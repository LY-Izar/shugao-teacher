import { Page } from '../components/AppShell'
import { Panel } from '../components/ui'
import { useStore } from '../data/store'
import { hasManagingRole } from '../lib/roles'
import Classes from './Classes'

/** 行政的学生管理直接展示全校班级；点击班级进入名单与学生档案。 */
export default function Administration() {
  const myRoles = useStore((s) => s.myRoles)
  if (hasManagingRole(myRoles)) return <Classes />
  return <Page><Panel bodyClass="p-4">你的账号看不到学生管理内容。</Panel></Page>
}
