import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconRefresh,
} from '../components/icons'
import { Button, PageHead, Panel, Sheet } from '../components/ui'
import { useStore, useToast } from '../data/store'
import {
  clearSchoolCalendarDay,
  loadSchoolCalendar,
  setSchoolCalendarDay,
  type DailyTables,
} from '../lib/daily'
import type { SchoolCalendarDay } from '../data/types'
import {
  EVENT_KIND_TEXT,
  addCalendarEvent,
  loadCalendarEvents,
  removeCalendarEvent,
  type CalendarEvent,
  type CalendarEventKind,
  type EventsState,
} from '../lib/calendarEvents'
import { saveBlob } from '../lib/fileOut'
import { addDays, beijingNow, dayKind, holidayOn, weekdayOfISO, ymdOf } from '../lib/holiday'
import type { DayKind } from '../lib/holiday'

/* ============================================================
   「校历」`/manage/calendar`（2026-10-XX，教室端改造那一轮）
   ------------------------------------------------------------
   它管的是**两层**：

     ① **官方那一层**（`data/holidays.ts` + `lib/holiday.ts`）——
        法定节假日与调休上班，按国务院的通知编在数据文件里，**这一页改不了它**；
     ② **学校自己那一层**（`school_calendar` 表，`supabase/schema.sql` §40）——
        一条覆盖行 = 这一天是"上课"还是"放假"（校庆、期中考试、临时补课、运动会…），
        没有覆盖行就照官方那一层走。

   🔴 **为什么两层分开**：官方安排每年一份、全校一样；学校自己改的日子是**这一校的
      临时决定**，明年会变、下一份通知来了要对账。混成一层的话，官方通知一更新，
      学校自己录的那些也跟着变成"看不出来是谁改的"。

   🔴 **谁能改**：由数据库的 `school_calendar_write`（`is_school_admin()`）判 —— 这一页
      **不读身份槽位**、不自己写角色数组（口径：权限判据一律以数据库为准）。
      改不动的时候，数据库的话会原样贴出来。

   ⚠️ 值日生轮值 / 教室端"今天放假"读的是**同一份**：`lib/duty.ts` 的 `isSchoolDay()`
      就是拿这里的覆盖行 + 官方那一层算的 —— 所以这一页录错一天，教室端那块屏会跟着错。
   ============================================================ */

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

type Kind = 'school' | 'off'

type Cell = {
  iso: string
  /** 这一天算不算上课日 */
  school: boolean
  /** 屏上那行小字 */
  label: string
  /** 「学校自己改的」那一行（没有就是 `null`） */
  over: SchoolCalendarDay | null
  /** 官方那一层给的性质 */
  base: DayKind
}

const pad = (n: number) => String(n).padStart(2, '0')

function monthStartOf(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

function shiftMonth(iso: string, n: number): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${pad(mm + 1)}-01`
}

function lastDayOfMonth(iso: string): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  return `${iso.slice(0, 7)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
}

/** 这一天的结论：**学校那一层压官方那一层** */
function cellOf(iso: string, over: SchoolCalendarDay | null): Cell {
  if (over) {
    return over.kind === 'school'
      ? { iso, school: true, label: '学校定：上课', over, base: dayKind(iso) }
      : { iso, school: false, label: '学校定：放假', over, base: dayKind(iso) }
  }
  const base = dayKind(iso)
  if (base === 'holiday') return { iso, school: false, label: holidayOn(iso)?.name ?? '法定放假', over: null, base }
  if (base === 'makeup') return { iso, school: true, label: '调休上班', over: null, base }
  if (base === 'weekend') return { iso, school: false, label: '周末', over: null, base }
  return { iso, school: true, label: '上课', over: null, base }
}

/** CSV 一格：有逗号/引号/换行就包起来（Excel 与 WPS 都认这一套） */
function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function SchoolCalendar() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const teacher = useStore((s) => s.teacher)

  const today = useMemo(() => ymdOf(beijingNow()), [])
  const [anchor, setAnchor] = useState(() => monthStartOf(today))
  const [overrides, setOverrides] = useState<SchoolCalendarDay[]>([])
  const [probe, setProbe] = useState<DailyTables | null>(null)
  const [notice, setNotice] = useState('')
  const [tick, setTick] = useState(0)
  const [editIso, setEditIso] = useState<string | null>(null)
  const [editKind, setEditKind] = useState<Kind>('off')
  const [editNote, setEditNote] = useState('')
  const [busy, setBusy] = useState(false)
  /* 🆕 2026-10-24：当天的活动 / 考试（`school_calendar_events`，一天可多件） */
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [evState, setEvState] = useState<EventsState>('present')
  const [evNotice, setEvNotice] = useState('')
  const [evKind, setEvKind] = useState<CalendarEventKind>('activity')
  const [evTitle, setEvTitle] = useState('')
  const [evAt, setEvAt] = useState('')

  const lastDay = lastDayOfMonth(anchor)

  useEffect(() => {
    let alive = true
    void loadSchoolCalendar(anchor, lastDay).then((r) => {
      if (!alive) return
      setOverrides(r.days)
      setProbe(r.state)
      setNotice(r.notice)
    })
    void loadCalendarEvents(anchor, lastDay).then((r) => {
      if (!alive) return
      setEvents(r.rows)
      setEvState(r.state)
      setEvNotice(r.notice)
    })
    return () => {
      alive = false
    }
  }, [anchor, lastDay, tick])

  const evByDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      const list = m.get(e.onDate) ?? []
      list.push(e)
      m.set(e.onDate, list)
    }
    return m
  }, [events])

  const overMap = useMemo(() => new Map(overrides.map((d) => [d.onDate, d])), [overrides])

  const cells: (Cell | null)[] = useMemo(() => {
    const lead = (weekdayOfISO(anchor) + 6) % 7
    const out: (Cell | null)[] = []
    for (let i = 0; i < lead; i++) out.push(null)
    for (let iso = anchor; iso <= lastDay; iso = addDays(iso, 1)) {
      out.push(cellOf(iso, overMap.get(iso) ?? null))
    }
    return out
  }, [anchor, lastDay, overMap])

  /** 本月：上课几天 / 放假几天（只数这个月，不含格子里那些空位） */
  const tally = useMemo(() => {
    let school = 0
    let rest = 0
    for (const c of cells) {
      if (!c) continue
      if (c.school) school += 1
      else rest += 1
    }
    return { school, rest }
  }, [cells])

  const openEditor = (iso: string) => {
    const over = overMap.get(iso) ?? null
    setEditKind(over ? (over.kind === 'school' ? 'school' : 'off') : (cellOf(iso, null).school ? 'off' : 'school'))
    setEditNote(over?.note ?? '')
    setEditIso(iso)
  }

  const save = async () => {
    if (!editIso) return
    setBusy(true)
    const r = await setSchoolCalendarDay({
      onDate: editIso,
      kind: editKind,
      note: editNote,
      authorId: teacher?.id ?? null,
      authorName: teacher?.name ?? '',
    })
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad' })
      return
    }
    push({
      text: '这一天已存下',
      tone: 'ok',
      desc: `${editIso} · ${editKind === 'school' ? '按上课算' : '按放假算'}`,
    })
    setEditIso(null)
    setTick((t) => t + 1)
  }

  const clear = async () => {
    if (!editIso) return
    setBusy(true)
    const r = await clearSchoolCalendarDay(editIso)
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad' })
      return
    }
    push({ text: '这一天回到了官方安排', tone: 'warn', desc: editIso })
    setEditIso(null)
    setTick((t) => t + 1)
  }

  const exportCsv = async (from: string, to: string) => {
    const r = await loadSchoolCalendar(from, to)
    /* 🆕 2026-10-24：活动 / 考试也进表（用户要"校历能编辑活动、考试"，
       导出里当然也得带上，否则印出来给老师的表就少一半信息） */
    const ev = await loadCalendarEvents(from, to)
    const evMap = new Map<string, string>()
    for (const e of ev.rows) {
      const line = `${EVENT_KIND_TEXT[e.kind]}${e.atText ? ` ${e.atText}` : ''}·${e.title}`
      evMap.set(e.onDate, evMap.has(e.onDate) ? `${evMap.get(e.onDate)}；${line}` : line)
    }
    const lines: string[][] = [
      ['日期', '星期', '是否上课', '这一天是什么', '说明', '活动 / 考试'],
    ]
    const map = new Map(r.days.map((d) => [d.onDate, d]))
    for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
      const c = cellOf(iso, map.get(iso) ?? null)
      lines.push([
        iso,
        `周${WEEK[(weekdayOfISO(iso) + 6) % 7]}`,
        c.school ? '上课' : '放假',
        c.label,
        c.over?.note ?? '',
        evMap.get(iso) ?? '',
      ])
    }
    const csv = lines.map((row) => row.map(csvCell).join(',')).join('\r\n')
    /*
     * 🔴🔴 **拿到结果再说"已导出表格"**（2026-10-04）
     *   原来这里用的是同步的 `downloadBlob(...)`（它 `void` 掉结果，签名**刻意不许改** ——
     *   见 `docxWrite.ts:240`），紧接着就无条件 `push({tone:'ok'})`
     *   ⇒ apk 上存不下去时也显示"已导出"（同一个假绿）。
     *   ✅ 改成直接 `await saveBlob`（`GradeSetup.tsx` 已是这个先例），
     *      统一出口仍是 `fileOut`，没有绕过它。
     */
    const saved = await saveBlob(
      `校历-${from}-至-${to}.csv`,
      new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
    )
    if (saved === 'failed') {
      push({ text: '表格没保存下来', tone: 'bad', desc: '这台设备存不了文件，换个方式导出。' })
      return
    }
    if (saved === 'cancelled') {
      push({ text: '已取消保存', tone: 'warn' })
      return
    }
    push({
      text: '已导出表格',
      tone: 'ok',
      desc: r.notice || '拿 Excel / WPS 打开就是一张表',
    })
  }

  const monthText = `${anchor.slice(0, 4)} 年 ${Number(anchor.slice(5, 7))} 月`
  const editing = editIso ? cellOf(editIso, overMap.get(editIso) ?? null) : null

  return (
    <>
      <PageHead
        title="校历"
        sub="法定节假日 · 调休 · 学校自己改的日子"
        onBack={() => navigate('/manage')}
      />
      <Page>
        <Panel
          head={monthText}
          extra={
            <span className="flex items-center gap-1">
              <Button size="sm" icon={<IconChevronLeft size={14} />} onClick={() => setAnchor((a) => shiftMonth(a, -1))}>
                上一月
              </Button>
              <Button size="sm" onClick={() => setAnchor(monthStartOf(today))}>
                本月
              </Button>
              <Button size="sm" onClick={() => setAnchor((a) => shiftMonth(a, 1))}>
                下一月
                <IconChevronRight size={14} />
              </Button>
            </span>
          }
        >
          {/* 这一行是"这个月怎么算的"：上课日 / 放假日的天数 + 两层各自的来源 */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            <span>
              本月 <b style={{ color: 'var(--color-ink)' }}>{tally.school}</b> 天上课 ·{' '}
              <b style={{ color: 'var(--color-ink)' }}>{tally.rest}</b> 天放假
            </span>
            <span>灰字＝官方法定安排；带「校」＝学校自己改的（可以删掉，删了就回到官方安排）</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {WEEK.map((w) => (
              <div
                key={w}
                className="text-center"
                style={{ fontSize: 11.5, color: 'var(--color-ink4)', paddingBottom: 2 }}
              >
                周{w}
              </div>
            ))}
            {cells.map((c, i) =>
              c ? (
                <button
                  key={c.iso}
                  type="button"
                  data-cal-day={c.iso}
                  data-cal-over={c.over ? c.over.kind : ''}
                  data-cal-school={c.school ? '1' : '0'}
                  onClick={() => openEditor(c.iso)}
                  style={{
                    textAlign: 'left',
                    padding: '6px 7px',
                    minHeight: 58,
                    borderRadius: 5,
                    border: `1px solid ${
                      c.iso === today
                        ? 'var(--color-accent)'
                        : c.over
                          ? 'var(--color-line3)'
                          : 'var(--color-line2)'
                    }`,
                    background: c.school ? 'var(--color-surface)' : 'var(--color-surface2)',
                  }}
                >
                  <span
                    className="flex items-center gap-1"
                    style={{ fontSize: 13, fontWeight: c.iso === today ? 700 : 600 }}
                  >
                    {Number(c.iso.slice(8, 10))}
                    {c.over ? (
                      <span style={{ fontSize: 10, color: 'var(--color-ink4)' }}>校</span>
                    ) : null}
                    {/* 🆕 有活动/考试的那天点一个点（只有这一天有事件才画，不占版面） */}
                    {evByDay.has(c.iso) ? (
                      <span
                        aria-hidden
                        data-cal-event-dot={c.iso}
                        title={(evByDay.get(c.iso) ?? []).map((e) => `${EVENT_KIND_TEXT[e.kind]}·${e.title}`).join('；')}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: 'var(--color-warn)',
                          display: 'inline-block',
                        }}
                      />
                    ) : null}
                  </span>
                  <span
                    className="block"
                    style={{
                      fontSize: 10.5,
                      lineHeight: 1.4,
                      color: c.school ? 'var(--color-ink2)' : 'var(--color-ink4)',
                    }}
                  >
                    {c.label}
                  </span>
                  {c.over?.note ? (
                    <span
                      className="block"
                      style={{ fontSize: 10, color: 'var(--color-ink4)', marginTop: 2 }}
                    >
                      {c.over.note}
                    </span>
                  ) : null}
                </button>
              ) : (
                <div key={`blank-${i}`} />
              ),
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<IconDownload size={14} />}
              onClick={() => void exportCsv(anchor, lastDay)}
            >
              导出本月表格
            </Button>
            <Button
              size="sm"
              icon={<IconDownload size={14} />}
              onClick={() => void exportCsv(`${anchor.slice(0, 4)}-01-01`, `${anchor.slice(0, 4)}-12-31`)}
            >
              导出整年
            </Button>
            <Button size="sm" icon={<IconRefresh size={14} />} onClick={() => setTick((t) => t + 1)}>
              重读一遍
            </Button>
            <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
              改动只有教务处能做；导出的表格能直接拿去做校历通知。
            </span>
          </div>

          {notice ? (
            <div className="mt-2" style={{ fontSize: 11.5, color: 'var(--color-warn)' }}>
              {notice}
            </div>
          ) : null}
          {probe === 'missing' || probe === 'unknown' ? (
            <div className="mt-2" style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              现在显示的是<b>官方那一层</b>（法定节假日 + 调休）。
              学校自己改的日子现在录不了 —— 这一页只看不改。
            </div>
          ) : null}
        </Panel>

        <Sheet
          open={!!editIso}
          onClose={() => setEditIso(null)}
          title={editIso ? `${editIso} · 周${WEEK[(weekdayOfISO(editIso) + 6) % 7]}` : '改一天'}
          footer={
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                block
                disabled={busy}
                onClick={() => void save()}
                data-cal-save="1"
              >
                存下这一天
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !editing?.over}
                onClick={() => void clear()}
                data-cal-clear="1"
              >
                回到官方安排
              </Button>
            </div>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
            官方那一层说这一天是「{editing?.over ? cellOf(editIso ?? '', null).label : editing?.label}」。
            改了就按你定的算。
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5" data-cal-kinds>
            {([
              ['off', '按放假算', '不上课（校庆 / 考试 / 放假）'],
              ['school', '按上课算', '要上课（补课 / 调休 / 拿回一天的课）'],
            ] as const).map(([k, label, hint]) => {
              const on = editKind === k
              return (
                <button
                  key={k}
                  type="button"
                  data-cal-kind={k}
                  data-on={on}
                  title={hint}
                  onClick={() => setEditKind(k)}
                  style={{
                    padding: '5px 11px',
                    borderRadius: 999,
                    fontSize: 12.5,
                    border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                    background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                    color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                    fontWeight: on ? 650 : 500,
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <input
            className="input mt-3"
            placeholder="说明（比如：校庆 · 期中考试 · 高三补课）"
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            aria-label="这一天的说明"
          />
          <div className="mt-2" style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}>
            说明是给老师看的（导出表格里也带着它）；不写也行。
          </div>

          {/* 🆕 2026-10-24：当天还有什么（活动 / 考试）。⚠️ 它**不改**上面"上不上课"那一档 */}
          <div className="mt-4" data-cal-events>
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 12.5, fontWeight: 650 }}>当天的活动 / 考试</span>
              <span className="flex-1" />
              {evState === 'missing' ? (
                <span style={{ fontSize: 11.5, color: 'var(--color-badink)' }}>库里还没有这张表</span>
              ) : null}
            </div>
            {evNotice ? (
              <div className="mt-1" style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                {evNotice}
              </div>
            ) : null}

            {(editIso ? evByDay.get(editIso) ?? [] : []).map((e) => (
              <div
                key={e.id}
                className="mt-1.5 flex items-center gap-2"
                data-cal-event={e.id}
                style={{ fontSize: 12.5 }}
              >
                <span className="tag tag-warn">{EVENT_KIND_TEXT[e.kind]}</span>
                {e.atText ? <span style={{ color: 'var(--color-ink3)' }}>{e.atText}</span> : null}
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await removeCalendarEvent(e.id)
                    if (!r.ok) {
                      push({ text: '没删掉', tone: 'bad', desc: r.why })
                      return
                    }
                    setTick((t) => t + 1)
                  }}
                  style={{ color: 'var(--color-bad)', fontSize: 11.5 }}
                >
                  删除
                </button>
              </div>
            ))}

            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-cal-event-kinds>
              {(['activity', 'exam', 'other'] as CalendarEventKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  data-cal-event-kind={k}
                  data-on={evKind === k}
                  onClick={() => setEvKind(k)}
                  style={{
                    padding: '3px 9px',
                    borderRadius: 999,
                    fontSize: 11.5,
                    border: `1px solid ${evKind === k ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                    background: evKind === k ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                    color: evKind === k ? 'var(--color-accentink)' : 'var(--color-ink2)',
                  }}
                >
                  {EVENT_KIND_TEXT[k]}
                </button>
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <input
                className="input"
                style={{ flex: '1 1 200px' }}
                placeholder="是什么（期中考试 / 校庆 / 运动会）"
                value={evTitle}
                maxLength={60}
                onChange={(e) => setEvTitle(e.target.value)}
                aria-label="活动或考试的名称"
                data-cal-event-title
              />
              <input
                className="input"
                style={{ flex: '0 1 130px' }}
                placeholder="时间（上午 8:00）"
                value={evAt}
                maxLength={30}
                onChange={(e) => setEvAt(e.target.value)}
                aria-label="时间"
                data-cal-event-at
              />
              <Button
                size="sm"
                disabled={busy || !editIso}
                onClick={async () => {
                  if (!editIso) return
                  setBusy(true)
                  const r = await addCalendarEvent({
                    onDate: editIso,
                    kind: evKind,
                    title: evTitle,
                    atText: evAt,
                    authorId: teacher?.id ?? null,
                    authorName: teacher?.name ?? '',
                  })
                  setBusy(false)
                  if (!r.ok) {
                    push({ text: '没加上', tone: 'bad', desc: r.why })
                    return
                  }
                  setEvTitle('')
                  setEvAt('')
                  setTick((t) => t + 1)
                }}
                data-cal-event-add="1"
              >
                加一条
              </Button>
            </div>
            <div className="mt-1" style={{ fontSize: 11, color: 'var(--color-ink4)', lineHeight: 1.7 }}>
              事件只是"这一天有什么事"。要让它**不上课**，上面选「按放假算」。
            </div>
          </div>
        </Sheet>
      </Page>
    </>
  )
}
