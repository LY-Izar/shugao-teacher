import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { Button, PageHead, Panel, Sect, Tag } from '../components/ui'
import { useStore } from '../data/store'
import { loadClassSubjects, loadGradeSetup, type ClassSubjectRow } from '../data/remote'
import { classPickProgress, classTypeOf, isAdminClass, subjectAdvice } from '../lib/pick'
import { subjectName } from '../lib/subjects'
import type { ClassType, Klass } from '../data/types'
import type { StudentSubject } from '../lib/pick'

/**
 * 「一个年级」概览 `/grades/:id`（`年级管理与选科走班方案.md` §4.3.1 里
 * "点进去看这个年级"的那一条）。
 *
 * ⚠️ **只读**：这一页只回答"这个年级现在是什么样"，
 *    所有写入都在 `/grades/:id/setup`（开学准备）那一页里 ——
 *    两个页面都能写 = 同一件事两个入口（§十 踩过四次）。
 */
export default function GradeDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const storeGrades = useStore((s) => s.grades)
  const storeClasses = useStore((s) => s.classes)

  const [loading, setLoading] = useState(true)
  const [classes, setClasses] = useState<Klass[]>([])
  const [subjects, setSubjects] = useState<Map<string, StudentSubject>>(new Map())
  const [csRows, setCsRows] = useState<ClassSubjectRow[] | null>(null)
  const [missing, setMissing] = useState(false)

  const grade = storeGrades.find((g) => g.id === id) ?? null

  useEffect(() => {
    let alive = true
    void (async () => {
      const b = await loadGradeSetup(id)
      if (!alive) return
      setMissing(b.state === 'missing')
      const fromStore = storeClasses.filter((k) => k.grade === b.grade?.name)
      const cls = (b.classes.length ? b.classes : fromStore).filter(isAdminClass)
      setClasses(cls)
      setSubjects(b.subjects)
      setCsRows(await loadClassSubjects(cls.map((k) => k.id)))
      setLoading(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const students = useMemo(
    () => classes.flatMap((k) => k.students.filter((s) => s.status === 'active')),
    [classes],
  )

  const outliers = useMemo(
    () =>
      classes.flatMap((k) =>
        k.students
          .filter((s) => s.status === 'active')
          .map((s) => ({ k, s, adv: subjectAdvice(classTypeOf(k), subjects.get(s.id) ?? null) }))
          .filter((x) => x.adv),
      ),
    [classes, subjects],
  )

  if (loading) {
    return (
      <>
        <PageHead title="年级" onBack={() => navigate('/grades')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在读…</span>
          </Panel>
        </Page>
      </>
    )
  }

  if (missing) {
    return (
      <>
        <PageHead title="年级" onBack={() => navigate('/grades')} />
        <Page>
          <Panel bodyClass="p-4">
            <div style={{ fontSize: 14, fontWeight: 600 }}>数据库还没跑「开学准备」那一段</div>
            <p style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
              到 Supabase → SQL Editor 跑一遍 <code>supabase/schema.sql</code> 第 27 段。
            </p>
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <>
      <PageHead
        title={`${grade?.cohort ? `${grade.cohort}级 · ` : ''}${grade?.name ?? '年级'}`}
        sub={`${classes.length} 个班 · ${students.length} 人`}
        onBack={() => navigate('/grades')}
        right={
          <Button size="sm" onClick={() => navigate(`/grades/${id}/setup`)}>
            开学准备
          </Button>
        }
      />
      <Page>
        <Sect>班与班型</Sect>
        <Panel bodyClass="p-3">
          {classes.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>还没有班。</div>
          ) : (
            classes.map((k) => {
              const p = classPickProgress(k, subjects)
              return (
                <div
                  key={k.id}
                  className="flex items-center gap-2 py-1.5"
                  style={{ borderBottom: '1px solid var(--color-line)' }}
                >
                  <span style={{ flex: 1, fontSize: 13 }}>{k.name}</span>
                  <Tag tone={classTypeOf(k) ? 'accent' : 'idle'}>
                    {classTypeOf(k) ? TYPE_NAME[classTypeOf(k)] : '班型未设置'}
                  </Tag>
                  <Tag tone={p.complete ? 'ok' : 'idle'}>
                    选科 {p.done}/{p.total}
                  </Tag>
                </div>
              )
            })
          )}
        </Panel>

        {/* 首选与班型不符 —— 只提示，不改（Q2） */}
        {outliers.length ? (
          <>
            <Sect>建议转班（首选与班型不符）</Sect>
            <Panel bodyClass="p-3">
              {outliers.slice(0, 20).map((x) => (
                <div key={x.s.id} style={{ fontSize: 12.5, color: 'var(--color-warn)', lineHeight: 1.8 }}>
                  {x.k.name} · {x.s.name}：{x.adv}
                </div>
              ))}
              {outliers.length > 20 ? (
                <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>还有 {outliers.length - 20} 个</div>
              ) : null}
            </Panel>
          </>
        ) : null}

        <Sect>任课关系</Sect>
        <Panel bodyClass="p-3">
          {csRows === null ? (
            <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>没读到（网络或权限）。</div>
          ) : csRows.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
              还没有任课关系（在「开学准备 → 分配身份」里写）。
            </div>
          ) : (
            <div style={{ fontSize: 12.5, lineHeight: 1.9, color: 'var(--color-ink2)' }}>
              {csRows.length} 行 ·{' '}
              {[...new Set(csRows.map((r) => subjectName(r.subjectCode, r.subjectCode)))].join('、')}
            </div>
          )}
        </Panel>
      </Page>
    </>
  )
}

const TYPE_NAME: Record<ClassType, string> = {
  '': '班型未设置',
  undivided: '未分科',
  arts: '文科班',
  science: '理科班',
}
