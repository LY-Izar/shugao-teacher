import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { AppShell, ToastHost } from './components/AppShell'
import { useStore } from './data/store'
import { useAuthBootstrap } from './hooks/useAuthBootstrap'
import { authExpired, hasAuthStamp, isClassroomDevice, markLogin } from './lib/session'
import AssignmentCall from './pages/AssignmentCall'
import AssignmentCollect from './pages/AssignmentCollect'
import AssignmentGrade from './pages/AssignmentGrade'
import AssignmentGradeDone from './pages/AssignmentGradeDone'
import AssignmentNew from './pages/AssignmentNew'
import AssignmentStats from './pages/AssignmentStats'
import Assignments from './pages/Assignments'
import Calls from './pages/Calls'
import ClassDetail from './pages/ClassDetail'
import Classroom from './pages/Classroom'
import Classes from './pages/Classes'
import ImportPaste from './pages/ImportPaste'
import ImportPhoto from './pages/ImportPhoto'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import WrongBook from './pages/WrongBook'
import AssignmentCorrect from './pages/AssignmentCorrect'
import AssignmentImport from './pages/AssignmentImport'
import Files from './pages/Files'
import Schedule from './pages/Schedule'
import Settings from './pages/Settings'
import Workbench from './pages/Workbench'

function Guard({ children }: { children: React.ReactNode }) {
  const teacher = useStore((s) => s.teacher)
  const hydrated = useStore((s) => s.hydrated)
  const accountKind = useStore((s) => s.accountKind)
  const signOut = useStore((s) => s.signOut)
  const loc = useLocation()
  const [expired] = useState(() => authExpired())

  useEffect(() => {
    if (!teacher) return
    if (!expired) {
      // 老设备升级上来时没有登录时间戳：从现在开始计时，不把人直接踢出去
      if (!hasAuthStamp()) markLogin()
      return
    }
    signOut()
  }, [teacher, expired, signOut])

  // 连了后端时，先等会话与数据就绪，否则会误判成「未登录」被踢回登录页
  if (!hydrated) return <BootScreen />
  /*
   * 教室端账号：它整个可见范围就只有自己那一个班，进教师控制台没有任何意义。
   * 这是**账号身份**决定的，和设备标记无关 —— 换个浏览器、清掉 localStorage 也一样。
   * /classroom 本身不在 Guard 里，所以这里不会绕成死循环。
   */
  if (accountKind === 'classroom') return <Navigate to="/classroom" replace />
  /*
   * 这台设备是被当作**教室端**用的（在教室里打开过 /classroom）——
   * 学生把网址后缀一改就能进教师控制台，所以这里要求重新输一次教师密码。
   * 拦的是"改网址"这个实际操作；真正的权限隔离靠独立账号 + 数据库 RLS。
   */
  if (isClassroomDevice()) {
    return <Navigate to="/login" replace state={{ from: loc.pathname, classroom: true }} />
  }
  if (!teacher || expired) {
    return <Navigate to="/login" replace state={{ from: loc.pathname, expired }} />
  }
  return <AppShell>{children}</AppShell>
}

/** 后端模式下的首次加载（通常一闪而过） */
function BootScreen() {
  return (
    <div className="grid min-h-full place-items-center px-6">
      <div className="flex flex-col items-center gap-3">
        <span
          className="live-dot"
          style={{
            width: 10,
            height: 10,
            borderRadius: 99,
            background: 'var(--color-accent)',
            display: 'inline-block',
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在同步数据…</span>
      </div>
    </div>
  )
}

export default function App() {
  useAuthBootstrap()
  return (
    <BrowserRouter>
      <ToastHost />
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* 教室端：一体机上的公共展示，不要求登录，也不套教师端应用壳 */}
        <Route path="/classroom" element={<Classroom />} />
        <Route
          path="/"
          element={
            <Guard>
              <Workbench />
            </Guard>
          }
        />
        <Route
          path="/classes"
          element={
            <Guard>
              <Classes />
            </Guard>
          }
        />
        <Route
          path="/classes/:id"
          element={
            <Guard>
              <ClassDetail />
            </Guard>
          }
        />
        <Route
          path="/classes/:id/import/photo"
          element={
            <Guard>
              <ImportPhoto />
            </Guard>
          }
        />
        <Route
          path="/classes/:id/import/paste"
          element={
            <Guard>
              <ImportPaste />
            </Guard>
          }
        />
        <Route
          path="/assignments"
          element={
            <Guard>
              <Assignments />
            </Guard>
          }
        />
        <Route
          path="/assignments/new"
          element={
            <Guard>
              <AssignmentNew />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/collect"
          element={
            <Guard>
              <AssignmentCollect />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/grade"
          element={
            <Guard>
              <AssignmentGrade />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/correct"
          element={
            <Guard>
              <AssignmentCorrect />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/import"
          element={
            <Guard>
              <AssignmentImport />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/grade/done"
          element={
            <Guard>
              <AssignmentGradeDone />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/stats"
          element={
            <Guard>
              <AssignmentStats />
            </Guard>
          }
        />
        <Route
          path="/assignments/:id/call"
          element={
            <Guard>
              <AssignmentCall />
            </Guard>
          }
        />
        <Route
          path="/calls"
          element={
            <Guard>
              <Calls />
            </Guard>
          }
        />
        <Route
          path="/schedule"
          element={
            <Guard>
              <Schedule />
            </Guard>
          }
        />
        <Route
          path="/files"
          element={
            <Guard>
              <Files />
            </Guard>
          }
        />
        <Route
          path="/wrong"
          element={
            <Guard>
              <WrongBook />
            </Guard>
          }
        />
        <Route
          path="/settings"
          element={
            <Guard>
              <Settings />
            </Guard>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
