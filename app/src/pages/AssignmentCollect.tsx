import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconHash,
  IconInfo,
  IconScan,
  IconStack,
  IconUpload,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Portal, Sect, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { Assignment, Student } from '../data/types'
import { analyzeScan, simulateCollectScan, type ScanAnalysis } from '../lib/assignments'
import { friendlyDate } from '../lib/date'

type Mark = 'submitted' | 'missing' | 'late'
type Stage = 'idle' | 'scanning' | 'done'

const SCAN_STEPS = ['定位侧面区域', '逐行识别学号', '序列连续性校验']

/** 收缴采用「只记例外」：默认全班已交，只存未交与迟交 */
function initMark(a?: Assignment): Record<string, Mark> {
  const next: Record<string, Mark> = {}
  if (!a) return next
  for (const n of a.missingNos) next[n] = 'missing'
  for (const n of a.lateNos) next[n] = 'late'
  return next
}

/**
 * 整齐一摞作业的侧面示意。
 * 对齐叠放时每本书的侧边带都完整露出、互不遮挡 —— 学号逐行分布，
 * 这正是「拍一张查全」成立的前提。书写位置会有横向差异，这里如实体现。
 */
function MockStack({ highlight }: { highlight?: string }) {
  const rows = 14
  return (
    <div
      className="absolute inset-0 flex flex-col justify-center gap-[2px] px-3"
      style={{ background: '***REMOVED***fff', paddingBottom: 36, paddingTop: 12 }}
    >
      {Array.from({ length: rows }).map((_, i) => {
        // 确定性横向抖动：还原真实书写位置不一致的情况
        const jitter = [0, 2.5, 1, 4, 0.5, 3, 1.5, 0, 2, 3.5, 1, 2.5, 0.5, 3][i % 14]
        const isName = i === rows - 2
        const no = i + 1
        const bad = highlight === String(no)
        return (
          <div
            key={i}
            className="flex items-center"
            style={{
              height: 13,
              background: i % 2 === 0 ? '***REMOVED***fbfcfd' : '***REMOVED***f4f6f9',
              borderTop: '1px solid ***REMOVED***e2e6ec',
              borderBottom: '1px solid ***REMOVED***eef1f5',
            }}
          >
            <span style={{ width: `${8 + jitter * 2}%` }} />
            <span
              className="num"
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: bad ? 'var(--color-bad)' : 'var(--color-ink3)',
                letterSpacing: '-.02em',
              }}
            >
              {isName ? '王志远' : no}
            </span>
            {bad ? (
              <span
                style={{
                  flex: 1,
                  height: 1,
                  marginLeft: 6,
                  background:
                    'repeating-linear-gradient(90deg, var(--color-bad) 0 3px, transparent 3px 6px)',
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export default function AssignmentCollect() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const setCollection = useStore((s) => s.setCollection)

  const students: Student[] = useMemo(
    () =>
      (klass?.students ?? [])
        .filter((s) => s.status === 'active')
        .sort((a, b) => Number(a.studentNo) - Number(b.studentNo)),
    [klass],
  )

  const [markBox, setMarkBox] = useState(() => ({
    id: assignment?.id ?? '',
    mark: initMark(assignment),
  }))
  /* 切换作业档案时在渲染期重算，避免在 effect 里同步 setState */
  if (markBox.id !== (assignment?.id ?? '')) {
    setMarkBox({ id: assignment?.id ?? '', mark: initMark(assignment) })
  }
  const mark = markBox.mark
  const setMark = (
    v: Record<string, Mark> | ((m: Record<string, Mark>) => Record<string, Mark>),
  ) => setMarkBox((b) => ({ ...b, mark: typeof v === 'function' ? v(b.mark) : v }))

  const [mode, setMode] = useState<'missing' | 'late'>('missing')
  const [stage, setStage] = useState<Stage>('idle')
  const [step, setStep] = useState(0)
  const [scan, setScan] = useState<ScanAnalysis | null>(null)
  const [detectedCount, setDetectedCount] = useState(0)
  const [photo, setPhoto] = useState<string | null>(null)
  const [zoom, setZoom] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* 用档案里已有的收缴记录初始化（只记例外，默认全班已交） */

  useEffect(() => {
    return () => {
      if (photo) URL.revokeObjectURL(photo)
    }
  }, [photo])

  if (!assignment) {
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

  const allNos = students.map((s) => s.studentNo)
  const missing = students.filter((s) => mark[s.studentNo] === 'missing')
  const late = students.filter((s) => mark[s.studentNo] === 'late')
  const submitted = students.length - missing.length

  const runScan = (src: string | null) => {
    setPhoto(src)
    setStage('scanning')
    setStep(0)
    const timers: number[] = []
    SCAN_STEPS.forEach((_, i) => timers.push(window.setTimeout(() => setStep(i + 1), 400 * (i + 1))))
    timers.push(
      window.setTimeout(
        () => {
          const { detected } = simulateCollectScan(allNos)
          const analysis = analyzeScan(detected, allNos)

          const next: Record<string, Mark> = {}
          for (const n of analysis.unreadable) next[n] = 'missing'
          setMark(next)
          setScan(analysis)
          setDetectedCount(detected.length)
          setStage('done')
        },
        400 * SCAN_STEPS.length + 380,
      ),
    )
  }

  const toggle = (no: string) => {
    setMark((m) => {
      const next = { ...m }
      if (next[no] === mode) delete next[no]
      else next[no] = mode
      return next
    })
  }

  return (
    <>
      <PageHead
        title="收作业查缺"
        sub={`${klass?.name ?? '—'} · ${friendlyDate(assignment.assignDate)} · ${assignment.questionCount} 题`}
        onBack={() => navigate('/assignments')}
      />

      <Page>
        {/* 概览 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <StatStrip
            items={[
              { k: '应交', v: students.length },
              { k: '已交', v: submitted, tone: 'var(--color-ok)' },
              {
                k: '未交',
                v: missing.length,
                tone: missing.length ? 'var(--color-bad)' : 'var(--color-ink4)',
              },
              {
                k: '迟交',
                v: late.length,
                tone: late.length ? 'var(--color-warn)' : 'var(--color-ink4)',
              },
            ]}
          />
        </Panel>

        {/* 拍照区 */}
        {stage !== 'done' ? (
          <div className="mb-4">
            <Sect>拍一摞作业的侧面</Sect>
            <Panel bodyClass="p-3">
              <div
                className="relative overflow-hidden"
                style={{
                  aspectRatio: '16 / 10',
                  borderRadius: 4,
                  border: '1px dashed var(--color-line3)',
                  background: 'var(--color-surface2)',
                }}
              >
                {photo ? (
                  <img
                    src={photo}
                    alt="作业摞侧面"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <MockStack />
                )}

                {stage === 'idle' ? (
                  <>
                    {[
                      { top: 10, left: 10, bt: 1, bl: 1 },
                      { top: 10, right: 10, bt: 1, br: 1 },
                      { bottom: 10, left: 10, bb: 1, bl: 1 },
                      { bottom: 10, right: 10, bb: 1, br: 1 },
                    ].map((c, i) => (
                      <span
                        key={i}
                        style={{
                          position: 'absolute',
                          width: 20,
                          height: 20,
                          top: c.top,
                          left: c.left,
                          right: c.right,
                          bottom: c.bottom,
                          borderTop: c.bt ? '2px solid var(--color-accent)' : undefined,
                          borderBottom: c.bb ? '2px solid var(--color-accent)' : undefined,
                          borderLeft: c.bl ? '2px solid var(--color-accent)' : undefined,
                          borderRight: c.br ? '2px solid var(--color-accent)' : undefined,
                        }}
                      />
                    ))}
                  </>
                ) : null}

                {stage === 'scanning' ? <span className="scanline" style={{ top: 0 }} /> : null}

                <div
                  className="glass glass-dark"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: '7px 10px',
                    color: '***REMOVED***fff',
                    fontSize: 11.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <IconStack size={14} />
                  整摞对齐摆正 · 侧面朝镜头 · 正面平拍 · 光线均匀不反光
                </div>
              </div>

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  runScan(URL.createObjectURL(f))
                }}
              />

              {stage === 'scanning' ? (
                <div className="mt-3 flex flex-col gap-2">
                  {SCAN_STEPS.map((s, i) => {
                    const doneStep = step > i
                    const active = step === i
                    return (
                      <div key={s} className="flex items-center gap-2.5" style={{ fontSize: 13 }}>
                        <span
                          className="grid place-items-center shrink-0"
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: 99,
                            border: `1px solid ${
                              doneStep
                                ? 'var(--color-ok)'
                                : active
                                  ? 'var(--color-accent)'
                                  : 'var(--color-line2)'
                            }`,
                            background: doneStep ? 'var(--color-oksoft)' : 'transparent',
                            color: doneStep ? 'var(--color-ok)' : 'var(--color-accent)',
                          }}
                        >
                          {doneStep ? (
                            <IconCheck size={11} strokeWidth={2.6} />
                          ) : (
                            <span
                              className={active ? 'live-dot' : ''}
                              style={{
                                width: 5,
                                height: 5,
                                borderRadius: 99,
                                background: 'currentColor',
                                opacity: active ? 1 : 0.4,
                              }}
                            />
                          )}
                        </span>
                        <span
                          style={{
                            color: doneStep || active ? 'var(--color-ink)' : 'var(--color-ink4)',
                          }}
                        >
                          {s}
                        </span>
                      </div>
                    )
                  })}
                  <div className="mt-1">
                    <div className="track">
                      <i style={{ width: `${(step / SCAN_STEPS.length) * 100}%` }} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <Button
                    block
                    variant="primary"
                    icon={<IconCamera size={16} />}
                    onClick={() => fileRef.current?.click()}
                  >
                    拍照查缺
                  </Button>
                  <Button block icon={<IconUpload size={16} />} onClick={() => runScan(null)}>
                    用示意图演示
                  </Button>
                </div>
              )}
            </Panel>
          </div>
        ) : null}

        {/* 识别结果与自检 */}
        {stage === 'done' && scan ? (
          <div className="anim-in mb-4">
            <Sect>识别结果与自检</Sect>
            {scan.suspicious ? (
              <div
                className="mb-2 flex items-start gap-2.5 p-3"
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
                  {scan.likelyMisread.length ? (
                    <div>
                      很可能是
                      <b className="num">
                        {' '}
                        {scan.likelyMisread.map((m) => `${m.from} 号被读成了 ${m.to} 号`).join('，')}
                      </b>
                      。这几个号请对照原图确认——它们可能其实交了。
                    </div>
                  ) : scan.dupNos.length ? (
                    <div>
                      识别到<b className="num"> {scan.dupNos.join('、')} </b>
                      号重复，说明有号码被误读，请对照原图确认。
                    </div>
                  ) : null}
                  {scan.unknown.length ? (
                    <div style={{ marginTop: 2 }}>
                      识别到花名册里没有的学号：
                      <b className="num">{scan.unknown.join('、')}</b>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div
                className="mb-2 flex items-center gap-2.5 p-3"
                style={{
                  background: 'var(--color-oksoft)',
                  border: '1px solid ***REMOVED***b9e2cf',
                  borderRadius: 6,
                }}
              >
                <span style={{ color: 'var(--color-ok)' }}>
                  <IconCheck size={16} />
                </span>
                <span style={{ fontSize: 12.5, color: '***REMOVED***0b6b4a' }}>
                  序列校验通过：识别到 <b className="num">{detectedCount}</b> 个学号，号码连续无重复。
                </span>
              </div>
            )}

            <Panel bodyClass="p-3">
              <div
                className="flex flex-wrap items-center gap-x-5 gap-y-2"
                style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}
              >
                <span className="flex items-center gap-1.5">
                  <IconScan size={14} />
                  识别到 <b className="num">{detectedCount}</b> 个学号
                </span>
                <span className="flex items-center gap-1.5">
                  <IconHash size={14} />
                  应交 <b className="num">{allNos.length}</b>
                </span>
                <span className="flex items-center gap-1.5">
                  <IconX size={14} />
                  未识别 <b className="num">{scan.unreadable.length}</b>
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => setZoom(true)}
                  style={{ color: 'var(--color-accent)', fontSize: 12.5, fontWeight: 600 }}
                >
                  查看原图
                </button>
              </div>
            </Panel>
          </div>
        ) : null}

        {/* 名单：默认全班已交，只标例外 */}
        <div className="mb-3">
          <Sect>登记表 · 默认全班已交，只标例外</Sect>
          <Panel className="overflow-hidden">
            <div
              className="flex flex-wrap items-center gap-2 px-3 py-2.5"
              style={{
                borderBottom: '1px solid var(--color-line)',
                background: 'var(--color-surface2)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>点学生标记为</span>
              <div className="seg">
                <button type="button" data-on={mode === 'missing'} onClick={() => setMode('missing')}>
                  未交
                </button>
                <button type="button" data-on={mode === 'late'} onClick={() => setMode('late')}>
                  迟交
                </button>
              </div>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                icon={<IconCheck size={14} />}
                onClick={() => {
                  setMark({})
                  push({ text: '已设为全员交齐', tone: 'ok' })
                }}
              >
                全部已交
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2 p-2.5 sm:grid-cols-4">
              {students.map((s) => {
                const st = mark[s.studentNo] ?? 'submitted'
                const bg =
                  st === 'missing'
                    ? 'var(--color-badsoft)'
                    : st === 'late'
                      ? 'var(--color-warnsoft)'
                      : 'var(--color-surface)'
                const bd =
                  st === 'missing'
                    ? 'var(--color-bad)'
                    : st === 'late'
                      ? 'var(--color-warn)'
                      : 'var(--color-line)'
                const fg =
                  st === 'missing'
                    ? 'var(--color-bad)'
                    : st === 'late'
                      ? 'var(--color-warn)'
                      : 'var(--color-ink)'
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.studentNo)}
                    className="flex flex-col items-start gap-0.5 px-2 py-1.5 text-left"
                    style={{
                      background: bg,
                      border: `1px solid ${bd}`,
                      borderRadius: 4,
                      transition:
                        'background-color .16s cubic-bezier(.22,.8,.24,1), border-color .16s, transform .1s',
                    }}
                  >
                    <span className="num" style={{ fontSize: 15, fontWeight: 700, color: fg }}>
                      {s.studentNo}
                    </span>
                    <span
                      className="truncate w-full"
                      style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                    >
                      {s.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </Panel>
        </div>

        {/* 未交名单 */}
        {missing.length > 0 ? (
          <Panel className="mb-4 overflow-hidden">
            <div className="panel-head">
              <h2>未交名单</h2>
              <span className="flex-1" />
              <Tag tone="bad">{missing.length} 人</Tag>
            </div>
            <div className="p-3 flex flex-wrap gap-1.5">
              {missing.map((s) => (
                <span
                  key={s.id}
                  className="flex items-center gap-1.5 px-2 py-1"
                  style={{
                    background: 'var(--color-badsoft)',
                    borderRadius: 3,
                    fontSize: 12.5,
                    color: 'var(--color-bad)',
                  }}
                >
                  <b className="num">{s.studentNo}</b>
                  {s.name}
                </span>
              ))}
            </div>
          </Panel>
        ) : null}

        <Button
          block
          variant="primary"
          icon={<IconChevronRight size={16} />}
          onClick={() => {
            setCollection(assignment.id, {
              missingNos: missing.map((s) => s.studentNo),
              lateNos: late.map((s) => s.studentNo),
              collected: true,
            })
            push({
              text: `收缴已登记：已交 ${submitted}/${students.length}`,
              tone: 'ok',
              desc: missing.length ? `${missing.length} 人未交` : '全员交齐',
            })
            navigate('/assignments')
          }}
        >
          保存登记
        </Button>

        <div
          className="mt-3 flex items-start gap-2 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
        >
          <IconInfo size={13} />
          <span>
            无论识别结果如何，都可以直接点学生手工修正 —— 识别只是加速器，永远不会卡住流程。
          </span>
        </div>
      </Page>

      {/* 原图放大 */}
      {zoom ? (
        <Portal>
          <div
            className="scrim"
            onClick={() => setZoom(false)}
            style={{ background: 'rgb(14 20 27 / .82)' }}
          />
          <div
            className="fixed inset-0 z-[51] grid place-items-center p-4"
            onClick={() => setZoom(false)}
          >
            <div
              className="overflow-hidden relative"
              style={{
                maxWidth: 560,
                width: '100%',
                aspectRatio: '16 / 10',
                borderRadius: 6,
                border: '1px solid var(--color-line2)',
                background: '***REMOVED***fff',
              }}
            >
              {photo ? (
                <img
                  src={photo}
                  alt="原图"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <MockStack highlight={scan?.dupNos[0]} />
              )}
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  )
}
