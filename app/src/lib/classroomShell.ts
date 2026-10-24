import type { Band } from './grading'

/**
 * 「教室端 exe 只让教室端账号登录」—— 壳级约束（2026-10-03）。
 *
 * ============================================================================
 * 为什么要做
 * ============================================================================
 * 教室端是挂在教室里给学生看的那块屏，但它加载的是**和教师端同一份网页产物**
 * （两个 `release/<端>/win-unpacked/resources/app` 是同一个 dist）。于是：
 *
 *   在教室端那台机器上，用**教师账号**登录 → `accountKind` 是 'teacher' →
 *   `App.tsx:90` 那条 `Navigate to="/classroom"` 不成立 → **直接落在教师控制台上**。
 *
 * 而教室端那块屏是**学生面前**的：能看全班成绩、能改数据。
 * 更糟的是这台机器往往是共用的，谁都能登。
 *
 * ---------------------------------------------------------------------------
 * 📌 与数据库那道隔离的分工（**2026-10-04 核实并改正** —— 这里原来是错的）
 * ---------------------------------------------------------------------------
 * 🔴 **本文件头的旧版写着「真正的隔离那条策略至今没有钉死，单独立项」—— 那是过期信息。**
 *    实测（2026-10-04）：**RLS 那一道早就钉死了**，而且是能红的：
 *      · `npm run rls-checks` → **961 条全绿**
 *      · 负向对照 `RLS_NEGATIVE=crack-a`（把 2026-09-25 那次收紧改回去）→ **4 条变红，exit=1**
 *    时间线：`schema.sql` §17.1 / §16.3 / §17.6 三次收紧（2026-09-25 A/B、2026-09-27 C），
 *    共 13 条 `*_not_classroom` / `classroom_admin_only` 策略，
 *    判据是 `is_classroom_account()`（`schema.sql` §10.5 唯一定义）。
 *
 * ⚠️ **那条过期注释曾经害过人**：2026-10-04 有 AI 照抄它，对用户汇报
 *    「RLS 至今没钉死、仍是单独立项」—— **是假的**。
 *    → 本条留着当教训：**注释里凡是写着"还没做/单独立项"，引用前先跑一次对应门禁核。**
 *
 * **所以两道的关系是**：
 *   · 数据库 RLS = **安全边界**（改不动成绩/名单，绕不过去）
 *   · 本文件 = **客户端拦截** = 减少误用与顺手点错，**不是**安全边界
 *     （改一下 JS 或 localStorage 就能绕过去）
 * 锁了之后权限仍以数据库为准（AGENTS.md 硬规矩：前端只决定"摆不摆入口"）。
 *
 * ============================================================================
 * 判据是哪一个
 * ============================================================================
 * `remote.loadClassroomAccount()` —— 「`classroom_accounts` 里有没有 id = 自己
 * uid 的那一行」。**不用** `teachers` 表判断：`handle_new_user` 触发器会给每一个
 * auth 用户（含教室端账号）建一行 `teachers`，区分不了。
 *
 * ============================================================================
 * ⚠️ 已知的两个坑（都在这儿钉住，免得下一个人重踩）
 * ============================================================================
 * ① `window.__shell_out` 在**网页版里压根不存在** → 取到 undefined → `shellRole()`
 *    返回 'unknown' → 全部逻辑落回"不锁"。这是刻意的：网站同一份代码必须照常给
 *    教师用。（AGENTS.md：网页行为逐字不变。）
 * ② 「我是哪个端」**只能**靠 preload 的 `webPreferences.additionalArguments` 送进来。
 *    主进程命令行上的自定义参数**不会**转发到渲染进程 —— 我第一版就是那么写的，
 *    结果 `appRole` 恒为 `'undefined'`、整套判断静默失效。详见
 *    `_src/desktop/preload.js` 顶部那段说明。
 */

/** 网页版返回 'unknown' —— 那是"不在壳里"，不是"出错了"。 */
export type ShellRole = 'classroom' | 'teacher' | 'unknown'

interface ShellBridge {
  appRole?: string
  /**
   * 哪一端的壳（`'electron'` | `'capacitor'`）—— 网页版没有这个字段。
   *
   * 🔴 **为什么它这么晚才补**（2026-10-04 扫「exe 与 apk 文案有没有分开」时发现）：
   *   exe 的 `_src/desktop/preload.js` **一直带着** `platform: 'electron'`，
   *   而 apk 的 `_src/shell-bridge-apk.js` **原来没有** ⇒ 页面眼里
   *   **apk 和教师端 exe 逐字同值**（都是 `appRole:'teacher'`、都没有 platform）
   *   ⇒ **没法按端分支文案**，于是像「这条要走**手机的**系统设置」在教师端 exe 上
   *     原样显示（Windows 上弹"手机"）、「桌面版自带备份文件夹」在 apk 上照显。
   *
   * ⚠️ **补 `platform` 之前打的那些老 apk 会回 `null`** ⇒ 按**网页**那一支走文案。
   *   这是刻意的：那个降级路径说的是"这台设备"这类中性话，不会说出假话。
   */
  platform?: string
  /**
   * 🆕 壳里**已经免掉了自动播放限制**（2026-10-04 加）—— 见 `shellAutoplayAllowed()`。
   * ⚠️ 只认 `=== true`：老壳没有这个字段 ⇒ 按"没免"处理（多留一步点击，不会说出假话）。
   */
  autoplayAllowed?: boolean
  /**
   * 🆕 壳**自己声明**开不了 Document PiP（2026-10-04 加）—— 见 `shellDocumentPipUnavailable()`。
   * ⚠️ 只认 `=== false`（显式声明）；`undefined`（老壳 / 网页版）⇒ 不推翻原判断。
   */
  documentPip?: boolean
  /**
   * 🆕 壳**自带的原生置顶小窗**（2026-10-04 加）—— 见 `shellPipAvailable()`。
   * 🔴 **只有教室端 exe 有**（施工单 §二.1：教师端不摆这个入口）⇒ 教师端 exe /
   *    网页版 / 老壳读到的都是 `undefined`。
   */
  pip?: ShellPipBridge
  /**
   * 🆕 P0b（插件化）—— 插件框架要的那一组新能力（`downloadPlugin` / `openTransparentWindow` /
   *    `closeTransparentWindow` / `onFloatingClosed` / `pushBlockScreen` / `closeAllFloating`），
   *    语义见本文件底部那一大段约定。
   *    ⚠️ 老壳没有这个字段 ⇒ 一律按"没有"处理，网页版行为逐字不变。
   */
  plugins?: ShellPluginBridge
}

/**
 * 壳侧那个原生置顶小窗的四个口（`preload.js` 的 `__shell_out.pip`，2026-10-04 加）。
 *
 * 🔴 为什么第 ④ 条要新开一条路而不是修 Document PiP：实测（教室端 exe ·
 *    Electron 33 / Chromium 130）`typeof documentPictureInPicture === 'object'`
 *    ——**API 对象在**，可真手势与 CDP `userGesture:true` 两条路调 `requestWindow()`
 *    **都抛** `InvalidStateError: … Internal error: no window`
 *    ⇒ **Electron 没实现"创建那个 PiP 窗口"那一层**（那是 Chrome 浏览器层做的）。
 *    ⇒ 两个 exe 改走壳自己那个 `BrowserWindow({ alwaysOnTop: true })`；
 *      **网页版照旧走 Document PiP**（那条路在浏览器里是真的能用）。
 */
interface ShellPipBridge {
  /** 开小窗（壳侧保证**单例**：已经有就复用/聚焦）。回 `{ok:true, reused}` / `{ok:false, why}` */
  open(payload?: ShellPipData): Promise<unknown>
  /** 推一屏数据（one-way）—— 壳照着画，**不做任何计算** */
  data(payload: ShellPipData): void
  /** 关小窗（主进程 `win.close()`）⇒ 壳会回一个 `shell:pipClosed` */
  close(): void
  /** 小窗被关掉时回调（网页据此复位）；返回注销函数 */
  onPipClosed(cb: () => void): unknown
}

/**
 * 题号条上的一格 —— **与网页版 `PipPanel` 的 `all[i]`（`gradeStats().questions[i]`）同源**。
 * 🔴 一题一格：题号 + 这一题自己的正确率 + 分档（分档决定小窗里那个颜色 = 讲评优先级）。
 * ⚠️ `bandLabel` 也由网页推：档名文案在 `BAND_META` 里**只有一份**，壳里不再抄一遍
 *    （抄一份就是"改了这边忘了那边"）。
 */
export interface ShellPipQuestion {
  /** 题号（1 起） */
  seq: number
  /** 这一题的正确率，**0–100 的整数**（网页已经乘好了） */
  ratePct: number
  /** 分档（`BAND_META` 的键）—— 小窗按它给这一格着色 */
  band: Band
  /** 档名文案（`BAND_META[band].label`）—— 与网页那一份逐字相同 */
  bandLabel: string
  /**
   * 这一题答错的人（**与网页版 `PipPanel` 的 `wrongNos` 同源**，`name` 由网页用 `nameOf` 解好）。
   * ⚠️ 姓名不在壳里查：壳拿不到学生名单，也不该去查。
   */
  wrong: Array<{ no: string; name: string }>
}

/**
 * 推给小窗的那一屏数据（**语义一个字段一种**）。
 * 🔴 **全部由网页算好**：壳只把它们填进 HTML —— 题号/正确率这种业务量绝不在壳里再算一遍
 *    （施工单 §二.3：一个字段一种语义；算两遍就一定有分家的那一天）。
 *
 * 🆕 2026-10-05（施工单 §一「与网页里那个小窗**同一份信息**」）：原来只有那五个字段，
 *    壳小窗因此丢了网页版 `PipPanel` 的三样东西 —— **题号条**（全部题号 + 各自正确率 + 分档着色）、
 *    **点题号展开的错误名单**、**◀ ▶ 翻页**。⇒ 补一个 `questions`：题号条的每一格，
 *    顺带把每一题的名单一起带过去（小窗没有回话的口子，翻到哪一题就得有哪一题的数据）。
 */
export interface ShellPipData {
  /** 班级名 */
  className: string
  /** 当前题号（1 起）；**没有可讲评的作业时给 0** */
  seq: number
  /** 这份作业的总题数；**0 = 还没有可讲评的作业**（壳据此显示那句空态，不留纯白空窗） */
  total: number
  /** 当前题的正确率，**0–100 的整数**（网页已经乘好了：壳里少一步换算，就少一处会分家的地方） */
  ratePct: number
  /** 未交人数 */
  missing: number
  /**
   * 题号条：**全部题目**，下标 = 题号 − 1（与 `PipPanel` 的 `all` 同一个顺序）。
   * ⚠️ 只有这里没有当前题那一格时，壳才拿上面那个 `ratePct` 兜底（免得那一行空着）。
   */
  questions: ShellPipQuestion[]
}

function bridge(): ShellBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __shell_out?: ShellBridge }
  return w.__shell_out ?? null
}

/**
 * 现在跑在哪个壳里。
 *
 * 🔴 网页版、以及任何比这个 `appRole` 更老的壳（没传 additionalArguments 的）
 *    都会返回 `'unknown'` —— 一律按"不锁"处理。宁可漏锁，不要把教师端网页版锁死。
 */
export function shellRole(): ShellRole {
  const r = bridge()?.appRole
  return r === 'classroom' || r === 'teacher' ? r : 'unknown'
}

/** 现在是不是教室端那个 exe */
export function isClassroomShell(): boolean {
  return shellRole() === 'classroom'
}

/** 见 `shellPlatform()`。 */
export type ShellPlatform = 'electron' | 'capacitor' | null

/**
 * 现在跑在**哪种壳**里 —— 文案按端分支的**唯一信号**（2026-10-04 加）。
 *
 * · `'electron'` → 两个 exe（教室端 / 教师端）
 * · `'capacitor'` → 教师端 apk
 * · `null`        → **网页版**，**以及补 `platform` 之前打的老 apk**（见上面字段的注释）
 *
 * 🔴 **判据必须是"认得这两个字面量"，不是"有没有 platform 这个字段"**：
 *   未知的第三个值（以后加了别的壳）会落进 `null` = 走网页那一支的中性文案，
 *   而不是猜一个端出来。**认不出就说认不出。**
 *
 * ⚠️ 用它之前先问一句：**这句话在另一端是不是错的？**
 *   只有"只在一端成立"的句子才需要分支（例：`手机的` / `Windows 的`）；
 *   "去教室那台机器上做某事"这种句子**两端都成立**，不许顺手加分支 ——
 *   那会把一句本来对的话切成两句半对的话。
 *
 * ⚠️ 别在这儿加别的能力（它只回答"哪一端"，不读别的字段）。
 */
export function shellPlatform(): ShellPlatform {
  const p = bridge()?.platform
  return p === 'electron' || p === 'capacitor' ? p : null
}

/**
 * 壳里是否**已经免掉了自动播放限制** —— 2026-10-04 加。
 *
 * 背景（用户当天报的）：「教室端**不支持置顶小窗，为什么还要点一下解锁声音**」。
 * 浏览器的自动播放政策要求"先有过一次用户手势"才允许出声，所以**网页版**上那一步
 * （教室端「先解锁声音」那个提示与按钮）是必需的；而**两个 exe 是壳** ——
 * 壳可以在 `webPreferences` 里直接写 `autoplayPolicy: 'no-user-gesture-required'`
 * ⇒ 那一步在壳里**根本不必要**。`preload.js` 同步暴露这个字段，网页据此跳过它。
 *
 * 🔴 三个地方**成对**：`_src/desktop/main-classroom.js` · `main-teacher.js` 的
 *    `autoplayPolicy` 与 `preload.js` 的这个字段 —— 改一个必须改另一个，
 *    否则"提示消失了但声音其实还是出不来"（那比多点一下更糟）。
 * ⚠️ 网页版、以及没这个字段的老壳 ⇒ `false` ⇒ **照旧显示那一步**，一字不变。
 */
export function shellAutoplayAllowed(): boolean {
  return bridge()?.autoplayAllowed === true
}

/**
 * 这个壳**自己说了**它开不了 Document PiP —— 2026-10-04 加。
 *
 * 🔴 为什么必须让**壳**来说（而不是让网页去猜）：实测（教室端 exe，Electron 33 / Chromium 130）
 *      · `typeof window.documentPictureInPicture === 'object'` —— **API 对象在**，
 *        所以"有没有这个 API"那条判据在壳里**永远是 true**；
 *      · 真手势（click 监听器里调、那一刻 `userActivation.isActive === true`）与
 *        CDP 的 `userGesture:true` **两条路都抛同一句**：
 *        `InvalidStateError: … requestWindow … Internal error: no window`
 *        ⇒ **Electron 没实现"创建那个 PiP 窗口"那一层**。
 *    ⇒ 网页侧只靠 `pipSupported()` 会判成"支持"，老师点下去才发现打不开，
 *      而提示还会甩锅给"浏览器版本太老"（那句话在壳里是**假的**）。
 *      `preload.js` 因此显式带 `documentPip: false`，让网页**提前**按"这台机器没有"处理。
 * ⚠️ 只认 `=== false`：老壳没有这个字段 ⇒ `undefined` ⇒ **不推翻** `pipSupported()`
 *    的原有判断（行为与今天完全一致，不会把好端端的网页版/新浏览器判成不支持）。
 */
export function shellDocumentPipUnavailable(): boolean {
  return bridge()?.documentPip === false
}

/* ============================================================================
   🆕 2026-10-04：**壳自带的原生置顶小窗**（教室端 exe；施工单 §三「网页」那一行）
   ----------------------------------------------------------------------------
   分工（和 `documentPip` 那一条正好相反）：
     · `documentPip: false`  —— 壳说"**网页那条路**在我这儿走不通"（老壳/教室端 exe 都有）；
     · `pip: {…}`           —— 壳说"**我有自己的一条路**"（**只有教室端 exe 有**）。
   网页侧的分支顺序因此是：**壳原生 → Document PiP → 都没有（no-api）**。
   ⚠️ 网页版里 `window.__shell_out` 压根不存在 ⇒ 这四个函数全都走"没有"那一支 ⇒
      **网页版行为一字不变**（`shots` 那一节钉着这条）。
   ============================================================================ */

/** 这个接口对象真的在不在 —— **只认"对象"**（`undefined` / 字符串 / 数字一律当没有） */
function pipBridge(): ShellPipBridge | null {
  const p = bridge()?.pip
  return typeof p === 'object' && p !== null ? p : null
}

/**
 * 壳里**有没有**原生置顶小窗的能力 —— `pip.ts` 的分支判据、`Classroom.tsx` 也是靠它。
 *
 * 🔴 **严格取值**：只认 `__shell_out.pip` **在且是对象**。
 *    · 教师端 exe / 网页版 / 老壳 ⇒ 读不到这个字段 ⇒ `false`（照旧走网页那条老路）；
 *    · 老壳里就算以后加了别的字段也不会被误判成"有原生小窗"。
 * ⚠️ 与 `documentPip` 是**两件事**：那个说"没有网页那条路"，这个说"有壳这条路"。
 */
export function shellPipAvailable(): boolean {
  return pipBridge() !== null
}

/**
 * 让壳开一个小窗（**单例**：已经有就复用）。
 * @returns 真的开出来了（或复用了）才 `true` —— 失败要说实话（不许静默）
 */
export async function shellPipOpen(payload?: ShellPipData): Promise<boolean> {
  const p = pipBridge()
  if (!p) return false
  try {
    const r = await p.open(payload)
    return !!(r && typeof r === 'object' && (r as { ok?: unknown }).ok === true)
  } catch (e) {
    console.error('[shell] pip.open 失败：', e)
    return false
  }
}

/**
 * 推一屏数据给小窗（**one-way**：壳不会回话）。
 * ⚠️ 只有小窗开着时才有意义；壳侧没有小窗时它什么都不做（不是错误）。
 */
export function shellPipData(payload: ShellPipData): void {
  const p = pipBridge()
  if (!p) return
  try {
    p.data(payload)
  } catch (e) {
    // 🔴 不许静默（硬规矩）：推不过去就说出来，别让屏上那块小窗停在上一条数据上
    console.error('[shell] pip.data 推不过去：', e)
  }
}

/** 关掉壳那个小窗（主页面那颗「小窗已开启」按钮、卸载、维护模式切进来时都走这儿） */
export function shellPipClose(): void {
  const p = pipBridge()
  if (!p) return
  try {
    p.close()
  } catch (e) {
    console.error('[shell] pip.close 失败：', e)
  }
}

/**
 * 小窗被关掉时的回调（**谁关的都算**：小窗自己那颗 ✕ / 网页侧 `close()` / 系统别的路）。
 * @returns 注销函数（组件卸载时要调它 —— 不然热更新会叠一堆监听）
 */
export function shellPipOnClosed(cb: () => void): () => void {
  const p = pipBridge()
  if (!p) return () => {}
  try {
    const off = p.onPipClosed(cb)
    return typeof off === 'function' ? (off as () => void) : () => {}
  } catch (e) {
    console.error('[shell] pip.onPipClosed 失败：', e)
    return () => {}
  }
}

/**
 * 登录页在"教室端登进了教师账号"时要显示的那两行。
 *
 * ⚠️ 文案纪律（A+ 力度）：只回答"这里是什么、我能做什么" ——
 *    **不解释**为什么拦、用什么判据、怎么绕（那是 `session.ts` 的注释的事）。
 * 导出成常量是为了**只有这一处能改文案**，也让门禁能钉住它。
 */
export const CLASSROOM_ONLY = {
  text: '请用教室端账号登录',
  desc: '这是教室端的程序，教师账号请在教师端登录。',
} as const

/* ============================================================================
   🆕 P0b（教室端插件化）：插件框架要的**那一组新壳能力** —— 本文件只写约定
   ----------------------------------------------------------------------------
   壳侧作业（`_src/desktop`，不在本仓库）照这一段实现；语义出处：
   《教室端插件开发手册.md》附录 A。四条共同纪律（与上面 `pip` 那一套同源）：

     1. **能力字段只认严格值**：每个包装函数先问"这条路在不在"（`typeof === 'function'`），
        老壳没有这个字段 ⇒ 按"没有"处理 ⇒ 网页版行为逐字不变。
     2. **失败要回 `{ ok:false, why }`**，且 `why` 必须是**能说给老师听的人话**——
        sha256 不符必须拒绝并说明，不许静默落盘（那是任意代码执行的口子）。
     3. 每个能力都在 `preload.js` 暴露，且**与主进程成对改**（历史教训：
        "提示消失了但声音其实还是出不来"）。

   | 能力 | 签名 | 要点 |
   |---|---|---|
   | `downloadPlugin` | `(url, { sha256 }) => Promise<{ ok:true, path } \| { ok:false, why }>` | 下到用户数据目录 `plugins/<id>/`；hash 不符**必须拒绝**并回可读 `why`；插件库地址是壳侧资产里的一项配置 |
   | `openTransparentWindow` | `({ pluginId, w, h, opacity? }) => Promise<{ ok, reused?, why? }>` | **一个插件一扇窗**（同一个 `pluginId` 已有就聚焦，`reused:true`）；窗里加载应用内路由 `app://-/popup/<pluginId>`；`opacity` 壳侧夹在 0.3–1.0（网页侧在调用前也夹一遍，两层都防） |
   | `closeTransparentWindow` | `(pluginId) => void` | 🆕 2026-10-24：关**那一个**插件的窗；找不到就什么都不做（不是错误） |
   | `onFloatingClosed` | `(cb: (pluginId) => void) => () => void` | 🆕 2026-10-24：某一扇浮窗被关掉（谁关的都算）时回调，**载荷是 `pluginId`**；返回注销函数 |
   | `pushBlockScreen` | `(payload) => void` | one-way：壳只把 payload 填进它自己的模板，**不算业务量**（沿用 `pip.data` 那条"网页算好、壳只画"的纪律） |
   | `closeAllFloating` | `() => void` | 维护模式切进 / 插件停用 / 登出 / 主程序退出时都要调；壳关完回 `shell:floatingClosed` |

   🔴🆕 2026-10-24（**浮窗不再是 `data:` 纸条窗**）：壳侧改成**每个插件一个真实窗口**，
   加载应用内路由 `app://-/popup/<pluginId>`（网页侧那一屏 = `src/pages/PluginPopup.tsx`）。
   ⇒ 三件事跟着变：① `openTransparentWindow` 收 `pluginId`（窗口的身份、复用的判据）；
   ② 窗里的内容**由那一屏自己渲染**（真实界面），不再靠 `pushBlockScreen` 填模板；
   ③ 关窗有了单扇的 `closeTransparentWindow(pluginId)`，被关时回 `shell:floatingClosed`，
     网页侧用 `onFloatingClosed` 收，**载荷是 `pluginId`**（不再是无参）。

   ⚠️ 悬浮窗是**镜像式**（手册 §9）：弹出后主屏功能块保留，悬浮窗渲染同一份数据；
   一个插件同时最多 1 个、全局上限 6 个 —— 这两条**数数的账在网页侧**
   （`ClassroomPluginShell` 的 pip 端口），壳只管开窗。
   ============================================================================ */

/** `preload.js` 将在 `__shell_out.plugins` 上暴露的那几个口（本文件顶部那张表）。 */
interface ShellPluginBridge {
  downloadPlugin?(
    url: string,
    opts: { sha256: string },
  ): Promise<{ ok: true; path: string } | { ok: false; why: string }>
  openTransparentWindow?(opts: {
    pluginId: string
    w: number
    h: number
    opacity?: number
  }): Promise<FloatingWindowResult>
  closeTransparentWindow?(pluginId: string): void
  onFloatingClosed?(cb: (pluginId: string) => void): unknown
  pushBlockScreen?(payload: Record<string, unknown>): void
  closeAllFloating?(): void
}

/**
 * 拿到 `__shell_out.plugins` —— **只认"在且是对象"**。
 * ⚠️ 刻意**不写**与 `pipBridge()` 那行一模一样的三元串：`nav-checks` 的反向对照会
 *    对本文件做一次**只换第一处**的文本替换来钉 `pipBridge()` 的严格取值，
 *    这里若出现同款字符串，那个对照就会换错行、当场假红（AGENTS.md §三.2 的坑）。
 */
function pluginBridge(): ShellPluginBridge | null {
  const p = bridge()?.plugins
  return p !== null && p !== undefined && typeof p === 'object' ? (p as ShellPluginBridge) : null
}

/** 壳里**有没有**"下载插件到本地缓存"这条路（网页版 / 老壳 ⇒ false，走不了真下载）。 */
export function shellPluginDownloadAvailable(): boolean {
  return typeof pluginBridge()?.downloadPlugin === 'function'
}

/**
 * 让壳把插件从插件库下到本机并校验指纹。壳不在 ⇒ `{ ok:false, why }`（照实说，不假装下成功）。
 */
export async function shellDownloadPlugin(
  url: string,
  opts: { sha256: string },
): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const fn = pluginBridge()?.downloadPlugin
  if (!fn) return { ok: false, why: '要教室版程序' }
  try {
    return await fn(url, opts)
  } catch (e) {
    console.error('[shell] downloadPlugin 失败：', e)
    return { ok: false, why: '插件没下载成，请重试一次' }
  }
}

/** 壳里**有没有**透明悬浮窗这条路（手册 §9：只有教室版程序有）。 */
export function shellTransparentWindowAvailable(): boolean {
  return typeof pluginBridge()?.openTransparentWindow === 'function'
}

/**
 * 开一扇浮窗的回话（**扁平形状**，壳侧原样给）。
 *
 * · `ok:true` → `reused` 说明这扇窗本来就在（聚焦复用），不是新开的；
 * · `ok:false` → `why` 是**能说给老师听的人话**，调用方转 toast，不许吞。
 * ⚠️ 老壳没有这条路 ⇒ 包装函数自己回 `{ ok:false, why:'要教室版程序' }`（不假装开成功）。
 */
export interface FloatingWindowResult {
  ok: boolean
  reused?: boolean
  why?: string
}

export interface TransparentWindowOpts {
  /**
   * 哪个插件的窗（= `manifest.id`；壳用它当窗口身份，也是"已有就复用"的判据）。
   * 🔴 必填：没有它，壳既认不出该复用哪扇窗，窗里的 `/popup/<pluginId>` 也没了主键。
   */
  pluginId: string
  w: number
  h: number
  /** 0.3–1.0；越界在这里先夹紧（壳侧还会再夹一遍），不报错 */
  opacity?: number
  /**
   * 🆕 2026-10-24：**这一扇要不要绝对置顶**。
   *
   * 用户定的口径：「只有讲评那一块启动置顶小窗才是绝对置顶，其他的插件弹窗都是仅在桌面上」。
   * · `true`（只有插件自己调 `ctx.pip.open` 那条路）= 老 PiP 那一档（压得住别的软件）；
   * · 缺省 `false`（功能块角上那颗「弹出」）= 普通的浮窗，别的软件一切过来就盖住它。
   * ⚠️ 别把它默认成 true：那样一整屏会挂满永远压在最上面的窗。
   */
  topmost?: boolean
}

/**
 * 给某个插件开浮窗（**一个插件一扇窗**：壳侧已有就复用并聚焦）。
 * 返回 `ok:false` 时 `why` 是给人看的话 —— 调用方把它转成 toast，不许吞。
 */
export async function shellOpenTransparentWindow(
  opts: TransparentWindowOpts,
): Promise<FloatingWindowResult> {
  const fn = pluginBridge()?.openTransparentWindow
  if (!fn) return { ok: false, why: '要教室版程序' }
  const opacity =
    opts.opacity === undefined ? 1 : Math.min(1, Math.max(0.3, opts.opacity))
  try {
    const r = await fn({ ...opts, opacity })
    /* 🔴 只认 `=== true`：老壳回 `undefined` / 半个对象都算"没开成"，别把空窗当成功 */
    if (r && r.ok === true) return { ok: true, reused: r.reused === true }
    return {
      ok: false,
      why: r && typeof r.why === 'string' && r.why ? r.why : '悬浮窗没开成，再点一次试试',
    }
  } catch (e) {
    console.error('[shell] openTransparentWindow 失败：', e)
    return { ok: false, why: '悬浮窗没开成，再点一次试试' }
  }
}

/**
 * 关掉**某一个**插件的浮窗（🆕 2026-10-24）。
 * 壳侧找不到那扇窗就什么都不做 —— 那不是错误（主屏在"开一半失败"之后也会来这里收）。
 */
export function shellCloseTransparentWindow(pluginId: string): void {
  const fn = pluginBridge()?.closeTransparentWindow
  if (!fn) return
  try {
    fn(pluginId)
  } catch (e) {
    console.error('[shell] closeTransparentWindow 失败：', e)
  }
}

/**
 * 有浮窗被关掉时的回调（**谁关的都算**：窗里那颗 ✕ / 主屏关的 / 系统别的路）。
 * 载荷是 `pluginId` —— 主屏据此只复位那一块，不用把六扇窗全当关了。
 * @returns 注销函数（组件卸载时要调它 —— 不然热更新会叠一堆监听）
 */
export function shellOnFloatingClosed(cb: (pluginId: string) => void): () => void {
  const fn = pluginBridge()?.onFloatingClosed
  if (!fn) return () => {}
  try {
    const off = fn(cb)
    return typeof off === 'function' ? (off as () => void) : () => {}
  } catch (e) {
    console.error('[shell] onFloatingClosed 失败：', e)
    return () => {}
  }
}

/**
 * 把一块功能块的内容**推给壳画**（one-way；壳没有这条路时什么都不做——
 * 它本来就是"锦上添花"的那一半，真正的失败面在 `openTransparentWindow` 上说）。
 */
export function shellPushBlockScreen(payload: Record<string, unknown>): void {
  const fn = pluginBridge()?.pushBlockScreen
  if (!fn) return
  try {
    fn(payload)
  } catch (e) {
    // 🔴 不许静默（硬规矩）：推不过去就说出来，别让悬浮窗停在上一条内容上
    console.error('[shell] pushBlockScreen 推不过去：', e)
  }
}

/** 收掉壳里**全部**悬浮窗（维护切进 / 插件停用 / 登出 / 退出——附录 A 第 4 条）。 */
export function shellCloseAllFloating(): void {
  const fn = pluginBridge()?.closeAllFloating
  if (!fn) return
  try {
    fn()
  } catch (e) {
    console.error('[shell] closeAllFloating 失败：', e)
  }
}