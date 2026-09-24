/* ============================================================
   四川新高考 · 各科题型待选清单（建档时的"一键套用"）
   ------------------------------------------------------------
   🔴 **这份清单是"待老师确认"的草案，不是权威数据。**
      用户明确要求：先把查证结果交给他确认，**不要直接写死进代码**。
      所以这里的每一条都带 `confidence`：
        · `'confirmed'` —— 2025 年真实卷面/官方文件逐项核实过（附来源）
        · `'inferred'`  —— 总分确证、逐题分值是按常规推断的
        · `'sample'`    —— 只找到样卷（合格考的信息技术/通用技术）
        · `'unknown'`   —— 只有总分与客观/主观比例，逐题结构没查到
      建档页上用**低饱和的提示**显示置信度，并且**一键套用之后每一项都能改**。

   来源（四川省教育厅 / 四川省教育考试院 / 2025 年真卷全文）见
   `功能设计与不变量.md` §十四「四川新高考题型查证」一节。

   ⚠️ 两条**与直觉相反**的事实（查证纠正过）：
     ① 物理、历史**不是全国卷**：四川「3+1+2」里的 6 门（物理/历史/政治/地理/化学/生物）
        全部由**四川省自主命题**；只有语文/数学/外语是教育部统一命题。
     ② **只有物理有多项选择题**（3 题 × 6 分）。化学/生物/政治/历史/地理**全部为单选**。
        这一条直接影响"客观题得分"的口径，写错了统计就全错。
   ============================================================ */

import type { ExamQuestionKind } from '../lib/examPaperTypes'
import { isChoiceKind } from '../lib/examPaperTypes'

export type PresetConfidence = 'confirmed' | 'inferred' | 'sample' | 'unknown'

export const CONFIDENCE_TEXT: Record<PresetConfidence, string> = {
  confirmed: '已核实',
  inferred: '部分推断',
  sample: '样卷',
  unknown: '待补',
}

export type PresetQuestion = {
  kind: ExamQuestionKind
  /** 这一组有几题 */
  count: number
  /** 每题分值 */
  each: number
  /**
   * 是不是**客观题**（机器可判的选择）。
   * ⚠️ 它**不等于** `isChoiceKind(kind)` 的反面：语文的"断句·涂卡"是涂卡作答（客观），
   *    但在平台上按"填空/其他"录入分值 —— 这里以**平台口径**为准（见 §十四的说明）。
   */
  objective?: boolean
  /** 显示名（卷面上的叫法，例如「现代文阅读 I · 单选」） */
  label?: string
  /** 小问数提示（只用于显示，不影响判分） */
  subCount?: number
}

export type SubjectExamPreset = {
  /** 与 `lib/subjects.ts` 的 code 对齐 */
  subjectCode: string
  subjectName: string
  /** 卷面满分 */
  fullScore: number
  /** 考试时长（分钟） */
  minutes: number
  /** 命题方 */
  by: string
  confidence: PresetConfidence
  /** 来源链接（老师要能自己去核） */
  sources: string[]
  /** 备注：这一科的坑在哪 */
  note?: string
  groups: PresetQuestion[]
}

/* ---------------- 清单 ---------------- */

export const EXAM_PRESETS: SubjectExamPreset[] = [
  {
    subjectCode: 'chinese',
    subjectName: '语文',
    fullScore: 150,
    minutes: 150,
    by: '教育部统一命题（2025 四川用全国二卷 / 新课标 II 卷）',
    confidence: 'confirmed',
    sources: ['https://www.scsqw.cn/scyx/scgkt/2000nyh/yw/content_178418'],
    note: '「断句」在卷面上是涂卡作答，但平台按"其他题型记分值"录入 —— 于是客观题只算单选的那 11 题。',
    groups: [
      { kind: 'single', count: 3, each: 3, objective: true, label: '现代文阅读 I · 单选' },
      { kind: 'reading', count: 2, each: 5, label: '现代文阅读 I · 简答（4 分 + 6 分）' },
      { kind: 'single', count: 2, each: 3, objective: true, label: '现代文阅读 II · 单选' },
      { kind: 'reading', count: 2, each: 6, label: '现代文阅读 II · 简答' },
      { kind: 'single', count: 1, each: 3, objective: true, label: '文言文 · 断句（涂卡）' },
      { kind: 'single', count: 2, each: 3, objective: true, label: '文言文 · 词语解说 / 内容概述' },
      { kind: 'translation', count: 1, each: 8, label: '文言文 · 翻译（2 句共 8 分）', subCount: 2 },
      { kind: 'reading', count: 1, each: 3, label: '文言文 · 简答' },
      { kind: 'single', count: 1, each: 3, objective: true, label: '古代诗歌 · 单选' },
      { kind: 'reading', count: 1, each: 6, label: '古代诗歌 · 简答' },
      { kind: 'blank', count: 1, each: 6, label: '名篇名句默写（3 小题 / 6 空）', subCount: 3 },
      { kind: 'single', count: 2, each: 3, objective: true, label: '语言文字运用 · 单选' },
      { kind: 'translation', count: 3, each: 4, label: '语言文字运用 · 填关联词 / 找错别字 / 简答（3+3+6）' },
      { kind: 'essay', count: 1, each: 60, label: '写作' },
    ],
  },
  {
    subjectCode: 'math',
    subjectName: '数学',
    fullScore: 150,
    minutes: 120,
    by: '教育部统一命题（2025 四川用全国二卷 / 新课标 II 卷）',
    confidence: 'inferred',
    sources: ['https://www.scsqw.cn/scyx/scgkt/2000nyh/lksx/content_178422'],
    note: '解答题 15/16/17 题的分值已核实（13+15+15）；18、19 题各 17 分是"合计 77 分"的推断，请老师核。',
    groups: [
      { kind: 'single', count: 8, each: 5, objective: true, label: '一、单项选择题' },
      { kind: 'multiple', count: 3, each: 6, objective: true, label: '二、多项选择题（部分对得部分分）' },
      { kind: 'blank', count: 3, each: 5, label: '三、填空题（2025 全卷无"一题两空"）' },
      { kind: 'calc', count: 1, each: 13, label: '15 题 · 三角' },
      { kind: 'calc', count: 1, each: 15, label: '16 题 · 解析几何' },
      { kind: 'calc', count: 1, each: 15, label: '17 题 · 立体几何' },
      { kind: 'calc', count: 1, each: 17, label: '18 题 · 导数（推断）' },
      { kind: 'calc', count: 1, each: 17, label: '19 题（推断）' },
    ],
  },
  {
    subjectCode: 'english',
    subjectName: '英语',
    fullScore: 150,
    minutes: 120,
    by: '教育部统一命题（2025 四川用全国二卷 / 新课标 II 卷）',
    confidence: 'inferred',
    sources: ['https://www.renrendoc.com/paper/460952070.html'],
    note: '**有听力（30 分）、有读后续写（25 分），已无短文改错**。语法填空 15 分已核实，10 空×1.5 分为推断。',
    groups: [
      { kind: 'listen', count: 5, each: 1.5, objective: true, label: '听力第一节' },
      { kind: 'listen', count: 15, each: 1.5, objective: true, label: '听力第二节' },
      { kind: 'reading', count: 15, each: 2.5, objective: true, label: '阅读理解（4 篇）' },
      { kind: 'reading', count: 5, each: 2.5, objective: true, label: '阅读七选五' },
      { kind: 'single', count: 15, each: 1, objective: true, label: '完形填空' },
      { kind: 'blank', count: 10, each: 1.5, label: '语法填空（题量/分值为推断）' },
      { kind: 'essay', count: 1, each: 15, label: '写作 · 应用文' },
      { kind: 'essay', count: 1, each: 25, label: '写作 · 读后续写' },
    ],
  },
  {
    subjectCode: 'physics',
    subjectName: '物理',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'confirmed',
    sources: ['https://www.scsqw.cn/scyx/scgkt/2000nyh/lkzhnlcs/content_178750'],
    note: '六科里**只有物理有多项选择题**（3 题 × 6 分）。客观 46 / 主观 54。',
    groups: [
      { kind: 'single', count: 7, each: 4, objective: true, label: '一、单项选择题' },
      { kind: 'multiple', count: 3, each: 6, objective: true, label: '二、多项选择题（选对不全得一半）' },
      { kind: 'experiment', count: 1, each: 6, label: '11 题 · 力学实验' },
      { kind: 'experiment', count: 1, each: 10, label: '12 题 · 电学实验' },
      { kind: 'calc', count: 1, each: 10, label: '13 题 · 计算' },
      { kind: 'calc', count: 1, each: 12, label: '14 题 · 计算' },
      { kind: 'calc', count: 1, each: 16, label: '15 题 · 计算' },
    ],
  },
  {
    subjectCode: 'history',
    subjectName: '历史',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'confirmed',
    sources: ['https://www.scsqw.cn/scyx/scgkt/2000nyh/wkzhnlcs/content_183768'],
    note: '**第 18 题是开放性设问**（指出疑点—结合史实阐释—得出结论，小论文型）。',
    groups: [
      { kind: 'single', count: 16, each: 3, objective: true, label: '一、单项选择题' },
      { kind: 'reading', count: 1, each: 17, label: '17 题 · 材料分析（2 问）', subCount: 2 },
      { kind: 'essay', count: 1, each: 17, label: '18 题 · 开放性设问' },
      { kind: 'reading', count: 1, each: 18, label: '19 题 · 材料分析（2 问）', subCount: 2 },
    ],
  },
  {
    subjectCode: 'politics',
    subjectName: '政治',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'inferred',
    sources: ['https://www.jinchutou.com/shtml/498a370f14ce9791a74d7e25d06bb92a.html'],
    note: '客观 48 / 主观 52 已核实；**19、20 题各自的分值没查到**（合计 26 分），请老师填。',
    groups: [
      { kind: 'single', count: 16, each: 3, objective: true, label: '一、单项选择题' },
      { kind: 'reading', count: 1, each: 16, label: '17 题（6 分 + 10 分两问）', subCount: 2 },
      { kind: 'reading', count: 1, each: 10, label: '18 题' },
      { kind: 'essay', count: 2, each: 13, label: '19、20 题（合计 26 分，**逐题待确认**）' },
    ],
  },
  {
    subjectCode: 'geography',
    subjectName: '地理',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'confirmed',
    sources: ['https://www.renrendoc.com/paper/491993414.html'],
    note: '客观 48 / 主观 52。第 19 题 22 分（4 问），是卷面上最大的一道主观题。',
    groups: [
      { kind: 'single', count: 16, each: 3, objective: true, label: '一、单项选择题' },
      { kind: 'reading', count: 1, each: 14, label: '17 题' },
      { kind: 'reading', count: 1, each: 16, label: '18 题' },
      { kind: 'reading', count: 1, each: 22, label: '19 题（4 问）', subCount: 4 },
    ],
  },
  {
    subjectCode: 'chemistry',
    subjectName: '化学',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'inferred',
    sources: ['https://www.jinchutou.com/shtml/85feef3d0b6449232c9701ec3cdc58f2.html'],
    note: '客观 45 / 主观 55 已核实（15 题 × 3 分 + 4 道非选择共 55 分）；**4 道非选择题各自的分值没查到**。',
    groups: [
      { kind: 'single', count: 15, each: 3, objective: true, label: '一、单项选择题' },
      { kind: 'experiment', count: 1, each: 14, label: '16 题 · 实验（分值待确认）' },
      { kind: 'reading', count: 1, each: 14, label: '17 题 · 工艺流程（分值待确认）' },
      { kind: 'calc', count: 1, each: 14, label: '18 题 · 反应原理（分值待确认）' },
      { kind: 'calc', count: 1, each: 13, label: '19 题 · 有机合成（分值待确认）' },
    ],
  },
  {
    subjectCode: 'biology',
    subjectName: '生物',
    fullScore: 100,
    minutes: 75,
    by: '四川省自主命题',
    confidence: 'inferred',
    sources: ['https://www.jinchutou.com/shtml/57fdd2056b439f827f07042665f932e1.html'],
    note: '客观 45 / 主观 55 已核实；**5 道非选择题各自的分值没查到**，请老师按实际卷子填。',
    groups: [
      { kind: 'single', count: 15, each: 3, objective: true, label: '一、单项选择题' },
      { kind: 'reading', count: 5, each: 11, label: '二、非选择题（各题分值待确认）' },
    ],
  },
  {
    subjectCode: 'it',
    subjectName: '信息技术',
    fullScore: 100,
    minutes: 60,
    by: '四川省合格考（无纸化机考）',
    confidence: 'sample',
    sources: ['https://www.renrendoc.com/paper/328517161.html'],
    note: '只找到**样卷**，不是当年实考卷；合格考成绩只记"合格/不合格"。',
    groups: [
      { kind: 'single', count: 20, each: 2, objective: true, label: '一、单选题' },
      { kind: 'judge', count: 10, each: 2, objective: true, label: '二、判断题' },
      { kind: 'experiment', count: 2, each: 5, label: '操作题 1（流程完善 6 + 数据处理 4）' },
      { kind: 'experiment', count: 2, each: 10, label: '操作题 2（功能搭建 10 + 程序改错补全 10）' },
      { kind: 'experiment', count: 1, each: 10, label: '操作题 3（结构图拖放补充）' },
    ],
  },
  {
    subjectCode: 'general_tech',
    subjectName: '通用技术',
    fullScore: 100,
    minutes: 60,
    by: '四川省合格考（**由市州命题**）',
    confidence: 'sample',
    sources: ['https://www.renrendoc.com/paper/214045896.html'],
    note: '只找到样卷；且通用技术现由**各市州命题**，不同市州的题型结构可能不同。',
    groups: [
      { kind: 'single', count: 20, each: 3, objective: true, label: '一、选择题（单选）' },
      { kind: 'judge', count: 5, each: 2, objective: true, label: '二、判断题' },
      { kind: 'other', count: 1, each: 10, label: '三、作图题（补三视图）' },
      { kind: 'other', count: 1, each: 12, label: '四、连线题' },
      { kind: 'other', count: 1, each: 8, label: '五、设计题' },
    ],
  },
]

/** 按学科 code 取预设（没有就返回 undefined —— **不编一个出来**） */
export function presetOf(subjectCode?: string | null): SubjectExamPreset | undefined {
  const c = String(subjectCode ?? '').trim()
  return c ? EXAM_PRESETS.find((p) => p.subjectCode === c) : undefined
}

/** 预设展开成"题号 → 题目结构"（建档页一键套用） */
export function expandPreset(p: SubjectExamPreset): {
  questionCount: number
  questions: Record<string, { no: number; kind: ExamQuestionKind; fullScore: number }>
} {
  const questions: Record<string, { no: number; kind: ExamQuestionKind; fullScore: number }> = {}
  let no = 0
  for (const g of p.groups) {
    for (let i = 0; i < g.count; i++) {
      no++
      questions[String(no)] = { no, kind: g.kind, fullScore: g.each }
    }
  }
  return { questionCount: no, questions }
}

/** 预设里客观题的题数（给老师一个"我会记多少个选项"的预期） */
export function presetChoiceCount(p: SubjectExamPreset): number {
  return p.groups.reduce((n, g) => n + (isChoiceKind(g.kind) ? g.count : 0), 0)
}

/** 预设的小计（用来核"加起来是不是满分"） */
export function presetTotal(p: SubjectExamPreset): number {
  return p.groups.reduce((n, g) => n + g.count * g.each, 0)
}
