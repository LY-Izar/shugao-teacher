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
   * ⚠️ 这里**故意没有** `platform` 字段：通知这一层不读它。
   * 读它的是 `lib/classroomShell.ts` 的 `shellPlatform()` ——
   * 留一份在两处正是"声明了没人用"（本项目为此栽过四次）。
   */
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
        channel: 'shugao_general',
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