import type { ImportRow, Student } from '../data/types'
import { isSerial } from './serial'

/* ---------------- 名单的统一排序（**只有这一处**） ----------------

   名单顺序**只在这里定义**，页面里不许自己写 `.sort()` 的比较（各写一份必然走散）。
   两个比较器，按"屏上显示的是哪个号"分工：
     · `compareRoster()`    —— **序列号**优先 → 走班班 / 年级名单（跨行政班不会出现"两个 12 号"）；
     · `compareStudentNo()` —— **班级内学号** → 班级页名单 / 错题集（屏上显示的就是它）。

   选**序列号**（`选科走班实施计划.md` P1 的"名单排序改成按序列号排"），理由：
     · 序列号是**全校唯一**的 → 走班班（跨行政班）的名单用它排才不会出现"两个 12 号"；
     · 它按届 + 届内序号生成，同一届的名单顺序在任何班里都一致。
   ⚠️ 兼容期：**还没有序列号的学生**（线上库还没跑 §20）按班内学号排 ——
      老库上的显示顺序一个字节都不变。
   ⚠️ 界面上**显示**的仍然是班内学号（Q6：老师看到的东西一模一样）；
      所以"屏上显示班内学号"的那两块屏（班级页、错题集）改用 `compareStudentNo()`。 */
export function compareRoster(
  a: Pick<Student, 'serial' | 'studentNo' | 'name'>,
  b: Pick<Student, 'serial' | 'studentNo' | 'name'>,
): number {
  const sa = isSerial(a.serial) ? String(a.serial) : ''
  const sb = isSerial(b.serial) ? String(b.serial) : ''
  if (sa && sb) return sa.localeCompare(sb) || a.name.localeCompare(b.name)
  if (sa) return -1
  if (sb) return 1
  return studentNoValue(a.studentNo) - studentNoValue(b.studentNo) || a.name.localeCompare(b.name)
}

/* ---------------- 按「班级内学号」排（班级页 / 错题集的名单顺序） ----------------

   ⚠️ **"按学号排"有两个不同的字段**，两个函数各管一边（别混用）：
     · `compareRoster()`    —— **序列号**优先。走班班（跨行政班）用它排才不会出现"两个 12 号"。
     · `compareStudentNo()` —— **班级内学号**。班级页的名单、错题集的学生列表用它：
       那两块屏上**显示**的就是班内学号（序列号是内部键），老师照着屏上的号找人，
       顺序就得跟屏上那个号一致。**用户 2026-09-26 拍板**：新增学生后要落进他该在的位置，
       不许追加在末尾（截图口径：44·32·38·5… → 1·2·3…）。

   ⚠️ 必须按**数字**排：直接比字符串会把 `10` 排到 `2` 前面（`'10' < '2'`）。 */
export function compareStudentNo(
  a: Pick<Student, 'studentNo' | 'name'>,
  b: Pick<Student, 'studentNo' | 'name'>,
): number {
  return studentNoValue(a.studentNo) - studentNoValue(b.studentNo) || a.name.localeCompare(b.name, 'zh')
}

/** 班内学号 → 数字。
 *  不是数字的（空号 / 意外值）当**最大**处理 —— 沉到名单末尾，
 *  而不是当 0 冲到最前（那看起来像名单错乱）。 */
function studentNoValue(no: string): number {
  const t = String(no).trim()
  return /^\d+$/.test(t) ? Number(t) : Number.MAX_SAFE_INTEGER
}

/* ============================================================
   开学准备：**整个年级**的名单解析（P6）
   ------------------------------------------------------------
   与下面 `parseRosterText()` 的分工（别把两个混起来用）：

     · `parseRosterText()`        —— **单班**名单（两列：班内学号 + 姓名），
                                    `ClassDetail` → 粘贴导入那条老链路在用，一个字没动。
     · `parseGradeRosterText()`   —— **一个年级**的名单（多一列**班号**），
                                    这是 P6 新增的那一条。班号 → 自动建班（Q11 = A）。

   🔴 **导入导出同一套列名**（Q29）：导出的就是下面 `ROSTER_COLUMNS` 那四列，
      所以"导出 → 改 → 再导回来"必须能吃掉自己导出的文件。列名在下面
      `ROSTER_COLUMNS` **只有一处定义**，导入的识别与导出的表头都从它读。
   ============================================================ */

/**
 * 名单的四列 —— **导入导出共用的唯一一份列名**。
 *
 * ⚠️ `班级内学号` 这个名字**故意**与老模板的 `学号` 不同：
 *    老模板里的"学号"其实是**班内学号**（P1 之后它已经不是那 10 个字段的键了），
 *    而新模板里"序列号"才是那个全局唯一的号。两个词都叫"学号"时，
 *    教导处一定会填错列 —— 所以新列名把歧义**写在名字里**。
 */
export const ROSTER_COLUMNS = {
  classNo: '班级',
  serial: '序列号',
  name: '姓名',
  studentNo: '班级内学号',
} as const

/** 导出时的表头（顺序就是导出文件的列序） */
export const ROSTER_HEADER = [
  ROSTER_COLUMNS.classNo,
  ROSTER_COLUMNS.serial,
  ROSTER_COLUMNS.name,
  ROSTER_COLUMNS.studentNo,
] as const

/** 一行的原始字段（**都是字符串**：解析阶段不猜类型，校验阶段才判） */
export type GradeRosterRow = {
  /** 行号（1 起，**含表头** —— 报错时要报用户在自己那份 Excel 里数得出来的那个号） */
  line: number
  classNo: string
  serial: string
  name: string
  studentNo: string
}

/** 体检后的一行 */
export type GradeRosterChecked = GradeRosterRow & {
  /** 去哪 ok / 待确认 */
  flag: 'ok' | 'no-class' | 'no-no' | 'no-name' | 'dup-no' | 'dup-serial' | 'serial-shape'
  /** 人话原因（`flag === 'ok'` 时为空） */
  reason: string
  /** 这一行的班号认出来了，且整批里至少有一个合法行 */
  className: string
}

/** 班号识别出来的统计 */
export type GradeRosterSummary = {
  total: number
  ok: number
  bad: number
  /** 班号 → 人数（按班号字符串，保持首次出现的顺序） */
  classes: Array<{ classNo: string; count: number }>
}

const HEAD_CLASS = /^(班级|班号|班级号|行政班|所在班|班)$/
const HEAD_SERIAL = /^(序列号|序列编号|学籍号|学籍编号)$/
const HEAD_NAME = /^(姓名|学生姓名|名字|学生)$/
const HEAD_NO = /^(班级内学号|班内学号|学号|序号|编号|考号|座号|号)$/
/**
 * 表头那一行**整体像不像表头**（用来把"认不出的列名"从数据里分出来）。
 *
 * ⚠️ 这一条要**宽**：它的用途只有一个 —— 让 `planRosterImport()` 能对
 *    `班级 序列号 姓名 班级内学号 联系电话` 这种**多了一列**的表头说
 *    "认不出的列名：联系电话"，而不是把它当成数据、然后报出一句
 *    "序列号格式不对"（实测踩过：真正的原因是**表头不认识**）。
 *    判据 = **每一格都不像数据**（不是纯数字、也不像一个中文人名），而不是"都认得出"。
 */
const HEAD_HINT = /班级|班号|姓名|学生|学号|序列|序号|编号|学籍|考号|座号|号$|电话|联系|备注|性别/

/**
 * 表头行：这一行**像不像表头**。
 *
 * 判据用的是"**大多数格子里有表头关键字**"（班级 / 学号 / 姓名 / 序列号 / 序号 / 编号 / 学籍），
 * 而不是"每一格都认得出" —— 因为**认不出的列名正是要报出来的那件事**：
 * 判"全中"会让一行带一个多余列的表头被当成数据，然后按默认列位读出来的
 * "数据行"会报成"序列号格式不对"（实测踩过），而真问题是**表头不认识**。
 */
function isHeaderLine(cells: string[]): boolean {
  if (!cells.length) return false
  const reals = cells.filter((c) => c !== '')
  if (!reals.length) return false
  const hits = reals.filter(
    (c) => HEAD_CLASS.test(c) || HEAD_SERIAL.test(c) || HEAD_NAME.test(c) || HEAD_NO.test(c),
  ).length
  if (hits >= reals.length) return true
  /*
   * 认得出大半，而且**剩下那些也不像数据**（没有纯数字、没有中文人名）→ 也当表头。
   * 这一支存在的唯一理由就是让"多了一列的表头"能走到 `unknownColumns` 那一步。
   */
  const looksLikeData = (c: string) => /^[0-9]+$/.test(c) || /^[\u4e00-\u9fa5·]{2,4}$/.test(c)
  return hits >= Math.ceil(reals.length * 0.6) && reals.every((c) => HEAD_HINT.test(c) || !looksLikeData(c))
}

/** 一个单元格像不像"4 位年份 + 3 位序号"的序列号 */
const SERIAL_SHAPE = /^[0-9]{4}[0-9]{3}$/

/**
 * 解析一个年级的名单文本。
 *
 * 🔴 **认不出的列名报错，绝不猜**（`选科走班实施计划.md` P6 验收第 7 条）：
 *    表头里出现了四个列名之外的**新**列名时，整份文本**拒绝解析**并报出那个列名 ——
 *    静默忽略最危险（用户以为自己导对了）。
 *    ⚠️ 但"没有表头、只有数据行"是**允许**的（老师直接从 Excel 里复制一片单元格），
 *       那时按列的**数量与形状**定位（见下面 `locate()`）。
 */
export function parseGradeRosterText(text: string): {
  rows: GradeRosterRow[]
  /** 认不出的列名（非空 = 整份没解析成功，界面要报出来） */
  unknownColumns: string[]
  /** 用没用表头（界面提示语不一样） */
  hadHeader: boolean
} {
  const lines = text.split(/\r?\n/)
  const rows: GradeRosterRow[] = []
  const unknownColumns: string[] = []
  let hadHeader = false
  /**
   * 四列的**下标定位**。默认值 = 导出文件那一套（班级 / 序列号 / 姓名 / 班级内学号）；
   * 有表头时按表头重排；没有表头时按形状猜一次（认不出就退回老两列口径）。
   */
  let idx: { classNo: number; serial: number; name: number; studentNo: number } | null = null

  lines.forEach((raw, i) => {
    const line = raw.replace(/\u3000/g, ' ').trim()
    if (!line) return
    /*
     * 🔴 **有制表符就按制表符切**（Excel 复制出来的就是它）。
     *    按空白切会把**空单元格吃掉** —— 一行 `1\t\t乙\t02`（序列号那一格留着空）
     *    会被切成 `['1','乙','02']`，列就**错位**了：姓名被当成序列号、班内学号被当成姓名。
     *    这正是"序列号留空 = 让系统发号"那条路上最常见的贴法，所以它必须对。
     *    ⚠️ 所以制表符这一支**不吃空串**（空格子是"这一格空着"，不是"没有这一格"）；
     *       按空白切的那一支照旧把空串滤掉（那里面一个空串没有信息量）。
     */
    const cells = line.includes('\t')
      ? line.split('\t').map((c) => c.trim())
      : line.split(/[\s,，、;；|]+/).filter(Boolean)
    if (!cells.length) return

    if (!hadHeader && isHeaderLine(cells)) {
      hadHeader = true
      const at = { classNo: -1, serial: -1, name: -1, studentNo: -1 }
      const unknown: string[] = []
      cells.forEach((c, k) => {
        /*
         * 🔴 **顺序要紧**：`HEAD_SERIAL` 必须在 `HEAD_NO` 前面判。
         *    `学籍号` 既匹配 `HEAD_SERIAL`、**也**匹配 `HEAD_NO`（`号` 那一支）——
         *    先判 `HEAD_NO` 的话它会被当成**班级内学号**（列就错了），
         *    而且"认不出的列名"那个清单里永远不会有它（实测踩过）。
         *    一个字段只能有一种语义：`学籍号` 在这里的语义是**序列号**（全校唯一的那个号）。
         */
        if (HEAD_CLASS.test(c)) at.classNo = k
        else if (HEAD_SERIAL.test(c)) at.serial = k
        else if (HEAD_NAME.test(c)) at.name = k
        else if (HEAD_NO.test(c)) at.studentNo = k
        else unknown.push(c)
      })
      unknownColumns.push(...unknown)
      idx = at
      return
    }

    if (!idx) idx = locate(cells)

    const cell = (k: number) => (k >= 0 ? (cells[k] ?? '').trim() : '')
    const classNo = cell(idx.classNo)
    const serial = cell(idx.serial)
    const name = cell(idx.name)
    const studentNo = idx.studentNo >= 0 ? cell(idx.studentNo) : ''
    rows.push({ line: i + 1, classNo, serial, name, studentNo })
  })

  return { rows, unknownColumns, hadHeader }
}

/**
 * 没有表头时，按列的数量与形状定位四列。
 *
 * 判据（**按可靠性排序**，不是按列序猜）：
 *   ① 有"4 位年份 + 3 位序号"形状的格子 → 那是序列号，**唯一一处能确定身份的形状**；
 *   ② 有中文人名的格子 → 姓名（可能不止一个：班里重名，所以取**最后一个**像人名的）；
 *   ③ 剩下的数字格子：**最小的那个**是班号、其余是班内学号（班号 1–30，班内学号 1–60，
 *      两者会重叠，所以这一条只在"一眼看得出谁大谁小"时才对 —— 认不出就按顺序给）。
 */
function locate(cells: string[]): {
  classNo: number
  serial: number
  name: number
  studentNo: number
} {
  const at = { classNo: -1, serial: -1, name: -1, studentNo: -1 }
  const nameLike = (s: string) => /^[\u4e00-\u9fa5·]{2,6}$/.test(s)
  const numLike = (s: string) => /^[0-9]{1,8}$/.test(s)

  cells.forEach((c, k) => {
    if (at.serial < 0 && SERIAL_SHAPE.test(c)) at.serial = k
    else if (nameLike(c)) at.name = k // 后面的覆盖前面的（重名时取最后一个像人名的）
  })

  if (cells.length >= 4) {
    if (at.classNo < 0) at.classNo = 0
    if (at.name < 0) at.name = 2
    if (at.studentNo < 0) at.studentNo = 3
  } else if (cells.length === 3) {
    /* 三列：班号 / 姓名 / 班级内学号（序列号那列由触发器发，不要求手填） */
    const nums = cells
      .map((c, k) => ({ c, k }))
      .filter((x) => x.k !== at.serial && x.k !== at.name && numLike(x.c))
    if (nums.length >= 2) {
      at.classNo = nums[0].k
      at.studentNo = nums[1].k
    }
    if (at.name < 0) at.name = cells.findIndex((c) => nameLike(c))
  } else if (cells.length === 2) {
    /* 老两列口径：班内学号 + 姓名（**没有班号** → 后面会报"缺班号"） */
    if (at.name < 0) at.name = 1
    if (at.studentNo < 0) at.studentNo = 0
  }
  return at
}

/**
 * 逐行体检（**报行号**，先补全再校验）。
 *
 * 🔴 这一步**只报问题，不改数据、不入库** —— 用户看到"第 47 行缺班号"之后
 *    要能在自己那份 Excel 里改成对的，再整份重贴。
 *
 * @param gradeName 年级显示名（`高一`）—— 用来拼班名（`高一(1)班`），与
 *                  `schema.sql` §27.11 里那个 `v_grade_name || '(' || 班号 || ')班'` **同款**
 */
export function checkGradeRoster(
  rows: GradeRosterRow[],
  gradeName: string,
): { rows: GradeRosterChecked[]; summary: GradeRosterSummary } {
  const seenNo = new Map<string, number>()
  const seenSerial = new Map<string, number>()
  const order: string[] = []
  const countOf = new Map<string, number>()

  for (const r of rows) {
    if (r.classNo) {
      if (!countOf.has(r.classNo)) order.push(r.classNo)
      countOf.set(r.classNo, (countOf.get(r.classNo) ?? 0) + 1)
    }
    if (r.classNo && r.studentNo) {
      const k = `${r.classNo}|${r.studentNo}`
      seenNo.set(k, (seenNo.get(k) ?? 0) + 1)
    }
    if (r.serial) seenSerial.set(r.serial, (seenSerial.get(r.serial) ?? 0) + 1)
  }

  /*
   * 🔴 **重号报"第二次出现"的那一行**（第一次是"先来的那一行"，多半是对的）。
   *    做法：先记下每个键第一次出现的行号，后面再遇到就把**当前这一行**标上。
   *    ⚠️ 不要把两次都标红：用户会以为自己错了两次，改起来反而犹豫。
   */
  const firstNoAt = new Map<string, number>()
  const firstSerialAt = new Map<string, number>()

  const out: GradeRosterChecked[] = rows.map((r) => {
    let flag: GradeRosterChecked['flag'] = 'ok'
    let reason = ''
    const className = r.classNo ? `${gradeName}(${r.classNo})班` : ''

    if (!r.name) {
      flag = 'no-name'
      reason = '缺姓名'
    } else if (!r.classNo) {
      flag = 'no-class'
      reason = '缺班号 —— 这一行不知道该放进哪个班'
    } else if (r.classNo.length > 12) {
      flag = 'no-class'
      reason = `班号太长（${r.classNo}）`
    } else if (!r.studentNo) {
      flag = 'no-no'
      reason = '缺班级内学号'
    } else if (r.serial && !SERIAL_SHAPE.test(r.serial)) {
      flag = 'serial-shape'
      reason = `序列号格式不对（${r.serial}）—— 它是"4 位年份 + 3 位序号"`
    } else if (r.serial && firstSerialAt.has(r.serial)) {
      flag = 'dup-serial'
      reason = `序列号 ${r.serial} 在第 ${firstSerialAt.get(r.serial)} 行已经出现过`
    } else {
      const k = `${r.classNo}|${r.studentNo}`
      if (firstNoAt.has(k)) {
        flag = 'dup-no'
        reason = `同一个班里的 ${r.studentNo} 号在第 ${firstNoAt.get(k)} 行已经出现过`
      }
    }

    if (r.classNo && r.studentNo && !firstNoAt.has(`${r.classNo}|${r.studentNo}`)) {
      firstNoAt.set(`${r.classNo}|${r.studentNo}`, r.line)
    }
    if (r.serial && !firstSerialAt.has(r.serial)) firstSerialAt.set(r.serial, r.line)

    return { ...r, flag, reason, className }
  })

  const bad = out.filter((r) => r.flag !== 'ok').length
  return {
    rows: out,
    summary: {
      total: out.length,
      ok: out.length - bad,
      bad,
      classes: order.map((classNo) => ({ classNo, count: countOf.get(classNo) ?? 0 })),
    },
  }
}

/**
 * 导出一份名单（**表头与导入同一套列名** —— 所以导出文件能直接导回来）。
 *
 * @param classNoOf 学生 → 班号。给不出来的那一行**留空**（导回去时会被报"缺班号"，
 *                  而不是被悄悄塞进某个班）
 */
export function gradeRosterToText(
  rows: Array<{
    name: string
    serial?: string
    studentNo: string
    classNo?: string
  }>,
): string {
  const head = ROSTER_HEADER.join('\t')
  const body = rows.map((r) =>
    [r.classNo ?? '', r.serial ?? '', r.name, r.studentNo]
      .map((v) => String(v).replace(/[\t\r\n]/g, ' '))
      .join('\t'),
  )
  return [head, ...body].join('\n')
}

/* ---------------- 名单体检：学号连续性 / 重号 / 重名 ---------------- */

export type RosterHealth = {
  count: number
  maxNo: number
  gaps: number[]
  dupNos: string[]
  dupNames: string[]
  noNumber: number
  healthy: boolean
}

export function analyzeRoster(students: Student[]): RosterHealth {
  const active = students.filter((s) => s.status === 'active')
  const nos = active.map((s) => Number(s.studentNo)).filter((n) => Number.isFinite(n))
  const maxNo = nos.length ? Math.max(...nos) : 0
  const seen = new Map<number, number>()
  for (const n of nos) seen.set(n, (seen.get(n) ?? 0) + 1)
  const dupNos = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => String(n))

  const nameCount = new Map<string, number>()
  for (const s of active) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n)

  const gaps: number[] = []
  for (let i = 1; i <= maxNo; i++) if (!seen.has(i)) gaps.push(i)

  const noNumber = active.length - nos.length
  return {
    count: active.length,
    maxNo,
    gaps,
    dupNos,
    dupNames,
    noNumber,
    /*
     * 🔴 **0 人不算"完整"**（2026-10-08 修）。
     *    原来这里 `gaps.length === 0 && dupNos.length === 0 && …` 对一个**空名单**恒为真
     *    —— 一个 0 人的班于是显示「名单完整」、体检写「学号 1–0 连续无缺号，无重号重名」、
     *    待核对写「正常」。那是这个项目栽过最多次的形状：**没有数据被当成一切正常**
     *    （RLS 挡下写入返回 0 行不报错 / 心跳条件恒假 / 探针读不到）。
     *    现在 `count > 0` 是完整的**前提**；"0 人"这件事只有一处判据：`rosterStateOf()`。
     */
    healthy: active.length > 0 && gaps.length === 0 && dupNos.length === 0 && dupNames.length === 0 && noNumber === 0,
  }
}

/* ---------------- 名单这件事的**四态**（读不到 / 空 / 完整 / 待核对） ----------------
 *
 * 🔴 为什么要有它（2026-10-08 修的那条链）：
 *    `analyzeRoster()` 只看"手上这一份名单"，它**分不开**下面四件事 ——
 *      ① 有 45 人、完整；
 *      ② 有 45 人、有缺号（待核对）；
 *      ③ **这个班还没有名单**（0 人）；
 *      ④ **名单没读到**（老库没有那张表 / 断网）—— 这一条最要命：
 *         它与 ③ 长得一模一样，而 ③ 又与 ① 长得一模一样（都是"没有缺号"）。
 *    走班班尤其明显：它的人来自 `class_members`（多对多），
 *    `students.class_id` 上永远是空的 → 读错了源就恒为 0 人，而屏上写着"名单完整"。
 *
 * 判据只有这一处；页面**不许**自己写 `count === 0` 那一套（第二个判定入口 = I17）。
 */
export type RosterStateKind = 'unknown' | 'nobody' | 'ok' | 'warn'

export type RosterState = {
  kind: RosterStateKind
  /** 名单上的人（`unknown` 时是 0，但**那不是**"这个班没人"） */
  count: number
  health: RosterHealth | null
  /**
   * 人数从哪儿来的：`students.class_id` 还是 `class_members`（多对多）。
   * 走班班是后者 —— 屏上"学号 1–N 连续"那套体检对它**没有意义**（它没有班内学号）。
   */
  source: 'class' | 'members'
}

export function rosterStateOf(
  students: readonly Student[],
  source: 'class' | 'members',
  /** `false` = 成员关系那一侧**没读到**（≥0 人这件事无从判断） */
  known = true,
): RosterState {
  if (!known) return { kind: 'unknown', count: 0, health: null, source }
  const health = analyzeRoster([...students])
  /* 🔴 `analyzeRoster()` 自己已经把 0 人判成 `healthy: false`；这里只把它翻成四态。
     不直接读 `health.count === 0` 再拼一套的理由：**判据只有一处**。 */
  if (health.healthy) return { kind: 'ok', count: health.count, health, source }
  if (health.count === 0) return { kind: 'nobody', count: 0, health: null, source }
  return { kind: 'warn', count: health.count, health, source }
}


/* ---------------- 粘贴文本解析 ---------------- */

export type ParsedRow = { studentNo: string; name: string }

const HEADER = /^\s*(序号|编号|学号|姓名|班级|备注|号)\s*$/

export function parseRosterText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const lines = text.split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.replace(/\u3000/g, ' ').trim()
    if (!line) continue

    // 跳过表头
    const parts = line.split(/[\s,，、;；|\t]+/).filter(Boolean)
    if (parts.length && parts.every((p) => HEADER.test(p))) continue
    if (!/\d/.test(line) && /学号|姓名|序号/.test(line)) continue

    let no = ''
    let name = ''

    // 形如 1.张三 / 1、张三 / 01-张三
    const glued = line.match(/^(\d{1,6})\s*[.、,，:：-]?\s*([\u4e00-\u9fa5·]{2,6})$/)
    if (glued) {
      no = glued[1]
      name = glued[2]
    } else {
      for (const p of parts) {
        if (!no && /^\d{1,6}[.、]?$/.test(p)) {
          no = p.replace(/\D/g, '')
          continue
        }
        if (!name && /[\u4e00-\u9fa5]/.test(p)) {
          name = p.replace(/[^\u4e00-\u9fa5·]/g, '').slice(0, 8)
          continue
        }
      }
      if (!name) {
        const cn = line.match(/[\u4e00-\u9fa5·]{2,6}/)
        if (cn) name = cn[0]
      }
    }

    if (!no && !name) continue
    out.push({ studentNo: no, name })
  }
  return out
}

/* ---------------- 导入校验：给每行打标记 ---------------- */

export function validateRows(rows: ParsedRow[], existing: Student[]): ImportRow[] {
  const existingByNo = new Map(
    existing.filter((s) => s.status === 'active').map((s) => [s.studentNo, s]),
  )

  const countNo = new Map<string, number>()
  const countName = new Map<string, number>()
  for (const r of rows) {
    if (r.studentNo) countNo.set(r.studentNo, (countNo.get(r.studentNo) ?? 0) + 1)
    if (r.name) countName.set(r.name, (countName.get(r.name) ?? 0) + 1)
  }

  return rows.map((r, i) => {
    const no = r.studentNo.trim()
    const name = r.name.trim()
    let flag: ImportRow['flag'] = null

    if (!no || !name) flag = 'bad'
    else if ((countNo.get(no) ?? 0) > 1) flag = 'dup-no'
    else if ((countName.get(name) ?? 0) > 1) flag = 'dup-name'

    return {
      key: `r-${i}`,
      studentNo: no,
      name,
      flag,
      existing: existingByNo.has(no),
    }
  })
}

/* ---------------- 模拟一次拍照识别 ---------------- */

export function simulateScan(classId: string): ImportRow[] {
  // 延迟由调用方控制；这里只做结果构造，并人为放入典型问题
  return [
    { key: `${classId}-1`, studentNo: '1', name: '王志远', flag: null },
    { key: `${classId}-2`, studentNo: '2', name: '李思涵', flag: null },
    { key: `${classId}-3`, studentNo: '3', name: '张雨欣', flag: null },
    { key: `${classId}-4`, studentNo: '4', name: '刘佳怡', flag: null },
    { key: `${classId}-5`, studentNo: '5', name: '陈明轩', flag: null },
    { key: `${classId}-6`, studentNo: '6', name: '杨嘉豪', flag: null },
    { key: `${classId}-7`, studentNo: '7', name: '黄雅静', flag: null },
    { key: `${classId}-8`, studentNo: '8', name: '赵子涵', flag: null },
    { key: `${classId}-9`, studentNo: '9', name: '吴欣悦', flag: null },
    { key: `${classId}-10`, studentNo: '10', name: '周', flag: 'bad' },
    { key: `${classId}-11`, studentNo: '11', name: '徐博文', flag: null },
    { key: `${classId}-12`, studentNo: '12', name: '孙志强', flag: null },
    { key: `${classId}-13`, studentNo: '12', name: '马晓明', flag: 'dup-no' },
    { key: `${classId}-14`, studentNo: '14', name: '朱文华', flag: null },
    { key: `${classId}-15`, studentNo: '15', name: '胡静怡', flag: null },
    { key: `${classId}-16`, studentNo: '16', name: '郭思远', flag: null },
  ]
}

export const FLAG_TEXT: Record<NonNullable<ImportRow['flag']>, string> = {
  'dup-no': '学号重复',
  'dup-name': '姓名重复',
  gap: '学号缺失',
  bad: '信息不完整',
}
