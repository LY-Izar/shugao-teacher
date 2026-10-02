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
import { downloadBlob } from '../lib/docxWrite'
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

  const lastDay = lastDayOfMonth(anchor)

  useEffect(() => {
    let alive = true
    void loadSchoolCalendar(anchor, lastDay).then((r) => {
      if (!alive) return
      setOverrides(r.days)
      setProbe(r.state)
      setNotice(r.notice)
    })
    return () => {
      alive = false
    }
  }, [anchor, lastDay, tick])

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
    const lines: string[][] = [['日期', '星期', '是否上课', '这一天是什么', '说明']]
    const map = new Map(r.days.map((d) => [d.onDate, d]))
    for (let iso = from; iso <= to; iso = addDays(iso, 1)) {
      const c = cellOf(iso, map.get(iso) ?? null)
      lines.push([
        iso,
        `周${WEEK[(weekdayOfISO(iso) + 6) % 7]}`,
        c.school ? '上课' : '放假',
        c.label,
        c.over?.note ?? '',
      ])
    }
    const csv = lines.map((row) => row.map(csvCell).join(',')).join('\r\n')
    downloadBlob(
      new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
      `校历-${from}-至-${to}.csv`,
    )
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
              改动只有教务处能做（数据库说了算）；导出的表格能直接拿去做校历通知。
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
              学校自己改的日子要等数据库里 §40 那张 `school_calendar` 表跑起来才能录
              —— 在那之前，这一页只看不改。
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
            改了就按你定的算 —— 教室端那句「今天放假」、以及值日生按学号往下轮，
            <b>都读这一条</b>。
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
        </Sheet>
      </Page>
    </>
  )
}
