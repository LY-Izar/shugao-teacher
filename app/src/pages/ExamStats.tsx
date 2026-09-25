import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
  IconPencil,
  IconTarget,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag, Track } from '../components/ui'
import { useStore } from '../data/store'
import { EXAM_MODE_TEXT, EXAM_SCOPE_TEXT } from '../data/examTypes'
import {
  EXAM_KIND_TEXT,
  isChoiceKind,
  paperFullScore,
  questionCountOf,
  round2,
  totalOf,
} from '../lib/examPaper'
import { examReport, studentTrendOf, trendOf, type QuestionStat } from '../lib/examStats'
import { friendlyDate } from '../lib/date'
import { archiveKeyOf } from '../lib/keys'

/* ============================================================
   考试 · 数据统计
   ------------------------------------------------------------
   这里回答两个问题：**这次考得怎么样**、**接下来讲什么**。
   文件里已经有的（`新教育` 导出的两个 sheet）：
     总分 / 客观题得分 / 主观题得分 / 班级排名 / 年级排名 / 逐题得分 /
     每题正确答案 / 答错答对人数 / 正答率 / 选项分布与名单 / 未交名单
   这一页在此基础上**新增**的：
     ① 知识点得分率    ② 分数段分布    ③ 近几次趋势（班级 + 个人）
     ④ 个人诊断（反复丢分的知识点、与班级均值差）  ⑤ 班级 vs 年级对比
     ⑥ 缺考/未批改名单   ⑦ 难度与区分度
   （逐条在 `功能设计与不变量.md` §十四「统计页做了什么」里也有）

   🔴 名次的口径：**文件里有就按文件的**（`classRank` / `gradeRank`），
      本地另算一份只在文件没给时兜底；两套不一致时**两个都显示**，不覆盖。
   ============================================================ */

/** 难度分档（教育测量学常用口径）。P 越大越容易。 */
function difficultyBand(p?: number): { label: string; tone: 'ok' | 'idle' | 'warn' | 'bad' | 'accent' } {
  if (p === undefined) return { label: '—', tone: 'idle' }
  if (p >= 0.85) return { label: '很容易', tone: 'ok' }
  if (p >= 0.7) return { label: '较易', tone: 'ok' }
  if (p >= 0.55) return { label: '中等', tone: 'accent' }
  if (p >= 0.4) return { label: '较难', tone: 'warn' }
  return { label: '很难', tone: 'bad' }
}

/** 区分度分档（D ≥ 0.4 很好；< 0.2 说明这道题分辨不出谁会谁不会） */
function discriminationBand(d?: number): { label: string; tone: 'ok' | 'idle' | 'warn' | 'bad' } {
  if (d === undefined) return { label: '—', tone: 'idle' }
  if (d >= 0.4) return { label: '很好', tone: 'ok' }
  if (d >= 0.3) return { label: '良好', tone: 'ok' }
  if (d >= 0.2) return { label: '尚可', tone: 'warn' }
  return { label: '需改进', tone: 'bad' }
}

const pct = (v?: number) => (v === undefined ? '—' : `${Math.round(v * 100)}%`)

export default function ExamStats() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const exam = useStore((s) => s.exams.find((e) => e.id === id))
  const allScores = useStore((s) => s.examScores)
  const classes = useStore((s) => s.classes)
  const exams = useStore((s) => s.exams)
  const updateExam = useStore((s) => s.updateExam)

  const [openQ, setOpenQ] = useState<number | null>(null)
  const [openStudent, setOpenStudent] = useState<string | null>(null)
  const [modeOpen, setModeOpen] = useState(false)

  const rows = useMemo(() => allScores.filter((r) => r.examId === id), [allScores, id])

  const roster = useMemo(() => {
    const ids = exam?.classIds ?? []
    /*
     * ⚠️ `studentNo` 这一栏放的是**档案键**（迁移后 = 序列号）——
     *    它要和 `exam_scores.student_no`（数据库那一列的值）对得上才能 join。
     *    给人看的班内学号放在 `displayNo` 里；**排序照旧按班内学号**（老师认这个号）。
     */
    const out: Array<{ studentNo: string; name: string; displayNo: string }> = []
    for (const cid of ids) {
      const k = classes.find((c) => c.id === cid)
      if (!k) continue
      for (const s of k.students) {
        if (s.status !== 'active') continue
        out.push({ studentNo: archiveKeyOf(s), displayNo: s.studentNo, name: s.name })
      }
    }
    return out.sort(
      (a, b) => Number(a.displayNo) - Number(b.displayNo) || a.name.localeCompare(b.name),
    )
  }, [exam?.classIds, classes])

  /**
   * 年级口径：同一年级、同一场考试（paper_key + 学科 + 日期 + 年级）的**所有班**的档案。
   * ⚠️ 这里读的是 `store.exams`，而它已经是**数据库 RLS 筛过的结果**——
   *    前端不另写一套"我能不能看这个班"的规则（§11.3）。
   *    年级主任能看到整个年级，正是靠数据库的读策略（schema.sql §15.3）。
   */
  const gradeBundle = useMemo(() => {
    if (!exam || exam.scope !== 'grade') return null
    const ids = exams
      .filter(
        (e) =>
          e.id === exam.id ||
          (e.scope === 'grade' &&
            e.paperKey === exam.paperKey &&
            e.subjectCode === exam.subjectCode &&
            e.grade === exam.grade &&
            e.examDate === exam.examDate),
      )
      .map((e) => e.id)
    const gradeRows = allScores.filter((r) => ids.includes(r.examId))
    const examList = exams.filter((e) => ids.includes(e.id))
    return { ids, gradeRows, examList }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam?.id, exam?.scope, exam?.paperKey, exam?.subjectCode, exam?.grade, exam?.examDate, exams, allScores])

  /** 同一个班、同一学科、最近的几次考试（趋势用） */
  const trendItems = useMemo(() => {
    if (!exam) return []
    return exams
      .filter((e) => e.status === 'graded' && e.subjectCode === exam.subjectCode)
      .filter((e) => e.classIds.some((c) => exam.classIds.includes(c)))
      .sort((a, b) => (a.examDate < b.examDate ? 1 : -1))
      .slice(0, 6)
      .map((e) => {
        const name = e.classIds
          .map((cid) => classes.find((c) => c.id === cid)?.name)
          .filter(Boolean)
          .join('、')
        return {
          exam: e,
          rows: allScores.filter((r) => r.examId === e.id),
          label: `${e.title}${name ? ` · ${name}` : ''}`,
        }
      })
  }, [exams, exam, allScores, classes])

  const report = useMemo(
    () => (exam ? examReport(exam, rows, roster, gradeBundle?.gradeRows) : null),
    [exam, rows, roster, gradeBundle],
  )

  if (!exam || !report) {
    return (
      <>
        <PageHead title="考试情况" onBack={() => navigate('/exams')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>该考试档案可能已被删除</div>
          </Panel>
        </Page>
      </>
    )
  }

  const b = report.basics
  const full = paperFullScore(exam)
  const examById = new Map(exams.map((e) => [e.id, e]))
  const gradeTotals = gradeBundle
    ? gradeBundle.gradeRows
        .filter((r) => !r.absent)
        .map((r) => {
          const e = examById.get(r.examId) ?? exam
          const t = Number(r.total)
          return Number.isFinite(t) && t > 0 ? t : totalOf(e, r)
        })
    : []
  const gradeAvg = gradeTotals.length
    ? round2(gradeTotals.reduce((a, c) => a + c, 0) / gradeTotals.length)
    : 0
  const gradeClassCount = gradeBundle ? new Set(gradeBundle.gradeRows.map((r) => r.classId)).size : 0
  const openStat: QuestionStat | undefined = report.questions.find((q) => q.no === openQ)
  const studentDiag = openStudent
    ? report.students.find((s) => s.studentNo === openStudent)
    : undefined
  const sTrend = openStudent ? studentTrendOf(trendItems, openStudent) : []

  return (
    <>
      <PageHead
        title="考试情况"
        sub={`${exam.title} · ${friendlyDate(exam.examDate)} · ${report.count} 题 · ${EXAM_MODE_TEXT[exam.mode]}`}
        onBack={() => navigate('/exams')}
        right={
          <Button size="sm" variant="ghost" icon={<IconPencil size={14} />} onClick={() => setModeOpen(true)}>
            档案
          </Button>
        }
      />

      <Page>
        {/* ---------------- 总览 ---------------- */}
        <div className="mb-3">
          <StatStrip
            items={[
              { k: '均分', v: <span className="num">{b.avg}</span> },
              { k: '卷面', v: <span className="num">{full}</span> },
              { k: '最高', v: <span className="num">{b.max}</span>, tone: 'var(--color-ok)' },
              { k: '最低', v: <span className="num">{b.min}</span> },
            ]}
          />
        </div>
        <Panel className="mb-4" bodyClass="p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2" style={{ fontSize: 12.5 }}>
            <span className="flex items-center gap-1.5">
              <Tag tone={exam.scope === 'grade' ? 'accent' : 'idle'}>{EXAM_SCOPE_TEXT[exam.scope]}</Tag>
              <Tag tone="ok">{exam.subject}</Tag>
            </span>
            <span className="flex items-center gap-1.5">
              <IconUsers size={13} />
              实考 <span className="num">{b.present}</span>/{b.total} 人
              {b.absent ? (
                <span style={{ color: 'var(--color-warn)' }}>
                  · 缺考 <span className="num">{b.absent}</span>
                </span>
              ) : null}
              {b.ungraded ? (
                <span style={{ color: 'var(--color-bad)' }}>
                  · 没批改 <span className="num">{b.ungraded}</span>（已按 0 分计）
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-1.5">
              中位 <span className="num">{b.median}</span>
            </span>
            <span className="flex items-center gap-1.5">
              标准差 <span className="num">{b.std}</span>
            </span>
            <span className="flex items-center gap-1.5">
              客观题均分 <span className="num">{b.avgObjective}</span>
            </span>
            <span className="flex items-center gap-1.5">
              主观题均分 <span className="num">{b.avgSubjective}</span>
            </span>
          </div>
        </Panel>

        {/* ---------------- 缺考 / 没批改（文件里那位"未交"就在这） ---------------- */}
        {report.missing.length ? (
          <div className="mb-4">
            <Sect>缺考 / 还没批改 · {report.missing.length} 人</Sect>
            <Panel bodyClass="p-3">
              <div className="flex flex-wrap gap-2">
                {report.missing.map((m) => (
                  <span
                    key={`${m.why}-${m.studentNo}`}
                    className="flex items-center gap-1.5 px-2 py-1"
                    style={{
                      border: `1px solid ${m.why === 'absent' ? 'var(--color-warn)' : 'var(--color-bad)'}`,
                      background: m.why === 'absent' ? 'var(--color-warnsoft)' : 'var(--color-badsoft)',
                      borderRadius: 4,
                      fontSize: 12.5,
                    }}
                  >
                    <b className="num">{m.displayNo}</b>
                    {m.name}
                    <span style={{ color: 'var(--color-ink3)' }}>
                      {m.why === 'absent' ? '缺考' : '没批改（0 分）'}
                    </span>
                  </span>
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                两种情形不是一回事：<b>缺考</b>的人不进均分；<b>没批改</b>的人按 0 分进均分。
                {exam.absentNos.length
                  ? '（本次缺考名单建档时登记过，可以点右上角「档案」改。）'
                  : ''}
              </p>
            </Panel>
          </div>
        ) : null}

        {/* ---------------- 班级 vs 年级 ---------------- */}
        {exam.scope === 'grade' ? (
          <div className="mb-4">
            <Sect>班级 vs 年级</Sect>
            <Panel bodyClass="p-3">
              {gradeClassCount <= 1 ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  这是一次<b>年级考试</b>，但库里目前只有本班这一份成绩。
                  同年级其他班如果也用平台记录，他们建一份<b>同名同科</b>的档案之后，
                  这里会自动出现年级排名与年级对比 —— 判据是试卷名（空格、汉字数字、标点都不影响）。
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2" style={{ fontSize: 13 }}>
                  <span>
                    本班均分 <b className="num">{b.avg}</b>
                  </span>
                  <span>
                    年级均分 <b className="num">{gradeAvg}</b>
                  </span>
                  <span
                    style={{
                      color: b.avg >= gradeAvg ? 'var(--color-ok)' : 'var(--color-bad)',
                      fontWeight: 650,
                    }}
                  >
                    {b.avg >= gradeAvg ? '高于年级' : '低于年级'}{' '}
                    <span className="num">{round2(Math.abs(b.avg - gradeAvg))}</span> 分
                  </span>
                  <span style={{ color: 'var(--color-ink3)' }}>
                    年级共 <span className="num">{gradeClassCount}</span> 个班 ·{' '}
                    <span className="num">{gradeTotals.length}</span> 人
                  </span>
                </div>
              )}
            </Panel>
          </div>
        ) : null}

        {/* ---------------- 分数段分布 ---------------- */}
        <div className="mb-4">
          <Sect>分数段分布 · {b.present} 人</Sect>
          <Panel bodyClass="p-4">
            {report.bands.map((band) => (
              <div key={band.label} className="flex items-center gap-3 py-1.5">
                <span style={{ width: 96, fontSize: 12.5, color: 'var(--color-ink2)' }}>{band.label}</span>
                <span style={{ flex: 1 }}>
                  <Track value={band.rate * 100} />
                </span>
                <span className="num" style={{ fontSize: 13, fontWeight: 700, width: 48, textAlign: 'right' }}>
                  {band.count} 人
                </span>
                <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)', width: 40 }}>
                  {pct(band.rate)}
                </span>
              </div>
            ))}
          </Panel>
        </div>

        {/* ---------------- 逐题 ---------------- */}
        <div className="mb-4">
          <Sect>逐题 · 得分率 / 难度 / 区分度</Sect>
          <Panel bodyClass="p-3">
            <div className="flex flex-col gap-1.5">
              {report.questions.map((q) => {
                const db = difficultyBand(q.difficulty)
                const rb = discriminationBand(q.discrimination)
                return (
                  <button
                    key={q.no}
                    type="button"
                    className="flex flex-wrap items-center gap-2 px-2 py-2 text-left"
                    style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}
                    onClick={() => setOpenQ(q.no)}
                  >
                    <span className="num" style={{ fontSize: 13.5, fontWeight: 700, width: 26 }}>
                      {q.no}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)', width: 62 }}>
                      {EXAM_KIND_TEXT[q.kind]}
                    </span>
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)', width: 44 }}>
                      {q.avg}/{q.fullScore}
                    </span>
                    <span style={{ flex: '1 1 90px', minWidth: 90 }}>
                      <Track
                        value={(q.rate ?? 0) * 100}
                        tone={(q.rate ?? 0) < 0.5 ? 'var(--color-bad)' : undefined}
                      />
                    </span>
                    <span className="num" style={{ fontSize: 12, width: 38 }}>
                      {pct(q.rate)}
                    </span>
                    <Tag tone={db.tone}>{db.label}</Tag>
                    <span style={{ fontSize: 11, color: 'var(--color-ink4)' }}>区分度</span>
                    <Tag tone={rb.tone}>
                      {q.discrimination === undefined ? '—' : `${q.discrimination.toFixed(2)} ${rb.label}`}
                    </Tag>
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              <b>难度 P</b> = 该题平均得分 ÷ 满分（越大越容易）·
              <b>区分度 D</b> = 高分组(27%)得分率 − 低分组(27%)得分率（≥0.4 很好，&lt;0.2 说明这题分辨不出会与不会）。
              人数少于 8 人时不计算区分度 —— 小样本上这个指标会误导人。
            </p>
          </Panel>
        </div>

        {/* ---------------- 知识点得分率 ---------------- */}
        <div className="mb-4">
          <Sect>知识点得分率（新增）</Sect>
          <Panel bodyClass="p-3">
            {report.points.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                这份档案的题目还没有挂知识点。知识点来自<b>九科知识树</b>，
                在批阅页可以给每道题打标；打上之后这里会给出「哪个知识点最薄」。
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {report.points.map((p) => (
                  <div key={p.id} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ fontSize: 13 }}>
                        {p.name}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                        第 {p.nos.join('、')} 题 · 覆盖 {p.questions} 题 · 卷面 {p.fullScore} 分
                      </span>
                    </span>
                    <span style={{ width: 90 }}>
                      <Track
                        value={p.rate * 100}
                        tone={p.rate < 0.5 ? 'var(--color-bad)' : p.rate < 0.7 ? 'var(--color-warn)' : undefined}
                      />
                    </span>
                    <span className="num" style={{ fontSize: 12.5, fontWeight: 700, width: 42, textAlign: 'right' }}>
                      {pct(p.rate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ---------------- 趋势 ---------------- */}
        <div className="mb-4">
          <Sect>近几次趋势（新增）</Sect>
          <Panel bodyClass="p-3">
            {trendItems.length <= 1 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                只有这一场考试，还看不出趋势
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  {trendOf(trendItems).map((t) => {
                    const on = t.examId === exam.id
                    return (
                      <button
                        key={t.examId}
                        type="button"
                        className="flex items-center gap-2 px-2 py-1.5 text-left"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'transparent',
                          borderRadius: 4,
                        }}
                        onClick={() => navigate(`/exams/${t.examId}/stats`)}
                      >
                        <span style={{ fontSize: 12, color: 'var(--color-ink3)', width: 74 }}>
                          {t.examDate}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5 }}>
                          {t.title}
                        </span>
                        <span style={{ width: 80 }}>
                          <Track value={t.rate * 100} />
                        </span>
                        <span className="num" style={{ fontSize: 12, width: 40, textAlign: 'right' }}>
                          {pct(t.rate)}
                        </span>
                        <span className="num" style={{ fontSize: 12, width: 74, textAlign: 'right' }}>
                          均 {t.avg}/{t.fullScore}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                  比的是<b>得分率</b>而不是平均分：上次 100 分卷、这次 60 分卷，
                  平均分从 62 掉到 48 不代表退步。两个数都列出来了，看趋势看的是得分率那一列。
                </p>
              </>
            )}
          </Panel>
        </div>

        {/* ---------------- 学生名单 ---------------- */}
        <div className="mb-4">
          <Sect>学生 · 点开看诊断</Sect>
          <Panel bodyClass="p-0">
            <div className="flex flex-col">
              {report.students
                .slice()
                .sort((x, y) => x.classRank - y.classRank)
                .map((s) => (
                  <button
                    key={s.studentNo}
                    type="button"
                    className="flex items-center gap-2 px-3 py-2 text-left"
                    style={{ borderBottom: '1px solid var(--color-line)' }}
                    aria-label={`${s.displayNo} 号 ${s.name}`}
                    onClick={() => setOpenStudent(s.studentNo)}
                  >
                    <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)', width: 34 }}>
                      {s.classRank || '—'}
                    </span>
                    <span className="num" style={{ fontSize: 12.5, width: 44 }}>
                      {s.displayNo}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                      {s.name}
                      {s.absent ? <Tag tone="warn">缺考</Tag> : null}
                      {s.ungraded ? <Tag tone="bad">没批改</Tag> : null}
                    </span>
                    <span
                      className="num"
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: s.diffFromAvg >= 0 ? 'var(--color-ok)' : 'var(--color-bad)',
                        width: 44,
                        textAlign: 'right',
                      }}
                    >
                      {s.total}
                    </span>
                    <span
                      className="num"
                      style={{
                        fontSize: 11.5,
                        color: s.diffFromAvg >= 0 ? 'var(--color-ok)' : 'var(--color-bad)',
                        width: 52,
                        textAlign: 'right',
                      }}
                    >
                      {s.diffFromAvg >= 0 ? '+' : ''}
                      {s.diffFromAvg}
                    </span>
                    <IconChevronRight size={14} />
                  </button>
                ))}
            </div>
          </Panel>
        </div>

        <p style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.8 }}>
          「相对均分」是本人总分减班级均分。<b>班级排名</b>按本次实考成绩排；
          <b>年级排名</b>优先用文件带来的值（新教育导出的那份就有），文件没给才本地算。
        </p>
      </Page>

      {/* ---------------- 逐题下钻 ---------------- */}
      <Sheet
        open={openQ !== null}
        onClose={() => setOpenQ(null)}
        title={openStat ? `第 ${openStat.no} 题 · ${EXAM_KIND_TEXT[openStat.kind]}` : '题目'}
        footer={
          <Button block onClick={() => setOpenQ(null)}>
            关闭
          </Button>
        }
      >
        {openStat ? (
          <>
            <StatStrip
              items={[
                { k: '满分', v: <span className="num">{openStat.fullScore}</span> },
                { k: '平均', v: <span className="num">{openStat.avg}</span> },
                { k: '得分率', v: pct(openStat.rate) },
                { k: '满分人数', v: <span className="num">{openStat.fullCount}</span>, tone: 'var(--color-ok)' },
                { k: '零分人数', v: <span className="num">{openStat.zeroCount}</span>, tone: 'var(--color-bad)' },
              ]}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2" style={{ fontSize: 12.5 }}>
              <Tag tone={difficultyBand(openStat.difficulty).tone}>
                难度 {difficultyBand(openStat.difficulty).label}
              </Tag>
              {openStat.discrimination !== undefined ? (
                <Tag tone={discriminationBand(openStat.discrimination).tone}>
                  区分度 {openStat.discrimination.toFixed(2)} {discriminationBand(openStat.discrimination).label}
                </Tag>
              ) : (
                <span style={{ color: 'var(--color-ink3)' }}>人数太少，不计算区分度</span>
              )}
            </div>

            {openStat.choices ? (
              <div className="mt-4">
                <Sect>选项分布</Sect>
                <div className="flex flex-col gap-1.5">
                  {openStat.choices.map((c) => (
                    <div key={c.option} className="px-2 py-1.5" style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}>
                      <div className="flex items-center gap-2">
                        <b className="num" style={{ fontSize: 13.5 }}>
                          {c.option}
                        </b>
                        {c.correct ? <Tag tone="ok">正确答案</Tag> : null}
                        <span className="flex-1" />
                        <span className="num" style={{ fontSize: 13, fontWeight: 700 }}>
                          {c.count} 人
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 3, lineHeight: 1.6 }}>
                        {c.names.join('、')}
                      </div>
                    </div>
                  ))}
                  {!openStat.choices.length ? (
                    <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                      没有选项数据
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="mt-4">
              <Sect>这题的答案</Sect>
              <div style={{ fontSize: 13.5 }}>
                {isChoiceKind(openStat.kind) ? (
                  <>
                    正确答案 <b className="num" style={{ color: 'var(--color-ok)' }}>{exam.questions[String(openStat.no)]?.answer || '未设置'}</b>
                  </>
                ) : (
                  '主观题，没有标准选项答案。'
                )}
              </div>
            </div>
          </>
        ) : null}
      </Sheet>

      {/* ---------------- 个人诊断 ---------------- */}
      <Sheet
        open={openStudent !== null}
        onClose={() => setOpenStudent(null)}
        title={studentDiag ? `${studentDiag.displayNo} ${studentDiag.name}` : '学生'}
        footer={
          <Button block onClick={() => setOpenStudent(null)}>
            关闭
          </Button>
        }
      >
        {studentDiag ? (
          <>
            <StatStrip
              items={[
                { k: '总分', v: <span className="num">{studentDiag.total}</span> },
                { k: '班级排名', v: <span className="num">{studentDiag.classRank || '—'}</span> },
                { k: '相对均分', v: `${studentDiag.diffFromAvg >= 0 ? '+' : ''}${studentDiag.diffFromAvg}` },
                {
                  k: '年级排名',
                  v: studentDiag.gradeRank ? <span className="num">{studentDiag.gradeRank}</span> : '—',
                },
              ]}
            />
            {studentDiag.absent ? (
              <p style={{ fontSize: 13, color: 'var(--color-warn)', marginTop: 12 }}>这次缺考，没有成绩。</p>
            ) : null}
            {studentDiag.ungraded ? (
              <p style={{ fontSize: 13, color: 'var(--color-bad)', marginTop: 12 }}>
                这位同学还没批改，统计时按 <b>0 分</b> 计。
              </p>
            ) : null}

            <div className="mt-4">
              <Sect>薄弱知识点 · 反复丢分的地方</Sect>
              {studentDiag.weakPoints.length ? (
                <div className="flex flex-col gap-1.5">
                  {studentDiag.weakPoints.map((p) => (
                    <div key={p.id} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="num" style={{ color: 'var(--color-bad)' }}>
                        丢 {p.lost} 分
                      </span>
                      <span className="num" style={{ color: 'var(--color-ink3)', width: 44, textAlign: 'right' }}>
                        {pct(p.rate)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  {report.points.length
                    ? '丢分比较分散，没有明显薄弱的知识点'
                    : '题目还没挂知识点，看不出薄弱点。'}
                </div>
              )}
            </div>

            <div className="mt-4">
              <Sect>薄弱题号</Sect>
              {studentDiag.weakNos.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {studentDiag.weakNos.map((no) => (
                    <span
                      key={no}
                      className="num grid place-items-center"
                      style={{
                        width: 30,
                        height: 30,
                        border: '1px solid var(--color-bad)',
                        background: 'var(--color-badsoft)',
                        borderRadius: 4,
                        fontSize: 12.5,
                        fontWeight: 700,
                      }}
                    >
                      {no}
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--color-ok)' }}>没有得分率低于 60% 的题。</div>
              )}
              {studentDiag.perfectNos.length ? (
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                  满分题：{studentDiag.perfectNos.join('、')}
                </p>
              ) : null}
            </div>

            {sTrend.length > 1 ? (
              <div className="mt-4">
                <Sect>这一科的个人趋势</Sect>
                <div className="flex flex-col gap-1">
                  {sTrend.map((t) => (
                    <div key={`${t.label}-${t.examDate}`} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                      <span style={{ color: 'var(--color-ink3)', width: 74 }}>{t.examDate}</span>
                      <span className="min-w-0 flex-1 truncate">{t.label}</span>
                      <span style={{ width: 70 }}>
                        <Track value={t.rate * 100} />
                      </span>
                      <span className="num" style={{ width: 56, textAlign: 'right' }}>
                        {t.total}/{t.fullScore}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </Sheet>

      {/* ---------------- 档案管理 ---------------- */}
      <Sheet
        open={modeOpen}
        onClose={() => setModeOpen(false)}
        title="档案"
        footer={
          <Button block onClick={() => setModeOpen(false)}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
          <div className="flex items-center gap-2">
            <IconClipboard size={14} />
            {exam.title}
          </div>
          <div className="flex items-center gap-2">
            <IconCalendar size={14} />
            {exam.examDate} · {exam.subject} · {EXAM_SCOPE_TEXT[exam.scope]}
          </div>
          <div className="flex items-center gap-2">
            <IconGrid size={14} />
            {questionCountOf(exam)} 题 · 卷面 {full} 分
          </div>
          <div className="flex items-center gap-2">
            <IconList size={14} />
            {EXAM_MODE_TEXT[exam.mode]}
            {exam.source === 'file' ? ' · 数据来自文件导入' : ' · 手动批阅'}
          </div>
          <div className="flex items-start gap-2">
            <IconUsers size={14} />
            <span>
              参加班级：
              {exam.classIds.map((cid) => classes.find((c) => c.id === cid)?.name ?? '未知班级').join('、') || '—'}
            </span>
          </div>
          {exam.absentNos.length ? (
            <div className="flex items-start gap-2">
              <IconAlert size={14} />
              <span>
                缺考学号：
                {exam.absentNos
                  .map((k) => roster.find((r) => r.studentNo === k)?.displayNo ?? k)
                  .join('、')}
              </span>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            block
            icon={<IconPencil size={14} />}
            onClick={() => navigate(`/exams/${exam.id}/grade`)}
          >
            回去改分数
          </Button>
          <Button
            block
            variant={exam.status === 'graded' ? 'ghost' : 'primary'}
            icon={<IconCheck size={14} />}
            onClick={() => {
              updateExam(exam.id, { status: exam.status === 'graded' ? 'grading' : 'graded' })
              setModeOpen(false)
            }}
          >
            {exam.status === 'graded' ? '退回批阅中' : '标为已完成'}
          </Button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
          退回「批阅中」只是换个状态，<b>不会清掉任何分数</b> —— 之后再回到这一页，统计照样在。
        </p>
        <div className="mt-3 flex items-center gap-1.5" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
          <IconInfo size={12} />
          <IconTarget size={12} />
          要不要删这份档案？在考试列表里点右边的垃圾桶。
        </div>
      </Sheet>
    </>
  )
}
