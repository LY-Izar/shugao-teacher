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

/** 是否已接后端。false 时全部走本地 localStorage。 */
export const isRemote = Boolean(RAW_URL && KEY)

export const SUPABASE_URL = RAW_URL ? normalizeUrl(RAW_URL) : ''

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
