import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { PageHead, Panel } from '../components/ui'
import { useStore } from '../data/store'
import { hasManagingRole } from '../lib/roles'
import CourseAdmin from './CourseAdmin'

/**
 * 「课程管理」`/manage/course`（2026-10-12，**第 3 轮**补上的独立页面）。
 *
 * 🔴 **上一轮为什么没有它**：新地址要**同时**登记四处 —— `App.tsx` 的路由 ·
 *    `lib/pages.ts` 的 `PAGES` · 两份矩阵文档各加一行 —— 而第 2 轮的施工单只允许动
 *    "页面 + 类型 + 数据读写"。所以那一轮它是**就地展开**（在 `/manage` 那张卡下面）。
 *    这一轮把四处一起落掉（用户点名问过「它现在没有单独的页面，是还没有做完的原因吗」）。
 *
 * 🔴 **它和 `/manage` 那张卡是同一个组件**（`CourseAdmin`），不是两份实现：
 *    多一个页面 = 多一处要跟着改的地方，而这里本来就只有一件事（课程管理）。
 *
 * 🔴 **判据**：摆不摆这一页问的是 `lib/roles.ts` 里**既有**那个 `hasManagingRole()`
 *    （最高管理员 / 教务处 / 年级主任）—— 它与数据库的 `can_manage_schedule_for()` 那一档同形。
 *    ⚠️ 这里**没有**在页面里就地写角色数组，也没有新造判据；
 *       "能不能改**这个班**的课表"仍然由服务端回的布尔说了算（`CourseAdmin.tsx`）。
 *    ⚠️ 手打 URL 进得来（不套额外守卫，与 `/accounts` / `/grades` / `/notices` 同款）——
 *       "藏入口"不是安全边界，写入口的闸门在 RLS 与 §38.1.1 的触发器上。
 */
export default function ManageCourse() {
  const navigate = useNavigate()
  const myRoles = useStore((s) => s.myRoles)
  const may = hasManagingRole(myRoles)

  return (
    <>
      <PageHead title="课程管理" sub="课表 · 调课 · 冲突" onBack={() => navigate('/manage')} />
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
