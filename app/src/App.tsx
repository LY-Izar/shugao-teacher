import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell, ToastHost } from './components/AppShell'
import { useStore } from './data/store'
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
import Schedule from './pages/Schedule'
import Settings from './pages/Settings'
import Workbench from './pages/Workbench'

function Guard({ children }: { children: React.ReactNode }) {
  const teacher = useStore((s) => s.teacher)
  const loc = useLocation()
  if (!teacher) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return <AppShell>{children}</AppShell>
}

export default function App() {
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
