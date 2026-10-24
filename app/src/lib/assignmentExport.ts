import type { Assignment, Student } from '../data/types'
import { archiveValue } from './keys'

/**
 * 作业档案 · **完成情况 + 改错情况** 导出成 CSV（Excel 直接打开）。
 *
 * ============================================================================
 * 用户口径（2026-10-24，原话转述）
 * ============================================================================
 * 「普通模式和极简模式**分开**：普通模式要显示**每道题的答题情况**，极简模式**只写等级**；
 *   两个模式下都要有**改错那一列**，**全对的默认不用改**。」
 *
 * ⇒ 所以只有**一个**导出动作，内容由档案自己的 `statsMode` 决定：
 *   · `normal`：学号 / 姓名 / 状态 / 第 1…N 题（对·错）/ 错题数 / 改错
 *   · `simple`：学号 / 姓名 / 状态 / 等级 / 改错
 * 两种模式**绝对不能**混着渲染：极简档案里 `questionCount` 只是建档时的默认值、`wrong` 恒空，
 * 照普通模式导出去就是一张"全班全对"的假表（`AssignmentGradeDone.tsx` 里那段 W16 注释写的就是这个坑）。
 *
 * ============================================================================
 * 「改错」这一列怎么判
 * ============================================================================
 * · 普通模式：这一份里**没有任何错题** ⇒ `不用改`；否则看 `correctedNos` ⇒ `已改` / `未改`。
 * · 极简模式：没有逐题数据，只能按等级 —— 等级 `优` ⇒ `不用改`；`良`/`差` ⇒ 看 `correctedNos`。
 *   ⚠️ "优"到底是不是"全对"由老师定义；这里按**本平台极简模式的约定**（优 = 不用改）取，
 *      写进表头注释行，别让老师以为是系统替他判的。
 *
 * 状态列取自「只记例外」的收缴口径（`types.ts:348-353`）：
 * `missingNos` 里的 ⇒ `缺交`；`lateNos` 里的 ⇒ `迟交`；其余 ⇒ `已交`。
 */

export type ExportMode = 'normal' | 'simple'

export function exportModeOf(a: Assignment): ExportMode {
  return a.statsMode === 'simple' ? 'simple' : 'normal'
}

/** 某一题（含小题）错了没有 —— 键是 `3` 或 `3.1` */
function seqWrong(wrongKeys: string[] | undefined, seq: number): boolean {
  if (!wrongKeys?.length) return false
  const head = String(seq)
  return wrongKeys.some((k) => k === head || k.startsWith(`${head}.`))
}

function wrongSeqCount(wrongKeys: string[] | undefined): number {
  if (!wrongKeys?.length) return 0
  return new Set(wrongKeys.map((k) => k.split('.')[0])).size
}

function cell(v: string | number): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export type ExportCounts = {
  total: number
  handed: number
  missing: number
  late: number
  /** 需要改错的人数（普通模式=有错题；极简模式=等级非优） */
  needCorrect: number
  corrected: number
}

export function buildAssignmentCsv(args: {
  assignment: Assignment
  students: Student[]
  className: string
}): { filename: string; csv: string; mode: ExportMode; counts: ExportCounts } {
  const { assignment: a, students, className } = args
  const mode = exportModeOf(a)
  const missing = new Set(a.missingNos ?? [])
  const late = new Set(a.lateNos ?? [])
  const corrected = new Set(a.correctedNos ?? [])

  const counts: ExportCounts = {
    total: students.length,
    handed: 0,
    missing: 0,
    late: 0,
    needCorrect: 0,
    corrected: 0,
  }

  const head =
    mode === 'normal'
      ? ['学号', '姓名', '状态', ...Array.from({ length: a.questionCount }, (_, i) => `第${i + 1}题`), '错题数', '改错']
      : ['学号', '姓名', '状态', '等级', '改错']

  const rows: string[] = [head.map(cell).join(',')]

  for (const s of students) {
    const isMissing = missing.has(s.studentNo)
    const isLate = late.has(s.studentNo)
    const state = isMissing ? '缺交' : isLate ? '迟交' : '已交'
    if (isMissing) counts.missing++
    else if (isLate) counts.late++
    else counts.handed++

    if (mode === 'normal') {
      const w = a.wrong?.[s.studentNo]
      const n = wrongSeqCount(w)
      const cells = a.questionCount
        ? Array.from({ length: a.questionCount }, (_, i) => (seqWrong(w, i + 1) ? '错' : '对'))
        : []
      /* 缺交的人没有题号数据：逐题格留空，而不是写"对"（那是在替他答对） */
      const marks = isMissing ? cells.map(() => '') : cells
      let fix: string
      if (n === 0) fix = '不用改'
      else {
        counts.needCorrect++
        fix = corrected.has(s.studentNo) ? '已改' : '未改'
        if (fix === '已改') counts.corrected++
      }
      rows.push([s.studentNo, s.name, state, ...marks, n === 0 ? 0 : n, fix].map(cell).join(','))
    } else {
      const g = archiveValue(a.grades, s) || ''
      let fix: string
      if (g === '优') fix = '不用改'
      else if (!g) fix = '' // 没评等级：不替老师判
      else {
        counts.needCorrect++
        fix = corrected.has(s.studentNo) ? '已改' : '未改'
        if (fix === '已改') counts.corrected++
      }
      rows.push([s.studentNo, s.name, state, g, fix].map(cell).join(','))
    }
  }

  /* 表尾：三行汇总 + 两行口径说明（老师一眼知道这张表是怎么算的） */
  rows.push('')
  rows.push(['应交', counts.total, '已交', counts.handed, '迟交', counts.late, '缺交', counts.missing].map(cell).join(','))
  rows.push(['需改错', counts.needCorrect, '已改错', counts.corrected].map(cell).join(','))
  rows.push(
    [
      mode === 'normal'
        ? '口径：普通模式逐题记录；「改错」列为「不用改」表示这一份没有错题。'
        : '口径：极简模式只记等级；「改错」列按等级判，优 = 不用改。',
    ]
      .map(cell)
      .join(','),
  )

  const safe = (t: string) => t.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40)
  const filename = `${safe(className)}-${safe(a.title)}-完成情况-${a.assignDate}.csv`
  return { filename, csv: rows.join('\r\n'), mode, counts }
}
