/* ============================================================
   高中物理知识体系 + 自动打标
   ------------------------------------------------------------
   为什么要有这棵树：错题集要回答的是「他在哪个知识点上掉分最多」，
   而不是「他错了第 3 题」。没有知识点维度，统计只是一堆题号。

   为什么用关键词匹配而不是再调一次 AI：
     · 一次导入几十道题，逐题调模型既慢又花钱
     · 物理题的关键词辨识度极高（「等势面」「库仑力」「电动势」几乎不会出现在别的章节）
     · **完全本机、零成本、可离线**，符合「AI 是加速器不是必经环节」
   匹配不上的题会落到「未归类」，教师不需要管 —— 有总比没有好，
   而且后续可以再叠加人工修正。
   ============================================================ */

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

export const PHYSICS_TREE: KnowledgeChapter[] = [
  {
    id: 'electrostatic',
    name: '静电场',
    points: [
      {
        id: 'coulomb',
        name: '电荷与库仑定律',
        keywords: ['库仑力', '库仑定律', '点电荷', '元电荷', '电荷量', '带电小球', '带正电', '带负电'],
      },
      {
        id: 'field-strength',
        name: '电场强度与电场线',
        keywords: ['电场强度', '场强', '电场线', '试探电荷', '电场方向', '场强的方向'],
      },
      {
        id: 'potential',
        name: '电势能与电势',
        keywords: ['电势能', '电势', '等势面', '等势线', '电势差', '电势的零点', 'φ'],
      },
      {
        id: 'work-in-field',
        name: '电场力做功',
        keywords: ['电场力做功', '静电力做功', '电场力做', '克服电场力'],
      },
      {
        id: 'uniform-field',
        name: '匀强电场',
        keywords: ['匀强电场', '平行该圆周平面', '等边三角形', '电势分别为'],
      },
      {
        id: 'charge-in-field',
        name: '带电粒子在电场中的运动',
        keywords: ['加速', '偏转', '动能最大', '由静止释放', '往复运动', '初速度'],
      },
      {
        id: 'capacitor',
        name: '电容器与电容',
        keywords: ['电容器', '电容', '极板', '带电微粒', '两板间'],
      },
    ],
  },
  {
    id: 'current',
    name: '恒定电流',
    points: [
      {
        id: 'ohm',
        name: '电流、电阻与电阻定律',
        keywords: ['电阻定律', '电阻率', '导体的电阻', '电流与电压', '伏安特性'],
      },
      {
        id: 'closed-circuit',
        name: '闭合电路欧姆定律',
        keywords: ['电动势', '内阻', '路端电压', '闭合电路', '电源的', '外电路'],
      },
      {
        id: 'power',
        name: '电功与电功率',
        keywords: ['电功', '电功率', '焦耳定律', '发热功率', '额定功率', '消耗的最大功率'],
      },
      {
        id: 'meter-experiment',
        name: '电学实验与多用电表',
        keywords: [
          '描绘',
          'I-U',
          '伏安法',
          '多用电表',
          '欧姆表',
          '滑动变阻器',
          '电流表',
          '电压表',
          '实验装置',
          '读数',
        ],
      },
    ],
  },
  {
    id: 'magnetism',
    name: '磁场',
    points: [
      {
        id: 'ampere',
        name: '磁场与安培力',
        keywords: ['磁感应强度', '安培力', '磁感线', '左手定则', '通电导线'],
      },
      {
        id: 'lorentz',
        name: '洛伦兹力与带电粒子在磁场中运动',
        keywords: ['洛伦兹力', '右手定则', '圆周运动', '回旋', '磁偏转'],
      },
    ],
  },
  {
    id: 'induction',
    name: '电磁感应',
    points: [
      {
        id: 'flux',
        name: '磁通量与楞次定律',
        keywords: ['磁通量', '楞次定律', '感应电流方向', '阻碍'],
      },
      {
        id: 'faraday',
        name: '法拉第电磁感应定律',
        keywords: ['感应电动势', '法拉第', '切割磁感线', '自感'],
      },
    ],
  },
  {
    id: 'mechanics',
    name: '力学（前置）',
    points: [
      {
        id: 'newton',
        name: '牛顿运动定律',
        keywords: ['牛顿第二定律', '加速度', '合外力', '受力分析'],
      },
      {
        id: 'energy',
        name: '功与能',
        keywords: ['动能定理', '机械能守恒', '重力做功', '动能', '重力势能'],
      },
      {
        id: 'circular',
        name: '圆周运动',
        keywords: ['向心力', '向心加速度', '半圆形', '圆弧'],
      },
    ],
  },
]

/** id → 名字，界面展示用 */
export const POINT_NAME: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const c of PHYSICS_TREE) for (const p of c.points) m[p.id] = p.name
  return m
})()

/** id → 所属章节名 */
export const POINT_CHAPTER: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const c of PHYSICS_TREE) for (const p of c.points) m[p.id] = c.name
  return m
})()

/* ---------------- 打标 ---------------- */

/** 每个知识点最多挂几个标签 —— 挂太多等于没分类 */
const MAX_POINTS = 3

/**
 * 给一段题目文字打知识点标签。
 * 关键词长 = 更具体，权重更高；同分时按树的顺序稳定输出。
 */
export function tagQuestion(text: string): string[] {
  if (!text) return []
  const hits: Array<{ id: string; score: number; order: number }> = []
  let order = 0

  for (const c of PHYSICS_TREE) {
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

export const POINT_TEXT = POINT_NAME
