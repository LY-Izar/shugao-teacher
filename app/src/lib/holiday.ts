import { HOLIDAY_PLANS, type HolidaySpan, type YearPlan } from '../data/holidays'

/* ============================================================
   节假日 / 调休 判定
   全部按**北京时间**算 —— 不依赖设备时区。
   ============================================================ */

const BJ_OFFSET_MIN = 8 * 60
const DAY_MS = 86400000

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 返回一个 Date，其「本地字段」（getFullYear / getHours …）
 * 就是北京时间的字段。之后所有日期比较都用它。
 */
export function beijingNow(base = new Date()): Date {
  return new Date(base.getTime() + base.getTimezoneOffset() * 60000 + BJ_OFFSET_MIN * 60000)
}

export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 用 UTC 做日期加减，避开夏令时之类的地方性时区规则 */
function toUTCms(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, (m || 1) - 1, d || 1)
}

export function addDays(iso: string, n: number): string {
  const d = new Date(toUTCms(iso) + n * DAY_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** b 比 a 晚多少天 */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUTCms(b) - toUTCms(a)) / DAY_MS)
}

/** 0 = 周日 */
export function weekdayOfISO(iso: string): number {
  return new Date(toUTCms(iso)).getUTCDay()
}

export function yearOf(iso: string): number {
  return Number(iso.slice(0, 4))
}

/* ---------------- 查表 ---------------- */

export function planOf(iso: string): YearPlan | null {
  return HOLIDAY_PLANS.find((p) => p.year === yearOf(iso)) ?? null
}

export function holidayOn(iso: string): HolidaySpan | null {
  const plan = planOf(iso)
  if (!plan) return null
  return plan.holidays.find((h) => iso >= h.start && iso <= h.end) ?? null
}

export type DayKind = 'holiday' | 'makeup' | 'weekend' | 'workday'

/**
 * 这一天的性质。
 * makeup（调休上班）刻意单独成一类 —— 它虽然落在周末，但要按工作日对待。
 */
export function dayKind(iso: string): DayKind {
  if (holidayOn(iso)) return 'holiday'
  const plan = planOf(iso)
  if (plan?.workdays.includes(iso)) return 'makeup'
  const wd = weekdayOfISO(iso)
  return wd === 0 || wd === 6 ? 'weekend' : 'workday'
}

export function isRestDay(iso: string): boolean {
  const k = dayKind(iso)
  return k === 'holiday' || k === 'weekend'
}

/* ---------------- 最近的假期 ---------------- */

export type UpcomingHoliday = {
  span: HolidaySpan
  /** 还有多少天开始（>=1） */
  daysLeft: number
}

export function nextHoliday(fromIso: string): UpcomingHoliday | null {
  let best: UpcomingHoliday | null = null
  for (const plan of HOLIDAY_PLANS) {
    for (const h of plan.holidays) {
      if (h.start <= fromIso) continue
      const daysLeft = daysBetween(fromIso, h.start)
      if (!best || daysLeft < best.daysLeft) best = { span: h, daysLeft }
    }
  }
  return best
}

/** 假期倒计时的口径：太远就不提，免得变成噪音 */
export const COUNTDOWN_NEAR = 30
/** 只剩这么几天时，连"今天完成了"的收尾也换成倒计时 */
export const COUNTDOWN_SOON = 3

export function countdownText(fromIso: string, maxDays = COUNTDOWN_NEAR): string | null {
  const next = nextHoliday(fromIso)
  if (!next || next.daysLeft > maxDays) return null
  return `还有 ${next.daysLeft} 天到${next.span.name}，再坚持一下下。`
}

/* ---------------- 节日祝福 ---------------- */

/** 清明说"快乐"不合礼数，单独处理 */
export function holidayWish(
  name: string,
  teacherName: string,
): { title: string; sub: string } {
  const sub = '假期要记得好好休息噢。'
  if (name === '清明节') return { title: `祝${teacherName}老师清明安康！`, sub }
  return { title: `祝${teacherName}老师${name}快乐！`, sub }
}

/*
 * 这里原来有 `holidayDataInfo()`（返回覆盖年份 / 最近一份通知的文号 / coversThisYear），
 * 只为「我的 → 节假日与调休」那块展示面板服务；面板 2026-09 整块删掉后它没有调用方，
 * 随之删除。
 *
 * ⚠️ 删的只是"数据来源说明"：上面的判定函数（`isRestDay` / `dayKind` / `holidayOn` /
 *    `nextHoliday` / `countdownText` / `holidayWish`）与 `data/holidays.ts` 的数据
 *    **一处都没动** —— 教室端「今天放假」「下课铃」、周一顺延、节假日氛围都还在用。
 */
