import { useEffect, useMemo, useState } from 'react'
import { IconCheck, IconChevronRight, IconGrid, IconStack } from '../components/icons'
import { Button, Empty, Panel, Sect, Tag } from '../components/ui'
import * as remote from '../data/remote'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT, type Klass, type ScheduleItem } from '../data/types'
import { isAdminClass, splitByKind } from '../lib/pick'
import { checkScheduleConflicts } from '../lib/schedule'
import { matchClassName, parseScheduleText, type ParsedScheduleItem } from '../lib/scheduleParse'

/**
 * 「课程管理」—— **行政管理页（`/manage`）里的第四张卡展开出来的那一段**（2026-10-12，第 2 轮：骨架）。
 *
 * 设计照 `Desktop\课程管理预览\预览-v3.html`（**已经跟用户确认过的那一版**），
 * 只做**第 2 轮**的范围：
 *
 *   ✅ 做：层级（**年级 → 班级 → 该班课表**）· 课表的**两种态**（没录过 = 录入 / 录过了 = 核对）·
 *          待导入那批逐条标"教室里会不会显示"（**三态**）· 权限入口按服务端回的布尔摆 ·
 *          §38 那两张新表不存在时**优雅降级**。
 *   ⛔ 不做（第 3 轮）：调课（临时 / 永久）· 冲突三类 · 不冲突建议 · 确认与通知 · 教室端读取。
 *
 * 🔴 **它为什么不是一条新路由**：新地址要同时登记四处 —— `App.tsx` 的路由 · `lib/pages.ts` 的
 *    `PAGES` · **两份矩阵文档**（`按身份显示导航方案.md` §2.2 与
 *    `管理架构与角色权限方案.md` §4.2 各加一行，13 列矩阵的行数与 V/E/B 自检值跟着动）——
 *    而这一轮的施工单只允许动"页面 + 类型 + 数据读写"。所以这一轮**就地展开**
 *    （与 `Grades.tsx` 的「班级档案」那条是同一种展开写法），路由与矩阵留给下一轮一起落。
 *
 * 🔴 **层级为什么是"年级 → 班级"**：与 `Grades.tsx` 的展开条同一条口径 ——
 *    `classes` 与 `grades` 都是**数据库（RLS）筛过的结果**，前端**一处 `filter(角色)` 都没有**：
 *    年级主任看不见高一/高三，是因为那两行**根本没读回来**，不是因为这里把它们藏了。
 *
 * 🔴 **权限判据一律以数据库为准**：这一页**一个角色字面量都没有、也不读「我的身份」那一份**，
 *    只读服务端回的 `canManageSchedule()` 那一位布尔（`canRevoke` / `canPin` 那套先例）。
 *    藏入口不是安全边界 —— 真正的闸门是 RLS 与 §38.1.1 的触发器。
 */

/** 一个年级条（`grades` 读不到时退回"按班上的年级名分组"） */
type GradeGroup = { key: string; name: string; cohort: string }

/** 课表里一条的落点：**三态，不许混**（与 `Classroom.tsx` 的 `classMark` 同一套判据） */
type Mark = 'ok' | 'red' | 'unknown'

/**
 * 这一条教室端会不会显示。
 *
 * 🔴 判据**只有一处**：`lib/scheduleParse.ts` 的 `matchClassName()` ——
 *    在页面里另写一遍 `title.includes(名)` 迟早在括号 / 空格上分叉，
 *    于是这里说"认得出"、教室里一条都不显示（用户 2026-09-28 实测栽过这个坑）。
 * ⚠️ `classes` 空 = **班级列表根本没读回来** → `unknown`（灰），**绝不能红**：
 *    红只说"确实对不上"，"我没读到"是"没结论"（§三.4 三态 / I 系列不变量）。
 */
function markOf(title: string, klass: Klass, classes: Klass[]): Mark {
  if (!classes.length) return 'unknown'
  if (!title.trim()) return 'unknown'
  return matchClassName(title, classes) === klass.name ? 'ok' : 'red'
}

const MARK_TEXT: Record<Mark, string> = {
  ok: '教室里会显示',
  red: '教室里不会显示',
  unknown: '班级列表没读到，判不了',
}

/** 一条「教室端会不会显示」的标记 —— 三态各自一个 `data-course-mark`（下一轮补断言的锚点） */
function MarkLine({ mark, klass }: { mark: Mark; klass: Klass }) {
  if (mark === 'ok') {
    return (
      <div data-course-mark="ok" style={{ fontSize: 11, color: 'var(--color-okink)', marginTop: 3 }}>
        ✓ {MARK_TEXT.ok}
      </div>
    )
  }
  if (mark === 'red') {
    return (
      <div
        data-course-mark="red"
        style={{ fontSize: 11, color: 'var(--color-bad)', marginTop: 3, lineHeight: 1.6 }}
      >
        ⚠ {MARK_TEXT.red} —— 标题里写上班名「{klass.name}」
      </div>
    )
  }
  return (
    <div data-course-mark="unknown" style={{ fontSize: 11, color: 'var(--color-ink3)', marginTop: 3 }}>
      {MARK_TEXT.unknown}
    </div>
  )
}

export default function CourseAdmin() {
  const grades = useStore((s) => s.grades)
  const classes = useStore((s) => s.classes)
  const schedule = useStore((s) => s.schedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const push = useToast((s) => s.push)

  /** 展开着的那一个年级（`null` = 都收起） */
  const [openGrade, setOpenGrade] = useState<string | null>(null)
  /** 选中的那个班（点班级行才出现右边那块课表） */
  const [classId, setClassId] = useState<string | null>(null)
  /** 服务端回的"能不能改这个班的课表"（**带班 id**：换班时不把上一个班的结论当成这个班的） */
  const [capFor, setCapFor] = useState<{ id: string; state: remote.CanManageScheduleState } | null>(
    null,
  )
  /** 录入模式：粘贴框里的原文 */
  const [paste, setPaste] = useState('')
  /** 录入模式：解析出来、等着核对的那一批（`null` = 还没解析） */
  const [parsed, setParsed] = useState<ParsedScheduleItem[] | null>(null)
  /** 核对模式：「我核对过了」（⚠️ 第 2 轮它是**这一段里的**一个记号，还没有落库的核对记录表） */
  const [reviewed, setReviewed] = useState(false)
  /** 一句话结果 / 拦下来的原因（**不许静默**） */
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  /*
   * 年级清单：以 `grades` 表为准，**读不到时退回"按班上的年级名分组"** ——
   * 与 `Grades.tsx:71` 的 `loadArchive` 同一条既有写法（远程以库里为准，本地用 store 那一份）。
   * ⚠️ 退回那一支不是"另一个判据"：两处读的都是数据库（RLS）给的那一份。
   */
  const groups = useMemo<GradeGroup[]>(() => {
    if (grades.length) return grades.map((g) => ({ key: g.id, name: g.name, cohort: g.cohort ?? '' }))
    const names = [...new Set(classes.map((k) => k.grade).filter(Boolean))]
    return names.map((n) => ({ key: n, name: n, cohort: '' }))
  }, [grades, classes])

  const klass = useMemo(() => classes.find((k) => k.id === classId) ?? null, [classes, classId])

  /**
   * 这个班**教室端那一份**课表 —— `scope='class'` 且 `classId` 是本班。
   * 🔴 这就是教室端那块屏读的那一批（§17 把教室端的写收窄到 `scope='class'`），
   *    所以「核对」核对的是**同一批行**，不是另抄一份。
   */
  const rows = useMemo<ScheduleItem[]>(
    () =>
      schedule
        .filter((s) => s.scope === 'class' && s.classId === classId)
        .slice()
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
    [schedule, classId],
  )

  /**
   * 点一个班：选上它，并把**上一个班**留下的结论全清掉。
   * ⚠️ 清在这里而不是 `useEffect([classId])` 里：同一个"点了才发生"的动作要在**触发它的地方**更新状态
   *    （在 effect 里同步 `setState` 会多渲染一轮，`oxlint` 的 `react(set-state-in-effect)` 会拦）。
   */
  const pickClass = (id: string) => {
    setClassId(id)
    setPaste('')
    setParsed(null)
    setReviewed(false)
    setNote('')
  }

  /**
   * 问服务端"我能不能改这个班的课表"。
   * 🔴 结论**带着班 id**（`capFor`）：`cap` 是在渲染时**推**出来的 ——
   *    换班的那一刻它自动变回 `null`（= 正在读），不需要在 effect 里 `setCap(null)`。
   *    ⚠️ 这与 `Grades.tsx:128` 的 `openIdRef` 挡的是同一件事（"先点甲班、紧接着点乙班"
   *    时甲班那一次读回来的结论不许摆到乙班下面），这里用"结论带 id"表达，比 ref 更直接。
   */
  useEffect(() => {
    if (!classId) return
    let alive = true
    void remote.canManageSchedule(classId).then((r) => {
      if (alive) setCapFor({ id: classId, state: r })
    })
    return () => {
      alive = false
    }
  }, [classId])

  /** 这个班的服务端结论（`null` = 还没问完 / 换班了） */
  const cap = capFor && capFor.id === classId ? capFor.state : null

  /**
   * **每个班有几条课表**（`scope='class'` 那一批）—— 年级副标题的"x 个有课表"与班级行的"x 节 / 未录"都读它。
   * ⚠️ 它按**全量 `schedule`** 分组，**不是**按当前选中的那个班的 `rows`：
   *    后者只对选中的那个班非零，别的班会一律显示"未录"（这个数看起来正常，其实是错的）。
   */
  const countByClass = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of schedule) {
      if (s.scope !== 'class' || !s.classId) continue
      m.set(s.classId, (m.get(s.classId) ?? 0) + 1)
    }
    return m
  }, [schedule])

  /** 这个年级的班（行政班 / 走班班分开 —— 与 `/classes` 同一处 `splitByKind`） */
  const byGrade = useMemo(() => {
    const out = new Map<string, { admin: Klass[]; stream: Klass[] }>()
    for (const g of groups) {
      const mine = classes.filter((k) => k.grade === g.name)
      out.set(g.key, splitByKind(mine))
    }
    return out
  }, [groups, classes])

  /** 有课表的班有几个（年级条副标题用） */
  const withGrid = (g: GradeGroup): number =>
    classes.filter((k) => k.grade === g.name && (countByClass.get(k.id) ?? 0) > 0).length

  if (!classes.length) {
    return (
      <Panel bodyClass="p-3">
        <Empty
          icon={<IconGrid size={24} />}
          title="还没有班级"
          desc="课程管理按年级列出班级。班级建好之后，这里就能一个个班看课表。"
        />
      </Panel>
    )
  }

  return (
    <div data-course-admin="1">
      <Panel bodyClass="p-3">
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
          看每个班的课表、核对教室里显示的那一份。
        </div>

        {groups.map((g) => {
          const open = openGrade === g.key
          const split = byGrade.get(g.key) ?? { admin: [], stream: [] }
          const total = split.admin.length + split.stream.length
          const n = withGrid(g)
          return (
            <div key={g.key} className="mb-1.5">
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${g.name}的班级`}
                data-course-grade={g.key}
                className="row"
                style={{ padding: '8px 10px', border: '1px solid var(--color-line)', borderRadius: 4 }}
                onClick={() => setOpenGrade(open ? null : g.key)}
              >
                <span style={{ color: 'var(--color-ink3)', display: 'grid', placeItems: 'center' }}>
                  <IconStack size={14} />
                </span>
                <span className="min-w-0 flex-1" style={{ fontSize: 13.5, fontWeight: 620 }}>
                  {g.cohort ? `${g.cohort}级 · ` : ''}
                  {g.name}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  {total} 个班 · {n} 个有课表
                </span>
                {/* ⚠️ 图标里没有 ChevronDown —— 用箭头**旋转 90°**当"展开/收起"（照 `Grades.tsx:257`） */}
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    color: 'var(--color-ink3)',
                    transition: 'transform .18s ease',
                    transform: open ? 'rotate(90deg)' : 'none',
                  }}
                >
                  <IconChevronRight size={15} />
                </span>
              </button>

              {open ? (
                <div
                  data-course-grade-body={g.key}
                  className="px-2 pb-2 pt-2"
                  style={{ border: '1px solid var(--color-line)', borderTop: 'none', borderRadius: '0 0 4px 4px' }}
                >
                  {total === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '4px 2px' }}>
                      这个年级还没有班。
                    </div>
                  ) : (
                    <>
                      {split.admin.length ? (
                        <>
                          <Sect>行政班</Sect>
                          <div className="flex flex-col gap-1">
                            {split.admin.map((k) => (
                              <ClassRow
                                key={k.id}
                                klass={k}
                                on={k.id === classId}
                                count={countByClass.get(k.id) ?? 0}
                                onPick={() => pickClass(k.id)}
                              />
                            ))}
                          </div>
                        </>
                      ) : null}
                      {split.stream.length ? (
                        <div className={split.admin.length ? 'mt-2.5' : ''}>
                          <Sect>走班班</Sect>
                          <div className="flex flex-col gap-1">
                            {split.stream.map((k) => (
                              <ClassRow
                                key={k.id}
                                klass={k}
                                on={k.id === classId}
                                count={countByClass.get(k.id) ?? 0}
                                onPick={() => pickClass(k.id)}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </Panel>

      {klass ? (
        <div className="mt-2" data-course-schedule={klass.id}>
          <Panel
            head={`${klass.name} 的课表`}
            extra={
              rows.length ? (
                <Tag tone="ok">已录 {rows.length} 节</Tag>
              ) : (
                <Tag tone="idle">还没录</Tag>
              )
            }
            bodyClass="p-3"
          >
            {/* 🔴 那一句话（权限 / 结果 / 拦下来的原因）—— **上屏，不静默**（§三.5） */}
            {note ? (
              <div
                role="status"
                data-course-note="1"
                style={{
                  background: 'var(--color-warnsoft)',
                  border: '1px solid var(--color-warnline)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  fontSize: 11.5,
                  color: 'var(--color-warnink)',
                  lineHeight: 1.7,
                  marginBottom: 8,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {note}
              </div>
            ) : null}

            {cap === null ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>正在读课表…</div>
            ) : cap.canManage ? (
              rows.length ? (
                /* ---------------- 核对模式：录过了 ---------------- */
                <div data-course-mode="review">
                  {/*
                   * 🔴 **这一块为什么不逐条标"教室里会不会显示"**（而录入模式那张核对表要标）：
                   *    `rows` 是**按 `classId === 本班`** 读出来的（教室端那块屏读的也正是这一条线 ——
                   *    `Classroom.tsx:464` 的 `s.scope === 'class' && s.classId === klass?.id`），
                   *    所以**这些行本来就都会显示**。照"标题里认不认得出班名"去给它们标红，
                   *    是**假红**（红只在"确实不会显示"时才该出现 —— `app/AGENTS.md` §三.4）。
                   *    `matchClassName()` 那个三态判据的用武之地是**待导入的那一批**
                   *    （它们的 `classId` 还没定，靠标题认班名），见下面录入模式。
                   */}
                  <div
                    data-course-show="all"
                    style={{ fontSize: 12, color: 'var(--color-okink)', lineHeight: 1.7, marginBottom: 8 }}
                  >
                    ✓ 这 {rows.length} 条教室里都会显示。
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {rows.map((s) => (
                      <ScheduleRow key={s.id} item={s} />
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    {reviewed ? (
                      <Tag tone="ok">已核对</Tag>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<IconCheck size={14} />}
                        data-course-review="1"
                        onClick={() => setReviewed(true)}
                      >
                        我核对过了
                      </Button>
                    )}
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      一条条对着看，看的是教室里现在显示的那一份。
                    </span>
                  </div>
                </div>
              ) : (
                /* ---------------- 录入模式：还没录过 ---------------- */
                <div data-course-mode="entry">
                  <div style={{ fontSize: 12, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                    这个班还没有课表。把学校发的电子表粘进来，或者一行一条手写，核对之后再导入。
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--color-bad)', lineHeight: 1.7, marginTop: 6 }}>
                    每行都要写上班名「{klass.name}」，教室端才认得出这节课是哪个班的。
                  </div>
                  <textarea
                    className="input mt-2"
                    rows={8}
                    spellCheck={false}
                    data-course-paste="1"
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder={`一行一条，例如：\n周一 08:00-08:40 ${klass.name} 语文\n周一 08:50-09:30 ${klass.name} 数学`}
                    style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!paste.trim() || busy}
                      data-course-parse="1"
                      onClick={() => {
                        const r = parseScheduleText(paste, classes)
                        if (!r.items.length) {
                          setParsed(null)
                          setNote(`没解析出课程。一行一条写最稳，例如「周一 08:00-08:40 ${klass.name} 语文」。`)
                          return
                        }
                        setNote('')
                        setParsed(r.items)
                      }}
                    >
                      解析并核对
                    </Button>
                    {parsed ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        data-course-import="1"
                        onClick={() => {
                          const items = parsed
                            .filter((r) => r.title.trim())
                            .map((r) => ({
                              weekday: r.weekday,
                              start: r.start,
                              end: r.end,
                              title: r.title.trim(),
                              room: r.room,
                              classId: r.classId,
                              kind: r.kind,
                              notify: r.notify,
                              scope: 'class' as const,
                            }))
                          if (!items.length) {
                            setNote('没有可导入的课。')
                            return
                          }
                          setBusy(true)
                          void (async () => {
                            try {
                              /*
                               * 🔴 排课入口的走班冲突闸门（I16）：与教室端粘贴 / 日程表 / 批量粘贴
                               *    **共用同一个** `checkScheduleConflicts` —— 少挂一处就是"有一个入口能绕过"。
                               *    ⚠️ 它只挡"排课的人不知道会撞"（前端判据不是安全边界）；
                               *       "三类冲突分开列 + 给建议"是第 3 轮的事，不在这一轮。
                               */
                              const gate = await checkScheduleConflicts(
                                {
                                  items: items.map((x, i) => ({ ...x, id: `pending-${i}` })),
                                  schedule,
                                  classes,
                                },
                                {
                                  loadMembers: remote.loadClassMembers,
                                  loadSubjects: remote.loadClassSubjects,
                                },
                              )
                              if (gate.blocked) {
                                setNote(`和走班班撞了，没有导入：\n${gate.message}`)
                                return
                              }
                              const n = addScheduleMany(items)
                              setParsed(null)
                              setPaste('')
                              const hidden = items.filter(
                                (x) => markOf(x.title, klass, classes) === 'red',
                              ).length
                              push({
                                text: `已导入 ${n} 条课`,
                                tone: hidden ? 'warn' : 'ok',
                                desc: hidden ? `${hidden} 条没认出班名，教室里不会显示` : undefined,
                              })
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }}
                      >
                        导入这 {parsed.filter((r) => r.title.trim()).length} 条
                      </Button>
                    ) : null}
                  </div>

                  {parsed ? (
                    <div className="mt-3" data-course-parsed="1">
                      <Sect>核对：解析出 {parsed.length} 条</Sect>
                      <div className="flex flex-col gap-1.5">
                        {parsed.map((r, i) => (
                          <div
                            key={`${r.weekday}-${r.start}-${i}`}
                            style={{ border: '1px solid var(--color-line2)', borderRadius: 4, padding: '6px 8px' }}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="num"
                                style={{ fontSize: 11.5, color: 'var(--color-ink3)', flexShrink: 0 }}
                              >
                                {WEEKDAY_TEXT[r.weekday - 1]} {r.start}–{r.end}
                              </span>
                              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
                                {r.title}
                              </span>
                            </div>
                            <MarkLine mark={markOf(r.title, klass, classes)} klass={klass} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            ) : (
              /*
               * 🔴 摆不了入口的三种情形，各自说清是哪一种（**都不是红**）：
               *   · `denied`  —— 数据库说这个班不归我管（科任 / 班主任 / 别年级的年级主任）；
               *   · `missing` —— §38 还没跑（函数 / 表不在）→ **优雅降级**：课表照旧看得见，
               *                  只是写入口不摆，并说清"还没开通"；
               *   · `unknown` —— 这一次没读出来（断网 / 认不出的错）→ 入口先不摆，也不说人家没权限。
               */
              <div data-course-locked={cap.verdict}>
                <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                  {cap.notice}
                </div>
                {rows.length ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {rows.map((s) => (
                      <ScheduleRow key={s.id} item={s} />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
                    这个班还没有课表。
                  </div>
                )}
              </div>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  )
}

/** 一个班一行（点一下选它 —— 右边那块课表就是它的） */
function ClassRow({
  klass,
  on,
  count,
  onPick,
}: {
  klass: Klass
  on: boolean
  count: number
  onPick: () => void
}) {
  const stream = !isAdminClass(klass)
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`看${klass.name}的课表`}
      data-course-class={klass.id}
      className="row"
      style={{
        padding: '7px 9px',
        border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line)'}`,
        borderRadius: 4,
        background: on ? 'var(--color-accentsoft)' : undefined,
      }}
      onClick={onPick}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 99,
          flex: '0 0 auto',
          background: count ? 'var(--color-ok)' : 'var(--color-ink4)',
        }}
      />
      <span className="min-w-0 flex-1" style={{ fontSize: 13, fontWeight: on ? 620 : 550 }}>
        {klass.name}
      </span>
      {/* ⚠️ 走班班的人来自 `class_members`（多对多），这里**不数人数**（照 `Grades.tsx:334`） */}
      {stream ? <Tag tone="idle">走班班</Tag> : null}
      <span
        className="num"
        style={{ fontSize: 11.5, color: count ? 'var(--color-ink3)' : 'var(--color-ink4)' }}
      >
        {count ? `${count} 节` : '未录'}
      </span>
      <IconChevronRight size={14} />
    </button>
  )
}

/**
 * 课表里的一条 —— **只列事实，不判"会不会显示"**。
 * ⚠️ 为什么这里没有 `MarkLine`：凡是**已经挂在这个班上**（`classId` 命中）的行，
 *    教室端那块屏都会显示（`Classroom.tsx:464` 就是按 `classId` 读的），
 *    给它们标红 = 假红。三态标记只出现在**待导入的那一批**上（它们的归属还没定）。
 */
function ScheduleRow({ item }: { item: ScheduleItem }) {
  return (
    <div
      data-course-row={item.id}
      style={{ border: '1px solid var(--color-line2)', borderRadius: 4, padding: '6px 8px' }}
    >
      <div className="flex items-center gap-2">
        <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)', flexShrink: 0 }}>
          {WEEKDAY_TEXT[item.weekday - 1]} {item.start}–{item.end}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
          {item.title}
        </span>
        {item.room ? <Tag tone="idle">{item.room}</Tag> : null}
      </div>
    </div>
  )
}
