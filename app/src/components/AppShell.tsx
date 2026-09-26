import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT, type Student, type TeacherRole } from '../data/types'
import * as remote from '../data/remote'
import { useClassroomPresence } from '../hooks/useClassroomPresence'
import { useMood } from '../hooks/useMood'
import { useScheduleReminder } from '../hooks/useScheduleReminder'
import { rosterStateOf } from '../lib/roster'
import { classKindOf } from '../lib/pick'
import { currentIdentityLabel, ENTRIES, entryVisible, IDENTITY_TAG_STYLE } from '../lib/roles'
import { awayText, toMinutes, weekdayOf } from '../lib/schedule'
import { connectionMode } from '../lib/supabase'
import { useTheme } from '../lib/theme'
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
  IconGrid,
  IconHash,
  IconInfo,
  IconMoon,
  IconSun,
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
 * （工作台 / 班级 / 作业 / 考试 / 错题集 / 日程表 / 通知 / 行政管理 / 我的），
 * 而 `ENTRIES` 里还有 `/accounts`、`/files`、`/calls`、`/notices/new`
 * 这些"入口不在 NAV 里"的（它们在「我的」页或通知页里，见方案 §2.4）。
 * 两者是**包含关系**，不是相等。
 *
 * 🆕 2026-09-28 加 `/notices`（方案 §四.2 第 18 行：**所有老师都是 V**）——
 *    这是 `NAV` 从 7 项变成 8 项的那一次；`PIN_KEYS` **一个字没动**
 *    （胶囊里那三个仍是"每天来回切"的那三个，见下）。
 * 🆕 2026-10-01 加 `/manage`（行政管理，`NAV` 从 8 项变成 **9 项**）——
 *    它是**一个页面**（三张入口卡：年级管理 / 档案管理 / 教师管理），
 *    不是「我的」里的一行设置项，所以进左栏；而 `/accounts`、`/grades`、`/grades/promote`
 *    这三条**仍然是"入口不在 NAV 里"的**（它们现在挂在 `/manage` 那一页上）。
 *    ⚠️ `PIN_KEYS` 照旧**一个字都不动**（新入口默认落进移动端「更多入口」——
 *    判据是频次不是权限，见下那条）。
 */
const NAV_KEYS = [
  '/',
  '/classes',
  '/assignments',
  '/exams',
  '/wrong',
  '/schedule',
  '/notices',
  '/manage',
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
  /*
   * 🆕 2026-10-01 行政管理（`/manage`）。
   *
   * 🔴 为什么它进 `NAV`：它是**一个页面**（三张入口卡），不是「我的」里的一行设置项 ——
   *    「年级管理 / 档案管理 / 教师管理」那三行原来都在「我的」页上，本轮**搬出来**
   *    单独成一页（用户 2026-10-01 原话："从我的里面提出来，单独设计制作一个行政管理页面"）。
   *    所以：`/manage` 进左栏，而 `/grades`、`/grades/promote`、`/accounts`
   *    这三条**仍然不在 NAV 里**（它们现在挂在那一页的三张卡上）。
   *
   * 🔴 判据是**三张卡判据的并集**（`ENTRIES['/manage']` = `seesAdministration`，
   *    今天 == `canManageTeachers`：超管 / 教务处 / 办公室主任）——
   *    今天恰好也含**年级主任**（`hasManagingRole` 那一支）。
   *    ⚠️ 这一项让**左栏第一次因身份而不同**（超管 / 教务处 / 年级主任 / 办公室主任 9 项，
   *    班主任 / 任课教师 8 项）—— 所以 `shots.mjs` 里那条"教导处与任课教师左栏逐项相同"
   *    必须**如实改成"多一项「行政管理」"**，并按"它对谁可见"逐档说明。
   *
   * ⚠️ `end: false`：`/manage` 今天是**叶子页**（没有子路由），但哪天它长出子页
   *    （比如 `/manage/…`），`end: false` 能让「行政管理」继续高亮 —— 与 `/exams` 同款判断。
   * ⚠️ 图标与 `/admin`（平台运维）**故意不同**：那两个入口在左栏里会同时出现（超管），
   *    同图标 + 名字只差一个字（"行政管理" vs "平台运维"）会让人点错。
   */
  { to: '/manage', label: '行政管理', icon: IconGrid, end: false },
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
            /* ⚠️ 这里是 `#fff` 而**不是** `var(--color-ink)`：Toast 是 `.glass-dark`（**永远深底**，
               亮暗两档都不变），压在上面的字必须永远是白的 —— 走令牌的话暗色下它反而变成近白、
               亮色下变成近黑（那样在深玻璃上直接看不见）。深底上的固定色是"正确"而不是"漏改"。 */
            color: '#fff',
            border: '1px solid rgb(255 255 255 / .14)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              /* 这一组跟着 `tone` 走的是**深玻璃上的状态色**（`.glass-dark` 恒深底）——
                 所以它们是"深底专用的提亮档"，**不换令牌**（换成 --color-ok 之类，
                 亮色下那支会暗到在深玻璃上看不清）。 */
              color:
                t.tone === 'ok'
                  ? '#4ade9a'
                  : t.tone === 'bad'
                    ? '#ff8a94'
                    : t.tone === 'warn'
                      ? '#f5c469'
                      : '#8fd3ff',
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
      · 右侧圆按钮：深底上的暖黄 `#f5c469` → 亮底上**够深的强调色** `--color-accentink`。
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
 *   玻璃**透过深色内容**时不再是近白 —— 深色图标（`--color-ink2` #4a5563 /
 *   `--color-accentink` #0847c4）压在那块底上只剩 **1.27:1**（深底实测），等于消失。
 *
 * 为什么不给玻璃加"整体暗化"（那也能救对比度）：用户这一轮买的就是**透明**，
 *   加一层暗化等于把透出来的壁纸又抹掉一半，方向相反。
 *   而参考图里玻璃本身**几乎没有本体色**，靠的就是边缘 —— 所以把"边缘"这个概念
 *   从控件边缘延伸到**图标边缘**：沿图标形状（`drop-shadow` 跟 alpha 走，
 *   不是矩形）描一圈很淡的浅色，深色图标在深底上就有了"玻璃里的白边"。
 * ⚠️ 两处（胶囊图标 / 圆按钮箭头）用的是**同一串值**，改一处就得改另一处。
 */
/* ---------- 材料令牌（见 `index.css` 的"派生语义色"）----------
 * 这一组是**液态玻璃的高光与描边**：亮色下与收编前的字面量逐字相同，
 * 暗色下换成"低透明度白 + 提亮后的 accent"（口径写在 `index.css` 的暗色块里）。
 * ⛔ 别把它们换成 `--color-surface*`：玻璃的高光不是"面"，换了就成一块死色。
 */
const GLASS_HI = 'var(--color-glasshi)'
const GLASS_HI2 = 'var(--color-glasshi2)'
const GLASS_LINE = 'var(--color-glassline)'
/** 液态玻璃"当前页"那一圈淡蓝描边（`AppShell` 里高亮边的 `border/outline/外扩影` 共用） */
const HI_LINE = 'var(--color-hiline)'

const ICON_HALO = `drop-shadow(0 0 0.6px rgb(${GLASS_LINE} / .9)) drop-shadow(0 0 1.4px rgb(${GLASS_LINE} / .45))`

/* ============================================================
   🔴 液态玻璃的**边缘折射**（2026-10-01 第三轮 · 用户附参考图 iOS 26 Liquid Glass）

   参考图里最关键的一条是"**玻璃的边缘把背景扭一下**" —— 那道边不是画上去的亮线，
   而是**真的**把后面的内容折了一下。CSS 没有"只折个边"的滤镜，能做这件事的只有 SVG：
   `feTurbulence` 造一张**低频**位移场 → `feDisplacementMap` 让背景按它位移；
   `index.css` 的 `.glass-light[data-refract='on']` 用 `url(#…)` 把它接到 `backdrop-filter` 上。
   （静态的那一半 —— 一明一暗的内描边 + 三道递减白圈 = "厚边" —— 仍在 CSS 里，两半都要有。）

   为什么用 `feTurbulence` 而不是"手绘一张径向置换图"：
     · 手绘要 `feImage` + 一个 `data:` 图 —— 那是一条**外部资源**，CSP / 引擎差异都可能让它
       **静默加载不到**（什么都不报，位移变成常数 → 整块背景被整体挪走，比不生效更糟）；
     · `feTurbulence` 是**算出来的**，不依赖任何资源，把 `baseFrequency` 调低就是"平滑的位移场"。
     ⚠️ 低频（0.004 / 0.02）是刻意的：高频出来是"磨砂噪点"，低频才是"背景被揉了一下"。

   三条降级（任何一条不过 → `data-refract='off'`）：
     ① 引擎不支持 `backdrop-filter: url(#…)`（`CSS.supports` 判，CSS 那头另有 `@supports` 兜一道）；
     ② **低端机不赌**（核数 ≤ 4 或 `deviceMemory` ≤ 4）：这是实时滤镜，老师和教室那台机器
        可能就是低端机（`AGENTS.md` 第一节），掉帧比"少一点折射"难看得多；
     ③ **掉帧看门狗**：挂上之后量 24 帧的 `requestAnimationFrame` 间隔，
        中位数超过 `FRAME_BUDGET_MS` 就**当场摘掉**（本会话内不再打开）。
   ⚠️ 退回之后剩下的就是"**只有模糊 + 描边**"（`index.css` 里那条基础声明照常生效）——
      可读性**不靠折射**（图标靠 `ICON_HALO`、面板靠 0.88 的白兜底层），所以降级只损失"像不像"。

   🔴 **这一轮又多了第二个实时滤镜**（选中项那个"液态果冻"指示器的 gooey，见下面 `GOO_ID`）。
      两个都是 GPU 上的实时滤镜，**绝不能无脑叠**：低端机上 `lowEndDevice()` 会把**两个一起关掉**，
      看门狗掉帧时也是**一起关**（同一个 `costly` 开关）——
      那时剩下的正是"**模糊 + 描边 + 颜色变化 + 弹簧位移**"（颜色与弹簧是 CPU 级的，几乎不花钱）。
   ============================================================ */

/** 与 `index.css` 里那两处 `url(#…)` **必须同字**：不一致 = 指针指空 = 静默不生效（`shots.mjs` 会钉） */
export const REFRACT_ID = 'shugao-liquid-refract'

/** 🔴 选中项那颗"液态果冻"指示器的 gooey 滤镜（`feGaussianBlur` + `feColorMatrix` 对比切边） */
export const GOO_ID = 'shugao-nav-goo'

/** 一帧最多允许多少毫秒（≈45fps）：超了就当"这台机器吃不下实时滤镜" */
const FRAME_BUDGET_MS = 22

/** ② 低端机不赌（两个阈值都是保守值；读不到就当它是好机器，交给看门狗兜） */
function lowEndDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency ?? 8
  const memory = nav.deviceMemory ?? 8
  return cores <= 4 || memory <= 4
}

/** ① 引擎认不认 `backdrop-filter: url(#…)`（不认就没必要往下走） */
function refractSupported(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  if (!CSS.supports('backdrop-filter', `url(#${REFRACT_ID})`)) return false
  if (window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) return false
  return !lowEndDevice()
}

/** ①' gooey 走的是普通 `filter`（比 `backdrop-filter: url()` 的支持面宽得多，但不能想当然） */
function gooSupported(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  return CSS.supports('filter', `url(#${GOO_ID})`) && !lowEndDevice()
}

/** `(prefers-reduced-motion: reduce)` —— 有人对动效敏感，果冻/拉伸必须让路（不是"建议"） */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * 两个实时滤镜（折射 / gooey）**共用的一个预算开关**：
 *   · 先各自做特性检测与低端机判据（`useState` 只算一次）；
 *   · 再看门狗：挂上之后量 24 帧的 `requestAnimationFrame` 间隔，中位数超 `FRAME_BUDGET_MS`
 *     → **两个一起关**（"只留一个"都嫌多的时候，正确的选择是一个都不留）；
 *   · `key` 变了（展开 ⇄ 收起）重新量一轮 —— 展开态那张面板的面积大得多，代价不是一回事。
 * ⚠️ 语义是"**关了不再开**"：一次掉帧就降级到底，免得在临界机器上反复开关（那比一直关更难看）。
 */
function useGlassFx(key: unknown): { refract: boolean; goo: boolean } {
  const [caps] = useState(() => ({ refract: refractSupported(), goo: gooSupported() }))
  const [costly, setCostly] = useState(true)
  const frames = useRef<number[]>([])
  useEffect(() => {
    if (!caps.refract && !caps.goo) return
    let raf = 0
    let last = performance.now()
    frames.current = []
    const tick = (t: number) => {
      const d = t - last
      last = t
      /* 后台标签页的帧是被节流的，不算数（否则切回来一次就"掉帧"了） */
      if (!document.hidden && d > 0) frames.current.push(d)
      if (frames.current.length >= 24) {
        const sorted = [...frames.current].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        frames.current = []
        if (median > FRAME_BUDGET_MS) {
          setCostly(false)
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [caps, key])
  return { refract: caps.refract && costly, goo: caps.goo && costly }
}

/**
 * 滤镜本体（内联 SVG，折射与 gooey 两个；胶囊 / 圆按钮 / 展开面板共用这一份）。
 * ⚠️ **只在对应那个开关打开时才挂进 DOM**：`url(#…)` 指不到东西时行为不可预期
 *    （有的引擎整条声明失效），"指针与实现一起挂、一起摘"最干净 —— 关掉时连 DOM 都不留。
 */
function LiquidGlassFilter({ refract, goo }: { refract: boolean; goo: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: 'absolute', pointerEvents: 'none' }}
    >
      <defs>
        {refract ? (
          <filter id={REFRACT_ID} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.004 0.02"
              numOctaves="2"
              seed="9"
              result="noise"
            />
            {/* 噪声的原始幅度会把背景拧烂：压到 0.6 并抬到中性灰附近，只留"很轻的一下" */}
            <feComponentTransfer in="noise" result="ripple">
              <feFuncR type="linear" slope="0.6" intercept="0.2" />
              <feFuncG type="linear" slope="0.6" intercept="0.2" />
            </feComponentTransfer>
            <feDisplacementMap
              in="SourceGraphic"
              in2="ripple"
              scale="14"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        ) : null}
        {/*
          🔴 **液态果冻（gooey）**：指示器本体与它那个"拖尾圆"同在这张滤镜里 ——
          `feGaussianBlur` 把两个形状糊成一片，`feColorMatrix` 最后一行是**alpha 的对比切边**
          （`0 0 0 18 -7`：alpha ≥ ~0.6 直接切到 1、以下切到 0）。
          两个圆靠近时它们被糊成一坨、再被切回**一个**形状（就是"粘连"）；
          靠得远时是**两个圆 + 中间一条细颈**（"两头圆、中间细"）。
          ⚠️ 最后那个 `feGaussianBlur stdDeviation=".4"` 是**抗锯齿用的**：
             alpha 切边会把圆角的锯齿放大，轻糊一下才干净（别删）。
          ⚠️ 阈值切边只对**不透明填充**成立：指示器与拖尾圆用的是同一个近乎不透明的色，
             两处**必须同色同透明度**，改一处就得改另一处（否则一个被切掉、一个留下）。
        */}
        {goo ? (
          <filter id={GOO_ID} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blurred" />
            <feColorMatrix
              in="blurred"
              result="goo"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
            />
            <feGaussianBlur in="goo" stdDeviation=".4" />
          </filter>
        ) : null}
      </defs>
    </svg>
  )
}

/**
 * 液态玻璃那一族的圆角：**与 `index.css` 的 `--radius-liquid` 必须同值**。
 * 那是本项目**唯一的大圆角**（理由写在 `index.css` 的令牌那一行），别拿它去改别的控件。
 */
const LG_RADIUS = 18

/* ============================================================
   🔴 **选中项那颗"液态果冻"指示器**（2026-10-01 第三轮追加 · 用户第二张参考图）

   用户原话：「我想把移动端最下面左侧的导航栏改成这种样子，按钮要有那种**液态晃动**的感觉，
   要**Q弹**」。参考图（相册 App 的底部悬浮胶囊）里看到的形态：
     · 选中项的指示器是一个**液体块**，在两项之间移动时**先朝目标方向拉长**（像被拽着的果冻）；
     · 中间态是"**两头圆、中间细**"的粘连形态；到位后收圆、微微过冲再弹回；
     · 指示器边缘有一圈**亮的高光边**（与玻璃面板同一套材质语言）。

   **"粘连"不是圆角能做出来的，是 gooey 滤镜**（`LiquidGlassFilter` 里的 `GOO_ID`）：
   把**本体填充**与一个**拖尾圆**放进同一层滤镜 —— `feGaussianBlur` 把两坨糊在一起、
   `feColorMatrix` 的 alpha 阈值再切回形状。两坨靠近时被糊成一坨 → "粘连"；
   靠得远时是两坨 + 中间一条细颈 → "两头圆、中间细"。

   **"Q弹"不是 ease，是弹簧**：拖尾圆由 `requestAnimationFrame` 的欠阻尼弹簧驱动
   （`SPRING_STIFF` / `SPRING_DAMP`），速度决定它与本体的间距；本体自己那 0.44s 的
   `cubic-bezier(.34,1.32,.5,1)` 是**带过冲**的（与桌面左栏同一套缓动）。

   🔴 **三条硬约束（都不许为了好看让步）**：
     ① **指示器不许是唯一信号**：选中项与未选中项的**图标颜色**必须同时不同
        （`--color-accentink` ⇄ `--color-ink2`，下方 `PinTab`）—— 色盲 / 强光 / 低对比背景
        都要能看出"我在哪一页"。gooey 关掉、弹簧关掉，颜色照旧。
     ② **不许与折射无脑叠**：两个都是实时滤镜，`useGlassFx` 里低端机与掉帧看门狗
        会把**两个一起关**（那时只留"模糊 + 描边 + 颜色 + 弹簧位移"）。
     ③ **`prefers-reduced-motion: reduce` → 直接跳过去、无果冻**：不跑弹簧、不做拉伸回弹、
        指示器的 `left/width` 过渡也改成 `none`（`useReducedMotion`）。
   ⚠️ 高光边（淡蓝描边 + 顶部内高光）**留在 goo 层外面**（`hiRingRef` 那一层）：
      alpha 阈值会把 0.3 的淡蓝边**切成实心蓝**（那是它固有的行为），挪出来才保得住原来的观感。
   ============================================================ */

/** 弹簧刚度：越大跟得越紧（0.14 ≈ 跟得上但明显滞后，滞后才看得见"果冻"） */
const SPRING_STIFF = 0.14

/** 每帧保留的速度比例：< 1 就是欠阻尼 → 会过冲一下再收回来（"Q弹"就是这一下） */
const SPRING_DAMP = 0.78

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
 *    · 当前页 `--color-accentink`（#0847c4）—— 既是主色、又是本文最深的蓝，压在
 *      近白的页面上比 `--color-accent`（#0b5cf0）更稳；
 *    · 其余 `--color-ink2`（#4a5563）—— "未选中"应该是"墨"而不是"灰得看不见"。
 *    这两个色都按"玻璃合成底色"算过、又在真浏览器里按像素复核过（局部对比度），
 *    数值见 §十五 15.1 的对比度表（**浅底 / 深底两组**）。
 *    ⛔ 别退回白色系（`#fff` / `rgb(255 255 255/.62)`）：那是配深底的。
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
   * 🔴 **两个实时滤镜开不开**（2026-10-01 第三轮）：特性检测 + 低端机 + 掉帧看门狗，
   * 见本文件上方那一大段（两个**共用同一个预算开关**，低端机上会一起关掉）。
   * ⚠️ `key` 传 `more`：展开那张面板的面积比胶囊大一个量级，收起 / 展开要各量一轮。
   * ⚠️ 它们**只是"像不像参考图"**：关掉之后模糊与描边照旧，读字靠的是兜底层（`index.css`），
   *    "我在哪一页"靠的是图标颜色（见下面 `PinTab`）。
   */
  const { refract, goo } = useGlassFx(more)
  /** 🔴 动效敏感的人：**没有果冻、没有拉伸、没有过渡**，指示器直接跳过去（硬要求） */
  const reduced = useReducedMotion()
  /** 果冻指示器 = gooey 可用 **且** 用户没要求减少动效 */
  const jelly = goo && !reduced

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
  /** 高光边那一层（**在 goo 层外面**，见上面 `data-hi-ring` 的注释）：它要跟着填充一起做拉伸回弹 */
  const hiRingRef = useRef<HTMLSpanElement>(null)
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
    /* 🔴 `prefers-reduced-motion: reduce` → **不弹也不拉长**（有人对动效敏感，这不是建议） */
    if (reduced) return
    /* ⚠️ **填充与高光边一起弹**：它们是两层（高光边挪到 goo 层外面了），只弹一层的话
       那一圈淡蓝描边会"留在原地"，看着像描边错位。两层的 keyframes 必须同一串。 */
    const stretch = [
      { transform: 'scaleX(1)' },
      { transform: 'scaleX(1.16)' },
      { transform: 'scaleX(0.97)' },
      { transform: 'scaleX(1)' },
    ]
    const opts = { duration: 470, easing: 'cubic-bezier(.34,1.3,.5,1)' }
    hiRef.current?.animate(stretch, opts)
    hiRingRef.current?.animate(stretch, opts)
  }, [pinIdx, reduced])

  /* ---- 在胶囊上滑动：高亮跟手，松手落到手指最近的那一格 ---- */

  const dragRef = useRef<{
    startX: number
    active: boolean
    boxes: Array<{ left: number; width: number }>
  } | null>(null)
  const suppressClick = useRef(false)
  const [dragX, setDragX] = useState<number | null>(null)

  /* ---- 🔴 液态果冻的**拖尾圆**：一个 rAF 弹簧（零依赖，见 `SPRING_*` 的注释） ----
   *
   * 为什么不是纯 CSS：CSS 过渡给的是"两端之间的插值"，而果冻要的是**欠阻尼的滞后**
   *   —— 尾巴的位置由"本体此刻在哪 + 速度"决定，还会过冲一下再收回来。
   * ⚠️ 弹簧状态放在 ref 里跨"重启"保留：拖动时 `dragX` 每帧都变，effect 会不停重启，
   *    每次把速度清零的话尾巴会**一直贴在本体上**（等于没有果冻）。
   * ⚠️ 停稳之后**主动停掉 rAF**（`st.raf = 0` 后不再排帧）：不为一个静止的圆常年占着帧。
   * ⚠️ 它必须排在 `dragX` **之后**：依赖数组里要用它（`useState` 之前引用 = TDZ 报错）。
   */
  const tailRef = useRef<HTMLSpanElement>(null)
  const springRef = useRef({ x: 0, v: 0, raf: 0, init: false })
  useEffect(() => {
    if (!jelly || !hi.show) return
    const tail = tailRef.current
    const wrap = pillRef.current
    if (!tail || !wrap) return
    const st = springRef.current
    /*
     * 🔴 **弹簧追的是"最终位置"（`hi.left` / `dragX`），不是"此刻渲染到哪"**。
     *
     * 为什么不能用 `getComputedStyle(body).left`（第一版就是这么写的，实测**永远是 0 滞后**）：
     *   点击之后 `hi.left` 立刻变成新值，但那条 `.44s` 的 CSS 过渡**要等下一次样式重算才起步**
     *   —— 实测在"换页 + 渲染新页面"那一下能拖到 **150~300ms** 之后。这段空窗里读到的
     *   `left` 还是旧位置，弹簧于是在**动画开始之前**就跑完并判定"停稳"、把自己停掉了；
     *   等过渡真的开始，没有人再叫醒它 —— 拖尾全程贴在本体上（果冻消失）。
     * 追最终位置就没有这个空窗：目标在那一刻就跳到了 52，滞后 >= 48px，绝不会误判停稳。
     * ⚠️ 副作用是好的：这一版**一次布局都不读**（原来每帧 `getComputedStyle`）。
     */
    const targetX = dragX ?? hi.left
    /* 拖尾圆只能在**内容盒**里跑：跑出胶囊外面就不像"一块玻璃"了（那是两坨东西） */
    const minX = 4
    const maxX = Math.max(minX, wrap.clientWidth - 4 - hi.width)
    let last = performance.now()
    const clamp = (x: number) => Math.min(Math.max(x, minX), maxX)
    if (!st.init) {
      st.x = targetX
      st.init = true
    }
    const tick = (t: number) => {
      /* 掉帧时按真实间隔折算，免得"帧率越低弹簧越硬" */
      const k = Math.min(3, Math.max(0.2, (t - last) / 16.7))
      last = t
      st.v = (st.v + (targetX - st.x) * SPRING_STIFF * k) * Math.pow(SPRING_DAMP, k)
      st.x += st.v * k
      tail.style.transform = `translateX(${clamp(st.x) - targetX}px)`
      if (Math.abs(targetX - st.x) < 0.35 && Math.abs(st.v) < 0.06) {
        st.x = targetX
        st.v = 0
        tail.style.transform = 'translateX(0px)'
        st.raf = 0
        return
      }
      st.raf = requestAnimationFrame(tick)
    }
    st.raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(st.raf)
      st.raf = 0
    }
  }, [jelly, hi.show, hi.left, hi.width, pathname, dragX])

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
      {/* 实时滤镜（内联 SVG：折射 + gooey）：哪个开关打开才挂哪个，见 `LiquidGlassFilter` */}
      {refract || goo ? <LiquidGlassFilter refract={refract} goo={goo} /> : null}
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
          {/* ① 胶囊：工作台 / 作业 / 我的 —— 半透明**亮色**液态玻璃、细描边、**大圆角 18** */}
          <div
            ref={pillRef}
            data-refract={refract ? 'on' : 'off'}
            className="glass-light pointer-events-auto relative flex items-center"
            style={{
              /* 58 = 1 边框 + 4 内边距 + 48 图标格 + 4 + 1（box-sizing 是 border-box）。
                 ⚠️ 那 1px 边框现在由 `.glass-light` 给（半透明白发丝描边）；**宽度仍然是 1**，
                    所以这个算式、`clientLeft`、以及 38/39 两张拖拽图量的坐标全都不变。 */
              height: 58,
              padding: 4,
              /* 🔴 18 = `LG_RADIUS` = `index.css` 的 `--radius-liquid`（本项目**唯一的大圆角**，
                 理由写在令牌那一行）。⚠️ 只改圆角不动任何尺寸：58 / 48 / 4 全照旧（I21）。 */
              borderRadius: LG_RADIUS,
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
                🔴 2026-09-28 第二轮**把它也降了一档**（`#fff/.9` + `accentsoft/.88`，
                   原来是不透明的 `#fff → accentsoft`）：玻璃变透明之后，那块**全白**的
                   高亮成了整条控件里最实的东西 —— 用户要的是"透明"，而"当前页"仍然靠
                   **一圈淡蓝描边 + 色块**就能读出来（不必靠不透明）。实测（浅底）：
                   块上的 `--color-accentink` #0847c4 = **7.5:1**，整格逐像素 **7.4:1**；
                   "看得见我在这一页"这一条另由 `shots.mjs` 的 35/36/37 三张图
                   （高亮位置真的会动）+ 下面的 `data-active` 断言钉住，没有丢。
                🔴 **2026-10-01 第三轮拆成两层**（为了果冻，见上面 `SPRING_STIFF` 那一段）：
                   ① `data-jelly` 这一层里是**填充**与**拖尾圆**，两者一起进 gooey 滤镜；
                   ② 高光边（淡蓝描边 + 顶部内高光）挪到**滤镜外面**那一层 ——
                      alpha 阈值会把 0.3 的淡蓝边切成**实心蓝**，那是滤镜的固有行为，躲开它。
                   ⚠️ `jelly` 关掉时这一层照样在（它就是"当前页"那块填充，不是装饰），
                      只是不挂滤镜、不渲染拖尾圆。 */}
            <div
              aria-hidden="true"
              data-jelly={jelly ? 'on' : 'off'}
              style={{
                position: 'absolute',
                /* = 胶囊的内边距盒：里面那两个 span 的坐标口径与改动前**一模一样**
                   （`hi.left` / `dragX` 一直是内边距盒坐标） */
                inset: 0,
                pointerEvents: 'none',
                filter: jelly ? `url(#${GOO_ID})` : undefined,
              }}
            >
              {/* ① 填充（**必须是第一个 `span[aria-hidden]`**：`shots.mjs` 的探针按它量高亮位置） */}
              <span
                ref={hiRef}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 4,
                  bottom: 4,
                  left: dragX ?? hi.left,
                  width: hi.width,
                  zIndex: 1,
                  /* 与胶囊**同心**：外圈 18 − 内边距 4 = 14（差着 4px 会在角上露出月牙） */
                  borderRadius: LG_RADIUS - 4,
                  background:
                    /* ⚠️ `--color-glasshi` / `--color-glasshi2` 是**材料令牌**（见文件头）：
                       "高光那一层的颜色分量"，不透明度留在这一行 ——
                       亮色 = 白 90% / `--color-accentsoft` 88%（与收编前**逐字相同**）；
                       暗色 = 白 14% / 白 8%（同一档材质，只是白的分量降下来）。
                       ⛔ 别把这两个换成 `--color-surface*`：玻璃的高光不是"面"，换了就成一块死色。 */
                    `linear-gradient(180deg, rgb(${GLASS_HI} / .9) 0%, rgb(${GLASS_HI2} / .88) 100%)`,
                  opacity: hi.show ? 1 : 0,
                  pointerEvents: 'none',
                  willChange: 'left, width, transform',
                  transition:
                    dragX !== null || reduced
                      ? /* 🔴 动效敏感：**直接跳过去**（没有过渡 = 没有果冻、没有滑动） */
                        'opacity .2s'
                      : 'left .44s cubic-bezier(.34,1.32,.5,1), width .44s cubic-bezier(.34,1.32,.5,1), opacity .2s',
                }}
              />
              {/* ② 拖尾圆：**同一颗圆**滞后一点点 → 与填充之间被糊成"两头圆、中间细" */}
              {jelly ? (
                <span
                  ref={tailRef}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: dragX ?? hi.left,
                    width: hi.width,
                    borderRadius: 999,
                    /* ⚠️ 与填充**同色同透明度**：alpha 阈值只对不透明的填切成形，
                       两处不一致会出现"一个被切掉、一个留下" */
                    background: 'rgb(var(--color-glasshi) / .9)',
                    opacity: hi.show ? 1 : 0,
                    pointerEvents: 'none',
                    willChange: 'transform',
                    /* ⚠️ `left` **不能**跟着做过渡：拖尾的"滞后"是由下面那个弹簧的
                       `translateX` 算的（位置 = 终点的 left + 与本体之间的滞后）。
                       给 `left` 也加过渡，两者就同步了 —— 尾巴永远贴在身上，果冻消失。 */
                    transition: 'opacity .2s',
                  }}
                />
              ) : null}
            </div>
            {/* ③ 高光边层（**不进 goo 滤镜**）：淡蓝描边 + 顶部内高光，与玻璃面板同一套语言
                ⚠️ `data-hi-ring` 是给 `shots.mjs` 认的锚点（它要断言"这一层不在 goo 层里"） */}
            <span
              ref={hiRingRef}
              aria-hidden="true"
              data-hi-ring=""
              style={{
                position: 'absolute',
                top: 4,
                bottom: 4,
                left: dragX ?? hi.left,
                width: hi.width,
                borderRadius: LG_RADIUS - 4,
                border: `1px solid rgb(${HI_LINE} / .3)`,
                /* ⚠️ 这一串里三个颜色全部走**材料令牌**（亮色与收编前逐字相同）：
                   `glassline`（内高光）/ `shadow`（贴边影）/ `hiline`（淡蓝边与它的外扩影）。 */
                boxShadow: `inset 0 1px 0 rgb(${GLASS_LINE} / .95), 0 1px 2px rgb(var(--color-shadow) / .08), 0 8px 18px -10px rgb(${HI_LINE} / .45)`,
                opacity: hi.show ? 1 : 0,
                pointerEvents: 'none',
                transition:
                  dragX !== null || reduced
                    ? 'opacity .2s'
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
              ⚠️ 颜色用 `--color-accentink`（#0847c4）：它压在近白的玻璃上 ≈ **7.3:1**。
                 原来那个暖黄 `#f5c469` 是"深底上的显眼强调物"，在这套亮色玻璃上只有
                 ≈ **1.5:1**，而且按钮现在的语义是个功能开关 —— 与全站其它控件同用
                 accent 一挂才对（为什么不取浅一档的 `--color-accent` 见下方注释）。 */}
          <button
            type="button"
            onClick={() => setMoreAt(more ? null : pathname)}
            aria-label={more ? '收起更多入口' : '展开更多入口'}
            aria-expanded={more}
            aria-haspopup="dialog"
            title={more ? '收起更多入口' : '更多入口'}
            data-refract={refract ? 'on' : 'off'}
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
                more || moreActive ? `2px solid rgb(${HI_LINE} / .55)` : '2px solid transparent',
              outlineOffset: 3,
              transition: 'outline-color .2s',
            }}
          >
            {/*
              为什么取 `--color-accentink`（#0847c4，7.3:1）而不是 `--color-accent`
              （#0b5cf0，5.2:1）：折角箭头是**细线**（1.6→2.1 描边），线越细越吃对比度，
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
        {/*
          🔴 `data-nav-glass` 是**给 CSS 认的标记**（`index.css` 的 `.sheet:has([data-nav-glass])`）：
          这一轮要的"移动端底部导航**展开态**也是液态玻璃"，只能从壳子这边指过去 ——
          `ui.tsx` 的 `Sheet` 是全站共用的（十来个页面在用），**不许动它**（那是别的页面的脸）。
          `:has()` 认不出这个标记的老浏览器 → 面板维持原来的不透明白底，**可用性零损失**。
          ⚠️ `data-refract` 同理：`on` 时那张面板才接上折射（判定在 `useLiquidRefract`）。
        */}
        <div
          data-nav-glass=""
          data-refract={refract ? 'on' : 'off'}
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
                  /* 🔴 这一轮行底从**实心白**改成**透明**：面板自己已经是一块奶白玻璃，
                     行再垫一层实白就把玻璃全挡掉了（展开态看着还是"一张白纸"）。
                     ⚠️ 透出去的是**面板那一层 0.88 的白**（不是页面），所以字仍然压在白底上 ——
                        "读得清"靠的是面板的兜底层，不是这一行的实心白（`index.css` 那一段有算式）。
                     ⚠️ 当前页那一行仍是 `accentsoft`（实色）：它是"我在这一页"的记号，要稳。 */
                  background: on ? 'var(--color-accentsoft)' : 'transparent',
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
                    /* ⚠️ 说明小字这一轮从 `--color-ink3` 提到 **`--color-ink2`**：
                       面板变成半透明之后，最坏背景（底下是深色内容）上 ink3 只剩 ≈1.9:1，
                       而 ink2 在**面板的兜底白**上仍有 ≈5.2:1（AA 过线）。
                       要不要再浅，先看 `index.css` 里那段算式 —— 这行字是"菜单里的字"里最细的一档。 */
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}>
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

/* ============================================================
   🆕 2026-10-09 F4：**亮 / 暗切换**那颗小圆钮

   放哪儿（用户原话：「切换的按钮就放在**平台标题的右侧**，用一个小圆钮」）：
     · **桌面**：左栏最上面那一行（树形图标 + 「树高教师平台」+ TEACHER CONSOLE）的**右端** ——
       就是"平台标题的右侧"字面意思。那里原来只有品牌标，右边是空的，加一颗不挤任何东西。
     · **移动端**：左栏在窄屏是**没有的**（`<aside>` 是 `hidden lg:block`），
       所以放**顶部那一条玻璃顶栏**里、平台名右侧、班级标签左边。
       **理由**：那颗按钮的语义是"平台级显示设置"，而移动端唯一一处**全局**的位置就是这条顶栏；
       放「我的」页要多点两层（而且它不是账号设置，是显示设置），
       放底部胶囊要挤掉一个导航格（48px 的格子一个都不能少，见 §十五）。
       ⚠️ 顶栏窄屏下只有 50px 高，所以这一颗必须**比桌面那颗小一档**（见下面两个 size 常量）。

   ⚠️ **触控目标不许小于现在那些**（用户点过这一条）：
     桌面 30×30、移动 34×34 —— 都**大于**左栏「当前班级」那个 34 高的 `select`，
     也大于顶部那颗 23 高的班级标签；移动端 34 与 `Logo` 那一格同级。
     （移动端导航胶囊里的图标格是 44×44，那是"手指每天点十几次"的东西；
       这一颗是**每次会话用一次**的显示开关，按 34 走，但**不许更小**。）

   🔴 图标显示的是**当前档**（暗色显示太阳、亮色显示月亮，照 `more ? 收起 : 展开` 那条口径）——
      点下去会变成什么，`title` / `aria-label` 里说清楚。
   ============================================================ */

/** 桌面左栏那颗的直径（⚠️ 与下面 `mt-4` 那一行的行高对齐，改尺寸要一起看） */
const THEME_BTN_DESKTOP = 30
/** 移动端顶栏那颗的直径（顶栏只有 50 高，30 会显小、38 会顶到边） */
const THEME_BTN_MOBILE = 34

function ThemeToggle({
  theme,
  onToggle,
  size = THEME_BTN_DESKTOP,
}: {
  theme: 'light' | 'dark'
  onToggle: () => void
  size?: number
}) {
  const dark = theme === 'dark'
  const label = dark ? '切到亮色模式' : '切到暗色模式'
  return (
    <button
      type="button"
      onClick={onToggle}
      data-theme-toggle={theme}
      aria-label={label}
      title={label}
      className="grid shrink-0 place-items-center"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        border: '1px solid var(--color-line2)',
        /* 圆钮是"浮在标题行上的一颗"：底色比它所在的底**高一档**（暗色下就是"更亮"那一档） */
        background: 'var(--color-surface2)',
        color: dark ? 'var(--color-accentink)' : 'var(--color-ink2)',
        cursor: 'pointer',
        transition: 'color .18s cubic-bezier(.22,.8,.24,1), background-color .18s',
      }}
    >
      {dark ? <IconSun size={size >= 34 ? 18 : 16} /> : <IconMoon size={size >= 34 ? 18 : 16} />}
    </button>
  )
}

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
   * 🆕 亮 / 暗（2026-10-09 F4）。
   * ⚠️ `pathname` 是它的 `key`：路由一变就重算一次 —— 这一条专门兜住
   *    「从教师端进 `/classroom`」时把 `data-theme` 摘掉（教室端恒亮，见 `lib/theme.ts`）。
   *    ⛔ 别改成 `useTheme()` 不带参：那样进教室端那一下属性会留到下一次重载。
   */
  const { theme, toggle: toggleTheme } = useTheme(pathname)

  /*
   * 右栏「名单体检」要的那一份数据（2026-10-08 修「0 人的班被画成绿勾」）。
   *
   * 🔴 走班班的成员在 `class_members`（多对多，§27.5）—— **不进 `loadSnapshot()`**
   *    （老库上没有那张表），所以这里**懒加载 + 先探针**，与班级页那两处同一条纪律。
   * ⚠️ 读不到 → `sidKnown = false` → 屏上写「人数待读」，**绝不写 0 人**（§三.4 的三态）；
   *    而写班名那一行只在**点数**，与"读没读到"无关（照旧按 `students.class_id` 数）。
   */
  const streamIdList = classes
    .filter((c) => classKindOf(c) === 'stream')
    .map((c) => c.id)
  const sidKey = streamIdList.join(',')
  const [sidList, setSidList] = useState<Record<string, Student[]>>({})
  const [sidKnown, setSidKnown] = useState(false)
  useEffect(() => {
    if (!sidKey) return
    let alive = true
    void remote.loadClassMembersFull(sidKey.split(',')).then((r) => {
      if (!alive) return
      setSidKnown(r.known)
      const by: Record<string, Student[]> = {}
      for (const [k, list] of Object.entries(r.by)) {
        by[k] = list.map((p, i) => ({
          id: p.id,
          name: p.name,
          studentNo: p.studentNo,
          status: p.status,
          createdAt: i,
        }))
      }
      setSidList(by)
    })
    return () => {
      alive = false
    }
  }, [sidKey])  /** 🔴 动效敏感的人：左栏那层高亮也**直接跳、不带弹簧**（与移动端同一条纪律） */
  const reduced = useReducedMotion()
  /** 左栏高亮要不要走弹簧（`false` = 直接跳） */
  const railFlow = !reduced

  /*
   * 🔴 **桌面左栏的选中高亮 = 一层会"流"过去的高亮**（2026-10-01 第三轮追加 · 用户第三张图）
   *
   * 用户原话：「这个地方的选中按钮也改一下质感吧，要 **Q 弹的液态效果**（**这个是长方形的，
   * 效果别叠太过了**）」。参考的是"**液体在管子里流过去**"，不是"两滴水融合"。
   *
   * 高亮**本来就已经是一层**（`.rail-pill` 那颗绝对定位的 span，`top`/`height` 由测量给出），
   * 这一轮改的是**它怎么动**：
   *   · 位移从"CSS 过渡 + 一次 `scaleY(1.24)` 的 WAAPI 拉伸"换成**一个 rAF 弹簧**
   *     （与移动端那颗果冻同一套常数：`SPRING_STIFF` / `SPRING_DAMP`）——
   *     所以有"略欠阻尼"的过冲与回弹；
   *   · **沿运动方向轻轻拉长**：`scaleY = 1 + min(6%, |v| × 0.012)` —— 速度决定拉伸量，
   *     到位自动收回 1（⛔ 不用 1.24 那种大变形，也不加 gooey：矩形做融合会很难看）；
   *   · `height` 也走弹簧（各项高度将来不同也能平滑过去）。
   *
   * 🔴 **三条纪律（都容易被漏）**：
   *   ① **首屏不许播动画**：`st.init` 为假时**直接定位**（否则一进页面高亮从顶部飞下来，很怪）；
   *   ② **`prefers-reduced-motion: reduce` → 直接跳、无弹簧**（与移动端同一条）；
   *   ③ **窗口尺寸 / 左栏自己滚动 / 栏内高度变化之后要重算**（否则高亮会指错项）——
   *      见下面 `measure()` 里的 `resize` + `scroll` + `ResizeObserver`。
   * ⚠️ 2026-10-08：**同一个 `measure()` 还负责算"滚动到哪一边"**（`railScroll` → 渐隐），
   *    因为导航项那一块现在溢出时自己滚（`.rail-nav`）。两者共用一套触发，
   *    ⛔ 别为渐隐再挂一套监听（同一件事两个触发口径 = 本仓库踩过四次的坑）。
   * ⚠️ 选中态的三个信号**一个都没删**（竖条 / 高亮底 / 文字与图标变蓝）：
   *    用户明确要求"可辨识性不许降低"，`shots.mjs` 里有一条专门钉"至少还有两个"。
   */
  const railNavRef = useRef<HTMLElement>(null)
  const railPillRef = useRef<HTMLSpanElement>(null)
  const [railInd, setRailInd] = useState({ top: 0, height: 40, show: false })
  /**
   * 🔴 **导航项那一块滚到哪儿了**（2026-10-08 追加：用户要"溢出了就自动变成能滚动的，交界处要有过渡"）。
   *
   * 值说的是**哪一边还要渐隐**（不是"滚到哪"）：
   *   · `none`   —— 放得下，**既没有滚动条也没有渐隐**；
   *   · `bottom` —— 在顶端、底下还有内容 → **底下渐隐**；
   *   · `top`    —— 在底端、顶上还有内容 → **顶上渐隐**；
   *   · `both`   —— 中间，两头都还有内容。
   * CSS 按这个属性选择器决定 `mask-image`（见 `index.css` 的 `.rail-nav`）。
   * ⚠️ **它由下面那个 `measure()` 写** —— 与高亮重算**同一处、同一套触发**（`resize` /
   *    `scroll` 按帧合并 / `ResizeObserver`），**没有另起一套监听**。
   */
  const [railScroll, setRailScroll] = useState<'none' | 'top' | 'bottom' | 'both'>('none')
  /** 量出来的**目标**（弹簧按它跑；`measure()` 之外没人写） */
  const railTarget = useRef({ top: 0, height: 40 })
  /** 弹簧自己的状态：位置 / 高度 / 两个速度 / 跑没跑过（首屏靠它判断"直接定位"） */
  const railSpring = useRef({ top: 0, height: 40, v: 0, vh: 0, init: false, raf: 0 })

  const activeIdx = visible.findIndex((n) =>
    n.end ? pathname === n.to : pathname.startsWith(n.to),
  )

  useEffect(() => {
    const measure = () => {
      const rw = railNavRef.current
      if (!rw) return
      /*
       * 🔴 先算**溢出方向**（跟高亮**共用这一次测量**，所以下面那三个触发就是它的触发）。
       *    `scrollHeight - clientHeight <= 1` = 放得下 → `none`（不出滚动条、不出渐隐）。
       * ⚠️ 两端各留 1px 容差：`scrollTop` 是整数而 `scrollHeight` 可能是小数，
       *    没这个容差会在"刚好滚到底"时闪一下渐隐。
       */
      const over = rw.scrollHeight - rw.clientHeight
      const next: 'none' | 'top' | 'bottom' | 'both' =
        over <= 1
          ? 'none'
          : rw.scrollTop <= 1
            ? 'bottom'
            : rw.scrollTop >= over - 1
              ? 'top'
              : 'both'
      setRailScroll((v) => (v === next ? v : next))
      const el = rw.querySelector<HTMLElement>('[data-active="true"]')
      if (!el) {
        setRailInd((v) => ({ ...v, show: false }))
        return
      }
      const r = el.getBoundingClientRect()
      const pr = rw.getBoundingClientRect()
      /*
       * 🔴 **必须加 `rw.scrollTop`**（2026-10-08 加上"导航项那一块自己滚"之后的新口径）：
       *    高亮那一片是**绝对定位在 `nav` 里**的，也就是**滚动内容的一部分** —— 它跟着内容
       *    一起被卷走。而 `r.top - pr.top` 量到的是**卷过之后**的视口相对值，
       *    直接写进去就**少算了一个 `scrollTop`**。
       *    实测（脚本探针）：滚到底时高亮整片飞到可见区外 330px，而且量一次动一次。
       *    ⚠️ 横竖都别退回 `r.top - pr.top`：不滚时 `scrollTop` 是 0，两条式子等价；
       *       一滚起来只有这条对。`left` 不由这里管（`left/right: 0` 是 CSS 定的）。
       */
      railTarget.current = { top: r.top - pr.top + rw.scrollTop, height: r.height }
      setRailInd({ top: railTarget.current.top, height: railTarget.current.height, show: true })
    }
    measure()
    const t = window.setTimeout(measure, 80)
    /* 🔴 **重算的三种触发**（用户点名要的第三条）：窗口尺寸、左栏自己滚动、栏内高度变化
       （字体变大 / 身份标签换行 / 顶部公告条让位都会改高度）。
       ⚠️ 滚动那条要**按帧合并**：`scroll` 一秒钟能来上百次，每次都量一遍 = 布局抖动。 */
    let queued = false
    const onScroll = () => {
      if (queued) return
      queued = true
      window.requestAnimationFrame(() => {
        queued = false
        measure()
      })
    }
    const nav = railNavRef.current
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', onScroll, { passive: true })
    nav?.addEventListener('scroll', onScroll, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (nav) ro?.observe(nav)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll)
      nav?.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [pathname])

  /* 🔴 桌面左栏那一层高亮**怎么动**：见上面那段注释（弹簧 / 首屏直接定位 / reduced 直接跳） */
  useEffect(() => {
    const pill = railPillRef.current
    if (!pill) return
    const st = railSpring.current
    const put = (top: number, height: number) => {
      pill.style.top = `${top}px`
      pill.style.height = `${height}px`
    }
    /* ① **首屏直接定位**（不插值）；② reduced-motion：也直接跳（并且不再往下跑弹簧） */
    if (!st.init || !railFlow) {
      const target = railTarget.current
      st.top = target.top
      st.height = target.height
      st.v = 0
      st.vh = 0
      st.init = true
      put(st.top, st.height)
      pill.style.transform = 'scaleY(1)'
      if (!railFlow) return
    }
    let last = performance.now()
    let lastTarget = Number.NaN
    let stable = 0
    const tick = (t: number) => {
      /* 掉帧时按真实间隔折算，免得"帧率越低弹簧越硬" */
      const k = Math.min(3, Math.max(0.2, (t - last) / 16.7))
      last = t
      const tg = railTarget.current
      /* ⚠️ 目标没变够几帧**不许判定"停稳"**：否则第一帧就可能把还在路上的动画收掉（移动端踩过） */
      stable = tg.top === lastTarget ? stable + 1 : 0
      lastTarget = tg.top
      st.v = (st.v + (tg.top - st.top) * SPRING_STIFF * k) * Math.pow(SPRING_DAMP, k)
      st.top += st.v * k
      st.vh = (st.vh + (tg.height - st.height) * SPRING_STIFF * k) * Math.pow(SPRING_DAMP, k)
      st.height += st.vh * k
      /* "液体在管子里流过去"：动的时候沿运动方向拉长一点点，到位收圆 */
      const stretch = Math.min(0.06, Math.abs(st.v) * 0.012)
      put(st.top, st.height)
      pill.style.transform = `scaleY(${(1 + stretch).toFixed(4)})`
      if (stable > 8 && Math.abs(tg.top - st.top) < 0.25 && Math.abs(st.v) < 0.05) {
        st.top = tg.top
        st.height = tg.height
        st.v = 0
        st.vh = 0
        put(st.top, st.height)
        pill.style.transform = 'scaleY(1)'
        st.raf = 0
        return
      }
      st.raf = requestAnimationFrame(tick)
    }
    st.raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(st.raf)
      st.raf = 0
    }
  }, [pathname, activeIdx, railFlow, reduced, railInd.top, railInd.height, railInd.show])

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
            {/* 🆕 亮 / 暗切换 —— **平台标题的右侧**（用户指定的位置，见 `ThemeToggle` 的说明） */}
            <span className="flex-1" />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
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
            data-rail-flow={railFlow ? 'on' : 'off'}
            /* 滚到哪儿了 → CSS 决定哪一边渐隐（见 `index.css` 的 `.rail-nav`） */
            data-rail-scroll={railScroll}
            /*
             * 🔴 放不下时**只有这一块滚**（`min-h-0` 是关键：flex 子项默认 `min-height: auto`
             *    会撑住不肯缩，那样滚的不是它、而是把底下那两行顶出去）。
             *    ⚠️ 底部的「已连接云端」「N 个班级」在 `nav` **外面** → 它们固定在底部不跟着滚。
             */
            className="rail-nav relative mt-3 flex min-h-0 flex-1 flex-col gap-0.5 pt-3"
            style={{ borderTop: '1px solid var(--color-line)' }}
          >
            {/*
              🔴 这一层高亮的 `top` / `height` / `transform` 由**上面那个 rAF 弹簧**逐帧写
              （所以这里**不能**再写 `transition: top`：CSS 过渡 + JS 弹簧 = 两套动画叠加，
              会变成"追不上又抖"）。React 只管 `opacity` 这一个属性。
            */}
            <span
              ref={railPillRef}
              className="rail-pill"
              style={{ opacity: railInd.show ? 1 : 0 }}
            />
            {visible.map((n) => (
              <RailItem key={n.to} {...n} dot={n.to === '/notices' && hasUnreadNotice} />
            ))}
          </nav>

          <div
            /* 稳定选择器（回归脚本按它取"底部那两行"，见 shots.mjs 的「左栏导航溢出可滚」）：
               🔴 它在 `nav` **外面** —— 滚的只有导航项，这两行固定在底部。 */
            data-rail-foot
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
          {/* 🆕 亮 / 暗切换 —— 移动端摆在这里（左栏在窄屏没有，理由见 `ThemeToggle` 的说明）。
              ⚠️ 它排在班级标签**左边**：标签是"这一页在看哪个班"（内容级），
                 主题是"平台怎么显示"（平台级）—— 平台级靠标题更近。 */}
          <ThemeToggle theme={theme} onToggle={toggleTheme} size={THEME_BTN_MOBILE} />
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
                border: '1px solid var(--color-warnline)',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1, flexShrink: 0 }}>
                <IconAlert size={16} />
              </span>
              <span style={{ flex: 1 }}>
                <span
                  style={{ display: 'block', fontSize: 13, fontWeight: 620, color: 'var(--color-warnink)' }}
                >
                  数据没能存到服务器
                </span>
                <span
                  style={{ display: 'block', fontSize: 11.5, color: 'var(--color-warnink2)', marginTop: 2 }}
                >
                  {syncError} · 本地已保留
                </span>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--color-warnink2)', flexShrink: 0 }}>
                知道了
              </span>
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
                  /*
                   * 🔴 **人数从哪儿读，取决于这是哪种班**（2026-10-08 修）。
                   *
                   *   走班班是 `classes` 里 `kind='stream'` 的一行，它的人来自
                   *   `class_members`（**多对多**）—— 在 `students.class_id` 上**永远没有他们**。
                   *   这里原来对两种班都算 `analyzeRoster(c.students)`，于是走班班恒为 0 人，
                   *   而 0 人又恰好"没有缺号、没有重号" → 右栏给它画一个**绿勾**。
                   *   同一份数据在班级页说 2 人、在这里画勾 —— 两个页面自相矛盾。
                   *
                   * 🔴 判据只有一处：`lib/roster.ts` 的 `rosterStateOf()`（四态）。
                   *    这一块**不许**自己写 `count === 0`，也不许拿 `analyzeRoster` 的
                   *    `healthy` 直接当"正常" —— 0 人不是"完整"。
                   */
                  const stream = classKindOf(c) === 'stream'
                  const known = stream ? sidKnown : true
                  const rs = rosterStateOf(
                    stream ? (sidList[c.id] ?? []) : c.students,
                    stream ? 'members' : 'class',
                    known,
                  )
                  /* 绿勾只在**真的完整**时画；"还没有名单"/"没读到"/"待核对"都不是绿勾 */
                  const issues = rs.health
                    ? rs.health.gaps.length + rs.health.dupNos.length + rs.health.dupNames.length
                    : 0
                  const good = rs.kind === 'ok'
                  return (
                    <div key={c.id} className="flex items-center gap-2">
                      <span
                        style={{
                          color: good ? 'var(--color-ok)' : 'var(--color-warn)',
                          display: 'grid',
                          placeItems: 'center',
                        }}
                      >
                        {good ? <IconCheck size={14} /> : <IconAlert size={14} />}
                      </span>
                      <span className="flex-1 truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                        {c.name}
                      </span>
                      <span
                        className="num"
                        style={{
                          fontSize: 12,
                          color: !good && issues === 0 ? 'var(--color-warn)' : 'var(--color-ink3)',
                        }}
                      >
                        {rs.kind === 'unknown'
                          ? '人数待读'
                          : rs.kind === 'nobody'
                            ? '还没有名单'
                            : `${rs.count} 人`}
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
