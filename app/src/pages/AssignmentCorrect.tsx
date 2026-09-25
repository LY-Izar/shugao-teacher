import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconMegaphone, IconRefresh } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { Student } from '../data/types'
import { friendlyDate } from '../lib/date'
import { CALL_LIMIT, composeCallText } from '../lib/calls'
import { archiveKeyOf } from '../lib/keys'

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
  const refreshClassrooms = useStore((s) => s.refreshClassrooms)

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
  /*
   * 🔴 上面这三个名单的键、以及下面 `grades` / `wrong` 的键，**都是档案键**
   *    （迁移后 = 序列号，I40 / `schema.sql` §20）。
   *    所以凡是"读写这些集合"的地方一律 `k(s)`；`{s.studentNo}` 那种**显示**保持不动。
   */
  const k = archiveKeyOf
  /**
   * 极简模式：这份档案**没有错题数据**（`wrong` 永远是空的），
   * 结论只有学号 → 优 / 良 / 差。
   * 照普通模式渲染的话，每个人都会显示"全对"，「全选有错的」「错误率 ≥ 30%」
   * 也永远是空集 —— 改错名单就永远建不起来（见 §五 的提醒）。
   */
  const simple = assignment?.statsMode === 'simple'

  const gradeOf = (no: string) => assignment?.grades?.[no]
  /** 等级 → 颜色，和批改页那三个等级按钮同一套语义 */
  const gradeColor = (g?: string) =>
    g === '优' ? 'var(--color-ok)' : g === '差' ? 'var(--color-bad)' : 'var(--color-warn)'

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
    (s) => correction.includes(k(s)) && !corrected.includes(k(s)),
  )
  const todo = [
    ...todoList.filter((s) => focus.includes(k(s))),
    ...todoList.filter((s) => !focus.includes(k(s))),
  ]
  const done = students.filter((s) => corrected.includes(k(s)))

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
  /**
   * 改名单时**顺手把「已改错」里已经不在名单上的人清掉**。
   *
   * 不过滤的话，名单一收缩就留下孤儿记录：按钮会显示「2/1」这种
   * 「已改的比该改的还多」的数，而且那个人再也点不到 —— 撤销入口跟着名单一起没了。
   */
  const setCorrection = (nos: string[]) =>
    updateAssignment(id, {
      correctionNos: nos,
      correctedNos: corrected.filter((n) => nos.includes(n)),
    })

  const toggleCorrected = (no: string) =>
    setCorrected(corrected.includes(no) ? corrected.filter((x) => x !== no) : [...corrected, no])

  const room = klass?.name ?? ''

  const doCall = async () => {
    if (!callSel.length) return
    try {
      // 发之前重新确认教室端在线（只是提示，不挡发送）
      let online = false
      try {
        const fresh = await refreshClassrooms()
        online = fresh.find((c) => c.classId === assignment.classId)?.online ?? false
      } catch {
        /* 读不到状态不影响发送 */
      }

      sendCall({
        assignmentId: id,
        classId: assignment.classId,
        studentNos: callSel,
        text: composeCallText(callSel, room, assignment.subject, ''),
        room,
      })
      push({
        text: online ? `已呼叫 ${callSel.length} 人` : `已发送 ${callSel.length} 人，但教室端离线`,
        tone: online ? 'ok' : 'warn',
        desc: online ? '教室端会响铃并按学号播报' : '刚才重新检测过：教室端不在线，学生可能听不到',
      })
      setCallSel([])
      setCalling(false)
    } catch (e) {
      push({ text: e instanceof Error ? e.message : '呼叫失败', tone: 'bad' })
    }
  }

  const Row = ({ s, on, onClick }: { s: Student; on: boolean; onClick: () => void }) => {
    const wc = wrongOf(k(s))
    const r = rateOf(k(s))
    const grade = gradeOf(k(s))
    const col = simple
      ? grade
        ? gradeColor(grade)
        : 'var(--color-ink3)'
      : r >= 0.3
        ? 'var(--color-bad)'
        : r > 0
          ? 'var(--color-warn)'
          : 'var(--color-ok)'
    const focused = focus.includes(k(s))
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
            {simple
              ? grade
                ? `等级 ${grade}`
                : '还没评等级'
              : wc
                ? `错 ${wc} 处 · ${Math.round(r * 100)}%`
                : '全对'}
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
                setCallSel(todo.map((s) => k(s)).slice(0, CALL_LIMIT))
                setCalling(true)
              }}
            >
              呼叫
            </Button>
          </div>
          <Panel className="overflow-hidden">
            {todo.length === 0 ? (
              <div className="px-3 py-6 text-center" style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
                {correction.length === 0 ? '还没有改错名单' : '都改完了 🎉'}
              </div>
            ) : (
              todo.map((s, i) => (
                <div key={s.id} style={{ borderBottom: i === todo.length - 1 ? undefined : '1px solid var(--color-line)' }}>
                  <Row s={s} on={false} onClick={() => toggleCorrected(k(s))} />
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
                  <Row s={s} on onClick={() => toggleCorrected(k(s))} />
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
            .filter((s) => correction.includes(k(s)))
            .map((s) => {
              const on = callSel.includes(k(s))
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
                        c.includes(k(s))
                          ? c.filter((x) => x !== k(s))
                          : c.length >= CALL_LIMIT
                            ? c
                            : [...c, k(s)],
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
                  {corrected.includes(k(s)) ? <Tag tone="ok">已改</Tag> : null}
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
          {/*
            极简模式没有错题，"全选有错的""错误率"两键必然是空集 ——
            那两键留着只会让人以为"这份作业没人要改错"。按等级挑人。
          */}
          {simple ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCorrection(students.filter((s) => gradeOf(k(s)) === '差').map((s) => k(s)))}
              >
                全选「差」的
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCorrection(
                    students
                      .filter((s) => {
                        const g = gradeOf(k(s))
                        return g === '差' || g === '良'
                      })
                      .map((s) => k(s)),
                  )
                }
              >
                选「良」和「差」
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCorrection(students.filter((s) => wrongOf(k(s)) > 0).map((s) => k(s)))}
              >
                全选有错的
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCorrection(students.filter((s) => rateOf(k(s)) >= 0.3).map((s) => k(s)))}
              >
                错误率 ≥ 30%
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setCorrection([])}>
            清空
          </Button>
        </div>
        <div style={{ maxHeight: '56vh', overflowY: 'auto' }}>
          {students.map((s) => {
            const on = correction.includes(k(s))
            const wc = wrongOf(k(s))
            const r = rateOf(k(s))
            const grade = gradeOf(k(s))
            const col = simple
              ? grade
                ? gradeColor(grade)
                : 'var(--color-ink3)'
              : r >= 0.3
                ? 'var(--color-bad)'
                : r > 0
                  ? 'var(--color-warn)'
                  : 'var(--color-ok)'
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
                    setCorrection(on ? correction.filter((x) => x !== k(s)) : [...correction, k(s)])
                  }
                  style={{ width: 16, height: 16, accentColor: 'var(--color-accent)', flexShrink: 0 }}
                />
                <span className="num shrink-0" style={{ fontSize: 13.5, fontWeight: 700, minWidth: 24 }}>
                  {s.studentNo}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5 }}>
                  {s.name}
                </span>
                {focus.includes(k(s)) ? <Tag tone="warn">重点</Tag> : null}
                <span className="num shrink-0" style={{ fontSize: 12.5, fontWeight: 700, color: col }}>
                  {simple ? (grade ?? '未评') : wc ? `错 ${wc}` : '全对'}
                </span>
                {corrected.includes(k(s)) ? (
                  <button
                    type="button"
                    onClick={() => toggleCorrected(k(s))}
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
