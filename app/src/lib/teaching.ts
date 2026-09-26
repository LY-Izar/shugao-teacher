/* ============================================================
   🔴 「我的任教关系」—— **待办口径的唯一判定入口**（2026-10-06）
   ------------------------------------------------------------
   「看得见」≠「待办」。这两件事原来是同一个东西，于是出了一个**会误导人的** bug：

     · **看得见**由数据库（RLS）说了算：班主任 / 年级主任 / 教务处看得见
       **整班各科的作业档案** —— 那是"看"的权限，**一个字都没动**
       （`/assignments` 那个列表照旧列全班各科，班主任要看的就是它）；
     · **待办**是"**我要干的活**"：一条作业进我的待办，当且仅当
       `(它的 classId, 它的 subjectCode)` 落在我的任教关系里（`class_subjects`，schema §10.6）。

   不收这一刀的后果（本轮修的就是它）：REST 读得宽，而「今日待办」原来**只按状态筛** ——
   于是**班主任的待办里混进了数学 / 英语这些他不上课的作业**，点进去还是
   「改成绩只给任课老师」那一页 → **一条改不了、只能退出来的死路待办**。

   两档管理身份走**同一条规则**（"看得见"不是"这活归我"）：
     · 超管 / 教务处 / 年级主任 → 待办**也只列自己教的**；
     · 纯管理、不上课的人（比如纯超管）→ 任教关系为空 → **待办为空**（这是对的）。

   数据来源只有一处：`class_subjects`（`data/remote.ts` 的 `loadClassSubjects()`，
   客户端只读）。⚠️ **不新发明判据**：这里**一个角色字段都不读**
   （`nav-checks` 的 D4/D5 那两张清单上**刻意没有这个文件** —— 它不该出现在那儿）——
   身份管"摆不摆入口"，任教关系管"有没有这活"，两件事（一个字段一种语义，见 §四）。

   ⚠️ **走班班的作业天然落得进来**：P7 那轮「分配走班班老师」会自动补一行
   `class_subjects`（schema §32.3），而走班班也是 `classes` 里的一行 ——
   所以判据不用为它开任何特例，`(走班班 id, 那一科)` 命中即进待办。
   ============================================================ */

import { subjectCodeOf } from './subjects'

/** `class_subjects` 在前端这一侧的形状（与 `data/remote.ts` 的 `ClassSubjectRow` 同一款） */
export type TeachingRow = { classId: string; subjectCode: string; teacherId: string }

/** 进待办的两种状态：待收缴 / 待批改（`graded` = 已批改，不是待办） */
export const TODO_STATUSES = ['open', 'collected'] as const

export function isTodoStatus(status: string): boolean {
  return TODO_STATUSES.includes(status as (typeof TODO_STATUSES)[number])
}

/** 我教这个班的这一科吗（判据只有这一处；调用方一律走它，别就地再写一份 some(...)） */
export function teachesClassSubject(
  rows: readonly TeachingRow[],
  teacherId: string,
  classId: string,
  subjectCode: string,
): boolean {
  return rows.some(
    (r) => r.teacherId === teacherId && r.classId === classId && r.subjectCode === subjectCode,
  )
}

/** 判"进不进我的待办"要看的三个字段（`Assignment` 本来就满足它） */
export type TodoCandidate = { classId: string; subjectCode?: string; subject?: string }

/**
 * 这条作业**进不进我的待办**（只看任教关系那一半；状态那一半在 `pendingForMe()`）。
 *
 * 三种输入**含义各不相同，别合并**（§三.4 的三态纪律）：
 *   · `rows` 是数组（**哪怕是空的**）= **知道**我的任教关系 → 按 `(班, 科)` 逐条判，
 *     空数组就是"我什么课都不教" → 一条都不进待办；
 *   · `rows === null` = **不知道**（还没读回来 / 读失败 / 本地演示模式根本没有数据库）
 *     → **不筛，放行**。不知道**不等于**不教；而且"待办少了一条"比"多了一条"危险得多
 *     —— 多出来的那位老师至少能看出不归自己管，少了的那条是**真的没人干**；
 *   · `teacherId` 认不出（没登录）→ 同上，放行。
 *
 * ⚠️ **学科认不出来的老档案**（`subjectCodeOf()` 反查不到字典，比如自由填写的写法）：
 *    按"**我教这个班**"放行 —— 同样是不许静默丢待办。
 */
export function isMyTodo(
  a: TodoCandidate,
  rows: readonly TeachingRow[] | null,
  teacherId: string | undefined,
): boolean {
  if (!rows || !teacherId) return true
  const classId = String(a.classId ?? '')
  if (!classId) return true
  const code = subjectCodeOf(a)
  if (!code) return rows.some((r) => r.teacherId === teacherId && r.classId === classId)
  return teachesClassSubject(rows, teacherId, classId, code)
}

/**
 * **待办集合** = 状态是待收缴/待批改 **且** 是我的任教关系。
 *
 * 🔴 工作台那一屏里，「今日待办」列表、那一格「待办」数字、以及快捷操作磁贴上的
 *    「N 份待处理」**都从同一次调用的结果上数** —— 别再各写一份 `filter`，
 *    那正是"同一件事两个判定入口"（本仓库踩过多次）。
 */
export function pendingForMe<T extends TodoCandidate & { status: string }>(
  list: readonly T[],
  rows: readonly TeachingRow[] | null,
  teacherId: string | undefined,
): T[] {
  return list.filter((a) => isTodoStatus(a.status) && isMyTodo(a, rows, teacherId))
}
