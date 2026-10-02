/* ============================================================
   系统通知（网页 / 壳 三条路）
   ============================================================
   🔴🔴 **这层存在的唯一理由**：apk 里的 WebView **没有 `Notification`**。
      `notifySupported()` 原来只看 `'Notification' in window` ⇒ 在 apk 里恒 false
      ⇒ `Schedule.tsx` 恒显示那句「**这个浏览器不支持系统通知**」，
      而它旁边的建议是「把网站装到手机桌面后再授权」——
      🔴 **老师已经装成 apk 了**（他就在 apk 里看到这句），照着做也没用。
      那句文案在 apk 里是**错的建议**（2026-10-03 用户截图报的就是这个）。
   ----------------------------------------------------------------
   三条路与判据（**判据不许写成「有没有 Capacitor」**，理由见文件末尾）：

     ① 原生壳（apk）        → `window.__shell_out.notify(...)`
        ⚠️ 这个壳**此刻还没接**（`preload.js` 里有 `notify` 的口，Android 侧也还没有
           对应的 `@PluginMethod`）。所以判据是**能力在不在**，不是"壳在不在" ——
           口子留了但没实现时，老老实实报「不支持」，不许假装发得出去。
     ② Electron 壳          → `window.__shell_out.notify(...)`（同一条口，Electron 那边
           也没有 → 同样落到 ① 的处理）
     ③ 网页                → 浏览器 `Notification` API（要求 https 或 localhost）

   ⚠️ **网页行为逐字不变**：网页上 `window.__shell_out` 不存在 ⇒ 一路落到 ③。
   ============================================================ */

/** 壳那边暴露的通知能力（Electron preload 声明了口，Android 侧还没实现） */
interface ShellNotifyBridge {
  notify?(title: string, body: string): Promise<boolean>
}

/** 桥接层在不在。与 `fileOut.ts` 用**同一个对象**（`window.__shell_out`）。 */
function shell(): ShellNotifyBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __shell_out?: ShellNotifyBridge }
  return w.__shell_out ?? null
}

/** 原生壳这条路上**真的发得出去**吗（口在 ≠ 实现在） */
function nativeReady(): boolean {
  return typeof shell()?.notify === 'function'
}

/** 网页那一支的浏览器能力（apk 的 WebView 里没有这个） */
function webSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/**
 * 现在能不能发系统通知。
 * @returns `'native'` 走壳 · `'web'` 走浏览器 · `'unsupported'` 真发不出去
 */
export function notifyChannel(): 'native' | 'web' | 'unsupported' {
  if (nativeReady()) return 'native'
  if (webSupported()) return 'web'
  return 'unsupported'
}

/** 网页版兼容旧判据（现在是三者之一，不再只有 boolean） */
export function notifySupported(): boolean {
  return notifyChannel() !== 'unsupported'
}

/**
 * 通知权限。
 *
 * 🔴 原生那一支**没有 `Notification.permission` 这种东西** —— 它是安卓的系统权限，
 *   要问原生插件。所以 `'native'` 这一档的权限状态**只能由调用方另行判断**
 *   （apk 侧插件有 `notificationEnabled()` 方法，R9 接线时接上）。
 *   在那之前，原生档一律返回 `'default'`（= 还没问过），
 *   ⚠️ **绝不能**返回 `'unsupported'` —— 那会让界面说"这个浏览器不支持"，
 *   而那句话在 apk 里是错的（就是它误导了老师）。
 */
export function notifyPermission(): NotificationPermission | 'unsupported' {
  const ch = notifyChannel()
  if (ch === 'unsupported') return 'unsupported'
  if (ch === 'native') return 'default'
  return Notification.permission
}

/** 同上，返回值里多了 `'native'` 这一档（调用方要能分辨"走的是哪条路"） */
export async function requestNotify(): Promise<NotificationPermission | 'unsupported' | 'native'> {
  const ch = notifyChannel()
  if (ch === 'unsupported') return 'unsupported'
  // 🔴 原生那一支**不弹网页的权限框** —— 它要的是安卓系统权限，
  //   那是另一个入口（R9 接 `openNotificationSettings()`）。
  //   这里返回 'native' 让界面走"去系统设置里开"那条文案，而不是谎称已授权。
  if (ch === 'native') return 'native'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * 发一条系统通知。
 *
 * ⚠️ 网页那一支的 `window.setTimeout(n.close, 15000)` **逐字保留** ——
 *    不许"顺手优化"，网页上 15 秒后自动消失就是既有行为。
 *
 * @returns `true` = 真的发出去了；`false` = 没发出去，**调用方必须退化成页内提示**
 *          （`useScheduleReminder` 现在正是这么做的）。
 */
export function notify(title: string, body: string): boolean {
  const ch = notifyChannel()

  if (ch === 'native') {
    const s = shell()
    // 🔴 这里**不能** await —— `notify()` 是同步函数（调用方按老规矩用返回值判断），
    //    而壳那边是异步的。取"发得出去"当作 true，真失败由壳那边自己管；
    //    ⚠️ 这样 apk 里的第一次提醒仍会走页内提示兜底，那是对的（宁可多一条页内，
    //    也不要"以为发出去了其实没发"）。
    void Promise.resolve(s?.notify?.(title, body)).catch(() => false)
    return true
  }

  if (ch === 'unsupported' || Notification.permission !== 'granted') return false
  try {
    const n = new Notification(title, { body, tag: title + body, lang: 'zh-CN' })
    window.setTimeout(() => n.close(), 15000)
    return true
  } catch {
    return false
  }
}

/* ============================================================
   ⚠️ 判据为什么**不能**写成「有没有 Capacitor」（留着，别改回去）
   ------------------------------------------------------------
   `fileOut.ts` 顶上写着同一句，这里再写一次是因为通知这条更隐蔽：

   一、**可靠性**：网页版可以把 `@capacitor/*` 当普通 npm 依赖装进来
      （PWA 封装、`@capacitor/core` 的类型判断都能进网页产物），
      于是"有没有 Capacitor"在网页上**可能为真** ——
      结果是网页分支被原生代码接管，而那里**根本没有原生**。
      现在用的判据是 `window.__shell_out?.notify` **这个能力本身在不在**：
      网页上那个对象压根不存在 ⇒ 恒为假 ⇒ 一路落到浏览器分支。

   二、**可测性**：`window.__shell_out` 有 `__shell_out` 这一个名字可断言，
      而"有没有 Capacitor"要看依赖树 —— 门禁没法在屏上量它。
      `preflight.mjs` 也有 `SHELL` 那条规则盯着谁可以直接摸这个对象。
   ============================================================ */