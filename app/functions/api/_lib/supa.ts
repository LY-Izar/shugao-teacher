/**
 * 服务端公共件（Cloudflare Pages Functions 的 `_lib`）—— **2026-09-29 管理台第二期新增**。
 *
 * 为什么会有这个文件：第二期一次加了 5 个 Function（`status` / `mail` / `admin/maintenance`
 * / `admin/errors` / `feedback`），它们要做的是**同一件事的四五遍**：
 * 拿调用者 JWT 问数据库判据、用 service_role 读写、把"表没建 / 函数没建"翻成人话。
 *
 * ⚠️ **它不是"第二套写法"，是把 `notice.ts` / `announcement.ts` 里那一套抽出来**：
 *    · `caller()`      —— 与 `notice.ts:184-196` 逐字同款（问 `/auth/v1/user`）；
 *    · `rpcBool()`     —— 与 `notice.ts:203-223` 逐字同款（`'missing'` 与 `false` 分开）；
 *    · `svc*()`        —— 与 `notice.ts:151-162` 的 `sb()` 同款（service_role，绕过 RLS）。
 *
 * 🔴 **`_lib` 这个下划线开头的目录不会变成一个路由**（Cloudflare Pages 的约定：
 *    以 `_` 开头的文件 / 目录不参与路由）。所以这里放共享代码是安全的。
 *
 * 🔴 两个既有 Function（`notice.ts` / `announcement.ts`）**一个字都不动** ——
 *    它们跑得好好的，而"顺手统一一下"正是本仓库出过四次的坑。
 */

export type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  RESEND_API_KEY?: string
  /**
   * 🆕 2026-09-30（隐私整改）：邮件收件人 —— **只从环境变量来**。
   * 代码里**不写任何真实地址**（公开仓库的纪律）。没配时 `sendMail()` 回 `reason:'no_to'`
   * 并**显式报错**，绝不静默发到某个默认地址 —— 见 `_lib/mail.ts` 文件头。
   */
  ADMIN_NOTIFY_EMAIL?: string
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 这一批接口全部是"当下状态"：任何一层缓存都不许留
      'Cache-Control': 'no-store',
    },
  })
}

export function baseUrl(env: Env): string {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
}

export function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
}

export function serviceKey(env: Env): string {
  return env.SUPABASE_SERVICE_ROLE_KEY ?? ''
}

/** 这个 Function 需要的两个变量在不在（不在的话整段回话都拿不到东西） */
export function ready(env: Env): boolean {
  return Boolean(baseUrl(env) && anonKey(env) && serviceKey(env))
}

export const NEED_SERVICE_KEY =
  '服务端还没配置管理员密钥。到 Cloudflare Pages → Settings → Variables and secrets 添加 ' +
  'SUPABASE_SERVICE_ROLE_KEY（Secret），然后重新部署。'

export const NEED_SUPABASE =
  '缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY，请到 Cloudflare Pages 的环境变量里补上。'

/* ---------------- 调用者是谁 ---------------- */

export async function caller(
  request: Request,
  env: Env,
): Promise<{ id: string; token: string } | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const key = anonKey(env)
  if (!key) return null
  const res = await fetch(`${baseUrl(env)}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user?.id ? { id: user.id, token } : null
}

/**
 * 问数据库：这个判据对我返回什么？
 * `'missing'` = 函数还没建（那一段 SQL 没跑）—— 调用方要把它翻成人话，
 * **不能当成 false**（那样会告诉一位超管"你没权限"，让人去改权限设置，越改越乱）。
 */
export async function rpcBool(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown> = {},
): Promise<boolean | 'missing'> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.ok) return text.trim() === 'true'
  if (res.status === 401 || res.status === 403) return false
  if (res.status === 404 || /PGRST202|does not exist|schema cache/i.test(text)) return 'missing'
  return false
}

/** 用**调用者自己的 JWT** 调一个返回 json 的 RPC（`report_frontend_error` 那种） */
export async function rpcJson(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; value: unknown; text: string; status: number }> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let value: unknown = null
  try {
    value = JSON.parse(text)
  } catch {
    value = null
  }
  return { ok: res.ok, value, text, status: res.status }
}

/* ---------------- service_role（绕过 RLS） ---------------- */

export type Read = {
  ok: boolean
  status: number
  rows: Record<string, unknown>[]
  text: string
}

export async function read(res: Response): Promise<Read> {
  const text = await res.text()
  let rows: Record<string, unknown>[] = []
  try {
    const v = JSON.parse(text || '[]')
    if (Array.isArray(v)) rows = v as Record<string, unknown>[]
  } catch {
    rows = []
  }
  return { ok: res.ok, status: res.status, rows, text }
}

/** 🔴 每一次用它之前，都必须已经问过判据（见各 Function 的入口） */
export function svc(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const key = serviceKey(env)
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

/** 表 / 列 / 函数还没建（那一段 SQL 没跑）—— 与 `notice.ts:178-180` 同款 */
export const isMissing = (r: Read) =>
  r.status === 404 ||
  /42P01|42703|PGRST20[45]|PGRST202|does not exist|schema cache/i.test(r.text)

/**
 * 一句人话的"去跑那一段 SQL"。
 * ⚠️ 与 `notice.ts` 的 `NEED_STAGE21` / `announcement.ts` 的 `NEED_STAGE22` 同一个形状 ——
 *    **段号写清楚**，否则超管只能猜是哪一段没跑。
 */
export function needStage(stage: string, what: string): string {
  return (
    `数据库还没跑${what}那一段（仓库里 supabase/schema.sql 第 ${stage} 段）。` +
    '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'
  )
}

/* ---------------- 操作留痕（`admin_audit`） ---------------- */

/**
 * 写一行操作留痕。
 *
 * 🔴 只有**写动作**才走它（开/关维护、删错误日志、发信）——
 *    "谁看过什么"这件事本仓库**刻意不做**（`功能设计与不变量.md` §20.2 的三条理由）。
 * ⚠️ 它自己**绝不抛错**：留痕失败不该把一次已经成功的动作变成失败，
 *    但也不能假装留痕成功了 —— 所以返回值给调用方看一眼（面板上"操作记录"那一栏）。
 */
export async function audit(
  env: Env,
  row: {
    actorId: string | null
    actorName?: string
    action: string
    target?: string
    detail?: string
    affected?: number
  },
): Promise<boolean> {
  try {
    const res = await read(
      await svc(env, '/rest/v1/admin_audit', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          actor_id: row.actorId,
          actor_name: (row.actorName ?? '').slice(0, 60),
          action: row.action.slice(0, 60),
          target: (row.target ?? '').slice(0, 120),
          detail: (row.detail ?? '').slice(0, 300),
          affected: Math.max(0, Math.trunc(row.affected ?? 0)),
        }),
      }),
    )
    return res.ok
  } catch {
    return false
  }
}

/** 数"最近 24 小时发了几封邮件"（Resend 免费额度 100 封/天） */
export async function mailedInLastDay(env: Env): Promise<number | null> {
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const res = await read(
    await svc(
      env,
      `/rest/v1/admin_audit?select=*&action=like.mail.*&at=gt.${encodeURIComponent(since)}`,
      { headers: { Prefer: 'count=exact' } },
    ),
  )
  if (!res.ok) return null
  return res.rows.length
}

/**
 * 数一个过滤条件下有几行（PostgREST 的 `Prefer: count=exact` + `Content-Range`）。
 *
 * ⚠️ **数不到就回 `null`，绝不回 0** —— "0 条错误"与"读不到"在面板上是两种颜色
 *    （本项目最贵的一条教训）。所以调用方必须把 `null` 显示成"无法判断"。
 */
export async function countRows(env: Env, path: string): Promise<number | null> {
  try {
    const res = await svc(env, path, {
      headers: { Prefer: 'count=exact', Range: '0-0' },
    })
    if (!res.ok && res.status !== 206) return null
    const cr = res.headers.get('content-range') ?? ''
    const m = /\/(\d+)\s*$/.exec(cr)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}
