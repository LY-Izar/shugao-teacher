import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/* ============================================================
   Supabase 客户端
   ------------------------------------------------------------
   设计原则：**没有环境变量时整个应用仍然能跑**（退回浏览器本地存储）。
   这样线上版本不会被改坏，环境变量一填上就自动切过去。
   ============================================================ */

function normalizeUrl(raw: string): string {
  // 用户常把 /rest/v1/ 一起复制进来，这里统一去掉
  return raw.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, '')
}

const RAW_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/**
 * 实际使用的基础地址。
 *
 * ⚠️ 部署在 Cloudflare Pages 上时**一律改走自己的中转 `/api/sb`**，
 *    不管构建时配的是什么。两个理由：
 *
 *    ① 国内网络对 `*.supabase.co` **整域做 SNI 阻断** —— TCP 能连上，
 *       但 TLS ClientHello 一被识别出这个域名就被 RST，前端所有请求报
 *       `Failed to fetch`（很容易被误判成密码错或权限问题）。必须经自己的域名出去。
 *
 *    ② 🔴 Cloudflare Pages 的**构建环境变量会覆盖 `.env.production`，而且完全不报错**。
 *       症状极具迷惑性：仓库里改了 `.env.production`、部署也显示成功，
 *       但构建产物**一字未变**（连内容哈希都一样），看起来就像"部署卡住了"。
 *       用 `location.origin` 拼中转地址是同一个部署内的路径，永远不会指错，
 *       也就不再受"构建变量和 .env 文件谁赢"这件事影响。
 *
 * 本地开发（localhost / 局域网 IP）不受影响：照旧用配置值，没配就退回本地模式。
 */
function resolveUrl(configured: string): string {
  if (!configured) return ''
  const host = typeof location === 'undefined' ? '' : location.hostname
  if (/\.pages\.dev$/i.test(host)) return `${location.origin}/api/sb`
  return configured
}

const RESOLVED_URL = resolveUrl(RAW_URL)

/** 是否已接后端。false 时全部走本地 localStorage。 */
export const isRemote = Boolean(RESOLVED_URL && KEY)

export const SUPABASE_URL = RESOLVED_URL ? normalizeUrl(RESOLVED_URL) : ''

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient | null {
  if (!isRemote) return null
  client ??= createClient(SUPABASE_URL, KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // 教室一体机上会一直挂着，session 必须能续
      detectSessionInUrl: false,
    },
    realtime: { params: { eventsPerSecond: 4 } },
  })
  return client
}

/** 连接模式，用于界面上显示与排错 */
export function connectionMode(): 'remote' | 'local' {
  return isRemote ? 'remote' : 'local'
}
