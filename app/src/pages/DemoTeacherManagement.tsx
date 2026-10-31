import { useEffect, useState } from 'react'
import { Page } from '../components/AppShell'
import { Button, PageHead, Panel, Sect } from '../components/ui'
import { useStore } from '../data/store'
import { classKindOf } from '../lib/pick'

type Assignment = { classId: string; subject: string }
type DemoTeacher = {
  id: string
  name: string
  loginEmail: string
  subject: string
  homeAddress: string
  phone: string
  contactEmail: string
  assignments: Assignment[]
}

const KEY = 'shugao-demo-teacher-management-v1'
const blank = (): DemoTeacher => ({
  id: '', name: '', loginEmail: '', subject: '', homeAddress: '', phone: '', contactEmail: '', assignments: [],
})

export default function DemoTeacherManagement({ assignmentOnly }: { assignmentOnly: boolean }) {
  const classes = useStore((s) => s.classes).filter((c) => classKindOf(c) === 'admin')
  const [teachers, setTeachers] = useState<DemoTeacher[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DemoTeacher[] | null
      if (Array.isArray(saved)) return saved
    } catch { /* 无效演示缓存时使用初始名单 */ }
    return [
      { ...blank(), id: 'demo-teacher-1', name: '预览教师', loginEmail: 'preview@example.invalid', subject: '物理' },
      { ...blank(), id: 'demo-teacher-2', name: '演示教师甲', loginEmail: 'teacher-a@example.invalid', subject: '语文' },
      { ...blank(), id: 'demo-teacher-3', name: '演示教师乙', loginEmail: 'teacher-b@example.invalid', subject: '数学' },
    ]
  })
  const [draft, setDraft] = useState<DemoTeacher | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(teachers)) }, [teachers])

  const save = () => {
    if (!draft?.name.trim() || !draft.loginEmail.trim() || !draft.subject.trim()) {
      setMessage('请填写姓名、登录账号和学科。')
      return
    }
    if (draft.assignments.some((a) => !a.classId || !a.subject.trim())) {
      setMessage('每条任课关系都要选班级并填写学科。')
      return
    }
    const next = { ...draft, id: draft.id || crypto.randomUUID(), name: draft.name.trim(), loginEmail: draft.loginEmail.trim() }
    if (teachers.some((t) => t.id !== next.id && t.loginEmail === next.loginEmail)) {
      setMessage('这个登录账号已在演示名单中。')
      return
    }
    setTeachers((list) => list.some((t) => t.id === next.id)
      ? list.map((t) => t.id === next.id ? next : t)
      : [...list, next])
    setDraft(null)
    setMessage('已保存到本机演示数据。')
  }

  return <>
    <PageHead title={assignmentOnly ? '任课老师分派' : '教师管理'}
      sub={assignmentOnly ? '按教师设置班级与学科' : '账号注册 · 教师详细档案'} />
    <Page>
      <Panel bodyClass="p-4">
        <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>本地演示数据；账号注册和修改只保存在这台设备的浏览器中。</p>
        {!assignmentOnly ? <div className="mt-3"><Button variant="primary" onClick={() => { setDraft(blank()); setMessage('') }}>注册教师账号</Button></div> : null}
      </Panel>
      <div className="mt-4"><Sect>{assignmentOnly ? '任课教师' : '教师名单'} · {teachers.length} 人</Sect></div>
      <Panel className="overflow-hidden">
        {teachers.map((teacher) => <button key={teacher.id} type="button" className="row" style={{ padding: 14, width: '100%', textAlign: 'left' }}
          onClick={() => { setDraft({ ...teacher, assignments: teacher.assignments.map((a) => ({ ...a })) }); setMessage('') }}>
          <span style={{ flex: 1 }}><b>{teacher.name}</b><span style={{ marginLeft: 10, color: 'var(--color-ink3)' }}>{teacher.subject}</span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink3)' }}>
              {assignmentOnly ? (teacher.assignments.map((a) => `${classes.find((c) => c.id === a.classId)?.name ?? '班级已删除'} · ${a.subject}`).join('、') || '尚未分派任课班级') : teacher.loginEmail}
            </span></span><span>编辑 ›</span>
        </button>)}
      </Panel>
      {draft ? <Panel bodyClass="p-4" className="mt-4">
        <Sect>{draft.id ? `编辑 · ${draft.name}` : '注册教师账号'}</Sect>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!assignmentOnly ? <>
            <label><span className="label">姓名</span><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label><span className="label">登录账号</span><input className="input" type="email" value={draft.loginEmail} onChange={(e) => setDraft({ ...draft, loginEmail: e.target.value })} /></label>
            <label><span className="label">主学科</span><input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>
            <label><span className="label">联系电话</span><input className="input" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></label>
            <label><span className="label">联系邮箱</span><input className="input" type="email" value={draft.contactEmail} onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })} /></label>
            <label><span className="label">家庭住址</span><input className="input" value={draft.homeAddress} onChange={(e) => setDraft({ ...draft, homeAddress: e.target.value })} /></label>
          </> : null}
        </div>
        {assignmentOnly ? <>
        <div className="mt-4"><Sect>任课班级与学科</Sect></div>
        {draft.assignments.map((assignment, index) => <div key={index} className="mb-2 flex flex-wrap gap-2">
          <select className="input" style={{ flex: 1 }} value={assignment.classId} onChange={(e) => setDraft({ ...draft, assignments: draft.assignments.map((a, i) => i === index ? { ...a, classId: e.target.value } : a) })}>
            <option value="">选择班级</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="input" style={{ flex: 1 }} placeholder="任教学科" value={assignment.subject} onChange={(e) => setDraft({ ...draft, assignments: draft.assignments.map((a, i) => i === index ? { ...a, subject: e.target.value } : a) })} />
          <Button onClick={() => setDraft({ ...draft, assignments: draft.assignments.filter((_, i) => i !== index) })}>移除</Button>
        </div>)}
        <Button onClick={() => setDraft({ ...draft, assignments: [...draft.assignments, { classId: '', subject: draft.subject }] })}>添加任课班级</Button>
        </> : null}
        {message ? <p className="mt-3" style={{ color: 'var(--color-warn)', fontSize: 12 }}>{message}</p> : null}
        <div className="mt-4 flex gap-2"><Button variant="primary" onClick={save}>保存</Button><Button onClick={() => { setDraft(null); setMessage('') }}>取消</Button></div>
      </Panel> : message ? <p className="mt-3" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>{message}</p> : null}
    </Page>
  </>
}
