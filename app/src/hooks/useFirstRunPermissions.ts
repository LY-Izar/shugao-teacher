import { useEffect, useRef } from 'react'
import { useStore, useToast } from '../data/store'
import { getSupabase } from '../lib/supabase'
import { apiUrl } from '../lib/apiBase'
import {
  notifyChannel,
  openExactAlarmSettings,
  shellEnsurePushRunning,
  shellHasPushFlow,
  shellPushStatus,
  shellRequestIgnoreBattery,
  shellRequestAutoStart,
  shellRequestNotifyPermission,
  shellStartPush,
} from '../lib/notify'

const DONE_KEY = 'shugao.perms.done'

/**
 * 🔴 「原生没把失败原因带回来」时**唯一的那句兜底话**（2026-10-06 抽成常量）。
 *
 * 为什么非抽不可：这句话在文件里出现**两处**（首启引导第 ④ 步那条横幅 + 新增的
 *   "通知通道没起来"那条），而门禁 A24 ② 的反向对照要求它在**真代码里恰好 1 处**
 *   —— `String.replace` 只换第一处，两处时那条对照会改到别的地方去 = **假绿**
 *   （`AGENTS.md` §三.2）。⇒ 一个真值源：常量在这里，两处都引它。
 */
const NO_WHY_HINT = '原因没带回来（看 logcat 里 ShugaoNative 那行）'

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

  /**
   * 🔴 「通知通道没起来」这句**一次会话只说一次**（2026-10-06 补）。
   *
   * 为什么不是 `useState`：它不是要画出来的东西，只防刷屏 —— 放成 state 就得进
   * effect 依赖 ⇒ 每次说完话 effect 重跑 ⇒ 又拉起一次（`useScheduleReminder`
   * 的 `warnedNoNative` 同一个理由）。
   */
  const warned = useRef(false)
  /**
   * 🔴 **已经成功拉起过一次**（同一次会话）——之后失败就不再提醒。
   *
   * 为什么：这一段挂在"每次回到前台"上，而**服务被划掉/被 ROM 清掉**是常态
   *   （清掉之后又会被 `onTaskRemoved` / 兜底任务拉回来）。老师来回切几次应用
   *   就弹几次"没起来" = 刷屏，而它并不代表"真的坏了"。
   * ⚠️ 成功过之后仍会**照常重试**（只是不吭声）—— 失败照样进 console.warn。
   */
  const ensuredOk = useRef(false)

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

      /*
       * ③-补 🔴 **厂商「自启动 / 后台运行」页**（2026-10-06 补，用户要求"覆盖各机型"）。
       *
       * 为什么与上一步是**两件事**：国产 ROM（MIUI / EMUI / ColorOS / OriginOS…）上
       *   "允许后台运行"与"允许自启动"**分开管** —— 上一步过了、这一步没开，
       *   老师把应用划掉之后**服务照样起不来**，而屏上什么都看不出来（就是本轮真机那个现象）。
       * 原生侧**逐档回退**（各家自启动页 → 组件直指 → 最后退应用详情页），
       *   每一档各自 `try/catch` ⇒ 某一档在这台机器上不存在，不影响别的档。
       *
       * ⚠️ **它不许挡住第 ④ 步**：跳不过去（`ok:false`）也**照走**，只把读数带进收尾那条横幅 ——
       *   一个"捷径"没通不该把整条推送链拖死（与上面两步同一条纪律）。
       * ⚠️ 只有**跳成了**才等老师回来（`waitBackFromSettings`）；没跳成时等下去
       *   只会白等 4 秒（`ok:false` 意味着我们根本没离开这一页）。
       */
      const auto = await shellRequestAutoStart()
      if (auto.ok) {
        // 跳过去就得等他回来，否则下面 ④ 那一步的 register 会在"老师在系统页面上"时发出去
        await waitBackFromSettings()
        steps.push(auto.via ? `自启动已打开（${auto.via}）` : '自启动已打开')
      } else if (!auto.unsupported) {
        // 如实记一笔：跳不动时说出来（不静默），但**不影响**后面的步骤
        console.warn('[push] 自启动页没跳成：', auto.why ?? '（没带原因）', auto.tried ?? [])
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
            (startedRes.why?.trim() || NO_WHY_HINT) +
            ' · 下次打开应用会自动再试。',
        })
      }
    })()
  }, [hydrated, teacher, isDemo, accountKind, push])

  /*
   * ============================================================
   * 🔴🔴 **每次打开应用 / 回到前台：确保那条常驻通知在**（2026-10-06 补）
   * ============================================================
   * 断在哪（用户真机 vc53）：原话「**通知我在不开应用后台的情况下是收不到**同一账号
   *   在电脑上发送的通知的」，随后当场确认：**通知栏里根本没有那条常驻通知** ⇒
   *   前台服务**从头到尾没起过**（Android 硬要求：前台服务必有常驻通知）。
   *   而上面那条流水线**只有两个启动点**，两个都靠不住：
   *     ① 首启引导第 ④ 步 —— 整条被 `localStorage` 里一个布尔跳过（覆盖安装会带过来），
   *        而且它**先要 register 那张网成功才起服务**（一次网络失败 ⇒ 服务不起）；
   *     ② `YlxbBootReceiver` —— 只有**手机重启**才跑。
   *   ⇒ "装完一直没重启、引导又早走完"这一档里，服务**一次都没起过**，而屏上静默。
   *
   * 这一段补的就是那个缺口：**应用在前台时把它拉起来**（此刻不受 Android 12+
   *   "不许从后台起前台服务"的限制）。与第 ④ 步**分工明确、不是第二份真值源**：
   *   · 第 ④ 步 = 登记钥匙 + 起服务（要网络）；
   *   · 这一段 = **不登记**，只看钥匙在不在，在就起。
   *
   * ⚠️ **失败只报一次**（`warned`）：这一段在"每次回到前台"都会跑 ——
   *   每次都弹一句"拉起失败"会变成刷屏。第一次说清楚，之后只留 console.warn
   *   （判据/维护者仍看得到，§三.5：不许静默）。而**一旦成功过就不再提醒**：
   *   那时候"通知栏里那条常驻通知在不在"才是老师该看的判据。
   * ⚠️ 只有 apk 的壳有这一支（`ensurePushRunning` 不在 ⇒ 一个字都不做，
   *   exe / 网页版行为完全不变）。
   */
  useEffect(() => {
    if (!hydrated || !teacher || isDemo || accountKind === 'classroom') return
    if (notifyChannel() !== 'native' || !shellHasPushFlow()) return
    let alive = true
    const ensure = async () => {
      const r = await shellEnsurePushRunning(apiUrl(''))
      if (!alive) return
      if (r.ok) {
        ensuredOk.current = true
        return
      }
      console.warn('[push] 通知通道这一趟没起来：', r.why ?? '（没带原因）')
      if (ensuredOk.current || warned.current) return
      warned.current = true
      push({
        text: '通知通道没起来',
        tone: 'warn',
        // ⚠️ 那句"没带原因"的兜底文案**只在上面那条流水线里写一份**（同一个真值源）：
        //    门禁 A24 ② 的反向对照要求它在**真代码里恰好 1 处**（两处时那条对照会改到
        //    别的地方、自己变假绿）。所以这里引 `NO_WHY_HINT`，不重写一遍那句话。
        desc: `${r.why?.trim() || NO_WHY_HINT} · 通知栏里那条「树高教务通」就是它在跑的标志。`,
      })
    }
    void ensure()
    /*
     * 回到前台再确认一次 —— 与第 ④ 步同一个理由：老师可能刚在系统设置里
     * 把通知打开 / 关掉电池优化，切回来这一下正是"补一次"的时机。
     * ⚠️ 两个监听都要（`visibilitychange` 管切走再切回；部分安卓 WebView 只发 `focus`）。
     */
    const reensure = () => {
      if (document.visibilityState === 'visible') void ensure()
    }
    document.addEventListener('visibilitychange', reensure)
    window.addEventListener('focus', reensure)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', reensure)
      window.removeEventListener('focus', reensure)
    }
  }, [hydrated, teacher, isDemo, accountKind, push])
}
