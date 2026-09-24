/* ============================================================
   从练习册 Word 稿里识别作业结构
   ------------------------------------------------------------
   目标只有一个：**把「这份作业有几道题、每题什么题型、几分、几个小问」自动填好**，
   让教师不用手工录。教师永远可以改 —— 识别结果只做加速，不做结论。

   纯文本输入，不碰 DOM，方便单测与复用。
   ============================================================ */

export type { QuestionKind, QuestionMeta } from '../data/types'

import type { QuestionKind, QuestionMeta } from '../data/types'

import { KIND_ORDER, KIND_TEXT } from '../data/types'
import { tagQuestion } from './knowledge'

export { KIND_ORDER, KIND_TEXT }

export type ParsedQuestion = {
  no: number
  kind: QuestionKind
  /** 分值；稿子里没写就是 undefined */
  score?: number
  /** 小问数（(1)(2)(3)），1 表示没有拆小问 */
  subCount: number
  /** 选项数，选择题用 */
  optionCount: number
  /** 难度星数 */
  stars: number
  /** 题干摘要，给教师核对用 */
  stem: string
  /** 知识点 id —— 用完整题干打标，摘要太短会漏 */
  points: string[]
  /** 这道题的配图（Word 稿里的 rId，位置已对齐到题号） */
  imgs: string[]
  /**
   * 正文里提到的图纸数量。
   * 注意：一张图片文件里可能画了「图甲 图乙」两个面板，
   * 所以 refs > imgs 不一定是错；但 **refs > 0 而 imgs = 0 一定是漏了图**。
   */
  figRefs: number
}

/** 数一段文字里提到了几张图：「图甲/图乙」「图1/图2」「如图 a」「如图所示」 */
export function countFigureRefs(text: string): number {
  const marks = new Set<string>()
  for (const m of text.matchAll(/图\s*([甲乙丙丁戊己])/g)) marks.add(`cn:${m[1]}`)
  for (const m of text.matchAll(/图\s*(\d{1,2})/g)) marks.add(`n:${m[1]}`)
  for (const m of text.matchAll(/图\s*([a-dA-D])(?![a-zA-Z])/g)) marks.add(`l:${m[1]}`)
  if (marks.size > 0) return marks.size
  // 只写了「如图所示」没分甲乙 —— 至少一张
  return /如图/.test(text) ? 1 : 0
}

export type ParsedExam = {
  title: string
  questions: ParsedQuestion[]
  /** 已知分值之和；有题没标分值时不可信，用 scoreComplete 判断 */
  totalScore: number
  scoreComplete: boolean
  warnings: string[]
}

/* ---------------- 文本归一化 ---------------- */

function normalize(text: string): string[] {
  return text
    .replace(/\u3000/g, ' ') // 全角空格
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
}

/* ---------------- 题目起始行 ---------------- */

/** 形如 `1.` `1．` `1、` 开头 */
const Q_HEAD = /^\s*(\d{1,2})\s*[.．、]\s*(.*)$/
/** 紧跟在题号后的 `（4分）` */
const SCORE_HEAD = /^[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]\s*/
/** 题型标注 `（多选）` `（单选）` */
const KIND_TAG = /^[（(]\s*(多选|单选|判断|不定项)\s*[）)]\s*/
/** 来源标注 `(2026·成都市高二期末)` */
const SOURCE_TAG = /^[（(]\s*\d{4}\s*[·・][^）)]{0,32}[）)]\s*/
/** 难度星 */
const STAR_TAG = /^★+\s*/

function detectKind(block: string, subCount: number, optionCount: number): QuestionKind {
  // 稿子里明写了就以它为准
  if (/[（(]\s*多选\s*[）)]/.test(block)) return 'multiple'
  if (/[（(]\s*(单选|不定项)\s*[）)]/.test(block)) return 'single'
  if (optionCount >= 2) return optionCount >= 5 ? 'multiple' : 'single'
  if (subCount >= 2) return 'calc'
  if (/实验|探究|读数|器材|刻度|游标卡尺|螺旋测微/.test(block)) return 'experiment'
  if (/_{3,}|填空|填在横线/.test(block)) return 'blank'
  if (/求|计算|大小为|多少|方向/.test(block)) return 'calc'
  return 'other'
}

function countSubs(block: string): number {
  const set = new Set<number>()
  for (const line of block.split('\n')) {
    const m = line.trim().match(/^[（(](\d{1,2})[）)]/)
    if (m) set.add(Number(m[1]))
  }
  return set.size || 1
}

function countOptions(block: string): number {
  let best = 0
  for (const line of block.split('\n')) {
    const hits = [...line.matchAll(/([A-H])\s*[.．、]/g)]
    if (hits.length < 2) continue
    const uniq = new Set(hits.map((m) => m[1]))
    if (uniq.size < 2) continue

    // 关键区分：真实选项的字母之间是**成句的文字**；
    // 而题干里「A、B、C 三点」「A、C₁ 固定电荷」这种点命名是紧挨着的。
    // 用相邻标记之间的平均间隔把它们分开 —— 不这么做，第 9 题会被误判成选择题。
    let gapSum = 0
    for (let i = 1; i < hits.length; i++) {
      const prevEnd = (hits[i - 1].index ?? 0) + hits[i - 1][0].length
      gapSum += (hits[i].index ?? 0) - prevEnd
    }
    if (gapSum / (hits.length - 1) < 4) continue

    if (uniq.size > best) best = uniq.size
  }
  return best
}

function makeStem(rest: string): string {
  let s = rest
  s = s.replace(SCORE_HEAD, '')
  s = s.replace(STAR_TAG, '')
  s = s.replace(KIND_TAG, '')
  s = s.replace(SOURCE_TAG, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 46 ? `${s.slice(0, 46)}…` : s
}

/* ---------------- 主函数 ---------------- */

export function parseExam(text: string, fallbackTitle = ''): ParsedExam {
  const lines = normalize(text)
  const warnings: string[] = []

  /* 1. 找出所有「题号行」，再取从 1 开始、连续递增的那一串 */
  type Cand = { no: number; idx: number; rest: string }
  const cands: Cand[] = []
  lines.forEach((line, idx) => {
    const m = line.match(Q_HEAD)
    if (!m) return
    cands.push({ no: Number(m[1]), idx, rest: m[2] ?? '' })
  })

  let seq: Cand[] = []
  for (let i = 0; i < cands.length; i++) {
    if (cands[i].no !== 1) continue
    const run: Cand[] = [cands[i]]
    for (let k = i + 1; k < cands.length; k++) {
      if (cands[k].no === run[run.length - 1].no + 1) run.push(cands[k])
      else if (cands[k].no > run[run.length - 1].no + 1) break
    }
    if (run.length > seq.length) seq = run
  }

  if (seq.length === 0) {
    return {
      title: fallbackTitle,
      questions: [],
      totalScore: 0,
      scoreComplete: false,
      warnings: ['没找到形如「1.（4分）…」的题号，可能这份稿子的排版不一样'],
    }
  }
  if (seq.length < cands.length) {
    warnings.push(`识别到 ${seq.length} 道题（另有 ${cands.length - seq.length} 处数字开头但不像题号，已跳过）`)
  }

  /* 2. 标题：题号之前最靠下的一个短行 */
  let title = ''
  const before = lines.slice(0, seq[0].idx).map((l) => l.trim()).filter(Boolean)
  for (let i = before.length - 1; i >= 0; i--) {
    const l = before[i]
    if (l.length <= 34 && !/^\d/.test(l)) {
      title = l
      break
    }
  }
  if (!title) title = fallbackTitle

  /* 3. 逐题解析 */
  const questions: ParsedQuestion[] = []
  let totalScore = 0
  let scored = 0

  seq.forEach((c, i) => {
    const end = i + 1 < seq.length ? seq[i + 1].idx : lines.length
    const block = lines.slice(c.idx, end).join('\n')

    const scoreM = c.rest.match(SCORE_HEAD)
    const score = scoreM ? Number(scoreM[1]) : undefined
    if (score !== undefined) {
      totalScore += score
      scored++
    }

    const subCount = countSubs(block)
    const optionCount = countOptions(block)
    questions.push({
      no: c.no,
      kind: detectKind(block, subCount, optionCount),
      score,
      subCount,
      optionCount,
      stars: (block.match(/★/g) ?? []).length,
      stem: makeStem(c.rest),
      // 用整段（含选项）打标 —— 只给题干的话「下列说法正确的是」这类会漏掉关键线索
      points: tagQuestion(block),
      // U+E000 是 docx 抽取时留的图片占位符，它落在哪一段就属于哪一题
      imgs: [...block.matchAll(/\uE000(rId\d+)\uE000/g)].map((m) => m[1]),
      figRefs: countFigureRefs(block),
    })
  })

  const scoreComplete = scored === questions.length
  if (!scoreComplete) {
    warnings.push(`${questions.length - scored} 道题没标分值，总分对不上，可在下面手工改`)
  }
  if (questions.length > 0 && questions[questions.length - 1].no !== questions.length) {
    warnings.push('题号有跳号，请核对')
  }

  return { title, questions, totalScore, scoreComplete, warnings }
}

/* ---------------- 转成档案需要的字段 ---------------- */

/** 题号 → 小题数（只保留真正拆了小问的） */
export function toSubQuestions(questions: ParsedQuestion[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const q of questions) {
    if (q.subCount > 1) out[String(q.no)] = q.subCount
  }
  return out
}

/** 题号 → 题目元信息 */
/** 题号 → 题目元信息 */
export function toQuestionMeta(questions: ParsedQuestion[]): Record<string, QuestionMeta> {
  const out: Record<string, QuestionMeta> = {}
  for (const q of questions) {
    out[String(q.no)] = {
      kind: q.kind,
      score: q.score,
      subCount: q.subCount > 1 ? q.subCount : undefined,
      optionCount: q.optionCount || undefined,
      stars: q.stars || undefined,
      stem: q.stem || undefined,
      points: q.points.length ? q.points : undefined,
      imgs: q.imgs.length ? q.imgs : undefined,
    }
  }
  return out
}

/** 把 ParsedQuestion 里的 rId 占位换成真正的 data URL（导入时调用一次） */
export function resolveImages(
  questions: ParsedQuestion[],
  images: Map<string, string>,
): ParsedQuestion[] {
  return questions.map((q) => ({
    ...q,
    imgs: q.imgs.map((r) => images.get(r)).filter((u): u is string => Boolean(u)),
  }))
}
