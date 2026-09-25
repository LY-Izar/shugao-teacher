/* ============================================================
   调自己的服务端接口（2026-09-29 管理台第二期）
   ------------------------------------------------------------
   为什么抽出来：这一期有五个接口（`/api/status` · `/api/mail` · `/api/feedback` ·
   `/api/admin/maintenance` · `/api/admin/errors`），而它们要做的是同一件事：
   **带上调用者的 JWT + 把回话解析成 JSON + 网络失败给人话**。
   三份 15 行的复制品就是"同一件事三个入口"的开始（本仓库踩过四次）。

   🔴 **它不做任何判据**：前端的活是"把 JWT 递上去"，判据永远在服务端问数据库
      （`is_super_admin()` / `can_contact_admin()`）。这里回 `403` 就是回 403，
      不翻译、不糊弄（人话由服务端给，`message` 原样带回）。
   ============================================================ */

import { getSupabase, isRemote } from './supabase'

export type ApiResult = {
  ok: boolean
  /** HTTP 状态码；`0` = 连都没连上（断网 / 本地模式没有服务端） */
  status: number
  data: Record<string, unknown>
}

/** 带上当前会话的 JWT（没有会话就不带 —— 那个由服务端决定放不放行） */
async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const sb = getSupabase()
    if (!sb) return headers
    const {
      data: { session },
    } = await sb.auth.getSession()
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  } catch {
    /* 取会话失败就当"没有会话"，让服务端回 401（比在这里猜要好） */
  }
  return headers
}

/**
 * POST 一个 JSON 接口。**它不抛错** —— 失败也回一个 `{ok:false}`（调用方不必写 try）。
 *
 * 🔴 **本地模式一个请求都不发**：没有服务端时 `/api/*` 会回 **404**，
 *    而页面控制台里那一条 `Failed to load resource: 404` 会被
 *    `shots.mjs` 的"运行时错误"那一关抓住（第一期的 `fetchServer` 就是这么做的：
 *    先看 `getSupabase()` 在不在，不在就**不发**）。
 *    症状如果写成"发出去再兜住 404"，屏上看着是对的，但控制台会一直脏。
 */
export async function postApi(path: string, body: Record<string, unknown>): Promise<ApiResult> {
  if (!isRemote) {
    return {
      ok: false,
      status: 0,
      data: {
        message:
          '本地模式：这一条要服务端（`/api/*`），本机演示环境里没有 —— 先把后端配上，或者去线上看。',
      },
    }
  }
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: { message: `连不上服务器（${e instanceof Error ? e.message : String(e)}）` },
    }
  }
}

/** 从回话里取人话（服务端每一条错误都写了人话；没写就给一个诚实的兜底） */
export function apiMessage(r: ApiResult, fallback: string): string {
  const m = r.data?.message
  return typeof m === 'string' && m ? m : r.status ? `${fallback}（HTTP ${r.status}）` : fallback
}
