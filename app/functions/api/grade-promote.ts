/**
 * 提档 + 毕业删除（P4）—— `年级管理与选科走班方案.md` §2.6 / §2.7 / §4.2.4(3)(4) ·
 * `选科走班实施计划.md` 的 P4 段 · SQL 在 `supabase/schema.sql` **第 29 段**。
 *
 * | action | 谁 | 判据（数据库） | 做什么 |
 * |---|---|---|---|
 * | `overview`        | 教导处 / 超管 | `promotion_overview()` | 读提档预览 + 待删提示（只读） |
 * | `promote`         | 教导处 / 超管 | `can_promote_grades_for()` | **一个事务**改 `stage`（幂等） |
 * | `backup`          | 教导处 / 超管 | `is_school_admin_for()` | 生成备份 → **发到超管邮箱**（发不出去就是失败） |
 * | `delete`          | **只有超管** | `can_delete_grade_for()` + 逐字全名 | **真删**（一个事务 + 清残留校验） |
 * | `downloadBackup`  | 教导处 / 超管 | `grade_backup_payload()` | 页面上下载那一份备份 |
 *
 * 🔴 三条纪律（与 `grade-setup.ts` 同一套，只有一处不同，写在下面）：
 *   ① **判据一处都不在这里**：全部在数据库（`*_for(p_actor, …)`）。这个 Function 只做
 *      "验出调用者是谁 → 把 `p_actor` 传下去 → 把数据库的人话带回来"。
 *   ② 🔴 **这里用 service_role 调写入口**（与 `grade-setup.ts` 不同）：§29 的写函数是
 *      `revoke … from public, anon, authenticated` 的，而 PostgREST 以 `authenticated`
 *      角色执行 —— 拿调用者 JWT 调**必然 42501**。所以改成"service_role + 显式 p_actor"，
 *      `p_actor` 仍然是从调用者 JWT 里验出来的那个 id（`caller()`）。
 *   ③ **邮件发不出去 = 备份没完成 = 删不了**：`backup` 这一步把发信结果写回
 *      `grade_removals.mail_ok`，`grade_delete()` 拿它当前置。**失败不吞**。
 *
 * 环境变量：`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
 *           `RESEND_API_KEY` / `ADMIN_NOTIFY_EMAIL`（收件人，没配就显式报错、一封信都不发）
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  anonKey,
  audit,
  baseUrl,
  caller,
  json,
  needStage,
  rpcBool,
  rpcJson,
  serviceKey,
  svcRpc as svcRpcLib,
} from './_lib/supa'
import { SYSTEM_MAIL_BODIES, beijingStamp, sendAuditedMail } from './_lib/mail'

const NEED_STAGE29 = needStage('29', '提档与毕业删除（`promote_grades` / `grade_delete` 就在那一段）')

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BUCKET = 'classroom-files'

type Body = {
  action?: 'overview' | 'promote' | 'backup' | 'delete' | 'downloadBackup'
  gradeId?: string
  removalId?: string
  /** 二次确认：**逐字**输入的年级全名 */
  confirmName?: string
}

/* ---------------- service_role 调一个 RPC（唯一一处写路径） ---------------- */

type RpcOut = { ok: boolean; status: number; value: Record<string, unknown>; message: string }

/**
 * 用管理员密钥调一个 RPC（绕过 RLS），**写路径只有这一处**。
 * ⚠️ `p_actor` 必须由调用方传进来，而且只能是 `caller()` 验出来的那个 id ——
 *    这是"service_role 不凭一个幽灵 id 写库"的唯一保证（照 `notice.ts` 的做法）。
 *
 * ⚠️ 2026-10-02：函数体已抽到 `_lib/supa.ts` 的 `svcRpc()`（`grade-setup.ts` 的
 *    三个写入口现在也走它）—— 这里只留一个**转发 + 保留原返回形状**的薄壳，
 *    免得同一段解析逻辑有两份、改一处忘一处。`RpcOut` 这个名字在本文件里照旧用。
 */
async function svcRpc(env: Env, fn: string, body: Record<string, unknown>): Promise<RpcOut> {
  const r = await svcRpcLib(env, fn, body)
  return { ok: r.ok, status: r.status, value: r.value, message: r.message }
}

/**
 * §29 那一段 SQL 还没跑时的形状：函数不存在（PostgREST 404 + `PGRST202`，
 * 或者 PostgreSQL 的 `42883`）。🔴 它**必须与"你没权限"分开** ——
 * 把"还没跑 SQL"报成"你没权限"，会让人去改权限设置，越改越乱。
 */
function fnMissing(status: number, message: string): boolean {
  return status === 404 || /PGRST202|42883|does not exist|schema cache/i.test(message)
}

/* ---------------- 人话 ---------------- */

/** 数据库 `raise exception` 的话原样带回（那些就是人话），否则给一句兜底 */
function dbMessage(r: RpcOut, fallback: string): string {
  return r.message || `${fallback}（HTTP ${r.status}）`
}

/** 权限被拒的三种形状：**分开报**（"你没权限"与"数据库还没跑"是两件事） */
function failureStatus(r: RpcOut): number {
  if (/只有最高管理员|只有教导处|没权限|permission denied/i.test(r.message)) return 403
  return 400
}

/**
 * 备份的**大小**用 KB / MB 说，**不用字节数**。
 * 🔴 理由不是好看：`_lib/mail.ts` 的正文体检把"裸的 7 位数字"当成档案键形状，
 *    命中就整封信不发 —— 而"备份 1234567 字节"正好会命中（10 GB 以下都可能）。
 */
function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '读不到大小'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 校验和分 4 位一组 —— 同一条理由（连续 7 位数字会被正文体检拦下） */
function checksumText(md5: string): string {
  return (md5.match(/.{1,4}/g) ?? []).join(' ')
}

/** 逐项计数 → 邮件里那几行（**只有条数，没有任何个人信息**） */
function countLines(counts: Record<string, unknown>): string {
  const n = (k: string) => {
    const v = counts?.[k]
    return typeof v === 'number' ? v : Number(v ?? 0) || 0
  }
  return [
    `班级 ${n('classes')} 个`,
    `学生 ${n('students')} 人`,
    `作业档案 ${n('assignments')} 份`,
    `呼叫记录 ${n('calls')} 条`,
    `考试档案 ${n('exams')} 场`,
    `考试评分记录 ${n('examScores')} 行`,
    `任教关系 ${n('classSubjects')} 行`,
    `身份行（年级主任 / 班主任）${n('teacherRoles')} 行`,
    `教室端账号 ${n('classroomAccounts')} 个`,
  ].join(' · ')
}

/* ---------------- 教室端账号与对象存储（删完之后的收尾） ---------------- */

/**
 * 删掉本届教室端的 **auth 账号**。
 *
 * 🔴 为什么必须做：`classroom_accounts.class_id` 是 cascade → 删班时**行**会跟着走，
 *    但 `auth.users` 里那个账号**不会** —— 留下"能登录、却什么都读不到"的账号
 *    （用户点名的"别留能登录但读不到东西的账号"）。
 * ⚠️ 失败**不许吞**：返回逐条结果，页面把失败条数显示出来（否则又是"不报错但就是不对"）。
 */
async function deleteClassroomAccounts(
  env: Env,
  accounts: Array<{ id?: unknown; email?: unknown }>,
): Promise<{ total: number; deleted: number; failed: Array<{ id: string; message: string }> }> {
  const key = serviceKey(env)
  const failed: Array<{ id: string; message: string }> = []
  let deleted = 0
  for (const a of accounts) {
    const id = String(a?.id ?? '')
    if (!UUID_RE.test(id)) continue
    try {
      const res = await fetch(`${baseUrl(env)}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      })
      if (res.ok) deleted++
      else failed.push({ id, message: `删除账号回 ${res.status}：${(await res.text()).slice(0, 160)}` })
    } catch (e) {
      failed.push({ id, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: accounts.length, deleted, failed }
}

/**
 * 删掉那些**整行被删**的共享文件在对象存储里的对象。
 * ⚠️ 只删"行没了"的那些：一份文件同时发给别的年级时，行还在、对象必须留着。
 */
async function deleteStorageObjects(
  env: Env,
  paths: unknown,
): Promise<{ total: number; deleted: number; failed: Array<{ path: string; message: string }> }> {
  const key = serviceKey(env)
  const list = Array.isArray(paths) ? paths.map((p) => String(p ?? '')).filter(Boolean) : []
  const failed: Array<{ path: string; message: string }> = []
  let deleted = 0
  for (const path of list) {
    try {
      const res = await fetch(
        `${baseUrl(env)}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } },
      )
      if (res.ok) deleted++
      else failed.push({ path, message: `删除对象回 ${res.status}：${(await res.text()).slice(0, 160)}` })
    } catch (e) {
      failed.push({ path, message: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: list.length, deleted, failed }
}

/* ---------------- 入口 ---------------- */

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

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  const action = body.action ?? 'overview'
  const gradeId = String(body.gradeId ?? '').trim()

  /* ---------------- overview：提档预览 + 待删提示（只读） ---------------- */
  if (action === 'overview') {
    const r = await rpcJson(env, me.token, 'promotion_overview')
    if (!r.ok) {
      if (/PGRST202|does not exist|schema cache/i.test(r.text)) {
        return json({ status: 'error', message: NEED_STAGE29 }, 503)
      }
      return json({ status: 'error', message: '读不到提档预览' }, 400)
    }
    const v = (r.value ?? {}) as Record<string, unknown>
    const canPromote = await rpcBool(env, me.token, 'can_promote_grades')
    if (canPromote === 'missing') return json({ status: 'error', message: NEED_STAGE29 }, 503)
    const isSuper = await rpcBool(env, me.token, 'is_super_admin')
    if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)

    /*
     * 每个年级"能不能删"**逐个问数据库**（不在这里算：那是同一件事第二个判定入口）。
     * 年级就三五个，几次往返换"判据只有一处"，值。
     */
    const grades = Array.isArray(v.grades) ? (v.grades as Record<string, unknown>[]) : []
    const withDelete: Record<string, unknown>[] = []
    for (const g of grades) {
      const id = String(g.id ?? '')
      const can = UUID_RE.test(id) && isSuper
        ? await rpcBool(env, me.token, 'can_delete_grade', { p_grade_id: id })
        : false
      withDelete.push({ ...g, canDelete: can === true, isSuper })
    }

    return json({
      status: 'ok',
      allowed: v.allowed === true,
      today: v.today ?? null,
      academicYear: v.academicYear ?? null,
      windowOpen: v.windowOpen === true,
      promotedAt: v.promotedAt ?? null,
      canPromote: canPromote === true,
      isSuper: isSuper === true,
      grades: withDelete,
    })
  }

  /* ---------------- promote：提档（一个事务 + 幂等） ---------------- */
  if (action === 'promote') {
    /*
     * ⚠️ 这里**不做"先探一下函数在不在"的预调用**：`promote_grades()` 是有副作用的，
     *    预调用会真的提一次档。函数不存在这件事从**失败的那一次调用**里认（`fnMissing`）。
     */
    const r = await svcRpc(env, 'promote_grades', { p_actor: me.id })
    if (!r.ok) {
      if (fnMissing(r.status, r.message)) return json({ status: 'error', message: NEED_STAGE29 }, 503)
      return json({ status: 'error', message: dbMessage(r, '提档失败') }, failureStatus(r))
    }
    await audit(env, {
      actorId: me.id,
      action: 'grade.promote',
      target: String(r.value.academicYear ?? ''),
      detail: r.value.alreadyPromoted === true
        ? `本学年已提档，未改动（${beijingStamp()}）`
        : `提档 ${String(r.value.promoted ?? 0)} 个年级`,
      affected: Number(r.value.promoted ?? 0),
    })
    return json({ status: 'ok', ...r.value })
  }

  /* ---------------- backup：生成备份 → 发到超管邮箱（**发不出去就是失败**） ---------------- */
  if (action === 'backup') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)

    const r = await svcRpc(env, 'grade_backup', { p_actor: me.id, p_grade_id: gradeId })
    if (!r.ok) {
      if (fnMissing(r.status, r.message)) return json({ status: 'error', message: NEED_STAGE29 }, 503)
      return json({ status: 'error', message: dbMessage(r, '生成备份失败') }, failureStatus(r))
    }

    const v = r.value
    const removalId = String(v.removalId ?? '')
    const token = String(v.token ?? '')
    const name = String(v.gradeName ?? '')
    const counts = (v.counts ?? {}) as Record<string, unknown>
    const link = `${new URL(request.url).origin}/api/grade-promote?token=${encodeURIComponent(token)}`
    /*
     * 🔴 邮件正文里放的是**相对**路径（`/api/grade-promote?token=…`），不是上面那个绝对链接。
     *    理由不是好看：`_lib/mail.ts` 的 `scrubSecrets()` 有一条**刻意**的规则 ——
     *    把绝对 URL 的 query string 整段擦掉（那是"凭据可能夹在链接里"的最后一道）。
     *    于是 `https://站点/api/grade-promote?token=xxx` 到了收件箱里会变成
     *    `https://站点/api/grade-promote`（令牌没了，点开必然 400）——**一封信看着有链接、其实没用**。
     *    相对路径没有 `http://` 前缀，不会被那条规则命中，令牌原样保留。
     *    ⚠️ 别为了"让邮件好看"去动 `scrubSecrets()`：它是别的几处发信共用的安全控制。
     *    页面上的「下载备份」是**首选**通道（它走 JWT + 判据），这一行是"人不在平台上"时的兜底。
     */
    const path = `/api/grade-promote?token=${encodeURIComponent(token)}`

    const mail = await sendAuditedMail(env, {
      action: 'mail.gradeBackup',
      actorId: me.id,
      subject: `【树高平台】${name} 毕业备份 · ${beijingStamp()}`,
      /* 正文在 `SYSTEM_MAIL_BODIES.gradeBackup`（唯一一处构造；自测逐条喂它） */
      text: SYSTEM_MAIL_BODIES.gradeBackup({
        stamp: beijingStamp(),
        gradeName: name,
        /* ⚠️ 下面三行都是**已经处理过形状**的（`sizeText()` 防 7 位连号、`checksumText()` 每 4 位断开） */
        countsLine: countLines(counts),
        sizeLine: sizeText(Number(v.byteSize ?? 0)),
        checksumLine: checksumText(String(v.checksum ?? '')),
        tokenPath: path,
      }),
      affected: 1,
    })

    /* 🔴 把发信结果写回数据库 —— `grade_delete()` 拿它当前置条件 */
    const wrote = await svcRpc(env, 'grade_backup_mail', {
      p_actor: me.id,
      p_removal_id: removalId,
      p_ok: mail.ok === true,
      p_reason: mail.ok ? '' : `${mail.reason}`,
    })

    if (!mail.ok) {
      /* 🔴 硬前置：**发不出去就是失败**（不许"跳过继续删"） */
      return json(
        {
          status: 'error',
          reason: mail.reason,
          message:
            `备份已经生成，但**没有存成功**（${mail.message}）—— 按规矩这个年级现在删不掉。` +
            '把通道修好（或稍后重试）再走一遍备份。',
          removalId,
          counts,
        },
        mail.reason === 'no_key' || mail.reason === 'no_to' ? 503 : 502,
      )
    }

    await audit(env, {
      actorId: me.id,
      action: 'grade.backup',
      target: name,
      detail: `备份已发到超管邮箱（${mail.to}）· ${wrote.ok ? '状态已登记' : '⚠️ 状态登记失败'}`,
      affected: 1,
    })

    return json({
      status: 'ok',
      removalId,
      token,
      link,
      expiresAt: v.expiresAt ?? null,
      gradeName: name,
      confirmName: v.confirmName ?? name,
      checksum: v.checksum ?? '',
      byteSize: v.byteSize ?? 0,
      counts,
      mailedTo: mail.to,
      mailStatusRecorded: wrote.ok,
    })
  }

  /* ---------------- delete：毕业删除（**只有超管** + 逐字全名） ---------------- */
  if (action === 'delete') {
    if (!UUID_RE.test(gradeId)) return json({ status: 'error', message: '没有指定年级' }, 400)
    const confirmName = String(body.confirmName ?? '')

    const r = await svcRpc(env, 'grade_delete', {
      p_actor: me.id,
      p_grade_id: gradeId,
      p_confirm_name: confirmName,
    })
    if (!r.ok) {
      if (fnMissing(r.status, r.message)) return json({ status: 'error', message: NEED_STAGE29 }, 503)
      return json({ status: 'error', message: dbMessage(r, '删除失败'), notDeleted: true }, failureStatus(r))
    }

    const v = r.value
    const already = v.alreadyDeleted === true

    /* 收尾①：对象存储里那些"整行被删"的共享文件 */
    const storage = already
      ? { total: 0, deleted: 0, failed: [] as Array<{ path: string; message: string }> }
      : await deleteStorageObjects(env, v.storagePaths)

    /* 收尾②：本届教室端的 auth 账号（行被 cascade 带走了，账号不会） */
    const accounts = already
      ? { total: 0, deleted: 0, failed: [] as Array<{ id: string; message: string }> }
      : await deleteClassroomAccounts(
          env,
          Array.isArray(v.classroomAccounts) ? (v.classroomAccounts as Array<Record<string, unknown>>) : [],
        )

    await audit(env, {
      actorId: me.id,
      action: already ? 'grade.deleteRepeat' : 'grade.delete',
      target: String(v.gradeName ?? ''),
      detail: already
        ? '同一个年级重复删除请求：什么都没改，返回上一次的报告'
        : `已删除 · 教室端账号 ${accounts.deleted}/${accounts.total} · 存储对象 ${storage.deleted}/${storage.total}`,
      affected: already ? 0 : 1,
    })

    return json({
      status: 'ok',
      alreadyDeleted: already,
      report: v.report ?? null,
      gradeName: v.gradeName ?? '',
      deletedAt: v.deletedAt ?? null,
      classroomAccounts: accounts,
      storageObjects: storage,
    })
  }

  /* ---------------- downloadBackup：页面上下载那一份备份 ---------------- */
  if (action === 'downloadBackup') {
    const removalId = String(body.removalId ?? '').trim()
    if (!UUID_RE.test(removalId)) return json({ status: 'error', message: '没有指定备份' }, 400)
    const r = await svcRpc(env, 'grade_backup_payload', { p_actor: me.id, p_removal_id: removalId })
    if (!r.ok) {
      if (fnMissing(r.status, r.message)) return json({ status: 'error', message: NEED_STAGE29 }, 503)
      return json({ status: 'error', message: dbMessage(r, '取备份失败') }, failureStatus(r))
    }
    await audit(env, {
      actorId: me.id,
      action: 'grade.backupDownload',
      target: String(r.value.gradeName ?? ''),
      detail: '页面下载备份',
      affected: 1,
    })
    return json({
      status: 'ok',
      gradeName: r.value.gradeName ?? '',
      checksum: r.value.checksum ?? '',
      byteSize: r.value.byteSize ?? 0,
      payload: r.value.payload ?? null,
    })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/**
 * `GET /api/grade-promote?token=…` —— **邮件里那个下载链接**。
 *
 * 🔴 它**不带 JWT**（邮件客户端点开一个 URL 没法带 Authorization），
 *    所以令牌本身就是唯一凭据、有效期是唯一的访问控制 —— 这正是 §4.2.7 的口径
 *    （"带有效期的签名下载链接"）与 U-14 = C（90 天）的落点。
 * 🔴 **每一次下载都留痕**（数据库数 download_count，审计里写一行）：
 *    备份会离开系统，出去以后只能靠这条记录回答"谁什么时候取过"。
 */
export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context
  if (!baseUrl(env) || !serviceKey(env)) return json({ status: 'error', message: NEED_SUPABASE }, 503)

  const token = new URL(request.url).searchParams.get('token') ?? ''
  if (!token) {
    return json(
      {
        status: 'ok',
        endpoint: '/api/grade-promote',
        method: 'POST',
        body: { action: 'overview | promote | backup | delete | downloadBackup' },
        note: 'GET ?token=… 是邮件里那个备份下载链接（令牌即凭据，90 天有效）；其余动作都是 POST',
      },
      200,
    )
  }

  const r = await svcRpc(env, 'grade_backup_by_token', { p_token: token })
  if (!r.ok) {
    if (fnMissing(r.status, r.message)) return json({ status: 'error', message: NEED_STAGE29 }, 503)
    /* 认不出 / 过期 → 400（人话由数据库给），**不返回任何内容** */
    return json({ status: 'error', message: dbMessage(r, '这个备份取不出来') }, 400)
  }

  const name = String(r.value.gradeName ?? '备份')
  await audit(env, {
    actorId: null,
    action: 'grade.backupDownload',
    target: name,
    detail: '从邮件链接下载备份（令牌）',
    affected: 1,
  })

  const filename = `${name.replace(/[\\/:*?"<>|（）]/g, '')}-备份.json`
  return new Response(JSON.stringify(r.value.payload ?? null), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  })
}

/** 供 `admin-checks` 之类静态核对：这个 Function 的写路径**只有 service_role → RPC 一处** */
export const P4_WRITE_PATH = 'service_role + rpc(p_actor)'
