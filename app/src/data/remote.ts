import { getSupabase, isRemote } from '../lib/supabase'
import { apiMessage, postApi } from '../lib/api'
import { asSubjectCode, subjectCodeOfName } from '../lib/subjects'
import { compareRoster } from '../lib/roster'
import { classKindOf } from '../lib/pick'
import { normalizeStudentStatus } from './types'
import { isUnassigned } from '../lib/assignments'
import {
  currentTermId,
  sortTerms,
  termOfDate,
  type AcademicYearDraft,
  type Term,
} from '../lib/terms'
import type { Exam, ExamScore } from './examTypes'
/* ⚠️ 只 import 类型：两张档案表的前端形状定义在 lib 里（判据在数据库），这里只做行映射 */
import type { StudentProfile } from '../lib/studentProfile'
import type { TeacherProfile } from '../lib/teacherProfile'
import type {
  Assignment,
  AssignmentStatus,
  CallRecord,
  CallState,
  ClassType,
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
  /**
   * 年级外键（`schema.sql` 第 10 段加的列）。
   * ⚠️ **可选**：老库没有这一列，或者"班名里的年级"在 `grades` 表里认不出来时，
   * 这一列**根本不出现**（不是写 null）—— 见 `ensureGradeLookup`。
   */
  grade_id?: string | null
  /**
   * 班级种类（`schema.sql` §27.2 加的列）：`admin` 行政班 / `stream` 走班班。
   * ⚠️ **可选**：老库没有它 —— 读不到就等于 `'admin'`（读的人走 `classKindOf()`）。
   */
  kind?: string | null
  /** 班型（`schema.sql` §27.2）：`''` / `undivided` / `arts` / `science`。读不到等于 `''` */
  class_type?: string | null
  /** 走班班的组合标识；行政班恒为 `''` */
  stream_key?: string | null
}
type StudentRow = {
  id: string
  class_id: string
  student_no: string
  name: string
  status: string
  /**
   * 序列号（`schema.sql` §20 加的列）：`入校年份 4 位 + 该届内 3 位`。
   * ⚠️ **可选**：线上库可能还没跑 §20 —— 这时读不到、也不能写（见 `ensureSerialCols`）。
   * 读不到 = 那一行还没生成序列号 → 档案键退回班内学号（老行为，见 `lib/keys.ts`）。
   */
  serial?: string | null
  /**
   * 迁移那一刻的班内学号存档（`schema.sql` §20 加的列）。
   * ⚠️ **永远不写**（数据库触发器会拒），只在读取时带着；用途只有一个：让键迁移幂等。
   */
  legacy_student_no?: string | null
}
type AssignmentRow = {
  id: string
  /**
   * 归属的班。⚠️ **可为空**（`schema.sql` §31.2，P5）：
   *    · 有值 = 行政班 or 走班班的 id（同一张 `classes`，按 `kind` 区分）；
   *    · `null` = **未归属**（前端一律走 `lib/assignments.ts` 的 `isUnassigned()`）。
   * ⚠️ 老库（还没跑 §31）上它仍是 `not null` —— 所以**写空一定是 `null`**，
   *    绝不可能写成空串（空串过不了 `uuid` 的类型转换，整条 upsert 会被拒）。
   */
  class_id: string | null
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
  /** 学期归属（`schema.sql` §28）：见 `ExamRow.term_id` 的说明（读不到 = 不知道） */
  term_id?: string | null
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
  /**
   * 🔴 **可空**（✅ Q32 = C，`schema.sql` §33.1 把 `calls_assignment_id_not_null` 去掉了）：
   *    · 有值 = **作业呼叫**（挂在某份作业档案下，科任老师就能发）；
   *    · `null` = **事务性呼叫**（班主任 / 教导处从班级管理直接叫人，不挂作业）。
   * ⚠️ 读回来一律收敛成 `''`（前端只有"没有"这一种写法，见 `rowToCall`）。
   */
  assignment_id: string | null
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
  /**
   * 学期归属（`schema.sql` §28，P3）。⚠️ **可选**：线上库还没跑 §28 时读不到这一列，
   * 读到 `undefined` = "不知道"（列表**照样显示**，见 `lib/terms.ts`）。
   */
  term_id?: string | null
  /** 这一场考试属于哪个届（`grades.id`）。同上：读不到 = 不知道 */
  grade_id?: string | null
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
  if (!colsProbe) {
    const p = probeSubjectCols()
    colsProbe = watchProbe('subjectCols', p, (v) => (v.assignments && v.teachers ? 'present' : 'missing'))
  }
  return colsProbe
}

/* ---------------- 兼容期：`classes` 的三列在不在？（schema.sql §27.2，P6） ----------------

   与 `ensureSubjectCols()` **同一套纪律**（判据也同一句：只认 `42703` = 列不存在）：
     · 读：`select('*')` 读不到就是 `undefined` → 读的人走 `classKindOf()` / `classTypeOf()`；
     · 写：列不在就**不把这三列放进载荷**（带上会让整条 upsert 被拒 = 刷新即丢）；
     · SQL 跑过之后前端一行都不用改，新列自动开始写。

   ⚠️ 为什么不塞进 `ensureSubjectCols()`：那一个探的是 `assignments` / `teachers`，
      混进来会让"学科列在不在"与"班级列在不在"变成同一个结论 ——
      两段 SQL 是可以分开跑的（用户常常只跑其中一段）。 */

type ClassCols = { kind: boolean }

let classColsProbe: Promise<ClassCols> | null = null

/**
 * 探针 —— **`select('*')`，不是 `select('kind')`**。
 *
 * 🔴 探针不许假设任何列存在（`nav-checks.mjs` 的 D10 会静态抓 `select('具体列名')`）：
 *    这里要问的本来就是"这一列在不在"，拿它自己去问，在**没有这一列的库上**会连
 *    "表在不在"都判不出来。所以先 `select('*')` 把整行拿回来，再在 JS 里看键在不在。
 */
async function probeClassCols(): Promise<ClassCols> {
  const sb = getSupabase()
  if (!sb) return { kind: false }
  try {
    const { data, error } = await sb.from('classes').select('*').limit(1)
    if (error) {
      const msg = String(error.message ?? '')
      const code = String((error as { code?: string }).code ?? '')
      /* 表/列不存在 = 还没跑那一段 SQL；别的错误（网络、权限）一律当作"有" */
      if (code === '42P01' || code === '42703' || /does not exist/i.test(msg)) return { kind: false }
      return { kind: true }
    }
    const row = (data ?? [])[0] as Record<string, unknown> | undefined
    /*
     * ⚠️ 一行都没有的库（全新的空库）读不出键 —— 但那种库上跑 `schema.sql` 是从头跑的，
     *    所以"空表"按 `true` 处理：不带这三列反而会让新班的班型存不进去。
     *    （判据是"列不存在"，不是"这一行有没有值"。）
     */
    if (!row) return { kind: true }
    return { kind: Object.prototype.hasOwnProperty.call(row, 'kind') }
  } catch {
    return { kind: true }
  }
}

/** 探测一次（同一页面内只探一次），给写班级的路径用 */
export function ensureClassCols(): Promise<ClassCols> {
  if (!classColsProbe) {
    const p = probeClassCols()
    classColsProbe = watchProbe('classCols', p, (v) => (v.kind ? 'present' : 'missing'))
  }
  return classColsProbe
}

/* ---------------- 兼容期：学年 / 学期（schema.sql §28，P3） ----------------

   与 `ensureClassCols()` **同一套纪律**（判据只认「列/表不在」；网络与权限一律当作"有"）：
     · 读：`select('*')` 读到 `term_id` 就是有；读不到 → `undefined` = **不知道**
       （列表照常显示，见 `lib/terms.ts` 文件头 ②）；
     · 写：`term_id` 只在**列真的在、而且算得出学期**时才放进载荷 ——
       带上一个不存在的列会让整条 upsert 被 PostgREST 拒（"保存失败 = 刷新即丢"）。

   ⚠️ 为什么单独一个探测、不塞进 `ensureGradeLookup()`（那个也读 `grades`）：
      它们探的是**不同的东西**（那边问 `classes.grade_id` 能不能写，这边问 §28 跑没跑）。
      混成一个结论 = 两段 SQL 只能一起跑，而用户常常只跑其中一段。 */

type TermCols = { ok: boolean }

let termColsProbe: Promise<TermCols> | null = null

/**
 * 探针 —— **`select('*')`，不是 `select('term_id')`**（`nav-checks` 的 D10 会静态抓后者）。
 * 要问的本来就是"这一列在不在"，拿它自己去问，在没有这一列的库上连"表在不在"都判不出来。
 */
async function probeTermCols(): Promise<TermCols> {
  const sb = getSupabase()
  if (!sb) return { ok: false }
  try {
    const { data, error } = await sb.from('assignments').select('*').limit(1)
    if (error) {
      const msg = String(error.message ?? '')
      const code = String((error as { code?: string }).code ?? '')
      if (code === '42P01' || code === '42703' || /does not exist/i.test(msg)) return { ok: false }
      return { ok: true }
    }
    const row = (data ?? [])[0] as Record<string, unknown> | undefined
    // 空表读不出键 —— 全新空库上 §28 与建表是一起跑的，按"有"处理（同 probeClassCols）
    if (!row) return { ok: true }
    return { ok: Object.prototype.hasOwnProperty.call(row, 'term_id') }
  } catch {
    return { ok: true }
  }
}

/** 探测一次（同一页面内只探一次）：§28 的 `assignments.term_id` 在不在 */
export function ensureTermCols(): Promise<TermCols> {
  if (!termColsProbe) {
    const p = probeTermCols()
    termColsProbe = watchProbe('termCols', p, (v) => (v.ok ? 'present' : 'missing'))
  }
  return termColsProbe
}

/** 学年 + 学期（**这一份缓存是"当前学期"的唯一来源**，不是本地数据模型的一部分） */
export type AcademicTerms = { terms: Term[]; current: string | null }

let termsCache: AcademicTerms | null = null

/** 读学年与学期（表不在 → 空；**不抛错、不白屏**） */
export async function loadTerms(force = false): Promise<AcademicTerms> {
  if (termsCache && !force) return termsCache
  const sb = getSupabase()
  const empty: AcademicTerms = { terms: [], current: null }
  if (!sb) {
    termsCache = empty
    return empty
  }
  const cols = await ensureTermCols()
  if (!cols.ok) {
    termsCache = empty
    return empty
  }
  try {
    const [y, t] = await Promise.all([
      sb.from('academic_years').select('*'),
      sb.from('terms').select('*'),
    ])
    if (y.error || t.error) {
      const err = y.error ?? t.error
      if (!isMissingTable(err)) fail('读取学年与学期', err)
      termsCache = empty
      return empty
    }
    const years = new Map<string, Record<string, unknown>>()
    for (const r of (y.data ?? []) as Record<string, unknown>[]) years.set(String(r.id), r)
    const list: Term[] = []
    for (const r of (t.data ?? []) as Record<string, unknown>[]) {
      const yr = years.get(String(r.academic_year_id))
      list.push({
        id: String(r.id),
        yearName: String(yr?.name ?? ''),
        yearStart: String(yr?.start_date ?? ''),
        yearEnd: String(yr?.end_date ?? ''),
        half: Number(r.half) === 2 ? 2 : 1,
        startDate: String(r.start_date ?? ''),
        endDate: String(r.end_date ?? ''),
      })
    }
    const terms = sortTerms(list.filter((x) => x.id && x.startDate && x.endDate))
    termsCache = { terms, current: currentTermId(terms) }
    return termsCache
  } catch (e) {
    fail('读取学年与学期', e)
    termsCache = empty
    return empty
  }
}

/** 清掉学期缓存（教导处刚改完日期 → 下一次读要拿新的） */
export function clearTermsCache() {
  termsCache = null
}

/**
 * 某一个日期属于哪个学期 —— **写路径唯一一处算学期的地方**。
 * 算不出来（列不在 / 学期表没有这一段 / 表读不到）返回 `null` → 调用方**不带这一列**。
 */
export async function termIdForDate(date: string): Promise<string | null> {
  const cols = await ensureTermCols()
  if (!cols.ok) return null
  const { terms } = await loadTerms()
  return termOfDate(terms, date)
}

/**
 * 写一个学年 + 上下半期（**一个 RPC = 一个事务**，服务端 `write_academic_year()`）。
 *
 * 判据不在这一层：服务端拿调用者 JWT 问 `can_manage_terms()`（= 教导处 / 最高管理员）。
 * 这里只把 JWT 递上去、把人话带回来（与 `lib/gradeSetup.ts` 同一条纪律）。
 */
export async function saveAcademicYear(d: AcademicYearDraft): Promise<{ ok: boolean; message: string }> {
  const r = await postApi('/api/grade-setup', { action: 'academicYearWrite', ...d })
  if (!r.ok) return { ok: false, message: apiMessage(r, '保存学年与学期失败') }
  clearTermsCache()
  return { ok: true, message: '已保存' }
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

/**
 * 上一次探测**到底问出了什么**（与 `examTablesProbe` 的返回值区分开，见下面 `getExamTablesProbeStatus`）。
 * 取值只有三种：还没问完 / 真的不在 / 没问出来。
 */
let lastExamTablesProbe: ExamProbeStatus = 'pending'

/**
 * 表不存在的判据 —— **只认"表/relation 不在"本身**：
 *  · `42P01`（PG 原生 `undefined_table`，文案 `relation "public.x" does not exist`）；
 *  · `PGRST205`（PostgREST 在自己的 schema cache 里找不到这张表）；
 *  · 文案里**限定过**的 `Could not find the table` / `relation … does not exist`。
 *
 * 🔴 **不许**写成一条泛化的 `/does not exist/i`，也**不许**把 `42703` / `PGRST204`
 *    算进"表不在"：「列不在」是**另一条判据**（`isMissingColumn`，本文件下面那个），
 *    而 `column "x" of relation "y" does not exist` 这种 PG 原生写法在**文案**上
 *    与 `relation … does not exist` 撞车 —— 所以这里**先**用那条判据把「列不在」摘掉。
 *    判错的代价：把"这一次缺了一列"说成"库还没跑 schema.sql"（假警报 + 指错动作），
 *    或者把写路径整条停掉。这正是超管面板 §20.7 那次误报的形状。
 *    口径与 `lib/adminChart.ts` 的 `MISSING_TABLE_RE` / `lib/notices.ts` 的同名常量一致。
 */
function isMissingTable(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  // 🔴 「列不在」先摘出去（判据分流，见上面那段）
  if (isMissingColumn(error)) return false
  const code = String(error.code ?? '')
  const msg = String(error.message ?? '')
  return (
    code === '42P01' || // undefined_table
    code === 'PGRST205' || // PostgREST: table not found in schema cache
    /Could not find the table|relation .+ does not exist/i.test(msg)
  )
}

async function probeExamTables(): Promise<ExamTablesState> {
  const sb = getSupabase()
  if (!sb) {
    examTablesProbeSettled = true
    lastExamTablesProbe = 'indeterminate'
    return 'missing'
  }
  const has = async (table: string): Promise<boolean | null> => {
    try {
      /*
       * 🔴 `select('*')`，**不是 `select('id')`** —— 表存在性只跟"这张表在不在"有关，
       *    探针**不许假设任何一列存在**（`select('id')` 偷偷假设了"每张表都有 id"，
       *    而 `subjects` 就没有；本仓库已经因此误报过两次，见 `notices.ts` 与 §20.7）。
       */
      const { error } = await sb.from(table).select('*').limit(1)
      if (!error) return true
      if (isMissingTable(error)) return false
      return null // 认不出来 → "不知道"（`42703`「列不在」也走这一支，绝不判"表不在"）
    } catch {
      return null
    }
  }
  const [exams, scores] = await Promise.all([has('exams'), has('exam_scores')])
  examTablesProbeSettled = true
  /*
   * ⚠️ 这三支的**返回值一个字都没改**（`'present' | 'missing'` 是对外契约，
   *    考试功能的读写路径按它判）。下面那三行只是把"这次到底问出了什么"
   *    另外记一份，给面板区分「表真的不在」与「我没问出来」——
   *    这两件事在返回值里长得一模一样，而它们的处置完全不同。
   */
  if (exams === false || scores === false) {
    lastExamTablesProbe = 'missing'
    return 'missing'
  }
  if (exams === null || scores === null) {
    // 探测本身没结论：**不缓存**，让下一次重探（可能只是断网）
    examTablesProbe = null
    examTablesProbeSettled = false
    lastExamTablesProbe = 'indeterminate'
    return 'missing'
  }
  lastExamTablesProbe = 'present'
  return 'present'
}

/** 探测一次（同一页面内只探一次），给考试功能的读写路径用 */
export function ensureExamTables(): Promise<ExamTablesState> {
  if (!examTablesProbe) {
    // 与上面三个同一件事：先挂旁听，再返回原 Promise（不改变任何调用方的时序）
    const p = probeExamTables()
    examTablesProbe = watchProbe('examTables', p)
  }
  return examTablesProbe
}

/**
 * `examTablesProbe` 的**唯一外部清理入口**。
 *
 * 这个函数是补上一个真实的缺陷（`功能设计与不变量.md` §十 留档）：
 * `store.refreshExamTables()` 的注释自称"先把缓存清掉再重探"，
 * 但它只 `set({ examTables: 'unknown' })` 然后调 `hydrateExams()`
 * → `ensureExamTables()` → **命中同一个已经 resolve 的 Promise**。
 * 全仓对 `examTablesProbe` 只有三处引用（定义 / `:274` 的自清 / 这里），
 * **没有任何外部清理入口** —— 后果是 `Exams.tsx` 上那个「重试」按钮**是空操作**，
 * 跑完 §15 必须整页刷新才生效。
 *
 * ⚠️ 语义与 `probeExamTables()` 内部的"探测无结论时自清"**是同一件事**：
 *    清掉 = 下一次 `ensureExamTables()` 重新发一次请求。它**只清缓存、不写任何东西**。
 */
export function resetExamTablesProbe(): void {
  examTablesProbe = null
  examTablesProbeSettled = false
}

/**
 * `ensureExamTables()` 到底有没有**结论**？
 *
 * 为什么需要单独一个 getter：它对外只返回 `'present' | 'missing'` 两个值，
 * 而"探测本身失败（断网 / 权限错误）"也被折成了 `'missing'`。
 * 于是界面上"表真的不在"和"我没问出来"长得一模一样 ——
 * 而本项目的纪律是**"无法判断"必须是独立的第四种状态，不能归到绿、也不能归到红**
 * （面板方案 §3.4 第 4 条；`自检.sql` 的"查不到人 = 假通过"是同一条教训）。
 *
 * 返回 `'unknown'` 的两种情形都要说清楚：
 *   · `pending` —— 探测还没跑完；
 *   · `indeterminate` —— 跑完了但没有结论（网络抖动），**这个结果没有被缓存**。
 */
export type ExamProbeStatus = 'pending' | 'present' | 'missing' | 'indeterminate'

let examTablesProbeSettled = false

export function getExamTablesProbeStatus(): ExamProbeStatus {
  if (!examTablesProbe) return 'pending'
  if (!examTablesProbeSettled) return 'pending'
  return lastExamTablesProbe
}

/* ---------------- 四个探测的**汇总**（超管运维面板 C2） ----------------

   现状（面板方案 §二 C2）：四个 `ensureXxx()` 各自把结果缓存在**模块级 let** 里，
   一个页面会话只探一次、刷新才重探、**没有任何一处汇总**。
   后果很具体：「某功能用不了但不知道为什么」时，看不到"前端自己以为哪些列/表在"。

   ⚠️ 这一段的纪律（三条，都写在方案的 C2 里）：
    ① **不改缓存语义** —— "同页面一次"是刻意的（见上面 `ensureSubjectCols` 的注释），
       这里只在既有的 resolve 上**旁听**，不改变任何一次探测的时机与次数；
    ② **不改任何写入路径的行为** —— 面板只"看"；
    ③ **不新写一套判据** —— 汇总里每一项的来源仍是原来那个 `ensureXxx()`。

   ⚠️ 第**四**个探测（`lib/files.ts` 的 `ensureFileClassCols`）**不在这份汇总里**：
      它的缓存变量在另一个模块里，且**没有对外的只读 getter**；
      而"给文件列加一个 getter"要动 `lib/files.ts`，那是本轮明确不许碰的文件。
       面板里这一列的现状由 `probeSchemaDrift()` 对 `shared_files.class_ids`
       独立探一次得到（同一个判据、两条互不相干的路径）。 */

/** 一个探测的结论：`present` 在 / `missing` 不在 / `indeterminate` 认不出来 */
export type ProbeState = 'present' | 'missing' | 'indeterminate'

type ProbeRecord = { state: ProbeState; at: number }

/** 每个探测的**最后一次结论**与时刻（模块级，与探测缓存的寿命一致） */
const probeRecords = new Map<string, ProbeRecord>()

/** 旁听一次探测：**先挂 then 再返回原 Promise**，不改变任何调用方的时序 */
function watchProbe<P>(
  key: string,
  p: Promise<P>,
  interpret: (v: P) => ProbeState = (v) => (v === true ? 'present' : 'missing'),
): Promise<P> {
  void Promise.resolve(p).then(
    (v) => probeRecords.set(key, { state: interpret(v), at: Date.now() }),
    () => probeRecords.set(key, { state: 'indeterminate', at: Date.now() }),
  )
  return p
}

export type ProbeReportItem = {
  /** 稳定标识（给断言与测试用，界面文案另算） */
  key: string
  label: string
  /** 它探的是哪张表/哪一列 —— 界面上要写出来，否则"四行都是 present"没有信息量 */
  target: string
  state: ProbeState
  /** 最后一次探测时刻（epoch ms）；从没探过是 null */
  at: number | null
  /** `indeterminate` 时那句人话 */
  note?: string
}

export type ProbeReport = {
  /** 这次汇总取的时刻 */
  collectedAt: number
  items: ProbeReportItem[]
}

/**
 * 把四个（实际能看到的三个 + 考试表）探测结果汇总给面板。
 *
 * 顺序固定，不随探测发生的先后变 —— 界面上四行来回跳会让人以为状态在变。
 */
export function probeReport(): ProbeReport {
  const of = (key: string): ProbeState => probeRecords.get(key)?.state ?? 'indeterminate'
  const at = (key: string): number | null => probeRecords.get(key)?.at ?? null
  const IND = '探测无结论（网络抖动 / 权限错误一律当作"有"，所以这个结果**不可信**）'

  const items: ProbeReportItem[] = [
    {
      key: 'subjectCols',
      label: '学科两列',
      target: 'assignments.subject_code · teachers.primary_subject_code',
      state: of('subjectCols'),
      at: at('subjectCols'),
      note: IND,
    },
    {
      key: 'gradeLookup',
      label: '年级外键',
      target: 'classes.grade_id + grades 映射',
      state: of('gradeLookup'),
      at: at('gradeLookup'),
      note: `它影响的正是**权限判据**（年级主任那一支）。${IND}`,
    },
    {
      key: 'examTables',
      label: '考试两张表',
      target: 'exams · exam_scores',
      state: of('examTables'),
      at: at('examTables'),
      note: '这是四个探测里**唯一会自我清缓存**的一个（无结论时下次重探）。',
    },
    {
      key: 'serialCols',
      label: '序列号列',
      target: 'students.serial（+ legacy_student_no 只读不写）',
      state: of('serialCols'),
      at: at('serialCols'),
      note: IND,
    },
    /*
     * 🆕 2026-09-30（P3）：学年 / 学期那一列（`assignments.term_id`，`schema.sql` §28）。
     * 它单独一格的理由与上面那个探测单独存在一样：**它决定"列表默认只看本学期"能不能生效** ——
     * 这一列为 `missing` 时列表不筛（照常显示全部），那一页的学年设置也就无从写起。
     */
    {
      key: 'termCols',
      label: '学期列',
      target: 'assignments.term_id + academic_years / terms',
      state: of('termCols'),
      at: at('termCols'),
      note: `它为 missing 时列表**不按学期筛**（宁可多看见，绝不静默藏档案）。${IND}`,
    },
  ]
  return { collectedAt: Date.now(), items }
}
/* ---------------- 兼容期：`students.serial` 这一列在不在？（schema.sql §20） ----------------

   与 `ensureSubjectCols()` 同一套纪律，判据是**列**：
     · 读：`select('*')` 读不到那个键**不报错**，`rowToStudent` 按"没有序列号"处理
          → 档案键退回班内学号（`lib/keys.ts`），老库上的行为**一个字节都不变**；
     · 写：upsert 的载荷里带上这一列 → 列不存在时**整条 upsert 被拒**
          → "保存失败 = 刷新即丢"（老师刚加的名单刷新就没了）。
          所以**列不存在就把这一列从行里摘掉**（不是写 null）。
     · `legacy_student_no` **任何时候都不写**：它是迁移判据，数据库 §20.2 的触发器会拒。

   ⚠️ 判据只看「列不存在」这一种错误；网络抖动/权限问题**一律当作有**。 */

type SerialCols = { students: boolean }

let serialColsProbe: Promise<SerialCols> | null = null

async function probeSerialCols(): Promise<SerialCols> {
  const sb = getSupabase()
  if (!sb) return { students: false }
  try {
    const { error } = await sb.from('students').select('serial').limit(1)
    if (!error) return { students: true }
    const msg = String(error.message ?? '')
    const code = String((error as { code?: string }).code ?? '')
    return { students: !(code === '42703' || /does not exist/i.test(msg)) }
  } catch {
    return { students: true }
  }
}

/** 探测一次（同一页面内只探一次），给写路径用 */
export function ensureSerialCols(): Promise<SerialCols> {
  if (!serialColsProbe) {
    const p = probeSerialCols()
    serialColsProbe = watchProbe('serialCols', p, (v) => (v.students ? 'present' : 'missing'))
  }
  return serialColsProbe
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
  ...(Object.prototype.hasOwnProperty.call(r, 'term_id') ? { termId: r.term_id ?? null } : {}),
  ...(Object.prototype.hasOwnProperty.call(r, 'grade_id') ? { gradeId: r.grade_id ?? null } : {}),
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
    /*
     * 学期归属（§28）：与作业同一条口径 —— **由 `exam_date` 推**，算不出就不带这一列
     * （不带 = 保住库里已有的值；带 null = 把回填好的归属擦掉）。
     */
    const row: Record<string, unknown> = { ...examToRow(e, teacherId) }
    const tid = await termIdForDate(e.examDate)
    if (tid) row.term_id = tid
    const { error } = await sb.from('exams').upsert(row as never, { onConflict: 'id' })
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

/* ---------------- 年级：`classes.grade_id` 的写入判据（schema.sql 第 10 段） ----------------

   为什么需要它（2026-09-27 用户拍板的"建班要带 grade_id"）：
   `classes.grade_id` 是**权限判据的一环** —— `visible_class_ids()` 里"年级主任看本年级"
   那一支、`can_manage_class()` 里同一条，都按它判。前端建出来的班原来 `grade_id` 是空的，
   于是"年级主任/班主任自己建的班"只有 super/admin 管得动：**加不了学生、改不了班级课表**
   （实测结论见 §十六 16.9 第 1 条）。

   前端手里只有 `classes.grade` 这个**文本**（「高二」，班级表单里选的），
   所以要拿它去 `grades` 表换 id。三条纪律：

     · **列不存在就不带**（线上库可能还没跑第 10 段）—— 与 `ensureSubjectCols` 同一条：
       带上一列不存在的列，整条 upsert 会被 PostgREST 拒掉（"保存失败 = 刷新即丢"）。
     · **认不出就不带**（年级表里没有同名行）—— 留空与今天的行为一样，不倒退。
     · **同名多条也不带**（`grades` 的唯一键是 `school_id + name`，跨学校可以重名）——
       `grade_id` 决定"哪个年级主任管得着这个班"，**猜错就是权限事故**，
       所以宁可留空让教务处去指派。 */

type GradeLookup = {
  /** `classes.grade_id` 这一列在不在 */
  column: boolean
  /** 年级名 → `grades.id`；同名多条（歧义）时值为 `null` */
  byName: Map<string, string | null>
  /**
   * 年级名 → **4 位入校年份**（`grades.cohort` 优先、老列 `grades.year` 兜底）。
   *
   * 用途只有一个：本地 / 恢复备份时按 U-2 的规则给新学生发序列号（`lib/serial.ts`）。
   * ⚠️ **同名多条 / 认不出 / 值不是 4 位数字 → 不放进这张表**（不猜，I14）。
   * ⚠️ 云端新建学生**以数据库那条规则为准**（`students_serial_fill()` 触发器）——
   *    这里只是它的镜像，推不出年份就不带序列号，留给数据库发。
   */
  years: Record<string, string>
}

let gradeLookupProbe: Promise<GradeLookup> | null = null

async function probeGradeLookup(): Promise<GradeLookup> {
  const sb = getSupabase()
  if (!sb) return { column: false, byName: new Map(), years: {} }
  const column = await (async () => {
    try {
      const { error } = await sb.from('classes').select('grade_id').limit(1)
      if (!error) return true
      const code = String((error as { code?: string }).code ?? '')
      const msg = String(error.message ?? '')
      // 只有「列不存在」才判定成还没跑第 10 段；网络抖动/权限问题一律当作**有**
      return !(code === '42703' || /does not exist/i.test(msg))
    } catch {
      return true
    }
  })()
  const byName = new Map<string, string | null>()
  const years: Record<string, string> = {}
  if (!column) return { column: false, byName, years }
  try {
    /*
     * `cohort`（P3 之后才有的列）用 `*` 读 —— 列不存在时它只是读不到那个键，**不报错**。
     * 这正是本项目兼容期读法的标准手法（`select('*')` + mapper 兜底）。
     */
    const { data, error } = await sb.from('grades').select('*')
    if (error) return { column: true, byName, years } // 读不到年级表 → 认不出，不猜
    const seen = new Set<string>()
    for (const row of (data ?? []) as { id?: string; name?: string; cohort?: string; year?: string }[]) {
      const name = (row.name ?? '').trim()
      if (!name || !row.id) continue
      // 第二次遇到同一个名字 → 记成"认不出"（歧义），后面一律不带
      byName.set(name, byName.has(name) ? null : row.id)
      if (seen.has(name)) {
        delete years[name]
        continue
      }
      seen.add(name)
      const y = String(row.cohort ?? '').trim() || String(row.year ?? '').trim()
      if (/^[0-9]{4}/.test(y)) years[name] = y.slice(0, 4)
    }
  } catch {
    /* 认不出，不猜 */
  }
  return { column: true, byName, years }
}

/** 探测一次（同一页面内只探一次），给 `saveClass` 用 */
export function ensureGradeLookup(): Promise<GradeLookup> {
  if (!gradeLookupProbe) {
    const p = probeGradeLookup()
    gradeLookupProbe = watchProbe('gradeLookup', p, (v) => (v.column ? 'present' : 'missing'))
  }
  return gradeLookupProbe
}

/* ---------------- 本地 → 行 ---------------- */

/**
 * 本地班级 → `classes` 行。
 *
 * `gradeId` 由调用方（`saveClass`）从 `grades` 表查出来传进来 ——
 * 这是**纯函数不带可选列**的同一条纪律（对照 `assignmentToRow` 的注释）：
 * "这一列在不在/认不认得出"的判断不放在纯函数里。
 */
export const classToRow = (
  k: Klass,
  teacherId: string,
  gradeId?: string | null,
  /** `classes.kind` / `class_type` / `stream_key` 三列在不在（`ensureClassCols()`） */
  withP6Cols = false,
): ClassRow => ({
  id: k.id,
  teacher_id: teacherId,
  name: k.name,
  grade: k.grade,
  year: k.year,
  ...(gradeId ? { grade_id: gradeId } : {}),
  /* 🔴 三列**只在列真的存在时**才带上（与 `assignmentWriteRow` 同一条纪律）：
   *    线上库还没跑 §27 时带上它们，整条 upsert 会被 PostgREST 拒 ——
   *    而"保存失败 = 刷新即丢"。列存在时又必须带上，否则新班的班型永远存不进去。 */
  ...(withP6Cols
    ? {
        kind: classKindOf(k),
        class_type: k.classType ?? '',
        stream_key: k.streamKey ?? '',
      }
    : {}),
})

/**
 * 本地学生 → `students` 行（**纯函数**，不判"列在不在"）。
 *
 * `serial`：有值就带上（云端以数据库那条规则为准，前端只是把已知的值送回去）；
 *          空串**不带** —— 让数据库的 `students_serial_fill()` 触发器去发号，
 *          而不是把一个空值写进去（写空值 = 把数据库已经发好的号擦掉，见 §20.2 的守卫）。
 * `legacy_student_no`：**永远不带**。它是迁移判据，写它会被数据库拒（§20.2）。
 */
export const studentToRow = (s: Student, classId: string): StudentRow => ({
  id: s.id,
  class_id: classId,
  student_no: s.studentNo,
  name: s.name,
  status: s.status,
  ...(s.serial ? { serial: s.serial } : {}),
})

/**
 * 学生的**落库载荷** —— `serial` 带不带，只有这一处说了算。
 *
 * 🔴 与 `assignmentWriteRow` 同一条纪律：**列不存在就不带这一列**。
 *    线上库还没跑 `schema.sql` §20 时带上它，整条 upsert 会被 PostgREST 拒掉 ——
 *    而"保存失败 = 刷新即丢"。`legacy_student_no` 更是一个字节都不许出现。
 *
 * ⚠️ 三条写学生的路径**共用它**：`saveStudent`（单条）/ `saveStudents`（批量导入）/
 *    `pushBackupToCloud`（恢复备份）—— 少覆盖一条就是"某个入口悄悄写不进去"。
 */
export async function studentWriteRow(
  s: Student,
  classId: string,
): Promise<Record<string, unknown>> {
  const cols = await ensureSerialCols()
  const row: Record<string, unknown> = { ...studentToRow(s, classId) }
  if (!cols.students) delete row.serial
  return row
}

/**
 * 本地 → 行。
 *
 * ⚠️ **故意不带 `subject_code`**：带不带取决于那一列在不在（见 ensureSubjectCols），
 *    而这是一个纯函数 —— 那个判断留给 `assignmentWriteRow`（`saveAssignment` 与
 *    "备份回推云端"共用它）：**列不存在不带、认不出学科也不带**，两条纪律写在那里。
 *    （upsert 只更新载荷里出现过的列，所以老行的 subject_code 不会被抹掉。）
 */
export const assignmentToRow = (a: Assignment, teacherId: string): AssignmentRow => ({
  id: a.id,
  /* 未归属（空串）→ **写 `null`**，绝不写空串：`class_id` 是 `uuid`，
     空串会当场 22P02 "invalid input syntax for type uuid" → 整条 upsert 被拒 = 刷新即丢。
     ⚠️ 判据走 `isUnassigned()`（**唯一一处**的"空"口径），不在这里再写一遍 `=== ''`。 */
  class_id: isUnassigned(a.classId) ? null : a.classId,
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

/**
 * 呼叫的落库载荷。
 *
 * 🔴 `assignment_id` 的**唯一映射处**（✅ Q32 = C）：前端只有"没有"这一种写法（空串），
 *    数据库那一列是**可空**的 —— `'' → null` 必须在这里发生，只此一处。
 *    ⚠️ 写成 `c.assignmentId` 直接传的话，PostgREST 会拿空串去比 uuid 列 → `22P02`，
 *    整条呼叫发不出去（而"发不出去"在界面上看着像"网络抖了一下"）。
 */
export const callToRow = (c: CallRecord, teacherId: string): CallRow => ({
  id: c.id,
  teacher_id: teacherId,
  assignment_id: c.assignmentId ? c.assignmentId : null,
  class_id: c.classId,
  student_nos: c.studentNos,
  text: c.text,
  room: c.room,
  sent_at: c.sentAt.map((t) => new Date(t).toISOString()),
  states: c.states,
})

/**
 * 🆕 学生档案 → `student_profiles` 行（2026-10 · 备份缺口）。
 *
 * ⚠️ 与 `lib/studentProfile.ts` 里那份 `profileToRow` **同一条口径**（trim；民族 / 电话 /
 *    住址空着就写空串 —— 那三列没有 check）。
 *    为什么这里要再来一份：备份的"回推云端"是从 `lib/backup.ts` 走的（与页面那条路
 *    不同的调用点），而 lib 不该反向依赖页面；两份都只做"形状映射"，判据仍在数据库。
 *
 * 🔴 **`birth_month` 只有形状对（`YYYY-MM`）时才放进载荷**（`schema.sql` §2.1 那条 check
 *    只收 `YYYY-MM` 或 null）。空着 / 写着「2010年5月」这类原文时**整列不出现**：
 *    写空串会**当场被 check 拒**（整批 upsert 失败 = 刷新即丢），写 null 又会把
 *    云端已有的出生年月抹掉 —— 与 `assignmentWriteRow` 的"认不出就不带"同一条纪律。
 */
export const studentProfileToRow = (p: StudentProfile): Record<string, string> => {
  const row: Record<string, string> = {
    student_id: p.studentId,
    ethnicity: String(p.ethnicity ?? '').trim(),
    guardian_phone: String(p.guardianPhone ?? '').trim(),
    home_address: String(p.homeAddress ?? '').trim(),
  }
  const birth = String(p.birthMonth ?? '').trim()
  if (/^\d{4}-\d{2}$/.test(birth)) row.birth_month = birth
  return row
}

/**
 * 🆕 教师档案 → `teacher_profiles` 行（2026-10 · 备份缺口）。
 *
 * ⚠️ 前端**不直连**这张表 upsert（见 `lib/teacherProfile.ts` 的说明：对老师本人
 *    那条路会静默失败）。这里这份只给"从备份恢复"用，而恢复走的是
 *    `can_create_teacher_accounts()` 那一档的判据 —— 挡下时 `pushBackupToCloud`
 *    会因为数回 0 行而**显式报错**，不会假装成功。
 */
export const teacherProfileToRow = (p: TeacherProfile): Record<string, string> => ({
  teacher_id: p.teacherId,
  home_address: String(p.homeAddress ?? '').trim(),
  phone: String(p.phone ?? '').trim(),
  email: String(p.email ?? '').trim(),
})

/* ---------------- 行 → 本地 ---------------- */

const rowToStudent = (r: StudentRow): Student => ({
  id: r.id,
  studentNo: r.student_no,
  name: r.name,
  status: (r.status as StudentStatus) ?? 'active',
  /*
   * 序列号：`select('*')` 读不到那个键（列还没建）时是 `undefined` → 空串。
   * ⚠️ **不在这里发号**：号码只能由数据库那条规则发（`students_serial_fill()`），
   *    前端另发一个 = 两个真相（同一个学生两边不一致，而且不可改）。
   *    本地演示模式/导入老备份那两条路才由 `lib/serial.ts` 发（那里没有数据库）。
   */
  serial: typeof r.serial === 'string' ? r.serial : '',
  legacyStudentNo: typeof r.legacy_student_no === 'string' ? r.legacy_student_no : '',
  createdAt: Date.now(),
})

const rowToAssignment = (r: AssignmentRow): Assignment => ({
  id: r.id,
  /* `null` → 空串（**归一到唯一一种"未归属"的写法**，见 types.ts 的 Assignment.classId） */
  classId: r.class_id ?? '',
  title: r.title,
  subject: r.subject,
  /*
   * 兼容期读法：新列有值就用；没有（列还没建，或老行没回填）就按显示名反查字典。
   * 反查不出来就留 undefined —— 绝不猜，页面上退回显示 `subject` 原样。
   */
  subjectCode: asSubjectCode(r.subject_code) ?? subjectCodeOfName(r.subject),
  assignDate: r.assign_date,
  /*
   * 学期归属（§28）。**列不存在时保持 `undefined`（= 不知道）**，不要写成 null：
   * 两者在列表里都"能看见"，但 `undefined` 还能让探针与面板看出"SQL 还没跑"。
   */
  ...(Object.prototype.hasOwnProperty.call(r, 'term_id') ? { termId: r.term_id ?? null } : {}),
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
  /* 库里的 `null`（事务性呼叫）→ 空串：前端"没有挂作业"只有这一种写法 */
  assignmentId: r.assignment_id ?? '',
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
/**
 * 「这一列在不在」—— 与 `isMissingTable()` **成对、但判据分流**：
 * 这里找的是**列**（`42703` / `PGRST204` / `column … does not exist`），
 * 那边找的是**表**（`42P01` / `PGRST205` / `relation … does not exist`）。
 * 🔴 两者**不许**合成一条泛化的 `does not exist` —— 合起来就会把"这一列不在"
 *    读成"这张表没建"（§20.7 那次误报的形状）。
 *
 * 🔴 只认「列不存在」这一种错误：网络抖动 / 权限问题**一律当作出错**（不是"列不在"）——
 *    否则一次抖动就会被读成"这一列从来不存在"，而那是个**永久**结论。
 */
function isMissingColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false
  const code = String(error.code ?? '')
  const msg = String(error.message ?? '')
  return code === '42703' || code === 'PGRST204' || /column .*does not exist/i.test(msg)
}

export async function loadMyRoles(userId: string): Promise<TeacherRole[]> {
  const sb = getSupabase()
  if (!sb) return []
  try {
    /*
     * 🆕 `subject_code` 那一列可能还不存在（第 10.1.1 段没跑）——
     * 与 `ensureSubjectCols()` 同一套判据：**只认「列不存在」，摘掉它重读**。
     * 不这么做的话，旧库上"我的身份"会整条读不到（= 所有管理入口一起消失，**而且不报错**）。
     */
    const base = 'role, scope_type, scope_id'
    /*
     * ⚠️ `let res: { data: unknown; error: ... }` 而不是让它从第一次赋值推断类型 ——
     *    两次 select 的**列不同**，推断出来的类型会互相打架（而它们本来就都是 any[]）。
     */
    let res: { data: unknown; error: { message?: string; code?: string } | null } = await sb
      .from('teacher_roles')
      .select(`${base}, subject_code`)
      .eq('teacher_id', userId)
    if (res.error && isMissingColumn(res.error)) {
      res = await sb.from('teacher_roles').select(base).eq('teacher_id', userId)
    }
    if (res.error) return []
    const data = (res.data ?? []) as {
      role?: string
      scope_type?: string
      scope_id?: string
      subject_code?: string | null
    }[]
    return data
      .filter((r) => typeof r.role === 'string' && r.role !== '')
      .map((r) => ({
        role: r.role as TeacherRole['role'],
        scopeType: (r.scope_type ?? undefined) as TeacherRole['scopeType'],
        scopeId: r.scope_id ?? undefined,
        subjectCode: r.subject_code ?? undefined,
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
    // 名单统一排序只有一处：`compareRoster`（有序列号按序列号，没有才按班内学号）
    students: (studentsByClass.get(row.id) ?? []).sort(compareRoster),
    /* §27.2 的三列：老库读不到 → 不写这三个键（`classKindOf()` / `classTypeOf()` 有兜底） */
    ...(row.kind === 'stream' ? { kind: 'stream' as const } : {}),
    ...(row.class_type ? { classType: row.class_type as ClassType } : {}),
    ...(row.stream_key ? { streamKey: row.stream_key } : {}),
    ...(row.grade_id ? { gradeId: row.grade_id } : {}),
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

/**
 * 写班级那一行。
 *
 * `grade_id` 是这一轮补上的（见上面 `ensureGradeLookup` 的说明）：
 * 它是权限判据的一环，留空会让"年级主任/班主任自己建的班"只有 super/admin 管得动。
 * 三步：列在不在 → 年级名换不换得出 id → 都成立才把这一列放进载荷。
 * `upsert` 只更新载荷里出现过的列，所以认不出时**老行的 grade_id 不会被抹掉**。
 */
export const saveClass = async (k: Klass, teacherId: string) => {
  const lookup = await ensureGradeLookup()
  const gradeId = lookup.column ? gradeLookupId(lookup, k.grade) : null
  const p6 = await ensureClassCols()
  return upsert('classes', classToRow(k, teacherId, gradeId, p6.kind))
}

/** 年级名 → id；认不出或同名多条（歧义）→ null（**不猜**，见 ensureGradeLookup） */
export function gradeLookupId(lookup: GradeLookup, gradeName: string): string | null {
  return lookup.byName.get((gradeName ?? '').trim()) ?? null
}

/**
 * 一批班级 → `classes` 行（含 `grade_id`，判据与 `saveClass` 完全一致）。
 *
 * 「恢复备份 → 回推云端」也走它：那是**第二条写班级的路径**，
 * 只修 `saveClass` 的话，恢复出来的班照样 `grade_id` 为空 ——
 * 年级主任/班主任还是加不了学生、改不了班级课表（同一件事两个入口，必须一起守）。
 */
export async function classRows(list: Klass[], teacherId: string): Promise<ClassRow[]> {
  const lookup = await ensureGradeLookup()
  const p6 = await ensureClassCols()
  return list.map((k) =>
    classToRow(k, teacherId, lookup.column ? gradeLookupId(lookup, k.grade) : null, p6.kind),
  )
}
export const deleteClass = (id: string) => remove('classes', id)

/**
 * 🆕 2026-09-30「开学准备」：**年级表那一份**（`grades`）。
 *
 * 🔴 它**不在 `loadSnapshot()` 里**（与考试 / 通知那两张表同一条纪律）：
 *    年级表读不到时不该让整份快照作废 —— 那会让"整个平台打不开"，
 *    而它只是"开学准备那一页少一行数据"。
 *
 * ⚠️ 实现放在 `data/gradeSetup.ts`（那一页自己的读），这里只是一个转发口：
 *    `store.hydrate()` 与页面都从 `remote.*` 取数据，多一个入口就是两个口径。
 */
export { loadGrades, loadGradeSetup } from './gradeSetup'
export type { GradeRow, GradeSetupBundle, GradeSetupState } from './gradeSetup'

/* ---------------- 开学准备（P6）：读任课关系 / 写选科（走服务端） ----------------

   🔴 两张表的分工（**别混**）：
     · `class_subjects`（任课关系）—— 客户端**只读**（`class_subjects_read` 策略）。
       批量写在数据库层零写权限 → 只能走 `/api/grade-setup` 的 `classSubjectBulk`。
     · `student_subjects`（学生的选科）—— 客户端有写策略，但**这一页的写入仍然走服务端**：
       因为"选科 + 走班班成员"要**同一个事务**，而两次 PostgREST 请求 = 两个事务
       = 可以只成功一半（本期验收要钉死的那条）。

   ⚠️ 读失败一律回 `null`（"不知道"），**不许回空数组** ——
      空数组在界面上是"这个老师一节课都没排"，与"没读到"完全是两回事。 */

export type ClassSubjectRow = { classId: string; subjectCode: string; teacherId: string }

export async function loadClassSubjects(classIds: string[]): Promise<ClassSubjectRow[] | null> {
  const sb = getSupabase()
  if (!sb || !classIds.length) return sb ? [] : null
  try {
    const { data, error } = await sb.from('class_subjects').select('*').in('class_id', classIds)
    if (error) return null
    return (data ?? [])
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r.subject_code)
      .map((r) => ({
        classId: String(r.class_id),
        subjectCode: String(r.subject_code),
        teacherId: String(r.teacher_id),
      }))
  } catch {
    return null
  }
}

export const saveStudent = async (s: Student, classId: string) =>
  upsert('students', await studentWriteRow(s, classId))
export const saveStudents = async (classId: string, list: Student[]) =>
  list.length
    ? upsert('students', await Promise.all(list.map((s) => studentWriteRow(s, classId))))
    : Promise.resolve()
export const deleteStudent = (id: string) => remove('students', id)

/* ---------------- 走班班成员（`class_members`，P6 建表 / P7 写 / **P5 有读取纪律**） ----------------

   🔴 **它不进 `loadSnapshot()`**（与考试 / 通知 / 年级那几张表同一条纪律）：
      `class_members` 是 §27.5 才有的表，**老库上没有它** ——
      混进那组"任一失败就整份快照作废"里，会让整个平台在老库上打不开。

   ⚠️ 因此读取一律**懒加载 + 先探针**（`ensureClassMembers()`）。探针用 `select('*')`
      （`nav-checks` 的 D10 会静态抓 `select('具体列名')` —— 那类 bug 咬过两次）。 */

type ClassMemberCols = { ok: boolean }

let classMembersProbe: Promise<ClassMemberCols> | null = null

async function probeClassMembers(): Promise<ClassMemberCols> {
  const sb = getSupabase()
  if (!sb) return { ok: false }
  try {
    const { error } = await sb.from('class_members').select('*').limit(1)
    if (!error) return { ok: true }
    const msg = String(error.message ?? '')
    const code = String((error as { code?: string }).code ?? '')
    /* 表不存在 = 还没跑 §27；别的错误（网络、权限）一律当作"有" */
    return { ok: !(code === '42P01' || code === '42703' || /does not exist/i.test(msg)) }
  } catch {
    return { ok: true }
  }
}

/** 探测一次（同一页面内只探一次） */
export function ensureClassMembers(): Promise<ClassMemberCols> {
  if (!classMembersProbe) {
    classMembersProbe = watchProbe('classMembers', probeClassMembers(), (v) =>
      v.ok ? 'present' : 'missing',
    )
  }
  return classMembersProbe
}

/**
 * 走班班的成员关系（**多对多**：一个学生可以同时在两个走班班里 —— U-1 = A）。
 * 返回 `classId → 学生 id[]`；**读不到回 `null`（"不知道"），不回空对象**。
 *
 * ⚠️ 为什么回 `null` 而不是 `{}`：空对象在界面上是"这个走班班一个人都没有"，
 *    与"没读到"完全是两回事（`loadClassSubjects` 同一条纪律）。
 */
export async function loadClassMembers(classIds: string[]): Promise<Record<string, string[]> | null> {
  const sb = getSupabase()
  if (!sb || !classIds.length) return sb ? {} : null
  const cols = await ensureClassMembers()
  if (!cols.ok) return null
  try {
    const { data, error } = await sb.from('class_members').select('*').in('class_id', classIds)
    if (error) return null
    const out: Record<string, string[]> = {}
    for (const r of (data ?? []) as Array<{ class_id?: unknown; student_id?: unknown }>) {
      const k = String(r.class_id ?? '')
      if (!k) continue
      const list = out[k] ?? []
      list.push(String(r.student_id ?? ''))
      out[k] = list
    }
    return out
  } catch {
    return null
  }
}

/* ---------------- 走班班成员 · **带人**的那一份（班级档案页 / 班级列表那两处要人数） ----------------

   🔴 为什么必须有它（2026-10-08 修的那条链）：
      `loadClassMembers()` 只回**学生 id**，而班级档案页与班级列表要的是**人数与姓名** ——
      那两处原来读的是 `klass.students`（= `students.class_id`），而走班班的人
      **永远不在 `class_id` 上**（多对多，§27.5）→ 屏上恒为「0 人」，
      而 `analyzeRoster([])` 又把它判成「名单完整」（0 人没有缺号、没有重号）。
      「同一份数据、两个页面自相矛盾」（开学准备说 2 人、班级页说 0 人）就是这么来的。

   ⚠️ 读不到回 `known: false`（"不知道"），**不回空数组** —— 空数组在界面上是
      "这个走班班一个人都没有"，与"没读到"是两回事（§三.4 的三态纪律）。 */

export type ClassMemberPerson = {
  id: string
  name: string
  studentNo: string
  status: StudentStatus
}

export type ClassMembersResult = {
  /** `classId → 成员行`（**读到了**才填；没读到就是 `{}`） */
  by: Record<string, ClassMemberPerson[]>
  /** 这一次到底读到了没有；`false` = 老库没有 `class_members` / 断网 → 界面必须写"没读到" */
  known: boolean
}

/** 成员那一层探针（与 `ensureClassMembers()` 同一个结论，只是这里要顺手探 `students`） */
let studentsProbe: Promise<boolean> | null = null

async function probeStudents(): Promise<boolean> {
  const sb = getSupabase()
  if (!sb) return false
  try {
    const { error } = await sb.from('students').select('*').limit(1)
    if (!error) return true
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    return !(code === '42P01' || code === '42703' || /does not exist/i.test(msg))
  } catch {
    return true
  }
}

function ensureStudents(): Promise<boolean> {
  if (!studentsProbe) studentsProbe = watchProbe('students', probeStudents(), (v) => (v ? 'present' : 'missing'))
  return studentsProbe
}

/** 姓名的兜底：认不出的行**不猜名字**（空串比假名字好） */
function asMemberPerson(row: Record<string, unknown>): ClassMemberPerson {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    studentNo: String(row.student_no ?? ''),
    status: normalizeStudentStatus(row.status),
  }
}

/**
 * 一次把若干个班的成员（**带姓名 / 学号 / 状态**）读出来。
 * 只读两张表：`class_members`（成员关系）+ `students`（姓名那一列）。
 */
export async function loadClassMembersFull(classIds: string[]): Promise<ClassMembersResult> {
  const sb = getSupabase()
  if (!sb || !classIds.length) return { by: {}, known: Boolean(sb) && !classIds.length }
  const cols = await ensureClassMembers()
  if (!cols.ok) return { by: {}, known: false }
  try {
    const m = await sb.from('class_members').select('*').in('class_id', classIds)
    if (m.error) return { by: {}, known: false }
    const rows = (m.data ?? []) as Array<{ class_id?: unknown; student_id?: unknown }>
    const by: Record<string, ClassMemberPerson[]> = {}
    for (const id of classIds) by[id] = []
    for (const r of rows) {
      const k = String(r.class_id ?? '')
      const sid = String(r.student_id ?? '')
      if (!k || !sid) continue
      ;(by[k] ??= []).push({ id: sid, name: '', studentNo: '', status: 'active' })
    }
    const ids = [...new Set(rows.map((r) => String(r.student_id ?? '')).filter(Boolean))]
    if (ids.length && (await ensureStudents())) {
      const s = await sb.from('students').select('*').in('id', ids)
      if (s.error) return { by: {}, known: false }
      const info = new Map<string, ClassMemberPerson>()
      for (const row of (s.data ?? []) as Record<string, unknown>[]) {
        const p = asMemberPerson(row)
        if (p.id) info.set(p.id, p)
      }
      for (const k of Object.keys(by)) {
        by[k] = by[k].map((p) => info.get(p.id) ?? p).sort(compareRoster)
      }
    }
    return { by, known: true }
  } catch {
    return { by: {}, known: false }
  }
}

/* ---------------- 走班班的**改名 / 改成员**（2026-10-08：内测「走班班没有编辑键」）----------------

   🔴 改名走 `classes_update`（`can_manage_class_for`）—— 走班班也是 `classes` 的一行，
      所以**复用 `saveClass` 那一条路**（`classToRow` 把 kind / stream_key 原样带上，
      不会把走班班存成行政班），**不另写一套**。
   🔴 成员写的是 `class_members`（多对多），**不是 `students.class_id`** ——
      走班班的人永远不在 `class_id` 上（§27.5），写错源就是恒为 0 人。
   ⚠️ 换老师**不在这里**：那一条会同时补 `class_subjects`（§32.3），
      走的是服务端的 `classSubjectAssign`（`lib/gradeSetup.ts` 的 `apiAssignStreamTeacher`），
      在这里再写一次 `classes.teacher_id` 就是同一件事的第二个入口。 */

/**
 * 保存走班班这一行（**只动 `classes`**）。
 *
 * 返回值是"到底成没成"：`upsert` 失败时**必须上屏**（"不报错但就是不对"是这个项目最忌的形状）。
 */
export async function saveStreamName(k: Klass, teacherId: string): Promise<boolean> {
  try {
    await saveClass(k, teacherId)
    return true
  } catch (e) {
    console.warn('[stream] 保存走班班失败', e, k.id)
    return false
  }
}

/**
 * 手工增删走班班的成员（**整份替换**，写 `class_members`）。
 *
 * 走数据库的 `write_stream_members()`（`schema.sql` §37.1）—— `class_members`
 * 对 `authenticated` 是**零写权限**的表（§27.8），所以只有函数这一条路。
 * 判据在函数里（`can_manage_class()`）；前端**一个判据都不写**，只把失败显式带回来。
 *
 * ⚠️ 线上库还没跑 §37 时这个函数不存在 —— 那种情况**显式报错**（"数据库还没跑那一段"），
 *    绝不当成"改成功了"（探针那一套纪律的另一半：`nav-checks` D10 / §三.4）。
 */
export type StreamMembersResult = { ok: boolean; message: string; members: number }

export async function saveStreamMembers(
  classId: string,
  studentIds: string[],
): Promise<StreamMembersResult> {
  const sb = getSupabase()
  if (!isRemote || !sb) {
    return { ok: false, message: '本地演示模式没有数据库，成员改动不会保存。', members: 0 }
  }
  try {
    const { data, error } = await sb.rpc(
      'write_stream_members' as never,
      { p_class_id: classId, p_student_ids: studentIds } as never,
    )
    if (error) {
      const msg = String(error.message ?? '')
      const code = String((error as { code?: string }).code ?? '')
      /* 42883 = `undefined_function`（库还没跑 §37）· PGRST202 = PostgREST 找不到这个 RPC */
      if (code === '42883' || code === 'PGRST202' || /could not find the function/i.test(msg)) {
        return {
          ok: false,
          message: '数据库还没跑 supabase/schema.sql 第 37 段（走班班成员编辑），这一段没法保存。',
          members: 0,
        }
      }
      return { ok: false, message: msg || '成员没能保存', members: 0 }
    }
    const v = (data ?? {}) as Record<string, unknown>
    return { ok: true, message: '', members: Number(v.members ?? studentIds.length) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '成员没能保存', members: 0 }
  }
}

/**
 * 🆕 P10：**选科变更记录**（`student_subject_changes`，`schema.sql` §34.1）。
 *
 * 一行 = 一次改动：谁改的 / 什么时候 / 从什么改成什么（Q27：三档都能改 → 要能查）。
 * `purgedAt` 有值 = 那一次改动**引出**的旧科目数据已经删过一次（**不可恢复**）。
 */
export type StudentSubjectChange = {
  id: string
  studentId: string
  /** 改前的科目快照（`{ kind, primary, second[], note }`）；首次采集是空对象 */
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** 改的人（`teachers.id`）；认不出就是空串 */
  changedBy: string
  changedAt: number
  purgedAt: number
  purgeCounts: Record<string, unknown>
}

type SubjectChangeCols = { ok: boolean }

let subjectChangeProbe: Promise<SubjectChangeCols> | null = null

async function probeSubjectChanges(): Promise<SubjectChangeCols> {
  const sb = getSupabase()
  if (!sb) return { ok: false }
  try {
    /* ⚠️ 探针一律 `select('*')`（`nav-checks` D10 会静态抓具体列名 —— 这一类 bug 咬过两次） */
    const { error } = await sb.from('student_subject_changes').select('*').limit(1)
    if (!error) return { ok: true }
    const msg = String(error.message ?? '')
    const code = String((error as { code?: string }).code ?? '')
    /* 表不存在 = 还没跑 §34；别的错误（网络、权限）一律当作"有" */
    return { ok: !(code === '42P01' || code === '42703' || /does not exist/i.test(msg)) }
  } catch {
    return { ok: true }
  }
}

/** 探测一次（同一页面内只探一次） */
export function ensureSubjectChanges(): Promise<SubjectChangeCols> {
  if (!subjectChangeProbe) {
    subjectChangeProbe = watchProbe('subjectChanges', probeSubjectChanges(), (v) =>
      v.ok ? 'present' : 'missing',
    )
  }
  return subjectChangeProbe
}

/**
 * 读这些学生的选科变更记录（**新的在前**）。
 * **读不到回 `null`（"不知道"），不回空数组** —— 空数组在界面上是"这个学生从没改过选科"，
 * 与"这张表还没建 / 没读到"完全是两回事（`loadClassMembers` 同一条纪律）。
 */
export async function loadStudentSubjectChanges(
  studentIds: string[],
): Promise<StudentSubjectChange[] | null> {
  const sb = getSupabase()
  if (!sb || !studentIds.length) return sb ? [] : null
  const cols = await ensureSubjectChanges()
  if (!cols.ok) return null
  try {
    const { data, error } = await sb
      .from('student_subject_changes')
      .select('*')
      .in('student_id', studentIds)
      .order('changed_at', { ascending: false })
      .limit(500)
    if (error) return null
    return (data ?? []).map((r) => {
      const x = r as Record<string, unknown>
      return {
        id: String(x.id ?? ''),
        studentId: String(x.student_id ?? ''),
        before: (x.before ?? {}) as Record<string, unknown>,
        after: (x.after ?? {}) as Record<string, unknown>,
        changedBy: String(x.changed_by ?? ''),
        changedAt: Date.parse(String(x.changed_at ?? '')) || 0,
        purgedAt: Date.parse(String(x.purged_at ?? '')) || 0,
        purgeCounts: (x.purge_counts ?? {}) as Record<string, unknown>,
      }
    })
  } catch {
    return null
  }
}

/**
 * 作业档案的**落库载荷** —— `subject_code` 带不带，只有这一处说了算。
 *
 * 🔴 两条纪律（两条都破过，见 功能设计与不变量.md §十）：
 *
 *  ① **列不存在就不带这一列**（`ensureSubjectCols` 的探测结果）：带上一列不存在的列，
 *     整条 upsert 会被 PostgREST 拒掉 —— 而本项目"保存失败 = 刷新即丢"。
 *
 *  ② **认不出学科（code 为空）也不带这一列**，而不是写 `null`：
 *     upsert 只更新载荷里出现过的列，所以"不带"＝**保住库里已有的值**。
 *     写 `null` 会把一行本该有学科的历史数据抹成"未标学科"——
 *     字典内的显示名靠 `schema.sql` 的 `teaches_subject_for` 还能兜住（所以不报错），
 *     字典外的显示名从此失去判据，而且**不可逆**。
 *
 * ⚠️ 与 `saveTeacher` 上那一列**故意不同**：老师可以在设置页显式不设主学科，
 *    所以 `saveTeacher` 写 `null` 是"清空"这个动作本身。
 *    作业档案**没有**"未设学科"这个状态（`subject` 永远来自字典），
 *    空 code 只能理解为"不知道"，那就什么都别写。
 */
export async function assignmentWriteRow(
  a: Assignment,
  teacherId: string,
): Promise<Record<string, unknown>> {
  const cols = await ensureSubjectCols()
  const row: Record<string, unknown> = { ...assignmentToRow(a, teacherId) }
  if (cols.assignments) {
    const code = asSubjectCode(a.subjectCode)
    if (code) row.subject_code = code
  }
  /*
   * 学期归属（`schema.sql` §28）：**由 `assign_date` 推**，与 §28.8 的 SQL 回填同一条口径。
   * 🔴 只在这一处写这一列 —— 页面与 store 都不许自己算（同一件事两个入口必错一个）。
   * 列不在 / 认不出学期 / 学期表读不到 → **不带这一列**（upsert 只更新载荷里出现过的列，
   * 所以不带 = 保住库里已有的值；带上 null = 把回填好的归属擦掉）。
   */
  const t = await termIdForDate(a.assignDate)
  if (t) row.term_id = t
  return row
}

/**
 * 写作业档案。
 *
 * 🔴 `subject_code` 的**唯一写入点**就是这里（`store.addAssignment` /
 * `store.updateAssignment` 上游是唯一的业务入口，页面里不许写这两个字段；
 * "恢复备份回推云端"走 `assignmentWriteRow`，与这里共用同一条判据）。
 */
export const saveAssignment = async (a: Assignment, teacherId: string) =>
  upsert('assignments', await assignmentWriteRow(a, teacherId))
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
