import { useEffect, useState } from 'react'
import { BAND_META, type Band } from '../lib/grading'

/* ============================================================
   小窗内容 —— 一份代码两种形态：
   · tone="pip"    渲染进 Document PiP 的系统置顶窗口（深色，浮在全屏应用之上）
   · tone="inline" 内联在教室端页面里（浅色，兼作不支持 PiP 时的兜底）
   折叠态只显示题号与正确率；名单要点一下才展开，且随时可一键收起。
   ============================================================ */

type Palette = {
  bg: string
  fg: string
  dim: string
  line: string
  btnBg: string
  btnOn: string
  listBg: string
}

const PIP: Palette = {
  bg: 'linear-gradient(180deg, #10151c, #171e28)',
  fg: '#fff',
  dim: 'rgb(255 255 255 / .6)',
  line: 'rgb(255 255 255 / .16)',
  btnBg: 'transparent',
  btnOn: 'rgb(255 255 255 / .16)',
  listBg: 'rgb(255 255 255 / .06)',
}

const INLINE: Palette = {
  bg: 'var(--color-surface)',
  fg: 'var(--color-ink)',
  dim: 'var(--color-ink3)',
  line: 'var(--color-line)',
  btnBg: 'var(--color-surface)',
  btnOn: 'var(--color-accentsoft)',
  listBg: 'var(--color-surface2)',
}

function PipBtn({
  onClick,
  children,
  on,
  p,
  ariaLabel,
}: {
  onClick: () => void
  children: React.ReactNode
  on?: boolean
  p: Palette
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      style={{
        flex: 1,
        height: 30,
        border: `1px solid ${on ? 'var(--color-accent)' : p.line}`,
        background: on ? p.btnOn : p.btnBg,
        color: on ? 'var(--color-accent)' : p.fg,
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {children}
    </button>
  )
}

export function PipPanel({
  tone = 'pip',
  seq,
  total,
  rate,
  band,
  wrongNos,
  nameOf,
  onPrev,
  onNext,
  all,
  onPick,
}: {
  tone?: 'pip' | 'inline'
  seq: number
  total: number
  rate: number
  band: Band
  wrongNos: string[]
  nameOf: (no: string) => string
  onPrev: () => void
  onNext: () => void
  /** 全部题目的正确率（下标 0 = 第 1 题），用来画题号条 */
  all: Array<{ rate: number; band: Band }>
  onPick: (seq: number) => void
}) {
  const [showList, setShowList] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const meta = BAND_META[band]
  const p = tone === 'pip' ? PIP : INLINE

  /**
   * 题号条：收起时**一次全部显示**；展开时只留前一个、当前、后一个。
   * 不全藏起来 —— 讲评时经常要往前后翻，看得见邻居才敢点。
   */
  const nums = expanded
    ? [seq - 1, seq, seq + 1].filter((n) => n >= 1 && n <= total)
    : Array.from({ length: total }, (_, i) => i + 1)

  /* 小窗获得焦点时可用方向键切题、Esc 收起名单 */
  useEffect(() => {
    if (tone !== 'pip') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onPrev()
      else if (e.key === 'ArrowRight') onNext()
      else if (e.key === 'Escape') setShowList(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tone, onPrev, onNext])

  // 换题时自动收起名单 —— 由调用方传 key={seq} 重挂载实现，不需要 effect

  return (
    <div
      style={{
        height: tone === 'pip' ? '100vh' : 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        padding: tone === 'pip' ? '9px 11px' : 0,
        background: p.bg,
        color: p.fg,
        boxSizing: 'border-box',
      }}
    >
      {/* 题号条：每个题号带自己的正确率，颜色即讲评优先级 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {nums.map((n) => {
          const q = all[n - 1]
          const on = n === seq
          const col = q ? BAND_META[q.band].color : p.dim
          return (
            <button
              key={n}
              type="button"
              aria-label={`第 ${n} 题`}
              onClick={() => {
                // 点当前题 = 收起/展开；点别的题 = 切过去并展开
                if (n === seq) {
                  setExpanded((v) => !v)
                  return
                }
                onPick(n)
                setExpanded(true)
              }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 3,
                padding: '2px 6px',
                borderRadius: 3,
                border: `1px solid ${on ? col : 'transparent'}`,
                background: on ? 'rgb(255 255 255 / .14)' : 'rgb(255 255 255 / .06)',
                color: col,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <span className="num" style={{ fontSize: 12, fontWeight: 700 }}>
                {n}
              </span>
              <span className="num" style={{ fontSize: 10, opacity: 0.85 }}>
                {q ? Math.round(q.rate * 100) : 0}%
              </span>
            </button>
          )
        })}
      </div>

      {expanded ? (
        <>
          <div className="flex items-baseline gap-2">
        <span className="num" style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-.02em' }}>
          第 {seq} 题
        </span>
        <span style={{ fontSize: 11, color: p.dim }}>/ {total}</span>
        <span className="flex-1" />
        <span className="num" style={{ fontSize: 22, fontWeight: 700, color: meta.color }}>
          {Math.round(rate * 100)}%
        </span>
      </div>

      <div className="flex items-center gap-2" style={{ fontSize: 11, color: p.dim }}>
        <span
          style={{
            padding: '1px 6px',
            borderRadius: 2,
            background: tone === 'pip' ? 'rgb(255 255 255 / .1)' : 'var(--color-surface3)',
            color: meta.color,
            fontWeight: 700,
          }}
        >
          {meta.label}
        </span>
        <span className="truncate">{wrongNos.length} 人错</span>
      </div>

      {showList ? (
        <div
          style={{
            flex: tone === 'pip' ? 1 : undefined,
            minHeight: 0,
            maxHeight: tone === 'pip' ? undefined : 132,
            overflowY: 'auto',
            background: p.listBg,
            borderRadius: 4,
            padding: '6px 8px',
            fontSize: 12,
            lineHeight: 1.9,
          }}
        >
          {wrongNos.map((no) => (
            <span key={no} style={{ marginRight: 10, whiteSpace: 'nowrap' }}>
              <b className="num">{no}</b>
              <span style={{ color: p.dim }}> {nameOf(no)}</span>
            </span>
          ))}
        </div>
      ) : null}

        </>
      ) : null}

      <div style={{ display: 'flex', gap: 5, marginTop: tone === 'pip' ? 'auto' : 2 }}>
        <PipBtn onClick={onPrev} p={p} ariaLabel="上一题">
          ◀
        </PipBtn>
        <PipBtn onClick={onNext} p={p} ariaLabel="下一题">
          ▶
        </PipBtn>
        <PipBtn
          onClick={() => {
            setExpanded(true)
            setShowList((v) => !v)
          }}
          on={showList}
          p={p}
          ariaLabel={showList ? '隐藏名单' : '展开错误名单'}
        >
          {showList ? '隐藏名单' : `名单 ${wrongNos.length}`}
        </PipBtn>
      </div>
    </div>
  )
}
