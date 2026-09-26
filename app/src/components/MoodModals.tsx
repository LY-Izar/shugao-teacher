import { Modal, Button, Panel, Tag } from './ui'
import {
  IconCalendar,
  IconCheck,
  IconClipboard,
  IconMoon,
  IconSpark,
  IconSun,
} from './icons'
import type { Assignment, Klass, ScheduleItem } from '../data/types'

/* ============================================================
   情绪价值的两个时刻
   · 早上第一次打开：一句祝福 + 今天要批的作业 + 今天的日程
   · 当天工作全部结束：一句收尾
   刻意克制 —— 不撒花、不打分、不做连续签到排行榜。
   ============================================================ */

export function MorningWelcome({
  open,
  onClose,
  teacherName,
  greeting,
  countdown,
  pending,
  classes,
  today,
  weekdayText,
}: {
  open: boolean
  onClose: () => void
  teacherName: string
  greeting: string
  /** 最近的假期倒计时；没有就不显示 */
  countdown: string | null
  pending: Assignment[]
  classes: Klass[]
  today: ScheduleItem[]
  weekdayText: string
}) {
  const className = (id?: string) => classes.find((c) => c.id === id)?.name

  return (
    <Modal open={open} onClose={onClose} labelledBy="welcome-title">
      {/* 顶部：一句祝福 */}
      <div
        style={{
          padding: '22px 20px 18px',
          background:
            'linear-gradient(160deg, var(--color-accentsoft) 0%, rgb(var(--color-glasshi) / 0) 78%)',
          borderBottom: '1px solid var(--color-line)',
        }}
      >
        <span
          className="grid place-items-center"
          style={{
            width: 38,
            height: 38,
            borderRadius: 99,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-line2)',
            color: 'var(--color-warn)',
          }}
        >
          <IconSun size={20} />
        </span>
        <div
          id="welcome-title"
          style={{ fontSize: 20, fontWeight: 680, letterSpacing: '-.01em', marginTop: 12 }}
        >
          早上好，{teacherName}
        </div>
        <div
          className="flex items-start gap-2"
          style={{ marginTop: 10, fontSize: 14, color: 'var(--color-accentink)', lineHeight: 1.7 }}
        >
          <span style={{ marginTop: 2, flexShrink: 0 }}>
            <IconSpark size={15} />
          </span>
          <span>{greeting}</span>
        </div>
        {countdown ? (
          <div
            className="mt-2 flex items-center gap-2 px-2.5 py-1.5"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-line2)',
              borderRadius: 4,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--color-warn)',
            }}
          >
            <IconCalendar size={14} />
            <span>{countdown}</span>
          </div>
        ) : null}
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* 今天要批的作业 */}
        <div>
          <div
            className="mb-1.5 flex items-center gap-2"
            style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}
          >
            <IconClipboard size={13} />
            今天要批的作业
            <span className="flex-1" />
            <span className="num">{pending.length}</span>
          </div>
          <Panel bodyClass="p-0" className="overflow-hidden">
            {pending.length === 0 ? (
              <div className="px-3 py-2.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                没有待批改的作业，今天的负担轻一点。
              </div>
            ) : (
              pending.slice(0, 4).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ borderBottom: '1px solid var(--color-line)' }}
                >
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                    {a.title}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    {className(a.classId)}
                  </span>
                  {/*
                    极简模式（`statsMode='simple'`）**不显示题数** —— 它没有"题"这个概念
                    （只记 优/良/差），而 `questionCount` 在建档时仍被写成 6：写出来会让老师
                    以为点进去有 6 道题的逐题数据。这一行已经有标题 + 班名，整块不渲染即可。
                    ⛔ 普通模式那份照旧显示题数（见 `功能设计与不变量.md` §四 4.1）。
                  */}
                  {a.statsMode === 'simple' ? null : (
                    <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                      {a.questionCount} 题
                    </span>
                  )}
                </div>
              ))
            )}
          </Panel>
        </div>

        {/* 今天的日程 */}
        <div>
          <div
            className="mb-1.5 flex items-center gap-2"
            style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}
          >
            <IconSun size={13} />
            今天的日程 · {weekdayText}
            <span className="flex-1" />
            <span className="num">{today.length}</span>
          </div>
          <Panel bodyClass="p-0" className="overflow-hidden">
            {today.length === 0 ? (
              <div className="px-3 py-2.5" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                今天没排课。要记录的话去「我的 → 日程表」。
              </div>
            ) : (
              today.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center gap-3 px-3 py-2"
                  style={{ borderBottom: '1px solid var(--color-line)' }}
                >
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700, width: 44 }}>
                    {it.start}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                    {it.title}
                  </span>
                  {it.room ? (
                    <Tag tone="idle">{it.room}</Tag>
                  ) : null}
                </div>
              ))
            )}
          </Panel>
        </div>

        <Button block variant="primary" onClick={onClose}>
          开始今天
        </Button>
      </div>
    </Modal>
  )
}

export function DoneCelebration({
  open,
  onClose,
  countdown,
}: {
  open: boolean
  onClose: () => void
  /** 假期就在眼前时，收尾换成倒计时 */
  countdown: string | null
}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="done-title">
      <div className="flex flex-col items-center px-5 pt-7 pb-6 text-center">
        <svg
          className="draw-check"
          width="58"
          height="58"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-ok)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10.4" />
          <path d="m7.6 12.4 3.1 3.1 6-6.6" />
        </svg>
        <div id="done-title" style={{ fontSize: 18, fontWeight: 680, marginTop: 14, lineHeight: 1.6 }}>
          今天的工作已经全部完成，
          <br />
          好好休息一下吧。
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
          {countdown ? (
            <span style={{ color: 'var(--color-warn)', fontWeight: 600 }}>{countdown}</span>
          ) : (
            '剩下的时间属于你自己。'
          )}
          <br />
          这条提醒会在工作台一直留到 23:00。
        </div>
        <div
          className="mt-4 flex items-center gap-2"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <IconMoon size={13} />
          <span>别忘了，明天还有课。</span>
        </div>
        <Button block variant="primary" className="mt-5" onClick={onClose}>
          好的
        </Button>
      </div>
    </Modal>
  )
}

/* 工作台首栏的氛围条 */
export function MoodBanner({
  title,
  sub,
  tone = 'default',
}: {
  title: string
  sub: string
  /** festive 用于法定假期，暖色 */
  tone?: 'default' | 'festive'
}) {
  const festive = tone === 'festive'
  return (
    <div
      className="anim-in mb-4 flex items-start gap-3 p-3.5"
      style={{
        background: festive
          ? 'linear-gradient(140deg, var(--color-warnsoft), rgb(var(--color-glasshi) / 0))'
          : 'linear-gradient(140deg, var(--color-accentsoft), rgb(var(--color-glasshi) / 0))',
        border: `1px solid ${festive ? 'var(--color-warnline)' : 'var(--color-infoline)'}`,
        borderRadius: 6,
      }}
    >
      <span
        className="grid place-items-center shrink-0"
        style={{
          width: 30,
          height: 30,
          borderRadius: 99,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-line2)',
          color: festive ? 'var(--color-warn)' : 'var(--color-accent)',
        }}
      >
        {festive ? <IconSpark size={16} /> : <IconCheck size={16} />}
      </span>
      <div className="flex-1">
        <div
          style={{
            fontSize: 14,
            fontWeight: 650,
            color: festive ? 'var(--color-warnink)' : 'var(--color-accentink)',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: festive ? 'var(--color-warnink2)' : 'var(--color-ink2)',
            marginTop: 2,
            lineHeight: 1.6,
          }}
        >
          {sub}
        </div>
      </div>
    </div>
  )
}
