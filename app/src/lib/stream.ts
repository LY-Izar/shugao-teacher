/* ============================================================
   走班班（P7）—— **生成建议** 与 **课表冲突** 的**唯一判定入口**
   ------------------------------------------------------------
   `选科走班实施计划.md` P7 · `功能设计与不变量.md` §三十二。

   🔴 这个文件里有两件"只能有一处实现"的东西，它们的代价都是"**做错了不报错**"：

   ① **走班科目怎么算**（`streamDiff` / `planStreamClasses`）
      Q5 = B 按组合建班 × U-1 = A 成员多对多 —— 一个学生可以**同时**在 2 个走班班里。
      `物政地` 的学生（理科班，默认物化生）差 **2 门**（化学、生物都不同）：
      他要走的科目是 **化学** 和 **地理**，所以进**两个**走班班。
      ⚠️ 任何地方都不许写 `if (只差一门)` —— 那就是"他那一科没有课上，且不报错"。

   ② **课表冲突怎么算**（`findScheduleConflicts`）
      Q13 = A（排课时校验，冲突就**拦住**）× Q26 = A（一个老师可带多个走班班）→
      **两个维度都要算**：
        · **学生集合交集** —— 同一个学生同一节次被排到两个不同的班；
        · **老师撞课** —— 同一个老师同一节次被排到两条不同的行。
      ⚠️ 参考项目那个"冲突红字"只查**同一个班同一时间的重复行**；
         跨班走班冲突**今天没有任何一处在管**（方案 §2.3 的结论）。
      ⚠️ 只算"学生集合交集"会**漏检老师撞课**：一个老师带两个走班班，
         两个班的学生集合**可以完全不相交**，而他在同一节次有两节课。

   走班的**四科写死在代码里**（Q24 = B）：化学 / 生物 / 政治 / 地理。
   ⚠️ `subjects.can_stream` 那一列**已废弃**（§32.6 把它从库里删掉了）——
      走班科目**只认这个文件里的常量**，别再长出第二个真相。
   ============================================================ */

import type { ClassType, Klass, ScheduleItem } from '../data/types'
import { classTypeOf, type StudentSubject } from './pick'
import { subjectName, type SubjectCode } from './subjects'
import { PERIOD_SLOTS } from './scheduleParse'
import { toMinutes } from './schedule'

/* ============================================================
   一、走班四科（Q24 = B：写死在代码里）
   ============================================================ */

/**
 * 能走班的四科 —— **全仓唯一的定义处**。
 *
 * 顺序 = 界面上组合名的显示顺序（`物化政` 这种要读得出来），
 * ⚠️ 它不是"随便排的"：换顺序会让同一个组合的 `stream_key` 变样 → 走班班被重建。
 */
export const STREAM_SUBJECT_CODES: readonly SubjectCode[] = [
  'chemistry',
  'biology',
  'politics',
  'geography',
]

/** 这一科能不能走班。**只有这一个判据**（不再读字典里的 `can_stream`） */
export function isStreamSubject(code?: string | null): boolean {
  return STREAM_SUBJECT_CODES.includes(String(code ?? '') as SubjectCode)
}

/* ============================================================
   二、班型默认组合（走班是"与默认不同"才产生的）
   ============================================================ */

/**
 * 两种班型的默认选修组合。
 *
 * ⚠️ 为什么它在**代码**里、而不是从 `class_subjects` 反推：
 *   走班发生在**开学准备**那一步，而那一刻 `class_subjects`（任教关系）往往还没录完 ——
 *   从它反推会把"还没录任教关系"读成"这个班什么都不教"，然后**给整个年级的每个人都建走班班**。
 *   班型默认是**学校口径**（方案 §2.2 那张表逐行写的），写在这里是可复核的。
 */
export const CLASS_TYPE_DEFAULT_SECOND: Record<string, readonly SubjectCode[]> = {
  science: ['chemistry', 'biology'],
  arts: ['politics', 'geography'],
}

/* ============================================================
   三、一个学生的走班科目（I41：唯一入口，返回值是**数组**）
   ============================================================ */

export type StreamDiffReason = 'unset-class-type' | 'no-primary' | 'primary-mismatch' | 'other'

export type StreamDiff = {
  /** 学生选的再选两门里**合法的**那些（认不出的一律丢掉，**不猜**） */
  takes: SubjectCode[]
  /** 🔴 要走的科目（0 ~ 2 门；**2 门是常态，不是异常**） */
  walk: SubjectCode[]
  /** 他**没选**的本班默认科目（界面上"化学→政治"那一列：本班教、他不上） */
  drops: SubjectCode[]
  /** 不能自动归类时的人话原因；能归类时是 `null` */
  reason: StreamDiffReason | null
}

const EMPTY_DIFF = (reason: StreamDiffReason): StreamDiff => ({
  takes: [],
  walk: [],
  drops: [],
  reason,
})

/**
 * **这个学生要走哪几门**（I41 的唯一入口）。
 *
 * 口径（一句话，别记成两张表）：
 *   学生在**行政班**上"首选 + 班型默认那两门"，其余**他选了的**科目就要走班 ——
 *   即 **`walk = 他选的 − 本班默认教的`**（`drops = 本班默认教的 − 他选的`，只用于显示）。
 *   走班班 = **教哪几门**就在哪个班；一个学生走 2 门就是**同时进 2 个走班班**（U-1 的多对多）。
 *
 * | 学生 | 本班默认 | `walk`（要走的） | `drops`（他不上本班的） |
 * |---|---|---|---|
 * | 物政地（理科班） | 物化生 | **化学 + 地理** | 化学、生物 |
 * | 物化政（理科班） | 物化生 | **生物** | 生物 |
 * | 物化生（理科班） | 物化生 | 无（随班） | 无 |
 * | 史化生（文科班） | 史政地 | **政治 + 地理** | 政治、地理 |
 *
 * ⚠️ **第一行正是"差 2 门"**（化学、生物都不同）→ 他同时在**两个**走班班里。
 *    任何地方都不许写 `if (只差一门)` —— 那就是"他那一科没有课上，且不报错"。
 *
 * ⚠️ **首选与班型不符**（理科班里首选历史）→ **不生成走班**，返回 `primary-mismatch`：
 *     走班补不了首选那一门（那是整个班的主线），方案 §2.2 的处置是"建议转班"（Q2），
 *     硬把他塞进走班班只会让他"物理没得上"而且不报错。
 * ⚠️ 未分科（`undivided` / 还没设）→ `unset-class-type`：**整班随班上课，不算走班**（方案 §2.4）。
 * ⚠️ 「其他」（结构都不满足）→ `other`：**必须手工选走班班**（Q1 = C），**绝不自动归类**。
 */
export function streamDiff(
  s: StudentSubject | null | undefined,
  classType: ClassType | string | undefined,
): StreamDiff {
  if (!s) return EMPTY_DIFF('other')
  if (s.kind === 'other') return EMPTY_DIFF('other')

  const t = classType === 'science' || classType === 'arts' ? classType : ''
  if (!t) return EMPTY_DIFF('unset-class-type')

  const primary = String(s.primaryCode ?? '')
  if (!primary) return EMPTY_DIFF('no-primary')
  const wantPrimary = t === 'science' ? 'physics' : 'history'
  if (primary !== wantPrimary) return EMPTY_DIFF('primary-mismatch')

  const def = CLASS_TYPE_DEFAULT_SECOND[t] ?? []
  const takes = (Array.isArray(s.secondCodes) ? s.secondCodes : [])
    .map((c) => String(c))
    .filter((c): c is SubjectCode => isStreamSubject(c))
  /* 🔴 `walk` 与 `drops` 是**两个方向**的差集 —— 写反了就是"他去的班教的是他没选的课" */
  const walk = takes.filter((c) => !def.includes(c))
  const drops = def.filter((c) => !takes.includes(c))
  return { takes, walk, drops, reason: null }
}

/* ============================================================
   四、走班班的标识与名字（stream_key / name）
   ============================================================ */

/** 走班班的键：科目代码的规范串（`chemistry+geography`）。**顺序固定**，不许就地拼 */
export const STREAM_KEY_SEP = '+'

export function streamKeyOf(codes: readonly string[]): string {
  const set = new Set(codes.filter((c) => isStreamSubject(c)))
  return STREAM_SUBJECT_CODES.filter((c) => set.has(c)).join(STREAM_KEY_SEP)
}

/** 走班班的显示名（Q14：走班班自带号，**不用真实教室名**） */
export function streamClassNameOf(codes: readonly string[]): string {
  const names = STREAM_SUBJECT_CODES.filter((c) => codes.includes(c)).map((c) => subjectName(c, c))
  return `走班班-${names.join('')}`
}

/**
 * 从一个走班班的 `stream_key`（或名字）反查它教哪几科。
 *
 * ⚠️ **认不出就不猜**：返回空数组。名字那条兼容支只认「走班班-化学生物…」这种
 *    由 `streamClassNameOf()` 生成过的形状 —— 老师手工改成「高一化学走班」之后
 *    这里读不出来，那种班要由界面提示"认不出它教哪几科"，**不许拿别的科目顶上**。
 */
export function streamSubjectsOf(streamKey?: string | null, name?: string | null): SubjectCode[] {
  const key = String(streamKey ?? '').trim()
  if (key) {
    const codes = key
      .split(STREAM_KEY_SEP)
      .map((x) => x.trim())
      .filter((x): x is SubjectCode => isStreamSubject(x))
    if (codes.length) return STREAM_SUBJECT_CODES.filter((c) => codes.includes(c))
  }
  const n = String(name ?? '').trim()
  if (n.startsWith('走班班-')) {
    const tail = n.slice(4)
    const hits = STREAM_SUBJECT_CODES.filter((c) => tail.includes(subjectName(c)))
    if (hits.length) return hits
  }
  return []
}

/* ============================================================
   五、生成建议（扫全年级选科 → 算出需要哪几个走班班 → **给建议**）
   ============================================================ */

/** 一个要走班的科目（= 一个走班班） */
export type StreamClassPlan = {
  streamKey: string
  name: string
  subjectCodes: SubjectCode[]
  /** 这个班要收的学生 id */
  studentIds: string[]
  /** 这些人分布在哪些行政班里（界面回显） */
  classIds: string[]
}

/** 自动归类不了的学生：**列出来让教导处手工处理**，绝不静默塞进某个班 */
export type StreamPending = {
  studentId: string
  name: string
  /** 序列号（全校唯一；没有就是空串 —— 与展示层同一口径） */
  serial: string
  /** 班内学号（序列号没有时用它认人） */
  studentNo: string
  className: string
  reason: StreamDiffReason
  /** 人话原因 */
  note: string
}

/** 选科分布里的一行（"物化政 18 人"那种；界面用它给人复核"生成结果对不对得上"） */
export type StreamComboRow = {
  combination: string
  count: number
  /** 这个组合要走哪几门 */
  walk: SubjectCode[]
  /** 这些人分布在哪些行政班 */
  classIds: string[]
}

export type StreamPlan = {
  /** 要建的走班班（`kind='stream'`；按 `stream_key` 去重） */
  classes: StreamClassPlan[]
  /** 待教导处手工处理的人 */
  pending: StreamPending[]
  /** 选科分布（**复核用**：生成结果与它对得上） */
  combos: StreamComboRow[]
  /** 参与生成的学生总数（分母）—— **在读 + 休学**，不含已转出（Q28 = B） */
  students: number
}

const REASON_TEXT: Record<StreamDiffReason, string> = {
  'unset-class-type': '这个班还没设班型（走班只对理科班 / 文科班生成）',
  'no-primary': '还没选首选科目',
  'primary-mismatch': '首选与班型不符（建议转班，走班补不了首选那一科）',
  other: '「其他」组合（必须手工选走班班）',
}

/** 一个学生的显示名（序列号优先，因为它全校唯一） */
function labelOf(st: { serial?: string; studentNo: string; name: string }): string {
  return [st.serial || st.studentNo, st.name].filter(Boolean).join(' ')
}

/**
 * 扫全年级 → 算建议。**只算、不写**（Q7 = B：教导处确认之后才建）。
 *
 * @param classes 这一届的**全部**班（`kind='admin'` 的那些才是分母；走班班传进来会被忽略）
 * @param subjects `studentId → 选科那一行`
 *
 * ⚠️ **排列顺序是确定的**：走班班按 `STREAM_SUBJECT_CODES` 的顺序，
 *    组合按人数从多到少、同数按名字 —— 同样的数据每次算出来**逐字相同**
 *    （生成是幂等的：第二次跑不会因为顺序变了而重建班）。
 */
export function planStreamClasses(
  classes: readonly Klass[],
  subjects: ReadonlyMap<string, StudentSubject>,
): StreamPlan {
  const admin = classes.filter((k) => k.kind !== 'stream')
  const byStudent = new Map<string, { name: string; serial: string; studentNo: string; className: string; classId: string; classType: ClassType }>()
  for (const k of admin) {
    const ct = classTypeOf(k)
    for (const st of k.students) {
      /*
       * ✅ Q28 = B：**只跳过"已转出"**（`left`）—— 转班/转学移出走班名单。
       * ⚠️ **休学（`suspended`）照旧参与生成**：用户口径是"休学保留但标记、
       *    复学可一键恢复"，所以他的走班班成员关系必须**继续算进去** ——
       *    写成 `status !== 'active'` 的话，教导处下一次"重新生成走班班"就会
       *    把休学生**静默移出**（`generate_stream_classes()` 是整组重算成员的）。
       */
      if (st.status === 'left') continue
      byStudent.set(st.id, {
        name: st.name,
        serial: st.serial ?? '',
        studentNo: st.studentNo,
        className: k.name,
        classId: k.id,
        classType: ct,
      })
    }
  }

  /* 每个走班科目收哪些人（一个学生可能进**多个**） */
  const members = new Map<SubjectCode, Set<string>>()
  const pending: StreamPending[] = []
  const comboMap = new Map<string, { walk: Set<SubjectCode>; ids: Set<string>; classIds: Set<string> }>()

  for (const [studentId, info] of byStudent) {
    const s = subjects.get(studentId) ?? null
    const d = streamDiff(s, info.classType)
    if (d.reason !== null) {
      pending.push({
        studentId,
        name: info.name,
        serial: info.serial,
        studentNo: info.studentNo,
        className: info.className,
        reason: d.reason,
        note: REASON_TEXT[d.reason],
      })
      continue
    }
    /* 选科分布那一行：**按学生自己选的组合**列（方案 §4.3.4 那张"选科分布"） */
    const combo = [s?.primaryCode ?? '', ...(s?.secondCodes ?? [])]
      .filter(Boolean)
      .map((c) => subjectName(c, c))
      .join('')
    if (combo) {
      const row = comboMap.get(combo) ?? { walk: new Set<SubjectCode>(), ids: new Set<string>(), classIds: new Set<string>() }
      d.walk.forEach((c) => row.walk.add(c))
      row.ids.add(studentId)
      row.classIds.add(info.classId)
      comboMap.set(combo, row)
    }
    /* 🔴 差 2 门的学生在这里进**两个** Set —— 这就是 U-1 的多对多 */
    for (const code of d.walk) {
      const set = members.get(code) ?? new Set<string>()
      set.add(studentId)
      members.set(code, set)
    }
  }

  const out: StreamClassPlan[] = []
  for (const code of STREAM_SUBJECT_CODES) {
    const ids = members.get(code)
    if (!ids || !ids.size) continue
    const streamKey = streamKeyOf([code])
    out.push({
      streamKey,
      name: streamClassNameOf([code]),
      subjectCodes: [code],
      studentIds: [...ids].sort(),
      classIds: [...new Set([...ids].map((id) => byStudent.get(id)?.classId ?? ''))].filter(Boolean).sort(),
    })
  }

  const combos: StreamComboRow[] = [...comboMap.entries()]
    .map(([combination, v]) => ({
      combination,
      count: v.ids.size,
      walk: STREAM_SUBJECT_CODES.filter((c) => v.walk.has(c)),
      classIds: [...v.classIds].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.combination.localeCompare(b.combination))

  pending.sort((a, b) => a.className.localeCompare(b.className) || labelOf(a).localeCompare(labelOf(b)))

  return { classes: out, pending, combos, students: byStudent.size }
}

/* ============================================================
   六、课表冲突（I58：**两个维度**，三个入口共用这一处）
   ============================================================ */

/** 保存一条课表时要问的东西 */
export type StreamScheduleContext = {
  /** 所有班（含走班班）—— 用来认"这一行是不是走班班的课" */
  classes: readonly Klass[]
  /** `classId → 学生 id 数组`（走班班的成员 + 行政班的名单，**同一个形状**） */
  members: ReadonlyMap<string, readonly string[]>
  /** `classId → subject_code → teacher_id`（走班班自动补过的那张表） */
  teachers: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** 已经在库里的课表（`scope='mine'` 与 `scope='class'` 都要） */
  existing: readonly ScheduleItem[]
  /** 本次要保存的行（**先校验后写**） */
  pending: readonly ScheduleItem[]
}

export type ScheduleConflict = {
  /** 人话一行（界面直接显示） */
  message: string
  /** `student` = 学生撞课；`teacher` = 老师撞课 */
  kind: 'student' | 'teacher'
}

const hhmm = (v: string) => {
  const [h, m] = String(v).split(':').map(Number)
  return `${String(h || 0).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`
}

/** 「第 N 节」—— 用 `PERIOD_SLOTS` 反查（`schedule_items` **没有节次列**，只有 start/end） */
export function periodOf(start: string): number | null {
  const t = hhmm(start)
  const i = PERIOD_SLOTS.findIndex(([s]) => s === t)
  return i >= 0 ? i + 1 : null
}

export function slotTextOf(start: string, end: string): string {
  const n = periodOf(start)
  return `${hhmm(start)}–${hhmm(end)}${n ? `（第 ${n} 节）` : ''}`
}

/** 时间重叠（半开区间：`08:00-08:40` 与 `08:40-09:30` **不算**冲突） */
export function timeOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end)
}

/** 这一行的班是哪几个（`classId` 空 = 未归属，不参与冲突判定） */
function classOf(it: ScheduleItem): string {
  return String(it.classId ?? '').trim()
}

/** 学科 → 老师（走班班的任教关系；`_` = 认不出科目的兜底那一档） */
const ANY_SUBJECT = '_'

function teacherIdFor(
  ctx: StreamScheduleContext,
  classId: string,
  klass: Klass | undefined,
): string {
  const bySub = ctx.teachers.get(classId)
  if (!bySub) return ''
  for (const s of streamSubjectsOf(klass?.streamKey, klass?.name)) {
    const t = bySub.get(s)
    if (t) return t
  }
  return bySub.get(ANY_SUBJECT) ?? ''
}

/**
 * 🔴 **走班课表冲突的唯一算法**（三个排课入口都必须调它）。
 *
 * 两个维度（**`Q13 = A` × `Q26 = A` 的叠加**，缺一个就是"少拦一半"）：
 *   ① **学生集合交集**：两条**不同班**的行，同一星期、时间重叠，
 *      而两个班**有共同的学生** → 那个学生被排了两节课。名单取
 *      `ctx.members`（走班班来自 `class_members`，行政班来自 `students.class_id`）。
 *   ② **老师撞课**：两条**不同行**（不同班或不同标题），同一星期、时间重叠，
 *      而**老师是同一个人** → 他被排了两节课。老师来自 `ctx.teachers`
 *      （走班班那一行由"分配走班班老师"自动补进 `class_subjects`）。
 *
 * ⚠️ **同一个班里同一时间的两行**（同一节次重复贴了一行）**不算**这里的冲突 ——
 *    那是"贴课表时贴重了"，归教室端现有的红字提示；这里只管**跨班走班**。
 * ⚠️ 返回值只列**人话那一行**，`kind` 用来让界面把两类分开显示（验收要求"两条分开断言"）。
 */
export function findScheduleConflicts(ctx: StreamScheduleContext): ScheduleConflict[] {
  const byId = new Map(ctx.classes.map((k) => [k.id, k]))
  const all: Array<{ it: ScheduleItem; pending: boolean }> = [
    ...ctx.existing.map((it) => ({ it, pending: false })),
    ...ctx.pending.map((it) => ({ it, pending: true })),
  ]
  const out: ScheduleConflict[] = []
  const seen = new Set<string>()

  const push = (c: ScheduleConflict, key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  const membersOf = (classId: string) => ctx.members.get(classId) ?? []

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]
      const b = all[j]
      if (a.it.weekday !== b.it.weekday) continue
      /* 同一份待保存的清单里同名同时间的行不重复报（一次粘贴里常见） */
      if (a.it.id === b.it.id) continue
      if (!timeOverlap(a.it, b.it)) continue

      /* ---- ① 老师撞课（先算它：它不要求两次都有班） ---- */
      const ca = classOf(a.it)
      const cb = classOf(b.it)
      if (ca !== cb) {
        const ta = teacherIdFor(ctx, ca, byId.get(ca))
        const tb = teacherIdFor(ctx, cb, byId.get(cb))
        if (ta && tb && ta === tb) {
          push(
            {
              kind: 'teacher',
              message: `老师撞课：${weekdayText(a.it.weekday)} ${slotTextOf(a.it.start, a.it.end)} —— ${titleOf(a.it, byId)} 与 ${titleOf(b.it, byId)} 是同一位老师`,
            },
            `t|${[a.it.weekday, a.it.start, a.it.end, ca, cb].join('|')}`,
          )
        }
      }

      /* ---- ② 学生撞课（同一行或同一个班不算：那是一个人被排了一次） ---- */
      if (!ca || !cb || ca === cb) continue
      const sa = membersOf(ca)
      const sb = membersOf(cb)
      if (!sa.length || !sb.length) continue
      const setB = new Set(sb)
      const hit = sa.filter((id) => setB.has(id))
      if (!hit.length) continue
      push(
        {
          kind: 'student',
          message: `学生撞课：${weekdayText(a.it.weekday)} ${slotTextOf(a.it.start, a.it.end)} —— ${hit.length} 人在 ${titleOf(a.it, byId)} 与 ${titleOf(b.it, byId)} 两边都有课`,
        },
        `s|${[a.it.weekday, a.it.start, a.it.end, ...[ca, cb].sort()].join('|')}`,
      )
    }
  }

  /* 学生那一类排前面（它更贴近"学生没课上/撞车"这件事） */
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'student' ? -1 : 1))
}

function weekdayText(w: number): string {
  return `周${'一二三四五六日'[w - 1] ?? '?'}`
}

function titleOf(it: ScheduleItem, byId: ReadonlyMap<string, Klass>): string {
  const name = byId.get(classOf(it))?.name
  return name ? `${name} ${it.title}` : it.title
}

/**
 * **没有走班班就别校验** —— 让这个函数在"还没有走班班"的库上**恒定放行**，
 * 老库 / 还没生成走班班的年级上的行为**一个字节都不变**（§31.4 的对照法）。
 *
 * ⚠️ 反过来：**只要这个年级有走班班，校验就必须真的跑**（哪怕这回保存的是行政班的课）——
 *    "少一处 = 有一个入口能绕过"，而绕过的那一处**看起来很正常**。
 */
export function shouldCheckConflicts(ctx: Pick<StreamScheduleContext, 'classes'>, gradeId?: string): boolean {
  return ctx.classes.some(
    (k) => k.kind === 'stream' && (!gradeId || !k.gradeId || k.gradeId === gradeId),
  )
}

/** 冲突 → 界面上那一段人话（拦住时显示；最多列 3 条，其余报总数） */
export function conflictBlockMessage(conflicts: readonly ScheduleConflict[]): string {
  if (!conflicts.length) return ''
  const head = conflicts.slice(0, 3).map((c) => c.message)
  const rest = conflicts.length - head.length
  return [`这张课表和走班班撞了 ${conflicts.length} 处，没有保存：`, ...head, rest > 0 ? `…还有 ${rest} 处` : '']
    .filter(Boolean)
    .join('\n')
}
