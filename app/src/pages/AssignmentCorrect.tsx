import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconMegaphone, IconRefresh } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { Student } from '../data/types'
import { friendlyDate } from '../lib/date'
import { CALL_LIMIT, composeCallText } from '../lib/calls'

/**
 * 改错登记。
 *
 * 两张表在页面上的位置很讲究：
 *  · 上：**待改错** —— 点一下 = 他已经改好了，降到下边
 *  · 下：**已改错** —— 点一下 = 撤销
 *
 * 「需重点关注」的人**置顶 + 变色**：他们是教师批改时单独标的，
 * 改错时最该盯的就是这几个。
 */
export default function AssignmentCorrect() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const updateAssignment = useStore((s) => s.updateAssignment)
  const sendCall = useStore((s) => s.sendCall)

  const [editList, setEditList] = useState(false)
  const [calling, setCalling] = useState(false)
  const [callSel, setCallSel] = useState<string[]>([])

  const students: Student[] = useMemo(
    () =>
      (klass?.students ?? [])
        .filter((s) => s.status === 'active')
        .sort((a, b) => Number(a.studentNo) - Number(b.studentNo)),
    [klass],
  )

  const correction = assignment?.correctionNos ?? []
  const corrected = assignment?.correctedNos ?? []
  const focus = assignment?.focusNos ?? []

  const rateOf = (no: string) => {
    const wc = assignment?.wrong?.[no]?.length ?? 0
    return wc / Math.max(1, assignment?.questionCount ?? 1)
  }
  const wrongOf = (no: string) => assignment?.wrong?.[no]?.length ?? 0

  /**
   * 待改错：重点关注置顶，其余按学号。
   * 不用 useMemo —— 上面几个数组来自 `?? []`，每次渲染都是新引用，
   * memo 既挡不住重算又会报依赖警告；班级几十人，直接算更省心。
   */
  const todoList = students.filter(
    (s) => correction.includes(s.studentNo) && !corrected.includes(s.studentNo),
  )
  const todo = [
    ...todoList.filter((s) => focus.includes(s.studentNo)),
    ...todoList.filter((s) => !focus.includes(s.studentNo)),
  ]
  const done = students.filter((s) => corrected.includes(s.studentNo))

  if (!assignment) {
    return (
      <>
        <PageHead title="档案不存在" onBack={() => navigate('/assignments')} />
        <Page>
          <Empty icon={<IconRefresh size={20} />} title="这份作业档案已被删除" />
        </Page>
      </>
    )
  }

  const setCorrected = (nos: string[]) => updateAssignment(id, { correctedNos: nos })
  const setCorrection = (nos: string[]) => updateAssignment(id, { correctionNos: nos })

  const toggleCorrected = (no: string) =>
    setCorrected(corrected.includes(no) ? corrected.filter((x) => x !== no) : [...corrected, no])

  const room = klass?.name ?? ''

  const doCall = () => {
    if (!callSel.length) return
    sendCall({
      assignmentId: id,
      classId: assignment.classId,
      studentNos: callSel,
      text: composeCallText(callSel, room, assignment.subject, ''),
      room,
    })
    push({ text: `已呼叫 ${callSel.length} 人，教室端会播报`, tone: 'ok' })
    setCallSel([])
    setCalling(false)
  }

  const Row = ({ s, on, onClick }: { s: Student; on: boolean; onClick: () => void }) => {
    const wc = wrongOf(s.studentNo)
    const r = rateOf(s.studentNo)
    const col = r >= 0.3 ? 'var(--color-bad)' : r > 0 ? 'var(--color-warn)' : 'var(--color-ok)'
    const focused = focus.includes(s.studentNo)
    return (
      <button
        type="button"
        onClick={onClick}
        className="row w-full"
        style={{
          padding: '11px 12px',
          background: focused ? 'var(--color-warnsoft)' : undefined,
          borderLeft: focused ? '3px solid var(--color-warn)' : '3px solid transparent',
        }}
      >
        <span
          className="num grid shrink-0 place-items-center"
          style={{
            width: 34,
            height: 34,
            borderRadius: 99,
            border: `1.5px solid ${on ? 'var(--color-ok)' : 'var(--color-line2)'}`,
            background: on ? 'var(--color-oksoft)' : 'var(--color-surface2)',
            fontSize: 12.5,
            fontWeight: 700,
            color: on ? 'var(--color-ok)' : 'var(--color-ink)',
          }}
        >
          {s.studentNo}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate" style={{ fontSize: 14.5, fontWeight: 560 }}>
              {s.name}
            </span>
            {focused ? <Tag tone="warn">需重点关注</Tag> : null}
          </span>
          <span className="num mt-0.5 block" style={{ fontSize: 11.5, color: col }}>
            {wc ? `错 ${wc} 处 · ${Math.round(r * 100)}%` : '全对'}
          </span>
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          {on ? '已改错' : '点一下记已改'}
        </span>
      </button>
    )
  }

  return (
    <>
      <PageHead
        title="改错登记"
        sub={`${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · 需改 ${correction.length} 人`}
        onBack={() => navigate('/assignments')}
        right={
          <Button size="sm" variant="ghost" icon={<IconRefresh size={15} />} onClick={() => setEditList(true)}>
            更改名单
          </Button>
        }
      />

      <Page>
        {/* 待改错 */}
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <Sect>待改错 · {todo.length} 人</Sect>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              icon={<IconMegaphone size={15} />}
              onClick={() => {
                // 默认勾上待改错的人 —— 叫的就是他们
                setCallSel(todo.map((s) => s.studentNo).slice(0, CALL_LIMIT))
                setCalling(true)
              }}
            >
              呼叫
            </Button>
          </div>
          <Panel className="overflow-hidden">
            {todo.length === 0 ? (
              <div className="px-3 py-6 text-center" style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
                {correction.length === 0
                  ? '这份作业还没有改错名单。点右上角「更改名单」挑人。'
                  : '都改完了 🎉'}
              </div>
            ) : (
              todo.map((s, i) => (
                <div key={s.id} style={{ borderBottom: i === todo.length - 1 ? undefined : '1px solid var(--color-line)' }}>
                  <Row s={s} on={false} onClick={() => toggleCorrected(s.studentNo)} />
                </div>
              ))
            )}
          </Panel>
        </div>

        {/* 已改错 */}
        {done.length ? (
          <div className="mb-4">
            <Sect>已改错 · {done.length} 人 · 点一下撤销</Sect>
            <Panel className="overflow-hidden">
              {done.map((s, i) => (
                <div key={s.id} style={{ borderBottom: i === done.length - 1 ? undefined : '1px solid var(--color-line)' }}>
                  <Row s={s} on onClick={() => toggleCorrected(s.studentNo)} />
                </div>
              ))}
            </Panel>
          </div>
        ) : null}

        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          置顶带黄底的是<b>需重点关注</b>的学生 —— 你在批改时单独标过的，
          改错时最该盯的就是这几个。
        </p>
      </Page>

      {/* 呼叫：勾人选，逻辑和原来的呼叫一致 */}
      <Sheet open={calling} onClose={() => setCalling(false)} title="呼叫来改错">
        <p style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
          勾选要叫的同学（最多 {CALL_LIMIT} 人），确认后教室端会响铃并按学号播报。
        </p>
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          {students
            .filter((s) => correction.includes(s.studentNo))
            .map((s) => {
              const on = callSel.includes(s.studentNo)
              return (
                <label
                  key={s.id}
                  className="flex items-center gap-2.5 px-1 py-2"
                  style={{ borderBottom: '1px solid var(--color-line)', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setCallSel((c) =>
                        c.includes(s.studentNo)
                          ? c.filter((x) => x !== s.studentNo)
                          : c.length >= CALL_LIMIT
                            ? c
                            : [...c, s.studentNo],
                      )
                    }
                    style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
                  />
                  <span className="num" style={{ fontSize: 13.5, fontWeight: 700, minWidth: 24 }}>
                    {s.studentNo}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                    {s.name}
                  </span>
                  {corrected.includes(s.studentNo) ? <Tag tone="ok">已改</Tag> : null}
                </label>
              )
            })}
        </div>
        <div className="mt-3 flex gap-2">
          <Button block onClick={() => setCalling(false)}>
            取消
          </Button>
          <Button block variant="primary" disabled={!callSel.length} onClick={doCall}>
            确认呼叫（{callSel.length}）
          </Button>
        </div>
      </Sheet>

      {/* 更改名单：保留已选状态，可增删；已登记过的再点一下取消登记 */}
      <Sheet open={editList} onClose={() => setEditList(false)} title="改错名单">
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCorrection(students.filter((s) => wrongOf(s.studentNo) > 0).map((s) => s.studentNo))}
          >
            全选有错的
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCorrection(students.filter((s) => rateOf(s.studentNo) >= 0.3).map((s) => s.studentNo))}
          >
            错误率 ≥ 30%
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCorrection([])}>
            清空
          </Button>
        </div>
        <div style={{ maxHeight: '56vh', overflowY: 'auto' }}>
          {students.map((s) => {
            const on = correction.includes(s.studentNo)
            const wc = wrongOf(s.studentNo)
            const r = rateOf(s.studentNo)
            const col = r >= 0.3 ? 'var(--color-bad)' : r > 0 ? 'var(--color-warn)' : 'var(--color-ok)'
            return (
              <div
                key={s.id}
                className="flex items-center gap-2.5 px-1 py-2"
                style={{ borderBottom: '1px solid var(--color-line)' }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setCorrection(on ? correction.filter((x) => x !== s.studentNo) : [...correction, s.studentNo])
                  }
                  style={{ width: 16, height: 16, accentColor: 'var(--color-accent)', flexShrink: 0 }}
                />
                <span className="num shrink-0" style={{ fontSize: 13.5, fontWeight: 700, minWidth: 24 }}>
                  {s.studentNo}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                  {s.name}
                </span>
                {focus.includes(s.studentNo) ? <Tag tone="warn">重点</Tag> : null}
                <span className="num shrink-0" style={{ fontSize: 12.5, fontWeight: 700, color: col }}>
                  {wc ? `错 ${wc}` : '全对'}
                </span>
                {corrected.includes(s.studentNo) ? (
                  <button
                    type="button"
                    onClick={() => toggleCorrected(s.studentNo)}
                    style={{ fontSize: 11.5, color: 'var(--color-ok)', textDecoration: 'underline', flexShrink: 0 }}
                  >
                    已改·撤销
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
        <Button block variant="primary" className="mt-3" onClick={() => setEditList(false)}>
          完成（{correction.length} 人）
        </Button>
      </Sheet>
    </>
  )
}
