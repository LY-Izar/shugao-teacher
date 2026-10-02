/* ============================================================
   教室端那三张新表 + 课代表口令（`supabase/schema.sql` §40）
   ------------------------------------------------------------
   这一层管四件事，全部**只碰数据库**（不碰 store、不碰 React）：
     · **每日作业** `daily_homework` —— 今天各科留了什么（每科可多条）；
     · **值日生锚点** `duty_assignments` —— 只读/写"老师明确指定过的那天"，
       其余日期由 `lib/duty.ts` 那个纯函数推（这里不重复实现轮值）；
     · **校历覆盖** `school_calendar` —— 学校自己改过的那些天；
     · **课代表口令** —— 设（`set_class_rep_pin`）与用（`rep_set_daily_homework`）
       两个 `security definer` 函数。🔴 `class_rep_pins` 那张表**一个表权限都不给客户端**，
       所以这里连"读口令"的函数都没有，也不需要。

   🔴 为什么单独立一个 lib、而不是塞进 `data/remote.ts` + `data/store.ts`：
     这三样只有**教室端一块屏 + 教师端三个入口**用得到，不是全局业务数据；
     而探测 / 优雅降级这一套与 `lib/announcements.ts` / `lib/files.ts` 是同一套纪律
     （判据只认「表不在」，网络抖动一律当作"在"，探测没结论**不缓存**）。

   🔴 本地演示模式：数据来自 `data/seed.ts` 的三个 demo 生成器，**写操作落在内存**
     （刷新页面回到演示数据）。演示模式本来就没有权限层（`canManageSchedule()` 回 `'local'`
     是同一条口径），所以这里照常摆入口、照常能写。
   ============================================================ */

import { getSupabase } from './supabase'
import { MISSING_TABLE_RE } from './announcements'
import { beijingNow, ymdOf } from './holiday'
import { makeDemoClasses, makeDemoDailyHomework, makeDemoDutyAnchors } from '../data/seed'
import type { CalendarOverride, DutyAnchor, DutyInput, DutyResult } from './duty'
import { dutyForDate, dutyRoster, dutyToday } from './duty'
import type { DailyHomework, SchoolCalendarDay, Student } from '../data/types'

export type { CalendarOverride, DutyAnchor, DutyResult }

/* ---------------- 探测：§40 那三张表在不在？ ---------------- */

export type DailyTables = 'present' | 'missing' | 'unknown' | 'local'

/*
 * 🔴 探**三张**，`class_rep_pins` 刻意不在里面：它 revoke 了 authenticated 的全部表权限
 *    （§40.4），探它只会拿到 `42501 permission denied` —— 那是"没权限"不是"表不在"，
 *    按本文件的判据它会永远停在"灰"，把整块功能拖成不可用。
 */
const DAILY_TABLES = ['daily_homework', 'duty_assignments', 'school_calendar'] as const

let dailyProbe: Promise<DailyTables> | null = null

async function probeDailyTables(): Promise<DailyTables> {
  const sb = getSupabase()
  if (!sb) return 'local'
  const has = async (table: string): Promise<boolean | null> => {
    try {
      /* 🔴 `select('*')`，不是 `select('id')` —— 表存在性只跟"这张表在不在"有关 */
      const { error } = await sb.from(table).select('*').limit(1)
      if (!error) return true
      if (MISSING_TABLE_RE.test(String((error as { code?: string }).code ?? ''))
        || MISSING_TABLE_RE.test(String(error.message ?? ''))) return false
      return null // 认不出来（含 `42703`「列不在」）→ "不知道"，绝不判成"表不在"
    } catch {
      return null
    }
  }
  const found = await Promise.all(DAILY_TABLES.map((t) => has(t)))
  if (found.some((f) => f === false)) return 'missing'
  if (found.some((f) => f === null)) {
    dailyProbe = null // 探测本身没结论 → **不缓存**（可能只是断网）
    return 'unknown'
  }
  return 'present'
}

/** 探一次（同一页面内只探一次） */
export function ensureDailyTables(): Promise<DailyTables> {
  if (!dailyProbe) dailyProbe = probeDailyTables()
  return dailyProbe
}

/** 清掉探测缓存（"重试"用；只清缓存，不写任何东西） */
export function resetDailyProbe(): void {
  dailyProbe = null
}

/** 探测结论 → 给页面的一句话（空串 = 不用说话） */
export function dailyNotice(state: DailyTables): string {
  if (state === 'missing') return '每日作业 / 值日生还没开通。'
  if (state === 'unknown') return '这一次没读出每日作业 / 值日生，先按空显示。'
  return ''
}

/* ---------------- 行 → 前端形状 ---------------- */

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Date.parse(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

export function asDailyHomework(raw: Record<string, unknown>): DailyHomework {
  return {
    id: str(raw.id),
    classId: str(raw.class_id),
    onDate: str(raw.on_date).slice(0, 10),
    subject: str(raw.subject),
    subjectCode: str(raw.subject_code) || undefined,
    content: str(raw.content),
    seq: Number(raw.seq ?? 0) || 0,
    source: raw.source === 'rep' ? 'rep' : 'teacher',
    authorName: str(raw.author_name),
    createdAt: num(raw.created_at),
  }
}

export function asSchoolCalendarDay(raw: Record<string, unknown>): SchoolCalendarDay {
  return {
    onDate: str(raw.on_date).slice(0, 10),
    kind: raw.kind === 'school' ? 'school' : 'off',
    note: str(raw.note),
    updatedByName: str(raw.updated_by_name),
    updatedAt: num(raw.updated_at),
  }
}

/* ---------------- 本地演示模式的那一份（内存） ---------------- */

type LocalState = {
  homework: DailyHomework[]
  anchors: DutyAnchor[]
  calendar: SchoolCalendarDay[]
}

let localState: LocalState | null = null
let localSeq = 0

function local(): LocalState {
  if (!localState) {
    const classes = makeDemoClasses()
    localState = {
      homework: makeDemoDailyHomework(classes),
      anchors: makeDemoDutyAnchors(classes),
      calendar: [],
    }
  }
  return localState
}

/* ---------------- 读 ---------------- */

export type DailyBundle = {
  state: DailyTables
  /** 这一段日期里的每日作业（按日期 + 学科顺序） */
  homework: DailyHomework[]
  /** 值日生锚点（这个班全部；数量很小，一次拿完，轮值在前端推） */
  anchors: DutyAnchor[]
  /** 同一段日期里的校历覆盖 */
  calendar: CalendarOverride[]
  /** 给页面的一句话（空 = 不用说话） */
  notice: string
}

/**
 * 教室端 / 教师端**一次拿齐**这三样（三条查询并发，别串行）。
 * `from` / `to` 是校历覆盖与每日作业的日期窗口（教室端 = 今天那一天 ± 几天）。
 */
export async function loadDailyBundle(
  classId: string,
  fromIso: string,
  toIso: string,
): Promise<DailyBundle> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    return {
      state,
      homework: l.homework.filter((h) => h.classId === classId && h.onDate >= fromIso && h.onDate <= toIso),
      /*
       * ⚠️ 演示模式里锚点**没有班级这一列**（它就是"哪天是谁"两列，`DutyAnchor` 的形状），
       *    两个演示班的锚点混在一起返回 —— 不打紧：`lib/duty.ts` 只认**池子里有的人**，
       *    别班的学号落在池外，那条锚点自然不算数。
       */
      anchors: l.anchors.slice(),
      calendar: l.calendar.filter((c) => c.onDate >= fromIso && c.onDate <= toIso).map((c) => ({ onDate: c.onDate, kind: c.kind })),
      notice: '',
    }
  }
  if (state !== 'present') {
    return { state, homework: [], anchors: [], calendar: [], notice: dailyNotice(state) }
  }
  const sb = getSupabase()
  if (!sb) return { state: 'local', homework: [], anchors: [], calendar: [], notice: '' }
  const [hw, duty, cal] = await Promise.all([
    sb.from('daily_homework').select('*').eq('class_id', classId)
      .gte('on_date', fromIso).lte('on_date', toIso).order('on_date').order('seq'),
    sb.from('duty_assignments').select('*').eq('class_id', classId).order('on_date'),
    sb.from('school_calendar').select('*').gte('on_date', fromIso).lte('on_date', toIso),
  ])
  const fail = hw.error ?? duty.error ?? cal.error
  if (fail) {
    return {
      state: 'unknown',
      homework: [],
      anchors: [],
      calendar: [],
      notice: '这一次没读出每日作业 / 值日生。',
    }
  }
  return {
    state,
    homework: (hw.data ?? []).map((r) => asDailyHomework(r as Record<string, unknown>)),
    anchors: (duty.data ?? []).map((r) => {
      const row = r as Record<string, unknown>
      return { onDate: str(row.on_date).slice(0, 10), studentId: str(row.student_id) }
    }),
    calendar: (cal.data ?? []).map((r) => asSchoolCalendarDay(r as Record<string, unknown>)),
    notice: '',
  }
}

/** 校历：给行政管理那一页用（一段日期，含备注与改动人） */
export async function loadSchoolCalendar(
  fromIso: string,
  toIso: string,
): Promise<{ state: DailyTables; days: SchoolCalendarDay[]; notice: string }> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    return {
      state,
      days: local().calendar.filter((d) => d.onDate >= fromIso && d.onDate <= toIso),
      notice: '',
    }
  }
  if (state !== 'present') return { state, days: [], notice: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { state: 'local', days: [], notice: '' }
  const { data, error } = await sb.from('school_calendar').select('*')
    .gte('on_date', fromIso).lte('on_date', toIso).order('on_date')
  if (error) return { state: 'unknown', days: [], notice: '这一次没读出来。' }
  return { state, days: (data ?? []).map((r) => asSchoolCalendarDay(r as Record<string, unknown>)), notice: '' }
}

/* ---------------- 写：每日作业 ---------------- */

export type DailyResult = { ok: true } | { ok: false; message: string }
export type DailyRowResult = { ok: true; row: DailyHomework } | { ok: false; message: string }

export type HomeworkInput = {
  classId: string
  onDate: string
  subject: string
  subjectCode?: string
  content: string
  authorId?: string | null
  authorName?: string
}

/** 加一条每日作业（老师那条路**直接写表**：能不能写由 §40.6 的 RLS 判） */
export async function addDailyHomework(input: HomeworkInput): Promise<DailyRowResult> {
  const content = input.content.trim()
  if (!content) return { ok: false, message: '内容还没写。' }
  const subject = input.subject.trim()
  if (!subject) return { ok: false, message: '先选一科。' }
  if (content.length > 500) return { ok: false, message: '一条最多 500 字。' }

  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    localSeq += 1
    const row: DailyHomework = {
      id: `dh-local-${Date.now()}-${localSeq}`,
      classId: input.classId,
      onDate: input.onDate,
      subject,
      subjectCode: input.subjectCode,
      content,
      seq: l.homework.filter((h) => h.classId === input.classId && h.onDate === input.onDate && h.subject === subject).length + 1,
      source: 'teacher',
      authorName: input.authorName ?? '',
      createdAt: Date.now(),
    }
    l.homework.push(row)
    return { ok: true, row }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { data, error } = await sb
    .from('daily_homework')
    .insert({
      class_id: input.classId,
      on_date: input.onDate,
      subject,
      subject_code: input.subjectCode ?? null,
      content,
      author_id: input.authorId ?? null,
      author_name: input.authorName ?? '',
    })
    .select('*')
  if (error) return { ok: false, message: writeMessage(error) }
  const row = (data ?? [])[0]
  if (!row) return { ok: false, message: '写进去了，但没读回来（刷新一下看看）。' }
  return { ok: true, row: asDailyHomework(row as Record<string, unknown>) }
}

/** 改一条（改的仍是**行里那一科** —— 判据在 RLS，这里不重复判） */
export async function updateDailyHomework(id: string, patch: { content?: string; subject?: string; subjectCode?: string }): Promise<DailyResult> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    const i = l.homework.findIndex((h) => h.id === id)
    if (i < 0) return { ok: false, message: '这一条不在了。' }
    const cur = l.homework[i]
    l.homework[i] = {
      ...cur,
      content: patch.content !== undefined ? patch.content.trim() : cur.content,
      subject: patch.subject !== undefined ? patch.subject : cur.subject,
      subjectCode: patch.subjectCode !== undefined ? patch.subjectCode : cur.subjectCode,
    }
    return { ok: true }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.content !== undefined) row.content = patch.content.trim()
  if (patch.subject !== undefined) row.subject = patch.subject
  if (patch.subjectCode !== undefined) row.subject_code = patch.subjectCode
  const { error } = await sb.from('daily_homework').update(row).eq('id', id)
  if (error) return { ok: false, message: writeMessage(error) }
  return { ok: true }
}

export async function deleteDailyHomework(id: string): Promise<DailyResult> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    l.homework = l.homework.filter((h) => h.id !== id)
    return { ok: true }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { error } = await sb.from('daily_homework').delete().eq('id', id)
  if (error) return { ok: false, message: writeMessage(error) }
  return { ok: true }
}

/**
 * 我能不能写「这个班的这一科」—— **问数据库**（`can_write_daily_homework`）。
 * 返回 `null` = 这一次没问出来（页面按"不摆写入口"处理，与入口那一套口径一致）。
 */
export async function canWriteDailyHomework(
  classId: string,
  subject: string,
  subjectCode?: string,
): Promise<boolean | null> {
  const state = await ensureDailyTables()
  if (state === 'local') return true
  if (state !== 'present') return null
  const sb = getSupabase()
  if (!sb) return true
  try {
    const { data, error } = await sb.rpc('can_write_daily_homework' as never, {
      p_class_id: classId,
      p_subject_code: subjectCode ?? null,
      p_subject: subject,
    } as never)
    if (error) return null
    return data === true
  } catch {
    return null
  }
}

/* ---------------- 写：值日生 ---------------- */

export type DutyWriteInput = {
  classId: string
  onDate: string
  studentId: string
  authorId?: string | null
  authorName?: string
}

/**
 * 指定某一天的值日生（**一天的一个人**，不是一整年）。
 * 这一天从此成为**锚点**：之后按学号往下轮由 `lib/duty.ts` 推。
 * ⚠️ 库里 `unique (class_id, on_date)` ⇒ 写的是 upsert，不是"再插一条"。
 */
export async function setDutyAssignment(input: DutyWriteInput): Promise<DailyResult> {
  if (!input.studentId) return { ok: false, message: '先选一位同学。' }
  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    l.anchors = l.anchors.filter((a) => a.onDate !== input.onDate)
    l.anchors.push({ onDate: input.onDate, studentId: input.studentId })
    return { ok: true }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { error } = await sb.from('duty_assignments').upsert(
    {
      class_id: input.classId,
      on_date: input.onDate,
      student_id: input.studentId,
      source: 'set',
      author_id: input.authorId ?? null,
      author_name: input.authorName ?? '',
    },
    { onConflict: 'class_id,on_date' },
  )
  if (error) return { ok: false, message: writeMessage(error) }
  return { ok: true }
}

/* ---------------- 写：校历覆盖 ---------------- */

export async function setSchoolCalendarDay(input: {
  onDate: string
  kind: 'school' | 'off'
  note?: string
  authorId?: string | null
  authorName?: string
}): Promise<DailyResult> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    const l = local()
    l.calendar = l.calendar.filter((d) => d.onDate !== input.onDate)
    l.calendar.push({
      onDate: input.onDate,
      kind: input.kind,
      note: input.note ?? '',
      updatedByName: input.authorName ?? '',
      updatedAt: Date.now(),
    })
    return { ok: true }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { error } = await sb.from('school_calendar').upsert(
    {
      on_date: input.onDate,
      kind: input.kind,
      note: input.note ?? '',
      updated_by: input.authorId ?? null,
      updated_by_name: input.authorName ?? '',
    },
    { onConflict: 'on_date' },
  )
  if (error) return { ok: false, message: writeMessage(error) }
  return { ok: true }
}

/** 把某一天恢复成"按官方安排"（删掉覆盖行；**不是**写一条放假） */
export async function clearSchoolCalendarDay(onDate: string): Promise<DailyResult> {
  const state = await ensureDailyTables()
  if (state === 'local') {
    local().calendar = local().calendar.filter((d) => d.onDate !== onDate)
    return { ok: true }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { error } = await sb.from('school_calendar').delete().eq('on_date', onDate)
  if (error) return { ok: false, message: writeMessage(error) }
  return { ok: true }
}

/* ---------------- 课代表口令（两个安全定义函数） ---------------- */

/** 班主任（或管得着这个班的人）设 / 换口令。**口令明文只在这一个调用里出现** */
export async function setClassRepPin(classId: string, pin: string): Promise<DailyResult> {
  const state = await ensureDailyTables()
  if (state === 'local') return { ok: true }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { data, error } = await sb.rpc('set_class_rep_pin' as never, {
    p_class_id: classId,
    p_pin: pin,
  } as never)
  if (error) return { ok: false, message: writeMessage(error) }
  return rpcResult(data, {
    forbidden: '只有管得着这个班的老师（班主任 / 教务处）能设口令。',
    length: '口令要 4–12 位。',
  })
}

export type RepHomeworkInput = {
  classId: string
  subject: string
  subjectCode?: string
  content: string
  pin: string
}

/**
 * 课代表在教室端录一条（**只有今天**，只能写口令对应的那个班）。
 * 🔴 这条路走的是 `security definer` 函数：RLS 策略读不到调用者手里的口令，
 *    所以校验只能在数据库里做（这里只把 `reason` 翻成人话）。
 */
export async function repSetDailyHomework(input: RepHomeworkInput): Promise<DailyRowResult> {
  const content = input.content.trim()
  if (!content) return { ok: false, message: '内容还没写。' }
  const state = await ensureDailyTables()
  if (state === 'local') {
    const row: DailyHomework = {
      id: `dh-rep-${Date.now()}`,
      classId: input.classId,
      onDate: ymdOf(beijingNow()),
      subject: input.subject,
      subjectCode: input.subjectCode,
      content,
      seq: 99,
      source: 'rep',
      authorName: '课代表',
      createdAt: Date.now(),
    }
    local().homework.push(row)
    return { ok: true, row }
  }
  if (state !== 'present') return { ok: false, message: dailyNotice(state) }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: '没有连上数据库。' }
  const { data, error } = await sb.rpc('rep_set_daily_homework' as never, {
    p_class_id: input.classId,
    p_subject: input.subject,
    p_subject_code: input.subjectCode ?? null,
    p_content: content,
    p_pin: input.pin,
  } as never)
  if (error) return { ok: false, message: writeMessage(error) }
  const verdict = rpcResult(data, {
    'no-subject': '先选一科。',
    empty: '内容还没写。',
    'too-long': '一条最多 500 字。',
    forbidden: '这台机器不是这个班的教室端，写不了。',
    'no-pin': '这个班还没设课代表口令，让班主任先设一个。',
    'bad-pin': '口令不对。',
  })
  if (!verdict.ok) return verdict
  const body = (data ?? {}) as { id?: string; on_date?: string }
  return {
    ok: true,
    row: {
      id: String(body.id ?? ''),
      classId: input.classId,
      onDate: String(body.on_date ?? ymdOf(beijingNow())).slice(0, 10),
      subject: input.subject,
      subjectCode: input.subjectCode,
      content,
      seq: 99,
      source: 'rep',
      authorName: '课代表',
      createdAt: Date.now(),
    },
  }
}

/* ---------------- 小工具 ---------------- */

/** 把 RPC 回的那张 `{ok, reason}` 表翻成人话 */
function rpcResult(data: unknown, reasons: Record<string, string>): DailyResult {
  const body = (data ?? {}) as { ok?: boolean; reason?: string }
  if (body.ok === true) return { ok: true }
  const reason = String(body.reason ?? '')
  return { ok: false, message: reasons[reason] ?? '没写进去（没说明原因）。' }
}

/** 写失败时的统一人话：权限那一条单独说清（老师最常撞的就是它） */
function writeMessage(error: unknown): string {
  const e = error as { code?: string; message?: string }
  const code = String(e?.code ?? '')
  const msg = String(e?.message ?? '')
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return '这一条不该由你写（不是你在教的那一科？）。'
  }
  if (code === '42P01' || MISSING_TABLE_RE.test(msg)) {
    return '这个功能还没开通。'
  }
  return msg || '没写进去。'
}

/**
 * 组装 `lib/duty.ts` 要的输入（两个页面共用，免得各拼一遍）。
 * `since` 传**建班日**：没有锚点的时候从那天第一个人开始轮（见 `lib/duty.ts` 顶部说明）。
 */
export function toDutyInput(input: {
  students: readonly Student[]
  anchors: readonly DutyAnchor[]
  calendar: readonly CalendarOverride[]
  classCreatedAt: number
}): DutyInput {
  return {
    students: input.students,
    anchors: input.anchors,
    overrides: input.calendar,
    since: ymdOf(beijingNow(new Date(input.classCreatedAt))),
  }
}

/** 今天的值日生（教室端那一行 + 课间浮标） */
export function todayDuty(input: DutyInput): DutyResult | null {
  return dutyToday(input)
}

/** 未来 `days` 天里**上课日**的值日生（教师端预览 / 导出图片） */
export function dutyPreview(fromIso: string, days: number, input: DutyInput): DutyResult[] {
  return dutyRoster(fromIso, days, input)
}

/** 某一天的值日生（档案区按日期翻页时用；休息日返回 `null`） */
export function dutyOn(iso: string, input: DutyInput): DutyResult | null {
  return dutyForDate(iso, input)
}
