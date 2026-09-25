import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconMegaphone,
  IconRefresh,
  IconTarget,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, StatStrip, Tag } from '../components/ui'
import { useStore } from '../data/store'
import { BAND_META, gradeStats, humanDuration } from '../lib/grading'
import { friendlyDate } from '../lib/date'
import { archiveValue } from '../lib/keys'

export default function AssignmentGradeDone() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const streakDays = useStore((s) => s.streakDays)

  const students = useMemo(
    () =>
      (klass?.students ?? [])
        .filter((s) => s.status === 'active')
        .sort((a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name, 'zh')),
    [klass],
  )
  const stats = useMemo(
    () => (assignment ? gradeStats(students, assignment) : null),
    [assignment, students],
  )

  /**
   * 极简模式的等级分布。
   *
   * 🔴 极简模式是**另一套数据模型**（§四 4.1）：只有「学号 → 优/良/差」，
   * `wrong` 永远是空的，`questionCount` 只是建档时那个隐藏输入框留下的默认值。
   * 照普通模式渲染这张完成页，教师看到的是
   * 「共 6 题 · 错题 0 · 错误率 0% · 本次没有需要集中讲评的题」——
   * **看起来很正常，其实全是错的**（这是 §九 W16 剩下的最后一处）。
   */
  const simple = assignment?.statsMode === 'simple'
  const grades = assignment?.grades
  const gradeCounts = useMemo(() => {
    const c = { 优: 0, 良: 0, 差: 0 }
    for (const s of students) {
      const g = archiveValue(grades, s)
      if (g === '优' || g === '良' || g === '差') c[g]++
    }
    return c
  }, [students, grades])
  /** 极简模式里"最该面批"的那批人 —— 代替普通模式的「明天讲评的重点」 */
  const badOnes = useMemo(
    () => students.filter((s) => archiveValue(grades, s) === '差'),
    [students, grades],
  )

  if (!assignment || !stats) {
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

  const seconds = assignment.gradeSeconds ?? 0
  const denominator = stats.total * assignment.questionCount
  const overallRate = denominator ? stats.wrongTotal / denominator : 0
  /* 极简模式没有逐题数据，`stats.ranked` 恒为空 —— 直接算「差」的名单 */
  const top = simple ? [] : stats.ranked.slice(0, 3)
  const incomplete = stats.completeness < 1

  return (
    <>
      <PageHead title="完成批改" sub={assignment.title} onBack={() => navigate('/assignments')} />

      <Page>
        {/* 对勾 + 结论 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <div className="flex flex-col items-center px-4 pt-7 pb-5 text-center">
            <svg
              className="draw-check"
              width="62"
              height="62"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-ok)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10.4" />
              <path d="m7.6 12.4 3.1 3.1 6-6.6" />
            </svg>
            <div style={{ fontSize: 19, fontWeight: 680, marginTop: 14 }}>本次批改完成</div>
            <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', marginTop: 3 }}>
              {klass?.name} · {friendlyDate(assignment.assignDate)} ·{' '}
              {simple ? '极简模式 · 只记等级' : `共 ${assignment.questionCount} 题`}
            </div>
          </div>

          <StatStrip
            items={
              simple
                ? [
                    { k: '用时', v: seconds ? humanDuration(seconds) : '—' },
                    { k: '记录', v: `${stats.total} 人` },
                    { k: '优', v: gradeCounts.优, tone: 'var(--color-ok)' },
                    { k: '良', v: gradeCounts.良, tone: 'var(--color-warn)' },
                    { k: '差', v: gradeCounts.差, tone: 'var(--color-bad)' },
                  ]
                : [
                    { k: '用时', v: seconds ? humanDuration(seconds) : '—' },
                    { k: '记录', v: `${stats.total} 人` },
                    { k: '错题', v: stats.wrongTotal, tone: 'var(--color-bad)' },
                    { k: '错误率', v: `${Math.round(overallRate * 100)}%` },
                  ]
            }
          />
        </Panel>

        {/* 完整性说明 */}
        {incomplete ? (
          <div
            className="anim-in mb-4 flex items-start gap-2.5 p-3"
            style={{
              background: 'var(--color-warnsoft)',
              border: '1px solid #ecd9ae',
              borderRadius: 6,
            }}
          >
            <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
              <IconAlert size={16} />
            </span>
            <div style={{ fontSize: 12.5, color: '#8a5a12', lineHeight: 1.65 }}>
              {simple ? '等级录入' : '批改完整度'} {Math.round(stats.completeness * 100)}%：还有{' '}
              {stats.total - stats.confirmedCount} 人{simple ? '没评等级' : '没打开过题号列表'}。
              {simple
                ? '下面的等级分布按现在录入的部分给出。'
                : '下面的结论按现有数据给出，可能会偏低。'}
            </div>
          </div>
        ) : null}

        {/* 讲评重点（普通模式）／最该面批的名单（极简模式） */}
        <div className="mb-4">
          <Sect>{simple ? '这次评「差」的学生 · 建议面批' : '明天讲评的重点已经帮你挑好了'}</Sect>
          <Panel className="overflow-hidden">
            {simple ? (
              badOnes.length === 0 ? (
                <div className="flex items-center gap-2.5 p-3.5">
                  <span style={{ color: 'var(--color-ok)' }}>
                    <IconCheck size={17} />
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                    没有评「差」的学生。
                  </span>
                </div>
              ) : (
                <div className="stagger">
                  {badOnes.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center gap-3 px-3.5 py-3"
                      style={{ borderBottom: '1px solid var(--color-line)' }}
                    >
                      <span
                        className="num grid place-items-center shrink-0"
                        style={{
                          width: 38,
                          height: 38,
                          border: '1px solid var(--color-bad)',
                          borderRadius: 4,
                          background: 'var(--color-badsoft)',
                          fontSize: 15,
                          fontWeight: 700,
                          color: 'var(--color-bad)',
                        }}
                      >
                        {s.studentNo}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div style={{ fontSize: 14, fontWeight: 650 }}>{s.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 2 }}>
                          等级 差 · 建议当面订正
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            ) : top.length === 0 ? (
              <div className="flex items-center gap-2.5 p-3.5">
                <span style={{ color: 'var(--color-ok)' }}>
                  <IconCheck size={17} />
                </span>
                <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                  没有需要集中讲评的题。
                </span>
              </div>
            ) : (
              <div className="stagger">
                {top.map((q) => (
                  <div
                    key={q.seq}
                    className="flex items-center gap-3 px-3.5 py-3"
                    style={{ borderBottom: '1px solid var(--color-line)' }}
                  >
                    <span
                      className="num grid place-items-center shrink-0"
                      style={{
                        width: 38,
                        height: 38,
                        border: '1px solid var(--color-line2)',
                        borderRadius: 4,
                        background: 'var(--color-surface2)',
                        fontSize: 17,
                        fontWeight: 700,
                      }}
                    >
                      {q.seq}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="num" style={{ fontSize: 14, fontWeight: 650 }}>
                          {Math.round(q.rate * 100)}%
                        </span>
                        <Tag tone={BAND_META[q.band].tone}>{BAND_META[q.band].label}</Tag>
                      </div>
                      <div
                        style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 2 }}
                      >
                        {BAND_META[q.band].action}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div
              className="flex items-center gap-2 px-3.5 py-2.5"
              style={{ background: 'var(--color-surface2)', fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              <IconTarget size={13} />
              <span>
                {simple
                  ? '极简模式只记等级，没有逐题数据 —— 所以不给逐题正确率，也不进错题集。'
                  : '分档依据：错误率 30–70% 的题讲评价值最高；低于 10% 建议个别辅导，不占课堂时间。'}
              </span>
            </div>
          </Panel>
        </div>

        {/* 连续使用 */}
        {streakDays > 1 ? (
          <Panel className="mb-4" bodyClass="p-3">
            <div className="flex items-center gap-3">
              <span className="num" style={{ fontSize: 22, fontWeight: 700 }}>
                {streakDays}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                连续使用天数 —— 数据攒得越久，学情判断越准
              </span>
            </div>
          </Panel>
        ) : null}

        <div className="flex gap-2">
          <Button
            block
            icon={<IconRefresh size={16} />}
            onClick={() => navigate(`/assignments/${assignment.id}/grade`)}
          >
            继续修改
          </Button>
          <Button
            block
            variant="primary"
            icon={<IconTarget size={16} />}
            onClick={() => navigate(`/assignments/${assignment.id}/stats`)}
          >
            {simple ? '等级分布' : '逐题统计'}
          </Button>
        </div>

        {/*
          极简模式没有错题数据，`/assignments/:id/call` 那一页（按错题数排序）
          在这份档案上只会显示「有错题 0 人」+ 空名单 —— 又一个"看起来正常其实错了"。
          所以这条入口在极简模式下改去**改错登记**：那里按等级挑人（「全选「差」的」），
          呼叫逻辑是同一套。
        */}
        <Button
          block
          className="mt-2"
          icon={<IconMegaphone size={16} />}
          onClick={() =>
            navigate(
              simple
                ? `/assignments/${assignment.id}/correct`
                : `/assignments/${assignment.id}/call`,
            )
          }
        >
          {simple ? '去改错登记挑人呼叫（按等级）' : '一键呼叫错得较多的学生'}
        </Button>
      </Page>
    </>
  )
}
