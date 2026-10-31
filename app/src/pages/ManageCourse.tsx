import { Page } from '../components/AppShell'
import { PageHead, Panel } from '../components/ui'
import { useStore } from '../data/store'
import { hasManagingRole } from '../lib/roles'
import CourseAdmin from './CourseAdmin'

/** 班级课表页复用现有课表与临时调课逻辑；具体写入权限仍由服务端判定。 */
export default function ManageCourse() {
  const myRoles = useStore((s) => s.myRoles)
  const may = hasManagingRole(myRoles)

  return (
    <>
      <PageHead title="班级课表" sub="各班课表 · 临时调课 · 教师分配" />
      <Page>
        {may ? (
          <CourseAdmin />
        ) : (
          /* 🔴 手打 URL 进来且够不着这一档 → **说人话**，不白屏、不静默（§三.5） */
          <Panel bodyClass="p-4">
            <div data-course-denied="1" style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              你的账号看不到这一页的内容。
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-ink4)', lineHeight: 1.7, marginTop: 4 }}>
              课程表由教务处与年级主任维护。
            </div>
          </Panel>
        )}
      </Page>
    </>
  )
}
