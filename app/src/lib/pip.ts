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
   ============================================================ */

import { shellDocumentPipUnavailable } from './classroomShell'

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
  | { ok: true; win: Window }
  /** `no-api` = 连这个 API 都没有；`failed` = 有，但申请窗口失败（`message` 是原始报错） */
  | { ok: false; why: 'no-api' | 'failed'; message: string }

export function pipSupported(): boolean {
  if (typeof window === 'undefined') return false
  /*
   * 🔴 壳自己声明开不了时，**不许**只看 API 在不在（2026-10-04）：
   *    教室端 exe（Electron 33）里 `documentPictureInPicture` 是个**真对象**，
   *    但 `requestWindow()` 必抛 `InvalidStateError: … Internal error: no window`
   *    —— 详见 `classroomShell.ts` 的 `shellDocumentPipUnavailable()`。
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
  /* 壳声明开不了 ⇒ 连试都不试（试了就是一屏"没打开"的红字，老师白按一次） */
  if (shellDocumentPipUnavailable()) {
    return { ok: false, why: 'no-api', message: '壳声明不支持（preload 的 documentPip=false）' }
  }
  const dpip = window.documentPictureInPicture
  if (!dpip) return { ok: false, why: 'no-api', message: '没有 documentPictureInPicture' }
  try {
    const win = await dpip.requestWindow({ width, height, disallowReturnToOpener: false })
    copyStyles(win.document)
    return { ok: true, win }
  } catch (e) {
    /* 🔴 原始报错要带出去：调用方要据此说"没打开"（而不是"你的浏览器太老"） */
    return { ok: false, why: 'failed', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

export function closePip() {
  window.documentPictureInPicture?.window?.close()
}
