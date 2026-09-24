import type { Assignment, QuestionKind, Student } from '../data/types'
import { parseQKey, qKey } from '../data/types'

/* ============================================================
   批改录入的纯函数
   核心约定：二元判定（对/错），默认全对，只记错的（「只记例外」）
   ============================================================ */

/** 该题是否有错：无小题看自身，有小题看任一小题 */
export function isQuestionWrong(wrong: string[] | undefined, seq: number, subCount = 0): boolean {
  if (!wrong || wrong.length === 0) return false
  if (subCount > 0) {
    for (let i = 1; i <= subCount; i++) if (wrong.includes(qKey(seq, i))) return true
    return false
  }
  return wrong.includes(qKey(seq))
}

export function isSubWrong(wrong: string[] | undefined, seq: number, sub: number): boolean {
  return !!wrong?.includes(qKey(seq, sub))
}

/** 点一下整题：全对 → 全错；只要有一处错 → 变全对 */
export function toggleQuestion(
  wrong: string[] | undefined,
  seq: number,
  subCount = 0,
): string[] {
  const cur = wrong ?? []
  const nowWrong = isQuestionWrong(cur, seq, subCount)
  const keys =
    subCount > 0
      ? Array.from({ length: subCount }, (_, i) => qKey(seq, i + 1))
      : [qKey(seq)]
  return nowWrong ? cur.filter((k) => !keys.includes(k)) : [...new Set([...cur, ...keys])]
}

/** 点一下某个小题，只影响它自己 */
export function toggleSub(wrong: string[] | undefined, seq: number, sub: number): string[] {
  const cur = wrong ?? []
  const k = qKey(seq, sub)
  return cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
}

/** 改变某题小题数的结果 —— 顺带说清动了谁的哪条记录，界面才好如实告知 */
export type SubImpact = {
  /** 归一化后的错题记录 */
  next: Assignment['wrong']
  /** 已有记录被搬成小题记录的学号 */
  migrated: string[]
  /** 归一化后不再有任何记录的学号（他们的错题真的没了） */
  dropped: string[]
}

/**
 * 改变某题的小题数时的归一化。
 *
 * ⚠️ **「整题错」不能丢**：拆小题之后 `isQuestionWrong` 只看小题键，
 * 一条 "3" 会变成谁也看不见的孤儿，而下一次 `finish()` 照样把它写回档案。
 * 原来的写法直接把它删掉 —— 于是"第 3 题已有 10 人记错，双击拆小题就清零"。
 * 现在整题错的记录**同时落到每个小题上**（教师可以逐个取消），
 * 缩小/取消小题时才真正删除，并且由调用方先向教师确认。
 */
export function normalizeForSubCount({
  wrong,
  before = 0,
  seq,
  count,
}: {
  wrong: Assignment['wrong']
  /** 这一题原来的小题数 —— 用来分辨"从整题拆出小题"和"已经是小题了" */
  before?: number
  seq: number
  count: number
}): SubImpact {
  const next: Assignment['wrong'] = {}
  const migrated: string[] = []
  const dropped: string[] = []
  /** 0 → n 才算"拆出小题"；反过来（n > 0 → 0）是"恢复成整题" */
  const splitting = before <= 0 && count > 0
  for (const [no, keys] of Object.entries(wrong)) {
    const mine: string[] = []
    const kept: string[] = []
    for (const k of keys) {
      const p = parseQKey(k)
      if (p.seq !== seq) kept.push(k)
      else mine.push(k)
    }
    const whole = mine.some((k) => parseQKey(k).sub === undefined)
    const subs = mine
      .map((k) => parseQKey(k).sub)
      .filter((s): s is number => s !== undefined)
    if (count <= 0) {
      // 恢复成一个整题：整题错的记录照样成立，小题记录没有位置可放
      if (whole) kept.push(qKey(seq))
    } else if (whole && splitting) {
      // 从整题拆出小题：整题错同时落到每个小题上，一条都不丢
      for (let s = 1; s <= count; s++) kept.push(qKey(seq, s))
    } else {
      /*
       * 已经是小题结构（或有小题记录）时的缩小/调整。
       * 注意：**整题键不能留** —— `isQuestionWrong` 在小题结构下只看小题键，
       * 留一条 "3" 就是一条谁也看不见、却算进统计的幽灵记录。
       */
      for (const s of subs) if (s <= count) kept.push(qKey(seq, s))
    }
    const uniq = [...new Set(kept)]
    if (uniq.length) next[no] = uniq
    else dropped.push(no)
    // 有记录的这题、改完之后仍然看得见，且键确实变了 → 算「搬过去」；否则是「删掉」
    const nowMine = uniq.filter((k) => parseQKey(k).seq === seq)
    const changed = mine.length !== nowMine.length || mine.some((k) => !nowMine.includes(k))
    const stillVisible = nowMine.some((k) => (count === 0 ? parseQKey(k).sub === undefined : true))
    if ((whole || subs.length > 0) && changed && stillVisible) migrated.push(no)
  }
  return { next, migrated, dropped }
}

/**
 * 把一个人登记为「未交」时要删掉的批改记录（不变量 I5：没交不能有错题）。
 *
 * 逐个字段对着 §二 的字段语义表判断：
 *  · `wrong` / `confirmedNos` / `correctionNos` / `correctedNos` / `grades`
 *    都是**批改的产物** —— 人没交就没得批，留着就是"未交 ∩ 已批改"的矛盾数据；
 *  · `focusNos` **不动**：它是教师对学生本人的标注（全对也可能被标），
 *    不是批改结论 —— 他这次没交，照样值得盯。
 */
export function clearStudentRecords(
  a: Pick<
    Assignment,
    'wrong' | 'confirmedNos' | 'correctionNos' | 'correctedNos' | 'grades'
  >,
  nos: string[],
): Partial<Assignment> {
  if (nos.length === 0) return {}
  const gone = new Set(nos)
  const wrong: Assignment['wrong'] = {}
  for (const [k, v] of Object.entries(a.wrong ?? {})) if (!gone.has(k)) wrong[k] = v
  const grades: Record<string, string> = {}
  for (const [k, v] of Object.entries(a.grades ?? {})) if (!gone.has(k)) grades[k] = v
  return {
    wrong,
    grades,
    confirmedNos: (a.confirmedNos ?? []).filter((n) => !gone.has(n)),
    correctionNos: (a.correctionNos ?? []).filter((n) => !gone.has(n)),
    correctedNos: (a.correctedNos ?? []).filter((n) => !gone.has(n)),
  }
}

/** 反向题：某题的错题数 */
export function wrongCountOf(students: Student[], wrong: Assignment['wrong']) {
  let total = 0
  for (const s of students) total += wrong[s.studentNo]?.length ?? 0
  return total
}

/* ---------------- 讲评优先级 ---------------- */

export type Band = 'solo' | 'brief' | 'focus' | 'deep' | 'suspect'

export const BAND_META: Record<
  Band,
  {
    label: string
    action: string
    score: number
    tone: 'idle' | 'ok' | 'warn' | 'bad' | 'accent'
    color: string
  }
> = {
  solo: {
    label: '个别辅导',
    action: '给名单单独辅导，不占课堂时间',
    score: 0.18,
    tone: 'idle',
    color: 'var(--color-ink4)',
  },
  brief: {
    label: '点到即止',
    action: '课堂上一句带过即可',
    score: 0.5,
    tone: 'ok',
    color: 'var(--color-ok)',
  },
  focus: {
    label: '优先精讲',
    action: '共性薄弱，配合变式题重点讲',
    score: 1,
    tone: 'bad',
    color: 'var(--color-bad)',
  },
  deep: {
    label: '精讲 + 查前置',
    action: '多数人没掌握，顺便检查前置知识是否缺失',
    score: 0.86,
    tone: 'warn',
    color: 'var(--color-warn)',
  },
  suspect: {
    label: '重点讲 + 回看设计',
    action: '几乎全班都错，可能是题目表述或教学环节的问题',
    score: 0.74,
    tone: 'warn',
    color: 'var(--color-warn)',
  },
}

/** 分档图例（按教学意义从轻到重） */
export const BAND_ORDER: Band[] = ['solo', 'brief', 'focus', 'deep', 'suspect']

/** 错误率 → 分档。30–70% 才是讲评价值最高的区间。 */
export function bandOf(rate: number): Band {
  if (rate < 0.1) return 'solo'
  if (rate < 0.3) return 'brief'
  if (rate < 0.7) return 'focus'
  if (rate < 0.9) return 'deep'
  return 'suspect'
}

/* ---------------- 统计 ---------------- */

export type QuestionStat = {
  seq: number
  subCount: number
  wrongNos: string[]
  wrongCount: number
  /** 错误率 = 错的人数 ÷ 应交人数（用应交而非实交，避免缺交掩盖问题） */
  rate: number
  band: Band
  score: number
  /* ---- 来自 Word 稿识别的题目信息（可能没有） ---- */
  kind?: QuestionKind
  /** 该题满分 */
  fullScore?: number
  /** 平均每人在这题上丢的分 = 错误率 × 满分。用来衡量「这题值不值得花课堂时间」 */
  lost?: number
}

/** 按题型聚合的掌握情况 */
export type KindStat = {
  kind: QuestionKind
  count: number
  fullScore: number
  /** 平均错误率 */
  rate: number
  lost: number
  wrongCount: number
}

export type GradeStats = {
  total: number
  confirmedCount: number
  /** 批改完整度 = 已确认 ÷ 应交 */
  completeness: number
  wrongTotal: number
  questions: QuestionStat[]
  /** 按讲评价值排序后的题目 */
  ranked: QuestionStat[]
  /** 有错的学生数 */
  studentsWithWrong: number
  /** 是否每道题都知道分值 */
  hasScores: boolean
  /** 卷面总分（只统计知道分值的那部分） */
  fullScore: number
  /** 全班平均得分；分值不齐时为 undefined —— 宁可不给，也不给一个错的数 */
  avgScore?: number
  /** 题型分布；没有题型信息时为空数组 */
  byKind: KindStat[]
}

export function gradeStats(students: Student[], a: Assignment): GradeStats {
  const active = students.filter((s) => s.status === 'active')
  const total = active.length || 1
  const meta = a.questionMeta ?? {}

  const questions: QuestionStat[] = Array.from({ length: a.questionCount }, (_, i) => {
    const seq = i + 1
    const subCount = a.subQuestions[String(seq)] ?? 0
    const wrongNos = active
      .filter((s) => isQuestionWrong(a.wrong[s.studentNo], seq, subCount))
      .map((s) => s.studentNo)
    const rate = wrongNos.length / total
    const band = bandOf(rate)
    const m = meta[String(seq)]
    const fullScore = m?.score
    return {
      seq,
      subCount,
      wrongNos,
      wrongCount: wrongNos.length,
      rate,
      band,
      score: BAND_META[band].score,
      kind: m?.kind,
      fullScore,
      lost: fullScore === undefined ? undefined : rate * fullScore,
    }
  })

  const confirmedCount = active.filter((s) => a.confirmedNos.includes(s.studentNo)).length
  const wrongTotal = active.reduce((n, s) => n + (a.wrong[s.studentNo]?.length ?? 0), 0)
  const studentsWithWrong = active.filter((s) => (a.wrong[s.studentNo]?.length ?? 0) > 0).length

  /* ---- 分值：只在「每道题都知道分值」时才算平均分 ---- */
  const scored = questions.filter((q) => q.fullScore !== undefined)
  const hasScores = questions.length > 0 && scored.length === questions.length
  const fullScore = scored.reduce((n, q) => n + (q.fullScore ?? 0), 0)
  const avgScore = hasScores
    ? scored.reduce((n, q) => n + (q.fullScore ?? 0) * (1 - q.rate), 0)
    : undefined

  /* ---- 按题型聚合 ---- */
  const kindMap = new Map<QuestionKind, KindStat>()
  for (const q of questions) {
    if (!q.kind) continue
    const e = kindMap.get(q.kind) ?? {
      kind: q.kind,
      count: 0,
      fullScore: 0,
      rate: 0,
      lost: 0,
      wrongCount: 0,
    }
    e.count++
    e.fullScore += q.fullScore ?? 0
    e.wrongCount += q.wrongCount
    e.rate += q.rate
    e.lost += q.lost ?? 0
    kindMap.set(q.kind, e)
  }
  const byKind = [...kindMap.values()]
    .map((e) => ({ ...e, rate: e.count ? e.rate / e.count : 0 }))
    .sort((x, y) => y.fullScore - x.fullScore || y.count - x.count)

  const ranked = [...questions]
    .filter((q) => q.wrongCount > 0)
    .sort(
      (x, y) =>
        y.score - x.score ||
        // 同一档里，先看「平均每人丢了多少分」—— 12 分的题丢 3 分比 4 分的题丢 3 分更值钱
        (y.lost ?? y.rate) - (x.lost ?? x.rate) ||
        y.rate - x.rate,
    )

  return {
    total: active.length,
    confirmedCount,
    completeness: confirmedCount / total,
    wrongTotal,
    questions,
    ranked,
    studentsWithWrong,
    hasScores,
    fullScore,
    avgScore,
    byKind,
  }
}

/** 把秒数说成人话 */
export function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}
