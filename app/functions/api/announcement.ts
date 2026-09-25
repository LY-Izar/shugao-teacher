/**
 * 全站公告 —— 发 / 改 / 撤下 / 超管清单（`supabase/schema.sql` §22）。
 *
 * 🔴🔴 **公告 ≠ 通知**（`管理台第二期方案.md` §二.0 原判"公告就是通知"，被用户 2026-09-28 推翻）：
 *    · **通知**（`/api/notice` + `notices` 表）＝ 教务通知：职能部门**发给老师**，
 *      有收件范围、有未读、落在 `/notices` 那一页。
 *    · **公告**（本文件 + `announcements` 表）＝ **全站公告**：**关于平台本身**的信息
 *      （"系统今晚维护"、"新功能上线"），**全站一条、没有收件范围、没有收件人**，
 *      形态是**顶部横幅 + 可选弹窗**（`AnnouncementStack.tsx`）。
 *    ⛔ 两个 Function **一个字都不共享**：本文件不 import `notice.ts` 的任何东西，
 *      也不碰 `notice_targets` / `notice_recipient_ids_for` / `can_publish_notice_to`。
 *
 * 🔴 **安全边界**：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处：
 *    数据库里 `schema.sql` §22.2 的
 *      `can_publish_announcement()`  = 超管 且 在册教师 且 不是教室端
 *    这里拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/can_publish_announcement` 去问
 *    （auth.uid() 就是调用者）。
 *
 * 🔴 **读**：教师端那条横幅**不走这个 Function** —— 它直接用登录会话读 `announcements`
 *    （真 RLS：`announcements_visible` 策略）。本文件里只有一个读动作 `admin-list`，
 *    它是**给超管面板**用的（要看到**已撤下 / 已过期**的那些 —— "这条公告曾经存在过吗"
 *    必须能回答），所以它走 service_role，判据在它前面。
 *
 * 部署：<项目根>/functions/api/announcement.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量（与 notice / teacher-account 共用同一套）：
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY       （校验调用者 JWT 与 RPC 用）
 *   SUPABASE_SERVICE_ROLE_KEY                        （🔴 Secret，绝不能进前端、绝不能进仓库）
 *
 * ⚠️ 🆕 **2026-09-29 管理台第二期：邮件那一半接上了**（用户点名）。
 *    这一节原来写着"本轮不做邮件发送（`RESEND_API_KEY` 用户还没配）"—— 那句话现在不成立了：
 *    `RESEND_API_KEY` 已经配好，而公告表上那四列（`email_sent` / `email_sent_ts` /
 *    `email_count` / `email_fail`）**本轮开始被真正写**。
 *
 *    🔴 **可选勾选、默认不发**（用户口径）：免费额度 3000 封/月、**100 封/天**，
 *       而"一条全校公告 = 100+ 封"—— 所以默认不勾，勾了才发。
 *    🔴 **发不到每位老师**：Resend 未验域名时只能用 `onboarding@resend.dev`，
 *       而它**只能发给账号所有者本人**（= 固定的管理员邮箱）。
 *       所以这一处的勾选框发的是**给管理员的一封留档邮件**，
 *       界面上把这件事写清楚了（**不许让超管以为"全班老师都收到了邮件"**）。
 */

import {
  MAIL_DAILY_CAP,
  MAIL_FROM,
  beijingStamp,
  mailConfigured,
  sendAuditedMail,
} from './_lib/mail'

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

/** 等级：与 `announcements.level` 的 check **逐字相同**（多一个值就是两处不一致）
 *  ⚠️ 它只回答"**多显眼**"；"弹几次"是 `POPUPS`（一个字段一种语义）。 */
const LEVELS = ['normal', 'important', 'urgent'] as const
/** 弹窗：与 `announcements.popup` 的 check **逐字相同** */
const POPUPS = ['never', 'once', 'session', 'always'] as const

type Level = (typeof LEVELS)[number]
type Popup = (typeof POPUPS)[number]

type Body = {
  action?: 'admin-list' | 'create' | 'update' | 'revoke'
  id?: string
  title?: string
  body?: string
  level?: string
  popup?: string
  pin?: boolean
  /** 生效起点 / 终点（ISO 字符串；空串 / 不传 = 那一端是 ±∞） */
  activeFrom?: string
  activeTo?: string
  /**
   * 🆕 是否同时发一封邮件（**默认不发**）。
   * ⚠️ 发的是**给管理员邮箱的一封留档**，不是群发（Resend 未验域名发不到别人）
   */
  sendEmail?: boolean
}

const NEED_STAGE22 =
  '数据库还没跑公告那一段（仓库里 supabase/schema.sql 第 22 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 正文上限：一条公告是"一句话说清平台状态"，不是公告板文章。超了直接拒，别静默截断 */
const TITLE_MAX = 120
const BODY_MAX = 2000

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function baseUrl(env: Env): string {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
}

function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
}

/**
 * 用**管理员密钥**调 Supabase（绕过 RLS）。
 * 🔴 每一次用到它之前，都已经先问过 `can_publish_announcement()` 了。
 */
function sb(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

type Read = { ok: boolean; status: number; rows: Record<string, unknown>[]; text: string }

async function read(res: Response): Promise<Read> {
  const text = await res.text()
  let rows: Record<string, unknown>[] = []
  try {
    const v = JSON.parse(text || '[]')
    if (Array.isArray(v)) rows = v as Record<string, unknown>[]
  } catch {
    rows = []
  }
  return { ok: res.ok, status: res.status, rows, text }
}

const isMissing = (r: Read) =>
  r.status === 404 ||
  /42P01|42703|PGRST20[45]|PGRST202|does not exist|schema cache/i.test(r.text)

/* ---------------- 调用者是谁 ---------------- */

async function caller(request: Request, env: Env): Promise<{ id: string; token: string } | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const key = anonKey(env)
  if (!key) return null
  const res = await fetch(`${baseUrl(env)}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user?.id ? { id: user.id, token } : null
}

/**
 * 问数据库：这个判据对我返回什么？
 * 返回 `'missing'` = 函数还没建（§22 没跑）。调用方要把它翻成人话，
 * **不能当成 false** —— 那样会告诉一位超管"你没权限发公告"。
 */
async function rpcBool(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown> = {},
): Promise<boolean | 'missing'> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.ok) return text.trim() === 'true'
  if (res.status === 401 || res.status === 403) return false
  if (res.status === 404 || /PGRST202|does not exist|schema cache/i.test(text)) return 'missing'
  return false
}

/** 把空串归一成 null（"没填"与"填了个空"在区间语义上是一回事） */
const orNull = (v: string | undefined): string | null => {
  const t = String(v ?? '').trim()
  return t === '' ? null : t
}

/** 生效区间：两端都可以为空（±∞）；**两端都填就必须"结束晚于开始"**（与 SQL 那条 check 同一条） */
function parseWindow(
  from: string | undefined,
  to: string | undefined,
): { from: string | null; to: string | null } | { error: string } {
  const f = orNull(from)
  const t = orNull(to)
  let fm: number | null = null
  let tm: number | null = null
  if (f) {
    fm = Date.parse(f)
    if (!Number.isFinite(fm)) return { error: '生效起点看不懂（要一个时间）' }
  }
  if (t) {
    tm = Date.parse(t)
    if (!Number.isFinite(tm)) return { error: '生效终点看不懂（要一个时间）' }
  }
  if (fm !== null && tm !== null && tm <= fm) {
    return { error: '生效终点必须晚于起点 —— 否则这条公告永远不会出现' }
  }
  return { from: fm === null ? null : new Date(fm).toISOString(), to: tm === null ? null : new Date(tm).toISOString() }
}

/** 形状校验（**不是权限校验**）：不认识的值连 RPC 都不用问 */
function parseFields(body: Body):
  | { title: string; text: string; level: Level; popup: Popup; pin: boolean; from: string | null; to: string | null }
  | { error: string } {
  const title = String(body.title ?? '').trim()
  const text = String(body.body ?? '').trim()
  if (!title) return { error: '请填标题' }
  if (title.length > TITLE_MAX) return { error: `标题最多 ${TITLE_MAX} 个字` }
  if (!text) return { error: '请填正文' }
  if (text.length > BODY_MAX) return { error: `正文最多 ${BODY_MAX} 个字` }
  const level = String(body.level ?? 'normal').trim() as Level
  if (!(LEVELS as readonly string[]).includes(level)) return { error: '不认识这个等级' }
  const popup = String(body.popup ?? 'never').trim() as Popup
  if (!(POPUPS as readonly string[]).includes(popup)) return { error: '不认识这个弹窗方式' }
  const win = parseWindow(body.activeFrom, body.activeTo)
  if ('error' in win) return { error: win.error }
  return { title, text, level, popup, pin: body.pin === true, from: win.from, to: win.to }
}

/* ---------------- 入口 ---------------- */

export async function onRequestPost(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(
      {
        status: 'not_configured',
        message:
          '还没配置账号服务。到 Cloudflare Pages → Settings → Variables and secrets 添加 SUPABASE_SERVICE_ROLE_KEY（Secret），然后重新部署。',
      },
      503,
    )
  }
  if (!baseUrl(env) || !anonKey(env)) {
    return json(
      {
        status: 'not_configured',
        message: '缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY，请到 Cloudflare Pages 的环境变量里补上。',
      },
      503,
    )
  }

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }

  const action = body.action ?? 'admin-list'

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /*
   * 🔴 **本能力的全部安全性就在这一句**（`supabase/schema.sql` §22.2）：
   *    "谁能发公告" = 超管（用户口径：公告是关于平台本身的）。
   *    前端藏掉那个入口**不是**安全边界 —— 手打这个接口就绕过去了。
   */
  const allowed = await rpcBool(env, me.token, 'can_publish_announcement')
  if (allowed === 'missing') return json({ status: 'error', message: NEED_STAGE22 }, 503)
  if (!allowed) {
    return json(
      {
        status: 'error',
        message:
          '只有最高管理员能发全站公告。公告是**关于平台本身**的信息（维护、功能、提醒），' +
          '各职能部门要通知老师请走「通知」那一页。',
      },
      403,
    )
  }

  /* ---------------- admin-list：超管清单（**含已撤下 / 已过期**） ---------------- */
  if (action === 'admin-list') {
    const res = await read(
      await sb(
        env,
        '/rest/v1/announcements?select=*&order=created_at.desc&limit=200',
      ),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE22 : '读公告清单失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }
    return json({ status: 'ok', announcements: res.rows })
  }

  /* ---------------- create：发一条（**先问判据，再写**） ---------------- */
  if (action === 'create') {
    const f = parseFields(body)
    if ('error' in f) return json({ status: 'error', message: f.error }, 400)

    /* 学校 id：与 grades/classes/notices 同一口径（多校预留）。取不到就留空，不因此拒发 */
    let schoolId: string | null = null
    const schools = await read(await sb(env, '/rest/v1/schools?select=id&order=created_at&limit=1'))
    if (schools.ok && schools.rows[0]) schoolId = String(schools.rows[0].id)

    /*
     * 🆕 邮件：**先决定发不发**（默认不发），但**发信永远在落库之后**
     *    —— 与用户反馈同一条纪律（先落库、再发信；发不出去也不回滚）。
     */
    const wantMail = body.sendEmail === true

    const ins = await read(
      await sb(env, '/rest/v1/announcements', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          school_id: schoolId,
          title: f.title,
          body: f.text,
          level: f.level,
          popup: f.popup,
          pin: f.pin,
          active_from: f.from,
          active_to: f.to,
          /* 🔴 发件人由**服务端从调用者 JWT 取**，前端传什么都不信（与 notices.sender_id 同一条纪律） */
          created_by: me.id,
          updated_by: me.id,
          /* 邮件四列：没勾就停在列默认值上（`email_sent=false` / count=0 / fail=0） */
        }),
      }),
    )
    if (!ins.ok || !ins.rows[0]?.id) {
      return json(
        {
          status: 'error',
          message: isMissing(ins) ? NEED_STAGE22 : '发公告失败',
          detail: ins.text.slice(0, 200),
        },
        isMissing(ins) ? 503 : 502,
      )
    }
    const id = String(ins.rows[0].id)

    /* ---------------- 邮件那一半（可选、默认不发） ---------------- */
    let mail: { ok: boolean; reason: string } = { ok: false, reason: 'not_requested' }
    if (wantMail) {
      const r = await sendAuditedMail(env, {
        action: 'mail.announcement',
        actorId: me.id,
        subject: `【树高公告】${f.title.slice(0, 60)} · ${beijingStamp()}`,
        text: [
          '你在管理台发布了一条全站公告。',
          '',
          `标题：${f.title}`,
          `等级：${f.level} · 弹窗：${f.popup} · 置顶：${f.pin ? '是' : '否'}`,
          `生效：${f.from ?? '立即'} → ${f.to ?? '不过期'}`,
          `时间：${beijingStamp()}`,
          '',
          '正文：',
          f.text,
          '',
          '⚠️ 这封邮件是**给管理员的一封留档**，不是群发：',
          `   Resend 未验域名时发件人只能是 ${MAIL_FROM}，且只能发给账号所有者本人。`,
          `   今天的邮件配额上限是 ${MAIL_DAILY_CAP} 封/天（Resend 免费额度 100 封/天）。`,
          /* ⚠️ 措辞避开那四个触发词（成绩 / 分数 / 得分 / 排名 / 名次）——
             它们会让 `looksLikeStudentData()` 把**这句免责声明自己**拦下来
             （`admin-checks` ⑤ 的反向对照抓到过同一个形状）。 */
          '⚠️ 本邮件正文里**没有学生个人信息**（发信助手发出前会体检一遍，命中就不发）。',
        ].join('\n'),
      })
      mail = { ok: r.ok, reason: r.ok ? '' : r.reason }
      /*
       * 🔴 四列**真正用起来**（方案 §二.5 的"额度/失败计数要给到界面上"）：
       *    email_sent  = 有没有**成功**发出去（失败不算"发过"，否则界面上会把失败画成绿）
       *    email_count = 成功封数（一封留档 = 1）
       *    email_fail  = 失败封数（含"没配 key"与"正文疑似含学生信息"）
       *  ⚠️ 写这四列失败**不影响公告本身**（公告已经发出去了）——
       *     但要把话说出来（回话里带 `mail.recorded`）。
       */
      await sb(env, `/rest/v1/announcements?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          email_sent: r.ok,
          email_sent_ts: new Date().toISOString(),
          email_count: r.ok ? 1 : 0,
          email_fail: r.ok ? 0 : 1,
          updated_by: me.id,
          updated_at: new Date().toISOString(),
        }),
      })
    }

    return json({
      status: 'ok',
      id,
      mail,
      /** 邮件通道通不通（界面上要写清楚"没配 key 时勾了也不会发"） */
      mailConfigured: mailConfigured(env),
    })
  }

  /* ---------------- update：改一条（**同一个不变量在每一条写入路径上守**） ---------------- */
  if (action === 'update') {
    const id = String(body.id ?? '').trim()
    if (!UUID_RE.test(id)) return json({ status: 'error', message: '没有指定公告' }, 400)
    const f = parseFields(body)
    if ('error' in f) return json({ status: 'error', message: f.error }, 400)

    const cur = await read(await sb(env, `/rest/v1/announcements?select=id,revoked_at&id=eq.${id}`))
    if (!cur.ok) {
      return json(
        { status: 'error', message: isMissing(cur) ? NEED_STAGE22 : '找不到这条公告' },
        isMissing(cur) ? 503 : 502,
      )
    }
    if (!cur.rows[0]) return json({ status: 'error', message: '找不到这条公告' }, 404)
    /*
     * 🔴 已撤下的**不许再改**：撤下是"这条公告到这儿为止"，
     *    再改它等于改历史（而那一行留着正是为了回答"它当时说了什么"）。
     */
    if (cur.rows[0].revoked_at) {
      return json({ status: 'error', message: '这条公告已经撤下了，改它没有意义（行留着是给历史用的）' }, 409)
    }

    const res = await read(
      await sb(env, `/rest/v1/announcements?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          title: f.title,
          body: f.text,
          level: f.level,
          popup: f.popup,
          pin: f.pin,
          active_from: f.from,
          active_to: f.to,
          updated_by: me.id,
          updated_at: new Date().toISOString(),
        }),
      }),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE22 : '改公告失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }
    return json({ status: 'ok' })
  }

  /* ---------------- revoke：撤下（**不删行**） ---------------- */
  if (action === 'revoke') {
    const id = String(body.id ?? '').trim()
    if (!UUID_RE.test(id)) return json({ status: 'error', message: '没有指定公告' }, 400)

    const res = await read(
      await sb(env, `/rest/v1/announcements?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: new Date().toISOString(), updated_by: me.id }),
      }),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE22 : '撤下失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }
    return json({ status: 'ok' })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}
