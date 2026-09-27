import { useCallback, useEffect, useState } from 'react'

/**
 * 主题（亮 / 暗）—— **全站唯一的一处判定**
 *
 * ============================================================
 * 口径（2026-10-09 F4，用户拍板的三条，改动前先读）
 * ============================================================
 *  ① **默认跟随系统**：`prefers-color-scheme`。用户没手动切过时，
 *     系统设置一变界面就跟着变（不只是"首次打开"那一下）。
 *  ② **手动切过就记住**：写 `localStorage['shugao.theme']` = `'light'` / `'dark'`；
 *     从此**不再被系统覆盖**（用户切成亮色、系统又是暗的 → 重载仍然是亮的）。
 *  ③ 🔴 **教室端恒亮**：`/classroom` 上**永远不写** `data-theme`。
 *     那块大屏挂在**亮着灯的教室**里给学生看，暗色在那儿是错的 ——
 *     这是硬规矩，不是偏好。所以 `isClassroom()` 一命中，**读也不读**偏好、
 *     **写也不写**属性（"彻底不动"比"先写再擦"少一次闪烁，也少一种失败方式）。
 *
 * ⚠️ **为什么还要 `index.html` 里那段内联脚本**：这一段是模块，跑起来的时候
 *    第一帧早就画完了 —— 暗色用户会看到一次**白闪**。那段内联脚本是它的**门卫版**
 *    （同样的三条口径，只有 8 行），首帧之前就把属性写上；这里再接管后续的切换。
 *    两处的口径必须一致：`localStorage` 的键名、属性名、`/classroom` 那一句。
 *
 * ⚠️ **不进 `store.ts`**：主题是"这台设备怎么显示"，不是业务数据 ——
 *    进 zustand 就会被 `shugao.teacher.v1` 那份快照一起备份/恢复/同步，
 *    而它既不该进备份，也不该跟着账号走（`backup.ts` 那边一行都不用改）。
 *
 * ============================================================
 * 🆕 2026-10-10 F6：**强调色轴**（`data-accent` = `blue` | `purple`）
 * ============================================================
 * 用户拍板：「**保留原来的蓝**，新增『校色紫』，合成 **4 套主题**」+「**原来的主题也要保留**」。
 * **两个轴正交**：上面那条（亮/暗）管 24 个令牌里的 21 个，这一条只管"跟着品牌色走"的那几个
 * （`index.css` 里两个紫块，见那边的说明）。于是 4 套 = 亮蓝(默认) / 暗蓝 / 亮紫 / 暗紫。
 *
 * 这条轴的**三条口径**（与亮/暗那三条刻意不同，别照抄）：
 *   ① 🔴 **默认恒 `blue`**，且**不写属性** —— `blue` 时把 `<html data-accent>` **摘掉**，
 *      于是一个没选过强调色的用户，DOM 与"这一轮之前"**逐字相同**（这是"129 张图不变"的前提，
 *      `shots.mjs` F6 有一条断言钉着它）。
 *   ② 🔴 **跟随系统（`prefers-color-scheme`）只作用于亮暗，不作用于强调色** ——
 *      系统里没有"系统喜欢什么品牌色"这回事。所以这条轴**没有** `systemDark()` 那一支，
 *      也**不进** `watch()` 的 `onSystem` 分支（系统一变，强调色一动不动）。
 *   ③ 🔴 **教室端恒亮 + 默认蓝**：`/classroom` 上连 `data-accent` 也**不写**（"今天什么样就什么样"）。
 *      ⚠️ **机制要说准**（别照着 F4 那句想当然）：`/classroom` 是**独立的一整屏、不套 `AppShell`**
 *      （`App.tsx` 那条路由），而 `Guard` 又在挂 `AppShell` **之前**就做 `hydrate` 与跳转 ——
 *      所以教室端上**本模块的 `apply()` 根本不会被调用**，AppShell 也没挂上 → 那块屏天然就是默认蓝。
 *      `Classroom.tsx` 只摘 `data-theme`（它不该知道强调色这一轴），**它也不需要知道**。
 *      ⚠️ **首帧那段内联脚本现在是"读到 `purple` 才写"**（F6 收尾补的那一句）——
 *      教室端所以仍然不写：内联脚本第 2 句就 `return` 了，`data-accent` 与 `data-theme` 一起不写。
 *      下面 `effectiveAccent()` 里那一句 `isClassroom() → 'blue'` 是**第二道**：
 *      万一将来有人把教室端套进应用壳，这条判据仍然把强调色按住（不赌"谁先谁后"）。
 *      `shots.mjs` F6-E 用"用户已经选了暗紫"的偏好直接开 `/classroom` 钉这件事（含反向对照）。
 *
 * ✅ **2026-10-10 F6 收尾：那段内联脚本已经补上强调色那一句** ——
 *    它现在也读 `localStorage['shugao.accent']`，是 `purple` 就写 `data-accent="purple"`
 *    （**默认 / 没选过 / 教室端 → 三个属性一律不写**，与下面口径①逐字一致）。
 *    于是"选了紫的用户硬重载先看到一帧蓝"这个缺口**关掉了**：首帧之前属性就在。
 *    ⚠️ 它在 `index.html` 的 `<head>` 里、是**首帧之前**跑的，所以那一句必须**极便宜**：
 *    只多读一个 key、多写一个属性，没有循环 / 没有查询 / 没有正则（`shots.mjs` F6-H 钉来源）。
 *    ⚠️ 两处的键名与属性名仍然必须**同字**：`shugao.theme` / `shugao.accent` /
 *    `data-theme` / `data-accent` / `/classroom` 那一句 —— 改一处就要同时改两处。
 */

/** `localStorage` 的键。⚠️ 与 `index.html` 里那段内联脚本**必须同字** */
export const THEME_KEY = 'shugao.theme'

/** `<html>` 上的属性名。⚠️ 同上，且与 `index.css` 的 `:root[data-theme='dark']` 同字 */
export const THEME_ATTR = 'data-theme'

export type Theme = 'light' | 'dark'

/** 🆕 F6：强调色那条轴的 `localStorage` 键（⚠️ 与 `THEME_KEY` **是两个键**，互不覆盖） */
export const ACCENT_KEY = 'shugao.accent'

/**
 * 🆕 F6：`<html>` 上的属性名 —— 与 `index.css` 里 `:root[data-accent='purple']` 同字。
 * ⚠️ `blue`（默认）时**不写这个属性**（见文件头口径①）。
 */
export const ACCENT_ATTR = 'data-accent'

/** 🆕 F6：强调色两档 —— `blue` 是**默认**，`purple` 是"校色紫"（校徽原色那一族） */
export type Accent = 'blue' | 'purple'

/** 教室端判定：判据只有"这扇窗的路径是不是 /classroom"，不猜别的 */
function isClassroom(): boolean {
  if (typeof window === 'undefined') return false
  return /^\/classroom(\/|$)/.test(window.location?.pathname ?? '')
}

/** 系统的偏好（读不到就按亮色 —— 与全站默认一致） */
function systemDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  } catch {
    return false
  }
}

/** 用户手动切过的那一档；没切过（或存的值不认识）→ `null` = 跟随系统 */
export function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

/** 当前**应该**是哪一档（教室端恒 `'light'`） */
export function effective(): Theme {
  if (isClassroom()) return 'light'
  return stored() ?? (systemDark() ? 'dark' : 'light')
}

/**
 * 把结果写到 `<html>`。
 * 🔴 教室端是"**摘掉**属性"，不是"写上 light" —— 摘掉之后连 `color-scheme` 都回到
 *    浏览器默认（亮），而写 `light` 会留下 `color-scheme: light` 这条我们并不想拥有的声明。
 *
 * 顺手把 `<meta name="theme-color">` 也换掉（它决定手机浏览器地址栏/状态栏那条的颜色）：
 * 不换的话，暗色下顶部会压着一条**亮灰色**的横带（`index.html` 里那个 `#E8EBF2`）。
 */
const META_COLOR: Record<Theme, string> = { light: '#E8EBF2', dark: '#0C0F14' }

export function apply(): Theme {
  const want = effective()
  if (typeof document !== 'undefined') {
    if (want === 'dark') document.documentElement.setAttribute(THEME_ATTR, 'dark')
    else document.documentElement.removeAttribute(THEME_ATTR)
    applyAccent()
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', META_COLOR[want])
  }
  return want
}

/* ---------------- 🆕 F6：强调色那条轴 ---------------- */

/** 用户选过的强调色；**没选过（或存的值不认识）→ `'blue'`**（默认，不是"跟随系统"） */
export function storedAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY)
    return v === 'purple' ? 'purple' : 'blue'
  } catch {
    return 'blue'
  }
}

/** 当前**应该**是哪种强调色（教室端恒 `'blue'` —— 口径③） */
export function effectiveAccent(): Accent {
  if (isClassroom()) return 'blue'
  return storedAccent()
}

/**
 * 把强调色写到 `<html>`（**只写这一个属性**，主题那条由 `apply()` 管）。
 *
 * 🔴 `blue` 是"**摘掉**属性"而不是"写上 blue"：默认那份值就在 `@theme` 里，
 *    写上 `data-accent="blue"` 只会让 DOM 与改动前**不再逐字相同**（多一个属性），
 *    而且会让"4 套"变成"CSS 里其实有 3 套"。
 */
export function applyAccent(): Accent {
  const want = effectiveAccent()
  if (typeof document !== 'undefined') {
    if (want === 'purple') document.documentElement.setAttribute(ACCENT_ATTR, 'purple')
    else document.documentElement.removeAttribute(ACCENT_ATTR)
  }
  return want
}

/**
 * 手动换强调色：**落 `localStorage` + 立刻生效**。
 * ⚠️ 教室端直接返回 `'blue'`（不写、不存、不改属性）—— 与 `set()` 同一条纪律。
 * ⚠️ 「跟随系统」在这条轴上**不存在** → 没有 `clearOverride()` 的对应物。
 */
export function setAccent(next: Accent): Accent {
  if (isClassroom()) return 'blue'
  try {
    localStorage.setItem(ACCENT_KEY, next)
  } catch {
    /* 存不下就是存不下（与 `set()` 同一处理）：这一次仍然生效，
       下一次重载会退回默认蓝 —— 界面状态照旧从 `effectiveAccent()` 读。 */
  }
  return applyAccent()
}

/**
 * 🔴 **模块级那一下**（F6）：强调色这条轴**不依赖"谁调用 `apply()`"**。
 *
 * 为什么必须要有它：`/admin`、`/login` 这些页面**不套 `AppShell`**（各自是独立的一整屏）——
 * 没人调 `apply()`，用户选的紫在这些页面上会**掉回蓝**（`shots.mjs` F6 拍 `/admin` 那张暗紫图时
 * **真的红过一次**，实测 `data-accent=null`、`accent=#5386f4` —— 这条就是那次红的修法）。
 *
 * 它只做两件事：**路径不是 `/classroom` 且存了 `purple` → 写上；否则（默认蓝 / 教室端）→ 摘掉**。
 * 于是教室端那一条也顺带被这一句守住（`effectiveAccent()` 里的 `isClassroom()` 是**真会被走到**的，
 * 不是摆设）。
 *
 * ✅ F6 收尾之后它的角色变了一点（**别以为可以删**）：首帧那段内联脚本也写 `data-accent` 了，
 *    所以"挂载之前那一帧"不再靠它 —— 但**它仍然是唯一一股"页面上没人调 `apply()` 时也生效"的力**，
 *    而且 SPA 里改完 `localStorage` 之后就靠它重算（内联脚本只在**文档加载**时跑一次）。
 * ⚠️ 它是**模块副作用**、跑在首帧之后（ES module 是 defer 的）。
 * ⚠️ `typeof document === 'undefined'` 这个守卫**不能删**：Node 下的脚本
 *    （`grade-checks` 之类）也会 import 到这个模块。
 * ⚠️ 别把它挪进某个 `useEffect`："不套应用壳的页面也要生效"正是它存在的理由。
 */
if (typeof document !== 'undefined') applyAccent()

/**
 * 手动切换：**写偏好 + 落 `localStorage` + 立刻生效**。
 * ⚠️ 教室端直接返回 `'light'`（不写、不存、不改属性）：那块屏没有一个切换入口，
 *    真有谁从控制台调到这里，结果也只会是"什么也没发生"，而不是"教室端变暗了"。
 */
export function set(next: Theme): Theme {
  if (isClassroom()) return 'light'
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* 隐私模式 / 配额满：**存不下就是存不下**（不假装成功）。
       这一次切换仍然生效 —— `apply()` 读到的是"没手动覆盖过"，于是它按系统档算；
       用户点的那一下在视觉上可能"没变化"，但**下一次点仍然会再试**，
       而且界面上的按钮状态是从 `effective()` 读的（不会显示一个存不下的状态）。 */
  }
  return apply()
}

/** 清掉手动覆盖 → 回到"跟随系统"（`Settings` 之类想给一个"跟随系统"按钮时用） */
export function clearOverride(): Theme {
  if (isClassroom()) return 'light'
  try {
    localStorage.removeItem(THEME_KEY)
  } catch {
    /* 同上 */
  }
  return apply()
}

/**
 * 让 `<html>` 与"当前应该的样子"保持同步，并返回当前值。
 *
 * 监听三条：
 *   · `prefers-color-scheme` 变化 → **仅在没手动覆盖过时**跟着变（口径 ①②）；
 *   · `storage`（别的标签页改了偏好）→ 跟着变；
 *   · `popstate`（浏览器前进/后退）→ 重新算一次（"从教师端退到教室端"这件事
 *     在 SPA 里是 `pushState`，不触发 `popstate`；SPA 那边由 `AppShell` 的
 *     `useTheme` 在路由变化时再调一次 `apply()` 兜住）。
 */
export function watch(onChange: (t: Theme) => void): () => void {
  const sync = () => onChange(apply())

  const mq = (() => {
    try {
      return window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
    } catch {
      return null
    }
  })()

  const onSystem = () => {
    // 🔴 手动覆盖过就不理系统（口径 ②）—— 这是"默认跟随"与"记住我的选择"的分界
    if (stored() !== null) return
    sync()
  }

  mq?.addEventListener?.('change', onSystem)
  window.addEventListener('storage', sync)
  window.addEventListener('popstate', sync)

  sync()

  return () => {
    mq?.removeEventListener?.('change', onSystem)
    window.removeEventListener('storage', sync)
    window.removeEventListener('popstate', sync)
  }
}

/**
 * 界面层要的那几件东西：**当前档（亮/暗 + 强调色）** + **切换的两个入口**。
 *
 * ⚠️ `useTheme()` 的**消费者只有 `AppShell` 一处**（平台标题右侧那颗圆钮 + 它展开的选择器）——
 *    别的页面想读主题就 `var(--color-*)`，**不要**各自再调一次这个 hook：
 *    那是"同一件事多个判定入口"，本仓库为这个坑付过四次代价。
 *
 * 🆕 F6：`accent` / `setAccent` 与 `theme` / `toggle` **是同一个 hook 的两半**，
 *    不另开一个 `useAccent()`：两条轴写的是**同一个 `<html>`**，分两个 hook 就会有两套
 *    订阅与两套 effect（"谁先写"变成一个隐式依赖）。
 */
export function useTheme(
  key?: string,
): { theme: Theme; toggle: () => void; accent: Accent; setAccent: (a: Accent) => Accent } {
  const [theme, setTheme] = useState<Theme>(() => effective())
  const [accent, setAccentState] = useState<Accent>(() => effectiveAccent())

  useEffect(() => {
    /*
     * `watch()` 里会先 `sync()` 一次 —— 这一句同时兜住三件事：
     *   ① 首屏（内联脚本已经写过属性，这里只是把 React 的状态对齐）；
     *   ② **SPA 路由变化**：`AppShell` 把 `pathname` 当 `key` 传进来，于是路由一变
     *      这个 effect 就重跑一次 → 两条轴都按**新**路径重算并重新落属性
     *      （路由此刻已经 `pushState` 完了，所以 `effective()` 读到的是新路径 ——
     *      顺序是对的，别把 `key` 改成"导航前"的某个值）。
     *   ③ 🆕 F6：强调色那条轴走的是**同一次** `apply()`（不另开订阅）——
     *      两条轴永远在同一次提交里对齐，不会出现"亮暗换了、强调色还差一帧"。
     */
    return watch((t) => {
      setTheme(t)
      setAccentState(effectiveAccent())
    })
  }, [key])

  const toggle = useCallback(() => {
    setTheme(set(effective() === 'dark' ? 'light' : 'dark'))
  }, [])

  const pickAccent = useCallback((a: Accent) => {
    const got = setAccent(a)
    setAccentState(got)
    return got
  }, [])

  return { theme, toggle, accent, setAccent: pickAccent }
}
