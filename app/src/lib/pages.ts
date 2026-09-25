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
 * 一条不漏：**34 条**（`App.tsx` 的 27 条真路由，含 `/login` 与 `/classroom`，
 * 不含 `path="*"` 的 404 兜底页 + 7 条 ★ 规划项）。
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
   * ⚠️ `/admin` 这一行：**它的路由今天已经在 `App.tsx` 里**（超管面板第一期），
   * 所以按"路由存不存在"这个口径它是 live 的（D1 拿它跟真路由比）。
   * 但方案 §2.2 的矩阵里**它带着 ★**（那张表把带 ★ 的行定义为"今天还没有这个路由"）——
   * 也就是方案自己的分类与实况在这一行上有偏差：**入口是新的，页面不是**。
   * 本文件按"路由存不存在"落（`live: true`），并把这个偏差写进两份文档的报告里。
   */
  { path: '/admin', group: '我的（仅 super）', entry: '/admin' },

  /* ---------------- ★ 规划中（方案里预备，今天还没有页面） ---------------- */
  { path: '/grades', group: '★ NAV（新增）', entry: '/grades', live: false },
  { path: '/grades/:id', group: '★ 页内', entry: null, live: false },
  { path: '/grades/:id/setup', group: '★ 页内', entry: null, live: false },
  { path: '/grades/:id/promote', group: '★ 页内', entry: '/grades/promote', live: false },
  { path: '/settings/terms', group: '★ 我的（新增一行）', entry: '/settings/terms', live: false },
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
 */
export const PLANNED_PAGE_COUNT = 6

/** 方案 §2.2 矩阵的规模（D2 的自证值：从文档里读回来必须逐项相等） */
export const MATRIX_SHAPE = {
  rows: 34,
  v: 145,
  e: 27,
  b: 32,
} as const
