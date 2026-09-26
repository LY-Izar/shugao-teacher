/* ============================================================
   教室端账号 —— 前端调用 `/api/classroom-account` 的那一层
   ------------------------------------------------------------
   服务端（`functions/api/classroom-account.ts`）才是闸门：
   建号 / 重置密码必须用 service_role，所以判据只能由服务端
   **拿调用者 JWT 问数据库**（`teacher_roles` + `classes.grade_id`，那一个 `mayManage()`）。
   🔴 这一层**不写任何判据**：它只做三件事 —— 递请求、把回话翻译成人话、
   把"密码只在生成时显示这一次"这句话留在**一处**（免得页面上再抄一遍就漂了）。

   🔴 为什么没有"查看原密码"这个动作（写给后人，别再来问一次）：
   Supabase 的密码是**哈希存储**的，服务端自己也拿不回原文 ——
   所以这件事**不是没做，是做不成**。替代方案是「重置密码」：
   生成一串新的、**当场显示一次**，要密码就重置。
   这也是为什么界面上必须写清"只显示这一次"（照教师账号那块的既有写法）。
   ============================================================ */

import { apiMessage, postApi, type ApiResult } from './api'

export type ClassroomAccount = {
  /** 归属的班 */
  classId: string
  /** 屏上显示的那个名字（`高二(4)班教室`）—— 由服务端拼，前端不重算 */
  name: string
  /** 登录账号（`g2-4@shugao.local`） */
  email: string
  /** 停用后教室端那个屏登不进去 */
  disabled: boolean
  /** 🔴 **只在这个回合里有值**（刚建出来 / 刚重置完）；之后再问服务端也拿不到 */
  password?: string
}

/** 从回话里读那一个 `account` 对象；形状不对就回 `null`（**不猜**） */
export function readAccount(r: ApiResult): ClassroomAccount | null {
  const a = r.data?.account
  if (!a || typeof a !== 'object') return null
  const o = a as Record<string, unknown>
  if (typeof o.email !== 'string' || !o.email) return null
  return {
    classId: String(o.classId ?? ''),
    name: String(o.name ?? ''),
    email: o.email,
    disabled: o.disabled === true,
    ...(typeof o.password === 'string' && o.password ? { password: o.password } : {}),
  }
}

/** 这个班有没有教室端账号（**只回账号，不回密码**） */
export function readHasAccount(r: ApiResult): boolean | null {
  const v = r.data?.hasAccount
  if (typeof v !== 'boolean') return null
  return v
}

/**
 * 失败一律翻成人话 —— **不同档的下一步动作不同**，混成一句"操作失败"会让人去改权限：
 *   · 401 登录过期 → 重新登录
 *   · 403 数据库说这个人管不着这个班 → 换人（唯一能说"没权限"的那一档）
 *   · 503 环境没配 / 建表脚本没跑 → 去补环境（服务端已经写了人话，原样带出来）
 *   · 404 服务端还没部署这一版 → 说清是"还没有这个动作"，别冤枉用户的权限
 *   · 409 `create` 撞上"已经有账号"（那不是失败：页面照常显示那个账号）
 *   · 0   连不上（断网 / 本地演示模式）→ 不解释技术路径
 */
export function classroomAccountMessage(r: ApiResult, fallback: string): string {
  if (r.status === 401) return '登录已过期，重新登录后再试。'
  if (r.status === 403) return apiMessage(r, '你没有管理这个班教室端账号的权限。')
  if (r.status === 503) return apiMessage(r, '教室端账号服务还没就绪。')
  if (r.status === 404) return '教室端账号服务还没更新到这一版，先让维护者重新部署一次。'
  if (r.status === 409) return apiMessage(r, '这个班已经有教室端账号了。')
  if (r.status === 0) return '连不上服务器，这一块现在只能看。'
  return apiMessage(r, fallback)
}

/* ---------------- 四个动作（服务端 `action` 的四个值）---------------- */

/** 看一眼这个班有没有账号（**只回账号**） */
export function apiClassroomAccountStatus(classId: string): Promise<ApiResult> {
  return postApi('/api/classroom-account', { action: 'status', classId })
}

/** 建账号（屏幕上一班一个；已经有就回 `exists`，不重复建） */
export function apiCreateClassroomAccount(classId: string): Promise<ApiResult> {
  return postApi('/api/classroom-account', { action: 'create', classId })
}

/** 重置密码（新密码只在这一回合的回话里） */
export function apiResetClassroomPassword(classId: string): Promise<ApiResult> {
  return postApi('/api/classroom-account', { action: 'reset', classId })
}

/** 停用 / 恢复这个班的教室端 */
export function apiSetClassroomDisabled(
  classId: string,
  disabled: boolean,
): Promise<ApiResult> {
  return postApi('/api/classroom-account', {
    action: disabled ? 'disable' : 'enable',
    classId,
  })
}

/**
 * 界面上必须照原样写出来的一句话 —— **只有这一处**。
 * 它是"为什么看不到原密码"的答案，也是用户点「重置密码」前该知道的代价。
 */
export const PASSWORD_SHOWN_ONCE = '密码只在生成时显示这一次，关掉就看不到了。'
