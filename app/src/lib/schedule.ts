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
