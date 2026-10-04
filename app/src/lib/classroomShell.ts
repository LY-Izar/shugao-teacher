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