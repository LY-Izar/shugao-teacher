import type { RealtimeChannel } from '@supabase/supabase-js'
import type { CallRecord, ClassroomClient } from '../data/types'
import { rowToCall, rowToClassroom } from '../data/remote'
import { getSupabase, isRemote } from './supabase'
import { createFanout, type Fanout } from './realtimeFanout'

/* ============================================================
   教师端 ←→ 教室端 的实时通道
   ------------------------------------------------------------
   · 本地模式：BroadcastChannel（同一个浏览器开两个标签页就能演示）
   · 后端模式：Supabase Realtime 订阅 calls / classrooms 两张表
   调用方（教师端发呼叫、教室端接收、心跳）完全不用区分模式。
   ============================================================ */

export type BusMessage =
  | { type: 'call'; call: CallRecord }
  | { type: 'heartbeat'; classroomId: string; at: number }
  | { type: 'classroom'; classroom: ClassroomClient }
  | { type: 'slide'; assignmentId: string; seq: number }
  /* 🆕 P1（插件化）：某班的插件启用清单变了（教师端开/关/改配置）→ 教室端重读。
     只带 classId 不带清单本身 —— 清单由收方自己重读（`loadPluginConfigs`），
     消息只当"门铃"用：两个真相源（教师端写、教室端读）各走各的权限。 */
  | { type: 'pluginConfigs'; classId: string }
  | { type: 'pluginRegistry' }
  | { type: 'pluginSource'; classId: string; table: string }
  | { type: 'pluginStorage'; classId: string; pluginId: string; key: string }
  | { type: 'pluginResult'; classId: string; pluginId: string; key: string }
  | { type: 'realtimeReady' }

const CHANNEL = 'shugao.classroom.v1'
const LOCAL_EVENT = 'shugao-bus'

/** 心跳间隔 / 判定离线阈值：后端模式写库更贵，所以放慢一些 */
export const HEARTBEAT_MS = isRemote ? 30_000 : 4_000
export const OFFLINE_AFTER_MS = isRemote ? 90_000 : 12_000

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (channel) return channel
  try {
    channel = new BroadcastChannel(CHANNEL)
    return channel
  } catch {
    return null
  }
}

/**
 * 广播一条消息。
 * 后端模式下 calls / classrooms 已经写进数据库、由 Realtime 推送，
 * 所以这里只把「同一页面内的监听者」叫醒，不再往外广播，避免重复。
 */
export function emit(m: BusMessage) {
  if (isRemote) {
    window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: m }))
    return
  }
  getChannel()?.postMessage(m)
  /*
   * 心跳**不往本页派发**：它是"我还活着"的自我介绍，只有别的标签页收到才有意义。
   * 在本页也派发的话，教室端会收到自己的心跳，反过来把自己的 lastSeenAt 一直刷新 ——
   * 那块屏开着一整天，每 4 秒白写一次本地存档（还会把教师端更新的快照覆盖回去）。
   */
  if (m.type !== 'heartbeat') window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: m }))
}

/*
 * 后端模式的那一条通道：**全页只有一条**，订阅者往这里登记 ——
 * 为什么不能"一个订阅者开一条"（会抛 cannot add postgres_changes callbacks …）
 * 写在 `realtimeFanout.ts` 顶上，那是 2026-10-24 教室端首页报错的根因。
 *
 * 三个 `.on` 在这里**一次挂完**；挂完之后任何地方都不许再往上追加。
 */
const remoteBus: Fanout<BusMessage> | null = isRemote
  ? createFanout<BusMessage, RealtimeChannel>({
      baseTopic: 'shugao-classroom',
      open: (topic) => {
        const sb = getSupabase()
        if (!sb) throw new Error('[realtime] 后端模式却拿不到 Supabase 客户端')
        return sb
          .channel(topic)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'calls' },
            /*
             * 这里必须是 `*` 而不是 `INSERT`。
             * 「再播一遍」不改行数，它是**追加一个 sent_at 时间戳**（UPDATE）——
             * 只订阅 INSERT 的话，教师点了重播、教室端什么都不会发生，
             * 而教师界面上写着"已重播一遍"。DELETE 没有可播的新行，跳过即可。
             */
            (p) => {
              if (p.eventType === 'DELETE') return
              remoteBus?.emit({ type: 'call', call: rowToCall(p.new as never) })
            },
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'classrooms' },
            (p) =>
              remoteBus?.emit({ type: 'classroom', classroom: rowToClassroom(p.new as never) }),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'plugin_configs' },
            /* 🆕 P1：教师端开/关/改配置 → 门铃。Realtime 吃 RLS：教室端只会收到
               自己班那些行（§46.2 的读策略在起作用），所以这里不用再筛权限 ——
               但**要不要响应这个班**仍由收方判（教师端也订着同一条）。 */
            (p) => {
              const row = (p.new ?? {}) as { class_id?: string }
              if (typeof row.class_id === 'string')
                remoteBus?.emit({ type: 'pluginConfigs', classId: row.class_id })
            },
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'plugin_registry' },
            () => remoteBus?.emit({ type: 'pluginRegistry' }),
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'plugin_sync_events' },
            (p) => {
              if (p.eventType === 'DELETE') return
              const row = p.new as { class_id?: string; kind?: string; name?: string; changed_key?: string }
              if (!row.class_id || !row.name) return
              if (row.kind === 'source') remoteBus?.emit({ type: 'pluginSource', classId: row.class_id, table: row.name })
              if (row.kind === 'storage' && row.changed_key)
                remoteBus?.emit({ type: 'pluginStorage', classId: row.class_id, pluginId: row.name, key: row.changed_key })
              if (row.kind === 'result' && row.changed_key)
                remoteBus?.emit({ type: 'pluginResult', classId: row.class_id, pluginId: row.name, key: row.changed_key })
            },
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') remoteBus?.emit({ type: 'realtimeReady' })
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              console.warn('[realtime] 频道异常:', status)
            }
          })
      },
      close: (ch) => {
        void getSupabase()?.removeChannel(ch)
      },
    })
  : null

export function subscribe(fn: (m: BusMessage) => void): () => void {
  if (isRemote) return remoteBus ? remoteBus.subscribe(fn) : () => {}

  const bc = getChannel()
  const onMsg = (e: MessageEvent) => fn(e.data as BusMessage)
  bc?.addEventListener('message', onMsg)

  const onLocal = (e: Event) => fn((e as CustomEvent<BusMessage>).detail)
  window.addEventListener(LOCAL_EVENT, onLocal)

  return () => {
    bc?.removeEventListener('message', onMsg)
    window.removeEventListener(LOCAL_EVENT, onLocal)
  }
}
