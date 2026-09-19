/* ============================================================
   强制置顶小窗
   用 Document Picture-in-Picture（Edge / Chrome 116+）。
   它是真正的系统级置顶窗口 —— 能压在全屏的新教育平台之上，
   而普通的浏览器页面做不到这一点。

   没有这个 API 时（旧版浏览器 / Firefox / Safari）返回 null，
   调用方退化为「页内可拖动面板 + 明确提示」。
   ============================================================ */

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

export function pipSupported(): boolean {
  return typeof window !== 'undefined' && !!window.documentPictureInPicture
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

export async function openPip(width = 344, height = 168): Promise<Window | null> {
  const dpip = window.documentPictureInPicture
  if (!dpip) return null
  try {
    const win = await dpip.requestWindow({ width, height, disallowReturnToOpener: false })
    copyStyles(win.document)
    return win
  } catch {
    return null
  }
}

export function closePip() {
  window.documentPictureInPicture?.window?.close()
}
