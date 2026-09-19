import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconTarget,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { downloadPracticeDocx } from '../lib/examDoc'
import { buildClassWrongBook, buildWrongBook, type WrongItem } from '../lib/wrongbook'

/** 勾选：空集合表示"全选"。这样不用在打开时做状态同步，少一类 bug */
function usePicked() {
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const all = (ids: string[]) => new Set(ids)
  const isOn = (id: string, ids: string[]) => (picked ?? all(ids)).has(id)
  const toggle = (id: string, ids: string[]) => {
    const cur = new Set(picked ?? ids)
    if (cur.has(id)) cur.delete(id)
    else cur.add(id)
    setPicked(cur)
  }
  const reset = () => setPicked(null)
  /** 从勾中的知识点里取出题目（去重 —— 一道题可能挂多个知识点） */
  const itemsOf = (points: Array<{ pointId: string; items: WrongItem[] }>, ids: string[]) => {
    const use = picked ?? all(ids)
    const map = new Map<string, WrongItem>()
    for (const p of points) {
      if (!use.has(p.pointId)) continue
      for (const it of p.items) map.set(`${it.assignmentId}-${it.seq}`, it)
    }
    return [...map.values()]
  }
  return { picked, isOn, toggle, reset, itemsOf }
}

export default function WrongBook() {
  const navigate = useNavigate()
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const assignments = useStore((s) => s.assignments)
  const push = useToast((s) => s.push)

  const [tab, setTab] = useState<'person' | 'class'>('person')
  const [openNo, setOpenNo] = useState<string | null>(null)
  const pick = usePicked()

  const klass = classes.find((c) => c.id === currentClassId) ?? classes[0]
  const students = useMemo(
    () => (klass?.students ?? []).filter((s) => s.status === 'active'),
    [klass],
  )

  const books = useMemo(
    () =>
      students
        .map((s) => buildWrongBook(s, klass, assignments))
        .sort((a, b) => b.totalLost - a.totalLost || b.totalWrong - a.totalWrong),
    [students, klass, assignments],
  )

  const cls = useMemo(() => buildClassWrongBook(klass, assignments), [klass, assignments])

  const gradedCount = assignments.filter(
    (a) => a.classId === klass?.id && (a.status === 'graded' || a.status === 'reviewed'),
  ).length

  const open = books.find((b) => b.studentNo === openNo) ?? null

  return (
    <>
      <PageHead
        title="错题集"
        sub={`${klass?.name ?? '—'} · 基于 ${gradedCount} 份已批改的作业`}
        onBack={() => navigate('/')}
      />

      <Page>
        {/* 还在开发中，先把话说清楚，别让教师以为已经完工 */}
        <div
          className="anim-in mb-3 flex items-center gap-2.5 p-2.5"
          style={{
            background: 'var(--color-warnsoft)',
            border: '1px solid ***REMOVED***ecd9ae',
            borderRadius: 6,
            fontSize: 12.5,
            color: '***REMOVED***8a5a12',
          }}
        >
          <IconAlert size={15} />
          <span>这个功能还在开发中</span>
        </div>

        {gradedCount === 0 ? (
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
              还没有批改过的作业，错题集暂时没有数据。
            </div>
            <Button className="mt-3" size="sm" variant="primary" onClick={() => navigate('/assignments')}>
              去批一份作业
            </Button>
          </Panel>
        ) : (
          <>
            {/* 个人 / 班级 */}
            <div className="mb-4 flex gap-2">
              {(
                [
                  ['person', '个人', IconUsers],
                  ['class', '班级', IconChart],
                ] as const
              ).map(([k, label, Icon]) => {
                const on = tab === k
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k)}
                    className="flex flex-1 items-center justify-center gap-2 py-2.5"
                    style={{
                      border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                      background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                      color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                      borderRadius: 4,
                      fontSize: 13.5,
                      fontWeight: on ? 640 : 500,
                    }}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                )
              })}
            </div>

            {tab === 'person' ? (
              <div className="mb-4">
                <Sect>每个人的错题账 · 按丢分排序</Sect>
                <Panel className="overflow-hidden">
                  {books.every((b) => b.totalWrong === 0) ? (
                    <div className="px-3 py-5 text-center" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                      这段时间没有人错题。
                    </div>
                  ) : (
                    books.map((b, i) => (
                      <button
                        key={b.studentNo}
                        type="button"
                        className="row w-full"
                        style={{
                          padding: '11px 12px',
                          borderBottom: i === books.length - 1 ? undefined : '1px solid var(--color-line)',
                          opacity: b.totalWrong ? 1 : 0.5,
                        }}
                        onClick={() => {
                          pick.reset()
                          setOpenNo(b.studentNo)
                        }}
                      >
                        <span
                          className="num grid shrink-0 place-items-center"
                          style={{
                            width: 34,
                            height: 34,
                            border: '1px solid var(--color-line2)',
                            borderRadius: 4,
                            background: 'var(--color-surface2)',
                            fontSize: 12.5,
                            fontWeight: 700,
                            color: b.totalWrong ? 'var(--color-ink)' : 'var(--color-ink4)',
                          }}
                        >
                          {b.studentNo}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate" style={{ fontSize: 14, fontWeight: 560 }}>
                            {b.name}
                          </span>
                          <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                            {b.totalWrong ? (
                              <>
                                错 <span className="num">{b.totalWrong}</span> 处 · 丢{' '}
                                <span className="num">{b.totalLost.toFixed(1)}</span> 分
                                {b.points[0] ? ` · 最弱：${b.points[0].name}` : ''}
                              </>
                            ) : (
                              '全对'
                            )}
                          </span>
                        </span>
                        {b.totalWrong ? <IconChevronRight size={16} /> : <IconCheck size={16} />}
                      </button>
                    ))
                  )}
                </Panel>
              </div>
            ) : (
              <div className="mb-4">
                <Sect>班级高频错点 · 跨作业反复错的排前面</Sect>
                <Panel bodyClass="p-3">
                  {cls.points.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>还没有数据。</div>
                  ) : (
                    <>
                      {cls.points.slice(0, 12).map((p) => {
                        const ids = cls.points.map((x) => x.pointId)
                        const on = pick.isOn(p.pointId, ids)
                        return (
                        <div
                          key={p.pointId}
                          className="flex items-center gap-2.5 py-2"
                          style={{ borderTop: '1px solid var(--color-line)', opacity: on ? 1 : 0.45 }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => pick.toggle(p.pointId, ids)}
                            style={{ width: 15, height: 15, accentColor: 'var(--color-accent)', flexShrink: 0 }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="truncate" style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                              {p.name}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                              {p.chapter} · <span className="num">{p.studentsHit}</span>/
                              <span className="num">{cls.totalStudents}</span> 人错过 · 分布在{' '}
                              <span className="num">{p.spread}</span> 份作业里
                            </span>
                          </span>
                          {p.spread >= 2 ? <Tag tone="bad">反复错</Tag> : null}
                          <span
                            className="num shrink-0"
                            style={{ fontSize: 13, fontWeight: 700, width: 52, textAlign: 'right' }}
                          >
                            {p.classLost.toFixed(0)} 分
                          </span>
                        </div>
                        )
                      })}
                    </>
                  )}
                </Panel>
              </div>
            )}

            <Button
              block
              variant="primary"
              className="mb-3"
              icon={<IconDownload size={16} />}
              onClick={async () => {
                const ids = cls.points.map((x) => x.pointId)
                const use = pick.itemsOf(cls.points, ids)
                if (!use.length) {
                  push({ text: '一个知识点都没勾，没法出卷', tone: 'warn' })
                  return
                }
                try {
                  const n = await downloadPracticeDocx(
                    use,
                    {
                      title: `班级错题重练 · ${klass?.name ?? ''}`,
                      subtitle: `按知识点整理 · 共 ${ids.filter((i) => pick.isOn(i, ids)).length} 个知识点、${use.length} 道题`,
                      answerSpace: false,
                    },
                    `班级错题重练-${klass?.name ?? ''}.docx`,
                  )
                  push({ text: `已生成 ${n} 题的练习卷`, tone: 'ok' })
                } catch (e) {
                  push({ text: e instanceof Error ? e.message : '生成失败', tone: 'bad' })
                }
              }}
            >
              生成班级错题重练卷
            </Button>

            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              丢分 = 错误率 × 该题分值。一道题挂了多个知识点时，丢分按个数均摊 ——
              不然同一个知识点会被重复计算，排行就虚高了。
            </p>
          </>
        )}
      </Page>

      {/* 个人详情 */}
      <Sheet open={Boolean(open)} onClose={() => setOpenNo(null)} title={open ? `${open.name} 的错题` : ''}>
        {open ? (
          open.totalWrong === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.9 }}>
              这段时间没有错题。
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2" style={{ fontSize: 13 }}>
                <span className="flex items-center gap-1.5">
                  <IconTarget size={15} />
                  错 <b className="num">{open.totalWrong}</b> 处
                </span>
                <span className="flex items-center gap-1.5">
                  <IconChart size={15} />
                  丢 <b className="num">{open.totalLost.toFixed(1)}</b> 分
                </span>
              </div>

              <Sect>哪个知识点掉分最多 · 勾掉不想练的</Sect>
              <Panel className="mb-4" bodyClass="p-3">
                {open.points.slice(0, 8).map((p) => {
                  const ids = open.points.map((x) => x.pointId)
                  const on = pick.isOn(p.pointId, ids)
                  const max = open.points[0]?.lost ?? 1
                  const pct = max > 0 ? Math.max(3, Math.round((p.lost / max) * 100)) : 0
                  return (
                    <label
                      key={p.pointId}
                      className="flex items-center gap-2.5 py-1.5"
                      style={{ cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => pick.toggle(p.pointId, ids)}
                        style={{ width: 15, height: 15, accentColor: 'var(--color-accent)', flexShrink: 0 }}
                      />
                      <span
                        className="truncate"
                        style={{ width: 92, fontSize: 12, flexShrink: 0, opacity: on ? 1 : 0.45 }}
                      >
                        {p.name}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          height: 8,
                          background: 'var(--color-surface3)',
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <i
                          style={{
                            display: 'block',
                            height: '100%',
                            width: `${pct}%`,
                            background: on ? 'var(--color-bad)' : 'var(--color-line3)',
                            borderRadius: 3,
                          }}
                        />
                      </span>
                      <span
                        className="num"
                        style={{ fontSize: 12, width: 54, textAlign: 'right', flexShrink: 0, fontWeight: 600 }}
                      >
                        {p.lost.toFixed(1)} 分
                      </span>
                    </label>
                  )
                })}
              </Panel>

              <Sect>错过的题</Sect>
              <Panel className="mb-3" bodyClass="p-3">
                {open.items.map((it, i) => (
                  <div
                    key={`${it.assignmentId}-${it.seq}`}
                    className="flex gap-2.5 py-2.5"
                    style={{ borderTop: i ? '1px solid var(--color-line)' : undefined }}
                  >
                    {it.imgs?.length ? (
                      <img
                        src={it.imgs[0]}
                        alt=""
                        style={{
                          width: 46,
                          height: 46,
                          objectFit: 'contain',
                          border: '1px solid var(--color-line2)',
                          borderRadius: 3,
                          background: '***REMOVED***fff',
                          flexShrink: 0,
                        }}
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="num" style={{ fontSize: 13, fontWeight: 700 }}>
                          第 {it.seq} 题
                        </span>
                        {it.score !== undefined ? (
                          <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                            {it.score} 分
                          </span>
                        ) : null}
                        <span className="flex-1" />
                        <span
                          className="num"
                          style={{
                            fontSize: 11,
                            color:
                              it.classRate >= 0.5 ? 'var(--color-ink3)' : 'var(--color-warn)',
                          }}
                        >
                          全班 {Math.round(it.classRate * 100)}% 错
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {it.points.map((p) => (
                          <Tag key={p} tone="idle">
                            {open.points.find((x) => x.pointId === p)?.name ?? p}
                          </Tag>
                        ))}
                      </div>
                      <div
                        className="mt-1"
                        style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.6 }}
                      >
                        {it.assignmentTitle} · {it.date}
                      </div>
                    </div>
                  </div>
                ))}
              </Panel>

              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                「全班 N% 错」用来分辨：这个知识点是他一个人没掌握，还是班里普遍没讲透 ——
                <b>后者更该在课堂上重讲</b>。
              </p>

              <Button
                block
                variant="primary"
                className="mt-3"
                icon={<IconDownload size={16} />}
                onClick={async () => {
                  const ids = open.points.map((x) => x.pointId)
                  const use = pick.itemsOf(open.points, ids)
                  if (!use.length) {
                    push({ text: '一个知识点都没勾，没法出卷', tone: 'warn' })
                    return
                  }
                  try {
                    const n = await downloadPracticeDocx(
                      use,
                      {
                        title: `错题重练 · ${klass?.name ?? ''} ${open.name}`,
                        subtitle: `按知识点整理 · 共 ${ids.filter((i) => pick.isOn(i, ids)).length} 个知识点、${use.length} 道题`,
                      },
                      `错题重练-${open.name}-${open.studentNo}.docx`,
                    )
                    push({ text: `已生成 ${n} 题的练习卷`, tone: 'ok' })
                  } catch (e) {
                    push({ text: e instanceof Error ? e.message : '生成失败', tone: 'bad' })
                  }
                }}
              >
                生成错题重练卷
              </Button>
            </>
          )
        ) : null}
      </Sheet>
    </>
  )
}
