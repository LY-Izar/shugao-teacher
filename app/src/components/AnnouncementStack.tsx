import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconAlert, IconInfo, IconMegaphone, IconX } from './icons'
import { Button, Modal } from './ui'
import { useStore } from '../data/store'
import {
  BAR_MAX_DESKTOP,
  BAR_MAX_MOBILE,
  LEVEL_TEXT,
  addSeen,
  addSessSeen,
  announcementPopupQueue,
  marksSeenOnClose,
  marksSessionOnShow,
  planAnnouncementBar,
  readHideDay,
  readSeen,
  readSessSeen,
  todayKey,
  writeHideDay,
} from '../lib/announcements'
import type { Announcement, AnnouncementLevel } from '../data/types'

/* ============================================================
   全站公告的**顶部横幅 + 弹窗**（2026-09-28 公告轮）
   ------------------------------------------------------------
   🔴🔴 **公告 ≠ 通知** —— 这是本仓库最容易搞混的一处：
     通知（教务通知）在 `/notices` 那一页里、有收件范围、有未读红点、**不弹窗**；
     公告（**关于平台本身**的信息）是**全站一条**、没有范围、**就是这一条横幅 + 可选弹窗**。
     ⛔ 这个文件**不 import** `pages/Notices.tsx` / `lib/notices.ts` 的任何东西。

   ------------------------------------------------------------
   🔴 **层叠规则（谁在上、同时出现怎么排）—— 唯一的定义处就是下面这段注释 + 那几个 z**

   本项目顶部一共**四个**会吸顶/浮起来的东西，各自的身份不同：

     z-80  `ToastHost`        （`AppShell.tsx`）临时气泡："已切换到 2 班"这种，几秒就没
     z-70  `SyncErrorBanner`  （`App.tsx`）**状态**："你的改动可能没保存"
     z-60  `.modal`           （`ui.tsx`）弹窗：早间欢迎 / 当天完成 / **公告弹窗**
     z-51  `.sheet` / z-50 `.scrim`（`index.css`）底部抽屉与它的遮罩
     ─────────────────────────────────────────────────────────────
     z-45  **本文件：公告条**（紧急/置顶的独立横幅 + 一条滚动条）
     z-40  `MobileNav`（移动端胶囊）· z-30 `PageHead` / 移动端顶栏

   规则只有三条，**从上到下就是这份 z 表**：
     ① **报错横幅在公告之上，而且公告条给它让位**（不是被它盖住）：
        `top = 报错横幅的实测高度`（下方 `syncH`）。理由与 `管理台第二期方案.md` §二.3 写的一致：
        "同步错误是'你的改动可能没保存'，它比'系统今晚维护'更个人、更紧急"。
        ⚠️ 让位而**不是**压盖是刻意的：被盖住 = 那条公告在报错期间**一个字都读不到**；
        让位 = 两条都读得到。
     ② **公告条在 `.scrim`(50) / `.sheet`(51) / `.modal`(60) 之下**：抽屉和弹窗一开，
        公告条被遮住（它不该压在浮层上）—— 这就是它取 45 而不是 57/58 的原因。
        ⚠️ 参照项目取的是 57/58（它没有本项目这套 50/51 的抽屉），**照抄那个数就会压住抽屉**。
     ③ **公告条自己内部**：独立横幅（紧急/置顶）在上、滚动条在下，**DOM 顺序即视觉顺序**
        （同一个 fixed 容器里依次排开，不靠 z-index 互相压）。

   🔴 它还要**给页面内容让位**：本组件把"报错横幅 + 公告条"的总高度写进
      `document.documentElement` 的 CSS 变量 `--top-stack-h`，
      由 `AppShell`（移动端顶栏 / 桌面左栏 / 右栏）与 `ui.tsx` 的 `PageHead` 消费
      （`top: var(--top-stack-h, 0px)`）。**没有这个变量就会有一条被顶栏压住的公告**。
   ============================================================ */

/** 等级 → 底色（**只影响外观**；弹不弹由 `popup` 决定，见 `lib/announcements.ts`） */
const LEVEL_STYLE: Record<AnnouncementLevel, { bg: string; fg: string; bd: string }> = {
  /* 紧急：实心红 + 白字（全站最重的一档；借用项目的 bad 色，不新造颜色） */
  urgent: { bg: 'var(--color-bad)', fg: 'var(--color-onbad)', bd: 'var(--color-badline)' },
  /* 重要：暖黄（与工作台那条"数据没存上"的卡同一挂 —— 项目里"要注意"就是这一挂） */
  important: { bg: 'var(--color-warnsoft)', fg: 'var(--color-warnink)', bd: 'var(--color-warnline)' },
  /* 普通：浅灰（滚动条那一档，最安静） */
  normal: { bg: 'var(--color-surface2)', fg: 'var(--color-ink2)', bd: 'var(--color-line)' },
}

const BADGE_STYLE: Record<AnnouncementLevel, string> = {
  urgent: 'tag tag-bad',
  important: 'tag tag-warn',
  normal: 'tag tag-idle',
}

/** `pin` / `urgent` / `important` 各自的徽标文字（**等级与置顶是两个维度**，可以同时出现） */
function badgesOf(a: Announcement): string[] {
  const out: string[] = []
  if (a.pin) out.push('置顶')
  if (a.level === 'urgent') out.push('紧急')
  else if (a.level === 'important') out.push('重要')
  return out.length ? out : ['公告']
}

const whenText = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * 顶部公告条 + 公告弹窗。
 *
 * `suppressPopup` = **更高优先级的弹窗正开着**（早间欢迎 / 当天完成）——
 * 由 `AppShell` 那一行 JSX 直接传进来（`mood.welcomeOpen || mood.doneOpen`）。
 * 🔴 它**只抑制弹窗，不抑制横幅**，而且抑制期间**不记任何 seen**
 *    （"这一次没弹"不等于"用户看过了"，否则那条公告就被静默吞掉了）。
 */
export function AnnouncementStack({ suppressPopup = false }: { suppressPopup?: boolean }) {
  const list = useStore((s) => s.announcements)
  const preview = useStore((s) => s.annPreview)
  const clearAnnPreview = useStore((s) => s.clearAnnPreview)

  /* 「现在」：30 秒一跳 —— 生效区间两端到了，横幅要自己出现/消失，而不是等刷新 */
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  /** 本机记的"今天关过"（**惰性初值**读一次，之后由本组件自己维护） */
  const [hiddenDay, setHiddenDay] = useState<string | null>(() => readHideDay())
  /** 本次会话里逐条按过「×」的（内存；刷新就回来 —— 与"今天关过"是两件事） */
  const [closedIds, setClosedIds] = useState<string[]>([])
  /** 滚动条轮换到第几条 */
  const [idx, setIdx] = useState(0)
  /** 弹窗：一次只弹一个 */
  const [current, setCurrent] = useState<Announcement | null>(null)
  /** 展开正文的那几条（独立横幅点一下可以把正文看全） */
  const [openIds, setOpenIds] = useState<string[]>([])

  /* 窄屏只留一条独立横幅（`BAR_MAX_MOBILE`）—— 顶部每多一条就永久吃掉一屏的行高 */
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setWide(mq.matches)
    apply()
    // Safari 14 只有 addListener；用能力检测而不是猜 UA
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply)
    else if (typeof mq.addListener === 'function') mq.addListener(apply)
    return () => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', apply)
      else if (typeof mq.removeListener === 'function') mq.removeListener(apply)
    }
  }, [])

  const today = todayKey(new Date(tick))
  const plan = useMemo(
    () =>
      planAnnouncementBar(list, {
        nowMs: tick,
        hiddenDay,
        today,
        closedIds,
        maxBars: wide ? BAR_MAX_DESKTOP : BAR_MAX_MOBILE,
        preview,
      }),
    [list, tick, hiddenDay, today, closedIds, wide, preview],
  )

  /* ---------------- 弹窗：一次一个，关掉上一个才弹下一个 ---------------- */
  useEffect(() => {
    if (current || suppressPopup) return
    /*
     * ⚠️ 延迟 400ms 再弹，两个理由（都是实测出来的）：
     *   ① 让**别的浮层先站起来**（早间欢迎弹窗是同一帧挂载的）—— 哪怕 `suppressPopup`
     *      因为时序差了一帧还没变真，也不会出现"两个弹窗同时开"；
     *   ② 这个 `setTimeout` 也让这条 effect 不再"同步改 state"
     *      （`react(set-state-in-effect)` 那条 lint 规则；本仓库要求 0 warning）。
     */
    const t = window.setTimeout(() => {
      const seen = { seen: readSeen(), sessSeen: readSessSeen() }
      /* 预览那一条**无视 `popup` 与 seen**（超管点的是"我要看它长什么样"），
         但仍然**受 `suppressPopup` 管** —— 于是"它给早间弹窗让位"这件事是可测的。 */
      const next = preview ?? announcementPopupQueue(list, { nowMs: Date.now(), seen })[0] ?? null
      if (!next) return
      /* `session` 与"紧急的 never"：**弹出时就记**（关不关掉都不再弹第二次） */
      if (marksSessionOnShow(next)) addSessSeen(next.id)
      setCurrent(next)
    }, 400)
    return () => window.clearTimeout(t)
  }, [list, preview, suppressPopup, current, tick])

  const closePopup = () => {
    const a = current
    if (!a) return
    /* `once`：**关掉时**才记（用户确实看到了）；`always` 一个都不记 */
    if (marksSeenOnClose(a)) addSeen(a.id)
    /* 预览看一次就清（横幅与弹窗一起收掉），免得它下次莫名弹出来 */
    if (a.preview) clearAnnPreview()
    setCurrent(null)
  }

  /* 滚动条轮换（只有一条时不动）。
     ⚠️ 这里**不要**再 `setIdx(0)` 去"归零"：读的时候那一处 `Math.min(idx, len - 1)`
        已经把越界的下标夹回去了（多一条会 `setState` → 多一轮渲染 → oxlint 的
        `react(set-state-in-effect)` 警告）。 */
  useEffect(() => {
    if (plan.marquee.length < 2) return
    const t = window.setInterval(() => setIdx((i) => (i + 1) % plan.marquee.length), 6000)
    return () => window.clearInterval(t)
  }, [plan.marquee.length])

  /* ---------------- 让位：写 `--top-stack-h`（见文件头那段层叠规则） ----------------
   *
   * 🔴 这里是**唯一**一处直接摸 DOM 的地方，两个数都**不用 React 状态**：
   *    · 公告条自己的高度、以及报错横幅（`App.tsx` 的 `SyncErrorBanner`，z-70）的高度；
   *    · 报错横幅一变，公告条整体下移（`el.style.top`）、`--top-stack-h` 跟着重算。
   * ⚠️ 为什么走命令式而不是 `setState`：这两个值**只影响布局、不影响渲染的内容**，
   *    而 `setState` 会在每次测量后多触发一轮渲染（`ResizeObserver` → render → 再测，
   *    很容易写成自激）。而且 oxlint 的 `react(set-state-in-effect)` 会把它标成警告，
   *    本仓库的口径是 `npm run lint` **0 warning**。
   * ⚠️ `top` 只在这里写、**JSX 的 style 里没有它** —— React 不会去动一个它不管的属性；
   *    反过来，一旦把 `top` 也写进 JSX，两处就会打架（命令式那次会被 React 覆盖掉）。
   * ⚠️ `useLayoutEffect` 在浏览器**绘制之前**跑完，所以不会出现"先贴在 y=0 再跳下去"的闪。
   */
  const rootRef = useRef<HTMLDivElement>(null)
  const syncError = useStore((s) => s.syncError)

  useLayoutEffect(() => {
    const el = rootRef.current
    const syncEl = () => document.querySelector<HTMLElement>('[data-sync-error-banner]')
    /*
   * 🔴🔴 **状态栏让位**（2026-10-03，用户 apk 截图报出来的）。
   *
   * 症状：手机上那条「平台开始第一次范围公测」被**系统状态栏压住** ——
   * 时间/信号/电池那一行盖在公告文字上，两个都读不全。
   *
   * 根因：这一叠全是 `position: fixed; top: 0`（本组件）/ `top: var(--top-stack-h)`
   * （移动端顶栏），而 `--top-stack-h` **只由这两条的高度算出来**，
   * 🔴 **从来没算过 `env(safe-area-inset-top)`** —— 也就是"系统状态栏占了多高"
   * 这件事从头到尾没被量进去。
   *
   * 为什么不能只在某个组件上补 `padding-top`：这一叠有**四层**
   * （公告条 / 报错横幅 / 移动端顶栏 / Toast），各补各的必然对不齐
   * （截图里就有一处是"补了但没补齐"的样子）。→ 统一在这里量一次，
   * 写进 `--top-stack-h`，那一叠所有消费者一起让开。
   *
   * ⚠️ 网页/PWA 上 `env(safe-area-inset-top)` 恒为 0 ⇒ **网页行为逐字不变**
   *    （`--top-stack-h` 与改之前算出来的是同一个数）。
   *
   * ⚠️ Chrome 的规则：**只有 `viewport-fit=cover` 时 `env()` 才非零**。
   *    那条 meta 在 `index.html` 里 —— 少了它这段代码恒等于 0。
   * ==================================================================
   * 🔴🔴🔴 **这里踩过一次自激循环，记下来别再踩**（2026-10-03）
   * ------------------------------------------------------------------
   * 第一版：`insetTop()` 每调一次就**往 `body` 插一个探针 div、量完 remove**。
   * 而 `apply()` 恰好被挂在 **`document.body` 的 MutationObserver（childList）** 上
   *    —— 那正是"报错横幅是挂上/摘下"才需要的那一个。
   * ⇒ 插 div → 触发 MutationObserver → `apply()` → 再插 → **无限循环**。
   *
   * 症状极难认：`page.goto(..., { waitUntil: 'networkidle' })` **超时 30s**，
   * 报「Timeout 30000ms exceeded」，而页面**完全正常、控制台零报错** ——
   * 第一反应会以为是自己改坏了页面（我确实先怀疑了那三个文件）。
   * 🔴 破案办法：**直接开一次页面看屏上是什么**（真信号），别盯着错误码猜。
   *
   * ✅ 修法：**缓存**。状态栏高度只在**转屏 / 改窗口大小时**才可能变，
   *    所以量一次存起来，`resize` / `orientationchange` 时才清缓存重算。
   *    重算那次虽然也会触发一次 MutationObserver，但那时缓存已填好、
   *    不再插探针 ⇒ 循环第二次就停了。
   */
  let cachedInset: number | null = null

  const insetTop = () => {
    if (cachedInset !== null) return cachedInset
    /*
     * 探针元素最稳：读 `documentElement` 上的 `env()` 在部分 WebView 里读不到
     * （UA 差异），而一个 0 宽的探针 div 一定读得到。
     * ⚠️ 必须挂在 **body** 上 —— 它得参与同一套布局上下文。
     */
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;pointer-events:none;visibility:hidden;height:env(safe-area-inset-top,0px);'
    document.body.appendChild(probe)
    cachedInset = Math.ceil(probe.getBoundingClientRect().height)
    probe.remove()
    return cachedInset
  }

  const apply = () => {
      const node = rootRef.current
      if (!node) return
      /* 🔴 先把 `top` 归零再量**它自己的高度** —— 否则量到的是"已经被推到下面那条"的高度 */
      node.style.top = '0px'
      const own = Math.ceil(node.getBoundingClientRect().height)
      const s = syncEl()
      const sync = s ? Math.ceil(s.getBoundingClientRect().height) : 0
      /* 状态栏那一段：公告条与报错横幅**都要**从它下面开始 */
      const inset = insetTop()
      node.style.top = `${inset + sync}px`
      document.documentElement.style.setProperty('--top-stack-h', `${inset + sync + own}px`)
    }
    apply()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply)
      if (el) ro.observe(el)
      const s = syncEl()
      if (s) ro.observe(s)
    }
    /* 报错横幅是**挂上/摘下**（不是改高度）—— 只有 MutationObserver 抓得到 */
    const mo = new MutationObserver(apply)
    mo.observe(document.body, { childList: true })
    /* 🔴 resize / 转屏时**清掉状态栏缓存**再重算 —— 那是它唯一会变的时机。
     * ⚠️ 清与算必须挂在**同一个**函数上：只清不算 → 公告条停在旧值；
     *    只算不清 → 永远是第一次量到的那个值。 */
    const onResize = () => {
      cachedInset = null
      apply()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      ro?.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      document.documentElement.style.setProperty('--top-stack-h', '0px')
    }
    /* 依赖：条数/A 展开态 会改高度；`syncError` 变了要**重新观察**那一棵元素 */
  }, [plan.bars.length, plan.marquee.length, openIds.length, syncError])

  const marqueeItem = plan.marquee.length
    ? plan.marquee[Math.min(idx, plan.marquee.length - 1)]
    : null

  const toggleOpen = (id: string) =>
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <>
      {/* 空的时候也要渲染这个节点：它的高度 = 0，`--top-stack-h` 自然回到"只有报错横幅"。
          ⚠️ 它的 `top` 由上面那段 `useLayoutEffect` 命令式地写（让位给报错横幅），
             **这里不要写 `top`** —— 两处都写就会互相覆盖。 */}
      <div
        ref={rootRef}
        data-ann-stack
        style={{ position: 'fixed', left: 0, right: 0, zIndex: 45 }}
      >
        {plan.bars.map((a) => {
          const st = LEVEL_STYLE[a.level]
          const open = openIds.includes(a.id)
          return (
            <div
              key={a.id}
              data-ann-bar={a.level}
              data-ann-id={a.id}
              style={{ background: st.bg, color: st.fg, borderBottom: `1px solid ${st.bd}` }}
            >
              <div
                className="mx-auto flex items-start gap-2 px-3 py-1.5"
                style={{ maxWidth: 1220 }}
              >
                <span style={{ marginTop: 2, flex: 'none', display: 'grid', placeItems: 'center' }}>
                  {a.level === 'urgent' ? <IconAlert size={15} /> : <IconMegaphone size={15} />}
                </span>
                <button
                  type="button"
                  data-ann-expand={a.id}
                  onClick={() => toggleOpen(a.id)}
                  className="min-w-0 flex-1 text-left"
                  /*
                   * 🔴 `aria-label` 是**固定文案**，这是刻意的、也是必须的：
                   *    无障碍名默认取按钮里的全部文字（"置顶 重要 系统维护…"），
                   *    而那段文字**每天都不一样** —— 于是它会被别的自动化测试的
                   *    `getByRole('button', { name: '保存' })` 这类**子串匹配**命中
                   *    （本仓库实测栽过一次：公告正文里的"保存失败"让"保存"这个按钮变成了两个）。
                   *    固定文案同时更准确：这个按钮的动作是"**展开/收起**"，不是"通告全文"。
                   */
                  aria-label={open ? '收起公告正文' : '展开公告正文'}
                  aria-expanded={open}
                  /*
                   * 折叠态**严格一行**（`nowrap` + 省略号），展开态看全（`pre-wrap` 保住正文换行）。
                   * ⚠️ 省略号必须挂在这个按钮上（它是那个 `min-w-0 flex-1` 的 flex 子项）——
                   *    挂在内层 span 上时，一行放不下就会**折成两行**（实测：手机上 56px 而不是 35px）。
                   */
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    fontWeight: a.level === 'normal' ? 550 : 700,
                    overflow: open ? 'visible' : 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: open ? 'pre-wrap' : 'nowrap',
                  }}
                >
                  {badgesOf(a).map((b) => (
                    <span
                      key={b}
                      className={BADGE_STYLE[a.level]}
                      style={{ marginRight: 6, verticalAlign: '1px' }}
                    >
                      {b}
                    </span>
                  ))}
                  <b>{a.title}</b>
                  {a.body ? <span style={{ fontWeight: 450 }}>{` ${a.body}`}</span> : null}
                </button>
                <button
                  type="button"
                  data-ann-close-bar={a.id}
                  /*
                   * 🔴 无障碍名里**刻意不带"关闭"两个字**：`shots.mjs` 有几处
                   *    `getByLabel('关闭').first()`（它们在点抽屉/弹窗的关闭按钮），
                   *    而 `getByLabel` 是**子串匹配** —— 公告条常驻在每一页上，
                   *    带"关闭"就会把那些查询变成"两个元素"（本轮实测：整步 30 秒超时）。
                   *    这里描述的是**公告自己的动作**（这条不再显示），本来就更准确。
                   */
                  aria-label="本次不再显示这条公告"
                  onClick={() => setClosedIds((prev) => [...prev, a.id])}
                  style={{ flex: 'none', color: 'inherit', opacity: 0.75, padding: '2px 4px' }}
                >
                  <IconX size={15} />
                </button>
              </div>
            </div>
          )
        })}

        {marqueeItem ? (
          <div
            data-ann-marquee
            data-ann-id={marqueeItem.id}
            style={{
              background: LEVEL_STYLE.normal.bg,
              color: LEVEL_STYLE.normal.fg,
              borderBottom: `1px solid ${LEVEL_STYLE.normal.bd}`,
            }}
          >
            <div className="mx-auto flex items-center gap-2 px-3 py-1.5" style={{ maxWidth: 1220 }}>
              <span style={{ flex: 'none', display: 'grid', placeItems: 'center', opacity: 0.75 }}>
                <IconInfo size={14} />
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                style={{ fontSize: 12.5, fontWeight: marqueeItem.level === 'normal' ? 450 : 650 }}
              >
                {badgesOf(marqueeItem).map((b) => (
                  <span key={b} className={BADGE_STYLE[marqueeItem.level]} style={{ marginRight: 6 }}>
                    {b}
                  </span>
                ))}
                <b>{marqueeItem.title}</b>
                {marqueeItem.body ? <span>{` ${marqueeItem.body}`}</span> : null}
              </span>
              {plan.marquee.length > 1 ? (
                <span className="num" style={{ flex: 'none', fontSize: 11, opacity: 0.7 }}>
                  {Math.min(idx, plan.marquee.length - 1) + 1}/{plan.marquee.length}
                </span>
              ) : null}
              <button
                type="button"
                data-ann-close-marquee
                aria-label="今天不再显示公告"
                onClick={() => {
                  writeHideDay(today)
                  setHiddenDay(today)
                }}
                style={{ flex: 'none', color: 'inherit', opacity: 0.6, padding: '2px 4px' }}
              >
                <IconX size={14} />
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <Modal open={current !== null} onClose={closePopup} labelledBy="ann-popup-title">
        {current ? (
          <div data-ann-popup={current.level}>
            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{
                background: LEVEL_STYLE[current.level].bg,
                color: LEVEL_STYLE[current.level].fg,
                borderRadius: '10px 10px 0 0',
              }}
            >
              <span style={{ display: 'grid', placeItems: 'center' }}>
                {current.level === 'urgent' ? <IconAlert size={17} /> : <IconMegaphone size={17} />}
              </span>
              <div id="ann-popup-title" className="flex-1" style={{ fontSize: 15, fontWeight: 700 }}>
                {current.title}
              </div>
              {/* ⚠️ 这个叉的无障碍名同样**不带"关闭"**（理由见横幅上那个叉的注释） */}
              <button
                type="button"
                onClick={closePopup}
                aria-label="收起公告弹窗"
                style={{ color: 'inherit' }}
              >
                <IconX size={18} />
              </button>
            </div>
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={BADGE_STYLE[current.level]}>{LEVEL_TEXT[current.level]}</span>
                {current.preview ? <span className="tag tag-accent">预览</span> : null}
                <span className="flex-1" />
                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  {whenText(current.createdAt)}
                </span>
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontSize: 14,
                  lineHeight: 1.85,
                  whiteSpace: 'pre-wrap',
                  color: 'var(--color-ink)',
                }}
              >
                {current.body}
              </div>
              <Button block variant="primary" className="mt-3" onClick={closePopup}>
                我知道了
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
