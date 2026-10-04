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
   ============================================================ */

import { useLocation } from 'react-router-dom'
import type { MaintenanceStatus } from './maintenance'
import { shellPlatform, shellRole } from './classroomShell'
import { APP_VERSION } from './version'
import {
  pickReleaseUrl,
  releaseCheck,
  releaseTargetOf,
  releaseTitle,
  type Release,
  type ReleaseCheck,
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
