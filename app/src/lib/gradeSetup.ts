/* ============================================================
   开学准备（P6）的**写**：全部走服务端 `/api/grade-setup`
   ------------------------------------------------------------
   为什么写入**一条都不直接打 PostgREST**（三个理由，缺一不可）：

     ① 🔴 **`class_subjects` 在数据库层零写权限**（只有 select 策略）——
        批量写任教关系只能走 service_role 的服务端 Function（用户拍板：开批量接口）。
     ② 🔴 **名单导入必须是一个事务**：一次粘贴 = 建 N 个班 + 写几百个学生，
        "导了一半"是这一期最不能接受的失败样子。→ 一个 RPC = 一个事务。
     ③ 🔴 **选科 + 走班班成员必须同一个事务**（「其他」的学生，
        在 `schema.sql` §27.9 的 `write_student_subject()` 里）。

   ⚠️ 判据**一处都不在这里**：这一层只做
      "把 JWT 递上去 + 把服务端的人话带回来"（与 `lib/api.ts` 同一条纪律）。
      真正的闸门是服务端拿调用者 JWT 问那两个函数
      （`can_manage_grade_setup()` / `can_edit_student_subject()`）。

   ⚠️ 上限（超了要报人话，不是静默截断）—— 与 `schema.sql` §27 里那两个
      `raise exception` 的口径**必须同值**（`nav-checks.mjs` 的 A11 逐字比对）：
        · 一次导入名单：**3000 行**
        · 一次写任教关系：**2000 行**
   ============================================================ */

import { apiMessage, postApi, type ApiResult } from './api'

/* ============================================================
   「我在这个年级能不能改」—— 前端只做一件事：**把服务端的话分拣成人话**
   ------------------------------------------------------------
   🔴 2026-09-30 修的 bug：这一页以前**自己写了一遍 `fetch('/api/grade-setup')`，
      没有带 JWT** → 服务端的 `caller()` 回 401 → 页面把"没带令牌"显示成
      「你的身份只能看，不能改」——**连最高管理员都被冤枉**（他的按钮全灰）。
      根因就是"同一件事两个入口"：别的写动作都走 `postApi`（它带 JWT），
      只有这一条自己写了一遍。现在 `canSetup` **只有这一个入口**（`apiCanSetup`）。

   ⚠️ 判据**一个字都不在这里**：`canSetup` 由服务端拿调用者 JWT 问数据库的
      `can_manage_grade_setup()`。这一层只把下面几种情况**分开说** ——
      它们的下一步动作完全不同，混成一句"你没权限"会让人去改权限设置：
        · `denied`    服务端问过数据库：不能改（**只有这一种**能说"你的身份只能看"）
        · `missing`   §27 那一段 SQL 还没跑 → 去跑 `supabase/schema.sql`
        · `signin`    没有会话 / 会话过期 → 重新登录
        · `offline`   连不上服务端（断网 / 本地演示模式没有 `/api/*`）
        · `error`     别的失败（年级 id 不合法等）→ 原样带服务端那句话
   ============================================================ */

export type CanSetupVerdict = 'allowed' | 'denied' | 'missing' | 'signin' | 'offline' | 'error'

export type CanSetupState = {
  canSetup: boolean
  verdict: CanSetupVerdict
  /** 页面上那一句话；`''` = 没什么要说的（有权限时不解释） */
  notice: string
}

/** 把服务端的回话分拣成上面那几档（**纯函数**，`grade-checks.mjs` 逐档断言它） */
export function readCanSetup(r: ApiResult): CanSetupState {
  if (r.ok) {
    if (r.data.canSetup === true) return { canSetup: true, verdict: 'allowed', notice: '' }
    if (r.data.canSetup === false) return { canSetup: false, verdict: 'denied', notice: '你在这个年级只能看，不能改。' }
    /* 🔴 接口回了 ok 却没有结论 —— **不许静默当成"没权限"**（那又是冤枉一个人） */
    return {
      canSetup: false,
      verdict: 'error',
      notice: '接口没给权限结论，这一页现在只能看。',
    }
  }
  if (r.status === 503) {
    /* 服务端那句话里带着"第 27 段 / 去 SQL Editor 跑一遍"——原样带出来 */
    return { canSetup: false, verdict: 'missing', notice: apiMessage(r, '接口还没就绪。') }
  }
  if (r.status === 401) {
    return { canSetup: false, verdict: 'signin', notice: '登录已过期，重新登录后再试。' }
  }
  if (r.status === 0) {
    /* ⚠️ 这一档**不用** `apiMessage`：`postApi` 在本地演示模式下给的那句话里带着
       `（/api/*）` 这种技术路径 —— 判据 A+ 的口径是"主文案里不出现路径"。 */
    return { canSetup: false, verdict: 'offline', notice: '连不上服务器，这一页现在只能看。' }
  }
  return { canSetup: false, verdict: 'error', notice: apiMessage(r, '读不到你的权限，这一页现在只能看。') }
}

/**
 * 问服务端"我在这个年级能不能改"。
 * 🔴 走 `postApi`（它把当前会话的 JWT 放进 `Authorization`）—— **不许再自己写 fetch**：
 *    漏带 JWT = 服务端回 401 = 超管被显示成"你的身份只能看"（这次 bug 的形状）。
 */
export async function apiCanSetup(gradeId: string): Promise<CanSetupState> {
  return readCanSetup(await postApi('/api/grade-setup', { action: 'canSetup', gradeId }))
}

/** 一次导入名单的行数上限（服务端 `bulk_import_roster` 里的那个数） */
export const ROSTER_IMPORT_MAX = 3000

/** 一次写任教关系的行数上限（服务端 `bulk_write_class_subjects` 里的那个数） */
export const CLASS_SUBJECT_BULK_MAX = 2000

export type RosterImportRow = {
  classNo: string
  studentNo: string
  name: string
  /** 序列号；**留空** = 交给数据库触发器发号（导入不许自己算号） */
  serial?: string
}

export type RosterImportResult = {
  ok: boolean
  message: string
  /** 这次新建了几个班 */
  classes: number
  /** 这次写进去（含更新）几个学生 */
  students: number
  /** 有几个人**没拿到序列号**（这一届的入校年份认不出来）—— 必须报出来，不许静默 */
  noSerial: number
  /** 入库后的名单（界面拿它直接刷新，不再猜前端算出来的号） */
  roster: Array<{ id: string; classId: string; studentNo: string; name: string; serial: string }>
}

/** 录名单 + 按班号自动建班（**一个事务**：要么全成、要么一行都不落） */
export async function apiImportRoster(
  gradeId: string,
  rows: RosterImportRow[],
): Promise<RosterImportResult> {
  const empty: RosterImportResult = {
    ok: false,
    message: '',
    classes: 0,
    students: 0,
    noSerial: 0,
    roster: [],
  }
  if (!rows.length) return { ...empty, message: '一行都没有 —— 这份名单是空的' }
  if (rows.length > ROSTER_IMPORT_MAX) {
    return {
      ...empty,
      message: `一次最多导入 ${ROSTER_IMPORT_MAX} 行，这次有 ${rows.length} 行 —— 按年级分批贴。`,
    }
  }
  const r = await postApi('/api/grade-setup', {
    action: 'rosterImport',
    gradeId,
    rows: rows.map((x) => ({
      classNo: String(x.classNo ?? '').trim(),
      studentNo: String(x.studentNo ?? '').trim(),
      name: String(x.name ?? '').trim(),
      serial: String(x.serial ?? '').trim(),
    })),
  })
  if (!r.ok) return { ...empty, message: apiMessage(r, '导入名单失败') }
  const d = r.data as Record<string, unknown>
  return {
    ok: true,
    message: '导入完成',
    classes: Number(d.classes ?? 0),
    students: Number(d.students ?? 0),
    noSerial: Number(d.noSerial ?? 0),
    roster: Array.isArray(d.roster)
      ? (d.roster as Array<Record<string, unknown>>).map((x) => ({
          id: String(x.id ?? ''),
          classId: String(x.classId ?? ''),
          studentNo: String(x.studentNo ?? ''),
          name: String(x.name ?? ''),
          serial: String(x.serial ?? ''),
        }))
      : [],
  }
}

export type SubjectWriteRow = {
  studentId: string
  kind: 'standard' | 'other'
  primaryCode: string
  secondCodes: string[]
  note: string
  /** 只对「其他」有意义：手工选中的走班班 id */
  memberClassIds?: string[]
}

/** 写一批选科（**逐条各自一个事务**：一条非法只挡那一条 —— 见服务端的说明） */
export async function apiWriteSubjects(
  gradeId: string,
  rows: SubjectWriteRow[],
): Promise<{ ok: boolean; message: string; written: number; failures: Array<{ studentId: string; reason: string }> }> {
  if (!rows.length) return { ok: true, message: '没有要写的行', written: 0, failures: [] }
  const r = await postApi('/api/grade-setup', { action: 'subjectWrite', gradeId, rows })
  const d = r.data as Record<string, unknown>
  const failures = Array.isArray(d.failures)
    ? (d.failures as Array<Record<string, unknown>>).map((x) => ({
        studentId: String(x.studentId ?? ''),
        reason: String(x.reason ?? ''),
      }))
    : []
  return {
    ok: r.ok,
    message: r.ok ? '已保存' : apiMessage(r, '保存选科失败'),
    written: Number(d.written ?? 0),
    failures,
  }
}

export type ClassSubjectWriteRow = { classId: string; subjectCode: string; teacherId: string }

/**
 * **批量写任教关系**（一个事务）。
 *
 * 🔴 上限与形状都在这一层先挡一道（省一次往返），但**判据与人话仍以服务端为准** ——
 *    前端这一层挡不住手打接口的人（它不是安全边界）。
 */
export async function apiBulkClassSubjects(
  gradeId: string,
  rows: ClassSubjectWriteRow[],
): Promise<{ ok: boolean; message: string; rows: number; replaced: number }> {
  if (!rows.length) return { ok: false, message: '一行都没有 —— 这份表是空的', rows: 0, replaced: 0 }
  if (rows.length > CLASS_SUBJECT_BULK_MAX) {
    return {
      ok: false,
      message: `一次最多写 ${CLASS_SUBJECT_BULK_MAX} 行，这次有 ${rows.length} 行 —— 分两批。`,
      rows: 0,
      replaced: 0,
    }
  }
  const r = await postApi('/api/grade-setup', { action: 'classSubjectBulk', gradeId, rows })
  if (!r.ok) return { ok: false, message: apiMessage(r, '写任教关系失败'), rows: 0, replaced: 0 }
  const d = r.data as Record<string, unknown>
  return {
    ok: true,
    message: `已补 ${Number(d.rows ?? 0)} 行任课关系`,
    rows: Number(d.rows ?? 0),
    replaced: Number(d.replaced ?? 0),
  }
}

/* ============================================================
   🆕 P7：走班班的生成与分配（`schema.sql` §32；Q7 = B / Q19 = A）
   ------------------------------------------------------------
   🔴 **判据一处都不在这里**：两个动作都由服务端用 service_role + 显式 `p_actor`
      调那个写 RPC，判据在数据库的 `can_manage_grade_setup_for` 里（§30 的形状）。
      这一层只做"算建议 + 把服务端的人话带回来"。
   ============================================================ */

/** 一个走班班的建议（`lib/stream.ts` 的 `planStreamClasses()` 算出来的，**教导处确认后才写**） */
export type StreamGroupRow = {
  streamKey: string
  name: string
  subjects: string[]
  /** 已经存在的走班班 id（重算时认回来的那个）；没有就是空串 */
  classId?: string
  studentIds: string[]
}

export type StreamGenerateResult = {
  ok: boolean
  message: string
  /** 这次生成 / 重算了几个走班班 */
  created: number
  /** 一共写了多少条成员关系（**多对多**：差 2 门的学生会算两次） */
  members: number
  classes: Array<{ classId: string; name: string; streamKey: string; members: number }>
}

/**
 * **生成走班班**（一个事务）。
 *
 * 🔴 Q7 = B：这个函数**只在教导处点了「确认生成」之后**才被调用 ——
 *    调用之前，`planStreamClasses()` 算出来的只是一份**建议**（页面上给他看）。
 */
export async function apiGenerateStreams(
  gradeId: string,
  groups: StreamGroupRow[],
): Promise<StreamGenerateResult> {
  const empty: StreamGenerateResult = { ok: false, message: '', created: 0, members: 0, classes: [] }
  if (!groups.length) return { ...empty, message: '没有要走班的组合' }
  const r = await postApi('/api/grade-setup', { action: 'streamGenerate', gradeId, groups })
  if (!r.ok) return { ...empty, message: apiMessage(r, '生成走班班失败') }
  const d = r.data as Record<string, unknown>
  return {
    ok: true,
    message: `已生成 ${Number(d.created ?? 0)} 个走班班`,
    created: Number(d.created ?? 0),
    members: Number(d.members ?? 0),
    classes: Array.isArray(d.classes)
      ? (d.classes as Array<Record<string, unknown>>).map((x) => ({
          classId: String(x.classId ?? ''),
          name: String(x.name ?? ''),
          streamKey: String(x.streamKey ?? ''),
          members: Number(x.members ?? 0),
        }))
      : [],
  }
}

export type StreamAssignResult = {
  ok: boolean
  message: string
  /** 🔴 这次**补了几行** `class_subjects`（Q19 = A：界面必须明确提示） */
  added: number
  subjects: string[]
}

/**
 * **分配走班班老师**（Q19 = A：**自动补 `class_subjects`**，与分配同一个事务）。
 *
 * 🔴 返回的 `added` 必须上屏 —— "补了几行"是这一条验收的口径：
 *    不补的话那位老师建作业会被权限层**静默拒掉**（0 行、不报错）。
 */
export async function apiAssignStreamTeacher(
  gradeId: string,
  classId: string,
  teacherId: string,
): Promise<StreamAssignResult> {
  const r = await postApi('/api/grade-setup', { action: 'classSubjectAssign', gradeId, classId, teacherId })
  if (!r.ok) return { ok: false, message: apiMessage(r, '分配老师失败'), added: 0, subjects: [] }
  const d = r.data as Record<string, unknown>
  const added = Number(d.added ?? 0)
  return {
    ok: true,
    message: added > 0 ? `已分配，并补了 ${added} 行任课关系` : '已分配（任课关系本来就在）',
    added,
    subjects: Array.isArray(d.subjects) ? (d.subjects as unknown[]).map(String) : [],
  }
}
