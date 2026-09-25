/* ============================================================
   维护模式（前端这一份）—— 2026-09-29 管理台第二期
   ------------------------------------------------------------
   🔴 **权威在服务端**（`app/functions/api/_lib/maintenance.ts`）：
      这个文件里的 `validateMaintenanceForm()` 只用于**面板表单的即时校验与预览**
      （超管还没点提交，就得看到"这样填会发生什么"）。
      ⚠️ 手打 `/api/admin/maintenance` 的人绕不过服务端那一条 —— 那边会**再判一次**。

   🔴 两份实现**必须逐字相同**（这是刻意的重复，不是疏忽）：
      前端产物与 Pages Function 是两个构建目标，跨目录 import 会把两边绑死
      （与 `notice.ts` ↔ `scheduled_roles()` 那三份清单同一条理由）。
      代价用**一条源码文本断言**补回来：`nav-checks.mjs` 逐条比对常量与四句报错文案。

   🔴 **四条校验逐条照抄参考项目**（用户点名）：
      R1 填了结束就必须填开始 · R2 勾了定时但两个都没填 → **降级为立即生效**
      R3 只填结束 → 拒 · R4 结束必须晚于开始
   ============================================================ */

import { isRemote } from './supabase'
import { apiMessage, postApi } from './api'

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

export type MaintenanceStatus = {
  enabled: boolean
  message: string
  /** 自动关闭时刻（毫秒） */
  until: number | null
  /**
   * 这次是怎么读到的：
   *  · `ok`     —— 读到了（`enabled` 就是结论）
   *  · `failed` —— **读不到**：按"未维护"放行（fail-open），但必须显式告诉用户/超管
   *  · `local`  —— 本地模式（没有服务端），按"未维护"处理
   */
  read: 'ok' | 'failed' | 'local'
  /** 读不到时的原因（原文，面板上要显示） */
  reason: string
  /** 这次读数的时刻（毫秒）—— 渲染必须是纯的，所以"现在"是一次取数的产物 */
  at: number
}

export const MAINTENANCE_UNKNOWN: MaintenanceStatus = {
  enabled: false,
  message: '',
  until: null,
  read: 'local',
  reason: '本地模式：没有服务端，维护状态读不到（按未维护处理）',
  at: 0,
}

/** 从服务端回话里读出状态（**只认那三个字段**；多出来的一个都不用） */
function parseStatus(raw: unknown, at: number): MaintenanceStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.enabled !== 'boolean') return null
  const until = typeof o.until === 'string' ? Date.parse(o.until) : null
  return {
    enabled: o.enabled,
    message: typeof o.message === 'string' ? o.message : '',
    until: until !== null && Number.isFinite(until) ? until : null,
    read: 'ok',
    reason: '',
    at,
  }
}

/**
 * 读一次维护状态（`GET /api/status`，**匿名可读、只回三个字段**）。
 *
 * 🔴 **读不到时按"未维护"处理（fail-open）**，但**绝不把它说成"正常"**：
 *    回话里 `read:'failed'` + `reason` 原文，面板上显示成**灰的"维护状态：读不到"**。
 *    反过来（读不到就算维护中）会让**一次接口抖动锁死全校**。
 *
 * ⚠️ 它**不抛异常**：调用方（每 30 秒的一次轮询）不该因为一次网络抖动就崩。
 */
export async function fetchMaintenanceStatus(): Promise<MaintenanceStatus> {
  const at = Date.now()
  if (!isRemote) return { ...MAINTENANCE_UNKNOWN, at }
  try {
    const res = await fetch('/api/status', { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let why = `HTTP ${res.status}`
      try {
        const b = (await res.json()) as { error?: string }
        if (b?.error) why = b.error
      } catch {
        /* 非 JSON（比如前端 dev server 的 404 HTML）—— 保持 HTTP 码 */
      }
      return { enabled: false, message: '', until: null, read: 'failed', reason: why, at }
    }
    const parsed = parseStatus(await res.json(), at)
    if (!parsed) {
      return {
        enabled: false,
        message: '',
        until: null,
        read: 'failed',
        reason: '服务端回话里没有 enabled 字段（形状不对）',
        at,
      }
    }
    return parsed
  } catch (e) {
    return {
      enabled: false,
      message: '',
      until: null,
      read: 'failed',
      reason: `读不到（${e instanceof Error ? e.message : String(e)}）`,
      at,
    }
  }
}

/** 面板上那一下"重新读取"用：带 JWT 走超管接口（顺带把"到点该关"的行落回 false） */
export async function fetchMaintenanceAdminState(): Promise<
  | { ok: true; state: AdminMaintenanceState }
  | { ok: false; status: number; message: string }
> {
  if (!isRemote) {
    return { ok: false, status: 0, message: '本地模式：没有服务端，维护模式改不了也读不到' }
  }
  const r = await postApi('/api/admin/maintenance', { action: 'state' })
  if (!r.ok) return { ok: false, status: r.status, message: apiMessage(r, '读维护状态失败') }
  const body = r.data
  const m = (body.maintenance ?? {}) as Record<string, unknown>
  return {
    ok: true,
    state: {
      enabled: m.enabled === true,
      effective: m.effective === true,
      message: String(m.message ?? ''),
      until: typeof m.untilIso === 'string' ? Date.parse(m.untilIso) : null,
      scheduledFrom: typeof m.scheduledFromIso === 'string' ? Date.parse(m.scheduledFromIso) : null,
      text: String(m.text ?? ''),
      updatedAt: typeof m.updatedAt === 'string' ? Date.parse(m.updatedAt) : null,
      updatedBy: typeof m.updatedBy === 'string' ? m.updatedBy : null,
      autoOff: m.autoOff === true,
      mail: (body.mail ?? {}) as {
        configured?: boolean
        recipientConfigured?: boolean
        sentToday?: number | null
        cap?: number
      },
    },
  }
}

export type AdminMaintenanceState = {
  enabled: boolean
  effective: boolean
  message: string
  until: number | null
  scheduledFrom: number | null
  text: string
  updatedAt: number | null
  updatedBy: string | null
  autoOff: boolean
  mail: {
    configured?: boolean
    /** 🆕 2026-09-30：收件人（`ADMIN_NOTIFY_EMAIL`）配了没有 —— 与 `configured` 是两件事 */
    recipientConfigured?: boolean
    sentToday?: number | null
    cap?: number
  }
}

/* ============================================================
   表单：四条校验 + 归一化（**与服务端逐字相同**）
   ============================================================ */

export type MaintenanceForm = {
  enabled: boolean
  message: string
  hours: number | null
  scheduled: boolean
  fromMs: number | null
  toMs: number | null
}

export type MaintenanceRow = {
  enabled: boolean
  message: string
  until: number | null
  scheduledFrom: number | null
}

export type MaintenanceVerdict =
  | { ok: true; row: MaintenanceRow; downgraded: boolean; hours: number }
  | { ok: false; rule: 'R1' | 'R3' | 'R4'; error: string }

/** 把小时数归一成四档之一（认不出 → 默认 4） */
export function normalizeHours(v: number | null | undefined): number {
  const n = Number(v)
  return (MAINTENANCE_HOURS as readonly number[]).includes(n) ? n : MAINTENANCE_DEFAULT_HOURS
}

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

/** 面板上"这样提交会发生什么"的预览（**只用于显示**） */
export function previewText(form: MaintenanceForm, nowMs: number): string {
  const v = validateMaintenanceForm(form, nowMs)
  if (!v.ok) return `⚠️ ${v.error}`
  if (!v.row.enabled) return '提交后：关闭维护模式（全校恢复正常）'
  const open = v.row.scheduledFrom === null ? '立即开启' : `${fmt(v.row.scheduledFrom)} 自动开启`
  const close = v.row.until === null ? '⚠️ 没有自动关闭时刻' : `${fmt(v.row.until)} 自动关闭`
  return `提交后：${open} · ${close}${v.downgraded ? '（定时两个都没填 → 已降级为立即生效）' : ''}`
}

function fmt(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `datetime-local` 输入框的值 ↔ 毫秒（**本地时区**，与 `Admin.tsx` 的 `toLocalInput` 同一口径） */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 空串 → null；读不出时间 → null（**不抛错**：输入框正在被编辑时中间态很正常） */
export function inputToMs(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}
