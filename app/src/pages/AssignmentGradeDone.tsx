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

export default function AssignmentGradeDone() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const streakDays = useStore((s) => s.streakDays)

  const students = useMemo(
    () => (klass?.students ?? []).filter((s) => s.status === 'active'),
    [klass],
  )
  const stats = useMemo(
    () => (assignment ? gradeStats(students, assignment) : null),
    [assignment, students],
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
  const top = stats.ranked.slice(0, 3)
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
              {klass?.name} · {friendlyDate(assignment.assignDate)} · 共{' '}
              {assignment.questionCount} 题
            </div>
          </div>

          <StatStrip
            items={[
              { k: '用时', v: seconds ? humanDuration(seconds) : '—' },
              { k: '记录', v: `${stats.total} 人` },
              { k: '错题', v: stats.wrongTotal, tone: 'var(--color-bad)' },
              { k: '错误率', v: `${Math.round(overallRate * 100)}%` },
            ]}
          />
        </Panel>

        {/* 完整性说明 */}
        {incomplete ? (
          <div
            className="anim-in mb-4 flex items-start gap-2.5 p-3"
            style={{
              background: 'var(--color-warnsoft)',
              border: '1px solid ***REMOVED***ecd9ae',
              borderRadius: 6,
            }}
          >
            <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
              <IconAlert size={16} />
            </span>
            <div style={{ fontSize: 12.5, color: '***REMOVED***8a5a12', lineHeight: 1.65 }}>
              批改完整度 {Math.round(stats.completeness * 100)}%：还有{' '}
              {stats.total - stats.confirmedCount} 人没打开过题号列表。
              下面的结论按现有数据给出，可能会偏低。
            </div>
          </div>
        ) : null}

        {/* 讲评重点 */}
        <div className="mb-4">
          <Sect>明天讲评的重点已经帮你挑好了</Sect>
          <Panel className="overflow-hidden">
            {top.length === 0 ? (
              <div className="flex items-center gap-2.5 p-3.5">
                <span style={{ color: 'var(--color-ok)' }}>
                  <IconCheck size={17} />
                </span>
                <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                  本次没有需要集中讲评的题 —— 错题都在个别辅导的范围内。
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
                分档依据：错误率 30–70% 的题讲评价值最高；低于 10% 建议个别辅导，不占课堂时间。
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
            逐题统计
          </Button>
        </div>

        <Button
          block
          className="mt-2"
          icon={<IconMegaphone size={16} />}
          onClick={() => navigate(`/assignments/${assignment.id}/call`)}
        >
          一键呼叫错得较多的学生
        </Button>

        <div
          className="mt-3 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
        >
          逐题正确率可下钻到学生名单，呼叫默认按错题数排序、默认不预选、单次最多 8 人。
        </div>
      </Page>
    </>
  )
}
