import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGrid,
  IconPlus,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { ensureISO, isoOffset } from '../lib/date'

export default function AssignmentNew() {
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const templates = useStore((s) => s.templates)
  const addAssignment = useStore((s) => s.addAssignment)
  const saveTemplate = useStore((s) => s.saveTemplate)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const firstClass = currentClassId ?? classes[0]?.id ?? ''
  const [classId, setClassId] = useState(firstClass)
  const [title, setTitle] = useState('')
  const [questionCount, setQuestionCount] = useState('6')
  const [assignDate, setAssignDate] = useState(isoOffset(-1))
  const [templateId, setTemplateId] = useState<string | undefined>(undefined)
  const [alsoTemplate, setAlsoTemplate] = useState(false)

  const klass = classes.find((c) => c.id === classId)
  const n = Math.max(1, Math.min(60, Number(questionCount) || 0))

  return (
    <>
      <PageHead
        title="新建作业档案"
        sub="题号结构来自模板，不需要识别图片"
        onBack={() => navigate('/assignments')}
      />

      <Page>
        {classes.length === 0 ? (
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
              还没有班级，请先到「班级」里建立班级并录入学生名单。
            </div>
            <Button
              className="mt-3"
              size="sm"
              variant="primary"
              onClick={() => navigate('/classes')}
            >
              去建立班级
            </Button>
          </Panel>
        ) : (
          <>
            {/* 模板 */}
            <div className="mb-4">
              <Sect>第 1 步 · 选择练习册模板（可跳过）</Sect>
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap gap-2">
                  {templates.map((t) => {
                    const on = templateId === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          if (on) {
                            setTemplateId(undefined)
                            return
                          }
                          setTemplateId(t.id)
                          setTitle(t.name)
                          setQuestionCount(String(t.questionCount))
                        }}
                        className="flex items-center gap-2 px-2.5 py-2 text-left transition-all"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                          maxWidth: '100%',
                        }}
                      >
                        <IconClipboard size={15} />
                        <span style={{ fontSize: 12.5, fontWeight: 550 }} className="truncate">
                          {t.name}
                        </span>
                        <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                          {t.questionCount} 题
                        </span>
                        {on ? <IconCheck size={14} /> : null}
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.65 }}>
                  模板存的是「这个作业有几道题」。建过一次就永久复用 —— 之后批改页展开的题号就是
                  1…N，<b>完全不依赖图像识别</b>。周末卷子直接手填题数即可。
                </p>
              </Panel>
            </div>

            {/* 基本信息 */}
            <div className="mb-4">
              <Sect>第 2 步 · 档案信息</Sect>
              <Panel bodyClass="p-4">
                <label className="block">
                  <span className="label">作业名称</span>
                  <input
                    className="input"
                    placeholder="例如 作业22 电源 闭合电路欧姆定律"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value)
                      setTemplateId(undefined)
                    }}
                  />
                </label>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <label>
                    <span className="label">题目数量</span>
                    <input
                      className="input num"
                      type="number"
                      min={1}
                      max={60}
                      value={questionCount}
                      onChange={(e) => setQuestionCount(e.target.value)}
                    />
                  </label>
                  <label>
                    <span className="label">布置日期</span>
                    <input
                      className="input"
                      type="date"
                      value={assignDate}
                      onChange={(e) => setAssignDate(ensureISO(e.target.value, assignDate))}
                    />
                  </label>
                </div>

                {/* 题号预览 */}
                <div className="mt-4">
                  <span className="label">批改页将按这些题号展开</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: n }).map((_, i) => (
                      <span
                        key={i}
                        className="num grid place-items-center"
                        style={{
                          width: 26,
                          height: 26,
                          border: '1px solid var(--color-line2)',
                          borderRadius: 3,
                          background: 'var(--color-surface2)',
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--color-ink2)',
                        }}
                      >
                        {i + 1}
                      </span>
                    ))}
                  </div>
                </div>
              </Panel>
            </div>

            {/* 班级 */}
            <div className="mb-4">
              <Sect>第 3 步 · 布置班级</Sect>
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap gap-2">
                  {classes.map((c) => {
                    const on = classId === c.id
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setClassId(c.id)}
                        className="flex items-center gap-2 px-3 py-2"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                        }}
                      >
                        <IconUsers size={15} />
                        <span style={{ fontSize: 13, fontWeight: 550 }}>{c.name}</span>
                        <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                          {c.students.filter((s) => s.status === 'active').length} 人
                        </span>
                        {on ? <IconCheck size={14} /> : null}
                      </button>
                    )
                  })}
                </div>
              </Panel>
            </div>

            {/* 汇总 */}
            <Panel className="mb-4" bodyClass="p-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2" style={{ fontSize: 12.5 }}>
                <span className="flex items-center gap-1.5">
                  <IconClipboard size={14} />
                  {klass?.name ?? '未选班级'}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconGrid size={14} />
                  <span className="num">{n}</span> 题
                </span>
                <span className="flex items-center gap-1.5">
                  <IconCalendar size={14} />
                  {assignDate}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconUsers size={14} />
                  应交 <span className="num">{klass?.students.filter((s) => s.status === 'active').length ?? 0}</span> 人
                </span>
              </div>
            </Panel>

            <label className="mb-4 flex items-center gap-2.5 px-1" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alsoTemplate}
                onChange={(e) => setAlsoTemplate(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
              />
              <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                把「{n} 题」存为模板，下次一键带出
              </span>
            </label>

            <div className="flex gap-2">
              <Button
                block
                onClick={() => {
                  if (!classId || !title.trim()) return
                  addAssignment({ title, classId, assignDate, questionCount: n, templateId })
                  push({ text: '档案已建立', tone: 'ok' })
                  navigate('/assignments')
                }}
                disabled={!title.trim()}
              >
                仅建立档案
              </Button>
              <Button
                block
                variant="primary"
                icon={<IconChevronRight size={16} />}
                disabled={!title.trim()}
                onClick={() => {
                  if (!classId || !title.trim()) return
                  const id = addAssignment({
                    title,
                    classId,
                    assignDate,
                    questionCount: n,
                    templateId,
                  })
                  if (alsoTemplate) {
                    saveTemplate({
                      name: title,
                      questionCount: n,
                      subject: '物理',
                    })
                    push({ text: '已存为模板', tone: 'ok' })
                  }
                  navigate(`/assignments/${id}/collect`)
                }}
              >
                建立并去收缴
              </Button>
            </div>

            {!title.trim() ? (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--color-ink3)',
                  textAlign: 'center',
                  marginTop: 8,
                }}
              >
                <IconPlus size={12} /> 填写作业名称后即可创建
              </p>
            ) : null}
          </>
        )}
      </Page>
    </>
  )
}
