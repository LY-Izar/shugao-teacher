import type { ScheduleItem } from '../data/types'
import { maybeShift, toMinutes } from '../lib/schedule'

export type TempDayCell = { subject: string; teacherId: string | null; end: string }

const overrideKey = (classId: string, date: string) => `shugao.classroom.weekOverride.${classId}.${date}`

/** 调休日在主屏选用的星期也要供独立弹出的插件窗口读取。 */
export function readTodayWeekOverride(classId: string, date: string): number | null {
  try {
    const saved = localStorage.getItem(overrideKey(classId, date))
    if (saved === null) return null
    const n = Number(saved)
    return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null
  } catch {
    return null
  }
}

export function saveTodayWeekOverride(classId: string, date: string, weekday: number | null): void {
  try {
    if (weekday === null) localStorage.removeItem(overrideKey(classId, date))
    else localStorage.setItem(overrideKey(classId, date), String(weekday))
  } catch {
    /* 浏览器禁用本地存储时，主屏仍可在本次会话内切换。 */
  }
}

/** 主屏和插件资源共用的「今天实际上什么课」计算。 */
export function resolveTodaySchedule(
  schedule: ScheduleItem[],
  classId: string,
  className: string,
  useWeekday: number,
  nowWeekday: number,
  tempOfDay: Record<string, TempDayCell>,
) {
  const raw = schedule.filter(
    (s) => s.scope === 'class' && s.classId === classId && s.weekday === useWeekday,
  )
  const used = new Set<string>()
  const merged: ScheduleItem[] = []
  const adjustedIds = new Set<string>()
  for (const it of raw) {
    const t = tempOfDay[it.start]
    if (!t || used.has(it.start)) {
      merged.push(it)
      continue
    }
    used.add(it.start)
    if (!t.subject) continue
    adjustedIds.add(it.id)
    merged.push({ ...it, title: `${className} ${t.subject}`.trim(), teacherId: t.teacherId ?? undefined })
  }
  for (const [start, t] of Object.entries(tempOfDay)) {
    if (!t.subject || used.has(start)) continue
    const id = `temp-${start}`
    adjustedIds.add(id)
    merged.push({
      id,
      weekday: useWeekday,
      start,
      end: t.end,
      title: `${className} ${t.subject}`.trim(),
      kind: 'class',
      notify: false,
      scope: 'class',
      classId,
      teacherId: t.teacherId ?? undefined,
    })
  }
  merged.sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  return { dayItems: maybeShift(merged, nowWeekday), adjustedIds }
}
