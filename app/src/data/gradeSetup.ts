/* ============================================================
   开学准备（P6）的**读**：整个年级的班 / 名单 / 选科 / 年级表
   ------------------------------------------------------------
   🔴 为什么另起一个文件、而不是塞进 `data/remote.ts`：
      `remote.ts` 是**快照那一条线**（任一条读失败 = 整份快照作废），
      而开学准备这一页是**新增功能** —— 线上库还没跑 `schema.sql` 第 27 段时，
      它必须**自己降级**（空数据 + 一句"数据库还没跑那一段"），
      **绝不能把快照那条线拖垮**（`ensureExamTables()` / `ensureNoticeTables()` 同一套纪律）。

   🔴 探针纪律（`nav-checks.mjs` 的 D10 会静态抓）：
      一律 `select('*')` —— **不许假设任何列存在**。
      这一类 bug 在这个仓库咬过两次（`subjects` 没有 `id`、`notice_targets` 没有 `id`）。

   ⚠️ 这一页只读**三张表**（`classes` / `students` / `student_subjects`）+ 一张 `grades`。
      写入一律走服务端 `/api/grade-setup`（`class_subjects` 与 `class_members`
      在数据库层零写权限，而名单导入要的是一个事务）。
   ============================================================ */

import { getSupabase, isRemote } from '../lib/supabase'
import { compareRoster } from '../lib/roster'
import { classTypeOf, isAdminClass } from '../lib/pick'
import { loadClassMembers } from './remote'
import type { ClassType, Klass, Student } from './types'
import type { StudentSubject } from '../lib/pick'

/** 探测结论：三态（"没结论"必须是灰，绝不红 —— §三.4 的硬不变量） */
export type GradeSetupState = 'present' | 'missing' | 'unknown'

/** 一个年级（`grades` 的一行） */
export type GradeRow = {
  id: string
  name: string
  /** 届 = 入校年份（4 位）；老库读不到就是空串 */
  cohort: string
  /** 1/2/3 = 高一/高二/高三；老库读不到按名字推 */
  stage: number
  /** 学年标签（`grades.year`，老列） */
  year: string
}

export type GradeSetupBundle = {
  state: GradeSetupState
  grade: GradeRow | null
  classes: Klass[]
  /** `studentId` → 选科那一行 */
  subjects: Map<string, StudentSubject>
  /**
   * 名单那一次读的结论；缺省 = `present`。
   * ⚠️ 它与 `state` **不是一回事**：`state: 'present'` + `studentsState: 'missing'`
   *    的意思是"班读到了、名单那一次没读到"。
   */
  studentsState?: GradeSetupState
  /** 选科那一次读的结论；缺省 = `present`。`'missing'` = 线上库还没跑 §27 的选科两张表 */
  subjectsState?: GradeSetupState
}

const EMPTY: GradeSetupBundle = {
  state: 'missing',
  grade: null,
  classes: [],
  subjects: new Map(),
}

/** 认不出的行一律不猜：要么是缺列（老库），要么是脏数据 */
function asStudent(row: Record<string, unknown>): Student {
  return {
    id: String(row.id),
    studentNo: String(row.student_no ?? ''),
    name: String(row.name ?? ''),
    status: row.status === 'left' ? 'left' : 'active',
    serial: row.serial ? String(row.serial) : undefined,
    createdAt: Date.parse(String(row.created_at ?? '')) || 0,
  }
}

function asKlass(row: Record<string, unknown>): Klass {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    grade: String(row.grade ?? ''),
    year: String(row.year ?? ''),
    createdAt: Date.parse(String(row.created_at ?? '')) || 0,
    students: [],
    ...(row.kind === 'stream' ? { kind: 'stream' as const } : {}),
    ...(row.class_type ? { classType: row.class_type as ClassType } : {}),
    ...(row.stream_key ? { streamKey: String(row.stream_key) } : {}),
    ...(row.grade_id ? { gradeId: String(row.grade_id) } : {}),
  }
}

const isMissingError = (code: string, msg: string) =>
  code === '42P01' ||
  code === '42703' ||
  code === 'PGRST204' ||
  code === 'PGRST205' ||
  /does not exist|schema cache/i.test(msg)

/**
 * 把 PostgREST 回来的行**逼成 `Record<string, unknown>[]`**。
 *
 * ⚠️ 为什么要显式写这一步：`supabase-js` 的泛型在"没给表类型"时会把 `data` 推成
 *    `any[] | null`，而本仓库开了 `noImplicitAny` —— 于是 `.map((r) => …)` 里的 `r`
 *    就是一个**隐式 any**（TS7006），`tsc -b` 会红。这不是矫情：
 *    这一页读的每一列都是"线上库可能还没有"的新列，**按 `unknown` 一行一行取键**
 *    正是它该有的写法（直接信 `any` 就会把"列不存在"读成 `undefined` 而悄悄放过）。
 */
const rowsOf = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? (data as Record<string, unknown>[]) : []

/** 年级表的三个阶段值：`cohort` / `stage` 是 §27.1 加的列，老库读不到 → 按名字推 */
function asGrade(row: Record<string, unknown>): GradeRow {
  const name = String(row.name ?? '')
  const stage =
    Number(row.stage) === 1 || Number(row.stage) === 2 || Number(row.stage) === 3
      ? Number(row.stage)
      : name === '高二'
        ? 2
        : name === '高三'
          ? 3
          : 1
  return {
    id: String(row.id),
    name,
    cohort: String(row.cohort ?? ''),
    stage,
    year: String(row.year ?? ''),
  }
}

/** 全年级的年级表（下拉用）。读不到就回空数组 —— 页面会显示"还没有年级"。 */
export async function loadGrades(): Promise<{ state: GradeSetupState; grades: GradeRow[] }> {
  const sb = getSupabase()
  if (!isRemote || !sb) return { state: 'missing', grades: [] }
  try {
    const { data, error } = await sb.from('grades').select('*').order('created_at')
    if (error) {
      return {
        state: isMissingError(String((error as { code?: string }).code ?? ''), String(error.message ?? ''))
          ? 'missing'
          : 'unknown',
        grades: [],
      }
    }
    return { state: 'present', grades: rowsOf(data).map(asGrade) }
  } catch {
    /* 断网 → **灰**（unknown），绝不能报成"这个年级不存在" */
    return { state: 'unknown', grades: [] }
  }
}

/**
 * 读一个年级的**开学准备**全量：班 + 名单 + 选科。
 *
 * 🔴 三张表**各自探各自的**，结论也各自记 —— 不许把它们揉成一个状态：
 *    · `classes` 读不到 → 整页没内容（`state: 'missing'`，页面提示去跑 §27）；
 *    · `students` 读不到 → 班还在、名单空（**"还没录名单"与"读不到名单"是两件事**）；
 *    · `student_subjects` 读不到（§27 之前的库）→ 班与名单照常显示，只是选科那一步
 *      显示"还没采集" —— 老库上这一页必须能用，这是兼容期的硬要求。
 *    断网一律 `'unknown'`（**灰**，绝不报成"没有数据"）。
 */
export async function loadGradeSetup(gradeId: string): Promise<GradeSetupBundle> {
  const sb = getSupabase()
  if (!isRemote || !sb) return EMPTY

  try {
    const g = await sb.from('grades').select('*').eq('id', gradeId).limit(1)
    if (g.error) {
      const code = String((g.error as { code?: string }).code ?? '')
      return { ...EMPTY, state: isMissingError(code, String(g.error.message ?? '')) ? 'missing' : 'unknown' }
    }
    if (!g.data?.[0]) return { ...EMPTY, state: 'present' }

    const c = await sb.from('classes').select('*').eq('grade_id', gradeId).order('created_at')
    if (c.error) {
      const code = String((c.error as { code?: string }).code ?? '')
      return {
        ...EMPTY,
        state: isMissingError(code, String(c.error.message ?? '')) ? 'missing' : 'unknown',
      }
    }
    /*
     * 🔴 **只要行政班**（P5 的统一模型：走班班也是 `classes` 的一行）。
     * 这一页的四步（建班 / 设班型 / 采选科 / 指派身份）**每一步都只对行政班有意义**：
     *   · `class_type` 对走班班恒为 `''`（§2.10）；
     *   · 名单是 `students.class_id`（走班班的人来自 `class_members`，多对多）；
     *   · "按班型一键默认选科"按班型走 —— 走班班没有班型。
     * 不加这一句的后果是**静默错**：走班班会混进"建班"那一步的表格里，
     * 而它的名单永远读出来是空的（学生不在 `class_id` 上），看起来像"这个班还没录名单"。
     */
    const classes = rowsOf(c.data).map(asKlass).filter(isAdminClass)
    const ids = classes.map((k) => k.id)

    /* 名单：单独一个结论 —— "班在但名单读不到"与"班在、名单确实是空"要分得开 */
    let studentsState: GradeSetupState = 'present'
    if (ids.length) {
      const s = await sb.from('students').select('*').in('class_id', ids)
      if (s.error) {
        const code = String((s.error as { code?: string }).code ?? '')
        studentsState = isMissingError(code, String(s.error.message ?? '')) ? 'missing' : 'unknown'
      } else {
        const by = new Map<string, Student[]>()
        for (const row of rowsOf(s.data)) {
          const st = asStudent(row)
          const key = String(row.class_id ?? '')
          const list = by.get(key) ?? []
          list.push(st)
          by.set(key, list)
        }
        for (const k of classes) k.students = (by.get(k.id) ?? []).sort(compareRoster)
      }
    }

    /* 选科：另一份结论（`student_subjects` 是 §27 才有的表，老库上它不在） */
    let subjectsState: GradeSetupState = 'present'
    const subjects = new Map<string, StudentSubject>()
    if (ids.length) {
      const ss = await sb.from('student_subjects').select('*')
      if (ss.error) {
        const code = String((ss.error as { code?: string }).code ?? '')
        const msg = String(ss.error.message ?? '')
        subjectsState = isMissingError(code, msg) ? 'missing' : 'unknown'
      } else {
        for (const r of rowsOf(ss.data)) {
          subjects.set(String(r.student_id), {
            studentId: String(r.student_id),
            primaryCode: String(r.primary_code ?? ''),
            secondCodes: Array.isArray(r.second_codes) ? (r.second_codes as string[]).map(String) : [],
            kind: r.kind === 'other' ? 'other' : 'standard',
            note: String(r.note ?? ''),
            updatedAt: Date.parse(String(r.updated_at ?? '')) || undefined,
          })
        }
      }
    }

    return {
      state: 'present',
      grade: asGrade(rowsOf(g.data)[0] ?? {}),
      classes,
      subjects,
      ...(studentsState !== 'present' ? { studentsState } : {}),
      ...(subjectsState !== 'present' ? { subjectsState } : {}),
    }
  } catch {
    return { ...EMPTY, state: 'unknown' }
  }
}

/** 班的班型（给列表那一步显示"完成度"用；与 `classTypeOf()` 同一口径） */
export const gradeClassType = (k: Klass): ClassType => classTypeOf(k)

/* ============================================================
   🆕 P7：走班班那一段（生成预览 / 分配老师 / 课表冲突都要读它）
   ------------------------------------------------------------
   🔴 三条纪律与 `loadGradeSetup()` 同款：
     · **走班班是 `classes` 里 `kind='stream'` 的行**（不是另一张表）；
       行政班那一段由 `loadGradeSetup()` 读（它只认行政班，见那里的注释）；
     · 成员（`class_members`，多对多）与任教关系（`class_subjects`）**各自探各自的**：
       老库上没有 `class_members` → 返回 `null`（"不知道"），**不回空对象**；
     · 断网 / 读不到 → `state: 'unknown'`（**灰**，绝不是"这个年级没有走班班"）。
   ============================================================ */

export type StreamBundle = {
  state: GradeSetupState
  /** 这一届的走班班（**按 `stream_key` 排序**，顺序稳定） */
  classes: Klass[]
  /** `classId → 学生 id[]`；**多对多**（差 2 门的学生出现在两个班的值里） */
  members: Record<string, string[]>
  /** `classId → 学生 id[]` 读到了没有（`false` = 老库没有那张表，不是"没人"） */
  membersKnown: boolean
}

const EMPTY_STREAM: StreamBundle = { state: 'missing', classes: [], members: {}, membersKnown: false }

/**
 * 读一个年级的走班班 + 成员。
 *
 * ⚠️ **只读三张表**（`classes` / `class_members` / 姓名用的 `students`），
 *    而且**不进 `loadSnapshot()`** —— 老库没有 `class_members` 时这一页照样要能用。
 */
export async function loadStreams(gradeId: string): Promise<StreamBundle> {
  const sb = getSupabase()
  if (!isRemote || !sb) return EMPTY_STREAM
  try {
    const c = await sb
      .from('classes')
      .select('*')
      .eq('grade_id', gradeId)
      .eq('kind', 'stream')
      .order('created_at')
    if (c.error) {
      const code = String((c.error as { code?: string }).code ?? '')
      return {
        ...EMPTY_STREAM,
        state: isMissingError(code, String(c.error.message ?? '')) ? 'missing' : 'unknown',
      }
    }
    const classes = rowsOf(c.data)
      .map(asKlass)
      .filter((k) => k.kind === 'stream')
      .sort((a, b) => (a.streamKey ?? '').localeCompare(b.streamKey ?? '') || a.name.localeCompare(b.name))

    const ids = classes.map((k) => k.id)
    const members: Record<string, string[]> = {}
    let membersKnown = false
    if (ids.length) {
      const raw = await loadClassMembers(ids)
      if (raw) {
        membersKnown = true
        for (const [k, v] of Object.entries(raw)) members[k] = v
      }
    }
    return { state: 'present', classes, members, membersKnown }
  } catch {
    return { ...EMPTY_STREAM, state: 'unknown' }
  }
}
