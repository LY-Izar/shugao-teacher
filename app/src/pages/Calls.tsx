import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { CallCard, NEXT_STATE } from '../components/CallCard'
import { IconMegaphone } from '../components/icons'
import { Button, Empty, PageHead, Panel, StatStrip } from '../components/ui'
import { useStore, useToast } from '../data/store'

export default function Calls() {
  const calls = useStore((s) => s.calls)
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const repeatCall = useStore((s) => s.repeatCall)
  const setCallState = useStore((s) => s.setCallState)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const rows = useMemo(
    () =>
      [...calls]
        .sort(
          (a, b) => (b.sentAt[b.sentAt.length - 1] ?? 0) - (a.sentAt[a.sentAt.length - 1] ?? 0),
        )
        .map((c) => {
          const klass = classes.find((k) => k.id === c.classId)
          const assignment = assignments.find((a) => a.id === c.assignmentId)
          return {
            call: c,
            students: (klass?.students ?? []).filter((s) => s.status === 'active'),
            context: `${assignment?.title ?? '作业已删除'} · ${klass?.name ?? ''}`,
          }
        }),
    [calls, classes, assignments],
  )

  const totalStudentCalls = calls.reduce((n, c) => n + c.studentNos.length, 0)
  const corrected = calls.reduce(
    (n, c) => n + c.studentNos.filter((no) => c.states[no] === 'corrected').length,
    0,
  )

  return (
    <>
      <PageHead
        title="呼叫记录"
        sub={`${calls.length} 次呼叫 · 仅教师可见`}
        onBack={() => navigate('/assignments')}
      />

      <Page>
        {calls.length === 0 ? (
          <Panel>
            <Empty
              icon={<IconMegaphone size={24} />}
              title="还没有呼叫记录"
              desc="在「作业情况」页挑出错得较多的学生，一次叫 3–8 个人到办公室面批。"
              action={
                <Button size="sm" variant="primary" onClick={() => navigate('/assignments')}>
                  去看作业情况
                </Button>
              }
            />
          </Panel>
        ) : (
          <>
            <Panel className="anim-in mb-4 overflow-hidden">
              <StatStrip
                items={[
                  { k: '呼叫次数', v: calls.length },
                  { k: '涉及人次', v: totalStudentCalls },
                  { k: '已订正', v: corrected, tone: 'var(--color-ok)' },
                ]}
              />
            </Panel>

            <div className="flex flex-col gap-2.5 stagger">
              {/* 只显示最近 3 条 —— 记录堆长了没用，真正要跟进的是最近这次 */}
              {rows.slice(0, 3).map(({ call, students, context }) => (
                <CallCard
                  key={call.id}
                  call={call}
                  students={students}
                  context={context}
                  onRepeat={() => {
                    repeatCall(call.id)
                    push({ text: '已重播一遍', tone: 'ok' })
                  }}
                  onAdvance={(no) => {
                    const cur = call.states[no] ?? 'called'
                    setCallState(call.id, no, NEXT_STATE[cur])
                  }}
                />
              ))}
            </div>

            {rows.length > 3 ? (
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, paddingLeft: 2 }}>
                只显示最近 3 条（共 <span className="num">{rows.length}</span> 条记录）
              </p>
            ) : null}

            <div
              className="mt-4 px-1"
              style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
            >
              记录只用于教师自己跟进订正进度。<b>不做被叫次数排行</b> ——
              一旦变成可比较的数字，它就会变成压力工具，而不是教学工具。
            </div>
          </>
        )}
      </Page>
    </>
  )
}
