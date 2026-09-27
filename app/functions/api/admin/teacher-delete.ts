/**
 * `POST /api/admin/teacher-delete` —— **教师账号"真删除"的唯一出口**（2026-10-09）。
 *
 * ============================================================
 * 为什么必须是一条**新的 Function**，而且必须走服务端
 * ============================================================
 * 用户口径：「教师管理里要能**真删**一个账号」（不是停用）。
 * 而删一个账号 = 删**两处**：
 *   · `auth.users` 里那一行（登录身份）；
 *   · `teachers` 里那一行（这个人）。
 * 删 `auth.users` 只有 **`service_role`** 做得到（GoTrue 的 Admin API），
 * 而 `service_role` **绝不能进前端产物** —— 所以它只能在服务端。
 *
 * ⚠️ **没有改既有的任何 Function**：`teacher-account.ts` 管建号 / 重置 / 身份 / 部门 /
 *    姓名 / 档案六件事，**不包含删除**（那一页从前也**没有任何删除入口**）。
 *    「顺手把 delete 塞进 teacher-account」= 把"建号"与"不可逆地删号"合成一个入口，
 *    而它们的判据档位**可能不一样**（这里用的是 `can_manage_teachers`，见下），
 *    而且会让那个已经 1400 行的文件再多一条写路径。所以新开一条。
 *
 * ============================================================
 * 🔴 权限判据：`can_manage_teachers()`（超管 ∪ 教务处），**判据在数据库**
 * ============================================================
 * 用户口径：谁能删 —— **`can_manage_teachers` 那一档**（教导处 / 超管）。
 * 做法与 `admin/maintenance.ts` / `admin/config-check.ts` **逐字同款**：
 * 拿**调用者自己的 JWT** 去 `POST /rest/v1/rpc/can_manage_teachers`，让**数据库**回答。
 * 🔴 **不信前端传来的任何"我是管理员"** —— 请求体里根本没有"我是谁"这个字段。
 *
 * ⚠️ 一条容易做错的区分（`teacher-account.ts:159-160` 的纪律）：
 *    **函数不存在（第 13 段没跑）→ 503「去跑第 13 段」，不是 403。**
 *    把"环境没准备好"误报成"你权限不够"，会让人去改权限设置，越改越乱。
 *
 * ============================================================
 * 🔴 外键：**哪些是级联、哪些要手工先清**（逐条核过 `schema.sql`，不是猜的）
 * ============================================================
 * `teachers.id → auth.users(id) on delete cascade`（§1）。所以删掉 `auth.users` 那一行时，
 * `teachers` 那一行**跟着走**，再往下的子表大多也写着 `on delete cascade`：
 *   · 任课关系 `class_subjects`（§10.3）        cascade
 *   · 身份 `teacher_roles`（§10.1）             cascade
 *   · 部门 `teacher_departments`（§21.2.2）     cascade
 *   · 档案 `teacher_profiles`（§1.1）           cascade
 *   · 通知 / 作业 / 考试 / 呼叫 / 文件 … 里 `teacher_id references teachers(id)`
 *     的那一批，**全部** `on delete cascade`（§12/§14/§15/§18/§19… 逐行核过）
 *
 * 🔴 **但有四列不写 `on delete`（= NO ACTION，会拦住整次删除）**：
 *   · `classroom_accounts.created_by`      —— "这个教室端账号是谁建的"
 *   · `student_subjects.updated_by`        —— "这个学生的选科是谁改的"
 *   · `student_subject_changes.changed_by` —— 选科变更审计：谁改的
 *   · `student_subject_changes.purged_by`  —— 选科变更审计：谁清的旧数据
 *   它们**故意**不级联（它们记的是"某个人做过什么"，不是"这个人拥有的东西"），
 *   所以删之前要把这几列**置空**（不是删行 —— 那些行本身不属于这个人）。
 *   ⚠️ 这一步**必须在删 auth 之前做完**：漏一列 → PostgreSQL 抛 `23503`，
 *      而 GoTrue 的 DELETE 是在**一个事务**里做的 → 整次删除**回滚**（两处都没删掉）。
 *      这恰好是"安全的失败方向"：**宁可什么都没删，也不要删一半**。
 *
 * ⚠️ 后两张表（§27 / §34）在老库上**可能还没建** —— 那几列既然不存在，
 *    也就不可能拦人。所以"表不在"（42P01 / PGRST205）**当作没有、继续走**，
 *    别的错误（42501 之类）**当场报出来**，绝不静默。
 *
 * ============================================================
 * 🔴 顺序：**先清外键 → 先写审计 → 再删 → 最后复核两处都没了**
 * ============================================================
 *   · **审计写在删除之前**（用户点名）：删成功时它必须已经落库；
 *     删失败时它是一条"尝试过"的记录 —— 两种都比"没记上"好。
 *   · **复核是硬要求**：删完再读一次 `teachers`、再问一次 GoTrue 的 Admin API，
 *     两处都确认没了才回 `ok`。本项目反复栽在"不报错但就是不对"上
 *     （RLS 挡下的更新返回 0 行不报错就是这个形状），所以这里**不许只看 HTTP 码**。
 *
 * ============================================================
 * 🔴 `service_role` 的边界（这条比功能本身重要）
 * ============================================================
 *   · 它只在本文件的 `svc()` / `deleteAuthUser()` 里被读一次，**只做 Authorization 头**；
 *   · **绝不进响应体**：`json()` 出去的东西里没有任何 `serviceKey(env)` 的值，
 *     连长度、前缀都不回（`config-check.ts` 那条"只回报在/不在"的纪律）；
 *   · **绝不进日志**：本文件**一句 `console.*` 都没有**；
 *   · **绝不进前端**：前端只 `fetch('/api/admin/teacher-delete')`，见 `data/remote.ts`。
 *
 * 环境变量：`SUPABASE_URL` / `VITE_SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  type Read,
  anonKey,
  audit,
  baseUrl,
  caller,
  isMissing,
  json,
  read,
  rpcBool,
  serviceKey,
  svc,
} from '../_lib/supa'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin / can_manage_teachers）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

type Body = {
  action?: 'probe' | 'delete'
  /** delete：要删的那个老师（= `teachers.id` = `auth.users.id`） */
  teacherId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 🔴 **会拦住删除的那四列**（`on delete` 缺省 = NO ACTION）。
 *
 * 逐条对着 `supabase/schema.sql` 核过，**不是猜的**：
 *   · §10   `classroom_accounts.created_by`      （`create table` 在 §10.1，第 743 行）
 *   · §27.3 `student_subjects.updated_by`        （第 6011 行）
 *   · §34.1 `student_subject_changes.changed_by` （第 8983 行）
 *   · §34.1 `student_subject_changes.purged_by`  （第 8987 行）
 *
 * ⚠️ 一条也不能少：漏一列 = `23503` = **整次删除回滚**（见文件头那段）。
 * ⚠️ 这条清单一变，`scripts/rls-checks.mjs` 第二十三节那条"四列逐条比对
 *    `pg_constraint.confdeltype`"就要跟着变 —— 那边是**从真库结构里读出来**的。
 */
const RESTRICT_COLS: ReadonlyArray<{ table: string; col: string }> = [
  { table: 'classroom_accounts', col: 'created_by' },
  { table: 'student_subjects', col: 'updated_by' },
  { table: 'student_subject_changes', col: 'changed_by' },
  { table: 'student_subject_changes', col: 'purged_by' },
]

/** 复核 / 读行一律 `select('*')` 的形状 —— **不假设任何列存在**（`subjects` 没有 `id` 那两次教训） */
const all = 'select=*'

type Cleaned = { table: string; col: string; rows: number | 'missing'; error?: string }

/**
 * 把"会挡住删除"的那几列**置空**。
 *
 * 回三个状态（与 `功能设计与不变量.md` 的三态纪律同款）：
 *   · `rows`  —— 真置空了几行（0 也是有效答案）
 *   · `'missing'` —— 这张表/这一列在老库上还没有（没有它也就拦不住人）→ **继续走**
 *   · `error` —— 真的失败了 → 调用方**当场中止**，不许带着隐患往下删
 */
async function clearRestrict(env: Env, id: string): Promise<{ cleaned: Cleaned[]; failed: string | null }> {
  const cleaned: Cleaned[] = []
  for (const r of RESTRICT_COLS) {
    let res: Read
    try {
      res = await read(
        await svc(env, `/rest/v1/${r.table}?${r.col}=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ [r.col]: null }),
        }),
      )
    } catch (e) {
      return {
        cleaned,
        failed: `清 ${r.table}.${r.col} 时连不上数据库：${e instanceof Error ? e.message : String(e)}`,
      }
    }
    if (res.ok) {
      cleaned.push({ table: r.table, col: r.col, rows: res.rows.length })
      continue
    }
    if (isMissing(res)) {
      cleaned.push({ table: r.table, col: r.col, rows: 'missing' })
      continue
    }
    /* 别的错误（42501 之类）**当场中止** —— 失败也要把这一列的状态记下来，免得回话里缺一条 */
    cleaned.push({ table: r.table, col: r.col, rows: res.rows.length, error: `HTTP ${res.status}` })
    return {
      cleaned,
      failed: `清 ${r.table}.${r.col} 失败（HTTP ${res.status}）：${res.text.replace(/\s+/g, ' ').slice(0, 160)}`,
    }
  }
  return { cleaned, failed: null }
}

/** 用**管理员密钥**删 `auth.users` 那一行（GoTrue Admin API）—— 级联会把 `teachers` 一并带走 */
async function deleteAuthUser(
  env: Env,
  id: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const key = serviceKey(env)
  try {
    const res = await fetch(`${baseUrl(env)}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 300) }
  } catch (e) {
    return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) }
  }
}

/** 问 GoTrue：这个账号**还在不在**（复核用；404 = 没了） */
async function authUserExists(env: Env, id: string): Promise<boolean | 'unknown'> {
  const key = serviceKey(env)
  try {
    const res = await fetch(`${baseUrl(env)}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (res.status === 404) return false
    if (!res.ok) return 'unknown'
    return true
  } catch {
    return 'unknown'
  }
}

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
  const action = body.action ?? 'probe'

  // ---- 1. 这是谁？（**只看 JWT，不看请求体**）----
  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /*
   * ---- 2. 他能不能管教师账号？----
   *
   * 🔴 判据在**数据库**：`schema.sql` §13.2 的 `can_manage_teachers()` = 最高管理员 ∪ 教务处。
   *    （`probe` 与 `delete` 用**同一个**判据：前端要照它摆不摆入口，
   *     而"能不能删"这件事服务端**再判一次** —— 藏入口从来不是安全边界。）
   * ⚠️ `'missing'` **不能当成 false**：旧库上会说"你不是超管"，而他明明是（第 13 段还没跑）。
   */
  const mayDelete = await rpcBool(env, me.token, 'can_manage_teachers')
  if (mayDelete === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!mayDelete) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员和教务处能删除教师账号。你在 teacher_roles 里没有 super / admin 那一行 —— ' +
          '见 schema.sql §10.6 的角色指派模板。',
      },
      403,
    )
  }

  /* ---------------- 教谁不能删：自己 · 最后一个最高管理员 ---------------- */

  /**
   * 🔴 **护栏一 / 护栏二**（用户点名的两条），合在一处判、各给一句人话。
   *
   *  · **不能删自己**：删掉自己那一行 = 立刻失去全部身份（`teacher_roles` 级联走），
   *    而"最后一个超管"那条路连补救的人都找不到了。
   *  · **不能删最后一个最高管理员**：`teacher_roles_one_super`（§10.1.1 ⑥）那条
   *    **部分唯一索引**保证"多不了"；这一条是它的**另一面** ——
   *    保证"少不到 0"（0 个 super = 谁也管不了平台：建号 / 指派身份 / 发公告全废）。
   *    ⚠️ 判据是**数出来的行数**，不是"他有没有 super 这一行"：
   *      有两个人拿着时，删掉其中一个是对的（那正是交接）。
   */
  function guardReason(targetId: string, meId: string, superRows: Record<string, unknown>[]): string | null {
    if (targetId === meId) {
      return '不能删除自己的账号。你正在用的就是这个账号 —— 删掉它，你会立刻失去全部身份。'
    }
    const supers = superRows.map((r) => String(r.teacher_id ?? '')).filter(Boolean)
    if (supers.includes(targetId) && supers.length <= 1) {
      return (
        '这是最后一位最高管理员，删不得。零个最高管理员 = 谁也管不了平台（建号 / 指派身份 / 发公告全废）。' +
        '要交接的话，先把另一个人也设成最高管理员，再删这一个。'
      )
    }
    return null
  }

  /** 现在有谁拿着 `super`（读得宽：`select=*`，不假设任何列存在） */
  async function loadSupers(): Promise<Record<string, unknown>[] | null> {
    const r = await read(await svc(env, `/rest/v1/teacher_roles?${all}&role=eq.super`))
    return r.ok ? r.rows : null
  }

  /* ---------------- probe：前端照它摆不摆入口 ---------------- */
  if (action === 'probe') {
    const supers = await loadSupers()
    if (supers === null) {
      /* 读不到就不是"不能删"，是**无法判断** —— 回一个 false 并把原因说出来（前端不摆入口，且能显示一句人话） */
      return json({
        status: 'ok',
        canDelete: false,
        selfId: me.id,
        lastSuperId: null,
        reason: '读不到身份表（teacher_roles），所以这一页不摆删除入口',
      })
    }
    const ids = supers.map((r) => String(r.teacher_id ?? '')).filter(Boolean)
    return json({
      status: 'ok',
      canDelete: true,
      selfId: me.id,
      /** 只有一位最高管理员时给它的 id，其余情况 `null`（`null` = 这一档没有"不能删"的人） */
      lastSuperId: ids.length === 1 ? ids[0] : null,
      reason: null,
    })
  }

  /* ---------------- delete：真删 ---------------- */
  if (action !== 'delete') return json({ status: 'error', message: '不认识这个操作' }, 400)

  const id = String(body.teacherId ?? '').trim()
  if (!UUID_RE.test(id)) return json({ status: 'error', message: '没有指定要删的老师' }, 400)

  const supers = await loadSupers()
  if (supers === null) {
    return json({ status: 'error', message: '读不到身份表（teacher_roles），这次删除没有执行' }, 502)
  }
  const guarded = guardReason(id, me.id, supers)
  if (guarded) return json({ status: 'error', message: guarded }, 400)

  /* 这个人得真的在 —— 不在就 404（"没有这个老师"与"删掉了"必须分得开） */
  let target: Record<string, unknown>
  {
    const r = await read(await svc(env, `/rest/v1/teachers?${all}&id=eq.${id}`))
    if (!r.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(r)
            ? '读不到教师表（teachers）—— 数据库里第 1 段还没跑？'
            : `读教师档案失败（HTTP ${r.status}）`,
        },
        502,
      )
    }
    if (r.rows.length === 0) {
      return json({ status: 'error', message: '找不到这位老师（可能已经被删掉了）' }, 404)
    }
    target = r.rows[0]
  }
  const name = String(target.name ?? '').trim()
  const subject = String(target.subject ?? '').trim()

  /*
   * ---- ③-a 🔴 审计写在删除之前 ----
   *
   * `actor_name` 取**调用者自己那一行**的姓名（快照）—— 回话里没有姓名时留空，
   * 不留一个假名字。⚠️ `detail` 里**不放任何学生数据**（`admin_audit` 会跟着备份，
   * 见 §23.1 与 §二十四 的同一句纪律）。
   */
  let actorName = ''
  {
    const r = await read(await svc(env, `/rest/v1/teachers?${all}&id=eq.${me.id}`))
    if (r.ok && r.rows.length) actorName = String(r.rows[0].name ?? '').trim()
  }
  const audited = await audit(env, {
    actorId: me.id,
    actorName,
    action: 'teacher.delete',
    target: `${name || '(没有姓名)'} · ${id}`,
    detail:
      `真删除：auth.users 与 teachers 两行；他的任课关系 / 身份 / 部门 / 档案 / 教室端账号` +
      `${subject ? `（主学科 ${subject}）` : ''} 会一并消失，且不可恢复`,
    affected: 1,
  })

  /* ---- ③-b 先把"会挡住删除"的那四列置空（不然 23503 → 整次回滚）---- */
  const { cleaned, failed } = await clearRestrict(env, id)
  if (failed) {
    return json(
      { status: 'error', message: `这次删除没有执行：${failed}`, cleaned, audited },
      502,
    )
  }

  /* ---- ③-c 删：`auth.users` 那一行（级联带走 `teachers` 与其余子表）---- */
  const del = await deleteAuthUser(env, id)
  let via = 'auth-cascade'
  if (!del.ok) {
    if (del.status !== 404) {
      /*
       * 🔴 显式失败：**两处都没删掉**（GoTrue 那一次是在事务里做的，级联没提交）。
       *    这里把 HTTP 码与 GoTrue 那句人话原样带出去 —— 绝不静默。
       */
      return json(
        {
          status: 'error',
          message: `删除失败（登录服务回了 HTTP ${del.status || '连不上'}），这个账号**两处都还在**`,
          detail: del.text,
          cleaned,
          audited,
        },
        502,
      )
    }
    /*
     * ⚠️ 404 = `auth.users` 里**本来就没这个人**（只有 `teachers` 那一行的孤儿行）。
     *    那就把 teachers 那一行显式删掉 —— 用户要的是"这人从平台上消失"，不是"只删登录"。
     */
    const r = await read(
      await svc(env, `/rest/v1/teachers?id=eq.${id}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      }),
    )
    if (!r.ok || r.rows.length === 0) {
      return json(
        {
          status: 'error',
          message: `删除失败：登录服务里没有这个账号，而 teachers 那一行也没删掉（HTTP ${r.status}）`,
          detail: r.text.replace(/\s+/g, ' ').slice(0, 200),
          cleaned,
          audited,
        },
        502,
      )
    }
    via = 'teachers-only'
  }

  /* ---- ④ 复核两处都没了（**不许只看 HTTP 码**）---- */
  const leftTeacher = await read(await svc(env, `/rest/v1/teachers?${all}&id=eq.${id}`))
  if (!leftTeacher.ok) {
    return json(
      {
        status: 'error',
        message: `删除已经发出去，但**复核不了**（读 teachers 失败 HTTP ${leftTeacher.status}）—— 请刷新这一页确认`,
        cleaned,
        audited,
      },
      502,
    )
  }
  if (leftTeacher.rows.length > 0) {
    /* 这是"不报错但就是不对"的形状：HTTP 都成功了，行却还在 */
    return json(
      {
        status: 'error',
        message: '删除没有生效：teachers 里那一行还在（请刷新这一页确认，并把这条消息报给维护者）',
        cleaned,
        audited,
      },
      502,
    )
  }
  const stillAuth = await authUserExists(env, id)
  if (stillAuth === true) {
    return json(
      {
        status: 'error',
        message:
          '登录账号没有删掉（teachers 那一行已经没了）—— 请把这条消息报给维护者，' +
          '并到 Supabase → Authentication → Users 里手工删掉他。',
        cleaned,
        audited,
      },
      502,
    )
  }

  return json({
    status: 'ok',
    deleted: {
      id,
      name,
      subject,
      /** `teachers` 那一行**复核过**没了 */
      teacherRow: true,
      /** `auth.users` 那一行**复核过**没了（`'unknown'` = 复核不了，但不影响这次结果） */
      authUser: stillAuth === false ? true : 'unknown',
      /** 走的是哪条路：正常是 `auth-cascade`（级联）；孤儿行是 `teachers-only` */
      via,
    },
    cleaned,
    /** ⚠️ 留痕失败要把话说出来（它不是"没发生"，是"没记上"） */
    audited,
  })
}

/**
 * GET 回一份"接口活着"的自述 —— **不回任何状态、不回任何 key**。
 * 用途只有一个：让人能确认"这个路径部署上去了没有"（否则 404 与 403 很难区分）。
 */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/admin/teacher-delete',
    method: 'POST',
    body: { action: 'probe | delete', delete: { teacherId: '<uuid>' } },
    note: '需要登录，且判据是数据库的 can_manage_teachers()（超管 / 教务处）',
  })
}
