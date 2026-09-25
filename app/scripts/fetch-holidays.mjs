/**
 * 从中国政府网抓取《国务院办公厅关于XXXX年部分节假日安排的通知》，
 * 解析出放假区间与调休上班日，生成 src/data/holidays.ts。
 *
 * 用法：
 *   node scripts/fetch-holidays.mjs             # 抓取下面 NOTICES 里列出的全部年份
 *   node scripts/fetch-holidays.mjs 2027 <url>  # 追加/更新某一年
 *
 * 国务院每年 11 月左右发布次年安排。发布后把新的通知地址加进 NOTICES 再跑一次即可。
 */
import { writeFileSync } from 'node:fs'

/* 官方原文地址（中国政府网 · 国务院文件） */
const NOTICES = [
  {
    year: 2026,
    url: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  },
]

const [, , argYear, argUrl] = process.argv
if (argYear && argUrl) NOTICES.push({ year: Number(argYear), url: argUrl })

const NAMES = ['元旦', '春节', '清明节', '劳动节', '端午节', '中秋节', '国庆节']

const pad = (n) => String(n).padStart(2, '0')
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, '')
}

/** 把正文按七个节日切开 */
function sections(text, year) {
  const out = []
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i]
    const start = text.indexOf(`${name}：`)
    if (start < 0) continue
    const nextStarts = NAMES.slice(i + 1)
      .map((n) => text.indexOf(`${n}：`, start + 1))
      .filter((x) => x > 0)
    const end = nextStarts.length ? Math.min(...nextStarts) : Math.min(text.length, start + 260)
    out.push({ name, body: text.slice(start + name.length + 1, end) })
  }
  void year
  return out
}

/** 从一段文字里解析放假区间与调休上班日 */
function parseSection({ name, body }, year) {
  // 放假区间：可能写全「A月B日至C月D日」，也可能省略结束月份「A月B日至D日」
  let start = null
  let end = null
  let m =
    body.match(/(\d{1,2})月(\d{1,2})日[^至]{0,16}?至(\d{1,2})月(\d{1,2})日/) || null
  if (m) {
    start = ymd(year, +m[1], +m[2])
    end = ymd(year, +m[3], +m[4])
  } else {
    m = body.match(/(\d{1,2})月(\d{1,2})日[^至]{0,16}?至(\d{1,2})日/)
    if (m) {
      start = ymd(year, +m[1], +m[2])
      end = ymd(year, +m[1], +m[3])
    } else {
      m = body.match(/(\d{1,2})月(\d{1,2})日/)
      if (m) {
        start = ymd(year, +m[1], +m[2])
        end = start
      }
    }
  }
  if (!start) return null

  // 调休上班：紧挨着「上班」前面的那一串日期
  const workdays = []
  const wd = body.match(/((?:\d{1,2}月\d{1,2}日（[^）]*）[、，]?)+)上班/)
  if (wd) {
    for (const d of wd[1].matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
      workdays.push(ymd(year, +d[1], +d[2]))
    }
  }

  return { name, start, end, workdays }
}

async function fetchYear({ year, url }) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`${year} 抓取失败：HTTP ${res.status}`)
  const html = await res.text()
  const text = stripTags(html)

  const docNo = (text.match(/国办发明电〔\d{4}〕\d+号/) || [''])[0]
  const published = (text.match(/成文日期：(\d{4}年\d{1,2}月\d{1,2}日)/) || [])[1] || ''

  const holidays = []
  const workdays = []
  for (const s of sections(text, year)) {
    const parsed = parseSection(s, year)
    if (!parsed) continue
    holidays.push({ name: parsed.name, start: parsed.start, end: parsed.end })
    workdays.push(...parsed.workdays)
  }
  if (holidays.length < 5) {
    throw new Error(`${year} 只解析出 ${holidays.length} 个节日，页面结构可能变了`)
  }
  return { year, url, docNo, published, holidays, workdays }
}

const plans = []
for (const n of NOTICES) {
  try {
    const plan = await fetchYear(n)
    plans.push(plan)
    console.log(
      `✓ ${plan.year} · ${plan.docNo} · ${plan.holidays.length} 个节日 · ${plan.workdays.length} 个调休上班日`,
    )
  } catch (e) {
    console.error(`✗ ${n.year}: ${e.message}`)
    process.exitCode = 1
  }
}

plans.sort((a, b) => a.year - b.year)

const body = plans
  .map((p) => {
    const hs = p.holidays
      .map((h) => `      { name: '${h.name}', start: '${h.start}', end: '${h.end}' },`)
      .join('\n')
    const ws = p.workdays.map((w) => `'${w}'`).join(', ')
    return `  {
    year: ${p.year},
    docNo: '${p.docNo}',
    publishedAt: '${p.published}',
    sourceUrl: '${p.url}',
    holidays: [
${hs}
    ],
    // 调休上班日：这些日子按工作日对待
    workdays: [${ws}],
  },`
  })
  .join('\n')

const file = `/* ============================================================
   法定节假日与调休安排 —— 数据来自中国政府网
   《国务院办公厅关于XXXX年部分节假日安排的通知》

   本文件由 scripts/fetch-holidays.mjs 自动生成，请勿手改。
   国务院每年 11 月左右发布次年安排，届时重新运行：
     node scripts/fetch-holidays.mjs
   ============================================================ */

export type HolidaySpan = {
  name: string
  /** 起始日 YYYY-MM-DD（含） */
  start: string
  /** 结束日 YYYY-MM-DD（含） */
  end: string
}

export type YearPlan = {
  year: number
  /** 发文字号 */
  docNo: string
  publishedAt: string
  sourceUrl: string
  holidays: HolidaySpan[]
  /** 调休上班的日期（通常是周末） */
  workdays: string[]
}

export const HOLIDAY_PLANS: YearPlan[] = [
${body}
]

/** 数据覆盖的年份 */
export const COVERED_YEARS = HOLIDAY_PLANS.map((p) => p.year)
`

writeFileSync(new URL('../src/data/holidays.ts', import.meta.url), file, 'utf8')
console.log(`\n已写入 src/data/holidays.ts（${plans.length} 个年份）`)
