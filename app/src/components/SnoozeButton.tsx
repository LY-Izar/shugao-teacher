import { useState } from 'react'
import { useStore, useToast } from '../data/store'
import { ensureSnoozeTable } from '../data/remote'
import { REMIND_BEFORE, snoozeMinuteOf, snoozeText } from '../lib/schedule'

/* ============================================================
   「晚 N 分钟」/「恢复」—— 推迟某一节课的**提醒**（2026-10-04）
   ------------------------------------------------------------
   🔴 它推迟的是**提醒**，不是课表 —— 课还在原来那个时间上。
      真要改课表走「编辑」，那改的是每周重复的那一行。

   🔴 为什么放 store 而不是本组件 useState：
      提醒那侧（`useScheduleReminder` 的定时器）读的是 store 那一份。
      本组件各开一份 useState ⇒ 按钮显示"已推迟到 10:20"、提醒还在 10:00 响。

   ⚠️ 累加语义：连点两次「晚 10 分钟」是 10:00 → 10:10 → 10:20，
      不是"永远 10:10"（后者是另一样东西：改成一个固定时刻）。
   ============================================================ */

const DELAYS = [10, 20] as const

export default function SnoozeButton({
  itemId,
  start,
  notify,
}: {
  itemId: string
  /** 'HH:MM' —— 这节课原本的开始时间（用来算"课前 10 分钟"那个基点） */
  start: string
  /** 这节课要不要提醒（`notify: false` 的课没有"晚 10 分钟"可言） */
  notify: boolean
}) {
  const snoozes = useStore((s) => s.scheduleSnoozes)
  const setScheduleSnooze = useStore((s) => s.setScheduleSnooze)
  const push = useToast((s) => s.push)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  // 探表（老库没那张表就不摆按钮，而不是点了报错）
  if (supported === null) {
    void ensureSnoozeTable().then(setSupported)
  }

  if (!notify) return null
  // 老库没那张表 ⇒ 收起（灰着不解释，"不支持"三个字对老师没用）
  if (supported === false) return null

  const moved = snoozes[itemId]

  const run = (minute: number | null, okText: string) => {
    if (busy) return
    setBusy(true)
    try {
      setScheduleSnooze(itemId, minute)
      push({ text: okText, tone: 'ok' })
    } catch (e) {
      // 🔴 落库失败必须说出来（store 已把内存改回去，这里补一句人话）
      push({
        text: '推迟没存上',
        tone: 'warn',
        desc: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {moved === undefined ? (
        DELAYS.map((d) => (
          <button
            key={d}
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              const m = snoozeMinuteOf(start, undefined, d)
              run(m, `提醒已推到 ${snoozeText(m)}`)
            }}
            title={`上课前 ${REMIND_BEFORE} 分钟那条提醒，改到 ${d} 分钟后再响（课还是 ${start}）`}
          >
            晚 {d} 分
          </button>
        ))
      ) : (
        <>
          {/* 已推迟：把"几点会响"说出来 —— 不说的话老师不知道还能不能关 */}
          <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
            {snoozeText(moved)} 提醒
          </span>
          {DELAYS.map((d) => (
            <button
              key={d}
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                const m = snoozeMinuteOf(start, moved, d)
                run(m, `提醒已推到 ${snoozeText(m)}`)
              }}
              title={`再往后推 ${d} 分钟`}
            >
              再晚 {d} 分
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(null, `恢复成上课前 ${REMIND_BEFORE} 分钟提醒`)}
          >
            恢复
          </button>
        </>
      )}
    </span>
  )
}