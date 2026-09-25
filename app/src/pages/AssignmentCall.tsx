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
  composeCallText,
  latestCallStateOf,
  latestCallStates,
  wrongStudents,
  wrongStudentsOfQuestion,
} from '../lib/calls'
import { archiveKeyOf, archiveValue, displayNoOfArchiveKey } from '../lib/keys'
import { roomOf } from '../lib/subjects'
import { friendlyDate } from '../lib/date'
import { ranked } from '../lib/wrongbook'

/**
 * 等级排序用：差 → 良 → 优 → 还没评（最该叫的人排最前）。
 * 与批改页那三个等级按钮、完成页的等级分布是**同一套语义**。
 */
const GRADE_ORDER: Record<string, number> = { 差: 0, 良: 1, 优: 2 }
const gradeRank = (g: string | undefined) => (g ? (GRADE_ORDER[g] ?? 3) : 4)

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
  const refreshClassrooms = useStore((s) => s.refreshClassrooms)

  const [mode, setMode] = useState<'all' | 'byQuestion'>('all')
  const [sending, setSending] = useState(false)
  const [seq, setSeq] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  /**
   * 呼叫地点：默认按这一份作业的学科算（「物理老师办公室」/「语文老师办公室」）。
   * 以前是写死的「物理老师办公室」，语文老师发出去的呼叫会被念成物理办公室。
   * 这里只是**初始值**，下面那个输入框随时能改。
   */
  const [room, setRoom] = useState(() => roomOf(assignment?.subject))
  const [custom, setCustom] = useState('')
  const [preview, setPreview] = useState(false)

  /**
   * 🔴 极简模式（`statsMode='simple'`）是**另一套数据模型**（§四 4.1；这一页是 §九 W35）。
   *
   * 这一页原来是**按错题数排序**的：而极简档案的 `wrong` 恒为空 → 概览写「有错题 0 人」、
   * 名单一列全空、按题号那排格子全是 0。**看起来很正常，其实全是错的**（与 W16 同源）。
   * 极简档案里唯一能排序的东西是**等级**，所以整页按 `statsMode` 分流 ——
   * 口径与「完成批改页」`AssignmentGradeDone.tsx` 完全一致（标题栏 / 概览 / 名单 / 按钮说明）。
   *
   * 判据复用 `lib/wrongbook.ts` 的 `ranked`（§11.5「判据只有一处」）：
   * "这份作业有没有逐题数据"全仓只有那一个定义，**不要**在这里再手写一遍 `statsMode === 'simple'`。
   * 它额外要求 `status ∈ {graded, reviewed}` —— 所以批改**进行中**的档案在这里也会走极简分支；
   * 这正好落在保守的一侧：宁可按等级渲染，也绝不在空数据上写出「有错题 0 人」这种假结论。
   */
  const simple = !assignment || !ranked(assignment)

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
    /* 极简档案没有逐题数据：一条"错题学生"都算不出来，别让下游把空列表当结论 */
    if (simple) return []
    return mode === 'all' ? wrongStudents(students, assignment) : wrongStudentsOfQuestion(students, assignment, seq)
  }, [assignment, students, mode, seq, simple])

  /** 极简模式的名单：全班在册学生，按 差 → 良 → 优 → 未评 排（最该叫的排最前） */
  const gradeList = useMemo(() => {
    if (!assignment) return []
    return [...students].sort(
      (a, b) =>
        gradeRank(archiveValue(assignment.grades, a)) - gradeRank(archiveValue(assignment.grades, b)) ||
        Number(a.studentNo) - Number(b.studentNo),
    )
  }, [assignment, students])

  /** 极简模式的概览：优 / 良 / 差 / 还没评等级（"没评"也是要叫的人，所以单独露出来） */
  const gradeCounts = useMemo(() => {
    const c = { 优: 0, 良: 0, 差: 0, 未评: 0 }
    for (const s of students) {
      const g = archiveValue(assignment?.grades, s)
      if (g === '优' || g === '良' || g === '差') c[g]++
      else c.未评++
    }
    return c
  }, [students, assignment])

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
  /*
   * ⚠️ `selected` 里存的是**档案键**（迁移后 = 序列号），因为 `studentNos` 要落库；
   *    而喊出来的话里必须是**班内学号**（"请 12 号…"）→ 显示前换一次。
   */
  const text = composeCallText(selected.map((k) => displayNoOfArchiveKey(students, k)), room, subject, custom)
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

  const doSend = async () => {
    if (selected.length === 0 || sending) return
    setSending(true)
    try {
      /*
       * 发之前重新读一次教室端状态，**但只是提示，不挡发送**。
       * 之前没有 try/finally：这次读一旦抛异常，sending 就永远卡在 true，
       * 之后每次点呼叫都被开头那句 `|| sending` 挡掉，一点反应都没有。
       */
      let online = false
      try {
        const fresh = await refreshClassrooms()
        online = fresh.find((c) => c.classId === assignment.classId)?.online ?? false
      } catch {
        /* 读不到状态不影響发送 —— 呼叫该发还是要发 */
      }

      // 广播由 store 的 sendCall 统一发出（四条呼叫路径共用），这里不再重复 emit
      sendCall({
        assignmentId: assignment.id,
        classId: assignment.classId,
        studentNos: selected,
        text,
        room,
      })
      push({
        text: online ? '已发送到教室端' : '已发送，但教室端当前离线',
        tone: online ? 'ok' : 'warn',
        desc: online ? text : '刚才重新检测过：教室端不在线，学生可能听不到',
      })
      setSelected([])
    } finally {
      // 无论成功失败都要解锁，否则这个按钮就废了
      setSending(false)
    }
  }

  return (
    <>
      <PageHead
        title="改错呼叫"
        /*
         * 极简模式**没有"题"这个概念**（只记 优/良/差），标题栏的话术与批改页 / 收缴页
         * 保持同一句「极简模式 · 只记等级」，别让老师以为这一屏能按题找错。
         */
        sub={
          simple
            ? `${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · 极简模式 · 只记等级`
            : `${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)}`
        }
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
          {room_client?.online ? (
            <div
              className="mt-2 flex items-start gap-2"
              style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.6 }}
            >
              <IconWifi size={13} />
              <span>
                播报前会先响一声提示音，语音用系统 TTS 播放，被切信号源也能出声。
              </span>
            </div>
          ) : (
            /* 离线要写得显眼 —— 教师点了呼叫、教室没动静，是这里最容易踩的坑 */
            <div
              className="mt-2 flex items-start gap-2 p-2.5"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid #ecd9ae',
                borderRadius: 4,
                fontSize: 12.5,
                lineHeight: 1.7,
                color: '#8a5a12',
              }}
            >
              <IconAlert size={15} />
              <span>
                <b>{klass?.name ?? '这个班'}</b> 的教室端
                {room_client ? '当前离线' : '还没有绑定设备'} —— 呼叫发出去
                <b>学生也听不到</b>。
                <br />
                请先打开教室里那台一体机上的教室端（双击桌面上的启动图标）。
              </span>
            </div>
          )}
        </Panel>

        {/* 概览：普通模式看错题，极简模式看等级分布（两套数据模型，不能共用一句话） */}
        <Panel className="mb-3 overflow-hidden">
          <StatStrip
            items={
              simple
                ? [
                    { k: '记录', v: `${students.length} 人` },
                    { k: '优', v: gradeCounts.优, tone: 'var(--color-ok)' },
                    { k: '良', v: gradeCounts.良, tone: 'var(--color-warn)' },
                    { k: '差', v: gradeCounts.差, tone: 'var(--color-bad)' },
                    { k: '未评', v: gradeCounts.未评, tone: 'var(--color-ink3)' },
                  ]
                : [
                    { k: '有错题', v: wrongStudents(students, assignment).length, tone: 'var(--color-bad)' },
                    { k: '已选', v: `${selected.length}/${CALL_LIMIT}` },
                    { k: '已叫过', v: calledStates.size, tone: 'var(--color-ink3)' },
                  ]
            }
          />
        </Panel>

        {/* 筛选：普通模式按错题挑人，极简模式按等级挑人 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="seg">
            {simple ? (
              <>
                <button type="button" data-on={mode === 'all'} onClick={() => setMode('all')}>
                  全部学生（按等级）
                </button>
                <button
                  type="button"
                  data-on={mode === 'byQuestion'}
                  onClick={() => setMode('byQuestion')}
                >
                  只看没评等级
                </button>
              </>
            ) : (
              <>
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
              </>
            )}
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

        {mode === 'byQuestion' && simple ? (
          <Panel className="mb-3" bodyClass="p-3">
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              极简模式只记 优 / 良 / 差，<b>没有逐题数据</b> —— 所以这里没有「按题号叫人」。
              要按题叫人，那份档案得是普通（逐题）模式建的。
            </div>
          </Panel>
        ) : null}

        {mode === 'byQuestion' && !simple ? (
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
                          color: '#fff',
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

        {/* 学生列表：普通模式按错题数、极简模式按等级 */}
        <div className="mb-3">
          <Sect>{simple ? '按等级排序 · 点一下选中' : '按错题数排序 · 点一下选中'}</Sect>
          <Panel className="overflow-hidden">
            {simple ? (
              gradeList.length === 0 ? (
                <div className="p-3.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                  这个班还没有在册学生
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 p-2.5 sm:grid-cols-3">
                  {gradeList.map((s) => {
                    const key = archiveKeyOf(s)
                    const on = selected.includes(key)
                    const disabled = !on && atLimit
                    const grade = archiveValue(assignment.grades, s)
                    /* 不评等级的人用灰（他不在"等级"这套口径里），别借"红"来说事 */
                    const tone = grade
                      ? grade === '差'
                        ? 'var(--color-bad)'
                        : grade === '良'
                          ? 'var(--color-warn)'
                          : 'var(--color-ok)'
                      : 'var(--color-ink3)'
                    const called = latestCallStateOf(calledStates, s)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggle(key)}
                        className="relative flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                        aria-label={`${s.studentNo} 号 ${s.name}`}
                        style={{
                          background: on
                            ? 'var(--color-accentsoft)'
                            : called
                              ? 'var(--color-idlesoft)'
                              : 'var(--color-surface)',
                          border: `1px solid ${
                            on
                              ? 'var(--color-accent)'
                              : called
                                ? 'var(--color-line)'
                                : 'var(--color-line2)'
                          }`,
                          borderRadius: 4,
                          opacity: disabled ? 0.45 : 1,
                          transition: 'background-color .16s, border-color .16s',
                        }}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span
                            className="num"
                            style={{ fontSize: 15, fontWeight: 700, color: tone }}
                          >
                            {s.studentNo}
                          </span>
                          <span
                            className="flex-1 truncate"
                            style={{ fontSize: 12, color: 'var(--color-ink2)' }}
                          >
                            {s.name}
                          </span>
                          {on ? <IconCheck size={14} strokeWidth={2.6} /> : null}
                        </span>
                        <span
                          className="flex w-full items-center gap-1.5"
                          style={{ fontSize: 10.5, color: 'var(--color-ink3)' }}
                        >
                          <span style={{ color: tone, fontWeight: 700 }}>
                            {grade ? `等级 ${grade}` : '还没评等级'}
                          </span>
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
              )
            ) : list.length === 0 ? (
              <div className="p-3.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                没有需要呼叫的学生
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-2.5 sm:grid-cols-3">
                {list.map((w) => {
                  const on = selected.includes(archiveKeyOf(w.student))
                  const called = latestCallStateOf(calledStates, w.student)
                  const disabled = !on && atLimit
                  return (
                    <button
                      key={w.student.id}
                      type="button"
                      onClick={() => toggle(archiveKeyOf(w.student))}
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
                placeholder={roomOf(assignment.subject)}
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
              {simple
                ? `默认不预选 —— 从上面按等级（差 → 良 → 未评）挑 3–8 个人即可，单次最多 ${CALL_LIMIT} 人。`
                : `默认不预选 —— 从上面按错题数从多到少挑 3–8 个人即可，单次最多 ${CALL_LIMIT} 人。`}
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
            background: 'linear-gradient(180deg, #10151c, #161d26)',
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
                background: '#4ade9a',
                display: 'inline-block',
              }}
            />
            {room_client?.online ? '已连接' : '离线 · 不会播出'} · 先播提示音
          </div>

          <div
            style={{
              color: '#fff',
              fontSize: 20,
              fontWeight: 650,
              lineHeight: 1.7,
              marginTop: 16,
            }}
          >
            {text}
          </div>

          {/*
            置顶小窗示意：普通模式显示"最该讲评那道题的正确率"；
            极简模式**没有逐题数据**（`stats.ranked` 恒为空），照普通模式渲染会写死成
            「第 1 题 正确率 0%」—— 又一个看起来正常、其实错的数字，所以整块换成一句实话。
          */}
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
              color: '#fff',
            }}
          >
            {simple ? (
              <span style={{ opacity: 0.85 }}>极简模式 · 不显示逐题正确率</span>
            ) : (
              <>
                <span className="num" style={{ fontWeight: 700 }}>
                  第 {stats.ranked[0]?.seq ?? 1} 题
                </span>
                <span style={{ opacity: 0.7, marginLeft: 6 }}>
                  正确率 {Math.round((stats.ranked[0]?.rate ?? 0) * 100)}%
                </span>
              </>
            )}
          </div>
        </div>

        <div
          className="mt-3 flex items-start gap-2"
          style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
        >
          <IconAlert size={13} />
          <span>
            教室里其他班的学生路过时也会听到。所以播报的是<b>学号</b>而不是姓名。
            {simple ? '极简模式只记等级，所以小窗里不显示逐题正确率。' : ''}
          </span>
        </div>
      </Sheet>
    </>
  )
}

/* ---------------- 呼叫记录卡片已抽到 components/CallCard ---------------- */
