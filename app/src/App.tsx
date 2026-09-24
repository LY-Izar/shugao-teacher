import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { AppShell, ToastHost } from './components/AppShell'
import { useStore } from './data/store'
import { useAuthBootstrap } from './hooks/useAuthBootstrap'
import { authExpired, hasAuthStamp, isClassroomDevice, markLogin } from './lib/session'
import { isRemote } from './lib/supabase'
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
import WrongBookClass from './pages/WrongBookClass'
import AssignmentCorrect from './pages/AssignmentCorrect'
import AssignmentImport from './pages/AssignmentImport'
import Files from './pages/Files'
import Schedule from './pages/Schedule'
import Settings from './pages/Settings'
import TeacherAccounts from './pages/TeacherAccounts'
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
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  }
  if (!teacher || expired) {
    return <Navigate to="/login" replace state={{ from: loc.pathname, expired }} />
  }
  return <AppShell>{children}</AppShell>
}

/**
 * 教室端也要登录。
 *
 * 这里以前是**完全公开**的（原来的注释就写着"不要求登录"），后果有两个：
 *  ① 从教师端点进去时，它直接用教师会话渲染教室端 —— 你根本没有机会输教室端账号，
 *     所以那条路**没法测**；
 *  ② 未登录的访客也能打开这块屏。
 * 数据库那边已经按账号收口了（教室端账号只看得见自己那个班），前端也得跟着要求身份，
 * 否则界面上永远是"用谁的会话就显示谁的数据"，账号体系等于白做。
 *
 * 和教师端的 Guard 不同：不检查设备标记（这台机器本来就该是教室端），
 * 也不套 AppShell（教室端是独立的一整屏）。
 */
function ClassroomGate({ children }: { children: React.ReactNode }) {
  const hydrated = useStore((s) => s.hydrated)
  const teacher = useStore((s) => s.teacher)
  const accountKind = useStore((s) => s.accountKind)
  const loc = useLocation()
  if (!hydrated) return <BootScreen />
  if (!teacher) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  }
  return (
    <>
      {/*
       * 教师账号打开教室端 = **预览**：拿自己的班当样本看看这块屏长什么样。
       * 它和一体机上那台（教室端账号，只看得见自己那个班）不是一回事，
       * 不写清楚很容易被当成同一个东西 —— 上一次的困惑就是这么来的。
       * 用 fixed 定位，不参与布局，也不影响截图。
       */}
      {isRemote && accountKind === 'teacher' ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            top: 0,
            zIndex: 60,
            padding: '6px 12px',
            textAlign: 'center',
            fontSize: 12.5,
            lineHeight: 1.5,
            background: 'var(--color-warnsoft)',
            borderBottom: '1px solid ***REMOVED***ecd9ae',
            color: '***REMOVED***8a5a12',
          }}
        >
          预览模式 —— 你用的是<b>教师账号</b>，显示的是你自己的班。
          一体机上那台用的是教室端账号，只看得见它自己那个班。
        </div>
      ) : null}
      {children}
    </>
  )
}

/** 后端模式下的首次加载（通常一闪而过） */
function BootScreen() {  return (
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
        {/* 教室端：独立的一整屏，不套教师端应用壳；但要登录（见 ClassroomGate） */}
        <Route
          path="/classroom"
          element={
            <ClassroomGate>
              <Classroom />
            </ClassroomGate>
          }
        />
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
        {/*
          错题集是**两层**：/wrong = 我任教的班级列表；/wrong/:classId = 某个班的错题档案。
          /wrong 这个入口路径不能改（导航栏和外面可能都有人在用），只加一层子路由。
          两层都在 Guard 里 —— 错题集是教师端功能，教室端账号不涉及（见权限与账号体系设计 §七）。
        */}
        <Route
          path="/wrong"
          element={
            <Guard>
              <WrongBook />
            </Guard>
          }
        />
        <Route
          path="/wrong/:classId"
          element={
            <Guard>
              <WrongBookClass />
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
        {/*
          教师账号（建号 / 主学科 / 任课关系 / 身份）。
          入口在「我的 → 教师账号」，**只有最高管理员和行政老师看得见那个入口**；
          页面自己也会在服务端被拒（判据是数据库的 can_manage_teachers()）。
          路由本身不额外加守卫：藏入口是"少点几下"，不是安全边界。
        */}
        <Route
          path="/accounts"
          element={
            <Guard>
              <TeacherAccounts />
            </Guard>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
