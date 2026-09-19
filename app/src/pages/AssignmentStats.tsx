import { Fragment, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconMegaphone,
  IconTarget,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, StatStrip, Tag } from '../components/ui'
import { useStore } from '../data/store'
import type { Student } from '../data/types'
import { collectStats } from '../lib/assignments'
import { BAND_META, BAND_ORDER, gradeStats } from '../lib/grading'
import { wrongStudents } from '../lib/calls'
import { friendlyDate } from '../lib/date'

export default function AssignmentStats() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const [openSeq, setOpenSeq] = useState<number | null>(null)
  const [showRule, setShowRule] = useState(false)

  const students: Student[] = useMemo(
    () => (klass?.students ?? []).filter((s) => s.status === 'active'),
    [klass],
  )
  const stats = useMemo(
    () => (assignment ? gradeStats(students, assignment) : null),
    [assignment, students],
  )
  const collect = useMemo(
    () => (assignment ? collectStats(klass?.students ?? [], assignment) : null),
    [assignment, klass],
  )
  const needCall = useMemo(
    () => (assignment ? wrongStudents(students, assignment) : []),
    [assignment, students],
  )

  if (!assignment || !stats || !collect) {
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

  const incomplete = stats.completeness < 1
  const top = stats.ranked.slice(0, 3)
  const nameOf = (no: string) => students.find((s) => s.studentNo === no)?.name ?? ''

  return (
    <>
      <PageHead
        title="作业情况"
        sub={`${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · ${assignment.questionCount} 题`}
        onBack={() => navigate('/assignments')}
        right={
          <Button
            size="sm"
            variant="primary"
            icon={<IconMegaphone size={15} />}
            disabled={needCall.length === 0}
            onClick={() => navigate(`/assignments/${assignment.id}/call`)}
          >
            呼叫
          </Button>
        }
      />

      <Page>
        {/* 收缴概览 */}
        <Panel className="anim-in mb-3 overflow-hidden">
          <StatStrip
            items={[
              { k: '应交', v: collect.total },
              { k: '已交', v: collect.submitted, tone: 'var(--color-ok)' },
              {
                k: '未交',
                v: collect.missing,
                tone: collect.missing ? 'var(--color-bad)' : 'var(--color-ink4)',
              },
              {
                k: '迟交',
                v: collect.late,
                tone: collect.late ? 'var(--color-warn)' : 'var(--color-ink4)',
              },
            ]}
          />
        </Panel>

        {incomplete ? (
          <div
            className="anim-in mb-3 flex items-start gap-2.5 p-3"
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
              批改完整度 <b className="num">{Math.round(stats.completeness * 100)}%</b>：
              还有 <b className="num">{stats.total - stats.confirmedCount}</b> 人没打开过题号列表，
              下面的错误率可能偏低。
            </div>
          </div>
        ) : null}

        {/* 逐题错误率 */}
        <div className="mb-4">
          <Sect>逐题错误率 · 点一行看是谁错了</Sect>
          <Panel className="overflow-hidden">
            {/* 图例 */}
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
              style={{ borderBottom: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
            >
              {BAND_ORDER.map((b) => (
                <span
                  key={b}
                  className="flex items-center gap-1.5"
                  style={{ fontSize: 11, color: 'var(--color-ink3)' }}
                >
                  <i
                    style={{
                      width: 10,
                      height: 3,
                      borderRadius: 2,
                      background: BAND_META[b].color,
                      display: 'inline-block',
                    }}
                  />
                  {BAND_META[b].label}
                </span>
              ))}
            </div>

            {stats.questions.map((q) => {
              const meta = BAND_META[q.band]
              const open = openSeq === q.seq
              return (
                <Fragment key={q.seq}>
                  <button
                    type="button"
                    className="row"
                    style={{ padding: '10px 12px', gap: 10 }}
                    onClick={() => setOpenSeq(open ? null : q.seq)}
                    aria-label={`第 ${q.seq} 题 错误率 ${Math.round(q.rate * 100)}%`}
                  >
                    <span
                      className="num grid place-items-center shrink-0"
                      style={{
                        width: 30,
                        height: 30,
                        border: '1px solid var(--color-line2)',
                        borderRadius: 4,
                        background: 'var(--color-surface2)',
                        fontSize: 13.5,
                        fontWeight: 700,
                      }}
                    >
                      {q.seq}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className="num"
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: q.wrongCount ? meta.color : 'var(--color-ink4)',
                            minWidth: 42,
                          }}
                        >
                          {Math.round(q.rate * 100)}%
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                          <b className="num">{q.wrongCount}</b> 人错
                          {q.subCount > 0 ? ` · ${q.subCount} 个小题` : ''}
                        </span>
                        <span className="flex-1" />
                        {q.wrongCount > 0 ? <Tag tone={meta.tone}>{meta.label}</Tag> : null}
                      </span>
                      <span className="mt-1.5 block">
                        <span
                          style={{
                            display: 'block',
                            height: 5,
                            background: 'var(--color-surface3)',
                            borderRadius: 3,
                            overflow: 'hidden',
                          }}
                        >
                          <i
                            style={{
                              display: 'block',
                              height: '100%',
                              width: `${Math.max(2, q.rate * 100)}%`,
                              background: meta.color,
                              borderRadius: 3,
                              transition: 'width .5s cubic-bezier(.22,.8,.24,1)',
                            }}
                          />
                        </span>
                      </span>
                    </span>

                    <IconChevronRight
                      size={15}
                      style={{
                        transform: open ? 'rotate(90deg)' : 'none',
                        transition: 'transform .2s',
                        color: 'var(--color-ink4)',
                      }}
                    />
                  </button>

                  {open ? (
                    <div
                      className="anim-in px-3 py-3"
                      style={{ background: 'var(--color-surface2)', borderBottom: '1px solid var(--color-line)' }}
                    >
                      <div className="mb-2 flex items-center gap-2" style={{ fontSize: 12 }}>
                        <IconTarget size={13} />
                        <span style={{ color: 'var(--color-ink2)', fontWeight: 600 }}>
                          {meta.label}
                        </span>
                        <span style={{ color: 'var(--color-ink3)' }}>{meta.action}</span>
                      </div>
                      {q.wrongNos.length === 0 ? (
                        <span style={{ fontSize: 12.5, color: 'var(--color-ok)' }}>
                          这一题全班都对
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {q.wrongNos.map((no) => (
                            <span
                              key={no}
                              className="flex items-center gap-1.5 px-2 py-1"
                              style={{
                                background: 'var(--color-badsoft)',
                                borderRadius: 3,
                                fontSize: 12.5,
                                color: 'var(--color-bad)',
                              }}
                            >
                              <b className="num">{no}</b>
                              {nameOf(no)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </Fragment>
              )
            })}
          </Panel>
        </div>

        {/* 讲评建议 */}
        <div className="mb-4">
          <Sect>讲评建议</Sect>
          <Panel className="overflow-hidden">
            {top.length === 0 ? (
              <div className="flex items-center gap-2.5 p-3.5">
                <span style={{ color: 'var(--color-ok)' }}>
                  <IconCheck size={17} />
                </span>
                <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                  没有需要集中讲评的题 —— 错题都在个别辅导的范围内。
                </span>
              </div>
            ) : (
              <div className="stagger">
                {top.map((q, i) => (
                  <div
                    key={q.seq}
                    className="flex items-start gap-3 px-3.5 py-3"
                    style={{ borderBottom: '1px solid var(--color-line)' }}
                  >
                    <span
                      className="num grid place-items-center shrink-0"
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 99,
                        background: i === 0 ? 'var(--color-bad)' : 'var(--color-surface3)',
                        color: i === 0 ? '***REMOVED***fff' : 'var(--color-ink3)',
                        fontSize: 11,
                        fontWeight: 700,
                        marginTop: 2,
                      }}
                    >
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="num" style={{ fontSize: 14, fontWeight: 650 }}>
                          第 {q.seq} 题
                        </span>
                        <span className="num" style={{ fontSize: 13, color: BAND_META[q.band].color, fontWeight: 700 }}>
                          {Math.round(q.rate * 100)}%
                        </span>
                        <Tag tone={BAND_META[q.band].tone}>{BAND_META[q.band].label}</Tag>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 2 }}>
                        {BAND_META[q.band].action}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div
              className="px-3.5 py-2.5"
              style={{ background: 'var(--color-surface2)', fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              分档依据：错误率 30–70% 的题讲评价值最高；低于 10% 建议个别辅导，不占课堂时间。
            </div>
          </Panel>
        </div>

        {/* 关注名单 */}
        <div className="mb-4">
          <Sect>关注名单 · 错得最多的学生</Sect>
          <Panel className="overflow-hidden">
            {needCall.length === 0 ? (
              <div className="p-3.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                没有学生做错
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5 p-3">
                {needCall.slice(0, 10).map((w) => (
                  <span
                    key={w.student.id}
                    className="flex items-center gap-1.5 px-2 py-1"
                    style={{
                      background: 'var(--color-surface2)',
                      border: '1px solid var(--color-line)',
                      borderRadius: 3,
                      fontSize: 12.5,
                    }}
                  >
                    <b className="num" style={{ color: 'var(--color-bad)' }}>
                      {w.student.studentNo}
                    </b>
                    {w.student.name}
                    <span className="num" style={{ color: 'var(--color-ink3)', fontSize: 11 }}>
                      {w.count} 处
                    </span>
                  </span>
                ))}
                {needCall.length > 10 ? (
                  <span style={{ fontSize: 12, color: 'var(--color-ink3)', alignSelf: 'center' }}>
                    等共 {needCall.length} 人
                  </span>
                ) : null}
              </div>
            )}
          </Panel>
        </div>

        {/* 口径 */}
        <Panel className="mb-4" bodyClass="px-3.5 py-2.5">
          <button
            type="button"
            className="flex w-full items-center gap-2"
            onClick={() => setShowRule((v) => !v)}
          >
            <IconInfo size={14} />
            <span style={{ fontSize: 12.5, color: 'var(--color-ink2)', fontWeight: 550 }}>
              统计口径说明
            </span>
            <span className="flex-1" />
            {showRule ? <IconX size={14} /> : <IconChevronRight size={14} />}
          </button>
          {showRule ? (
            <ul
              className="anim-in"
              style={{
                fontSize: 12,
                color: 'var(--color-ink3)',
                lineHeight: 1.85,
                paddingLeft: 16,
                listStyle: 'disc',
                marginTop: 8,
              }}
            >
              <li>
                错误率 = 该题做错人数 ÷ <b>应交人数</b>（用应交而非实交，避免缺交把错误率压低）
              </li>
              <li>有小题的题，任一小题错即计入该题错误人数</li>
              <li>批改完整度 = 打开过题号列表的人数 ÷ 应交人数</li>
              <li>未交学生不计入错误率分母之外的任何统计</li>
            </ul>
          ) : null}
        </Panel>

        <div className="flex gap-2">
          <Button
            block
            icon={<IconTarget size={16} />}
            onClick={() => navigate(`/assignments/${assignment.id}/grade`)}
          >
            继续修改批改
          </Button>
          <Button
            block
            variant="primary"
            icon={<IconMegaphone size={16} />}
            disabled={needCall.length === 0}
            onClick={() => navigate(`/assignments/${assignment.id}/call`)}
          >
            呼叫 {needCall.length} 人
          </Button>
        </div>
      </Page>
    </>
  )
}
