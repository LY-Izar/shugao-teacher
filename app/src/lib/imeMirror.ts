/* ============================================================
   输入法组字（IME composition）的**全局镜像** —— 2026-10-04
   「apk 上点按钮会把刚打的几个字吞掉」那一类 bug 的根治处
   ------------------------------------------------------------
   🔴 用户报的症状（原话）：**「点按钮后会把输入了的字吞掉几个」**，
      进一步确认是「**字在框里也没了**」—— 不是"没保存"，是屏上就少了那几个字。

   ── 机制（两步，缺一不可）─────────────────────────────────────────
   ① 受控输入的 `value` 与 DOM 里的文字**短时间对不上**：拼音还没选词上屏时，
      那几个字已经在编辑框里（屏上看得见），而 React 那一侧的状态可能还停在
      最后一个上屏的字上 —— 两种可能都会造成它，而**结果完全一样**：
        · 那一击的 `input` 事件**没派发**（Android WebView 的组字是原生写进编辑框的，
          `compositionupdate` 会来，`input` 不一定来）；
        · 或者它**来得比这次重渲染晚**（IME 的提交是异步的）。
   ② 只要发生**任何一次重渲染**，React 就会把 `value` 写回它自己那份旧值
      ⇒ **屏上那几个未上屏的字被冲掉**。桌面浏览器上这两件事通常同步得很好，
      所以它表现为"只有手机（apk）上才会"。

   ── 修法（就是这一条）──────────────────────────────────────────
   **在 `compositionupdate` / `compositionend` 时补派发一个 `input` 事件** ——
   React 的受控输入于是重新读一次 `el.value`（里面**已经含**未上屏的拼音），
   "屏上有什么、状态里就有什么"，那次写回就成了空操作，那几个字不再被冲掉。

   ⚠️ 它不是"绕过受控输入"、也不是"组字期间不许 setState"：
      只是**让状态跟上屏上**。🔴 反过来说：**不要再往 `onChange` 里加
      `.trim()` / `.slice()` 这类"改写用户正在打的字"的变换** —— 那会把刚补上的
      这一笔又改掉（要规范化就在**提交那一刻**做，不在每一击上做）。

   ── 三条边界 ──────────────────────────────────────────────────
   ① **只在组字期间/结束时补**，其余时刻一个事件都不多发（正常打字路径逐字不变）；
      而且 `input` 事件本来就会派发的环境里，补的这一下是**空操作**
      （React 的值跟踪器已经同步过，值没变就不触发 `onChange`）。
   ② 补的必须是**冒泡的真事件**：React 18 的监听挂在容器（`#root`）上，
      所以这里挂在 `document` 的**捕获**阶段 —— 比 React 更早，收得到；
      不冒泡就永远到不了 React。
   ③ 🔴 **它一个字节都不改 DOM**（不碰 `el.value`、不模拟按键）——
      所以不可能自己制造出一次输入、也不会与组件的 `onChange` 打架
      （程序化改 `value` 本来就不派发 `input`）。
   ============================================================ */

/** 会组字的文本输入（`checkbox` / `radio` / `file` / `range` 那些不算） */
function isTextField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  const node = el as HTMLElement
  if (node.tagName === 'TEXTAREA') return true
  if (node.tagName !== 'INPUT') return false
  const t = (node as HTMLInputElement).type
  /* ⚠️ `type` 缺省（没写这个属性）时是 `'text'`，要算进来 */
  return ['text', 'search', 'url', 'tel', 'password', 'email', 'number', ''].includes(t)
}

/**
 * 装一次（幂等）。在 `main.tsx` 里调一次即可。
 *
 * ⚠️ 用 `window` 上的一个标记位防重复装：热更新（HMR）会把模块重新求值，
 *    没有它就会一次输入挂上好几个监听（每个都补一次事件 = 无谓的重渲染）。
 */
export function installImeMirror(): void {
  if (typeof document === 'undefined') return
  const w = window as unknown as { __imeMirrorInstalled?: boolean }
  if (w.__imeMirrorInstalled) return
  w.__imeMirrorInstalled = true

  const mirror = (e: Event) => {
    const el = e.target
    if (!isTextField(el)) return
    /*
     * 🔴 `isComposing: false` 是**有意的**：补这一下的目的就是让受控输入
     *    "把屏上这一笔当成已上屏的字收下来"，所以不能标成组字中。
     *    `InputEvent` 不可用时退回普通 `Event`（老 WebView）。
     */
    const ev =
      typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, isComposing: false })
        : new Event('input', { bubbles: true })
    el.dispatchEvent(ev)
  }

  document.addEventListener('compositionupdate', mirror, true)
  document.addEventListener('compositionend', mirror, true)
}
