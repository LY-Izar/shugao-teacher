/* ============================================================
   考试 · 题型的**值域**（单独一个文件，纯类型 + 常量）
   ------------------------------------------------------------
   为什么把它从 `lib/examPaper.ts` 拆出来：
   `data/examTypes.ts` 需要 `ExamQuestionKind`，而 `lib/examPaper.ts` 需要
   `data/examTypes.ts` 的 `Exam`/`ExamQuestion` —— 两边互相 import 会形成
   "循环定义"（TypeScript 会直接报 TS2303）。
   把**没有行为的值域**放在这里，两个方向就都只依赖它，没有环。

   🔴 与作业的 `QuestionKind`（`data/types.ts`）**不是同一套值域**，别互相赋值：
      作业那套来自练习册 Word 稿识别（`single|multiple|blank|calc|experiment|other`），
      用途是"讲评时按题型聚合"；考试这套多出判断题、写作/论述、听力、
      阅读理解、翻译语用 —— 这些是文科与英语卷上的真实题型，作业那套装不下。
   ============================================================ */

export type ExamQuestionKind =
  | 'single' // 单项选择
  | 'multiple' // 多项选择
  | 'judge' // 判断
  | 'blank' // 填空
  | 'experiment' // 实验 / 探究
  | 'calc' // 计算 / 解答
  | 'reading' // 阅读（现代文 / 文言文 / 材料）
  | 'essay' // 写作 / 论述 / 开放设问
  | 'listen' // 听力
  | 'translation' // 翻译 / 语言文字运用
  | 'other' // 待定

export const EXAM_KIND_TEXT: Record<ExamQuestionKind, string> = {
  single: '单项选择',
  multiple: '多项选择',
  judge: '判断题',
  blank: '填空题',
  experiment: '实验探究',
  calc: '计算解答',
  reading: '阅读理解',
  essay: '写作论述',
  listen: '听力',
  translation: '翻译/语用',
  other: '待定',
}

/** 建档时题型 chip 的显示顺序 */
export const EXAM_KIND_ORDER: ExamQuestionKind[] = [
  'single',
  'multiple',
  'judge',
  'blank',
  'experiment',
  'calc',
  'reading',
  'essay',
  'listen',
  'translation',
  'other',
]

/**
 * 是不是选择题 —— **"记答题情况"模式只对选择题有意义**。
 * 判据只有这一处：任何"这题能不能选选项"的判断都调它，别各写各的
 * （`kind === 'single' || kind === 'multiple'` 抄第二份就是第二个判定入口）。
 */
export function isChoiceKind(kind?: string | null): boolean {
  return kind === 'single' || kind === 'multiple'
}

/** 单项选择题的选项字母（八个够用；多选题同理） */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
