/**
 * 通知 —— 发 / 看 / 撤下 / 置顶 / 标记已读（`管理架构与角色权限方案.md` §九）。
 *
 * 🔴 **安全边界**：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处：
 *    数据库里 `schema.sql` §21 的那几个函数
 *      `can_publish_notice_to(scope_kind, grade_id, subject_code, target_role, teacher_ids, department)`
 *        **本能力的全部安全性都在它身上**（方案 §九.8 的 P-2）。
 *        🆕 2026-09-28 第二轮：参数多了 `department`（第七种收件维度 = 职能部门）。
 *      `my_notice_scopes()`          我能发哪些范围（前端拿它摆选项 —— 它**不是**第二处判据）
 *      `teacher_rank(uid)`           级别表（"发职位只能发给自己级别以下"就落在这里）
 *    这里拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 去问（auth.uid() 就是调用者）。
 *
 * 🔴 **三份清单必须同值**（少一处 = 同一件事两个口径）：
 *      · `SCOPE_KINDS`（下面）↔ `notices.scope_kind` 的 check（schema §21.3.1）
 *      · `SENDABLE_ROLES`     ↔ `notice_sendable_roles()`（schema §21.2）
 *      · `DEPARTMENTS`        ↔ `notice_departments()`（schema §21.2.2）
 *    ⚠️ 这三组都是**形状校验**（不在清单里直接 400，**在 RPC 之前**），
 *       所以只改数据库不改这里 = 数据库说 true、真实调用仍然 400（上一轮踩过的坑）。
 *       `app/scripts/nav-checks.mjs` 的 **A9** 拿源码文本逐字比对这几份。
 *
 * 🔴 **为什么读通知不需要这个 Function**：读走的是**真 RLS**（`notices_visible` 策略，
 *    见 schema §21.7）。也就是说，本文件里**没有**一处"前端说要看哪条就给他哪条"的代码 ——
 *    `list` 用的仍然是**调用者的 JWT**（不是 service_role），RLS 照常生效。
 *    教室端读不到、范围外的人读不到，都是数据库在拦（I47 / I46）。
 *
 * 🔴 **通知 ≠ 呼叫**（方案 §0.1）：这张表里**没有** `student_nos` / `class_id` /
 *    `assignment_id`，也**不会**有。呼叫走 `calls` + 教室大屏，两套判据、两个介质。
 *
 * 部署：<项目根>/functions/api/notice.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量（与 teacher-account 共用同一套）：
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY       （校验调用者 JWT 与 RPC 用）
 *   SUPABASE_SERVICE_ROLE_KEY                        （🔴 Secret，绝不能进前端、绝不能进仓库）
 */

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

/** 与 `notices.scope_kind` 的 check 约束**逐字相同**（多一个值就是两处不一致）
 *  🆕 2026-09-28 第二轮：加了 `'department'`（第七种）。 */
const SCOPE_KINDS = [
  'school',
  'grade',
  'subject',
  'grade_subject',
  'role',
  'custom',
  'department',
] as const
type ScopeKind = (typeof SCOPE_KINDS)[number]

/**
 * 能发给这些职位（与 `notice_sendable_roles()` 同一组；数据库那边仍会再判一次）。
 *
 * 🆕 2026-09-28 第二轮：**八档** —— 把 `admin`（教务处主任）加回来了（用户拍板）。
 *   ⚠️ 加它**不破坏**"超管要给校长递话走「全校」"那条口径：校级三档仍在清单外，
 *   而 `admin` 只可能被**超管**发到（`teacher_rank` 取 max → 拿 admin 的人级别恒 ≥ 90，
 *   判据是"我比他**严格**高"，所以 90 > 90 不成立）—— 这一档**不会**产生"下级通知上级"。
 *   详见 `supabase/schema.sql` §21.2 那段判断。
 */
const SENDABLE_ROLES = [
  'admin',
  'office_head',
  'moral_edu_head',
  'grade_head',
  'subject_lead',
  'lesson_prep_lead',
  'head_teacher',
  'teacher',
] as const

/**
 * 职能部门清单（与数据库 `notice_departments()` 同一组，四个值）。
 * 顺序 = 收件范围选项在界面上的顺序（`my_notice_scopes()` 按这个顺序往外列）。
 */
const DEPARTMENTS = ['office', 'academic', 'logistics', 'moral_edu'] as const

type Body = {
  action?: 'list' | 'create' | 'revoke' | 'pin' | 'seen'
  /** create */
  title?: string
  body?: string
  scopeKind?: string
  gradeId?: string
  subjectCode?: string
  targetRole?: string
  /** 🆕 收件范围 = 某个职能部门时，这里放部门代码（`DEPARTMENTS` 里那四个之一） */
  department?: string
  teacherIds?: string[]
  /** create：有效期（天，0 / 空 = 不过期） */
  expiresInDays?: number
  /** revoke / pin */
  noticeId?: string
  pinned?: boolean
  /** seen：我看到了哪个时刻为止（毫秒时间戳，服务端翻成 timestamptz） */
  seenAtMs?: number
}

const NEED_STAGE21 =
  '数据库还没跑通知那一段（仓库里 supabase/schema.sql 第 21 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^[a-z][a-z0-9_]{1,23}$/

/** 正文上限：一条通知是"开会通知"，不是公告板文章。超了直接拒，别静默截断 */
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

/** 用**调用者的 JWT** 调 Supabase（RLS 生效）—— 读通知走这条 */
function sbAs(env: Env, token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

/**
 * 用**管理员密钥**调 Supabase（绕过 RLS）—— 只有"写通知"这一步用它。
 * 🔴 每一次用到它之前，都已经先问过 `can_publish_notice_to()` 了。
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
 * 返回 'missing' = 函数还没建（第 21 段没跑）。调用方要把它翻成人话，
 * **不能当成 false** —— 那样会告诉一位校长"你没权限发通知"。
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

/** 问数据库：给我一组行（`my_notice_scopes()` 用；同样是**调用者的 JWT**） */
async function rpcRows(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>[] | 'missing'> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const r = await read(res)
  if (r.ok) return r.rows
  if (r.status === 404 || /PGRST202|does not exist|schema cache/i.test(r.text)) return 'missing'
  return []
}

/** 用调用者身份读一批行（RLS 生效）—— `list` / `seen` 的读都走它 */
async function selectAs(
  env: Env,
  token: string,
  path: string,
): Promise<Record<string, unknown>[] | 'missing'> {
  const r = await read(await sbAs(env, token, path))
  if (r.ok) return r.rows
  if (isMissing(r)) return 'missing'
  throw new Error(r.text.slice(0, 200))
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

  const action = body.action ?? 'list'

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /*
   * 「我能发哪些范围」—— 每个动作都要带上它，理由有两层：
   *   ① 页面首屏就要知道"该不该摆『发通知』这个按钮"（§四.2 第 19 行的 E/V 格）；
   *   ② 它是**唯一**能让前端不重写规则的来源（I16 / I29）：范围清单由数据库算。
   * ⚠️ 它**不是**第二处判据：写之前还会**再问一次** `can_publish_notice_to`（见 create）。
   */
  const scopes = await rpcRows(env, me.token, 'my_notice_scopes')
  if (scopes === 'missing') return json({ status: 'error', message: NEED_STAGE21 }, 503)

  const canPublish = scopes.length > 0

  /* ---------------- list：看得见的通知（**RLS 在拦**，不是这里筛） ---------------- */
  if (action === 'list') {
    let notices: Record<string, unknown>[] | 'missing'
    let targets: Record<string, unknown>[] | 'missing'
    try {
      notices = await selectAs(
        env,
        me.token,
        '/rest/v1/notices?select=*&order=pinned.desc,created_at.desc&limit=200',
      )
      targets = await selectAs(env, me.token, '/rest/v1/notice_targets?select=*')
    } catch (e) {
      return json(
        { status: 'error', message: '读通知失败', detail: String((e as Error).message).slice(0, 200) },
        502,
      )
    }
    if (notices === 'missing' || targets === 'missing') {
      return json({ status: 'error', message: NEED_STAGE21 }, 503)
    }

    /* 我"看到哪儿了"：读自己那一行 teachers（策略 teachers_self 只放行自己那一行） */
    let seenAt: string | null = null
    try {
      const mine = await selectAs(
        env,
        me.token,
        `/rest/v1/teachers?select=notice_seen_at&id=eq.${me.id}`,
      )
      if (mine !== 'missing' && mine[0]) {
        seenAt = (mine[0].notice_seen_at as string | null) ?? null
      }
    } catch {
      // 读不到就是"从没看过"（全部算未读）—— 不因为它整页失败
      seenAt = null
    }

    const nowMs = Date.now()
    const list = notices.map((n) => {
      const createdMs = Date.parse(String(n.created_at ?? '')) || 0
      const expiresAt = (n.expires_at as string | null) ?? null
      const expired = expiresAt ? Date.parse(expiresAt) <= nowMs : false
      const seenMs = seenAt ? Date.parse(seenAt) : 0
      return {
        id: String(n.id),
        title: String(n.title ?? ''),
        body: String(n.body ?? ''),
        scopeKind: String(n.scope_kind ?? 'school'),
        senderId: String(n.sender_id ?? ''),
        createdAt: createdMs,
        expiresAt: expiresAt ? Date.parse(expiresAt) : null,
        pinned: n.pinned === true,
        revokedAt: n.revoked_at ? Date.parse(String(n.revoked_at)) : null,
        expired,
        mine: String(n.sender_id ?? '') === me.id,
        // 未读 = 有 created_at > 我的 notice_seen_at 的通知（I49：**只有这一个时间戳**）
        unread: createdMs > seenMs,
        targets: targets
          .filter((t) => String(t.notice_id) === String(n.id))
          .map((t) => ({
            kind: String(t.target_kind ?? ''),
            gradeId: (t.grade_id as string | null) ?? null,
            subjectCode: (t.subject_code as string | null) ?? null,
            targetRole: (t.target_role as string | null) ?? null,
            /* 🆕 老库上这一列还不存在（第 21.3.1 段没跑）→ `select=*` 里没有它 →
               这里是 undefined → 归一成 null，前端不会崩（也**不能**因此 500）。 */
            department: (t.target_department as string | null) ?? null,
            teacherId: (t.teacher_id as string | null) ?? null,
          })),
      }
    })

    return json({
      status: 'ok',
      me: me.id,
      canPublish,
      scopes: scopes.map((s) => ({
        scopeKind: String(s.scope_kind ?? ''),
        gradeId: (s.grade_id as string | null) ?? null,
        gradeName: (s.grade_name as string | null) ?? null,
        subjectCode: (s.subject_code as string | null) ?? null,
        roleCode: (s.role_code as string | null) ?? null,
        /* 🆕 部门那一维的取值（老库 / 老缓存里没有这一列 → null） */
        departmentCode: (s.department_code as string | null) ?? null,
      })),
      seenAt: seenAt ? Date.parse(seenAt) : null,
      notices: list,
      unread: list.filter((n) => n.unread && !n.revokedAt && !n.expired).length,
    })
  }

  /* ---------------- seen：把"我上次看到哪儿"推到最新（**一行一个老师**，I49） ---------------- */
  if (action === 'seen') {
    const ms = Number(body.seenAtMs ?? Date.now())
    const at = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString()
    const res = await read(
      await sb(env, `/rest/v1/teachers?id=eq.${me.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ notice_seen_at: at }),
      }),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE21 : '记录已读失败',
          detail: res.text.slice(0, 200),
        },
        503,
      )
    }
    return json({ status: 'ok', seenAt: Date.parse(at) })
  }

  /* ---------------- create：发通知（**先问判据，再写**） ---------------- */
  if (action === 'create') {
    const title = String(body.title ?? '').trim()
    const text = String(body.body ?? '').trim()
    if (!title) return json({ status: 'error', message: '请填标题' }, 400)
    if (title.length > TITLE_MAX) {
      return json({ status: 'error', message: `标题最多 ${TITLE_MAX} 个字` }, 400)
    }
    if (!text) return json({ status: 'error', message: '请填正文' }, 400)
    if (text.length > BODY_MAX) {
      return json({ status: 'error', message: `正文最多 ${BODY_MAX} 个字` }, 400)
    }

    const scopeKind = String(body.scopeKind ?? '').trim() as ScopeKind
    if (!SCOPE_KINDS.includes(scopeKind)) {
      return json({ status: 'error', message: '不认识这个发布范围' }, 400)
    }

    const gradeId = String(body.gradeId ?? '').trim()
    const subjectCode = String(body.subjectCode ?? '').trim()
    const targetRole = String(body.targetRole ?? '').trim()
    const department = String(body.department ?? '').trim()
    const teacherIds = (body.teacherIds ?? [])
      .map((v) => String(v).trim())
      .filter((v) => UUID_RE.test(v))

    /* 形状校验（**不是**权限校验）：缺字段的话连 RPC 都不用问 */
    if ((scopeKind === 'grade' || scopeKind === 'grade_subject') && !UUID_RE.test(gradeId)) {
      return json({ status: 'error', message: '这个范围要指定一个年级' }, 400)
    }
    if ((scopeKind === 'subject' || scopeKind === 'grade_subject') && !CODE_RE.test(subjectCode)) {
      return json({ status: 'error', message: '这个范围要指定一个学科' }, 400)
    }
    if (scopeKind === 'role' && !(SENDABLE_ROLES as readonly string[]).includes(targetRole)) {
      return json({ status: 'error', message: '这个职位不在可发布的清单里' }, 400)
    }
    /* 🆕 部门那一支：代码必须是那四个之一（与 `notice_departments()` 同一组） */
    if (scopeKind === 'department' && !(DEPARTMENTS as readonly string[]).includes(department)) {
      return json({ status: 'error', message: '这个部门不在可发布的清单里' }, 400)
    }
    if (scopeKind === 'custom' && teacherIds.length === 0) {
      return json({ status: 'error', message: '还没有勾选任何老师' }, 400)
    }

    /*
     * 🔴 **本能力的全部安全性就在这一句**（方案 §九.8 的 P-2 / I46）：
     *    "能发给全校"与"能发给本年级"是**两种权限**，而这条判据**只在数据库里**。
     *    前端藏掉"全校"那个选项**不是**安全边界 —— 手打这个接口就绕过去了。
     */
    const allowed = await rpcBool(env, me.token, 'can_publish_notice_to', {
      p_scope_kind: scopeKind,
      p_grade_id: UUID_RE.test(gradeId) ? gradeId : null,
      p_subject_code: CODE_RE.test(subjectCode) ? subjectCode : null,
      p_target_role: targetRole || null,
      p_teacher_ids: teacherIds.length ? teacherIds : null,
      p_department: department || null,
    })
    if (allowed === 'missing') return json({ status: 'error', message: NEED_STAGE21 }, 503)
    if (!allowed) {
      return json(
        {
          status: 'error',
          message:
            '你没有给这个范围发通知的权限。可以发的范围见「发通知」页上列出的那几项 —— ' +
            '级别高的档位（校长 / 教务处 / 超管）不能由你去通知。',
        },
        403,
      )
    }

    /* 有效期：0 / 空 = 不过期。按"当下"的语义存**时刻**，不存天数（表里只有 expires_at） */
    const days = Number(body.expiresInDays ?? 0)
    const expiresAt =
      Number.isFinite(days) && days > 0
        ? new Date(Date.now() + Math.min(days, 365) * 86400000).toISOString()
        : null

    /* 学校 id：与 grades/classes 同一口径（多校预留）。取不到就留空，不因此拒发 */
    let schoolId: string | null = null
    const schools = await read(await sb(env, '/rest/v1/schools?select=id&order=created_at&limit=1'))
    if (schools.ok && schools.rows[0]) schoolId = String(schools.rows[0].id)

    const ins = await read(
      await sb(env, '/rest/v1/notices', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          school_id: schoolId,
          // 🔴 sender_id **由服务端取调用者**，前端传什么都不信（与 calls.teacher_id 同一条纪律）
          sender_id: me.id,
          title,
          body: text,
          scope_kind: scopeKind,
          expires_at: expiresAt,
        }),
      }),
    )
    if (!ins.ok || !ins.rows[0]?.id) {
      return json(
        {
          status: 'error',
          message: isMissing(ins) ? NEED_STAGE21 : '发通知失败',
          detail: ins.text.slice(0, 200),
        },
        502,
      )
    }
    const noticeId = String(ins.rows[0].id)

    /* 收件范围：**一行一个维度值**（存范围、不存名单，I50） */
    const rows: Record<string, unknown>[] = []
    const push = (kind: string, patch: Record<string, unknown>) =>
      rows.push({ notice_id: noticeId, target_kind: kind, ...patch })

    if (scopeKind === 'school') push('school', {})
    else if (scopeKind === 'grade') push('grade', { grade_id: gradeId })
    else if (scopeKind === 'subject') push('subject', { subject_code: subjectCode })
    else if (scopeKind === 'grade_subject')
      push('grade_subject', { grade_id: gradeId, subject_code: subjectCode })
    else if (scopeKind === 'role') push('role', { target_role: targetRole })
    /* 🆕 部门：写进**它自己那一列** `target_department`，**不复用** `target_role` ——
     *    一个字段只能有一种语义（`schema.sql` §21.3 那段写清了为什么）。 */
    else if (scopeKind === 'department') push('department', { target_department: department })
    else if (scopeKind === 'custom') {
      // 去重：同一个人勾两次只写一行
      for (const id of [...new Set(teacherIds)]) push('teacher', { teacher_id: id })
    }

    const tIns = await read(
      await sb(env, '/rest/v1/notice_targets', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(rows),
      }),
    )
    if (!tIns.ok) {
      /*
       * 范围没写进去 → **撤下这条通知**（而不是删掉）：删了就没法回答"这条通知曾经存在过吗"，
       * 而"一条谁都收不到的通知"在列表里就是一个谜。撤下之后它只对发件人可见，并且带说明。
       */
      await sb(env, `/rest/v1/notices?id=eq.${noticeId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      })
      return json(
        {
          status: 'error',
          message: '通知的范围没写进去，已自动撤下这条通知（谁都不会收到）',
          detail: tIns.text.slice(0, 200),
        },
        502,
      )
    }

    return json({ status: 'ok', noticeId })
  }

  /* ---------------- revoke：撤下（**不删行**） ---------------- */
  if (action === 'revoke') {
    const noticeId = String(body.noticeId ?? '').trim()
    if (!UUID_RE.test(noticeId)) return json({ status: 'error', message: '没有指定通知' }, 400)

    const mine = await read(
      await sb(env, `/rest/v1/notices?select=id,sender_id&id=eq.${noticeId}`),
    )
    if (!mine.ok) {
      return json(
        { status: 'error', message: isMissing(mine) ? NEED_STAGE21 : '找不到这条通知' },
        503,
      )
    }
    if (!mine.rows[0]) return json({ status: 'error', message: '找不到这条通知' }, 404)

    /*
     * 「撤下」比「发」更窄（§三 第 40 行）：**任何人（含校长）都只能撤自己发的那条**，
     * 唯一的例外是教务处与超管。理由：否则一位年级主任就能撤掉校长发的全校通知。
     */
    const isMine = String(mine.rows[0].sender_id) === me.id
    const broad = await rpcBool(env, me.token, 'is_school_admin')
    if (broad === 'missing') return json({ status: 'error', message: NEED_STAGE21 }, 503)
    if (!isMine && !broad) {
      return json({ status: 'error', message: '只能撤下自己发的通知' }, 403)
    }

    const res = await read(
      await sb(env, `/rest/v1/notices?id=eq.${noticeId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      }),
    )
    if (!res.ok) return json({ status: 'error', message: '撤下失败', detail: res.text.slice(0, 200) }, 502)
    return json({ status: 'ok' })
  }

  /* ---------------- pin：置顶（**只有教务处与超管**） ---------------- */
  if (action === 'pin') {
    /*
     * 「置顶」与「撤下」是两组权限（§三 第 40 行）：**置顶别人的通知 = 改别人话的权重**，
     * 这件事不该人人都有。判据用 `is_school_admin()`（super + 教务处）。
     */
    const broad = await rpcBool(env, me.token, 'is_school_admin')
    if (broad === 'missing') return json({ status: 'error', message: NEED_STAGE21 }, 503)
    if (!broad) return json({ status: 'error', message: '只有教务处与最高管理员能置顶通知' }, 403)

    const noticeId = String(body.noticeId ?? '').trim()
    if (!UUID_RE.test(noticeId)) return json({ status: 'error', message: '没有指定通知' }, 400)

    const res = await read(
      await sb(env, `/rest/v1/notices?id=eq.${noticeId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ pinned: body.pinned !== false }),
      }),
    )
    if (!res.ok) return json({ status: 'error', message: '置顶失败', detail: res.text.slice(0, 200) }, 502)
    return json({ status: 'ok' })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}
