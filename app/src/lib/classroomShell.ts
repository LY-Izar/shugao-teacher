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