const pad = (n: number) => String(n).padStart(2, '0')

/** 本地时区的 YYYY-MM-DD，避免 toISOString 的 UTC 偏移把日期算错一天 */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isoOffset(days: number, from = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return toISODate(d)
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** 原生 date 输入被清空时会返回空串，这里回退到原值，避免日期变空 */
export function ensureISO(value: string, fallback: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

const WEEK = '日一二三四五六'

/** 人话日期：今天 / 昨天 / 前天 / 9月18日 · 周四 */
export function friendlyDate(iso: string): string {
  const today = toISODate(new Date())
  if (iso === today) return '今天'
  if (iso === isoOffset(-1)) return '昨天'
  if (iso === isoOffset(-2)) return '前天'
  const d = parseISODate(iso)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK[d.getDay()]}`
}

export function fullDate(iso: string): string {
  const d = parseISODate(iso)
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK[d.getDay()]}`
}
