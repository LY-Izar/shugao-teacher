/* ============================================================
   维护模式的**全局闸门**（2026-09-29 管理台第二期）
   ------------------------------------------------------------
   🔴 它要做的那一件事（用户原话）：
      「**反正开维护后会将所有在线用户强制返回到一个正在维护中的页面**」

   落法：闸门挂在 `<Routes>` 外面（`App.tsx`），每次轮询/交互后重新算 ——
   一旦维护开着，**当前页整块被替换成维护画面**（下一次轮询 30 秒内必到，
   维护中时 10 秒一次；切回标签页/网络恢复时立刻再读一次）。

   🔴 **两个豁免，缺一个都会出事故**：
      · `/admin`     —— **超管必须还能进**（否则开了就关不掉，这是本功能最坏的失败模式）。
        判据只看**路径**：`/admin` 自己的判据在服务端（`is_super_admin()`），
        所以"能打开这个页面"≠"能关掉维护"（非超管打开只会看到登录卡/403）。
      · `/classroom` —— 教室端**自己**渲染维护画面。理由是那两件只有它做得到的事：
        ① **心跳照发**（闸门会把组件卸载掉 → 心跳停 → 面板开始显示"教室端离线"，
           而它其实好好地在显示维护画面：那是往"假在线"那条已知缺陷上再叠一层假信号）；
        ② **立刻清掉本页学生数据**（见 `Classroom.tsx` 里那个 effect）。
      ⚠️ 维护状态**不看设备标记**（`deviceRole()`）：超管的笔记本被标成教室端是
         真实可能的状态（第一期 T6 就是为它拍的板）—— 那台机器必须照样进得来。
   ============================================================ */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from './ui'
import { Emblem } from './Emblem'
import { IconAlert, IconCheck, IconClock, IconRefresh } from './icons'
import { useMaintenanceStatus } from '../lib/useMaintenance'
import { ReleaseGate } from './ReleaseGate'
import { beijingNow } from '../lib/holiday'
import { useStore } from '../data/store'
import { getSupabase } from '../lib/supabase'
import { unlockMaintenance, type MaintenanceStatus } from '../lib/maintenance'

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴🔴 **超管从维护画面进来的那条路**（2026-10-03，用户要求补的）
   ------------------------------------------------------------------------
   为什么必须有这条（这是本功能**最坏的失败模式**，而之前只挡住了一半）：

     维护闸门把**整页**换成维护画面 —— **包括 `/login` 本身**。
     ⇒ 一台**没登录过**的设备上，超管**连登录页都点不开**，
       于是「开维护的人把自己关在外面」**真的会发生**。
     （文件头那两条豁免 `/admin`、`/classroom`，是给**已经登录着**的
       超管留的路；对**没登录**的那台设备一点用没有。）

     这一条是那台设备的路：**在维护画面上按一段固定节奏点页面
     → 出来一个密码框 → 输管理员账号密码 → 直接进 `/admin`。**

   ── 三条判据，缺一个这条就成了漏洞 ──────────────────────────────────
   ① **手势只是"把入口显示出来"**，它本身**不是权限**。
      屏上任何人都能按出那个框 —— 这是**故意的**：
      入口藏起来不等于安全，真正的判据在 ② 和 ③。
   ② **密码由服务端校验**：`unlockMaintenance()` → `/api/admin/maintenance`
      `{action:'unlock'}` → Supabase 验密码（**anon key**）。
      🔴 密码**一个字都不经过我们的前端**。
   ③ **服务端还会再问一次 `is_super_admin()`** ——
      所以「知道某个教师的密码」**也进不去**，必须本来就是最高管理员。
      （服务端那一段在 `functions/api/admin/maintenance.ts`，带失败限流。）

   ⚠️ 为什么**不给**"输密码就放行"的纯前端版本：那等于把密码校验放在
      能被改的客户端里，改一行 JS 就过了。
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * 节奏：`X X XXX XX XXXX` = 四段，段内连点、段间停顿。
 * ⚠️ 为什么这样定（三个都要满足）：
 *   · 段内**连点**要快（<380ms 算同段）—— 手速正常的人点得出来；
 *   · 段间**停顿**要明显（>900ms 才算换段）—— 走路、拿手机、思考都会超时中断；
 *   · 总长 **11 下** —— 短了容易误触（学生会乱点），长了老师记不住。
 * ⚠️ 节奏本身**不写在界面上**（这是设计决定）：
 *   写了就等于贴在公告下面人人可见。写在这里 + 维护须知里。
 */
const UNLOCK_PATTERN = [1, 1, 3, 2, 4] as const
/** 同段内两下的最大间隔（毫秒） */
const UNLOCK_IN_GROUP_MS = 380
/** 两段之间至少停这么久（毫秒） */
const UNLOCK_BETWEEN_MS = 900

export function MaintenanceUnlock() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState(0)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  /** 记下每次点击的时刻（只留最近 30 个，够算四段） */
  const taps = useRef<number[]>([])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /**
   * 一「组」是一串**连点**。按 UNLOCK_PATTERN 逐段对：
   * 返回已经对上的段数（对不上就**清零重来**，而不是从中间续）。
   */
  const onTap = () => {
    if (open) return // 框已经开着，别再往里记节奏
    const now = Date.now()
    taps.current = [...taps.current, now].slice(-30)

    // 从后往前切成一组一组的"连点"，再逐段对
    const groups: number[][] = []
    for (const t of taps.current) {
      const last = groups[groups.length - 1]
      if (last && t - last[last.length - 1] <= UNLOCK_IN_GROUP_MS) last.push(t)
      else groups.push([t])
    }
    /*
     * 🔴🔴🔴 **"某组超过上限就清空" 必须排在 `groups.length < 5` 那个提前 return 之前**
     *   （2026-10-03 加日志才抓到 —— 我连着猜错了三次都是因为这一点）：
     *     「狂点 11 下」时**只有 1 组**，所以代码在 `groups.length < 5` 就 return 了，
     *     **根本走不到下面那段清理** ⇒ 那组 11 下一直留在缓冲区里
     *     ⇒ 之后每一段都偏移一格、永远开不出框。
     *   实测日志（清之前）：`清①某组超上限 [11,1,1,3,1]` —— 那 11 下好好地待着。
     *
     *   超过最大下数的那一刻，它**已经确定不是**这条节奏的一部分了 ⇒ 可以立刻清。
     */
    const maxSlot = Math.max(...UNLOCK_PATTERN)
    if (groups.some((g) => g.length > maxSlot)) {
      taps.current = []
      setProgress(0)
      return
    }

    if (groups.length < UNLOCK_PATTERN.length) {
      setProgress(Math.min(groups.length, UNLOCK_PATTERN.length - 1))
      return
    }

    const tail = groups.slice(-UNLOCK_PATTERN.length)
    /*
     * 🔴🔴 **把缓冲区裁成"最后 5 段"**（2026-10-03 探针抓到的最后一个真 bug）：
     *   「狂点 11 下」清掉之后，**前面还会剩 1~4 下的残余组**。
     *   它一直占着 `tail` 的**第一格**，于是后面每按一段节奏，
     *   `tail[0]` 的长度都对不上 ⇒ progress 每段**偏移一格**，永远凑不齐。
     *   （实测：狂点后 progress=1，之后是 1→2→3→4→1，卡在最后一格。）
     *
     * ✅ 正确做法：**只保留最后 5 段**，更早的组自动被挤掉。
     *   这样"陈旧残余"就不可能再占位，而**合法的节奏**恰好就是 5 段，
     *   不会被误挤（这是"按 5 段长度裁"而不是"按时间裁"的理由 ——
     *   按时间裁会在慢一点的人手上把合法节奏裁掉）。
     */
    if (tail.length === UNLOCK_PATTERN.length) {
      taps.current = tail.flat()
    }
    /*
     * 🔴🔴 **最后一段还没攒够时要"等"，不能判失败**（2026-10-03 探针抓到的真 bug）：
     *   那 4 下是**逐个到的**。第 5 段第一下刚进来时分组长度是 1，
     *   而 `UNLOCK_PATTERN[4] === 4` ⇒ 这时就按"对不上"清空的话，
     *   **它永远攒不满第 5 段**（实测 progress 走到 4 又掉回 1）。
     *
     * ✅ 只在**两种"确定错了"**时清空：
     *   ① 段间间隔不够（真的连成一片）
     *   ② **最后一段已经超过**它该有的下数（点多了）
     * 其余一律**留着继续等**。
     */
    for (let i = 1; i < tail.length; i++) {
      if (tail[i][0] - tail[i - 1][tail[i - 1].length - 1] < UNLOCK_BETWEEN_MS) {
        console.log('[unlock] 清②段间太密', tail[i][0] - tail[i - 1][tail[i - 1].length - 1])
        taps.current = []
        setProgress(0)
        return
      }
    }
    const lastLen = tail[tail.length - 1].length
    const wantLast = UNLOCK_PATTERN[UNLOCK_PATTERN.length - 1]
    if (lastLen > wantLast) {
      console.log('[unlock] 清③末段超长', lastLen, '>', wantLast)
      taps.current = []
      setProgress(0)
      return
    }
    const hit = tail.every((g, i) => g.length === UNLOCK_PATTERN[i])
    if (!hit) {
      setProgress(UNLOCK_PATTERN.length - 1) // 段数够、最后一段还在攒 ⇒ 等
      return
    }
    setProgress(UNLOCK_PATTERN.length)
    setOpen(true)
    taps.current = []
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    const r = await unlockMaintenance(email, password)
    if (!r.ok) {
      setErr(r.message)
      setBusy(false)
      return
    }
    // 收下**该管理员自己的**会话，然后一切照常走 /admin 那条既有路径
    const sb = getSupabase()
    if (!sb) {
      setErr('没有连上账号服务。')
      setBusy(false)
      return
    }
    const { error } = await sb.auth.setSession({
      access_token: r.accessToken,
      refresh_token: r.refreshToken,
    })
    if (error) {
      // 🔴 不许静默：拿不到会话就意味着进不去 /admin，
      //    而"看起来像成功了"比失败更糟。
      setErr(`会话没建立起来：${error.message}`)
      setBusy(false)
      return
    }
    navigate('/admin', { replace: true })
    setBusy(false)
  }

  return (
    <>
      {/* 手势的落点：整块维护画面都能点（用户说的是"按节奏点页面"） */}
      {open ? (
        <form
          onSubmit={submit}
          data-maintenance-unlock="open"
          className="fixed inset-x-3 bottom-3 z-50 mx-auto w-auto max-w-sm rounded-lg border border-line bg-[var(--color-surface)] p-3 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', marginBottom: 8 }}>
            输入最高管理员的账号与密码，进去把维护关掉。
          </div>
          <input
            className="input"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="管理员账号"
            autoComplete="username"
            style={{ marginBottom: 6 }}
          />
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete="current-password"
            style={{ marginBottom: 8 }}
          />
          {err ? (
            <div style={{ fontSize: 11.5, color: 'var(--color-badink)', marginBottom: 8 }} data-maintenance-unlock-error>
              {err}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !email.trim() || !password}
              onClick={() => void submit({ preventDefault: () => {} } as React.FormEvent)}
            >
              {busy ? '正在核对…' : '进入管理台'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setPassword('')
                setErr('')
              }}
              style={{ fontSize: 12, color: 'var(--color-ink3)' }}
            >
              取消
            </button>
          </div>
        </form>
      ) : null}
      <span
        /* 屏上**什么都不显示**（手势不写在界面上，见上面那段说明）。
           这个元素只是为了给门禁一个能断言的落点。 */
        data-maintenance-unlock-tapzone=""
        data-progress={progress}
        onClick={onTap}
        style={{ position: 'fixed', inset: 0, zIndex: 39, cursor: 'default' }}
      />
    </>
  )
}

/** 豁免维护判定的路径（见文件头；**加一条之前先想清楚"开了关不掉"这个后果**）
 *  ⚠️ **刻意不 export**：`nav-checks.mjs` 按**源码文本**核对这两条路径
 *     （`react(only-export-components)` 那条 lint 规则也不允许组件文件里导出常量表）。 */
const MAINTENANCE_EXEMPT_PATHS = ['/admin', '/classroom'] as const

export function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const loc = useLocation()
  const status = useMaintenanceStatus()
  const exempt = (MAINTENANCE_EXEMPT_PATHS as readonly string[]).includes(loc.pathname)
  if (status.enabled && !exempt) {
    return <MaintenanceScreen status={status} variant="teacher" />
  }
  /*
   * 🆕 版本更新公告那一层（2026-10-04，施工单 §二.5）挂在**这里**，而不是 `App.tsx`：
   *    · 它要的是**同一次** `/api/status` 取数（施工单 §二.4「不许再开一个轮询」）
   *      —— `status` 在这里正好在手上；
   *    · 顺序也就是"维护 → 更新 → 页面"：维护开着时它根本不渲染（那一屏已经在管了）。
   * ⚠️ 两张豁免表**各存一份**（理由见 `ReleaseGate.tsx` 文件头）。
   */
  return <ReleaseGate status={status}>{children}</ReleaseGate>
}

/**
 * 维护画面。两种形态：
 *  · `teacher`   —— 教师端 / 登录页：一张居中卡片（不是白屏、不是报错）；
 *  · `classroom` —— 教室那块大屏：**整屏**，带大号时钟（那屏 24 小时亮着，
 *                   "还有多久"是它唯一有用的信息）。
 *
 * ⚠️ **不弹窗**（方案 §二.3 的表）：它是**常驻**状态，本来就不需要弹窗；
 *    而"关掉就不再显示"的位置配不上一个"可以被撤回"的状态。
 * ⚠️ 层叠：`SyncErrorBanner` 是 `z-[70]`，这里用 `z-40` ——
 *    "你的改动可能没保存"比"系统维护中"更个人、更紧急（照方案那条拍板）。
 */
export function MaintenanceScreen({
  status,
  variant,
}: {
  status: MaintenanceStatus & { refresh?: () => void }
  variant: 'teacher' | 'classroom'
}) {
  const school = useStore((s) => s.teacher?.school ?? '')
  /**
   * ⚠️ 这里存的是**真实时刻**（`Date.now()`），不是 `beijingNow()` 的返回值。
   *    `beijingNow()` 把时区偏移**加进了毫秒值**（在 UTC+8 的机器上恰好抵消，
   *    在别的时区就会差 8 小时）—— 拿它去算"还剩多久"会算错。
   *    所以：**倒计时用真实时刻，显示用北京时间的字段**。
   */
  const [nowMs, setNowMs] = useState(() => Date.now())

  /* 教室那块屏上时钟要走字；教师端也顺手走（"还剩多久"要准） */
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  /* 🔴 「重新检查」的反馈必须由这一屏自己持有（原因见按钮那一段注释：
     `useMaintenanceStatus` 在状态没变时**一次都不会重渲染**） */
  const [busy, setBusy] = useState(false)
  const [spin, setSpin] = useState(0)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  const bj = beijingNow(new Date(nowMs))
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`

  /**
   * 点「重新检查」：先转图标 + 变「检查中…」，收尾后亮一行「已检查 HH:MM:SS · 仍是维护中」。
   * ⚠️ `refresh()` **没有 promise 可等**（`useMaintenanceStatus` 里是 `void fetch…`），
   *    而且状态没变时它不 setState ⇒ 这里用一个**最短可见时长**收尾。
   *    这是"让动作看得见"，不是假装加载：真读数仍然由 hook 自己在轮询里更新。
   */
  const onRecheck = () => {
    if (busy) return
    setBusy(true)
    setSpin((n) => n + 1)
    status.refresh?.()
    window.setTimeout(() => {
      setBusy(false)
      const b = beijingNow(new Date())
      setCheckedAt(`${pad(b.getHours())}:${pad(b.getMinutes())}:${pad(b.getSeconds())}`)
    }, 900)
  }
  const leftMs = status.until === null ? null : status.until - nowMs
  const leftText =
    leftMs === null
      ? ''
      : leftMs <= 0
        ? '维护应该已经结束了 —— 点一下「重新检查」'
        : `预计还有 ${Math.floor(leftMs / 3600_000)} 小时 ${Math.floor((leftMs % 3600_000) / 60_000)} 分钟`

  const message = status.message || '系统维护中，请稍后重试。'

  if (variant === 'classroom') {
    return (
      <div
        data-maintenance-screen
        data-maintenance-variant="classroom"
        className="fixed inset-0 z-40 flex flex-col items-center justify-center px-10 text-center"
        style={{ background: 'var(--color-canvas)' }}
      >
        {/* 教室端维护屏：校徽 **64px 全徽**（盒子 73.6 = 64 / 0.87）。
            这一屏挂在教室里给学生看，所以徽比顶栏那两处大一号；
            它的读者隔着一间教室的距离 —— 32px 那一档在这个距离上只剩一个点。 */}
        <Emblem n={64} style={{ marginBottom: 16 }} />
        <div style={{ fontSize: 22, fontWeight: 620, color: 'var(--color-ink2)' }}>
          {school || '成都市树德实验高级中学 · 树高教务通'}
        </div>
        <div style={{ fontSize: 56, fontWeight: 700, marginTop: 10 }} data-maintenance-title>
          系统维护中
        </div>
        <div
          className="num"
          style={{ fontSize: 96, fontWeight: 700, letterSpacing: '.04em', marginTop: 18 }}
          data-maintenance-clock
        >
          {clock}
        </div>
        <div style={{ fontSize: 26, lineHeight: 1.7, marginTop: 18, maxWidth: 1000 }}>{message}</div>
        {leftText ? (
          <div style={{ fontSize: 20, color: 'var(--color-ink3)', marginTop: 14 }}>{leftText}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      data-maintenance-screen
      data-maintenance-variant="teacher"
      className="fixed inset-0 z-40 grid place-items-center px-5 py-10"
      style={{ background: 'var(--color-canvas)' }}
    >
      {/*
        🔴 超管那条路：手势落点 + 密码框（**屏上不写节奏**，见 `MaintenanceUnlock` 头部）。
        ⚠️ 它必须在**教师这一支**（`variant === 'teacher'`）里 ——
           教室端那一支是给**学生**看的大屏，那块屏上不该有任何维护入口。
      */}
      {variant === 'teacher' ? <MaintenanceUnlock /> : null}
      {/*
        🔴🔴 `zIndex: 40` 是**必须的**（2026-10-04 用户报"点『重新检查』没有任何反馈"时抓到的）：
           手势落点那一层是 `position: fixed; inset: 0; zIndex: 39` —— 它**盖在这张卡片上面**，
           于是卡片上所有的点击（包括「重新检查」按钮）都落到了那层透明落点上，
           按钮**从来没被点到过**（实测：`elementFromPoint(按钮中心)` 返回的是落点 span；
           点下去 `/api/status` 一个请求都不发）。
           ⇒ 卡片必须抬到落点**之上**。⚠️ 密码框是 `z-50`，仍在卡片之上（它就该在最上面）。
           ⚠️ 门禁那条"按节奏开框"是**直接用 JS 点落点**的，所以它**抓不到**这个 bug ——
              新加的那条用 `elementFromPoint` 做**真命中测试**。
      */}
      <div
        className="panel w-full overflow-hidden anim-in"
        style={{ maxWidth: 460, position: 'relative', zIndex: 40 }}
      >
        <div className="flex items-center gap-2.5 p-4">
          <IconAlert size={19} />
          <div style={{ fontSize: 17, fontWeight: 680 }} data-maintenance-title>
            系统维护中
          </div>
        </div>
        <div
          className="px-4 pb-4"
          style={{ fontSize: 13.5, lineHeight: 1.85, color: 'var(--color-ink2)' }}
        >
          {message}
          {leftText ? (
            <div className="mt-2" style={{ color: 'var(--color-ink3)' }}>
              {leftText}
            </div>
          ) : null}
          <div className="mt-3" style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
            · 维护期间平台功能暂停使用，你的登录状态不会被登出（维护结束后直接继续用）。
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          {/*
            🔴 「重新检查」以前**点下去什么都不动**（2026-10-04 用户报：没有反馈、没有动效）。
               两个原因叠在一起：
                 ① 按钮被手势落点盖住，根本点不到（见上面 `zIndex: 40` 那段）；
                 ② 就算点到了，`refresh()` 也是"发出去就不管"的 —— 而 `useMaintenanceStatus`
                    只在**状态真的变了**时才 setState（见那个 hook 的 `sameStatus`）
                    ⇒ 维护照旧时**一次重渲染都没有**，屏上自然毫无变化。
               ⇒ 所以反馈必须由这一屏自己给：点下去先转图标 + 变「检查中…」，
                  收尾后亮一行**「已检查 HH:MM:SS」**（`refresh()` 没有 promise 可等，
                  这里用一个最短可见时长收尾 —— 那是"让动作看得见"，不是假装加载）。
          */}
          <Button
            size="sm"
            disabled={busy}
            icon={
              <span
                style={{
                  display: 'inline-flex',
                  transform: `rotate(${spin * 360}deg)`,
                  transition: 'transform .9s var(--ease-out)',
                }}
              >
                <IconRefresh size={14} />
              </span>
            }
            onClick={onRecheck}
          >
            {busy ? '检查中…' : '重新检查'}
          </Button>
          {checkedAt ? (
            <span
              className="anim-in flex items-center gap-1"
              style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}
              data-maint-checked
            >
              <IconCheck size={13} />
              已检查 {checkedAt} · 仍是维护中
            </span>
          ) : (
            <span
              className="flex items-center gap-1.5"
              style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
            >
              <IconClock size={13} />
              {clock}（北京时间）
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
