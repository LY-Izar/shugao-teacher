import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore } from '../data/store'
import { STATUS_TEXT, WEEKDAY_TEXT, type DailyHomework, type Klass, type Student } from '../data/types'
import { collectStats } from '../lib/assignments'
import { addDays, beijingNow, ymdOf } from '../lib/holiday'
import { loadDailyBundle } from '../lib/daily'
import { PROFILE_FIELDS, emptyProfile, loadStudentProfiles, saveStudentProfile, type StudentProfile } from '../lib/studentProfile'
import { splitLessonTitle } from '../lib/scheduleParse'
import { getSupabase, isRemote } from '../lib/supabase'
import { ClassroomPluginsPanel } from './ClassDetail'
import { PluginTeacherResults } from '../components/PluginTeacherResults'

type PrivateEntry = { id: string; studentId: string; kind: 'tag' | 'note'; body: string; createdAt: string }
type ClassGroup = { id: string; name: string; leaderId: string; memberIds: string[] }
type ClassSeat = { studentId: string; row: number; col: number }

function useClassSeats(classId: string) {
  const key = `shugao.class.seats.${classId}`
  const [seats, setSeats] = useState<ClassSeat[]>(() => {
    if (isRemote) return []
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as ClassSeat[] } catch { return [] }
  })
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!isRemote) localStorage.setItem(key, JSON.stringify(seats))
  }, [key, seats])
  useEffect(() => {
    if (!isRemote) return
    let alive = true
    const sb = getSupabase()
    void sb?.from('class_seats').select('student_id,seat_row,seat_col')
      .eq('class_id', classId).then(({ data, error }) => {
        if (!alive) return
        if (error) { setNotice(`座位表暂时读不到：${error.message}`); return }
        setSeats((data ?? []).map((item) => ({
          studentId: String(item.student_id), row: Number(item.seat_row), col: Number(item.seat_col),
        })))
        setNotice('')
      })
    return () => { alive = false }
  }, [classId])
  const save = async (studentId: string, row: number, col: number): Promise<string> => {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 1 || col < 1 || row > 30 || col > 30)
      return '行和列都需要填写 1 至 30 的整数。'
    if (seats.some((seat) => seat.studentId !== studentId && seat.row === row && seat.col === col))
      return '这个位置已经分配给其他学生。'
    if (isRemote) {
      const sb = getSupabase()
      if (!sb) return '数据库连接不可用，座位没有保存。'
      const { error } = await sb.from('class_seats').upsert({
        class_id: classId, student_id: studentId, seat_row: row, seat_col: col,
      }, { onConflict: 'class_id,student_id' })
      if (error) return `座位没有保存：${error.message}`
    }
    setSeats((before) => [...before.filter((seat) => seat.studentId !== studentId), { studentId, row, col }])
    return ''
  }
  const remove = async (studentId: string): Promise<string> => {
    if (isRemote) {
      const sb = getSupabase()
      if (!sb) return '数据库连接不可用，座位没有清除。'
      const { error } = await sb.from('class_seats').delete().eq('class_id', classId).eq('student_id', studentId)
      if (error) return `座位没有清除：${error.message}`
    }
    setSeats((before) => before.filter((seat) => seat.studentId !== studentId))
    return ''
  }
  return { seats, save, remove, notice }
}

function useClassGroups(classId: string) {
  const key = `shugao.class.groups.${classId}`
  const [groups, setGroups] = useState<ClassGroup[]>(() => {
    if (isRemote) return []
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as ClassGroup[] } catch { return [] }
  })
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!isRemote) { localStorage.setItem(key, JSON.stringify(groups)); return }
  }, [key, groups])
  useEffect(() => {
    if (!isRemote) return
    let alive = true
    const sb = getSupabase()
    void sb?.from('class_groups').select('id,name,leader_id,member_ids')
      .eq('class_id', classId).order('name').then(({ data, error }) => {
        if (!alive) return
        if (error) { setNotice(`班级小组暂时读不到：${error.message}`); return }
        setGroups((data ?? []).map((row) => ({
          id: String(row.id), name: String(row.name),
          leaderId: String(row.leader_id ?? ''), memberIds: row.member_ids as string[] ?? [],
        })))
        setNotice('')
      })
    return () => { alive = false }
  }, [classId])
  const save = async (group: ClassGroup): Promise<string> => {
    const next = { ...group, name: group.name.trim() }
    if (!isRemote) {
      setGroups((before) => before.some((g) => g.id === next.id)
        ? before.map((g) => g.id === next.id ? next : g) : [...before, next])
      return ''
    }
    const sb = getSupabase()
    if (!sb) return '数据库连接不可用，小组没有保存。'
    const { error } = await sb.from('class_groups').upsert({
      id: next.id, class_id: classId, name: next.name,
      leader_id: next.leaderId, member_ids: next.memberIds,
    })
    if (error) return `小组没有保存：${error.message}`
    setGroups((before) => before.some((g) => g.id === next.id)
      ? before.map((g) => g.id === next.id ? next : g) : [...before, next])
    return ''
  }
  const remove = async (id: string): Promise<string> => {
    if (isRemote) {
      const sb = getSupabase()
      if (!sb) return '数据库连接不可用，小组没有删除。'
      const { error } = await sb.from('class_groups').delete().eq('id', id).eq('class_id', classId)
      if (error) return `小组没有删除：${error.message}`
    }
    setGroups((before) => before.filter((group) => group.id !== id))
    return ''
  }
  return { groups, save, remove, notice }
}

function useLocalClassState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? initial } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 本机存储不可用时仍可编辑当前页面 */ } }, [key, value])
  return [value, setValue]
}

function useHomework(classId: string) {
  const today = ymdOf(beijingNow())
  const yesterday = addDays(today, -1)
  const [result, setResult] = useState<{ rows: DailyHomework[]; notice: string } | null>(null)
  useEffect(() => {
    let alive = true
    void loadDailyBundle(classId, yesterday, today).then((data) => {
      if (alive) setResult({ rows: data.homework, notice: data.notice })
    })
    return () => { alive = false }
  }, [classId, today, yesterday])
  return { today, yesterday, result }
}

export default function ClassWorkspace() {
  const { section = 'roster' } = useParams()
  const classes = useStore((s) => s.classes)
  const roles = useStore((s) => s.myRoles)
  const currentClassId = useStore((s) => s.currentClassId)
  const userId = useStore((s) => s.userId) ?? 'demo-head-teacher'
  const ledId = roles.find((r) => r.role === 'head_teacher' && r.scopeType === 'class' && classes.some((c) => c.id === r.scopeId))?.scopeId
  const klass = classes.find((c) => c.id === ledId) ?? (roles.some((r) => r.role === 'head_teacher') ? classes.find((c) => c.id === currentClassId) : undefined)
  const title: Record<string, string> = {
    roster: '学生名单', groups: '班级小组', courses: '班级课程', homework: '班级作业',
    learning: '学习管理', affairs: '班级事务', classroom: '教室操控',
  }
  return <>
    <PageHead title={title[section] ?? '班级管理'} sub={klass ? `${klass.name} · 班主任工作台` : '班主任工作台'} />
    <Page>
      {klass ? <ClassWorkspaceContent key={klass.id} section={section} klass={klass} userId={userId} /> :
        <Panel bodyClass="p-4">当前账号尚未分配可管理的班级。</Panel>}
    </Page>
  </>
}

function ClassWorkspaceContent({ section, klass, userId }: { section: string; klass: Klass; userId: string }) {
  const roster = klass.students.filter((student) => student.status !== 'left')
  const [entries, setEntries] = useLocalClassState<PrivateEntry[]>(`shugao.class.private.${userId}.${klass.id}`, [])
  const classGroups = useClassGroups(klass.id)
  const classSeats = useClassSeats(klass.id)
  const [reps, setReps] = useLocalClassState<Record<string, string>>(`shugao.class.reps.${klass.id}`, {})
  const schedule = useStore((s) => s.schedule)
  const rows = useMemo(() => schedule.filter((row) => row.scope === 'class' && row.classId === klass.id)
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)), [schedule, klass.id])
  const subjects = [...new Set(rows.map((row) => splitLessonTitle(row.title).subject).filter(Boolean))]
  const assignments = useStore((s) => s.assignments)
  const ownAssignments = assignments.filter((assignment) => assignment.classId === klass.id)

  if (section === 'roster') return <ClassRoster klass={klass} roster={roster} entries={entries} setEntries={setEntries} />
  if (section === 'groups') return <><ClassGroups roster={roster} {...classGroups} />
    <ClassSeats roster={roster} {...classSeats} /></>
  if (section === 'courses') return <ClassCourses roster={roster} rows={rows} subjects={subjects} reps={reps} setReps={setReps} />
  if (section === 'homework') return <ClassHomework klass={klass} assignments={ownAssignments} />
  if (section === 'classroom') return <ClassroomControl klass={klass} />
  if (section === 'learning' || section === 'affairs') return <Panel bodyClass="p-5">
    <Sect>{section === 'learning' ? '学习管理' : '班级事务'}</Sect>
    <p style={{ fontSize: 13, color: 'var(--color-ink3)' }}>此板块预留，后续在这里加入本班的管理功能。</p>
  </Panel>
  return <Panel bodyClass="p-4">未找到这个班级板块。</Panel>
}

function ClassRoster({ klass, roster, entries, setEntries }: {
  klass: Klass; roster: Student[]; entries: PrivateEntry[]; setEntries: Dispatch<SetStateAction<PrivateEntry[]>>
}) {
  const [studentId, setStudentId] = useState<string | null>(null)
  const [profile, setProfile] = useState<StudentProfile | null>(null)
  const [profileError, setProfileError] = useState('')
  const [tag, setTag] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const student = roster.find((item) => item.id === studentId)
  const studentEntries = entries.filter((item) => item.studentId === studentId)
  const openStudent = async (id: string) => {
    setStudentId(id); setProfile(null); setProfileError(''); setTag(''); setNote('')
    const result = await loadStudentProfiles([id])
    if (result.ok) setProfile(result.profiles.get(id) ?? emptyProfile(id))
    else setProfileError(result.message)
  }
  const addEntry = (kind: 'tag' | 'note') => {
    const body = (kind === 'tag' ? tag : note).trim()
    if (!studentId || !body) return
    setEntries((list) => [{ id: crypto.randomUUID(), studentId, kind, body, createdAt: new Date().toISOString() }, ...list])
    if (kind === 'tag') setTag(''); else setNote('')
  }
  const saveProfile = async () => {
    if (!profile) return
    setBusy(true)
    const result = await saveStudentProfile(profile)
    setBusy(false)
    setProfileError(result.ok ? '档案已保存。' : result.message)
  }
  return <>
    <Panel head={`${klass.name} · ${roster.length} 名学生`} bodyClass="p-3">
      <div className="overflow-x-auto"><table className="w-full text-left" style={{ fontSize: 13 }}>
        <thead><tr><th className="p-2">学号</th><th className="p-2">姓名</th><th className="p-2">状态</th><th className="p-2">非公开记录</th></tr></thead>
        <tbody>{roster.map((item) => {
          const count = entries.filter((entry) => entry.studentId === item.id).length
          return <tr key={item.id} style={{ borderTop: '1px solid var(--color-line2)' }}>
            <td className="p-2">{item.studentNo}</td><td className="p-2"><button type="button" onClick={() => void openStudent(item.id)} style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{item.name}</button></td>
            <td className="p-2">{item.status === 'active' ? '在读' : '休学'}</td><td className="p-2">{count ? `${count} 条` : '—'}</td>
          </tr>
        })}</tbody>
      </table></div>
    </Panel>
    <Sheet open={!!student} onClose={() => setStudentId(null)} title={student ? `学生档案 · ${student.name}` : '学生档案'}>
      {student ? <div className="flex flex-col gap-4">
        <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>班内学号 {student.studentNo} · {student.status === 'active' ? '在读' : '休学'}</div>
        <div><Sect>基础档案</Sect>{profile ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PROFILE_FIELDS.map((field) => <label key={field.key}><span className="label">{field.label}</span><input className="input" value={profile[field.key]} onChange={(e) => setProfile({ ...profile, [field.key]: e.target.value })} /></label>)}
          <div><Button size="sm" variant="primary" disabled={busy} onClick={() => void saveProfile()}>保存档案</Button></div>
        </div> : <div style={{ fontSize: 12 }}>{profileError || '正在读取档案…'}</div>}</div>
        <div><Sect>仅当前账号可见的标签</Sect><div className="flex flex-wrap gap-2">{studentEntries.filter((item) => item.kind === 'tag').map((item) =>
          <span key={item.id} className="tag tag-accent">{item.body} <button type="button" aria-label={`删除标签 ${item.body}`} onClick={() => setEntries((list) => list.filter((entry) => entry.id !== item.id))}>×</button></span>)}</div>
          <div className="mt-2 flex gap-2"><input className="input" maxLength={24} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="输入非公开标签" /><Button size="sm" disabled={!tag.trim()} onClick={() => addEntry('tag')}>添加</Button></div>
        </div>
        <div><Sect>条目式批注</Sect><textarea className="input" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="一件事写一条批注" /><Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => addEntry('note')}>添加批注</Button>
          <ol className="mt-3 flex flex-col gap-2">{studentEntries.filter((item) => item.kind === 'note').map((item) => <li key={item.id} className="rounded-md border p-2" style={{ borderColor: 'var(--color-line2)' }}><div style={{ color: 'var(--color-ink3)', fontSize: 11 }}>{new Date(item.createdAt).toLocaleString('zh-CN')}</div><p style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{item.body}</p><button type="button" style={{ fontSize: 11, color: 'var(--color-ink3)' }} onClick={() => setEntries((list) => list.filter((entry) => entry.id !== item.id))}>删除这条</button></li>)}</ol>
        </div>
        <p style={{ fontSize: 11, color: 'var(--color-ink4)' }}>标签与批注只保存在当前浏览器的当前账号下，不会显示到教室端。</p>
        {profileError && profile ? <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>{profileError}</p> : null}
      </div> : null}
    </Sheet>
  </>
}

function ClassGroups({ roster, groups, save: saveGroup, remove, notice }: {
  roster: Student[]; groups: ClassGroup[]; save: (group: ClassGroup) => Promise<string>;
  remove: (id: string) => Promise<string>; notice: string
}) {
  const [draft, setDraft] = useState<ClassGroup | null>(null)
  const [error, setError] = useState('')
  const nameOf = (id: string) => roster.find((item) => item.id === id)?.name ?? '已离班'
  const used = new Set(groups.flatMap((group) => group.memberIds))
  const save = async () => {
    if (!draft?.name.trim()) { setError('请填写组名。'); return }
    if (!draft.memberIds.length) { setError('请选择组员。'); return }
    if (!draft.leaderId || !draft.memberIds.includes(draft.leaderId)) { setError('请选择组内的一名学生担任组长。'); return }
    const result = await saveGroup(draft)
    if (result) { setError(result); return }
    setDraft(null); setError('')
  }
  return <>
    <Panel head="全班分组" bodyClass="p-3">
      {notice ? <p style={{ fontSize: 12, color: 'var(--color-warn)' }}>{notice}</p> : null}
      {error && !draft ? <p style={{ fontSize: 12, color: 'var(--color-bad)' }}>{error}</p> : null}
      <div className="flex items-center gap-2"><span style={{ flex: 1, fontSize: 12, color: 'var(--color-ink3)' }}>{groups.length} 个小组 · {roster.length - used.size} 人未分组</span><Button size="sm" variant="primary" onClick={() => setDraft({ id: crypto.randomUUID(), name: '', leaderId: '', memberIds: [] })}>新建小组</Button></div>
      <div className="mt-3 flex flex-col gap-2">{groups.map((group) => <div key={group.id} className="rounded-md border p-3" style={{ borderColor: 'var(--color-line2)' }}><div className="flex items-center gap-2"><strong style={{ flex: 1 }}>{group.name}</strong><Tag tone="accent">组长 {nameOf(group.leaderId)}</Tag><Button size="sm" onClick={() => setDraft({ ...group, memberIds: [...group.memberIds] })}>编辑</Button><Button size="sm" onClick={() => void remove(group.id).then((message) => { if (message) setError(message) })}>删除</Button></div><p style={{ fontSize: 12, color: 'var(--color-ink2)', marginTop: 6 }}>组员：{group.memberIds.map(nameOf).join('、')}</p></div>)}</div>
      {!groups.length ? <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 10 }}>尚未分组。可为每组指定组长与组员。</p> : null}
      {!isRemote ? <p style={{ fontSize: 11, color: 'var(--color-ink4)', marginTop: 10 }}>本地演示分组保存在当前浏览器。</p> : null}
    </Panel>
    <Sheet open={!!draft} onClose={() => { setDraft(null); setError('') }} title={draft ? '编辑班级小组' : '班级小组'} footer={<Button block variant="primary" onClick={() => void save()}>保存小组</Button>}>
      {draft ? <div className="flex flex-col gap-3"><label><span className="label">组名</span><input className="input" maxLength={50} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <div><span className="label">组员</span><div className="flex flex-col gap-1" style={{ maxHeight: 280, overflowY: 'auto' }}>{roster.map((student) => {
          const taken = groups.some((group) => group.id !== draft.id && group.memberIds.includes(student.id))
          return <label key={student.id} className="flex items-center gap-2 p-1"><input type="checkbox" disabled={taken} checked={draft.memberIds.includes(student.id)} onChange={(e) => setDraft({ ...draft, memberIds: e.target.checked ? [...draft.memberIds, student.id] : draft.memberIds.filter((id) => id !== student.id), leaderId: !e.target.checked && draft.leaderId === student.id ? '' : draft.leaderId })} />{student.studentNo} · {student.name}{taken ? '（已在其他组）' : ''}</label>
        })}</div></div>
        <label><span className="label">组长</span><select className="input" value={draft.leaderId} onChange={(e) => setDraft({ ...draft, leaderId: e.target.value })}><option value="">选择组长</option>{draft.memberIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}</select></label>
        {error ? <p style={{ fontSize: 12, color: 'var(--color-bad)' }}>{error}</p> : null}
      </div> : null}
    </Sheet>
  </>
}

function ClassSeats({ roster, seats, save, remove, notice }: {
  roster: Student[]; seats: ClassSeat[]; save: (id: string, row: number, col: number) => Promise<string>;
  remove: (id: string) => Promise<string>; notice: string
}) {
  return <Panel head="座位表" className="mt-4" bodyClass="p-3">
    {notice ? <p style={{ color: 'var(--color-warn)', fontSize: 12 }}>{notice}</p> : null}
    <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginBottom: 10 }}>设置本班学生的行、列；教室插件在审核通过后可只读查看。</p>
    <div className="flex flex-col gap-2">{roster.map((student) => {
      const seat = seats.find((item) => item.studentId === student.id)
      return <SeatEditor key={`${student.id}:${seat?.row ?? 0}:${seat?.col ?? 0}`}
        student={student} seat={seat} save={save} remove={remove} />
    })}</div>
  </Panel>
}

function SeatEditor({ student, seat, save, remove }: {
  student: Student; seat?: ClassSeat; save: (id: string, row: number, col: number) => Promise<string>;
  remove: (id: string) => Promise<string>
}) {
  const [row, setRow] = useState(seat?.row ?? 0)
  const [col, setCol] = useState(seat?.col ?? 0)
  const [error, setError] = useState('')
  return <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 12 }}>
    <span style={{ minWidth: 110 }}>{student.studentNo} · {student.name}</span>
    <label>行 <input className="input num" type="number" min={1} max={30} value={row || ''}
      style={{ width: 56 }} onChange={(event) => setRow(Number(event.target.value))} /></label>
    <label>列 <input className="input num" type="number" min={1} max={30} value={col || ''}
      style={{ width: 56 }} onChange={(event) => setCol(Number(event.target.value))} /></label>
    <Button size="sm" onClick={() => void save(student.id, row, col).then(setError)}>保存</Button>
    {seat ? <Button size="sm" variant="ghost" onClick={() => void remove(student.id).then(setError)}>清除</Button> : null}
    {error ? <span style={{ color: 'var(--color-bad)' }}>{error}</span> : null}
  </div>
}

function ClassCourses({ roster, rows, subjects, reps, setReps }: {
  roster: Student[]; rows: ReturnType<typeof useStore.getState>['schedule']; subjects: string[];
  reps: Record<string, string>; setReps: Dispatch<SetStateAction<Record<string, string>>>
}) {
  return <>
    <Panel head="本班每周课表" bodyClass="p-3">
      {rows.length ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{WEEKDAY_TEXT.map((day, index) => {
        const dayRows = rows.filter((row) => row.weekday === index + 1)
        return <div key={day} className="rounded-md border p-2" style={{ borderColor: 'var(--color-line2)' }}><strong>{day}</strong>{dayRows.length ? dayRows.map((row) => {
          const lesson = splitLessonTitle(row.title)
          return <div key={row.id} className="flex gap-2 py-1" style={{ fontSize: 12, borderTop: '1px solid var(--color-line2)' }}><span className="num">{row.start}</span><span style={{ flex: 1 }}>{lesson.subject}</span>{lesson.teacher ? <span style={{ color: 'var(--color-ink3)' }}>{lesson.teacher}</span> : null}</div>
        }) : <p style={{ fontSize: 12, color: 'var(--color-ink4)' }}>没有课</p>}</div>
      })}</div> : <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>本班还没有课表。</p>}
      <p style={{ fontSize: 11, color: 'var(--color-ink4)', marginTop: 8 }}>这里读取全站共用的班级课表，教室端使用同一份数据。</p>
    </Panel>
    <Panel head="各科课代表" className="mt-4" bodyClass="p-3">
      {subjects.length ? subjects.map((subject) => <label key={subject} className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--color-line2)' }}><span style={{ minWidth: 72, fontWeight: 600 }}>{subject}</span><select className="input" value={reps[subject] ?? ''} onChange={(e) => setReps((current) => ({ ...current, [subject]: e.target.value }))}><option value="">未指定</option>{roster.map((student) => <option key={student.id} value={student.id}>{student.studentNo} · {student.name}</option>)}</select></label>) : <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>录入本班课表后，便可按学科指定课代表。</p>}
      <p style={{ fontSize: 11, color: 'var(--color-ink4)', marginTop: 8 }}>课代表名单目前仅保存在本机演示页面。</p>
    </Panel>
  </>
}

function ClassHomework({ klass, assignments }: { klass: Klass; assignments: ReturnType<typeof useStore.getState>['assignments'] }) {
  const { today, yesterday, result } = useHomework(klass.id)
  return <>
    {result?.notice ? <Panel bodyClass="p-3">{result.notice}</Panel> : null}
    {[[today, '今天'], [yesterday, '昨天']].map(([date, label]) => {
      const daily = result?.rows.filter((item) => item.onDate === date) ?? []
      const records = assignments.filter((item) => item.assignDate === date)
      return <Panel key={date} head={`${label} · ${date}`} className="mb-4" bodyClass="p-3">
        <Sect>各科作业</Sect>{daily.length ? daily.map((item) => <div key={item.id} className="rounded-md border p-2 mb-2" style={{ borderColor: 'var(--color-line2)' }}><strong>{item.subject}</strong><p style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{item.content}</p></div>) : <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>暂无这一天的每日作业记录。</p>}
        <div className="mt-3"><Sect>收缴与完成情况</Sect></div>{records.length ? records.map((item) => {
          const stats = collectStats(klass.students, item)
          return <div key={item.id} className="rounded-md border p-2 mb-2" style={{ borderColor: 'var(--color-line2)' }}><div className="flex flex-wrap items-center gap-2"><strong>{item.subject} · {item.title}</strong><Tag tone="idle">{STATUS_TEXT[item.status]}</Tag></div><p style={{ fontSize: 12, color: 'var(--color-ink2)' }}>{stats.registered ? `已交 ${stats.submitted}/${stats.total} · 未交 ${stats.missing} · 迟交 ${stats.late}` : '收缴尚未登记'} · {item.status === 'graded' || item.status === 'reviewed' || item.status === 'archived' ? '批改已完成' : '批改未完成'}</p></div>
        }) : <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>暂无这一天的作业档案。</p>}
      </Panel>
    })}
  </>
}

function ClassroomControl({ klass }: { klass: Klass }) {
  return <>
    <Panel head="教室端插件" bodyClass="p-3"><ClassroomPluginsPanel classId={klass.id} /></Panel>
    <PluginTeacherResults classId={klass.id} />
  </>
}
