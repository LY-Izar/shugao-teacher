/* ============================================================
   版本更新公告的**全局闸门** —— 2026-10-04，施工单 `施工单-版本更新提示.md`
   ------------------------------------------------------------
   🔴 它要做的两件事（用户原话的口径）：
      · **强制**：公告上**只有「下载最新版」**—— 没有关闭 ×、没有 Esc、
        点遮罩不关、**没有"稍后"**；而且**整屏接管**（登录之后除豁免路径外
        只能看见它，"平台用不了"）；
      · **选择性**：公告上「下载最新版」＋「稍后」⇒ 点稍后就正常用。
        🆕 **每次进入应用都再弹一次**（用户 2026-10-04 拍板：每次冷启动都弹，
        同一天反复开也每次弹）—— 所以"关过了"只记在**这一次进程**里（组件 state），
        冷启动就没了；而**换版本号要重新提示**（比的是版本，不是一个布尔）。

   🔴 两个豁免（`/login` 与 `/admin`）：
      · 不豁免 `/login` ⇒ 连登录都进不去，「登录后只能看见提示」这句话就不成立；
      · 不豁免 `/admin` ⇒ 超管会被**自己**锁在外面（**维护模式已经踩过这条**）。
      ⚠️ 这张表与 `MaintenanceGate.tsx` 里那张**刻意各存一份**：两张表的理由不同
        （那张还要豁免 `/classroom`，这张**不豁免** —— 教室那块屏也要更新）。

   🔴 三件事**不由这个文件说了算**（别在这里加判据）：
      · 是不是强制 —— 服务端那一位 `force`（这里只决定"关不关得掉"）；
      · 该不该提示 —— `useRelease()` 里那一次版本比较（`APP_VERSION` vs 公告版本）；
      · 我这一台是哪一档 —— `releaseTargetOf()`（`appRole === 'classroom'` 或 `/classroom`）。

   ⚠️ 层叠：维护画面与它都用 `z-40`。**维护在的时候它不渲染**（见下面 `status.enabled`
      那一条 early-return）：`/classroom` 不参与全局维护闸门、由 `Classroom.tsx`
      自己渲染维护屏，两层整屏叠在一起只会互相打架。
   ============================================================ */

import type React from 'react'
import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { MaintenanceStatus } from '../lib/maintenance'
import { ReleaseSlotsContext, useRelease, type ReleaseView } from '../lib/useRelease'
import {
  RELEASE_BTN_DOWNLOAD,
  RELEASE_BTN_LATER,
  RELEASE_CLASSROOM_HINT,
} from '../lib/release'
import {
  canDownloadAndInstall,
  downloadAndInstall,
  openInstallPermissionSettings,
} from '../lib/fileOut'
import { Emblem } from './Emblem'
import { IconDownload, IconSpark, IconX } from './icons'
import { useStore } from '../data/store'

/**
 * 豁免这一档判定的路径（见文件头；**加一条之前先想清楚"超管会不会被自己锁住"**）。
 * ⚠️ **刻意不 export**：`shots.mjs` / `nav-checks.mjs` 按**源码文本**核对这两条路径
 *    （与 `MaintenanceGate.tsx` 那张表同一个做法）。
 */
const RELEASE_EXEMPT_PATHS = ['/login', '/admin'] as const

/**
 * 「下载最新版」在**没授权**时说的那一句（Android 8+ 要用户对这个来源单独允许装应用）。
 * ⚠️ 文案纪律（`AGENTS.md` §七）：只回答"这里是什么、我能做什么"，**不解释实现**、
 *    不写"未知来源""安装包"这类系统弹窗词（那几个词在 `lib/release.ts` 的禁词表里）。
 */
const INSTALL_HINT_PERM = '还没允许从这里安装应用。已打开系统设置，打开那个开关后回来再点一次「下载最新版」。'

/** 别的失败（下载断了 / 没地方放…）说一句人话 —— 老师点了**不许没反应** */
const INSTALL_HINT_FAIL = '没下下来。已改用浏览器下载。'

export function ReleaseGate({
  status,
  children,
}: {
  status: MaintenanceStatus
  children: React.ReactNode
}) {
  const loc = useLocation()
  const view = useRelease(status)
  /**
   * 选择性那一档"这次关过了"的**版本号**（空串 = 还没关过）。
   * ⚠️ 存版本号而不是布尔：换了版本要**重新提示**（施工单 §二.5）。
   * ⚠️ 存组件 state 而不是 localStorage：用户拍板的是"**每次冷启动都弹**"。
   */
  const [closedVersion, setClosedVersion] = useState('')

  /**
   * 🔴 把**这一次取数**的两档链接交给下面那些页（「我的 → 关于」那三颗下载按钮要用）。
   *    `value` 就是手上这个 `status.release` —— **不新发请求、不开第二个轮询**；
   *    读它的是 `lib/useRelease.ts` 的 `useReleaseSlots()`（`nav-checks` D18 钉着这一条）。
   * ⚠️ 每一条 `children` 出口都要包上：少包一条，那一条路上的页面就一颗按钮都摆不出来。
   */
  const withSlots = (kids: React.ReactNode) => (
    <ReleaseSlotsContext.Provider value={status.release}>{kids}</ReleaseSlotsContext.Provider>
  )

  /* 维护中：那一屏已经在管了（`/classroom` 自己渲染它），这里不叠第二层整屏 */
  if (status.enabled) return withSlots(children)

  const exempt = (RELEASE_EXEMPT_PATHS as readonly string[]).includes(loc.pathname)
  if (exempt) return withSlots(children)

  /* 🔴 提示的判据只有这一条：服务端发了公告 **而且**我这一版比它旧 */
  if (view.check !== 'behind' || !view.notice) return withSlots(children)

  const notice = view.notice
  if (view.canClose && closedVersion === notice.version) return withSlots(children)

  /**
   * 🔴 **什么时候保留 children**（两个理由，都不是"顺手"）：
   *    · **教室端那一档**：与 `MaintenanceGate` 豁免 `/classroom` 是**同一条理由** ——
   *      教室那台机器的**心跳必须照发**（组件被卸载 = 心跳停 = 面板开始显示"教室端离线"，
   *      而它其实好好地在显示"请更新到最新版"：那是往"假在线"那条已知缺陷上再叠一层假信号）。
   *    · **选择性那一档**：它是一张可以关掉的弹窗，弹窗不该把整页销毁重建
   *      （`children` 一卸载，页面上正在填的东西就没了）。
   *  ⇒ 只有**强制 + 教师端**是"整块替换"—— 那一档的口径就是"平台用不了"。
   */
  const keepChildren = view.target === 'classroom' || view.canClose

  return (
    <>
      {keepChildren ? withSlots(children) : null}
      <ReleaseScreen view={view} onLater={() => setClosedVersion(notice.version)} />
    </>
  )
}

/**
 * 公告那一屏。两种形态：
 *  · `teacher`   —— 教师端 / 手机 / 网页：一张居中卡片；
 *  · `classroom` —— 教室那块大屏：**整屏大字**（它的读者隔着一间教室，
 *                  而且这台机器要**人工装一次**，所以多一句「请在教师电脑上下载后…」）。
 *
 * ⚠️ 在**它自己的** `z-40` 整屏里：教室端那一支是盖在页面上的，所以必须**不透明**
 *    （`background: var(--color-canvas)`）—— 半透明会让下面的班级数据透出来。
 */
function ReleaseScreen({ view, onLater }: { view: ReleaseView; onLater: () => void }) {
  const notice = view.notice
  const school = useStore((s) => s.teacher?.school ?? '')

  /**
   * 🔴 **应用内更新**（2026-10-05 施工单 `施工单-版本更新提示.md` §八，用户确认这一条是
   *    **教师端 apk** 的事）：apk 里点了「下载最新版」，原来是**浏览器下载完就完了** ——
   *    老师还得自己去「文件管理」里翻出那个 apk 才装得上。能拿到壳的那个方法时改走壳
   *    （原生下载 → 系统安装界面）；**拿不到就保持现在的行为**（下面那颗 `<a>` 照旧）。
   *
   * ⚠️ **网页版与两个 exe 一个字都不许变**：桥接方法只在 apk 新壳里有 ⇒
   *    `canDownloadAndInstall()` 在那边恒 false ⇒ 第一句就 return，原来的链接照旧。
   * 🔴 **真机未验**：本机没有安卓设备 —— 这条路只做过静态判据（`nav-checks` 第二十六节），
   *    真机验收只能由用户在手机上做。
   * ⚠️ 三个 hook **必须放在下面那句 early-return 之前**（与 `useStore` 同一条理由）：
   *    放在它后面就是"条件调用 hook"，`notice` 一旦从有到无，React 当场报 hook 数不对。
   */
  const fallbackClick = useRef(false)
  const downloadAnchor = useRef<HTMLAnchorElement>(null)
  /** 空串 = 没话说（网页版 / 两个 exe 恒空串 ⇒ 屏上不会多出任何东西） */
  const [installHint, setInstallHint] = useState('')

  if (!notice) return null

  /** 🔴 能不能关，只认服务端那一位（`canClose` 就是 `!force`） */
  const force = !view.canClose
  const classroom = view.target === 'classroom'

  const onDownloadClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    /*
     * 这一下是**我们自己点出来的**（下面那条退回浏览器）：放它走。
     * 没有这个闸，退回分支点回来又被同一个 handler 拦住 ⇒ 老师点完什么都没发生
     * —— 那正是这一轮要修的毛病。
     */
    if (fallbackClick.current) {
      fallbackClick.current = false
      return
    }
    // 拿不到桥接 ⇒ 立刻返回、**什么都不做** = 原来的 `<a href target="_blank">` 行为
    if (!canDownloadAndInstall()) return
    e.preventDefault()
    const r = await downloadAndInstall(view.url)
    if (r.ok) {
      // 系统安装界面已经起来了：不用多说（老师看得到那两下）
      setInstallHint('')
      return
    }
    if (r.needPermission) {
      // 🔴 没授权**不许静默**：说一句人话 + 引导去系统设置（那条退路也还在）
      setInstallHint(INSTALL_HINT_PERM)
      await openInstallPermissionSettings()
      return
    }
    // 别的失败：**退回当前行为**（把那个 https 链接交给浏览器），并且明说已经退了
    setInstallHint(r.why ? `${r.why}已改用浏览器下载。` : INSTALL_HINT_FAIL)
    fallbackClick.current = true
    downloadAnchor.current?.click()
  }

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    textDecoration: 'none',
    ...(classroom ? { fontSize: 24, padding: '14px 28px' } : {}),
  }

  const buttons = (
    <div className={classroom ? 'flex items-center gap-4' : 'flex items-center gap-2'}>
      {view.url ? (
        /* 🔒 只显示不执行：`target="_blank"` + `noreferrer`（施工单 §六的安全口径）。
           🆕 2026-10-05：apk 新壳里**才**有那条"下载完调起安装器"的路（onClick 里第一句
           就是"拿不到桥接就什么都不做"）⇒ 网页版与两个 exe 的这颗按钮行为不变。 */
        <a
          ref={downloadAnchor}
          className="btn btn-primary"
          style={btnStyle}
          href={view.url}
          target="_blank"
          rel="noreferrer"
          onClick={onDownloadClick}
          data-release-download
        >
          <IconDownload size={classroom ? 22 : 15} />
          {RELEASE_BTN_DOWNLOAD}
        </a>
      ) : null}
      {view.canClose ? (
        <button
          type="button"
          className="btn"
          style={btnStyle}
          onClick={onLater}
          data-release-later
        >
          {RELEASE_BTN_LATER}
        </button>
      ) : null}
    </div>
  )

  /* ---------------- 教室那块大屏 ---------------- */
  if (classroom) {
    return (
      <div
        data-release-screen
        data-release-slot="classroom"
        data-release-force={force ? '1' : '0'}
        data-release-version={notice.version}
        className="fixed inset-0 z-40 flex flex-col items-center justify-center px-10 text-center"
        style={{ background: 'var(--color-canvas)' }}
      >
        <Emblem n={64} style={{ marginBottom: 16 }} />
        <div style={{ fontSize: 22, fontWeight: 620, color: 'var(--color-ink2)' }}>
          {school || '成都市树德实验高级中学 · 树高教务通'}
        </div>
        <div
          style={{ fontSize: 56, fontWeight: 700, marginTop: 10 }}
          data-release-title
        >
          {view.title}
        </div>
        <div style={{ fontSize: 30, lineHeight: 1.7, marginTop: 18, maxWidth: 1000 }} data-release-note>
          {notice.note}
        </div>
        <div style={{ fontSize: 20, color: 'var(--color-ink3)', marginTop: 10 }}>
          {RELEASE_CLASSROOM_HINT}
        </div>
        <div style={{ marginTop: 26 }}>{buttons}</div>
        {/* 只在 apk 上、点了下载之后才出现（网页版 / 两个 exe 恒不渲染） */}
        {installHint ? (
          <div style={{ fontSize: 20, color: 'var(--color-ink2)', marginTop: 14 }} data-release-install-hint>
            {installHint}
          </div>
        ) : null}
      </div>
    )
  }

  /* ---------------- 教师端 / 网页 ---------------- */
  return (
    <div
      data-release-screen
      data-release-slot="teacher"
      data-release-force={force ? '1' : '0'}
      data-release-version={notice.version}
      className="fixed inset-0 z-40 grid place-items-center px-5 py-10"
      style={{ background: 'var(--color-canvas)' }}
      /*
        ⚠️ 选择性那一档：点空白处 = 稍后（用户会去点它）。**强制那一档不挂这个 onClick**
           —— 施工单 §一.1 写的就是"点遮罩不关"。卡片自己 `stopPropagation`，
           所以卡片上的点击不会穿到这一层。
      */
      onClick={view.canClose ? onLater : undefined}
    >
      <div
        className="panel relative w-full overflow-hidden anim-in"
        style={{ maxWidth: 420, zIndex: 41 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 p-4">
          {/*
            ⚠️ 这个图标**刻意不带 `color`** —— 与同族的维护卡（`MaintenanceGate.tsx:449`
            的 `<IconAlert size={19} />`）一致：`color:` 前景色在本仓库只许用
            `--color-accenttext`（`shots` 的 F6-H 是全仓计数：`accent` 必须 0 处），
            所以这里让它**继承**当前正文色，不为一个装饰性图标多开一处颜色落点。
          */}
          <span style={{ marginTop: 2 }}>
            <IconSpark size={19} />
          </span>
          <div className="flex-1">
            <div style={{ fontSize: 17, fontWeight: 680 }} data-release-title>
              {view.title}
            </div>
            <div
              className="mt-1"
              style={{ fontSize: 13.5, lineHeight: 1.85, color: 'var(--color-ink2)' }}
              data-release-note
            >
              {notice.note}
            </div>
            {/* 只在 apk 上、点了下载之后才出现（网页版 / 两个 exe 恒不渲染） */}
            {installHint ? (
              <div
                className="mt-2"
                style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-ink2)' }}
                data-release-install-hint
              >
                {installHint}
              </div>
            ) : null}
          </div>
          {/* 🔴 只有选择性那一档有关闭 × —— 强制那一档**一个能关的落点都没有** */}
          {view.canClose ? (
            <button
              type="button"
              aria-label="关闭"
              onClick={onLater}
              data-release-close
              style={{ color: 'var(--color-ink3)', padding: 2 }}
            >
              <IconX size={16} />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">{buttons}</div>
      </div>
    </div>
  )
}
