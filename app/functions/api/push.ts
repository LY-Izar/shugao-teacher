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
 *
 *     🔴 **2026-10-05 补：这一条同时返回全站公告**（`announcements`，schema §22）——
 *       原来这里**只读 `notices`** ⇒ 超管在电脑上发的全站公告**永远到不了手机**
 *       （用户实测"电脑上发通知，手机没弹"很可能就是它）。
 *       · **判据复用点 = `sbAs(env, access, …)`**（老师自己的会话，就是下面读通知那一个）
 *         ⇒ `announcements_visible`（§22.3）在这一读上**原样生效**；
 *       · ⇒ 服务端**一个自己的可见性条件都不加**（连 `revoked_at` 都不加），
 *         可见性**只有一处判据**（那条 RLS 策略，教师端横幅走的也是它）；
 *       · ⛔ 绝不用 `svc()`（service_role）读公告 —— 那就是绕开 RLS（安全红线）。
 *       · 🔴 两边**各有各的 cursor**（通知 `since`/`cursor`，公告 `annSince`/`annCursor`）：
 *         共用一个是错的 —— 一方一次多于 10 条时，另一方的 cursor 会被顶到未来、
 *         中间那几条**永远读不到**（而"轰炸"和"漏掉"是同一个机制的两面）。
 *         两条的**语义**仍然逐字一致：`> cursor` 单调递增、`asc`、`limit 10`、
 *         去重靠行 id（原生那侧用 id 当通知 id）。
 *       · 公告的 cursor 刻度 = `greatest(created_at, active_from)`：
 *         `active_from` 是**未来**的公告（§22.1 允许排期）在创建时**被 RLS 挡着**，
 *         只按 `created_at` 判它会**永远收不到**（创建时刻早就落在 cursor 之后了）
 *         ⇒ 过滤写成 `created_at > since OR active_from > since`。
 *       · ⚠️ 公告读失败（§22 没跑 / 网络）**不许连累通知**：通知照旧返回，
 *         另回一个 `annError` 说明原因（§三.5：不许静默）。
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
  /*
   * 🔴 **响应有两种形状都要认**（2026-10-05 真机第二轮的教训）：
   *   裸 REST 调 `/auth/v1/admin/generate_link` 回的是**扁平**的
   *   `{ hashed_token, action_link, email_otp, … }`；supabase-js 才把它包成
   *   `{ properties: { hashed_token, … } }`。只认包着的那一种 = 这一步永远死在
   *   "没返回 token"（上一版真机上"没能建立推送会话"就是它）。
   */
  const genBody = (await gen.json()) as {
    hashed_token?: string
    email_otp?: string
    properties?: { hashed_token?: string; email_otp?: string }
  }
  const hashed: string | undefined = genBody.hashed_token ?? genBody.properties?.hashed_token
  const otp: string | undefined = genBody.email_otp ?? genBody.properties?.email_otp
  if (!hashed && !otp) {
    return {
      error:
        '造会话第 1 步没返回 token（响应里没有 hashed_token / email_otp；拿到的是 ' +
        JSON.stringify(Object.keys(genBody)) +
        '）。',
    }
  }
  /*
   * 🔴 ② verify 端点对请求形状**各版本不一致**（真机第三轮实测：三样都发了仍回
   *    400 "Or the token_hash and type should be provided"）—— 按**优先级逐形状试**：
   *    ① token_hash + type + email（hash 流）② email + token（六位码流）。
   *    哪个被接受用哪个；全失败时 detail 带上"发过哪些字段 + 各自的上游原文"。
   */
  const candidates: Array<{ body: Record<string, unknown>; label: string }> = []
  if (hashed) candidates.push({ body: { type: 'magiclink', token_hash: hashed, email }, label: 'token_hash 形' })
  if (otp) candidates.push({ body: { type: 'magiclink', email, token: otp }, label: 'email_otp 形' })
  let lastErr = ''
  for (const cand of candidates) {
    const verify = await fetch(`${baseUrl(env)}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        apikey: anonKey(env),
        Authorization: `Bearer ${anonKey(env)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cand.body),
    })
    if (!verify.ok) {
      const t = (await verify.text()).slice(0, 140)
      lastErr += `［${cand.label}：HTTP ${verify.status} ${t}］`
      continue
    }
    const s = (await verify.json()) as { access_token?: string; refresh_token?: string }
    if (!s.access_token || !s.refresh_token) {
      lastErr += `［${cand.label}：200 但没回会话］`
      continue
    }
    return { access: s.access_token, refresh: s.refresh_token }
  }
  return { error: `造会话第 2 步失败。${lastErr}` }
}

/**
 * 🔴🔴 2026-10-05 真机第五轮：**整条处理过程包一层 try/catch**（改之前一处都没有）。
 *
 * 真机横幅原文（用户截的）：
 *   `startPush 里 register（POST …/api/push）这一步：HTTP 500 · 服务端返回的不是 JSON
 *    对象（响应体开头：error code: 1101）`
 * `error code: 1101` 是 **Cloudflare 自己的码** = Worker 抛了**未捕获的 JavaScript 异常**
 * —— 函数里任何一处 `await ….json()`、任何一次 `undefined.xxx` 抛出来，平台都会把响应
 * 换成纯文本的 `error code: 1101`（线上实测：`Content-Type: text/plain`、
 * `Content-Length: 17`、HTTP 500）⇒ 原生 `new JSONObject(<纯文本>)` 当场抛 org.json 黑话，
 * **HTTP 码与真因一起被吞掉**（§三.5：不可写的路径要显式报错，不许静默）。
 *
 * ⇒ 这里兜底：异常一律回**JSON**（`status` / `message` / `detail`）+ 502。
 *   `detail` 带**异常原文**（`String(e)` —— 只是消息，**不是**栈，不泄内部信息）
 *   ⇒ 用户把横幅那句话原样发回来就能一路追到真因。
 *
 * ⚠️ 已有的正常分支（register / pull / revoke 的响应体、状态码、字段）**一个字都没动**。
 */
export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  try {
    return await handlePush(context)
  } catch (e) {
    return json(
      {
        status: 'error',
        message: '推送接口出错了（服务端）。把下面这行原样发给管理员。',
        detail: String(e),
      },
      502,
    )
  }
}

/** 真正的处理过程 —— 被上面那层 try/catch 整个罩住（同文件内，不导出） */
async function handlePush(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!serviceKey(env) || !anonKey(env) || !baseUrl(env)) {
    return json(
      { status: 'not_configured', message: '缺少 SUPABASE_URL / ANON / SERVICE_ROLE 环境变量。' },
      503,
    )
  }

  let body: { action?: string; token?: string; since?: number; annSince?: number }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  /*
   * 🔴 2026-10-05：**形状守卫**。
   *   `request.json()` 对字面 `null` 是**成功**的（`null` 是合法 JSON）⇒ `body` 会是
   *   `null` ⇒ 下一句 `body.action` **当场 TypeError**（这是 `error code: 1101` 的一种来路）。
   *   字符串 / 数字 / 布尔同理（`(await request.json())` 的回值就是那几种标量）。
   * ⇒ 读 `.action` **之前**先确认"它是个对象"，不是就回 400「请求格式不对」。
   * ⚠️ 数组是 `typeof === 'object'`，放行 —— 读 `.action` 只会得到 `undefined`（不会抛）。
   */
  if (typeof body !== 'object' || body === null) {
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
    /*
     * 🔴🔴 2026-10-05 真机第五轮：**`Prefer: return=representation` 原来漏了 —— 这就是那条
     *    `error code: 1101` 的真凶**（原生的 register 请求形状是写死的
     *    `{"action":"register"}` + `Authorization: Bearer`，见打包工程
     *    `YlxbNativePlugin.java` 的 `startPush` ⇒ 上面那条形状守卫**不是**它触发的）。
     *
     *    为什么漏了就必炸：PostgREST 对 POST 的默认是 `return=minimal` —— 插成功也只回
     *    **201 + 空体**（这正是全仓别处读 `json()` 的 POST 一律显式写
     *      `Prefer: return=representation` 的原因：`notice.ts` / `teacher-account.ts` /
     *      `announcement.ts` / `feedback.ts` / `admin/release.ts` … 一处不缺）。
     *    而下一句 `await ins.json()` 读的是**空体** ⇒ 抛 `SyntaxError: Unexpected end of
     *    JSON input` ⇒ 冲出函数 ⇒ 平台换成纯文本 1101 ⇒ 原生横幅只剩 org.json 黑话，
     *    "register 永远建不起拉取钥匙"这件事在界面上看不出任何原因。
     *    ⇒ 补上它，`rows[0].token` 那两行才有东西可读（这才是这段代码本来的意思）。
     */
    const ins = await svc(env, '/rest/v1/push_tokens', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
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
    /*
     * 🔴🔴 2026-10-05 真机第五轮：**`await ins.json()` 原来裸着**。
     *    上游回 2xx 但响应体**不是 JSON**（空体 / 纯文本 / HTML 网关页）时它当场抛，
     *    而"到底回了什么"就在那个响应体里 —— 抛掉它等于把唯一的线索丢了（§三.5）。
     * ⇒ 先 `clone()` 留一份原文（`json()` 会把 body 消费掉，克隆出来的那份还能读），
     *    解析失败时把 **HTTP 码 + 响应体开头（≤200 字节）+ 异常原文** 一起写进 `detail`。
     * ⚠️ 这不改任何成功路径：解析成功时 `rows` 与改之前**逐字同一个值**。
     */
    const insRaw = ins.clone()
    let rows: Array<{ token: string }>
    try {
      rows = (await ins.json()) as Array<{ token: string }>
    } catch (e) {
      const t = await insRaw.text().catch(() => '')
      return json(
        {
          status: 'error',
          message: '推送钥匙存进去了，但服务端回的话读不懂（服务端问题）。',
          detail: `HTTP ${ins.status} · 响应体开头：${t.slice(0, 200) || '(空)'} · ${String(e)}`,
        },
        502,
      )
    }
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

    /*
     * 🔴 2026-10-05：**两条路各有各的 cursor，缺省都是"一天前"**。
     *
     * 原来这里没有这个缺省 —— `since` 缺失时退回 `0`（= 1970）⇒ 冷启动那一次会把
     * **全部历史通知**一次性当"新"发出去（老师屏上瞬间几十条）。而原生那侧
     * （`YlxbPushService.pullOnce`）自己有一份"一天前"的缺省 ⇒ 两边口径必须一致：
     * 一天前是**窗口**，不是"漏掉历史"（历史在应用内看得到）。
     * ⚠️ 公告那一路（`annSince` / `annCursor`）用**同一个窗口**，别让它退回 0。
     */
    const dayAgo = Date.now() - 24 * 3600_000
    // ② 按老师自己的会话读（RLS 原样生效）；cursor = 上一次见过的最大 createdAt
    const since = typeof body.since === 'number' && body.since >= 0 ? body.since : dayAgo
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

    /*
     * 🔴🔴 2026-10-05 补：**全站公告**（`announcements`，schema §22）走**同一个会话**读。
     *
     * 断在哪：这一条原样只读 `notices` ⇒ 超管在电脑上发的全站公告**永远到不了手机**
     *   （用户实测"电脑上发通知，手机没弹"很可能就是它）。
     *
     * 🔴 **判据复用点 = 上面那个 `sbAs(env, access, …)`** —— 老师自己的会话 ⇒
     *   `announcements_visible`（§22.3：未撤下 + 生效区间 + 非教室端）在这一读上
     *   原样生效。⇒ 服务端**一个自己的可见性条件都不加**：
     *   可见性判断**只有一处** = 那条 RLS 策略（教师端横幅走的也是它）。
     *   ⚠️ 查询串里那个 `revoked_at=is.null` **不是**第二套判据 —— 它只是**性能筛**
     *     （别把撤下的行取回来再让 RLS 丢掉）＋**意图自明**：少了它行为**一模一样**。
     *     生效区间同理：**一个字都不筛**，交给 RLS（那里是闭区间，自己再写一遍迟早漂开）。
     *   ⛔ **绝不用 `svc()`（service_role）读公告** —— 那就是绕开 RLS（安全红线）。
     *
     * 🔴 **公告的 cursor 刻度 = `greatest(created_at, active_from)`**：
     *   `active_from` 在**未来**的公告（§22.1 允许排期）在创建时**被 RLS 挡着**，
     *   只按 `created_at` 判它会**永远收不到**（创建时刻早就落在 cursor 之后了）
     *   ⇒ 过滤与游标都写成"两列取大"，两边**同一个刻度**，不重不漏。
     *
     * ⚠️ **公告读失败不许连累通知**：通知照旧返回（上面已经算好），另回一个
     *   `annError` 说明原因（§三.5：不许静默）—— 公告那一半坏了不该让整条拉取变红。
     */
    const annSince = typeof body.annSince === 'number' && body.annSince >= 0 ? body.annSince : dayAgo
    const annSinceIso = new Date(annSince).toISOString()
    const enc = encodeURIComponent(annSinceIso)
    let anns: Array<{ id: string; title: string; body: string; createdAt: number }> = []
    let annCursor = annSince
    let annError: string | undefined
    try {
      /*
       * ⚠️ `active_from` **可能为空**（= 立即生效，§22.1）—— `gt.` 对 NULL 恒不成立，
       *   只写 `active_from=gt.<cursor>` 会把"立即生效"的公告**全部漏掉** ⇒ 用 `or=(…)`
       *   把两列并列（PostgREST 至少要有一个合取项成立）。
       */
      const annRes = await sbAs(
        env,
        access,
        `/rest/v1/announcements?select=id,title,body,created_at,active_from` +
          `&or=(created_at.gt.${enc},active_from.gt.${enc})&revoked_at=is.null` +
          `&order=created_at.asc&limit=10`,
      )
      if (!annRes.ok) {
        annError = `公告读取失败（RLS/网络 · HTTP ${annRes.status}）。`
      } else {
        const annRows = (await annRes.json()) as Array<{
          id: string
          title: string
          body: string | null
          created_at: string
          active_from: string | null
        }>
        anns = annRows.map((r) => {
          const created = new Date(r.created_at).getTime() || 0
          const from = r.active_from ? new Date(r.active_from).getTime() || 0 : 0
          const at = Math.max(created, from)
          if (at > annCursor) annCursor = at
          return { id: r.id, title: r.title, body: (r.body ?? '').slice(0, 200), createdAt: at }
        })
      }
    } catch (e) {
      annError = `公告读取出错：${String(e)}`
    }

    /*
     * ⚠️ `annCursor` **只在真的读到行时才写回**：读失败时原样回传收到的那个
     *   ⇒ 原生那侧不会因为"服务端这一轮坏了"把 cursor 推到未来、把中间几条**永远漏掉**。
     *   （与通知那一路同一个语义：cursor 只能由"真的见过的行"推进。）
     */
    return json({ status: 'ok', notices, cursor, announcements: anns, annCursor, annError })
  }

  return json({ status: 'error', message: '未知动作' }, 400)
}
