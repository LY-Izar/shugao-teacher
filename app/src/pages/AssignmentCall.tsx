import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconMegaphone,
  IconSend,
  IconWifi,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { CallCard, NEXT_STATE } from '../components/CallCard'
import { useStore, useToast } from '../data/store'
import { CALL_STATE_TEXT, type Student } from '../data/types'
import { gradeStats } from '../lib/grading'
import {
  CALL_LIMIT,
  CUSTOM_MAX,
  DEFAULT_ROOM,
  composeCallText,
  latestCallStates,
  wrongStudents,
  wrongStudentsOfQuestion,
} from '../lib/calls'
import { friendlyDate } from '../lib/date'
import { emit } from '../lib/realtime'

export default function AssignmentCall() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const classrooms = useStore((s) => s.classrooms)
  const calls = useStore((s) => s.calls)
  const sendCall = useStore((s) => s.sendCall)
  const repeatCall = useStore((s) => s.repeatCall)
  const setCallState = useStore((s) => s.setCallState)
  const setClassroomOnline = useStore((s) => s.setClassroomOnline)

  const [mode, setMode] = useState<'all' | 'byQuestion'>('all')
  const [seq, setSeq] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [room, setRoom] = useState(DEFAULT_ROOM)
  const [custom, setCustom] = useState('')
  const [preview, setPreview] = useState(false)

  const students: Student[] = useMemo(
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

  const list = useMemo(() => {
    if (!assignment) return []
    return mode === 'all' ? wrongStudents(students, assignment) : wrongStudentsOfQuestion(students, assignment, seq)
  }, [assignment, students, mode, seq])

  const myCalls = useMemo(
    () =>
      calls
        .filter((c) => c.assignmentId === id)
        .sort((a, b) => (b.sentAt[b.sentAt.length - 1] ?? 0) - (a.sentAt[a.sentAt.length - 1] ?? 0)),
    [calls, id],
  )

  const calledStates = useMemo(() => latestCallStates(calls, id), [calls, id])

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

  const room_client = classrooms.find((c) => c.classId === assignment.classId)
  const subject = assignment.subject
  const text = composeCallText(selected, room, subject, custom)
  const atLimit = selected.length >= CALL_LIMIT

  const toggle = (no: string) => {
    setSelected((cur) => {
      if (cur.includes(no)) return cur.filter((x) => x !== no)
      if (cur.length >= CALL_LIMIT) {
        push({ text: `单次最多叫 ${CALL_LIMIT} 人`, tone: 'warn', desc: '超出请分批呼叫' })
        return cur
      }
      return [...cur, no]
    })
  }

  const doSend = () => {
    if (selected.length === 0) return
    const rec = sendCall({
      assignmentId: assignment.id,
      classId: assignment.classId,
      studentNos: selected,
      text,
      room,
    })
    // 推给教室端（当前是本地通道；接 Supabase 后换成 Realtime 即可）
    emit({ type: 'call', call: rec })
    push({
      text: room_client?.online ? '已发送到教室端' : '已记录，但教室端当前离线',
      tone: room_client?.online ? 'ok' : 'warn',
      desc: room_client?.online ? text : '学生可能听不到，请检查一体机',
    })
    setSelected([])
  }

  return (
    <>
      <PageHead
        title="改错呼叫"
        sub={`${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)}`}
        onBack={() => navigate('/assignments')}
        right={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconChevronRight size={15} />}
            onClick={() => navigate('/calls')}
          >
            记录
          </Button>
        }
      />

      <Page>
        {/* 教室端状态 */}
        <Panel className="anim-in mb-3" bodyClass="p-3">
          <div className="flex items-center gap-2.5">
            <span
              className={room_client?.online ? 'live-dot' : ''}
              style={{
                width: 8,
                height: 8,
                borderRadius: 99,
                background: room_client?.online ? 'var(--color-ok)' : 'var(--color-warn)',
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>
              {room_client?.name ?? '未绑定教室端'}
            </span>
            <Tag tone={room_client?.online ? 'ok' : 'warn'}>
              {room_client?.online ? '在线' : '离线'}
            </Tag>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => room_client && setClassroomOnline(room_client.id, !room_client.online)}
              style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
            >
              切换状态
            </button>
          </div>
          <div
            className="mt-2 flex items-start gap-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.6 }}
          >
            <IconWifi size={13} />
            <span>
              {room_client?.online
                ? '播报前会先响一声提示音，语音用系统 TTS 播放，被切信号源也能出声。'
                : '教室端当前离线 —— 呼叫会被记录，但学生很可能听不到，请先检查一体机。'}
            </span>
          </div>
        </Panel>

        {/* 概览 */}
        <Panel className="mb-3 overflow-hidden">
          <StatStrip
            items={[
              { k: '有错题', v: wrongStudents(students, assignment).length, tone: 'var(--color-bad)' },
              { k: '已选', v: `${selected.length}/${CALL_LIMIT}` },
              { k: '已叫过', v: calledStates.size, tone: 'var(--color-ink3)' },
            ]}
          />
        </Panel>

        {/* 筛选 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="seg">
            <button type="button" data-on={mode === 'all'} onClick={() => setMode('all')}>
              全部错题学生
            </button>
            <button
              type="button"
              data-on={mode === 'byQuestion'}
              onClick={() => setMode('byQuestion')}
            >
              按题号
            </button>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setSelected([])}
            style={{ fontSize: 12, color: 'var(--color-ink3)' }}
          >
            清空选择
          </button>
        </div>

        {mode === 'byQuestion' ? (
          <Panel className="mb-3" bodyClass="p-3">
            <div className="mb-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
              选一道题，把错这道题的人都叫来 —— 面批同一道题效率最高
            </div>
            <div className="flex flex-wrap gap-1.5">
              {stats.questions.map((q) => {
                const on = seq === q.seq
                return (
                  <button
                    key={q.seq}
                    type="button"
                    onClick={() => setSeq(q.seq)}
                    disabled={q.wrongCount === 0}
                    className="num grid place-items-center"
                    style={{
                      width: 34,
                      height: 34,
                      border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                      background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                      color: on
                        ? 'var(--color-accentink)'
                        : q.wrongCount === 0
                          ? 'var(--color-ink4)'
                          : 'var(--color-ink)',
                      borderRadius: 4,
                      fontSize: 14,
                      fontWeight: 700,
                      position: 'relative',
                      opacity: q.wrongCount === 0 ? 0.45 : 1,
                    }}
                  >
                    {q.seq}
                    {q.wrongCount > 0 ? (
                      <span
                        className="num"
                        style={{
                          position: 'absolute',
                          top: -5,
                          right: -5,
                          minWidth: 15,
                          height: 15,
                          padding: '0 3px',
                          borderRadius: 99,
                          background: 'var(--color-bad)',
                          color: '***REMOVED***fff',
                          fontSize: 9.5,
                          lineHeight: '15px',
                          fontWeight: 700,
                        }}
                      >
                        {q.wrongCount}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </Panel>
        ) : null}

        {/* 学生列表：按错题数从多到少 */}
        <div className="mb-3">
          <Sect>按错题数排序 · 点一下选中</Sect>
          <Panel className="overflow-hidden">
            {list.length === 0 ? (
              <div className="p-3.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                没有需要呼叫的学生
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-2.5 sm:grid-cols-3">
                {list.map((w) => {
                  const on = selected.includes(w.student.studentNo)
                  const called = calledStates.get(w.student.studentNo)
                  const disabled = !on && atLimit
                  return (
                    <button
                      key={w.student.id}
                      type="button"
                      onClick={() => toggle(w.student.studentNo)}
                      className="relative flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                      aria-label={`${w.student.studentNo} 号 ${w.student.name}`}
                      style={{
                        background: on
                          ? 'var(--color-accentsoft)'
                          : called
                            ? 'var(--color-idlesoft)'
                            : 'var(--color-surface)',
                        border: `1px solid ${
                          on ? 'var(--color-accent)' : called ? 'var(--color-line)' : 'var(--color-line2)'
                        }`,
                        borderRadius: 4,
                        opacity: disabled ? 0.45 : 1,
                        transition: 'background-color .16s, border-color .16s',
                      }}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span
                          className="num"
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: called && !on ? 'var(--color-ink3)' : 'var(--color-bad)',
                          }}
                        >
                          {w.student.studentNo}
                        </span>
                        <span
                          className="flex-1 truncate"
                          style={{ fontSize: 12, color: 'var(--color-ink2)' }}
                        >
                          {w.student.name}
                        </span>
                        {on ? <IconCheck size={14} strokeWidth={2.6} /> : null}
                      </span>
                      <span
                        className="flex w-full items-center gap-1.5"
                        style={{ fontSize: 10.5, color: 'var(--color-ink3)' }}
                      >
                        <span className="num">{w.count} 处错</span>
                        {w.seqs.length ? (
                          <span className="truncate">第 {w.seqs.join('、')} 题</span>
                        ) : null}
                        {called ? (
                          <span
                            style={{
                              marginLeft: 'auto',
                              color:
                                called === 'corrected'
                                  ? 'var(--color-ok)'
                                  : called === 'arrived'
                                    ? 'var(--color-accent)'
                                    : 'var(--color-ink3)',
                              fontWeight: 600,
                            }}
                          >
                            {CALL_STATE_TEXT[called]}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Panel>
        </div>

        {/* 播报内容 */}
        <div className="mb-3">
          <Sect>播报内容</Sect>
          <Panel bodyClass="p-3">
            <label className="block">
              <span className="label">到哪儿</span>
              <input
                className="input"
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder={DEFAULT_ROOM}
              />
            </label>
            <label className="mt-3 block">
              <span className="label">
                自定义后缀（可选，{custom.length}/{CUSTOM_MAX}）
              </span>
              <input
                className="input"
                value={custom}
                maxLength={CUSTOM_MAX}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="带上作业本"
              />
              <span
                style={{ display: 'block', fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 5 }}
              >
                会拼成「{subject}老师叫你{ custom.trim() || '……' }」。这句话会公开放音，请写清楚。
              </span>
            </label>

            <div
              className="mt-3 p-3"
              style={{
                background: 'var(--color-surface2)',
                border: '1px dashed var(--color-line2)',
                borderRadius: 4,
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.08em' }}>
                教室端将播报
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 5, lineHeight: 1.65 }}>
                {text}
              </div>
            </div>
          </Panel>
        </div>

        <div className="flex gap-2">
          <Button
            block
            icon={<IconMegaphone size={16} />}
            disabled={selected.length === 0}
            onClick={() => setPreview(true)}
          >
            预览教室端
          </Button>
          <Button
            block
            variant="primary"
            icon={<IconSend size={16} />}
            disabled={selected.length === 0}
            onClick={doSend}
          >
            发送呼叫
          </Button>
        </div>

        {selected.length === 0 ? (
          <div
            className="mt-3 flex items-start gap-2 px-1"
            style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
          >
            <IconInfo size={13} />
            <span>
              默认不预选 —— 从上面按错题数从多到少挑 3–8 个人即可，单次最多 {CALL_LIMIT} 人。
            </span>
          </div>
        ) : null}

        {/* 本次呼叫记录 */}
        {myCalls.length > 0 ? (
          <div className="mt-5">
            <Sect>本次呼叫记录 · 点状态可推进</Sect>
            <div className="flex flex-col gap-2.5">
              {myCalls.map((c) => (
                <CallCard
                  key={c.id}
                  call={c}
                  students={students}
                  onRepeat={() => {
                    repeatCall(c.id)
                    push({ text: '已重播一遍', tone: 'ok' })
                  }}
                  onAdvance={(no) => {
                    const cur = c.states[no] ?? 'called'
                    setCallState(c.id, no, NEXT_STATE[cur])
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </Page>

      {/* 教室端预览 */}
      <Sheet
        open={preview}
        onClose={() => setPreview(false)}
        title="教室端预览"
        footer={
          <Button block variant="primary" icon={<IconSend size={16} />} onClick={() => { setPreview(false); doSend() }}>
            确认发送
          </Button>
        }
      >
        <div
          className="relative overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, ***REMOVED***10151c, ***REMOVED***161d26)',
            borderRadius: 6,
            padding: '22px 16px',
            minHeight: 190,
          }}
        >
          {/* 提示音 */}
          <div
            className="flex items-center gap-2"
            style={{ fontSize: 11, color: 'rgb(255 255 255 / .5)', letterSpacing: '.1em' }}
          >
            <span
              className="live-dot"
              style={{
                width: 6,
                height: 6,
                borderRadius: 99,
                background: '***REMOVED***4ade9a',
                display: 'inline-block',
              }}
            />
            {room_client?.online ? '已连接' : '离线 · 不会播出'} · 先播提示音
          </div>

          <div
            style={{
              color: '***REMOVED***fff',
              fontSize: 20,
              fontWeight: 650,
              lineHeight: 1.7,
              marginTop: 16,
            }}
          >
            {text}
          </div>

          {/* 置顶小窗示意 */}
          <div
            className="glass-dark"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              padding: '6px 9px',
              borderRadius: 4,
              border: '1px solid rgb(255 255 255 / .18)',
              fontSize: 11,
              color: '***REMOVED***fff',
            }}
          >
            <span className="num" style={{ fontWeight: 700 }}>
              第 {stats.ranked[0]?.seq ?? 1} 题
            </span>
            <span style={{ opacity: 0.7, marginLeft: 6 }}>
              正确率 {Math.round((stats.ranked[0]?.rate ?? 0) * 100)}%
            </span>
          </div>
        </div>

        <div
          className="mt-3 flex items-start gap-2"
          style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
        >
          <IconAlert size={13} />
          <span>
            教室里其他班的学生路过时也会听到。所以播报的是<b>学号</b>而不是姓名。
          </span>
        </div>
      </Sheet>
    </>
  )
}

/* ---------------- 呼叫记录卡片已抽到 components/CallCard ---------------- */
