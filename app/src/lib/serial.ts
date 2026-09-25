import type { Klass, Student } from '../data/types'

/* ============================================================
   序列号的**前端镜像**（规则与 `supabase/schema.sql` §20.3 逐条相同）
   ------------------------------------------------------------
   序列号 = **4 位入校年份 + 该届内 3 位序号**（Q6，例 `2025001`）：
     · 插班生 / 转学生**追加到年级末尾**（已用最大号 + 1，**不复用空号** —— U-2 = A）；
     · **生成后永久不可改**（数据库触发器强制，`schema.sql` §20.2）。

   🔴 **这不是第二个真相**：云端以**数据库**那条规则为准
      （`students_serial_fill()` 触发器 + `assign_student_serials()`）。
      前端这份只在两种情形发号：
        ① **本地演示模式**（根本没有数据库）；
        ② **导入一份没有序列号的老备份**（v1/v2 —— §4.4 的"按班内学号反查补成序列号"）。

   入校年份的来路（**顺序与数据库逐条相同**，认不出就返回空串 → **不发号、不猜**）：
     ① `yearOf[年级名]`（云端由 `grades.cohort` / `grades.year` 来，见 `remote.ensureGradeLookup`）
     ② 同年级**已有学生**的序列号前缀（**一致时**才算 —— 从数据里读出来的事实，不是猜）
   ⚠️ **不用 `classes.year`**：那是"学年"（`2025-2026`），与"届"是两回事（§2.13.1 的教训）。
   ============================================================ */

const SERIAL_RE = /^[0-9]{4}[0-9]{3}$/

export const isSerial = (v: string | undefined): boolean => !!v && SERIAL_RE.test(v)

/** 「年级名 → 4 位入校年份」。云端来自 `grades`，本地/老备份可能只有一部分。 */
export type SerialYearLookup = Record<string, string>

/** 一个学生**已经**有序列号时，把它的年份前缀并进 lookup（本地模式下自我补全） */
export function yearLookupFromClasses(classes: readonly Klass[]): SerialYearLookup {
  const out: SerialYearLookup = {}
  for (const k of classes) {
    if (!k.grade) continue
    const years = new Set<string>()
    for (const s of k.students ?? []) if (isSerial(s.serial)) years.add(String(s.serial).slice(0, 4))
    // 同一年级里出现两个年份前缀 = 说明这一批数据跨届（或者有人手填过）→ **不认**
    if (years.size === 1) out[k.grade] = [...years][0]
  }
  return out
}

/** 认出入校年份（'' = 认不出，**不猜**）—— 与 `serial_year_of_class()` 同顺序 */
export function serialYearOfClass(k: Klass, yearOf: SerialYearLookup = {}): string {
  const byName = (yearOf[k.grade] ?? '').trim()
  if (/^[0-9]{4}/.test(byName)) return byName.slice(0, 4)

  const years = new Set<string>()
  for (const s of k.students ?? []) if (isSerial(s.serial)) years.add(String(s.serial).slice(0, 4))
  if (years.size === 1) return [...years][0]
  return ''
}

/** 该届**已用过的最大序号**（只看本班之外的由调用方补齐；这里要的是全局视角） */
function maxSeqOfYear(classes: readonly Klass[], year: string, skipIds: Set<string>): number {
  let max = 0
  for (const k of classes) {
    for (const s of k.students ?? []) {
      if (skipIds.has(s.id)) continue
      const v = String(s.serial ?? '')
      if (isSerial(v) && v.slice(0, 4) === year) max = Math.max(max, Number(v.slice(4)))
    }
  }
  return max
}

export type SerialAssignResult = { assigned: number; unresolved: number; classes: Klass[] }

/**
 * 给**没有序列号**的学生补号（幂等：已经有的一个都不动）。
 *
 * ⚠️ 编号顺序：按年级分组，组内按 `studentNo` 数字序 / 姓名序 —— **顺序只决定"谁排在前面"**，
 *    不影响任何正确性（迁移的映射靠班内学号一对一，`schema.sql` §20.4）。
 *    云端那边用的是"姓名拼音序"，本地这份退化成学号序；**两边都只是外观差异**。
 */
export function assignMissingSerials(
  classes: readonly Klass[],
  yearOf: SerialYearLookup = {},
  /**
   * 只用来算"这个届已经用到几号了"的**额外名单**（不修改它）。
   *
   * 为什么需要：恢复一份**没有序列号的 v1/v2 老备份**时，号码不能从 001 重来 ——
   * 云端/本机**已经有**这一届的学生，重来就会撞上唯一索引（整批 upsert 被拒）。
   * 所以调用方把"当前 app 里已有的那些班"传进来当编号基数。
   */
  numberingBase: readonly Klass[] = [],
): SerialAssignResult {
  const lookup = { ...yearLookupFromClasses(classes), ...yearOf }
  let assigned = 0
  let unresolved = 0

  const next = classes.map((k) => ({ ...k, students: [...(k.students ?? [])] }))
  // 自增游标：按年份各一个（**追加到年级末尾**，不复用空号）
  const cursor = new Map<string, number>()
  const base = [...next, ...numberingBase]

  for (const k of next) {
    const year = serialYearOfClass(k, lookup)
    if (!year) {
      unresolved += (k.students ?? []).filter((s) => !isSerial(s.serial)).length
      continue
    }
    if (!cursor.has(year)) cursor.set(year, maxSeqOfYear(base, year, new Set()))
    const missing = k.students
      .filter((s) => !isSerial(s.serial))
      .sort(
        (a, b) =>
          (Number(a.studentNo) || 0) - (Number(b.studentNo) || 0) ||
          a.studentNo.localeCompare(b.studentNo) ||
          a.name.localeCompare(b.name),
      )
    for (const s of missing) {
      const n = (cursor.get(year) ?? 0) + 1
      if (n > 999) {
        unresolved++
        continue
      }
      cursor.set(year, n)
      s.serial = `${year}${String(n).padStart(3, '0')}`
      assigned++
    }
  }

  return { assigned, unresolved, classes: next }
}

/** 单个学生发号（本地模式新建 / 转班时用；认不出年份就原样返回） */
export function withSerial(
  student: Student,
  klass: Klass,
  classes: readonly Klass[],
  yearOf: SerialYearLookup = {},
): Student {
  if (isSerial(student.serial)) return student
  const year = serialYearOfClass(klass, { ...yearLookupFromClasses(classes), ...yearOf })
  if (!year) return student
  const n = maxSeqOfYear(classes, year, new Set()) + 1
  if (n > 999) return student
  return { ...student, serial: `${year}${String(n).padStart(3, '0')}` }
}
