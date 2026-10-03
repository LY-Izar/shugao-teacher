/**
 * `/api/*` 的响应头（2026-10-01 安全加固 A4；🆕 2026-10-04 补跨域预检）。
 *
 * 为什么要有它：Cloudflare Pages 的 `public/_headers` **只作用于静态资源**，
 * 由 Functions 生成的响应**不吃那个文件** —— 所以 `/api/ocr`、`/api/teacher-account`、
 * `/api/notice` 这些接口的响应一直只有 Cloudflare 的默认头（线上实测：连 `nosniff` 都没有）。
 * 这里补上；两边都做才算做完（见 `安全加固方案.md` A3 / A4）。
 *
 * 🔴 `/api/sb/*` **必须原样放行**：
 *   它是数据库的中转，要**原样透传上游响应** —— 头部（`content-encoding` / `content-length`）
 *   与 body **一个字节都不能碰**，碰了浏览器解析会失败；Realtime 还走它的 `Upgrade` 握手。
 *   所以这里连"重造一个 Response"都不做，直接把上游那份返回。
 *   （它自己的头由 `sb/[[path]].ts` 负责；那条路上本来就带 `Cache-Control: no-store`。）
 *
 * 只加头、不读 body：非 `/api/sb` 的接口都是 JSON（几十字节到几 KB），
 * 重造 Response 不会影响流式语义；但 204/304 **没有 body**，那时必须传 null（否则当场抛错）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🆕 2026-10-04 · 跨域（CORS）：**壳里那些 `/api/*` 为什么一条都到不了**
 * ═══════════════════════════════════════════════════════════════════════════
 * exe（`app://-`）与 apk（`https://localhost`）加载的是**打进包里的网页产物**，
 * 它们调站内接口时是**跨域**的（相对路径那一半见 `src/lib/apiBase.ts`）。
 * 线上实测（`curl -H 'Origin: https://localhost'`）：
 *   · `GET /api/status` 的响应里**没有任何** `Access-Control-*` ⇒ 浏览器不给读；
 *   · `OPTIONS /api/admin/config-check` 回 **405** ⇒ 预检失败 ⇒ 带 `authorization`
 *     的 POST 一条都发不出去。
 * ⇒ 这里补两件事：**预检自己回 204** + 给非 `/api/sb/*` 的响应加 `ACAO`。
 *
 * 🔴 为什么可以用 `Access-Control-Allow-Origin: *`（是想过才这么写的，不是偷懒）：
 *   · 这些接口的鉴权是**请求头里的 Bearer JWT**（`getSupabase().auth.getSession()`），
 *     **不用 cookie** ⇒ `*` 不会让"别人家的页面"自动带上受害者的身份；
 *     而 `*` 也**不允许** `credentials: 'include'` 的请求（那种请求浏览器会直接拒）。
 *   · 真正的判据仍在服务端问数据库（`is_super_admin()` / `can_contact_admin()` / RLS）——
 *     **CORS 从来不是权限边界**，它只决定"浏览器肯不肯把回话交给调用者"。
 *   · 同一条路上游就是这么做的：`/api/sb/*` 透传的 Supabase 响应带的就是 `ACAO: *`
 *     （线上实测过，那正是壳里能读到真实班级/作业的原因）。
 *   ⚠️ 反过来：**不许**在这里放开 cookie、也不许把它改成 `credentials` 那一套。
 * ⚠️ 预检分支**不碰 `/api/sb/*`**（`Upgrade` 与透传都不能被我们答掉）。
 */

type Ctx = {
  request: Request
  next: () => Promise<Response>
}

/** 非 `/api/sb/*` 的接口统一这几条（预检与真响应共用） */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
}

export async function onRequest(context: Ctx): Promise<Response> {
  const path = new URL(context.request.url).pathname

  /*
   * 预检（OPTIONS）必须在 `next()` **之前**答：Cloudflare Pages 对没实现的 OPTIONS
   * 回 405，而浏览器把"预检不是 2xx"直接判成跨域失败 —— 壳里那些 POST 就是这么死的。
   * ⚠️ 只拦非 `/api/sb/*`；`/api/sb/*` 的 OPTIONS 照旧往下走（透传上游）。
   */
  if (context.request.method === 'OPTIONS' && !path.startsWith('/api/sb')) {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    })
  }

  const res = await context.next()

  // 见文件头 🔴：数据库中转原样放行
  if (path === '/api/sb' || path.startsWith('/api/sb/')) return res

  const headers = new Headers(res.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('X-Frame-Options', 'DENY')
  /* 接口响应一律不该被缓存（里面可能带某个人看得见的数据） */
  headers.set('Cache-Control', 'no-store')
  /* 这些响应是给 `fetch()` 读的，没有任何理由被当文档渲染或被框住 */
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  /* 🆕 壳（`app://-` / `https://localhost`）是跨域调用者 —— 见文件头那段理由 */
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)

  /* 204 / 304 不许带 body（构造时会抛 TypeError）—— 用 null 而不是 res.body */
  const body = res.status === 204 || res.status === 304 ? null : res.body
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}
