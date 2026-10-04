/* ============================================================
   强制置顶小窗
   用 Document Picture-in-Picture（Edge / Chrome 116+）。
   它是真正的系统级置顶窗口 —— 能压在全屏的新教育平台之上，
   而普通的浏览器页面做不到这一点。

   没有这个 API 时（旧版浏览器 / Firefox / Safari）返回 null，
   调用方退化为「页内可拖动面板 + 明确提示」。

   🔴 2026-10-04 补：**壳自己声明开不了时也按"没有"处理**（`documentPip: false`，
      见 `lib/classroomShell.ts` 的 `shellDocumentPipUnavailable()`）—— 教室端 exe 里
      API 对象在、`requestWindow()` 必抛，光看"API 在不在"会判错。

   🔴🔴 2026-10-04 再补（施工单 `教室端原生置顶小窗` §三）：**壳有自己那条路时先走壳**。
      教室端 exe = Electron 33：`typeof documentPictureInPicture === 'object'` 而
      `requestWindow()` 必抛 `InvalidStateError: … Internal error: no window`
      ⇒ 网页那条路在壳里是**死的**。壳自带一个真正的系统级置顶窗口
      （`BrowserWindow({ alwaysOnTop: true })` + `setAlwaysOnTop(true,'screen-saver')`）。
      ⇒ 分支顺序定死：**壳原生 → Document PiP（网页版）→ 都没有（`no-api`）**。
      ⚠️ 网页版读不到 `__shell_out` ⇒ 还是走中间那一条，**一字不变**。

   ⚠️ 三态仍然是三态：`ok:false` 的 `why` 还是 `'no-api'`（连能力都没有）与
      `'failed'`（有，但没开成）两档 —— 屏上那是两句不同的话。
   ============================================================ */

import {
  shellDocumentPipUnavailable,
  shellPipAvailable,
  shellPipClose,
  shellPipData as pushPipData,
  shellPipOpen,
  type ShellPipData,
} from './classroomShell'

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options?: {
        width?: number
        height?: number
        disallowReturnToOpener?: boolean
      }): Promise<Window>
      window: Window | null
    }
  }
}

/**
 * 开小窗的**结果**——🔴 三态，不是一个 `Window | null`（2026-10-04 改）。
 *
 * 为什么必须分开（用户 2026-10-04 报：「**不支持置顶小窗**，为什么还要点一下解锁声音」）：
 *   原来这个函数把**两件完全不同的事**都回成 `null`：
 *     ① 浏览器/壳里**根本没有** Document PiP 这个 API（老浏览器；或壳里没开）；
 *     ② API **在**，但 `requestWindow()` **抛了异常**（有的壳里就是这个）。
 *   调用方只能笼统地说一句「当前浏览器不支持置顶小窗（需要 Edge / Chrome 116 及以上）」
 *   —— 而在**教室端 exe 里那句话是假的**：它跑的是 Electron 33（Chromium 130）、
 *   `app://` 也是按 `secure: true` 注册的，压根不是"浏览器太老"。
 *   ⇒ 「探不到」与「坏了」必须分得开（本项目反复栽在这一条上）。
 */
export type PipResult =
  | {
      ok: true
      /**
       * Document PiP 那个窗口对象（网页版才有）。
       * 🔴 **壳原生那一条路上它是 `null`** —— 那个窗口是主进程建的，网页侧拿不到它的
       *    `document`，所以调用方**不许**对它 `addEventListener` / 往里 portal 任何东西。
       *    要看"是不是壳那条路"就判下面的 `native`。
       */
      win: Window | null
      /** `true` = 壳自己开的原生置顶窗口（`win` 必为 `null`）；`false` = Document PiP */
      native: boolean
    }
  /** `no-api` = 连这个能力都没有；`failed` = 有，但申请窗口失败（`message` 是原始报错） */
  | { ok: false; why: 'no-api' | 'failed'; message: string }

export function pipSupported(): boolean {
  if (typeof window === 'undefined') return false
  /*
   * 🔴 顺序也是口径（施工单 §三）：**壳原生优先**。
   *    壳里 Document PiP 是死的（实测必抛），而壳那条路是活的 ⇒ 先看壳。
   *    ⚠️ 这里不能拿 `documentPip === false` 去否决壳那条路：教室端 exe
   *      **两个字段同时为真**（`pip` 在、`documentPip: false`），先判后者就永远判不出原生小窗。
   */
  if (shellPipAvailable()) return true
  /*
   * 🔴 壳自己声明开不了时，**不许**只看 API 在不在（2026-10-04）：
   *    教室端 exe（Electron 33）里 `documentPictureInPicture` 是个**真对象**，
   *    但 `requestWindow()` 必抛 `InvalidStateError: … Internal error: no window`
   *    —— 详见 `classroomShell.ts` 的 `shellDocumentPipUnavailable()`。
   *    ⚠️ 教师端 exe 走的也是这一支（壳有、但没有原生小窗、也没有网页那条路）
   *      ⇒ 那块「这台机器上开不了置顶小窗」的横幅在那儿是**真话**。
   */
  if (shellDocumentPipUnavailable()) return false
  return !!window.documentPictureInPicture
}

/** 把主文档的样式复制进小窗 —— 否则里面是没有样式的裸 HTML */
function copyStyles(doc: Document) {
  for (const node of Array.from(
    document.querySelectorAll('style, link[rel="stylesheet"]'),
  )) {
    doc.head.appendChild(node.cloneNode(true))
  }
  // 让 root 变量也生效
  const base = doc.createElement('style')
  base.textContent = `
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
  `
  doc.head.appendChild(base)
}

export async function openPip(width = 344, height = 168): Promise<PipResult> {
  /*
   * 🔴🔴 **壳原生优先**（施工单 §三：分支顺序 = 壳 → Document PiP → no-api）。
   *    教室里那条屏上 `documentPictureInPicture` 这个对象**在**，可 `requestWindow()`
   *    必抛 ⇒ 不先判壳的话就是"点了没反应 + 一句假的'浏览器太老'"。
   *    ⚠️ 壳那条路**没有 `win`**（窗口在主进程手里）⇒ 回 `win: null` + `native: true`，
   *      调用方据此走"没有 window 可挂"的那一支（别去 `addEventListener`）。
   */
  if (shellPipAvailable()) {
    const opened = await shellPipOpen()
    if (opened) return { ok: true, win: null, native: true }
    /* 桥在、壳侧却没建出来（或那个 channel 没人接）—— 这是 `failed`，不是 `no-api` */
    return { ok: false, why: 'failed', message: '壳没建出小窗（shell:pipOpen 回了 false / 超时）' }
  }
  /* 壳声明开不了 ⇒ 连试都不试（试了就是一屏"没打开"的红字，老师白按一次） */
  if (shellDocumentPipUnavailable()) {
    return { ok: false, why: 'no-api', message: '壳声明不支持（preload 的 documentPip=false）' }
  }
  const dpip = window.documentPictureInPicture
  if (!dpip) return { ok: false, why: 'no-api', message: '没有 documentPictureInPicture' }
  try {
    const win = await dpip.requestWindow({ width, height, disallowReturnToOpener: false })
    copyStyles(win.document)
    return { ok: true, win, native: false }
  } catch (e) {
    /* 🔴 原始报错要带出去：调用方要据此说"没打开"（而不是"你的浏览器太老"） */
    return { ok: false, why: 'failed', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

/**
 * 关掉小窗 —— **两条路各关各的**：
 *   · 壳原生：叫主进程 `win.close()`（关掉之后壳会回 `shell:pipClosed`，网页据此复位）；
 *   · Document PiP：关那个 window 对象。
 * ⚠️ 没开的时候调它**不是错误**（卸载、切维护模式时都会顺手调一次）。
 */
export function closePip() {
  if (shellPipAvailable()) {
    shellPipClose()
    return
  }
  window.documentPictureInPicture?.window?.close()
}

/**
 * 往小窗推一屏数据（**只有壳原生那条路需要**；Document PiP 走的是 React portal）。
 * ⚠️ 网页版 / 教师端 exe 上调它什么都不做（适配层里判过了）。
 */
export function pushPipScreen(data: ShellPipData): void {
  pushPipData(data)
}

/** 小窗被关掉时回调（**两条路都会有**：壳的 `closed` 事件 / Document PiP 的 `pagehide`） */
export { shellPipOnClosed as onPipClosed } from './classroomShell'
