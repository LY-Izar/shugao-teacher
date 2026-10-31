import type { WorkspaceGroup } from '../types'

export const subjectDirectory: WorkspaceGroup[] = [
  { label: '教学工作', entry: '/schedule', to: '/schedule', links: [
    { label: '个人教学安排', to: '/schedule', entry: '/schedule' },
    { label: '班级情况', to: '/classes', entry: '/classes' },
  ] },
  { label: '作业情况', entry: '/assignments', to: '/assignments', links: [
    { label: '作业列表', to: '/assignments', entry: '/assignments' },
  ] },
  { label: '考试情况', entry: '/exams', to: '/exams', links: [
    { label: '考试列表', to: '/exams', entry: '/exams' },
  ] },
]
