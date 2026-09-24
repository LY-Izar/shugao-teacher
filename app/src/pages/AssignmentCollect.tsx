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
  IconRefresh,
  IconScan,
  IconStack,
  IconUpload,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Portal, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { Assignment, Student } from '../data/types'
import { analyzeScan, simulateCollectScan, type ScanAnalysis } from '../lib/assignments'
import { clearStudentRecords } from '../lib/grading'
import { recognize, splitByConfidence, type OcrCount } from '../lib/ocr'
import { preparePhoto, type PreparedPhoto, type Rotate } from '../lib/photo'
import { isRemote } from '../lib/supabase'
import { friendlyDate } from '../lib/date'

type Mark = 'submitted' | 'missing' | 'late'
type Stage = 'idle' | 'preview' | 'scanning' | 'done'

/** 识别过程中的进度文案 —— 现在是真在跑，不再是演的 */
const SCAN_STEPS = ['预处理照片（压缩 · 纠偏 · 提对比）', '识别手写学号', '与花名册对账']

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
  const updateAssignment = useStore((s) => s.updateAssignment)

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
  /** 待确认降级为未交的学生学号（他已批改过，要先确认删掉批改记录） */
  const [demoteNo, setDemote] = useState<string | null>(null)
  /**
   * 「保存登记」卡在确认上的那一步。
   * 照片预填出来的未交名单**不经过三态循环**，所以它是最容易绕开降级确认的一条路：
   * 先批改、后拍照登记，就会产生"未交 ∩ 已批改"的矛盾数据。
   */
  const [pendingSave, setPendingSave] = useState<{ missingNos: string[]; lateNos: string[] } | null>(
    null,
  )
  const [stage, setStage] = useState<Stage>('idle')
  const [step, setStep] = useState(0)
  const [scan, setScan] = useState<ScanAnalysis | null>(null)
  const [detectedCount, setDetectedCount] = useState(0)
  const [photo, setPhoto] = useState<string | null>(null)
  const [zoom, setZoom] = useState(false)

  /* ---- 真识别相关 ---- */
  const [source, setSource] = useState<Blob | null>(null)
  const [prep, setPrep] = useState<PreparedPhoto | null>(null)
  const [enhance, setEnhance] = useState(true)
  const [rotate, setRotate] = useState<Rotate>(0)
  const [lowConf, setLowConf] = useState<Set<string>>(new Set())
  const [ocrErr, setOcrErr] = useState<{ msg: string; detail?: string } | null>(null)
  const [ocrNotes, setOcrNotes] = useState('')
  /** 识别产出过低时的已识别数量（非 null 表示这张照片不合格） */
  const [lowYield, setLowYield] = useState<number | null>(null)
  /** 数出来的本数 */
  const [bookCount, setBookCount] = useState<OcrCount | null>(null)
  /** 本数够 → 直接判定交齐 */
  const [allIn, setAllIn] = useState<OcrCount | null>(null)
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

  /** 选到照片后先做本机预处理，让教师看一眼再决定要不要识别 */
  const pickPhoto = async (f: Blob, opts?: { enhance?: boolean; rotate?: Rotate }) => {
    const en = opts?.enhance ?? enhance
    const rot = opts?.rotate ?? rotate
    setOcrErr(null)
    setOcrNotes('')
    try {
      const p = await preparePhoto(f, { enhance: en, rotate: rot })
      setSource(f)
      setPrep(p)
      setPhoto(p.dataUrl)
      setStage('preview')
    } catch (e) {
      setOcrErr({ msg: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 真正调用识别 */
  const runScan = async () => {
    if (!prep) return
    setOcrErr(null)
    setStage('scanning')
    setStep(0)
    const timers: number[] = []
    SCAN_STEPS.forEach((_, i) => timers.push(window.setTimeout(() => setStep(i + 1), 600 * (i + 1))))

    /* ---------- 第一步：数本数 ----------
       数本数比认手写学号可靠得多。交齐了就一步到位，不用认号。 */
    const counted = await recognize(prep.dataUrl, { scene: 'count', className: klass?.name })

    if (counted.status === 'ok' && counted.count) {
      setBookCount(counted.count)
      // 把握的下限都够数 → 一定是交齐了
      if (counted.count.min >= allNos.length) {
        timers.forEach((t) => window.clearTimeout(t))
        setMark({})
        // 空的校验结果，省得下面到处判空
        setScan({ dupNos: [], unreadable: [], unknown: [], likelyMisread: [], suspicious: false })
        setDetectedCount(0)
        setLowConf(new Set())
        setLowYield(null)
        setAllIn(counted.count)
        setOcrNotes(counted.count.note ?? '')
        setStep(SCAN_STEPS.length)
        setStage('done')
        return
      }
    }

    /* ---------- 第二步：数不够，才去认学号 ---------- */
    const out = await recognize(prep.dataUrl, {
      scene: 'collect',
      className: klass?.name,
      nos: allNos,
    })

    timers.forEach((t) => window.clearTimeout(t))
    setAllIn(null)

    if (out.status !== 'ok') {
      setOcrErr({ msg: out.message, detail: 'detail' in out ? out.detail : undefined })
      setStage('preview')
      return
    }

    const { all, lowConfidence } = splitByConfidence(out.numbers)
    const analysis = analyzeScan(all, allNos)

    // 识别产出太低时**不预标未交** —— 否则 36 人认出 4 个，一按确认就记错 32 人。
    // 宁可让教师重拍或手工标，也不能给一份看着像真的错名单。
    const yieldRatio = allNos.length ? all.length / allNos.length : 1
    if (yieldRatio < 0.5) {
      setMark({})
      setScan(analysis)
      setDetectedCount(all.length)
      setLowConf(lowConfidence)
      setOcrNotes(out.notes)
      setLowYield(all.length)
      setStep(SCAN_STEPS.length)
      setStage('done')
      return
    }

    const next: Record<string, Mark> = {}
    for (const n of analysis.unreadable) next[n] = 'missing'
    setMark(next)
    setScan(analysis)
    setDetectedCount(all.length)
    setLowConf(lowConfidence)
    setOcrNotes(out.notes)
    setLowYield(null)
    setStep(SCAN_STEPS.length)
    setStage('done')
  }

  /**
   * 三态循环：白（还没碰）→ 红（未交）→ 绿（已交）→ 红 → …
   *
   * 白和绿都算「已交」，区别只是"我核对过这一个"——
   * 所以教师只需要点没交的那几个，不用全班点一遍。
   *
   * 唯一要小心的是**绿变红**：如果这个人已经批改过（有错题记录），
   * 把他改成未交就自相矛盾了，必须先确认、并把批改记录一并删掉。
   */
  const cycle = (no: string, m: 'missing' | 'late' = 'missing') => {
    /*
     * 「迟交」模式单独一条路 —— 之前 cycle 完全不读 mode，
     * 切到「迟交」点学生实际走的是未交/已交三态循环，
     * 教师想记"迟交"却落库成"未交"，而 lateNos 永远写不进去。
     */
    if (m === 'late') {
      setMark((prev) => ({ ...prev, [no]: prev[no] === 'late' ? 'submitted' : 'late' }))
      return
    }
    const cur = mark[no]
    if (cur === undefined) {
      setMark((prev) => ({ ...prev, [no]: 'missing' }))
      return
    }
    if (cur === 'missing') {
      setMark((prev) => ({ ...prev, [no]: 'submitted' }))
      return
    }
    const wc = assignment?.wrong?.[no]?.length ?? 0
    const graded = (assignment?.confirmedNos ?? []).includes(no)
    if (wc > 0 || graded) {
      setDemote(no)
      return
    }
    setMark((prev) => ({ ...prev, [no]: 'missing' }))
  }

  /** 已经批改过的人：有错题记录，或者被确认过（判过"全对"也算批过） */
  const graded = (no: string) =>
    (assignment?.confirmedNos ?? []).includes(no) || (assignment?.wrong?.[no]?.length ?? 0) > 0

  /** 名单里"已经批改过、却要被登记成未交"的人 —— 保存前必须先问一句 */
  const demoteStudents = (nos: string[]) =>
    students.filter((s) => nos.includes(s.studentNo) && graded(s.studentNo)).map((s) => s.studentNo)

  /**
   * 确认把已批改的人改成未交：批改记录一起删，不能留一份"没交却有错题"的数据。
   *
   * 清哪些字段交给 `clearStudentRecords` 判定（对照 §二 的字段语义表）——
   * 原来的写法只删了 `wrong` / `confirmedNos`，`correctionNos`、`correctedNos`、
   * `grades` 全留着，于是改错登记里还挂着一个"没交的人要去改错"。
   * `focusNos` 保留：那是对人的标注，跟他这次交没交无关。
   */
  const doDemote = (no: string) => {
    if (!assignment) return
    updateAssignment(assignment.id, clearStudentRecords(assignment, [no]))
    setMark((m) => ({ ...m, [no]: 'missing' }))
    setDemote(null)
  }

  /** 真正落库 —— 名单 + 批改记录的清理一次性写下去 */
  const commitSave = (missingNos: string[], lateNos: string[], clean: string[] = []) => {
    if (!assignment) return
    if (clean.length) updateAssignment(assignment.id, clearStudentRecords(assignment, clean))
    setCollection(assignment.id, { missingNos, lateNos, collected: true })
    setPendingSave(null)
    push({
      text: `收缴已登记：已交 ${students.length - missingNos.length}/${students.length}`,
      tone: 'ok',
      desc: missingNos.length ? `${missingNos.length} 人未交` : '全员交齐',
    })
    navigate('/assignments')
  }

  /** 「保存登记」：有"已批改的人被标成未交"就先确认，否则直接存 */
  const save = () => {
    if (!assignment) return
    const missingNos = missing.map((s) => s.studentNo)
    const lateNos = late.map((s) => s.studentNo)
    if (demoteStudents(missingNos).length) {
      setPendingSave({ missingNos, lateNos })
      return
    }
    commitSave(missingNos, lateNos)
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
                  void pickPhoto(f)
                  e.target.value = ''
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
              ) : stage === 'preview' ? (
                <>
                  {/* 预处理结果的样子给教师看一眼，可调 */}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        const next = !enhance
                        setEnhance(next)
                        if (source) void pickPhoto(source, { enhance: next, rotate })
                      }}
                    >
                      {enhance ? '对比度已增强' : '原始亮度'}
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconRefresh size={14} />}
                      onClick={() => {
                        const next = (((rotate + 90) % 360) as Rotate)
                        setRotate(next)
                        if (source) void pickPhoto(source, { enhance, rotate: next })
                      }}
                    >
                      旋转
                    </Button>
                    <Button size="sm" onClick={() => fileRef.current?.click()}>
                      重选
                    </Button>
                  </div>

                  {prep && (prep.tooDark || prep.tooBright || prep.lowContrast) ? (
                    <div
                      className="mt-2.5 flex items-start gap-2 p-2.5"
                      style={{
                        background: 'var(--color-warnsoft)',
                        border: '1px solid ***REMOVED***ecd9ae',
                        borderRadius: 4,
                        fontSize: 11.5,
                        color: '***REMOVED***8a5a12',
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ marginTop: 1, flexShrink: 0 }}>
                        <IconAlert size={14} />
                      </span>
                      <span>
                        {prep.tooDark
                          ? '这张偏暗，识别率会下降。换个角度避开阴影，或对着窗口方向重拍。'
                          : prep.tooBright
                            ? '这张偏亮、可能有反光。躲开顶灯直射再拍一张。'
                            : '画面偏灰、字迹对比弱。已经自动增强过，若还看不清建议补光重拍。'}
                      </span>
                    </div>
                  ) : null}

                  {ocrErr ? (
                    <div
                      className="mt-2.5 flex items-start gap-2 p-2.5"
                      style={{
                        background:
                          ocrErr.msg.includes('没有班级') || ocrErr.msg.includes('没配置')
                            ? 'var(--color-warnsoft)'
                            : 'var(--color-badsoft)',
                        border: '1px solid ***REMOVED***f0c9c9',
                        borderRadius: 4,
                        fontSize: 11.5,
                        color: '***REMOVED***8f2b2b',
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ marginTop: 1, flexShrink: 0 }}>
                        <IconAlert size={14} />
                      </span>
                      <span>
                        {ocrErr.msg}
                        {ocrErr.detail ? (
                          <>
                            <br />
                            <span style={{ opacity: 0.75 }}>{ocrErr.detail}</span>
                          </>
                        ) : null}
                        <br />
                        识别不了也不影响登记 —— 下面的表格可以手动标未交。
                      </span>
                    </div>
                  ) : null}

                  <Button
                    block
                    className="mt-3"
                    variant="primary"
                    onClick={() => void runScan()}
                  >
                    开始识别
                  </Button>
                </>
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
                  {!isRemote ? (
                    <Button
                      block
                      icon={<IconUpload size={16} />}
                      onClick={() => {
                        // 仅本地演示模式保留：没有配识别服务时用来看界面流程
                        const { detected } = simulateCollectScan(allNos)
                        const analysis = analyzeScan(detected, allNos)
                        const next: Record<string, Mark> = {}
                        for (const n of analysis.unreadable) next[n] = 'missing'
                        setMark(next)
                        setScan(analysis)
                        setDetectedCount(detected.length)
                        setLowConf(new Set())
                        setStage('done')
                      }}
                    >
                      演示（模拟结果）
                    </Button>
                  ) : null}
                </div>
              )}
            </Panel>
          </div>
        ) : null}

        {/* 数本数够 → 直接判定交齐，不用认学号 */}
        {stage === 'done' && allIn ? (
          <div className="anim-in mb-4">
            <Panel bodyClass="p-4">
              <div className="flex items-start gap-3">
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 99,
                    background: 'var(--color-oksoft)',
                    color: 'var(--color-ok)',
                  }}
                >
                  <IconCheck size={22} strokeWidth={2.4} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 16, fontWeight: 680, color: 'var(--color-ok)' }}>
                    数到 <span className="num">{allIn.typical}</span> 本 · 交齐了
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--color-ink2)',
                      marginTop: 4,
                      lineHeight: 1.7,
                    }}
                  >
                    应交 <span className="num">{allNos.length}</span> 人，本数够得上，
                    就不必逐个去认学号了 —— <b>认手写号比数本数容易出错得多</b>。
                    {allIn.min !== allIn.max ? (
                      <>
                        <br />
                        数数的把握区间是 <span className="num">{allIn.min}–{allIn.max}</span> 本，
                        下限也够，所以可以放心。
                      </>
                    ) : null}
                    {allIn.note ? (
                      <>
                        <br />
                        备注：{allIn.note}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  block
                  onClick={() => {
                    setStage('idle')
                    setAllIn(null)
                    setBookCount(null)
                  }}
                >
                  重拍
                </Button>
                <Button
                  block
                  variant="primary"
                  icon={<IconCheck size={16} />}
                  onClick={() => {
                    setMark({})
                    push({
                      text: '已设为全员交齐',
                      tone: 'ok',
                      desc: '还没保存 —— 点下面的「保存登记」才真正生效',
                    })
                  }}
                >
                  确认全员已交
                </Button>
              </div>
            </Panel>
          </div>
        ) : null}

        {/* 识别结果与自检 */}
        {stage === 'done' && scan && !allIn ? (
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

            {lowYield !== null ? (
              <div
                className="mb-3 flex items-start gap-2.5 p-3"
                style={{
                  background: 'var(--color-badsoft)',
                  border: '1px solid ***REMOVED***f0c9c9',
                  borderRadius: 6,
                }}
              >
                <span style={{ color: 'var(--color-bad)', marginTop: 1, flexShrink: 0 }}>
                  <IconAlert size={18} />
                </span>
                <div style={{ fontSize: 12.5, color: '***REMOVED***8f2b2b', lineHeight: 1.7 }}>
                  <b>这张照片没认全，先别用它登记。</b>
                  <br />
                  应交 <b className="num">{allNos.length}</b> 人，只认出{' '}
                  <b className="num">{lowYield}</b> 个号 —— 剩下的人多半不是没交，而是没拍清楚。
                  <br />
                  <b>已经把预填的「未交」清空了</b>，免得你顺手就记错一大片。
                  <br />
                  建议：把整摞敦齐平方，<b>镜头与书脊齐平、正视、占满画面</b>，躲开反光和阴影，重拍一张；
                  或者直接用下面的表格手工标未交。
                </div>
                <button
                  type="button"
                  className="shrink-0"
                  style={{ fontSize: 12, color: '***REMOVED***8f2b2b', textDecoration: 'underline' }}
                  onClick={() => {
                    setStage('idle')
                    setScan(null)
                    setLowYield(null)
                  }}
                >
                  重拍
                </button>
              </div>
            ) : null}

            {lowConf.size > 0 || ocrNotes ? (
              <div
                className="mb-3 flex items-start gap-2.5 p-3"
                style={{
                  background: 'var(--color-warnsoft)',
                  border: '1px solid ***REMOVED***ecd9ae',
                  borderRadius: 6,
                }}
              >
                <span style={{ color: 'var(--color-warn)', marginTop: 1, flexShrink: 0 }}>
                  <IconAlert size={16} />
                </span>
                <div style={{ fontSize: 12.5, color: '***REMOVED***8a5a12', lineHeight: 1.65 }}>
                  {lowConf.size > 0 ? (
                    <>
                      有 <b className="num">{lowConf.size}</b> 个号识别得不够确定
                      （<span className="num">{[...lowConf].slice(0, 12).join('、')}</span>
                      {lowConf.size > 12 ? ' 等' : ''}）。
                      <b>这些号已经标在下面的名单里了，请顺手扫一眼本子核对。</b>
                    </>
                  ) : null}
                  {ocrNotes ? (
                    <>
                      {lowConf.size > 0 ? <br /> : null}
                      识别备注：{ocrNotes}
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            <Panel bodyClass="p-3">
              <div
                className="flex flex-wrap items-center gap-x-5 gap-y-2"
                style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}
              >
                {bookCount ? (
                  <span className="flex items-center gap-1.5">
                    <IconStack size={14} />
                    数到 <b className="num">{bookCount.typical}</b> 本
                    {bookCount.typical < allNos.length ? (
                      <span style={{ color: 'var(--color-bad)' }}>
                        （少 {allNos.length - bookCount.typical} 本）
                      </span>
                    ) : null}
                  </span>
                ) : null}
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
              <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                {mode === 'missing' ? '点一下：未交 → 已交 → 未交' : '点学生标记为'}
              </span>
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
                  push({
                    text: '已设为全员交齐',
                    tone: 'ok',
                    desc: '还没保存 —— 点下面的「保存登记」才真正生效',
                  })
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
                    onClick={() => cycle(s.studentNo, mode)}
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
          onClick={save}
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

      {/* 绿 → 红：这个人已经批改过，改成未交就得连批改记录一起删 */}
      <Sheet
        open={Boolean(demoteNo)}
        onClose={() => setDemote(null)}
        title="他要改成未交？"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setDemote(null)}>
              算了
            </Button>
            <Button block variant="primary" onClick={() => demoteNo && doDemote(demoteNo)}>
              确认改成未交
            </Button>
          </div>
        }
      >
        <div className="flex items-start gap-2.5">
          <span style={{ color: 'var(--color-bad)', marginTop: 1 }}>
            <IconAlert size={17} />
          </span>
          <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--color-ink2)' }}>
            <b className="num">{demoteNo}</b> 号
            {students.find((s) => s.studentNo === demoteNo)?.name ?? ''} 已经有批改记录（错了{' '}
            <b className="num">{assignment?.wrong?.[demoteNo ?? '']?.length ?? 0}</b> 处）。
            <br />
            改成未交的话，<b>这份批改记录会一起删掉</b> —— 错题、改错名单里的名字、
            「已改错」的登记都会一并清掉，且不能撤销。
            <br />
            <span style={{ color: 'var(--color-ink3)', fontSize: 12 }}>
              「需重点关注」的标记会留着 —— 那是对人的标注，跟他这次交没交无关。
            </span>
          </div>
        </div>
      </Sheet>

      {/* 名单里混进了已批改的人 → 保存前拦一道，别把"未交 ∩ 已批改"落库 */}
      <Sheet
        open={Boolean(pendingSave)}
        onClose={() => setPendingSave(null)}
        title="这些人已经批改过了"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setPendingSave(null)}>
              回去改名单
            </Button>
            <Button
              block
              variant="primary"
              onClick={() => {
                if (!pendingSave) return
                const clean = demoteStudents(pendingSave.missingNos)
                commitSave(pendingSave.missingNos, pendingSave.lateNos, clean)
              }}
            >
              一起删掉批改记录
            </Button>
          </div>
        }
      >
        <div className="flex items-start gap-2.5">
          <span style={{ color: 'var(--color-bad)', marginTop: 1 }}>
            <IconAlert size={17} />
          </span>
          <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--color-ink2)' }}>
            这次要登记的未交名单里有 <b className="num">{demoteStudents(pendingSave?.missingNos ?? []).length}</b>{' '}
            个人是有批改记录的 —— 多半是先批改、后拍的照片。
            <br />
            直接保存就会留下「没交、却有错题」的矛盾数据。
            确认保存的话，<b>他们的批改记录会一起删掉</b>，且不能撤销；
            如果他们其实交了，点「回去改名单」把红格子点回已交更稳妥。
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {students
            .filter((s) => demoteStudents(pendingSave?.missingNos ?? []).includes(s.studentNo))
            .map((s) => (
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
                <span className="num" style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                  {assignment?.wrong?.[s.studentNo]?.length
                    ? `错 ${assignment.wrong[s.studentNo].length}`
                    : '已批阅'}
                </span>
              </span>
            ))}
        </div>
      </Sheet>

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
