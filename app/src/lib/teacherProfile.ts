/* ============================================================
   教师档案：**家庭住址 / 电话号码 / 邮箱**
   ------------------------------------------------------------
   表是 `teacher_profiles`（`supabase/schema.sql` §1.1 建表、§36 授权与策略）。

   🔴 **判据一个都不在这个文件里**（本仓库最贵的一条纪律）：
     · **看**谁读得到 → 数据库的 `teacher_profiles_visible`
       （`teacher_id = auth.uid()` = 自己那一行 ∪ `can_create_teacher_accounts()` = 超管 /
       教务处 / 办公室主任；**且不是教室端**）；
     · **改**谁写得动 → `can_create_teacher_accounts()` **同一档**（服务端 `profile` 动作
       用 service_role 走同一个判据）。⚠️ 班主任 / 年级主任**都不在里面** ——
       老师的家庭住址不是班主任该看的（`schema.sql` §36 写清了理由）。
   这里只回答"怎么读、怎么写"，以及**读不到的时候要显式说出来**。

   ⚠️ **三态**（不许把"读不到"说成"没录过"）：
     `present` / `missing`（表还没跑）/ `indeterminate`（网络抖了、别的错）——
     后者只是"没结论"，界面上是一句灰话，不是错误、更不是"这位老师没档案"。

   ⚠️ 本地演示模式（没有 Supabase）：**读不到就是读不到**（这里不编一份内存数据）——
     这一页要靠服务端 `listTeachers()` 才打得开，而那个在本地演示模式下本来就不通，
     所以演示模式下面板根本不会渲染。不摆假数据 = 不给"看起来能读"的错觉。
   ============================================================ */

import { MISSING_COL_RE, MISSING_TABLE_RE } from './announcements'
import { getSupabase, isRemote } from './supabase'

/** 三个字段 —— 顺序就是界面上的顺序（**只有这一处定义**） */
export const TEACHER_PROFILE_FIELDS = [
  { key: 'homeAddress', label: '家庭住址', hint: '如：某小区1号楼2单元501' },
  { key: 'phone', label: '电话号码', hint: '座机 / 手机都行' },
  { key: 'email', label: '邮箱', hint: '' },
] as const

export type TeacherProfileFieldKey = (typeof TEACHER_PROFILE_FIELDS)[number]['key']

export type TeacherProfile = {
  teacherId: string
  homeAddress: string
  /** 联系电话**原文**（座机 / 带区号 / 带分机都存得下 —— 形状由数据库那条 check 守） */
  phone: string
  /** **联系邮箱** —— 与登录账号（`auth.users.email`）不是一回事，改它不动登录方式 */
  email: string
}

export type TeacherProfileState = 'present' | 'missing' | 'indeterminate'

/** 空档案（没录过就是这个形状：三个字段都是空串） */
export function emptyTeacherProfile(teacherId: string): TeacherProfile {
  return { teacherId, homeAddress: '', phone: '', email: '' }
}

/** 录过没有（三个字段全空 = 没录过） */
export function teacherProfileFilled(p: TeacherProfile | undefined | null): boolean {
  if (!p) return false
  return TEACHER_PROFILE_FIELDS.some((f) => String(p[f.key] ?? '').trim() !== '')
}

/** 一行 `teacher_profiles`（PostgREST 形状）→ 前端形状。认不出的值一律退回空串 */
function rowToProfile(r: Record<string, unknown>): TeacherProfile {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
  return {
    teacherId: s(r.teacher_id),
    homeAddress: s(r.home_address),
    phone: s(r.phone),
    email: s(r.email),
  }
}

/* ---------------- 表存在性探针（`nav-checks` D10 盯着这一节） ----------------
   🔴 `select('*')` —— 表存在性与"有哪几列"无关（这一类 bug 咬过两次：
   `subjects` 没有 `id`、`notice_targets` 没有 `id`）。 */

let probe: Promise<TeacherProfileState> | null = null

async function probeTeacherProfiles(): Promise<TeacherProfileState> {
  const sb = getSupabase()
  if (!sb) return 'missing'
  try {
    const { error } = await sb.from('teacher_profiles').select('*').limit(1)
    if (!error) return 'present'
    const code = String((error as { code?: string }).code ?? '')
    const msg = String(error.message ?? '')
    // 「列不在」先摘出去：表探针拿到它只能记灰（绝不能据此说"表不在"）
    if (MISSING_COL_RE.test(code) || MISSING_COL_RE.test(msg)) return 'indeterminate'
    // 只有「表不在」才是 missing；认不出的错一律灰（不缓存）
    if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) return 'missing'
    return 'indeterminate'
  } catch {
    return 'indeterminate'
  }
}

/** 探一次（同一页面内只探一次） */
export function ensureTeacherProfiles(): Promise<TeacherProfileState> {
  if (!probe) probe = probeTeacherProfiles()
  return probe
}

/** 清掉探测缓存（"重试"用；只清缓存，什么都不写） */
export function resetTeacherProfileProbe(): void {
  probe = null
}

/* ---------------- 读 ---------------- */

export type TeacherProfileLoad =
  | { ok: true; profiles: Map<string, TeacherProfile> }
  | { ok: false; reason: 'missing' | 'indeterminate'; message: string }

/**
 * 读这批老师的档案。
 *
 * 🔴 **读不到就返回 `ok: false`** —— 调用方必须把"读不到"与"没录过"分开说
 * （这个仓库反复栽在"不报错但就是不对"上）。传进来的老师一个都没有时直接回空的成功。
 */
export async function loadTeacherProfiles(teacherIds: string[]): Promise<TeacherProfileLoad> {
  const ids = [...new Set(teacherIds.filter(Boolean))]
  const out = new Map<string, TeacherProfile>()
  if (!ids.length) return { ok: true, profiles: out }

  if (!isRemote) {
    return {
      ok: false,
      reason: 'missing',
      message: '读不到教师档案：本地演示模式没有数据库。',
    }
  }

  const state = await ensureTeacherProfiles()
  if (state === 'missing') {
    return {
      ok: false,
      reason: 'missing',
      message: '读不到教师档案。数据库可能还没跑 supabase/schema.sql 第 36 段（教师档案那一张表）。',
    }
  }

  const sb = getSupabase()
  if (!sb) {
    return { ok: false, reason: 'indeterminate', message: '读不到教师档案：现在连不上数据库。' }
  }
  try {
    const { data, error } = await sb.from('teacher_profiles').select('*').in('teacher_id', ids)
    if (error) {
      return {
        ok: false,
        reason: 'indeterminate',
        message: `读不到教师档案：${String(error.message ?? '未知错误')}`,
      }
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const p = rowToProfile(row)
      if (p.teacherId) out.set(p.teacherId, p)
    }
    return { ok: true, profiles: out }
  } catch (e) {
    return {
      ok: false,
      reason: 'indeterminate',
      message: `读不到教师档案：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/* ---------------- 写 ----------------
   🔴 **写走服务端**（`POST /api/teacher-account` 的 `profile` 动作，service_role +
   `can_create_teacher_accounts()` 判据）—— 前端**不直连**这张表去 upsert。
   理由：service_role 那条路绕开 RLS，判断只在一处；而前端这条路上的 RLS 是
   "自己那一行"（只读）—— 直连 upsert 对老师本人会静默失败（更糟的是"看着像存上了"）。
   本文件**不导出写函数**：调用方用 `lib/accounts.ts` 的 `saveTeacherProfile()`。 */
