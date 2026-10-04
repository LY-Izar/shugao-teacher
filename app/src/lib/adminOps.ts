/* ============================================================
   管理台第二期：**服务端交互**（数据库用量 / 错误日志 / 发信）
   ------------------------------------------------------------
   分层与第一期一致：**判据与阈值在 `adminChart.ts`（纯函数）、渲染在 `Admin.tsx`**，
   这个文件只负责"打接口 + 把回话的形状掰正"。

   🔴 这里**一个阈值都没有**：DB 配额（1 GB）与三档线在 `adminChart.ts`；
     错误条的黄红线也在那里。一个常量只能有一处。
   ============================================================ */

import { apiMessage, postApi } from './api'
import type { DbArchiveFact, DbTableFact } from './adminChart'

/* ---------------- ① 数据库用量（`/api/admin/config-check` 的 `db` 动作） ---------------- */

export type DbReport = {
  configured: boolean
  totalBytes: number | null
  tables: DbTableFact[]
  questionMetaBytes: number | null
  archives: DbArchiveFact[]
  unknownReason: string | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 读数据库用量。
 * ⚠️ 回话形状与 `functions/api/admin/config-check.ts` 的 `dbReport()` 一一对应；
 *    **服务端只量数、不判色**（配额在 `adminChart.ts`）——
 *    `admin-checks` 有一条反向断言：服务端回话里**不许**出现 `quotaBytes`。
 */
export async function fetchDbUsage(): Promise<{ ok: true; report: DbReport } | { ok: false; message: string }> {
  const r = await postApi('/api/admin/config-check', { action: 'db' })
  if (!r.ok) return { ok: false, message: apiMessage(r, '读数据库用量失败') }
  const d = (r.data.db ?? {}) as Record<string, unknown>
  const tables = Array.isArray(d.tables) ? (d.tables as Array<Record<string, unknown>>) : []
  const archives = Array.isArray(d.archives) ? (d.archives as Array<Record<string, unknown>>) : []
  return {
    ok: true,
    report: {
      configured: d.configured === true,
      totalBytes: num(d.totalBytes),
      questionMetaBytes: num(d.questionMetaBytes),
      unknownReason: typeof d.unknownReason === 'string' ? d.unknownReason : null,
      tables: tables.map((t) => ({
        name: String(t.name ?? ''),
        bytes: num(t.bytes) ?? 0,
        rowsEstimate: num(t.rowsEstimate),
      })),
      archives: archives.map((a) => ({
        assignmentId: String(a.assignmentId ?? ''),
        className: String(a.className ?? ''),
        bytes: num(a.bytes) ?? 0,
      })),
    },
  }
}

/* ---------------- ② 前端错误日志（`/api/admin/errors`） ---------------- */

export type AdminErrorRow = {
  id: string
  at: number | null
  username: string
  role: string
  view: string
  message: string
  stack: string
  ua: string
  env: string
  syncError: string
  hasPii: boolean
}

export type ErrorsReport = {
  total: number | null
  last24h: number | null
  rows: AdminErrorRow[]
  shown: number
  pageMax: number
}

export async function adminListErrors(
  keyword = '',
): Promise<{ ok: true; report: ErrorsReport } | { ok: false; message: string }> {
  const r = await postApi('/api/admin/errors', { action: 'list', keyword })
  if (!r.ok) return { ok: false, message: apiMessage(r, '读错误日志失败') }
  const e = (r.data.errors ?? {}) as Record<string, unknown>
  const rows = Array.isArray(e.rows) ? (e.rows as Array<Record<string, unknown>>) : []
  return {
    ok: true,
    report: {
      total: num(e.total),
      last24h: num(e.last24h),
      shown: num(e.shown) ?? rows.length,
      pageMax: num(e.pageMax) ?? 200,
      rows: rows.map((x) => ({
        id: String(x.id ?? ''),
        at: x.ts ? Date.parse(String(x.ts)) : null,
        username: String(x.username ?? ''),
        role: String(x.role ?? ''),
        view: String(x.view ?? ''),
        message: String(x.message ?? ''),
        stack: String(x.stack ?? ''),
        ua: String(x.ua ?? ''),
        env: String(x.env ?? ''),
        syncError: String(x.sync_error ?? ''),
        hasPii: x.has_pii === true,
      })),
    },
  }
}

/** 删除：按 id（"全选本页"选中的那些）**或**按截止日期。两者都不给 → 服务端 400 */
export async function adminDeleteErrors(input: {
  ids?: string[]
  before?: number | null
}): Promise<{ ok: true; deleted: number } | { ok: false; message: string }> {
  const r = await postApi('/api/admin/errors', {
    action: 'delete',
    ...(input.ids?.length ? { ids: input.ids } : {}),
    ...(input.before ? { before: input.before } : {}),
  })
  if (!r.ok) return { ok: false, message: apiMessage(r, '删除失败') }
  return { ok: true, deleted: num(r.data.deleted) ?? 0 }
}

/* ---------------- ③ 维护模式（写出口） ---------------- */

export type SetMaintenanceInput = {
  enabled: boolean
  message: string
  hours: number
  scheduled: boolean
  fromMs: number | null
  toMs: number | null
  confirm: string
}

export async function setMaintenance(
  input: SetMaintenanceInput,
): Promise<
  | { ok: true; effective: boolean; text: string; downgraded: boolean; until: number | null }
  | { ok: false; message: string; rule?: string }
> {
  const r = await postApi('/api/admin/maintenance', { action: 'set', ...input })
  if (!r.ok) {
    return {
      ok: false,
      message: apiMessage(r, '开关维护模式失败'),
      rule: typeof r.data.rule === 'string' ? r.data.rule : undefined,
    }
  }
  const m = (r.data.maintenance ?? {}) as Record<string, unknown>
  return {
    ok: true,
    effective: m.effective === true,
    text: String(m.text ?? ''),
    downgraded: r.data.downgraded === true,
    until: typeof m.untilIso === 'string' ? Date.parse(m.untilIso) : null,
  }
}

/* ---------------- ⑤ 版本更新公告（`/api/admin/release`，2026-10-04） ---------------- */

/**
 * 面板要的那一档。
 * ⚠️ 形状与 `functions/api/admin/release.ts` 的 `adminSlot()` 一一对应：
 *    · `note` / `version` / `urlApk` / `urlExe` 是**预填**用的（连没发布的草稿也回）；
 *    · `live` 是**服务端算好的、外面真正看到的那一份**（`null` = 没在发）——
 *      面板上的预览必须用它，**不许前端自己拼**（否则"面板显示的和外面看到的"会分叉）。
 *    · `present` = 那一行在不在（不在 = §23.2.1 的两行种子没跑）。
 */
export type AdminReleaseSlot = {
  present: boolean
  enabled: boolean
  version: string
  force: boolean
  note: string
  urlApk: string
  urlExe: string
  /** 服务端算好的那一份（`null` = 没在发） */
  live: Record<string, unknown> | null
  updatedAt: number | null
  updatedBy: string | null
}

function toSlot(v: unknown): AdminReleaseSlot {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const ms = (x: unknown) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null)
  return {
    present: s.present === true,
    enabled: s.enabled === true,
    version: String(s.version ?? ''),
    force: s.force === true,
    note: String(s.note ?? ''),
    urlApk: String(s.urlApk ?? ''),
    urlExe: String(s.urlExe ?? ''),
    live: s.live && typeof s.live === 'object' ? (s.live as Record<string, unknown>) : null,
    updatedAt: ms(s.updatedAt),
    updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy : null,
  }
}

/** 读两档（教师端 / 教室端）—— 含没发布的草稿，面板用它预填 */
export async function fetchReleaseState(): Promise<
  { ok: true; teacher: AdminReleaseSlot; classroom: AdminReleaseSlot } | { ok: false; message: string }
> {
  const r = await postApi('/api/admin/release', { action: 'state' })
  if (!r.ok) return { ok: false, message: apiMessage(r, '读版本更新状态失败') }
  const rel = (r.data.release ?? {}) as Record<string, unknown>
  return { ok: true, teacher: toSlot(rel.teacher), classroom: toSlot(rel.classroom) }
}

/** 发布 / 撤下**一档**（一次发布只动一档：给教师端发强制，教室端不受影响） */
export async function setRelease(input: {
  target: 'teacher' | 'classroom'
  enabled: boolean
  version: string
  force: boolean
  note: string
  urlApk: string
  urlExe: string
}): Promise<{ ok: true; slot: AdminReleaseSlot } | { ok: false; message: string; rule?: string }> {
  const r = await postApi('/api/admin/release', { action: 'set', ...input })
  if (!r.ok) {
    return {
      ok: false,
      message: apiMessage(r, '发布版本更新公告失败'),
      rule: typeof r.data.rule === 'string' ? r.data.rule : undefined,
    }
  }
  const rel = (r.data.release ?? {}) as Record<string, unknown>
  return { ok: true, slot: toSlot(rel[input.target]) }
}

/* ---------------- ④ 发信（`/api/mail`） ---------------- */

export async function sendTestMail(): Promise<{ ok: true; to: string } | { ok: false; message: string }> {
  const r = await postApi('/api/mail', { action: 'test' })
  if (!r.ok) return { ok: false, message: apiMessage(r, '发测试邮件失败') }
  return { ok: true, to: String(r.data.to ?? '') }
}

/**
 * 备份完成通知 —— **"备份→发信→发不出去就不许删"那条链的中间一环**。
 * ⚠️ 调用方拿到 `ok:false` 时**必须**把话说出来（那条链上的人要知道"没人通知到"）。
 */
export async function sendBackupMail(
  summary: string,
  detail = '',
): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await postApi('/api/mail', { action: 'backup', summary, detail })
  if (!r.ok) return { ok: false, message: apiMessage(r, '发备份通知失败') }
  return { ok: true }
}
