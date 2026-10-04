import { useEffect } from 'react'
import { useStore, useToast } from '../data/store'
import { loadSnoozes } from '../data/remote'
import { notifyAsync, readNotifyPermission } from '../lib/notify'
import { REMIND_BEFORE, dueRemindersWithSnooze } from '../lib/schedule'
import { beijingNow, dayKind, ymdOf } from '../lib/holiday'

const SEEN_KEY = 'shugao.remind.seen'

type Seen = Record<string, true>

function loadSeen(): Seen {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as { day: string; ids: string[] }) : null
    if (!parsed || parsed.day !== ymdOf(beijingNow())) return {}
    return Object.fromEntries(parsed.ids.map((id) => [id, true as const]))
  } catch {
    return {}
  }
}

function saveSeen(seen: Seen) {
  try {
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify({ day: ymdOf(beijingNow()), ids: Object.keys(seen) }),
    )
  } catch {
    /* 忽略 */
  }
}

/**
 * 上课前 10 分钟提醒下一节课是哪个班的。
 * 每分钟检查一次；同一天同一条日程只提醒一次。
 *
 * **时间口径一律北京时间**（§一 全局约定）：判定窗口、去重、"今天"的节假日
 * 都从同一个 `beijingNow()` 出发。设备时区只是显示口径，不参与判断 ——
 * 老师在国外出差时，课表仍然是学校的时间。
 */
export function useScheduleReminder() {
  const schedule = useStore((s) => s.schedule)
  const classes = useStore((s) => s.classes)
  const push = useToast((s) => s.push)

  /*
   * 🔴 推迟记录读的是 **store 里的那一份**（不是组件自己的 useState）：
   *    日程页的「晚 10 分钟」按钮写的是 store，读取方若是另一个 useState
   *    ⇒ 两个真值源 ⇒ 按钮显示"已推迟到 10:20"、提醒还在 10:00 响。
   */
  const snoozes = useStore((s) => s.scheduleSnoozes)
  const setScheduleSnooze = useStore((s) => s.setScheduleSnooze)

  // 每天取一次当天那组（跨零点自动换组 —— `ymdOf` 变了 key 就变）
  const dayKey = ymdOf(beijingNow())
  useEffect(() => {
    let alive = true
    void loadSnoozes(dayKey).then((loaded) => {
      if (!alive || Object.keys(loaded).length === 0) return
      // 只在有东西时写回（否则一次网络抖动就把本地的推迟记录清空）
      const cur = useStore.getState().scheduleSnoozes
      const merged = { ...cur, ...loaded }
      if (JSON.stringify(merged) === JSON.stringify(cur)) return
      useStore.setState({ scheduleSnoozes: merged })
    })
    return () => {
      alive = false
    }
  }, [dayKey, setScheduleSnooze])

  useEffect(() => {
    if (schedule.length === 0) return

    const tick = async () => {
      /*
       * ⚠️ 一次 tick 里只取**一个**「现在」。
       *
       * `dueReminders` 内部读的是 Date 的**本地字段**（`getHours` / `getDay`），
       * 所以必须把 `beijingNow()` 传进去 —— 它返回的 Date 的本地字段就是北京时间。
       * 传设备本地时间的话，窗口按设备时区算、去重与节假日按北京时间算，
       * 出了国境（或设备时区不是 +08:00）就会「该提醒的不提醒、不该提醒的乱提醒」。
       *
       * 判定窗口、去重键、节假日三处必须用**同一个**时间点：
       * 取一次 now 全程复用，跨零点那一瞬间也不会一半算今天、一半算明天。
       */
      const now = beijingNow()
      const today = ymdOf(now)

      // 法定假期不上课，别在假期里提醒上课
      // （调休上班日照常提醒 —— 那天确实要上课）
      if (dayKind(today) === 'holiday') return

      // 只提醒教师自己的课；班级课表里别的科目不归他管
      const due = dueRemindersWithSnooze(
        schedule.filter((s) => s.scope !== 'class'),
        snoozes,
        now,
      )
      if (due.length === 0) return

      const seen = loadSeen()
      let changed = false
      for (const item of due) {
        // 同一天同一个日程只提醒一次 —— 这里是**北京时间的"今天"**，和上面同源
        const key = `${today}:${item.id}`
        if (seen[key]) continue
        seen[key] = true
        changed = true

        const className = classes.find((c) => c.id === item.classId)?.name
        const title = `${REMIND_BEFORE} 分钟后上课`
        const body = [item.title, className, item.room, `${item.start} 开始`]
          .filter(Boolean)
          .join(' · ')

        /*
         * 🔴🔴 用 `notifyAsync` 而不是 `notify`（2026-10-04 修）：
         *   旧版用同步的 `notify()`，而它在原生那一支**恒返回 true**
         *   （桥接层如实回的 false 被丢掉了）⇒ `if (!ok)` 从来不成立
         *   ⇒ **系统通知没发出去时，连这条页内提示也没有** ⇒ 到点无声无息。
         *   现在拿到的是**真结果**：发失败就一定补一条页内提示。
         *   ⚠️ 页内那条是**兜底**，不是"多此一举" —— 它正是"失败了会有人知道吗"那一问的答案。
         */
        const ok = await notifyAsync(title, body)
        // 系统通知没发出（未授权 / 非 https / 桥接失败）就退化成页内提示，不能什么都不说
        if (!ok) {
          const perm = await readNotifyPermission()
          push({
            text: `${REMIND_BEFORE} 分钟后：${item.title}`,
            tone: 'warn',
            desc:
              perm === 'granted'
                ? `${item.start} 开始`
                : '系统通知未授权，正在用页内提醒代替',
          })
        }
      }
      if (changed) saveSeen(seen)
    }

    // `tick` 是 async 的（`notifyAsync` / `readNotifyPermission` 要 await）——
    // 这里显式 `void`，免得未处理的 Promise 挂在那儿；定时器那一份同理。
    void tick()
    const t = window.setInterval(() => void tick(), 60_000)
    return () => window.clearInterval(t)
    // 🔴 `snoozes` 在依赖里：推迟/恢复之后**下一分钟的那次 tick** 必须按新时刻判，
    //    漏了它就会出现"我明明点了晚 10 分钟，它还是按课前 10 分钟又响了一遍"。
  }, [schedule, classes, push, snoozes])
}
