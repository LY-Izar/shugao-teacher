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
 */

/** `localStorage` 的键。⚠️ 与 `index.html` 里那段内联脚本**必须同字** */
export const THEME_KEY = 'shugao.theme'

/** `<html>` 上的属性名。⚠️ 同上，且与 `index.css` 的 `:root[data-theme='dark']` 同字 */
export const THEME_ATTR = 'data-theme'

export type Theme = 'light' | 'dark'

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
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', META_COLOR[want])
  }
  return want
}

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
 * 界面层要的那两件东西：**当前档** + **切一下**。
 *
 * ⚠️ `useTheme()` 的**消费者只有 `AppShell` 一处**（平台标题右侧那颗小圆钮）——
 *    别的页面想读主题就 `var(--color-*)`，**不要**各自再调一次这个 hook：
 *    那是"同一件事多个判定入口"，本仓库为这个坑付过四次代价。
 */
export function useTheme(key?: string): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => effective())

  useEffect(() => {
    /*
     * `watch()` 里会先 `sync()` 一次 —— 这一句同时兜住两件事：
     *   ① 首屏（内联脚本已经写过属性，这里只是把 React 的状态对齐）；
     *   ② **SPA 路由变化**：`AppShell` 把 `pathname` 当 `key` 传进来，于是路由一变
     *      这个 effect 就重跑一次 → 进 `/classroom` 那一趟会把属性摘掉（教室端恒亮）。
     *      路由此刻已经 `pushState` 完了，所以 `theme.ts` 里的 `effective()` 读到的
     *      是**新**路径 —— 顺序是对的，别把 `key` 改成"导航前"的某个值。
     */
    return watch(setTheme)
  }, [key])

  const toggle = useCallback(() => {
    setTheme(set(effective() === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, toggle }
}
