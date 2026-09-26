/* ============================================================
   开学准备（P6）—— **纯逻辑**：名单事务、分组切块、按班型默认、操作步数
   ------------------------------------------------------------
   🔴 为什么这些是**纯函数**、与页面和网络分开：

     ① **"一个事务"这件事要能被断言**（`选科走班实施计划.md` P6 验收第 6 条：
        "一批 N 行里第 k 行非法 → **整批不入库**）+ 反向对照
        （"合法的那一批确实写得进去"）。
        所以"这一批该怎么写"先在这里算成一个**全成或全空的计划**，
        再由 `applyRoster()` 把它落进内存（本地演示模式）或交给服务端一个 RPC（远程）。
     ⚠️ 但是：**这一层不是闸门**。真正的原子性由数据库那一个 RPC 保证
        （`schema.sql` §27.11 的 `bulk_import_roster()` —— 一个 RPC = 一个事务）。
        这一层只是把同一套判据**在提交之前**跑一遍，好让用户当场看到第几行错了。

     ② **操作步数要能被数出来**（这一轮验收的核心是"步数"）。
        所以"做一次开学准备要几步"写成下面 `StepLog` 那一张表 +
        `GRADE_SETUP_STEPS` 那个估算 —— **数出来的是数，不是感觉**。
        见 `app/scripts/grade-checks.mjs` 的断言。
   ============================================================ */

import type { ClassType, Klass, Student } from '../data/types'
import { CLASS_TYPE_NAME } from '../data/types'
import {
  ROSTER_COLUMNS,
  checkGradeRoster,
  parseGradeRosterText,
  type GradeRosterChecked,
  type GradeRosterRow,
  type GradeRosterSummary,
} from './roster'
import { classTypeOf, defaultSubjectFor, isAdminClass, subjectCheck, type StudentSubject } from './pick'
import { SECOND_CODES, PRIMARY_CODES } from './pick'
import { subjectCodeOfName, subjectName, subjectShort } from './subjects'

/* ---------------- ① 名字解析：班号 → 班名（**唯一一处**） ---------------- */

/**
 * 班号 → 班名（`高一(1)班`）。
 *
 * 🔴 这条规则**在两处**必须逐字相同：
 *    · 这里（前端预览里显示"将创建 7 个班：高一(1)班 …"）；
 *    · `schema.sql` §27.11 里那句 `v_grade_name || '(' || 班号 || ')班'`。
 *    两边不一样的话，预览里说"要建高一(1)班"、建出来的却是另一个名字，
 *    而"按班号自动建班"的**幂等**（第二次导入不重复建班）就是靠这个名字认人的。
 */
export function classNameOf(gradeName: string, classNo: string): string {
  return `${gradeName}(${classNo})班`
}

/* ---------------- ② 名单 → 一个事务的"计划" ---------------- */

export type RosterMutation =
  | {
      kind: 'create-class'
      /** 这一行在第几次出现（用来把班号与下面的 students 串起来） */
      classNo: string
      name: string
    }
  | {
      kind: 'reuse-class'
      classNo: string
      classId: string
      name: string
    }
  | {
      kind: 'upsert-student'
      classNo: string
      classId: string
      studentNo: string
      name: string
      /**
       * 序列号。**空串 = 让数据库那一条触发器发号**（`students_serial_fill()`）——
       * 🔴 导入**绝不自己算号**（Q6 / U-2：算号只有数据库那一处）。
       */
      serial: string
      existingId?: string
    }

export type RosterPlan =
  | {
      ok: true
      /** 计划里的每一步（顺序就是落地的顺序：先建班、再写人） */
      mutations: RosterMutation[]
      /** 要新建几个班 */
      newClasses: string[]
      /** 复用了几个已有的班 */
      reusedClasses: string[]
      /** 写进去（含更新）几个人 */
      students: number
      /** 有几行是**新**学生 */
      added: number
      /** 有几行是更新已有学生 */
      updated: number
      /** 体检结果（逐行，带行号） */
      checked: GradeRosterChecked[]
      summary: GradeRosterSummary
      /** 补全后的行（序列号可能还是空的 —— 那是"交给触发器发号"的意思） */
      rows: GradeRosterRow[]
    }
  | {
      ok: false
      /** 🔴 报的是**行号 + 原因**（不是"导入失败"这种没用的句子） */
      line: number
      reason: string
      checked: GradeRosterChecked[]
      summary: GradeRosterSummary
    }

const SERIAL_SHAPE = /^[0-9]{4}[0-9]{3}$/

/**
 * 把一份粘贴文本算成"一次事务要做的全部事情"。
 *
 * 🔴 **全成或全空**：任何一行不合法 → 返回 `{ok:false}`，`mutations` **一步都没有**
 *    （这一层与数据库那个 RPC 是同一条语义；`grade-checks.mjs` 拿它做正反两向断言）。
 */
export function planRosterImport(input: {
  text: string
  gradeName: string
  classes: readonly Klass[]
  /** 这个年级已有的学生（`classId` → 名单）；用来判"更新"以及"同一个班同学号" */
  existing: readonly Klass[]
}): RosterPlan {
  const parsed = parseGradeRosterText(input.text)
  const checked = checkGradeRoster(parsed.rows, input.gradeName)
  const summary = checked.summary

  /* ① 列名认不出 → 整份拒绝解析（"认不出的列名报错，不猜"）
     ⚠️ **这一条要放在逐行体检之前**：认不出列名时那些"行"根本不该被当成数据
        （实测：表头里多一列 `学籍号`，按默认列位读出来的"数据行"会被报成
         "序列号格式不对"，而真正的问题是**表头不认识**）。 */
  if (parsed.unknownColumns.length) {
    return {
      ok: false,
      line: 1,
      reason: `表头里有认不出的列名：${parsed.unknownColumns.join('、')} —— 四列是 ${Object.values(
        ROSTER_COLUMNS,
      ).join(' / ')}（或者干脆去掉表头，直接贴数据行）`,
      checked: checked.rows,
      summary,
    }
  }

  /* ② 一行都没有 */
  if (!parsed.rows.length) {
    return { ok: false, line: 0, reason: '一行都没有 —— 这份名单是空的', checked: [], summary }
  }

  /* ③ 逐行体检（**第一行不合法的就报它**：用户改一行、再贴一次，比列 20 条要好） */
  const firstBad = checked.rows.find((r) => r.flag !== 'ok')
  if (firstBad) {
    return {
      ok: false,
      line: firstBad.line,
      reason: firstBad.reason,
      checked: checked.rows,
      summary,
    }
  }

  /* ④ 序列号：**要么不写（交给触发器），要么写对**；写了就不许重复 */
  const serialSeen = new Map<string, number>()
  for (const r of checked.rows) {
    if (!r.serial) continue
    if (!SERIAL_SHAPE.test(r.serial)) {
      return {
        ok: false,
        line: r.line,
        reason: `序列号格式不对（${r.serial}）—— 它是"4 位年份 + 3 位序号"；留空则系统自动发号`,
        checked: checked.rows,
        summary,
      }
    }
    serialSeen.set(r.serial, (serialSeen.get(r.serial) ?? 0) + 1)
  }
  for (const r of checked.rows) {
    if (r.serial && (serialSeen.get(r.serial) ?? 0) > 1) {
      return {
        ok: false,
        line: r.line,
        reason: `序列号 ${r.serial} 在名单里出现了两次`,
        checked: checked.rows,
        summary,
      }
    }
  }

  /* ⑤ 与库里已有的班对上：**按 (年级, 班名) 认**，认得出就复用、认不出就建 */
  const existingByClassNo = new Map<string, Klass>()
  for (const k of input.existing) {
    if (!isAdminClass(k)) continue
    const m = k.name.match(/\(([^)]+)\)\s*班\s*$/)
    const no = m ? m[1] : k.name
    if (!existingByClassNo.has(no)) existingByClassNo.set(no, k)
  }

  const mutations: RosterMutation[] = []
  const newClasses: string[] = []
  const reusedClasses: string[] = []
  for (const c of summary.classes) {
    const name = classNameOf(input.gradeName, c.classNo)
    const hit = existingByClassNo.get(c.classNo)
    if (hit) {
      reusedClasses.push(name)
      mutations.push({ kind: 'reuse-class', classNo: c.classNo, classId: hit.id, name: hit.name })
    } else {
      newClasses.push(name)
      mutations.push({ kind: 'create-class', classNo: c.classNo, name })
    }
  }

  /* ⑥ 学生：按 (班号, 班内学号) 认已有的人（同一行 = 更新，新行 = 新增） */
  const studentIndex = new Map<string, Student>()
  for (const k of input.existing) {
    for (const s of k.students) studentIndex.set(`${k.id}|${s.studentNo}`, s)
  }
  const classIdOf = (classNo: string): string => {
    const hit = existingByClassNo.get(classNo)
    return hit?.id ?? `new:${classNo}`
  }

  let added = 0
  let updated = 0
  for (const r of checked.rows) {
    const classId = classIdOf(r.classNo)
    const hit = studentIndex.get(`${classId}|${r.studentNo}`)
    if (hit) updated++
    else added++
    mutations.push({
      kind: 'upsert-student',
      classNo: r.classNo,
      classId,
      studentNo: r.studentNo,
      name: r.name,
      /* 空串 = 交给触发器发号（**绝不在这里算号**，也不在前端算） */
      serial: r.serial,
      ...(hit ? { existingId: hit.id } : {}),
    })
  }

  return {
    ok: true,
    mutations,
    newClasses,
    reusedClasses,
    students: checked.rows.length,
    added,
    updated,
    checked: checked.rows,
    summary,
    rows: checked.rows.map((r) => ({
      line: r.line,
      classNo: r.classNo,
      serial: r.serial,
      name: r.name,
      studentNo: r.studentNo,
    })),
  }
}

/**
 * 把一份"合法的计划"落进**本地内存**（本地演示模式 / 单测用）。
 *
 * 🔴 它是 `planRosterImport()` 的对照面：计划不合法时**根本不会被调到**
 *    （调用方先看 `plan.ok`）—— 所以"改一半"在这条路上不可能发生。
 *    远程模式走的是服务端一个 RPC，语义相同（一个事务）。
 *
 * @returns 新的班级数组（**不修改入参** —— 这一页的所有写入都是"算一份新的"，与 store 的乐观更新同款）
 */
export function applyRoster(classes: readonly Klass[], plan: Extract<RosterPlan, { ok: true }>): Klass[] {
  const out = classes.map((k) => ({ ...k, students: [...k.students] }))
  const byNewNo = new Map<string, Klass>()

  for (const m of plan.mutations) {
    if (m.kind !== 'create-class') continue
    const k: Klass = {
      id: `local-${m.classNo}-${Date.now()}`,
      name: m.name,
      grade: '',
      year: '',
      createdAt: Date.now(),
      students: [],
      kind: 'admin',
      classType: '',
    }
    byNewNo.set(m.classNo, k)
    out.push(k)
  }

  for (const m of plan.mutations) {
    if (m.kind !== 'upsert-student') continue
    const target =
      byNewNo.get(m.classNo) ?? out.find((k) => k.id === m.classId) ?? null
    if (!target) continue
    const hit = target.students.find((s) => s.studentNo === m.studentNo)
    if (hit) {
      hit.name = m.name
      /* 序列号**只补空**：已有序列号的行一个字节都不动（与数据库那条触发器同款） */
      if (!hit.serial && m.serial) hit.serial = m.serial
    } else {
      target.students.push({
        id: `local-${m.classNo}-${m.studentNo}`,
        studentNo: m.studentNo,
        name: m.name,
        status: 'active',
        ...(m.serial ? { serial: m.serial } : {}),
        createdAt: Date.now(),
      })
    }
  }
  return out
}

/* ---------------- ③ 批量设班型：按班号切块 ---------------- */

/**
 * 把 `1-4` / `5,6` / `7` 这种班号表达式展开成班号清单。
 *
 * ⚠️ 认不出的词**原样留在 `bad` 里报出来**（不猜、不静默丢掉一个班）。
 *    中划线支持 `-` 与 `~`，分隔符支持逗号 / 顿号 / 空格。
 */
export function parseClassNoSpec(spec: string): { nos: string[]; bad: string[] } {
  const nos: string[] = []
  const bad: string[] = []
  const tokens = String(spec ?? '')
    .replace(/[，、;；]/g, ',')
    .split(/[\s,]+/)
    .filter(Boolean)
  for (const t of tokens) {
    const range = t.match(/^(\d{1,3})\s*[-~]\s*(\d{1,3})$/)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (a > b) {
        bad.push(t)
        continue
      }
      for (let i = a; i <= b; i++) nos.push(String(i))
      continue
    }
    if (/^\d{1,3}$/.test(t)) {
      nos.push(String(Number(t)))
      continue
    }
    bad.push(t)
  }
  return { nos, bad: [...new Set(bad)] }
}

/** 按班号表达式挑出这个年级里的班（认不出的班号单独报出来，不静默） */
export function pickClassesBySpec(
  classes: readonly Klass[],
  gradeName: string,
  spec: string,
): { hit: Klass[]; missing: string[]; bad: string[] } {
  const { nos, bad } = parseClassNoSpec(spec)
  const hit: Klass[] = []
  const missing: string[] = []
  for (const no of nos) {
    const name = classNameOf(gradeName, no)
    const k = classes.find((c) => isAdminClass(c) && (c.name === name || c.name === no))
    if (k) {
      if (!hit.some((x) => x.id === k.id)) hit.push(k)
    } else {
      missing.push(no)
    }
  }
  return { hit, missing, bad }
}

/* ---------------- ④ 采集选科：按班型默认一键铺开 ---------------- */

export type CollectResult = {
  /** 要写的那批（**跳过与现有值相同的行** —— 反指标：不让人做无意义的确认） */
  rows: StudentSubject[]
  /** 因为没有默认组合而**没被铺开**的班（未分科 / 未设置）—— 必须报出来 */
  skippedClasses: Array<{ classId: string; name: string; why: string }>
  /** 已经是这个组合、不用再写的行数 */
  unchanged: number
  /** 「其他」的学生：**必须手工选走班科目**，一键铺开**不覆盖**他们 */
  otherKept: number
}

/**
 * 按每个班的班型，给全班学生铺默认选科。
 *
 * 🔴 三条不能破的：
 *   ① **不覆盖「其他」**（`kind === 'other'` 的那几个学生是手工定的，一键不该改写它们）；
 *   ② 班型是 `''`（还没设置）或 `'undivided'`（未分科）时**没有默认组合** →
 *      那几行**不写**，并把班列进 `skippedClasses`（"未分科"不是"默认物化生"）；
 *   ③ 与现有值相同的行**不写**（省掉几百次无意义的写；界面上的"已采集"也因此是准的）。
 */
export function collectByClassType(
  classes: readonly Klass[],
  existing: ReadonlyMap<string, StudentSubject>,
): CollectResult {
  const rows: StudentSubject[] = []
  const skippedClasses: CollectResult['skippedClasses'] = []
  let unchanged = 0
  let otherKept = 0

  for (const k of classes) {
    if (!isAdminClass(k)) continue
    const t: ClassType = classTypeOf(k)
    for (const st of k.students) {
      if (st.status !== 'active') continue
      const cur = existing.get(st.id) ?? null
      if (cur?.kind === 'other') {
        otherKept++
        continue
      }
      const d = defaultSubjectFor(t, st.id)
      if (!d) {
        if (t === 'undivided' || t === '') {
          skippedClasses.push({
            classId: k.id,
            name: k.name,
            why: t === '' ? '这个班还没设班型' : '未分科的班没有默认组合',
          })
        }
        continue
      }
      if (cur && cur.kind === 'standard' && cur.primaryCode === d.primaryCode &&
          [...cur.secondCodes].sort().join(',') === [...d.secondCodes].sort().join(',')) {
        unchanged++
        continue
      }
      rows.push({ ...d, note: '' })
    }
  }
  /* 同一个班进 `skippedClasses` 只留一条（45 个人不该报 45 次） */
  const seen = new Set<string>()
  const skipped = skippedClasses.filter((s) => {
    if (seen.has(s.classId)) return false
    seen.add(s.classId)
    return true
  })
  return { rows, skippedClasses: skipped, unchanged, otherKept }
}

/* ---------------- ④b 粘贴差异名单：一行一个人 ---------------- */

export type SubjectPastePlan =
  | {
      ok: true
      /** 要写的那批（**一个人一行**，已经归一化成 code） */
      rows: StudentSubject[]
      /** 逐行的预览（界面用；带行号与人话说明） */
      lines: Array<{ line: number; text: string; who: string; combo: string; note: string }>
    }
  | {
      ok: false
      line: number
      reason: string
      lines: Array<{ line: number; text: string; who: string; combo: string; note: string }>
    }

/**
 * 组合名 → 首选 + 再选两门；认不出返回 `null`（**绝不猜**）。
 *
 * 两种写法都认（老师从 Excel 里贴过来的是哪一种都可能）：
 *   · **短名连写**：`物化政`（`lib/subjects.ts` 的 `short`，界面上显示的也是它）
 *   · **全名连写**：`物理化学政治`（`lib/pick.ts` 的 `COMBINATIONS` 就是这一种）
 *
 * ⚠️ **先按短名逐字切，再按全名逐词切** —— 反过来会把 `物理化学生物` 切成
 *    「物」「理」…（两个字的名字被拆开，这是本仓库见过好几次的坑）。
 *    两种都认不出 → `null`（不猜、不按前缀匹配）。
 */
export function combinationToCodes(combo: string): { primary: string; second: string[] } | null {
  const s = String(combo ?? '').replace(/\s/g, '')
  if (!s) return null

  const byShort = new Map<string, string>()
  const byFull = new Map<string, string>()
  for (const c of [...PRIMARY_CODES, ...SECOND_CODES]) {
    byShort.set(subjectShort(c), c)
    byFull.set(subjectName(c), c)
  }

  const take = (codes: string[]): { primary: string; second: string[] } | null => {
    if (codes.length !== 3) return null
    const first = codes[0]
    if (first !== 'physics' && first !== 'history') return null
    return { primary: first, second: codes.slice(1) }
  }

  /* ① 短名逐字（`物化政`）—— 界面上显示、老师手打的就是这一种 */
  const byChar: string[] = []
  let shortOk = true
  for (const ch of s) {
    const code = byShort.get(ch)
    if (!code) {
      shortOk = false
      break
    }
    byChar.push(code)
  }
  if (shortOk) {
    const hit = take(byChar)
    if (hit) return hit
  }

  /* ② 全名逐词（`物理化学政治`）—— 从左往右吃，吃不下就整体不认 */
  let rest = s
  const byWord: string[] = []
  while (rest) {
    const name = [...byFull.keys()].find((n) => rest.startsWith(n))
    if (!name) return null
    byWord.push(byFull.get(name) as string)
    rest = rest.slice(name.length)
  }
  return take(byWord)
}

/**
 * 把一份"粘贴的差异名单"算成要写的行。
 *
 * 认人的两列（**按班号那一列在不在**自动定，不按列的数量猜得更细）：
 *   · `1  2026001  物化政`            ← 第一列是**班号**、第二列是序列号
 *   · `2026001  物化政`               ← 只有序列号（那一列在整份里都认得出形状）
 *   · `1  01  物化政`                 ← 班号 + 班内学号（序列号还没发下来时用这个）
 *
 * ⚠️ 组合名认不出 / 结构不合法（首选两门、再选一门…）→ **整份拒绝**并报**行号**，
 *    与名单导入同一条纪律（"当场拦住，不入库"）。
 */
export function planSubjectPaste(input: {
  text: string
  classes: readonly Klass[]
  /** 认人用：序列号 → 学生；以及 `班号|班内学号` → 学生（这张表由页面建好传进来） */
  bySerial: ReadonlyMap<string, { student: Student; classNo: string }>
  byClassNoStudentNo: ReadonlyMap<string, { student: Student; classNo: string }>
}): SubjectPastePlan {
  const rows: StudentSubject[] = []
  const lines: SubjectPastePlan['lines'] = []
  const rawLines = String(input.text ?? '').split(/\r?\n/)

  rawLines.forEach((raw, i) => {
    const line = i + 1
    const text = raw.replace(/\u3000/g, ' ').trim()
    if (!text) return
    if (/^(姓名|序列号|班级|班级内学号|首选|再选|组合)\b/.test(text)) return

    const cells = text.split(/[\s,，、;；|\t]+/).filter(Boolean)
    if (cells.length < 2) {
      lines.push({ line, text, who: '', combo: '', note: '这一行只有一列' })
      return
    }
    const combo = cells[cells.length - 1]
    const keys = cells.slice(0, -1)

    let hit: { student: Student; classNo: string } | undefined
    let how = ''
    if (keys.length >= 2) {
      hit = input.byClassNoStudentNo.get(`${keys[0]}|${keys[1]}`)
      how = `班 ${keys[0]} 的 ${keys[1]} 号`
    }
    if (!hit) {
      hit = input.bySerial.get(keys[keys.length - 1])
      how = hit ? `序列号 ${keys[keys.length - 1]}` : how
    }
    if (!hit) {
      lines.push({ line, text, who: '', combo, note: '认不出这个学生' })
      return
    }

    const codes = combinationToCodes(combo)
    if (!codes) {
      lines.push({ line, text, who: hit.student.name, combo, note: '这不是一个合法的 3+1+2 组合' })
      return
    }
    const row: StudentSubject = {
      studentId: hit.student.id,
      primaryCode: codes.primary,
      secondCodes: codes.second,
      kind: 'standard',
      note: '',
    }
    const why = subjectCheck(row)
    if (why) {
      lines.push({ line, text, who: hit.student.name, combo, note: why })
      return
    }
    rows.push(row)
    lines.push({ line, text, who: hit.student.name, combo, note: how })
  })

  if (!lines.length) return { ok: false, line: 0, reason: '一行都没有 —— 这份名单是空的', lines }
  /*
   * 逐行判定：合法的那些行，`note` 记的是**认人的方式**（"班 1 的 07 号" / "序列号 …"）；
   * 不合法的行，`note` 记的是**为什么**。所以"有没有不合法的行"就是
   * "有没有一行不是以这两种方式认出来的"。
   */
  const legalHow = (n: string) => n.startsWith('班 ') || n.startsWith('序列号 ')
  const offender = lines.find((l) => !legalHow(l.note))
  if (offender) {
    return {
      ok: false,
      line: offender.line,
      reason: `${offender.note}（${offender.who ? `${offender.who}：` : ''}${offender.combo}）`,
      lines,
    }
  }
  return { ok: true, rows, lines }
}

/* ---------------- ⑤b 批量指定任教关系（粘贴三列） ---------------- */

export type RolePastePlan =
  | {
      ok: true
      rows: Array<{ classId: string; className: string; subjectCode: string; teacherId: string; teacherName: string }>
      /** 涉及几个班 / 几位老师 / 几科（预览里那三个数） */
      classes: number
      teachers: number
      subjects: number
      lines: Array<{ line: number; className: string; subject: string; teacher: string; bad?: string }>
    }
  | {
      ok: false
      line: number
      reason: string
      lines: Array<{ line: number; className: string; subject: string; teacher: string; bad?: string }>
    }

/**
 * 把一份"班级 · 科目 · 老师"的三列粘贴算成要写的任教关系。
 *
 * 这是 `年级管理与选科走班方案.md` §4.3.2 第⑤步里那个 **`[ 粘贴批量指定 ]`** ——
 * 把"几十位老师 × 每个班一科"从几十次下拉压成**一次粘贴**（方案原文给的就是这条路）。
 *
 * 🔴 **认不出的绝不猜**（与名单导入同一条纪律）：
 *    · 班名认不出（不在这个年级里）→ 报**行号 + 那个班名**
 *    · 科目名认不出（不在 `lib/subjects.ts` 的字典里）→ 报行号 + 那个名字
 *    · 老师名认不出 / **同名两位老师**（歧义）→ 报行号 + 那个名字
 *    任何一行不对 → `{ok:false}`，**一行都不写**（服务端那一个 RPC 也是一个事务）。
 */
export function planRolePaste(input: {
  text: string
  gradeName: string
  classes: readonly Klass[]
  teachers: readonly { id: string; name: string }[]
}): RolePastePlan {
  const lines: RolePastePlan['lines'] = []
  const rows: Array<{
    classId: string
    className: string
    subjectCode: string
    teacherId: string
    teacherName: string
  }> = []

  const byClass = new Map<string, Klass>()
  for (const k of input.classes) {
    if (!isAdminClass(k)) continue
    byClass.set(k.name, k)
    const no = k.name.match(/\(([^)]+)\)\s*班\s*$/)?.[1]
    if (no) byClass.set(no, k)
    byClass.set(`${input.gradeName}(${no})班`, k)
  }
  const teacherByName = new Map<string, string[]>()
  for (const t of input.teachers) {
    const list = teacherByName.get(t.name) ?? []
    list.push(t.id)
    teacherByName.set(t.name, list)
  }

  const raw = String(input.text ?? '').split(/\r?\n/)

  for (let i = 0; i < raw.length; i++) {
    const line = i + 1
    const text = raw[i].replace(/\u3000/g, ' ').trim()
    if (!text) continue
    if (/^(班级|班号|科目|学科|老师|教师)\b/.test(text)) continue

    const cells = text.split(/[\s,，、;；|\t]+/).filter(Boolean)
    if (cells.length < 3) {
      lines.push({ line, className: '', subject: '', teacher: '', bad: '这一行不足三列（班级 / 科目 / 老师）' })
      continue
    }
    const [classRaw, subjectRaw, teacherRaw] = [cells[0], cells[1], cells[2]]
    const k = byClass.get(classRaw)
    if (!k) {
      lines.push({ line, className: classRaw, subject: subjectRaw, teacher: teacherRaw, bad: `这个年级里没有「${classRaw}」这个班` })
      continue
    }
    const code = subjectCodeOfName(subjectRaw)
    if (!code) {
      lines.push({ line, className: k.name, subject: subjectRaw, teacher: teacherRaw, bad: `认不出学科「${subjectRaw}」` })
      continue
    }
    const hits = teacherByName.get(teacherRaw) ?? []
    if (hits.length === 0) {
      lines.push({ line, className: k.name, subject: subjectRaw, teacher: teacherRaw, bad: `找不到老师「${teacherRaw}」` })
      continue
    }
    if (hits.length > 1) {
      lines.push({ line, className: k.name, subject: subjectRaw, teacher: teacherRaw, bad: `有 ${hits.length} 位老师都叫「${teacherRaw}」—— 重名要先在账号页改掉` })
      continue
    }
    rows.push({
      classId: k.id,
      className: k.name,
      subjectCode: code,
      teacherId: hits[0],
      teacherName: teacherRaw,
    })
    lines.push({ line, className: k.name, subject: subjectRaw, teacher: teacherRaw })
  }

  if (!lines.length) return { ok: false, line: 0, reason: '一行都没有 —— 这份表是空的', lines }
  const offender = lines.find((l) => l.bad)
  if (offender) return { ok: false, line: offender.line, reason: `${offender.bad}`, lines }
  return {
    ok: true,
    rows,
    classes: new Set(rows.map((r) => r.classId)).size,
    teachers: new Set(rows.map((r) => r.teacherId)).size,
    subjects: new Set(rows.map((r) => r.subjectCode)).size,
    lines,
  }
}

/* ---------------- ⑤ 操作步数（**数出来的，不是感觉**） ---------------- */

/**
 * 一次"开学准备"里的一次点击/一次粘贴。
 *
 * ⚠️ 它只**记账**，不判任何东西 —— 判据在数据库。这样"步数"这件事才有唯一的数。
 */
export type StepCount = {
  /** 这一步叫什么（报告里那张步数表用的就是它） */
  what: string
  /** 几步（一次点击 / 一次粘贴 = 1） */
  steps: number
}

/**
 * 方案 §4.3.2 的步数估算（`年级管理与选科走班方案.md` 第 2175–2400 行那段）——
 * **按 Q23 的真实规模**（7 个班约 330 人 / 2026 高一）折算。
 *
 * 🔴 **怎么数的**（口径写死，免得下一个人"为了好看"改数）：
 *    · **一次点击 / 一次粘贴 = 1 步**；**打字不算步**（输入 `1-4` 与点按钮是同一次操作，
 *      方案原文那句"输 `1-4` → 点设为理科班 = 2 次"数的是**两个动作**，
 *      而"输入"这一步在本页面上是按钮旁边那个输入框，不是独立的确认动作）；
 *    · **一次服务端请求 = 1 步**（不管它写了 3 行还是 300 行）；
 *    · **页面上"看"的那些东西**（进度条、完成度、不符提示）**不算步**。
 *
 * | 步骤 | 方案原文的估法 | 本页的真实步数 |
 * | --- | --- | --- |
 * | ① 录名单 | "3 次点击（粘贴 → 预览 → 确认）" | **3** |
 * | ② 建班 | "带班号 = **0 次**"（15 班从 ≈45 步降到 0 步） | **0** |
 * | ③ 设班型 | "输 `1-4` → 设为理科班" + "输 `5,6` → 设为文科班" | **2** |
 * | ④ 采选科 | "一键全部按班型默认" + 1 次确认；"粘贴差异名单" + 1 次确认 | **4** |
 * | ⑤ 分配身份 | "班主任粘贴 1 次 = 2 步" + "年级主任 = 1 步" + "科任老师粘贴 = 2 步" | **5** |
 *
 * ✅ **合计 14 步**（方案 §4.3 按 15 班 / 650 人 / 40 老师估的是 **≈43 步**，
 *    `选科走班实施计划.md` P6 验收第 1 条按 Q23 重算的目标是 **≤ 15 步**）。
 *    两个口径都对得上：43 步里最大的一块是"科任老师 12 位 × 3 次点击 = 36 步"，
 *    而方案自己在那一段写了**另一条路**：「或者**粘贴 2 次**（如果有 Excel）」。
 *    ✅ 本轮把那条路做出来了（`planRolePaste()` + 「粘贴批量指定任教关系」），
 *    所以这张表数的是**真的做出来的界面步数**，不是把 43 步"改小"。
 *    ⚠️ 用户拍板的同类判断正是这个方向：「40 位老师 × 4 行 = 160 次请求」→ **开批量接口**。
 *    ⚠️ **数的时候按"一次点击 / 一次粘贴 = 1 步、打字不算步、一次请求 = 1 步"**（见上）；
 *       按别的口径数出来会不一样 —— 所以口径写死在这里，别各自算各自的。
 */
export const GRADE_SETUP_STEPS: readonly StepCount[] = [
  { what: '① 录名单（粘贴 → 预览 → 确认）', steps: 3 },
  { what: '② 建班（名单里带班号 → 自动建，0 步）', steps: 0 },
  { what: '③ 设班型（按班号批量：1-4 设理科 + 5-7 设文科）', steps: 2 },
  { what: '④ 采选科（一键按班型默认 + 确认；粘贴差异名单 + 确认）', steps: 4 },
  { what: '⑤ 分配身份（班主任粘贴 2 步 + 年级主任 1 步 + 任教关系粘贴 2 步）', steps: 5 },
]

/** 步数合计 */
export const GRADE_SETUP_STEP_TOTAL: number = GRADE_SETUP_STEPS.reduce((a, s) => a + s.steps, 0)

/** 一笔一笔地记（页面用它显示"你已经点了 N 步"；脚本用它做断言） */
export class StepLog {
  private readonly items: StepCount[] = []

  add(what: string, steps = 1): void {
    if (steps > 0) this.items.push({ what, steps })
  }

  get total(): number {
    return this.items.reduce((a, s) => a + s.steps, 0)
  }

  get list(): readonly StepCount[] {
    return this.items
  }

  reset(): void {
    this.items.length = 0
  }
}

/** 界面上一句话说明这一档班型（**只有一处**，别在页面里各写一份 if） */
export function classTypeLabel(t?: ClassType): string {
  const name = CLASS_TYPE_NAME[t ?? ''] ?? CLASS_TYPE_NAME['']
  return name
}
