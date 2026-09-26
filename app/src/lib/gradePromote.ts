/* ============================================================
   提档 + 毕业删除（P4）的**前端那一半**
   ------------------------------------------------------------
   施工图：`选科走班实施计划.md` 的 P4 段；决策：`年级管理与选科走班方案.md`
   §2.6（毕业删除 / 清残留清点表）· §2.7（身份撤回的边界）· §4.2.4(3)(4)（两个事务）。
   SQL：`supabase/schema.sql` **第 29 段**；服务端：`functions/api/grade-promote.ts`。

   🔴 这一层**一条判据都没有**（与 `lib/gradeSetup.ts` 同一条纪律）：
      · "我能不能提档" / "我能不能删" → `can_promote_grades()` / `can_delete_grade()`
        （服务端拿调用者 JWT 问数据库，回来后**只决定摆不摆按钮**）；
      · 真正的闸门在数据库：`grade_delete()` 自己问 `is_super_admin_for(p_actor)`
        并把输入的年级全名与 `grade_full_name()` 逐字比。
      · 这里的 `confirmMatches()` **只用来把按钮点亮**（UX），它不是判据 ——
        判据在 SQL 里那一句 `replace(btrim(p_confirm_name),' ','') <> replace(v_full,' ','')`。

   ⚠️ 三态（"没结论"必须是灰，绝不能红）：`readOverview()` 把六种回话分开，
      只有 `denied` 那一档才说"你的身份只能看"（§三.4 那条硬不变量）。
   ============================================================ */

import { apiMessage, postApi, type ApiResult } from './api'

/** 下载链接的有效期（与 `schema.sql` §29.6 的 `interval '90 days'` **必须同值**） */
export const BACKUP_LINK_DAYS = 90

/** 学段显示名（与 SQL 的 `grade_full_name()` **同一套字**；全名以服务端回话为准） */
export function stageLabel(stage: number): string {
  return stage === 1 ? '高一' : stage === 2 ? '高二' : stage === 3 ? '高三' : `学段 ${stage}`
}

export type PromoteGrade = {
  id: string
  name: string
  cohort: string
  stage: number
  /** 服务端算出来的**年级全名**（二次确认要逐字输入的那一串） */
  fullName: string
  classes: number
  students: number
  mailOk: boolean
  mailAt: string | null
  mailReason: string
  backupAt: string | null
  removedAt: string | null
  /** 备份那一行的 id（服务端下载备份要用它）；没有备份时是 `''` */
  removalId: string
  canDelete: boolean
  isSuper: boolean
}

export type PromoteOverview = {
  allowed: boolean
  today: string | null
  academicYear: string | null
  windowOpen: boolean
  promotedAt: string | null
  canPromote: boolean
  isSuper: boolean
  grades: PromoteGrade[]
}

export type OverviewState = {
  overview: PromoteOverview
  verdict: 'allowed' | 'denied' | 'missing' | 'signin' | 'offline' | 'error'
  /** 页面上那一句话；`''` = 没什么要说的 */
  notice: string
}

const EMPTY: PromoteOverview = {
  allowed: false,
  today: null,
  academicYear: null,
  windowOpen: false,
  promotedAt: null,
  canPromote: false,
  isSuper: false,
  grades: [],
}

function asGrade(raw: unknown): PromoteGrade {
  const g = (raw ?? {}) as Record<string, unknown>
  const num = (k: string) => (typeof g[k] === 'number' ? (g[k] as number) : Number(g[k] ?? 0) || 0)
  const str = (k: string) => (typeof g[k] === 'string' ? (g[k] as string) : '')
  const stage = num('stage')
  const cohort = str('cohort')
  return {
    id: str('id'),
    name: str('name'),
    cohort,
    stage,
    fullName: str('fullName') || `${stageLabel(stage)}${cohort ? `（${cohort} 级）` : '（届未知）'}`,
    classes: num('classes'),
    students: num('students'),
    mailOk: g.mailOk === true,
    mailAt: typeof g.mailAt === 'string' ? g.mailAt : null,
    mailReason: str('mailReason'),
    backupAt: typeof g.backupAt === 'string' ? g.backupAt : null,
    removedAt: typeof g.removedAt === 'string' ? g.removedAt : null,
    removalId: str('removalId'),
    canDelete: g.canDelete === true,
    isSuper: g.isSuper === true,
  }
}

/** 把服务端的回话分拣成六档（**纯函数**，`grade-checks` 逐档断言它） */
export function readOverview(r: ApiResult): OverviewState {
  if (r.ok) {
    const d = r.data as Record<string, unknown>
    if (typeof d.allowed !== 'boolean' || !Array.isArray(d.grades)) {
      /* 🔴 ok 却没有结论 —— **不许静默当成"没权限"**（那又会冤枉一个人） */
      return { overview: EMPTY, verdict: 'error', notice: '接口没给结论，这一页现在只能看。' }
    }
    return {
      overview: {
        allowed: d.allowed === true,
        today: typeof d.today === 'string' ? d.today : null,
        academicYear: typeof d.academicYear === 'string' ? d.academicYear : null,
        windowOpen: d.windowOpen === true,
        promotedAt: typeof d.promotedAt === 'string' ? d.promotedAt : null,
        canPromote: d.canPromote === true,
        isSuper: d.isSuper === true,
        grades: (d.grades as unknown[]).map(asGrade),
      },
      /* `allowed:false` = 数据库说了"你不是教导处 / 超管" —— **只有这一档**说"只能看" */
      verdict: d.allowed === true ? 'allowed' : 'denied',
      notice: d.allowed === true ? '' : '你的身份看不到提档与毕业这一页的内容。',
    }
  }
  if (r.status === 503) {
    /* 服务端那句话里带着"第 29 段 / 去 SQL Editor 跑一遍"——原样带出来 */
    return { overview: EMPTY, verdict: 'missing', notice: apiMessage(r, '接口还没就绪。') }
  }
  if (r.status === 401) {
    return { overview: EMPTY, verdict: 'signin', notice: '登录已过期，重新登录后再试。' }
  }
  if (r.status === 0) {
    return { overview: EMPTY, verdict: 'offline', notice: '连不上服务器，这一页现在只能看。' }
  }
  return { overview: EMPTY, verdict: 'error', notice: apiMessage(r, '读不到提档预览。') }
}

export async function apiOverview(): Promise<OverviewState> {
  return readOverview(await postApi('/api/grade-promote', { action: 'overview' }))
}

/* ---------------- 提档预览（**纯逻辑**，这一页的核心产物） ---------------- */

export type PlanRow = {
  id: string
  fullName: string
  from: string
  to: string
  classes: number
  students: number
  /** `promote` = 这次会改它；`graduate` = 停在高三，走毕业删除；`unknown` = 学段认不出来 */
  kind: 'promote' | 'graduate' | 'unknown'
}

/**
 * 改前 / 改后对照表（`年级管理与选科走班方案.md` §4.2.4(3) 的预览）。
 *
 * 🔴 **预览里没有"撤回身份"那一行** —— Q16：提档**不撤回任何身份**
 *    （原方案那一行已经删掉，这里连一句都不提，免得有人照着旧方案补回来）。
 * 🔴 年级 id 不变，所以"改前 / 改后"只有 `stage` 这一列在动；班级 / 学生数是**跟随**的。
 */
export function promotePlan(grades: PromoteGrade[]): PlanRow[] {
  return grades.map((g) => ({
    id: g.id,
    fullName: g.fullName,
    from: stageLabel(g.stage),
    to: g.stage === 3 ? '毕业删除' : stageLabel(g.stage + 1),
    classes: g.classes,
    students: g.students,
    kind: g.stage === 1 || g.stage === 2 ? 'promote' : g.stage === 3 ? 'graduate' : 'unknown',
  }))
}

/** 这一学年有没有要提的年级（预览表里有没有 `promote` 行） */
export function hasPromotable(grades: PromoteGrade[]): boolean {
  return grades.some((g) => g.stage === 1 || g.stage === 2)
}

/* ---------------- 二次确认（**只用来点亮按钮**，判据在 SQL） ---------------- */

/**
 * 输入的年级全名对不对。
 * ⚠️ 空格两边都去掉再比（与 `grade_delete()` 里那一句**同一套口径**）：
 *    "高三（2024 级）"里那个空格是渲染出来的，不该因为少打一个空格就让人以为"名字错了"。
 */
export function confirmMatches(typed: string, required: string): boolean {
  const norm = (s: string) => s.replace(/\s/g, '')
  return norm(typed).length > 0 && norm(typed) === norm(required)
}

/* ---------------- 写动作的三个"结果读取器"（纯函数） ---------------- */

export type ActionResult = {
  ok: boolean
  /** 服务端/数据库的人话 */
  message: string
  /** 失败时：**有没有改动数据**（删除失败时用它说"什么都没删"） */
  notDeleted: boolean
  verdict: 'ok' | 'denied' | 'missing' | 'signin' | 'offline' | 'refused' | 'error'
  data: Record<string, unknown>
}

function readAction(r: ApiResult): ActionResult {
  if (r.ok) {
    return { ok: true, message: '', notDeleted: false, verdict: 'ok', data: r.data }
  }
  if (r.status === 503) {
    return { ok: false, message: apiMessage(r, '接口还没就绪。'), notDeleted: false, verdict: 'missing', data: r.data }
  }
  if (r.status === 401) {
    return {
      ok: false,
      message: '登录已过期，重新登录后再试。',
      notDeleted: false,
      verdict: 'signin',
      data: r.data,
    }
  }
  if (r.status === 0) {
    return { ok: false, message: '连不上服务器，什么都没做成。', notDeleted: false, verdict: 'offline', data: r.data }
  }
  if (r.status === 403) {
    return { ok: false, message: apiMessage(r, '你的身份做不了这个动作。'), notDeleted: false, verdict: 'denied', data: r.data }
  }
  /* 400 = 数据库的人话（"备份还没发出去" / "年级全名不对" / "清残留校验没过"） */
  return {
    ok: false,
    message: apiMessage(r, '这一步没做成。'),
    notDeleted: r.data?.notDeleted === true,
    verdict: 'refused',
    data: r.data,
  }
}

/** 提档 */
export async function apiPromote(): Promise<ActionResult> {
  return readAction(await postApi('/api/grade-promote', { action: 'promote' }))
}

/* 提档结果里三个给界面用的数（`alreadyPromoted` 是幂等的那一条，要**明说**） */
export function readPromoteResult(a: ActionResult): {
  promoted: number
  alreadyPromoted: boolean
  academicYear: string
} {
  return {
    promoted: Number(a.data?.promoted ?? 0) || 0,
    alreadyPromoted: a.data?.alreadyPromoted === true,
    academicYear: typeof a.data?.academicYear === 'string' ? a.data.academicYear : '',
  }
}

/** 生成备份 + 发到超管邮箱（**发不出去就是失败**） */
export async function apiGradeBackup(gradeId: string): Promise<ActionResult> {
  return readAction(await postApi('/api/grade-promote', { action: 'backup', gradeId }))
}

/** 毕业删除（服务端会再验一次超管 + 逐字全名 + 备份已发出） */
export async function apiGradeDelete(gradeId: string, confirmName: string): Promise<ActionResult> {
  return readAction(await postApi('/api/grade-promote', { action: 'delete', gradeId, confirmName }))
}

/** 页面上下载那一份备份（超管 / 教导处） */
export async function apiDownloadBackup(removalId: string): Promise<ActionResult> {
  return readAction(await postApi('/api/grade-promote', { action: 'downloadBackup', removalId }))
}

/* ---------------- 🔴 清点表（删完之后"删掉了什么 + 还剩什么"） ---------------- */

export type ChecklistRow = {
  key: string
  label: string
  /** 删之前有多少 */
  before: number
  /** 后置校验：**必须为 0** */
  after: number
  ok: boolean
}

/**
 * 把服务端的 `report` 变成一张**逐项**的清点表。
 *
 * 🔴 每一项都必须给出"删之前多少 / 删之后还剩多少"，而**删之后必须为 0** ——
 *    这就是"清干净不留残留"的验收口径（§2.6 的清点表 + 本轮新发现的
 *    `shared_files.class_ids` 那一类）。`ok === false` 的行要**红着显示**，
 *    绝不许因为"看起来差不多"就咽下去。
 */
export function checklistRows(report: unknown): ChecklistRow[] {
  const r = (report ?? {}) as Record<string, unknown>
  const counts = (r.counts ?? {}) as Record<string, unknown>
  const checks = (r.checks ?? {}) as Record<string, unknown>
  const num = (src: Record<string, unknown>, k: string) => {
    const v = src?.[k]
    return typeof v === 'number' ? v : Number(v ?? 0) || 0
  }
  /* 顺序照 §2.6 的清点表（级联删不到的排前面），加一条本轮发现的第三类 */
  const items: Array<[string, string]> = [
    ['exams', '孤儿考试档案（`class_ids` 是数组、建不了外键）'],
    ['teacherRoles', '身份行（`scope_id` 没有外键：年级主任 / 班主任）'],
    ['sharedFiles', '共享文件的班级归属（`class_ids` 也是数组）'],
    ['scheduleItems', '排课行（`class_id` 是 set null，不是 cascade）'],
    ['classroomAccounts', '教室端行'],
    ['classrooms', '教室端设备行'],
    ['classSubjects', '任教关系（级联）'],
    ['classMembers', '走班班成员（级联）'],
    ['studentSubjects', '学生的选科（级联）'],
    ['students', '学生（级联）'],
    ['assignments', '作业档案（级联）'],
    ['calls', '呼叫记录（级联）'],
    ['examScores', '考试评分行（级联）'],
    ['noticeTargets', '通知的年级收件人（级联）'],
    ['classes', '班级'],
    ['grades', '年级本身'],
  ]
  return items.map(([key, label]) => {
    const before = num(counts, key)
    const after = num(checks, key)
    return { key, label, before, after, ok: after === 0 }
  })
}
