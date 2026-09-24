/* ============================================================
   考试 · 数据模型
   ------------------------------------------------------------
   设计见 `功能设计与不变量.md` §十四「考试」。
   两条与作业**故意相反**的约定，先写在这里免得被后来的人"统一"掉：

     ① **默认全零**：考试每题都要有分，没批改过的人每题 0 分。
        作业是"默认全对、只记例外"（`wrong`）—— 两者的默认值正好相反。
     ② **不记例外、记全量**：考试存"每个人的逐题得分/答案"，
        因为 0 分和"没批改"必须分得开（作业那边分不开，也不需要分）。

   表的划分（两张，不是一个宽表）：
     · `exams`       = 一次考试（一张卷子在一个班/一个年级）
     · `exam_scores` = 一个学生的一次考试（逐题得分 + 答案 + 缺考）
   ============================================================ */

import type { ExamQuestionKind } from '../lib/examPaperTypes'

export type { ExamQuestionKind }

/** 数据来源：平台文件导入 / 手动批阅（用户口径的两种） */
export type ExamSource = 'file' | 'manual'

/**
 * 考试范围：
 *  · `class` 班级考试 —— 只记录在本班，不参与年级排名
 *  · `grade` 年级考试 —— 同名同科的档案一起排年级排名与班级排名
 */
export type ExamScope = 'class' | 'grade'

/**
 * 记录模式（用户口径的两种）：
 *  · `answers` 记录答题情况 —— 选择题逐人选选项（按 m/n 判分），其余题型只记分值
 *  · `scores`  记录分值     —— 每题只记一个得分
 * ⚠️ `answers` 模式**必须先设好选择题答案**，否则选择题判不出分（见 `checkPaper`）。
 */
export type ExamMode = 'answers' | 'scores'

/**
 * 归档状态。
 *  · `grading` 批阅中（含"还没开始"）—— 点档案进**批阅页**
 *  · `graded`  已确认完成 —— 点档案进**统计页**，且未批改的学生每题按 0 分计
 *
 * 🔴 与作业的 `open/collected/graded` 是两套状态机，**不要互相套用**：
 *    考试没有"收缴登记"这一步（缺考名单来自文件或默认为空）。
 */
export type ExamStatus = 'grading' | 'graded'

export const EXAM_STATUS_TEXT: Record<ExamStatus, string> = {
  grading: '批阅中',
  graded: '已完成',
}

export const EXAM_SCOPE_TEXT: Record<ExamScope, string> = {
  class: '班级考试',
  grade: '年级考试',
}

export const EXAM_MODE_TEXT: Record<ExamMode, string> = {
  answers: '记录答题情况',
  scores: '记录分值',
}

export const EXAM_SOURCE_TEXT: Record<ExamSource, string> = {
  file: '平台文件导入',
  manual: '手动批阅',
}

/** 一道题的结构 */
export type ExamQuestion = {
  /** 题号（1 起，与 `questionCount` 对齐） */
  no: number
  kind: ExamQuestionKind
  /** 该题满分。0 表示还没填 —— 统计时"卷面总分"会如实反映出来 */
  fullScore: number
  /** 选择题的正确答案，如 `"A"` / `"AC"`；非选择题留空 */
  answer?: string
  /**
   * 小问数（(1)(2)(3)），>1 才存。
   *
   * ⚠️ 考试的判分**不按小问拆**（每题就是"一个分数"，用户口径）——
   *    这个字段只用来显示（「计算题（3 问）」），让老师在批阅时知道这题有几个问。
   *    作业的 `subQuestions` 是另一回事：那里的错题键要落到小问上。
   *    两者**别互相套用**。
   */
  subCount?: number
  /** 知识点 id（`data/knowledge/` 那套树的裸 id）—— 统计页按它算得分率 */
  points?: string[]
  /** 题干摘要，仅用于核对 */
  stem?: string
}

/** 一个学生的一次考试 */
export type ExamScore = {
  id: string
  examId: string
  classId: string
  /** 学号即身份（与作业同一套：`功能设计与不变量.md` §一） */
  studentNo: string
  /** 姓名快照 —— 学生转班/改名后，历史档案里仍要显示当时的名字 */
  name: string
  /**
   * 逐题得分：题号 → 分数。
   * `answers` 模式下**只对非选择题**用；`scores` 模式下所有题都用。
   */
  scores: Record<string, number>
  /** 逐题选项：题号 → 学生选的选项串（`"AC"`）。只有 `answers` 模式的选择题会写 */
  answers: Record<string, string>
  /**
   * 是否已经批阅过（**不变量 E1**：只有教师明确点过「确认批阅」才置 true）。
   * 没批阅的人：`scores`/`answers` 一定是空的，统计时每题按 0 分算。
   */
  graded: boolean
  /**
   * 缺考 / 未交。与"没批改"是两回事：
   *  · 缺考 = 人没来考（不参与均分、单独列名单）
   *  · 没批改 = 卷子还没录（**按 0 分算**，因为确认完成时已经跟老师确认过）
   */
  absent: boolean
  /* ---- 文件带来的、或平台自己算出来的汇总 ---- */
  /** 总分。文件里有就**保留文件的值**（用户口径：不覆盖文件给的值） */
  total?: number
  /** 客观题（选择题）得分 */
  objective?: number
  /** 主观题得分 */
  subjective?: number
  /** 班级排名 —— **文件里有就按文件的** */
  classRank?: number
  /** 年级排名 —— 同上；文件里没有也不要瞎算一个塞进来 */
  gradeRank?: number
  createdAt: number
}

/** 一次考试（一张卷子 + 一个班 / 一个年级） */
export type Exam = {
  id: string
  title: string
  /**
   * 归一化后的试卷键（`normalizePaperName` 的结果）。
   * **同场考试判定读它**，不读 `title` —— 否则每次判定都要重算一遍归一化，
   * 而且历史档案的判定结果会随归一化规则改动而变。
   */
  paperKey: string
  /** 学科代码（判据）+ 显示名（缓存），与作业同一套纪律：页面里不许单独写 `subject` */
  subjectCode: string
  subject: string
  scope: ExamScope
  /**
   * 年级标识。年级考试要按它把同一年级的各班档案合起来排名。
   * 取 `classes.grade`（`高一/高二/高三`）；班级考试也记，只是不用它排名。
   */
  grade: string
  source: ExamSource
  mode: ExamMode
  /** 考试日期 YYYY-MM-DD（**用 beijingNow() 取"今天"**） */
  examDate: string
  questionCount: number
  /** 题号 → 题目结构 */
  questions: Record<string, ExamQuestion>
  /**
   * 计划参加考试的班级。年级考试可以是**整个年级的多个班**，
   * 班级考试通常只有一个（用户口径：布置的班级可以在教学班里多选）。
   */
  classIds: string[]
  /** 缺考 / 未交学号（只记例外 —— 这一条和作业一样） */
  absentNos: string[]
  status: ExamStatus
  createdBy: string
  createdAt: number
  /** 确认完成的时刻 */
  gradedAt?: number
  note?: string
}

/* ---------------- 派生 ---------------- */

export type ExamWithRows = {
  exam: Exam
  rows: ExamScore[]
}

/** 某个学生的那一行（没有就是 undefined —— 别在这里造一个空行） */
export function rowOf(rows: readonly ExamScore[], studentNo: string): ExamScore | undefined {
  return rows.find((r) => r.studentNo === studentNo)
}

/** 参与统计的行：**缺考的不算**（人不在这张卷子上，算进去会把均分拉低） */
export function scoredRows(rows: readonly ExamScore[]): ExamScore[] {
  return rows.filter((r) => !r.absent)
}
