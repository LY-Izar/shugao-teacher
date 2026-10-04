import { useMemo } from 'react'
import type { ScheduleItem } from '../data/types'
import { Tag } from './ui'
import { REMIND_BEFORE, dayGaps, dayRange, nowMinutes, overlapGroups, toMinutes } from '../lib/schedule'

/* ============================================================
   「今天」的**真实时间轴**（2026-10-04 · 施工单-日程今天时间轴.md）
   ------------------------------------------------------------
   它解决的是平铺列表看不出来的三件事：
     ① 每节课**真实占多长**（40 分钟和 90 分钟看起来不一样长）
     ② 中间**空闲多久**（不用自己把上一次的 end 和下一次的 start 减一遍）
     ③ **哪两节真的撞了**（并且画成并排，而不是叠在一起看不见）

   ⚠️ 「撞了」的判定不在这里 —— 复用 `lib/schedule.ts` 的 `overlapGroups()`，
      它与 `applyMondayShift()` 返回的 `conflicts` 是**同一件事两个说法**。
      本组件只负责"画得出来"。
   ============================================================ */

/** 每分钟多少像素（同一个比例尺下，40 分钟的课就该是 80 分钟的一半高） */
const PX_PER_MIN = 1.15
/** 太矮的课至少给这么高，否则点不中 */
const MIN_ROW_H = 20
/** 整点标签那一列的宽度 */
const GUTTER = 46

function hhmm(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export default function ScheduleDayAxis({
  items,
  classNameOf,
  onPick,
  now = nowMinutes(),
}: {
  items: ScheduleItem[]
  /** 班级 id → 班级名（取不到就是空串，轴照画） */
  classNameOf: (id?: string) => string | undefined
  onPick?: (it: ScheduleItem) => void
  /** 现在是几点（分钟）。传进来是为了让判据能钉住时间，不必真的等到那一刻 */
  now?: number
}) {
  const range = dayRange(items)

  /**
   * 重叠的两条要**并排**，不是叠在一起。
   * ⇒ 先算出每条占同一时间带里的第几格 / 共几格，再按比例定宽定左。
   */
  const slots = useMemo(() => {
    const map = new Map<string, { i: number; n: number }>()
    for (const g of overlapGroups(items)) {
      g.forEach((it, i) => map.set(it.id, { i, n: g.length }))
    }
    for (const it of items) if (!map.has(it.id)) map.set(it.id, { i: 0, n: 1 })
    return map
  }, [items])

  const gaps = dayGaps(items)
  const overlapped = useMemo(() => new Set(overlapGroups(items).flat().map((x) => x.id)), [items])

  /* 空数据就**不渲染轴** —— 别给一条空轴，那看着像坏了。
     ⚠️ 这个早退必须排在**所有** useMemo 之后：hook 调用顺序逐帧一变，下一帧就炸
        （oxlint rules-of-hooks 会当场抓，但它只在"已写错"之后才说话）。 */
  if (!range) return null

  const span = Math.max(1, range.toMin - range.fromMin)
  const height = span * PX_PER_MIN
  const y = (min: number) => (min - range.fromMin) * PX_PER_MIN

  const hours: number[] = []
  for (let h = Math.ceil(range.fromMin / 60) * 60; h <= range.toMin; h += 60) hours.push(h)

  return (
    <div className="relative" style={{ paddingLeft: GUTTER, height, minHeight: 120 }}>
      {/* 整点横线 + 刻度 */}
      {hours.map((h) => (
        <div key={h}>
          <div
            className="num"
            style={{
              position: 'absolute',
              left: 0,
              top: y(h),
              width: GUTTER - 8,
              textAlign: 'right',
              fontSize: 10.5,
              color: 'var(--color-ink4)',
              transform: 'translateY(-50%)',
            }}
          >
            {hhmm(h)}
          </div>
          <div
            style={{
              position: 'absolute',
              left: GUTTER,
              right: 0,
              top: y(h),
              borderTop: '1px solid var(--color-line)',
            }}
          />
        </div>
      ))}

      {/* 空闲：显式说出来，别让老师自己减 */}
      {gaps.map((g, i) => (
        <div
          key={`gap-${i}`}
          style={{
            position: 'absolute',
            left: GUTTER,
            right: 0,
            top: y(g.fromMin),
            height: Math.max(16, (g.toMin - g.fromMin) * PX_PER_MIN),
            borderLeft: '2px dashed var(--color-line2)',
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 8,
            fontSize: 11.5,
            color: 'var(--color-ink4)',
          }}
        >
          空闲 {g.minutes} 分钟
        </div>
      ))}

      {/* 每节课按真实时长铺位 */}
      {items.map((it) => {
        const s = toMinutes(it.start)
        const e = Math.max(toMinutes(it.end), s + 1)
        const slot = slots.get(it.id) ?? { i: 0, n: 1 }
        const isNow = now >= s && now < e
        const isPast = e <= now
        const cls = classNameOf(it.classId)
        const body = (
          <>
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className="num shrink-0" style={{ fontSize: 12, fontWeight: 700 }}>
                {it.start}
              </span>
              <span className="truncate" style={{ fontSize: 13, fontWeight: 620 }}>
                {it.title}
              </span>
              {isNow ? <Tag tone="accent">进行中</Tag> : null}
              {overlapped.has(it.id) ? <Tag tone="warn">时间重叠</Tag> : null}
            </div>
            <div
              className="mt-0.5 flex flex-wrap items-center gap-x-3"
              style={{ fontSize: 11, color: 'var(--color-ink3)' }}
            >
              <span className="num">
                {it.start}–{it.end}
              </span>
              {cls ? <span className="truncate">{cls}</span> : null}
              {it.room ? <span>{it.room}</span> : null}
              {/* 已过去的那几节就不必再提醒"会提醒你"了 —— 那天已经过完了 */}
              {it.notify && !isPast ? (
                <span>提前 {REMIND_BEFORE} 分钟提醒</span>
              ) : null}
            </div>
          </>
        )
        const box: React.CSSProperties = {
          position: 'absolute',
          left: GUTTER + (slot.i * 100) / slot.n + 6,
          width: `calc((100% - ${GUTTER}px - 12px) / ${slot.n} - ${(slot.i * 100) / slot.n}%)`,
          top: y(s) + 1,
          height: Math.max(MIN_ROW_H, (e - s) * PX_PER_MIN - 2),
          padding: '5px 8px',
          borderRadius: 8,
          border: `1px solid ${isNow ? 'var(--color-accent)' : 'var(--color-line)'}`,
          background: isNow ? 'var(--color-accentsoft)' : 'var(--color-surface)',
          opacity: isPast ? 0.55 : 1,
          overflow: 'hidden',
          textAlign: 'left',
          cursor: onPick ? 'pointer' : 'default',
        }
        return onPick ? (
          <button key={it.id} type="button" style={box} onClick={() => onPick(it)}>
            {body}
          </button>
        ) : (
          <div key={it.id} style={box}>
            {body}
          </div>
        )
      })}

      {/* 现在 */}
      {now >= range.fromMin && now <= range.toMin ? (
        <div
          style={{
            position: 'absolute',
            left: GUTTER,
            right: 0,
            top: y(now),
            borderTop: '2px solid var(--color-accent)',
            zIndex: 2,
            pointerEvents: 'none',
          }}
        >
          <span
            className="num"
            style={{
              position: 'absolute',
              left: -GUTTER + 2,
              top: -8,
              fontSize: 10.5,
              fontWeight: 700,
              color: 'var(--color-accenttext)',
            }}
          >
            现在
          </span>
        </div>
      ) : null}
    </div>
  )
}