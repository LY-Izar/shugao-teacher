import type { ClassKind, ClassType, Klass, Student } from '../data/types'
import { CLASS_TYPE_DEFAULT } from '../data/types'
import { subjectName, type SubjectCode } from './subjects'

/* ============================================================
   选科（3+1+2）—— **结构约束的唯一一处判定入口**
   ------------------------------------------------------------
   用户拍板（Q1 = C）：**不枚举 12 种组合**，而是写成"首选 1 门 + 再选 2 门"的
   结构约束，再开一档「其他」给学校开不出的组合。

   🔴 为什么这条纪律这么要紧：选科有**四条写入路径**
      （单条改 / 粘贴批量 / 一键按班型默认 / 导入），
      各写一份结构判断就是"同一件事四个判定入口"（本仓库踩过四次）。
      服务端那一侧同一份判断在 `schema.sql` §27.4 的 `student_subject_check()` ——
      **两边必须同值**，改一处就要改两处（`nav-checks.mjs` 的 A11 拿源码逐字比对）。

   ⚠️ 这里是**形状**判断（进不进得去），不是**权限**判断（谁能改）—— 后者只在数据库。
   ============================================================ */

/** 3+1+2 里的那个「1」：首选只有两门 */
export const PRIMARY_CODES: readonly SubjectCode[] = ['physics', 'history']

/** 3+1+2 里的那个「2」：再选只能从这四门里取两门 */
export const SECOND_CODES: readonly SubjectCode[] = ['chemistry', 'biology', 'politics', 'geography']

/** 首选 → 它属于哪一种班型（**班型与首选绑定**，Q2） */
export const PRIMARY_CLASS_TYPE: Record<string, ClassType> = {
  physics: 'science',
  history: 'arts',
}

/** 12 种合法组合（`首选 + 再选两门` 的全部笛卡尔积）—— 由上面两组**推**出来，不是另抄一份清单 */
export const COMBINATIONS: readonly string[] = PRIMARY_CODES.flatMap((p) =>
  SECOND_CODES.flatMap((a, i) =>
    SECOND_CODES.slice(i + 1).map((b) => `${subjectName(p)}${subjectName(a)}${subjectName(b)}`),
  ),
)

/** 选科的一行（`student_subjects` 在前端这一侧的形状） */
export type StudentSubject = {
  studentId: string
  /** 首选（`physics` / `history`）；「其他」时可能是空的（连结构都不满足） */
  primaryCode: string
  /** 再选两门 */
  secondCodes: string[]
  /** `standard` = 走结构约束；`other` = 学校开不出的组合，**必须**手工选走班科目并填原因 */
  kind: 'standard' | 'other'
  /** `kind === 'other'` 时必填的原因 */
  note: string
  /** 这一行改动的时间（毫秒）；没有 = 从没写过 */
  updatedAt?: number
}

/** 学生 + 他的选科（列表里一行一个人用的形状） */
export type PickRow = {
  student: Student
  subject: StudentSubject | null
}

export function emptySubject(studentId: string): StudentSubject {
  return { studentId, primaryCode: '', secondCodes: [], kind: 'standard', note: '' }
}

/**
 * 这一行选科**合法吗**。返回 `null` = 合法；返回字符串 = 人话原因。
 *
 * 判据与 `schema.sql` §27.4 的 `student_subject_check()` **逐条同款**：
 *   ① 「其他」：再选必须恰好 2 门 + 原因必填
 *   ② 标准：首选必须是物理或历史
 *   ③ 标准：再选恰好 2 门、只能从那四门里取、两门不许相同、首选不许出现在再选里
 */
export function subjectCheck(s: {
  kind: string
  primaryCode: string
  secondCodes: string[]
  note: string
}): string | null {
  const second = s.secondCodes.filter(Boolean)
  if (s.kind !== 'standard' && s.kind !== 'other') return '选科类型认不出'

  if (s.kind === 'other') {
    if (second.length !== 2) return '「其他」必须手工选走班科目（再选恰好 2 门）'
    if (!String(s.note ?? '').trim()) return '「其他」必须填原因'
    return null
  }

  if (!PRIMARY_CODES.includes(s.primaryCode as SubjectCode)) {
    return s.primaryCode ? `首选只能是物理或历史（收到「${subjectName(s.primaryCode, s.primaryCode)}」）` : '还没有选首选'
  }
  if (second.length !== 2) return `再选必须恰好 2 门（这一行有 ${second.length} 门）`
  const bad = second.find((c) => !SECOND_CODES.includes(c as SubjectCode))
  if (bad) return `再选只能从 化学 / 生物 / 政治 / 地理 里取（收到「${subjectName(bad, bad)}」）`
  if (second[0] === second[1]) return `再选两门不许相同（${subjectName(second[0])}）`
  if (second.includes(s.primaryCode)) return `首选 ${subjectName(s.primaryCode)} 不许出现在再选里`
  return null
}

/** 这一行的组合名（`物化生` 这种）。认不出的科目原样回显 —— **不猜** */
export function combinationName(s: {
  primaryCode: string
  secondCodes: string[]
}): string {
  const parts = [s.primaryCode, ...s.secondCodes].filter(Boolean)
  return parts.map((c) => subjectName(c, c)).join('')
}

/** 合法组合清单（`物化生` 这种）；不合法返回 `null` */
export function legalCombination(s: {
  kind: string
  primaryCode: string
  secondCodes: string[]
  note: string
}): string | null {
  if (subjectCheck(s)) return null
  if (s.kind === 'other') return null
  const name = combinationName(s)
  return COMBINATIONS.includes(name) ? name : null
}

/**
 * **首选与班型不符 → 「建议转班」**（Q2：不静默放过，**也不自动改**）。
 *
 * 返回 `null` = 一致（或两边都还没定，不算"不符"）；返回字符串 = 要显示的那一句提示。
 *
 * ⚠️ 三种情形**都不算不符**，别把它们报成"建议转班"：
 *   · 班型是 `''`（还没设置）或 `'undivided'`（未分科）—— 这两档本来就允许任何首选；
 *   · 学生是「其他」（连标准结构都不满足，另有「必须手工选走班科目」那条提示）；
 *   · 学生还没选首选。
 */
export function subjectAdvice(
  classType: ClassType,
  s: { kind: string; primaryCode: string } | null,
): string | null {
  if (!s) return null
  if (s.kind !== 'standard') return null
  if (!s.primaryCode) return null
  const want = PRIMARY_CLASS_TYPE[s.primaryCode]
  if (!want) return null
  if (classType !== 'science' && classType !== 'arts') return null
  if (classType === want) return null
  return `首选是${subjectName(s.primaryCode)}，本班是${classType === 'arts' ? '文科班' : '理科班'} → 建议转班`
}

/** 班型的默认组合（`null` = 这一档没有默认，未设置与未分科都是） */
export function classTypeDefault(classType: ClassType) {
  return CLASS_TYPE_DEFAULT[classType] ?? null
}

/**
 * 这个班的种类（`classes.kind`）。**读的人一律走它**（兼容期那一处判断只有这里一份）：
 * 老库读不到这一列 → `undefined` → 等于 `'admin'`（行政班），老行为一个字节不变。
 */
export function classKindOf(k?: Pick<Klass, 'kind'> | null): ClassKind {
  return k?.kind === 'stream' ? 'stream' : 'admin'
}

/** 这个班的班型（`classes.class_type`）；认不出的值一律当"还没设置"（**不猜**） */
export function classTypeOf(k?: Pick<Klass, 'classType'> | null): ClassType {
  const t = k?.classType
  return t === 'undivided' || t === 'arts' || t === 'science' ? t : ''
}

/** 这个班是不是行政班（班型 / 建班 / 录名单只对行政班有意义） */
export function isAdminClass(k?: Pick<Klass, 'kind'> | null): boolean {
  return classKindOf(k) === 'admin'
}

/**
 * 一个班的选科完成度（界面上"采集选科"那一步的"完成没"）。
 * ⚠️ 它数的是**在册**学生（`active`）—— 转出的学生不该拖着这一步不算完成。
 */
export function classPickProgress(
  k: Pick<Klass, 'students'>,
  subjects: ReadonlyMap<string, { studentId: string }>,
) {
  const active = k.students.filter((s) => s.status === 'active')
  const done = active.filter((s) => subjects.has(s.id)).length
  return { total: active.length, done, complete: active.length > 0 && done === active.length }
}

/** 按班型算出来的默认选科（给「一键全部按班型默认」用）；没有默认返回 `null` */
export function defaultSubjectFor(classType: ClassType, studentId: string): StudentSubject | null {
  const d = classTypeDefault(classType)
  if (!d) return null
  return { studentId, primaryCode: d.primary, secondCodes: [...d.second], kind: 'standard', note: '' }
}
