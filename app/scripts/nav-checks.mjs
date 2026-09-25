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
 *   · 静态（D1–D7 / D9 / D10）：路由 ↔ 登记表 ↔ 本文档矩阵三方咬合；入口判据不许各写一套；
 *     谁在读 `myRoles` / `ROLE_NAME` 要有白名单；`PIN_KEYS` 不许脱队；
 *     生产构建里测试钩子不许出现；
 *     🆕 **D10：表存在性探针不许假设任何列存在**（`select('*')`）+
 *     「表不在」与「列不在」判据分流（这一类 bug 已经咬了两次：`subjects` / `notice_targets`）。
 *   · 编码（D8）：全仓文本文件的无 BOM / 严格 UTF-8 / 中文没被 mojibake，
 *     外加**不可见字符 / 全角标点混进代码** ——
 *     这个项目**反复栽在编码上**（BOM 出过构建失败、上一轮又出双重编码乱码），
 *     而全仓扫一遍成本极低。带反向对照（伪造的坏字节流 / 坏字符必须被判坏）。
 * ============================================================
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

function section(name) {
  currentSection = name
  if (!printed.has(name)) {
    printed.add(name)
    console.log(`\n── ${name}`)
  }
}

function check(ok, label, observed, extra = '') {
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
  // 只有 super / admin（`canManageTeachers()`）—— §2.3 ***REMOVED***27
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
  /* ①′ 的 6 列小计：34 行原样 + 通知两行 → 153 / 29 / 34（方案 §四.0） */
  eq('A8 对账：145 + 8 = 153（①′ 的 V）', MATRIX_SHAPE.v + 8, 153)
  eq('A8 对账：27 + 2 = 29（①′ 的 E）', MATRIX_SHAPE.e + 2, 29)
  eq('A8 对账：32 + 2 = 34（①′ 的 B —— 教室端那两格）', MATRIX_SHAPE.b + 2, 34)
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
 * `按身份显示导航方案.md` §2.2 矩阵里的那 **34 条路径**（**写死的清单**）。
 *
 * 为什么写死而不是读文档：D1 要能独立于 D2 的解析器工作 ——
 * D2 的锚点一旦坏了，D2 自己会红，但 D1 不该跟着一起瞎。
 * ⚠️ 这 34 条**一条都不许改**（`MATRIX_SHAPE` 那个口径的实体）。
 */
const MATRIX_PATHS = [
  '/login', '/classroom', '/', '/classes', '/classes/:id',
  '/classes/:id/import/photo', '/classes/:id/import/paste',
  '/assignments', '/assignments/new', '/assignments/:id/collect', '/assignments/:id/grade',
  '/assignments/:id/correct', '/assignments/:id/import', '/assignments/:id/grade/done',
  '/assignments/:id/stats', '/assignments/:id/call', '/calls', '/exams', '/exams/new',
  '/exams/:id/grade', '/exams/:id/stats', '/schedule', '/files', '/wrong', '/wrong/:classId',
  '/settings', '/accounts', '/grades', '/grades/:id', '/grades/:id/setup',
  '/grades/:id/promote', '/settings/terms', '/admin', '/admin/probes',
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
   * 自证（§4.4 的纪律）：**两个等式一起成立**才能防住"删掉 6 条规划项 + 偷偷加 6 条路由"
   * 互相抵消成绿。所以再把那 6 条 ★ 用**写死的清单**核一遍（不信 `live` 字段本身）。
   *
   * ⚠️ **`/admin` 不在这一组里**：方案 §2.2 给它带了 ★，但它的**路由其实已经落了**
   *    （超管面板第一期），只有入口是新的 —— 所以"规划中"是 6 条，不是 7 条。
   *    这是本轮发现的**方案自身的一处偏差**，已在两份文档里写明。
   */
  const PLANNED6 = [
    '/grades',
    '/grades/:id',
    '/grades/:id/setup',
    '/grades/:id/promote',
    '/settings/terms',
    '/admin/probes',
  ]
  eqSet('D1：规划中的路径就是那 6 条（写死核对，不看 live 字段）', planned, PLANNED6)
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
    'D1：PAGES 里在矩阵里的行数 == 矩阵行数（34）',
    PAGES.filter((p) => MATRIX_PATHS.includes(p.path)).length,
    MATRIX_SHAPE.rows,
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

section('第八节 · D2：方案 §2.2 矩阵（第二个单元格）↔ PAGES — 34 行 / V145 / E27 / B32')

function parseMatrix() {
  const doc = readRepo('按身份显示导航方案.md')
  const at = doc.indexOf('***REMOVED******REMOVED******REMOVED*** 2.2')
  if (at < 0) throw new Error('找不到 `***REMOVED******REMOVED******REMOVED*** 2.2`（锚点变了）')
  /*
   * 🔴 锚点必须**先切后取**（§18.3 那个"锚点跨过中间全部内容、把 schema 咬掉一大块
   * 而 `if (!m) throw` 抓不到"的坑）：从 `***REMOVED******REMOVED******REMOVED*** 2.2` 切到**下一个 `***REMOVED******REMOVED******REMOVED***`** 为止，
   * 再在**这一段里**找表行。别用贪婪的 `[\s\S]*?`。
   */
  const rest = doc.slice(at + 4)
  const end = rest.indexOf('***REMOVED******REMOVED******REMOVED***')
  if (end < 0) throw new Error('`***REMOVED******REMOVED******REMOVED*** 2.2` 之后找不到下一个 `***REMOVED******REMOVED******REMOVED***`（锚点咬到文件末尾了）')
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
     *   [0] 序号 `***REMOVED***` · [1] 路由 · [2] 入口在哪 · [3] 路由(有/★新) · [4..9] 六个身份
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

{
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
     * 不许静默通过）。写死的 34 / 145 / 27 / 32 是方案 §2.2 "规模感"那张表的自检值。
     */
    eq('D2 自证：矩阵行数', mx.paths.length, MATRIX_SHAPE.rows)
    eq('D2 自证：V 格数', mx.sum.v, MATRIX_SHAPE.v)
    eq('D2 自证：E 格数', mx.sum.e, MATRIX_SHAPE.e)
    eq('D2 自证：B 格数', mx.sum.b, MATRIX_SHAPE.b)
    eq('D2 自证：V+E+B == 行数 × 6', mx.sum.v + mx.sum.e + mx.sum.b, MATRIX_SHAPE.rows * 6)
    eqSet(
      'D2：矩阵路径 ↔ PAGES 里那 34 条（通知两行不在 §2.2 的矩阵里，见 D9）',
      mx.paths,
      PAGES.map((p) => p.path).filter((p) => MATRIX_PATHS.includes(p)),
    )
    /* 逐角色的小计也核（方案 §2.2 里那张"每个角色 V/E/B"的表） */
    const ROLE_SUM = [
      { v: 33, e: 1, b: 0 },
      { v: 31, e: 3, b: 0 },
      { v: 29, e: 5, b: 0 },
      { v: 25, e: 9, b: 0 },
      { v: 25, e: 9, b: 0 },
      { v: 2, e: 0, b: 32 },
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
   * 方案 §2.2 是按路由族排的；`/files` 在 PAGES 里排在 `/accounts` 前面，矩阵里是 ***REMOVED***23 vs ***REMOVED***27）
   * → **按路径 join**（`pathEntry` 那张表），不是 `PAGES[i]`。
   *
   * ⚠️ **只比那 34 行**（`MATRIX_PATHS`）：`PAGES` 现在还多了通知那两行，
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
   这是本轮新增的**第二组分母**（方案 §四.0 的 ②）：**36 行 × 13 列 = 468 格**
   （其中 30 格是办公室主任那一列的 `—` 不适用）。

   🔴 它与 D2 **不是同一张表**，所以**分开解析、分开断言**：
      · D2 读 `按身份显示导航方案.md` §2.2（**34 × 6 = 204**）→ `MATRIX_SHAPE`
      · D9 读 `管理架构与角色权限方案.md` §4.2（**36 × 13 = 468**）→ `MATRIX_SHAPE_13`
      **两个口径不许互相推导**（列数不同，"相减"出来的数没有意义 —— 方案 §4.0 原文）。

   🔴 **D9 的核心一条**：把矩阵里**每一格**与 `ENTRIES` **真算出来**的值对上。
      这正是"文档说的"与"代码做的"之间那根线（D2 里同样有一根）——
      没有它，13 列那 468 格就只是文档里的一堆字母。
   ============================================================ */

section('第八节之二 · D9：管理架构方案 §4.2 的 13 列矩阵（36 行 / V344 / E60 / B34 / —30）')

/**
 * 解析 `管理架构与角色权限方案.md` §4.2 的矩阵。
 *
 * 锚点纪律与 D2 逐字相同（**先切后取**，别用贪婪正则）：
 * 从 `***REMOVED******REMOVED******REMOVED*** 4.2 ` 切到下一个 `***REMOVED******REMOVED******REMOVED***` 为止，再在这一段里找表行。
 */
function parseMatrix13() {
  const doc = readRepo('管理架构与角色权限方案.md')
  const at = doc.indexOf('***REMOVED******REMOVED******REMOVED*** 4.2 ')
  if (at < 0) throw new Error('找不到 `***REMOVED******REMOVED******REMOVED*** 4.2 `（锚点变了）')
  const rest = doc.slice(at + 4)
  const end = rest.indexOf('***REMOVED******REMOVED******REMOVED***')
  if (end < 0) throw new Error('`***REMOVED******REMOVED******REMOVED*** 4.2` 之后找不到下一个 `***REMOVED******REMOVED******REMOVED***`（锚点咬到文件末尾了）')
  const sec = rest.slice(0, end)
  const lines = sec.split('\n').filter((l) => l.startsWith('|'))
  if (lines.length < 36) throw new Error(`§4.2 里只解析到 ${lines.length} 行表行 —— 锚点多半错了`)

  /** 表头那一行：`| ***REMOVED*** | 入口 | 路由 | 超 | 教 | … |` —— 拿它核列序（缩写） */
  const headerLine = lines.find((l) => l.includes('| 入口 |'))
  const headerCells = headerLine
    ? headerLine.split('|').slice(1).map((c) => c.trim()).filter((c, i, a) => !(i === a.length - 1 && c === ''))
    : []
  const heads = headerCells.slice(3) // 去掉 `***REMOVED***` / `入口` / `路由` 三格

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
    // 13 列 + 3 格（***REMOVED*** / 入口 / 路由）= 16 格；表头与 `| --- |` 分隔行靠"第三格是 `/` 开头的路径"排掉
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
      else unknown.push(`${m[1]}***REMOVED***${i + 1}:${JSON.stringify(t)}`)
    })
    cells.push(thirteen.map((t) => t.charAt(0)))
  }
  const sum = perCol.reduce(
    (a, c) => ({ v: a.v + c.v, e: a.e + c.e, b: a.b + c.b, x: a.x + c.x }),
    { v: 0, e: 0, b: 0, x: 0 },
  )
  return { paths, cells, perCol, sum, heads, unknown }
}

{
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
    /* 形状自证：36 / 344 / 60 / 34 / 30 */
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
     * 36 行 = 原来那 34 行 + 通知那两行。
     * ⚠️ 这一条是"**不推翻那 204 格**"的机器版：前 34 条路径必须与 D1 的写死清单
     *    **逐项相等**（顺序可以不同，集合必须相等）。
     */
    eqSet('D9：13 列矩阵的行 ↔ §2.2 的 34 条路径 + 通知两行', mx.paths, [
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
    const ALLOWED = ['isSuperAdmin', 'canManageTeachers', 'canAssignRoles', 'hasManagingRole', 'canPublishNotice', 'seesTeachingData']
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
   * ⚠️ 白名单**今天有 8 个**，比方案 §4.2 里写的 4 个多四个 —— 每一个都写清了理由，
   *    而且四个都是"这一轮/上一轮新出现的"，所以**这一条审计第一次跑就抓到了东西**
   *    （这正是它该有的样子，别把清单改成"永远为绿"）：
   *      · `src/pages/Admin.tsx`    上一轮（超管面板第一期）落的文件：`isSuperAdmin(myRoles)` 只决定摆不摆
   *      · `src/App.tsx`            本轮的 DEV 钩子（把 `?as=` 注进 `myRoles`，生产构建里被摇掉）
   *      · `src/data/store.ts`      `myRoles` 这个**槽位的定义处**（state + hydrate/signOut 写入）
   *      · `src/lib/roles.ts`       入口表与判据的**定义处**
   *    加一个就要在这里加一行并写理由。
   */
    const ROLE_READERS = new Map([
      ['src/pages/Settings.tsx', '身份卡 + 我的身份（显示）+ 三行入口读 entryVisible'],
      ['src/pages/TeacherAccounts.tsx', '身份区按钮显隐（canAssignRoles）+ 身份名文案'],
      ['src/components/AppShell.tsx', '当前身份标签（显示）+ NAV 过滤（**唯一一处真·入口判据**）+ 🆕通知未读红点'],
      ['src/pages/Workbench.tsx', '问候语里的身份标签（显示）+ 🆕「最新通知」那一块的入口显隐'],
      ['src/pages/Admin.tsx', '面板内的东西显隐（isSuperAdmin）+ 只读体检屏（上一轮新落）'],
      ['src/pages/Notices.tsx', '🆕「发通知」按钮的显隐（canPublishNotice）—— 只决定摆不摆，服务端仍会 403'],
      ['src/pages/NoticeNew.tsx', '🆕 发通知页：不能发的人进来看到一句说明（不是判据）+ 职位显示名'],
      ['src/App.tsx', 'DEV 钩子：把 ?as= 注进 myRoles（**只测试用，生产构建里被摇掉**，D7 钉住）'],
      ['src/data/store.ts', '`myRoles` 这个槽位的**定义处**（state + hydrate/signOut 写入，不是读取处）'],
      ['src/data/types.ts', '🆕 `RoleCode` 这个**类型的定义处**（注释里引用了 `ROLE_NAME` 这个名字，不读它的值）'],
      ['src/lib/notices.ts', '🆕 通知的**数据层**里那条显示用的小工具（`noticeScopeText`，把范围翻成一句话）'],
      ['src/lib/roles.ts', '入口表与判据的定义处（不是读取处）'],
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
    ['src/pages/TeacherAccounts.tsx', 'filter 的是任课关系多选（与角色无关）'],
    ['src/pages/Workbench.tsx', 'filter 的是今日待办（与角色无关）'],
    ['src/pages/Notices.tsx', '🆕 filter 的是通知列表的**排序前拷贝**（与角色无关，未读那一段也是服务端给的）'],
    ['src/pages/NoticeNew.tsx', '🆕 filter 的是"我能发的范围选项"（**选项，不是数据行** —— 清单由数据库给）'],
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
  eq('D6：NAV 有 8 项（🆕 2026-09-28 加了「通知」）', navKeys.length, 8)
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

section('第十一节 · D7：dist 产物里没有 `?as=` / `?kind=` 的痕迹（生产构建无效）')

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
      ['devInjectedRoles', '钩子函数名'],
      ['devInjectedAccountKind', '钩子函数名'],
      ['devInjectedSyncError', '钩子函数名'],
    ]) {
      eq(`D7：产物里没有 ${why}`, all.includes(needle), false)
    }
    /*
     * 反向对照（**必须的**）：如果构建产物里连 `myRoles` 都没有，那上面四条
     * "没找到"就是废话（整个应用都被摇掉了）。所以先证明产物里**有**这个东西。
     */
    check(all.includes('myRoles'), 'D7 反向对照：产物里**有** myRoles（证明上面四条不是"什么都搜不到"）', all.includes('myRoles') ? '在' : '不在（构建产物不对）')
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
     CSS：块注释；`.gitignore`：行首 `***REMOVED***`。⚠️ `*\/` 里那个反斜杠是故意的 ——
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
                     按行首 `***REMOVED***` 判断不出"这个全角标点在键里还是值里"，判红必误报。
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
       * 让"这一行以 `***REMOVED***` 开头吗"（本仓库只有 `.gitignore` 走这条规则）永远判错 ——
       * 这个 bug 真的发生过一次：`.gitignore` 里 12 处 `***REMOVED***` 注释被当成代码判红。
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
      // `***REMOVED***` 只有"这一行第一个非空白字符"才算注释（不是行内注释）—— 宁可漏报
      if (syn.hash && c === '***REMOVED***' && prevChar === '') {
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

/* ---------------- 结果 ---------------- */

console.log(`\n================ 结果 ================`)
console.log(`  断言：通过 ${passed} 条，失败 ${failures.length} 条`)
for (const f of failures) console.log(`  ❌ ${f}`)
if (failures.length) {
  console.log('\n  ⛔ 有断言没过（上面每一条都写了实测值）')
  process.exitCode = 1
} else {
  console.log('  全部通过 ✅（纯函数 A1–A10 / 静态 D1–D7 · D9 · D10 / 编码 + 不可见字符 D8）')
}
}, { script: 'nav-checks.mjs' })
