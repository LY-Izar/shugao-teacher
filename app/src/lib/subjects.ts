/* ============================================================
   学科字典 —— **全仓唯一来源**
   ------------------------------------------------------------
   为什么要有这个文件：这个平台原本是「物理专用」的，界面上写死过 27 处「物理」。
   多学科化的第一步就是把「学科」变成一个**规范化的维度**：
     · `code` 是短英文稳定标识（进数据库、进 URL、做判据用的就是它）
     · `name` 是对外显示名（中文）
   两者**不是同一个值域**，任何时候都不要拿显示名当判据、也不要拿 code 当文案。

   ⚠️ 十五条学科代码必须与 `supabase/schema.sql` 第 12 段 `subjects` 字典表一致。
     数据库那份是权威（将来由学校自己加行），这份是前端离线可用的镜像：
     前端读不到数据库字典时（比如线上库还没跑那一段 SQL）照样要能用。
     两边**只有这一处**对应关系，别的文件不许再写一份数组。

   ⚠️ 这里**不写任何界面逻辑**：谁能走班、显示几个字，都是字典里的数据
     （`canStream` / `short`），不是代码里的 if。
   ============================================================ */

import type { Teacher } from '../data/types'

export type SubjectCode =
  | 'chinese'
  | 'math'
  | 'english'
  | 'physics'
  | 'chemistry'
  | 'biology'
  | 'politics'
  | 'history'
  | 'geography'
  | 'it'
  | 'general_tech'
  | 'pe'
  | 'music'
  | 'art'
  | 'mental_health'

export type Subject = {
  code: SubjectCode
  name: string
  /** 两个字的短名，手机上用 */
  short: string
  /**
   * 走班候选。**只是字典里的一条数据** ——
   * 界面入口是否打开由它决定，代码里不写 `if (subject === '生物')`。
   */
  canStream: boolean
  sort: number
}

/** 学科字典（15 科：用户给的 14 科 + 物理本身）。顺序就是界面上的显示顺序 */
export const SUBJECTS: readonly Subject[] = [
  { code: 'chinese', name: '语文', short: '语', canStream: false, sort: 1 },
  { code: 'math', name: '数学', short: '数', canStream: false, sort: 2 },
  { code: 'english', name: '英语', short: '英', canStream: false, sort: 3 },
  { code: 'physics', name: '物理', short: '物', canStream: false, sort: 4 },
  { code: 'chemistry', name: '化学', short: '化', canStream: false, sort: 5 },
  { code: 'biology', name: '生物', short: '生', canStream: true, sort: 6 },
  { code: 'politics', name: '政治', short: '政', canStream: true, sort: 7 },
  { code: 'history', name: '历史', short: '史', canStream: false, sort: 8 },
  { code: 'geography', name: '地理', short: '地', canStream: true, sort: 9 },
  { code: 'it', name: '信息技术', short: '信', canStream: false, sort: 10 },
  { code: 'general_tech', name: '通用技术', short: '通', canStream: false, sort: 11 },
  { code: 'pe', name: '体育', short: '体', canStream: false, sort: 12 },
  { code: 'music', name: '音乐', short: '音', canStream: false, sort: 13 },
  { code: 'art', name: '美术', short: '美', canStream: false, sort: 14 },
  { code: 'mental_health', name: '心理健康', short: '心', canStream: false, sort: 15 },
]

/**
 * 兜底的学科。
 *
 * ⚠️ 它只用来保证「**永远有值**」：新建作业时学科必须已经预选好，
 * 绝不能让老师每次布置作业都去选一次（反指标：每次作业新增手工录入字段数 = 0）。
 * 不要把它当成"默认大家都是物理"的业务假设 —— 老师的主学科由
 * `teachers.primary_subject_code` 决定，这里只是最后一层兜底。
 */
export const DEFAULT_SUBJECT_CODE: SubjectCode = 'physics'

const BY_CODE = new Map<string, Subject>(SUBJECTS.map((s) => [s.code, s]))
const BY_NAME = new Map<string, Subject>(SUBJECTS.map((s) => [s.name, s]))

/** 是不是字典里的学科代码 */
export function isSubjectCode(v: unknown): v is SubjectCode {
  return typeof v === 'string' && BY_CODE.has(v)
}

/**
 * 归一化任意输入 → 合法 code；认不出来返回 `undefined`。
 *
 * 🔴 **认不出来时绝不猜**：不按前缀匹配、不按包含关系匹配。
 *    猜错学科会写进不可逆的历史数据（`assignments.subject_code`），
 *    而 schema 的回填纪律是「只回填能确证的，剩下的留 null 并报出来」。
 */
export function asSubjectCode(v?: string | null): SubjectCode | undefined {
  const s = String(v ?? '').trim()
  return isSubjectCode(s) ? s : undefined
}

/**
 * 中文显示名 → code。**兼容期读旧列用的**（`assignments.subject` / `teachers.subject`）。
 * 只做去空白后的精确匹配；`''` 与字典外的名字一律返回 `undefined`。
 */
export function subjectCodeOfName(name?: string | null): SubjectCode | undefined {
  const s = String(name ?? '').trim()
  return s ? BY_NAME.get(s)?.code : undefined
}

/** code → 显示名。认不出来时返回 `fallback`（默认空串） */
export function subjectName(code?: string | null, fallback = ''): string {
  const s = asSubjectCode(code)
  return s ? (BY_CODE.get(s)?.name ?? fallback) : fallback
}

/** code → 两个字短名。认不出来时返回 `fallback` */
export function subjectShort(code?: string | null, fallback = ''): string {
  const s = asSubjectCode(code)
  return s ? (BY_CODE.get(s)?.short ?? fallback) : fallback
}

/** 这一科能不能走班（走班候选写得是字典里的数据） */
export function canStream(code?: string | null): boolean {
  const s = asSubjectCode(code)
  return s ? (BY_CODE.get(s)?.canStream ?? false) : false
}

/** `{ subjectCode?, subject? }` 这个形状的兼容读取：有 code 用 code，没有就按显示名反查 */
export function subjectCodeOf(rec?: { subjectCode?: string; subject?: string } | null): SubjectCode | undefined {
  if (!rec) return undefined
  return asSubjectCode(rec.subjectCode) ?? subjectCodeOfName(rec.subject)
}

/**
 * **作业档案**：把 `{ subjectCode, subject }` 成对对齐 —— `subject` 永远是 code 在字典里的显示名。
 *
 * 什么时候用它：任何**外部数据落地**的入口（恢复备份）或写入路径要守 I13 的时候。
 * 认不出学科时**原样返回**（`asSubjectCode` 只精确匹配，绝不猜，见 I14）。
 *
 * ⚠️ 它**只负责对齐**，不负责补结构（那是 `lib/backup.ts` 的 `normalizeAssignment` 的事）。
 *    实现只此一份：这一轮"恢复备份丢 `subjectCode`"的 bug 就是某条写入路径漏了归一化，
 *    所以别再就地手写一份 `asSubjectCode(x) ?? subjectCodeOfName(y)` —— 抄第二份就是第二个判定入口。
 */
export function alignAssignmentSubject<T extends { subjectCode?: string; subject?: string }>(a: T): T {
  const code = asSubjectCode(a.subjectCode) ?? subjectCodeOfName(a.subject)
  return code ? { ...a, subjectCode: code, subject: subjectName(code) } : a
}

/**
 * **老师**：只补齐 `primarySubjectCode`，显示名一个字都不动。
 *
 * 与上面那个**故意不同**：`Assignment.subject` 是 code 的显示缓存（必须跟着 code 走），
 * 而 `Teacher.subject` 是**自由显示标签**（老师可以写「物理竞赛」，见 §12.2）——
 * 拿 `subjectName(code)` 去覆盖它 = 把老师自己写的名字抹掉。
 */
export function alignTeacherPrimarySubject<T extends { primarySubjectCode?: string; subject?: string }>(
  t: T,
): T {
  const code = asSubjectCode(t.primarySubjectCode) ?? subjectCodeOfName(t.subject)
  return code && code !== t.primarySubjectCode ? { ...t, primarySubjectCode: code } : t
}

/**
 * 老师的主学科。
 *
 * 取值顺序（**永远有值**，所以新建作业不需要老师做任何额外操作）：
 *   ① `primarySubjectCode`（设置页显式选过的主学科）
 *   ② 按显示名 `subject` 反查（兼容期：线上库还没有 `primary_subject_code` 这一列时走这里）
 *   ③ 字典兜底
 *
 * ⚠️ ② 是**读兼容**，不是"猜老师的学科"：`subject` 是老师自己在设置页填的，
 *    这里只是把它翻译成规范代码。翻译不出来（比如填了「高中语文」）时落到 ③，
 *    老师去设置页选一次主学科就正了 —— 不做模糊匹配，猜错比空着更糟。
 */
export function teacherPrimarySubjectCode(t?: Pick<Teacher, 'subject' | 'primarySubjectCode'> | null): SubjectCode {
  return (
    asSubjectCode(t?.primarySubjectCode) ??
    subjectCodeOfName(t?.subject) ??
    DEFAULT_SUBJECT_CODE
  )
}

/**
 * 顶部/设置页那个学科标签显示什么。
 * 老师自己写的显示名优先（可能写了「物理竞赛」这种），没有才用主学科的名字。
 */
export function teacherSubjectLabel(
  t?: Pick<Teacher, 'subject' | 'primarySubjectCode'> | null,
  fallback = '老师',
): string {
  const s = String(t?.subject ?? '').trim()
  return s || subjectName(teacherPrimarySubjectCode(t), fallback)
}

/**
 * 呼叫默认地点：按学科算 —— 「物理老师办公室」/「语文老师办公室」。
 *
 * 以前这里是一个写死的常量 `DEFAULT_ROOM = '物理老师办公室'`，
 * 语文老师发呼叫时默认地点是物理办公室（而且会被真正的播报念出来）。
 */
export function roomOf(subject?: string | null): string {
  // 兼容「物理老师」这种已经带了后缀的写法，别拼成「物理老师老师办公室」
  const s = String(subject ?? '').trim().replace(/老师$/, '')
  return s ? `${s}老师办公室` : '老师办公室'
}
