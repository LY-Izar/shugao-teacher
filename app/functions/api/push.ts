/**
 * 推送拉取（2026-10-02）—— apk 前台服务（YlxbPushService）的三个动作。
 *
 * 🔴 **判据只有一处**：前台服务读通知时**拿的是老师自己的会话 JWT**（RLS 原样生效，
 *    `notices_visible` 照常拦）—— 本文件里**没有**一行"前端说要看哪条就给他哪条"。
 *    会话的来路：register 时用 service_role 给这位老师**单独造一个会话**
 *    （admin generateLink(magiclink) → /auth/v1/verify 换出 access+refresh），
 *    refresh_token 存进 `push_tokens`（schema §41，RLS 全拒）。
 *    ⚠️ refresh token 是**轮换**的：每次 pull 都会拿到新的，**必须立刻写回本表** ——
 *       它只被前台服务这一个使用方持有，所以不存在"跟浏览器抢"的冲突。
 *
 * 🔴 三个动作（POST，Body 里 action 区分）：
 *   · register —— 老师开着应用时调（Authorization: 老师的 JWT）。给这位老师建/换
 *     一把拉取钥匙，返回 `{ token }`（uuid）；前台服务拿它当 `X-Push-Token`。
 *   · pull     —— 前台服务每 30 秒调（X-Push-Token）。按 cursor 返回**新**通知
 *     （id/title/body/createdAt）+ 新 cursor。会话失效（改密码/被登出）时回
 *     `{ reauth: true }` ⇒ 服务端停拉，等老师下次打开应用重新 register。
 *   · revoke   —— 老师登出时调（Authorization: 老师的 JWT）。作废自己的钥匙。
 *
 * 部署：functions/api/push.ts，推 GitHub 后 Cloudflare 自动带上（与 notice.ts 同一套环境变量）。
 */

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function baseUrl(env: Env): string {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
}

function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
}

function serviceKey(env: Env): string {
  return env.SUPABASE_SERVICE_ROLE_KEY ?? ''
}

/** service_role 直调（register / pull 的令牌读写；客户份数据一律 RLS 拦） */
function svc(env: Env, path: string, init?: RequestInit): Promise<Response> {
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

/** 用**调用者的 JWT** 调 Supabase（RLS 生效）—— pull 的读走这条 */
function sbAs(env: Env, token: string, path: string): Promise<Response> {
  return fetch(`${baseUrl(env)}${path}`, {
    headers: { apikey: anonKey(env), Authorization: `Bearer ${token}` },
  })
}

/** 调用者是谁（与 notice.ts 的 caller 同一套：拿 JWT 问 /auth/v1/user） */
async function caller(request: Request, env: Env): Promise<{ id: string; email: string; token: string } | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  const key = anonKey(env)
  if (!token || !key || !baseUrl(env)) return null
  const res = await fetch(`${baseUrl(env)}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string; email?: string }
  return user?.id ? { id: user.id, email: user.email ?? '', token } : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type PushRow = {
  token: string
  teacher_id: string
  email: string | null
  refresh_token: string
  revoked_at: string | null
}

async function findToken(env: Env, token: string): Promise<PushRow | null> {
  const res = await svc(env, `/rest/v1/push_tokens?select=*&token=eq.${encodeURIComponent(token)}&revoked_at=is.null`)
  if (!res.ok) return null
  const rows = (await res.json()) as PushRow[]
  return rows[0] ?? null
}

/**
 * 给老师**单独造一个会话**（service_role 的 admin magic link → verify 换出会话）。
 * 这个会话只归前台服务用 —— 与老师浏览器里的那个会话互不干扰（refresh 轮换不抢）。
 * 🔴 每一步失败都带 `detail`（上游原文片段）—— "没建起来"不给原因 = 把人扔在原地。
 */
async function mintSessionFor(
  env: Env,
  teacherId: string,
  email: string,
): Promise<{ access: string; refresh: string } | { error: string }> {
  if (!email || !UUID_RE.test(teacherId)) return { error: '这个账号没有邮箱，造不了推送会话。' }
  // ① 造 magic link（admin API **不发邮件**，只回一次性 token）
  const gen = await svc(env, '/auth/v1/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email }),
  })
  if (!gen.ok) {
    const t = (await gen.text()).slice(0, 160)
    return { error: `造会话第 1 步失败（HTTP ${gen.status}）：${t}` }
  }
  const genBody = (await gen.json()) as { properties?: { hashed_token?: string } }
  const hashed = genBody.properties?.hashed_token
  if (!hashed) return { error: '造会话第 1 步没返回 token（响应形状变了）。' }
  // ② 用一次性 token 换出真会话（email 一起带上：有的 GoTrue 版本校验它）
  const verify = await fetch(`${baseUrl(env)}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${anonKey(env)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed, email }),
  })
  if (!verify.ok) {
    const t = (await verify.text()).slice(0, 160)
    return { error: `造会话第 2 步失败（HTTP ${verify.status}）：${t}` }
  }
  const s = (await verify.json()) as { access_token?: string; refresh_token?: string }
  if (!s.access_token || !s.refresh_token) return { error: '造会话第 2 步没返回会话。' }
  return { access: s.access_token, refresh: s.refresh_token }
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!serviceKey(env) || !anonKey(env) || !baseUrl(env)) {
    return json(
      { status: 'not_configured', message: '缺少 SUPABASE_URL / ANON / SERVICE_ROLE 环境变量。' },
      503,
    )
  }

  let body: { action?: string; token?: string; since?: number }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  const action = body.action ?? ''

  /* ---------------- register：老师开着应用时建/换拉取钥匙 ---------------- */
  if (action === 'register') {
    const me = await caller(request, env)
    if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)
    if (!me.email) return json({ status: 'error', message: '这个账号没有邮箱，收不了推送。' }, 400)

    const minted = await mintSessionFor(env, me.id, me.email)
    if ('error' in minted) {
      return json({ status: 'error', message: '没能为这台设备建立推送会话。', detail: minted.error }, 502)
    }
    const session = { access: minted.access, refresh: minted.refresh }
    await svc(env, '/rest/v1/push_tokens?teacher_id=eq.' + me.id, { method: 'DELETE' })
    const ins = await svc(env, '/rest/v1/push_tokens', {
      method: 'POST',
      body: JSON.stringify({
        teacher_id: me.id,
        email: me.email,
        refresh_token: session.refresh,
      }),
    })
    if (!ins.ok) {
      const t = (await ins.text()).slice(0, 200)
      // 🔴 最常见的一档：§41 那张表还没建（用户没在 Supabase 重跑整份 schema.sql）——
      //    把它从一堆报错里点名出来，别让老师对着一句"没存上"猜。
      if (/PGRST20[45]|42P01|does not exist|schema cache/i.test(t)) {
        return json(
          {
            status: 'error',
            message:
              '数据库还没建推送表（schema §41）：到 Supabase → SQL Editor 把整份 schema.sql 再跑一遍，然后重开应用。',
            detail: t,
          },
          502,
        )
      }
      return json({ status: 'error', message: '推送钥匙没存上（服务端）。', detail: t }, 502)
    }
    const rows = (await ins.json()) as Array<{ token: string }>
    const token = rows[0]?.token
    if (!token || !UUID_RE.test(token)) return json({ status: 'error', message: '推送钥匙没存上。' }, 502)
    return json({ status: 'ok', token })
  }

  /* ---------------- revoke：登出时作废自己的钥匙 ---------------- */
  if (action === 'revoke') {
    const me = await caller(request, env)
    if (!me) return json({ status: 'error', message: '登录已过期' }, 401)
    await svc(env, '/rest/v1/push_tokens?teacher_id=eq.' + me.id, {
      method: 'PATCH',
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    })
    return json({ status: 'ok' })
  }

  /* ---------------- pull：前台服务每 30 秒一次 ---------------- */
  if (action === 'pull') {
    const header = request.headers.get('X-Push-Token') ?? ''
    const token = header.trim()
    if (!UUID_RE.test(token)) return json({ status: 'error', reauth: true, message: '钥匙格式不对' }, 401)
    const row = await findToken(env, token)
    if (!row) return json({ status: 'error', reauth: true, message: '钥匙不存在或已作废，重新打开应用再连。' }, 401)

    // ① 用存着的 refresh_token 换新会话（轮换：换完立刻写回，别丢）
    const refresh = await fetch(`${baseUrl(env)}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: anonKey(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: row.refresh_token }),
    })
    if (!refresh.ok) {
      // 会话死了（改密码 / 被登出）→ 让服务停拉，老师下次打开应用时 register 一把新的
      await svc(env, '/rest/v1/push_tokens?token=eq.' + token, {
        method: 'PATCH',
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      })
      return json({ status: 'error', reauth: true, message: '推送会话已失效，重新打开应用即恢复。' }, 401)
    }
    const session = (await refresh.json()) as { access_token?: string; refresh_token?: string }
    const access = session.access_token ?? ''
    const refreshNew = session.refresh_token ?? row.refresh_token
    if (!access) return json({ status: 'error', reauth: true, message: '推送会话刷新失败。' }, 401)
    await svc(env, '/rest/v1/push_tokens?token=eq.' + token, {
      method: 'PATCH',
      body: JSON.stringify({ refresh_token: refreshNew, last_pull_at: new Date().toISOString() }),
    })

    // ② 按老师自己的会话读（RLS 原样生效）；cursor = 上一次见过的最大 createdAt
    const since = typeof body.since === 'number' && body.since >= 0 ? body.since : 0
    const sinceIso = new Date(since).toISOString()
    const res = await sbAs(
      env,
      access,
      `/rest/v1/notices?select=id,title,body,created_at&created_at=gt.${encodeURIComponent(sinceIso)}&revoked_at=is.null&order=created_at.asc&limit=10`,
    )
    if (!res.ok) return json({ status: 'error', message: '通知读取失败（RLS/网络）。' }, 502)
    const rows = (await res.json()) as Array<{
      id: string
      title: string
      body: string | null
      created_at: string
    }>
    let cursor = since
    const notices = rows.map((r) => {
      const at = new Date(r.created_at).getTime() || 0
      if (at > cursor) cursor = at
      return { id: r.id, title: r.title, body: (r.body ?? '').slice(0, 200), createdAt: at }
    })
    return json({ status: 'ok', notices, cursor })
  }

  return json({ status: 'error', message: '未知动作' }, 400)
}
