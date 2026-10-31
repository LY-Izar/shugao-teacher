import type { WorkspaceGroup } from '../types'

export const adminDirectory: WorkspaceGroup[] = [
  { label: '学生管理', entry: '/manage/course', to: '/manage', links: [
    { label: '全校学生名单', to: '/manage', entry: '/manage/course' },
    { label: '班级名单与学生档案', to: '/manage/students/:id', entry: '/manage/course', currentClass: true },
  ] },
  { label: '教师管理', entry: '/accounts', to: '/accounts', links: [
    { label: '教师账号与档案', to: '/accounts', entry: '/accounts' },
  ] },
  { label: '课程管理', entry: '/manage/calendar', to: '/manage/calendar', links: [
    { label: '校历', to: '/manage/calendar', entry: '/manage/calendar' },
    { label: '班级课表', to: '/manage/course', entry: '/manage/course' },
  ] },
]
