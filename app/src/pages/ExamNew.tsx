import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGrid,
  IconInfo,
  IconList,
  IconUpload,
  IconUsers,
  IconZap,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { EXAM_STATUS_TEXT, type ExamMode, type ExamScope, type ExamSource } from '../data/examTypes'
import { CONFIDENCE_TEXT, EXAM_PRESETS, expandPreset, presetOf, presetTotal } from '../data/examPresets'
import {
  EXAM_KIND_TEXT,
  checkPaper,
  findSameExam,
  isChoiceKind,
  normalizePaperName,
} from '../lib/examPaper'
import type { ExamQuestionKind } from '../lib/examPaperTypes'
import { ymdOf, beijingNow } from '../lib/holiday'
import { SUBJECTS, subjectName, teacherPrimarySubjectCode } from '../lib/subjects'
import type { ExamQuestion } from '../data/examTypes'

/* ============================================================
   新建考试档案
   ------------------------------------------------------------
   流程（用户口径）：
     第 1 步 考试类型 —— 年级考试 / 班级考试
     第 2 步 数据来源 —— 平台文件导入 / 手动批阅
     第 3 步 试卷结构 —— 题量 + 每题题型 + 每题分值（可以批量选）
     第 4 步 记录模式 —— 记录答题情况 / 记录分值
     第 5 步 班级与日期 —— 班级考试的班级可以在自己的教学班里**多选**

   🔴 与作业的对照（别把两者统一）：
     作业：学科预选好、题量填一个数就行，**新增手工录入字段数 = 0**；
     考试：**建档是一次性的**，允许有自己的必填项 —— 但"能预填的必须预填"，
     所以题型/分值有一键套用（`data/examPresets.ts` 的四川新高考清单），
     而且套用之后每一项都能改（那份清单还等着老师确认）。
   ============================================================ */

/** 题库里的一道题的可编辑行 */
type QRow = {
  no: number
  kind: ExamQuestionKind
  fullScore: string
  answer: string
}

function rowsFromQuestions(
  questions: Record<number, { fullScore: number; answer?: string; kind: ExamQuestionKind }>,
  count: number,
): QRow[] {
  const out: QRow[] = []
  for (let i = 1; i <= count; i++) {
    const q = questions[i]
    out.push({
      no: i,
      kind: q?.kind ?? 'other',
      fullScore: q?.fullScore ? String(q.fullScore) : '',
      answer: q?.answer ?? '',
    })
  }
  return out
}

/** 铺出 count 道空题（题型待定、分值空着 —— **不替老师猜一个数**） */
function blankRows(count: number): QRow[] {
  return Array.from({ length: count }, (_, i) => ({
    no: i + 1,
    kind: 'other' as ExamQuestionKind,
    fullScore: '',
    answer: '',
  }))
}

const FIRST_COUNT = 10

export default function ExamNew() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const teacher = useStore((s) => s.teacher)
  const exams = useStore((s) => s.exams)
  const addExam = useStore((s) => s.addExam)
  const examTables = useStore((s) => s.examTables)

  /* ---------- 第 1 步：类型 ---------- */
  const [scope, setScope] = useState<ExamScope>('class')

  /* ---------- 第 2 步：数据来源 ---------- */
  const [source, setSource] = useState<ExamSource>('manual')

  /* ---------- 基本信息 ---------- */
  const [title, setTitle] = useState('')
  const [subjectCode, setSubjectCode] = useState(() => teacherPrimarySubjectCode(teacher))
  const [examDate, setExamDate] = useState(() => ymdOf(beijingNow()))

  /* ---------- 第 3 步：结构 ---------- */
  const [questionCount, setQuestionCount] = useState(String(FIRST_COUNT))
  const [rows, setRows] = useState<QRow[]>(() => blankRows(FIRST_COUNT))
  /** 批量选中的题号 */
  const [picked, setPicked] = useState<number[]>([])
  const [bulkKind, setBulkKind] = useState<ExamQuestionKind>('single')
  const [bulkScore, setBulkScore] = useState('')

  /* ---------- 第 4 步：模式 ---------- */
  const [mode, setMode] = useState<ExamMode>('scores')

  /* ---------- 第 5 步：班级 ---------- */
  const [classIds, setClassIds] = useState<string[]>(() =>
    currentClassId ? [currentClassId] : classes[0] ? [classes[0].id] : [],
  )
  const [absentText, setAbsentText] = useState('')
  const [presetOpen, setPresetOpen] = useState(false)

  const n = Math.max(1, Math.min(60, Number(questionCount) || 0))
  /** 班级考试只允许一个班 —— 它是"本班的小型考试"，多选了就没法算班级排名 */
  const chosen = scope === 'class' ? classIds.slice(0, 1) : classIds
  const grade = classes.find((c) => c.id === chosen[0])?.grade ?? ''

  /** 结构：行数组 → questions（**唯一来源是 rows**，questionCount 只是它的长度上限） */
  const questions = useMemo(() => {
    const out: Record<string, ExamQuestion> = {}
    for (const r of rows) {
      if (r.no > n) continue
      out[String(r.no)] = {
        no: r.no,
        kind: r.kind,
        fullScore: Number(r.fullScore) || 0,
        answer: isChoiceKind(r.kind) ? r.answer.trim().toUpperCase() : undefined,
      }
    }
    return out
  }, [rows, n])

  /**
   * 改了题量就把行数组补齐/截断。
   * ⚠️ **不要在渲染里顺手 setState**：那会让"上一次渲染的 rows"参与判定，
   *    改题量时容易把刚填的分值丢掉。所有对 rows 的修改都走这里 / patchRow。
   */
  const setCount = (v: string) => {
    setQuestionCount(v)
    const n2 = Number(v)
    if (!Number.isFinite(n2) || n2 < 1) return // 输入框清空时不急着改结构，等老师填回来
    const want = Math.max(1, Math.min(60, Math.floor(n2)))
    setRows((prev) => {
      if (prev.length === want) return prev
      if (prev.length > want) return prev.slice(0, want)
      const next = [...prev]
      for (let i = prev.length + 1; i <= want; i++) {
        next.push({ no: i, kind: 'other', fullScore: '', answer: '' })
      }
      return next
    })
  }

  const patchRow = (no: number, patch: Partial<QRow>) =>
    setRows((prev) => prev.map((r) => (r.no === no ? { ...r, ...patch } : r)))

  /** 批量套用题型/分值到选中题（用户口径：题型可以批量选） */
  const applyBulk = () => {
    if (!picked.length) {
      push({ text: '先点题号选中要批量设置的题', tone: 'warn' })
      return
    }
    const score = Number(bulkScore)
    setRows((prev) =>
      prev.map((r) =>
        picked.includes(r.no)
          ? {
              ...r,
              kind: bulkKind,
              fullScore: bulkScore.trim() === '' ? r.fullScore : String(score || ''),
              // 换成非选择题就把答案清掉 —— 留着会让"这题到底记不记选项"变成两个来源
              answer: isChoiceKind(bulkKind) ? r.answer : '',
            }
          : r,
      ),
    )
    push({ text: `已把 ${picked.length} 道题设为「${EXAM_KIND_TEXT[bulkKind]}」`, tone: 'ok' })
  }

  /** 一键套用四川新高考题型清单 */
  const applyPreset = (code: string) => {
    const p = presetOf(code)
    if (!p) {
      push({ text: `${subjectName(code)}还没有待选清单，请手工设题型`, tone: 'warn' })
      return
    }
    const ex = expandPreset(p)
    setQuestionCount(String(ex.questionCount))
    setRows(rowsFromQuestions(ex.questions, ex.questionCount))
    setPicked([])
    setPresetOpen(false)
    push({
      text: `已套用 ${p.subjectName} 的题型清单（${ex.questionCount} 题 / ${presetTotal(p)} 分）`,
      tone: 'ok',
      desc:
        p.confidence === 'confirmed'
          ? '各题分值已按 2025 年真卷核实，仍可逐题修改'
          : '部分分值是按常规推断的，**请对着卷子核一遍**',
    })
  }

  /** 同场考试：按试卷名归一化找已有的（用户口径：名字一样就是同一场） */
  const sameOnes = useMemo(
    () =>
      title.trim()
        ? findSameExam(exams, { title: title.trim(), subjectCode, examDate }).slice(0, 4)
        : [],
    [exams, title, subjectCode, examDate],
  )

  const integrity = checkPaper({ questionCount: n, questions })
  const paperTotal = Object.values(questions).reduce((s, q) => s + (q.fullScore || 0), 0)
  const choiceCount = Object.values(questions).filter((q) => isChoiceKind(q.kind)).length

  const canCreate = Boolean(title.trim()) && chosen.length > 0 && n >= 1

  const create = async () => {
    if (!canCreate) return
    const absentNos = absentText
      .split(/[\s,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const res = await addExam({
      title: title.trim(),
      subjectCode,
      scope,
      source,
      mode,
      examDate,
      questionCount: n,
      questions,
      classIds: chosen,
      grade,
      absentNos,
    })
    if (!res.saved) {
      // 表还没建：**如实说**，不假装建好了（见 schema.sql §15.6）
      push({
        text: '档案没能保存到云端',
        tone: 'bad',
        desc: res.reason ?? '请稍后再试',
      })
      return
    }
    push({ text: '考试档案已建立', tone: 'ok', desc: `${subjectName(subjectCode)} · ${n} 题` })
    navigate(`/exams/${res.id}/grade`)
  }

  return (
    <>
      <PageHead
        title="新建考试档案"
        sub="先确认考试类型与数据来源，再设题型分值"
        onBack={() => navigate('/exams')}
      />

      <Page>
        {classes.length === 0 ? (
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
              还没有班级，请先到「班级」里建立班级并录入学生名单。
            </div>
            <Button className="mt-3" size="sm" variant="primary" onClick={() => navigate('/classes')}>
              去建立班级
            </Button>
          </Panel>
        ) : (
          <>
            {examTables === 'missing' ? (
              <Panel className="mb-3" bodyClass="p-3">
                <div className="flex items-start gap-2" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                  <IconAlert size={15} />
                  <span>
                    线上数据库还没有考试相关的表，现在建的档案**存不进云端**。
                    请先到 Supabase → SQL Editor 跑 <b>supabase/schema.sql 第 15 段</b>。
                  </span>
                </div>
              </Panel>
            ) : null}

            {/* ---------- 第 1 步 · 考试类型 ---------- */}
            <div className="mb-4">
              <Sect>第 1 步 · 考试类型</Sect>
              <Panel bodyClass="p-3">
                <div className="flex gap-2">
                  {(
                    [
                      ['grade', '年级考试', '同一个年级一起考，按试卷名把各班的数据合起来排年级排名'],
                      ['class', '班级考试', '只有本班的小型考试，只记在本班，不算年级排名'],
                    ] as const
                  ).map(([k, label, desc]) => {
                    const on = scope === k
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setScope(k)}
                        className="flex-1 p-2.5 text-left"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                        }}
                      >
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13.5,
                            fontWeight: on ? 680 : 550,
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                          }}
                        >
                          {label}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--color-ink3)',
                            lineHeight: 1.5,
                            marginTop: 2,
                          }}
                        >
                          {desc}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </Panel>
            </div>

            {/* ---------- 第 2 步 · 数据来源 ---------- */}
            <div className="mb-4">
              <Sect>第 2 步 · 数据来源</Sect>
              <Panel bodyClass="p-3">
                <div className="flex gap-2">
                  {(
                    [
                      ['file', '平台文件导入', '新教育导出的成绩单，自动认出试卷名，选个日期就能建'],
                      ['manual', '手动批阅', '自己在平台上逐题录分（下面第 3、4 步就是为它准备的）'],
                    ] as const
                  ).map(([k, label, desc]) => {
                    const on = source === k
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setSource(k)}
                        className="flex-1 p-2.5 text-left"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                        }}
                      >
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 13.5,
                            fontWeight: on ? 680 : 550,
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                          }}
                        >
                          {k === 'file' ? <IconUpload size={14} /> : <IconZap size={14} />}
                          {label}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--color-ink3)',
                            lineHeight: 1.5,
                            marginTop: 2,
                          }}
                        >
                          {desc}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {source === 'file' ? (
                  <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                    文件导入的入口在<b>考试列表页右上角</b>：选中文件后会自动认出试卷名、题量、每题分值与答案，
                    并列出未交名单让你核对，确认之后才建档。
                    <br />
                    这里也照样把第 3~5 步填好 —— 导入时会用它们兜住文件里认不出来的部分（比如非选择题的题型）。
                  </p>
                ) : null}
              </Panel>
            </div>

            {/* ---------- 基本信息 ---------- */}
            <div className="mb-4">
              <Sect>试卷名称 · 学科 · 日期</Sect>
              <Panel bodyClass="p-4">
                <label className="block">
                  <span className="label">试卷名称</span>
                  <input
                    className="input"
                    placeholder="例如 物理练习8 / 高二上期期中考试"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                  <IconInfo size={12} /> 年级考试<b>按试卷名认同一场考试</b>：
                  空格不一样、数字写成「八」、少了标点都算同一场
                  （{normalizePaperName(title) ? `归一化后 =「${normalizePaperName(title)}」` : '填了名字这里会显示归一化结果'}）。
                </p>

                {sameOnes.length ? (
                  <div
                    className="mt-3 p-2.5"
                    style={{
                      border: '1px solid var(--color-accent)',
                      background: 'var(--color-accentsoft)',
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--color-accentink)' }}>
                      已找到 {sameOnes.length} 份**同一场考试**的档案（年级排名会合起来算）
                    </div>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {sameOnes.map(({ exam, verdict }) => (
                        <div key={exam.id} style={{ fontSize: 11.5, color: 'var(--color-ink2)', lineHeight: 1.6 }}>
                          · {exam.title}（
                          {exam.classIds
                            .map((id) => classes.find((c) => c.id === id)?.name ?? '未知班级')
                            .join('、')}
                          ）· {exam.examDate} ·{' '}
                          {EXAM_STATUS_TEXT[exam.status]}
                          <br />
                          <span style={{ color: 'var(--color-ink3)' }}>判定理由：{verdict.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-4">
                  <span className="label">学科</span>
                  <div className="flex flex-wrap gap-1.5">
                    {SUBJECTS.map((s) => {
                      const on = subjectCode === s.code
                      return (
                        <button
                          key={s.code}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setSubjectCode(s.code)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 4,
                            fontSize: 12.5,
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                            fontWeight: on ? 650 : 500,
                          }}
                        >
                          {s.name}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <label className="mt-4 block">
                  <span className="label">考试日期</span>
                  <input
                    className="input"
                    type="date"
                    value={examDate}
                    onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setExamDate(e.target.value)}
                  />
                </label>
              </Panel>
            </div>

            {/* ---------- 第 3 步 · 试卷结构 ---------- */}
            <div className="mb-4">
              <Sect>第 3 步 · 试卷结构（题量 / 题型 / 分值）</Sect>
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label>
                    <span className="label">题目数量</span>
                    <input
                      className="input num"
                      type="number"
                      min={1}
                      max={60}
                      style={{ width: 90 }}
                      value={questionCount}
                      onChange={(e) => setCount(e.target.value)}
                    />
                  </label>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconList size={14} />}
                    onClick={() => setPresetOpen(true)}
                  >
                    套用题型清单
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconCheck size={14} />}
                    onClick={() => setPicked(rows.filter((r) => r.no <= n).map((r) => r.no))}
                  >
                    全选
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
                    清空选择
                  </Button>
                </div>

                {/* 批量设置 */}
                {picked.length ? (
                  <div
                    className="mt-3 p-2.5"
                    style={{
                      border: '1px solid var(--color-accent)',
                      background: 'var(--color-accentsoft)',
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--color-accentink)' }}>
                      已选 {picked.length} 题 · 批量设为
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {(
                        [
                          'single',
                          'multiple',
                          'judge',
                          'blank',
                          'experiment',
                          'calc',
                          'reading',
                          'essay',
                          'listen',
                          'translation',
                          'other',
                        ] as ExamQuestionKind[]
                      ).map((k) => (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={bulkKind === k}
                          onClick={() => setBulkKind(k)}
                          style={{
                            padding: '3px 9px',
                            borderRadius: 4,
                            fontSize: 12,
                            border: `1px solid ${bulkKind === k ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: bulkKind === k ? 'var(--color-surface)' : 'transparent',
                            color: 'var(--color-ink2)',
                            fontWeight: bulkKind === k ? 650 : 500,
                          }}
                        >
                          {EXAM_KIND_TEXT[k]}
                        </button>
                      ))}
                      <input
                        className="input num"
                        type="number"
                        min={1}
                        max={100}
                        placeholder="每题分值"
                        style={{ width: 100, height: 30, fontSize: 12.5 }}
                        value={bulkScore}
                        onChange={(e) => setBulkScore(e.target.value)}
                      />
                      <Button size="sm" variant="primary" onClick={applyBulk}>
                        套用
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* 逐题表 */}
                <div className="mt-3 flex flex-col gap-1.5">
                  {rows
                    .filter((r) => r.no <= n)
                    .map((r) => {
                      const on = picked.includes(r.no)
                      return (
                        <div
                          key={r.no}
                          className="flex flex-wrap items-center gap-2 px-2 py-1.5"
                          style={{
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line)'}`,
                            background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            borderRadius: 4,
                          }}
                        >
                          <button
                            type="button"
                            aria-label={`第 ${r.no} 题`}
                            aria-pressed={on}
                            onClick={() =>
                              setPicked((p) => (p.includes(r.no) ? p.filter((x) => x !== r.no) : [...p, r.no]))
                            }
                            className="num grid shrink-0 place-items-center"
                            style={{
                              width: 26,
                              height: 26,
                              borderRadius: 3,
                              border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                              background: on ? 'var(--color-accent)' : 'var(--color-surface2)',
                              color: on ? '***REMOVED***fff' : 'var(--color-ink2)',
                              fontSize: 12,
                              fontWeight: 700,
                            }}
                          >
                            {r.no}
                          </button>
                          <select
                            className="input"
                            aria-label={`第 ${r.no} 题题型`}
                            style={{ width: 'auto', height: 30, fontSize: 12.5 }}
                            value={r.kind}
                            onChange={(e) =>
                              patchRow(r.no, {
                                kind: e.target.value as ExamQuestionKind,
                                answer: isChoiceKind(e.target.value) ? r.answer : '',
                              })
                            }
                          >
                            {(Object.keys(EXAM_KIND_TEXT) as ExamQuestionKind[]).map((k) => (
                              <option key={k} value={k}>
                                {EXAM_KIND_TEXT[k]}
                              </option>
                            ))}
                          </select>
                          <input
                            className="input num"
                            type="number"
                            min={0}
                            max={100}
                            aria-label={`第 ${r.no} 题分值`}
                            placeholder="分值"
                            style={{ width: 72, height: 30, fontSize: 12.5 }}
                            value={r.fullScore}
                            onChange={(e) => patchRow(r.no, { fullScore: e.target.value })}
                          />
                          {isChoiceKind(r.kind) ? (
                            <input
                              className="input"
                              aria-label={`第 ${r.no} 题正确答案`}
                              placeholder="正确答案，如 AC"
                              style={{ width: 130, height: 30, fontSize: 12.5 }}
                              value={r.answer}
                              onChange={(e) =>
                                patchRow(r.no, { answer: e.target.value.toUpperCase().replace(/[^A-H]/g, '') })
                              }
                            />
                          ) : (
                            <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>记分值</span>
                          )}
                        </div>
                      )
                    })}
                </div>

                <div
                  className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1"
                  style={{ fontSize: 12, color: 'var(--color-ink3)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <IconGrid size={13} />
                    <span className="num">{n}</span> 题 · 卷面 <span className="num">{paperTotal}</span> 分
                  </span>
                  <span className="flex items-center gap-1.5">
                    <IconList size={13} />
                    选择题 <span className="num">{choiceCount}</span> 题
                  </span>
                </div>

                {!integrity.ok ? (
                  <div className="mt-2 flex flex-col gap-1" style={{ fontSize: 11.5, lineHeight: 1.65 }}>
                    {integrity.missingScore.length ? (
                      <span style={{ color: 'var(--color-warn)' }}>
                        <IconAlert size={12} /> 第 {integrity.missingScore.join('、')} 题还没填分值 ——
                        统计页的"卷面总分"会把它们算成 0 分
                      </span>
                    ) : null}
                    {integrity.missingAnswer.length ? (
                      <span style={{ color: 'var(--color-warn)' }}>
                        <IconAlert size={12} /> 第 {integrity.missingAnswer.join('、')} 题是选择题但**没设正确答案**
                        —— 「记录答题情况」模式下这些题判不出分
                      </span>
                    ) : null}
                    {integrity.unknownKind.length ? (
                      <span style={{ color: 'var(--color-ink3)' }}>
                        <IconInfo size={12} /> 第 {integrity.unknownKind.join('、')} 题题型还是「待定」
                        —— 不影响录分，只影响按题型聚合的统计
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </Panel>
            </div>

            {/* ---------- 第 4 步 · 记录模式 ---------- */}
            <div className="mb-4">
              <Sect>第 4 步 · 记录模式</Sect>
              <Panel bodyClass="p-3">
                <div className="flex gap-2">
                  {(
                    [
                      ['answers', '记录答题情况', '选择题逐人选选项（多选按"选对 m/n"给分），其余题型只记分值'],
                      ['scores', '记录分值', '每题只记一个得分，不记选项'],
                    ] as const
                  ).map(([k, label, desc]) => {
                    const on = mode === k
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setMode(k)}
                        className="flex-1 p-2.5 text-left"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                        }}
                      >
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13.5,
                            fontWeight: on ? 680 : 550,
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                          }}
                        >
                          {label}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--color-ink3)',
                            lineHeight: 1.5,
                            marginTop: 2,
                          }}
                        >
                          {desc}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {mode === 'answers' && integrity.missingAnswer.length ? (
                  <p style={{ fontSize: 11.5, color: 'var(--color-warn)', marginTop: 8, lineHeight: 1.7 }}>
                    <IconAlert size={12} /> 还有 {integrity.missingAnswer.length} 道选择题没设答案，
                    可以先建档案、到批阅页再补 —— 但那些题在补上之前一律 0 分。
                  </p>
                ) : null}
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                  ⚠️ 考试与作业的默认值<b>正好相反</b>：作业默认全对、只记错的；
                  考试默认全零，<b>没批改过的学生每题按 0 分算</b>（确认完成时会再跟你确认一次）。
                </p>
              </Panel>
            </div>

            {/* ---------- 第 5 步 · 班级 ---------- */}
            <div className="mb-4">
              <Sect>
                第 5 步 · {scope === 'grade' ? '参加考试的班级（可多选）' : '考试班级'}
                {chosen.length > 1 ? ` · 已选 ${chosen.length} 个` : ''}
              </Sect>
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap gap-2">
                  {classes.map((c) => {
                    const on = chosen.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setClassIds((cur) => {
                            if (scope === 'class') return [c.id]
                            return cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]
                          })
                        }
                        className="flex items-center gap-2 px-3 py-2"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                        }}
                      >
                        <span
                          className="grid shrink-0 place-items-center"
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: 3,
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: on ? 'var(--color-accent)' : 'transparent',
                            color: '***REMOVED***fff',
                          }}
                        >
                          {on ? <IconCheck size={11} strokeWidth={3} /> : null}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 550 }}>{c.name}</span>
                        <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                          {c.students.filter((s) => s.status === 'active').length} 人
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                  {scope === 'class'
                    ? '班级考试只记在本班，不参与年级排名 —— 所以只能选一个班。'
                    : '年级考试可以选自己任教的多个班；同一个年级里别的老师给自己班建的档案，会按试卷名自动合起来算年级排名（你能看见他们在统计里的名次，但改不了别人班的分）。'}
                  <br />
                  走班教学班这一轮还没做（班型明天才确认）—— 现在只认行政班。
                </p>

                <label className="mt-3 block">
                  <span className="label">缺考 / 未交学号（可选，用逗号或空格隔开）</span>
                  <input
                    className="input"
                    placeholder="例如 12 25 31"
                    value={absentText}
                    onChange={(e) => setAbsentText(e.target.value)}
                  />
                </label>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                  缺考的人<b>不参与均分</b>，单独的名单会在统计页列出来。
                  文件导入时会自动从「未交名单」那一行读出来。
                </p>
              </Panel>
            </div>

            {/* ---------- 汇总 ---------- */}
            <Panel className="mb-4" bodyClass="p-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2" style={{ fontSize: 12.5 }}>
                <span className="flex items-center gap-1.5">
                  <IconClipboard size={14} />
                  {subjectName(subjectCode)}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconGrid size={14} />
                  <span className="num">{n}</span> 题 / <span className="num">{paperTotal}</span> 分
                </span>
                <span className="flex items-center gap-1.5">
                  <IconUsers size={14} />
                  {chosen.length
                    ? chosen.map((id) => classes.find((c) => c.id === id)?.name).join('、')
                    : '未选班级'}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconCalendar size={14} />
                  {examDate}
                </span>
                <Tag tone={scope === 'grade' ? 'accent' : 'idle'}>
                  {scope === 'grade' ? '年级考试' : '班级考试'}
                </Tag>
                <Tag tone={mode === 'answers' ? 'accent' : 'idle'}>
                  {mode === 'answers' ? '记答题情况' : '记分值'}
                </Tag>
              </div>
            </Panel>

            <div className="flex gap-2">
              <Button block onClick={() => navigate('/exams')}>
                取消
              </Button>
              <Button
                block
                variant="primary"
                icon={<IconChevronRight size={16} />}
                disabled={!canCreate}
                onClick={create}
              >
                {source === 'file' ? '先建好，再去导入文件' : '建立并去批阅'}
              </Button>
            </div>
            {!canCreate ? (
              <p style={{ fontSize: 12, color: 'var(--color-ink3)', textAlign: 'center', marginTop: 8 }}>
                填上试卷名称、并至少选一个班之后即可创建
              </p>
            ) : null}
          </>
        )}
      </Page>

      {/* ---------- 题型清单浮层 ---------- */}
      <Sheet
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title="套用题型清单 · 四川新高考"
        footer={
          <Button block onClick={() => setPresetOpen(false)}>
            关闭
          </Button>
        }
      >
        <p style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 12 }}>
          🔴 这份清单是<b>待你确认的草案</b>：<b>已核实</b>的是按 2025 年真卷逐项查过的，
          <b>部分推断</b>的是总分确证、逐题分值按常规推的，<b>样卷</b>是合格考只找到样卷的科目。
          套用之后<b>每一项都能改</b>。
        </p>
        <div className="flex flex-col gap-2.5">
          {EXAM_PRESETS.map((p) => {
            const total = presetTotal(p)
            const diff = total - p.fullScore
            return (
              <div
                key={p.subjectCode}
                className="p-3"
                style={{ border: '1px solid var(--color-line2)', borderRadius: 4 }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span style={{ fontSize: 14, fontWeight: 650 }}>{p.subjectName}</span>
                  <Tag tone={p.confidence === 'confirmed' ? 'ok' : p.confidence === 'inferred' ? 'warn' : 'idle'}>
                    {CONFIDENCE_TEXT[p.confidence]}
                  </Tag>
                  <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                    {p.minutes} 分钟 · {p.fullScore} 分
                  </span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => applyPreset(p.subjectCode)}>
                    套用
                  </Button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 4, lineHeight: 1.6 }}>
                  {p.by}
                </div>
                <div
                  className="mt-2 flex flex-wrap gap-x-3 gap-y-1"
                  style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}
                >
                  {p.groups.map((g, i) => (
                    <span key={i}>
                      {g.label ?? EXAM_KIND_TEXT[g.kind]} {g.count}×{g.each}
                    </span>
                  ))}
                </div>
                {p.note ? (
                  <div style={{ fontSize: 11.5, color: 'var(--color-warn)', marginTop: 6, lineHeight: 1.6 }}>
                    {p.note}
                  </div>
                ) : null}
                {diff !== 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--color-bad)', marginTop: 4 }}>
                    ⚠️ 这张清单加起来是 {total} 分，与卷面满分 {p.fullScore} 分差 {diff > 0 ? '+' : ''}
                    {diff} —— 说明有几道题的分值还没查到，请按实际卷子改。
                  </div>
                ) : null}
                {p.sources.length ? (
                  <div style={{ fontSize: 11, color: 'var(--color-ink4)', marginTop: 4, wordBreak: 'break-all' }}>
                    来源：{p.sources.join(' ')}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </Sheet>
    </>
  )
}
