/**
 * 维护模式的**纯逻辑**（服务端）—— 2026-09-29 管理台第二期新增。
 *
 * 🔴 **同一份逻辑在仓库里有两处，这是刻意的、并且被断言钉住的**：
 *    · 服务端（本文件）：**权威**。`/api/status` 与 `/api/admin/maintenance` 用它；
 *    · 前端（`app/src/lib/maintenance.ts`）：只用于**面板表单**的即时校验与预览
 *      （超管还没点提交，就得看到"这样填会发生什么"）。
 *    ⚠️ 理由与本仓库既有的 `notice.ts` ↔ `scheduled_roles()` 那三份清单一样：
 *      前端产物与 Pages Function 是两个构建目标，跨目录 import 会把两边绑死。
 *      代价用**一条源码文本断言**补回来（`nav-checks.mjs`，照 A9 的写法）：
 *      四条校验的代码、四个常量、默认文案必须逐字相同。
 *
 * 🔴 **四条校验逐条照抄参考项目**（用户点名），每条都有自己的代号，便于单独断言：
 *   · R1 填了结束就必须填开始
 *   · R2 勾了"定时"但两个都没填 → **降级为立即生效（不报错）**
 *   · R3 只填结束 → 拒
 *   · R4 结束必须晚于开始
 */

/** 自动关闭（小时）：四档可选、**不许留空** */
export const MAINTENANCE_HOURS = [1, 4, 12, 24] as const
/** 默认值：夜里升级的典型窗口（用户拍板 4 小时） */
export const MAINTENANCE_DEFAULT_HOURS = 4
/** 通告正文上限（服务端截断到 200 字） */
export const MAINTENANCE_MESSAGE_MAX = 200
/** 二次确认要输入的字符串（英文大写 —— 不会被输入法吃掉） */
export const MAINTENANCE_CONFIRM_WORD = 'MAINTENANCE'
/** `message` 留空时给全校看的默认文案 */
export const MAINTENANCE_DEFAULT_MESSAGE = '系统维护中，请稍后重试。'

/** 一条维护状态（**已经过 effective 计算的那一半**与原始时刻放在一起） */
export type MaintenanceState = {
  /** 超管的开关意图（`site_state.enabled` 原值） */
  enabled: boolean
  message: string
  /** 自动关闭时刻（毫秒；null = 不自动关） */
  until: number | null
  /** 定时开启时刻（毫秒；null = 立即生效） */
  scheduledFrom: number | null
}

/**
 * **"现在到底是不是维护中"的唯一判据**（服务端权威）。
 *
 * 三条，按顺序：
 *   ① 没开 → 不是；
 *   ② 还没到定时开启时刻 → 不是（**到点自动开**）；
 *   ③ 已经过了自动关闭时刻 → 不是（**到点自动关**）。
 * ⚠️ 这里**只算、不落库**：`GET /api/status` 是**匿名**接口，
 *    匿名请求不该产生任何写。把过期的行落回 `false` 是**超管接口**
 *    （`POST /api/admin/maintenance {action:'state'}`）顺手做的事（幂等）。
 */
export function maintenanceEffective(s: MaintenanceState, nowMs: number): boolean {
  if (!s.enabled) return false
  if (s.scheduledFrom !== null && nowMs < s.scheduledFrom) return false
  if (s.until !== null && nowMs >= s.until) return false
  return true
}

/** 给界面用的一句话（"还剩多久" / "什么时候自动开"） */
export function maintenanceText(s: MaintenanceState, nowMs: number): string {
  if (maintenanceEffective(s, nowMs)) {
    if (s.until === null) return '维护中（没有自动关闭时刻 —— 这不该出现，服务端会强制写）'
    return `维护中 · 还剩 ${leftText(s.until - nowMs)}`
  }
  if (s.enabled && s.scheduledFrom !== null && nowMs < s.scheduledFrom) {
    return `已定时：${leftText(s.scheduledFrom - nowMs)}后自动开启` + (s.until ? ` · ${fmt(s.until)} 自动关闭` : '')
  }
  if (s.enabled && s.until !== null && nowMs >= s.until) return '已到点自动关闭（行还在，超管看一眼即可落回未开启）'
  return '未开启'
}

function leftText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`
}

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ============================================================
   表单：四条校验 + 归一化
   ============================================================ */

export type MaintenanceForm = {
  /** 想开还是想关 */
  enabled: boolean
  message: string
  /** 自动关闭（小时）。`null` / 认不出 → 用默认 4 小时（**不许留空**） */
  hours: number | null
  /** 勾了"定时开启" */
  scheduled: boolean
  /** 定时开始（毫秒；null = 没填） */
  fromMs: number | null
  /** 定时结束（毫秒；null = 没填） */
  toMs: number | null
}

export type MaintenanceRow = {
  enabled: boolean
  message: string
  /** 毫秒时间戳（null = 不自动关）；存库时翻成 ISO */
  until: number | null
  scheduledFrom: number | null
}

export type MaintenanceVerdict =
  | {
      ok: true
      row: MaintenanceRow
      /** R2 生效了：勾了定时但两个都没填 → 已降级为立即生效 */
      downgraded: boolean
      /** 归一化后真正生效的自动关闭小时数 */
      hours: number
    }
  | { ok: false; rule: 'R1' | 'R3' | 'R4'; error: string }

/** 把小时数归一成四档之一（认不出 → 默认 4） */
export function normalizeHours(v: number | null | undefined): number {
  const n = Number(v)
  return (MAINTENANCE_HOURS as readonly number[]).includes(n) ? n : MAINTENANCE_DEFAULT_HOURS
}

/**
 * 四条校验 + 归一化（**服务端与前端各一份，逐字相同**）。
 * ⚠️ 顺序是有意的：R1/R3 先判"填得对不对"，R4 再判"两个都对但顺序不对"，
 *    R2 最后 —— 它是**唯一一条不报错的**（降级），放在最后才不会盖住前三条。
 */
export function validateMaintenanceForm(
  form: MaintenanceForm,
  nowMs: number,
): MaintenanceVerdict {
  const hours = normalizeHours(form.hours)

  /* ---- 关闭：一键关掉，时刻与文案一起清空（"message 只在开启时有意义"）---- */
  if (!form.enabled) {
    return { ok: true, row: { enabled: false, message: '', until: null, scheduledFrom: null }, downgraded: false, hours }
  }

  /* ---- R1：勾了定时、填了结束、却没填开始 ---- */
  if (form.scheduled && form.toMs !== null && form.fromMs === null) {
    return {
      ok: false,
      rule: 'R1',
      error: '填了结束时间就必须填开始时间 —— 只填结束的那一段没有起点，它永远不会自动开启',
    }
  }

  /* ---- R3：没勾定时（= 想立即生效）、却只填了结束 ---- */
  if (!form.scheduled && form.toMs !== null && form.fromMs === null) {
    return {
      ok: false,
      rule: 'R3',
      error:
        '只填了结束时间 —— 要么把开始时间也填上（那就是定时开启），要么清掉结束时间' +
        `（立即开启，${MAINTENANCE_DEFAULT_HOURS} 小时后自动关）`,
    }
  }

  /* ---- R4：两端都填了，但结束不晚于开始 ---- */
  if (form.fromMs !== null && form.toMs !== null && form.toMs <= form.fromMs) {
    return {
      ok: false,
      rule: 'R4',
      error: '结束时间必须晚于开始时间 —— 否则那一段永远不会开启（公告的生效区间是同一条纪律）',
    }
  }

  /* ---- R2：勾了定时、两个都没填 → **降级为立即生效，不报错** ---- */
  const downgraded = form.scheduled && form.fromMs === null && form.toMs === null

  const scheduledFrom = downgraded ? null : form.fromMs
  /*
   * 🔴 **强制自动关闭**（防呆 2）：`enabled=true` 时 `until` **必须有值** ——
   *    不允许"永久开启"（那是"开了忘了关"这种事故的温床）。
   *    · 定时开启了：结束填了就用它，没填就用 `开始 + N 小时`；
   *    · 立即开启：`now + N 小时`。
   */
  const until =
    scheduledFrom !== null
      ? (form.toMs ?? scheduledFrom + hours * 3_600_000)
      : nowMs + hours * 3_600_000

  const message = (form.message ?? '').trim().slice(0, MAINTENANCE_MESSAGE_MAX)

  return {
    ok: true,
    row: { enabled: true, message, until, scheduledFrom },
    downgraded,
    hours,
  }
}

/** 把请求体（前端传上来的原始 JSON）归一成 `MaintenanceForm` */
export function formFromBody(body: Record<string, unknown>): MaintenanceForm {
  const ms = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null
    const n = typeof v === 'number' ? v : Date.parse(String(v))
    return Number.isFinite(n) ? n : null
  }
  return {
    enabled: body.enabled === true,
    message: typeof body.message === 'string' ? body.message : '',
    hours: body.hours === null || body.hours === undefined ? null : Number(body.hours),
    scheduled: body.scheduled === true,
    fromMs: ms(body.fromMs ?? body.scheduledFrom),
    toMs: ms(body.toMs ?? body.until),
  }
}

/** 落库前把毫秒翻成 ISO（`null` 原样，**不是空串**） */
export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}
