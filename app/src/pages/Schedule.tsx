import { useEffect, useMemo, useState } from 'react'
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
import ScheduleDayAxis from '../components/ScheduleDayAxis'
import SnoozeButton from '../components/SnoozeButton'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { loadClassMembers, loadClassSubjects } from '../data/remote'
import { WEEKDAY_TEXT, type ScheduleItem, type ScheduleKind } from '../data/types'
import { goBackOr } from '../lib/back'
import { notifyPermission, readNotifyPermission, requestNotify } from '../lib/notify'
import { shellPlatform } from '../lib/classroomShell'
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
  /*
 * 🔴 `'native'` 这一档是 2026-10-03 加的（apk 里的 WebView **没有** `Notification`
 *    ⇒ 原来恒显示「这个浏览器不支持系统通知」，而那句建议在 apk 里是错的）。
 *    所以本地的 `perm` 状态类型必须**跟着加一档**，否则 tsc 会报
 *    `types '"default"' and '"native"' have no overlap` —— 那不是"比较多余"，
 *    是"我漏了一档"。⚠️ 别为了让 tsc 过而把 `native` 那两段删掉。
 */
const [perm, setPerm] = useState<
  NotificationPermission | 'unsupported' | 'native'
>(() => notifyPermission())

  /*
   * 🔴🔴 **挂载后把权限读成真值**（2026-10-04 修，用户报"通知还是不对"）
   *
   * 上面那个初值 `notifyPermission()` 是**同步的猜测**：原生那一档它恒回 `'default'`，
   * 因为真值在桥接层那边、只能异步取。
   * ⇒ 旧版**没有这个 useEffect** ⇒ apk 里即使系统通知早就授权了，
   *   横幅也永远是「开启通知 + 一个按钮」，绿的「通知已开启」**永远到不了**。
   *   🔴 和 `97cf3fd`（key 读不到被显示成"未配置"）同一个病根：**答案有，没人去读。**
   *
   * 为什么还要监听 `visibilitychange`：
   *   apk 上点按钮是**跳到系统设置页**去开（`openNotificationSettings()`），
   *   用户在那边改完切回来 —— 这一页**没有重新挂载**，不重读的话横幅照旧挂着。
   *   ⚠️ 这一步不加的话，"去设置里开"这个动作**在界面上永远看不见效果**。
   *
   * 三态：读不出来就停在初值（`'default'`）—— 灰，不谎称已授权。
   */
  useEffect(() => {
    let alive = true
    const sync = () => {
      void readNotifyPermission().then((p) => {
        if (alive) setPerm(p)
      })
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
    }
  }, [])

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
            {/* ⚠️ 上面那段 `background` / `border` / `icon` 三处都按 `unsupported` 分档，
                与文案是**两处独立的判据** —— 2026-10-03 加 `native` 档时三处都要跟着看，
                别只改文案不改配色（那会出现"图标是告警色、文案却在说正常"）。 */}
            <div className="flex-1" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <div
                style={{
                  fontWeight: 620,
                  color: perm === 'unsupported' ? 'var(--color-warnink)' : 'var(--color-accentink)',
                }}
              >
                {perm === 'unsupported'
                  ? '这个设备收不到系统通知'
                  : perm === 'denied'
                    ? '系统通知被拒绝了'
                    : perm === 'native'
                      ? `开启通知，上课前 ${REMIND_BEFORE} 分钟提醒你`
                      : `开启通知，上课前 ${REMIND_BEFORE} 分钟提醒你`}
              </div>
              <div style={{ color: perm === 'unsupported' ? 'var(--color-warnink2)' : 'var(--color-ink2)', marginTop: 2 }}>
                {perm === 'unsupported'
                  ? /*
                     * 🔴🔴 这句话 2026-10-03 改过（用户在 apk 上截图报出来的）。
                     *   原文案是「**这个浏览器不支持**系统通知」+「把网站装到手机桌面后再授权」——
                     *   而 apk 的 WebView 里**压根没有 Notification**，`notifySupported()` 恒 false
                     *   ⇒ **老师明明已经装成 apk 了**，却还被建议"再装到桌面"。
                     *   那是**照着做也没用的建议**（AGENTS.md：不可写的路径要显式报错，
                     *   不能给一条执行不了的出路）。
                     *   现在只说事实 + 给真正能做的事（页内提醒 / 用网页版）。
                     */
                    '会改用页内提醒（需要平台开着）。要在手机上收到系统通知，请用浏览器打开网站并允许通知。'
                  : perm === 'denied'
                    ? '请到系统或浏览器设置里允许本网站通知，或改用页内提醒。'
                    : perm === 'native'
                      ? '只在这台设备上提醒，内容不会外发。'
                      : '只在这台设备上提醒，内容不会外发。'}
              </div>
            </div>
            {perm === 'default' ? (
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const r = await requestNotify()
                  /*
                   * 🔴 `'native'` 不能当成"未授权"（2026-10-03）：
                   *   `requestNotify()` 在原生那一支返回 'native'，意思是
                   *   **"这要走系统设置，不是网页能弹的框"**。
                   *   原来 `r === 'granted' ? … : '未授权，将用页内提醒'` 会把它
                   *   说成"未授权"—— 而 apk 上真正的入口是**系统通知设置**。
                   *   ⚠️ R9 把 `openNotificationSettings()` 接上后，这里换成真的跳设置。
                   */
                  push(
                    r === 'granted'
                      ? { text: '通知已开启', tone: 'ok' }
                      : r === 'native'
                        ? {
                            text: '要在系统里开通知',
                            tone: 'warn',
                            /*
                             * 🔴🔴 这句话**原来写死"手机的系统设置"**，而教师端 exe 上
                             *   也照原样显示（2026-10-04 扫出来的）—— Windows 上弹出
                             *   「要走**手机的**系统设置」是**错的指示**。
                             *   现在按壳的 `platform` 分端说：
                             *     · apk  → 手机的系统设置
                             *     · exe  → Windows 的系统设置
                             *     · 网页 / 老 apk（没带 platform）→ 这台设备（不点错设备）
                             *
                             * ⚠️ apk 那一支**是真的会跳过去**（`requestNotify()` 里调了
                             *    `openNotificationSettings()`），所以文案说"去打开"是成立的；
                             *    exe 没有那个口，只能告知位置，别写成"已跳转"。
                             */
                            desc: (() => {
                              const p = shellPlatform()
                              const where =
                                p === 'capacitor'
                                  ? '手机的'
                                  : p === 'electron'
                                    ? 'Windows 的'
                                    : '这台设备的'
                              return `这条要走${where}系统设置才能打开，平台会继续用页内提醒。`
                            })(),
                          }
                        : { text: '未授权，将用页内提醒', tone: 'warn' },
                  )
                  /* ⚠️ 原生那一支**不 setPerm**：`'native'` 不是"已授权"，
                     真值要等用户从系统设置切回来时由上面那个 effect 重新读
                     （光靠这里 set 会让横幅在权限其实没开时消失）。 */
                  if (r !== 'native') setPerm(r)
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
              <>
                {/* 真实时间轴：按真实分钟铺位，看得出每节多长、中间空闲多久、哪两节撞了 */}
                <div className="p-3">
                  <ScheduleDayAxis items={state.items} classNameOf={className} onPick={startEdit} />
                </div>
                {/*
                 * 🆕 推迟提醒：每节课一行「晚 10 分 / 晚 20 分」（或已推迟时的「再晚 / 恢复」）。
                 *
                 * ⚠️ 只给**今天剩下的**那几节摆 —— 已经过去的课不需要推迟
                 *    （点"晚 10 分钟"在已过去的课上没有意义，那是一条永远不会被读的记录）。
                 */}
                <div
                  className="flex flex-col gap-1.5 px-3 pb-3"
                  style={{ borderTop: '1px solid var(--color-line)', paddingTop: 10 }}
                >
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    提醒时间 · 只挪提醒，课还是原来的时间
                  </span>
                  {state.items
                    .filter((it) => toMinutes(it.end) > nowMinutes())
                    .map((it) => (
                      <div key={it.id} className="flex items-center gap-2">
                        <span className="num shrink-0" style={{ width: 74, fontSize: 12 }}>
                          {it.start}–{it.end}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 12.5 }}>
                          {it.title}
                        </span>
                        <SnoozeButton itemId={it.id} start={it.start} notify={it.notify} />
                      </div>
                    ))}
                  {state.items.filter((it) => toMinutes(it.end) > nowMinutes()).length === 0 ? (
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                      今天的课都上完了
                    </span>
                  ) : null}
                </div>
              </>
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
