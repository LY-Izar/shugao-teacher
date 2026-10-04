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

     ① 原生壳（apk / exe）  → `window.__shell_out.notify(...)`
        ⚠️ **两个壳现在都接了**（2026-10-04 核实；本段旧版写"此刻还没接"已过期）：
           · apk → `_src/shell-bridge-apk.js` → `@capacitor/local-notifications`
           · exe → `_src/desktop/preload.js` → `ipcRenderer.invoke('shell:notify')`
           判据仍是**能力在不在**，不是"壳在不在" —— 口子留了但没实现时，
           老老实实报「不支持」，不许假装发得出去。
     ② 网页                → 浏览器 `Notification` API（要求 https 或 localhost）

     ⚠️ **两个壳的权限口不一样**（见下面 `ShellNotifyBridge`）：
        apk 有 `notifyPermission` / `openNotificationSettings`，exe **没有**
        ⇒ 判据一律写"这个方法在不在"，没实现的那档**如实报不知道**。

   ⚠️ **网页行为逐字不变**：网页上 `window.__shell_out` 不存在 ⇒ 一路落到 ③。
   ============================================================ */

/** 壳那边暴露的通知能力。
 *
 * ⚠️ **两个壳的这一份形状现在不完全一样**（2026-10-04 核实）：
 *   · apk（`_src/shell-bridge-apk.js`）有 `notifyPermission` / `openNotificationSettings`
 *   · exe（`_src/desktop/preload.js`）只有 `notify`
 * 所以判据一律写成 **"这个方法在不在"**，不许写成"是不是壳" ——
 * 没实现的那档**如实报不知道**，不许猜（§三.5：不可写的路径要显式报错）。
 */
interface ShellNotifyBridge {
  notify?(title: string, body: string): Promise<boolean>
  /** apk 有；exe 没有（Windows 的通知开关不在这里） */
  notifyPermission?(): Promise<'granted' | 'default' | 'unsupported'>
  /** apk 有；exe 没有 */
  openNotificationSettings?(): Promise<boolean>
  /** `'electron'` | `'capacitor'`。exe 一直有，apk 2026-10-04 补上 —— 文案按端分支要用 */
  platform?: string
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
 * 通知权限 —— **同步版，只适合当初值**（挂载那一瞬的猜测值）。
 *
 * 🔴🔴 **原生那一档它永远回 `'default'`**（2026-10-04 修）：
 *   旧版这里直接 `return 'default'`，**从不问桥接层** —— 而 apk 的桥接层
 *   早就实现好了 `notifyPermission()`（`_src/shell-bridge-apk.js:75`）。
 *   ⇒ **即使系统通知已经授权，横幅也永远是"还没开"+ 一个点了没出路的按钮**，
 *     绿的「通知已开启」在 apk 上**永远到不了**。
 *   🔴 这和 `97cf3fd`（key 读不到被显示成"未配置"）是**同一个病根**：
 *      **桥接层给了答案，业务层没去读。**
 *
 * ⚠️ 想要真值请用 `readNotifyPermission()`（异步，`Schedule.tsx` 挂载后刷一次）。
 * ⚠️ **绝不能**在这里返回 `'unsupported'` —— 那会让界面说"这个浏览器不支持"，
 *   而那句话在 apk 里是错的（就是它误导了老师）。
 */
export function notifyPermission(): NotificationPermission | 'unsupported' | 'native' {
  const ch = notifyChannel()
  if (ch === 'unsupported') return 'unsupported'
  if (ch === 'native') return 'default'
  return Notification.permission
}

/**
 * 通知权限 —— **真值版**（异步，因为原生那一支的答案在桥那边）。
 *
 * 三档怎么来的：
 *   · **apk** → 桥接层 `notifyPermission()` → `'granted' | 'default' | 'unsupported'`
 *     （`LocalNotifications.checkPermissions()`，Android 13+ 才有运行时权限，
 *      低版本系统自己回 granted —— **版本判断在原生侧做，前端不重复判**）
 *   · **exe** → 桥接层**没有**这个方法（Windows 的通知开关不在 Electron 这一层）
 *     → 回 `'native'` = "走原生这条路，网页没有权限概念"。
 *     这一档是**如实报不知道**，不是"假装已授权"；界面已有 `'native'` 的文案。
 *   · **网页** → `Notification.permission`
 *
 * 🔴 桥接层**实现了但抛错** → 回 `'default'`（= 还没问过），
 *    **不回 `'granted'`**（那会把"读不到"说成"已授权"），
 *    也**不回 `'unsupported'`**（那会说"这个浏览器不支持"，在 apk 里是错的）。
 */
export async function readNotifyPermission(): Promise<
  NotificationPermission | 'unsupported' | 'native'
> {
  const ch = notifyChannel()
  if (ch === 'unsupported') return 'unsupported'
  if (ch === 'web') return Notification.permission

  const s = shell()
  // 口在但没实现（exe 就是这样）→ 'native'
  if (typeof s?.notifyPermission !== 'function') return 'native'
  try {
    const p = await s.notifyPermission()
    if (p === 'granted' || p === 'unsupported') return p
    return 'default'
  } catch {
    // 读失败 = 不知道 → 'default'（灰态：还没问过），**不许当成已授权**
    return 'default'
  }
}

/**
 * 真的去把通知打开。
 *
 * · **apk** → `openNotificationSettings()` 跳系统通知设置
 *   （拒过一次之后系统**不会再弹授权框**，只能引导去设置 —— 桥接层注释里写着）
 * · **exe** → 桥接层没有这个口 → 不谎称跳了，返回 `false`，
 *   界面据此说清楚"要去 Windows 设置里开"
 * · **网页** → `Notification.requestPermission()`
 *
 * @returns `'granted'` 已经开 · `'native'` 走了系统设置（回来还要再读一次） ·
 *          `'denied'` / `'default'` 没开成 · `'unsupported'` 发不出去
 */
export async function requestNotify(): Promise<NotificationPermission | 'unsupported' | 'native'> {
  const ch = notifyChannel()
  if (ch === 'unsupported') return 'unsupported'

  if (ch === 'native') {
    const s = shell()
    // apk：真跳系统设置。跳完**权限不会立刻变**（用户在设置里改，回来才生效），
    // 所以这里回 'native'，由调用方在页面重新可见时**再读一次**（`readNotifyPermission`）。
    if (typeof s?.openNotificationSettings === 'function') {
      try {
        await s.openNotificationSettings()
      } catch {
        /* 跳失败也不谎称成功 —— 回 'native' 让界面照实说"去系统设置里开" */
      }
    }
    // 🔴 原生那一支**不弹网页的权限框** —— 那是另一个入口。
    //   这里返回 'native' 让界面走"去系统设置里开"那条文案，而不是谎称已授权。
    return 'native'
  }
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/**
 * 发一条系统通知 —— **同步版**。
 *
 * ⚠️⚠️ **原生那一支（apk / exe）同步拿不到结果，所以这里回 `false`**（2026-10-04 修）。
 *   旧版是 `void Promise.resolve(s?.notify?.(...)).catch(() => false)` 然后 **`return true`**
 *   —— 那把桥接层**如实回的 `false`**（用户拒权限 / 没建渠道 / `schedule` 抛错）
 *   整个丢掉了，**恒报成功**。后果不是"少个提示"：
 *     `useScheduleReminder` 只在 `ok === false` 时才做页内兜底 ⇒ **系统通知没发出去时，
 *     连页内提醒也没有** ⇒ 到点**无声无息**。
 *   🔴 和 `97cf3fd` 是同一个病根：**失败被返回值抹平**。
 *
 *   现在按"**此刻还没确认发出**"如实回 `false`（宁可多一条页内，
 *   也不要"以为发出去了其实没发"—— 这句是原注释里的意图，旧代码没做到）。
 *
 * 🔴 **要真结果请用 `notifyAsync()`**（调用方只有 `useScheduleReminder` 一处，已改用它）。
 *
 * ⚠️ 网页那一支的 `window.setTimeout(n.close, 15000)` **逐字保留** ——
 *    不许"顺手优化"，网页上 15 秒后自动消失就是既有行为。
 *
 * @returns `true` = 确定发出去了；`false` = 没发出去 / 此刻还不知道
 */
export function notify(title: string, body: string): boolean {
  const ch = notifyChannel()

  if (ch === 'native') {
    // 同步给不了真结果 ⇒ 如实报"还没确认"，让调用方的页内兜底照常工作。
    // ⚠️ 真正要发的那一下照发（不能因为拿不到结果就不发）。
    void shell()?.notify?.(title, body)?.catch(() => false)
    return false
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

/**
 * 发一条系统通知 —— **异步版，回的是真结果**。
 *
 * 这是 `useScheduleReminder` 用的那一条：它必须知道**到底发出去没有**，
 * 才能在失败时补一条页内提示（不然到点无声无息）。
 *
 * @returns `true` = 真的发出去了；`false` = 没发出去，**调用方必须退化成页内提示**
 */
export async function notifyAsync(title: string, body: string): Promise<boolean> {
  const ch = notifyChannel()

  if (ch === 'native') {
    try {
      const r = await shell()?.notify?.(title, body)
      // 桥接层没实现 `notify`（口在方法不在）时 `r` 是 undefined ⇒ 也算没发出去
      return r === true
    } catch {
      return false
    }
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

/**
 * 这个壳是哪一端 —— **文案按端分支要用的唯一信号**。
 *
 * · `'electron'`   → 教师端 / 教室端 exe（`preload.js` 一直有）
 * · `'capacitor'`   → apk（`_src/shell-bridge-apk.js` 2026-10-04 补上；
 *                     在那之前 apk 和 exe **同值**，所以"手机的系统设置"
 *                     这句话在教师端 exe 上原样显示 —— 那是错的）
 * · `null`          → 网页版（或桥接层没带这个字段）
 *
 * ⚠️ 老包（补 `platform` 之前打的 apk）会回 `null` ⇒ 按**网页**分支走文案，
 *    这是安全的降级（不会说出"手机"这个词之外的假话）。
 */
export function shellPlatform(): 'electron' | 'capacitor' | null {
  const p = shell()?.platform
  if (p === 'electron' || p === 'capacitor') return p
  return null
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