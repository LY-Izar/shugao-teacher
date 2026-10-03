/* ============================================================
   退场延迟（挂载延迟）
   为什么需要它：以前 `Sheet` / `Modal` 是 `if (!open) return null`
   —— open 一变 false 组件**立刻卸载**，CSS 根本没有机会播退场。
   于是全站**只有进场、没有退场**：抽屉「啪」地消失、对话框闪掉。
   （进场那半边早就有了：`.sheet` 的 `sheet-up`、`.modal` 的 `modal-in`。）

   它只做一件事：**open 变 false 时不立刻卸载，让退场动画跑完。**
   挂不挂载是"看得见"的事；open/open 语义（`inert` / `aria-hidden`）跟 open 走。
   ============================================================ */

import { useEffect, useRef, useState } from 'react'

/**
 * 挂载延迟。
 *
 * @param open  语义状态：要不要开着（`inert` / `aria-hidden` 跟它走）
 * @param ms    退场时长。**0 = 立刻卸载**（不进 timer）
 * @returns `mounted` —— 渲染用这个；判语义用 `open`
 *
 * ⚠️ 三个必写的细节（少一个就是「看不见却点得到」的老毛病）：
 *
 * 1. **`ms` 变化 / `open` 变化时必须清掉旧 timer**（靠 effect 的 cleanup）。
 *    不清的话：关掉 → 150ms 时又打开 → 那个 180ms 的 timer 还在跑 → 提前把组件卸载了。
 * 2. **返回值是 `mounted`，不是 `open`**。调用方**用 `mounted` 渲染、用 `open` 判语义** ——
 *    退场那 180ms 里元素还在 DOM 里，所以必须让 `inert` / `aria-hidden` 跟 `open` 走，
 *    否则它"看不见却能 Tab 到、能点"。
 * 3. **`ms <= 0` 走同步分支，不进 timer**。断言「关掉后元素不存在」的那些调用点传 0，
 *    就不必等 180ms —— 那是**产品级选项**（有的浮层就该立刻消失），不是绕过门禁的后门。
 *
 * 🔴 **与 `实施方案.md §2.1` 那段草稿的差异（有意为之，不是抄漏）**：
 * 草稿是「`mounted` 布尔 + 在 effect 里同步 `setMounted`」。实测那样写会被 oxlint 的
 * `react(set-state-in-effect)` 判 **warning** —— 而本项目门禁要求 oxlint **0 warning 0 error**。
 * 所以改成下面这版，三个必写细节的**行为完全一致**：
 *   · state 存 **`exited`（退场已播完 = 可以卸载了）**，而不是 `mounted` → **少一次渲染**；
 *   · `open` 变 true 时的复位走 **render 期调整**（React 官方认可的
 *     「prop 变了就调 state」那一节，见 react.dev「You Might Not Need an Effect」）；
 *   · `ms <= 0` 那一支**完全不碰 state**，由 `open` 直接派生 → 同步，且断言不用等。
 */
export function useExit(open: boolean, ms = 180) {
  /**
   * 退场**已经播完**（= 可以卸载了）。存的是"已完成"，不是"是否挂载"。
   *
   * 🔴 **初值必须是 `!open`，不能是 `false`**（2026-10-03 修）：返回值是 `open || !exited`，
   * 初值若写 `false`，则**首次就以 `open=false` 挂载**（＝页面第一次渲染里那个关着的
   * `Sheet`/`Modal`）会算成"正在退场"→ 元素被挂出来，而 `.sheet--out` / `.scrim--out`
   * 挂的是 `sheet-down` / `fade-out`，这两条 `@keyframes` **只有 `to`、没有 `from`**
   * ⇒ 起点就是元素自己的静态样式（屏幕内、`opacity:1`），于是**每次都真的画出一个
   * 整屏暗幕 + 一张满高抽屉，再滑下去**，180ms 后才卸载。
   * 实测（390×844 探针，点底部「我的」）：切页后 +453ms 插进 DOM，`scrim` box
   * `[0,0,390,844]`、`op=1`，`sheet` box `[0,101,390,743]`、`op=1`，`sheet-down@180`，
   * +641ms 才删掉 —— 用户报的「底部弹窗出现又消失、闪一下」就是它（与滚动位置无关）。
   */
  const [exited, setExited] = useState(!open)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // render 期调整：重新打开 → 撤销"卸载"这个结论。
  // 不复位的话，「关 → 等满 → 再开 → 再关」第二次关会**立刻**卸载（exited 还留着 true）。
  if (open && exited) setExited(false)

  useEffect(() => {
    // 打开时不需要副作用：细节 2 要的"语义跟 open 走"由下面的返回值直接保证
    if (open) return
    // 细节 3：ms=0 同步卸载 —— 走派生，这一支不设 timer 也不 setState
    if (ms <= 0) return
    // 细节 1：cleanup 负责在 open / ms 变化时清掉旧 timer
    timer.current = setTimeout(() => setExited(true), ms)
    return () => clearTimeout(timer.current)
  }, [open, ms])

  // ms<=0：`open` 就是全部答案。ms>0：开着或在退场期间都算挂载，退场播完才卸载。
  return ms <= 0 ? open : open || !exited
}