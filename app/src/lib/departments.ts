/* ============================================================
   职能部门（办公室 / 教务处 / 总务处 / 德育处）—— 前端**只负责显示**
   ------------------------------------------------------------
   来源：用户口述的**真实架构**（2026-09-28 第二轮）：
   「通知这里，应该还可以给各个职能部门发通知呀」。

   🔴 这个文件里**没有任何判据**，它只回答"这个代码显示成什么字"：
     · 谁能发通知给某个部门 → 数据库 `can_publish_notice_to_for(…)`（schema §21.4）；
     · 哪个部门里都有谁     → 数据库 `teacher_departments` 表（schema §21.2.2）；
     · 谁能维护这个归属     → 服务端 `/api/teacher-account` 问数据库
                              `can_create_teacher_accounts()`（超管 / 教务处 / 办公室主任）。
     前端拿这里的名字去**摆选项 / 写标签**，拿不到任何"多看到一行"的能力。

   🔴 **四值清单在三个地方必须是同一组**（少一处就是"同一件事两个口径"）：
     · SQL：`notice_departments()`（schema §21.2.2）＋ `teacher_departments.department` 的 check
     · 服务端：`app/functions/api/notice.ts` 的 `DEPARTMENTS` 与
       `app/functions/api/teacher-account.ts` 的 `DEPARTMENTS`（形状校验，不在里面直接 400）
     · 这里（**显示名**，前端唯一的定义处）
     `app/scripts/nav-checks.mjs` 的 **A9** 拿源码文本把这四份逐字比对；
     `app/scripts/rls-checks.mjs` 另有一条把 SQL 那两处（函数 vs check 约束）对上。
   ============================================================ */

/** 部门代码（与数据库里那一列的值**逐字相同**） */
export type DepartmentCode = 'office' | 'academic' | 'logistics' | 'moral_edu'

/**
 * 四个部门（顺序 = 通知收件范围选项在界面上的顺序 = 服务端 `DEPARTMENTS` 的顺序）。
 *
 * ⚠️ `logistics`（总务处）在这里是**真实存在的部门**，而 `teacher_roles.role` 里**没有**
 *    叫 `logistics` 的身份 —— 两者不是一回事（见 `schema.sql` §21.2.2 那段）：
 *    身份是"有权限的那一档"，部门是"他在哪个处室"。
 *    `教师账号` 页里那位总务处的老师可以一条身份行都没有（= 任课教师那一档）。
 */
export const DEPARTMENTS: { code: DepartmentCode; name: string; note: string }[] = [
  { code: 'office', name: '办公室', note: '日常行政 / 公文 / 会议' },
  { code: 'academic', name: '教务处', note: '教务口径的日常执行' },
  { code: 'logistics', name: '总务处', note: '后勤 / 资产 / 场地' },
  { code: 'moral_edu', name: '德育处', note: '班主任管理 / 学生活动' },
]

/**
 * 认得出的部门代码 → 显示名；认不出**原样回显**。
 *
 * 与 `lib/roles.ts` 里"认不出的角色代码原样显示、不猜也不吞掉"是同一条纪律 ——
 * 宁可让界面上出现一个生代码，也不要谎报一个部门名（把语文老师显示成"教务处"比留一个
 * `academic` 难查得多）。⚠️ 这条纪律**不在**这里重新定义一次身份：`labels` 归 `roles.ts`，
 * 这里只管部门。
 */
export function departmentName(code?: string | null): string {
  const s = String(code ?? '').trim()
  if (!s) return ''
  return DEPARTMENTS.find((d) => d.code === s)?.name ?? s
}
