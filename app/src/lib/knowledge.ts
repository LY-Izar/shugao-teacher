/* ============================================================
   知识体系 —— **旧入口（兼容层）** + 自动打标
   ------------------------------------------------------------
   为什么要有知识树：错题集要回答的是「他在哪个知识点上掉分最多」，
   而不是「他错了第 3 题」。没有知识点维度，统计只是一堆题号。

   为什么用关键词匹配而不是再调一次 AI：
     · 一次导入几十道题，逐题调模型既慢又花钱
     · 物理题的关键词辨识度极高（「等势面」「库仑力」「电动势」几乎不会出现在别的章节）
     · **完全本机、零成本、可离线**，符合「AI 是加速器不是必经环节」
   匹配不上的题会落到「未归类」，教师不需要管 —— 有总比没有好，
   而且后续可以再叠加人工修正。

   ------------------------------------------------------------
   🔴 **这个文件现在只剩两件事**，其余全部搬到了 `data/knowledge/`：

     ① **打标**（`tagQuestion` / `tagQuestionIn` / `MAX_POINTS`）——
        它是逻辑，不是数据，所以留在 lib 里；
     ② **兼容层**：把 `data/knowledge/index.ts` 的东西原样再导一遍，
        并派生 `POINT_NAME` / `POINT_CHAPTER` / `POINT_SUBJECT` 三张
        **全局表**。`examParse.ts` / `examDoc.ts` / `wrongbook.ts`
        三个文件今天写的还是 `from './knowledge'`，**它们一行都不用改**。

   ------------------------------------------------------------
   数据形状搬成了什么（详见 `data/knowledge/types.ts` 与 `index.ts`）：

     学科（一个文件） → 教材（年级 + 版本） → 章节 → 知识点

     ⚠️ **章节与知识点两层的形状一个字都没改** —— 还是
        `{ id, name, points: [{ id, name, keywords }] }`，
        所以本文件里读 `p.name` / `c.name` 的老代码继续有效。
        新加的只有外面那两层（年级、教材版本）。

   ------------------------------------------------------------
   🔴 **`POINT_NAME` / `POINT_CHAPTER` 是全局表，这就是"id 必须带学科前缀"的原因**
     （`data/knowledge/types.ts` 的 `ID_PREFIXES`）：
     数据库里 `QuestionMeta.points` 存的是**裸 id**，第二科一旦也写一个
     `energy`，两科会互相覆盖，而且**不报错**。

     今天这两张表是**从全量数据派生**的（不再手写），
     **撞 id 时先写的那一科赢**（顺序 = `SUBJECTS` 的 sort 顺序：
     语文 → 数学 → 英语 → 物理 …）。物理的历史 id 因此不会被任何后来者挤掉。

     要检查有没有人真的撞了：`findPointIdCollisions()`（见文件末尾）。
     修的办法是**给后来那个 id 加学科前缀**，不是改这两张表的合并顺序。
   ============================================================ */

import { PHYSICS_TREE, chaptersOf, pointSubject, treeOf } from '../data/knowledge'
import { SUBJECTS } from './subjects'
// 三个值（前缀表 / 上限 / 年级）**既要再导出、又要在本文件里用**，
// 所以走命名空间拿一份，免得同一模块出现两条 import 同一名字的语句。
import * as KB from '../data/knowledge/types'
import type { Grade, KnowledgeChapter } from '../data/knowledge/types'

/* ---------------- 兼容层：这些名字老代码都在用，不许改名 ---------------- */

export {
  treeOf,
  hasKnowledgeTree,
  textbooksOf,
  chaptersOf,
  gradeChaptersOf,
  pointsOf,
  pointById,
  pointName,
  chapterOfPoint,
  pointSubject,
} from '../data/knowledge'

export type { KnowledgeChapter, KnowledgePoint, KnowledgeTree, Textbook, Grade, NineSubjectCode } from '../data/knowledge/types'

/* ---------------- 全局表（从全量数据派生，撞 id 先写的赢） ---------------- */

type GlobalTables = {
  /** 知识点 id → 名字，界面展示用 */
  name: Record<string, string>
  /** 知识点 id → 所属章节名 */
  chapter: Record<string, string>
  /** 知识点 id → 学科 code（**新增**：作业里只存了裸 id，按学科分组要用它） */
  subject: Record<string, string>
  /** 撞 id 记录，"先写的科 ← 被吃掉的科"，正常情况下是空的 */
  collisions: Record<string, string>
}

const TABLES: GlobalTables = (() => {
  const name: Record<string, string> = {}
  const chapter: Record<string, string> = {}
  const subject: Record<string, string> = {}
  const collisions: Record<string, string> = {}

  for (const s of SUBJECTS) {
    for (const c of chaptersOf(s.code)) {
      for (const p of c.points) {
        if (name[p.id] !== undefined) {
          if (!collisions[p.id]) collisions[p.id] = `${subject[p.id]} ← ${s.code}`
          continue
        }
        name[p.id] = p.name
        chapter[p.id] = c.name
        subject[p.id] = s.code
      }
    }
  }

  return { name, chapter, subject, collisions }
})()

/** id → 名字，界面展示用 */
export const POINT_NAME: Record<string, string> = TABLES.name

/** id → 所属章节名 */
export const POINT_CHAPTER: Record<string, string> = TABLES.chapter

/** id → 学科 code（新的；找不到就是 `undefined`，**不猜**） */
export const POINT_SUBJECT: Record<string, string> = TABLES.subject

export const POINT_TEXT = POINT_NAME

/**
 * 有没有两个学科写了同一个知识点 id。
 *
 * 正常情况返回 `[]`。**它不该在运行时被当作业务逻辑**（撞了也不会抛错，
 * 只是两科的显示名会互相盖），用途只有两个：
 *   · 九科写完之后跑一次核对；
 *   · 加新学科时先自查一遍。
 *
 * 返回形状：`[ 'energy: 物理 ← 化学', … ]`（左边是先写的那一科）。
 */
export function findPointIdCollisions(): string[] {
  return Object.entries(TABLES.collisions).map(([id, who]) => `${id}: ${who}`)
}

/** 某科现在的规模 —— 给报告/自检用，界面不要依赖它 */
export function knowledgeStats(code: string): { textbooks: number; chapters: number; points: number; keywords: number } {
  const books = treeOf(code).textbooks
  const chapters = books.flatMap((tb) => tb.chapters)
  const points = chapters.flatMap((c) => c.points)
  return {
    textbooks: books.length,
    chapters: chapters.length,
    points: points.length,
    keywords: points.reduce((n, p) => n + p.keywords.length, 0),
  }
}

/**
 * 某个知识点 id 在字典里应有的前缀（比如 `mat-monotonicity` → `mat`）。
 * 认不出来返回 `undefined`（不猜）。
 */
export function pointIdPrefix(id?: string | null): string | undefined {
  const s = pointSubject(id)
  if (!s) return undefined
  return (KB.ID_PREFIXES as Record<string, string>)[s]
}

/* ---------------- 打标 ---------------- */

/** 每个知识点最多挂几个标签 —— 挂太多等于没分类（数值在 `data/knowledge/types.ts`） */
export const MAX_POINTS = KB.MAX_POINTS

/** 年级（高一/高二/高三）—— 数据维度，取值只有这三个 */
export const GRADES = KB.GRADES

/** 九科的 id 前缀表 —— 写新知识树时的命名依据，见 `data/knowledge/types.ts` */
export const ID_PREFIXES = KB.ID_PREFIXES

/**
 * 物理那棵树（教科版）。
 * ⚠️ 它今天**横跨三个年级**（力学是高一前置、电磁是高二高三），所以没有 `grade`，
 *    `chaptersOf('physics', '高一')` 会把 5 章全给出来 —— 这是刻意的，别改。
 */
export { PHYSICS_TREE }

/**
 * 给一段题目文字打知识点标签。
 * 关键词长 = 更具体，权重更高；同分时按树的顺序稳定输出。
 *
 * 🔴 **不传学科时只扫物理**（`PHYSICS_TREE`）—— 这是搬家前的老行为，
 *    `examParse.ts` 就靠它，**改这个默认值等于改所有历史打标结果**。
 *    要多学科打标请用 `tagQuestionIn`。
 */
export function tagQuestion(text: string): string[] {
  return tagQuestionIn(text, { subject: 'physics' })
}

export type TagOptions = {
  /** 学科 code（`lib/subjects.ts` 的 `SubjectCode`）。**不传 = 只扫物理**（兼容旧行为） */
  subject?: string | null
  /** 只在这一年级里打标（不传 = 这一科的全部年级） */
  grade?: Grade
}

/**
 * 按学科（可选年级）打标。
 *
 * 为什么 id 全局唯一就能跨学科混着存：`QuestionMeta.points` 存的是裸 id，
 * 而裸 id 有前缀约定（见 `ID_PREFIXES`），所以九科的标签放一个数组里
 * 也不会混。**前提是九科都守前缀约定**。
 */
export function tagQuestionIn(text: string, opts?: TagOptions): string[] {
  const g = opts?.grade
  const chapters = treeOf(opts?.subject ?? 'physics')
    .textbooks.filter((tb) => g === undefined || tb.grade === undefined || tb.grade === g)
    .flatMap((tb) => tb.chapters)
  return tagIn(chapters, text)
}

/** 打标内核：给一批章节 + 一段文字，返回最多 `MAX_POINTS` 个知识点 id */
function tagIn(chapters: KnowledgeChapter[], text: string): string[] {
  if (!text) return []
  const hits: Array<{ id: string; score: number; order: number }> = []
  let order = 0

  for (const c of chapters) {
    for (const p of c.points) {
      let score = 0
      for (const k of p.keywords) {
        if (text.includes(k)) score += k.length // 词越长越具体
      }
      if (score > 0) hits.push({ id: p.id, score, order: order++ })
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_POINTS)
    .map((h) => h.id)
}
