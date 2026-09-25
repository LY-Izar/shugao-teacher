import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconHash,
  IconInfo,
  IconPlus,
  IconScan,
  IconUsers,
  IconZap,
} from '../components/icons'
import { Button, Panel, Sect, Sheet, StatStrip, Tag, Track } from '../components/ui'
import { activeStudents, useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT } from '../data/types'
import { useMood } from '../hooks/useMood'
import { MoodBanner } from '../components/MoodModals'
import { MOOD_TEXT, greetingWord } from '../lib/mood'
import { awayText, weekdayOf } from '../lib/schedule'
import { collectStats } from '../lib/assignments'
import { friendlyDate } from '../lib/date'
import { analyzeRoster } from '../lib/roster'
import { currentIdentityLabel, IDENTITY_TAG_STYLE } from '../lib/roles'

const todoPath = (a: { id: string; status: string }) =>
  a.status === 'collected' ? `/assignments/${a.id}/grade` : `/assignments/${a.id}/collect`

function greeting() {
  return greetingWord()
}

export default function Workbench() {
  const teacher = useStore((s) => s.teacher)
  /* 「当前身份」标签：有管理身份显示身份，没有才显示学科（与侧栏同一处实现，见 lib/roles.ts） */
  const myRoles = useStore((s) => s.myRoles)
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const isDemo = useStore((s) => s.isDemo)
  const streakDays = useStore((s) => s.streakDays)
  const resetDemo = useStore((s) => s.resetDemo)
  const clearAll = useStore((s) => s.clearAll)
  const addClass = useStore((s) => s.addClass)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm] = useState({ name: '', grade: '高二', year: '2025-2026' })

  const total = classes.reduce((n, c) => n + activeStudents(c).length, 0)

  const moodState = useMood()
  const banner =
    moodState.mood === 'normal'
      ? null
      : moodState.mood === 'holiday'
        ? moodState.festive
        : MOOD_TEXT[moodState.mood]
  const todayItems = moodState.day.items
  const nextItemId = moodState.day.next?.id

  const pending = useMemo(
    () =>
      assignments
        .filter((a) => a.status === 'open' || a.status === 'collected')
        .map((a) => {
          const klass = classes.find((c) => c.id === a.classId)
          return { a, klass, stats: collectStats(klass?.students ?? [], a) }
        })
        .sort((x, y) => (x.a.assignDate < y.a.assignDate ? 1 : -1)),
    [assignments, classes],
  )

  const health = useMemo(() => classes.map((c) => ({ c, h: analyzeRoster(c.students) })), [classes])

  const today = new Date()
  const dateText = `${today.getMonth() + 1} 月 ${today.getDate()} 日 · 周${
    '日一二三四五六'[today.getDay()]
  }`

  const tiles = [
    {
      key: 'assignment',
      icon: <IconClipboard size={19} />,
      title: '新建作业档案',
      desc: '名称 · 题数 · 班级 · 日期',
      onClick: () => navigate('/assignments/new'),
    },
    {
      key: 'collect',
      icon: <IconScan size={19} />,
      title: pending[0]?.a.status === 'collected' ? '继续批改' : '收作业查缺',
      desc: pending.length ? `${pending.length} 份待处理` : '拍一摞作业的侧面',
      onClick: () => navigate(pending[0] ? todoPath(pending[0].a) : '/assignments'),
    },
    {
      key: 'photo',
      icon: <IconCamera size={19} />,
      title: '拍照录名单',
      desc: '录入新班级花名册',
      onClick: () => navigate(classes[0] ? `/classes/${classes[0].id}/import/photo` : '/classes'),
    },
    {
      key: 'manage',
      icon: <IconUsers size={19} />,
      title: '班级管理',
      desc: `${classes.length} 个班 · ${total} 人`,
      onClick: () => navigate('/classes'),
    },
  ]

  return (
    <Page>
      {/* 氛围首栏：假期 / 夜深 / 周末 / 今天已完成 */}
      {banner ? (
        <MoodBanner
          title={banner.title}
          sub={banner.sub}
          tone={moodState.mood === 'holiday' ? 'festive' : 'default'}
        />
      ) : null}

      {/* 问候 */}
      <div className="anim-in mb-4 pt-1">
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', letterSpacing: '.04em' }}>
          {dateText}
        </div>
        <h1 style={{ fontSize: 23, fontWeight: 680, letterSpacing: '-.02em', marginTop: 2 }}>
          {greeting()}，{teacher?.name ?? '老师'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/*
            同上：有管理身份显示身份（**多个身份全露**，如「教导处 · 年级主任」），没有才显示学科。
            这一行本来就是 `flex-wrap`，多身份时后面的标签整块落到下一行 —— 实测 3 / 4 个身份都不溢出。
          */}
          <span className="tag tag-accent" style={IDENTITY_TAG_STYLE}>
            {currentIdentityLabel(myRoles, teacher)}
          </span>
          <Tag tone="idle">高二 · 2025-2026</Tag>
          {streakDays > 1 ? <Tag tone="ok">连续使用 {streakDays} 天</Tag> : null}
        </div>
      </div>

      {/* 演示数据提示 */}
      {isDemo ? (
        <div
          className="anim-in mb-4 flex items-start gap-3 p-3"
          style={{
            background: 'var(--color-warnsoft)',
            border: '1px solid ***REMOVED***ecd9ae',
            borderRadius: 6,
          }}
        >
          <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
            <IconAlert size={17} />
          </span>
          <div className="flex-1">
            <div style={{ fontSize: 13, fontWeight: 620, color: '***REMOVED***8a5a12' }}>
              当前是演示数据（2 个虚拟班级 + 3 份作业档案）
            </div>
            <div style={{ fontSize: 12, color: '***REMOVED***96702f', marginTop: 2, lineHeight: 1.5 }}>
              姓名均为程序拼装生成，不对应任何真实个人。开始录入真实班级后会自动切换。
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                resetDemo()
                push({ text: '演示数据已重置', tone: 'ok' })
              }}
            >
              重置
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearAll()
                push({ text: '已清空，请重新登录', tone: 'ok' })
              }}
            >
              清空
            </Button>
          </div>
        </div>
      ) : null}

      {/* 数据条 */}
      <Panel className="anim-in mb-4 overflow-hidden">
        <StatStrip
          items={[
            { k: '班级', v: classes.length },
            { k: '学生', v: total },
            {
              k: '待办',
              v: pending.length,
              tone: pending.length ? 'var(--color-warn)' : 'var(--color-ok)',
            },
          ]}
        />
      </Panel>

      {/* 待办 */}
      <div className="mb-4">
        <Sect>今日待办</Sect>
        <Panel className="overflow-hidden">
          {pending.length === 0 ? (
            <div className="flex items-center gap-2.5 p-3.5">
              <span style={{ color: 'var(--color-ok)' }}>
                <IconCheck size={17} />
              </span>
              <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                没有待处理的作业。去「作业」里新建一份档案开始记录。
              </span>
            </div>
          ) : (
            <div className="stagger">
              {pending.map(({ a, klass, stats }) => (
                <button
                  key={a.id}
                  type="button"
                  className="row"
                  style={{ padding: 13 }}
                  onClick={() => navigate(todoPath(a))}
                >
                  <span
                    className="grid place-items-center shrink-0"
                    style={{
                      width: 34,
                      height: 34,
                      border: '1px solid var(--color-line2)',
                      borderRadius: 4,
                      background: 'var(--color-surface2)',
                      color: 'var(--color-accent)',
                    }}
                  >
                    {a.status === 'collected' ? <IconZap size={17} /> : <IconScan size={17} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" style={{ fontSize: 14, fontWeight: 620 }}>
                      {a.title}
                    </span>
                    <span
                      className="mt-0.5 flex items-center gap-3"
                      style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                    >
                      <span>{klass?.name ?? '—'}</span>
                      <span>{friendlyDate(a.assignDate)}</span>
                      <span>
                        {a.status === 'collected' ? (
                          /*
                           * 极简模式**不显示题数**：它没有"题"这个概念（只记 优/良/差），
                           * 而 `questionCount` 在建档时仍被写成 6 —— 那个数字会让老师以为
                           * 点进去有 6 道题的逐题数据。改成这个数字**真正有意义**的口径：
                           * 应交多少人（与「待收缴」那一行同一句话）。
                           * ⛔ 普通模式那行「N 题待批改」照旧，别顺手也去掉。
                           */
                          a.statsMode === 'simple' ? (
                            <>
                              应交 <b className="num">{stats.total}</b> 人
                            </>
                          ) : (
                            <>
                              <span className="num">{a.questionCount}</span> 题待批改
                            </>
                          )
                        ) : (
                          <>
                            应交 <b className="num">{stats.total}</b> 人
                          </>
                        )}
                      </span>
                    </span>
                  </span>
                  <Tag tone={a.status === 'collected' ? 'accent' : 'warn'}>
                    {a.status === 'collected' ? '待批改' : '待收缴'}
                  </Tag>
                  <IconChevronRight size={16} />
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* 今天的日程（假期不显示 —— 那天本来就没有课） */}
      {todayItems.length > 0 && moodState.mood !== 'holiday' ? (
        <div className="mb-4">
          <Sect>今天的日程 · {WEEKDAY_TEXT[weekdayOf(moodState.now) - 1]}</Sect>
          <Panel className="overflow-hidden">
            <div className="stagger">
              {todayItems.map((it) => {
                const isNext = it.id === nextItemId
                return (
                  <button
                    key={it.id}
                    type="button"
                    className="row"
                    style={{ padding: 12 }}
                    onClick={() => navigate('/schedule')}
                  >
                    <span
                      className="num shrink-0"
                      style={{
                        width: 46,
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: isNext ? 'var(--color-accent)' : 'var(--color-ink2)',
                      }}
                    >
                      {it.start}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ fontSize: 14, fontWeight: 620 }}>
                        {it.title}
                      </span>
                      <span
                        className="mt-0.5 flex items-center gap-3"
                        style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                      >
                        <span>
                          {it.start}–{it.end}
                        </span>
                        {it.room ? <span>{it.room}</span> : null}
                      </span>
                    </span>
                    {isNext && moodState.day.minutesToNext !== null ? (
                      <Tag tone="accent">{awayText(moodState.day.minutesToNext)}</Tag>
                    ) : null}
                    <IconChevronRight size={16} />
                  </button>
                )
              })}
            </div>
          </Panel>
        </div>
      ) : null}

      {/* 快捷操作 */}
      <div className="mb-4">
        <Sect>快捷操作</Sect>        <div className="grid grid-cols-2 gap-2.5 stagger">
          {tiles.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={t.onClick}
              className="panel group relative flex flex-col gap-2 p-3.5 text-left transition-all"
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-line3)'
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-line)'
                e.currentTarget.style.transform = 'none'
              }}
            >
              <span
                className="grid place-items-center"
                style={{
                  width: 32,
                  height: 32,
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  color: 'var(--color-accent)',
                  background: 'var(--color-surface2)',
                }}
              >
                {t.icon}
              </span>
              <span>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 620 }}>{t.title}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  {t.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 班级概览 */}
      <div className="mb-4">
        <Sect>我的班级</Sect>
        <Panel className="overflow-hidden">
          {classes.length === 0 ? (
            <div className="empty">
              <IconUsers size={26} />
              <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>还没有班级</div>
              <div style={{ fontSize: 13 }}>先建一个班级，再把学生名单录进来</div>
              <Button
                variant="primary"
                size="sm"
                icon={<IconPlus size={15} />}
                onClick={() => setNewOpen(true)}
              >
                新建班级
              </Button>
            </div>
          ) : (
            <div className="stagger">
              {health.map(({ c, h }) => {
                const pct = h.count ? (h.count / Math.max(h.maxNo, h.count)) * 100 : 0
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="row"
                    onClick={() => navigate(`/classes/${c.id}`)}
                  >
                    <span
                      className="grid place-items-center shrink-0"
                      style={{
                        width: 36,
                        height: 36,
                        border: '1px solid var(--color-line2)',
                        borderRadius: 4,
                        background: 'var(--color-surface2)',
                        color: 'var(--color-ink2)',
                      }}
                    >
                      <IconUsers size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span style={{ fontSize: 14.5, fontWeight: 620 }}>{c.name}</span>
                        {h.healthy ? (
                          <Tag tone="ok">名单完整</Tag>
                        ) : (
                          <Tag tone="warn">
                            {h.gaps.length > 0
                              ? `缺 ${h.gaps.length} 个号`
                              : h.dupNames.length > 0
                                ? '有重名'
                                : '待核对'}
                          </Tag>
                        )}
                      </span>
                      <span
                        className="mt-1.5 flex items-center gap-2"
                        style={{ fontSize: 12, color: 'var(--color-ink3)' }}
                      >
                        <span className="num">{h.count}</span> 人
                        <span style={{ flex: 1, maxWidth: 96 }}>
                          <Track value={pct} tone={h.healthy ? 'var(--color-ok)' : undefined} />
                        </span>
                        <span className="num">1–{h.maxNo || 0}</span>
                      </span>
                    </span>
                    <IconChevronRight size={17} />
                  </button>
                )
              })}
            </div>
          )}
        </Panel>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-1"
        style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
      >
        <span className="flex items-center gap-1.5">
          <IconHash size={13} /> 学号为主键
        </span>
        <span className="flex items-center gap-1.5">
          <IconScan size={13} /> 序列自检
        </span>
        <span className="flex items-center gap-1.5">
          <IconZap size={13} /> 离线可录入
        </span>
        <span className="flex items-center gap-1.5">
          <IconInfo size={13} /> 教室端已就绪
        </span>
      </div>

      {/* 新建班级 */}
      <Sheet
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="新建班级"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setNewOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!form.name.trim()}
              onClick={() => {
                const id = addClass(form)
                setNewOpen(false)
                setForm({ name: '', grade: '高二', year: '2025-2026' })
                push({ text: `已创建 ${form.name}`, tone: 'ok', desc: '接下来录入学生名单' })
                navigate(`/classes/${id}`)
              }}
            >
              创建并录名单
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="label">班级名称</span>
            <input
              className="input"
              placeholder="例如 高二(5)班"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">年级</span>
              <select
                className="input"
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
              >
                {['高一', '高二', '高三'].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">学年</span>
              <input
                className="input"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
              />
            </label>
          </div>
        </div>
      </Sheet>
    </Page>
  )
}
