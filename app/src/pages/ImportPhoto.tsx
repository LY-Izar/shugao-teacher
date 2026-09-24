import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconHash,
  IconPaste,
  IconRefresh,
  IconScan,
  IconUpload,
} from '../components/icons'
import { Button, PageHead, Panel, Portal, Sect, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import type { ParsedRow } from '../lib/roster'
import { FLAG_TEXT, simulateScan, validateRows } from '../lib/roster'
import { recognize } from '../lib/ocr'
import { preparePhoto, type PreparedPhoto, type Rotate } from '../lib/photo'
import { isRemote } from '../lib/supabase'
import { teacherSubjectLabel } from '../lib/subjects'

type Stage = 'capture' | 'preview' | 'scanning' | 'review'

const SCAN_STEPS = ['定位名单区域', '识别学号列', '识别姓名列', '序列连续性校验']

/** 无照片时的示意「花名册」——用几何线条合成，不依赖任何素材 */
function MockSheet() {
  return (
    <div
      className="absolute inset-0"
      style={{ background: '***REMOVED***fff', padding: '9% 11%', display: 'flex', flexDirection: 'column', gap: 9 }}
    >
      <div style={{ width: '46%', height: 9, background: 'var(--color-line2)', borderRadius: 2 }} />
      <div style={{ height: 1, background: 'var(--color-line)' }} />
      {Array.from({ length: 13 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div
            style={{
              width: 20,
              height: 7,
              background: 'var(--color-line)',
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <div
            style={{
              width: `${38 + ((i * 37) % 34)}%`,
              height: 7,
              background: 'var(--color-line)',
              borderRadius: 2,
            }}
          />
        </div>
      ))}
    </div>
  )
}

export default function ImportPhoto() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const klass = useStore((s) => s.classes.find((c) => c.id === id))
  const addStudents = useStore((s) => s.addStudents)
  const teacher = useStore((s) => s.teacher)

  const [stage, setStage] = useState<Stage>('capture')
  const [photo, setPhoto] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [raw, setRaw] = useState<ParsedRow[]>([])
  const [zoom, setZoom] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* ---- 真识别 ---- */
  const [source, setSource] = useState<Blob | null>(null)
  const [prep, setPrep] = useState<PreparedPhoto | null>(null)
  const [enhance, setEnhance] = useState(true)
  const [rotate, setRotate] = useState<Rotate>(0)
  const [lowConf, setLowConf] = useState<Set<string>>(new Set())
  const [ocrErr, setOcrErr] = useState('')
  const [ocrNotes, setOcrNotes] = useState('')

  const rows = useMemo(() => validateRows(raw, klass?.students ?? []), [raw, klass])
  const bad = rows.filter((r) => r.flag).length

  useEffect(() => {
    return () => {
      if (photo) URL.revokeObjectURL(photo)
    }
  }, [photo])

  /** 选到照片后先本机预处理，让教师看一眼再识别 */
  const pickPhoto = async (f: Blob, opts?: { enhance?: boolean; rotate?: Rotate }) => {
    const en = opts?.enhance ?? enhance
    const rot = opts?.rotate ?? rotate
    setOcrErr('')
    try {
      const p = await preparePhoto(f, { enhance: en, rotate: rot })
      setSource(f)
      setPrep(p)
      setPhoto(p.dataUrl)
      setStage('preview')
    } catch (e) {
      setOcrErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 真识别：花名册照片 → 学号 + 姓名 */
  const runScan = async () => {
    if (!prep) return
    setOcrErr('')
    setStage('scanning')
    setStep(0)
    SCAN_STEPS.forEach((_, i) => window.setTimeout(() => setStep(i + 1), 600 * (i + 1)))

    const out = await recognize(prep.dataUrl, {
      scene: 'roster',
      className: klass?.name,
      nos: klass?.students.map((s) => s.studentNo),
      // 花名册不分科，用老师自己的学科；提示词里那句「高中X老师」更贴合场景
      subject: teacherSubjectLabel(teacher),
    })

    if (out.status !== 'ok') {
      setOcrErr(out.message)
      setStage('preview')
      return
    }

    const rows = out.students
      .map((s) => ({ studentNo: s.studentNo, name: s.name }))
      .filter((r) => r.studentNo || r.name)

    if (!rows.length) {
      setOcrErr('没从这张照片里认出学生。试试拍正一点、光线均匀一些，或改用「粘贴导入」。')
      setStage('preview')
      return
    }

    setRaw(rows)
    setLowConf(new Set(out.students.filter((s) => s.confidence === 'low').map((s) => s.studentNo)))
    setOcrNotes(out.notes)
    setStep(SCAN_STEPS.length)
    setStage('review')
  }

  if (!klass) {
    return (
      <>
        <PageHead title="班级不存在" onBack={() => navigate('/classes')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>请返回重新选择班级</div>
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="拍照录名单"
        sub={`${klass.name} · 当前 ${klass.students.length} 人`}
        onBack={() => navigate(`/classes/${klass.id}`)}
        right={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconPaste size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
          >
            改用粘贴
          </Button>
        }
      />

      <Page>
        {/* ---------- 取景 ---------- */}
        {stage === 'capture' || stage === 'preview' ? (
          <>
            <div className="mb-2">
              <Sect>第 1 步 · 拍摄花名册</Sect>
              <Panel bodyClass="p-3">
                <div
                  className="relative overflow-hidden"
                  style={{
                    aspectRatio: '4 / 3',
                    borderRadius: 4,
                    border: '1px dashed var(--color-line3)',
                    background: 'var(--color-surface2)',
                  }}
                >
                  <MockSheet />
                  {/* 四角取景框 */}
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
                    <IconScan size={14} />
                    让名单填满取景框 · 正面拍摄 · 避免反光与阴影
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

                {stage === 'preview' ? (
                  <>
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
                          const next = ((rotate + 90) % 360) as Rotate
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
                            ? '这张偏暗，识别率会下降。到窗边或补个光重拍。'
                            : prep.tooBright
                              ? '这张偏亮、可能有反光。躲开顶灯直射再拍一张。'
                              : '画面偏灰、字迹对比弱。已自动增强，若还看不清建议补光重拍。'}
                        </span>
                      </div>
                    ) : null}

                    {ocrErr ? (
                      <div
                        className="mt-2.5 flex items-start gap-2 p-2.5"
                        style={{
                          background: 'var(--color-badsoft)',
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
                          {ocrErr}
                          <br />
                          识别不了也不影响建班 —— 可以改用「粘贴导入」，或先手工建班再逐个加学生。
                        </span>
                      </div>
                    ) : null}

                    <Button block className="mt-3" variant="primary" onClick={() => void runScan()}>
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
                      拍照 / 选照片
                    </Button>
                    {!isRemote ? (
                      <Button
                        block
                        icon={<IconUpload size={16} />}
                        onClick={() => {
                          // 仅本地演示模式：没配识别服务时用来看界面流程
                          setRaw(
                            simulateScan(klass?.id ?? 'x').map((r) => ({
                              studentNo: r.studentNo,
                              name: r.name,
                            })),
                          )
                          setLowConf(new Set())
                          setStage('review')
                        }}
                      >
                        演示（模拟结果）
                      </Button>
                    ) : null}
                  </div>
                )}
              </Panel>
            </div>

            <div className="mb-4">
              <Sect>识别约定</Sect>
              <Panel bodyClass="p-3">
                <ul
                  style={{
                    fontSize: 12.5,
                    color: 'var(--color-ink2)',
                    lineHeight: 1.9,
                    paddingLeft: 16,
                    listStyle: 'disc',
                  }}
                >
                  <li>系统只识别「学号 + 姓名」两列，其余内容忽略</li>
                  <li>识别后自动做序列校验：重号、跳号会标黄要求人工确认</li>
                  <li>识别不全可只补拍缺失部分，不必重拍整张</li>
                  <li>照片仅用于当次识别，可随时在设置中清除</li>
                </ul>
              </Panel>
            </div>
          </>
        ) : null}

        {/* ---------- 识别中 ---------- */}
        {stage === 'scanning' ? (
          <div className="anim-in">
            <div className="mb-2">
              <Sect>正在识别</Sect>
              <Panel bodyClass="p-3">
                <div
                  className="relative overflow-hidden"
                  style={{ aspectRatio: '4 / 3', borderRadius: 4, background: 'var(--color-surface2)' }}
                >
                  {photo ? (
                    <img
                      src={photo}
                      alt="待识别照片"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <MockSheet />
                  )}
                  <span className="scanline" style={{ top: 0 }} />
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background:
                        'linear-gradient(180deg, rgb(11 92 240 / .06), rgb(0 176 198 / .12), rgb(11 92 240 / .06))',
                    }}
                  />
                </div>

                <div className="mt-3 flex flex-col gap-2">
                  {SCAN_STEPS.map((s, i) => {
                    const done = step > i
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
                              done ? 'var(--color-ok)' : active ? 'var(--color-accent)' : 'var(--color-line2)'
                            }`,
                            background: done ? 'var(--color-oksoft)' : 'transparent',
                            color: done ? 'var(--color-ok)' : 'var(--color-accent)',
                          }}
                        >
                          {done ? (
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
                        <span style={{ color: done || active ? 'var(--color-ink)' : 'var(--color-ink4)' }}>
                          {s}
                        </span>
                        {done ? (
                          <span className="flex-1" />
                        ) : null}
                        {done && i === SCAN_STEPS.length - 1 ? (
                          <Tag tone="ok">通过</Tag>
                        ) : null}
                      </div>
                    )
                  })}
                </div>

                <div className="mt-3">
                  <div className="track">
                    <i style={{ width: `${(step / SCAN_STEPS.length) * 100}%` }} />
                  </div>
                </div>
              </Panel>
            </div>
          </div>
        ) : null}

        {/* ---------- 校对 ---------- */}
        {stage === 'review' ? (
          <div className="anim-in">
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
                      有 <b className="num">{lowConf.size}</b> 行识别得不够确定，
                      <b>请在下面的校对表里核对原图</b>。
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
            <Panel className="mb-3 overflow-hidden">
              <StatStrip
                items={[
                  { k: '识别', v: rows.length },
                  { k: '正常', v: rows.length - bad, tone: 'var(--color-ok)' },
                  {
                    k: '待确认',
                    v: bad,
                    tone: bad ? 'var(--color-warn)' : 'var(--color-ink4)',
                  },
                ]}
              />
            </Panel>

            {bad > 0 ? (
              <div
                className="mb-3 flex items-start gap-2.5 p-3"
                style={{ background: 'var(--color-warnsoft)', border: '1px solid ***REMOVED***ecd9ae', borderRadius: 6 }}
              >
                <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                  <IconAlert size={16} />
                </span>
                <div style={{ fontSize: 12.5, color: '***REMOVED***8a5a12', lineHeight: 1.6 }}>
                  有 <b className="num">{bad}</b> 行需要人工确认。请对照原图修改——
                  系统不会把有疑问的行当作正确结果。
                </div>
              </div>
            ) : (
              <div
                className="mb-3 flex items-center gap-2.5 p-3"
                style={{ background: 'var(--color-oksoft)', border: '1px solid ***REMOVED***b9e2cf', borderRadius: 6 }}
              >
                <span style={{ color: 'var(--color-ok)' }}>
                  <IconCheck size={16} />
                </span>
                <span style={{ fontSize: 12.5, color: '***REMOVED***0b6b4a' }}>
                  校验通过：学号连续，无重号重名。
                </span>
              </div>
            )}

            <div className="mb-2">
              <Sect>第 2 步 · 对照校对（可直接修改）</Sect>
              <Panel className="overflow-hidden">
                <div className="max-h-[42vh] overflow-y-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 76 }}>
                          <span className="flex items-center gap-1">
                            <IconHash size={12} />学号
                          </span>
                        </th>
                        <th>姓名</th>
                        <th style={{ width: 92 }}>校验</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.key} data-flag={r.flag ? 'true' : undefined}>
                          <td style={{ padding: '5px 8px' }}>
                            <input
                              className="input num"
                              style={{ height: 30, fontSize: 13, padding: '0 7px' }}
                              value={r.studentNo}
                              onChange={(e) => {
                                const next = [...raw]
                                next[i] = { ...next[i], studentNo: e.target.value }
                                setRaw(next)
                              }}
                            />
                          </td>
                          <td style={{ padding: '5px 8px' }}>
                            <input
                              className="input"
                              style={{ height: 30, fontSize: 13.5, padding: '0 7px' }}
                              value={r.name}
                              onChange={(e) => {
                                const next = [...raw]
                                next[i] = { ...next[i], name: e.target.value }
                                setRaw(next)
                              }}
                            />
                          </td>
                          <td>
                            {r.flag ? (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: 'var(--color-warn)', fontSize: 11.5 }}
                              >
                                <IconAlert size={12} />
                                {FLAG_TEXT[r.flag]}
                              </span>
                            ) : (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: 'var(--color-ok)', fontSize: 11.5 }}
                              >
                                <IconCheck size={12} />
                                正常
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>

            <div className="mb-3 flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setZoom(true)}>
                查看原图
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconRefresh size={14} />}
                onClick={() => {
                  setStage('capture')
                  setRaw([])
                  setStep(0)
                }}
              >
                重拍
              </Button>
              <span className="flex-1" />
              <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                将导入 <b className="num">{rows.filter((r) => !r.flag).length}</b> 条
              </span>
            </div>

            <Button
              block
              variant="primary"
              icon={<IconCheck size={16} />}
              disabled={rows.filter((r) => !r.flag).length === 0}
              onClick={() => {
                const clean = rows
                  .filter((r) => !r.flag)
                  .map((r) => ({ studentNo: r.studentNo, name: r.name }))
                const { added, updated } = addStudents(klass.id, clean, 'merge')
                push({
                  text: `导入完成：新增 ${added} 人，更新 ${updated} 人`,
                  tone: 'ok',
                  desc: bad ? `另有 ${bad} 行未通过校验，已跳过` : undefined,
                })
                navigate(`/classes/${klass.id}`)
              }}
            >
              确认导入名单
            </Button>
          </div>
        ) : null}
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
              className="overflow-hidden"
              style={{
                maxWidth: 520,
                width: '100%',
                borderRadius: 6,
                border: '1px solid var(--color-line2)',
                background: '***REMOVED***fff',
              }}
            >
              {photo ? (
                <img src={photo} alt="原图" style={{ width: '100%', display: 'block' }} />
              ) : (
                <div className="relative" style={{ aspectRatio: '4 / 3' }}>
                  <MockSheet />
                </div>
              )}
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  )
}
