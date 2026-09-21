import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconX,
  IconZap,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { Assignment, Student } from '../data/types'
import {
  BAND_META,
  gradeStats,
  isQuestionWrong,
  isSubWrong,
  normalizeForSubCount,
  toggleQuestion,
  toggleSub,
} from '../lib/grading'
import { friendlyDate } from '../lib/date'

type Mode = 'byStudent' | 'byQuestion'

/* ============================================================
   题号按钮
   单击 = 记错 ｜ 双击（无小题时）= 直接拆出 2 个小题 ｜ 长按 = 小题设置（取消需确认）
   单击立即生效、双击时再回退 —— 高频录入不能卡在"等双击判定"上。
   ============================================================ */
function QButton({
  seq,
  subCount,
  wrong,
  onToggle,
  onSub,
  onSetSubCount,
  onSubSettings,
}: {
  seq: number
  subCount: number
  wrong: string[]
  onToggle: () => void
  onSub: (sub: number) => void
  onSetSubCount: (n: number) => void
  onSubSettings: () => void
}) {
  const lastTap = useRef(0)
  const pressTimer = useRef<number | null>(null)
  const longFired = useRef(false)
  const whole = isQuestionWrong(wrong, seq, subCount)

  const handleTap = () => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      // 双击：只在还没有小题时直接拆出两个，不再弹窗打断
      if (subCount === 0) {
        if (whole) onToggle() // 回退刚才那次单击
        onSetSubCount(2)
      }
      return
    }
    lastTap.current = now
    onToggle()
  }

  return (
    <div
      style={{
        border: `1px solid ${whole ? 'var(--color-bad)' : 'var(--color-line2)'}`,
        background: whole ? 'var(--color-badsoft)' : 'var(--color-surface)',
        borderRadius: 4,
        overflow: 'hidden',
        transition: 'background-color .14s, border-color .14s',
      }}
    >
      <button
        type="button"
        onClick={handleTap}
        onPointerDown={() => {
          longFired.current = false
          pressTimer.current = window.setTimeout(() => {
            longFired.current = true
            onSubSettings()
          }, 520)
        }}
        onPointerUp={() => {
          if (pressTimer.current) window.clearTimeout(pressTimer.current)
        }}
        onPointerLeave={() => {
          if (pressTimer.current) window.clearTimeout(pressTimer.current)
        }}
        onClickCapture={(e) => {
          if (longFired.current) {
            e.stopPropagation()
            longFired.current = false
          }
        }}
        className="num w-full"
        style={{
          height: subCount > 0 ? 28 : 38,
          fontSize: 15,
          fontWeight: 700,
          color: whole ? 'var(--color-bad)' : 'var(--color-ink)',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
        }}
        aria-label={`第 ${seq} 题`}
      >
        {seq}
      </button>

      {subCount > 0 ? (
        <div
          className="flex"
          style={{ borderTop: `1px solid ${whole ? 'var(--color-bad)' : 'var(--color-line)'}` }}
        >
          {Array.from({ length: subCount }, (_, i) => i + 1).map((sub) => {
            const on = isSubWrong(wrong, seq, sub)
            return (
              <button
                key={sub}
                type="button"
                onClick={() => onSub(sub)}
                className="num flex-1"
                style={{
                  height: 26,
                  fontSize: 12,
                  fontWeight: 700,
                  border: 0,
                  borderRight: '1px solid var(--color-line)',
                  background: on ? 'var(--color-bad)' : 'transparent',
                  color: on ? '***REMOVED***fff' : 'var(--color-ink3)',
                  cursor: 'pointer',
                }}
                aria-label={`第 ${seq} 题第 ${sub} 小题`}
              >
                {sub}
              </button>
            )
          })}
          {/* 预留的加号：直接加一个小题，不再弹窗 */}
          <button
            type="button"
            onClick={() => onSetSubCount(subCount + 1)}
            disabled={subCount >= 6}
            aria-label={`第 ${seq} 题增加小题`}
            style={{
              width: 26,
              height: 26,
              border: 0,
              background: 'transparent',
              color: 'var(--color-ink3)',
              cursor: subCount >= 6 ? 'not-allowed' : 'pointer',
              opacity: subCount >= 6 ? 0.3 : 1,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconPlus size={11} strokeWidth={2.4} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- 小题编辑器 ---------------- */

function SubEditor({
  seq,
  count,
  onClose,
  onApply,
}: {
  seq: number
  count: number
  onClose: () => void
  onApply: (n: number) => void
}) {
  const [n, setN] = useState(count > 0 ? count : 2)
  return (
    <Sheet
      open
      onClose={onClose}
      title={`第 ${seq} 题 · 小题设置`}
      footer={
        <div className="flex gap-2">
          {count > 0 ? (
            <Button block variant="danger" onClick={() => onApply(0)}>
              取消小题
            </Button>
          ) : null}
          <Button block variant="primary" onClick={() => onApply(n)}>
            完成
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          icon={<IconMinus size={15} />}
          disabled={n <= 2}
          onClick={() => setN((v) => Math.max(2, v - 1))}
        >
          减少
        </Button>
        <span
          className="num"
          style={{ fontSize: 26, fontWeight: 700, minWidth: 40, textAlign: 'center' }}
        >
          {n}
        </span>
        <Button
          size="sm"
          icon={<IconPlus size={15} />}
          disabled={n >= 6}
          onClick={() => setN((v) => Math.min(6, v + 1))}
        >
          增加
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {Array.from({ length: n }, (_, i) => (
          <span
            key={i}
            className="num grid place-items-center"
            style={{
              width: 30,
              height: 30,
              border: '1px solid var(--color-line2)',
              borderRadius: 3,
              background: 'var(--color-surface2)',
              fontSize: 12.5,
              fontWeight: 700,
            }}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 12, lineHeight: 1.65 }}>
        平时<strong>双击题号</strong>就能直接拆出 (1)(2)，题号格里的 <strong>+</strong> 可以继续加 ——
        都不需要经过这里。这个面板只在<strong>长按</strong>时打开，用来减少小题数或取消小题。
      </p>
      <p style={{ fontSize: 12, color: 'var(--color-bad)', marginTop: 8, lineHeight: 1.65 }}>
        取消小题会把这一题恢复成一个整题，已记录的小题对错会被清除。
      </p>
    </Sheet>
  )
}

/* ============================================================
   批改录入
   ============================================================ */

export default function AssignmentGrade() {
  const { id = '' } = useParams()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))

  return (
    <GradeSession
      key={id}
      id={id}
      initialWrong={assignment?.wrong ?? {}}
      initialSubs={assignment?.subQuestions ?? {}}
      initialConfirmed={assignment?.confirmedNos ?? []}
    />
  )
}

/**
 * 一次批改会话。
 * 用 key={id} 保证换档案时整块重挂载 —— 本地工作副本直接由 useState
 * 惰性初始化，不需要在 effect 里 setState，也不需要渲染期读写 ref。
 */
/**
 * 批改草稿：按档案 id 分开存，避免两份作业的进度互相覆盖。
 * 只存页面内的临时副本，不动档案本身 —— 正式提交仍然走「完成批改」。
 */
function draftKey(id: string) {
  return `shugao.grade.draft.${id}`
}

type GradeDraft = {
  wrong: Assignment['wrong']
  subs: Record<string, number>
  confirmed: string[]
  at: number
}

function loadDraft(key: string): GradeDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as GradeDraft
    if (!d || typeof d !== 'object' || !d.wrong) return null
    return d
  } catch {
    return null
  }
}

function GradeSession({
  id,
  initialWrong,
  initialSubs,
  initialConfirmed,
}: {
  id: string
  initialWrong: Assignment['wrong']
  initialSubs: Record<string, number>
  initialConfirmed: string[]
}) {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const DRAFT_KEY = draftKey(id)

  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const setGrade = useStore((s) => s.setGrade)

  const students: Student[] = useMemo(
    () =>
      (klass?.students ?? [])
        .filter((s) => s.status === 'active')
        .sort((a, b) => Number(a.studentNo) - Number(b.studentNo)),
    [klass],
  )

  /* 本地工作副本：初值来自档案（**已有草稿则优先用草稿**），换档案时靠 key 重挂载 */
  const [restored] = useState(() => Boolean(loadDraft(DRAFT_KEY)))
  const [wrong, setWrong] = useState<Assignment['wrong']>(() => loadDraft(DRAFT_KEY)?.wrong ?? initialWrong)
  const [subs, setSubs] = useState<Record<string, number>>(
    () => loadDraft(DRAFT_KEY)?.subs ?? initialSubs,
  )
  const [confirmed, setConfirmed] = useState<string[]>(
    () => loadDraft(DRAFT_KEY)?.confirmed ?? initialConfirmed,
  )
  const [showRestored, setShowRestored] = useState(restored)

  /**
   * 边改边落盘。
   * 批改是"一个人点十几下"的连续动作，中途切出去（接电话、切应用）就全丢，
   * 教师得从头再点一遍 —— 这是最伤人的一类 bug。
   */
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(id), JSON.stringify({ wrong, subs, confirmed, at: Date.now() }))
    } catch {
      /* 存不下（隐私模式/配额满）也不能因此打断批改 */
    }
  }, [id, wrong, subs, confirmed])
  const [open, setOpen] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('byStudent')
  const [curQ, setCurQ] = useState(1)
  const [editing, setEditing] = useState<number | null>(null)
  const [askedDone, setAskedDone] = useState(false)
  const [taps, setTaps] = useState(0)
  const [startedAt] = useState(() => Date.now())
  const panelRef = useRef<HTMLDivElement>(null)

  const stats = useMemo(
    () =>
      assignment
        ? gradeStats(students, {
            ...assignment,
            wrong,
            subQuestions: subs,
            confirmedNos: confirmed,
          })
        : null,
    [assignment, students, wrong, subs, confirmed],
  )

  /* 展开的题号面板若在视口外，自动滚到可见位置 —— 让老师不用手动滑 */
  useEffect(() => {
    if (open) panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])

  if (!assignment) {
    return (
      <>
        <PageHead title="档案不存在" onBack={() => navigate('/assignments')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>该作业档案可能已被删除</div>
          </Panel>
        </Page>
      </>
    )
  }

  const subCountOf = (seq: number) => subs[String(seq)] ?? 0

  const markOpen = (no: string) => {
    setOpen((cur) => (cur === no ? null : no))
    setConfirmed((c) => (c.includes(no) ? c : [...c, no]))
  }

  const toggleFor = (no: string, seq: number) => {
    setTaps((t) => t + 1)
    setWrong((w) => ({ ...w, [no]: toggleQuestion(w[no], seq, subCountOf(seq)) }))
  }

  const toggleSubFor = (no: string, seq: number, sub: number) => {
    setTaps((t) => t + 1)
    setWrong((w) => ({ ...w, [no]: toggleSub(w[no], seq, sub) }))
  }

  const applySubs = (seq: number, n: number) => {
    setSubs((s) => {
      const next = { ...s }
      if (n <= 0) delete next[String(seq)]
      else next[String(seq)] = n
      return next
    })
    setWrong((w) => normalizeForSubCount(w, seq, n))
    setEditing(null)
    push({
      text: n > 0 ? `第 ${seq} 题已拆成 ${n} 个小题` : `第 ${seq} 题已取消小题`,
      tone: 'ok',
      desc: '已同步到整份档案',
    })
  }

  const wrongCountOf = (no: string) => wrong[no]?.length ?? 0

  const finish = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    setGrade(assignment.id, {
      wrong,
      confirmedNos: confirmed,
      subQuestions: subs,
      status: 'graded',
      gradeSeconds: seconds,
    })
    // 正式提交了，草稿就没用了 —— 留着下次进来会跟档案对不上
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* 忽略 */
    }
    navigate(`/assignments/${assignment.id}/grade/done`)
  }

  const unconfirmed = students.length - confirmed.length

  /* ***REMOVED***11 已批改的从原表挪走：原表只留没批的，越批越短，一眼看到还剩谁
     （不用 useMemo —— 它在早退分支之后，用了会违反 hooks 规则；数组很小，直接算）

     注意：`confirmed` 在"点开学生"时就记上了（相当于"已批阅"），
     所以**正在展开的那个人必须留在原表**，否则一点开就跳走、面板跟着消失。
     收起之后才落到下面的已批改表。 */
  const doneSet = new Set(confirmed)
  const todo = students.filter((s) => !doneSet.has(s.studentNo) || open === s.studentNo)
  const doneList = students.filter((s) => doneSet.has(s.studentNo) && open !== s.studentNo)

  return (
    <>
      <PageHead
        title="批改录入"
        sub={`${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · ${assignment.questionCount} 题`}
        onBack={() => navigate('/assignments')}
        right={
          <Button
            size="sm"
            variant="primary"
            icon={<IconCheck size={15} />}
            onClick={() => (unconfirmed > 0 ? setAskedDone(true) : finish())}
          >
            完成批改
          </Button>
        }
      />

      <Page>
        <div>
          {/* 恢复了上次没批完的进度 —— 得让教师知道，否则会以为数据串了 */}
          {showRestored ? (
            <div
              className="anim-in mb-3 flex items-center gap-2 p-2.5"
              style={{
                background: 'var(--color-accentsoft)',
                border: '1px solid var(--color-line2)',
                borderRadius: 6,
                fontSize: 12.5,
                color: 'var(--color-accentink)',
              }}
            >
              <IconRefresh size={15} />
              <span className="flex-1">已恢复上次没批完的进度，接着批就行</span>
              <button
                type="button"
                style={{ color: 'var(--color-ink3)', textDecoration: 'underline' }}
                onClick={() => {
                  try {
                    localStorage.removeItem(DRAFT_KEY)
                  } catch {
                    /* 忽略 */
                  }
                  setWrong(initialWrong)
                  setSubs(initialSubs)
                  setConfirmed(initialConfirmed)
                  setShowRestored(false)
                }}
              >
                丢弃，重新开始
              </button>
            </div>
          ) : null}
          {/* 概览 */}
          <Panel className="anim-in mb-3 overflow-hidden">
            <StatStrip
              items={[
                {
                  k: '已确认',
                  v: `${confirmed.length}/${students.length}`,
                  tone: confirmed.length === students.length ? 'var(--color-ok)' : undefined,
                },
                { k: '错题', v: stats?.wrongTotal ?? 0, tone: 'var(--color-bad)' },
                {
                  k: '完整度',
                  v: `${Math.round((stats?.completeness ?? 0) * 100)}%`,
                  tone:
                    (stats?.completeness ?? 0) >= 1
                      ? 'var(--color-ok)'
                      : 'var(--color-warn)',
                },
              ]}
            />
          </Panel>

          {/* 模式 */}
          <div className="mb-3 flex items-center gap-2">
            <div className="seg">
              <button
                type="button"
                data-on={mode === 'byStudent'}
                onClick={() => setMode('byStudent')}
              >
                按人
              </button>
              <button
                type="button"
                data-on={mode === 'byQuestion'}
                onClick={() => setMode('byQuestion')}
              >
                按题
              </button>
            </div>
            <span className="flex-1" />
            <span
              className="flex items-center gap-1.5"
              style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              <IconZap size={13} />
              默认全对 · 只点错的
            </span>
          </div>

          {/* 按题模式：选题 */}
          {mode === 'byQuestion' ? (
            <Panel className="mb-3" bodyClass="p-3">
              <div className="mb-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                先选一道题，再点做错的学生
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: assignment.questionCount }, (_, i) => i + 1).map((seq) => {
                  const on = curQ === seq
                  const stat = stats?.questions[seq - 1]
                  return (
                    <button
                      key={seq}
                      type="button"
                      onClick={() => setCurQ(seq)}
                      className="num grid place-items-center"
                      style={{
                        width: 34,
                        height: 34,
                        border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                        background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                        color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                        borderRadius: 4,
                        fontSize: 14,
                        fontWeight: 700,
                        position: 'relative',
                      }}
                    >
                      {seq}
                      {stat && stat.wrongCount > 0 ? (
                        <span
                          className="num"
                          style={{
                            position: 'absolute',
                            top: -5,
                            right: -5,
                            minWidth: 15,
                            height: 15,
                            padding: '0 3px',
                            borderRadius: 99,
                            background: 'var(--color-bad)',
                            color: '***REMOVED***fff',
                            fontSize: 9.5,
                            lineHeight: '15px',
                            fontWeight: 700,
                          }}
                        >
                          {stat.wrongCount}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
              <div
                className="mt-2.5 flex items-center gap-2 pt-2.5"
                style={{ borderTop: '1px solid var(--color-line)', fontSize: 12 }}
              >
                <span style={{ color: 'var(--color-ink3)' }}>第 {curQ} 题</span>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(curQ)}
                >
                  {subCountOf(curQ) > 0 ? `已拆 ${subCountOf(curQ)} 小题` : '拆小题'}
                </Button>
              </div>
            </Panel>
          ) : null}

          {/* 学生网格 */}
          <div className="mb-3">
            <Sect>
              {mode === 'byStudent' ? '点学号展开题号' : '点学生记为做错'}
              {todo.length ? ` · 还剩 ${todo.length} 人` : ' · 都批完了'}
            </Sect>
            <Panel className="overflow-hidden">
              <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
                {todo.map((s) => {
                  const wc = wrongCountOf(s.studentNo)
                  const isOpen = open === s.studentNo
                  const done = confirmed.includes(s.studentNo)
                  const inQ =
                    mode === 'byQuestion' &&
                    isQuestionWrong(wrong[s.studentNo], curQ, subCountOf(curQ))
                  const active = mode === 'byStudent' ? isOpen : inQ
                  return (
                    <Fragment key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (mode === 'byStudent') markOpen(s.studentNo)
                          else {
                            toggleFor(s.studentNo, curQ)
                            setConfirmed((c) =>
                              c.includes(s.studentNo) ? c : [...c, s.studentNo],
                            )
                          }
                        }}
                        className="relative flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                        aria-label={`${s.studentNo} 号 ${s.name}`}
                        style={{
                          background: active
                            ? 'var(--color-accentsoft)'
                            : wc > 0
                              ? 'var(--color-badsoft)'
                              : 'var(--color-surface)',
                          border: `1px solid ${
                            active
                              ? 'var(--color-accent)'
                              : wc > 0
                                ? 'var(--color-bad)'
                                : 'var(--color-line)'
                          }`,
                          borderRadius: 4,
                          transition: 'background-color .16s, border-color .16s',
                        }}
                      >
                        <span
                          className="num"
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: wc > 0 ? 'var(--color-bad)' : 'var(--color-ink)',
                          }}
                        >
                          {s.studentNo}
                        </span>
                        <span
                          className="w-full truncate"
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                        >
                          {s.name}
                        </span>
                        {wc > 0 ? (
                          <span
                            className="num"
                            style={{
                              position: 'absolute',
                              top: 3,
                              right: 3,
                              minWidth: 16,
                              height: 16,
                              padding: '0 3px',
                              borderRadius: 99,
                              background: 'var(--color-bad)',
                              color: '***REMOVED***fff',
                              fontSize: 10,
                              lineHeight: '16px',
                              fontWeight: 700,
                              textAlign: 'center',
                            }}
                          >
                            {wc}
                          </span>
                        ) : done ? (
                          <span
                            style={{
                              position: 'absolute',
                              top: 4,
                              right: 4,
                              color: 'var(--color-ok)',
                            }}
                          >
                            <IconCheck size={12} strokeWidth={2.6} />
                          </span>
                        ) : null}
                      </button>

                      {/* 题号就地展开在该学生正下方 —— 手指不用离开这一片区域 */}
                      {mode === 'byStudent' && isOpen ? (
                        <div
                          ref={panelRef}
                          className="anim-in"
                          style={{
                            gridColumn: '1 / -1',
                            border: '1px solid var(--color-accent)',
                            borderRadius: 4,
                            background: 'var(--color-surface)',
                            padding: 10,
                          }}
                        >
                          <div className="mb-2 flex items-center gap-2">
                            <span className="num" style={{ fontSize: 16, fontWeight: 700 }}>
                              {s.studentNo}
                            </span>
                            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
                            <Tag tone={wc > 0 ? 'bad' : 'ok'}>
                              {wc > 0 ? `${wc} 处错` : '全对'}
                            </Tag>
                            <span className="flex-1" />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setWrong((w) => ({ ...w, [s.studentNo]: [] }))
                                setTaps((t) => t + 1)
                              }}
                            >
                              整份全对
                            </Button>
                            <button
                              type="button"
                              onClick={() => setOpen(null)}
                              aria-label="收起"
                              style={{ color: 'var(--color-ink3)', padding: 4 }}
                            >
                              <IconX size={16} />
                            </button>
                          </div>

                          <div
                            className="grid gap-1.5"
                            style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
                          >
                            {Array.from(
                              { length: assignment.questionCount },
                              (_, i) => i + 1,
                            ).map((seq) => (
                              <QButton
                                key={seq}
                                seq={seq}
                                subCount={subCountOf(seq)}
                                wrong={wrong[s.studentNo] ?? []}
                                onToggle={() => toggleFor(s.studentNo, seq)}
                                onSub={(sub) => toggleSubFor(s.studentNo, seq, sub)}
                                onSetSubCount={(n) => applySubs(seq, n)}
                                onSubSettings={() => setEditing(seq)}
                              />
                            ))}
                          </div>

                          <div
                            className="mt-2"
                            style={{ fontSize: 11, color: 'var(--color-ink3)' }}
                          >
                            红色 = 做错 · <b>双击</b>题号直接拆小题 · <b>长按</b>调整小题
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  )
                })}
              </div>
            </Panel>
          </div>

          {/* ***REMOVED***11 已批改的挪到下面单独一张表，上面只留没批的 */}
          {doneList.length ? (
            <div className="mb-3">
              <Sect>已批改 {doneList.length} 人 · 点一下撤回重批</Sect>
              <Panel className="overflow-hidden">
                <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
                  {doneList.map((s) => {
                    const wc = wrongCountOf(s.studentNo)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setConfirmed((c) => c.filter((x) => x !== s.studentNo))}
                        className="flex items-center gap-1.5 px-2 py-2 text-left"
                        style={{
                          border: '1px solid var(--color-line2)',
                          borderRadius: 4,
                          background: wc ? 'var(--color-badsoft)' : 'var(--color-oksoft)',
                        }}
                      >
                        <span
                          className="num shrink-0"
                          style={{ fontSize: 13, fontWeight: 700, minWidth: 20 }}
                        >
                          {s.studentNo}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5 }}>
                          {s.name}
                        </span>
                        <span
                          className="num shrink-0"
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: wc ? 'var(--color-bad)' : 'var(--color-ok)',
                          }}
                        >
                          {wc ? `错${wc}` : '全对'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Panel>
            </div>
          ) : null}

          {/* 错题汇总（按题模式下的实时反馈） */}
          {mode === 'byQuestion' && stats && stats.questions[curQ - 1] ? (
            <Panel className="mb-3 overflow-hidden">
              <div className="panel-head">
                <h2>
                  第 {curQ} 题 · 错误率{' '}
                  {Math.round((stats.questions[curQ - 1].rate ?? 0) * 100)}%
                </h2>
                <span className="flex-1" />
                <Tag tone={BAND_META[stats.questions[curQ - 1].band].tone}>
                  {BAND_META[stats.questions[curQ - 1].band].label}
                </Tag>
              </div>
              <div className="p-3 flex flex-wrap gap-1.5">
                {stats.questions[curQ - 1].wrongNos.length === 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                    还没有人标为做错
                  </span>
                ) : (
                  stats.questions[curQ - 1].wrongNos.map((no) => (
                    <span
                      key={no}
                      className="num"
                      style={{
                        padding: '2px 7px',
                        background: 'var(--color-badsoft)',
                        color: 'var(--color-bad)',
                        borderRadius: 3,
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {no}
                    </span>
                  ))
                )}
              </div>
            </Panel>
          ) : null}

          <div
            className="flex items-start gap-2 px-1"
            style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
          >
            <IconInfo size={13} />
            <span>
              题号上<b>单击</b>记错、<b>双击</b>直接拆小题、<b>长按</b>调整小题。
              本次已录入 {taps} 次点击。
            </span>
          </div>
        </div>
      </Page>

      {editing ? (
        <SubEditor
          key={editing}
          seq={editing}
          count={subCountOf(editing)}
          onClose={() => setEditing(null)}
          onApply={(n) => applySubs(editing, n)}
        />
      ) : null}

      {/* 完整度提醒 */}
      <Sheet
        open={askedDone}
        onClose={() => setAskedDone(false)}
        title={`还有 ${unconfirmed} 人未确认`}
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setAskedDone(false)}>
              回去补完
            </Button>
            <Button block variant="primary" icon={<IconChevronRight size={16} />} onClick={finish}>
              继续完成
            </Button>
          </div>
        }
      >
        <div className="flex items-start gap-2.5">
          <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
            <IconAlert size={17} />
          </span>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--color-ink2)' }}>
            「未确认」表示你还没打开过他们的题号列表 —— 系统无法区分
            <b>确实全对</b>和<b>根本没看</b>。可以继续，但统计会标注数据完整度。
          </div>
        </div>
      </Sheet>
    </>
  )
}
