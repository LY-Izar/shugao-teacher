/**
 * `/api/*` 的响应头（2026-10-01 安全加固 A4）。
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
 */

type Ctx = {
  request: Request
  next: () => Promise<Response>
}

export async function onRequest(context: Ctx): Promise<Response> {
  const res = await context.next()
  const path = new URL(context.request.url).pathname

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

  /* 204 / 304 不许带 body（构造时会抛 TypeError）—— 用 null 而不是 res.body */
  const body = res.status === 204 || res.status === 304 ? null : res.body
  return new Response(body, { status: res.status, statusText: res.statusText, headers })
}
