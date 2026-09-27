/**
 * StatusMark —— ReactBits `StatusMark`（TS-TW，deps: `["motion@^12.23.12"]`）的**零依赖移植**。
 *
 * 🔴 这一版照原版（`新建文件夹\3\代码.txt`）的**驱动方式**：
 *
 *   `animate(travel, [t0, t0 - C], { duration: spinDuration/1000, ease:'linear', repeat:Infinity })`
 *   `travel.on('change', v => ring.setAttribute('stroke-dashoffset', v))`
 *   —— **只有 `stroke-dashoffset` 在动**。两个 `<circle>` 上的 `transform="rotate(-90 12 12)"`
 *      是**写死的静态属性**（只把弧的起点挪到 12 点钟），**从来不是动画目标**。
 *
 * ⚠️ 前两版把 `rotate` 当动画目标去转（CSS `@keyframes`）→ 弧不是"转"而是"漂"：
 *    属性那份解析出来是**三函数**列表、CSS 的 `to` 是**单函数**，列表不匹配时浏览器退化成
 *    **矩阵插值**，把 translate 分量也插了进去（屏幕坐标圆心漂 4.07px，图标才 20px；
 *    挂到 `<g>` 上更是漂 27.5px）。
 *
 * ✅ **本轮判据（进 `scripts/shots.mjs`）**：屏幕坐标圆心漂移 **0.000px**、
 *    `transform` 取值个数 **= 1**（逐字相同）。反向对照：改回 CSS 转 `rotate` → 必须红。
 *
 * `motion` 在这里只干"给一个数做线性插值 + 每帧回调" —— 那就是 `requestAnimationFrame`
 * 十几行的事，**不构成引入 22 KB gzip 的理由**（`说明.md` §3）。
 *
 * 与原版**逐字等价**：props 形状 / 默认值 / ARIA / 文案 / 几何 / 状态机 / reduced-motion 分支。
 * 只有两处是为把体积压回 ≤3 KB gzip 的近似：
 *   ① `useMotionValue` + `animate` → 一个 `rAF` 分发器 + 三个数字 ref；
 *   ② 300ms 形态切换的缓动：原版用 `motion` 的 spring / `cubic-bezier(.77,0,.175,1)`，
 *      这里用 smoothstep（对"300ms 内 0.06 的 fill-opacity 怎么走"不可辨）。
 *
 * ⚠️ 原版 `配置.txt` 示例里的 `indeterminate` **不是 prop**（`接口` 里没有它，
 *    行为由 `status === 'running' && progress 不是数` 推出）→ 这里也**不接收**它。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export type StatusMarkStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface StatusMarkProps {
  status?: StatusMarkStatus
  progress?: number
  label?: ReactNode
  color?: string
  doneColor?: string
  errorColor?: string
  size?: number
  strokeWidth?: number
  dashes?: number
  fontSize?: number
  spinDuration?: number
  arcLength?: number
  drawDuration?: number
  fillOpacity?: number
  strike?: boolean
  strikeDelay?: number
  className?: string
  style?: CSSProperties
}

/* 原版同款常量（3/代码.txt:29-40） */
const MORPH_MS = 300 // 原版 MORPH / UI 都是 duration .3
const CHECK = 'M7.5 12.25 10.5 15.25 16.75 8.75'
const CROSS = 'M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5'
const TEXT: Record<StatusMarkStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
const IDLE_DASH = 0.3

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/* 形态切换的缓动：两端零斜率的单调曲线（smoothstep 及其反向读法） */
const easeOut = (u: number) => u * u * (3 - 2 * u)
const easeIn = (u: number) => 1 - easeOut(1 - u)

export function StatusMark({
  status = 'pending',
  progress,
  label,
  color = 'currentColor',
  doneColor = '#22c55e',
  errorColor = '#ef4444',
  size = 20,
  strokeWidth = 2,
  dashes = 8,
  fontSize = 14,
  spinDuration = 1100,
  arcLength = 0.68,
  drawDuration = 240,
  fillOpacity = 0.06,
  strike = true,
  strikeDelay = 60,
  className = '',
  style,
}: StatusMarkProps) {
  const r = 10 - strokeWidth / 2
  const C = 2 * Math.PI * r
  const P = C / Math.max(1, dashes)
  const determinate = status === 'running' && typeof progress === 'number' && Number.isFinite(progress)
  const indeterminate = status === 'running' && !determinate
  const solid = status === 'running' || status === 'done' || status === 'failed'
  const targetArc = indeterminate ? arcLength : determinate ? clamp01(progress as number) : 1

  const ringRef = useRef<SVGCircleElement>(null)
  /* 三个"运动值" —— 原版是 MotionValue，这里是 ref 里的普通数字 */
  const geo = useRef({ C, P })
  geo.current = { C, P }
  const mode = useRef(solid ? 1 : 0)
  const arc = useRef(targetArc)
  const travel = useRef(0)
  const raf = useRef(0)
  /* 原版这里是 `useReducedMotion()`（3/代码.txt:64），motion 的那一个是**响应式**的：
     系统偏好一变，effect 依赖里的 reduce 就变，组件重走降级/恢复分支。这里用 matchMedia 补上。 */
  const [reduce, setReduce] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  /* 原版 `writeDash`（3/代码.txt:81-88）：mode / arc 任一变化 → 重写 dasharray */
  const writeDash = () => {
    const g = geo.current
    const m = mode.current
    const a = arc.current
    const dash = IDLE_DASH * g.P + (a * g.C - IDLE_DASH * g.P) * m
    const gap = (1 - IDLE_DASH) * g.P + ((1 - a) * g.C - (1 - IDLE_DASH) * g.P) * m
    ringRef.current?.setAttribute('stroke-dasharray', `${Math.max(0, dash)} ${Math.max(0, gap)}`)
  }
  /* 原版 `travel.on('change', …)`：**只动这一个属性** */
  const writeTravel = () => ringRef.current?.setAttribute('stroke-dashoffset', String(travel.current))

  useLayoutEffect(() => {
    writeDash()
    writeTravel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [C, P])

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    const v = { start: travel.current, mode: mode.current, arc: arc.current }

    if (reduce) {
      /* 原版 3/代码.txt:111-116。⚠️ 关键是 `travel.jump(0)`：
         弧停在**正上方**、dashoffset 归零，**不是**停在某个随机相位；循环根本不启动。 */
      mode.current = solid ? 1 : 0
      arc.current = targetArc
      travel.current = 0
      writeDash()
      writeTravel()
      return
    }

    if (mode.current === 0) arc.current = targetArc // 原版 117
    const mFrom = mode.current
    const aFrom = arc.current
    const mTo = solid ? 1 : 0
    const t0 = performance.now()
    const unit = determinate ? C : P
    const snapped = Math.floor(v.start / unit) * unit // 原版 125-129：走到整数格再归零
    const spin = indeterminate // 🔴 原版 120-124：只推 dashoffset，线性、无限

    const frame = (now: number) => {
      const p = clamp01((now - t0) / MORPH_MS)
      /* 形态切换（只在真的还在变的时候才写 —— 原版 motion 也是"值变了才回调"） */
      if (p < 1) {
        mode.current = mFrom + (mTo - mFrom) * easeOut(p)
        arc.current = aFrom + (targetArc - aFrom) * easeOut(p)
        writeDash()
      }
      /* 行程：不确定型 = 线性无限扫（原版 `travel` 那条 animate）；确定型 = 收进整数格再跳回 0 */
      if (spin) {
        travel.current = v.start - C * (((now - t0) / spinDuration) % 1)
      } else if (p < 1) {
        travel.current = v.start + (snapped - v.start) * easeIn(p)
      } else {
        travel.current = 0 // 原版 127-128：animate(...).then(() => travel.jump(0))
      }
      writeTravel()
      if (spin || p < 1) raf.current = requestAnimationFrame(frame)
      else raf.current = 0
    }
    raf.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, determinate, targetArc, reduce, C, P, spinDuration])

  const spoken = TEXT[status] + (determinate ? `, ${Math.round(clamp01(progress as number) * 100)}%` : '')
  const hasLabel = label !== undefined && label !== null

  return (
    <span
      className={`status-mark${className ? ` ${className}` : ''}`}
      data-status={status}
      data-indeterminate={indeterminate ? '' : undefined}
      data-strike={strike ? '' : undefined}
      style={
        {
          '--sm-size': `${size}px`,
          '--sm-stroke': strokeWidth,
          '--sm-color': color,
          '--sm-done': doneColor,
          '--sm-error': errorColor,
          '--sm-fill': fillOpacity,
          '--sm-font': `${fontSize}px`,
          '--sm-draw': `${drawDuration}ms`,
          '--sm-strike-delay': `${120 + strikeDelay}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <svg
        className="status-mark__glyph"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        role={hasLabel ? undefined : 'img'}
        aria-label={hasLabel ? undefined : spoken}
        aria-hidden={hasLabel || undefined}
      >
        {/* 🔴 这两个 rotate(-90 12 12) 是**静态属性**，与原版逐字一致；全程不动 */}
        <circle className="status-mark__track" cx="12" cy="12" r={r} transform="rotate(-90 12 12)" />
        <circle ref={ringRef} className="status-mark__ring" cx="12" cy="12" r={r} transform="rotate(-90 12 12)" />
        <path className="status-mark__check" d={CHECK} pathLength="1" />
        <path className="status-mark__cross" d={CROSS} pathLength="1" />
      </svg>
      {hasLabel ? <span className="status-mark__sr">{spoken}: </span> : null}
      {hasLabel ? (
        <span className="status-mark__label">
          {label}
          <span className="status-mark__strike" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  )
}

export default StatusMark
