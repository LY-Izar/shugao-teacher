/**
 * 教室端账号的创建 / 重置 / 自设 / 停用。
 *
 * 为什么必须放服务端：
 * 在浏览器里创建 Supabase 账号**必须**用管理员密钥（service_role），
 * 而这个密钥一旦进了前端产物就等于公开 —— 谁都能拿它读写全校数据。
 * 所以密钥只待在 Cloudflare Pages 的环境变量里，由这个 Function 代劳。
 *
 * 🔴 安全边界（设计 §六 明确要求）：
 * 这个 Function **必须自己校验调用者权限**，不能只靠"登录了就放行"。
 * 因为 service_role 是绕过 RLS 的，一旦放行就等于把整库交出去。
 * 具体规则（用户已确认）：只有 最高管理员 / 年级主任 / 班主任 能给班建账号；
 * 任课教师不行；**教室端账号自己更不行**（学生能碰到那台机器）。
 *
 * 部署：<项目根>/functions/api/classroom-account.ts，推 GitHub 后 Cloudflare 自动带上。
 * 需要在 Pages 项目 → Settings → Variables and secrets 配三个变量：
 *   SUPABASE_URL                （没配的话回退用 VITE_SUPABASE_URL）
 *   SUPABASE_ANON_KEY           （用来校验调用者的 JWT，公开无妨）
 *   SUPABASE_SERVICE_ROLE_KEY   （🔴 Secret，绝不能进前端、绝不能进仓库）
 */

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type Body = {
  /**
   * create = 建账号；reset = 随机换一串密码；🆕 set = **班主任自己定一个密码**；
   * disable / enable = 停用或恢复；
   * 🆕 status = **只看一眼**这个班有没有账号（**只回账号，不回密码** —— 密码是哈希存的，拿不回原文）。
   */
  action?: 'create' | 'reset' | 'set' | 'disable' | 'enable' | 'status'
  classId?: string
  /**
   * 🔴 **只有 `set` 用它**（`reset` 自己 `makePassword()`）—— 口令从调用者手里来，
   *    服务端**不校验旧口令**（班主任已经登录；旧口令原文谁也拿不到），只校验它合不合规。
   * ⚠️ 它**只去 GoTrue**（`auth.users`，那边存哈希）：业务库 `classroom_accounts` 一个字段都不写。
   */
  password?: string
}

const EMAIL_DOMAIN = 'shugao.local'

/** 去掉容易看错、也难在教室那台机器上敲的字符：I l O 0 1 */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

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

/** 用管理员密钥调 Supabase（绕过 RLS，所以调用前的权限校验一步都不能省） */
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

/**
 * 数据库还没跑阶段 1 的建表脚本时，PostgREST 会回 42P01（relation does not exist）。
 * 这种错误对用户来说完全看不懂，单独翻译一句人话。
 *
 * 🔴 判据只认"**表/relation** 不在"（`42P01` / `PGRST205` /
 * 文案里限定过的 `Could not find the table` / `relation … does not exist`），
 * **不许**用泛化的 `/does not exist/i` 或 `schema cache` —— 那会把
 * `Could not find the 'x' column of 'y' in the schema cache`（`PGRST204`，说的是"这一列不在"）
 * 也翻成「表还没建」，等于把人指去跑一段本来已经跑过的 SQL。
 * ⚠️ 这里探的是**表**（`classroom_accounts?select=id&id=eq.` 只用主键那一列），
 *    所以不需要 `isMissingColumn` 那条配套判据；`42703` 一律**不是**"表不在"。
 * 口径与 `lib/adminChart.ts` 的 `MISSING_TABLE_RE` 一致。
 */
function isMissingTable(status: number, text: string): boolean {
  return (
    status === 404 || /42P01|PGRST205|Could not find the table|relation .+ does not exist/i.test(text)
  )
}

const NEED_STAGE1 =
  '数据库还没建权限体系的表。到 Supabase → SQL Editor 跑一遍仓库里的 supabase/schema.sql（第 10 段），再回来重试。'

/** 校验调用者身份：拿他自己的 JWT 去问 Auth 这是谁 */
async function callerId(request: Request, env: Env): Promise<string | null> {
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
  return user?.id ?? null
}

/** 教室端登录名：高二(4)班 → g2-4@shugao.local（要能在教室那台机器上敲得进去） */
function emailSlug(className: string): string {
  const m = className.match(/高\s*([一二三])\s*[（(]\s*(\d+)\s*[）)]/)
  if (m) {
    const g = { 一: '1', 二: '2', 三: '3' }[m[1] as '一' | '二' | '三']
    return `g${g}-${m[2]}`
  }
  const ascii = className
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
  return ascii || 'class'
}

/** 邮箱被占了就往后加 -2、-3…（auth.users 里已有同名用户时） */
async function pickEmail(env: Env, className: string): Promise<string> {
  const slug = emailSlug(className)
  for (let i = 1; i <= 20; i++) {
    const candidate = `${slug}${i === 1 ? '' : `-${i}`}@${EMAIL_DOMAIN}`
    const res = await sb(
      env,
      `/rest/v1/classroom_accounts?select=id&email=eq.${encodeURIComponent(candidate)}`,
    )
    if (!res.ok) break
    const rows = (await res.json()) as unknown[]
    if (!Array.isArray(rows) || rows.length === 0) return candidate
  }
  return `${slug}-${Date.now().toString(36)}@${EMAIL_DOMAIN}`
}

function makePassword(len = 12): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length]
  return out
}

/**
 * 给这个教室端账号换口令 —— `set` 与 `reset` 走的**同一条路**
 * （同一个 `existing.id`、同一个 `PUT /auth/v1/admin/users/{id}`）。
 * 两条路的差别**只有一处**：`password` 是谁给的（`set` = 调用者传入，`reset` = `makePassword()`）。
 */
function putPassword(env: Env, userId: string, password: string): Promise<Response> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  return fetch(`${baseUrl(env)}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  })
}

/** 「自己设置」那串口令的位数下限 / 上限（GoTrue 默认下限就是 6 位） */
const PW_MIN = 6
const PW_MAX = 12

/**
 * 班主任自己定的那串口令合不合规？不合规回**一句人话**，合规回 `null`（调用方据此回 400）。
 *
 * 🔴 规则（用户确认）：**6–12 位、字母和数字都要有、不许有空格**。
 * ⚠️ **别把它和课代表口令那条混起来**：课代表口令是 4–12 位、纯数字也行
 *    （那管的是班里的口令，和教室端大屏账号是两回事）。
 * 🔴 规则**只有这一份**，在服务端：前端只判"两次输入一不一样"，**不另抄一份**（抄了就会走散）。
 */
function passwordProblem(pw: string): string | null {
  if (!pw) return '请先填一个密码'
  if (/\s/.test(pw)) return '密码里不能有空格'
  if (pw.length < PW_MIN || pw.length > PW_MAX) return `密码要 ${PW_MIN} 到 ${PW_MAX} 位`
  if (!/[A-Za-z]/.test(pw)) return '密码里要有字母'
  if (!/[0-9]/.test(pw)) return '密码里要有数字'
  return null
}

/**
 * GoTrue 出错回话里那句**关键信息**（`msg` / `message` / `error_code`）；
 * 认不出来就把原文截一段 —— 🔴 **不许静默**：调用方把这句话带回给老师。
 */
function goTrueReason(text: string): string {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    for (const k of ['msg', 'message', 'error_code']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 120)
    }
  } catch {
    /* 不是 JSON —— 下面原样截一段 */
  }
  return (text || '').trim().slice(0, 120)
}

/* ---------------- 操作留痕（`admin_audit`） ---------------- */

/**
 * 写一行操作留痕。
 *
 * 🔴 只给"不可逆、而且会把明文交出去"的口令动作用：`reset`（随机换一串）与
 *    `set`（班主任自己定一个）。仿 `teacher-account.ts` 里的同名函数
 *    （本文件刻意**不 import** 任何东西，所以自带一份）——
 *    ⚠️ 两处必须**逐字段相同**（列名 / 截断长度 / `affected` 的下限），否则同一张表会长出两种写法。
 * ⚠️ 它自己**绝不抛错**：留痕失败不该把一次已经改成功的口令变成 500；
 *    但也不假装成功 —— 返回值交给调用方放进回话里（`audited`）。
 */
async function auditRow(
  env: Env,
  row: {
    actorId: string | null
    actorName?: string
    action: string
    target?: string
    detail?: string
    affected?: number
  },
): Promise<boolean> {
  try {
    const res = await sb(env, '/rest/v1/admin_audit', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor_id: row.actorId,
        actor_name: (row.actorName ?? '').slice(0, 60),
        action: row.action.slice(0, 60),
        target: (row.target ?? '').slice(0, 120),
        detail: (row.detail ?? '').slice(0, 300),
        affected: Math.max(0, Math.trunc(row.affected ?? 0)),
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** 某位老师在 `teachers` 里的姓名（读不到就回空串 —— **不留假名字**） */
async function nameOf(env: Env, id: string): Promise<string> {
  try {
    const res = await sb(env, `/rest/v1/teachers?select=name&id=eq.${id}`)
    if (!res.ok) return ''
    const rows = (await res.json()) as { name?: string }[]
    return String(rows?.[0]?.name ?? '').trim()
  } catch {
    return ''
  }
}

type ClassRow = { id: string; name: string; grade_id: string | null; school_id: string | null }
type RoleRow = { role: string; scope_type: string | null; scope_id: string | null }
type AccountRow = { id: string; email: string; disabled: boolean }

/**
 * 这个人能不能管这个班的教室端账号？
 *
 * 规则（用户已确认）：最高管理员 / 教务处 ∪ 年级主任（本年级）/ 班主任（本班）。
 * 任课教师不行 —— 任课关系是「能不能批改」的判据，不是「能不能建账号」的判据。
 *
 * 🔴 **走班班不需要另加一支**：它只是 `classes` 里 `kind='stream'` 的一行、**照样有 `grade_id`**，
 *    于是"本年级的年级主任"这一支天然把它盖住 —— 这正是用户要的
 *    「走班班没有班主任，由年级主任统一管」。**别为它再发明一个名字相近的判据**
 *    （`can_manage_stream_class` 在 `schema.sql` §31.1 / §32 里被明确否掉，理由同上）。
 */
export function mayManage(roles: RoleRow[], cls: ClassRow): boolean {
  return roles.some((r) => {
    if (r.role === 'super' || r.role === 'admin') return true
    if (r.role === 'grade_head') return cls.grade_id != null && r.scope_id === cls.grade_id
    if (r.role === 'head_teacher') return r.scope_id === cls.id
    return false
  })
}

/** 回话里那一个 `account` 对象 —— **形状只有这一处**（三个动作各自拼一份就会漂） */
function accountOf(cls: ClassRow, a: AccountRow, password?: string): Record<string, unknown> {
  return {
    classId: cls.id,
    name: `${cls.name.replace(/班$/, '')}班教室`,
    email: a.email,
    disabled: a.disabled,
    ...(password ? { password } : {}),
  }
}

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
          '还没配置教室端账号服务。到 Cloudflare Pages → Settings → Variables and secrets 添加 SUPABASE_SERVICE_ROLE_KEY（Secret），然后重新部署。',
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

  const action = body.action ?? 'create'
  const classId = (body.classId ?? '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(classId)) {
    return json({ status: 'error', message: '没有指定有效的班级' }, 400)
  }

  // ---- 1. 这是谁？ ----
  const uid = await callerId(request, env)
  if (!uid) {
    return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)
  }

  // ---- 2. 教室端账号自己不许管账号（学生能碰到那台机器）----
  const selfCheck = await sb(env, `/rest/v1/classroom_accounts?select=id&id=eq.${uid}`)
  const selfText = await selfCheck.text()
  if (isMissingTable(selfCheck.status, selfText)) {
    return json({ status: 'error', message: NEED_STAGE1 }, 503)
  }
  if (selfCheck.ok) {
    const mine = JSON.parse(selfText || '[]') as unknown[]
    if (Array.isArray(mine) && mine.length > 0) {
      return json({ status: 'error', message: '教室端账号没有管理账号的权限' }, 403)
    }
  }

  // ---- 3. 他管得着这个班吗？ ----
  const clsRes = await sb(
    env,
    `/rest/v1/classes?select=id,name,grade_id,school_id&id=eq.${classId}`,
  )
  const clsText = await clsRes.text()
  if (!clsRes.ok) {
    return json({ status: 'error', message: NEED_STAGE1, detail: clsText.slice(0, 200) }, 503)
  }
  const cls = (JSON.parse(clsText || '[]') as ClassRow[])[0]
  if (!cls) return json({ status: 'error', message: '找不到这个班级' }, 404)

  const roleRes = await sb(
    env,
    `/rest/v1/teacher_roles?select=role,scope_type,scope_id&teacher_id=eq.${uid}`,
  )
  const roleText = await roleRes.text()
  if (!roleRes.ok) {
    return json({ status: 'error', message: NEED_STAGE1, detail: roleText.slice(0, 200) }, 503)
  }
  const roles = JSON.parse(roleText || '[]') as RoleRow[]

  if (!mayManage(roles, cls)) {
    return json(
      {
        status: 'error',
        // 三个动作都能干，所以这一句里三件都写上（只提"建账号"会把重置密码的人指错）
        message: '只有班主任、年级主任或最高管理员能管这个班的教室端账号',
      },
      403,
    )
  }

  const displayName = `${cls.name.replace(/班$/, '')}班教室`

  // ---- 4. 干活 ----
  const existingRes = await sb(
    env,
    `/rest/v1/classroom_accounts?select=id,email,disabled&class_id=eq.${classId}`,
  )
  const existingText = await existingRes.text()
  if (!existingRes.ok) {
    return json({ status: 'error', message: NEED_STAGE1, detail: existingText.slice(0, 200) }, 503)
  }
  const existing = (JSON.parse(existingText || '[]') as AccountRow[])[0]

  /*
   * 🆕 status = **只看一眼**（班级档案里那一块「教室端账号」进门先问它）。
   *
   * 🔴 它**只回账号**：Supabase 的密码是**哈希**存的，服务端自己也拿不回原文 ——
   *    所以"看一眼密码"这件事在原理上做不到，界面上必须写清"密码只在生成时显示这一次"。
   *    要密码就点「重置密码」（`reset`），新密码在手边显示一次。
   *
   * ⚠️ 它是**只读动作**：不改库、不建号，所以它走的是同一个 `mayManage()` 那一刀
   *    （上面刚判过）—— 不另设一套"看得到"与"改得动"的判据。
   */
  if (action === 'status') {
    return json({
      status: 'ok',
      hasAccount: Boolean(existing),
      ...(existing ? { account: accountOf(cls, existing) } : {}),
    })
  }

  if (action === 'disable' || action === 'enable') {
    if (!existing) return json({ status: 'error', message: '这个班还没有教室端账号' }, 404)
    const upd = await sb(env, `/rest/v1/classroom_accounts?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ disabled: action === 'disable' }),
    })
    if (!upd.ok) {
      return json(
        { status: 'error', message: '更新失败', detail: (await upd.text()).slice(0, 200) },
        502,
      )
    }
    return json({
      status: 'ok',
      account: accountOf(cls, { ...existing, disabled: action === 'disable' }),
    })
  }

  if (action === 'reset') {
    if (!existing) return json({ status: 'error', message: '这个班还没有教室端账号' }, 404)
    /*
     * 🔴 **留痕**：口令这类动作**动手前后各一条**（照 `teacher-account.ts` 里那条先例）。
     *    明文照旧只在回话里交给操作者一次（重置之后要交给人），但"是谁、什么时候、
     *    给哪个班的哪个账号换的"必须查得到 —— 这是口令类动作唯一能留下的证据。
     */
    const actorName = await nameOf(env, uid)
    const targetLabel = `${cls.name} · ${existing.email}`
    const auditedBefore = await auditRow(env, {
      actorId: uid,
      actorName,
      action: 'classroom.reset',
      target: targetLabel,
      detail: '重置前：即将给这个教室端账号生成一个新的随机密码，旧密码下一步立刻失效',
      affected: 1,
    })

    const password = makePassword()
    const upd = await putPassword(env, existing.id, password)
    if (!upd.ok) {
      /* 失败也是写动作（试过一次），照旧留痕 —— 否则"重置失败"在流水里看不见 */
      const code = upd.status
      const detail = (await upd.text()).slice(0, 200)
      const auditedFail = await auditRow(env, {
        actorId: uid,
        actorName,
        action: 'classroom.reset',
        target: targetLabel,
        detail: `重置失败（GoTrue HTTP ${code}）：密码没有改，旧密码照旧可用`,
        affected: 0,
      })
      return json(
        {
          status: 'error',
          message: '重置密码失败',
          detail,
          audited: auditedBefore && auditedFail,
        },
        502,
      )
    }
    const auditedAfter = await auditRow(env, {
      actorId: uid,
      actorName,
      action: 'classroom.reset',
      target: targetLabel,
      detail: '重置成功：新密码已在回话里交给操作者一次，库里不存原文',
      affected: 1,
    })
    if (existing.disabled) {
      await sb(env, `/rest/v1/classroom_accounts?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ disabled: false }),
      })
    }
    return json({
      status: 'ok',
      audited: auditedBefore && auditedAfter,
      account: accountOf(cls, { ...existing, disabled: false }, password),
    })
  }

  /*
   * 🆕 `set` = **班主任自己定一个口令**（用户要的就是这一句："密码能不能由班主任自己设置"）。
   *
   * 🔴 与 `reset` 的差别**只有一处**：`password` 换成**调用者传进来的**那个值（不是 `makePassword()`）。
   *    闸门还是上面那一刀 `mayManage()`（**不新写判据**）、账号还是 `existing.id`、
   *    写入还是同一个 `putPassword()`。
   * ⚠️ **不要求旧口令**：班主任已经登录（上面 `callerId` 那一步），而且旧口令原文
   *    谁也拿不到（GoTrue 存的是哈希）—— "先输旧口令"这件事在原理上就做不到。
   * ⚠️ 口令**只去 `auth.users`**：业务库 `classroom_accounts` 一个字段都不写
   *    （那一行里没有任何一列等于新口令）。
   */
  if (action === 'set') {
    if (!existing) return json({ status: 'error', message: '这个班还没有教室端账号' }, 404)
    const password = typeof body.password === 'string' ? body.password : ''
    const bad = passwordProblem(password)
    // 不合规：400 + 说清哪一条不合规，**不静默、也不去打 GoTrue**
    if (bad) return json({ status: 'error', message: bad }, 400)

    const actorName = await nameOf(env, uid)
    const targetLabel = `${cls.name} · ${existing.email}`
    const auditedBefore = await auditRow(env, {
      actorId: uid,
      actorName,
      action: 'classroom.set',
      target: targetLabel,
      detail: '自设口令前：班主任自己定的新密码即将生效，旧密码同时失效',
      affected: 1,
    })

    const upd = await putPassword(env, existing.id, password)
    if (!upd.ok) {
      /*
       * 🔴 失败**不许静默**：GoTrue 那句关键信息原样带回给调用者，状态码也照它来
       *    （4xx 一律翻成 400，好让前端把这句话原样摆出来，而不是被翻译成"没权限"）。
       * ⚠️ 这时**旧口令保持不变** —— PUT 没成功，GoTrue 那边一个字节都没改。
       */
      const code = upd.status
      const raw = (await upd.text()).slice(0, 200)
      const reason = goTrueReason(raw)
      const auditedFail = await auditRow(env, {
        actorId: uid,
        actorName,
        action: 'classroom.set',
        target: targetLabel,
        detail: `自设口令失败（GoTrue HTTP ${code}）：密码没有改，旧密码照旧可用`,
        affected: 0,
      })
      return json(
        {
          status: 'error',
          message: `设置密码失败（GoTrue HTTP ${code}）${reason ? `：${reason}` : ''}`,
          detail: raw,
          audited: auditedBefore && auditedFail,
        },
        code >= 400 && code < 500 ? 400 : 502,
      )
    }

    const auditedAfter = await auditRow(env, {
      actorId: uid,
      actorName,
      action: 'classroom.set',
      target: targetLabel,
      detail: '自设口令成功：新密码已在回话里交给操作者一次，库里不存原文',
      affected: 1,
    })
    if (existing.disabled) {
      await sb(env, `/rest/v1/classroom_accounts?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ disabled: false }),
      })
    }
    return json({
      status: 'ok',
      audited: auditedBefore && auditedAfter,
      account: accountOf(cls, { ...existing, disabled: false }, password),
    })
  }

  // action === 'create'
  if (existing) {
    return json(
      {
        status: 'exists',
        message: '这个班已经有教室端账号了。要找回密码就点「重置密码」，会生成一串新的。',
        account: accountOf(cls, existing),
      },
      409,
    )
  }

  const email = await pickEmail(env, cls.name)
  const password = makePassword()

  const created = await fetch(`${baseUrl(env)}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      // 教室端用的是自己生成的内部邮箱，没有收信的地方，直接标记已确认
      email_confirm: true,
      user_metadata: { name: displayName, kind: 'classroom' },
    }),
  })
  const createdText = await created.text()
  if (!created.ok) {
    return json(
      {
        status: 'error',
        message: '创建账号失败',
        detail: createdText.slice(0, 300),
      },
      502,
    )
  }
  const newUser = JSON.parse(createdText || '{}') as { id?: string }
  if (!newUser.id) {
    return json({ status: 'error', message: '创建账号失败：没有拿到用户 id' }, 502)
  }

  const ins = await sb(env, `/rest/v1/classroom_accounts`, {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: newUser.id,
      class_id: classId,
      school_id: cls.school_id,
      name: displayName,
      email,
      created_by: uid,
    }),
  })
  if (!ins.ok) {
    // 建好了 auth 用户却没写进 classroom_accounts，会留下一个能登录、
    // 但系统里不认的孤儿账号 —— 回滚掉，别留。
    await fetch(`${baseUrl(env)}/auth/v1/admin/users/${newUser.id}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    })
    return json(
      {
        status: 'error',
        message: '建账号时写库失败，已回滚',
        detail: (await ins.text()).slice(0, 300),
      },
      502,
    )
  }

  return json({
    status: 'ok',
    account: accountOf(cls, { id: newUser.id, email, disabled: false }, password),
  })
}
