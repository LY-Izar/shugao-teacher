/* ============================================================
   「返回」—— 顶层 tab 的两难，与那个唯一正确的形状
   ------------------------------------------------------------
   适用对象：**既是顶层 tab（左栏 / 底部胶囊）、又能从「我的」点进来**的页面，
   今天只有两个 —— `/schedule`（日程表）与 `/wrong`（错题集）。

   为什么写死一条路径不对（两边总有一边是错的）：
     · 写死 `/settings`（日程表原来的写法）—— 从 tab 进来时上一页可能是
       工作台 / 班级 / 作业…，回到「我的」是**说谎**；
     · 写死 `/`（错题集原来的写法）—— 从任意一页点 tab 进来，返回时被扔回首页，
       同样不是"上一页"。

   正解不是猜入口，而是**问浏览器历史**（React Router v7 自己在 `history.state`
   里维护的序号，见 `react-router` 的 `getUrlBasedHistory()`）：
     · `idx > 0` → 这一次会话里**确实还有上一页** → `navigate(-1)`，回到用户来的那一页；
     · `idx === 0` → 这一页是**直接打开的**（书签 / PWA 图标 / 手打地址）→ **没有上一页**，
       这时裸 `navigate(-1)` 会把他**带出应用**（回到上一个站点，PWA 里就是关掉 / 白屏）
       → 所以回**兜底路径**。

   🔴 **不许裸用 `navigate(-1)`**：上面第二种情况就是它的现场。
   ⚠️ 兜底路径必须用 `replace`：直开时历史里只有这一页，用 push 会在
      `/schedule → /` 之间留下一条能来回弹的记录。
   ⚠️ **同一件事不许两套写法**：这两页不许各写一遍 `idx` 判断，一律走本函数。
   ============================================================ */

import type { NavigateFunction } from 'react-router-dom'

/**
 * 顶层 tab 页的「返回」：**有上一页就回上一页，没有（书签 / PWA 直开）就回 `fallback`**。
 *
 * @param navigate `useNavigate()` 的返回值
 * @param fallback 没有历史时的兜底路径。顶层 tab 一律给 `'/'`：它们彼此是**同级**，
 *                 唯一说得通的"上一级"是应用根 —— 写某一个入口的父页（`/settings`）
 *                 会让返回键只在"从「我的」进来"那一半的情况下对。
 */
export function goBackOr(navigate: NavigateFunction, fallback: string): void {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > 0) {
    navigate(-1)
    return
  }
  navigate(fallback, { replace: true })
}
