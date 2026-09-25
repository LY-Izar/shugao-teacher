/* ============================================================
   考试 · 统计（纯函数）
   ------------------------------------------------------------
   与作业统计（`lib/grading.ts` 的 `gradeStats`）**不是一套**，别合并：
     · 作业统计的输入是「错题集合」（默认全对），算的是**错误率**
     · 考试统计的输入是「每人每题得分」（默认全零），算的是**得分率**
   错误率 = 1 - 得分率 只在"每题满分相同、且二元判定"时才等价，
   考试卷上分值不等（6/10/12/16），所以必须分开算。

   这里的所有函数都是纯的：吃 `Exam` + `ExamScore[]` + 学生名单，吐数字。
   页面只负责渲染 —— 这样"统计口径"只有一处，能被脚本直接断言。
   ============================================================ */

import { pointName } from './knowledge'
import { isChoiceKind, objectiveSubjective, questionCountOf, questionsOf, round2, scoreOf, totalOf } from './examPaper'
import type { Exam, ExamQuestion, ExamScore } from '../data/examTypes'

/**
 * 参与统计的名单一行。
 *
 * ⚠️ `studentNo` 是**档案键**（迁移后 = 序列号，见 `lib/keys.ts`） —— 它要和
 *    `ExamScore.studentNo`（数据库那一列的值）对得上才能 join。
 *    **`displayNo` 才是给人看的班内学号**；没给就退回 `studentNo`（兼容期）。
 */
export type ExamRosterEntry = { studentNo: string; name: string; displayNo?: string }

/* ---------------- 基础 ---------------- */

export type ExamBasics = {
  /** 应交人数（名单人数） */
  total: number
  /** 实考人数（非缺考） */
  present: number
  /** 缺考人数 */
  absent: number
  /** 还没批阅的人数 —— **他们按 0 分计**（确认完成时已经跟老师确认过） */
  ungraded: number
  avg: number
  median: number
  max: number
  min: number
  /** 标准差（总体，除以 n）—— 用来判断"这次是整体差还是两极分化" */
  std: number
  fullScore: number
  /** 客观题 / 主观题均分 */
  avgObjective: number
  avgSubjective: number
}

export function median(nums: number[]): number {
  if (!nums.length) return 0
  const a = [...nums].sort((x, y) => x - y)
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : round2((a[mid - 1] + a[mid]) / 2)
}

/** 算总分：**文件给了就用文件的**，没给才按逐题得分重算（用户口径：不覆盖文件的值） */
export function totalOfRow(e: Exam, row: ExamScore): number {
  const saved = Number(row.total)
  if (Number.isFinite(saved) && saved > 0) return round2(saved)
  return totalOf(e, row)
}

export function basicsOf(e: Exam, rows: readonly ExamScore[]): ExamBasics {
  const fullScore = questionsOf(e).reduce((n, q) => n + (Number(q.fullScore) || 0), 0)
  const present = rows.filter((r) => !r.absent)
  const totals = present.map((r) => totalOfRow(e, r))
  const avg = totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : 0
  const variance = totals.length
    ? totals.reduce((a, b) => a + (b - avg) ** 2, 0) / totals.length
    : 0
  const obj = present.map((r) => objectiveSubjective(e, r).objective)
  const sub = present.map((r) => objectiveSubjective(e, r).subjective)
  const mean = (a: number[]) => (a.length ? round2(a.reduce((x, y) => x + y, 0) / a.length) : 0)
  return {
    total: rows.length,
    present: present.length,
    absent: rows.filter((r) => r.absent).length,
    ungraded: rows.filter((r) => !r.graded && !r.absent).length,
    avg,
    median: median(totals),
    max: totals.length ? Math.max(...totals) : 0,
    min: totals.length ? Math.min(...totals) : 0,
    std: round2(Math.sqrt(variance)),
    fullScore,
    avgObjective: mean(obj),
    avgSubjective: mean(sub),
  }
}

/* ---------------- 逐题 ---------------- */

export type QuestionStat = {
  no: number
  kind: ExamQuestion['kind']
  fullScore: number
  /** 实考人数（分母） */
  present: number
  /** 满分人数 */
  fullCount: number
  /** 零分人数 */
  zeroCount: number
  /** 平均得分 */
  avg: number
  /** 得分率 = 平均得分 ÷ 满分（满分 0 时为 undefined —— 宁可不给，也不给一个错的数） */
  rate?: number
  /**
   * 难度系数 P = 得分率（教育测量学的通行定义：越大越容易）。
   * 与 `rate` 同值，单独列出来是因为页面上"难度"和"得分率"要分开展示、口径要写清。
   */
  difficulty?: number
  /**
   * 区分度 D：把总分排序后取**高分组(27%)**与**低分组(27%)**，
   * D = 高分组该题得分率 − 低分组该题得分率。
   *   · D ≥ 0.4 很好 · 0.3–0.39 良好 · 0.2–0.29 尚可 · < 0.2 需改进
   * 班级人数太少（< 8 人）时返回 undefined —— 小样本上这个指标没有意义，
   * 与其给一个会误导人的数，不如不给。
   */
  discrimination?: number
  /** 选项分布（只有选择题有）：选项 → 人数 */
  choices?: Array<{ option: string; count: number; correct: boolean; names: string[] }>
}

/** 高/低分组的取法：27% 是教育测量学的惯例；人少时至少各 3 人 */
function extremeGroups(totals: Array<{ no: string; total: number }>) {
  const sorted = [...totals].sort((a, b) => b.total - a.total)
  const cut = Math.max(3, Math.round(sorted.length * 0.27))
  // 人太少时高分组与低分组会重叠 —— 那就没有区分度可言
  if (sorted.length < cut * 2) return null
  return {
    high: new Set(sorted.slice(0, cut).map((x) => x.no)),
    low: new Set(sorted.slice(-cut).map((x) => x.no)),
  }
}

export function questionStats(e: Exam, rows: readonly ExamScore[]): QuestionStat[] {
  const present = rows.filter((r) => !r.absent)
  const totals = present.map((r) => ({ no: r.studentNo, total: totalOfRow(e, r) }))
  const groups = extremeGroups(totals)
  const nameOf = new Map(rows.map((r) => [r.studentNo, r.name]))

  return questionsOf(e).map((q) => {
    const scores = present.map((r) => scoreOf(q, e.mode, r))
    const full = Number(q.fullScore) || 0
    const avg = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    const rate = full > 0 ? round2(avg / full) : undefined

    let discrimination: number | undefined
    if (groups) {
      const rateIn = (set: Set<string>) => {
        const list = present.filter((r) => set.has(r.studentNo))
        if (!list.length || full <= 0) return 0
        return list.reduce((n, r) => n + scoreOf(q, e.mode, r), 0) / list.length / full
      }
      discrimination = round2(rateIn(groups.high) - rateIn(groups.low))
    }

    /* 选择题：选项分布 —— 与文件里的"选项分布"sheet 是同一件事，本地也能算出来 */
    let choices: QuestionStat['choices']
    if (isChoiceKind(q.kind)) {
      const answer = (q.answer ?? '').toUpperCase()
      const count = new Map<string, string[]>()
      for (const r of present) {
        // 记分值模式下没有答案数据 —— 那就没有选项分布（不编一个出来）
        const picked = String(r.answers?.[String(q.no)] ?? '')
          .toUpperCase()
          .replace(/[^A-H]/g, '')
        if (!picked) continue
        const list = count.get(picked) ?? []
        list.push(nameOf.get(r.studentNo) ?? r.studentNo)
        count.set(picked, list)
      }
      choices = [...count.entries()]
        .map(([option, names]) => ({
          option,
          count: names.length,
          correct: option === answer,
          names: names.sort(),
        }))
        .sort((a, b) => b.count - a.count || a.option.localeCompare(b.option))
      if (!choices.length) choices = undefined
    }

    return {
      no: q.no,
      kind: q.kind,
      fullScore: full,
      present: present.length,
      fullCount: scores.filter((s) => full > 0 && s >= full).length,
      zeroCount: scores.filter((s) => s <= 0).length,
      avg,
      rate,
      difficulty: rate,
      discrimination,
      choices,
    }
  })
}

/* ---------------- 分数段 ---------------- */

export type BandStat = { label: string; from: number; to: number; count: number; rate: number }

/**
 * 分数段分布。
 *
 * 分档按**卷面总分的百分比**算，不是固定分数 —— 100 分卷与 60 分卷都要能用。
 * 默认六档：<60% / 60–70% / 70–80% / 80–90% / 90–100% / 满分。
 * 最后一档单独列"满分"，因为老师最关心的就是"几个满分"。
 */
export function bandStats(e: Exam, rows: readonly ExamScore[]): BandStat[] {
  const present = rows.filter((r) => !r.absent)
  const full = questionsOf(e).reduce((n, q) => n + (Number(q.fullScore) || 0), 0)
  const edges: Array<[string, number, number]> = [
    ['不及格（<60%）', 0, 0.6],
    ['60–70%', 0.6, 0.7],
    ['70–80%', 0.7, 0.8],
    ['80–90%', 0.8, 0.9],
    ['90–100%', 0.9, 1],
  ]
  const out: BandStat[] = edges.map(([label, a, b]) => ({
    label,
    from: round2(full * a),
    to: round2(full * b),
    count: 0,
    rate: 0,
  }))
  out.push({ label: '满分', from: full, to: full, count: 0, rate: 0 })

  const n = present.length || 1
  for (const r of present) {
    const t = totalOfRow(e, r)
    if (full > 0 && t >= full) {
      out[out.length - 1].count++
      continue
    }
    const ratio = full > 0 ? t / full : 0
    const i = ratio < 0.6 ? 0 : ratio < 0.7 ? 1 : ratio < 0.8 ? 2 : ratio < 0.9 ? 3 : 4
    out[i].count++
  }
  for (const b of out) b.rate = round2(b.count / n)
  return out
}

/* ---------------- 知识点 ---------------- */

export type PointStat = {
  id: string
  name: string
  /** 这一考点在卷面上占多少分 */
  fullScore: number
  /** 全班平均得分 */
  avg: number
  /** 得分率 —— 「知识点得分率」就是它（用户列的 ① 号新指标） */
  rate: number
  /** 覆盖的题号 */
  nos: number[]
  /** 这题是不是只有一题覆盖（知识点挂得少的题，结论要谨慎） */
  questions: number
}

/**
 * 按知识点聚合的得分率。
 *
 * 一道题可以挂多个知识点（`data/knowledge/` 打标最多挂 MAX_POINTS 个），
 * 这时**该题分值在每个知识点上都计一次** —— 于是"各知识点满分之和 ≥ 卷面总分"。
 * 这是刻意的：知识点视角回答的是"这个点在卷子上值多少分"，
 * 不是"这些点怎么瓜分卷面分"（瓜分要猜权重，猜出来的一定是错的）。
 * 界面上会显示"覆盖 N 题"，提醒老师这一条的样本量。
 */
export function pointStats(e: Exam, rows: readonly ExamScore[]): PointStat[] {
  const present = rows.filter((r) => !r.absent)
  const acc = new Map<string, PointStat>()
  for (const q of questionsOf(e)) {
    for (const id of q.points ?? []) {
      const cur = acc.get(id) ?? {
        id,
        name: pointName(id) ?? '未归类',
        fullScore: 0,
        avg: 0,
        rate: 0,
        nos: [],
        questions: 0,
      }
      cur.fullScore += Number(q.fullScore) || 0
      cur.nos.push(q.no)
      cur.questions += 1
      acc.set(id, cur)
    }
  }
  for (const st of acc.values()) {
    let sum = 0
    for (const no of st.nos) {
      const q = questionsOf(e).find((x) => x.no === no)
      if (!q) continue
      for (const r of present) sum += scoreOf(q, e.mode, r)
    }
    const denom = st.fullScore * present.length
    st.avg = present.length ? round2(sum / present.length) : 0
    st.rate = denom > 0 ? round2(sum / denom) : 0
  }
  return [...acc.values()].sort((a, b) => a.rate - b.rate || b.fullScore - a.fullScore)
}

/* ---------------- 个人诊断 ---------------- */

export type StudentDiagnosis = {
  /** **档案键**（迁移后 = 序列号）；界面上要显示的话用它对应的 `displayNo` */
  studentNo: string
  /** 给人看的**班内学号**（兼容期就是 `studentNo` 本身） */
  displayNo: string
  name: string
  total: number
  /** 与班级均分之差（正数 = 高于均分） */
  diffFromAvg: number
  /** 班级排名（按总分，同分并列） */
  classRank: number
  /** 年级排名（只在年级考试、且有别的班数据时给） */
  gradeRank?: number
  /** 该生得分率明显偏低的题号（低于他这个总分水平应有的表现） */
  weakNos: number[]
  /** 反复丢分的知识点（用户列的 ④ 号新指标）；`lost` = 该点上的丢分 */
  weakPoints: Array<{ id: string; name: string; rate: number; lost: number }>
  /** 满分题号 */
  perfectNos: number[]
  absent: boolean
  /** 还没批阅（按 0 分计） */
  ungraded: boolean
}

/** 排名（同分并列，返回 学号 → 名次） */
export function rankOf(items: Array<{ studentNo: string; total: number }>): Map<string, number> {
  const sorted = [...items].sort((a, b) => b.total - a.total)
  const out = new Map<string, number>()
  let last: number | null = null
  let lastRank = 0
  sorted.forEach((it, i) => {
    const rank = last !== null && it.total === last ? lastRank : i + 1
    out.set(it.studentNo, rank)
    last = it.total
    lastRank = rank
  })
  return out
}

function weakPointsOf(
  e: Exam,
  row: ExamScore,
  classRate: Map<string, number>,
): Array<{ id: string; name: string; rate: number; lost: number }> {
  const out: Array<{ id: string; name: string; rate: number; lost: number }> = []
  const acc = new Map<string, { full: number; got: number }>()
  for (const q of questionsOf(e)) {
    for (const id of q.points ?? []) {
      const cur = acc.get(id) ?? { full: 0, got: 0 }
      cur.full += Number(q.fullScore) || 0
      cur.got += scoreOf(q, e.mode, row)
      acc.set(id, cur)
    }
  }
  for (const [id, v] of acc) {
    if (v.full <= 0) continue
    const rate = round2(v.got / v.full)
    const cls = classRate.get(id)
    // 丢分 且 明显低于班级水平（差 15 个百分点以上）才算"反复丢分的点"
    if (rate < 0.85 && (cls === undefined || rate < cls - 0.15)) {
      out.push({ id, name: pointName(id) ?? '未归类', rate, lost: round2(v.full - v.got) })
    }
  }
  return out.sort((a, b) => b.lost - a.lost).slice(0, 6)
}

/**
 * 个人诊断。
 *
 * 这里**不做"反复丢分"的跨考试统计** —— 那是趋势页（`trendOf`）的事。
 * 本函数只看这一次考试：与均分之差、班级排名、薄弱知识点、满分题。
 */
export function diagnose(
  e: Exam,
  rows: readonly ExamScore[],
  roster: readonly ExamRosterEntry[],
  gradeRows?: readonly ExamScore[],
): StudentDiagnosis[] {
  const present = rows.filter((r) => !r.absent)
  const totals = present.map((r) => ({ studentNo: r.studentNo, total: totalOfRow(e, r) }))
  const rank = rankOf(totals)
  const avg = totals.length ? round2(totals.reduce((n, x) => n + x.total, 0) / totals.length) : 0
  const gradeRank = gradeRows?.length ? rankOf(gradeRows.map((r) => ({ studentNo: r.studentNo, total: totalOfRow(e, r) }))) : null

  const pts = pointStats(e, rows)
  const classRate = new Map(pts.map((p) => [p.id, p.rate]))

  return roster.map(({ studentNo, name, displayNo }) => {
    const row = rows.find((r) => r.studentNo === studentNo)
    const absent = row?.absent === true
    const ungraded = !row || (!row.graded && !absent)
    const total = !row || absent ? 0 : totalOfRow(e, row)
    const qs = questionsOf(e)
    const weakNos: number[] = []
    const perfectNos: number[] = []
    for (const q of qs) {
      const full = Number(q.fullScore) || 0
      if (full <= 0) continue
      const s = row ? scoreOf(q, e.mode, row) : 0
      if (s >= full) perfectNos.push(q.no)
      // 得分率低于 60% 的题算薄弱题（不按绝对分数，各题满分不一样）
      else if (s / full < 0.6) weakNos.push(q.no)
    }
    return {
      studentNo,
      displayNo: displayNo ?? studentNo,
      name: row?.name || name,
      total,
      diffFromAvg: round2(total - avg),
      classRank: rank.get(studentNo) ?? 0,
      /*
       * 🔴 名次**优先用文件给的**（用户口径：文件里有就按文件的，不要覆盖）。
       *    只有文件没给时才用本地算出来的 —— 本地算的口径是"这次考试参与排名的这些人"，
       *    而新教育导出的年级排名是**全年级**口径，两者本来就可能不一样。
       */
      gradeRank: row?.gradeRank ?? gradeRank?.get(studentNo),
      weakNos,
      weakPoints: row && !absent ? weakPointsOf(e, row, classRate) : [],
      perfectNos,
      absent,
      ungraded,
    }
  })
}

/* ---------------- 趋势 ---------------- */

export type TrendPoint = {
  examId: string
  title: string
  examDate: string
  /** 这次考试的统计人数 */
  count: number
  avg: number
  fullScore: number
  /** 平均得分率（跨卷可比：100 分卷与 60 分卷放在一起也不失真） */
  rate: number
  median: number
  max: number
}

/**
 * 近几次考试趋势（用户列的 ③ 号新指标）。
 *
 * ⚠️ **比的是"得分率"而不是"平均分"**：上一次 100 分卷、这一次 60 分卷，
 *    平均分从 62 掉到 48 不代表退步。界面上两个数都显示，但趋势图连的是得分率。
 *
 * 输入是**已经按同场考试归并好的一串考试**（同一份卷子在不同班的档案会各算一条），
 * 由调用方决定要不要合并 —— 这里只负责算，不做归并（归并口径在页面里更清楚）。
 */
export function trendOf(
  items: Array<{ exam: Exam; rows: readonly ExamScore[]; label: string }>,
): TrendPoint[] {
  return items
    .map(({ exam, rows, label }) => {
      const b = basicsOf(exam, rows)
      return {
        examId: exam.id,
        title: label,
        examDate: exam.examDate,
        count: b.present,
        avg: b.avg,
        fullScore: b.fullScore,
        rate: b.fullScore > 0 ? round2(b.avg / b.fullScore) : 0,
        median: b.median,
        max: b.max,
      }
    })
    .sort((a, b) => (a.examDate < b.examDate ? 1 : a.examDate > b.examDate ? -1 : 0))
}

/** 某个学生在若干次考试里的得分率（个人趋势） */
export function studentTrendOf(
  items: Array<{ exam: Exam; rows: readonly ExamScore[]; label: string }>,
  studentNo: string,
): Array<{ label: string; examDate: string; total: number; fullScore: number; rate: number }> {
  return items
    .map(({ exam, rows, label }) => {
      const row = rows.find((r) => r.studentNo === studentNo)
      const full = questionsOf(exam).reduce((n, q) => n + (Number(q.fullScore) || 0), 0)
      const total = row && !row.absent ? totalOfRow(exam, row) : 0
      return {
        label,
        examDate: exam.examDate,
        total,
        fullScore: full,
        rate: full > 0 ? round2(total / full) : 0,
      }
    })
    .sort((a, b) => (a.examDate < b.examDate ? -1 : 1))
}

/* ---------------- 缺考 / 未交 ---------------- */

export type MissingEntry = {
  /** **档案键**（迁移后 = 序列号） */
  studentNo: string
  /** 给人看的**班内学号** */
  displayNo: string
  name: string
  why: 'absent' | 'ungraded'
}

/**
 * 缺考 / 未批改名单（用户列的 ⑥ 号新指标）。
 *
 * 为什么必须单独列出来：新教育导出的文件里写着「已交 37，未交 1」，
 * 但**学生表里根本没有那第 38 个人**（他只出现在汇总行里）。
 * 不做这一步，那个孩子就从统计里彻底消失了 —— 而"谁没考"恰恰是老师要找的人。
 *
 * `why` 的两种取值**不能合并**：
 *   · `absent`   人没来（不参与均分）
 *   · `ungraded` 卷子还没录（**按 0 分参与均分**）
 */
export function missingList(
  rows: readonly ExamScore[],
  roster: readonly ExamRosterEntry[],
): MissingEntry[] {
  const out: MissingEntry[] = []
  for (const { studentNo, name, displayNo } of roster) {
    const shown = displayNo ?? studentNo
    const row = rows.find((r) => r.studentNo === studentNo)
    if (row?.absent) out.push({ studentNo, displayNo: shown, name: row.name || name, why: 'absent' })
    else if (!row || !row.graded) {
      out.push({ studentNo, displayNo: shown, name: row?.name || name, why: 'ungraded' })
    }
  }
  return out
}

/* ---------------- 一个总入口（页面只调它） ---------------- */

export type ExamReport = {
  basics: ExamBasics
  questions: QuestionStat[]
  bands: BandStat[]
  points: PointStat[]
  students: StudentDiagnosis[]
  missing: MissingEntry[]
  /** 题量（读 `questionCount`，不再各处数一遍） */
  count: number
}

export function examReport(
  e: Exam,
  rows: readonly ExamScore[],
  roster: readonly ExamRosterEntry[],
  gradeRows?: readonly ExamScore[],
): ExamReport {
  return {
    basics: basicsOf(e, rows),
    questions: questionStats(e, rows),
    bands: bandStats(e, rows),
    points: pointStats(e, rows),
    students: diagnose(e, rows, roster, gradeRows),
    missing: missingList(rows, roster),
    count: questionCountOf(e),
  }
}
