/**
 * 开学准备（P6）—— 录名单 / 建班 / 采选科 / 批量写任教关系
 * （`年级管理与选科走班方案.md` §4.3.2 · `选科走班实施计划.md` P6）
 *
 * 🔴 **安全边界**：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处，在数据库：
 *      · `can_manage_grade_setup(grade_id)` —— 录名单 / 建班 / 设班型 / 写任教关系
 *      · `can_edit_student_subject(student_id)` —— 改一个学生的选科
 *    这里拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 去问（`auth.uid()` 就是调用者）。
 *
 * 🔴 **一个事务**：三个写入动作**各是一次 RPC**，不是一串 PostgREST 请求。
 *    PostgREST 一次 RPC = 一个事务 —— 这正是本期验收要钉的那条
 *    （"改一半的情况不发生"）。所以：
 *      · `rosterImport`      → `bulk_import_roster()`  （建 N 个班 + 写几百个学生，同一个事务）
 *      · `subjectWrite`      → `write_student_subject()` **逐条**各一个事务
 *        （⚠️ 这里我**刻意**没有做成"整批一个事务"：选科是"改少数几个人"的动作，
 *          一条非法只挡那一条、并报出是哪个人；而"整批回滚"会让用户重贴 300 行。
 *          本期唯一要求"整批原子"的是**名单导入**与**任教关系**那两条。）
 *      · `classSubjectBulk`  → `bulk_write_class_subjects()`（一个事务）
 *
 * 🔴 **上限**（超了报人话，不静默截断）—— 与 `app/src/lib/gradeSetup.ts` 里那两个常量
 *    **必须同值**（`nav-checks.mjs` 的 A11 逐字比对）：
 *      · 名单导入 **3000 行** · 任教关系 **2000 行**
 *
 * 部署：<项目根>/functions/api/grade-setup.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量（与 notice / teacher-account 共用同一套）：
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY                        （🔴 Secret，绝不能进前端、绝不能进仓库）
 */

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

/** 名单导入一次的行数上限（`bulk_import_roster()` 里那个 `raise exception`） */
const ROSTER_MAX = 3000
/** 任教关系一次的行数上限（`bulk_write_class_subjects()` 里那个） */
const CLASS_SUBJECT_MAX = 2000

/** 与 `lib/pick.ts` 的 `PRIMARY_CODES` / `SECOND_CODES` 同值（数据库那份在 §27.4） */
const PRIMARY_CODES = ['physics', 'history']
const SECOND_CODES = ['chemistry', 'biology', 'politics', 'geography']

type Body = {
  action?: 'canSetup' | 'rosterImport' | 'subjectWrite' | 'classSubjectBulk' | 'academicYearWrite'
  gradeId?: string
  rows?: unknown[]
  /* ---- `academicYearWrite`（P3，`schema.sql` §28）：一个学年 + 上下半期 ---- */
  name?: string
  yearStart?: string
  yearEnd?: string
  half1Start?: string
  half1End?: string
  half2Start?: string
  half2End?: string
}

const NEED_STAGE27 =
  '数据库还没跑"开学准备"那一段（仓库里 supabase/schema.sql 第 27 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** P3（§28）还没跑时的那句话 —— 与 `NEED_STAGE27` 同款：**把下一步动作写清楚** */
const NEED_STAGE28 =
  '数据库还没跑"学年与学期"那一段（仓库里 supabase/schema.sql 第 28 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** `YYYY-MM-DD`（日期列的入参形状；四样都要） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

/** 用**调用者的 JWT** 调 Supabase（RLS 生效）—— 这一页的**读**都走它
 *  ⚠️ 今天这三个动作**全是写**，所以它暂时没有调用方；留着是因为
 *     "读走调用者 JWT、写走 service_role 且写之前先问判据"是这一页的形状说明。
 *     下一个动作（比如"读这个年级的任课关系"）会直接用它 —— 别把它当死代码删掉。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
 * 用**管理员密钥**调 Supabase（绕过 RLS）。
 *
 * ⚠️ 今天**没有调用方**：三个写入动作全部走 `rpc()`（拿**调用者 JWT** 调 RPC，
 *    由数据库的 `security definer` 函数把关）。
 *    这比"用管理员密钥直写表"更好 —— 少一次"我在 TypeScript 里判权限"的机会。
 *    留着它是因为下一期的动作（改班型 / 建走班班）大概率要直写 `classes`。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

/**
 * 调一个 RPC，**回原样的结果**（成功时 `rows[0]` 是那个 jsonb 返回值）。
 *
 * 🔴 数据库用 `raise exception` 报的都是**人话**（"第 3 行缺班号"）——
 *    那些话必须**原样带给用户**，不能吞掉换成"保存失败"。
 *    `status === 400` 且 `message` 是 `P0001`（raise_exception）时取那句话。
 */
async function rpc(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown>,
): Promise<Read & { p0001: string | null }> {
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
  let p0001: string | null = null
  try {
    const v = JSON.parse(r.text || '{}') as { code?: string; message?: string }
    if (v?.message) p0001 = String(v.message)
  } catch {
    /* 不是 JSON 就当没有那句话 */
  }
  return { ...r, p0001 }
}

/** 问数据库：这个判据对我返回什么？`'missing'` = 函数还没建（第 27 段没跑） */
async function rpcBool(
  env: Env,
  token: string,
  fn: string,
  body: Record<string, unknown>,
): Promise<boolean | 'missing'> {
  const r = await rpc(env, token, fn, body)
  if (r.ok) return r.text.trim() === 'true'
  if (r.status === 401 || r.status === 403) return false
  if (r.status === 404 || /PGRST202|does not exist|schema cache/i.test(r.text)) return 'missing'
  return false
}

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

/* ---------------- 形状校验（**不是**权限校验） ---------------- */

type RosterRow = { class_no: string; student_no: string; name: string; serial: string }

/**
 * 名单行的形状。**逐行报行号**（与服务端 `bulk_import_roster()` 里那几句同款）——
 * 这一层挡的是"字段都没给全"这种连 RPC 都不用问的错。
 */
function shapeRoster(rows: unknown[]): { ok: true; rows: RosterRow[] } | { ok: false; message: string } {
  if (rows.length > ROSTER_MAX) {
    return { ok: false, message: `一次最多导入 ${ROSTER_MAX} 行，这次有 ${rows.length} 行 —— 按年级分批贴。` }
  }
  const out: RosterRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>
    const classNo = String(r.classNo ?? '').trim()
    const studentNo = String(r.studentNo ?? '').trim()
    const name = String(r.name ?? '').trim()
    const serial = String(r.serial ?? '').trim()
    if (!name) return { ok: false, message: `第 ${i + 1} 行缺姓名` }
    if (!classNo) return { ok: false, message: `第 ${i + 1} 行缺班号 —— 这一行不知道该放进哪个班` }
    if (classNo.length > 12) return { ok: false, message: `第 ${i + 1} 行的班号太长（${classNo}）` }
    if (!studentNo) return { ok: false, message: `第 ${i + 1} 行缺班级内学号` }
    if (serial && !/^[0-9]{4}[0-9]{3}$/.test(serial)) {
      return {
        ok: false,
        message: `第 ${i + 1} 行的序列号格式不对（${serial}）—— 它是"4 位年份 + 3 位序号"`,
      }
    }
    out.push({ class_no: classNo, student_no: studentNo, name, serial })
  }
  if (!out.length) return { ok: false, message: '一行都没有 —— 这份名单是空的' }
  return { ok: true, rows: out }
}

/**
 * 选科行的形状。🔴 与 `lib/pick.ts` 的 `subjectCheck()` 和数据库
 * `student_subject_check()` **同一套判据**（三处同值；数据库那份仍是唯一闸门）。
 */
function shapeSubject(
  rows: unknown[],
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; message: string } {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>
    const studentId = String(r.studentId ?? '').trim()
    const kind = String(r.kind ?? 'standard').trim() === 'other' ? 'other' : 'standard'
    const primaryCode = String(r.primaryCode ?? '').trim()
    const secondCodes = Array.isArray(r.secondCodes)
      ? (r.secondCodes as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      : []
    const note = String(r.note ?? '').trim()
    const memberClassIds = Array.isArray(r.memberClassIds)
      ? (r.memberClassIds as unknown[]).map((x) => String(x).trim()).filter((x) => UUID_RE.test(x))
      : []

    if (!UUID_RE.test(studentId)) return { ok: false, message: `第 ${i + 1} 行没有指定学生` }

    if (kind === 'other') {
      if (secondCodes.length !== 2) {
        return { ok: false, message: `第 ${i + 1} 行：「其他」必须手工选走班科目（再选恰好 2 门）` }
      }
      if (!note) return { ok: false, message: `第 ${i + 1} 行：「其他」必须填原因` }
      if (!memberClassIds.length) {
        return { ok: false, message: `第 ${i + 1} 行：「其他」的学生必须手工选走班科目（走班班一个都没选）` }
      }
    } else {
      if (!PRIMARY_CODES.includes(primaryCode)) {
        return { ok: false, message: `第 ${i + 1} 行：首选只能是物理或历史` }
      }
      if (secondCodes.length !== 2) {
        return { ok: false, message: `第 ${i + 1} 行：再选必须恰好 2 门（这一行有 ${secondCodes.length} 门）` }
      }
      const bad = secondCodes.find((c) => !SECOND_CODES.includes(c))
      if (bad) {
        return { ok: false, message: `第 ${i + 1} 行：再选只能从 化学 / 生物 / 政治 / 地理 里取（收到 ${bad}）` }
      }
      if (secondCodes[0] === secondCodes[1]) {
        return { ok: false, message: `第 ${i + 1} 行：再选两门不许相同` }
      }
      if (secondCodes.includes(primaryCode)) {
        return { ok: false, message: `第 ${i + 1} 行：首选不许出现在再选里` }
      }
      if (memberClassIds.length) {
        return { ok: false, message: `第 ${i + 1} 行：标准组合的走班班由系统生成，手工选班只对「其他」开放` }
      }
    }

    out.push({
      student_id: studentId,
      kind,
      primary_code: primaryCode,
      second_codes: secondCodes,
      note,
      member_class_ids: memberClassIds,
    })
  }
  if (!out.length) return { ok: false, message: '一行都没有' }
  return { ok: true, rows: out }
}

/** 任教关系行的形状（上限 + 三样必填） */
function shapeClassSubjects(
  rows: unknown[],
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; message: string } {
  if (rows.length > CLASS_SUBJECT_MAX) {
    return { ok: false, message: `一次最多写 ${CLASS_SUBJECT_MAX} 行，这次有 ${rows.length} 行 —— 分两批。` }
  }
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>
    const classId = String(r.classId ?? '').trim()
    const subjectCode = String(r.subjectCode ?? '').trim()
    const teacherId = String(r.teacherId ?? '').trim()
    if (!UUID_RE.test(classId)) return { ok: false, message: `第 ${i + 1} 行没有指定班级` }
    if (!UUID_RE.test(teacherId)) return { ok: false, message: `第 ${i + 1} 行没有指定老师` }
    if (!subjectCode) return { ok: false, message: `第 ${i + 1} 行没有指定学科` }
    out.push({ class_id: classId, subject_code: subjectCode, teacher_id: teacherId })
  }
  if (!out.length) return { ok: false, message: '一行都没有 —— 这份表是空的' }
  return { ok: true, rows: out }
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

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  const action = body.action ?? 'canSetup'
  const gradeId = String(body.gradeId ?? '').trim()

  /* ---------------- canSetup：我在这个年级有没有开学准备的权限 ----------------
   * 它只决定"界面上摆不摆那几个按钮"（M1/M2 那条纪律的同一口径），
   * **不是安全边界** —— 每次真写之前都会**再问一次**判据（见下面三个动作）。 */
  if (action === 'canSetup') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const can = await rpcBool(env, me.token, 'can_manage_grade_setup', { p_grade_id: gradeId })
    if (can === 'missing') return json({ status: 'error', message: NEED_STAGE27 }, 503)
    return json({ status: 'ok', canSetup: can })
  }

  /* ---------------- rosterImport：录名单 + 按班号自动建班（**一个事务**） ---------------- */
  if (action === 'rosterImport') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeRoster(Array.isArray(body.rows) ? body.rows : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    const r = await rpc(env, me.token, 'bulk_import_roster', {
      p_grade_id: gradeId,
      p_rows: shaped.rows,
      p_class_name_template: '%s',
    })
    if (!r.ok) {
      if (isMissing(r)) return json({ status: 'error', message: NEED_STAGE27 }, 503)
      /* 🔴 数据库那几句人话（"第 3 行缺班号" / "你没有…权限"）原样带回去 */
      return json({ status: 'error', message: r.p0001 ?? '导入名单失败' }, r.status === 403 ? 403 : 400)
    }
    const v = (r.rows[0] ?? {}) as Record<string, unknown>
    return json({
      status: 'ok',
      classes: Number(v.classes ?? 0),
      students: Number(v.students ?? 0),
      noSerial: Number(v.noSerial ?? 0),
      roster: Array.isArray(v.roster) ? v.roster : [],
    })
  }

  /* ---------------- subjectWrite：写选科（逐条各自一个事务） ---------------- */
  if (action === 'subjectWrite') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeSubject(Array.isArray(body.rows) ? body.rows : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    let written = 0
    const failures: Array<{ studentId: string; reason: string }> = []
    for (const row of shaped.rows) {
      const r = await rpc(env, me.token, 'write_student_subject', {
        p_student_id: row.student_id,
        p_kind: row.kind,
        p_primary: row.primary_code,
        p_second: row.second_codes,
        p_note: row.note,
        p_member_class_ids: row.member_class_ids,
      })
      if (r.ok) {
        written++
      } else if (isMissing(r)) {
        return json({ status: 'error', message: NEED_STAGE27 }, 503)
      } else {
        failures.push({ studentId: String(row.student_id), reason: r.p0001 ?? '保存失败' })
      }
    }
    return json({ status: 'ok', written, failures })
  }

  /* ---------------- classSubjectBulk：批量写任教关系（**一个事务**） ---------------- */
  if (action === 'classSubjectBulk') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeClassSubjects(Array.isArray(body.rows) ? body.rows : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    const r = await rpc(env, me.token, 'bulk_write_class_subjects', { p_rows: shaped.rows })
    if (!r.ok) {
      if (isMissing(r)) return json({ status: 'error', message: NEED_STAGE27 }, 503)
      return json({ status: 'error', message: r.p0001 ?? '写任教关系失败' }, r.status === 403 ? 403 : 400)
    }
    const v = (r.rows[0] ?? {}) as Record<string, unknown>
    return json({ status: 'ok', rows: Number(v.rows ?? 0), replaced: Number(v.replaced ?? 0) })
  }

  /* ---------------- academicYearWrite：设一个学年的上下半期（**一个事务**，P3 / §28） ----------------
   *  🔴 判据不在这一层：`write_academic_year()` 自己问数据库的 `can_manage_terms()`
   *     （= 教导处 / 最高管理员）。四段日期在这一层先按形状挡一道（省一次往返），
   *     真正的校验（重叠、先后）在数据库里报人话。 */
  if (action === 'academicYearWrite') {
    const name = String(body.name ?? '').trim()
    const dates = {
      p_year_start: String(body.yearStart ?? '').trim(),
      p_year_end: String(body.yearEnd ?? '').trim(),
      p_half1_start: String(body.half1Start ?? '').trim(),
      p_half1_end: String(body.half1End ?? '').trim(),
      p_half2_start: String(body.half2Start ?? '').trim(),
      p_half2_end: String(body.half2End ?? '').trim(),
    }
    if (!/^\d{4}-\d{4}$/.test(name)) {
      return json({ status: 'error', message: '学年名写成 2026-2027 这样' }, 400)
    }
    for (const [k, v] of Object.entries(dates)) {
      if (!DATE_RE.test(v)) return json({ status: 'error', message: `${k} 要一个 YYYY-MM-DD 的日期` }, 400)
    }
    const r = await rpc(env, me.token, 'write_academic_year', { p_name: name, ...dates })
    if (!r.ok) {
      if (isMissing(r)) return json({ status: 'error', message: NEED_STAGE28 }, 503)
      return json({ status: 'error', message: r.p0001 ?? '保存学年与学期失败' }, r.status === 403 ? 403 : 400)
    }
    const v = (r.rows[0] ?? {}) as Record<string, unknown>
    return json({ status: 'ok', academicYearId: String(v.academicYearId ?? ''), name: String(v.name ?? name) })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/* 供本地调试看一眼（不进前端产物）：读接口没有，全部动作都是 POST */
export async function onRequestGet(): Promise<Response> {
  return json(
    {
      status: 'ok',
      hint: '开学准备的服务端接口：POST { action: canSetup | rosterImport | subjectWrite | classSubjectBulk | academicYearWrite }',
    },
    200,
  )
}
