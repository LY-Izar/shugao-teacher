import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCalendar,
  IconCheck,
  IconClipboard,
  IconGrid,
  IconHash,
  IconMegaphone,
  IconPlus,
  IconRefresh,
  IconScan,
  IconTrash,
  IconUsers,
  IconZap,
} from '../components/icons'
import { Button, Empty, PageHead, Panel, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { STATUS_TEXT, type Assignment, type AssignmentStatus } from '../data/types'
import { collectStats } from '../lib/assignments'
import { friendlyDate, isoOffset, parseISODate, toISODate } from '../lib/date'

const wrongTotal = (a: Assignment) =>
  Object.values(a.wrong ?? {}).reduce((n, keys) => n + keys.length, 0)

type Filter = 'all' | 'open' | 'collected'
type TimeFilter = 'all' | 'today' | 'week' | 'month'

const FILTERS: Array<{ k: Filter; label: string }> = [
  { k: 'all', label: '全部' },
  { k: 'open', label: '待收缴' },
  { k: 'collected', label: '待批改' },
]

const TIME_FILTERS: Array<{ k: TimeFilter; label: string }> = [
  { k: 'all', label: '全部时间' },
  { k: 'today', label: '今天' },
  { k: 'week', label: '最近 7 天' },
  { k: 'month', label: '最近 30 天' },
]

/** 距今天的第几天（负数表示过去） */
function daysAgo(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = parseISODate(iso)
  return Math.round((today.getTime() - d.getTime()) / 86400000)
}

function inTimeRange(iso: string, f: TimeFilter): boolean {
  if (f === 'all') return true
  const diff = daysAgo(iso)
  if (f === 'today') return diff <= 0
  if (f === 'week') return diff <= 6
  return diff <= 29
}

function statusTone(s: AssignmentStatus): 'idle' | 'accent' | 'ok' | 'warn' {
  if (s === 'open') return 'warn'
  if (s === 'collected') return 'accent'
  if (s === 'archived') return 'idle'
  return 'ok'
}

/** 每份档案的主入口：待收缴去收缴，待批改去批改，已批改看统计 */
function primaryPath(a: { id: string; status: AssignmentStatus }): string {
  if (a.status === 'open') return `/assignments/${a.id}/collect`
  if (a.status === 'collected') return `/assignments/${a.id}/grade`
  return `/assignments/${a.id}/stats`
}

const PRIMARY_LABEL: Record<AssignmentStatus, string> = {
  open: '拍照查缺',
  collected: '去批改',
  graded: '看统计',
  reviewed: '看统计',
  archived: '查看',
}

export default function Assignments() {
  const assignments = useStore((s) => s.assignments)
  const classes = useStore((s) => s.classes)
  const removeAssignment = useStore((s) => s.removeAssignment)
  const addAssignment = useStore((s) => s.addAssignment)
  const updateAssignment = useStore((s) => s.updateAssignment)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const [filter, setFilter] = useState<Filter>('all')
  const [classFilter, setClassFilter] = useState<string>('all')
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** 正在改布置日期的档案 id */
  const [dateFor, setDateFor] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      assignments
        .map((a) => {
          const klass = classes.find((c) => c.id === a.classId)
          return { a, klass, stats: collectStats(klass?.students ?? [], a) }
        })
        .filter((r) => (filter === 'all' ? true : r.a.status === filter))
        .filter((r) => (classFilter === 'all' ? true : r.a.classId === classFilter))
        .filter((r) => inTimeRange(r.a.assignDate, timeFilter))
        // 默认排序：时间最近的在最上面
        .sort(
          (x, y) =>
            (x.a.assignDate < y.a.assignDate ? 1 : x.a.assignDate > y.a.assignDate ? -1 : 0) ||
            y.a.createdAt - x.a.createdAt,
        ),
    [assignments, classes, filter, classFilter, timeFilter],
  )

  const filtered = filter !== 'all' || classFilter !== 'all' || timeFilter !== 'all'

  const pending = assignments.filter((a) => a.status === 'open').length
  const last = [...assignments].sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1))[0]

  return (
    <>
      <PageHead
        title="作业"
        sub={`${assignments.length} 份档案 · ${pending} 份待收缴`}
        right={
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={15} />}
            onClick={() => navigate('/assignments/new')}
          >
            新建
          </Button>
        }
      />

      <Page>
        {/* 筛选：班级 · 时间 · 状态 */}
        <div className="mb-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input"
              style={{ width: 'auto', height: 34, fontSize: 13 }}
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              aria-label="按班级筛选"
            >
              <option value="all">全部班级</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              style={{ width: 'auto', height: 34, fontSize: 13 }}
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
              aria-label="按时间筛选"
            >
              {TIME_FILTERS.map((t) => (
                <option key={t.k} value={t.k}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="flex-1" />
            {filtered ? (
              <button
                type="button"
                onClick={() => {
                  setFilter('all')
                  setClassFilter('all')
                  setTimeFilter('all')
                }}
                style={{ fontSize: 12, color: 'var(--color-ink3)' }}
              >
                清空筛选
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.k}
                  type="button"
                  data-on={filter === f.k}
                  onClick={() => setFilter(f.k)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {last ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconRefresh size={14} />}
                onClick={() => {
                  const id = addAssignment({
                    title: last.title,
                    classId: last.classId,
                    assignDate: toISODate(new Date()),
                    questionCount: last.questionCount,
                    templateId: last.templateId,
                  })
                  push({ text: '已按上次新建', tone: 'ok', desc: last.title })
                  navigate(`/assignments/${id}/collect`)
                }}
              >
                按上次新建
              </Button>
            ) : null}
          </div>
        </div>

        {rows.length === 0 ? (
          <Panel>
            <Empty
              icon={<IconClipboard size={24} />}
              title={assignments.length === 0 ? '还没有作业档案' : '没有符合筛选的档案'}
              desc={
                assignments.length === 0
                  ? '建立档案后才能登记收缴、进入批改。题目数量来自练习册模板，不需要识别图片。'
                  : '换一个班级或时间范围试试。'
              }
              action={
                assignments.length === 0 ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<IconPlus size={15} />}
                    onClick={() => navigate('/assignments/new')}
                  >
                    建立第一份档案
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      setFilter('all')
                      setClassFilter('all')
                      setTimeFilter('all')
                    }}
                  >
                    清空筛选
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-2.5 stagger">
            {rows.map(({ a, klass, stats }) => (
              <Panel key={a.id} className="overflow-hidden">
                <button
                  type="button"
                  className="row"
                  style={{ padding: 14, alignItems: 'flex-start' }}
                  onClick={() => navigate(primaryPath(a))}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <Tag tone={statusTone(a.status)}>{STATUS_TEXT[a.status]}</Tag>
                      <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                        {friendlyDate(a.assignDate)}
                      </span>
                    </span>
                    <span
                      className="mt-1.5 block truncate"
                      style={{ fontSize: 15, fontWeight: 640 }}
                    >
                      {a.title}
                    </span>
                    <span
                      className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1"
                      style={{ fontSize: 12, color: 'var(--color-ink3)' }}
                    >
                      <span className="flex items-center gap-1.5">
                        <IconUsers size={13} />
                        {klass?.name ?? '班级已删除'}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <IconGrid size={13} />
                        <span className="num">{a.questionCount}</span> 题
                      </span>
                      <span className="flex items-center gap-1.5">
                        <IconHash size={13} />
                        {stats.registered ? (
                          <>
                            已交 <span className="num">{stats.submitted}</span>/
                            <span className="num">{stats.total}</span>
                          </>
                        ) : (
                          '未登记'
                        )}
                      </span>
                      {stats.registered && stats.missing > 0 ? (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: 'var(--color-warn)', fontWeight: 600 }}
                        >
                          未交 <span className="num">{stats.missing}</span>
                        </span>
                      ) : null}
                      {stats.registered && stats.missing === 0 ? (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: 'var(--color-ok)', fontWeight: 600 }}
                        >
                          <IconCheck size={13} />
                          全员交齐
                        </span>
                      ) : null}
                      {a.status !== 'open' && a.status !== 'collected' ? (
                        <span
                          className="flex items-center gap-1"
                          style={{ color: 'var(--color-bad)', fontWeight: 600 }}
                        >
                          错题 <span className="num">{wrongTotal(a)}</span>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>

                <div
                  className="flex items-center gap-1 px-3 py-2"
                  style={{
                    borderTop: '1px solid var(--color-line)',
                    background: 'var(--color-surface2)',
                  }}
                >
                  <Button
                    size="sm"
                    variant={a.status === 'graded' || a.status === 'reviewed' ? 'ghost' : 'primary'}
                    icon={a.status === 'collected' ? <IconZap size={14} /> : <IconScan size={14} />}
                    onClick={() => navigate(primaryPath(a))}
                  >
                    {PRIMARY_LABEL[a.status]}
                  </Button>
                  {/* 收缴不再挡着批改：有同学当天才交，不能因为没登记完就不让批 */}
                  {a.status === 'open' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconZap size={14} />}
                      onClick={() => navigate(`/assignments/${a.id}/grade`)}
                    >
                      直接批改
                    </Button>
                  ) : null}
                  {a.status !== 'open' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate(`/assignments/${a.id}/collect`)}
                    >
                      收缴记录
                    </Button>
                  ) : null}
                  {/* 布置日期建完之后也要能改 —— 之前建了就锁死了 */}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconCalendar size={14} />}
                    onClick={() => setDateFor(a.id)}
                  >
                    改日期
                  </Button>
                  {a.status === 'graded' || a.status === 'reviewed' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<IconMegaphone size={14} />}
                      onClick={() => navigate(`/assignments/${a.id}/call`)}
                    >
                      呼叫
                    </Button>
                  ) : null}
                  <span className="flex-1" />
                  <button
                    type="button"
                    aria-label="删除"
                    onClick={() => setConfirmId(a.id)}
                    style={{ color: 'var(--color-ink4)', padding: 6 }}
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </Panel>
            ))}
          </div>
        )}

        <div
          className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <span className="flex items-center gap-1.5">
            <IconCalendar size={13} /> 日期默认取前一天
          </span>
          <span className="flex items-center gap-1.5">
            <IconGrid size={13} /> 题号来自模板，不依赖图片识别
          </span>
        </div>
      </Page>

      {/* 删除确认 */}
      <Sheet
        open={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="删除作业档案"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setConfirmId(null)}>
              取消
            </Button>
            <Button
              block
              variant="danger"
              onClick={() => {
                if (confirmId) removeAssignment(confirmId)
                setConfirmId(null)
                push({ text: '档案已删除', tone: 'warn' })
              }}
            >
              确认删除
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 13.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
          将删除「{assignments.find((x) => x.id === confirmId)?.title}」及其收缴与批改记录。
          该操作不可恢复。
        </div>
      </Sheet>

      {/* 改布置日期：建完之后也能改 */}
      <Sheet open={Boolean(dateFor)} onClose={() => setDateFor(null)} title="修改布置日期">
        {dateFor ? (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {[
                ['今天', 0],
                ['昨天', -1],
                ['前天', -2],
              ].map(([label, off]) => {
                const iso = isoOffset(off as number)
                const on = assignments.find((x) => x.id === dateFor)?.assignDate === iso
                return (
                  <button
                    key={label as string}
                    type="button"
                    onClick={() => updateAssignment(dateFor, { assignDate: iso })}
                    style={{
                      padding: '4px 11px',
                      borderRadius: 4,
                      fontSize: 12.5,
                      border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                      background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                      color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                      fontWeight: on ? 650 : 500,
                    }}
                  >
                    {label as string}
                  </button>
                )
              })}
            </div>
            <label className="block">
              <span className="label">也可以直接选</span>
              <input
                className="input"
                type="date"
                value={assignments.find((x) => x.id === dateFor)?.assignDate ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) updateAssignment(dateFor, { assignDate: v })
                }}
              />
            </label>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              改的是"这次作业算哪天的"。收缴与批改记录不受影响。
            </p>
            <Button
              block
              variant="primary"
              className="mt-3"
              onClick={() => {
                push({ text: '布置日期已更新', tone: 'ok' })
                setDateFor(null)
              }}
            >
              完成
            </Button>
          </>
        ) : null}
      </Sheet>
    </>
  )
}
