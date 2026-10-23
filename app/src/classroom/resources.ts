/**
 * 插件的**只读资源**（手册 §6.1 那六张表）—— 宿主代理读，插件拿不到数据库客户端。
 *
 * ============================================================================
 * 口径
 * ============================================================================
 * · 数据源是**本机的 store**（`useStore`）—— 它在远程模式由 `hydrate()` + Realtime
 *   灌着，在演示模式是种子数据。插件读到的永远是"这块屏已经同步到的那一份"，
 *   与大屏自己显示的同源；不另开一条查库的路（那会变成第二套数据真相）。
 * · `stale`（手册 §6.4）：远程模式断网时 `true`（这份可能是旧缓存）；演示模式恒
 *   `false` —— 数据就在本机，没有"旧"可言。`read` **任何情况下都不 reject**：
 *   没数据回空形状，读不出来回空形状 + `stale:true`。
 * · `asOf` 一律 `beijingNow()`（§一 时间口径）。
 * · `class.assignments` 的 `dueDate`：本平台的作业档案今天只有**布置日**这一列
 *   （`Assignment.assignDate`），先按它给；手册 §6.1 的字段名是契约、保持不变，
 *   将来平台真出现"截止日"再换数据源（P2 首个用它的插件落地时一起核）。
 */

import { useStore } from '../data/store'
import { dayState, nowMinutes, toMinutes, weekdayOf } from '../lib/schedule'
import { splitLessonTitle } from '../lib/scheduleParse'
import { subjectCodeOf, subjectCodeOfName, subjectName } from '../lib/subjects'
import { collectStats } from '../lib/assignments'
import { ranked } from '../lib/wrongbook'
import { loadDailyBundle, toDutyInput, todayDuty } from '../lib/daily'
import { isoOffset } from '../lib/date'
import { beijingNow } from '../lib/holiday'
import { isRemote } from '../lib/supabase'
import type { ResourceName } from '../lib/pluginHost'
import type { ScheduleItem } from '../data/types'

export interface ResourceResult {
  value: unknown
  stale: boolean
  asOf: string
}

/** 与教室端旧页同一窗口：往前两周 + 明天（值日生锚点要往前翻才能推出来）。 */
const DAILY_FROM = -14
const DAILY_TO = 1

const noOf = (s: { studentNo: string; serial?: string }): string => s.studentNo || s.serial || ''

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
  }
}

/**
 * 订阅"变了"。回调**只表示变了、不推数据**（手册 §6.2），插件回调里自己重新 `read`。
 * P0b 从宽：store 任何一格变化都通知（重画是插件自己的便宜操作）；
 * 按资源做细粒度 diff 是 P2 有真插件之后的事，别提前做。
 */
export function watchResource(cb: () => void): () => void {
  return useStore.subscribe(() => cb())
}
