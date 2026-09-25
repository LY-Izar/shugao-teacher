import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT } from '../data/types'
import { useClassroomPresence } from '../hooks/useClassroomPresence'
import { useMood } from '../hooks/useMood'
import { useScheduleReminder } from '../hooks/useScheduleReminder'
import { analyzeRoster } from '../lib/roster'
import { currentIdentityLabel, IDENTITY_TAG_STYLE } from '../lib/roles'
import { awayText, toMinutes, weekdayOf } from '../lib/schedule'
import { connectionMode } from '../lib/supabase'
import { APP_VERSION_LABEL } from '../lib/version'
import { DoneCelebration, MorningWelcome } from './MoodModals'
import {
  IconAlert,
  IconCalendar,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGauge,
  IconHash,
  IconInfo,
  IconSend,
  IconTarget,
  IconUser,
  IconUsers,
  Logo,
} from './icons'
import { Button, Sheet, Tag } from './ui'
import { cx } from '../lib/cx'

/**
 * 全部入口。**桌面左栏按这个顺序全摆**（一行文字 + 图标）；
 * 移动端只把其中三个放进悬浮胶囊，其余收进「更多入口」——
 * 哪三个见下面的 `PIN_KEYS`（形态与理由见 `功能设计与不变量.md` §十五）。
 */
const NAV = [
  { to: '/', label: '工作台', icon: IconGauge, end: true },
  { to: '/classes', label: '班级', icon: IconUsers, end: false },
  { to: '/assignments', label: '作业', icon: IconClipboard, end: false },
  /*
   * 考试（`功能设计与不变量.md` §十四）。两条纪律：
   *  · `end: false` —— `/exams/new`、`/exams/:id/grade`、`/exams/:id/stats`
   *    都要让「考试」保持选中（同 §11.1 里错题集那条）。
   *  · 它**不在** `PIN_KEYS` 里 → 移动端默认收进「更多入口」。
   *    这是刻意的：胶囊里那三个是每天来回切的；考试是"考完那一两天进去"的。
   */
  { to: '/exams', label: '考试', icon: IconChart, end: false },
  { to: '/wrong', label: '错题集', icon: IconTarget, end: false },
  /*
   * 教师的**个人排课表**（`schedule_items.scope='mine'`）—— 显示名叫「日程表」。
   *
   * 为什么改这个名（2026-09-27 用户拍板）：平台里有**两套**课表，
   *   · `scope='mine'`  —— 我什么时候上哪个班（这一条入口）；
   *   · `scope='class'` —— 班级课表，贴在教室里给学生看，教师端只读（§七 7.2）。
   * 两套都叫"课表"时，老师根本分不清说的是哪一份。
   * ⚠️ **只改了显示名与入口位置**：`scope` 的取值、过滤、写入一个字都没动
   *    （`schedule_items.scope` 的 check 只有 `'mine'` / `'class'`）。
   */
  { to: '/schedule', label: '日程表', icon: IconCalendar, end: false },
  { to: '/settings', label: '我的', icon: IconUser, end: false },
]

/**
 * 移动端胶囊里的三个（顺序即胶囊里的排列顺序）：工作台 / 作业 / 我的。
 *
 * 判据是**频次**：这三条是每天要来回切的；班级与错题集是"进去待一会儿"的，
 * 收进更多入口。以后往 NAV 里加新入口，默认会落到「更多入口」里 —— 这是**故意**的兜底：
 * 新入口宁可在展开层多一步，也别把胶囊挤成"一排又小又密的按钮"（那正是上一轮改掉的东西）。
 */
const PIN_KEYS = ['/', '/assignments', '/settings']
const PINNED = NAV.filter((n) => PIN_KEYS.includes(n.to))
const COLLAPSED = NAV.filter((n) => !PIN_KEYS.includes(n.to))

const MORE_HINT: Record<string, string> = {
  '/classes': '花名册 · 拍照录入 · 名单体检',
  '/exams': '导入成绩单 · 手动批阅 · 逐题统计',
  '/wrong': '按班级看错题 · 生成重练题卷',
  '/schedule': '我什么时候上哪个班 · 上课前提醒',
}

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

/* ============================================================
   移动端导航：悬浮的深色玻璃控件（两件，彼此分开）

   形态（用户给的图 + `功能设计与不变量.md` §十五）：

        ┌───────────────────┐        ╭─────╮
        │  ♥    ▣✎    ⌕     │        │  ✈  │      ← 全圆按钮 = 展开其余入口
        └───────────────────┘        ╰─────╯
         12 圆角胶囊 · 三个图标          独立、不连着

   三条不能破的：
   ① 每个图标 **48×48**（≥44px，手指点的东西不许更小）；
   ② 只放图标、**不放文字标签**，所以必须有 `aria-label`（无障碍名 = 原来的文字）；
   ③ 悬浮在内容之上、**不贴底边**；容器 `pointer-events-none`，
      只有胶囊与圆按钮本身可点 —— 中间那段空隙要能点穿到页面上去。
   ============================================================ */

/** 胶囊里的一个图标：可点区域 48×48，当前页高亮由父级的滑动胶囊负责。 */
function PinTab({ to, label, icon: Icon, end }: (typeof NAV)[number]) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      /* 🔴 链接默认是**可拖拽**的：在胶囊上按住横向滑动时，浏览器会改为拖这个链接
         （HTML5 拖放），指针事件直接停掉 —— 滑动跟手就永远不会发生（鼠标上必现）。
         关掉它，滑动才拿得到 pointermove。见 §十五 */
      draggable={false}
      className="relative block shrink-0"
      style={{ width: 48, height: 48 }}
    >
      {({ isActive }) => (
        <span
          data-active={isActive}
          className="grid h-full w-full place-items-center"
          style={{
            color: isActive ? '***REMOVED***fff' : 'rgb(255 255 255 / .62)',
            transition: 'color .22s cubic-bezier(.22,.8,.24,1)',
          }}
        >
          <span
            className={isActive ? 'tab-icon-on' : undefined}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <Icon size={22} strokeWidth={isActive ? 1.9 : 1.6} />
          </span>
        </span>
      )}
    </NavLink>
  )
}

function MobileNav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  /**
   * 「更多入口」的展开态：记的是**打开它的那个路径**，而不是一个布尔。
   * 这样"换了页面就自动收起"是**推导**出来的（路径一变 `more` 立刻为 false），
   * 既不用在 effect 里 setState，浏览器前进/后退回来时也不会莫名弹着一张浮层。
   */
  const [moreAt, setMoreAt] = useState<string | null>(null)
  const more = moreAt === pathname

  /* 当前页在胶囊里 → 高亮滑到那一格；在「更多入口」里 → 圆按钮加一圈暖黄描边 */
  const pinIdx = PINNED.findIndex((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))
  const moreActive = COLLAPSED.some((n) =>
    n.end ? pathname === n.to : pathname.startsWith(n.to),
  )

  const pillRef = useRef<HTMLDivElement>(null)
  const hiRef = useRef<HTMLSpanElement>(null)
  const lastIdx = useRef(-1)
  const [hi, setHi] = useState({ left: 4, width: 48, show: false })

  /* 高亮块的落点靠**量**（不写死 48×序号）：字号/间距将来变了也不会错位 */
  useEffect(() => {
    const measure = () => {
      const wrap = pillRef.current
      if (!wrap) return
      const el = wrap.querySelector<HTMLElement>('[data-active="true"]')
      if (!el) {
        setHi((v) => ({ ...v, show: false }))
        return
      }
      const r = el.getBoundingClientRect()
      const pr = wrap.getBoundingClientRect()
      /* 绝对定位的 `left` 是相对**内边距盒**算的，所以要减掉左边框那 1px */
      setHi({ left: r.left - pr.left - wrap.clientLeft, width: r.width, show: true })
    }
    measure()
    const t = window.setTimeout(measure, 80)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('resize', measure)
    }
  }, [pathname])

  /* 切页时给高亮块一段拉伸回弹（液态手感，与桌面左栏同一套缓动） */
  useEffect(() => {
    if (pinIdx < 0) return
    const first = lastIdx.current === -1
    if (lastIdx.current === pinIdx) return
    lastIdx.current = pinIdx
    if (first) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    hiRef.current?.animate(
      [
        { transform: 'scaleX(1)' },
        { transform: 'scaleX(1.16)' },
        { transform: 'scaleX(0.97)' },
        { transform: 'scaleX(1)' },
      ],
      { duration: 470, easing: 'cubic-bezier(.34,1.3,.5,1)' },
    )
  }, [pinIdx])

  /* ---- 在胶囊上滑动：高亮跟手，松手落到手指最近的那一格 ---- */

  const dragRef = useRef<{
    startX: number
    active: boolean
    boxes: Array<{ left: number; width: number }>
  } | null>(null)
  const suppressClick = useRef(false)
  const [dragX, setDragX] = useState<number | null>(null)

  /** 胶囊内边距盒在视口里的左边缘（滑动的坐标系原点） */
  const pillOrigin = (wrap: HTMLElement) => wrap.getBoundingClientRect().left + wrap.clientLeft

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    const wrap = pillRef.current
    if (!wrap) return
    const origin = pillOrigin(wrap)
    const boxes = Array.from(wrap.querySelectorAll<HTMLElement>('a')).map((a) => {
      const r = a.getBoundingClientRect()
      return { left: r.left - origin, width: r.width }
    })
    dragRef.current = { startX: e.clientX, active: false, boxes }
    /*
     * 🔴 **这里不能 setPointerCapture**：一旦在 pointerdown 就捕获，
     * pointerup / mouseup / click 会被**重定向到胶囊本身**，里面的 <NavLink> 永远收不到 click
     * —— 表现为"点图标没反应"（真机上点一下什么都不会发生）。已实测踩过，见 §十五。
     * 指针捕获改成**滑动超过阈值时**才拿（那时本来也不该触发点击）。
     */
  }

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const wrap = pillRef.current
    if (!d || !wrap) return
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < 8) return
      d.active = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* 忽略 */
      }
    }
    const half = hi.width / 2
    const max = Math.max(4, wrap.clientWidth - 4 - hi.width)
    setDragX(Math.min(Math.max(e.clientX - pillOrigin(wrap) - half, 4), max))
  }

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d?.active) {
      setDragX(null)
      return
    }
    suppressClick.current = true
    setDragX(null)
    const wrap = pillRef.current
    if (!wrap) return
    const x = e.clientX - pillOrigin(wrap)
    let idx = 0
    let best = Infinity
    d.boxes.forEach((b, i) => {
      const dist = Math.abs(x - (b.left + b.width / 2))
      if (dist < best) {
        best = dist
        idx = i
      }
    })
    const target = PINNED[idx]
    if (target && target.to !== pathname) navigate(target.to)
  }

  return (
    <>
      <nav
        aria-label="主导航"
        className="pointer-events-none fixed inset-x-0 z-40 lg:hidden"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
      >
        {/*
         * 这一行**只包住两个控件**（fit-content + 居中），不铺满整屏：
         * ① 它中间那段空隙要让点击穿过去（父级是 pointer-events-none）；
         * ② `scripts/shots.mjs` 的拖拽回归按 `nav > div` 取拖拽区，宽度等于控件本身才对得上。
         */}
        <div
          className="mx-auto flex items-center gap-3"
          style={{ width: 'fit-content', maxWidth: 640, padding: '0 16px' }}
        >
          {/* ① 胶囊：工作台 / 作业 / 我的 —— 半透明深色玻璃、细描边、12 圆角 */}
          <div
            ref={pillRef}
            className="glass-dark pointer-events-auto relative flex items-center"
            style={{
              /* 58 = 1 边框 + 4 内边距 + 48 图标格 + 4 + 1（box-sizing 是 border-box） */
              height: 58,
              padding: 4,
              borderRadius: 12,
              border: '1px solid rgb(255 255 255 / .18)',
              touchAction: 'pan-y',
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onClickCapture={(e) => {
              if (suppressClick.current) {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
          >
            {/* 当前页那一格：跟着手指走的一块玻璃 */}
            <span
              ref={hiRef}
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: 4,
                bottom: 4,
                left: dragX ?? hi.left,
                width: hi.width,
                borderRadius: 12,
                background:
                  'linear-gradient(180deg, rgb(255 255 255 / .24), rgb(255 255 255 / .12))',
                border: '1px solid rgb(255 255 255 / .22)',
                boxShadow: 'inset 0 1px 0 rgb(255 255 255 / .3)',
                opacity: hi.show ? 1 : 0,
                pointerEvents: 'none',
                willChange: 'left, width, transform',
                transition:
                  dragX !== null
                    ? 'none'
                    : 'left .44s cubic-bezier(.34,1.32,.5,1), width .44s cubic-bezier(.34,1.32,.5,1), opacity .2s',
              }}
            />
            {PINNED.map((n) => (
              <PinTab key={n.to} {...n} />
            ))}
          </div>

          {/* ② 圆按钮：展开其余入口。和胶囊**分开**，不连着 */}
          <button
            type="button"
            onClick={() => setMoreAt(more ? null : pathname)}
            aria-label="展开更多入口"
            aria-expanded={more}
            aria-haspopup="dialog"
            title="更多入口"
            className="glass-dark pointer-events-auto grid shrink-0 place-items-center"
            style={{
              /* 与胶囊等高（58），全圆 */
              width: 58,
              height: 58,
              borderRadius: 999,
              border: '1px solid rgb(255 255 255 / .18)',
              color: '***REMOVED***f5c469',
              /* 当前页在展开层里时描一圈同色暖黄，免得"高亮不见了" */
              outline:
                more || moreActive ? '2px solid rgb(245 196 105 / .5)' : '2px solid transparent',
              outlineOffset: 3,
              transition: 'outline-color .2s',
            }}
          >
            <IconSend size={24} fill="currentColor" />
          </button>
        </div>
      </nav>

      {/* 展开：其余入口（班级 / 错题集 …）。一行 52px，够手指点 */}
      <Sheet
        open={more}
        onClose={() => setMoreAt(null)}
        title="更多入口"
        footer={
          <Button block onClick={() => setMoreAt(null)}>
            收起
          </Button>
        }
      >
        <div
          className="overflow-hidden"
          style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}
        >
          {COLLAPSED.map((n, i) => {
            const on = n.end ? pathname === n.to : pathname.startsWith(n.to)
            const Icon = n.icon
            return (
              <button
                key={n.to}
                type="button"
                onClick={() => {
                  setMoreAt(null)
                  navigate(n.to)
                }}
                className="flex w-full items-center gap-3 px-3 text-left"
                style={{
                  minHeight: 52,
                  borderBottom:
                    i === COLLAPSED.length - 1 ? undefined : '1px solid var(--color-line)',
                  background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                }}
              >
                <span
                  className="grid shrink-0 place-items-center"
                  style={{
                    width: 34,
                    height: 34,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 4,
                    background: 'var(--color-surface2)',
                    color: on ? 'var(--color-accent)' : 'var(--color-ink2)',
                  }}
                >
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate"
                    style={{
                      fontSize: 14.5,
                      fontWeight: on ? 660 : 560,
                      color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                    }}
                  >
                    {n.label}
                  </span>
                  {MORE_HINT[n.to] ? (
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      {MORE_HINT[n.to]}
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    color: on ? 'var(--color-accent)' : 'var(--color-ink4)',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {on ? <IconCheck size={16} /> : <IconChevronRight size={16} />}
                </span>
              </button>
            )
          })}
        </div>
        <p
          style={{
            fontSize: 11.5,
            color: 'var(--color-ink3)',
            marginTop: 10,
            lineHeight: 1.7,
          }}
        >
          工作台 / 作业 / 我的 在底部那颗胶囊里；这一层装的是其余入口。
        </p>
      </Sheet>
    </>
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
  /*
   * 「当前身份」那个标签：**有管理身份先显示身份，没有才显示学科**。
   * `myRoles` 只覆盖"我自己" —— 而这个标签显示的正是当前登录者，够用（见 lib/roles.ts）。
   * 它**只是显示**：判据一律在数据库（§13.5 I16）。
   */
  const myRoles = useStore((s) => s.myRoles)
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
  const mode = connectionMode()
  const totalStudents = classes.reduce(
    (n, c) => n + c.students.filter((s) => s.status === 'active').length,
    0,
  )
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const current = classes.find((c) => c.id === currentClassId)

  /*
   * 桌面左栏的液态玻璃胶囊：量出激活项的位置，让胶囊滑过去。
   * 移动端那颗悬浮胶囊由 `MobileNav` 自己管（两份状态各自独立 —— 两个端从不同时出现）。
   */
  const railNavRef = useRef<HTMLElement>(null)
  const railPillRef = useRef<HTMLSpanElement>(null)
  const lastIdx = useRef(-1)
  const [railInd, setRailInd] = useState({ top: 0, height: 40, show: false })

  const activeIdx = NAV.findIndex((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))

  useEffect(() => {
    const measure = () => {
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

  /* 切页时给左栏胶囊一段拉伸回弹，做出「液态」的手感 */
  useEffect(() => {
    if (activeIdx < 0) return
    const first = lastIdx.current === -1
    if (lastIdx.current === activeIdx) return
    lastIdx.current = activeIdx
    if (first) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    railPillRef.current?.animate(
      [
        { transform: 'scaleY(1)' },
        { transform: 'scaleY(1.24)' },
        { transform: 'scaleY(0.96)' },
        { transform: 'scaleY(1)' },
      ],
      { duration: 470, easing: 'cubic-bezier(.34,1.3,.5,1)' },
    )
  }, [activeIdx])

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
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {/*
                ⚠️ 姓名这一格必须 `white-space: nowrap`：标签是 `nowrap` 又有 `min-width: auto`，
                不禁住姓名的话，多身份时被压缩的是**姓名**（「王老师」会变成竖排三个字，实测）。
                折行交给容器（`flex-wrap`），标签内部只在分隔符处折 —— 见 IDENTITY_TAG_STYLE。
              */}
              <span style={{ fontSize: 15, fontWeight: 620, whiteSpace: 'nowrap' }}>
                {teacher?.name ?? '未登录'}
              </span>
              {/*
                学科是"教什么"，身份是"是谁" —— 有管理身份的人先答"是谁"。
                ⛔ 别退回 `teacherSubjectLabel(teacher)`：`teachers.subject` 有列默认值
                「物理」，每个账号都有值，管理员会被挂上"物理"（2026-09-25 用户截图）。
              */}
              <span className="tag tag-accent" style={IDENTITY_TAG_STYLE}>
                {currentIdentityLabel(myRoles, teacher)}
              </span>
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
            <button
              type="button"
              onClick={() => navigate('/settings')}
              className="flex items-center gap-2 text-left"
              style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              <span
                className={mode === 'remote' ? 'live-dot' : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  display: 'inline-block',
                  background:
                    mode === 'remote'
                      ? 'var(--color-ok)'
                      : isDemo
                        ? 'var(--color-warn)'
                        : 'var(--color-ink4)',
                }}
              />
              {mode === 'remote' ? '已连接云端' : isDemo ? '本地演示数据' : '本地存储 · 未接后端'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
              {classes.length} 个班级 · {totalStudents} 名学生
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
              <span>{mood.day.items.length ? '调整日程' : '去录入日程'}</span>
              <span className="flex-1" />
              <IconChevronRight size={13} />
            </button>
          </section>

          <div
            className="mt-auto flex items-center gap-2 px-1 pt-2"
            style={{ fontSize: 11, color: 'var(--color-ink4)' }}
          >
            <IconInfo size={13} />
            <span>{APP_VERSION_LABEL}</span>
          </div>
        </div>
      </aside>

      {/* 移动端导航 —— 悬浮的深色玻璃胶囊 + 展开按钮（形态见 MobileNav 上方的说明） */}
      <MobileNav />

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
