import { useEffect, useRef } from 'react'
import { useStore } from '../data/store'
import { notifyAsync } from '../lib/notify'

const NOTIFIED_KEY = 'shugao.notify.notices'
const MAX_NOTIFIED = 200

/**
 * 「教务处发了通知」→ **系统通知**（2026-10-02，用户报"发通知的时候不弹"）。
 *
 * 断在哪：全仓除日程提醒外**没有任何代码**发系统通知 —— 教务处发了通知，
 * 老师只有打开「通知」页才看得见；apk 关着时连页内都没有。这一条把"到达"接上：
 * hydrate 到**没提醒过**的新通知 → `notifyAsync()` 走与日程提醒同一条原生链
 * （`ShugaoNative.notify` → `shugao-default` 渠道，heads-up 弹出）。
 *
 * ⚠️ 去重：localStorage 记已提醒的 id（截尾 200 条）。**首次挂载只记档、不补发**
 *   —— 否则装上第一版就把历史未读挨个炸一遍（旧通知是"未读"，不是"刚到"）。
 * ⚠️ 只在**前台**探测（下面 5 分钟一轮的重取）：应用关着要收通知需要
 *   FCM/自建推送那样的服务端通道，本项目没有 —— 那是**另案**，这里如实说清楚边界。
 * ⚠️ 自己发的（`mine`）不提醒；已撤回 / 已过期的也不提醒。
 * ⚠️ 发失败**静默**是刻意的：失败的原因（未授权 / 渠道被关）在「我的 → 通知权限」
 *   与日程提醒那侧都有完整的引导，这里不为每条通知再叠一条页内提示刷屏。
 */
function loadNotified(): Record<string, true> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, true>) : {}
  } catch {
    return {}
  }
}

function saveNotified(ids: string[]) {
  try {
    const keep = ids.slice(-MAX_NOTIFIED)
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(Object.fromEntries(keep.map((id) => [id, true as const]))))
  } catch {
    /* localStorage 满了 / 被禁：退化为"这次会话内不会重复提醒"，功能本身不受影响 */
  }
}

export function useNoticeNotify() {
  const notices = useStore((s) => s.notices)
  const isDemo = useStore((s) => s.isDemo)
  const hydrateNotices = useStore((s) => s.hydrateNotices)
  /** 首次见到这一批 = 记档基线（不补发历史） */
  const first = useRef(true)

  useEffect(() => {
    if (isDemo || notices.length === 0) return
    const seen = loadNotified()
    const fresh = notices
      .filter((n) => !n.mine && !n.revokedAt && !n.expired && !seen[n.id])
      .map((n) => n.id)

    if (first.current) {
      first.current = false
      if (fresh.length) saveNotified(fresh)
      return
    }
    if (fresh.length === 0) return

    /* 一次最多响 3 条（教务处连发一批时只取最新的三条，别把手机炸了） */
    const toFire = notices
      .filter((n) => fresh.includes(n.id))
      .slice(0, 3)
    for (const n of toFire) {
      void notifyAsync(n.title, (n.body ?? '').slice(0, 180))
    }
    saveNotified(fresh)
  }, [notices, isDemo])

  /* 前台每 5 分钟重取一次通知 —— "发通知的时候"多半发生在应用开着的时段 */
  useEffect(() => {
    if (isDemo) return
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void hydrateNotices()
    }, 300_000)
    return () => window.clearInterval(t)
  }, [isDemo, hydrateNotices])
}
