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
     ③ 这里 —— 只回答"界面上该不该摆这个入口"

   🔴 为什么③不算"第二套判据"：它对数据的可见范围**一无所知**，
      也不可能让谁多看到一行 —— 真正的闸门是①，服务端每次都问。
      `功能设计与不变量.md` §11.3 那条纪律（前端不另写权限过滤）说的是**数据行**，
      而"显示哪些入口"按设计就是前端的事（`多学科体系方案.md` §3.3.4）。
   ============================================================ */

import type { RoleCode, TeacherRole } from '../data/types'

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
