import type { Assignment, CallRecord, CallState, Student } from '../data/types'
import { isQuestionWrong } from './grading'
import { roomOf } from './subjects'

/** 单次播报人数上限 —— 一次叫太多学生既不现实也拆散课堂 */
export const CALL_LIMIT = 8
/** 自定义后缀字数上限：这句话会公开放音 */
export const CUSTOM_MAX = 30

/**
 * 播报文案。
 * 默认：「请 12 号、37 号，到物理老师办公室。」（地点按学科算）
 * 带自定义：「……。物理老师叫你带上作业本。」
 *
 * ⚠️ 地点以前是一个写死的常量 `DEFAULT_ROOM = '物理老师办公室'`：
 *    语文老师发呼叫时默认地点是物理办公室，而且这句话会被**真的念出来**。
 *    现在按学科算（`roomOf`），地点仍然是教师可以改的输入框内容。
 */
export function composeCallText(
  studentNos: string[],
  room: string,
  subject: string,
  custom: string,
): string {
  const nums = studentNos.map((n) => `${n} 号`).join('、')
  const head = nums ? `请 ${nums}，到${room || roomOf(subject)}。` : '（还没有选学生）'
  const c = custom.trim()
  return c ? `${head}${subject}老师叫你${c}。` : head
}

/* ---------------- 谁需要被叫 ---------------- */

export type WrongStudent = {
  student: Student
  /** 错了几处（小题单独计数） */
  count: number
  /** 错题号，展示用 */
  seqs: number[]
  /** 其中是否有小题级别的错 */
  hasSub: boolean
}

/** 按错题数从多到少排序 —— 最该叫的排最前 */
export function wrongStudents(students: Student[], a: Assignment): WrongStudent[] {
  const active = students.filter((s) => s.status === 'active')
  return active
    .map((student) => {
      const keys = a.wrong[student.studentNo] ?? []
      const seqSet = new Set<number>()
      let hasSub = false
      for (const k of keys) {
        const [seqStr, sub] = k.split('.')
        const seq = Number(seqStr)
        seqSet.add(seq)
        if (sub) hasSub = true
      }
      return { student, count: keys.length, seqs: [...seqSet].sort((x, y) => x - y), hasSub }
    })
    .filter((x) => x.count > 0)
    .sort((x, y) => y.count - x.count || Number(x.student.studentNo) - Number(y.student.studentNo))
}

/** 某道题错的学生（按题号筛选呼叫用） */
export function wrongStudentsOfQuestion(
  students: Student[],
  a: Assignment,
  seq: number,
): WrongStudent[] {
  const subCount = a.subQuestions[String(seq)] ?? 0
  return students
    .filter((s) => s.status === 'active' && isQuestionWrong(a.wrong[s.studentNo], seq, subCount))
    .map((student) => ({
      student,
      count: (a.wrong[student.studentNo] ?? []).filter((k) => Number(k.split('.')[0]) === seq).length,
      seqs: [seq],
      hasSub: subCount > 0,
    }))
    .sort((x, y) => Number(x.student.studentNo) - Number(y.student.studentNo))
}

/* ---------------- 呼叫记录 ---------------- */

/** 本次作业里，每个学生最近一次的呼叫状态 —— 用于「已叫过标灰」 */
export function latestCallStates(calls: CallRecord[], assignmentId: string): Map<string, CallState> {
  const map = new Map<string, CallState>()
  const list = calls
    .filter((c) => c.assignmentId === assignmentId)
    .sort((a, b) => (a.sentAt[0] ?? 0) - (b.sentAt[0] ?? 0))
  for (const c of list) {
    for (const no of c.studentNos) map.set(no, c.states[no] ?? 'called')
  }
  return map
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
