/**
 * 教师账号的创建 / 重置密码 / 任课关系 / 身份指派。
 *
 * 为什么必须放服务端：在浏览器里创建 Supabase 账号**必须**用管理员密钥（service_role），
 * 而这个密钥一旦进了前端产物就等于公开。所以照 `classroom-account.ts` 那套做：
 * 教师端发起 → 这个 Function 用 service_role 代劳。
 *
 * 🔴 安全边界：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处：
 *    数据库里 `schema.sql` §13.2 的两个函数
 *      `can_manage_teachers()`  最高管理员 + 行政老师：建号 / 任课关系 / 重置密码
 *      `is_super_admin()`       **只有**最高管理员：指派身份（班主任 / 年级主任 / 行政 / 最高管理员）
 *    这里拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 去问（auth.uid() 就是调用者）。
 *
 * 部署：<项目根>/functions/api/teacher-account.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量（与 classroom-account 共用同一套）：
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

type RoleCode = 'super' | 'admin' | 'grade_head' | 'head_teacher'

type Body = {
  action?: 'list' | 'create' | 'reset' | 'assign' | 'role'
  /** create */
  name?: string
  email?: string
  password?: string
  /** 学科：code 是判据（进 primary_subject_code），name 是显示名（进 teachers.subject） */
  subjectCode?: string
  subject?: string
  school?: string
  classIds?: string[]
  /** reset / assign / role */
  teacherId?: string
  /** assign */
  classId?: string
  on?: boolean
  /** role */
  role?: string
  scopeType?: string
  scopeId?: string
}

/** 去掉容易看错、也难念给同事听的字符：I l O 0 1 */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 能指派进 teacher_roles 的身份。`teacher`（任课教师）**不在里面**：
 *  任课教师不是一个"头衔"，而是 `class_subjects` 里的任课关系（见 schema.sql §10.6）。 */
const ASSIGNABLE: RoleCode[] = ['super', 'admin', 'grade_head', 'head_teacher']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NEED_STAGE13 =
  '数据库还没跑多学科阶段 3 的权限函数（仓库里 supabase/schema.sql 第 13 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

const NEED_STAGE10 = '数据库还没建权限体系的表（schema.sql 第 10 段）。先跑一遍 schema.sql。'

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
 * 把一次响应读完（**身体只能读一次**，所以统一在这里读，别处不再 clone）。
 * 解析不出数组就当空数组 —— 调用方只看 `ok` 与 `text`。
 */
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

function isMissingTable(status: number, text: string): boolean {
  return status === 404 || /42P01|PGRST205|does not exist|schema cache/i.test(text)
}

/**
 * 「这一列在不在」。
 *
 * 线上库可能还没跑多学科阶段 1（`teachers.primary_subject_code` /
 * `class_subjects.subject_code` 还不存在）。带上一列不存在的列去写，
 * **整条请求会被拒**，而这里做的是"建号"这种不能半途而废的事 ——
 * 所以按 `app/src/data/remote.ts` 的 `ensureSubjectCols()` 同一套判据：
 * 只认「列不存在」这一种错误，**摘掉那一列重试**，其余错误照常报。
 */
function isMissingColumn(status: number, text: string): boolean {
  return status === 400 && /42703|PGRST204|column .*does not exist/i.test(text)
}

const isMissing = (r: Read) => isMissingTable(r.status, r.text) || isMissingColumn(r.status, r.text)

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
 * 问数据库：这个权限函数对我返回什么？
 * 返回 'missing' = 函数还没建（第 13 段没跑）。调用方要把它翻译成人话，
 * **不能当成 false** —— 那样会告诉管理员"你没权限"，而他其实是超管。
 */
async function rpcBool(env: Env, token: string, fn: string): Promise<boolean | 'missing'> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const text = await res.text()
  if (res.ok) return text.trim() === 'true'
  if (res.status === 401 || res.status === 403) return false
  if (res.status === 404 || /PGRST202|does not exist|schema cache/i.test(text)) return 'missing'
  return false
}

/* ---------------- 小工具 ---------------- */

function makePassword(len = 12): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length]
  return out
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
const isCode = (s: string) => /^[a-z][a-z0-9_]{1,23}$/.test(s)

/**
 * 学科：code → 字典里的显示名。
 *
 * 字典的权威在 **`subjects` 表**（`lib/subjects.ts` 是它的前端镜像）。
 * 表还没建（第 12 段没跑）时返回 `null`，调用方退回用界面上选中的显示名 ——
 * 那条路照样能让新老师第一次登录时 chip 预选正确（前端按显示名反查字典）。
 * 🔴 认不出来时**不猜**：表在、但这个 code 不在表里 → 直接报错，不替他挑一科。
 */
async function subjectRow(env: Env, code: string): Promise<{ name: string } | null | 'reject'> {
  const res = await sb(env, `/rest/v1/subjects?select=name&code=eq.${encodeURIComponent(code)}`)
  const r = await read(res)
  if (!r.ok) return isMissing(r) ? null : 'reject'
  const name = String((r.rows[0] as { name?: string } | undefined)?.name ?? '').trim()
  return name ? { name } : 'reject'
}

/* ---------------- 读：教师列表（建号页要用的那份） ---------------- */

type ClassRow = { id: string; name: string; grade_id?: string | null }
type GradeRow = { id: string; name: string }
type RoleRow = {
  teacher_id: string
  role: string
  scope_type: string | null
  scope_id: string | null
}
type SubjectJoin = {
  teacher_id: string
  class_id: string
  subject: string
  subject_code?: string | null
}
type TeacherRow = {
  id: string
  name: string
  subject: string
  primary_subject_code?: string | null
  school?: string
}

async function loadDirectory(env: Env) {
  // 先按"新列存在"读，列不存在就摘掉它重读 —— 与前端 ensureSubjectCols() 同一套判据
  const base = 'id,name,subject,school,created_at'
  let tRes = await read(await sb(env, `/rest/v1/teachers?select=${base},primary_subject_code&order=created_at`))
  if (!tRes.ok && isMissingColumn(tRes.status, tRes.text)) {
    tRes = await read(await sb(env, `/rest/v1/teachers?select=${base}&order=created_at`))
  }
  if (!tRes.ok) {
    return { error: isMissing(tRes) ? NEED_STAGE10 : `读教师失败：${tRes.text.slice(0, 200)}` }
  }

  const [c, g, r, cs, ca] = await Promise.all([
    read(await sb(env, '/rest/v1/classes?select=id,name,grade_id&order=created_at')),
    read(await sb(env, '/rest/v1/grades?select=id,name&order=name')),
    read(await sb(env, '/rest/v1/teacher_roles?select=teacher_id,role,scope_type,scope_id')),
    read(await sb(env, '/rest/v1/class_subjects?select=teacher_id,class_id,subject,subject_code')),
    read(await sb(env, '/rest/v1/classroom_accounts?select=id')),
  ])

  // 任何一张附属表读不到（第 10/12 段没跑）都只当"空" —— 列表照常出来，
  // 缺的那一列/那张表在界面上表现为"还没维护"，而不是整页报错
  let subjectJoins = cs.rows as unknown as SubjectJoin[]
  if (!cs.ok && isMissingColumn(cs.status, cs.text)) {
    const retry = await read(await sb(env, '/rest/v1/class_subjects?select=teacher_id,class_id,subject'))
    subjectJoins = (retry.ok ? retry.rows : []) as unknown as SubjectJoin[]
  }
  const classes = (c.ok ? c.rows : []) as unknown as ClassRow[]
  const grades = (g.ok ? g.rows : []) as unknown as GradeRow[]
  const roles = (r.ok ? r.rows : []) as unknown as RoleRow[]
  const roomIds = new Set((ca.ok ? ca.rows : []).map((x) => String(x.id)))

  const classNames = new Map(classes.map((x) => [x.id, x.name]))
  const gradeNames = new Map(grades.map((x) => [x.id, x.name]))

  const teachers = (tRes.rows as unknown as TeacherRow[])
    // 教室端账号也有一行 teachers（触发器给每个 auth 用户都建），别把它当成老师列出来
    .filter((t) => !roomIds.has(t.id))
    .map((t) => ({
      id: t.id,
      name: t.name,
      subject: t.subject,
      primarySubjectCode: t.primary_subject_code ?? null,
      school: t.school ?? '',
      roles: roles
        .filter((x) => x.teacher_id === t.id)
        .map((x) => ({
          role: x.role,
          scopeType: x.scope_type ?? '',
          scopeId: x.scope_id ?? '',
          scopeLabel:
            x.scope_type === 'class'
              ? (classNames.get(String(x.scope_id)) ?? '')
              : x.scope_type === 'grade'
                ? (gradeNames.get(String(x.scope_id)) ?? '')
                : '',
        })),
      subjects: subjectJoins
        .filter((x) => x.teacher_id === t.id)
        .map((x) => ({
          classId: x.class_id,
          className: classNames.get(x.class_id) ?? '',
          subjectCode: x.subject_code ?? '',
          subject: x.subject,
        })),
    }))

  return { teachers, classes, grades }
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

  // ---- 1. 这是谁？ ----
  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  // ---- 2. 他有没有这个权限？（判据在数据库，不在这里重写规则）----
  const mayManage = await rpcBool(env, me.token, 'can_manage_teachers')
  if (mayManage === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!mayManage) {
    return json(
      {
        status: 'error',
        message:
          '只有最高管理员和行政老师能管理教师账号。你的账号在 teacher_roles 里没有 super / admin 行 —— 见 schema.sql §10.6 的角色指派模板。',
      },
      403,
    )
  }
  /** 指派身份只有最高管理员能做（行政老师不行）—— 这是两种身份的分界之一 */
  const needSuper = async (): Promise<Response | null> => {
    const isSuper = await rpcBool(env, me.token, 'is_super_admin')
    if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
    if (!isSuper) {
      return json(
        {
          status: 'error',
          message:
            '指派身份（班主任 / 年级主任 / 行政老师 / 最高管理员）只有最高管理员能做。建号、任课关系、重置密码不受影响。',
        },
        403,
      )
    }
    return null
  }

  /* ---------------- list ---------------- */
  if (action === 'list') {
    const dir = await loadDirectory(env)
    if ('error' in dir) return json({ status: 'error', message: dir.error }, 502)
    return json({ status: 'ok', canManage: true, ...dir })
  }

  /* ---------------- create：建号（学科必须带上） ---------------- */
  if (action === 'create') {
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const code = String(body.subjectCode ?? '').trim()
    let subjectLabel = String(body.subject ?? '').trim()

    if (!name) return json({ status: 'error', message: '请填老师姓名' }, 400)
    if (!isEmail(email)) {
      return json({ status: 'error', message: '邮箱格式不对（例如 123456@qq.com）' }, 400)
    }
    if (!isCode(code)) return json({ status: 'error', message: '没有选学科' }, 400)

    const dict = await subjectRow(env, code)
    if (dict === 'reject') {
      return json(
        {
          status: 'error',
          message: `数据库的学科字典（subjects 表）里没有「${code}」这一科。先跑 schema.sql 第 12 段，或核对前端 lib/subjects.ts 与字典是否一致。`,
        },
        400,
      )
    }
    // 字典在就用字典的写法（它是权威），字典还没建就用界面上选中的显示名
    if (dict) subjectLabel = dict.name
    if (!subjectLabel) return json({ status: 'error', message: '没有选学科' }, 400)

    const password = String(body.password ?? '').trim() || makePassword()
    if (password.length < 8) return json({ status: 'error', message: '初始密码至少 8 位' }, 400)

    const classIds = (body.classIds ?? [])
      .map((v) => String(v).trim())
      .filter((v) => UUID_RE.test(v))

    // ---- ① 建 auth 账号 ----
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
        // 管理员建的账号没有"收信确认"这一步：直接标记已确认，否则他登不进去
        email_confirm: true,
        user_metadata: {
          name,
          // ① 显示名：触发器与前端都认它（前端按显示名反查字典 → 学科 chip 预选正确）
          subject: subjectLabel,
          // ② 判据代码：第 13 段跑过之后，触发器会把它写进 primary_subject_code
          subject_code: code,
          school: String(body.school ?? '').trim(),
          kind: 'teacher',
        },
      }),
    })
    const createdText = await created.text()
    if (!created.ok) {
      const dup = /already|registered|exists/i.test(createdText)
      return json(
        {
          status: dup ? 'exists' : 'error',
          message: dup
            ? `这个邮箱已经建过账号了：${email}。忘密码就点「重置密码」。`
            : '创建账号失败',
          detail: createdText.slice(0, 300),
        },
        dup ? 409 : 502,
      )
    }
    const newUser = JSON.parse(createdText || '{}') as { id?: string }
    if (!newUser.id) return json({ status: 'error', message: '创建账号失败：没有拿到用户 id' }, 502)
    const uid = newUser.id

    /** 建了 auth 用户却没把 teachers 行写对 → 回滚，别留一个系统里不认的账号 */
    const rollback = async (message: string, detail: string, status = 502): Promise<Response> => {
      await fetch(`${baseUrl(env)}/auth/v1/admin/users/${uid}`, {
        method: 'DELETE',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      })
      return json({ status: 'error', message: `${message}（已回滚，账号没留下）`, detail }, status)
    }

    // ---- ② 把 teachers 行写对（顺带把主学科落进判据列）----
    // 触发器应该已经建了这一行；万一没有（触发器被停用/换过），就自己插一行。
    const rowBase: Record<string, unknown> = {
      id: uid,
      name,
      subject: subjectLabel,
      school: String(body.school ?? '').trim(),
    }
    const patchTeacher = (row: Record<string, unknown>) =>
      sb(env, `/rest/v1/teachers?id=eq.${uid}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(row),
      })

    let subjectCol = true
    let wrote = await read(await patchTeacher({ ...rowBase, primary_subject_code: code }))
    if (!wrote.ok && isMissingColumn(wrote.status, wrote.text)) {
      // 第 12 段还没跑：判据列不存在 → 摘掉它重写（显示名那条路仍能让 chip 预选正确）
      subjectCol = false
      wrote = await read(await patchTeacher(rowBase))
    }
    if (!wrote.ok) {
      if (isMissingTable(wrote.status, wrote.text)) {
        return rollback(NEED_STAGE10, wrote.text.slice(0, 200), 503)
      }
      return rollback('写教师资料失败', wrote.text.slice(0, 300))
    }

    if (wrote.rows.length === 0) {
      // 触发器没建那一行 → 自己插（service_role 绕过 RLS）
      const post = (row: Record<string, unknown>) =>
        sb(env, '/rest/v1/teachers', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      let ins = await read(await post(subjectCol ? { ...rowBase, primary_subject_code: code } : rowBase))
      if (!ins.ok && isMissingColumn(ins.status, ins.text)) {
        subjectCol = false
        ins = await read(await post(rowBase))
      }
      if (!ins.ok) return rollback('写教师资料失败', ins.text.slice(0, 300))
    }

    // ---- ③ 任课关系（可选）：这位老师教哪几个班这一科 ----
    // 它决定他登录后看得见哪些班、哪一科（visible_class_ids + §13.4 的读策略）
    const warnings: string[] = []
    const relations: { classId: string; ok: boolean; note?: string }[] = []
    for (const classId of classIds) {
      const post = (row: Record<string, unknown>) =>
        sb(env, '/rest/v1/class_subjects', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(row),
        })
      const payload: Record<string, unknown> = {
        class_id: classId,
        subject: subjectLabel,
        teacher_id: uid,
      }
      let res = await read(
        await post(subjectCol ? { ...payload, subject_code: code } : payload),
      )
      if (!res.ok && subjectCol && isMissingColumn(res.status, res.text)) {
        subjectCol = false
        res = await read(await post(payload))
      }
      if (res.ok) relations.push({ classId, ok: true })
      else if (/23505|duplicate key|conflict/i.test(res.text)) relations.push({ classId, ok: true, note: '已有' })
      else if (isMissingTable(res.status, res.text)) {
        relations.push({ classId, ok: false, note: '权限体系的表还没建' })
      } else relations.push({ classId, ok: false, note: res.text.slice(0, 120) })
    }
    const failed = relations.filter((x) => !x.ok)
    if (failed.length) {
      warnings.push(
        `有 ${failed.length} 个班的任课关系没写进去 —— 这位老师登录后看不到那些班。可以在这页上补（任课关系可以随时改）。`,
      )
    }
    if (!subjectCol) {
      warnings.push(
        '数据库还没跑多学科第 12 段（没有 primary_subject_code 这一列），主学科是按「显示名」记的：' +
          '这位老师第一次登录时学科 chip 仍然会预选正确；跑过 schema.sql 第 12 段后回填一下即可。',
      )
    }

    return json({
      status: 'ok',
      account: { id: uid, name, email, password, subjectCode: code, subject: subjectLabel },
      relations,
      warnings,
    })
  }

  /* ---------------- reset：重置密码 ---------------- */
  if (action === 'reset') {
    const teacherId = String(body.teacherId ?? '').trim()
    if (!UUID_RE.test(teacherId)) return json({ status: 'error', message: '没有指定老师' }, 400)
    const room = await read(await sb(env, `/rest/v1/classroom_accounts?select=id&id=eq.${teacherId}`))
    if (room.ok && room.rows.length) {
      return json({ status: 'error', message: '这是教室端账号，不在这里重置' }, 400)
    }
    const password = makePassword()
    const upd = await fetch(`${baseUrl(env)}/auth/v1/admin/users/${teacherId}`, {
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
        { status: 'error', message: '重置密码失败', detail: (await upd.text()).slice(0, 200) },
        502,
      )
    }
    return json({ status: 'ok', password })
  }

  /* ---------------- assign：任课关系（哪个班、哪一科） ---------------- */
  if (action === 'assign') {
    const teacherId = String(body.teacherId ?? '').trim()
    const classId = String(body.classId ?? '').trim()
    const code = String(body.subjectCode ?? '').trim()
    const on = body.on !== false
    if (!UUID_RE.test(teacherId)) return json({ status: 'error', message: '没有指定老师' }, 400)
    if (!UUID_RE.test(classId)) return json({ status: 'error', message: '没有指定班级' }, 400)

    // 学科名：能查到字典就用字典的写法；查不到（老行/第 12 段没跑）用界面上给的显示名
    const dict = isCode(code) ? await subjectRow(env, code) : null
    if (dict === 'reject') {
      return json({ status: 'error', message: `学科字典里没有「${code}」这一科` }, 400)
    }
    const label = dict ? dict.name : String(body.subject ?? '').trim()

    const url = (filter: string) =>
      `/rest/v1/class_subjects?teacher_id=eq.${teacherId}&class_id=eq.${classId}&${filter}`

    if (!on) {
      // 🔴 删的时候**不要求学科代码合法**：第 12 段之前建的任课关系只有显示名，
      //    要求代码就等于"老数据删不掉"。
      //    两条都删：按代码删新行、按显示名删老行。「列不存在」不算错，其余错误照报。
      if (!isCode(code) && !label) {
        return json({ status: 'error', message: '没有指定要删哪一科' }, 400)
      }
      const results: Read[] = []
      if (isCode(code)) {
        results.push(
          await read(
            await sb(env, url(`subject_code=eq.${encodeURIComponent(code)}`), {
              method: 'DELETE',
              headers: { Prefer: 'return=minimal' },
            }),
          ),
        )
      }
      if (label) {
        results.push(
          await read(
            await sb(env, url(`subject=eq.${encodeURIComponent(label)}`), {
              method: 'DELETE',
              headers: { Prefer: 'return=minimal' },
            }),
          ),
        )
      }
      const bad = results.find((x) => !x.ok && !isMissing(x))
      if (bad) {
        return json({ status: 'error', message: '删任课关系失败', detail: bad.text.slice(0, 200) }, 502)
      }
      return json({ status: 'ok' })
    }

    if (!isCode(code)) return json({ status: 'error', message: '没有选学科' }, 400)
    if (!label) return json({ status: 'error', message: '没有选学科' }, 400)

    const post = (row: Record<string, unknown>) =>
      sb(env, '/rest/v1/class_subjects', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      })
    const payload: Record<string, unknown> = { class_id: classId, subject: label, teacher_id: teacherId }
    let subjectCol = true
    let res = await read(await post({ ...payload, subject_code: code }))
    if (!res.ok && isMissingColumn(res.status, res.text)) {
      subjectCol = false
      res = await read(await post(payload))
    }
    if (!res.ok && !/23505|duplicate key|conflict/i.test(res.text)) {
      return json(
        {
          status: 'error',
          message: isMissingTable(res.status, res.text) ? NEED_STAGE10 : '写任课关系失败',
          detail: res.text.slice(0, 200),
        },
        502,
      )
    }
    return json({ status: 'ok', subjectCodeSaved: subjectCol })
  }

  /* ---------------- role：指派身份（**只有最高管理员**） ---------------- */
  if (action === 'role') {
    const denied = await needSuper()
    if (denied) return denied

    const teacherId = String(body.teacherId ?? '').trim()
    const role = String(body.role ?? '').trim() as RoleCode
    const scopeType = String(body.scopeType ?? '').trim()
    const scopeId = String(body.scopeId ?? '').trim()
    const on = body.on !== false

    if (!UUID_RE.test(teacherId)) return json({ status: 'error', message: '没有指定老师' }, 400)
    if (!ASSIGNABLE.includes(role)) return json({ status: 'error', message: '这个身份不能指派' }, 400)

    // 管辖范围必须和身份对得上（不然权限判据永远匹配不到，看起来"指派成功了"其实没生效）
    let scope: string | null = null
    if (role === 'grade_head' || role === 'head_teacher') {
      const want = role === 'grade_head' ? 'grade' : 'class'
      if (scopeType !== want || !UUID_RE.test(scopeId)) {
        return json(
          {
            status: 'error',
            message: role === 'grade_head' ? '年级主任要指定一个年级' : '班主任要指定一个班级',
          },
          400,
        )
      }
      const table = want === 'grade' ? 'grades' : 'classes'
      const check = await read(await sb(env, `/rest/v1/${table}?select=id&id=eq.${scopeId}`))
      if (!check.ok || check.rows.length === 0) {
        return json(
          { status: 'error', message: `找不到这个${want === 'grade' ? '年级' : '班级'}` },
          404,
        )
      }
      scope = scopeId
    }

    // 别把自己唯一那条 super 摘掉 —— 摘了就没人能再指派身份了（把自己锁在门外）
    if (!on && role === 'super' && teacherId === me.id) {
      const mine = await read(
        await sb(env, `/rest/v1/teacher_roles?select=id&teacher_id=eq.${teacherId}&role=eq.super`),
      )
      if (mine.ok && mine.rows.length <= 1) {
        return json(
          {
            status: 'error',
            message:
              '这是你自己最后一条最高管理员身份，摘掉之后就没人能再指派身份了。要交接就先给另一个人加上，再摘自己这条。',
          },
          400,
        )
      }
    }

    if (!on) {
      // 删的键要和插的键一致：super/admin 的 scope 是 null，grade_head/head_teacher 是具体 id。
      // 键不一致就删不掉（看起来"取消成功了"，其实那行还在）—— 所以这里显式拼两套。
      const filter = scope
        ? `teacher_id=eq.${teacherId}&role=eq.${role}` +
          `&scope_type=eq.${role === 'grade_head' ? 'grade' : 'class'}&scope_id=eq.${scope}`
        : `teacher_id=eq.${teacherId}&role=eq.${role}&scope_type=is.null&scope_id=is.null`
      const res = await read(
        await sb(env, `/rest/v1/teacher_roles?${filter}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        }),
      )
      if (!res.ok) {
        return json(
          {
            status: 'error',
            message: isMissing(res) ? NEED_STAGE10 : '取消身份失败',
            detail: res.text.slice(0, 200),
          },
          502,
        )
      }
      return json({ status: 'ok' })
    }

    const res = await read(
      await sb(env, '/rest/v1/teacher_roles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          teacher_id: teacherId,
          role,
          scope_type: scope ? (role === 'grade_head' ? 'grade' : 'class') : null,
          scope_id: scope,
        }),
      }),
    )
    if (!res.ok) {
      if (/23505|duplicate key|conflict/i.test(res.text)) return json({ status: 'ok' })
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE10 : '指派身份失败',
          detail: res.text.slice(0, 200),
        },
        502,
      )
    }
    return json({ status: 'ok' })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}
