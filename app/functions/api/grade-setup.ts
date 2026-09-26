/**
 * 开学准备（P6）—— 录名单 / 建班 / 采选科 / 批量写任教关系
 * （`年级管理与选科走班方案.md` §4.3.2 · `选科走班实施计划.md` P6）
 *
 * 🔴 **安全边界**：service_role **绕过 RLS**，所以这个 Function 必须自己校验调用者权限。
 *    但"自己校验"不等于"在 TypeScript 里再写一遍规则" —— 判据只有一处，在数据库：
 *      · `can_manage_grade_setup(grade_id)` —— 录名单 / 建班 / 设班型 / 写任教关系
 *      · `can_edit_student_subject(student_id)` —— 改一个学生的选科
 *    **读**（`canSetup`）拿**调用者自己的 JWT** 走 `POST /rest/v1/rpc/<函数名>` 去问
 *    （`auth.uid()` 就是调用者）。
 *
 * 🔴 **写：service_role + 显式 `p_actor`**（2026-10-02 集成修复 —— 与 `grade-promote.ts` §29 **同一套形状**）。
 *    三个写函数在 `schema.sql` §27.12 是 `revoke … from authenticated` 的，而 PostgREST
 *    以 `authenticated` 角色执行 —— 原来拿调用者 JWT 调它们，**线上必 42501**
 *    （"录名单 / 批量写任教关系 / 写选科"三条路全线导不进去，而当时的门禁全绿，
 *    因为那些断言是以属主 / 服务角色跑的）。所以：
 *      · 用 `caller()` 从调用者 JWT 验出 `me.id`（**身份只有这一处来源**）；
 *      · 用 **service_role** 调 RPC（`svcRpc()`）；
 *      · **显式传 `p_actor: me.id`** —— service_role 下 `auth.uid()` 是 **NULL**，
 *        数据库自己问不出"谁干的"；判据仍是数据库的 `*_for(p_actor, …)` 说了算。
 *    完整理由见 `schema.sql` §27.13。
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
 *      · `academicYearWrite` → `write_academic_year()`（学年 + 上下半期，一个事务 ——
 *        它同样是 `revoke … from authenticated` 的，所以走**同一条** service_role + `p_actor` 链）
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

import { anonKey, baseUrl, caller, json, rpcBool, svcRpc } from './_lib/supa'

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
  action?:
    | 'canSetup'
    | 'rosterImport'
    | 'subjectWrite'
    | 'classSubjectBulk'
    | 'academicYearWrite'
    /** 🆕 P7：生成走班班（**教导处确认之后**的那一次调用） */
    | 'streamGenerate'
    /** 🆕 P7：分配走班班老师（**自动补 `class_subjects`**） */
    | 'classSubjectAssign'
    /** 🆕 P10：旧科目数据「将删除什么」的清单（**只算不删**） */
    | 'subjectPurgePreview'
    /** 🆕 P10：删旧科目数据（**不确认就删不掉**） */
    | 'subjectPurge'
    /** 🆕 2026-10-09：我在这个班能不能"从班级管理呼叫学生"（**只决定摆不摆那个入口**） */
    | 'classCallable'
  gradeId?: string
  rows?: unknown[]
  /* ---- `streamGenerate`（P7，`schema.sql` §32.2）---- */
  groups?: unknown[]
  /* ---- `classSubjectAssign`（P7，`schema.sql` §32.3）---- */
  classId?: string
  teacherId?: string
  /* ---- `subjectPurgePreview` / `subjectPurge`（P10，`schema.sql` §34.3）---- */
  studentId?: string
  /** 二次确认：**不是 true 就删不掉**（数据库那一侧 `raise exception`） */
  confirm?: boolean
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

/** P7（§32）还没跑时的那句话 */
const NEED_STAGE32 =
  '数据库还没跑"走班班"那一段（仓库里 supabase/schema.sql 第 32 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** P10（§34）还没跑时的那句话 */
const NEED_STAGE34 =
  '数据库还没跑"选科变更审计"那一段（仓库里 supabase/schema.sql 第 34 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** 🆕 呼叫判据（§33）还没跑时的那句话 */
const NEED_STAGE33 =
  '数据库还没跑"呼叫判据"那一段（仓库里 supabase/schema.sql 第 33 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** 走班四科 —— 与 `lib/stream.ts` 的 `STREAM_SUBJECT_CODES` 同值（那一份是唯一判定入口） */
const STREAM_SUBJECT_CODES = ['chemistry', 'biology', 'politics', 'geography']

/** 一次最多生成几个走班班（`generate_stream_classes()` 里那个数） */
const STREAM_GROUP_MAX = 200

/** `YYYY-MM-DD`（日期列的入参形状；四样都要） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* ---------------- 三条链（`json()` / `svcRpc()` / `caller()` 都在 `_lib/supa.ts`） ----------------
 * ⚠️ 少了的是那两个"留着备用"的本地 `sb()` / `sbAs()`（一直没人调）：
 *    这一页今天**读**走 `rpcBool()`（调用者 JWT）、**写**走 `svcRpc()`（service_role + `p_actor`），
 *    两条链都在 `_lib/supa.ts` 里各只有一份 —— 别在这里再长出一份。
 */

/** 第 27 段的函数还没建时的形状：PostgREST 404 / `PGRST202`，或 PostgreSQL 的 `42883` */
const FN_MISSING_RE = /42P01|42703|42883|PGRST20[245]|does not exist|schema cache/i

/**
 * 写入口失败 → HTTP 码（**三种形状必须分开报**）：
 *   · `42501`（`permission denied for function`）= 数据库的 execute 权限挡住 —— 那是**部署事故**
 *     （说明服务端没有用 service_role 调，或那一段 SQL 的 grant 被改过），给 500 而不是 403：
 *     它不是"这个人没权限"，而是"这个接口坏了"。**不许静默成"你没权限"。**
 *   · 数据库 `raise exception` 说"你没权限" → 403（判据挡住）
 *   · 其余（"第 3 行缺班号"这种）→ 400
 */
function writeFailStatus(r: { status: number; message: string }): number {
  if (/42501|permission denied for function/i.test(r.message) || r.status === 401) return 500
  if (/没权限|只有教导处|只有最高管理员|你没有/.test(r.message)) return 403
  return 400
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

/**
 * 走班班那一组的形状（P7 · `schema.sql` §32.2）。
 *
 * 🔴 **这里只挡形状，不重算走班科目**：算法（谁要走哪几科、差 2 门的人进两个班）
 *    唯一实现在 `app/src/lib/stream.ts` 的 `planStreamClasses()`，而它是**纯逻辑** ——
 *    服务端再写一份就是"同一件事两个判定入口"（I16）。
 * ⚠️ 科目**必须在走班四科里**、人数**不许为 0**（空走班班不建）——
 *    与库里那两句 `raise exception` 同款（少一层，用户在浏览器里要多等一次往返）。
 */
function shapeStreamGroups(
  rows: unknown[],
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; message: string } {
  if (rows.length > STREAM_GROUP_MAX) {
    return { ok: false, message: `一次最多生成 ${STREAM_GROUP_MAX} 个走班班，这次有 ${rows.length} 个` }
  }
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>
    const streamKey = String(r.streamKey ?? '').trim()
    const name = String(r.name ?? '').trim()
    const subjects = Array.isArray(r.subjects)
      ? (r.subjects as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      : []
    const classId = String(r.classId ?? '').trim()
    const studentIds = Array.isArray(r.studentIds)
      ? (r.studentIds as unknown[]).map((x) => String(x).trim()).filter((x) => UUID_RE.test(x))
      : []
    if (!streamKey) return { ok: false, message: `第 ${i + 1} 组没有组合标识` }
    if (seen.has(streamKey)) return { ok: false, message: `第 ${i + 1} 组的组合标识与前面重复了（${streamKey}）` }
    seen.add(streamKey)
    if (!name) return { ok: false, message: `第 ${i + 1} 组没有名字` }
    if (!subjects.length) return { ok: false, message: `第 ${i + 1} 组没有指定走班科目` }
    const bad = subjects.find((c) => !STREAM_SUBJECT_CODES.includes(c))
    if (bad) return { ok: false, message: `第 ${i + 1} 组的科目「${bad}」不在走班四科里` }
    if (!studentIds.length) return { ok: false, message: `第 ${i + 1} 组一个人都没有` }
    if (classId && !UUID_RE.test(classId)) return { ok: false, message: `第 ${i + 1} 组的班级 id 不合法` }
    out.push({
      stream_key: streamKey,
      name,
      subjects,
      class_id: classId || null,
      student_ids: studentIds,
    })
  }
  if (!out.length) return { ok: false, message: '一个走班班都没有 —— 没有要走班的组合' }
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

  /* ---------------- classCallable：我在这个班能不能"从班级管理呼叫学生" ----------------
   * 与 `canSetup` 同一个口径（M1/M2）：**只决定"摆不摆那个入口"**，不是安全边界 ——
   * 真发呼叫时数据库那三条 `calls` 策略会再问一次**同一个**判据（§33.3）。
   *
   * 🔴 判据**一处都不新写**：直接问数据库的裸版 `can_call(class_id, null)` ——
   *    `assignment_id` 为空正好是 `can_call_for()` 的"**事务性呼叫**"那一支
   *    （= `can_manage_class_for()` ∪ 行政班，§33.2）。
   *    ⚠️ 刻意**不掺"有作业的呼叫"那一支**：那条还额外给科任老师（`teaches_in_class_for`），
   *    是**另一档**权力，"从班级管理直接叫人"不该按它摆。
   *    它顺带把 Q17 的边界也带上了：走班班（`kind='stream'`）的事务性呼叫判据恒假 →
   *    那些班自然不摆这个按钮。
   */
  if (action === 'classCallable') {
    const classId = String(body.classId ?? '').trim()
    if (!UUID_RE.test(classId)) return json({ status: 'error', message: '没有指定班级' }, 400)
    const can = await rpcBool(env, me.token, 'can_call', {
      p_class_id: classId,
      p_assignment_id: null,
    })
    if (can === 'missing') return json({ status: 'error', message: NEED_STAGE33 }, 503)
    return json({ status: 'ok', canCall: can })
  }

  /* ---------------- rosterImport：录名单 + 按班号自动建班（**一个事务**） ---------------- */
  if (action === 'rosterImport') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeRoster(Array.isArray(body.rows) ? body.rows : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    /* 🔴 service_role + 显式 `p_actor`（见文件头与 `schema.sql` §27.13） */
    const r = await svcRpc(env, 'bulk_import_roster', {
      p_actor: me.id,
      p_grade_id: gradeId,
      p_rows: shaped.rows,
      p_class_name_template: '%s',
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE27 }, 503)
      /* 🔴 数据库那几句人话（"第 3 行缺班号" / "你没有…权限"）原样带回去 */
      return json({ status: 'error', message: r.message || '导入名单失败' }, writeFailStatus(r))
    }
    const v = r.value
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
      const r = await svcRpc(env, 'write_student_subject', {
        p_actor: me.id,
        p_student_id: row.student_id,
        p_kind: row.kind,
        p_primary: row.primary_code,
        p_second: row.second_codes,
        p_note: row.note,
        p_member_class_ids: row.member_class_ids,
      })
      if (r.ok) {
        written++
      } else if (FN_MISSING_RE.test(r.message)) {
        return json({ status: 'error', message: NEED_STAGE27 }, 503)
      } else {
        failures.push({ studentId: String(row.student_id), reason: r.message || '保存失败' })
      }
    }
    return json({ status: 'ok', written, failures })
  }

  /* ---------------- subjectPurgePreview：旧科目数据「将删除什么」（**只算不删**，P10 / §34.3） ----------------
   *  🔴 数字**只有一处算**（`old_subject_data_counts_for()`，`schema.sql` §34.3）——
   *     服务端与界面都**不许**自己数一遍（数错了 = 二次确认上写着"将删除 0 条"、
   *     实际删掉一片，而那正是"不可恢复"的操作最怕的样子）。
   *  ⚠️ 读也要走 service_role：那两个函数是 `_for(p_uid, …)`，**一律 revoke**（§16.2 的纪律）。
   */
  if (action === 'subjectPurgePreview') {
    const studentId = String(body.studentId ?? '').trim()
    if (!UUID_RE.test(studentId)) return json({ status: 'error', message: '没有指定学生' }, 400)
    const r = await svcRpc(env, 'old_subject_data_counts_for', {
      p_uid: me.id,
      p_student_id: studentId,
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE34 }, 503)
      return json({ status: 'error', message: r.message || '读不到要删的东西' }, writeFailStatus(r))
    }
    const v = r.value
    return json({
      status: 'ok',
      oldSubjects: Array.isArray(v.oldSubjects) ? v.oldSubjects : [],
      scores: Number(v.scores ?? 0),
      members: Number(v.members ?? 0),
      total: Number(v.total ?? 0),
    })
  }

  /* ---------------- subjectPurge：删旧科目数据（**不确认就删不掉**，P10 / §34.3） ---------------- */
  if (action === 'subjectPurge') {
    const studentId = String(body.studentId ?? '').trim()
    if (!UUID_RE.test(studentId)) return json({ status: 'error', message: '没有指定学生' }, 400)
    const r = await svcRpc(env, 'purge_old_subject_data', {
      p_actor: me.id,
      p_student_id: studentId,
      /*
       * 🔴 只有**字面上的 true** 才算确认 —— 但**判断本身仍在数据库**：
       *    这里传什么都不能绕过 `purge_old_subject_data()` 里
       *    `if p_confirm is not true then raise exception …` 那一句。
       */
      p_confirm: body.confirm === true,
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE34 }, 503)
      /* 数据库那句人话里带着"将删除 N 条记录（不可恢复）" —— 原样带回去当确认文案 */
      return json({ status: 'error', message: r.message || '删除失败', notDeleted: true }, writeFailStatus(r))
    }
    const v = r.value
    return json({
      status: 'ok',
      message: String(v.message ?? '已删除'),
      deleted: v.deleted ?? { scores: 0, members: 0 },
    })
  }

  /* ---------------- classSubjectBulk：批量写任教关系（**一个事务**） ---------------- */  if (action === 'classSubjectBulk') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeClassSubjects(Array.isArray(body.rows) ? body.rows : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    const r = await svcRpc(env, 'bulk_write_class_subjects', {
      p_actor: me.id,
      p_rows: shaped.rows,
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE27 }, 503)
      return json({ status: 'error', message: r.message || '写任教关系失败' }, writeFailStatus(r))
    }
    const v = r.value
    return json({ status: 'ok', rows: Number(v.rows ?? 0), replaced: Number(v.replaced ?? 0) })
  }

  /* ---------------- streamGenerate：生成走班班（**一个事务**，P7 / §32.2） ----------------
   *  🔴 **确认是必经**（Q7 = B）：前端先算建议给教导处看，**只有他点了「确认生成」**
   *     才会打到这里。服务端**不重算**（算法只有一处，在 `lib/stream.ts`），
   *     只挡形状 + 转交库里的 `generate_stream_classes()`。
   *  ⚠️ 这个写入口同样是 `revoke … from authenticated` 的（§32.4）：
   *     与上面几个一样走 **service_role + 显式 `p_actor`**（§30 的那个形状）。 */
  if (action === 'streamGenerate') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const shaped = shapeStreamGroups(Array.isArray(body.groups) ? body.groups : [])
    if (!shaped.ok) return json({ status: 'error', message: shaped.message }, 400)

    const r = await svcRpc(env, 'generate_stream_classes', {
      p_actor: me.id,
      p_rows: shaped.rows,
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE32 }, 503)
      return json({ status: 'error', message: r.message || '生成走班班失败' }, writeFailStatus(r))
    }
    const v = r.value
    return json({
      status: 'ok',
      created: Number(v.created ?? 0),
      members: Number(v.members ?? 0),
      classes: Array.isArray(v.classes) ? v.classes : [],
    })
  }

  /* ---------------- classSubjectAssign：分配走班班老师（**自动补 `class_subjects`**，P7 / §32.3） ----------------
   *  🔴 Q19 = A 的字面实现：老师与"他在这个走班班教哪几科"**同一个事务**落库。
   *     不补的后果是那位老师建作业被 RLS **静默拒掉**（§31.3 的 `assignments_write_ok`
   *     在有归属时走 `can_grade_subject` → `teaches_subject_for` → 读 `class_subjects`）。
   *  ⚠️ 走班班教哪几科从 `stream_key` 反查（库里那一段），**认不出就报错、不拿别的科目顶上**。 */
  if (action === 'classSubjectAssign') {
    const classId = String(body.classId ?? '').trim()
    const teacherId = String(body.teacherId ?? '').trim()
    if (!UUID_RE.test(classId)) return json({ status: 'error', message: '没有指定走班班' }, 400)
    if (!UUID_RE.test(teacherId)) return json({ status: 'error', message: '没有指定老师' }, 400)

    const r = await svcRpc(env, 'assign_stream_teacher', {
      p_actor: me.id,
      p_class_id: classId,
      p_teacher_id: teacherId,
    })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE32 }, 503)
      return json({ status: 'error', message: r.message || '分配老师失败' }, writeFailStatus(r))
    }
    const v = r.value
    return json({
      status: 'ok',
      classId: String(v.classId ?? classId),
      teacherId: String(v.teacherId ?? teacherId),
      added: Number(v.added ?? 0),
      subjects: Array.isArray(v.subjects) ? v.subjects : [],
    })
  }

  /* ---------------- academicYearWrite：设一个学年的上下半期（**一个事务**，P3 / §28） ----------------
   *  🔴 判据不在这一层：`write_academic_year()` 自己问数据库的
   *     `can_manage_terms_for(p_actor)`（= 教导处 / 最高管理员）。
   *     四段日期在这一层先按形状挡一道（省一次往返），真正的校验（重叠、先后）在数据库里报人话。
   *  ⚠️ 这个写入口同样是 `revoke … from authenticated` 的（§28.5）：
   *     与上面三个一样走 **service_role + 显式 `p_actor`** —— 这是同一类 bug（见 §27.13）。 */
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
    const r = await svcRpc(env, 'write_academic_year', { p_actor: me.id, p_name: name, ...dates })
    if (!r.ok) {
      if (FN_MISSING_RE.test(r.message)) return json({ status: 'error', message: NEED_STAGE28 }, 503)
      return json({ status: 'error', message: r.message || '保存学年与学期失败' }, writeFailStatus(r))
    }
    const v = r.value
    return json({ status: 'ok', academicYearId: String(v.academicYearId ?? ''), name: String(v.name ?? name) })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/* 供本地调试看一眼（不进前端产物）：读接口没有，全部动作都是 POST */
export async function onRequestGet(): Promise<Response> {
  return json(
    {
      status: 'ok',
      hint: '开学准备的服务端接口：POST { action: canSetup | rosterImport | subjectWrite | classSubjectBulk | classSubjectAssign | streamGenerate | academicYearWrite | subjectPurgePreview | subjectPurge }',
    },
    200,
  )
}
