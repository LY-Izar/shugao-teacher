/* ============================================================
   账号与身份 —— 前端调用 `/api/teacher-account` 的那一层
   ------------------------------------------------------------
   服务端（`functions/api/teacher-account.ts`）才是闸门：
   它用 service_role 建号，并且**拿你的 JWT 去问数据库**
   （`schema.sql` §13.2 的 `can_create_teacher_accounts()` / `can_assign_roles()` /
   `is_super_admin()`）。
   🔴 2026-09-28 起那两个判据**不再同集合**：建号含办公室主任、指派身份不含 ——
      这正是"拆 `can_manage_teachers`"那一轮的目的（见 `管理架构与角色权限方案.md` §三.4）。
   这里只做三件事：补邮箱后缀、带 JWT、把错误翻成人话。
   ============================================================ */

import { getSupabase } from './supabase'

/**
 * 内部账号的邮箱后缀。
 *
 * 这个平台有三类登录身份，只有第一类是人：
 *   教师 / 管理员：用真实邮箱（`admin2@example.com`、`admin@example.com`）
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
}
export type Directory = {
  teachers: DirTeacher[]
  classes: { id: string; name: string }[]
  grades: { id: string; name: string }[]
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
      message:
        '这个部署里没有账号服务（/api/teacher-account）。在本地开发环境（npm run dev）下它不存在，线上才有。',
    }
  }
  return {
    ok: false,
    message: String(payload.message ?? `操作失败（HTTP ${res.status}）`),
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
  }
}

/* ---------------- 具体动作 ---------------- */

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
