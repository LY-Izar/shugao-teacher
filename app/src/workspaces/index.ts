import type { TeacherRole } from '../data/types'
import { entryVisible, seesTeachingData } from '../lib/roles'
import { subjectDirectory } from './subject/directory'
import { classDirectory } from './class/directory'
import { adminDirectory } from './admin/directory'
import type { WorkspaceGroup, WorkspaceId } from './types'

export const WORKSPACES: Record<WorkspaceId, { label: string; short: string; directory: WorkspaceGroup[] }> = {
  subject: { label: '学科管理', short: '学科', directory: subjectDirectory },
  class: { label: '班级管理', short: '班级', directory: classDirectory },
  admin: { label: '行政管理', short: '行政', directory: adminDirectory },
}

export function availableWorkspaces(roles: readonly TeacherRole[] | null | undefined): WorkspaceId[] {
  const codes = new Set((roles ?? []).map((r) => r.role))
  const subject = codes.size === 0 || ['teacher', 'subject_lead', 'lesson_prep_lead', 'head_teacher'].some((r) => codes.has(r as TeacherRole['role'])) || seesTeachingData(roles)
  const klass = codes.has('head_teacher')
  const admin = adminDirectory.some((group) => group.links.some((link) => link.entry !== '/notices' && link.entry !== '/notices/new' && entryVisible(link.entry, roles)))
  return ([['subject', subject], ['class', klass], ['admin', admin]] as const)
    .filter(([, show]) => show)
    .map(([id]) => id)
}

export function visibleDirectory(id: WorkspaceId, roles: readonly TeacherRole[] | null | undefined): WorkspaceGroup[] {
  return WORKSPACES[id].directory
    .map((group) => ({ ...group, links: group.links.filter((link) => entryVisible(link.entry, roles)) }))
    .filter((group) => group.links.length > 0)
}

export function workspaceForPath(path: string, allowed: WorkspaceId[], current: WorkspaceId): WorkspaceId {
  if (path === '/' && allowed.includes(current)) return current
  const matches = allowed.filter((id) => WORKSPACES[id].directory.some((group) =>
    group.links.some((link) => path === link.to || path.startsWith(`${link.to}/`)),
  ))
  if (matches.includes(current)) return current
  return matches[0] ?? allowed[0] ?? 'subject'
}
