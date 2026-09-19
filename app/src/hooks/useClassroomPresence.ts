import { useEffect } from 'react'
import { useStore } from '../data/store'
import { OFFLINE_AFTER_MS, subscribe } from '../lib/realtime'

/**
 * 教师端维护「教室端是否在线」。
 * 教室端每 4 秒发一次心跳；超过 12 秒没收到就判定离线。
 * 这条状态决定了呼叫时会不会明确警告「学生可能听不到」。
 */
export function useClassroomPresence() {
  useEffect(() => {
    const off = subscribe((m) => {
      if (m.type !== 'heartbeat') return
      const c = useStore.getState().classrooms.find((x) => x.id === m.classroomId)
      if (c && !c.online) useStore.getState().setClassroomOnline(c.id, true)
    })

    const timer = window.setInterval(() => {
      const st = useStore.getState()
      const now = Date.now()
      for (const c of st.classrooms) {
        if (c.online && now - c.lastSeenAt > OFFLINE_AFTER_MS) {
          st.setClassroomOnline(c.id, false)
        }
      }
    }, 5000)

    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [])
}
