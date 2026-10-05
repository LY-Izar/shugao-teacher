import { useEffect, useRef } from 'react'
import { useStore, useToast } from '../data/store'
import { getSupabase } from '../lib/supabase'
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
    let doneMark = false
    try {
      doneMark = localStorage.getItem(DONE_KEY) === '1'
    } catch {
      return
    }
    ran.current = true

    void (async () => {
      const steps: string[] = []

      /*
       * 🔴 2026-10-05 真机第五轮（用户把 1.1.3 **覆盖安装**到 1.1.2 上、没卸载没清数据的实测）：
       *
       * `shugao.perms.done` 只是**一个布尔**，而"账上记过"与"现在真的达成了"是两件事 ——
       *   覆盖安装会把上一个版本留下的 `=1` 原样带进新版（localStorage 跟着 WebView 数据走）
       *   ⇒ 新版**整条流水线一次都不跑**：通知授权那一步不再请求、推送钥匙不再登记，
       *     而屏上**什么都不说** ⇒ 用户看到的就是"通知权限还是没有正常弹出"（§三.5：不许静默）。
       *
       * ⇒ 跳过整条流水线的判据从"一个布尔"改成**两件事同时成立**：
       *   ① 账上记过（`doneMark`）**且** ② 现在真的量到"通知开着"（`st.notify === true`）。
       *   量不到（`null` = 不知道）或量到没开 ⇒ **照跑**。这不是"每次都重跑一遍"：
       *   下面每一步都是**先量再动** —— 已授权的精确闹钟不弹、已在白名单的电池不弹、
       *   register 是幂等的 ⇒ 只有**真正缺的那一步**会被补上，不会重复打扰。
       */
      let st = await shellPushStatus()
      if (doneMark && st?.notify === true) return

      /* ① 通知授权弹窗（Android 13+；12- 及以下系统默认给，弹都不弹） */
      const perm = await shellRequestNotifyPermission()
      if (perm === 'granted') steps.push('通知已允许')

      /* ② 精确闹钟（Android 12+）：量到没给就跳系统页；回来复核，还不给就跳过这一步 */
      st = await shellPushStatus()
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

      /* ④ 注册拉取钥匙 → 启动前台服务。失败不记账 done ⇒ 下次打开自动重试。
         🔴 register 由**原生**发（WebView 里这条跨域 POST 会 Failed to fetch——
            真机第四轮实测），这里只把会话的 access token 递给壳。 */
      const sb = getSupabase()
      const sess = sb ? (await sb.auth.getSession()).data.session : null
      const accessToken = sess?.access_token ?? ''
      const startedRes = accessToken
        ? await shellStartPush(apiUrl(''), accessToken)
        : { ok: false, why: '登录会话已过期，重新登录后再试。' }
      const started = startedRes.ok
      if (started) steps.push('消息保持畅通')

      if (started) {
        try {
          localStorage.setItem(DONE_KEY, '1')
        } catch {
          /* 忽略：记不上就下次再走一遍（每一步都先量，不会重复打扰） */
        }
        push({ text: '通知设置完成', tone: 'ok', desc: steps.join(' · ') })
      } else {
        /* 🔴 失败原因由原生侧带回（服务端 message/detail 原文），一亮就能定位 */
        push({
          text: '通知设置没走完',
          tone: 'warn',
          // 🔴 `why` 一定要带上真因（2026-10-05 真机实测）：
          //   原生把「路径多了一个斜杠」这件事如实回了（405），但桥接层那两支
          //   （插件不存在 / Promise reject）都只回 `{ok:false}` 把 why 吃掉
          //   ⇒ 屏上只剩「前台服务没起来」，用户和开发者都无从下手。
          //   这里再兜一层底：why 为空时说的是"原因没带回来"而不是编一个原因。
          /*
           * 🔴 2026-10-05 真机第五轮：**通知那一格的读数也要上屏**。
           *
           * 用户连着两轮报"通知权限始终没有正常弹出" —— 而这一步（① 请求授权）
           * 无论回 `granted` 还是 `denied`，**今天在屏上都没有任何痕迹** ✗：
           * 已授权时系统**本来就不会再弹**（Android 只弹一次），于是"没弹"与"早就给了"
           * 在界面上一模一样，谁也分不清。⇒ 这里把**当场量到的读数**写进横幅：
           * 通知开关关着 / 13+ 没授权 / 这个壳没有那个口 —— 三档分别说自己那一句，
           * 量不到（`st` 为 `null`）就一个字都不说（§三.4：没结论是灰，不许编）。
           */
          desc:
            (st?.notify === false
              ? '系统里这个应用的通知开关是关着的（去系统设置里打开）。 '
              : perm === 'denied'
                ? '系统还没允许这个应用发通知（若从没弹过授权窗，去系统设置里手动打开）。 '
                : perm === 'unsupported'
                  ? '这个壳没有通知授权那个口。 '
                  : '') +
            (startedRes.why?.trim() || '原因没带回来（看 logcat 里 ShugaoNative 那行）') +
            ' · 下次打开应用会自动再试。',
        })
      }
    })()
  }, [hydrated, teacher, isDemo, accountKind, push])
}
