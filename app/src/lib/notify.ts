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
  /**
   * 🆕 **把到点提醒交给系统排程**（2026-10-05 加；只有 apk 有，exe 没有）。
   *
   * 🔴 为什么非有不可：见本文件末尾「为什么必须交给系统排程」。
   * 这一支在 apk 里落到原生 `ShugaoNative.scheduleAlarms` → `AlarmManager`
   * （`setExactAndAllowWhileIdle` + `SharedPreferences` 持久化 + 开机重排）。
   * @returns `true` = 系统真的收下了这批闹钟；`false` = 没接上，调用方**必须**保留页内那一条兜底
   */
  scheduleAlarms?(alarms: Array<ShellAlarm>): Promise<boolean>
  /** 🆕 这个壳能不能排**精确**闹钟（Android 12+ 要在设置里开；回 `null` = 不知道） */
  canScheduleExact?(): Promise<boolean | null>
  /**
   * 🆕 **精确闹钟没授权时，跳到系统那一页**（Android 12+ 的「闹钟与提醒」；
   * 只有 apk 有，网页版与两个 exe 都没有 —— 它们也没有这个东西要授权）。
   *
   * 🔴 为什么非有不可：`canScheduleExact()` 只**量**得出来"没授权"，量完
   *   只丢一句"收不到"等于把老师扔在原地（`AGENTS.md` §三.5：不可写的路径要显式报错，
   *   而且**要给一条真能走的出路**）。原生侧那个方法（三级回退：
   *   带包名跳转 → 不带包名跳转 → 应用详情页）早就写好了，**桥接层一直没挂** ⇒ 网页侧无从调用。
   */
  openExactAlarmSettings?(): Promise<boolean>
  /* ============================================================
     🆕 推送链路（2026-10-02，用户拍板"一步到位"）—— 只有 apk 的壳有这几个口。
     判据照旧写"方法在不在"：exe / 网页版一个字都不会变。
     ============================================================ */
  /** 首启引导：Android 13+ 的通知授权弹窗（**真弹**，与只读的 `notifyPermission` 不同） */
  requestNotifyPermission?(): Promise<'granted' | 'denied' | 'unsupported'>
  /** 首启引导：三格读数（通知总开关 / 精确闹钟 / 电池优化白名单） */
  pushStatus?(): Promise<{ notify?: boolean; exact?: boolean; battery?: boolean } | null>
  /** 首启引导：电池优化白名单（系统弹窗，直接跳转引导用户点"允许"） */
  requestIgnoreBattery?(): Promise<{ ok: boolean; already?: boolean; why?: string }>
  /**
   * 🆕 **厂商「自启动 / 后台运行」页**（2026-10-06 加；只有 apk 有）。
   *
   * 与 `requestIgnoreBattery` 是**两个开关**：国产 ROM 上"允许后台运行"与
   * "允许自启动"分开管，前者过了、后者没开，划掉应用后服务照样起不来。
   * 原生侧**逐档回退**（MIUI / EMUI / ColorOS / OriginOS / 三星 / 魅族 / 一加 / 乐视
   * → 最后退应用详情页），每档各自 try/catch。
   * `via` = 真的跳到了哪一页；`tried` = 依次试过哪几档（跳不动时用来定位）。
   */
  openAutoStartSettings?(): Promise<{ ok: boolean; via?: string; tried?: string[]; why?: string }>
  /** 启动推送拉取前台服务（endpoint = 业务站基址；token = /api/push/register 换的钥匙） */
  startPush?(opts: { endpoint: string; accessToken: string }): Promise<{ ok: boolean; why?: string }>
  /**
   * 🆕 **每次打开应用 / 回到前台：确保通知通道在跑**（2026-10-06 加；只有 apk 有）。
   *
   * 与 `startPush` 的差别是这次修复的关键：**它不登记钥匙**（不联网），
   * 只看"钥匙在不在"，在就把前台服务拉起来 —— 见 `shellEnsurePushRunning()`。
   * 老壳没有这一支 ⇒ 调用方**如实跳过**（`unsupported` 那一档），不许假装拉过。
   */
  ensurePushRunning?(opts: { endpoint: string }): Promise<{
    ok: boolean
    running?: boolean
    already?: boolean
    started?: boolean
    why?: string
  }>
  /** 登出时停掉前台服务 */
  stopPush?(): Promise<{ ok: boolean }>
  /**
   * 🆕 **通知自检**（2026-10-05 真机第三轮；只有 apk 有）。
   *
   * 回的是**分散的读数**，不是一句"成功/失败" —— 断在哪一环就哪一格 `false`：
   *   · `notify`  系统允许本应用发通知吗
   *   · `granted` Android 13+ 的运行时权限给了吗
   *   · `channel` 那个通知渠道**在系统里真的存在**吗
   *   · `posted`  测试那条**真的交给系统**了吗
   *   · `why`     没发出去时的人话（能读懂、能照做）
   *   · `unsupported` 这一版壳还没有这个检查（**如实报**，不许假装检查过）
   */
  selfTest?(): Promise<ShellSelfTest>
  /**
   * 🆕 **"两分钟后试一条定时提醒"**（2026-10-05 真机第四轮；只有 apk 有）。
   *
   * 🔴 与 `selfTest()` 的区别是**这一整轮的关键**：`selfTest()` 走**即时**通知那条路
   *   （能证明"能发通知"），而这一个走**真实排程**那条路
   *   （`scheduleAlarms` → `AlarmManager` 精确闹钟 → `YlxbAlarmReceiver` → 通知）。
   *   老师已经验通了即时那条，坏的恰恰是排程这条 ⇒ **只验即时那条等于假绿**。
   */
  remindSelfTest?(): Promise<ShellRemindCheck>
  /** 🆕 回读那条自检到点了没有（"到点那一下到底响没响"的唯一来源） */
  remindSelfCheck?(): Promise<ShellRemindFired>
  /**
   * 🆕 **安卓 API 级别**（只有 apk 有；`Build.VERSION.SDK_INT`）。
   * 回 `0` = 量不出来 ⇒ 界面**不许**照它分档（§三.4：没结论是灰）。
   */
  sdkVersion?(): Promise<number>
  /**
   * ⚠️ 这里**故意没有** `platform` 字段：通知这一层不读它。
   * 读它的是 `lib/classroomShell.ts` 的 `shellPlatform()` ——
   * 留一份在两处正是"声明了没人用"（本项目为此栽过四次）。
   */
}

/**
 * 通知自检的读数（**每一格都要能单独看见** —— 合成一个 boolean 就没法定位断点了）。
 *
 * 🔴 为什么要有这个类型而不用 `boolean`：老师连着两轮报"收不到通知"，而本机
 *   **没有安卓设备**。静态判据钉得住源码形状，钉不住"这台手机上哪一环断了" ——
 *   自检就是那个"把断点搬到屏上"的东西。
 */
export interface ShellSelfTest {
  /** 系统里这个应用的通知是开着的吗（`areNotificationsEnabled()`） */
  notify?: boolean
  /** Android 13+ 的 `POST_NOTIFICATIONS` 给了吗 */
  granted?: boolean
  /** 那个通知渠道在系统里存在吗（**不存在 ⇒ 通知会被静默丢掉**） */
  channel?: boolean
  /** 测试那条真的交给系统了吗 */
  posted?: boolean
  /** 没发出去时的人话 */
  why?: string
  /** 这一版壳还没有这个检查（`selfCheck` / `notifySelfTest` 没挂） */
  unsupported?: boolean
}

/**
 * 🆕 **"两分钟后试一条定时提醒"**的读数（`remindSelfTest()`；只有 apk 有）。
 *
 * 🔴 与 `ShellSelfTest` 分开两个类型而不是合成一个：两者断的**不是同一条路**
 *   （那一个是即时通知，这一个要经过系统闹钟），合成一个就会出现
 *   "即时那条绿了 ⇒ 以为排程也绿了"这一种最贵的假绿。
 *
 * `stage` 是**断在哪一环**（空串 = 这一环没断）：
 *   · `notify`   系统里这个应用的通知被关着
 *   · `granted`  13+ 没给 `POST_NOTIFICATIONS`
 *   · `channel`  那个通知渠道在系统里不存在（**Android 8+ 往不存在的渠道发 = 静默丢掉**）
 *   · `schedule` `AlarmManager` 那一下没排上（抛错 / 时刻已过期 / 拿不到系统服务）
 *   · `''`       真的交给系统了 —— **但"排上了"不等于"到点响了"**，还要 `remindSelfCheck()` 回读
 */
export interface ShellRemindCheck {
  /** 系统允许本应用发通知吗 */
  notify?: boolean
  /** 13+ 的 `POST_NOTIFICATIONS` 给了吗 */
  granted?: boolean
  /** 到点那条用的渠道在系统里存在吗 */
  channel?: boolean
  /**
   * 🆕 那个渠道**开着**吗（`getImportance() != IMPORTANCE_NONE`）。
   *
   * 🔴 与 `channel` **不是同一件事**：Android 允许老师单独关掉某一个渠道
   *   （「应用通知」→「到点提醒」），那时 `areNotificationsEnabled()` 照样回 `true`，
   *   而往 `IMPORTANCE_NONE` 的渠道发通知 = **系统静默丢掉**（不抛错）
   *   ⇒ 只量 `channel` 会把这一档报成"全绿、就是没响"。
   */
  channelOn?: boolean
  /** 那个渠道当前的重要性（`-1` = 没读到） */
  channelImportance?: number
  /** 精确闹钟授权（`false` **不是**断点：会退化成 `setAndAllowWhileIdle`，仍然会响） */
  exact?: boolean
  /** 真的交给系统了吗 */
  scheduled?: boolean
  /** 断在哪一环（空串 = 没断） */
  stage?: string
  /** 断点时的人话 */
  why?: string
  /** 那条自检该响的时刻（Unix 毫秒） */
  fireAt?: number
  /*
   * 🔴 下面四格是**真实那条排程**（`scheduleAlarms`）当场回上来的中间结果 ——
   *    用户 2026-10-05 当场追加的要求："把每一步的中间结果都回报到屏上"。
   *    ⚠️ 它们**不是**"有没有响"，只是"系统收下这条闹钟时说了什么"。
   */
  /** `scheduleAlarms` 回的"真的排上了几条"（`-1` = 没读到） */
  innerScheduled?: number
  /** `scheduleAlarms` 回的"单子里本来有几条" */
  innerRequested?: number
  /** `scheduleAlarms` 当场读到的精确闹钟授权 */
  innerExact?: boolean
  /** 这一版壳还没有这个检查 */
  unsupported?: boolean
}

/**
 * 🆕 **那条自检到点了没有**的读数（`remindSelfCheck()`；只有 apk 有）。
 *
 * 🔴 `fired:false` 的两种意思必须分开（§三.4：没结论是灰）：
 *   · `elapsed:false` ⇒ **还没到点**（灰：再等等，别让老师以为坏了）
 *   · `elapsed:true`  ⇒ 过了点接收器**没跑到**（红：断在 `YlxbAlarmReceiver` 那一环）
 */
export interface ShellRemindFired {
  fired?: boolean
  /** 已经过了那条自检该响的时刻（用来区分"还没到"与"没到"） */
  elapsed?: boolean
  at?: number
  /** 那条自检**该响**的时刻（Unix 毫秒）—— 与 `at` 一起看就知道"晚了多久" */
  due?: number
  /**
   * 🔴 到点那一下**用的渠道 id**（空 = 接收器没跑到）。
   *    它必须与即时那条同为 `shugao-default` —— 这是"两条路同源"的**真机判据**
   *    （屏上直接看得见，不靠源码形状推断）。
   */
  channel?: string
  /** 交给 `NotificationManagerCompat` 的通知 id（`-1` = 没发到那一步） */
  notifyId?: number
  /** 标题走了接收器的兜底（自检那条**本来**就该走兜底 ⇒ `true` 是正常的） */
  fallbackTitle?: boolean
  /** 接收器发通知那一步抛错的原文（空 = 没抛错） */
  receiverError?: string
  /**
   * 🔴🆕 **"到点的提醒被丢了几条"**（`YlxbAlarmReceiver.KEY_DROP_COUNT`；2026-10-06 补）。
   *
   * 为什么非要把它报上来：老师报"提醒没响"时，下面两种情形在**屏上长得一模一样**
   * （都是"什么都没有"），而**修法完全不同**：
   *   · 「**被丢了**」—— 闹钟真的到点了、接收器也跑了，只是**晚得太多**
   *     （超出容忍窗，见 `YlxbAlarmReceiver.STALE_TOLERANCE_MS`）⇒ 这一格 > 0；
   *   · 「**根本没排上**」—— `AlarmManager` 那一步就没成，或这一刻应用从未打开过 ⇒ 恒 0。
   * ⇒ 有这一格，一句"到点了但没响"才**说得出断在哪**（§三.5：不许静默）。
   *
   * ⚠️ 它是**历史累计**（不是"这一次"），而且只在"真的丢了"时才涨 ⇒
   *   读到 `0` **不等于**"从来没丢过"（重装 / 清数据之后从 0 开始）。
   */
  dropCount?: number
  /** 最后一次丢弃发生在什么时候（Unix 毫秒；`0` = 没有过） */
  dropAt?: number
  /** 最后一次被丢的那条**晚了多久**（毫秒；`0` = 没有过） */
  dropLateMs?: number
  exact?: boolean
  why?: string
  unsupported?: boolean
}

/**
 * 要交给系统的那一条闹钟（`fileOut.ts` 那种"只传数据、不传行为"的形状）。
 *
 * 🔴 **`id` 的硬边界**：Android 的 `NotificationManager.notify(int, …)` 收的是 **Java int**，
 *    Capacitor 的本地通知插件对它有一句死判据 ——
 *    `LocalNotification.java:227-231`：`id > Integer.MAX_VALUE` 直接 `reject("The identifier should be a Java int")`。
 *    ⇒ **`id` 必须是 1 … 2147483647 的整数**（0 也不给：通知 id 0 与"没有 id"在别处同义）。
 */
export interface ShellAlarm {
  /** 1 … 2147483647（Java int；越界不是"响不响"的问题，是**当场被原生回绝**） */
  id: number
  /** 到点时刻：Unix 毫秒（`fireAt`） */
  fireAt: number
  title: string
  body: string
  /** 通知渠道 id（原生 `YlxbNativePlugin.CHANNEL_*`；给空串走"一般通知"） */
  channel?: string
  /** 点通知时带给页面的深链（`shugao://…`） */
  payload?: string
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
 * 站点基址**去掉末尾斜杠** —— 全模块**只此一处**（2026-10-06 抽出来）。
 *
 * 🔴 为什么非抽不可：`nav-checks` 的 A24 ① 与它的反向对照要求
 *   「`.replace(/\/+$/, '')` 这一句在 `notify.ts` 的**真代码里恰好 1 处**」
 *   （`String.replace` 只换第一处 ⇒ 有两处时那条对照会改到别的地方去 = **假绿**）。
 *   而这一轮新加的 `shellEnsurePushRunning()` 也需要同一个 trim ——
 *   于是**共用这一个函数**，而不是把那一行再抄一份。
 *
 * 为什么非 trim 不可：原生拼的是 `endpoint + "/api/push"`，而 `apiUrl('')`
 *   返回的是 `https://站点/`（末尾带 `/`）⇒ 变成 `//api/push`。实测（线上）：
 *   `POST /api/push` → **401**（路由在，只是没带 token）；
 *   `POST //api/push` → **405**（命中另一个资源）。
 */
function trimBase(endpoint: string): string {
  return String(endpoint || '').replace(/\/+$/, '')
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

  // ⚠️ 下面的网页分支逐字不变（`window.__shell_out` 不存在 ⇒ 一路落在这一支）

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
   🆕 2026-10-05：**把提醒交给系统排程**（真机反馈「装上了、权限也过了，就是收不到通知」）
   ------------------------------------------------------------
   这一节只做三件事：**算 id / 算时刻 / 转交给桥接层**。
   它**不认识**课表，也不认识 React —— 所以它能在门禁里单独被量（`nav-checks.mjs` 第二十七节）。

   🔴 **为什么必须交给系统排程**（两个各能单独致命的原因）：
     ① 原来整条提醒靠**应用内的 `window.setInterval(60s)`**（`useScheduleReminder.ts` 末尾那个 effect）
        —— 应用一退到后台 / 锁屏 / 被杀，WebView 的定时器就冻结 ⇒ 一个提醒都不会响；
     ② 原来即使那一分钟正好在跑，`notify()` 也是拿 Capacitor 本地通知发**当下这一条**
        （没有 `at`）⇒ 同样的：只在"那一分钟应用正开着"时才有用。
     而原生那一侧**三天前就写好了**（精确闹钟 + 到点通知 + 开机重排），
     断的只是"**网页侧没人调它**" —— 桥接层一个口都没暴露。

   🔴 **id 必须落在 Java int 里**（见 `ShellAlarm.id` 的注释）：原生
      `LocalNotification.java:227-231` 对 `id > Integer.MAX_VALUE` 是**当场 `reject`**，
      而桥接层把它 `catch` 成 `false` ⇒ 界面上只会看到页内那条兜底，系统通知一条都没有。
      ⚠️ **旧式 `Date.now() % 2000000000 + 1` 实测并没有越界**（上界 1 999 999 999）——
      这一条是**契约防线**，不是本次现象的根因（根因见上面 ①②）。
   ============================================================ */

/** id 的上界：**`Integer.MAX_VALUE` 减 1**（留一格余量，且**不给 0** —— 0 与"没有 id"在别处同义） */
export const ALARM_ID_MAX = 2147483646

/**
 * 🔴🔴 **到点那条通知用哪个渠道** —— 字面量**只许有这一份**（2026-10-05 真机第四轮）。
 *
 * 断在哪（两条路各用了**不同的**渠道，而老师已经验通的只有其中一条）：
 *   · 即时那条（`ShugaoNative.notify`）→ 原生 `YlxbNativePlugin.CHANNEL_IMMEDIATE`
 *     = **`shugao-default`**「到点提醒」/ `IMPORTANCE_HIGH` ⇒ 老师点「试一条通知」**真的响了** ✓
 *   · 到点那条（`YlxbAlarmReceiver`）→ 原来兜底取 `CHANNEL_GENERAL` = `shugao_general`
 *     「一般通知」/ `IMPORTANCE_DEFAULT` ⇒ **同一个功能在两个渠道里**
 *     （系统通知设置里两个开关，关掉一个就只有一半提醒会响，界面看不出异常）✗
 *
 * ⇒ 现在**一处定义、两侧引用**：原生那侧是
 *   `YlxbAlarmReceiver.CHANNEL_REMIND = YlxbNativePlugin.CHANNEL_IMMEDIATE`，
 *   本文件是这一条常量 —— 两边字面量都必须是 `shugao-default`，
 *   而它由 `ensureChannels()` 真建过（不然 Android 8+ **静默丢掉**那条通知）。
 *
 * 🔴 为什么在网页侧也写一份：交出去的单子里必须**写明**用哪个渠道
 *   （`nativeReminderPlan()` 每一条都带 `channel`）—— 从前那一条写的是
 *   `'shugao_general'`，与即时那条**不同源**。判据在 `nav-checks.mjs` 第二十七节
 *   （两侧一起数，改任一侧当场红）。
 * ⚠️ **不是** `shugao_general`（那个仍然建着，但没人点名用它了）。
 */
export const SHELL_ALARM_CHANNEL = 'shugao-default'

/** `yyyy-mm-dd` → 一个稳定的天数序号（`Date.UTC` 解析，避免时区把它挪一天） */
function epochDayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = Date.UTC(y || 1970, (m || 1) - 1, d || 1)
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0
}

/**
 * 一条提醒的**稳定**通知 id —— 同一天同一条日程每天都算出同一个数。
 *
 * 🔴 稳定是硬要求：原生 `YlxbAlarms.scheduleAll` 是「**先按 id 取消旧的、再注册新的**」
 *    （`YlxbAlarms.java:80-88`）⇒ id 每次都变的话，重排就会**不停堆**旧闹钟。
 * @returns 1 … `ALARM_ID_MAX`
 */
export function alarmIdOf(day: number, seq: number): number {
  const id = ((Math.trunc(day) * 97 + Math.trunc(seq)) % ALARM_ID_MAX + ALARM_ID_MAX) % ALARM_ID_MAX
  return id + 1
}

/**
 * 提醒到点的**时刻**（Unix 毫秒）。
 *
 * `minute` 是"当天的第几分钟"（`0…1440`）—— **1440 = 次日 00:00**，
 * `Date` 的字段溢出会自己进位，所以不用特判。
 */
export function alarmFireAt(base: Date, dayOffset: number, minute: number): number {
  const d = new Date(base.getTime())
  d.setDate(d.getDate() + Math.trunc(dayOffset))
  d.setHours(0, 0, 0, 0)
  d.setMinutes(Math.trunc(minute))
  return d.getTime()
}

/** 交给系统的那一张单子里的一条（`items` 是**已经算好**的那天那几条课） */
export interface NativePlanItem {
  /** 课表条目 id（`schedule_snoozes` 的键，也是 payload 深链的载荷） */
  id: string
  /** 标题（`10 分钟后上课` 那句） */
  title: string
  /** 正文（班级 · 地点 · 开始时间） */
  body: string
  /** 这一条**当天**该响的第几分钟 */
  minute: number
}

/**
 * 把"今天起 `days` 天要响的提醒"算成一张交给系统的单子。
 *
 * ⚠️ 输入是**每一天各自那几条**（`days[i] = ` 第 i 天要响的），
 *    而不是整张课表 —— 因为"几点响"要经过推迟记录（`scheduleSnoozes`）、
 *    周一顺延、法定假期三道判断，那三道都在调用方（`useScheduleReminder` / `lib/schedule`）已经做过。
 * 🔴 `now` 之前的那些**不算**（过期的闹钟交给系统只会立刻响一下，那是打扰）。
 */
export function nativeReminderPlan(
  days: Array<{ ymd: string; items: readonly NativePlanItem[] }>,
  now: Date,
): ShellAlarm[] {
  const t0 = now.getTime()
  const out: ShellAlarm[] = []
  days.forEach((day, i) => {
    const epochDay = epochDayOf(day.ymd)
    for (const it of day.items) {
      const fireAt = alarmFireAt(now, i, it.minute)
      if (fireAt <= t0) continue
      out.push({
        id: alarmIdOf(epochDay, out.length),
        fireAt,
        title: it.title,
        body: it.body,
        channel: SHELL_ALARM_CHANNEL,
        payload: `shugao://notify/${encodeURIComponent(it.id)}`,
      })
    }
  })
  return out
}

/**
 * 这个壳**有没有**原生排程这个能力（`scheduleAlarms` 在不在）。
 *
 * 🔴 **先问能力、再谈成败** —— 这两件事必须分开：
 *    · 网页版（`window.__shell_out` 不存在）与两个 exe（`_src/desktop/preload.js`
 *      只暴露文件那几个口）**都没有**这个方法 ⇒ 它们本来就没有原生排程；
 *    · 对它们说"关掉应用就收不到"是**噪音**（网页版关掉页面本来就收不到，无需提醒）。
 *
 * ⇒ 调用方拿到 `false` 时必须**直接不进任何提示分支**，
 *   而不是"试一下、`scheduleNativeReminders()` 失败就提示"（那正是这句话
 *   在网页版与两个 exe 上平白弹出来的原因）。
 *
 * @returns `true` = 这个壳能排（这次排得成不成功是另一回事，见 `scheduleNativeReminders()`）
 */
export function shellCanScheduleAlarms(): boolean {
  const s = shell()
  return typeof s?.scheduleAlarms === 'function'
}

/**
 * 把这张单子交给壳去排程（网页版 / exe ⇒ `false`，**一个字都不做**）。
 *
 * ⚠️ 这个 `false` 同时覆盖"没这条路"和"有路但没排上"两种情形 ⇒ **不能**拿它当
 *    "要不要提示用户"的判据：提示前必须先用 `shellCanScheduleAlarms()` 问一句能力。
 *
 * @returns `true` = 系统真的收下了（**此后应用关着也会响**）；
 *          `false` = 没排上（调用方必须保留页内那一条兜底，**不许假装成功**）
 *
 * 🔴 **真机未验**：本机没有安卓设备 —— 这一条只做过静态自检（`tsc` + `nav-checks` 第二十七节）。
 *    真机验收只能由用户在手机上做：打开应用停在日程页 ⇒ 划掉应用 ⇒ 到课前 10 分钟应收到通知。
 */
export async function scheduleNativeReminders(alarms: readonly ShellAlarm[]): Promise<boolean> {
  const s = shell()
  if (typeof s?.scheduleAlarms !== 'function') return false
  if (alarms.length === 0) return false
  try {
    return (await s.scheduleAlarms([...alarms])) === true
  } catch {
    return false
  }
}

/**
 * 这个壳**有没有**"跳到精确闹钟授权页"这条路（`openExactAlarmSettings` 在不在）。
 *
 * 与 `shellCanScheduleAlarms()` 同一套纪律：**先问能力、再谈成败** ——
 * 网页版与两个 exe 都没有这个方法，对它们调它只会拿回 `false`，
 * 界面据此说"去系统设置"就是**照着做也没用的建议**。
 */
export function shellCanOpenExactAlarmSettings(): boolean {
  const s = shell()
  return typeof s?.openExactAlarmSettings === 'function'
}

/**
 * 跳到系统那一页（Android 12+ 的「闹钟与提醒 / 作息时间」），让老师把精确闹钟开给本应用。
 *
 * @returns `true` = 真的跳过去了（失败不谎称成功 —— 跳不过去时原生自己退到应用详情页，
 *          那里也有同一个开关）；`false` = 这个壳没有这条路
 */
export async function openExactAlarmSettings(): Promise<boolean> {
  const s = shell()
  if (typeof s?.openExactAlarmSettings !== 'function') return false
  try {
    return (await s.openExactAlarmSettings()) === true
  } catch {
    return false
  }
}

/** 这个壳能不能排**精确**闹钟（Android 12+ 要在设置里开）—— 没这条路的壳回 `null`（**不知道**，不是"不能"） */
export async function canScheduleExactNative(): Promise<boolean | null> {
  const s = shell()
  if (typeof s?.canScheduleExact !== 'function') return null
  try {
    const v = await s.canScheduleExact()
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

/**
 * 🩺 **跑一遍通知自检**（"给我发一条测试通知"那个入口的底座；只有 apk 有）。
 *
 * 🔴 为什么非有不可：用户连着两轮报「收不到通知」，而**本机没有安卓设备** ——
 *   静态判据能钉住源码形状，钉不住"这台手机上到底哪一环断了"。
 *   这个函数把四个断点**分开**报出来（系统关着 / 13+ 权限 / 渠道没建 / 真发出去了），
 *   老师点一下就知道该去开哪一格（`AGENTS.md` §三.5：不可写的路径要显式报错，
 *   而且要给一条真能走的出路）。
 *
 * ⚠️ 三态不许混（§三.4）：
 *   · `{unsupported:true}` = 这一版壳还没有这个检查（网页版与两个 exe 恒是这一档）；
 *   · `{why:…}`            = 自检**跑过**、但某一步没通（或读不出来）；
 *   · `{posted:true}`      = 测试那条真的交给系统了。
 *   **不许**把"没跑起来"说成"发出去了"。
 */
export async function runNotifySelfTest(): Promise<ShellSelfTest> {
  const s = shell()
  if (typeof s?.selfTest !== 'function') return { unsupported: true }
  try {
    const r = await s.selfTest()
    return r && typeof r === 'object' ? r : { why: '自检没返回结果。' }
  } catch {
    return { why: '自检没跑起来。' }
  }
}

/**
 * 把自检那四格读数翻成**老师能照做的一句话**（纯函数 ⇒ 判据能直接跑它，§三.2）。
 *
 * 🔴 每一格对应一个**不同的**动作，所以**不许**合成一句"通知有问题"：
 *   · `notify=false`  → 去系统里把这个应用的通知打开（渠道、权限都对了也没用）
 *   · `granted=false` → 13+ 还没允许发通知
 *   · `channel=false` → **渠道没建起来**（这一格存在本身就是"通知会被静默丢掉"的判据）
 *   · `posted=true`   → 让老师去通知栏找那一条
 *   · `unsupported`   → 这一版壳还没有这个检查（**如实说**，不许假装检查过了）
 *
 * `tone` 跟着走：`ok` 只有"真的发出去了"那一档配得上。
 */
export function selfTestHint(r: ShellSelfTest): { text: string; desc: string; tone: 'ok' | 'warn' } {
  if (r.unsupported) return { text: '这个版本还不能自检', desc: '装上最新版再试。', tone: 'warn' }
  if (r.posted === true) return { text: '已发出一条测试通知', desc: '去手机的通知栏找「测试通知」。', tone: 'ok' }
  if (r.notify === false) return { text: '系统里通知是关着的', desc: '去系统设置把本应用的通知打开。', tone: 'warn' }
  if (r.granted === false) return { text: '还没允许本应用发通知', desc: '去系统设置允许本应用发通知。', tone: 'warn' }
  if (r.channel === false) return { text: '通知渠道没建起来', desc: '这一条要装新版本才能修。', tone: 'warn' }
  return { text: '没发出去', desc: r.why || '过一会儿再试一次。', tone: 'warn' }
}

/**
 * 🩺🩺 **排一条"两分钟后响"的定时提醒**（"两分钟后试一条定时提醒"那个入口的底座；只有 apk 有）。
 *
 * 🔴🔴 **它必须走真实排程那条链**（`ShugaoNative.remindSelfTest` →
 *   `YlxbAlarms.registerPrepared` 的 `setExactAndAllowWhileIdle` → `YlxbAlarmReceiver`
 *   → `NotificationManager`），**不许**图省事去调即时通知（`shell().notify`）——
 *   后者只能证明"能发通知"（老师已经验通了），**证明不了到点会响**，
 *   那就是一次**假绿**（`AGENTS.md` §三.1）。
 *
 * ⚠️ 三态不许混（§三.4）：`{unsupported:true}` = 这一版壳还没有这个检查；
 *   `{scheduled:false, stage:'…'}` = 跑过、断在某一环（`stage` 说得出是哪一环）；
 *   `{scheduled:true}` = 真交给系统了（**到没到**还要 `runRemindSelfCheck()` 回读）。
 */
export async function runRemindSelfTest(): Promise<ShellRemindCheck> {
  const s = shell()
  if (typeof s?.remindSelfTest !== 'function') return { unsupported: true }
  try {
    const r = await s.remindSelfTest()
    return r && typeof r === 'object' ? r : { scheduled: false, stage: 'schedule', why: '自检没返回结果。' }
  } catch {
    return { scheduled: false, stage: 'schedule', why: '自检没跑起来。' }
  }
}

/**
 * 🩺 **回读**那条自检到点了没有（"两分钟后试一条"的第二步）。
 *
 * `{unsupported:true}` = 这一版壳还没有这个检查；`{fired:false, elapsed:true}` =
 * 过了点接收器没跑到（断在接收器那一环）；`{fired:false, elapsed:false}` = **还没到点**（灰）。
 */
export async function runRemindSelfCheck(): Promise<ShellRemindFired> {
  const s = shell()
  if (typeof s?.remindSelfCheck !== 'function') return { unsupported: true }
  try {
    const r = await s.remindSelfCheck()
    return r && typeof r === 'object' ? r : { fired: false, elapsed: false }
  } catch {
    return { fired: false, elapsed: false }
  }
}

/**
 * 把"两分钟后试一条"的读数翻成**老师能照做的一句话**（纯函数 ⇒ 判据能直接跑它，§三.2）。
 *
 * 🔴 分档按**断在哪一环**（每一环对应一个**不同的**动作），**不许**合成一句"定时提醒不通"：
 *   · `unsupported`       → 这一版应用还没有这个检查（**如实说**，不许假装检查过了）
 *   · `notify=false`      → 去系统里把这个应用的通知打开
 *   · `granted=false`     → 13+ 还没允许发通知
 *   · `channel=false`     → **渠道没建起来**（Android 8+ 往不存在的渠道发 = 静默丢掉）
 *   · `schedule` 断       → 系统闹钟没排上（把这句 `why` 原样给老师，它说的是真因）
 *   · `scheduled=true`    → 已排上，告诉他"两分钟后会响"（**还没响**，别写成已经响了）
 *
 * @param check `runRemindSelfTest()` 的读数
 * @param sdk   安卓 API 级别（不给 = 不知道 ⇒ 不说那句只对 13+ 成立的话）
 */
export function remindCheckHint(
  check: ShellRemindCheck,
  sdk?: number,
): { text: string; desc: string; tone: 'ok' | 'warn' } {
  if (check.unsupported) {
    return { text: '这个版本还不能定时自检', desc: '装上最新版再试。', tone: 'warn' }
  }
  if (check.notify === false) {
    return { text: '系统里通知是关着的', desc: '去系统设置把本应用的通知打开，再点一次。', tone: 'warn' }
  }
  if (check.granted === false) {
    return { text: '还没允许本应用发通知', desc: '去系统设置允许本应用发通知，再点一次。', tone: 'warn' }
  }
  if (check.channel === false) {
    return { text: '通知渠道没建起来', desc: '这一条要装新版本才能修。', tone: 'warn' }
  }
  /*
   * 🔴 **渠道被单独关掉**这一档（`areNotificationsEnabled()` 管不到它）：
   *   老师两秒就能自己开 —— 所以给的是**可操作的一步**，不是"就是没响"。
   */
  if (check.channelOn === false) {
    return {
      text: '「到点提醒」被关掉了',
      desc: '去系统的应用通知设置里把「到点提醒」那个开关打开，再点一次。',
      tone: 'warn',
    }
  }
  if (check.scheduled === false) {
    // 把原生当场回的中间结果也说出来（"排了几条 / 单子里几条 / 精确闹钟给没给"）
    const detail =
      check.innerScheduled !== undefined && check.innerScheduled >= 0
        ? `系统只收下 ${check.innerScheduled} 条（单子里 ${check.innerRequested ?? 0} 条）。`
        : ''
    return {
      text: '定时提醒没排上',
      desc: `${check.why || '系统闹钟这一步没过去。'}${detail}`,
      tone: 'warn',
    }
  }
  /*
   * ⚠️ 到这里是"**排上了**"——不是"响了"。文案必须写成**将要发生**的事，
   *   写"已发出"就是把"排上"说成"响了"（§三.4：不许把"没结论"说成结论）。
   * 🔴 中间结果一律报出来（用户要求）：真的排上了几条 · 精确闹钟读数是几。
   */
  const inner =
    check.innerScheduled !== undefined && check.innerScheduled >= 0
      ? `已排上 ${check.innerScheduled} 条 · 精确闹钟${check.innerExact ? '已允许' : '没允许'}`
      : ''
  /*
   * ⚠️ "可以停在这一页等" 只对 **Android 12+（API 31+）** 说：自检那条带了
   *   `selfCheck` 标记、会绕过接收器的前台早退；而**真实提醒不会**（前台由即时那条路负责）。
   *   量不到 sdk（`undefined`）⇒ 不说这句（§三.4：没结论是灰）。
   */
  return {
    text: '两分钟后会响一条定时提醒',
    desc: [
      inner,
      sdk !== undefined && sdk >= 31 ? '可以先把这个应用切到后台，也可以就停在这一页等。' : '可以先把这个应用切到后台。',
      check.exact === false ? '还没允许「闹钟和提醒」，可能会晚一点响。' : '',
    ]
      .filter(Boolean)
      .join(' '),
    tone: 'ok',
  }
}

/**
 * 那条自检**到没到**翻成一句人话（纯函数；只有 apk 会走到）。
 *
 * 🔴 三态（§三.4）—— 把"还没到点"与"过了点没到"分开，是这一条的全部意义：
 *   · `unsupported`                    → 这一版应用还没有这个检查
 *   · `fired=true`                     → **整条链通了**（权限 → 渠道 → 排程 → 接收器 → 通知）
 *   · `fired=false` + `elapsed=false`  → **还没到点**（灰：再等等，别说坏了）
 *   · `fired=false` + `elapsed=true`   → 过了点还没到 ⇒ **断在接收器那一环**（说得出是哪一环）
 */
export function remindFiredHint(fired: ShellRemindFired): {
  text: string
  desc: string
  tone: 'ok' | 'warn'
} {
  if (fired.unsupported) {
    return { text: '这个版本还不能定时自检', desc: '装上最新版再试。', tone: 'warn' }
  }
  /*
   * 🔴 **"有没有到点的提醒被丢掉"这一句要跟着每条出路一起说**（2026-10-06 补）。
   *
   * 为什么不能只在"没响"那一支说：老师说"提醒没响"时，最坏的一档恰恰是
   * **自检这条链看着全通、而真提醒在另一条路上被丢光了**（自检豁免了容忍窗，
   * 真提醒没有）⇒ 只在失败支说这句，就会把这一档漏掉。
   */
  const dropNote = dropNoteOf(fired)
  if (fired.fired === true) {
    return {
      text: '定时提醒这条链是通的',
      desc:
        `刚才那条就是走系统闹钟到点的。渠道 ${fired.channel || '未知'}，通知号 ${fired.notifyId ?? -1}。关掉应用也会响。` +
        dropNote,
      tone: 'ok',
    }
  }
  if (fired.elapsed === true) {
    /*
     * 🔴 断在接收器这一环时，把**能读到的都读出来**（用户要求"屏上报哪几个数"）：
     *   有没有抛错 / 渠道读到什么 / 通知号是多少 —— 空着的那一格就是断点。
     */
    const parts = [
      `该响 ${fired.due ? new Date(fired.due).toLocaleTimeString('zh-CN') : '未知'}`,
      `接收器读到 ${fired.fired ? '到了' : '没到'}`,
      `渠道 ${fired.channel || '（空）'}`,
      `通知号 ${fired.notifyId ?? -1}`,
    ]
    if (fired.receiverError) parts.push(`报错 ${fired.receiverError}`)
    return {
      text: '到点了但没响',
      desc: `${parts.join(' · ')}。${dropNote}`,
      tone: 'warn',
    }
  }
  return { text: '还没到点', desc: `再等一会儿，别关掉通知栏。${dropNote}`, tone: 'warn' }
}

/**
 * 🔴 **"有几条到点的提醒被丢了"那句人话**（纯函数，判据能直接跑它，§三.2；2026-10-06 补）。
 *
 * 为什么单拎出来：它要挂在**每一条出路**上（通了 / 没响 / 还没到点）——
 *   最坏的一档正是"自检那条链看着全通，而**真提醒**在另一条路上被丢光了"
 *   （自检豁免了容忍窗，真提醒没有）⇒ 只在失败支说这句就会漏掉这一档。
 *
 * 三态（§三.4）：
 *   · `dropCount > 0` ⇒ 说出**丢了几条 + 最后一次晚了多久**（附一句"这是历史累计"，
 *     免得老师把它当成"刚才那一条"）；
 *   · `dropCount === 0` / 读不到 ⇒ **一个字都不说**（不是"没丢过"，是"这一格没有读数"
 *     —— 见 `ShellRemindFired.dropCount` 的注释；拿它说"一切正常"就是编）。
 *
 * @returns 拼在后面的一句话（前面自带空格；没有可说的就回空串）
 */
export function dropNoteOf(fired: ShellRemindFired): string {
  const n = typeof fired.dropCount === 'number' ? fired.dropCount : 0
  if (n <= 0) return ''
  const late = typeof fired.dropLateMs === 'number' && fired.dropLateMs > 0
    ? `，最后一次晚了 ${Math.round(fired.dropLateMs / 60_000)} 分钟`
    : ''
  return ` 另外：有 ${n} 条到点的提醒因为系统把它们推迟得太久（超过 10 分钟）被丢掉了${late}。`
}

/**
 * 🩺 **安卓 API 级别**（`Build.VERSION.SDK_INT`；只有 apk 有）。
 *
 * @returns `0` = **量不出来**（网页版 / 两个 exe / 老壳 / 读失败）
 *          —— 调用方**不许**照它分档（§三.4：没结论是灰，不许拿"不知道"当"是"）。
 */
export async function readSdkVersion(): Promise<number> {
  const s = shell()
  if (typeof s?.sdkVersion !== 'function') return 0
  try {
    const v = await s.sdkVersion()
    return typeof v === 'number' && v > 0 ? v : 0
  } catch {
    return 0
  }
}

/**
 * 🩺 **等那条自检到点，然后把"到没到"回报给界面**（"两分钟后试一条"的第二步的驱动）。
 *
 * 🔴 为什么不做成"睡两分钟再问一次"：那条自检**正好在两分钟后**响，
 *   一次定时问下去必然问在一次**没有信息的时刻**上（早了=还没到，晚了=没意义）。
 *   ⇒ 按固定间隔**回读**，一旦"过了点"( `elapsed` ) 或"真的到了"( `fired` ) 就收工。
 *   这**不是**页内定时器兜底那一条：它**不发任何通知**，只读原生那一笔账
 *   （到点响不响由系统闹钟与 `YlxbAlarmReceiver` 决定，与页面在不在前台无关）。
 *
 * ⚠️ `unsupported`（老壳没有 `remindSelfCheck`）⇒ **立刻收工**，一个字都不猜。
 * @param onResult 每次读到结果都回调一次（界面**就地**把"还没到点 / 通了 / 没响"说出去）
 * @returns 一个"取消"函数（组件卸载时调，避免报到一次已经卸载的组件上）
 */
export function watchRemindSelfCheck(
  onResult: (r: ShellRemindFired) => void,
  intervalMs = 20_000,
  maxRounds = 12,
): () => void {
  let stopped = false
  let rounds = 0
  let timer: number | undefined
  const stop = () => {
    stopped = true
    if (timer !== undefined) window.clearTimeout(timer)
  }
  const step = async () => {
    if (stopped) return
    rounds += 1
    const r = await runRemindSelfCheck()
    if (stopped) return
    // 老壳没有这个口 ⇒ 立刻收工（**不许**猜"到了"或"没到"）
    if (r.unsupported) {
      stop()
      return
    }
    /*
     * ⚠️ **只有"到了"或"过了点还没到"才回报**：`fired:false && elapsed:false` 是
     *   "还没到点"，把这一档也推出去等于每 20 秒刷老师一条"还没到点"
     *   —— 那不是信息，是噪音（与 `remindFiredHint()` 的三态分档是同一件事）。
     */
    if (r.fired === true || r.elapsed === true || rounds >= maxRounds) {
      onResult(r)
      stop()
      return
    }
    timer = window.setTimeout(() => void step(), intervalMs)
  }
  void step()
  return stop
}

/**
 * 网页那一支的"到点"路径 —— 逐字保留原来的行为。
 *
 * ⚠️ 上面新增的三个导出**都不碰它**：`window.__shell_out` 不存在 ⇒
 *    `scheduleNativeReminders()` 恒 `false`（不会多排一条闹钟），这条路一字不变。
 */

/**
 * 🔴 `platform` 已经搬到 `lib/classroomShell.ts` 的 `shellPlatform()`（2026-10-04）。
 *
 * 搬的理由：它是**壳身份**，不是通知的事 —— 留在这儿会让 `Settings` / `changelog`
 * 为了判断"这是哪一端"去 import 通知模块，而它们跟通知毫无关系。
 * ⚠️ 顺带把这个接口里的 `platform?` 字段**删掉**了（通知这一层不读它，
 *    留着就是"声明了没人用"—— 本项目刚为这个模式栽过四次）。
 * ⚠️ `Schedule.tsx` 的 import 跟着改到 `classroomShell`，**没有留 re-export**：
 *    留一个转发会让下一个人继续从错误的模块拿这个能力。
 *
 * @returns 见 `classroomShell.shellPlatform()`。
 */

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
/* ============================================================
   🆕 推送链路的应用侧包装（2026-10-02）—— 首启引导与前台服务。
   只有 apk 的壳会真的动；exe / 网页版方法不存在 ⇒ 如实回 false/null，
   调用方直接跳过（§三.5：没这条路就别说这条路的话）。
   ============================================================ */

/**
 * 这个壳有没有整条推送链（startPush + pushStatus 都在）—— 首启引导的总闸。
 *
 * ⚠️ **故意不把 `ensurePushRunning` 也算进来**（2026-10-06 想过、否了）：
 *   它是"每次回前台确保通道在跑"那一支，**与首启引导无关**；
 *   把它算进这个总闸，会让"装了还带这一支的旧壳"（没有它）连首启引导都跑不了
 *   —— 那是**用一个可选的补丁去挡掉一条本来能用的链**。
 *   ⇒ 它自己那一支**单独问能力**（`shellEnsurePushRunning()` 里那句
 *   `typeof s?.ensurePushRunning !== 'function'` ⇒ 老壳如实跳过，一个字不做）。
 */
export function shellHasPushFlow(): boolean {
  const s = shell()
  return typeof s?.startPush === 'function' && typeof s?.pushStatus === 'function'
}

/** Android 13+ 的通知授权弹窗（真弹）。12- 及以下系统默认已有 ⇒ 也会回 granted */
export async function shellRequestNotifyPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  const s = shell()
  if (typeof s?.requestNotifyPermission !== 'function') return 'unsupported'
  try {
    const r = await s.requestNotifyPermission()
    return r === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

export type ShellPushStatus = { notify?: boolean; exact?: boolean; battery?: boolean }

/** 三格读数（通知总开关 / 精确闹钟 / 电池白名单）。读不到 = null（**不知道**，不许猜） */
export async function shellPushStatus(): Promise<ShellPushStatus | null> {
  const s = shell()
  if (typeof s?.pushStatus !== 'function') return null
  try {
    const r = await s.pushStatus()
    return r && typeof r === 'object' ? (r as ShellPushStatus) : null
  } catch {
    return null
  }
}

/** 电池优化白名单（系统弹窗）。`false` = 这个壳没有这条路 / 跳转失败（如实） */
export async function shellRequestIgnoreBattery(): Promise<boolean> {
  const s = shell()
  if (typeof s?.requestIgnoreBattery !== 'function') return false
  try {
    const r = await s.requestIgnoreBattery()
    return !!(r && r.ok)
  } catch {
    return false
  }
}

/**
 * 🆕 **跳到厂商「自启动 / 后台运行」页**（2026-10-06 加；只有 apk 有）。
 *
 * 与 `shellRequestIgnoreBattery()` 是**两个开关**（国产 ROM 上分开管），
 * 所以两条都要走一遍。返回的是**原生逐档回退的读数**（不是一句"成功/失败"）：
 *   · `via`   —— 真的跳到了哪一页（最后一档 `应用详情页` 也**算跳成功**，
 *                只是要多点两下；界面照实说，别把它写成"已打开自启动页"）；
 *   · `tried` —— 依次试过哪几档（跳不动时用来定位是哪台机器/哪个 ROM 的事）；
 *   · `ok:false` —— **一档都没跳成**（连详情页都打不开）⇒ 调用方必须给一句人话出路。
 *
 * ⚠️ 老壳没有这一支 ⇒ 回 `{ok:false, unsupported:true}`，调用方**一个字都不做**
 *   （§三.4：没这条路就别说这条路的话）。
 */
export async function shellRequestAutoStart(): Promise<{
  ok: boolean
  via?: string
  tried?: string[]
  why?: string
  unsupported?: boolean
}> {
  const s = shell()
  if (typeof s?.openAutoStartSettings !== 'function') return { ok: false, unsupported: true }
  try {
    const r = await s.openAutoStartSettings()
    if (r && typeof r === 'object') return r
    return { ok: false, why: '壳那边回的不是对象（桥接层多半被截断了）。' }
  } catch (e) {
    return { ok: false, why: `调用壳失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 启动推送拉取前台服务。`false` = 没这条路 / 起失败（调用方要给页内兜底） */
/**
 * 启动推送拉取前台服务。
 *
 * 🔴 2026-10-05 真机第四轮补：`endpoint` 现在**必须去掉末尾斜杠**。
 *   `apiUrl('')` 返回的是 `https://站点/`（末尾带 `/`，那是它给 `'/api/…'` 拼的），
 *   而原生那边拼的是 `endpoint + "/api/push"` ⇒ 变成 `//api/push`。
 *   实测（线上）：`POST /api/push` → **401**（路由在，只是没带 token）；
 *   `POST //api/push` → **405**（命中另一个资源）。
 *   ⇒ 那道横幅上写「前台服务没起来」，而真因是路径多了一个斜杠。
 *   这里 trim 掉，比让每处调用方自己记得干净更可靠。
 *
 * ⚠️ 🔴 `why` 一路带到屏上：桥接那层 `.catch()` 与"插件不存在"两支都只回 `{ok:false}`，
 *   把原生带回的真因吃掉了 ⇒ 屏上只能显示兜底那句「前台服务没起来」。
 *   所以下面每一条回不回 `why` 都要说清楚为什么（§五「失败了会有人知道吗」）。
 */
export async function shellStartPush(
  endpoint: string,
  accessToken: string,
): Promise<{ ok: boolean; why?: string }> {
  const s = shell()
  if (typeof s?.startPush !== 'function') return { ok: false, why: '这个壳没有推送链。' }
  // 去掉末尾斜杠（**唯一那一处在 `trimBase`**：原生那边自己会拼 `/api/…`）
  const base = trimBase(endpoint)
  try {
    const r = await s.startPush({ endpoint: base, accessToken })
    if (r && typeof r === 'object') {
      // `why` 是空串时补一句能定位的（空串在界面上等于"没原因"）
      return r.ok ? r : { ...r, why: r.why?.trim() || '壳那边没回失败原因（看 logcat 的 ShugaoNative）。' }
    }
    return { ok: false, why: '壳那边回的不是对象（桥接层多半被截断了）。' }
  } catch (e) {
    // 🔴 这一支原来只回 '启动失败。' —— 把真因吃掉，屏上只剩一句废话
    return { ok: false, why: `调用壳失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 登出时停掉前台服务（停失败不抛 —— 登出路径不该被它挡住） */
export async function shellStopPush(): Promise<void> {
  const s = shell()
  if (typeof s?.stopPush !== 'function') return
  try {
    await s.stopPush()
  } catch {
    /* 忽略 */
  }
}

/**
 * 🔴🆕 **每次打开应用 / 回到前台：确保通知通道在跑**（2026-10-06 补）。
 *
 * 与 `shellStartPush()` 的分工**必须分清楚**（合起来就是一个真值源被拆成两半）：
 *   · `shellStartPush()` —— **登记钥匙**（要网络 + access token）**并且**起服务，首启引导用；
 *   · 这一个 —— **不登记**，只看"钥匙在不在"，在就把前台服务拉起来。
 *
 * 🔴 为什么非有不可（用户真机 vc53 + 当场核过的那句话）：
 *   用户说「**通知我在不开应用后台的情况下是收不到**同一账号在电脑上发送的通知的」，
 *   随后确认**通知栏里根本没有那条常驻通知** ⇒ 前台服务**从来没起过**（Android 硬要求：
 *   前台服务必有常驻通知）。而原来它只有两个启动点，两个都靠不住：
 *     ① 首启引导第 ④ 步 —— 整条流水线被 `localStorage` 里一个布尔跳过（覆盖安装会带过来），
 *        而且它**先要 register 那张网成功才起服务** ⇒ 一次网络失败 = 服务不起；
 *     ② `YlxbBootReceiver` —— 只有**真重启**才跑。
 *   ⇒ 这一支补的就是"**应用开着的时候把它拉起来**"这个缺口（此刻在前台，
 *     不受 Android 12+ "不许从后台起前台服务"那条限制）。
 *
 * @returns `running:true` = 钥匙在、系统收下了这次启动（**不等于**那条常驻通知已经出现
 *          —— 那一格只有老师自己看通知栏才算数）；`ok:false` 时 `why` 一定有话说
 */
export async function shellEnsurePushRunning(
  endpoint: string,
): Promise<{ ok: boolean; running?: boolean; already?: boolean; started?: boolean; why?: string }> {
  const s = shell()
  if (typeof s?.ensurePushRunning !== 'function') {
    return { ok: false, running: false, why: '这个壳还没有这一支（装最新版）。' }
  }
  // 与 `shellStartPush` 共用同一个 trim（见 `trimBase`：全模块唯一一处）
  const base = trimBase(endpoint)
  try {
    const r = await s.ensurePushRunning({ endpoint: base })
    if (r && typeof r === 'object') return r
    return { ok: false, running: false, why: '壳那边回的不是对象（桥接层多半被截断了）。' }
  } catch (e) {
    return { ok: false, running: false, why: `调用壳失败：${e instanceof Error ? e.message : String(e)}` }
  }
}
