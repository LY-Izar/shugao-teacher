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
import { goBackOr } from '../lib/back'
import { splitByKind } from '../lib/pick'
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
 *
 * 🔴 **但 `kind` 不是权限、必须自己判**（P5 的统一模型）：走班班也是 `classes` 的一行，
 *    而这一页的每一行都按"这个班的学生名单 + 这个班的档案"算 —— 走班班的人来自
 *    `class_members`（多对多，`students.class_id` 指向的是它的行政班），
 *    直接列出来会让那一行永远显示"还没有批改过作业"（**静默错**，不报错）。
 *    所以这一页只列**行政班**，走班班另有说明（`streamClassSummary`）。
 */
export default function WrongBook() {
  const navigate = useNavigate()
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)

  /** 按 kind 分两半 —— 判定入口只有 `lib/pick.ts` 那一份 */
  const { admin: adminClasses, stream: streamClasses } = useMemo(() => splitByKind(classes), [classes])

  /**
   * 每个班两件事：有几份「能进错题集」的作业、全班一共错了几处。
   * 第二个数只能把学生逐个算一遍才有 —— 成本在可接受范围内（一个老师几个班）。
   */
  const stats = useMemo(
    () =>
      new Map(
        adminClasses.map((c) => {
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
    [adminClasses, assignments],
  )

  const totalStudents = adminClasses.reduce((n, c) => n + activeStudents(c).length, 0)

  return (
    <>
      <PageHead
        title="错题集"
        sub={
          adminClasses.length
            ? `${adminClasses.length} 个班 · ${totalStudents} 名学生`
            : undefined
        }
        /*
         * 🔴 「返回」不写死路径：`/wrong` 是左栏/底部的顶层 tab（写死 `/` 会把
         *    从任意一页点进来的人扔回首页）。有上一页回上一页；书签/PWA 直开时回 `/`。
         *    形状与理由见 `lib/back.ts`。
         */
        onBack={() => goBackOr(navigate, '/')}
      />

      <Page>
        {adminClasses.length === 0 ? (
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
              {adminClasses.map((c) => {
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

            {/*
              走班班**不在上面的列表里**（P5 的统一模型）：它的人来自 `class_members`
              （多对多），按"这个班的学生名单"算错题集就会永远算成空的。
              这里只说明"有这几个"，不摆入口 —— 走班班的错题集是另一期的活。
              ⚠️ 只在真有走班班时才渲染：没有走班班的库上这一整块不存在，
                 所以"改造前后逐行相等"这条验收口径在这里也是逐字成立的。
            */}
            {streamClasses.length ? (
              <div className="mt-4">
                <Sect>走班班</Sect>
                <Panel bodyClass="p-3">
                  <div className="flex flex-wrap gap-2" style={{ fontSize: 12.5 }}>
                    {streamClasses.map((k) => (
                      <Tag key={k.id} tone="idle">
                        {k.name}
                      </Tag>
                    ))}
                  </div>
                  <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                    走班班的名单来自成员关系（一个学生可以在多个走班班），错题集按成员算。
                  </p>
                </Panel>
              </div>
            ) : null}
          </div>
        )}
      </Page>
    </>
  )
}
