import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconBell, IconCheck, IconPlus, IconTrash } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { canPublishNotice } from '../lib/roles'
import { noticeScopeText } from '../lib/notices'
import { friendlyDate } from '../lib/date'
import type { Notice } from '../data/types'

/**
 * 通知页 `/notices` —— 老师的**收件箱**（`管理架构与角色权限方案.md` §九.7）。
 *
 * 🔴 三条纪律，改这个页面之前先读：
 *
 *  ① **看得到什么是数据库决定的**。`notices` 是 RLS 筛过的结果（`notices_visible` 策略，
 *     schema.sql §21.7）—— 这个页面**不筛、不判断、不按身份过滤任何一行**（M3 / §11.3）。
 *     教室端**根本到不了这里**（`App.tsx` 的 `accountKind` 一支），
 *     而数据库那一边也一条都不给它（I47）——两处是**同一条边界**，不是两道。
 *
 *  ② **不做"已读回执"**（I49）。这一页进来自动做的那一件事，是把我自己的
 *     `teachers.notice_seen_at` 推到最新 —— **一行一个老师、一个时间戳**，
 *     它回答"我有没有新通知"，**不回答"谁看过这一条"**。
 *     所以这里**没有**"逐条标记已读"、没有"标为未读"、没有已读名单。
 *
 *  ③ **通知不是待办**。所以红点**不显示条数**（那个数字会让人以为"有 3 件事要做"），
 *     只显示"有新通知"这一点；列表也不按"未读/已读"分成两个待办区。
 */
export default function Notices() {
  const notices = useStore((s) => s.notices)
  const noticesState = useStore((s) => s.noticesState)
  const myRoles = useStore((s) => s.myRoles)
  const markNoticesSeen = useStore((s) => s.markNoticesSeen)
  const revokeNotice = useStore((s) => s.revokeNotice)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const [busy, setBusy] = useState<string | null>(null)

  /** 这一页进来就把"我看到哪儿了"推到最新。只跑一次（markNoticesSeen 会改 state）。 */
  const marked = useRef(false)
  useEffect(() => {
    if (marked.current) return
    marked.current = true
    void markNoticesSeen()
  }, [markNoticesSeen])

  /** 能发通知才摆「发通知」那个按钮（§四.2 第 19 行；服务端仍会 403 兜底） */
  const mayPublish = canPublishNotice(myRoles)

  /**
   * 排序：**置顶 → 时间倒序**。
   * ⚠️ **撤下的那些不在这里筛掉** —— 自己发的那条撤下之后仍然看得见（I25 的同一条纪律），
   *    它带着"已撤下"的标记，让人知道"这条我发过、而且我撤了"。
   */
  const rows = useMemo(
    () =>
      [...notices].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt),
    [notices],
  )
  const unread = rows.filter((n) => n.unread && !n.revokedAt && !n.expired).length

  return (
    <>
      <PageHead
        title="通知"
        right={
          mayPublish ? (
            <Button size="sm" variant="primary" icon={<IconPlus size={16} />} onClick={() => navigate('/notices/new')}>
              发通知
            </Button>
          ) : undefined
        }
      />

      <Page>
        {noticesState === 'missing' ? (
          <Panel className="anim-in mb-4" bodyClass="p-4">
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <b>数据库里还没有通知表。</b>
              <div className="mt-1" style={{ color: 'var(--color-ink2)' }}>
                请管理员启用通知功能，回来刷新这一页就有了。
              </div>
            </div>
          </Panel>
        ) : null}

        {rows.length === 0 && noticesState !== 'missing' ? (
          <Panel>
            <Empty
              icon={<IconBell size={24} />}
              title="还没有通知"
              action={
                mayPublish ? (
                  <Button size="sm" variant="primary" onClick={() => navigate('/notices/new')}>
                    发一条通知
                  </Button>
                ) : undefined
              }
            />
          </Panel>
        ) : null}

        {rows.length > 0 ? (
          <>
            <Panel className="anim-in mb-4 overflow-hidden">
              <StatStrip
                items={[
                  { k: '通知', v: rows.length },
                  {
                    k: '有新通知',
                    v: unread ? '有' : '没有',
                    tone: unread ? 'var(--color-accent)' : 'var(--color-ok)',
                  },
                  { k: '我发的', v: rows.filter((n) => n.mine).length },
                ]}
              />
            </Panel>

            <Sect>收件箱</Sect>
            <div className="flex flex-col gap-2.5 stagger">
              {rows.map((n) => (
                <NoticeCard
                  key={n.id}
                  notice={n}
                  busy={busy === n.id}
                  onRevoke={async () => {
                    setBusy(n.id)
                    const res = await revokeNotice(n.id)
                    setBusy(null)
                    push(
                      res.ok
                        ? { text: '已撤下', tone: 'ok' }
                        : { text: res.message, tone: 'bad' },
                    )
                  }}
                />
              ))}
            </div>
          </>
        ) : null}
      </Page>
    </>
  )
}

/** 一条通知。⚠️ 它**没有**"已读/未读"的按钮 —— 未读只是"新"这一个视觉标记（I49） */
function NoticeCard({
  notice,
  busy,
  onRevoke,
}: {
  notice: Notice
  busy: boolean
  onRevoke: () => void
}) {
  const revoked = notice.revokedAt !== null
  const dead = revoked || notice.expired
  return (
    <Panel className="anim-in" bodyClass="p-3.5">
      <div className="flex items-start gap-2.5">
        <span
          className="grid shrink-0 place-items-center"
          style={{
            width: 34,
            height: 34,
            border: '1px solid var(--color-line2)',
            borderRadius: 4,
            background: 'var(--color-surface2)',
            color: notice.unread && !dead ? 'var(--color-accent)' : 'var(--color-ink3)',
          }}
        >
          <IconBell size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {notice.pinned ? <Tag tone="accent">置顶</Tag> : null}
            {notice.unread && !dead ? <Tag tone="warn">新</Tag> : null}
            {notice.mine ? <Tag tone="idle">我发的</Tag> : null}
            {revoked ? <Tag tone="bad">已撤下</Tag> : null}
            {!revoked && notice.expired ? <Tag tone="idle">已过期</Tag> : null}
          </div>
          <div style={{ fontSize: 15, fontWeight: 640, marginTop: 5, lineHeight: 1.45 }}>
            {notice.title}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--color-ink2)',
              marginTop: 4,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
            }}
          >
            {notice.body}
          </div>
          <div
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
          >
            <span>{noticeScopeText(notice)}</span>
            <span>{friendlyDate(new Date(notice.createdAt).toISOString().slice(0, 10))}</span>
            <span className="num">
              {new Date(notice.createdAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {notice.expiresAt ? (
              <span>有效期至 {new Date(notice.expiresAt).toLocaleDateString('zh-CN')}</span>
            ) : null}
          </div>
          {notice.mine && !revoked ? (
            <div className="mt-2">
              <Button size="sm" variant="ghost" icon={<IconTrash size={15} />} disabled={busy} onClick={onRevoke}>
                撤下
              </Button>
            </div>
          ) : null}
          {revoked ? (
            <div className="mt-1" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
              <IconCheck size={13} /> 已撤下
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}
