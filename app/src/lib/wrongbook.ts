import type { Assignment, Klass, Student } from '../data/types'
import { isQuestionWrong } from './grading'
import { archiveValue } from './keys'
import { POINT_CHAPTER, POINT_NAME } from './knowledge'

/* ============================================================
   错题集：把一个学生历次作业的错题，按知识点聚起来

   关键设计：一道题可能挂多个知识点，**丢分按挂的个数均摊** ——
   不然同一道题会在几个知识点上各记一次满分，排行就虚高了。
   ============================================================ */

export type WrongItem = {
  assignmentId: string
  assignmentTitle: string
  date: string
  seq: number
  subCount: number
  score?: number
  stem?: string
  imgs?: string[]
  points: string[]
  /** 这道题全班多少人错（0–1）—— 用来分辨「只有他不会」还是「大家都不行」 */
  classRate: number
  /** 这道题他丢的分（已按知识点个数均摊后的原值，展示用） */
  lost: number
}

export type PointLoss = {
  pointId: string
  name: string
  chapter: string
  /** 错了多少次 */
  times: number
  /** 累计丢了约多少分（同一题多知识点时均摊） */
  lost: number
  items: WrongItem[]
}

export type WrongBook = {
  studentNo: string
  name: string
  /** 错题总次数 */
  totalWrong: number
  /** 累计丢分 */
  totalLost: number
  /** 按丢分从多到少 */
  points: PointLoss[]
  /** 按时间从新到旧 */
  items: WrongItem[]
}

/**
 * 只有逐题记录过的作业才有错题可算 —— 极简模式不进错题集。
 *
 * ⚠️ 这个判据**必须只有一处**：它是"这份作业能不能进错题集"的唯一入口，
 * 页面上的「已批改作业数」也要用它来数（见 WrongBook 班级列表）。
 * 若页面自己写一遍 `status === 'graded'`，极简模式的档案就会被算进来 ——
 * 而它没有任何逐题数据，最后渲染成"全班全对"这种看起来很正常、其实错了的结论。
 */
export const ranked = (a: Assignment) =>
  (a.status === 'graded' || a.status === 'reviewed') && a.statsMode !== 'simple'

/** 某个班有多少份「能进错题集」的作业 —— 供列表页显示与空态判定 */
export const rankedCountOf = (classId: string, assignments: Assignment[]) =>
  assignments.filter((a) => a.classId === classId && ranked(a)).length

/** 一个班、一份作业里，每道题的全班错误率 */
function classRates(students: Student[], a: Assignment): number[] {
  const active = students.filter((s) => s.status === 'active')
  const n = active.length || 1
  return Array.from({ length: a.questionCount }, (_, i) => {
    const seq = i + 1
    const sub = a.subQuestions[String(seq)] ?? 0
    return active.filter((s) => isQuestionWrong(archiveValue(a.wrong, s), seq, sub)).length / n
  })
}

export function buildWrongBook(
  student: Student,
  klass: Klass | undefined,
  assignments: Assignment[],
): WrongBook {
  const all = klass?.students ?? []
  const mine = assignments
    .filter((a) => a.classId === klass?.id && ranked(a))
    .sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1))

  const items: WrongItem[] = []
  let totalWrong = 0
  let totalLost = 0

  for (const a of mine) {
    const rates = classRates(all, a)
    const wrongKeys = archiveValue(a.wrong, student) ?? []
    if (!wrongKeys.length) continue

    for (let i = 0; i < a.questionCount; i++) {
      const seq = i + 1
      const sub = a.subQuestions[String(seq)] ?? 0
      if (!isQuestionWrong(wrongKeys, seq, sub)) continue

      const meta = a.questionMeta?.[String(seq)]
      const score = meta?.score
      const pts = meta?.points ?? []
      // 有小题时按错的小题比例折算
      let ratio = 1
      if (sub > 0) {
        let bad = 0
        for (let k = 1; k <= sub; k++) if (wrongKeys.includes(`${seq}.${k}`)) bad++
        ratio = sub ? bad / sub : 1
      }
      const lost = score === undefined ? 0 : score * ratio

      totalWrong++
      totalLost += lost

      items.push({
        assignmentId: a.id,
        assignmentTitle: a.title,
        date: a.assignDate,
        seq,
        subCount: sub,
        score,
        stem: meta?.stem,
        imgs: meta?.imgs,
        points: pts,
        classRate: rates[i] ?? 0,
        lost,
      })
    }
  }

  /* 按知识点聚合 */
  const map = new Map<string, PointLoss>()
  for (const it of items) {
    const pts = it.points.length ? it.points : ['__none__']
    const share = it.lost / pts.length
    for (const p of pts) {
      const e =
        map.get(p) ??
        ({
          pointId: p,
          name: POINT_NAME[p] ?? '未归类',
          chapter: POINT_CHAPTER[p] ?? '其他',
          times: 0,
          lost: 0,
          items: [],
        } satisfies PointLoss)
      e.times++
      e.lost += share
      e.items.push(it)
      map.set(p, e)
    }
  }

  return {
    studentNo: student.studentNo,
    name: student.name,
    totalWrong,
    totalLost,
    points: [...map.values()].sort((x, y) => y.lost - x.lost || y.times - x.times),
    items,
  }
}

/* ---------------- 班级视图的原料（下一步用） ---------------- */

export type ClassPointLoss = PointLoss & {
  /** 这个知识点上，班里有多少人错过 */
  studentsHit: number
  /** 全班在这上面的总丢分 */
  classLost: number
  /** 分布在几份作业里 —— 跨作业反复错 = 真高频错点 */
  spread: number
}

export function buildClassWrongBook(
  klass: Klass | undefined,
  assignments: Assignment[],
): { points: ClassPointLoss[]; totalStudents: number } {
  const students = (klass?.students ?? []).filter((s) => s.status === 'active')
  const books = students.map((s) => ({ s, b: buildWrongBook(s, klass, assignments) }))

  const map = new Map<string, ClassPointLoss & { who: Set<string>; asg: Set<string> }>()
  for (const { s, b } of books) {
    for (const p of b.points) {
      const e =
        map.get(p.pointId) ??
        ({
          ...p,
          items: [],
          times: 0,
          lost: 0,
          studentsHit: 0,
          classLost: 0,
          spread: 0,
          who: new Set<string>(),
          asg: new Set<string>(),
        } as ClassPointLoss & { who: Set<string>; asg: Set<string> })
      e.times += p.times
      e.lost += p.lost
      e.classLost += p.lost
      e.who.add(s.studentNo)
      /*
       * ⚠️ items 必须往里塞，否则班级错题重练卷永远生成不出来。
       * 之前这里只喂了 asg（去重计数用），items 一直是空数组 ——
       * WrongBook 的「生成班级错题重练卷」遍历 p.items 建集合，
       * 恒为空 → 每次都弹「一个知识点都没勾，没法出卷」。
       * 同一个学生可能被多个班/多次记录命中，所以按 (作业, 题号) 去重。
       */
      for (const it of p.items) {
        e.asg.add(it.assignmentId)
        if (!e.items.some((x) => x.assignmentId === it.assignmentId && x.seq === it.seq)) {
          e.items.push(it)
        }
      }
      map.set(p.pointId, e)
    }
  }

  const points = [...map.values()]
    .map((e) => ({
      ...e,
      studentsHit: e.who.size,
      spread: e.asg.size,
    }))
    .sort((x, y) => y.classLost - x.classLost)

  return { points, totalStudents: students.length }
}
