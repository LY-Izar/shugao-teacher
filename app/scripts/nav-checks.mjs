/**
 * 按身份显示导航 · 静态审计 + 纯函数断言（`按身份显示导航方案.md` §五 R1/R4）
 * 用法：npm run nav-checks（纯 Node，不连浏览器；但 D7 要读 `npm run build` 的产物）
 *
 * 为什么单开一个脚本、不塞进 `shots.mjs`：`shots.mjs` 是**真浏览器 + 拨表 + 95 张图**
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
 *   · 纯函数（A1–A7）：角色组合 → 该看见哪些入口。**"该藏的时候藏了、该显示的时候显示了"**
 *     两个方向都钉（§18.3：两个坏法方向相反，各要一条对照）。
 *   · 静态（D1–D7）：路由 ↔ 登记表 ↔ 本文档矩阵三方咬合；入口判据不许各写一套；
 *     谁在读 `myRoles` / `ROLE_NAME` 要有白名单；`PIN_KEYS` 不许脱队；
 *     生产构建里测试钩子不许出现。
 *   · 编码（D8）：全仓文本文件的无 BOM / 严格 UTF-8 / 中文没被 mojibake ——
 *     这个项目**反复栽在编码上**（BOM 出过构建失败、上一轮又出双重编码乱码），
 *     而全仓扫一遍成本极低。带反向对照（伪造的坏字节流必须被判坏）。
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
const { PAGES, PLANNED_PAGE_COUNT, MATRIX_SHAPE } = await import('../src/lib/pages.ts')

/** 矩阵里的 6 列（顺序 = 方案 §2.2 表头里的顺序，不许改） */
const ROLES6 = [
  { key: 'super', label: 'super 最高管理员', roles: [{ role: 'super' }] },
  { key: 'admin', label: 'admin 教导处', roles: [{ role: 'admin' }] },
  { key: 'grade_head', label: 'grade_head 年级主任', roles: [{ role: 'grade_head' }] },
  { key: 'head_teacher', label: 'head_teacher 班主任', roles: [{ role: 'head_teacher' }] },
  { key: 'teacher', label: 'teacher 任课教师', roles: [{ role: 'teacher' }] },
  { key: 'classroom', label: 'classroom 教室端', roles: [] },
]

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
   */
  const classroomVis = roles.entryVisible(entry, [])
  eq(
    `A1：教室端（roles=[]）对 ${entry} —— 没有 teacher_roles 行，管理入口一个都拿不到`,
    classroomVis,
    EXPECTED[entry].teacher && !roles.hasManagingRole([]),
  )
}
check(
  Object.keys(EXPECTED).length * ROLES6.length === 84,
  'A1 的格数 = 6 × 14 = 84（教室端那一列断言的是"这条边界在哪"，见上方注释）',
  `${Object.keys(EXPECTED).length} × ${ROLES6.length} = ${Object.keys(EXPECTED).length * ROLES6.length}`,
)

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
  ["[{role:'principal'}]（字典里没有的值）", [{ role: 'principal' }]],
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
}

/* ============================================================
   第七节 · D1：App.tsx 的路由 ↔ PAGES 登记表
   ============================================================ */

section('第七节 · D1：App.tsx 的 path="…" ↔ lib/pages.ts 的 PAGES（集合相等）')

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
  check(
    PAGES.length === MATRIX_SHAPE.rows,
    `D1：PAGES 总条数 == 矩阵行数（${MATRIX_SHAPE.rows}）`,
    `PAGES = ${PAGES.length}`,
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
    eqSet('D2：矩阵路径 ↔ PAGES（多一条少一条都红）', mx.paths, PAGES.map((p) => p.path))
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
     * ⚠️ **矩阵里的格子值 vs `ENTRIES` 真算出来的值** —— 这是把"文档说的"与"代码做的"
     * 接起来的那一根线。两个数组**不能按下标配对**（PAGES 是按"归属"分组的，
     * 方案 §2.2 是按路由族排的；`/files` 在 PAGES 里排在 `/accounts` 前面，矩阵里是 ***REMOVED***23 vs ***REMOVED***27）
     * → **按路径 join**（`pathEntry` 那张表），不是 `PAGES[i]`。
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
     */
    const ALLOWED = ['isSuperAdmin', 'canManageTeachers', 'canAssignRoles', 'hasManagingRole']
    const inline = rules.filter((b) => b.includes('=>'))
    eqSet('D3：就地写的判据只能是 `() => true`，别的内联箭头函数一律红', inline, ['() => true'])
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
    ['src/components/AppShell.tsx', '当前身份标签（显示）+ NAV 过滤（**唯一一处真·入口判据**）'],
    ['src/pages/Workbench.tsx', '问候语里的身份标签（显示）'],
    ['src/pages/Admin.tsx', '面板内的东西显隐（isSuperAdmin）+ 只读体检屏（上一轮新落）'],
    ['src/App.tsx', 'DEV 钩子：把 ?as= 注进 myRoles（**只测试用，生产构建里被摇掉**，D7 钉住）'],
    ['src/data/store.ts', '`myRoles` 这个槽位的**定义处**（state + hydrate/signOut 写入，不是读取处）'],
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
  eq('D6：NAV 有 7 项', navKeys.length, 7)
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
      ['devInjectedRoles', '钩子函数名'],
      ['devInjectedAccountKind', '钩子函数名'],
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
   ------------------------------------------------------------
   为什么从 9 个文件扩到全仓：这个项目**反复栽在编码上** ——
   `Admin.tsx` 那一轮用 PowerShell 文本 cmdlet 回写，整份文件变成双重编码乱码 + BOM
   （症状是 `tsc` 报一屏语法错，见 §20.6）；本轮又出过一次双重编码。
   而"扫一遍全仓"的成本是**一秒内**，比再踩一次便宜得多。
   ============================================================ */

section('第十二节 · D8：全仓编码体检（BOM / 严格 UTF-8 / 中文没被 mojibake）')

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
}

/* ---------------- 结果 ---------------- */

console.log(`\n================ 结果 ================`)
console.log(`  断言：通过 ${passed} 条，失败 ${failures.length} 条`)
for (const f of failures) console.log(`  ❌ ${f}`)
if (failures.length) {
  console.log('\n  ⛔ 有断言没过（上面每一条都写了实测值）')
  process.exitCode = 1
} else {
  console.log('  全部通过 ✅（纯函数 A1–A7 / 静态 D1–D7 / 编码 D8）')
}
}, { script: 'nav-checks.mjs' })
