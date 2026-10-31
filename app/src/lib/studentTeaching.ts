import { getSupabase, isRemote } from './supabase'

export type TeachingEntry = {
  id: string
  classId: string
  studentId: string
  teacherId: string
  subjectCode: string
  kind: 'tag' | 'note'
  body: string
  createdAt: string
}

export type TeachingGroup = {
  id: string
  classId: string
  teacherId: string
  subjectCode: string
  name: string
  studentIds: string[]
}

export type TeachingData = { entries: TeachingEntry[]; groups: TeachingGroup[] }
type Result<T> = { ok: true; data: T } | { ok: false; message: string }

const demoEntries: TeachingEntry[] = []
const demoGroups: TeachingGroup[] = []
const unavailable = '学科记录暂不可用。数据库尚未安装第 47 段，或连接暂时不可用。'

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function rowEntry(r: Record<string, unknown>): TeachingEntry {
  return {
    id: String(r.id), classId: String(r.class_id), studentId: String(r.student_id),
    teacherId: String(r.teacher_id), subjectCode: String(r.subject_code),
    kind: r.kind === 'tag' ? 'tag' : 'note', body: String(r.body ?? ''),
    createdAt: String(r.created_at ?? ''),
  }
}

export async function loadTeachingData(
  classId: string, rosterIds: string[], includeRelatedGroups: boolean, ownerId?: string,
): Promise<Result<TeachingData>> {
  if (!isRemote) {
    const ids = new Set(rosterIds)
    return { ok: true, data: {
      entries: demoEntries.filter((x) => x.classId === classId),
      groups: demoGroups.filter((x) => (!ownerId || x.teacherId === ownerId)
        && (x.classId === classId || (includeRelatedGroups && x.studentIds.some((id) => ids.has(id))))),
    } }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: unavailable }
  try {
    const ownGroupsQuery = sb.from('subject_student_groups').select('*').eq('class_id', classId)
    const ownGroups = ownerId ? await ownGroupsQuery.eq('teacher_id', ownerId) : await ownGroupsQuery
    if (ownGroups.error) return { ok: false, message: `${unavailable} ${ownGroups.error.message}` }
    const relatedIds = new Set<string>()
    if (includeRelatedGroups && rosterIds.length) {
      for (const ids of batches(rosterIds, 80)) {
        for (let from = 0; ; from += 500) {
          const related = await sb.from('subject_student_group_members').select('*').in('student_id', ids)
            .order('student_id').order('group_id').range(from, from + 499)
          if (related.error) return { ok: false, message: `${unavailable} ${related.error.message}` }
          for (const row of related.data ?? []) relatedIds.add(String(row.group_id))
          if ((related.data?.length ?? 0) < 500) break
        }
      }
    }
    const groupIds = [...new Set([...(ownGroups.data ?? []).map((r) => String(r.id)), ...relatedIds])]
    const groupRows: Record<string, unknown>[] = []
    const memberRows: Record<string, unknown>[] = []
    for (const ids of batches(groupIds, 80)) {
      const groupsResult = await sb.from('subject_student_groups').select('*').in('id', ids)
      if (groupsResult.error) return { ok: false, message: `${unavailable} ${groupsResult.error.message}` }
      groupRows.push(...(groupsResult.data ?? []))
      for (let from = 0; ; from += 500) {
        const membersResult = await sb.from('subject_student_group_members').select('*').in('group_id', ids)
          .order('group_id').order('student_id').range(from, from + 499)
        if (membersResult.error) return { ok: false, message: `${unavailable} ${membersResult.error.message}` }
        memberRows.push(...(membersResult.data ?? []))
        if ((membersResult.data?.length ?? 0) < 500) break
      }
    }
    const members = new Map<string, string[]>()
    for (const row of memberRows) {
      const groupId = String(row.group_id)
      members.set(groupId, [...(members.get(groupId) ?? []), String(row.student_id)])
    }
    const groups = groupRows.filter((r) => !ownerId || r.teacher_id === ownerId).map((r) => ({
      id: String(r.id), classId: String(r.class_id), teacherId: String(r.teacher_id),
      subjectCode: String(r.subject_code), name: String(r.name), studentIds: members.get(String(r.id)) ?? [],
    }))
    if (includeRelatedGroups) return { ok: true, data: { entries: [], groups } }
    const entries: TeachingEntry[] = []
    for (let from = 0; ; from += 500) {
      const entriesResult = await sb.from('student_teaching_entries').select('*').eq('class_id', classId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + 499)
      if (entriesResult.error) return { ok: false, message: `${unavailable} ${entriesResult.error.message}` }
      entries.push(...(entriesResult.data ?? []).map(rowEntry))
      if ((entriesResult.data?.length ?? 0) < 500) break
    }
    return { ok: true, data: { entries, groups } }
  } catch (e) {
    return { ok: false, message: `${unavailable} ${errorText(e)}` }
  }
}

export async function addTeachingEntry(input: Omit<TeachingEntry, 'id' | 'createdAt'>): Promise<Result<TeachingEntry>> {
  const body = input.body.trim()
  if (!body || body.length > 2000) return { ok: false, message: '内容需为 1–2000 字。' }
  if (!isRemote) {
    const entry = { ...input, id: crypto.randomUUID(), body, createdAt: new Date().toISOString() }
    demoEntries.unshift(entry)
    return { ok: true, data: entry }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: unavailable }
  try {
    const { data, error } = await sb.from('student_teaching_entries').insert({
      class_id: input.classId, student_id: input.studentId, teacher_id: input.teacherId,
      subject_code: input.subjectCode, kind: input.kind, body,
    }).select('*').single()
    if (error || !data) return { ok: false, message: `保存失败：${error?.message ?? '未写入记录'}` }
    return { ok: true, data: rowEntry(data) }
  } catch (e) { return { ok: false, message: `保存失败：${errorText(e)}` } }
}

export async function deleteTeachingEntry(id: string): Promise<Result<true>> {
  if (!isRemote) {
    const index = demoEntries.findIndex((x) => x.id === id)
    if (index < 0) return { ok: false, message: '找不到这条记录。' }
    demoEntries.splice(index, 1)
    return { ok: true, data: true }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: unavailable }
  try {
    const { data, error } = await sb.from('student_teaching_entries').delete().eq('id', id).select('id')
    if (error || !data?.length) return { ok: false, message: `删除失败：${error?.message ?? '无权限或记录不存在'}` }
    return { ok: true, data: true }
  } catch (e) { return { ok: false, message: `删除失败：${errorText(e)}` } }
}

export async function createTeachingGroup(input: Omit<TeachingGroup, 'id'>): Promise<Result<TeachingGroup>> {
  const name = input.name.trim()
  const studentIds = [...new Set(input.studentIds)]
  if (!name || name.length > 50 || !studentIds.length || studentIds.length > 100)
    return { ok: false, message: '填写 1–50 字组名，并选择 1–100 名学生。' }
  if (!isRemote) {
    const group = { ...input, name, studentIds, id: crypto.randomUUID() }
    demoGroups.unshift(group)
    return { ok: true, data: group }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: unavailable }
  try {
    const { data, error } = await sb.rpc('create_subject_student_group', {
      p_class_id: input.classId, p_subject_code: input.subjectCode, p_name: name, p_student_ids: studentIds,
    })
    if (error || !data) return { ok: false, message: `建组失败：${error?.message ?? '未创建'}` }
    return { ok: true, data: { ...input, id: String(data), name, studentIds } }
  } catch (e) { return { ok: false, message: `建组失败：${errorText(e)}` } }
}

export async function deleteTeachingGroup(id: string): Promise<Result<true>> {
  if (!isRemote) {
    const index = demoGroups.findIndex((x) => x.id === id)
    if (index < 0) return { ok: false, message: '找不到这个组。' }
    demoGroups.splice(index, 1)
    return { ok: true, data: true }
  }
  const sb = getSupabase()
  if (!sb) return { ok: false, message: unavailable }
  try {
    const { data, error } = await sb.from('subject_student_groups').delete().eq('id', id).select('id')
    if (error || !data?.length) return { ok: false, message: `删除失败：${error?.message ?? '无权限或组不存在'}` }
    return { ok: true, data: true }
  } catch (e) { return { ok: false, message: `删除失败：${errorText(e)}` } }
}
