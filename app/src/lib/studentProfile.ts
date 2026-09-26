/* ============================================================
   学生档案：**民族 / 出生年月 / 家长电话 / 家庭住址**
   ------------------------------------------------------------
   表是 `student_profiles`（`supabase/schema.sql` §2.1 建表、§35 授权与策略）。

   🔴 **判据一个都不在这个文件里**（这是本仓库最贵的一条纪律）：
     · **看**谁读得到 → 数据库的 `student_profiles_visible`
       （`visible_class_ids()` = "看得见哪些班"，∪ 自己建的班；**且不是教室端**）；
     · **改**谁写得动 → 数据库的 `can_manage_class()`
       （最高管理员 / 教务处 ∪ 本年级年级主任 ∪ **本班班主任**）。
   这里只回答"怎么读、怎么写"，以及**读不到的时候要显式说出来**。

   ⚠️ **三态**（不许把"读不到"说成"没录过"）：
     `present` / `missing`（表还没跑）/ `indeterminate`（网络抖了、别的错）——
     后者只是"没结论"，界面上是一句灰话，不是错误、更不是"这个学生没档案"。

   ⚠️ 本地演示模式（没有 Supabase）：只在本页内存里放一份，用来给截图脚本走通
     "录入 → 看到"这条路 —— 它**不落盘**，也不是第二套判据（那台机器上根本没有数据库）。
   ============================================================ */

import { MISSING_COL_RE, MISSING_TABLE_RE } from './announcements'
import { getSupabase, isRemote } from './supabase'

/** 四个字段 —— 顺序就是界面上的顺序（**只有这一处定义**） */
export const PROFILE_FIELDS = [
  { key: 'ethnicity', label: '民族', hint: '如：汉族' },
  { key: 'birthMonth', label: '出生年月', hint: '如：2010-05' },
  { key: 'guardianPhone', label: '家长电话', hint: '' },
  { key: 'homeAddress', label: '家庭住址', hint: '' },
] as const

export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]['key']

export type StudentProfile = {
  studentId: string
  ethnicity: string
  /** 出生年月 `YYYY-MM`（**不是年龄**，也不是完整生日；数据库那条 check 守着形状） */
  birthMonth: string
  guardianPhone: string
  homeAddress: string
}

export type ProfileState = 'present' | 'missing' | 'indeterminate'

/** 空档案（没录过就是这个形状：四个字段都是空串） */
export function emptyProfile(studentId: string): StudentProfile {
  return { studentId, ethnicity: '', birthMonth: '', guardianPhone: '', homeAddress: '' }
}

/** 录过没有（四个字段全空 = 没录过） */
export function profileFilled(p: StudentProfile | undefined | null): boolean {
  if (!p) return false
  return PROFILE_FIELDS.some((f) => String(p[f.key] ?? '').trim() !== '')
}

/** 一行 `student_profiles`（PostgREST 形状）→ 前端形状。认不出的值一律退回空串 */
function rowToProfile(r: Record<string, unknown>): StudentProfile {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
  return {
    studentId: s(r.student_id),
    ethnicity: s(r.ethnicity),
    birthMonth: s(r.birth_month),
    guardianPhone: s(r.guardian_phone),
    homeAddress: s(r.home_address),
  }
}

/** 前端形状 → 落库的行（**列名只有这一处**） */
function profileToRow(p: StudentProfile): Record<string, string> {
  const t = (v: string) => String(v ?? '').trim()
  return {
    student_id: p.studentId,
    ethnicity: t(p.ethnicity),
    birth_month: t(p.birthMonth),
    guardian_phone: t(p.guardianPhone),
    home_address: t(p.homeAddress),
  }
}

/* ---------------- 表存在性探针（`nav-checks` D10 盯着这一节） ----------------
   🔴 `select('*')` —— 表存在性与"有哪几列"无关（这一类 bug 咬过两次：
   `subjects` 没有 `id`、`notice_targets` 没有 `id`）。 */

let probe: Promise<ProfileState> | null = null

async function probeStudentProfiles(): Promise<ProfileState> {
  const sb = getSupabase()
  if (!sb) return 'missing'
  try {
    const { error } = await sb.from('student_profiles').select('*').limit(1)
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
export function ensureStudentProfiles(): Promise<ProfileState> {
  if (!probe) probe = probeStudentProfiles()
  return probe
}

/** 清掉探测缓存（"重试"用；只清缓存，什么都不写） */
export function resetStudentProfileProbe(): void {
  probe = null
}

/* ---------------- 本地演示模式：只在本页内存里（不落盘） ---------------- */

const demoProfiles = new Map<string, StudentProfile>()

/* ---------------- 读 ---------------- */

export type ProfileLoad =
  | { ok: true; profiles: Map<string, StudentProfile> }
  | { ok: false; reason: 'missing' | 'indeterminate'; message: string }

/**
 * 读这批学生的档案。
 *
 * 🔴 **读不到就返回 `ok: false`** —— 调用方必须把"读不到"与"没录过"分开说
 * （这个仓库反复栽在"不报错但就是不对"上）。传进来的学生一个都没有时直接回空的成功。
 */
export async function loadStudentProfiles(studentIds: string[]): Promise<ProfileLoad> {
  const ids = [...new Set(studentIds.filter(Boolean))]
  const out = new Map<string, StudentProfile>()
  if (!ids.length) return { ok: true, profiles: out }

  if (!isRemote) {
    for (const id of ids) {
      const hit = demoProfiles.get(id)
      if (hit) out.set(id, hit)
    }
    return { ok: true, profiles: out }
  }

  const state = await ensureStudentProfiles()
  if (state === 'missing') {
    return {
      ok: false,
      reason: 'missing',
      message:
        '读不到学生档案。数据库可能还没跑 supabase/schema.sql 第 35 段（学生档案那一张表）。',
    }
  }

  const sb = getSupabase()
  if (!sb) {
    return { ok: false, reason: 'indeterminate', message: '读不到学生档案：现在连不上数据库。' }
  }
  try {
    const { data, error } = await sb.from('student_profiles').select('*').in('student_id', ids)
    if (error) {
      return {
        ok: false,
        reason: 'indeterminate',
        message: `读不到学生档案：${String(error.message ?? '未知错误')}`,
      }
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const p = rowToProfile(row)
      if (p.studentId) out.set(p.studentId, p)
    }
    return { ok: true, profiles: out }
  } catch (e) {
    return {
      ok: false,
      reason: 'indeterminate',
      message: `读不到学生档案：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/* ---------------- 写 ---------------- */

export type ProfileSave = { ok: true } | { ok: false; message: string }

/**
 * 保存一个学生的档案（upsert：没有行就建）。
 *
 * 🔴 失败**必须显式报错**：数据库那边被策略挡下的更新是"0 行且不报错"
 *    （`功能设计与不变量.md` §三.5），所以这里**数回落行数**——为 0 就说人话，
 *    绝不静默当成"已保存"。
 */
export async function saveStudentProfile(p: StudentProfile): Promise<ProfileSave> {
  if (!p.studentId) return { ok: false, message: '没选中学生，保存不了。' }
  const row = profileToRow(p)

  if (!isRemote) {
    // 本地演示模式：同形状地写进本页内存（刷新就没 —— 那台机器上没有数据库）
    demoProfiles.set(p.studentId, { ...p })
    return { ok: true }
  }

  const state = await ensureStudentProfiles()
  if (state === 'missing') {
    return {
      ok: false,
      message: '存不了学生档案。数据库可能还没跑 supabase/schema.sql 第 35 段（学生档案那一张表）。',
    }
  }

  const sb = getSupabase()
  if (!sb) return { ok: false, message: '存不了学生档案：现在连不上数据库。' }
  try {
    const { data, error } = await sb
      .from('student_profiles')
      .upsert(row, { onConflict: 'student_id' })
      .select('student_id')
    if (error) return { ok: false, message: `存不了学生档案：${String(error.message ?? '未知错误')}` }
    /* 🔴 0 行 = 被策略挡下了（多半是"这个班不归我管"）——**别报成功** */
    if (!data || data.length === 0) {
      return { ok: false, message: '这一条没存进去：这个班不归你管（数据库那边挡下了）。' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `存不了学生档案：${e instanceof Error ? e.message : String(e)}` }
  }
}
