import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT } from '../data/types'
import { useClassroomPresence } from '../hooks/useClassroomPresence'
import { useMood } from '../hooks/useMood'
import { useScheduleReminder } from '../hooks/useScheduleReminder'
import { analyzeRoster } from '../lib/roster'
import { awayText, toMinutes, weekdayOf } from '../lib/schedule'
import { DoneCelebration, MorningWelcome } from './MoodModals'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGauge,
  IconHash,
  IconInfo,
  IconUser,
  IconUsers,
  Logo,
} from './icons'
import { Button, Sheet, Tag } from './ui'
import { cx } from '../lib/cx'

const NAV = [
  { to: '/', label: '工作台', icon: IconGauge, end: true },
  { to: '/classes', label: '班级', icon: IconUsers, end: false },
  { to: '/assignments', label: '作业', icon: IconClipboard, end: false },
  { to: '/settings', label: '我的', icon: IconUser, end: false },
]

/* ---------------- Toast ---------------- */

export function ToastHost() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex flex-col items-center gap-2 pt-3">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className="glass-dark anim-toast pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 text-left"
          style={{
            maxWidth: 420,
            color: '***REMOVED***fff',
            border: '1px solid rgb(255 255 255 / .14)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              color:
                t.tone === 'ok'
                  ? '***REMOVED***4ade9a'
                  : t.tone === 'bad'
                    ? '***REMOVED***ff8a94'
                    : t.tone === 'warn'
                      ? '***REMOVED***f5c469'
                      : '***REMOVED***8fd3ff',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            {t.tone === 'ok' ? (
              <IconCheck size={17} />
            ) : t.tone === 'bad' ? (
              <IconAlert size={17} />
            ) : (
              <IconInfo size={17} />
            )}
          </span>
          <span className="flex-1" style={{ fontSize: 13.5, fontWeight: 550 }}>
            {t.text}
            {t.desc ? (
              <span style={{ display: 'block', fontWeight: 400, opacity: 0.7, fontSize: 12 }}>
                {t.desc}
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ---------------- 导航项 ---------------- */

function RailItem({ to, label, icon: Icon, end }: (typeof NAV)[number]) {
  return (
    <NavLink to={to} end={end} className="block">
      {({ isActive }) => (
        <span
          data-active={isActive}
          className="relative flex items-center gap-3 px-3"
          style={{
            height: 40,
            borderRadius: 6,
            color: isActive ? 'var(--color-accentink)' : 'var(--color-ink2)',
            fontWeight: isActive ? 600 : 500,
            fontSize: 14,
            transition: 'color .22s cubic-bezier(.22,.8,.24,1)',
          }}
        >
          {isActive ? (
            <i
              className="absolute left-0"
              style={{
                top: 9,
                bottom: 9,
                width: 2,
                background: 'var(--color-accent)',
                borderRadius: '0 2px 2px 0',
              }}
            />
          ) : null}
          <span
            className={isActive ? 'tab-icon-on' : undefined}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <Icon size={18} />
          </span>
          {label}
        </span>
      )}
    </NavLink>
  )
}

function TabItem({ to, label, icon: Icon, end }: (typeof NAV)[number]) {
  return (
    <NavLink to={to} end={end} className="relative flex-1">
      {({ isActive }) => (
        <span
          data-active={isActive}
          className="relative flex flex-col items-center justify-center gap-1"
          style={{
            height: 56,
            color: isActive ? 'var(--color-accent)' : 'var(--color-ink3)',
            transition: 'color .22s cubic-bezier(.22,.8,.24,1)',
          }}
        >
          <span
            className={isActive ? 'tab-icon-on' : undefined}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <Icon size={21} strokeWidth={isActive ? 1.9 : 1.6} />
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: isActive ? 650 : 500,
              transition: 'font-weight .2s',
            }}
          >
            {label}
          </span>
        </span>
      )}
    </NavLink>
  )
}

/* ---------------- 桌面右栏时钟 ---------------- */

function ClockPanel() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <section className="panel p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}>
          现在
        </span>
        <span className="flex-1" />
        <span
          className="live-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: 99,
            background: 'var(--color-ok)',
            display: 'inline-block',
          }}
        />
      </div>
      <div
        className="num"
        style={{ fontSize: 30, fontWeight: 640, letterSpacing: '-.04em', lineHeight: 1 }}
      >
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span style={{ fontSize: 14, color: 'var(--color-ink4)', marginLeft: 3 }}>
          {pad(now.getSeconds())}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 5 }}>
        {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周
        {'日一二三四五六'[now.getDay()]}
      </div>
    </section>
  )
}

/* ---------------- 应用壳 ---------------- */

export function AppShell({ children }: { children: React.ReactNode }) {
  const teacher = useStore((s) => s.teacher)
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const push = useToast((s) => s.push)
  /** 顶栏班级标签点开后的切换浮层 */
  const [switching, setSwitching] = useState(false)
  const isDemo = useStore((s) => s.isDemo)
  const touchStreak = useStore((s) => s.touchStreak)
  const syncError = useStore((s) => s.syncError)
  const clearSyncError = useStore((s) => s.clearSyncError)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current = classes.find((c) => c.id === currentClassId)

  /* 底部导航 + 左侧导航：测量激活项位置，让液态玻璃胶囊滑过去 */
  const tabsRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const railNavRef = useRef<HTMLElement>(null)
  const railPillRef = useRef<HTMLSpanElement>(null)
  const lastIdx = useRef(-1)
  const [ind, setInd] = useState({ left: 0, width: 0, show: false })
  const [railInd, setRailInd] = useState({ top: 0, height: 40, show: false })

  /* 拖动底栏时胶囊跟手 */
  const dragRef = useRef<{ startX: number; active: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [dragX, setDragX] = useState<number | null>(null)

  const activeIdx = NAV.findIndex((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))

  useEffect(() => {
    const measure = () => {
      const tw = tabsRef.current
      if (tw) {
        const el = tw.querySelector<HTMLElement>('[data-active="true"]')
        if (el) {
          const r = el.getBoundingClientRect()
          const pr = tw.getBoundingClientRect()
          const pad = 7
          setInd({
            left: r.left - pr.left + pad,
            width: Math.max(0, r.width - pad * 2),
            show: true,
          })
        } else {
          setInd((v) => ({ ...v, show: false }))
        }
      }
      const rw = railNavRef.current
      if (rw) {
        const el = rw.querySelector<HTMLElement>('[data-active="true"]')
        if (el) {
          const r = el.getBoundingClientRect()
          const pr = rw.getBoundingClientRect()
          setRailInd({ top: r.top - pr.top, height: r.height, show: true })
        } else {
          setRailInd((v) => ({ ...v, show: false }))
        }
      }
    }
    measure()
    const t = window.setTimeout(measure, 80)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('resize', measure)
    }
  }, [pathname])

  /* 切页时给两颗胶囊一段拉伸回弹，做出「液态」的手感 */
  useEffect(() => {
    if (activeIdx < 0) return
    const first = lastIdx.current === -1
    if (lastIdx.current === activeIdx) return
    lastIdx.current = activeIdx
    if (first) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const easing = 'cubic-bezier(.34,1.3,.5,1)'
    pillRef.current?.animate(
      [
        { transform: 'scaleX(1)' },
        { transform: 'scaleX(1.16)' },
        { transform: 'scaleX(0.97)' },
        { transform: 'scaleX(1)' },
      ],
      { duration: 470, easing },
    )
    railPillRef.current?.animate(
      [
        { transform: 'scaleY(1)' },
        { transform: 'scaleY(1.24)' },
        { transform: 'scaleY(0.96)' },
        { transform: 'scaleY(1)' },
      ],
      { duration: 470, easing },
    )
  }, [activeIdx])

  /* ---- 底栏拖拽：胶囊实时跟手，松手落到手指所在的 tab ---- */

  const onNavDown = (e: React.PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    dragRef.current = { startX: e.clientX, active: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }
  }

  const onNavMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const wrap = tabsRef.current
    if (!d || !wrap) return
    if (!d.active && Math.abs(e.clientX - d.startX) < 8) return
    d.active = true
    const pr = wrap.getBoundingClientRect()
    const half = ind.width / 2
    const x = Math.min(Math.max(e.clientX - pr.left - half, 0), Math.max(0, pr.width - ind.width))
    setDragX(x)
  }

  const onNavUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.active) {
      setDragX(null)
      return
    }
    suppressClick.current = true
    setDragX(null)
    const wrap = tabsRef.current
    if (!wrap) return
    const pr = wrap.getBoundingClientRect()
    const ratio = (e.clientX - pr.left) / pr.width
    const idx = Math.min(NAV.length - 1, Math.max(0, Math.floor(ratio * NAV.length)))
    const target = NAV[idx]
    if (target && target.to !== pathname) navigate(target.to)
  }

  useEffect(() => {
    touchStreak()
  }, [touchStreak])

  // 教室端在线状态靠心跳维持
  useClassroomPresence()
  // 上课前 10 分钟提醒
  useScheduleReminder()
  // 早上问候 / 当天完成的收尾
  const mood = useMood()
  /** 当前时刻（北京时间，按分钟）—— 用于右栏判断哪节课已结束 */
  const nowMin = mood.now.getHours() * 60 + mood.now.getMinutes()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    <div className="relative z-[1] mx-auto flex min-h-full w-full" style={{ maxWidth: 1220 }}>
      {/* 桌面左栏 —— 悬浮在画布之上的一层 */}
      <aside className="hidden shrink-0 lg:block" style={{ width: 266, paddingLeft: 14 }}>
        <div
          className="floating-rail sticky flex flex-col p-4"
          style={{ top: 14, height: 'calc(100vh - 28px)' }}
        >
          <div className="mb-4 flex items-center gap-2.5 px-1">
            <span
              className="grid place-items-center"
              style={{
                width: 34,
                height: 34,
                border: '1px solid var(--color-line2)',
                borderRadius: 6,
                background: 'var(--color-surface)',
                color: 'var(--color-accent)',
              }}
            >
              <Logo size={20} />
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 650, lineHeight: 1.2 }}>
                树高教师平台
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.06em' }}>
                TEACHER CONSOLE
              </span>
            </span>
          </div>

          <div className="rail-block">
            <div style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.08em' }}>
              当前身份
            </div>
            <div className="mt-1 flex items-center gap-2">
              <span style={{ fontSize: 15, fontWeight: 620 }}>{teacher?.name ?? '未登录'}</span>
              <span className="tag tag-accent">{teacher?.subject ?? '物理'}</span>
            </div>
            <div
              className="mt-2.5"
              style={{ borderTop: '1px solid var(--color-line)', paddingTop: 8 }}
            >
              <div style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.08em' }}>
                当前班级
              </div>
              <select
                className="input mt-1"
                style={{ height: 34, fontSize: 13 }}
                value={currentClassId ?? ''}
                onChange={(e) => setCurrentClass(e.target.value || null)}
              >
                {classes.length === 0 ? <option value="">暂无班级</option> : null}
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <nav
            ref={railNavRef}
            className="relative mt-3 flex flex-1 flex-col gap-0.5 pt-3"
            style={{ borderTop: '1px solid var(--color-line)' }}
          >
            <span
              ref={railPillRef}
              className="rail-pill"
              style={{
                top: railInd.top,
                height: railInd.height,
                opacity: railInd.show ? 1 : 0,
              }}
            />
            {NAV.map((n) => (
              <RailItem key={n.to} {...n} />
            ))}
          </nav>

          <div
            className="mt-3 flex flex-col gap-2 px-1 pt-3"
            style={{ borderTop: '1px solid var(--color-line)' }}
          >
            <div
              className="flex items-center gap-2"
              style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              <span
                className="live-dot"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: isDemo ? 'var(--color-warn)' : 'var(--color-ok)',
                  display: 'inline-block',
                }}
              />
              {isDemo ? '本地演示数据' : '本地存储 · 未接后端'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
              S1–S5 全部完成 · {current?.students.length ?? 0} 名学生
            </div>
          </div>
        </div>
      </aside>

      {/* 主列 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 —— 液态玻璃 */}
        <header
          className="glass sticky top-0 z-30 flex items-center gap-2 px-4 lg:hidden"
          style={{ height: 50, borderBottom: '1px solid var(--color-line)' }}
        >
          <span className="flex items-center gap-2">
            <span style={{ color: 'var(--color-accent)', display: 'grid', placeItems: 'center' }}>
              <Logo size={19} />
            </span>
            <span style={{ fontSize: 14.5, fontWeight: 650 }}>树高教师平台</span>
          </span>
          <span className="flex-1" />
          {current ? (
            <button
              type="button"
              onClick={() => setSwitching(true)}
              className="tag tag-idle flex items-center gap-1"
              style={{ height: 23, cursor: 'pointer' }}
              aria-label="切换班级"
            >
              {current.name}
              <span
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  transform: 'rotate(90deg)',
                  opacity: 0.55,
                }}
              >
                <IconChevronRight size={11} />
              </span>
            </button>
          ) : null}
        </header>

        <main key={pathname} className="page-enter flex-1 pb-24 lg:pb-8">
          {syncError ? (
            <button
              type="button"
              onClick={clearSyncError}
              className="anim-in mb-3 flex w-full items-start gap-2.5 p-3 text-left"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1, flexShrink: 0 }}>
                <IconAlert size={16} />
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 620, color: '***REMOVED***8a5a12' }}>
                  数据没能存到服务器
                </span>
                <span style={{ display: 'block', fontSize: 11.5, color: '***REMOVED***96702f', marginTop: 2 }}>
                  {syncError} · 网络恢复后重新操作一次即可，本地已保留
                </span>
              </span>
              <span style={{ fontSize: 11.5, color: '***REMOVED***96702f', flexShrink: 0 }}>知道了</span>
            </button>
          ) : null}
          {children}
        </main>
      </div>

      {/* 桌面右栏 —— 平铺在画布上，不做悬浮，免得中间那列被两侧挤住 */}
      <aside className="hidden shrink-0 xl:block" style={{ width: 260 }}>
        <div
          className="sticky flex flex-col gap-3 overflow-y-auto py-4 pl-1 pr-4"
          style={{ top: 0, height: '100vh' }}
        >
          <ClockPanel />

          <section className="panel p-3">
            <div className="mb-2.5 flex items-center gap-2">
              <span style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}>
                名单体检
              </span>
              <span className="flex-1" />
              <IconHash size={14} />
            </div>
            <div className="flex flex-col gap-2.5">
              {classes.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>还没有班级</div>
              ) : (
                classes.map((c) => {
                  const h = analyzeRoster(c.students)
                  const issues = h.gaps.length + h.dupNos.length + h.dupNames.length
                  return (
                    <div key={c.id} className="flex items-center gap-2">
                      <span
                        style={{
                          color: issues === 0 ? 'var(--color-ok)' : 'var(--color-warn)',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        {issues === 0 ? <IconCheck size={14} /> : <IconAlert size={14} />}
                      </span>
                      <span className="flex-1 truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                        {c.name}
                      </span>
                      <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                        {h.count} 人
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          {/* 当天日程 —— 右栏最该看的东西 */}
          <section className="panel p-3">
            <div className="mb-2 flex items-center gap-2">
              <span style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}>
                当天日程
              </span>
              <span className="flex-1" />
              <span className="num" style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
                {WEEKDAY_TEXT[weekdayOf(mood.now) - 1]}
              </span>
            </div>

            {mood.day.items.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                今天没有排课。
              </div>
            ) : (
              mood.day.items.map((it, i) => {
                const done = toMinutes(it.end) <= nowMin
                const live = mood.day.current?.id === it.id
                const next = mood.day.next?.id === it.id
                const last = i === mood.day.items.length - 1
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-2.5 py-1.5"
                    style={{
                      borderBottom: last ? undefined : '1px solid var(--color-line)',
                      opacity: done ? 0.42 : 1,
                    }}
                  >
                    <span
                      className="num shrink-0"
                      style={{
                        width: 38,
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: live || next ? 'var(--color-accent)' : 'var(--color-ink2)',
                      }}
                    >
                      {it.start}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                        {it.title}
                      </span>
                      {it.room ? (
                        <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>{it.room}</span>
                      ) : null}
                    </span>
                    {live ? (
                      <Tag tone="ok">进行中</Tag>
                    ) : next && mood.day.minutesToNext !== null ? (
                      <Tag tone="accent">{awayText(mood.day.minutesToNext)}</Tag>
                    ) : null}
                  </div>
                )
              })
            )}

            <button
              type="button"
              onClick={() => navigate('/schedule')}
              className="mt-2.5 flex w-full items-center gap-1.5"
              style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
            >
              <IconCalendar size={13} />
              <span>{mood.day.items.length ? '调整课表' : '去录入课表'}</span>
              <span className="flex-1" />
              <IconChevronRight size={13} />
            </button>
          </section>

          <div
            className="mt-auto flex items-center gap-2 px-1 pt-2"
            style={{ fontSize: 11, color: 'var(--color-ink4)' }}
          >
            <IconInfo size={13} />
            <span>v0.6.0 · S1–S5</span>
          </div>
        </div>
      </aside>

      {/* 移动端底部导航 —— 磨砂玻璃 + 液态玻璃胶囊 */}
      <nav
        className="nav-frost fixed inset-x-0 bottom-0 z-40 lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div
          ref={tabsRef}
          className="relative mx-auto flex"
          style={{ maxWidth: 640, touchAction: 'pan-y' }}
          onPointerDown={onNavDown}
          onPointerMove={onNavMove}
          onPointerUp={onNavUp}
          onPointerCancel={onNavUp}
          onClickCapture={(e) => {
            if (suppressClick.current) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
        >
          <span
            ref={pillRef}
            className="tab-pill"
            style={{
              left: dragX ?? ind.left,
              width: ind.width,
              opacity: ind.show ? 1 : 0,
              transition: dragX !== null ? 'none' : undefined,
            }}
          />
          {NAV.map((n) => (
            <TabItem key={n.to} {...n} />
          ))}
        </div>
      </nav>

      {/* 切换班级 */}
      <Sheet
        open={switching}
        onClose={() => setSwitching(false)}
        title="切换班级"
        footer={
          <Button
            block
            onClick={() => {
              setSwitching(false)
              navigate('/classes')
            }}
          >
            管理班级
          </Button>
        }
      >
        <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginBottom: 8, lineHeight: 1.65 }}>
          切换后，「作业」「班级」等页面默认就按这个班来。
        </div>
        <div className="overflow-hidden" style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}>
          {classes.map((c, i) => {
            const on = c.id === currentClassId
            const active = c.students.filter((s) => s.status === 'active').length
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCurrentClass(c.id)
                  setSwitching(false)
                  push({ text: `已切到 ${c.name}`, tone: 'ok' })
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                style={{
                  borderBottom: i === classes.length - 1 ? undefined : '1px solid var(--color-line)',
                  background: on ? 'var(--color-accentsoft)' : 'transparent',
                }}
              >
                <span
                  className="grid shrink-0 place-items-center"
                  style={{
                    width: 32,
                    height: 32,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 4,
                    background: 'var(--color-surface2)',
                    color: on ? 'var(--color-accent)' : 'var(--color-ink2)',
                  }}
                >
                  <IconUsers size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate"
                    style={{
                      fontSize: 14,
                      fontWeight: on ? 660 : 560,
                      color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                    }}
                  >
                    {c.name}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    <span className="num">{active}</span> 名学生
                  </span>
                </span>
                {on ? (
                  <span style={{ color: 'var(--color-accent)', display: 'grid', placeItems: 'center' }}>
                    <IconCheck size={16} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </Sheet>

      {/* 情绪价值的两个时刻 */}
      <MorningWelcome
        open={mood.welcomeOpen}
        onClose={mood.closeWelcome}
        teacherName={teacher?.name ?? '老师'}
        greeting={mood.greeting}
        countdown={mood.countdown}
        pending={mood.pending}
        classes={classes}
        today={mood.day.items}
        weekdayText={WEEKDAY_TEXT[weekdayOf(mood.now) - 1]}
      />
      <DoneCelebration
        open={mood.doneOpen}
        onClose={mood.closeDone}
        countdown={mood.soonCountdown}
      />
    </div>
  )
}

/* ---------------- 页面容器 ---------------- */

export function Page({
  children,
  className,
  wide,
}: {
  children: React.ReactNode
  className?: string
  wide?: boolean
}) {
  return (
    <div
      className={cx('mx-auto w-full px-4 py-4', className)}
      style={{ maxWidth: wide ? 900 : 640 }}
    >
      {children}
    </div>
  )
}
