import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconClipboard,
  IconGrid,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconUsers,
} from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast, examScoreId } from '../data/store'
import {
  EXAM_SCOPE_TEXT,
  EXAM_SOURCE_TEXT,
  EXAM_STATUS_TEXT,
  type Exam,
  type ExamQuestion,
  type ExamQuestionKind,
  type ExamScore,
  type ExamScope,
} from '../data/examTypes'
import { EXAM_KIND_TEXT, findSameExam, isChoiceKind, normalizePaperName } from '../lib/examPaper'
import { parseExamWorkbook, type ExamImportResult } from '../lib/examImport'
import { xlsxSheets } from '../lib/xlsx'
import { ymdOf, beijingNow } from '../lib/holiday'
import { friendlyDate } from '../lib/date'
import { examReport } from '../lib/examStats'
import { archiveKeyOf } from '../lib/keys'
import {
  TERM_FILTER_CURRENT,
  isOtherTerm,
  termFilterOptions,
  termLabelOf,
  termMatches,
  type TermFilterValue,
} from '../lib/terms'

/* ============================================================
   考试列表
   ------------------------------------------------------------
   入口只有两个动作：**新建档案**（去做第 1~5 步）与**导入文件**（新教育导出的成绩单）。
   卡片点进去按状态分流 —— 「批阅中」去批阅页、「已完成」去统计页。
   ============================================================ */

export default function Exams() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const exams = useStore((s) => s.exams)
  const examScores = useStore((s) => s.examScores)
  const classes = useStore((s) => s.classes)
  const removeExam = useStore((s) => s.removeExam)
  const addExam = useStore((s) => s.addExam)
  const setExamScores = useStore((s) => s.setExamScores)
  const examTables = useStore((s) => s.examTables)
  const refreshExamTables = useStore((s) => s.refreshExamTables)
  const terms = useStore((s) => s.terms)
  const currentTerm = useStore((s) => s.currentTermId)

  /**
   * 学期筛选（默认「本学期」，与作业列表同一口径 —— 判据只有 `lib/terms.ts` 一处）。
   * ⚠️ 它不会让考试档案消失：推不出当前学期时不筛、没有归属的照常显示
   *    （P2 那 1 场考试补不上归属时**绝不能从列表里消失**，见实施计划 P2 验收第 4 条）。
   */
  const [termFilter, setTermFilter] = useState<TermFilterValue>(TERM_FILTER_CURRENT)

  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [parsed, setParsed] = useState<ExamImportResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [pickClass, setPickClass] = useState<string>('')
  const [pickScope, setPickScope] = useState<ExamScope>('class')
  const [pickDate, setPickDate] = useState(() => ymdOf(beijingNow()))
  /**
   * 选择题每题几分。**只在文件没给的时候才需要老师填**：
   * 真实的那份导出里，满分行只写了总分 100，客观/主观两格是空的，
   * 于是 10 道选择题的分值一道都推不出来 —— 与其每道题刷一条告警，
   * 不如让老师填一个数（十道选择题通常同分），一键铺到每一道。
   */
  const [choiceScore, setChoiceScore] = useState('')
  const [questionEdits, setQuestionEdits] = useState<Record<number, ExamQuestionKind>>({})

  const nameOfClass = (id: string) => classes.find((c) => c.id === id)?.name ?? '班级已删除'

  /** 同场考试的合并展示：按 paperKey + 学科分组（**先按学期筛**，见上面 `termFilter`） */
  const shown = useMemo(
    () => exams.filter((e) => termMatches(e.termId, termFilter, currentTerm, terms)),
    [exams, termFilter, currentTerm, terms],
  )
  const groups = useMemo(() => {
    const map = new Map<string, Exam[]>()
    for (const e of shown) {
      const key = `${e.paperKey}|${e.subjectCode}|${e.grade}|${e.examDate}`
      const list = map.get(key) ?? []
      list.push(e)
      map.set(key, list)
    }
    return [...map.values()].sort((a, b) => (a[0].examDate < b[0].examDate ? 1 : -1))
  }, [shown])

  /** 处理一份导入文件 */
  const handleFile = async (f: File) => {
    setBusy(true)
    setErr('')
    setParsed(null)
    try {
      const sheets = await xlsxSheets(f)
      const r = parseExamWorkbook(sheets)
      setParsed(r)
      setFileName(f.name)
      setQuestionEdits({})
      /*
       * 班级怎么预选：文件里的班号（`4`）去匹配平台班名里的数字或完整班名。
       * **匹配不上就不选**（让老师自己点）—— 猜错班 = 把分数记到别人头上。
       */
      const fileClass = r.rows.find((x) => x.fileClass)?.fileClass ?? ''
      const hit = fileClass
        ? classes.find(
            (c) => c.name.includes(`${fileClass}班`) || c.name.replace(/\D/g, '') === fileClass,
          )
        : undefined
      setPickClass(hit?.id ?? '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 把解析出来的成绩与花名册对上 */
  const matched = useMemo(() => {
    const klass = classes.find((c) => c.id === pickClass)
    const roster = (klass?.students ?? []).filter((s) => s.status === 'active')
    const byNo = new Map(roster.map((s) => [s.studentNo, s]))
    const byName = new Map(roster.map((s) => [s.name.replace(/\s/g, ''), s]))
    const used = new Set<string>()
    const rows: Array<{
      imported: ExamImportResult['rows'][number]
      studentNo?: string
      name: string
      how: '学号' | '姓名' | '没对上'
    }> = []
    for (const r of parsed?.rows ?? []) {
      // ⚠️ 文件里的 `r.studentNo` 是**班内学号**（纸上印的），所以按 `s.studentNo` 找；
      //    找到之后**存进档案的键是 `archiveKeyOf(s)`**（迁移后 = 序列号）。
      const hitNo = byNo.get(r.studentNo)
      if (hitNo && !used.has(archiveKeyOf(hitNo))) {
        used.add(archiveKeyOf(hitNo))
        rows.push({ imported: r, studentNo: archiveKeyOf(hitNo), name: hitNo.name, how: '学号' })
        continue
      }
      const hitName = byName.get(r.name.replace(/\s/g, ''))
      if (hitName && !used.has(archiveKeyOf(hitName))) {
        used.add(archiveKeyOf(hitName))
        rows.push({ imported: r, studentNo: archiveKeyOf(hitName), name: hitName.name, how: '姓名' })
        continue
      }
      rows.push({ imported: r, name: r.name, how: '没对上' })
    }
    const missing = roster.filter((s) => !used.has(archiveKeyOf(s)))
    return { rows, missing, roster }
  }, [parsed, pickClass, classes])

  const unmatched = matched.rows.filter((r) => r.how === '没对上')

  /**
   * 选择题的每题分值：文件推出来的（`perChoice`）优先；推不出来时用老师填的那个。
   * 两者都取不到就是 0（**不编**），预览上会红字说明。
   */
  const perChoiceFromFile = useMemo(() => {
    if (!parsed?.objectiveFull || !parsed.choiceNos.length) return 0
    return parsed.objectiveFull % parsed.choiceNos.length === 0
      ? parsed.objectiveFull / parsed.choiceNos.length
      : 0
  }, [parsed])
  const choiceEach = perChoiceFromFile || Number(choiceScore) || 0

  /** 确认导入：建档案 + 写成绩行 */
  const doImport = async () => {
    if (!parsed || !pickClass) return
    const klass = classes.find((c) => c.id === pickClass)
    if (!klass) return
    const questions: Record<string, ExamQuestion> = {}
    for (let no = 1; no <= parsed.questionCount; no++) {
      const q = parsed.questions[no]
      const kind = questionEdits[no] ?? q?.kind ?? 'other'
      const isChoice = isChoiceKind(kind)
      questions[String(no)] = {
        no,
        kind,
        // 选择题用「文件推出来的 / 老师填的」每题分值；其余题用文件给的那一题满分
        fullScore: isChoice ? choiceEach : (q?.fullScore ?? 0),
        answer: isChoice ? q?.answer : undefined,
      }
    }
    /* 缺考名单：文件里的「未交名单」按姓名对到学生上（对不上的**不猜**，只提示）；存的是**键** */
    const absentNos = parsed.absentNames
      .map((a) => {
        const hit = matched.roster.find(
          (s) => s.name.replace(/\s/g, '') === a.name.replace(/\s/g, ''),
        )
        return hit ? archiveKeyOf(hit) : undefined
      })
      .filter((x): x is string => Boolean(x))

    /*
     * 先建档案、再写成绩行。
     * ⚠️ 顺序不能反：`examScoreId` 要用**档案的 id** 算确定性主键，
     *    而档案 id 在 `addExam` 内部由 (班级, 学科, 试卷键) 推出来 —— 不先建就没有它。
     *    两步之间失败会留下"空档案"，所以下面把失败如实报出来（不是静默）。
     */
    const res = await addExam({
      title: parsed.title || fileName.replace(/\.xlsx$/i, ''),
      subjectCode: undefined,
      scope: pickScope,
      source: 'file',
      // 文件里选择题给的是选项（可以判分），所以一律用「记录答题情况」——
      // 非选择题的分数照样是从文件里直接读的，不受模式影响。
      mode: 'answers',
      examDate: pickDate,
      questionCount: parsed.questionCount,
      questions,
      classIds: [klass.id],
      absentNos,
      rows: [],
    })
    if (!res.saved) {
      push({ text: '档案没能保存到云端', tone: 'bad', desc: res.reason })
      return
    }

    const rows: ExamScore[] = []
    for (const m of matched.rows) {
      if (!m.studentNo) continue
      rows.push({
        id: await examScoreId(res.id, m.studentNo),
        examId: res.id,
        classId: klass.id,
        studentNo: m.studentNo,
        name: m.name,
        scores: { ...m.imported.scores },
        answers: { ...m.imported.answers },
        graded: true,
        absent: absentNos.includes(m.studentNo),
        // 文件给的汇总**原样保留**（用户口径：文件里有就按文件的，不覆盖）
        total: m.imported.total,
        objective: m.imported.objective,
        subjective: m.imported.subjective,
        classRank: m.imported.classRank,
        gradeRank: m.imported.gradeRank,
        createdAt: Date.now(),
      })
    }
    if (rows.length) setExamScores(res.id, rows)
    push({
      text: '已从文件建立考试档案',
      tone: 'ok',
      desc: `${parsed.title} · ${rows.length} 人${unmatched.length ? ` · ${unmatched.length} 人没对上` : ''}`,
    })
    setImportOpen(false)
    setParsed(null)
    navigate(`/exams/${res.id}/stats`)
  }

  return (
    <>
      <PageHead
        title="考试"
        sub={`${exams.length} 份档案 · ${groups.length} 场考试`}
        onBack={() => navigate('/assignments')}
        right={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" icon={<IconUpload size={14} />} onClick={() => setImportOpen(true)}>
              导入
            </Button>
            <Button size="sm" variant="primary" icon={<IconPlus size={15} />} onClick={() => navigate('/exams/new')}>
              新建
            </Button>
          </div>
        }
      />

      <Page>
        {/*
          学期筛选（默认「本学期」）。摆在下拉里的学期**只列数据里真有的**，
          与作业列表同一口径；切到「全部学期」就能看到以前那几场。
        */}
        {exams.length ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className="input"
              style={{ width: 'auto', height: 34, fontSize: 13 }}
              value={termFilter}
              onChange={(e) => setTermFilter(e.target.value)}
              aria-label="按学期筛选"
            >
              {termFilterOptions(terms, currentTerm).map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
              共 {shown.length} 份档案
            </span>
          </div>
        ) : null}

        {examTables === 'missing' ? (
          <Panel className="mb-3" bodyClass="p-3">
            <div className="flex items-start gap-2" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <IconAlert size={15} />
              <span className="flex-1">
                考试功能暂时不可用，请稍后再试。
              </span>
              <Button size="sm" variant="ghost" icon={<IconRefresh size={13} />} onClick={() => void refreshExamTables()}>
                重试
              </Button>
            </div>
          </Panel>
        ) : null}

        {exams.length === 0 || shown.length === 0 ? (
          <Panel>
            <Empty
              icon={<IconClipboard size={24} />}
              title={exams.length === 0 ? '还没有考试档案' : '这个学期里还没有考试档案'}
              desc={
                exams.length === 0
                  ? undefined
                  : '换一个学期、或者切到「全部学期」试试。'
              }
              action={
                exams.length === 0 ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" icon={<IconPlus size={15} />} onClick={() => navigate('/exams/new')}>
                      建立第一份档案
                    </Button>
                    <Button size="sm" icon={<IconUpload size={14} />} onClick={() => setImportOpen(true)}>
                      导入成绩单
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" onClick={() => setTermFilter('all')}>
                    看全部学期
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-3 stagger">
            {groups.map((list) => {
              const head = list[0]
              const sameOnes = list.length
              return (
                <div key={`${head.paperKey}-${head.subjectCode}-${head.grade}-${head.examDate}`}>
                  {sameOnes > 1 ? (
                    <Sect>
                      {head.title} · {sameOnes} 个班的档案（同一场考试，年级排名会合起来算）
                    </Sect>
                  ) : null}
                  <div className="flex flex-col gap-2.5">
                    {list.map((e) => {
                      const rows = examScores.filter((r) => r.examId === e.id)
                      const klass = classes.find((c) => c.id === e.classIds[0])
                      const roster = (klass?.students ?? [])
                        .filter((s) => s.status === 'active')
                        .map((s) => ({ studentNo: archiveKeyOf(s), displayNo: s.studentNo, name: s.name }))
                      const rep = examReport(e, rows, roster)
                      return (
                        <Panel key={e.id} className="overflow-hidden">
                          <button
                            type="button"
                            className="row"
                            style={{ padding: 14, alignItems: 'flex-start' }}
                            onClick={() =>
                              navigate(e.status === 'graded' ? `/exams/${e.id}/stats` : `/exams/${e.id}/grade`)
                            }
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <Tag tone={e.status === 'graded' ? 'ok' : 'warn'}>
                                  {EXAM_STATUS_TEXT[e.status]}
                                </Tag>
                                <Tag tone={e.scope === 'grade' ? 'accent' : 'idle'}>
                                  {EXAM_SCOPE_TEXT[e.scope]}
                                </Tag>
                                <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                                  {friendlyDate(e.examDate)}
                                </span>
                                {/* 不是本学期的那几场，切到「全部学期」时要认得出来 */}
                                {isOtherTerm(e.termId, currentTerm) ? (
                                  <Tag tone="idle">{termLabelOf(e.termId, terms)}</Tag>
                                ) : null}
                              </span>
                              <span className="mt-1.5 block truncate" style={{ fontSize: 15, fontWeight: 640 }}>
                                {e.title}
                              </span>
                              <span
                                className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1"
                                style={{ fontSize: 12, color: 'var(--color-ink3)' }}
                              >
                                <span className="flex items-center gap-1.5">
                                  <IconGrid size={13} />
                                  {e.subject} · {e.questionCount} 题 · {rep.basics.fullScore} 分
                                </span>
                                <span className="flex items-center gap-1.5">
                                  <IconUsers size={13} />
                                  {e.classIds.map(nameOfClass).join('、')}
                                </span>
                                <span className="flex items-center gap-1.5">
                                  {EXAM_SOURCE_TEXT[e.source]}
                                </span>
                                {rep.basics.present ? (
                                  <span className="flex items-center gap-1.5">
                                    实考 <span className="num">{rep.basics.present}</span> 人 · 均分{' '}
                                    <span className="num" style={{ fontWeight: 650, color: 'var(--color-ink2)' }}>
                                      {rep.basics.avg}
                                    </span>
                                  </span>
                                ) : null}
                                {e.status !== 'graded' && rep.basics.ungraded ? (
                                  <span style={{ color: 'var(--color-warn)', fontWeight: 600 }}>
                                    还没批 <span className="num">{rep.basics.ungraded}</span> 人
                                  </span>
                                ) : null}
                                {e.status === 'graded' && rep.missing.length ? (
                                  <span style={{ color: 'var(--color-warn)', fontWeight: 600 }}>
                                    缺考/没批 <span className="num">{rep.missing.length}</span> 人
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </button>

                          <div
                            className="flex items-center gap-1 px-3 py-2"
                            style={{ borderTop: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
                          >
                            <Button
                              size="sm"
                              variant={e.status === 'graded' ? 'ghost' : 'primary'}
                              icon={e.status === 'graded' ? <IconGrid size={14} /> : <IconCheck size={14} />}
                              onClick={() =>
                                navigate(e.status === 'graded' ? `/exams/${e.id}/stats` : `/exams/${e.id}/grade`)
                              }
                            >
                              {e.status === 'graded' ? '看统计' : '继续批阅'}
                            </Button>
                            {e.status === 'graded' ? (
                              <Button size="sm" variant="ghost" onClick={() => navigate(`/exams/${e.id}/grade`)}>
                                改分数
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" onClick={() => navigate(`/exams/${e.id}/stats`)}>
                                看当前情况
                              </Button>
                            )}
                            <span className="flex-1" />
                            <button
                              type="button"
                              aria-label="删除"
                              onClick={() => setConfirmId(e.id)}
                              style={{ color: 'var(--color-ink4)', padding: 6 }}
                            >
                              <IconTrash size={15} />
                            </button>
                          </div>
                        </Panel>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </Page>

      {/* ---------------- 删除确认 ---------------- */}
      <Sheet
        open={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="删除考试档案"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setConfirmId(null)}>
              取消
            </Button>
            <Button
              block
              variant="danger"
              onClick={() => {
                if (confirmId) removeExam(confirmId)
                setConfirmId(null)
                push({ text: '考试档案已删除', tone: 'warn' })
              }}
            >
              确认删除
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 13.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
          将删除「{exams.find((x) => x.id === confirmId)?.title}」以及这次考试的全部学生成绩。
          该操作不可恢复。
          {examScores.filter((r) => r.examId === confirmId).length ? (
            <>
              <br />
              这次会一起删掉 <b className="num">{examScores.filter((r) => r.examId === confirmId).length}</b>{' '}
              条学生成绩记录。
            </>
          ) : null}
        </div>
      </Sheet>

      {/* ---------------- 导入文件 ---------------- */}
      <Sheet
        open={importOpen}
        onClose={() => {
          setImportOpen(false)
          setParsed(null)
          setErr('')
        }}
        title={parsed ? '核对导入内容' : '导入成绩单（新教育导出）'}
        footer={
          parsed ? (
            <div className="flex gap-2">
              <Button block onClick={() => setParsed(null)}>
                换个文件
              </Button>
              <Button
                block
                variant="primary"
                disabled={!pickClass || busy}
                onClick={() => void doImport()}
              >
                确认建档（{matched.rows.filter((r) => r.studentNo).length} 人）
              </Button>
            </div>
          ) : (
            <Button
              block
              onClick={() => {
                setImportOpen(false)
                navigate('/exams/new')
              }}
            >
              改成手动建档
            </Button>
          )
        }
      >
        {!parsed ? (
          <div>
            <label
              className="block p-6 text-center"
              style={{ border: '1px dashed var(--color-line2)', borderRadius: 6, cursor: 'pointer' }}
            >
              <input
                type="file"
                accept=".xlsx"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleFile(f)
                }}
              />
              <IconUpload size={22} />
              <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 6 }}>
                {busy ? '正在读取…' : '选一份 .xlsx 成绩单'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 4, lineHeight: 1.7 }}>
                新教育导出的成绩单
              </div>
            </label>
            {err ? (
              <div className="mt-3 flex items-start gap-2" style={{ fontSize: 12.5, color: 'var(--color-bad)' }}>
                <IconAlert size={14} />
                {err}
              </div>
            ) : null}
          </div>
        ) : (
          <div>
            {/* 识别出来的东西 */}
            <div className="p-3" style={{ border: '1px solid var(--color-line2)', borderRadius: 4 }}>
              <div className="flex flex-wrap items-center gap-2">
                <b style={{ fontSize: 14.5 }}>{parsed.title || '（没认出试卷名）'}</b>
                {parsed.subjectName ? <Tag tone="accent">{parsed.subjectName}</Tag> : null}
                <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                  {parsed.questionCount} 题
                </span>
              </div>
              {parsed.summaryText ? (
                <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 4 }}>{parsed.summaryText}</div>
              ) : null}
            </div>

            <label className="mt-3 block">
              <span className="label">考试日期（文件名里没有，需要你选）</span>
              <input
                className="input"
                type="date"
                value={pickDate}
                onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setPickDate(e.target.value)}
              />
            </label>

            <div className="mt-3">
              <span className="label">这是年级考试还是班级考试</span>
              <div className="flex gap-2">
                {(
                  [
                    ['grade', '年级考试', '别班的同名档案会合起来算年级排名'],
                    ['class', '班级考试', '只记在本班，不算年级排名'],
                  ] as const
                ).map(([k, label, desc]) => {
                  const on = pickScope === k
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPickScope(k)}
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
                          fontSize: 13,
                          fontWeight: on ? 680 : 550,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                        }}
                      >
                        {label}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--color-ink3)', lineHeight: 1.5 }}>
                        {desc}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="mt-3">
              <span className="label">这份成绩属于哪个班（必选）</span>
              <div className="flex flex-wrap gap-2">
                {classes.map((c) => {
                  const on = pickClass === c.id
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPickClass(c.id)}
                      className="flex items-center gap-2 px-3 py-2"
                      style={{
                        border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                        background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                        borderRadius: 4,
                        color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 550 }}>{c.name}</span>
                      <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                        {c.students.filter((s) => s.status === 'active').length} 人
                      </span>
                    </button>
                  )
                })}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                文件里的班号是「{parsed.rows.find((r) => r.fileClass)?.fileClass || '—'}」，
                已按它预选。选错了分会记到别的班头上，请核一下。
              </p>
            </div>

            {/* 对上 / 没对上 */}
            <div className="mt-4">
              <Sect>
                学生核对 · 对上 {matched.rows.filter((r) => r.studentNo).length} 人
                {unmatched.length ? ` · 没对上 ${unmatched.length} 人` : ''}
              </Sect>
              {unmatched.length ? (
                <div
                  className="mb-2 p-2.5"
                  style={{ background: 'var(--color-warnsoft)', borderRadius: 4, fontSize: 12.5, lineHeight: 1.8 }}
                >
                  <IconAlert size={13} /> 这些人不会被导入（花名册里找不到）：
                  {unmatched.map((u) => `${u.imported.fileClass ? `${u.imported.fileClass}班 ` : ''}${u.name}`).join('、')}
                  <br />
                  名字里有多余标记、或者还没录进平台。先去「班级」补上再导一次。
                </div>
              ) : null}
              {matched.missing.length ? (
                <div className="mb-2" style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                  花名册里这 <b className="num">{matched.missing.length}</b> 人文件里没有：
                  {matched.missing.map((s) => s.name).join('、')}
                  —— 他们会是"没批改（0 分）"，在统计页的名单里能看到。
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                {matched.rows.slice(0, 60).map((r, i) => (
                  <div
                    key={`${r.studentNo ?? 'x'}-${i}`}
                    className="flex items-center gap-2 px-2 py-1"
                    style={{ fontSize: 12, borderBottom: '1px solid var(--color-line)' }}
                  >
                    <span className="num" style={{ width: 44, color: 'var(--color-ink3)' }}>
                      {r.studentNo ?? '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="num" style={{ width: 46, textAlign: 'right' }}>
                      {r.imported.total ?? '—'}
                    </span>
                    <span style={{ width: 54, color: r.how === '没对上' ? 'var(--color-bad)' : 'var(--color-ink3)' }}>
                      {r.how}
                    </span>
                  </div>
                ))}
                {matched.rows.length > 60 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                    （只显示前 60 行，共 {matched.rows.length} 行）
                  </div>
                ) : null}
              </div>
            </div>

            {/* 题型确认：文件里认不出的题型要老师定 */}
            <div className="mt-4">
              <Sect>题型（文件认不出的要你定一下）</Sect>

              {parsed.choiceNos.length && !perChoiceFromFile ? (
                <div
                  className="mb-2 p-2.5"
                  style={{ background: 'var(--color-warnsoft)', borderRadius: 4, fontSize: 12.5, lineHeight: 1.8 }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      这份文件的满分行里<b>没给客观题满分</b>，所以 {parsed.choiceNos.length} 道选择题的每题分值
                      要你填一下：
                    </span>
                    <input
                      className="input num"
                      type="number"
                      min={1}
                      max={20}
                      placeholder="每题几分"
                      style={{ width: 96, height: 30, fontSize: 12.5 }}
                      value={choiceScore}
                      onChange={(e) => setChoiceScore(e.target.value)}
                    />
                    <span className="num" style={{ color: 'var(--color-ink3)' }}>
                      × {parsed.choiceNos.length} 题 ={' '}
                      {choiceEach ? choiceEach * parsed.choiceNos.length : 0} 分
                    </span>
                  </div>
                  <div style={{ color: 'var(--color-ink3)', marginTop: 4 }}>
                    题目与答案已经认出来了，只差每题分值。
                    {choiceEach ? `第 ${parsed.choiceNos.join('、')} 题各记 ${choiceEach} 分。` : '不填的话选择题一律 0 分。'}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                {Array.from({ length: parsed.questionCount }, (_, i) => i + 1).map((no) => {
                  const q = parsed.questions[no]
                  const kind = questionEdits[no] ?? q?.kind ?? 'other'
                  const choices = q && isChoiceKind(q.kind)
                  return (
                    <div key={no} className="flex flex-wrap items-center gap-2">
                      <span className="num" style={{ width: 26, fontSize: 12.5, fontWeight: 700 }}>
                        {no}
                      </span>
                      {choices ? (
                        <Tag tone="ok">
                          {EXAM_KIND_TEXT[q.kind]} {q.answer}
                        </Tag>
                      ) : (
                        <select
                          className="input"
                          aria-label={`第 ${no} 题题型`}
                          style={{ width: 'auto', height: 30, fontSize: 12.5 }}
                          value={kind}
                          onChange={(e) =>
                            setQuestionEdits((s) => ({ ...s, [no]: e.target.value as ExamQuestionKind }))
                          }
                        >
                          {(Object.keys(EXAM_KIND_TEXT) as ExamQuestionKind[]).map((k) => (
                            <option key={k} value={k}>
                              {EXAM_KIND_TEXT[k]}
                            </option>
                          ))}
                        </select>
                      )}
                      <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                        {choices ? choiceEach : (q?.fullScore ?? 0)} 分
                      </span>
                    </div>
                  )
                })}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                这几题文件里给了答案，已认成选择题；其余题需要你选一下题型。
                选错只影响按题型聚合的统计，不影响分数。
              </p>
            </div>

            {parsed.warnings.length ? (
              <div className="mt-4">
                <Sect>解析提醒 · {parsed.warnings.length} 条</Sect>
                <div className="flex flex-col gap-1">
                  {parsed.warnings.map((w, i) => (
                    <div key={i} className="flex items-start gap-2" style={{ fontSize: 12, color: 'var(--color-warn)', lineHeight: 1.7 }}>
                      <IconAlert size={13} />
                      {w}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {parsed.distribution.length ? (
              <div className="mt-4">
                <Sect>文件里的选项分布（{parsed.distribution.length} 题）</Sect>
                <div style={{ fontSize: 12, color: 'var(--color-ink2)', lineHeight: 1.8 }}>
                  {parsed.distribution.map((d) => (
                    <div key={d.no}>
                      第 {d.no} 题 答案 <b>{d.answer}</b>：
                      {d.options.map((o) => `${o.option} ${o.count}人`).join(' · ')}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 同场考试提示 */}
            {(() => {
              const same = findSameExam(exams, { title: parsed.title }).slice(0, 3)
              if (!same.length) return null
              return (
                <div
                  className="mt-4 p-2.5"
                  style={{ border: '1px solid var(--color-accent)', background: 'var(--color-accentsoft)', borderRadius: 4 }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--color-accentink)' }}>
                    库里已有 {same.length} 份同一场考试
                  </div>
                  {same.map(({ exam }) => (
                    <div key={exam.id} style={{ fontSize: 11.5, color: 'var(--color-ink2)', marginTop: 3, lineHeight: 1.6 }}>
                      · {exam.title}（{exam.classIds.map(nameOfClass).join('、')}）
                    </div>
                  ))}
                  <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 4, lineHeight: 1.7 }}>
                    =「{normalizePaperName(parsed.title)}」这一场的各班档案会合起来算年级排名；
                    这次只写你这个班的分。
                  </div>
                </div>
              )
            })()}
          </div>
        )}
      </Sheet>
    </>
  )
}
