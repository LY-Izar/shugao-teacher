/**
 * Supabase 中转（Cloudflare Pages Function）。
 *
 * 为什么需要它：
 * 实测本机网络对 `*.supabase.co` **整域做 SNI 阻断** —— TCP 能连上
 * （116ms，够得着 Cloudflare 边缘），但 TLS ClientHello 一被识别出这个域名
 * 就被 RST。于是前端所有请求（登录、读写、文件）全部 `Failed to fetch`。
 * ⚠️ 这个错误**不是**密码错、也不是权限问题，是根本没连上数据库 ——
 *    排查时很容易被它带偏（我们就先怀疑过教室端账号和密码）。
 *
 * 做法：前端把 `VITE_SUPABASE_URL` 指向 `https://<自己的域名>/api/sb`，
 * 请求先到 Cloudflare（自己的域名没被拦），由这里原样转发给 Supabase。
 * 好处是**对任何网络、任何设备都生效** —— 不用给手机、教室机器逐台配代理。
 *
 * 三个必须做对的地方（都是踩过的坑）：
 *  ① 原样返回上游响应，**绝不要读它的 body** —— 一读就会解压，而
 *     `content-encoding` / `content-length` 还是上游那一份，浏览器解析会失败。
 *  ② 要保留 `Upgrade` 头，否则 Realtime 的 WebSocket 握不上手。
 *     握不上也不致命：App 里有轮询兜底，呼叫会晚几秒到，不是收不到。
 *  ③ 上游地址写死成常量 —— 这样它**不是开放代理**，别人拿不去当跳板。
 *
 * 部署：`<项目根>/functions/api/sb/[[path]].ts`，推 GitHub 后 Cloudflare 自动带上，
 * 和已有的 `api/ocr.ts`、`api/classroom-account.ts` 一样，不需要额外工具。
 */

const UPSTREAM = 'https://gwdyiwopiymzqjnmkiou.supabase.co'

/** 前缀要去掉：`/api/sb/rest/v1/classes` → 上游 `/rest/v1/classes` */
const PREFIX = '/api/sb'

type Ctx = {
  request: Request
  params?: { path?: string | string[] }
}

export async function onRequest(context: Ctx): Promise<Response> {
  const { request } = context
  const url = new URL(request.url)

  // 去掉前缀拼到上游。search 原样保留 —— supabase-js 全靠它传参（select/eq/order…）
  const rest = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
  const target = `${UPSTREAM}${rest}${url.search}`

  /*
   * `new Request(target, request)` 会把 method / headers / body 一起带过去，
   * 包括 `Upgrade: websocket`。host 由目标 URL 决定，不用手动删。
   */
  let upstream: Response
  try {
    upstream = await fetch(new Request(target, request))
  } catch (e) {
    /*
     * 上游连不上时，要返回**Supabase 那份错误结构**（error / error_description），
     * 否则 supabase-js 解析不出来，界面上只会显示一句莫名其妙的报错。
     */
    return new Response(
      JSON.stringify({
        error: 'proxy_unreachable',
        error_description: `中转连不上数据库：${e instanceof Error ? e.message : String(e)}`,
        message: `中转连不上数据库：${e instanceof Error ? e.message : String(e)}`,
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  // 原样透传（含 WebSocket 的 101）。见文件头 ① ②。
  return upstream
}
