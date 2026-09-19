import type { CallRecord, ClassroomClient } from '../data/types'
import { rowToCall, rowToClassroom } from '../data/remote'
import { getSupabase, isRemote } from './supabase'

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
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: m }))
}

export function subscribe(fn: (m: BusMessage) => void): () => void {
  if (isRemote) {
    const sb = getSupabase()
    if (!sb) return () => {}
    const ch = sb
      .channel('shugao-classroom')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls' },
        (p) => fn({ type: 'call', call: rowToCall(p.new as never) }),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'classrooms' },
        (p) => fn({ type: 'classroom', classroom: rowToClassroom(p.new as never) }),
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[realtime] 频道异常:', status)
        }
      })
    return () => {
      void sb.removeChannel(ch)
    }
  }

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
