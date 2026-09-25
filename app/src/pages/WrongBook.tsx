import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconTarget,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Tag } from '../components/ui'
import { activeStudents, useStore } from '../data/store'
import { buildWrongBook, rankedCountOf } from '../lib/wrongbook'

/**
 * 错题集 · 第 1 层：我任教的班级。
 *
 * 这一层只回答一个问题：**该看哪个班**。所以每行必须让教师一眼看出
 * 「这个班有没有可看的错题、错得多不多」，而不是只摆一个班名。
 *
 * ⚠️ **不要在前端按 `class_subjects` 再筛一遍班级。**
 * store 里的 `classes` 已经是**数据库 RLS 筛过**的结果 —— 学科老师登录后
 * 拿到的就是自己任教（或当班主任/年级主任管）的班。前端再筛一套判据，
 * 等于同一件事有两个判定入口，两边一旦不一致就会打架（见 §十 的教训）。
 */
export default function WrongBook() {
  const navigate = useNavigate()
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)

  /**
   * 每个班两件事：有几份「能进错题集」的作业、全班一共错了几处。
   * 第二个数只能把学生逐个算一遍才有 —— 成本在可接受范围内（一个老师几个班）。
   */
  const stats = useMemo(
    () =>
      new Map(
        classes.map((c) => {
          const books = activeStudents(c).map((s) => buildWrongBook(s, c, assignments))
          return [
            c.id,
            {
              students: books.length,
              graded: rankedCountOf(c.id, assignments),
              wrong: books.reduce((n, b) => n + b.totalWrong, 0),
              lost: books.reduce((n, b) => n + b.totalLost, 0),
            },
          ] as const
        }),
      ),
    [classes, assignments],
  )

  const totalStudents = classes.reduce((n, c) => n + activeStudents(c).length, 0)

  return (
    <>
      <PageHead
        title="错题集"
        sub={
          classes.length
            ? `${classes.length} 个班 · ${totalStudents} 名学生`
            : undefined
        }
        onBack={() => navigate('/')}
      />

      <Page>
        {classes.length === 0 ? (
          <Panel className="overflow-hidden">
            <div className="empty">
              <IconUsers size={26} />
              <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>名下还没有班级</div>
              <div style={{ fontSize: 13, maxWidth: 280 }}>
                先建一个班，批过作业后这里就有数据。
              </div>
              <Button
                variant="primary"
                size="sm"
                icon={<IconUsers size={15} />}
                onClick={() => navigate('/classes')}
              >
                去建班级
              </Button>
            </div>
          </Panel>
        ) : (
          <div className="mb-4">
            <Sect>我任教的班级</Sect>
            <div className="flex flex-col gap-2.5 stagger">
              {classes.map((c) => {
                const st = stats.get(c.id)
                const graded = st?.graded ?? 0
                const wrong = st?.wrong ?? 0
                return (
                  <Panel key={c.id} className="overflow-hidden">
                    <button
                      type="button"
                      className="row"
                      style={{ padding: 14 }}
                      onClick={() => navigate(`/wrong/${c.id}`)}
                    >
                      <span
                        className="grid shrink-0 place-items-center"
                        style={{
                          width: 40,
                          height: 40,
                          border: '1px solid var(--color-line2)',
                          borderRadius: 4,
                          background: 'var(--color-surface2)',
                          color: 'var(--color-ink2)',
                        }}
                      >
                        <IconUsers size={19} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span style={{ fontSize: 15.5, fontWeight: 650 }}>{c.name}</span>
                          {graded > 0 && wrong > 0 ? <Tag tone="bad">有错题</Tag> : null}
                        </span>
                        <span
                          className="mt-0.5 block"
                          style={{ fontSize: 12, color: 'var(--color-ink3)' }}
                        >
                          {c.grade} · <span className="num">{st?.students ?? 0}</span> 人
                        </span>
                        <span
                          className="mt-1.5 flex items-center gap-2 whitespace-nowrap"
                          style={{
                            fontSize: 12.5,
                            color: graded === 0 ? 'var(--color-ink4)' : 'var(--color-ink2)',
                            lineHeight: 1.5,
                          }}
                        >
                          {graded === 0 ? (
                            <>
                              <IconClipboard size={14} className="shrink-0" />
                              还没批改过作业
                            </>
                          ) : wrong === 0 ? (
                            <>
                              <IconCheck size={14} className="shrink-0" />
                              批过 <span className="num">{graded}</span> 份 · 没有人错题
                            </>
                          ) : (
                            <>
                              <IconTarget size={14} className="shrink-0" />
                              错 <span className="num">{wrong}</span> 处 · 全班丢{' '}
                              <span className="num">{st?.lost.toFixed(1)}</span> 分 · 批过{' '}
                              <span className="num">{graded}</span> 份
                            </>
                          )}
                        </span>
                      </span>
                      <IconChevronRight size={16} />
                    </button>
                  </Panel>
                )
              })}
            </div>
          </div>
        )}
      </Page>
    </>
  )
}
