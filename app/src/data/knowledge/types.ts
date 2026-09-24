/* ============================================================
   知识树的数据形状 —— **全仓唯一来源**
   ------------------------------------------------------------
   一门课的知识体系要能回答五个问题，缺一个统计就退化成"一堆题号"：

     学科  →  年级（高一/高二/高三）  →  教材版本  →  章节  →  知识点

   ⚠️ **章节与知识点这两层的形状一个字都没改**，跟搬家前的
      `lib/knowledge.ts` 完全一致（`{ id, name, points: [{ id, name, keywords }] }`）：
      这两层已经够用，改了只会让所有读旧字段的地方白改一遍。
      **新加的只有它们外面那两层——年级与教材版本**：

        · 一个学科一个文件（`data/knowledge/<code>.ts`），文件里是 **若干本教材**；
        · 一本教材 = `{ grade, version, chapters }`，
          `chapters` 就是旧的那个章节数组，**原样搬进来、一行没动**。

      为什么用"多本教材"而不是"给章节点加一个 grade 字段"：
        ① **最小改动** —— 旧的章节数组可以直接当 `chapters` 用；
        ② 年级 + 版本是**教材的属性，不是章节的属性** —— 同一个学科里
           "人教版必修一（高一）"与"教科版必修三（高二）"是两本书，
           按章节点散着标 grade，查询时还得去重，反而更容易标错标漏；
        ③ 老师脑子里的组织方式就是"这本书"（哪本、哪个年级用）。

   ⚠️ **学科 code 只有一处来源：`lib/subjects.ts`**（15 科，`SubjectCode`）。
      这里**不再写一份学科数组**（见 `功能设计与不变量.md` §12.1）。

   ⚠️ **年级是三选一的定值，不是老师的班级**：
      `Grade` 是**教材/知识树的年级**（高一/高二/高三），
      跟 `studentClass`（班级）是两件事，别当成一个维度用。
      没标 `grade` 的教材 = **不分年级**（体育/音乐/美术/心理健康多半这样），
      它在任何年级查询里都返回得出来（见 `index.ts` 的 `chaptersOf` 注释）。
   ============================================================ */

import type { SubjectCode } from '../../lib/subjects'

/**
 * 教材的年级。
 *
 * 🔴 只有这三个值，写别的编译期就过不去 —— 因为它是**数据维度**，
 *    一旦允许自由文本（"高一上"、"2024级"）就再也归不了类。
 */
export type Grade = '高一' | '高二' | '高三'

/** 年级的规范顺序（界面上按这个排；不要在页面里再写一遍数组） */
export const GRADES: readonly Grade[] = ['高一', '高二', '高三']

export type KnowledgePoint = {
  /** 唯一 id，存进数据库用 */
  id: string
  name: string
  /** 命中任一关键词即算打上这个标签；按权重从高到低排 */
  keywords: string[]
}

export type KnowledgeChapter = {
  id: string
  name: string
  points: KnowledgePoint[]
}

/**
 * 一本教材。
 *
 * `grade` 缺省 = 不分年级；`version` 写"教科版 / 人教版 / 沪科版…"。
 */
export type Textbook = {
  grade?: Grade
  version: string
  chapters: KnowledgeChapter[]
}

/**
 * 一个学科的知识体系。
 *
 * ⚠️ **一个学科一个文件、只导出这一个对象**（外加它自己的教材常量），
 *    文件里**不写任何逻辑**：没有查询函数、没有 `if (subject === …)`。
 *    九科的 agent 各写各的文件，**不用碰公共文件**，也就不存在互相踩。
 */
export type KnowledgeTree = {
  /** 学科 code，取自 `lib/subjects.ts` 的 `SubjectCode` */
  subject: SubjectCode
  /**
   * 这个学科用的教材。顺序 = 展示顺序（建议按 高一 → 高二 → 高三 排）。
   * **暂时写不出内容就留空数组 `[]`** —— 取用函数对空树返回空数组，不报错。
   */
  textbooks: Textbook[]
}

/**
 * 一个知识点最多挂几个标签 —— 挂太多等于没分类。
 * 打标函数（`lib/knowledge.ts`）与将来的人工修正界面都用这一个数。
 */
export const MAX_POINTS = 3

/**
 * 九科的 **id 前缀**（全仓只此一份）。
 *
 * 🔴 **知识点 id 一律 `前缀-英文短名`，章节 id 一律 `前缀-ch-英文短名`**，
 *    例：数学函数单调性 = `mat-monotonicity`，语文文言实词 = `chn-content-word`。
 *
 *    为什么必须带前缀：数据库里 `QuestionMeta.points` 存的是**裸 id**，
 *    而 `POINT_NAME` / `POINT_CHAPTER` 是**全局表**。第二个学科一旦写一个
 *    也叫 `energy` 的 id，两科的显示名会互相覆盖，而且**不报错**
 *    —— 这正是老 `lib/knowledge.ts` 头上警告过的那件事。
 *
 *    ⚠️ **物理是唯一例外**：它那批裸 id（`coulomb` / `ohm` …）已经写进
 *       历史档案、不迁移，所以 `physics.ts` 里**一个 `phy-` 都没有**。
 *       表里留着 `phy` 只是让九科的形状整齐；物理新增的点若真与别科撞名，
 *       才需要用它。**别"顺手统一"去给物理的老 id 加前缀** ——
 *       那会让历史错题集全部变成「未归类」。
 *
 * 用法：`idPrefixOf('math') === 'mat'`；九科之外（体育/音乐…）目前走不到，
 * 将来要加就在这张表里加一行，**不要在页面里拼前缀**。
 */
export const ID_PREFIXES = {
  chinese: 'chn',
  math: 'mat',
  english: 'eng',
  physics: 'phy',
  chemistry: 'chem',
  biology: 'bio',
  politics: 'pol',
  history: 'his',
  geography: 'geo',
} as const

/** 有前缀约定（也就是"有正文要写"）的九科 code */
export type NineSubjectCode = keyof typeof ID_PREFIXES
