import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconCalendar, IconCheck } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { saveAcademicYear } from '../data/remote'
import { entryVisible } from '../lib/roles'
import {
  academicYearCheck,
  halfText,
  sortTerms,
  termShortText,
  type AcademicYearDraft,
  type Term,
} from '../lib/terms'
import { beijingNow, ymdOf } from '../lib/holiday'

/* ============================================================
   「学期与学年」页 `/grades/terms`（P3 · `年级管理与选科走班方案.md` §4.2.2 ②）
   ------------------------------------------------------------
   这一页只干一件事：**让教导处设一个学年的上下半期起止日期**。

   三条纪律：
     · **"当前学期"不在这里设** —— 它是推出来的（今天落在哪个学期区间里）。
       所以页面上那枚「当前」标签是**读**出来的，不是谁点的（存一份就有两个真相）。
     · **判据不在这一层**：能不能保存由服务端拿调用者 JWT 问数据库
       （`can_manage_terms()` = 教导处 / 最高管理员）。前端只决定"摆不摆这个表单"。
     · 时间口径一律 `beijingNow()`（页面上"今天"那一行用的是它）。
   ============================================================ */

/** 空表单：拿今天推一个像样的默认（开学 9 月 1 日 / 上半年到 1 月 31 日） */
function blankDraft(now: Date = beijingNow()): AcademicYearDraft {
  const y = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1
  return {
    name: `${y}-${y + 1}`,
    yearStart: `${y}-09-01`,
    yearEnd: `${y + 1}-08-31`,
    half1Start: `${y}-09-01`,
    half1End: `${y + 1}-01-31`,
    half2Start: `${y + 1}-02-01`,
    half2End: `${y + 1}-08-31`,
  }
}

/** 一个学年 = 两个半期（按名字把 `terms` 分组；名字来自学年的 `name`） */
type YearGroup = { name: string; yearStart: string; yearEnd: string; terms: Term[] }

function groupByYear(terms: readonly Term[]): YearGroup[] {
  const map = new Map<string, YearGroup>()
  for (const t of terms) {
    const key = t.yearName
    const g = map.get(key) ?? { name: key, yearStart: t.yearStart, yearEnd: t.yearEnd, terms: [] }
    g.terms.push(t)
    map.set(key, g)
  }
  return [...map.values()].sort((a, b) => (a.yearStart < b.yearStart ? 1 : -1))
}

export default function Terms() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const terms = useStore((s) => s.terms)
  const current = useStore((s) => s.currentTermId)
  const myRoles = useStore((s) => s.myRoles)
  const refreshTerms = useStore((s) => s.refreshTerms)

  const [draft, setDraft] = useState<AcademicYearDraft>(() => blankDraft())
  const [busy, setBusy] = useState(false)
  /** 正在编辑的学年名；空串 = 新建一个学年 */
  const [editing, setEditing] = useState('')

  const years = useMemo(() => groupByYear(terms), [terms])
  /*
   * 摆不摆这个表单 —— 走 `lib/roles.ts` 的入口判据（与 `/settings` 那一行同一处），
   * 页面里**不手写角色数组**。⚠️ 这一层不是安全边界：真正的闸门是服务端拿调用者 JWT
   * 问数据库的 `can_manage_terms()`（= 教导处 / 最高管理员）。
   */
  const canWrite = useMemo(() => entryVisible('/settings/terms', myRoles), [myRoles])

  /* 选中某一学年时，把它的日期灌进表单（**不是**另开一个编辑态 —— 表单只有一份） */
  const pick = (g: YearGroup) => {
    const h1 = g.terms.find((t) => t.half === 1)
    const h2 = g.terms.find((t) => t.half === 2)
    setEditing(g.name)
    setDraft({
      name: g.name,
      yearStart: g.yearStart || h1?.startDate || '',
      yearEnd: g.yearEnd || h2?.endDate || '',
      half1Start: h1?.startDate ?? '',
      half1End: h1?.endDate ?? '',
      half2Start: h2?.startDate ?? '',
      half2End: h2?.endDate ?? '',
    })
  }

  useEffect(() => {
    // 第一次进来：库里已有学年就直接拿最近那一个填上（少让教导处从零敲 6 个日期）
    if (!editing && years.length) pick(years[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years.length])

  const why = academicYearCheck(draft)

  const submit = async () => {
    if (why) return
    setBusy(true)
    const r = await saveAcademicYear(draft)
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad' })
      return
    }
    await refreshTerms()
    setEditing(draft.name)
    push({ text: '学年与学期已保存', tone: 'ok', desc: draft.name })
  }

  const field = (
    label: string,
    key: keyof AcademicYearDraft,
    type: 'text' | 'date' = 'date',
  ) => (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input"
        type={type}
        value={draft[key]}
        placeholder={type === 'text' ? '2026-2027' : undefined}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      />
    </label>
  )

  return (
    <>
      <PageHead
        title="学期与学年"
        sub={`今天是 ${ymdOf(beijingNow())}`}
        onBack={() => navigate('/grades')}
      />
      <Page>
        {/* ---------------- 库里已有的学年 ---------------- */}
        <Sect>已有的学年 · {years.length} 个</Sect>
        {years.length === 0 ? (
          <Panel bodyClass="p-4">
            <Empty
              icon={<IconCalendar size={24} />}
              title="还没有学年与学期"
              desc="设一个学年，上下半期的起止日期各填一次。作业与考试会按日期归到学期上。"
            />
          </Panel>
        ) : (
          years.map((g) => (
            <div key={g.name} className="mb-2">
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <b style={{ fontSize: 14.5 }}>{g.name || '（没写学年名）'}</b>
                  {g.name === editing ? <Tag tone="accent">正在编辑</Tag> : null}
                  <span className="flex-1" />
                  <Button size="sm" onClick={() => pick(g)}>
                    改这几个日期
                  </Button>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {sortTerms(g.terms).map((t) => (
                    <div
                      key={t.id}
                      className="flex flex-wrap items-center gap-2"
                      style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}
                    >
                      <span style={{ width: 52 }}>{halfText(t.half)}</span>
                      <span className="num">
                        {t.startDate} — {t.endDate}
                      </span>
                      {t.id === current ? (
                        <Tag tone="ok">
                          <IconCheck size={12} /> 当前学期
                        </Tag>
                      ) : null}
                    </div>
                  ))}
                  {g.terms.length < 2 ? (
                    <span style={{ fontSize: 12, color: 'var(--color-warn)' }}>
                      <IconAlert size={12} /> 这个学年只设了 {g.terms.length} 个半期 —— 另一个半期的档案会没有归属。
                    </span>
                  ) : null}
                </div>
              </Panel>
            </div>
          ))
        )}

        {/* ---------------- 录入 / 修改 ---------------- */}
        <Sect>{editing ? `改「${editing}」` : '加一个学年'}</Sect>
        {canWrite ? (
          <Panel bodyClass="p-4">
            <div className="flex flex-col gap-3">
              {field('学年（形如 2026-2027）', 'name', 'text')}
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                {field('学年开始', 'yearStart')}
                {field('学年结束', 'yearEnd')}
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                {field('上半期开始', 'half1Start')}
                {field('上半期结束', 'half1End')}
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                {field('下半期开始', 'half2Start')}
                {field('下半期结束', 'half2End')}
              </div>
              {why ? (
                <div className="flex items-start gap-2" style={{ fontSize: 12.5, color: 'var(--color-bad)' }}>
                  <IconAlert size={14} />
                  {why}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                  保存后：作业与考试按自己的日期归到学期上；「当前学期」是**推**出来的
                  （今天落在上面的区间里就是它），不在这里设。
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy || Boolean(why)} onClick={() => void submit()}>
                  {busy ? '正在保存…' : '保存这个学年'}
                </Button>
                <Button onClick={() => { setEditing(''); setDraft(blankDraft()) }}>
                  再填一个学年
                </Button>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel bodyClass="p-4">
            <div style={{ fontSize: 13, color: 'var(--color-ink2)', lineHeight: 1.8 }}>
              学年与学期由教导处设 —— 你的账号只能看。
            </div>
          </Panel>
        )}

        {/* ---------------- 提示：今天在哪一段 ---------------- */}
        <p style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          当前学期：
          {current ? ` ${termShortText(terms.find((t) => t.id === current) ?? terms[0])}` : ' 今天不在任何学期区间里'}
          。作业与考试的列表默认只看本学期；切到「全部学期」能看到以前的。
        </p>
      </Page>
    </>
  )
}
