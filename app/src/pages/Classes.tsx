import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCamera,
  IconChevronRight,
  IconPaste,
  IconPencil,
  IconPlus,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, Tag, Track } from '../components/ui'
import { activeStudents, useStore, useToast } from '../data/store'
import type { Klass } from '../data/types'
import { splitByKind } from '../lib/pick'
import { analyzeRoster } from '../lib/roster'

/**
 * 一个班那行卡片。
 *
 * ⚠️ **行政班与走班班共用同一个渲染**，差别只有脚注那一栏：
 *   · 行政班 —— 拍照 / 粘贴名单 / 编辑（这几件事只对行政班有意义）；
 *   · 走班班 —— 没有脚注（它的人来自 `class_members` 的多对多关系，不走"录名单"那一条路）。
 */
function ClassCard({
  klass,
  onOpen,
  onEdit,
}: {
  klass: Klass
  onOpen: () => void
  /** 传了才渲染脚注那一栏（走班班不传） */
  onEdit?: () => void
}) {
  const navigate = useNavigate()
  const h = analyzeRoster(klass.students)
  const pct = h.count ? (h.count / Math.max(h.maxNo, h.count)) * 100 : 0
  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        className="row"
        style={{ alignItems: 'flex-start', padding: 14 }}
        onClick={onOpen}
      >
        <span
          className="grid place-items-center shrink-0"
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
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>{klass.name}</span>
            {h.healthy ? <Tag tone="ok">名单完整</Tag> : <Tag tone="warn">待核对</Tag>}
          </span>
          <span className="mt-0.5 block" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            {klass.grade} · {klass.year} · 学号 1–{h.maxNo || 0}
          </span>

          <span className="mt-2 flex items-center gap-2.5">
            <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {h.count} 人
            </span>
            <span style={{ flex: 1, maxWidth: 150 }}>
              <Track value={pct} tone={h.healthy ? 'var(--color-ok)' : undefined} />
            </span>
          </span>

          {!h.healthy ? (
            <span
              className="mt-2 flex flex-wrap gap-x-3 gap-y-1"
              style={{ fontSize: 11.5, color: 'var(--color-warn)' }}
            >
              {h.gaps.length ? (
                <span>
                  缺号 {h.gaps.slice(0, 6).join('、')}
                  {h.gaps.length > 6 ? '…' : ''}
                </span>
              ) : null}
              {h.dupNos.length ? <span>重号 {h.dupNos.join('、')}</span> : null}
              {h.dupNames.length ? <span>重名 {h.dupNames.join('、')}</span> : null}
            </span>
          ) : null}
        </span>
        <IconChevronRight size={17} />
      </button>

      {onEdit ? (
        <div
          className="flex items-center gap-1 px-3 py-2"
          style={{
            borderTop: '1px solid var(--color-line)',
            background: 'var(--color-surface2)',
          }}
        >
          <Button
            size="sm"
            variant="ghost"
            icon={<IconCamera size={14} />}
            onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
          >
            拍照
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<IconPaste size={14} />}
            onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
          >
            粘贴
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<IconPencil size={14} />} onClick={onEdit}>
            编辑
          </Button>
        </div>
      ) : null}
    </Panel>
  )
}

export default function Classes() {
  const classes = useStore((s) => s.classes)
  const addClass = useStore((s) => s.addClass)
  const updateClass = useStore((s) => s.updateClass)
  const removeClass = useStore((s) => s.removeClass)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', grade: '高二', year: '2025-2026' })

  /*
   * 🔴 **两种班分开显示**（P5 的统一模型 Q21 = A：走班班也是 `classes` 的一行）。
   *    · 这一页的语义是"行政班管理"（建班 / 录名单 / 核名单 / 班型）
   *      → 列表只列**行政班**。把走班班混进来会让"待核对"变成噪音：
   *        走班班的人来自 `class_members`（多对多），`students.class_id` 上永远是空的
   *        → 每一行都显示"缺号 1、2、3…"（**看起来很正常、其实错了**）。
   *    · 走班班单独一段列在下面，**只在真有走班班时渲染**
   *      （没有走班班的库上，这一页的字节与改造前逐字相同 —— P5 的验收第 1 条）。
   *    ⚠️ 判定入口只有 `lib/pick.ts` 的 `splitByKind()`；页面里不许再写 `kind === 'stream'`。
   */
  const { admin: adminClasses, stream: streamClasses } = splitByKind(classes)
  const totalStudents = adminClasses.reduce((n, c) => n + activeStudents(c).length, 0)

  const startNew = () => {
    setEditing(null)
    setForm({ name: '', grade: '高二', year: '2025-2026' })
    setOpen(true)
  }
  const startEdit = (id: string) => {
    const c = classes.find((x) => x.id === id)
    if (!c) return
    setEditing(id)
    setForm({ name: c.name, grade: c.grade, year: c.year })
    setOpen(true)
  }

  return (
    <>
      <PageHead
        title="班级"
        sub={
          `${adminClasses.length} 个班级 · ${totalStudents} 名学生` +
          /* 「另有 N 个走班班」只在真有走班班时才接上去 */
          (streamClasses.length ? ` · 另有 ${streamClasses.length} 个走班班` : '')
        }
        right={
          <Button size="sm" variant="primary" icon={<IconPlus size={15} />} onClick={startNew}>
            新建
          </Button>
        }
      />

      <Page>
        {adminClasses.length === 0 ? (
          <Panel className="overflow-hidden">
            <div className="empty">
              <IconUsers size={26} />
              <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>还没有班级</div>
              <Button variant="primary" size="sm" icon={<IconPlus size={15} />} onClick={startNew}>
                新建班级
              </Button>
            </div>
          </Panel>
        ) : (
          <div className="flex flex-col gap-2.5 stagger">
            {adminClasses.map((c) => (
              <ClassCard
                key={c.id}
                klass={c}
                onOpen={() => navigate(`/classes/${c.id}`)}
                onEdit={() => startEdit(c.id)}
              />
            ))}
          </div>
        )}

        {streamClasses.length ? (
          <div className="mt-5">
            <Sect>走班班</Sect>
            <div className="flex flex-col gap-2.5 stagger">
              {streamClasses.map((c) => (
                <ClassCard key={c.id} klass={c} onOpen={() => navigate(`/classes/${c.id}`)} />
              ))}
            </div>
          </div>
        ) : null}
      </Page>

      {/* 新建 / 编辑 */}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑班级' : '新建班级'}
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!form.name.trim()}
              onClick={() => {
                if (editing) {
                  updateClass(editing, form)
                  push({ text: '已保存', tone: 'ok' })
                } else {
                  const id = addClass(form)
                  push({ text: `已创建 ${form.name}`, tone: 'ok', desc: '接下来导入学生名单' })
                  navigate(`/classes/${id}`)
                }
                setOpen(false)
              }}
            >
              {editing ? '保存' : '创建并录名单'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="label">班级名称</span>
            <input
              className="input"
              placeholder="例如 高二(5)班"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">年级</span>
              <select
                className="input"
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
              >
                {['高一', '高二', '高三'].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">学年</span>
              <input
                className="input"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
              />
            </label>
          </div>
          {editing ? (
            <Button
              variant="danger"
              block
              onClick={() => {
                removeClass(editing)
                setOpen(false)
                push({ text: '班级已删除', tone: 'warn' })
              }}
            >
              删除班级
            </Button>
          ) : null}
        </div>
      </Sheet>
    </>
  )
}
