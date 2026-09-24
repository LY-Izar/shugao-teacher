import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCalendar,
  IconCheck,
  IconClipboard,
  IconGrid,
  IconHash,
  IconList,
  IconPlus,
  IconRefresh,
  IconScan,
  IconTrash,
  IconUsers,
  IconZap,
} from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { STATUS_TEXT, type Assignment, type AssignmentStatus, type Klass } from '../data/types'
import { collectStats } from '../lib/assignments'
import { friendlyDate, isoOffset, parseISODate, toISODate } from '../lib/date'
import { SUBJECTS, subjectCodeOf, subjectName } from '../lib/subjects'

const wrongTotal = (a: Assignment) =>
  Object.values(a.wrong ?? {}).reduce((n, keys) => n + keys.length, 0)

/** 这一科显示什么：字典名优先，认不出来就照原样显示（兼容期老档案） */
const subjectLabelOf = (a: Assignment) => subjectName(subjectCodeOf(a), a.subject || '未标学科')

type Filter = 'all' | 'open' | 'collected'
type TimeFilter = 'all' | 'today' | 'week' | 'month'

/**
 * 列表怎么排：
 *  · `time`    按时间（**默认**，与以前完全一样）
 *  · `subject` **按学科分类**：一科一段，段头写清这一科有几份、几份待收缴、几份待批改
 *
 * 为什么要有后一种（用户 2026-09-27：「现在有多学科了，查看作业档案再加个按学科分类」）：
 * 一份档案只属于**一科**，而列表原来是一条时间流水 ——
 * 教两个学科的老师、以及看全科的班主任，都得自己在心里把科目分开。
 *
 * 实现纪律：
 *  · 分组判据走 `subjectCodeOf()`（兼容期老档案按显示名反查字典），**不新增任何字段**；
 *  · 「全部学科」时认不出的学科**照常列出来**（单开一段「未标学科」那类名字），
 *    绝不静默藏数据 —— 与筛选下拉框"只列出现过的学科"是同一条纪律；
 *  · 分组**只改渲染顺序**，不改任何筛选/统计语义（份数、待办都是从同一份 rows 上数的）。
 */
type ViewMode = 'time' | 'subject'

const VIEW_MODES: Array<{ k: ViewMode; label: string }> = [
  { k: 'time', label: '按时间' },
  { k: 'subject', label: '按学科' },
]

/** 列表里的一行（`rows` 的元素） */
type Row = { a: Assignment; klass?: Klass; stats: ReturnType<typeof collectStats> }

/** 按学科分类时，渲染序列 = 段头 + 这一科的若干行 */
type ListItem =
  | { kind: 'head'; key: string; name: string; count: number; open: number; collected: number }
  | { kind: 'row'; key: string; r: Row }

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

/**
 * 已经动过批改的档案。
 *
 * 判定只用云端就有的 `confirmedNos` —— **不能依赖本机草稿**：
 * 换台设备、或者清过缓存，草稿就没了，档案会突然退回"待收缴"，
 * 教师会以为批改白做了。
 */
function gradingStarted(a: { confirmedNos?: string[] }): boolean {
  return (a.confirmedNos?.length ?? 0) > 0
}

/**
 * 每份档案的主入口。
 *  - 已批改 → 点档案看统计
 *  - **批改中（临时保存过）→ 点档案继续批**，而不是回到查人页
 *  - 还没动 → 去收缴
 */
function primaryPath(a: { id: string; status: AssignmentStatus; confirmedNos?: string[] }): string {
  if (a.status === 'graded' || a.status === 'reviewed') return `/assignments/${a.id}/stats`
  if (gradingStarted(a)) return `/assignments/${a.id}/grade`
  if (a.status === 'collected') return `/assignments/${a.id}/grade`
  return `/assignments/${a.id}/collect`
}

function primaryLabel(a: { status: AssignmentStatus; confirmedNos?: string[] }): string {
  if (a.status === 'graded' || a.status === 'reviewed') return '看统计'
  if (gradingStarted(a)) return '继续批改'
  if (a.status === 'collected') return '去批改'
  return '拍照查缺'
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
  const [subjectFilter, setSubjectFilter] = useState<string>('all')
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [view, setView] = useState<ViewMode>('time')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  /** 正在改布置日期的档案 id */
  const [dateFor, setDateFor] = useState<string | null>(null)

  /**
   * 学科筛选项只列**数据里真出现过的**学科。
   *
   * 不把字典 15 科全列出来的理由：没数据的那几项选了就是空列表，
   * 教师会以为是坏了。判据走 `subjectCodeOf()`（兼容期：老档案没有 code，
   * 按显示名反查），**认不出来的学科不会出现在筛选里** ——
   * 它们仍然在「全部学科」下看得见，不静默藏数据。
   */
  const subjectOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const a of assignments) {
      const c = subjectCodeOf(a)
      if (c) seen.add(c)
    }
    return SUBJECTS.filter((s) => seen.has(s.code))
  }, [assignments])

  const rows = useMemo<Row[]>(
    () =>
      assignments
        .map((a) => {
          const klass = classes.find((c) => c.id === a.classId)
          return { a, klass, stats: collectStats(klass?.students ?? [], a) }
        })
        .filter((r) => (filter === 'all' ? true : r.a.status === filter))
        .filter((r) => (classFilter === 'all' ? true : r.a.classId === classFilter))
        .filter((r) => (subjectFilter === 'all' ? true : subjectCodeOf(r.a) === subjectFilter))
        .filter((r) => inTimeRange(r.a.assignDate, timeFilter))
        // 默认排序：时间最近的在最上面
        .sort(
          (x, y) =>
            (x.a.assignDate < y.a.assignDate ? 1 : x.a.assignDate > y.a.assignDate ? -1 : 0) ||
            y.a.createdAt - x.a.createdAt,
        ),
    [assignments, classes, filter, classFilter, subjectFilter, timeFilter],
  )

  /** 有几种学科就有没有"分类"这回事：只有一科时不摆这个开关（摆了也是空转） */
  const multiSubject = subjectOptions.length > 1

  /**
   * 渲染序列。`time` 模式 = 原来那条流水（一个字节都没变）；
   * `subject` 模式 = 段头 + 该科的行，科与科之间按**字典顺序**排，
   * 认不出学科的（老档案 / 字典外的写法）排在最后，按名字排。
   */
  const listItems = useMemo<ListItem[]>(() => {
    if (view !== 'subject') return rows.map((r) => ({ kind: 'row', key: r.a.id, r }))
    const dictOrder = new Map(SUBJECTS.map((s, i) => [s.code, i]))
    const groups = new Map<
      string,
      { key: string; name: string; sort: number; rows: Row[] }
    >()
    for (const r of rows) {
      const code = subjectCodeOf(r.a)
      const key = code ?? `?${subjectLabelOf(r.a)}`
      const g = groups.get(key) ?? {
        key,
        name: subjectLabelOf(r.a),
        sort: code ? (dictOrder.get(code) ?? 900) : 999, // 字典外的排最后
        rows: [],
      }
      g.rows.push(r)
      groups.set(key, g)
    }
    const out: ListItem[] = []
    for (const g of [...groups.values()].sort(
      (x, y) => x.sort - y.sort || x.name.localeCompare(y.name, 'zh'),
    )) {
      out.push({
        kind: 'head',
        key: `h-${g.key}`,
        name: g.name,
        count: g.rows.length,
        open: g.rows.filter((r) => r.a.status === 'open').length,
        collected: g.rows.filter((r) => r.a.status === 'collected').length,
      })
      for (const r of g.rows) out.push({ kind: 'row', key: r.a.id, r })
    }
    return out
  }, [rows, view])

  const filtered =
    filter !== 'all' || classFilter !== 'all' || subjectFilter !== 'all' || timeFilter !== 'all'

  const pending = assignments.filter((a) => a.status === 'open').length
  const last = [...assignments].sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1))[0]

  return (
    <>
      <PageHead
        title="作业"
        sub={`${assignments.length} 份档案 · ${pending} 份待收缴`}
        right={
          <div className="flex items-center gap-1">
            {/*
              考试入口放这里（而不是塞进底部导航）：底部只有 5 个位置，
              而"考试"和"作业"本来就是同一件事的两个分支，放在一起最好找。
              ⚠️ 这只是**入口**，作业的数据与语义一个字节都没动 ——
              考试是独立的一条 /exams 路由族与两张独立的表。
            */}
            <Button size="sm" variant="ghost" icon={<IconHash size={14} />} onClick={() => navigate('/exams')}>
              考试
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<IconPlus size={15} />}
              onClick={() => navigate('/assignments/new')}
            >
              新建
            </Button>
          </div>
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
            {subjectOptions.length > 1 ? (
              <select
                className="input"
                style={{ width: 'auto', height: 34, fontSize: 13 }}
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                aria-label="按学科筛选"
              >
                <option value="all">全部学科</option>
                {subjectOptions.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
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
            {/*
              「按学科」这个开关**只在数据里真的有两种以上学科时**才摆出来
              （判据与上面那个学科下拉框同一条：`subjectOptions.length > 1`）——
              只有一科时它点了也是原样，属于多余的控件。
              ⚠️ 它必须待在这一行（flex-wrap 的那行）：塞进下面"状态"那一行会把
                 状态分段控件挤窄、四个字折成两行（实测过）。
            */}
            {multiSubject ? (
              <div
                className="seg"
                role="group"
                aria-label="列表排列方式"
                style={{ whiteSpace: 'nowrap' }}
              >
                {VIEW_MODES.map((v) => (
                  <button
                    key={v.k}
                    type="button"
                    data-on={view === v.k}
                    onClick={() => setView(v.k)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="flex-1" />
            {filtered ? (
              <button
                type="button"
                onClick={() => {
                  setFilter('all')
                  setClassFilter('all')
                  setSubjectFilter('all')
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
                  /*
                   * 「按上次新建」要**照着上一次的整份结构**建，不只是标题和题数。
                   * 少带 `statsMode` 时，极简模式的档案会被建成普通模式（页面按逐题渲染，
                   * 而这份档案根本没有逐题数据）；少带 `subQuestions` / `questionMeta` 时，
                   * 拆过的小题、识别出来的题型分值全都得重新录一遍 ——
                   * 而这正是"按上次新建"唯一的用处。
                   */
                  const id = addAssignment({
                    title: last.title,
                    classId: last.classId,
                    assignDate: toISODate(new Date()),
                    questionCount: last.questionCount,
                    templateId: last.templateId,
                    // 学科沿用上一份（显式传参，这次不是"老师的主学科"）
                    subjectCode: last.subjectCode,
                    statsMode: last.statsMode,
                    subQuestions: last.subQuestions,
                    questionMeta: last.questionMeta,
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
                  : '换一个班级、学科或时间范围试试。'
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
                      // 🔴 学科那一个也要清：漏了它，"清空筛选"之后列表还是空的，
                      // 教师会以为档案没了（这一条曾经真的漏过）
                      setSubjectFilter('all')
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
            {listItems.map((it) => {
              /*
               * 按学科分类时，段头先把这一科的家底交代清楚（几份 / 几份待收缴 / 几份待批改）——
               * 没有它，"分类"就只是把列表切断；有了它，一眼就知道哪一科还欠着活。
               */
              if (it.kind === 'head') {
                return (
                  <Sect key={it.key}>
                    {it.name} · {it.count} 份
                    {it.open ? ` · 待收缴 ${it.open}` : ''}
                    {it.collected ? ` · 待批改 ${it.collected}` : ''}
                  </Sect>
                )
              }
              const { a, klass, stats } = it.r
              const started = gradingStarted(a)
              return (
              <Panel key={it.key} className="overflow-hidden">
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
                        <IconList size={13} />
                        {subjectLabelOf(a)}
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
                    {primaryLabel(a)}
                  </Button>

                  {/* 已经临时保存过的：主入口是继续批，下面只留一个看统计的口子 */}
                  {started && a.status !== 'graded' && a.status !== 'reviewed' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate(`/assignments/${a.id}/stats`)}
                    >
                      查看当前统计情况
                    </Button>
                  ) : null}

                  {/* 还没动过批改才给「直接批改」——已经批过的人不需要 */}
                  {a.status === 'open' && !started ? (
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

                  {/* 确认完成批改之后才有改错登记。呼叫也在那一页里，档案下不再重复放 */}
                  {a.status === 'graded' || a.status === 'reviewed' ? (
                    <Button
                      size="sm"
                      variant={(a.correctionNos?.length ?? 0) > 0 ? 'primary' : 'ghost'}
                      icon={<IconCheck size={14} />}
                      onClick={() => navigate(`/assignments/${a.id}/correct`)}
                    >
                      改错登记
                      {a.correctionNos?.length
                        ? ` ${a.correctedNos?.length ?? 0}/${a.correctionNos.length}`
                        : ''}
                    </Button>
                  ) : null}
                  {/* 「补题目」「改日期」都挪到作业情况页右上角了 —— 那里才是档案的管理入口 */}
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
              )
            })}
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
