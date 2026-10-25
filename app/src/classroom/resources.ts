/**
 * 插件的**只读资源**（手册 §6.1 那张表）—— 宿主代理读，插件拿不到数据库客户端。
 *
 * ============================================================================
 * 口径
 * ============================================================================
 * · 通常数据源是**本机的 store**（`useStore`）—— 它在远程模式由 `hydrate()` + Realtime
 *   灌着，在演示模式是种子数据。`class.todaySchedule` 是例外：优先取主屏算好的
 *   投影；独立弹窗没有新鲜投影时，沿用主屏的 `schedule_day_cells` 读取与合并函数。
 * · `stale`（手册 §6.4）：远程模式断网时 `true`（这份可能是旧缓存）；演示模式恒
 *   `false` —— 数据就在本机，没有"旧"可言。`read` **任何情况下都不 reject**：
 *   没数据回空形状，读不出来回空形状 + `stale:true`。
 * · `asOf` 一律 `beijingNow()`（§一 时间口径）。
 * · `class.assignments` 的 `dueDate`：本平台的作业档案今天只有**布置日**这一列
 *   （`Assignment.assignDate`），先按它给；手册 §6.1 的字段名是契约、保持不变，
 *   将来平台真出现"截止日"再换数据源（P2 首个用它的插件落地时一起核）。
 */

import { useStore } from '../data/store'
import { dayState, nowMinutes, toMinutes, weekdayOf, type DayState } from '../lib/schedule'
import { splitLessonTitle } from '../lib/scheduleParse'
import { subjectCodeOf, subjectCodeOfName, subjectName } from '../lib/subjects'
import { collectStats } from '../lib/assignments'
import { BAND_META, gradeStats } from '../lib/grading'
import { ranked } from '../lib/wrongbook'
import { loadDailyBundle, toDutyInput, todayDuty } from '../lib/daily'
import { isoOffset } from '../lib/date'
import { beijingNow, dayKind, holidayOn, isRestDay, ymdOf } from '../lib/holiday'
import { pickDailyQuote } from '../lib/quotes'
import { isRemote } from '../lib/supabase'
import type { ResourceName } from '../lib/pluginHost'
import type { ScheduleItem } from '../data/types'
import * as remote from '../data/remote'
import { readTodayWeekOverride, resolveTodaySchedule, type TempDayCell } from './todaySchedule'

export interface ResourceResult {
  value: unknown
  stale: boolean
  asOf: string
}

/** 与教室端旧页同一窗口：往前两周 + 明天（值日生锚点要往前翻才能推出来）。 */
const DAILY_FROM = -14
const DAILY_TO = 1

const noOf = (s: { studentNo: string; serial?: string }): string => s.studentNo || s.serial || ''

type TodayScheduleValue = {
  date: string
  weekday: number
  isMakeup: boolean
  restDay: boolean
  restName: string
  items: Array<{ id: string; start: string; end: string; subject: string; teacherName: string; adjusted: boolean; current: boolean; next: boolean }>
  conflicts: string[]
}

export function todayScheduleValue(input: {
  date: string; weekday: number; isMakeup: boolean; restDay: boolean; restName: string
  day: DayState; adjustedIds: ReadonlySet<string>; conflicts: string[]
}): TodayScheduleValue {
  return {
    date: input.date,
    weekday: input.weekday,
    isMakeup: input.isMakeup,
    restDay: input.restDay,
    restName: input.restName,
    items: input.day.items.map((it) => {
      const parsed = splitLessonTitle(it.title)
      return {
        id: it.id, start: it.start, end: it.end,
        subject: parsed.subject, teacherName: parsed.teacher,
        adjusted: input.adjustedIds.has(it.id),
        current: input.day.current?.id === it.id,
        next: input.day.next?.id === it.id,
      }
    }),
    conflicts: input.conflicts,
  }
}

const TODAY_SNAPSHOT_TTL_MS = 90_000
const snapshotKey = (classId: string) => `shugao.classroom.todaySchedule.${classId}`
const todaySnapshots = new Map<string, { value: TodayScheduleValue; at: number }>()
const resourceListeners = new Set<() => void>()

/** 主屏投影供内嵌插件和同源的独立弹窗读取；弹窗失去主屏心跳后自己重算。 */
export function publishTodaySchedule(classId: string, value: TodayScheduleValue): void {
  const previous = todaySnapshots.get(classId)
  const changed = !previous || JSON.stringify(previous.value) !== JSON.stringify(value)
  if (!changed && Date.now() - previous.at < 30_000) return
  const at = Date.now()
  todaySnapshots.set(classId, { value, at })
  try {
    localStorage.setItem(snapshotKey(classId), JSON.stringify({ value, at }))
  } catch {
    /* 禁用存储时，同页插件仍从内存拿到同一份投影。 */
  }
  if (!changed) return
  for (const cb of resourceListeners) cb()
}

/** 独立弹窗有自己的 JS 上下文，按同一函数重算投影。 */
async function readTodaySchedule(classId: string, className: string): Promise<{ value: TodayScheduleValue; stale: boolean }> {
  const now = beijingNow()
  const date = ymdOf(now)
  let snapshot = todaySnapshots.get(classId)
  if (!snapshot) {
    try {
      snapshot = JSON.parse(localStorage.getItem(snapshotKey(classId)) ?? 'null') ?? undefined
    } catch { /* 没有跨窗口快照就走同源重算。 */ }
  }
  if (snapshot?.value?.date === date && Date.now() - snapshot.at < TODAY_SNAPSHOT_TTL_MS) {
    return { value: snapshot.value, stale: false }
  }
  const weekday = weekdayOf(now)
  const isMakeup = dayKind(date) === 'makeup'
  const override = isMakeup ? readTodayWeekOverride(classId, date) : null
  const useWeekday = override ?? weekday
  const temp: Record<string, TempDayCell> = {}
  let stale = false
  if (isRemote) {
    const result = await remote.loadScheduleDay(date)
    if (result.status === 'present') {
      for (const c of result.cells) {
        if (c.changed && c.classId === classId) {
          temp[c.start] = { subject: c.subject, teacherId: c.teacherId, end: c.end }
        }
      }
    } else stale = true
  } else {
    for (const c of useStore.getState().tempScheduleChanges) {
      if (c.date === date && c.classId === classId) {
        temp[c.start] = { subject: c.toSubject, teacherId: c.toTeacherId ?? null, end: c.end }
      }
    }
  }
  const { dayItems, adjustedIds } = resolveTodaySchedule(
    useStore.getState().schedule, classId, className, useWeekday, weekday, temp,
  )
  const restDay = isRestDay(date)
  return {
    value: todayScheduleValue({
      date, weekday: useWeekday, isMakeup, restDay,
      restName: restDay ? holidayOn(date)?.name ?? '' : '',
      day: dayState(dayItems.items, now, useWeekday), adjustedIds,
      conflicts: dayItems.conflicts,
    }),
    stale,
  }
}

/** 一节课对外的形状（手册 §4.1 的 `Slot`）。`current` 的 minutesLeft 是距**结束**。
 *  导出：壳发 `clock.onLesson` 事件（lessonStart/lessonEnd）用**同一条**换算 ——
 *  两个出口各写一遍，早晚各算出两套时间。 */
export function toSlot(it: ScheduleItem | null, kind: 'current' | 'next', m: number) {
  if (!it) return null
  const t = splitLessonTitle(it.title)
  return {
    subject: t.subject,
    subjectCode: subjectCodeOfName(t.subject) ?? '',
    start: it.start,
    end: it.end,
    minutesLeft: kind === 'current' ? toMinutes(it.end) - m : toMinutes(it.start) - m,
  }
}

export async function readResource(resource: ResourceName, classId: string): Promise<ResourceResult> {
  const asOf = beijingNow().toISOString()
  const stale = isRemote ? !navigator.onLine : false
  const s = useStore.getState()
  const klass = s.classes.find((c) => c.id === classId)
  const activeStudents = () => (klass?.students ?? []).filter((st) => st.status === 'active')

  switch (resource) {
    case 'class.roster':
      return {
        value: { students: activeStudents().map((st) => ({ id: st.id, no: noOf(st), name: st.name })) },
        stale,
        asOf,
      }

    case 'class.schedule': {
      const items = s.schedule.filter((it) => it.scope === 'class' && it.classId === classId)
      return {
        value: {
          items: items.map((it) => {
            const t = splitLessonTitle(it.title)
            return {
              weekday: it.weekday,
              start: it.start,
              end: it.end,
              subject: t.subject,
              subjectCode: subjectCodeOfName(t.subject) ?? '',
              teacherName: t.teacher,
            }
          }),
        },
        stale,
        asOf,
      }
    }

    case 'class.todaySchedule': {
      try {
        const result = await readTodaySchedule(classId, klass?.name ?? '')
        return { value: result.value, stale: stale || result.stale, asOf }
      } catch {
        return { value: { date: ymdOf(beijingNow()), weekday: weekdayOf(beijingNow()), isMakeup: false, restDay: false, restName: '', items: [], conflicts: [] }, stale: true, asOf }
      }
    }

    case 'class.slotNow': {
      const now = beijingNow()
      const wd = weekdayOf(now)
      const raw = s.schedule.filter(
        (it) => it.scope === 'class' && it.classId === classId && it.weekday === wd,
      )
      const d = dayState(raw, now, wd)
      return {
        value: { current: toSlot(d.current, 'current', nowMinutes(now)), next: toSlot(d.next, 'next', nowMinutes(now)) },
        stale,
        asOf,
      }
    }

    case 'class.dailyHomework':
    case 'class.duty': {
      if (!klass) {
        return resource === 'class.duty'
          ? { value: { today: null, roster: [] }, stale, asOf }
          : { value: { rows: [] }, stale, asOf }
      }
      try {
        const b = await loadDailyBundle(classId, isoOffset(DAILY_FROM), isoOffset(DAILY_TO))
        if (resource === 'class.dailyHomework') {
          return {
            value: {
              rows: b.homework.map((h) => ({
                subject: h.subject,
                subjectCode: subjectCodeOf(h) ?? '',
                content: h.content,
                onDate: h.onDate,
                source: h.source,
              })),
            },
            stale,
            asOf,
          }
        }
        const input = toDutyInput({
          students: activeStudents(),
          anchors: b.anchors,
          calendar: b.calendar,
          classCreatedAt: klass.createdAt,
        })
        const t = todayDuty(input)
        return {
          value: {
            today: t ? { no: t.studentNo, name: t.name } : null,
            roster: activeStudents().map((st) => ({ no: noOf(st), name: st.name })),
          },
          stale,
          asOf,
        }
      } catch {
        // 读不出来按"旧缓存里的空"处理，**不 reject**（手册 §6.4：没数据不是错误）
        return resource === 'class.duty'
          ? { value: { today: null, roster: [] }, stale: true, asOf }
          : { value: { rows: [] }, stale: true, asOf }
      }
    }

    case 'class.assignments': {
      const rows = s.assignments
        .filter((a) => a.classId === classId && ranked(a))
        .map((a) => {
          const cs = collectStats(klass?.students ?? [], a)
          return {
            title: a.title,
            subject: subjectName(subjectCodeOf(a), a.subject),
            dueDate: a.assignDate,
            submitted: cs.submitted,
            total: cs.total,
          }
        })
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 首批搬运（考试板插件）：与旧教室端 `classExams` 同一条筛选与排序 ——
     * `classIds` 含本班的最近 6 场、按日期倒序。教室端对 exams 是**零写**
     * （§15.3），这里纯读 store（远程模式由 hydrateExams 灌着）。
     * 没有考试 ⇒ 回空数组：那是"没排考试"，不是错误（§6.4）。
     */
    case 'class.exams': {
      const rows = s.exams
        .filter((e) => (e.classIds ?? []).includes(classId))
        .sort((a, b) => (a.examDate < b.examDate ? 1 : -1))
        .slice(0, 6)
        .map((e) => ({
          examDate: e.examDate,
          subject: e.subject || e.title,
          status: e.status === 'graded' ? 'graded' : 'pending',
        }))
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 收尾（讲评插件）：已批改作业 + 逐题正确率。
     *
     * 判据全部**照旧页那一份**，一个字没改：
     *   · 「已批改」= `ranked(a)`（不是 `status === 'graded'`）—— 极简模式的档案没有逐题
     *     数据，自己写状态判断会让它混进来，然后被渲染成「全班全对 + 错误率 0%」
     *     （W16 的教室端那一半，见旧页 `graded` 的注释）；
     *   · 逐题统计 = `gradeStats(本班在读学生, 档案)`，错误率 = 错的人数 ÷ 应交人数；
     *   · 排序 = 布置日倒序（旧页 `graded` 的同一行）。
     *
     * ⚠️ 为什么把**所有**已批改档案的逐题统计一次递出去：`data.read` 没有参数
     *    （手册 §4.1），插件选不了"只读第 N 份"。本班 ~45 人 × 一学期几十份作业，
     *    一次算完是毫秒级；真到算不动的时候再拆资源，别现在把接口改成带参数的。
     * ⚠️ `bandLabel` / `bandColor` 也由宿主递（`BAND_META` 里只有一份）：插件是单文件、
     *    不许 import 宿主模块（手册 §11.3），让它自己抄一张分档表就是两个真相。
     */
    case 'class.gradedHomework': {
      const students = klass?.students ?? []
      const rows = s.assignments
        .filter((a) => a.classId === classId && ranked(a))
        .sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1))
        .map((a) => {
          const st = gradeStats(students, a)
          const cs = collectStats(students, a)
          return {
            id: a.id,
            title: a.title,
            subject: subjectName(subjectCodeOf(a), a.subject),
            assignDate: a.assignDate,
            total: cs.total,
            submitted: cs.submitted,
            missing: cs.missing,
            questions: st.questions.map((q) => ({
              seq: q.seq,
              wrongCount: q.wrongCount,
              rate: q.rate,
              band: q.band,
              bandLabel: BAND_META[q.band].label,
              bandColor: BAND_META[q.band].color,
              /* 学号（不是姓名）：与旧页 `PipPanel` 的 `wrongNos` 同一口径，
                 姓名由插件经 `class.roster` 自己配（名单是另一个能力）。 */
              wrongNos: q.wrongNos,
            })),
          }
        })
      return { value: { rows }, stale, asOf }
    }

    /*
     * 🆕 P2 首批搬运（祝福语插件）：宿主侧唯一话术源是 `lib/quotes.ts` 的 43 句
     *    （用户 2026-09-29 拍板的"每条能考据"那批）—— 插件不许 import 宿主内部模块
     *    （手册 §11.3），所以走资源口把**当天的那一句**递出去。`pickDailyQuote`
     *    用北京时间日期做种子，同一天固定，跨时区不串天 —— 与旧教室端
     *    `DailyQuote` 同一条判据，一个字没改。
     */
    case 'class.quote':
      return { value: { ...pickDailyQuote(beijingNow()) }, stale, asOf }
  }
}

/**
 * 订阅"变了"。回调**只表示变了、不推数据**（手册 §6.2），插件回调里自己重新 `read`。
 * P0b 从宽：store 任何一格变化都通知（重画是插件自己的便宜操作）；
 * 按资源做细粒度 diff 是 P2 有真插件之后的事，别提前做。
 */
export function watchResource(cb: () => void): () => void {
  resourceListeners.add(cb)
  const unsub = useStore.subscribe(() => cb())
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith('shugao.classroom.todaySchedule.') || event.key?.startsWith('shugao.classroom.weekOverride.')) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => { resourceListeners.delete(cb); unsub(); window.removeEventListener('storage', onStorage) }
}
