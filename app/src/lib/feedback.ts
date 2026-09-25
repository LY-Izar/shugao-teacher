/* ============================================================
   用户反馈的数据层（2026-09-29 管理台第二期）
   ------------------------------------------------------------
   🔴 三条必须先说清楚的事（都写在 `功能设计与不变量.md` §二十五）：

     ① **先落库、再发信**：服务端插入成功之后才发信；发信失败**不回滚**
        —— 用户看到的"已送到"指的是"已经到管理员那儿了（在库里）"，
        **不是**"已发到邮箱"（那是我们控制不了的事）。所以这里的成功文案
        一个字都不许写"已发送到邮箱"。

     ② **反馈 ≠ 通知**：反馈是**老师对学校**说话（收件人是一个人），
        通知是**学校对老师**说话（收件人是算出来的范围）。两张表、两个接口、
        零复用。这一页上要明写一句"只给管理员看，不会出现在通知里"。

     ③ **不允许匿名提交**：登录不上 / 前端出错走的是**前端错误上报**那条路
        （那个匿名也能报）。所以这里没有"游客"分支，401 就是 401。

   ⚠️ 出参里**只有作者该看的那几个字段**（服务端已经剥过一层，这里再只认那几个）：
     内部字段（`mail_error` / `internal_note` / `handled_by`）**前端根本拿不到**。
   ============================================================ */

import { apiMessage, postApi } from './api'
import { isRemote } from './supabase'

/** 正文：至少 5 个字（与服务端逐字相同） */
export const FEEDBACK_MIN = 5
/** 正文上限 1000 字（服务端**超了直接拒，不静默截断**） */
export const FEEDBACK_MAX = 1000
export const FEEDBACK_CONTACT_MAX = 120
/** 「我提过的」只给最近 5 条 */
export const FEEDBACK_MINE_LIMIT = 5

export type MyFeedback = {
  id: string
  createdAt: number | null
  body: string
  contact: string
  page: string
  /** 只有两个值：`已提交` / `已处理`（**不给处理人、不给内部备注**） */
  status: string
  /** 管理员的可选回复（作者看得到） */
  reply: string
}

export type SubmitResult =
  | { ok: true; id: string; mailOk: boolean; mailReason: string }
  | { ok: false; message: string }

/**
 * 打 `/api/feedback` —— 走 `lib/api.ts` 那一处（**本地模式一个请求都不发**：
 * 没有服务端时发出去只会得到一条 404，脏的是控制台）。
 */
async function post(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  return postApi('/api/feedback', body)
}

/** 前端这一层也拦一次（服务端还会再拦）：< 5 字 / 超 1000 字 */
export function checkBody(text: string): string | null {
  const t = text.trim()
  if (t.length < FEEDBACK_MIN) return `请至少写 ${FEEDBACK_MIN} 个字`
  if (t.length > FEEDBACK_MAX) return `最多 ${FEEDBACK_MAX} 个字（现在 ${t.length} 个）`
  return null
}

/**
 * 提交一条反馈。
 *
 * 出参里 **`mailOk` 只用于管理台/排错**，用户界面上**不许**因为它改变文案：
 * "发信失败"不等于"没送到"（它已经落库了，管理员在面板上看得见）。
 */
export async function submitFeedback(input: {
  body: string
  contact?: string
  page?: string
  authorRoles?: string
}): Promise<SubmitResult> {
  if (!isRemote) {
    return { ok: false, message: '本地演示模式送不出反馈' }
  }
  const bad = checkBody(input.body)
  if (bad) return { ok: false, message: bad }
  if ((input.contact ?? '').length > FEEDBACK_CONTACT_MAX) {
    return { ok: false, message: `联系方式最多 ${FEEDBACK_CONTACT_MAX} 个字` }
  }
  const r = await post({
    action: 'submit',
    body: input.body.trim(),
    contact: (input.contact ?? '').trim(),
    page: (input.page ?? '').slice(0, 120),
    env: 'remote',
    ua: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    authorRoles: (input.authorRoles ?? '').slice(0, 120),
  })
  if (!r.ok) {
    return { ok: false, message: apiMessage(r, `提交失败`) }
  }
  const mail = (r.data.mail ?? {}) as { ok?: boolean; reason?: string }
  return {
    ok: true,
    id: String(r.data.id ?? ''),
    mailOk: mail.ok === true,
    mailReason: String(mail.reason ?? ''),
  }
}

/** 「我提过的」：只有我自己那几条（服务端按 JWT 过滤） */
export async function myFeedback(): Promise<{ ok: true; rows: MyFeedback[] } | { ok: false; message: string }> {
  if (!isRemote) return { ok: true, rows: [] }
  const r = await post({ action: 'mine' })
  if (!r.ok) return { ok: false, message: apiMessage(r, '读不到我提过的反馈') }
  const rows = Array.isArray(r.data.mine) ? (r.data.mine as Array<Record<string, unknown>>) : []
  return {
    ok: true,
    rows: rows.map((x) => ({
      id: String(x.id ?? ''),
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : null,
      body: String(x.body ?? ''),
      contact: String(x.contact ?? ''),
      page: String(x.page ?? ''),
      status: String(x.status ?? '已提交'),
      reply: String(x.reply ?? ''),
    })),
  }
}

/* ---------------- 超管那一半（面板用） ---------------- */

export type AdminFeedbackRow = {
  id: string
  createdAt: number | null
  authorName: string
  authorRoles: string
  body: string
  contact: string
  page: string
  env: string
  handledAt: number | null
  internalNote: string
  reply: string
  mailState: string
  mailError: string
}

export type AdminFeedbackReport = {
  total: number | null
  open: number | null
  /** 🔴 邮件**没发出去**的条数（`pending` / `failed` / `skipped`）—— 面板上必须显式报警 */
  mailBad: number | null
  rows: AdminFeedbackRow[]
  shown: number
  pageMax: number
}

export async function adminListFeedback(
  keyword = '',
): Promise<{ ok: true; report: AdminFeedbackReport } | { ok: false; message: string }> {
  const r = await post({ action: 'admin-list', keyword })
  if (!r.ok) return { ok: false, message: apiMessage(r, '读反馈清单失败') }
  const f = (r.data.feedback ?? {}) as Record<string, unknown>
  const rows = Array.isArray(f.rows) ? (f.rows as Array<Record<string, unknown>>) : []
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    ok: true,
    report: {
      total: num(f.total),
      open: num(f.open),
      mailBad: num(f.mailBad),
      shown: num(f.shown) ?? rows.length,
      pageMax: num(f.pageMax) ?? 200,
      rows: rows.map((x) => ({
        id: String(x.id ?? ''),
        createdAt: x.created_at ? Date.parse(String(x.created_at)) : null,
        authorName: String(x.author_name ?? ''),
        authorRoles: String(x.author_roles ?? ''),
        body: String(x.body ?? ''),
        contact: String(x.contact ?? ''),
        page: String(x.page ?? ''),
        env: String(x.env ?? ''),
        handledAt: x.handled_at ? Date.parse(String(x.handled_at)) : null,
        internalNote: String(x.internal_note ?? ''),
        reply: String(x.reply ?? ''),
        mailState: String(x.mail_state ?? ''),
        mailError: String(x.mail_error ?? ''),
      })),
    },
  }
}

export async function adminSetFeedbackHandled(
  id: string,
  handled: boolean,
  note = '',
  reply = '',
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await post({ action: 'admin-set-handled', id, handled, note, reply })
  if (!r.ok) return { ok: false, message: apiMessage(r, '改反馈状态失败') }
  return { ok: true }
}
