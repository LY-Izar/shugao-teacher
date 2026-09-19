import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconHash,
  IconPaste,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSwap,
  IconUsers,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { analyzeRoster } from '../lib/roster'

export default function ClassDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const klass = useStore((s) => s.classes.find((c) => c.id === id))
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const updateStudent = useStore((s) => s.updateStudent)
  const removeStudent = useStore((s) => s.removeStudent)
  const transferStudent = useStore((s) => s.transferStudent)
  const addStudents = useStore((s) => s.addStudents)

  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ studentNo: '', name: '', status: 'active' as 'active' | 'left' })
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ studentNo: '', name: '' })

  const health = useMemo(() => analyzeRoster(klass?.students ?? []), [klass])

  if (!klass) {
    return (
      <>
        <PageHead title="班级不存在" onBack={() => navigate('/classes')} />
        <Page>
          <Panel bodyClass="p-6 text-center" >
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>该班级可能已被删除</div>
          </Panel>
        </Page>
      </>
    )
  }

  const list = klass.students
    .filter((s) => {
      if (!q.trim()) return true
      const k = q.trim()
      return s.name.includes(k) || s.studentNo.includes(k)
    })
    .sort((a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name))

  const openEdit = (sid: string) => {
    const s = klass.students.find((x) => x.id === sid)
    if (!s) return
    setEditing(sid)
    setForm({ studentNo: s.studentNo, name: s.name, status: s.status })
  }

  const problems = health.gaps.length + health.dupNos.length + health.dupNames.length

  return (
    <>
      <PageHead
        title={klass.name}
        sub={`${klass.grade} · ${klass.year}`}
        onBack={() => navigate('/classes')}
        right={
          currentClassId === klass.id ? (
            <Tag tone="accent">当前班级</Tag>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setCurrentClass(klass.id)
                push({ text: `已切换为 ${klass.name}`, tone: 'ok' })
              }}
            >
              设为当前
            </Button>
          )
        }
      />

      <Page>
        {/* 体检 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <StatStrip
            items={[
              { k: '学生', v: health.count },
              { k: '学号区间', v: `1–${health.maxNo || 0}` },
              {
                k: '待核对',
                v: problems === 0 ? '正常' : problems,
                tone: problems === 0 ? 'var(--color-ok)' : 'var(--color-warn)',
              },
            ]}
          />
          <div
            className="flex items-start gap-2.5 p-3"
            style={{
              borderTop: '1px solid var(--color-line)',
              background: problems === 0 ? 'var(--color-oksoft)' : 'var(--color-warnsoft)',
            }}
          >
            <span
              style={{ color: problems === 0 ? 'var(--color-ok)' : 'var(--color-warn)', marginTop: 1 }}
            >
              {problems === 0 ? <IconCheck size={16} /> : <IconAlert size={16} />}
            </span>
            <div className="flex-1" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {problems === 0 ? (
                <span style={{ color: '***REMOVED***0b6b4a' }}>
                  名单体检通过：学号 1–{health.maxNo} 连续无缺号，无重号重名。
                </span>
              ) : (
                <span style={{ color: '***REMOVED***8a5a12' }}>
                  {health.gaps.length ? `缺号 ${health.gaps.join('、')}； ` : ''}
                  {health.dupNos.length ? `学号重复 ${health.dupNos.join('、')}； ` : ''}
                  {health.dupNames.length ? `重名 ${health.dupNames.join('、')}； ` : ''}
                  {health.noNumber ? `另有 ${health.noNumber} 人学号非数字` : ''}
                </span>
              )}
            </div>
          </div>
        </Panel>

        {/* 操作 */}
        <div className="mb-3 flex gap-2">
          <Button
            size="sm"
            icon={<IconCamera size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
          >
            拍照录名单
          </Button>
          <Button
            size="sm"
            icon={<IconPaste size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
          >
            粘贴导入
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={15} />}
            onClick={() => {
              setAddForm({ studentNo: String(health.maxNo + 1), name: '' })
              setAddOpen(true)
            }}
          >
            加学生
          </Button>
        </div>

        {/* 名单 */}
        <div>
          <Sect>学生名单 · {klass.students.length} 人</Sect>
          <Panel className="overflow-hidden">
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: '1px solid var(--color-line)', background: 'var(--color-surface)' }}
            >
              <span style={{ color: 'var(--color-ink3)' }}>
                <IconSearch size={16} />
              </span>
              <input
                className="flex-1 bg-transparent"
                style={{ border: 0, outline: 'none', fontSize: 14, fontFamily: 'inherit' }}
                placeholder="搜学号或姓名"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {q ? (
                <button type="button" onClick={() => setQ('')} style={{ color: 'var(--color-ink3)' }}>
                  <IconX size={15} />
                </button>
              ) : null}
            </div>

            {list.length === 0 ? (
              <div className="empty">
                <IconUsers size={24} />
                <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>
                  {klass.students.length === 0 ? '名单还是空的' : '没有匹配的学生'}
                </div>
                {klass.students.length === 0 ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<IconCamera size={14} />}
                      onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
                    >
                      拍照录入
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconPaste size={14} />}
                      onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
                    >
                      粘贴导入
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="max-h-[52vh] overflow-y-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>
                        <span className="flex items-center gap-1">
                          <IconHash size={12} />
                          学号
                        </span>
                      </th>
                      <th>姓名</th>
                      <th style={{ width: 74 }}>状态</th>
                      <th style={{ width: 46 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td className="num" style={{ fontWeight: 600, color: 'var(--color-ink2)' }}>
                          {s.studentNo}
                        </td>
                        <td style={{ fontWeight: 550 }}>{s.name || '—'}</td>
                        <td>
                          {s.status === 'active' ? (
                            <Tag tone="ok">在读</Tag>
                          ) : (
                            <Tag tone="idle">已转出</Tag>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => openEdit(s.id)}
                            aria-label="编辑"
                            style={{ color: 'var(--color-ink3)' }}
                          >
                            <IconPencil size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="mt-3 px-1" style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}>
          转班学生请使用「设为已转出」而非删除，历史作业数据会随之保留。
        </div>
      </Page>

      {/* 编辑学生 */}
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑学生"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              onClick={() => {
                if (editing) updateStudent(klass.id, editing, form)
                setEditing(null)
                push({ text: '已保存', tone: 'ok' })
              }}
            >
              保存
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[92px_1fr] gap-3">
            <label>
              <span className="label">学号</span>
              <input
                className="input num"
                value={form.studentNo}
                onChange={(e) => setForm({ ...form, studentNo: e.target.value })}
              />
            </label>
            <label>
              <span className="label">姓名</span>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
          </div>

          <div>
            <span className="label">在班状态</span>
            <div className="seg">
              <button
                type="button"
                data-on={form.status === 'active'}
                onClick={() => setForm({ ...form, status: 'active' })}
              >
                在读
              </button>
              <button
                type="button"
                data-on={form.status === 'left'}
                onClick={() => setForm({ ...form, status: 'left' })}
              >
                已转出
              </button>
            </div>
          </div>

          {classes.length > 1 ? (
            <div>
              <span className="label">转入其他班级</span>
              <div className="flex flex-wrap gap-1.5">
                {classes
                  .filter((c) => c.id !== klass.id)
                  .map((c) => (
                    <Button
                      key={c.id}
                      size="sm"
                      icon={<IconSwap size={14} />}
                      onClick={() => {
                        if (editing) transferStudent(editing, klass.id, c.id)
                        setEditing(null)
                        push({ text: `已转入 ${c.name}`, tone: 'ok' })
                      }}
                    >
                      {c.name}
                    </Button>
                  ))}
              </div>
            </div>
          ) : null}

          <Button
            variant="danger"
            block
            onClick={() => {
              if (editing) removeStudent(klass.id, editing)
              setEditing(null)
              push({ text: '已删除该学生', tone: 'warn', desc: '删除不可恢复' })
            }}
          >
            彻底删除
          </Button>
        </div>
      </Sheet>

      {/* 新增学生 */}
      <Sheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新增学生"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!addForm.name.trim()}
              onClick={() => {
                addStudents(klass.id, [addForm], 'merge')
                setAddOpen(false)
                push({ text: `已添加 ${addForm.name}`, tone: 'ok' })
                setAddForm({ studentNo: '', name: '' })
              }}
            >
              添加
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-[92px_1fr] gap-3">
          <label>
            <span className="label">学号</span>
            <input
              className="input num"
              value={addForm.studentNo}
              onChange={(e) => setAddForm({ ...addForm, studentNo: e.target.value })}
            />
          </label>
          <label>
            <span className="label">姓名</span>
            <input
              className="input"
              placeholder="学生姓名"
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
              autoFocus
            />
          </label>
        </div>
      </Sheet>
    </>
  )
}
