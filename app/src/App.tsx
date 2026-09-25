import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect, useLayoutEffect, useState } from 'react'
import { AppShell, ToastHost } from './components/AppShell'
import { useStore } from './data/store'
import { useAuthBootstrap } from './hooks/useAuthBootstrap'
import { authExpired, hasAuthStamp, isClassroomDevice, markLogin } from './lib/session'
import { devInjectedAccountKind, devInjectedRoles } from './lib/roles'
import { isRemote } from './lib/supabase'
import type { TeacherRole } from './data/types'
import Admin from './pages/Admin'
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
import ExamGrade from './pages/ExamGrade'
import ExamNew from './pages/ExamNew'
import Exams from './pages/Exams'
import ExamStats from './pages/ExamStats'
import ImportPaste from './pages/ImportPaste'
import ImportPhoto from './pages/ImportPhoto'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import NoticeNew from './pages/NoticeNew'
import Notices from './pages/Notices'
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
  /*
   * 🔴 **G7（用户 2026-09-28 拍板）：教师账号在"被标成教室端的设备"上打开 /classroom —— 直接拦住。**
   *
   * 为什么必须拦，而不是像以前那样只挂一条黄条放行：
   *   这块屏是**给学生看的**（挂在教室墙上/一体机上），而教师账号在这上面渲染的是
   *   **他自己的全部班级数据**（名单、收缴、讲评材料）—— 学生把网址后缀一改、
   *   或者上一位老师在这台机器上登过、没退出，屏上就是那些数据。
   *   只挂黄条 = **用一条提示代替了一道安全边界**，而这条边界的两端不对等：
   *   拦错的代价是"老师去自己电脑上看"，放过的代价是"全班学生看到教师数据"。
   *
   * 判据是「**这台设备被标成教室端**（`isClassroomDevice()`）× **当前是教师账号**」：
   *   · 教室端账号（`accountKind === 'classroom'`）→ **照常放行**，那正是这块屏的主人；
   *   · 教师账号 + 设备**没**被标成教室端 → 照常放行。老师在自己电脑/手机上
   *     打开 `/classroom` 是想核对那块屏长什么样（比如看课表排版），
   *     而**他自己的设备**上不存在"学生围过来看"这个场景；
   *   · 教师账号 + 设备**已被标成教室端** → 拦住并说明出路。
   *
   * ⚠️ 这不是"教师端 Guard"那条分支的重复：Guard 拦的是**反方向**
   *    （教室端设备去访问教师端），而且它只把人送去登录页；这里说的是
   *    "这台机器本来就是教室端，拿教师账号打开等于在教室里摊开教师数据"。
   */
  const isTeacherAccount = accountKind !== 'classroom'
  if (isTeacherAccount && isClassroomDevice()) {
    return (
      <div className="grid min-h-full place-items-center px-6 py-10">
        <div className="w-full anim-in" style={{ maxWidth: 420 }}>
          <div className="panel overflow-hidden" data-classroom-blocked>
            <div className="panel-head">
              <h2>这台机器是教室端</h2>
            </div>
            <div className="p-4" style={{ fontSize: 13, lineHeight: 1.85 }}>
              <p style={{ color: 'var(--color-bad)', fontWeight: 620 }}>
                教师账号不能在这台设备上打开教室端。
              </p>
              <p className="mt-2" style={{ color: 'var(--color-ink2)' }}>
                这块屏是<b>挂在教室里给学生看</b>的，而教师账号在它上面渲染的是
                <b>你自己的全部班级数据</b>（名单、收缴、讲评材料）。
                只提醒一句就放行，等于让学生有机会看到这些 —— 所以这里直接拦住。
              </p>
              <p className="mt-3" style={{ color: 'var(--color-ink2)' }}>
                <b>三条出路：</b>
              </p>
              <ul className="mt-1" style={{ color: 'var(--color-ink3)', paddingLeft: 18 }}>
                <li>
                  一体机上请用<b>教室端账号</b>登录 —— 教室端账号只看得见它自己那个班，
                  这正是它的用途（在「我的 → 教室端账号」里建）。
                </li>
                <li>
                  想核对这块屏长什么样：去<b>另一台设备</b>（自己的电脑/手机）打开
                  <code> /classroom</code>，那边的设备标记不是教室端，照常可看。
                </li>
                <li>
                  这台机器本来就是教师端：到<b>登录页用教师密码登一次</b>
                  （登录会把设备角色改回教师端），之后就能正常进教师控制台。
                </li>
              </ul>
              <div className="mt-4 flex flex-wrap gap-2">
                {/*
                 * 这里**刻意不用 `useNavigate()`** —— `ClassroomGate` 是包在
                 * `<Route element={…}>` 上的组件，而 `App.tsx` 的 `useNavigate`
                 * 之前没有在这个文件里出现过。用普通链接最稳：教室端那一屏
                 * 本来就不该（也不需要）参与教师端的路由动画与历史栈。
                 */}
                <a className="btn btn-primary btn-sm" href="/">
                  回教师端
                </a>
                <a className="btn btn-sm" href="/login">
                  去登录页换个账号
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
  /*
   * 教师账号 + **自己的**设备（设备标记不是教室端）→ 照旧是"预览"：
   * 拿自己的班当样本看看这块屏长什么样。它和一体机上那台（教室端账号，
   * 只看得见自己那个班）不是一回事，不写清楚很容易被当成同一个东西。
   * 用 fixed 定位，不参与布局，也不影响截图。
   */
  return (
    <>
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
          ⚠️ 在<b>被标成教室端的设备</b>上这条路是**拦住**的（那台屏是给学生看的）。
        </div>
      ) : null}
      {children}
    </>
  )
}

/**
 * 全局的 `syncError` 横幅。
 *
 * 🔴 **它为什么必须在这一层（`<Router>` 里、所有路由之外）**
 *
 * `syncError` 原来只有两个消费者：教师端 `AppShell` 与教室端 `Classroom` 的 `SyncBanner`。
 * 而 `hydrate()` 失败那条路的症状是：
 *   `loadSnapshot()` 返回 null → `store.hydrate()` 只 `set({hydrated:true})` **不设 teacher**
 *   → `Guard` 把用户 `<Navigate to="/login">` → **而登录页不渲染 `syncError`**（它不在 `AppShell` 里）。
 * → 实际症状是「**莫名被踢回登录页，毫无解释**」：顶栏那条报错横幅**永远没机会出现**，
 *   因为用户已经不在 `AppShell` 里了。
 *
 * 修法就是**把它抬到所有路由之上** —— 这样登录页、教室端、以及超管面板都能看见它。
 * ⚠️ 这也正是"超管面板不能长在 `AppShell` 里"的同一个理由（面板方案 §二 D2 / §3.6）：
 *    **同一个状态要在所有读它的人面前显示**，而"半坏状态"下恰恰是最需要它的时刻。
 *
 * ⚠️ 刻意**不改 `syncError` 的形态**（它仍然是一个字符串槽位、没有时间、没有历史）——
 *    那是 D1/D2 的事（要改 `remote.upsert/remove` + 环形缓冲），第二期。
 *    这里只解决"没人看得到"。
 */
function SyncErrorBanner() {
  const syncError = useStore((s) => s.syncError)
  const clearSyncError = useStore((s) => s.clearSyncError)
  if (!syncError) return null
  return (
    <div
      role="alert"
      data-sync-error-banner
      className="fixed inset-x-0 top-0 z-[70] flex items-start gap-2 px-3 py-2"
      style={{
        background: 'var(--color-badsoft)',
        borderBottom: '1px solid ***REMOVED***f3c9cd',
        color: '***REMOVED***8f1c26',
        fontSize: 12.5,
        lineHeight: 1.65,
      }}
    >
      <span className="min-w-0 flex-1">
        <b>云端同步出错，改动可能没有保存。</b>
        <span style={{ display: 'block', opacity: 0.9 }}>
          {syncError}
          <span style={{ opacity: 0.8 }}>
            {' '}
            —— 若你刚才被踢回登录页，原因大概率就是它（数据没读全，路由守卫会当成"未登录"）。
          </span>
        </span>
      </span>
      <button
        type="button"
        onClick={clearSyncError}
        style={{ flex: 'none', color: '***REMOVED***8f1c26', opacity: 0.75, fontSize: 12 }}
      >
        知道了
      </button>
    </div>
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

/**
 * 🧪 **DEV-only 测试钩子**：把 `?as=` / `?kind=` 注入到 store 的两个槽位。
 *
 * 为什么必须有它（`按身份显示导航方案.md` §七 待确认 ③ / §五 R3）：
 * `shots.mjs` 跑的是**本地演示模式**，而 `myRoles` 与 `accountKind` 都只在**远程模式**
 * 由 `hydrate()` 灌进去（`store.ts` 的 `remote.loadMyRoles` / `loadClassroomAccount`），
 * 演示模式恒为 `[]` / `'teacher'` —— 于是两句话**永远断言不了**：
 *   · 「教导处看得见『教师账号』这一行」（该显示的时候真的显示）；
 *   · 「教室端账号进不了教师端」（G6，安全边界，今天一条自动断言都没有）。
 * 负向对照只能证明"藏住的时候会红"，证明不了"该显示的时候真的显示"。
 *
 * ⚠️ 它只改这两个**"摆不摆入口"的槽位**，一个数据字段都不碰
 *    （`classes` / `assignments` / `examScores` 全不动）——
 *    也就是说它连"多看到一行数据"都做不到：RLS 在服务端，钩子够不着。
 * ⚠️ 解析在 `lib/roles.ts` 的 `devInjectedRoles()` / `devInjectedAccountKind()` 里，
 *    两处都写着 `if (!(import.meta.env.DEV && search)) return null` ——
 *    `vite build` 把 `import.meta.env.DEV` 折成 `false`，整块被摇掉，
 *    所以**生产构建里 `?as=` / `?kind=` 一眼都看不到**（`nav-checks.mjs` 的 D7 读 dist 核对）。
 * ⚠️ 时机：在远程模式下 `hydrate()` 是异步的，它 `set({ myRoles, accountKind })`
 *    会把注入**盖掉** → 所以这里订一个 store 监听，**只要与注入值不一致就再写一次**。
 *    写成"无条件写"会自激（listener 又触发 listener）；写成只跑一次会在远程模式下失效。
 */
function useDevInjection() {
  const search = typeof location === 'undefined' ? '' : location.search
  useLayoutEffect(() => {
    if (!search) return
    const roles: TeacherRole[] | null = devInjectedRoles(search)
    const kind = devInjectedAccountKind(search)
    if (!roles && !kind) return
    const apply = () => {
      const s = useStore.getState()
      const patch: { myRoles?: TeacherRole[]; accountKind?: 'classroom' } = {}
      if (roles && JSON.stringify(s.myRoles) !== JSON.stringify(roles)) patch.myRoles = roles
      if (kind && s.accountKind !== kind) patch.accountKind = kind
      if (Object.keys(patch).length) useStore.setState(patch)
    }
    // 先同步打一次（`useLayoutEffect` 在浏览器绘制**之前**跑完，所以演示模式下
    // 首帧就是对的角色 —— 不会出现"导航先渲染成任课老师、下一帧才变"的抖动）
    apply()
    return useStore.subscribe(apply)
  }, [search])
}

export default function App() {
  useAuthBootstrap()
  useDevInjection()
  return (
    <BrowserRouter>
      <ToastHost />
      <SyncErrorBanner />
      <Routes>
        <Route path="/login" element={<Login />} />
        {/*
          超管运维面板（`超管运维面板方案.md` 第一期）。

          🔴 **它刻意不套 `Guard`，也不套 `AppShell`** —— 这是方案 §七 T6 那条设计决定：
          `Guard` 会把"被标成教室端的设备"一律送去 `/login`（见上面那一段），
          而 `/settings`（面板入口所在页）**也在 `Guard` 里**。
          → 超管这台机器被标成教室端时，他连面板都进不去，
            而面板恰恰是用来救这种情况的（§九 W22 就是这个状态）。
          → 还有第二半：`hydrate()` 失败时用户也会被踢去登录页，
            面板要能在"半坏状态"下打开，所以它**自己取数**（不依赖 `store` 的 hydrate 结果）。

          ⚠️ **"不套 Guard"不等于"不设防"**：
             · 面板自己检查 Supabase 会话（没会话就在**页面内**给一张登录卡，不跳转）；
             · 真正的权限判据在**服务端** —— `POST /api/admin/config-check` 拿调用者的
               JWT 去问数据库的 `is_super_admin()`，不是 `can_manage_teachers()`
               （那个含教导处，见方案 §5.5 T7）。前端只是"摆不摆入口"。
        */}
        <Route path="/admin" element={<Admin />} />
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
        {/*
          考试（功能设计与不变量.md §十四）。**独立的一条 /exams 路由族**，不挂在 /assignments 下面：
          考试与作业是两套数据模型（作业默认全对、考试默认全零），路径混在一起最容易被人"顺手统一"。
          入口在作业列表页的右上角，以及考试列表自己的返回按钮。
        */}
        <Route
          path="/exams"
          element={
            <Guard>
              <Exams />
            </Guard>
          }
        />
        <Route
          path="/exams/new"
          element={
            <Guard>
              <ExamNew />
            </Guard>
          }
        />
        <Route
          path="/exams/:id/grade"
          element={
            <Guard>
              <ExamGrade />
            </Guard>
          }
        />
        <Route
          path="/exams/:id/stats"
          element={
            <Guard>
              <ExamStats />
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
          入口在「我的 → 教师账号」，**只有最高管理员和教导处看得见那个入口**；
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
        {/*
          🆕 通知（`管理架构与角色权限方案.md` §九.7）。两条路由：
            · `/notices`     —— 老师的收件箱（**所有老师**都有；教室端到不了这里）
            · `/notices/new` —— 发通知（只有能发的那八档看得见入口，服务端仍会 403 兜底）
          ⚠️ 刻意**不套任何额外守卫**：手打 URL 进得来，然后
            · `/notices` 由**数据库 RLS** 筛（范围外的通知读不到 —— I46/I47）；
            · `/notices/new` 在服务端拿调用者 JWT 问 `can_publish_notice_to()`（I46）。
          "藏入口"不是安全边界，这里也不假装它是。
          🔴 教室端**读不到通知**：那是 `Guard` 上面那句 `accountKind === 'classroom'`
            一条管全部（与它那 34 个 B 同款），加上数据库读策略里**根本没有教室端的分支**（I47）。
            两处是同一条边界，不是两道 —— 别在这里再写第三道。
        */}
        <Route
          path="/notices"
          element={
            <Guard>
              <Notices />
            </Guard>
          }
        />
        <Route
          path="/notices/new"
          element={
            <Guard>
              <NoticeNew />
            </Guard>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
