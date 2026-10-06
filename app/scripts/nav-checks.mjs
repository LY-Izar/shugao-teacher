/**
 * 按身份显示导航 · 静态审计 + 纯函数断言（`按身份显示导航方案.md` §五 R1/R4）
 * 用法：npm run nav-checks（纯 Node，不连浏览器；但 D7 要读 `npm run build` 的产物）
 *
 * 为什么单开一个脚本、不塞进 `shots.mjs`：`shots.mjs` 是**真浏览器 + 拨表 + 101 张图**
 * 的重家伙，而这里 A1–A7 是纯函数、D1–D8 是读文件，**一秒内跑完、失败信息干净**。
 * `clock-checks.mjs` 已经是"专门一层"的先例（`功能设计与不变量.md` §18.1）。
 *
 * ⚠️ 它同样必须上锁（`scripts/lib/lock.mjs` 的 `withLock()`，§18.8.1 原文：
 * "五个脚本已经全部包好，**不许再各写一套**"）—— 不是因为要连浏览器，
 * 而是因为它是"同一批验证里的一个"：它读 `dist/`、读文档、读源码，
 * 不能在 `shots` 正跑着的时候跟它抢同一份工作区状态。
 *
 * ============================================================
 * 这一层守什么（三层里的第一层）
 * ------------------------------------------------------------
 *   · 纯函数（A1–A8）：角色组合 → 该看见哪些入口。**"该藏的时候藏了、该显示的时候显示了"**
 *     两个方向都钉（§18.3：两个坏法方向相反，各要一条对照）。
 *     🆕 **A10（2026-09-28 公告轮）：全站公告的纯逻辑** —— 排序 / 生效区间 /
 *     顶部摆哪几条 / 弹窗弹几次。那几件事**没有别的机器能验**（不是布局、不是权限、不是类型）。
 *     🆕 **A12（2026-10-04 版本更新公告）：前端与 Pages Function 那份"共享区"** ——
 *     `src/lib/release.ts` 与 `functions/api/_lib/release.ts` 之间那一段**逐字节比对**
 *     （抄一份的代价必须补回来；逐行 grep **不够**：漏抄一行可能一条都不红），
 *     外加版本比较 / 三态判定 / 默认正文 / 挑哪条下载链接 / 哪一档 / 回话解析 / 禁词与表单校验，
 *     以及 `RELEASE_KEYS` ↔ `schema.sql` 种子行、四个列名 ↔ `RELEASE_SELECT_COLS` 的契约。
 *     🆕 **A13（2026-10-04 输入法组字）：apk 上点按钮吞字** —— `installImeMirror()` 补派发的
 *     那个 `input` 必须**恰好一个 / 冒泡 / `isComposing:false`**，且监听挂在 `document` 的
 *     **捕获**阶段（挂冒泡就晚于 React 的容器监听 —— 那正是 bug 本身）；
 *     反向对照是把那一行 `dispatchEvent` 删掉 ⇒ 一个都不补；
 *     外加 `main.tsx` 里"调在 `createRoot(` 之前 + import 自 `./lib/imeMirror`"的接线。
 *     🆕 **A14（2026-10-04 教室端壳能力）：壳声明 ↔ 网页判据** —— 用户报的第 ④ 条
 *     「**不支持置顶小窗，为什么还要点一下解锁声音**」。实测（真壳 · Electron 33）：
 *     `documentPictureInPicture` 这个**对象在**（老判据会判"支持"），而 `requestWindow()`
 *     真手势与 CDP `userGesture:true` **两条路都抛** `InvalidStateError … no window`；
 *     而"解锁声音"那一步在壳里**本来就多余**（默认 `autoplayPolicy` 免手势）。
 *     ⇒ 壳用 preload 声明（`autoplayAllowed: true` / `documentPip: false`），网页只认**严格值**。
 *     A 半打纯函数行为（`pipSupported` / `openPip` 的三态、`requestWindow` 一次都没调），
 *     B 半钉 `Classroom.tsx` 的**按端分支位置**（不是"这两句话在不在"），每条带反向对照。
 *     🆕 **A15（2026-10-04 教室端**原生**置顶小窗）：壳自己那条路** ——
 *     真壳实测：`documentPictureInPicture` 这个**对象在**，而 `requestWindow()` 必抛
 *     `InvalidStateError: … no window` ⇒ **Electron 没实现"创建那个 PiP 窗口"那一层**
 *     ⇒ 两个 exe 改走壳的 `BrowserWindow({ alwaysOnTop: true })`（`__shell_out.pip`），
 *     而**网页版照旧走 Document PiP**。分支顺序因此定死：**壳原生 → Document PiP → no-api**；
 *     A 半钉 `shellPipAvailable()` 的严格取值与这个顺序（壳在时 `requestWindow` 一次都不许调），
 *     B 半钉 `Classroom.tsx` 里"题号一变就推数据"那一处的字段/依赖/**位置**，各带反向对照。
 *     🆕 **A16（2026-10-04）：「我的」页那三处取舍 ——「删除也是被钉住的」** ——
 *     用户当天点名删掉的东西（「关于」里的学段学科 / 存储两行、「教室端」整卡、
 *     「备份与恢复」里的加密导出 / 备份到云端 / 下面那段说明）**在源码里必须真的没有**，
 *     而换上去的三颗下载按钮要接 `releaseDownloads(useReleaseSlots())`；
 *     撤下的那两颗的**实现**另存于 `components/BackupExtraActions.tsx`（入口撤、实现留）。
 *     🔴🔴 **③ 的期望值 2026-10-05 变了（用户要求，别再改回去）**：
 *     「把用户可以下载备份文件的入口也取消了吧」⇒ 连导出 / 恢复那两颗也撤，
 *     「备份与恢复」**整卡删掉**（源码里一颗都不许在）—— 详见本节 ③ 那段注释。
 *     ⚠️ 判据一律**先剥注释**（"为什么删"就写在注释里，不剥会被自己骗过）。
 *   · 静态（D1–D7 / D9 / D10）：路由 ↔ 登记表 ↔ 本文档矩阵三方咬合；入口判据不许各写一套；
 *     谁在读 `myRoles` / `ROLE_NAME` 要有白名单；`PIN_KEYS` 不许脱队；
 *     生产构建里测试钩子不许出现；
 *     🆕 **D18（2026-10-04）：两档公告**必须跟着 `GET /api/status` 那**同一次**取数回来 ——
 *     `useRelease.ts` 里不许有 `setInterval` / `setTimeout` / `fetch(`，
 *     而 `<ReleaseGate>` 必须挂在 `MaintenanceGate` **内部**（挂到 `App.tsx` = 第二个轮询）。
 *     🆕 **D10：表存在性探针不许假设任何列存在**（`select('*')`）+
 *     「表不在」与「列不在」判据分流（这一类 bug 已经咬了两次：`subjects` / `notice_targets`）。
 *     🆕 **D12（2026-10-12）：念出来的号 / 摆上屏的号 = 班内学号** ——
 *     「呼叫后教室端播报的应该是学生的班级内学号，而不是年级序列号」（用户原话）；
 *     谁在拼"念出来的话"、谁自己抄了一遍 `s.serial || s.studentNo`，两样都钉住。
 *     🆕 **D15（2026-10-03）：关着的浮层不许在第一帧被挂出来** —— `useExit` 初值写错
 *     （`false` 而不是 `!open`）时每次切页真的画出一整屏暗幕再滑下去（用户报的
 *     "底部弹窗闪一下"）；`shots` 的 04f 测的是反方向（关掉之后留 180ms），钉不住它。
 *     🆕 **D16（2026-10-04）：站内接口只有一个基址** —— 两个壳（`app://-` /
 *     `https://localhost`）加载的是打进包里的网页产物，**相对路径**的 `/api/*` 会被壳
 *     自己的本地服务器接走（回 `200 + index.html`）⇒ 维护模式读不到、面板误报"未配置"。
 *     一律走 `src/lib/apiBase.ts` 的 `apiUrl()`；跨域预检在 `functions/api/_middleware.ts`。
 *     🆕 **D17（2026-10-04）：产物面向老设备的底线** —— 用户报"安卓较低版本上 UI 不能正常
 *     显示"，根因是**产物基线**：① Tailwind v4 把全部样式放进 `@layer`（底线 Chrome 99），
 *     更老的 WebView **不认识 `@layer`、连块带规则一起丢掉** ⇒ 页面完全没样式；
 *     ② 不写 `build.target` 时产出 `?.`/`??`（Chrome 80+）⇒ 更老的 WebView **解析失败** ⇒ 白屏。
 *     判据：产物 CSS 里 `@layer` 必须为 0；`vite.config.ts` 必须钉着 `target: 'es2015'` + 摊平插件。
 *   · 编码（D8）：全仓文本文件的无 BOM / 严格 UTF-8 / 中文没被 mojibake，
 *     外加**不可见字符 / 全角标点混进代码** ——
 *     这个项目**反复栽在编码上**（BOM 出过构建失败、上一轮又出双重编码乱码），
 *     而全仓扫一遍成本极低。带反向对照（伪造的坏字节流 / 坏字符必须被判坏）。
 * ============================================================
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const REPO = resolve(APP, '..')

/* ---------------- 断言与日志（照 clock-checks / shots 的样子） ---------------- */

let passed = 0
const failures = []
let currentSection = '(还没开始)'
const printed = new Set()

/** 🔴 灰档（`shellGray`）的作用域账 —— 见下面那段"逐节收口"的注释，节末自证拿这两个数咬人 */
let sectionOpens = 0 // `section()` 被调了几次
let shellGrayCount = 0 // 一共落灰几条
/**
 * 上一个 `section()` 打开时，灰档里是不是已经有灰了？
 * 正常永远是 `null`：`section()` 会**强制关掉**灰档 ⇒ 新节**不可能继承**上一节的灰。
 * 只有"灰档跨节泄漏"（= 那几节在 CI 上变成静默 no-op）才会留下一个节名。
 */
let grayLeakInto = null

function section(name) {
  currentSection = name
  sectionOpens++
  /*
   * 🔴🔴 **2026-10-05 逐节收口（第三次 CI 红之后同一轮挖出的既有隐患）**：
   *    `shellGray` 原来靠**各处手工 `= false`** 收口 —— A21 在 7476 关、A22 只在
   *    **自证块内部**（8760）关、A24 在 9238 关。也就是说"A22 之后还灰不灰"**取决于
   *    自证那两句恰好被执行到**，而不是取决于"这一节该不该灰" ✗。
   *    后果（§三.1「门禁自己也要能红」最忌讳的形状）：**谁能保证下一节不会被
   *    `shellGray === true` 罩住 ⇒ 那一节的断言变成静默 no-op**（在 CI 上"从没跑过"，
   *    而报告里照样写着"全部通过"✓，因为它既不计红也不计绿）。
   *    ✅ 收口方式：**每次开新节一律 `shellGray = false`** —— 灰档**不可能跨节**。
   *       要灰就在**本节内**用 `shellSide()` 或显式 `shellGray = true` 打开，
   *       并**在本节内关掉**（`shellSide` 自动复原；手工打开的由本节自证兜住）。
   *    ⚠️ 顺序要紧：先把"上一节结束时还灰着吗"记进 `grayLeakInto`，再清掉它。
   */
  if (shellGray) grayLeakInto = `${currentSection} → ${name}`
  shellGray = false
  if (!printed.has(name)) {
    printed.add(name)
    console.log(`\n── ${name}`)
  }
}

/*
 * ============================================================
 * 🆕 三态的第三档：**灰**（探不到 ≠ 坏了）—— 2026-10-05（CI 红）
 * ------------------------------------------------------------
 * 硬纪律（`AGENTS.md` §三.4）：「没结论必须是灰，绝不能红；红只在"确实没跑/确实坏了"时出现」。
 *
 * 🔴 事故：**A21/A22 里的壳那一侧读的是仓库外的打包工程**
 *    （`C:\Users\Administrator\Desktop\树高教务通打包`，它**不在这个公开仓库里** ⇒
 *     CI 的干净检出**必然**没有）⇒ 那两节开头那句「找不到就是红」在 CI 上**恒红**，
 *     而本地（打包工程在）恒绿 ⇒ `0f45438` / `d8d1e98` 两次 CI 都红、而本机 1332/0。
 *     那是**一条不可能在 CI 变绿的卡**（与 §三.1「假红」同源）。
 *
 * ✅ 改法：**只有"读仓库外那份文件"的那一段**允许落灰，其余一个字都不许灰：
 *    · `shellGray === true` 期间，`check()` 一律打成 `⚪ 灰（探不到）` 并计入 `grayed`，
 *      **不红也不绿**（那些判据读的是空串，判它们毫无意义）；
 *    · 打包工程**在**的机器上（维护者本机）这个开关**永远不开** ⇒ 一条判据都不变、一个字都不灰；
 *    · 🔴 每一节末尾都有一条**自证**（可红）：壳不在时"壳那一侧**一条都没判**"、
 *      而 app 侧那几条（只读 `app/` 下、CI 里也在的文件）**一条都没灰** ⇒
 *      将来谁忘了把开关关掉/打开，那条自证当场红。
 *    ⚠️ 这不是"放宽判据"：**能在 CI 里验的那一半（app 侧源码）照旧逐条判**，
 *      灰掉的只是"本机才有、CI 里根本不存在"的那半个输入。
 * ============================================================
 */
let grayed = 0
let shellGray = false

function check(ok, label, observed, extra = '') {
  if (shellGray) {
    grayed++
    shellGrayCount++
    console.log(`   ⚪ ${label}\n        灰（探不到，不红不绿）：${observed}`)
    return
  }
  if (ok) {
    passed++
    console.log(`   ✅ ${label}${observed ? `\n        实测：${observed}` : ''}`)
  } else {
    failures.push(`[${currentSection}] ${label} —— 实测：${observed}${extra ? `（${extra}）` : ''}`)
    console.log(`   ❌ ${label}\n        实测：${observed}${extra ? `　（${extra}）` : ''}`)
  }
}

const eq = (label, got, want, extra = '') =>
  check(got === want, label, `得到 ${JSON.stringify(got)}`, `期望 ${JSON.stringify(want)}${extra ? ` · ${extra}` : ''}`)

/** 集合相等（比"包含"强：多一项也红）—— B1/D1/D2 都用它 */
const eqSet = (label, got, want) => {
  const g = [...new Set(got)].sort()
  const w = [...new Set(want)].sort()
  const missing = w.filter((x) => !g.includes(x))
  const extra = g.filter((x) => !w.includes(x))
  check(
    missing.length === 0 && extra.length === 0,
    label,
    `${g.length} 项${missing.length ? ` · 少了 ${missing.join('、')}` : ''}${extra.length ? ` · 多了 ${extra.join('、')}` : ''}`,
    `期望 ${w.length} 项`,
  )
}

const short = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const readRepo = (rel) => readFileSync(join(REPO, rel), 'utf8')
const readApp = (rel) => readFileSync(join(APP, rel), 'utf8')

/* ---------------- 读真源码（走 scripts/lib/ts-resolve.mjs，§12.4.1 的做法） ---------------- */

registerTsResolve()
/*
 * 🧪 **负向对照**：`SHUGAO_NAV_FORCE=all|none` 会把 `entryVisible()` 变成恒真 / 恒假。
 * 这是 §18.3 要求的"两个方向的坏法各一条对照"的落点（恒真 = 入口全摆等于没做；
 * 恒假 = 全藏，连胶囊都空了），**不用真改源码再改回来** ——
 * 后者一旦漏还原，仓库里就留下一条恒真的权限判据。
 * ⚠️ 期望行为：设了它之后**本脚本必须变红**（退出码 1）。绿了就说明这一层断言是摆设。
 */
if (process.env.SHUGAO_NAV_FORCE) {
  globalThis.__NAV_FORCE__ = process.env.SHUGAO_NAV_FORCE
  console.log(`\n🧪🧪 负向对照模式：entryVisible 恒 ${process.env.SHUGAO_NAV_FORCE === 'all' ? '真' : '假'}（下面**必须**有红）\n`)
}
const roles = await import('../src/lib/roles.ts')
const { PAGES, PLANNED_PAGE_COUNT, MATRIX_SHAPE, MATRIX_SHAPE_13 } = await import('../src/lib/pages.ts')

/** 矩阵里的 6 列（顺序 = 方案 §2.2 表头里的顺序，不许改） */
const ROLES6 = [
  { key: 'super', label: 'super 最高管理员', roles: [{ role: 'super' }] },
  { key: 'admin', label: 'admin 教务处', roles: [{ role: 'admin' }] },
  { key: 'grade_head', label: 'grade_head 年级主任', roles: [{ role: 'grade_head' }] },
  { key: 'head_teacher', label: 'head_teacher 班主任', roles: [{ role: 'head_teacher' }] },
  { key: 'teacher', label: 'teacher 任课教师', roles: [{ role: 'teacher' }] },
  { key: 'classroom', label: 'classroom 教室端', roles: [] },
]

/**
 * 🆕 2026-09-28「管理架构与角色权限」这一轮新增的 **7 列**
 * （顺序 = `管理架构与角色权限方案.md` §4.2 表头的顺序：校 副 助 办 德 教组 备组）。
 *
 * ⚠️ **这 7 列不出现在 `EXPECTED`（那张 6 × 14 的表）里** —— 那一张表是
 * "6 档教师身份 × 14 个入口"的口径，加列会让 A1 的 84 格变成 182 格、
 * 而 `MATRIX_SHAPE`（34 / 145 / 27 / 32）**一个字都不许动**。
 * 新列的断言在 A8 与 D9 两节（各自对**新的一组分母**负责）。
 */
const ROLES7 = [
  { key: 'principal', label: 'principal 校长', roles: [{ role: 'principal' }] },
  { key: 'vice_principal', label: 'vice_principal 副校长', roles: [{ role: 'vice_principal' }] },
  { key: 'principal_assistant', label: 'principal_assistant 校长助理', roles: [{ role: 'principal_assistant' }] },
  { key: 'office_head', label: 'office_head 办公室主任', roles: [{ role: 'office_head' }] },
  { key: 'moral_edu_head', label: 'moral_edu_head 德育处主任', roles: [{ role: 'moral_edu_head' }] },
  { key: 'subject_lead', label: 'subject_lead 教研组长', roles: [{ role: 'subject_lead' }] },
  { key: 'lesson_prep_lead', label: 'lesson_prep_lead 备课组长', roles: [{ role: 'lesson_prep_lead' }] },
]

/** 13 列的**列序**（= 方案 §4.2 的表头顺序：超 教 校 副 助 办 德 级 教组 备组 班 任 室） */
const COLORDER13 = [
  'super', 'admin', 'principal', 'vice_principal', 'principal_assistant', 'office_head',
  'moral_edu_head', 'grade_head', 'subject_lead', 'lesson_prep_lead', 'head_teacher', 'teacher',
  'classroom',
]
/** 13 列（按上面的顺序取到那 13 个身份；表头缩写也要按这个顺序核，见 D9） */
const COLS13 = COLORDER13.map((k) => {
  const found = [...ROLES6, ...ROLES7].find((r) => r.key === k)
  if (!found) throw new Error(`13 列里有一个找不到的角色 key：${k}`)
  return found
})
/** 方案 §4.2 表头的**缩写**（与上面逐列一一对应）—— D9 拿它核"列序没被改过" */
const HEAD13 = ['超', '教', '校', '副', '助', '办', '德', '级', '教组', '备组', '班', '任', '室']

/* ============================================================
   🔒 整个脚本的工作都在这把锁里面（与另外六个验证脚本共用一把）
   ============================================================ */

await withLock(async () => {
console.log('【按身份显示导航 · 静态审计】')
console.log(`  仓库：${REPO}`)
console.log(`  入口表：${Object.keys(roles.ENTRIES).length} 个 key · 登记表：${PAGES.length} 条路径`)

/* ============================================================
   第一节 · A1：6 个身份 × 14 个入口（逐格对方案 §2.2）
   ============================================================ */

section('第一节 · A1：6 个身份 × 14 个入口（逐格对方案 §2.2 的矩阵）')

/** 方案 §2.2 的矩阵里，这 14 个入口对每一列是 V（看得见）还是 E（藏入口就够） */
const EXPECTED = {
  //                        super  admin  grade  head   teacher classroom
  '/': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/classes': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/assignments': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/exams': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/wrong': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/schedule': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/settings': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/files': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  '/calls': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true, classroom: false },
  // 只有 super / admin（`canManageTeachers()`）—— §2.3 #27
  '/accounts': { super: true, admin: true, grade_head: false, head_teacher: false, teacher: false, classroom: false },
  // ★ 年级管理：super/admin 全部；年级主任 V（列表由 RLS 筛）；班主任与任课老师 E
  '/grades': { super: true, admin: true, grade_head: true, head_teacher: false, teacher: false, classroom: false },
  // ★ 提档：`is_school_admin()`（super + 教导处），**年级主任 ❌** —— 与上一行不同，别跟着抄
  '/grades/promote': { super: true, admin: true, grade_head: false, head_teacher: false, teacher: false, classroom: false },
  /*
   * ★ 学期与学年：矩阵 §2.2 第 33 行那一格是 **V**（super / admin / 年级主任），
   * 而 §2.3 的正文与 §七 待确认 ④ 的建议都是 E —— **两处矛盾**。
   * 本轮按**矩阵的格子**落（理由：§2.2 与附录里写死的 145/27 自检值只有在这一格是 V
   * 时才成立），并在报告里单列了这一条。⚠️ 用户若改判成 E，改的是这一行 + ENTRIES
   * 那一格 + 方案 §2.2 的汇总数字（145→144、27→28），三处要一起动。
   */
  '/settings/terms': { super: true, admin: true, grade_head: true, head_teacher: false, teacher: false, classroom: false },
  // ★ 平台运维：**只能是 isSuperAdmin**（方案 §3.5 原文：不能用 canManageTeachers，那会把教导处放进来）
  '/admin': { super: true, admin: false, grade_head: false, head_teacher: false, teacher: false, classroom: false },
}

for (const entry of Object.keys(EXPECTED)) {
  if (!(entry in roles.ENTRIES)) {
    check(false, `A1：入口 ${entry} 在 ENTRIES 里`, '找不到这个 key', '方案 §4.1 的表里有它')
    continue
  }
  for (const r of ROLES6.filter((x) => x.key !== 'classroom')) {
    const got = roles.entryVisible(entry, r.roles)
    eq(`A1：${r.label} 对 ${entry}`, got, EXPECTED[entry][r.key])
  }
  /*
   * 🔴 **教室端那一列单独说**（这一格是全表最容易做错的地方）。
   *
   * 方案 §2.2 的教室端列是 B —— 但那条 B **不是这张表在做**，而是
   * `App.tsx` 的一句 `if (accountKind === 'classroom') return <Navigate to="/classroom" />`
   * 管了 32 行（方案 §2.2 的 U4 原文："**不是在要求你写 32 个守卫**"）。
   * `ENTRIES` 看不见 `accountKind`（M2 只准读 `roles` 一个参数），所以它在这 9 项上
   * 说不了"教室端不摆" —— 教室端账号**根本没有 `teacher_roles` 行**，
   * 在入口表眼里就是"没有身份"，而"没有身份"与"认不出的身份"必须同样处理（A3）。
   *
   * 所以这里断言的是**这条边界本身**，而不是假装表里有 32 个 false：
   *   ① 教室端到不了教师端 = **`accountKind` 那一支**，由 `shots.mjs` 的
   *      C1/C2（真界面、`?kind=classroom`）与 `admin-checks.mjs` 第十节（判据形状）钉住；
   *   ② 入口表这一侧只保证：**它不会让教室端多拿到管理入口**
   *      （而这正是"教室端没有 teacher_roles 行"的直接后果）。
   *
   * 🆕 2026-09-28：加了通知两行（`/notices` 是 `() => true`）之后，教室端在
   *    "全员都摆"的那些项上同样是 true —— 所以判据从 `EXPECTED[entry].teacher`
   *    改成 **"`roles.entryVisible(entry, [{role:'teacher'}])` 说摆不摆"**
   *    （教师身份是"最低那一档"，全员项对它为真、管理项对它为假；语义与原来逐字相同，
   *     只是不再依赖"教师那一格必须写在 `EXPECTED` 里"）。
   */
  const classroomVis = roles.entryVisible(entry, [])
  eq(
    `A1：教室端（roles=[]）对 ${entry} —— 没有 teacher_roles 行，管理入口一个都拿不到`,
    classroomVis,
    roles.entryVisible(entry, [{ role: 'teacher' }]) && !roles.hasManagingRole([]),
  )
}
check(
  Object.keys(EXPECTED).length * ROLES6.length === 84,
  'A1 的格数 = 6 × 14 = 84（教室端那一列断言的是"这条边界在哪"，见上方注释）',
  `${Object.keys(EXPECTED).length} × ${ROLES6.length} = ${Object.keys(EXPECTED).length * ROLES6.length}`,
)

/* ============================================================
   第一节之二 · A8：通知那两行（**本轮新增的第 15 / 16 个入口**）
   ------------------------------------------------------------
   它们**不在** `EXPECTED` 里 —— 那一张表是"6 × 14 = 84 格"的口径，
   而 `MATRIX_SHAPE`（34 / 145 / 27 / 32）一个字都不许动（见 A8 上面那段）。
   所以新两行单独在这里钉：逐身份断言"摆不摆"，外加 6 列的小计 V8 / E2 / B2
   （方案 §四.0 的 ①′：`153 / 29 / 34`）。
   ============================================================ */

section('第一节之二 · A8：通知两行（/notices · /notices/new）—— 表格里是 V，域外两行是 B')

const NOTICE_ROWS = ['/notices', '/notices/new']

/** 方案 §4.2 第 18 / 19 行那 26 格（6 列 × 2 行，教室端由 App 那一支管所以这里只核 5 档教师身份） */
const NOTICE_EXPECTED = {
  //             super  admin  grade  head   teacher
  '/notices': { super: true, admin: true, grade_head: true, head_teacher: true, teacher: true },
  // 班主任与任课教师是 **E**（不是 B）：进来会看到"你没有发通知的权限"，不构成信息泄露
  '/notices/new': { super: true, admin: true, grade_head: true, head_teacher: false, teacher: false },
}

for (const entry of NOTICE_ROWS) {
  check(
    entry in roles.ENTRIES,
    `A8：入口 ${entry} 在 ENTRIES 里`,
    entry in roles.ENTRIES ? `label = ${roles.ENTRIES[entry].label}` : '找不到这个 key',
  )
  for (const r of ROLES6.filter((x) => x.key !== 'classroom')) {
    eq(`A8：${r.label} 对 ${entry}`, roles.entryVisible(entry, r.roles), NOTICE_EXPECTED[entry][r.key])
  }
}
{
  /* 6 列的小计：`V8 / E2 / B2` —— 教室端两行**都是 B**（方案 §四.0 那个"关节"） */
  let v = 0
  let e = 0
  for (const entry of NOTICE_ROWS) {
    for (const r of ROLES6.filter((x) => x.key !== 'classroom')) {
      if (roles.entryVisible(entry, r.roles)) v++
      else e++
    }
  }
  eq('A8：通知两行在 6 列上的 V 格数', v, 8)
  eq('A8：通知两行在 6 列上的 E 格数', e, 2)
  eq('A8：通知两行在 6 列上 = 12 格（6 列 × 2 行）', v + e + 2, 12, '教室端那 2 格是 B')
  eq(
    'A8：教室端对通知两行 = "全员项的可见性"（真 B 在 App.tsx 与数据库两处，不在这张表）',
    NOTICE_ROWS.map((k) => roles.entryVisible(k, [])).join(','),
    NOTICE_ROWS.map((k) => roles.entryVisible(k, [{ role: 'teacher' }])).join(','),
    '入口表眼里它是"没有身份"，与"全员项"同款 —— 那两处 B 才是安全边界（I47）',
  )
}
{
  /*
   * ①′ 的 6 列小计：6 列那一份的 `MATRIX_SHAPE` + 通知两行（+8 V / +2 E / +2 B）。
   * ⚠️ 这一组**不是 §2.2 的矩阵**：§2.2 只有 6 列、**没有** `/notices` 那两行，
   *    而这两个小计是 `管理架构与角色权限方案.md` §四.0 那个口径（含通知）。
   * 🆕 2026-10-01：`MATRIX_SHAPE` 变了（加 `/manage` 那一行 + 按实测改正聚合数），
   *    所以这一组的期望值也跟着变成 **156 / 30 / 35**（派生写法，改一处即可）。
   * 🆕 2026-10-12：再加一行 `/manage/course`（课程管理第 3 轮）之后，
   *    `MATRIX_SHAPE` 是 **36 / 151 / 31 / 34** → 这一组的期望值是 **159 / 33 / 36**
   *    （V 151+8、E 31+2、B 34+2）。**三个数都是派生的，别手算**。
   * 🆕 2026-10-XX：再加一行 `/manage/calendar`（校历）之后，
   *    `MATRIX_SHAPE` 是 **37 / 154 / 33 / 35** → 这一组的期望值是 **162 / 35 / 37**。
   */
  eq(`A8 对账：${MATRIX_SHAPE.v} + 8 = ${MATRIX_SHAPE.v + 8}（①′ 的 V）`, MATRIX_SHAPE.v + 8, 162)
  eq(`A8 对账：${MATRIX_SHAPE.e} + 2 = ${MATRIX_SHAPE.e + 2}（①′ 的 E）`, MATRIX_SHAPE.e + 2, 35)
  eq(
    `A8 对账：${MATRIX_SHAPE.b} + 2 = ${MATRIX_SHAPE.b + 2}（①′ 的 B —— 教室端那两格）`,
    MATRIX_SHAPE.b + 2,
    37,
  )
  eq(
    'A8 对账自证：①′ 的 V+E+B == (矩阵行数 + 2 行) × 6',
    MATRIX_SHAPE.v + 8 + MATRIX_SHAPE.e + 2 + MATRIX_SHAPE.b + 2,
    (MATRIX_SHAPE.rows + 2) * 6,
  )
}
{
  /*
   * 🔴 **本轮这两档身份在入口层唯一的区别**（方案 §4.5 末尾那条专门断言）：
   *    组长**看得见「发通知」**，任课教师看不见 ——
   *    而他们在原来那 14 个入口上**逐格相同**（25/9/0）。
   * ⚠️ 组长两档**权限逐格相同、只是职责/头衔不同**（用户拍板）：所以这两列
   *    在本脚本里必须**永远一起断言**，分开写就是给"它们其实不一样"留后门。
   */
  for (const key of ['subject_lead', 'lesson_prep_lead']) {
    const asLead = [{ role: key, scopeType: 'subject', subjectCode: 'physics' }]
    eq(`A8：${key} 看得见 /notices/new（他是**发通知的人**）`, roles.entryVisible('/notices/new', asLead), true)
    eq(`A8：${key} 看得见 /notices（收件箱对谁都有意义）`, roles.entryVisible('/notices', asLead), true)
    eq(`A8：${key} 看不见 /accounts（他不是管账号的人）`, roles.entryVisible('/accounts', asLead), false)
    eq(`A8：${key} 看不见 /admin（平台运维只有超管）`, roles.entryVisible('/admin', asLead), false)
  }
  eq(
    'A8：任课教师**看不见** /notices/new（他没有"需要通知一批老师"的职务）',
    roles.entryVisible('/notices/new', [{ role: 'teacher' }]),
    false,
  )
  eq(
    'A8：班主任也看不见 /notices/new（他的班级事务走**呼叫**，不是通知）',
    roles.entryVisible('/notices/new', [{ role: 'head_teacher' }]),
    false,
  )
  /* 正面：两档组长在这 14 个老入口上**逐格相同**（这一条钉"逐格相同是刻意的"） */
  const leadKeys = (k) =>
    Object.keys(roles.ENTRIES)
      .filter((e) => roles.entryVisible(e, [{ role: k }]))
      .sort()
  eqSet(
    'A8：教研组长 与 备课组长 的入口集合**逐项相同**（权限逐格相同是刻意的）',
    leadKeys('subject_lead'),
    leadKeys('lesson_prep_lead'),
  )
}

/* ============================================================
   第一节之二·补 · A11：🆕「行政管理」入口（2026-10-01）
   ------------------------------------------------------------
   它是**一个页面三张入口卡**（年级管理 `/grades` · 档案管理 `/grades/promote` ·
   教师管理 `/accounts`）—— 那三行原来在「我的」页上，本轮提出来单独成一页。

   🔴 它为什么必须是**单独一节**而不是塞进 A1：
      · `EXPECTED` 那张表是"6 × 14 = 84 格"的口径（`MATRIX_SHAPE` 那个分母）；
        这一项是**新入口**，进 A1 会把 84 变 90、把那一组自检值全带偏。
      · 它的判据不是"某一个新的角色数组"，而是**那三张卡各自判据的并集**
        （`roles.ts` 的 `seesAdministration()`）—— 所以这里逐档核的就是
        "并集有没有算对"，而且**必须带反向对照**（否则它可能是个恒真的摆设）。
   ============================================================ */

section('第一节之二·补 · A11：行政管理入口（/manage）—— 逐档 + 反向对照')

{
  const as = (k) => [{ role: k }]
  /*
   * 逐档（对 = 摆入口）：
   *   · super / admin —— `canManageTeachers` 直接命中（也覆盖了另外两张卡）；
   *   · office_head   —— `canManageTeachers`（建号 + 提档那两张卡）；
   *   · grade_head    —— **只**因为他看得见「年级管理」那张卡（`hasManagingRole`），
   *                     而**另外两张卡对他都不摆** —— 这一档是"并集"最容易被算错的那一格。
   */
  for (const [k, label] of [
    ['super', '超管'],
    ['admin', '教务处'],
    ['grade_head', '年级主任'],
    ['office_head', '办公室主任'],
  ]) {
    eq(`A11：${label} 看得见「行政管理」入口`, roles.entryVisible('/manage', as(k)), true)
  }
  /*
   * 逐档（错 = 不摆）：**带反向对照的另一半**（§18.3：两个坏法方向相反，各要一条）。
   *   · head_teacher / teacher —— 够不着那三张卡里的任何一张；
   *   · 教室端（`roles = []`）—— 它没有 teacher_roles 行，"没有身份"与"认不出的身份"同款。
   *   ⚠️ 校级三档 / 德育处 / 组长**也看不见**（他们看得见「年级管理」那一页，
   *      但那个入口不在这个页面上）—— 否则"并集"会被写成"`seesTeachingData` 也算"。
   */
  for (const [k, label] of [
    ['head_teacher', '班主任'],
    ['teacher', '任课教师'],
    ['principal', '校长'],
    ['vice_principal', '副校长'],
    ['principal_assistant', '校长助理'],
    ['moral_edu_head', '德育处主任'],
    ['subject_lead', '教研组长'],
    ['lesson_prep_lead', '备课组长'],
  ]) {
    eq(`A11：${label} **看不见**「行政管理」入口`, roles.entryVisible('/manage', as(k)), false)
  }
  eq('A11：教室端（roles=[]）也看不见「行政管理」', roles.entryVisible('/manage', []), false)
  /*
   * 🔴 反向对照（**必须有**）：如果哪天有人把它写成 `() => true`（或者把并集写成
   *    "谁都看得见"），上面那 8 条会一起红 —— 但"上面那 8 条真的会红吗"这件事
   *    本身没有证据。所以这里反过来钉住**并集的两半都在**：
   *      · 至少有一个身份是 true（不是恒假）；
   *      · 至少有一个教师身份是 false（不是恒真）。
   *    恒真 / 恒假两种坏法各被一条断言盖住。
   */
  const teacherRoles = ['super', 'admin', 'principal', 'vice_principal', 'principal_assistant', 'office_head', 'moral_edu_head', 'grade_head', 'subject_lead', 'lesson_prep_lead', 'head_teacher', 'teacher']
  const seen = teacherRoles.map((k) => roles.entryVisible('/manage', as(k)))
  check(
    seen.includes(true),
    'A11 反向对照：至少有一个教师身份看得见（不是"恒假"的摆设）',
    `true 的档：${teacherRoles.filter((_, i) => seen[i]).join('、') || '(一个都没有)'}`,
  )
  check(
    seen.includes(false),
    'A11 反向对照：至少有一个教师身份看不见（不是"恒真"的摆设）',
    `false 的档：${teacherRoles.filter((_, i) => !seen[i]).join('、') || '(一个都没有)'}`,
  )
  /* 并集的推导本身：`seesAdministration` 必须**恰好**等于那两条判据的或。
     ⚠️ 是**两条**不是三条：`/grades` 那一张卡的判据（`hasManagingRole || seesTeachingData`）
     与另外两张卡的判据（`canManageTeachers`）取并 —— 而 `seesTeachingData` 单独那一支
     **不算**（校级三档 / 德育处够得着 `/grades` 那一页，却够不着这个页面上的另外两张卡，
     所以他们看不见这个入口 —— 这正是 A11 上面那两条 list 钉住的事）。 */
  for (const k of teacherRoles) {
    const want = roles.hasManagingRole(as(k)) || roles.canManageTeachers(as(k))
    eq(
      `A11：${k} 那一档 == 「年级管理 or 档案管理 or 教师管理」的并集（不许另写一套）`,
      roles.seesAdministration(as(k)),
      want,
    )
  }
  /* 三张卡各自的判据**一个字没动**（这一轮只搬地方、没改判据） */
  eq('A11：`/grades` 的判据没动（超管看得见）', roles.entryVisible('/grades', as('super')), true)
  eq('A11：`/grades` 的判据没动（德育处看得见 —— 与「行政管理」入口那一档不同）', roles.entryVisible('/grades', as('moral_edu_head')), true)
  eq('A11：`/grades/promote` 的判据没动（年级主任看不见）', roles.entryVisible('/grades/promote', as('grade_head')), false)
  eq('A11：`/accounts` 的判据没动（办公室主任看得见）', roles.entryVisible('/accounts', as('office_head')), true)
}

/* ============================================================
   第一节之三 · A9：通知的**三份清单同值**（2026-09-28 第二轮 · 部门维度）
   ------------------------------------------------------------
   为什么必须有这一节（用户原话："这个是上一轮踩过的坑，别重蹈"）：
   通知那三组取值在**数据库**与**服务端**各有一份，而服务端那份是**形状校验**
   （不在里面**直接 400，在 RPC 之前**）。只改一处 = 数据库说 true、真实调用仍然 400 ——
   而且**一条报错都没有**（服务端在问数据库之前就把它拒了）。

     · `SCOPE_KINDS`   ↔ `notices.scope_kind` 的 check（§21.3.1 的 `_v2`）
     · `SENDABLE_ROLES`↔ `notice_sendable_roles()`（§21.2，🆕 本轮 7 → **8**，加回 `admin`）
     · `DEPARTMENTS`   ↔ `notice_departments()`（§21.2.2）+ 界面 `lib/departments.ts`

   ⚠️ 这里是**静态源码审计**（读文本、对值），与 `rls-checks` 那一侧互补：
   那边在真 PGlite 里量"数据库自己那两处（函数 vs check 约束）是否同值"，
   这边量"数据库 vs 服务端 vs 界面"这三份是否同值。两处都要有，少一处就有一半的路无人看守。
   ============================================================ */

section('第一节之三 · A9：通知的三份清单同值（收件范围 · 可发职位 · 部门）')

{
  const schemaSql = readRepo('supabase/schema.sql')
  const noticeTs = readApp('functions/api/notice.ts')
  const accountTs = readApp('functions/api/teacher-account.ts')
  const deptTs = readApp('src/lib/departments.ts')

  /** 一段文本里所有单引号字面量（去重 + 排序）——三组清单都靠它取 */
  const quoted = (s) =>
    [...new Set([...String(s).matchAll(/'([^']*)'/g)].map((m) => m[1]))].sort()

  /** 取 `create or replace function public.<name>(…)` 到 `$$;` 之间的函数体 */
  const fnBody = (text, name) => {
    const re = new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`,
    )
    const m = text.match(re)
    if (!m) throw new Error(`A9 锚点没找到：schema.sql 里 ${name}() 的形状变了`)
    return m[1]
  }

  /** 取 `add constraint <conname> … in ( … )` 里的值（§21.3.1 那两条换版约束） */
  const constraintValues = (text, conname) => {
    const re = new RegExp(`add constraint ${conname}\\b[\\s\\S]{0,400}?in \\(([^)]*)\\)`)
    const m = text.match(re)
    if (!m) throw new Error(`A9 锚点没找到：schema.sql 里约束 ${conname} 不见了`)
    return quoted(m[1])
  }

  /** 取 TS 里 `const NAME = [ … ] as const` 的数组 */
  const tsArray = (text, name) => {
    const re = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`)
    const m = text.match(re)
    if (!m) throw new Error(`A9 锚点没找到：${name} 的数组字面量不见了`)
    return quoted(m[1])
  }

  /* ---- ① 收件范围（scope_kind）：数据库 check ↔ 服务端 SCOPE_KINDS ---- */
  const scopeKindsDb = constraintValues(schemaSql, 'notices_scope_kind_check_v2')
  const scopeKindsTs = tsArray(noticeTs, 'SCOPE_KINDS')
  eqSet('A9：收件范围（`notices.scope_kind`）↔ 服务端 `SCOPE_KINDS` 逐字同值', scopeKindsTs, scopeKindsDb)
  eq(
    'A9：收件范围是**七种**（六种 + 🆕部门）',
    scopeKindsDb.length,
    7,
    scopeKindsDb.join('、'),
  )
  check(
    scopeKindsDb.includes('department'),
    'A9：七种里有 `department`（本轮新增的那一维）',
    scopeKindsDb.join('、'),
  )

  /* ---- ② 可发职位（notice_sendable_roles）：数据库函数 ↔ 服务端 SENDABLE_ROLES ---- */
  const rolesDb = quoted(fnBody(schemaSql, 'notice_sendable_roles'))
  const rolesTs = tsArray(noticeTs, 'SENDABLE_ROLES')
  eqSet(
    '🔴 A9：可发职位（`notice_sendable_roles()`）↔ 服务端 `SENDABLE_ROLES` 逐字同值（上一轮就栽在这里）',
    rolesTs,
    rolesDb,
  )
  eq(
    '🆕 A9：清单是**八档**（七档 + 本轮加回的 `admin`）',
    rolesDb.length,
    8,
    rolesDb.join('、'),
  )
  check(
    rolesDb.includes('admin'),
    '🔴 A9：`admin`（教务处主任）**在**清单里',
    rolesDb.join('、'),
  )
  eqSet(
    '🔴 A9：校级三档**仍然不在**清单里（"超管要给校长递话走全校"那条口径一个字没动）',
    rolesDb.filter((r) => ['principal', 'vice_principal', 'principal_assistant'].includes(r)),
    [],
  )

  /* ---- ③ 部门（notice_departments）：数据库 ↔ 服务端两处 ↔ 界面 ---- */
  const deptsDb = quoted(fnBody(schemaSql, 'notice_departments'))
  const deptsNoticeTs = tsArray(noticeTs, 'DEPARTMENTS')
  const deptsAccountTs = tsArray(accountTs, 'DEPARTMENTS')
  const deptsUi = [...new Set([...deptTs.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]))].sort()
  eq(
    'A9：部门是**四个**（办公室 / 教务处 / 总务处 / 德育处）',
    deptsDb.length,
    4,
    deptsDb.join('、'),
  )
  eqSet('🆕 A9：`notice_departments()` ↔ 服务端 `notice.ts` 的 `DEPARTMENTS`', deptsNoticeTs, deptsDb)
  eqSet(
    '🆕 A9：`notice_departments()` ↔ 服务端 `teacher-account.ts` 的 `DEPARTMENTS`',
    deptsAccountTs,
    deptsDb,
  )
  eqSet('🆕 A9：`notice_departments()` ↔ 界面 `lib/departments.ts` 的四个代码', deptsUi, deptsDb)
  /*
   * ⚠️ 锚点**不要**写成 `add constraint …`：`teacher_departments.department` 那条 check 是
   *    **建表时内联**写的（`department text not null constraint … check (…)`），
   *    没有 `add constraint` 三个字（本轮实测：写成 add 就找不到锚点）。
   */
  const deptCheck = schemaSql.match(
    /constraint teacher_departments_department_check[\s\S]{0,400}?in \(([^)]*)\)/,
  )
  if (!deptCheck) throw new Error('A9 锚点没找到：teacher_departments 那个部门 check 不见了')
  eqSet(
    '🆕 A9：`teacher_departments.department` 列上的 check 也是同一组（SQL 侧两处同值）',
    quoted(deptCheck[1]),
    deptsDb,
  )

  /* ---- ④ 收件范围 vs 写入分支：每一种 target_kind 服务端都要真的写一行 ---- */
  const kindsDb = constraintValues(schemaSql, 'notice_targets_target_kind_check_v2')
  const pushKinds = [...new Set([...noticeTs.matchAll(/push\('([a-z_]+)'/g)].map((m) => m[1]))].sort()
  eqSet(
    '🔴 A9：`notice_targets.target_kind` 的每一种值，服务端都有一条 `push(…)` 写它（多一种 / 少一种都红）',
    pushKinds,
    kindsDb,
  )
  check(
    kindsDb.includes('department'),
    'A9：`target_kind` 那一组里有 `department`（收件行按部门写）',
    kindsDb.join('、'),
  )
}

/* ============================================================
   第一节之四 · 🆕 A10：**全站公告**的纯逻辑（2026-09-28 公告轮）
   ------------------------------------------------------------
   为什么这些断言必须在这里：`lib/announcements.ts` 里那几个纯函数回答的是
   **产品语义**，而它**没有别的机器能验** ——
     · 不是布局（`shots` 量不到"哪一条该在前面"）；
     · 不是权限（`rls-checks` 管的是"拿得到拿不到"，而这里管的是"摆哪一条"）；
     · 不是类型（`tsc` 只看形状）。
   所以"排序 / 生效区间 / 顶端摆几条 / 弹几次"这四件事**只能**钉在纯函数上。

   🔴 **公告 ≠ 通知**：本节的断言与 A8/A9（通知）**一个字都不共享** ——
      两个数据模型、两张表、两个接口。⛔ 别把它们合并成"反正都是给老师看的消息"。
   ============================================================ */

section('第一节之四 · A10：全站公告（排序 · 生效区间 · 横幅摆几条 · 弹窗弹几次）')

{
  const ann = await import('../src/lib/announcements.ts')

  /** 造一条公告（默认：普通 / 不弹 / 不置顶 / 不过期） */
  const A = (patch) => ({
    id: 'a',
    title: 'T',
    body: 'B',
    level: 'normal',
    popup: 'never',
    pin: false,
    activeFrom: null,
    activeTo: null,
    createdBy: null,
    updatedBy: null,
    createdAt: 1000,
    updatedAt: 1000,
    revokedAt: null,
    emailSent: false,
    emailSentTs: null,
    emailCount: 0,
    emailFail: 0,
    ...patch,
  })
  const ids = (list) => list.map((x) => x.id).join(',')
  /**
   * ⚠️ `eq()` 是**严格相等**（`got === want`）—— 数组永远比不过。
   * 所以这里的多值断言一律先摊成字符串再比（`vals()`），
   * **不要**用 `eqSet`：它会把 `[true, true]` 去重成 `[true]`，那就不是那条断言了。
   */
  const vals = (list) => list.map((x) => String(x)).join(' / ')
  const eqVals = (label, got, want) => eq(label, vals(got), vals(want))

  /* ---- ① 唯一的那个顺序：置顶 → 等级 → 时间 ---- */
  {
    const list = [
      A({ id: 'normal-new', createdAt: 900 }),
      A({ id: 'important-old', level: 'important', createdAt: 100 }),
      A({ id: 'pinned-old', pin: true, createdAt: 10 }),
      A({ id: 'urgent-new', level: 'urgent', createdAt: 900 }),
      A({ id: 'important-new', level: 'important', createdAt: 950 }),
    ]
    eq(
      'A10：顺序 = 置顶 → 等级（紧急>重要>普通）→ 时间倒序（**只有这一个顺序**，列表/横幅/弹窗共用）',
      ids(ann.sortAnnouncements(list)),
      'pinned-old,urgent-new,important-new,important-old,normal-new',
    )
    /* 反向对照：把置顶那条的 pin 拿掉，它**必须**掉到等级那一档里去（证明上面那条不是恒真） */
    const noPin = list.map((x) => (x.id === 'pinned-old' ? { ...x, pin: false } : x))
    eq(
      'A10 反向对照：去掉 `pin` 之后它不再排第一（那条断言不是恒真）',
      ids(ann.sortAnnouncements(noPin)).startsWith('urgent-new'),
      true,
    )
  }

  /* ---- ② 生效区间：**闭区间，两端都含**；撤下与过期都只是"不再出现" ---- */
  {
    const now = 1000
    eq('A10：两端为空 = 生效（-∞ ~ +∞）', ann.isActiveAt(A({}), now), true)
    eq(
      'A10：还没到 `active_from` → 不生效（未生效的那条不该出现）',
      ann.isActiveAt(A({ activeFrom: 1001 }), now),
      false,
    )
    eq('A10：刚过 `active_to` → 不生效（过期自动消失）', ann.isActiveAt(A({ activeTo: 999 }), now), false)
    eqVals(
      'A10：**闭区间**——正好等于 `active_from` / `active_to` 的那一刻都算生效',
      [ann.isActiveAt(A({ activeFrom: 1000 }), now), ann.isActiveAt(A({ activeTo: 1000 }), now)],
      [true, true],
    )
    eq(
      'A10：撤下（`revokedAt` 非空）→ 不生效，**哪怕还在生效区间内**',
      ann.isActiveAt(A({ revokedAt: 900 }), now),
      false,
    )
    /*
     * 负向对照：未生效 / 已撤下的都不能出现在 `activeAnnouncements` 里 ——
     * 写成独立一条是为了让"过滤"与"判据"两处都被钉住（不是只钉判据）。
     */
    eq(
      'A10 反向对照：`activeAnnouncements` 把未生效 / 已撤下的都滤掉',
      ids(
        ann.activeAnnouncements(
          [A({ id: 'k' }), A({ id: 'x', activeFrom: 1001 }), A({ id: 'y', revokedAt: 1 })],
          now,
        ),
      ),
      'k',
    )
  }

  /* ---- ③ 顶部摆几条：独立横幅（紧急/置顶）+ 一条滚动条 ---- */
  {
    const now = 1000
    const list = [
      A({ id: 'p1', pin: true, level: 'normal' }),
      A({ id: 'u1', level: 'urgent' }),
      A({ id: 'n1' }),
      A({ id: 'i1', level: 'important' }),
      A({ id: 'p2', pin: true, level: 'important' }),
    ]
    const plan = ann.planAnnouncementBar(list, {
      nowMs: now,
      hiddenDay: null,
      today: '2026-09-19',
      maxBars: ann.BAR_MAX_DESKTOP,
    })
    eq(
      'A10：独立横幅 = 置顶或紧急的那几条（按同一个顺序），最多 `maxBars` 条',
      ids(plan.bars),
      /* p2 是 important 置顶、p1 是 normal 置顶 —— 两条都置顶时由**等级**决定先后 */
      'p2,p1',
    )
    eq('A10：滚动条 = 其余的生效公告（被 `maxBars` 挤出来的也在这里）', ids(plan.marquee), 'u1,i1,n1')
    eqVals(
      'A10：桌面 2 条 / 窄屏 1 条（常量本身也钉住 —— 它决定顶部吃掉多少行高）',
      [ann.BAR_MAX_DESKTOP, ann.BAR_MAX_MOBILE],
      [2, 1],
    )

    const narrow = ann.planAnnouncementBar(list, {
      nowMs: now,
      hiddenDay: null,
      today: '2026-09-19',
      maxBars: ann.BAR_MAX_MOBILE,
    })
    eqVals(
      'A10：窄屏只留 1 条独立横幅，**不丢内容**（其余全在滚动条里）',
      [ids(narrow.bars), new Set([...narrow.bars, ...narrow.marquee]).size],
      ['p2', 5],
    )

    /*
     * 「今天关过」：滚动条整条不摆，但**置顶 / 紧急无视隐藏标志**
     * （照参照项目：一个"我一定要让你看到"的东西不该被一次误点永久关掉）。
     */
    const hidden = ann.planAnnouncementBar(list, {
      nowMs: now,
      hiddenDay: '2026-09-19',
      today: '2026-09-19',
      maxBars: ann.BAR_MAX_DESKTOP,
    })
    eq('A10：今天按过「×」→ 滚动条不摆', hidden.marquee.length, 0)
    eq('A10：🔴 但**置顶 / 紧急照样在**（无视"今天关过"）', ids(hidden.bars), 'p2,p1')
    eq(
      'A10：隐藏标志只对**今天**有效（昨天关过 ≠ 今天关过）',
      ann.planAnnouncementBar(list, {
        nowMs: now,
        hiddenDay: '2026-09-18',
        today: '2026-09-19',
        maxBars: 2,
      }).marquee.length,
      3,
    )

    const closed = ann.planAnnouncementBar(list, {
      nowMs: now,
      hiddenDay: null,
      today: '2026-09-19',
      closedIds: ['p1', 'n1'],
      maxBars: 2,
    })
    eqVals(
      'A10：逐条「×」= 本次会话不再显示这一条（独立横幅与滚动条都算）',
      [ids(closed.bars), ids(closed.marquee)],
      /* p1 关掉之后**紧急的那条补位**进了独立横幅（`maxBars` 空出一格）—— 这是对的，不是丢内容 */
      ['p2,u1', 'i1'],
    )

    const prev = A({ id: 'pv', title: '预览', revokedAt: 5, activeFrom: 999999 })
    const withPrev = ann.planAnnouncementBar(list, {
      nowMs: now,
      hiddenDay: '2026-09-19',
      today: '2026-09-19',
      maxBars: 3,
      preview: prev,
    })
    check(
      withPrev.bars.some((x) => x.id === 'pv' && x.preview === true),
      'A10：🔴 预览那一条**无视生效区间 / 撤下 / "今天关过"**（超管点的是"我要看它长什么样"）',
      ids(withPrev.bars),
    )
  }

  /* ---- ④ 弹窗：`popup` 是"弹几次"的唯一字段（含紧急那一个例外） ---- */
  {
    const sn = (patch) => ({ seen: [], sessSeen: [], ...patch })
    const cases = [
      ['always：每次都弹（seen/session 都记过也照弹）', A({ id: 'x', popup: 'always' }), sn({ seen: ['x'], sessSeen: ['x'] }), true],
      ['once：本机没记过 → 弹', A({ id: 'x', popup: 'once' }), sn({}), true],
      ['once：本机记过 → 不弹', A({ id: 'x', popup: 'once' }), sn({ seen: ['x'] }), false],
      ['session：本次会话记过 → 不弹', A({ id: 'x', popup: 'session' }), sn({ sessSeen: ['x'] }), false],
      ['session：只有本机永久记录（上一次会话）→ **照弹**', A({ id: 'x', popup: 'session' }), sn({ seen: ['x'] }), true],
      ['never：不弹', A({ id: 'x', popup: 'never' }), sn({}), false],
      [
        '🔴 never + urgent：**仍然弹**（紧急公告"登录时强提醒"就落在这一个例外上）',
        A({ id: 'x', popup: 'never', level: 'urgent' }),
        sn({}),
        true,
      ],
      [
        '🔴 never + urgent：本次会话已经弹过 → 不再弹（它是 session 语义，不是 always）',
        A({ id: 'x', popup: 'never', level: 'urgent' }),
        sn({ sessSeen: ['x'] }),
        false,
      ],
      [
        'never + important：**没有例外**（等级不改变 `never` 的语义）',
        A({ id: 'x', popup: 'never', level: 'important' }),
        sn({}),
        false,
      ],
    ]
    for (const [label, item, s, want] of cases) {
      eq(`A10：${label}`, ann.shouldPopup(item, s), want)
    }
    eqVals(
      'A10：**弹出时**记 sessionStorage 的是 `session` 与"紧急的 never"',
      [
        ann.marksSessionOnShow(A({ popup: 'session' })),
        ann.marksSessionOnShow(A({ popup: 'never', level: 'urgent' })),
        ann.marksSessionOnShow(A({ popup: 'once' })),
      ],
      [true, true, false],
    )
    eqVals(
      'A10：**关掉时**才记 localStorage 的只有 `once`（`always` 一个都不记）',
      [
        ann.marksSeenOnClose(A({ popup: 'once' })),
        ann.marksSeenOnClose(A({ popup: 'always' })),
        ann.marksSeenOnClose(A({ popup: 'session' })),
      ],
      [true, false, false],
    )

    eq(
      'A10：弹窗队列 = 生效 + 该弹的那些，**按同一个顺序**（一次只弹第一个）',
      ids(
        ann.announcementPopupQueue(
          [A({ id: 'b', popup: 'once', createdAt: 1 }), A({ id: 'a', popup: 'once', createdAt: 9 })],
          { nowMs: 1000, seen: { seen: [], sessSeen: [] } },
        ),
      ),
      'a,b',
    )
    eq(
      '🔴 A10：早间欢迎 / 当天完成弹窗开着时（`suppressed`）→ 队列为空（**公告弹窗礼让**）',
      ann.announcementPopupQueue([A({ id: 'a', popup: 'always' })], {
        nowMs: 1000,
        seen: { seen: [], sessSeen: [] },
        suppressed: true,
      }).length,
      0,
    )
    eq(
      'A10：礼让**不消耗** seen —— 换个时机它还在队列里（"这一次没弹" ≠ "用户看过了"）',
      ids(
        ann.announcementPopupQueue([A({ id: 'a', popup: 'once' })], {
          nowMs: 1000,
          seen: { seen: [], sessSeen: [] },
        }),
      ),
      'a',
    )
  }

  /* ---- ⑤ 编辑时的隐私提醒 + 时间口径 ---- */
  {
    eq(
      'A10：一句正常的运维公告**不该**被提醒（"今晚 23:00–23:30 维护"里有数字，但它不是个人数据）',
      ann.announcementPrivacyHint('系统维护：今晚 23:00–23:30', '平台升级数据库，期间可能有一两次保存失败。'),
      null,
    )
    check(
      ann.announcementPrivacyHint('月考成绩', '高二(1)班张三这次考了 85 分，请各位老师注意。') !== null,
      'A10：出现成绩 / 姓名 → 给一条**软提醒**（不拦提交，理由见 `announcementPrivacyHint()`）',
      short(String(ann.announcementPrivacyHint('月考成绩', '张三 85 分')), 40),
    )
    /*
     * 🔴 这一条是**实测补上的**：第一版判据只认"分数 / 成绩"这两个**词**，
     *    而 `shots` 94 用的那句"张三这次考了 **85 分**"一个词都不沾 —— 当场红了。
     *    → 判据里加了 `\d+\s*分(?!钟)`。下面两条一对：该响的响、**不该响的不响**。
     */
    check(
      ann.announcementPrivacyHint('平台升级', '张三这次考了 85 分。') !== null,
      'A10：光有"数字 + 分"（没有"成绩"这两个字）也要认出来 —— `shots` 94 就是栽在这一句上',
      short(String(ann.announcementPrivacyHint('平台升级', '考了 85 分')), 40),
    )
    eq(
      'A10 反向对照：「大约 30 分钟」**不**算成绩（`(?!钟)` 那半个判据；软提醒也不该乱响）',
      ann.announcementPrivacyHint('系统维护', '今晚 23:00 开始，预计 30 分钟。'),
      null,
    )
    check(
      ann.announcementPrivacyHint('关于学生', '请各位老师关注一下同学们的状态。') !== null,
      'A10：出现"学生 / 同学"这类词也给提醒（换个说法就够）',
      'ok',
    )
    eq(
      'A10：时间口径一律 `beijingNow()` —— "今天"按北京时间算（这个值 `planAnnouncementBar` 用它比"今天关过"）',
      ann.todayKey(new Date('2026-09-19T20:30:00+08:00')),
      '2026-09-19',
    )
  }
}

/* ============================================================
   第二节 · A2：多身份是**并集**（顺序无关）
   ============================================================ */

section('第二节 · A2：多身份 = 并集（顺序无关，"取最高一档"是错的）')

const KEYS14 = Object.keys(EXPECTED)
const visSet = (rs) => KEYS14.filter((k) => roles.entryVisible(k, rs))

const asRoles = (...codes) => codes.map((role) => ({ role }))

{
  const head = visSet(asRoles('head_teacher'))
  const both = visSet(asRoles('teacher', 'head_teacher'))
  eqSet('A2：[teacher, head_teacher] ≡ [head_teacher]（任课教师那一档被班主任完全覆盖）', both, head)

  const sup = visSet(asRoles('super'))
  const tsup = visSet(asRoles('teacher', 'super'))
  eqSet('A2：[teacher, super] ≡ [super]', tsup, sup)

  const gh = visSet(asRoles('grade_head'))
  eqSet(
    'A2：[head_teacher, grade_head] = 两者并集（**不是**取最高一档）',
    visSet(asRoles('head_teacher', 'grade_head')),
    [...new Set([...head, ...gh])],
  )
  eqSet(
    'A2：顺序无关 —— [grade_head, head_teacher] 与反过来逐项相等',
    visSet(asRoles('grade_head', 'head_teacher')),
    visSet(asRoles('head_teacher', 'grade_head')),
  )

  /* 并集方向的反面：单靠 teacher 拿不到 /accounts，加上 admin 才拿到 */
  eq('A2：[teacher] 看不见 /accounts', roles.entryVisible('/accounts', asRoles('teacher')), false)
  eq(
    'A2：[teacher, admin] 看得见 /accounts（并集**只会变宽**）',
    roles.entryVisible('/accounts', asRoles('teacher', 'admin')),
    true,
  )
  eq(
    'A2：[grade_head, admin] 对 /accounts 是 true（并集里有一条命中就摆）',
    roles.entryVisible('/accounts', asRoles('grade_head', 'admin')),
    true,
  )
}

/* ============================================================
   第三节 · A3：空 / null / 认不出的角色代码（`roleName()` 的纪律：认不出不猜）
   ============================================================ */

section('第三节 · A3：空角色 / null / 认不出的代码 —— 不许抛异常，且只看得见"全员"那几项')

for (const [label, rs] of [
  ['[]（还没拿到身份）', []],
  ['null（没有登录态）', null],
  ['undefined', undefined],
  /*
   * ⚠️ 这一格原来用的是 `principal` —— 2026-09-28 那一轮它**变成了一个真身份**
   *    （校长），不再"认不出"。所以换成一个**真的认不出**的代码。
   *    这条断言检验的是"认不出的身份与空身份同样处理"，不是某一个具体代码。
   */
  ["[{role:'wizard'}]（字典里没有的值）", [{ role: 'wizard' }]],
]) {
  let threw = null
  let vis = null
  try {
    vis = KEYS14.filter((k) => roles.entryVisible(k, rs))
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check(threw === null, `A3：${label} 调 entryVisible 不抛异常`, threw ?? '没有抛')
  if (threw) continue
  eqSet(
    `A3：${label} 只看得见"全员"那 9 项（管理入口一个都不给）`,
    vis,
    KEYS14.filter((k) => EXPECTED[k].teacher),
  )
}

/* ============================================================
   第四节 · A4：认不出的角色不会**意外**获得管理入口（负向）
   ============================================================ */

section('第四节 · A4：认不出的角色代码不许"前缀撞上"就拿到管理入口')

for (const fake of ['admin2', 'administrator', 'superuser', 'grade_head_x']) {
  const rs = [{ role: fake }]
  eq(`A4：[{role:'${fake}'}] 对 /accounts 是 false`, roles.entryVisible('/accounts', rs), false)
  eq(`A4：[{role:'${fake}'}] 对 /admin 是 false`, roles.entryVisible('/admin', rs), false)
  eq(`A4：[{role:'${fake}'}] 对 /grades 是 false`, roles.entryVisible('/grades', rs), false)
}
/* 正面：真的 admin / super 必须是 true（别把"认不出"写成"一律 false"） */
eq("A4 正面：[{role:'admin'}] 对 /accounts 是 true", roles.entryVisible('/accounts', [{ role: 'admin' }]), true)
eq("A4 正面：[{role:'super'}] 对 /admin 是 true", roles.entryVisible('/admin', [{ role: 'super' }]), true)

/* ============================================================
   第五节 · A5/A6：PIN_KEYS 前提 + "最高管理员 ≠ 教导处"
   ============================================================ */

section('第五节 · A5/A6：胶囊三项对每个教师身份都摆（N2 的前提）· 最高管理员 ≠ 教导处')

const PIN_KEYS = ['/', '/assignments', '/settings']
for (const k of PIN_KEYS) {
  for (const r of ROLES6.filter((x) => x.key !== 'classroom')) {
    eq(`A5：${r.label} 看得见胶囊项 ${k}`, roles.entryVisible(k, r.roles), true)
  }
}

{
  const admin = [{ role: 'admin' }]
  const sup = [{ role: 'super' }]
  eq('A6：[admin] 对 /admin 是 false（教导处**不是**平台维护者）', roles.entryVisible('/admin', admin), false)
  eq('A6：[admin] 对 /accounts 是 true（教导处能建号）', roles.entryVisible('/accounts', admin), true)
  eq('A6：[super] 对 /admin 是 true', roles.entryVisible('/admin', sup), true)
  /* 判据函数本身也要区分开（防有人把 ENTRIES 里 /admin 那一格写成 canManageTeachers） */
  eq('A6：isSuperAdmin([admin]) = false', roles.isSuperAdmin(admin), false)
  eq('A6：canManageTeachers([admin]) = true', roles.canManageTeachers(admin), true)
  check(
    roles.isSuperAdmin(admin) !== roles.canManageTeachers(admin),
    'A6：这两个判据在 admin 上**不相等**（合成一个函数就是本轮最典型的错）',
    `isSuperAdmin=${roles.isSuperAdmin(admin)} / canManageTeachers=${roles.canManageTeachers(admin)}`,
  )
}

/* ============================================================
   第六节 · 🧪 DEV 测试钩子：解析规则（`?as=` / `?kind=`）
   ============================================================ */

section('第六节 · DEV 钩子：?as= 与 ?kind= 的解析规则')

{
  /*
   * ⚠️ 这里**不是在测"生产里无效"**：Node 里 `import.meta.env` 被 ts-resolve 换成了
   * `globalThis.__VITE_ENV__`（见 scripts/lib/ts-resolve.mjs），而 `DEV` 由我们自己写进那个壳里
   * —— 也就是说 A7 测的是"DEV 下钩子按规则工作"，**"生产里无效"由 D7 读 dist 产物来钉**。
   * 两者必须都有（§18.3：两个方向的坏法各要一条对照）。
   */
  globalThis.__VITE_ENV__.DEV = true
  const r1 = roles.devInjectedRoles('?as=admin')
  check(Array.isArray(r1) && r1.length === 1 && r1[0].role === 'admin', "A7：?as=admin → 注入一条 admin", JSON.stringify(r1))
  const r2 = roles.devInjectedRoles('?as=teacher,head_teacher')
  check(
    Array.isArray(r2) && r2.map((x) => x.role).join(',') === 'teacher,head_teacher',
    'A7：?as=teacher,head_teacher → 两条（多身份是常态）',
    JSON.stringify(r2),
  )
  eq('A7：没有 ?as= 时 → null（不注入）', roles.devInjectedRoles(''), null)
  eq('A7：?as=（空值）→ null，**不是**注入空数组', roles.devInjectedRoles('?as='), null)
  eq('A7：?as=,,  → null（全空）', roles.devInjectedRoles('?as=,,'), null)
  eq("A7：?kind=classroom → 'classroom'", roles.devInjectedAccountKind('?kind=classroom'), 'classroom')
  eq("A7：?kind=teacher → null（只认 classroom 这一个值）", roles.devInjectedAccountKind('?kind=teacher'), null)
  eq('A7：没有 ?kind= → null', roles.devInjectedAccountKind('?as=admin'), null)
  /*
   * 🆕 2026-09-28 公告轮：第三个 DEV 钩子 `?sync=` —— 它是"**公告条要给报错横幅让位**"
   * 那条断言唯一的前提（本地演示模式下一次云端写都不会发生，报错横幅本来永远不出现）。
   * ⚠️ 与另外两个钩子逐字同款：只在 DEV 生效、只写一个槽位、空值当"没有钩子"。
   */
  eq('A7：?sync=… → 原样给出那段文案', roles.devInjectedSyncError('?sync=保存失败：x'), '保存失败：x')
  eq('A7：?sync=（空值）→ null，**不是**注入空串', roles.devInjectedSyncError('?sync='), null)
  eq('A7：没有 ?sync= → null', roles.devInjectedSyncError('?as=admin'), null)
  /* 认不出的角色代码**原样收下**（A4 靠它测"前缀撞不上"） */
  const r3 = roles.devInjectedRoles('?as=admin2')
  check(Array.isArray(r3) && r3[0].role === 'admin2', "A7：认不出的代码原样收下（roleName 的纪律：认出不猜）", JSON.stringify(r3))
  eq('A7：注入的 admin2 拿不到 /accounts（与 A4 同一条路）', roles.entryVisible('/accounts', r3), false)

  /*
   * 🧪 **负向对照用的总闸**本身也要有断言（否则它可能"悄悄一直是开的"）：
   *   ① 设 `all` → 谁都看得见（恒真）；② 设 `none` → 谁都看不见（恒假）；③ 清掉 → 恢复。
   * ⚠️ 这一组**不是**在测"负向对照会红"（那要看整个脚本的退出码，CI 里靠显式跑一次）；
   *    它测的是"这根线头接对了、而且只在这一个函数上生效"。
   */
  globalThis.__NAV_FORCE__ = 'all'
  eq('A7：__NAV_FORCE__=all → 任课教师也"看得见" /admin（恒真的对照）', roles.entryVisible('/admin', [{ role: 'teacher' }]), true)
  globalThis.__NAV_FORCE__ = 'none'
  eq('A7：__NAV_FORCE__=none → 超管也"看不见" /（恒假的对照）', roles.entryVisible('/', [{ role: 'super' }]), false)
  delete globalThis.__NAV_FORCE__
  eq('A7：清掉总闸 → 判据恢复（超管看得见 /，任课教师看不见 /admin）', `${roles.entryVisible('/', [{ role: 'super' }])}/${roles.entryVisible('/admin', [{ role: 'teacher' }])}`, 'true/false')
  check(
    !/__NAV_FORCE__/.test(readApp('src/components/AppShell.tsx')),
    'A7：总闸**只**在 entryVisible 里生效（界面层不许再插一手）',
    'AppShell 里没有它',
  )
  /* 整个 src/ 里只准 `lib/roles.ts` 一处提到它 —— 多一处就是"第二套判据"的开始 */
  {
    const hits = []
    const walkF = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walkF(full)
        else if (/\.tsx?$/.test(e.name) && /__NAV_FORCE__/.test(readFileSync(full, 'utf8'))) {
          hits.push(full.slice(APP.length + 1).replace(/\\/g, '/'))
        }
      }
    }
    walkF(join(APP, 'src'))
    eqSet('A7：`__NAV_FORCE__` 在 src/ 里只出现一处（lib/roles.ts）', hits, ['src/lib/roles.ts'])
  }

  /* 🔴 这一条是"钩子只改显示槽位"的机器版：它**不可能**让谁多看到一行数据 */
  const hook = roles.devInjectedRoles('?as=super')
  check(
    Array.isArray(hook) &&
      hook.every((r) => !('classes' in r) && !('students' in r) && Object.keys(r).length <= 3),
    'A7：钩子返回的对象只有 role / scopeType（**没有**任何数据字段）',
    JSON.stringify(hook),
  )
  delete globalThis.__VITE_ENV__.DEV
  eq('A7：DEV 为假时 ?as=admin → null（钩子整体失效）', roles.devInjectedRoles('?as=admin'), null)
  eq('A7：DEV 为假时 ?sync=… → null（新增的那个钩子同样失效）', roles.devInjectedSyncError('?sync=x'), null)
}

/* ============================================================
   第七节 · D1：App.tsx 的路由 ↔ PAGES 登记表
   ============================================================ */

section('第七节 · D1：App.tsx 的 path="…" ↔ lib/pages.ts 的 PAGES（集合相等）')

/**
 * `按身份显示导航方案.md` §2.2 矩阵里的那 **35 条路径**（**写死的清单**）。
 *
 * 为什么写死而不是读文档：D1 要能独立于 D2 的解析器工作 ——
 * D2 的锚点一旦坏了，D2 自己会红，但 D1 不该跟着一起瞎。
 * ⚠️ 这 **37** 条**一条都不许改**（`MATRIX_SHAPE` 那个口径的实体）。
 * 🆕 2026-10-01 加 `/manage`（行政管理）—— 这一条是**真的新地址**（§2.2 里原来没有它），
 *    所以 `MATRIX_SHAPE` 也跟着从 34/145/27/32 变成 35/146/28/32。
 * 🆕 2026-10-12 加 `/manage/course`（课程管理）—— 同样是**真地址**（§2.2 里原来没有它），
 *    → **36 / 151 / 31 / 34**（三个聚合数按 §2.2 逐行读回来，不是手算）。
 * 🆕 2026-10-XX 加 `/manage/calendar`（校历）—— 同样是**真地址**，
 *    → **37 / 154 / 33 / 35**（同一套纪律：跑一次 `nav-checks` 把实测抄回来，
 *      别按"我加了什么"去推 —— 那三个数一个都不是"加一行就 +1"）。
 */
const MATRIX_PATHS = [
  '/login', '/classroom', '/', '/classes', '/classes/:id',
  '/classes/:id/import/photo', '/classes/:id/import/paste',
  '/assignments', '/assignments/new', '/assignments/:id/collect', '/assignments/:id/grade',
  '/assignments/:id/correct', '/assignments/:id/import', '/assignments/:id/grade/done',
  '/assignments/:id/stats', '/assignments/:id/call', '/calls', '/exams', '/exams/new',
  '/exams/:id/grade', '/exams/:id/stats', '/schedule', '/files', '/wrong', '/wrong/:classId',
  '/settings', '/accounts', '/grades', '/grades/:id', '/grades/:id/setup',
  '/grades/promote', '/settings/terms', '/admin', '/admin/probes', '/manage', '/manage/course',
  '/manage/calendar',
]

const appSrc = readApp('src/App.tsx')
const routes = [...appSrc.matchAll(/path="([^"]+)"/g)].map((m) => m[1])
const realRoutes = routes.filter((p) => p !== '*')

{
  check(routes.includes('*'), 'D1：`path="*"`（404 兜底页）在 App.tsx 里（它**不登记**进 PAGES）', `共 ${routes.length} 条 path`)
  const livePages = PAGES.filter((p) => p.live !== false).map((p) => p.path)
  const planned = PAGES.filter((p) => p.live === false).map((p) => p.path)
  eqSet('D1：真路由 ↔ PAGES 里 live 的那些，逐条相等', realRoutes, livePages)
  eq(
    'D1：PAGES 里 live:false（规划中）的条数 == PLANNED_PAGE_COUNT',
    planned.length,
    PLANNED_PAGE_COUNT,
  )
  /*
   * 自证（§4.4 的纪律）：**两个等式一起成立**才能防住"删掉几条规划项 + 偷偷加几条路由"
   * 互相抵消成绿。所以再把那几条 ★ 用**写死的清单**核一遍（不信 `live` 字段本身）。
   *
   * ⚠️ **`/admin` 不在这一组里**：方案 §2.2 给它带了 ★，但它的**路由其实已经落了**
   *    （超管面板第一期），只有入口是新的 —— 所以它是真路由，不是规划项。
   *    这是本轮发现的**方案自身的一处偏差**，已在两份文档里写明。
   *
   * 🆕 2026-09-30「开学准备」落地：这一组从 **6 条降到 3 条** ——
   *    `/grades` · `/grades/:id` · `/grades/:id/setup` 三条页面真的做出来了
   *    （`App.tsx` 里有了它们的路由，`PAGES` 里也去掉了 `live: false`）。
   *    ⚠️ 三条**一起**落地是故意的：只落一条会让 `PAGES` 停在中间态，
   *       而中间态里 D1 那两个等式**仍然绿** —— 那种绿什么也没证明。
   *    ⚠️ 顺带：`/grades/:id/setup` 同时**加进了上面的 `MATRIX_PATHS`**（它是新地址）。
   * 🆕 2026-09-30（P3）「学期与学年」落地：这一组从 **3 条降到 2 条** ——
   *    `/settings/terms` 的页面真的做出来了（`pages/Terms.tsx` + `App.tsx` 的路由），
   *    `PAGES` 里那一行也去掉了 `live: false`。
   *    ⚠️ 与 P6 那三条同一条教训：它**原来就在矩阵里**（§2.2 带 ★ 的那一行），
   *       所以 `MATRIX_SHAPE` / `MATRIX_SHAPE_13` 那几个数**一个都不动**。
   * 🆕 2026-10-01（P4）「提档 + 毕业删除」落地：这一组从 **2 条降到 1 条** ——
   *    `/grades/promote` 的页面真的做出来了（`pages/GradePromote.tsx` + `App.tsx` 的路由）。
   *    ⚠️ 本轮**同时改了那一行的地址**（`/grades/:id/promote` → `/grades/promote`）：
   *       提档是全校一年一次、毕业删除一次只有一个高三，做成"每个年级一页"没有意义。
   *       改地址的地方是**四处**：`MATRIX_PATHS`（这里）+ `PLANNED2`（下面）+
   *       `lib/pages.ts` + 两份矩阵文档那一行 —— 行数与 V·E·B 自检值一个都没动。
   */
  const PLANNED2 = [
    '/admin/probes',
  ]
  eqSet('D1：规划中的路径就是那 1 条（写死核对，不看 live 字段）', planned, PLANNED2)
  check(
    realRoutes.includes('/admin'),
    'D1：`/admin` 是**真路由**（★ 里唯一一个已经落地的，见注释）',
    realRoutes.includes('/admin') ? '在真路由里' : '不在了 —— 是不是有人把它删了？',
  )
  eq(
    'D1：App.tsx 真路由条数 == PAGES 总条数 − 规划条数',
    realRoutes.length,
    PAGES.length - planned.length,
  )
  /*
   * 🆕 2026-09-28：这一条原来比的是 `PAGES.length === MATRIX_SHAPE.rows`。
   * 加了通知两行之后两个数**不再相等**（PAGES 36 / 矩阵 34），所以拆成两句 ——
   * ⚠️ **不是把断言删掉**，而是让它比原来更紧：
   *   ① `PAGES` 里必须**真的有那 34 行矩阵行**（按路径 join 核，不信条数）；
   *   ② 多出来的必须**恰好是通知那两行**。
   * 于是"偷偷加一条路由没登记"和"矩阵少了一行"两种坏法**都还抓得住**。
   */
  eq(
    'D1：PAGES 里在矩阵里的行数 == 矩阵行数（' + MATRIX_SHAPE.rows + '）',
    PAGES.filter((p) => MATRIX_PATHS.includes(p.path)).length,
    MATRIX_SHAPE.rows,
    `MATRIX_PATHS=${MATRIX_PATHS.length} 条 · PAGES=${PAGES.length} 条`,
  )
  eqSet(
    'D1：PAGES 里**不在** `按身份显示导航方案.md` §2.2 矩阵里的路径 —— 恰好是通知那两行',
    PAGES.map((p) => p.path).filter((p) => !MATRIX_PATHS.includes(p)),
    ['/notices', '/notices/new'],
  )
}

/* ============================================================
   第八节 · D2：方案 §2.2 的矩阵路径 ↔ PAGES（**新增页面时的纪律**的机器版）
   ============================================================ */

section('第八节 · D2：方案 §2.2 矩阵（第二个单元格）↔ PAGES — 37 行 / V154 / E33 / B35')

function parseMatrix() {
  const doc = readRepo('按身份显示导航方案.md')
  const at = doc.indexOf('### 2.2')
  if (at < 0) throw new Error('找不到 `### 2.2`（锚点变了）')
  /*
   * 🔴 锚点必须**先切后取**（§18.3 那个"锚点跨过中间全部内容、把 schema 咬掉一大块
   * 而 `if (!m) throw` 抓不到"的坑）：从 `### 2.2` 切到**下一个 `###`** 为止，
   * 再在**这一段里**找表行。别用贪婪的 `[\s\S]*?`。
   */
  const rest = doc.slice(at + 4)
  const end = rest.indexOf('###')
  if (end < 0) throw new Error('`### 2.2` 之后找不到下一个 `###`（锚点咬到文件末尾了）')
  const sec = rest.slice(0, end)
  const lines = sec.split('\n').filter((l) => l.startsWith('|'))
  if (lines.length < 30) throw new Error(`§2.2 里只解析到 ${lines.length} 行表行 —— 锚点多半错了`)
  const paths = []
  const cells = []
  const perRole = Array.from({ length: 6 }, () => ({ v: 0, e: 0, b: 0 }))
  const unknown = []
  for (const line of lines) {
    /*
     * 单元格：`| a | b | c |…|` 拆开之后**首尾都是空串**（首尾各一个 `|`），
     * 去掉末尾那一个空串之后剩 10 格：
     *   [0] 序号 `#` · [1] 路由 · [2] 入口在哪 · [3] 路由(有/★新) · [4..9] 六个身份
     * ⚠️ 前 4 格里**只有 [1] 是路径** —— 方案 §2.1 特意为 D2 留的口径（"只认第二个单元格"）。
     */
    const raw = line
      .split('|')
      .slice(1)
      .map((c) => c.trim())
      .filter((c, i, arr) => !(i === arr.length - 1 && c === ''))
    if (raw.length !== 10) continue // 表头 / `| --- |` 分隔行（它们第二格里没有反引号）
    const m = raw[1].match(/`([^`]+)`/)
    if (!m || !m[1].startsWith('/')) continue // 只留以 `/` 开头的（`*` 那一行根本不在表里）
    paths.push(m[1])
    const six = raw.slice(4).map((c) => c.replace(/\*/g, '').trim().charAt(0))
    if (six.length !== 6) unknown.push(`${m[1]}:${six.length}格`)
    six.forEach((t, i) => {
      if (!perRole[i]) return
      if (t === 'V') perRole[i].v++
      else if (t === 'E') perRole[i].e++
      else if (t === 'B') perRole[i].b++
      else unknown.push(`${m[1]}:${JSON.stringify(t)}`)
    })
    cells.push(six)
  }
  const sum = perRole.reduce(
    (a, x) => ({ v: a.v + x.v, e: a.e + x.e, b: a.b + x.b }),
    { v: 0, e: 0, b: 0 },
  )
  return { paths, perRole, sum, cells, unknown }
}

d2Matrix: {
  /*
   * 🆕 2026-10-02（E1 CI 轮）：这份方案**不进 git**（根目录 *.md 全被 .gitignore 拦下），
   * CI 的 checkout 里没有它。没结论必须灰、绝不红：文档不在就打印说明、整节跳过
   * （与 exam-checks 三之二那份本机 xlsx 同一模式）；文档在的地方下面一条断言都不变。
   */
  if (!existsSync(join(REPO, '按身份显示导航方案.md'))) {
    console.log('  ⏭ 按身份显示导航方案.md 不在（它不进 git，只在维护者机器上）—— D2 整节跳过')
    break d2Matrix
  }
  let mx = null
  let boom = null
  try {
    mx = parseMatrix()
  } catch (e) {
    boom = e instanceof Error ? e.message : String(e)
  }
  check(boom === null, 'D2：§2.2 的矩阵解析得出来（锚点自证）', boom ?? '解析成功')
  if (mx) {
    check(mx.unknown.length === 0, 'D2：每一格的取值只能是 V / E / B（解析完自证）', mx.unknown.join('、') || '没有认不出的格')
    /*
     * 🔴 **先自证条数与形状，再逐条比**（§4.4 原文：条数不对就直接报"锚点解析错了"，
     * 不许静默通过）。`MATRIX_SHAPE` 是方案 §2.2 "规模感"那张表的自检值
     * —— 🆕 2026-10-XX 加了 `/manage/calendar` 那一行之后是 **37 / 154 / 33 / 35**。
     */
    eq('D2 自证：矩阵行数', mx.paths.length, MATRIX_SHAPE.rows)
    eq('D2 自证：V 格数', mx.sum.v, MATRIX_SHAPE.v)
    eq('D2 自证：E 格数', mx.sum.e, MATRIX_SHAPE.e)
    eq('D2 自证：B 格数', mx.sum.b, MATRIX_SHAPE.b)
    eq('D2 自证：V+E+B == 行数 × 6', mx.sum.v + mx.sum.e + mx.sum.b, MATRIX_SHAPE.rows * 6)
    eqSet(
      'D2：矩阵路径 ↔ PAGES 里那 37 条（通知两行不在 §2.2 的矩阵里，见 D9）',
      mx.paths,
      PAGES.map((p) => p.path).filter((p) => MATRIX_PATHS.includes(p)),
    )
    /* 逐角色的小计也核（方案 §2.2 里那张"每个角色 V/E/B"的表） */
    const ROLE_SUM = [
      { v: 36, e: 1, b: 0 },
      { v: 34, e: 3, b: 0 },
      { v: 32, e: 5, b: 0 },
      { v: 25, e: 12, b: 0 },
      { v: 25, e: 12, b: 0 },
      { v: 2, e: 0, b: 35 },
    ]
    ROLES6.forEach((r, i) => {
      const g = mx.perRole[i]
      const w = ROLE_SUM[i]
      check(
        g.v === w.v && g.e === w.e && g.b === w.b,
        `D2：${r.label} 那一列的小计`,
        `V${g.v} / E${g.e} / B${g.b}`,
        `期望 V${w.v} / E${w.e} / B${w.b}`,
      )
    })
  /*
   * ⚠️ 矩阵里的格子值 vs `ENTRIES` 真算出来的值 —— 这是把"文档说的"与"代码做的"
   * 接起来的那一根线。两个数组**不能按下标配对**（PAGES 是按"归属"分组的，
   * 方案 §2.2 是按路由族排的；`/files` 在 PAGES 里排在 `/accounts` 前面，矩阵里是 #23 vs #27）
   * → **按路径 join**（`pathEntry` 那张表），不是 `PAGES[i]`。
   *
   * ⚠️ **只比那 37 行**（`MATRIX_PATHS`）：`PAGES` 现在还多了通知那两行，
   *    而**那两行不在 §2.2 的矩阵里**（它们是 `管理架构与角色权限方案.md` §4.2 的第 18 / 19 行）。
   *    上一版这里是按 `mx.paths[i]` 与 `PAGES.map(...)` 直接 `eqSet` 的，所以加了两行就红了 ——
   *    那正是它该有的样子（"每加一条路由都要登记"的机器版），这里把**范围**说清楚。
   *
   * 🔴 判据必须是 **`roles.entryVisible(key, r.roles)`（真跑一遍表）**，
   *    **不是**本文件上面那张 `EXPECTED`（那是 A1 的期望表）。
   *    第一版写成了后者 —— 于是"有人把 `/accounts` 的判据改成 `isSuperAdmin`"
   *    这种真实的取舍错误**这一条抓不到**（A1 会红，但文档与代码的咬合悄悄断了）。
   *    负向对照 N-c 就是拿这个抓出来的。
   *
   * 只比**教师身份那五列**：
   *   · 教室端那一列是 `App.tsx` 的 `accountKind` 一支在管（见 A1 的注释），
   *     入口表按 M2 看不见 `accountKind`，拿它比会得到 32 条假的"不一致"；
   *   · 剩下的不一致**就是真问题**，会立刻红（本轮它抓到过真实矛盾：
   *     `/settings/terms` 那一行与方案 §七 待确认 ④ 的结论相反，见报告）。
   */
    const pathEntry = new Map(PAGES.map((p) => [p.path, p.entry]))
    for (let i = 0; i < mx.paths.length; i++) {
      const path = mx.paths[i]
      const key = pathEntry.get(path)
      check(
        pathEntry.has(path),
        `D2：矩阵里的 ${path} 在 PAGES 里登记过（按路径 join，不是按下标）`,
        pathEntry.has(path) ? `入口 key = ${key ?? '(页内页，没有入口)'}` : 'PAGES 里没有这条',
      )
      if (!key) continue
      ROLES6.forEach((r, j) => {
        if (r.key === 'classroom') return
        const computed = roles.entryVisible(key, r.roles)
        const cell = mx.cells[i][j]
        const want = computed ? 'V' : 'E'
        check(
          cell === want,
          `D2：矩阵 ${path} × ${r.label} 的格子 == ENTRIES **真算出来**的值`,
          `矩阵写 ${cell}`,
          `ENTRIES 说 ${want}（${key} → ${r.key}）`,
        )
      })
    }
  }
}

/* ============================================================
   🆕 第八节之二 · D9：`管理架构与角色权限方案.md` §4.2 的 **13 列矩阵**
   ------------------------------------------------------------
   这是本轮新增的**第二组分母**（方案 §四.0 的 ②）：**37 行 × 13 列 = 481 格**
    （其中 16 格是办公室主任那一列的 `—` 不适用；🆕 2026-10-01 加了 `/manage` 那一行）。

   🔴 它与 D2 **不是同一张表**，所以**分开解析、分开断言**：
      · D2 读 `按身份显示导航方案.md` §2.2（**35 × 6 = 210**）→ `MATRIX_SHAPE`
      · D9 读 `管理架构与角色权限方案.md` §4.2（**37 × 13 = 481**）→ `MATRIX_SHAPE_13`
      **两个口径不许互相推导**（列数不同，"相减"出来的数没有意义 —— 方案 §4.0 原文）。

   🔴 **D9 的核心一条**：把矩阵里**每一格**与 `ENTRIES` **真算出来**的值对上。
      这正是"文档说的"与"代码做的"之间那根线（D2 里同样有一根）——
      没有它，13 列那 481 格就只是文档里的一堆字母。
   ============================================================ */

section('第八节之二 · D9：管理架构方案 §4.2 的 13 列矩阵（39 行 / V355 / E99 / B37 / —16）')

/**
 * 解析 `管理架构与角色权限方案.md` §4.2 的矩阵。
 *
 * 锚点纪律与 D2 逐字相同（**先切后取**，别用贪婪正则）：
 * 从 `### 4.2 ` 切到下一个 `###` 为止，再在这一段里找表行。
 */
function parseMatrix13() {
  const doc = readRepo('管理架构与角色权限方案.md')
  const at = doc.indexOf('### 4.2 ')
  if (at < 0) throw new Error('找不到 `### 4.2 `（锚点变了）')
  const rest = doc.slice(at + 4)
  const end = rest.indexOf('###')
  if (end < 0) throw new Error('`### 4.2` 之后找不到下一个 `###`（锚点咬到文件末尾了）')
  const sec = rest.slice(0, end)
  const lines = sec.split('\n').filter((l) => l.startsWith('|'))
  if (lines.length < 36) throw new Error(`§4.2 里只解析到 ${lines.length} 行表行 —— 锚点多半错了`)

  /** 表头那一行：`| # | 入口 | 路由 | 超 | 教 | … |` —— 拿它核列序（缩写） */
  const headerLine = lines.find((l) => l.includes('| 入口 |'))
  const headerCells = headerLine
    ? headerLine.split('|').slice(1).map((c) => c.trim()).filter((c, i, a) => !(i === a.length - 1 && c === ''))
    : []
  const heads = headerCells.slice(3) // 去掉 `#` / `入口` / `路由` 三格

  const paths = []
  const cells = []
  const perCol = Array.from({ length: 13 }, () => ({ v: 0, e: 0, b: 0, x: 0 }))
  const unknown = []
  for (const line of lines) {
    const raw = line
      .split('|')
      .slice(1)
      .map((c) => c.trim())
      .filter((c, i, arr) => !(i === arr.length - 1 && c === ''))
    // 13 列 + 3 格（# / 入口 / 路由）= 16 格；表头与 `| --- |` 分隔行靠"第三格是 `/` 开头的路径"排掉
    if (raw.length !== 16) continue
    const m = raw[2].match(/`(\/[^`]*)`/)
    /*
     * 🔴 判据是"**反引号里是一条路径**"：`/` 后面必须跟字母、数字或 `*`，
     *    或者整格就是一个 `/`（首页那一行）。
     *    光写"以 `/` 开头"**不够** —— `| --- | --- | --- |` 那一行的第三个单元格是 `---`，
     *    而表头行里也有别的内容；不收紧的话会多算 2 行，而**那 2 行的 26 格
     *    会把整张表的小计全部带偏**（本轮实测：收紧前 office_head 那列被算成 V19/—16）。
     */
    if (!m || !/^(\/[A-Za-z0-9*]|\/$)/.test(m[1])) continue
    paths.push(m[1])
    /*
     * 格子取值：`V` / `E` / `B` / `—`（不适用）。
     * ⚠️ 文档里带装饰写法（`**V**` / `V【新】` / `V★待拍板` / `—\*`）——
     *    统一按"去掉 `*` 后取第一个字符"来读，读不出 V/E/B/— 就记进 `unknown`
     *    （**不许静默通过**：那是"锚点解析错了"的唯一信号）。
     */
    const thirteen = raw.slice(3).map((c) => c.replace(/\*/g, '').trim())
    if (thirteen.length !== 13) unknown.push(`${m[1]}:${thirteen.length}格`)
    thirteen.forEach((t, i) => {
      if (!perCol[i]) return
      const ch = t.charAt(0)
      if (ch === 'V') perCol[i].v++
      else if (ch === 'E') perCol[i].e++
      else if (ch === 'B') perCol[i].b++
      else if (t.startsWith('—')) perCol[i].x++
      else unknown.push(`${m[1]}#${i + 1}:${JSON.stringify(t)}`)
    })
    cells.push(thirteen.map((t) => t.charAt(0)))
  }
  const sum = perCol.reduce(
    (a, c) => ({ v: a.v + c.v, e: a.e + c.e, b: a.b + c.b, x: a.x + c.x }),
    { v: 0, e: 0, b: 0, x: 0 },
  )
  return { paths, cells, perCol, sum, heads, unknown }
}

d9Matrix: {
  /*
   * 🆕 2026-10-02（E1 CI 轮）：这份方案**不进 git**（同 D2 的口径）—— CI 的 checkout
   * 里没有它。文档不在就打印说明、整节跳过（灰），绝不红；文档在的地方一条断言都不变。
   */
  if (!existsSync(join(REPO, '管理架构与角色权限方案.md'))) {
    console.log('  ⏭ 管理架构与角色权限方案.md 不在（它不进 git，只在维护者机器上）—— D9 整节跳过')
    break d9Matrix
  }
  let mx = null
  let boom = null
  try {
    mx = parseMatrix13()
  } catch (e) {
    boom = e instanceof Error ? e.message : String(e)
  }
  check(boom === null, 'D9：§4.2 的 13 列矩阵解析得出来（锚点自证）', boom ?? '解析成功')
  if (mx) {
    check(mx.unknown.length === 0, 'D9：每一格的取值只能是 V / E / B / —（解析完自证）', mx.unknown.join('、') || '没有认不出的格')
    /* 列序自证：表头的 13 个缩写必须与 `COLS13` 一一对应（改了列序 = 13 列全配错人） */
    eqSet('D9：§4.2 表头的 13 个缩写 == 方案的口径（超教校副助办德级教组备组班任室）', mx.heads, HEAD13)
    /* 形状自证：37 / 348 / 74 / 34 / 16 */
    eq('D9 自证：矩阵行数', mx.paths.length, MATRIX_SHAPE_13.rows)
    eq('D9 自证：V 格数', mx.sum.v, MATRIX_SHAPE_13.v)
    eq('D9 自证：E 格数', mx.sum.e, MATRIX_SHAPE_13.e)
    eq('D9 自证：B 格数', mx.sum.b, MATRIX_SHAPE_13.b)
    eq('D9 自证：`—` 不适用格数（办公室主任那一列）', mx.sum.x, MATRIX_SHAPE_13.excluded)
    eq(
      'D9 自证：V+E+B+— == 行数 × 13',
      mx.sum.v + mx.sum.e + mx.sum.b + mx.sum.x,
      MATRIX_SHAPE_13.rows * 13,
    )
    /* 逐列小计（方案 §4.1 那张表）—— 下标与 `MATRIX_SHAPE_13.columns` 一一对应 */
    COLS13.forEach((r, i) => {
      const g = mx.perCol[i]
      const w = MATRIX_SHAPE_13.perColumn[i]
      check(
        g.v === w.v && g.e === w.e && g.b === w.b && g.x === w.x,
        `D9：${r.label} 那一列的小计`,
        `V${g.v} / E${g.e} / B${g.b} / —${g.x}`,
        `期望 V${w.v} / E${w.e} / B${w.b} / —${w.x}`,
      )
    })
    /*
     * 37 行 = 原来那 **35** 行（§2.2 那一份，含 🆕 `/manage`）+ 通知那两行。
     * ⚠️ 这一条是"**不推翻那 210 格**"的机器版：这 35 条路径必须与 D1 的写死清单
     *    **逐项相等**（顺序可以不同，集合必须相等）。
     *
     * 🆕 2026-10-01：`/manage` 那一行是**两张表一起加**的（§2.2 与 §4.2）——
     *    所以这里的 `MATRIX_PATHS` 也跟着多一条。⚠️ 别只加一处：`MATRIX_PATHS`
     *    是 D1/D2/D9 三处共用的那一份写死清单，改了它三处一起动（这正是它的用途）。
     * 🆕 2026-10-XX：校历（`/manage/calendar`）同样**两张表一起加** ——
     *    `MATRIX_PATHS` 又多一条。§4.2 那 13 列矩阵现在有 **39 行**（37 条矩阵路径 + 通知两行）。
     */
    eqSet('D9：13 列矩阵的行 ↔ §2.2 的 37 条路径 + 通知两行', mx.paths, [
      ...MATRIX_PATHS,
      '/notices',
      '/notices/new',
    ])
    eqSet('D9：13 列矩阵的路径 ↔ PAGES 的路径（每加一条路由都要登记）', mx.paths, PAGES.map((p) => p.path))

    /*
     * 🔴 **逐格核对**：矩阵里写的字母 == `ENTRIES` 真算出来的值。
     *   · `V` ← `entryVisible(key, roles)` 为真
     *   · `E` ← 该页对这个身份**存在但入口不摆**（入口 key 非空而判据为假）
     *   · `B` / `—` ← 两者都**不是入口表能表达的**（`B` 是 `App.tsx` 的教室端那一支；
     *     `—` 是"这一页对这个身份根本不存在"）→ 它们**只对教室端与办公室主任成立**，
     *     而这两位在入口表里都是"没有可摆的入口"，所以这里只核 V / E 两态。
     *
     * 🔴 两个记号的分工（这一条**踩过一次**，写下来）：
     *    · `if (!key) continue` 是**错的** —— `PAGES` 里 **20 条是"页内页"**（`entry: null`），
     *      它们**没有入口 key 可判**，但**不等于这一行不用核**：它们的 13 格里
     *      绝大多数写着 `E`（对某个身份这一页不存在入口），而那一格恰恰要核。
     *      第一版就是这么写的 —— 结果只比了 208/468 格，**而数字对账那几条还是绿的**
     *      （因为聚合数字是解析器算的，与这个循环无关）。
     *      → 所以现在的写法是：**先判记号（B / — 直接过），再取 key；没有 key 就按
     *         "这一页没有入口"核对那一格只能是 `E`**。
     *    · `B` / `—` 只允许出现在教室端 / 办公室主任那两列 —— 别的身份用了就是写错了。
     *
     * ⚠️ `PENDING_CELLS`：**已知的、有意的口径冲突**，只允许写在这里并逐条注明理由。
     *    这一格不是"实现写错了"、也不是"文档写错了"，而是**两份文档自己就没说拢**
     *    （方案 §四.3 第 34 行原文："⚠️ **两处口径不一致**（矩阵 V vs 正文 E）"）。
     *    落地按**现行实现**（V）落，冲突原样报出来等拍板 —— 见方案 §七 Q6。
     *    ⛔ 别把新出现的"不一致"往这张表里塞：它的唯一用途是**记录已经写在文档里的**那一处。
     */
    const PENDING_CELLS = new Map([
      [
        '/settings/terms|grade_head',
        '方案 §四.3 第 34 行自己记着"矩阵 E vs 正文 V"两处口径不一致（§七 Q6 待拍板）；落地按现行实现 V',
      ],
    ])
    const pathEntry = new Map(PAGES.map((p) => [p.path, p.entry]))
    let compared = 0
    let pending = 0
    for (let i = 0; i < mx.paths.length; i++) {
      const path = mx.paths[i]
      const inPages = pathEntry.has(path)
      const key = pathEntry.get(path) ?? null
      check(
        inPages,
        `D9：矩阵里的 ${path} 在 PAGES 里登记过`,
        inPages ? `入口 key = ${key ?? '(页内页，没有入口)'}` : 'PAGES 里没有这条',
      )
      if (!inPages) continue
      COLS13.forEach((r, j) => {
        compared++
        const cell = mx.cells[i][j]
        /* `B` / `—` 不在入口表的表达范围内（见上）—— 只对"教室端 + 办公室主任"允许 */
        if (cell === 'B' || cell === '—') {
          check(
            r.key === 'classroom' || r.key === 'office_head',
            `D9：矩阵 ${path} × ${r.label} 用了 ${cell} —— 只有教室端 / 办公室主任能用这两个记号`,
            `矩阵写 ${cell}`,
            '别的身份只用 V / E（B 是安全判断、— 是功能判断，两者都靠页面/数据库，不靠入口表）',
          )
          return
        }
        /*
         * **页内页（`entry: null`）与独立页在入口层"说不了话"，所以只对账、不逐格断言。**
         *
         * 为什么它们**不能**按 `entryVisible` 核：
         *   · **独立页**（`/login`、`/classroom`）：根本不在 `AppShell` 里 ——
         *     `/login` 对所有身份都是 `V`（`Guard` 的出口），`/classroom` 只有教室端是 `V`
         *     （其余是 `E`：教师账号进去是"预览"）。这两句都由 `App.tsx` 的路由结构决定，
         *     `ENTRIES` 里没有它们的位置。
         *   · **页内页**（`/classes/:id`、`/assignments/new` …）：`PAGES` 里 `entry: null`
         *     （"只能从父页点进来"），所以"这个身份有没有这个入口"**在入口层无从表达** ——
         *     矩阵里那些格说的是"**进不进得去这一页**"（`V`）或"**藏入口就够**"（`E`），
         *     而进不进得去由**页面自己的守卫与 RLS** 决定。
         *   ⚠️ 我第一版给页内页写了一条"必须是 `E`"的断言 —— **那是错的**：
         *     矩阵里 `/login` 对 12 个身份是 `V`、`/classroom` 对教室端是 `V`，
         *     它们**本来就是 `V`**（那两页确实谁都能打开）。**照抄矩阵、按同一套规则计数**，
         *     不额外发明一条规则。
         *
         * 所以这里的处置与上面的 `B` / `—` 相同：**记账**（进 `compared`），不逐格判。
         */
        if (key === null) return
        const computed = roles.entryVisible(key, r.roles)
        const want = computed ? 'V' : 'E'
        if (PENDING_CELLS.has(`${path}|${r.key}`)) {
          compared--
          pending++
          check(
            cell !== want,
            `D9：${path} × ${r.label} 那一格**确实还挂着**口径冲突（冲突解决了就该把 PENDING_CELLS 里那条删掉）`,
            `矩阵写 ${cell} / ENTRIES 说 ${want}`,
            PENDING_CELLS.get(`${path}|${r.key}`),
          )
          return
        }
        check(
          cell === want,
          `D9：矩阵 ${path} × ${r.label} 的格子 == ENTRIES **真算出来**的值`,
          `矩阵写 ${cell}`,
          `ENTRIES 说 ${want}（${key} → ${r.key}）`,
        )
      })
    }
    /* 自证：逐格比对的格数 + 挂账的格数 == 行数 × 13（少一格都说明解析漏了行） */
    eq(
      'D9 自证：逐格比对 + 挂账的格数 == 行数 × 13（不是"比了几格就算几格"）',
      compared + pending,
      MATRIX_SHAPE_13.rows * 13,
      `其中 ${compared} 格真比过、${pending} 格挂着已知冲突、${mx.sum.b + mx.sum.x} 格是 B / —（由页面与数据库负责）`,
    )
  }
}

/* ============================================================
   第九节 · D3/D4/D5：入口判据不许各写一套（M1–M3 的机器版）
   ============================================================ */

section('第九节 · D3/D4/D5：判据白名单 · myRoles 读取点白名单 · 数据行不许过这张表')

{
  const src = readApp('src/lib/roles.ts')
  const at = src.indexOf('export const ENTRIES')
  check(at > 0, 'D3：找得到 `export const ENTRIES`（锚点自证）', `偏移 ${at}`)
  if (at > 0) {
    /* 用大括号配平切出**表的整个对象字面量**（不能用 indexOf('\n}')：
       每个规则自己也有一个 `}`，那样只会切到第一条） */
    const open = src.indexOf('{', at)
    let depth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    check(close > open, 'D3：ENTRIES 的对象字面量配平（锚点自证）', `从 ${open} 到 ${close}（${close - open} 字符）`)
    const body = src.slice(open, close)
    const rules = [...body.matchAll(/visibleFor:\s*([^,\n}]+)/g)].map((m) => m[1].trim())
    const keys = [...body.matchAll(/^\s*'([^']+)':\s*\{/gm)].map((m) => m[1])
    eq('D3：ENTRIES 的入口条数', keys.length, Object.keys(roles.ENTRIES).length)
    eqSet('D3：ENTRIES 里的 key ↔ 运行时对象的 key', keys, Object.keys(roles.ENTRIES))
    eq('D3：每个入口都写得出 visibleFor 的值（正则自证）', rules.length, keys.length)
    /*
     * 白名单：只准 `() => true`（全员）或**本文件导出的判据函数名**。
     * ⛔ 不许就地写 `(roles) => roles.some(…)`：那正是"每个入口一套判据"的开始。
     * 判据：每个 `visibleFor:` 后面的值**含 `=>` 的就是就地写的**。
     *
     * 🆕 2026-09-28：`(roles) => hasManagingRole(roles) || seesTeachingData(roles)` 这一处
     *    **是刻意保留的内联写法**，理由写在这里（不是"忘了提取成函数"）：
     *    `/grades` 那一格要表达的是"**在原来那个判据之上追加一支**"——
     *    它必须让"改动只发生在这一行"这件事**在源码里一眼看得见**。
     *    抽成一个 `canSeeGrades()` 反而会把"原有 34 行一格没改"这条纪律藏进另一个文件。
     *    ⚠️ 它仍然合 M1/M2（只读 `roles` 一个参数、只返回 boolean），且**两个函数都在
     *    lib/roles.ts 里**（不是就地写 `roles.some(...)`）。
     */
    /*
     * 🆕 2026-10-01 加 `seesAdministration`（`/manage` 那一格用的）——
     *    它**不是**第 7 个角色判据，而是**已有那几条的并集**（写在 `lib/roles.ts` 里、
     *    带逐条推导的注释），所以这里放行它，而不是让 `ENTRIES` 里就地写 `||`。
     */
    const ALLOWED = ['isSuperAdmin', 'canManageTeachers', 'canAssignRoles', 'hasManagingRole', 'canPublishNotice', 'seesTeachingData', 'seesAdministration']
    const inline = rules.filter((b) => b.includes('=>'))
    eqSet(
      'D3：就地写的判据只有两处 —— `() => true`（全员）与 `/grades` 那一行的"追加一支"',
      inline,
      ['() => true', '(roles) => hasManagingRole(roles) || seesTeachingData(roles)'],
    )
    const badNames = rules.filter((b) => !b.includes('=>') && !ALLOWED.includes(b))
    eqSet('D3：判据函数引用的名字全在白名单里', badNames, [])
    eq(
      'D3：白名单函数都是 lib/roles.ts 真的导出的（不是拼错的名字）',
      ALLOWED.filter((n) => typeof roles[n] !== 'function').join('、'),
      '',
    )
    const refs = rules.filter((b) => !b.includes('=>'))
    check(
      refs.length >= 4,
      'D3：至少 4 个入口用的是判据函数（不是"全都是 () => true"这种退化写法）',
      `${refs.length} 个引用：${refs.join('、')}`,
    )
    /* M1：返回值只能是 boolean —— 拿真函数逐个量一遍 */
    for (const [k, rule] of Object.entries(roles.ENTRIES)) {
      const out = rule.visibleFor([{ role: 'teacher' }])
      eq(`D3(M1)：ENTRIES['${k}'].visibleFor 返回 boolean`, typeof out, 'boolean')
      check(
        typeof rule.label === 'string' && rule.label.length > 0,
        `D3：ENTRIES['${k}'] 有显示名（登记表要能被人读）`,
        JSON.stringify(rule.label),
      )
      eq(`D3(M2)：ENTRIES['${k}'].visibleFor 只接受一个参数`, rule.visibleFor.length <= 1, true)
    }
  }
}

{
  /*
   * D4：**谁在替"入口"做决定？** 合法的地方只有一处：`lib/roles.ts` 的 `ENTRIES`。
   * 别处出现 `myRoles` / `ROLE_NAME` / `roleName(` 就是**可疑点**：
   *   · 显示用途（标签文案 / 问候语）→ 白名单，允许
   *   · 任何别的新用途 → 报出来让人看一眼（"这是显示还是判据？"）
   *
   * ⚠️ 白名单**今天有 15 个**（🆕 2026-10-01 加了 `src/pages/Administration.tsx`），
   *    比方案 §4.2 里写的 4 个多十一个 —— 每一个都写清了理由，
   *    而且四个都是"这一轮/上一轮新出现的"，所以**这一条审计第一次跑就抓到了东西**
   *    （这正是它该有的样子，别把清单改成"永远为绿"）：
   *      · `src/pages/Admin.tsx`    上一轮（超管面板第一期）落的文件：`isSuperAdmin(myRoles)` 只决定摆不摆
   *      · `src/App.tsx`            本轮的 DEV 钩子（把 `?as=` 注进 `myRoles`，生产构建里被摇掉）
   *      · `src/data/store.ts`      `myRoles` 这个**槽位的定义处**（state + hydrate/signOut 写入）
   *      · `src/lib/roles.ts`       入口表与判据的**定义处**
   *    加一个就要在这里加一行并写理由。
   */
    const ROLE_READERS = new Map([
      ['src/pages/Settings.tsx', '身份卡 + 我的身份（显示）+ 「平台运维」那一行读 entryVisible'],
      [
        'src/pages/Administration.tsx',
        '🆕 行政管理（2026-10-01）：**三张入口卡各自的显隐**（`entryVisible(卡的 key, myRoles)`）—— ' +
          '这一页**自己不查权限**（它只是入口合集），判据全在 `lib/roles.ts` 那张表里；' +
          '**不读任何数据行**（那三页的读写闸门由服务端与 RLS 判）',
      ],
      ['src/pages/TeacherAccounts.tsx', '身份区按钮显隐（canAssignRoles）+ 身份名文案'],
      [
        'src/pages/ManageCourse.tsx',
        '🆕 课程管理（2026-10-12，第 3 轮）：**整段摆不摆**那一个判据（`hasManagingRole(myRoles)`）—— ' +
          '与 `/manage` 那条**同一个既有函数**（不新造判据、不就地写角色数组）；' +
          '手打 URL 进来而够不着时给一句说明。**班级粒度**能不能改仍由服务端回的布尔判（`canManageSchedule()`）',
      ],
      ['src/components/AppShell.tsx', '当前身份标签（显示）+ NAV 过滤（**唯一一处真·入口判据**）+ 🆕通知未读红点'],
      [
        'src/pages/Workbench.tsx',
        '问候语里的身份标签（显示）+ 「最新通知」那一块的入口显隐 + ' +
          '🆕**快捷操作按身份分格**（2026-10-XX）：`isSuperAdmin` / `canAssignRoles` / ' +
          '`hasManagingRole` / `canManageTeachers` / `seesTeachingData` / `canEditClassFor` ' +
          '—— **全是既有函数**，这里不写角色数组；每一格末尾过一遍 ' +
          '`entryVisible(格子的 entry, myRoles)`（滤**入口**），**不读任何数据行**',
      ],
      ['src/pages/Admin.tsx', '面板内的东西显隐（isSuperAdmin）+ 只读体检屏（上一轮新落）'],
      ['src/pages/Notices.tsx', '🆕「发通知」按钮的显隐（canPublishNotice）—— 只决定摆不摆，服务端仍会 403'],
      ['src/pages/NoticeNew.tsx', '🆕 发通知页：不能发的人进来看到一句说明（不是判据）+ 职位显示名'],
      ['src/App.tsx', 'DEV 钩子：把 ?as= 注进 myRoles（**只测试用，生产构建里被摇掉**，D7 钉住）'],
      ['src/data/store.ts', '`myRoles` 这个槽位的**定义处**（state + hydrate/signOut 写入，不是读取处）'],
      ['src/data/types.ts', '🆕 `RoleCode` 这个**类型的定义处**（注释里引用了 `ROLE_NAME` 这个名字，不读它的值）'],
      ['src/lib/notices.ts', '🆕 通知的**数据层**里那条显示用的小工具（`noticeScopeText`，把范围翻成一句话）'],
      [
        'src/pages/GradeSetup.tsx',
        '🆕 开学准备（P6）：「分配身份」那两组按钮的**显隐**（`canAssignRoles(myRoles)`）—— ' +
          '与 `/accounts` 那一页同一档判据、同一处 `roles.ts` 函数；**不读任何数据行**。' +
          '真正的闸门是服务端问数据库（`can_manage_grade_setup()` / `can_assign_roles()`）',
      ],
      [
        'src/pages/Grades.tsx',
        '🆕 年级管理（P6）：**只用来选一句空态文案**（"你的账号看不到任何年级" vs "还没有年级"）—— ' +
          '连入口都不判（入口在 `Settings.tsx` 那一行走 `entryVisible("/grades", …)`）',
      ],
      [
        'src/pages/Terms.tsx',
        '🆕 学期与学年（P3）：**只决定摆不摆那个录入表单**（`entryVisible("/settings/terms", myRoles)`，' +
          '与「我的」页那一行**同一个 key、同一个函数**）；**不读任何数据行**。' +
          '真正的闸门是服务端拿调用者 JWT 问数据库的 `can_manage_terms()`（= 教导处 / 最高管理员）',
      ],
      ['src/lib/roles.ts', '入口表与判据的定义处（不是读取处）'],
      [
        'src/pages/ClassDetail.tsx',
        '教室端两块能力（P9）· 2026-10-09：「呼叫学生」那个按钮的**显隐**已改成' +
          '**服务端回的那一个布尔**（`canCall`，`/api/grade-setup` 的 `classCallable`）—— ' +
          '这一页**不再拿角色推断它**；`myRoles` 在这里只剩"学生档案 / 教室端账号那一块摆不摆"' +
          '（`canEditClassFor(myRoles, …)`，与 `Classes.tsx` 同一款前端影子）。' +
          '**只决定摆不摆入口、不读任何数据行**。真正的闸门是数据库的 `can_call()`' +
          '（`schema.sql` §33.2）：事务性呼叫只给班级管理权那一档，科任老师即使把请求打进来也会被拒' +
          '（`rls-checks` 第十七节有一条反向对照钉着它）',
      ],
      [
        'src/pages/Classes.tsx',
        '🆕 走班班的编辑 / 删除（2026-10-08）：**只决定摆不摆那两个入口**' +
          '（`canEditClassFor(myRoles, c.id, c.gradeId)` —— `lib/roles.ts` 里那条判据的前端影子，' +
          '逐支照抄 `can_manage_class_for()`）；**不读任何数据行**（`classes` 是 RLS 筛过的结果，不再筛第二遍）。' +
          '真正的闸门是数据库：改 / 删走 `classes_update` / `classes_delete`（同一条判据），' +
          '加删成员走 §37.1 的函数（函数体内第一句就是 `can_manage_class()`）',
      ],
    ])
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e.name)) {
        const text = readFileSync(full, 'utf8')
        if (/\bmyRoles\b|\bROLE_NAME\b|\broleName\(/.test(text)) {
          hits.push(full.slice(APP.length + 1).replace(/\\/g, '/'))
        }
      }
    }
  }
  walk(join(APP, 'src'))
  eqSet('D4：读 myRoles / ROLE_NAME 的文件 ↔ 白名单（出现新文件就红）', hits, [...ROLE_READERS.keys()])
  check(
    ROLE_READERS.get('src/components/AppShell.tsx')?.includes('入口判据'),
    'D4：白名单里那句"这是显示还是判据"写清楚了（AppShell 是唯一一处真·入口判据）',
    ROLE_READERS.get('src/components/AppShell.tsx'),
  )
}

{
  /*
   * D5（M3 的机器版）：**页面里不许出现"角色 + 数据过滤"同框**。
   *
   * 判据用 `myRoles` 与 `.filter(` **同一文件**（粗略判据，命中就报出来让人看）——
   * 为什么不是逐行更聪明的判据：这一条的产出是"让人看一眼"，不是"机器判案"。
   * 名单里的每个文件都要能说出"它 filter 的是**入口**，不是数据行"：
   */
  const ALLOWED_FILTER = new Map([
    ['src/components/AppShell.tsx', 'filter 的是 NAV（EntryKey[]）—— 正是 M3 划的那条线'],
    ['src/data/store.ts', 'filter 的是班级/作业的增删（与角色无关）'],
    ['src/lib/roles.ts', 'filter 的是 EntryKey 数组（visibleEntryKeys，入口不是数据）'],
    ['src/pages/Admin.tsx', 'filter 的是面板的只读体检项 allTones（与角色无关）'],
    ['src/pages/Settings.tsx', 'filter 的是 schedule 里 scope!==class 的那一份（与角色无关）'],
    [
      'src/pages/Administration.tsx',
      '🆕 行政管理（2026-10-01）：`.filter` 滤的是**入口清单**（`CARDS.filter((c) => entryVisible(c.key, myRoles))`）' +
        '—— 与 `AppShell` 的 `NAV.filter(...)` 同一款，正是 M3 划的那条线（**入口 ≠ 数据行**）。' +
        '这一页不读 classes / students / grades 里的任何一行',
    ],
    ['src/pages/TeacherAccounts.tsx', 'filter 的是任课关系多选（与角色无关）'],
    [
      'src/pages/Workbench.tsx',
      'filter 的是今日待办（与角色无关）+ 🆕快捷操作那一组格子末尾的 ' +
        '`entryVisible(格子的 entry, myRoles)` —— 滤的是**入口清单**（与 `AppShell` 的 ' +
        '`NAV.filter(...)`、`Administration` 的 `CARDS.filter(...)` 同一款，M3 那条线）；' +
        '`myRoles` 也出现在 `adminClasses.find(c => canEditClassFor(myRoles, …))` 里 —— ' +
        '那是**既有前端影子**，只为拿"我那个班的 id"，**没有拿角色去筛数据行**',
    ],
    ['src/pages/Notices.tsx', '🆕 filter 的是通知列表的**排序前拷贝**（与角色无关，未读那一段也是服务端给的）'],
    ['src/pages/NoticeNew.tsx', '🆕 filter 的是"我能发的范围选项"（**选项，不是数据行** —— 清单由数据库给）'],
    [
      'src/pages/GradeSetup.tsx',
      '🆕 开学准备（P6）：10 处 `.filter` **没有一处与角色有关** —— 滤的是班级（`isAdminClass`）、' +
        '在册学生（`status === "active"`）、班号表达式挑出来的班、以及数组去重；' +
        '`myRoles` 单独出现在那两组按钮的 `disabled=` / `canAssign=` 里（见 D4 的白名单理由）',
    ],
    [
      'src/pages/Grades.tsx',
      '🆕 年级管理（P6）：`.filter` 滤的是这个年级的行政班与在册学生（与角色无关）；' +
        '`myRoles` 只出现在空态文案那一句',
    ],
    [
      'src/pages/ClassDetail.tsx',
      '🆕 教室端两块能力（P9）：4 处 `.filter` **没有一处与角色有关** —— 滤的是搜索命中的学生、' +
        '转班时的候选班、以及呼叫面板里"没转出的学生"；`myRoles` 单独出现在' +
        '"学生档案 / 教室端账号"那一块的显隐上（`canEditClassFor(myRoles, …)`，见 D4 的白名单理由）' +
        '—— 「呼叫学生」那个按钮**已经不在这里**（它看服务端回的 `canCall`）',
    ],
    [
      'src/pages/Classes.tsx',
      '🆕 走班班的编辑 / 删除（2026-10-08）：4 处 `.filter` **没有一处与角色有关** —— ' +
        '滤的是行政班 / 走班班（`splitByKind`）、名单里的搜索命中、以及全年级在册学生；' +
        '`myRoles` 单独出现在那两个入口的显隐上（`canEditClassFor(myRoles, …)`，见 D4 的白名单理由）',
    ],
  ])
  const SUSPECT = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e.name)) {
        const text = readFileSync(full, 'utf8')
        if (/\bmyRoles\b/.test(text) && /\.filter\(/.test(text)) {
          SUSPECT.push(full.slice(APP.length + 1).replace(/\\/g, '/'))
        }
      }
    }
  }
  walk(join(APP, 'src'))
  eqSet(
    'D5：`myRoles` 与 `.filter(` 同框的文件 ↔ 逐个说得出"滤的是入口不是数据"',
    SUSPECT,
    [...ALLOWED_FILTER.keys()],
  )
  /*
   * 更强的一条（正面）：**没有人拿 myRoles 去 filter 数据行**。
   * 真出现 `classes.filter((…) => myRoles…)` 这种写法时，这条会红。
   */
  const dataFilter = []
  const walk2 = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk2(full)
      else if (/\.tsx?$/.test(e.name)) {
        const text = readFileSync(full, 'utf8')
        /* 同一表达式里既出现数据集合又出现 roles/myRoles 的 filter */
        const re = /(classes|students|assignments|exams|examScores|calls)\s*\.filter\(\s*\(?[^)]*\)?\s*=>[^\n]{0,120}(myRoles|roles)\b/g
        for (const m of text.matchAll(re)) dataFilter.push(`${full.slice(APP.length + 1).replace(/\\/g, '/')}: ${short(m[0], 70)}`)
      }
    }
  }
  walk2(join(APP, 'src'))
  eqSet('D5（M3 正面）：没有任何"数据集合 .filter(… roles …)"的写法', dataFilter, [])
  const shell = readApp('src/components/AppShell.tsx')
  /*
   * `AppShell` 里那两处 `students.filter(...)` 与角色**无关**（统计 active 学生数），
   * 唯一与角色同框的是 `NAV.filter((n) => entryVisible(n.to, myRoles))` ——
   * 它滤的是 **`EntryKey[]`（入口）**，那正是 M3 划的那条线（"入口 ≠ 数据"）。
   * 所以这里断言的是**白名单恰好就是这一处**：多出第二处就要人看一眼。
   */
  const roleInDataFilter = [...shell.matchAll(/[a-zA-Z]+\.filter\([^\n]*\)/g)]
    .map((m) => m[0])
    .filter((s) => /myRoles|\broles\b/.test(s))
  eqSet(
    'D5：AppShell 里"与角色同框的 .filter"恰好只有那一处，且滤的是 NAV（入口）',
    roleInDataFilter,
    ['NAV.filter((n) => entryVisible(n.to, myRoles))'],
  )
}

/* ============================================================
   第十节 · D6：PIN_KEYS ⊆ NAV（改了一个忘了另一个会立刻红）
   ============================================================ */

section('第十节 · D6：PIN_KEYS ⊆ NAV（移动端胶囊的兜底）')

{
  const shell = readApp('src/components/AppShell.tsx')
  const navKeys = [...shell.matchAll(/^\s*\{ to: '([^']+)'/gm)].map((m) => m[1])
  const pinLine = shell.match(/const PIN_KEYS = \[([^\]]+)\]/)
  const pinKeys = pinLine ? [...pinLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  eq('D6：NAV 有 9 项（🆕 2026-10-01 加了「行政管理」；之前 8 项 = 加了「通知」）', navKeys.length, 9)
  eq('D6：PIN_KEYS 有 3 项', pinKeys.length, 3)
  eqSet('D6：PIN_KEYS ⊆ NAV', pinKeys.filter((k) => !navKeys.includes(k)), [])
  eqSet('D6：NAV 的每一项都在 ENTRIES 里', navKeys.filter((k) => !(k in roles.ENTRIES)), [])
  check(
    shell.includes('visibleNav') && shell.includes('splitPin'),
    'D6：过滤走的是 visibleNav()/splitPin() 一处（桌面 / 胶囊 / 展开层共用）',
    `visibleNav ×${(shell.match(/visibleNav/g) ?? []).length} · splitPin ×${(shell.match(/splitPin/g) ?? []).length}`,
  )
  /*
   * 🔴 三处索引必须一起换成过滤后的数组 —— 这是"高亮悄悄错位"那个 bug 的机器版：
   * `activeIdx`（桌面左栏）/ `pinIdx`（胶囊滑动落点）/ `moreActive`（圆按钮描边）。
   * 判据：这三行里都不许出现 `NAV.` / `PINNED` / `COLLAPSED`。
   */
  for (const [name, re] of [
    ['activeIdx', /const activeIdx = ([^\n]+)/],
    ['pinIdx', /const pinIdx = ([^\n]+)/],
    ['moreActive', /const moreActive = ([^\n]+)/],
  ]) {
    const m = shell.match(re)
    check(Boolean(m), `D6：找得到 ${name} 的定义（锚点自证）`, m ? short(m[1], 70) : '没找到')
    if (m) {
      const line = m[1]
      check(
        !/\bNAV\.findIndex|\bNAV\.some|\bPINNED\b|\bCOLLAPSED\b/.test(line),
        `D6：${name} 算的是**过滤后**的数组（不是 NAV / PINNED / COLLAPSED）`,
        short(line, 90),
      )
    }
  }
  const drag = shell.match(/const target = ([^\n]+)/)
  check(
    Boolean(drag) && !/PINNED/.test(drag[1]),
    'D6：胶囊拖拽落点用的是过滤后的 pinned（不是 PINNED 常量）',
    drag ? short(drag[1], 60) : '没找到',
  )
}

/* ============================================================
   第十一节 · D7：生产构建里测试钩子**一次都不许出现**（C5 的机器版）
   ============================================================ */

section('第十一节 · D7：dist 产物里没有 `?as=` / `?kind=` / `?maint=` / `?rel=` 的痕迹（生产构建无效）')

{
  const dist = join(APP, 'dist', 'assets')
  if (!existsSync(dist)) {
    check(false, 'D7：dist 存在（先跑 npm run build）', `${dist} 不存在`, '这一条不许静默跳过')
  } else {
    const js = readdirSync(dist).filter((f) => f.endsWith('.js'))
    const all = js.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n')
    check(js.length > 0, 'D7：dist/assets 下有 js 产物', `${js.length} 个文件、${all.length} 字符`)
    for (const [needle, why] of [
      ["get('as')", '`?as=` 的读取'],
      ["get('kind')", '`?kind=` 的读取'],
      /* 🆕 2026-09-28 公告轮：第三个钩子 `?sync=`（公告条与报错横幅的层叠断言靠它） */
      ["get('sync')", '`?sync=` 的读取'],
      /* 🆕 2026-09-29 管理台第二期：第四个钩子 `?maint=`（维护模式那三种行为的断言靠它） */
      ["get('maint')", '`?maint=` 的读取'],
      /*
       * 🆕 2026-10-04「版本更新公告」：第五个钩子 `?rel=1.1.1[&force=1][&slot=classroom]`。
       * ⚠️ 别为 `rel="noreferrer"`（`ReleaseGate.tsx` 里那个外链属性）加豁免 ——
       *    它**不会**命中 `get('rel')`（那个 needle 是"读查询参数"的形状，不是属性名）。
       */
      ["get('rel')", '`?rel=` 的读取'],
      /*
       * 🆕 2026-10-04（用户「我的」页第 ① 条的同一天）：第六个钩子参数 `?urls=apk|exe`
       * —— 让"面板里两个地址只填了其中一个"这件事在门禁里**造得出来**
       * （否则"没填的不摆死按钮"只能靠纯函数验，屏上那一半永远测不到）。
       * 它与 `rel` 同生共死（同一个 DEV 分支里），生产构建里一起被摇掉。
       */
      ["get('urls')", '`?urls=` 的读取'],
      ['devInjectedRoles', '钩子函数名'],
      ['devInjectedAccountKind', '钩子函数名'],
      ['devInjectedSyncError', '钩子函数名'],
      ['devInjectedMaintenance', '钩子函数名'],
      ['devInjectedRelease', '钩子函数名'],
    ]) {
      eq(`D7：产物里没有 ${why}`, all.includes(needle), false)
    }
    /*
     * 反向对照（**必须的**）：如果构建产物里连 `myRoles` 都没有，那上面那一串
     * "没找到"就是废话（整个应用都被摇掉了）。所以先证明产物里**有**这个东西。
     */
    check(all.includes('myRoles'), 'D7 反向对照：产物里**有** myRoles（证明上面那一串不是"什么都搜不到"）', all.includes('myRoles') ? '在' : '不在（构建产物不对）')
    check(all.includes('最高管理员'), 'D7 反向对照：产物里有中文（证明读的是真产物、编码没坏）', all.includes('最高管理员') ? '在' : '不在')
  }
}

/* ============================================================
   第十二节 · D8：全仓文本文件的编码体检（无 BOM / 严格 UTF-8 / 有汉字则无 U+FFFD）
                                                 + 不可见字符 / 全角标点混进代码
   ------------------------------------------------------------
   为什么从 9 个文件扩到全仓：这个项目**反复栽在编码上** ——
   `Admin.tsx` 那一轮用 PowerShell 文本 cmdlet 回写，整份文件变成双重编码乱码 + BOM
   （症状是 `tsc` 报一屏语法错，见 §20.6）；本轮又出过一次双重编码。
   而"扫一遍全仓"的成本是**一秒内**，比再踩一次便宜得多。
   第二层（不可见字符 / 全角标点）的判据、覆盖范围、跳过了哪些文件类型及原因，
   全部写在下面那段块注释里 —— 先读那段再改判据。
   ============================================================ */

section('第十二节 · D8：全仓编码体检（BOM / 严格 UTF-8 / 中文没被 mojibake / 不可见字符 / 全角标点）')

/** 文件是**严格 UTF-8** 吗？逐字节解一遍，遇到非法序列就报错（静默替换不报） */
function isStrictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** 一个文件"是不是好文本"的三条体检：无 BOM + 严格 UTF-8 + 有汉字的话没有 U+FFFD */
function sourceFileHealth(buf) {
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const utf8 = isStrictUtf8(buf)
  const text = new TextDecoder('utf-8').decode(buf)
  const han = /[\u4e00-\u9fa5]/.test(text)
  // U+FFFD = 解码时被静默替换掉的字节（"看起来是中文，其实是坏字符"最隐蔽的一种）
  const replaced = text.includes('\uFFFD')
  return { bom, utf8, han, replaced, bytes: buf.length, bad: bom || !utf8 || (han && replaced) }
}

{
  /** 扫哪些根：仓库里所有"我们自己写的"文本（不扫 node_modules / dist / .shots） */
  const ROOTS = ['app/src', 'app/scripts', 'app/functions', 'supabase', '.github']
  const ROOT_FILES = ['.gitignore', 'README.md']
  const EXT = new Set([
    '.ts', '.tsx', '.mjs', '.js', '.cjs', '.json', '.sql', '.md', '.yml', '.yaml', '.css', '.html',
  ])
  const SKIP_DIR = new Set(['node_modules', 'dist', '.shots', '.git', 'tmpdir'])
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (EXT.has(extname(e.name))) files.push(full)
    }
  }
  for (const r of ROOTS) {
    const full = join(REPO, r)
    if (existsSync(full)) walk(full)
  }
  for (const f of ROOT_FILES) {
    const full = join(REPO, f)
    if (existsSync(full)) files.push(full)
  }

  /*
   * 自证：文件数不能太少（否则"锚点写错、什么都没扫到"会**全绿通过**）。
   * 今天实测 130+ 个；下限写 100 留出增删空间，但绝不允许是 0。
   */
  check(files.length >= 100, `D8：扫到 ${files.length} 个文本文件（自证不是"什么都没扫到"）`, `根：${ROOTS.join(' · ')}`)

  const bad = []
  for (const f of files) {
    const h = sourceFileHealth(readFileSync(f))
    if (h.bad) {
      bad.push(
        `${f.slice(REPO.length + 1).replace(/\\/g, '/')}（${[
          h.bom ? 'BOM' : '',
          !h.utf8 ? '非法 UTF-8 字节' : '',
          h.han && h.replaced ? 'U+FFFD 替换字符' : '',
        ]
          .filter(Boolean)
          .join(' + ')}）`,
      )
    }
  }
  check(
    bad.length === 0,
    `D8：${files.length} 个文件全部无 BOM / 严格 UTF-8 / 中文没被 mojibake`,
    bad.length ? bad.join('；') : '全部干净',
  )
  /* 有汉字的文件要占绝大多数（这个仓库里几乎每个文件都有中文注释）—— 顺带自证编码判断没瞎 */
  const hanCount = files.filter((f) => /[\u4e00-\u9fa5]/.test(readFileSync(f, 'utf8'))).length
  check(hanCount > files.length / 2, `D8：${hanCount}/${files.length} 个文件含汉字（编码判断真的在工作）`, `含汉字比例 ${Math.round((hanCount / files.length) * 100)}%`)

  /*
   * 🔴 **反向对照**：故意构造坏字节流，上面那三条必须能红 ——
   * 否则这一节就是"永远为绿"的摆设（§18.6 那条教训：假断言比没有断言更糟）。
   */
  const doubleEncoded = Buffer.from(Array.from('小件').map((c) => c.charCodeAt(0)), 'latin1')
  const h1 = sourceFileHealth(doubleEncoded)
  check(
    h1.bad,
    'D8 反向对照①：伪造的双重编码字节流被判坏',
    `字节 ${[...doubleEncoded].map((b) => b.toString(16)).join(' ')} → bad=${h1.bad}（严格 UTF-8=${h1.utf8} / U+FFFD=${h1.replaced}）`,
  )
  const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('好', 'utf8')])
  const h2 = sourceFileHealth(bommed)
  check(h2.bad && h2.bom, 'D8 反向对照②：带 BOM 的字节流被判坏', `bad=${h2.bad} · bom=${h2.bom}`)
  const truncated = Buffer.from([0xe4, 0xb8]) // "中"字的前两个字节（缺尾字节）
  const h3 = sourceFileHealth(truncated)
  check(h3.bad && !h3.utf8, 'D8 反向对照③：被截断的多字节序列被判坏', `bad=${h3.bad} · 严格 UTF-8=${h3.utf8}`)
  /* 正面：正常的 UTF-8 中文不许被判坏（否则"全红"也是坏断言） */
  const good = Buffer.from('正常的中文注释 ✅', 'utf8')
  check(!sourceFileHealth(good).bad, 'D8 正面对照：正常的 UTF-8 中文**不**被判坏', `bad=${sourceFileHealth(good).bad}`)

  /* ============================================================
     D8 第二层：不可见字符 / 全角标点（"看十遍也看不出来"的那一类）
     ------------------------------------------------------------
     上一层的 BOM / mojibake 是"整份文件坏掉"；这一层管的是**单字符**级的坏法 ——
     一个 NBSP 混进代码、一个全角括号冒充半角。它们的共同点是：**报错会指向别处**，
     而人眼在等宽字体里几乎分不出来（这个项目已经在全角标点上吃过一次警告）。
     扫描成本一样是一秒内，所以并进 D8。

     ★ 分两类，判据不同：
     ① 类①「哪里都不合法」（连注释里也不该有）：NBSP / 零宽 / word joiner /
        BOM-零宽不换行 / 行、段分隔符 / 软连字符 / 全角空格 ——
        它们唯一的作用就是"让人看不出来"，没有任何一种写法**需要**它们。→ 出现即红。
        报出：文件、行号、列号、**字符名**、那一行的原文（不可见字符转义成 `<U+XXXX>` 再打印，
        否则连报错信息本身都是看不见的）。
     ② 类②「只在代码位置才不合法」：全角括号 / 冒号 / 逗号 / 分号 / 全角单双引号。
        这个仓库**大量中文注释**，注释里用中文标点本来就对 → 注释里合法，**代码位置**才红。

     ⚠️ 类② 怎么判断"这是不是代码位置"：不用"行首是不是 `//`"的一行判断 ——
     那样 JSX 文本、跨行块注释、字符串里的中文文案全都会被误判。这里做的是**逐字符标注**：
     按该语言的注释语法（TS/JS：`//` 行注释与 `/*` … `*\/` 块注释；SQL：`--` 与块注释；
     CSS：块注释；`.gitignore`：行首 `#`。⚠️ `*\/` 里那个反斜杠是故意的 ——
     在块注释里直接写"星号斜杠"会**提前结束这条注释**，这个坑本轮踩过一次）
     加上字符串 / 模板字面量 / 正则字面量，把整份文件标成
     注释 / 文本 / **裸代码** 三种，只有裸代码里的全角标点才红。效果：
       · 注释里的中文标点 → 绿
       · 中文文案字符串（`'科目（必填）'`）→ 绿（它跟注释一样是"给人看的文本"）
       · `foo（1）` / `import { a，b }` 这种"全角冒充半角" → 红
     ⚠️ 不确定的一律**宁可漏报也不要误报**：模板字面量里的 `${}` 表达式、正则里的 `[...]`、
     跨行未闭合的引号，统统按"文本"放过 —— 它们里面就算有全角标点，也未必构成语法错误，
     而误报会让这条检查天天喊狼来了，比没有检查更糟（§18.6）。

     ⚠️ 以下类型**跳过类②、只查类①**，每个都有具体原因（不是偷懒）：
       · `.md`       整篇就是给人看的散文，正文里的中文标点本来就该是全角。
       · `.json`     没有注释语法；值是题库/模板里的中文数据，`"（1）"` 是数据不是代码。
       · `.yml`/`.yaml`  例：`- name: 环境自检（只报 secret 存在性）` —— 值几乎全是中文说明，
                     按行首 `#` 判断不出"这个全角标点在键里还是值里"，判红必误报。
       · `.tsx`      JSX 文本节点（`<b>三条出路：</b>`）与代码在词法上**长得一样**（都是裸文本），
                     行级启发式分不开；本仓库 JSX 里 400+ 行中文文案 → 判红就是天天误报。
       · `.html`     同 markdown（整篇是标记 + 文案）。
     类② 实际覆盖：`.ts` `.js` `.mjs` `.cjs` `.sql` `.css` `.gitignore`。
     ============================================================ */

  /** 类①：任何地方都不合法的不可见字符（写成转义，免得本文件自己带上不可见字符） */
  const INVISIBLE_ANYWHERE = new Map([
    ['\u00A0', 'U+00A0 NBSP 不换行空格'],
    ['\u200B', 'U+200B ZWSP 零宽空格'],
    ['\u200C', 'U+200C ZWNJ 零宽不连字'],
    ['\u200D', 'U+200D ZWJ 零宽连字'],
    ['\u2060', 'U+2060 word joiner'],
    ['\uFEFF', 'U+FEFF BOM / 零宽不换行空格'],
    ['\u2028', 'U+2028 行分隔符 LS'],
    ['\u2029', 'U+2029 段分隔符 PS'],
    ['\u00AD', 'U+00AD 软连字符 SHY'],
    ['\u3000', 'U+3000 全角空格'],
  ])

  /**
   * U+3000 的**唯一**豁免：紧跟在全角左括号 `（` 之前时，算"排版留白"，不判红。
   * 为什么要有这条：本仓库有 5 处 `${extra ? `U+3000（${extra}）` : ''}`
   * （clock-checks.mjs / shots.mjs / 本文件），是在**控制台输出里**用全角空格把实测值
   * 和后面那对全角括号隔开 —— 有意的排版留白，人眼看得见，不是"藏起来的坏字符"。
   * 而这 5 处所在的文件**不在本次改动范围**，判红会让每天的 nav-checks 当场变噪音。
   * 为什么这个豁免不会漏掉坏法：同样的位置若真出现在**代码**里，类② 会照样把那个 `（` 判红
   * （两层是叠加的）。⚠️ 豁免只认"U+3000 后面紧跟 `（`"这一种形状，孤零零的 U+3000
   * 照旧判红 —— 有反向对照④钉住这一点。
   */
  const LAYOUT_SPACER_NEXT = '\uFF08' // 全角左括号

  /** 类②：只在"代码位置"才不合法的歧义字符 */
  const AMBIGUOUS_IN_CODE = new Map([
    ['\uFF08', 'U+FF08 全角左括号'],
    ['\uFF09', 'U+FF09 全角右括号'],
    ['\uFF1A', 'U+FF1A 全角冒号'],
    ['\uFF0C', 'U+FF0C 全角逗号'],
    ['\uFF1B', 'U+FF1B 全角分号'],
    ['\u201C', 'U+201C 全角左双引号'],
    ['\u201D', 'U+201D 全角右双引号'],
    ['\u2018', 'U+2018 全角左单引号'],
    ['\u2019', 'U+2019 全角右单引号'],
  ])

  /** 注释语法表：**不认识的扩展名 = 不查类②**（宁可漏报） */
  const COMMENT_SYNTAX = new Map([
    ['.ts', { line: '//', block: true, hash: false }],
    ['.js', { line: '//', block: true, hash: false }],
    ['.mjs', { line: '//', block: true, hash: false }],
    ['.cjs', { line: '//', block: true, hash: false }],
    ['.sql', { line: '--', block: true, hash: false }],
    ['.css', { line: null, block: true, hash: false }],
    ['.gitignore', { line: null, block: false, hash: true }],
  ])
  const CLASS2_EXT = new Set(COMMENT_SYNTAX.keys())

  /** 正则字面量只能靠"上一个有意义的字符"猜（JS 本身的经典歧义）——猜错宁可当代码 */
  const REGEX_AFTER = '(,=:[!&|?{};+-*%~^<>'
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await',
    'instanceof', 'new', 'delete', 'void', 'throw', 'default',
  ])

  /**
   * 逐字符标注：'c' 裸代码 / 'm' 注释 / 's' 字符串（含模板、正则）。
   * 模板字面量用栈处理：`` ` `` 开，内部只有 `${` 是代码，`${}` 里再出现 `` ` `` 是**嵌套模板**
   * （本仓库的 `${extra ? `（${extra}）` : ''}` 就是这种），不算"模板结束"。
   */
  function codeMask(text, syn) {
    const N = text.length
    const mask = new Array(N).fill('c')
    const stack = []
    let i = 0
    let prevChar = ''
    let word = ''
    const startsRegex = () => prevChar === '' || REGEX_AFTER.includes(prevChar) || REGEX_KEYWORDS.has(word)
    while (i < N) {
      const c = text[i]
      const two = text.slice(i, i + 2)
      const top = stack[stack.length - 1]
      if (top && top.t === 'tpl') {
        mask[i] = 's'
        if (c === '\\') { if (i + 1 < N) mask[i + 1] = 's'; i += 2; continue }
        if (c === '`') { stack.pop(); i++; prevChar = '`'; word = ''; continue }
        if (two === '${') { mask[i + 1] = 'c'; i += 2; stack.push({ t: 'expr', depth: 0 }); prevChar = '{'; word = ''; continue }
        i++
        continue
      }
      if (top && top.t === 'expr') {
        if (c === '{') { top.depth++; i++; prevChar = '{'; word = ''; continue }
        if (c === '}') {
          if (top.depth === 0) { stack.pop(); mask[i] = 's'; i++; prevChar = '}'; word = ''; continue }
          top.depth--; i++; prevChar = '}'; word = ''; continue
        }
      }
      /*
       * 换行要把"上一个有意义的字符"清掉：否则上一行行尾的字符会漏到下一行，
       * 让"这一行以 `#` 开头吗"（本仓库只有 `.gitignore` 走这条规则）永远判错 ——
       * 这个 bug 真的发生过一次：`.gitignore` 里 12 处 `#` 注释被当成代码判红。
       */
      if (c === '\n') { prevChar = ''; word = ''; i++; continue }
      if (syn.block && two === '/*') {
        const end = text.indexOf('*/', i + 2)
        const stop = end < 0 ? N : end + 2
        for (let k = i; k < stop; k++) mask[k] = 'm'
        i = stop
        word = ''
        continue
      }
      if (syn.line && two === syn.line) {
        while (i < N && text[i] !== '\n') { mask[i] = 'm'; i++ }
        word = ''
        continue
      }
      // `#` 只有"这一行第一个非空白字符"才算注释（不是行内注释）—— 宁可漏报
      if (syn.hash && c === '#' && prevChar === '') {
        while (i < N && text[i] !== '\n') { mask[i] = 'm'; i++ }
        continue
      }
      if (c === '"' || c === "'") {
        let j = i + 1
        let closed = false
        while (j < N) {
          if (text[j] === '\\') { j += 2; continue }
          if (text[j] === '\n') break
          if (text[j] === c) { closed = true; break }
          j++
        }
        // 引号没在本行闭合 → 大概不是字符串（宁可当代码），不标注
        if (closed) { for (let k = i; k <= j; k++) mask[k] = 's'; i = j + 1; prevChar = c; word = ''; continue }
      }
      if (c === '`') { mask[i] = 's'; stack.push({ t: 'tpl' }); i++; continue }
      if (c === '/' && startsRegex()) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < N) {
          const d = text[j]
          if (d === '\\') { j += 2; continue }
          if (d === '\n') break
          if (d === '[') inClass = true
          else if (d === ']') inClass = false
          else if (d === '/' && !inClass) { closed = true; break }
          j++
        }
        if (closed) { for (let k = i; k <= j; k++) mask[k] = 's'; i = j + 1; prevChar = '/'; word = ''; continue }
      }
      if (!/\s/.test(c)) {
        prevChar = c
        word = /[A-Za-z_$0-9]/.test(c) ? word + c : ''
      }
      i++
    }
    return mask
  }

  /** 把不可见字符转义成看得见的 `<U+XXXX>`（否则"报出原文"这件事本身就是不可见的） */
  function escapeInvisible(line) {
    let out = ''
    for (const ch of line) {
      if (INVISIBLE_ANYWHERE.has(ch)) out += `<${INVISIBLE_ANYWHERE.get(ch).split(' ')[0]}>`
      else if (ch === '\t') out += '\\t'
      else out += ch
    }
    return out
  }

  /** 命中处前后开个窗口（行很长时不至于把命中点截掉），再转义显示 */
  function showLine(line, at) {
    const from = Math.max(0, at - 36)
    const to = Math.min(line.length, at + 72)
    return `${from > 0 ? '…' : ''}${escapeInvisible(line.slice(from, to))}${to < line.length ? '…' : ''}`
  }

  /**
   * 扫一段文本。`ext` 决定注释语法；不认识的扩展名只查类①（mask=null）。
   * 返回：类①命中 / 类②命中 / 被当成"文本"放过的全角标点数（自证不是什么都没扫到）。
   */
  function scanInvisible(text, ext) {
    const normalized = text.replace(/\r\n/g, '\n')
    const syn = COMMENT_SYNTAX.get(ext)
    const mask = syn && CLASS2_EXT.has(ext) ? codeMask(normalized, syn) : null
    const lines = normalized.split('\n')
    const invisible = []
    const ambiguous = []
    const spacers = []
    let ambiguousInText = 0
    let base = 0
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]
      for (let k = 0; k < line.length; k++) {
        const ch = line[k]
        if (INVISIBLE_ANYWHERE.has(ch)) {
          const hit = { line: li + 1, col: k + 1, name: INVISIBLE_ANYWHERE.get(ch), shown: showLine(line, k) }
          if (ch === '\u3000' && line[k + 1] === LAYOUT_SPACER_NEXT) spacers.push(hit)
          else invisible.push(hit)
        } else if (AMBIGUOUS_IN_CODE.has(ch)) {
          if (mask && mask[base + k] === 'c') {
            ambiguous.push({ line: li + 1, col: k + 1, name: AMBIGUOUS_IN_CODE.get(ch), shown: showLine(line, k) })
          } else if (mask) ambiguousInText++
        }
      }
      base += line.length + 1
    }
    return { invisible, ambiguous, spacers, ambiguousInText }
  }

  const fmt = (rel, hits) => {
    const CAP = 6
    const shown = hits.slice(0, CAP).map((h) => `${rel}:${h.line}:${h.col} ${h.name} → ${h.shown}`)
    if (hits.length > CAP) shown.push(`（这一个文件还有 ${hits.length - CAP} 处）`)
    return shown.join('；')
  }

  /* ---------------- 真文件：类① ---------------- */
  const invisibleHits = []
  const spacerHits = []
  const ambiguousHits = []
  let ambiguousInText = 0
  let class2Files = 0
  for (const f of files) {
    const rel = f.slice(REPO.length + 1).replace(/\\/g, '/')
    /*
     * ⚠️ `extname('.gitignore')` 是**空串**（点文件没有扩展名）——
     * 所以这里显式补一下，否则注释语法表里的 `.gitignore` 永远不会命中，
     * 而输出里却写着"覆盖 .gitignore"（一查一漏，比不查更坏）。
     */
    const ext = extname(f) || (f.endsWith('.gitignore') ? '.gitignore' : '')
    const r = scanInvisible(readFileSync(f, 'utf8'), ext)
    if (CLASS2_EXT.has(ext)) class2Files++
    ambiguousInText += r.ambiguousInText
    if (r.invisible.length) invisibleHits.push(fmt(rel, r.invisible))
    for (const h of r.spacers) spacerHits.push(`${rel}:${h.line}`)
    if (r.ambiguous.length) ambiguousHits.push(fmt(rel, r.ambiguous))
  }
  check(
    invisibleHits.length === 0,
    `D8·不可见①：${files.length} 个文件里没有"哪里都不合法"的不可见字符（NBSP/零宽/word joiner/软连字符/行段分隔符/全角空格）`,
    invisibleHits.length ? invisibleHits.join('；') : `0 处；另有 ${spacerHits.length} 处已声明的排版留白（U+3000 紧跟全角左括号，见代码注释）${spacerHits.length ? ` → ${spacerHits.join(' · ')}` : ''}`,
  )
  check(
    ambiguousHits.length === 0,
    `D8·不可见②：类②覆盖的 ${class2Files} 个文件（${[...CLASS2_EXT].join('/')}）里，全角标点没有混进**代码位置**`,
    ambiguousHits.length ? ambiguousHits.join('；') : `0 处；跳过类②的类型：.md/.json/.yml/.yaml/.tsx/.html（原因见本节抬头注释）`,
  )
  /* 自证：类② 若是"什么都没扫到"，上面那条就是永远为绿的摆设 —— 证明它确实看到了大量
     注释/字符串里的全角标点并**有意识**地放过了它们（这个仓库中文注释很多，量必然不小）。 */
  check(
    ambiguousInText > 1000,
    'D8·不可见②自证：确实在注释/字符串里看到并放过了大量全角标点（不是"什么都没扫到"）',
    `${ambiguousInText} 处全角标点落在注释/字符串里（合法，已排除）`,
  )

  /* 🔴 反向对照（**必须有**，否则这一层就是永远为绿的摆设）：拿伪造样本证明它会红，
     再拿注释样本证明它**不**会一刀切。 */
  const f1 = scanInvisible('const a = 1\u00A0// 行尾一个不换行空格\n', '.ts')
  check(
    f1.invisible.length === 1 && f1.invisible[0].line === 1,
    'D8·不可见 反向对照①：伪造的 U+00A0（哪怕在注释行里）被判红',
    `命中 ${f1.invisible.length} 处 → ${f1.invisible.map((h) => `${h.line}:${h.col} ${h.name} → ${h.shown}`).join('；') || '（没红，说明类①失效）'}`,
  )
  const f2 = scanInvisible('const n = foo\uFF081\uFF09\uFF0Cok\n', '.ts')
  check(
    f2.ambiguous.length >= 3,
    'D8·不可见 反向对照②：伪造的**代码行**里的全角括号/逗号被判红',
    `命中 ${f2.ambiguous.length} 处 → ${f2.ambiguous.map((h) => `${h.col} ${h.name}`).join('；') || '（没红，说明类②失效）'}`,
  )
  const f3 = scanInvisible('// 说明\uFF08这里在注释里，合法\uFF09\n', '.ts')
  check(
    f3.ambiguous.length === 0 && f3.invisible.length === 0,
    'D8·不可见 反向对照③：伪造的**注释行**里的全角括号**不**被判红（防"一刀切"把正常中文注释判坏）',
    `命中 ${f3.ambiguous.length + f3.invisible.length} 处（期望 0）`,
  )
  const f4 = scanInvisible('const a =\u3000 1\n', '.ts')
  check(
    f4.invisible.length === 1 && f4.spacers.length === 0,
    'D8·不可见 反向对照④：孤零零的 U+3000 照样判红（证明"排版留白"豁免很窄，不是把全角空格放行）',
    `命中 ${f4.invisible.length} 处 · 算作留白的 ${f4.spacers.length} 处（期望 1 / 0）`,
  )
  const f5 = scanInvisible('const a = 1 // 正常注释\n', '.ts')
  check(
    f5.invisible.length === 0 && f5.ambiguous.length === 0,
    'D8·不可见 正面对照：干净的代码行**不**被判红',
    `命中 ${f5.invisible.length + f5.ambiguous.length} 处（期望 0）`,
  )
  /*
   * 反向对照⑤：**报错信息本身**也要有反向对照 —— 上面那几条只在"能红"时才有意义，
   * 而"红了以后的报告长什么样"是另一段代码（fmt）。真要出事时才发现报告函数崩了，
   * 就等于没有报告。所以这里把 fmt 的输出也钉一遍：文件、行号、列号、字符名、
   * 以及**转义后的那一行原文**（不转义的话，打印出来还是看不见）。
   */
  const f1report = fmt('app/scripts/伪造样本.ts', f1.invisible)
  const needFields = ['app/scripts/伪造样本.ts:1:12', 'U+00A0 NBSP 不换行空格', '<U+00A0>', 'const a = 1']
  check(
    needFields.every((s) => f1report.includes(s)),
    'D8·不可见 反向对照⑤：红的时候报的信息够定位（文件:行:列 + 字符名 + 转义后的那行原文）',
    f1report,
  )
  /*
   * 反向对照⑥：上面几条用的是**伪造的小字符串**；这条拿一个**真文件**做端到端对照 ——
   * 原文必须 0 命中，往它末尾注入一行"全角冒充半角"后必须红。
   * 为什么值得多这一条：只有它同时证明了"这一节的绿不是解析器把整份文件都吞了"。
   */
  const realFile = files.find((g) => extname(g) === '.ts')
  const realScan = (extra) => (realFile ? scanInvisible(readFileSync(realFile, 'utf8') + extra, '.ts') : null)
  const realClean = realScan('')
  const realPoisoned = realScan('\nconst 注入 = foo\uFF081\uFF09\n')
  check(
    !!realClean && realClean.ambiguous.length === 0 && !!realPoisoned && realPoisoned.ambiguous.length >= 2,
    `D8·不可见 反向对照⑥：真文件端到端对照（${realFile ? realFile.slice(REPO.length + 1).replace(/\\/g, '/') : '没找到 .ts 文件'}）—— 原文 0 命中，注入一行"全角冒充半角"后判红`,
    realClean && realPoisoned ? `原文 ${realClean.ambiguous.length} 处 · 注入后 ${realPoisoned.ambiguous.length} 处` : '没扫到',
  )
}

/* ============================================================
   第十三节 · D10：**表存在性探针不许假设任何列存在**（这一类 bug 已经咬了两次）
   ------------------------------------------------------------
   两次实例（同一个形状 —— 拿**某一列**当**整张表**的探针，而"每张表都有 id"只是假设）：
     · ① 超管面板 `adminChart.probeTable()`：探 9 张表用 `select('id')`，
          而 `subjects` 的主键是 `code`（`schema.sql` §12.1，**没有 id**）
          → 那一格在任何正确的库上都是红的（已改成 `select('*')`）；
     · ② 通知数据层 `lib/notices.ts`：探 `notice_targets` 用 `select('id')`，
          而那张表的列是 `notice_id` / `target_kind` / …（§21.4，**没有 id**）
          → PostgREST 回 `42703 column notice_targets.id does not exist`
          → 被泛判据当成"表不在" → 通知页谎报「数据库里还没有通知表」（已改成 `select('*')`）。

   本节守三条（都必须能在当前仓库上**零误报** —— 一个天天误报的检查比没有更糟，§18.6）：

     A · **形状**：探针里 `.select('<具体列>')` 必须是 `'*'`。
         "探针上下文" = `at` 落在**最近的、名字像探针的函数**里：`probe*` / `ensure*`，
         或就地问"在不在"的小工具 `has`（`const has = async (table) => …`）。
         唯一豁免：**这个探针自己就在问"这一列在不在"** —— 它的体里出现 `42703`，
         或者（**表名写死时**）引用了名字像列判据的东西（`MISSING_COL_RE` / `isMissingColumn`）——
         那选那一列**正是它的目的**（`lib/files.ts` 的 `probeFileClassCols` 就是这种；
         它不在本轮允许改的文件里，而且它**不是**这一类 bug）。
     B · **判据分流**：名字带 `MissingTable` / `MissingRelation` 的判据
         **不许**把「列不在」（`42703` / `PGRST204`）算进来，也**不许**用没有 `relation`
         限定的 `does not exist`；且必须认得 `42P01`（否则它可能"什么都不认得"）。
         「列不在」要**另起一条**判据（`MISSING_COL_RE` / `isMissingColumn`），两条成对。
     C · **错误文案对照**（最实的一条）：把仓库里**真判据**抠出来（错误码字面量 + 正则字面量）
         拿去跑**真错误文案**：`42703 column notice_targets.id does not exist`（真库上那句）
         与 `PGRST204 … column …` 一律**不许**被判成"表不在"；`42P01` / `PGRST205` /
         无码的 `relation … does not exist` 一律**必须**被判出来。

   ⚠️ **收窄留档**（为什么不做成"全仓所有 `select('<具体列>')` 都查"）：
      · 正常业务查询本来就常常只要一两列（`select('id,title')`）—— 一刀切必然天天误报，
        而"一个天天误报的检查比没有更糟"（§18.6）；
      · 所以形状判据只认"**探针上下文**"里的 select，业务查询一律不管（反向对照②钉住这一点）；
      · 剩下的已知缺口（**明说，不假装覆盖**）：列探针若把列判据整条抽到别处、体里既没有
        `42703` 也不引用列判据，判据 A 会把它当"表探针"抓（**假红** —— 报错里写了怎么改）；
        反过来，"表名写死 + 体里引用了列判据"的探针若仍拿具体列去探**表**，会漏（**假绿**）。
        两条真实实例的形状（`from(<变量>).select('id')` + 表判据）两边都抓得住 ——
        这一节的定位是"把已经咬过两次的形状钉死 + 把判据分流钉死"，不是"证明这类写法不存在"。
   ============================================================ */

section("第十三节 · D10：表存在性探针不许假设列存在（select('*')）+ 42703 不算「表不在」")

{
  /* ---------------- 小工具（只在本节内用） ---------------- */

  /**
   * 去掉注释，**保留字节长度与换行**（这样命中处的行号还能对得上原文）。
   * 为什么必须去注释：本仓库的注释里到处在**讨论**这两件事（"42703 不是表不在"、
   * "别用 select('id')"），而这里判的是**代码**写了什么。
   */
  const stripComments = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])(\/\/[^\n]*)/gm, (m, a, b) => a + ' '.repeat(b.length))

  /** 声明处：`function name(` / `const name = … =>`（含 `async`） */
  const DECL_RE =
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=;]{0,90}?=>/g

  /** 从 `{` 起配平切出函数体（与 D3 切 `ENTRIES` 的写法同款） */
  function braceBody(src, open) {
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) return src.slice(open, i + 1)
      }
    }
    return src.slice(open)
  }

  /**
   * `at` 落在哪个**探针函数**里？返回 `{ name, body }`（找不到返回 null = 非探针用途）。
   *
   * ⚠️ 两个坑（都踩过，写下来）：
   *   · 要的是"**最近的探针函数**"，不是"最近的声明" —— 探针体里常嵌一层就地问在不在的
   *     小工具（`const has = async (table) => {…}`）或 IIFE（`await (async () => {…})()`），
   *     后者**不是**探针，按"最近声明"取会把整个探针站点漏掉；
   *   · 函数体那个 `{` **不能取"声明后第一个 `{`"** —— 签名里的类型字面量
   *     （`error: { message?: string } | null`）也是一个 `{`，取错了整条判据就看不见了。
   *     所以这里逐个 `{` 试，取"配平后**真的包含这一处命中**"的那个。
   */
  function enclosingFn(src, at, needle) {
    const decls = []
    for (const m of src.matchAll(DECL_RE)) {
      if (m.index > at) break
      decls.push(m)
    }
    for (let k = decls.length - 1; k >= 0; k--) {
      const name = decls[k][1] ?? decls[k][2]
      if (!isProbeName(name)) continue
      /*
       * ⚠️ 候选 `{` 只在"**这个声明自己的范围**"里找（到下一个声明为止）——
       *    否则会一路扫到后面别的函数体上，把一处业务查询错记到某个探针名下。
       * ⚠️ `needle` 必须传**整段 `.from(…).select(…)`**，不能只截前 12 个字符：
       *    `.from('class` 既是 `classroom_accounts` 的前缀、也是 `classes` 的前缀 ——
       *    只比前 12 个字符时，`probeGradeLookup()` 里那句 `from('classes').select('grade_id')`
       *    会把 `classroomRole()` 里的 `from('classroom_accounts')` 认成自己人（踩过）。
       */
      const limit = decls[k + 1] ? Math.min(at, decls[k + 1].index) : at
      for (let i = decls[k].index; i < limit; i++) {
        if (src[i] !== '{') continue
        const body = braceBody(src, i)
        if (body.includes(needle)) return { name, body }
      }
    }
    return null
  }

  /** 一个 `function name(…)` 的**函数体**（同上：取"配平后含 `return`"的那个 `{`，避开类型字面量） */
  function fnBodyAfter(code, from) {
    for (let i = from; i < code.length; i++) {
      if (code[i] !== '{') continue
      const body = braceBody(code, i)
      if (/\breturn\b/.test(body)) return body
    }
    return null
  }

  const lineOf = (src, at) => src.slice(0, at).split('\n').length
  const isProbeName = (n) => /^(probe|ensure)/i.test(n) || n === 'has'
  const isTablePredName = (n) => /missing_?(table|relation)/i.test(n)
  const isColPredName = (n) => /missing_?col/i.test(n)

  /* ---------------- 判据 A：探针里的 `.select(...)` ---------------- */

  /**
   * 扫一份源码：返回探针里的 `.select(...)` 站点。
   *   · `sites`  所有探针站点（自证用：数量太少说明锚点/正则坏了）
   *   · `hits`   **红**：探针里写了具体列名
   *   · `exempt` 绿：这个探针的判据里有 `42703`（它在问"这一列在不在"）
   */
  function scanProbeSelects(src) {
    const code = stripComments(src)
    const sites = []
    const hits = []
    const exempt = []
    for (const m of code.matchAll(/\.from\(([^)]*)\)\s*\.select\(\s*([^)]*?)\s*\)/g)) {
      const fn = enclosingFn(code, m.index, m[0])
      if (!fn || !isProbeName(fn.name)) continue // 非探针用途（业务查询）→ 不归这一节管
      const arg = m[2]
      const where = `${fn.name}() 第 ${lineOf(code, m.index)} 行 · .from(${m[1]})`
      sites.push(where)
      if (arg.includes('*')) continue // `'*'`（或 `'id,*'`）→ 没有假设任何列
      if (!/^'[^']*'$/.test(arg) && !/^"[^"]*"$/.test(arg)) continue // 变量（`select(column)`）→ 列探针的写法
      /*
       * 豁免：这个探针自己就在问"**这一列**在不在"（选那一列正是它的目的），两种写法都认：
       *   · 体里直接有 `42703`（本仓库那三个列探针都是这么写的）；
       *   · 体里引用了名字像列判据的东西（`MISSING_COL_RE` / `isMissingColumn`）
       *     **且表名是写死的**（`from('shared_files')`）—— "表也当变量传"的探针
       *     一律不认这个豁免（不然一句 `MISSING_COL_RE` 就能把表探针洗白，
       *     反向对照④就是拿真文件钉这一点的）。
       */
      const literalTable = /^['"]/.test(String(m[1]).trim())
      if (/42703/.test(fn.body) || (literalTable && /missing_?col/i.test(fn.body))) {
        exempt.push(`${where} · select(${arg})`)
      } else {
        hits.push(`${where} · select(${arg}) [若这是"列探针"，请把 42703 判据写进它的体里，或改用变量选列]`)
      }
    }
    return { sites, hits, exempt }
  }

  /* ---------------- 判据 B：「表不在」判据的形状 ---------------- */

  /**
   * 一条「表不在」的判据该长什么样 —— 返回"哪里不对"的清单（空 = 合格）。
   * ⚠️ `does not exist` 的限定词取**最近一个** `relation` / `column` / `table`：
   *    `/relation .+ does not exist/i` 最近的是 `relation` → 合格；
   *    裸的 `/does not exist/i` 和 `/column .+ does not exist/i` → 不合格（后者是**列**判据）。
   */
  function checkTablePredicate(text) {
    const bad = []
    if (/42703/.test(text)) bad.push('认了 42703（那是「列不在」，要另起一条判据）')
    if (/PGRST204/.test(text)) bad.push('认了 PGRST204（那是「列不在」）')
    if (!/42P01/.test(text)) bad.push('认不出 42P01（那它可能什么都不认得）')
    for (const m of text.matchAll(/does not exist/gi)) {
      const before = text.slice(0, m.index)
      const qual = [...before.matchAll(/\b(relation|column|table)\b/gi)].pop()?.[1]?.toLowerCase()
      if (qual !== 'relation') {
        bad.push(`有一处 does not exist 不是由 relation 限定的（最近的是 ${qual ?? '（没有）'}）`)
      }
    }
    return bad
  }

  /** 扫一份源码里所有「表不在」/「列不在」的判据（`function name(…){}` 与 `const NAME = …`） */
  function scanMissingPredicates(src) {
    const code = stripComments(src)
    const out = []
    for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!isTablePredName(m[1]) && !isColPredName(m[1])) continue
      const body = fnBodyAfter(code, m.index + m[0].length)
      if (!body) continue
      out.push({
        name: m[1],
        text: `${m[0]}…）${body}`,
        line: lineOf(code, m.index),
      })
    }
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g)) {
      if (!isTablePredName(m[1]) && !isColPredName(m[1])) continue
      out.push({ name: m[1], text: `${m[1]} = ${m[2]}`, line: lineOf(code, m.index) })
    }
    return out
  }

  /**
   * 一条判据"认不认"某个错误 —— 把它源码里的**错误码字面量**与**正则字面量**抠出来模拟一遍。
   *
   * ⚠️ 这只能模拟"文案 + 代码"这一层，**看不见控制流**（比如
   *    `if (isMissingColumn(error)) return false` 这种"先摘掉列不在"的分支）——
   *    所以下面那组错误文案里**不放** `column "x" of relation "y" does not exist`
   *    那种 PG 原生写法：它在**正则层面**与 `relation … does not exist` 撞车，
   *    只能靠代码分流（各家的分流都写在 `isMissingTable` / `has()` 里，本节盯不住控制流）。
   *    而"表探针用 `select('*')`"这条纪律恰恰保证**表探针收不到任何列错误** ——
   *    那才是根治；这条对照只是把"认得出/认不出"钉住。
   */
  function predicateProbe(text) {
    const codes = [...text.matchAll(/'([0-9A-Z]{5,8})'/g)].map((m) => m[1])
    const regexes = []
    for (const m of text.matchAll(/\/(?![/*])((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/([gimsuy]*)/g)) {
      try {
        regexes.push(new RegExp(m[1], m[2].replace(/[gy]/g, '')))
      } catch {
        /* 抠不出来就跳过 —— 下面"必须认得 42P01/42P01 样本"那条会兜住 */
      }
    }
    return { codes, regexes }
  }
  const classify = (p, code, msg) => p.codes.includes(code) || p.regexes.some((re) => re.test(msg))

  /* ---------------- 真文件 ---------------- */

  /* 生产代码两处（`src` 与 `functions`）；`app/scripts` 是验证脚本，里面有**刻意伪造的样本字符串**，不扫 */
  const D10_ROOTS = ['src', 'functions']
  const tsFiles = []
  const walkTs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walkTs(full)
      else if (e.name.endsWith('.ts')) tsFiles.push(full)
    }
  }
  for (const r of D10_ROOTS) walkTs(join(APP, r))
  check(tsFiles.length >= 40, `D10：扫到 ${tsFiles.length} 个 .ts（${D10_ROOTS.join(' · ')}）`, `扫到 ${tsFiles.length} 个`)

  const relOf = (f) => f.slice(APP.length + 1).replace(/\\/g, '/')
  const shapeHits = []
  const shapeExempt = []
  let probeSites = 0
  const tablePreds = []
  const colPreds = []
  const predBad = []
  for (const f of tsFiles) {
    const raw = readFileSync(f, 'utf8')
    const s = scanProbeSelects(raw)
    probeSites += s.sites.length
    for (const h of s.hits) shapeHits.push(`${relOf(f)} · ${h}`)
    for (const h of s.exempt) shapeExempt.push(`${relOf(f)} · ${h}`)
    for (const p of scanMissingPredicates(raw)) {
      const where = `${relOf(f)} · ${p.name}`
      if (isTablePredName(p.name)) {
        tablePreds.push(where)
        const bad = checkTablePredicate(p.text)
        if (bad.length) predBad.push(`${where} 第 ${p.line} 行 —— ${bad.join('；')}`)
      } else colPreds.push(where)
    }
  }

  /* 判据 A：红 + 自证（站点数、豁免清单都要看得见） */
  check(
    probeSites >= 6,
    `D10-A 自证：扫到 ${probeSites} 处"探针里的 select"（少于 6 说明锚点/正则坏了，不是"全绿"）`,
    `${probeSites} 处`,
  )
  check(
    shapeHits.length === 0,
    "D10-A：探针里没有一处写具体列名（表存在性必须 select('*')）",
    shapeHits.length ? shapeHits.join('；') : `0 处红；豁免 ${shapeExempt.length} 处（判据里有 42703 的「列探针」）：${shapeExempt.join(' · ') || '（没有）'}`,
  )

  /* 判据 B：真判据全部合格 + 清单自证（出现新判据就要人来这儿认领） */
  check(
    predBad.length === 0,
    'D10-B：所有"表不在"判据都没有把 42703 当"表不在"、也没有裸的 does not exist',
    predBad.length ? predBad.join('；') : `${tablePreds.length} 条全部合格`,
  )
  eqSet('D10-B 自证：「表不在」判据清单（多一条就要来这儿说清它为什么该在）', tablePreds, [
    'src/lib/adminChart.ts · MISSING_TABLE_RE',
    'src/lib/notices.ts · MISSING_TABLE_RE',
    /* 🆕 2026-09-28 公告轮：公告那张表（`schema.sql` §22）也要一个"表不在"的判据 ——
       `ensureAnnouncementTable()` 靠它区分"表没跑"与"网络抖了"（后者一律当作有）。 */
    'src/lib/announcements.ts · MISSING_TABLE_RE',
    'src/data/remote.ts · isMissingTable',
    'functions/api/teacher-account.ts · isMissingTable',
    'functions/api/classroom-account.ts · isMissingTable',
  ])
  check(
    colPreds.length >= 3,
    'D10-B 自证：「列不在」判据是**另起的**（不是揉进"表不在"里）',
    `${colPreds.length} 条：${colPreds.join(' · ')}`,
  )

  /*
   * 🔴 **错误文案对照**（本节最强的一条）：把仓库里**真判据**拿去跑**真错误文案**，
   * 要求「列不在」一律**不**被判成"表不在"，「表不在」一律**被**判出来。
   * `notice_targets` 那一句就是用户在真库上看到的那一句（这一类 bug 的第二次实例）。
   */
  const ERROR_SAMPLES = [
    { code: '42703', msg: 'column notice_targets.id does not exist', table: false, col: true },
    { code: '42703', msg: 'column subjects.id does not exist', table: false, col: true },
    {
      code: 'PGRST204',
      msg: "Could not find the 'primary_subject_code' column of 'teachers' in the schema cache",
      table: false,
      col: false,
    },
    { code: '42P01', msg: 'relation "public.notices" does not exist', table: true, col: false },
    {
      code: 'PGRST205',
      msg: "Could not find the table 'public.notice_targets' in the schema cache",
      table: true,
      col: false,
    },
    // 老版 PostgREST 不带 code，只给话 —— 兜底文案那一条分支也得认得出"表不在"
    { code: '', msg: 'relation "public.exams" does not exist', table: true, col: false },
  ]
  const allPreds = tsFiles.flatMap((f) =>
    scanMissingPredicates(readFileSync(f, 'utf8')).map((p) => ({ ...p, where: `${relOf(f)} · ${p.name}` })),
  )
  const byPred = allPreds.map((p) => ({
    name: p.name,
    where: p.where,
    isTable: isTablePredName(p.name),
    /* 列判据只在"它**真的**声称认得 `42703`/`PGRST204`"时才核（本仓库的列判据都认得） */
    claimsCol: /42703|PGRST204/.test(p.text),
    probe: predicateProbe(p.text),
  }))
  const mismatches = []
  for (const p of byPred) {
    for (const s of ERROR_SAMPLES) {
      const got = classify(p.probe, s.code, s.msg)
      if (p.isTable && got !== s.table) {
        mismatches.push(`${p.where} 对「${s.code || '(无码)'} ${short(s.msg, 42)}」判成 ${got}（期望 ${s.table}）`)
      }
      // `s.col` 为假 = "这一条不核"（各家的列判据认得的码不完全一样，见上面两行样本）
      if (!p.isTable && s.col && p.claimsCol && got !== s.col) {
        mismatches.push(`${p.where} 对「${s.code} ${short(s.msg, 42)}」判成 ${got}（期望 ${s.col}）`)
      }
    }
  }
  eq(
    'D10-B 对照自证：「列不在」判据确实被这条对照核到了（不然上面那条只剩表判据那一半）',
    byPred.filter((p) => !p.isTable && p.claimsCol).length,
    colPreds.length,
    '每一条列判据都要在样本里被核过',
  )
  check(
    mismatches.length === 0,
    `D10-B 对照：${byPred.length} 条真判据 × ${ERROR_SAMPLES.length} 条真错误文案 —— 「列不在」不判成"表不在"，「表不在」都判得出`,
    mismatches.length ? mismatches.join('；') : '全部一致',
  )

  /* ---------------- 🔴 反向对照（必须有，否则这一节就是永远为绿的摆设） ---------------- */

  {
    /* ① 伪造的"表探针 + select('id')" → 必须红（这就是那两个真实例的形状） */
    const fakeProbe = [
      'const sb: any = null',
      'async function probeNoticeTables() {',
      '  const has = async (table: string) => {',
      "    const { error } = await sb.from(table).select('id').limit(1)",
      '    if (error) return false',
      '    return true',
      '  }',
      "  return has('notice_targets')",
      '}',
    ].join('\n')
    const r1 = scanProbeSelects(fakeProbe)
    check(
      r1.hits.length === 1 && r1.exempt.length === 0,
      "D10-A 反向对照①：伪造的探针 `.from(table).select('id')` 被判红",
      `红 ${r1.hits.length} 处 / 豁免 ${r1.exempt.length} 处 → ${r1.hits[0] ?? '（没红，说明判据 A 失效）'}`,
    )

    /* ② 正常的业务查询 `select('id,title')`（**非探针用途**）→ 必须绿（防一刀切） */
    const fakeBiz = [
      'async function loadNoticeById(id: string) {',
      "  const { data } = await sb.from('notices').select('id,title').eq('id', id).maybeSingle()",
      '  return data',
      '}',
    ].join('\n')
    const r2 = scanProbeSelects(fakeBiz)
    check(
      r2.hits.length === 0 && r2.exempt.length === 0 && r2.sites.length === 0,
      "D10-A 反向对照②：非探针用途的 `select('id,title')` **不**被判红（防一刀切）",
      `红 ${r2.hits.length} / 豁免 ${r2.exempt.length} / 站点 ${r2.sites.length}（都期望 0）`,
    )

    /* ③ 正式的"列探针"（判据里有 42703）→ 必须绿（它问的就是那一列） */
    const fakeCol = [
      'async function probeFileClassCols() {',
      "  const { error } = await sb.from('shared_files').select('class_ids').limit(1)",
      "  if (!error) return true",
      "  return !(code === '42703' || /does not exist/i.test(msg))",
      '}',
    ].join('\n')
    const r3 = scanProbeSelects(fakeCol)
    check(
      r3.hits.length === 0 && r3.exempt.length === 1,
      "D10-A 反向对照③：列探针 `select('class_ids')`（判据里有 42703）**不**被判红",
      `红 ${r3.hits.length} / 豁免 ${r3.exempt.length}（期望 0 / 1）→ ${r3.exempt[0] ?? ''}`,
    )

    /* ④ 端到端：拿**真文件**把那一行换回旧写法 → 必须红（证明上面的绿不是因为什么都没扫到） */
    const noticeSrc = readApp('src/lib/notices.ts')
    const poisoned = noticeSrc.replace(".select('*')", ".select('id')")
    const r4 = scanProbeSelects(poisoned)
    check(
      poisoned !== noticeSrc && r4.hits.length === 1,
      'D10-A 反向对照④：真文件（lib/notices.ts）换回 `select(\'id\')` 后判红',
      `红 ${r4.hits.length} 处 → ${r4.hits[0] ?? '（没红：真源码那条探针已经不在了？）'}`,
    )
    const clean = scanProbeSelects(noticeSrc)
    check(
      clean.hits.length === 0,
      'D10-A 正面对照：真文件（lib/notices.ts）原文 0 处红',
      `红 ${clean.hits.length} 处 / 站点 ${clean.sites.length} 处`,
    )
  }

  {
    /* ⑤ 判据 B 的反向对照：三种坏写法必须红，一条好写法必须绿 */
    const badBare = checkTablePredicate("/42P01|PGRST205|does not exist|schema cache/i")
    check(
      badBare.length >= 1,
      'D10-B 反向对照①：裸的 `/does not exist/i`（**历史写法**，就是那次误报的判据）被判红',
      badBare.join('；') || '（没红，说明判据 B 失效）',
    )
    const badCol = checkTablePredicate("code === '42P01' || code === '42703' || code === 'PGRST204'")
    check(
      badCol.length >= 2,
      'D10-B 反向对照②：把 `42703` / `PGRST204` 算进"表不在"被判红',
      badCol.join('；') || '（没红，说明判据 B 失效）',
    )
    const badSilent = checkTablePredicate('/schema cache/i')
    check(
      badSilent.length >= 1,
      'D10-B 反向对照③：认不出 `42P01`（"什么都不认得"）被判红',
      badSilent.join('；') || '（没红，说明判据 B 失效）',
    )
    const okShape = checkTablePredicate('/42P01|PGRST205|Could not find the table|relation .+ does not exist/i')
    check(
      okShape.length === 0,
      'D10-B 正面对照：分流后的写法（`relation` 限定 + 认得 `42P01`）**不**被判红',
      okShape.join('；') || '0 处问题',
    )
    /* ⑥ 防一刀切：**列**判据里带 42703 是它的本职工作，不许被这条判据 B 盯上 */
    check(
      scanMissingPredicates('const MISSING_COL_RE = /42703|PGRST204|column .+ does not exist/i').every(
        (p) => !isTablePredName(p.name),
      ),
      'D10-B 反向对照④：「列不在」判据（名字里是 Col）不归判据 B 管（防一刀切）',
      'MISSING_COL_RE 没被当成"表不在"判据',
    )
  }
}

/* ============================================================
   第十三节 · D11：**"摆不摆入口"由服务端给的那一位布尔决定**
   ============================================================
   两件事（2026-10-09）都是同一个形状 —— 与通知的 `canRevoke`
   （`functions/api/notice.ts` → `lib/notices.ts`）逐字同一套：

     ① 「呼叫学生」那个按钮 —— 判据是数据库的 `can_call(class_id, null)`
        （= `can_call_for()` 的**事务性呼叫**那一支 = `can_manage_class_for()`，§33.2）。
        ⚠️ 前端原来写 `hasManagingRole(myRoles)`（粗档，**不含班主任**）→
        **本班班主任服务端允许、界面上不摆按钮**（这一类 bug 的第三次）。
     ② `teachable` —— 名录里每一行由服务端标"能不能被选去教书"：
        `super`（平台主人）不能，⚠️ **教务处 `admin` 照旧能**（别把真老师筛掉）。

   🔴 这一节要钉住的**不是**"某一行代码长什么样"，而是**判据的位置**：
      前端只读服务端回的那一个布尔，**一个字都不判角色**。
   ============================================================ */
{
  section('第十三节 · D11：入口显隐由服务端的一位布尔定（呼叫学生 / teachable）')

  /* ---- ①-服务端：`classCallable` 那一支问的是裸版 `can_call(…, null)` ---- */
  const callSiteOf = (src) => {
    const at = src.indexOf("action === 'classCallable'")
    return at < 0 ? null : src.slice(at, at + 1600)
  }
  const lookCallSite = (src) => {
    const text = callSiteOf(src)
    if (text === null) return { anchor: false }
    return {
      anchor: true,
      bare: /rpcBool\(\s*env,\s*me\.token,\s*'can_call'\s*,/.test(text),
      noAssignment: /p_assignment_id:\s*null/.test(text),
      returnsBool: /canCall:\s*can\b/.test(text),
      missing: /===\s*'missing'/.test(text),
      /* ⚠️ 不许把 `_for` 变体端给前端（它在 schema 里是 revoke 给 authenticated 的，§16.2） */
      forVariant: /'can_call_for'/.test(text),
    }
  }
  const gradeSrv = readApp('functions/api/grade-setup.ts')
  const c1 = lookCallSite(gradeSrv)
  check(c1.anchor, 'D11-A 锚点自证：服务端有 `action === \'classCallable\'` 那一支', c1.anchor ? '找到了' : '没找到（改名了？那就得改这一节）')
  check(
    c1.bare === true && c1.noAssignment === true,
    'D11-A ① 服务端问的是**裸版 `can_call`**，而且 `p_assignment_id` 传 `null`（= 事务性呼叫那一支，不是"有作业的呼叫"那一支）',
    `can_call=${c1.bare} · 无作业支=${c1.noAssignment}`,
  )
  check(c1.returnsBool === true, 'D11-A ② 服务端回话里带那一位布尔 `canCall`（前端照它摆）', `canCall: can → ${c1.returnsBool}`)
  check(c1.missing === true, 'D11-A ③ 函数不在（第 33 段没跑）时**显式报错**，不静默当 false（否则又冤枉一位班主任）', `处理了 missing → ${c1.missing}`)
  check(c1.forVariant === false, 'D11-A ④ 端给前端的**不是** `_for` 变体（那个在 schema 里 revoke 给 authenticated，端上去线上必 42501）', `出现 'can_call_for' → ${c1.forVariant}`)
  /* 反向对照①：掺进"有作业的呼叫"那一支（`p_assignment_id` 不给 null）→ 判据必须变 */
  const c1poison = lookCallSite(gradeSrv.replace('p_assignment_id: null', 'p_assignment_id: assignmentId'))
  check(
    c1poison.anchor === true && c1poison.noAssignment === false,
    'D11-A 反向对照①：把 `p_assignment_id: null` 改成给一个作业 id → "事务性呼叫那一支"这条**当场红**',
    `无作业支 = ${c1poison.noAssignment}（期望 false）`,
  )
  /* 反向对照②：换成 `_for` 变体 → ④ 必须红 */
  const c1poison2 = lookCallSite(gradeSrv.replace("'can_call'", "'can_call_for'"))
  check(
    c1poison2.bare === false && c1poison2.forVariant === true,
    'D11-A 反向对照②：把 `\'can_call\'` 换成 `\'can_call_for\'` → 上面 ① 与 ④ 一起红',
    `bare=${c1poison2.bare} · forVariant=${c1poison2.forVariant}`,
  )

  /* ---- ①-前端：ClassDetail 一个字都不判角色 ---- */
  /* ⚠️ 判之前**先把注释剔掉**：这一页的注释里刻意留着旧写法（`hasManagingRole(myRoles)`）当留档，
     不剔就会假红（shots.mjs 第 Ⅳ 组同款做法）。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const lookCallPage = (src) => {
    const code = stripComments(src)
    return {
      roleFree: !/\bhasManagingRole\b/.test(code),
      booleanDriven: /\{\s*canCall\s*\?\s*\(/.test(code),
      fromServer: /const canCall = [^\n]*canCall === true/.test(code),
      perClass: /callAuthFor === id/.test(code),
    }
  }
  const classPage = readApp('src/pages/ClassDetail.tsx')
  const p1 = lookCallPage(classPage)
  check(p1.roleFree, 'D11-B ① `ClassDetail.tsx` 的**代码里**一个字都不提 `hasManagingRole`（前端不许自己推断角色；注释里留档不算）', `出现 → ${!p1.roleFree}`)
  check(p1.booleanDriven, 'D11-B ② 「呼叫学生」那个按钮的条件**就是** `canCall`（服务端回的那一位布尔）', `{ canCall ? ( → ${p1.booleanDriven}`)
  check(p1.fromServer, 'D11-B ③ `canCall` 由 `readCanCall()` 的结论算出来（`canCall === true`），不是本地拼的', `→ ${p1.fromServer}`)
  check(p1.perClass, 'D11-B ④ 结论认**班级 id**（换班时不把上一个班的结论当成这个班的）', `→ ${p1.perClass}`)
  /* 反向对照③：改回原来那种写法（前端判角色）→ ① 与 ② 一起红 */
  const p1poison = lookCallPage(classPage.replace('{canCall ? (', '{hasManagingRole(myRoles) ? ('))
  check(
    p1poison.roleFree === false && p1poison.booleanDriven === false,
    'D11-B 反向对照③：把按钮改回 `hasManagingRole(myRoles)`（**这就是那个 bug 的形状**）→ ① 与 ② 一起红',
    `roleFree=${p1poison.roleFree} · booleanDriven=${p1poison.booleanDriven}`,
  )

  /* ============================================================
     D11-C 🆕 2026-10-14：**ClassDetail 那一格老师名不许印 UUID**（`schema.sql` §44「超管隐身」）
     ------------------------------------------------------------
     病根（本节就是钉它）：那一格的名字是从 `listTeachers()`（`/api/teacher-account` 的 `list`）
     认的，而那个接口**只有能建号的三档**（超管 / 教务处 / 办公室主任）进得去 ——
     普通教师 / 班主任 / 年级主任调它是 **403**。旧写法 `t?.name ?? tid`
     ⇒ 他们看到的是 **UUID**（`bedabab0-7cf1-…` 那种），比空白更糟：
     UUID 是账号的身份信息，而且这一位还会当 `authorName` 写进值日记录。

     ⚠️ 只做**纸面判据**（同 D11-B 的做法）：这一页跑起来要真 Supabase，
        能不能在浏览器里挂起来是 `shots` 的事，这里钉的是"源码里那句兜底还在不在"。
     🔴 反向对照：把 `?? tid` 写回去 ⇒ ① 必须红（**先数出现次数，不是 1 就抛错**，防假绿）。
     ============================================================ */
  {
    /** 判据只看代码、不看注释（注释里刻意留着旧写法当留档 —— 与 D11-B 同款） */
    const lookUuidLeak = (src) => {
      const code = stripComments(src)
      /* 只盯"老师名那一格"这一小段：从 `const tid =` 到 `setTeacherNameHidden(` 收口 */
      const at = code.indexOf('const tid = rows[0].teacherId')
      const seg = at < 0 ? '' : code.slice(at, at + 1400)
      return {
        anchor: at >= 0 && seg.includes('setTeacherNameHidden('),
        noTidFallback: !/\?\?\s*tid\b/.test(seg),
        usesList: /await listTeachers\(\)/.test(seg),
        neutral: /teacherNameHidden/.test(stripComments(src)),
      }
    }
    const u1 = lookUuidLeak(classPage)
    check(u1.anchor, 'D11-C 前置：能定位到"走班班老师名"那一小段（定位不到下面全是空断言）', `anchor=${u1.anchor}`)
    check(u1.usesList, 'D11-C ① 那一格的名字确实来自 `listTeachers()`（= 非建号档必然 403 的那条路）', `usesList=${u1.usesList}`)
    check(
      u1.noTidFallback,
      '🔴 D11-C ② 认不出名字时**不把 UUID 当兜底**（`?? tid` 一处都不许有）',
      `noTidFallback=${u1.noTidFallback}`,
    )
    check(
      u1.neutral,
      '🔴 D11-C ③ 认不出名字时走**中性标签**那一支（`teacherNameHidden`），不是"什么都不说"',
      `neutral=${u1.neutral}`,
    )
    /* 🧪 反向对照：把旧写法写回去 —— ② 必须当场假 */
    const LEAK = "const known = t?.name?.trim() ? t.name : ''"
    if (classPage.split(LEAK).length - 1 !== 1) {
      throw new Error(`D11-C 反向对照锚点不唯一（期望 1 处，实际 ${classPage.split(LEAK).length - 1} 处）—— 宁可报错，也不假绿`)
    }
    const uPoison = lookUuidLeak(classPage.replace(LEAK, 'const known = t?.name ?? tid'))
    check(
      uPoison.noTidFallback === false,
      '🧪 D11-C 反向对照：把兜底改回 `t?.name ?? tid`（**这就是那个 bug 的形状**）⇒ ② 当场红',
      `noTidFallback=${uPoison.noTidFallback}`,
    )
  }

  /* ---- ②-服务端：`teachable` 只排除 `super` ---- */
  const dirSrv = readApp('functions/api/teacher-account.ts')
  const lookTeachable = (src) => {
    const at = src.indexOf('teachable:')
    if (at < 0) return { anchor: false }
    const own = src.slice(at, at + 220)
    return {
      anchor: true,
      own,
      onlySuper: /x\.role === 'super'/.test(own),
      /* ⚠️ 判据里**不许出现 admin** —— 教务处那一档要照旧能选 */
      notAdmin: !/'admin'/.test(own),
      roomFiltered: /\.filter\(\(t\) => !roomIds\.has\(t\.id\)\)/.test(src),
    }
  }
  const t1 = lookTeachable(dirSrv)
  check(t1.anchor, 'D11-C 锚点自证：名录里每一行带 `teachable` 那一位布尔', t1.anchor ? '找到了' : '没找到')
  check(t1.onlySuper, 'D11-C ① 判据 = **有 `super` 身份就不 teachable**（平台主人不该被选去教书）', `→ ${t1.onlySuper}`)
  check(t1.notAdmin, 'D11-C ② 这一支里**没有 `admin`** —— 教务处照旧能选（别把真老师筛掉）', `出现 'admin' → ${!t1.notAdmin}`)
  check(t1.roomFiltered, 'D11-C ③ 教室端账号在名录里**先被剔掉**（`classroom_accounts` 那几行根本不进列表）', `→ ${t1.roomFiltered}`)
  /* 反向对照④：判据顺手加上 admin → ② 必须红（正是"把真老师筛掉"那一种坏法） */
  const t1poison = lookTeachable(dirSrv.replace("x.role === 'super'", "x.role === 'super' || x.role === 'admin'"))
  check(
    t1poison.notAdmin === false,
    'D11-C 反向对照④：判据顺手把 `admin` 也排除 → ② **当场红**（教务处被当成了不该教书的人）',
    `出现 'admin' → ${!t1poison.notAdmin}`,
  )
  /* 反向对照⑤：删掉教室端过滤 → ③ 必须红 */
  const t1poison2 = lookTeachable(dirSrv.replace('    .filter((t) => !roomIds.has(t.id))\n', ''))
  check(
    t1poison2.roomFiltered === false,
    'D11-C 反向对照⑤：删掉"剔掉教室端账号"那一句 → ③ **当场红**',
    `→ ${t1poison2.roomFiltered}`,
  )

  /* ---- ②-前端：名录那一份布尔只用来**筛下拉**，「教师管理」不筛 ---- */
  const accountsLib = readApp('src/lib/accounts.ts')
  check(
    /export function teachableOnly\(list: readonly DirTeacher\[\]\): DirTeacher\[\] \{\s*return list\.filter\(\(t\) => t\.teachable\)/.test(accountsLib),
    'D11-D ① 筛的口子只有一处（`lib/accounts.ts` 的 `teachableOnly()`，判据就是服务端那一位布尔）',
    '`teachableOnly()` 的形状对',
  )
  const gsPage = readApp('src/pages/GradeSetup.tsx')
  eq(
    'D11-D ② 「开学准备」四处"选老师教书"的下拉全走 `teachableOnly()`（年级主任 / 班主任 / 批量任教关系 / 走班班老师）',
    (gsPage.match(/teachableOnly\(teachers\)/g) ?? []).length,
    4,
  )
  eq(
    'D11-D ③ 那四处**没有**漏网的 `teachers.map(`（漏一处 = 平台主人又出现在某个下拉里）',
    (gsPage.match(/\{teachers\.map\(/g) ?? []).length,
    0,
  )
  const classesPage = readApp('src/pages/Classes.tsx')
  eq(
    'D11-D ④ 走班班的「走班老师」也走 `teachableOnly()`',
    (classesPage.match(/teachableOnly\(teachers\)\.map\(/g) ?? []).length,
    1,
  )
  eq(
    'D11-D ⑤ 那里也没有漏网的 `{teachers.map(`',
    (classesPage.match(/\{teachers\.map\(/g) ?? []).length,
    0,
  )
  const taPage = readApp('src/pages/TeacherAccounts.tsx')
  eq(
    'D11-D ⑥ 「教师管理」**不筛**（管理名单要看见所有人）—— 三处名录照旧列全部',
    (taPage.match(/dir\.teachers\.map\(/g) ?? []).length,
    3,
  )
  check(
    !/teachableOnly/.test(taPage),
    'D11-D ⑦ 「教师管理」里读标记但**不用它筛**（`teachable` 只用来写一个标签）',
    `出现 teachableOnly → ${/teachableOnly/.test(taPage)}`,
  )
  check(
    /!\s*t\.teachable\s*\?/.test(taPage),
    'D11-D ⑧ 「教师管理」那一行真的**读了**标记（`!t.teachable` → 一个标签）—— 否则 ⑥ 就是"白不筛"',
    `读到 → ${/!\s*t\.teachable\s*\?/.test(taPage)}`,
  )
  /* 反向对照⑥：把「教师管理」的主名单也筛一遍 → ⑥ 必须红（3 → 2） */
  const taPoison = taPage.replace('dir.teachers.map((t) => (', 'teachableOnly(dir.teachers).map((t) => (')
  check(
    (taPoison.match(/dir\.teachers\.map\(/g) ?? []).length !== 3,
    'D11-D 反向对照⑥：把「教师管理」也按 `teachable` 筛 → ⑥ **当场红**（那正是"把 super 从名单里删掉"）',
    `改后 = ${(taPoison.match(/dir\.teachers\.map\(/g) ?? []).length}（期望 ≠ 3）`,
  )
}

/* ============================================================
   第十四节 · D12：**念出来的号 / 摆上屏的号 = 班内学号**（档案键只当键）
   ------------------------------------------------------------
   🔴 用户原话（2026-10-12）：
      「**呼叫后教室端播报的应该是学生的班级内学号，而不是年级序列号**」

   平台有**两套号**（`lib/keys.ts` 文件头 / I40）：
     · `students.serial`    = 全校唯一序列号（7 位 `YYYY`+`NNN`）——
                              **是那 10 个字段的键**，生成后永久不可改；
     · `students.studentNo` = **班内学号** —— 老师与学生认的就是它。
   判据只有一句：**给人看 / 念给人听的号，一律是班内学号；当键用的地方一个字都不许动。**

   为什么要有这一节：拼"念出来的话"的地方有三处，其中**改错登记页**
   （`AssignmentCorrect.tsx`）一直把**档案键**直接交给 `composeCallText()` →
   教室端念出「请 **2025007** 号…」（= 序列号），学生不知道那是在叫谁。
   纯逻辑断言在 A 组、静态钉子在 D 组，每条都带**反向对照**（喂修之前的写法必须判红）。

   ⚠️ 豁免只两处（`eqSet` 钉住，多一处就要来这儿说清）：
     · `src/lib/keys.ts`   —— **唯一入口**：翻译本来就长在这里；
     · `src/lib/stream.ts` —— `labelOf()` 是 **`pending` / `noRecord` 的排序键**（不上屏）；
        ⚠️ 它上面那句注释写的是"序列号优先，因为它全校唯一"，与本仓库的主导口径
        （`keys.ts:70`「界面上永远显示班内学号」）**不一致** —— 本轮**超出文件边界没动它**，
        留在这里让它可见；要么下轮统一，要么把那句注释改对。
   ============================================================ */
section('第十四节 · D12：念出来的号 = 班内学号（`serial` 只当键）')

{
  const K = await import('../src/lib/keys.ts')
  const CALLS = await import('../src/lib/calls.ts')

  /** 夹具：两个学生，键（序列号）与给人看的号（班内学号）**故意长得完全不一样** */
  const ROSTER = [
    { serial: '2025007', studentNo: '12', name: '甲' },
    { serial: '2025008', studentNo: '3', name: '乙' },
  ]
  const KEYS_ = ['2025007', '2025008']
  const ROOM = '物理老师办公室'

  eq(
    '🔴 D12-A ① 一批**键** → 一批**给人看的号**（= 班内学号）',
    JSON.stringify(K.displayNosOfArchiveKeys(ROSTER, KEYS_)),
    JSON.stringify(['12', '3']),
  )
  eq(
    'D12-A ② **老键**（迁移前的班内学号）照样翻得出（兼容期两条路）',
    JSON.stringify(K.displayNosOfArchiveKeys(ROSTER, ['12', '3'])),
    JSON.stringify(['12', '3']),
  )
  eq(
    'D12-A ③ 翻不出来的键**原样留着**（不许变空串 —— 空 = 把一个学生从名单里静默抹掉，§三.5）',
    JSON.stringify(K.displayNosOfArchiveKeys(ROSTER, ['9999999'])),
    JSON.stringify(['9999999']),
  )

  /* ---- B：真函数串起来 —— 教室端**念出来的那句话** ---- */
  const said = CALLS.composeCallText(K.displayNosOfArchiveKeys(ROSTER, KEYS_), ROOM, '物理', '')
  eq('🔴 D12-B ① 教室端念的是**班内学号**', said, '请 12 号、3 号，到物理老师办公室。')
  check(
    !/2025\d{3}/.test(said),
    '🔴 D12-B ② 那句话里**一个 7 位序列号都没有**（序列号是内部键，念给学生听毫无意义）',
    said,
  )
  /* 反向对照：把**修之前的写法**（键直传）喂进来 → 序列号就出来了（证明上面两条不是恒真） */
  const saidBeforeFix = CALLS.composeCallText(KEYS_, ROOM, '物理', '')
  check(
    /2025007/.test(saidBeforeFix),
    '🧪 D12-B 反向对照：**把键原样交给 `composeCallText()`**（= 修之前那一行）→ 念出来的是 7 位序列号（所以 ① 会红）',
    `改回旧写法 = ${saidBeforeFix}`,
  )

  /* ---- C：**键**这条路一个字都没动（反向对照：把键也换成班内学号 → 必须红） ---- */
  eq('🔴 D12-C ① `archiveKeyOf()` 给的还是**序列号**（写库/存档用的键没被动过）', K.archiveKeyOf(ROSTER[0]), '2025007')
  eq(
    '🔴 D12-C ② 键候选顺序仍是 [序列号, 班内学号]（读的两条路：**序列号优先**）',
    JSON.stringify(K.archiveKeyCandidates(ROSTER[0])),
    JSON.stringify(['2025007', '12']),
  )
  eq(
    'D12-C ③ 没有序列号时键退回班内学号（老库上的行为一个字节都不变）',
    K.archiveKeyOf({ serial: '', studentNo: '7' }),
    '7',
  )
  eq(
    'D12-C ④ `archiveValue()` 认序列号那一格（键还是键）',
    JSON.stringify(K.archiveValue({ 2025007: ['3'] }, ROSTER[0])),
    JSON.stringify(['3']),
  )
  /* 反向对照：把键也换成班内学号（这正是"绕过 P1 迁移"的形状）——
     同一个断言体必须判**假**；否则上面那四条只是摆设 */
  const keyOfPoison = (s) => s.studentNo
  check(
    keyOfPoison(ROSTER[0]) !== '2025007' && K.archiveKeyCandidates(ROSTER[0])[0] === '2025007',
    '🧪 D12-C 反向对照：把键也换成班内学号 → D12-C ① **当场红**（而 ② 的"序列号优先"正是挡住这一步的那一条）',
    `改后 archiveKeyOf(甲) = ${keyOfPoison(ROSTER[0])}（期望 ≠ 2025007）`,
  )

  /* ---- D：全仓"自己写 `x.serial || x.studentNo` 去显示"= 0 处（纪律 → 能跑的断言） ---- */
  const D12_EXEMPT = new Set([
    'src/lib/keys.ts', // 唯一入口：翻译本来就长在这里
    'src/lib/stream.ts', // labelOf()：**排序键**，不上屏（见本节头部的说明）
  ])
  const D12_SHAPES = [
    /\.serial\s*\|\|\s*[\w$]+\.studentNo/, // `s.serial || s.studentNo`
    /\.serial\s\?[^\n]{0,140}?\.studentNo\s\?/, // 「序列号优先」的三元
  ]
  /* ⚠️ 只扫**真代码行**：整行是注释的不算（`keys.ts` / `Admin.tsx` 的文件头就在写这条纪律本身，
     里面**故意**有那个坏形状的字面量）。判据只认"这一行上真有那个表达式"。 */
  const isCommentOnly = (line) => {
    const t = line.trim()
    return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
  }
  const d12Files = []
  const walkD12 = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walkD12(full)
      else if (/\.tsx?$/.test(e.name)) d12Files.push(full)
    }
  }
  walkD12(join(APP, 'src'))
  const d12Hits = []
  for (const f of d12Files) {
    const rel = f.slice(APP.length + 1).replace(/\\/g, '/')
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isCommentOnly(line)) return
        for (const re of D12_SHAPES) if (re.test(line)) d12Hits.push({ file: rel, line: i + 1, text: short(line, 110) })
      })
  }
  const d12Bad = d12Hits.filter((h) => !D12_EXEMPT.has(h.file))
  check(
    d12Files.length >= 40,
    `D12-D 自证：扫到 ${d12Files.length} 个 .ts/.tsx（少于 40 说明锚点坏了，不是"全绿"）`,
    `${d12Files.length} 个`,
  )
  check(
    d12Bad.length === 0,
    '🔴 D12-D ① 全仓没有一处"自己写 `x.serial || x.studentNo` 去显示/念号"（翻译只许走 `lib/keys.ts`）',
    d12Bad.length ? d12Bad.map((h) => `${h.file}:${h.line} ${h.text}`).join('；') : `0 处红（命中 ${d12Hits.length} 处，全在豁免清单里）`,
  )
  eqSet(
    'D12-D ② 自证：豁免清单 = 唯一入口 + 一处**排序键**（多一处就要来这儿说清它为什么该在）',
    d12Hits.filter((h) => D12_EXEMPT.has(h.file)).map((h) => h.file),
    ['src/lib/keys.ts', 'src/lib/stream.ts'],
  )
  /* 反向对照：把旧写法（两种形状）喂给同一个判据 → 必须都被抓到 */
  const D12_POISON = [
    'const no = a.serial || b.studentNo',
    '  {p.serial ? ` （${p.serial}）` : p.studentNo ? ` （${p.studentNo}）` : ""}',
    '  <td>{s.serial ? s.serial : s.studentNo ? s.studentNo : ""}</td>',
  ]
  const poisonHit = D12_POISON.filter((l) => D12_SHAPES.some((re) => re.test(l)))
  eq(
    '🧪 D12-D 反向对照①：把旧写法（`||` 与"序列号优先"的三元）喂给同一判据 → **三种全被抓**',
    poisonHit.length,
    D12_POISON.length,
  )
  /* 反向对照②：**真文件**改回序列号优先 → 上面 ① 当场红（拿真内容做替换，不靠手写的字面量） */
  const BT = String.fromCharCode(96)
  const gsSrc = readApp('src/pages/GradeSetup.tsx')
  const gsFixed = gsSrc.split('\n').filter((l) => l.includes('（${p.studentNo}）'))
  eq(
    '🔴 D12-D ③ `GradeSetup.tsx` 那两处（待处理 / 选科还没录）的括号号 = **班内学号优先**（序列号只当兜底）',
    gsFixed.length,
    2,
  )
  const gsPoison = gsSrc.replace(
    new RegExp('p\\.studentNo \\? ' + BT + ' （\\$\\{p\\.studentNo\\}）' + BT + ' : p\\.serial', 'g'),
    'p.serial ? ' + BT + ' （${p.serial}）' + BT + ' : p.studentNo',
  )
  check(
    gsPoison !== gsSrc && D12_SHAPES.some((re) => gsPoison.split('\n').some((l) => re.test(l))),
    '🧪 D12-D 反向对照②：把那两处**改回「序列号优先」** → D12-D ①/③ 当场红',
    gsPoison === gsSrc ? '没替换成功（锚点变了？那这条对照就是摆设，必须修）' : '替换成功，且被判据抓到',
  )

  /* ---- E：拼"念出来的话"的地方只有三处，而且每一处的号都是给人看的 ---- */
  /** 从一段源码里抠出每一处 `composeCallText(` 的**第一个实参**（括号/引号配平到第一个顶层逗号） */
  function callTextFirstArgs(src) {
    const out = []
    const re = /(?<![\w.$])composeCallText\s*\(/g
    let m
    while ((m = re.exec(src))) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 24), m.index))) continue // 定义处
      let i = m.index + m[0].length
      let depth = 0
      let arg = ''
      for (; i < src.length; i++) {
        const ch = src[i]
        if (ch === "'" || ch === '"' || ch === BT) {
          const quote = ch
          arg += ch
          for (i++; i < src.length && src[i] !== quote; i++) arg += src[i]
          arg += src[i] ?? ''
          continue
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === ')' || ch === ']' || ch === '}') {
          if (depth === 0) break
          depth--
        } else if (ch === ',' && depth === 0) break
        arg += ch
      }
      out.push({ line: src.slice(0, m.index).split('\n').length, arg: arg.trim() })
      re.lastIndex = i
    }
    return out
  }
  /** "给人看的号"的两种合法写法：走唯一入口，或页面手里本来就是 `Student`（`.studentNo`） */
  const DISPLAY_ARG_OK = [
    /displayNos?OfArchiveKeys?\s*\(/,
    /\.map\(\s*\(\s*[\w$]+\s*\)\s*=>\s*[\w$]+\.studentNo\s*\)/,
  ]
  const callSites = []
  for (const f of d12Files) {
    const rel = f.slice(APP.length + 1).replace(/\\/g, '/')
    const lines = readFileSync(f, 'utf8').split('\n')
    for (const s of callTextFirstArgs(lines.join('\n'))) {
      /* 整行是注释的不算（`keys.ts` 的文件头就在讲这条纪律本身，里面**故意**
         写了一个 `composeCallText(…)` 的字面量当反例） */
      if (isCommentOnly(lines[s.line - 1] ?? '')) continue
      callSites.push({ file: rel, ...s })
    }
  }
  const callBad = callSites.filter((s) => !DISPLAY_ARG_OK.some((re) => re.test(s.arg)))
  eq('D12-E 自证：拼"念出来的话"的地方 = 3 处（多一处就要来这儿说清）', callSites.length, 3)
  eqSet(
    'D12-E 自证：这三处分别是哪个文件',
    callSites.map((s) => s.file),
    ['src/pages/AssignmentCall.tsx', 'src/pages/AssignmentCorrect.tsx', 'src/pages/ClassDetail.tsx'],
  )
  check(
    callBad.length === 0,
    '🔴 D12-E ① 每一处"念出来的话"的第一个实参都是**给人看的号**（不是档案键）',
    callBad.length
      ? callBad.map((s) => `${s.file}:${s.line} → ${short(s.arg, 80)}`).join('；')
      : callSites.map((s) => `第 ${s.line} 行 → ${short(s.arg, 60)}`).join('；'),
  )
  /* 反向对照：把改错页改回"键直传" → 当场红；两种合法写法**不**判红（防一刀切） */
  const poisonSite = callTextFirstArgs("composeCallText(callSel, room, assignment.subject, '')")
  check(
    poisonSite.length === 1 && !DISPLAY_ARG_OK.some((re) => re.test(poisonSite[0].arg)),
    '🧪 D12-E 反向对照①：把改错页改回 `composeCallText(callSel, …)`（**键直传，就是那个 bug**）→ 当场红',
    `抠出的第一个实参 = ${poisonSite[0]?.arg ?? '(没抠到)'}`,
  )
  const okSites = [
    "composeCallText(displayNosOfArchiveKeys(students, callSel), room, assignment.subject, '')",
    "composeCallText(selected.map((k) => displayNoOfArchiveKey(students, k)), room, subject, custom)",
    "composeCallText(picked.map((s) => s.studentNo), klass.name, '', callText.trim())",
  ]
  const okParsed = okSites.map((s) => callTextFirstArgs(s)[0]?.arg ?? '')
  check(
    okParsed.length === 3 && okParsed.every((a) => DISPLAY_ARG_OK.some((re) => re.test(a))),
    '🧪 D12-E 反向对照②：三种**合法**写法（批量入口 / 单个入口 / 页面手里本来就是 Student）都**不**判红（防一刀切）',
    okParsed.map((a) => short(a, 60)).join(' · '),
  )
  const poisonSelf = callTextFirstArgs("composeCallText(s.serial || s.studentNo, room, '', '')")[0]?.arg ?? ''
  check(
    !DISPLAY_ARG_OK.some((re) => re.test(poisonSelf)) && D12_SHAPES.some((re) => re.test(poisonSelf)),
    '🧪 D12-E 反向对照③：`s.serial || s.studentNo` 这种"自己翻译"喂进来 → 被 D 与 E 两条一起抓',
    `第一个实参 = ${poisonSelf}`,
  )
}

/* ============================================================
   第十五节 · D13：**自己改密码**只作用自己 + 失败必须显式报错
   ------------------------------------------------------------
   🔴 用户 2026-10-11 原话：
      「**加一个吧，都放在我的页面的那个身份卡里面**」

   为什么这件事**必须**存在：平台把**最高管理员锁死为一个**（`teacher_roles_one_super`），
   他自己忘了密码**没人能给他重置** —— 只能自己改。所以入口在
   `Settings.tsx` 那张 `title="我的身份"` 的 Sheet 里（用户点名：和姓名 / 主学科并列）。

   为什么这一节有四组断言（都不是摆设）：
     · A —— 三档失败各自的文案。§三.5：不可写的路径要**显式报错**，
            而"太短 / 两次不一致 / 旧密码没填"是三种不同的错，**不许一句话概括**；
     · B —— 全仓**没有**"拿别人的 id 去改密码"的路（更新只作用当前会话自己）；
     · C —— 旧密码那道坎**真的在**（`signInWithPassword` **先于** `updateUser`），
            而且它挂在验证之后 —— 少了它，"手机被人拿去"就能把原主人永久锁在外面；
     · D —— 失败**上屏**（`role="alert"` + 真按钮），不是只写在注释里。

   每条都带反向对照（喂"修之前的写法"必须判红）；对照本身也证过能红。
   ============================================================ */
section('第十五节 · D13：自己改密码（只作用自己 · 失败显式上屏）')

{
  const SET = 'src/pages/Settings.tsx'
  const settingsSrc = readApp(SET)

  /* ---- A：三档失败各自的文案（**从源码里抠出那个真函数**来跑，不是复刻一份） ---- */
  const mFn = settingsSrc.match(/function pwdIssue\([\s\S]*?\n\}/)
  check(
    Boolean(mFn),
    'D13-A 锚点自证：`Settings.tsx` 里有 `function pwdIssue()`（抠不到就说明它改名了，这一节得跟着改）',
    mFn ? short(mFn[0], 90) : '没找到',
  )
  let pwdIssue = () => {
    throw new Error('没抠到 pwdIssue')
  }
  let fnErr = ''
  try {
    /*
     * ⚠️ 两个必须处理的坑（都踩过一次）：
     *   ① `export ` 在 `new Function()` 的函数体里是语法错误；
     *   ② `new Function()` 只吃 **JS**，而源码是 TS —— 类型注解要逐处剥掉。
     *      只处理"函数签名 + 返回值类型"这一小块，体**一个字都不动**。
     */
    const fnSrc = (mFn?.[0] ?? '')
      .replace(/^export\s+/, '')
      .replace(/^function\s+\w+\s*\(([^)]*)\)\s*:\s*[^{]+/, (s, params) =>
        `function pwdIssue(${params.replace(/:\s*[^,)]+/g, '')})`,
      )
    pwdIssue = new Function(`${fnSrc}; return pwdIssue`)()
  } catch (e) {
    fnErr = e instanceof Error ? e.message : String(e)
  }
  check(
    typeof pwdIssue === 'function' && pwdIssue('old-pwd-8', 'newpass-9', 'newpass-9') === null,
    'D13-A 锚点自证②：抠出来的**就是**那个函数（合格输入回 null —— 证明没抠成半截）',
    fnErr ? `求值失败：${fnErr}` : `typeof = ${typeof pwdIssue}`,
  )

  const iOld = pwdIssue('', 'x'.repeat(10), 'x'.repeat(10))
  check(
    typeof iOld === 'string' && iOld.includes('现在的密码'),
    '🔴 D13-A ① 旧密码没填 → 报一句"请输入现在的密码"（**不是**静默提交）',
    `pwdIssue('', 10 位, 10 位) → ${JSON.stringify(iOld)}`,
  )
  const iShort = pwdIssue('old-pwd-8', 'short7c', 'short7c')
  check(
    typeof iShort === 'string' && iShort.includes('至少 8 位'),
    '🔴 D13-A ② 新密码太短（7 位）→ 报"至少 8 位"并说出**现在几位**',
    `7 位 → ${JSON.stringify(iShort)}`,
  )
  const iMiss = pwdIssue('old-pwd-8', 'newpass-9a', 'newpass-9b')
  check(
    typeof iMiss === 'string' && iMiss.includes('不一致'),
    '🔴 D13-A ③ 两次不一致 → 报"两次输入的新密码不一致"（**文案与"太短"必须不同**）',
    `→ ${JSON.stringify(iMiss)}`,
  )
  check(
    typeof iShort === 'string' && typeof iMiss === 'string' && iShort !== iMiss,
    '🔴 D13-A ④ 两档的文案**不是同一句**（"一句话概括所有失败"= 把原因吃掉）',
    `太短 = ${JSON.stringify(iShort)} vs 不一致 = ${JSON.stringify(iMiss)}`,
  )
  const iSame = pwdIssue('same-pwd-8', 'same-pwd-8', 'same-pwd-8')
  check(
    typeof iSame === 'string' && iSame.includes('不能和现在的密码一样'),
    'D13-A ⑤ 新密码和旧密码一样 → 也拦下（还有第 4 档文案）',
    `→ ${JSON.stringify(iSame)}`,
  )
  eq('D13-A ⑥ 三格都合格 → `null`（**放行**；三档里任何一档恒真，上面几条就是摆设）', pwdIssue('old-pwd-8', 'newpass-9', 'newpass-9'), null)

  /* ---- 反向对照（A）：喂"修之前的写法"（不校验）必须判红 ---- */
  const lazyIssue = () => null
  const lazyOk = lazyIssue('', 'x', 'y') === null
  check(
    lazyOk &&
      !(pwdIssue('', 'x', 'y') === null) &&
      !(pwdIssue('old-pwd-8', 'short7c', 'short7c') === null),
    '🧪 D13-A 反向对照：把校验改成"永远放行" → ① ② 当场判红（三档失败**真的**被拦下来了）',
    `不校验版('', 'x', 'y') = ${lazyOk ? 'null（= 恒过的摆设）' : '有拦'} · 真函数('', 'x', 'y') = ${JSON.stringify(pwdIssue('', 'x', 'y'))}`,
  )
  eq(
    '🧪 D13-A 反向对照②：把新密码填到 **8 位**就不再报"太短"（边界真的在 8，不是随手写的数）',
    pwdIssue('old-pwd-8', '12345678', '12345678'),
    null,
  )

  /* ---- A'：8 位这个下限与**建号那一支同一个数**（一个平台一个口径） ---- */
  const fnSrc = readApp('functions/api/teacher-account.ts')
  check(
    /password\.length\s*<\s*8/.test(fnSrc) && /初始密码至少 8 位/.test(fnSrc),
    'D13-A ⑦ 下限 8 与建号那支**同一个数**（`functions/api/teacher-account.ts` 的「初始密码至少 8 位」）',
    `服务端那一句在 = ${/password\.length\s*<\s*8/.test(fnSrc)}`,
  )
  /* 🧪 反向对照：把服务端那个数改成 6 → 上面那条必须红（证明它真的在比对那个字面量） */
  const fnPoison = fnSrc.replace('password.length < 8', 'password.length < 6')
  check(
    !(/password\.length\s*<\s*8/.test(fnPoison) && /初始密码至少 8 位/.test(fnPoison)),
    '🧪 D13-A ⑧ 反向对照：把服务端改成 6 位 → ⑦ 当场红（两个数一旦分家就会被抓住）',
    `改后两个条件同时成立 = ${/password\.length\s*<\s*8/.test(fnPoison) && /初始密码至少 8 位/.test(fnPoison)}`,
  )

  /* ---- B：入口就在「我的身份」那张卡里 + **只作用自己**（静态） ---- */
  const sheetAt = settingsSrc.indexOf('title="我的身份"')
  check(
    sheetAt > 0,
    'D13-B 锚点自证：找得到那张 `title="我的身份"` 的 Sheet（找不到就说明它改名了，这一节得跟着改）',
    `偏移 ${sheetAt}`,
  )
  const sheetEnd = settingsSrc.indexOf('</Sheet>', sheetAt)
  const sheetBody = sheetAt > 0 && sheetEnd > sheetAt ? settingsSrc.slice(sheetAt, sheetEnd) : ''
  check(
    /data-change-password[^>]*>/.test(sheetBody) && /<span className="label">改密码<\/span>/.test(sheetBody),
    '🔴 D13-B ① 「改密码」那一块**就在「我的身份」那张卡里**（用户点名：放在身份卡里，与姓名 / 主学科并列）',
    `卡内出现「改密码」标题 = ${/<span className="label">改密码<\/span>/.test(sheetBody)} · 卡内长度 ${sheetBody.length}`,
  )
  eq('D13-B ② 那张卡里三个密码格**都真的摆了**（现在的密码 / 新密码 / 再输一遍新密码）', (sheetBody.match(/type="password"/g) ?? []).length, 3)
  check(
    /onClick=\{\(\) => void doChangePassword\(\)\}/.test(sheetBody),
    'D13-B ③ 那一块点下去走的是 `doChangePassword()`（不是把密码丢进 `updateTeacher` 的载荷里）',
    `找到调用点 = ${/doChangePassword\(\)/.test(sheetBody)}`,
  )
  /* 注释里也写着 `updateUser`（那是**留档**，不是代码）——所以这一组全部在**剔掉注释之后**量 */
  const SET_CODE = settingsSrc
    .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const upd = [...SET_CODE.matchAll(/\.auth\.updateUser\(/g)]
  eq('🔴 D13-B ④ `updateUser(` 在 `Settings.tsx` 的真代码里**恰好 1 处**（多一处就要来这儿说清）', upd.length, 1)
  check(
    /\.auth\.updateUser\(\{\s*password\s*:/.test(SET_CODE),
    '🔴 D13-B ⑤ 那一处**只带 `password` 一个键**（没有 `email` / 没有别人的 `userId`）—— 改的是"我的密码"',
    `带 password 的调用 = ${/\.auth\.updateUser\(\{\s*password\s*:/.test(SET_CODE)}`,
  )
  check(
    /sb\??\.auth\.getUser\(\)/.test(SET_CODE),
    '🔴 D13-B ⑥ 账号身份来自 `sb.auth.getUser()`（**当前会话**），不是从参数 / 路由 / store 里拿一个 id',
    `getUser 在 = ${/sb\??\.auth\.getUser\(\)/.test(SET_CODE)}`,
  )
  check(
    !/updateUserById|admin\.updateUser|admin\.createUser|service_role|SERVICE_ROLE/i.test(settingsSrc),
    '🔴 D13-B ⑦ `Settings.tsx` 里**没有**任何"替别人改密码"的手段（`updateUserById` / `admin.*` / `service_role`）',
    `命中 = ${(settingsSrc.match(/updateUserById|admin\.updateUser|admin\.createUser|service_role|SERVICE_ROLE/gi) ?? []).join('、') || '0 处'}`,
  )

  /* 🔴 B'：**全仓**扫一遍 —— 有且只有 Settings.tsx 那一处（别人的 id 改密码是绝对禁线） */
  const SRC_ROOT = join(APP, 'src')
  const walk = (d, exts = /\.tsx?$/) => {
    const out = []
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const p = join(d, e.name)
      if (e.isDirectory()) out.push(...walk(p, exts))
      else if (exts.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p)
    }
    return out
  }
  const srcFiles = walk(SRC_ROOT)
  check(srcFiles.length >= 40, `D13-B ⑧ 扫到 ${srcFiles.length} 个 .ts/.tsx（自证不是"什么都没扫到"）`, `根：${SRC_ROOT}`)
  const updHits = srcFiles
    .map((f) => ({ rel: f.slice(APP.length + 1).replace(/\\/g, '/'), txt: readFileSync(f, 'utf8') }))
    .filter((x) => x.txt.includes('updateUser'))
  eqSet('🔴 D13-B ⑨ 全仓**碰 `updateUser` 的文件只有 Settings.tsx 一个**（别人那儿一处都不许有）', updHits.map((x) => x.rel), [SET])
  const updTotal = updHits.reduce((n, x) => n + (x.txt.match(/\.auth\.updateUser\(/g) ?? []).length, 0)
  eq('🔴 D13-B ⑩ 全仓 `.auth.updateUser(` 合计**恰好 1 处**（= 它只改自己的会话）', updTotal, 1)
  check(
    !srcFiles.some((f) => /updateUserById|admin\.updateUserById/.test(readFileSync(f, 'utf8'))),
    '🔴 D13-B ⑪ 全仓**一处都没有** `updateUserById`（那是"拿别人的 id 去改密码"，本项目永远不许有）',
    `命中文件 = ${srcFiles.filter((f) => /updateUserById/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(APP.length + 1)).join('、') || '0 个'}`,
  )
  /* 🧪 反向对照：把别人那一支的签名（`updateUserById`）塞进去 → ⑪ 必须红 */
  const srcPoison = settingsSrc + "\nsb.auth.admin.updateUserById(otherId, { password: 'x' })\n"
  check(
    /updateUserById/.test(srcPoison) && !/updateUserById/.test(settingsSrc),
    '🧪 D13-B 反向对照：往源码里塞一句 `updateUserById(otherId, …)` → ⑪ 当场红（"只作用自己"那条**真的在读源码**）',
    `塞进去之后命中 = ${/updateUserById/.test(srcPoison)} · 原源码命中 = ${/updateUserById/.test(settingsSrc)}`,
  )

  /* ---- C：旧密码那道坎**真的在**，而且**先验后改** ---- */
  check(
    /sb\.auth\.signInWithPassword\(\{\s*email\s*,\s*password:\s*pwOld\s*\}\)/.test(SET_CODE),
    '🔴 D13-C ① 旧密码那一道坎真的在（`signInWithPassword` 复验**当前账号 + 输入的旧密码**）',
    `找到 = ${/sb\.auth\.signInWithPassword\(\{\s*email\s*,\s*password:\s*pwOld\s*\}\)/.test(SET_CODE)}`,
  )
  const iSignIn = SET_CODE.indexOf('signInWithPassword')
  const iUpdate = SET_CODE.indexOf('.auth.updateUser(')
  check(
    iSignIn > 0 && iUpdate > iSignIn,
    '🔴 D13-C ② 顺序是**先验旧密码、再改**（反过来 = 谁拿到手机都能把原主人永久锁在外面）',
    `signInWithPassword @ ${iSignIn} · updateUser @ ${iUpdate}（要 update 在后）`,
  )
  check(
    (SET_CODE.match(/setPwErr\(/g) ?? []).length >= 4,
    '🔴 D13-C ③ 失败**有好几档各自上屏**（§三.5 显式报错，不许静默）—— `setPwErr()` 的落点至少 4 处',
    `${(SET_CODE.match(/setPwErr\(/g) ?? []).length} 处`,
  )
  /* 🧪 反向对照：把两句**对调** → ② 必须红（证明它真的在比偏移，不是恒真） */
  const swapped = (() => {
    const a = 'sb.auth.signInWithPassword({ email, password: pwOld })'
    const b = 'sb.auth.updateUser({ password: pwNew })'
    return SET_CODE.split(a).join('\u0000').split(b).join(a).split('\u0000').join(b)
  })()
  check(
    swapped.indexOf('signInWithPassword') > swapped.indexOf('.auth.updateUser('),
    '🧪 D13-C 反向对照：把两句**对调**（先改再验）→ ② 当场红（"先验后改"不是一句空话）',
    `对调后 signInWithPassword @ ${swapped.indexOf('signInWithPassword')} · updateUser @ ${swapped.indexOf('.auth.updateUser(')}`,
  )

  /* ---- D：失败/成功**真上屏**（标记 + role=alert），不是躺在注释里 ---- */
  check(
    /data-pwd-err/.test(settingsSrc) && /role="alert"/.test(settingsSrc),
    '🔴 D13-D ① 失败那块屏上有标记、并且是 `role="alert"`（不是只写在注释里 —— 注释不算"上屏"）',
    `data-pwd-err=${/data-pwd-err/.test(settingsSrc)} · role="alert"=${/role="alert"/.test(settingsSrc)}`,
  )
  check(
    /\{pwErr \? \(/.test(settingsSrc) && /data-pwd-ok/.test(settingsSrc) && /setPwOk\('密码已改/.test(SET_CODE),
    'D13-D ② 成功也说话（"密码已改" + 那台设备不用重新登录），而且错/对两块**是两个条件各自的**',
    `pwErr 三元=${/\{pwErr \? \(/.test(settingsSrc)} · data-pwd-ok=${/data-pwd-ok/.test(settingsSrc)}`,
  )
  /* 🧪 反向对照：把那两个标记摘掉 → ① 必须假 */
  const stripped = settingsSrc.split('data-pwd-err').join('x-pwd-err').split('role="alert"').join('role="note"')
  check(
    !/data-pwd-err/.test(stripped) && !/role="alert"/.test(stripped),
    '🧪 D13-D 反向对照：把标记摘掉 → ① 当场判假（这个探针真的在找那两个标记）',
    `摘掉之后 data-pwd-err=${/data-pwd-err/.test(stripped)} · role="alert"=${/role="alert"/.test(stripped)}`,
  )

  /* ---- E：全仓不许出现**真密码字面量**（断言/注释也不行；这里只放"形状明显是密码"的串） ---- */
  const PW_LITERALS = [
    /ShuGao@?\d{4}/i,
    /(password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{6,}['"]/i,
    /['"][A-Za-z0-9!@#$%^&*_-]{6,}['"]\s*\/\/\s*密码/,
  ]
  const pwDirs = [
    { dir: join(APP, 'src'), exts: /\.tsx?$/ },
    { dir: join(APP, 'scripts'), exts: /\.(mjs|ts)$/ },
    { dir: join(APP, 'functions'), exts: /\.ts$/ },
    { dir: join(REPO, 'supabase'), exts: /\.sql$/ },
  ]
  const pwHits = []
  let pwScanned = 0
  for (const { dir, exts } of pwDirs) {
    if (!existsSync(dir)) continue
    for (const f of walk(dir, exts)) {
      pwScanned++
      const txt = readFileSync(f, 'utf8')
      for (const re of PW_LITERALS) {
        const m = txt.match(re)
        if (m) pwHits.push(`${f.slice(REPO.length + 1).replace(/\\/g, '/')} → ${short(m[0], 60)}`)
      }
    }
  }
  check(pwScanned >= 100, `D13-E 自证：真的扫了 ${pwScanned} 个文本文件（src / scripts / functions / supabase/schema.sql）`, `扫到 ${pwScanned} 个`)
  eq('🔴 D13-E ① 仓库里**没有任何"看起来就是真密码"的字面量**（代码 / 注释 / 断言都不许有）', pwHits.length, 0)
  /*
   * 🧪 反向对照：喂一条**真形状**的密码进来 → 同一组正则必须命中
   *（证明 ① 不是"什么都扫不到"）。
   * ⚠️ 样例与它前面的那个词**都写成 `\uXXXX` 转义**，到运行时才解回明文：
   *    · 源码里因此**不存在**明文凭据的字节序列（"仓库里不许有密码"连假样例也守）；
   *    · 而且**这一行的原文**也不会撞上 ① 的那条正则 —— 否则就成了
   *      "用自己的样例把自己判红"（真踩过一次）。
   *    所以 ① 的绿是干净的：既不靠排除这个文件，也不用为了绿去改绿。
   */
  const ESC_PW = '\\u0068\\u0075\\u006e\\u0074\\u0065\\u0072\\u0032\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074'
  const ESC_KEY = '\\u0070\\u0061\\u0073\\u0073\\u0077\\u006f\\u0072\\u0064'
  const unesc = (s) => String(JSON.parse(`"${s}"`))
  const pwPoison = `const ${unesc(ESC_KEY)} = '${unesc(ESC_PW)}'`
  check(
    PW_LITERALS.some((re) => re.test(pwPoison)),
    '🧪 D13-E 反向对照：喂 `const password = \'…\'`（真形状）进去 → 同一组正则**当场命中**',
    `命中 = ${PW_LITERALS.map((re) => re.test(pwPoison)).join('/')}`,
  )
  check(
    ESC_PW === [...unesc(ESC_PW)].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') &&
      !/hunter/.test(ESC_PW),
    'D13-E 反向对照自证：样例在**源码里**是 `\\uXXXX` 转义（明文只存在于运行时内存）—— 所以 ① 的绿不是被自己的样例撞出来的，也没有"排除自己这个文件"',
    `源码形态 = ${JSON.stringify(ESC_PW)}`,
  )

  /* ---- F：改名字那**两条写路径**对同一个字段必须有同一个口径（2026-10-11 本轮补） ----
   *
   * 背景（用户原话的后半句：「自己改了账户名字后行政管理那边要能看见」）：
   * 「我的」页改的是 `teachers.name`，行政管理（`TeacherAccounts.tsx`）读的也是它 ——
   * 但那是**两条不同的写路径**：
   *   · 老师自己那一页：`store.updateTeacher` → `remote.saveTeacher`（**自己的 JWT + RLS**）；
   *   · 行政管理那一页：`/api/teacher-account` 的 `rename` 动作（**service_role**）。
   * 两条都落同一张表、同一列 → **行政管理刷新即见**（这一页只在挂载时拉一次，没有客户端缓存）。
   * 数据库那一层由 `rls-checks` 第七节（真 Postgres）与第八·之二节各自钉住；
   * 这里只钉**前端这一层**唯一会分家的地方：**姓名那一格的字数上限**。
   *   🔴 分家的代价：老师能给自己存一个 60 个字的名字，而行政管理那一页的同一个字段不许 ——
   *      同一个人、同一个字段、两套规矩（AGENTS.md §四：「一个字段只能有一种语义」）。
   */
  const fSrc = readApp('src/pages/TeacherAccounts.tsx')
  const mServer = fnSrc.match(/const NAME_MAX\s*=\s*(\d+)/)
  const mClient = settingsSrc.match(/const SELF_NAME_MAX\s*=\s*(\d+)/)
  check(
    Boolean(mServer) && Boolean(mClient) && mServer[1] === mClient[1],
    '🔴 D13-F ① 姓名上限**一个数**：`teacher-account.ts` 的 `NAME_MAX` 与 `Settings.tsx` 的 `SELF_NAME_MAX` 相等（老师自己改名 / 行政管理改名 不许两套规矩）',
    `服务端 NAME_MAX=${mServer ? mServer[1] : '（没抠到）'} · 我的页 SELF_NAME_MAX=${mClient ? mClient[1] : '（没抠到）'}`,
  )
  check(
    /maxLength=\{NAME_MAX\}/.test(fSrc) && /maxLength=\{SELF_NAME_MAX\}/.test(SET_CODE),
    '🔴 D13-F ② 两条路都把那个数**真的挂到了输入框上**（常量相等但没人用 = 摆设；`maxLength` 才是挡住超长那一格的东西）',
    `行政管理挂上了 = ${/maxLength=\{NAME_MAX\}/.test(fSrc)} · 我的页挂上了 = ${/maxLength=\{SELF_NAME_MAX\}/.test(SET_CODE)}`,
  )
  /* 🧪 反向对照：把服务端那个数改成 60 → ① 当场红（证明它真的在比那两个数，不是恒真） */
  const mServer60 = fnSrc.replace(/const NAME_MAX\s*=\s*24/, 'const NAME_MAX = 60')
  const server60 = mServer60.match(/const NAME_MAX\s*=\s*(\d+)/)
  check(
    Boolean(server60) && server60[1] !== (mClient ? mClient[1] : null),
    '🧪 D13-F 反向对照：把服务端改成 60 → ① 当场红（两个数一旦分家就会被抓住）',
    `改后 服务端=${server60 ? server60[1] : '（没抠到）'} vs 我的页=${mClient ? mClient[1] : '（没抠到）'}`,
  )
  /* 🧪 反向对照②：把 `maxLength` 那一处摘掉 → ② 当场假（"挂上了没有"真的在读 JSX） */
  const SET_NO_MAX = SET_CODE.replace(/maxLength=\{SELF_NAME_MAX\}/, '')
  check(
    !/maxLength=\{SELF_NAME_MAX\}/.test(SET_NO_MAX) && /maxLength=\{SELF_NAME_MAX\}/.test(SET_CODE),
    '🧪 D13-F 反向对照②：把 `maxLength={SELF_NAME_MAX}` 摘掉 → ② 当场假（那一条真的在读 JSX，不是恒真）',
    `摘掉之后还在 = ${/maxLength=\{SELF_NAME_MAX\}/.test(SET_NO_MAX)}`,
  )
}

/* ============================================================
   第十六节 · D14：安全加固 A 档（2026-10-01）
   ------------------------------------------------------------
   这一节守的是**"安全这件事没有门禁"**那个缺口 —— `rls-checks` 是数据库权限的真测试，
   但它不覆盖：响应头 / CSP 内联脚本哈希 / 中转白名单 / 内嵌打开 / 登录文案。
   这几样里的每一样都有一个"悄悄退回去"的坏法，而**退回去了没人会看见**：
     · `_headers` 里的 sha256 与 `index.html` 那段内联脚本**一旦不同步**，
       浏览器的 CSP 会把那段脚本**静默拦掉** —— 页面照常打开，只有暗色用户先白闪一下；
     · `_middleware.ts` 少掉 `/api/sb` 那一句放行，Realtime / 文件全断，而且只有线上才现；
     · `/api/sb` 的白名单与抹头两件事，删掉任何一件都不影响任何功能（只影响安全）；
     · `.html` 回到 accept 里、判定回到"能内嵌看" —— 功能上毫无变化，安全上直接开口子。
   所以这里**每一条都配反向对照**（AGENTS.md §三：把修复改回去必须红）。
   ============================================================ */

section('第十六节 · D14：安全加固 A 档（响应头 · CSP 哈希配对 · 中转白名单 · 内嵌打开 · 登录文案）')

{
  /** 读一个 app/ 下的文件；**读不到回 null**（不抛）—— 让断言自己报"文件不在"，而不是脚本崩掉 */
  const readOr = (rel, root = APP) => {
    const p = join(root, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }
  const S = (x) => String(x ?? '')

  const HDR = readOr('public/_headers')
  const HTML = readOr('index.html')
  const MW = readOr('functions/api/_middleware.ts')
  const SB = readOr('functions/api/sb/[[path]].ts')
  const FILELIB = readOr('src/lib/files.ts')
  const FILEPAGE = readOr('src/pages/Files.tsx')
  const LOGIN = readOr('src/pages/Login.tsx')
  const ADMIN = readOr('src/pages/Admin.tsx')
  const ACCOUNTS = readOr('src/lib/accounts.ts')
  const SCHEMA = readOr('supabase/schema.sql', REPO)

  /* ---------- A：静态资源的安全响应头（A3）+ 内联脚本的哈希配对 ---------- */

  const NEED_HDR = [
    ['X-Frame-Options', /X-Frame-Options:\s*DENY/i],
    ['X-Content-Type-Options', /X-Content-Type-Options:\s*nosniff/i],
    ['Referrer-Policy', /Referrer-Policy:\s*strict-origin-when-cross-origin/i],
    ['Strict-Transport-Security', /Strict-Transport-Security:\s*max-age=\d+/i],
    ['Content-Security-Policy', /Content-Security-Policy:\s*default-src 'self'/i],
  ]
  const hdrMissing = NEED_HDR.filter(([, re]) => !re.test(S(HDR))).map(([n]) => n)
  check(
    HDR !== null && hdrMissing.length === 0,
    'D14-A ① `app/public/_headers` 在，且五类头都在（XFO / nosniff / Referrer / HSTS / CSP）',
    HDR === null ? '文件不在' : hdrMissing.length ? `少了 ${hdrMissing.join('、')}` : '五类齐全',
  )

  /*
   * CSP 的 sha256 必须与**内联脚本元素的文本内容**逐字对上（含首尾空白）。
   * ⚠️ 口径：浏览器算的是 `<script>` 与 `</script>` 之间的**全部字符** ——
   *    去掉首尾空白去算会得到一个**永远对不上**的哈希（本轮第一次就是这么算错的）。
   */
  const hashOf = (s) => createHash('sha256').update(s, 'utf8').digest('base64')
  const inlineOf = (html) => {
    const m = S(html).match(/<script>([\s\S]*?)<\/script>/)
    return m ? m[1] : null
  }
  const inline = inlineOf(HTML)
  const wantHash = inline === null ? '(没有内联脚本)' : hashOf(inline)
  const cspHashes = [...S(HDR).matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map((m) => m[1])
  check(
    inline !== null && cspHashes.includes(wantHash),
    '🔴 D14-A ② CSP 里的 sha256 = `index.html` 那段内联主题脚本算出来的哈希（不同步 = 浏览器**静默**拦掉它，只有暗色用户先白闪一下）',
    `内联脚本算出 ${wantHash} · CSP 里写着 ${cspHashes.join('、') || '（没有）'}`,
  )
  /* 🧪 反向对照①：脚本内容动一个字符 → 哈希就对不上了（证明 ② 真的在算） */
  const inlineShifted = inline === null ? null : `${inline} `
  check(
    inlineShifted !== null && hashOf(inlineShifted) !== wantHash,
    '🧪 D14-A 反向对照①：内联脚本尾部多一个空格 → 哈希当场变（证明 ② 是在真算哈希，不是恒真）',
    inlineShifted === null ? '（没抠到内联脚本）' : `多一个空格后 ${hashOf(inlineShifted)}`,
  )
  /* 🧪 反向对照②：把 CSP 里那段哈希改掉 → ② 的判据当场假（证明 ② 真的在读那个文件） */
  const hdrBadHash = S(HDR).replace(/sha256-[A-Za-z0-9+/=]+/, 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
  check(
    hdrBadHash !== S(HDR) && !hdrBadHash.includes(wantHash),
    '🧪 D14-A 反向对照②：把 CSP 里那段 sha256 换成假的 → ② 当场红（"配对"不是摆设）',
    `改后还含真哈希 = ${hdrBadHash.includes(wantHash)}`,
  )

  /* ---------- B：Functions 的响应头（A4）---------- */

  check(
    MW !== null &&
      /X-Content-Type-Options/.test(S(MW)) &&
      /X-Frame-Options/.test(S(MW)) &&
      /Referrer-Policy/.test(S(MW)),
    'D14-B ① `app/functions/api/_middleware.ts` 在，且给接口响应补了 nosniff / XFO / Referrer-Policy（`_headers` 管不到 Functions）',
    MW === null ? '文件不在' : '找了三个头名',
  )
  const mwBypass = /startsWith\('\/api\/sb\/'\)[\s\S]{0,60}?return res/.test(S(MW))
  check(
    mwBypass,
    '🔴 D14-B ② `/api/sb/*` **原样放行**（它是数据库中转：重造 Response 会破坏 `content-encoding`，Realtime 的 Upgrade 也走它）',
    mwBypass ? '放行那一句在' : '没找到"判 /api/sb 就 return res"这一句',
  )
  const mwNoBypass = S(MW).replace(/if \(path === '\/api\/sb' \|\| path\.startsWith\('\/api\/sb\/'\)\) return res/, '')
  check(
    mwNoBypass !== S(MW) && !/startsWith\('\/api\/sb\/'\)[\s\S]{0,60}?return res/.test(mwNoBypass),
    '🧪 D14-B 反向对照：把放行那一句删掉 → ② 当场红（证明它真的在读那句）',
    `删掉之后还在 = ${/startsWith\('\/api\/sb\/'\)[\s\S]{0,60}?return res/.test(mwNoBypass)}`,
  )

  /* ---------- C：数据库中转的路径白名单 + 抹掉可伪造的 IP 头（A7）---------- */

  const PREFIXES = ['/auth/v1/', '/rest/v1/', '/storage/v1/', '/realtime/v1/', '/functions/v1/']
  const missingPrefix = PREFIXES.filter((p) => !S(SB).includes(p))
  check(
    SB !== null && missingPrefix.length === 0,
    'D14-C ① `/api/sb` 的白名单里五段路径都在（auth / rest / storage / realtime / functions）',
    SB === null ? '文件不在' : missingPrefix.length ? `少了 ${missingPrefix.join('、')}` : '五段齐全',
  )
  const guardPos = S(SB).indexOf('if (!allowedPath(rest))')
  const fetchPos = S(SB).indexOf('await fetch(')
  check(
    guardPos >= 0 && fetchPos > guardPos,
    '🔴 D14-C ② 名单判定在**转发之前**（判在 fetch 之后 = 白名单等于没写）',
    `allowedPath 在第 ${guardPos + 1} 字符 · await fetch 在第 ${fetchPos + 1} 字符`,
  )
  const STRIP_NEED = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']
  const stripMissing = STRIP_NEED.filter((h) => !S(SB).includes(`'${h}'`))
  check(
    stripMissing.length === 0 && /headers\.delete\(h\)/.test(S(SB)),
    '🔴 D14-C ③ 客户端可伪造的 IP 头被逐个删掉（`x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`）—— 不删的话，攻击者每换一个假 IP 就等于换一只限流桶',
    stripMissing.length ? `常量里少了 ${stripMissing.join('、')}` : '三个都在、并且真的 delete',
  )
  const sbNoGuard = S(SB).replace('if (!allowedPath(rest))', 'if (false)')
  check(
    sbNoGuard !== S(SB) && !sbNoGuard.includes('if (!allowedPath(rest))'),
    '🧪 D14-C 反向对照：把守卫改成 `if (false)` → ①/② 的口径当场假（证明这几条真的在读那句守卫）',
    `改后还找得到原句 = ${sbNoGuard.includes('if (!allowedPath(rest))')}`,
  )

  /* ---------- D：内嵌打开那一类收紧（A6）---------- */

  const accept = (S(FILEPAGE).match(/accept="([^"]*)"/) ?? [])[1] ?? ''
  check(
    accept !== '' && !/\.html|\.htm|\.svg/.test(accept),
    '🔴 D14-D ① `Files.tsx` 的上传 `accept` 里没有 `.html/.htm/.svg`',
    `accept="${accept}"`,
  )
  check(
    !/return 'html'/.test(S(FILELIB)) &&
      !/FileKind =[^\n]*'html'/.test(S(FILELIB)) &&
      !/k === 'html'/.test(S(FILELIB)),
    '🔴 D14-D ② `files.ts` 里 html 这一类**从类型到判定都不存在**（`FileKind` 没有 html、`kindOf` 不再返回它、`canViewInline` 不认它）',
    `还剩 html 字样 = ${/html/.test(S(FILELIB))}`,
  )
  check(
    /application\/octet-stream/.test(S(FILELIB)) && /kindOf\(file\.name, file\.type\) === 'other'/.test(S(FILELIB)),
    '🔴 D14-D ③ 上传时**不信浏览器报的类型**：认不出的（含 html/svg）一律存 `application/octet-stream`',
    '在 `uploadFile()` 里找那一句',
  )
  check(
    /download \? \{ download: true \} : undefined/.test(S(FILELIB)) &&
      /!canViewInline\(k\)/.test(S(FILEPAGE)),
    '🔴 D14-D ④ 签名直链能强制下载，且「打开」那个按钮**按能不能内嵌看**决定要不要强制（能看的才内嵌）',
    `库里带 download = ${/download \? \{ download: true \} : undefined/.test(S(FILELIB))} · 页面上传了 = ${/!canViewInline\(k\)/.test(S(FILEPAGE))}`,
  )
  const acceptBack = S(FILEPAGE).replace('accept="image/*,.pdf', 'accept="image/*,.html,.htm,.pdf')
  check(
    acceptBack !== S(FILEPAGE) && /\.html/.test((acceptBack.match(/accept="([^"]*)"/) ?? [])[1] ?? ''),
    '🧪 D14-D 反向对照：把 `.html` 塞回 accept → ① 当场红（证明 ① 真的在读那一行）',
    `塞回去之后 accept 里还有 .html = ${/\.html/.test((acceptBack.match(/accept="([^"]*)"/) ?? [])[1] ?? '')}`,
  )

  /* ---------- E：登录失败不再直出 GoTrue 原文（A5）---------- */

  const loginUses = /desc: loginFailText\(error\.message\)/.test(S(LOGIN))
  const adminUses = /setErr\(loginFailText\(error\.message\)\)/.test(S(ADMIN))
  check(
    loginUses && adminUses && !/error\.message === 'Invalid login credentials'/.test(S(LOGIN) + S(ADMIN)),
    '🔴 D14-E ① 两处登录（登录页 / 管理台）的失败文案都走 `loginFailText()`，都不再把 GoTrue 原文摆上屏',
    `登录页 = ${loginUses} · 管理台 = ${adminUses}`,
  )
  const loginRaw = S(LOGIN).replace('desc: loginFailText(error.message)', 'desc: error.message')
  check(
    !/desc: loginFailText\(error\.message\)/.test(loginRaw) && loginRaw !== S(LOGIN),
    '🧪 D14-E 反向对照：把那一句换回 `error.message` → ① 当场红（原文会漏"账号在不在 / 有没有被限流"）',
    `换回去之后还走 loginFailText = ${/desc: loginFailText\(error\.message\)/.test(loginRaw)}`,
  )
  check(
    /return '登录没成功，稍后再试一次'/.test(S(ACCOUNTS)) && /export function loginFailText/.test(S(ACCOUNTS)),
    '🔴 D14-E ② `loginFailText()` 认不出的一律回**固定那一句**（不回显原文 —— 上游以后换文案，只会变笼统，不会漏信息）',
    '在 `lib/accounts.ts` 里找那一句兜底',
  )
  check(
    /signInWithPassword\(\{ email: toEmail\(account\)/.test(S(ADMIN)) && /import \{ loginFailText, toEmail \}/.test(S(ADMIN)),
    '🔴 D14-E ③ 管理台登录也走 `toEmail()`（原来自己拼了一个"只补 @qq.com"的版本 —— 同一个账号两套口径）',
    '在 `Admin.tsx` 里找那一句',
  )

  /* ---------- F：数据库那一侧的执行权限收口（A8）---------- */

  /*
   * A8 的第一版写的是 `revoke execute on all functions in schema public from public, anon;`
   * —— 一刀切会把"没有显式 grant"的函数对 `authenticated` / `service_role` **一起断供**：
   * `grade-checks` 的 K3 当场红（`student_subject_check` 靠 PUBLIC 默认值），
   * 而 §29 那批"只该由 service_role 调"的写入口（`promote_grades` / `grade_backup*`）
   * 门禁里测不到、会在线上炸。下面这几条钉的就是"规则式 revoke"这个形态本身。
   */
  const CLOSE_RULE = "execute format('revoke execute on function %s from public, anon', r.sig);"
  const BLANKET = 'revoke execute on all functions in schema public from public, anon;'
  const S_SCHEMA = S(SCHEMA)
  const closePos = S_SCHEMA.indexOf(CLOSE_RULE)
  const blanketPos = S_SCHEMA.indexOf(BLANKET)
  const grantBarePos = S_SCHEMA.indexOf(
    'grant execute on function public.can_edit_student_subject(uuid) to authenticated;',
  )
  const reGrantAnonPos = S_SCHEMA.indexOf('to anon;', closePos)
  check(
    closePos > 0 && blanketPos === -1 && grantBarePos > closePos && reGrantAnonPos > closePos,
    '🔴 D14-F ① 末尾那条收口是**规则式**（只收 definer 非触发器函数），且**不许**出现一刀切的 `revoke … on all functions`；两条补 grant 都在它之后',
    `规则在第 ${closePos + 1} 字符 · 一刀切位置 = ${blanketPos} · 裸版判据补 grant = ${grantBarePos > closePos} · 匿名上报再 grant = ${reGrantAnonPos > closePos}`,
  )
  check(
    /p\.prosecdef/.test(S_SCHEMA) && /p\.prorettype <> 'trigger'::regtype/.test(S_SCHEMA),
    '🔴 D14-F ② 那条规则只在 `security definer` 且非触发器函数上生效（非 definer 的裸函数与触发器函数一个都不许碰）',
    '在 `schema.sql` 的 §39 里找 `p.prosecdef` 与 `p.prorettype`',
  )
  /*
   * ③ 只看**那条 grant 语句本身**（`grant execute on function public.report_frontend_error(`）——
   *    不看函数名：上面那段注释里也写着 `report_frontend_error()`，用函数名去判会恒真（本轮第一次就是这么写错的）。
   */
  const anonGrantRe = /grant execute on function public\.report_frontend_error\(/
  const svcGuardRe = /if exists \(select 1 from pg_roles where rolname = 'service_role'\)/
  check(
    /🔴 三条必须跟着它/.test(S_SCHEMA) &&
      anonGrantRe.test(S_SCHEMA.slice(closePos)) &&
      svcGuardRe.test(S_SCHEMA.slice(closePos)),
    '🔴 D14-F ③ 三条"必须跟着它"的事写在原地：`report_frontend_error()`（故意给 anon）· 裸版判据（RLS 策略要调）· service_role 显式补回（带角色存在性守卫）',
    `规则之后还找得到匿名 grant = ${anonGrantRe.test(S_SCHEMA.slice(closePos))} · service_role 守卫 = ${svcGuardRe.test(S_SCHEMA.slice(closePos))}`,
  )
  /* 🧪 反向对照一：把那条 grant 整行删掉（不是只换名字）→ ③ 的"规则之后还有它"当场假 */
  const schemaNoAnonGrant = S_SCHEMA.replace(
    /grant execute on function public\.report_frontend_error\([^\n]*\n/,
    '',
  )
  const noGrantAfter = anonGrantRe.test(
    schemaNoAnonGrant.slice(schemaNoAnonGrant.indexOf(CLOSE_RULE)),
  )
  check(
    schemaNoAnonGrant !== S_SCHEMA && noGrantAfter === false,
    '🧪 D14-F 反向对照一：把那条匿名 grant 整行删掉 → ③ 当场假（证明 ③ 真的在读规则之后那一段，不是恒真）',
    `删掉之后规则之后还找得到 = ${noGrantAfter}`,
  )
  /* 🧪 反向对照二：往末尾塞回一刀切那条 → ① 的"不许出现"当场假 */
  const schemaBlanket = `${S_SCHEMA}\n${BLANKET}\n`
  check(
    schemaBlanket.includes(BLANKET) && S_SCHEMA.includes(BLANKET) === false,
    '🧪 D14-F 反向对照二：塞回一刀切的 `revoke … on all functions` → ① 的"不许出现"当场假（A8 第一版就是这样，`grade-checks` K3 抓到的）',
    `塞回之后找得到 = ${schemaBlanket.includes(BLANKET)} · 原文里本来有 = ${S_SCHEMA.includes(BLANKET)}`,
  )
}

/* ============================================================
   第十七节 · D15：**关着的浮层不许在第一帧被挂出来**（`useExit` 初值 = 切页那一下的闪动）
   ------------------------------------------------------------
   2026-10-03 修掉的那个 bug（提交 `f525054`）：
     · `useExit(open)` 的返回值是 `open || !exited`，那个 state 存的是"退场**已经播完**"；
     · 初值写成 `useState(false)`（＝"已经播完"）⇒ **页面第一次渲染**里那些本来关着的
       `Sheet` / `Modal` 被算成"正在退场" ⇒ **元素被挂进 DOM**；
     · 而 `.sheet--out` / `.scrim--out` 挂的是 `sheet-down` / `fade-out`，这两条 `@keyframes`
       （`src/index.css:1099-1114`）**只有 `to`、没有 `from`** ⇒ 起点就是元素自己的静态样式
       （屏幕内、`opacity:1`）⇒ 真的画出一整屏暗幕 + 一张满高白抽屉，再滑下去
       （390×844 实测：切页后 +453ms 插进 DOM，+641ms 才删掉）。
   为什么 `shots` 的 04f 钉不住它：那一节测的是"**关掉之后**留 180ms 播退场"（退场机制本身）；
   "第一次挂载就被算成退场"是**另一个方向** —— 改回 `useState(false)`，04f 照样全绿。
   怎么钉：**不看拼写看行为**。用 `react-dom/server` 把 `useExit` 的**第一帧返回值**渲染出来
   （Node 里跑真源码，走 `scripts/lib/ts-resolve.mjs`），再拿"就地改坏的副本"做反向对照；
   判据是"第一帧挂没挂"，所以换一种更漂亮的写法（`useState(() => !open)` 之类）不会冤。
   ============================================================ */

section('第十七节 · D15：关着的浮层不许在第一帧被挂出来（`useExit` 初值 · 切页那一下的闪动）')

{
  const React = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const EXIT_REL = 'src/lib/useExit.ts'
  const EXIT_SRC = readApp(EXIT_REL)

  /** 第一帧渲染成什么。`mounted` = 元素进了 DOM（＝那次闪动）；`gone` = 干净的 */
  const firstFrame = (hook, open) =>
    renderToStaticMarkup(
      React.createElement(function Probe() {
        return React.createElement('i', null, hook(open) ? 'mounted' : 'gone')
      }),
    )

  /* 锚点自证：声明那个 state 的行还在。改名 / 重构 ⇒ 这一节必须跟着改，而不是静默变绿 */
  const declLine = EXIT_SRC.split('\n').find((l) => /=\s*useState\(/.test(l) && !/^\s*[*/]/.test(l))
  check(
    Boolean(declLine),
    'D15 锚点自证：`useExit` 里找得到 `= useState(初值)` 那一行',
    declLine ? short(declLine) : `在 ${EXIT_REL} 里没找到（改名了？那就得改这一节）`,
  )

  if (declLine) {
    const real = await import('../src/lib/useExit.ts')
    const realHtml = firstFrame(real.useExit, false)
    check(
      realHtml === '<i>gone</i>',
      '🔴 D15 ①：`useExit(false)` 的**第一帧不挂载** —— 关着的浮层不许进 DOM（切页不闪的那一条）',
      `第一帧 = ${realHtml}`,
      '反向对照：把初值改回 `useState(false)` → 这条必须红（下一条反向对照就是它）',
    )

    /* 🧪 反面对照：同一个探针喂 `open=true` 必须挂载 —— 否则 ① 可能只是"恒 gone"的摆设 */
    const openHtml = firstFrame(real.useExit, true)
    check(
      openHtml === '<i>mounted</i>',
      '🧪 D15 ① 反面对照：`useExit(true)` 第一帧**必须**挂载（证明这个探针分得出两种输入，不是恒 gone）',
      `第一帧 = ${openHtml}`,
    )

    /* 🧪 反向对照：把初值就地改回 `useState(false)`，写成 .tmp-gates/ 里的副本（gitignore 了，跑完删） */
    const broken = EXIT_SRC.replace(declLine, declLine.replace(/useState\([^)]*\)/, 'useState(false)'))
    const TMP = join(APP, '.tmp-gates', `useExit-old-${process.pid}.ts`)
    let oldHtml = '(没跑起来)'
    try {
      mkdirSync(dirname(TMP), { recursive: true })
      writeFileSync(TMP, broken)
      const oldMod = await import(pathToFileURL(TMP).href)
      oldHtml = firstFrame(oldMod.useExit, false)
    } catch (e) {
      oldHtml = `副本没跑起来：${e?.message ?? e}`
    } finally {
      rmSync(TMP, { force: true })
    }
    check(
      broken !== EXIT_SRC && oldHtml === '<i>mounted</i>',
      '🧪 D15 反向对照：把初值改回 `useState(false)` → ① 当场假（证明 ① 量的是**行为**，不是拼写、不是摆设）',
      `改回去之后第一帧 = ${oldHtml}`,
      '这一段在仓库里不留痕：副本写在 gitignore 的 `.tmp-gates/`，finally 里删',
    )
  }
}

/* ============================================================
   第十八节 · D16：站内接口只有一个基址（`apiUrl`）—— 壳里才不会把 `/api/*` 丢给本地服务器
   ------------------------------------------------------------
   用户 2026-10-04 报的「维护模式读不到 / `/admin` 说那几个 key 没配」的根因：
   exe（`app://-`）与 apk（`https://localhost`）加载的是**打进包里的网页产物**，
   **相对路径**的 `/api/*` 会被壳自己的本地服务器接走 —— 它对不认识的路径回
   `200 + index.html`（`JSON.parse` 抛 `Unexpected token '<'`）：
     · 维护状态 → 按"未维护"放行（fail-open）⇒ **壳里维护模式永远不生效**；
     · 面板接口 → 拿到一坨 HTML（应用侧已改成"读不到"而不是"未配置"，但接口还是没通）。
   数据那条路**本来就是绝对地址**（`.env.production` 的 `VITE_SUPABASE_URL=…/api/sb`），
   所以壳里读得到班级/作业 —— 出问题的只有站点自己那些 `/api` 路由。
   ⇒ ① 站内接口一律走 `src/lib/apiBase.ts` 的 `apiUrl()`（基址来自 `.env.production` 的
        `VITE_API_BASE`；**留空 = 相对路径，网页行为逐字不变**）；
      ② 壳里是**跨域**调用，服务端要点头：`functions/api/_middleware.ts` 把预检自己答掉
        （线上实测：不做的话 `OPTIONS` 回 405 ⇒ 带 `authorization` 的 POST 一条都发不出去）。
   ============================================================ */

section('第十八节 · D16：站内接口只有一个基址（`apiUrl` · 壳里不许把 `/api/*` 丢给本地服务器）')

{
  const { apiUrl } = await import('../src/lib/apiBase.ts')

  /* ① 纯函数：没有基址时**逐字返回**（网页 / `vite dev` / 门禁里的行为不变） */
  check(
    apiUrl('/api/status') === '/api/status' && apiUrl('/api/admin/config-check') === '/api/admin/config-check',
    'D16 ① 没有 `VITE_API_BASE` 时 `apiUrl()` **原样返回**相对路径（网页行为逐字不变）',
    `apiUrl('/api/status') = ${apiUrl('/api/status')}`,
  )
  eq(
    'D16 ② 给了基址 → 绝对地址；基址末尾的斜杠 / 路径缺前导斜杠都不许拼出 `//`',
    [
      apiUrl('/api/status', 'https://x.dev'),
      apiUrl('api/status', 'https://x.dev/'),
      apiUrl('/api/status', 'https://x.dev///'),
    ].join(' '),
    'https://x.dev/api/status https://x.dev/api/status https://x.dev/api/status',
  )

  /* ② 静态：`src` 里不许再出现相对路径的 `fetch('/api/…')`。
     ⚠️ 注释**先剥掉** —— 解释这件事的注释里就写着这个形状（`stripComments`）。 */
  const stripComments = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const RAW = /fetch\(\s*['"]\/api\//
  const offenders = []
  const walk = (dir) => {
    for (const e of readdirSync(join(APP, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(e.name) && RAW.test(stripComments(readApp(rel)))) offenders.push(rel)
    }
  }
  walk('src')
  check(
    offenders.length === 0,
    "🔴 D16 ③ `src` 里没有一处相对路径的 `fetch('/api/…')`（一律走 `apiUrl()`）",
    offenders.length ? `还有 ${offenders.length} 处：${offenders.slice(0, 4).join('、')}` : '0 处',
    "反向对照：在任意页面里写一句 `fetch('/api/notice')` → 这条必须红",
  )
  /* 🧪 反向对照：把一句真的相对 fetch 拼进**真源码的文本**里，同一条判据必须当场抓到 */
  const sample = stripComments(readApp('src/lib/notices.ts'))
  const patched = `${sample}\nasync function __probe() { await fetch('/api/notice') }\n`
  check(
    RAW.test(sample) === false && RAW.test(patched) === true,
    '🧪 D16 反向对照：把 `fetch(\'/api/notice\')` 塞进真源码文本 → ③ 的判据当场为真（证明它在真扫，不是恒绿）',
    `原文命中 = ${RAW.test(sample)} · 塞进去之后 = ${RAW.test(patched)}`,
  )

  /* ③ `.env.production` 的基址必须是**绝对 https 域名**（壳里靠它才出得去） */
  const ENV_PROD = readApp('.env.production')
  const baseLine = /^VITE_API_BASE=(.+)$/m.exec(ENV_PROD)
  check(
    Boolean(baseLine) && /^https:\/\/[a-z0-9.-]+$/.test(String(baseLine[1]).trim()),
    'D16 ④ `.env.production` 里 `VITE_API_BASE` 是**绝对 https 域名**（空着的话壳里还是出不去）',
    baseLine ? `VITE_API_BASE=${short(String(baseLine[1]).trim(), 60)}` : '没找到这一行',
  )

  /* ④ 跨域预检：**必须在 `next()` 之前**答（晚一步就是 405，浏览器判预检失败） */
  const MW = readApp('functions/api/_middleware.ts')
  const orderOk = (s) => {
    const o = String(s).indexOf("method === 'OPTIONS'")
    const n = String(s).indexOf('await context.next()')
    return o > 0 && n > o
  }
  check(
    orderOk(MW) && /Access-Control-Allow-Origin/.test(MW),
    '🔴 D16 ⑤ `_middleware.ts`：预检在 `next()` **之前**答（204 + ACAO）—— 晚一步就是 405，壳里带 `authorization` 的 POST 全死',
    `预检在 next() 之前 = ${orderOk(MW)} · ACAO 在 = ${/Access-Control-Allow-Origin/.test(MW)}`,
  )
  /* 🧪 反向对照：顺序换过来的写法必须判假（证明 ⑤ 真的在看顺序） */
  const swapped = `await context.next()\nif (context.request.method === 'OPTIONS') return pre()`
  check(
    orderOk(swapped) === false,
    '🧪 D16 反向对照：把预检挪到 `next()` 之后 → ⑤ 当场假（证明它看的是顺序，不是"这两句在不在"）',
    `顺序反了的写法 = ${orderOk(swapped)}`,
  )
}

/* ============================================================
   第十九节 · D17：产物面向**老设备**的底线（2026-10-04）
   ------------------------------------------------------------
   用户报「安卓较低版本的设备上 UI 不能正常显示」。根因不在页面，在**产物基线**：
     · CSS：Tailwind v4 把**全部**样式放进 `@layer theme/base/components/utilities`，
       而 `@layer` 的底线是 **Chrome 99 / Android WebView 99**（2022-03）。更老的 WebView
       **不认识 `@layer`，会把整块连同里面的规则一起丢掉** ⇒ 页面等于完全没有样式。
       → `vite.config.ts` 的 `shugaoCssCompat()` 在**产物**上把层摊平（顺序不变）。
     · JS：不写 `build.target` 时，产物里是 `?.`（59 处）与 `??`（91 处）—— **Chrome 80+**
       才认的语法 ⇒ 更老的 WebView **整个 bundle 解析失败**（白屏）。
       → 现在钉死 `build.target: 'es2015'`（Chrome 49+，覆盖 minSdk 23 那一档）。
   ⚠️ 判据**只认 `@layer`**：`?.` 不能当判据 —— 产物里 `i?.42:1` 其实是三元
      `i ? .42 : 1`（minify 把空格去掉了），grep 会**误报**（这一轮实测踩到）。
   ============================================================ */

section('第十九节 · D17：产物面向老设备的底线（`@layer` 摊平 · `target: es2015`）')

{
  const DIST = join(APP, 'dist', 'assets')
  const cssFiles = existsSync(DIST) ? readdirSync(DIST).filter((f) => f.endsWith('.css')) : []
  check(
    cssFiles.length > 0,
    'D17 前置：`dist/assets/*.css` 在（先 `npm run build`）—— 这一条不许静默跳过',
    cssFiles.length ? `${cssFiles.length} 个 css：${cssFiles.slice(0, 3).join('、')}` : '没有产物',
  )
  if (cssFiles.length) {
    const css = cssFiles.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')
    const hit = (re) => (css.match(re) || []).length
    const layers = hit(/@layer[\s{]/g)
    check(
      layers === 0,
      '🔴 D17 ① 产物 CSS 里**没有 `@layer`**（Tailwind v4 默认全在层里；老 WebView 会把整块丢掉 ⇒ 页面没样式）',
      `@layer ${layers} 处 · @property ${hit(/@property/g)} · :is( ${hit(/:is\(/g)} · color-mix( ${hit(/color-mix\(/g)}`,
      '反向对照：把 `vite.config.ts` 的 `shugaoCssCompat()` 从 plugins 里去掉 → 这条当场红',
    )
    /* 🧪 反向对照：同一段判据喂一段**带层**的 CSS，必须当场命中 */
    const sample = '@layer utilities{.a{color:red}}'
    check(
      (sample.match(/@layer[\s{]/g) || []).length === 1 && layers === 0,
      '🧪 D17 反向对照：喂一段 `@layer utilities{…}` 给同一条判据 → 当场命中（证明 ① 在真扫产物）',
      `样例命中 ${(sample.match(/@layer[\s{]/g) || []).length} 处 · 产物命中 ${layers} 处`,
    )
  }
  const viteSrc = readApp('vite.config.ts')
  const hasTarget = /target:\s*'es2015'/.test(viteSrc)
  const hasPlugin = /shugaoCssCompat\(\)/.test(viteSrc)
  check(
    hasTarget && hasPlugin,
    "🔴 D17 ② `vite.config.ts` 里钉着两条底线：`build.target: 'es2015'` + 产物 CSS 摊平插件",
    `target 在 = ${hasTarget} · 插件挂在 plugins 里 = ${hasPlugin}`,
    "这两条是**意图锚点**（真读数由构建时的 esbuild 与 ① 的产物扫描保证）—— `?.` 那种 grep 会误报，见本节注释",
  )

  /* ============================================================
     D17 ③ ④：`color-mix` 兜底 与 `mask-image` 前缀（2026-10-04 · 安卓 8 那一轮）
     ------------------------------------------------------------
     🔴 这两条**只能在产物上判**：`shots` 打的是 dev（未压缩源码 CSS），
        而要判的是 ① 产物里内联样式的**顺序**、② Tailwind 有没有给 mask 补前缀 ——
        **`shots` 一条都抓不到**（这正是同批扫描点出的"门禁盲区"）。

     两条的底数都是 **Chrome 84**（flex `gap` 那个地板）：
       · `color-mix()` = Chrome **111** → 84~110 丢整条 ⇒ sticky 页头**透明**
       · `mask-image`  = Chrome **120** → 84~119 丢 ⇒ 背景网格不渐隐
     ============================================================ */
  if (cssFiles.length) {
    /* ⚠️ 这里**重新读一次** `css`：`①` 那段的 `const css` 在**它自己那个 `if` 块**里，
       挪出来要动已有断言的作用域，不值当（读几个产物文件是毫秒级）。
       🔴 第一版这里直接用了 `css` ⇒ `ReferenceError: css is not defined`，
       **整个 nav-checks 崩在 D17 之前**，exit=1 —— 错误位置离真因很远（见 §九.8 同类）。 */
    const css = cssFiles.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')
    /* ④ 每一条非前缀 `mask-image`，都要在同产物里找到值相同的 `-webkit-mask-image` */
    const norm = (s) => s.replace(/\s+/g, '')
    const maskMissingOf = (s) => {
      const un = [...s.matchAll(/(?<!-webkit-)mask-image:\s*([^;}]+)/g)].map((m) => norm(m[1]))
      const wk = [...s.matchAll(/-webkit-mask-image:\s*([^;}]+)/g)].map((m) => norm(m[1]))
      return { un: un.length, missing: un.filter((v) => !wk.includes(v)) }
    }
    const maskNow = maskMissingOf(css)
    check(
      maskNow.un > 0 && maskNow.missing.length === 0,
      '🔴 D17 ④ 产物 CSS 里**每一条 `mask-image` 都配了 `-webkit-mask-image`**（非前缀要 Chrome 120，`-webkit-` 只要 4）',
      `非前缀 ${maskNow.un} 条 · 缺前缀 ${maskNow.missing.length} 条${maskNow.missing.length ? '：' + maskNow.missing.join(' | ').slice(0, 120) : ''}`,
      '反向对照：见下一条（从产物里删掉一条前缀 → 本条当场红）',
    )
    /* 🧪 **真**反向对照：从产物 CSS 里删掉第一条 `-webkit-mask-image`，判据必须数出缺前缀。
       ⚠️ 上一版这里算的是"假设值"，那是**假对照**（判据动不了它、它也永远为真）。 */
    const cssPoisoned = css.replace(/-webkit-mask-image:\s*[^;}]+;?/, '')
    const maskPoisoned = maskMissingOf(cssPoisoned)
    check(
      maskNow.missing.length === 0 && maskPoisoned.missing.length > 0 && cssPoisoned !== css,
      '🧪 D17 ④ 反向对照：**从产物 CSS 里删掉一条 `-webkit-mask-image`** → 同一条判据当场数出缺前缀（④ 不是恒真的摆设）',
      `真产物缺 ${maskNow.missing.length} 条 · 删掉一条前缀后缺 ${maskPoisoned.missing.length} 条 · 源真的被改过 = ${cssPoisoned !== css}`,
    )
  }
  {
    const jsFiles = existsSync(DIST) ? readdirSync(DIST).filter((f) => f.endsWith('.js')) : []
    const js = jsFiles.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')
    const backedOf = (s) => ({
      mix: [...s.matchAll(/background:\s*[`"']color-mix\(/g)].length,
      /* ⚠️🔴 **必须同时认反引号** —— 产物经 rolldown，字符串字面量是反引号；
         第一版判据写死 `"` ⇒ 三处兜底明明都在，却判成"一个都没进产物"（**假红**）。 */
      ok: [...s.matchAll(
        /backgroundColor:\s*[`"']var\(--color-canvas\)[`"']\s*,\s*background:\s*[`"']color-mix\(/g,
      )].length,
    })
    const now = backedOf(js)
    check(
      now.mix > 0 && now.ok === now.mix,
      '🔴 D17 ③ 产物 JS 里**每一处 `color-mix` 前面都垫了 `backgroundColor` 兜底，且兜底在前**（顺序反了新浏览器也恒不透明）',
      `color-mix ${now.mix} 处 · 有兜底且在前 ${now.ok} 处 · js 文件 ${jsFiles.length} 个`,
      '反向对照：见下一条（拿掉一处兜底 → 本条当场红）',
    )
    /* 🧪 **真**反向对照：从产物 JS 里删掉**第一处**兜底键，判据必须当场数出缺口 */
    const jsPoisoned = js.replace(
      /backgroundColor:\s*[`"']var\(--color-canvas\)[`"']\s*,\s*(background:\s*[`"']color-mix\()/g,
      '$1',
    )
    const poisoned = backedOf(jsPoisoned)
    check(
      now.ok === now.mix && poisoned.ok < now.ok && jsPoisoned !== js,
      '🧪 D17 ③ 反向对照：**从产物 JS 里删掉第一处兜底键** → 同一条判据当场数出"有兜底的"变少（③ 不是恒真的摆设）',
      `真产物 ${now.ok}/${now.mix} · 删掉一处后 ${poisoned.ok}/${poisoned.mix} · 源真的被改过 = ${jsPoisoned !== js}`,
    )
  }
}

/* ============================================================
   第二十节 · 🆕 A12：**版本更新公告**（2026-10-04，施工单 `施工单-版本更新提示.md`）
   ------------------------------------------------------------
   为什么这一节必须有：这个功能的**权威在服务端**（`functions/api/_lib/release.ts`），
   而前端为了能原样活在浏览器里**另抄了一份"共享区"**（与 `maintenance.ts` ↔
   `_lib/maintenance.ts` 同一条理由：前端产物与 Pages Function 是两个构建目标，
   跨目录 import 会把两边绑死）。抄一份的代价，必须**在门禁里补回来**。

   🔴 补的方式是**整段逐字节比对**，不是逐行 grep：
      漏抄一行在逐行 grep 下**可能一条都不红**（那一行两边的值各自仍自洽）——
      这正是"前后端各写一套"那类事故的入口。
      （那段逻辑原来在临时探针 `scripts/_tmp_relblock.mjs` 里，现在搬到这里。）

   ⚠️ 与 A10（全站公告）**一个字都不共享**：那是"给老师看的公告"（`announcements` 表），
      这是"客户端该不该提示更新"（`site_state` 的两行）。两个数据模型、两个接口。
   ============================================================ */

section('第二十节 · A12：版本更新公告（共享区逐字节相同 · 纯函数 · key/列名契约）')

{
  const rel = await import('../src/lib/release.ts')
  const srvSrc = readApp('functions/api/_lib/release.ts')
  const uiSrc = readApp('src/lib/release.ts')

  /* ---- ① 🔴 共享区**整段逐字节比对**（本功能最重要的一条）---- */
  {
    /** 从"共享区 —— 开始"切到"共享区 —— 结束"（两个锚点缺一个就返回 null，**不静默切空**） */
    const cut = (s) => {
      const t = String(s ?? '')
      const i = t.indexOf('共享区 —— 开始')
      const j = t.indexOf('共享区 —— 结束')
      if (i < 0 || j < 0 || j < i) return null
      return t.slice(i, j)
    }
    const a = cut(srvSrc) // 权威那一份（服务端）
    const b = cut(uiSrc) // 抄的那一份（前端）
    check(a !== null, 'A12：服务端那一份找得到共享区（开始 / 结束两个锚点都在）', `切出 ${a ? a.length : 0} 字符`)
    check(b !== null, 'A12：前端那一份找得到共享区', `切出 ${b ? b.length : 0} 字符`)
    check(
      a !== null && b !== null && a === b,
      '🔴 A12：两边的共享区**逐字节相同**（"前后端各写一套"那类事故的解药）',
      `服务端 ${a ? a.length : 0} 字符 · 前端 ${b ? b.length : 0} 字符` +
        (a !== null && b !== null ? (a === b ? '（相同）' : ' —— **不一样**') : ' —— **有一边没切出来**'),
      '反向对照：本节末尾那条（从服务端那一份里漏抄一行 → 本条当场红）',
    )
    /* 自证：切出来的确实是那一段（含关键符号、且**不含**结束锚点） */
    check(
      a !== null && a.includes('RELEASE_KEYS') && a.includes('validateReleaseForm') && !a.includes('共享区 —— 结束'),
      'A12 自证：切出来的那一段确实是共享区（含 RELEASE_KEYS / validateReleaseForm，且不含结束锚点）',
      a === null ? '没切出来' : `${a.length} 字符`,
    )
    /* 自证②：锚点缺一个就切不出来 —— 判据本身必须会红，不是恒真 */
    eq('A12 自证②：锚点缺一个就切不出来（`cut()` 不是恒真）', cut('这里没有那两个锚点'), null)
    /* 🧪 **真**反向对照：**真的**从服务端那一份里删掉共享区中的一行，再走同一条判据 */
    const leaked = srvSrc.replace(/^.*export const RELEASE_TITLE_SOFT = .*$/m, '')
    const c = cut(leaked)
    check(
      leaked !== srvSrc && c !== null && c !== b,
      '🧪 A12 反向对照：从服务端那一份里**漏抄一行**（删掉 RELEASE_TITLE_SOFT）→ 逐字节比对当场红',
      `删掉那一行后切出 ${c ? c.length : 0} 字符 · 与前端那份相同 = ${c === b}`,
      '逐行 grep 在这一步**可能一条都不红** —— 这就是"整段比对"存在的唯一理由',
    )
  }

  /* ---- ② 纯函数（真 TS 模块，照 A7/A10 的写法 import 进来）---- */
  {
    const slotsOf = (notice, read = 'ok') => ({ teacher: notice, classroom: null, read, reason: '' })
    const N = (patch = {}) => ({ version: '1.1.1', force: false, note: 'x', urlApk: '', urlExe: '', ...patch })

    /* ②-1 版本比较：形状不对就说"认不出"（`null`），**不许当 0** */
    eq("A12：cmpVersion('1.1.0','1.1.1') === -1", rel.cmpVersion('1.1.0', '1.1.1'), -1)
    eq("A12：cmpVersion('1.2.0','1.1.9') === 1", rel.cmpVersion('1.2.0', '1.1.9'), 1)
    eq("A12：cmpVersion('1.1.0','1.1.0') === 0", rel.cmpVersion('1.1.0', '1.1.0'), 0)
    eq("A12：cmpVersion('1.1','1.1.0') === null（形状不对 ⇒ 认不出，不许当 0）", rel.cmpVersion('1.1', '1.1.0'), null)
    eq("A12：cmpVersion('v1.1.1','1.1.0') === null（带前缀也不行）", rel.cmpVersion('v1.1.1', '1.1.0'), null)

    /* ②-2 三态判定：五种取值各自一条 */
    eq("A12：公告 1.1.1、我 1.1.0 → 'behind'", rel.releaseCheck(slotsOf(N()), 'teacher', '1.1.0'), 'behind')
    eq(
      "A12：公告与我**同版本**（1.1.0）→ 'uptodate'（不是 behind）",
      rel.releaseCheck(slotsOf(N({ version: '1.1.0' })), 'teacher', '1.1.0'),
      'uptodate',
    )
    eq(
      "🔴 A12：read:'failed' → 'unreadable'（**读不到 ⇒ 不提示**）",
      rel.releaseCheck(slotsOf(N(), 'failed'), 'teacher', '1.1.0'),
      'unreadable',
    )
    eq(
      "🔴 A12：read:'missing' → 'unreadable'（旧服务端同样不提示）",
      rel.releaseCheck(slotsOf(N(), 'missing'), 'teacher', '1.1.0'),
      'unreadable',
    )
    eq("A12：没有公告且 read:'ok' → 'none'", rel.releaseCheck(slotsOf(null), 'teacher', '1.1.0'), 'none')
    eq(
      "A12：公告版本写成 'abc' → 'notnew'（有公告但比不出来）",
      rel.releaseCheck(slotsOf({ version: 'abc' }), 'teacher', '1.1.0'),
      'notnew',
    )
    /*
     * 🔴🔴 本功能最要紧的那条口径：**只有 `behind` 才提示**。
     *    "读不到不许当已是最新"就落在这一条上 —— 上面那五条各自绿了还不够，
     *    要**一起**证明除 `behind` 之外的每一种都 `!== 'behind'`（少一种都算漏）。
     */
    {
      const others = [
        ['同版本', rel.releaseCheck(slotsOf(N({ version: '1.1.0' })), 'teacher', '1.1.0')],
        ['这一档没有公告', rel.releaseCheck(slotsOf(null), 'teacher', '1.1.0')],
        ['公告版本写坏了', rel.releaseCheck(slotsOf({ version: 'abc' }), 'teacher', '1.1.0')],
        ['读库失败', rel.releaseCheck(slotsOf(N(), 'failed'), 'teacher', '1.1.0')],
        ['回话里没有这一段', rel.releaseCheck(slotsOf(N(), 'missing'), 'teacher', '1.1.0')],
      ]
      check(
        others.length === 5 && others.every(([, v]) => v !== 'behind'),
        '🔴 A12：**只有 behind 才提示** —— 另外五种（含"读不到"两种）**一个都不是 behind**',
        others.map(([k, v]) => `${k}=${v}`).join(' · '),
        '它们被合并进 uptodate 的那一刻，"读不到"就变成了"已是最新"',
      )
      eqSet('🔴 A12 自证：这五种里**没有一种**落在 behind 上（多一种就要来这儿说清它为什么该在）', others.filter(([, v]) => v === 'behind').map(([k]) => k), [])
    }

    /* ②-3 默认正文（两种档位各一句） */
    eq(
      "A12：releaseDefaultNote('1.1.1', false) === 'v1.1.1 已发布，建议更新。'",
      rel.releaseDefaultNote('1.1.1', false),
      'v1.1.1 已发布，建议更新。',
    )
    eq(
      "A12：releaseDefaultNote('1.1.1', true) === 'v1.1.1 已发布，更新后可继续使用。'",
      rel.releaseDefaultNote('1.1.1', true),
      'v1.1.1 已发布，更新后可继续使用。',
    )

    /* ②-4 点出去是哪条链接：**手机不给 exe、电脑不给 apk**（拿错了那个包装不上）
       🔴 2026-10-05：下面这些夹具域名换成**白名单里**的（`gitee.com`）—— `isReleaseUrl()`
       现在会拒陌生域名，`https://a/...` 那种假域名会被闸门拒掉 ⇒ 期望值跟着夹具一起改。
       **只换域名，判据一个字没松** ✗。 */
    {
      const one = {
        version: '1.1.1',
        force: false,
        note: '',
        urlApk: 'https://gitee.com/x.apk',
        urlExe: 'https://gitee.com/x.exe',
      }
      eq("A12：platform='capacitor'（手机）→ urlApk", rel.pickReleaseUrl(one, 'capacitor'), 'https://gitee.com/x.apk')
      eq("A12：platform='electron'（电脑）→ urlExe", rel.pickReleaseUrl(one, 'electron'), 'https://gitee.com/x.exe')
      eq('A12：platform=null（网页端）→ urlExe || urlApk', rel.pickReleaseUrl(one, null), 'https://gitee.com/x.exe')
      check(
        rel.pickReleaseUrl(one, 'capacitor') !== one.urlExe,
        '🔴 A12：手机那一端**不给 exe**（拿错了装不上）',
        `capacitor → ${rel.pickReleaseUrl(one, 'capacitor')}`,
      )
      check(
        rel.pickReleaseUrl(one, 'electron') !== one.urlApk,
        '🔴 A12：电脑那一端**不给 apk**（拿错了装不上）',
        `electron → ${rel.pickReleaseUrl(one, 'electron')}`,
      )
      eq(
        '🔴 A12：电脑那一端**只有 apk** 时 → 空串（宁可不给按钮，也不给一个装不上的包）',
        rel.pickReleaseUrl({ ...one, urlExe: '' }, 'electron'),
        '',
      )
      eq(
        'A12：手机那一端**只有 exe** 时 → 空串（同上，反方向）',
        rel.pickReleaseUrl({ ...one, urlApk: '' }, 'capacitor'),
        '',
      )
    }

    /* ②-5 我这一台是哪一档（判据只有 `releaseTargetOf` 一处） */
    eq("A12：releaseTargetOf('classroom','/') === 'classroom'", rel.releaseTargetOf('classroom', '/'), 'classroom')
    eq(
      "A12：releaseTargetOf('unknown','/classroom') === 'classroom'（网页里的教室端账号）",
      rel.releaseTargetOf('unknown', '/classroom'),
      'classroom',
    )
    eq("A12：releaseTargetOf('unknown','/') === 'teacher'（网页端跟随教师端）", rel.releaseTargetOf('unknown', '/'), 'teacher')
    eq("A12：releaseTargetOf('unknown','/admin') === 'teacher'", rel.releaseTargetOf('unknown', '/admin'), 'teacher')

    /* ②-6 `/api/status` 回话 → 两档公告（含**旧服务端**那一支） */
    {
      const u = rel.releaseSlotsFromStatus(undefined)
      eq("🔴 A12：releaseSlotsFromStatus(undefined) ⇒ read='missing'（旧服务端 / 没部署到这一版）", u.read, 'missing')
      check(
        u.teacher === null && u.classroom === null,
        '🔴 A12：而且**两档都是 null**（回话里没有这一段 ⇒ 一档都不许瞎猜）',
        `teacher=${JSON.stringify(u.teacher)} · classroom=${JSON.stringify(u.classroom)}`,
      )
      eq("A12：{read:'failed'} ⇒ read='failed'（读不到 ≠ 没有公告）", rel.releaseSlotsFromStatus({ read: 'failed' }).read, 'failed')
      const ok = rel.releaseSlotsFromStatus({
        read: 'ok',
        teacher: {
          enabled: true,
          version: '1.1.1',
          force: false,
          message: '',
          url_apk: 'https://gitee.com/x.apk',
          url_exe: '',
        },
      })
      eq(
        'A12：一档 enabled + 版本 1.1.1 + message 空 ⇒ 正文 = **默认那句**',
        ok.teacher ? ok.teacher.note : null,
        'v1.1.1 已发布，建议更新。',
      )
      check(
        ok.classroom === null,
        'A12：回话里**没给**的那一档仍是 null（不是"拿教师端那条顶替"）',
        JSON.stringify(ok.classroom),
      )
      eq(
        "A12：`{version:'1.1'}`（写坏了）⇒ 那一档 null（写坏的行不许拿去跟客户端比）",
        rel.releaseSlotsFromStatus({ read: 'ok', teacher: { enabled: true, version: '1.1' } }).teacher,
        null,
      )
    }

    /* ②-7 禁词体检 + 发布前校验（**都必须能红**，所以各带一个反向对照） */
    {
      const hit = rel.bannedWordIn('点击这里并允许未知来源')
      check(
        hit !== null,
        '🔴 A12（**反向对照**）：bannedWordIn(\'点击这里并允许未知来源\') 非 null（禁词表真的在生效）',
        JSON.stringify(hit),
      )
      eq(
        'A12：干净的那句默认正文 → null（反向对照的另一半：别把正常话判成禁词）',
        rel.bannedWordIn('v1.1.1 已发布，建议更新。'),
        null,
      )
      const bad = rel.validateReleaseForm({
        target: 'teacher',
        enabled: true,
        version: '1.1.1',
        force: true,
        note: '禁止安装包提示',
        urlApk: '',
        urlExe: '',
      })
      eq(
        "🔴 A12（**反向对照**）：正文写「禁止安装包提示」⇒ validateReleaseForm 判 rule==='R4'",
        bad.ok === false ? bad.rule : `ok=${JSON.stringify(bad)}`,
        'R4',
      )
      const good = rel.validateReleaseForm({
        target: 'teacher',
        enabled: true,
        version: '1.1.1',
        force: true,
        note: '建议更新。',
        urlApk: 'https://gitee.com/x.apk',
        urlExe: '',
      })
      eq('A12：干净的表单 → ok:true（上面那条 R4 不是"一律拒绝"）', good.ok, true)
    }

    /* ②-8 🆕 2026-10-04：「我的 → 关于」那三颗下载按钮（用户「我的」页三处改动的第 ① 条）
       ------------------------------------------------------------
       用户原话：「把学科学段和存储位置删了，放三个按钮，分别是下载教师端（安卓）
       下载教师端（Windows）下载教室端（Windows）……按钮就绑定面板里面我填的网址就好了」。
       🔴 三条要钉的，每条都能红：
         · **绑的是哪一列**：教师端两颗各看自己那一列（`urlApk` / `urlExe`），
           教室端那颗只看 `urlExe`（那块屏是一体机）—— 与 `pickReleaseUrl` 的分端口径同源；
         · **没填就不出现**：四种组合（都没填 / 只填 apk / 只填 exe / 两个都填）逐个数 ——
           点了没反应的死按钮比屏上少一颗按钮糟得多；
         · **只认 https**：`http://` 与 `javascript:` 一律不算（与面板那侧 R5 同一个判据）。
       ⚠️ 屏上那一半（真 DOM 上按钮的文案与 href）在 `shots.mjs`；这里钉的是**同一个纯函数**
          （`Settings.tsx` 调的就是它，接线见 D18）。
    */
    {
      /**
       * 🔴 **期望值 2026-10-04 变了**（用户拍板：「公告撤下了，下载也照样能用」）：
       *    从前 `releaseDownloads()` 读的是**公告那一层**（`slots.teacher` / `slots.classroom`），
       *    而那一层在"撤下"时是 `null` ⇒ 三颗按钮跟着公告一起消失。
       *    现在它读的是 **`slots.downloads`**（服务端 `release.downloads` 子块，
       *    **不看 `enabled`**）⇒ 按钮**不随公告状态消失**。
       *    ⚠️ 所以下面每一条都要**显式带上 `downloads`**：
       *       只给 `teacher` / `classroom`（公告那一层）已经**摆不出**按钮了。
       */
      const downloadsOf = (apk, exe) => ({
        teacher: { url_apk: apk, url_exe: exe },
        classroom: { url_apk: '', url_exe: '' },
      })
      const EMPTY_DL = { teacher: { url_apk: '', url_exe: '' }, classroom: { url_apk: '', url_exe: '' } }
      const slotsOf = (t, c, dl = EMPTY_DL) => ({ teacher: t, classroom: c, read: 'ok', reason: '', downloads: dl })
      const noticeOf = (apk, exe) => ({ version: '1.1.2', force: false, note: '', urlApk: apk, urlExe: exe })
      const keys = (l) => l.map((d) => d.key)
      /*
       * 🔴 2026-10-05：夹具域名换成**白名单里**的（`RELEASE_URL_HOSTS`：`gitee.com` / `github.com` /
       *    `objects.githubusercontent.com` / `shugao-teacher.pages.dev`；**主机名逐字相等、不认子域**）。
       *    为什么必须换：`isReleaseUrl()` 现在会拒陌生域名，而 `dl.example.com` / `a` 这种假域名
       *    会被闸门直接拒掉 ⇒ 三颗按钮**一颗都摆不出来**、`validateReleaseForm` 也判 false
       *    （判据当场红 —— 那是**夹具过期**，不是产品坏了）。**只换域名，判据一个字没松** ✗。
       */
      const A = 'https://gitee.com/teacher.apk'
      const E = 'https://gitee.com/teacher.exe'
      const C = 'https://gitee.com/classroom.exe'

      /* ---- 四种组合逐个（"没填就不出现"那一条） ---- */
      eqSet('🔴 A12：教师端**只填了安卓**那个地址 ⇒ 只有「下载教师端（安卓）」那一颗', keys(rel.releaseDownloads(slotsOf(noticeOf(A, ''), null, downloadsOf(A, '')))), ['teacher-apk'])
      eqSet('🔴 A12：教师端**只填了 Windows** 那个地址 ⇒ 只有「下载教师端（Windows）」那一颗', keys(rel.releaseDownloads(slotsOf(noticeOf('', E), null, downloadsOf('', E)))), ['teacher-exe'])
      eqSet('🔴 A12：两个都填 ⇒ 两颗都在', keys(rel.releaseDownloads(slotsOf(noticeOf(A, E), null, downloadsOf(A, E)))), ['teacher-apk', 'teacher-exe'])
      eqSet('🔴 A12：**一个都没填** ⇒ 一颗都不摆', keys(rel.releaseDownloads(slotsOf(noticeOf('', ''), null, downloadsOf('', '')))), [])

      /* 🔴 2026-10-04 新增（期望值**故意**变了的那一条）：公告那一层翻不动按钮
         `downloads` 一样、只把公告那一层从"在发"换成"撤下"（`null`）⇒ **按钮数不变** */
      eqSet(
        '🔴 A12：**公告撤下**（`teacher: null`）但 `downloads` 有地址 ⇒ 两颗**照样在**' +
          '（用户 2026-10-04 拍板的那一条：下载与公告分开）',
        keys(rel.releaseDownloads(slotsOf(null, null, downloadsOf(A, E)))),
        ['teacher-apk', 'teacher-exe'],
      )
      /* 🧪 反向对照 D（**关键**：证明按钮真挂在**新字段**上，而不是"公告那一层还在顺带给"）：
         URL 一模一样，只把 `downloads` 那一块从 `/api/status` 回话里摘掉，只留公告那一层
         ⇒ **一颗都摆不出来**。谁把 `releaseDownloads()` 改回去读公告那一层，上面那两颗就会
         变成 0 颗 ⇒ 当场红。（旧代码正是这么读的 —— 那正是用户点名的那个 bug。） */
      {
        const withDl = rel.releaseSlotsFromStatus({
          read: 'ok',
          teacher: noticeOf(A, E),
          classroom: null,
          downloads: downloadsOf(A, E),
        })
        const onlyNotice = rel.releaseSlotsFromStatus({ read: 'ok', teacher: noticeOf(A, E), classroom: null })
        check(
          keys(rel.releaseDownloads(withDl)).length === 2 && keys(rel.releaseDownloads(onlyNotice)).length === 0,
          '🧪 A12 反向对照 D：地址只放在**公告那一层**（没有 `downloads` 那一块）⇒ 0 颗；' +
            '放进 `downloads` 那一层 ⇒ 2 颗（证明按钮读的是新字段，不是公告）',
          `带 downloads=${keys(rel.releaseDownloads(withDl)).length} 颗 · 只有公告那一层=${keys(rel.releaseDownloads(onlyNotice)).length} 颗`,
        )
      }

      /* ---- 教室端那颗只看 exe ---- */
      const clsOnly = rel.releaseDownloads(
        slotsOf(null, noticeOf(A, C), { teacher: { url_apk: '', url_exe: '' }, classroom: { url_apk: A, url_exe: C } }),
      )
      eqSet('🔴 A12：教室端**只看 `url_exe`**（`url_apk` 填了也不摆那一颗）', keys(clsOnly), ['classroom-exe'])
      eq('A12：教室端那颗用的就是 `release.downloads.classroom.url_exe`', clsOnly[0]?.url, C)

      /* ---- 三颗一起：顺序 + 绑定 + 措辞 ---- */
      const three = rel.releaseDownloads(
        slotsOf(noticeOf(A, E), noticeOf('', C), {
          teacher: { url_apk: A, url_exe: E },
          classroom: { url_apk: A, url_exe: C },
        }),
      )
      eqSet('🔴 A12：两档都填时三颗的 key（就是用户点名的那三种）', keys(three), ['teacher-apk', 'teacher-exe', 'classroom-exe'])
      eq(
        '🔴 A12：三颗各绑**自己那一列**（教师 apk / 教师 exe / 教室 exe），顺序也是摆的顺序',
        three.map((d) => d.url).join(' · '),
        `${A} · ${E} · ${C}`,
      )
      eq(
        '🔴 A12：三句措辞就是用户点名的那三句（页面里不再各抄一份）',
        three.map((d) => d.label).join(' · '),
        '下载教师端（安卓） · 下载教师端（Windows） · 下载教室端（Windows）',
      )

      /* ---- 只认 https ---- */
      eqSet(
        '🔴 A12：`http://` 与 `javascript:` 一律不算（三颗一颗都不摆 —— 面板 R5 走的是同一个判据）',
        keys(
          rel.releaseDownloads(
            slotsOf(noticeOf('', ''), null, downloadsOf('http://a/x.apk', 'javascript:alert(1)')),
          ),
        ),
        [],
      )

      /* 🧪 反向对照 A：把 `isReleaseUrl` 那道滤网从**源码副本**里去掉
         （副本写在 gitignore 的 `.tmp-gates/`，finally 里删）⇒「没填就不出现」当场假 */
      const REL_SRC = uiSrc
      const REL_TMP_A = join(APP, '.tmp-gates', `release-nofilter-${process.pid}.ts`)
      const noFilter = REL_SRC.replace('return rows.filter((r) => isReleaseUrl(r.url))', 'return rows')
      let badA = null
      try {
        mkdirSync(dirname(REL_TMP_A), { recursive: true })
        writeFileSync(REL_TMP_A, noFilter)
        const mod = await import(pathToFileURL(REL_TMP_A).href)
        badA = mod.releaseDownloads(slotsOf(noticeOf('', ''), null, downloadsOf(A, E))).length
      } catch (e) {
        badA = `副本没跑起来：${e?.message ?? e}`
      } finally {
        rmSync(REL_TMP_A, { force: true })
      }
      check(
        noFilter !== REL_SRC && badA === 3,
        '🧪 A12 ②-8 反向对照 A：把滤网去掉（源码副本，`.tmp-gates/` 里，finally 删）⇒ **三颗全摆出来**，「没填就不出现」当场假',
        `源码真被改过=${noFilter !== REL_SRC} · 去掉滤网后摆了 ${badA} 颗`,
      )

      /* 🧪 反向对照 B：把教师端两颗的**列**对调（apk ↔ exe）⇒「各绑自己那一列」当场假
         ⚠️ 2026-10-04 起 `releaseDownloads()` 读的是 `slots.downloads` 那一层，
            所以这里对调的**锚点**也跟着换成新字段（老锚点已经匹配不上，那条对照会静默失效）。 */
      const REL_TMP_B = join(APP, '.tmp-gates', `release-swap-${process.pid}.ts`)
      const swappedFrom =
        "{ key: 'teacher-apk', label: DL_TEACHER_APK, url: slots.downloads.teacher.url_apk },\n    { key: 'teacher-exe', label: DL_TEACHER_EXE, url: slots.downloads.teacher.url_exe },"
      const swappedTo =
        "{ key: 'teacher-apk', label: DL_TEACHER_APK, url: slots.downloads.teacher.url_exe },\n    { key: 'teacher-exe', label: DL_TEACHER_EXE, url: slots.downloads.teacher.url_apk },"
      const swapped = REL_SRC.replace(swappedFrom, swappedTo)
      let badB = null
      try {
        mkdirSync(dirname(REL_TMP_B), { recursive: true })
        writeFileSync(REL_TMP_B, swapped)
        const mod = await import(pathToFileURL(REL_TMP_B).href)
        badB = mod.releaseDownloads(slotsOf(noticeOf(A, E), null, downloadsOf(A, E))).map((d) => d.url)
      } catch (e) {
        badB = `副本没跑起来：${e?.message ?? e}`
      } finally {
        rmSync(REL_TMP_B, { force: true })
      }
      check(
        swapped !== REL_SRC && Array.isArray(badB) && badB[0] === E && badB[1] === A,
        '🧪 A12 ②-8 反向对照 B：把教师端两颗的列**对调**（apk ↔ exe，源码副本）⇒ 绑定判据当场假（证明它看的是"哪一列"，不是"有没有两颗"）',
        `源码真被改过=${swapped !== REL_SRC} · 对调后读到 ${JSON.stringify(badB)}`,
      )
    }

    /* ②-9 🔴 2026-10-04 用户拍板：「公告撤下了，下载也照样能用」
       ------------------------------------------------------------
       🔴 **期望值为什么翻过来了**（这一段从前钉的是**反面**）：
         从前「关于」那三颗按钮读的是**公告那一层**（`slots.teacher` / `slots.classroom`），
         而那一层由 `releaseFromRow()` 把守：`enabled !== true` ⇒ `null`
         ⇒ 面板把那一档「撤下」之后 `/api/status` 不给地址 ⇒ 那几颗跟着消失
         （当时把这条写进了门禁，还特意注明"别让后来的人把它当 bug 修掉"）。
         用户当天实测后拍板：**「公告撤下了，下载也照样能用」** ⇒ 口径改成"两件事分开"——
           · **公告**（`version` / `force` / `message`）仍然守 `enabled` 那道闸门
             （草稿不外泄，`releaseFromRow` 一个字没动）；
           · **下载地址**改读新字段 `release.downloads`（服务端 `releaseDownloadsFromRow()`，
             **不看 `enabled`**）⇒ 按钮**不再随公告状态变化**。
         ⚠️ 所以"撤下 ⇒ 收起"这句话现在**只对公告那一层成立**，对按钮那一层是**错的**。
       ------------------------------------------------------------------ */
    {
      const row = { enabled: false, version: '1.1.2', force: false, message: '', url_apk: 'https://gitee.com/x.apk', url_exe: 'https://gitee.com/x.exe' }
      /** 🔴 `keys` 是上面那一块的**块级**变量 —— 这里自己再定义一份（别跨块引用） */
      const keys = (l) => l.map((d) => d.key)
      /** 两端地址那一层（**不看 `enabled`**）：与公告那一层各自独立 */
      const dlOf = (r) => ({
        teacher: { url_apk: r.url_apk, url_exe: r.url_exe },
        classroom: { url_apk: '', url_exe: '' },
      })

      eq('🔴 A12：`enabled:false`（公告撤下）⇒ `releaseFromRow` 回 null（**公告**这几个字段照旧不给）', rel.releaseFromRow(row), null)
      eq(
        '🔴 A12：撤下时**公告**那一层确实是 null（草稿不外泄这条口径一个字没松）',
        rel.releaseSlotsFromStatus({ read: 'ok', teacher: row, classroom: null, downloads: dlOf(row) }).teacher,
        null,
      )

      /* 🔴 新口径：撤下时**按钮照样在** */
      const offSlots = rel.releaseSlotsFromStatus({ read: 'ok', teacher: row, classroom: null, downloads: dlOf(row) })
      eqSet(
        '🔴 A12：**撤下也照样摆出那两颗**（用户 2026-10-04 拍板：「公告撤下了，下载也照样能用」）',
        keys(rel.releaseDownloads(offSlots)),
        ['teacher-apk', 'teacher-exe'],
      )
      eq(
        '🔴 A12：而且两颗绑的就是库里存着的那两列（撤下只写 `enabled`，地址留在库里当下次预填）',
        rel.releaseDownloads(offSlots).map((d) => d.url).join(' · '),
        'https://gitee.com/x.apk · https://gitee.com/x.exe',
      )

      /* 🧪 反向对照 C（**期望值变了的那一条**）：
         从前是"只翻 `enabled` ⇒ 3 颗 → 0 颗"；现在**只翻 `enabled` ⇒ 按钮数不变**，
         变的只有**公告**那一层（有/无）。这一条同时钉住两件事：
           · 按钮不再随公告状态变化（新口径）；
           · 公告那一层仍然跟着 `enabled` 走（老口径那一半没丢）。 */
      const onRow = { ...row, enabled: true }
      const onSlots = rel.releaseSlotsFromStatus({ read: 'ok', teacher: onRow, classroom: null, downloads: dlOf(onRow) })
      check(
        rel.releaseDownloads(offSlots).length === 2 &&
          rel.releaseDownloads(onSlots).length === 2 &&
          offSlots.teacher === null &&
          onSlots.teacher !== null,
        '🧪 A12 ②-9 反向对照 C：**只翻 `enabled`** ⇒ 按钮 **2 颗 → 2 颗（不变）**，' +
          '而公告那一层 `null` → 有公告（**变的是公告，不是按钮**）' +
          '—— 期望值 2026-10-04 从"3 颗 → 0 颗"改成这一条',
        `撤下：按钮 ${rel.releaseDownloads(offSlots).length} 颗 / 公告 ${offSlots.teacher === null ? '无' : '有'} · ` +
          `在发：按钮 ${rel.releaseDownloads(onSlots).length} 颗 / 公告 ${onSlots.teacher === null ? '无' : '有'}`,
      )

      check(
        rel.releaseFromRow({ ...row, enabled: true }) !== null,
        'A12 自证：同一行把 `enabled` 翻成 true 就**读得到公告**（上一条不是"这个函数恒回 null"）',
        `enabled:true → urlExe=${rel.releaseFromRow({ ...row, enabled: true })?.urlExe ?? '(null)'}`,
      )

      /* 🧪 反向对照 D（**关键**）：地址只放在公告那一层（回话里**没有** `downloads` 那一块）
         ⇒ 现在**一颗都摆不出来**。谁把 `releaseDownloads()` 改回去读公告那一层，
         上面"撤下也照样摆出两颗"那一条就会变成 0 颗 ⇒ 当场红。 */
      const onlyNotice = rel.releaseSlotsFromStatus({ read: 'ok', teacher: onRow, classroom: null })
      check(
        keys(rel.releaseDownloads(onlyNotice)).length === 0 && keys(rel.releaseDownloads(onSlots)).length === 2,
        '🧪 A12 反向对照 D：地址只放在**公告那一层**（回话里没有 `downloads` 那一块）⇒ **0 颗**；' +
          '放进 `downloads` 那一层 ⇒ 2 颗（证明这两条判据量的是**新字段**，不是"公告还在顺带给"）',
        `只有公告那一层=${keys(rel.releaseDownloads(onlyNotice)).length} 颗 · 带 downloads=${keys(rel.releaseDownloads(onSlots)).length} 颗`,
      )
    }
  }

  /* ---- ③ 契约：key 与列名（施工单 §三）---- */
  {
    const schemaSql = readRepo('supabase/schema.sql')
    /*
     * 种子行 `insert into site_state (key) values ('…')` —— 先把**所有**这样的行扫出来，
     * 用 `maintenance` 那一行做自证（证明锚点在扫真的 §23，而不是什么都扫不到）。
     */
    const seeds = [...schemaSql.matchAll(/insert into site_state \(key\) values \('([^']+)'\)/g)].map((m) => m[1])
    check(
      seeds.includes('maintenance'),
      'A12 自证：锚点在扫 §23 的种子行（`maintenance` 那一行也扫到了 —— 不是"什么都扫不到"）',
      seeds.join('、'),
    )
    const relSeeds = [...new Set(seeds.filter((k) => k.startsWith('release:')))].sort()
    eqSet(
      '🔴 A12：schema.sql 里 `release:` 那两行种子 ↔ `RELEASE_KEYS` **逐字相同**（集合相等：多一行也红）',
      relSeeds,
      [rel.RELEASE_KEYS.teacher, rel.RELEASE_KEYS.classroom],
    )
    eq('A12：`RELEASE_KEYS.teacher` 就是种子行里那两个串之一', rel.RELEASE_KEYS.teacher, 'release:teacher')
    eq('A12：`RELEASE_KEYS.classroom` 就是种子行里那两个串之一', rel.RELEASE_KEYS.classroom, 'release:classroom')

    /* 列名：只从 §23.2.1 那一段里取 `add column if not exists <列>` */
    const i1 = schemaSql.indexOf('23.2.1')
    const i2 = schemaSql.indexOf('23.3 核对')
    check(i1 >= 0 && i2 > i1, 'A12 自证：找得到 §23.2.1 那一段（到「23.3 核对」之间）', `@${i1} ~ @${i2}`)
    const sec = i1 >= 0 && i2 > i1 ? schemaSql.slice(i1, i2) : ''
    const cols = [...sec.matchAll(/alter table site_state add column if not exists ([a-z_]+)/g)].map((m) => m[1])
    eqSet('🔴 A12：§23.2.1 加的四列就是那四个', cols, ['version', 'force', 'url_apk', 'url_exe'])
    const selMatch = srvSrc.match(/RELEASE_SELECT_COLS = '([^']*)'/)
    check(
      Boolean(selMatch),
      'A12：服务端找得到 `RELEASE_SELECT_COLS` 的字面量（锚点自证）',
      selMatch ? JSON.stringify(selMatch[1]) : '没找到',
    )
    const sel = selMatch ? selMatch[1] : ''
    /*
     * 🔴 这一条防的是"schema 加了列、服务端 select 没加"——
     *    症状是那一列**静默读不到**（前端拿到 undefined、按空值走），一条报错都没有。
     */
    for (const c of cols.length ? cols : ['version', 'force', 'url_apk', 'url_exe']) {
      check(
        sel.includes(c),
        `🔴 A12：\`RELEASE_SELECT_COLS\` **包含**列 \`${c}\`（schema 加了列而这里没加 = 那一列静默读不到）`,
        sel ? JSON.stringify(sel) : '（没解析到）',
      )
    }
    check(
      sel.includes('key') && sel.includes('enabled') && sel.includes('message'),
      'A12：另外三列（key / enabled / message）也在 select 里 —— 少任何一列，那一档就整条读不到',
      JSON.stringify(sel),
    )
    /* 🧪 反向对照：同一个 `includes` 判据喂一个不存在的列名 → 必须判"不包含" */
    check(
      sel !== '' && !sel.includes('nope_not_a_column'),
      '🧪 A12 反向对照：同一个 `includes` 判据喂一个不存在的列名 → 判"不包含"（上面那几条不是恒真）',
      JSON.stringify(sel),
    )
  }
}

/* ============================================================
   第二十节之二 · 🆕 D18：**"不许再开一个轮询"** + 闸门的挂载点
   ------------------------------------------------------------
   施工单 §二.4 原话：「与维护共用同一次请求，**不许再开一个轮询**」。
   两档公告跟着 `GET /api/status` 一起回来（`useMaintenance.ts` 的那一次取数），
   `useRelease.ts` 只做"取哪一档 + 我够不够新"的纯计算。

   为什么两条都要有：
     · 「没有 effect / 没有定时器」在**源码文本**上判（`shots` 量不到"没发请求"）；
     · 「闸门挂在 `MaintenanceGate` **里面**」才是"共用同一次取数"的**结构保证** ——
       一旦谁把 `<ReleaseGate>` 挪到 `App.tsx`，它就得自己去拿一份 status
       （= 第二个轮询），而那时**没有任何一条断言会响**。
   ============================================================ */

section('第二十节之二 · D18：两档公告跟着同一次 /api/status 回来（没有第二个轮询）')

{
  const strip = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /* ⚠️ 剥掉注释再查 —— 文件头那段注释里就写着"没有定时器、不发请求"这几个字 */
  const uiCode = strip(readApp('src/lib/useRelease.ts'))
  for (const [needle, why] of [
    ['setInterval', '定时器'],
    ['setTimeout', '定时器'],
    ['fetch(', '取数'],
  ]) {
    eq(
      `🔴 D18（施工单 §二.4「不许再开一个轮询」）：\`src/lib/useRelease.ts\` 里没有 ${why} \`${needle}\``,
      uiCode.includes(needle),
      false,
    )
  }
  check(
    uiCode.includes('releaseCheck') && uiCode.includes('releaseTargetOf') && uiCode.includes('pickReleaseUrl'),
    'D18 自证：useRelease.ts 里确实有那三个纯计算（读的是真文件，不是空串）',
    `${uiCode.length} 字符`,
  )
  /* 🧪 反向对照：同一段判据喂 `useMaintenance.ts`（它**本来就有**这两个定时器）→ 两个 needle 都命中 */
  const umCode = strip(readApp('src/lib/useMaintenance.ts'))
  check(
    umCode.includes('setInterval') && umCode.includes('setTimeout'),
    '🧪 D18 反向对照：同样的判据喂 `useMaintenance.ts` → `setInterval` / `setTimeout` **都命中**（证明上面那几条不是"什么都搜不到"）',
    `setInterval=${umCode.includes('setInterval')} · setTimeout=${umCode.includes('setTimeout')}`,
  )

  /* ---- 🆕 2026-10-04：「我的 → 关于」那三颗下载按钮读的是**同一次取数**（不是第二个轮询）----
     用户当天第 ① 条要求那三颗按钮"绑定面板里面我填的网址"（= `/api/status` 的 `release` 块），
     而这一页**不许**自己再取一次（施工单原话「不许再开一个轮询」）。
     落地办法：`ReleaseGate` 用 React context 把 `status.release`（就是 `MaintenanceGate`
     那唯一一次 `useMaintenanceStatus()` 的结果）往下传，`Settings.tsx` 用 `useReleaseSlots()` 读。
     🔴 四条一起才成立（缺一条就是"看着能用、其实又开了一个轮询"）：
        · Provider 在 `ReleaseGate` 里、`value` 就是 `status.release`；
        · 默认值是 `RELEASE_SLOTS_UNKNOWN`（没有 Provider ⇒ 一颗按钮都摆不出来，不是死按钮）；
        · 「我的」页**没有** `useMaintenanceStatus` / `fetch(` / `setInterval` 这些第二次取数的入口；
        · 而它确实读的是 `useReleaseSlots()`（自证：上一条不是"那一页什么都没写"）。
  */
  const urCode = strip(readApp('src/lib/useRelease.ts'))
  const rgCode = strip(readApp('src/components/ReleaseGate.tsx'))
  const setCode = strip(readApp('src/pages/Settings.tsx'))
  check(
    rgCode.includes('ReleaseSlotsContext.Provider value={status.release}'),
    '🔴 D18：三颗下载按钮的链接来自**同一个 Provider** —— `ReleaseGate.tsx` 里 `ReleaseSlotsContext.Provider value={status.release}`（那个 `status` 就是维护那一次取数的结果）',
    `ReleaseGate 里的 Provider=${rgCode.includes('ReleaseSlotsContext.Provider value={status.release}')}`,
    '把 `value` 换成自己算一份 / 换到别处去取 = 第二个轮询',
  )
  check(
    /createContext<ReleaseSlots>\(RELEASE_SLOTS_UNKNOWN\)/.test(urCode),
    '🔴 D18：`ReleaseSlotsContext` 的默认值是 `RELEASE_SLOTS_UNKNOWN`（**没有 Provider 时一颗按钮都摆不出来**，而不是摆一颗点了没反应的死按钮）',
    `默认值那一行=${/createContext<ReleaseSlots>\(RELEASE_SLOTS_UNKNOWN\)/.test(urCode)}`,
  )
  const noSecondPoll = (s) =>
    s.includes('useReleaseSlots()') &&
    !s.includes('useMaintenanceStatus') &&
    !s.includes('fetch(') &&
    !s.includes('setInterval')
  check(
    noSecondPoll(setCode),
    '🔴 D18：「我的」页读链接走 `useReleaseSlots()`，而且那一页里**没有** `useMaintenanceStatus` / `fetch(` / `setInterval`（第二次取数的入口一个都不许有）',
    `useReleaseSlots=${setCode.includes('useReleaseSlots()')} · useMaintenanceStatus=${setCode.includes('useMaintenanceStatus')} · fetch(=${setCode.includes('fetch(')} · setInterval=${setCode.includes('setInterval')}`,
  )
  /* 🧪 反向对照：把 `useMaintenanceStatus()` 塞进「我的」页的**源码副本**（不动磁盘）⇒ 上面那条当场假 */
  const setPolling = setCode.replace('  const downloads = releaseDownloads(', '  const dup = useMaintenanceStatus()\n  const downloads = releaseDownloads(')
  check(
    setPolling !== setCode && !noSecondPoll(setPolling),
    '🧪 D18 反向对照：往「我的」页的副本里塞一句 `useMaintenanceStatus()` ⇒ 同一条判据当场假（证明它真的在数"有没有第二个取数入口"）',
    `副本真被改过=${setPolling !== setCode} · 塞进去之后判据=${noSecondPoll(setPolling)}`,
  )

  /* ---- 闸门挂在 MaintenanceGate **里面**（共用同一次取数）---- */
  const mgSrc = readApp('src/components/MaintenanceGate.tsx')
  const appSrc = readApp('src/App.tsx')
  const gateAt = mgSrc.indexOf('export function MaintenanceGate')
  const relAt = mgSrc.indexOf('<ReleaseGate')
  check(
    gateAt >= 0 && relAt > gateAt && /<ReleaseGate\s+status=\{status\}>\{children\}<\/ReleaseGate>/.test(mgSrc),
    '🔴 D18：`<ReleaseGate status={status}>{children}</ReleaseGate>` **挂在 `MaintenanceGate` 内部**（`status` 就是手上那一次取数的结果）',
    `MaintenanceGate @${gateAt} · <ReleaseGate> @${relAt}`,
    '挪到 App.tsx = 它得自己再拿一份 status = 第二个轮询',
  )
  eq(
    '🔴 D18：`ReleaseGate` 在 `App.tsx` 里**一次都没出现**（出现即 = 第二次取数 / 第二个轮询的入口）',
    appSrc.includes('ReleaseGate'),
    false,
  )
  check(
    appSrc.includes('<MaintenanceGate>'),
    'D18 自证：`App.tsx` 里确实挂着 `<MaintenanceGate>`（上一条读的是真文件，不是"什么都搜不到"）',
    `${appSrc.length} 字符`,
  )
  /* 两张豁免表**各存一份**（理由不同：维护还要豁免 /classroom，公告不豁免）—— 别被"顺手合并"掉 */
  eq(
    'D18：两张豁免表**都在各自那一份文件里**（维护那张还含 `/classroom`，公告这张只含 `/login` 与 `/admin`）',
    `${mgSrc.includes("MAINTENANCE_EXEMPT_PATHS = ['/admin', '/classroom'] as const")}/${readApp('src/components/ReleaseGate.tsx').includes("RELEASE_EXEMPT_PATHS = ['/login', '/admin'] as const")}`,
    'true/true',
  )
}

/* ============================================================
   第二十节之三 · 🆕 A13：**输入法组字的全局镜像**（2026-10-04，「apk 上点按钮吞字」）
   ------------------------------------------------------------
   用户报的症状（原话）：「点按钮后会把输入了的字吞掉几个」；进一步确认是
   「**字在框里也没了**」—— 不是"没保存"，是屏上就少了那几个字。
   根因两步（`src/lib/imeMirror.ts` 的文件头写全了）：
     ① 拼音还没选词时，那几个字**已经在编辑框里**（屏上看得见），而 React 那侧的状态没有它们；
     ② 于是任何一次「点按钮 → setState → 重渲染 / 重挂载」都可能**把旧值写回** ⇒ 那几个字被冲掉。
   修法：在 `document` 的**捕获**阶段听 `compositionupdate` / `compositionend`，
   收到就在那个框上补派发**一个冒泡的 `input`**（`isComposing: false`）⇒ 受控输入重读
   `el.value`（里面已含未上屏的拼音）⇒ 状态跟上屏 ⇒ 那次写回成了空操作。

   为什么这一节必须有（`shots` 那一节量的是真浏览器里的屏，量不到下面这四件事）：
     · 补的**恰好一个**（多补 = 无谓重渲染；不补 = 修法等于没装）；
     · 必须**冒泡**（React 18 的监听挂在容器上，不冒泡就永远到不了它）；
     · 必须 `isComposing: false`（标成"组字中"，React 会把这一笔当还没上屏丢掉）；
     · 必须挂在**捕获**阶段（挂冒泡就**晚于** React 的容器监听 —— 那正是这个 bug）。
   ⚠️ 这里**不 import 任何 React**，自己搭一个最小假 DOM + 真模块（照 D15 那个路子）。
   ⚠️ 假输入框覆盖四类：`<input type=text>` / `<textarea>` 要补，
      `<input type=checkbox>` / `<div>` **不许补**（补了就是凭空制造一次输入）。
   ============================================================ */

section('第二十节之三 · A13：输入法组字镜像（捕获阶段补派发一个冒泡的 input）')

{
  const IME_REL = 'src/lib/imeMirror.ts'
  const IME_SRC = readApp(IME_REL)
  const IME_TMP = join(APP, '.tmp-gates', `imeMirror-no-dispatch-${process.pid}.ts`)

  /* 假 DOM 用完**还回去**：这一节之后（含以后新添的节）还得在干净的 Node 环境里跑 */
  const SAVED = new Map()
  const put = (k, v) => {
    if (!SAVED.has(k)) SAVED.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    globalThis[k] = v
  }
  const putBack = () => {
    for (const [k, d] of SAVED) {
      if (d) Object.defineProperty(globalThis, k, d)
      else delete globalThis[k]
    }
    SAVED.clear()
  }

  /** 一个"全新页面"的假环境：监听表 + 幂等标记清掉（模块用的是 `window` 上的标记） */
  const freshPage = () => {
    const listeners = {}
    put('window', globalThis)
    put('document', {
      addEventListener: (t, fn, capture) => {
        ;(listeners[t] ||= []).push({ fn, capture })
      },
    })
    delete globalThis.__imeMirrorInstalled
    return listeners
  }
  /** 假输入框：记下它收到了哪些事件（真 DOM 里没写 `type` 的 `<input>` 读出来是 `'text'`） */
  const field = (props) => {
    const got = []
    return {
      got,
      el: {
        ...props,
        dispatchEvent: (ev) => {
          got.push(ev)
          return true
        },
      },
    }
  }
  /** 手动放一次组字事件 —— `{ target: 假框 }` 就是那个捕获监听真正会收到的东西 */
  const fire = (listeners, type, props) => {
    const f = field(props)
    for (const l of listeners[type] ?? []) l.fn({ target: f.el })
    return f.got
  }

  try {
    put(
      'Event',
      class {
        constructor(type, init) {
          this.type = type
          this.bubbles = !!init?.bubbles
        }
      },
    )
    put(
      'InputEvent',
      class extends globalThis.Event {
        constructor(type, init) {
          super(type, init)
          this.isComposing = !!init?.isComposing
        }
      },
    )

    const ime = await import('../src/lib/imeMirror.ts')

    /* ---- ① 幂等：连装三次，两个事件各**只挂一个**监听 ---- */
    const L = freshPage()
    ime.installImeMirror()
    ime.installImeMirror()
    ime.installImeMirror()
    check(
      L['compositionupdate']?.length === 1 && L['compositionend']?.length === 1,
      '🔴 A13 ① `installImeMirror()` **连装三次** ⇒ `compositionupdate` / `compositionend` 各只挂**一个**监听（幂等：热更新重装不会让一次组字补三遍）',
      `compositionupdate=${L['compositionupdate']?.length ?? 0} · compositionend=${L['compositionend']?.length ?? 0}`,
    )
    /* ---- ② 挂的是**捕获**阶段（挂冒泡 = 晚于 React 的容器监听 = 补的 input 到不了它）---- */
    check(
      L['compositionupdate']?.[0]?.capture === true && L['compositionend']?.[0]?.capture === true,
      '🔴 A13 ② 两个监听都装在 `document` 的**捕获**阶段（React 18 的监听在容器上 —— 挂冒泡就晚于它）',
      `update.capture=${L['compositionupdate']?.[0]?.capture} · end.capture=${L['compositionend']?.[0]?.capture}`,
    )

    /* ---- ③ 补派发：**恰好一个**、冒泡、不是"组字中" ---- */
    for (const type of ['compositionupdate', 'compositionend']) {
      const got = fire(L, type, { tagName: 'TEXTAREA' })
      const one = got[0]
      check(
        got.length === 1 && one?.type === 'input' && one.bubbles === true && one.isComposing === false,
        `🔴 A13 ③ \`${type}\`（textarea）⇒ **恰好一个** \`input\`，\`bubbles === true\` 且 \`isComposing === false\``,
        got.length
          ? `${got.length} 个：${got.map((e) => `${e.type}(bubbles=${e.bubbles}, isComposing=${e.isComposing})`).join('、')}`
          : '一个都没补',
        '把 `bubbles: true` 改成 false、或 `isComposing` 改成 true → 这条必须红',
      )
    }

    /* ---- ④ 哪些框**要**补 ---- */
    const text = fire(L, 'compositionupdate', { tagName: 'INPUT', type: 'text' })
    const tel = fire(L, 'compositionupdate', { tagName: 'INPUT', type: 'tel' })
    check(
      text.length === 1 && tel.length === 1,
      "🔴 A13 ④ 文本输入都补：`<input type='text'>` 与 `<input type='tel'>` 各补一个",
      `text → ${text.length} 个 · tel → ${tel.length} 个`,
    )
    /* ---- ⑤ 哪些框**不许**补 ---- */
    const box = fire(L, 'compositionupdate', { tagName: 'INPUT', type: 'checkbox' })
    const div = fire(L, 'compositionupdate', { tagName: 'DIV' })
    check(
      box.length === 0 && div.length === 0,
      '🔴 A13 ⑤ 非文本**一个都不许补**（`checkbox` / `div`）—— 补了就是凭空制造一次输入',
      `checkbox → ${box.length} 个 · div → ${div.length} 个`,
    )

    /* ---- ⑥ 🔴 反向对照：把补派发那一行就地删掉，写成 `.tmp-gates/` 里的副本（跑完删）---- */
    const broken = IME_SRC.replace(/^[ \t]*el\.dispatchEvent\(ev\)[ \t]*$/m, '    /* 反向对照：这一行被删掉 */')
    let brokenGot = null
    try {
      mkdirSync(dirname(IME_TMP), { recursive: true })
      writeFileSync(IME_TMP, broken)
      const LB = freshPage()
      const old = await import(pathToFileURL(IME_TMP).href)
      old.installImeMirror()
      brokenGot = fire(LB, 'compositionupdate', { tagName: 'TEXTAREA' })
    } catch (e) {
      brokenGot = `副本没跑起来：${e?.message ?? e}`
    } finally {
      rmSync(IME_TMP, { force: true })
    }
    check(
      broken !== IME_SRC && Array.isArray(brokenGot) && brokenGot.length === 0,
      '🧪 A13 ⑥ 反向对照：删掉补派发那一行（副本写在 gitignore 的 `.tmp-gates/`，finally 里删）⇒ **一个都不补** —— 判据咬的是那一行代码，不是"什么都通过"',
      `源码真的被改过 = ${broken !== IME_SRC} · 删掉之后补了 ${Array.isArray(brokenGot) ? brokenGot.length : brokenGot} 个`,
    )

    /* ---- ⑦ 接线：`main.tsx` 里调在 `createRoot(` **之前**，且 import 自 `./lib/imeMirror` ---- */
    const MAIN = readApp('src/main.tsx')
    /* ⚠️ **注释先剥掉**：`main.tsx` 的说明注释里就写着"必须在 `createRoot(...)` 之前装" ——
       不剥的话 `indexOf('createRoot(')` 命中的是那句注释（本节第一版就这么红过一次，是真的红）。 */
    const MAIN_CODE = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const callAt = MAIN_CODE.indexOf('installImeMirror()')
    const rootAt = MAIN_CODE.indexOf('createRoot(')
    check(
      callAt >= 0 && rootAt > callAt,
      '🔴 A13 ⑦ `src/main.tsx` 里 `installImeMirror()` 调在 `createRoot(` **之前**（首次渲染之前就该生效）',
      `剥掉注释后：installImeMirror() @${callAt} · createRoot( @${rootAt}`,
    )
    check(
      /import\s*\{[^}]*\binstallImeMirror\b[^}]*\}\s*from\s*'\.\/lib\/imeMirror'/.test(MAIN),
      '🔴 A13 ⑧ 而且是从 `./lib/imeMirror` import 的（不是别处同名的一个函数）',
      short(MAIN.split('\n').find((l) => l.includes('imeMirror')) ?? '（没找到那一行）'),
    )
    /* 🧪 反向对照：同一套位置判据喂"调在 `createRoot(` 之后"的写法 → 当场假 */
    const late = `${MAIN_CODE.replace(/^installImeMirror\(\)$/m, '')}\ninstallImeMirror()\n`
    check(
      late !== MAIN_CODE && late.indexOf('createRoot(') < late.indexOf('installImeMirror()'),
      '🧪 A13 ⑦ 反向对照：把那句话挪到 `createRoot(` **之后**（只在文本里挪，不动真文件）⇒ ⑦ 的判据当场假（证明它看的是**顺序**，不是"这两个名字在不在"）',
      `真文件 ${callAt} < ${rootAt} · 挪到最后 ${late.indexOf('createRoot(')} < ${late.indexOf('installImeMirror()')}`,
    )

    /* ---- ⑨ 它**一个字节都不改 DOM**（不改 `value`，才不会自己制造出一次输入）---- */
    const code = IME_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check(
      !/\.value\s*=/.test(code) && /\.value\s*=/.test(`${code}\nel.value = 'x'\n`),
      '🔴 A13 ⑨ 镜像**不改 DOM**：剥掉注释后的代码里没有一处 `.value =`（+ 自证：塞一句进去则命中 —— 不是"什么都搜不到"）',
      `真源码命中 = ${/\.value\s*=/.test(code)} · 塞一句进去 = ${/\.value\s*=/.test(`${code}\nel.value = 'x'\n`)}`,
    )
  } finally {
    putBack()
  }
}

/* ============================================================
   第二十节之四 · 🆕 A16：「我的」页 2026-10-04 的三处取舍 —— **删除也是被钉住的**
   ------------------------------------------------------------
   用户当天对「我的」页提的三条（原话抄在 `Settings.tsx` 每一处的注释里）：
     ①「关于」：删掉「学段学科」「存储」两行，换成三颗下载按钮
        （教师端 安卓 / 教师端 Windows / 教室端 Windows，链接 = 面板里填的那两行）；
     ②「教室端」那张卡**整卡删掉**（教室端现在有自己的程序，1.1.2 起还有原生置顶小窗）；
     ③「备份与恢复」：2026-10-04 那一版是"只留「导出备份文件」与「从备份文件恢复」"，
        **2026-10-05 期望值又变了一次**（用户原话：「把用户可以下载备份文件的入口也取消了吧」）
        ⇒ 那两颗也撤，**整卡删掉**：老师端不再有下载 / 恢复备份的入口。
        删的只是**入口** —— `lib/backup.ts` 那一套能力与
        `components/BackupExtraActions.tsx`（超管面板那条路）**一个字都没删**。
   🔴 这一节钉的是**源码这一侧**（"删掉了"本身就是判据）；屏上那一侧（真 DOM 上的
      文案与 href、以及"面板没填就不出现"）在 `shots.mjs`。
   ⚠️ 一律**先剥注释**再判：这三处的中文在注释里**正当地**出现（写着"为什么删"），
      不剥的话"代码里没有这句话"会被注释骗过 ⇒ 判据恒绿（§三.2 那一类）。
   ⚠️ 每条都带一条**就地改坏**的反向对照（在内存里的源码副本上做，不动磁盘）。
   ============================================================ */

section('第二十节之四 · A16：「我的」页三处取舍（删除也是被钉住的）')

{
  /** 剥注释（行尾 `//` 与块注释）—— 判据只许看**真代码** */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const SET = strip(readApp('src/pages/Settings.tsx'))
  const EXTRA = strip(readApp('src/components/BackupExtraActions.tsx'))

  /* ---------------- ① 「关于」：两行删了、三颗按钮接上了 ---------------- */
  const aboutOk = (s) =>
    !s.includes('学段学科') &&
    !s.includes('k="存储"') &&
    !s.includes('connectionMode') &&
    s.includes('releaseDownloads(useReleaseSlots())') &&
    s.includes('data-download-slot={d.key}')
  check(
    aboutOk(SET),
    '🔴 A16 ①「关于」：`学段学科` / `存储` 两行**都删了**，而三颗下载按钮接的是 `releaseDownloads(useReleaseSlots())`（同一个纯函数 · 同一份取数）',
    `学段学科=${SET.includes('学段学科')} · 存储行=${SET.includes('k="存储"')} · connectionMode=${SET.includes('connectionMode')} · 下载接线=${SET.includes('releaseDownloads(useReleaseSlots())')}`,
    '反向对照：下面那条（把「学段学科」那一行塞回副本 ⇒ 本条当场假）',
  )
  const setBackRow = SET.replace(
    '            <KV k="版本"',
    '            <KV k="学段学科" v="高中 · 物理" />\n            <KV k="版本"',
  )
  check(
    setBackRow !== SET && !aboutOk(setBackRow),
    '🧪 A16 ① 反向对照：把「学段学科」那一行塞回**副本**（不动磁盘）⇒ 同一条判据当场假',
    `副本真被改过=${setBackRow !== SET} · 塞回去之后判据=${aboutOk(setBackRow)}`,
  )

  /* ---------------- ② 「教室端」整卡 ---------------- */
  const roomOk = (s) =>
    !s.includes('<Sect>教室端</Sect>') &&
    !s.includes('在新标签页打开教室端') &&
    !s.includes('已复制教室端地址') &&
    !s.includes("window.open('/classroom'")
  check(
    roomOk(SET),
    '🔴 A16 ②「教室端」那张卡**整卡删了**：没有小标题 · 没有「复制」· 没有「在新标签页打开教室端」· 也没有 `window.open(\'/classroom\')`',
    `小标题=${SET.includes('<Sect>教室端</Sect>')} · 新标签页=${SET.includes('在新标签页打开教室端')} · 已复制=${SET.includes('已复制教室端地址')} · window.open=${SET.includes("window.open('/classroom'")}`,
  )
  const roomBack = SET.replace(
    '        <div className="mb-4">\n          <Sect>关于</Sect>',
    '        <div className="mb-4">\n          <Sect>教室端</Sect>\n        </div>\n        <div className="mb-4">\n          <Sect>关于</Sect>',
  )
  check(
    roomBack !== SET && !roomOk(roomBack),
    '🧪 A16 ② 反向对照：把「教室端」那张卡的小标题塞回副本 ⇒ 同一条判据当场假（这张卡真的被钉着，不是"文件里恰好没有"）',
    `副本真被改过=${roomBack !== SET} · 塞回去之后判据=${roomOk(roomBack)}`,
  )

  /* ---------------- ③ 「备份与恢复」**整卡撤下**（期望值 2026-10-05 变了） ----------------
   * 🔴 **为什么期望值变了**：2026-10-04 那一版判的是"只留第一、第四颗"（加密档案导出 /
   *    备份到云端从这一屏撤下）。2026-10-05 用户要求「把用户可以下载备份文件的入口也取消了吧」
   *    ⇒ 连**导出 / 恢复**那两颗也撤 —— 撤完那张卡里只剩一个 hidden file input（空壳）
   *    ⇒ 按文案纪律**整卡删掉**（含小标题）。
   *    ⚠️ 所以这一条从"必须包含这两颗"翻成"**一颗都不许在**" —— 是**期望值**变了，
   *       不是判据被放宽：原来那五条"不许在"的（`导出档案备份（加密）` / `data-backup-seal` /
   *       `data-backup-notify` / `notifyBackupDone` / `云端是主副本`）照旧逐条钉着，
   *       而且**新增**了三条（小标题 / 只为恢复服务的 `bkRef` / `restoreBackup` 调用点）。
   * ⚠️ 仍然只判**入口**：实现与终态接线在 `components/BackupExtraActions.tsx`，
   *    由下面 ③附 照旧钉着（那一条一个字没动）。
   */
  const bkOk = (s) =>
    !s.includes('导出备份文件') &&
    !s.includes('从备份文件恢复') &&
    !s.includes('<Sect>备份与恢复</Sect>') &&
    !s.includes('导出档案备份（加密）') &&
    !s.includes('data-backup-seal') &&
    !s.includes('data-backup-notify') &&
    !s.includes('notifyBackupDone') &&
    !s.includes('云端是主副本') &&
    !s.includes('bkRef') &&
    !s.includes('restoreBackup')
  check(
    bkOk(SET),
    '🔴 A16 ③「备份与恢复」**整卡撤下**（用户 2026-10-05 要求取消下载备份的入口）：源码里没有那两颗粒按钮 · 没有小标题 · 也没有只为恢复服务的 file input（`bkRef`）与 `restoreBackup` 调用点 —— 老师端不再有下载 / 从备份恢复的入口',
    `导出=${SET.includes('导出备份文件')} · 恢复=${SET.includes('从备份文件恢复')} · 小标题=${SET.includes('<Sect>备份与恢复</Sect>')} · 加密那颗=${SET.includes('data-backup-seal')} · 云端那颗=${SET.includes('data-backup-notify')} · 说明段=${SET.includes('云端是主副本')} · bkRef=${SET.includes('bkRef')} · restoreBackup=${SET.includes('restoreBackup')}`,
  )
  /* 🧪 反向对照：把**整张卡**塞回副本 ⇒ 同一条判据当场假。
     🔴 锚点 2026-10-05 换了：旧锚点 `'                从备份文件恢复'` **就是这次被删掉的那一行**，
        不改的话副本根本改不动（命中 0 处）⇒ 对照会变成"假绿"（§三.2 那一类）。
        新锚点用「关于」那张卡的开头（与 ② 用同一个锚，它是源码里唯一一处）。
     🔴 先数出现次数、**恰好 1 处**才替换：`String.replace` 只换第一处，宁可报错也不假绿。 */
  const CARD_ANCHOR = '        <div className="mb-4">\n          <Sect>关于</Sect>'
  const anchorHits = SET.split(CARD_ANCHOR).length - 1
  const bkBack =
    anchorHits === 1
      ? SET.replace(
          CARD_ANCHOR,
          '        <div className="mb-4">\n          <Sect>备份与恢复</Sect>\n          <Panel bodyClass="p-3">\n            <Button block>导出备份文件</Button>\n            <Button block>从备份文件恢复</Button>\n          </Panel>\n        </div>\n' +
            CARD_ANCHOR,
        )
      : SET
  check(
    anchorHits === 1 && bkBack !== SET && !bkOk(bkBack),
    '🧪 A16 ③ 反向对照：把那张卡（含导出 / 恢复两颗）塞回副本 ⇒ 同一条判据当场假（"整卡撤下了"真的被判，不是文件里恰好没有）',
    `锚点出现 ${anchorHits} 处（须恰好 1）· 副本真被改过=${bkBack !== SET} · 塞回去之后判据=${bkOk(bkBack)}`,
  )

  /* ---- ③附：撤下的那两颗**实现没跟着丢**（用户口径：只把入口从这一屏去掉） ---- */
  const keepsSubstance = (s) =>
    s.includes('data-backup-seal') &&
    s.includes('data-backup-notify') &&
    /set[A-Za-z]+\(res\.ok\s*\?\s*'done'\s*:\s*'failed'\)/.test(s) &&
    s.includes('sealForAdmin') &&
    s.includes('notifyBackupDone')
  check(
    keepsSubstance(EXTRA),
    '🔴 A16 ③附：撤下的那两颗的**实现与终态接线都还在**（`components/BackupExtraActions.tsx`）—— 用户口径是"只把入口从这一屏去掉"，不是删实现（超管面板那一路直接摆它，别写第二份）',
    `seal=${EXTRA.includes('data-backup-seal')} · notify=${EXTRA.includes('data-backup-notify')} · res.ok 三目=${/set[A-Za-z]+\(res\.ok\s*\?\s*'done'\s*:\s*'failed'\)/.test(EXTRA)}`,
  )
  const extraGutted = EXTRA.replace("setBackupMark(res.ok ? 'done' : 'failed')", "setBackupMark('done')")
  check(
    extraGutted !== EXTRA && !keepsSubstance(extraGutted),
    '🧪 A16 ③附 反向对照：把那一句改回"忙完就当成功"（副本）⇒ 终态判据当场假',
    `副本真被改过=${extraGutted !== EXTRA} · 改坏之后判据=${keepsSubstance(extraGutted)}`,
  )
}

/* ============================================================
   第二十一节 · A14：壳声明 ↔ 网页判据（置顶小窗 / 声音）—— 2026-10-04
   ------------------------------------------------------------
   用户报的第 ④ 条原话：「**不支持置顶小窗，为什么还要点一下解锁声音**」（教室端 exe）。
   已量到的事实（真壳 · Electron 33 / Chromium 130 · `app://` 是安全上下文）：
     · `typeof window.documentPictureInPicture === 'object'` —— **API 对象在**，
       所以"有没有这个 API"那条老判据在壳里**永远是"支持"**；
     · 真手势（click 里调、那一刻 `userActivation.isActive === true`）与
       CDP `userGesture:true` **两条路都抛同一句**
       `InvalidStateError: … requestWindow … Internal error: no window`
       ⇒ **Electron 没实现"创建那个 PiP 窗口"那一层**；
     · 而"点一下解锁声音"那一步在壳里**本来就是多余的**（默认 `autoplayPolicy` 免手势）。
   ⇒ 修法是**让壳自己声明**（`_src/desktop/preload.js` 塞 `autoplayAllowed: true` /
     `documentPip: false`），网页只认**严格值**（`=== true` / `=== false`）。
     这一节钉的就是这条接口契约 + 它在页面上的两个落点。

   ⚠️ 分两半：**A 半**（①–④）import 真模块（`classroomShell.ts` / `pip.ts`），
     用假 `window` 打**行为**；**B 半**（⑤–⑧）读 `Classroom.tsx` 源码，
     钉"按端分支的**位置**"（不是"这两句话在不在"）。
   ⚠️ 每条都带反向对照；B 半一律**先剥注释** —— 那些句子的原文在注释里也出现过
     （`startPip` 上面那段说明就引了「需要 Edge / Chrome 116 及以上」），
     不剥的话"代码里那一句被删掉"照样能命中注释里的那一份 ⇒ 判据恒绿（§三.2）。
   ============================================================ */

section('第二十一节 · A14：壳声明 ↔ 网页判据（置顶小窗 / 声音 —— 用户报的第 ④ 条）')

{
  /* ---------------- A 半：纯函数 / 行为（假 `window`，用完还回去） ---------------- */

  const { shellAutoplayAllowed, shellDocumentPipUnavailable } = await import('../src/lib/classroomShell.ts')
  const pip = await import('../src/lib/pip.ts')

  const SAVED_G = new Map()
  const putG = (k, v) => {
    if (!SAVED_G.has(k)) SAVED_G.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    if (v === undefined) delete globalThis[k]
    else globalThis[k] = v
  }
  const putBackG = () => {
    for (const [k, d] of SAVED_G) {
      if (d) Object.defineProperty(globalThis, k, d)
      else delete globalThis[k]
    }
    SAVED_G.clear()
  }
  /**
   * 装一个假页面：`shell` 给 `window.__shell_out` 的内容（**`null` = 网页版：压根没这个对象**），
   * `dpip` 给 `window.documentPictureInPicture`（`undefined` = 这个浏览器没有这个 API）。
   * ⚠️ 每个用例**之前**都重新装一次：不装的话上一条的假 `window` 会漏到下一条（互相污染）。
   */
  const page = (shell, dpip) => {
    const w = {}
    if (shell !== null) w.__shell_out = shell
    if (dpip !== undefined) w.documentPictureInPicture = dpip
    putG('window', w)
    return w
  }

  try {
    /* ---- ① `shellAutoplayAllowed()`：**只认严格 `=== true`** ---- */
    for (const [shell, want, why] of [
      [{ autoplayAllowed: true }, true, '壳声明 true'],
      [{ autoplayAllowed: false }, false, '壳声明 false'],
      [{}, false, '老壳：没有这个字段'],
      [null, false, '网页版：压根没有 `__shell_out`'],
      [{ autoplayAllowed: 'true' }, false, '只认严格 boolean —— 字符串 "true" 不算'],
    ]) {
      page(shell, undefined)
      const got = shellAutoplayAllowed()
      check(got === want, `🔴 A14 ① \`shellAutoplayAllowed()\` = ${want}（${why}）`, `得到 ${got}`, `期望 ${want}`)
    }

    /* ---- ② `shellDocumentPipUnavailable()`：**只认严格 `=== false`** ---- */
    for (const [shell, want, why] of [
      [{ documentPip: false }, true, '壳显式声明开不了'],
      [{ documentPip: true }, false, '壳说能开 ⇒ 不推翻原判断'],
      [{}, false, '老壳：没有这个字段 ⇒ 不推翻原判断'],
      [null, false, '网页版：压根没有 `__shell_out`'],
      [{ documentPip: 0 }, false, '只认严格 `=== false` —— `0` / `"false"` 都不算'],
    ]) {
      page(shell, undefined)
      const got = shellDocumentPipUnavailable()
      check(got === want, `🔴 A14 ② \`shellDocumentPipUnavailable()\` = ${want}（${why}）`, `得到 ${got}`, `期望 ${want}`)
    }

    /* ---- ③ `pipSupported()`：壳说开不了时**哪怕 API 对象在**也必须判"不支持" ---- */
    for (const [shell, dpip, want, why] of [
      [{ documentPip: false }, {}, false, '壳说 documentPip=false ⇒ **API 对象在也不支持**（这是用户报的那一条的判据）'],
      [{}, {}, true, '壳没说（老壳）+ API 在 ⇒ 照旧支持'],
      [null, {}, true, '网页版 + API 在 ⇒ 支持（网页版行为一字不变）'],
      [null, undefined, false, '网页版 + 没有这个 API ⇒ 不支持'],
    ]) {
      page(shell, dpip)
      const got = pip.pipSupported()
      check(got === want, `🔴 A14 ③ \`pipSupported()\` = ${want}（${why}）`, `得到 ${got}`, `期望 ${want}`)
    }

    /* ---- ④ `openPip()`：壳声明不支持时**连试都不试**；API 在但抛 ⇒ `failed`（不是 no-api） ---- */
    let calls = 0
    page({ documentPip: false }, { requestWindow: async () => { calls++; return null } })
    const r1 = await pip.openPip()
    check(
      r1.ok === false && r1.why === 'no-api' && calls === 0,
      '🔴 A14 ④ 壳声明 `documentPip:false` ⇒ `openPip()` 直接回 `{ok:false, why:\'no-api\'}`，而且 `requestWindow` **一次都没被调用**（试了就是一屏"没打开"的红字，老师白按一次）',
      `why=${r1.why} · requestWindow 调用 ${calls} 次`,
      '期望 why=no-api 且调用 0 次',
    )
    calls = 0
    const boom = new Error('Internal error: no window')
    boom.name = 'InvalidStateError'
    page(null, { requestWindow: async () => { calls++; throw boom } })
    const r2 = await pip.openPip()
    check(
      r2.ok === false && r2.why === 'failed' && String(r2.message).includes('InvalidStateError') && calls === 1,
      '🔴 A14 ④ `requestWindow` 抛 `InvalidStateError` ⇒ `{ok:false, why:\'failed\'}`，`message` 里带着 `InvalidStateError`（**不是**笼统的 no-api）—— 这两档在屏上是两句不同的话',
      `why=${r2.why} · message=${short(r2.message)} · requestWindow 调用 ${calls} 次`,
      '期望 why=failed 且 message 含 InvalidStateError',
    )
    /* 🧪 自证：同一套假环境也能跑出**成功**那一支 —— 否则上面两条可能只是"恒假" */
    putG('document', { querySelectorAll: () => [], createElement: () => ({ textContent: '' }) })
    page(null, {
      requestWindow: async () => ({
        /* 小窗那一份 document：`copyStyles()` 会在它上面 createElement + 往 head 里塞 */
        document: { createElement: () => ({ textContent: '' }), head: { appendChild() {} } },
      }),
    })
    const r3 = await pip.openPip()
    check(
      r3.ok === true,
      '🧪 A14 ④ 自证：`requestWindow` 正常返回时同一条路给出 `{ok:true, win}` —— 上面那两条不是"恒假"',
      `ok=${r3.ok}${r3.ok ? '' : ` · why=${r3.why} message=${short(r3.message)}`}`,
    )
  } finally {
    putBackG()
  }

  /* ---------------- B 半：源码断言 + 反向对照 ---------------- */

  const CLS_RAW = readApp('src/pages/Classroom.tsx')
  /*
   * ⚠️ **先剥注释**（照 A13 ⑦ 的写法：块注释 + **整行** `//`，只剥整行，免得把 `https://` 里的 `//` 切了）。
   *    理由见本节标题上面那条：这些句子的原文在注释里也有一份。
   */
  const CLS = CLS_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

  /** 取两个锚点**之间**的源码；锚点缺一个 ⇒ `null`（判据据此去红，而不是静默拿到空串） */
  const between = (s, a, b) => {
    const i = s.indexOf(a)
    if (i < 0) return null
    const j = s.indexOf(b, i + a.length)
    return j < 0 ? null : s.slice(i, j)
  }
  /**
   * 从一个三目条件处切开，得到「条件为真的那一支」与「其余」。
   * 按 `()` `[]` `{}` 的**配对深度**找 `?` 与配对的 `:`，所以分支里再嵌三目也不会切错；
   * JSX 文本里的全角括号 `（）`（例：「（需要 Edge / Chrome 116 及以上）」）不参与深度，正好。
   */
  const splitTernary = (s, at) => {
    let depth = 0
    let q = -1
    for (let i = at; i < s.length; i++) {
      const c = s[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      else if (c === '?' && depth === 0) { q = i; break }
    }
    if (q < 0) return null
    let d2 = 0
    for (let j = q + 1; j < s.length; j++) {
      const c = s[j]
      if (c === '(' || c === '[' || c === '{') d2++
      else if (c === ')' || c === ']' || c === '}') {
        if (d2 === 0) return null
        d2--
      } else if (c === ':' && d2 === 0) return { yes: s.slice(q + 1, j), no: s.slice(j + 1) }
    }
    return null
  }

  const EDGE = '需要 Edge / Chrome 116'
  const SHELL_ONLY = '这台机器上开不了'

  /* ---- ⑤ 按端分支：`shellPlatform() === 'electron'` 那一支说"这台机器上开不了"，
          非壳那一支才提浏览器版本 ---- */
  const bannerBranches = (s) => {
    const region = between(s, 'data-classroom-pip-unsupported', 'data-classroom-unlock')
    if (!region) return null
    const at = region.indexOf("shellPlatform() === 'electron'")
    if (at < 0) return null
    return splitTernary(region, at)
  }
  const bannerTextWiredRight = (s) => {
    const br = bannerBranches(s)
    return (
      !!br &&
      br.no.includes(EDGE) &&
      !br.yes.includes(EDGE) &&
      br.yes.includes(SHELL_ONLY) &&
      !br.no.includes(SHELL_ONLY)
    )
  }
  /*
   * 🧪 反向对照要用 `replaceAll`：这两句**各出现两处**（`startPip` 里一次、横幅里一次），
   *    只换第一处的话换到的是 `startPip` 那一份，横幅一个字都没动 ⇒ 对照自己失效。
   */
  const CLS_SWAPPED = CLS
    .replaceAll(SHELL_ONLY, '@@SHELL@@')
    .replaceAll(EDGE, SHELL_ONLY)
    .replaceAll('@@SHELL@@', EDGE)
  check(
    bannerTextWiredRight(CLS),
    "🔴 A14 ⑤ 小窗不可用那块横幅里：「需要 Edge / Chrome 116」**只在非壳那一支**，「这台机器上开不了」**只在 `shellPlatform() === 'electron'` 那一支** —— 分支方向没反（壳里说「浏览器太老」是假话）",
    `取到两支=${!!bannerBranches(CLS)} · 壳支含 116=${bannerBranches(CLS)?.yes.includes(EDGE)} · 网页支含 116=${bannerBranches(CLS)?.no.includes(EDGE)}`,
  )
  check(
    CLS_SWAPPED !== CLS && !bannerTextWiredRight(CLS_SWAPPED),
    '🧪 A14 ⑤ 反向对照：把那两支的句子**对调**（只在文本里换，不动真文件）⇒ 同一条判据当场判假（它看的是**所属分支**，不是"这两句在不在"）',
    `对调之后：壳支含 116=${bannerBranches(CLS_SWAPPED)?.yes.includes(EDGE)} · 网页支含 116=${bannerBranches(CLS_SWAPPED)?.no.includes(EDGE)}`,
  )

  /* ---- ⑥ `armed` 的初值：壳里跳过"先解锁声音"那一步 ---- */
  const ARMED_INIT = /const \[armed, setArmed\] = useState\(\(\) => shellAutoplayAllowed\(\)\)/
  const armedInitFromShell = (s) => ARMED_INIT.test(s)
  const CLS_ARMED_FALSE = CLS.replace('useState(() => shellAutoplayAllowed())', 'useState(false)')
  check(
    armedInitFromShell(CLS),
    '🔴 A14 ⑥ `armed` 的初值 = `useState(() => shellAutoplayAllowed())` —— 壳里**跳过**「先解锁声音」那一步（网页版它恒 false ⇒ 那一屏照旧）',
    short(CLS.split('\n').find((l) => l.includes('const [armed')) ?? '（没找到那一行）'),
  )
  check(
    CLS_ARMED_FALSE !== CLS && !armedInitFromShell(CLS_ARMED_FALSE),
    '🧪 A14 ⑥ 反向对照：把初值写回 `useState(false)`（改动前那一版）⇒ 同一条判据当场判假',
    `改回去之后还命中 = ${armedInitFromShell(CLS_ARMED_FALSE)}`,
  )

  /* ---- ⑦ 两个落点在（`shots` 与 `verify-exe` 都靠它们量屏） ---- */
  const hasRoomAttrs = (s) => /data-classroom-unlock\b/.test(s) && /data-classroom-pip-unsupported\b/.test(s)
  const CLS_RENAMED = CLS
    .replaceAll('data-classroom-unlock', 'data-room-unlock')
    .replaceAll('data-classroom-pip-unsupported', 'data-room-pip-unsupported')
  check(
    hasRoomAttrs(CLS),
    '🔴 A14 ⑦ 两个落点都在：`data-classroom-unlock`（网页版那一步照旧）与 `data-classroom-pip-unsupported`（壳里提前按"开不了"处理）—— 门禁就是靠这两个属性量屏',
    `unlock=${/data-classroom-unlock\b/.test(CLS)} · pip-unsupported=${/data-classroom-pip-unsupported\b/.test(CLS)}`,
  )
  check(
    CLS_RENAMED !== CLS && !hasRoomAttrs(CLS_RENAMED),
    '🧪 A14 ⑦ 反向对照：把两个属性**改名**（`data-classroom-*` → `data-room-*`）⇒ 同一条判据当场判假',
    `改名之后 unlock=${/data-classroom-unlock\b/.test(CLS_RENAMED)} · pip-unsupported=${/data-classroom-pip-unsupported\b/.test(CLS_RENAMED)}`,
  )

  /* ---- ⑧ `startPip` 里**不再**无条件推「需要 Edge / Chrome 116 及以上版本」 ---- */
  const startPipBody = between(CLS, 'const startPip = async () => {', 'const nameOf = useCallback(')
  /**
   * 那一段里每一处 `desc:`：**凡是带着那句 116 的**，都必须挂在按端三目里
   * （`?` 之前出现端判据 `inShell` / `shellPlatform()`）。不带那句的不管。
   * 还要自证"真的读到东西了"（`seen > 0 && withEdge > 0`）——
   * 两样都是 0 时返回 false，`startPip` 被改名/被删会当场红，而不是"什么都搜不到也算过"。
   */
  const descNeverUnconditional = (body) => {
    if (!body) return false
    let seen = 0
    let withEdge = 0
    for (const line of body.split('\n')) {
      const i = line.indexOf('desc:')
      if (i < 0) continue
      seen++
      if (!line.includes(EDGE)) continue
      withEdge++
      const head = line.slice(i, line.indexOf(EDGE))
      if (!(head.includes('?') && /inShell|shellPlatform\(\)/.test(head))) return false
    }
    return seen > 0 && withEdge > 0
  }
  const START_PIP_UNCONDITIONAL = (startPipBody ?? '').replace(
    "desc: '再点一次；还不行就用手机或平板看题号与正确率'",
    "desc: '需要 Edge / Chrome 116 及以上版本'",
  )
  check(
    descNeverUnconditional(startPipBody),
    "🔴 A14 ⑧ `startPip` 里**每一处**带「需要 Edge / Chrome 116」的 `desc:` 都在**按端三目**里（壳那一支说的是「用手机/平板」）—— 不再把「浏览器版本」那句无条件甩给老师",
    startPipBody
      ? `那一段 ${startPipBody.split('\n').filter((l) => l.includes('desc:')).length} 处 \`desc:\`，带 116 的都在三目里`
      : '取不到 `startPip` 那一段（锚点不见了）',
  )
  check(
    !!startPipBody && START_PIP_UNCONDITIONAL !== startPipBody && !descNeverUnconditional(START_PIP_UNCONDITIONAL),
    "🧪 A14 ⑧ 反向对照：在 `startPip` 里塞一处**无条件**的 `desc: '需要 Edge / Chrome 116 及以上版本'` ⇒ 同一条判据当场判假",
    `塞进去之后：判据=${descNeverUnconditional(START_PIP_UNCONDITIONAL)}`,
  )
}

/* ============================================================
   第二十二节 · A15：教室端**原生**置顶小窗（壳原生 → Document PiP → no-api）—— 2026-10-04
   ------------------------------------------------------------
   施工单 `施工单-教室端原生置顶小窗.md`。已量到的事实（真壳 · Electron 33 / Chromium 130）：
     · `typeof window.documentPictureInPicture === 'object'` —— **API 对象在**；
     · `requestWindow()` 真手势与 CDP `userGesture:true` **两条路都抛**
       `InvalidStateError: … Internal error: no window`
       ⇒ **Electron 没实现"创建那个 PiP 窗口"那一层**（那是 Chrome 浏览器层做的）。
   ⇒ 两个 exe 改走**壳自己的** `BrowserWindow({ alwaysOnTop: true })`（`preload` 的
     `__shell_out.pip`），而**网页版照旧走 Document PiP**（那条路在浏览器里是真的能用，
     不许因为这次改动把它改掉）。

   这一节钉三样，**每一样都配一条真能红的反向对照**（副本写在 gitignore 的 `.tmp-gates/`，
   `finally` 里删 —— 照 A13 ⑥ 的写法；改的是副本，仓库里的真文件一个字节都不动）：
     ① `shellPipAvailable()` 的**严格取值**（`pip` 在且是**对象**才算）+ 壳优先的 `pipSupported()`；
     ② `openPip()` 的**分支顺序**：壳那条路在时 `requestWindow` **一次都不许被调用**
        （试了就是一屏"没打开"的红字，老师白按一次）；没有壳时走的还是 Document PiP 那条老路；
        壳侧没建出窗口是 `failed`、两条都没有才是 `no-api`（两档在屏上是两句不同的话）；
     ③ `Classroom.tsx` 里"**题号一变就推数据**"那一处的**存在性 / 字段 / 位置**：
        推的那一屏必须有那五个字段（班级 / 题号 / 正确率 / 未交人数）+ 🆕 `questions`
        （题号条与每一题的名单），依赖数组里必须有 `seq`，而且那个 effect **必须在 `const cur = …` 之后**
        （依赖数组是在渲染期求值的，放前面会撞 TDZ ⇒ **整页崩**，不是静默）。
     ④ 🆕 **壳小窗那一屏本身**（2026-10-05，施工单 §一「与网页里那个小窗**同一份信息**」）：
        壳源码里那个 `pipHtml` 抠出来**真跑一遍**，断言那一屏里有**题号条**（每题一格、各自正确率、
        分档着色）、**◀ ▶ 与方向键**、**名单容器**（号码 + 姓名 + 几人错）、**深色渐变配色**，
        以及班级 / 题号 / 正确率 / 未交人数四样；并比着 `index.css` 暗色块钉住那份分档色。
        ⚠️ **期望值 2026-10-05 变了**：原来这一屏是从零写的，比网页版 `PipPanel` 少了三样、配色也换了
        —— 这一轮按用户批准的方案①补回来，所以判据从"有那四个字段"变成"与网页同一份信息"。

   ⚠️ **真壳那一半**（窗口数 1→2 / 新窗口 `isAlwaysOnTop()` / 小窗里没有 preload /
      教师端 `pip === undefined` 那条反向）只能在**出包之后**由 `_tools/verify-exe.mjs` 量；
      本节量的是"网页这一半 + 壳那份 HTML"，三条合起来才是完整的一条链。
   ============================================================ */
section('第二十二节 · A15：教室端原生置顶小窗（壳原生 → Document PiP → no-api）')

{
  const { shellPipAvailable } = await import('../src/lib/classroomShell.ts')
  const pip = await import('../src/lib/pip.ts')

  /* 假 `window` 用完**还回去**（这一节之后还得在干净的 Node 环境里跑）—— 照 A14 的写法 */
  const SAVED_G = new Map()
  const putG = (k, v) => {
    if (!SAVED_G.has(k)) SAVED_G.set(k, Object.getOwnPropertyDescriptor(globalThis, k))
    if (v === undefined) delete globalThis[k]
    else globalThis[k] = v
  }
  const putBackG = () => {
    for (const [k, d] of SAVED_G) {
      if (d) Object.defineProperty(globalThis, k, d)
      else delete globalThis[k]
    }
    SAVED_G.clear()
  }
  /** 装一个假页面：`shell = null` ⇒ **网页版**（压根没有 `__shell_out`）；`dpip = undefined` ⇒ 没有那个 API */
  const page = (shell, dpip) => {
    const w = {}
    if (shell !== null) w.__shell_out = shell
    if (dpip !== undefined) w.documentPictureInPicture = dpip
    putG('window', w)
    return w
  }
  /** 壳摆出来的完整四个口（`preload.js` 的 `shellOut.pip`）—— `open` 照真壳回 `{ok:true}` */
  const FULL = { open: async () => ({ ok: true, reused: false }), data() {}, close() {}, onPipClosed() {} }

  const TMP_LOOSE = join(APP, '.tmp-gates', `classroomShell-loose-${process.pid}.ts`)
  const TMP_PIP = join(APP, '.tmp-gates', `pip-shellsecond-${process.pid}.ts`)
  const TMP_CLS = join(APP, '.tmp-gates', `Classroom-pip-${process.pid}.tsx`)

  try {
    /* ---- ① `shellPipAvailable()`：**只认"pip 在且是对象"**（两个方向都钉） ---- */
    for (const [shell, want, why] of [
      [{ pip: FULL }, true, '教室端 exe：四个口都摆出来了'],
      [{ pip: {} }, true, '只要 `pip` 是**对象**就算"有这条路"（四个口能不能用由 ② 的行为断言管）'],
      [{ pip: undefined }, false, '字段在但值是 undefined（老壳/写坏了）—— 不算'],
      [{ pip: null }, false, '`null` 不是对象'],
      [{ pip: 'open' }, false, '只认对象 —— **字符串不算**'],
      [{ pip: 0 }, false, '只认对象 —— **数字不算**'],
      [{}, false, '老壳 / 教师端 exe：压根没有这个字段（施工单 §二.1：教师端不摆入口）'],
      [null, false, '网页版：压根没有 `__shell_out`'],
    ]) {
      page(shell, undefined)
      const got = shellPipAvailable()
      check(got === want, `🔴 A15 ① \`shellPipAvailable()\` = ${want}（${why}）`, `得到 ${got}`, `期望 ${want}`)
    }

    /*
     * 🧪 ① 的反向对照：**把严格取值改宽**（`return p ?? null` = "字段在就算"）就写成
     *    `.tmp-gates/` 里的副本，再拿**同一条判据**去量它 —— 字符串与数字那两档必须当场红。
     */
    let loose = null
    try {
      const src = readApp('src/lib/classroomShell.ts')
      const broken = src.replace(
        "return typeof p === 'object' && p !== null ? p : null",
        'return p ?? null',
      )
      mkdirSync(dirname(TMP_LOOSE), { recursive: true })
      writeFileSync(TMP_LOOSE, broken)
      const mod = await import(pathToFileURL(TMP_LOOSE).href)
      const reds = [
        [{ pip: 'open' }, false],
        [{ pip: 0 }, false],
        [{ pip: FULL }, true],
      ].filter(([sh, want]) => {
        page(sh, undefined)
        return mod.shellPipAvailable() !== want
      })
      loose = { changed: broken !== src, reds: reds.length }
    } catch (e) {
      loose = { err: String(e?.message ?? e) }
    } finally {
      rmSync(TMP_LOOSE, { force: true })
    }
    check(
      loose?.changed === true && loose?.reds >= 2,
      '🧪 A15 ① 反向对照：把严格取值改宽成 `return p ?? null`（副本写在 gitignore 的 `.tmp-gates/`，finally 删）⇒ 同一条判据当场红 **2 档**（字符串 `"open"` / 数字 `0`）—— 证明上面那几条咬的是"是不是对象"，不是"字段在不在"',
      loose?.err ? `副本没跑起来：${loose.err}` : `副本真的被改过=${loose?.changed} · 判红的档数=${loose?.reds}`,
    )

    /* ---- ①′ `pipSupported()`：**壳优先**（教室端 exe 两个字段同时为真） ---- */
    for (const [shell, dpip, want, why] of [
      [
        { pip: FULL, documentPip: false },
        {},
        true,
        '教室端 exe：`pip` 在 **而** `documentPip: false`（网页那条路是死的）⇒ 先判壳 ⇒ **支持**（先判 documentPip 就永远判不出原生小窗）',
      ],
      [
        { documentPip: false },
        {},
        false,
        '教师端 exe / 老壳：没有原生小窗 + 壳说网页那条路也不行 ⇒ 不支持（屏上那句"这台机器上开不了"在那儿是**真话**）',
      ],
      [null, {}, true, '网页版 + API 在 ⇒ 支持（**网页版行为一字不变**）'],
      [null, undefined, false, '网页版 + 没有这个 API ⇒ 不支持'],
    ]) {
      page(shell, dpip)
      const got = pip.pipSupported()
      check(got === want, `🔴 A15 ①′ \`pipSupported()\` = ${want}（${why}）`, `得到 ${got}`, `期望 ${want}`)
    }

    /* ---- ② `openPip()` 的分支顺序：**壳 → Document PiP → no-api** ---- */
    let calls = 0
    page({ pip: FULL }, { requestWindow: async () => { calls++; throw new Error('这一步不该走到这儿') } })
    const s1 = await pip.openPip()
    check(
      s1.ok === true && s1.native === true && s1.win === null && calls === 0,
      '🔴 A15 ② 壳有原生小窗 ⇒ 走**壳那条路**（`{ok:true, native:true, win:null}`），而且 `requestWindow` **一次都没被调用**（它是死的；试了就是一屏"没打开"的红字，老师白按一次）',
      `ok=${s1.ok}${s1.ok ? ` · native=${s1.native} · win=${String(s1.win)}` : ` · why=${s1.why}`} · requestWindow 调用 ${calls} 次`,
      '期望 native=true、win=null 且调用 0 次',
    )

    /* 没有壳（网页版）⇒ **还是那条老路**，而且 `win` 就是 `requestWindow` 回来的那个窗口 */
    calls = 0
    putG('document', { querySelectorAll: () => [], createElement: () => ({ textContent: '' }) })
    const fakeWin = { document: { createElement: () => ({ textContent: '' }), head: { appendChild() {} } } }
    page(null, { requestWindow: async () => { calls++; return fakeWin } })
    const s2 = await pip.openPip()
    check(
      s2.ok === true && s2.native === false && s2.win === fakeWin && calls === 1,
      '🔴 A15 ② **没有壳时（网页版）走的还是 Document PiP 那条老路**：`native:false`、`win` 就是 `requestWindow` 回来的那个窗口（这条路一个字都没被改掉）',
      `ok=${s2.ok}${s2.ok ? ` · native=${s2.native} · win 是那个窗口=${s2.win === fakeWin}` : ` · why=${s2.why}`} · requestWindow 调用 ${calls} 次`,
    )

    /* 壳里有原生小窗，可**壳侧没建出来** ⇒ `failed`（不是 `no-api`） */
    calls = 0
    page({ pip: { open: async () => ({ ok: false, why: '建窗口失败' }) } }, { requestWindow: async () => { calls++; return fakeWin } })
    const s3 = await pip.openPip()
    check(
      s3.ok === false && s3.why === 'failed' && calls === 0,
      "🔴 A15 ② 壳侧没建出小窗（`pip.open` 回 `ok:false`）⇒ `{ok:false, why:'failed'}`（**不是** `no-api` —— 这两档在屏上是两句不同的话）",
      `why=${s3.why} · message=${short(s3.message)} · requestWindow 调用 ${calls} 次`,
      '期望 why=failed 且不去碰 Document PiP',
    )

    /* 两条都没有 ⇒ `no-api`（三态里的第一态） */
    page({}, undefined)
    const s4 = await pip.openPip()
    check(
      s4.ok === false && s4.why === 'no-api',
      "🔴 A15 ② 壳没有原生小窗、浏览器也没有那个 API ⇒ `{ok:false, why:'no-api'}`（老浏览器 / 教师端 exe 那一支）",
      `why=${s4.why} · message=${short(s4.message)}`,
    )

    /*
     * 🧪 ② 的反向对照：把 `openPip()` 里**壳那条分支拿掉**（`if (shellPipAvailable())` → `if (false)`），
     *    写成 `.tmp-gates/` 里的副本（顺便把 `./classroomShell` 的 import 指回真文件）——
     *    同一个假环境（壳有 `pip`、而 `requestWindow` 会抛）必须变成 `failed` 且**真的去调了** `requestWindow`。
     */
    let brokenPip = null
    try {
      const src = readApp('src/lib/pip.ts')
      /*
       * ⚠️ **`replaceAll`**：`from './classroomShell'` 在 pip.ts 里出现**两处**
       *    （顶上那个 import 块 + 末尾的 `export { … } from`）。只换第一处的话，
       *    副本里剩下的那一处会被解析成 `.tmp-gates/classroomShell` ⇒ **副本根本跑不起来**
       *    （2026-10-04 本节第一版就这么红的：反向对照变成"副本没跑起来"，那不是对照成功）。
       */
      const broken = src
        .replaceAll("from './classroomShell'", "from '../src/lib/classroomShell'")
        .replace('if (shellPipAvailable()) {', 'if (false) { /* 反向对照：壳那条路被拿掉 */')
      mkdirSync(dirname(TMP_PIP), { recursive: true })
      writeFileSync(TMP_PIP, broken)
      const mod = await import(pathToFileURL(TMP_PIP).href)
      calls = 0
      page({ pip: FULL }, { requestWindow: async () => { calls++; throw new Error('不该走到这儿') } })
      const b = await mod.openPip()
      brokenPip = { changed: broken !== src, ok: b.ok, why: b.ok ? '' : b.why, calls }
    } catch (e) {
      brokenPip = { err: String(e?.message ?? e) }
    } finally {
      rmSync(TMP_PIP, { force: true })
    }
    check(
      brokenPip?.changed === true && brokenPip?.ok === false && brokenPip?.calls === 1,
      '🧪 A15 ② 反向对照：把 `openPip()` 里壳那条分支拿掉（`.tmp-gates/` 副本，finally 删）⇒ 同一个假环境当场变成 `failed`，而且 `requestWindow` **被调了一次** —— 证明 ② 那条"一次都没被调用"不是恒真',
      brokenPip?.err
        ? `副本没跑起来：${brokenPip.err}`
        : `副本真的被改过=${brokenPip?.changed} · ok=${brokenPip?.ok} · why=${brokenPip?.why} · requestWindow 调用 ${brokenPip?.calls} 次`,
    )

    /* ---- ③ `Classroom.tsx`：「题号一变就推数据」那一处 ---- */
    const CLS_RAW = readApp('src/pages/Classroom.tsx')
    /**
     * 取「那一处推数据」：`pushPipScreen(` 往前最近的一个 `useEffect(`，
     * 往后到配对的那个依赖数组 `],`。三样都取不到就返回 `null`（判据据此去红，
     * 而不是静默拿到空串 —— A14 的 `between()` 同规矩）。
     */
    const pushEffect = (s) => {
      const i = s.indexOf('pushPipScreen(')
      if (i < 0) return null
      const at = s.lastIndexOf('useEffect(', i)
      if (at < 0) return null
      const depsAt = s.indexOf('}, [', i)
      if (depsAt < 0) return null
      const end = s.indexOf('])', depsAt)
      if (end < 0) return null
      return { at, i, end, head: s.slice(at, i), payload: s.slice(i, depsAt), deps: s.slice(depsAt + 4, end) }
    }
    /**
     * 那一屏的字段（**一个字段一种语义**，施工单 §二.3）。
     * 🆕 2026-10-05：加 `questions`（题号条 + 每一题的名单）—— 施工单 §一「与网页里那个小窗
     *    同一份信息」；壳那边没有回话的口子，翻到哪一题就得有哪一题的名单（见 A15 ④）。
     */
    const PIP_KEYS = ['className', 'seq', 'total', 'ratePct', 'missing', 'questions']
    /**
     * 依赖：`pipNative`（只在小窗开着时推）+ 会变的那些量：题号 / 当前那一题 / 未交人数 /
     * **整份题目数组**（题号条与名单都出自它）/ `nameOf`（名单里的姓名）。
     * ⚠️ **期望值 2026-10-05 变了**：原来写的是 `stats?.questions.length` —— 而题号条与名单
     *    要的是**每一项**（长度变了内容也可能变），所以钉 `stats?.questions` 本身 + `nameOf`。
     */
    const PIP_DEP_KEYS = ['pipNative', 'seq', 'cur', 'collect?.missing', 'stats?.questions', 'nameOf']
    const pushWiredRight = (s) => {
      const e = pushEffect(s)
      return (
        !!e &&
        e.head.includes('!pipNative') &&
        PIP_KEYS.every((k) => e.payload.includes(`${k}:`)) &&
        PIP_DEP_KEYS.every((k) => e.deps.includes(k))
      )
    }
    const CUR_DECL = 'const cur = stats?.questions[seq - 1]'
    /** 位置：那个 effect 必须在 `const cur = …` **之后**（依赖数组是渲染期求值的 ⇒ 放前面撞 TDZ） */
    const pushAfterCur = (s) => {
      const e = pushEffect(s)
      const curAt = s.indexOf(CUR_DECL)
      return !!e && curAt >= 0 && curAt < e.i
    }

    check(
      pushWiredRight(CLS_RAW),
      '🔴 A15 ③ `Classroom.tsx` 里"**题号一变就推数据**"那一处在（`useEffect` + `if (!pipNative) return` + `pushPipScreen`），那一屏带着五个字段（班级 / 题号 / 正确率 / 未交人数 / 🆕 `questions` 题号条与每题名单），依赖里有 `seq`、`cur`、`collect?.missing`、`stats?.questions`、`nameOf`',
      `那一处=${!!pushEffect(CLS_RAW)} · 依赖=[${pushEffect(CLS_RAW)?.deps.trim() ?? '-'}]`,
    )
    check(
      pushAfterCur(CLS_RAW),
      '🔴 A15 ③ 而且那一处**在 `const cur = stats?.questions[seq - 1]` 之后** —— 依赖数组里的 `cur` 是渲染期求值的，放前面撞 TDZ 会**整页崩**（不是静默）',
      `cur @${CLS_RAW.indexOf(CUR_DECL)} · 推数据 @${pushEffect(CLS_RAW)?.i ?? -1}`,
    )

    /*
     * 🧪 ③ 的两条反向对照（两次就地改坏，都写成 `.tmp-gates/` 的副本、再从磁盘读回来喂同一条判据）：
     *    A. 依赖数组里**去掉 `seq`** ⇒ "题号一变就推"那条判据必须红；
     *    B. 把那一段 effect **挪到 `const cur` 之前** ⇒ 位置那条判据必须红（而 A 的判据仍绿，
     *       证明两条咬的不是同一件事）。
     */
    const moveBeforeCur = (s) => {
      const e = pushEffect(s)
      if (!e) return s
      const text = s.slice(e.at, e.end + 2)
      const rest = s.slice(0, e.at) + s.slice(e.end + 2)
      const k = rest.indexOf(CUR_DECL)
      if (k < 0) return rest
      return `${rest.slice(0, k)}${text}\n\n  ${rest.slice(k)}`
    }
    let clsBroken = null
    try {
      const noSeq = CLS_RAW.replace('[pipNative, klass?.name, seq, cur,', '[pipNative, klass?.name, cur,')
      const moved = moveBeforeCur(CLS_RAW)
      mkdirSync(dirname(TMP_CLS), { recursive: true })
      writeFileSync(TMP_CLS, noSeq)
      const back1 = readFileSync(TMP_CLS, 'utf8')
      writeFileSync(TMP_CLS, moved)
      const back2 = readFileSync(TMP_CLS, 'utf8')
      clsBroken = {
        aChanged: back1 !== CLS_RAW,
        aRed: !pushWiredRight(back1),
        bChanged: back2 !== CLS_RAW,
        bRed: !pushAfterCur(back2),
        bStillWired: pushWiredRight(back2),
      }
    } finally {
      rmSync(TMP_CLS, { force: true })
    }
    check(
      clsBroken?.aChanged === true && clsBroken?.aRed === true,
      '🧪 A15 ③ 反向对照 A：把依赖数组里的 `seq` 去掉（`.tmp-gates/` 副本，finally 删）⇒ "题号变了就推数据"那条判据当场红',
      `副本真的被改过=${clsBroken?.aChanged} · 判据红=${clsBroken?.aRed}`,
    )
    check(
      clsBroken?.bChanged === true && clsBroken?.bRed === true && clsBroken?.bStillWired === true,
      '🧪 A15 ③ 反向对照 B：把那一段 effect 挪到 `const cur` **之前**（会撞 TDZ）⇒ **位置**那条判据当场红，而字段/依赖那条仍绿（证明两条咬的不是同一件事）',
      `副本真的被改过=${clsBroken?.bChanged} · 位置判据红=${clsBroken?.bRed} · 字段依赖判据仍绿=${clsBroken?.bStillWired}`,
    )

    /* ============================================================
       ④ 🆕 壳小窗**那一屏本身** —— 与网页里那个小窗**同一份信息**（2026-10-05）
       ------------------------------------------------------------
       用户批准的方案①（施工单 `施工单-教室端原生置顶小窗.md:28`）：
         「显示内容（与现在网页里那个小窗同一份信息）：班级 · 当前题号 · 正确率 · 未交人数」。
       原来壳里那个 `pipHtml` 是从零写的 HTML 字符串，比网页版 `PipPanel.tsx` **少三样**
       （题号条 / 点题号展开的名单 / ◀ ▶ 与方向键）、配色也换了（纯色 vs 深色渐变）。
       这一轮补回来 —— 下面的判据钉的就是"补回来了、而且以后不许再丢"。

       ⚠️ 壳源码**不在本仓库**（隔壁打包工程，`_src/desktop/shell-ipc.mjs`；照 A21/A22 的先例）：
          探不到就**落灰**（CI 的干净检出必然没有它，不是"坏了"）。
       🔴 判据吃的是**真渲染出来的那一屏 HTML**：把 `escapeHtml` + `pipHtml` 那段源码从壳文件里
          抠出来，用 `new Function` 真跑一遍（不是拿正则去猜源码）。反向对照因此是真的：
          在**内存副本**里把题号条那一句抠掉 ⇒ 同一个判据当场假（磁盘一个字节都不动）。

       🔴 **一条如实的边界**：这一屏**没有回话的口子**（不给 preload）⇒ ◀ ▶ 与点题号只翻**窗内**
          那一屏，改不了网页上"现在是第几题"。所以壳里那份 HTML 在两边不一致时会显示
          「网页在第 N 题」（判据里也钉了这一句）。**真壳上的观感要等出包后由 `verify-exe.mjs` 量。**
       ============================================================ */
    const SHELL_IPC_ABS = 'C:\\Users\\Administrator\\Desktop\\树高教务通打包\\_src\\desktop\\shell-ipc.mjs'
    const shellIpcRaw = (() => {
      try {
        return readFileSync(SHELL_IPC_ABS, 'utf8')
      } catch {
        return null
      }
    })()

    /* ---------- ④-0 **仓库内那一半**：硬判据，**永不落灰**（CI 上也要真判） ----------
     * 施工单 §一那份数据的**类型**就在仓库里（`src/lib/classroomShell.ts`），推送处在
     * `src/pages/Classroom.tsx`（A15 ③ 钉着那一段）—— 这两半**两台机器上都验得了**，不许灰。
     * 只有"壳那份 HTML 长什么样"那一半才是灰的（壳源码在仓库外，CI 的干净检出必然没有）。
     */
    const CLS_SHELL_RAW = readApp('src/lib/classroomShell.ts')
    /** 取 `export interface X {` 到它那一行 `}` 的正文（取不到 ⇒ `null` ⇒ 下面那条红） */
    const ifaceBody = (src, name) => {
      const i = src.indexOf(`export interface ${name} {`)
      if (i < 0) return null
      const j = src.indexOf('\n}', i)
      return j < 0 ? null : src.slice(i, j)
    }
    const dataBody = ifaceBody(CLS_SHELL_RAW, 'ShellPipData')
    const qBody = ifaceBody(CLS_SHELL_RAW, 'ShellPipQuestion')
    const SHAPE_KEYS = ['seq: number', 'ratePct: number', 'band: Band', 'bandLabel: string', 'wrong: Array<{ no: string; name: string }>']
    const shapeOK =
      !!dataBody && !!qBody && dataBody.includes('questions: ShellPipQuestion[]') && SHAPE_KEYS.every((k) => qBody.includes(k))
    const gShape = grayed
    const pShape = passed
    check(
      shapeOK,
      '🔴 A15 ④-0（**只读仓库里的文件 ⇒ 永不落灰、CI 上也真判**）`ShellPipData` 里声明了 `questions: ShellPipQuestion[]`，而 `ShellPipQuestion` 的五个字段（题号 / 正确率 / 分档 / 档名 / 名单）一个不缺 —— 壳小窗要的那份数据在**类型上**就是与网页同一份',
      `ShellPipData=${!!dataBody} · ShellPipQuestion=${!!qBody} · questions 字段=${!!dataBody && dataBody.includes('questions: ShellPipQuestion[]')} · 缺的字段=[${SHAPE_KEYS.filter((k) => !qBody?.includes(k)).join('、')}]`,
    )
    /** ④-0 必须**真判**（判了恰好 1 条、灰了 0 条）—— 自证拿这个数咬人 */
    const shapeJudged = passed - pShape === 1 && grayed - gShape === 0
    /*
     * ④ 那 6 条的基线：**必须在 ④-0 之后取**（④-0 也算"判了"，混进来就变成"壳不在时判了 1 条"
     * —— 2026-10-06 实测，就是这里第一次把自证弄红的），而且要在 ④ 那条自证 `check()` **之前**取。
     */
    const pShell0 = passed
    const gShell0 = grayed

    const grayWas4 = shellGray
    if (shellIpcRaw === null) shellGray = true
    try {
      /*
       * 抠 `escapeHtml` … `pipHtml` 这一整段（到下一个顶层 `export function` 为止）。
       * 锚点找不到 ⇒ `null` ⇒ 下面几条当场红（源码形状变了要有人知道，不许静默）。
       */
      const fnSrc = (() => {
        if (shellIpcRaw === null) return null
        const i = shellIpcRaw.indexOf('function escapeHtml(s) {')
        const j = shellIpcRaw.indexOf('\nexport function registerPip', i)
        return i >= 0 && j > i ? shellIpcRaw.slice(i, j) : null
      })()
      /** 照着壳里那个 `render()` 的调法建函数（`new Function` 里跑的就是壳里那一段源码） */
      const build = (src) => new Function(`${src}; return pipHtml`)()
      let buildErr = ''
      let pipHtmlFn = null
      try {
        pipHtmlFn = fnSrc === null ? null : build(fnSrc)
      } catch (e) {
        buildErr = String(e?.message ?? e)
      }
      /** 探针那一屏：三题，第 2 题是当前题（与 `verify-exe.mjs` 里那份假数据同形） */
      const SAMPLE = {
        className: '高二(3)班',
        seq: 2,
        total: 3,
        ratePct: 50,
        missing: 1,
        questions: [
          { seq: 1, ratePct: 80, band: 'brief', bandLabel: '点到即止', wrong: [] },
          {
            seq: 2,
            ratePct: 50,
            band: 'focus',
            bandLabel: '优先精讲',
            wrong: [{ no: '1001', name: '张三' }, { no: '1002', name: '李四' }],
          },
          { seq: 3, ratePct: 20, band: 'deep', bandLabel: '重点讲，并检查前置知识', wrong: [] },
        ],
      }
      const html = pipHtmlFn === null ? '' : pipHtmlFn(SAMPLE)
      const countOf = (h, re) => (h.match(re) ?? []).length
      /** ① 题号条：**每题一格**，每格带自己的题号与正确率、格子上就是它自己那一档的颜色 */
      const hasStrip = (h) =>
        countOf(h, /class="chip(?: on)?"/g) === 3 &&
        countOf(h, /class="pct"/g) === 3 &&
        h.includes('data-q="1"') && h.includes('data-q="2"') && h.includes('data-q="3"') &&
        h.includes('onclick="pick(2)"') &&
        h.includes('>80%<') && h.includes('>50%<') && h.includes('>20%<') &&
        /* 第 2 题是 focus 档 ⇒ 它的那一格用 `--color-bad` 那个色（绿/黄混进来就不算） */
        h.includes('data-q="2" aria-label="第 2 题" onclick="pick(2)" style="color:#ff7d89;border-color:#ff7d89"')
      /** ② ◀ ▶ 两个键 + 键盘方向键 + Esc（对齐 `PipPanel.tsx:121-129` 与它底下那排按钮） */
      const hasNav = (h) =>
        countOf(h, /class="nb"/g) === 3 &&
        h.includes('>◀</button>') && h.includes('>▶</button>') &&
        h.includes('onclick="step(-1)"') && h.includes('onclick="step(1)"') &&
        h.includes('ArrowLeft') && h.includes('ArrowRight') && h.includes("=== 'Escape'") &&
        /* 🔴 两边不一致那句必须在（没有回话的口子 ⇒ 必须**看得见**） */
        h.includes('网页在第 ')
      /** ③ 名单容器：号码 + 姓名 + 几人错（与 `PipPanel` 的 `wrongNos` / `nameOf` 同源） */
      const hasList = (h) =>
        countOf(h, /class="list"/g) === 3 &&
        countOf(h, /class="who"/g) === 2 &&
        h.includes('1001') && h.includes('张三') && h.includes('1002') && h.includes('李四') &&
        h.includes('2 人错') && h.includes('名单 2') &&
        h.includes('panel.showlist .list')
      /** ④ 配色回到网页那份深色渐变 + 施工单那四样（班级 / 题号 / 正确率 / 未交人数）一个不缺 */
      const hasLook = (h) =>
        h.includes('linear-gradient(180deg,#10151c,#171e28)') &&
        h.includes('高二(3)班') && h.includes('第 2 题') && h.includes('/ 3') &&
        h.includes('>50%<') && h.includes('未交 1 人') && h.includes('优先精讲')

      check(
        !!html && hasStrip(html) && hasNav(html) && hasList(html) && hasLook(html),
        '🔴 A15 ④ 壳小窗那一屏**与网页里那个小窗同一份信息**：题号条（每题一格 + 各自正确率 + 分档着色）+ ◀ ▶ 与方向键 + 名单容器（号码 / 姓名 / 几人错）+ 深色渐变配色 + 班级/题号/正确率/未交人数四样',
        html
          ? `题号格 ${countOf(html, /class="chip(?: on)?"/g)} 个 · 名单容器 ${countOf(html, /class="list"/g)} 个 · 题号条=${hasStrip(html)} · 翻页=${hasNav(html)} · 名单=${hasList(html)} · 配色与四字段=${hasLook(html)}`
          : `🔴 抠不出 \`pipHtml\`：${buildErr || '源码形状变了（锚点找不到）'}`,
      )

      /**
       * 反向对照用的"改一处"：**先数出现次数，不是 1 处就报错、不改**（AGENTS §三.2 —— `replace`
       * 只换第一处，目标串要是在别处也有一份，改的就是别人 ⇒ **对照假绿**）。
       */
      const cutOnce = (src, from, to) => {
        const hits = src.split(from).length - 1
        if (hits !== 1) return { hits, src: null }
        return { hits, src: src.replace(from, to) }
      }
      const cutStrip = fnSrc === null ? null : cutOnce(fnSrc, "const chips = items.map((x) => x.chip).join('')", "const chips = ''")
      const cutNav = fnSrc === null ? null : cutOnce(fnSrc, 'onclick="step(-1)"', 'onclick="noop()"')
      const cutList = fnSrc === null ? null : cutOnce(fnSrc, '<div class="list">', '<div class="nolist">')
      /** 改坏的副本也**真跑一遍**（跑不起来就是"副本没跑起来"，不是对照成功 —— 照 A15 ② 的教训） */
      const htmlOfCut = (cut) => {
        if (cut === null || cut.src === null) return { html: '', err: '' }
        try {
          return { html: build(cut.src)(SAMPLE), err: '' }
        } catch (e) {
          return { html: '', err: String(e?.message ?? e) }
        }
      }
      const hStrip = htmlOfCut(cutStrip)
      const hNav = htmlOfCut(cutNav)
      const hList = htmlOfCut(cutList)
      check(
        cutStrip?.hits === 1 && !hStrip.err && !hasStrip(hStrip.html) && hasNav(hStrip.html) && hasList(hStrip.html),
        '🧪 A15 ④ 反向对照 A：把**题号条**那一段从内存副本里抠掉（`.join(\'\')` → 空串）⇒ "题号条"那条当场假，而翻页 / 名单两条仍绿（证明三条咬的不是同一件事）',
        `抠掉处数=${cutStrip?.hits} · ${hStrip.err ? `副本没跑起来：${hStrip.err}` : `题号条=${hasStrip(hStrip.html)} · 翻页=${hasNav(hStrip.html)} · 名单=${hasList(hStrip.html)}`}`,
      )
      check(
        cutNav?.hits === 1 && !hNav.err && !hasNav(hNav.html) && hasStrip(hNav.html) && hasList(hNav.html),
        '🧪 A15 ④ 反向对照 B：把 ◀ 那颗键的 `step(-1)` 改掉 ⇒ "翻页"那条当场假，题号条 / 名单仍绿',
        `抠掉处数=${cutNav?.hits} · ${hNav.err ? `副本没跑起来：${hNav.err}` : `翻页=${hasNav(hNav.html)} · 题号条=${hasStrip(hNav.html)} · 名单=${hasList(hNav.html)}`}`,
      )
      check(
        cutList?.hits === 1 && !hList.err && !hasList(hList.html) && hasStrip(hList.html) && hasNav(hList.html),
        '🧪 A15 ④ 反向对照 C：把**名单容器**那一层抠掉 ⇒ "名单"那条当场假，题号条 / 翻页仍绿',
        `抠掉处数=${cutList?.hits} · ${hList.err ? `副本没跑起来：${hList.err}` : `名单=${hasList(hList.html)} · 题号条=${hasStrip(hList.html)} · 翻页=${hasNav(hList.html)}`}`,
      )

      /*
       * ⑤ **分档色**：网页那边 `BAND_META[band].color` 是 CSS 变量，小窗里没有那张样式表
       *    ⇒ 壳里只能把暗色主题那几个 hex 抄一遍。抄错一个字节，颜色就跟网页分家了
       *    —— 所以拿 `index.css` 的**暗色块**比着钉（不是只钉"壳里有这几个 hex"）。
       */
      const cssRaw = readApp('src/index.css')
      const darkAt = cssRaw.indexOf('--color-surface: #14181f')
      const darkCss = darkAt < 0 ? '' : cssRaw.slice(darkAt)
      const BAND2VAR = {
        solo: '--color-ink4',
        brief: '--color-ok',
        focus: '--color-bad',
        deep: '--color-warn',
        suspect: '--color-warn',
      }
      const colorPairs = Object.entries(BAND2VAR).map(([band, v]) => {
        const inShell = (fnSrc?.match(new RegExp(`${band}: '(#[0-9a-f]{6})'`)) ?? [])[1] ?? null
        const inCss = (darkCss.match(new RegExp(`${v}:\\s*(#[0-9a-f]{6})`)) ?? [])[1] ?? null
        return { band, v, inShell, inCss, same: !!inShell && inShell === inCss }
      })
      check(
        darkCss !== '' && colorPairs.length === 5 && colorPairs.every((p) => p.same),
        '🔴 A15 ④ 壳里那份**分档色**与网页 `index.css` 暗色主题逐字相同（`solo/brief/focus/deep/suspect` ↔ `--color-ink4/ok/bad/warn/warn`）—— 小窗里没有 CSS 变量，只能抄一遍；抄错了师生看到的就是两套颜色',
        colorPairs.map((p) => `${p.band}=${p.inShell ?? '?'}/${p.inCss ?? '?'}`).join(' · '),
      )
      /* 🧪 反向对照 D：把壳里 `brief` 那个色改一个字节 ⇒ 同一条判据当场假 */
      const cutColor = fnSrc === null ? null : cutOnce(fnSrc, "brief: '#35c98a'", "brief: '#35c98b'")
      const colorBroken = cutColor?.src === null || cutColor === null
        ? false
        : (() => {
            const inShell = (cutColor.src.match(/brief: '(#[0-9a-f]{6})'/) ?? [])[1] ?? null
            const inCss = (darkCss.match(/--color-ok:\s*(#[0-9a-f]{6})/) ?? [])[1] ?? null
            return !!inShell && inShell === inCss
          })()
      check(
        cutColor?.hits === 1 && colorBroken === false,
        '🧪 A15 ④ 反向对照 D：把壳里 `brief` 那个色改一个字节（`#35c98a` → `#35c98b`）⇒ "分档色与 index.css 逐字相同"那条当场假',
        `改一处=${cutColor?.hits} · 改后仍算相同=${colorBroken}`,
      )
    } finally {
      shellGray = grayWas4
    }

    /*
     * 🔴 **自证（三态）** —— 照 A21/A22/A24 那套口径：
     *   · 壳源码**不在**（CI 的干净检出 / 别人的机器）⇒ ④ 那 6 条**全落灰、一条都没判**
     *     （不红不绿 = **未测**，不是"通过"），而 ④-0 那条（只读仓库里的文件）**照样真判**；
     *   · 壳源码**在**（维护者本机）⇒ 6 条**逐条真判、一条都不灰**。
     * ⇒ 谁忘了开/关那个开关、把**仓库内那半**也罩进灰档（= CI 上的静默 no-op）、
     *   或改了 ④ 的条数，这一条当场红。
     */
    const A15_4_N = 6
    const shellJudged = passed - pShell0
    const shellGrayed = grayed - gShell0
    check(
      shapeJudged &&
        shellJudged === (shellIpcRaw === null ? 0 : A15_4_N) &&
        shellGrayed === (shellIpcRaw === null ? A15_4_N : 0),
      '🔴 A15 ④ 自证（三态）：壳源码**不在**时 ④ 那 6 条**全落灰、一条都没判**（不红不绿 = 未测）、而 ④-0 那条**照样真判**；壳源码**在**时 6 条**逐条真判、一条都不灰** —— 忘开/忘关那个开关、把仓库内那半也罩进灰档、或改了条数，这条当场红',
      `壳在=${shellIpcRaw !== null} · ④-0（仓库内那半）真判=${shapeJudged} · ④ 那 ${A15_4_N} 条：判了 ${shellJudged} 条 / 灰了 ${shellGrayed} 条`,
    )
  } finally {
    putBackG()
  }
}

/* ============================================================
   第二十三节 · 🆕 A17：「要留意」汇总清单 —— **计数与清单同源**（源码这一侧）
   ------------------------------------------------------------
   用户 2026-10-04 原话：「维护面板，能不能我点一下概览里面要留意的，就把所以黄色
   或者红色状态的全部列出来呀，一个一个找有点麻烦」。
   屏上那一半（真 DOM：点开、条数、逐字相同、「看这一块」跳转、灰项不进清单）
   在 `shots.mjs` 的「管理台第二期 ⑨」。**这一节钉的是源码这一侧**：

     ① 全屏只有**一份** `attentionAll`（黄红清单的唯一来源；别处只许引用，不许再建一份）；
     ② 顶部那个数字就是 `attentionItems`（= 它按黄红过滤后的长度）—— 同一个数组；
     ③ 每张卡的 `headline` 取自**同一个 `reason` 字段**（`cardReason(…)`），不许各写一份措辞；
     ④ 兜底：`toneCountsMatch`「两处逐项对上」还在；
     ⑤ 灰项不许混进清单，只在末尾那行；⑥ 0 项时那句话不留"0 项要留意"。

   🔴 **两处诚实记下的缺口（别为了让判据绿而假装已覆盖）**：
     · **缺口 A（黄档 / 跨栏）**：本机 dev 没有 `app/.env.local` ⇒ 面板接口（配置 / 备份 /
       数据库 / 错误 / 反馈 / 版本公告）全部读不到 ⇒ 这些卡一律落在**灰**档。
       所以真页面上能拿到的黄红项**恰好 1 个**（本地模式那一档，红）。
       ⇒ **「N 项要留意」（黄档）那句文案、以及"跨栏先切栏再滚"这一支，
          只能在"静态对齐"上钉**（上面 ② 钉同源、`shots ⑨` 钉每条的栏 = 卡真实所在的栏）；
          真正驱动它们需要线上服务端或伪造整套接口回话，这一轮没做，也不假装做了。
     · **缺口 B（超级管理员那一项）**：「0 个 super」**没有单张卡** —— 它的结论只在概览
       那块磁贴上。所以清单里那一条的"原因"取自**磁贴的 `sub`**，
       **不是**卡上那句话（`judgeSuperAdminCount().text` 在屏上从来没出现过 ——
       那是"判据有结论、但没人显示"的历史遗留）。这一条是**已知的口径差**，
       不是判据漏了。

   ⚠️ 一律**先剥注释**再判（这批注释里正当地写着 `attentionAll` / `cardReason` / `badCount`
      这些词；不剥的话"别处不再数一遍"会被注释骗过 ⇒ 判据恒绿，正是 §三.2 那一类）。
   ⚠️ 每条都带一条**在内存里的源码副本上就地改坏**的反向对照（不动磁盘）。
   ============================================================ */

section('第二十三节 · A17：「要留意」汇总清单 —— 计数与清单同源（源码侧）')

{
  /** 剥注释（块注释 + 行注释）—— 判据只许看**真代码**（照 A16 的写法） */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const ADMIN = strip(readApp('src/pages/Admin.tsx'))

  /* ---------------- ① 全屏只有一份 `attentionAll` ---------------- */
  const declCount = (ADMIN.match(/const\s+attentionAll\s*[:=]/g) ?? []).length
  const refCount = (ADMIN.match(/\battentionAll\b/g) ?? []).length
  check(
    declCount === 1 && refCount === 5,
    '🔴 A17 ① 全屏**只有一份** `attentionAll`（黄红清单的唯一来源）—— 别处只许引用，不许再建一份',
    `定义 ${declCount} 处 · 出现 ${refCount} 处（1 处定义 + 「badCount」「warnCount」「attentionItems」「cardReason」各引用 1 处 = 5）`,
  )

  /* 反向对照 A：再建一份同名数组 ⇒ 本条当场假 */
  const dupArray = ADMIN.replace(
    'const attentionAll:',
    "const attentionAllExtra = [{ key: 'x', tone: 'warn' }]\n  const attentionAll:",
  )
  const dupCount = (dupArray.match(/const\s+attentionAll/g) ?? []).length
  check(
    dupArray !== ADMIN && dupCount === 2,
    '🧪 A17 ① 反向对照 A：把那份数组**再建一遍**（内存副本）⇒ 「只有一份」当场假',
    `副本真的被改过=${dupArray !== ADMIN} · 副本里同名声明 ${dupCount} 份`,
  )

  /* ---------------- ② 顶部那个数字 = `attentionItems.length`（同一个数组） ---------------- */
  /*
   * 这一段**不引入任何新名字**：`badCount` / `warnCount` / `attentionItems` 就是
   * 那份数组（① 已经钉住"只有一份"）按黄红过滤出来的长度 ——
   *   `items.length` 出现在 `AttentionBar` 里 ⇒ 顶部那个数字就是清单的长度。
   */
  const barBody = (() => {
    const at = ADMIN.indexOf('function AttentionBar')
    if (at < 0) return ''
    const end = ADMIN.indexOf('function maintenanceHeadline', at)
    const whole = end < 0 ? ADMIN.slice(at) : ADMIN.slice(at, end)
    /* ⚠️ 去掉尾部那段注释（`function maintenanceHeadline` 上面那段注释里正当地写着
       `badCount` 等词）—— 注释已经剥过，但这里再切掉尾巴更保险 */
    return whole.slice(0, Math.max(0, whole.length - 200))
  })()
  check(
    barBody.includes('items.length') &&
      !barBody.includes('badCount') &&
      !barBody.includes('warnCount') &&
      !barBody.includes('attentionItems'),
    '🔴 A17 ② 顶部那个数字取的是 `AttentionBar` 收进来的 **`items.length`** —— 就是清单本身的长度，**不是**在渲染里另数一遍 `allTones`',
    `AttentionBar 里有 items.length=${barBody.includes('items.length')} · 另数一遍（badCount/warnCount/attentionItems 一个都不该在）=${barBody.includes('badCount') || barBody.includes('warnCount') || barBody.includes('attentionItems')}`,
  )
  const itemsExpr = /const\s+attentionItems[^=]*=\s*attentionAll\s*\.\s*filter\(\s*([\s\S]*?)\)\s*\n/.exec(
    ADMIN,
  )
  check(
    /tone\s*===\s*'bad'/.test(itemsExpr?.[1] ?? '') &&
      /tone\s*===\s*'warn'/.test(itemsExpr?.[1] ?? '') &&
      !/unknown/.test(itemsExpr?.[1] ?? ''),
    '🔴 A17 ② `attentionItems` = 那份数组按 **黄红** 过滤（`bad` + `warn`），**灰不在里面**',
    short(itemsExpr?.[1] ?? '（没匹配到 `attentionItems` 的赋值）', 120),
  )

  /* 反向对照 B / C：改坏那两条 ⇒ 同一个"同源"判据当场假 */
  const countElsewhere = ADMIN.replace(
    '<span className="num">{items.length}</span>',
    '<span className="num">{badCount}</span>',
  )
  const dupItems = ADMIN.replace(
    'const attentionItems: AttentionItem[] = attentionAll.filter(',
    "const attentionItemsOther = allTones.filter((t) => t === 'warn').length\n  const attentionItems: AttentionItem[] = attentionAll.filter(",
  )
  check(
    countElsewhere !== ADMIN && !countElsewhere.includes('{items.length}'),
    '🧪 A17 ② 反向对照 B：把那颗按钮里的数字**换成别处数出来的一个数**（副本里 `{items.length}` → `{badCount}`）⇒「数字就是清单长度」当场假',
    `副本真的被改过=${countElsewhere !== ADMIN} · 副本里还有 {items.length}=${countElsewhere.includes('{items.length}')}`,
  )
  check(
    dupItems !== ADMIN && (dupItems.match(/const\s+attentionItems/g) ?? []).length === 2,
    '🧪 A17 ② 反向对照 C：把清单的来源**再建一份**（副本里加一个从 `allTones` 数出来的同名变量）⇒「同一个数组」当场假',
    `副本真的被改过=${dupItems !== ADMIN} · 副本里同名声明 ${(dupItems.match(/const\s+attentionItems/g) ?? []).length} 份`,
  )

  /**
   * 切出 `attentionAll` **那一段数组字面量**（花括号配对，不看注释）。
   * 为什么要切：`reason:` 这个词在别处也有（`unknownReason:` 那种字段名），
   * 整文件数会数成 16 —— 只有这一段里的 `reason:` 才是"每一条都有自己的原因"。
   */
  const sliceArrayBlock = () => {
    const at = ADMIN.indexOf('const attentionAll')
    if (at < 0) return ''
    const from = ADMIN.indexOf('= [', at)
    if (from < 0) return ''
    let depth = 0
    for (let i = from + 2; i < ADMIN.length; i++) {
      const ch = ADMIN[i]
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) return ADMIN.slice(from, i + 1)
      }
    }
    return ''
  }
  const ARR = sliceArrayBlock()

  /* ---------------- ③ 每张卡的 headline 取自同一个 `reason` 字段 ---------------- */
  /*
   * ⚠️ 数字都是**实测过的**（2026-10-04 这一版）：数组里 11 条各有一个 `reason:`；
   *    能出黄红的 ⑩ 张卡里，8 张用 `cardReason(…)`（维护 / 版本更新那两张走各自的
   *    共用函数 `maintenanceHeadline` / `releaseHeadline` —— 与清单取的是同一个函数）；
   *    另有 3 个"既给数组、也给共用函数"的局部常量（`maintReason` / `releaseReason` /
   *    `superReason`）。所以 11 = 8 + 3 就是**同源**的算术表达。
   */
  const reasonFields = (ARR.match(/(^|[\s,{])reason:\s/gm) ?? []).length
  const cardReasonCalls = (ADMIN.match(/cardReason\(\s*'[a-z]+'\s*\)/g) ?? []).length
  const sharedReasonConsts = (ADMIN.match(/const\s+(maint|release|super)Reason\s*=/g) ?? []).length
  check(
    ARR !== '' && reasonFields === 11 && cardReasonCalls === 8 && sharedReasonConsts === 3,
    '🔴 A17 ③ 每张卡的 `headline` 都取自**同一个 `reason` 字段**（8 张走 `cardReason(…)`，维护 / 版本更新走各自的共用函数，另有 3 个常量）—— 不许在卡上再写一份措辞',
    `数组段长度 ${ARR.length} 字符 · 段里 reason: ${reasonFields} 处 · cardReason(…) ${cardReasonCalls} 处 · 共用函数用的局部常量 ${sharedReasonConsts} 个（${reasonFields} = ${cardReasonCalls} + ${sharedReasonConsts}）`,
  )
  const cardKeepsCopy = ADMIN.replace(
    "headline={cardReason('deploy')}",
    "headline={localMode ? '**本地模式** —— 平台上所有数据其实只在这台浏览器里' : '线上构建标识正常'}",
  )
  check(
    ADMIN.includes("headline={cardReason('deploy')}") &&
      cardKeepsCopy !== ADMIN &&
      !cardKeepsCopy.includes("headline={cardReason('deploy')}"),
    '🧪 A17 ③ 反向对照：把「① 部署与版本」那张卡换回**自己写一份措辞**（副本）⇒ 上面那条当场假（证明它咬的是"卡去取同一个 reason"，不是"有没有 headline"）',
    `正向能匹配=${ADMIN.includes("headline={cardReason('deploy')}")} · 副本里那句没了=${!cardKeepsCopy.includes("headline={cardReason('deploy')}")}`,
  )

  /* ---------------- ④ 兜底：`toneCountsMatch` 那类"两处逐项对上"还在 ---------------- */
  /*
   * ⚠️ 原来这里的正则写的是 `filter\([^)]*bad[^)]*\)` —— 而真实那一段是
   *    `allTones.filter((t) => t === 'bad').length`，**箭头函数那个 `)` 就把 `[^)]*` 掐断了**
   *    ⇒ 判据恒假（第一次跑就是这一条红）。所以改成"允许括号"的写法：
   *    `filter\(([^;]*?)bad([^;]*?)\)\s*\.\s*length` —— 在分号前把那一小段抓出来。
   */
  const matchPair = (tone, countVar) =>
    new RegExp(
      `allTones\\s*\\.\\s*filter\\(([^;]*?)${tone}([^;]*?)\\)\\s*\\.\\s*length\\s*===\\s*${countVar}`,
    ).test(ADMIN)
  check(
    /const\s+toneCountsMatch\s*=/.test(ADMIN) && matchPair('bad', 'badCount') && matchPair('warn', 'warnCount'),
    '🔴 A17 ④ 兜底判据 `toneCountsMatch` 还在：`allTones` 里黄/红的条数必须与 `attentionAll` 数出来的一致（"两处逐项对上"，谁漏补一边就露头）',
    `toneCountsMatch=${/const\s+toneCountsMatch\s*=/.test(ADMIN)} · bad 那一对=${matchPair('bad', 'badCount')} · warn 那一对=${matchPair('warn', 'warnCount')}`,
  )
  const noMatch = ADMIN.replace('const toneCountsMatch =', 'const toneCountsMatchX =')
  check(
    noMatch !== ADMIN && !/const\s+toneCountsMatch\s*=/.test(noMatch),
    '🧪 A17 ④ 反向对照：把那条兜底判据**改掉名字**（副本）⇒ 上面那条当场假（它不是注释、也不是摆设）',
    `副本真的被改过=${noMatch !== ADMIN}`,
  )

  /* ---------------- ⑤ 灰项不许混进清单，只在末尾那行 ---------------- */
  const itemsPredicate = itemsExpr?.[1] ?? ''
  check(
    itemsPredicate !== '' && !itemsPredicate.includes('unknown'),
    '🔴 A17 ⑤ 灰项**不在清单的过滤条件里**（`attentionItems` 的 filter 里没有 `unknown`）—— 它只在末尾那行「另有 N 项无法判断」',
    short(itemsPredicate, 120),
  )
  const withUnknown = ADMIN.replace(
    "a.tone === 'bad' || a.tone === 'warn',",
    "a.tone === 'bad' || a.tone === 'warn' || a.tone === 'unknown',",
  )
  const brokenPredicate =
    /const\s+attentionItems[^=]*=\s*attentionAll\s*\.\s*filter\(\s*([\s\S]*?)\)\s*\n/.exec(
      withUnknown,
    )?.[1] ?? ''
  check(
    withUnknown !== ADMIN && brokenPredicate.includes('unknown'),
    '🧪 A17 ⑤ 反向对照：往过滤条件里**塞一个 `unknown`**（副本）⇒「灰不在清单里」当场假',
    `副本真的被改过=${withUnknown !== ADMIN} · 改坏后 filter 里出现 unknown=${brokenPredicate.includes('unknown')}`,
  )
  check(
    ADMIN.includes('另有') && ADMIN.includes('项无法判断') && !ADMIN.includes('0 项要留意'),
    '🔴 A17 ⑤ 末尾那行写的是「另有 N 项无法判断（拿不到数据，不算"要留意"）」；而源码里**不含** `0 项要留意`（0 项时不留空数字）',
    `另有=${ADMIN.includes('另有')} · 项无法判断=${ADMIN.includes('项无法判断')} · 出现"0 项要留意"=${ADMIN.includes('0 项要留意')}`,
  )
  const noZeroGuard = ADMIN.replace(/\{items\.length > 0 \? \(/g, '{true ? (')
  const guardHits = (ADMIN.match(/\{items\.length > 0 \? \(/g) ?? []).length
  check(
    guardHits === 1 && noZeroGuard !== ADMIN && !/\{items\.length > 0 \? \(/.test(noZeroGuard),
    '🧪 A17 ⑤ 反向对照：把 `items.length > 0` 那道闸去掉（副本）⇒ "0 项时不留空数字"就失去了实现依据（0 项时那句话只剩前半截，不会出现空数字）',
    `源码里那道闸 ${guardHits} 处 · 副本真的被改过=${noZeroGuard !== ADMIN}`,
  )

  /* ---------------- ⑥ 每条都得有 `pane`（跨栏那一支的静态对齐） ---------------- */
  const paneFields = (ARR.match(/(^|[\s,{])pane:\s*'/gm) ?? []).length
  const paneMarkers = (ADMIN.match(/data-admin-pane=/g) ?? []).length
  check(
    paneFields === reasonFields && paneFields >= 11 && paneMarkers >= 7,
    '🔴 A17 ⑥ 数组里**每一条都标了 `pane`**（它落在哪一栏），而每个分区都摆了 `data-admin-pane` 标记 —— "跨栏先切栏再滚"只能这样静态对齐（缺口 A）',
    `段里 pane: ${paneFields} 处 · reason: ${reasonFields} 处（必须相等）· data-admin-pane 标记 ${paneMarkers} 处`,
  )
  const dropPane = ADMIN.replace("      pane: 'db',", '')
  check(
    dropPane !== ADMIN && (dropPane.match(/(^|[\s,{])pane:\s*'/gm) ?? []).length === paneFields - 1,
    '🧪 A17 ⑥ 反向对照：把其中一条的 `pane` **删掉**（副本）⇒「每一条都标了 pane」当场假',
    `副本里 pane: ${(dropPane.match(/(^|[\s,{])pane:\s*'/gm) ?? []).length} 处（原本 ${paneFields} 处）`,
  )
  /* ⚠️ 缺口 B 也在这里说清：`super` 那一条的 pane 是 `overview`（磁贴所在栏），不是某张卡所在栏 */
  check(
    /key:\s*'super'[\s\S]{0,220}pane:\s*'overview'/.test(ADMIN),
    '⚠️ A17 ⑥（缺口 B 的落点）「超级管理员」那一条的 `pane` 是 `overview` —— 它**没有卡**，结论只在概览那块磁贴上（口径差见本节开头那段）',
    'key: super 与 pane: overview 的位置关系',
  )
}

/* ============================================================
   第二十四节 · A18：「今天」时间轴（2026-10-04，施工单-日程今天时间轴.md）
   ------------------------------------------------------------
   为什么单开一节：平铺列表看不出三件事 ——
     ① 每节课**真实占多长**（40 分钟和 90 分钟看起来一样长）
     ② 中间**空闲多久**（不用自己把上一次的 end 和下一次的 start 减一遍）
     ③ **哪两节真的撞了**（而且要画成并排，不是叠在一起看不见）

   ⚠️ 判据落在**纯函数**上，不落界面 ——
      `dayRange` / `dayGaps` / `overlapGroups` 不碰 DOM、不读全局，
      所以能脱离界面单测；界面上那三处（空闲/时间重叠/现在）另在静态侧钉。

   🔴 这三条与 `applyMondayShift()` 返回的 `conflicts` 是**同一件事两个说法**
      （那处已经把冲突交给界面提示了）。本节只保证它们判得一致，不新造一套口径。
   ============================================================ */
section('第二十四节 · A18：「今天」时间轴 —— 真实时长 / 空闲 / 重叠（纯函数）')

{
  const SCHED = readApp('src/lib/schedule.ts')

  /**
   * 把那几个纯函数**原样**抠出来求值，不另抄一份 ——
   * 抄一份就变成"我抄错了但两边都绿"。
   *
   * ⚠️ 两个坑（前面 D13 那节已踩过，这里同一路）：
   *   ① `export ` 在 `new Function()` 的函数体里是语法错误；
   *   ② `new Function()` 只吃 JS，而源码是 TS —— 类型注解要剥。
   *      只剥类型，**逻辑一个字都不动**。
   */
  const loadAxis = (mutate = () => {}) => {
    const from = SCHED.indexOf('export function toMinutes')
    const to = SCHED.lastIndexOf('}')
    if (from < 0 || to < 0) throw new Error('抠不出时间轴那一段')
    const blocks = []
    for (const re of [
      /^export function toMinutes[\s\S]*?^\}/gm,
      /^export const AXIS_PAD_MIN[^\n]*\n/gm,
      /^export const GAP_MIN_MINUTES[^\n]*\n/gm,
      /^export function dayRange[\s\S]*?^\}/gm,
      /^export function dayGaps[\s\S]*?^\}/gm,
      /^export function overlapGroups[\s\S]*?^\}/gm,
    ]) {
      const m = SCHED.slice(from, to + 1).match(re)
      if (m) for (const x of m) blocks.push(x)
    }
    const missing = ['toMinutes', 'AXIS_PAD_MIN', 'GAP_MIN_MINUTES', 'dayRange', 'dayGaps', 'overlapGroups'].filter(
      (k) => !blocks.some((b) => b.includes(k)),
    )
    if (missing.length) throw new Error(`抠漏了 ${missing.join('/')}（改名了这一节得跟着改）`)

    let body = blocks.join('\n').replace(/^import .*$/gm, '')
    // 剥类型：**只碰函数签名上的那一处**（`(items: readonly ScheduleItem[]): DayRange | null`），
    // 体和常量一个字都不动 —— 剥多了会把下一行也吃掉，剥少了求值直接 SyntaxError。
    body = body
      .replace(
        // 函数签名上的返回值类型 —— `DayRange | null` 里**有空格**，所以按「到 `{` 为止、不跨行」收
        /\(([^()]*?)\)\s*:\s*[^\n{]*(?=\{)/g,
        (s, params) => `(${params.replace(/:\s*[^,)]+/g, '').trim()})`,
      )
      // ⚠️ 局部变量上的类型注解（`const out: DayGap[] = []` / `let cur: ScheduleItem[] = []`）
      //   同样要剥 —— 上一版只剥了签名，于是**求值从"Unexpected token ':'"变成
      //   "Missing initializer in const declaration"**（同一个坑的下一层症状）
      .replace(/(:\s*(?:readonly\s+)?[A-Za-z_$][\w$[\]]*(?:\[\])*(?:\s*\|\s*[A-Za-z_$][\w$[\]]*(?:\[\])*)*)\s*(?==)/g, '')
    body = body.replace(/^(\s*)export\s+/gm, '$1').replace(/\sas\s+const/g, '')

    /*
     * 🔴 `mutate` 做的是**变异**（把实现改坏、验证判据会红）。
     *    所以它拿到的不是裸字符串，而是 `mustReplaceOnce` ——
     *      · `String.replace(re, …)` **只换第一处**；源码里若有第二处相同文字
     *        （哪怕在注释里），改到的就是注释而**判据照样绿** ⇒ 对照成了摆设；
     *      · 这一版三条反向对照正是这么假绿的（`s < curEnd` 的注释里也有一份，
     *        排在真代码前面）；所以这里强制「恰好一处」，不是 1 处就抛错。
     */
    const mustReplaceOnce = (needle, replacement) => {
      const n = body.split(needle).length - 1
      if (n !== 1) {
        throw new Error(`变异目标出现 ${n} 处（必须恰好 1 处）：${JSON.stringify(needle.slice(0, 60))}`)
      }
      body = body.replace(needle, replacement)
    }
    mutate(body, mustReplaceOnce)

    // eslint-disable-next-line no-new-func
    return new Function(
      `${body}
return { toMinutes, AXIS_PAD_MIN, GAP_MIN_MINUTES, dayRange, dayGaps, overlapGroups };`,
    )()
  }

  /** 固定一条课（判据不读真库、不看设备时间） */
  const it = (id, start, end) => ({ id, weekday: 1, start, end, title: `T${id}`, kind: 'class', notify: true, scope: 'mine' })

  let A
  let loadErr = ''
  try {
    A = loadAxis()
  } catch (e) {
    A = {}
    loadErr = e instanceof Error ? e.message : String(e)
  }

  check(
    !loadErr && ['dayRange', 'dayGaps', 'overlapGroups'].every((k) => typeof A[k] === 'function'),
    'A18 锚点自证：抠出来的**就是**那几个纯函数（否则下面全是空转）',
    loadErr ? `求值失败：${loadErr}` : `typeof = ${['dayRange', 'dayGaps', 'overlapGroups'].map((k) => typeof A[k]).join('/')}`,
  )

  /* ---------------- ① 边界：上下各留一圈、向整点取整、越界要钳住 ---------------- */
  check(A.dayRange([]) === null, 'A18 ① 空数组回 `null` —— 界面据此**不渲染轴**（别给一条空轴，那看着像坏了）', `实测 ${JSON.stringify(A.dayRange([]))}`)
  {
    const r = A.dayRange([it('a', '08:00', '08:45'), it('b', '10:00', '10:40')])
    check(
      r.fromMin === 420 && r.toMin === 720,
      'A18 ① 上下各留 30 分钟并**向整点取整**（08:00−30=07:30→07:00，10:40+30=11:10→12:00）',
      `实测 ${JSON.stringify(r)}`,
    )
  }
  {
    /* 早晚课：减法/加法都要有钳位，否则轴画到容器外（看着像"今天没课"） */
    const early = A.dayRange([it('a', '07:00', '07:45')])
    check(early.fromMin === 360, 'A18 ① 早课时 fromMin 落在 06:00，不是 06:30（要整点）', `实测 ${early.fromMin}`)
    const late = A.dayRange([it('a', '22:30', '23:15')])
    check(late.toMin === 1440, 'A18 ① 晚课时 toMin 收在 24:00（放行会算出 24:45）', `实测 ${late.toMin}`)
  }
  /* 反向对照①：把 padding 换成 600 小时级，两道钳位必须同时被顶出来 */
  {
    let B
    try {
      B = loadAxis((_s, must) => must('AXIS_PAD_MIN = 30', 'AXIS_PAD_MIN = 600'))
      check(typeof B.dayRange === 'function', '🧪 A18 ① 变异体求值成功（变异没生效的话，判据会假绿）', `typeof = ${typeof B?.dayRange}`)
    } catch {
      B = {}
    }
    const e = B.dayRange?.([it('a', '07:00', '07:45')])
    const l = B.dayRange?.([it('a', '22:30', '23:15')])
    check(
      e?.fromMin === 0 && l?.toMin === 1440,
      '🧪 A18 ① 反向对照：padding 改到 600 ⇒ fromMin 被夹到 0、toMin 被夹到 1440（证明上面两条钳位真在判，不是摆设）',
      `早课 fromMin=${e?.fromMin}（期望 0）· 晚课 toMin=${l?.toMin}（期望 1440）`,
    )
  }

  /* ---------------- ② 空闲：门槛 10 分钟，且门槛本身可红 ---------------- */
  check(
    A.GAP_MIN_MINUTES === 10,
    'A18 ② 空档门槛 = 10 分钟 —— 5 分钟的接续**不是**空档（那是正常作息，天天报就成了假红）',
    `实测 ${A.GAP_MIN_MINUTES}`,
  )
  {
    const g = A.dayGaps([it('a', '08:00', '08:45'), it('b', '10:00', '10:40'), it('c', '10:45', '11:30')])
    check(
      g.length === 1 && g[0].minutes === 75,
      'A18 ② 三节课只回**一个**空档：08:45→10:00 = 75 分钟；10:40→10:45 那 5 分钟不算',
      `实测 ${g.length} 条${g[0] ? ` · 首条 ${g[0].minutes} 分钟` : ''}`,
    )
  }
  {
    const g = A.dayGaps([it('a', '08:00', '08:45'), it('b', '08:55', '09:40')])
    check(g.length === 1 && g[0].minutes === 10, 'A18 ② 正好 10 分钟**算**空档（边界含）', `实测 ${JSON.stringify(g)}`)
  }
  {
    const g = A.dayGaps([it('a', '08:00', '08:45'), it('b', '08:45', '09:30')])
    check(g.length === 0, 'A18 ② 首尾相接（0 分钟）**不算**空档', `实测 ${g.length} 条`)
  }
  /* 反向对照②：门槛降到 0 ⇒ 上面那三条"不算"必须同时翻 */
  {
    let B
    try {
      B = loadAxis((_s, must) => must('GAP_MIN_MINUTES = 10', 'GAP_MIN_MINUTES = 0'))
    } catch {
      B = {}
    }
    const tight = B.dayGaps?.([it('a', '08:00', '08:45'), it('b', '08:45', '09:30')])
    const tiny = B.dayGaps?.([it('a', '08:00', '08:45'), it('b', '10:00', '10:40'), it('c', '10:45', '11:30')])
    check(
      tight?.length === 1 && tiny?.length === 2,
      '🧪 A18 ② 反向对照：门槛降到 0 ⇒ 接续与 5 分钟都被报出来（证明上面三条"不算"真在判）',
      `接续得到 ${tight?.length} 条（期望 1）· 三节课得到 ${tiny?.length} 条（期望 2）`,
    )
  }

  /* ---------------- ③ 重叠：首尾相接不算，连压三节合成一组 ---------------- */
  check(
    A.overlapGroups([it('a', '08:00', '08:45'), it('b', '08:45', '09:30')]).length === 0,
    'A18 ③ 首尾相接不算重叠（上一节 08:45 下课，下一节 08:45 上课）',
    '实测 0 组',
  )
  {
    const ov = A.overlapGroups([it('a', '08:00', '09:00'), it('b', '08:30', '09:30'), it('c', '10:00', '11:00')])
    check(
      ov.length === 1 && ov[0].length === 2,
      'A18 ③ 两条压在一起 = **一组**（界面上并排），第三条独立',
      `实测 ${ov.length} 组${ov[0] ? ` · 首组 ${ov[0].length} 节` : ''}`,
    )
  }
  {
    const chain = A.overlapGroups([it('a', '08:00', '09:00'), it('b', '08:30', '09:30'), it('c', '09:15', '10:00')])
    check(
      chain.length === 1 && chain[0].length === 3,
      'A18 ③ **传递**重叠（a 压 b、b 压 c，a 与 c 不直接压）三节合成一组 —— 少一条就并排不开',
      `实测 ${chain.length} 组${chain[0] ? ` · 首组 ${chain[0].length} 节` : ''}`,
    )
  }
  /* 反向对照③：把严格小于改成小于等于 ⇒ "首尾相接不算"当场假 */
  {
    let B
    try {
      B = loadAxis((_s, must) => must('if (cur.length && s < curEnd)', 'if (cur.length && s <= curEnd)'))
    } catch {
      B = {}
    }
    const touching = B.overlapGroups?.([it('a', '08:00', '08:45'), it('b', '08:45', '09:30')])
    check(
      touching?.length === 1,
      '🧪 A18 ③ 反向对照：把 `s < curEnd` 改成 `s <=` ⇒ 首尾相接立刻被报成重叠（证明那条严格小于真在判）',
      `实测 ${touching?.length} 组（期望 1）`,
    )
  }

  /* ---------------- ④ 界面上那三处（不能只靠函数绿） ---------------- */
  {
    const AXIS = readApp('src/components/ScheduleDayAxis.tsx')
    const PAGE = readApp('src/pages/Schedule.tsx')
    check(
      /空闲\s*\{g\.minutes\}\s*分钟/.test(AXIS),
      'A18 ④ 空档那行写的是「空闲 N 分钟」—— 让老师一眼看出**这段时间能安排事**',
      `实测 ${/空闲\s*\{g\.minutes\}\s*分钟/.test(AXIS)}（找的是 JSX 里的 \`空闲 {g.minutes} 分钟\`）`,
    )
    check(AXIS.includes('时间重叠'), 'A18 ④ 重叠那行有「时间重叠」标记（叠在一起看不见就等于没报）', `含「时间重叠」=${AXIS.includes('时间重叠')}`)
    check(
      AXIS.includes('现在') && AXIS.includes('位置') === false,
      'A18 ④ 有「现在」这条时刻线 —— 一条时间轴不给"现在在哪"就还得自己心算',
      `含「现在」=${AXIS.includes('现在')}`,
    )
    check(
      AXIS.includes('if (!range) return null'),
      'A18 ④ items 空时**早退不渲染轴** —— 钩子顺序也在所有 useMemo 之后（提前早退下一帧就炸）',
      `含早退=${AXIS.includes('if (!range) return null')}`,
    )
    check(
      /position:\s*'absolute'/.test(AXIS) && AXIS.includes('PX_PER_MIN'),
      'A18 ④ 按真实分钟铺位（同一比例尺下 40 分钟就该是 80 分钟的一半高）',
      `绝对定位=${/position:\s*'absolute'/.test(AXIS)} · 比例尺常量=${AXIS.includes('PX_PER_MIN')}`,
    )
    check(
      /<ScheduleDayAxis[\s\S]{0,200}classNameOf/.test(PAGE),
      'A18 ④「今天」那屏接的是**时间轴**（不是还留在平铺列表上）',
      'ScheduleDayAxis 在 Schedule.tsx 里被用到=' + /<ScheduleDayAxis/.test(PAGE),
    )
    check(
      !/state\.items\.map\(\(it\) =>[\s\S]{0,80}className="row"/.test(PAGE),
      'A18 ④ 旧的平铺列表**已经换掉**（留着两套 = 同一个信息出现两次，老师会问"哪个对"）',
      '仍存在那段列表=' + /state\.items\.map\(\(it\) =>[\s\S]{0,80}className="row"/.test(PAGE),
    )
    /* 反向对照④：把「时间重叠」这三个字从组件里抠掉 ⇒ 上面那条当场假 */
    {
      const stripped = AXIS.replace('时间重叠', '撞了')
      check(
        stripped !== AXIS && !stripped.includes('时间重叠'),
        '🧪 A18 ④ 反向对照：把「时间重叠」换掉（副本）⇒ 上面那条"有重叠标记"立刻失据（证明它读的是真源码）',
        `副本真的被改过=${stripped !== AXIS}`,
      )
    }
  }
}

/* ============================================================
   🆕 2026-10-04 · A19：超管面板的**备份引导档** + ⑥「档案解密」的钥匙口径（**源码侧**）
   ============================================================
   上一轮（`16ca7d4`）把这两件事做完时**不许碰门禁** ⇒ 当时没有任何判据看着它们。
   这一节钉住**源码这一侧**（真 DOM 那一侧在 `shots.mjs` 的 `SAD` 那一节，两处互补）：
     ① ③ 卡引导档的**五组事实**（照实写，一个字都不许少）；
     ② 那颗按钮的**如实名字**（`BACKUP_MARK_LABEL.pending` 就是按钮名）+ 两处源码里都没有「备份到云端」；
     ③ 那一整块**只有一份实现**（`<BackupExtraActions />` 只摆一次 —— 不许写第二份）；
     ④ ③ 卡那段源码里**一个输入控件都没有**（面板不收整库口令 / 档案私钥）；
     ⑤ ⑥ 卡是**全仓唯一**出现私钥输入框的地方，而且卡里**没有任何把它带出去的调用**；
     ⑥ `lib/backup.ts` 的兜底文案已经改成如实的那一句（不再说"没能存到云端"）。
   ⚠️ 一律**先剥注释**再判：这五组事实的"为什么"正当地写在注释里（③ 卡上面那一段注释
      逐条复述了它们）—— 不剥的话"照实写在屏上"会被注释骗过 ⇒ 判据恒绿（§三.2 那一类）。
      反向对照 B 就是专门治这个的：把那一句**挪进注释** ⇒ 同一个判据必须假。
   ⚠️ 每条都带一条**在内存里的源码副本上就地改坏**的反向对照（不动磁盘）。
   ============================================================ */

section('第二十五节 · A19：备份引导档四条事实 + ⑥ 档案解密的钥匙口径（源码侧）')

{
  /** 剥注释（块注释 + 行注释）—— 判据只许看**真代码**（照 A16 / A17 的写法） */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const RAW_ADMIN = readApp('src/pages/Admin.tsx')
  const ADMIN = strip(RAW_ADMIN)
  const EXTRA = strip(readApp('src/components/BackupExtraActions.tsx'))
  const CRYPTO = strip(readApp('src/lib/backupCrypto.ts'))
  const BACKUP = strip(readApp('src/lib/backup.ts'))

  /** 按起止标记切一段源码（**找不到起点就回空串** ⇒ 判据当场假，绝不静默放过） */
  const region = (s, from, to) => {
    const a = s.indexOf(from)
    if (a < 0) return ''
    const b = s.indexOf(to, a + from.length)
    return b < 0 ? s.slice(a) : s.slice(a, b)
  }
  /**
   * 🔴 反向对照的前置：目标串必须**恰好出现一次**再替换
   *    （`String.replace` 只换**第一处** —— 而目标串经常在注释里也有一份、且排在真代码前面
   *     ⇒ 改的是注释、判据纹丝不动 ⇒ 对照假绿。`AGENTS.md` 三·2 2026-10-04 加的纪律。）
   *    出现 0 处或 2 处 ⇒ `ok=false` ⇒ **这条对照自己红**，绝不静默通过。
   */
  const once = (t, s) => t.split(s).length - 1
  const oneEdit = (t, from, to) =>
    once(t, from) === 1
      ? { ok: true, n: 1, text: t.replace(from, to) }
      : { ok: false, n: once(t, from), text: t }

  /* ---------------- ① ③ 卡引导档：五组事实（剥注释后仍在真 JSX 里） ---------------- */
  const GUIDE_FACTS = [
    /* ① 每天北京 02:30 跑 `pg_dump → gzip → AES-256 → R2` */
    ['02:30', 'pg_dump', 'gzip', 'AES-256'],
    /* ② R2 短期开不了 ⇒ **今天真正的备份在 GitHub Actions 的 Artifact**（保留 30 天 · 要登录） */
    ['短期开通不了', 'GitHub Actions', '保留 30 天', '登录 GitHub 才能下载'],
    /* ③ 拉回＝打包机双击那个 `.cmd`（落到哪个目录 / 只留 30 份 / 不解密） */
    ['_tools\\拉取整库备份.cmd', '树高教务通打包\\整库备份\\', '只留最近 30 份', '不解密'],
    /* ④ 🔴 不可逆操作先留退路：恢复前先在打包机导一份当前库 */
    ['恢复前先在打包机导一份当前库'],
    /* ⑤ 钥匙在超管手上、面板只读不收 */
    ['不收口令、不收私钥', 'BACKUP_ENCRYPTION_PASSPHRASE'],
  ]
  const guideOk = (s) => GUIDE_FACTS.every((g) => g.every((x) => s.includes(x)))
  check(
    guideOk(ADMIN),
    '🔴 A19 ① ③ 卡的引导档**照实**写清五组事实（北京 02:30 那条链 · R2 开不了⇒真备份在 GitHub Actions 的 Artifact 保留 30 天且要登录 · 打包机双击那个 .cmd 落到哪个目录、只留 30 份、不解密 · **恢复前先导一份当前库** · 钥匙在超管手上、面板只读不收）—— **剥注释之后**仍然在',
    GUIDE_FACTS.map((g, i) => `第${i + 1}组 ${g.filter((x) => ADMIN.includes(x)).length}/${g.length}`).join(' · '),
  )
  {
    /* 🧪 反向对照 A：把「恢复前先在打包机导一份当前库」从副本里抠掉 ⇒ 同一条判据当场假 */
    const cut = oneEdit(ADMIN, '恢复前先在打包机导一份当前库', '（先干再说）')
    check(
      cut.ok && !guideOk(cut.text),
      '🧪 A19 ① 反向对照 A：把「恢复前先在打包机导一份当前库」从**内存副本**里抠掉 ⇒ 同一条判据当场判假（证明这五组事实真的逐字被判，不是恒真）',
      `目标在剥注释后的源码里出现 ${cut.n} 处（须恰好 1）· 抠掉之后判据=${guideOk(cut.text)}`,
    )
  }
  {
    /*
     * 🧪 反向对照 B（**专治"注释里写了也算"**）：把那一句从 JSX 挪进注释 ——
     *    JSX 那句换成"先干再说"、再把原句补进一段注释里 ⇒ **同一个判据（先剥注释）必须假**。
     *    没有这一条，"剥注释"这件事本身就没被钉住（写注释也能骗绿）。
     */
    const cutJsx = oneEdit(RAW_ADMIN, '<b>恢复前先在打包机导一份当前库</b>', '<b>先干再说</b>')
    const moved = `${cutJsx.text}\n/* 恢复前先在打包机导一份当前库 */\n`
    check(
      cutJsx.ok && !guideOk(strip(moved)),
      '🧪 A19 ① 反向对照 B：把那一句**挪进注释**（JSX 换成"先干再说"、注释里补回原句）⇒ 同一个判据当场判假 —— 证明"注释里写了"不算数，判据看的是真 JSX',
      `目标在**原始文件**里出现 ${cutJsx.n} 处（须恰好 1）· 副本剥注释后判据=${guideOk(strip(moved))}（期望 false）`,
    )
  }

  /* ---------------- ② 如实按钮名 + 两处源码里都没有「备份到云端」 ---------------- */
  /** 取出 `BACKUP_MARK_LABEL` 那张表（四档文案都在里面） */
  const markTable = (s) => region(s, 'const BACKUP_MARK_LABEL', '}')
  const honestBtnOk = (blk) =>
    /pending:\s*'导出本机备份并发一封通知邮件'/.test(blk) && !blk.includes('云端')
  check(
    honestBtnOk(markTable(EXTRA)),
    '🔴 A19 ② 那颗按钮的名字 = `BACKUP_MARK_LABEL.pending`，**逐字**是「导出本机备份并发一封通知邮件」，而且四档文案里**一个"云端"都没有**（它不上传任何文件：只导本机明文 JSON + 发一封通知邮件）',
    `pending 逐字在=${/pending:\s*'导出本机备份并发一封通知邮件'/.test(markTable(EXTRA))} · 四档里出现"云端"=${markTable(EXTRA).includes('云端')}`,
  )
  {
    /* 🧪 反向对照 A：把 `pending` 那一档换回旧名「备份到云端」（内存副本）⇒ 同一条判据当场假 */
    const old = oneEdit(EXTRA, "pending: '导出本机备份并发一封通知邮件'", "pending: '备份到云端'")
    check(
      old.ok && !honestBtnOk(markTable(old.text)),
      '🧪 A19 ② 反向对照 A：把 `pending` 那一档换回旧名「备份到云端」（**内存副本**）⇒ 同一条判据当场判假',
      `目标出现 ${old.n} 处（须恰好 1）· 换回旧名之后判据=${honestBtnOk(markTable(old.text))}`,
    )
  }
  const noCloudOk = (s) => !s.includes('备份到云端')
  check(
    noCloudOk(ADMIN) && noCloudOk(EXTRA),
    '🔴 A19 ② 「备份到云端」这个名字在**这两份源码的真代码里**一处都不剩（注释里那句历史说明不算 —— 已经被剥掉）',
    `Admin.tsx=${ADMIN.includes('备份到云端')} · BackupExtraActions.tsx=${EXTRA.includes('备份到云端')}`,
  )
  {
    /* 🧪 反向对照 B：往副本里塞回一颗叫「备份到云端」的按钮 ⇒ 同一条判据当场假 */
    const injected = oneEdit(
      EXTRA,
      '<div className="flex flex-col gap-2">',
      '<Button block>备份到云端</Button>\n<div className="flex flex-col gap-2">',
    )
    check(
      injected.ok && !noCloudOk(injected.text),
      '🧪 A19 ② 反向对照 B：往副本里塞回一颗叫「备份到云端」的按钮 ⇒ 同一条判据当场判假（证明它扫的是真代码）',
      `目标出现 ${injected.n} 处（须恰好 1）· 塞回旧名之后判据=${noCloudOk(injected.text)}`,
    )
  }

  /* ---------------- ③ 那一整块**只有一份实现** ---------------- */
  const oneImplOk = (s) =>
    (s.match(/<BackupExtraActions\s*\/>/g) ?? []).length === 1 &&
    (s.match(/components\/BackupExtraActions'/g) ?? []).length === 1
  check(
    oneImplOk(ADMIN),
    '🔴 A19 ③ 那一整块在面板里**只摆一次**（`<BackupExtraActions />` 1 处 · import 1 处）—— 用户口径：搬进来，**不许写第二份**',
    `用到=${(ADMIN.match(/<BackupExtraActions\s*\/>/g) ?? []).length} 处 · import=${(ADMIN.match(/components\/BackupExtraActions'/g) ?? []).length} 处`,
  )
  {
    /* 🧪 反向对照：把那一块**再摆一份**（内存副本）⇒ "只有一份"当场假 */
    const twice = oneEdit(ADMIN, '<BackupExtraActions />', '<BackupExtraActions />\n<BackupExtraActions />')
    check(
      twice.ok && !oneImplOk(twice.text),
      '🧪 A19 ③ 反向对照：把 `<BackupExtraActions />` **再摆一份**（内存副本）⇒ 同一条判据当场判假',
      `目标出现 ${twice.n} 处（须恰好 1）· 副本里用到 ${(twice.text.match(/<BackupExtraActions\s*\/>/g) ?? []).length} 处`,
    )
  }

  /* ---------------- ④ ③ 卡那段源码里 0 个输入控件 ---------------- */
  const G2_REGION = region(ADMIN, 'title="③ 备份（G2）"', '</Card>')
  /** 区间里不许有输入控件；`<Card` 计数必须为 0（= 区间边界切对了，没多切进下一张卡） */
  const noControlsOk = (r) =>
    r.length > 0 &&
    (r.match(/<Card\b/g) ?? []).length === 0 &&
    !/<\s*(input|textarea|select)\b/.test(r) &&
    !/type="file"/.test(r)
  check(
    noControlsOk(G2_REGION),
    '🔴 A19 ④ ③ 卡那段源码里**一个输入控件都没有**（`<input` / `<textarea` / `<select` / `type="file"` 全 0）—— 整库口令（`BACKUP_ENCRYPTION_PASSPHRASE`）与档案私钥都留在超管手上，面板只读状态',
    `区间 ${G2_REGION.length} 字符 · 区间里还有 \`<Card\`=${(G2_REGION.match(/<Card\b/g) ?? []).length} 处（该 0）`,
  )
  {
    /* 🧪 反向对照：往那段区间里塞一个密码框（内存副本）⇒ 同一条判据当场假 */
    const withBox = oneEdit(
      G2_REGION,
      '<SubHead>本机导出与通知（全平台那一层）</SubHead>',
      '<SubHead>本机导出与通知（全平台那一层）</SubHead>\n<input type="password" placeholder="整库口令" />',
    )
    check(
      withBox.ok && !noControlsOk(withBox.text),
      '🧪 A19 ④ 反向对照：往 ③ 卡那段区间里塞一个密码框（**内存副本**）⇒ 同一条判据当场判假（证明那段区间真的在判、不是恒真）',
      `目标出现 ${withBox.n} 处（须恰好 1）· 塞进去之后判据=${noControlsOk(withBox.text)}`,
    )
  }

  /* ---------------- ⑤ ⑥ 卡：私钥输入框**全仓唯一**，且卡里没有把它带出去的路 ---------------- */
  /** 全仓 `src/` 扫一遍（"别处一律不许"必须全仓扫，只看面板那一份是不够的） */
  const walkSrc = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkSrc(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  /**
   * 🔴 私钥输入口的**机器可读标记**：`BEGIN PRIVATE KEY`（就是那个 textarea 的占位符开头）。
   *    别拿 `type="password"` 当标记 —— 全仓有 6 处正经的**账号密码**框（登录 / 改密码 /
   *    维护口令），它们不是这一条要管的东西；这一条管的是"备份 / 解密用的钥匙"。
   */
  const KEY_PLACE = /BEGIN PRIVATE KEY/
  const keyPlaceFiles = (entries) => entries.filter((e) => KEY_PLACE.test(e.code)).map((e) => e.rel)
  const entries = walkSrc(join(APP, 'src')).map((f) => ({
    rel: f.slice(APP.length + 1).replace(/\\/g, '/'),
    code: strip(readFileSync(f, 'utf8')),
  }))
  const onlyKeyPlaceOk = (list) => list.length === 1 && list[0] === 'src/pages/Admin.tsx'
  check(
    onlyKeyPlaceOk(keyPlaceFiles(entries)),
    '🔴 A19 ⑤ 全仓 `src/` 里出现**私钥输入标记**（`BEGIN PRIVATE KEY`）的文件**只有 `src/pages/Admin.tsx` 一份** —— 用户口径：只许在 ⑥ 那一张卡里收私钥，别处一律不许',
    `扫了 ${entries.length} 份 · 命中 ${keyPlaceFiles(entries).length} 份：${keyPlaceFiles(entries).join(' · ') || '（无）'}`,
  )
  {
    /*
     * 🧪 反向对照：往**同一批 entries** 里塞一份"别处也抄了一个私钥口"的副本
     *    ⇒ **同一个扫描函数**当场多出一份（照 S22 ① 那两条对照的写法：喂坏数据，不另写口径）。
     */
    const dup = [...entries, { rel: 'src/lib/backup.ts', code: "<textarea placeholder={'-----BEGIN PRIVATE KEY-----'} />" }]
    check(
      !onlyKeyPlaceOk(keyPlaceFiles(dup)),
      '🧪 A19 ⑤ 反向对照 A：往同一批 entries 里塞一份"别处也抄了私钥口"（内存副本）⇒ 同一个扫描函数当场多出一份、判据判假（证明"全仓只有一份"真的在数）',
      `塞进去之后命中 ${keyPlaceFiles(dup).length} 份：${keyPlaceFiles(dup).join(' · ')}`,
    )
  }
  const SEAL_REGION = region(ADMIN, 'function SealDecryptCard()', 'function PanelLogin(')
  const sealCardOk = (s, r) =>
    r.length > 0 &&
    r.includes('openAdminSealed') &&
    (r.match(/BEGIN PRIVATE KEY/g) ?? []).length === 1 &&
    (s.match(/BEGIN PRIVATE KEY/g) ?? []).length === 1 &&
    !/\bfetch\s*\(|postApi\s*\(|apiUrl\s*\(|supabase|localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest/.test(r)
  check(
    sealCardOk(ADMIN, SEAL_REGION),
    '🔴 A19 ⑤ ⑥ 卡**自己**也守得住：私钥输入框就在这张卡里（全文件只此 1 处）、解的是 `openAdminSealed`，而卡里**没有任何把它带出去的调用**（没有 `fetch(` / `postApi(` / `apiUrl(` / `supabase` / `localStorage` / `indexedDB` …）',
    `区间 ${SEAL_REGION.length} 字符 · BEGIN PRIVATE KEY（卡内/全文件）=${(SEAL_REGION.match(/BEGIN PRIVATE KEY/g) ?? []).length}/${(ADMIN.match(/BEGIN PRIVATE KEY/g) ?? []).length} · 带出去的调用=${/\bfetch\s*\(|postApi\s*\(|apiUrl\s*\(|supabase|localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest/.test(SEAL_REGION)}`,
  )
  {
    /* 🧪 反向对照 B：往那张卡的副本里塞一句"把私钥 POST 出去" ⇒ 同一条判据当场假 */
    const leaky = oneEdit(
      SEAL_REGION,
      'await openAdminSealed(doc, pem)',
      "await fetch('/api/leak', { method: 'POST', body: pem })\n      await openAdminSealed(doc, pem)",
    )
    check(
      leaky.ok && !sealCardOk(leaky.text, leaky.text),
      '🧪 A19 ⑤ 反向对照 B：往那张卡的副本里塞一句 `fetch(\'/api/leak\', { body: pem })` ⇒ 同一条判据当场判假（证明"钥匙不外送"真的在被判）',
      `目标出现 ${leaky.n} 处（须恰好 1）· 塞进去之后判据=${sealCardOk(leaky.text, leaky.text)}`,
    )
  }
  /**
   * 🔴 ⑤b 解钥匙的那份实现是**纯前端 WebCrypto**：整份 `lib/backupCrypto.ts` 里
   *    一个网络 / 存储调用都没有 ⇒ 私钥那条路只有内存（与 ⑥ 卡上那句话对上）。
   */
  const cryptoPureOk = (s) =>
    s.includes('globalThis.crypto') &&
    s.includes('openAdminSealed') &&
    !/\bfetch\s*\(|postApi\s*\(|apiUrl\s*\(|supabase|localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest/.test(s)
  check(
    cryptoPureOk(CRYPTO),
    '🔴 A19 ⑤b `lib/backupCrypto.ts` 整份里**没有任何网络 / 存储调用**（`openAdminSealed` 走 `globalThis.crypto`，纯 WebCrypto）—— 私钥只在那一次解密的内存里过一遍',
    `globalThis.crypto=${CRYPTO.includes('globalThis.crypto')} · openAdminSealed=${CRYPTO.includes('openAdminSealed')} · 网络/存储调用=${/\bfetch\s*\(|postApi\s*\(|apiUrl\s*\(|supabase|localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest/.test(CRYPTO)}`,
  )
  {
    /* 🧪 反向对照：往 `backupCrypto.ts` 副本里塞一句 `fetch(` ⇒ 同一条判据当场假 */
    const wired = oneEdit(
      CRYPTO,
      'export async function openAdminSealed(',
      "await fetch('/api/sealed')\nexport async function openAdminSealed(",
    )
    check(
      wired.ok && !cryptoPureOk(wired.text),
      '🧪 A19 ⑤b 反向对照：往 `lib/backupCrypto.ts` 副本里塞一句 `fetch(` ⇒ 同一条判据当场判假（"纯前端"这件事真的被判着）',
      `目标出现 ${wired.n} 处（须恰好 1）· 塞进去之后判据=${cryptoPureOk(wired.text)}`,
    )
  }

  /* ---------------- ⑥ `lib/backup.ts` 的兜底文案如实 ---------------- */
  const fallbackOk = (s) => s.includes('导出完成，但通知邮件没能发出') && !s.includes('没能存到云端')
  check(
    fallbackOk(BACKUP),
    '🔴 A19 ⑥ `lib/backup.ts` 的兜底文案如实：**导出已经完成**、失败的只有那封通知邮件（旧文案「备份通知没能存到云端」把一次"信没发出去"说成了一次不存在的上传 —— 与改名的口径不一致）',
    `新文案在=${BACKUP.includes('导出完成，但通知邮件没能发出')} · 旧文案还在=${BACKUP.includes('没能存到云端')}`,
  )
  {
    /* 🧪 反向对照：把那一句换回旧文案（内存副本）⇒ 同一条判据当场假 */
    const old = oneEdit(BACKUP, '导出完成，但通知邮件没能发出', '备份通知没能存到云端')
    check(
      old.ok && !fallbackOk(old.text),
      '🧪 A19 ⑥ 反向对照：把那一句换回「备份通知没能存到云端」（**内存副本**）⇒ 同一条判据当场判假',
      `目标出现 ${old.n} 处（须恰好 1）· 换回去之后判据=${fallbackOk(old.text)}`,
    )
  }
}

/* ============================================================
   第二十四节之二 · A20：推迟某一节课的**提醒**（2026-10-04，施工单-日程延后.md）
   ------------------------------------------------------------
   🔴 这一节要钉的是"**推迟只挪提醒，不挪课表**"那件事的三条：
     ① 判据本身：`dueRemindersWithSnooze` 与原 `dueReminders` **同一个窗口**，
        推迟过的那几条只认推迟时刻 —— 两处口径不同会在两个时刻各响一次；
     ② 落库那侧写的是**新表** `schedule_snoozes`，一个字都不碰 `schedule_items`
        （推迟污染每周重复的课表 = 偷偷改课表）；
     ③ 真值源只有**一份**（store）—— 提醒的定时器与界面按钮都读写它。

   ⚠️ 判据一律**先剥注释**：这一批的"为什么"大量正当写在注释里
      （尤其 ② 那段"不是改课表"）—— 不剥的话"源码里写了那句话"恒绿。
      反向对照 B 专门治这个：把那句话挪进注释，同一个判据必须假。
   ============================================================ */
section('第二十四节之二 · A20：推迟某一节课的**提醒**（不挪课表）')

{
  /** 剥注释（照 A19 那一节的写法）—— 判据只许看**真代码** */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')

  /* ⚠️ `_SCHED`（不是 `SCHED`）：A18 那一节已经有一个 `SCHED` 在用，这一节只是留着备查 ⇒
     声明未使用会被 `oxlint` 的 no-unused-vars 抓到（仓库的线是 0 warnings ✗）。 */
  const _SCHED = strip(readApp('src/lib/schedule.ts'))
  const BTN = strip(readApp('src/components/SnoozeButton.tsx'))
  const STORE = strip(readApp('src/data/store.ts'))
  const REMOTE = strip(readApp('src/data/remote.ts'))
  const HOOK = strip(readApp('src/hooks/useScheduleReminder.ts'))
  // ⚠️ `schema.sql` 在**仓库根**不在 app/ 下 —— 走 `readRepo` 而不是 `readApp`
//    （用 readApp 会 ENOENT，而那是在第 6816 行抛的、看起来像"我的判据炸了"）
const SQL = readRepo('supabase/schema.sql')

  /* ---------------- ① 纯函数：推迟时刻换判，且窗口与原来同一个 ---------------- */
  /** 把那几个纯函数原样抠出来求值（剥类型那套路照 A18，不另抄一份） */
  const loadS = (mutate = (_b, _must) => {}) => {
    const raw = readApp('src/lib/schedule.ts')
    const from = raw.indexOf('export function toMinutes')
    const to = raw.lastIndexOf('}')
    const blocks = []
    for (const re of [
      // ⚠️ 这三个是**依赖**，不是被测对象：`dueRemindersWithSnooze` 体内用了
      //    `nowMinutes` / `itemsForDate`，不抠进来求值就 `ReferenceError`
      //    （报出来看不出"是我少抠了依赖"）。
      /^export function nowMinutes[\s\S]*?^\}/gm,
      /^export function weekdayOf[\s\S]*?^\}/gm,
      /^export function itemsOfDay[\s\S]*?^\}/gm,
      /^export function itemsForDate[\s\S]*?^\}/gm,
      /^export function toMinutes[\s\S]*?^\}/gm,
      /^export const REMIND_BEFORE[^\n]*\n/gm,
      // ⚠️ 这三个函数里，**参数类型与返回类型要一并抠到** ——
      //    `dueRemindersWithSnooze` 的签名跨行（参数各占一行），
      //    而 `snoozeMinuteOf` / `snoozeText` 是单行但带返回类型。
      //    抠不到返回类型 ⇒ `new Function` 求值时把它当成了别的语法，
      //    报出来是 `is not a function`，**看不出是抠漏了**（锚点自证就是防这个）。
      /^export function dueRemindersWithSnooze\([\s\S]*?\n\):[^{]*\{[\s\S]*?^\}/gm,
      /^export function snoozeMinuteOf[^{]*\{[\s\S]*?^\}/gm,
      /^export function snoozeText[^{]*\{[\s\S]*?^\}/gm,
    ]) {
      const m = raw.slice(from, to + 1).match(re)
      if (m) for (const x of m) blocks.push(x)
    }
    const need = ['toMinutes', 'REMIND_BEFORE', 'dueRemindersWithSnooze', 'snoozeMinuteOf', 'snoozeText']
    const missing = need.filter((k) => !blocks.some((b) => b.includes(k)))
    if (missing.length) throw new Error(`抠漏了 ${missing.join('/')}`)
    let body = blocks.join('\n').replace(/^import .*$/gm, '')
    /*
     * 剥签名上的类型 —— **逐行**处理，因为签名可能跨多行
     * （`dueRemindersWithSnooze` 三个参数各占一行）。
     *
     * 🔴🔴 这一段坏过**四次**，四次报出来的错都指不到真因：
     *   ① `[^{\n]*` —— 不容许类型里换行 ⇒ 一个都匹配不上（报「那不是个函数」）；
     *   ② `[\s\S]*?` —— 一路跨到**下一个函数**的 `{`；
     *   ③ `[^{]*?` —— `\(` 匹配到**体内**的 `(`（`split(':')` 那个），
     *      从 `toMinutes` 就一路吞到下一处 `)`；
     *   ④ 只改 `export function`、漏了 `export const` ⇒ 函数体里留下 `export`
     *      （报 `Unexpected token 'export'`）。
     * ✅ 现在按行扫：见到 `function 名字(` 就把签名**整段**收进来（可能跨行），
     *    参数名取每个逗号段冒号**之前**那半，输出成单行签名。
     *    —— 不靠正则猜边界，所以上面四种坏法都不会再出现。
     */
    {
      const out = []
      for (let i = 0; i < body.split('\n').length; i++) {
        const line = body.split('\n')[i]
        const fn = /^(\s*)export function (\w+)\s*\(/.exec(line)
        if (!fn) {
          out.push(line)
          continue
        }
        let sig = line
        while (!/\)\s*:?[^\n]*\{\s*$/.test(sig) && i + 1 < body.split('\n').length) {
          i++
          sig += '\n' + body.split('\n')[i]
        }
        // ⚠️🔴 收参数区**不能**用 `lastIndexOf(')')` ——
        //   `d = new Date()` 里那个 `)` 在**默认值之后**，取到它就把参数区切得**过了头**
        //   （第五次坏法：`Readonly<Record<string, number>>` 的 `<>` 被切出来留在原地，
        //   求值报 `Unexpected token '>>'` —— 又一个指不到真因的错）。
        // ✅ 按**括号配平**收：从 `(` 起，每遇 `(` 加一、每遇 `)` 减一，回到 0 那个才是收尾。
        let open = sig.indexOf('(')
        let depth = 0
        let close = -1
        // ⚠️ 尖括号也要算进去（第六次坏法）：`Readonly<Record<string, number>>`
        //   里的 `>` 会让"见到 `)` 就收尾"的判断**提前触发** ——
        //   不成对计 `>` 的话参数区被切成 `schedule, snoozed, number>>`，
        //   求值报 `Unexpected token '>>'`（还是指不到真因）。
        let angle = 0
        for (let k = open; k < sig.length; k++) {
          const c = sig[k]
          if (c === '<') angle++
          else if (c === '>') angle--
          else if (c === '(' && angle === 0) depth++
          else if (c === ')' && angle === 0) {
            depth--
            if (depth === 0) {
              close = k
              break
            }
          }
        }
        if (close < 0) throw new Error(`抠 ${fn[2]} 的参数区失败（括号不配平）`)
        // 🔴 参数区**不能**用 `split(',')` —— 泛型里有逗号：
        //   `Readonly<Record<string, number>>` 会被切成 `Readonly<Record<string` /
        //   ` number>>` 两段 ⇒ 拼回去还是 `>>`，求值报 `Unexpected token '>>'`（第七次坏法）。
        // ✅ 按**顶层逗号**切：`<`、`(`、`[` 里的逗号不算。
        const rawParams = sig.slice(open + 1, close)
        const parts = []
        let buf = ''
        let nest = 0
        for (const c of rawParams) {
          if (c === '<' || c === '(' || c === '[' || c === '{') nest++
          else if (c === '>' || c === ')' || c === ']' || c === '}') nest--
          if (c === ',' && nest === 0) {
            parts.push(buf)
            buf = ''
            continue
          }
          buf += c
        }
        parts.push(buf)
        const params = parts.map((one) => one.split(':')[0].trim()).filter(Boolean)
        out.push(`${fn[1]}export function ${fn[2]}(${params.join(', ')}) {`)
      }
      body = out.join('\n')
    }
      // 局部变量的类型注解（`const out: DayGap[] = []`）
      body = body.replace(/(:\s*(?:readonly\s+)?[A-Za-z_$][\w$[\]]*(?:\[\])*(?:\s*\|\s*[A-Za-z_$][\w$[\]]*(?:\[\])*)*)\s*(?==)/g, '')
    // ⚠️ `export` 的统一剥离**必须排在上面那个逐行改写之后**：
    //    那个改写只处理 `export function`，`export const REMIND_BEFORE` 那行还带着
    //    export ⇒ `new Function` 的函数体里 export 是语法错误
    //    （报出来是 `Unexpected token 'export'`，看不出是剥漏了）。
    body = body.replace(/^(\s*)export\s+/gm, '$1').replace(/\sas\s+const/g, '')
    const mustReplaceOnce = (needle, replacement) => {
      const n = body.split(needle).length - 1
      if (n !== 1) throw new Error(`变异目标出现 ${n} 处（必须恰好 1 处）：${JSON.stringify(needle.slice(0, 50))}`)
      body = body.replace(needle, replacement)
    }
    mutate(body, mustReplaceOnce)
    // eslint-disable-next-line no-new-func
    return new Function(`${body}
return { toMinutes, REMIND_BEFORE, dueRemindersWithSnooze, snoozeMinuteOf, snoozeText };`)()
  }

  const it = (id, start, end) => ({ id, weekday: 1, start, end, title: `T${id}`, kind: 'class', notify: true, scope: 'mine' })

  let S = {}
  let sErr = ''
  try {
    S = loadS()
  } catch (e) {
    sErr = e instanceof Error ? e.message : String(e)
  }
  check(
    !sErr && typeof S.dueRemindersWithSnooze === 'function' && typeof S.snoozeMinuteOf === 'function',
    'A20 锚点自证：抠出来的**就是**那几个纯函数（否则下面全是空转）',
    sErr ? `求值失败：${sErr}` : `typeof = ${typeof S.dueRemindersWithSnooze}/${typeof S.snoozeMinuteOf}`,
  )

  // 08:00 的课 ⇒ 原提醒在 07:50（课前 10 分钟）
  const day = [it('a', '08:00', '08:45')]
  const at = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number)
    const d = new Date(2026, 0, 5, h, m)
    return d
  }
  {
    const d = at('07:50')
    check(
      S.dueRemindersWithSnooze(day, {}, d).map((x) => x.id).join() === 'a',
      'A20 ① 没推迟过的那条：课前 10 分钟（07:50）照常进窗口',
      `实测 ${JSON.stringify(S.dueRemindersWithSnooze(day, {}, d).map((x) => x.id))}`,
    )
    // 推迟到 08:00 ⇒ 07:50 **不该**再响（否则两个时刻各响一次）
    const moved = { a: 480 }
    check(
      S.dueRemindersWithSnooze(day, moved, d).length === 0 &&
        S.dueRemindersWithSnooze(day, moved, at('08:00')).map((x) => x.id).join() === 'a',
      'A20 ① 推迟到 08:00 ⇒ 原时刻 07:50 **不再响**、只在新时刻 08:00 响（同一个窗口，不多不少）',
      `07:50 得到 ${S.dueRemindersWithSnooze(day, moved, d).length} 条 · 08:00 得到 ${JSON.stringify(S.dueRemindersWithSnooze(day, moved, at('08:00')).map((x) => x.id))}`,
    )
    // 推迟到已经过去的分钟 ⇒ 今天不再响（不能让一条过期的推迟把课永远卡住）
    const past = { a: 400 } // 06:40，早过了
    check(
      S.dueRemindersWithSnooze(day, past, d).length === 0 && S.dueRemindersWithSnooze(day, past, at('23:00')).length === 0,
      'A20 ① 推迟到**已经过去**的分钟 ⇒ 今天一整天都不响它（否则那条记录会把课永久卡住）',
      `07:50 得到 ${S.dueRemindersWithSnooze(day, past, d).length} 条 · 23:00 得到 ${S.dueRemindersWithSnooze(day, past, at('23:00')).length} 条`,
    )
  }
  {
    // 累加语义：10:00 → 10:10 → 10:20，不是"永远 10:10"
    const base = S.snoozeMinuteOf('08:00', undefined, 10)
    const twice = S.snoozeMinuteOf('08:00', base, 10)
    check(
      base === 480 && twice === 490,
      'A20 ① 「晚 N 分钟」是**累加**：08:00 那节课的提醒 07:50→08:00→08:10（不是"永远 08:00"）',
      `首次 ${base} · 再晚一次 ${twice}`,
    )
    /*
     * 🔴 只钉**上界**，因为下界在真实路径上**触发不了**：
     *   `current` 永远是合法分钟数（非负）、基点也是非负，`+ delayMinutes` 又只增
     *   ⇒ `Math.max(0, …)` 那半边在正常路径上恒等于原值。
     *   我前两版分别拿 `00:10` 晚 10 / 晚 200 去撞下界，两次都没撞到
     *   ⇒ 那是一条**恒绿却没在判任何东西**的断言（假绿，§三.2 那一类）。
     *   ⇒ 现在只钉上界：23:55 那节课晚 200 分钟 = 1635，不钳位会被库的
     *      `check (remind_minute between 0 and 1440)` 挡下 ⇒ 按钮"点了没反应"。
     */
    const late = S.snoozeMinuteOf('23:55', undefined, 200)
    check(
      late === 1440,
      'A20 ① 结果**钳在 1440 以内**（23:55 那节课再晚 200 分钟 = 1635，不钳位会被库的 check 挡下 ⇒ 按钮"点了没反应"）',
      `实测 ${late}（期望 1440）`,
    )
    // 下界钳位仍**保留**在源码里（防的是"将来有人允许负的 current"），但这里不断言它 ——
    // 断言一个触发不了的分支，就是拿一条恒绿的断言占位。
    check(
      /Math\.max\(0,\s*Math\.min\(1440,/.test(strip(readApp('src/lib/schedule.ts'))),
      'A20 ① 两道钳位**都在源码里**（下界那半边当前触发不了，但它挡的是"将来有人传个负值过来"）',
      `实测 ${/Math\.max\(0,\s*Math\.min\(1440,/.test(strip(readApp('src/lib/schedule.ts')))}`,
    )
  }
  /* 反向对照①：把"只认推迟时刻"那行去掉 ⇒ 07:50 那条立刻又回来（证明那两行真在判） */
  {
    let B = {}
    let err = ''
    try {
      B = loadS((_b, must) => must('const moved = snoozed[it.id]', 'const moved = undefined'))
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    check(err === '', '🧪 A20 ① 反向对照：变异目标**恰好一处**（注释里那份不算）', err ? `抛错：${err}` : '变异成功')
    check(
      B.dueRemindersWithSnooze?.(day, { a: 480 }, at('07:50')).map((x) => x.id).join() === 'a',
      '🧪 A20 ① 反向对照：让推迟**不起作用** ⇒ 推迟过的那条在原时刻 07:50 又响了（证明"只认推迟时刻"真在判）',
      `实测 ${JSON.stringify(B.dueRemindersWithSnooze?.(day, { a: 480 }, at('07:50')).map((x) => x.id))}（期望 a，即"两个时刻都响"的坏状态）`,
    )
  }

  /* ---------------- ② 推迟只挪提醒，不挪课表 ---------------- */
  check(
    /from\('schedule_snoozes'\)/.test(REMOTE) && !/from\('schedule_items'\)[\s\S]{0,120}snooze/.test(REMOTE),
    'A20 ② 推迟那侧写的是 **`schedule_snoozes`**，一个字都没碰 `schedule_items`（推迟污染每周重复的课表 = 偷偷改课表）',
    `写到 schedule_snoozes=${/from\('schedule_snoozes'\)/.test(REMOTE)} · 有没有去写 schedule_items=${/from\('schedule_items'\)[\s\S]{0,120}snooze/.test(REMOTE)}`,
  )
  check(
    /unique\s*\(\s*teacher_id\s*,\s*on_date\s*,\s*schedule_item_id\s*\)/.test(SQL),
    'A20 ② 表上一条 **unique(teacher_id, on_date, schedule_item_id)** —— 连点两次「晚 10 分」在原来那条上累加，不会摆出两个推迟时刻',
    `实测 ${/unique\s*\(\s*teacher_id\s*,\s*on_date\s*,\s*schedule_item_id\s*\)/.test(SQL)}`,
  )
  check(
    /alter table schedule_snoozes enable row level security/i.test(SQL) && /create policy schedule_snoozes_own/i.test(SQL),
    'A20 ② 🔴 `enable row level security` **和** `create policy` 都在 —— 少了前一句，策略一条也不生效（PostgREST 直接放行全表，而这表**看着**有策略）',
    `enable=${/alter table schedule_snoozes enable row level security/i.test(SQL)} · policy=${/create policy schedule_snoozes_own/i.test(SQL)}`,
  )
  check(
    /not is_classroom_account\(\)/.test(strip(SQL)) && /on_date\s+date/.test(SQL),
    'A20 ② RLS 与 `schedule_mine_write` 同一条理由**不许教室端账号**；`on_date` 是 **date** 而不是 weekday（用 weekday 就变成"每周三都晚 10 分"，那是改课表）',
    `排除教室端=${/not is_classroom_account\(\)/.test(strip(SQL))} · on_date 是 date=${/on_date\s+date/.test(SQL)}`,
  )
  /* 反向对照②：把 enable 那一行删掉（副本）⇒ 第 ③ 条立刻失据 */
  {
    const noEnable = SQL.replace(/alter table schedule_snoozes enable row level security;?/i, '/* 忘了 */')
    check(
      noEnable !== SQL && !/alter table schedule_snoozes enable row level security/i.test(noEnable),
      '🧪 A20 ② 反向对照：把那一句**删掉**（副本）⇒"两条都在"当场假（证明这一句真在判，不是摆设）',
      `副本真的被改过=${noEnable !== SQL}`,
    )
  }

  /* ---------------- ③ 真值源只有一份 ---------------- */
  /* ⚠️ 同一个道理：这一行原来叫 `storeReads`，但下面的 check 是直接对 `HOOK` 做正则判的
     ⇒ 它没被用到 ⇒ 会被 no-unused-vars 抓（改成 `_` 前缀保留"这里数过一次"这个信息）。 */
  const _storeReads = (HOOK.match(/scheduleSnoozes/g) ?? []).length
  check(
    /useStore\(\(s\) => s\.scheduleSnoozes\)/.test(HOOK),
    'A20 ③ 提醒侧（定时器）读的是 **store 那一份**，不是组件自己的 useState',
    `实测 ${/useStore\(\(s\) => s\.scheduleSnoozes\)/.test(HOOK)}`,
  )
  check(
    /useState<Record<string, number>>/.test(HOOK) === false,
    'A20 ③ 那一侧**没有**第二份 useState（两份就是"按钮显示已推迟、提醒照旧响"）',
    `仍有 useState<Record<string, number>> = ${/useState<Record<string, number>>/.test(HOOK)}`,
  )
  check(
    /\[schedule, classes, push, snoozes\]/.test(HOOK),
    'A20 ③ 定时器那个 effect 的依赖里**带上 `snoozes`** —— 漏了它就会"点了晚 10 分钟，下一次 tick 仍按课前 10 分钟判"',
    `实测 ${/\[schedule, classes, push, snoozes\]/.test(HOOK)}`,
  )
  check(
    /scheduleSnoozes: \{\} as Record<string, number>/.test(STORE),
    'A20 ③ store 里两个初值都在（演示模式 + 后端模式）—— `persist` 反序列化出来的老缓存里没这一条，`undefined` 会读成"报错"而不是"没推迟"',
    `实测 ${/scheduleSnoozes: \{\} as Record<string, number>/.test(STORE)}（出现 ${(STORE.match(/scheduleSnoozes: \{\} as Record<string, number>/g) ?? []).length} 处）`,
  )
  /* 反向对照③：把依赖里的 snoozes 去掉 ⇒ 第 ③ 条立刻假 */
  {
    const noDep = HOOK.replace('[schedule, classes, push, snoozes]', '[schedule, classes, push]')
    check(
      noDep !== HOOK && !/\[schedule, classes, push, snoozes\]/.test(noDep),
      '🧪 A20 ③ 反向对照：把 `snoozes` 从依赖里去掉（副本）⇒ 上面那条当场假（证明它在读真源码）',
      `副本真的被改过=${noDep !== HOOK}`,
    )
  }

  /* ---------------- ④ 老库没那张表 / 落库失败 ---------------- */
  check(
    /ensureSnoozeTable/.test(BTN) && /return null/.test(BTN),
    'A20 ④ 老库没那张表时按钮**收起**（不是点了报错），而且 `notify:false` 的课也不摆 —— 没提醒可推迟',
    `探表=${/ensureSnoozeTable/.test(BTN)} · notify 判据=${/if \(!notify\) return null/.test(BTN)}`,
  )
  check(
    /if \(!sb\) return true/.test(REMOTE) && /return true \/\/ 探不到 ≠ 没有/.test(readApp('src/data/remote.ts')),
    'A20 ④ 探表判据**只认"表不在"**，网络抖动按"在"处理（否则一次网抖就骗用户说"这功能没有"）',
    `实测 ${/if \(!sb\) return true/.test(REMOTE)}`,
  )
  check(
    /set\(\{ scheduleSnoozes: prev \}\)/.test(STORE) && /throw e/.test(STORE),
    'A20 ④ 落库失败**把内存改回去并抛错** —— 不报错但就是不对（按钮说推迟成功、库里没有、明天没人提醒）',
    `改回去=${/set\(\{ scheduleSnoozes: prev \}\)/.test(STORE)} · 抛出=${/throw e/.test(STORE)}`,
  )
  /* 反向对照④：把「改回去」那一行去掉 ⇒ 内存与库就此永久不一致 */
  {
    const noRollback = STORE.replace('set({ scheduleSnoozes: prev })', '/* 忘了改回去 */')
    check(
      noRollback !== STORE && !/set\(\{ scheduleSnoozes: prev \}\)/.test(noRollback),
      '🧪 A20 ④ 反向对照：落库失败时**不**改回去（副本）⇒ 上面那条当场假（证明那一行真在判）',
      `副本真的被改过=${noRollback !== STORE}`,
    )
  }
}

/* ============================================================
   第二十六节 · A21：应用内更新 ——「下载完调起系统安装器」（2026-10-05 施工单 §八）
   ------------------------------------------------------------
   用户报的：手机上点更新公告里的「下载最新版」，**浏览器下载完就完了** ——
   老师还得自己去「文件管理」里翻出那个 apk 才装得上。
   ⇒ 教师端 apk 要：manifest 加 `REQUEST_INSTALL_PACKAGES`（不加永远弹不出安装界面）+
   FileProvider（Android 7+ 只能给 content 地址）、原生方法 `downloadAndInstall`
   （下到应用私有目录 → 起系统安装界面）、桥接层按现有约定暴露它；
   网页侧 `components/ReleaseGate.tsx` **能拿到就走壳、拿不到就保持现在的行为**
   （那颗 `<a href target="_blank">` 照旧 ⇒ 网页版与两个 exe 一个字都不变）。

   🔴 三条**物理边界**（这一节不假装能验它们）：
     · Android 不许静默安装（除非设备管理员/系统应用）⇒ 最多弹到系统安装界面，老师仍要点两下；
     · Android 8+ 要用户对这个来源单独授权「安装未知应用」⇒ 没授权时原生回
       `needPermission:true`，网页侧说一句人话 + 引导去系统设置（**不许静默**）；
     · 🔴 **真机未验** —— 本机没有安卓设备，这一节全是**静态**判据。
       真机验收只能由用户做（见本节末尾那条"怎么验"）。

   ⚠️ 壳那一侧不在本仓库（隔壁打包工程），所以照 `shots.mjs:8634` 的先例钉**绝对路径**。
      🔴 **2026-10-05 改（CI 红）：那里不是"找不到就是红"** —— 打包工程**不在这个公开仓库里**，
      CI 的干净检出**必然**没有它，那句"红"于是成了**一条不可能在 CI 变绿的卡**（本机恒绿、
      CI 恒红：`0f45438` / `d8d1e98` 两次）。现在按三态办：**壳那一侧（①–⑦）落灰**
      （写明原因、不红不绿），**app 侧（⑧–⑪，只读 `app/` 下的文件）照旧逐条判**；
      本机（打包工程在）那个开关**永远不开** ⇒ 一条判据都不变。节末另有一条自证可红。
   ============================================================ */
section('第二十六节 · A21：应用内更新（下载完调起安装器）—— manifest / FileProvider / 原生方法 / 网页退回分支')

{
  /** 剥注释（照 A19/A20 的写法）—— 判据只许看**真代码**（注释里写"不许用某个东西"不算命中） */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  /** XML 的注释是 `<!-- -->`（与 JS 那种块注释写法不同）⇒ 单独剥一层；文件路径那一类判据两层都剥 */
  const stripXml = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '')
  const stripAll = (s) => strip(stripXml(s))

  /** 🔴 反向对照的前置：目标串必须**恰好出现一次**再替换（`AGENTS.md` §三.2） */
  const once = (t, s) => t.split(s).length - 1
  const oneEdit = (t, from, to) =>
    once(t, from) === 1 ? { ok: true, n: 1, text: t.replace(from, to) } : { ok: false, n: once(t, from), text: t }

  /* ---------------- 读壳那一侧（本仓库之外） ---------------- */
  const PACK = 'C:\\Users\\Administrator\\Desktop\\树高教务通打包'
  const MANIFEST_REL = '_src/android/app/src/main/AndroidManifest.xml'
  const PATHS_REL = '_src/android/app/src/main/res/xml/file_paths.xml'
  const PLUGIN_REL = '_src/android/app/src/main/java/com/shugao/jiaowu/YlxbNativePlugin.java'
  const BRIDGE_REL = '_src/shell-bridge-apk.js'
  const JAVA_DIR = join(PACK, '_src/android/app/src/main/java/com/shugao/jiaowu')
  const shellRead = (rel) => {
    const p = join(PACK, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const missing = [MANIFEST_REL, PATHS_REL, PLUGIN_REL, BRIDGE_REL].filter((r) => !existsSync(join(PACK, r)))
  /*
   * 🔴 三态（2026-10-05 修 CI 红）：打包工程**不在这个公开仓库里** ⇒ CI 的干净检出**必然**
   *    没有它。原来那句「找不到就是红」于是成了**一条不可能在 CI 变绿的卡**（本机恒绿、
   *    CI 恒红 —— `0f45438` / `d8d1e98` 两次就是这么红的）。
   *    ⇒ 壳那一侧（①–⑦，读的全是 `PACK` 下的文件）**落灰**：写明原因、不红不绿；
   *      **app 侧（⑧–⑪，只读 `app/` 下的文件 —— CI 里也有）照旧逐条判**。
   */
  const SHELL_HERE = existsSync(PACK)
  const g0 = grayed
  const j0 = passed + failures.length
  if (!SHELL_HERE) {
    console.log(
      `  ⏭ A21 ①–⑦ 壳那一侧**落灰**：打包工程 ${PACK} 不在（它不进这个公开仓库，CI 的干净检出必然没有）—— 不是"坏了"`,
    )
    shellGray = true
  }
  check(
    missing.length === 0,
    'A21 ① 壳那四个源文件找得到（打包工程 `树高教务通打包`）',
    missing.length ? `缺 ${missing.length} 个：${missing.join(' · ')}` : `都在 ${PACK}`,
    '（壳不在 ⇒ 本条与②–⑦落灰；壳在 ⇒ 缺文件仍是红：判据读的是空串，那正是"门禁自己也要能红"）',
  )

  const MANIFEST = stripXml(shellRead(MANIFEST_REL))
  const PATHS = stripXml(shellRead(PATHS_REL))
  const PLUGIN = strip(shellRead(PLUGIN_REL))
  const BRIDGE = strip(shellRead(BRIDGE_REL))
  const FILEOUT = strip(readApp('src/lib/fileOut.ts'))
  const GATE = strip(readApp('src/components/ReleaseGate.tsx'))

  /* ---------------- ② manifest：权限 + FileProvider 四件套 ---------------- */
  const PERM_RE = /<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"\s*\/>/
  check(
    PERM_RE.test(MANIFEST),
    '🔴 A21 ② manifest 里有 `REQUEST_INSTALL_PACKAGES`（**不加这一条，系统安装界面永远弹不出来**）',
    PERM_RE.test(MANIFEST) ? '在' : '不在',
  )
  {
    /* 🧪 反向对照：把那一行删掉 ⇒ ② 当场红 */
    const cut = oneEdit(MANIFEST, '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />', '')
    check(
      cut.ok && !PERM_RE.test(cut.text),
      '🧪 A21 ② 反向对照：把 `REQUEST_INSTALL_PACKAGES` 那一行删掉（内存副本）⇒ ② 当场红（证明它真的在数那一行，不是恒真）',
      `目标出现 ${cut.n} 处（须恰好 1）· 删掉后判据=${PERM_RE.test(cut.text)}`,
    )
  }

  /** FileProvider 四件套（少任何一件，`getUriForFile` 都会在手机上炸 / 或者压根没配上） */
  const FP_FACTS = [
    'androidx.core.content.FileProvider',
    'android:authorities="${applicationId}.fileprovider"',
    'android:grantUriPermissions="true"',
    'android:name="android.support.FILE_PROVIDER_PATHS"',
    'android:resource="@xml/file_paths"',
  ]
  const fpOk = (s) => FP_FACTS.every((x) => s.includes(x))
  check(
    fpOk(MANIFEST),
    '🔴 A21 ② manifest 里 FileProvider 四件套齐（`androidx.core.content.FileProvider` · authorities = `${applicationId}.fileprovider` · `grantUriPermissions` · `FILE_PROVIDER_PATHS` → `@xml/file_paths`）',
    FP_FACTS.map((x) => `${MANIFEST.includes(x) ? '✔' : '✖'}${x}`).join(' · '),
  )
  {
    /* 🧪 反向对照：把 `grantUriPermissions` 翻成 false ⇒ 同一条判据当场红 */
    const cut = oneEdit(MANIFEST, 'android:grantUriPermissions="true"', 'android:grantUriPermissions="false"')
    check(
      cut.ok && !fpOk(cut.text),
      '🧪 A21 ② 反向对照：把 `grantUriPermissions` 翻成 `"false"`（副本）⇒ 四件套那一条当场红（少一件就传不出 content 地址）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${fpOk(cut.text)}`,
    )
  }

  /* ---------------- ③ file_paths.xml：下载目录必须**配过** ---------------- */
  const PATHS_RE = /<files-path name="update_apk" path="updates\/" \/>/
  const JAVA_DIR_RE = /new File\(ctx\.getFilesDir\(\), "updates"\)/
  check(
    PATHS_RE.test(PATHS) && JAVA_DIR_RE.test(PLUGIN),
    '🔴 A21 ③ `file_paths.xml` 给**下载目录**配了一条 `files-path`，而且与原生落盘的那个目录**是同一个**（少这一条 = `Failed to find configured root`，安装界面弹不出来）',
    `file_paths 里那一条=${PATHS_RE.test(PATHS)} · 原生落在 filesDir/updates=${JAVA_DIR_RE.test(PLUGIN)}`,
  )
  {
    /* 🧪 反向对照：把那条 files-path 删掉 ⇒ ③ 当场红 */
    const cut = oneEdit(PATHS, '<files-path name="update_apk" path="updates/" />', '')
    check(
      cut.ok && !PATHS_RE.test(cut.text),
      '🧪 A21 ③ 反向对照：把那条 `files-path` 删掉（副本）⇒ ③ 当场红（证明它真的在读那份 xml，不是恒真）',
      `目标出现 ${cut.n} 处（须恰好 1）· 删掉后判据=${PATHS_RE.test(cut.text)}`,
    )
  }

  /* ---------------- ④ 原生方法：下载 → FileProvider → 系统安装界面 ---------------- */
  const METHOD_RE = /@PluginMethod\s+public void downloadAndInstall\(PluginCall call\)/
  check(
    METHOD_RE.test(PLUGIN) && /@CapacitorPlugin\(name = "ShugaoNative"\)/.test(PLUGIN),
    '🔴 A21 ④ 原生插件里有 `@PluginMethod downloadAndInstall(PluginCall)`（挂在 `@CapacitorPlugin(name = "ShugaoNative")` 上 —— 桥接层按这个名字调）',
    `方法在=${METHOD_RE.test(PLUGIN)} · 插件名对=${/@CapacitorPlugin\(name = "ShugaoNative"\)/.test(PLUGIN)}`,
  )
  const URI_RE = /FileProvider\.getUriForFile\(ctx, ctx\.getPackageName\(\) \+ "\.fileprovider", apk\)/
  check(
    URI_RE.test(PLUGIN),
    '🔴 A21 ④ 交给系统安装器的是 **FileProvider 的 content 地址**，authorities 与 manifest 那一条拼法一致（不许把文件路径直接给系统）',
    `实测 ${URI_RE.test(PLUGIN)}`,
  )
  {
    /* 🧪 反向对照：换成"直接给文件路径"那种坏法 ⇒ 同一条判据当场红 */
    const cut = oneEdit(PLUGIN, 'FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk)', 'Uri.fromFile(apk)')
    check(
      cut.ok && !URI_RE.test(cut.text) && /Uri\.fromFile\(apk\)/.test(cut.text),
      '🧪 A21 ④ 反向对照：把 `FileProvider.getUriForFile(...)` 换成 `Uri.fromFile(apk)`（= 那个坏法）⇒ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${URI_RE.test(cut.text)}`,
    )
  }
  const INTENT_RE = /new Intent\(Intent\.ACTION_VIEW\)/
  check(
    INTENT_RE.test(PLUGIN) &&
      /setDataAndType\(uri, "application\/vnd\.android\.package-archive"\)/.test(PLUGIN) &&
      /FLAG_GRANT_READ_URI_PERMISSION/.test(PLUGIN),
    '🔴 A21 ④ 起的是安装意图：`ACTION_VIEW` + MIME `application/vnd.android.package-archive` + `FLAG_GRANT_READ_URI_PERMISSION`（少了最后那个标志，安装器读不到那个 content 地址）',
    `ACTION_VIEW=${INTENT_RE.test(PLUGIN)} · MIME=${/setDataAndType\(uri, "application\/vnd\.android\.package-archive"\)/.test(PLUGIN)} · 授权标志=${/FLAG_GRANT_READ_URI_PERMISSION/.test(PLUGIN)}`,
  )
  check(
    /https:\/\//.test(shellRead(PLUGIN_REL)) && /!url\.startsWith\("https:\/\/"\)/.test(PLUGIN),
    'A21 ④ 原生侧也只收 `https` 地址（与 `lib/release.ts` 的安全口径同源，`http:` / 别的都当场回绝）',
    `实测 ${/!url\.startsWith\("https:\/\/"\)/.test(PLUGIN)}`,
  )

  /* ---------------- ⑤ 没授权 ≠ 静默：如实回 needPermission + 引导去设置 ---------------- */
  check(
    /canRequestPackageInstalls\(\)/.test(PLUGIN) && /\.put\("needPermission", true\)/.test(PLUGIN),
    '🔴 A21 ⑤ Android 8+ 没授权时**如实回** `needPermission: true`（不许假装在装、也不许静默失败）',
    `查权限=${/canRequestPackageInstalls\(\)/.test(PLUGIN)} · 回 needPermission=${/\.put\("needPermission", true\)/.test(PLUGIN)}`,
  )
  {
    /* 🧪 反向对照：把权限那一问删掉 ⇒ ⑤ 当场红（那正是"没授权也照样往下走"的坏法） */
    const cut = oneEdit(PLUGIN, '!getContext().getPackageManager().canRequestPackageInstalls()', 'false')
    check(
      cut.ok && !/canRequestPackageInstalls\(\)/.test(cut.text),
      '🧪 A21 ⑤ 反向对照：把 `canRequestPackageInstalls()` 那一问拿掉（副本）⇒ ⑤ 当场红（没授权也会往下走 = 静默失败）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${/canRequestPackageInstalls\(\)/.test(cut.text)}`,
    )
  }
  const SETTINGS_RE = /Settings\.ACTION_MANAGE_UNKNOWN_APP_SOURCES/
  check(
    SETTINGS_RE.test(PLUGIN) && /public void openInstallPermissionSettings\(PluginCall call\)/.test(PLUGIN),
    '🔴 A21 ⑤ 没授权时**有**引导去系统设置那条路（`ACTION_MANAGE_UNKNOWN_APP_SOURCES` + 插件方法 `openInstallPermissionSettings`，跳不过去就退到应用详情页）',
    `设置页=${SETTINGS_RE.test(PLUGIN)} · 方法在=${/public void openInstallPermissionSettings\(PluginCall call\)/.test(PLUGIN)}`,
  )
  {
    /* 🧪 反向对照：把设置页那一段删掉 ⇒ ⑤ 那条当场红 */
    const cut = oneEdit(PLUGIN, 'Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES', 'Settings.ACTION_SETTINGS')
    check(
      cut.ok && !SETTINGS_RE.test(cut.text),
      '🧪 A21 ⑤ 反向对照：把 `ACTION_MANAGE_UNKNOWN_APP_SOURCES` 换成随便一个设置页（副本）⇒ 当场红（引导必须落到**那一页**，否则老师找不到开关）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${SETTINGS_RE.test(cut.text)}`,
    )
  }

  /* ---------------- ⑥ 桥接层：按现有约定接到 `window.__shell_out` ---------------- */
  const BR_RE = /downloadAndInstall: function \(url\) \{/
  check(
    BR_RE.test(BRIDGE) && /N\.downloadAndInstall\(\{ url:/.test(BRIDGE),
    '🔴 A21 ⑥ 桥接层（`_src/shell-bridge-apk.js`）把 `downloadAndInstall` 接到 `ShugaoNative` 上（与 `notify` 同一个口；老壳没有这个方法就回 `unsupported`）',
    `挂了方法=${BR_RE.test(BRIDGE)} · 真的转给原生=${/N\.downloadAndInstall\(\{ url:/.test(BRIDGE)}`,
  )
  check(
    /openInstallPermissionSettings: function \(\) \{/.test(BRIDGE) && /N\.openInstallPermissionSettings\(\)/.test(BRIDGE),
    'A21 ⑥ 桥接层也放了 `openInstallPermissionSettings`（没授权时网页侧要引导去设置，这条得能通到原生）',
    `挂了方法=${/openInstallPermissionSettings: function \(\) \{/.test(BRIDGE)} · 转给原生=${/N\.openInstallPermissionSettings\(\)/.test(BRIDGE)}`,
  )
  {
    /* 🧪 反向对照：把桥接那一行删掉 ⇒ ⑥ 当场红 */
    const cut = oneEdit(BRIDGE, 'downloadAndInstall: function (url) {', 'downloadAndInstallRenamed: function (url) {')
    check(
      cut.ok && !BR_RE.test(cut.text),
      '🧪 A21 ⑥ 反向对照：把桥接那个方法**改名**（副本）⇒ ⑥ 当场红 —— 名字是两侧约定，改了原生就白写',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${BR_RE.test(cut.text)}`,
    )
  }

  /* ---------------- ⑦ `file://` 零命中（Android 7+ 给系统文件路径 = 当场炸） ---------------- */
  const javaFiles = existsSync(JAVA_DIR) ? readdirSync(JAVA_DIR).filter((f) => f.endsWith('.java')) : []
  const shellScanned = [
    ['AndroidManifest.xml', shellRead(MANIFEST_REL)],
    ['file_paths.xml', shellRead(PATHS_REL)],
    ...javaFiles.map((f) => [f, readFileSync(join(JAVA_DIR, f), 'utf8')]),
    ['shell-bridge-apk.js', shellRead(BRIDGE_REL)],
  ]
  const fileHits = shellScanned.filter(([, t]) => /file:\/\//.test(stripAll(t))).map(([n]) => n)
  check(
    fileHits.length === 0,
    `🔴 A21 ⑦ 壳侧**一个「file 路径地址」都没有**（Android 7+ 把文件路径交给系统会当场 \`FileUriExposedException\`，装不上）—— 扫了 ${shellScanned.length} 份`,
    fileHits.length ? `命中：${fileHits.join(' · ')}` : '零命中',
  )
  {
    /* 🧪 反向对照：往 manifest 副本里塞一个 `file://` ⇒ 同一条判据当场红 */
    const poisoned = `${MANIFEST}\n<data android:host="file://x" />`
    check(
      /file:\/\//.test(stripAll(poisoned)),
      '🧪 A21 ⑦ 反向对照：往 manifest 副本里塞一句含 `file://` 的东西 ⇒ 同一条判据当场红（证明它真在扫，不是"什么都搜不到"）',
      `副本命中=${/file:\/\//.test(stripAll(poisoned))}`,
    )
  }

  /*
   * ⛔ 壳那一侧到此为止 —— 下面 ⑧–⑪ 判的全是 **`app/` 下的文件**
   *    （CI 的检出里**也有**，本来就能验）⇒ 它们**一条都不许灰**。
   *    ✅ 2026-10-05（逐节收口那一轮）：这里**必须**把窗口关上 —— 本节 ⑧–⑪ 与
   *      ①–⑦ 在**同一个 `section()`** 里，`section()` 的自动收口要等到**下一节**才生效，
   *      那时候 ⑧–⑪ 已经被罩成灰了 ✗（实测：删掉这一句，CI 形态下 A21 自证当场红，
   *      `app 侧灰了 13 条`）。
   *    ⚠️ 别指望"A21 走的是手工 `shellGray = true`，`shellSide()` 的 `finally` 会复原" ——
   *      本节的壳侧**不是**用 `shellSide()` 包的（那是 A22/A24 的写法）。
   */
  const shellJudged = passed + failures.length - j0
  shellGray = false
  const g1 = grayed

  /* ---------------- ⑧ 网页侧：能拿到走壳 · 拿不到保持现在的行为 ---------------- */
  const CAN_RE = /export function canDownloadAndInstall\(\): boolean \{/
  check(
    CAN_RE.test(FILEOUT) && /typeof shell\(\)\?\.downloadAndInstall === 'function'/.test(FILEOUT),
    '🔴 A21 ⑧ 适配层（`src/lib/fileOut.ts`）有 `canDownloadAndInstall()`，判据是"**桥接对象上这个方法在不在**"（不是"有没有 Capacitor"）',
    `函数在=${CAN_RE.test(FILEOUT)} · 判据=${/typeof shell\(\)\?\.downloadAndInstall === 'function'/.test(FILEOUT)}`,
  )
  const WRAP_RE = /export async function downloadAndInstall\(url: string\): Promise<ShellInstallResult> \{/
  const UNSUP_RE = /if \(!s\?\.downloadAndInstall\) return \{ ok: false, unsupported: true \}/
  check(
    WRAP_RE.test(FILEOUT) && UNSUP_RE.test(FILEOUT),
    'A21 ⑧ `downloadAndInstall()` 拿不到桥接时回 `unsupported`（**不许假装成功** —— 那正是"点了没反应"的来源）',
    `封装在=${WRAP_RE.test(FILEOUT)} · 没桥接时如实回=${UNSUP_RE.test(FILEOUT)}`,
  )
  {
    /* 🧪 反向对照：把"没桥接就如实回"那一句删掉 ⇒ 同一条判据当场红 */
    const cut = oneEdit(FILEOUT, "if (!s?.downloadAndInstall) return { ok: false, unsupported: true }", '')
    check(
      cut.ok && !UNSUP_RE.test(cut.text),
      '🧪 A21 ⑧ 反向对照：把"拿不到桥接就如实回 unsupported"那一句删掉（副本）⇒ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 删掉后判据=${UNSUP_RE.test(cut.text)}`,
    )
  }

  /* ---------------- ⑨ ReleaseGate：调它 **而且**有退回分支 ---------------- */
  const GATE_IMPORT_RE = /import \{[^}]*canDownloadAndInstall[^}]*\} from '\.\.\/lib\/fileOut'/
  const FALLBACK_RE = /if \(!canDownloadAndInstall\(\)\) return/
  check(
    GATE_IMPORT_RE.test(GATE) && FALLBACK_RE.test(GATE),
    '🔴 A21 ⑨ 公告那颗「下载最新版」**调**这个适配层，而且**第一句就是退回分支**：拿不到桥接立刻 return ⇒ 还是原来那颗 `<a href target="_blank">`（网页版与两个 exe 一个字不变）',
    `从适配层取=${GATE_IMPORT_RE.test(GATE)} · 退回分支=${FALLBACK_RE.test(GATE)}`,
  )
  {
    /* 🧪 反向对照：把退回分支那一句删掉 ⇒ ⑨ 当场红（那样 apk 以外也会被 preventDefault 拦住 = 网页版行为被改） */
    const cut = oneEdit(GATE, 'if (!canDownloadAndInstall()) return', '')
    check(
      cut.ok && !FALLBACK_RE.test(cut.text),
      '🧪 A21 ⑨ 反向对照：把退回分支那一句删掉（副本）⇒ ⑨ 当场红 —— 证明"网页版与两个 exe 不变"这件事真的被钉着',
      `目标出现 ${cut.n} 处（须恰好 1）· 删掉后判据=${FALLBACK_RE.test(cut.text)}`,
    )
  }
  check(
    /e\.preventDefault\(\)/.test(GATE) && /const r = await downloadAndInstall\(view\.url\)/.test(GATE),
    'A21 ⑨ 走壳那条路是"先拦住默认跳转、再等壳回话"（**顺序反了**就等于既走壳又开浏览器）',
    `拦住默认跳转=${/e\.preventDefault\(\)/.test(GATE)} · 调适配层=${/const r = await downloadAndInstall\(view\.url\)/.test(GATE)}`,
  )
  check(
    /if \(r\.needPermission\) \{[\s\S]{0,200}setInstallHint\(INSTALL_HINT_PERM\)[\s\S]{0,200}await openInstallPermissionSettings\(\)/.test(GATE),
    '🔴 A21 ⑨ 没授权那一支：**说一句人话**（上屏）+ 引导去系统设置（§三.5：不可写的路径要显式报错，不许静默）',
    `实测 ${/if \(r\.needPermission\) \{[\s\S]{0,200}setInstallHint\(INSTALL_HINT_PERM\)[\s\S]{0,200}await openInstallPermissionSettings\(\)/.test(GATE)}`,
  )
  check(
    /fallbackClick\.current = true[\s\S]{0,200}downloadAnchor\.current\?\.click\(\)/.test(GATE),
    'A21 ⑨ 别的失败那一支：**退回当前行为**（把那个 https 链接交给浏览器）并且明说已经退了（`已改用浏览器下载。`）',
    `实测 ${/fallbackClick\.current = true[\s\S]{0,200}downloadAnchor\.current\?\.click\(\)/.test(GATE)}`,
  )
  {
    /*
     * 🧪 反向对照：把"退回浏览器"那一支**整段**换掉（改成什么都不做）⇒ 上面那条当场红。
     *    这正是施工单点名的坏法：「点了没反应」。
     */
    const click = 'downloadAnchor.current?.click()'
    const cut = oneEdit(GATE, click, 'void 0')
    check(
      cut.ok && !/downloadAnchor\.current\?\.click\(\)/.test(cut.text),
      '🧪 A21 ⑨ 反向对照：把"退回浏览器"那一次点击换成 `void 0`（副本）⇒ 当场红（那就是"点了没反应"的坏法）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${/downloadAnchor\.current\?\.click\(\)/.test(cut.text)}`,
    )
  }
  /* 🔒 退回分支本身就是**原来那颗 `<a>`**：href / target / rel 一个字没改（施工单 §六 的安全口径） */
  const ANCHOR_FACTS = ['href={view.url}', 'target="_blank"', 'rel="noreferrer"', 'data-release-download']
  check(
    ANCHOR_FACTS.every((x) => GATE.includes(x)),
    'A21 ⑨ 退回分支 = 原来那颗 `<a href={view.url} target="_blank" rel="noreferrer" data-release-download>`（四个属性一个都没动，只多挂了一个 onClick）',
    ANCHOR_FACTS.map((x) => `${GATE.includes(x) ? '✔' : '✖'}${x}`).join(' · '),
  )

  /* ---------------- ⑩ 桥接只在白名单的三个适配层里出现 ---------------- */
  const walkTs = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walkTs(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const BRIDGE_FILES = ['src/lib/classroomShell.ts', 'src/lib/fileOut.ts', 'src/lib/notify.ts']
  const srcEntries = walkTs(join(APP, 'src')).map((f) => ({
    rel: f.slice(APP.length + 1).replace(/\\/g, '/'),
    text: readFileSync(f, 'utf8'),
  }))
  const bridgeReaders = (entries) => entries.filter((e) => /__shell_out/.test(strip(e.text))).map((e) => e.rel)
  eqSet(
    '🔴 A21 ⑩ 全仓 `src/` 里读 `window.__shell_out` 的文件 ↔ 白名单（`_tools/preflight.mjs:114` 那三个适配层；多一个文件就红 —— 剥注释之后数）',
    bridgeReaders(srcEntries),
    BRIDGE_FILES,
  )
  {
    /* 🧪 反向对照：往一个**非白名单**文件里塞一句 ⇒ 同一个集合当场多一项 */
    const poisoned = srcEntries.map((e) =>
      e.rel === 'src/lib/apiBase.ts' ? { ...e, text: `${e.text}\nconst _peek = window.__shell_out\n` } : e,
    )
    const got = bridgeReaders(poisoned)
    check(
      got.length === BRIDGE_FILES.length + 1 && got.includes('src/lib/apiBase.ts'),
      '🧪 A21 ⑩ 反向对照：往 `src/lib/apiBase.ts` 里塞一句 `window.__shell_out`（内存副本）⇒ 白名单集合当场多出它（证明这一条真在数文件，不是恒真）',
      `改完 ${got.length} 份：${got.join(' · ')}`,
    )
  }

  /*
   * ✅ **怎么真机验**（本机没有安卓设备 ⇒ 这一节全是静态判据，**没有一条**是真机验过的）：
   *    ① 出一版新 apk（`_tools/package-all.mjs`）装到老师手机上；
   *    ② 进 /admin 的「版本更新」卡把版本号抬高一点并发布 ⇒ 手机上弹更新公告；
   *    ③ 点「下载最新版」：先弹系统"允许来自此来源的应用"（第一次）⇒ 回来再点一次
   *       ⇒ 应弹出**系统安装界面**（而不是只下载完就没动静）；
   *    ④ 反向：在系统设置里把那个开关关掉，再点 ⇒ 屏上应出现那句人话并跳到设置页（不许没反应）。
   */
  {
    /*
     * 🔴 这一条**故意用原始文本（不剥注释）**：上面每一条判据都必须剥注释（"注释里写不许用 X"不算），
     *    而"照实写着真机未验"这件事**只能**在注释里 —— 两种口径各用各的文本，别混。
     */
    /*
     * app 侧那两份**永远**要查（CI 的检出里也有）；壳侧两份只在打包工程真的在的那台机器上一起查
     * —— 三态：量不到的那半个输入不许红、也不许假装绿，但**量得到的半个照旧逐条判**。
     */
    const APP_SIDES = [
      ['src/lib/fileOut.ts', readApp('src/lib/fileOut.ts')],
      ['src/components/ReleaseGate.tsx', readApp('src/components/ReleaseGate.tsx')],
    ]
    const SHELL_SIDES = [
      ['YlxbNativePlugin.java', shellRead(PLUGIN_REL)],
      ['shell-bridge-apk.js', shellRead(BRIDGE_REL)],
    ]
    const RAW_SIDES = SHELL_HERE ? [...SHELL_SIDES, ...APP_SIDES] : APP_SIDES
    const said = RAW_SIDES.filter(([, t]) => /真机未验/.test(t)).map(([n]) => n)
    const silent = RAW_SIDES.filter(([, t]) => !/真机未验/.test(t)).map(([n]) => n)
    check(
      silent.length === 0,
      `🔴 A21 ⑪ ${SHELL_HERE ? '两侧四份' : 'app 侧那两份（壳侧两份本机没有 ⇒ 一并查不了）'}源码的**注释**里都照实写着"真机未验"（本机没有安卓设备，别假装验过）`,
      silent.length ? `没写：${silent.join(' · ')}｜写了：${said.join(' · ')}` : `${RAW_SIDES.length} 份都写了：${said.join(' · ')}`,
    )
    /*
     * 🔴 **节末自证（可红）**：壳不在时"壳那一侧（①–⑦）**一条都没判**"（全落灰），
     *    而 app 侧（⑧–⑪）**一条都没灰** ⇒ 谁忘了把"允许落灰"打开/关掉，这条当场红。
     * ⚠️ 断言前**强制关掉那个开关**：否则"忘了关"这件事会把**这条自证自己也罩成灰**
     *    ⇒ 变成一条静默的"假灰"（2026-10-05 实测踩到，已改）。
     * ⚠️ 这句**保留、不换成"依赖 `section()` 自动收口"**：本节 ⑧–⑪ 就在同一个
     *    `section()` 里，自动收口要到**下一节**才生效，那时候已经晚了 ✗ ——
     *    本节内要真判，就必须**本节内**先把开关关上。
     */
    shellGray = false
    check(
      (SHELL_HERE || shellJudged === 0) && grayed - g1 === 0,
      '🔴 A21 自证（三态）：壳不在时壳那一侧（①–⑦）**一条都没判**（全落灰），app 侧（⑧–⑪）**一条都没灰** —— 忘关/忘开那个开关，这条当场红',
      `壳在=${SHELL_HERE} · 壳侧真的判了 ${shellJudged} 条 · 壳侧灰了 ${g1 - g0} 条 · app 侧灰了 ${grayed - g1} 条`,
    )
  }
}

/* ============================================================
   第二十七节 · A22：到点提醒**交给系统排程**（2026-10-05 真机反馈）
   ------------------------------------------------------------
   用户（真安卓手机、`树高教务通-教师端-v1.1.2-vc32.apk`）报的原话：
     「我从浏览器下载后它自动安装了，然后**通知权限确认时界面跳转正常**，
       但是**我收不到通知**」
   ⇒ 症状：**装上了、权限那一步走通了，通知一条都没有**。

   🔴 查清的链（每一步都有 `文件:行`，本机没有安卓设备 ⇒ 全是静态判据）：
     · 权限那一步是 **Capacitor 的本地通知插件**弹的
       （`shell-bridge-apk.js` 的 `notify()` → `LN.checkPermissions()` / `requestPermissions()`）
       —— 它成功只证明**能发**，不证明**有人去发**；
     · 真正在"到点"那一下做决定的，是应用里那个 **`setInterval(60s)`**
       （`useScheduleReminder.ts` 的 tick）⇒ 应用一退后台 / 锁屏 / 被杀，
       WebView 定时器冻结 ⇒ **提醒整条静默消失**；
     · 而原生侧**三天前就写好了**（`YlxbNativePlugin.scheduleAlarms` → `YlxbAlarms`
       的 `setExactAndAllowWhileIdle` + `YlxbAlarmReceiver` 发通知 + `YlxbBootReceiver` 开机重排），
       manifest 也声明了 `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` / `POST_NOTIFICATIONS`
       —— **断的只是"桥接层一个口都没暴露"**（全仓 grep `scheduleAlarms` 只命中 Java 自己）。

   ⚠️ 这一节**不改**网页版行为、**不装**新插件、**不动** apk 构建配置：
      用的全是已经打进 vc32 里的原生能力。
   🔴 **真机未验**（本机没有安卓设备）—— 怎么验见本节末尾。
   ============================================================ */
section('第二十七节 · A22：到点提醒交给系统排程（桥接层 / 原生闹钟 / 网页侧三条都对上）')

{
  /** 剥注释（照 A21 的写法）—— 判据只许看**真代码** */
  const strip2 = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const stripXml2 = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '')
  const once2 = (t, s) => t.split(s).length - 1
  const oneEdit2 = (t, from, to) =>
    once2(t, from) === 1 ? { ok: true, n: 1, text: t.replace(from, to) } : { ok: false, n: once2(t, from), text: t }

  const PACK2 = 'C:\\Users\\Administrator\\Desktop\\树高教务通打包'
  const BRIDGE2_REL = '_src/shell-bridge-apk.js'
  const PLUGIN2_REL = '_src/android/app/src/main/java/com/shugao/jiaowu/YlxbNativePlugin.java'
  const ALARMS_REL = '_src/android/app/src/main/java/com/shugao/jiaowu/YlxbAlarms.java'
  const RECV_REL = '_src/android/app/src/main/java/com/shugao/jiaowu/YlxbAlarmReceiver.java'
  const BOOT_REL = '_src/android/app/src/main/java/com/shugao/jiaowu/YlxbBootReceiver.java'
  const MANIFEST2_REL = '_src/android/app/src/main/AndroidManifest.xml'
  const shellRead2 = (rel) => {
    const p = join(PACK2, rel)
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }
  const MUST = [BRIDGE2_REL, PLUGIN2_REL, ALARMS_REL, RECV_REL, BOOT_REL, MANIFEST2_REL]
  const missing2 = MUST.filter((r) => !existsSync(join(PACK2, r)))
  /*
   * 🔴 三态（与 A21 同一条理由，2026-10-05 修 CI 红）：打包工程**不在这个公开仓库里**
   *    ⇒ CI 的干净检出**必然**没有它 ⇒「找不到就是红」在 CI 上恒红（本地恒绿）。
   *    ⇒ 壳那一侧（①–④，读的全是 `PACK2` 下的文件）**落灰**；
   *      **app 侧（⑤–⑧，只读 `app/` 下 —— CI 里也有）照旧逐条判**。
   */
  const SHELL_HERE2 = existsSync(PACK2)
  const g0b = grayed
  const j0b = passed + failures.length
  if (!SHELL_HERE2) {
    console.log(
      `  ⏭ A22 ①–④ 壳那一侧**落灰**：打包工程 ${PACK2} 不在（它不进这个公开仓库，CI 的干净检出必然没有）—— 不是"坏了"`,
    )
    shellGray = true
  }
  check(
    missing2.length === 0,
    'A22 ① 壳那六份源文件找得到（打包工程 `树高教务通打包`）',
    missing2.length ? `缺 ${missing2.length} 个：${missing2.join(' · ')}` : `都在 ${PACK2}`,
    '（壳不在 ⇒ 本条与②–④落灰；壳在 ⇒ 缺文件仍是红：判据读的是空串，那正是"门禁自己也要能红"）',
  )

  const BRIDGE2 = strip2(shellRead2(BRIDGE2_REL))
  const PLUGIN2 = strip2(shellRead2(PLUGIN2_REL))
  const ALARMS = strip2(shellRead2(ALARMS_REL))
  const RECV = strip2(shellRead2(RECV_REL))
  const MANIFEST2 = stripXml2(shellRead2(MANIFEST2_REL))
  const NOTIFY = strip2(readApp('src/lib/notify.ts'))
  const HOOK = strip2(readApp('src/hooks/useScheduleReminder.ts'))
  /**
   * 🔴 `Schedule.tsx`（⑫ 要判的那块黄条就在这一页）—— 同样**剥注释**：
   *   块注释里写着"不许说这个设备收不到系统通知"，不剥就会把**注释**当成命中
   *   （§三.2 那个"改的是注释、判据纹丝不动"的坑）。
   */
  const SCHEDULE = strip2(readApp('src/pages/Schedule.tsx'))

  /* ---------------- ② 桥接层：把 `scheduleAlarms` 接到 `ShugaoNative` 上 ---------------- */
  const BR_SCHED = /scheduleAlarms: function \(alarms\) \{/
  check(
    BR_SCHED.test(BRIDGE2) && /N\.scheduleAlarms\(\{ alarms: list \}\)/.test(BRIDGE2),
    '🔴 A22 ② 桥接层（`_src/shell-bridge-apk.js`）把 `scheduleAlarms` 接到 `ShugaoNative` 上 —— **这一条空了三天**，就是"收不到通知"的根因（原生写好了、网页侧无从调用）',
    `挂了方法=${BR_SCHED.test(BRIDGE2)} · 真的转给原生=${/N\.scheduleAlarms\(\{ alarms: list \}\)/.test(BRIDGE2)}`,
  )
  {
    /* 🧪 反向对照：把桥接那个方法**改名** ⇒ ② 当场红 —— 名字是两侧的约定，改了原生就白写 */
    const cut = oneEdit2(BRIDGE2, 'scheduleAlarms: function (alarms) {', 'scheduleAlarmsRenamed: function (alarms) {')
    check(
      cut.ok && !BR_SCHED.test(cut.text),
      '🧪 A22 ② 反向对照：把桥接那个方法**改名**（副本）⇒ ② 当场红（证明它真的在数那个名字，不是恒真）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${BR_SCHED.test(cut.text)}`,
    )
  }
  check(
    /var ID_PERIOD = 2000000000/.test(BRIDGE2) &&
      /return \(Date\.now\(\) % ID_PERIOD\) \+ 1/.test(BRIDGE2) &&
      ID_PERIOD_OK(),
    '🔴 A22 ② 桥接层的即时通知 id **写明了一个 31 位周期**（`ID_PERIOD = 2000000000` < `Integer.MAX_VALUE` = 2147483647）—— 原生 `LocalNotification.java:227-231` 对越界的 id 是当场 `reject`，而这一层把它 `catch` 成 `false`（界面只看到页内兜底，系统通知一条都没有）',
    `周期常量=${/var ID_PERIOD = 2000000000/.test(BRIDGE2)} · 取模式=${/return \(Date\.now\(\) % ID_PERIOD\) \+ 1/.test(BRIDGE2)} · 上界 < 2^31=${ID_PERIOD_OK()}`,
  )
  function ID_PERIOD_OK() {
    const m = BRIDGE2.match(/var ID_PERIOD = (\d+)/)
    return !!m && Number(m[1]) > 0 && Number(m[1]) + 1 <= 2147483647
  }
  {
    /* 🧪 反向对照：把周期改成超过 int 的那个值 ⇒ 上界判据当场假 */
    const cut = oneEdit2(BRIDGE2, 'var ID_PERIOD = 2000000000', 'var ID_PERIOD = 3000000000')
    const okAfter = (() => {
      const m = cut.text.match(/var ID_PERIOD = (\d+)/)
      return !!m && Number(m[1]) + 1 <= 2147483647
    })()
    check(
      cut.ok && !okAfter,
      '🧪 A22 ② 反向对照：把 `ID_PERIOD` 改成 `3000000000`（= 会越界的那种坏法，副本）⇒ 上面那条上界判据当场假（证明它真在算，不是恒真）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完上界合法=${okAfter}`,
    )
  }

  /* ---------------- ③ 原生：精确闹钟 + 到点发通知 + 开机重排 ---------------- */
  const JAVA_SCHED = /public void scheduleAlarms\(PluginCall call\)/
  check(
    JAVA_SCHED.test(PLUGIN2) && /YlxbAlarms\.scheduleAll\(getContext\(\), list\)/.test(PLUGIN2),
    '🔴 A22 ③ 原生插件里有 `@PluginMethod scheduleAlarms(PluginCall)` 且真的转给 `YlxbAlarms.scheduleAll`（桥接层按这个名字调）',
    `方法在=${JAVA_SCHED.test(PLUGIN2)} · 转给调度核心=${/YlxbAlarms\.scheduleAll\(getContext\(\), list\)/.test(PLUGIN2)}`,
  )
  check(
    /am\.setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(ALARMS) &&
      /am\.setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(ALARMS),
    '🔴 A22 ③ 调度核心用的是**系统闹钟**（`setExactAndAllowWhileIdle`；拿不到精确授权时退化成 `setAndAllowWhileIdle` —— 仍然会响，只是不那么准）：这是"应用关着也能响"的**唯一**来源',
    `精确=${/am\.setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(ALARMS)} · 退化档=${/am\.setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(ALARMS)}`,
  )
  {
    /* 🧪 反向对照：把精确那一句换成"页内定时器"根本做不到的写法（`set`）⇒ 判据当场红 */
    const cut = oneEdit2(ALARMS, 'am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, fireAt, pi)', 'am.set(AlarmManager.RTC, fireAt, pi)')
    check(
      cut.ok && !/am\.setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(cut.text),
      '🧪 A22 ③ 反向对照：把精确闹钟那一句换成 `am.set(...)`（副本）⇒ 上面那条当场红（证明它读的是**那一个**调用）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${/am\.setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, fireAt, pi\)/.test(cut.text)}`,
    )
  }
  check(
    /nm\.notify\(id, b\.build\(\)\)/.test(RECV) &&
      /MainActivity\.isForeground\(\)/.test(RECV) &&
      /intent\.getIntExtra\("id", 0\)/.test(RECV) &&
      /intent\.getStringExtra\("title"\)/.test(RECV) &&
      /*
       * 🔴 2026-10-05 真机第四轮：那句"应用在前台就不重复打扰"**留着**（前台由即时那条路负责），
       *   但**自检那条必须能绕开它** —— 否则点完盯着屏看 = 早退 = 什么都没发生，
       *   而自检会把它报成"接收器没到"（**假红**）。
       *   ⇒ 判据从"有没有那个早退"升级成"早退在、而且带一档只给自检的旁路"。
       */
      /boolean selfCheck = intent\.getBooleanExtra\(EXTRA_SELF_CHECK, false\) \|\| inProcessSelfCheck;/.test(RECV) &&
      /if \(!selfCheck && MainActivity\.isForeground\(\)\) return;/.test(RECV),
    '🔴 A22 ③ 到点那一下**由系统广播接收器发通知**（`YlxbAlarmReceiver`：读 `id` / `title` / `body` / `channel` / `payload` → `nm.notify(...)`），而且**应用在前台时不重复打扰**（页内已有弹窗与语音）—— 但那道早退带一档**只给自检**的旁路（`EXTRA_SELF_CHECK` / `inProcessSelfCheck`）：自检的用法就是"点完盯着屏看"，没有旁路它会把"早退"报成"接收器没到"（假红）',
    `发通知=${/nm\.notify\(id, b\.build\(\)\)/.test(RECV)} · 前台跳过=${/MainActivity\.isForeground\(\)/.test(RECV)} · 自检旁路=${/boolean selfCheck = intent\.getBooleanExtra\(EXTRA_SELF_CHECK, false\)/.test(RECV)} · 早退用了它=${/if \(!selfCheck && MainActivity\.isForeground\(\)\) return;/.test(RECV)} · 读 id=${/intent\.getIntExtra\("id", 0\)/.test(RECV)}`,
  )
  check(
    /YlxbAlarms\.scheduleAll\(context, list\)/.test(strip2(shellRead2(BOOT_REL))) &&
      /ACTION_BOOT_COMPLETED/.test(strip2(shellRead2(BOOT_REL))),
    'A22 ③ 手机重启后**从持久化的那份单子重排**（`YlxbBootReceiver` → `scheduleAll`，`SharedPreferences` 里的 `alarms_json`）—— 否则重启一次，往后几天的提醒就全没了',
    `开机重排=${/YlxbAlarms\.scheduleAll\(context, list\)/.test(strip2(shellRead2(BOOT_REL)))}`,
  )

  /* ---------------- ④ manifest：权限 + 两个 receiver + 渠道 ---------------- */
  const PERMS2 = [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ]
  check(
    PERMS2.every((p) => MANIFEST2.includes(`android:name="${p}"`)),
    '🔴 A22 ④ manifest 三条权限都在（`POST_NOTIFICATIONS`（13+ 运行时权限）· `SCHEDULE_EXACT_ALARM` · `RECEIVE_BOOT_COMPLETED`）—— 少任何一条，"应用关着也响"就有一档是假的',
    PERMS2.map((p) => `${MANIFEST2.includes(`android:name="${p}"`) ? '✔' : '✖'}${p.split('.').pop()}`).join(' · '),
  )
  {
    /* 🧪 反向对照：删掉 `POST_NOTIFICATIONS` ⇒ ④ 当场红 */
    const cut = oneEdit2(MANIFEST2, 'android:name="android.permission.POST_NOTIFICATIONS"', 'android:name="android.permission.INTERNET"')
    check(
      cut.ok && !cut.text.includes('android:name="android.permission.POST_NOTIFICATIONS"'),
      '🧪 A22 ④ 反向对照：把 `POST_NOTIFICATIONS` 那一行换成别的权限（副本）⇒ ④ 当场红（13+ 上没这一条，通知请求根本弹不出来）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${cut.text.includes('android:name="android.permission.POST_NOTIFICATIONS"')}`,
    )
  }
  /**
   * 🔴🔴 A22 ④-补：**`USE_EXACT_ALARM` 必须不在**（2026-10-05 真机第三轮）。
   *
   * 老师报的原话：「**闹钟和提醒**里面**根本就没有我们应用**」（那张特殊权限表里看不到）。
   * 根因就在这条上：Android 13+ 的 `USE_EXACT_ALARM` 是**安装即授予**（同款能力的"自动档"）
   * ⇒ 系统认"这应用已经能排精确闹钟了" ⇒ **那张"要用户自己开"的特殊权限表里压根不列它** ✗
   * ⇒ 只留 `SCHEDULE_EXACT_ALARM`，系统才把本应用列进那张表、老师才开得了。
   *
   * ⚠️ 判的是**剥过注释**的 `MANIFEST2` —— 否则上面那段"解释它为什么不能有"的话
   *   本身会把这条判据判红（注释也会误伤）。
   */
  check(
    !MANIFEST2.includes('android:name="android.permission.USE_EXACT_ALARM"'),
    '🔴 A22 ④-补 manifest **不许**声明 `USE_EXACT_ALARM` —— 13+ 上它是"安装即授予"，声明了系统就**不把本应用列进「闹钟和提醒」那张特殊权限表**（老师报的"根本没有我们应用"就是这一条）；要留在那张表里让老师自己开，只能声明 `SCHEDULE_EXACT_ALARM`',
    `声明了 USE_EXACT_ALARM=${MANIFEST2.includes('android:name="android.permission.USE_EXACT_ALARM"')}（须 false）· 声明了 SCHEDULE_EXACT_ALARM=${MANIFEST2.includes('android:name="android.permission.SCHEDULE_EXACT_ALARM"')}（须 true）`,
  )
  {
    /* 🧪 反向对照：把 `USE_EXACT_ALARM` 加回 manifest 副本 ⇒ ④-补 当场红 */
    const cut = oneEdit2(
      MANIFEST2,
      '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
      '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />\n    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />',
    )
    const back = cut.text.includes('android:name="android.permission.USE_EXACT_ALARM"')
    check(
      cut.ok && back,
      '🧪 A22 ④-补 反向对照：把 `USE_EXACT_ALARM` 那一行**加回去**（副本 = 老师报"表里看不到我们应用"的那一版）⇒ ④-补 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完又声明了=${back}`,
    )
  }
  check(
    /<receiver android:name="\.YlxbAlarmReceiver" android:exported="false" \/>/.test(MANIFEST2) &&
      /<receiver android:name="\.YlxbBootReceiver"/.test(MANIFEST2) &&
      /android\.intent\.action\.BOOT_COMPLETED/.test(MANIFEST2),
    '🔴 A22 ④ 两个 receiver 都注册了（`YlxbAlarmReceiver` = 到点发通知 · `YlxbBootReceiver` = 开机重排，带 `BOOT_COMPLETED` intent-filter）—— 没注册 = 闹钟响了没人接，**界面完全看不出异常**',
    `闹钟接收器=${/<receiver android:name="\.YlxbAlarmReceiver" android:exported="false" \/>/.test(MANIFEST2)} · 开机接收器=${/<receiver android:name="\.YlxbBootReceiver"/.test(MANIFEST2)} · BOOT_COMPLETED=${/android\.intent\.action\.BOOT_COMPLETED/.test(MANIFEST2)}`,
  )
  const CH_GENERAL2 = /public static final String CHANNEL_GENERAL = "shugao_general"/
  const CH_GENERAL_CREATE2 = /nm\.createNotificationChannel\(gn\)/
  const CH_IMM2 = /public static final String CHANNEL_IMMEDIATE = "shugao-default"/
  const CH_IMM_CREATE2 = /nm\.createNotificationChannel\(im\)/
  check(
    CH_GENERAL2.test(PLUGIN2) &&
      CH_GENERAL_CREATE2.test(PLUGIN2) &&
      CH_IMM2.test(PLUGIN2) &&
      CH_IMM_CREATE2.test(PLUGIN2) &&
      /var CHANNEL_IMMEDIATE = 'shugao-default'/.test(BRIDGE2),
    '🔴 A22 ④ 通知渠道**两侧对得上**，而且**每一个渠道都有创建者**：原生建了 `shugao_general`（保留，仍在「应用通知」里可见）与 `shugao-default`（**即时通知与到点提醒两条都点名用它**），桥接层那个常量与原生**一字不差** —— Android 8+ **往不存在的渠道发通知 = 那条通知被系统当场丢掉**（不抛错），这正是老师报"连应用内都没有通知"的那一环',
    `原生一般渠道=${CH_GENERAL2.test(PLUGIN2)}/${CH_GENERAL_CREATE2.test(PLUGIN2)} · 原生即时渠道=${CH_IMM2.test(PLUGIN2)}/${CH_IMM_CREATE2.test(PLUGIN2)} · 桥接层常量=${/var CHANNEL_IMMEDIATE = 'shugao-default'/.test(BRIDGE2)}`,
    '（⚠️ `shugao-default` 那个字面量**含连字符**，与 `shugao_general` 不同族 —— 两侧必须逐字相同，改了任一侧这条当场红）',
  )
  /*
   * ⚠️ **"网页侧交出去的单子点名哪个渠道"这一格搬去了 ⑱**（2026-10-05 真机第四轮）：
   *   原来这里断言的是 `notify.ts` 里出现 `'shugao_general'` —— 而那一处**正是要改掉的错**
   *   （交出去的单子点名了另一个渠道 ⇒ 与老师验通的即时那条不同源）。
   *   现在这一条只管"**每个渠道都有创建者**"；"两条路同源"由 ⑱ 判（那里配了能红的反向对照）。
   */
  {
    /* 🧪 反向对照：把原生那个即时渠道常量**改名** ⇒ 上面那条当场红（渠道没人建了） */
    const cut = oneEdit2(PLUGIN2, 'public static final String CHANNEL_IMMEDIATE = "shugao-default"', 'public static final String CHANNEL_IMMEDIATE = "shugao_default_renamed"')
    check(
      cut.ok && !CH_IMM2.test(cut.text) && /var CHANNEL_IMMEDIATE = 'shugao-default'/.test(BRIDGE2),
      '🧪 A22 ④ 反向对照：把原生那个即时渠道常量**改名**（副本）⇒ 上面那条当场红（桥接层点名的渠道又没人建了 = 通知被静默丢掉）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完两侧还对得上=${CH_IMM2.test(cut.text)}`,
    )
  }
  {
    /* 🧪 反向对照：**删掉原生那一句建渠道** ⇒ 上面那条当场红（这正是改之前的形状：常量在、没人建） */
    const cut = oneEdit2(PLUGIN2, 'nm.createNotificationChannel(im);', '/* 渠道没建 */')
    check(
      cut.ok && !CH_IMM_CREATE2.test(cut.text) && CH_IMM2.test(cut.text),
      '🧪 A22 ④ 反向对照：把原生那句 `nm.createNotificationChannel(im)` 删掉（副本 = **改之前**的形状：常量在、渠道没人建）⇒ 上面那条当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完还建着=${CH_IMM_CREATE2.test(cut.text)}`,
    )
  }

  /* ---------------- ④-② 即时通知那条路：走原生 `notify`，而且**报得出真失败** ---------------- */
  const BR_NATIVE_NOTIFY = /return N\.notify\(\{ id: nextId\(\), title: t, body: b \}\)/
  const BR_LN_SCHED = /LN\.schedule\(/
  check(
    BR_NATIVE_NOTIFY.test(BRIDGE2) && !BR_LN_SCHED.test(BRIDGE2),
    '🔴 A22 ④-② 桥接层的即时通知走**原生** `ShugaoNative.notify`（`YlxbNativePlugin` 的 `@PluginMethod notify`），**不再**走 `LocalNotifications.schedule` —— 后者在"渠道不存在"时**照样 resolve**（把"被系统丢掉"报成成功，这一层永远分不清发出去没有），而原生那一句会把 `ok:false` + 人话回上来',
    `转给原生=${BR_NATIVE_NOTIFY.test(BRIDGE2)} · 还在用插件 schedule=${BR_LN_SCHED.test(BRIDGE2)}（须 false）`,
  )
  {
    /* 🧪 反向对照：把那一句换回 `LocalNotifications.schedule` 的老写法 ⇒ ④-② 当场红 */
    const cut = oneEdit2(BRIDGE2, 'return N.notify({ id: nextId(), title: t, body: b })', "return LN.schedule({ notifications: [{ id: nextId(), title: t, body: b, channelId: CHANNEL_IMMEDIATE }] }).then(function () { return true })")
    check(
      cut.ok && BR_LN_SCHED.test(cut.text) && !BR_NATIVE_NOTIFY.test(cut.text),
      '🧪 A22 ④-② 反向对照：把那一句换回老写法 `LN.schedule(…).then(return true)`（副本 = "被丢掉也报成功"的坏法）⇒ ④-② 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完又用插件=${BR_LN_SCHED.test(cut.text)}`,
    )
  }
  /* ⚠️ 判据咬的是**那道守卫本身**，不是 `areNotificationsEnabled()` 这个名字 ——
     这个名字在 `selfCheck` / `notifySelfTest` 里也有，拿它当判据会被那两处**撑住不红** */
  const JAVA_NOTIFY_GUARD = /if \(nm0 == null \|\| !nm0\.areNotificationsEnabled\(\)\) \{/
  check(
    /public void notify\(PluginCall call\)/.test(PLUGIN2) &&
      JAVA_NOTIFY_GUARD.test(PLUGIN2) &&
      /Manifest\.permission\.POST_NOTIFICATIONS/.test(PLUGIN2) &&
      /NotificationManagerCompat\.from\(ctx\)\.notify\(id, b\.build\(\)\)/.test(PLUGIN2),
    '🔴 A22 ④-② 原生 `notify` **先量再发**：那道守卫 `if (nm0 == null || !nm0.areNotificationsEnabled())` 排在最前面（这个应用的通知有没有被系统关掉）· 再量 13+ 的 `POST_NOTIFICATIONS` · 都过了才 `NotificationManagerCompat.notify` —— 断了就回 `ok:false` + 一句人话（**不许静默**：改之前"发不出去"与"发出去了"在这一层长得一模一样）',
    `方法在=${/public void notify\(PluginCall call\)/.test(PLUGIN2)} · 守卫在=${JAVA_NOTIFY_GUARD.test(PLUGIN2)} · 量13+权限=${/Manifest\.permission\.POST_NOTIFICATIONS/.test(PLUGIN2)} · 真的发=${/NotificationManagerCompat\.from\(ctx\)\.notify\(id, b\.build\(\)\)/.test(PLUGIN2)}`,
  )
  {
    /* 🧪 反向对照：把那道守卫短路成 `if (false) {` ⇒ 上面那条当场红（= 又回到"不量就发"） */
    const cut = oneEdit2(PLUGIN2, 'if (nm0 == null || !nm0.areNotificationsEnabled()) {', 'if (false) {')
    check(
      cut.ok && !JAVA_NOTIFY_GUARD.test(cut.text),
      '🧪 A22 ④-② 反向对照：把那道守卫短路成 `if (false) {`（副本 = "不量就发、发丢了也不说"的坏法）⇒ 上面那条当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完守卫还在=${JAVA_NOTIFY_GUARD.test(cut.text)}`,
    )
  }

  /* ---------------- ④-③ 自检入口（老师自己点一下就知道断在哪一环） ---------------- */
  const BR_SELFTEST = /selfTest: function \(\) \{/
  const JAVA_SUB = /public void selfCheck\(PluginCall call\)/
  const JAVA_SUB2 = /public void notifySelfTest\(PluginCall call\)/
  const TEST_ID2 = /private static final int NOTIFY_TEST_ID = \d+;/
  check(
    BR_SELFTEST.test(BRIDGE2) &&
      /N\.selfCheck\(\)/.test(BRIDGE2) &&
      /N\.notifySelfTest\(\)/.test(BRIDGE2) &&
      JAVA_SUB.test(PLUGIN2) &&
      JAVA_SUB2.test(PLUGIN2) &&
      /nm\.getNotificationChannel\(CHANNEL_IMMEDIATE\) != null/.test(PLUGIN2),
    '🔴 A22 ④-③ **自检那条路两侧都通**：桥接层挂 `selfTest()`（转发 `selfCheck` = 只量 + `notifySelfTest` = 真发一条），原生两个方法都在，而且自检**直接量那个渠道在不在**（`getNotificationChannel(CHANNEL_IMMEDIATE) != null`）—— 本机没有安卓设备，这一格读数就是"把这台手机上的断点搬到屏上"的唯一办法',
    `桥接层=${BR_SELFTEST.test(BRIDGE2)} · 转发只量=${/N\.selfCheck\(\)/.test(BRIDGE2)} · 转发真发=${/N\.notifySelfTest\(\)/.test(BRIDGE2)} · 原生两个方法=${JAVA_SUB.test(PLUGIN2)}/${JAVA_SUB2.test(PLUGIN2)} · 量渠道=${/nm\.getNotificationChannel\(CHANNEL_IMMEDIATE\) != null/.test(PLUGIN2)}`,
  )
  {
    /* 🧪 反向对照：把桥接层那个自检方法**改名** ⇒ ④-③ 当场红（网页侧又无从调用） */
    const cut = oneEdit2(BRIDGE2, 'selfTest: function () {', 'selfTestRenamed: function () {')
    check(
      cut.ok && !BR_SELFTEST.test(cut.text),
      '🧪 A22 ④-③ 反向对照：把桥接层那个 `selfTest` **改名**（副本 = "原生写好了、网页侧没挂"那个形态）⇒ ④-③ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${BR_SELFTEST.test(cut.text)}`,
    )
  }
  check(
    TEST_ID2.test(PLUGIN2),
    '🔴 A22 ④-③ 自检那条通知用**写死的固定 id**（`NOTIFY_TEST_ID`）—— 重复点只覆盖不堆通知栏；而且它是个小常数，**不会**像 `System.currentTimeMillis()` 那样在 2038 年后越过 Java int（这个入口要长期留着）',
    `固定 id=${TEST_ID2.test(PLUGIN2)}`,
  )
  {
    /* 🧪 反向对照：把固定 id 换成 `System.currentTimeMillis()` 那种写法 ⇒ 上面那条当场红 */
    const cut = oneEdit2(PLUGIN2, 'private static final int NOTIFY_TEST_ID = 944001;', 'private static final int NOTIFY_TEST_ID = (int) System.currentTimeMillis();')
    check(
      cut.ok && !TEST_ID2.test(cut.text),
      '🧪 A22 ④-③ 反向对照：把那句固定 id 换成 `(int) System.currentTimeMillis()`（副本 = 2038 年后越界的那种坏法）⇒ 上面那条当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完还是固定常数=${TEST_ID2.test(cut.text)}`,
    )
  }

  /* ---------------- ④-④ 网页侧：自检那四格读数 + 只给超管的入口 ---------------- */
  check(
    /export interface ShellSelfTest \{/.test(NOTIFY) &&
      /selfTest\?\(\): Promise<ShellSelfTest>/.test(NOTIFY) &&
      /export async function runNotifySelfTest\(\): Promise<ShellSelfTest> \{/.test(NOTIFY) &&
      /if \(typeof s\?\.selfTest !== 'function'\) return \{ unsupported: true \}/.test(NOTIFY) &&
      /export function selfTestHint\(r: ShellSelfTest\)/.test(NOTIFY) &&
      /if \(r\.unsupported\) return \{ text: '这个版本还不能自检'/.test(NOTIFY) &&
      /if \(r\.posted === true\) return \{ text: '已发出一条测试通知'/.test(NOTIFY),
    '🔴 A22 ④-④ 网页侧那条自检路**三态分明**：`ShellSelfTest` 把四格读数分开（`notify` / `granted` / `channel` / `posted`，**合成一个 boolean 就没法定位断点了**）· **先问能力**（`selfTest` 不在 ⇒ 回 `unsupported`，不许假装检查过）· `selfTestHint()` 把每一格翻成**不同的**一句人话（"系统里通知是关着的" ≠ "渠道没建起来"）',
    `类型在=${/export interface ShellSelfTest \{/.test(NOTIFY)} · 能力门=${/if \(typeof s\?\.selfTest !== 'function'\) return \{ unsupported: true \}/.test(NOTIFY)} · 分档=${/export function selfTestHint\(r: ShellSelfTest\)/.test(NOTIFY)} · 未支持档=${/if \(r\.unsupported\) return \{ text: '这个版本还不能自检'/.test(NOTIFY)} · 成功档=${/if \(r\.posted === true\) return \{ text: '已发出一条测试通知'/.test(NOTIFY)}`,
  )
  {
    /* 🧪 反向对照：把"先问能力"那一句短路 ⇒ ④-④ 当场红（网页版也会去调一个不存在的口） */
    const cut = oneEdit2(NOTIFY, "if (typeof s?.selfTest !== 'function') return { unsupported: true }", 'if (false) return { unsupported: true }')
    check(
      cut.ok && !/if \(typeof s\?\.selfTest !== 'function\) return \{ unsupported: true \}/.test(cut.text),
      '🧪 A22 ④-④ 反向对照：把"先问能力"那一句短路成 `if (false)`（副本 = 网页版与两个 exe 也会去调一个不存在的口）⇒ ④-④ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }
  /**
   * 🆕 **入口已撤**（用户 2026-10-05/06 原话：「日程里面两个测试按钮可以删除了」）。
   *
   * 🔴 为什么期望值从"在屏上"翻成"看不到"：那块（「试一条通知」+「两分钟后试一条
   *    定时提醒」+ 那句「只给管理员，用来查到点提醒通不通」）是 2026-10-05 真机第三/四轮
   *    为排查"收不到通知"临时加的**自检入口**。用户已确认功能正常（权限提示正常、
   *    计时正常）⇒ **撤掉入口**（文案纪律：界面只说"这里是什么、我能做什么"；
   *    排查工具不该常驻）。
   * ⚠️⚠️ **撤的是入口，不是能力**：`notify.ts` 里 `runNotifySelfTest()` / `selfTestHint()`
   *    那一整条路照旧由本节上一条（自检四格读数）与 ⑳ 钉着 —— 将来还要排障。
   *    所以这一条**只**判"日程页里不再出现它们"，一个字都不碰 `notify.ts`。
   */
  const SELFTEST_ENTRY_GONE2 = [
    '试一条通知',
    '两分钟后试一条定时提醒',
    '只给管理员，用来查到点提醒通不通',
    'isSuperAdmin(myRoles)',
    'runNotifySelfTest',
    'runRemindSelfTest',
    'selfTestHint',
    'remindCheckHint',
    'remindFiredHint',
    'watchRemindSelfCheck',
  ]
  const entryGone2 = (s) => SELFTEST_ENTRY_GONE2.every((m) => !s.includes(m))
  const entryHits2 = (s) => SELFTEST_ENTRY_GONE2.filter((m) => s.includes(m))
  check(
    entryGone2(SCHEDULE),
    '🔴 A22 ④-④ 日程页那两颗**临时自检入口已撤掉**（「试一条通知」/「两分钟后试一条定时提醒」/「只给管理员，用来查到点提醒通不通」，用户 2026-10-05/06 要求：功能已验通 ⇒ 撤排查工具）—— 入口撤、**能力仍在**（`notify.ts` 那半条路由上一条与 ⑳ 继续钉着）',
    `还在屏上/源码里的：${entryHits2(SCHEDULE).join('、') || '（一处都没有）'}`,
  )
  {
    /* 🧪 反向对照：把那一块**塞回源码副本**（锚点 = 它撤掉之前紧挨着的那句横幅三目，
       剥注释后恰好 1 处）⇒ 上面那条当场假 —— 证明它读的是真源码，不是恒绿摆设。
       ⚠️ `oneEdit2` 先数出现次数（≠1 就不改、判 `ok:false`），宁可报错也不假绿。 */
    const cut = oneEdit2(
      SCHEDULE,
      '{showPermBanner ? (',
      '{Array.isArray(myRoles) && isSuperAdmin(myRoles) ? (<Button>试一条通知</Button>) : null}\n{showPermBanner ? (',
    )
    check(
      cut.ok && !entryGone2(cut.text),
      '🧪 A22 ④-④ 反向对照：把「试一条通知」那块**塞回源码副本**（= 撤掉之前的形态）⇒ 上面那条当场假',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完还"一处都没有"=${entryGone2(cut.text)} · 命中的：${entryHits2(cut.text).join('、')}`,
    )
  }

  /*
   * ⛔ 壳那一侧到此为止 —— 🔴 **立刻关掉"允许落灰"**：下面 ⑤–⑧ 判的全是 **`app/` 下的文件**
   *    （CI 的检出里**也有**）⇒ 它们**一条都不许灰**。忘了关 ⇒ 节末自证当场红。
   */
  const shellJudged2 = passed + failures.length - j0b
  shellGray = false
  const g1b = grayed

  /* ---------------- ⑤ 网页侧：真去调那个口 + 算得对 ---------------- */
  check(
    /typeof s\?\.scheduleAlarms !== 'function'/.test(NOTIFY) && /await s\.scheduleAlarms\(\[\.\.\.alarms\]\)/.test(NOTIFY),
    '🔴 A22 ⑤ `notify.ts` 的 `scheduleNativeReminders()` 判据是"**桥接对象上这个方法在不在**"（不是"有没有 Capacitor"），而且**真的调**它',
    `判能力=${/typeof s\?\.scheduleAlarms !== 'function'/.test(NOTIFY)} · 真调=${/await s\.scheduleAlarms\(\[\.\.\.alarms\]\)/.test(NOTIFY)}`,
  )
  check(
    /export const ALARM_ID_MAX = 2147483646/.test(NOTIFY) && /return id \+ 1/.test(NOTIFY),
    '🔴 A22 ⑤ 交给系统的 id 上界写死在 `ALARM_ID_MAX = 2147483646`（`Integer.MAX_VALUE` 减 1；**不给 0** —— 0 与"没有 id"在别处同义）',
    `常量在=${/export const ALARM_ID_MAX = 2147483646/.test(NOTIFY)}`,
  )
  {
    /* 🧪 反向对照：把上界改大到越界 ⇒ 判据当场假 */
    const cut = oneEdit2(NOTIFY, 'export const ALARM_ID_MAX = 2147483646', 'export const ALARM_ID_MAX = 3147483646')
    check(
      cut.ok && !/export const ALARM_ID_MAX = 2147483646/.test(cut.text),
      '🧪 A22 ⑤ 反向对照：把 `ALARM_ID_MAX` 改到越界（副本）⇒ 上面那条当场红（证明它在读**那个字面量**）',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }
  check(
    /if \(fireAt <= t0\) continue/.test(NOTIFY) && /d\.setMinutes\(Math\.trunc\(minute\)\)/.test(NOTIFY),
    '🔴 A22 ⑤ 排单子时**过期的那些不排**（`fireAt <= t0`）、时刻由"当天第几分钟"算（`setMinutes` 会自己进位：1440 = 次日 00:00）—— 排一堆已经过去的闹钟等于老师一打开应用就被轰一串通知',
    `过期过滤=${/if \(fireAt <= t0\) continue/.test(NOTIFY)} · 分钟→时刻=${/d\.setMinutes\(Math\.trunc\(minute\)\)/.test(NOTIFY)}`,
  )

  /* ---------------- ⑥ 挂钩子：真的排了，而且**页内那一条兜底还在** ---------------- */
  /*
   * 🔴 2026-10-05 真机第四轮改过分句形状：`nativeReminderPlan(...)` 的结果先落进 `plan`
   *   （因为要先用它判"**空单子就早退**"，见 ⑪），再交给 `scheduleNativeReminders(plan)`。
   *   ⇒ 判据跟着改成两句都在、且顺序正确（仍然配能红的反向对照）。
   */
  const ARM_PLAN = /const plan = nativeReminderPlan\(days, now\)/
  const ARM_CALL = /const ok = await scheduleNativeReminders\(plan\)/
  check(
    ARM_PLAN.test(HOOK) &&
      ARM_CALL.test(HOOK) &&
      HOOK.indexOf('const plan = nativeReminderPlan(days, now)') <
        HOOK.indexOf('const ok = await scheduleNativeReminders(plan)') &&
      /scheduleNativeReminders,[\s\S]{0,120}\} from '\.\.\/lib\/notify'/.test(HOOK),
    '🔴 A22 ⑥ `useScheduleReminder` 真的把那条单子排出去（`nativeReminderPlan(days, now)` → `scheduleNativeReminders(plan)`）—— 桥接层与适配层都写好了、**没人调**，就是这次事故的形态（`97cf3fd` 同源：桥接层给了答案，业务层没去读）',
    `算单子=${ARM_PLAN.test(HOOK)} · 排出去=${ARM_CALL.test(HOOK)}`,
  )
  {
    /* 🧪 反向对照：把那一句删掉 ⇒ ⑥ 当场红（= 回到"只有页内定时器"的老样子） */
    const cut = oneEdit2(HOOK, 'const ok = await scheduleNativeReminders(plan)', 'const ok = false')
    check(
      cut.ok && !ARM_CALL.test(cut.text),
      '🧪 A22 ⑥ 反向对照：把"排出去"那一句删掉（副本）⇒ ⑥ 当场红 —— 那正是**改之前**的状态（整条提醒只靠页内定时器）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${ARM_CALL.test(cut.text)}`,
    )
  }
  check(
    /const NATIVE_PLAN_DAYS = 3/.test(HOOK) &&
      /for \(let i = 0; i < NATIVE_PLAN_DAYS; i\+\+\)/.test(HOOK),
    'A22 ⑥ 往后算 `NATIVE_PLAN_DAYS = 3` 天（今天 / 明天 / 后天）—— 每次页面重新可见都会重排一遍，所以"提前几天"这个数不必大：**排太多会吃 ROM 的闹钟配额**',
    `天数=${/const NATIVE_PLAN_DAYS = 3/.test(HOOK)} · 循环用它=${/for \(let i = 0; i < NATIVE_PLAN_DAYS; i\+\+\)/.test(HOOK)}`,
  )
  {
    /* 🧪 反向对照：把天数改成 0 ⇒ ⑥ 那条当场假（一条都不排 = 静默失效） */
    const cut = oneEdit2(HOOK, 'const NATIVE_PLAN_DAYS = 3', 'const NATIVE_PLAN_DAYS = 0')
    check(
      cut.ok && !/const NATIVE_PLAN_DAYS = 3/.test(cut.text),
      '🧪 A22 ⑥ 反向对照：把天数改成 `0`（副本）⇒ 上面那条当场红 —— "排 0 天"就是"什么都不排"，而界面上看不出任何异常',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }
  check(
    /const t = window\.setInterval\(\(\) => void tick\(\), 60_000\)/.test(HOOK) &&
      /const ok = await notifyAsync\(title, body\)/.test(HOOK) &&
      /perm === 'granted'/.test(HOOK),
    '🔴 A22 ⑥ **页内那一条兜底照旧保留**（`setInterval(60s)` + `notifyAsync` + 失败时 `push` 页内提示）—— 系统排程是"应用关着也能响"，页内那条是"应用开着时更即时、且失败会有人知道"，两条**分工**，不许二选一',
    `定时器=${/const t = window\.setInterval\(\(\) => void tick\(\), 60_000\)/.test(HOOK)} · 即时通知=${/const ok = await notifyAsync\(title, body\)/.test(HOOK)} · 页内兜底=${/perm === 'granted'/.test(HOOK)}`,
  )

  /* ---------------- ⑦ 排不上就**说出来**（不许静默） ---------------- */
  check(
    /if \(!warnedNoNative\.current\)/.test(HOOK) && /提醒改在应用内显示/.test(HOOK),
    '🔴 A22 ⑦ 系统排不上时**说一句人话**（一次会话只说一次）—— §三.5：不可写的路径要显式报错。"收不到通知而界面上看不出任何异常"正是这次事故的形态',
    `说了=${/if \(!warnedNoNative\.current\)/.test(HOOK)} · 文案在=${/提醒改在应用内显示/.test(HOOK)}`,
  )
  {
    /* 🧪 反向对照：把那一句删掉 ⇒ ⑦ 当场红（= 静默失败） */
    const cut = oneEdit2(HOOK, 'if (!warnedNoNative.current) {', 'if (false) {')
    check(
      cut.ok && !/if \(!warnedNoNative\.current\)/.test(cut.text),
      '🧪 A22 ⑦ 反向对照：把那句提示的条件改成 `false`（副本）⇒ ⑦ 当场红（排不上也一声不吭）',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }

  /* ---------------- ⑨–⑪ **先问"这个壳有没有这个能力"，再谈成败**（2026-10-05 文档轮抓到的真 bug） ----------------
   *
   * 🔴 改之前：那句提示的判据是「**尝试后失败** ⇒ 提示」（`if (!ok)`）——
   *    而 `scheduleNativeReminders()` 在**网页版与两个 exe** 上恒返 `false`
   *    （exe 的 `_src/desktop/preload.js` 没有暴露 `scheduleAlarms`，网页版连 `__shell_out` 都没有）
   *    ⇒ 那句「提醒改在应用内显示。关掉应用就收不到了。」由 `AppShell`（**无条件挂载**）承载，
   *      在**每一个登录后的页面上平白弹一次** ✗。
   *    🔴 而它只对 **apk 壳**成立：网页版关掉页面本来就收不到（无需提醒）、两个 exe 也从来没有原生排程。
   * ✅ 现在：**先问能力**（`shellCanScheduleAlarms()`）—— 没有能力就**直接不进任何提示分支**；
   *    有能力的壳里，"没排上 / 被系统拒"照旧说那句人话（⑦ 一字未动）。
   */
  const CAP_SIG = /export function shellCanScheduleAlarms\(\): boolean \{([\s\S]*?)\n\}/
  /** 抠出能力判据的**函数体**（抠不出来 ⇒ 空串 ⇒ 下面的判据当场红，不会空转） */
  const capBodyOf = (t) => t.match(CAP_SIG)?.[1] ?? ''
  /** 把函数体**真的跑一遍**（三种壳的假 `shell()`）—— 这是行为判据，不是文字判据 */
  const runCap = (body) => {
    try {
      const f = new Function('shell', body)
      return {
        web: f(() => null),
        exe: f(() => ({})),
        apk: f(() => ({ scheduleAlarms: () => Promise.resolve(true) })),
        err: '',
      }
    } catch (e) {
      return { web: null, exe: null, apk: null, err: String(e?.message ?? e) }
    }
  }
  const CAP_OK = (r) => r.err === '' && r.web === false && r.exe === false && r.apk === true

  check(
    /typeof s\?\.scheduleAlarms === 'function'/.test(capBodyOf(NOTIFY)),
    '🔴 A22 ⑨ `notify.ts` 有了"**这个壳有没有原生排程这个能力**"的判据（`shellCanScheduleAlarms()`：问 `__shell_out` 上 `scheduleAlarms` 在不在）—— 不是"有没有 Capacitor"、也不是"试一下成不成"',
    capBodyOf(NOTIFY)
      ? `判据体=${JSON.stringify(capBodyOf(NOTIFY).trim().split('\n').join(' '))}`
      : '🔴 抠不出 `shellCanScheduleAlarms()` 的函数体（形状变了 ⇒ 这一条当场红）',
  )
  {
    const r = runCap(capBodyOf(NOTIFY))
    check(
      CAP_OK(r),
      '🔴 A22 ⑩ 三种壳上跑同一条判据：网页版（没有 `__shell_out`）= `false` · **exe 的 preload**（有 `__shell_out`、没有 `scheduleAlarms`）= `false` · apk 桥接层 = `true` ⇒ "没有能力"与"有能力但没排上"**从结构上**分得开',
      r.err ? `🔴 跑不起来：${r.err}` : `网页版=${r.web} · exe=${r.exe} · apk=${r.apk}`,
    )
    /* 🧪 反向对照：把能力判据反过来问（内存副本）⇒ 上面那条当场红（读数整个翻过来） */
    const cut = oneEdit2(NOTIFY, "typeof s?.scheduleAlarms === 'function'", "typeof s?.scheduleAlarms !== 'function'")
    const rc = cut.ok
      ? runCap(capBodyOf(cut.text))
      : { web: null, exe: null, apk: null, err: `替换失败：目标出现 ${cut.n} 处（须恰好 1）` }
    check(
      cut.ok && rc.err === '' && !CAP_OK(rc),
      '🧪 A22 ⑩ 反向对照：把能力判据改成"**没有**这个方法才算有能力"（内存副本）⇒ 上面那条当场假 —— 证明它咬的是**问对了没有**，不是这几个名字在不在',
      cut.ok
        ? `目标出现 ${cut.n} 处（须恰好 1）· 改完读数：网页版=${rc.web} · exe=${rc.exe} · apk=${rc.apk}`
        : `目标出现 ${cut.n} 处（须恰好 1）—— 宁可报错，也不假绿`,
    )
  }
  {
    /**
     * 那句提示的前后顺序（`NOTIFY` / `HOOK` 都已经是**剥过注释**的真代码）。
     *
     * 🔴 **2026-10-05 真机第四轮改过这一条的判据形状**（原来是逐个 `indexOf` 常量串）：
     *   真凶查出来后 `arm()` 里插进了一句"**空单子就早退**"（`if (plan.length === 0) return`），
     *   而那句必须排在"排单子"和"出口"**之间** —— 用常量串去数就会因为
     *   `const ok = await scheduleNativeReminders(nativeReminderPlan(days, now))`
     *   被改成 `const plan = …` + `scheduleNativeReminders(plan)` 而**假红**
     *   （判据咬的是"哪一行代码"，不是"有没有这个语义"）。
     * ⇒ 现在用**正则按语义**取位置，四处**一个都不能少**（抠不出来 = `-1` ⇒ 当场红）：
     *     门（真判据） < 排单子 < 空单子早退 < 那个唯一出口
     */
    const gateOrder = (t) => {
      const re = (r) => {
        const m = r.exec(t)
        return m ? m.index : -1
      }
      const g = re(/if \(!shellCanScheduleAlarms\(\)\) return/)
      const c = re(/const plan = nativeReminderPlan\(days, now\)/)
      const e = re(/if \(plan\.length === 0\) return/)
      const k = re(/const ok = await scheduleNativeReminders\(plan\)/)
      /*
       * ⚠️ 这里数的是**真的把话推出去**那一句（`push({ text: hint.text`），
       *    **不是**那句文案本身 —— 2026-10-05 起文案搬进了纯函数 `remindFailHint()`
       *    （排在文件前面，为的是让 ⑭ 能直接把它当代码跑）⇒ 按文案的位置判会**假红**。
       *    "谁能把这句话说出去"才是这条要判的东西：出口只有一个，且在能力门**之后**。
       */
      const p = t.indexOf("push({ text: hint.text, tone: 'warn', desc: hint.desc })")
      /* 能力门必须是**真判据**（`if (false) return` 这种短路要能红） */
      const gOk = g >= 0 && /if \(!shellCanScheduleAlarms\(\)\) return/.test(t)
      return {
        g,
        c,
        e,
        k,
        p,
        gOk,
        ok: gOk && c > g && e > c && k > e && p > k,
      }
    }
    const o = gateOrder(HOOK)
    const IMPORTED = /shellCanScheduleAlarms,[\s\S]{0,200}\} from '\.\.\/lib\/notify'/.test(HOOK)
    check(
      o.ok && IMPORTED,
      '🔴 A22 ⑪ 提示的触发条件**先判"这个壳有没有这个能力"**（`if (!shellCanScheduleAlarms()) return` 是**真判据**，不是短路），且排在"排单子"→「**空单子早退**」→「唯一出口」（`push({ text: hint.text … })`）**之前**（四处缺一不可）⇒ 网页版 / 两个 exe **连提示分支都进不去**；而"今天没有要响的提醒"这一档**根本不再走那句误导话**（2026-10-05 真机第四轮：那句「换一版应用可以收到系统通知」正是老师看到的那一句）；判据从 `lib/notify` 那一个口导入',
      `门@${o.g}（真判据=${o.gOk}）· 排单子@${o.c} · 空单子早退@${o.e} · 排出去@${o.k} · 出口@${o.p}（须 门 < 排 < 早退 < 排出去 < 出口）· 从 notify 导入=${IMPORTED}`,
    )
    /* 🧪 反向对照：把"先判能力"那一句短路掉 = 改之前"直接判失败就提示"的形状 ⇒ ⑪ 当场红 */
    const cut = oneEdit2(HOOK, 'if (!shellCanScheduleAlarms()) return', 'if (false) return')
    const o2 = cut.ok ? gateOrder(cut.text) : { g: -1, c: -1, e: -1, k: -1, p: -1, gOk: false, ok: true }
    check(
      cut.ok && !o2.ok,
      '🧪 A22 ⑪ 反向对照：把"先判能力"那一句短路成 `if (false) return`（内存副本 = 改之前"没排上就提示"的形状）⇒ ⑪ 当场红（那句话又变成网页版也会弹）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完能力门@${o2.g} · 真判据=${o2.gOk} · 判据=${o2.ok}`,
    )
    /* 🧪 反向对照：把"空单子早退"删掉（= 让"今天没东西可排"又落回那句误导话）⇒ ⑪ 当场红 */
    const cut2 = oneEdit2(HOOK, 'if (plan.length === 0) return', 'if (false) return')
    const o3 = cut2.ok ? gateOrder(cut2.text) : { g: -1, c: -1, e: -1, k: -1, p: -1, gOk: false, ok: true }
    check(
      cut2.ok && !o3.ok,
      '🧪 A22 ⑪ 反向对照：把「**空单子早退**」删掉（内存副本 = 老师看到"换一版应用可以收到系统通知"的那一版）⇒ ⑪ 当场红 —— "今天没有要响的提醒"与"排不上"是两件事，这条判据咬的就是它们**分得开**',
      `目标出现 ${cut2.n} 处（须恰好 1）· 改完空单子早退@${o3.e} · 判据=${o3.ok}`,
    )
  }

  /*
   * ---------------- ⑫–⑯ **"提示与真实能力不匹配"**（2026-10-05 真机第二轮，两条 ✗） ----------------
   *
   * 用户在真机（最新 apk）上看到两句**不该那样说**的话：
   *   ✗ ① 工作台顶部：「提醒改在应用内显示。关掉应用就收不到了。」／「换一版应用可以收到系统通知。」
   *        —— 那是**兜底话**：出现说明**能力门过了**（⑪），紧跟着的真因是
   *        **系统没给"精确闹钟"**（Android 12+ 的 `SCHEDULE_EXACT_ALARM`）
   *        ⇒ 话里得有**可操作的一步**（去系统设置开「闹钟与提醒」），不能只说"收不到"。
   *   ✗ ② 日程表页那张黄条：「这个设备收不到系统通知」／「要在手机上收到系统通知，请用浏览器打开网站并允许通知。」
   *        —— 那是**更早的**判断，问的是**网页的**通知权限（WebView 里本来就没有
   *        `Notification` ⇒ `notifyChannel() === 'unsupported'`），而 **apk 的通知走的是原生
   *        `AlarmManager`**（`__shell_out.scheduleAlarms`）⇒ 它明明收得到，还在劝去浏览器 ✗。
   *
   * 🔴 两处共同的纪律：**先问能力，再谈成败**；量不出来就**灰**（不说），绝不猜（§三.4）。
   * 🔴 硬边界：**网页版与两个 exe 的行为一个字不许变** —— 下面那些"能力门"就是这条边界的守卫，
   *    每条都配一条能红的反向对照（§三.2：`String.replace` 前先数出现次数）。
   */
  const IMP_SCHED =
    /import \{\s*notifyPermission,[\s\S]{0,400}shellCanScheduleAlarms,[\s\S]{0,120}\} from '\.\.\/lib\/notify'/
  const SHOW_RE = /const showPermBanner = perm !== 'granted' && !shellSchedules/
  check(
    IMP_SCHED.test(SCHEDULE) && /const shellSchedules = shellCanScheduleAlarms\(\)/.test(SCHEDULE) && SHOW_RE.test(SCHEDULE),
    '🔴 A22 ⑫ 日程页那块权限横幅**先问原生能力**：从 `notify.ts` 那一个口导入 `shellCanScheduleAlarms()`，显示条件是 `perm !== \'granted\' && !shellSchedules` —— **壳里有原生排程（apk）⇒ 这块横幅整个不出现**（老师明明收得到系统通知，没有"收不到"这回事，也没有"开启通知"要他做）',
    `导入=${IMP_SCHED.test(SCHEDULE)} · 问能力=${/const shellSchedules = shellCanScheduleAlarms\(\)/.test(SCHEDULE)} · 条件=${SHOW_RE.test(SCHEDULE)}`,
  )
  {
    /* 🧪 反向对照：把能力那一项从显示条件里删掉 ⇒ ⑫ 当场红（= 回到"只看网页权限"的坏法：apk 上又会劝去浏览器） */
    const cut = oneEdit2(SCHEDULE, "const showPermBanner = perm !== 'granted' && !shellSchedules", "const showPermBanner = perm !== 'granted'")
    check(
      cut.ok && !SHOW_RE.test(cut.text),
      '🧪 A22 ⑫ 反向对照：把 `&& !shellSchedules` 从显示条件里删掉（内存副本 = apk 上又会劝"用浏览器打开网站"的坏法）⇒ ⑫ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${SHOW_RE.test(cut.text)}`,
    )
  }
  {
    /*
     * ⚠️ 那句引导话在 `HOOK` 里只出现**一处**（`remindFailHint()` 的函数体里）——
     *   而**真正给出去**的那一句是下面 `const hint = remindFailHint(...)` 那一行
     *   （它的 `push` 在 ⑪ 出口判据里钉着）。
     *   ⇒ 这里判的是：那句文案**只有** `remindFailHint()` 这一个来源，
     *     而它的**调用点**在文案之后、且**过得了那道能力门**（`canExact === false && canOpenSettings`）。
     *   ⚠️ 抠不出函数定义 / 找不到调用点 ⇒ 全是 `-1` ⇒ 判据当场红（不空转）。
     */
    const order = (t) => {
      const fn = t.indexOf('export function remindFailHint(')
      const g = t.indexOf('去系统设置把「闹钟与提醒」允许给本应用，关掉应用也能响。')
      const u =
        fn < 0 ? -1 : t.indexOf('const hint = remindFailHint(canExactNow, shellCanOpenExactAlarmSettings())', fn)
      return {
        g,
        u,
        n: t.split('去系统设置把「闹钟与提醒」允许给本应用，关掉应用也能响。').length - 1,
        ok: fn >= 0 && g > fn && u > fn && u > g,
      }
    }
    const o = order(HOOK)
    check(
      /export function remindFailHint\(/.test(HOOK) &&
        /if \(canExact === false && canOpenSettings\) \{/.test(HOOK) &&
        o.ok,
      '🔴 A22 ⑬ 兜底话**给出可操作的一步**：`remindFailHint(canExact, canOpenSettings)` 分档（纯函数，判据直接跑它），只有**量到"精确闹钟没授权"（`false`）**且**这个壳有那条跳设置的路**时，才说「去系统设置把『闹钟与提醒』允许给本应用，关掉应用也能响。」—— 其余情形（没量到 / 跳不了）照旧那句兜底，**不许**凭空指着设置说"去那儿开"',
      `分档函数=${/export function remindFailHint\(/.test(HOOK)} · 能力门在=${/if \(canExact === false && canOpenSettings\) \{/.test(HOOK)} · 引导话@${o.g} < 调用点@${o.u}（须严格在这个顺序上）· 那句话全文件 ${o.n} 处（须恰好 1：唯一出口在分档函数里）`,
    )
    /* 🧪 反向对照：把"量到了没授权"这一个前提反过来 ⇒ ⑬ 的能力门当场假（那就会对着"不知道"乱指路） */
    const cut = oneEdit2(HOOK, 'if (canExact === false && canOpenSettings) {', 'if (canExact === true && canOpenSettings) {')
    check(
      cut.ok && !/if \(canExact === false && canOpenSettings\) \{/.test(cut.text),
      '🧪 A22 ⑬ 反向对照：把前提改成"**量到 `true` 才算没授权**"（内存副本 = 拿"知道能排"去指路，方向反了）⇒ ⑬ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${/if \(canExact === false && canOpenSettings\) \{/.test(cut.text)}`,
    )
  }
  {
    /**
     * 🧪 把 `remindFailHint()` 的函数体**真的跑一遍**（`Function` 构造器 —— 行为判据，不是文字判据）。
     *    输入三档：量到没授权（`false`）· 量到已授权（`true`）· 没量到（`null`）；
     *    每种再分"这个壳有跳设置那条路 / 没有"。
     */
    const HINT_SIG =
      /export function remindFailHint\(\s*canExact: boolean \| null,\s*canOpenSettings: boolean,\s*\): \{ text: string; desc: string \} \{([\s\S]*?)\n\}/
    const body = HOOK.match(HINT_SIG)?.[1] ?? ''
    const run = (t, c) => {
      try {
        const f = new Function('canExact', 'canOpenSettings', t)
        return { text: String(f(c, true)?.text ?? ''), desc: String(f(c, true)?.desc ?? ''), err: '' }
      } catch (e) {
        return { text: '', desc: '', err: String(e?.message ?? e) }
      }
    }
    /** 网页版 / 两个 exe：**没有**那条跳设置的路 ⇒ 一个字都不许变（照旧那句兜底） */
    const webOk = (t) => {
      const f = new Function('canExact', 'canOpenSettings', t)
      return [null, false, true].every((c) => f(c, false).text === '提醒改在应用内显示。关掉应用就收不到了。')
    }
    let r = { text: '', desc: '', err: '抠不出 remindFailHint() 的函数体（形状变了 ⇒ 这一条当场红）' }
    let web = false
    if (body) {
      r = run(body, false)
      try {
        web = webOk(body)
      } catch {
        web = false
      }
    }
    const ok =
      body !== '' && r.err === '' && r.desc.includes('去系统设置') && r.desc.includes('闹钟与提醒') && web
    check(
      ok,
      '🔴 A22 ⑭ 把那个分档**当代码跑**：`canExact = false`（系统确实没给精确闹钟）⇒ 那句里**真的**有「去系统设置」+「闹钟与提醒」；而 `null`（**没量到**）与 `true`（已经给了）都照旧那句兜底 —— 三态不许混（§三.4：没结论是灰，不许拿"不知道"去指路）',
      r.err ? `🔴 跑不起来：${r.err}` : `false ⇒ ${r.text}／${r.desc} · 没量到与已授权那两档走兜底=${web}`,
    )
    /* 🧪 反向对照：把"量到了没授权"改判成"量到了已授权" ⇒ 引导话**打不出来**了，上面那条当场红 */
    const cut = oneEdit2(HOOK, 'if (canExact === false && canOpenSettings) {', 'if (canExact === true && canOpenSettings) {')
    const cutBody = cut.ok ? cut.text.match(HINT_SIG)?.[1] ?? '' : ''
    const rc = cutBody ? run(cutBody, false) : { desc: '', err: '抠不出函数体' }
    check(
      cut.ok && rc.err === '' && !rc.desc.includes('去系统设置'),
      '🧪 A22 ⑭ 反向对照：把那一档改判成"量到 `true` 才指路"（内存副本）⇒ 兜底话里「去系统设置」**一个字都打不出来** —— 证明这条判据咬的是那句真代码，不是恒真',
      cut.ok
        ? `目标出现 ${cut.n} 处（须恰好 1）· 改完 desc=${JSON.stringify(rc.desc)}`
        : `目标出现 ${cut.n} 处（须恰好 1）—— 宁可报错，也不假绿`,
    )
  }
  /*
   * 🔴🔴 **A22 ⑮–㉑ 也有两条腿**（2026-10-05 修第二次 CI 红）：
   *    壳那一侧读的是 `PLUGIN2` / `BRIDGE2` / `MANIFEST2` / `RECV` / `ALARMS`
   *    —— 全在**仓库外**那份打包工程里（CI 的干净检出必然没有，`shellRead2` 回空串）；
   *    网页侧读的是 `NOTIFY` / `HOOK` / `SCHEDULE`（`app/` 下，CI 里**也有**）。
   *    🔴 事故：第三/四轮把 ⑤–㉑ 全加在**窗口外** ⇒ 壳那一侧那半读的是空串 ⇒
   *      `c8da6a1` / `056a54c` 两次 CI 都在这 15 条上红（本机却有打包工程 ⇒ 恒绿）。
   *    ⇒ 照本节 ①–④ / A21 ①–⑦ 那套**现成**的三态办：壳那一侧用 `shellSide()` 包起来
   *      （窗口内一律 `⚪ 灰（探不到，不红不绿）`、计入 `grayed`）；
   *      **网页侧留在窗口外逐条真判，一条都不许灰**（节末自证当场咬）。
   */
  let shellWide = 0 // 壳那一侧（下面这些窗口里）灰掉的条数
  let shellWideJudged = 0 // 壳那一侧真的判了的条数（打包工程在的机器上）
  /* 壳那一侧（⑮–㉑）**一共多少条判据** —— 节末自证拿它当边界，
     谁把某条挪进/挪出窗口（灰的范围开大/开小）那条自证当场红；加了新判据就把这个数跟着加。 */
  const SHELL_LEG_N = 22
  /**
   * 🔴 上面这 22 条里，**不依赖仓库外那份输入**（只吃内存里造出来的字符串）、
   *    **两台机器上都真判**的条数 —— 就是 ⑲-补 那条**形状自证**（`checkUngrayed`）。
   *
   * 2026-10-05（`dc34e8c` 那次 CI 红，第四次）补：原来它是**普通 `check`** ⇒ 壳不在的
   * 干净检出（= CI）里它**也落灰** ⇒ "判据自证"这条在 CI 上从没跑过（§三.1 那种静默 no-op：
   * 既不红也不绿、报告里照样写"通过"）。可它**一个字节都不读仓库外的文件** ⇒ 按本节
   * 定下的规矩（"只在**探不到**时灰，能在 CI 验的一条不许灰"）它**必须真判**。
   * ⇒ 单给它一个 `checkUngrayed` 的口，节末自证用这个数把账对平：
   *    壳不在 ⇒ 灰 `22 - 1 = 21` 条、真判 **1** 条；壳在 ⇒ 灰 0 条、真判 22 条。
   */
  const SHELL_CI_LEG_N = 1
  const shellSide = (fn) => {
    const g = grayed
    const j = passed + failures.length
    const was = shellGray
    /* 🔴 只在**探不到**（打包工程不在 = CI 的干净检出）时才允许落灰；
       打包工程在的机器上 `shellGray` 照旧是 `false` ⇒ 窗口内**逐条真判**，一条都不灰。 */
    shellGray = was || !SHELL_HERE2
    try {
      fn()
    } finally {
      shellGray = was
    }
    shellWide += grayed - g
    shellWideJudged += passed + failures.length - j
  }
  /**
   * 🔴 "**能在 CI 验的一条不许灰**"：⑲-补 那条**形状自证**只吃内存里造出来的字符串
   *    （`probeBody()` 拼的假桥接层），跟仓库外那份真桥接层**一个字节都不相干**
   *    ⇒ 它在 CI 上也得**真判**，不许落灰。
   * ⚠️ 所以只给它开这一个口：判这一条时把灰档**关一下**，判完立刻复原（`shellGray` 的账照旧）。
   * ⚠️ 它算"判了的"、而且不依赖仓库外那半 ⇒ 节末自证那本账认得它（`SHELL_CI_LEG_N`）。
   * 🔴 **别拿它去放行"真读仓库外文件"的判据** —— 那样节末自证的条数当场对不上，直接红。
   */
  const checkUngrayed = (ok, label, observed) => {
    const was = shellGray
    shellGray = false
    try {
      check(ok, label, observed)
    } finally {
      shellGray = was
    }
  }
  {
    /* 🧪 自证（可红）：这个口**真的绕过灰档** —— 灰档开着时普通 `check` 落灰、
       而 `checkUngrayed` 照旧计进"判了的"。谁把它改回普通 `check`（= 那条形状自证
       又变成 CI 上的静默 no-op），这一条当场红。
       ⚠️ 量完把计数器**原样复原**：这里只是"量一下这个口"，不该污染门禁的账
       （否则它自己那 1 灰 1 判会顶到 `appGray` / `shellWide` 上，节末自证反过来假红）。 */
    const g0 = grayed
    const c0 = shellGrayCount
    const p0 = passed
    const f0 = failures.length
    const was = shellGray
    const realLog = console.log
    console.log = () => {}
    let probeOK = false
    try {
      shellGray = true
      check(true, '自证占位（普通 check）', '灰')
      checkUngrayed(true, '自证占位（checkUngrayed）', '判')
      /*
       * 🔴 2026-10-05（修一个公式隐患，本轮发现）：原来写的是
       *    `passed + failures.length - p0 === 1` —— 把**绝对**的 `failures.length` 掺进了增量里
       *    ⇒ 只要它**前面有任何一条红**（`failures.length > 0`），这个差就恒 ≠ 1
       *    ⇒ 这条自证**被别人的红牵连**成假红（实测三档：前 0 红⇒绿 · 前 1 红⇒红 · 前 16 红⇒红）。
       *    ⇒ 基线上把**开始时的红数一起减掉**：`- (p0 + f0)`。
       *    改完三档：前 0 红⇒**绿** · 前 1 红⇒**绿**（不再被牵连）· **真增量 ≠ 1**（这个口没绕过
       *    灰档 / 没真判）⇒ 仍**当场红**。
       */
      probeOK = grayed - g0 === 1 && passed + failures.length - (p0 + f0) === 1
    } finally {
      console.log = realLog
      shellGray = was
      grayed = g0
      shellGrayCount = c0
      passed = p0
      failures.length = f0
    }
    check(
      probeOK,
      '🧪 A22 ⑲-补 自证②（可红）：`checkUngrayed` **真的绕过灰档**（灰档开着时它照样计进"判了的"），而普通 `check` 照旧落灰 —— 谁把它改回普通 `check`（= ⑲-补 那条"只吃内存形状"的自证又变回 CI 上的静默 no-op），这一条当场红',
      `灰档开着时：普通 check 灰了 1 条 / 改过的口判了 1 条 ⇒ 这个口绕过灰档=${probeOK}`,
    )
  }
  const BR_EXACT = /openExactAlarmSettings: function \(\) \{/
  const JAVA_EXACT = /public void openExactAlarmSettings\(PluginCall call\)/
  const EXACT_PAGE = /Settings\.ACTION_REQUEST_SCHEDULE_EXACT_ALARM/
  shellSide(() => { // ← 壳那一侧（⑮ 原生插件 · ⑯ 桥接层）
  check(
    JAVA_EXACT.test(PLUGIN2) && EXACT_PAGE.test(PLUGIN2),
    '🔴 A22 ⑮ 原生那侧**本来就有**"跳精确闹钟设置"的能力（`YlxbNativePlugin.openExactAlarmSettings` → `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`；**不是本轮新加的**，本轮只是把它挂出来）—— 缺了它，⑯ 那句"去系统设置"会跳到一个不存在的动作上',
    `插件方法=${JAVA_EXACT.test(PLUGIN2)} · 那一页=${EXACT_PAGE.test(PLUGIN2)}`,
  )
  check(
    BR_EXACT.test(BRIDGE2) && /N\.openExactAlarmSettings\(\)/.test(BRIDGE2),
    '🔴 A22 ⑯ 桥接层挂上了 `openExactAlarmSettings`（与 `openInstallPermissionSettings` 同一个口）—— **原生写好了、桥接层没挂**正是 `scheduleAlarms` 空了三天那个形态：网页侧无从调用，界面上看不出异常',
    `挂了方法=${BR_EXACT.test(BRIDGE2)} · 真的转给原生=${/N\.openExactAlarmSettings\(\)/.test(BRIDGE2)}`,
  )
  {
    /* 🧪 反向对照：把桥接那个方法**改名** ⇒ ⑯ 当场红（名字是两侧的约定，改了原生就白写） */
    const cut = oneEdit2(BRIDGE2, 'openExactAlarmSettings: function () {', 'openExactAlarmSettingsRenamed: function () {')
    check(
      cut.ok && !BR_EXACT.test(cut.text),
      '🧪 A22 ⑯ 反向对照：把桥接那个方法**改名**（内存副本）⇒ ⑯ 当场红 —— 名字是两侧的约定，改了原生那个 `@PluginMethod` 就白写',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${BR_EXACT.test(cut.text)}`,
    )
  }
  }) // ← 壳那一侧（⑮⑯）到此为止：下面 ⑯ 的**网页侧**那一条只读 `app/`，一条都不许灰
  const APP_EXACT = /export function shellCanOpenExactAlarmSettings\(\): boolean \{/
  const APP_OPEN = /export async function openExactAlarmSettings\(\): Promise<boolean> \{/
  check(
    APP_EXACT.test(NOTIFY) &&
      APP_OPEN.test(NOTIFY) &&
      /if \(typeof s\?\.openExactAlarmSettings !== 'function'\) return false/.test(NOTIFY) &&
      /await s\.openExactAlarmSettings\(\)/.test(NOTIFY),
    '🔴 A22 ⑯ 网页侧那条路也齐全：`shellCanOpenExactAlarmSettings()`（**能力门**：问 `__shell_out` 上这个方法在不在）+ `openExactAlarmSettings()`（真的调它）—— 「去系统设置」那句话只在这道门里面可达，网页版与两个 exe 上从结构上走不到',
    `能力门=${APP_EXACT.test(NOTIFY)} · 真的调=${APP_OPEN.test(NOTIFY)} · 先问能力=${/if \(typeof s\?\.openExactAlarmSettings !== 'function'\) return false/.test(NOTIFY)}`,
  )
  {
    /* 🧪 反向对照：把能力门那一句短路掉 ⇒ 上面那条当场红（= 网页版也会去调一个不存在的口） */
    const cut = oneEdit2(NOTIFY, "if (typeof s?.openExactAlarmSettings !== 'function') return false", 'if (false) return false')
    check(
      cut.ok && !/if \(typeof s\?\.openExactAlarmSettings !== 'function'\) return false/.test(cut.text),
      '🧪 A22 ⑯ 反向对照：把能力门那一句短路成 `if (false) return false`（内存副本）⇒ 上面那条当场红 —— 那正是"先试再谈成败"的坏法（网页版上也会去调一个不存在的口）',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }

  /*
   * ============================================================
   * ⑰–㉒ **2026-10-05 真机第四轮**：到点提醒"排了但不响"那一轮
   * ------------------------------------------------------------
   * 老师这轮实测（vc36）：
   *   ✓ 点「试一条通知」系统通知栏**真的弹了**（即时那条路通）
   *   ✓ 安装**真的跳到了**「闹钟与提醒」授权页（manifest 那条生效）
   *   ✗ **到点响的定时提醒不响**（14:20 坐在日程页上，14:21 该响，什么都没响）
   *   ✗ 工作台还挂着「提醒改在应用内显示。关掉应用就收不到了。／换一版应用可以收到系统通知。」
   *
   * 🔴 本轮**已查清**的两条（都不是猜的）：
   *   ① 那句误导话的**真凶**：`scheduleNativeReminders()` 在
   *      `alarms.length === 0` 时直接回 `false`（`notify.ts`）⇒ 与"排不上"撞在同一档。
   *      修法：`arm()` 里加"**空单子早退**"（判据 ⑪ 现在钉着这四个位置的顺序）。
   *   ② **两条路用了不同的渠道**（这一条才是"到点不响"里最贵的一处）：
   *      即时那条走 `CHANNEL_IMMEDIATE`（`shugao-default`，老师**验通了**），
   *      而到点那条原来兜底取 `CHANNEL_GENERAL`（`shugao_general`）⇒ 同一个功能两个渠道。
   *      修法：**一处定义**（`YlxbAlarmReceiver.CHANNEL_REMIND = YlxbNativePlugin.CHANNEL_IMMEDIATE`）
   *      + 网页侧交出去的单子也点名同一个 id（`SHELL_ALARM_CHANNEL`）。
   *
   * 🔴 最要紧的一条（⑲）：真实排程那条链**本机没有安卓设备，验不了** ——
   *   所以本轮加了「**两分钟后试一条定时提醒**」，它**必须走真实排程**
   *   （`YlxbAlarmReceiver` + `setExactAndAllowWhileIdle` + 同一个渠道），
   *   **不许**图省事去调即时通知（`ShugaoNative.notify`）—— 那是一次假绿。
   * ============================================================
   */

  /* ---------------- ⑰ manifest 里**有**那个接收器（没声明 = 闹钟响了没人接） ---------------- */
  shellSide(() => { // ← 壳那一侧（⑰ AndroidManifest 里的接收器声明）
  const RECV_DECL = /<receiver\s+android:name="\.YlxbAlarmReceiver"\s+android:exported="false"\s*\/>/
  check(
    RECV_DECL.test(MANIFEST2),
    '🔴 A22 ⑰ `YlxbAlarmReceiver` 在 `AndroidManifest.xml` 里**有** `<receiver>` 声明（`exported="false"` —— `AlarmManager` 那条是**显式** Intent，同应用内投递不经 intent-filter，所以不需要 filter；`exported=false` 只挡住外部应用伪造我们的闹钟）—— 没声明的话 `PendingIntent.getBroadcast` 到点**没有任何人接**，而界面上看不出任何异常',
    `声明在=${RECV_DECL.test(MANIFEST2)} · 文件里出现 receiver=${once2(MANIFEST2, '<receiver')} 个`,
  )
  {
    /* 🧪 反向对照：把那一行删掉（副本）⇒ ⑰ 当场红 */
    const cut = oneEdit2(MANIFEST2, '<receiver android:name=".YlxbAlarmReceiver" android:exported="false" />', '<!-- 接收器没了 -->')
    check(
      cut.ok && !RECV_DECL.test(cut.text),
      '🧪 A22 ⑰ 反向对照：把接收器那条声明删掉（内存副本 = 闹钟响了没人接的那一版）⇒ ⑰ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${RECV_DECL.test(cut.text)}`,
    )
  }
  }) // ← 壳那一侧（⑰）到此为止

  /* ---------------- ⑱ 渠道**同源**：一处定义、两侧引用（不许各写一份字面量） ----------------
   * 🔴 这一条是"到点不响"里最贵的一处：即时那条（老师验通的）在 `shugao-default`，
   *   而到点那条原来在 `shugao_general` —— 同一个功能两个渠道，
   *   老师在系统通知设置里看到两个开关，关掉一个就只有一半提醒会响。
   */
  const APP_CH_SAME = /export const SHELL_ALARM_CHANNEL = 'shugao-default'/.test(NOTIFY)
  const PLAN_USES = /channel: SHELL_ALARM_CHANNEL,/.test(NOTIFY)
  check(
    APP_CH_SAME && PLAN_USES,
    '🔴🔴 A22 ⑱（网页侧那半）**到点那条通知与即时那条用同一个渠道，而且这个 id 只有一处字面量**：接收器那句 `CHANNEL_REMIND = YlxbNativePlugin.CHANNEL_IMMEDIATE`（引用常量，**不是**再写一遍 `"shugao-default"`）、兜底真的用它；网页侧交出去的单子也点名同一个 id（`SHELL_ALARM_CHANNEL = \'shugao-default\'` + `channel: SHELL_ALARM_CHANNEL`）—— Android 8+ **往不存在的渠道发通知 = 当场被丢掉**（不抛错），而"哪条路用哪个渠道"分叉过一次就是这个 bug',
    `网页侧常量=${APP_CH_SAME} · 单子点名它=${PLAN_USES}`,
  )
  /* 壳那一侧那条腿（`YlxbAlarmReceiver.java`）：仓库外文件 ⇒ 走灰档 */
  shellSide(() => {
    const RECV_CH_SAME =
      /public static final String CHANNEL_REMIND = YlxbNativePlugin\.CHANNEL_IMMEDIATE;/.test(RECV)
    const RECV_USES = /if \(channel == null \|\| channel\.isEmpty\(\)\) channel = CHANNEL_REMIND;/.test(RECV)
    check(
      RECV_CH_SAME && RECV_USES,
      '🔴🔴 A22 ⑱（接收器那半）**到点那条通知与即时那条用同一个渠道**：接收器那句 `CHANNEL_REMIND = YlxbNativePlugin.CHANNEL_IMMEDIATE`（引用常量，**不是**再写一遍 `"shugao-default"`）、兜底真的用它 —— Android 8+ **往不存在的渠道发通知 = 当场被丢掉**（不抛错），"哪条路用哪个渠道"分叉过一次就是这个 bug',
      `接收器引用常量=${RECV_CH_SAME} · 接收器真的用它=${RECV_USES}`,
    )
  })
  {
    shellSide(() => { // ← 壳那一侧（⑱ 接收器那条反向对照）
    /* 🧪 反向对照：把接收器那个常量改回**各写一份字面量**的坏法（= 改之前）⇒ ⑱ 当场红 */
    const cut = oneEdit2(RECV, 'public static final String CHANNEL_REMIND = YlxbNativePlugin.CHANNEL_IMMEDIATE;', 'public static final String CHANNEL_REMIND = "shugao_general";')
    check(
      cut.ok && !/public static final String CHANNEL_REMIND = YlxbNativePlugin\.CHANNEL_IMMEDIATE;/.test(cut.text),
      '🧪 A22 ⑱ 反向对照：把接收器那个常量改回**自己写一份字面量**（内存副本 = 到点那条落进另一个渠道的那一版）⇒ ⑱ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${/public static final String CHANNEL_REMIND = YlxbNativePlugin\.CHANNEL_IMMEDIATE;/.test(cut.text)}`,
    )
    }) // ← 壳那一侧（⑱ 反向对照）到此为止
    /* 🧪 反向对照：把网页侧那个常量改成别的 id ⇒ ⑱ 的"两边同源"当场假 */
    const cut2 = oneEdit2(NOTIFY, "export const SHELL_ALARM_CHANNEL = 'shugao-default'", "export const SHELL_ALARM_CHANNEL = 'shugao_general'")
    check(
      cut2.ok && !/export const SHELL_ALARM_CHANNEL = 'shugao-default'/.test(cut2.text),
      '🧪 A22 ⑱ 反向对照：把网页侧那个渠道常量改成 `shugao_general`（内存副本 = 单子点名一个、原生兜底另一个）⇒ ⑱ 当场红 —— 两侧**必须逐字同源**',
      `目标出现 ${cut2.n} 处（须恰好 1）`,
    )
    /*
     * 🔴 **⑱-补：这个渠道真的被建过**（"往不存在的渠道发 = 静默丢掉"那条硬规矩）。
     *   ⚠️ 判的是**建渠道那一句**在不在（`createNotificationChannel(im)`），
     *     不是"常量在不在" —— 常量在、没人建，正是 2026-10-05 第三轮那个形状。
     */
    shellSide(() => { // ← 壳那一侧（⑱-补 建渠道 · ⑱-补② 量单渠道开关）
    const CREATED = /new NotificationChannel\(CHANNEL_IMMEDIATE, "到点提醒", NotificationManager\.IMPORTANCE_HIGH\)/.test(PLUGIN2) && /nm\.createNotificationChannel\(im\)/.test(PLUGIN2)
    check(
      CREATED,
      '🔴 A22 ⑱-补 `CHANNEL_IMMEDIATE`（`shugao-default`）**真的被 `ensureChannels()` 建过**（`new NotificationChannel(CHANNEL_IMMEDIATE, "到点提醒", IMPORTANCE_HIGH)` + `createNotificationChannel(im)`）—— 常量在、没人建，正是第三轮那个"通知被系统静默丢掉"的形状；而接收器第一句就是 `ensureChannels()`，所以到点那条一定发得进这个渠道',
      `常量建了=${/new NotificationChannel\(CHANNEL_IMMEDIATE, "到点提醒"/.test(PLUGIN2)} · 真的 create=${/nm\.createNotificationChannel\(im\)/.test(PLUGIN2)}`,
    )
    /*
     * 🔴 **⑱-补②："渠道在" ≠ "渠道开着"**（2026-10-05 真机第四轮）。
     *   Android 允许老师**单独关掉某一个渠道**，那时 `areNotificationsEnabled()` 照样 true，
     *   而往 `IMPORTANCE_NONE` 的渠道发通知 = **系统静默丢掉**（不抛错）
     *   ⇒ 自检必须把这一格单独量出来（不然它会把"渠道被关了"报成"全绿、就是没响"）。
     */
    const CH_OFF_DETECTED =
      /channelImportance = ch\.getImportance\(\);/.test(PLUGIN2) &&
      /channelOn = channelImportance != NotificationManager\.IMPORTANCE_NONE;/.test(PLUGIN2) &&
      /stage = "channelOff";/.test(PLUGIN2)
    check(
      CH_OFF_DETECTED,
      '🔴 A22 ⑱-补② 自检**单独量"那个渠道开着吗"**（`ch.getImportance() != IMPORTANCE_NONE` → `channelOn` → 断了就 `stage = "channelOff"`）—— `areNotificationsEnabled()` **管不到单渠道开关**，只量"渠道在不在"会把"「到点提醒」被关掉了"报成"全绿、就是没响"，而老师两秒就能自己开那一个开关',
      `读重要性=${/channelImportance = ch\.getImportance\(\);/.test(PLUGIN2)} · 判是否关着=${/channelOn = channelImportance != NotificationManager\.IMPORTANCE_NONE;/.test(PLUGIN2)} · 断了报 channelOff=${/stage = "channelOff";/.test(PLUGIN2)}`,
    )
    /* 🧪 反向对照：把"单渠道关着"这一档删掉（= 只量"渠道在不在"的坏法）⇒ 上面那条当场红 */
    const cut = oneEdit2(PLUGIN2, 'channelOn = channelImportance != NotificationManager.IMPORTANCE_NONE;', 'channelOn = true;')
    check(
      cut.ok && !/channelOn = channelImportance != NotificationManager\.IMPORTANCE_NONE;/.test(cut.text),
      '🧪 A22 ⑱-补② 反向对照：把"单渠道关着"这一档改成恒 `true`（内存副本 = 只量"渠道在不在"的坏法）⇒ 上面那条当场红',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
    }) // ← 壳那一侧（⑱-补 · ⑱-补②）到此为止：下面那条反向对照只读 `app/`，一条都不许灰
    {
      /* 🧪 反向对照：网页侧那一档分档话删掉 ⇒ ⑱-补② 当场红（读数有了、屏上不说） */
      const cut2 = oneEdit2(NOTIFY, "if (check.channelOn === false) {", 'if (false) {')
      check(
        cut2.ok && !/if \(check\.channelOn === false\) \{/.test(cut2.text),
        '🧪 A22 ⑱-补② 反向对照：把网页侧"渠道被单独关掉"那一档分档话删掉（内存副本 = 量到了却不说）⇒ 上面那条当场红',
        `目标出现 ${cut2.n} 处（须恰好 1）· 改完判据=${/if \(check\.channelOn === false\) \{/.test(cut2.text)}`,
      )
    }
  }

  /* ---------------- ⑲ 自检走的是**真实排程**，不是即时那条路 ----------------
   * 🔴 这一条是本节最贵的一条：老师点一次「两分钟后试一条定时提醒」，
   *   屏上就该看得出"排了几条 / 系统回什么 / 到点有没有进接收器 / 用的哪个渠道"。
   *   要是这个口偷偷走了 `ShugaoNative.notify`（即时那条，**已经验通的那条**），
   *   那么"自检通过"什么都证明不了 —— **假绿**（§三.1）。
   */
  /* 网页侧那条腿（只读 `app/src/lib/notify.ts`）—— **窗口外**，CI 里照旧逐条真判、不许灰 */
  const APP_SELF = /export async function runRemindSelfTest\(\)/.test(NOTIFY) && /typeof s\?\.remindSelfTest !== 'function'/.test(NOTIFY)
  check(
    APP_SELF,
    '🔴🔴 A22 ⑲（网页侧那半）自检那条路**先问能力**：`runRemindSelfTest()` 在桥接对象上没有 `remindSelfTest` 时如实回"这个版本还不能自检"，**不许假装跑过**（跑不了却报成功 = 假绿）',
    `网页侧能力门=${APP_SELF}`,
  )
  /* 壳那一侧那条腿（原生 `YlxbNativePlugin.java` + 桥接层 `shell-bridge-apk.js`）：仓库外文件 ⇒ 走灰档 */
  shellSide(() => {
  const JAVA_SELF = /public void remindSelfTest\(PluginCall call\)/
  const JAVA_SELF_VIA_REAL = /scheduleAlarms\(inner\);/.test(PLUGIN2)
  const JAVA_SELF_NO_NOTIFY = !/notifySelfTest\(\)/.test(PLUGIN2.slice(PLUGIN2.indexOf('public void remindSelfTest('), PLUGIN2.indexOf('public void remindSelfCheck(')))
  const BR_SELF = /remindSelfTest: function \(\) \{/.test(BRIDGE2)
  const BR_SELF_FWD = /N\.remindSelfTest\(\)/.test(BRIDGE2)
  const BR_SELF_NO_NOTIFY = !/N\.notify\(/.test(BRIDGE2.slice(BRIDGE2.indexOf('remindSelfTest: function () {'), BRIDGE2.indexOf('remindSelfCheck: function () {')))
  check(
    JAVA_SELF.test(PLUGIN2) && JAVA_SELF_VIA_REAL && JAVA_SELF_NO_NOTIFY && BR_SELF && BR_SELF_FWD && BR_SELF_NO_NOTIFY,
    '🔴🔴 A22 ⑲ 「两分钟后试一条定时提醒」**走的是真实排程那条链**：原生 `remindSelfTest()` **调的是 `scheduleAlarms(inner)` 本身**（不是另写一份、更不是走即时那条路）⇒ 与真实提醒共用同一个 `YlxbAlarms.scheduleAll` / `setExactAndAllowWhileIdle` / `YlxbAlarmReceiver` / 同一个渠道；桥接层与 `notify.ts` 都只转发它、**一个即时通知都不许出现在这一段里** —— 否则"自检通过"只证明即时那条（老师早就验通了），是一次假绿',
    `原生方法在=${JAVA_SELF.test(PLUGIN2)} · 走真实排程=${JAVA_SELF_VIA_REAL} · 原生那段没走即时=${JAVA_SELF_NO_NOTIFY} · 桥接层挂了=${BR_SELF} · 真的转发=${BR_SELF_FWD} · 桥接那段没走即时=${BR_SELF_NO_NOTIFY}`,
  )
  {
    /*
     * 🧪 反向对照：把自检里那一句**换成即时通知那条路**（= 最容易图省事的假绿写法）
     *    ⇒ ⑲ 当场红。⚠️ 这里替换的是**真实排程那一句**（必须恰好出现一次）。
     */
    const cut = oneEdit2(PLUGIN2, 'scheduleAlarms(inner);', 'notifySelfTest(call);')
    const stillReal = /scheduleAlarms\(inner\);/.test(cut.text)
    check(
      cut.ok && !stillReal,
      '🧪 A22 ⑲ 反向对照：把自检那一句换成**即时通知**那条路（内存副本 = "自检自己另开一条捷径"的假绿）⇒ ⑲ 当场红 —— 通了也证明不了到点会响',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完还走真实排程=${stillReal}`,
    )
  }
  }) // ← 壳那一侧（⑲ 原生 + 桥接层）到此为止

  /* ---------------- ⑲-补 桥接层**不许白名单挑键**：原生的读数必须整体透传 ----------------
   *
   * 🔴🔴 2026-10-05 真机第五轮：`remindSelfTest` / `remindSelfCheck` 在这一层是
   *    **白名单式重打包**（`return { notify: … , scheduled: … , why: … }`），
   *    于是原生**新加**的读数（`innerScheduled` / `innerRequested` / `innerExact`
   *    —— 见 `YlxbNativePlugin.java:558-560`）**被静默丢掉** ✗
   *    ⇒ `notify.ts` 的 `remindCheckHint()` 读到的全是 `undefined`
   *    ⇒ 屏上永远拼不出第二句「已排上 N 条 · 精确闹钟已允许／没允许」——
   *      真机第四轮老师点完只看到第一句，就是这么来的（同一形态第二次咬人：
   *      `remindSelfCheck` 那边五个键 `due` / `channel` / `notifyId` /
   *      `fallbackTitle` / `receiverError` 也是这么丢的）。
   *
   * ⚠️ **形态本身是可静态识别的**，不用跑真机：
   *    · ✅ 整体透传：`return r` / `return r || {…}` / `return JSON.parse(JSON.stringify(r))`
   *      / `Object.assign({}, r, {…})` —— **新加的读数自动到屏上**；
   *    · ❌ 白名单挑键：`return { a: r.a, … }` —— **每加一个原生读数都要人手跟一遍**，
   *      漏一次就是一个**看不见的**丢字（§三.5：不许静默）。
   *
   * 🔴 判据不许退化成"这两个方法名在不在"（那已经由 ⑲/⑳ 钉住了）——
   *    这里咬的是**键集**：从桥接那段真代码里数出它回上去的键，**与原生真回的键对齐**。
   *    原生回的是哪几个键**不是我列的表**，是**同一份 Java 源码里 `ret.put("…")` 数出来的**
   *    —— 判据与原生**同源**（写死一张表 = 下一次原生加读数时这张表也一起过时 ✗）。
   */
  shellSide(() => {
    /*
     * ⚠️ 这里自己带一份"剥注释"：A22 那个 `strip2`/`strip` 在**本节另一个块**里，
     *    跨块看不见（实测：`ReferenceError: strip is not defined` —— 门禁自己抛异常
     *    就是 §三.1 说的"自己吞异常"那类假绿，所以这里**一个字都不借**）。
     */
    const stripC = (s) =>
      String(s)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
    /**
     * 🔴 这两组就是**前端真的会读、而桥接层白名单丢掉**的那些读数（真机第四/五轮的账）：
     *    · `remindSelfTest` 的三个 `inner*` —— 丢了 ⇒ 屏上永远拼不出第二句
     *      「已排上 N 条 · 精确闹钟已允许／没允许」；
     *    · `remindSelfCheck` 的五个 —— 丢了 ⇒ 「定时提醒这条链是通的 · 渠道 … · 通知号 …」
     *      里渠道恒显示"未知"、通知号恒 -1。
     *
     * ⚠️ 这两组是从**前端**那份类型/读数函数里点出来的（`lib/notify.ts` 的
     *    `remindCheckHint()` / `remindFiredHint()`），**不是**原生回的全集：
     *    原生还回 `id` / `ok` / `stage` 这类**过程量**，桥接层本来就不转（它们只给原生自己用）
     *    —— 要求"原生每一个键都必须转上去"会把 `id` / `ok` 判红，那是**假红**
     *    （实测：头一版就是这么红的）。
     */
    const NATIVE_INNER = ['innerScheduled', 'innerRequested', 'innerExact']
    const NATIVE_FIRED = ['due', 'channel', 'notifyId', 'fallbackTitle', 'receiverError']
    /**
     * 桥接层里那个方法的**函数体**（抠不出 ⇒ 空串 ⇒ 下面几支全判假，不会空转）。
     *
     * 🔴 为什么用**扫描器**而不是正则找边界（这段源码的形态很坑，实测踩了四次）：
     *    ① `},` 出现在一大串缩进档上（`      },` / `            },` / `    },`）
     *       ⇒ 按"两空格的 `},`"找会匹配到别处，函数体一路吃到文件末尾；
     *    ② 用 `.catch(` 当结尾会被**注释**截住（注释里就写着 `.catch(` 这三个字）；
     *    ③ 用 `.then(` 当结尾会把**回调整个切掉** ⇒ 键集一个都数不到；
     *    ④ **行首缩进不可靠**：`strip()` 只剥注释，`\` 续行会把两行接成一行，
     *       行首空白会变（实测：`\n  },` 根本不存在，`  },\n` 才在）。
     * ✅ 唯一稳的办法：**按花括号配平**抠出 `name: function (…) { … }`，
     *    并且跳过字符串/模板字面量里的花括号（否则一句 `'{'` 就把配平带偏）。
     */
    const bodyOf = (src, name) => {
      const clean = stripC(String(src))
      const m = new RegExp(String.raw`(?:^|[,{\s])${name}\s*:\s*function\s*\([^)]*\)\s*\{`).exec(clean)
      if (!m) return ''
      const start = m.index + m[0].length - 1
      let depth = 0
      let q = ''
      for (let i = start; i < clean.length; i++) {
        const c = clean[i]
        if (q) {
          if (c === '\\') i++
          else if (c === q) q = ''
          continue
        }
        if (c === "'" || c === '"' || c === '`') {
          q = c
          continue
        }
        if (c === '{') depth++
        else if (c === '}' && --depth === 0) return clean.slice(m.index, i + 1)
      }
      return ''
    }
    /** 被**整对象摊开**的那些标识符（`{...r}` / `Object.assign({}, r, …)` 里的 `r`） */
    const spreadIdsOf = (s) =>
      [
        ...String(s).matchAll(
          /(?:\.\.\.|Object\.assign\(\s*(?:\{\s*\}\s*,\s*)?)\s*([A-Za-z_$][\w$]*)/g,
        ),
      ].map((m) => m[1])
    /**
     * 原生真回的键集 —— 这段 Java 方法里所有 `ret.put("…")`。
     * ⚠️ 用**没剥注释**的原生源码（`PLUGIN2` 是剥过注释的）：`ret.put` 是**代码**，
     *    注释里不会出现（真出现了也是不该有的重复，那一条由 D 支当场点名）。
     */
    const nativeKeysOf = (name) => {
      const src = shellRead2(PLUGIN2_REL)
      const i = src.indexOf(`public void ${name}(PluginCall call)`)
      if (i < 0) return []
      const rest = src.slice(i + 10)
      const j = rest.search(/public void \w+\(PluginCall call\)/)
      const seg = j > 0 ? rest.slice(0, j) : rest
      return [...seg.matchAll(/ret\.put\("([A-Za-z0-9_]+)"/g)].map((m) => m[1])
    }
    /**
     * ✅ 一条判据：这个 `.then()` 回调有没有**把原生那份对象整体带上去**。
     *
     * 认这几种（都不靠变量名叫什么，只看形状；先剥掉可能包在外面的一层 `{`）：
     *   · `return r` / `return r || {…}`       —— 直接透传；
     *   · `return JSON.parse(JSON.stringify(r))` —— 深拷贝透传；
     *   · `return { ...r, … }` / `Object.assign({}, r, {…})` —— 摊开进新对象。
     * ❌ 不认：`return { a: r.a, b: r.b }` —— **白名单挑键**：原生那份对象本身没被带上，
     *    于是**每加一个原生读数都要人手跟一遍**，漏一次就是一个看不见的丢字。
     * ⚠️ 抠不出 `.then(` / 抠不出那句 `return` ⇒ **当场假**（宁可报错，也不空转）。
     */
    const propOK = (src, name) => {
      const ret = thenReturnOf(src, name)
      if (!ret) return false
      const t = ret.trim().replace(/^\{\s*/, '')
      if (/^return\s+[A-Za-z_$][\w$]*\s*(\|\||;|$)/.test(t)) return true
      if (/^return\s+JSON\.parse\(\s*JSON\.stringify\(/.test(t)) return true
      return spreadIdsOf(t).length > 0
    }
    /** 这条原生读数在"这个方法的返回"里到得了屏上吗（整体透传 ⇒ 一定到） */
    const keyCarried = (src, name, k) => {
      const ret = thenReturnOf(src, name)
      if (!ret) return false
      /* 🔴 整体透传 ⇒ 这一条恒真：**别**再去这段里找键名（`return r` 里当然找不到 `due`）
         —— 头一版漏了这一句，于是"整体透传"的副本被判成"5 个读数全丢"（假红） */
      if (propOK(src, name)) return true
      if (spreadIdsOf(ret).length > 0) return true
      return new RegExp(`(?:^|[,{\\s])${k}\\s*:`).test(ret)
    }
    /**
     * `.then()` 回调里**那一句** `return`（取**最后**那句：守卫里也可能有 `return`）。
     *
     * ⚠️ 不能只取"最后一句"就完事 —— 守卫那句（`return Promise.resolve({…})`）
     *    也长得像"返回对象"，而且它排在前面 ⇒ 必须取**最后**那句。
     * ⚠️ 返回的是**整段表达式**（对象字面量是多行的，`return\s+(.+)` 那种按行取
     *    只拿得到 `return {` ⇒ 谓词恒假，实测踩过）。
     */
    const thenReturnOf = (src, name) => {
      const b = bodyOf(src, name)
      const i = b.indexOf('.then(')
      if (i < 0) return ''
      const j = b.indexOf('{', i)
      if (j < 0) return ''
      /* 花括号配平：只取 `.then(function (r) { … })` 这一段，**不含**后面的 `.catch(` */
      let depth = 0
      let seg = ''
      for (let k = j; k < b.length; k++) {
        if (b[k] === '{') depth++
        else if (b[k] === '}' && --depth === 0) {
          seg = b.slice(i, k + 1)
          break
        }
      }
      if (!seg) return ''
      const r = seg.lastIndexOf('return')
      if (r < 0) return ''
      const raw = seg.slice(r).replace(/[;)\s]+$/, '')
      return raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw
    }
    /**
     * 🧪 形状自证（可红）：`[守卫那句, 回调 return 的那句, 期望]`
     * ⚠️ 两个方向都要有：**透传的几种写法**判过、**白名单挑键的几种写法**判假
     *    —— 缺任何一边，这个谓词都可能变成"永远为绿的摆设"（§三.1）。
     */
    const PROBE = [
      ['if (!N || !N.remindSelfCheck) return Promise.resolve({ unsupported: true })', 'return r', true],
      ['if (!N) return Promise.resolve({})', 'return r || { ok: false }', true],
      ['if (!N) return Promise.resolve({})', 'return JSON.parse(JSON.stringify(r))', true],
      ['if (!N) return Promise.resolve({})', 'return Object.assign({}, r, { unsupported: false })', true],
      ['if (!N) return Promise.resolve({})', 'return { ...r, unsupported: false }', true],
      ['if (!N) return Promise.resolve({})', 'return { ok: !!(r && r.ok), why: (r && r.why) || "" }', false],
      ['if (!N) return Promise.resolve(0)', 'return r && typeof r.sdk === "number" ? r.sdk : 0', false],
      ['if (!N) return Promise.resolve(0)', 'return r.sdk', false],
      ['if (!N) return Promise.resolve(false)', 'return !!(r && r.ok)', false],
      ['if (!N) return Promise.resolve({})', 'return { fired: !!(r.fired), elapsed: !!(r.elapsed) }', false],
    ]
    /**
     * 探针的载体 —— **必须长得像真桥接层**：方法名 + 上一句守卫的 `return` +
     * 后面的 `.catch(` 兜底 + 下一个方法。
     * 🔴 少了"下一个方法那个逗号"，`bodyOf` 的方法名定位会匹配不上（实测：整段恒空）。
     */
    const probeBody = (req, ret) =>
      `bridge = {\n    probe: function () { ${req}\n      return N.remindSelfCheck()\n.then(function (r) { ${ret}; }).catch(function () {})\n    },\n\n    nextOne: function () {}\n  }`
    /* 🔴 用 `checkUngrayed`：这条只吃**内存里造出来的**形状（`probeBody()`），
       不读仓库外那份桥接层 ⇒ 按"能在 CI 验的一条不许灰"，它在 CI 上也得真判 */
    checkUngrayed(
      PROBE.every(([req, ret, want]) => propOK(probeBody(req, ret), 'probe') === want),
      '🔴 A22 ⑲-补 判据自证（形状，可红）：这个谓词**认得出"整体透传"与"白名单挑键"两种形态** —— `return r` / `return r || {…}` / `return JSON.parse(JSON.stringify(r))` / `{...r}` / `Object.assign({}, r, {…})` 判过 · `return { a: r.a }` / `return r.sdk` / `return !!(r && r.ok)` 判假；**谁把它改成恒真/恒假，这条当场红**',
      PROBE.map(([req, ret, want]) => `「${ret}」→${propOK(probeBody(req, ret), 'probe') ? '整体透传' : '白名单挑键'}（期望 ${want ? '整体透传' : '白名单挑键'}）`).join(' · '),
    )

    /**
     * 🔴 主判据：桥接层**不许白名单挑键** —— 屏幕上要读的那几个读数，一个都不许在半路丢掉。
     *
     * 判过（二选一）：① **整体透传**（`return r` / 深拷贝 / `{...r}`）——
     *    以后原生再加读数**自动**到屏上，不用人手跟；或 ② 那个读数在这段返回值里**真的在**
     *    （键集与原生同源）。
     * ⚠️ 只有**前端真的会读**的那几个（`NATIVE_INNER` / `NATIVE_FIRED`）算数：
     *    原生还回 `id` / `ok` / `now` 这类**过程量**，桥接层不转它们是对的
     *    —— 要求"原生每个键都上来"会当场假红（实测：头一版就是被 `id` / `ok` 判红的）。
     */
    const droppedOf = (src, name, ks) => ks.filter((k) => !keyCarried(src, name, k))
    const RULES = [
      ['remindSelfTest', NATIVE_INNER],
      ['remindSelfCheck', NATIVE_FIRED],
    ]
    for (const [name, ks] of RULES) {
      const nats = nativeKeysOf(name)
      const lost = droppedOf(BRIDGE2, name, ks)
      const pass = propOK(BRIDGE2, name)
      check(
        nats.length > 0 && (pass || lost.length === 0),
        `🔴 A22 ⑲-补 桥接层的 \`${name}\` **不许白名单挑键**：屏幕要读的 ${ks.length} 个读数（${ks.join(' / ')}）一个都不许在半路丢掉 —— 要么**整体透传**（\`return r\` / 深拷贝 / \`{...r}\`，以后原生加读数自动到屏），要么这几个键**真的在**`,
        nats.length === 0
          ? `抠不出原生 \`${name}\` 的 \`ret.put(…)\` ⇒ **判据当场假**（宁可报错，也不空转）`
          : `整体透传=${pass} · 屏上要读的这几个里**到不了的：${lost.length ? lost.join(' · ') : '无'}**`,
      )
    }
    check(
      NATIVE_INNER.every((k) => nativeKeysOf('remindSelfTest').includes(k)) &&
        NATIVE_FIRED.every((k) => nativeKeysOf('remindSelfCheck').includes(k)),
      '🔴 A22 ⑲-补 自证①（原生那侧真回了这些读数）：`remindSelfTest` 回 `innerScheduled` / `innerRequested` / `innerExact`（`YlxbNativePlugin.java:558-560` 那三句 `ret.put`）· `remindSelfCheck` 回 `due` / `channel` / `notifyId` / `fallbackTitle` / `receiverError` —— 这两组就是真机第五轮差点被桥接层丢掉的那几个',
      `remindSelfTest 有 ${NATIVE_INNER.filter((k) => nativeKeysOf('remindSelfTest').includes(k)).length}/3 · remindSelfCheck 有 ${NATIVE_FIRED.filter((k) => nativeKeysOf('remindSelfCheck').includes(k)).length}/5`,
    )
    {
      /* 🧪 反向对照：把 `remindSelfCheck` 改成**白名单挑键**（内存副本）⇒ 上面那条**当场假** */
      const target = 'return N.remindSelfCheck()'
      const a = BRIDGE2.split(target).length - 1
      /**
       * 🔴🔴 **2026-10-05 第四次 CI 红（`dc34e8c`，第 7 步 `nav-checks`）**：这个计数守卫
       *    原来是**无条件** `throw` —— 而灰档（`shellGray`）**只罩 `check()`，罩不住 `throw`** ✗
       *    ⇒ 壳不在的干净检出（= CI，打包工程不进这个公开仓库）里 `BRIDGE2` 是**空串**
       *    ⇒ 目标出现 **0** 处 ⇒ 当场抛 ⇒ **整个脚本死在半路**（`withLock` 只有 `finally`、
       *    不接异常）⇒ 比"判红一条"更糟：**这一节剩下的、后面所有节一条都没跑，报告也没有**。
       *    （本机有打包工程 ⇒ `a === 1` ⇒ 恒绿 ⇒ 又一次"本机有的东西 CI 没有"。）
       * ✅ 分两种情况，判据本身一个字没放宽：
       *    · **读不到源**（空串 = 壳不在）：**不抛** —— 交给下面的 `check` 走灰档
       *      （灰只该在"探不到"时出现）；
       *    · **读到了源却数不到恰好 1 处**（被改名/删掉/多出一份）：照旧**当场抛**
       *      （真坏就得响；而且这种情形下壳是在的 ⇒ `shellGray` 为 `false` ⇒
       *      下面那两条 `check` 也会如实判红，不会静默）。
       *    判据**单独拎成 `shouldThrow`**：下面有一条自证咬它（内联的话自证只能咬一份副本）。
       */
      const shouldThrow = (src) => src !== '' && src.split(target).length - 1 !== 1
      if (shouldThrow(BRIDGE2))
        throw new Error(`A22 ⑲-补：目标「${target}」在桥接层出现 ${a} 处（必须恰好 1）`)
      /* 🧪 自证（可红）：把守卫改回"无条件抛"（= `dc34e8c` 那份写法）⇒ 这条当场红；
         三个方向都钉住：空串**不抛** · 真源（恰好 1 处）**不抛** · 多出一处**抛** */
      check(
        shouldThrow('') === false &&
          shouldThrow(BRIDGE2) === false &&
          shouldThrow(`${BRIDGE2}\n${target}`) === true,
        '🧪 A22 ⑲-补 自证③（可红）：那个计数守卫**只在"读到了源却数不到恰好 1 处"时才抛**——**源读不到（空串 = 壳不在 = CI）时不许抛**（抛了就是 `dc34e8c` 那次"第 7 步死在半路"）；谁把它改回无条件 `if (a !== 1) throw`，这条当场红',
        `空串 ⇒ 抛=${shouldThrow('')}（期望 false）· 真源 ⇒ 抛=${shouldThrow(BRIDGE2)}（期望 false）· 目标多出一处 ⇒ 抛=${shouldThrow(`${BRIDGE2}\n${target}`)}（期望 true）`,
      )
      const mutated = BRIDGE2.replace(
        target,
        'return N.remindSelfCheck().then(function (r) { return { fired: !!(r && r.fired), elapsed: !!(r && r.elapsed) } })',
      )
      const mLost = droppedOf(mutated, 'remindSelfCheck', NATIVE_FIRED)
      check(
        mutated !== BRIDGE2 && mLost.length === NATIVE_FIRED.length,
        '🧪 A22 ⑲-补 反向对照：把 `remindSelfCheck` 改成**白名单挑键**（内存副本 = 这个形态原本的样子）⇒ 上面那条**当场假** —— 原生那五个读数（`due` / `channel` / `notifyId` / `fallbackTitle` / `receiverError`）一个都到不了屏上',
        `目标出现 ${a} 处（须恰好 1）· 到不了屏上 ${mLost.length}/${NATIVE_FIRED.length} 个：${mLost.join(' · ')}`,
      )
      /* 🧪 反方向：副本改成**整体透传** ⇒ 上面那条**判过**（证明它认得出修好的样子，不是恒假） */
      const repaired = BRIDGE2.replace(
        target,
        'return N.remindSelfCheck().then(function (r) { return JSON.parse(JSON.stringify(r)) })',
      )
      check(
        repaired !== BRIDGE2 && propOK(repaired, 'remindSelfCheck') && droppedOf(repaired, 'remindSelfCheck', NATIVE_FIRED).length === 0,
        '🧪 A22 ⑲-补 反向对照（反方向）：把同一个口改成**整体透传**（内存副本 = 修好之后的样子）⇒ 上面那条**判过**、屏幕要读的五个读数**全部到得了屏上** —— 证明这条判据不是恒假的一张贴纸',
        `改完整体透传=${propOK(repaired, 'remindSelfCheck')} · 到不了屏上 ${droppedOf(repaired, 'remindSelfCheck', NATIVE_FIRED).length} 个`,
      )
    }
  }) // ← 壳那一侧（⑲-补）到此为止

  /* ---------------- ⑳ 每一步的中间结果都回读到屏上（排了几条 / 到没到 / 哪个渠道） ---------------- */
  /* 壳那一侧（桥接层的"到点回读"口）：仓库外文件 ⇒ 走灰档 */
  shellSide(() => {
    const BR_FIRED = /remindSelfCheck: function \(\) \{/.test(BRIDGE2) && /N\.remindSelfCheck\(\)/.test(BRIDGE2)
    check(
      BR_FIRED,
      '🔴 A22 ⑳（壳侧那半）桥接层挂了"到点回读"那个口（`remindSelfCheck` + 真的转给 `N.remindSelfCheck()`）—— 网页侧无从调用时，屏上永远只剩"排上了"，到点响没响看不到',
      `桥接层回读=${BR_FIRED}`,
    )
  }) // ← 壳那一侧（⑳）到此为止：下面那条只读 `app/`，一条都不许灰
  const APP_FIRED =
    /export async function runRemindSelfCheck\(\)/.test(NOTIFY) &&
    /export function remindCheckHint\(/.test(NOTIFY) &&
    /export function remindFiredHint\(/.test(NOTIFY)
  /**
   * 🆕 **期望值 2026-10-05/06 变了**（用户：「日程里面两个测试按钮可以删除了」）：
   *    日程页那颗「两分钟后试一条定时提醒」**已撤** ⇒ 这一半从"页面真的用它们"
   *    翻成"页面**不再**接它们"。
   * 🔴 为什么能力那一半照旧判绿：`runRemindSelfCheck()` / `remindCheckHint()` /
   *    `remindFiredHint()`（还有桥接层与原生两半）**一个都没删** ——
   *    用户要撤的是**入口**，排查能力要留着（将来还要排障）。
   */
  const pageFired2 = (s) =>
    /await runRemindSelfTest\(\)/.test(s) ||
    /push\(remindCheckHint\(r, sdk\)\)/.test(s) ||
    /watchRemindSelfCheck\(/.test(s)
  const PAGE_FIRED = pageFired2(SCHEDULE)
  check(
    APP_FIRED && !PAGE_FIRED,
    '🔴 A22 ⑳（网页侧那半）`remindCheckHint()` / `remindFiredHint()` 这些**分步读数**照旧在 `notify.ts` 里（能力留）；而日程页那颗「两分钟后试一条定时提醒」入口**已撤**（用户 2026-10-05/06 要求，见 ④-④）—— 页面**不再**接它们，但将来要排障时那条路整条都还在',
    `网页侧三个纯函数=${APP_FIRED} · 页面仍接它们=${PAGE_FIRED}（须 false）`,
  )
  {
    /* 🧪 反向对照：把页面那一整段接线**塞回源码副本** ⇒ ⑳ 当场红（锚点 = 撤掉之前
       紧挨着的那句横幅三目，剥注释后恰好 1 处）。
       ⚠️ `oneEdit2` 先数出现次数（≠1 就判 `ok:false`），宁可报错也不假绿。 */
    const cut = oneEdit2(
      SCHEDULE,
      '{showPermBanner ? (',
      'const sdk = 0\nconst r = await runRemindSelfTest()\npush(remindCheckHint(r, sdk))\nwatchRemindSelfCheck((f) => push(remindFiredHint(f)))\n{showPermBanner ? (',
    )
    check(
      cut.ok && pageFired2(cut.text),
      '🧪 A22 ⑳ 反向对照：把那一整段接线（`runRemindSelfTest` / `remindCheckHint` / `watchRemindSelfCheck` + `remindFiredHint`）**塞回源码副本**（= 撤掉之前的形态）⇒ ⑳ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完"仍接它们"=${pageFired2(cut.text)}`,
    )
  }

  /* ---------------- ㉑ `scheduled` 必须是"**真的排上了几条**"，不是"传进来几条" ----------------
   * 🔴 回"传进来几条"就会把一次**一条都没排上**报成成功 ⇒ 网页侧那个能力门
   *   （`r.scheduled > 0`）永远为真 ⇒ 界面上看不出任何异常（§三.5）。
   */
  shellSide(() => { // ← 壳那一侧（㉑ 调度核 `YlxbAlarms.java` + 原生插件）
  const ALARMS_COUNTS = /if \(registerOne\(ctx, am, alarms\.getJSONObject\(i\), exact\)\) scheduled\+\+;/.test(ALARMS)
  const ALARMS_RETURNS = /return scheduled;/.test(ALARMS)
  const JAVA_USES_COUNT = /int scheduled = YlxbAlarms\.scheduleAll\(getContext\(\), list\);/.test(PLUGIN2) && /ret\.put\("scheduled", scheduled\);/.test(PLUGIN2)
  check(
    ALARMS_COUNTS && ALARMS_RETURNS && JAVA_USES_COUNT,
    '🔴 A22 ㉑ `scheduleAll` 回的是**真的排上了几条**（过期的那些会被跳过，所以它 ≠ 传进来几条），原生插件把它如实转给网页侧（`ret.put("scheduled", scheduled)`）—— 回"传进来几条"就会把一次**一条都没排上**报成成功，而网页侧那个能力门（`scheduled > 0`）永远为真 ⇒ 界面上看不出任何异常',
    `调度核数真的排上几条=${ALARMS_COUNTS} · 回这个数=${ALARMS_RETURNS} · 原生照它转=${JAVA_USES_COUNT}`,
  )
  {
    /* 🧪 反向对照：把它改回"传进来几条"（= 改之前的写法）⇒ ㉑ 当场红 */
    const cut = oneEdit2(PLUGIN2, 'ret.put("scheduled", scheduled);', 'ret.put("scheduled", list.length());')
    check(
      cut.ok && !/ret\.put\("scheduled", scheduled\);/.test(cut.text),
      '🧪 A22 ㉑ 反向对照：把它改回 `ret.put("scheduled", list.length())`（内存副本 = 改之前那份"排 0 条也回成功"的写法）⇒ ㉑ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }
  }) // ← 壳那一侧（㉑）到此为止

  /* ---------------- ㉒ `canScheduleExact` 的读数**切回前台会被重读** ----------------
   * 🔴 老师已经授权过，应用却还按旧读数说"排不了" —— 就是"只在启动时读一次"那个形态。
   *   形状可静态识别：`arm()` 的**第一句**就是 `canScheduleExactNative()`，
   *   而"回到前台"那两个监听（`visibilitychange` + `focus`）挂的是**会重跑 arm** 的那个函数。
   */
  const READ_FIRST = /const canExactNow = await canScheduleExactNative\(\)/.test(HOOK)
  const REARM_ON_VISIBLE =
    /document\.addEventListener\('visibilitychange', rearm\)/.test(HOOK) &&
    /window\.addEventListener\('focus', rearm\)/.test(HOOK)
  const REARM_CALLS_ARM = /const rearm = \(\) => \{[\s\S]{0,200}void arm\(\)/.test(HOOK)
  check(
    READ_FIRST && REARM_ON_VISIBLE && REARM_CALLS_ARM,
    '🔴🔴 A22 ㉒ `canScheduleExact` 那个读数**切回前台会被重读**（不是"只在启动时读一次"）：`arm()` 的第一句就是 `canScheduleExactNative()`，而"回到前台"那两个监听（`visibilitychange` **和** `focus`，部分安卓 WebView 只发后者）挂的都是会重跑 `arm()` 的那个函数 ⇒ 老师去「闹钟和提醒」把开关打开、切回来，界面上那句误导话才会跟着消失',
    `先读=${READ_FIRST} · 两个监听都在=${REARM_ON_VISIBLE} · 监听真的重跑 arm=${REARM_CALLS_ARM}`,
  )
  {
    /* 🧪 反向对照：把"回到前台重跑"那一句去掉（= "只在启动时读一次"的坏法）⇒ ㉒ 当场红 */
    const cut = oneEdit2(HOOK, "document.addEventListener('visibilitychange', rearm)", "document.addEventListener('visibilitychange', () => {})")
    check(
      cut.ok && !/document\.addEventListener\('visibilitychange', rearm\)/.test(cut.text),
      '🧪 A22 ㉒ 反向对照：把"回到前台重跑"那一句去掉（内存副本 = 只在启动时读一次的坏法）⇒ ㉒ 当场红',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }

  /*
   * ✅ **怎么真机验**（本机没有安卓设备 ⇒ 这一节全是静态判据，**没有一条**是真机验过的）：
   *
   * 🔴 2026-10-05 真机**第四轮**的复验步骤（这一版是给"到点提醒不响"那一轮收口的）：
   *
   * ① **先开权限（一遍就够，之后不用再开）**：装新 apk → 系统设置 → 其他特殊权限 →
   *    「闹钟和提醒」⇒ 列表里应当有「树高教务通」，把那个开关**打开**。
   *
   * ② **验那条坏的链**（这一轮的主角）：超管账号登录 → 「日程」页 →
   *    点「**两分钟后试一条定时提醒**」⇒ 屏上应当立刻出现一句
   *    「**两分钟后会响一条定时提醒**」，并且**带上两个数**：
   *    「已排上 N 条 · 精确闹钟已允许／没允许」（N 应当 ≥ 1）。
   *    ⇒ 然后**把应用切到后台**（或者就停在这一页等），两分钟后通知栏应出现
   *    一条标题「**树高教务通 · 提醒**」的通知。
   *    ⚠️ 若没响：屏上会**自己说出是哪一环**，照下面的读数报给维护者：
   *      · 「系统里通知是关着的」        → 去系统里把这个应用的通知打开
   *      · 「还没允许本应用发通知」      → 13+ 的 POST_NOTIFICATIONS 没给
   *      · 「通知渠道没建起来」          → 要装新版本才能修
   *      · 「定时提醒没排上 ＋ 系统只收下 0 条（单子里 1 条）」→ 断在**排程**（AlarmManager）
   *      · 「到点了但没响 · 该响 HH:MM:SS · 接收器读到没到 · 渠道 … · 通知号 …」
   *        → 断在**接收器 / 通知**那一环（渠道那一格必须显示 `shugao-default`）；
   *          若都正常却仍没响，看那句「报错 …」的原文。
   *      · 「还没到点」                  → 只是时间没到（**灰**，不是坏）
   *
   * ③ **验即时那条**（上一轮修好的，别退化）：点「**试一条通知**」⇒
   *    通知栏应当出现「测试通知」（带应用图标）。
   *
   * ④ **验真实提醒**：停在「日程」页（让网页把那张单子交给系统）⇒ **把应用划掉** ⇒
   *    到下一节课「课前 10 分钟」时通知栏应出现「10 分钟后上课 · 班级 · 地点 · 时间」
   *    —— 应用**是关着的**。
   *
   * ⑤ **验那句误导话没了**：把上面 ① 的开关**关掉**再切回应用 ⇒
   *    工作台那句「提醒改在应用内显示。关掉应用就收不到了。／换一版应用可以收到系统通知。」
   *    不应当再出现（那句只在"**确实排不上**"时才说，不再被"今天没有要响的提醒"顶出来）。
   */
  {
    /* 照 A21 ⑪ 的先例：这一条**故意用原始文本**（"真机未验"这几个字只能写在注释里） */
    const APP2 = [
      ['src/lib/notify.ts', readApp('src/lib/notify.ts')],
      ['src/hooks/useScheduleReminder.ts', readApp('src/hooks/useScheduleReminder.ts')],
    ]
    const SHELL2 = [
      ['shell-bridge-apk.js', shellRead2(BRIDGE2_REL)],
      ['YlxbNativePlugin.java', shellRead2(PLUGIN2_REL)],
    ]
    /* app 侧那两份**永远**要查；壳侧两份只在打包工程真的在的那台机器上一起查（三态） */
    const RAW2 = SHELL_HERE2 ? [...SHELL2, ...APP2] : APP2
    const silent2 = RAW2.filter(([, t]) => !/真机未验/.test(t)).map(([n]) => n)
    check(
      silent2.length === 0,
      `🔴 A22 ⑧ ${SHELL_HERE2 ? '四份' : 'app 侧那两份（壳侧两份本机没有 ⇒ 一并查不了）'}源码的**注释**里都照实写着"真机未验"（本机没有安卓设备，别假装验过）`,
      silent2.length ? `没写：${silent2.join(' · ')}` : `${RAW2.length} 份都写了：${RAW2.map(([n]) => n).join(' · ')}`,
    )
    /* 🔴 **节末自证（可红）**：三态那两条边界 ——
       ① 壳不在时（= CI 的干净检出）：壳那一侧（①–④ 与 ⑮–㉑）**全落灰、一条都没判**，
          而**网页侧**（⑤–⑧ · ⑯⑱⑲⑳网页侧那几半 · ㉒）**一条都没灰**；
       ② 壳在时（维护者本机）：壳那一侧**真的判了**，而且一条都不灰。
       ⚠️ 谁把灰的范围**开大**（罩到网页侧那半）或**开小**（壳侧漏在外面），这条当场红。
       ✅ 2026-10-05：这里原来有一句手工 `shellGray = false`，**已删** ——
         本节的灰档由 `shellSide()` 的 `finally` 复原（它只在本节 ⑮–㉑ 那几段内开），
         而"跨节"那一层由 `section()` **每次开新节强制收口**兜住 ⇒ 不再需要这句。
         它留着反而掩盖了"跨节泄漏"这件事（**已实测：删掉它，本节自证照旧绿**）。 */
    const appGray = grayed - g1b - shellWide // 窗口外灰掉的 = 只能来自"灰的范围开大了"
    const shellLegOK =
      /* 🔴 壳那一侧（⑮–㉑）一共就是这 `SHELL_LEG_N` 条：壳在 ⇒ **全真判、一条不灰**；
         壳不在 ⇒ 灰 `SHELL_LEG_N - SHELL_CI_LEG_N` 条、真判 **`SHELL_CI_LEG_N`** 条
         —— 那一条是 ⑲-补 的**形状自证**：它只吃内存里造出来的假桥接层
         （`probeBody()`）、**一个字节都不读仓库外**，按"能在 CI 验的一条不许灰"它必须真判。
         **谁把某条挪进/挪出窗口（= 把灰的范围开大/开小），这条当场红**
         （两个方向、两台机器上都能红，不只是 CI 上）。 */
      shellWide + shellWideJudged === SHELL_LEG_N &&
      (SHELL_HERE2 ? shellWide === 0 : shellWideJudged === SHELL_CI_LEG_N)
    const shellHeadOK = SHELL_HERE2 ? shellJudged2 > 0 : shellJudged2 === 0
    check(
      shellLegOK && shellHeadOK && appGray === 0,
      '🔴 A22 自证（三态）：壳那一侧（①–④ · ⑮–㉑）在壳不在时**只剩那条"只吃内存形状"的形状自证真判、其余全落灰**、壳在时**逐条真判、一条都不灰**；**网页侧一条都没灰** —— 忘关/忘开那个开关、把灰的范围开到网页侧那半、把壳侧某条挪进/挪出窗口、或把那条"能在 CI 验"的形状自证又罩回灰档（= CI 上的静默 no-op），这条当场红',
      `壳在=${SHELL_HERE2} · 壳侧①–④ 判了 ${shellJudged2} 条 / 灰了 ${g1b - g0b} 条 · 壳侧⑮–㉑ 共 ${SHELL_LEG_N} 条：判了 ${shellWideJudged} 条（壳不在时期望 ${SHELL_CI_LEG_N} 条）/ 灰了 ${shellWide} 条 · 网页侧灰了 ${appGray} 条`,
    )
  }
}

/* ============================================================
   第二十八节 · A23：点「发布」吞字 —— **提交读屏、不读 state**（2026-10-05 真机反馈）
   ------------------------------------------------------------
   用户（真安卓手机 · `树高教务通-教师端-v1.1.2-vc32.apk` · **公告发布界面**）原话：
     「我打的是汉字，**在我全部输完以后**，点击**发布**按钮后它**吞了我几个字**」。
   ⇒ 字已经选好词、已经在框里（不是还挂在候选条上），是**点发布那一刻**少掉的。

   🔴 **上一版为什么没解决**：`src/lib/imeMirror.ts`（`da9ad45`，本包**已经含**）的前提是
      「`composition*` 一定会来，补派发一个 `input` 就一定让 React 跟上屏」——
      真机上这条前提**不成立**（有些安卓输入法 / WebView 不发组合事件；就算发了，
      点击触发的重渲染是**同步**的，它经常排在组字提交**前面**）。
      ⇒ 修法必须**不依赖任何输入法事件**。

   🔴 断在哪（vc32 的两个位置）：
     ① **提交读的是 state**：`Admin.tsx` 的 `doSet()` 把渲染期闭包里的 `note` 交给 `setRelease()`
        ⇒ 安卓上最后一次 `onChange` 若排在点击**之后**，发出去的正文少那几个字，
        **同时**那次重渲染把旧 `note` 写回受控的 `value=` ⇒ **框里也没了**（两个症状同源）。
     ② **提交路径上改写用户输入**：版本号框 `onChange={(e) => changeVersion(e.target.value.trim())}`
        （每击键 `.trim()` 一次 = 不变量 I-输入-2）+ 正文框 `maxLength`（原生上限在组字时**静默截断**）。

   ✅ 修法（`src/lib/liveInput.ts` + `Admin.tsx` 的 `ReleaseSlotForm`）：
     · 正文框改成**非受控**（`defaultValue` + `noteRef`）：React 一个字都不往框里写
       ⇒ 丢字**从结构上不可能**；我们自己要替换它（服务端预填 / 版本或档位联动）走唯一的 `applyNote()`。
     · 点「发布」/「撤下」时**先读 DOM**（`liveValue`）→ 写回 state → 用**读回来的那一份**重算
       `validateReleaseForm()`；不 ok ⇒ **显式报错、不发布**（不静默截断、不截断后照发）。
     · 另外三个框照旧受控（要靠服务端预填与版本联动）⇒ 它们走"提交前读回"。
     · 去掉 `maxLength` 与 `onChange` 里的 `.trim()`。

   ⚠️ 本机没有安卓设备 ⇒ 这一节全是**静态**判据（**没有一条**是真机验过的）；
      真机验收只能由用户做（复验步骤写在本节末尾的注释里）。
   ============================================================ */
section('第二十八节 · A23：公告「发布」吞字（正文非受控 + 提交前从 DOM 读回）')

{
  /** 剥注释（照 A21/A22 的写法）：判据只许看**真代码**（注释里写"不许用某个东西"不算命中） */
  const strip3 = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  /** 🔴 反向对照的前置：目标串必须**恰好出现一次**再替换（`AGENTS.md` §三.2） */
  const once3 = (t, s) => t.split(s).length - 1
  const oneEdit3 = (t, from, to) =>
    once3(t, from) === 1 ? { ok: true, n: 1, text: t.replace(from, to) } : { ok: false, n: once3(t, from), text: t }

  const LIVE_SRC = strip3(readApp('src/lib/liveInput.ts'))
  const ADMIN = strip3(readApp('src/pages/Admin.tsx'))
  /*
   * 🔴 只取**发布表单那一个组件**（`ReleaseSlotForm`）再判：
   *    `Admin.tsx` 里别的卡（维护模式 / 错误日志 / 教师账号…）也有输入框，
   *    不切片就会把它们的 `onChange` / `maxLength` 一起算进来 ⇒ 判据会假红或空转。
   */
  const slotFrom = ADMIN.indexOf('function ReleaseSlotForm(')
  const slotTo = ADMIN.indexOf('function ErrorsCard(')
  const SLOT = slotFrom >= 0 && slotTo > slotFrom ? ADMIN.slice(slotFrom, slotTo) : ''
  check(
    SLOT.length > 0 && LIVE_SRC.length > 0,
    'A23 锚点自证：`ReleaseSlotForm` 那一块与适配层 `lib/liveInput.ts` 都抠出来了（否则下面全是空转）',
    `ReleaseSlotForm ${SLOT.length} B · liveInput ${LIVE_SRC.length} B`,
  )

  /* ---------------- ① 正文框：非受控 ---------------- */
  const noteUncontrolled = (t) =>
    t.includes('defaultValue={note}') && t.includes('ref={noteRef}') && !/value=\{note\}/.test(t)
  check(
    noteUncontrolled(SLOT),
    '🔴 A23 ① 正文框（`data-rel-note`）是**非受控**的：`defaultValue={note}` + `ref={noteRef}`，**没有** `value={note}` —— React 不再往框里写回旧值 ⇒ "点发布把刚打完的字冲掉"从结构上不可能',
    `defaultValue=${SLOT.includes('defaultValue={note}')} · ref=${SLOT.includes('ref={noteRef}')} · 还有 value={note}=${/value=\{note\}/.test(SLOT)}`,
  )
  {
    /* 🧪 反向对照：改回受控（= 改之前那份代码）⇒ ① 当场假 */
    const cut = oneEdit3(SLOT, 'defaultValue={note}', 'value={note}')
    check(
      cut.ok && !noteUncontrolled(cut.text),
      '🧪 A23 ① 反向对照：把 `defaultValue={note}` 换回 `value={note}`（受控 = **改之前**的写法，内存副本）⇒ ① 当场假',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完还有 value={note}=${/value=\{note\}/.test(cut.text)}`,
    )
  }

  /* ---------------- ② 提交那一刻读的是**屏上**，不是 state ---------------- */
  const readsDom = (t) => t.includes('liveValue(noteRef.current, note)')
  check(
    readsDom(SLOT) && SLOT.indexOf('liveValue(noteRef.current') < SLOT.indexOf('setRelease('),
    '🔴 A23 ② 点「发布」/「撤下」时**先读 DOM**（`liveValue(noteRef.current, note)`）而且**排在 `setRelease(` 之前** —— 安卓上最后一次 `onChange` 可能排在这次点击之后，读 state 就是把老师刚打完、屏上看得见的那几个字吞掉',
    `读 DOM=${readsDom(SLOT)} · 读的位置 ${SLOT.indexOf('liveValue(noteRef.current')} < 发出去的位置 ${SLOT.indexOf('setRelease(')}`,
  )
  {
    const cut = oneEdit3(SLOT, 'liveValue(noteRef.current, note)', 'note')
    check(
      cut.ok && !readsDom(cut.text),
      '🧪 A23 ② 反向对照：把"读 DOM"换成"读 state"（`note` = 改之前那份代码，内存副本）⇒ ② 当场假（证明它咬的是**从哪儿读**，不是"这两个名字在不在"）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完读 DOM=${readsDom(cut.text)}`,
    )
  }

  /* ---------------- ③ 读回之后**重算校验**；不 ok 就报错、不发布 ---------------- */
  const GATE_RE = /if \(checked && !checked\.ok\) \{[\s\S]{0,160}setErr\(checked\.error\)[\s\S]{0,80}return/
  check(
    /const checked = enabled/.test(SLOT) && GATE_RE.test(SLOT),
    '🔴 A23 ③ 提交前用**读回来的那一份**重算 `validateReleaseForm()`；不 ok ⇒ **显式报错并 return**（不发布）—— 不许"校验的是旧值、发出去的也是旧值"，也不许"截断之后照发"',
    `重算=${/const checked = enabled/.test(SLOT)} · 不 ok 就报错返回=${GATE_RE.test(SLOT)}`,
  )
  {
    const cut = oneEdit3(SLOT, 'if (checked && !checked.ok) {', 'if (false) {')
    check(
      cut.ok && !GATE_RE.test(cut.text),
      '🧪 A23 ③ 反向对照：把"不 ok 就报错返回"那一句的条件改成 `false`（副本）⇒ ③ 当场假（正文不合规也照样发出去）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完判据=${GATE_RE.test(cut.text)}`,
    )
  }
  check(
    /const row = checked\?\.ok \? checked\.row : null/.test(SLOT) && /note: outNote/.test(SLOT),
    '🔴 A23 ③ 发出去的字段取的是**校验器归一化后的那一份**（`checked.row`），不是渲染期闭包里那几个 state —— 否则"读了 DOM 校验过"与"实际发出去的"又是两份字',
    `取 checked.row=${/const row = checked\?\.ok \? checked\.row : null/.test(SLOT)} · 用 outNote=${/note: outNote/.test(SLOT)}`,
  )

  /* ---------------- ④ 提交路径上**不改写**用户输入 ---------------- */
  check(
    !/maxLength=/.test(SLOT) && /note\.length\} \/ \{RELEASE_NOTE_MAX\}/.test(SLOT),
    '🔴 A23 ④ 正文框**没有 `maxLength`**（原生上限会在组字时**静默截断**正在打的字 —— 那也是"吞字"，只不过是我们自己造成的），而字数提示照旧在（`{note.length} / {RELEASE_NOTE_MAX} 字`）⇒ 超 24 字改成"明确报错、不发布"',
    `还有 maxLength=${/maxLength=/.test(SLOT)} · 字数提示在=${/note\.length\} \/ \{RELEASE_NOTE_MAX\}/.test(SLOT)}`,
  )
  {
    /* 🧪 反向对照：把 `maxLength` 塞回去 ⇒ ④ 当场假（原生静默截断又回来了） */
    const cut = oneEdit3(SLOT, 'data-rel-note', 'maxLength={RELEASE_NOTE_MAX}\n        data-rel-note')
    check(
      cut.ok && /maxLength=/.test(cut.text),
      '🧪 A23 ④ 反向对照：把 `maxLength={RELEASE_NOTE_MAX}` 塞回正文框（副本）⇒ ④ 当场假（静默改用户输入又回来了）',
      `目标出现 ${cut.n} 处（须恰好 1）· 塞回去之后还有 maxLength=${/maxLength=/.test(cut.text)}`,
    )
  }
  const TRIM_RE = /onChange=\{\(e\) => changeVersion\(e\.target\.value\.trim\(\)\)\}/
  check(
    !TRIM_RE.test(ADMIN),
    '🔴 A23 ④ 版本号框的 `onChange` 里**不再有 `.trim()`**（原来每打一个字就 `.trim()` 一次 = 改写用户正在打的字，不变量 I-输入-2）—— 规范化留给校验/提交那一刻（`validateReleaseForm()` 自己会 `trim()`）',
    `还有那一句=${TRIM_RE.test(ADMIN)}`,
  )
  {
    const cut = oneEdit3(
      ADMIN,
      'onChange={(e) => changeVersion(e.target.value)}',
      'onChange={(e) => changeVersion(e.target.value.trim())}',
    )
    check(
      cut.ok && TRIM_RE.test(cut.text),
      '🧪 A23 ④ 反向对照：把 `.trim()` 加回版本号框（副本）⇒ 上面那条当场假（证明它读的是**那一个**表达式）',
      `目标出现 ${cut.n} 处（须恰好 1）· 加回去之后命中=${TRIM_RE.test(cut.text)}`,
    )
  }

  /* ---------------- ⑤ 另外三个受控框：提交前也读回 ---------------- */
  const FIELDS3 = ['versionRef', 'apkRef', 'exeRef']
  const readBack = (t, r) => t.includes(`liveValue(${r}.current`)
  check(
    FIELDS3.every((r) => readBack(SLOT, r)) &&
      FIELDS3.every((r) => SLOT.indexOf(`liveValue(${r}.current`) < SLOT.indexOf('setRelease(')),
    '🔴 A23 ⑤ 版本号 / 两个链接框**照旧受控**（它们要靠服务端预填、版本号还要驱动正文联动 ⇒ 改成非受控反而会让"读到服务端那一份"失效），所以走另一条路：**提交前各自从 DOM 读回**，三个都排在 `setRelease(` 之前',
    FIELDS3.map((r) => `${r}:${readBack(SLOT, r) ? '✔' : '✖'}`).join(' · '),
  )
  {
    const cut = oneEdit3(SLOT, 'liveValue(apkRef.current, urlApk)', 'urlApk')
    check(
      cut.ok && !readBack(cut.text, 'apkRef'),
      '🧪 A23 ⑤ 反向对照：把手机链接那个框的读回去掉（副本）⇒ ⑤ 当场假（那一个框又变成"读 state 提交"）',
      `目标出现 ${cut.n} 处（须恰好 1）· 改完 apkRef 读回=${readBack(cut.text, 'apkRef')}`,
    )
  }

  /* ---------------- ⑥ 适配层：只读不写 ---------------- */
  check(
    /export function liveValue\(el: LiveField, fallback = ''\): string \{/.test(LIVE_SRC) &&
      /return el && typeof el\.value === 'string' \? el\.value : fallback/.test(LIVE_SRC),
    '🔴 A23 ⑥ 适配层 `liveValue()` 的判据是"**元素在、而且它真有 `value`**"，否则退回 `fallback`（拿不到元素时绝不会读出一个 `undefined` 当字符串用）',
    `函数在=${/export function liveValue/.test(LIVE_SRC)} · 取值判据=${/typeof el\.value === 'string'/.test(LIVE_SRC)}`,
  )
  /*
   * 🔴 判据写成 `\.value\s*=(?!=)`：`===` / `==` 里也有一个 `=`
   *    —— 第一版写成 `/\.value\s*=/`，当场把 `typeof el.value === 'string'` 判成
   *    "给 value 赋值"⇒ **假红**（2026-10-05 实测；与 `AGENTS.md` §九.1 同源：
   *    核对失败时第一件事是怀疑核对工具）。
   */
  const WRITE_RE = /\.value\s*=(?!=)/
  check(
    !WRITE_RE.test(LIVE_SRC),
    '🔴 A23 ⑥ 适配层**一个字节都不改 DOM**（剥注释后的代码里没有一处 `.value =`）—— 它只读，所以不可能自己制造一次输入、也不会与组件的 `onChange` 打架',
    `命中 ${(LIVE_SRC.match(/\.value\s*=(?!=)/g) ?? []).length} 处`,
  )
  {
    /* 自证：塞一句进去则命中（"零命中"不是"什么都搜不到"） */
    const poisoned = `${LIVE_SRC}\nfunction _bad(el) { el.value = 'x' }\n`
    check(
      WRITE_RE.test(poisoned),
      '🧪 A23 ⑥ 自证：往副本里塞一句 `el.value = …` ⇒ 上面那条"零命中"当场假（证明它不是恒绿的空跑）',
      `塞进去之后命中 ${(poisoned.match(/\.value\s*=(?!=)/g) ?? []).length} 处`,
    )
  }
  {
    const cut = oneEdit3(
      LIVE_SRC,
      "return el && typeof el.value === 'string' ? el.value : fallback",
      'return (el as HTMLInputElement).value',
    )
    check(
      cut.ok && !/typeof el\.value === 'string'/.test(cut.text),
      '🧪 A23 ⑥ 反向对照：把"真有 `value` 才读"换成直接取 `.value`（副本）⇒ 上面那条当场假（拿不到元素时会读出 `undefined`）',
      `目标出现 ${cut.n} 处（须恰好 1）`,
    )
  }

  /* ---------------- ⑦ 两侧都照实写着"真机未验" ---------------- */
  {
    /* 照 A21 ⑪ / A22 ⑧ 的先例：这一条**故意用原始文本**（那五个字只能写在注释里） */
    const RAW3 = [
      ['src/pages/Admin.tsx', readApp('src/pages/Admin.tsx')],
      ['src/lib/liveInput.ts', readApp('src/lib/liveInput.ts')],
    ]
    const silent3 = RAW3.filter(([, t]) => !/真机未验/.test(t)).map(([n]) => n)
    check(
      silent3.length === 0,
      '🔴 A23 ⑦ 两份源码的**注释**里都照实写着"真机未验"（本机没有安卓设备，别假装验过）',
      silent3.length ? `没写：${silent3.join(' · ')}` : `两份都写了：${RAW3.map(([n]) => n).join(' · ')}`,
    )
  }

  /*
   * ✅ **怎么真机验**（本机没有安卓设备 ⇒ 这一节全是静态判据，**没有一条**是真机验过的）：
   *    ① 装一版新 apk（`_tools/package-all.mjs`），进 `/admin` → 「版本更新」卡 → 教师端那一档；
   *    ② 用**中文输入法**在「公告正文」里连着打十几个汉字（**别用英文、别粘贴** ——
   *       粘贴绕不出这个 bug，它要的是"用输入法一路打上来"）；
   *    ③ 打完**立刻**点「发布」：正文框里那几个字**必须一个都不少**，而且报错/成功那句里的
   *       版本号与正文与屏上一致；
   *    ④ 反向：把正文改到 25 个字以上再点发布 ⇒ 应看到「公告正文最多 24 字 —— 长了没人读」
   *       这句**明确报错**，而**不是**"被悄悄截成 24 字发出去"。
   */
}

/* ============================================================
   第二十四节之三 · A24：推送那条链的**失败原因不许被吞**（2026-10-05 真机实测）
   ------------------------------------------------------------
   ⚠️ 编号：A21（应用内更新）/ A22（系统排程）/ A23（发布吞字）已被并行那几节占掉
      ⇒ 本节取 **A24**，别再往这三号上撞（同号两节会让"看日志定位"当场失效）。

   🔴 起因（真机第四轮，用户在 apk 上看到）：横幅写「通知设置没走完 · 前台服务没起来。」
      而真因是**接口地址末尾多了一个斜杠**：原生拼 `endpoint + "/api/push"`，
      网页给的 `apiUrl('')` 末尾带 `/` ⇒ `//api/push` ⇒ **405**。
      （实测线上对照：`/api/push` → 401 路由在；`//api/push` → 405 命中另一个资源。）

   🔴 为什么用户看到的是「前台服务没起来」而不是 405 —— **原因被吞了三次**：
      ① 桥接 `.catch()` 只 `console.error`；
      ② 桥接"插件不存在"那一支只回 `{ok:false, unsupported:true}`，没有 `why`；
      ③ `shellStartPush` 拿到非对象时只回 `{ok:false}`。
      三处都把"没回原因"和"原因很严重"压成同一句话
      ⇒ 那道横幅成了**恒真的废话**（§五「失败了会有人知道吗」那一问的答案：没人知道）。

   这一节钉住三件事：地址**不许**带末尾斜杠 · `why` **一路**带得到屏上 ·
   405/404 这类"地址错了"要在真因**前面**点出来（不然用户以为是服务端故障）。

   🔴🔴 **本节自己头一版写出来的四条判据全红，两个真因都指不到真因**（留档）：
      ① 字面量 `.replace(/\/+$/, '')` 里的 **`+` 必须转义** —— 我写成 `\/+`，
         那是「一个或多个斜杠」，匹配不到字面的 `+` ⇒ **源码明明是对的，判据恒假**；
      ② **不剥注释就判，反向对照会被注释骗过** —— `前台服务没起来` / `原因没带回来`
         这两串字在我**新写的注释**里各有一份，`String.replace` 只换第一处、
         且第一处是 desc 那句 ⇒ 换完注释里那份还在 ⇒ 对照判假
         ⇒ 与它成对的那条"编造兜底不在了"反而**假绿**（它靠"中间插了注释使
         pattern 不匹配"蒙混过关）。
      ✅ 这一节**全部先 `strip()` 再判**，并加了一条 strip 自证
         （同一句塞进注释判过、塞进代码判假）。
   ============================================================ */
section('第二十四节之三 · A24：推送失败原因不许被吞（真机 405 那次）')

{
  const HOOK = readApp('src/hooks/useFirstRunPermissions.ts')
  const NOTIFY = readApp('src/lib/notify.ts')

  /**
   * 剥注释 —— 本节**每一条**都走它。
   *
   * 🔴 不剥会出两种坏结果（头一版四条红就是这么来的）：
   *   ① 正则里那个 `+` 没转义：字面量是 `.replace(/\/+$/, '')`，我写 `\/+`
   *      （=「一个或多个斜杠」）⇒ **源码明明对，判据恒假**；
   *   ② 反向对照被**注释**骗过：`前台服务没起来` / `原因没带回来` 这两串字在
   *      我新写的注释里各有一份，`String.replace` 只换第一处（= desc 那句）
   *      ⇒ 换完注释里那份还在 ⇒ 对照判假 ⇒ 与它成对的"编造兜底不在了"
   *      反而**假绿**（靠"中间插了注释使整个 pattern 不匹配"蒙混过关）。
   */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const CODE = strip(HOOK)
  const NCODE = strip(NOTIFY)

  /** 进本节时的灰计数（照 A21/A22 的 `g0`/`g0b` 先例）—— 节末自证用它算"app 侧灰了几条" */
  const g24 = grayed

  /* 字面量 `.replace(/\/+$/, '')` 的正则 —— `+` 与 `$` 都要转义，`/` 要写成 `\/` */
  const TRIM_RE = /replace\(\/\\\/\+\$\/, ''\)/
  const TRIM_BRIDGE_RE =
    /var base = String\(\(opts && opts\.endpoint\) \|\| ''\)\.replace\(\/\\\/\+\$\/, ''\)/

  /* ---------------- ① 地址不许带末尾斜杠 ---------------- */
  check(
    TRIM_RE.test(NCODE) && /endpoint: base/.test(NCODE),
    'A24 ① `shellStartPush` **自己**去掉 endpoint 末尾的斜杠（原生拼的是 `endpoint + "/api/push"` ⇒ 多一个斜杠就是 405）',
    `实测 ${TRIM_RE.test(NCODE)} / ${/endpoint: base/.test(NCODE)}`,
  )
  check(
    /apiUrl\(''\)/.test(CODE) === true,
    'A24 ① 调用处确实传的是 `apiUrl(\'\')`（站点 origin，不是某个具体路由 —— 路由由原生那边自己拼）',
    `实测 ${/apiUrl\(''\)/.test(CODE)}`,
  )

  /* ---------------- ② why 一路带得到屏上 ---------------- */
  const whyKept = [
    /这个壳没有推送链/.test(NCODE),
    /壳那边回的不是对象/.test(NCODE),
    /调用壳失败/.test(NCODE),
    /原因没带回来/.test(CODE),
  ]
  check(
    whyKept.every(Boolean) && whyKept.length === 4,
    'A24 ② `shellStartPush` 的**四条**返回支路各带一句能定位的话（"没回原因"与"原因严重"不许压成同一句）',
    `实测 ${whyKept.filter(Boolean).length}/4`,
  )

  /**
   * 「编造的那句兜底」在**代码**里还剩几处 —— 必须先 `strip()` 再数。
   *
   * ⚠️ 🔴 这一条头一版是**假绿**：它判的是"整段 pattern 匹配不上"，
   *    而 pattern 匹配不上只是因为我在 `text:` 与 `desc:` **中间插了注释**
   *    ⇒ 与"那句话真的拿掉了"毫无关系（同一个坏法见 §三.1「靠放水而绿」）。
   *    现在改成"数真代码里那串字"，并且**塞回代码必须判假、塞进注释必须判过**。
   */
  const fabricated = (src) => strip(src).split('前台服务没起来').length - 1
  check(
    fabricated(HOOK) === 0,
    'A24 ② 横幅那一句**不再用编造的兜底原因**（`why || "前台服务没起来。"` —— 真因被吞时的第一现场就是它）',
    `剥注释后真代码里还有 ${fabricated(HOOK)} 处（期望 0）`,
  )
  check(
    fabricated(HOOK + "\nconst x = '前台服务没起来。'") === 1 &&
      fabricated(HOOK + '\n// 前台服务没起来。') === 0,
    '🧪 A24 ② strip 自证：同一句塞进**代码** ⇒ 数到 1（判假）· 塞进**注释** ⇒ 数到 0（判过）—— 证明"剥注释"真的在区分两者，不是把整份文件删空',
    `代码里=${fabricated(HOOK + "\nconst x = '前台服务没起来。'")}（期望 1）· 注释里=${fabricated(
      HOOK + '\n// 前台服务没起来。',
    )}（期望 0）`,
  )
  check(
    /why: r\.why\?\.trim\(\) \|\|/.test(NCODE),
    'A24 ② 原生回 `{ok:false}` 但 `why` 是**空串**时，补一句"看 logcat"（空串在界面上等于"没原因"）',
    `实测 ${/why: r\.why\?\.trim\(\) \|\|/.test(NCODE)}`,
  )

  /* ---------------- ③ 壳侧两处也要带 why（不在 git 里，直接读打包目录） ----------------
   *
   * 🔴🔴 **2026-10-05 第三次 CI 红（`4cf89fc`）：这一节漏在灰档窗口之外**。
   *    ⚠️ 引进它的是 `7b6211f`（A24 整节头一次落地），而 `4cf89fc` 是**第一次把它推进
   *       CI** 的那个提交 —— `7b6211f` / `47fc6d6` / `4cf89fc` 是同一次 push，
   *       而 GitHub 对一次 push **只跑 tip 那一个 commit**，所以 `7b6211f` 自己没被单独跑过、
   *       上一个绿（`dbda528`，CI 跑过）里**根本还没有 A24 这一节**。
   *       这就是"为什么前几次绿、这次红"的答案：判据是新的，不是被改坏的。
   *    真因有两个，**两个都要**才能修对：
   *      ① **路径拼法不一致**：A21/A22 读壳侧用的是**绝对路径**
   *         （`PACK` / `PACK2` = 桌面上那个 `树高教务通打包` 目录的**绝对路径**），
   *         而这里写的是 `join(REPO, '..', …)` —— `REPO` 是"本脚本所在那份检出"的根。
   *         于是：**本机**（主工作区跑）解析到隔壁打包工程 ⇒ 在 ⇒ 绿；而
   *         **`git worktree` 的干净检出**（和 CI 一样的那份，`%TEMP%\shugao-nav-4cf89fc`）
   *         会解析到 `%TEMP%\树高教务通打包` ⇒ **必然不在** ⇒ 走 else 恒红。
   *         这就是"本机绿、干净检出红"里**只有本机那半**被 A21/A22 的绝对路径盖住的原因。
   *      ② **没有三态**：这一节的 `else` 分支是**无条件 `check(false, …)`** ——
   *         打包工程**不进这个公开仓库**，CI 的干净检出**必然**没有它
   *         ⇒ 那是一条**不可能在 CI 变绿的卡**（与 `0f45438` / `d8d1e98` 同一个坏法，
   *         见 `AGENTS.md` §三.1「假红」）。CI 因此**一进来就死**（第 7 步 ~2 秒退出）。
   *    ✅ 修法照本节 A21/A22 的**现成**机制：**只灰掉"读仓库外那半个输入"**——
   *       桥接文件在 ⇒ 逐条真判（本机：一条都不灰）；不在 ⇒ 落灰（CI），
   *       而 app 侧（①②与两条反向对照，只读 `app/`）**一条都不许灰**。
   *       节末另有一条**自证可红**（写在灰档外面），谁把灰的范围开大/开小当场红。
   */
  const BRIDGE_ABS =
    'C:\\Users\\Administrator\\Desktop\\树高教务通打包\\_src\\shell-bridge-apk.js'
  const SHELL_BRIDGE_HERE = existsSync(BRIDGE_ABS)
  let shellBridgeJudged = 0
  let shellBridgeGray = 0
  const shellSide = (fn) => {
    const g = grayed
    const j = passed + failures.length
    const was = shellGray
    shellGray = was || !SHELL_BRIDGE_HERE
    try {
      fn()
    } finally {
      shellGray = was
    }
    shellBridgeGray += grayed - g
    shellBridgeJudged += passed + failures.length - j
  }

  shellSide(() => {
    /*
     * 🔴 读之前仍要**先问在不在**：`SHELL_BRIDGE_HERE` 为假时这一句在 CI 上会
     *    抛 `ENOENT`，那是「门禁自己吞异常」那类假绿的老家（`AGENTS.md` §三.1）。
     *    文件真的缺（打包工程在、桥接文件被删）⇒ 读空串 ⇒ 下面两条**当场红**，
     *    正是"壳在的机器上缺文件仍是红"那一条纪律。
     */
    const BR = SHELL_BRIDGE_HERE ? strip(readFileSync(BRIDGE_ABS, 'utf8')) : ''
    check(
      /插件 ShugaoNative 没加载上/.test(BR) && /调用原生抛错/.test(BR) && /原生回的不是对象/.test(BR),
      'A24 ③ 桥接层**三支都带 why**（插件没加载 / 原生回的不是对象 / 调用抛错）—— 原来全是 `{ok:false}`，真因就在这里被吃掉',
      `实测 插件=${/插件 ShugaoNative 没加载上/.test(BR)} · 非对象=${/原生回的不是对象/.test(BR)} · 抛错=${/调用原生抛错/.test(BR)}`,
    )
    check(
      TRIM_BRIDGE_RE.test(BR),
      'A24 ③ 桥接那侧**也**去一道末尾斜杠（两道保险：网页一道、壳一道 —— 少任何一道都会让这个 bug 从另一侧漏回来）',
      `实测 ${TRIM_BRIDGE_RE.test(BR)}`,
    )
  })

  /* 反向对照 G：把 trim 那一道删掉（副本）⇒ ① 当场假 */
  {
    // 🔴 **先数出现次数，不是 1 就抛错**（§三.2）：`String.replace` 只换第一处，
    //    而目标串经常在注释里也有一份 ⇒ 改的是注释、判据纹丝不动 = 对照假绿。
    const needle = ".replace(/\\/+$/, '')"
    const hits = NCODE.split(needle).length - 1
    if (hits !== 1) throw new Error(`A24 G：目标在 notify 里出现 ${hits} 处（必须恰好 1）`)
    const noTrim = NCODE.replace(needle, '')
    check(
      noTrim !== NCODE && !TRIM_RE.test(noTrim),
      '🧪 A24 ① 反向对照 G：把「去掉末尾斜杠」那一行删掉（副本）⇒ 上面那条当场假（证明它在读真源码）',
      `目标 ${hits} 处 · 副本被改过=${noTrim !== NCODE} · 改完判据=${TRIM_RE.test(noTrim)}（期望 false）`,
    )
  }
  /* 反向对照 H：把编造兜底那句塞回**代码**（副本）⇒ ② 当场假 */
  {
    const needle = '原因没带回来（看 logcat 里 ShugaoNative 那行）'
    const hits = CODE.split(needle).length - 1
    if (hits !== 1) throw new Error(`A24 H：目标在真代码里出现 ${hits} 处（必须恰好 1）`)
    const back = HOOK.replace(needle, '前台服务没起来。')
    check(
      back !== HOOK && fabricated(back) === 1,
      '🧪 A24 ② 反向对照 H：把兜底原因**换回编造的那句**（副本）⇒ ② 当场假（证明那句"编造原因不许在"真在判）',
      `目标 ${hits} 处 · 副本被改过=${back !== HOOK} · 改完真代码里有 ${fabricated(back)} 处（期望 1）`,
    )
    // 🔴 头一版就是栽在这儿：换的是 desc 那句，而**注释里那份还在** ⇒ 对照判假、
    //    与它成对的那条反而假绿。所以再钉一次"注释里那份不影响判据"：
    check(
      fabricated(HOOK + '\n// 前台服务没起来。') === 0,
      '🧪 A24 ② 反向对照 H-补：把那句**只放进注释**（副本）⇒ 判据仍判过 —— 证明它数的是真代码、不是注释',
      `注释里那份使读数变成 ${fabricated(HOOK + '\n// 前台服务没起来。')}（期望 0）`,
    )
  }

  /*
   * 🔴 **A24 自证（三态，可红）** —— 写在灰档**外面**，两个方向都能红：
   *    · 壳在（维护者本机）：③ 那 **2 条**逐条真判、**一条都不灰**；
   *    · 壳不在（CI 的干净检出）：③ 那 **2 条**全落灰、**一条都没判**；
   *    · 而这一节 app 侧（①② 与那两条反向对照，只读 `app/`）**一条都不许灰**
   *      —— 谁把灰的范围**开大**（罩到 app 侧那半）或**开小**（③ 漏在窗口外，
   *      正是 `4cf89fc` 那次 CI 的坏法）**或改了 ③ 的条数**，这条当场红。
   * ✅ 2026-10-05：这里原来也有一句手工 `shellGray = false`，**已删** ——
   *    ③ 的灰档由 `shellSide()` 的 `finally` 复原，跨节那一层由 `section()` 强制收口
   *    （节末那条"灰档不跨节"的自证现在也盯着它）。**已实测：删掉它，本节自证照旧绿。**
   */
  {
    const A24_SHELL_LEG_N = 2
    const appSideGray = grayed - g24 - shellBridgeGray
    check(
      shellBridgeJudged + shellBridgeGray === A24_SHELL_LEG_N &&
        (SHELL_BRIDGE_HERE ? shellBridgeGray === 0 : shellBridgeJudged === 0) &&
        appSideGray === 0,
      '🔴 A24 自证（三态）：壳不在时 ③ 那两条**全落灰、一条都没判**、壳在时**逐条真判、一条都不灰**；**本节 app 侧那半一条都没灰** —— 谁把 ③ 漏在灰档窗口外（= `4cf89fc` 那次 CI 一进来就死）、把灰的范围开到 app 侧、或改了 ③ 的条数，这条当场红',
      `壳在=${SHELL_BRIDGE_HERE} · ③ 共 ${A24_SHELL_LEG_N} 条：判了 ${shellBridgeJudged} 条 / 灰了 ${shellBridgeGray} 条 · app 侧灰了 ${appSideGray} 条`,
    )
  }
}

/* ============================================================
   第二十四节之四 · A25：`/api/push` 抛出去的东西**不许冲出函数**（2026-10-05 真机第五轮）
   ------------------------------------------------------------
   真机横幅原文（用户截的）：
     `startPush 里 register（POST /api/push）这一步：HTTP 500 · 服务端返回的不是 JSON
      对象（响应体开头：error code: 1101）`
   `error code: 1101` 是 **Cloudflare 自己的码** = Worker 抛了**未捕获的 JavaScript 异常**。
   本机 curl 复现（body 用文件发，避开 PowerShell 吞引号那件事）：
     `POST /api/push` body `null` ⇒ **HTTP 500 · Content-Type: text/plain ·
      Content-Length: 17 · 体 = `error code: 1101``
     `POST /api/push` body `{"action":"pull"}` ⇒ 401 JSON（路由在，函数被正常调到）
   ⇒ 原生那侧 `new JSONObject(<纯文本>)` 当场抛 org.json 黑话，**HTTP 码与真因一起被吞**。

   这一节钉四件事（app 侧静态判据，只读 `functions/api/push.ts`）：
     ① `onRequestPost` **整体**包了一层 try/catch，异常回 JSON + 502 且 `detail: String(e)`；
     ② 读 `body.action` **之前**有对象形状守卫（字面 `null` 是**合法 JSON**，
        `request.json()` 会成功返回 `null` ⇒ 原来当场 TypeError）；
     ③ `await ins.json()` 有保护（上游回 2xx 非 JSON 时，把 HTTP 码 + 响应体开头写进 detail）；
     ④ 往 `push_tokens` 插那一条**带 `Prefer: return=representation`** —— 这是那条 1101 的
        **真凶**：PostgREST 对 POST 默认 `return=minimal`（插成功也只回 **201 空体**），
        而下一句 `ins.json()` 读空体必抛；全仓别处读 `json()` 的 POST 一处不缺地带这个头
        （`notice.ts` / `teacher-account.ts` / `announcement.ts` / `feedback.ts` /
         `admin/release.ts` / `schedule-notice.ts` / `admin/errors.ts` …）。
   ⚠️ 原生 register 的**请求形状**是写死的 `{"action":"register"}` + `Authorization: Bearer`
      （打包工程 `YlxbNativePlugin.java` 的 `startPush`）⇒ ② 那条守卫**不是**它触发的，
      真机那 500 出在 ④ 那一处（`ins.json()` 读空体）。
   每条都有反向对照，且**先数出现次数、不是 1 就抛错**（§三.2 的坑：换的是注释里那份）。
   ============================================================ */
section('第二十四节之四 · A25：/api/push 抛出的异常不许冲出函数（Cloudflare 1101）')

{
  const PUSH = readApp('functions/api/push.ts')

  /** 剥注释（与 A24 同一套写法）：判据只许看**真代码** */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
  const PCODE = strip(PUSH)

  /** 数出现次数（判据里用它，不做替换 ⇒ 不抛错，红了能看清读数） */
  const countIn = (needle, hay) => hay.split(needle).length - 1
  /**
   * 🔴 反向对照专用：**出现次数必须恰好 1**，否则抛错（`String.replace` 只换第一处，
   *    而目标串经常在注释里也有一份、且排在真代码前面 ⇒ 改的是注释、判据纹丝不动 = 对照假绿）。
   *    宁可当场报错，也不假绿（`AGENTS.md` §三.2）。
   */
  const mustOnce = (needle, hay, who) => {
    const hits = countIn(needle, hay)
    if (hits !== 1) throw new Error(`A25 ${who}：目标「${needle}」出现 ${hits} 处（必须恰好 1）`)
    return hits
  }

  /**
   * 抠出某个函数声明的整段（花括号配平）—— 判据只在**那个函数里**找，别把别处的 try 数进来。
   * ⚠️🔴 必须**先跨过参数表**再找函数体那个 `{`：`onRequestPost(context: { request: Request;
   *    env: Env })` 的签名里**自己就带一对花括号**（类型字面量）—— 头一版直接
   *    `indexOf('{', at)` 抠到的是那对类型花括号（35 个字），于是"函数体里 `try {` 0 处"，
   *    ① 当场假、反向对照还因"目标 0 处"抛错（§三.2 那条纪律正好把它拦住了，没假绿）。
   */
  const fnBody = (src, decl) => {
    const at = src.indexOf(decl)
    if (at < 0) return ''
    const p = src.indexOf('(', at)
    if (p < 0) return ''
    let pd = 1
    let i = p + 1
    for (; i < src.length && pd > 0; i++) {
      if (src[i] === '(') pd++
      else if (src[i] === ')') pd--
    }
    const open = src.indexOf('{', i)
    if (open < 0) return ''
    let depth = 0
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') {
        depth--
        if (depth === 0) return src.slice(open, j + 1)
      }
    }
    return ''
  }

  const POST_DECL = 'export async function onRequestPost'
  const POST_BODY = fnBody(PCODE, POST_DECL)

  check(
    POST_BODY.length > 40 &&
      POST_BODY.length < 900 &&
      /handlePush/.test(POST_BODY) &&
      /export async function onRequestPost/.test(PCODE) &&
      countIn('async function handlePush', PCODE) === 1,
    'A25 ⓪ 锚点自证：`onRequestPost` 那一整段抠出来了，而且它只做一件事（转发给同文件唯一那个 `handlePush`）—— 抠错了下面四条全是空转',
    `抠出 ${POST_BODY.length} 字（须 40–900）· 含 handlePush=${/handlePush/.test(POST_BODY)} · handlePush 声明 ${countIn('async function handlePush', PCODE)} 处（须 1）`,
  )

  /* ---------------- ① 外层 try/catch ---------------- */
  /**
   * 那个 `try` 必须是**函数体最外层的第一句** —— 只判"文件里出现过 try"是不够的
   * （那样"只罩住里面一小段"也会判过，而异常照样冲出去）。
   */
  const outerOk = (bodyTxt) =>
    /^try\s*\{/.test(String(bodyTxt).replace(/^\{\s*/, '')) &&
    /catch\s*\(\s*\w+\s*\)\s*\{/.test(bodyTxt) &&
    /detail:\s*String\(\s*e\s*\)/.test(bodyTxt) &&
    /\b502\b/.test(bodyTxt)

  const outerTryHits = countIn('try {', POST_BODY)
  check(
    outerOk(POST_BODY) && outerTryHits === 1,
    '🔴 A25 ① `onRequestPost` **整体**包了一层 try/catch（整个函数体里只有这一个 try ⇒ 真的是"罩住全函数"），异常一律回 JSON + 502，`detail: String(e)` 带异常原文 —— 改之前任何一次未捕获异常都被 Cloudflare 换成 `text/plain` 的 `error code: 1101`（实测 HTTP 500），原生 `new JSONObject(<纯文本>)` 当场抛 org.json 黑话、HTTP 码与真因一起被吞',
    `最外层是 try=${/^try\s*\{/.test(POST_BODY.replace(/^\{\s*/, ''))} · catch=${/catch\s*\(\s*\w+\s*\)\s*\{/.test(POST_BODY)} · detail=String(e)=${/detail:\s*String\(\s*e\s*\)/.test(POST_BODY)} · 有 502=${/\b502\b/.test(POST_BODY)} · 函数体里 try 的处数=${outerTryHits}（须 1）`,
  )

  /* ---------------- ② body 形状守卫（必须在读 .action 之前） ---------------- */
  const GUARD = "typeof body !== 'object' || body === null"
  const guardOk = (src) => {
    const g = src.indexOf(GUARD)
    const a = src.indexOf('body.action')
    if (g < 0 || a < 0 || a < g) return false
    const win = src.slice(g, g + 200)
    return /请求格式不对/.test(win) && /,\s*400\s*\)/.test(win)
  }
  const guardAt = PCODE.indexOf(GUARD)
  const actionAt = PCODE.indexOf('body.action')
  check(
    guardOk(PCODE),
    '🔴 A25 ② 读 `body.action` **之前**先过对象形状守卫（`typeof body !== \'object\' || body === null` ⇒ 回 400「请求格式不对」）—— `request.json()` 对字面 `null` 是**成功**的（`null` 是合法 JSON），改之前 `body.action` 当场 TypeError（1101 的一条来路）',
    `守卫在第 ${guardAt} 字 · 第一次读 body.action 在第 ${actionAt} 字（须晚于守卫）· 守卫段里回 400=${/,\s*400\s*\)/.test(guardAt >= 0 ? PCODE.slice(guardAt, guardAt + 200) : '')}`,
  )

  /* ---------------- ③ ins.json() 有保护 ---------------- */
  const INS = 'ins.json()'
  const insOk = (src) => {
    const at = src.indexOf(INS)
    if (at < 0) return false
    const before = src.slice(Math.max(0, at - 600), at)
    const after = src.slice(at, at + 700)
    return (
      /try\s*\{/.test(before) &&
      /clone\(\)/.test(before) &&
      /catch\s*\(\s*\w+\s*\)/.test(after) &&
      /slice\(0,\s*200\)/.test(after) &&
      /\b502\b/.test(after)
    )
  }
  const insBefore = PCODE.slice(Math.max(0, PCODE.indexOf(INS) - 600), PCODE.indexOf(INS))
  const insAfter = PCODE.slice(PCODE.indexOf(INS), PCODE.indexOf(INS) + 700)
  check(
    insOk(PCODE),
    '🔴 A25 ③ `await ins.json()` 有保护：先 `clone()` 留一份原文（`json()` 会把 body 消费掉），解析失败时把 HTTP 码 + 响应体开头（≤200 字节）+ 异常原文写进 `detail` 回 502 —— 上游回 2xx 非 JSON（空体 / 纯文本 / 网关页）时原来当场抛，**唯一的线索就在那个响应体里**（§三.5）',
    `ins.json() 前有 try=${/try\s*\{/.test(insBefore)} · 前有 clone()=${/clone\(\)/.test(insBefore)} · 后有 catch=${/catch\s*\(\s*\w+\s*\)/.test(insAfter)} · 后有 slice(0,200)=${/slice\(0,\s*200\)/.test(insAfter)} · 后有 502=${/\b502\b/.test(insAfter)}`,
  )

  /* ---------------- ④ 插入那一条带 Prefer: return=representation ---------------- */
  const PREFER = "Prefer: 'return=representation'"
  const preferHits = countIn(PREFER, PCODE)
  const insertAt = PCODE.indexOf("'/rest/v1/push_tokens', {")
  const notOkAt = PCODE.indexOf('if (!ins.ok)')
  const preferAt = PCODE.indexOf(PREFER)
  check(
    preferHits === 1 && insertAt >= 0 && preferAt > insertAt && preferAt < notOkAt,
    '🔴 A25 ④ 往 `push_tokens` 插那一条**带** `Prefer: return=representation`（位置就在 `!ins.ok` 那道判断之前）—— PostgREST 对 POST 默认 `return=minimal` ⇒ 插成功也只回 **201 空体** ⇒ 下一句 `ins.json()` 必抛。**这就是真机那条 `error code: 1101` 的真凶**，也是 register 永远建不起拉取钥匙的原因（全仓别处读 `json()` 的 POST 都显式带这个头）',
    `该头 ${preferHits} 处（须 1）· 插入语句在第 ${insertAt} 字 · Prefer 在第 ${preferAt} 字（须在两者之间）· !ins.ok 在第 ${notOkAt} 字`,
  )

  /* ---------------- 剥注释自证（§三.2：注释里那份会骗过反向对照） ---------------- */
  const rawGuardWord = countIn('请求格式不对', PUSH)
  const codeGuardWord = countIn('请求格式不对', PCODE)
  check(
    rawGuardWord > codeGuardWord && codeGuardWord === 2,
    '🧪 A25 剥注释自证：`请求格式不对` 在原文里比在真代码里多（注释里那一份被剥掉了），而真代码里恰好 2 处（`request.json()` 解析失败那一支 + 形状守卫那一支）—— 证明下面几条看的是**真代码**，不是注释',
    `原文 ${rawGuardWord} 处 · 剥注释后 ${codeGuardWord} 处（须 2）`,
  )

  /* 反向对照 G1：把外层 try 换成 `if (false) {`（副本）⇒ ① 当场假 */
  {
    const hits = mustOnce('try {', POST_BODY, '①反向对照')
    const noTry = POST_BODY.replace('try {', 'if (false) {')
    check(
      noTry !== POST_BODY && !outerOk(noTry),
      '🧪 A25 ① 反向对照：把外层那个 `try {` 换成 `if (false) {`（副本 = 没有兜底的那一版）⇒ ① 当场假 —— 证明它咬的是"整个函数体被 try 罩住"，不是"文件里出现过 try"',
      `目标 ${hits} 处 · 副本被改过=${noTry !== POST_BODY} · 改完 ① 判过=${outerOk(noTry)}（期望 false）`,
    )
  }
  /* 反向对照 G2：把守卫条件换成 `false`（副本）⇒ ② 当场假 */
  {
    const hits = mustOnce(GUARD, PCODE, '②反向对照')
    const noGuard = PCODE.replace(GUARD, 'false')
    check(
      noGuard !== PCODE && !guardOk(noGuard),
      '🧪 A25 ② 反向对照：把守卫条件换成 `false`（副本 = 改之前"不判形状就读 `.action`"的写法）⇒ ② 当场假',
      `目标 ${hits} 处 · 改完 ② 判过=${guardOk(noGuard)}（期望 false）`,
    )
  }
  /* 反向对照 G3：把"先留一份原文"去掉（副本）⇒ ③ 当场假 */
  {
    const hits = mustOnce('ins.clone()', PCODE, '③反向对照')
    const noClone = PCODE.replace('ins.clone()', 'ins')
    check(
      noClone !== PCODE && !insOk(noClone),
      '🧪 A25 ③ 反向对照：把 `ins.clone()`（先留一份原文）去掉（副本 = 改之前裸读的写法）⇒ ③ 当场假 —— 拿不到 JSON 时连响应体都读不出来（body 已被消费）',
      `目标 ${hits} 处 · 改完 ③ 判过=${insOk(noClone)}（期望 false）`,
    )
  }
  /* 反向对照 G4：把那个头换成 return=minimal（副本）⇒ ④ 当场假 */
  {
    const hits = mustOnce(PREFER, PCODE, '④反向对照')
    const noPrefer = PCODE.replace(PREFER, "Prefer: 'return=minimal'")
    check(
      noPrefer !== PCODE && countIn(PREFER, noPrefer) === 0,
      '🧪 A25 ④ 反向对照：把这个头换成 `return=minimal`（副本 = 真机那一版，插成功也只回空体）⇒ ④ 当场假',
      `目标 ${hits} 处 · 改完出现 ${countIn(PREFER, noPrefer)} 处（期望 0）`,
    )
  }
}

/* ============================================================
   🔴 灰档（`shellGray`）**不许跨节** —— 逐节收口的自证（2026-10-05 加）
   ------------------------------------------------------------
   为什么单开这一节：**"静默 no-op"是这个仓库最忌讳的假绿形状**
   （`AGENTS.md` §三.1「门禁自己也要能红」）—— 一条断言被灰档罩住时，
   它**既不红也不绿**，报告里照样写着"全部通过"✓，而它**在 CI 上从来没跑过** ✗。

   原来 `shellGray` 靠**各处手工 `= false`** 收口 ⇒ "下一节还灰不灰"取决于
   "自证那两句恰好被跑到"，而不是"这一节该不该灰" ✗。现在 `section()` 里
   **每开一节一律 `shellGray = false`** ⇒ 灰档在结构上**不可能继承**。

   ⚠️ 本节**故意不建"仿造一份实现再自己验自己"**那种模型（那只能证明模型自洽，
   证明不了真实现 —— 本项目把这个叫"自证假绿"）。这里咬的是**真运行结果**。
   ============================================================ */
section('灰档收口自证：`shellGray` 不许跨节')
{
  /** 正常态：本脚本跑完**一次都不该**出现"带着上一节的灰开新节" */
  const leakOK =
    grayLeakInto === null &&
    shellGray === false &&
    sectionOpens > 30 &&
    grayed === shellGrayCount

  /**
   * 🔴 **对着真源码咬这一句**：把仓库里 `section()` 那个函数体抠出来，逐行排除注释后，
   *    要求里面**恰好有一句**收口。为什么不用 `section.toString()`：`Function.prototype.toString`
   *    返回的是**已经编译过的形态**，注释会被剥掉 ⇒ 后人把那句收口注释掉时
   *    `toString()` 照样"看得见"（其实是没看见），那就成了一条会骗人的自证 ✗。
   *    读**真文件**才掐得住"被注释掉 / 被删掉"两种坏法。
   *    ⚠️ 必须**逐行排除注释行**：这段函数体里我自己就写了「一律 `shellGray = false`」这句
   *       注释 ⇒ 不排除的话会数到 2 处（判据假红，本项目栽过好几次"注释里那份"的坑）。
   */
  const SELF_SRC = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  /**
   * ⚠️ **别在判据里写出被找的那个字符串**：判据自己就住在同一份文件里 ⇒
   *    `indexOf(那个串)` 会把**本行自己**也数上（第一次写就是这么栽的：
   *    `FIRST !== LAST`，`LAST` 指的就是本块里那份字面量）。
   *    ✅ 这里改成**按源码行号定位**：先找到 `section()` 那一行，再取到它的函数体，
   *       全程不把锚点当字符串字面量写出来。
   */
  const SELF_LINES = SELF_SRC.split('\n')
  const fnLine = SELF_LINES.findIndex((l) => /^function\s+\w+\s*\(\s*\w+\s*\)\s*\{$/.test(l.trim()) && l.includes('name'))
  if (fnLine < 0) throw new Error('灰档自证：找不到 `section()` 的声明行 —— 锚点坏了')
  let fnEnd = -1
  for (let i = fnLine + 1; i < SELF_LINES.length; i++) {
    if (SELF_LINES[i] === '}') {
      fnEnd = i
      break
    }
  }
  if (fnEnd < 0) throw new Error('灰档自证：找不到 `section()` 的收尾行 —— 锚点坏了')
  /** 真代码里的收口句 = 排除注释行（`//` 与块注释的 `*` 续行）之后数 */
  const codeLines = SELF_LINES.slice(fnLine, fnEnd + 1).filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//')
  })
  const RESET = 'shellGray' + ' = ' + 'false'
  const resetHits = codeLines.join('\n').split(RESET).length - 1

  /** 🔴 反向对照：把那一句从**内存副本**里抠掉 ⇒ 上面那个判据必须当场数到 0（证明它真在数那一句） */
  const crippledHits = codeLines.join('\n').replace(RESET, '/* 收口被抠掉了 */').split(RESET).length - 1

  check(
    leakOK && resetHits === 1 && crippledHits === 0,
    '🔴 灰档**不许跨节**：每一次开新节都强制 `shellGray = false` ⇒ **没有任何一节带着上一节的灰打开**（否则那一节的断言就是静默 no-op：既不红也不绿、在 CI 上从没跑过，而报告里写着"全部通过"）—— 把 `section()` 那句收口删掉/注释掉、或让谁在本节外把灰档开着，这条当场红',
    `实际跨节泄漏=${grayLeakInto ?? '无'} · 开过节数=${sectionOpens} · 开关=${shellGray} · 灰档计数一致=${grayed === shellGrayCount} · \`section()\` 里收口句 ${resetHits} 处（须 1）· 抠掉后 ${crippledHits} 处（须 0）`,
  )
}

/* ============================================================
   第二十九节 · D19：分块加载失败的自愈 / 那句话与错误码 / 上报（真机反馈 2026-10-06）
   ------------------------------------------------------------
   🔴 现场：`/admin` 错误日志里那条
      「[渲染] Failed to fetch dynamically imported module: …/Workbench-<旧哈希>.js」，
      老师补充"**这是安卓 10 系统上登录时出的**"⇒ 低版本 WebView + 部署换代：
      浏览器里留着**上一版的 `index.html`**（写死旧分块名），新部署一上线旧分块就没了。
   ✅ 三件事都在这一节钉住：① 自愈一次且**不许成环**；② 给老师的是人话+错误码
      （调试期多一行 URL，**一个开关**管着）；③ 上报**复用既有那一条链**。
   🔴 每条都带**反向对照**（改内存副本 ⇒ 当场假）—— 照 `AGENTS.md` §三.2。
   ============================================================ */
section('第二十九节 · D19：分块加载失败要能自愈一次 · 人话+错误码分两档 · 复用既有上报链')

{
  const chunkSrc = readFileSync(join(APP, 'src/lib/chunkReload.ts'), 'utf8')
  const ebSrc = readFileSync(join(APP, 'src/components/ErrorBoundary.tsx'), 'utf8')
  const mainSrc = readFileSync(join(APP, 'src/main.tsx'), 'utf8')

  const count = (s, needle) => s.split(needle).length - 1

  /* ---------- ① 接住哪几类失败（两个事件都要，少一个就漏一半现场） ---------- */
  /*
   * ⚠️ 数的是 **`addEventListener('…')` 那一句**，不是裸事件名 ——
   *    事件名在同一份文件里还会出现在 `removeEventListener` 与注释里（第一次写就数成 5 处假红）。
   */
  const VITE_EV = "addEventListener('vite:preloadError'"
  const ERR_EV = "addEventListener('error'"
  const REJ_EV = "addEventListener('unhandledrejection'"

  const written = chunkSrc.indexOf('function installChunkRecovery')
  /*
   * ⚠️ `indexOf` 取的是**第一次**出现 ⇒ 会命中 import 那一行（`.tsx` 里 `createRoot` 排在
   *    真正的调用之前），量出来是"装在 createRoot 之后"的假红。取**最后一次**才是调用。
   */
  const called = mainSrc.lastIndexOf('installChunkRecovery()')
  /*
   * ⚠️ 锚点必须带 `(document`：`indexOf('createRoot(')` 命中的是**import 那一行**
   *    （`import { createRoot } from 'react-dom/client'` 里的 `createRoot(` 排在最前面）
   *    ⇒ 量出来是"装在 createRoot 之后"的假红。第一次写就踩了这个。
   */
  const rooted = mainSrc.indexOf('createRoot(document')

  check(
    count(chunkSrc, VITE_EV) === 1 &&
      count(chunkSrc, ERR_EV) === 1 &&
      count(chunkSrc, REJ_EV) === 1 &&
      written > 0 &&
      called >= 0 &&
      rooted >= 0 &&
      called < rooted,
    '🔴 D19 ① 接住**三路**：`vite:preloadError`（Vite 官方那条）＋ `error` ＋ `unhandledrejection`（低版本 WebView 上不发第一条的那几种走法），且**装在 `createRoot()` 之前**（`lazy()` 失败比 `useEffect` 早得多，装在 effect 里就接不住"第一次进这一页"）',
    `三处 addEventListener：vite ${count(chunkSrc, VITE_EV)} / error ${count(chunkSrc, ERR_EV)} / unhandledrejection ${count(chunkSrc, REJ_EV)} 处（各须 1）· 调用位置 ${called} ${rooted >= 0 ? `< createRoot 位置 ${rooted}` : '（main.tsx 里没有 createRoot 了？）'}`,
  )

  /* ---------- ② 自愈一次：防循环标记 + 无条件 reload 的反向对照 ---------- */
  const MARK = 'RELOAD_MARK'
  const READ_MARK = 'sessionStorage.getItem(' + MARK
  const SET_MARK = 'sessionStorage.setItem(' + MARK
  const GUARD_RE = /if\s*\(\s*reloadAlreadyTried\(\)\s*\)/
  const reloadCall = 'hardReload()'

  const guardHits = (chunkSrc.match(GUARD_RE) ?? []).length
  const markSetHits = count(chunkSrc, SET_MARK)
  /*
   * ⚠️ 这两个 index 都**只取第一次出现**：函数体里 `setItem` 与 `hardReload()` 各只有一处
   *    （上面 `markSetHits === 1` 由判据自己咬住，不靠这里）。
   */
  const iSet = chunkSrc.indexOf(SET_MARK)
  const iReload = chunkSrc.indexOf(reloadCall, iSet > 0 ? iSet : 0)

  check(
    count(chunkSrc, READ_MARK) === 1 &&
      markSetHits === 1 &&
      guardHits === 1 &&
      iSet > 0 &&
      iReload > iSet,
    '🔴 D19 ② 自愈**只有一次、且不许成环**：`sessionStorage` 里那枚一次性标记先**读**（防重入）再**写**，写标记必须在重载**之前** —— 顺序反了就是"重载被挡住 ⇒ 页面原地停着 ⇒ 下次再刷"，老师手机上一秒一刷还进不去',
    `读标记 ${count(chunkSrc, READ_MARK)} 处 · 写标记 ${markSetHits} 处 · 防循环守卫 ${guardHits} 处 · 写标记@${iSet} < 重载@${iReload}`,
  )

  /* 🔴 反向对照之一：把防循环守卫整句抠掉（副本 = 无条件重载）⇒ 上面那条必须当场假 */
  const crippledGuard = chunkSrc.replace(GUARD_RE, 'if (true)')
  const crippledMark = chunkSrc.replace(SET_MARK, 'sessionStorage.removeItem(' + MARK)
  check(
    (crippledGuard.match(GUARD_RE) ?? []).length === 0 &&
      count(crippledGuard, SET_MARK) === markSetHits &&
      guardHits === 1,
    '🧪 D19 ②-a 反向对照：把 `if (reloadAlreadyTried())` 那个守卫抠掉（副本 = **无条件 reload**）⇒ ② 当场假 —— 证明它真在数"防循环"那一句，不是摆设',
    `原文守卫 ${guardHits} 处 · 抠掉后 ${(crippledGuard.match(GUARD_RE) ?? []).length} 处（须 0）· 写标记 ${count(crippledGuard, SET_MARK)} 处（这条守卫不管写标记，故仍须 ${markSetHits}）`,
  )

  /* 🔴 反向对照之二：把"先落标记"那句拿掉（只重载、不留痕）⇒ 同一枚标记当场数到 0 */
  check(
    count(crippledMark, SET_MARK) === 0 && markSetHits === 1,
    '🧪 D19 ②-b 反向对照：把 `sessionStorage.setItem(RELOAD_MARK, …)` 换掉（副本 = 只重载、不落标记）⇒ ② 当场假 —— 少了这一句就是**无限刷新**',
    `原文写标记 ${markSetHits} 处 · 拿掉后 ${count(crippledMark, SET_MARK)} 处（须 0）`,
  )

  /* ---------- ③ 上报：复用既有封装，绝不新造第二条链 ---------- */
  /*
   * ⚠️ import 是**多行**的（格式化器折过行）⇒ 单行正则判不出来（第一次写就假红）。
   *    这里改成：① 源码里出现 `reportFrontendError` 与 `lib/errors`；② **只有那一处** import；
   *    ③ 本文件里没有裸 `rpc(`。
   * ⚠️ `report_frontend_error` 那个字符串**允许出现在注释里**（要写明用的是哪条 RPC）——
   *    该禁的是**在源码里自己调它**（那才是第二条链）。所以判据落到 `rpc(` 上。
   */
  const importsWrapper = chunkSrc.includes('reportFrontendError') && chunkSrc.includes('lib/errors')
  const importCount = (chunkSrc.match(/^\s*import\b/gm) ?? []).length
  const bareRpc = /(?:sb|supabase)\s*\.\s*rpc\s*\(|(?:^|[^.\w])rpc\s*\(/m.test(chunkSrc)
  const callSites = count(chunkSrc, 'reportFrontendError({')
  check(
    importsWrapper &&
      importCount === 2 &&
      count(chunkSrc, 'import { reportFrontendError }') === 1 &&
      callSites === 1 &&
      !bareRpc,
    '🔴 D19 ③ 上报**走既有的那一个封装** `reportFrontendError()`（`lib/errors.ts`，匿名可调的 `report_frontend_error` RPC 就在它里面）—— 新的一条链会多一份限流/脱敏口径，也要多一处审计',
    `导入既有封装 ${importsWrapper} · 本文件 import 共 ${importCount} 处（须 2：封装 + 版本号）· 封装调用点 ${callSites} 处（须 1）· 自己裸调 rpc( ${bareRpc}（须 false）`,
  )

  /* ---------- ④ 上屏的是人话 + 错误码，且调试/正式**只有一个开关** ---------- */
  const codeUses = (ebSrc.match(/CHUNK_ERROR_CODE/g) ?? []).length
  const debugDef = /export const DEBUG_ERROR_SCREEN = (?:true|false)/.test(chunkSrc)
  const decTheEB = /DEBUG_ERROR_SCREEN\s*=/.test(ebSrc)
  const defCode = /export const CHUNK_ERROR_CODE = 'FE-CHUNK-01'/.test(chunkSrc)
  /*
   * ⚠️ 数的是**布尔判断处**（`{DEBUG_ERROR_SCREEN &&`，带那个开括号），不是那个词本身 ——
   *    同一份文件里那个词还出现在 import 与三处注释里（数词频就是假红）。
   */
  const COND_RE = /\{\s*DEBUG_ERROR_SCREEN\s*&&/g
  const screenCond = (ebSrc.match(COND_RE) ?? []).length
  check(
    defCode &&
      debugDef &&
      codeUses === 3 &&
      screenCond === 1 &&
      !decTheEB &&
      ebSrc.includes('错误码 {code}'),
    '🔴 D19 ④ 给老师的那一句**只有人话 + 错误码**（原文只出现在调试开关那一档里），且**调试/正式只有一个开关**：`DEBUG_ERROR_SCREEN` 定义在 `lib/chunkReload.ts` 一处、`ErrorBoundary` 只读不定义（切正式期 = 只改那一行）',
    `错误码常量定义 ${defCode} · 开关定义（chunkReload 一处）${debugDef} · ErrorBoundary 用错误码 ${codeUses} 处（须 3：import + 取名 + 那一档）· 调试行显示条件 ${screenCond} 处（须 1）· ErrorBoundary 自己定义开关 ${decTheEB}（须 false）· 屏上有"错误码 {code}" ${ebSrc.includes('错误码 {code}')}`,
  )

  /*
   * 🔴 反向对照之三（2026-10-06 写第三版才对，前两版都是**假绿**，形状与 `AGENTS.md` §三.2 同源）：
   *    第一版："把 `DEBUG_ERROR_SCREEN &&` 换成 `false &&`，再数它剩几处（须 0）" ——
   *     那个数是**恒等的 0**（那个串在副本里本来就不存在）⇒ 既不能证明开关在管事，
   *     也不能证明改对了地方；
   *    第二版：用 `$1` 拼替换串，但那是**模板串**、`$1` 是字面量 ⇒ 副本里被塞进
   *     一个新的 `DEBUG_ERROR_SCREEN`，读数反而对不上。
   *    ✅ 现在：锚点**带开括号**（源码里 `DEBUG_ERROR_SCREEN` 先出现在 import 与注释里），
   *       替换串**不含 `$`**，收据用**短路符总数**（恰好多一个 `&&`）。
   */
  const COND = 'DEBUG_ERROR_SCREEN &&'
  const blindReplace = ebSrc.replace(COND, 'false && ' + COND)
  const crippledScreen = ebSrc.replace('{' + COND, '{false && ' + COND)
  const andCount = (s) => (s.match(/&&/g) ?? []).length
  check(
    crippledScreen !== ebSrc &&
      screenCond === 1 &&
      andCount(crippledScreen) === andCount(ebSrc) + 1 &&
      blindReplace !== ebSrc,
    '🧪 D19 ④-a 反向对照：把那一档的显示条件短路成 `{false && DEBUG_ERROR_SCREEN && (…)`（副本 = 正式期只要人话+错误码）⇒ 源码里那个条件**当场被短路**（锚点收据：短路符 +1）—— 这一条自己也被写红过两版，正是"对照也得能红"的活例子',
    `原文条件 ${screenCond} 处（须 1）· 带锚点副本变过 ${crippledScreen !== ebSrc} · 短路符 ${andCount(ebSrc)}→${andCount(crippledScreen)}（须 +1）· 不带开括号的替换也改得到东西 ${blindReplace !== ebSrc}（注释里那份也是同一个串 ⇒ 判据认的必须是带开括号的那个条件）`,
  )

  /* ---------- ⑤ 上报里必须有那几样，且**不许带个人信息** ---------- */
  /*
   * 🔴 这里判的是**上报载荷本身**（不是整份源码，也**先剥掉注释**）：
   *    源码注释里出现"版本号 / 学生"这类字眼是正常的（要写清楚口径），
   *    会被误判成 PII 的只有**载荷**；而载荷的注释块恰好就写着"不带学生信息"（第一次写就假红）。
   */
  const callAt = chunkSrc.indexOf('reportFrontendError({')
  const rawPayload =
    callAt < 0 ? '' : chunkSrc.slice(callAt, chunkSrc.indexOf('})\n  } catch', callAt) + 1)
  const payload = rawPayload.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  const PII_IN_PAYLOAD = [
    ['姓名', /姓名/],
    ['班级', /班级/],
    ['学号', /学号/],
    ['学生', /学生/],
    ['账号类型', /accountKind/],
    ['同步错误', /syncError/],
  ]
  const piiHits = PII_IN_PAYLOAD.filter(([, re]) => re.test(payload)).map(([n]) => n)
  const payloadFields = [
    ['错误码代码', /\[\$\{CHUNK_ERROR_CODE\}\]/],
    ['阶段', /\[阶段=\$\{CHUNK_PHASE\}\]/],
    ['自愈', /\[自愈=\$\{heal\}\]/],
    ['分块URL', /\[url=\$\{url\}\]/],
    ['页面', /\[页面=\$\{pagePath\(\)\}\]/],
    ['版本', /\[版本=\$\{APP_VERSION_LABEL\}\]/],
  ].filter(([, re]) => re.test(payload))
  check(
    rawPayload.length > 0 &&
      payloadFields.length === 6 &&
      piiHits.length === 0,
    '🔴 D19 ⑤ 上报里带 **错误码 + 阶段（加载）+ 自愈状态 + 分块 URL + 页面路径 + 版本号** 六样，且**一个个人信息字段都没有**（姓名/班级/学号/学生/账号类型/同步错误都不许进载荷——那张表会被一起备份）',
    `载荷字段 ${payloadFields.length}/6（${payloadFields.map(([n]) => n).join(' ')}）· 命中个人信息 ${piiHits.length ? piiHits.join(',') : '无'}`,
  )

  /* ---------- ⑥ 那条人话 / 错误码**在真源码里各只有一处**（防止将来被抄成两份走散） ---------- */
  const chunkCodeDef = /export const CHUNK_ERROR_CODE = 'FE-CHUNK-01'/.test(chunkSrc)
  check(
    chunkCodeDef && chunkSrc.includes("const CHUNK_FAIL_RE ="),
    '🔴 D19 ⑥ 错误码与"分块失败"的识别器**都只有一处定义**（`FE-CHUNK-01` / `CHUNK_FAIL_RE`）—— 抄成两份就会走散（本项目栽过：版本号分居两个文件）',
    `错误码定义 ${chunkCodeDef} · 识别器一处 ${chunkSrc.includes('const CHUNK_FAIL_RE =')}`,
  )
}

/* ============================================================
   🆕 教室端口令：班主任**自己设一个**（源码级静态判据 + 反向对照）
   ------------------------------------------------------------
   用户原话：「班级端的密码能不能由班主任自己设置，而不是只能重置」。
   改动只落三个文件：`functions/api/classroom-account.ts`（服务端加 `set`）、
   `src/lib/classroomAccount.ts`（加 `apiSetClassroomPassword`）、
   `src/pages/ClassDetail.tsx`（浮层扩成两选）。
   ⚠️ **强断言**（拿假服务端真打一遍 `onRequestPost`）留在 `rls-checks.mjs` 第二十一节 ——
      那是安全那一路的地盘，**待协调后再补**；本节只做源码级判据。
   ============================================================ */
section('🆕 教室端口令：班主任自己设一个（set 的源码级判据 + 反向对照）')
{
  const raw = readApp('functions/api/classroom-account.ts')
  /* 🔴 剥注释：注释里也写着 makePassword / password / 业务库这些名字 —— 不剥就是假红 */
  const naked = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, ' ')

  const once = (t, s) => t.split(s).length - 1
  const oneEdit = (t, from, to) => (once(t, from) === 1 ? t.replace(from, to) : null)

  /** `set` 分支那一段（锚点：`if (action === 'set')` → 建号那一支的 `pickEmail`） */
  const SET_HEAD = "if (action === 'set')"
  const SET_TAIL = 'const email = await pickEmail(env, cls.name)'
  const branchOf = (t) => {
    const a = t.indexOf(SET_HEAD)
    const b = t.indexOf(SET_TAIL)
    return a >= 0 && b > a ? t.slice(a, b) : ''
  }

  /**
   * `classroom_accounts` 每一条写入的 JSON body：**按大括号配平取**，
   * 不靠"URL 后面 N 个字符"猜（猜的窗口要么漏掉写进去的口令、要么把别处的 `password` 误当写入）。
   * 只在 URL 之后 400 字符内找 `body:` —— 再远就不是这一条请求的了。
   */
  const bodiesOf = (t) => {
    const out = []
    for (const m of t.matchAll(/\/rest\/v1\/classroom_accounts/g)) {
      const at = t.indexOf('body: JSON.stringify(', m.index)
      if (at < 0 || at - m.index > 400) continue
      const open = t.indexOf('{', at)
      let depth = 0
      for (let i = open; i < t.length; i++) {
        if (t[i] === '{') depth++
        else if (t[i] === '}') {
          depth--
          if (depth === 0) {
            out.push(t.slice(open, i + 1))
            break
          }
        }
      }
    }
    return out
  }
  const dbOk = (t) => {
    const bodies = bodiesOf(t)
    return bodies.length === 4 && !bodies.some((b) => /password/.test(b))
  }
  const setOk = (t) => {
    const b = branchOf(t)
    return b.length > 200 && b.includes('body.password') && !/makePassword/.test(b)
  }
  const gateOk = (t) => {
    const g = "if (!mayManage(roles, cls)) {"
    return once(t, g) === 1 && t.indexOf(SET_HEAD) > t.indexOf(g)
  }
  const auditOk = (t) => {
    const a = t.indexOf('async function auditRow(')
    const b = a >= 0 ? t.indexOf('\n}', a) : -1
    const body = a >= 0 && b > a ? t.slice(a, b) : ''
    return body.includes('try {') && body.includes('} catch {') && body.includes('return false')
  }

  const setBranch = branchOf(naked)
  const audited = (t) => (t.match(/await auditRow\(/g) ?? []).length

  /* ---- ① 动作契约里有 `set` ---- */
  const CONTRACT = "'create' | 'reset' | 'set' | 'disable' | 'enable' | 'status'"
  check(
    naked.includes(CONTRACT),
    `① 动作契约里有 set（六个值：${CONTRACT}）—— 自设口令是一个**新动作**，不是把 reset 拆开`,
    `六个值的联合类型 ${naked.includes(CONTRACT) ? '在' : '不在'}`,
  )
  check(
    setBranch.length > 200,
    '① 自证：`set` 分支那一段真的被切出来了（切不出来下面几条就是在量空串 —— 假绿）',
    `锚点之间 ${setBranch.length} 个字符`,
  )

  /* ---- ② 复用同一个 `mayManage()` 闸门，不另写判据 ---- */
  check(
    gateOk(naked),
    '🔴 ② `set` 分支复用**同一个** `mayManage()` 闸门（全文件只有这一处闸门，且 `set` 分支在它**之后**）—— 班主任本来就有权，缺的只是"自己定一个"',
    `闸门 ${once(naked, "if (!mayManage(roles, cls)) {")} 处 · set 分支在闸门之后 ${gateOk(naked)}`,
  )
  check(
    setBranch.length > 0 && !/\brole\b|scope_id|can_manage/.test(setBranch),
    '🔴 ② `set` 分支里**没有第二套权限判据**（不出现 `role` / `scope_id` / `can_manage`）—— 权限名单不变（`can_manage_class_for()` 逐档相等那条在 `rls-checks` 第二十一节②）',
    `分支里出现角色判据 ${/\brole\b|scope_id|can_manage/.test(setBranch)}`,
  )

  /* ---- ③ 口令来自调用者（不是 `makePassword()`），且规则是 6–12 位 + 字母 + 数字 + 禁空格 ---- */
  check(
    setOk(naked),
    '🔴 ③ `set` 分支的 password **来自调用者**（读 `body.password`），**没有**调用 `makePassword()` —— 随机生成那条只归 `reset`',
    `读调用者传入 ${setBranch.includes('body.password')} · 出现 makePassword ${/makePassword/.test(setBranch)}`,
  )
  check(
    /function passwordProblem\(pw: string\): string \| null/.test(naked) &&
      naked.includes('const PW_MIN = 6') &&
      naked.includes('const PW_MAX = 12') &&
      /\/\[A-Za-z\]\//.test(naked) &&
      /\/\[0-9\]\//.test(naked) &&
      /\/\\s\//.test(naked) &&
      setBranch.includes('passwordProblem(password)') &&
      setBranch.includes('message: bad }, 400)'),
    '🔴 ③ 口令规则是 **6 到 12 位 + 字母和数字都要有 + 不许有空格**（`PW_MIN = 6` / `PW_MAX = 12` / `[A-Za-z]` / `[0-9]` / `\\s`），且 `set` 分支真的过这道规则、不合规回 **400 + 人话**（不是课代表口令那条 6–12 位）',
    `规则函数在 ${/function passwordProblem/.test(naked)} · 上下限 ${naked.includes('const PW_MIN = 6')}/${naked.includes('const PW_MAX = 12')} · set 分支过规则 ${setBranch.includes('passwordProblem(password)')} · 400 ${setBranch.includes('message: bad }, 400)')}`,
  )

  /* ---- ④ 业务库一个字段都不写（口令只去 GoTrue 的 auth.users） ---- */
  check(
    dbOk(naked),
    '🔴 ④ `classroom_accounts` 的**每一条写入路径**里都没有 `password`（自证：正好 4 条写入 —— 停用/恢复、随机重置、自己设置、建号；多一条就要来这儿说清它为什么该在）',
    `${bodiesOf(naked).length} 条写入 · 含 password 的 ${bodiesOf(naked).filter((b) => /password/.test(b)).length} 条`,
  )
  {
    const pwBodies = [...naked.matchAll(/JSON\.stringify\(\{\s*password\s*\}\)/g)]
    const putAt = naked.indexOf('function putPassword(')
    const putEnd = putAt >= 0 ? naked.indexOf('\n}', putAt) : -1
    const putBody = putAt >= 0 && putEnd > putAt ? naked.slice(putAt, putEnd) : ''
    check(
      pwBodies.length === 1 &&
        putBody.includes('JSON.stringify({ password })') &&
        putBody.includes('/auth/v1/admin/users/'),
      '🔴 ④ 全文件**只有一处**把口令序列化（`JSON.stringify({ password })`），且它在 `putPassword()` 里、打给 GoTrue 的 `/auth/v1/admin/users/{id}` —— `set` 与 `reset` 走的是同一条路',
      `序列化 ${pwBodies.length} 处 · putPassword 里有它 ${putBody.includes('JSON.stringify({ password })')} · 打的是 GoTrue ${putBody.includes('/auth/v1/admin/users/')}`,
    )
  }

  /* ---- ⑤ 留痕：包成不影响响应 ---- */
  check(
    auditOk(naked),
    '🔴 ⑤ 留痕写入被包住：`auditRow()` 自己 `try`/`catch`、失败回 `false`（**绝不抛错**）—— 留痕失败不许把一次已经改成功的换密码变成 500',
    `auditRow 里有 try/catch + return false ${auditOk(naked)}`,
  )
  check(
    audited(setBranch) >= 2 &&
      setBranch.includes("action: 'classroom.set'") &&
      setBranch.includes('audited: auditedBefore && auditedFail') &&
      setBranch.includes('audited: auditedBefore && auditedAfter'),
    '🔴 ⑤ `set` 动手前后**各一条**留痕（`classroom.set`，失败那条也写），且 `audited` 随回话带出 —— 留痕失败看得见，但不影响响应',
    `set 分支 auditRow ${audited(setBranch)} 次 · action 名 ${setBranch.includes("action: 'classroom.set'")} · 成功/失败都带回 audited ${setBranch.includes('audited: auditedBefore && auditedFail') && setBranch.includes('audited: auditedBefore && auditedAfter')}`,
  )
  {
    const a = naked.indexOf("if (action === 'reset')")
    const b = naked.indexOf(SET_HEAD)
    const resetBranch = a >= 0 && b > a ? naked.slice(a, b) : ''
    check(
      resetBranch.includes("action: 'classroom.reset'") && audited(resetBranch) >= 2,
      '🔴 ⑤ 顺手：**随机重置（reset）也留痕**（`classroom.reset`，前后各一条）—— 口令类动作两条路都留痕',
      `reset 分支 auditRow ${audited(resetBranch)} 次 · action 名 ${resetBranch.includes("action: 'classroom.reset'")}`,
    )
  }

  /* ---------------- 反向对照（内存副本，不落盘） ----------------
     纪律（`AGENTS.md` 三·2）：**先断言目标出现次数恰好 1，再替换** ——
     不是 1 处就说明锚点变了，那一条对照**自己红**，绝不假绿。 */
  const rcGate = oneEdit(naked, "if (!mayManage(roles, cls)) {", 'if (false) {')
  check(
    gateOk(naked) === true && rcGate !== null && gateOk(rcGate) === false,
    '🧪 ② 反向对照：把 `mayManage()` 那一句抠掉（副本里换成 `if (false) {`）⇒ 「闸门只有一处、且 set 在它之后」**当场假** —— 证明②咬的正是那个闸门',
    `原文 ${gateOk(naked)} · 副本 ${rcGate === null ? '锚点不是恰好 1 处（对照自己红）' : gateOk(rcGate)}`,
  )
  const rcSet = oneEdit(
    naked,
    "const password = typeof body.password === 'string' ? body.password : ''",
    'const password = makePassword()',
  )
  check(
    setOk(naked) === true && rcSet !== null && setOk(rcSet) === false,
    '🧪 ③ 反向对照：把 `set` 分支里的口令换回 `makePassword()`（副本）⇒ 「口令来自调用者」**当场假** —— 证明③真的在量那条赋值',
    `原文 ${setOk(naked)} · 副本 ${rcSet === null ? '锚点不是恰好 1 处（对照自己红）' : setOk(rcSet)}`,
  )
  const rcDb = oneEdit(
    naked,
    '      email,\n      created_by: uid,',
    '      email,\n      password,\n      created_by: uid,',
  )
  check(
    dbOk(naked) === true && rcDb !== null && dbOk(rcDb) === false,
    '🧪 ④ 反向对照：往建号那条写库语句里塞一个 `password`（副本，就是"把口令写进业务库"的样子）⇒ 「业务库里没有口令」**当场假**',
    `原文 ${dbOk(naked)} · 副本 ${rcDb === null ? '锚点不是恰好 1 处（对照自己红）' : dbOk(rcDb)}`,
  )
  const rcAudit = oneEdit(
    naked,
    '    return res.ok\n  } catch {\n    return false',
    '    return res.ok\n  } finally {\n    return false',
  )
  check(
    auditOk(naked) === true && rcAudit !== null && auditOk(rcAudit) === false,
    '🧪 ⑤ 反向对照：把留痕那层 `try`/`catch` 换成 `try`/`finally`（副本）⇒ 「留痕被包住、失败回 false」**当场假** —— 证明⑤咬的是那层兜底',
    `原文 ${auditOk(naked)} · 副本 ${rcAudit === null ? '锚点不是恰好 1 处（对照自己红）' : auditOk(rcAudit)}`,
  )
}

/* ---------------- 结果 ---------------- */
console.log(`\n================ 结果 ================`)

console.log(
  `  断言：通过 ${passed} 条，失败 ${failures.length} 条${grayed ? ` · 灰（探不到，不红不绿）${grayed} 条` : ''}`,
)
for (const f of failures) console.log(`  ❌ ${f}`)
if (failures.length) {
  console.log('\n  ⛔ 有断言没过（上面每一条都写了实测值）')
  process.exitCode = 1
} else if (grayed) {
  /*
   * 🔴 三态：**有灰就不许再说"全部通过"**（那正是把"量不到"读成"验过了"）。
   *    典型情形 = CI 的干净检出：打包工程不在这个公开仓库里 ⇒ A21/A22 的壳那一侧落灰
   *    （原因见上面那几行 `⏭`），而 app 侧那几条照旧逐条判过。
   */
  console.log(
    `  通过 ✅（另有 ${grayed} 条**灰**：那一半输入本机没有 —— 打包工程不进这个公开仓库，详见上面 ⏭ 那几行）`,
  )
} else {
  console.log('  全部通过 ✅（纯函数 A1–A16 / 静态 D1–D7 · D9 · D10 · D11 · D12 · D13 · D14 · D15 · D16 · D17 · D18 / 编码 + 不可见字符 D8）')
}
}, { script: 'nav-checks.mjs' })
