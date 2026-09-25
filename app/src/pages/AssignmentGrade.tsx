import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
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
import { parseQKey } from '../data/types'
import {
  BAND_META,
  gradeStats,
  isQuestionWrong,
  isSubWrong,
  normalizeForSubCount,
  type SubImpact,
  toggleQuestion,
  toggleSub,
} from '../lib/grading'
import { friendlyDate } from '../lib/date'
import { archiveKeyOf } from '../lib/keys'

/*
 * 🔴 **档案键**（`wrong` / `confirmedNos` / `focusNos` / `correctionNos` /
 *    `correctedNos` / `grades`）：迁移后是**序列号**（I40 / `schema.sql` §20）。
 *    所以本文件里凡是"读写这些集合"的地方一律 `k(s)`；
 *    凡是**显示**（`{s.studentNo}`、aria-label）的地方保持 `s.studentNo` 不动 ——
 *    老师看到的东西和迁移前一模一样（Q6 的原话）。
 *
 * ⚠️ 别名放在**模块层**（不是组件内）：放组件里会被 `react-hooks/exhaustive-deps`
 *    当成响应式依赖（"useMemo 少了一个依赖 k"），而它其实是个纯函数。
 */
const k = archiveKeyOf

type Mode = 'byStudent' | 'byQuestion'

/**
 * 等级 → 颜色 / 浅底色，和批改页那三个等级按钮同一套语义。
 * 极简模式**只有等级**，没有逐题数据 —— 界面上任何"错几处"的地方都要换成它。
 */
function gradeTone(g?: string): string {
  return g === '优' ? 'var(--color-ok)' : g === '差' ? 'var(--color-bad)' : 'var(--color-warn)'
}
function gradeSoft(g?: string): string {
  return g === '优' ? 'var(--color-oksoft)' : g === '差' ? 'var(--color-badsoft)' : 'var(--color-warnsoft)'
}

/**
 * 双击拆小题时，第一下单击需要撤销的信息。
 *
 * `previous` 是**点第一下之前**这个学生的错题记录（没有就是空数组）——
 * 不存快照、改用 toggle 反推的话，他原本就记过这一题时会把那一条也撤掉。
 */
type SubUndo = { no: string; previous: string[] }

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
  /** `previous` = 双击第一下之前这个学生的错题记录快照（撤销用） */
  onSetSubCount: (n: number, previous?: string[]) => void
  onSubSettings: () => void
}) {
  const lastTap = useRef(0)
  const pressTimer = useRef<number | null>(null)
  const longFired = useRef(false)
  const whole = isQuestionWrong(wrong, seq, subCount)
  /*
   * 双击的**第二下**点到的是上一次渲染留下的那个实例，props 还停在第一下之前。
   * 所以"第一下点了什么、之前是什么样、现在能不能拆"都要自己记下来，第二下才撤得干净。
   * 不能用 `whole`/`wrong`/`subCount` 反推：那还是旧值（这就是原来撤回失效的原因）。
   *
   * 用 effect 同步而不是渲染期赋值 —— 渲染期写 ref 会被 lint 挡下来（react(refs)）。
   * 事件在渲染与 effect 之后才发生，读到的就是最新值。
   */
  const latest = useRef({ subCount, wrong, onToggle })
  useEffect(() => {
    latest.current = { subCount, wrong, onToggle }
  })
  const preTap = useRef<string[] | null>(null)

  const handleTap = () => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      lastTap.current = 0
      // 双击：只在还没有小题时直接拆出两个，不再弹窗打断
      if (latest.current.subCount === 0) {
        const previous = preTap.current
        preTap.current = null
        onSetSubCount(2, previous ?? undefined)
      }
      return
    }
    lastTap.current = now
    preTap.current = latest.current.wrong
    latest.current.onToggle()
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
                  color: on ? '#fff' : 'var(--color-ink3)',
                  cursor: 'pointer',
                }}
                aria-label={`第 ${seq} 题第 ${sub} 小题`}
              >
                {sub}
              </button>
            )
          })}
          {/* 这里原来有个「+」能直接加小题，但它紧挨着小题号，
              点错就把题拆了 —— 拆小题现在只走双击，加/减小题只走长按面板 */}
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
        平时<strong>双击题号</strong>就能直接拆出 (1)(2)。这个面板在<strong>长按</strong>题号时打开，
        用来改成别的小题数、或取消小题。
      </p>
      <p style={{ fontSize: 12, color: 'var(--color-warn)', marginTop: 8, lineHeight: 1.65 }}>
        这一题上已经有人记过错。拆小题会把「整题错」改记到每个小题上（不会丢），
        减少或取消小题则会真的删掉一部分记录 —— 动手前会先把名单列给你确认。
      </p>
    </Sheet>
  )
}

/* ============================================================
   批改录入
   ============================================================ */

export default function AssignmentGrade() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const hydrated = useStore((s) => s.hydrated)

  /**
   * ⚠️ 档案没到位之前**绝对不能挂载 GradeSession**。
   *
   * GradeSession 把初值快照进 useState，而 useState 的初值**只取第一次渲染**。
   * 之前是 `initialConfirmed={assignment?.confirmedNos ?? []}` ——
   * 云端数据还在路上时传进去空数组，等数据到了它也不会再看一眼，
   * 于是「修改批改」进去永远是全新界面。这就是"有的档案正常、有的不对"的原因：
   * 差别只在进页面那一瞬间档案在不在内存里。
   */
  if (!hydrated || !assignment) {
    return (
      <>
        <PageHead title="批改录入" onBack={() => navigate('/assignments')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
              {hydrated ? '该作业档案可能已被删除' : '正在读取作业档案…'}
            </div>
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <GradeSession
      key={id}
      id={id}
      initialWrong={assignment.wrong ?? {}}
      initialSubs={assignment.subQuestions ?? {}}
      initialConfirmed={assignment.confirmedNos ?? []}
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
  grades?: Record<string, string>
  focus?: string[]
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

/**
 * 挑一份**值得用**的草稿。
 *
 * 空草稿比档案还空时直接丢掉 —— 它多半是"数据还没就绪时挂载写进去的空壳"，
 * 用了它会把档案里真实的批改进度盖成 0。
 */
function pickDraft(key: string, savedConfirmed: string[]): GradeDraft | null {
  const d = loadDraft(key)
  if (!d) return null
  const draftCount = (d.confirmed ?? []).length
  const savedCount = savedConfirmed.length
  // 草稿的进度还不如档案 → 这是坏草稿（或者档案更新过），以档案为准
  if (draftCount < savedCount) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* 忽略 */
    }
    return null
  }
  return d
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
        // 名单一律**按班内学号**排（老师认这个号；序列号只进档案、不上屏）
        .sort((a, b) => Number(a.studentNo) - Number(b.studentNo)),
    [klass],
  )

  /**
   * 本地工作副本：初值来自档案，**草稿只在它确实更有进度时**才优先。
   *
   * 之前是 `草稿 ?? 档案`，而空数组也是"有值" —— 于是一份空壳草稿
   * 会把档案里已批改的 43 个人盖成 0 个（就是"有的档案点进去是空白"的原因）。
   */
  const [draft] = useState(() => pickDraft(DRAFT_KEY, initialConfirmed))
  const [wrong, setWrong] = useState<Assignment['wrong']>(() => draft?.wrong ?? initialWrong)
  /**
   * 错题记录的**最新值**。
   *
   * 双击题号时第二下点到的还是**上一次渲染**的那个 QButton 实例 ——
   * 它闭包里的 `wrong` 停留在第一下之前（少了刚记上的那一条）。
   * 拆小题要按真实数据算"谁会被动到"，所以这里留一份跟着渲染更新的副本，
   * 撤销与影响范围都读它。
   */
  const wrongRef = useRef(wrong)
  useEffect(() => {
    wrongRef.current = wrong
  }, [wrong])
  const [subs, setSubs] = useState<Record<string, number>>(() => draft?.subs ?? initialSubs)
  const [confirmed, setConfirmed] = useState<string[]>(() => draft?.confirmed ?? initialConfirmed)
  const [showRestored, setShowRestored] = useState(Boolean(draft))

  /** 极简模式：不记题，只记 优/良/差 */
  const simple = assignment?.statsMode === 'simple'
  /*
   * ⚠️ 草稿优先 —— 等级和重点关注**只存在本地 state**，
   * 临时保存前不落库，草稿是它们唯一的副本。
   * 之前只从 assignment 初始化，于是"已恢复上次没批完的进度"这句话是假的：
   * wrong/confirmed 恢复了，grades/focus 却被清空，下一次 finish 再把空值写回档案。
   */
  const [grades, setGrades] = useState<Record<string, string>>(
    () => draft?.grades ?? assignment?.grades ?? {},
  )
  /**
   * 「需重点关注」——和改错名单是两回事：
   * 改错名单是"错了要改的人"，这里是教师觉得这孩子不对劲、单独标的（哪怕他全对）。
   */
  const [focus, setFocus] = useState<string[]>(() => draft?.focus ?? assignment?.focusNos ?? [])
  const toggleFocus = (no: string) =>
    setFocus((f) => (f.includes(no) ? f.filter((x) => x !== no) : [...f, no]))

  /** 改错名单：**边勾边存** —— 教师随时可能被打断，不能等最后一起提交 */
  const [correction, setCorrection] = useState<string[]>(() => assignment?.correctionNos ?? [])
  const updateAssignment = useStore((s) => s.updateAssignment)
  const toggleCorrection = (no: string) => {
    const next = correction.includes(no)
      ? correction.filter((x) => x !== no)
      : [...correction, no]
    setCorrection(next)
    updateAssignment(id, { correctionNos: next })
  }

  /**
   * 边改边落盘。
   * 批改是"一个人点十几下"的连续动作，中途切出去（接电话、切应用）就全丢，
   * 教师得从头再点一遍 —— 这是最伤人的一类 bug。
   */
  const firstRun = useRef(true)
  useEffect(() => {
    // 挂载那一次不写 —— 那一刻的初值可能还没就绪，
    // 写下去就是一份空壳草稿，下次进来会把真实进度盖掉
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    try {
      localStorage.setItem(
        draftKey(id),
        JSON.stringify({ wrong, subs, confirmed, grades, focus, at: Date.now() }),
      )
    } catch {
      /* 存不下（隐私模式/配额满）也不能因此打断批改 */
    }
  }, [id, wrong, subs, confirmed, grades, focus])

  /**
   * 兜底：档案数据在本页挂载**之后**才更新（云端同步晚到）时补一次。
   * 只在**完全没动过**时生效（一个人都没确认、一道错题都没记）——
   * 教师已经点过的进度绝不能被覆盖。
   */
  useEffect(() => {
    const saved = assignment?.confirmedNos ?? []
    const untouched = confirmed.length === 0 && Object.keys(wrong).length === 0
    if (untouched && saved.length > 0) {
      setWrong(assignment?.wrong ?? {})
      setSubs(assignment?.subQuestions ?? {})
      setConfirmed(saved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed.length, Object.keys(wrong).length, assignment?.confirmedNos?.length])
  const [open, setOpen] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('byStudent')
  const [curQ, setCurQ] = useState(1)
  const [editing, setEditing] = useState<number | null>(null)
  /** 拆小题前卡住的那一步：确认后才知道动的是哪些人的记录 */
  const [pendingSub, setPendingSub] = useState<{
    seq: number
    n: number
    /** 已经算好的归一化结果 —— 确认时直接用它落盘，不重算 */
    impact: SubImpact
  } | null>(null)
  const [askedDone, setAskedDone] = useState(false)
  /** 弹层里的步骤：先选保存方式，再选改错名单 */
  const [step, setStep] = useState<'choose' | 'select'>('choose')
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

  /**
   * 极简模式的等级分布。
   *
   * 极简模式**没有错题数据**（`wrong` 永远是空的），概览里那个「错题 0」不是
   * "这次没人错"，而是"这份档案根本不记题" —— 拿普通模式的指标去渲染极简模式，
   * 教师会以为全班全对。这里换成等级分布，才是这份档案真正的结论。
   */
  const gradeCounts = useMemo(() => {
    const c = { 优: 0, 良: 0, 差: 0 }
    for (const s of students) {
      const g = grades[k(s)]
      if (g === '优' || g === '良' || g === '差') c[g]++
    }
    return c
  }, [students, grades])

  /**
   * 未交名单：这些人**不能批改**（不变量 I3）。
   * 用 Set 是为了在 map 里 O(1) 判断 —— 一份档案几十人，不必每次 includes 扫一遍。
   */
  const missingSet = useMemo(
    () => new Set(assignment?.missingNos ?? []),
    [assignment?.missingNos],
  )

  /* 展开的学生在别处被登记成未交时，把面板收掉 —— 不然那里还留着一片可点的题号 */
  useEffect(() => {
    if (open && missingSet.has(open)) setOpen(null)
  }, [open, missingSet])

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

  const confirm = (no: string) => setConfirmed((c) => (c.includes(no) ? c : [...c, no]))

  /**
   * 这题上"会有记录被搬走或被删掉"的学号（按学号排序，界面好读）。
   *
   * ⚠️ 判断"谁在这题上有记录"必须按**当前**的错题记录来 ——
   * `impact.next` 里已经带上迁移后的新键，拿它当依据的话，
   * 连"只有别的题记错"的人也会被算进来，凭空多弹一次确认。
   *
   * `skip` 是双击第一下刚碰过的那个学号（他正在被撤回）。
   * 传进来的记录里已经不含他了，但下拉列表是照记录筛的 —— 不排除掉的话，
   * 弹层里的人数会和"这一题现在记着 N 个人"对不上。
   */
  const subAffected = (seq: number, impact: SubImpact, skip: string[] = []) => {
    const nos = new Set([...impact.migrated, ...impact.dropped])
    for (const [no, keys] of Object.entries(wrongRef.current)) {
      if (keys.some((k) => parseQKey(k).seq === seq)) nos.add(no)
    }
    for (const no of skip) nos.delete(no)
    return students.filter((s) => nos.has(k(s))).map((s) => k(s))
  }

  /**
   * 登记为「未交」的学生**不能批改** —— 人没交本子，哪来的错题。
   * 要批先回收缴页把他改回已交。
   */
  const isMissing = (no: string) => missingSet.has(no)
  const blocked = () => push({ text: '这位同学登记为未交，先去收缴页改回已交才能批', tone: 'warn' })

  /**
   * 点开学生**只展开，不算批改过**。
   *
   * 以前点开就同时记成「已批阅」，而没人点过错题就等于「全对」——
   * 于是点错人再切走，那个人就被默默记成全对了。
   * 全对必须是教师**明确点一下**的动作，不能靠"点开过"推断。
   */
  const markOpen = (no: string) => {
    if (isMissing(no)) {
      blocked()
      return
    }
    setOpen((cur) => (cur === no ? null : no))
  }

  /**
   * 记错题 / 取消错题。
   *
   * 加错题 = 这个人确实批过了 → 确认；
   * **但把最后一个错题也消掉时，要把他退回"还没批"** ——
   * 否则「取消掉所有错题」就等于全对，又绕过了「确认全对」那个按钮。
   */
  const toggleFor = (no: string, seq: number) => {
    if (isMissing(no)) {
      blocked()
      return
    }
    setTaps((t) => t + 1)
    const next = toggleQuestion(wrong[no], seq, subCountOf(seq))
    setWrong((w) => ({ ...w, [no]: next }))
    if (next.length === 0) setConfirmed((c) => c.filter((x) => x !== no))
    else confirm(no)
  }

  const toggleSubFor = (no: string, seq: number, sub: number) => {
    // 小题按钮和三态循环走的是两个入口 —— 判定入口只能有一个（见 §十）
    if (isMissing(no)) {
      blocked()
      return
    }
    setTaps((t) => t + 1)
    const next = toggleSub(wrong[no], seq, sub)
    setWrong((w) => ({ ...w, [no]: next }))
    if (next.length === 0) setConfirmed((c) => c.filter((x) => x !== no))
    else confirm(no)
  }

  /**
   * 拆 / 减小题会影响**全班**：这一题的错题记录都要跟着变。
   *
   * 三步走：
   *  1. 结构没变（长按面板原样点「完成」）→ 什么都不做，直接关面板；
   *  2. 算清"动了谁的记录"：已经有记录的这题，整题错会被搬成小题记录（保留），
   *     缩小或取消小题才会真删；
   *  3. 有人会被删 → **先把名单摆给教师确认**；没人会被动到 → 直接改，不打断。
   *
   * 另外，这里**不能碰 `correctionNos`**：改错名单是"错了要去改的人"的独立名单，
   * 改小题结构不该顺手把名单也改了。
   */
  const applySubs = (seq: number, n: number, undo?: SubUndo) => {
    const before = subCountOf(seq)
    /*
     * 结构没变（比如长按打开面板、原样点了「完成」）而且没有要撤回的单击 ——
     * 什么都别动。少了这一步，一次无意义的"完成"也会把整题错的记录改写成小题记录，
     * 白白多弹一次确认。
     */
    if (before === n && !undo) {
      setEditing(null)
      setPendingSub(null)
      return
    }
    /*
     * ⚠️ 读 `wrongRef` 而不是闭包里的 `wrong`。
     * 双击拆小题的第二下，`onSetSubCount` 还是上一次渲染留下的实例，
     * 闭包里的记录少了第一下刚记上的那一条（那张卡片没有重渲染）。
     */
    const live = wrongRef.current
    // 双击的第一下已经落了一条"记错"，这里按它**之前**的样子撤回来
    const undone: Assignment['wrong'] = undo ? { ...live, [undo.no]: undo.previous } : live
    const impact = normalizeForSubCount({ wrong: undone, before, seq, count: n })
    const touched = subAffected(seq, impact, undo?.no ? [undo.no] : [])
    if (touched.length === 0) {
      commitSubs(seq, n, impact)
      return
    }
    setPendingSub({ seq, n, impact })
    setEditing(null)
  }

  /** 确认之后才真正改结构、落记录 */
  const commitSubs = (seq: number, n: number, impact: SubImpact) => {
    setSubs((s) => {
      const next = { ...s }
      if (n <= 0) delete next[String(seq)]
      else next[String(seq)] = n
      return next
    })
    setWrong(impact.next)
    setEditing(null)
    setPendingSub(null)
    push({
      text: n > 0 ? `第 ${seq} 题已拆成 ${n} 个小题` : `第 ${seq} 题已取消小题`,
      tone: 'ok',
      desc: impact.migrated.length
        ? `${impact.migrated.length} 人的记录已改记到小题上，没有丢`
        : '已同步到整份档案',
    })
  }

  const wrongCountOf = (no: string) => wrong[no]?.length ?? 0

  /**
   * 临时保存：只把当前进度写回档案，**不**动未批改的人。
   * 之后从作业列表点进来会接着这次的状态，不是空白。
   */
  const saveDraft = () => {
    setGrade(assignment.id, {
      wrong,
      confirmedNos: confirmed,
      subQuestions: subs,
      grades,
      focusNos: focus,
      correctionNos: correction,
    })
    push({ text: '已临时保存，之后可以接着批', tone: 'ok' })
    navigate('/assignments')
  }

  /**
   * 确认完成批改。
   * **未批改的人一律登记为「未交」** —— 教师批的就是交上来的那一摞，
   * 不在里面的就是没交。
   */
  const finish = (correctionOverride?: string[]) => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const ungraded = students
      .filter((s) => !confirmed.includes(k(s)))
      .map((s) => k(s))
    /*
     * ⚠️ 改错名单必须用**实参**，不能只读 state。
     * 调用方可能在同一个事件里刚 setCorrection(all) 就调 finish() ——
     * setState 是异步的，这里读到的还是旧值 []，而 store 的 `?? ` 判不出空数组，
     * 于是把刚写进去的名单覆盖成空（默认路径必现）。
     */
    const nextCorrection = correctionOverride ?? correction
    setGrade(assignment.id, {
      wrong,
      confirmedNos: confirmed,
      subQuestions: subs,
      status: 'graded',
      gradeSeconds: seconds,
      grades,
      focusNos: focus,
      correctionNos: nextCorrection,
      missingNos: [...new Set([...assignment.missingNos, ...ungraded])],
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

  /* #11 已批改的从原表挪走：原表只留没批的，越批越短，一眼看到还剩谁
     （不用 useMemo —— 它在早退分支之后，用了会违反 hooks 规则；数组很小，直接算）

     注意：`confirmed` 在"点开学生"时就记上了（相当于"已批阅"），
     所以**正在展开的那个人必须留在原表**，否则一点开就跳走、面板跟着消失。
     收起之后才落到下面的已批改表。 */
  const doneSet = new Set(confirmed)
  const todo = students.filter((s) => !doneSet.has(k(s)) || open === k(s))
  const doneList = students.filter((s) => doneSet.has(k(s)) && open !== k(s))

  /* 待确认的拆小题：要如实告诉他这一题上现在记着谁（不用 useMemo，几十个人直接筛） */
  const pendingSubNo = pendingSub?.seq ?? -1
  const pendingWrong = students.filter((s) =>
    (wrong[k(s)] ?? []).some((k) => parseQKey(k).seq === pendingSubNo),
  )

  return (
    <>
      <PageHead
        title="批改录入"
        /*
         * 极简模式**没有"题"这个概念**，标题栏里那个「N 题」是普通模式的口径
         * （它的值来自建档时那个被隐藏的输入框）—— 照普通模式写出来，
         * 教师会去找"第 3 题在哪"，而这一屏根本没有题号。
         */
        sub={
          simple
            ? `${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · 极简模式 · 只记等级`
            : `${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · ${assignment.questionCount} 题`
        }
        onBack={() => navigate('/assignments')}
        right={
          <Button
            size="sm"
            variant="primary"
            icon={<IconCheck size={15} />}
            onClick={() => setAskedDone(true)}
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
          {/* 概览：极简模式看等级分布，普通模式看错题与完整度 */}
          <Panel className="anim-in mb-3 overflow-hidden">
            <StatStrip
              items={
                simple
                  ? [
                      {
                        k: '已评',
                        v: `${confirmed.length}/${students.length}`,
                        tone:
                          confirmed.length === students.length ? 'var(--color-ok)' : undefined,
                      },
                      { k: '优', v: gradeCounts.优, tone: 'var(--color-ok)' },
                      { k: '良', v: gradeCounts.良, tone: 'var(--color-warn)' },
                      { k: '差', v: gradeCounts.差, tone: 'var(--color-bad)' },
                    ]
                  : [
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
                    ]
              }
            />
          </Panel>

          {/* 模式：极简模式没有"题"，这两个切换没意义 */}
          <div className="mb-3 flex items-center gap-2" style={{ display: simple ? 'none' : undefined }}>
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
                            color: '#fff',
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
              {simple
                ? '点学号选 优 / 良 / 差'
                : mode === 'byStudent'
                  ? '点学号展开题号'
                  : '点学生记为做错'}
              {todo.length ? ` · 还剩 ${todo.length} 人` : ' · 都批完了'}
            </Sect>
            <Panel className="overflow-hidden">
              <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
                {todo.map((s) => {
                  const wc = wrongCountOf(k(s))
                  const isOpen = open === k(s)
                  const done = confirmed.includes(k(s))
                  const grade = grades[k(s)]
                  /*
                   * 极简模式没有"错几处"这回事 —— 卡片上的角标换成等级，
                   * 颜色也跟着等级走（优绿 / 良黄 / 差红）。照普通模式渲染的话，
                   * 每个学生都顶着一个"全对"的绿勾，看起来像全班全对。
                   */
                  const tone = simple ? (grade ? gradeTone(grade) : undefined) : wc > 0 ? 'var(--color-bad)' : undefined
                  const soft = simple
                    ? grade
                      ? gradeSoft(grade)
                      : undefined
                    : wc > 0
                      ? 'var(--color-badsoft)'
                      : undefined
                  const inQ =
                    !simple &&
                    mode === 'byQuestion' &&
                    isQuestionWrong(wrong[k(s)], curQ, subCountOf(curQ))
                  const active = simple ? false : mode === 'byStudent' ? isOpen : inQ
                  return (
                    <Fragment key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (simple || mode === 'byStudent') {
                            markOpen(k(s))
                            return
                          }
                          /*
                           * ⚠️ 这里**绝对不能**再无条件 setConfirmed。
                           * toggleFor 内部已经处理了"记错就确认、错题归零就退回未批"，
                           * 也无条件会拦下未交学生 —— 之前这两句一叠加，
                           * 点一下未交学生就把他写成"已交 + 全对"，未交记录被永久删掉。
                           */
                          toggleFor(k(s), curQ)
                        }}
                        className="relative flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                        aria-label={`${s.studentNo} 号 ${s.name}`}
                        style={{
                          background: active
                            ? 'var(--color-accentsoft)'
                            : (soft ?? 'var(--color-surface)'),
                          border: `1px solid ${active ? 'var(--color-accent)' : (tone ?? 'var(--color-line)')}`,
                          borderRadius: 4,
                          transition: 'background-color .16s, border-color .16s',
                        }}
                      >
                        <span
                          className="num"
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: tone ?? 'var(--color-ink)',
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
                        {simple ? (
                          grade ? (
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
                                background: tone,
                                color: '#fff',
                                fontSize: 10,
                                lineHeight: '16px',
                                fontWeight: 700,
                                textAlign: 'center',
                              }}
                            >
                              {grade}
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
                          ) : null
                        ) : wc > 0 ? (
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
                              color: '#fff',
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
                            {simple ? (
                              <Tag tone={grades[k(s)] ? 'accent' : 'idle'}>
                                {grades[k(s)] ?? '未评'}
                              </Tag>
                            ) : (
                              <Tag tone={wc > 0 ? 'bad' : 'ok'}>
                                {wc > 0 ? `${wc} 处错` : '全对'}
                              </Tag>
                            )}
                            {focus.includes(k(s)) ? <Tag tone="warn">重点关注</Tag> : null}
                            <span className="flex-1" />
                            {!simple ? (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                  if (isMissing(k(s))) {
                                    blocked()
                                    return
                                  }
                                  setWrong((w) => ({ ...w, [k(s)]: [] }))
                                  setTaps((t) => t + 1)
                                  // 「全对」是要点出来的动作，不点就不算批过
                                  confirm(k(s))
                                }}
                              >
                                确认全对
                              </Button>
                            ) : null}
                            {/* 「找」：标记需重点关注。和改错名单是两回事 —— 全对也可能要盯 */}
                            <button
                              type="button"
                              onClick={() => toggleFocus(k(s))}
                              aria-label={`${s.name} 标记需重点关注`}
                              title={focus.includes(k(s)) ? '取消重点关注' : '标记为需重点关注'}
                              style={{
                                width: 30,
                                height: 30,
                                borderRadius: 99,
                                flexShrink: 0,
                                fontSize: 13,
                                fontWeight: 700,
                                border: `1.5px solid ${
                                  focus.includes(k(s))
                                    ? 'var(--color-warn)'
                                    : 'var(--color-line2)'
                                }`,
                                background: focus.includes(k(s))
                                  ? 'var(--color-warnsoft)'
                                  : 'transparent',
                                color: focus.includes(k(s))
                                  ? 'var(--color-warn)'
                                  : 'var(--color-ink3)',
                              }}
                            >
                              找
                            </button>
                            <button
                              type="button"
                              onClick={() => setOpen(null)}
                              aria-label="收起"
                              style={{ color: 'var(--color-ink3)', padding: 4 }}
                            >
                              <IconX size={16} />
                            </button>
                          </div>

                          {/* 极简模式只点等级；普通模式点题号记错 */}
                          {simple ? (
                            <div className="flex gap-2">
                              {(['优', '良', '差'] as const).map((lv) => {
                                const on = grades[k(s)] === lv
                                const tone =
                                  lv === '优'
                                    ? 'var(--color-ok)'
                                    : lv === '差'
                                      ? 'var(--color-bad)'
                                      : 'var(--color-warn)'
                                return (
                                  <button
                                    key={lv}
                                    type="button"
                                    onClick={() => {
                                      if (isMissing(k(s))) {
                                        blocked()
                                        return
                                      }
                                      setGrades((g) => ({ ...g, [k(s)]: lv }))
                                      setTaps((t) => t + 1)
                                      confirm(k(s))
                                    }}
                                    className="flex-1"
                                    style={{
                                      padding: '10px 0',
                                      fontSize: 16,
                                      fontWeight: 700,
                                      borderRadius: 4,
                                      border: `1px solid ${on ? tone : 'var(--color-line2)'}`,
                                      background: on ? 'var(--color-surface2)' : 'var(--color-surface)',
                                      color: on ? tone : 'var(--color-ink2)',
                                    }}
                                  >
                                    {lv}
                                  </button>
                                )
                              })}
                            </div>
                          ) : (
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
                                  wrong={wrong[k(s)] ?? []}
                                  onToggle={() => toggleFor(k(s), seq)}
                                  onSub={(sub) => toggleSubFor(k(s), seq, sub)}
                                  onSetSubCount={(n, previous) =>
                                    applySubs(seq, n, previous ? { no: k(s), previous } : undefined)
                                  }
                                  onSubSettings={() => setEditing(seq)}
                                />
                              ))}
                            </div>
                          )}

                          <div
                            className="mt-2"
                            style={{ fontSize: 11, color: 'var(--color-ink3)' }}
                          >
                            {simple ? (
                              <>
                                点一下记等级（优 / 良 / 差）· 要撤回就点下面「已批改」里的人
                              </>
                            ) : (
                              <>
                                红色 = 做错 · <b>双击</b>题号直接拆小题 · <b>长按</b>调整小题
                              </>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </Fragment>
                  )
                })}
              </div>
            </Panel>
          </div>

          {/* 需重点关注名单 —— 和改错名单是两回事，全对的人也可能被标进来 */}
          {focus.length ? (
            <div className="mb-3">
              <Sect>需重点关注 {focus.length} 人 · 点一下取消</Sect>
              <Panel className="overflow-hidden">
                <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
                  {students
                    .filter((s) => focus.includes(k(s)))
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleFocus(k(s))}
                        className="flex items-center gap-1.5 px-2 py-2 text-left"
                        style={{
                          border: '1px solid var(--color-warn)',
                          borderRadius: 4,
                          background: 'var(--color-warnsoft)',
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
                          style={{ fontSize: 11, color: 'var(--color-ink3)' }}
                        >
                          {simple
                            ? (grades[k(s)] ?? '未评')
                            : wrongCountOf(k(s))
                              ? `错${wrongCountOf(k(s))}`
                              : '全对'}
                        </span>
                      </button>
                    ))}
                </div>
              </Panel>
            </div>
          ) : null}

          {/* #11 已批改的挪到下面单独一张表，上面只留没批的 */}
          {doneList.length ? (
            <div className="mb-3">
              <Sect>已批改 {doneList.length} 人 · 点一下撤回重批</Sect>
              <Panel className="overflow-hidden">
                <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
                  {doneList.map((s) => {
                    const wc = wrongCountOf(k(s))
                    const grade = grades[k(s)]
                    // 极简模式：结论是等级，不是"错几处"（`wrong` 在这类档案里永远是空的）
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setConfirmed((c) => c.filter((x) => x !== k(s)))}
                        className="flex items-center gap-1.5 px-2 py-2 text-left"
                        style={{
                          border: '1px solid var(--color-line2)',
                          borderRadius: 4,
                          background: simple
                            ? grade
                              ? gradeSoft(grade)
                              : 'var(--color-surface2)'
                            : wc
                              ? 'var(--color-badsoft)'
                              : 'var(--color-oksoft)',
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
                            color: simple
                              ? grade
                                ? gradeTone(grade)
                                : 'var(--color-ink3)'
                              : wc
                                ? 'var(--color-bad)'
                                : 'var(--color-ok)',
                          }}
                        >
                          {simple ? (grade ?? '未评') : wc ? `错${wc}` : '全对'}
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
              {simple ? (
                <>
                  点开学生选<b>优 / 良 / 差</b>；极简模式不记题目，所以没有题号、没有错题统计。
                  本次已录入 {taps} 次点击。
                </>
              ) : (
                <>
                  题号上<b>单击</b>记错、<b>双击</b>直接拆小题、<b>长按</b>调整小题。
                  本次已录入 {taps} 次点击。
                </>
              )}
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

      {/*
        拆/减小题前把"谁会被动到"如实摆出来。
        这道题上已经有人记过错 —— 直接改结构会悄悄抹掉他们的记录（原来的写法就是这样），
        所以先确认一次：拆小题只是把整题错搬成小题错，减小题才是真的删。
      */}
      {pendingSub ? (
        <Sheet
          open
          onClose={() => setPendingSub(null)}
          title={pendingSub.n > 0 ? `第 ${pendingSub.seq} 题拆成小题？` : `取消第 ${pendingSub.seq} 题的小题？`}
          footer={
            <div className="flex gap-2">
              <Button block onClick={() => setPendingSub(null)}>
                算了
              </Button>
              <Button
                block
                variant="primary"
                onClick={() => commitSubs(pendingSub.seq, pendingSub.n, pendingSub.impact)}
              >
                {pendingSub.n > 0 ? '确认拆小题' : '确认取消小题'}
              </Button>
            </div>
          }
        >
          <div className="flex items-start gap-2.5">
            <span
              style={{
                color: pendingSub.n > 0 ? 'var(--color-warn)' : 'var(--color-bad)',
                marginTop: 1,
              }}
            >
              <IconAlert size={17} />
            </span>
            <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--color-ink2)' }}>
              这一题现在记着 <b className="num">{pendingWrong.length}</b> 个人的错。
              {pendingSub.n > 0 ? (
                <>
                  <br />
                  拆成 <b className="num">{pendingSub.n}</b> 个小题后，每一条「整题错」
                  都会同时记到每个小题上，一条都不会少。
                  谁其实只错了一部分，再点一下对应的小题取消就行。
                </>
              ) : (
                <>
                  <br />
                  取消小题会把这一题恢复成一个整题，上面这些人的错题记录
                  <b>会一起删掉</b>，且不能撤销。
                </>
              )}
            </div>
          </div>
          {pendingWrong.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {pendingWrong.map((s) => (
                <span
                  key={s.id}
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
                  {s.studentNo}
                </span>
              ))}
            </div>
          ) : null}
        </Sheet>
      ) : null}

      {/* 完成批改：两条路 —— 临时保存 / 确认完成（未批改的记为未交） */}
      <Sheet
        open={askedDone}
        onClose={() => {
          setAskedDone(false)
          setStep('choose')
        }}
        title={step === 'choose' ? '完成批改' : '选择需要改错的学生'}
      >
        {step === 'choose' ? (
          <>
            <button
              type="button"
              className="mb-2 w-full p-3 text-left"
              style={{ border: '1px solid var(--color-line2)', borderRadius: 6, background: 'var(--color-surface)' }}
              onClick={saveDraft}
            >
              <span style={{ display: 'block', fontSize: 14.5, fontWeight: 650 }}>临时保存</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.6, marginTop: 2 }}>
                只存下当前进度，未批改的 <b>{unconfirmed}</b> 人不算未交。
              </span>
            </button>
            <button
              type="button"
              className="w-full p-3 text-left"
              style={{ border: '1px solid var(--color-accent)', borderRadius: 6, background: 'var(--color-accentsoft)' }}
              onClick={() => (simple ? finish() : setStep('select'))}
            >
              <span style={{ display: 'block', fontSize: 14.5, fontWeight: 650, color: 'var(--color-accentink)' }}>
                确认完成批改
              </span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.6, marginTop: 2 }}>
                未批改的 <b>{unconfirmed}</b> 人会被登记为未交。
                {simple ? '' : ' 下一步可以挑需要改错的人。'}
              </span>
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
              勾选需要改错的人，这份名单会出现在「改错登记」里。
            </p>

            <div className="mb-2 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const all = students.filter((s) => wrongCountOf(k(s)) > 0).map((s) => k(s))
                  setCorrection(all)
                  updateAssignment(id, { correctionNos: all })
                }}
              >
                全选有错的
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const bad = students
                    .filter((s) => wrongCountOf(k(s)) / Math.max(1, assignment.questionCount) >= 0.3)
                    .map((s) => k(s))
                  setCorrection(bad)
                  updateAssignment(id, { correctionNos: bad })
                }}
              >
                错误率 ≥ 30%
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCorrection([])
                  updateAssignment(id, { correctionNos: [] })
                }}
              >
                清空
              </Button>
            </div>

            <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
              {students.map((s) => {
                const wc = wrongCountOf(k(s))
                const rate = wc / Math.max(1, assignment.questionCount)
                const col =
                  wc === 0 ? 'var(--color-ok)' : rate >= 0.3 ? 'var(--color-bad)' : 'var(--color-warn)'
                const on = correction.includes(k(s))
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-2.5 px-1 py-2"
                    style={{ borderBottom: '1px solid var(--color-line)', cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleCorrection(k(s))}
                      style={{ width: 16, height: 16, accentColor: 'var(--color-accent)', flexShrink: 0 }}
                    />
                    <span className="num shrink-0" style={{ fontSize: 13.5, fontWeight: 700, minWidth: 24 }}>
                      {s.studentNo}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                      {s.name}
                    </span>
                    {focus.includes(k(s)) ? <Tag tone="warn">重点</Tag> : null}
                    <span
                      className="num shrink-0"
                      style={{ fontSize: 13, fontWeight: 700, color: col, minWidth: 48, textAlign: 'right' }}
                    >
                      {wc === 0 ? '全对' : `错 ${wc}`}
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="mt-3 flex gap-2">
              <Button block onClick={() => setStep('choose')}>
                返回
              </Button>
              <Button
                block
                variant="primary"
                onClick={() => {
                  // 改错名单默认就是"有错的那些人"，教师没勾就按有错的来。
                  // 注意：算出来的名单要**直接传给 finish**，不能只 setCorrection ——
                  // setState 是异步的，finish 在同一个事件里读到的是旧值。
                  const next = correction.length
                    ? correction
                    : students.filter((s) => wrongCountOf(k(s)) > 0).map((s) => k(s))
                  setCorrection(next)
                  updateAssignment(id, { correctionNos: next })
                  finish(next)
                }}
              >
                确认完成批改
              </Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  )
}
