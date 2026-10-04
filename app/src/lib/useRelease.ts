/* ============================================================
   版本更新公告的**读取钩子** —— 2026-10-04，施工单 `施工单-版本更新提示.md` §二.4
   ------------------------------------------------------------
   🔴 **它自己不取数**（施工单原话：「与维护共用同一次请求，不许再开一个轮询」）：
      两档公告跟着 `GET /api/status` 一起回来（`useMaintenanceStatus()` 那一次取数），
      这里只做三件纯计算：
        · 我这一台是**哪一档**（`releaseTargetOf`，判据只有一处）；
        · 我这一版**够不够新**（`releaseCheck`，三态：够新 / 落后 / 没结论）；
        · 「下载最新版」该点**哪条链接**（`pickReleaseUrl`，按壳分端）。
   ⚠️ 所以它是个"从已经拿到的状态里挑一份视图"的钩子 —— 名字带 `use` 是因为它读
      `useLocation()`（路由变了要重新判），**它没有 effect、没有定时器、不发请求**。

   🆕 2026-10-04（用户当天「我的」页三处改动的第 ① 条）：「我的 → 关于」还要三颗
      **下载按钮**（教师端 安卓 / 教师端 Windows / 教室端 Windows），
      而这三条链接就是面板里填的那两行。⇒ 这里多一个 `ReleaseSlotsContext`：
      **`ReleaseGate` 把手上那一次 `/api/status` 取数的 `status.release` 放进去**，
      「我的」页用 `useReleaseSlots()` 读它。
      🔴 这就是"复用现有的取数机制"的落地 —— 那一页**不许**再调 `useMaintenanceStatus()`、
         也不许自己 `fetch('/api/status')`（`nav-checks` 的 D18 钉着"只有一个轮询者"）。
      ⚠️ 默认值是 `RELEASE_SLOTS_UNKNOWN`：**没有 Provider 时一颗按钮都不出现**
         （宁可不摆，也不摆一颗点了没反应的死按钮）。
   ============================================================ */

import { createContext, useContext } from 'react'
import { useLocation } from 'react-router-dom'
import type { MaintenanceStatus } from './maintenance'
import { shellPlatform, shellRole } from './classroomShell'
import { APP_VERSION } from './version'
import {
  RELEASE_SLOTS_UNKNOWN,
  pickReleaseUrl,
  releaseCheck,
  releaseTargetOf,
  releaseTitle,
  type Release,
  type ReleaseCheck,
  type ReleaseSlots,
  type ReleaseTarget,
} from './release'

export type ReleaseView = {
  /** 我这一台属于哪一档（教师端 / 教室端） */
  target: ReleaseTarget
  /** 这一档正在发的公告（`null` = 没有） */
  notice: Release | null
  /**
   * 我这一版的处境：
   *  · `behind`     —— **要提示**；
   *  · `uptodate`   —— 真·已是最新；
   *  · `none`       —— 这一档没发公告；
   *  · `notnew` / `unreadable` —— **没结论**（不提示，但**不许**说成"已是最新"）。
   */
  check: ReleaseCheck
  /** 「下载最新版」点出去的那条链接（空串 = 这一端没链接 ⇒ 不给按钮） */
  url: string
  /** 标题（按 `force` 选一句；没有公告时是空串） */
  title: string
  /**
   * 🔴 **能不能关掉，只认服务端给的那一位 `force`**（施工单 §四：不许做成前端可改的）。
   *    客户端只决定"关掉之后这一次还显不显示"，**不决定**"是不是强制"。
   */
  canClose: boolean
}

export function useRelease(status: MaintenanceStatus): ReleaseView {
  const loc = useLocation()
  const target = releaseTargetOf(shellRole(), loc.pathname)
  const notice = status.release[target]
  const check = releaseCheck(status.release, target, APP_VERSION)
  return {
    target,
    notice,
    check,
    url: notice ? pickReleaseUrl(notice, shellPlatform()) : '',
    title: notice ? releaseTitle(notice.force) : '',
    canClose: notice ? !notice.force : true,
  }
}

/**
 * 手上那一次 `/api/status` 取数里的**两档链接**（`ReleaseGate` 放进来的）。
 *
 * 🔴 它是**同一个 Provider 的值**，不是第二次取数 —— `ReleaseGate` 那一个
 *    `<ReleaseSlotsContext.Provider value={status.release}>` 就是全部来源，
 *    而 `status` 来自 `MaintenanceGate` 里唯一那次 `useMaintenanceStatus()`。
 * ⚠️ 没有 Provider 时给的是 `RELEASE_SLOTS_UNKNOWN`（两档都 `null`、`read:'missing'`）
 *    ⇒ 读它的人自然摆不出任何链接，不会摆出死按钮。
 */
export const ReleaseSlotsContext = createContext<ReleaseSlots>(RELEASE_SLOTS_UNKNOWN)

/** 读两档链接（「我的 → 关于」那三颗下载按钮用的就是它） */
export function useReleaseSlots(): ReleaseSlots {
  return useContext(ReleaseSlotsContext)
}
