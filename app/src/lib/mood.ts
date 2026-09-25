/* ============================================================
   情绪价值
   早上打开的一句问候、一天结束时的一句收尾。
   刻意不做积分、不做等级 —— 那种"游戏化"会让专业感流失。
   ============================================================ */

import { dayKind } from './holiday'

/**
 * 每天一句，按天轮换。同一天始终是同一句，相邻两天一定不同。
 *
 * 🔴 **换成这一批之前的那 100 句是 AI 味的**（"愿今天的你，被学生温柔以待。"
 *    "你不是在完成指标，你在陪人长大。"这一类）。用户 2026-09-29 拍板：
 *    ① **对老师说教的话一律不要** —— 不替老师下情绪结论、不规定他该怎么想；
 *    ② **"愿今天的你…"这一种句式全砍** —— 一百句同一个腔调，读两次就腻；
 *    ③ 换成**具体的、有画面的**句子：一天的某个时刻、教室里的一件小事、
 *       一句不解释不辩护的实话。
 *    判据同全站文案审查（见 `文案审查任务.md`）：**短、具体、不说教**。
 *
 * ⚠️ 与教室端的 `lib/quotes.ts`（`DAILY_QUOTES`）**不是同一批** ——
 *    那一边是给学生看的诗词与名言，尺度不同，别把两批并成一批。
 */
export const GREETINGS: string[] = [
  '先看一眼今天有几节课，再决定先做哪件事。',
  '课表上第一节是哪个班，心里先过一遍。',
  '水杯先接满，会省下你一次出教室。',
  '昨天没批完的那摞，今天总有时间。',
  '上课前两分钟，教室里最吵，也最有生气。',
  '粉笔灰落下来的时候，光里看得见。',
  '先把板书想清楚，讲起来会顺很多。',
  '点名的时候，谁应得最响，你心里有数。',
  '今天要讲的那道题，先自己想一遍。',
  '课件翻到最后一页，检查一遍有没有错字。',
  '一节课四十分钟，讲得完的就是好课。',
  '学生举手之前，会先看你一眼。',
  '作业本上的红笔印，是你昨天留下的。',
  '今天第一句话说什么，想一句就够。',
  '讲台抽屉里那支备用笔，今天可能用得上。',
  '中午的那段时间，留一点给自己。',
  '走廊里碰到学生，他喊你一声，你应一声。',
  '有人会在这节课上听懂，你不知道是哪一个。',
  '黑板上写错一个字，擦了重写就是。',
  '学生问的问题，答不上来就说不确定。',
  '讲慢一点，后排才跟得上。',
  '今天可能有一节课特别顺。',
  '收上来的本子里，总有一本是认真的。',
  '办公室的水烧开了，先倒一杯。',
  '该改的作业改完，剩下的明天再说。',
  '课间十分钟，学生跑得比谁都快。',
  '同一个知识点，换个说法他们就懂了。',
  '备课时卡住的地方，上课时常常会通。',
  '学生的草稿纸，比作业本更能看出问题。',
  '今天讲到哪儿，就在哪儿停一下。',
  '上课铃响之前进教室，站定，再开口。',
  '板书写整齐一点，抄的人会少吃点苦。',
  '有人趴着，叫一声名字通常就够了。',
  '晚上还有课的话，白天留点力气。',
  '一句鼓励，说出口比想在心里有用。',
  '作业收不齐，先问一句为什么。',
  '今天要收的那一份，昨天已经说过了。',
  '走廊尽头的窗户开着，风会吹进来。',
  '讲到自己熟的地方，语速会快起来，慢一点。',
  '学生记住的常常是你随口说的那句。',
  '下课时把讲台理一理，明天好找东西。',
  '这一届学生，你才刚认识一部分。',
  '今天不必把每件事都做完。',
  '开会之前想好要说什么，两句话就够。',
  '批到一份好本子，可以停一下再往下批。',
  '教室后排也听得见，声音要送出去。',
  '今天遇到的难题，多半昨天也有人遇到过。',
  '收工之前，把明天第一节课要用的东西放好。',
  '一年下来，你会记得的其实只有几个人和几节课。',
]

const DAY = 86400000

/**
 * 本地日期的天数序号，用来做到「每天一句、当天不变」。
 * ⚠️ 教室端的每日名言（`lib/quotes.ts`）**也用它** —— 两处必须是同一个种子，
 *    否则同一块屏上会出现"刷新一下换一句"。
 */
export function dayIndex(d = new Date()): number {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.floor(local.getTime() / DAY)
}

export function pickGreeting(d = new Date()): string {
  const i = ((dayIndex(d) % GREETINGS.length) + GREETINGS.length) % GREETINGS.length
  return GREETINGS[i]
}

export function dateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 早上 6:30 – 9:00 之间第一次打开，才给欢迎弹窗 */
export function isMorningWindow(d = new Date()): boolean {
  const m = d.getHours() * 60 + d.getMinutes()
  return m >= 390 && m < 540
}

export function greetingWord(d = new Date()): string {
  const h = d.getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/* ---------------- 工作台首栏的氛围判断 ---------------- */

export type DayMood = 'lateNight' | 'holiday' | 'weekend' | 'done' | 'normal'

export const MOOD_TEXT: Record<
  Exclude<DayMood, 'normal' | 'holiday'>,
  { title: string; sub: string }
> = {
  lateNight: {
    title: '夜深了，早点休息吧。',
    sub: '明天还有课，别熬太久。',
  },
  weekend: {
    title: '今天是周末噢，好好休息吧。',
    sub: '不用惦记工作的事，明天再说。',
  },
  done: {
    title: '今天的工作已经全部完成，好好休息一下吧。',
    sub: '剩下的时间属于你自己。',
  },
}

/**
 * 优先级：深夜 > 法定假期 > 周末 > 当日完成。
 *
 * 关键点：周末与否走 `dayKind` —— 它会先扣掉法定假期，再把**调休上班日**
 * 归到工作日一类。所以调休那天照常按工作日走，不会被误判成周末。
 *
 * 「完成」= 没有待批改的作业，且（今天的日程都结束了 或 已过 18:00）。
 * 特意把「还有待批改的作业」排除在外 —— 手上还有活的时候说「全部完成」
 * 是假的，那种话不如不说。
 */
export function dayMood(
  now: Date,
  ctx: { dateStr: string; allScheduleEnded: boolean; hasMoreToday?: boolean; pending: number },
): DayMood {
  const h = now.getHours()
  if (h >= 23 || h < 5) return 'lateNight'
  const kind = dayKind(ctx.dateStr)
  if (kind === 'holiday') return 'holiday'
  if (kind === 'weekend') return 'weekend'
  /*
   * ⚠️ 还有课没上完时**绝对不能报「全部完成」**。
   *
   * 原来是 `allScheduleEnded || h >= 18`：晚上 19:00 还有一节课、现在 18:05 时，
   * allScheduleEnded=false 但 h>=18 为真 → 弹出「今天的工作已经全部完成，好好休息一下吧」——
   * 老师明明还有课要上。那个 `h >= 18` 本意是照顾"今天没日程的老师"，
   * 所以这里必须用 hasMoreToday 把它挡在前面。
   */
  if (ctx.hasMoreToday) return 'normal'
  // makeup（调休上班）落在这里，按工作日处理
  if (ctx.pending === 0 && (ctx.allScheduleEnded || h >= 18)) return 'done'
  return 'normal'
}
