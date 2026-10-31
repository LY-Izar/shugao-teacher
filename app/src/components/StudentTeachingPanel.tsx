import { useEffect, useMemo, useState } from 'react'
import type { Student, Teacher } from '../data/types'
import { useStore, useToast } from '../data/store'
import * as remote from '../data/remote'
import { isRemote } from '../lib/supabase'
import { subjectName, teacherPrimarySubjectCode } from '../lib/subjects'
import {
  addTeachingEntry, createTeachingGroup, deleteTeachingEntry, deleteTeachingGroup,
  loadTeachingData, type TeachingData, type TeachingEntry,
} from '../lib/studentTeaching'
import { Button, Panel, Sect, Sheet, Tag } from './ui'
import { IconPlus } from './icons'

type Props = {
  classId: string
  roster: Student[]
  subjectView: boolean
  selectedStudent: Student | null
  onCloseStudent: () => void
  onOpenProfile: (studentId: string) => void
  onEntriesChange: (entries: TeachingEntry[]) => void
}

const recordTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
})

export function StudentTeachingPanel({ classId, roster, subjectView, selectedStudent, onCloseStudent, onOpenProfile, onEntriesChange }: Props) {
  const push = useToast((s) => s.push)
  const userId = useStore((s) => s.userId) ?? 'demo-teacher'
  const teacher = useStore((s) => s.teacher) as Teacher | null
  const [subjectCodes, setSubjectCodes] = useState<string[] | null>(null)
  const [subjectError, setSubjectError] = useState('')
  const [chosenSubject, setChosenSubject] = useState('')
  const [loadedFor, setLoadedFor] = useState('')
  const [data, setData] = useState<TeachingData>({ entries: [], groups: [] })
  const [loadError, setLoadError] = useState('')
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [tagText, setTagText] = useState('')
  const [noteText, setNoteText] = useState('')
  const [entryError, setEntryError] = useState('')
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMembers, setGroupMembers] = useState<string[]>([])
  const [groupError, setGroupError] = useState('')
  const rosterIds = roster.map((s) => s.id).join(',')
  const rosterById = useMemo(() => new Map(roster.map((s) => [s.id, s])), [roster])

  useEffect(() => {
    if (!subjectView) return
    let alive = true
    if (!isRemote) {
      Promise.resolve().then(() => {
        if (alive) setSubjectCodes([teacherPrimarySubjectCode(teacher)])
      })
      return () => { alive = false }
    }
    void remote.loadClassSubjects([classId]).then((rows) => {
      if (!alive) return
      if (rows === null) {
        setSubjectError('任教学科暂时读不到，暂不能保存学科记录。')
        setSubjectCodes([])
        return
      }
      setSubjectError('')
      setSubjectCodes([...new Set(rows.filter((r) => r.teacherId === userId).map((r) => r.subjectCode))])
    })
    return () => { alive = false }
  }, [classId, subjectView, teacher, userId])

  const subjectCode = subjectCodes?.includes(chosenSubject) ? chosenSubject : (subjectCodes?.[0] ?? '')

  useEffect(() => {
    let alive = true
    const ids = rosterIds ? rosterIds.split(',') : []
    void loadTeachingData(classId, ids, !subjectView, subjectView ? userId : undefined).then((result) => {
      if (!alive) return
      setLoadedFor(classId)
      if (result.ok) {
        setData(result.data)
        onEntriesChange(result.data.entries)
        setLoadError('')
      } else {
        setData({ entries: [], groups: [] })
        onEntriesChange([])
        setLoadError(result.message)
      }
    })
    return () => { alive = false }
  }, [classId, rosterIds, subjectView, tick, userId, onEntriesChange])

  const selectedEntries = selectedStudent
    ? data.entries.filter((x) => x.studentId === selectedStudent.id)
    : []
  const noteEntries = selectedEntries.filter((x) => x.kind === 'note')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const selectedGroups = selectedStudent
    ? data.groups.filter((x) => x.studentIds.includes(selectedStudent.id))
    : []
  const loading = loadedFor !== classId
  const canWrite = subjectView && !!subjectCode && !loading && !loadError

  const saveEntry = async (kind: 'tag' | 'note') => {
    if (!selectedStudent || !canWrite || busy) return
    const body = (kind === 'tag' ? tagText : noteText).trim()
    if (!body) { setEntryError('请先输入内容。'); return }
    if (kind === 'tag' && body.length > 24) { setEntryError('标签最多 24 字。'); return }
    setBusy(true)
    setEntryError('')
    const result = await addTeachingEntry({ classId, studentId: selectedStudent.id, teacherId: userId, subjectCode, kind, body })
    setBusy(false)
    if (!result.ok) { setEntryError(result.message); return }
    if (kind === 'tag') setTagText('')
    else setNoteText('')
    setTick((x) => x + 1)
    push({ text: kind === 'tag' ? '标签已添加' : '文字记录已保存', tone: 'ok' })
  }

  const removeEntry = async (id: string) => {
    if (busy) return
    setBusy(true)
    const result = await deleteTeachingEntry(id)
    setBusy(false)
    if (!result.ok) { setEntryError(result.message); return }
    setTick((x) => x + 1)
  }

  const saveGroup = async () => {
    if (!canWrite || busy) return
    const members = groupMembers.filter((id) => rosterById.has(id))
    setBusy(true)
    setGroupError('')
    const result = await createTeachingGroup({ classId, teacherId: userId, subjectCode, name: groupName, studentIds: members })
    setBusy(false)
    if (!result.ok) { setGroupError(result.message); return }
    setGroupOpen(false)
    setGroupName('')
    setGroupMembers([])
    setTick((x) => x + 1)
    push({ text: '学科学生组已创建，班主任可查看', tone: 'ok' })
  }

  const removeGroup = async (id: string) => {
    if (!window.confirm('删除这个学生组？组内学生和文字记录不会被删除。')) return
    const result = await deleteTeachingGroup(id)
    if (!result.ok) { push({ text: result.message, tone: 'bad' }); return }
    setTick((x) => x + 1)
  }

  return (
    <>
      <div className="mt-5" id="subject-student-groups">
        <Sect>学科学生组</Sect>
        <Panel head={subjectView ? '我建立的学生组' : '任课教师共享的学生组'} extra={subjectView && canWrite ? (
          <Button size="sm" variant="primary" icon={<IconPlus size={14} />} onClick={() => setGroupOpen(true)}>建组</Button>
        ) : undefined} bodyClass="p-3">
          {loading ? <div className="text-sm text-ink3">正在读取学生组…</div> : loadError ? (
            <div style={{ color: 'var(--color-bad)', fontSize: 13 }}>{loadError}</div>
          ) : data.groups.length ? (
            <div className="flex flex-col gap-2">
              {data.groups.map((g) => {
                const shown = g.studentIds.filter((id) => rosterById.has(id))
                const names = shown.map((id) => rosterById.get(id)?.name || rosterById.get(id)?.studentNo).join('、')
                return <div key={g.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface2)' }}>
                  <div className="flex items-center gap-2">
                    <strong className="flex-1" style={{ fontSize: 14 }}>{g.name}</strong>
                    <Tag tone="idle">{subjectName(g.subjectCode, g.subjectCode)}</Tag>
                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>{subjectView ? '' : '本班 '}{g.studentIds.length} 人</span>
                    {subjectView && g.teacherId === userId ? <button type="button" onClick={() => void removeGroup(g.id)} style={{ fontSize: 12, color: 'var(--color-ink3)' }}>删除组</button> : null}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-ink2)' }}>
                    {names || '本班暂无可显示的成员'}
                  </div>
                </div>
              })}
            </div>
          ) : <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>{subjectView ? '还没有学生组。可按学习情况选人建组，班主任会同步看到。' : '任课教师还没有共享学生组。'}</div>}
          {subjectView && subjectError ? <div style={{ marginTop: 8, color: 'var(--color-warn)', fontSize: 12 }}>{subjectError}</div> : null}
          {subjectView && !isRemote ? <div style={{ marginTop: 8, color: 'var(--color-ink4)', fontSize: 11 }}>本地演示数据仅在当前页面会话中保留。</div> : null}
        </Panel>
      </div>

      <Sheet open={groupOpen} onClose={() => setGroupOpen(false)} title="新建学科学生组" footer={
        <Button block variant="primary" disabled={busy || !canWrite} onClick={() => void saveGroup()}>{busy ? '创建中…' : `创建学生组 · 已选 ${groupMembers.length} 人`}</Button>
      }>
        <div className="flex flex-col gap-4">
          <div><span className="label">组名</span><input className="input" maxLength={50} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="例如：实验探究组" /></div>
          {subjectCodes && subjectCodes.length > 1 ? <div><span className="label">学科</span><select className="input" value={subjectCode} onChange={(e) => setChosenSubject(e.target.value)}>{subjectCodes.map((code) => <option key={code} value={code}>{subjectName(code, code)}</option>)}</select></div> : null}
          <div><span className="label">选择组员</span><div className="flex flex-col gap-1" style={{ maxHeight: 350, overflowY: 'auto' }}>
            {roster.filter((s) => s.status !== 'left').map((s) => <label key={s.id} className="flex items-center gap-2 rounded-md px-2 py-2" style={{ background: groupMembers.includes(s.id) ? 'var(--color-accentsoft)' : 'var(--color-surface2)' }}>
              <input type="checkbox" checked={groupMembers.includes(s.id)} onChange={(e) => setGroupMembers((ids) => e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id))} />
              <span style={{ fontSize: 13 }}>{s.studentNo} · {s.name}</span>
            </label>)}
          </div></div>
          <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>学生组与班主任同步；个人标签和文字记录不会同步。</div>
          {groupError ? <div style={{ color: 'var(--color-bad)', fontSize: 12 }}>{groupError}</div> : null}
        </div>
      </Sheet>

      <Sheet open={!!selectedStudent && subjectView} onClose={onCloseStudent} title={selectedStudent ? `学生情况 · ${selectedStudent.name || selectedStudent.studentNo}` : '学生情况'}>
        {selectedStudent ? <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
            <span>学号 {selectedStudent.studentNo}</span><Tag tone={selectedStudent.status === 'active' ? 'ok' : 'idle'}>{selectedStudent.status === 'active' ? '在读' : selectedStudent.status === 'suspended' ? '休学' : '已转出'}</Tag>
            <button type="button" style={{ marginLeft: 'auto', color: 'var(--color-accent)' }} onClick={() => { onCloseStudent(); onOpenProfile(selectedStudent.id) }}>查看基础档案</button>
          </div>
          {loadError ? <div style={{ color: 'var(--color-bad)', fontSize: 12 }}>{loadError}</div> : null}
          {subjectCodes && subjectCodes.length > 1 ? <div><span className="label">记录学科</span><select className="input" value={subjectCode} onChange={(e) => setChosenSubject(e.target.value)}>{subjectCodes.map((code) => <option key={code} value={code}>{subjectName(code, code)}</option>)}</select></div> : null}
          <div>
            <Sect>仅我可见的标签</Sect>
            <div className="flex flex-wrap gap-2" style={{ minHeight: 32 }}>
              {selectedEntries.filter((x) => x.kind === 'tag').length ? selectedEntries.filter((x) => x.kind === 'tag').map((x) => <span key={x.id} className="flex items-center gap-1 rounded-md px-2 py-1" style={{ background: 'var(--color-accentsoft)', color: 'var(--color-accenttext)', fontSize: 12 }}>
                {x.body}<button type="button" aria-label={`移除标签 ${x.body}`} onClick={() => void removeEntry(x.id)} style={{ fontSize: 14 }}>×</button>
              </span>) : <span style={{ fontSize: 12, color: 'var(--color-ink4)' }}>暂无标签</span>}
            </div>
            <div className="flex gap-2 mt-2"><input className="input" maxLength={24} value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="例如：实验能力强" /><Button size="sm" disabled={!canWrite || busy} onClick={() => void saveEntry('tag')}>加标签</Button></div>
          </div>
          <div>
            <Sect>所在学科组</Sect>
            <div className="flex flex-wrap gap-2">{selectedGroups.length ? selectedGroups.map((g) => <Tag key={g.id} tone="idle">{g.name}</Tag>) : <span style={{ fontSize: 12, color: 'var(--color-ink4)' }}>暂未分组</span>}</div>
          </div>
          <div>
            <Sect>仅我可见的文字记录 · {noteEntries.length} 条</Sect>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface2)' }}>
              <label htmlFor="student-teaching-note" style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600 }}>新增一条记录</label>
              <textarea id="student-teaching-note" className="input" rows={2} maxLength={2000} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="一条事项写一条记录，例如：今天完成了实验操作辅导" style={{ resize: 'vertical' }} />
              <div className="flex items-center justify-between mt-2"><span style={{ fontSize: 11, color: 'var(--color-ink4)' }}>{noteText.length}/2000 字</span><Button size="sm" variant="primary" disabled={!canWrite || busy || !noteText.trim()} onClick={() => void saveEntry('note')}>添加条目</Button></div>
            </div>
            {entryError ? <div style={{ marginTop: 7, color: 'var(--color-bad)', fontSize: 12 }}>{entryError}</div> : null}
            {noteEntries.length ? <ol className="flex flex-col gap-2 mt-3" aria-label="文字记录条目">
              {noteEntries.map((x, index) => <li key={x.id} className="flex gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--color-line)', background: 'var(--color-surface)' }}>
                <span className="flex shrink-0 items-center justify-center rounded-md" style={{ width: 26, height: 26, background: 'var(--color-accentsoft)', color: 'var(--color-accenttext)', fontSize: 11, fontWeight: 700 }}>{noteEntries.length - index}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2" style={{ color: 'var(--color-ink3)', fontSize: 11 }}>
                    <span>{subjectName(x.subjectCode, x.subjectCode)} · {recordTime.format(new Date(x.createdAt))}</span>
                    <button type="button" aria-label={`删除第 ${noteEntries.length - index} 条文字记录`} onClick={() => { if (window.confirm('删除这条文字记录？')) void removeEntry(x.id) }} style={{ color: 'var(--color-ink3)' }}>删除</button>
                  </div>
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7, fontSize: 13, marginTop: 5 }}>{x.body}</p>
                </div>
              </li>)}
            </ol> : <div className="mt-3" style={{ color: 'var(--color-ink4)', fontSize: 12 }}>暂无记录。每次添加会形成一条独立条目，按时间倒序排列。</div>}
          </div>
        </div> : null}
      </Sheet>
    </>
  )
}
