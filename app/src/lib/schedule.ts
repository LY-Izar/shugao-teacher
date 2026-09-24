import type { ScheduleItem } from '../data/types'

/* ---------------- 时间工具 ---------------- */

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function nowMinutes(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** JS 的 getDay()：0=周日。课表用 1=周一 … 7=周日 */
export function weekdayOf(d = new Date()): number {
  const g = d.getDay()
  return g === 0 ? 7 : g
}

export function itemsOfDay(schedule: ScheduleItem[], weekday: number): ScheduleItem[] {
  return schedule
    .filter((s) => s.weekday === weekday)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
}

export function itemsForDate(schedule: ScheduleItem[], d = new Date()): ScheduleItem[] {
  return itemsOfDay(schedule, weekdayOf(d))
}

/* ---------------- 今日状态 ---------------- */

export type DayState = {
  items: ScheduleItem[]
  has: boolean
  /** 今天所有日程都已结束 */
  allEnded: boolean
  /**
   * 今天**还有课没上完**（有日程，且至少有一条还没结束）。
   *
   * 和 `allEnded` 的区别在"今天没有日程"这种情形：
   *   · 没有日程 → allEnded=false、hasMore=false
   *   · 有日程没上完 → allEnded=false、hasMore=true
   * 「今天工作全部完成」的判定必须看 hasMore，否则晚上还有课也会被报成已完成。
   */
  hasMore: boolean
  current: ScheduleItem | null
  next: ScheduleItem | null
  /** 距离下一节课还有多少分钟 */
  minutesToNext: number | null
}

export function dayState(schedule: ScheduleItem[], d = new Date()): DayState {
  const items = itemsForDate(schedule, d)
  const m = nowMinutes(d)
  let current: ScheduleItem | null = null
  let next: ScheduleItem | null = null
  let minutesToNext: number | null = null

  for (const it of items) {
    const s = toMinutes(it.start)
    const e = toMinutes(it.end)
    if (m >= s && m < e) current = it
    if (s > m && !next) {
      next = it
      minutesToNext = s - m
    }
  }

  return {
    items,
    has: items.length > 0,
    allEnded: items.length > 0 && items.every((it) => toMinutes(it.end) <= m),
    hasMore: items.length > 0 && items.some((it) => toMinutes(it.end) > m),
    current,
    next,
    minutesToNext,
  }
}

/** 「上课前 10 分钟」的判定窗口：落在 9–11 分钟内就提醒，避免定时器抖动漏掉 */
export const REMIND_BEFORE = 10

export function dueReminders(schedule: ScheduleItem[], d = new Date()): ScheduleItem[] {
  const m = nowMinutes(d)
  return itemsForDate(schedule, d).filter((it) => {
    if (!it.notify) return false
    const diff = toMinutes(it.start) - m
    return diff >= REMIND_BEFORE - 1 && diff <= REMIND_BEFORE + 1
  })
}

export function normalizeTime(v: string, fallback: string): string {
  return /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim().padStart(5, '0') : fallback
}

export function durationText(start: string, end: string): string {
  const d = toMinutes(end) - toMinutes(start)
  return d > 0 ? `${d} 分钟` : '时间有误'
}

/* ---------------- 周一前三节顺延 ---------------- */

/**
 * 周一早上第 1–3 节整体顺延（校会 / 升旗占用）。
 * 只动这三节，其余按学校原表不动 —— 这是学校明确的规矩。
 */
export const MONDAY_SHIFT = { weekday: 1, count: 3, minutes: 20 }

const pad2 = (n: number) => String(n).padStart(2, '0')
const fromMin = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`

/**
 * 应用顺延。
 *
 * 会返回 conflicts：如果顺延后出现**上一节还没下课、下一节已经开始**，
 * 就把冲突原样交出来让界面提示。宁可让教师看见冲突，
 * 也不能在教室大屏上显示一份物理上不可能的课表。
 */
export function applyMondayShift(items: ScheduleItem[]): {
  items: ScheduleItem[]
  shifted: number
  conflicts: string[]
} {
  const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  if (sorted.length === 0) return { items, shifted: 0, conflicts: [] }

  const out = sorted.map((it, i) => {
    if (i >= MONDAY_SHIFT.count) return it
    const s = toMinutes(it.start) + MONDAY_SHIFT.minutes
    const e = toMinutes(it.end) + MONDAY_SHIFT.minutes
    return { ...it, start: fromMin(s), end: fromMin(e) }
  })

  const conflicts: string[] = []
  for (let i = 1; i < out.length; i++) {
    if (toMinutes(out[i].start) < toMinutes(out[i - 1].end)) {
      conflicts.push(
        `第 ${i + 1} 节 ${out[i].start} 开始，但第 ${i} 节 ${out[i - 1].end} 才下课 —— 时间重叠`,
      )
    }
  }
  return { items: out, shifted: Math.min(MONDAY_SHIFT.count, sorted.length), conflicts }
}

export function maybeShift(
  items: ScheduleItem[],
  weekday: number,
): { items: ScheduleItem[]; shifted: number; conflicts: string[] } {
  if (weekday !== MONDAY_SHIFT.weekday) return { items, shifted: 0, conflicts: [] }
  return applyMondayShift(items)
}

/**
 * 某一天、某个班要展示的课表（含周一顺延）。
 * 教室端和教师端走同一处逻辑，免得两边算出两套时间。
 */
export function displayItemsForDate(
  schedule: ScheduleItem[],
  opts: { weekday: number; classId?: string; scope?: 'mine' | 'class' },
): { items: ScheduleItem[]; shifted: number; conflicts: string[] } {
  const base = schedule.filter(
    (s) => s.weekday === opts.weekday && (!opts.scope || (s.scope ?? 'mine') === opts.scope),
  )
  const list = opts.classId ? base.filter((s) => s.classId === opts.classId) : base
  return maybeShift(list, opts.weekday)
}

/**
 * 「还有多久」的口语说法。
 * 隔得远的时候说「190 分后」没人会在脑子里换算，所以超过 90 分钟改用小时。
 */
export function awayText(minutes: number): string {
  if (minutes <= 0) return '马上'
  if (minutes < 90) return `${minutes} 分后`
  const h = Math.round(minutes / 60)
  return h >= 24 ? `${Math.round(minutes / 1440)} 天后` : `${h} 小时后`
}
