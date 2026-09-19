import type { Assignment, Student } from '../data/types'
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

/**
 * 改变某题的小题数时的归一化：
 * 拆出小题后「整题错」标记不再有意义，超出范围的旧小题标记也要清掉。
 */
export function normalizeForSubCount(
  wrong: Assignment['wrong'],
  seq: number,
  count: number,
): Assignment['wrong'] {
  const next: Assignment['wrong'] = {}
  for (const [no, keys] of Object.entries(wrong)) {
    next[no] = keys.filter((k) => {
      const p = parseQKey(k)
      if (p.seq !== seq) return true
      if (p.sub === undefined) return false
      return p.sub <= count
    })
  }
  return next
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
}

export function gradeStats(students: Student[], a: Assignment): GradeStats {
  const active = students.filter((s) => s.status === 'active')
  const total = active.length || 1

  const questions: QuestionStat[] = Array.from({ length: a.questionCount }, (_, i) => {
    const seq = i + 1
    const subCount = a.subQuestions[String(seq)] ?? 0
    const wrongNos = active.filter((s) => isQuestionWrong(a.wrong[s.studentNo], seq, subCount)).map((s) => s.studentNo)
    const rate = wrongNos.length / total
    const band = bandOf(rate)
    return {
      seq,
      subCount,
      wrongNos,
      wrongCount: wrongNos.length,
      rate,
      band,
      score: BAND_META[band].score,
    }
  })

  const confirmedCount = active.filter((s) => a.confirmedNos.includes(s.studentNo)).length
  const wrongTotal = active.reduce((n, s) => n + (a.wrong[s.studentNo]?.length ?? 0), 0)
  const studentsWithWrong = active.filter((s) => (a.wrong[s.studentNo]?.length ?? 0) > 0).length

  const ranked = [...questions]
    .filter((q) => q.wrongCount > 0)
    .sort((x, y) => y.score - x.score || y.rate - x.rate)

  return {
    total: active.length,
    confirmedCount,
    completeness: confirmedCount / total,
    wrongTotal,
    questions,
    ranked,
    studentsWithWrong,
  }
}

/** 把秒数说成人话 */
export function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}
