import type { WorkspaceGroup } from '../types'

export const classDirectory: WorkspaceGroup[] = [
  { label: '学生名单', entry: '/classes', to: '/class/roster', links: [
    { label: '名单', to: '/class/roster', entry: '/classes' },
    { label: '小组', to: '/class/groups', entry: '/classes' },
  ] },
  { label: '课程管理', entry: '/schedule', to: '/class/courses', links: [
    { label: '课程', to: '/class/courses', entry: '/schedule' },
    { label: '作业', to: '/class/homework', entry: '/assignments' },
  ] },
  { label: '学习管理', entry: '/classes', to: '/class/learning', links: [
    { label: '学习管理', to: '/class/learning', entry: '/classes' },
  ] },
  { label: '班级事务', entry: '/classes', to: '/class/affairs', links: [
    { label: '班级事务', to: '/class/affairs', entry: '/classes' },
  ] },
  { label: '教室操控', entry: '/files', to: '/class/classroom', links: [
    { label: '插件管理', to: '/class/classroom', entry: '/files' },
  ] },
]
