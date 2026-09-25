/* ============================================================
   身份（角色）—— 前端**只负责显示**，判据一律在数据库
   ------------------------------------------------------------
   用户口径（2026-09-26 定、2026-09-27 修）：**最高管理员与教导处是两种身份，
   判据要分开写**；但"指派身份"这件事两者都能做（原话：
   「班主任，年级主任的身份也要由行政管理（教导处）给」）。
   落到代码里是三处，缺一不可：

     ① `supabase/schema.sql` §13.2 的三个函数 —— **唯一判据**
        `is_super_admin()`      只有最高管理员（本段之后暂时没有调用方，留着交接超管用）
        `can_manage_teachers()` 最高管理员 + 教导处：建号 / 任课关系 / 重置密码 / **指派身份**
        `is_school_admin()`     （§16.2）两者一起：建班 / 加删学生 / 改成绩兜底
     ② `app/functions/api/teacher-account.ts` —— 用 service_role 建号/指派前，
        拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 问数据库，
        **不在 TypeScript 里重写一遍规则**
     ③ 这里 —— 只回答"界面上该不该摆这个入口"**和"标签上写什么字"**
        （`roleChips()` / `currentIdentityLabel()`，见文件末尾）

   🔴 为什么③不算"第二套判据"：它对数据的可见范围**一无所知**，
      也不可能让谁多看到一行 —— 真正的闸门是①，服务端每次都问。
      `功能设计与不变量.md` §11.3 那条纪律（前端不另写权限过滤）说的是**数据行**，
      而"显示哪些入口"按设计就是前端的事（`多学科体系方案.md` §3.3.4）。
   ============================================================ */

import type { CSSProperties } from 'react'
import type { RoleCode, Teacher, TeacherRole } from '../data/types'
import { teacherSubjectLabel } from './subjects'

/** 身份的显示名。加一档身份 = 这里加一行 + schema 的 check 约束加一个值。
 *
 *  🔴 2026-09-28「管理架构与角色权限」这一轮：**14 档身份**（`管理架构与角色权限方案.md` §一）。
 *  三条要读懂的：
 *   · `admin` 的显示名从「教导处」改成「**教务处**」（用户这次的架构里叫教务处）。
 *     **代号一个字节都没改**（改代码是破坏性迁移），库里 `admin` 有 0 行 → 纯文案、零数据迁移。
 *   · 校级三档（校长 / 副校长 / 校长助理）**在数据库里逐格相同**（方案 §三.2）：
 *     三个显示名、一条判据。要分开就得先有"分管范围"这个字段 —— 今天没有。
 *   · 组长两档（教研组长 / 备课组长）**权限逐格相同、只是职责/头衔不同**（用户拍板）：
 *     建两档是为了标签写对，不是为了权限不同。
 */
export const ROLE_NAME: Record<RoleCode, string> = {
  super: '最高管理员',
  admin: '教务处',
  principal: '校长',
  vice_principal: '副校长',
  principal_assistant: '校长助理',
  office_head: '办公室主任',
  moral_edu_head: '德育处主任',
  grade_head: '年级主任',
  head_teacher: '班主任',
  subject_lead: '教研组长',
  lesson_prep_lead: '备课组长',
  teacher: '任课教师',
}

/** 库里出现认不出的角色代码时，原样显示（**不猜**，也不吞掉） */
export function roleName(role?: string | null): string {
  const s = String(role ?? '').trim()
  if (!s) return ''
  return ROLE_NAME[s as RoleCode] ?? s
}

/**
 * 我是不是最高管理员（界面用；闸门见文件头①）。
 *
 * 它仍然是一个**独立的判据**（`schema.sql` §16.8：留给交接超管身份这类只有超管能做的事，
 * 以及 §20 的超管运维面板 `/admin`）—— 别拿 `canManageTeachers()` 去替代它，
 * 那正是把两种身份混成一种。
 */
export function isSuperAdmin(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super')
}

/**
 * 我能不能**建教师账号 / 维护任课关系 / 重置密码**（界面用；闸门见文件头①）。
 *
 * 🔴 2026-09-28 拆函数（方案 §三.4 的 N-1）：服务端那一侧现在是**两个**判据
 *    （`can_create_teacher_accounts()` / `can_assign_roles()`），前端这两个函数与它们
 *    **一一对应**，别合并：
 *      · 建号 → 最高管理员 + 教务处 + 🆕**办公室主任**
 *      · 指派身份 → 最高管理员 + 教务处（**不含办公室主任**）
 *    合并的那一刻，办公室主任就能在界面上看到"加一个身份"的按钮 ——
 *    而服务端会 403（按钮点了被拒，正是"编出来的按钮"）。
 *
 * ⚠️ 它含 `office_head` 是**刻意的**，且**不改那 6 列在原来那 34 行上的任何一格**：
 *    那 6 列里没有 `office_head`，所以对它求值只会是 false（见方案 §4.5 的 `/accounts` 那一行）。
 */
export function canManageTeachers(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some(
    (r) => r.role === 'super' || r.role === 'admin' || r.role === 'office_head',
  )
}

/**
 * 我能不能**指派身份**（班主任 / 年级主任 / 组长 / 校级三档 …）。
 *
 * 用户 2026-09-27 口径：**教务处 + 最高管理员**都能指派 ——
 * 原话是「班主任，年级主任的身份也要由行政管理（教务处）给」。
 *
 * 🔴 它**比 `canManageTeachers()` 窄**（少一档办公室主任），这就是拆函数的意义：
 *    **建号 ≠ 指派身份**。两者今天**不再同集合** —— 这正是"拆开"的验收点
 *    （`nav-checks.mjs` 有一条专门的断言钉它）。
 */
export function canAssignRoles(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super' || r.role === 'admin')
}

/**
 * 我是不是**校级领导**（校长 / 副校长 / 校长助理）。
 *
 * 三档**在数据库里逐格相同**（全校只读 + 发全校通知）—— 方案 §三.2 明说了这个取舍：
 * 平台里没有"分管哪条线"这个数据结构，所以也判不了。
 * ⚠️ 它只回答"摆不摆入口"（M1/M2），**不回答"能看几个班"** —— 那是 RLS 的事。
 */
export function isSchoolLeader(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some(
    (r) =>
      r.role === 'principal' || r.role === 'vice_principal' || r.role === 'principal_assistant',
  )
}

/**
 * 我**看不看得见教学数据**（班级 / 名单 / 作业 / 成绩 / 错题 / 考试）。
 *
 * = 超管 · 教务处 · 校级三档 · 德育处主任。
 * 🔴 **德育处是"只读"**：看得见、一处也改不了（写的那几个判据里没有它）。
 * 🔴 **办公室主任不在这里** —— 他今天只做两件事：**建号 + 发全校通知**，
 *    看不到任何教学数据（方案 §一.2 第 6 行）。
 */
export function seesTeachingData(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => SEES_TEACHING_DATA.has(r.role))
}

/** `seesTeachingData()` 的那一组（写成常量是为了让类型检查器帮我们盯住拼错的角色代码） */
const SEES_TEACHING_DATA: ReadonlySet<RoleCode> = new Set<RoleCode>([
  'super',
  'admin',
  'moral_edu_head',
  'principal',
  'vice_principal',
  'principal_assistant',
])

/**
 * 我能不能**发通知**（能打开"发通知"这个动作）。
 *
 * 🔴 八档：超管 · 教务处 · 校级三档 · 办公室主任 · 德育处主任 · 年级主任 · 两个组长。
 * **班主任与任课教师不发**：他们的"班级事务"走**呼叫**（给学生的大屏），不是通知 ——
 * 通知的真实语义是"**学校对老师说话**"（方案 §0.1）。
 * ⚠️ "能发"与"**能发给谁**"是**两件事**：年级主任与组长只能发给自己那个范围
 *    （本年级 / 本学科），而这一条**只在服务端/数据库判**（I46）——
 *    前端看不见那个范围，也不可能靠这里绕过去。
 */
export function canPublishNotice(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) =>
    [
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
    ].includes(r.role),
  )
}

/**
 * 身份标签（「班主任 · 高二(4)班」这种）。
 *
 * `className` 用来把 `scope_id` 翻译成班名 —— 只有**看得见的班**能翻译出来
 * （`store.classes` 是数据库 RLS 筛过的结果），翻不出来就只显示身份名，
 * 不编一个名字出来。
 */
export function roleChips(
  roles?: readonly TeacherRole[] | null,
  className?: (id: string) => string | undefined,
): string[] {
  const out: string[] = []
  for (const r of roles ?? []) {
    const base = roleName(r.role)
    if (!base) continue
    if (r.scopeType === 'class' && r.scopeId) {
      const name = className?.(r.scopeId)
      out.push(name ? `${base} · ${name}` : base)
      continue
    }
    // 年级名不在这里编：前端没读 grades 表，只有 id 没有名字 —— 宁可只写身份名
    out.push(base)
  }
  return out
}

/* ============================================================
   身份标签显示什么（**只是显示，不是判据**）
   ------------------------------------------------------------
   2026-09-25：用户截图里最高管理员的侧栏标签写着「物理」。
   根因不是标签取错了字段，而是 `teachers.subject` **有列默认值 `'物理'`**
   （列默认值不改，那是破坏性迁移，见 §12.5）—— 于是**每个账号都有学科**，
   连不教课的账号也被挂上"物理"。学科回答的是"教什么"，身份回答的是"是谁"，
   有身份的人应当先答"是谁"。
   ============================================================ */

/**
 * 管理身份的显示优先级（**高 → 低**）。
 *
 * `teacher`（任课教师）**不在表里**：它是"没有管理身份"的那一档，
 * 只有它的老师照旧显示学科。
 *
 * 🆕 2026-09-28：14 档身份里除 `teacher` 之外全在表里 —— 包括**组长两档**。
 * 理由（方案 §5.6 的建议，本轮采纳）：**组长是身份，不是学科** ——
 * 「教研组长」比「物理」更能回答"这个人是谁"。
 * ⚠️ 布局约束随之而来（`功能设计与不变量.md` §13.10）：标签宽 194px，
 *    多一档会折行 —— 折行是**允许**的（容器 `flex-wrap` + 分隔符处断行），
 *    但"一个人挂了 5 档身份"那种账号会占三行。这是显示取舍，不影响任何判据。
 *
 * ⚠️ 这张表只决定**标签上按什么顺序写**，与权限无关 ——
 *    "谁能建号 / 谁能指派身份 / 谁改得了成绩"一律以数据库为准（§13.5 I16、§16）。
 *    别拿它去写任何 if 判断（那正是 I17 说的"第二处判据"）。
 */
const MANAGING_ROLES: readonly RoleCode[] = [
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
]

/**
 * 多个身份之间的分隔符：` · `（与 `roleChips()` 里「班主任 · 高二(4)班」同一个符号）。
 *
 * 刻意用「空格 · 空格」而不是逗号/顿号：**空格是断行机会**，
 * 侧栏那种窄容器里（内容宽 194px）标签需要能在两个身份之间折行 ——
 * 配上 `word-break: keep-all` 就只会在分隔符处断，不会把「最高管理员」拆成"最高管理 / 员"。
 */
const ROLE_SEP = ' · '

/**
 * 这个人的**管理身份**显示名；没有管理身份返回 `''`。
 *
 * 🔴 **多身份全部露出来**（用户 2026-09-27 拍板），例如「教导处 · 年级主任」。
 *    上一轮曾经只显示最高一档（`super` > `admin` > `grade_head` > `head_teacher`），
 *    理由是"标签在侧栏里挨着姓名，拼成长串会撑破" —— 用户否掉了那个取舍：
 *    一个人同时是年级主任和班主任，只写「年级主任」等于把另一重身份藏起来。
 *    由此带来的**布局约束**写在 `功能设计与不变量.md` §13.10：
 *    调用点的容器必须允许折行（侧栏那行是 `flex-wrap` + 标签自己 `keep-all` 折在分隔符处）。
 *
 * 顺序 = `MANAGING_ROLES` 的优先级（与数组先后无关），所以
 * `[head_teacher, super]` 与 `[super, head_teacher]` 都写「最高管理员 · 班主任」。
 *
 * 同名身份**只写一次**：`teacher_roles` 允许同一个人有多行同一档身份
 * （班主任带两个班就是两行 `head_teacher`），而这一行标签不带班名 ——
 * 不去重就会出现「班主任 · 班主任」。带班名的完整清单在 `roleChips()`。
 *
 * ⚠️ **认不出的角色代码按身份显示**（`roleName()` 原样回显，排在最后 ——
 *    它们在优先级表里没有位置，只能按数组先后）：把一个身份显示成学科正是
 *    2026-09-25 那一轮要修的那个错，宁可显示一个生代码，也不要谎报"物理"。
 *    `teacher` 那一档不算管理身份。
 */
export function managingRoleLabel(roles?: readonly TeacherRole[] | null): string {
  const list = roles ?? []
  const names: string[] = []
  const seen = new Set<string>()
  const push = (name: string) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  // ① 认得出的管理身份：按优先级表排（顺序不取决于 `roles` 数组的先后）
  for (const code of MANAGING_ROLES) {
    if (list.some((r) => r.role === code)) push(roleName(code))
  }
  // ② 认不出的角色代码：原样回显，排在最后（表里没有它们的位置）
  for (const r of list) {
    if (r.role === 'teacher' || MANAGING_ROLES.includes(r.role)) continue
    push(roleName(r.role))
  }
  return names.join(ROLE_SEP)
}

/**
 * 🔴 **「当前身份」那个标签显示什么：有管理身份就显示身份，没有才显示学科。**
 *
 * 三处「我自己」的标签共用这一处实现（侧栏 `AppShell` / 工作台问候语 / 设置页身份卡）——
 * 别再各写一句 `managingRoleLabel(myRoles) || teacherSubjectLabel(teacher)`：
 * 「同一件事只能有一个判定入口」是本仓库踩过四次的坑（§十）。
 *
 * ⚠️ **`roles` 只覆盖"我自己"**：`store.myRoles` 来自 `remote.loadMyRoles(我的 uid)`，
 *    前端**拿不到别人的角色数组**。要显示**别人**（账号表、班级名单那种一行一个人）时
 *    别调它 —— 传进去的空数组会让那个人显示成学科，等于把"没有身份"这个结论安在别人头上
 *    （那正是这一轮修的错，只是换了个方向）。`TeacherAccounts` 那几列显示学科是**对的**：
 *    那一列本来就是"这个账号教什么科"。
 */
export function currentIdentityLabel(
  roles?: readonly TeacherRole[] | null,
  t?: Pick<Teacher, 'subject' | 'primarySubjectCode'> | null,
  fallback = '老师',
): string {
  return managingRoleLabel(roles) || teacherSubjectLabel(t, fallback)
}

/**
 * 「当前身份」标签的**排版约束**——三个显示点共用这一处，别再各写一份内联样式
 * （同 `currentIdentityLabel()` 的理由：同一件事只有一个定义）。
 *
 * 为什么需要它（2026-09-27 改成"多身份全露"之后**实测**出来的，不是设想的）：
 *
 * | 位置 | 可用宽度 | 1 个身份 | 2 个 | 3 个 | 4 个 |
 * | --- | --- | --- | --- | --- | --- |
 * | 侧栏那一行（266 − 14 留白 − 2 边框 − 32 `p-4` − 24 `rail-block` 内边距） | **194px** | 72 | 104 | 158 | **212** |
 * | 设置页身份卡那一行（414px 手机上） | 约 **216px** | 72 | 104 | 158 | **212** |
 *
 * 实测到的两个坏样子（修之前，截图在报告里）：
 *   ① 名字被挤成竖排 —— 姓名 `span` 和标签在同一行、标签 `nowrap` 又有 `min-width: auto`，
 *      于是**能屈能伸的只有姓名**：「王老师」被压成三行（王 / 老 / 师）；
 *   ② 标签自己捅出侧栏（4 个身份时溢出 **41px**，被面板边裁掉）。
 *
 * 所以：容器那一行必须 `flex-wrap`（见三个显示点），**标签自己**也要能在
 * 两个身份之间折行（`whiteSpace: normal` + `wordBreak: keep-all` 只断在分隔符的空格处，
 * 不会把「最高管理员」拆成"最高管理 / 员"）；`height: auto` + `minHeight: 21`
 * 保证只有一个身份时**仍然是原来那 21px 的一行**（上下内边距留 0：`.tag` 自己有
 * `height: 21px` + 1px 边框 + `box-sizing: border-box`，多给内边距会把它撑到 23px ——
 * 实测过，"顺手加 2px"就是会让所有单身份账号的标签悄悄变高）。
 *
 * ⚠️ 别把 `.tag` 这个类改掉：它是全站共用的（`index.css`），这里只覆盖这一个标签。
 */
export const IDENTITY_TAG_STYLE: CSSProperties = {
  maxWidth: '100%',
  whiteSpace: 'normal',
  wordBreak: 'keep-all',
  height: 'auto',
  minHeight: 21,
  lineHeight: 1.6,
  textAlign: 'left',
}

/* ============================================================
   🔴 入口表（ENTRIES）—— 「按身份显示导航」的**唯一实现**
   ------------------------------------------------------------
   来源：`按身份显示导航方案.md` §四。矩阵（页面 × 角色，34 行 × 6 列）在
   那份文档的 §2.2，每一格是 V（看得见入口）/ E（藏入口就够）/ B（要挡）。

   ⚠️ **这张表只决定"摆不摆入口"，它不回答"能不能读"，也不回答"能不能做"**：

     入口藏不藏  →  `entryVisible(key, myRoles)`   ← 前端（本文件），改错了最多是少点几下
     能不能读    →  RLS 策略（`visible_class_ids()` …）← 数据库，前端一个字都插不上手
     能不能做    →  `/api/*` 拿调用者 JWT 去问 RPC  ← 服务端，前端藏了按钮也拦不住

   **藏入口 ≠ 访问不到**：手打 URL 照样进得去页面，然后被 RLS 筛成空数据。
   所以「藏入口」只在两种情况下成立：① 那页对这个身份本来就该显示空（或全是自己的）；
   ② 页面自己还有一道挡（`Guard` 或页面内判据，例如 `App.tsx` 的 `accountKind`）。
   **它不是安全边界**，真正的边界永远在数据库（§零 与 `§13.5 I16` / `§16.6 I29`）。

   三条写法纪律（`scripts/nav-checks.mjs` 的 D3 逐条机器检查，别绕）：
     M1  `visibleFor` **只回答"摆不摆"，返回值只能是 `boolean`** ——
         不许返回 `EntryKey[]`、不许返回"可见的班级名单"。一旦它开始返回数据，
         就会有人拿它去 `filter()` 数据行。
     M2  `visibleFor` **只准读 `roles` 一个参数** —— 不许 `useStore`、不许读
         `classes` / `assignments` / `students`、不许 `await` 任何请求。
         "看得见几个班"是 RLS 的事，读它来算入口 = 前端开始做权限判断。
     M3  **数据行一律不过这张表** —— 页面里不许出现 `classes.filter(…role…)`。
         `classes` 是 RLS 筛过的结果，再筛一次就是 §11.3 明令禁止的那件事。
   ============================================================ */

/**
 * 今天的入口清单（`key` 与 `PAGES` 登记表、与方案 §2.2 矩阵**逐行对应**）。
 *
 * ⚠️ 这一组 key 里有 4 个是**方案里预备、今天还没有页面**的
 * （`/grades`、`/grades/promote`、`/settings/terms`、`/admin`）；
 * `/admin` 的路由其实**已经在了**（超管面板第一期），只是入口在 `Settings.tsx` 里。
 * 它们现在登记在这里是为了"加页面时不用回头看方案"，
 * `nav-checks.mjs` 的 D1 用 `PAGES` 的 `live` 字段把"已落地 / 规划中"分开核对。
 */
export type EntryKey =
  | '/'
  | '/classes'
  | '/assignments'
  | '/exams'
  | '/wrong'
  | '/schedule'
  | '/settings'
  | '/files'
  | '/calls'
  | '/accounts'
  | '/grades'
  | '/grades/promote'
  | '/settings/terms'
  | '/admin'
  /* 🆕 2026-09-28 通知两行（`管理架构与角色权限方案.md` §四.2 的第 18 / 19 行）。
     它们是**新加的两行**，不是"改了某一行" —— 所以原来那 14 个 key 的值一个都没变。
     ⚠️ 组长两档因此在入口层**比任课教师多一个入口**（`/notices/new`）：
     这是那 34 行之外的新事实，矩阵里体现为 `27/9/0` vs `26/10/0`。 */
  | '/notices'
  | '/notices/new'

type EntryRule = {
  /** 显示名（登记表要能被人读 —— 这是"矩阵能不能对上"的一半） */
  label: string
  /**
   * 判据：**只准调本文件里已有的 `xxx()`，或最朴素的 role 命中**（M1/M2）。
   * ⛔ 不许读 store、不许读 classes/assignments、不许返回"过滤后的数据"。
   */
  visibleFor: (roles?: readonly TeacherRole[] | null) => boolean
}

/**
 * 我有没有**年级管理这一层的身份**（最高管理员 / 教务处 / 年级主任）。
 *
 * 🔴 它**故意不含 `head_teacher`（班主任）** —— 这是本轮**一处刻意的取舍**，写清楚：
 *
 *   · 名字上像"有管理身份的人"，而 `MANAGING_ROLES`（上面那张**标签优先级**表）
 *     确实含班主任 —— 但那个数组决定的是"标签上按什么顺序写字"，
 *     `I17` 明令**不许拿它写 if**，所以这里另立一个函数、**另定一组角色**；
 *   · 班主任**不进**年级管理：方案 §2.3 第 29–31 行原文（引自 `年级管理与选科走班方案.md`
 *     §4.1 的导航可见性表）是"super / admin 全部；年级主任只有自己那个年级；
 *     **班主任与任课老师不进**"；矩阵里那三行的班主任格就是 **E**；
 *   · 矩阵本身也是这么算的：`head_teacher` 与 `teacher` 两列的 V/E/B 小计**必须一样**
 *     （25/9/0，方案 §2.2 那张"规模感"表），而"班主任多 4 格 V"会让它变成 29 ——
 *     总分也就会从 145 变成 149。**145 这个自检值只有班主任不进年级管理才成立。**
 *
 * ⚠️ 2026-09-28 这一轮它**一个字没改**（仍是 super / admin / grade_head）——
 *    新加的那几档走的是**另一个**函数（`seesTeachingData()`），
 *    在 `ENTRIES` 里以 `or` 的形式追加。这么写是为了让"那 34 行的 6 列一个格都不改"
 *    这句话**在代码里看得出来**（改这一个函数的成员 = 同时动 `/grades` 与 `/settings/terms`）。
 */
export function hasManagingRole(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some(
    (r) => r.role === 'super' || r.role === 'admin' || r.role === 'grade_head',
  )
}

/**
 * **唯一的入口表**。加一个入口 = 这里加一行 + `lib/pages.ts` 加一行 +
 * `按身份显示导航方案.md` §2.2 的矩阵加一行（D1/D2 就是拿这个等式当断言的）。
 *
 * 值与方案 §2.2 的矩阵**逐格对应**：
 *   · 五档教师身份对 `/`、`/classes`、`/assignments`、`/exams`、`/wrong`、
 *     `/schedule`、`/settings`、`/files`、`/calls` 全是 V（"看得见几个班"由 RLS 决定，
 *     不在入口层）；教室端到不了它们 —— 那是 `App.tsx` 的 `accountKind` 一支管 32 行，
 *     不是这里 32 个 false（方案 §2.2 的 U4）。
 *   · `classroom` **不是** `teacher_roles` 的一档（它是另一张表的一行），
 *     所以它根本不会出现在 `roles` 里 → 这些项对它是"没有身份" = 不摆。
 */
export const ENTRIES: Record<EntryKey, EntryRule> = {
  '/': { label: '工作台', visibleFor: () => true },
  '/classes': { label: '班级', visibleFor: () => true },
  '/assignments': { label: '作业', visibleFor: () => true },
  '/exams': { label: '考试', visibleFor: () => true },
  '/wrong': { label: '错题集', visibleFor: () => true },
  '/schedule': { label: '日程表', visibleFor: () => true },
  '/settings': { label: '我的', visibleFor: () => true },
  // 入口名按"老师要做什么"写（"教室端文件"是内部命名，老师不知道"教室端"指哪台机器）。
  // ⚠️ 页面本身的标题仍是「教室端文件」（那一页说的是它自己），改的只是这一行的入口名。
  '/files': { label: '传到教室大屏', visibleFor: () => true },
  // §2.3 #17：能走到呼叫页的人（= 能改这份作业的老师）就有记录可看，
  // 六个教师身份都是 V；管理身份与任课老师的差别**在数据范围**（RLS），不在入口。
  '/calls': { label: '呼叫记录', visibleFor: () => true },
  /*
   * 只有**能建教师账号**的几档（`canManageTeachers()`：最高管理员 / 教务处 / 🆕办公室主任）。
   * 🔴 2026-09-28 起它指向 `canManageTeachers` 而**不再**是"能指派身份"那一档 ——
   *    办公室主任建号要看得见这一页，而**指派身份仍归教务处 + 超管**（服务端 403）。
   *    ⚠️ 这一处换的是**函数**、不是值：在那 6 列（没有 office_head）上逐格不变（方案 §4.5）。
   */
  '/accounts': { label: '教师账号', visibleFor: canManageTeachers },
  // ★ 将来（年级管理与选课走班方案 §4.1）：super/admin 全部、年级主任本年级、班主任与任课老师不进。
  //  🆕 追加 `seesTeachingData`：德育处主任与校级三档**看得见**年级/班级名册（只读）——
  //     德育处按"读得一样宽"给 V（他要看名册才能管班主任，方案 §4.2 第 30–32 行）。
  '/grades': {
    label: '年级管理',
    visibleFor: (roles) => hasManagingRole(roles) || seesTeachingData(roles),
  },
  // ★ 将来（同方案 §4.2.5）：提档 = `is_school_admin()`（super + 教务处），**年级主任 ❌**。
  '/grades/promote': { label: '提档与毕业', visibleFor: canManageTeachers },
  /*
   * ★ 将来：**super / admin / 年级主任**（`hasManagingRole`）。
   *
   * ⚠️ 这一格是本轮唯一一处"矩阵与正文打架"的地方，**按矩阵那一格落的**，理由写全：
   *   · 矩阵 §2.2 第 33 行那一格是 **V**，而且 §2.2 下面那张"规模感"表的
   *     `grade_head` 汇总（V29）**只有在这一格是 V 时才成立**（全表 V=145 同理）——
   *     改成 E 会让全表变成 144/28，与 §2.2 与附录里写死的 145/27 **对不上**；
   *   · §2.3 第 33 行的正文却写着"年级主任 E"，§七 待确认 ④ 的建议也是 E。
   *   → 两者矛盾，**采用矩阵的格子（V）+ 145/27 那两个自检值**，
   *     并在本轮报告里单列出来（这是"别默默选"那条要求的落点）。
   */
  '/settings/terms': { label: '学期与学年', visibleFor: hasManagingRole },
  // ★ 平台运维：**只能是 `isSuperAdmin`**（超管面板方案 §3.5 原文：不能用
  // `canManageTeachers()`，那会把教务处也放进来）。服务端 `POST /api/admin/*` 是闸门。
  '/admin': { label: '平台运维', visibleFor: isSuperAdmin },
  /* ---------------- 🆕 通知两行（2026-09-28）---------------- */
  /*
   * 看通知 = **所有老师**（含班主任与任课教师）—— 收件箱对谁都有意义，
   * 而"看通知"与"发通知"是**两件事**（方案 §三 第 39 行）。
   * 🔴 **用 `() => true` 而不是 `canPublishNotice`**：用后者会把班主任和任课老师
   *    挡在自己的收件箱外面 —— 他们收得到通知，却打不开那一页。
   * ⚠️ 教室端是 **B**（它到不了任何教师端页面，`App.tsx:65` 一句一条管全部）——
   *    那不是这里写 32 个 false 能做到的（M2 只准读 roles 一个参数，见 A1 的注释）。
   */
  '/notices': { label: '通知', visibleFor: () => true },
  /*
   * 发通知 = 能发的**八档**（方案 §三 第 33 行）：
   *   超管 · 教务处 · 校级三档 · 办公室主任 · 德育处主任 · 年级主任 · 教研组长 · 备课组长。
   * ⚠️ **班主任与任课教师是 E 而不是 B**（方案 §4.2 第 19 行）：他们进来会看到
   *    "你没有发通知的权限"这样一句说明（服务端 403），**不构成任何信息泄露**。
   *    这里给 `V` 会摆出一个"点了被拒"的按钮，而"发通知"是**新功能**，从一开始就该是对的。
   * 🔴 **能发给谁**完全不在这里 —— 判据只在服务端/数据库（I46）：年级主任与组长
   *    只能发给自己那个范围，前端藏掉"全校"那个选项**不是**安全边界。
   */
  '/notices/new': { label: '发通知', visibleFor: canPublishNotice },
}

/**
 * **唯一的问法**：这个入口对我摆不摆。
 *
 * 多身份是常态（一个老师同时是班主任和年级主任），所以表里每个 `visibleFor` 都是
 * **并集语义**（`.some()`）：看得见的入口 = ⋃(我每一条身份各自看得见的入口)。
 */
export const entryVisible = (
  key: EntryKey,
  roles?: readonly TeacherRole[] | null,
): boolean => {
  /*
   * 🧪 **负向对照用的总闸**：`globalThis.__NAV_FORCE__` 是 `'all' | 'none' | undefined`。
   * 它只在**测试进程里**由 Node 设（`shots.mjs` 从环境变量 `SHUGAO_NAV_FORCE` 转发），
   * 浏览器与生产构建里恒为 `undefined` —— 也就是说**运行时不提供任何改变这条判据的入口**，
   * 它只是一根"给负向对照用的线头"。
   *
   * 为什么必须有它：§18.3 要求"改完断言必须做一次负向对照，而且**两个方向的坏法各要一条**"
   * （恒真 = 入口全摆等于没做；恒假 = 全藏，连胶囊都空了）。
   * 没有这根线头的话，只能去**真改源码**再改回来 —— 而"改回来"这一步一旦出错，
   * 仓库里就留下一条恒真的权限判据（比没有断言糟得多）。
   * ⚠️ 别把它做成 `import.meta.env` 那一类**构建期**开关：那样生产构建里会留一个
   *    "摇不掉"的分支（D7 读 dist 时会红）。运行时的 `globalThis` 在浏览器里永远是 undefined。
   */
  const force = (globalThis as { __NAV_FORCE__?: 'all' | 'none' }).__NAV_FORCE__
  if (force === 'all') return true
  if (force === 'none') return false
  return ENTRIES[key].visibleFor(roles)
}

/**
 * 从一批入口 key 里挑出**对我摆**的那些（顺序原样保留）。
 *
 * 这是给 `AppShell` 的 `NAV` / `PIN_KEYS` 用的：过滤**只在这一个函数里**，
 * 桌面左栏、移动端胶囊、展开层三处都从它的结果取数 —— 三处各写一遍
 * `filter(…)` 就是"同一件事三个判定入口"（本仓库踩过四次的坑，见 §十）。
 *
 * ⚠️ 它同样只读 `roles`（M1/M2）：返回的是 `key` 的子集，**不是数据行**。
 */
export function visibleEntryKeys<K extends EntryKey>(
  keys: readonly K[],
  roles?: readonly TeacherRole[] | null,
): K[] {
  return keys.filter((k) => entryVisible(k, roles))
}

/* ============================================================
   🧪 DEV-only 测试钩子：`?as=` 角色注入（**生产构建里被编译掉**）
   ------------------------------------------------------------
   为什么必须有它（方案 §5.3）：`shots.mjs` 跑的是**本地演示模式**，而 `myRoles` 只在
   远程模式由 `hydrate()` 从 `loadMyRoles()` 灌进去，本地模式恒为 `[]`
   —— 于是"教导处看得见「教师账号」这一行"这句话**永远断言不了**（只能做负向对照，
   而负向对照只能证明"藏住的时候会红"，证明不了"该显示的时候真的显示"）。
   方案 §七 待确认 ③ 的建议是加这个钩子 + 一条"生产构建里无效"的断言。

   ⚠️ 三条边界（写死在这里，改的时候别绕）：
     ① **只在 `import.meta.env.DEV` 生效**：`vite build` 会把 `import.meta.env.DEV`
        折成字面量 `false`，整个分支被摇掉 —— `nav-checks.mjs` 的 D7 读 dist 产物
        核对"`as` / `kind` 这两个查询参数**一次都没出现过**"，所以它不会漏进线上；
     ② **它只改 `myRoles` / `accountKind` 这两个"摆不摆入口"的槽位**，
        不碰任何数据（`classes` / `assignments` / `scores` 一个字都不动）——
        也就是说它连"多看到一行数据"都做不到（RLS 在服务端，钩子够不着）；
     ③ 认不出的角色代码**原样收下**（`roleName()` 的口径：认不出不猜），
        所以 `?as=nonsense` 也测得到"认不出的身份不会意外拿到管理入口"。
   ============================================================ */

/** 合法的角色代码（与 `RoleCode` 同一组；`classroom` 刻意**不在**里面 —— 它不是身份，是另一张表的一行）
 *  ⚠️ 这一组同时是 `?as=` 注入的**白名单来源**（`nav-checks.mjs` 的 A7 拿它逐个试），
 *    所以 14 档身份一个都不能漏 —— 漏了就等于"这一档在 DEV 钩子里注入不了"。
 */
export const TEST_ROLE_CODES: readonly RoleCode[] = [
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
]

/**
 * 从 `location.search` 里解析出**注入的身份**；没有钩子 / 不是 DEV → `null`。
 *
 * `?as=` 用逗号分隔多身份（`?as=teacher,head_teacher`），与"多身份是常态"一致；
 * 空值（`?as=`）当作"没有这个钩子"，不当作"注入空数组" —— 后者会让
 * "老师看不见教师账号那一行"这种断言**在忘记写参数时静默通过**（假通过）。
 */
export function devInjectedRoles(search: string): TeacherRole[] | null {
  // 🔴 这一行是"只在 DEV 生效"的全部实现。别把它挪出这个三元表达式：
  //    生产构建（`vite build`，import.meta.env.DEV === false）会整块摇掉。
  if (!(import.meta.env.DEV && search)) return null
  const raw = new URLSearchParams(search).get('as')
  if (raw === null) return null
  const codes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!codes.length) return null
  // ⚠️ 这里**故意**把认不出的代码也原样收下（`as RoleCode` 是个谎，但它正是
  //    A4 那条断言要测的东西："认不出的角色不会意外获得管理入口"）。
  //    别改成"先过滤掉不认识的" —— 那会把 `?as=nonsense` 静默变成"没有钩子"。
  return codes.map((role) => ({ role: role as RoleCode, scopeType: 'school' as const }))
}

/**
 * 从 `location.search` 里解析出**注入的账号类型**（`?kind=classroom`）。
 *
 * 为什么连它也要注入：`accountKind` 同样只在远程模式由
 * `remote.loadClassroomAccount()` 决定（`store.ts`），演示模式恒为 `'teacher'`
 * —— 而"教室端进不了教师端"（方案 G6 / §五 R3 的 C1–C2）**是安全边界**，
 * 今天一条自动断言都没有。同 `devInjectedRoles()` 的三条边界。
 */
export function devInjectedAccountKind(search: string): 'classroom' | null {
  if (!(import.meta.env.DEV && search)) return null
  return new URLSearchParams(search).get('kind') === 'classroom' ? 'classroom' : null
}

/**
 * 🧪 DEV-only 测试钩子：`?sync=…` 往 store 里塞一条 `syncError`（**生产构建里被编译掉**）。
 *
 * 为什么必须有它（2026-09-28 公告轮）：`SyncErrorBanner`（`App.tsx`，`z-[70]`）
 * **只在"往云端写失败"时才出现**，而 `shots.mjs` 跑的是**本地演示模式** ——
 * 那里一次云端写都不会发生，于是"公告条要给报错横幅让位"这句话**永远断言不了**：
 * 只能断言"没有报错时它贴在最上面"，那证明不了"同时出现时谁在上"。
 * 而这一条恰恰是用户点名要**实测**的那件事（参考项目为它写了 128 行的层叠代码）。
 *
 * ⚠️ 三条边界与 `devInjectedRoles()` **逐字相同**：
 *   ① 只在 `import.meta.env.DEV` 生效（`nav-checks.mjs` 的 D7 读 dist 核对
 *      `sync` 这个查询参数与函数名一次都没出现）；
 *   ② 它只写 `syncError` 那**一个字符串槽位**，不碰任何数据
 *      （`classes` / `assignments` / `scores` 一个字都不动）；
 *   ③ 空值（`?sync=`）当作"没有这个钩子" —— 否则"没有报错横幅"这种断言
 *      会在忘记写参数时**静默通过**（假通过）。
 */
export function devInjectedSyncError(search: string): string | null {
  if (!(import.meta.env.DEV && search)) return null
  const raw = new URLSearchParams(search).get('sync')
  return raw ? raw : null
}

/**
 * 🧪 DEV-only 测试钩子：`?maint=…` 把"维护模式"**装成开着的**（**生产构建里被编译掉**）。
 *
 * 为什么必须有它（2026-09-29 管理台第二期）：维护状态是**服务端**给的
 * （`GET /api/status`），而 `shots.mjs` 跑的是**本地演示模式**（没有服务端）——
 * 于是"全员被送进维护页""教室端切成全屏维护画面""**超管仍然进得去 `/admin`**"
 * 这三句话**一句都断言不了**（这正是这一期最要紧的三条行为）。
 *
 * ⚠️ 三条边界与 `devInjectedSyncError()` **逐字相同**：
 *   ① 只在 `import.meta.env.DEV` 生效（`nav-checks.mjs` 的 D7 读 dist 核对
 *      `maint` 这个查询参数与函数名一次都没出现）；
 *   ② 它只影响**渲染**（`useMaintenanceStatus` 那一处），**一个字都不写数据库**、
 *      也不碰任何数据（`classes` / `assignments` 全不动）；
 *   ③ 空值（`?maint=`）当作"没有这个钩子" —— 否则"没有维护画面"这种断言
 *      会在忘记写参数时**静默通过**（假通过）。
 *
 * ⚠️ 返回值就是**通告正文**（方便截图里出现一句像样的文案）；`?maint=1` 时用默认文案。
 */
export function devInjectedMaintenance(search: string): string | null {
  if (!(import.meta.env.DEV && search)) return null
  const raw = new URLSearchParams(search).get('maint')
  if (!raw) return null
  return raw === '1' ? '系统维护中，请稍后重试。' : raw
}
