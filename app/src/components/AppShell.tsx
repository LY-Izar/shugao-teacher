import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT, type TeacherRole } from '../data/types'
import { useClassroomPresence } from '../hooks/useClassroomPresence'
import { useMood } from '../hooks/useMood'
import { useScheduleReminder } from '../hooks/useScheduleReminder'
import { analyzeRoster } from '../lib/roster'
import { currentIdentityLabel, ENTRIES, entryVisible, IDENTITY_TAG_STYLE } from '../lib/roles'
import { awayText, toMinutes, weekdayOf } from '../lib/schedule'
import { connectionMode } from '../lib/supabase'
import { APP_VERSION_LABEL } from '../lib/version'
import { DoneCelebration, MorningWelcome } from './MoodModals'
import { AnnouncementStack } from './AnnouncementStack'
import {
  IconAlert,
  IconBell,
  IconCalendar,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGauge,
  IconHash,
  IconInfo,
  IconTarget,
  IconUser,
  IconUsers,
  Logo,
  type IconProps,
} from './icons'
import { Button, Sheet, Tag } from './ui'
import { cx } from '../lib/cx'
import type { ComponentType } from 'react'

/**
 * 全部入口。**桌面左栏按这个顺序全摆**（一行文字 + 图标）；
 * 移动端只把其中三个放进悬浮胶囊，其余收进「更多入口」——
 * 哪三个见下面的 `PIN_KEYS`（形态与理由见 `功能设计与不变量.md` §十五）。
 *
 * 🔴 **这个数组是"全部入口"，不是"这个人看得见的入口"** ——
 * `to` 就是 `lib/roles.ts` 的 `ENTRIES` 里的 key（`ENTRY_KEY_OF` 核对过），
 * 过滤发生在**取数那一层**（`visibleNav()`），不在数组里。
 * 别把某个角色看不见的项从这里删掉：删了就没有任何一处能说明"它对谁摆"了。
 */
type NavItem = {
  to: (typeof NAV_KEYS)[number]
  label: string
  icon: ComponentType<IconProps>
  end: boolean
}

/**
 * `NAV` 的 key 白名单（= `lib/roles.ts` 里 `ENTRIES` 有的那些）。
 *
 * 为什么要单独列一行而不是直接写 `EntryKey`：`NAV` 只装**桌面左栏里摆的**入口
 * （工作台 / 班级 / 作业 / 考试 / 错题集 / 日程表 / 通知 / 我的），
 * 而 `ENTRIES` 里还有 `/accounts`、`/files`、`/calls`、`/notices/new`
 * 这些"入口不在 NAV 里"的（它们在「我的」页或通知页里，见方案 §2.4）。
 * 两者是**包含关系**，不是相等。
 *
 * 🆕 2026-09-28 加 `/notices`（方案 §四.2 第 18 行：**所有老师都是 V**）——
 *    这是 `NAV` 从 7 项变成 8 项的那一次；`PIN_KEYS` **一个字没动**
 *    （胶囊里那三个仍是"每天来回切"的那三个，见下）。
 */
const NAV_KEYS = [
  '/',
  '/classes',
  '/assignments',
  '/exams',
  '/wrong',
  '/schedule',
  '/notices',
  '/settings',
] as const

const NAV: NavItem[] = [
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
  /*
   * 🆕 通知（2026-09-28）。放在日程表与「我的」之间：它是"学校对老师说话"，
   * 频次高于「我的」、低于那三个每天来回切的 —— 所以它**不进 `PIN_KEYS`**
   * （新入口宁可在展开层多一步，也别把胶囊挤成一排又小又密的按钮）。
   * ⚠️ `end: true` 是**故意**的：`/notices/new` 是"进去写一条、写完就走"的动作页，
   *    它**不该**让左栏的「通知」一直高亮着（`end:false` 会让 `/notices/new`
   *    也把「通知」点亮）。同一条判断在移动端展开层里由 `n.end` 复用。
   */
  { to: '/notices', label: '通知', icon: IconBell, end: true },
  { to: '/settings', label: '我的', icon: IconUser, end: false },
]

/**
 * 移动端胶囊里的三个（顺序即胶囊里的排列顺序）：工作台 / 作业 / 我的。
 *
 * 判据是**频次**（`功能设计与不变量.md` §15.2），**不是权限**：
 * 这三条是每天要来回切的；班级与错题集是"进去待一会儿"的，
 * 收进更多入口。以后往 NAV 里加新入口，默认会落到「更多入口」里 —— 这是**故意**的兜底：
 * 新入口宁可在展开层多一步，也别把胶囊挤成"一排又小又密的按钮"（那正是上一轮改掉的东西）。
 *
 * 🔴 按身份过滤（N1）**不改这个数组**：过滤发生在它**之前**（`visibleNav()`）。
 *    权限不该改频次判断 —— 一个入口对某身份不摆，就不摆；
 *    摆着的那几个**位置不动**（N2：过滤后胶囊里某一格空着，不补位，
 *    否则"三个图标的位置"会随身份漂移，而 `shots.mjs` 的 38/39 两张图是按位置拖拽的）。
 */
const PIN_KEYS = ['/', '/assignments', '/settings']

/**
 * **按身份过滤后的入口**（唯一的一处：桌面左栏 / 移动端胶囊 / 展开层共用它）。
 *
 * ⚠️ 过滤必须在**取数这一层**，且必须在 `PIN_KEYS` 之前（方案 §4.1/§4.3）：
 *    `activeIdx` / `pinIdx` / `moreActive` **三处都是按索引或按 `pathname.startsWith`
 *    算的**，过滤之后必须**一起**换成这个数组，否则"当前页高亮"会在某个角色下
 *    悄悄错位（那正是 `shots.mjs` 里 38/39 两张图在量的东西）。
 *
 * ⚠️ 它**只读 `myRoles` 一个参数**（M2）：不读 store、不读 classes ——
 *    "看得见几个班"是 RLS 的事，读它来算入口就是前端在做权限判断。
 */
function visibleNav(myRoles: readonly TeacherRole[] | null | undefined): NavItem[] {
  return NAV.filter((n) => entryVisible(n.to, myRoles))
}

/**
 * 胶囊 / 展开层的两份（过滤在 `PIN_KEYS` **之前**，且只有这一处）。
 *
 * ⚠️ 返回的是**两份**而不是"过滤后的 PIN_KEYS"：`PIN_KEYS` 的顺序即胶囊里的排列顺序，
 *    而展开层要的是 `NAV` 的顺序 —— 两个顺序故意不同，别合并成一个数组。
 */
function splitPin(visible: NavItem[]): { pinned: NavItem[]; collapsed: NavItem[] } {
  const isPin = (to: string) => (PIN_KEYS as readonly string[]).includes(to)
  return {
    pinned: visible.filter((n) => isPin(n.to)),
    collapsed: visible.filter((n) => !isPin(n.to)),
  }
}

/**
 * `NAV` 的每一项都必须在 `ENTRIES` 里有对应规则 —— 没有的话
 * `ENTRIES[n.to]` 会在 `entryVisible()` 里直接抛异常（整页白屏）。
 *
 * ⚠️ 这是一个**模块级自检**，写在源码里而不是只写在脚本里：脚本能在提交前拦住，
 *    而这里能拦住"脚本没跑到的那条路"（比如有人只跑了 `vite dev`）。
 *    代价是一次 `Object.keys()`，可以忽略。
 */
for (const n of NAV) {
  if (!Object.prototype.hasOwnProperty.call(ENTRIES, n.to)) {
    throw new Error(`入口 ${n.to} 没有在 lib/roles.ts 的 ENTRIES 里登记（见按身份显示导航方案 §4.1）`)
  }
}

const MORE_HINT: Record<string, string> = {
  '/classes': '花名册 · 拍照录入',
  '/exams': '导入成绩单 · 手动批阅 · 逐题统计',
  '/wrong': '按班级看错题 · 生成重练题卷',
  // ⚠️ `/schedule` 那一行**故意没有**：它原来写的是"我什么时候上哪个班 · 上课前提醒"，
  //    而展开层里那一项本来就叫「日程表」—— 一行 11.5px 小字复读标题（用户 2026-09-29 拍板删）。
  //    渲染处 `MORE_HINT[n.to] ? … : null` 会自己跳过没有的那一项。
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

function RailItem({ to, label, icon: Icon, end, dot }: NavItem & { dot?: boolean }) {
  return (
    <NavLink to={to} end={end} className="block" aria-label={label} data-nav={to}>
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
            className={cx('relative', isActive && 'tab-icon-on')}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <Icon size={18} />
            {dot ? <UnreadDot /> : null}
          </span>
          {label}
        </span>
      )}
    </NavLink>
  )
}

/**
 * 🆕 **未读小红点**（2026-09-28 通知）。
 *
 * 🔴 **它不显示条数** —— 那是刻意的（`管理架构与角色权限方案.md` §九.7 的"未读红点的实现口径"）：
 *    "3"这个数字会让人以为是**待办**（三件事要做），而通知不是待办。
 *    只显示"有新通知"这一点。
 * 🔴 未读的判据**只有一处**：`createdAt > 我上次看到哪儿`（`teachers.notice_seen_at`）。
 *    这里读的就是那个值，不在界面层另算一遍（I49）。
 * ⚠️ 它挂在**图标**的右上角，不挂在文字后面 —— 桌面左栏与移动端胶囊共用同一处实现，
 *    免得两处各写一个（"同一件事两个判定入口"是本仓库踩过四次的坑）。
 */
function UnreadDot() {
  return (
    <i
      data-unread-dot
      aria-label="有新通知"
      style={{
        position: 'absolute',
        top: -1,
        right: -2,
        width: 7,
        height: 7,
        borderRadius: 99,
        background: 'var(--color-accent)',
        boxShadow: '0 0 0 1.5px var(--color-surface)',
      }}
    />
  )
}

/* ============================================================
   移动端导航：悬浮的**亮色**液态玻璃控件（两件，彼此分开）

   形态（用户给的图 + `功能设计与不变量.md` §十五）：

        ┌───────────────────┐        ╭─────╮
        │  ♥    ▣✎    ⌕     │        │  ⌃  │      ← 全圆按钮 = 展开其余入口
        └───────────────────┘        ╰─────╯         （未展开 ⌃ 朝上 / 已展开 ⌄ 朝下）
         12 圆角胶囊 · 三个图标          独立、不连着

   🔴 **底色是亮色**（2026-09-28 用户拍板）：全站 UI 都是亮色，只有这一块原来是深色玻璃，
      在亮色页面上像"另一个 App 的残留"。材料换成 `index.css` 的 `.glass-light`。
      ⚠️ 2026-09-28 **第二轮**又调过一次（用户「要这种按钮的质感，透明一点」+ 参考图）：
      白底 64%/48% → **20%/30%**、`blur` 22 → 28px、`saturate` 200% → **150%**，
      **边缘成了主角**（外圈亮描边 + 内圈更淡的一圈 = 玻璃厚度）。参数与实测见 §十五 15.1。

   🔴 **展开时整栏淡出**（2026-09-28 第二轮用户拍板：「点开后导航栏浮在上面会不会太奇怪了 /
      展开后整个导航栏淡出吧」）：`opacity: 0` + 两个子控件的 `pointer-events` 一起去掉，
      过渡 260ms 与 Sheet 的升降动画对齐。**上一轮"把 `<nav>` 抬到 z-52"的做法已回退**
      （现在恒 `z-40`）—— 详见 `<nav>` 上那段注释与 §十五 15.3。

   ⚠️ **换成亮底 / 再变透明之后，对比度都要重算**（这是这一轮最容易漏的地方）：
      · 胶囊里的图标：白 → **深色**（当前页 `--color-accentink`、其余 `--color-ink2`），
        且**沿图标形状描一圈很淡的浅色**（`ICON_HALO`）—— 玻璃透出深色内容时靠它保住辨识度；
      · 当前页那块高亮：白玻璃 → **近白 + 淡蓝描边**（`--color-accentsoft` 那一挂；
        第二轮又把它从"全不透明"降到半透明，免得它成了整条控件里最实的东西）；
      · 右侧圆按钮：深底上的暖黄 `***REMOVED***f5c469` → 亮底上**够深的强调色** `--color-accentink`。
      三个都按"玻璃合成底色"算过 WCAG 对比度，**又在真浏览器里按像素复核过
      （浅底 / 深底两组）**，具体数值与口径写在 §十五 15.1 的对比度表里。

   三条不能破的：
   ① 每个图标 **48×48**（≥44px，手指点的东西不许更小）；
   ② 只放图标、**不放文字标签**，所以必须有 `aria-label`（无障碍名 = 原来的文字）；
   ③ 悬浮在内容之上、**不贴底边**；容器 `pointer-events-none`，
      只有胶囊与圆按钮本身可点 —— 中间那段空隙要能点穿到页面上去。
   ============================================================ */

/**
 * 🔴 **图标的那圈浅色描边（halo）**—— 2026-09-28 第二轮"玻璃再透明一档"之后加的，别删。
 *
 * 理由（真浏览器实测，§十五 15.1 的对比度表里有数）：
 *   这一轮把白底从 64%/48% 压到 20%/30%（用户「透明一点」+ 参考图"白色只在边缘"），
 *   玻璃**透过深色内容**时不再是近白 —— 深色图标（`--color-ink2` ***REMOVED***4a5563 /
 *   `--color-accentink` ***REMOVED***0847c4）压在那块底上只剩 **1.27:1**（深底实测），等于消失。
 *
 * 为什么不给玻璃加"整体暗化"（那也能救对比度）：用户这一轮买的就是**透明**，
 *   加一层暗化等于把透出来的壁纸又抹掉一半，方向相反。
 *   而参考图里玻璃本身**几乎没有本体色**，靠的就是边缘 —— 所以把"边缘"这个概念
 *   从控件边缘延伸到**图标边缘**：沿图标形状（`drop-shadow` 跟 alpha 走，
 *   不是矩形）描一圈很淡的浅色，深色图标在深底上就有了"玻璃里的白边"。
 * ⚠️ 两处（胶囊图标 / 圆按钮箭头）用的是**同一串值**，改一处就得改另一处。
 */
const ICON_HALO = 'drop-shadow(0 0 0.6px rgb(255 255 255 / .9)) drop-shadow(0 0 1.4px rgb(255 255 255 / .45))'
/**
 * 胶囊里的一个图标：可点区域 48×48，当前页高亮由父级的滑动胶囊负责。
 *
 * ⚠️ 类型上带着可选的 `dot`（`pinned.map((n) => <PinTab key={n.to} {...n} />)` 会把
 *    `RailItem` 那一侧的 `dot` 一起传进来），但**胶囊里不画那个点**：
 *    胶囊只装三个"每天来回切"的入口，而通知**不在** `PIN_KEYS` 里 ——
 *    所以这里既不需要那个参数、也不该为它加分支（`dot` 只属于左栏与展开层）。
 *
 * 🔴 **图标是深色的**（2026-09-28 改亮色玻璃之后）：底从深色换成半透明浅色，
 *    原来那套"当前页白 / 其余 62% 白"在这块底上等于看不见。
 *    · 当前页 `--color-accentink`（***REMOVED***0847c4）—— 既是主色、又是本文最深的蓝，压在
 *      近白的页面上比 `--color-accent`（***REMOVED***0b5cf0）更稳；
 *    · 其余 `--color-ink2`（***REMOVED***4a5563）—— "未选中"应该是"墨"而不是"灰得看不见"。
 *    这两个色都按"玻璃合成底色"算过、又在真浏览器里按像素复核过（局部对比度），
 *    数值见 §十五 15.1 的对比度表（**浅底 / 深底两组**）。
 *    ⛔ 别退回白色系（`***REMOVED***fff` / `rgb(255 255 255/.62)`）：那是配深底的。
 */
function PinTab({ to, label, icon: Icon, end }: NavItem & { dot?: boolean }) {
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
            color: isActive ? 'var(--color-accentink)' : 'var(--color-ink2)',
            transition: 'color .22s cubic-bezier(.22,.8,.24,1)',
          }}
        >
          <span
            className={isActive ? 'tab-icon-on' : undefined}
            style={{ display: 'grid', placeItems: 'center', filter: ICON_HALO }}
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
  /*
   * 🔴 按身份过滤（方案 §4.3）：胶囊 / 展开层都从**这一份**取数。
   * `PIN_KEYS` 本身不动（N1），过滤在它之前（N2：过滤后某一格空着，不补位）。
   */
  const myRoles = useStore((s) => s.myRoles)
  const visible = visibleNav(myRoles)
  const { pinned, collapsed } = splitPin(visible)
  /* 🆕 新通知的小红点（展开层里那一行用）—— 与桌面左栏**同一处判据**（服务端的 unread） */
  const hasUnreadNotice = useStore((s) =>
    s.notices.some((n) => n.unread && !n.revokedAt && !n.expired),
  )
  /**
   * 「更多入口」的展开态：记的是**打开它的那个路径**，而不是一个布尔。
   * 这样"换了页面就自动收起"是**推导**出来的（路径一变 `more` 立刻为 false），
   * 既不用在 effect 里 setState，浏览器前进/后退回来时也不会莫名弹着一张浮层。
   */
  const [moreAt, setMoreAt] = useState<string | null>(null)
  const more = moreAt === pathname

  /*
   * 当前页在胶囊里 → 高亮滑到那一格；在「更多入口」里 → 圆按钮加一圈**蓝**描边
   * （2026-09-28 改亮色玻璃之后：原来那圈暖黄是为深底挑的，见 §十五 15.1 的对比度表）。
   * ⚠️ 这两处都**必须**跟着 `visible` 走（不是 `NAV`）：否则过滤之后
   *    某一格不在了，索引会错位、`moreActive` 会在错误的页面上亮起来。
   */
  const pinIdx = pinned.findIndex((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)))
  const moreActive = collapsed.some((n) =>
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
    const target = pinned[idx]
    if (target && target.to !== pathname) navigate(target.to)
  }

  return (
    <>
      <nav
        aria-label="主导航"
        /*
         * 🔴 **层叠 · 2026-09-28 第二轮（用户拍板改做法：展开时整栏淡出）**
         *
         * 上一轮的做法是"把整个 `<nav>` 抬到 Sheet 之上（展开态 `z-[52]`）"，
         * 好让"朝下的收起箭头"看得见。用户看过之后说：
         *   「但是点开后导航栏浮在上面会不会太奇怪了 / 展开后整个导航栏淡出吧」
         * —— 于是**抬层叠这件事被整个推翻**：展开时这一栏自己消失，
         *    就不存在"要不要浮在上面"的问题，也不会有"看不见却还能点到"的误触。
         *
         * 现在：
         *   · `<nav>` **恒为 `z-40`**（和最早一样，收起态压在内容之上、在 `.scrim`(z-50)
         *     与 `.sheet`(z-51) 之下 —— 展开时被 Sheet 盖住也无所谓，因为它正在淡出）；
         *   · 展开态加 `opacity-0`；而带子本身 `pointer-events-none` **恒定保留**（I22 那条：
         *     这条带子从来就只有胶囊与圆按钮可点）。
         *     注意"看不见"与"点不到"是两件事：**只把它变透明的话它仍然能点到** ——
         *     那正是"看不见却会误触"。所以展开态**两件事一起做**：
         *     ① 整栏 `opacity-0`（视觉上彻底消失）；
         *     ② 那两个子控件（胶囊 / 圆按钮）各自的 `pointer-events-auto` **也一起去掉**
         *        （`pointerEvents: more ? 'none' : 'auto'`）—— 只把父级设成 `none`
         *        是**不够**的，子级自己写了 `auto`，照样能在透明状态下被点到（实测这条坑）。
         *   · 过渡 `260ms` 与 `.sheet` 的升/降动画（`@keyframes sheet-up` 0.26s，
         *     同一条 `cubic-bezier(.22,.8,.24,1)`）**对齐** —— 别各弹各的。
         *     收起时 Sheet 往下走、导航同步淡回来，不会"先看不见再跳出来"。
         *
         * ⚠️ 因为不再抬层叠，AppShell 根节点那个 `z-index` 也**照旧不能有**
         *    （上一轮为抬层叠摘掉过 `z-[1]`；摘掉本身对淡出无害，但"根节点带 z-index"
         *    这件事仍然会把整棵子树关进层叠上下文 —— 页面里那些浮层的层叠口径见 §十五 15.3）。
         * ⚠️ **尺寸一个字没动**：底距、58、48、52 全照旧（I21）。
         */
        aria-hidden={more || undefined}
        className={cx(
          'pointer-events-none fixed inset-x-0 lg:hidden z-40',
          'transition-opacity duration-[260ms] ease-[cubic-bezier(.22,.8,.24,1)]',
          more ? 'opacity-0' : 'opacity-100',
        )}
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
          {/* ① 胶囊：工作台 / 作业 / 我的 —— 半透明**亮色**液态玻璃、细描边、12 圆角 */}
          <div
            ref={pillRef}
            className="glass-light pointer-events-auto relative flex items-center"
            style={{
              /* 58 = 1 边框 + 4 内边距 + 48 图标格 + 4 + 1（box-sizing 是 border-box）。
                 ⚠️ 那 1px 边框现在由 `.glass-light` 给（半透明白发丝描边）；**宽度仍然是 1**，
                    所以这个算式、`clientLeft`、以及 38/39 两张拖拽图量的坐标全都不变。 */
              height: 58,
              padding: 4,
              borderRadius: 12,
              touchAction: 'pan-y',
              /* 展开态整栏在淡出：这时候**不能还能点**（见 `<nav>` 上那段层叠注释） */
              pointerEvents: more ? 'none' : 'auto',
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
            {/* 当前页那一格：跟着手指走的一块玻璃。
                ⚠️ 底下已经是**很透**的玻璃，再用半透明白就"高亮不起来"了（白压白）。
                   所以这里用一档**近白 → 淡蓝**渐变 + 一圈淡蓝描边（`--color-accentsoft`
                   那一挂）—— 既要看得出来"我在这一页"，又不能变成一块突兀的实心块。
                🔴 2026-09-28 第二轮**把它也降了一档**（`***REMOVED***fff/.9` + `accentsoft/.88`，
                   原来是不透明的 `***REMOVED***fff → accentsoft`）：玻璃变透明之后，那块**全白**的
                   高亮成了整条控件里最实的东西 —— 用户要的是"透明"，而"当前页"仍然靠
                   **一圈淡蓝描边 + 色块**就能读出来（不必靠不透明）。实测（浅底）：
                   块上的 `--color-accentink` ***REMOVED***0847c4 = **7.5:1**，整格逐像素 **7.4:1**；
                   "看得见我在这一页"这一条另由 `shots.mjs` 的 35/36/37 三张图
                   （高亮位置真的会动）+ 下面的 `data-active` 断言钉住，没有丢。 */}
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
                  'linear-gradient(180deg, rgb(255 255 255 / .9) 0%, rgb(233 240 254 / .88) 100%)',
                border: '1px solid rgb(11 92 240 / .3)',
                boxShadow: 'inset 0 1px 0 rgb(255 255 255 / .95), 0 1px 2px rgb(14 20 27 / .08), 0 8px 18px -10px rgb(11 92 240 / .45)',
                opacity: hi.show ? 1 : 0,
                pointerEvents: 'none',
                willChange: 'left, width, transform',
                transition:
                  dragX !== null
                    ? 'none'
                    : 'left .44s cubic-bezier(.34,1.32,.5,1), width .44s cubic-bezier(.34,1.32,.5,1), opacity .2s',
              }}
            />
            {pinned.map((n) => (
              <PinTab key={n.to} {...n} />
            ))}
          </div>

          {/* ② 圆按钮：**展开 / 收起其余入口**。和胶囊**分开**，不连着。
              🔴 图标是**折角箭头**（`IconChevronRight` 转 90°），**未展开朝上 / 已展开朝下**
                 （2026-09-28 用户拍板）：原来用的纸飞机（`IconSend`）是照参考图抄的，
                 语义其实不对 —— 这个按钮的职责是"把下面那一层拉上来 / 放回去"，
                 不是"发送"。箭头的方向与它下面那张 Sheet 的升/降方向一致，
                 也是底部抽屉的通用画法（VIVO / OPPO 的系统 UI 同样这么用）。
                 ⚠️ 一个图标两个状态，状态变化体现在**方向**上，比"换一个完全不同的图标"
                    更容易读成"同一件事的开关"；桌面那侧没有这个按钮，不用跟着改。
              🔴 **无障碍名跟着状态变**（视觉与 aria-label 必须一致，§十五 I21 那一挂）：
                 `展开更多入口` ↔ `收起更多入口`。`shots.mjs` 是按**收起态那个名字**点的。
              🔴 **2026-09-28 第二轮：展开态它随整栏一起淡出**（用户：「展开后整个导航栏淡出吧」）。
                 所以"展开态这颗按钮看不看得见"这件事**不再是**要钉的东西 —— 反过来，
                 展开态它**必须看不见、也点不到**（`pointer-events` 一起去掉），
                 `shots.mjs` 现在钉的是这一条（见 §十五 15.3 与 15.5）。
                 ⚠️ 本组件里那个"已展开 → 箭头朝下"的 `rotate(90deg)` **留着**：
                    它是**收起动画那 0.26s** 里唯一能读到的方向信号（Sheet 往下走、导航淡回来），
                    而且一次点击就能把状态读出来 —— 别以为"反正看不见"就把它删了。
              ⚠️ 颜色用 `--color-accentink`（***REMOVED***0847c4）：它压在近白的玻璃上 ≈ **7.3:1**。
                 原来那个暖黄 `***REMOVED***f5c469` 是"深底上的显眼强调物"，在这套亮色玻璃上只有
                 ≈ **1.5:1**，而且按钮现在的语义是个功能开关 —— 与全站其它控件同用
                 accent 一挂才对（为什么不取浅一档的 `--color-accent` 见下方注释）。 */}
          <button
            type="button"
            onClick={() => setMoreAt(more ? null : pathname)}
            aria-label={more ? '收起更多入口' : '展开更多入口'}
            aria-expanded={more}
            aria-haspopup="dialog"
            title={more ? '收起更多入口' : '更多入口'}
            className="glass-light pointer-events-auto grid shrink-0 place-items-center"
            style={{
              /* 与胶囊等高（58），全圆 */
              width: 58,
              height: 58,
              borderRadius: 999,
              color: 'var(--color-accentink)',
              /* 展开态整栏在淡出：**必须连它自己那层 `pointer-events-auto` 一起去掉** ——
                 只把 `<nav>` 设成 none 是没用的，这一层写着 auto，透明了照样能点到（实测）。 */
              pointerEvents: more ? 'none' : 'auto',
              /* 当前页在展开层里时描一圈同色蓝，免得"高亮不见了" */
              outline:
                more || moreActive ? '2px solid rgb(11 92 240 / .55)' : '2px solid transparent',
              outlineOffset: 3,
              transition: 'outline-color .2s',
            }}
          >
            {/*
              为什么取 `--color-accentink`（***REMOVED***0847c4，7.3:1）而不是 `--color-accent`
              （***REMOVED***0b5cf0，5.2:1）：折角箭头是**细线**（1.6→2.1 描边），线越细越吃对比度，
              而 7.3:1 是本次实测里最稳的那一档；两者都在 AA 之上，取深的那支。
            */}
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                /* 与胶囊图标同一串 halo（见 ICON_HALO 的注释）：箭头是细线，最吃对比度 */
                filter: ICON_HALO,
                /* 未展开 → 朝上（把那一层拉起来）；已展开 → 朝下（放回去） */
                transform: more ? 'rotate(90deg)' : 'rotate(-90deg)',
                transition: 'transform .32s cubic-bezier(.34,1.3,.5,1)',
              }}
            >
              <IconChevronRight size={26} strokeWidth={2.1} />
            </span>
          </button>
        </div>
      </nav>

      {/*
        展开：其余入口（班级 / 错题集 …）。一行 52px，够手指点。
        ⚠️ 这一层（`.sheet`）本来就是**白底亮色**（`index.css` 的 `.sheet`），
           所以上一轮改亮色玻璃**没有**把它也算进来 —— 先读清再动手，别无脑统一。
        ⚠️ 底部原来还有一行说明「工作台 / 作业 / 我的 在底部那颗胶囊里；这一层装的是
           其余入口。」（按实际胶囊项动态拼，`pinnedLabel()`）—— 用户 2026-09-28 拍板
           **删掉**，那段拼字符串的逻辑也一起删了（它只有这一个用处，留着就是死代码）。
           `shots.mjs` 的「按身份显示导航」那一节反过来钉住"它不在"。
      */}
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
          {collapsed.map((n, i) => {
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
                    i === collapsed.length - 1 ? undefined : '1px solid var(--color-line)',
                  background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                }}
              >
                <span
                  className="relative grid shrink-0 place-items-center"
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
                  {n.to === '/notices' && hasUnreadNotice ? <UnreadDot /> : null}
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
  /*
   * 🔴 **按身份过滤后的入口** —— 桌面左栏真正渲染的那一份（方案 §4.1）。
   * 取数只有这一处，`activeIdx` 与渲染都从它来；`NAV`（全部入口）不再直接渲染。
   * 见 `visibleNav()` 的注释：过滤必须在 PIN_KEYS 之前、三处索引一起换。
   */
  const visible = visibleNav(myRoles)
  /**
   * 🆕 有没有**新通知**（导航上的那个小红点）。
   *
   * ⚠️ 三条口径都写在这里，因为它是全站唯一一处算它的地方：
   *   · **只有"有/没有"，没有条数**（数字会让人以为是待办，见 `UnreadDot()`）；
   *   · 判据就是服务端给的 `unread`（= `createdAt > 我的 notice_seen_at`，I49），
   *     这里**不重算** —— 重算就是"同一件事两个判定入口"；
   *   · **撤下 / 过期的那些不算新**（它们还在列表里，但不再是"新通知"）。
   */
  const hasUnreadNotice = useStore((s) =>
    s.notices.some((n) => n.unread && !n.revokedAt && !n.expired),
  )
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

  const activeIdx = visible.findIndex((n) =>
    n.end ? pathname === n.to : pathname.startsWith(n.to),
  )

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
    /*
     * 🔴 **这里故意没有 `z-[1]`**（2026-09-28 挪走的，别加回来）—— 见 §十五 15.3。
     *
     * 移动端那颗展开按钮要"抬到 Sheet（`.sheet`，z-51，走 Portal 挂在 body 上）之上"，
     * 是**在这一层的 z-index 上失败的**：`z-index` 非 `auto` 的定位元素会**自成层叠上下文**，
     * 子树里的 `z-index` 再也出不去 —— `<nav>` 里写 `z-[52]` 也没用，整棵子树仍然被
     * 关在 `z-index: 1` 里，永远压不过 body 下那个 `z-51` 的 Sheet。
     * 实测（414×880、展开态）：`elementFromPoint(圆按钮中心)` 命中的是 `.sheet` 的页脚，
     * 不是按钮；把这行的 `z-index` 摘掉之后立刻命中按钮里的 `<svg>`（`shots.mjs` 有这条断言）。
     *
     * ⚠️ 摘掉它**不会**让页面里的东西盖住浮层：页面内容仍然是普通流/`z-index:auto`，
     *    而 `.scrim`（z-50）与 `.sheet`（z-51）是**定位元素且排在后面**，照样盖住整页 ——
     *    实测移动端顶栏（`z-30`）在 Sheet 开着时命中的仍然是 `.scrim`。
     * ⚠️ `relative` 留着（页面里那些 `absolute` 的东西要按它定位）。
     */
    <div
      className="relative mx-auto flex min-h-full w-full"
      /*
       * 🆕 顶部让位（2026-09-28 公告轮）：公告条 + 同步出错横幅都是**固定**的，
       * 所以内容必须自己往下让出那一段（高度由 `AnnouncementStack` 实测后写进
       * `document.documentElement` 的 `--top-stack-h`）。
       * 🔴 用 `paddingTop` 而不是"给子元素各加一个 margin"：这里只有一处，
       *    而 `min-h-full` 会在**减掉 padding 之后**再算（border-box），
       *    于是整屏页照样居中、长内容照样能长出去。
       */
      style={{ maxWidth: 1220, paddingTop: 'var(--top-stack-h, 0px)' }}
    >
      {/* 桌面左栏 —— 悬浮在画布之上的一层 */}
      <aside className="hidden shrink-0 lg:block" style={{ width: 266, paddingLeft: 14 }}>
        <div
          className="floating-rail sticky flex flex-col p-4"
          /*
           * 🔴 顶栏与公告条（`--top-stack-h`，见 `AnnouncementStack.tsx` 的层叠规则）
           *    要**一起**让位：让位量由那一个 CSS 变量给出，桌面左栏 / 右栏 / 移动端顶栏
           *    与 `ui.tsx` 的 `PageHead` **共用它**（各自写一个数 = 同一件事四个口径）。
           */
          style={{
            top: 'calc(var(--top-stack-h, 0px) + 14px)',
            height: 'calc(100vh - 28px - var(--top-stack-h, 0px))',
          }}
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
            /* 稳定选择器：回归脚本按它取"桌面左栏里摆着哪几项"（方案 §5.3 的 B1）。
               ⚠️ 别用样式类名当选择器（§15.5 的教训：`nav.nav-frost` 已经配不上，
               `boundingBox()` 直接超时）。移动端那颗胶囊用的是 `aria-label="主导航"`。 */
            aria-label="主导航 · 桌面"
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
            {visible.map((n) => (
              <RailItem key={n.to} {...n} dot={n.to === '/notices' && hasUnreadNotice} />
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
          className="glass sticky z-30 flex items-center gap-2 px-4 lg:hidden"
          /* 🔴 `top` 走 `--top-stack-h`（公告条 + 报错横幅），见 `AnnouncementStack.tsx` 文件头 */
          style={{ height: 50, top: 'var(--top-stack-h, 0px)', borderBottom: '1px solid var(--color-line)' }}
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
                  {syncError} · 本地已保留
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
          /* 🔴 同样给顶部的公告条 + 报错横幅让位（见 `AnnouncementStack.tsx` 文件头） */
          style={{ top: 'var(--top-stack-h, 0px)', height: 'calc(100vh - var(--top-stack-h, 0px))' }}
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

      {/* 移动端导航 —— 悬浮的**亮色**液态玻璃胶囊 + 展开按钮（形态见 MobileNav 上方的说明） */}
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
          切换后，作业、班级等页面都按这个班显示
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

      {/*
        🆕 全站公告的顶部横幅 + 弹窗（2026-09-28 公告轮）。
        🔴 **它与早间欢迎弹窗的排队规则就写在这一行上**：公告弹窗**礼让**那两个时刻的弹窗
           （`suppressPopup`）。礼让时它**不记任何 seen** —— "这一次没弹"不等于"用户看过了"。
           规则、层叠（与 `SyncErrorBanner` 的 z-70 怎么排）与实测见
           `AnnouncementStack.tsx` 的文件头 + `功能设计与不变量.md` §二十四。
        ⚠️ 它**只抑制弹窗，不抑制横幅**：早上进来那两条横幅照常在。
      */}
      <AnnouncementStack suppressPopup={mood.welcomeOpen || mood.doneOpen} />
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
