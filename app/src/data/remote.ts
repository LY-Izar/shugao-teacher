import { getSupabase } from '../lib/supabase'
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

export async function loadSnapshot(): Promise<Snapshot | null> {
  const sb = getSupabase()
  if (!sb) return null

  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return null

  const [t, c, s, a, sch, room, calls] = await Promise.all([
    sb.from('teachers').select('*').eq('id', user.id).maybeSingle(),
    sb.from('classes').select('*').order('created_at', { ascending: true }),
    sb.from('students').select('*'),
    sb.from('assignments').select('*').order('assign_date', { ascending: false }),
    sb.from('schedule_items').select('*').order('weekday', { ascending: true }),
    sb.from('classrooms').select('*'),
    sb.from('calls').select('*').order('created_at', { ascending: false }).limit(200),
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

  const tRow = t.data as { name?: string; subject?: string; school?: string } | null

  return {
    userId: user.id,
    teacher: {
      id: user.id,
      name: tRow?.name ?? user.email?.split('@')[0] ?? '老师',
      subject: tRow?.subject ?? '物理',
      school: tRow?.school ?? '',
    },
    classes,
    assignments: ((a.data ?? []) as AssignmentRow[]).map(rowToAssignment),
    schedule: ((sch.data ?? []) as ScheduleRow[]).map(rowToSchedule),
    classrooms: ((room.data ?? []) as ClassroomRow[]).map(rowToClassroom),
    calls: ((calls.data ?? []) as CallRow[]).map(rowToCall),
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

export const saveTeacher = (t: Teacher) =>
  upsert('teachers', { id: t.id, name: t.name, subject: t.subject, school: t.school })

export const saveClass = (k: Klass, teacherId: string) => upsert('classes', classToRow(k, teacherId))
export const deleteClass = (id: string) => remove('classes', id)

export const saveStudent = (s: Student, classId: string) =>
  upsert('students', studentToRow(s, classId))
export const saveStudents = (classId: string, list: Student[]) =>
  list.length ? upsert('students', list.map((s) => studentToRow(s, classId))) : Promise.resolve()
export const deleteStudent = (id: string) => remove('students', id)

export const saveAssignment = (a: Assignment, teacherId: string) =>
  upsert('assignments', assignmentToRow(a, teacherId))
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
