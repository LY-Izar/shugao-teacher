/**
 * 教室端账号的创建 / 重置 / 停用。
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
  /** create = 建账号；reset = 换密码；disable / enable = 停用或恢复 */
  action?: 'create' | 'reset' | 'disable' | 'enable'
  classId?: string
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
 */
function isMissingTable(status: number, text: string): boolean {
  return status === 404 || /42P01|does not exist|schema cache/i.test(text)
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

type ClassRow = { id: string; name: string; grade_id: string | null; school_id: string | null }
type RoleRow = { role: string; scope_type: string | null; scope_id: string | null }

/**
 * 这个人能不能管这个班的教室端账号？
 * 规则（用户已确认）：最高管理员 / 年级主任（本年级）/ 班主任（本班）。
 * 任课教师不行 —— 任课关系是「能不能批改」的判据，不是「能不能建账号」的判据。
 */
function mayManage(roles: RoleRow[], cls: ClassRow): boolean {
  return roles.some((r) => {
    if (r.role === 'super' || r.role === 'admin') return true
    if (r.role === 'grade_head') return cls.grade_id != null && r.scope_id === cls.grade_id
    if (r.role === 'head_teacher') return r.scope_id === cls.id
    return false
  })
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
        message: '只有班主任、年级主任或最高管理员能给这个班建教室端账号',
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
  const existing = (JSON.parse(existingText || '[]') as {
    id: string
    email: string
    disabled: boolean
  }[])[0]

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
      account: { classId, name: displayName, email: existing.email, disabled: action === 'disable' },
    })
  }

  if (action === 'reset') {
    if (!existing) return json({ status: 'error', message: '这个班还没有教室端账号' }, 404)
    const password = makePassword()
    const upd = await fetch(`${baseUrl(env)}/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    })
    if (!upd.ok) {
      return json(
        {
          status: 'error',
          message: '重置密码失败',
          detail: (await upd.text()).slice(0, 200),
        },
        502,
      )
    }
    if (existing.disabled) {
      await sb(env, `/rest/v1/classroom_accounts?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ disabled: false }),
      })
    }
    return json({
      status: 'ok',
      account: { classId, name: displayName, email: existing.email, password },
    })
  }

  // action === 'create'
  if (existing) {
    return json(
      {
        status: 'exists',
        message: '这个班已经有教室端账号了。要找回密码就点「重置密码」，会生成一串新的。',
        account: { classId, name: displayName, email: existing.email, disabled: existing.disabled },
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
    account: { classId, name: displayName, email, password },
  })
}
