import type { Klass, ScheduleKind } from '../data/types'

/* ============================================================
   从课表（Excel / Word / 粘贴文本）识别日程
   ------------------------------------------------------------
   学校发下来的课表通常长两种样子，这里都要认：
     ① 网格式：行 = 节次，列 = 周一…周五，格子里是课程
     ② 列表式：每行一条，含「星期 + 时间 + 课程」
   识别结果一律**先摊开给教师核对**，永远不静默采用。
   ============================================================ */

/** 标准节次时间，格子里没写时间时按这个兜底 */
export const PERIOD_SLOTS: Array<[string, string]> = [
  ['08:00', '08:45'],
  ['08:55', '09:40'],
  ['10:10', '10:55'],
  ['11:05', '11:50'],
  ['14:30', '15:15'],
  ['15:25', '16:10'],
  ['16:30', '17:15'],
  ['17:25', '18:10'],
]

export type ParsedScheduleItem = {
  weekday: number
  start: string
  end: string
  title: string
  room?: string
  classId?: string
  kind: ScheduleKind
  notify: boolean
  /** 原文，核对时给教师看 */
  raw: string
}

export type ParsedSchedule = {
  items: ParsedScheduleItem[]
  layout: 'grid' | 'list' | 'unknown'
  warnings: string[]
}

/* ---------------- 基本识别 ---------------- */

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  七: 7,
}
const EN_DAY: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
}

/** 「周一」「星期一」「周1」「一」「Mon」→ 1–7；认不出返回 null */
export function weekdayFrom(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const m = t.match(/(?:周|星期|礼拜)\s*([一二三四五六日天七1-7])/)
  if (m) {
    const n = CN_NUM[m[1]] ?? Number(m[1])
    return n >= 1 && n <= 7 ? n : null
  }
  if (t.length <= 2) {
    if (CN_NUM[t] !== undefined) return CN_NUM[t]
    if (/^[1-7]$/.test(t)) return Number(t)
  }
  const en = EN_DAY[t.slice(0, 3).toLowerCase()]
  return en ?? null
}

const H = '([01]?\\d|2[0-3])'
const M = '([0-5]\\d)'
const SEP = '\\s*[-~～—－至到]\\s*'
const RANGE_SRC = `${H}\\s*[:：]\\s*${M}${SEP}${H}\\s*[:：]\\s*${M}`

const pad = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`

/** 「08:00-08:45」「8：00~8：45」→ ['08:00','08:45'] */
export function timeRange(text: string): [string, string] | null {
  const m = text.match(new RegExp(RANGE_SRC))
  if (!m) return null
  return [pad(m[1], m[2]), pad(m[3], m[4])]
}

/** 单个时间「第1节 08:00」→ 只取开始时间时用不上；这里只用于判断行标签像不像时间 */
export function hasTime(text: string): boolean {
  return new RegExp(RANGE_SRC).test(text)
}

const ROOM_RE =
  /([\u4e00-\u9fa5A-Za-z0-9]{0,6}(?:实验室|教室|机房|操场|会议室|办公室|报告厅|阶梯教室|体育馆|美术室|音乐室|舞蹈房|录播室))/

const OTHER_KW = /备课|教研|会议|活动|培训|值班|例会|讲座|监考|阅卷|自习|升旗|社团/

function matchClass(title: string, classes: Klass[]): string | undefined {
  const flat = title.replace(/[()（）\s]/g, '')
  for (const c of classes) {
    if (!c.name) continue
    if (title.includes(c.name)) return c.id
    const loose = c.name.replace(/[()（）\s]/g, '')
    if (loose && flat.includes(loose)) return c.id
  }
  return undefined
}

function build(
  weekday: number,
  start: string,
  end: string,
  rawTitle: string,
  raw: string,
  classes: Klass[],
): ParsedScheduleItem | null {
  let title = rawTitle.replace(/\s+/g, ' ').trim()
  if (!title) return null

  const room = title.match(ROOM_RE)?.[1]
  if (room) {
    // 只收掉首尾多出来的括号/空格 —— 不能把括号一律换成空格，
    // 那样「高二(1)班」会变成「高二 1 班」，班级就匹配不上了
    const stripped = title
      .replace(room, '')
      .replace(/\s+/g, ' ')
      .replace(/^[（）()\s]+|[（）()\s]+$/g, '')
      .trim()
    if (stripped) title = stripped
  }

  const kind: ScheduleKind = OTHER_KW.test(title) ? 'other' : 'class'
  return {
    weekday,
    start,
    end,
    title,
    room: room || undefined,
    classId: matchClass(title, classes),
    kind,
    notify: kind === 'class',
    raw,
  }
}

/* ---------------- 网格式 ---------------- */

export function parseScheduleRows(rows: string[][], classes: Klass[] = []): ParsedSchedule {
  const warnings: string[] = []

  /* 找表头行：含最多星期标记的那一行（至少要 2 个才认） */
  let headIdx = -1
  let colDay = new Map<number, number>()
  rows.forEach((row, i) => {
    const map = new Map<number, number>()
    row.forEach((cell, c) => {
      const w = weekdayFrom(cell)
      if (w) map.set(c, w)
    })
    if (map.size >= 2 && map.size > colDay.size) {
      headIdx = i
      colDay = map
    }
  })

  /* ---- 网格式 ---- */
  if (headIdx >= 0 && colDay.size >= 2) {
    const items: ParsedScheduleItem[] = []
    let period = 0
    let usedFallback = false

    for (let r = headIdx + 1; r < rows.length; r++) {
      const row = rows[r]

      // 这一行在星期列上有没有课？没有就不算一个节次
      // （否则「午休」这种夹在中间的说明行会占掉一节，后面全错位）
      const filled = [...colDay.keys()].filter((c) => (row[c] ?? '').trim())
      if (!filled.length) continue

      // 行标签：不在星期列里的第一个非空格子
      let label = ''
      for (let c = 0; c < row.length; c++) {
        if (colDay.has(c)) continue
        if (row[c]) {
          label = row[c]
          break
        }
      }

      const range = label ? timeRange(label) : null
      const slot = range ?? PERIOD_SLOTS[period] ?? null
      if (!range && slot) usedFallback = true
      period++

      for (const c of filled) {
        const wd = colDay.get(c)
        const cell = (row[c] ?? '').trim()
        if (wd === undefined || !slot) continue
        const it = build(wd, slot[0], slot[1], cell, `${label} ${cell}`.trim(), classes)
        if (it) items.push(it)
      }
    }

    if (usedFallback && items.length) {
      warnings.push(
        `行标签里没写具体时间，已按标准节次预填（第 1 节 ${PERIOD_SLOTS[0][0]}–${PERIOD_SLOTS[0][1]}），请核对`,
      )
    }
    return { items, layout: 'grid', warnings }
  }

  /* ---- 列表式 ---- */
  const items: ParsedScheduleItem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const cells = row.filter((c) => c && c.trim())
    if (!cells.length) continue
    const joined = cells.join(' ')
    let weekday: number | null = null
    for (const c of cells) {
      const w = weekdayFrom(c)
      if (w) {
        weekday = w
        break
      }
    }
    if (!weekday) continue
    const range = timeRange(joined)
    if (!range) continue

    const title = joined
      .replace(new RegExp(RANGE_SRC, 'g'), ' ')
      .replace(/(?:周|星期|礼拜)\s*[一二三四五六日天七1-7]/g, ' ')
      .replace(/第\s*\d{1,2}\s*节/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const it = build(weekday, range[0], range[1], title, joined, classes)
    if (!it) continue
    const key = `${it.weekday}|${it.start}|${it.title}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(it)
  }

  if (!items.length) {
    return {
      items,
      layout: 'unknown',
      warnings: ['没认出课表结构。可以试试：① 用学校发的 Excel 原文件；② 每一行写成「周二 08:55-09:40 高二(3)班 物理」'],
    }
  }
  return { items, layout: 'list', warnings }
}

/** 纯文本 → 先按分隔符切行，再交给 parseScheduleRows */
export function parseScheduleText(text: string, classes: Klass[] = []): ParsedSchedule {
  const rows = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (line.includes('\t')) return line.split('\t').map((c) => c.trim())
      if (line.includes(',')) return line.split(',').map((c) => c.trim())
      return line.split(/\s{2,}/).map((c) => c.trim())
    })
  return parseScheduleRows(rows, classes)
}
