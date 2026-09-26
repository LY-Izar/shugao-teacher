import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../data/store'
import { loadClassSubjects } from '../data/remote'
import { isMyTodo, type TeachingRow } from '../lib/teaching'
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
  const classes = useStore((s) => s.classes)
  const teacherId = useStore((s) => s.teacher?.id)
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

  const day = useMemo(
    // 只看教师自己的排课表；班级课表是给教室端展示的，不该混进「今天的日程」
    () => dayState(schedule.filter((s) => s.scope !== 'class'), now),
    [schedule, now],
  )

  /*
   * 我的任教关系（`class_subjects`）—— 与 `Workbench.tsx` **同一处读法、同一个判据**：
   *   · 读不到回 `null`（"不知道"）→ `isMyTodo()` **不筛**（宁多不藏）；
   *   · 一个班都没有（换过账号 / 清空过）→ 上一次的结论一并作废，退回"不知道"。
   */
  const [teachingRows, setTeachingRows] = useState<TeachingRow[] | null>(null)
  useEffect(() => {
    let alive = true
    const ids = classes.map((c) => c.id)
    if (ids.length) {
      void loadClassSubjects(ids).then((r) => {
        if (alive) setTeachingRows(r)
      })
    }
    return () => {
      alive = false
    }
  }, [classes])
  const relations: TeachingRow[] | null = classes.length ? teachingRows : null

  const pending = useMemo(
    /*
     * 🔴 **弹窗这一处的口径**（2026-10-07 F3 修的是它的**另一半**）：
     *
     *   ① **任教关系那一半**（这一轮修的）：复用 `lib/teaching.ts` 的 `isMyTodo()` ——
     *      班主任早上一打开，欢迎弹窗「今天要批的作业」里原来会列出**数学**
     *      （他不上这一科；点进去是「改成绩只给任课老师」那一页 = 改不了的死路）。
     *      ⚠️ **不另写一份** `(班, 科)` 判断：工作台那一屏走的是同一个函数。
     *   ② **状态那一半**：这里是「**今天要批的作业**」→ 只要 **`collected`（待批改）**。
     *      ⚠️ 别用 `pendingForMe()` 的**整体**结果：它按「今日待办」的口径把 `open`
     *      （待收缴）也算进去 —— 那是**工作台「今日待办」列表**的口径（那边照旧），
     *      但"待收缴"的作业还没收上来，**没有东西可批**，列进「今天要批的作业」是错的。
     *      （实测过：拿 `pendingForMe()` 的整体结果顶在这里，会让演示数据里那两份
     *      `open` 的作业混进弹窗，而且"今日完成"再也到不了 —— `shots` S46 当场红。）
     *
     * ⚠️ **三态照旧**（`isMyTodo()` 里写清了）：任教关系 `null` = **不知道**
     *    （还没读回来 / 读失败 / 本地演示模式没有数据库）→ **不筛**（宁多不藏）。
     */
    () =>
      assignments.filter((a) => a.status === 'collected' && isMyTodo(a, relations, teacherId)),
    [assignments, relations, teacherId],
  )

  const mood: DayMood = dayMood(now, {
    dateStr,
    allScheduleEnded: day.allEnded,
    hasMoreToday: day.hasMore,
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
