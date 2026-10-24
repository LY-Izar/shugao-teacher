/**
 * 两个 P2 收尾插件的**内置副本**视图（React）。
 *
 * ============================================================================
 * 为什么单独一个 `.tsx`
 * ============================================================================
 * 教室端跑的是**内置副本**（真下载 `downloadPlugin` 落地前，屏上看到的就是这一份），
 * 而 `demoPlugin.ts` 是登记表与装载（纯逻辑、`.ts` 放不了 JSX）。视图按本目录既有
 * 惯例放在 `blocks/` 下，与 `FilesBlock.tsx` / `BackupBlock.tsx` 同一个位置。
 *
 * ============================================================================
 * 与三件套的关系（`app/plugins/shugao.review/` · `app/plugins/shugao.schedule/`）
 * ============================================================================
 * **逐行为同源**。差别只在渲染层 —— 这里直接复用旧页的真组件
 * （`components/PipPanel.tsx`），三件套里是等价的单文件原生 DOM 回填
 * （插件不许 import 宿主模块，手册 §11.3）。「存成图片」2026-10-25 挪去每日作业
 * （`demoPlugin.ts` 的 `dailyModule` / `plugins/shugao.daily/`），讲评不再出图。
 * 🔴 改行为时两处一起改：这里改完，`plugins/<id>/index.js` 那份也要跟，反之亦然。
 */

import { useEffect, useState } from 'react'
import { PipPanel } from '../../components/PipPanel'
import { BAND_META, type Band } from '../../lib/grading'

/* ============================================================================
   ① 作业讲评
   ============================================================================ */

type ReviewQuestion = {
  seq: number
  wrongCount: number
  rate: number
  band: Band
  bandLabel: string
  bandColor: string
  wrongNos: string[]
}
type ReviewRow = {
  id: string
  title: string
  subject: string
  assignDate: string
  total: number
  submitted: number
  missing: number
  questions: ReviewQuestion[]
}

export type ReviewCtx = {
  ui: { container: HTMLElement; toast(text: string): void }
  class: { id: string; name: string }
  data: {
    read(resource: string): Promise<Record<string, unknown>>
    watch(resource: string, cb: () => void): () => void
  }
  pip?: { open(opts: Record<string, unknown>): Promise<boolean>; close(): void }
  now(): Date
  onDispose(fn: () => void): void
}

const PIP_MISSING = '这台机器上开不了置顶小窗。讲评时请用手机或平板看题号与正确率。'
const PIP_FAILED = '置顶小窗要教室版程序才能开。讲评时看屏上这一份，或者用手机和平板。'

export function ReviewBlock({ ctx }: { ctx: ReviewCtx }) {
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [roster, setRoster] = useState<Array<{ no: string; name: string }>>([])
  const [idx, setIdx] = useState(0)
  const [seq, setSeq] = useState(1)
  const [pipOn, setPipOn] = useState(false)
  const [pipNote, setPipNote] = useState('')

  const row = rows[idx] ?? rows[0] ?? null
  const questions = row?.questions ?? []
  const cur = questions[seq - 1] ?? null
  const nameOf = (no: string) => roster.find((s) => s.no === no)?.name ?? ''

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [graded, people] = await Promise.all([
        ctx.data.read('class.gradedHomework') as Promise<{ rows?: ReviewRow[] }>,
        ctx.data.read('class.roster') as Promise<{ students?: Array<{ no: string; name: string }> }>,
      ])
      if (!alive) return
      setRows(graded.rows ?? [])
      setRoster(people.students ?? [])
    }
    void load()
    const a = ctx.data.watch('class.gradedHomework', () => void load())
    const b = ctx.data.watch('class.roster', () => void load())
    return () => {
      alive = false
      a()
      b()
    }
  }, [ctx])

  /*
   * 置顶小窗：与三件套同一口径 —— 挂上就试一次（手册 §9 的镜像式），两种失败都要说人话：
   * 网页预览下 `ctx.pip` 根本不存在；壳里没开成则说"要教室版程序"。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      if (!ctx.pip) {
        if (alive) setPipNote(PIP_MISSING)
        return
      }
      const ok = await ctx.pip.open({ w: 360, h: 220, opacity: 1 })
      if (!alive) return
      setPipOn(ok)
      setPipNote(ok ? '' : PIP_FAILED)
    })()
    return () => {
      alive = false
    }
  }, [ctx])

  const go = (n: number) => setSeq(Math.min(Math.max(1, n), Math.max(1, questions.length)))

  const togglePip = async () => {
    if (pipOn && ctx.pip) {
      ctx.pip.close()
      setPipOn(false)
      setPipNote('')
      return
    }
    if (!ctx.pip) {
      setPipNote(PIP_MISSING)
      return
    }
    const ok = await ctx.pip.open({ w: 360, h: 220, opacity: 1 })
    setPipOn(ok)
    setPipNote(ok ? '' : PIP_FAILED)
  }

  if (!row) {
    return (
      <div style={{ padding: '12px 14px', fontFamily: 'system-ui', color: 'var(--color-ink)' }}>
        <div style={{ fontSize: 16, fontWeight: 620 }}>本班还没有已批改的作业</div>
        <div style={{ marginTop: 4, fontSize: 14, color: 'var(--color-ink4)' }}>极简模式的档案没有逐题正确率。</div>
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: '12px 14px',
        overflow: 'auto',
        scrollbarWidth: 'thin',
        fontFamily: 'system-ui',
        color: 'var(--color-ink)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 17 }}>作业讲评</span>
        <span style={{ fontSize: 15, color: row.missing ? 'var(--color-bad)' : 'var(--color-ink3)' }}>
          应交 {row.total} · 已交 {row.submitted} · 未交 {row.missing}
        </span>
        <span style={{ flex: 1 }} />
        <select
          className="input"
          style={{ width: 'auto', height: 38, fontSize: 15 }}
          value={row.id}
          onChange={(e) => {
            setIdx(Math.max(0, rows.findIndex((r) => r.id === e.target.value)))
            setSeq(1)
          }}
        >
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void togglePip()}
          style={{
            height: 38,
            padding: '0 14px',
            fontSize: 15,
            fontFamily: 'inherit',
            fontWeight: 600,
            cursor: 'pointer',
            borderRadius: 'var(--radius-sm)',
            border: `1px solid ${pipOn ? 'var(--color-accent)' : 'var(--color-line2)'}`,
            background: pipOn ? 'var(--color-accentsoft)' : 'var(--color-surface)',
            color: pipOn ? 'var(--color-accentink)' : 'var(--color-ink2)',
          }}
        >
          {pipOn ? '小窗已开启' : '启动置顶小窗'}
        </button>
      </div>

      {pipNote ? <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-warn)' }}>{pipNote}</div> : null}

      {/* 小窗同款面板：不支持置顶小窗时，这就是兜底（与旧页同一个组件、同一份数据） */}
      {cur ? (
        <div
          style={{
            padding: '10px 12px',
            border: '1px solid var(--color-line2)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 15.5 }}>当前题目</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>{pipOn ? '与小窗同步' : ''}</span>
          </div>
          <PipPanel
            key={seq}
            tone="inline"
            seq={seq}
            total={questions.length}
            rate={cur.rate}
            band={cur.band}
            wrongNos={cur.wrongNos}
            nameOf={nameOf}
            all={questions}
            onPick={setSeq}
            onPrev={() => go(seq - 1)}
            onNext={() => go(seq + 1)}
          />
        </div>
      ) : null}

      {/* 逐题正确率：点一行切题 */}
      <div
        style={{
          border: '1px solid var(--color-line2)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--color-line2)',
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15.5 }}>逐题正确率 · 点一行切换小窗</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>共 {questions.length} 题</span>
        </div>
        <div>
          {questions.map((q) => {
            const meta = BAND_META[q.band]
            const on = q.seq === seq
            return (
              <button
                key={q.seq}
                type="button"
                onClick={() => setSeq(q.seq)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 12px',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                  border: 0,
                  borderLeft: `3px solid ${on ? 'var(--color-accent)' : 'transparent'}`,
                  background: on ? 'var(--color-accentsoft)' : 'transparent',
                }}
              >
                <span
                  className="num"
                  style={{
                    flex: 'none',
                    width: 34,
                    height: 34,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 16,
                    fontWeight: 700,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--color-surface)',
                  }}
                >
                  {q.seq}
                </span>
                <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                    <span
                      className="num"
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        minWidth: 66,
                        color: q.wrongCount ? meta.color : 'var(--color-ink4)',
                      }}
                    >
                      {Math.round(q.rate * 100)}%
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--color-ink3)' }}>{q.wrongCount} 人错</span>
                    <span style={{ flex: 1 }} />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 700,
                        padding: '1px 8px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--color-surface2)',
                        color: q.wrongCount ? meta.color : 'var(--color-ok)',
                      }}
                    >
                      {q.wrongCount ? q.bandLabel : '全对'}
                    </span>
                  </span>
                  <span
                    style={{
                      display: 'block',
                      height: 6,
                      borderRadius: 3,
                      overflow: 'hidden',
                      background: 'var(--color-surface3)',
                    }}
                  >
                    <i
                      style={{
                        display: 'block',
                        height: '100%',
                        width: `${Math.max(2, Math.round(q.rate * 100))}%`,
                        background: meta.color,
                      }}
                    />
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ============================================================================
   ② 班级课表（**只读显示**）
   ----------------------------------------------------------------------------
   2026-10-24 用户拍板（第二次改口）：**课表不由教室端录入** —— 录入在教师端
   「班级管理 → 本班课表」那一块（早就有了），教室屏只负责显示。
   所以这里没有任何写入口：清单里只有 `data.schedule` + `clock`，没有 `writes`，
   也不碰 `ctx.write`。判据全在宿主：`class.schedule` 给本班每一节（weekday/start/
   end/subject/teacherName），`class.slotNow` 给「当前这一节 / 下一节」。
   ============================================================================ */

type ScheduleRow = {
  weekday: number
  start: string
  end: string
  subject: string
  subjectCode: string
  teacherName: string
}
type SlotInfo = { subject: string; start: string; end: string }

export type ScheduleCtx = {
  ui: { container: HTMLElement }
  class: { id: string; name: string }
  data: {
    read(resource: string): Promise<Record<string, unknown>>
    watch(resource: string, cb: () => void): () => void
  }
  clock?: { onMinute(cb: () => void): () => void }
  now(): Date
  onDispose(fn: () => void): void
}

const WD_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
/** 1 = 周一…7 = 周日，与 `ScheduleItem.weekday` 同一口径；`getDay()` 的 0 = 周日只在这一处换算 */
const weekdayOfDay = (d: Date) => d.getDay() || 7

export function ScheduleBlock({ ctx }: { ctx: ScheduleCtx }) {
  const [items, setItems] = useState<ScheduleRow[]>([])
  const [slot, setSlot] = useState<{ current: SlotInfo | null; next: SlotInfo | null }>({
    current: null,
    next: null,
  })

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [sched, nowSlot] = await Promise.all([
        ctx.data.read('class.schedule') as Promise<{ items?: ScheduleRow[] }>,
        ctx.data.read('class.slotNow') as Promise<{ current?: SlotInfo | null; next?: SlotInfo | null }>,
      ])
      if (!alive) return
      setItems(sched.items ?? [])
      setSlot({ current: nowSlot.current ?? null, next: nowSlot.next ?? null })
    }
    void load()
    const a = ctx.data.watch('class.schedule', () => void load())
    const b = ctx.data.watch('class.slotNow', () => void load())
    /* 整分钟重画：当前/下一节是按分钟翻的（与旧页 `dayState` 同一口径） */
    const c = ctx.clock ? ctx.clock.onMinute(() => void load()) : () => {}
    return () => {
      alive = false
      a()
      b()
      c()
    }
  }, [ctx])

  const now = ctx.now()
  const wd = weekdayOfDay(now)
  /* 今天那几节：只按宿主给的 `weekday` 筛，按开始时间排（HH:MM 字符串序即时间序） */
  const today = items
    .filter((it) => Number(it.weekday) === wd && Boolean(it.start))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const cur = slot.current
  const next = slot.next
  /* `slotNow` 的 Slot 不带老师 —— 老师那一截从同校次的课表行上取 */
  const curItem = cur ? (today.find((it) => it.start === cur.start) ?? null) : null
  const nextItem = next ? (today.find((it) => it.start === next.start) ?? null) : null
  const teacherOf = (it: ScheduleRow | null) => (it && it.teacherName ? ` ${it.teacherName}` : '')
  const line = cur
    ? `正在上 · ${cur.subject}${teacherOf(curItem)} · 到 ${cur.end}`
    : next
      ? `下一节 · ${next.subject}${teacherOf(nextItem)} · ${next.start} 开始`
      : ''

  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: '12px 14px',
        overflow: 'auto',
        scrollbarWidth: 'thin',
        fontFamily: 'system-ui',
        color: 'var(--color-ink)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 17 }}>本班课表</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
          {`${WD_TEXT[wd - 1]} · ${now.getMonth() + 1} 月 ${now.getDate()} 日`}
        </span>
      </div>

      {/* 当前 / 下一节：`slotNow` 是宿主算的，这里只负责摆上屏 */}
      {line ? (
        <div
          style={{
            padding: '9px 11px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-accentsoft)',
            border: '1px solid var(--color-accent)',
            color: 'var(--color-accentink)',
            fontSize: 15,
            lineHeight: 1.7,
          }}
        >
          {line}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {today.map((it) => {
          const on = Boolean(cur && cur.start === it.start)
          return (
            <div
              key={`${it.weekday}-${it.start}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                padding: '7px 10px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
              }}
            >
              {/* 时间在前（旧页与课程管理同一口径） */}
              <span
                className="num"
                style={{
                  flex: 'none',
                  fontSize: 14,
                  color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                }}
              >
                {it.start}–{it.end}
              </span>
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  fontSize: 16,
                  fontWeight: 650,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.subject}
              </span>
              <span style={{ flex: 'none', fontSize: 13, color: 'var(--color-ink3)' }}>{it.teacherName}</span>
              {on ? (
                <span
                  style={{
                    flex: 'none',
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '1px 7px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--color-accent)',
                    color: 'var(--color-onaccent)',
                  }}
                >
                  正在上
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
      {today.length ? null : (
        <div style={{ fontSize: 15, color: 'var(--color-ink3)', lineHeight: 1.8 }}>今天没课。</div>
      )}
    </div>
  )
}
