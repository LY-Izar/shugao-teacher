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
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Button } from './ui'
import { IconAlert, IconClock, IconRefresh } from './icons'
import { useMaintenanceStatus } from '../lib/useMaintenance'
import { beijingNow } from '../lib/holiday'
import { useStore } from '../data/store'
import type { MaintenanceStatus } from '../lib/maintenance'

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
  return <>{children}</>
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

  const bj = beijingNow(new Date(nowMs))
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(bj.getHours())}:${pad(bj.getMinutes())}:${pad(bj.getSeconds())}`
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
        <div style={{ fontSize: 22, fontWeight: 620, color: 'var(--color-ink2)' }}>
          {school || '树高教师平台'}
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
      <div className="panel w-full overflow-hidden anim-in" style={{ maxWidth: 460 }}>
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
            <br />· 正在填的表先别关页面。
            <br />· 这一页每 10 秒自己检查一次；好了它自己会让开。
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <Button
            size="sm"
            icon={<IconRefresh size={14} />}
            onClick={() => status.refresh?.()}
          >
            重新检查
          </Button>
          <span
            className="flex items-center gap-1.5"
            style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
          >
            <IconClock size={13} />
            {clock}（北京时间）
          </span>
        </div>
      </div>
    </div>
  )
}
