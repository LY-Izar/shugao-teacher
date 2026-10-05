import { useEffect, useRef } from 'react'
import { useStore, useToast } from '../data/store'
import { apiMessage, postApi } from '../lib/api'
import { apiUrl } from '../lib/apiBase'
import {
  notifyChannel,
  openExactAlarmSettings,
  shellHasPushFlow,
  shellPushStatus,
  shellRequestIgnoreBattery,
  shellRequestNotifyPermission,
  shellStartPush,
} from '../lib/notify'

const DONE_KEY = 'shugao.perms.done'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 跳到系统页之后**等老师回来**：先等"离开"（跳转瞬间页面可能还报 visible），
 * 再等"回来"，最后留一拍让系统页真正收掉。
 */
async function waitBackFromSettings() {
  for (let i = 0; i < 20 && document.visibilityState === 'visible'; i++) await sleep(150)
  for (let i = 0; i < 100 && document.visibilityState !== 'visible'; i++) await sleep(200)
  await sleep(600)
}

/**
 * 首启权限流水线（2026-10-02，用户拍板："第一次下载应用就引导弄好，不用做页面，
 * 一个一个弹权限确认弹窗，部分权限直接跳转引导用户点击"）。
 *
 * 只在 **apk 的壳**里跑（`shellHasPushFlow()` 总闸）；每台设备只跑一次
 * （localStorage 记账）；四步顺序：
 *   ① 通知授权弹窗（Android 13+ 真弹；12- 及以下系统默认已有 ⇒ 直接过）
 *   ② 精确闹钟：没授权就**跳系统页**让老师点"允许"，回来复核
 *   ③ 电池优化白名单：系统弹窗，点"允许"（国产 ROM 杀后台的最常见最后一环）
 *   ④ 注册推送钥匙 → 启动前台服务（应用被划掉后 30 秒内也能收到新通知）
 *
 * 🔴 三条纪律：
 *   · 每一步**先量再动**：已经允许的步骤直接跳过，不重复打扰；
 *   · 失败**不挡路**：哪一步没成，后两步照走（一个开关坏了不该拖死整条流水线）；
 *   · 收尾**说人话**：成了什么、差什么，一条 Toast 交代；register 失败**不记账 done**
 *     ⇒ 下次打开应用自动重试（服务端没连上不该永久放弃）。
 */
export function useFirstRunPermissions() {
  const teacher = useStore((s) => s.teacher)
  const hydrated = useStore((s) => s.hydrated)
  const isDemo = useStore((s) => s.isDemo)
  const accountKind = useStore((s) => s.accountKind)
  const push = useToast((s) => s.push)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    if (!hydrated || !teacher || isDemo || accountKind === 'classroom') return
    /* 总闸：只有 apk 的壳有整条链。exe 与网页版：一个字都不新增（弹窗噪音）。 */
    if (notifyChannel() !== 'native' || !shellHasPushFlow()) return
    try {
      if (localStorage.getItem(DONE_KEY) === '1') return
    } catch {
      return
    }
    ran.current = true

    void (async () => {
      const steps: string[] = []

      /* ① 通知授权弹窗（Android 13+；12- 及以下系统默认给，弹都不弹） */
      const perm = await shellRequestNotifyPermission()
      if (perm === 'granted') steps.push('通知已允许')

      /* ② 精确闹钟（Android 12+）：量到没给就跳系统页；回来复核，还不给就跳过这一步 */
      let st = await shellPushStatus()
      if (st && st.exact === false) {
        push({
          text: '第 2 步 / 共 3 步：允许「闹钟和提醒」',
          tone: 'info',
          desc: '在接下来的系统页面上打开开关 —— 关掉应用也能收到上课提醒。',
        })
        await openExactAlarmSettings()
        await waitBackFromSettings()
        st = await shellPushStatus()
        if (st && st.exact !== false) steps.push('闹钟已允许')
      } else if (st && st.exact !== false) {
        steps.push('闹钟已允许')
      }

      /* ③ 电池优化白名单：系统弹窗（国产 ROM 杀后台的最常见最后一环） */
      const bat = await shellRequestIgnoreBattery()
      if (bat) {
        await sleep(1200)
        steps.push('后台运行已允许')
      }

      /* ④ 注册拉取钥匙 → 启动前台服务。失败不记账 done ⇒ 下次打开自动重试 */
      /* 🔴 路径是 `/api/push`（动作写在 body.action 里，与 pull/revoke 同一个函数）——
         调 `/api/push/register` 会落到静态层回 405（用户真机第三轮的 HTTP 405 就是它）。 */
      const reg = await postApi('/api/push', { action: 'register' })
      const token = reg.ok && typeof reg.data.token === 'string' ? reg.data.token : ''
      const started = token ? await shellStartPush(apiUrl(''), token) : false
      if (started) steps.push('消息保持畅通')

      /* 🔴 失败要说清楚断在哪（用户真机第二轮的教训：一句"没走完"让人对着黄条猜）。
         reg 失败时 `message`/`detail` 原样带上（"§41 没建"那一档会点名让老师跑 schema）。 */
      if (reg.ok && started) {
        try {
          localStorage.setItem(DONE_KEY, '1')
        } catch {
          /* 忽略：记不上就下次再走一遍（每一步都先量，不会重复打扰） */
        }
        push({ text: '通知设置完成', tone: 'ok', desc: steps.join(' · ') })
      } else {
        /* 🔴 失败必须把**服务端的 detail** 亮出来 —— "没能建立推送会话"这类笼统话
           不带原因 = 老师对着黄条猜（真机第三轮：真正的断点是造会话第 1 步的
           响应形状，detail 一亮就能定位）。 */
        const why = !reg.ok
          ? apiMessage(reg, '连不上服务器')
          : !token
            ? '服务端没回推送钥匙'
            : '前台服务没起来'
        const detail = typeof reg.data.detail === 'string' ? reg.data.detail : ''
        push({
          text: '通知设置没走完',
          tone: 'warn',
          desc: detail ? `${why} —— ${detail}` : `${why} 下次打开应用会自动再试。`,
        })
      }
    })()
  }, [hydrated, teacher, isDemo, accountKind, push])
}
