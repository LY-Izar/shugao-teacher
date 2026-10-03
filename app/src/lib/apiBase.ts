/* ============================================================
   站内接口的基址（2026-10-04）
   ------------------------------------------------------------
   🔴 **为什么需要它**：exe / apk 两个壳的 origin 都不是线上域名
      （Electron 是 `app://-`，Capacitor 是 `https://localhost` —— 打包侧的
      `_tools/verify-exe.mjs:300` 早就写着这件事），它们加载的是**打进包里的网页产物**。
      于是 `fetch('/api/status')` 这类**相对路径**会被**壳自己的本地服务器**接走：
      它对不认识的路径回 **200 + index.html** ⇒
        · 维护状态：`JSON.parse` 抛 `Unexpected token '<'` ⇒ 按"未维护"放行（fail-open）
          ⇒ **壳里维护模式永远不生效**；
        · 面板接口：拿到一坨 HTML ⇒ 旧逻辑还把它当"服务端在、只是 secret 没配"（假红）。
      ⇒ 用户 2026-10-04 报的"维护模式读不到 / 那几个 key 读不到"就是这个。

   数据那条路**本来就是绝对地址**（`.env.production` 的
   `VITE_SUPABASE_URL=https://shugao-teacher.pages.dev/api/sb`，见那个文件里"为什么不直连
   supabase.co"那段），所以壳里能读到真实班级与作业 —— 出问题的**只有站点自己那些 `/api` 路由**。

   ✅ 做法：给它一个**绝对基址** `VITE_API_BASE`（构建时注入；`app/.env.production` 里写着）。
      ⚠️ **不设它时 `apiUrl()` 原样返回传入的路径** ⇒ 网页 / `vite dev` / 门禁里的行为**逐字不变**。
      ⚠️ 壳里跨域调 `/api/*` 还要服务端点头（预检 + `Access-Control-Allow-Origin`）——
         那半边在 `app/functions/api/_middleware.ts`，两边都做才算做完。

   🔴 **别在多处拼这个地址**：所有站内接口一律走 `apiUrl()`（`nav-checks` 的 D16 静态钉住
      "除 `lib/api.ts` 外不许再出现 `fetch('/api/`"）。
   ============================================================ */

/**
 * 构建时注入的绝对基址；空串 = 用页面自己的 origin（网页 / 开发环境）。
 * 末尾的斜杠在这里就去掉，免得拼出 `//api/…`。
 */
export const API_BASE = String(import.meta.env?.VITE_API_BASE ?? '').replace(/\/+$/, '')

/**
 * 把站内接口路径拼成绝对地址。例：`apiUrl('/api/status')`。
 *
 * @param path 站内路径（`/api/…`），带不带前导斜杠都行
 * @param base **只给门禁用的**第二支：不传就走 `API_BASE`（生产/网页的真实行为）。
 *             留着它是为了能在 Node 里把"有基址 / 没基址"两支都断言一遍，而不是靠改环境变量。
 */
export function apiUrl(path: string, base: string = API_BASE): string {
  const b = String(base).replace(/\/+$/, '')
  if (!b) return path
  return b + (path.startsWith('/') ? path : `/${path}`)
}
