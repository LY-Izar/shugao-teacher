import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconChevronRight, IconCalendar, IconStack, IconUsers } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Tag, Track } from '../components/ui'
import { useStore } from '../data/store'
import { loadGradeSetup, loadStreams, type GradeRow } from '../data/gradeSetup'
import { classTypeOf, isAdminClass, splitByKind } from '../lib/pick'
import { entryVisible } from '../lib/roles'
import type { Klass } from '../data/types'

/**
 * 「年级管理」总览页 `/grades`（`年级管理与选科走班方案.md` §4.3.1）。
 *
 * 🔴 **它不筛数据行**（§11.3 / M3）：这一页读到的年级就是 RLS 给这个人的那几条
 *    （年级主任只有自己那个年级、教务处看全部）。前端**一处 `filter(角色)` 都没有**。
 *
 * ⚠️ 完成度那四个数（班型 / 班主任 / 选科 / 走班）里，**走班那一项本轮不做**
 *    （走班班的生成是 P7）—— 所以这里只显示前四项，不做假数据。
 */

type Card = {
  grade: GradeRow
  classes: number
  students: number
  /** 已设班型的行政班数（`''` = 还没设置，不计入） */
  typed: number
  /** 已采集选科的人数 */
  picked: number
  state: 'present' | 'missing' | 'unknown'
}

/* ============================================================
   🆕 2026-10-07：「班级档案」那一条（用户最早提的那个需求）
   ------------------------------------------------------------
   原话：「年级管理并不是只有开学的时候用呀，平常也会改改档案 —— 是不是应该
   在下面加上高一/高二/高三的档案条，点一下展开该年级所有班级的档案，
   点班级档案可以修改？」

   🔴 **这是一个"行政视角"**：年级主任 / 教务处在这一页看到的是**整个年级的班**，
      不只是自己教的那几个。所以展开条里的班来自**按年级读**（`loadGradeSetup`
      的 `classes` + `loadStreams` 的走班班），**不是**从 `store.classes` 里
      按"我教哪些班"筛出来的。
   🔴 **但"看得见 ≠ 改得动"**：点进去是**同一个**班级档案页
      （`/classes/:id` → `pages/ClassDetail.tsx`），**能改什么仍然由那一页的判据说了算**
      （`canEditClassFor` = 数据库 `can_manage_class_for()` 的前端影子）。
      **本页不新增任何判据、也不判"谁能改"**——它只决定"摆不摆入口"。
   ⚠️ **只有一处班级档案页**（这是本项目最忌的"两套"）：这一条只 `navigate`，
      源码级断言钉住"全仓只有一个 `ClassDetail` 路由"。
   ============================================================ */

type Archive = {
  state: 'present' | 'missing' | 'unknown'
  admin: Klass[]
  stream: Klass[]
}

/**
 * 读一个年级的**全部班**（行政班 + 走班班）。
 *
 * · 行政班：[`loadGradeSetup()`] 的 `classes`（远程模式**只给行政班**，见那里的注释）；
 * · 走班班：[`loadStreams()`]（它单独读 `classes kind='stream'` + `class_members`）——
 *   老库没有 `class_members` 时它自己降级，**不影响行政班那一段**；
 * · 本地演示模式（没有数据库）：两份都回空 → 回落到 `store` 里那一份。
 *   ⚠️ 这与 `GradeDetail.tsx:40` / `GradeSetup.tsx:132` 是**同一条既有写法**
 *      （"远程以库里为准，本地用 store 那一份"），**不是新判据**：
 *      `store.classes` 本身就是数据库（RLS）筛过的结果，前端再 `filter` 的是
 *      **年级名**（形状），不是身份。
 * · 断网 / 读不到 → `'unknown'`（**灰**）：屏上明说"这次没读到"，**不报成"这个年级没有班"**。
 */
async function loadArchive(gradeId: string, gradeName: string, storeClasses: Klass[]): Promise<Archive> {
  const b = await loadGradeSetup(gradeId)
  const s = await loadStreams(gradeId)
  const fromStore = storeClasses.filter((k) => k.grade === gradeName)
  const local = splitByKind(fromStore)
  const all = [...(b.classes.length ? b.classes : local.admin), ...(s.classes.length ? s.classes : local.stream)]
  const { admin, stream } = splitByKind(all)
  const state = b.state === 'present' || s.state === 'present' ? 'present' : b.state
  return { state, admin, stream }
}

export default function Grades() {
  const navigate = useNavigate()
  const myRoles = useStore((s) => s.myRoles)
  /* 年级清单从 store 取（`hydrate()` 里灌的）—— 这一页**不再自己读一次**：
     同一份数据两个读点就是"同一件事两个入口"（§十 踩过四次）。 */
  const grades = useStore((s) => s.grades)
  const storeClasses = useStore((s) => s.classes)
  const [cards, setCards] = useState<Card[] | null>(null)
  /** 展开条那一条（`null` = 收起；`state` 三态见 `Archive`） */
  const [openId, setOpenId] = useState<string | null>(null)
  const [archive, setArchive] = useState<Archive | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const out: Card[] = []
      for (const g of grades) {
        const b = await loadGradeSetup(g.id)
        const admin = b.classes.filter(isAdminClass)
        out.push({
          grade: g,
          classes: admin.length,
          students: admin.reduce((a, k) => a + k.students.filter((s) => s.status === 'active').length, 0),
          typed: admin.filter((k) => classTypeOf(k) !== '').length,
          picked: admin.reduce(
            (a, k) => a + k.students.filter((s) => s.status === 'active' && b.subjects.has(s.id)).length,
            0,
          ),
          state: b.state,
        })
      }
      if (alive) setCards(out)
    })()
    return () => {
      alive = false
    }
  }, [grades])

  /**
   * 点一下那条「班级档案」：展开 / 收起（展开时才读一次那一页的班）。
   * ⚠️ 换一个年级展开时，**先清空上一个年级的结论**（`setArchive(null)`），
   *    并且**只回填还在展开的那一个年级**（`openIdRef`）—— 否则"先点高一、
   *    紧接着点高二"时，高一那一次读回来的班会盖在高二的标题下面
   *    （同一个坑在 `ClassDetail` 的 `roomAccountFor` 那里踩过：屏上必须有且
   *    只有一个年级的数据）。用 ref 而不是 state：回调里要读**当时**那一个值。
   */
  const openIdRef = useRef<string | null>(null)
  const toggleArchive = useCallback(
    (g: GradeRow) => {
      if (openIdRef.current === g.id) {
        openIdRef.current = null
        setOpenId(null)
        return
      }
      openIdRef.current = g.id
      setOpenId(g.id)
      setArchive(null)
      void loadArchive(g.id, g.name, storeClasses).then((r) => {
        if (openIdRef.current === g.id) setArchive(r)
      })
    },
    [storeClasses],
  )

  return (
    <>
      <PageHead
        title="年级管理"
        /*
         * 返回「行政管理」(`/manage`)，不是「我的」。
         * 这一页现在的唯一入口是 `/manage` 那张卡（2026-10-01 起）——
         * 原来写死 `/settings` 是「行政管理」页存在之前的旧世界（那时入口在「我的」）。
         */
        onBack={() => navigate('/manage')}
        right={
          /* 入口判据走 `lib/roles.ts`（与「我的」页那一行同一处），页面里不手写角色数组 */
          entryVisible('/settings/terms', myRoles) ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconCalendar size={14} />}
              onClick={() => navigate('/settings/terms')}
            >
              学期与学年
            </Button>
          ) : null
        }
      />
      <Page>
        {cards === null ? (
          <Panel bodyClass="p-6 text-center">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在读年级…</span>
          </Panel>
        ) : cards.length === 0 ? (
          <Empty
            icon={<IconUsers size={24} />}
            title="还没有年级"
            desc={
              myRoles.length
                ? '还没有年级。'
                : '你的账号看不到任何年级。'
            }
          />
        ) : (
          cards.map((c) => {
            const done = [c.classes > 0, c.typed === c.classes && c.classes > 0, c.picked === c.students && c.students > 0]
            const finished = done.filter(Boolean).length
            const expanded = openId === c.grade.id
            return (
              <div key={c.grade.id} className="mb-2">
                <Panel bodyClass="p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div style={{ fontSize: 15, fontWeight: 650 }}>
                        {c.grade.cohort ? `${c.grade.cohort}级 · ` : ''}
                        {c.grade.name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 2 }}>
                        {c.classes} 个班 · {c.students} 人 ·{' '}
                        {c.typed === c.classes && c.classes > 0
                          ? '班型已设'
                          : c.typed > 0
                            ? `班型 ${c.typed}/${c.classes}`
                            : '班型未设置'}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      icon={<IconChevronRight size={15} />}
                      onClick={() => navigate(`/grades/${c.grade.id}/setup`)}
                    >
                      开学准备
                    </Button>
                  </div>
                  <div className="mt-2.5">
                    <Track value={(finished / 3) * 100} />
                    <div className="mt-1.5" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                      {
                        [
                          c.classes > 0 ? `名单 ✅ ${c.students} 人` : '名单 ⬜ 未录',
                          c.classes > 0 ? `建班 ✅ ${c.classes} 个` : '建班 ⬜ 0 个',
                          c.typed === c.classes && c.classes > 0 ? '班型 ✅' : `班型 ⬜ ${c.typed}/${c.classes}`,
                          c.picked === c.students && c.students > 0 ? `选科 ✅ ${c.picked} 人` : `选科 ⬜ ${c.picked}/${c.students}`,
                        ].join(' · ')
                      }
                    </div>
                  </div>
                  {c.state === 'unknown' ? (
                    <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
                      ⚠ 这一次没读到这个年级的数据（网络或权限），上面的数是旧的或空的。
                    </div>
                  ) : null}
                </Panel>

                {/* 🆕 「班级档案」那一条 —— **与「开学准备」并列**（不是取代它）：
                    「开学准备」是开学那一次的生命周期动作；这一条是**平时**改档案的入口。 */}
                <Panel bodyClass="p-0" className="mt-1.5 overflow-hidden">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${c.grade.name}的班级档案`}
                    data-grade-toggle={c.grade.id}
                    className="row"
                    style={{ padding: '9px 12px', alignItems: 'center' }}
                    onClick={() => toggleArchive(c.grade)}
                  >
                    <span style={{ color: 'var(--color-ink3)', display: 'grid', placeItems: 'center' }}>
                      <IconStack size={14} />
                    </span>
                    <span className="min-w-0 flex-1" style={{ fontSize: 13, fontWeight: 600 }}>
                      班级档案
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                      {expanded && archive ? `${archive.admin.length + archive.stream.length} 个班` : '点一下展开'}
                    </span>
                    {/* ⚠️ 图标里没有 ChevronDown —— 用箭头**旋转 90°**当"展开/收起"，不新画图标 */}
                    <span
                      style={{
                        display: 'grid',
                        placeItems: 'center',
                        color: 'var(--color-ink3)',
                        transition: 'transform .18s ease',
                        transform: expanded ? 'rotate(90deg)' : 'none',
                      }}
                    >
                      <IconChevronRight size={15} />
                    </span>
                  </button>

                  {expanded ? (
                    <div
                      data-grade-archive={c.grade.id}
                      className="px-3 pb-3 pt-1"
                      style={{ borderTop: '1px solid var(--color-line)' }}
                    >
                      {archive === null ? (
                        <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '6px 0' }}>
                          正在读班级…
                        </div>
                      ) : archive.state === 'unknown' ? (
                        <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '6px 0' }}>
                          ⚠ 这一次没读到这个年级的班（网络或权限）—— 不是"这个年级没有班"。
                        </div>
                      ) : archive.admin.length + archive.stream.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '6px 0' }}>
                          这个年级还没有班。
                        </div>
                      ) : (
                        <>
                          {/* 行政班与走班班**分两块**列（与 `/classes` 同一处 `splitByKind`；
                              走班班那一块只在真有走班班时渲染） */}
                          {archive.admin.length ? (
                            <>
                              <Sect>行政班</Sect>
                              <div className="flex flex-col gap-1.5">
                                {archive.admin.map((k) => (
                                  <button
                                    key={k.id}
                                    type="button"
                                    aria-label={`打开${k.name}的班级档案`}
                                    className="row"
                                    style={{ padding: '8px 10px', border: '1px solid var(--color-line)', borderRadius: 4 }}
                                    onClick={() => navigate(`/classes/${k.id}`)}
                                  >
                                    <span className="min-w-0 flex-1" style={{ fontSize: 13, fontWeight: 550 }}>
                                      {k.name}
                                    </span>
                                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                                      {k.students.filter((s) => s.status === 'active').length} 人
                                    </span>
                                    <IconChevronRight size={15} />
                                  </button>
                                ))}
                              </div>
                            </>
                          ) : null}
                          {archive.stream.length ? (
                            <div className={archive.admin.length ? 'mt-3' : ''}>
                              <Sect>走班班</Sect>
                              <div className="flex flex-col gap-1.5">
                                {archive.stream.map((k) => (
                                  <button
                                    key={k.id}
                                    type="button"
                                    aria-label={`打开${k.name}的班级档案`}
                                    className="row"
                                    style={{ padding: '8px 10px', border: '1px solid var(--color-line)', borderRadius: 4 }}
                                    onClick={() => navigate(`/classes/${k.id}`)}
                                  >
                                    <span className="min-w-0 flex-1" style={{ fontSize: 13, fontWeight: 550 }}>
                                      {k.name}
                                    </span>
                                    {/* ⚠️ 走班班的人来自 `class_members`（多对多），
                                        这里**不数人数**（那要一次额外的全表读；`splitByKind` 的注释里写明了） */}
                                    <Tag tone="idle">走班班</Tag>
                                    <IconChevronRight size={15} />
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </Panel>
              </div>
            )
          })
        )}
      </Page>
    </>
  )
}
