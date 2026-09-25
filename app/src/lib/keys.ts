import type { Student } from '../data/types'

/* ============================================================
   档案键（I40）：那 10 个以学号为键的字段，键**一律是学生的序列号**
   ------------------------------------------------------------
   为什么要有这个文件（`年级管理与选科走班方案.md` §2.1 / schema.sql §20）：
     · 今天 `wrong` / `missingNos` / `confirmedNos` / … 这些字段的键是**班内学号**，
       而学号只在班内唯一 → 走班一上线，一个走班班里同时有 1 班的 3 人和 4 班的 33 人
       → **两个"12 号"**，`wrong = {"12": [...]}` 把两个孩子**静默合并**；
     · 所以键换成全校唯一的 `students.serial`（P1 的键值迁移）。

   🔴 **兼容期的两条路**（与 §12.4 的 `subject_code` / `grade_id` 同一套纪律）：
     · **写**：一律用 `archiveKeyOf()`（新口径 = 序列号）；
     · **读**：先按序列号找，**找不到再按班内学号找**（老库 / 迁移中途的行仍然读得到）；
     · 序列号为空 = 这一行还没生成序列号 → `archiveKeyOf()` 原样退回班内学号，
       **老库上的行为一个字节都不变**。
     · 优先级：**序列号优先**。万一某个学生的序列号长得跟另一个学生的班内学号一样，
       以序列号为准（那是"新口径"，而且序列号是 7 位 `YYYY`+`NNN`，班内学号是 1–3 位）。

   ⚠️ **别在页面里自己写 `s.serial || s.studentNo`** —— 那样"两条路"就会散落到几十处，
   漏一处是**静默读不到数据**（列表少一个人，而且不报错）。这个文件是唯一入口。
   ============================================================ */

/** 这一行的**键候选**：序列号（有的话）在前，班内学号在后 */
export function archiveKeyCandidates(s: Pick<Student, 'serial' | 'studentNo'>): string[] {
  const serial = typeof s.serial === 'string' ? s.serial : ''
  const no = typeof s.studentNo === 'string' ? s.studentNo : ''
  if (serial && serial !== '' && serial !== no) return [serial, no]
  return [no]
}

/** **写**的时候用的键（唯一口径）：有序列号就是序列号，没有就退回班内学号 */
export function archiveKeyOf(s: Pick<Student, 'serial' | 'studentNo'>): string {
  const serial = typeof s.serial === 'string' ? s.serial : ''
  return serial && serial !== '' ? serial : s.studentNo
}

/** **读** `Record<键, T>`（`wrong` / `grades` / `calls.states`）：先序列号、再班内学号 */
export function archiveValue<T>(
  rec: Record<string, T> | undefined | null,
  s: Pick<Student, 'serial' | 'studentNo'>,
): T | undefined {
  if (!rec) return undefined
  for (const k of archiveKeyCandidates(s)) {
    const v = rec[k]
    if (v !== undefined) return v
  }
  return undefined
}

/** **读** `string[]`（`missingNos` / `lateNos` / `focusNos` / …）：两条路任一命中即算 */
export function archiveHas(
  list: readonly string[] | undefined | null,
  s: Pick<Student, 'serial' | 'studentNo'>,
): boolean {
  if (!list || !list.length) return false
  for (const k of archiveKeyCandidates(s)) if (list.includes(k)) return true
  return false
}

/** 键 → 学生（**读**方向：档案里存着的那个键，去名单里找是谁） */
export function studentOfArchiveKey<T extends Pick<Student, 'serial' | 'studentNo'>>(
  students: readonly T[] | undefined | null,
  key: string,
): T | undefined {
  if (!students || !students.length || key === '') return undefined
  return students.find((s) => archiveKeyOf(s) === key || s.studentNo === key)
}

/** 键 → 显示用的班内学号（界面上**永远显示班内学号**，不是序列号 —— 老师看到的东西不变） */
export function displayNoOfArchiveKey<T extends Pick<Student, 'serial' | 'studentNo'>>(
  students: readonly T[] | undefined | null,
  key: string,
): string {
  return studentOfArchiveKey(students, key)?.studentNo ?? key
}
