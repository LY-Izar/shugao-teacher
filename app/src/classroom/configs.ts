/**
 * 插件配置通道（P1）—— `plugin_configs`（§46）的读写，两档同形状。
 *
 * ============================================================================
 * 谁写谁读
 * ============================================================================
 * · **教师端**（班级详情页的"教室端插件"区）：读 + 写（RLS：读=看得见这个班，
 *   写=`can_manage_class()`，§46.2）。
 * · **教室端**（新壳）：只读 —— 启用清单由教师决定，屏只是执行者（§46 段首 ②）。
 * · 插件**碰不到**这张表：它拿到的只是 `ctx.config`（已合并默认值的生效值，loader 接线）。
 *
 * 两档：
 * · 线上 = Supabase 表 + RLS，变化靠 Realtime（`realtime.ts` 的 `pluginConfigs` 消息）
 *   + 教室端 30s 轮询兜底（websocket 会悄悄断，老教室端对呼叫就是这么办的）；
 * · 演示（无 Supabase）= localStorage 一份 JSON + BroadcastChannel 通知，
 *   **接口形状与线上一致**（缺表/读不到 = `unknown`，不是"什么都没配"）。
 */

import { getSupabase, isRemote } from '../lib/supabase'
import { emit } from '../lib/realtime'

export interface PluginConfigRow {
  pluginId: string
  enabled: boolean
  config: Record<string, unknown>
}

export type ConfigsState = 'ok' | 'unknown'

/** 演示模式的落盘键（一个键装所有班 —— 量小，不值得按班拆键）。 */
const LS_KEY = 'shugao.plugin.configs'

type LsShape = Record<string, Record<string, { enabled: boolean; config: Record<string, unknown> }>>

function lsRead(): LsShape {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as LsShape
  } catch {
    return {}
  }
}

function lsWrite(all: LsShape): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all))
  } catch {
    /* 存不下就算了 —— 演示模式的配置不是真数据 */
  }
}

export interface ConfigsResult {
  state: ConfigsState
  rows: PluginConfigRow[]
  /** `unknown` 时给人看的一句话（§三.4：没结论要说没结论，不说"没配置"） */
  notice?: string
}

export async function loadPluginConfigs(classId: string): Promise<ConfigsResult> {
  if (!isRemote) {
    const mine = lsRead()[classId] ?? {}
    return {
      state: 'ok',
      rows: Object.entries(mine).map(([pluginId, v]) => ({
        pluginId,
        enabled: v.enabled === true,
        config: v.config ?? {},
      })),
    }
  }
  const sb = getSupabase()
  if (!sb) return { state: 'unknown', rows: [], notice: '没有可用的数据库连接。' }
  try {
    const { data, error } = await sb
      .from('plugin_configs')
      .select('plugin_id, enabled, config')
      .eq('class_id', classId)
    if (error) {
      const code = String((error as { code?: string }).code ?? '')
      const msg = String(error.message ?? '')
      // 42P01 = 表不存在（线上库还没跑 §46）· PGRST205 = 列对不上 —— 都是"读不到"，不是"没配置"
      if (code === '42P01' || code === 'PGRST205' || /does not exist/i.test(msg)) {
        return { state: 'unknown', rows: [], notice: '数据库还没跑 supabase/schema.sql 第 46 段（插件配置），这一块先看不了。' }
      }
      return { state: 'unknown', rows: [], notice: msg || '启用清单没读出来。' }
    }
    const list = Array.isArray(data) ? data : []
    return {
      state: 'ok',
      rows: list
        .filter((r) => !!r && typeof r === 'object')
        .map((r) => {
          const o = r as Record<string, unknown>
          return {
            pluginId: String(o.plugin_id ?? ''),
            enabled: o.enabled === true,
            config: (o.config ?? {}) as Record<string, unknown>,
          }
        })
        .filter((r) => r.pluginId),
    }
  } catch (e) {
    return { state: 'unknown', rows: [], notice: e instanceof Error ? e.message : '启用清单没读出来。' }
  }
}

export interface SaveResult {
  ok: boolean
  message: string
}

/** 教师端写一个插件的启用/配置（部分字段 patch，另一字段照旧）。 */
export async function savePluginConfig(
  classId: string,
  pluginId: string,
  patch: { enabled?: boolean; config?: Record<string, unknown> },
): Promise<SaveResult> {
  if (!isRemote) {
    const all = lsRead()
    const mine = all[classId] ?? {}
    const cur = mine[pluginId] ?? { enabled: false, config: {} }
    mine[pluginId] = {
      enabled: patch.enabled ?? cur.enabled,
      config: patch.config ?? cur.config,
    }
    all[classId] = mine
    lsWrite(all)
    // 演示模式：教室端那块屏在另一个标签页里，BroadcastChannel 把它叫醒
    emit({ type: 'pluginConfigs', classId })
    return { ok: true, message: '' }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有可用的数据库连接，没有存进去。' }
  // 先读回现值再整行 upsert：patch 是部分字段，RLS 的 insert+update 两条策略都要过
  let cur: { enabled: boolean; config: Record<string, unknown> } = { enabled: false, config: {} }
  try {
    const { data } = await sb
      .from('plugin_configs')
      .select('enabled, config')
      .eq('class_id', classId)
      .eq('plugin_id', pluginId)
      .maybeSingle()
    if (data && typeof data === 'object') {
      cur = {
        enabled: (data as { enabled?: boolean }).enabled === true,
        config: ((data as { config?: unknown }).config ?? {}) as Record<string, unknown>,
      }
    }
  } catch {
    /* 读不回现值就按默认 upsert —— 写那一步会自己报真实原因 */
  }
  try {
    const { error } = await sb.from('plugin_configs').upsert(
      {
        class_id: classId,
        plugin_id: pluginId,
        enabled: patch.enabled ?? cur.enabled,
        config: patch.config ?? cur.config,
      },
      { onConflict: 'class_id,plugin_id' },
    )
    if (error) {
      const msg = String(error.message ?? '')
      if (/row-level security/i.test(msg)) {
        return { ok: false, message: '这个班不归你管，改动被服务器挡下了。' }
      }
      if (/does not exist/i.test(msg) || String((error as { code?: string }).code ?? '') === '42P01') {
        return { ok: false, message: '数据库还没跑 supabase/schema.sql 第 46 段（插件配置），存不进去。' }
      }
      return { ok: false, message: msg || '没有存进去。' }
    }
    return { ok: true, message: '' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '没有存进去。' }
  }
}

/** manifest `config.fields` 的默认值 → 一份"没被教师改过"的生效值（loader 的 configGet 用它打底）。 */
export function configDefaults(
  manifest?: { config?: { fields?: Array<{ key: string; default?: unknown }> } | null } | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of manifest?.config?.fields ?? []) {
    if (f.default !== undefined) out[f.key] = f.default
  }
  return out
}
