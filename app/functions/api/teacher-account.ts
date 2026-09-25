/**
 * 教师账号的创建 / 重置密码 / 任课关系 / 身份指派。
 *
 * 为什么必须放服务端：在浏览器里创建 Supabase 账号**必须**用管理员密钥（service_role），
 * 而这个密钥一旦进了前端产物就等于公开。所以照 `classroom-account.ts` 那套做：
 * 教师端发起 → 这个 Function 用 service_role 代劳。
 *
 * 🔴 安全边界：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处：
 *    数据库里 `schema.sql` §13.2 的函数
 *      `can_create_teacher_accounts()`  **建号 / 任课关系 / 重置密码**
 *          最高管理员 + 教务处 + 🆕办公室主任
 *      `can_assign_roles()`             **指派身份**
 *          最高管理员 + 教务处（🔴 **不含办公室主任** —— 见下）
 *      `is_super_admin()`               **只有**最高管理员：留给"交接超管身份"这类事
 *    这里拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 去问（auth.uid() 就是调用者）。
 *
 *  🆕 2026-09-28 第二轮：**部门归属**（老师 ↔ 职能部门）也走这个 Function 的 `department` 动作。
 *     · 判据用 `can_create_teacher_accounts`（超管 / 教务处 / **办公室主任**）——
 *       部门是**档案属性**（"他在哪个处室"），不是身份，所以与"建号 / 任课关系 / 重置密码"
 *       同一档，**不是** `can_assign_roles`（那一档不含办公室主任）。
 *     · 🔴 也**不再新立一个判据函数**：同一个集合写成第二个函数就是"同一件事两个口径"（I17）。
 *     · 写法是**批量**的（界面上的多选）：一次请求加/去一批 (老师 × 部门)，
 *       因为用户的口径是"开学时不要手工点几百下"。
 *
 *  🔴 **2026-09-28：拆成两个函数（建号 ≠ 指派身份）** —— `管理架构与角色权限方案.md` §三.4 的 N-1。
 *     新架构里唯一变宽的写权限是「办公室主任建号」，而 `can_manage_teachers()` 原本
 *     **同时**管建号 / 任课关系 / **指派身份**三件事：
 *       直接给它加 `office_head` → **办公室主任就能给自己发一条 `super`**。
 *     所以先拆，再放行。拆完之后：
 *       · `create` / `assign`（任课关系）/ `reset`  → 问 `can_create_teacher_accounts`
 *       · `role`（指派身份）                        → 问 `can_assign_roles`
 *     ⚠️ **两处 RPC 名字必须与 schema 里的函数逐字一致**：拼错了会拿到 'missing'
 *        → 503「数据库还没跑第 13 段」，而真正的原因是这个 Function 写错了名字。
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

/**
 * 身份代码 —— 与 `teacher_roles.role` 的 check 约束**逐字相同**（`schema.sql` §10.1.1）。
 * ⚠️ `classroom`（教室端）**不在里面**：它不是 `teacher_roles` 的一档，
 *    而是 `classroom_accounts` 里的一行（见 §10.1）。
 */
type RoleCode =
  | 'super'
  | 'admin'
  | 'principal'
  | 'vice_principal'
  | 'principal_assistant'
  | 'office_head'
  | 'moral_edu_head'
  | 'grade_head'
  | 'head_teacher'
  | 'subject_lead'
  | 'lesson_prep_lead'
  | 'teacher'

type Body = {
  action?: 'list' | 'create' | 'reset' | 'assign' | 'role' | 'department'
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
  /** role：组长两档要的学科代码（`subject_lead` / `lesson_prep_lead` 必填） */
  roleSubjectCode?: string
  /** 🆕 department：要加/去的部门代码（收件范围用，见 `DEPARTMENTS`） */
  departments?: string[]
  /** 🆕 department：对哪些老师（多选；与 `departments` 是**笛卡尔积**关系） */
  teacherIds?: string[]
}

/**
 * 🆕 职能部门清单 —— 与数据库 `notice_departments()` **逐字同值**
 * （`supabase/schema.sql` §21.2.2；第三处在界面 `app/src/lib/departments.ts`，
 * `nav-checks` 的 A9 拿源码文本把这几份对齐）。
 *
 * 🔴 **它不是身份**：`teacher_roles` 里的 `admin` = 教务处**主任**（有全部权限），
 *    而"属于教务处"是**档案属性** —— 教务处的干事也属于教务处，但不该拿到 admin 的权限。
 *    把两者合成一个字段就是"一个字段两种语义"，所以这里单独一张表（`teacher_departments`）。
 */
const DEPARTMENTS = ['office', 'academic', 'logistics', 'moral_edu'] as const

/** 一次批量改部门最多几位老师（界面是多选；上限防"一个请求改全校"把 Function 拖死） */
const DEPARTMENT_BATCH_MAX = 100

/** 去掉容易看错、也难念给同事听的字符：I l O 0 1 */
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/**
 * 能指派进 `teacher_roles` 的身份（14 档里除任课教师之外的全部）。
 * `teacher`（任课教师）**不在里面**：任课教师不是一个"头衔"，
 * 而是 `class_subjects` 里的任课关系（见 schema.sql §10.6）。
 * ⚠️ 这份清单是**形状**（哪些值塞得进那一列），**不是权限** ——
 *    谁能指派由 `can_assign_roles()` 判（办公室主任不在里面）。
 */
const ASSIGNABLE: RoleCode[] = [
  'super',
  'admin',
  'principal',
  'vice_principal',
  'principal_assistant',
  'office_head',
  'moral_edu_head',
  'grade_head',
  'head_teacher',
  'subject_lead',
  'lesson_prep_lead',
]

/**
 * 每一档身份的**管辖范围形状** —— 一个字段只能有一种语义（这里是"这一档要不要范围"）。
 *   `none`            scope_type = null、scope_id = null
 *   `grade`           scope_type='grade'、scope_id = 年级 id
 *   `class`           scope_type='class'、scope_id = 班级 id
 *   `subject`         scope_type='subject'、subject_code = 学科代码、scope_id = null
 *   `grade_subject`   scope_type='grade_subject'、scope_id = 年级 id、subject_code = 学科代码
 */
const SCOPE_OF: Record<string, 'none' | 'grade' | 'class' | 'subject' | 'grade_subject'> = {
  super: 'none',
  admin: 'none',
  principal: 'none',
  vice_principal: 'none',
  principal_assistant: 'none',
  office_head: 'none',
  moral_edu_head: 'none',
  grade_head: 'grade',
  head_teacher: 'class',
  subject_lead: 'subject',
  lesson_prep_lead: 'grade_subject',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NEED_STAGE13 =
  '数据库还没跑多学科阶段 3 的权限函数（仓库里 supabase/schema.sql 第 13 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

const NEED_STAGE10 = '数据库还没建权限体系的表（schema.sql 第 10 段）。先跑一遍 schema.sql。'

/** 🆕 部门归属那一张表在 `schema.sql` 第 21 段（通知那一段里的 §21.2.2） */
const NEED_STAGE21 =
  '数据库还没跑部门归属那一段（仓库里 supabase/schema.sql 第 21 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

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

/**
 * 「**表**不在」—— 只认"表/relation 不在"本身：`42P01` / `PGRST205` /
 * 文案里限定过的 `Could not find the table` / `relation … does not exist`。
 *
 * 🔴 这里**不许**写成泛化的 `/does not exist/i`（也不许带上 `schema cache`）：
 *    `Could not find the 'x' column of 'teachers' in the schema cache`（`PGRST204`）之类
 *    说的都是**"这一列不在"** —— 列缺失有它自己那条判据（`isMissingColumn`，下面那个，
 *    调用方会**摘掉那一列重试**）。混在一起的话，一次"列缺失"会被报成
 *    「权限体系的表还没建 / 去跑 schema.sql」（`NEED_STAGE10`），把人指到错误的动作上。
 *
 * ⚠️ `column "x" of relation "y" does not exist` 这种 PG 原生写法在**文案**上与
 *    `relation … does not exist` 撞车 —— 所以这里**先**用 `isMissingColumn()` 把「列不在」摘掉。
 *    口径与 `lib/adminChart.ts` 的 `MISSING_TABLE_RE` 一致。
 */
function isMissingTable(status: number, text: string): boolean {
  if (isMissingColumn(status, text)) return false // 「列不在」先摘出去（判据分流，见上）
  return (
    status === 404 || /42P01|PGRST205|Could not find the table|relation .+ does not exist/i.test(text)
  )
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
  /** 🆕 组长两档的学科代码（第 10.1.1 段之后才有这一列；读不到就当空串） */
  subject_code?: string | null
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

  const [c, g, r, cs, ca, td] = await Promise.all([
    read(await sb(env, '/rest/v1/classes?select=id,name,grade_id&order=created_at')),
    read(await sb(env, '/rest/v1/grades?select=id,name&order=name')),
    /*
     * 🆕 `subject_code` 那一列可能还不存在（第 10.1.1 段没跑）——
     * 与 `primary_subject_code` 同一套判据：**只认「列不存在」，摘掉它重读**，
     * 其余错误照常（沿用下面的空数组兜底）。
     */
    read(await sb(env, '/rest/v1/teacher_roles?select=teacher_id,role,scope_type,scope_id,subject_code')),
    read(await sb(env, '/rest/v1/class_subjects?select=teacher_id,class_id,subject,subject_code')),
    read(await sb(env, '/rest/v1/classroom_accounts?select=id')),
    /*
     * 🆕 部门归属（§21.2.2）。这张表可能还不存在（第 21 段没跑 / 老库）——
     * 它是**附加信息**：读不到就当"还没有人分过部门"，**绝不能让整页打不开**。
     */
    read(await sb(env, '/rest/v1/teacher_departments?select=teacher_id,department')),
  ])

  // 任何一张附属表读不到（第 10/12 段没跑）都只当"空" —— 列表照常出来，
  // 缺的那一列/那张表在界面上表现为"还没维护"，而不是整页报错
  let subjectJoins = cs.rows as unknown as SubjectJoin[]
  if (!cs.ok && isMissingColumn(cs.status, cs.text)) {
    const retry = await read(await sb(env, '/rest/v1/class_subjects?select=teacher_id,class_id,subject'))
    subjectJoins = (retry.ok ? retry.rows : []) as unknown as SubjectJoin[]
  }
  let roleRows = r.rows as unknown as RoleRow[]
  if (!r.ok && isMissingColumn(r.status, r.text)) {
    const retry = await read(await sb(env, '/rest/v1/teacher_roles?select=teacher_id,role,scope_type,scope_id'))
    roleRows = (retry.ok ? retry.rows : []) as unknown as RoleRow[]
  }
  const classes = (c.ok ? c.rows : []) as unknown as ClassRow[]
  const grades = (g.ok ? g.rows : []) as unknown as GradeRow[]
  const roles = roleRows
  const roomIds = new Set((ca.ok ? ca.rows : []).map((x) => String(x.id)))
  /* 🆕 部门归属：表不在 / 读不到 → 空数组（页面上表现为"还没有维护过"，不是整页报错） */
  const deptRows = (td.ok ? td.rows : []) as { teacher_id?: string; department?: string }[]

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
          /*
           * 🆕 学科代码要**原样带回去**：界面上"取消这个身份"按它拼删除条件，
           * 少了它那一行就删不掉（看起来取消成功了、其实还在）。
           */
          subjectCode: x.subject_code ?? '',
          scopeLabel:
            x.scope_type === 'class'
              ? (classNames.get(String(x.scope_id)) ?? '')
              : x.scope_type === 'grade' || x.scope_type === 'grade_subject'
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
      /* 🆕 他属于哪些部门（可能 0 个、可能多个 —— §21.2.2 的形状） */
      departments: deptRows
        .filter((x) => String(x.teacher_id) === t.id)
        .map((x) => String(x.department ?? ''))
        .filter(Boolean)
        .sort(),
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
  /*
   * 🔴 **两处 RPC、两种语义**（2026-09-28 拆函数）：
   *    · "建号 / 任课关系 / 重置密码" → `can_create_teacher_accounts`（含办公室主任）
   *    · "指派身份"                   → `can_assign_roles`（**不含**办公室主任）
   * 把两者合成一次判断 = 把"建号"与"决定谁当班主任"合成一件事 ——
   * 而后者正是用户说的"人员招聘 ≠ 决定谁当班主任"。
   */
  const mayCreate = await rpcBool(env, me.token, 'can_create_teacher_accounts')
  if (mayCreate === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!mayCreate) {
    return json(
      {
        status: 'error',
        message:
          '只有最高管理员、教务处和办公室主任能建教师账号。你的账号在 teacher_roles 里没有 super / admin / office_head 行 —— 见 schema.sql §10.6 的角色指派模板。',
      },
      403,
    )
  }

  /*
   * 指派身份比建号**窄一档**：教务处 + 最高管理员（用户 2026-09-27 原话：
   * 「班主任，年级主任的身份也要由行政管理（教务处）给」）。
   * 🔴 办公室主任**不在**这里 —— 他建号，但不决定谁当班主任 / 年级主任 / 组长。
   * ⚠️ 这一句**只在 `role` 动作里才真正判**（放在这里是为了让"读一次"变成"读两处"之前
   *    就先把它算出来；算出来不影响 create / assign / reset 的放行）。
   */
  const mayAssign = await rpcBool(env, me.token, 'can_assign_roles')
  if (mayAssign === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)

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

  /* ---------------- role：指派身份（**教导处 + 最高管理员**） ---------------- */
  if (action === 'role') {
    /*
     * 🔴 **指派身份 = 比建号更窄的一档**（2026-09-28 拆函数，方案 §三.4 的 N-1）。
     *    办公室主任能建号（`mayCreate` 为真），但**不能**走到这里 ——
     *    否则他就能给自己发一条 `super`。
     */
    if (!mayAssign) {
      return json(
        {
          status: 'error',
          message:
            '只有最高管理员和教务处能指派身份。办公室主任可以建账号，但不能决定谁当班主任 / 年级主任 / 组长 —— 这是两件事。',
        },
        403,
      )
    }
    const teacherId = String(body.teacherId ?? '').trim()
    const role = String(body.role ?? '').trim() as RoleCode
    const scopeId = String(body.scopeId ?? '').trim()
    const roleSubjectCode = String(body.roleSubjectCode ?? '').trim()
    const on = body.on !== false

    if (!UUID_RE.test(teacherId)) return json({ status: 'error', message: '没有指定老师' }, 400)
    if (!ASSIGNABLE.includes(role)) return json({ status: 'error', message: '这个身份不能指派' }, 400)

    /*
     * 管辖范围必须和身份对得上（不然权限判据永远匹配不到，看起来"指派成功了"其实没生效）。
     * 🆕 2026-09-28：从"两档逐档写 if"改成**一张形状表**（`SCOPE_OF`）——
     *    14 档里现在有五种形状（none / grade / class / subject / grade_subject），
     *    再逐档写 if 就是"同一件事五个判定入口"。
     */
    const shape = SCOPE_OF[role]
    let scope: string | null = null
    let subjectCode: string | null = null

    if (shape === 'grade' || shape === 'grade_subject') {
      if (!UUID_RE.test(scopeId)) {
        return json(
          {
            status: 'error',
            message:
              shape === 'grade_subject'
                ? '备课组长要指定一个年级（外加一个学科）'
                : '年级主任要指定一个年级',
          },
          400,
        )
      }
      const check = await read(await sb(env, `/rest/v1/grades?select=id&id=eq.${scopeId}`))
      if (!check.ok || check.rows.length === 0) {
        return json({ status: 'error', message: '找不到这个年级' }, 404)
      }
      scope = scopeId
    } else if (shape === 'class') {
      if (!UUID_RE.test(scopeId)) {
        return json({ status: 'error', message: '班主任要指定一个班级' }, 400)
      }
      const check = await read(await sb(env, `/rest/v1/classes?select=id&id=eq.${scopeId}`))
      if (!check.ok || check.rows.length === 0) {
        return json({ status: 'error', message: '找不到这个班级' }, 404)
      }
      scope = scopeId
    }

    if (shape === 'subject' || shape === 'grade_subject') {
      /*
       * 🔴 组长两档**必须带学科代码**：少了它，组长在平台里等于一位普通任课老师
       *    （判据永远匹配不到），而界面上看起来"指派成功了"。
       * ⚠️ 学科代码要**在字典里真的存在** —— 不猜、也不替他挑一科。
       */
      if (!isCode(roleSubjectCode)) {
        return json(
          {
            status: 'error',
            message: role === 'subject_lead' ? '教研组长要指定一个学科' : '备课组长要指定一个学科',
          },
          400,
        )
      }
      const dict = await subjectRow(env, roleSubjectCode)
      if (dict === 'reject') {
        return json(
          {
            status: 'error',
            message: `数据库的学科字典（subjects 表）里没有「${roleSubjectCode}」这一科。先跑 schema.sql 第 12 段。`,
          },
          400,
        )
      }
      subjectCode = roleSubjectCode
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
      /*
       * 删的键要和插的键**逐字一致**，否则删不掉 ——
       * 而"看起来取消成功了、其实那行还在"是一处真实的权限残留（这个坑踩过一次）。
       * 所以这里按 `SCOPE_OF` 拼四种键，**不再**手写 `role === 'grade_head' ? … : …`。
       */
      const parts = [`teacher_id=eq.${teacherId}`, `role=eq.${role}`]
      if (shape === 'none') {
        parts.push('scope_type=is.null', 'scope_id=is.null', 'subject_code=is.null')
      } else {
        parts.push(`scope_type=eq.${shape}`)
        parts.push(scope ? `scope_id=eq.${scope}` : 'scope_id=is.null')
        parts.push(subjectCode ? `subject_code=eq.${subjectCode}` : 'subject_code=is.null')
      }
      const res = await read(
        await sb(env, `/rest/v1/teacher_roles?${parts.join('&')}`, {
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

    /*
     * 写入。⚠️ `subject_code` 那一列可能还不存在（第 10.1.1 段没跑）——
     * 与 `ensureSubjectCols()` 同一套判据：只认「列不存在」，**摘掉那一列重试**，
     * 其余错误照报。不这么做的话，组长那两档在旧库上会整条失败。
     */
    const post = (row: Record<string, unknown>) =>
      sb(env, '/rest/v1/teacher_roles', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      })
    const payload: Record<string, unknown> = {
      teacher_id: teacherId,
      role,
      scope_type: shape === 'none' ? null : shape,
      scope_id: scope,
    }
    let missedSubjectCol = false
    let res = await read(await post({ ...payload, subject_code: subjectCode }))
    if (!res.ok && isMissingColumn(res.status, res.text)) {
      missedSubjectCol = true
      res = await read(await post(payload))
    }
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
    return json({
      status: 'ok',
      warnings: missedSubjectCol
        ? [
            '数据库还没跑第 10.1.1 段（teacher_roles 没有 subject_code 这一列），' +
              '所以组长两档的学科没记下来 —— 他登录后看不到本学科的数据。跑过 schema.sql 之后重新指派一次即可。',
          ]
        : undefined,
    })
  }

  /* ---------------- department：部门归属（🆕 批量；判据同"建号"那一档） ---------------- */
  if (action === 'department') {
    /*
     * 🔴 **判据**：`can_create_teacher_accounts`（超管 / 教务处 / 办公室主任）——
     *    上面已经问过数据库了（`mayCreate`），这里**不重写规则**。
     *    为什么不是 `can_assign_roles`：部门是**档案属性**，不是身份（见文件头那段）。
     */
    const departments = [
      ...new Set(
        (Array.isArray(body.departments) ? body.departments : [])
          .map((v) => String(v).trim())
          .filter(Boolean),
      ),
    ]
    const teacherIds = [
      ...new Set(
        (Array.isArray(body.teacherIds) ? body.teacherIds : [])
          .map((v) => String(v).trim())
          .filter((v) => UUID_RE.test(v)),
      ),
    ]
    const on = body.on !== false

    if (!teacherIds.length) return json({ status: 'error', message: '还没有选中老师' }, 400)
    if (!departments.length) return json({ status: 'error', message: '还没有选中部门' }, 400)
    if (teacherIds.length > DEPARTMENT_BATCH_MAX) {
      return json(
        { status: 'error', message: `一次最多改 ${DEPARTMENT_BATCH_MAX} 位老师，分几次来` },
        400,
      )
    }
    /* 形状校验：部门代码必须是那四个之一（与数据库 `notice_departments()` 同一组） */
    const unknown = departments.filter((d) => !(DEPARTMENTS as readonly string[]).includes(d))
    if (unknown.length) {
      return json(
        { status: 'error', message: `不认识的部门：${unknown.join('、')}` },
        400,
      )
    }

    /*
     * 🔴 教室端账号**不是**"某个部门的人"（与 `notice_recipient_ids_for` 那一支同一口径）。
     *    分块查：一批最多 50 个 id，免得 URL 太长（PostgREST 走的是 query string）。
     *    ⚠️ 这一步**不是**安全边界（真正的边界在收件人函数里），它只是把用户的操作错误
     *    在写之前说清楚 —— 所以查不到（老库没有那张表）就直接放行。
     */
    for (let i = 0; i < teacherIds.length; i += 50) {
      const part = teacherIds.slice(i, i + 50)
      const rooms = await read(
        await sb(env, `/rest/v1/classroom_accounts?select=id&id=in.(${part.join(',')})`),
      )
      if (rooms.ok && rooms.rows.length) {
        return json(
          {
            status: 'error',
            message: '所选老师里有教室端账号 —— 它不是老师，不能分到部门',
          },
          400,
        )
      }
      if (!rooms.ok && isMissing(rooms)) break
    }

    if (!on) {
      /*
       * 移除：一次删掉"所选老师 × 所选部门"那些行。
       * ⚠️ 键要与写入时**逐字一致**（`teacher_id` + `department`），
       *    否则会出现"看起来移除了、其实那一行还在"（这个坑在身份那一支踩过一次）。
       */
      const res = await read(
        await sb(
          env,
          `/rest/v1/teacher_departments?teacher_id=in.(${teacherIds.join(',')})` +
            `&department=in.(${departments.map(encodeURIComponent).join(',')})`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
        ),
      )
      if (!res.ok) {
        return json(
          {
            status: 'error',
            message: isMissing(res) ? NEED_STAGE21 : '去掉部门失败',
            detail: res.text.slice(0, 200),
          },
          isMissing(res) ? 503 : 502,
        )
      }
      return json({ status: 'ok' })
    }

    /* 加上：**一次请求写一批**（笛卡尔积）。
     * ⚠️ `on_conflict` + `resolution=ignore-duplicates` = `ON CONFLICT DO NOTHING`：
     *    "这个人已经在这个部门里"是幂等的情形，不该整批失败（主键是 (teacher_id, department)）。 */
    const rows = teacherIds.flatMap((teacher_id) =>
      departments.map((department) => ({ teacher_id, department })),
    )
    const res = await read(
      await sb(env, '/rest/v1/teacher_departments?on_conflict=teacher_id,department', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      }),
    )
    /* 23505 = 冲突（个别 PostgREST 版本会这么答）也算成功：那些行本来就在 */
    if (!res.ok && !/23505|duplicate key|conflict/i.test(res.text)) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE21 : '写部门归属失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }
    return json({ status: 'ok', pairs: rows.length })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}
