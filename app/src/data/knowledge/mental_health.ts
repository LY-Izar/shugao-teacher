/* ============================================================
   心理健康知识树（占位 —— 本轮九科之外，先让形状齐）
   ------------------------------------------------------------
   为什么空着也要有这个文件：`data/knowledge/index.ts` 按学科 code 取树，
   缺哪一科就返回空树。留着文件是给后面接手的人一个**明确的落点**。

   要填的时候：章节 id 用 `mh-ch-英文短名`、知识点 id 用 `mh-英文短名`
   （前缀规则见 `types.ts` 的 `ID_PREFIXES`，**新学科一定要带前缀**）。
   心理健康按主题（自我认知 / 情绪调节 / 人际交往…）组织、不分年级，
   照这样写（**`grade` 不写** = 任何年级都取得到）：

     textbooks: [
       {
         version: '通用',
         chapters: [
           { id: 'mh-ch-emotion', name: '情绪调节', points: [ { id: 'mh-stress', name: '…', keywords: ['…'] } ] },
         ],
       },
     ],

   ⚠️ `textbooks: []` 是**刻意的空**，不是"忘了写"：
      没正文的学科必须在**每一个取用函数**上都表现为空数组
      （`textbooksOf` / `chaptersOf` / `pointsOf` 全部 `[]`），
      界面才不会给老师弹出一个"什么内容都没有的版本选项"。

   ⚠️ 这个文件只放数据：不写函数、不写 `if`、不 import 别的东西。
   ============================================================ */

import type { KnowledgeTree } from './types'

export const MENTAL_HEALTH_TREE: KnowledgeTree = {
  subject: 'mental_health',
  textbooks: [],
}
