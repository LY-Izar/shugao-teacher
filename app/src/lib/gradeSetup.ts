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

import { apiMessage, postApi } from './api'

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
