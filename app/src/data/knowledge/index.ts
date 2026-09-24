/* ============================================================
   知识树总索引 —— **按学科 code 取树的唯一入口**
   ------------------------------------------------------------
   一个学科一个文件，这个文件把它们缝起来：

     学科 code（`lib/subjects.ts` 的 SubjectCode）
        → `data/knowledge/<code>.ts` 的 <CODE>_TREE（若干本教材）
        → 教材（年级 + 版本）
        → 章节 KnowledgeChapter            ← 形状与搬家前**完全一致**
        → 知识点 KnowledgePoint             ← 形状与搬家前**完全一致**

   🔴 **"暂时缺某一科"必须是空数组，不是报错**（这条是硬要求）：
      `REGISTRY` 里没登记的 code、登记了但 `textbooks: []` 的空树、
      年级/版本过滤后没有匹配 —— **一律返回 `[]`**。
      老师那边看到的是"这一科还没有知识树"，不是白屏。
      所以本文件里没有任何一处 `throw`，取用函数也不返回 `null`。

   🔴 **九科各写各的文件，谁都不用改这个文件**：REGISTRY 里每一科
      都已经写好了一行（物理已实现，其余是空树）。要填哪一科，
      就去改**那一科自己的文件**（把 `textbooks` 里的 `chapters: []` 填上），
      别的文件一个字都不用动，也就不存在互相踩。

   ⚠️ 这个文件**只做查询与拼装，不放任何学科正文**；
     正文一律在 `<code>.ts` 里（见 `physics.ts` 的写法）。
   ============================================================ */

import { asSubjectCode, type SubjectCode } from '../../lib/subjects'
import type { Grade, KnowledgeChapter, KnowledgePoint, KnowledgeTree, Textbook } from './types'
import { ART_TREE } from './art'
import { BIOLOGY_TREE } from './biology'
import { CHEMISTRY_TREE } from './chemistry'
import { CHINESE_TREE } from './chinese'
import { ENGLISH_TREE } from './english'
import { GENERAL_TECH_TREE } from './general_tech'
import { GEOGRAPHY_TREE } from './geography'
import { HISTORY_TREE } from './history'
import { IT_TREE } from './it'
import { MATH_TREE } from './math'
import { MENTAL_HEALTH_TREE } from './mental_health'
import { MUSIC_TREE } from './music'
import { PE_TREE } from './pe'
import { PHYSICS_TREE } from './physics'
import { POLITICS_TREE } from './politics'

export type { Grade, KnowledgeChapter, KnowledgePoint, KnowledgeTree, Textbook } from './types'
export { GRADES, ID_PREFIXES, MAX_POINTS } from './types'
export type { NineSubjectCode } from './types'

/**
 * 物理那棵树（教科版）—— **唯一的现成样本**。
 * ⚠️ 它今天横跨三个年级（力学是高一前置、电磁是高二高三），所以没有 `grade`；
 *    `chaptersOf('physics', '高一')` 会把 5 章全给出来，这是刻意的，别改。
 */
export { PHYSICS_TREE }

/**
 * 空树 —— **缺一科时的返回值**，不是 `undefined`。
 * 取用函数全都基于它，所以"没写这一科"走的路径与"写了但是空的"完全一样。
 */
function emptyTree(code: SubjectCode): KnowledgeTree {
  return { subject: code, textbooks: [] }
}

/**
 * 学科 code → 该科的树。
 *
 * ⚠️ 用**函数**而不是直接放对象：模块初始化时只跑这 15 个 `() => …`，
 *    每棵树本身要等第一次取用才求值（`loaded` 缓存住）——
 *    将来某一科大到几千个知识点时，语文老师打开平台不必付物理的代价。
 */
const REGISTRY: Record<SubjectCode, (code: SubjectCode) => KnowledgeTree> = {
  chinese: () => CHINESE_TREE,
  math: () => MATH_TREE,
  english: () => ENGLISH_TREE,
  physics: () => PHYSICS_TREE,
  chemistry: () => CHEMISTRY_TREE,
  biology: () => BIOLOGY_TREE,
  politics: () => POLITICS_TREE,
  history: () => HISTORY_TREE,
  geography: () => GEOGRAPHY_TREE,
  it: () => IT_TREE,
  general_tech: () => GENERAL_TECH_TREE,
  pe: () => PE_TREE,
  music: () => MUSIC_TREE,
  art: () => ART_TREE,
  mental_health: () => MENTAL_HEALTH_TREE,
}

const EMPTY_BY_CODE = new Map<string, KnowledgeTree>()
const loaded = new Map<string, KnowledgeTree>()

/**
 * 取某一科的树。**永远有值**：认不出的 code / 缺那一科 → 空树。
 * （认不出来时**不猜**，与 `lib/subjects.ts` 的 `asSubjectCode` 同一条纪律。）
 */
export function treeOf(code?: string | null): KnowledgeTree {
  const c = asSubjectCode(code)
  if (!c) return emptyTree('physics') // 认不出 → 空树（`subject` 只是占位，取用函数不看它）
  const hit = loaded.get(c)
  if (hit) return hit
  const cached = EMPTY_BY_CODE.get(c)
  if (cached) return cached
  const build = REGISTRY[c]
  const tree = build ? build(c) : emptyTree(c)
  if (tree.textbooks.length === 0) EMPTY_BY_CODE.set(c, tree)
  else loaded.set(c, tree)
  return tree
}

/**
 * 这一科现在**有没有正文**（至少要有一章）。
 *
 * ⚠️ 判据是"有章节"，不是"有教材"：九科的占位文件里都写了
 *    `{ version: '人教版', chapters: [] }` —— 教材有、正文没有，
 *    那种状态对界面来说跟"没写"是一回事，**只用来显示"这一科还没有知识树"**，
 *    不要拿它当权限判据。
 */
export function hasKnowledgeTree(code?: string | null): boolean {
  return treeOf(code).textbooks.some((tb) => tb.chapters.length > 0)
}

/** 教材的年级过滤：没标 grade 的教材 = 不分年级，**任何年级都能取到** */
function inGrade(tb: Textbook, g?: Grade): boolean {
  return g === undefined || tb.grade === undefined || tb.grade === g
}

/**
 * 取这一科的教材（含年级与版本）。
 *
 * 不传 `grade` = 全部年级；不传 `version` = 全部版本。
 * 例：`textbooksOf('physics')` → 1 本（教科版，不分年级）；
 *     `textbooksOf('math', '高一')` → 高一那本。
 */
export function textbooksOf(code?: string | null, grade?: Grade, version?: string): Textbook[] {
  return treeOf(code).textbooks.filter((tb) => inGrade(tb, grade) && (version === undefined || tb.version === version))
}

/**
 * 取章节 —— **最常用的那个**：`chaptersOf('physics', '高一')`。
 *
 * 语义（定死，别各自理解）：
 *   · `grade` 不传 → 该科**全部**章节（各版本合并）；
 *   · `grade` 传了 → 只留那一本的章节，外加**没标年级的教材**里的章节
 *     （"不分年级"的东西任何年级都该看见，见 `types.ts` 的 `Grade` 注释）；
 *   · `version` 传了 → 再按版本收一道（同一科多个版本并存时才用得上）；
 *   · 这一科没写 / 没有匹配 → `[]`。
 *
 * 版本合并**不去重**：跨版本本来就可能有同名章节，去重会把两本书的内容
 * 悄悄吞掉一本。要按版本分开看就传 `version`，或者用 `textbooksOf`。
 */
export function chaptersOf(code: string | null | undefined, grade: Grade): KnowledgeChapter[]
export function chaptersOf(code: string | null | undefined, grade: Grade, version: string): KnowledgeChapter[]
export function chaptersOf(code?: string | null): KnowledgeChapter[]
export function chaptersOf(code?: string | null, grade?: Grade, version?: string): KnowledgeChapter[] {
  return textbooksOf(code, grade, version).flatMap((tb) => tb.chapters)
}

/**
 * 取章节，但**每章都知道自己是哪个年级的** —— 界面要按年级分组时用它。
 * 顺序 = 数据里教材的书写顺序（约定按 高一 → 高二 → 高三 写），
 * "不分年级"（没写 `grade`）的教材排在它实际所在的位置，不额外重排。
 */
export function gradeChaptersOf(code?: string | null): Array<{ grade?: Grade; chapter: KnowledgeChapter }> {
  const out: Array<{ grade?: Grade; chapter: KnowledgeChapter }> = []
  for (const tb of treeOf(code).textbooks) {
    for (const chapter of tb.chapters) out.push({ grade: tb.grade, chapter })
  }
  return out
}

/** 取某一章的知识点；不传 `chapterId` = 该科所有知识点（打标要用全量） */
export function pointsOf(code?: string | null, chapterId?: string): KnowledgePoint[] {
  const tree = treeOf(code)
  if (chapterId === undefined) return tree.textbooks.flatMap((tb) => tb.chapters).flatMap((c) => c.points)
  for (const tb of tree.textbooks) {
    for (const c of tb.chapters) if (c.id === chapterId) return c.points
  }
  return []
}

/* ---------------- 按 id 找东西（id → 名字/章节/学科） ---------------- */

type IdIndex = {
  /** 知识点 id → 知识点 */
  points: Map<string, KnowledgePoint>
  /** 知识点 id → 所属章节（拿的是 `chapter.name`，与历史行为一致） */
  chapters: Map<string, KnowledgeChapter>
}

const idIndexes = new Map<string, IdIndex>()

function indexOf(c: SubjectCode): IdIndex {
  const hit = idIndexes.get(c)
  if (hit) return hit
  const points = new Map<string, KnowledgePoint>()
  const chapters = new Map<string, KnowledgeChapter>()
  for (const tb of treeOf(c).textbooks) {
    for (const ch of tb.chapters) {
      for (const p of ch.points) {
        // 同一科内撞 id：**先写的那条赢**（与全局表的"后者不覆盖"一致），不抛错
        if (!points.has(p.id)) {
          points.set(p.id, p)
          chapters.set(p.id, ch)
        }
      }
    }
  }
  const idx: IdIndex = { points, chapters }
  idIndexes.set(c, idx)
  return idx
}

/**
 * 按知识点 id 找那一科的 id 索引。
 *
 * ⚠️ id 是**全局裸 id**，所以必须跨学科找 —— 先问 `lib/knowledge.ts` 的
 *    全局表（它算一次就缓存住），找不到再线性扫一遍（认不出的 id 走这里，
 *    保证不抛错）。
 */
function findPoint(id?: string | null): { code: SubjectCode; tree: KnowledgeTree; point?: KnowledgePoint } | undefined {
  const key = String(id ?? '').trim()
  if (!key) return undefined
  for (const s of Object.keys(REGISTRY) as SubjectCode[]) {
    const found = indexOf(s).points.get(key)
    if (found) return { code: s, tree: treeOf(s), point: found }
  }
  return undefined
}

/**
 * 取知识点名字。**找不到返回 `undefined`**（调用方自己决定显示"未归类"还是别的）
 * —— 与搬家前的 `POINT_NAME[id]` 行为一致，老代码不用改。
 */
export function pointById(id?: string | null): KnowledgePoint | undefined {
  return findPoint(id)?.point
}

/** 取知识点名字，一步到位：`pointName('coulomb') === '电荷与库仑定律'` */
export function pointName(id?: string | null): string | undefined {
  return findPoint(id)?.point?.name
}

/** 取知识点**所属章节**（章节对象，能拿到 `id` 和 `name`） */
export function chapterOfPoint(id?: string | null): KnowledgeChapter | undefined {
  const code = pointSubject(id)
  return code ? indexOf(code).chapters.get(String(id).trim()) : undefined
}

/**
 * 这个知识点是**哪一科**的 —— 从 id 反查学科。
 *
 * 用途：作业/错题集里只存了裸 id，界面要按学科分组时靠它。
 * ⚠️ 找不到返回 `undefined`（**不猜**，见 §12.3 I14）。
 */
export function pointSubject(id?: string | null): SubjectCode | undefined {
  return findPoint(id)?.code
}
