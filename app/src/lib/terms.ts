/* ============================================================
   学年 / 学期（`schema.sql` §28，P3）—— 前端这一侧的**推导**与**筛选口径**
   ------------------------------------------------------------
   三条纪律（都别改）：

    ① 🔴 **"当前学期"是一个推导值，不落列**。
       `terms` 里**没有** `is_current` —— 按北京时间推：
       今天落在哪个学期的区间里，哪个就是当前学期。
       存一份"当前"就有两个真相（跨过 2 月 1 日那一夜，库里那个值就悄悄错了，
       而且**不报错**）。时间口径一律 `beijingNow()`（项目硬约束）。

    ② 🔴 **筛选判据是三态：`''` 空串 = "数据库还没跑 §28"，不是"没有学期"**。
       这一条是"列表默认只看本学期"唯一的安全阀：
         · `undefined`（读不到这一列）→ **算"能看见"**
         · `null`（列在、这个档案没归属）→ **算"能看见"**（宁可多看见，绝不静默藏）
         · 只有"确实属于**另一个**学期"才被默认筛掉
       不这么写就会踩 P2 那个失败模式：SQL 还没跑 / 回填写漏一行 →
       **档案从列表里消失，而且不报任何错**（`选科走班实施计划.md` 的 P2 开场）。

    ③ **档案的学期归属按日期推**（`assign_date` / `exam_date` 落在哪个学期）——
       与 `schema.sql` §28.8 的 SQL 回填**同一条口径**，两处不许各算各的。
   ============================================================ */

import { beijingNow, ymdOf } from './holiday'

/** 一个学期（`terms` 一行 + 它所属学年的名字） */
export type Term = {
  id: string
  /** 所属学年名，如 `2026-2027` */
  yearName: string
  yearStart: string
  yearEnd: string
  /** 1 = 上半期，2 = 下半期 */
  half: 1 | 2
  startDate: string
  endDate: string
}

/** 半期的人话（**只此一处**，界面与筛选都读它） */
export function halfText(half: 1 | 2): string {
  return half === 1 ? '上半期' : '下半期'
}

/** 学期的显示名：「2026-2027 上半期」 */
export function termText(t: Term): string {
  return `${t.yearName} ${halfText(t.half)}`
}

/** 学期的短显示名（筛选下拉框里用）：「2026-2027 上」 */
export function termShortText(t: Term): string {
  return `${t.yearName} ${t.half === 1 ? '上' : '下'}`
}

/**
 * 日期落在哪个学期里 —— 认不出返回 `null`（**绝不"就近归到某一学期"**，I14）。
 * `date` 用 `YYYY-MM-DD` 的字面比较（ISO 日期串的字典序 = 时间序）。
 */
export function termOfDate(terms: readonly Term[], date: string): string | null {
  if (!date) return null
  const hit = terms.find((t) => date >= t.startDate && date <= t.endDate)
  return hit ? hit.id : null
}

/**
 * 当前学期（北京时间今天落在的那个）。
 * 传 `now` 只是为了**测试能拨假时钟**；生产一律默认 `beijingNow()`。
 */
export function currentTermId(terms: readonly Term[], now: Date = beijingNow()): string | null {
  return termOfDate(terms, ymdOf(now))
}

/** 按时间正序排（一份学年表读下来就是乱的 —— 排序口径只此一处） */
export function sortTerms(terms: readonly Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) ||
      (a.half < b.half ? -1 : 1),
  )
}

/* ---------------- 筛选（列表默认只显示本学期） ---------------- */

/**
 * 学期筛选的取值：
 *  · `'all'`      全部（含没归属的）
 *  · `'current'`  **默认** —— 只看当前学期；认不出当前学期时**退化成"全部"**
 *  · `'none'`     只看没归到任何学期的（排查"回填没跑到"用）
 *  · 学期 id      某一段
 */
export type TermFilterValue = string
export const TERM_FILTER_ALL = 'all'
export const TERM_FILTER_CURRENT = 'current'
export const TERM_FILTER_NONE = 'none'

/**
 * 一条档案在某个筛选下**该不该显示**。
 *
 * 🔴 `termId` 的三种取值的语义（见文件头 ②）：
 *  · `undefined` —— 这一列读不到（老库 / SQL 没跑）→ **显示**
 *  · `null`      —— 没归属 → 「全部」与「本学期」都**显示**，只有「没有学期」之外不显示
 *  · 字符串      —— 有归属，按判据比
 */
export function termMatches(
  termId: string | null | undefined,
  filter: TermFilterValue,
  current: string | null,
  terms: readonly Term[],
): boolean {
  if (filter === TERM_FILTER_ALL) return true
  if (filter === TERM_FILTER_NONE) return termId === null
  if (filter === TERM_FILTER_CURRENT) {
    // 当前学期认不出来（库还没跑 §28 / 今天不在任何学期区间里）→ **不筛**，
    // 否则整页档案一起消失，而用户完全不知道为什么。
    if (!current) return true
    if (termId === undefined || termId === null) return true
    return termId === current
  }
  // 指定学期：没有归属的**仍然显示**（它们本来就没有学期，藏起来等于丢数据）
  const known = terms.some((t) => t.id === filter)
  if (!known) return true
  if (termId === undefined || termId === null) return true
  return termId === filter
}

/** 「这个是别的学期的」——列表上要能看出来，别让人以为档案跑错了地方 */
export function isOtherTerm(
  termId: string | null | undefined,
  current: string | null,
): boolean {
  if (!current || typeof termId !== 'string') return false
  return termId !== current
}

/**
 * 一枚学期标签的文字：认得出就写「2025-2026 下」，认不出（那一行学期被删了 /
 * 还没读回来）就写「以前学期」—— **绝不写空**（空的标签在界面上等于没有）。
 */
export function termLabelOf(termId: string | null | undefined, terms: readonly Term[]): string {
  const hit = terms.find((t) => t.id === termId)
  return hit ? termShortText(hit) : '以前学期'
}

/** 筛选下拉框的选项（**只列数据里真出现过 / 真存在的学期**，不摆空选项） */
export type TermFilterOption = { value: TermFilterValue; label: string }

export function termFilterOptions(
  terms: readonly Term[],
  current: string | null,
): TermFilterOption[] {
  const opts: TermFilterOption[] = [{ value: TERM_FILTER_CURRENT, label: '本学期' }]
  opts.push({ value: TERM_FILTER_ALL, label: '全部学期' })
  for (const t of sortTerms(terms)) {
    opts.push({ value: t.id, label: termShortText(t) + (t.id === current ? '（当前）' : '') })
  }
  opts.push({ value: TERM_FILTER_NONE, label: '没有学期' })
  return opts
}

/* ---------------- 教导处录入（写入口是服务端 RPC） ---------------- */

/** 一个学年 + 上下半期（`写 4 个日期` 就是这一页的全部录入面） */
export type AcademicYearDraft = {
  name: string
  yearStart: string
  yearEnd: string
  half1Start: string
  half1End: string
  half2Start: string
  half2End: string
}

/** 这一份录入**能不能提交**；不能就报出第一句人话（校验只有这一处） */
export function academicYearCheck(d: AcademicYearDraft): string | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (!/^\d{4}-\d{4}$/.test(d.name.trim())) return '学年名写成 2026-2027 这样'
  const pairs: Array<[string, string, string]> = [
    ['学年', d.yearStart, d.yearEnd],
    ['上半期', d.half1Start, d.half1End],
    ['下半期', d.half2Start, d.half2End],
  ]
  for (const [label, s, e] of pairs) {
    if (!iso.test(s) || !iso.test(e)) return `${label}的起止日期都要填`
    if (e < s) return `${label}的结束日期早于开始日期`
  }
  if (d.half2Start < d.half1End) return '下半期的开始日期早于上半期结束 —— 两个半期不许重叠'
  return null
}
