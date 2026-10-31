import { getSupabase, isRemote } from './supabase'

/**
 * 校历事件（活动 / 考试）—— `school_calendar_events`（schema.sql §40.3b）。
 *
 * 🔴 与 `school_calendar` 分工（用户 2026-10-24 的口径）：
 *   · `school_calendar`：那一天**上不上课**（一天一行，主键是日期）；
 *   · 这张表：那一天**还有什么事**（校庆 / 运动会 / 期中考试…），一天可以好几件。
 *   ⚠️ 事件**不改**上不上课；要让某天不上课，仍去写 `school_calendar.kind = 'off'`。
 *
 * ⚠️ 建表段（§40.3b）可能还没在线上库跑过 ⇒ 所有读口都要能回 `state: 'missing'`，
 *    调用方据此显示"库里还没有这张表"，**而不是显示"没有活动"**（两件事，别装成一件）。
 */

export type CalendarEventKind = 'activity' | 'exam' | 'other'

export const EVENT_KIND_TEXT: Record<CalendarEventKind, string> = {
  activity: '活动',
  exam: '大型考试',
  other: '其他',
}

export type CalendarEvent = {
  id: string
  onDate: string
  kind: CalendarEventKind
  title: string
  atText: string
  note: string
}

export type EventsState = 'present' | 'missing' | 'local' | 'unreachable'

function asEvent(raw: Record<string, unknown>): CalendarEvent {
  const k = raw.kind
  return {
    id: String(raw.id ?? ''),
    onDate: String(raw.on_date ?? ''),
    kind: k === 'exam' ? 'exam' : k === 'activity' ? 'activity' : 'other',
    title: String(raw.title ?? ''),
    atText: String(raw.at_text ?? ''),
    note: String(raw.note ?? ''),
  }
}

/** 表不在（还没跑 §40.3b）与"网络不通"要分开 —— 前者是"去跑 SQL"，后者是"过会儿再看" */
function classify(err: { code?: string; message?: string } | null): EventsState {
  const s = `${err?.code ?? ''} ${err?.message ?? ''}`
  if (/42P01|PGRST205|does not exist|schema cache/i.test(s)) return 'missing'
  return 'unreachable'
}

export async function loadCalendarEvents(
  fromIso: string,
  toIso: string,
): Promise<{ state: EventsState; rows: CalendarEvent[]; notice: string }> {
  if (!isRemote) {
    return { state: 'local', rows: [], notice: '本地演示模式没有校历库：活动与考试要在线上录。' }
  }
  const sb = getSupabase()
  if (!sb) return { state: 'unreachable', rows: [], notice: '连不上服务器。' }
  const { data, error } = await sb
    .from('school_calendar_events')
    .select('*')
    .gte('on_date', fromIso)
    .lte('on_date', toIso)
    .order('on_date', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    const state = classify(error)
    return {
      state,
      rows: [],
      notice:
        state === 'missing'
          ? '库里还没有校历事件这张表 —— 先把 supabase/schema.sql §40.3b 跑一次。'
          : `读不到校历事件：${error.message}`,
    }
  }
  return { state: 'present', rows: (data ?? []).map((r) => asEvent(r as Record<string, unknown>)), notice: '' }
}

export type WriteResult = { ok: true } | { ok: false; why: string }

export async function addCalendarEvent(input: {
  onDate: string
  kind: CalendarEventKind
  title: string
  atText?: string
  note?: string
  authorId?: string | null
  authorName?: string
}): Promise<WriteResult> {
  if (!isRemote) return { ok: false, why: '本地演示模式改不了校历：这条要连上服务器。' }
  const title = input.title.trim()
  if (!title) return { ok: false, why: '写一句这是什么（比如：期中考试 / 校庆）' }
  if (title.length > 60) return { ok: false, why: '这一句太长了，60 字以内' }
  const sb = getSupabase()
  if (!sb) return { ok: false, why: '连不上服务器。' }
  const { error } = await sb.from('school_calendar_events').insert({
    on_date: input.onDate,
    kind: input.kind,
    title,
    at_text: (input.atText ?? '').trim().slice(0, 30),
    note: (input.note ?? '').trim().slice(0, 200),
    updated_by: input.authorId ?? null,
    updated_by_name: input.authorName ?? '',
  })
  if (error) {
    const state = classify(error)
    return {
      ok: false,
      why: state === 'missing' ? '库里还没有校历事件这张表 —— 先跑 schema.sql §40.3b' : `没存上：${error.message}`,
    }
  }
  return { ok: true }
}

export async function removeCalendarEvent(id: string): Promise<WriteResult> {
  if (!isRemote) return { ok: false, why: '本地演示模式改不了校历：这条要连上服务器。' }
  const sb = getSupabase()
  if (!sb) return { ok: false, why: '连不上服务器。' }
  const { error } = await sb.from('school_calendar_events').delete().eq('id', id)
  if (error) return { ok: false, why: `没删掉：${error.message}` }
  return { ok: true }
}
