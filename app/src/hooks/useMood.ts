import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../data/store'
import { dayMood, isMorningWindow, pickGreeting, type DayMood } from '../lib/mood'
import {
  COUNTDOWN_NEAR,
  COUNTDOWN_SOON,
  beijingNow,
  countdownText,
  holidayOn,
  holidayWish,
  nextHoliday,
  ymdOf,
} from '../lib/holiday'
import { dayState } from '../lib/schedule'

const WELCOME_KEY = 'shugao.mood.welcomed'
const CELEBRATED_KEY = 'shugao.mood.celebrated'

function readDates(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as string[]) : []
  } catch {
    return []
  }
}

function writeDates(key: string, dates: string[]) {
  try {
    // 只留最近 30 条，别让它在本地无限长
    localStorage.setItem(key, JSON.stringify(dates.slice(-30)))
  } catch {
    /* 忽略 */
  }
}

/**
 * 「今天过得怎么样」的判定，以及两个时刻的弹窗。
 *
 * 时间一律按**北京时间**取（`beijingNow`），不依赖设备时区。
 * 全部用状态推导 + 事件里落盘，不在 effect 里 setState ——
 * 否则每次渲染都可能触发一轮连锁渲染。
 */
export function useMood() {
  const schedule = useStore((s) => s.schedule)
  const assignments = useStore((s) => s.assignments)
  const teacherName = useStore((s) => s.teacher?.name ?? '老师')

  const [now, setNow] = useState(() => beijingNow())
  // 打开平台的那一刻，用于判断「早上第一次打开」——不会因为停留过 9:00 而自己关掉
  const [openedAt] = useState(() => beijingNow())

  const [welcomed, setWelcomed] = useState<string[]>(() => readDates(WELCOME_KEY))
  const [celebrated, setCelebrated] = useState<string[]>(() => readDates(CELEBRATED_KEY))

  // 时间推进：半小时一次足够，跨过 23:00 / 18:00 这类边界时氛围要跟着变
  useEffect(() => {
    const t = window.setInterval(() => setNow(beijingNow()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const dateStr = ymdOf(now)
  const openDateStr = ymdOf(openedAt)

  const day = useMemo(() => dayState(schedule, now), [schedule, now])
  const pending = useMemo(() => assignments.filter((a) => a.status === 'collected'), [assignments])

  const mood: DayMood = dayMood(now, {
    dateStr,
    allScheduleEnded: day.allEnded,
    pending: pending.length,
  })

  const greeting = useMemo(() => pickGreeting(openedAt), [openedAt])

  /** 今天正在放假 */
  const holiday = holidayOn(dateStr)
  /** 假期倒计时（30 天内才提） */
  const countdown = countdownText(dateStr, COUNTDOWN_NEAR)
  /** 只剩几天（用于把「今天完成了」的收尾也换成倒计时） */
  const soon = countdownText(dateStr, COUNTDOWN_SOON)
  const next = nextHoliday(dateStr)
  const festive = holiday ? holidayWish(holiday.name, teacherName) : null

  // 假期期间不弹窗
  const welcomeOpen =
    mood !== 'holiday' && isMorningWindow(openedAt) && !welcomed.includes(openDateStr)
  const doneOpen = mood === 'done' && !celebrated.includes(dateStr)

  const closeWelcome = useCallback(() => {
    setWelcomed((prev) => {
      const nextDates = [...prev, openDateStr]
      writeDates(WELCOME_KEY, nextDates)
      return nextDates
    })
  }, [openDateStr])

  const closeDone = useCallback(() => {
    setCelebrated((prev) => {
      const nextDates = [...prev, ymdOf(beijingNow())]
      writeDates(CELEBRATED_KEY, nextDates)
      return nextDates
    })
  }, [])

  return {
    now,
    dateStr,
    day,
    pending,
    mood,
    greeting,
    holiday,
    festive,
    countdown,
    soonCountdown: soon,
    nextHoliday: next,
    welcomeOpen,
    closeWelcome,
    doneOpen,
    closeDone,
  }
}
