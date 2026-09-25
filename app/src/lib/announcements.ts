/* ============================================================
   全站公告 —— 「**平台**对老师说话」（2026-09-28 公告轮）
   ------------------------------------------------------------
   🔴🔴 **公告 ≠ 通知**（本仓库最容易搞混的一处，改这个文件之前先读这三行）：
     · **通知**（`lib/notices.ts` / `schema.sql` §21）＝ 教务通知：各职能部门**发给老师**，
       有收件范围、有未读红点、有 `/notices` 收件箱页。问的是"这件事跟我有没有关系"。
     · **公告**（本文件 / `schema.sql` §22）＝ **全站公告**：**关于平台本身**的信息
       （"系统今晚维护"、"新功能上线"），**全站一条、没有收件范围、没有收件人、没有未读**。
       问的是"这个平台现在是什么状态"。形态 = **顶部横幅 + 可选弹窗**。
     ⛔ 两者不许互相塞：公告不进 `notices`，通知不加 `level` / `popup`。
        本文件**不 import** `lib/notices.ts` 的任何东西（两个数据模型一个字都不共享）。

   这一层做四件事：
     ① **读**：`getSupabase().from('announcements').select('*')` —— **走 RLS**
        （`announcements_visible` 策略，schema.sql §22.3）。教室端读不到、
        过期/未生效/已撤下的读不到，**都是数据库在拦**，前端一个字都不筛（M3 / §11.3）。
     ② **纯逻辑**：排序 / 生效区间 / 顶部那条横幅摆哪几条 / 弹窗队列 ——
        全部是纯函数（`nav-checks.mjs` 的 **A10** 逐条断言它们，
        因为"横幅摆哪几条、弹几次"这件事**没有别的机器能验**）。
     ③ **本机记性**：今天关过没有（localStorage）/ 弹过了没有（localStorage + sessionStorage）——
        **一律不落库**：谁关过横幅、谁看过弹窗，平台**不记**（与 I49 同一条纪律：
        不做行为留痕）。
     ④ **表没跑过时前端不崩**：线上库还没跑 §22 时，探测到 `missing` 就返回空包，
        横幅**整条不出现**（不是白屏、也不是一句吓人的报错）。

   🔴 **前端探针不许假设任何一列存在**（这一类 bug 在本仓库咬过两次，见 D10）：
      探"这张表在不在"就用 `select('*')`。⚠️ 「表不在」与「列不在」是**两条判据**，
      不许合成一条泛化的 `does not exist`（`nav-checks.mjs` 的 **D10** 把两条都钉死）。
   ============================================================ */

import { getSupabase } from './supabase'
import { beijingNow, ymdOf } from './holiday'
import type { Announcement, AnnouncementLevel, AnnouncementPopup } from '../data/types'

/* ---------------- 探测：公告那张表在不在？（schema.sql §22） ----------------

   与 `ensureNoticeTables()` / `ensureExamTables()` **同一套纪律**，判据只认「表不存在」：
   网络抖动、权限问题一律当作**在**（否则一次抖动就把公告永久停掉，比偶发失败严重得多）。
   ⚠️ "探测本身失败"（断网）**不缓存** —— 缓存住会把临时故障固化成永久状态。
   ---------------------------------------------------------------------------- */

export type AnnouncementProbeState = 'present' | 'missing' | 'indeterminate'

let annProbe: Promise<AnnouncementProbeState> | null = null

/*
 * 「**表**不在」的判据 —— 只认这三样：`42P01` / `PGRST205` / 文案里带 `relation … does not exist`
 * （口径与 `lib/notices.ts` / `lib/adminChart.ts` 的 `MISSING_TABLE_RE` **逐字一致**）。
 *
 * 🔴 这里**绝不能**把 `42703`（`undefined_column`）当成"表不在"，也**绝不能**只写一个
 *    泛化的 `/does not exist/i` —— `column <表>.<列> does not exist` 里也有这两个词，
 *    而那说的**只是"这一列不在"**，不是"这张表没建"。
 */
const MISSING_TABLE_RE = /42P01|PGRST205|Could not find the table|relation .+ does not exist/i
/** 「**列**不在」：`42703` / `PGRST204` / `column … does not exist`（与上面那条成对，判据分流） */
const MISSING_COL_RE = /42703|PGRST204|column .+ does not exist/i

async function probeAnnouncementTable(): Promise<AnnouncementProbeState> {
  const sb = getSupabase()
  if (!sb) return 'missing'
  try {
    /* 🔴 `select('*')`，**不是 `select('id')`** —— 表存在性与"有哪几列"无关 */
    const { error } = await sb.from('announcements').select('*').limit(1)
    if (!error) return 'present'
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    // 「列不在」先摘出去：**表探针拿到它只能记灰**，绝不能据此说"表不在"
    if (MISSING_COL_RE.test(code) || MISSING_COL_RE.test(msg)) return 'indeterminate'
    // 只有「表不在」才是 false；认不出的错一律灰（不缓存）
    if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) return 'missing'
    return 'indeterminate'
  } catch {
    return 'indeterminate'
  }
}

/** 探一次（同一页面内只探一次） */
export function ensureAnnouncementTable(): Promise<AnnouncementProbeState> {
  if (!annProbe) annProbe = probeAnnouncementTable()
  return annProbe
}

/** 清掉探测缓存（"重试"用；只清缓存、不写任何东西） */
export function resetAnnouncementProbe(): void {
  annProbe = null
}

/* ---------------- 归一 ---------------- */

const LEVELS: readonly AnnouncementLevel[] = ['normal', 'important', 'urgent']
const POPUPS: readonly AnnouncementPopup[] = ['never', 'once', 'session', 'always']

const asLevel = (v: unknown): AnnouncementLevel =>
  LEVELS.includes(String(v) as AnnouncementLevel) ? (String(v) as AnnouncementLevel) : 'normal'
const asPopup = (v: unknown): AnnouncementPopup =>
  POPUPS.includes(String(v) as AnnouncementPopup) ? (String(v) as AnnouncementPopup) : 'never'

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}

/** 一行 `announcements`（PostgREST 形状）→ 前端的 `Announcement`。**不认识的值一律退回默认** */
export function asAnnouncement(raw: Record<string, unknown>): Announcement {
  const created = ms(raw.created_at) ?? 0
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    level: asLevel(raw.level),
    popup: asPopup(raw.popup),
    pin: raw.pin === true,
    activeFrom: ms(raw.active_from),
    activeTo: ms(raw.active_to),
    createdBy: (raw.created_by as string | null) ?? null,
    updatedBy: (raw.updated_by as string | null) ?? null,
    createdAt: created,
    updatedAt: ms(raw.updated_at) ?? created,
    revokedAt: ms(raw.revoked_at),
    emailSent: raw.email_sent === true,
    emailSentTs: ms(raw.email_sent_ts),
    emailCount: Number(raw.email_count ?? 0) || 0,
    emailFail: Number(raw.email_fail ?? 0) || 0,
  }
}

/* ---------------- 读（**RLS 在拦**，这里不筛） ---------------- */

export type AnnouncementBundle = {
  /** 表在不在（探测结论，与 `ensureNoticeTables()` 同一套纪律） */
  state: 'present' | 'missing' | 'unknown'
  announcements: Announcement[]
}

export const EMPTY_ANNOUNCEMENT_BUNDLE: AnnouncementBundle = {
  state: 'missing',
  announcements: [],
}

/**
 * 读我看得到的公告（**数据库 RLS 筛过的结果**）。
 *
 * 🔴 这条查询**不经过 `/api/announcement`**（那个 Function 只管写与超管列表）：
 *    教师端横幅是**每一页都要的东西**，多一次自己的中转只是多一跳；
 *    而 RLS 在数据库那一侧照常生效（用的是登录会话的 JWT）。
 * 🔴 **教室端拿到的是 0 行**（策略里 `not a classroom_account`）—— 前端不要补一个 if。
 */
export async function loadAnnouncements(): Promise<AnnouncementBundle> {
  const state = await ensureAnnouncementTable()
  if (state !== 'present') {
    return { state: state === 'missing' ? 'missing' : 'unknown', announcements: [] }
  }
  const sb = getSupabase()
  if (!sb) return { state: 'missing', announcements: [] }
  try {
    /* 🔴 `select('*')`（理由同探针）：**不许假设任何一列存在** */
    const { data, error } = await sb
      .from('announcements')
      .select('*')
      .order('pin', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) {
      const code = String((error as { code?: string }).code ?? '')
      const msg = String(error.message ?? '')
      if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) {
        return { state: 'missing', announcements: [] }
      }
      return { state: 'unknown', announcements: [] }
    }
    return {
      state: 'present',
      announcements: (Array.isArray(data) ? data : []).map((r) =>
        asAnnouncement(r as Record<string, unknown>),
      ),
    }
  } catch {
    return { state: 'unknown', announcements: [] }
  }
}

/* ============================================================
   纯逻辑（`nav-checks.mjs` A10 的断言对象）

   这一组函数**不碰网络、不碰 localStorage、不读全局** —— 它们只回答三件事：
     · 排序（谁在前）
     · 生效区间（现在该不该出现）
     · 顶部摆哪几条 / 弹窗排哪几条
   把"摆哪几条、弹几次"变成纯函数是这个文件存在的第二个理由：
   **它没有别的机器能验**（不是布局问题、不是权限问题，而是产品语义）。
   ============================================================ */

/** 等级权重（**只用于排序**；弹窗行为不由它决定，见 `shouldPopup`） */
export const LEVEL_WEIGHT: Record<AnnouncementLevel, number> = {
  normal: 1,
  important: 2,
  urgent: 3,
}

/**
 * 所有地方**共用同一个顺序**（列表 / 横幅 / 弹窗队列都用它）：
 *   ① **置顶**在前（`pin` 是人的显式动作："让它钉在最上面"）
 *   ② 同档里**等级高**的在前（紧急 > 重要 > 普通）
 *   ③ 同等级里**新发的**在前
 *
 * 🔴 **只有这一个顺序**。⛔ 不许在别处再写一个"紧急优先于置顶"之类的变体 ——
 *    两套顺序就是"同一件事两个口径"，而横幅被截断时（`maxBars`）后果是**内容漂移**。
 */
export function sortAnnouncements(list: readonly Announcement[]): Announcement[] {
  return [...list].sort((a, b) => {
    if (a.pin !== b.pin) return a.pin ? -1 : 1
    const lv = LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level]
    if (lv !== 0) return lv
    return b.createdAt - a.createdAt
  })
}

/**
 * 这一条现在该不该出现（**生效区间是闭区间，两端都含**）。
 *
 * ⚠️ 这条判据在**前端也有一份**（因为要按分钟重算"现在"），而**数据库那一份才是权限**：
 *    策略里同样三条（未撤下 / 区间内 / 不是教室端），见 schema.sql §22.3。
 *    两份的关系是"**读得宽、写得窄**"那条纪律的正常形状：
 *    数据库决定"拿得到拿不到"，前端这一份只决定"这一秒摆不摆"（比如 23:00 维护开始时
 *    横幅要自己消失，而不是等下一次刷新）。
 */
export function isActiveAt(a: Announcement, nowMs: number): boolean {
  if (a.revokedAt !== null) return false
  if (a.activeFrom !== null && nowMs < a.activeFrom) return false
  if (a.activeTo !== null && nowMs > a.activeTo) return false
  return true
}

/** 现在生效的那些，**已排序** */
export function activeAnnouncements(
  list: readonly Announcement[],
  nowMs: number,
): Announcement[] {
  return sortAnnouncements(list.filter((a) => isActiveAt(a, nowMs)))
}

/* ---------------- 顶部那一条：摆哪几条 ---------------- */

/**
 * 独立横幅（一人一条、整幅宽度）最多几条。
 *
 * 🔴 桌面 2 / **窄屏 1**：横幅是**吸顶**的，每多一条就永久吃掉一屏的行高。
 *    窄屏只留一条，是因为"顶部两条横幅 + 一条滚动条"在 880 高的屏上就是 ~110px（12%），
 *    而老师要的是内容。**这是本项目给的硬上限**，不是参考项目那种"有多少摆多少"。
 */
export const BAR_MAX_DESKTOP = 2
export const BAR_MAX_MOBILE = 1

export type AnnouncementPlanInput = {
  /** 现在（毫秒时间戳） */
  nowMs: number
  /** 本机记的"今天关过横幅"（北京时间的那一天，`YYYY-MM-DD`）；没关过就是 null */
  hiddenDay: string | null
  /** 今天（北京时间 `YYYY-MM-DD`）—— 与 `hiddenDay` 比 */
  today: string
  /** 本次会话里逐条按过「×」的那些 id（内存，不落盘） */
  closedIds?: readonly string[]
  /** 独立横幅最多几条（桌面 `BAR_MAX_DESKTOP` / 窄屏 `BAR_MAX_MOBILE`） */
  maxBars: number
  /** 超管在面板上点的那一条预览（**无视生效区间与"今天关过"**，只影响这一次渲染） */
  preview?: Announcement | null
}

export type AnnouncementPlan = {
  /** 独立横幅（**已排序**，最多 `maxBars` 条）：紧急 / 置顶的那些 */
  bars: Announcement[]
  /** 滚动条里的那些（**已排序**）：其余的生效公告；"今天关过"之后为空 */
  marquee: Announcement[]
  /** 今天是不是被按过「×」（按过之后只留紧急/置顶那几个独立横幅） */
  hiddenToday: boolean
}

/**
 * 今天顶部摆什么。四条规则（`nav-checks` A10 逐条断言）：
 *  ① **独立横幅** = `pin` 或 `level='urgent'` 的那些，按**唯一的那个顺序**排，最多 `maxBars` 条；
 *  ② **滚动条** = 其余的生效公告（含被 `maxBars` 挤出来的置顶/紧急），按同一个顺序；
 *  ③ **本机记过"今天关过"** → 滚动条整条不摆，但 **置顶 / 紧急无视隐藏标志**
 *     （照参考项目：一个"我一定要让你看到"的东西不该被一次误点永久关掉）；
 *  ④ **预览**那一条：无视生效区间与"今天关过"，而且即使它已经被撤下也照样摆
 *     —— 超管点的是"我要看它长什么样"。
 *
 * ⚠️ `closedIds`（逐条「×」）对**所有**条目生效（本次会话内）：
 *    它就是"我现在不想看这条"，与"今天都别给我看"（规则③）是两件事。
 */
export function planAnnouncementBar(
  list: readonly Announcement[],
  input: AnnouncementPlanInput,
): AnnouncementPlan {
  const closed = new Set(input.closedIds ?? [])
  const preview = input.preview ?? null
  const rest = list.filter((a) => !closed.has(a.id) && a.id !== preview?.id)
  const pool = activeAnnouncements(rest, input.nowMs)
  const all = preview ? sortAnnouncements([...pool, { ...preview, preview: true }]) : pool

  const barPool = all.filter((a) => a.pin || a.level === 'urgent' || a.preview === true)
  /*
   * 🔴 预览那一条**优先占一个独立横幅位**（`sort` 是稳定的，所以它只是被提到最前）：
   *    人正等着看它，而"置顶 + 紧急"已经占满 `maxBars` 时它会被挤进滚动条 ——
   *    那时超管点完「预览」看到的是"什么都没变"（本轮实测踩到的正是这个形状）。
   */
  const ordered = [...barPool].sort(
    (a, b) => Number(b.preview === true) - Number(a.preview === true),
  )
  const bars = ordered.slice(0, Math.max(0, input.maxBars))
  const inBars = new Set(bars.map((a) => a.id))
  const hiddenToday = input.hiddenDay === input.today && input.hiddenDay !== null
  /* 规则③ + 规则④：今天关过 → 滚动条不摆；**但预览那一条永远摆**（不然超管会以为坏了） */
  const marquee =
    hiddenToday && !preview ? [] : all.filter((a) => !inBars.has(a.id))
  return { bars, marquee, hiddenToday }
}

/* ---------------- 弹窗：弹哪几条、弹几次 ---------------- */

export type PopupSeen = {
  /** 本机永久记过的那些 id（`popup='once'`，localStorage） */
  seen: readonly string[]
  /** 本次会话记过的那些 id（`popup='session'` 与紧急的 `never`，sessionStorage） */
  sessSeen: readonly string[]
}

/**
 * 这一条现在该不该弹。
 *
 * 🔴 **`popup` 是"弹几次"的唯一字段**（一个字段一种语义）。四值：
 *    `always`  → 每次都弹（不记任何东西）
 *    `once`    → 本机没记过就弹；**关掉时**记进 localStorage
 *    `session` → 本次会话没记过就弹；**弹出时**就记进 sessionStorage
 *    `never`   → **不弹** —— **唯一例外：`level='urgent'` 按 `session` 处理**
 *                （用户口径："urgent 紧急 —— 用户登录时弹出强提醒弹窗"）
 *
 * ⚠️ 那条例外是**刻意**的，也是本项目与参照项目唯一一处"等级影响弹窗"：
 *    参照项目把 `level` 与 `popup` 混着用，本项目把它收成一个例外、且**只有这一处**。
 */
export function shouldPopup(a: Announcement, seen: PopupSeen): boolean {
  switch (a.popup) {
    case 'always':
      return true
    case 'once':
      return !seen.seen.includes(a.id)
    case 'session':
      return !seen.sessSeen.includes(a.id)
    default:
      return a.level === 'urgent' ? !seen.sessSeen.includes(a.id) : false
  }
}

/** **弹出时**要记进 sessionStorage 的那些（`session` 与"紧急的 never"） */
export const marksSessionOnShow = (a: Announcement): boolean =>
  a.popup === 'session' || (a.popup === 'never' && a.level === 'urgent')

/** **关掉时**要记进 localStorage 的那些（只有 `once`） */
export const marksSeenOnClose = (a: Announcement): boolean => a.popup === 'once'

/**
 * 这一次进来要弹哪几条（**已排序；一次只弹一个，关掉上一个再弹下一个**）。
 *
 * ⚠️ `suppressed` 由调用方给：**早间欢迎弹窗 / 当天完成弹窗开着时为真** ——
 *    公告弹窗**礼让**它（见 `功能设计与不变量.md` §二十四 的排队规则），
 *    而且礼让时**不记任何 seen**（"这一次没弹"不等于"用户看过了"）。
 */
export function announcementPopupQueue(
  list: readonly Announcement[],
  input: { nowMs: number; seen: PopupSeen; suppressed?: boolean },
): Announcement[] {
  if (input.suppressed) return []
  return activeAnnouncements(list, input.nowMs).filter((a) => shouldPopup(a, input.seen))
}

/* ---------------- 本机记性（**一律不落库**） ----------------
 *
 * 🔴 **平台不记"谁关过横幅 / 谁看过弹窗"**（与 I49 同一条纪律：不做行为留痕，
 *    与超管面板 §5.4 的隐私口径一致）。这三个键全部只在**这台浏览器**上：
 *      · `shugao.ann.hideDay`  今天关过（一个 `YYYY-MM-DD`，按**北京时间**的那一天）
 *      · `shugao.ann.seen`     `popup='once'` 弹过并关掉的那些（id → 时刻）
 *      · `shugao.ann.sessSeen` `popup='session'`（含紧急的 never）**本次会话**弹过的那些（sessionStorage）
 * 另外 `shugao.ann.preview` 是**超管的预览快照**（不是记性，是"我要在教师端看一眼"）。
 * ------------------------------------------------------------ */

export const ANN_HIDE_KEY = 'shugao.ann.hideDay'
export const ANN_SEEN_KEY = 'shugao.ann.seen'
export const ANN_SESS_KEY = 'shugao.ann.sessSeen'
export const ANN_PREVIEW_KEY = 'shugao.ann.preview'

/** 北京时间的今天（`YYYY-MM-DD`）—— 时间口径一律 `beijingNow()`，不依赖设备时区 */
export function todayKey(now: Date = beijingNow()): string {
  return ymdOf(now)
}

export function readHideDay(): string | null {
  try {
    return localStorage.getItem(ANN_HIDE_KEY)
  } catch {
    return null
  }
}

/** 记"今天不再显示"（**只记这一天**；置顶/紧急不受它影响） */
export function writeHideDay(day: string): void {
  try {
    localStorage.setItem(ANN_HIDE_KEY, day)
  } catch {
    /* 隐私模式 / 配额满：不记就是了，横幅照常按规则③的上一半显示 */
  }
}

function readMap(key: string, store: 'local' | 'session'): string[] {
  try {
    const raw =
      store === 'local' ? localStorage.getItem(key) : sessionStorage.getItem(key)
    if (!raw) return []
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return []
    return Object.keys(v as Record<string, unknown>)
  } catch {
    return []
  }
}

function writeMapEntry(key: string, id: string, store: 'local' | 'session'): void {
  try {
    const raw = store === 'local' ? localStorage.getItem(key) : sessionStorage.getItem(key)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    const map: Record<string, number> =
      v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, number>) } : {}
    map[id] = Date.now()
    // 只留最近 200 条：这张表是"个位数条公告"，200 足够，且不会让本机存储无限长
    const keys = Object.keys(map)
    const kept: Record<string, number> = {}
    for (const k of keys.slice(-200)) kept[k] = map[k]
    const text = JSON.stringify(kept)
    if (store === 'local') localStorage.setItem(key, text)
    else sessionStorage.setItem(key, text)
  } catch {
    /* 同上：记不住就多弹一次，不影响功能 */
  }
}

export const readSeen = (): string[] => readMap(ANN_SEEN_KEY, 'local')
export const addSeen = (id: string): void => writeMapEntry(ANN_SEEN_KEY, id, 'local')
export const readSessSeen = (): string[] => readMap(ANN_SESS_KEY, 'session')
export const addSessSeen = (id: string): void => writeMapEntry(ANN_SESS_KEY, id, 'session')

/** 读超管的预览快照（读完**不清**：清不清由调用方决定，见 `clearPreview`） */
export function readPreview(): Announcement | null {
  try {
    const raw = localStorage.getItem(ANN_PREVIEW_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object') return null
    const a = asAnnouncement(v as Record<string, unknown>)
    return a.id ? { ...a, preview: true } : null
  } catch {
    return null
  }
}

/** 写 / 清预览快照（`null` = 清掉） */
export function writePreview(a: Announcement | null): void {
  try {
    if (!a) localStorage.removeItem(ANN_PREVIEW_KEY)
    else localStorage.setItem(ANN_PREVIEW_KEY, JSON.stringify(a))
  } catch {
    /* 记不住就只在本次会话里预览（调用方自己那一份状态仍然有效） */
  }
}

/* ---------------- 写：走服务端 `/api/announcement` ---------------- */

const NEED_STAGE22 =
  '数据库还没跑公告那一段（仓库里 supabase/schema.sql 第 22 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

export type AnnouncementInput = {
  title: string
  body: string
  level: AnnouncementLevel
  popup: AnnouncementPopup
  pin: boolean
  /** 生效起点（ISO 字符串）；空串 = 立即生效 */
  activeFrom?: string
  /** 生效终点（ISO 字符串）；空串 = 不过期 */
  activeTo?: string
}

async function call(
  body: Record<string, unknown>,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string; missing?: boolean }
> {
  const sb = getSupabase()
  const session = sb ? (await sb.auth.getSession()).data.session : null
  const token = session?.access_token
  if (!token) {
    return {
      ok: false,
      message: isRemoteLike()
        ? '登录已过期，请重新登录后再试'
        : '本地模式没有云端，公告发不出去（发布需要服务端 /api/announcement）。',
    }
  }
  let res: Response
  try {
    res = await fetch('/api/announcement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, message: '网络不通，这次操作没有发出去' }
  }
  const text = await res.text()
  let payload: Record<string, unknown> = {}
  try {
    const v = JSON.parse(text || '{}')
    if (v && typeof v === 'object') payload = v as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (res.ok) return { ok: true, data: payload }
  if (res.status === 404) {
    return {
      ok: false,
      message:
        '这个部署里没有公告服务（/api/announcement）。在本地开发环境（npm run dev）下它不存在，线上才有。',
    }
  }
  const message = String(payload.message ?? `操作失败（HTTP ${res.status}）`)
  return { ok: false, message, missing: message.includes('第 22 段') }
}

function isRemoteLike(): boolean {
  return getSupabase() !== null
}

/** 超管的公告清单（**含已撤下 / 已过期** —— 面板要能回答"这条曾经存在过吗"） */
export async function adminListAnnouncements(): Promise<
  { ok: true; announcements: Announcement[] } | { ok: false; message: string }
> {
  const res = await call({ action: 'admin-list' })
  if (!res.ok) return { ok: false, message: res.message }
  const rows = Array.isArray(res.data.announcements)
    ? (res.data.announcements as Record<string, unknown>[])
    : []
  return { ok: true, announcements: rows.map(asAnnouncement) }
}

/** 发一条公告。🔴 能不能发**只有服务端说了算**（403 时 message 直接给人看） */
export const createAnnouncement = (input: AnnouncementInput) => call({ action: 'create', ...input })

/** 改一条公告（标题 / 正文 / 等级 / 弹窗 / 置顶 / 生效区间） */
export const updateAnnouncement = (id: string, input: AnnouncementInput) =>
  call({ action: 'update', id, ...input })

/** 撤下（**不删行**）。⚠️ 只有超管能撤（与服务端那条判据同一组人） */
export const revokeAnnouncement = (id: string) => call({ action: 'revoke', id })

export { NEED_STAGE22 }

/* ---------------- 显示用的小件（页面里不重复写） ---------------- */

export const LEVEL_TEXT: Record<AnnouncementLevel, string> = {
  normal: '普通',
  important: '重要',
  urgent: '紧急',
}

export const POPUP_TEXT: Record<AnnouncementPopup, string> = {
  never: '不弹窗',
  once: '每人弹一次',
  session: '每会话一次',
  always: '每次都弹（慎用）',
}

/**
 * 编辑公告时的**隐私提醒**（需求原文："公告是给全站看的，正文里不该出现学生姓名/成绩"）。
 *
 * 🔴 这是一条**软提醒**（不拦提交），而且判据只认"像个人数据"的那几个词。
 *    为什么不做硬校验：公告完全可能合法地出现数字（"今晚 23:00–23:30 维护"、
 *    "版本 0.9.1"），硬校验会把它一起拦掉 —— 那比漏提醒更烦人。
 *    返回 `null` = 没看出问题（不是"保证没问题"）。
 */
export function announcementPrivacyHint(title: string, body: string): string | null {
  const text = `${title}\n${body}`
  /*
   * ⚠️ 最后那一条 `\d+\s*分(?!钟)` 是**实测补上的**：一开始只写了"分数 / 成绩"两个词，
   *    结果"张三这次考了 85 分"这种**最典型的**写法一条都不命中（`shots` 94 那张图的断言当场红了）。
   *    而 `(?!钟)` 是防误伤"大约 30 分钟" —— 那种运维文案本来就该放行（软提醒也不该乱响）。
   */
  if (/(学号|分数|成绩|排名|平均分|及格率|名次)/.test(text) || /\d+\s*分(?!钟)/.test(text)) {
    return (
      '正文里出现了「成绩 / 分数 / 学号」一类的词。公告是**给全站看的**，' +
      '请不要写具体的学生姓名、学号或成绩 —— 那类事走「通知」（只有相关老师看得到）。'
    )
  }
  if (/(学生|同学|孩子)/.test(text)) {
    return (
      '正文里出现了「学生 / 同学」一类的词。若要点到具体的人，请改成不含姓名的说法' +
      '（例如"高三年级"），学生姓名与成绩不该出现在全站公告里。'
    )
  }
  return null
}
