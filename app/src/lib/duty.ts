/* ============================================================
   值日生轮值 —— **纯函数**，教室端与教师端共用同一份
   ------------------------------------------------------------
   用户口径（2026-10-02，逐条问过）：
     · **每天 1 人**；池＝这个班**在读**学生，按**学号升序**；
     · 班主任指定某一天的人 → 从那个人**接着往下轮**；
     · **只在上课日轮**（周末 / 法定假期 / 学校自己的放假一律跳过，
       调休上班的那种周末算上课日）。
     · 提醒时机是**每节课下课**（不是放学）—— 那件事在教室端做，与这里无关。

   🔴 为什么算法在前端而不在 SQL：库里 `duty_assignments` **只存"被明确指定过的那天"**
      （锚点），其余日期是**推**出来的。推的规则必须**一处实现**——
      教室端要显示今天、教师端要预览未来 7 天、导出图片要用同一天，
      三处要是各写一遍，迟早有一天对不上。放在这里，两边 import 同一份；
      数据库仍然是判据（谁**能**指定由 RLS 定），但"是谁"由这个纯函数算。

   🔴 没有锚点时从哪天起算：**建班那天**（`classes.created_at`），第一个人 = 池里第一个。
      —— 为什么不从"今天"起算：那样昨天的答案明天会变（今天的偏移天天在动），
         同一天的两次查询可能给出两个人；用一个**绝对的**日子当基准才稳定。
      —— 为什么不从"本学期第一天"起算：那要读学期表、还要处理"学期中途转学"，
         收益只是"编号看起来更整齐"；建班日是绝对且每班自带的。
      ⚠️ 所以池子**中途变人**（转学 / 插班 / 改学号）会让轮值顺序整体挪位 ——
         这是"按学号轮"的固有性质（用户口径就是按学号），不是 bug；
         真遇到要钉死的那几天，班主任指定一次就是锚点。
   ============================================================ */

import { addDays, beijingNow, dayKind, daysBetween, ymdOf } from './holiday'
import type { Student } from '../data/types'

/** 校历覆盖：学校自己改过的那些天（`school_calendar` 一行） */
export type CalendarOverride = {
  onDate: string
  /** `school` = 上课（哪怕本来是假期/周末）；`off` = 放假（哪怕本来是工作日） */
  kind: 'school' | 'off'
}

/** 库里的一个锚点：这一天**明确**指定了谁（`duty_assignments` 一行） */
export type DutyAnchor = {
  onDate: string
  studentId: string
}

export type DutyInput = {
  students: readonly Student[]
  anchors: readonly DutyAnchor[]
  /** 校历覆盖层；缺省 = 全按官方节假日 + 周末判 */
  overrides?: readonly CalendarOverride[]
  /** 没有锚点时的基准日（传建班日 `classes.created_at`） */
  since: string
}

export type DutyResult = {
  date: string
  studentId: string
  name: string
  studentNo: string
  /** `set` = 老师明确指定过这一天；`auto` = 按轮值推出来的 */
  source: 'set' | 'auto'
}

/* ---------------- 池 ---------------- */

const digits = (s: string) => s.replace(/\D/g, '')

/**
 * 学号排序：**先数值、再文本**。
 *  `student_no` 是 text（"01" / "1" / "12" 都可能），按字符串比会得到
 *  "1, 10, 11, 2" 这种顺序 —— 按数值比才是师生眼里的学号顺序。
 *  ⚠️ 认不出数字的（空串 / "转1"）**排在最后**，彼此按学号文本比 —— 不猜它排第几。
 */
export function compareStudentNo(a: string, b: string): number {
  const da = digits(a)
  const db = digits(b)
  const na = da === '' ? null : Number(da)
  const nb = db === '' ? null : Number(db)
  if (na !== null && nb !== null) return na === nb ? a.localeCompare(b) : na - nb
  if (na !== null) return -1
  if (nb !== null) return 1
  return a.localeCompare(b)
}

/** 值日生池：这个班**在读**的学生，按学号升序。`status` 认不出时当作在读（兼容老库）。 */
export function dutyPool(students: readonly Student[]): Student[] {
  return students
    .filter((s) => s.status !== 'left')
    .slice()
    .sort((a, b) => compareStudentNo(a.studentNo, b.studentNo))
}

/* ---------------- 上课日 ---------------- */

/** 校历覆盖层摊平成查表用的 Map（值日生与"今天放不放假"共用同一口径） */
export function calendarMap(overrides: readonly CalendarOverride[] = []): Map<string, 'school' | 'off'> {
  const m = new Map<string, 'school' | 'off'>()
  for (const o of overrides) m.set(o.onDate, o.kind)
  return m
}

/**
 * 这一天是不是**上课日**。
 *  ① 学校自己改过 → 按学校说的（`off` 放假 / `school` 上课）；
 *  ② 否则按官方节假日表 + 周末（`lib/holiday.ts` 的 `dayKind()`，
 *     `makeup`（调休上班）算上课日，`holiday` / `weekend` 不算）。
 */
export function isSchoolDay(iso: string, cal: Map<string, 'school' | 'off'> = new Map()): boolean {
  const ov = cal.get(iso)
  if (ov === 'school') return true
  if (ov === 'off') return false
  const k = dayKind(iso)
  return k === 'workday' || k === 'makeup'
}

/**
 * `(from, to]` 之间有多少个上课日（**不含 from 那一天**）。
 * 轮值的偏移量就是它：锚点那天是第 0 步，下一个上课日才是第 1 步。
 * `to` 早于 `from` 时返回负数 —— 班主任指定的是**未来**某天时，
 * 今天要往回推（"他前面那个人"）。
 * ⚠️ 逐个日子走。跨度是"建班日 → 今天"这种量级（几百天），
 *    一次预览 7 天 = 几千次循环，比建索引便宜得多。
 */
export function schoolDaysBetween(
  from: string,
  to: string,
  cal: Map<string, 'school' | 'off'> = new Map(),
): number {
  const diff = daysBetween(from, to)
  if (diff === 0) return 0
  const step = diff > 0 ? 1 : -1
  let n = 0
  for (let i = step; step > 0 ? i <= diff : i >= diff; i += step) {
    if (isSchoolDay(addDays(from, i), cal)) n += step
  }
  return n
}

/* ---------------- 轮值 ---------------- */

/**
 * 这一天该谁值日。
 *
 * 规则（一份，读三遍就懂）：
 *   ① 这一天**有锚点** → 就是那个人（老师指定压过轮值）；
 *   ② 否则找**这一天之前（含）最近的一个锚点**当基准 —— 没有就找**之后最近**的一个
 *      （班主任只指定了未来某天时，今天要往回数），再没有就用 `since` + 池里第一个人；
 *   ③ 从上一步那个人的位置往前走 `schoolDaysBetween(基准日, 这一天)` 步，
 *      在池里**环形**取模。
 *
 * ⚠️ 锚点指向的人**已经不在池里**（转学 / 删除）时，这个锚点整条不算数
 *    （不能拿一个查不到的人当基准）—— 退回到再前一个锚点，或 `since`。
 */
export function dutyForDate(target: string, input: DutyInput): DutyResult | null {
  const pool = dutyPool(input.students)
  if (pool.length === 0) return null
  const cal = calendarMap(input.overrides)
  const at = (i: number): DutyResult => ({
    date: target,
    studentId: pool[i].id,
    name: pool[i].name,
    studentNo: pool[i].studentNo,
    source: 'auto',
  })
  const indexOf = (id: string) => pool.findIndex((s) => s.id === id)

  const explicit = input.anchors.find((a) => a.onDate === target)
  if (explicit) {
    const i = indexOf(explicit.studentId)
    if (i >= 0) return { ...at(i), source: 'set' }
  }

  const usable = input.anchors
    .filter((a) => indexOf(a.studentId) >= 0)
    .slice()
    .sort((a, b) => a.onDate.localeCompare(b.onDate))

  let baseDate = input.since
  let baseId = pool[0].id
  const before = [...usable].reverse().find((a) => a.onDate <= target)
  const after = usable.find((a) => a.onDate > target)
  const base = before ?? after
  if (base) {
    baseDate = base.onDate
    baseId = base.studentId
  }

  const i0 = indexOf(baseId)
  const offset = schoolDaysBetween(baseDate, target, cal)
  const n = pool.length
  const idx = (((i0 + offset) % n) + n) % n
  return at(idx)
}

/**
 * 一段日期里的**上课日**值日生（教师端"未来 7 天预览"、教室端"这周谁值日"都用它）。
 * 休息日**不进结果** —— 那天没有值日生这回事，不是"空着一格"。
 */
export function dutyRoster(fromIso: string, days: number, input: DutyInput): DutyResult[] {
  const cal = calendarMap(input.overrides)
  const out: DutyResult[] = []
  for (let i = 0; i < Math.max(0, days); i += 1) {
    const d = addDays(fromIso, i)
    if (!isSchoolDay(d, cal)) continue
    const r = dutyForDate(d, input)
    if (r) out.push(r)
  }
  return out
}

/** 今天（北京时间）的值日生 —— 教室端那一行与课间浮标用 */
export function dutyToday(input: DutyInput): DutyResult | null {
  const today = ymdOf(beijingNow())
  if (!isSchoolDay(today, calendarMap(input.overrides))) return null
  return dutyForDate(today, input)
}

/**
 * 锚点日往后找**下一个上课日**（教室端"明天谁值日"那种提示用）。
 * ⚠️ 放假那天不显示值日生：`null` 不是错误，是"今天不该有人值日"。
 */
export function dutyAtNextSchoolDay(fromIso: string, input: DutyInput): DutyResult | null {
  const cal = calendarMap(input.overrides)
  for (let i = 1; i <= 30; i += 1) {
    const d = addDays(fromIso, i)
    if (isSchoolDay(d, cal)) return dutyForDate(d, input)
  }
  return null
}
