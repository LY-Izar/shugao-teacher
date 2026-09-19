import { useEffect } from 'react'
import { useStore } from '../data/store'
import { getSupabase, isRemote } from '../lib/supabase'

/**
 * 启动引导：后端模式下先看看有没有已登录的会话，有就把数据拉下来。
 *
 * 教室端一体机会长期挂着，所以这里也负责在会话失效时把本地状态清干净，
 * 避免上一个账号的数据留在屏幕上。
 */
export function useAuthBootstrap() {
  const hydrate = useStore((s) => s.hydrate)

  useEffect(() => {
    if (!isRemote) return
    const sb = getSupabase()
    if (!sb) return

    let alive = true

    void (async () => {
      try {
        const {
          data: { session },
        } = await sb.auth.getSession()
        if (!alive) return
        if (session) await hydrate()
        else useStore.setState({ hydrated: true })
      } catch {
        if (alive) useStore.setState({ hydrated: true })
      }
    })()

    const { data: sub } = sb.auth.onAuthStateChange((event) => {
      // 只在「登出」时兜底清理；登录由 Login 页自己 hydrate，避免重复拉取
      if (event === 'SIGNED_OUT') useStore.getState().signOut()
    })

    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [hydrate])
}

/** 后端模式下的退出登录 */
export async function signOutEverywhere() {
  if (isRemote) {
    const sb = getSupabase()
    await sb?.auth.signOut()
  }
  useStore.getState().signOut()
}
