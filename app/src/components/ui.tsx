import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/cx'
import { IconArrowLeft, IconX } from './icons'

/**
 * 浮层一律挂到 body 上。
 * 页面过渡动画会给 <main> 创建层叠上下文，浮层的 z-index 会被关在里面，
 * 结果被底部导航盖住、按钮点不到 —— 用 Portal 从根本上避开。
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

/* ---------------- 按钮（带真实坐标波纹） ---------------- */

type ButtonProps = {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  icon?: ReactNode
  block?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  block,
  children,
  className,
  ...rest
}: ButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      className={cx(
        'btn',
        'ripple',
        variant === 'primary' && 'btn-primary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        block && 'w-full',
        className,
      )}
      onPointerDown={(e) => {
        const el = ref.current
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--rx', `${e.clientX - r.left}px`)
        el.style.setProperty('--ry', `${e.clientY - r.top}px`)
      }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

/* ---------------- 面板 ---------------- */

export function Panel({
  head,
  extra,
  children,
  className,
  bodyClass,
}: {
  head?: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
}) {
  return (
    <section className={cx('panel', className)}>
      {head ? (
        <div className="panel-head">
          <h2 className="flex-1 truncate">{head}</h2>
          {extra}
        </div>
      ) : null}
      <div className={bodyClass}>{children}</div>
    </section>
  )
}

/* ---------------- 分区标题 ---------------- */

export function Sect({ children }: { children: ReactNode }) {
  return (
    <div className="sect">
      <span>{children}</span>
      <i />
    </div>
  )
}

/* ---------------- 数据条 ---------------- */

export function StatStrip({ items }: { items: Array<{ k: string; v: ReactNode; tone?: string }> }) {
  return (
    <div className="flex">
      {items.map((it) => (
        <div key={it.k} className="stat flex-1">
          <div className="stat-k">{it.k}</div>
          <div className="stat-v" style={{ color: it.tone }}>
            {it.v}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 进度 ---------------- */

export function Track({ value, tone }: { value: number; tone?: string }) {
  return (
    <div className="track">
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: tone }} />
    </div>
  )
}

/* ---------------- 标签 ---------------- */

export function Tag({
  tone = 'idle',
  children,
}: {
  tone?: 'idle' | 'accent' | 'ok' | 'warn' | 'bad'
  children: ReactNode
}) {
  return <span className={cx('tag', `tag-${tone}`)}>{children}</span>
}

/* ---------------- 空态 ---------------- */

export function Empty({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode
  title: string
  desc?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div
        className="grid place-items-center"
        style={{
          width: 52,
          height: 52,
          border: '1px solid var(--color-line2)',
          borderRadius: 6,
          color: 'var(--color-ink3)',
        }}
      >
        {icon}
      </div>
      <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{title}</div>
      {desc ? <div style={{ fontSize: 13, maxWidth: 280 }}>{desc}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

/* ---------------- 页面头 ---------------- */

export function PageHead({
  title,
  sub,
  onBack,
  right,
}: {
  title: string
  sub?: ReactNode
  onBack?: () => void
  right?: ReactNode
}) {
  return (
    <header
      className="sticky z-30 flex items-center gap-3 px-4"
      style={{
        height: 52,
        /*
         * 🔴 `top` 走 `--top-stack-h`：顶部可能有**公告条**（`AnnouncementStack`，z-45）
         *    与**同步出错横幅**（`SyncErrorBanner`，z-70）。页头如果用 `top-0`，
         *    滚动时会被那两条压住（它们 z 更高）。
         *    ⚠️ 这个变量由 `AnnouncementStack` 写、**四个地方共用**
         *    （这里 + `AppShell` 的移动端顶栏 / 桌面左栏 / 右栏）——
         *    各自写一个数就是"同一件事四个口径"。
         */
        top: 'var(--top-stack-h, 0px)',
        background: 'color-mix(in srgb, var(--color-canvas) 88%, transparent)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid var(--color-line)',
      }}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="-ml-1.5 grid place-items-center transition-colors"
          style={{
            width: 34,
            height: 34,
            border: '1px solid var(--color-line)',
            borderRadius: 4,
            background: 'var(--color-surface)',
            color: 'var(--color-ink2)',
          }}
        >
          <IconArrowLeft size={17} />
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate" style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.25 }}>
          {title}
        </h1>
        {sub ? (
          <div className="truncate" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            {sub}
          </div>
        ) : null}
      </div>
      {right}
    </header>
  )
}

/* ---------------- 底部浮层 ---------------- */

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <Portal>
      <div className="scrim" onClick={onClose} />
      <div className="sheet">
        <div className="panel-head" style={{ borderRadius: '10px 10px 0 0' }}>
          <h2 className="flex-1 truncate">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            style={{ color: 'var(--color-ink3)' }}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {/*
          ⚠️ `sheet-foot-safe` 这个类名现在**没有任何 CSS 规则**（2026-09-28 第二轮起）。
          它原来是给页脚补一块底部安全区、让开移动端那两颗悬浮控件（当时导航被抬到
          Sheet 之上）；那一轮改成"**展开时整栏淡出**"之后没有东西压着页脚了，
          规则按用户要求**回退删掉**（留一个说不出理由的 `!important` 更危险）。
          类名先留着当**锚点**：`shots.mjs` 与这一段注释都按它取页脚，
          以后真要再让位，加一条规则即可。缘由与实测见 `index.css` 里那段留档。
        */}
        {footer ? (
          <div className="border-t border-line p-3 sheet-foot-safe">{footer}</div>
        ) : null}
      </div>
    </Portal>
  )
}

/* ---------------- 居中对话框 ---------------- */

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <Portal>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </Portal>
  )
}

/* ---------------- 键值行 ---------------- */

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-2" style={{ borderBottom: '1px solid var(--color-line)' }}>
      <span style={{ fontSize: 12, color: 'var(--color-ink3)', minWidth: 68 }}>{k}</span>
      <span className="flex-1 text-right" style={{ fontSize: 14 }}>
        {v}
      </span>
    </div>
  )
}
