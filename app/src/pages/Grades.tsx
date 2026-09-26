import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconChevronRight, IconUsers } from '../components/icons'
import { Button, Empty, PageHead, Panel, Track } from '../components/ui'
import { useStore } from '../data/store'
import { loadGradeSetup, type GradeRow } from '../data/gradeSetup'
import { GRADE_SETUP_STEP_TOTAL } from '../lib/gradeImport'
import { classTypeOf, isAdminClass } from '../lib/pick'

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

export default function Grades() {
  const navigate = useNavigate()
  const myRoles = useStore((s) => s.myRoles)
  /* 年级清单从 store 取（`hydrate()` 里灌的）—— 这一页**不再自己读一次**：
     同一份数据两个读点就是"同一件事两个入口"（§十 踩过四次）。 */
  const grades = useStore((s) => s.grades)
  const [cards, setCards] = useState<Card[] | null>(null)

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

  return (
    <>
      <PageHead title="年级管理" sub="开学准备那一条流水线从这里进" onBack={() => navigate('/settings')} />
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
                ? '建年级这一步在「学期与学年」那一期里（还没做）—— 今天这一页只显示库里已有的年级。'
                : '你的账号看不到任何年级。'
            }
          />
        ) : (
          cards.map((c) => {
            const done = [c.classes > 0, c.typed === c.classes && c.classes > 0, c.picked === c.students && c.students > 0]
            const finished = done.filter(Boolean).length
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
              </div>
            )
          })
        )}
        <p style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          录一个年级的全流程大约 {GRADE_SETUP_STEP_TOTAL} 步（7 个班 330 人量级）——
          名单里带班号，系统自动建班。
        </p>
      </Page>
    </>
  )
}
