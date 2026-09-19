import { useEffect } from 'react'
import { useStore, useToast } from '../data/store'
import { notify, notifyPermission } from '../lib/notify'
import { REMIND_BEFORE, dueReminders } from '../lib/schedule'
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
 */
export function useScheduleReminder() {
  const schedule = useStore((s) => s.schedule)
  const classes = useStore((s) => s.classes)
  const push = useToast((s) => s.push)

  useEffect(() => {
    if (schedule.length === 0) return

    const tick = () => {
      // 法定假期不上课，别在假期里提醒上课
      // （调休上班日照常提醒 —— 那天确实要上课）
      if (dayKind(ymdOf(beijingNow())) === 'holiday') return

      // 只提醒教师自己的课；班级课表里别的科目不归他管
      const due = dueReminders(schedule.filter((s) => s.scope !== 'class'))
      if (due.length === 0) return

      const seen = loadSeen()
      let changed = false
      for (const item of due) {
        const key = `${ymdOf(beijingNow())}:${item.id}`
        if (seen[key]) continue
        seen[key] = true
        changed = true

        const className = classes.find((c) => c.id === item.classId)?.name
        const title = `${REMIND_BEFORE} 分钟后上课`
        const body = [item.title, className, item.room, `${item.start} 开始`]
          .filter(Boolean)
          .join(' · ')

        const ok = notify(title, body)
        // 系统通知没发出（未授权 / 非 https）就退化成页内提示，不能什么都不说
        if (!ok) {
          push({
            text: `${REMIND_BEFORE} 分钟后：${item.title}`,
            tone: 'warn',
            desc:
              notifyPermission() === 'granted'
                ? `${item.start} 开始`
                : '系统通知未授权，正在用页内提醒代替',
          })
        }
      }
      if (changed) saveSeen(seen)
    }

    tick()
    const t = window.setInterval(tick, 60_000)
    return () => window.clearInterval(t)
  }, [schedule, classes, push])
}
