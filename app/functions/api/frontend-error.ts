/**
 * `POST /api/frontend-error` —— 前端报错**落库 + 给管理员发一封提醒信**（2026-10-29）。
 *
 * 为什么需要它（而不是把发信塞进 `report_frontend_error()`）：
 *   · `report_frontend_error()` 是**匿名可调**的 RPC（登录页 / 教室端 / hydrate 失败
 *     三个现场都没有会话），它只负责"落库 + 截断 + 洗一遍"；
 *   · 发信要拿**服务角色**、要读配额、要留痕 —— 那是 `sendAuditedMail()` 那一层的事；
 *   · 这个端点只给**已登录**的人用：`caller()` 拿不到人就 401（匿名现场照旧走 RPC 落库，
 *     只是不会发信 —— 这是有意的：邮箱不是登录页的兜底通道）。
 *
 * 🔴 **落库是权威，发信只是提醒**：
 *   即使邮件没发出去（没配 `RESEND_API_KEY` / 没配 `ADMIN_NOTIFY_EMAIL` / 被隐私判据拦下），
 *   这条报错也已经在 `frontend_errors` 里了。所以发信失败**不许回 5xx**，
 *   回 200 + `mail.reason` 那一句人话（沿用 `sendAuditedMail` 的 `reason`）。
 *
 * 🔴 **节流：同一个"报错原文前 80 字"在 30 分钟内只发一封**。
 *   实现选的是「**发成功后往 `admin_audit` 写一行标记，发之前按签名查最近 30 分钟**」：
 *     · 为什么不用 `frontend_errors` 自己当标记：那张表**没有"发过信"这一列**，
 *       为一个布尔位加列要改 schema + RLS + 门禁；而且"报过错"并不等于"信发出去过"。
 *     · 为什么标记的 `action` 是 `frontendError.mail`（**故意不以 `mail.` 开头**）：
 *       `admin_audit` 里 `action like 'mail.*'` 会被 `mailedInLastDay()` 数成**邮件配额**。
 *       用 `mail.frontendError` 再写一行标记 = 每封信算两封，90 封/天的上限会腰斩。
 *     · 为什么**只在发送成功之后**写标记：发不出去时下一次报错还会再试，
 *       不会因为一次"没配 key"就静默 30 分钟。
 *     · 标记写失败 / 查不到：**放行**（fail-open）—— 宁可多收一封信，
 *       也不要把"没人知道"做成常态；与 `mailedInLastDay()` 读不到时放行同一条思路。
 *   ⚠️ 并发两个一模一样的报错可能各发一封（两次查询都没看到对方）——
 *      这个窗口是**有意的**：它比"因为一次竞争就永远不发"安全。
 *
 * ============================================================
 * 请求 / 回话
 * ============================================================
 *   POST `/api/frontend-error`
 *   `{ page, message, stack?, browser, at }`
 *     · `page`    —— 只该是 `location.pathname`（**不许带 query string**）；
 *     · `message` —— 报错原文（服务端会再洗一遍、再截断，不信前端）；
 *     · `stack`   —— 可选；
 *     · `browser` —— `navigator.userAgent`；
 *     · `at`      —— 报错发生时刻（ISO 字符串；偏差超过 24 小时就不采信，用落库时间）。
 *
 *   200 `{ ok: true, id, stored, mail: { sent, reason?, message? } }`
 *   400 `{ ok: false, message }`      请求体不对
 *   401 `{ ok: false, message }`      没有会话（这个端点不接匿名）
 *   503 `{ ok: false, message }`      服务端没配好 / 数据库还没建那张表
 *   502 `{ ok: false, message }`      写库失败（**这一条才是真正的失败**）
 *
 * 字段与长度上限照 `supabase/schema.sql` §24.1 / §24.2 那张表来（逐字相同，别猜）。
 */

import {
  type Env,
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  anonKey,
  audit,
  baseUrl,
  caller,
  isMissing,
  json,
  read,
  serviceKey,
  svc,
} from './_lib/supa'
import { SYSTEM_MAIL_BODIES, beijingStamp, sendAuditedMail } from './_lib/mail'
import { logIssue } from './_lib/log'

/** 长度上限：与 `frontend_errors` 的列注释 / `report_frontend_error()` 的 `left(…, N)` 相同 */
const VIEW_MAX = 120
const MSG_MAX = 500
const STACK_MAX = 2000
const UA_MAX = 300
const ENV_MAX = 20
/** 节流签名：报错原文前 80 字 */
const SIG_MAX = 80
/** 同一个签名 30 分钟内只发一封 */
const THROTTLE_MS = 30 * 60_000
/**
 * 节流标记的 `admin_audit.action`。
 * 🔴 **故意不以 `mail.` 开头**：那一串会被 `mailedInLastDay()` 数成邮件配额（见文件头）。
 */
const MARK_ACTION = 'frontendError.mail'

type Body = {
  page?: unknown
  message?: unknown
  stack?: unknown
  browser?: unknown
  at?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 洗一遍：URL 的 query string / 凭据痕迹 / 学生与教师档案的 PII 值。
 * ⚠️ 与 `src/lib/errors.ts` 的 `scrubForReport()`、`report_frontend_error()`（§24.2 ⑤）
 *    **同源**；这里再洗一次是因为这一步走的是 service_role，**绕过了 RPC 里那道**。
 *    （前端那道只管"少发点流量"，服务端这道才是纪律。）
 */
function scrub(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [已隐去]')
    .replace(/\b(sbp_|sk_|re_|eyJ)[A-Za-z0-9._-]{12,}/g, '[已隐去]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[已隐去]')
    /* 学生档案那四个字段 + 教师住址（带标注的写法）—— 与 §24.2 ⑤ 逐条相同 */
    .replace(
      /(家长电话|监护人电话|联系电话|手机号|家庭住址|现住址|住址|出生年月|出生日期|民族)\s*[:：]\s*[^\s,，;；|]+/g,
      '$1：[已隐去]',
    )
    /* 家长 / 老师电话最常见的形状：11 位手机号 */
    .replace(/\b1[3-9]\d{9}\b/g, '[已隐去]')
    /* 教师档案的邮箱：只抹 `@` 之后那一段域名 */
    .replace(/(@)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '$1[已隐去]')
}

/**
 * `has_pii` 的**窄启发式**：与 `report_frontend_error()` §24.2 ④ 同一组判据。
 * ⚠️ 它会有漏、也可能误标 —— 管理台上必须写明"启发式"，不许写成"已脱敏"。
 * ⚠️ 必须在 `scrub()` **之前**算（洗完值就没了，之后再算永远为假）。
 */
function looksLikePii(raw: string): boolean {
  return (
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(raw) ||
    /[0-9]{15,}/.test(raw) ||
    /(家长电话|监护人电话|联系电话|手机号|家庭住址|现住址|住址|出生年月|出生日期|民族)\s*[:：]/.test(raw) ||
    /\b1[3-9]\d{9}\b/.test(raw)
  )
}

/** 只接受"看起来是这台机器刚刚发生的"时刻；偏差太大就当成没有，用落库时间 */
function parseAt(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  if (Math.abs(Date.now() - ms) > 24 * 3600_000) return null
  return new Date(ms).toISOString()
}

/**
 * 报错原文前 80 字的**稳定短签名**（FNV-1a 32 位）。
 * 不存原文：`admin_audit.target` 只有 120 字，而且那张流水不该多一份报错正文。
 * ⚠️ 32 位、非加密：这里防的是"同一句报错连打"，不是敌手构造碰撞。
 */
function signatureHash(signature: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < signature.length; i++) {
    h ^= signature.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 最近 30 分钟是否已经为这个签名发过一封（读不到 = 放行，见文件头） */
async function mailedRecently(env: Env, hash: string): Promise<boolean> {
  const since = new Date(Date.now() - THROTTLE_MS).toISOString()
  const path =
    `/rest/v1/admin_audit?select=target&action=eq.${encodeURIComponent(MARK_ACTION)}` +
    `&at=gt.${encodeURIComponent(since)}` +
    `&target=like.${encodeURIComponent(`*sig:${hash}*`)}`
  const res = await read(await svc(env, path))
  if (!res.ok) return false
  return res.rows.length > 0
}

/** 发成功之后写标记（写失败只放行，不把已成功的发信变成失败） */
async function markMailed(env: Env, actorId: string, actorName: string, hash: string): Promise<void> {
  await audit(env, {
    actorId,
    actorName,
    action: MARK_ACTION,
    target: `sig:${hash}`,
    detail: '已发提醒（同一报错 30 分钟内只发一封）',
    affected: 1,
  })
}

/**
 * 入口：**兜住一切没预料到的抛出**（连不上数据库、上游 `fetch` 直接 reject）。
 *
 * 🔴 这个端点自己就在错误路径上：它要是回一个 500 裸错，前端那条 `.catch` 只会看到
 *    "有一坨 500"，既不落库也没有一句能照着排查的话。所以这里统一翻成
 *    `502 { ok:false, message }` + 一条 `logIssue`（参数 / 这意味着 / 下一步）。
 */
export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  try {
    return await handle(context)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    logIssue(
      'frontend-error',
      '前端报错没有存进数据库',
      { reason: 'thrown', error: why.slice(0, 200) },
      '这条报错既没有落库，也没有发信 —— 这是真正需要处理的一次失败，不是通知慢了一步',
      '看 /admin 的「错误日志」；再查 Supabase 的项目状态与 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
    )
    return json({ ok: false, message: '这条报错没有送达服务端，请稍后再试', detail: why.slice(0, 200) }, 502)
  }
}

async function handle(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!serviceKey(env)) return json({ ok: false, message: NEED_SERVICE_KEY }, 503)
  if (!baseUrl(env) || !anonKey(env)) return json({ ok: false, message: NEED_SUPABASE }, 503)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ ok: false, message: '请求格式不对' }, 400)
  }

  /* ---- ① 这条报错是谁报的？（拿不到会话就 401，不接匿名）---- */
  const me = await caller(request, env)
  if (!me) return json({ ok: false, message: '登录已过期，请重新登录后再试' }, 401)

  const page = text(body.page).slice(0, VIEW_MAX)
  /*
   * ⚠️ **先截断再判 PII / 洗**（与 §24.2 的 `left(…, N)` 同序）：不信前端 ——
   *    一个几 MB 的 `stack` 会让下面几条正则在大字符串上跑。
   */
  const rawMessage = text(body.message).trim().slice(0, MSG_MAX)
  const rawStack = text(body.stack).slice(0, STACK_MAX)
  if (!rawMessage) return json({ ok: false, message: '没有报错内容' }, 400)

  /* 先判 `has_pii`（原文），再洗、再截断 —— 顺序与 §24.2 ④⑤ 相同 */
  const pii = looksLikePii(rawMessage + ' ' + rawStack)
  const message = scrub(rawMessage).slice(0, MSG_MAX)
  const stack = scrub(rawStack).slice(0, STACK_MAX)
  const browser = text(body.browser).slice(0, UA_MAX)

  /* ---- ② 这个人是教师端还是教室端？（只影响落库的两个快照列 + 邮件里的一句人话）---- */
  const nameRes = await read(
    await svc(env, `/rest/v1/teachers?select=name&id=eq.${encodeURIComponent(me.id)}`),
  )
  const username = nameRes.ok ? String(nameRes.rows[0]?.name ?? '').slice(0, 60) : ''
  const roomRes = await read(
    await svc(env, `/rest/v1/classroom_accounts?select=id&id=eq.${encodeURIComponent(me.id)}`),
  )
  const isKiosk = roomRes.ok && roomRes.rows.length > 0
  const role = (isKiosk ? 'classroom' : 'teacher').slice(0, 40)
  const envName = (isKiosk ? 'kiosk' : 'web').slice(0, ENV_MAX)

  /* ---- ③ 落库（权威）---- */
  const at = parseAt(body.at)
  const row: Record<string, unknown> = {
    account_id: me.id,
    username,
    role,
    view: page,
    message,
    stack,
    ua: browser,
    env: envName,
    sync_error: '',
    has_pii: pii,
  }
  /* `ts` 有默认值 now()；只有客户端时刻可信时才覆盖它 */
  if (at) row.ts = at

  const ins = await read(
    await svc(env, '/rest/v1/frontend_errors', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    }),
  )
  if (!ins.ok) {
    return json(
      {
        ok: false,
        message: isMissing(ins)
          ? '数据库还没有前端错误日志表。到 Supabase → SQL Editor 跑一遍仓库里的 supabase/schema.sql（第 24 段），再回来重试。'
          : '这条报错没有存进数据库，请稍后再试',
        detail: ins.text.slice(0, 200),
      },
      isMissing(ins) ? 503 : 502,
    )
  }
  /*
   * ⚠️ 落库成功但 `rows` 为空是**正常的**：§43.3 的 `frontend_errors_gate` 会把
   *    "同一个人 + 同一页面 + 同一句话"在 60 秒内的重复行**静默丢掉**（返回 null）。
   *    这一条仍然值得发信（30 分钟节流会兜住），所以不把它当失败。
   */
  const stored = ins.rows.length > 0
  const id = stored ? (ins.rows[0].id ?? null) : null

  /* ---- ④ 发提醒信（非权威；失败只回人话原因，绝不 5xx）---- */
  const signature = message.slice(0, SIG_MAX)
  const hash = signatureHash(signature)

  if (await mailedRecently(env, hash)) {
    return json({
      ok: true,
      id,
      stored,
      mail: { sent: false, reason: 'throttled', message: '同一报错 30 分钟内只发一封邮件' },
    })
  }

  try {
    const mail = await sendAuditedMail(env, {
      action: 'mail.frontendError',
      subject: `【树高教务通】前端报错 · ${page || '(页面未提供)'} · ${beijingStamp()}`,
      /*
       * 正文在 `SYSTEM_MAIL_BODIES.frontendError`（唯一一处构造；`admin-checks` ⑤
       * 会逐条喂给 `looksLikeStudentData()` 体检）。
       * ⚠️ 模板收的是**一份合并后的清单**（`count` + `items[]`）：这个端点一次只报一条，
       *    所以 `count: 1`、`items` 只有这一条；30 分钟节流保证同一条报错不会刷屏。
       */
      doc: SYSTEM_MAIL_BODIES.frontendError({
        stamp: beijingStamp(),
        sentToday: null,
        count: 1,
        items: [
          {
            page,
            who: username || (isKiosk ? '教室端一体机' : '未署名教师'),
            at: at ?? new Date().toISOString(),
            message,
            stack,
            browser,
          },
        ],
      }),
      actorId: me.id,
      actorName: username || undefined,
    })

    if (mail.ok) {
      await markMailed(env, me.id, username, hash)
      return json({ ok: true, id, stored, mail: { sent: true } })
    }

    /* 发信失败：留一句人话原因（`no_key` / `no_to` / `pii_blocked` / `quota` / `failed`） */
    logIssue(
      'frontend-error',
      '前端报错邮件没发出去',
      { page, message: message.slice(0, 120), reason: mail.reason, status: mail.status },
      '报错已经存进数据库了，但你没有收到邮件 —— 所以"没人知道"是假象，只是通知慢了一步',
      '看 /admin 的「错误日志」卡片；若长期发不出去，去 Cloudflare 查 RESEND_API_KEY / ADMIN_NOTIFY_EMAIL',
    )
    return json({
      ok: true,
      id,
      stored,
      mail: { sent: false, reason: mail.reason, message: mail.message },
    })
  } catch (e) {
    /* 连发信助手都抛了（例如邮件模板还没部署）：同样只留痕 + 说人话 */
    const why = e instanceof Error ? e.message : String(e)
    logIssue(
      'frontend-error',
      '前端报错邮件没发出去',
      { page, message: message.slice(0, 120), reason: 'thrown', error: why },
      '报错已经存进数据库了，但你没有收到邮件 —— 所以"没人知道"是假象，只是通知慢了一步',
      '看 /admin 的「错误日志」卡片；若长期发不出去，去 Cloudflare 查 RESEND_API_KEY / ADMIN_NOTIFY_EMAIL',
    )
    return json({
      ok: true,
      id,
      stored,
      mail: { sent: false, reason: 'failed', message: why.slice(0, 200) },
    })
  }
}

/** 其余方法一律 405（这个路径只有上报） */
export async function onRequest(): Promise<Response> {
  return json({ ok: false, message: '这个地址只有 POST' }, 405)
}
