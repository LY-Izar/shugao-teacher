import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconBell,
  IconCheck,
  IconClock,
  IconPlus,
  IconTrash,
  IconUsers,
} from '../components/icons'
import { ScheduleBatch } from '../components/ScheduleBatch'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { loadClassMembers, loadClassSubjects } from '../data/remote'
import { WEEKDAY_TEXT, type ScheduleItem, type ScheduleKind } from '../data/types'
import { goBackOr } from '../lib/back'
import { notifyPermission, requestNotify } from '../lib/notify'
import {
  REMIND_BEFORE,
  checkScheduleConflicts,
  dayState,
  durationText,
  itemsOfDay,
  normalizeTime,
  nowMinutes,
  toMinutes,
  weekdayOf,
} from '../lib/schedule'

const BLANK: Omit<ScheduleItem, 'id'> = {
  weekday: 1,
  start: '08:00',
  end: '08:45',
  title: '',
  classId: undefined,
  room: '',
  kind: 'class',
  notify: true,
}

export default function Schedule() {
  const schedule = useStore((s) => s.schedule)
  const classes = useStore((s) => s.classes)
  const addSchedule = useStore((s) => s.addSchedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const updateSchedule = useStore((s) => s.updateSchedule)
  const removeSchedule = useStore((s) => s.removeSchedule)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const [editing, setEditing] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [form, setForm] = useState<Omit<ScheduleItem, 'id'>>(BLANK)
  const [perm, setPerm] = useState(() => notifyPermission())

  const today = weekdayOf()
  /**
   * 这里只管**教师自己的排课表**。
   * 班级课表（scope='class'，教室端给学生看的那份）由教室端单独维护 ——
   * 之前周视图直接用了未过滤的 schedule，教室端一录课表就串到这儿来。
   */
  const mine = useMemo(() => schedule.filter((s) => s.scope !== 'class'), [schedule])
  const state = useMemo(() => dayState(mine), [mine])

  const startNew = (weekday = today) => {
    setEditing(null)
    setForm({ ...BLANK, weekday })
    setOpen(true)
  }

  const startEdit = (item: ScheduleItem) => {
    setEditing(item.id)
    const { id: _id, ...rest } = item
    void _id
    setForm(rest)
    setOpen(true)
  }

  const save = async () => {
    const payload: Omit<ScheduleItem, 'id'> = {
      ...form,
      title: form.title.trim(),
      start: normalizeTime(form.start, '08:00'),
      end: normalizeTime(form.end, '08:45'),
      room: form.room?.trim() || undefined,
    }
    if (!payload.title) return
    if (toMinutes(payload.end) <= toMinutes(payload.start)) {
      push({ text: '结束时间要晚于开始时间', tone: 'bad' })
      return
    }
    /* 🔴 走班冲突：**拦住**（Q13 = A）。改动的那一行要从"已有"里排掉，否则自己撞自己 */
    const others = editing ? schedule.filter((s) => s.id !== editing) : schedule
    const gate = await checkScheduleConflicts(
      { items: [{ ...payload, id: editing ?? 'pending' }], schedule: others, classes },
      { loadMembers: loadClassMembers, loadSubjects: loadClassSubjects },
    )
    if (gate.blocked) {
      push({ text: '这张课表和走班班撞了，没有保存', tone: 'bad', desc: gate.message })
      return
    }
    if (editing) {
      updateSchedule(editing, payload)
      push({ text: '已保存', tone: 'ok' })
    } else {
      addSchedule(payload)
      push({ text: '已加入课表', tone: 'ok' })
    }
    setOpen(false)
  }

  const className = (id?: string) => classes.find((c) => c.id === id)?.name

  return (
    <>
      <PageHead
        /*
         * 🔴 这一页叫「日程表」，不叫「课表」（2026-09-27 用户拍板）。
         *
         * 因为平台里现在有**两套**课表数据，都叫"课表"就分不清谁是谁：
         *   · `scope='mine'` —— 教师自己的排课表（就是这一页），只影响"我什么时候上哪个班"；
         *   · `scope='class'` —— 班级课表，贴在教室里给学生看的那份，教师端只读。
         * 只改了**显示名**：`scope` 的取值一个字都没动
         * （`schedule_items.scope` 的 check 只有 `'mine'` / `'class'`）。
         */
        title="日程表"
        sub={`每周 ${mine.length} 项 · 今天 ${state.items.length} 项`}
        /*
         * 🔴 「返回」不写死路径：这一页**既是左栏/底部的顶层 tab，又从「我的」那一行进来**，
         *    写死 `/settings` 会让"从 tab 进来"的那一半回错页。
         *    形状与理由见 `lib/back.ts`（有上一页回上一页；书签/PWA 直开时回 `/`）。
         */
        onBack={() => goBackOr(navigate, '/')}
        right={
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={15} />}
            onClick={() => setBatchOpen(true)}
          >
            添加
          </Button>
        }
      />

      <Page>
        {/* 提醒权限 */}
        {perm !== 'granted' ? (
          <div
            className="anim-in mb-3 flex flex-wrap items-center gap-3 p-3.5"
            style={{
              background: perm === 'unsupported' ? 'var(--color-warnsoft)' : 'var(--color-accentsoft)',
              border: `1px solid ${perm === 'unsupported' ? 'var(--color-warnline)' : 'var(--color-infoline)'}`,
              borderRadius: 6,
            }}
          >
            <span style={{ color: perm === 'unsupported' ? 'var(--color-warn)' : 'var(--color-accent)' }}>
              {perm === 'unsupported' ? <IconAlert size={17} /> : <IconBell size={17} />}
            </span>
            <div className="flex-1" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <div
                style={{
                  fontWeight: 620,
                  color: perm === 'unsupported' ? 'var(--color-warnink)' : 'var(--color-accentink)',
                }}
              >
                {perm === 'unsupported'
                  ? '这个浏览器不支持系统通知'
                  : perm === 'denied'
                    ? '系统通知被拒绝了'
                    : `开启通知，上课前 ${REMIND_BEFORE} 分钟提醒你`}
              </div>
              <div style={{ color: perm === 'unsupported' ? 'var(--color-warnink2)' : 'var(--color-ink2)', marginTop: 2 }}>
                {perm === 'unsupported'
                  ? '会改用页内提醒（需要平台开着）。把网站装到手机桌面后再授权，通常就能收到。'
                  : perm === 'denied'
                    ? '请到浏览器设置里允许本网站通知，或改用页内提醒。'
                    : '只在这台设备上提醒，内容不会外发。'}
              </div>
            </div>
            {perm === 'default' ? (
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const r = await requestNotify()
                  setPerm(r)
                  push({
                    text: r === 'granted' ? '通知已开启' : '未授权，将用页内提醒',
                    tone: r === 'granted' ? 'ok' : 'warn',
                  })
                }}
              >
                开启通知
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            className="anim-in mb-3 flex items-center gap-2.5 p-3"
            style={{ background: 'var(--color-oksoft)', border: '1px solid var(--color-okline)', borderRadius: 6 }}
          >
            <span style={{ color: 'var(--color-ok)' }}>
              <IconCheck size={16} />
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--color-okink)' }}>
              通知已开启 · 上课前 {REMIND_BEFORE} 分钟提醒
            </span>
          </div>
        )}

        {/* 今天 */}
        <div className="mb-4">
          <Sect>今天 · {WEEKDAY_TEXT[today - 1]}</Sect>
          <Panel className="overflow-hidden">
            {state.items.length === 0 ? (
              <div className="flex flex-wrap items-center gap-3 p-3.5">
                <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                  今天没有排课
                </span>
              </div>
            ) : (
              <div>
                {state.items.map((it) => {
                  const m = nowMinutes()
                  const isNow = m >= toMinutes(it.start) && m < toMinutes(it.end)
                  const isPast = toMinutes(it.end) <= m
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className="row"
                      style={{ padding: '11px 13px', opacity: isPast ? 0.55 : 1 }}
                      onClick={() => startEdit(it)}
                    >
                      <span
                        className="num shrink-0"
                        style={{
                          width: 46,
                          fontSize: 13,
                          fontWeight: 700,
                          color: isNow ? 'var(--color-accent)' : 'var(--color-ink2)',
                        }}
                      >
                        {it.start}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span style={{ fontSize: 14, fontWeight: 620 }}>{it.title}</span>
                          {isNow ? <Tag tone="accent">进行中</Tag> : null}
                          {isPast ? <Tag tone="idle">已结束</Tag> : null}
                        </span>
                        <span
                          className="mt-0.5 flex flex-wrap items-center gap-x-3"
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                        >
                          <span>
                            {it.start}–{it.end}
                          </span>
                          {className(it.classId) ? <span>{className(it.classId)}</span> : null}
                          {it.room ? <span>{it.room}</span> : null}
                          {it.notify ? <span>提前 {REMIND_BEFORE} 分钟提醒</span> : null}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Panel>
        </div>

        {/* 整周 */}
        <div className="mb-4">
          <Sect>整周日程</Sect>
          <div className="flex flex-col gap-2.5">
            {[1, 2, 3, 4, 5, 6, 7].map((wd) => {
              const items = itemsOfDay(mine, wd)
              const isToday = wd === today
              return (
                <Panel key={wd} className="overflow-hidden">
                  <div
                    className="flex items-center gap-2 px-3 py-2"
                    style={{
                      borderBottom: items.length ? '1px solid var(--color-line)' : undefined,
                      background: isToday ? 'var(--color-accentsoft)' : 'var(--color-surface2)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 650,
                        color: isToday ? 'var(--color-accentink)' : 'var(--color-ink2)',
                      }}
                    >
                      {WEEKDAY_TEXT[wd - 1]}
                    </span>
                    {isToday ? <Tag tone="accent">今天</Tag> : null}
                    <span className="flex-1" />
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      {items.length} 项
                    </span>
                    <button
                      type="button"
                      onClick={() => startNew(wd)}
                      aria-label={`给${WEEKDAY_TEXT[wd - 1]}添加`}
                      style={{ color: 'var(--color-ink3)', display: 'grid', placeItems: 'center' }}
                    >
                      <IconPlus size={15} />
                    </button>
                  </div>
                  {items.length === 0 ? (
                    <div className="px-3 py-2.5" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                      没有安排
                    </div>
                  ) : (
                    <div>
                      {items.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          className="row"
                          style={{ padding: '9px 13px' }}
                          onClick={() => startEdit(it)}
                        >
                          <span
                            className="num shrink-0"
                            style={{ width: 44, fontSize: 12.5, fontWeight: 650 }}
                          >
                            {it.start}
                          </span>
                          <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
                            {it.title}
                          </span>
                          {it.room ? (
                            <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>{it.room}</span>
                          ) : null}
                          <span className="num" style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
                            {durationText(it.start, it.end)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </Panel>
              )
            })}
          </div>
        </div>

        <div
          className="flex items-start gap-2 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
        >
          <IconClock size={13} />
          <span>日程只存在你的账号里。</span>
        </div>
      </Page>

      {/* 批量录入 —— 手工多条 / 粘贴文字 / 上传课表文件，都汇到同一张清单 */}
      <ScheduleBatch
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        classes={classes}
        today={today}
        onSave={async (items) => {
          /* 🔴 批量粘贴这一路的走班冲突校验（与单条、教室端**同一个** `checkScheduleConflicts`） */
          const gate = await checkScheduleConflicts(
            { items: items.map((x, i) => ({ ...x, id: `pending-${i}` })), schedule, classes },
            { loadMembers: loadClassMembers, loadSubjects: loadClassSubjects },
          )
          if (gate.blocked) {
            push({ text: '这批课表和走班班撞了，没有保存', tone: 'bad', desc: gate.message })
            return false
          }
          const n = addScheduleMany(items)
          setBatchOpen(false)
          push({ text: `已加入 ${n} 条日程`, tone: 'ok' })
          return true
        }}
      />

      {/* 新增 / 编辑单条 */}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑日程' : '添加日程'}
        footer={
          <div className="flex gap-2">
            {editing ? (
              <Button
                variant="danger"
                icon={<IconTrash size={15} />}
                onClick={() => {
                  removeSchedule(editing)
                  setOpen(false)
                  push({ text: '已删除', tone: 'warn' })
                }}
              >
                删除
              </Button>
            ) : null}
            <Button block variant="primary" disabled={!form.title.trim()} onClick={save}>
              {editing ? '保存' : '添加'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="label">标题</span>
            <input
              className="input"
              placeholder="例如 高二(3)班 语文"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              autoFocus
            />
          </label>

          <div>
            <span className="label">星期</span>
            <div className="seg flex-wrap">
              {WEEKDAY_TEXT.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  data-on={form.weekday === i + 1}
                  onClick={() => setForm({ ...form, weekday: i + 1 })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">开始</span>
              <input
                className="input num"
                type="time"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </label>
            <label>
              <span className="label">结束</span>
              <input
                className="input num"
                type="time"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">班级（可选）</span>
              <select
                className="input"
                value={form.classId ?? ''}
                onChange={(e) => setForm({ ...form, classId: e.target.value || undefined })}
              >
                <option value="">不指定</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">地点（可选）</span>
              <input
                className="input"
                placeholder="如 实验楼 302"
                value={form.room ?? ''}
                onChange={(e) => setForm({ ...form, room: e.target.value })}
              />
            </label>
          </div>

          <div>
            <span className="label">类型</span>
            <div className="seg">
              {(
                [
                  ['class', '上课'],
                  ['other', '其他安排'],
                ] as Array<[ScheduleKind, string]>
              ).map(([k, t]) => (
                <button
                  key={k}
                  type="button"
                  data-on={form.kind === k}
                  onClick={() => setForm({ ...form, kind: k })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2.5" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.notify}
              onChange={(e) => setForm({ ...form, notify: e.target.checked })}
              style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
            />
            <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
              上课前 {REMIND_BEFORE} 分钟提醒我
            </span>
          </label>

          <div
            className="flex items-center gap-2 p-2.5"
            style={{
              background: 'var(--color-surface2)',
              borderRadius: 4,
              fontSize: 11.5,
              color: 'var(--color-ink3)',
            }}
          >
            <IconUsers size={13} />
            <span>
              示例：{WEEKDAY_TEXT[form.weekday - 1]} {form.start}–{form.end} ·{' '}
              {form.title.trim() || '（未填标题）'}
              {form.room ? ` · ${form.room}` : ''}
            </span>
          </div>
        </div>
      </Sheet>
    </>
  )
}
