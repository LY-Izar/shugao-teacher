/* ============================================================
   前端错误上报（2026-09-29 管理台第二期）
   ------------------------------------------------------------
   🔴 这个文件里**每一行都在 try 里**（或走 `safe()`）——
      上报函数自己抛错会再触发一次 `window.onerror` → **递归**。
      参考项目用一个 `_ferSafe()` 包住，这里是同一个东西，名字不同而已。

   🔴 **三条边界**（用户点名 / 方案 §二.4）：
      ① **匿名也能报**：登录页 / 教室端 / `hydrate()` 失败这三个现场**都没有会话**，
         而它们恰恰是最该报上来的三种 → 判据全在服务端（`report_frontend_error()` 里限流）；
      ② **上报本身绝不能抛错**（见上）；
      ③ **不带任何 URL 的 query string / 任何 key**：`view` 只取 `location.pathname`
         （**故意丢掉 search**）—— token / `?roles=` 这类东西就进不了那张"会被一起备份"的表。

   🔴 **它与 `syncError` 的关系**（方案里的那个交界，必须说清楚）：
      `syncError` = **上一次 Supabase 写入失败的原因**（一个字符串槽位、没有时间没有历史）；
      这张表 = **浏览器 JS 异常的时间序列**。
      关系只有一条：上报时**把当时的 `syncError` 抄进 `sync_error` 列**（不改它的形态）。
      它不是"谁看了什么"，也不是 H 组（调用与设备）的替代品 ——
      它是 H4"推送断了但心跳照常"那个症状在**浏览器侧**的采集器。
   ============================================================ */

import { getSupabase, isRemote } from './supabase'
import { useStore } from '../data/store'

/**
 * 长度上限：**与服务端逐字相同**（`schema.sql` §24.2 的 `left(…, N)`）。
 * ⚠️ 前端截断是**省流量**，服务端截断才是**纪律**（不信前端）——
 *    两边都要有，少一边都不算做完（`admin-checks` 两个方向都断言）。
 */
export const ERROR_MSG_MAX = 500
export const ERROR_STACK_MAX = 2000
export const ERROR_UA_MAX = 300
export const ERROR_VIEW_MAX = 120
/** 同一会话总条数上限：崩溃循环里 10 条 fetch 已经足够定位（而且不会拖死一个正在出错的页面） */
export const ERROR_SESSION_MAX = 10
/** 同一条错误文本每会话最多 2 条（"第二条就够定位，第三条是噪音"） */
export const ERROR_SAME_MAX = 2

/** 会话内的计数（**不落盘**：刷新页面就重来，与"本机记性不落库"同一条口径） */
const seen = new Map<string, number>()
let total = 0

/** 把任意一段文本洗成"可以离开这台机器"的样子（query string / token 一律不留） */
export function scrubForReport(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [已隐去]')
    .replace(/\b(sbp_|sk_|re_|eyJ)[A-Za-z0-9._-]{12,}/g, '[已隐去]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[已隐去]')
}

export type ReportInput = {
  message: string
  stack?: string
  view?: string
}

/** 现在这个运行环境（'kiosk' = 教室那块一体机，'web' = 教师端） */
function envOf(): string {
  try {
    return useStore.getState().accountKind === 'classroom' ? 'kiosk' : 'web'
  } catch {
    return 'web'
  }
}

/**
 * 上报一条。
 *
 * 🔴 **它绝不抛错、也绝不返回 Promise**：调用方（`window.onerror` 那个回调）
 *    不该因为上报而改变自己的行为。所有失败静默吞掉（**不做任何 toast**：
 *    用户看到一个"错误上报失败"的提示只会更慌）。
 */
export function reportFrontendError(input: ReportInput): void {
  try {
    /* ---- ① 会话内限流（前端这一层挡的是"崩溃循环把页面拖死"）---- */
    const key = (input.message || '未知错误').slice(0, 200)
    const same = seen.get(key) ?? 0
    if (total >= ERROR_SESSION_MAX || same >= ERROR_SAME_MAX) return
    seen.set(key, same + 1)
    total += 1

    /* ---- ② 本地模式没有服务端：本地报不了（也不该报） ---- */
    if (!isRemote) return
    const sb = getSupabase()
    if (!sb) return

    const s = useStore.getState()
    const args = {
      p_username: (s.teacher?.name ?? '').slice(0, 60),
      /*
       * ⚠️ `role` 填的是**账号类型**（teacher / classroom），**不是 14 档身份标签**。
       *    算身份标签要读角色槽位，而"谁在读那个槽位"是被 `nav-checks` 的 D4
       *    逐文件审计的（每多一处就要说得出理由）。这里不值当多一处 ——
       *    所以这个文件**刻意不碰**角色表。
       */
      p_role: (s.accountKind === 'classroom' ? 'classroom' : 'teacher').slice(0, 40),
      /* ⚠️ 只取 pathname：**故意丢掉 search**（token / ?roles= 就进不了库） */
      p_view: scrubForReport(
        input.view ?? (typeof location === 'undefined' ? '' : location.pathname),
      ).slice(0, ERROR_VIEW_MAX),
      p_message: scrubForReport(input.message || '未知错误').slice(0, ERROR_MSG_MAX),
      p_stack: scrubForReport(input.stack ?? '').slice(0, ERROR_STACK_MAX),
      p_ua: (typeof navigator === 'undefined' ? '' : navigator.userAgent).slice(0, ERROR_UA_MAX),
      p_env: envOf(),
      /* 🔴 与 `syncError` 的唯一关系：把**当时那一句话**抄回来（不改它的形态） */
      p_sync_error: (s.syncError ?? '').slice(0, 300),
    }
    /* `rpc()` 返回的是一个 thenable 的 query builder（不是 Promise）—— 用 Promise.resolve 兜住 */
    void Promise.resolve(sb.rpc('report_frontend_error', args)).then(
      () => undefined,
      () => undefined,
    )
  } catch {
    /* 🔴 静默：上报失败绝不许变成用户的问题（也不能抛回给 window.onerror） */
  }
}

/** 从 `ErrorEvent` / 任意值里抠出 message 与 stack（**认不出就给空串**，不猜） */
export function describeError(e: unknown): { message: string; stack: string } {
  try {
    if (e instanceof Error) return { message: e.message || e.name || '未知错误', stack: e.stack ?? '' }
    if (typeof e === 'string') return { message: e, stack: '' }
    if (e && typeof e === 'object') {
      const o = e as { message?: unknown; stack?: unknown; reason?: unknown }
      const msg = typeof o.message === 'string' ? o.message : ''
      const stack = typeof o.stack === 'string' ? o.stack : ''
      if (msg || stack) return { message: msg || '未知错误', stack }
      if (o.reason !== undefined) return describeError(o.reason)
      try {
        return { message: JSON.stringify(e).slice(0, 200), stack: '' }
      } catch {
        return { message: '未知错误（对象解不开）', stack: '' }
      }
    }
    return { message: String(e ?? '未知错误'), stack: '' }
  } catch {
    return { message: '未知错误（连描述都失败了）', stack: '' }
  }
}

/**
 * 装三个入口（**三处都要**，用户点名）：
 *   ① `window.onerror`  → 同步脚本错误
 *   ② `unhandledrejection` → 没接住的 Promise（本项目最常见的一种：
 *      "推送断了但心跳照常"在浏览器侧常常就是一批这个）
 *   ③ React `ErrorBoundary` → 渲染期抛错（在 `components/ErrorBoundary.tsx`）
 *
 * 返回一个卸载函数（测试与 HMR 用；正常运行时不需要调）。
 */
export function installErrorReporting(): () => void {
  if (typeof window === 'undefined') return () => undefined

  const onError = (ev: ErrorEvent) => {
    /* ⚠️ `ev.error` 可能为 null（跨域脚本）—— 那时用 `ev.message` */
    const d = describeError(ev.error ?? ev.message)
    reportFrontendError({
      message: d.message,
      stack: d.stack || `${ev.filename ?? ''}:${ev.lineno ?? 0}:${ev.colno ?? 0}`,
    })
  }
  const onReject = (ev: PromiseRejectionEvent) => {
    const d = describeError(ev.reason)
    reportFrontendError({ message: `[未处理的 Promise] ${d.message}`, stack: d.stack })
  }

  try {
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onReject)
  } catch {
    return () => undefined
  }
  return () => {
    try {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onReject)
    } catch {
      /* 忽略 */
    }
  }
}

/** 测试/排错用：看这一会儿一共报了多少条（**不落盘**） */
export function reportCounters(): { total: number; kinds: number } {
  return { total, kinds: seen.size }
}
