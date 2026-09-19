import type { CallRecord } from '../data/types'

/* ============================================================
   教师端 ←→ 教室端 的实时通道

   当前是本地实现：BroadcastChannel + 同页 CustomEvent。
   同一个浏览器里开两个标签页即可完整演示（教师端 + 教室端）。
   接 Supabase 后把 emit/subscribe 换成 Realtime 频道即可，
   调用方一行都不用改。
   ============================================================ */

export type BusMessage =
  | { type: 'call'; call: CallRecord }
  | { type: 'heartbeat'; classroomId: string; at: number }
  | { type: 'slide'; assignmentId: string; seq: number }

const CHANNEL = 'shugao.classroom.v1'
const LOCAL_EVENT = 'shugao-bus'

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

/** 广播给其他标签页（BroadcastChannel 不会回给自己） */
export function emit(m: BusMessage) {
  getChannel()?.postMessage(m)
  // 同页面内的监听者也要收到
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: m }))
}

export function subscribe(fn: (m: BusMessage) => void): () => void {
  const ch = getChannel()
  const onMsg = (e: MessageEvent) => fn(e.data as BusMessage)
  ch?.addEventListener('message', onMsg)

  const onLocal = (e: Event) => fn((e as CustomEvent<BusMessage>).detail)
  window.addEventListener(LOCAL_EVENT, onLocal)

  return () => {
    ch?.removeEventListener('message', onMsg)
    window.removeEventListener(LOCAL_EVENT, onLocal)
  }
}

/** 心跳间隔与判定离线的阈值 */
export const HEARTBEAT_MS = 4000
export const OFFLINE_AFTER_MS = 12000
