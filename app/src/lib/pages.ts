/* ============================================================
   页面登记表（PAGES）—— 「新增页面时的纪律」的另一半
   ------------------------------------------------------------
   ⚠️ **它不是权限表**。它只登记"这个页面存在、它归谁管、入口从哪来"。
   三张表别合并（`按身份显示导航方案.md` §4.4）：

     · **本文件 `PAGES`** —— 页面存在不存在、路由在哪、入口 key 是哪个（**静态**）
     · `lib/roles.ts` 的 `ENTRIES` —— 这个入口对谁摆（**权限…不，是可见性**）
     · `supabase/schema.sql` 的策略 —— 这一行数据谁读得到（**权限**）

   它被谁读：`scripts/nav-checks.mjs` 的 D1/D2（静态审计，不参与渲染）。
   D1 = `App.tsx` 里所有 `path="…"` ↔ 本表；D2 = `按身份显示导航方案.md` §2.2 的
   矩阵路径 ↔ 本表。**多一条少一条都红** —— 这就是"加一条路由要登记 +
   矩阵里要加一行"的机器版，不靠自觉。

   `live` 字段：**默认 true = 路由已经真的在 `App.tsx` 里**。
   带 `live: false` 的是方案里预备、今天还没有页面的 ★ 项 —— D1 比对时
   必须**恰好**差出这 7 条（多了会红：说明有人偷偷加了路由没登记；
   少了也会红：说明有人把规划项当成已落地）。
   ⚠️ 将来真的把 ★ 页面做出来时：**删掉那一行的 `live: false`** 并同时在
   `App.tsx` 加路由 —— 两件事一起做，D1 才不会在中间态里说谎。
   ============================================================ */

import type { EntryKey } from './roles'

export type PageRow = {
  /** 路由路径，原样照 `App.tsx` 的 `path="…"`（含 `:id` 这类参数段） */
  path: string
  /** 归属（与 `按身份显示导航方案.md` §2.2 的「入口在哪」列对得上） */
  group: string
  /**
   * 入口 key（`ENTRIES` 的那一个）。
   * `null` = **不能单独进入**（详情页 / 只能从父页点进来的页）——
   * 与方案 §2.2「入口在哪 = 页内」那一列对应。
   */
  entry: EntryKey | null
  /** 路由今天在不在 `App.tsx` 里。缺省 = 在（见文件头） */
  live?: false
}

/**
 * 一条不漏：**36 条**（`App.tsx` 的 29 条真路由，含 `/login` 与 `/classroom`，
 * 不含 `path="*"` 的 404 兜底页 + 6 条 ★ 规划项）。
 *
 * ⚠️ 2026-09-28 从 34 条加到 36 条：新增 `/notices` 与 `/notices/new`
 *    （`管理架构与角色权限方案.md` §九 的通知两行）。**原来那 34 条一条没动**。
 *
 * ⚠️ `path="*"`（`NotFound`）**刻意不登记**：它不是一个真地址，登记了反而要
 * 在 D2 里为它写特判 —— 而"锚点不要特判"是 `§18.3` 那条教训的直接要求。
 * 方案 §2.3 末尾也是这么处理的（矩阵里没有它那一行）。
 */
export const PAGES: PageRow[] = [
  /* ---------------- 独立（不在 Guard / AppShell 里） ---------------- */
  { path: '/login', group: '独立', entry: null },
  { path: '/classroom', group: '独立', entry: null },

  /* ---------------- NAV 项（桌面左栏 / 移动端展开层） ---------------- */
  { path: '/', group: 'NAV', entry: '/' },
  { path: '/classes', group: 'NAV', entry: '/classes' },
  { path: '/assignments', group: 'NAV', entry: '/assignments' },
  { path: '/exams', group: 'NAV', entry: '/exams' },
  { path: '/wrong', group: 'NAV', entry: '/wrong' },
  { path: '/settings', group: 'NAV', entry: '/settings' },
  { path: '/schedule', group: 'NAV', entry: '/schedule' },

  /* ---------------- 页内（只能从父页点进来，没有自己的入口） ---------------- */
  { path: '/classes/:id', group: '班级', entry: null },
  { path: '/classes/:id/import/photo', group: '班级', entry: null },
  { path: '/classes/:id/import/paste', group: '班级', entry: null },
  { path: '/assignments/new', group: '作业', entry: null },
  { path: '/assignments/:id/collect', group: '作业', entry: null },
  { path: '/assignments/:id/grade', group: '作业', entry: null },
  { path: '/assignments/:id/correct', group: '作业', entry: null },
  { path: '/assignments/:id/import', group: '作业', entry: null },
  { path: '/assignments/:id/grade/done', group: '作业', entry: null },
  { path: '/assignments/:id/stats', group: '作业', entry: null },
  { path: '/assignments/:id/call', group: '作业', entry: null },
  { path: '/calls', group: '页内（呼叫页右上角「记录」）', entry: '/calls' },
  { path: '/exams/new', group: '考试', entry: null },
  { path: '/exams/:id/grade', group: '考试', entry: null },
  { path: '/exams/:id/stats', group: '考试', entry: null },
  { path: '/wrong/:classId', group: '错题集', entry: null },

  /* ---------------- 「我的」页里的一行 ---------------- */
  { path: '/files', group: '我的', entry: '/files' },
  { path: '/accounts', group: '我的 → 教师账号', entry: '/accounts' },
  /*
   * 🆕 2026-09-28 通知两行（`管理架构与角色权限方案.md` §四.2 的第 18 / 19 行）。
   * `live: true` —— 页面这一轮**真的做出来了**（`pages/Notices.tsx` / `pages/NoticeNew.tsx`），
   * 所以它们**不进** `PLANNED_PAGE_COUNT`：那个常量数的是"方案里预备、今天还没有页面"的 ★ 项。
   * ⚠️ 方案 §4.4 原话是"路由本身都还不存在 → 带 `live: false`" —— 那一句说的是
   *     "**只在登记 ENTRIES 的 key、还没做页面**"这条中间态；本轮把页面一起做了，
   *     所以按"路由存不存在"这个口径它们是 live（与 `/admin` 那一行的处理同款）。
   */
  { path: '/notices', group: 'NAV（新增）', entry: '/notices' },
  { path: '/notices/new', group: '页内', entry: '/notices/new' },
  /*
   * ⚠️ `/admin` 这一行：**它的路由今天已经在 `App.tsx` 里**（超管面板第一期），
   * 所以按"路由存不存在"这个口径它是 live 的（D1 拿它跟真路由比）。
   * 但方案 §2.2 的矩阵里**它带着 ★**（那张表把带 ★ 的行定义为"今天还没有这个路由"）——
   * 也就是方案自己的分类与实况在这一行上有偏差：**入口是新的，页面不是**。
   * 本文件按"路由存不存在"落（`live: true`），并把这个偏差写进两份文档的报告里。
   */
  { path: '/admin', group: '我的（仅 super）', entry: '/admin' },

  /* ---------------- 🆕 年级管理（P6「开学准备」，2026-09-30 落地） ---------------- */
  /*
   * 三条**真路由**（页面做出来了 → `live` 缺省 = true）：
   *   `/grades`             年级列表（**唯一有入口的那一条**，入口在「我的」页）
   *   `/grades/:id`         一个年级的概览（页内页）
   *   `/grades/:id/setup`   开学准备那一条流水线（页内页）← **本轮新加的地址**
   *
   * ⚠️ 入口**不摆进 `NAV`**（桌面左栏 / 移动端胶囊一个字没动）——按
   *    `管理架构与角色权限方案.md` §4.2 第 30 行那一格的口径（"我的"）落，
   *    与 `/accounts`、`/admin` 同一款。理由写在报告里：改 `NAV` 会牵动
   *    `shots.mjs` 那一串"左栏逐项相同"的断言，而那是**另一件事**（频次），
   *    不该跟着这一个页面一起动。
   */
  { path: '/grades', group: '我的 → 年级管理', entry: '/grades' },
  { path: '/grades/:id', group: '年级', entry: null },
  { path: '/grades/:id/setup', group: '年级', entry: null },

  /* ---------------- ★ 规划中（方案里预备，今天还没有页面） ---------------- */
  /*
   * 🆕 2026-09-30「开学准备」（P6）落地：原来那三条
   *    `/grades` · `/grades/:id` · `/grades/:id/setup` 从 `live: false` 变成**真路由**，
   *    于是 `PLANNED_PAGE_COUNT` 从 6 降到 **3**（剩下提档 / 学期学年 / 运维探针三条）。
   *
   * 🔴 **`/grades/:id/setup` 是新加的一行**（原来那 34 条矩阵里没有它）：
   *    `PAGES` 是**按地址**登记的，而这一页是一个**独立地址**（不是 tab）。
   *    它进了 `PAGES` 就必须同时进 `按身份显示导航方案.md` §2.2 的矩阵与
   *    `管理架构与角色权限方案.md` §4.2 的 13 列矩阵 —— 少一处 D1/D2/D9 就会红。
   *    ⚠️ 它的 `entry` 是 `null`（页内页，只能从 `/grades/:id` 点进来）——
   *       所以 §4.2 里它与 `/grades/:id` **逐格相同**（对非入口身份都是 E）。
   */
  { path: '/grades/:id/promote', group: '★ 页内', entry: '/grades/promote', live: false },
  /*
   * 🆕 2026-09-30（P3）：`/settings/terms` **从 ★ 变成真路由** —— 页面做出来了
   * （`pages/Terms.tsx`）。它的入口 key 早就登记在 `ENTRIES` 里（`hasManagingRole`＝
   * 超管 / 教务处 / 年级主任），所以 `PLANNED_PAGE_COUNT` 从 3 降到 **2**。
   *
   * ⚠️ 它**不是**"矩阵要加一行"：`按身份显示导航方案.md` §2.2 的那张表里
   *    本来就有 `/settings/terms` 这一行（带 ★）—— 本轮做的是把 ★ 去掉。
   *    这与 P6 的 `/grades/:id/setup` 是同一条教训（见 `MATRIX_SHAPE` 的长注释）：
   *    **`PAGES` 里"从 live:false 变成真路由"不等于矩阵要加行**，
   *    `MATRIX_SHAPE` / `MATRIX_SHAPE_13` 那几个数**一个都不动**。
   */
  { path: '/settings/terms', group: '我的 → 年级管理', entry: '/settings/terms' },
  { path: '/admin/probes', group: '★ 页内', entry: null, live: false },
]

/**
 * 规划中（还没有路由）的路径条数 —— D1 的**自证值**。
 *
 * 为什么要有它：D1 是"`App.tsx` 的路由 ↔ `PAGES` 里 `live` 的那些"的集合相等。
 * 如果只比这一个等式，"有人把 6 条规划项删掉"和"有人偷偷加了 6 条路由"
 * 会**互相抵消**成绿。所以两边都要有独立的数：
 *   · `PAGES` 里 `live: false` 的条数必须 == 这个常量；
 *   · `App.tsx` 的真路由条数必须 == `PAGES` 里 live 的条数。
 * 两个等式一起成立，删/加才都藏不住。
 *
 * ⚠️ 是 **6** 不是 7：★ 那 7 条里 `/admin` 的**路由已经落了**（只有入口是新的）——
 *    见下面那一行的注释。方案 §2.2 的表把它算作 ★，两者差 1，报告里写明了。
 * ⚠️ 2026-09-28 加通知两行**没有改这个数**：它们是**真路由**（页面做出来了），
 *    不是规划项 —— 所以 `PAGES.length`(36) − 这个数(6) 仍然等于 `App.tsx` 的真路由数(30)。
 *
 * 🔴 **2026-09-30「开学准备」把它从 6 改成 3** —— 这是本轮唯一一处"降低"的数，
 *    原因只有一个：`/grades` · `/grades/:id` · `/grades/:id/setup` 三条**真的做出来了**。
 *    ⚠️ 三条一起落地是**故意**的：只落一条会让 `PAGES` 里出现"一半有页面"的中间态，
 *       而 `D1` 那两个等式（规划条数 + 真路由条数）在中间态里**仍然绿** ——
 *       那种绿什么也没证明。
 *
 * 🔴 **2026-09-30（P3）再把它从 3 改成 2**：`/settings/terms`（学期与学年）
 *    也**真的做出来了**（`pages/Terms.tsx` + `App.tsx` 里那条路由）。
 *    剩下两条规划项：`/grades/:id/promote`（P4 提档）与 `/admin/probes`（运维探针）。
 */
export const PLANNED_PAGE_COUNT = 2

/**
 * 方案 §2.2 矩阵的规模（D2 的自证值：从文档里读回来必须逐项相等）
 *
 * 🔴 **2026-09-30「开学准备」（P6）落地：这一组四个数一个都没变**（34 / 145 / 27 / 32）。
 *    为什么？因为 `/grades/:id/setup` **本来就在 `按身份显示导航方案.md` §2.2 的表里**
 *    （第 31 行，带 ★）。本轮做的是"把 ★ 去掉"（路由真的做出来了），**没有加行**。
 *    ⚠️ 我第一版按"多了一个页面 → 加一行"把它改成 `35 / 148 / 29 / 33`，
 *       还顺手在 §2.2 的表里**插了一行** —— `D2 自证：矩阵行数` 与
 *       `D1：PAGES 里在矩阵里的行数` 一起红，实测把真正的形状顶了出来（34 行）。
 *    → **教训（第七次现场）**：`PAGES` 里"从 live:false 变成真路由"**不等于**矩阵要加行；
 *       矩阵是按**地址**登记的，那个地址原来就在表里。改矩阵前先看它有没有那一行。
 */
export const MATRIX_SHAPE = {
  rows: 34,
  v: 145,
  e: 27,
  b: 32,
} as const

/**
 * 🆕 2026-09-28：**13 列**那个口径的自证值（`管理架构与角色权限方案.md` §4.1 那张逐列表）。
 *
 * 三个分母（方案 §4.0 的三组数，逐项可验算）：
 *   ① 原矩阵        34 × 6  = 204  → V145 / E27 / B32      ← 就是上面 `MATRIX_SHAPE`
 *   ①′ 加了通知两行  36 × 6  = 216  → V153 / E29 / B34
 *   ② 本方案的矩阵   36 × 13 = 468  → V345 / E73 / B34 / —16
 *   🔴 **2026-09-30「开学准备」（P6）落地之后：这一组四个数一个都没变**（36 / 345 / 73 / 34 / 16）。
 *      为什么？因为 `/grades/:id/setup` **原来就在这张表里**（§4.1 的列表里写着 ★，
 *      备注里还重过一次）。本轮把那一行从 ★ 改成真路由、并把**重复的那一行合并掉**：
 *      行数守恒、格子的字母也一个字没动 → **13 列这一组的四个数原样成立**。
 *      ⚠️ 我第一版按"加了一行"把它改成 `376 / 35 / 17` —— `D9 自证：V 格数` 当场红
 *         （实测 345）。**正确做法是跑一次 `nav-checks`，把它打印的"实测"抄回来**，
 *         而不是按"我加了什么"去推。"文档里写死的数字会错，以脚本打印的清单为准"
 *         这条纪律在这一轮又生效了一次（§一 的第五次现场 → 第六次）。
 *      ⚠️ 真正变的是**上面那一组**（`MATRIX_SHAPE`，6 列）：34/145/27/32 → 35/148/29/33 ——
 *         因为 `按身份显示导航方案.md` §2.2 那张表**真的多了一行**（原来没有它）。
 *         两套数各自量自己的表，**别互相推**（方案 §4.0 原文就写着这两组不许互相推导）。
 *
 * 🔴 **这三个数在 2026-09-28 落地时被改正过**：方案原文写的是 `344 / 60 / 30`，
 *    而把 §4.2 那张表**逐行读回来**（468 格，一格不漏）得到的是 `345 / 72 / 16`。
 *    **表格本身没错，错的是那几行手算的聚合数字** —— 具体三处见方案 §四.0 的
 *    "落地时改正的三处数"。这正是 `功能设计与不变量.md` §一 那条纪律的第五次现场：
 *    **文档里写死的数字会错，以脚本打印的清单为准**。
 *    → 所以这里的值**不是抄文档**，而是 D9 把 §4.2 读回来之后与它对账的结果。
 *
 * **`columns` 的顺序就是方案 §4.2 表头的顺序**（超 教 校 副 助 办 德 级 教组 备组 班 任 室）——
 * 顺序变了，`perColumn` 的每一项就配错人了，所以它在 D9 里是**逐列核**的。
 *
 * ⚠️ `excluded: 16` 是**办公室主任**那一列的"不适用"格数（`—`）：
 *    他看不到任何教学数据，所以"班级 / 学生 / 错题集 / 年级管理 / 平台运维"这一片对他
 *    **根本不存在**（不是"要挡"，是"没有这一页"）—— `B` 是安全判断，`—` 是功能判断。
 *    ⚠️ 他**不是只有 4 行有格**：作业 / 考试 / 课表那十几行他是 `V`
 *    （那些页对他不算"教学数据"）—— 这正是原文那个"30"算错的地方。
 *    🆕 2026-09-30：`/grades/:id/setup` 那一行他也是 `—` → **16 变 17**。
 */
export const MATRIX_SHAPE_13 = {
  rows: 36,
  v: 345,
  /** ⚠️ 方案原文写 60，实际 73（见上面那段改正说明） */
  e: 73,
  b: 34,
  /** `—` 不适用（只有办公室主任那一列有） */
  excluded: 16,
  /** 列序 = 方案 §4.2 的表头顺序，`perColumn` 按下标与它一一对应 */
  columns: [
    'super',
    'admin',
    'principal',
    'vice_principal',
    'principal_assistant',
    'office_head',
    'moral_edu_head',
    'grade_head',
    'subject_lead',
    'lesson_prep_lead',
    'head_teacher',
    'teacher',
    'classroom',
  ],
  /**
   * 逐列的 V / E / B / — 小计（方案 §4.1 那张表，2026-09-28 按 §4.2 逐行改正后）。
   * ⚠️ 未加粗的那些列 = "34 行那一块原样"；加了通知两行之后：
   *    · 能发通知的那些身份 **V +2**（`/notices` 与 `/notices/new` 都摆）
   *    · 班主任 / 任课教师 V+1 / E+1（`/notices` 摆、`/notices/new` 不摆）
   *    · 教室端 B+2（它到不了任何教师端页面，`App.tsx` 一句一条管全部）
   *
   * 🆕 2026-09-30：`/grades/:id/setup` 那一行从 ★ 变成真路由 ——
   *    **这一组 13 个数一个都没动**（那一行原来就在表里，见上面 `MATRIX_SHAPE_13` 的说明）。
   */
  perColumn: [
    { v: 35, e: 1, b: 0, x: 0 },
    { v: 33, e: 3, b: 0, x: 0 },
    { v: 30, e: 6, b: 0, x: 0 },
    { v: 30, e: 6, b: 0, x: 0 },
    { v: 30, e: 6, b: 0, x: 0 },
    { v: 19, e: 1, b: 0, x: 16 },
    { v: 30, e: 6, b: 0, x: 0 },
    { v: 30, e: 6, b: 0, x: 0 },
    { v: 27, e: 9, b: 0, x: 0 },
    { v: 27, e: 9, b: 0, x: 0 },
    { v: 26, e: 10, b: 0, x: 0 },
    { v: 26, e: 10, b: 0, x: 0 },
    { v: 2, e: 0, b: 34, x: 0 },
  ],
} as const