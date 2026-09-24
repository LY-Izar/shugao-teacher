import { getSupabase } from '../lib/supabase'
import { asSubjectCode, subjectCodeOfName } from '../lib/subjects'
import type { Exam, ExamScore } from './examTypes'
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
  TeacherRole,
} from './types'

/* ============================================================
   本地模型 ←→ Supabase 表 的映射与读写
   ------------------------------------------------------------
   本地模型是 camelCase + 学生嵌在班级里；
   数据库是 snake_case + 学生独立成表。这里做双向转换。
   ============================================================ */

/* ---------------- 行类型 ---------------- */

type ClassRow = {
  id: string
  teacher_id: string
  name: string
  grade: string
  year: string
}
type StudentRow = {
  id: string
  class_id: string
  student_no: string
  name: string
  status: string
}
type AssignmentRow = {
  id: string
  class_id: string
  teacher_id: string
  title: string
  subject: string
  /**
   * 学科代码（schema.sql 第 12 段加的列）。
   * ⚠️ **可选**：线上库可能还没跑那一段，这时读不到、也不能写（见 ensureSubjectCols）。
   */
  subject_code?: string | null
  assign_date: string
  question_count: number
  status: string
  template_id: string | null
  collected: boolean
  missing_nos: string[]
  late_nos: string[]
  sub_questions: Record<string, number>
  wrong: Record<string, string[]>
  confirmed_nos: string[]
  question_meta: Record<string, QuestionMeta>
  stats_mode: string
  grades: Record<string, string>
  focus_nos: string[]
  correction_nos: string[]
  corrected_nos: string[]
  grade_seconds: number | null
  graded_at: string | null
  /** 由数据库默认值生成，只在读取时才有 */
  created_at?: string | null
}
type ScheduleRow = {
  id: string
  teacher_id: string
  weekday: number
  start_time: string
  end_time: string
  title: string
  class_id: string | null
  room: string | null
  kind: string
  notify: boolean
  scope: string
}
type ClassroomRow = {
  id: string
  teacher_id: string
  class_id: string
  name: string
  online: boolean
  last_seen_at: string
}
type CallRow = {
  id: string
  teacher_id: string
  assignment_id: string
  class_id: string
  student_nos: string[]
  text: string
  room: string
  sent_at: string[]
  states: Record<string, CallState>
  /** 由数据库默认值生成，只在读取时才有（轮询按它取时间窗） */
  created_at?: string | null
}

/* ---- 考试（schema.sql 第 15 段，见 功能设计与不变量.md §十四） ---- */

type ExamQuestionRow = {
  no?: number
  kind?: string
  fullScore?: number
  answer?: string
  points?: string[]
  stem?: string
}

type ExamRow = {
  id: string
  teacher_id: string
  title: string
  paper_key: string
  subject: string
  subject_code?: string | null
  scope: string
  grade: string
  source: string
  mode: string
  exam_date: string
  question_count: number
  questions: Record<string, ExamQuestionRow>
  class_ids: string[]
  absent_nos: string[]
  status: string
  graded_at?: string | null
  note: string
  created_at?: string | null
}

type ExamScoreRow = {
  id: string
  exam_id: string
  class_id: string
  student_no: string
  name: string
  scores: Record<string, number>
  answers: Record<string, string>
  graded: boolean
  absent: boolean
  total: number | string | null
  objective: number | string | null
  subjective: number | string | null
  class_rank: number | null
  grade_rank: number | null
  created_at?: string | null
}

/** Postgres 的 numeric 经 PostgREST 回来是**字符串**（避免精度丢失），要显式转 */
const nnum = (v: number | string | null | undefined): number | undefined => {
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/* ---------------- 兼容期：新列在不在？（多学科阶段 1） ----------------

   多学科那一段 schema 只做加法：给 assignments / teachers / class_subjects
   各加一个 subject_code 类的新列。**前端不能假设它已经跑过** ——
   线上库现在就没有这些列，而 PostgREST 遇到不存在的列会直接报错：

     · 读：`select('subject_code')` → 报错；但 `select('*')` 只是读不到那个键，**不报错**。
     · 写：upsert 的行里带上这个键 → **整条 upsert 被拒**。
       而本项目的纪律是「乐观更新 + 保存失败 = 刷新即丢」（见 功能设计与不变量.md §一），
       所以一旦在没跑 SQL 的库上带这一列去写，老师刚建的档案刷新就没了。

   手法与权限体系阶段 1 的「先并存、后收口」一致：
     · 读：一律带兜底（`subject_code` 读不到就按显示名 `subject` 反查）；
     · 写：先探测一次列在不在，不在就把这一列从行里摘掉；
     · SQL 真跑过之后，**前端一行都不用改**，新列自动开始写（刷新生效）。

   ⚠️ 探测结果按页面缓存一次（刷新即重探）。判据只看「列不存在」这一种错误，
      网络抖动/权限问题**一律当作有**，免得一次抖动就把新列永久写停了。 */

type SubjectCols = { assignments: boolean; teachers: boolean }

let colsProbe: Promise<SubjectCols> | null = null

async function probeSubjectCols(): Promise<SubjectCols> {
  const sb = getSupabase()
  if (!sb) return { assignments: false, teachers: false }
  const has = async (table: string, column: string): Promise<boolean> => {
    try {
      const { error } = await sb.from(table).select(column).limit(1)
      if (!error) return true
      const msg = String(error.message ?? '')
      const code = String((error as { code?: string }).code ?? '')
      // 只有「列不存在」才判定成还没跑 SQL
      return !(code === '42703' || /does not exist/i.test(msg))
    } catch {
      return true
    }
  }
  const [assignments, teachers] = await Promise.all([
    has('assignments', 'subject_code'),
    has('teachers', 'primary_subject_code'),
  ])
  return { assignments, teachers }
}

/** 探测一次（同一页面内只探一次），给写路径用 */
export function ensureSubjectCols(): Promise<SubjectCols> {
  if (!colsProbe) colsProbe = probeSubjectCols()
  return colsProbe
}

/* ---------------- 兼容期：考试那两张表在不在？（schema.sql 第 15 段） ----------------

   与上面的 `ensureSubjectCols()` 同一套纪律，但判据不同 —— 这次探的是**表**，不是列：
     · 这一整段是**新增功能**，线上库没跑第 15 段时 `exams` / `exam_scores` 根本不存在；
     · 读：`select('*')` 会报 42P01 / PGRST205；**表不在就当"还没有考试档案"**，
          绝不能让"考试"这一个功能把整个应用拖垮（快照那条路一个字都不动）；
     · 写：表不在就**不写**，并把原因交回给调用方去显示人话 ——
          "乐观更新 + 刷新即丢"在这里是最坏的结局（老师录了一节课的分，刷新全没了）。

   判据只有「表不存在」这一种：网络抖动、权限问题一律当作**在**
   （否则一次抖动就把写入永久停掉，比偶发失败严重得多）。

   ⚠️ 结果只有两种：'present' / 'missing'。
      "探测本身失败"（断网）**不缓存**，下次还会重探 —— 缓存住会把临时故障固化成永久状态。 */

export type ExamTablesState = 'present' | 'missing'

let examTablesProbe: Promise<ExamTablesState> | null = null

/** 表不存在的三种表述：PG 原生错误码 / PostgREST 的 schema cache 错误码 / 兜底文案 */
function isMissingTable(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  const msg = String(error.message ?? '')
  return (
    code === '42P01' || // undefined_table
    code === 'PGRST205' || // PostgREST: table not found in schema cache
    /does not exist/i.test(msg) ||
    /schema cache/i.test(msg)
  )
}

async function probeExamTables(): Promise<ExamTablesState> {
  const sb = getSupabase()
  if (!sb) return 'missing'
  const has = async (table: string): Promise<boolean | null> => {
    try {
      const { error } = await sb.from(table).select('id').limit(1)
      if (!error) return true
      if (isMissingTable(error)) return false
      return null // 认不出来 → "不知道"
    } catch {
      return null
    }
  }
  const [exams, scores] = await Promise.all([has('exams'), has('exam_scores')])
  if (exams === false || scores === false) return 'missing'
  if (exams === null || scores === null) {
    // 探测本身没结论：**不缓存**，让下一次重探（可能只是断网）
    examTablesProbe = null
    return 'missing'
  }
  return 'present'
}

/** 探测一次（同一页面内只探一次），给考试功能的读写路径用 */
export function ensureExamTables(): Promise<ExamTablesState> {
  if (!examTablesProbe) examTablesProbe = probeExamTables()
  return examTablesProbe
}

/** 第 15 段还没跑时，界面上要显示的那句话（**下一步动作写在错误信息里**） */
export const EXAM_MIGRATION_HINT =
  '线上数据库还没有考试相关的表：请到 Supabase → SQL Editor 跑 supabase/schema.sql 第 15 段'

/* ---------------- 考试：本地 → 行 ---------------- */

export const examToRow = (e: Exam, teacherId: string): ExamRow => ({
  id: e.id,
  teacher_id: teacherId,
  title: e.title,
  paper_key: e.paperKey,
  subject: e.subject,
  subject_code: asSubjectCode(e.subjectCode) ?? null,
  scope: e.scope,
  grade: e.grade,
  source: e.source,
  mode: e.mode,
  exam_date: e.examDate,
  question_count: e.questionCount,
  questions: (e.questions ?? {}) as unknown as Record<string, ExamQuestionRow>,
  class_ids: e.classIds ?? [],
  absent_nos: e.absentNos ?? [],
  status: e.status,
  graded_at: ts(e.gradedAt),
  note: e.note ?? '',
})

export const examScoreToRow = (s: ExamScore): ExamScoreRow => ({
  id: s.id,
  exam_id: s.examId,
  class_id: s.classId,
  student_no: s.studentNo,
  name: s.name,
  scores: s.scores ?? {},
  answers: s.answers ?? {},
  graded: s.graded,
  absent: s.absent,
  total: s.total ?? null,
  objective: s.objective ?? null,
  subjective: s.subjective ?? null,
  class_rank: s.classRank ?? null,
  grade_rank: s.gradeRank ?? null,
})

/* ---------------- 考试：行 → 本地 ---------------- */

const rowToExam = (r: ExamRow): Exam => ({
  id: r.id,
  title: r.title,
  paperKey: r.paper_key ?? '',
  subject: r.subject ?? '',
  subjectCode: asSubjectCode(r.subject_code) ?? subjectCodeOfName(r.subject) ?? '',
  scope: (r.scope as Exam['scope']) ?? 'class',
  grade: r.grade ?? '',
  source: (r.source as Exam['source']) ?? 'manual',
  mode: (r.mode as Exam['mode']) ?? 'scores',
  examDate: r.exam_date,
  questionCount: r.question_count,
  questions: (r.questions ?? {}) as Exam['questions'],
  classIds: r.class_ids ?? [],
  absentNos: r.absent_nos ?? [],
  status: (r.status as Exam['status']) ?? 'grading',
  createdBy: r.teacher_id,
  createdAt: ms(r.created_at) ?? Date.now(),
  gradedAt: ms(r.graded_at),
  note: r.note ?? '',
})

const rowToExamScore = (r: ExamScoreRow): ExamScore => ({
  id: r.id,
  examId: r.exam_id,
  classId: r.class_id,
  studentNo: r.student_no,
  name: r.name ?? '',
  scores: r.scores ?? {},
  answers: r.answers ?? {},
  graded: r.graded === true,
  absent: r.absent === true,
  total: nnum(r.total),
  objective: nnum(r.objective),
  subjective: nnum(r.subjective),
  classRank: r.class_rank ?? undefined,
  gradeRank: r.grade_rank ?? undefined,
  createdAt: ms(r.created_at) ?? Date.now(),
})

/* ---------------- 考试：读写 ----------------
 *
 * ⚠️ **这两张表不进 `loadSnapshot()`**（那组是"任一失败就整份快照作废"）：
 *    线上库还没跑第 15 段时，混进去会让**整个应用一起看不到数据**——
 *    比"考试功能暂时不可用"严重得多（同 §13.6 里 `loadMyRoles` 的理由）。
 *    所以考试有自己的加载入口，页面按需调。 */

export type ExamBundle = { exams: Exam[]; scores: ExamScore[] }

/**
 * 读全部可见的考试与成绩。
 *
 * 线上库没跑第 15 段时返回 `{ exams: [], scores: [] }`（**不抛错、不白屏**），
 * 由调用方用 `ensureExamTables()` 去区分"表不存在"和"真的还没有档案"。
 */
export async function loadExams(): Promise<ExamBundle> {
  const sb = getSupabase()
  if (!sb) return { exams: [], scores: [] }
  const state = await ensureExamTables()
  if (state === 'missing') return { exams: [], scores: [] }
  try {
    const [e, s] = await Promise.all([
      sb.from('exams').select('*').order('exam_date', { ascending: false }),
      sb.from('exam_scores').select('*'),
    ])
    if (e.error || s.error) {
      // 表在、但读失败（权限/网络）：如实报出来，列表退回空
      if (!isMissingTable(e.error) && !isMissingTable(s.error)) {
        fail('读取考试', e.error ?? s.error)
      }
      return { exams: [], scores: [] }
    }
    return {
      exams: ((e.data ?? []) as ExamRow[]).map(rowToExam),
      scores: ((s.data ?? []) as ExamScoreRow[]).map(rowToExamScore),
    }
  } catch (err) {
    fail('读取考试', err)
    return { exams: [], scores: [] }
  }
}

export type SaveExamResult = { ok: boolean; reason?: string }

/**
 * 写一份考试档案（含它的全部学生行）。
 *
 * 顺序：**先 exams 再 exam_scores**（外键方向）。
 * 两者都成功才算成功 —— 只写了档案没写分数，教师看到的是"改完了但分没了"。
 */
export async function saveExam(
  e: Exam,
  rows: ExamScore[],
  teacherId: string,
): Promise<SaveExamResult> {
  const sb = getSupabase()
  if (!sb) return { ok: true } // 本地模式：store 自己持久化
  const state = await ensureExamTables()
  if (state === 'missing') {
    // 不写、也不吞：把下一步动作交给调用方显示（**不能乐观更新后刷新即丢**）
    fail('保存考试', { message: EXAM_MIGRATION_HINT })
    return { ok: false, reason: EXAM_MIGRATION_HINT }
  }
  try {
    const { error } = await sb.from('exams').upsert(examToRow(e, teacherId) as never, { onConflict: 'id' })
    if (error) {
      fail('保存考试', error)
      return { ok: false, reason: String(error.message ?? '未知错误') }
    }
    if (rows.length) {
      const { error: e2 } = await sb
        .from('exam_scores')
        .upsert(rows.map(examScoreToRow) as never, { onConflict: 'id' })
      if (e2) {
        fail('保存考试成绩', e2)
        return { ok: false, reason: String(e2.message ?? '未知错误') }
      }
    }
    return { ok: true }
  } catch (err) {
    fail('保存考试', err)
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteExam(id: string): Promise<void> {
  const sb = getSupabase()
  if (!sb) return
  remove('exams', id)
}

/** 只删某些学生的成绩行（改名/转班后用不上了）—— 目前只有"删整份档案"用到 */
export async function deleteExamScores(ids: string[]): Promise<void> {
  const sb = getSupabase()
  if (!sb || !ids.length) return
  try {
    const { error } = await sb.from('exam_scores').delete().in('id', ids)
    if (error) fail('删除考试成绩', error)
  } catch (err) {
    fail('删除考试成绩', err)
  }
}

/* ---------------- 错误上报 ---------------- */

let onError: ((message: string, detail?: string) => void) | null = null
export function setSyncErrorHandler(fn: (message: string, detail?: string) => void) {
  onError = fn
}
function fail(where: string, e: unknown) {
  const detail = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)
  console.error(`[sync] ${where} 失败:`, detail)
  onError?.(where, detail)
}

/* ---------------- 时间转换 ---------------- */

const ts = (ms?: number | null) => (ms ? new Date(ms).toISOString() : null)
const ms = (iso?: string | null) => (iso ? new Date(iso).getTime() : undefined)
/** Postgres 的 time 会返回 HH:MM:SS，界面只用 HH:MM */
const hhmm = (t: string) => (t ?? '').slice(0, 5)

/* ---------------- 本地 → 行 ---------------- */

export const classToRow = (k: Klass, teacherId: string): ClassRow => ({
  id: k.id,
  teacher_id: teacherId,
  name: k.name,
  grade: k.grade,
  year: k.year,
})

export const studentToRow = (s: Student, classId: string): StudentRow => ({
  id: s.id,
  class_id: classId,
  student_no: s.studentNo,
  name: s.name,
  status: s.status,
})

/**
 * 本地 → 行。
 *
 * ⚠️ **故意不带 `subject_code`**：带不带取决于那一列在不在（见 ensureSubjectCols），
 *    而这是一个纯函数。真正的写入点在 `saveAssignment`，那里按探测结果补上。
 *    另一个好处是"备份回推云端"（backup.ts 也调这个函数）沿用同一套安全性：
 *    备份 v1 里没有 `subjectCode`，也就不会往可能不存在的列上写。
 *    （upsert 只更新载荷里出现过的列，所以老行的 subject_code 不会被抹掉。）
 */
export const assignmentToRow = (a: Assignment, teacherId: string): AssignmentRow => ({
  id: a.id,
  class_id: a.classId,
  teacher_id: teacherId,
  title: a.title,
  subject: a.subject,
  assign_date: a.assignDate,
  question_count: a.questionCount,
  status: a.status,
  template_id: a.templateId ?? null,
  collected: a.collected,
  missing_nos: a.missingNos ?? [],
  late_nos: a.lateNos ?? [],
  sub_questions: a.subQuestions ?? {},
  wrong: a.wrong ?? {},
  confirmed_nos: a.confirmedNos ?? [],
  question_meta: a.questionMeta ?? {},
  stats_mode: a.statsMode ?? 'normal',
  grades: a.grades ?? {},
  focus_nos: a.focusNos ?? [],
  correction_nos: a.correctionNos ?? [],
  corrected_nos: a.correctedNos ?? [],
  grade_seconds: a.gradeSeconds ?? null,
  graded_at: ts(a.gradedAt),
})

export const scheduleToRow = (s: ScheduleItem, teacherId: string): ScheduleRow => ({
  id: s.id,
  teacher_id: teacherId,
  weekday: s.weekday,
  start_time: s.start,
  end_time: s.end,
  title: s.title,
  class_id: s.classId ?? null,
  room: s.room ?? null,
  kind: s.kind,
  notify: s.notify,
  scope: s.scope ?? 'mine',
})

export const classroomToRow = (c: ClassroomClient, teacherId: string): ClassroomRow => ({
  id: c.id,
  teacher_id: teacherId,
  class_id: c.classId,
  name: c.name,
  online: c.online,
  last_seen_at: ts(c.lastSeenAt) ?? new Date().toISOString(),
})

export const callToRow = (c: CallRecord, teacherId: string): CallRow => ({
  id: c.id,
  teacher_id: teacherId,
  assignment_id: c.assignmentId,
  class_id: c.classId,
  student_nos: c.studentNos,
  text: c.text,
  room: c.room,
  sent_at: c.sentAt.map((t) => new Date(t).toISOString()),
  states: c.states,
})

/* ---------------- 行 → 本地 ---------------- */

const rowToStudent = (r: StudentRow): Student => ({
  id: r.id,
  studentNo: r.student_no,
  name: r.name,
  status: (r.status as StudentStatus) ?? 'active',
  createdAt: Date.now(),
})

const rowToAssignment = (r: AssignmentRow): Assignment => ({
  id: r.id,
  classId: r.class_id,
  title: r.title,
  subject: r.subject,
  /*
   * 兼容期读法：新列有值就用；没有（列还没建，或老行没回填）就按显示名反查字典。
   * 反查不出来就留 undefined —— 绝不猜，页面上退回显示 `subject` 原样。
   */
  subjectCode: asSubjectCode(r.subject_code) ?? subjectCodeOfName(r.subject),
  assignDate: r.assign_date,
  questionCount: r.question_count,
  status: r.status as AssignmentStatus,
  templateId: r.template_id ?? undefined,
  createdAt: ms(r.created_at) ?? Date.now(),
  collected: r.collected,
  missingNos: r.missing_nos ?? [],
  lateNos: r.late_nos ?? [],
  subQuestions: r.sub_questions ?? {},
  wrong: r.wrong ?? {},
  confirmedNos: r.confirmed_nos ?? [],
  questionMeta: r.question_meta ?? {},
  statsMode: (r.stats_mode as 'simple' | 'normal') ?? 'normal',
  grades: r.grades ?? {},
  focusNos: r.focus_nos ?? [],
  correctionNos: r.correction_nos ?? [],
  correctedNos: r.corrected_nos ?? [],
  gradeSeconds: r.grade_seconds ?? undefined,
  gradedAt: ms(r.graded_at),
})

const rowToSchedule = (r: ScheduleRow): ScheduleItem => ({
  id: r.id,
  weekday: r.weekday,
  start: hhmm(r.start_time),
  end: hhmm(r.end_time),
  title: r.title,
  classId: r.class_id ?? undefined,
  room: r.room ?? undefined,
  kind: (r.kind as ScheduleKind) ?? 'class',
  notify: r.notify,
  scope: (r.scope as 'mine' | 'class') ?? 'mine',
})

export const rowToClassroom = (r: ClassroomRow): ClassroomClient => ({
  id: r.id,
  classId: r.class_id,
  name: r.name,
  online: r.online,
  lastSeenAt: ms(r.last_seen_at) ?? Date.now(),
})

export const rowToCall = (r: CallRow): CallRecord => ({
  id: r.id,
  assignmentId: r.assignment_id,
  classId: r.class_id,
  studentNos: r.student_nos ?? [],
  text: r.text,
  room: r.room,
  sentAt: (r.sent_at ?? []).map((t) => new Date(t).getTime()),
  states: r.states ?? {},
})

/* ---------------- 读 ---------------- */

export type Snapshot = {
  teacher: Teacher | null
  classes: Klass[]
  assignments: Assignment[]
  schedule: ScheduleItem[]
  classrooms: ClassroomClient[]
  calls: CallRecord[]
  /**
   * 我的身份（`teacher_roles` 里属于我的那些行）。
   * 表还没建 / 没登录 / 网络出错时是**空数组**（＝"身份未知"）——
   * 界面按"未指派"显示，判据仍在服务端（schema.sql §13.2 的两个函数）。
   */
  roles: TeacherRole[]
  userId: string
}

/**
 * 只重读教室端设备状态。
 * 发呼叫前要确认"对面真的在线" —— 页面上那份可能是几分钟前的快照，
 * 光看它会以为教室端还在线，结果学生什么都没听到。
 */
export async function loadClassrooms(): Promise<ClassroomClient[] | null> {
  const sb = getSupabase()
  if (!sb) return null
  const { data, error } = await sb.from('classrooms').select('*')
  if (error) return null
  return (data ?? []).map(rowToClassroom)
}

/** 轮询一次最多看多少条：够覆盖"最近这一会儿"的呼叫，又不至于每次拉回整个学期 */
const POLL_LIMIT = 30

/**
 * 读某个班最近的呼叫 —— 给教室端做**轮询兜底**。
 *
 * 为什么需要：教室端收呼叫走的是 Realtime 的 websocket，而"在线"是靠 REST 心跳。
 * 这两条连接是独立的 —— **websocket 悄悄断掉时心跳照常**，
 * 于是教师端看到"在线"、呼叫也发出去了，教室端却一声不响。
 * 教室端要开一整天，这种事迟早会发生，所以不能只靠推送。
 *
 * ⚠️ 窗口按「**新建时间 or 最后一次播报时间**」取，不能只按 `created_at`：
 * 「再播一遍」只是往 `sent_at` 里追加一个时间戳（行还是老行），
 * 只按 created_at 过滤的话，超过 15 分钟的老呼叫重播时轮询永远看不到它。
 * 表里没有 updated_at（也不为此改 schema），所以先把最近 N 条拉回来再在本地筛。
 */
export async function loadRecentCalls(classId: string, sinceMs: number): Promise<CallRecord[]> {
  const sb = getSupabase()
  if (!sb) return []
  const { data, error } = await sb
    .from('calls')
    .select('*')
    .eq('class_id', classId)
    .order('created_at', { ascending: false })
    .limit(POLL_LIMIT)
  if (error) return []
  return ((data ?? []) as CallRow[])
    .filter((r) => {
      const created = ms(r.created_at) ?? 0
      const lastSent = Math.max(
        0,
        ...(r.sent_at ?? []).map((t) => new Date(t).getTime()).filter((n) => Number.isFinite(n)),
      )
      return created >= sinceMs || lastSent >= sinceMs
    })
    .map(rowToCall)
}

/**
 * 这个登录账号是不是「教室端账号」？是的话连它管哪个班一起返回。
 *
 * 为什么不能靠别的办法判断身份：
 * `handle_new_user` 触发器会给**每一个** auth 用户建一行 `teachers` ——
 * 教室端账号也有。所以"有没有 teachers 行"区分不了教师和教室端。
 * 唯一的判据是 `classroom_accounts` 里有没有 id = 自己 uid 的那一行。
 *
 * RLS 上教室端读得到自己那一行：`classroom_accounts_read` 按 visible_class_ids() 收口，
 * 而 visible_class_ids() 里本来就有 classroom_accounts 这一支。
 *
 * 任何失败（表还没建、没登录、网络）都返回 null —— 那就当教师处理，
 * 和现在的行为一致，不会因为权限体系还没上线就把人挡在门外。
 */
export async function loadClassroomAccount(): Promise<{
  classId: string
  disabled: boolean
} | null> {
  const sb = getSupabase()
  if (!sb) return null
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return null
  const { data, error } = await sb
    .from('classroom_accounts')
    .select('class_id, disabled')
    .eq('id', user.id)
    .maybeSingle()
  if (error || !data) return null
  const row = data as { class_id?: string; disabled?: boolean }
  if (!row.class_id) return null
  return { classId: row.class_id, disabled: row.disabled === true }
}

/**
 * 读「我的身份」：`teacher_roles` 里属于我的那些行（多身份是常态，所以是数组）。
 *
 * 🔴 **绝不能把它混进 `loadSnapshot` 那一组 `Promise.all` 后再统一判错**：
 *    线上库可能还没跑 `schema.sql` 第 10 段（`teacher_roles` 表还不存在），
 *    那时这条查询会报错 —— 一旦它进了"任一失败就整份快照作废"的那一组，
 *    **整个应用会一起看不到数据**（比"身份未知"严重得多）。
 *    所以它自带兜底：任何失败都返回 `[]`，界面上就是"没指派身份"，
 *    而真正的判据在服务端（`schema.sql` §13.2），前端读不到身份不影响任何权限。
 */
export async function loadMyRoles(userId: string): Promise<TeacherRole[]> {
  const sb = getSupabase()
  if (!sb) return []
  try {
    const { data, error } = await sb
      .from('teacher_roles')
      .select('role, scope_type, scope_id')
      .eq('teacher_id', userId)
    if (error) return []
    return ((data ?? []) as { role?: string; scope_type?: string; scope_id?: string }[])
      .filter((r) => typeof r.role === 'string' && r.role !== '')
      .map((r) => ({
        role: r.role as TeacherRole['role'],
        scopeType: (r.scope_type ?? undefined) as TeacherRole['scopeType'],
        scopeId: r.scope_id ?? undefined,
      }))
  } catch {
    return []
  }
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  const sb = getSupabase()
  if (!sb) return null

  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return null

  // 顺便把「新列在不在」探一次（与下面的读并行，省得第一次保存时才多一个来回）
  void ensureSubjectCols()

  const [t, c, s, a, sch, room, calls, roles] = await Promise.all([
    sb.from('teachers').select('*').eq('id', user.id).maybeSingle(),
    sb.from('classes').select('*').order('created_at', { ascending: true }),
    sb.from('students').select('*'),
    sb.from('assignments').select('*').order('assign_date', { ascending: false }),
    sb.from('schedule_items').select('*').order('weekday', { ascending: true }),
    sb.from('classrooms').select('*'),
    sb.from('calls').select('*').order('created_at', { ascending: false }).limit(200),
    // ⚠️ 这一条**自己吞错**（见 loadMyRoles），所以不进下面那组"任一失败就作废"的判错
    loadMyRoles(user.id),
  ])

  const firstErr = [t, c, s, a, sch, room, calls].find((r) => r.error)?.error
  if (firstErr) {
    fail('读取数据', firstErr)
    return null
  }

  const studentsByClass = new Map<string, Student[]>()
  for (const row of (s.data ?? []) as StudentRow[]) {
    const list = studentsByClass.get(row.class_id) ?? []
    list.push(rowToStudent(row))
    studentsByClass.set(row.class_id, list)
  }

  const classes: Klass[] = ((c.data ?? []) as ClassRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    grade: row.grade,
    year: row.year,
    createdAt: Date.now(),
    students: (studentsByClass.get(row.id) ?? []).sort(
      (x, y) => Number(x.studentNo) - Number(y.studentNo),
    ),
  }))

  const tRow = t.data as {
    name?: string
    subject?: string
    primary_subject_code?: string | null
    school?: string
  } | null

  return {
    userId: user.id,
    teacher: {
      id: user.id,
      name: tRow?.name ?? user.email?.split('@')[0] ?? '老师',
      /*
       * 显示标签：**不再兜底成「物理」**。空着就让读的人用
       * `teacherSubjectLabel()` 去取主学科的名字 —— 一个值只能有一个来源。
       */
      subject: tRow?.subject ?? '',
      // 新列没有就是 undefined（兼容期），读的人走 teacherPrimarySubjectCode()
      primarySubjectCode: asSubjectCode(tRow?.primary_subject_code),
      school: tRow?.school ?? '',
    },
    classes,
    assignments: ((a.data ?? []) as AssignmentRow[]).map(rowToAssignment),
    schedule: ((sch.data ?? []) as ScheduleRow[]).map(rowToSchedule),
    classrooms: ((room.data ?? []) as ClassroomRow[]).map(rowToClassroom),
    calls: ((calls.data ?? []) as CallRow[]).map(rowToCall),
    roles,
  }
}

/* ---------------- 写（乐观更新后后台落库，失败只提示不阻塞） ---------------- */

async function upsert(table: string, rows: object | object[]) {
  const sb = getSupabase()
  if (!sb) return
  try {
    const { error } = await sb.from(table).upsert(rows as never, { onConflict: 'id' })
    if (error) fail(`${table} 保存`, error)
  } catch (e) {
    fail(`${table} 保存`, e)
  }
}

async function remove(table: string, id: string) {
  const sb = getSupabase()
  if (!sb) return
  try {
    const { error } = await sb.from(table).delete().eq('id', id)
    if (error) fail(`${table} 删除`, error)
  } catch (e) {
    fail(`${table} 删除`, e)
  }
}

/**
 * 写教师那一行。
 *
 * `primary_subject_code` 只在**列真的存在**时才写（见 ensureSubjectCols）：
 * 线上库还没跑多学科那一段时，带上它会让整条 upsert 被拒 —— 而 teachers
 * 是外键的根，那条失败会连累后面所有表。
 */
export const saveTeacher = async (t: Teacher) => {
  const cols = await ensureSubjectCols()
  const row: Record<string, unknown> = {
    id: t.id,
    name: t.name,
    subject: t.subject,
    school: t.school,
  }
  if (cols.teachers) row.primary_subject_code = asSubjectCode(t.primarySubjectCode) ?? null
  return upsert('teachers', row)
}

export const saveClass = (k: Klass, teacherId: string) => upsert('classes', classToRow(k, teacherId))
export const deleteClass = (id: string) => remove('classes', id)

export const saveStudent = (s: Student, classId: string) =>
  upsert('students', studentToRow(s, classId))
export const saveStudents = (classId: string, list: Student[]) =>
  list.length ? upsert('students', list.map((s) => studentToRow(s, classId))) : Promise.resolve()
export const deleteStudent = (id: string) => remove('students', id)

/**
 * 写作业档案。
 *
 * 🔴 `subject_code` 的**唯一写入点**就是这里（`store.addAssignment` /
 * `store.updateAssignment` 是上游唯一入口，页面里不许写这两个字段）。
 * 列不存在时把这一列摘掉，而不是让整条 upsert 被拒 —— 这是"SQL 还没跑时前端不崩"的关键。
 */
export const saveAssignment = async (a: Assignment, teacherId: string) => {
  const cols = await ensureSubjectCols()
  const row: Record<string, unknown> = { ...assignmentToRow(a, teacherId) }
  if (cols.assignments) row.subject_code = asSubjectCode(a.subjectCode) ?? null
  return upsert('assignments', row)
}
export const deleteAssignment = (id: string) => remove('assignments', id)

export const saveSchedule = (s: ScheduleItem, teacherId: string) =>
  upsert('schedule_items', scheduleToRow(s, teacherId))
export const saveSchedules = (list: ScheduleItem[], teacherId: string) =>
  list.length ? upsert('schedule_items', list.map((s) => scheduleToRow(s, teacherId))) : Promise.resolve()
export const deleteSchedule = (id: string) => remove('schedule_items', id)

export const saveClassroom = (c: ClassroomClient, teacherId: string) =>
  upsert('classrooms', classroomToRow(c, teacherId))

export const saveCall = (c: CallRecord, teacherId: string) => upsert('calls', callToRow(c, teacherId))

/** 清空该教师的全部业务数据。teachers 那一行保留（它绑定 auth 用户，删了不会再自动生成）。 */
export async function purgeAll(teacherId: string) {
  const sb = getSupabase()
  if (!sb) return
  try {
    // classes 上有 on delete cascade，会连带清掉 students / assignments / classrooms
    for (const table of ['classes', 'schedule_items', 'calls'] as const) {
      const { error } = await sb.from(table).delete().eq('teacher_id', teacherId)
      if (error) {
        fail(`${table} 清空`, error)
        return
      }
    }
  } catch (e) {
    fail('清空数据', e)
  }
}
