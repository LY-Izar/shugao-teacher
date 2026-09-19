import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { PipPanel } from '../components/PipPanel'
import {
  IconAlert,
  IconCheck,
  IconInfo,
  IconMegaphone,
  IconTarget,
  IconWifi,
  Logo,
} from '../components/icons'
import { Button, Panel, Sect, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { collectStats } from '../lib/assignments'
import { BAND_META, gradeStats } from '../lib/grading'
import { closePip, openPip, pipSupported } from '../lib/pip'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import { isRemote } from '../lib/supabase'
import { chime, speak, stopSpeaking, unlockAudio } from '../lib/tts'
import { friendlyDate } from '../lib/date'
import type { CallRecord } from '../data/types'

const CLASS_KEY = 'shugao.classroom.classId'

export default function Classroom() {
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const classrooms = useStore((s) => s.classrooms)
  const setClassroomOnline = useStore((s) => s.setClassroomOnline)
  const ensureClassroom = useStore((s) => s.ensureClassroom)
  const hydrated = useStore((s) => s.hydrated)
  const teacher = useStore((s) => s.teacher)
  const navigate = useNavigate()

  const [classId, setClassId] = useState(() => {
    try {
      return localStorage.getItem(CLASS_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const klass = classes.find((c) => c.id === classId) ?? classes[0]
  const client = classrooms.find((c) => c.classId === klass?.id)

  const graded = useMemo(
    () =>
      assignments
        .filter(
          (a) => a.classId === klass?.id && (a.status === 'graded' || a.status === 'reviewed'),
        )
        .sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1)),
    [assignments, klass?.id],
  )

  const [assignmentId, setAssignmentId] = useState('')
  const assignment = graded.find((a) => a.id === assignmentId) ?? graded[0]

  const students = useMemo(
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

  const [seq, setSeq] = useState(1)
  const [pipWin, setPipWin] = useState<Window | null>(null)
  const [broadcast, setBroadcast] = useState<CallRecord | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [armed, setArmed] = useState(false)
  const push = useToast((s) => s.push)
  const rootRef = useRef<HTMLDivElement>(null)

  /* 记住选的是哪个班 */
  useEffect(() => {
    if (!klass) return
    try {
      localStorage.setItem(CLASS_KEY, klass.id)
    } catch {
      /* 忽略 */
    }
  }, [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 时钟 */
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])

  /* 教室端自我登记：后端模式没有种子数据，第一次打开时要把这台设备建出来 */
  useEffect(() => {
    if (!klass) return
    ensureClassroom(klass.id, '一体机')
  }, [klass?.id, ensureClassroom]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 心跳：教师端据此显示「在线 / 离线」 */
  useEffect(() => {
    if (!client) return
    const beat = () => {
      if (isRemote) {
        // 后端模式：心跳就是更新 classrooms.last_seen_at，教师端靠 Realtime 收到
        setClassroomOnline(client.id, true)
      } else {
        // 本地模式：两个标签页各有各的 store，必须靠广播
        emit({ type: 'heartbeat', classroomId: client.id, at: Date.now() })
        if (!client.online) setClassroomOnline(client.id, true)
      }
    }
    beat()
    const t = window.setInterval(beat, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [client?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 接收呼叫 */
  useEffect(() => {
    if (!klass) return
    return subscribe((m) => {
      if (m.type !== 'call') return
      if (m.call.classId !== klass.id) return
      setBroadcast(m.call)
      chime()
      window.setTimeout(() => speak(m.call.text), 680)
      window.setTimeout(() => setBroadcast(null), 15000)
    })
  }, [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => closePip(), [])

  const startPip = async () => {
    unlockAudio()
    setArmed(true)
    const w = await openPip()
    if (!w) {
      push({
        text: '当前浏览器不支持置顶小窗',
        tone: 'warn',
        desc: '需要 Edge / Chrome 116 及以上版本',
      })
      return
    }
    w.addEventListener('pagehide', () => setPipWin(null))
    setPipWin(w)
  }

  const nameOf = useCallback(
    (no: string) => students.find((s) => s.studentNo === no)?.name ?? '',
    [students],
  )

  const cur = stats?.questions[seq - 1]
  const pad = (n: number) => String(n).padStart(2, '0')

  /* ---------- 后端模式下教室端需要一次登录 ---------- */
  if (isRemote && !hydrated) {
    return (
      <Shell>
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 15, fontWeight: 640 }}>正在同步数据…</div>
        </Panel>
      </Shell>
    )
  }
  if (isRemote && !teacher) {
    return (
      <Shell>
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>教室端还没有登录</div>
          <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
            这台一体机需要用教师账号登录一次，之后会一直保持登录。
            <br />
            登录后回到本页即可。
          </div>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => navigate('/login')}
          >
            去登录
          </Button>
        </Panel>
      </Shell>
    )
  }

  /* ---------- 没有班级 ---------- */
  if (!klass) {
    return (
      <Shell>
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>还没有班级数据</div>
          <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
            先在教师端建立班级并录入学生名单，教室端会自动读到。
          </div>
        </Panel>
      </Shell>
    )
  }

  return (
    <Shell>
      <div ref={rootRef}>
        {/* 顶栏 */}
        <div
          className="glass sticky top-0 z-30 flex flex-wrap items-center gap-3 px-5"
          style={{ height: 62, borderBottom: '1px solid var(--color-line)' }}
        >
          <span className="flex items-center gap-2.5">
            <span style={{ color: 'var(--color-accent)', display: 'grid', placeItems: 'center' }}>
              <Logo size={22} />
            </span>
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>树高教师平台</span>
            <Tag tone="accent">教室端</Tag>
          </span>

          <span className="flex-1" />

          <select
            className="input"
            style={{ width: 'auto', height: 34, fontSize: 13 }}
            value={klass.id}
            onChange={(e) => {
              setClassId(e.target.value)
              setAssignmentId('')
              setSeq(1)
            }}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <span className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            <span
              className={client?.online ? 'live-dot' : ''}
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: client?.online ? 'var(--color-ok)' : 'var(--color-warn)',
                display: 'inline-block',
              }}
            />
            <IconWifi size={14} />
            <span style={{ color: 'var(--color-ink3)' }}>{client?.name ?? '未绑定'}</span>
          </span>

          {pipWin ? (
            <Button
              size="sm"
              icon={<IconCheck size={14} />}
              onClick={() => {
                closePip()
                setPipWin(null)
              }}
            >
              小窗已开启
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<IconTarget size={14} />} onClick={startPip}>
              启动置顶小窗
            </Button>
          )}
        </div>

        <div className="mx-auto w-full px-5 py-5" style={{ maxWidth: 1360 }}>
          {/* 小窗不可用提示 */}
          {!pipSupported() ? (
            <div
              className="mb-4 flex items-start gap-2.5 p-3.5"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={17} />
              </span>
              <div style={{ fontSize: 13, color: '***REMOVED***8a5a12', lineHeight: 1.7 }}>
                当前浏览器不支持<b>强制置顶小窗</b>（需要 Edge / Chrome 116 及以上）。
                下面的「当前题目」面板仍然可用，但它会被全屏的新教育平台盖住 ——
                讲评时请用手机或平板看题号与正确率。
              </div>
            </div>
          ) : !armed ? (
            <div
              className="mb-4 flex flex-wrap items-center gap-3 p-3.5"
              style={{
                background: 'var(--color-accentsoft)',
                border: '1px solid ***REMOVED***c3d6fb',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-accent)' }}>
                <IconInfo size={17} />
              </span>
              <div className="flex-1" style={{ fontSize: 13, color: '***REMOVED***0d3f9e', lineHeight: 1.7 }}>
                点一次「启动置顶小窗」即可：它会浮在全屏的新教育平台之上，显示当前题号与正确率。
                <b>同时这一步也解开了浏览器的声音限制</b>，呼叫播报才能出声。
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  unlockAudio()
                  setArmed(true)
                  chime()
                  push({ text: '已解锁声音', tone: 'ok', desc: '现在可以听到呼叫播报' })
                }}
              >
                先解锁声音
              </Button>
            </div>
          ) : null}

          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'minmax(300px, 360px) 1fr' }}
          >
            {/* 左列 */}
            <div className="flex flex-col gap-4">
              <Panel className="anim-in overflow-hidden">
                <div className="p-5 text-center">
                  <div
                    className="num"
                    style={{ fontSize: 62, fontWeight: 650, letterSpacing: '-.05em', lineHeight: 1 }}
                  >
                    {pad(now.getHours())}:{pad(now.getMinutes())}
                    <span style={{ fontSize: 24, color: 'var(--color-ink4)', marginLeft: 4 }}>
                      {pad(now.getSeconds())}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 8 }}>
                    {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周
                    {'日一二三四五六'[now.getDay()]} · {klass.name}
                  </div>
                </div>
              </Panel>

              {collect ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>本次作业</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      {assignment ? friendlyDate(assignment.assignDate) : ''}
                    </span>
                  </div>
                  <div className="p-4 grid grid-cols-3 gap-3 text-center">
                    {[
                      { k: '应交', v: collect.total },
                      { k: '已交', v: collect.submitted, c: 'var(--color-ok)' },
                      {
                        k: '未交',
                        v: collect.missing,
                        c: collect.missing ? 'var(--color-bad)' : undefined,
                      },
                    ].map((x) => (
                      <div key={x.k}>
                        <div className="num" style={{ fontSize: 26, fontWeight: 700, color: x.c }}>
                          {x.v}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>{x.k}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              <Panel bodyClass="p-4">
                <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <IconMegaphone size={15} />
                  <span style={{ color: 'var(--color-ink2)' }}>呼叫播报已就绪</span>
                </div>
                <div
                  className="mt-2"
                  style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
                >
                  教师端发出呼叫后，这里会先响提示音，再用系统 TTS 播报。
                  播报用的是学号，不是姓名。
                </div>
                <Button
                  size="sm"
                  block
                  className="mt-3"
                  onClick={() => {
                    unlockAudio()
                    setArmed(true)
                    chime()
                    window.setTimeout(
                      () => speak(`请 12 号、37 号，到${klass.name}的物理老师办公室。`),
                      680,
                    )
                  }}
                >
                  试播一句
                </Button>
              </Panel>

              {/* 小窗同款面板：不支持置顶小窗时，这就是兜底 */}
              {cur ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>当前题目</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                      {pipWin ? '与小窗同步' : '小窗兜底'}
                    </span>
                  </div>
                  <div className="p-3">
                    <PipPanel
                      key={seq}
                      tone="inline"
                      seq={seq}
                      total={stats?.questions.length ?? 0}
                      rate={cur.rate}
                      band={cur.band}
                      wrongNos={cur.wrongNos}
                      nameOf={nameOf}
                      onPrev={() => setSeq((v) => Math.max(1, v - 1))}
                      onNext={() =>
                        setSeq((v) => Math.min(stats?.questions.length ?? 1, v + 1))
                      }
                    />
                  </div>
                </Panel>
              ) : null}
            </div>

            {/* 右列：逐题 */}
            <div className="flex flex-col gap-4">
              {!assignment || !stats ? (
                <Panel bodyClass="p-8 text-center">
                  <div style={{ fontSize: 15, fontWeight: 620 }}>本班还没有已批改的作业</div>
                  <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
                    在教师端完成一次批改后，这里的逐题正确率会自动出现。
                  </div>
                </Panel>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <select
                      className="input"
                      style={{ width: 'auto', height: 36, fontSize: 13.5 }}
                      value={assignment.id}
                      onChange={(e) => {
                        setAssignmentId(e.target.value)
                        setSeq(1)
                      }}
                    >
                      {graded.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                    <span className="flex-1" />
                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                      当前小窗显示：第 {seq} 题
                      {cur ? ` · 错误率 ${Math.round(cur.rate * 100)}%` : ''}
                    </span>
                    {pipWin ? <Tag tone="ok">小窗已开启</Tag> : null}
                  </div>

                  <Panel className="overflow-hidden">
                    <div className="panel-head">
                      <h2>逐题正确率 · 点一行切换小窗</h2>
                      <span className="flex-1" />
                      <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                        共 {stats.questions.length} 题
                      </span>
                    </div>
                    <div>
                      {stats.questions.map((q) => {
                        const meta = BAND_META[q.band]
                        const on = q.seq === seq
                        return (
                          <button
                            key={q.seq}
                            type="button"
                            onClick={() => setSeq(q.seq)}
                            className="row"
                            style={{
                              padding: '13px 16px',
                              gap: 14,
                              background: on ? 'var(--color-accentsoft)' : undefined,
                              borderLeft: `3px solid ${on ? 'var(--color-accent)' : 'transparent'}`,
                            }}
                          >
                            <span
                              className="num grid place-items-center shrink-0"
                              style={{
                                width: 38,
                                height: 38,
                                border: '1px solid var(--color-line2)',
                                borderRadius: 4,
                                background: 'var(--color-surface)',
                                fontSize: 16,
                                fontWeight: 700,
                              }}
                            >
                              {q.seq}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-3">
                                <span
                                  className="num"
                                  style={{
                                    fontSize: 22,
                                    fontWeight: 700,
                                    color: q.wrongCount ? meta.color : 'var(--color-ink4)',
                                    minWidth: 66,
                                  }}
                                >
                                  {Math.round(q.rate * 100)}%
                                </span>
                                <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                                  <b className="num">{q.wrongCount}</b> 人错
                                </span>
                                <span className="flex-1" />
                                {q.wrongCount > 0 ? (
                                  <Tag tone={meta.tone}>{meta.label}</Tag>
                                ) : (
                                  <Tag tone="ok">全对</Tag>
                                )}
                              </span>
                              <span
                                className="mt-2 block"
                                style={{
                                  height: 6,
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
                                  }}
                                />
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </Panel>

                  <Sect>小窗操作</Sect>
                  <Panel bodyClass="p-4">
                    <ul
                      style={{
                        fontSize: 12.5,
                        color: 'var(--color-ink2)',
                        lineHeight: 2,
                        paddingLeft: 18,
                        listStyle: 'disc',
                      }}
                    >
                      <li>
                        小窗里的 <b>◀ ▶</b> 切题；小窗获得焦点时也可用键盘方向键
                      </li>
                      <li>
                        点<b>名单</b>才展开错误学生姓名，再点一次立即收起 —— 讲评到敏感处可随手隐藏
                      </li>
                      <li>小窗可以随意拖动、缩放，位置会被浏览器记住</li>
                      <li>换题时会自动收起名单，避免上一题的名单留在屏幕上</li>
                    </ul>
                  </Panel>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 置顶小窗内容 */}
      {pipWin && cur
        ? createPortal(
            <PipPanel
              key={seq}
              seq={seq}
              total={stats?.questions.length ?? 0}
              rate={cur.rate}
              band={cur.band}
              wrongNos={cur.wrongNos}
              nameOf={nameOf}
              onPrev={() => setSeq((v) => Math.max(1, v - 1))}
              onNext={() => setSeq((v) => Math.min(stats?.questions.length ?? 1, v + 1))}
            />,
            pipWin.document.body,
          )
        : null}

      {/* 播报浮层 */}
      {broadcast ? (
        <div
          className="anim-in fixed inset-0 z-[70] flex flex-col items-center justify-center px-10"
          style={{ background: 'rgb(10 14 20 / .95)' }}
        >
          <div
            className="flex items-center gap-2.5"
            style={{ color: 'rgb(255 255 255 / .55)', fontSize: 14, letterSpacing: '.14em' }}
          >
            <span
              className="live-dot"
              style={{
                width: 9,
                height: 9,
                borderRadius: 99,
                background: '***REMOVED***4ade9a',
                display: 'inline-block',
              }}
            />
            正在播报
          </div>
          <div
            style={{
              color: '***REMOVED***fff',
              fontSize: 46,
              fontWeight: 700,
              lineHeight: 1.5,
              textAlign: 'center',
              marginTop: 26,
              maxWidth: 1200,
            }}
          >
            {broadcast.text}
          </div>
          <div className="mt-10 flex gap-3">
            <Button
              onClick={() => {
                chime()
                window.setTimeout(() => speak(broadcast.text), 680)
              }}
            >
              再播一遍
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                stopSpeaking()
                setBroadcast(null)
              }}
            >
              关闭
            </Button>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}

/* 教室端不套教师端的应用壳 */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-[1] mx-auto min-h-full w-full">{children}</div>
}
