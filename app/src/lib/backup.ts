import { getSupabase } from './supabase'
import { postApi, apiMessage } from './api'
import { useStore, useToast } from '../data/store'
import { toISODate } from './date'
import { clampQuestionCount, isUnassigned } from './assignments'
import { isSerial, assignMissingSerials, yearLookupFromClasses } from './serial'
import {
  DEFAULT_SUBJECT_CODE,
  alignAssignmentSubject,
  alignTeacherPrimarySubject,
  asSubjectCode,
  subjectCodeOfName,
  subjectName,
} from './subjects'
import {
  assignmentWriteRow,
  callToRow,
  classRows,
  classroomToRow,
  ensureSubjectCols,
  scheduleToRow,
  studentToRow,
} from '../data/remote'
import type {
  Assignment,
  AssignmentStatus,
  CallRecord,
  CallState,
  ClassroomClient,
  Klass,
  QuestionMeta,
  ScheduleItem,
  ScheduleKind,
  Student,
  StudentStatus,
  Teacher,
} from '../data/types'

/* ============================================================
   备份与恢复
   ------------------------------------------------------------
   两种方式，都是「落到本机硬盘上一个文件」：

   ① 一键导出 JSON —— 任何浏览器都能用，教师自己存 U 盘/网盘
   ② 授权一个文件夹，之后每次数据变动自动往里写 —— 需要一次授权

   注意：云端（Supabase）才是主副本，这里是**额外**的一份。
   两边都坏才会真丢数据 —— 这正是备份该有的样子。
   ============================================================ */

/**
 * 备份格式版本。**写出去的一律是当前版本，读进来的一律兼容到 v1。**
 *
 * · **v1**：没有 `subjectCode` / `primarySubjectCode` 两个字段（学科只有中文显示名）。
 * · **v2**（2026-09-25）：带上它们，恢复时才能把"判据"一起搬回去。
 * · **v3**（2026-09-25 · P1 序列号键迁移）：`students[].serial` 进备份，
 *   而**那 10 个字段的键的含义从"班内学号"变成"序列号"**（`schema.sql` §20 / I40）。
 *
 * 🔴 **v1 / v2 老备份必须永远能导入**，不许因为"淘汰了"就删掉兼容分支：
 *    v1 按**显示名反查字典**把学科 code 补回来（`subjectCodeOfName`），反查不出来
 *    （老师写的是「物理竞赛」这种字典外显示名）就留 `undefined`，**绝不写 `null`、也绝不猜**（I14）；
 *    v1/v2 的**档案键**按"班内学号 → 该生的序列号"反查着补（见 `upgradeKeysToSerial`），
 *    **补不到的留原键，并把条数报给用户**（"绝不静默丢弃"）。理由见 功能设计与不变量.md §12.7。
 */
export type Backup = {
  v: 3
  at: number
  teacher?: Teacher | null
  classes: Klass[]
  assignments: Assignment[]
  schedule: ScheduleItem[]
  calls: CallRecord[]
  classrooms: ClassroomClient[]
}

export function makeBackup(s: {
  teacher: Teacher | null
  classes: Klass[]
  assignments: Assignment[]
  schedule: ScheduleItem[]
  calls: CallRecord[]
  classrooms: ClassroomClient[]
}): Backup {
  return {
    v: 3,
    at: Date.now(),
    teacher: s.teacher,
    classes: s.classes,
    assignments: s.assignments,
    schedule: s.schedule,
    calls: s.calls,
    classrooms: s.classrooms,
  }
}

/* ============================================================
   归一化：备份是**外部文件**，字段可能缺、类型可能不对
   ------------------------------------------------------------
   恢复是不可逆的，而且恢复完每个页面都会去读这些数据：
   少一个数组字段（老备份没有 `correctionNos` / `focusNos`）就会让
   `a.missingNos.filter(...)` 直接抛异常 —— 页面白屏，而且全仓没有 ErrorBoundary 兜。
   所以在唯一的入口这里把结构补齐、把明显越界/类型不对的值收回来。
   ⚠️ 只补结构，**不改语义**：没记录的字段一律给"空例外集"，不给任何"已批/已交"的默认值。
   ============================================================ */

const STATUSES: AssignmentStatus[] = ['open', 'collected', 'graded', 'reviewed', 'archived']

/** 与 store.ts 里的同名函数一致（uuid 列不接受短串）；lib 不该反过来 import store，所以本地留一份 */
function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const asText = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback

const asNumber = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

const asTextList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []

function asRecord<T>(v: unknown, map: (x: unknown) => T | undefined): Record<string, T> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, T> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const mapped = map(val)
    if (mapped !== undefined) out[k] = mapped
  }
  return out
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^(\d{1,2}):(\d{2})/

/** 学生：`id` 是 React key 也是数据库主键；学号是档案里所有记录的键，两个都不能空 */
function normalizeStudent(raw: unknown, index: number, seenIds: Set<string>): Student {
  const s = (raw ?? {}) as Partial<Student>
  let id = asText(s.id)
  if (!id || seenIds.has(id)) id = uuid()
  seenIds.add(id)
  const status: StudentStatus = s.status === 'left' ? 'left' : 'active'
  /*
   * 序列号（v3 才有）：**原样收下**（非空字符串就要），但**不在这里校验形状、也不补号** ——
   * 补号是 `upgradeKeysToSerial` 的活（它要看到整班名单才能按 U-2 的规则"追加到年级末尾"）。
   * `legacyStudentNo` **故意不收**：它是迁移判据（数据库 §20.2 的触发器会拒写），
   * 备份里带上它只会让"恢复"多一个能把它写坏的机会。
   */
  const serial = typeof s.serial === 'string' ? s.serial.trim() : ''
  return {
    id,
    studentNo: asText(s.studentNo) || String(index + 1),
    ...(serial ? { serial } : {}),
    name: asText(s.name),
    status,
    ...(typeof s.note === 'string' ? { note: s.note } : {}),
    createdAt: asNumber(s.createdAt, Date.now()),
  }
}

function normalizeKlass(raw: unknown): Klass {
  const k = (raw ?? {}) as Partial<Klass>
  const id = asText(k.id) || uuid()
  const seen = new Set<string>()
  const list = Array.isArray(k.students) ? k.students : []
  const students = list.map((s, i) => normalizeStudent(s, i, seen))
  // 学号是班内唯一索引（数据库还有 unique 约束）：撞号会让整条 upsert 被拒
  const usedNos = new Set<string>()
  for (const s of students) {
    if (usedNos.has(s.studentNo)) {
      let n = students.length + 1
      while (usedNos.has(String(n))) n++
      s.studentNo = String(n)
    }
    usedNos.add(s.studentNo)
  }
  return {
    id,
    name: asText(k.name, '未命名班级'),
    grade: asText(k.grade),
    year: asText(k.year),
    createdAt: asNumber(k.createdAt, Date.now()),
    students,
  }
}

function normalizeAssignment(raw: unknown): Assignment {
  const a = (raw ?? {}) as Partial<Assignment>
  const status = STATUSES.includes(a.status as AssignmentStatus)
    ? (a.status as AssignmentStatus)
    : 'open'
  /*
   * 🔴 **学科：判据（code）和显示名一起补齐**（I13）。
   *
   * 这里曾经漏掉 `subjectCode`（导出带、导入丢）—— 后果是不报错的：
   * 恢复完再批改一次，`saveAssignment` 把云端 `subject_code` 写成 NULL；
   * 本地模式下老师的主学科也跟着没了，化学竞赛老师新建作业默认成"物理"。
   *
   * 取值顺序：先认 code（v2 备份里有），再按显示名反查字典（v1 老备份只能这样兜）。
   * **两个都认不出来就留 `undefined`**（不是 `null`）：字典外的显示名（「物理竞赛」）
   * 本来就没有判据，编一个出来会写进不可逆的历史数据（I14）。
   */
  const subjectCode = asSubjectCode(a.subjectCode) ?? subjectCodeOfName(a.subject)
  const item: Assignment = {
    id: asText(a.id) || uuid(),
    title: asText(a.title, '未命名作业'),
    classId: asText(a.classId),
    // 兜底值来自学科字典（这个文件以前手写了第二份「物理」）
    subject: asText(
      a.subject,
      subjectCode ? subjectName(subjectCode) : subjectName(DEFAULT_SUBJECT_CODE),
    ),
    // 认出来了才带上；认不出**不加这个键**（JSON 里连 `null` 都不出现）
    ...(subjectCode ? { subjectCode } : {}),
    assignDate: ISO_DATE.test(asText(a.assignDate)) ? asText(a.assignDate) : toISODate(new Date()),
    // 数据库有 check (question_count between 1 and 60)：越界会让**整条 upsert 被拒**（刷新即丢）
    // ——夹取的定义只有一处（`lib/assignments.ts` 的 clampQuestionCount，I8 的守门人）
    questionCount: clampQuestionCount(asNumber(a.questionCount, 1)),
    status,
    ...(typeof a.templateId === 'string' ? { templateId: a.templateId } : {}),
    createdAt: asNumber(a.createdAt, Date.now()),
    collected: a.collected === true,
    missingNos: asTextList(a.missingNos),
    lateNos: asTextList(a.lateNos),
    subQuestions: asRecord(a.subQuestions, (x) => {
      const n = Math.round(asNumber(x, 0))
      return n > 0 ? n : undefined
    }),
    questionMeta: asRecord<QuestionMeta>(a.questionMeta, (x) =>
      x && typeof x === 'object' && !Array.isArray(x) ? (x as QuestionMeta) : undefined,
    ),
    wrong: asRecord(a.wrong, (x) => asTextList(x)),
    confirmedNos: asTextList(a.confirmedNos),
    ...(a.gradeSeconds === undefined ? {} : { gradeSeconds: asNumber(a.gradeSeconds, 0) }),
    ...(a.gradedAt === undefined ? {} : { gradedAt: asNumber(a.gradedAt, 0) }),
    statsMode: a.statsMode === 'simple' ? 'simple' : 'normal',
    focusNos: asTextList(a.focusNos),
    grades: asRecord(a.grades, (x) => (typeof x === 'string' && x ? x : undefined)),
    correctionNos: asTextList(a.correctionNos),
    correctedNos: asTextList(a.correctedNos),
  }
  // 认出了 code 就把显示名对齐成它（`subject` 是 code 的显示缓存）；认不出原样保留
  return alignAssignmentSubject(item)
}

function normalizeSchedule(raw: unknown): ScheduleItem {
  const s = (raw ?? {}) as Partial<ScheduleItem>
  const hhmm = (v: unknown, fallback: string) => {
    const m = HHMM.exec(asText(v))
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : fallback
  }
  return {
    id: asText(s.id) || uuid(),
    // 数据库 check (weekday between 1 and 7)
    weekday: Math.min(7, Math.max(1, Math.round(asNumber(s.weekday, 1)))),
    start: hhmm(s.start, '08:00'),
    end: hhmm(s.end, '08:40'),
    title: asText(s.title, '未命名'),
    ...(typeof s.classId === 'string' && s.classId ? { classId: s.classId } : {}),
    ...(typeof s.room === 'string' && s.room ? { room: s.room } : {}),
    kind: (s.kind === 'other' ? 'other' : 'class') as ScheduleKind,
    notify: s.notify !== false,
    scope: s.scope === 'class' ? 'class' : 'mine',
  }
}

function normalizeClassroom(raw: unknown): ClassroomClient {
  const c = (raw ?? {}) as Partial<ClassroomClient>
  return {
    id: asText(c.id) || uuid(),
    classId: asText(c.classId),
    name: asText(c.name, '一体机'),
    online: c.online === true,
    lastSeenAt: asNumber(c.lastSeenAt, 0),
  }
}

function normalizeCall(raw: unknown): CallRecord {
  const c = (raw ?? {}) as Partial<CallRecord>
  const sentAt = Array.isArray(c.sentAt)
    ? c.sentAt.map((t) => asNumber(t, 0)).filter((t) => t > 0)
    : []
  return {
    id: asText(c.id) || uuid(),
    assignmentId: asText(c.assignmentId),
    classId: asText(c.classId),
    studentNos: asTextList(c.studentNos),
    text: asText(c.text),
    room: asText(c.room),
    // 空的时间戳数组会让 `Math.max(0, ...[])` 变成 0 → 去重键恒定，重播就再也播不出来
    sentAt: sentAt.length ? sentAt : [Date.now()],
    states: asRecord<CallState>(c.states, (x) =>
      x === 'arrived' || x === 'corrected' || x === 'called' ? x : undefined,
    ),
  }
}

function normalizeTeacher(raw: unknown): Teacher | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Partial<Teacher>
  const code = asSubjectCode(t.primarySubjectCode)
  const item: Teacher = {
    id: asText(t.id, 't-1'),
    name: asText(t.name, '老师'),
    subject: asText(t.subject, subjectName(DEFAULT_SUBJECT_CODE)),
    school: asText(t.school),
  }
  // 与作业同一条纪律：认得出才写，认不出留 undefined（v1 老备份只能按显示名反查）
  if (code) item.primarySubjectCode = code
  /*
   * ⚠️ 只补 `primarySubjectCode`，**不动 `subject`**：那是老师自己写的显示标签，
   *    可能是「物理竞赛」这种字典外写法（见 §12.2），拿字典名覆盖它等于抹掉老师写的东西。
   */
  return alignTeacherPrimarySubject(item)
}

/**
 * 一份备份值不值得信 —— 恢复是不可逆的，宁可不恢复也不能恢复半份。
 *
 * 🔴 **版本判据：`v1` / `v2` / `v3` 都收**，收完一律按当前版本（v3）返回。
 *    v1 没有 `subjectCode` / `primarySubjectCode`，由两个 normalize 按显示名反查字典兜住；
 *    v1/v2 的**档案键是班内学号**，由 `upgradeKeysToSerial()` 补成序列号
 *    （补不到的**留原键**并把条数报出来 —— 绝不静默丢弃）。
 *    版本比当前高（v4+）或没有 `v` 的**不认**：宁可报错，也不要猜一份看不懂的结构。
 */
export function validateBackup(raw: unknown): { ok: true; data: Backup } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '不是有效的备份文件' }
  // `v` 单独按 number 读：Backup['v'] 是字面量 3，直接比较 1 会被 TS 判成"不可能相等"
  const b = raw as Omit<Partial<Backup>, 'v'> & { v?: number }
  if (b.v !== 1 && b.v !== 2 && b.v !== 3) return { ok: false, why: `备份版本不认识（v${String(b.v)}）` }
  if (!Array.isArray(b.classes)) return { ok: false, why: '缺少班级数据' }
  if (!Array.isArray(b.assignments)) return { ok: false, why: '缺少作业数据' }
  const classes = b.classes.map(normalizeKlass)
  const students = classes.reduce((n, c) => n + c.students.length, 0)
  if (students === 0) return { ok: false, why: '备份里一个学生都没有，可能是坏文件' }

  // 教室端一台设备对一个班（数据库还有 unique (class_id)）：重复的只留一台，
  // 否则回推云端时整批 upsert 会被唯一约束拒掉
  const roomByClass = new Map<string, ClassroomClient>()
  for (const rawRoom of Array.isArray(b.classrooms) ? b.classrooms : []) {
    const c = normalizeClassroom(rawRoom)
    if (!roomByClass.has(c.classId)) roomByClass.set(c.classId, c)
  }

  /*
   * v1/v2 的档案键是**班内学号**（Q6 迁移之前的口径）——
   * 这里把它们补成序列号：先给缺号的学生按 U-2 的规则发号，再按
   * "班内学号 → 序列号" 一对一重写那 10 个字段的键。**查不到的留原键**。
   */
  const upgraded = upgradeKeysToSerial({
    classes,
    assignments: (b.assignments as unknown[]).map(normalizeAssignment),
    calls: (Array.isArray(b.calls) ? b.calls : []).map(normalizeCall),
  })

  return {
    ok: true,
    data: {
      // 收进来的是 v1 / v2 / v3 都好，**从这里往后一律是 v3**（归一化后的结构）
      v: 3,
      at: asNumber(b.at, 0),
      teacher: normalizeTeacher(b.teacher),
      classes: upgraded.classes,
      assignments: upgraded.assignments,
      schedule: (Array.isArray(b.schedule) ? b.schedule : []).map(normalizeSchedule),
      calls: upgraded.calls,
      classrooms: [...roomByClass.values()],
    },
  }
}

/* ---------------- v1/v2 → v3：把档案键从"班内学号"补成"序列号" ----------------
 *
 * 规矩与 `supabase/schema.sql` §20 的迁移**逐条相同**（同一个不变量，两条路径都要守）：
 *   ① **先给缺号的学生发号**（U-2 = A：追加到年级末尾）—— 用 `lib/serial.ts`（那里是
 *      `serial_year_of_class()` 的镜像）；
 *   ② **映射一对一**：`班内学号 → 序列号`（同一个班内唯一，因为 `unique (class_id, student_no)`）；
 *   ③ **查不到的键留原键**，并把条数报出来（I14：认不出不许猜）；
 *   ④ **幂等**：已经全是序列号的、以及已经补过的，重跑一遍不会变（序列号查不到对应关系就原样）。
 * ============================================================ */

export type KeyUpgradeStats = { converted: number; unresolved: number; assigned: number }

/** 上面那次升级的统计（给"恢复完成"的提示用；`undefined` = 没有发生过升级） */
export let lastKeyUpgrade: KeyUpgradeStats | undefined

function upgradeKeysToSerial(input: {
  classes: Klass[]
  assignments: Assignment[]
  calls: CallRecord[]
}): { classes: Klass[]; assignments: Assignment[]; calls: CallRecord[]; stats: KeyUpgradeStats } {
  const before = countNonSerialKeys(input)
  const hasMissing = input.classes.some((c) => c.students.some((s) => !s.serial))
  if (!hasMissing && before === 0) {
    // 已经是 v3 形状（或这份备份本来就是从迁移后的库里导出的）→ **一个字都不动**
    lastKeyUpgrade = undefined
    return { ...input, stats: { converted: 0, unresolved: 0, assigned: 0 } }
  }

  // ① 发号：届的来路与数据库同顺序（先问当前 store 里同年级的已有序列号）；
  //    **编号基数要带上当前 app 已有的班** —— 否则恢复会从 001 重来、撞上唯一索引
  const current = currentStoreClasses()
  const yearOf = yearLookupFromClasses(current)
  const { classes, assigned } = assignMissingSerials(input.classes, yearOf, current)

  // ② 每个班一张 `班内学号 → 序列号` 表
  const maps = new Map<string, Map<string, string>>()
  for (const k of classes) {
    const m = new Map<string, string>()
    for (const s of k.students) if (s.serial) m.set(s.studentNo, s.serial)
    maps.set(k.id, m)
  }
  let unresolved = 0
  const conv = (classId: string, key: string): string => {
    const hit = maps.get(classId)?.get(key)
    if (hit) return hit
    // 认不出就留原键 —— "已经是序列号"也走这一支（原样返回，所以重跑是幂等的）
    if (!isSerial(key) && key !== '') unresolved++
    return key
  }
  const convList = (classId: string, list: string[] | undefined): string[] =>
    (list ?? []).map((n) => conv(classId, n))
  const convRec = <T,>(classId: string, rec: Record<string, T> | undefined): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec ?? {})) out[conv(classId, k)] = v
    return out
  }

  const assignments = input.assignments.map((a) => ({
    ...a,
    missingNos: convList(a.classId, a.missingNos),
    lateNos: convList(a.classId, a.lateNos),
    confirmedNos: convList(a.classId, a.confirmedNos),
    focusNos: convList(a.classId, a.focusNos),
    correctionNos: convList(a.classId, a.correctionNos),
    correctedNos: convList(a.classId, a.correctedNos),
    wrong: convRec(a.classId, a.wrong),
    grades: convRec(a.classId, a.grades),
  }))

  const calls = input.calls.map((c) => ({
    ...c,
    studentNos: convList(c.classId, c.studentNos),
    states: convRec(c.classId, c.states),
  }))

  lastKeyUpgrade = { converted: before - unresolved, unresolved, assigned }
  return { classes, assignments, calls, stats: lastKeyUpgrade }
}

/** 数一下"还不是序列号"的键（= 需要升级的规模）；空键不算 */
function countNonSerialKeys(input: {
  classes: Klass[]
  assignments: Assignment[]
  calls: CallRecord[]
}): number {
  let n = 0
  const count = (list: string[] | undefined) => {
    for (const k of list ?? []) if (k !== '' && !isSerial(k)) n++
  }
  for (const a of input.assignments) {
    count(a.missingNos)
    count(a.lateNos)
    count(a.confirmedNos)
    count(a.focusNos)
    count(a.correctionNos)
    count(a.correctedNos)
    for (const k of Object.keys(a.wrong ?? {})) if (k !== '' && !isSerial(k)) n++
    for (const k of Object.keys(a.grades ?? {})) if (k !== '' && !isSerial(k)) n++
  }
  for (const c of input.calls) {
    count(c.studentNos)
    for (const k of Object.keys(c.states ?? {})) if (k !== '' && !isSerial(k)) n++
  }
  return n
}

/**
 * 当前 app 里的班级（恢复备份时用）。
 *
 * 两个用途：① 届的来路（同年级已有学生的序列号前缀）；
 * ② **编号基数** —— 恢复一份没有序列号的老备份时不能从 001 重来。
 * 云端那份权威来源是 `grades.cohort` / `grades.year`（见 `remote.ensureGradeLookup`），
 * 恢复备份时它不一定在手上 —— 那就退化成"同年级已有序列号"这条**事实**（仍然不是猜）。
 */
function currentStoreClasses(): Klass[] {
  try {
    const st = useStore.getState() as { classes?: Klass[] }
    return st.classes ?? []
  } catch {
    return []
  }
}

export function backupSummary(b: Backup): string {
  const students = b.classes.reduce((n, c) => n + (c.students?.length ?? 0), 0)
  return `${b.classes.length} 个班级 · ${students} 名学生 · ${b.assignments.length} 份作业档案`
}

/* ---------------- ① 导出 / 导入 ---------------- */

/* ============================================================
   🆕 备份完成通知（邮件）—— 2026-09-29 管理台第二期「三处接入」的第二处
   ------------------------------------------------------------
   🔴 那条链的规矩（用户口径，**既定**）：**备份 → 发信 → 发不出去就不许删**。
      落在这里的是中间那一环（发信），"不许删"落在调用处（`Settings.tsx`）：
      发信失败时**必须显式告诉老师"先别删刚才那份备份文件"**，而不是静默过去。

   🔴 正文**由服务端构造**（只有摘要 + 时间 + 一句纪律），
      所以这条邮件**结构上不可能**带学生姓名 / 学号 / 成绩（`_lib/mail.ts` 的三条硬要求）。
      ⚠️ 摘要也别塞学生姓名 —— 那是调用方的责任（这里只截断长度）。

   ⚠️ 它**不抛错**：备份本身已经成功了，通知失败不该让"备份成功"这件事看起来失败。
   ============================================================ */

export type NotifyBackupResult = { ok: true } | { ok: false; message: string }

export async function notifyBackupDone(
  summary: string,
  detail = '',
): Promise<NotifyBackupResult> {
  const r = await postApi('/api/mail', {
    action: 'backup',
    summary: summary.slice(0, 200),
    detail: detail.slice(0, 400),
  })
  if (!r.ok) return { ok: false, message: apiMessage(r, '备份通知没发出去') }
  return { ok: true }
}

export function downloadJson(data: unknown, filename: string) {  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text())
}

/* ---------------- ② 自动写进指定文件夹 ---------------- */

const HANDLE_KEY = 'shugao.backupDir'
const DB = 'shugao.backup'
const STORE = 'handles'

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('打不开句柄库'))
  })
}

/** 目录句柄可以直接存进 IndexedDB（这是它比路径字符串强的地方） */
async function saveHandle(h: DirHandle): Promise<void> {
  const db = await openDb()
  await new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, 'readwrite')
    t.objectStore(STORE).put(h, HANDLE_KEY)
    t.oncomplete = () => {
      db.close()
      res()
    }
    t.onerror = () => rej(t.error ?? new Error('存句柄失败'))
  })
}

export async function loadHandle(): Promise<DirHandle | null> {
  try {
    const db = await openDb()
    return await new Promise((res) => {
      const t = db.transaction(STORE, 'readonly')
      const r = t.objectStore(STORE).get(HANDLE_KEY)
      r.onsuccess = () => {
        db.close()
        res((r.result as DirHandle) ?? null)
      }
      r.onerror = () => {
        db.close()
        res(null)
      }
    })
  } catch {
    return null
  }
}

export function fsSupported(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/* ---- 备份失败必须让教师看见（自动备份是**后台**跑的，静默失败 = 等于没备份） ---- */

/** 上一条已经提示过的原因 / 时间 —— 同一条错不刷屏（自动备份每 5 分钟一次） */
let lastIssue = ''
let lastIssueAt = 0
const ISSUE_REPEAT_MS = 10 * 60_000

const reasonOf = (e: unknown): string =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e)

function reportBackupIssue(why: string) {
  console.warn('[backup]', why)
  const now = Date.now()
  if (why === lastIssue && now - lastIssueAt < ISSUE_REPEAT_MS) return
  lastIssue = why
  lastIssueAt = now
  /*
   * 走站内 toast：备份是在后台定时跑的，失败时教师多半没盯着控制台 ——
   * 以前三条失败路径（没选文件夹 / 权限失效 / 写文件抛异常）都是 `return false` 或 `return null`，
   * 界面上一个字都没有，教师会一直以为"自动备份开着呢"。
   */
  try {
    useToast.getState().push({ text: '自动备份没写成', tone: 'bad', desc: why })
  } catch {
    /* toast 起不来也不能反过来把备份流程搞崩 */
  }
}

/** 拿不到可写目录时，说清是哪一种情况 —— 提示要能落到一个具体动作上 */
async function whyNoFolder(): Promise<string> {
  const h = await loadHandle()
  if (!h) return '还没有选备份文件夹（在教室端点「设置文件夹」）'
  const q = await h.queryPermission?.({ mode: 'readwrite' })
  if (q === 'granted') return '文件夹句柄失效了，请重新选一次备份文件夹'
  return '浏览器重启后文件夹权限会失效 —— 点一下「点一下恢复」重新授权'
}

/** 让教师选一个文件夹（必须由点击触发） */
export async function pickFolder(): Promise<DirHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker: () => Promise<DirHandle> })
    .showDirectoryPicker
  if (!picker) return null
  try {
    const h = await picker()
    await saveHandle(h)
    lastIssue = ''
    return h
  } catch (e) {
    /*
     * 教师点「取消」也是走 reject（AbortError）—— 那不是故障，不提示。
     * 但**不能把异常原样抛出去**：调用方是 onClick 里的 async 函数，
     * 抛出去就成了一条没人接的 unhandled rejection，界面上什么都不显示。
     */
    const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : ''
    if (name !== 'AbortError') reportBackupIssue(`选文件夹失败：${reasonOf(e)}`)
    return null
  }
}

/**
 * 拿一个**当前可写**的目录句柄。
 * 浏览器重启后权限可能退回 'prompt'，此时必须由用户点击才能再要一次 ——
 * 返回 null 让界面提示教师点一下，不要静默失败。
 */
export async function writableFolder(): Promise<DirHandle | null> {
  const h = await loadHandle()
  if (!h) return null
  const q = await h.queryPermission?.({ mode: 'readwrite' })
  if (q === 'granted') return h
  if (q === 'prompt') {
    const r = await h.requestPermission?.({ mode: 'readwrite' })
    if (r === 'granted') return h
  }
  return null
}

/** 还有句柄但需要教师点一下授权 */
export async function folderNeedsGrant(): Promise<boolean> {
  const h = await loadHandle()
  if (!h) return false
  return (await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted'
}

/**
 * 写一份备份到授权文件夹。
 *
 * ⚠️ 失败**不能只是 `return false`**：调用方（教室端的自动备份）是 5 分钟一次的后台定时器，
 * 拿到 false 什么也不显示 —— 教师会一直以为备份在写，直到真需要恢复那天。
 * 这里负责把"为什么没写成"说出口（同一条错 10 分钟只提示一次）。
 */
export async function writeToFolder(name: string, data: unknown): Promise<boolean> {
  const dir = await writableFolder()
  if (!dir) {
    reportBackupIssue(await whyNoFolder())
    return false
  }
  try {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify(data))
    await w.close()
    lastIssue = ''
    return true
  } catch (e) {
    reportBackupIssue(`写「${name}」失败：${reasonOf(e)}`)
    return false
  }
}

/* ---------------- 恢复时把数据推回云端 ---------------- */

/** 一批 upsert 多少行（学生名单可能有几百条） */
const PUSH_BATCH = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 恢复不只是"写回本地" —— **云端才是主副本**，必须一起推上去。
 *
 * 之前只推了班级和学生：云端模式下恢复完界面看着一切正常，
 * 一刷新 `hydrate()` 从云端重建，作业 / 课表 / 呼叫全没了 —— 静默丢数据。
 *
 * 现在按外键依赖的顺序把每一类都推上去：
 *   teachers → classes → students → assignments → schedule_items → classrooms → calls
 * 并且四点必须做到，否则"已恢复"就是句谎话：
 *  ① **每一批都看 error**（以前只 await，Supabase 不抛异常，错就咽掉了）；
 *  ② 用 `.select('id')` 数回真正落库的行数 —— 被 RLS 挡下的更新是 **0 行且不报错**；
 *  ③ 备份里引用了不存在的班级 / 档案的行（本地删班留下的孤儿）**跳过并写进结果**，
 *     不让一条脏数据把整批 upsert 拖垮，也不假装推成功了；
 *  ④ **学科那两列（`subject_code` / `primary_subject_code`）认得出才带、认不出就不带**
 *     （列不存在也不带）—— 绝不写 `null`：这里写一次 null 就把云端历史数据的判据抹掉了，
 *     而且不可逆（见 §12.7）。
 */
export async function pushBackupToCloud(b: Backup, teacherId: string): Promise<string> {
  const sb = getSupabase()
  if (!sb) return '本地模式：只恢复到本机'
  if (!UUID_RE.test(teacherId)) {
    return '已恢复到本机，但还没登录 —— 刷新就会丢，请先登录再恢复一次'
  }

  const classIds = new Set(b.classes.map((c) => c.id))
  /*
   * 🔴 **未归属的档案必须留下**（P5：`assignments.class_id` 可空）。
   *    这一句原来只认"归属的班在备份里"，而未归属的档案 `classId` 是**空串**
   *    —— 空串永远不在 `classIds` 里，于是**回推云端时被静默丢掉**
   *    （`dropped` 那个计数只说"丢了几行"，老师看不出丢的是哪一类）。
   *    走班班那些行不用特殊处理：走班班也在 `b.classes` 里，`classIds.has()` 天然成立。
   *    ⚠️ 判据走 `isUnassigned()`（**唯一一处**的"空"口径），不在这里再写一遍 `!a.classId`。
   */
  const keepAssignments = (b.assignments ?? []).filter(
    (a) => isUnassigned(a.classId) || classIds.has(a.classId),
  )
  const assignmentIds = new Set(keepAssignments.map((a) => a.id))
  const keepRooms = (b.classrooms ?? []).filter((c) => classIds.has(c.classId))
  const keepCalls = (b.calls ?? []).filter(
    (c) => classIds.has(c.classId) && assignmentIds.has(c.assignmentId),
  )
  const dropped =
    (b.assignments?.length ?? 0) -
    keepAssignments.length +
    ((b.classrooms?.length ?? 0) - keepRooms.length) +
    ((b.calls?.length ?? 0) - keepCalls.length)

  const push = async (table: string, rows: object[]): Promise<{ why?: string }> => {
    for (let i = 0; i < rows.length; i += PUSH_BATCH) {
      const chunk = rows.slice(i, i + PUSH_BATCH)
      const { data, error } = await sb
        .from(table)
        .upsert(chunk as never, { onConflict: 'id' })
        .select('id')
      if (error) return { why: error.message }
      const got = data?.length ?? 0
      if (got < chunk.length) {
        return { why: `只落库 ${got}/${chunk.length} 行（账号不匹配或约束冲突）` }
      }
    }
    return {}
  }

  const errors: string[] = []
  const counts = { classes: 0, students: 0, assignments: 0, schedule: 0, classrooms: 0, calls: 0 }

  /*
   * 学科那两列在不在（与 `remote.saveAssignment` 同一套探测纪律）：
   * 列不存在时**一个字都不许往载荷里放** —— 带上不存在的列，整批 upsert 会被拒，
   * 而"恢复"这个动作被拒的后果比平时严重得多（教师以为恢复好了）。
   */
  const cols = await ensureSubjectCols()

  // teachers 那一行绑定 auth 用户；它缺失的话下面全都会卡在外键上
  if (b.teacher) {
    const row: Record<string, unknown> = {
      id: teacherId,
      name: b.teacher.name,
      subject: b.teacher.subject,
      school: b.teacher.school,
    }
    /*
     * 主学科：v2 备份里带着，v1 老备份靠显示名反查（`normalizeTeacher` 已经补过）。
     *
     * 🔴 **认不出就整列不出现**，而不是写 `null` —— 与 `saveTeacher` 故意不同：
     *    那边写 null 是"老师显式清空主学科"这一个动作本身；恢复备份时我们**不知道**，
     *    写 null 会把账号上已有的主学科抹掉（换设备/换账号恢复时尤其明显）。
     */
    const code = asSubjectCode(b.teacher.primarySubjectCode)
    if (cols.teachers && code) row.primary_subject_code = code
    const t = await push('teachers', [row])
    if (t.why) errors.push(`教师资料：${t.why}`)
  }

  const steps: Array<{
    label: string
    key: keyof typeof counts
    table: string
    rows: object[]
    /** 后面几张表都靠它的外键，没推上去就别接着推了 */
    fatal: boolean
  }> = [
    {
      label: '班级',
      key: 'classes',
      table: 'classes',
      /*
       * 走 `classRows`（与 `saveClass` 同一个落库载荷）：带上 `grade_id`，
       * 判据也是那三条（列不存在不带 / 认不出不带 / 同名多条不带）。
       * 只修 `saveClass` 的话，恢复出来的班照样是"年级主任管不动"的班。
       */
      rows: await classRows(b.classes, teacherId),
      fatal: true,
    },
    {
      label: '学生',
      key: 'students',
      table: 'students',
      rows: b.classes.flatMap((c) => c.students.map((s) => studentToRow(s, c.id))),
      fatal: true,
    },
    {
      label: '作业档案',
      key: 'assignments',
      table: 'assignments',
      /*
       * 走 `assignmentWriteRow`（与 `saveAssignment` 同一个落库载荷）：
       * 于是"回推云端"也守 `subject_code` 的两条纪律 —— 列不存在不带、认不出学科不带。
       * v1 老备份没有 code（按显示名也反查不出来时）就等于**不动**云端已有的值。
       */
      rows: await Promise.all(keepAssignments.map((a) => assignmentWriteRow(a, teacherId))),
      fatal: true,
    },
    {
      label: '课表',
      key: 'schedule',
      table: 'schedule_items',
      // 备份里引用了已经删掉的班 → 和云端 `on delete set null` 一样置空，而不是整条丢掉
      rows: (b.schedule ?? []).map((s) =>
        scheduleToRow(s.classId && !classIds.has(s.classId) ? { ...s, classId: undefined } : s, teacherId),
      ),
      fatal: false,
    },
    {
      label: '教室端设备',
      key: 'classrooms',
      table: 'classrooms',
      rows: keepRooms.map((c) => classroomToRow(c, teacherId)),
      fatal: false,
    },
    {
      label: '呼叫记录',
      key: 'calls',
      table: 'calls',
      rows: keepCalls.map((c) => callToRow(c, teacherId)),
      fatal: false,
    },
  ]

  for (const step of steps) {
    const r = await push(step.table, step.rows)
    if (r.why) {
      errors.push(`${step.label}：${r.why}`)
      if (step.fatal) break
      continue
    }
    counts[step.key] = step.rows.length
  }

  const parts = [
    `${counts.classes} 个班级`,
    `${counts.students} 名学生`,
    `${counts.assignments} 份作业档案`,
    counts.schedule ? `${counts.schedule} 条课表` : '',
    counts.classrooms ? `${counts.classrooms} 台教室端` : '',
    counts.calls ? `${counts.calls} 条呼叫` : '',
  ].filter(Boolean)
  const tail = dropped ? `（另有 ${dropped} 条挂在备份里没有的班级/档案上，已跳过）` : ''

  if (errors.length) {
    return `⚠️ 本地已恢复，但回推云端没完成（现在刷新就会丢）：${errors.join('；')}｜已推上：${parts.join(' / ')}${tail}`
  }
  return `已恢复到云端：${parts.join(' / ')}${tail}`
}
