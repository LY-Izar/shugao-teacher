/* ============================================================
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
  {
    year: 2026,
    docNo: '国办发明电〔2025〕7号',
    publishedAt: '2025年11月04日',
    sourceUrl: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
    holidays: [
      { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
      { name: '春节', start: '2026-02-15', end: '2026-02-23' },
      { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
      { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
      { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
      { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
      { name: '国庆节', start: '2026-10-01', end: '2026-10-07' },
    ],
    // 调休上班日：这些日子按工作日对待
    workdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
]

/** 数据覆盖的年份 */
export const COVERED_YEARS = HOLIDAY_PLANS.map((p) => p.year)
