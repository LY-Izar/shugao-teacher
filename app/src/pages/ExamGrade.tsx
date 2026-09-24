import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconList,
  IconRefresh,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { EXAM_MODE_TEXT, type Exam, type ExamQuestion, type ExamScore } from '../data/examTypes'
import {
  EXAM_KIND_TEXT,
  OPTION_LETTERS,
  gradeChoice,
  isChoiceKind,
  objectiveSubjective,
  questionCountOf,
  questionsOf,
  round2,
  scoreOf,
  totalOf,
} from '../lib/examPaper'

/* ============================================================
   考试 · 手动批阅
   ------------------------------------------------------------
   交互（用户口径，逐条落地）：
     · 点一个学生卡 → **其他学生暂时隐藏**，只剩这一个学生（`open` 状态）
     · 题号**沿着竖列展开**，每个题号后面跟着：
         - 「记录答题情况」模式的选择题 → 选项按钮（A…H）
         - 其余题型 → 0~满分的分值选择
     · 该学生卡展开后**右下角**是「确认批阅」
     · 点「确认批阅」后 —— ⚠️ **不是"下一个待批学生顶上来"，而是整张待批改的表重新显示**
       （用户后来专门更正过这一条），这个学生落进下面「已完成」的表
     · **边改边保存**：确认批阅时立刻写一个人的成绩；「临时保存」把整份进度写回档案
     · 右上角「批阅完成」分两条路：**临时保存** / **确认完成**
       —— 确认完成时，**没改过的学生每题按 0 分算**，并且**完成前弹窗让老师确认**

   🔴 不变量 E1：`graded` 只由「确认批阅」（以及文件导入）置 true。
      点开学生、展开题号、切模式**都不算批阅** —— 与作业的 I1 是同一条纪律：
      "全对必须是人点出来的"，考试这边是"录过必须是有人确认过的"。
      破坏了会怎样：老师点开一个学生看了看就切走，那个人被默默记成"已批阅（每题 0 分）"，
      而 0 分会**真的算进均分**，统计页从此是错的。
   ============================================================ */

/** 空题：题型待定、分值 0 —— 与 `questionsOf()` 的补法一致（**不猜**） */
const EMPTY_Q: ExamQuestion = { no: 0, kind: 'other', fullScore: 0 }

function draftKey(id: string) {
  return `shugao.exam.grade.draft.${id}`
}

type Row = {
  scores: Record<string, number>
  answers: Record<string, string>
  graded: boolean
}

type GradeDraft = {
  rows: Record<string, Row>
  at: number
}

function loadDraft(key: string): GradeDraft | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const d = JSON.parse(raw) as GradeDraft
    if (!d || typeof d !== 'object' || !d.rows || typeof d.rows !== 'object') return null
    return d
  } catch {
    return null
  }
}

/**
 * 某个学生当前的记录（**档案 + 本地草稿合并**）。
 * 草稿只在它比档案更有进度时才用 —— 与作业 `pickDraft` 同一条纪律：
 * 空壳草稿会把档案里已批改的进度盖成 0（那个 bug 已经出过一次，见 §十）。
 */
function rowOf(
  saved: Map<string, ExamScore>,
  draft: GradeDraft | null,
  studentNo: string,
): Row {
  const s = saved.get(studentNo)
  const d = draft?.rows?.[studentNo]
  const base: Row = {
    scores: s?.scores ?? {},
    answers: s?.answers ?? {},
    graded: s?.graded === true,
  }
  if (!d) return base
  const savedSize = Object.keys(base.scores).length + Object.keys(base.answers).length
  const draftSize = Object.keys(d.scores ?? {}).length + Object.keys(d.answers ?? {}).length
  if (!d.graded && !base.graded && draftSize < savedSize) return base
  return {
    scores: { ...base.scores, ...(d.scores ?? {}) },
    answers: { ...base.answers, ...(d.answers ?? {}) },
    graded: d.graded || base.graded,
  }
}

/** 这题的得分选择器给哪些档位（**用户口径**：单选只给 0 和满分，其余题型给 0~满分的整数） */
function scoreOptions(q: ExamQuestion): number[] {
  const full = Number(q.fullScore) || 0
  if (full <= 0) return [0]
  if (q.kind === 'single') return [0, full]
  if (full <= 20) return Array.from({ length: full + 1 }, (_, i) => i)
  // 分值太大的题（作文 60 分）摆一整排按钮点不准，给关键档 + 手输
  return [...new Set([0, round2(full * 0.4), round2(full * 0.6), round2(full * 0.8), full])].sort(
    (a, b) => a - b,
  )
}

/* ============================================================
   一道题的录入行（题号沿竖列展开的那一行）
   ============================================================ */
function QRowEditor({
  q,
  mode,
  row,
  onAnswer,
  onScore,
}: {
  q: ExamQuestion
  mode: Exam['mode']
  row: Row
  onAnswer: (picked: string) => void
  onScore: (v: number) => void
}) {
  const full = Number(q.fullScore) || 0
  const choice = isChoiceKind(q.kind)
  const picked = String(row.answers[String(q.no)] ?? '')
  const score = scoreOf(q, mode, row)
  const verdict = choice ? gradeChoice(full, q.answer, picked) : null
  const nOpt = Math.max(4, (q.answer ?? '').length || 0, picked.length || 0)
  const options = OPTION_LETTERS.slice(0, Math.max(4, Math.min(OPTION_LETTERS.length, nOpt)))

  /** 记答题情况 + 选择题：点选项 */
  const byAnswer = choice && mode === 'answers'

  return (
    <div
      className="flex flex-col gap-2 p-2.5"
      style={{
        border: '1px solid var(--color-line)',
        background: score > 0 ? 'var(--color-surface)' : 'var(--color-surface2)',
        borderRadius: 4,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="num grid shrink-0 place-items-center"
          style={{
            width: 30,
            height: 30,
            borderRadius: 4,
            border: '1px solid var(--color-line2)',
            background: 'var(--color-surface)',
            fontSize: 13.5,
            fontWeight: 700,
          }}
        >
          {q.no}
        </span>
        <Tag tone="idle">{EXAM_KIND_TEXT[q.kind]}</Tag>
        {q.subCount && q.subCount > 1 ? (
          <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
            {q.subCount} 问
          </span>
        ) : null}
        <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
          满分 {full}
        </span>
        {choice && (q.answer || null) ? (
          <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
            答案 <b style={{ color: 'var(--color-ink2)' }}>{q.answer}</b>
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className="num"
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: score >= full && full > 0 ? 'var(--color-ok)' : score > 0 ? 'var(--color-ink)' : 'var(--color-ink4)',
          }}
        >
          {score}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>/ {full}</span>
      </div>

      {byAnswer ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {options.map((o) => {
            const on = picked.includes(o)
            const isKey = (q.answer ?? '').includes(o)
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                aria-label={`第 ${q.no} 题选 ${o}`}
                onClick={() => {
                  const set = new Set(picked.split(''))
                  if (set.has(o)) set.delete(o)
                  else set.add(o)
                  onAnswer([...set].sort().join(''))
                }}
                className="num grid place-items-center"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 700,
                  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                  background: on ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: on ? '***REMOVED***fff' : 'var(--color-ink2)',
                  position: 'relative',
                }}
              >
                {o}
                {/* 答案提示只用一个小点标出来 —— 不写字母，免得被当成"已经选了" */}
                {isKey ? (
                  <i
                    style={{
                      position: 'absolute',
                      bottom: 3,
                      width: 4,
                      height: 4,
                      borderRadius: 9,
                      background: on ? '***REMOVED***fff' : 'var(--color-ok)',
                    }}
                  />
                ) : null}
              </button>
            )
          })}
          <span className="flex-1" />
          {/* 默认全对要有，但**必须是人点出来的**（E1 的另一面：没点就是 0 分） */}
          {q.answer ? (
            <Button size="sm" variant="ghost" onClick={() => onAnswer(q.answer ?? '')}>
              全对
            </Button>
          ) : (
            <span style={{ fontSize: 11.5, color: 'var(--color-warn)' }}>
              <IconAlert size={12} /> 这题没设正确答案，可选但判不出分
            </span>
          )}
          <Button size="sm" variant="ghost" icon={<IconX size={13} />} onClick={() => onAnswer('')}>
            未作答
          </Button>
          {verdict && full > 0 && picked ? (
            <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
              选对 {verdict.hit}/{verdict.total}
              {verdict.total > 1 && q.kind === 'multiple' ? ' → 按比例给分' : ''}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {scoreOptions(q).map((v) => {
            const on = score === v
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                aria-label={`第 ${q.no} 题得 ${v} 分`}
                onClick={() => onScore(v)}
                className="num grid place-items-center"
                style={{
                  minWidth: 34,
                  height: 32,
                  padding: '0 7px',
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 700,
                  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                  background: on ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: on ? '***REMOVED***fff' : 'var(--color-ink2)',
                }}
              >
                {v}
              </button>
            )
          })}
          {full > 20 ? (
            <input
              className="input num"
              type="number"
              min={0}
              max={full}
              step={0.5}
              aria-label={`第 ${q.no} 题自定义得分`}
              placeholder="手输"
              style={{ width: 84, height: 32, fontSize: 12.5 }}
              value={score}
              onChange={(e) => onScore(Math.max(0, Math.min(full, Number(e.target.value) || 0)))}
            />
          ) : null}
          {full <= 0 ? (
            <span style={{ fontSize: 11.5, color: 'var(--color-warn)' }}>
              <IconAlert size={12} /> 这题没设满分，先在档案里补上
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ============================================================
   页面的外壳（照 `AssignmentGrade` 的写法：数据没就绪不挂载会话）
   ============================================================ */
export default function ExamGrade() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const hydrated = useStore((s) => s.hydrated)
  const exam = useStore((s) => s.exams.find((e) => e.id === id))

  if (!hydrated || !exam) {
    return (
      <>
        <PageHead title="考试批阅" onBack={() => navigate('/exams')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
              {hydrated ? '该考试档案可能已被删除' : '正在读取考试档案…'}
            </div>
          </Panel>
        </Page>
      </>
    )
  }
  /*
   * `key={id}` 保证换档案时整块重挂载：本地工作副本由 useState 惰性初始化，
   * 不需要在 effect 里 setState（§十「修改批改进去是全新界面」的教训）。
   */
  return <ExamGradeSession key={id} id={id} />
}

function ExamGradeSession({ id }: { id: string }) {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const exam = useStore((s) => s.exams.find((e) => e.id === id))
  const allScores = useStore((s) => s.examScores)
  const classes = useStore((s) => s.classes)
  const setExamScore = useStore((s) => s.setExamScore)
  const updateExam = useStore((s) => s.updateExam)
  const DRAFT_KEY = draftKey(id)

  /* 名单：这次考试勾的班里的在读学生（按学号排） */
  const students = useMemo(() => {
    const ids = exam?.classIds ?? []
    const out: Array<{ studentNo: string; name: string; classId: string; className: string }> = []
    for (const cid of ids) {
      const k = classes.find((c) => c.id === cid)
      if (!k) continue
      for (const s of k.students) {
        if (s.status !== 'active') continue
        out.push({ studentNo: s.studentNo, name: s.name, classId: k.id, className: k.name })
      }
    }
    return out.sort((a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name))
  }, [exam?.classIds, classes])

  const saved = useMemo(() => {
    const m = new Map<string, ExamScore>()
    for (const r of allScores) if (r.examId === id) m.set(r.studentNo, r)
    return m
  }, [allScores, id])

  const [draft, setDraft] = useState<GradeDraft | null>(() => loadDraft(DRAFT_KEY))
  /**
   * 展开中的学生（**其他学生暂时隐藏**）；null = 显示完整的待批改表。
   *
   * ⚠️ 「确认批阅」之后是**回到整张表**（`setOpen(null)`），
   *    不是"下一个待批学生自动顶上来" —— 用户后来专门更正过这一条。
   */
  const [open, setOpen] = useState<string | null>(null)
  const [step, setStep] = useState<'choose' | 'confirmZero'>('choose')
  const [finishOpen, setFinishOpen] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)

  const qs = useMemo(() => (exam ? questionsOf(exam) : []), [exam])
  const n = exam ? questionCountOf(exam) : 0
  const mode = exam?.mode ?? 'scores'

  /* 草稿恢复提示（与作业页同一句话：恢复的是"进度"，不是"结论"） */
  const [restored, setRestored] = useState(() => {
    const d = loadDraft(DRAFT_KEY)
    if (!d) return false
    const ids = Object.keys(d.rows ?? {})
    // 空壳草稿不提示（它什么都没恢复）
    return ids.some((k) => {
      const r = d.rows[k]
      return r.graded || Object.keys(r.scores ?? {}).length + Object.keys(r.answers ?? {}).length > 0
    })
  })
  useEffect(() => {
    if (restored) {
      const t = setTimeout(() => setRestored(false), 4000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [restored])

  const rowFor = (studentNo: string) => rowOf(saved, draft, studentNo)

  /** 边改边存：每次改动都写 localStorage（**正式落库在"确认批阅"**） */
  const patchRow = (studentNo: string, fn: (r: Row) => Row) => {
    setDraft((d) => {
      const rows = { ...(d?.rows ?? {}) }
      const next = fn(rows[studentNo] ?? { scores: {}, answers: {}, graded: false })
      rows[studentNo] = next
      const out: GradeDraft = { rows, at: Date.now() }
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(out))
      } catch {
        /* 存不下（隐私模式/配额满）也不能因此打断批阅 */
      }
      return out
    })
  }

  /**
   * 每题的已批人数（答案速查里显示，给老师一个"还剩多少"的直觉）。
   *
   * ⚠️ 这个 useMemo **必须在下面的 `if (!exam) return null` 之前** ——
   *    项目里已经因为"条件分支后面还调 Hook"踩过一次（lint 直接报 rules-of-hooks）。
   */
  const perQuestion = useMemo(() => {
    const out = new Map<number, number>()
    for (const q of qs) {
      out.set(q.no, students.filter((s) => rowOf(saved, draft, s.studentNo).graded).length)
    }
    return out
  }, [qs, students, saved, draft])

  if (!exam) return null

  const gradedSet = new Set(students.map((s) => s.studentNo).filter((no) => rowFor(no).graded))
  const todo = students.filter((s) => !gradedSet.has(s.studentNo) || open === s.studentNo)
  const done = students.filter((s) => gradedSet.has(s.studentNo) && open !== s.studentNo)

  const totalOfRowLocal = (no: string) => totalOf(exam, { ...rowFor(no) })
  const openStudent = open ? students.find((s) => s.studentNo === open) : null
  const openRow = open ? rowFor(open) : null
  const answeredCount = openRow
    ? qs.filter((q) =>
        isChoiceKind(q.kind) && mode === 'answers'
          ? String(openRow.answers[String(q.no)] ?? '') !== ''
          : openRow.scores[String(q.no)] !== undefined,
      ).length
    : 0

  /* ---------------- 确认批阅（一个学生） ---------------- */

  /**
   * 🔴 这是**唯一**把 `graded` 置 true 的地方（除了文件导入）。
   * 存的是**这个学生此时此刻的完整记录**：没过 0 分的题也要写进 `scores`，
   * 否则"没答"和"答了得 0 分"在数据上分不开 —— 虽然两者算分都是 0，
   * 但老师在统计页上要能看出"这道题他一个字没写"。
   */
  const confirmStudent = (studentNo: string) => {
    const s = students.find((x) => x.studentNo === studentNo)
    if (!s) return
    const r = rowFor(studentNo)
    /*
     * 没答的题也要写进去（值 0）：`scores` 里有这个键 = "老师看过这道题、他这题没得分"，
     * 没有这个键 = "还没录"。虽然两者算分都是 0，但老师在统计页上要能分辨。
     * 记答题情况模式下选择题不给 0 分键 —— 它的答案是 `answers` 里的选项串（空 = 未作答）。
     */
    const scores: Record<string, number> = {}
    const answers: Record<string, string> = {}
    for (const q of qs) {
      if (isChoiceKind(q.kind) && exam.mode === 'answers') {
        const a = String(r.answers[String(q.no)] ?? '')
        if (a) answers[String(q.no)] = a
        continue
      }
      scores[String(q.no)] = scoreOf(q, exam.mode, r)
    }
    const merged: Row = { scores, answers, graded: true }
    const objsub = objectiveSubjective(exam, merged)
    setExamScore(id, {
      studentNo,
      classId: s.classId,
      name: s.name,
      scores,
      answers,
      graded: true,
      absent: exam.absentNos.includes(studentNo),
      total: totalOf(exam, merged),
      objective: objsub.objective,
      subjective: objsub.subjective,
    })
    patchRow(studentNo, () => merged)
    /*
     * ⚠️ **确认批阅之后回到整张表**（用户后来专门更正过这一条）：
     *    不是"下一个待批学生顶上来"。所以这里只关掉展开态。
     */
    setOpen(null)
    push({ text: `${s.name} 已批阅 · ${totalOf(exam, merged)} 分`, tone: 'ok' })
  }

  /** 撤销「已批阅」：**保留分数**，只把它退回待批改（老师常常只是点错了） */
  const reopen = (studentNo: string) => {
    const s = students.find((x) => x.studentNo === studentNo)
    if (!s) return
    const r = rowFor(studentNo)
    setExamScore(id, {
      studentNo,
      classId: s.classId,
      name: s.name,
      scores: r.scores,
      answers: r.answers,
      graded: false,
    })
    patchRow(studentNo, (cur) => ({ ...cur, graded: false }))
    push({ text: `${s.name} 已退回待批改（分数还在）`, tone: 'warn' })
  }

  /* ---------------- 右上角「批阅完成」 ---------------- */

  const ungradedNos = students.filter((s) => !rowFor(s.studentNo).graded).map((s) => s.studentNo)
  const gradedCount = students.length - ungradedNos.length

  /** 临时保存：把进度写回档案，**不改 status**（点档案进来接着批） */
  const saveDraft = () => {
    const rows: ExamScore[] = students.map((s) => {
      const r = rowFor(s.studentNo)
      const merged: Row = { scores: r.scores, answers: r.answers, graded: r.graded }
      const objsub = objectiveSubjective(exam, merged)
      return {
        id: `pending-${id}-${s.studentNo}`,
        examId: id,
        classId: s.classId,
        studentNo: s.studentNo,
        name: s.name,
        scores: r.scores,
        answers: r.answers,
        graded: r.graded,
        absent: exam.absentNos.includes(s.studentNo),
        total: totalOf(exam, merged),
        objective: objsub.objective,
        subjective: objsub.subjective,
        createdAt: Date.now(),
      }
    })
    /*
     * 逐人写：`setExamScore` 是**唯一**的成绩写入口，它自己会算 id / 合并旧值。
     * 已确认过的人写 graded=true，没确认的写 graded=false（**不算批阅**）。
     */
    for (const r of rows) {
      setExamScore(id, {
        studentNo: r.studentNo,
        classId: r.classId,
        name: r.name,
        scores: r.scores,
        answers: r.answers,
        graded: r.graded,
        absent: r.absent,
        total: r.total,
        objective: r.objective,
        subjective: r.subjective,
      })
    }
    push({
      text: '已临时保存，之后可以接着批',
      tone: 'ok',
      desc: `已批 ${gradedCount}/${students.length} 人`,
    })
    setFinishOpen(false)
    navigate('/exams')
  }

  /**
   * 确认完成。
   *
   * 🔴 **没改过的学生每题按 0 分算**（用户口径，照做）——
   *    但**完成前必须弹窗让老师确认**（用户口径，照做）。
   *    这里的"没改过" = `graded !== true`，也就是**没点过「确认批阅」**的人。
   */
  const finish = () => {
    const rows: ExamScore[] = students.map((s) => {
      const r = rowFor(s.studentNo)
      const zero = !r.graded
      const merged: Row = zero ? { scores: {}, answers: {}, graded: true } : r
      const objsub = objectiveSubjective(exam, merged)
      return {
        id: `pending-${id}-${s.studentNo}`,
        examId: id,
        classId: s.classId,
        studentNo: s.studentNo,
        name: s.name,
        scores: merged.scores,
        answers: merged.answers,
        graded: true,
        absent: exam.absentNos.includes(s.studentNo),
        total: totalOf(exam, merged),
        objective: objsub.objective,
        subjective: objsub.subjective,
        createdAt: Date.now(),
      }
    })
    for (const r of rows) {
      setExamScore(id, {
        studentNo: r.studentNo,
        classId: r.classId,
        name: r.name,
        scores: r.scores,
        answers: r.answers,
        graded: true,
        absent: r.absent,
        total: r.total,
        objective: r.objective,
        subjective: r.subjective,
      })
    }
    updateExam(id, { status: 'graded', gradedAt: Date.now() })
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {
      /* 忽略 */
    }
    push({
      text: '批阅已完成',
      tone: 'ok',
      desc: ungradedNos.length ? `${ungradedNos.length} 位没改过的同学按 0 分计` : '全班都批过了',
    })
    setFinishOpen(false)
    navigate(`/exams/${id}/stats`)
  }

  return (
    <>
      <PageHead
        title="考试批阅"
        sub={`${exam.title} · ${n} 题 · ${students.length} 人 · ${EXAM_MODE_TEXT[exam.mode]}`}
        onBack={() => navigate('/exams')}
        right={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<IconList size={14} />} onClick={() => setKeyOpen(true)}>
              答案
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<IconCheck size={14} />}
              onClick={() => {
                setStep('choose')
                setFinishOpen(true)
              }}
            >
              批阅完成
            </Button>
          </div>
        }
      />

      <Page>
        {restored ? (
          <Panel className="mb-3" bodyClass="p-3">
            <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
              <IconRefresh size={14} />
              已恢复上次没批完的进度（存在本机，换设备看不到）
            </div>
          </Panel>
        ) : null}

        {exam.absentNos.length ? (
          <Panel className="mb-3" bodyClass="p-3">
            <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <IconInfo size={13} /> 缺考 {exam.absentNos.length} 人（
              {exam.absentNos.join('、')}）—— 他们不参与均分，也不会被"按 0 分"处理。
            </div>
          </Panel>
        ) : null}

        <Panel className="mb-4" bodyClass="p-0">
          <StatStrip
            items={[
              { k: '应交', v: <span className="num">{students.length}</span> },
              { k: '已批阅', v: <span className="num">{gradedCount}</span>, tone: 'var(--color-ok)' },
              {
                k: '没改过（按 0 分）',
                v: <span className="num">{ungradedNos.length}</span>,
                tone: ungradedNos.length ? 'var(--color-warn)' : undefined,
              },
              { k: '卷面', v: <span className="num">{qs.reduce((s, q) => s + (q.fullScore || 0), 0)}</span> },
            ]}
          />
        </Panel>

        {/* ---------------- 展开的这一个学生（其他学生暂时隐藏） ---------------- */}
        {openStudent && openRow ? (
          <Panel className="mb-4" bodyClass="p-0">
            <div
              className="flex flex-wrap items-center gap-2 p-3"
              style={{ borderBottom: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
            >
              <span className="num" style={{ fontSize: 18, fontWeight: 750 }}>
                {openStudent.studentNo}
              </span>
              <span style={{ fontSize: 15, fontWeight: 650 }}>{openStudent.name}</span>
              {openStudent.className ? (
                <Tag tone="idle">{openStudent.className}</Tag>
              ) : null}
              <span className="flex-1" />
              <span className="num" style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
                已录 {answeredCount}/{n} 题 · 合计 {totalOfRowLocal(openStudent.studentNo)}
              </span>
            </div>

            {/* 题号沿**竖列**展开 */}
            <div className="flex flex-col gap-2 p-3">
              {qs.map((q) => (
                <QRowEditor
                  key={q.no}
                  q={q ?? EMPTY_Q}
                  mode={mode}
                  row={openRow}
                  onAnswer={(picked) =>
                    patchRow(openStudent.studentNo, (r) => ({
                      ...r,
                      answers: { ...r.answers, [String(q.no)]: picked },
                    }))
                  }
                  onScore={(v) =>
                    patchRow(openStudent.studentNo, (r) => ({
                      ...r,
                      scores: { ...r.scores, [String(q.no)]: v },
                    }))
                  }
                />
              ))}
            </div>

            {/* 右下角：确认批阅 / 退出 */}
            <div
              className="flex items-center gap-2 p-3"
              style={{ borderTop: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
            >
              <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                退出（不算批阅）
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="primary"
                icon={<IconChevronRight size={14} />}
                onClick={() => confirmStudent(openStudent.studentNo)}
              >
                确认批阅
              </Button>
            </div>
          </Panel>
        ) : null}

        {/* ---------------- 待批改（展开某个人时**整张表隐藏**——用户口径） ---------------- */}
        {!open ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Sect>待批改 · {todo.length} 人</Sect>
            </div>
            {todo.length === 0 ? (
              <Panel bodyClass="p-5 text-center">
                <div style={{ fontSize: 13.5, color: 'var(--color-ink3)' }}>
                  全班都批过了 —— 点右上角「批阅完成」把结果定下来
                </div>
              </Panel>
            ) : (
              <div className="flex flex-col gap-2">
                {todo.map((s) => {
                  const r = rowFor(s.studentNo)
                  const touched =
                    Object.keys(r.scores).length + Object.keys(r.answers).length > 0
                  return (
                    <Panel key={s.studentNo} className="overflow-hidden">
                      <button
                        type="button"
                        className="row"
                        style={{ padding: 12 }}
                        aria-label={`${s.studentNo} 号 ${s.name}`}
                        onClick={() => setOpen(s.studentNo)}
                      >
                        <span className="num" style={{ fontSize: 16, fontWeight: 700, width: 44 }}>
                          {s.studentNo}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate" style={{ fontSize: 14.5, fontWeight: 620 }}>
                            {s.name}
                          </span>
                          <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                            {touched ? (
                              <>
                                已录 {Object.keys(r.scores).length + Object.keys(r.answers).length} 处 ·
                                合计 {totalOfRowLocal(s.studentNo)} 分（还没确认）
                              </>
                            ) : (
                              '还没开始'
                            )}
                          </span>
                        </span>
                        <IconChevronRight size={16} />
                      </button>
                    </Panel>
                  )
                })}
              </div>
            )}
          </>
        ) : null}

        {/* ---------------- 已批阅 ---------------- */}
        {done.length ? (
          <div className="mt-5">
            <Sect>已批阅 · {done.length} 人</Sect>
            <Panel bodyClass="p-0">
              <div className="flex flex-col">
                {done.map((s) => {
                  const r = rowFor(s.studentNo)
                  return (
                    <div
                      key={s.studentNo}
                      className="flex items-center gap-2 px-3 py-2"
                      style={{ borderBottom: '1px solid var(--color-line)' }}
                    >
                      <span className="num" style={{ fontSize: 13, color: 'var(--color-ink3)', width: 44 }}>
                        {s.studentNo}
                      </span>
                      <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                        {s.name}
                      </span>
                      <span className="num" style={{ fontSize: 14, fontWeight: 700 }}>
                        {totalOfRowLocal(s.studentNo)}
                      </span>
                      <button
                        type="button"
                        onClick={() => reopen(s.studentNo)}
                        style={{ fontSize: 11.5, color: 'var(--color-ink3)', padding: '2px 6px' }}
                      >
                        改
                      </button>
                      <button
                        type="button"
                        aria-label={`${s.name} 重新批阅`}
                        onClick={() => setOpen(s.studentNo)}
                        style={{ fontSize: 11.5, color: 'var(--color-accentink)', padding: '2px 6px' }}
                      >
                        重批
                      </button>
                      {r.answers && Object.keys(r.answers).length ? (
                        <span style={{ fontSize: 11, color: 'var(--color-ink4)' }}>含选项</span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </Panel>
          </div>
        ) : null}

        <p style={{ fontSize: 11.5, color: 'var(--color-ink4)', marginTop: 14, lineHeight: 1.7 }}>
          点一个学生 → 只显示他 → 每题录分/选选项 → 右下角「确认批阅」→ 他落到下面的「已批阅」。
          <br />
          改动会**立刻存在本机**；「批阅完成 → 临时保存」会把进度写回档案，下次点档案接着批。
        </p>
      </Page>

      {/* ---------------- 批阅完成：两条路 ---------------- */}
      <Sheet
        open={finishOpen}
        onClose={() => setFinishOpen(false)}
        title={step === 'choose' ? '批阅完成' : '确认完成前请看一眼'}
        footer={
          step === 'choose' ? (
            <div className="flex gap-2">
              <Button block onClick={saveDraft}>
                临时保存
              </Button>
              <Button block variant="primary" onClick={() => setStep('confirmZero')}>
                确认完成
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button block onClick={() => setStep('choose')}>
                再改改
              </Button>
              <Button block variant="danger" onClick={finish}>
                确认完成
              </Button>
            </div>
          )
        }
      >
        {step === 'choose' ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.8, color: 'var(--color-ink2)' }}>
            <p>
              已经确认批阅 <b className="num">{gradedCount}</b> / {students.length} 人。
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <div className="p-2.5" style={{ border: '1px solid var(--color-line2)', borderRadius: 4 }}>
                <b>临时保存</b>
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', marginTop: 2, lineHeight: 1.7 }}>
                  把现在的进度写回档案，<b>状态仍是"批阅中"</b>。之后从考试列表点进来接着批。
                </div>
              </div>
              <div className="p-2.5" style={{ border: '1px solid var(--color-line2)', borderRadius: 4 }}>
                <b>确认完成</b>
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', marginTop: 2, lineHeight: 1.7 }}>
                  定稿，档案变成"已完成"，点进去看到的是<b>数据统计</b>。
                  还没确认批阅的同学会被<b>按 0 分计</b>（这是考试与作业相反的默认值）。
                  <b>确认前会再问你一次。</b>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13.5, lineHeight: 1.8 }}>
            <div className="flex items-start gap-2" style={{ color: 'var(--color-warn)' }}>
              <IconAlert size={16} />
              <span>
                还有 <b className="num">{ungradedNos.length}</b> 位同学<b>没点过「确认批阅」</b>
                ，他们这次<b>每一题都按 0 分算</b>，会参与均分与排名。
              </span>
            </div>
            {ungradedNos.length ? (
              <div
                className="mt-3 p-2.5"
                style={{ background: 'var(--color-warnsoft)', borderRadius: 4, fontSize: 12.5, lineHeight: 1.8 }}
              >
                {ungradedNos
                  .map((no) => {
                    const s = students.find((x) => x.studentNo === no)
                    return `${no} ${s?.name ?? ''}`
                  })
                  .join('、')}
              </div>
            ) : (
              <p style={{ marginTop: 12, color: 'var(--color-ok)' }}>
                全班都确认过了，这里没有会被清零的同学。
              </p>
            )}
            <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 12, lineHeight: 1.7 }}>
              如果这不是你要的：点「再改改」回去把剩下的批完，或者点「临时保存」先存着。
            </p>
          </div>
        )}
      </Sheet>

      {/* ---------------- 答案速查（批阅时最需要的那张表） ---------------- */}
      <Sheet
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        title="参考答案与分值"
        footer={
          <Button block onClick={() => setKeyOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col gap-1.5">
          {qs.map((q) => (
            <div
              key={q.no}
              className="flex items-center gap-3 px-2.5 py-2"
              style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}
            >
              <span className="num" style={{ fontSize: 13.5, fontWeight: 700, width: 28 }}>
                {q.no}
              </span>
              <Tag tone="idle">{EXAM_KIND_TEXT[q.kind]}</Tag>
              <span className="num" style={{ fontSize: 12.5 }}>
                {q.fullScore} 分
              </span>
              <span className="flex-1" />
              {isChoiceKind(q.kind) ? (
                <span className="num" style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-ok)' }}>
                  {q.answer || '未设'}
                </span>
              ) : (
                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>主观题</span>
              )}
              <span className="num" style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
                已批 {perQuestion.get(q.no) ?? 0}
              </span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 12, lineHeight: 1.7 }}>
          多选题的判分规则：正确答案有 <b>n</b> 个选项、学生选对了 <b>m</b> 个 →
          得 <b>m/n × 满分</b>（例：答案 AC、选 A → 满分 5 分记 2.5）。
          {exam.mode === 'answers' ? '' : ' 这份档案是「记录分值」模式，选择题也是直接记分。'}
        </p>
      </Sheet>
    </>
  )
}
