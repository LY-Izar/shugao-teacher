import type { ImportRow, Student } from '../data/types'

/* ---------------- 名单体检：学号连续性 / 重号 / 重名 ---------------- */

export type RosterHealth = {
  count: number
  maxNo: number
  gaps: number[]
  dupNos: string[]
  dupNames: string[]
  noNumber: number
  healthy: boolean
}

export function analyzeRoster(students: Student[]): RosterHealth {
  const active = students.filter((s) => s.status === 'active')
  const nos = active.map((s) => Number(s.studentNo)).filter((n) => Number.isFinite(n))
  const maxNo = nos.length ? Math.max(...nos) : 0

  const seen = new Map<number, number>()
  for (const n of nos) seen.set(n, (seen.get(n) ?? 0) + 1)
  const dupNos = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => String(n))

  const nameCount = new Map<string, number>()
  for (const s of active) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n)

  const gaps: number[] = []
  for (let i = 1; i <= maxNo; i++) if (!seen.has(i)) gaps.push(i)

  const noNumber = active.length - nos.length
  return {
    count: active.length,
    maxNo,
    gaps,
    dupNos,
    dupNames,
    noNumber,
    healthy: gaps.length === 0 && dupNos.length === 0 && dupNames.length === 0 && noNumber === 0,
  }
}

/* ---------------- 粘贴文本解析 ---------------- */

export type ParsedRow = { studentNo: string; name: string }

const HEADER = /^\s*(序号|编号|学号|姓名|班级|备注|号)\s*$/

export function parseRosterText(text: string): ParsedRow[] {
  const out: ParsedRow[] = []
  const lines = text.split(/\r?\n/)

  for (const raw of lines) {
    const line = raw.replace(/\u3000/g, ' ').trim()
    if (!line) continue

    // 跳过表头
    const parts = line.split(/[\s,，、;；|\t]+/).filter(Boolean)
    if (parts.length && parts.every((p) => HEADER.test(p))) continue
    if (!/\d/.test(line) && /学号|姓名|序号/.test(line)) continue

    let no = ''
    let name = ''

    // 形如 1.张三 / 1、张三 / 01-张三
    const glued = line.match(/^(\d{1,6})\s*[.、,，:：-]?\s*([\u4e00-\u9fa5·]{2,6})$/)
    if (glued) {
      no = glued[1]
      name = glued[2]
    } else {
      for (const p of parts) {
        if (!no && /^\d{1,6}[.、]?$/.test(p)) {
          no = p.replace(/\D/g, '')
          continue
        }
        if (!name && /[\u4e00-\u9fa5]/.test(p)) {
          name = p.replace(/[^\u4e00-\u9fa5·]/g, '').slice(0, 8)
          continue
        }
      }
      if (!name) {
        const cn = line.match(/[\u4e00-\u9fa5·]{2,6}/)
        if (cn) name = cn[0]
      }
    }

    if (!no && !name) continue
    out.push({ studentNo: no, name })
  }
  return out
}

/* ---------------- 导入校验：给每行打标记 ---------------- */

export function validateRows(rows: ParsedRow[], existing: Student[]): ImportRow[] {
  const existingByNo = new Map(
    existing.filter((s) => s.status === 'active').map((s) => [s.studentNo, s]),
  )

  const countNo = new Map<string, number>()
  const countName = new Map<string, number>()
  for (const r of rows) {
    if (r.studentNo) countNo.set(r.studentNo, (countNo.get(r.studentNo) ?? 0) + 1)
    if (r.name) countName.set(r.name, (countName.get(r.name) ?? 0) + 1)
  }

  return rows.map((r, i) => {
    const no = r.studentNo.trim()
    const name = r.name.trim()
    let flag: ImportRow['flag'] = null

    if (!no || !name) flag = 'bad'
    else if ((countNo.get(no) ?? 0) > 1) flag = 'dup-no'
    else if ((countName.get(name) ?? 0) > 1) flag = 'dup-name'

    return {
      key: `r-${i}`,
      studentNo: no,
      name,
      flag,
      existing: existingByNo.has(no),
    }
  })
}

/* ---------------- 模拟一次拍照识别 ---------------- */

export function simulateScan(classId: string): ImportRow[] {
  // 延迟由调用方控制；这里只做结果构造，并人为放入典型问题
  return [
    { key: `${classId}-1`, studentNo: '1', name: '王志远', flag: null },
    { key: `${classId}-2`, studentNo: '2', name: '李思涵', flag: null },
    { key: `${classId}-3`, studentNo: '3', name: '张雨欣', flag: null },
    { key: `${classId}-4`, studentNo: '4', name: '刘佳怡', flag: null },
    { key: `${classId}-5`, studentNo: '5', name: '陈明轩', flag: null },
    { key: `${classId}-6`, studentNo: '6', name: '杨嘉豪', flag: null },
    { key: `${classId}-7`, studentNo: '7', name: '黄雅静', flag: null },
    { key: `${classId}-8`, studentNo: '8', name: '赵子涵', flag: null },
    { key: `${classId}-9`, studentNo: '9', name: '吴欣悦', flag: null },
    { key: `${classId}-10`, studentNo: '10', name: '周', flag: 'bad' },
    { key: `${classId}-11`, studentNo: '11', name: '徐博文', flag: null },
    { key: `${classId}-12`, studentNo: '12', name: '孙志强', flag: null },
    { key: `${classId}-13`, studentNo: '12', name: '马晓明', flag: 'dup-no' },
    { key: `${classId}-14`, studentNo: '14', name: '朱文华', flag: null },
    { key: `${classId}-15`, studentNo: '15', name: '胡静怡', flag: null },
    { key: `${classId}-16`, studentNo: '16', name: '郭思远', flag: null },
  ]
}

export const FLAG_TEXT: Record<NonNullable<ImportRow['flag']>, string> = {
  'dup-no': '学号重复',
  'dup-name': '姓名重复',
  gap: '学号缺失',
  bad: '信息不完整',
}
