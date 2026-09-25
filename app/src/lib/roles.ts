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
 *  `admin` 显示成「教导处」—— 用户口径：「`admin` = 教导处 / 校级行政，
 *  不是"行政老师"这个新角色」（2026-09-27）。角色代码**不改**（改代码是破坏性迁移）。 */
export const ROLE_NAME: Record<RoleCode, string> = {
  super: '最高管理员',
  admin: '教导处',
  grade_head: '年级主任',
  head_teacher: '班主任',
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
 * ⚠️ 当前**没有调用方**：指派身份已经改成 `canAssignRoles()`（教导处 + 最高管理员）。
 * 留着它是因为"只有最高管理员"这件事仍然是一个**独立的判据**
 * （`schema.sql` §16.8：留给交接超管身份这类只有超管能做的事）——
 * 别拿 `canManageTeachers()` 去替代它，那正是把两种身份混成一种。
 */
export function isSuperAdmin(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super')
}

/** 我能不能建教师账号 / 维护任课关系 / 重置密码（界面用；闸门见文件头①） */
export function canManageTeachers(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super' || r.role === 'admin')
}

/**
 * 我能不能**指派身份**（班主任 / 年级主任 / 教导处 / 最高管理员）。
 *
 * 用户 2026-09-27 口径：**教导处 + 最高管理员**都能指派 ——
 * 原话是「班主任，年级主任的身份也要由行政管理（教导处）给」。
 * （09-26 那一轮曾经做成"只有最高管理员"，与这条口径不符，已改。）
 *
 * 它与 `canManageTeachers()` 今天**恰好同集合**，但仍然写成两个函数：
 * 这是两处判据、两种语义（能建号 ≠ 能指派身份），将来任一边收紧时，
 * 改的是一个函数而不是散落各处的 `role === 'super' || role === 'admin'`（I17）。
 */
export function canAssignRoles(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super' || r.role === 'admin')
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
 * ⚠️ 这张表只决定**标签上按什么顺序写**，与权限无关 ——
 *    "谁能建号 / 谁能指派身份 / 谁改得了成绩"一律以数据库为准（§13.5 I16、§16）。
 *    别拿它去写任何 if 判断（那正是 I17 说的"第二处判据"）。
 */
const MANAGING_ROLES: readonly RoleCode[] = ['super', 'admin', 'grade_head', 'head_teacher']

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
