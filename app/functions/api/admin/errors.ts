/**
 * `POST /api/admin/errors` —— **前端错误日志的超管读 / 删**（2026-09-29 管理台第二期）。
 *
 * 设计见 `管理台第二期方案.md` §二.4 · 落地口径见 `功能设计与不变量.md` §二十五。
 *
 * 🔴 **上报走的是另一条路**：`report_frontend_error()`（`schema.sql` §24.2，RPC，
 *    **匿名可调**）。这个文件只管"**谁能看、谁能删**"—— 而那是**只有超管**。
 *    两条路共用同一张表，但**判据完全不同**（一个是"谁都能写"，一个是"只有超管能读"）。
 *
 * 🔴 **删除是不可逆的，所以有两道**：
 *    ① 前端 `confirm`（体验层）；
 *    ② **服务端再判一次**：按截止日期清理时，`before` 必须**早于此刻**
 *       （参考项目的原话是 `raise exception '截止时间必须早于当前时间'`）。
 *    ③ 删完**写操作留痕**（`admin_audit`：谁、删了几条、删的是 id 还是截止日期）。
 *
 * 🔴 **隐私（B 类，可能升到 C）**：读出来的是 `message` / `stack` 原文 ——
 *    里面**可能夹到学生姓名**。所以：
 *    · 这个接口**只给超管**（判据在数据库）；
 *    · 界面上复用第一期的 `PrivacyLine`（"请勿投屏或截图"）；
 *    · `has_pii` 是**启发式**标记（`schema.sql` §24.2 那四条窄判据），
 *      界面**不许**写成"已脱敏"。
 *
 * 环境变量：同 `_lib/supa.ts`
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  anonKey,
  audit,
  baseUrl,
  caller,
  countRows,
  isMissing,
  json,
  needStage,
  read,
  rpcBool,
  serviceKey,
  svc,
} from '../_lib/supa'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'
const NEED_STAGE24 = needStage('24', '前端错误日志')

/** 一页最多给多少条（"全选本页"只选这一页 —— 照参考项目，**不许扩成"全选全部"**） */
const PAGE_MAX = 200

type Body = {
  action?: 'list' | 'delete'
  /** list：关键字（同时匹 username 与 message） */
  keyword?: string
  /** delete：按 id 删（这一页勾中的那些） */
  ids?: Array<number | string>
  /** delete：按截止日期清理（毫秒时间戳或 ISO 串） */
  before?: number | string
}

const idList = (ids: Array<number | string> | undefined): string[] =>
  (ids ?? [])
    .map((v) => String(v).trim())
    .filter((v) => /^\d{1,18}$/.test(v))
    .slice(0, PAGE_MAX)

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!baseUrl(env) || !anonKey(env)) return json({ status: 'error', message: NEED_SUPABASE }, 503)
  if (!serviceKey(env)) return json({ status: 'error', message: NEED_SERVICE_KEY }, 503)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  const action = body.action ?? 'list'

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /* 🔴 判据在数据库：只有超管（与第一期 T7 同一条） */
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!isSuper) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员能看前端错误日志。它里面**可能夹到学生姓名**（老师自己写的错误文案），' +
          '所以教务处 / 年级主任 / 班主任都不在这一档。',
      },
      403,
    )
  }

  /* ---------------- list：计数 + 关键字筛选 ---------------- */
  if (action === 'list') {
    const keyword = String(body.keyword ?? '').trim().slice(0, 80)
    /*
     * ⚠️ 关键字的 `ilike` 是**服务端拼进 URL** 的 —— 必须编码，且**不允许**出现
     *    任何 PostgREST 的语法字符（`,` `(` `)` `*`）：手打接口的人不能靠关键字
     *    注入出别的过滤条件。所以这里只留"普通字符 + 中文"。
     */
    const safe = keyword.replace(/[^\p{L}\p{N}\s._@-]/gu, ' ').trim()
    const filter = safe
      ? `&or=(username.ilike.*${encodeURIComponent(safe)}*,message.ilike.*${encodeURIComponent(safe)}*)`
      : ''

    let res
    try {
      res = await read(
        await svc(
          env,
          `/rest/v1/frontend_errors?select=*&order=ts.desc&limit=${PAGE_MAX}${filter}`,
        ),
      )
    } catch (e) {
      return json(
        { status: 'error', message: `读错误日志失败：${e instanceof Error ? e.message : String(e)}` },
        502,
      )
    }
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE24 : '读错误日志失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }

    const since = new Date(Date.now() - 86_400_000).toISOString()
    const total = await countRows(env, '/rest/v1/frontend_errors?select=id')
    const last24h = await countRows(
      env,
      `/rest/v1/frontend_errors?select=id&ts=gt.${encodeURIComponent(since)}`,
    )
    /* ⚠️ 这两个计数**读不到就是 null**（面板显示"无法判断"），**不许当 0** */
    return json({
      status: 'ok',
      errors: {
        total,
        last24h,
        rows: res.rows,
        keyword: safe,
        pageMax: PAGE_MAX,
        /** 命中条数可能多于这一页（界面要说明"这是最近 200 条里的 N 条"） */
        shown: res.rows.length,
      },
    })
  }

  /* ---------------- delete：按 id / 按截止日期（**写留痕**） ---------------- */
  if (action === 'delete') {
    const ids = idList(body.ids)
    const rawBefore = body.before
    let beforeIso: string | null = null
    if (rawBefore !== undefined && rawBefore !== null && rawBefore !== '') {
      const t = typeof rawBefore === 'number' ? rawBefore : Date.parse(String(rawBefore))
      if (!Number.isFinite(t)) return json({ status: 'error', message: '截止日期看不懂（要一个时间）' }, 400)
      /* 🔴 服务端再判一次：截止时间必须早于此刻（否则就是在删"刚发生的事"） */
      if (t >= Date.now()) {
        return json(
          { status: 'error', message: '截止时间必须早于当前时间 —— 否则会连刚发生的那几条一起删掉' },
          400,
        )
      }
      beforeIso = new Date(t).toISOString()
    }

    if (ids.length === 0 && beforeIso === null) {
      return json({ status: 'error', message: '没有勾选任何一条，也没有填截止日期' }, 400)
    }

    const query =
      ids.length > 0
        ? `/rest/v1/frontend_errors?id=in.(${ids.join(',')})`
        : `/rest/v1/frontend_errors?ts=lt.${encodeURIComponent(beforeIso as string)}`

    let res
    try {
      res = await read(
        await svc(env, query, {
          method: 'DELETE',
          headers: { Prefer: 'return=representation' },
        }),
      )
    } catch (e) {
      return json(
        { status: 'error', message: `删除失败：${e instanceof Error ? e.message : String(e)}` },
        502,
      )
    }
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE24 : '删除失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }

    const affected = res.rows.length
    const audited = await audit(env, {
      actorId: me.id,
      action: 'errors.delete',
      target: ids.length > 0 ? `ids:${ids.length}` : `before:${beforeIso}`,
      detail: ids.length > 0 ? `按 id 删了 ${affected} 条` : `清理了 ${beforeIso} 之前的 ${affected} 条`,
      affected,
    })
    return json({ status: 'ok', deleted: affected, audited })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/** GET 自述（只为了区分"没部署"与"权限不够"） */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/admin/errors',
    method: 'POST',
    body: { action: 'list | delete' },
    note: '需要登录，且判据是数据库的 is_super_admin()；上报走的是 report_frontend_error()（匿名可调）',
  })
}
