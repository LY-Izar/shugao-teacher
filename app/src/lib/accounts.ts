/* ============================================================
   账号与身份 —— 前端调用 `/api/teacher-account` 的那一层
   ------------------------------------------------------------
   服务端（`functions/api/teacher-account.ts`）才是闸门：
   它用 service_role 建号，并且**拿你的 JWT 去问数据库**
   （`schema.sql` §13.2 的 `can_create_teacher_accounts()` / `can_assign_roles()` /
   `is_super_admin()`）。
   🔴 2026-09-28 起那两个判据**不再同集合**：建号含办公室主任、指派身份不含 ——
      这正是"拆 `can_manage_teachers`"那一轮的目的（见 `管理架构与角色权限方案.md` §三.4）。
   🆕 2026-09-28 第二轮：**部门归属**（`setDepartment()`）走的是**建号**那一档
      （`can_create_teacher_accounts`：超管 / 教务处 / 办公室主任），因为它改的是**档案属性**
      而不是身份 —— 判据仍然只在数据库那一侧，这里一个字都不重写。
   🆕 2026-09-28 第三轮：**显示姓名**（`renameTeacher()`）同样走**建号**那一档（同上），
      理由也同上：姓名是档案属性。它**不动登录账号**（见那个函数的注释）。
   这里只做三件事：补邮箱后缀、带 JWT、把错误翻成人话。
   ============================================================ */

import { getSupabase } from './supabase'

/**
 * 内部账号的邮箱后缀。
 *
 * 这个平台有三类登录身份，只有第一类是人：
 *   教师 / 管理员：用**自己的**邮箱（真实邮箱只存在于库里，公开仓库里不写具体地址）
 *   教室端账号：  一个班一个，登录名是 `g2-4` 这种短名 —— 不是人，也不该收信
 *
 * 所以登录框允许**只敲短名**，这里按输入内容补后缀：
 *   带 @              → 原样放行（教师、管理员都敲完整邮箱）
 *   纯数字 5–11 位    → 当 QQ 号，补 `@qq.com`（管理员平时只记号码）
 *   其余              → 当内部短名，补 `@shugao.local`
 *
 * 🔴 建号与登录**必须用同一个函数**：两边规则不一致的话，
 *    会出现"账号建出来了、在登录页却敲不进去"这种查半天的问题。
 *    ⚠️ 后缀还必须和 `functions/api/classroom-account.ts` 里的 EMAIL_DOMAIN 一致。
 */
export const ACCOUNT_DOMAIN = '@shugao.local'
export const QQ_DOMAIN = '@qq.com'
const QQ_RE = /^\d{5,11}$/

/** 看输入内容决定补哪个后缀；本来就有 @ 的原样放行 */
export function toEmail(raw: string): string {
  const s = raw.trim()
  if (!s || s.includes('@')) return s
  return QQ_RE.test(s) ? `${s}${QQ_DOMAIN}` : `${s}${ACCOUNT_DOMAIN}`
}

/* ---------------- 服务端返回的形状 ---------------- */

export type DirRole = {
  role: string
  scopeType: string
  scopeId: string
  /**
   * 🆕 组长两档的学科代码（`teacher_roles.subject_code`）。
   * 少了它，界面上"取消这个身份"就删不掉那一行（键对不上）。
   */
  subjectCode: string
  scopeLabel: string
}
export type DirSubject = {
  classId: string
  className: string
  subjectCode: string
  subject: string
}
export type DirTeacher = {
  id: string
  name: string
  subject: string
  primarySubjectCode: string | null
  school: string
  roles: DirRole[]
  subjects: DirSubject[]
  /**
   * 🆕 他属于哪些职能部门（`teacher_departments`，2026-09-28 第二轮）。
   * **可以是 0 个**（纯任课老师）、**也可以是多个**（一个人兼任两个部门）。
   * ⚠️ 老服务端 / 老库上这个字段不存在 → 页面一律写 `t.departments ?? []`。
   */
  departments: string[]
  /**
   * 🆕 **这个人能不能被选去"教书"**（班主任 / 年级主任 / 走班老师 / 批量写任教关系那几处下拉）。
   *
   * 🔴 判据在**服务端**（`functions/api/teacher-account.ts` 的 `loadDirectory()`）：
   *    没有 `super` 身份 = `true`。最高管理员是平台主人、不是这个学校的任课老师，
   *    所以**不该被当成老师选中去教书**；⚠️ 教务处（`admin`）照旧 `true`。
   *
   * ⚠️ 它**只管"能不能被选去教书"**：`false` 的人**照旧出现在「教师管理」名单里**
   *    （那一页管理的是账号，不是任教分配）—— 所以这是**带标记**，不是"从列表里删掉"。
   */
  teachable: boolean
}
export type Directory = {
  teachers: DirTeacher[]
  classes: { id: string; name: string }[]
  grades: { id: string; name: string }[]
}

/**
 * 🆕 2026-10-09：**"选老师去教书"的那几处下拉用这一份**。
 *
 * 🔴 判据不在前端：只照服务端回的那一位 `teachable` 筛（M1/M2 —— 前端不自己看 `roles`）。
 *    落点（`grep teachers.map` 逐个过完的那一份清单）：
 *      · `pages/GradeSetup.tsx` 四处 —— 年级主任 / 班主任 / 按老师批量写任教关系 / 走班班老师
 *      · `pages/Classes.tsx` 一处 —— 走班班的「走班老师」
 *    ⚠️ **不在**这里的：「教师管理」（`pages/TeacherAccounts.tsx`）与部门分配、
 *    以及 `GradeSetup` 里那句"班主任配齐没"的计数 —— 那些是**管理名单/统计**，照旧看全部人。
 */
export function teachableOnly(list: readonly DirTeacher[]): DirTeacher[] {
  return list.filter((t) => t.teachable)
}
export type CreatedAccount = {
  id: string
  name: string
  email: string
  password: string
  subjectCode: string
  subject: string
}

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; message: string; detail?: string }
export type Result<T> = Ok<T> | Err

/** 统一出口：任何失败都变成 `{ok:false,message}`，页面只显示 message（+detail 折在下面） */
async function call<T>(body: Record<string, unknown>): Promise<Result<T>> {
  const sb = getSupabase()
  const session = sb ? (await sb.auth.getSession()).data.session : null
  const token = session?.access_token
  if (!token) return { ok: false, message: '登录已过期，请重新登录后再试' }

  let res: Response
  try {
    res = await fetch('/api/teacher-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, message: '网络不通，这次操作没有发出去' }
  }

  const text = await res.text()
  let payload: Record<string, unknown> = {}
  try {
    const v = JSON.parse(text || '{}')
    if (v && typeof v === 'object') payload = v as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (res.ok) return { ok: true, data: payload as T }
  if (res.status === 404) {
    return {
      ok: false,
      message: '账号服务暂时不可用，请稍后再试。',
    }
  }
  return {
    ok: false,
    message: String(payload.message ?? `操作失败（HTTP ${res.status}）`),
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
  }
}

/* ---------------- 具体动作 ---------------- */

/**
 * 🆕 显示姓名的长度上限 —— 与**服务端** `functions/api/teacher-account.ts` 的 `NAME_MAX`
 * **同一个数**（那边是唯一的闸门，这里只是"别让他白敲"）。
 *
 * ⚠️ 这不是第二套判据：服务端 `checkTeacherName()` 才是判据，
 *    这一份只用来在输入框上写一句提示（判据在数据库/服务端那一侧的纪律见 AGENTS.md）。
 */
export const NAME_MAX = 24

export const listTeachers = () => call<Directory>({ action: 'list' })

export type CreateInput = {
  name: string
  /** 原始输入（QQ 号也行）—— 后缀在这里补，保证和登录页同一套规则 */
  account: string
  subjectCode: string
  /** 显示名（由字典推出；服务端仍会以 `subjects` 表为准） */
  subject: string
  password?: string
  school?: string
  classIds?: string[]
}

export const createTeacher = (input: CreateInput) =>
  call<{ account: CreatedAccount; warnings?: string[] }>({
    action: 'create',
    name: input.name,
    email: toEmail(input.account),
    password: input.password ?? '',
    subjectCode: input.subjectCode,
    subject: input.subject,
    school: input.school ?? '',
    classIds: input.classIds ?? [],
  })

export const resetTeacherPassword = (teacherId: string) =>
  call<{ password: string }>({ action: 'reset', teacherId })

/**
 * 🆕 改**显示姓名**（`teachers.name`）。
 *
 * 🔴 改的只是显示名 —— **不动登录账号**（`auth.users.email`），
 *    所以他的任教关系 / 身份 / 部门 / 登录方式一个字都不变（这正是它的用处：
 *    姓名打错了不必重建账号）。判据在服务端：`can_create_teacher_accounts()`
 *    （超管 / 教务处 / 办公室主任），与建号同一档。
 *
 * 返回改后的姓名，调用方**就地更新那一行**即可（不必重拉整张名单）。
 */
export const renameTeacher = (teacherId: string, name: string) =>
  call<{ teacher: { id: string; name: string } }>({ action: 'rename', teacherId, name })

/**
 * 🆕 2026-10-06：存**教师档案**（家庭住址 / 电话号码 / 邮箱，`teacher_profiles`）。
 *
 * 🔴 **判据在服务端那一句 `can_create_teacher_accounts()`**（超管 / 教务处 / 办公室主任）——
 *    与"建号 / 部门 / 显示姓名"同一档，这里**不重写规则**。
 *    ⚠️ 老师本人改不了自己的档案（他读得到自己那一行，写不了）—— 这是本轮的决定，
 *    理由在 `supabase/schema.sql` §36（"改档案"是管档案的人的活）。
 *
 * 🔴 它**不碰登录账号**：`email` 是**联系邮箱**，登录名在 `auth.users.email` —— 两回事。
 *
 * ⚠️ 三个字段**全可空**：空串 = 清掉这一格（服务端落库统一成 null）。
 *    形状（电话 / 邮箱）由数据库那两条 check 守，服务端把 23514 翻成一句人话回来。
 */
export const saveTeacherProfile = (
  teacherId: string,
  profile: { homeAddress: string; phone: string; email: string },
) => call<{ profile: { homeAddress: string; phone: string; email: string } }>({ action: 'profile', teacherId, profile })

export const assignSubject = (input: {
  teacherId: string
  classId: string
  subjectCode: string
  subject: string
  on: boolean
}) => call<{ subjectCodeSaved?: boolean }>({ action: 'assign', ...input })

/**
 * 指派 / 取消身份。
 *
 * 🆕 2026-09-28：14 档身份里有**五种**范围形状，所以参数比原来多一个：
 *   · `scopeType` / `scopeId` —— 年级（`grade`）或班级（`class`），组长两档用 `subject` / `grade_subject`
 *   · `roleSubjectCode`      —— **组长两档必填**（少了它判据永远匹配不到，指派等于白做）
 *   · 取消（`on: false`）时**要把这一行自己的形状原样传回来**（含学科代码）：
 *     服务端按同一张形状表拼删除条件，少一个字段就会"看起来取消成功了、其实那行还在"。
 *
 * 🔴 服务端那道闸门与建号**不是**同一档：建号是
 *    `can_create_teacher_accounts()`（含办公室主任），指派身份是 `can_assign_roles()`
 *    （**不含**办公室主任）。
 */
export const setRole = (input: {
  teacherId: string
  role: string
  scopeType?: string
  scopeId?: string
  roleSubjectCode?: string
  on: boolean
}) => call<Record<string, never>>({ action: 'role', ...input })

/**
 * 🆕 改**部门归属**（2026-09-28 第二轮）。
 *
 * 与"指派身份"是**两件事**（服务端两道不同的闸门，见 `functions/api/teacher-account.ts`）：
 *   · 部门归属 = **档案属性**（他在哪个处室），与建号 / 任课关系同一档 →
 *     `can_create_teacher_accounts()`（超管 / 教务处 / **办公室主任**）；
 *   · 身份     = `can_assign_roles()`（超管 / 教务处，**不含**办公室主任）。
 *
 * 🔴 **参数是数组**（不是单个）：界面上的形状就是"多选"—— 一次给一批老师加/去一批部门，
 *    服务端按**笛卡尔积**写（用户口径：开学时不要手工点几百下）。
 *    一个人可以属于多个部门、也可以一个都不属于，所以"去掉"是**按 (人, 部门) 这一对**删的。
 *
 * @param input.teacherIds  要改哪几位老师（多选）
 * @param input.departments 要加/去的部门代码（多选；`lib/departments.ts` 的四个）
 * @param input.on          true = 加上，false = 去掉
 */
export const setDepartment = (input: {
  teacherIds: string[]
  departments: string[]
  on: boolean
}) => call<Record<string, never>>({ action: 'department', ...input })
