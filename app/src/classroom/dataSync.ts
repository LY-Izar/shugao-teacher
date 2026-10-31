import { useStore } from '../data/store'

/**
 * 教室主屏和插件窗口共享同一份快照刷新。事件只作失效信号，数据仍由
 * loadSnapshot 的 RLS 查询取得；刷新期间再来的事件会再读一次，避免漏掉末次修改。
 */
let running: Promise<void> | null = null
let dirty = false

export function refreshClassroomData(): Promise<void> {
  dirty = true
  if (!running) {
    running = (async () => {
      try {
        while (dirty) {
          dirty = false
          await useStore.getState().hydrate()
        }
      } finally {
        running = null
      }
    })()
  }
  return running
}
