import type { Assignment, Student } from '../data/types'
import { archiveHas } from './keys'

/* ---------------- 题量：I8 的守门人（**只在这里定义一次**） ---------------- */

/**
 * `assignments.question_count` 的合法区间，**与数据库的 check 约束一一对应**：
 * `schema.sql` 里写的是 `check (question_count between 1 and 60)`。
 *
 * 🔴 为什么不变量 I8 要求「守门人在 store，而不在页面」：
 *    越界值不会报错，只会让**整条 upsert 被拒**（PostgREST 把 22P02/23514 当成一次失败），
 *    而云端模式本地不做持久化（§一「云端是主副本」）——
 *    界面上写着"已导入"，刷新之后这份档案连同收缴、批改一起没了。
 *    页面自己夹是**第二道闸**（「补导入题目」还要据此告诉老师"只记了前 60 题"），
 *    但新加一条写入路径的人不会记得去夹，所以最后一道必须在 `store` 的写入路径上。
 */
export const QUESTION_MIN = 1
export const QUESTION_MAX = 60

/**
 * 把任意输入夹到 1–60 的整数。
 * 非数字（`''` / `undefined` / 乱码）→ 1；小数四舍五入（数据库那一列是 int，
 * 传 6.5 过去同样会被整条拒掉）。
 */
export function clampQuestionCount(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return QUESTION_MIN
  return Math.max(QUESTION_MIN, Math.min(QUESTION_MAX, Math.round(v)))
}

/* ---------------- 收缴统计 ---------------- */

export type CollectStats = {
  total: number
  submitted: number
  missing: number
  late: number
  /** 登记完成度：未交 + 迟交 + 已交 是否覆盖全员 */
  registered: boolean
}

export function collectStats(students: Student[], a: Assignment): CollectStats {
  const active = students.filter((s) => s.status === 'active')
  const total = active.length
  /*
   * 「未交 / 迟交」按**学生**数，不按键的个数：
   * 键已经是序列号（迁移后），而这里要回答的是"名单里还有几个人没交"。
   * 走 `archiveHas` = 两条路（序列号 / 班内学号）任一命中即算。
   */
  const missing = active.filter((s) => archiveHas(a.missingNos, s)).length
  const late = active.filter((s) => archiveHas(a.lateNos, s)).length
  return {
    total,
    submitted: Math.max(0, total - missing),
    missing,
    late,
    registered: a.collected,
  }
}

/* ---------------- 学号识别结果的校验 ---------------- */

export type ScanAnalysis = {
  /** 重复出现的学号 —— 说明可能有号码被误读 */
  dupNos: string[]
  /** 花名册里存在、但这次没识别到的学号 —— 可能未交，也可能只是没拍到 */
  unreadable: string[]
  /** 识别到了但花名册里没有的学号 */
  unknown: string[]
  /**
   * 推断出的误读对：把 from 读成了 to（to 因此出现两次）。
   * 依据是「跳号 + 重号」相邻——这是查缺场景里最常见的一类错误。
   */
  likelyMisread: Array<{ from: string; to: string }>
  suspicious: boolean
}

export function analyzeScan(detected: string[], allNos: string[]): ScanAnalysis {
  const counts = new Map<string, number>()
  for (const n of detected) counts.set(n, (counts.get(n) ?? 0) + 1)

  const dupNos = [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n)
  const unreadable = allNos.filter((n) => !counts.has(n))
  const unknown = detected.filter((n) => !allNos.includes(n))

  // 重号与相邻跳号配对，推断「把某号读成了某号」
  const likelyMisread: Array<{ from: string; to: string }> = []
  const claimed = new Set<string>()
  for (const dup of dupNos) {
    const d = Number(dup)
    const near = unreadable.find(
      (g) => !claimed.has(g) && (Math.abs(Number(g) - d) === 1 || Number(g) === d),
    )
    if (near) {
      likelyMisread.push({ from: near, to: dup })
      claimed.add(near)
    }
  }

  return {
    dupNos,
    unreadable,
    unknown,
    likelyMisread,
    suspicious: dupNos.length > 0 || unknown.length > 0,
  }
}

/* ---------------- 拍照查缺的模拟识别 ---------------- */

/**
 * 模拟「拍一摞作业的侧面」的识别结果。
 * 刻意制造一处误读（把某个号读成了另一个已存在的号），
 * 用来触发序列自检 —— 这正是准确率的保障机制。
 */
export function simulateCollectScan(allNos: string[]): { detected: string[]; misreadFrom: string | null } {
  const nums = allNos.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (nums.length === 0) return { detected: [], misreadFrom: null }

  const total = nums.length
  const missingCount = Math.max(1, Math.min(3, Math.round(total * 0.07)))
  const missing = new Set<number>()
  for (let i = 0; i < missingCount; i++) {
    const idx = Math.floor(((i + 1) * total) / (missingCount + 1)) - 1
    missing.add(nums[Math.max(0, Math.min(total - 1, idx))])
  }

  const detected = nums.filter((n) => !missing.has(n)).map(String)

  let misreadFrom: string | null = null
  if (detected.length > 6) {
    const i = Math.floor(detected.length * 0.62)
    misreadFrom = detected[i]
    detected[i] = detected[i - 1]
  }

  return { detected, misreadFrom }
}

/* ---------------- 展示辅助 ---------------- */

export function submissionLabel(stats: CollectStats): string {
  if (!stats.registered) return '未登记'
  return `${stats.submitted}/${stats.total}`
}
