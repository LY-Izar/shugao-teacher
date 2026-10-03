/**
 * `POST /api/admin/maintenance` —— **维护模式的唯一写出口 + 超管读状态**
 * （2026-09-29 管理台第二期）。
 *
 * 设计见 `管理台第二期方案.md` §二.3 · 落地口径见 `功能设计与不变量.md` §二十五。
 *
 * ============================================================
 * 🔴 判据：`is_super_admin()`，**不是** `can_manage_teachers()`
 * ============================================================
 *   · `can_manage_teachers()` 含**教务处**，而维护是**平台**的动作、不是学校的动作；
 *   · 误触的代价是"**全校用不了**" —— 把能按这个按钮的人从 1 个变成 2 个，代价不对称。
 *   · `false` → **403**；**函数没建（第 13 段没跑）→ 503「去跑第 13 段」**
 *     （`teacher-account.ts:159-160` 的纪律：把"环境没准备好"说成"你没权限"，
 *      会让人去改权限设置，越改越乱）。
 *
 * ============================================================
 * 🔴 防呆（用户点名的那几条，逐条落在这里）
 * ============================================================
 *   · **二次确认要输入字符串 `MAINTENANCE`**（前端 `disabled` 只是体验，**这里才是闸门**）；
 *   · **强制自动关闭**：`enabled=true` 时 `until` 一定有计划（默认 4 小时）；
 *   · **四条表单校验**（R1/R2/R3/R4）在 `_lib/maintenance.ts`，**只有一处实现**；
 *   · **超管自己不受影响** —— 那是前端"`/admin` 不参与维护判定"的事，
 *     但那一句之所以安全，正是因为**只有超管**能读到这个接口（403 挡着）。
 *
 * ⚠️ **不做"维护时强制登出"**（用户拍板）：登录态是 7 天，一次误触 = 100 多人重登。
 *    只跳转、不登出 —— 判据是"下一次轮询/交互时被送进维护页"。
 *
 * 环境变量：SUPABASE_URL / VITE_SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  type Read,
  anonKey,
  audit,
  baseUrl,
  caller,
  isMissing,
  json,
  mailedInLastDay,
  needStage,
  read,
  rpcBool,
  serviceKey,
  svc,
} from '../_lib/supa'
import {
  MAINTENANCE_CONFIRM_WORD,
  type MaintenanceState,
  formFromBody,
  isoOrNull,
  maintenanceEffective,
  maintenanceText,
  validateMaintenanceForm,
} from '../_lib/maintenance'
import { MAIL_DAILY_CAP, mailConfigured, mailTo } from '../_lib/mail'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin / can_manage_teachers）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/* ═══════════════════════════════════════════════════════════════════════════
   🔴 `unlock` 的**限流**（2026-10-03）—— 这是本文件里**唯一免登录**的入口
   ------------------------------------------------------------------------
   为什么必须有：其余动作都要求「有 JWT 且 `is_super_admin()`」，
   而 `unlock` 恰恰是**给"还没有会话"的人**用的 —— 所以它是**唯一能被匿名反复打**的地方。
   没有限流时它就是一台**在线试密码机**。

   为什么是**内存**计数而不是数据库/Redis：这一层是"减少噪音"，
   不是安全边界 —— ⚠️ **真正的判据是 Supabase 那边**（它自己也有速率限制）
   与 `is_super_admin()`。所以这一层**放宽了也不会让人进得去**。
   ⚠️ 已知局限：Cloudflare 每个 isolate 独立计数 ⇒ 多实例时实际上限会放大。
     方向是安全的（只放宽次数，不放宽判据）。要更严就得落库，那是另一件事。

   数字怎么定的：5 次失败 → 锁 5 分钟。真人输错两三次很正常（手机输入法+手抖）；
   而试密码的人不会愿意等 5 分钟。
   ═══════════════════════════════════════════════════════════════════════ */
const UNLOCK_MAX_FAILS = 5
const UNLOCK_LOCK_MS = 5 * 60 * 1000
/** IP → { 失败次数, 锁定到什么时候 } */
const unlockFails = new Map<string, { n: number; until: number }>()

function ipOf(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP')?.trim() ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

function unlockGate(request: Request): { ok: true } | { ok: false; message: string } {
  const rec = unlockFails.get(ipOf(request))
  if (rec && rec.until > Date.now()) {
    const mins = Math.max(1, Math.ceil((rec.until - Date.now()) / 60_000))
    return { ok: false, message: `试太多次了，${mins} 分钟后再试。` }
  }
  return { ok: true }
}

function recordUnlockFailure(request: Request): void {
  const ip = ipOf(request)
  const prev = unlockFails.get(ip)
  const n = (prev?.n ?? 0) + 1
  unlockFails.set(ip, n >= UNLOCK_MAX_FAILS ? { n: 0, until: Date.now() + UNLOCK_LOCK_MS } : { n, until: 0 })
}

function clearUnlockFailures(request: Request): void {
  unlockFails.delete(ipOf(request))
}
const NEED_STAGE23 = needStage('23', '平台设置（维护模式）')

type Body = {
  action?: 'state' | 'set' | 'unlock'
  /** set */
  enabled?: boolean
  message?: string
  hours?: number | null
  scheduled?: boolean
  fromMs?: number | null
  toMs?: number | null
  /** 🔴 二次确认：开启时必须逐字等于 MAINTENANCE */
  confirm?: string
}

const SELECT_COLS = 'enabled,message,until,scheduled_from,updated_by,updated_at'

function toState(row: Record<string, unknown> | undefined): MaintenanceState {
  const ms = (v: unknown): number | null => {
    if (!v) return null
    const t = Date.parse(String(v))
    return Number.isFinite(t) ? t : null
  }
  return {
    enabled: row?.enabled === true,
    message: String(row?.message ?? ''),
    until: ms(row?.until),
    scheduledFrom: ms(row?.scheduled_from),
  }
}

async function loadRow(env: Env): Promise<Read> {
  return read(await svc(env, `/rest/v1/site_state?select=${SELECT_COLS}&key=eq.maintenance`))
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!baseUrl(env) || !anonKey(env)) return json({ status: 'error', message: NEED_SUPABASE }, 503)
  if (!serviceKey(env)) return json({ status: 'error', message: NEED_SERVICE_KEY }, 503)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  const action = body.action ?? 'state'

  /* ═══════════════════════════════════════════════════════════════════════
     🔴🔴 `unlock`：**免登录**的那一条（2026-10-03，用户要求补的）
     ------------------------------------------------------------------------
     为什么它必须存在（这是本功能**最坏的失败模式**，之前只挡住了一半）：

       维护闸门把**整页**换成维护画面 —— **包括 `/login`**。
       ⇒ 一台**没登录过**的设备上，超管**连登录页都进不去**，
         于是「开维护的人把自己关在外面」真的会发生。
       （`MAINTENANCE_EXEMPT_PATHS` 只豁免 `/admin` 与 `/classroom` ——
         那是给**已经登录着**的超管留的路，对**没登录**的那台设备不管用。）

       现在补的这一条是那台设备的路：**在维护画面上按一段固定节奏点页面
       → 出一个密码框 → 输管理员账号密码 → 进 `/admin` 把维护关掉。**

     🔴 **安全性两道，都在这儿，绝不在前端**：
       ① 密码由 **Supabase 自己校验**（`auth/v1/token?grant_type=password`，
          用 **anon key** —— 那把公开钥匙只能"验证身份"，读不到任何表）；
       ② 拿到 token 后**再问一次数据库** `is_super_admin()` ——
          密码对的**普通教师也进不去**。
       ⚠️ 所以"知道别人的密码" ≠ "能进维护面板"，必须**本来就是最高管理员**。

     ⚠️ 为什么把 token 返给前端：`/admin` 要靠会话里的 JWT 才能读接口。
       这里返回的是**该账号自己的**会话（不是新造的后门 token），
       前端 `setSession()` 收下之后，一切照常走既有那条路。

     ⚠️ **限流**：这是唯一免登录的入口，🔴 必须限 —— 见 `unlockGate`。
  ═══════════════════════════════════════════════════════════════════════ */
  if (action === 'unlock') {
    const gate = unlockGate(request)
    if (!gate.ok) return json({ status: 'error', message: gate.message }, 429)

    const raw = body as { email?: unknown; password?: unknown }
    const email = String(raw.email ?? '').trim()
    const password = String(raw.password ?? '')
    if (!email || !password) return json({ status: 'error', message: '账号和密码都要填。' }, 400)

    /* ① 密码交给 Supabase 校验（用 anon key —— 它只能验证身份） */
    /*
     * ⚠️ 这里**必须用具名类型**，不能写 `typeof authed`：
     *   那一行上 `authed` 已经被窄化成 `null`，`as typeof authed` 就变成 `as null`
     *   ⇒ 后面三行全部报 `Property 'access_token' does not exist on type 'never'`。
     *   （tsc 抓的，不是猜的。）
     */
    type SupaAuthed = { access_token?: string; refresh_token?: string; expires_in?: number }
    let authed: SupaAuthed | null = null
    try {
      const r = await fetch(`${baseUrl(env)}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: anonKey(env) },
        body: JSON.stringify({ email, password }),
      })
      if (!r.ok) {
        recordUnlockFailure(request)
        /* 🔴 **不回显 Supabase 原文**：那会漏"账号在不在 / 有没有确认过 / 被限流了" */
        return json({ status: 'error', message: '账号或密码不对。' }, 401)
      }
      authed = (await r.json()) as SupaAuthed
    } catch {
      return json({ status: 'error', message: '连不上账号服务，稍后再试。' }, 502)
    }
    const accessToken = authed?.access_token
    const refreshToken = authed?.refresh_token
    if (!accessToken || !refreshToken) {
      return json({ status: 'error', message: '账号服务没有给回会话，请稍后再试。' }, 502)
    }

    /* ② 再问数据库：这个账号**是不是最高管理员**。密码对但不是超管 ⇒ 一样进不去。 */
    const isSuper = await rpcBool(env, accessToken, 'is_super_admin')
    if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
    if (!isSuper) {
      return json({ status: 'forbidden', message: '这个账号不是最高管理员 —— 维护模式只能由平台主人开关。' }, 403)
    }

    clearUnlockFailures(request)
    return json({
      status: 'ok',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: authed?.expires_in ?? 3600,
    })
  }

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /* 🔴 本能力的全部安全性就在这一句（判据在数据库，不在这里重写规则） */
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!isSuper) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员能开关维护模式。它是**平台**的动作（不是学校的动作），' +
          '而误触的代价是"全校用不了" —— 所以教务处 / 年级主任 / 班主任都不在这一档。',
      },
      403,
    )
  }

  /* ---------------- state：读状态（顺手把"到点该关"的行落回 false，幂等） ---------------- */
  if (action === 'state') {
    let row
    try {
      row = await loadRow(env)
    } catch (e) {
      return json(
        { status: 'error', message: `读维护状态失败：${e instanceof Error ? e.message : String(e)}` },
        502,
      )
    }
    if (!row.ok) {
      return json({ status: 'error', message: isMissing(row) ? NEED_STAGE23 : '读维护状态失败' }, isMissing(row) ? 503 : 502)
    }

    let state = toState(row.rows[0])
    const now = Date.now()
    /*
     * 🔴 **到点自动关的第二个来源**（第一个是"读的时候算"）：
     *    方案 §二.3 的失败表写着"服务端每次读都顺手把过期的 enabled 落回 false（幂等）"。
     *    ⚠️ 这件事**只在超管接口里做**：`GET /api/status` 是**匿名**的，
     *       匿名请求不该产生任何写（那是把"一次读"变成"一次可被外部触发的写"）。
     */
    let autoOff = false
    if (state.enabled && state.until !== null && now >= state.until) {
      const patch = await read(
        await svc(env, '/rest/v1/site_state?key=eq.maintenance', {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            enabled: false,
            message: '',
            until: null,
            scheduled_from: null,
            updated_by: me.id,
            updated_at: new Date().toISOString(),
          }),
        }),
      )
      if (patch.ok) {
        autoOff = true
        state = { enabled: false, message: '', until: null, scheduledFrom: null }
        await audit(env, {
          actorId: me.id,
          action: 'maintenance.auto-off',
          target: 'maintenance',
          detail: '到点自动关闭（读状态时顺手落回 false，幂等）',
          affected: 1,
        })
      }
    }

    const sentToday = await mailedInLastDay(env)
    return json({
      status: 'ok',
      maintenance: {
        ...state,
        effective: maintenanceEffective(state, now),
        text: maintenanceText(state, now),
        untilIso: isoOrNull(state.until),
        scheduledFromIso: isoOrNull(state.scheduledFrom),
        updatedAt: row.rows[0]?.updated_at ? String(row.rows[0].updated_at) : null,
        updatedBy: row.rows[0]?.updated_by ? String(row.rows[0].updated_by) : null,
        autoOff,
      },
      /*
       * 🔴 `recipientConfigured` 与 `configured` 是**两件事**，都要摆给面板：
       *    只有 key、没有收件人（`ADMIN_NOTIFY_EMAIL`）时邮件一封也发不出去。
       *    不报这一项，面板就会说"通道是好的" —— 那是**面板说谎**（本项目的头号禁忌）。
       * ⚠️ 只报布尔，**不回显地址**（与 config-check 那条"只回报在/不在"同一条纪律）。
       */
      mail: {
        configured: mailConfigured(env),
        recipientConfigured: Boolean(mailTo(env)),
        sentToday,
        cap: MAIL_DAILY_CAP,
      },
    })
  }

  /* ---------------- set：开 / 关 ---------------- */
  if (action === 'set') {
    /*
     * 🔴 二次确认：**开启**才要（关闭不需要防呆 —— 关错了的代价是"能用了"）。
     *    前端那个 `disabled` 只是体验；手打接口的人也要过这一关。
     */
    if (body.enabled === true && String(body.confirm ?? '').trim() !== MAINTENANCE_CONFIRM_WORD) {
      return json(
        {
          status: 'error',
          message:
            `开启维护模式要把确认字符串逐字填成 ${MAINTENANCE_CONFIRM_WORD} —— ` +
            '它会立刻把全校（含教室端大屏）切到维护画面。',
        },
        400,
      )
    }

    const verdict = validateMaintenanceForm(formFromBody(body as Record<string, unknown>), Date.now())
    if (!verdict.ok) {
      /* 四条校验各自带代号（R1/R3/R4），界面上直接显示这句话 */
      return json({ status: 'error', rule: verdict.rule, message: verdict.error }, 400)
    }

    const patch = await read(
      await svc(env, '/rest/v1/site_state?key=eq.maintenance', {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          enabled: verdict.row.enabled,
          message: verdict.row.message,
          until: isoOrNull(verdict.row.until),
          scheduled_from: isoOrNull(verdict.row.scheduledFrom),
          updated_by: me.id,
          updated_at: new Date().toISOString(),
        }),
      }),
    )
    if (!patch.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(patch) ? NEED_STAGE23 : '写维护状态失败',
          detail: patch.text.slice(0, 200),
        },
        isMissing(patch) ? 503 : 502,
      )
    }

    const next: MaintenanceState = {
      enabled: verdict.row.enabled,
      message: verdict.row.message,
      until: verdict.row.until,
      scheduledFrom: verdict.row.scheduledFrom,
    }
    const now = Date.now()
    const audited = await audit(env, {
      actorId: me.id,
      action: verdict.row.enabled ? 'maintenance.on' : 'maintenance.off',
      target: 'maintenance',
      detail: verdict.row.enabled
        ? `${verdict.downgraded ? '（定时两个都没填 → 降级为立即生效）' : ''}` +
          `通告：${verdict.row.message.slice(0, 60) || '(默认文案)'} · 自动关：${isoOrNull(verdict.row.until) ?? '无'}`
        : `已关闭（${verdict.hours} 小时档位不影响关闭）`,
      affected: 1,
    })

    return json({
      status: 'ok',
      maintenance: {
        ...next,
        effective: maintenanceEffective(next, now),
        text: maintenanceText(next, now),
        untilIso: isoOrNull(next.until),
        scheduledFromIso: isoOrNull(next.scheduledFrom),
        updatedAt: new Date(now).toISOString(),
        updatedBy: me.id,
        autoOff: false,
      },
      downgraded: verdict.downgraded,
      hours: verdict.hours,
      /** ⚠️ 留痕失败要把话说出来（它不是"没发生"，是"没记上"） */
      audited,
    })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/**
 * GET 回一份"接口活着"的自述 —— **不回任何状态**。
 * 用途只有一个：让人能确认"这个路径部署上去了没有"（否则 404 与 403 很难区分）。
 */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/admin/maintenance',
    method: 'POST',
    body: { action: 'state | set', set: { enabled: true, confirm: 'MAINTENANCE' } },
    note: '需要登录，且判据是数据库的 is_super_admin()',
  })
}
