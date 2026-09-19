/* ============================================================
   系统通知
   Web 端用 Notification API。要求 https 或 localhost；
   局域网 http 打开时浏览器会拒绝，这里会返回 false 并让调用方降级。
   ============================================================ */

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  if (!notifySupported()) return 'unsupported'
  return Notification.permission
}

export async function requestNotify(): Promise<NotificationPermission | 'unsupported'> {
  if (!notifySupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/** 发一条系统通知。失败时返回 false，调用方应退化到页内提示。 */
export function notify(title: string, body: string): boolean {
  if (!notifySupported() || Notification.permission !== 'granted') return false
  try {
    const n = new Notification(title, { body, tag: title + body, lang: 'zh-CN' })
    window.setTimeout(() => n.close(), 15000)
    return true
  } catch {
    return false
  }
}
