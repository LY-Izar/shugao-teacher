/* ============================================================
   身份（角色）—— 前端**只负责显示**，判据一律在数据库
   ------------------------------------------------------------
   用户口径（2026-09-26）：**最高管理员与行政老师是两种身份，权限要分开**。
   落到代码里是三处，缺一不可：

     ① `supabase/schema.sql` §13.2 的两个函数 —— **唯一判据**
        `is_super_admin()`      只有最高管理员
        `can_manage_teachers()` 最高管理员 + 行政老师
     ② `app/functions/api/teacher-account.ts` —— 用 service_role 建号前，
        拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 问数据库，
        **不在 TypeScript 里重写一遍规则**
     ③ 这里 —— 只回答"界面上该不该摆这个入口"

   🔴 为什么③不算"第二套判据"：它对数据的可见范围**一无所知**，
      也不可能让谁多看到一行 —— 真正的闸门是①，服务端每次都问。
      `功能设计与不变量.md` §11.3 那条纪律（前端不另写权限过滤）说的是**数据行**，
      而"显示哪些入口"按设计就是前端的事（`多学科体系方案.md` §3.3.4）。
   ============================================================ */

import type { RoleCode, TeacherRole } from '../data/types'

/** 身份的显示名。加一档身份 = 这里加一行 + schema 的 check 约束加一个值 */
export const ROLE_NAME: Record<RoleCode, string> = {
  super: '最高管理员',
  admin: '行政老师',
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

/** 我是不是最高管理员（界面用；闸门见文件头①） */
export function isSuperAdmin(roles?: readonly TeacherRole[] | null): boolean {
  return (roles ?? []).some((r) => r.role === 'super')
}

/** 我能不能建教师账号 / 维护任课关系 / 重置密码（界面用；闸门见文件头①） */
export function canManageTeachers(roles?: readonly TeacherRole[] | null): boolean {
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
