import type { Klass, ScheduleItem } from '../data/types'
import { classKindOf } from './pick'
import { conflictBlockMessage, findScheduleConflicts } from './stream'

/* ---------------- 时间工具 ---------------- */

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function nowMinutes(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** JS 的 getDay()：0=周日。课表用 1=周一 … 7=周日 */
export function weekdayOf(d = new Date()): number {
  const g = d.getDay()
  return g === 0 ? 7 : g
}

export function itemsOfDay(schedule: ScheduleItem[], weekday: number): ScheduleItem[] {
  return schedule
    .filter((s) => s.weekday === weekday)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
}

export function itemsForDate(schedule: ScheduleItem[], d = new Date()): ScheduleItem[] {
  return itemsOfDay(schedule, weekdayOf(d))
}

/* ---------------- 今日状态 ---------------- */

export type DayState = {
  items: ScheduleItem[]
  has: boolean
  /** 今天所有日程都已结束 */
  allEnded: boolean
  /**
   * 今天**还有课没上完**（有日程，且至少有一条还没结束）。
   *
   * 和 `allEnded` 的区别在"今天没有日程"这种情形：
   *   · 没有日程 → allEnded=false、hasMore=false
   *   · 有日程没上完 → allEnded=false、hasMore=true
   * 「今天工作全部完成」的判定必须看 hasMore，否则晚上还有课也会被报成已完成。
   */
  hasMore: boolean
  current: ScheduleItem | null
  next: ScheduleItem | null
  /** 距离下一节课还有多少分钟 */
  minutesToNext: number | null
}

/**
 * 今天的状态。
 *
 * `weekday` 只在**调休日手动选「今天按周X的课表上」**时传：
 * 那时 items 已经按选定的星期过滤好了，而 `itemsForDate` 会拿**设备真实星期**
 * 再过滤一次 —— 调休日真实是周六/日，必然筛成空，整块「今天这个班什么课」就没了。
 * 传了 weekday 就跳过二次过滤。
 */
export function dayState(schedule: ScheduleItem[], d = new Date(), weekday?: number): DayState {
  const items = weekday === undefined ? itemsForDate(schedule, d) : itemsOfDay(schedule, weekday)
  const m = nowMinutes(d)
  let current: ScheduleItem | null = null
  let next: ScheduleItem | null = null
  let minutesToNext: number | null = null

  for (const it of items) {
    const s = toMinutes(it.start)
    const e = toMinutes(it.end)
    if (m >= s && m < e) current = it
    if (s > m && !next) {
      next = it
      minutesToNext = s - m
    }
  }

  return {
    items,
    has: items.length > 0,
    allEnded: items.length > 0 && items.every((it) => toMinutes(it.end) <= m),
    hasMore: items.length > 0 && items.some((it) => toMinutes(it.end) > m),
    current,
    next,
    minutesToNext,
  }
}

/** 「上课前 10 分钟」的判定窗口：落在 9–11 分钟内就提醒，避免定时器抖动漏掉 */
export const REMIND_BEFORE = 10

export function dueReminders(schedule: ScheduleItem[], d = new Date()): ScheduleItem[] {
  return dueRemindersWithSnooze(schedule, {}, d)
}

/**
 * 推迟过的那几条：提醒时间不看"课前 10 分钟"，看**推迟到的那一分钟**。
 *
 * 🔴 推迟只改**提醒**，不改课表 —— 课还在原时间上（那才是真出事）。
 * ⚠️ 判定窗口与 `dueReminders` **同一个**（±1 分钟，躲定时器抖动）：
 *    两处口径不一样的话，同一条课会在两个时刻各响一次。
 *
 * @param snoozed 课表条目 id → 推迟到当天第几分钟（`schedule_snoozes.remind_minute`）
 */
export function dueRemindersWithSnooze(
  schedule: ScheduleItem[],
  snoozed: Readonly<Record<string, number>>,
  d = new Date(),
): ScheduleItem[] {
  const m = nowMinutes(d)
  return itemsForDate(schedule, d).filter((it) => {
    if (!it.notify) return false
    /* 有推迟记录 ⇒ 只认那个时刻；推迟到已经过去的分钟 ⇒ 今天不再响它 */
    const moved = snoozed[it.id]
    const target = moved === undefined ? toMinutes(it.start) - REMIND_BEFORE : moved
    return target - m >= -1 && target - m <= 1
  })
}

/**
 * 「晚 N 分钟」推到几点 —— **累加**语义。
 *
 * @param start       这节课的 'HH:MM' 开始时间
 * @param current     已经推迟到第几分钟（`undefined` = 还没推迟过）
 * @param delayMinutes 再往后推多少
 *
 * ⚠️ 基点是「**课前 10 分钟**」，不是「课开始」——
 *    晚 10 分钟 = 提醒晚响 10 分钟，不是课晚 10 分钟（那是调课，另一条路）。
 * 🔴 结果**钳在 [0, 1440]**：一节课被连点很多次也不会推出一天之外
 *    （`1440` = 24:00，写进库被 check 约束挡住 ⇒ 按钮看着点了没反应）。
 */
export function snoozeMinuteOf(start: string, current: number | undefined, delayMinutes: number): number {
  const base = current ?? toMinutes(start) - REMIND_BEFORE
  return Math.max(0, Math.min(1440, base + delayMinutes))
}

/** 把「现在几点」说成人话（推迟到的那一刻显示在按钮上） */
export function snoozeText(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function normalizeTime(v: string, fallback: string): string {
  return /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim().padStart(5, '0') : fallback
}

export function durationText(start: string, end: string): string {
  const d = toMinutes(end) - toMinutes(start)
  return d > 0 ? `${d} 分钟` : '时间有误'
}

/* ---------------- 周一前三节顺延 ---------------- */

/**
 * 周一早上第 1–3 节整体顺延（校会 / 升旗占用）。
 * 只动这三节，其余按学校原表不动 —— 这是学校明确的规矩。
 */
export const MONDAY_SHIFT = { weekday: 1, count: 3, minutes: 20 }

const pad2 = (n: number) => String(n).padStart(2, '0')
const fromMin = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`

/**
 * 应用顺延。
 *
 * 会返回 conflicts：如果顺延后出现**上一节还没下课、下一节已经开始**，
 * 就把冲突原样交出来让界面提示。宁可让教师看见冲突，
 * 也不能在教室大屏上显示一份物理上不可能的课表。
 */
export function applyMondayShift(items: ScheduleItem[]): {
  items: ScheduleItem[]
  shifted: number
  conflicts: string[]
} {
  const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  if (sorted.length === 0) return { items, shifted: 0, conflicts: [] }

  const out = sorted.map((it, i) => {
    if (i >= MONDAY_SHIFT.count) return it
    const s = toMinutes(it.start) + MONDAY_SHIFT.minutes
    const e = toMinutes(it.end) + MONDAY_SHIFT.minutes
    return { ...it, start: fromMin(s), end: fromMin(e) }
  })

  const conflicts: string[] = []
  for (let i = 1; i < out.length; i++) {
    if (toMinutes(out[i].start) < toMinutes(out[i - 1].end)) {
      conflicts.push(
        `第 ${i + 1} 节 ${out[i].start} 开始，但第 ${i} 节 ${out[i - 1].end} 才下课 —— 时间重叠`,
      )
    }
  }
  return { items: out, shifted: Math.min(MONDAY_SHIFT.count, sorted.length), conflicts }
}

export function maybeShift(
  items: ScheduleItem[],
  weekday: number,
): { items: ScheduleItem[]; shifted: number; conflicts: string[] } {
  if (weekday !== MONDAY_SHIFT.weekday) return { items, shifted: 0, conflicts: [] }
  return applyMondayShift(items)
}

/**
 * 某一天、某个班要展示的课表（含周一顺延）。
 * 教室端和教师端走同一处逻辑，免得两边算出两套时间。
 */
export function displayItemsForDate(
  schedule: ScheduleItem[],
  opts: { weekday: number; classId?: string; scope?: 'mine' | 'class' },
): { items: ScheduleItem[]; shifted: number; conflicts: string[] } {
  const base = schedule.filter(
    (s) => s.weekday === opts.weekday && (!opts.scope || (s.scope ?? 'mine') === opts.scope),
  )
  const list = opts.classId ? base.filter((s) => s.classId === opts.classId) : base
  return maybeShift(list, opts.weekday)
}

/**
 * 「还有多久」的口语说法。
 * 隔得远的时候说「190 分后」没人会在脑子里换算，所以超过 90 分钟改用小时。
 */
export function awayText(minutes: number): string {
  if (minutes <= 0) return '马上'
  if (minutes < 90) return `${minutes} 分后`
  const h = Math.round(minutes / 60)
  return h >= 24 ? `${Math.round(minutes / 1440)} 天后` : `${h} 小时后`
}

/* ============================================================
   🔴 排课时的**走班冲突校验**闸门（P7 · Q13 = A：冲突就**拦住**）
   ------------------------------------------------------------
   算法只有一处：`lib/stream.ts` 的 `findScheduleConflicts()`
   （**学生集合交集** + **老师撞课**两个维度）。

   这一层只做两件事：
     ① 把走班班的成员（`class_members`）与任教关系（`class_subjects`）读出来
        —— 都走 `data/remote.ts` 的**懒加载 + 探针**（老库没有那张表时返回 `null`）；
     ② 没有走班班就**恒定放行**（老库 / 还没生成走班班的年级，行为一个字节不变）。

   🔴 三个排课入口（教师端日程表 / 批量粘贴 / 教室端粘贴）**共用这一个函数** ——
      I16：少挂一处 = 有一个入口能绕过，而绕过的那一处**看起来很正常**。
   ⚠️ 它**不是安全边界**（前端判据不作数）：它挡的是"排课的人不知道会撞"；
      "谁能在这一行上写"仍然只有数据库说了算。
   ============================================================ */

export type ConflictGate = {
  /** `true` = 这次保存被拦下（`message` 是人话，按行分好了） */
  blocked: boolean
  message: string
  /** 没拦住时的一句诊断（不上屏；回归与排查看） */
  note: string
}

/**
 * 注入式依赖：**只传函数、不 import `data/remote.ts`**。
 *
 * 为什么不让这个文件自己 import：`data/remote.ts` 依赖面积很大（supabase 客户端、
 * 快照那条线），而 `lib/schedule.ts` 是**纯时间工具**，被教室端 / 提醒 / 名言一起用 ——
 * 为了一个校验把它们全拖进来不值得。注入还有一个好处：`grade-checks.mjs`
 * 可以传自己的假读取函数，**在真库里跑真断言**。
 */
export type ConflictGateDeps = {
  /** 读走班班成员：`classId → 学生 id[]`；读不到回 `null`（"不知道"） */
  loadMembers?: (classIds: string[]) => Promise<Record<string, string[]> | null>
  /** 读任教关系（`class_subjects`） */
  loadSubjects?: (
    classIds: string[],
  ) => Promise<Array<{ classId: string; subjectCode: string; teacherId: string }> | null>
}

export async function checkScheduleConflicts(
  input: {
    /** 这一回要保存的行 */
    items: readonly ScheduleItem[]
    /** 已经在库里的课表（`scope='mine'` 与 `scope='class'` 都要） */
    schedule: readonly ScheduleItem[]
    /** 所有班（含走班班） */
    classes: readonly Klass[]
    /** `classId → 学生 id[]`（本地演示模式由 store 以同一形状传进来） */
    localMembers?: Readonly<Record<string, readonly string[]>>
    /** `classId → subject_code → teacher_id` */
    localTeachers?: ReadonlyMap<string, ReadonlyMap<string, string>>
  },
  deps: ConflictGateDeps = {},
): Promise<ConflictGate> {
  const touched = [...new Set(input.items.map((i) => String(i.classId ?? '')).filter(Boolean))]
  if (!touched.length) return { blocked: false, message: '', note: '这些行都没有归属班' }

  const stream = input.classes.filter((k) => classKindOf(k) === 'stream')
  /* 🔴 没有走班班 → **恒定放行**（§31.4 的对照法：改造前后行为相等） */
  if (!stream.length) return { blocked: false, message: '', note: '这个库里还没有走班班' }
  if (!input.items.some((i) => classKindOf(input.classes.find((k) => k.id === i.classId)) === 'stream')) {
    return { blocked: false, message: '', note: '这一回没有走班班的课' }
  }

  const streamIds = stream.map((k) => k.id)
  const members = new Map<string, readonly string[]>()
  for (const id of [...touched, ...streamIds]) {
    const local = input.localMembers?.[id]
    if (local) {
      members.set(id, local)
      continue
    }
    const k = input.classes.find((x) => x.id === id)
    /* 行政班的名单就在 `Klass.students` 上（走班班的人只在 `class_members` 里，要读） */
    if (k && classKindOf(k) === 'admin') members.set(id, k.students.map((s) => s.id))
  }
  const needMembers = [...touched, ...streamIds].filter((id) => !members.has(id))
  if (needMembers.length && deps.loadMembers) {
    const r = await deps.loadMembers(needMembers)
    /* 读不到（老库没有 `class_members`）→ 那一档按"不知道"处理，**不许 pretend 成"没人"** */
    if (r) for (const [k, v] of Object.entries(r)) members.set(k, v)
  }

  const teachers = new Map<string, Map<string, string>>()
  if (input.localTeachers) for (const [k, v] of input.localTeachers) teachers.set(k, new Map(v))
  const needTeachers = streamIds.filter((id) => !teachers.has(id))
  if (needTeachers.length && deps.loadSubjects) {
    const rows = await deps.loadSubjects(needTeachers)
    if (rows) {
      for (const r of rows) {
        const m = teachers.get(r.classId) ?? new Map<string, string>()
        m.set(r.subjectCode, r.teacherId)
        teachers.set(r.classId, m)
      }
    }
  }

  const conflicts = findScheduleConflicts({
    classes: input.classes,
    members,
    teachers,
    existing: input.schedule,
    pending: input.items,
  })
  if (!conflicts.length) return { blocked: false, message: '', note: '' }
  return { blocked: true, message: conflictBlockMessage(conflicts), note: `${conflicts.length} 处` }
}

/* ============================================================
   「今天」那屏的**真实时间轴**要用的三件（2026-10-04）
   ------------------------------------------------------------
   为什么需要：我们把今天的课平铺成列表，只有"几点—几点"——
   看不出每节真实占多长、中间空多久、哪两节真的撞了。

   🔴 三条都必须是**纯函数**：不碰 DOM、不读 `new Date()` 之外的全局、
      不认识 React —— 这样才能脱离界面单测（判据要能单独红）。
   ⚠️ 「空档」的门槛 10 分钟是**学校作息里的正常接续**，
      低于它就标出来等于天天报"冲突"，那teacher 就不看了
      （假绿/假红之外还有第三条：**假红**）。
   ============================================================ */

/** 时间轴上下边界：最早开始前 / 最晚结束后各留 30 分钟，向整点取整 */
export const AXIS_PAD_MIN = 30

/** 短于这个分钟数的空档**不标**（那是正常的课间接续，不是空档） */
export const GAP_MIN_MINUTES = 10

export type DayRange = { fromMin: number; toMin: number }

/**
 * 一天的上下边界。
 *
 * 空数组时给 `null` —— 界面据此**不渲染轴**（别给一条空轴）。
 */
export function dayRange(items: readonly ScheduleItem[]): DayRange | null {
  if (items.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const it of items) {
    const s = toMinutes(it.start)
    const e = toMinutes(it.end)
    if (s < lo) lo = s
    if (e > hi) hi = e
  }
  /*
⚠️ 那两道钳位不是装饰：`AXIS_PAD_MIN` 是导出常量、界面上还有别的入口会传不同值，
     而**减法没有下界** —— padding 大于一天的起点时会算出负的 fromMin，
     拿去当 CSS 的 top 就是把整条轴画到容器外面（看起来像"今天没有课"）。
     倒过来 toMin 超过 1440 同理（那是 24:00 之后）。
  */
  const fromMin = Math.floor((lo - AXIS_PAD_MIN) / 60) * 60
  const toMin = Math.ceil((hi + AXIS_PAD_MIN) / 60) * 60
  return {
    fromMin: Math.max(0, fromMin),
    toMin: Math.min(1440, toMin),
  }
}

export type DayGap = { fromMin: number; toMin: number; minutes: number }

/**
 * 两节课之间的空档，**只回 ≥ `GAP_MIN_MINUTES` 的**。
 *
 * 输入会先按开始时间排好序，所以一趟扫就够了。
 */
export function dayGaps(items: readonly ScheduleItem[]): DayGap[] {
  const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  const out: DayGap[] = []
  for (let i = 1; i < sorted.length; i++) {
    const fromMin = toMinutes(sorted[i - 1].end)
    const toMin = toMinutes(sorted[i].start)
    const minutes = toMin - fromMin
    if (minutes >= GAP_MIN_MINUTES) out.push({ fromMin, toMin, minutes })
  }
  return out
}

/**
 * 时间重叠的分组。
 *
 * ⚠️ 与 `applyMondayShift()` 返回的 `conflicts` **口径一致**（同一件事两个说法）：
 * 「下一节开始时，上一节还没下课」。那一处已经会把冲突原样交给界面提示，
 * 这里是让时间轴**画得出来**（并排），而不是让两处各判一次。
 *
 * 传递性：连着三节互相压 ⇒ 合成一组（那三节都得并排）。
 */
export function overlapGroups(items: readonly ScheduleItem[]): ScheduleItem[][] {
  const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
  const out: ScheduleItem[][] = []
  let cur: ScheduleItem[] = []
  let curEnd = -Infinity
  for (const it of sorted) {
    const s = toMinutes(it.start)
    const e = toMinutes(it.end)
    /* `s < curEnd` 才是重叠；`s === curEnd` 是正常接续 */
    if (cur.length && s < curEnd) {
      cur.push(it)
      if (e > curEnd) curEnd = e
    } else {
      if (cur.length) out.push(cur)
      cur = [it]
      curEnd = e
    }
  }
  if (cur.length) out.push(cur)
  return out.filter((g) => g.length > 1)
}
