/* ============================================================
   考试 · 试卷结构与判分（纯函数，单一来源）
   ------------------------------------------------------------
   为什么单独一个文件：这套规则要在**至少四处**用到，抄第二份必然分叉 ——
     · 建档页（预览/校验）
     · 文件导入（从新教育导出的 xlsx 还原结构）
     · 手动批阅页（实时算分）
     · 统计页（正确率、知识点得分率）
   项目里已经出过四次「同一件事两个判定入口」的事故（见 功能设计与不变量.md §十），
   所以判分**只有这一个入口**。

   🔴 考试与作业最根本的差别（别把两者统一）：
     · 作业：**默认全对**，只记例外（`wrong`）——「错题只记例外」见 §一
     · 考试：**默认全零**，每题都要有分 —— 没改过的学生每题 0 分
   两者的默认值正好相反，是刻意的。把它们"统一"起来会让一边彻底算错。
   ============================================================ */

import { isChoiceKind } from './examPaperTypes'
import type { Exam, ExamQuestion } from '../data/examTypes'

/*
 * 题型的值域与显示名在 `./examPaperTypes`（**单独一个文件**，因为
 * `data/examTypes.ts` 也要用它，放在这里会形成循环 import）。
 * 这里再导出一次，页面只需要认 `lib/examPaper` 一个入口。
 */
export {
  EXAM_KIND_ORDER,
  EXAM_KIND_TEXT,
  OPTION_LETTERS,
  isChoiceKind,
} from './examPaperTypes'

export type { ExamQuestionKind } from './examPaperTypes'
export type { Exam, ExamMode, ExamQuestion } from '../data/examTypes'

/* ---------------- 结构读取（宽容：老数据/外部文件都可能缺字段） ---------------- */

/**
 * 一份试卷的题目数量。
 * **题量是"最大题号"**（不是 `questions.length`）：外部文件里偶尔缺一行，
 * 用长度会让后面的题号整体前移，比缺一行更糟。
 */
export function questionCountOf(e: Pick<Exam, 'questionCount' | 'questions'>): number {
  const n = Math.max(0, Math.floor(Number(e.questionCount) || 0))
  const maxNo = Object.keys(e.questions ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0)
  return Math.max(n, maxNo)
}

/** 题号 1..n 的题目结构；缺的那题补一个 `other/0 分`（**不猜题型，也不编分值**） */
export function questionsOf(e: Pick<Exam, 'questionCount' | 'questions'>): ExamQuestion[] {
  const n = questionCountOf(e)
  const src = e.questions ?? {}
  const out: ExamQuestion[] = []
  for (let seq = 1; seq <= n; seq++) {
    const q = src[String(seq)]
    out.push(
      q
        ? { ...q, no: seq }
        : { no: seq, kind: 'other', fullScore: 0 },
    )
  }
  return out
}

/** 卷面总分 = 各题满分之和（题目分值缺失按 0 算，并如实反映出来） */
export function paperFullScore(e: Pick<Exam, 'questionCount' | 'questions'>): number {
  return questionsOf(e).reduce((n, q) => n + (Number(q.fullScore) || 0), 0)
}

export type PaperIntegrity = {
  /** 有没有题目没填分值 */
  missingScore: number[]
  /** 有没有题目没填题型（落到 `other`） */
  unknownKind: number[]
  /** 选择题但没设正确答案 —— 记答题情况模式下这些题判不了分 */
  missingAnswer: number[]
  /** 选择题的正确答案超过选项范围 / 重复字母 */
  badAnswer: number[]
  /** 分值不是 0 到 100 的整数 */
  badScore: number[]
  /** 有没有任何阻塞项（建档时用来决定要不要提醒） */
  ok: boolean
}

/**
 * 结构体检。
 * **只报告、不阻塞**：老师可以在信息不全的情况下先把档案建起来
 * （反指标那条是给作业的；考试建档允许有必填项，但"能预填的必须预填"，
 * 且绝不因为一处没填就把整个流程锁死）。
 */
export function checkPaper(e: Pick<Exam, 'questionCount' | 'questions'>): PaperIntegrity {
  const missingScore: number[] = []
  const unknownKind: number[] = []
  const missingAnswer: number[] = []
  const badAnswer: number[] = []
  const badScore: number[] = []
  for (const q of questionsOf(e)) {
    const sc = Number(q.fullScore)
    if (!Number.isFinite(sc) || sc === 0) missingScore.push(q.no)
    else if (sc < 0 || sc > 100 || Math.round(sc) !== sc) badScore.push(q.no)
    if (!q.kind || q.kind === 'other') unknownKind.push(q.no)
    if (isChoiceKind(q.kind)) {
      const ans = normalizeAnswer(q.answer)
      if (!ans) missingAnswer.push(q.no)
      else if (q.kind === 'single' && ans.length !== 1) badAnswer.push(q.no)
    }
  }
  return {
    missingScore,
    unknownKind,
    missingAnswer,
    badAnswer,
    badScore,
    ok:
      missingScore.length === 0 &&
      unknownKind.length === 0 &&
      missingAnswer.length === 0 &&
      badAnswer.length === 0 &&
      badScore.length === 0,
  }
}

/* ---------------- 学生答案 ---------------- */

/**
 * 归一化一个选项串：`"a c"` → `"AC"`，`"Ａ"` → `"A"`。
 * 认不出任何一个字符合法选项时返回 `''`（＝没作答）。
 * 全角字母、空格、顿号、逗号都容错 —— 这些是新教育/智学网导出里真出现过的写法。
 */
export function normalizeAnswer(raw?: string | null): string {
  const s = String(raw ?? '')
    .replace(/[\uFF21-\uFF3A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toUpperCase()
    .replace(/[^A-H]/g, '')
  const uniq = [...new Set(s.split(''))].sort()
  return uniq.join('')
}

/** 这个答案串能不能被解析成合法选项（空串＝未作答，也算合法） */
export function isAnswerLike(raw?: string | null): boolean {
  return /^[A-Ha-h\s,，、]*$/.test(String(raw ?? ''))
}

/* ---------------- 判分（**唯一入口**） ---------------- */

export type ChoiceVerdict = {
  /** 学生选中的选项 */
  picked: string
  /** 正确答案 */
  answer: string
  /** 选对的个数 */
  hit: number
  /** 正确答案的选项总数 n */
  total: number
  /** 得分（多选题按 m/n × 满分；单选题只有 0 或满分） */
  score: number
}

/**
 * 选择题判分。
 *
 * 🔴 用户拍板的规则（**多选题**）：总正确选项为 n，学生选对 m 个 → 得分 = m/n × 该题分值。
 *    例：答案 AC（n=2）、学生选 A（m=1）→ 满分 5 分记 2.5 分；选 AB（m=1）→ 2.5 分；选 AC → 5 分。
 *    单选：答对 = 满分，答错 = 0（n=1 时 m/n 只会是 0 或 1，与这条规则自洽）。
 *
 * ⚠️ 没有 `isChoiceKind` 的判断在这里 —— 调用方要先分流：
 *    非选择题走 `scoreOf()` 直接取记录的分值。把两种模式混在一个函数里，
 *    就会出现"填空题被拿去比选项"这种不会报错、但结果全错的 bug。
 */
export function gradeChoice(
  fullScore: number,
  answerRaw?: string | null,
  pickedRaw?: string | null,
): ChoiceVerdict {
  const answer = normalizeAnswer(answerRaw)
  const picked = normalizeAnswer(pickedRaw)
  const total = answer.length
  const full = Number(fullScore) || 0
  if (total === 0) return { picked, answer, hit: 0, total: 0, score: 0 }
  const hit = answer.split('').filter((c) => picked.includes(c)).length
  // 多选了错的选项不额外扣分 —— 只按"选对了几个"算（用户口径只说了 m/n）
  const ratio = Math.min(1, hit / total)
  return { picked, answer, hit, total, score: round2(full * ratio) }
}

/** 保留两位小数（0.5 分这种半分粒度在 m/n 判分里必然出现） */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * 某一题某人的得分。
 *
 * · 记答题情况模式（`answers`）：**选择题按 m/n 判分；其余题型取记录的分值**
 *   （用户口径：填空/解答等其他题型只需要记录分值）；
 * · 记分值模式（`scores`）：一律取记录的分值。
 *
 * 🔴 **没记录 = 0 分**（考试默认全零，与作业的"默认全对"相反）。
 *    这是"确认完成后没改过的学生每题都按 0 算"那条规则的落点，
 *    所以任何地方要算分都必须走这里，不要自己 `?? 0` 一遍 —— 那又多了一个判定入口。
 */
export function scoreOf(
  q: ExamQuestion | undefined,
  m: Exam['mode'],
  row: { scores?: Record<string, number>; answers?: Record<string, string> } | undefined,
): number {
  if (!q) return 0
  const full = Number(q.fullScore) || 0
  if (isChoiceKind(q.kind) && m === 'answers') {
    const picked = row?.answers?.[String(q.no)]
    // 没作答也要走判分：答案是 A、学生没选 → m=0 → 0 分，与"默认全零"自洽
    return gradeChoice(full, q.answer, picked).score
  }
  const raw = row?.scores?.[String(q.no)]
  const v = Number(raw)
  if (!Number.isFinite(v) || v <= 0) return 0
  return round2(Math.min(v, full))
}

/** 某人整卷得分 */
export function totalOf(
  e: Pick<Exam, 'questionCount' | 'questions' | 'mode'>,
  row: { scores?: Record<string, number>; answers?: Record<string, string> } | undefined,
): number {
  return round2(questionsOf(e).reduce((n, q) => n + scoreOf(q, e.mode, row), 0))
}

/**
 * 客观题 / 主观题得分。
 *
 * 口径（要写进文档，否则"客观题得分"这四个字每个人理解都不一样）：
 *   · **客观题 = 选择题**（`isChoiceKind`）—— 机器能判的只有这类；
 *   · 主观题 = 其余全部题型。
 * 新教育导出的文件里这两列是现成的，本地重算时会与它对照（不一致要报出来，不静默覆盖）。
 */
export function objectiveSubjective(
  e: Pick<Exam, 'questionCount' | 'questions' | 'mode'>,
  row: { scores?: Record<string, number>; answers?: Record<string, string> } | undefined,
): { objective: number; subjective: number } {
  let objective = 0
  let subjective = 0
  for (const q of questionsOf(e)) {
    const s = scoreOf(q, e.mode, row)
    if (isChoiceKind(q.kind)) objective += s
    else subjective += s
  }
  return { objective: round2(objective), subjective: round2(subjective) }
}

/* ---------------- 同一场考试的归一化判定 ---------------- */

/** 汉字数字 → 阿拉伯数字（只做 0–99，够覆盖「练习八」「第12次」这类写法） */
const CN_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 把一段文本里的汉字数字换成阿拉伯数字：`练习八` → `练习8`，`十二` → `12` */
export function cnNumToArabic(text: string): string {
  return text.replace(/[〇零一二两三四五六七八九十]{1,3}/g, (m) => {
    if (m.length === 1) return String(CN_DIGITS[m] ?? m)
    // 十 / 十二 / 二十 / 二十三
    const idx = m.indexOf('十')
    if (idx >= 0) {
      const head = m.slice(0, idx)
      const tail = m.slice(idx + 1)
      const tens = head === '' ? 1 : (CN_DIGITS[head] ?? NaN)
      const ones = tail === '' ? 0 : (CN_DIGITS[tail] ?? NaN)
      if (Number.isFinite(tens) && Number.isFinite(ones)) return String(tens * 10 + ones)
      return m
    }
    // 纯数字连写：二三 → 23（少见，但比原样留着好）
    const digits = m.split('').map((c) => CN_DIGITS[c])
    if (digits.every((d) => d !== undefined)) return digits.join('')
    return m
  })
}

/**
 * 试卷名归一化 —— **判定"是不是同一场考试"的唯一依据**。
 *
 * 用户拍板：**按试卷名字**，而且要容错：空格不一样、数字用汉字、少了标点，
 * 只要文字意思一样就算同一场。所以依次做六件事：
 *   ① 全角空格/制表符 → 普通空格
 *   ② 汉字数字 → 阿拉伯数字（`练习八` = `练习8`）
 *   ③ 去掉**所有**空白（"物理 练习 8" = "物理练习8"）
 *   ④ 丢掉纯修饰后缀/前缀（`-原始成绩` / `成绩单` / `（答题卡）` …）
 *   ⑤ 去掉所有标点与括号（中英文都去）
 *   ⑥ 英文小写化
 *
 * ⚠️ **不做**同义词替换（"期末" ≠ "期末考试"）：那要靠相似度兜底，
 *    悄悄改字面会让"为什么判成同一场"说不清楚（用户要求能解释）。
 */
export function normalizePaperName(raw?: string | null): string {
  let s = String(raw ?? '')
  s = s.replace(/[\u3000\t\r\n]+/g, ' ')
  s = cnNumToArabic(s)
  s = s.replace(/\s+/g, '')
  // 导出文件常见的修饰尾巴：先剥掉再比，否则「物理练习8」与「物理练习8-原始成绩」判不成同一场
  s = s.replace(
    /[-—_·]*(原始成绩|成绩单|原始数据|答卷|答题卡|成绩|数据|明细|导出|汇总|统计)$/g,
    '',
  )
  s = s.replace(/[（(][^）)]*[）)]/g, '')
  s = s.replace(/[，。、,.;；:：!！?？"'“”‘’《》<>[\]【】{}·—～~\\/|+*&^%$***REMOVED***@`]/g, '')
  s = s.replace(/[-_]/g, '')
  s = s.toLocaleLowerCase('zh-Hans-CN')
  return s
}

export type SameExamVerdict = {
  same: boolean
  /** 判定的理由（**要能给人看**：用户要求"能解释为什么判成同一场"） */
  reason: string
  /** 归一化之后的两个键 */
  keyA: string
  keyB: string
  /** 相似度 0–1（大字组 Dice 系数）；精确相等时为 1 */
  similarity: number
}

/** 字符二元组集合 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  if (s.length <= 1) {
    if (s) out.add(s)
    return out
  }
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 二元组 Dice 相似度（0–1）。用它而不是编辑距离：中文短串上更稳，也不会被一个错字带偏。 */
export function similarityOf(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** 判定相似度阈值 —— 0.86：能容下"少一个字/多一个字"，又不会把「练习8」「练习9」判成同一场 */
export const SAME_EXAM_THRESHOLD = 0.86

/**
 * 两份试卷名是不是**同一场考试**。
 *
 * 三级判定，**每一级都返回人话理由**：
 *   ① 归一化后完全相等 → 同一场（这是最常见的一级，也是用户说的"文字意思一样"）
 *   ② 一方包含另一方、且短的那个 ≥ 4 个字 → 同一场（`物理练习8` ⊂ `物理练习8第一次`）
 *      ⚠️ 加了长度下限：`练习8` ⊂ `练习80` 这种必须拦住
 *   ③ 二元组相似度 ≥ 0.86 → 同一场（少了一个字、多了一个字、错一个字）
 * 否则不同场。**宁可判成两场，也不要错并**：并错了是把两个班的两次考试揉在一起，
 * 而且教师看不出来；判成两场只是多建一份档案，删掉就行。
 */
export function sameExamName(a?: string | null, b?: string | null): SameExamVerdict {
  const keyA = normalizePaperName(a)
  const keyB = normalizePaperName(b)
  if (!keyA || !keyB) {
    return { same: false, reason: '有一边没有名字，无从比对', keyA, keyB, similarity: 0 }
  }
  if (keyA === keyB) {
    return {
      same: true,
      reason: `去空格、去标点、汉字数字转阿拉伯数字之后完全相同：「${keyA}」`,
      keyA,
      keyB,
      similarity: 1,
    }
  }
  const sim = similarityOf(keyA, keyB)
  const shorter = keyA.length <= keyB.length ? keyA : keyB
  const longer = keyA.length <= keyB.length ? keyB : keyA
  /*
   * ② 包含关系 —— 但**不能让数字被截断**：
   *    「物理练习8」⊂「物理练习80」字面上成立，可 8 与 80 是两场不同的考试。
   *    所以贴着边界那一位如果是数字，就不认这一条（`8` 后面是 `0` → 拒绝）。
   *    归一化已经把空格去掉了，所以「物理练习8 第一次」这种也照样能匹配上。
   */
  const at = longer.indexOf(shorter)
  const cutAtDigit = at >= 0 && /\d/.test(longer[at + shorter.length] ?? '\u0000')
  if (shorter.length >= 4 && at >= 0 && !cutAtDigit) {
    return {
      same: true,
      reason: `「${shorter}」完整包含在「${longer}」里，且已足够长（≥4 字）`,
      keyA,
      keyB,
      similarity: sim,
    }
  }
  if (shorter.length >= 4 && at >= 0 && cutAtDigit) {
    return {
      same: false,
      reason: `虽然「${shorter}」是「${longer}」的前缀，但紧跟着一位数字（${longer[at + shorter.length]}）—— 题号不同，判成两场`,
      keyA,
      keyB,
      similarity: sim,
    }
  }
  if (sim >= SAME_EXAM_THRESHOLD) {
    return {
      same: true,
      reason: `文字相似度 ${(sim * 100).toFixed(1)}%，达到同一场考试的判定线（${SAME_EXAM_THRESHOLD * 100}%）`,
      keyA,
      keyB,
      similarity: sim,
    }
  }
  return {
    same: false,
    reason: `归一化后不同（「${keyA}」vs「${keyB}」），相似度只有 ${(sim * 100).toFixed(1)}%，判成两场`,
    keyA,
    keyB,
    similarity: sim,
  }
}

/**
 * 在已有考试里找**同一场**的那些（年级考试要拿它把各班的数据合起来排名）。
 * 返回按考试日期倒序排好的候选，每个都带理由 —— 界面上要能展开看"为什么匹配上"。
 */
export function findSameExam<T extends { title: string; subjectCode?: string; examDate: string }>(
  all: readonly T[],
  target: { title: string; subjectCode?: string; examDate?: string },
): Array<{ exam: T; verdict: SameExamVerdict }> {
  const out: Array<{ exam: T; verdict: SameExamVerdict }> = []
  for (const e of all) {
    // 学科不同就不是同一场（语文练习8 与 物理练习8 同名也不许合）
    if (target.subjectCode && e.subjectCode && target.subjectCode !== e.subjectCode) continue
    const v = sameExamName(e.title, target.title)
    if (v.same) out.push({ exam: e, verdict: v })
  }
  return out.sort((x, y) => (x.exam.examDate < y.exam.examDate ? 1 : -1))
}

/** 从导出文件名/表名里猜试卷名：`物理练习8-原始成绩` → `物理练习8` */
export function paperTitleFromSheetName(name?: string | null): string {
  let s = String(name ?? '').trim()
  s = s.replace(/[-—_·]*(原始成绩|成绩单|原始数据|答卷|答题卡|成绩|数据|明细|选项分布|分布|导出|汇总|统计)$/g, '')
  return s.trim()
}
