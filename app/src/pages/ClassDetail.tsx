import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconEye,
  IconHash,
  IconInfo,
  IconMegaphone,
  IconPaste,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSwap,
  IconUsers,
  IconX,
} from '../components/icons'
import { ScheduleBatch } from '../components/ScheduleBatch'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import {
  STUDENT_STATUS_NAME,
  WEEKDAY_TEXT,
  type ScheduleItem,
  type Student,
  type StudentStatus,
} from '../data/types'
import { compareStudentNo, rosterStateOf } from '../lib/roster'
import { CALL_LIMIT, CUSTOM_MAX, composeCallText } from '../lib/calls'
import { archiveKeyOf } from '../lib/keys'
import { classKindOf } from '../lib/pick'
import { PERIOD_SLOTS, splitLessonTitle } from '../lib/scheduleParse'
import { checkScheduleConflicts } from '../lib/schedule'
import { canEditClassFor } from '../lib/roles'
import { SUBJECTS, subjectCodeOfName, subjectName } from '../lib/subjects'
import {
  PROFILE_FIELDS,
  emptyProfile,
  loadStudentProfiles,
  profileFilled,
  saveStudentProfile,
  type StudentProfile,
} from '../lib/studentProfile'
import {
  apiOldSubjectPreview,
  apiPurgeOldSubjectData,
  apiClassCallable,
  type CanCallState,
  type OldSubjectCounts,
} from '../lib/gradeSetup'
import { isRemote } from '../lib/supabase'
import { beijingNow, weekdayOfISO, ymdOf } from '../lib/holiday'
import { isoOffset } from '../lib/date'
import { dutyPool } from '../lib/duty'
import {
  dutyOn,
  dutyPreview,
  loadDailyBundle,
  setClassRepPin,
  setDutyAssignment,
  toDutyInput,
  type DailyBundle,
} from '../lib/daily'
import {
  PASSWORD_SHOWN_ONCE,
  apiClassroomAccountStatus,
  apiCreateClassroomAccount,
  apiResetClassroomPassword,
  apiSetClassroomDisabled,
  apiSetClassroomPassword,
  classroomAccountMessage,
  readAccount,
  readHasAccount,
  type ClassroomAccount,
} from '../lib/classroomAccount'
import * as remote from '../data/remote'
import { listTeachers } from '../lib/accounts'

/** 一条选科快照 → 人话（`物化生`）；空快照 = "还没采过" */
function comboText(snap: Record<string, unknown> | undefined): string {
  const primary = String(snap?.primary ?? '')
  const raw = snap?.second
  const second = Array.isArray(raw) ? raw.map(String) : []
  const parts = [primary, ...second].filter(Boolean)
  if (!parts.length) return '还没采过'
  return parts.map((c) => subjectName(c, c)).join('')
}

/**
 * 读一次某个班的教室端账号（**只回账号，不回密码**）。
 *
 * 为什么是**模块级**函数、而不是组件里的 `useCallback`：
 *   `useCallback` 那一版会被 `react-hooks(exhaustive-deps)` 记成"每次渲染都变"，
 *   而把这几个 setState 直接写进 `useEffect` 体里又会被 `react(set-state-in-effect)` 记一笔
 *   （两者本轮都实测报过）。挪到模块级之后：**请求在模块里、状态在 effect 的 `then` 里**，
 *   两条 lint 都干净，读起来也更直（这一页已有的 `loadStudentProfiles` 就是这个形状）。
 *
 * 🔴 走 `postApi`（它把当前会话的 JWT 放进去）—— 自己写 `fetch` 就会漏带令牌，
 *    服务端回 401，而页面会把"没带令牌"显示成"你没权限"（`lib/gradeSetup.ts` 记过这个坑）。
 * ⚠️ 读不到**不是"没有账号"**：两件事必须分开说（`readHasAccount` 回 `null` = 没结论）。
 */
async function fetchRoomAccount(
  classId: string,
): Promise<{ verdict: 'found'; account: ClassroomAccount | null } | { verdict: 'unknown'; message: string }> {
  const r = await apiClassroomAccountStatus(classId)
  const has = readHasAccount(r)
  if (has === null) {
    return { verdict: 'unknown', message: classroomAccountMessage(r, '读不到这个班的教室端账号。') }
  }
  return { verdict: 'found', account: has ? readAccount(r) : null }
}

export default function ClassDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const klass = useStore((s) => s.classes.find((c) => c.id === id))
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const updateStudent = useStore((s) => s.updateStudent)
  const sendCall = useStore((s) => s.sendCall)
  /*
   * 「从班级管理里直接呼叫学生」—— 摆不摆这个入口。
   *
   * 🔴 **摆不摆由服务端回的那一个布尔说了算**（`canCall`，`/api/grade-setup` 的
   *    `classCallable`）—— 前端**不自己推断角色**。形状与通知的「撤下」那个
   *    `canRevoke`（`functions/api/notice.ts` → `lib/notices.ts`）**一模一样**。
   *    服务端那一支的判据就是数据库的 `can_call(class_id, null)`，即
   *    `can_call_for()` 的"**事务性呼叫**"那一支 = `can_manage_class_for()`
   *    （超管 / 教务处 ∪ 本年级年级主任 ∪ **本班班主任** ∪ 行政班），见 `schema.sql` §33.2。
   *    ⚠️ 刻意**不掺**"有作业的呼叫"那一支（那条还额外给科任老师，是另一档权力）。
   *
   * ⚠️ 2026-10-09 修的就是这里：原来前端写的是 `hasManagingRole(myRoles)`
   *    —— 那是**粗档**（super / admin / 年级主任，**不含班主任**）→
   *    **本班班主任服务端允许、界面上却不摆按钮**。这是"服务端允许、前端没摆"
   *    这一类 bug 的**第三次**（前两次：开学准备页、通知的「撤下」）。
   * ⚠️ 读不到（断网 / 第 33 段没跑）时**不摆** —— 读不到 ≠ 没权限，
   *    所以结论里带着一句 `notice`（`readCanCall()` 分档），不把"没结论"说成"没权限"。
   */
  const [callAuth, setCallAuth] = useState<CanCallState | null>(null)
  /** 这份结论是**哪一个班**的（`''` = 还没读到任何结论；换班时两者不等 → 不摆） */
  const [callAuthFor, setCallAuthFor] = useState('')
  useEffect(() => {
    if (!id) return
    let alive = true
    void apiClassCallable(id).then((s) => {
      if (!alive) return
      setCallAuth(s)
      setCallAuthFor(id)
    })
    return () => {
      alive = false
    }
  }, [id])
  const canCall = callAuthFor !== '' && callAuthFor === id && callAuth?.canCall === true
  const myRoles = useStore((s) => s.myRoles)

  /** 自由播报 / 呼叫学生：教师自己输要念的话，不针对某次作业 */
  const [callOpen, setCallOpen] = useState(false)
  const [callText, setCallText] = useState('')
  /** 被叫学生（`students.id`）；**事务性呼叫**可以不选人（整班播报） */
  const [callPicked, setCallPicked] = useState<string[]>([])
  const removeStudent = useStore((s) => s.removeStudent)
  const transferStudent = useStore((s) => s.transferStudent)
  const addStudents = useStore((s) => s.addStudents)

  /* ---- 🆕 P10：选科变更记录 + 旧科目数据的删除（班主任确认那一层）----
     记录本身**只读**（前端一个字都不许写这张表：`student_subject_changes` 只有 select 策略）；
     删除走服务端（那两个函数是 `_for` 变体，一律 revoke）。 */
  const [changes, setChanges] = useState<remote.StudentSubjectChange[] | null>(null)
  const [changesErr, setChangesErr] = useState('')
  const [purgeCounts, setPurgeCounts] = useState<OldSubjectCounts | null>(null)
  const [purgeErr, setPurgeErr] = useState('')
  const [purgeBusy, setPurgeBusy] = useState(false)

  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<{ studentNo: string; name: string; status: StudentStatus }>({
    studentNo: '',
    name: '',
    status: 'active',
  })
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({ studentNo: '', name: '' })

  /* ---- 🆕 学生档案：民族 / 出生年月 / 家长电话 / 家庭住址 ----
     表在 `supabase/schema.sql` §2.1，策略在 §35。判据一律在数据库：
       · **看**（读得到哪些行）= `visible_class_ids()`（科任老师 = 自己任教的班）**且不是教室端**；
       · **改** = `can_manage_class()`（最高管理员 / 教务处 ∪ 本年级年级主任 ∪ 本班班主任）。
     这里只做两件事：**摆不摆"修改"入口**、**读不到时说出来**（不许说成"没录过"）。 */
  const [profiles, setProfiles] = useState<Map<string, StudentProfile>>(new Map())
  const [profilesErr, setProfilesErr] = useState('')
  const [profileFor, setProfileFor] = useState<string | null>(null)
  const [profileEdit, setProfileEdit] = useState(false)
  const [profileForm, setProfileForm] = useState<StudentProfile>(emptyProfile(''))
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileSaveErr, setProfileSaveErr] = useState('')

  /*
   * 🔴 **"这一个班归不归我管"只算一次**（`canEditClassFor` = 数据库 `can_manage_class_for()` 的前端影子：
   *    超管 / 教务处 ∪ 本年级年级主任 ∪ 本班班主任）。
   *    它管两处入口：**学生档案那个块**（教室端账号那块在上面已经读过了）——
   *    各写一份就是"同一件事两个入口"（本项目最忌的那个形状）。
   * ⚠️ **这只是"摆不摆入口"**：真正那一刀在数据库 / 服务端（`mayManage()`），前端藏了也拦不住手打接口的人。
   * ⚠️ 它必须在下面那个 `if (!klass)` **之前**定义（那之前已有两处 effect 依赖它）。
   */
  const canManageThis = canEditClassFor(myRoles, klass?.id ?? '', klass?.gradeId)

  /* ---- 🆕 教室端账号（`classroom_accounts`）：账号 + 重置密码 ----
     一个班一个账号，登录名是 `g2-4@shugao.local` 那种短名，挂在教室里那台大屏上。
     · **摆不摆**这个块 = `canManageThis`（与"改学生档案"同一个粗档）；**看不看得见**与
       "重不重置得动"由服务端拿调用者 JWT 问数据库（`mayManage()`）说了算。
     · 🔴 **这里给不出原密码**：Supabase 里密码是哈希存的，谁也算不回原文 ——
       要密码就点「重置密码」，新密码当场显示一次（`PASSWORD_SHOWN_ONCE`）。 */
  const [roomAccount, setRoomAccount] = useState<ClassroomAccount | null>(null)
  /**
   * 这份账号结论是**哪一个班**的（`''` = 还没读到任何结论）。
   * 🔴 它回答的是"屏上这份数据是不是当前这个班的" —— 换班 / 按了「重试」时两者不相等，
   *    界面就写"正在读…"，**不会把上一个班的账号当成这个班的**。
   */
  const [roomAccountFor, setRoomAccountFor] = useState('')
  const [roomErr, setRoomErr] = useState('')
  /** 刚生成的那一串（**只有这一回合有**，重进这一页就没有了） */
  const [roomPwd, setRoomPwd] = useState('')
  const [roomBusy, setRoomBusy] = useState(false)
  /** 换密码那张浮层（**两条路二选一**：随机重置 ／ 自己设置） */
  const [roomConfirmResetOpen, setRoomConfirmResetOpen] = useState(false)
  /**
   * 🆕 浮层里切到「自己设置」那一档（`false` = 先给两条路选）。
   * 口令规则（6–12 位、字母和数字都要有）由**服务端**判 —— 这里只判"两次输入一不一样"。
   */
  const [roomSetForm, setRoomSetForm] = useState(false)
  /** 自己设置那一路：新口令 / 再输一遍 */
  const [roomPw1, setRoomPw1] = useState('')
  const [roomPw2, setRoomPw2] = useState('')
  /** 自己设置那一路失败的原因（**摆在浮层里**，不外抛） */
  const [roomSetErr, setRoomSetErr] = useState('')
  /** 新密码那一张浮层（关掉还能用「看新密码」再打开一次；**重进这一页就没有了**） */
  const [roomPwdOpen, setRoomPwdOpen] = useState(false)
  /** 「为什么看不到原密码」那一页（块右上角那个 ⓘ） */
  const [roomInfo, setRoomInfo] = useState(false)
  /** 换了一个班就重读一次（底下的 `loadRoom` 依赖它） */
  const [roomTick, setRoomTick] = useState(0)
  /** 走班班「移出一个人」那一张轻确认浮层：要移出的是谁 / 正在写 / 失败原因 */
  const [leaveWho, setLeaveWho] = useState<Student | null>(null)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveErr, setLeaveErr] = useState('')
  /* 🔴 这个班**是不是走班班**：一处判定，下面全靠它（`classKindOf` 是唯一入口）。 */
  const isStream = classKindOf(klass) === 'stream'
  /*
   * 走班班的成员（`class_members`，多对多）—— 在下面那个 effect 里读。
   * 声明在这儿是因为**屏上那一份名单**（`roster`）在 `if (!klass)` 之前就要用。
   */
  const [members, setMembers] = useState<Student[]>([])
  /*
   * 屏上那一份名单 = **这一页唯一的名单**：
   *   · 行政班 → `klass.students`（`students.class_id`）；
   *   · 走班班 → `members`（`class_members`，多对多，在下面那个 effect 里读）。
   * 搜索 / 人数 / 档案 / 行内操作**全部从它算** —— 哪一处单独回去读 `klass.students`，
   * 在走班班上就查不到人（2026-10-09 行内那颗铅笔点了没反应，根因就是它）。
   */
  const classStudents = klass?.students
  const roster = useMemo(
    () => (isStream ? members : (classStudents ?? [])),
    [isStream, members, classStudents],
  )
  /** 名单里那些 id（拼成串当依赖：学生一增一删就要重读一次） */
  const profileIds = roster.map((s) => s.id).join(',')
  /** 教室端账号那一块的班 id（`''` = 班还没读出来；换班时它变 → 下面那个 effect 重读） */
  const roomId = klass?.id ?? ''

  useEffect(() => {
    if (!klass) return
    let alive = true
    /* 🔴 "读哪些人" = **上面那一份名单**（`profileIds`：行政班 = `klass.students`、
       走班班 = `class_members` 来的 `members`）。这里若回去读 `klass.students`，
       走班班学生的档案就永远读成"未录入" —— 与那颗铅笔同一个根因的另一半。 */
    void loadStudentProfiles(profileIds ? profileIds.split(',') : []).then((r) => {
      if (!alive) return
      if (r.ok) {
        setProfiles(r.profiles)
        setProfilesErr('')
        return
      }
      // 🔴 读不到 ≠ 没录过：清空缓存 + 显式留一句话
      setProfiles(new Map())
      setProfilesErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [klass, profileIds])

  /*
   * 教室端账号那一块：进这一页先问一次"这个班有没有账号"（只回账号，不回密码）。
   * `canManageThis` 已经算过了（见上面那一处）—— 这里不再算第二遍。
   * ⚠️ 真正的闸门不在这里：服务端会拿 JWT 再问一次数据库（`mayManage()`）。
   */
  useEffect(() => {
    if (!canManageThis || !isRemote || !roomId) return
    let alive = true
    void fetchRoomAccount(roomId).then((r) => {
      /* ⚠️ 这些 setState **只在 `then` 里调**（不在 effect 体里同步调）：
         effect 体里同步 setState 会让 React 多渲染一轮 —— oxlint 的
         `react(set-state-in-effect)` 会当场报出来。所以"正在读"这件事**推导出来**，
         不靠 effect 体里那句 `setRoomLoaded(false)`：
         `roomAccountFor` 只在读到结论时才写上班级 id，两者不等就是"还没读到"。 */
      if (!alive) return
      setRoomAccountFor(roomId)
      if (r.verdict === 'unknown') {
        setRoomAccount(null)
        setRoomErr(r.message)
      } else {
        setRoomErr('')
        setRoomAccount(r.account)
      }
      setRoomPwd('')
      setRoomConfirmResetOpen(false)
      setRoomPwdOpen(false)
    })
    return () => {
      alive = false
    }
    /* `roomTick` 只用来让「重试」能再打一次（不靠任何函数身份变化），所以它必须进依赖 */
  }, [canManageThis, roomId, roomTick])

  /** 读到结论之前（或刚按了「重试」）—— 屏上写"正在读…"，**不写成"没有账号"** */
  const roomReading = roomAccountFor !== roomId && !roomErr

  /*
   * 🔴 走班班的名单从 `class_members`（多对多）读，**不是** `klass.students`。
   *
   * 原来这一页对走班班也算 `analyzeRoster(klass.students ?? [])`，而走班班的人
   * **永远不在 `students.class_id` 上**（§27.5）→ 恒为「0 人」，
   * 而 0 人又恰好"没有缺号、没有重号" → 体检写「学号 1–0 连续无缺号」、写「名单完整」。
   * 同一份数据在「开学准备 ⑥」说 2 人、在这一页说 0 人 —— 两个页面自相矛盾。
   */
  const [membersKnown, setMembersKnown] = useState(true)
  const [membersErr, setMembersErr] = useState('')
  useEffect(() => {
    if (!id || !isStream) return
    let alive = true
    void remote.loadClassMembersFull([id]).then((r) => {
      if (!alive) return
      setMembersKnown(r.known)
      setMembersErr(r.known ? '' : '读不到这个走班班的成员。数据库可能还没跑 supabase/schema.sql 第 27 段（走班班成员那一张表）。')
      const list = r.by[id] ?? []
      setMembers(
        list.map((p, i) => ({
          id: p.id,
          name: p.name,
          studentNo: p.studentNo,
          status: p.status,
          createdAt: i,
        })),
      )
    })
    return () => {
      alive = false
    }
  }, [id, isStream])

  /**
   * 名单这件事的**四态**（读不到 / 还没有名单 / 完整 / 待核对）。
   * 🔴 判据只有一处：`lib/roster.ts` 的 `rosterStateOf()` —— 这一页不许自己写 `count === 0`。
   *    走班班那一支传 `members`（`class_members` 来的），行政班那一支传 `klass.students`。
   */
  const rosterState = useMemo(
    () =>
      isStream
        ? rosterStateOf(members, 'members', membersKnown)
        : rosterStateOf(klass?.students ?? [], 'class'),
    [isStream, members, membersKnown, klass],
  )
  const health = rosterState.health

  /*
   * 🆕 走班班的**老师**（`class_subjects`，§32.3 里 `assign_stream_teacher()` 补的那几行）。
   *
   * 🔴 为什么这一页也要读它：老师在「开学准备 ⑥」选完，**刷新之后没有任何地方看得到**
   *    —— 而"分配了没落库"与"落库了没读出来"在界面上长得一模一样。
   *    这一块就是那个**读**的那一侧（写的那一侧在 §32.3，两边同一张表 `class_subjects`）。
   * ⚠️ 读不到 ≠ 没分配：`state: 'unknown'` 写"没读到"，不写"还没分配"。
   */
  const [teacherName, setTeacherName] = useState('')
  const [teacherUnknown, setTeacherUnknown] = useState(false)
  /*
   * 🔴 2026-10-14 新增：**名字读不到**（≠ 读不到任教关系、更 ≠ 还没分配）。
   *
   * 为什么要有这一位（这一轮的安全收紧，`supabase/schema.sql` §44「超管隐身」）：
   *   上面那一行老师名是从 `listTeachers()`（`/api/teacher-account` 的 `list`）里认的，
   *   而那个接口**只有能建号的那三档**（超管 / 教务处 / 办公室主任）进得去 ——
   *   普通教师 / 班主任 / 年级主任调它拿的是 **403**（判据 = `can_create_teacher_accounts()`）。
   *   也就是说：**绝大多数读者在这一页上永远认不出这位老师的名字**（这不是坏掉，是权限）。
   *
   *   ⚠️ 旧写法是 `setTeacherName(t?.name ?? tid)` —— 认不出时**把 UUID 打到屏上**
   *      （当时的顾虑是"空白会被读成没分配"）。但 UUID 是**账号的身份信息**，
   *      比空白更不能出现；而且这一位还会被当作 `authorName` 写进值日记录（见 `saveDuty`）。
   *   ⇒ 认不出就**不印身份、也不写库**：屏上用中性标签「任课老师」（见下面那一处），
   *     库里那一列留空（值日记录本来就不要求作者名）。
   */
  const [teacherNameHidden, setTeacherNameHidden] = useState(false)
  useEffect(() => {
    if (!id || !isStream) return
    let alive = true
    void (async () => {
      const rows = await remote.loadClassSubjects([id])
      if (!alive) return
      if (rows === null) {
        setTeacherUnknown(true)
        return
      }
      setTeacherUnknown(false)
      if (!rows.length) {
        setTeacherName('')
        setTeacherNameHidden(false)
        return
      }
      const tid = rows[0].teacherId
      const r = await listTeachers()
      if (!alive) return
      const t = r.ok ? r.data.teachers.find((x) => x.id === tid) : undefined
      /*
       * 🔴 认不出名字就不印任何身份：**不印 UUID**（`r.ok === false` 时那个 id 正是 UUID，
       *    §44 之后普通教师 / 班主任 / 年级主任在这条路上**必然**认不出名字）。
       *    屏上由 `teacherNameHidden` 那一支说"任课老师"（中性标签，见下面渲染处）。
       * ⚠️ 走班班**没定老师**（`teacherId` 为空）与**认不出是谁**是两件事，分开：
       *    前者照旧"还没分配"，后者说"一位任课老师"。空白会被读成"没分配"，
       *    所以这里必须给一个**非空的中性词**，不能什么都不说。
       */
      const known = t?.name?.trim() ? t.name : ''
      setTeacherName(known)
      setTeacherNameHidden(known === '')
    })()
    return () => {
      alive = false
    }
  }, [id, isStream])

  /* ============================================================
     🆕 班务：值日生轮值 + 课代表口令（`supabase/schema.sql` §40）
     ------------------------------------------------------------
     口径（用户 2026-10-02 / 10-03）：
       · 值日生**每天一人**，池子 = 本班在读学生、按**学号升序**，只在上课日轮；
       · 班主任可以**指定某一天**是谁，从那天起接着往下轮（锚点 = `duty_assignments` 一行）；
       · 轮值算法**只有一处**（`app/src/lib/duty.ts` 的纯函数）——
         教室里那块大屏的下课提醒、这里的预览、导出的作业图，读的都是同一份；
       · 课代表口令由班主任设，库存 `sha256('<班 id>:<口令>')`；`class_rep_pins`
         **对客户端零权限**（写只走 `set_class_rep_pin()`，校验只走 RPC）。
     🔴 摆不摆这一块 = `canManageThis`（`can_manage_class_for()` 的前端影子，
        与上面「教室端账号」同一档）：科任老师看不到。真正那一刀在数据库里。
     ============================================================ */
  const [daily, setDaily] = useState<DailyBundle | null>(null)
  const [dutyDate, setDutyDate] = useState(() => ymdOf(beijingNow()))
  const [dutyPick, setDutyPick] = useState('')
  const [dutyBusy, setDutyBusy] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [pinMsg, setPinMsg] = useState('')
  const [dailyTick, setDailyTick] = useState(0)

  /*
   * 往前 30 天（看得到最近指定过谁）+ 往后 60 天（够预览这一轮的走向）。
   * 读不到就**当没有**、由界面自己说出来，不假装"没人指定过"。
   */
  useEffect(() => {
    if (!id) return
    let alive = true
    loadDailyBundle(id, isoOffset(-30), isoOffset(60))
      .then((b) => {
        if (alive) setDaily(b)
      })
      .catch(() => {
        if (alive) setDaily(null)
      })
    return () => {
      alive = false
    }
  }, [id, dailyTick])

  const dutyInput = useMemo(
    () =>
      klass
        ? toDutyInput({
            students: roster,
            anchors: daily?.anchors ?? [],
            calendar: daily?.calendar ?? [],
            classCreatedAt: klass.createdAt,
          })
        : null,
    [klass, roster, daily],
  )
  const dutyDay = dutyInput ? dutyOn(dutyDate, dutyInput) : null
  const dutyNext = useMemo(
    () => (dutyInput ? dutyPreview(ymdOf(beijingNow()), 14, dutyInput) : []),
    [dutyInput],
  )
  const dutyCandidates = useMemo(() => dutyPool(roster), [roster])

  const saveDuty = async () => {
    if (!klass || !dutyPick) return
    setDutyBusy(true)
    const r = await setDutyAssignment({
      classId: klass.id,
      onDate: dutyDate,
      studentId: dutyPick,
      /* ⚠️ 认不出名字时**不写这一列**（见上面 `teacherNameHidden` 那段注释：它以前会被写成 UUID） */
      authorName: teacherName || undefined,
    })
    setDutyBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad' })
      return
    }
    push({ text: `已定：${dutyDate} 的值日生`, tone: 'ok' })
    setDailyTick((t) => t + 1)
  }

  const savePin = async () => {
    if (!klass) return
    setPinBusy(true)
    const r = await setClassRepPin(klass.id, pinInput.trim())
    setPinBusy(false)
    setPinMsg(r.ok ? '已设定。原文谁也看不到，忘了就重设一个。' : r.message)
    if (r.ok) {
      push({ text: '课代表口令已设定', tone: 'ok' })
      setPinInput('')
    }
  }

  /* ============================================================
     🆕 本班课表（用户口径 ⑨：**班主任在班级管理处调本班课表**）
     ------------------------------------------------------------
     背景（2026-10-03 核实，写给后来的人）：
       · 数据库本来就允许班主任改本班课表 —— `schedule_items` 的
         `schedule_class_write` = `scope='class' and can_manage_class(class_id)`，
         而 `can_manage_class_for()` 含 head_teacher 本班那一支；
       · 但**能改课表的界面**只有「课程管理」（`/manage/course`），
         那一页的入口判据是另一条更窄的 `can_manage_schedule()`
         （超管 / 教务处 / 年级主任本年级，**故意不含班主任**，见 `schema.sql` §38.0）——
         所以班主任在这之前**没有任何界面**能调本班课表。
       · 这一块就是那条路：写的是 `scope='class'` 的行（教室端大屏读它），
         判据用 `canManageThis`（`can_manage_class_for()` 的前端影子），
         真正那一刀仍在数据库（RLS 挡）。
     🔴 口径分界：这里改的是「**以后每周都生效**」的课表；
        只改某一天走课程管理页的**临时调课**（`schedule_temp_changes`），是另一条路。
     ============================================================ */
  const schedule = useStore((s) => s.schedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const updateSchedule = useStore((s) => s.updateSchedule)
  const removeSchedule = useStore((s) => s.removeSchedule)

  const classRows = useMemo(
    () => (klass ? schedule.filter((s) => s.scope === 'class' && s.classId === klass.id) : []),
    [schedule, klass],
  )

  /**
   * 这张网格的**行**＝这一周真正出现过的时段 ∪ 平台标准节次 ——
   * 演示数据的时间点与 `PERIOD_SLOTS` 只有第 1 节碰得上（这是 2026-10 排课那轮的既有事实），
   * 所以不能只按标准节次画，否则库里那几节会**整行看不见**。
   */
  const weekSlots = useMemo(() => {
    const seen = new Map<string, [string, string]>()
    for (const [a, b] of PERIOD_SLOTS) seen.set(a, [a, b])
    for (const r of classRows) if (!seen.has(r.start)) seen.set(r.start, [r.start, r.end])
    return [...seen.values()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
  }, [classRows])

  /** 列＝周一至周五；周六周日**只在真有课时**才多一列（不摆空列） */
  const weekDays = useMemo(() => {
    const ds = [1, 2, 3, 4, 5]
    for (const r of classRows) if (r.weekday >= 6 && !ds.includes(r.weekday)) ds.push(r.weekday)
    return ds.sort((a, b) => a - b)
  }, [classRows])

  const cellRows = (wd: number, start: string) =>
    classRows.filter((r) => r.weekday === wd && r.start === start)

  /** 本班各科的任课老师（编辑那一格时挑老师用）—— 认不出名字时**不把 id 打到屏上** */
  const [classTeachers, setClassTeachers] = useState<{ id: string; name: string; subjectCode: string }[]>([])
  useEffect(() => {
    if (!canManageThis || !id) return
    let alive = true
    void (async () => {
      const [rows, t] = await Promise.all([remote.loadClassSubjects([id]), listTeachers()])
      if (!alive) return
      const nameOf = new Map((t.ok ? t.data.teachers : []).map((x) => [x.id, x.name]))
      setClassTeachers(
        (rows ?? []).map((r) => ({
          id: r.teacherId,
          name: nameOf.get(r.teacherId) ?? '（认不出名字）',
          subjectCode: r.subjectCode,
        })),
      )
    })()
    return () => {
      alive = false
    }
  }, [canManageThis, id])

  const [lessonCell, setLessonCell] = useState<{ wd: number; start: string; end: string } | null>(null)
  const [lessonSubject, setLessonSubject] = useState('')
  const [lessonTeacher, setLessonTeacher] = useState('')
  const [lessonBusy, setLessonBusy] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)

  /** 点一格：把那一格已有那节填进编辑面板（空着就是新加） */
  const openCell = (wd: number, start: string, end: string, rows: ScheduleItem[]) => {
    setLessonCell({ wd, start, end })
    setLessonSubject(subjectCodeOfName(splitLessonTitle(rows[0]?.title ?? '').subject) ?? '')
    setLessonTeacher(rows[0]?.teacherId ?? '')
  }

  /**
   * 走班冲突校验 —— 与单条录入、教室端粘贴**同一个** `checkScheduleConflicts`
   * （这节课会落到哪个走班班，只有那一处算得对）。
   */
  const guardConflicts = async (items: Omit<ScheduleItem, 'id'>[]): Promise<boolean> => {
    const gate = await checkScheduleConflicts(
      { items: items.map((x, i) => ({ ...x, id: `pending-${i}` })), schedule, classes },
      { loadMembers: remote.loadClassMembers, loadSubjects: remote.loadClassSubjects },
    )
    if (gate.blocked) {
      push({ text: '这份课表和走班班撞了，没有保存', tone: 'bad', desc: gate.message })
      return false
    }
    return true
  }

  const saveLesson = async () => {
    if (!klass || !lessonCell || !lessonSubject) return
    const title = `${klass.name} ${subjectName(lessonSubject, lessonSubject)}`
    const teacherId = lessonTeacher || null
    const existing = cellRows(lessonCell.wd, lessonCell.start)
    setLessonBusy(true)
    if (existing.length) {
      /* 已经有这一节 → **改那一行**（科目与老师一起改，与课程管理页同一口径） */
      updateSchedule(existing[0].id, { title, teacherId })
      setLessonBusy(false)
      setLessonCell(null)
      push({ text: '这一节改了', tone: 'ok', desc: '以后每周都按新的上' })
      return
    }
    const item: Omit<ScheduleItem, 'id'> = {
      weekday: lessonCell.wd,
      start: lessonCell.start,
      end: lessonCell.end,
      title,
      classId: klass.id,
      room: '',
      kind: 'class',
      notify: true,
      scope: 'class',
      teacherId,
    }
    const ok = await guardConflicts([item])
    setLessonBusy(false)
    if (!ok) return
    addScheduleMany([item])
    setLessonCell(null)
    push({ text: '加了一节', tone: 'ok', desc: '以后每周都按新的上' })
  }

  const removeLesson = () => {
    if (!lessonCell) return
    const existing = cellRows(lessonCell.wd, lessonCell.start)
    if (!existing.length) return
    removeSchedule(existing[0].id)
    setLessonCell(null)
    push({ text: '这一节去掉了', tone: 'ok' })
  }

  /* ============================================================
     🆕 某一天的**临时调课 / 停课**（2026-10-13 追加）。
     用户口径：**班主任也要能改某一天的课** —— 此前那个界面只有课程管理页有，
     而那一页的入口判据 `hasManagingRole()` **不含班主任**（＝他没有任何入口）。
     · 写的是 `schedule_temp_changes`（**只影响这一天**），每周那张表一个字不动。
     · 判据在数据库：§38.0b 的 `can_manage_temp_schedule()`（超管 / 教务处 /
       本年级年级主任 ∪ **本班班主任**）；前端只决定**摆不摆**这一块（`canManageThis`）——
       "是不是本班班主任"由数据库那一支自己验，前端**不新写角色数组**。
     · 读的是权威口径：`schedule_day_cells(p_date)`（临时层已经压好了）＋
       `schedule_conflicts_on(p_date)`（三类撞课只有那一份算法）。
     ⚠️ 演示模式没有数据库（`loadScheduleDay` 回 `'local'`）→ 这里用内存那两层自己拼，
        与课程管理页 `buildDayCells` 同一个口径。
     ============================================================ */
  const tempChanges = useStore((s) => s.tempScheduleChanges)
  const addTempScheduleChange = useStore((s) => s.addTempScheduleChange)
  const [adjOpen, setAdjOpen] = useState(false)
  const [adjDate, setAdjDate] = useState(() => ymdOf(beijingNow()))
  const [adjDay, setAdjDay] = useState<remote.ScheduleDayRead | null>(null)
  const [adjConf, setAdjConf] = useState<remote.ScheduleDayConflict[]>([])
  const [adjPick, setAdjPick] = useState('')
  const [adjSubject, setAdjSubject] = useState('')
  const [adjTeacher, setAdjTeacher] = useState('')
  const [adjBusy, setAdjBusy] = useState(false)
  const [adjTick, setAdjTick] = useState(0)

  useEffect(() => {
    if (!adjOpen || !canManageThis) return
    let alive = true
    void (async () => {
      const [d, c] = await Promise.all([
        remote.loadScheduleDay(adjDate),
        remote.loadScheduleConflicts(adjDate),
      ])
      if (!alive) return
      setAdjDay(d)
      setAdjConf(c.status === 'present' ? c.conflicts : [])
    })()
    return () => {
      alive = false
    }
  }, [adjOpen, adjDate, adjTick, canManageThis])

  const adjWeekday = weekdayOfISO(adjDate)

  /** 这一天这个班实际有哪些节（**读不到就是读不到**，不许拿每周课表冒充） */
  const adjCells = useMemo<remote.ScheduleDayCell[]>(() => {
    if (adjDay?.status === 'present') {
      return adjDay.cells
        .filter((c) => c.classId === klass?.id)
        .sort((a, b) => (a.start < b.start ? -1 : 1))
    }
    /* 数据库那一层读不到时（`missing` / `unknown`）**不摆任何格** ——
       "这一天排得开"与"没读到"是两件事（同 `loadScheduleDay` 的纪律） */
    if (adjDay && adjDay.status !== 'local') return []
    const base0 = classRows.filter((r) => r.weekday === adjWeekday)
    /* ⚠️ **只在演示模式**：班级课表那一份夹具挂在这些行上、但 `scope` 空着
       （全平台按 `'mine'` 读）—— 一行都没有时退回"挂在这个班名下的那些行"，
       否则演示里这一页永远说"这一天这个班没有课"（与课程管理页 `classRows()` 自相矛盾）。
       真实模式只认 `scope='class'`。 */
    const base =
      base0.length || isRemote
        ? base0
        : schedule.filter((s) => s.classId === klass?.id && s.weekday === adjWeekday)
    const mine = tempChanges.filter((t) => t.date === adjDate && t.classId === klass?.id)
    /* 后写的压先写的（同一节改第二次就是后写的那条说了算） */
    const at = (start: string) => [...mine].reverse().find((t) => t.start === start)
    const out: remote.ScheduleDayCell[] = []
    for (const r of base) {
      const t = at(r.start)
      if (t && !t.toSubject) continue
      out.push({
        classId: r.classId ?? klass?.id ?? '',
        start: r.start,
        end: t?.end ?? r.end,
        subject: t ? t.toSubject : (splitLessonTitle(r.title).subject ?? ''),
        teacherId: t ? (t.toTeacherId ?? null) : (r.teacherId ?? null),
        changed: !!t,
      })
    }
    for (const t of mine) {
      if (!t.toSubject || out.some((c) => c.start === t.start)) continue
      out.push({
        classId: t.classId,
        start: t.start,
        end: t.end,
        subject: t.toSubject,
        teacherId: t.toTeacherId ?? null,
        changed: true,
      })
    }
    return out.sort((a, b) => (a.start < b.start ? -1 : 1))
  }, [adjDay, classRows, schedule, tempChanges, adjDate, adjWeekday, klass])

  const adjListable = adjDay === null || adjDay.status === 'present' || adjDay.status === 'local'
  const adjPicked = adjCells.find((c) => c.start === adjPick) ?? null
  const adjBaseRow =
    classRows.find((r) => r.weekday === adjWeekday && r.start === adjPick) ?? null
  /** 认不出名字就**不把 id 打到屏上**（同 `teacherOf` 那一条纪律） */
  const adjTeacherText = (tid: string | null) => {
    if (!tid) return '（没写老师）'
    return classTeachers.find((t) => t.id === tid)?.name ?? '（认不出名字）'
  }
  const adjStartConf = adjConf.filter(
    (c) =>
      c.start === adjPicked?.start &&
      (c.kind !== 'teacher' || c.teacherId === adjPicked?.teacherId || c.classId === klass?.id),
  )

  /**
   * 落一笔临时改动。
   * 🔴 库里那条 check（§38.1）：`kind='teacher'` **只许换老师、不许改科目** ——
   *    科目一动就得走 `'whole'`；停课与"恢复成每周课表那一节"也一律 `'whole'`。
   * 🔴 停课＝`to_subject` 空串 + `to_teacher_id` **`null`**（不许递空串，理由见 `remote.ts`）。
   */
  const submitAdj = async (mode: 'swap' | 'off' | 'restore') => {
    if (!klass || !adjPicked) return
    let toSubject = adjSubject ? subjectName(adjSubject, adjSubject) : ''
    let toTeacherId: string | null = adjTeacher || null
    if (mode === 'off') {
      toSubject = ''
      toTeacherId = null
    }
    if (mode === 'restore') {
      if (!adjBaseRow) return
      toSubject = splitLessonTitle(adjBaseRow.title).subject || ''
      toTeacherId = adjBaseRow.teacherId ?? null
    }
    const kind: 'teacher' | 'whole' =
      mode === 'swap' && toSubject && toSubject === adjPicked.subject ? 'teacher' : 'whole'
    setAdjBusy(true)
    const r = await remote.saveTempScheduleChange({
      onDate: adjDate,
      classId: klass.id,
      start: adjPicked.start,
      end: adjPicked.end,
      fromSubject: adjPicked.subject,
      fromTeacherId: adjPicked.teacherId,
      toSubject,
      toTeacherId,
      kind,
    })
    /* 演示模式（`!isRemote`）没有数据库 —— 同时把这一笔记进内存那一层，
       屏上才会真的变（与课程管理页 `applyPlan` 同一套） */
    if (!isRemote || r.ok) {
      addTempScheduleChange({
        date: adjDate,
        classId: klass.id,
        start: adjPicked.start,
        end: adjPicked.end,
        fromSubject: adjPicked.subject,
        fromTeacherId: adjPicked.teacherId,
        toSubject,
        toTeacherId,
        kind,
      })
    }
    setAdjBusy(false)
    if (!r.ok) {
      push({ text: '这一笔没写成', tone: 'bad', desc: r.message })
      return
    }
    setAdjPick('')
    setAdjTick((t) => t + 1)
    push({
      text: mode === 'off' ? '这一节今天不上了' : mode === 'restore' ? '恢复成每周课表那一节' : '这一节今天换过了',
      tone: 'ok',
      desc: `${adjDate} 只改这一天`,
    })
  }

  if (!klass) {
    return (
      <>
        <PageHead title="班级不存在" onBack={() => navigate('/classes')} />
        <Page>
          <Panel bodyClass="p-6 text-center" >
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>该班级可能已被删除</div>
          </Panel>
        </Page>
      </>
    )
  }

  /*
   * 屏上那一份名单 = **这一页唯一的名单**（`roster`，定义在上面 —— 它必须在
   * `if (!klass)` 之前，因为**学生档案那一次读**也要按它读）。
   * 下面的搜索 / 排序全部从它算 —— 两边各写一套就是第二个判定入口。
   */
  const list = roster
    .filter((s) => {
      if (!q.trim()) return true
      const k = q.trim()
      // 搜学号时**序列号也认**（老师手上可能是导出表里的那一列）
      return s.name.includes(k) || s.studentNo.includes(k) || (s.serial ?? '').includes(k)
    })
    /*
     * 名单顺序 = **班级内学号**升序（`compareStudentNo`，按数字排：10 排在 2 后面）。
     *
     * 🔴 用户 2026-09-26 拍板：**新增学生后要落进他该在的位置**，不许追加在末尾
     *    ——「新增了学生后也要按学号排序，不然全乱了」。
     *    这里按屏上显示的那一列（`studentNo`）排，而不是序列号：
     *    序列号是内部键、与班内学号不同序，按它排看起来就是乱的（44·32·38·5…）。
     *    找人的需求由上面的搜索框覆盖（它同时认班内学号与序列号）。
     */
    .sort(compareStudentNo)

  const openEdit = (sid: string) => {
    const s = klass.students.find((x) => x.id === sid)
    if (!s) return
    setEditing(sid)
    setForm({ studentNo: s.studentNo, name: s.name, status: s.status })
    /* 每次打开都重读一次（刚在开学准备页改过选科的，这里要立刻看得到） */
    setChanges(null)
    setChangesErr('')
    setPurgeCounts(null)
    setPurgeErr('')
    if (isRemote) void loadChanges(sid)
  }

  /**
   * 读这个学生的选科变更记录。
   * ⚠️ 读不到回 `null`（**"不知道"**），界面必须与"从没改过"分开说 ——
   *    写成空数组的话，"这张表还没建"会长得跟"他没改过选科"一模一样。
   */
  const loadChanges = async (sid: string) => {
    const rows = await remote.loadStudentSubjectChanges([sid])
    if (rows === null) {
      setChanges(null)
      setChangesErr(
        '读不到选科变更记录。数据库可能还没跑 supabase/schema.sql 第 34 段（选科变更审计那一张表）。',
      )
      return
    }
    setChangesErr('')
    setChanges(rows)
  }

  /** 正在编辑的那个学生 —— 编辑面板上要显示他的**序列号（只读）**
   *  ⚠️ 这颗铅笔**只在行政班里摆**（`!isStream`）：改姓名 / 学号 / 在班状态是
   *     **行政班**的事（`students.class_id`），走班班那一格摆的是「移出」。 */
  const editingStudent = roster.find((x) => x.id === editing)

  /* ---- 学生档案 ------------------------------------------------------------------
     ⚠️ "摆不摆修改入口"用的就是上面那一个 `canManageThis`（判据只有一处）——
        这里不再算第二遍，也不再另起一个名字。 */
  const profileStudent = roster.find((x) => x.id === profileFor)
  const shownProfile = profileFor ? (profiles.get(profileFor) ?? emptyProfile(profileFor)) : null

  const openProfile = (sid: string) => {
    setProfileFor(sid)
    setProfileEdit(false)
    setProfileSaveErr('')
    setProfileForm(profiles.get(sid) ?? emptyProfile(sid))
  }

  /* ---- 走班班：把一个人**移出这个走班班** ------------------------------------------
   *
   * 🔴 走班班那一格的语义定死在这里（2026-10-09 用户实测「铅笔点了没反应」之后拍的）：
   *   · 学生的**姓名 / 学号 / 档案**属于他的**行政班**（`students.class_id`）——
   *     在走班班的页面上改它不合理，所以那一格**不摆**"编辑学生"；
   *   · 走班班这一格该做的事是「**移出这个走班班**」（他不再上这门课），
   *     写的是 `class_members`（多对多）—— **碰都不碰 `students.class_id`**。
   *
   * ⚠️ **不新写写路径**：走的是走班班那一轮已有的 `saveStreamMembers()`
   *    （`schema.sql` §37.1 的 `write_stream_members()`，整份替换）。
   *    "移出一个人" = 集合减他一个，再整份写回去。
   * ⚠️ 摆不摆这个入口 = `canManageThis`（`can_manage_class_for` 的前端影子，与这一页
   *    别处**同一个判据**）；真正那一刀在函数里（`can_manage_class`），失败**显式报错**。
   * ⚠️ 读不到成员时（`membersKnown === false`）**不发这个请求**：`saveStreamMembers`
   *    是整份替换，拿一份"没读到"的空名单去写就是把全班清空。
   */
  const goOut = async () => {
    if (!klass || !leaveWho) return
    if (!membersKnown) {
      setLeaveErr('成员名单没读到，这时不能改（整份替换会把人清空）。刷新再来。')
      return
    }
    setLeaveBusy(true)
    setLeaveErr('')
    const next = members.filter((m) => m.id !== leaveWho.id).map((m) => m.id)
    const r = await remote.saveStreamMembers(klass.id, next)
    setLeaveBusy(false)
    if (!r.ok) {
      /* 🔴 失败**显式上屏**（被策略挡下是"0 行且不报错"，绝不能静默当"已移出"） */
      setLeaveErr(r.message)
      return
    }
    setMembers((prev) => prev.filter((m) => m.id !== leaveWho.id).sort(compareStudentNo))
    push({ text: `已把 ${leaveWho.name || leaveWho.studentNo} 移出`, tone: 'ok', desc: `现在 ${r.members} 人` })
    setLeaveWho(null)
  }

  const saveProfile = async () => {
    if (!profileFor) return
    setProfileSaving(true)
    setProfileSaveErr('')
    const next = { ...profileForm, studentId: profileFor }
    const r = await saveStudentProfile(next)
    setProfileSaving(false)
    if (!r.ok) {
      // 🔴 失败**显式报错**（被策略挡下是"0 行且不报错"，绝不能静默当"已保存"）
      setProfileSaveErr(r.message)
      return
    }
    setProfiles((m) => new Map(m).set(profileFor, next))
    setProfileEdit(false)
    push({ text: '已保存', tone: 'ok' })
  }

  /** 改档案里的一个字段（四个字段的 key 是联合字面量，这里收口成一处） */
  const setField = (k: (typeof PROFILE_FIELDS)[number]['key'], v: string) => {
    setProfileForm((p) => ({ ...p, [k]: v }) as StudentProfile)
  }

  /* ---- 教室端账号：建号 / 重置密码 / 停用（三个动作各一个函数，失败一律显式说出来）----
     🔴 三个都要"失败了有人知道"：成功了就重读一次（**以服务端回话为准，不本地拼**），
        失败了把服务端那句话原样摆出来（`classroomAccountMessage` 分档翻译）。 */

  const applyRoomResult = (r: { ok: boolean; status: number; data: Record<string, unknown> }): boolean => {
    if (!r.ok) {
      setRoomErr(classroomAccountMessage(r, '这次操作没成功。'))
      return false
    }
    const acc = readAccount(r)
    if (acc) setRoomAccount(acc)
    setRoomErr('')
    /* 成功了再问一次服务端（**库里的状态以它为准，不拿回话本地拼**） */
    void fetchRoomAccount(roomId).then((next) => {
      if (next.verdict === 'unknown') return
      setRoomAccount(next.account)
      setRoomAccountFor(roomId)
    })
    return true
  }

  /** 建号（一班一个；已经有就按"已经有"处理，不重复建） */
  const createRoomAccount = async () => {
    setRoomBusy(true)
    setRoomPwd('')
    const r = await apiCreateClassroomAccount(roomId)
    setRoomBusy(false)
    if (!applyRoomResult(r)) return
    setRoomPwd(readAccount(r)?.password ?? '')
    setRoomPwdOpen(true)
    push({ text: '教室端账号已建好', tone: 'ok' })
  }

  /**
   * 打开 / 关掉「设置新密码」那张浮层（**两条路二选一**：随机重置 ／ 自己设置）。
   * 关掉时把两条路上的临时输入清干净 —— 口令是明文，留在 state 里没必要。
   */
  const openRoomPw = () => {
    setRoomSetForm(false)
    setRoomSetErr('')
    setRoomPw1('')
    setRoomPw2('')
    setRoomConfirmResetOpen(true)
  }

  const closeRoomPw = () => {
    setRoomConfirmResetOpen(false)
    setRoomSetForm(false)
    setRoomSetErr('')
    setRoomPw1('')
    setRoomPw2('')
  }

  /**
   * 随机重置：**先把代价说清再动手**（旧密码立刻失效 —— 教室那台机器下次登录要用新的）。
   * 🔴 新密码只在这一回合的回话里，**再查一次也拿不到**（库里是哈希），所以浮层上写死那句话。
   */
  const resetRoomPassword = async () => {
    closeRoomPw()
    setRoomBusy(true)
    setRoomPwd('')
    const r = await apiResetClassroomPassword(roomId)
    setRoomBusy(false)
    if (!applyRoomResult(r)) return
    setRoomPwd(readAccount(r)?.password ?? '')
    setRoomPwdOpen(true)
    push({ text: '密码已重置', tone: 'warn', desc: '旧密码立刻失效' })
  }

  /**
   * 🆕 **自己设一个**：班主任已经登录，所以**不要求旧口令**（旧口令原文谁也拿不到）。
   * ⚠️ 这里只判"两次输入一不一样"；规则（6–12 位、字母和数字都要有、不许有空格）**由服务端判**
   *    —— 前端再抄一份就会与服务端走散。服务端回的那句人话原样摆进浮层（不静默）。
   */
  const submitRoomPassword = async () => {
    if (roomPw1 !== roomPw2) {
      setRoomSetErr('两次输入的不一样，再对一遍。')
      return
    }
    setRoomSetErr('')
    setRoomBusy(true)
    setRoomPwd('')
    const r = await apiSetClassroomPassword(roomId, roomPw1)
    setRoomBusy(false)
    if (!applyRoomResult(r)) {
      setRoomSetErr(classroomAccountMessage(r, '这次操作没成功。'))
      return
    }
    setRoomPwd(readAccount(r)?.password ?? '')
    setRoomPw1('')
    setRoomPw2('')
    setRoomSetForm(false)
    setRoomConfirmResetOpen(false)
    setRoomPwdOpen(true)
    push({ text: '密码已设好', tone: 'ok', desc: '旧密码立刻失效' })
  }

  const toggleRoomDisabled = async () => {
    const next = !roomAccount?.disabled
    setRoomBusy(true)
    const r = await apiSetClassroomDisabled(roomId, next)
    setRoomBusy(false)
    if (!applyRoomResult(r)) return
    push({ text: next ? '已停用这个班的教室端' : '已恢复这个班的教室端', tone: next ? 'warn' : 'ok' })
  }

  /* 🔴 `problems` 只在**真有名单**时才算 —— 0 人的班"没有问题"不等于"正常"，
     那一档由 `rosterState.kind` 单独说（`nobody` / `unknown`），见下面体检那一块。 */
  const problems = health ? health.gaps.length + health.dupNos.length + health.dupNames.length : 0
  /** 体检这一块的四态；`ok` 才是"通过" */
  const okRoster = rosterState.kind === 'ok'

  return (
    <>
      <PageHead
        title={klass.name}
        sub={`${klass.grade} · ${klass.year}`}
        onBack={() => navigate('/classes')}
        right={
          <div className="flex items-center gap-2">
            {/*
              事务性呼叫的入口（Q32 = C）。🔴 **摆不摆只看服务端回的那一个布尔**
              （`canCall`）—— 前端**不在这里判角色**（见上面那一处注释）。
              ⚠️ 能不能发最终仍由数据库的 `can_call()` 说了算：就算把请求手打进来，
              科任老师一样会被拒（§33.2）。
            */}
            {canCall ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<IconMegaphone size={15} />}
                onClick={() => {
                  setCallText('')
                  setCallPicked([])
                  setCallOpen(true)
                }}
              >
                呼叫学生
              </Button>
            ) : null}
            {currentClassId === klass.id ? (
              <Tag tone="accent">当前班级</Tag>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  setCurrentClass(klass.id)
                  push({ text: `已切换为 ${klass.name}`, tone: 'ok' })
                }}
              >
                设为当前
              </Button>
            )}
          </div>
        }
      />

      <Page>
        {/* 走班班的老师（`class_subjects` 那一行）—— 老师分配完刷新之后，这一块必须还在。
            行政班不显示这一块（它的任课关系在「开学准备」那一步批量写，与走班班不是一条链）。 */}
        {isStream ? (
          <div
            className="mb-3 flex items-center gap-2"
            style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}
          >
            <span style={{ color: 'var(--color-ink3)' }}>走班班老师</span>
            <span style={{ fontWeight: 600 }}>
              {teacherUnknown
                ? '没读到'
                : teacherName || (teacherNameHidden ? '一位任课老师' : '还没分配')}
            </span>
            {teacherUnknown ? (
              <span style={{ color: 'var(--color-ink3)' }}>（网络或权限 —— 不代表还没分配）</span>
            ) : null}
          </div>
        ) : null}

        {/* 体检
            🔴 **"还没有名单"与"名单没读到"都不许写成"通过 / 正常"**（2026-10-08）。
               一个 0 人的班是"没有缺号"的，但那是**没有数据**，不是"名单完整" ——
               这个项目栽过最多次的就是"没有数据被当成一切正常"。 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <StatStrip
            items={[
              { k: isStream ? '走班成员' : '学生', v: rosterState.kind === 'unknown' ? '—' : rosterState.count },
              isStream
                ? { k: '名单来源', v: '选科自动生成' }
                : { k: '学号区间', v: rosterState.kind === 'unknown' ? '—' : `1–${health?.maxNo || 0}` },
              {
                k: '待核对',
                v:
                  rosterState.kind === 'unknown'
                    ? '没读到'
                    : rosterState.kind === 'nobody'
                      ? '还没有名单'
                      : okRoster
                        ? '正常'
                        : problems,
                tone:
                  (health && !okRoster) || rosterState.kind === 'nobody'
                    ? 'var(--color-warn)'
                    : 'var(--color-ink3)',
              },
            ]}
          />
          <div
            className="flex items-start gap-2.5 p-3"
            style={{
              borderTop: '1px solid var(--color-line)',
              background: okRoster ? 'var(--color-oksoft)' : rosterState.kind === 'warn' ? 'var(--color-warnsoft)' : 'var(--color-surface2)',
            }}
          >
            <span
              style={{
                color: okRoster ? 'var(--color-ok)' : health && !okRoster ? 'var(--color-warn)' : 'var(--color-ink3)',
                marginTop: 1,
              }}
            >
              {okRoster ? <IconCheck size={16} /> : health && !okRoster ? <IconAlert size={16} /> : <IconUsers size={16} />}
            </span>
            <div className="flex-1" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {okRoster && health ? (
                isStream ? (
                  <span style={{ color: 'var(--color-okink)' }}>
                    名单完整：{health.count} 人（来自选科，跟着选科走）。
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-okink)' }}>
                    名单体检通过：学号 1–{health.maxNo} 连续无缺号，无重号重名。
                  </span>
                )
              ) : health && !okRoster ? (
                <span style={{ color: 'var(--color-warnink)' }}>
                  {health.gaps.length ? `缺号 ${health.gaps.join('、')}； ` : ''}
                  {health.dupNos.length ? `学号重复 ${health.dupNos.join('、')}； ` : ''}
                  {health.dupNames.length ? `重名 ${health.dupNames.join('、')}； ` : ''}
                  {health.noNumber ? `另有 ${health.noNumber} 人学号非数字` : ''}
                </span>
              ) : rosterState.kind === 'unknown' ? (
                <span style={{ color: 'var(--color-ink2)' }}>
                  {membersErr || '没读到这个班的名单 —— 不代表它没有人。'}
                </span>
              ) : isStream ? (
                <span style={{ color: 'var(--color-ink2)' }}>
                  这个走班班还没有成员。在「开学准备 · 选科与走班」里选科之后生成。
                </span>
              ) : (
                <span style={{ color: 'var(--color-ink2)' }}>
                  还没有名单（0 人）—— 体检无从谈起。拍照或粘贴导入之后再来看这一块。
                </span>
              )}
            </div>
          </div>
        </Panel>

        {/* 操作 —— 🔴 **走班班不摆"录名单"那三个入口**：它的人来自选科（`class_members`），
            在这一页手工加/导都不该有路（摆着就是骗人）。 */}
        {!isStream ? (
        <div className="mb-3 flex gap-2">
          <Button
            size="sm"
            icon={<IconCamera size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
          >
            拍照录名单
          </Button>
          <Button
            size="sm"
            icon={<IconPaste size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
          >
            粘贴导入
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            icon={<IconPlus size={15} />}
            onClick={() => {
              setAddForm({ studentNo: String((health?.maxNo ?? 0) + 1), name: '' })
              setAddOpen(true)
            }}
          >
            加学生
          </Button>
        </div>
        ) : null}

        {/* 名单 */}
        <div>
          <Sect>
            {isStream ? '走班成员' : '学生名单'} ·{' '}
            {rosterState.kind === 'unknown' ? '人数没读到' : `${rosterState.count} 人`}
          </Sect>
          <Panel className="overflow-hidden">
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ borderBottom: '1px solid var(--color-line)', background: 'var(--color-surface)' }}
            >
              <span style={{ color: 'var(--color-ink3)' }}>
                <IconSearch size={16} />
              </span>
              <input
                className="flex-1 bg-transparent"
                style={{ border: 0, outline: 'none', fontSize: 14, fontFamily: 'inherit' }}
                placeholder="搜学号或姓名"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {q ? (
                <button type="button" onClick={() => setQ('')} style={{ color: 'var(--color-ink3)' }}>
                  <IconX size={15} />
                </button>
              ) : null}
            </div>

            {list.length === 0 ? (
              <div className="empty">
                <IconUsers size={24} />
                <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>
                  {roster.length === 0 ? (isStream ? '还没有成员' : '名单还是空的') : '没有匹配的学生'}
                </div>
                {roster.length === 0 && !isStream ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<IconCamera size={14} />}
                      onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
                    >
                      拍照录入
                    </Button>
                    <Button
                      size="sm"
                      icon={<IconPaste size={14} />}
                      onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
                    >
                      粘贴导入
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="max-h-[52vh] overflow-y-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>
                        <span className="flex items-center gap-1">
                          <IconHash size={12} />
                          学号
                        </span>
                      </th>
                      <th style={{ width: 86 }}>序列号</th>
                      <th>姓名</th>
                      <th style={{ width: 74 }}>状态</th>
                      <th style={{ width: 52 }}>档案</th>
                      <th style={{ width: 46 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => (
                      <tr key={s.id}>
                        <td className="num" style={{ fontWeight: 600, color: 'var(--color-ink2)' }}>
                          {s.studentNo}
                        </td>
                        {/*
                          序列号：**只读**。它是那 10 个字段的键（I40），
                          而且数据库层已经禁止改（`schema.sql` §20.2 的触发器）——
                          这里连输入框都不摆，免得老师以为能点。
                        */}
                        <td
                          className="num"
                          style={{ color: 'var(--color-ink3)', fontSize: 12 }}
                          title="序列号：全校唯一，生成后不可修改"
                        >
                          {s.serial || '—'}
                        </td>
                        <td style={{ fontWeight: 550 }}>{s.name || '—'}</td>
                        <td>
                          {/* 三档（Q28 = B）—— 显示名只有一处（`types.ts` 的映射） */}
                          <Tag tone={s.status === 'active' ? 'ok' : s.status === 'suspended' ? 'warn' : 'idle'}>
                            {STUDENT_STATUS_NAME[s.status] ?? STUDENT_STATUS_NAME.active}
                          </Tag>
                        </td>
                        <td>
                          {/*
                            学生档案（民族 / 出生年月 / 家长电话 / 家庭住址）。
                            ⚠️ 这里**不判"我看不看得到"**：名单本身就是数据库 RLS 筛过的
                               （`students_visible` → `visible_class_ids()`），看得见这一行就看得见它。
                          */}
                          <button
                            type="button"
                            onClick={() => openProfile(s.id)}
                            aria-label="学生档案"
                            style={{
                              color: profileFilled(profiles.get(s.id))
                                ? 'var(--color-accent)'
                                : 'var(--color-ink3)',
                              fontSize: 12,
                            }}
                          >
                            档案
                          </button>
                        </td>
                        <td>
                          {/*
                            🔴 走班班这一格 = **移出这个走班班**（不是"编辑学生"）。
                               走班班的人不在 `students.class_id` 上，而姓名 / 学号 / 状态
                               都是**行政班**的事 —— 在这里摆铅笔既改不动也不该改
                               （2026-10-09 用户实测：那颗铅笔点了没反应）。
                            行政班那一格照旧是铅笔，一个字没动。
                          */}
                          {isStream ? (
                            canManageThis ? (
                              <button
                                type="button"
                                data-stream-leave="1"
                                onClick={() => {
                                  setLeaveErr('')
                                  setLeaveWho(s)
                                }}
                                aria-label={`把 ${s.name || s.studentNo} 移出这个走班班`}
                                style={{ color: 'var(--color-ink3)', fontSize: 12 }}
                              >
                                移出
                              </button>
                            ) : null
                          ) : (
                            <button
                              type="button"
                              onClick={() => openEdit(s.id)}
                              aria-label="编辑"
                              style={{ color: 'var(--color-ink3)' }}
                            >
                              <IconPencil size={16} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="mt-3 px-1" style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}>
          {isStream
            ? '移出只是不上这门课了 —— 他还是行政班里的人，作业与成绩档案都留着。'
            : '转班学生请使用「设为已转出」而非删除，历史作业数据会随之保留。'}
        </div>

        {/*
          🆕 教室端账号（用户点名：把"班主任能管教室端账号"这个入口放进**班级档案**）。
          🔴 **只对管得着这个班的人摆**（超管 / 教务处 ∪ 本年级年级主任 ∪ 本班班主任）——
             与"改学生档案"同一个粗档（`canEditClassFor`），科任老师**看不到这一块**。
             ⚠️ 摆不摆只是"少点几下"：真正那一刀在服务端（`mayManage()`）。
          🔴 **这里给不出原密码** —— Supabase 里密码是哈希存的，谁也算不回原文；
             要密码只有一条路：「重置密码」，新密码当场显示一次。
        */}
        {canManageThis ? (
          <div className="mt-6">
            <Sect>教室端账号</Sect>
            <Panel bodyClass="p-3">
              {!isRemote ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  教室端账号要连上服务器才能管理。
                </div>
              ) : roomReading ? (
                <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>正在读…</div>
              ) : roomErr ? (
                <div className="flex items-start gap-2">
                  <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                    <IconAlert size={16} />
                  </span>
                  <div className="flex-1" style={{ fontSize: 12.5, color: 'var(--color-warn)', lineHeight: 1.8 }}>
                    {roomErr.includes('显示这一次') ? roomErr : `${roomErr} ${PASSWORD_SHOWN_ONCE}`}
                  </div>
                  <Button size="sm" disabled={roomBusy} onClick={() => setRoomTick((t) => t + 1)}>
                    重试
                  </Button>
                </div>
              ) : roomAccount ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>登录账号</span>
                    <code
                      className="num"
                      style={{ fontSize: 13, fontFamily: 'var(--font-mono)', fontWeight: 600 }}
                    >
                      {roomAccount.email}
                    </code>
                    <Tag tone={roomAccount.disabled ? 'idle' : 'ok'}>
                      {roomAccount.disabled ? '已停用' : '在用'}
                    </Tag>
                    <span className="flex-1" />
                    {/*
                      ⓘ 只回答一件事："密码去哪了？" —— 摆在这里是因为**每个人第一次
                      看这一块都会问它**（用户原话就是"能看见账号和密码"）。
                    */}
                    <button
                      type="button"
                      onClick={() => setRoomInfo(true)}
                      aria-label="密码怎么拿"
                      style={{ color: 'var(--color-ink3)' }}
                    >
                      <IconInfo size={16} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                    挂在教室里那台大屏上。
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      icon={<IconRefresh size={14} />}
                      disabled={roomBusy}
                      onClick={openRoomPw}
                    >
                      设置新密码
                    </Button>
                    <Button size="sm" variant="ghost" disabled={roomBusy} onClick={() => void toggleRoomDisabled()}>
                      {roomAccount.disabled ? '恢复使用' : '停用'}
                    </Button>
                    {roomPwd ? (
                      <Button size="sm" variant="ghost" icon={<IconEye size={14} />} onClick={() => setRoomPwdOpen(true)}>
                        看新密码
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.8 }}>
                    这个班还没有教室端账号 —— 建好之后，教室里那台大屏就能登录了。
                  </div>
                  <div>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<IconPlus size={14} />}
                      disabled={roomBusy}
                      onClick={() => void createRoomAccount()}
                    >
                      建教室端账号
                    </Button>
                  </div>
                </div>
              )}
            </Panel>
          </div>
        ) : null}

        {/*
          🆕 值日生 + 课代表口令（用户口径 ⑧ + 追问 5）。
          🔴 摆不摆 = 上面那一个 `canManageThis`（与「教室端账号」同一档判据）——
             科任老师看不到这一块；真正那一刀在数据库（`duty_assignments_write`
             是 `can_manage_class()`、口令只能走 RPC）。
          ⚠️ 值日生的**顺序**不由这里决定：这里只写"某天是谁"这一个锚点，
             其余日子全部由 `lib/duty.ts` 按学号顺序推出来（判据只有一处）。
        */}
        {canManageThis ? (
          <>
            <div className="mt-6">
              <Sect>值日生</Sect>
              <Panel bodyClass="p-3">
                <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  每天<b>一人</b>，按<b>学号升序</b>轮，周末与放假日跳过。你在这里定了某一天是谁，
                  从那天起就接着往下轮。
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    className="input"
                    style={{ width: 'auto' }}
                    value={dutyDate}
                    onChange={(e) => setDutyDate(e.target.value || ymdOf(beijingNow()))}
                  />
                  <Button size="sm" onClick={() => setDutyDate(ymdOf(beijingNow()))}>
                    回到今天
                  </Button>
                  <span className="flex-1" />
                  <span style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                    {dutyDay ? (
                      <>
                        这一天：<b>{dutyDay.name}</b>
                        <span style={{ color: 'var(--color-ink3)' }}>（学号 {dutyDay.studentNo}）</span>
                      </>
                    ) : (
                      '这一天不上课（周末 / 放假）'
                    )}
                  </span>
                  {dutyDay ? (
                    <Tag tone={dutyDay.source === 'set' ? 'accent' : 'idle'}>
                      {dutyDay.source === 'set' ? '你定的' : '按学号轮'}
                    </Tag>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    className="input"
                    style={{ width: 'auto', maxWidth: 260 }}
                    value={dutyPick}
                    onChange={(e) => setDutyPick(e.target.value)}
                  >
                    <option value="">（挑一个学生）</option>
                    {dutyCandidates.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.studentNo} {s.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={dutyBusy || !dutyPick || !dutyDay}
                    onClick={() => void saveDuty()}
                  >
                    就定他
                  </Button>
                  {!daily ? (
                    <span style={{ fontSize: 11.5, color: 'var(--color-warn)' }}>
                      这一次没读出值日生记录，定了可能存不下去。
                    </span>
                  ) : null}
                </div>

                <div className="mt-4" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  接下来两周（只列上课日，点一行跳到那天）
                </div>
                <div className="mt-1 flex flex-col">
                  {dutyNext.length ? (
                    dutyNext.map((r) => (
                      <button
                        key={r.date}
                        type="button"
                        data-duty-row={r.date}
                        onClick={() => setDutyDate(r.date)}
                        className="flex items-center gap-3 py-2 text-left"
                        style={{
                          borderBottom: '1px solid var(--color-line2)',
                          background: r.date === dutyDate ? 'var(--color-accentsoft)' : undefined,
                        }}
                      >
                        <span className="num" style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                          {r.date.slice(5).replace('-', '/')}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                          周{['一', '二', '三', '四', '五', '六', '日'][weekdayOfISO(r.date) - 1]}
                        </span>
                        <span className="flex-1" style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {r.name}
                        </span>
                        {r.source === 'set' ? <Tag tone="accent">你定的</Tag> : null}
                      </button>
                    ))
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--color-ink4)' }}>
                      这两周没有上课日（放假？）。
                    </div>
                  )}
                </div>
              </Panel>
            </div>

            <div className="mt-6">
              <Sect>课代表口令</Sect>
              <Panel bodyClass="p-3">
                <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  课代表在教室那块屏上录作业时要输它（他只能录<b>自己那一科</b>、只能录<b>今天</b>）。
                  <b>设完谁都看不到原文</b> —— 忘了就再设一个。
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    className="input"
                    style={{ width: 'auto', maxWidth: 200 }}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="6–12 位"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={pinBusy || pinInput.trim().length < 6 || pinInput.trim().length > 12}
                    onClick={() => void savePin()}
                  >
                    设定 / 换口令
                  </Button>
                  {pinMsg ? (
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>{pinMsg}</span>
                  ) : null}
                </div>
              </Panel>
            </div>

            {/*
              🆕 本班课表（用户口径 ⑨）—— 班主任在班级管理处调本班课表。
              逻辑与判据见上面「本班课表」那一段注释；这里只画。
            */}
            <div className="mt-6">
              <Sect>本班课表</Sect>
              <Panel bodyClass="p-3">
                <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                  这里改的是<b>以后每周都生效</b>的本班课表（教室里那块大屏读的就是它）。
                  只想改<b>某一天</b>的（换一节课的老师 / 这节课今天不上了），
                  用下面的「调课 / 停课」——那是另一条路，不动这张表。
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => setBatchOpen(true)}>
                    <IconPaste size={14} /> 粘贴 / 上传整份课表
                  </Button>
                  <Button
                    size="sm"
                    data-adj-open="1"
                    onClick={() => {
                      setAdjPick('')
                      setAdjOpen(true)
                    }}
                  >
                    <IconSwap size={14} /> 调课 / 停课（只改某一天）
                  </Button>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                    {classRows.length ? `现在有 ${classRows.length} 节` : '现在还是空的'}
                  </span>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <div style={{ minWidth: 560 }}>
                    <div
                      className="flex items-stretch"
                      style={{ borderBottom: '1px solid var(--color-line2)' }}
                    >
                      <div style={{ width: 64 }} />
                      {weekDays.map((wd) => (
                        <div
                          key={wd}
                          className="flex-1 py-1.5 text-center"
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                        >
                          {WEEKDAY_TEXT[wd - 1]}
                        </div>
                      ))}
                    </div>
                    {weekSlots.map(([start, end]) => (
                      <div
                        key={start}
                        data-class-slot={start}
                        className="flex items-stretch"
                        style={{ borderBottom: '1px solid var(--color-line2)' }}
                      >
                        <div
                          className="flex items-center"
                          style={{ width: 64, fontSize: 11, color: 'var(--color-ink4)' }}
                        >
                          <span className="num">{start}</span>
                        </div>
                        {weekDays.map((wd) => {
                          const rows = cellRows(wd, start)
                          return (
                            <div
                              key={wd}
                              className="min-w-0 flex-1 p-1"
                              data-class-cell={`${wd}-${start}`}
                            >
                              {rows.length ? (
                                rows.map((r) => (
                                  <button
                                    key={r.id}
                                    type="button"
                                    onClick={() => openCell(wd, start, r.end, rows)}
                                    className="mb-1 w-full rounded-md px-1.5 py-1 text-left"
                                    style={{
                                      background: 'var(--color-accentsoft)',
                                      border: '1px solid var(--color-line2)',
                                    }}
                                  >
                                    <span
                                      className="block truncate"
                                      style={{ fontSize: 12, fontWeight: 600 }}
                                    >
                                      {splitLessonTitle(r.title).subject || r.title}
                                    </span>
                                  </button>
                                ))
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => openCell(wd, start, end, [])}
                                  aria-label={`加一节课：${WEEKDAY_TEXT[wd - 1]} ${start}`}
                                  className="w-full rounded-md"
                                  style={{
                                    border: '1px dashed var(--color-line3)',
                                    color: 'var(--color-ink4)',
                                    fontSize: 13,
                                    lineHeight: '22px',
                                  }}
                                >
                                  ＋
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>
            </div>

            {/* 编辑那一节：钟点与星期几来自**点的那一格**，这里只挑科目与老师 */}
            <Sheet
              open={!!lessonCell}
              onClose={() => setLessonCell(null)}
              title={lessonCell ? `${WEEKDAY_TEXT[lessonCell.wd - 1]} ${lessonCell.start}` : ''}
              footer={
                <div className="flex gap-2">
                  {lessonCell && cellRows(lessonCell.wd, lessonCell.start).length ? (
                    <Button block onClick={removeLesson}>
                      去掉这一节
                    </Button>
                  ) : null}
                  <Button
                    block
                    variant="primary"
                    disabled={lessonBusy || !lessonSubject}
                    onClick={() => void saveLesson()}
                  >
                    保存
                  </Button>
                </div>
              }
            >
              <div style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>这一节上哪一科</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {SUBJECTS.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    data-lesson-subject={s.code}
                    onClick={() => setLessonSubject(s.code)}
                    className="rounded-full px-2.5 py-1"
                    style={{
                      fontSize: 12,
                      border: '1px solid var(--color-line2)',
                      background:
                        lessonSubject === s.code ? 'var(--color-accentsoft)' : 'transparent',
                      color:
                        lessonSubject === s.code ? 'var(--color-ink)' : 'var(--color-ink2)',
                      fontWeight: lessonSubject === s.code ? 650 : 400,
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </div>

              <div className="mt-4" style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                谁上（可以不填）
              </div>
              <select
                className="input mt-2"
                style={{ width: 'auto', maxWidth: 300 }}
                value={lessonTeacher}
                onChange={(e) => setLessonTeacher(e.target.value)}
              >
                <option value="">（不写老师）</option>
                {classTeachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {subjectName(t.subjectCode, t.subjectCode)} · {t.name}
                  </option>
                ))}
              </select>
              <div className="mt-2" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                名单来自这个班的任课关系（教师管理里配的那张表）。
              </div>
            </Sheet>

            {/*
              调课 / 停课（**只改这一天**）—— 见上面那一段注释。
              写 `schedule_temp_changes`（§38.0b 起的判据含本班班主任）；
              ⚠️ 这里的"这一天有几节"读的是 `schedule_day_cells`，**不是**上面那张周课表。
            */}
            <Sheet
              open={adjOpen}
              onClose={() => setAdjOpen(false)}
              title="调课 / 停课（只改这一天）"
              footer={
                <Button block onClick={() => setAdjOpen(false)}>
                  完成
                </Button>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  className="input"
                  data-adj-date="1"
                  style={{ width: 'auto' }}
                  value={adjDate}
                  onChange={(e) => {
                    setAdjDate(e.target.value)
                    setAdjPick('')
                  }}
                />
                {[
                  ['今天', 0],
                  ['明天', 1],
                  ['后天', 2],
                ].map(([text, n]) => {
                  const iso = isoOffset(Number(n))
                  return (
                    <button
                      key={text}
                      type="button"
                      data-adj-quick={String(n)}
                      onClick={() => {
                        setAdjDate(iso)
                        setAdjPick('')
                      }}
                      className="rounded-full px-2.5 py-1"
                      style={{
                        fontSize: 12,
                        border: '1px solid var(--color-line2)',
                        background: adjDate === iso ? 'var(--color-accentsoft)' : 'transparent',
                        color: adjDate === iso ? 'var(--color-ink)' : 'var(--color-ink2)',
                        fontWeight: adjDate === iso ? 650 : 400,
                      }}
                    >
                      {text}
                    </button>
                  )
                })}
              </div>

              {!adjListable ? (
                <div
                  className="mt-3"
                  style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}
                >
                  {adjDay?.status === 'missing'
                    ? '课表功能还没开通，这一天的改动暂时改不了。'
                    : '这一天的课表没读到（不是"这一天没课"）。'}
                </div>
              ) : (
                <>
                  <div className="mt-3" style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                    这一天这个班有 <b className="num">{adjCells.length}</b> 节 · 点一节改它
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {adjCells.length ? (
                      adjCells.map((c) => (
                        <button
                          key={c.start}
                          type="button"
                          data-adj-cell={c.start}
                          onClick={() => {
                            setAdjPick(c.start)
                            setAdjSubject(subjectCodeOfName(c.subject) ?? '')
                            setAdjTeacher(c.teacherId ?? '')
                          }}
                          className="w-full rounded-md px-2.5 py-2 text-left"
                          style={{
                            border: '1px solid var(--color-line2)',
                            background:
                              adjPick === c.start ? 'var(--color-accentsoft)' : 'transparent',
                          }}
                        >
                          <span
                            className="flex items-center gap-1.5"
                            style={{ fontSize: 12.5, fontWeight: 620 }}
                          >
                            <span className="num">
                              {c.start}–{c.end}
                            </span>
                            <span>{c.subject || '（空）'}</span>
                            {c.changed ? <Tag tone="warn">今天改过</Tag> : null}
                          </span>
                          <span
                            className="mt-0.5 block"
                            style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                          >
                            {adjTeacherText(c.teacherId)}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                        这一天这个班没有课。
                      </div>
                    )}
                  </div>
                </>
              )}

              {adjPicked ? (
                <div
                  className="mt-4"
                  style={{ borderTop: '1px solid var(--color-line2)', paddingTop: 12 }}
                >
                  <div style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                    这一节（
                    <span className="num">
                      {adjPicked.start}–{adjPicked.end}
                    </span>
                    ）今天改成
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {SUBJECTS.map((s) => (
                      <button
                        key={s.code}
                        type="button"
                        data-adj-subject={s.code}
                        onClick={() => setAdjSubject(s.code)}
                        className="rounded-full px-2.5 py-1"
                        style={{
                          fontSize: 12,
                          border: '1px solid var(--color-line2)',
                          background:
                            adjSubject === s.code ? 'var(--color-accentsoft)' : 'transparent',
                          color: adjSubject === s.code ? 'var(--color-ink)' : 'var(--color-ink2)',
                          fontWeight: adjSubject === s.code ? 650 : 400,
                        }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                  <select
                    className="input mt-3"
                    data-adj-teacher="1"
                    style={{ width: 'auto', maxWidth: 300 }}
                    value={adjTeacher}
                    onChange={(e) => setAdjTeacher(e.target.value)}
                  >
                    <option value="">（不写老师）</option>
                    {classTeachers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {subjectName(t.subjectCode, t.subjectCode)} · {t.name}
                      </option>
                    ))}
                  </select>
                  {adjStartConf.length ? (
                    <div
                      className="mt-2"
                      style={{ fontSize: 11.5, color: 'var(--color-badink)', lineHeight: 1.7 }}
                    >
                      注意：{adjStartConf.map((c) => c.detail).join('；')}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      data-adj-save="1"
                      disabled={adjBusy || !adjSubject}
                      onClick={() => void submitAdj('swap')}
                    >
                      存这一笔
                    </Button>
                    <Button
                      size="sm"
                      data-adj-off="1"
                      disabled={adjBusy}
                      onClick={() => void submitAdj('off')}
                    >
                      这节课今天不上
                    </Button>
                    {adjBaseRow ? (
                      <Button
                        size="sm"
                        data-adj-restore="1"
                        disabled={adjBusy}
                        onClick={() => void submitAdj('restore')}
                      >
                        恢复成每周课表那一节
                      </Button>
                    ) : null}
                  </div>
                  <div
                    className="mt-2"
                    style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
                  >
                    只改 <span className="num">{adjDate}</span> 这一天；每周的课表不动。
                  </div>
                </div>
              ) : null}
            </Sheet>

            {/* 批量录入：粘贴 / 上传整份课表 —— 与「我的日程表」那一页同一个组件 */}
            <ScheduleBatch
              open={batchOpen}
              onClose={() => setBatchOpen(false)}
              classes={[klass]}
              today={weekdayOfISO(ymdOf(beijingNow()))}
              onSave={async (items) => {
                const mapped: Omit<ScheduleItem, 'id'>[] = items.map((x) => ({
                  ...x,
                  classId: klass.id,
                  scope: 'class',
                  kind: 'class',
                }))
                const ok = await guardConflicts(mapped)
                if (!ok) return false
                const n = addScheduleMany(mapped)
                setBatchOpen(false)
                push({ text: `已加入 ${n} 节`, tone: 'ok', desc: '以后每周都按新的上' })
                return true
              }}
            />
          </>
        ) : null}
      </Page>

      {/*
        「为什么看不到原密码」的那一页（教室端账号块右上角那个 ⓘ）。
        写得短：这里只回答"密码去哪了 / 要密码怎么办"。
      */}
      <Sheet open={roomInfo} onClose={() => setRoomInfo(false)} title="教室端账号">
        <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
          <p>这个班的大屏用一个账号登录，学生能碰到那台机器。</p>
          <p className="mt-2">
            密码存进去就取不出原文了，所以这里看不到。要密码就点「设置新密码」——
            可以自己定一个，也可以让系统随机生成一个，当场显示一次，旧密码立刻失效。
          </p>
        </div>
      </Sheet>

      {/*
        「设置新密码」：**先把代价说清再动手**（两条路都会让教室那台机器下次登录要用新密码），
        然后**两条路二选一** —— 「随机重置」＝服务端 `makePassword()` 生成 12 位；
        「自己设置」＝班主任自己定一个（6 到 12 位、字母和数字都要有）。
      */}
      <Sheet
        open={roomConfirmResetOpen}
        onClose={closeRoomPw}
        title="设置新密码"
        footer={
          roomSetForm ? (
            <div className="flex gap-2">
              <Button block onClick={() => { setRoomSetForm(false); setRoomSetErr('') }}>
                返回
              </Button>
              <Button block variant="primary" disabled={roomBusy} onClick={() => void submitRoomPassword()}>
                确认设置
              </Button>
            </div>
          ) : (
            <Button block onClick={closeRoomPw}>
              取消
            </Button>
          )
        }
      >
        {roomSetForm ? (
          <div className="flex flex-col gap-4">
            <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
              <p>6 到 12 位，字母和数字都要有，不能有空格。</p>
              <p className="mt-2">设好之后旧密码立刻失效，教室那台大屏下次登录要用新的。</p>
            </div>
            <label>
              <span className="label">新密码</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={roomPw1}
                onChange={(e) => setRoomPw1(e.target.value)}
              />
            </label>
            <label>
              <span className="label">再输一遍</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={roomPw2}
                onChange={(e) => setRoomPw2(e.target.value)}
              />
            </label>
            {roomSetErr ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-bad, #c0392b)', lineHeight: 1.75 }}>
                {roomSetErr}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
              <p>旧密码立刻失效，教室那台大屏下次登录要用新密码。</p>
              <p className="mt-2">{PASSWORD_SHOWN_ONCE}</p>
            </div>
            <Button
              size="sm"
              icon={<IconRefresh size={14} />}
              disabled={roomBusy}
              onClick={() => void resetRoomPassword()}
            >
              随机重置
            </Button>
            <Button
              size="sm"
              icon={<IconPencil size={14} />}
              disabled={roomBusy}
              onClick={() => { setRoomSetErr(''); setRoomSetForm(true) }}
            >
              自己设置
            </Button>
          </div>
        )}
      </Sheet>

      {/* 换密码结果：新密码**只在这里一次**（关掉就看不到了 —— 库里存的不是原文） */}
      <Sheet
        open={roomPwdOpen && !!roomPwd}
        onClose={() => setRoomPwdOpen(false)}
        title="新密码"
        footer={
          <Button block variant="primary" icon={<IconCheck size={16} />} onClick={() => setRoomPwdOpen(false)}>
            我知道了
          </Button>
        }
      >
        {roomPwd ? (
          <div className="flex flex-col gap-2">
            <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
              {PASSWORD_SHOWN_ONCE}抄给管那台机器的人。
            </div>
            <RoomRow label="登录账号" value={roomAccount?.email ?? ''} onCopy={push} />
            <RoomRow label="新密码" value={roomPwd} onCopy={push} />
          </div>
        ) : null}
      </Sheet>

      {/* 编辑学生 */}
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title="编辑学生"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              onClick={() => {
                if (editing) updateStudent(klass.id, editing, form)
                setEditing(null)
                push({ text: '已保存', tone: 'ok' })
              }}
            >
              保存
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-[92px_1fr] gap-3">
            <label>
              <span className="label">学号</span>
              <input
                className="input num"
                value={form.studentNo}
                onChange={(e) => setForm({ ...form, studentNo: e.target.value })}
              />
            </label>
            <label>
              <span className="label">姓名</span>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
          </div>

          {/*
            🔴 **序列号只读**：它是那 10 个字段的键，生成后永久不可改
            （Q6；数据库层由 `schema.sql` §20.2 的触发器强制，不只是界面灰化）。
            班内学号**照旧可改**（三档：班主任 / 年级主任 / 教务处）——
            改它不会影响任何历史档案，因为键已经是序列号。
          */}
          <label>
            <span className="label">序列号（只读 · 生成后不可修改）</span>
            <input
              className="input num"
              value={editingStudent?.serial || '（还没生成）'}
              readOnly
              disabled
              aria-readonly="true"
            />
          </label>

          {/*
            ✅ Q28 = B：**三档**。转班 / 转学移出走班名单；**休学保留但标记**（复学一键恢复）。
            🔴 移出这件事**不在这里做**：数据库那边 `students` 上的触发器
               （`schema.sql` §34.5）守住了**全部四条写入路径**（逐个改 / 粘贴导入 /
               备份恢复回推 / 服务端），界面这一层只是把三档摆出来。
          */}
          <div>
            <span className="label">在班状态</span>
            <div className="seg">
              {(['active', 'suspended', 'left'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  data-on={form.status === v}
                  onClick={() => setForm({ ...form, status: v })}
                >
                  {STUDENT_STATUS_NAME[v]}
                </button>
              ))}
            </div>
            {form.status === 'suspended' ? (
              <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                休学期间走班名单与全部历史都保留；复学时把状态改回「在读」即可。
              </div>
            ) : null}
            {form.status === 'left' ? (
              <div style={{ fontSize: 11.5, color: 'var(--color-warn)', marginTop: 6, lineHeight: 1.7 }}>
                转出会把这位学生移出走班名单。历史作业与成绩不受影响。
              </div>
            ) : null}
          </div>

          {isRemote && editing ? (
            <div>
              <span className="label">选科变更记录</span>
              {changesErr ? (
                <div style={{ fontSize: 12, color: 'var(--color-warn)', lineHeight: 1.7 }}>{changesErr}</div>
              ) : changes === null ? (
                <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>正在读…</div>
              ) : changes.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                  这位学生还没有选科变更记录。
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {changes.slice(0, 8).map((c) => (
                    <div
                      key={c.id}
                      style={{
                        border: '1px solid var(--color-line2)',
                        borderRadius: 4,
                        padding: '6px 8px',
                        fontSize: 12,
                        lineHeight: 1.7,
                      }}
                    >
                      <div>
                        {comboText(c.before)} → {comboText(c.after)}
                      </div>
                      <div style={{ color: 'var(--color-ink3)', fontSize: 11 }}>
                        {c.changedAt ? new Date(c.changedAt).toLocaleString('zh-CN') : '时间不明'}
                        {c.purgedAt ? ' · 旧科目数据已删除' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/*
                🔴 **二次确认**（Q20 = A）：先把"将删除 N 条记录"摆出来，点确认才真删。
                数字来自数据库（`old_subject_data_counts_for()`）——**前端不自己数一遍**
                （数错了就是"确认框上写着 0 条、实际删掉一片"，而那是不可恢复的操作）。
              */}
              {purgeCounts?.ok && purgeCounts.total > 0 ? (
                <div
                  className="mt-2"
                  style={{
                    border: '1px solid var(--color-warnline)',
                    background: 'var(--color-warnsoft)',
                    borderRadius: 4,
                    padding: '8px 10px',
                    fontSize: 12,
                    lineHeight: 1.8,
                  }}
                >
                  <div style={{ color: 'var(--color-warnink)', fontWeight: 600 }}>
                    将删除 {purgeCounts.total} 条记录（无可恢复）
                  </div>
                  <div style={{ color: 'var(--color-warnink)' }}>
                    被放弃的科目：{purgeCounts.oldSubjects.map((c) => subjectName(c, c)).join('、') || '（无）'}
                    <br />
                    考试成绩 {purgeCounts.scores} 条 · 走班班成员 {purgeCounts.members} 条
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => setPurgeCounts(null)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={purgeBusy}
                      onClick={async () => {
                        setPurgeBusy(true)
                        const r = await apiPurgeOldSubjectData(editing, true)
                        setPurgeBusy(false)
                        setPurgeCounts(null)
                        if (!r.ok) {
                          setPurgeErr(r.message)
                          return
                        }
                        setPurgeErr('')
                        push({
                          text: '已删除旧科目数据',
                          tone: 'warn',
                          desc: `成绩 ${r.deleted.scores} 条 · 走班班成员 ${r.deleted.members} 条`,
                        })
                        void loadChanges(editing)
                      }}
                    >
                      确认删除
                    </Button>
                  </div>
                </div>
              ) : null}

              {purgeErr ? (
                <div style={{ fontSize: 12, color: 'var(--color-bad)', marginTop: 6, lineHeight: 1.7 }}>
                  {purgeErr}
                </div>
              ) : null}

              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                disabled={purgeBusy || !changes?.length}
                onClick={async () => {
                  setPurgeErr('')
                  setPurgeBusy(true)
                  const c = await apiOldSubjectPreview(editing)
                  setPurgeBusy(false)
                  if (!c.ok) {
                    setPurgeErr(c.message)
                    return
                  }
                  if (c.total === 0) {
                    push({ text: '没有要删的旧科目数据', tone: 'ok' })
                    return
                  }
                  setPurgeCounts(c)
                }}
              >
                删除变更掉的旧科目数据
              </Button>
            </div>
          ) : null}

          {classes.length > 1 ? (
            <div>
              <span className="label">转入其他班级</span>
              <div className="flex flex-wrap gap-1.5">
                {classes
                  .filter((c) => c.id !== klass.id)
                  .map((c) => (
                    <Button
                      key={c.id}
                      size="sm"
                      icon={<IconSwap size={14} />}
                      onClick={() => {
                        if (editing) transferStudent(editing, klass.id, c.id)
                        setEditing(null)
                        push({ text: `已转入 ${c.name}`, tone: 'ok' })
                      }}
                    >
                      {c.name}
                    </Button>
                  ))}
              </div>
            </div>
          ) : null}

          <Button
            variant="danger"
            block
            onClick={() => {
              if (editing) removeStudent(klass.id, editing)
              setEditing(null)
              push({ text: '已删除该学生', tone: 'warn', desc: '删除不可恢复' })
            }}
          >
            彻底删除
          </Button>
        </div>
      </Sheet>

      {/* 新增学生 */}
      <Sheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="新增学生"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!addForm.name.trim()}
              onClick={() => {
                addStudents(klass.id, [addForm], 'merge')
                setAddOpen(false)
                push({ text: `已添加 ${addForm.name}`, tone: 'ok' })
                setAddForm({ studentNo: '', name: '' })
              }}
            >
              添加
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-[92px_1fr] gap-3">
          <label>
            <span className="label">学号</span>
            <input
              className="input num"
              value={addForm.studentNo}
              onChange={(e) => setAddForm({ ...addForm, studentNo: e.target.value })}
            />
          </label>
          <label>
            <span className="label">姓名</span>
            <input
              className="input"
              placeholder="学生姓名"
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
              autoFocus
            />
          </label>
        </div>
      </Sheet>

      {/*
        学生档案：民族 / 出生年月 / 家长电话 / 家庭住址（表 `student_profiles`，schema.sql §35）。
        🔴 **"修改档案"这个入口只对管得着这个班的人摆**（超管 / 教务处 ∪ 本年级年级主任 ∪
           本班班主任 = 数据库的 `can_manage_class()`）；科任老师照样**看得见**这几个字段。
           ⚠️ 前端只决定"摆不摆"，真正能不能写由数据库那条策略说了算 —— 所以保存失败
              必须**显式说出来**（被策略挡下是"0 行且不报错"，见 `lib/studentProfile.ts`）。
      */}
      <Sheet
        open={!!profileFor}
        onClose={() => {
          setProfileFor(null)
          setProfileEdit(false)
        }}
        title={profileStudent ? `学生档案 · ${profileStudent.name || '（无姓名）'}` : '学生档案'}
        footer={
          profileEdit ? (
            <div className="flex gap-2">
              <Button
                block
                onClick={() => {
                  setProfileEdit(false)
                  setProfileSaveErr('')
                }}
              >
                取消
              </Button>
              <Button block variant="primary" disabled={profileSaving} onClick={() => void saveProfile()}>
                {profileSaving ? '保存中…' : '保存'}
              </Button>
            </div>
          ) : canManageThis && !profilesErr ? (
            <Button
              block
              variant="primary"
              onClick={() => {
                setProfileForm(shownProfile ?? emptyProfile(profileFor ?? ''))
                setProfileSaveErr('')
                setProfileEdit(true)
              }}
            >
              修改档案
            </Button>
          ) : undefined
        }
      >
        {profilesErr ? (
          <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}>{profilesErr}</div>
        ) : (
          <div className="flex flex-col gap-3">
            {PROFILE_FIELDS.map((f) => (
              <div key={f.key}>
                <span className="label">{f.label}</span>
                {profileEdit ? (
                  <input
                    className="input"
                    placeholder={f.hint}
                    value={profileForm[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.7,
                      color: String(shownProfile?.[f.key] ?? '').trim()
                        ? 'var(--color-ink)'
                        : 'var(--color-ink4)',
                    }}
                  >
                    {String(shownProfile?.[f.key] ?? '').trim() || '未录入'}
                  </div>
                )}
              </div>
            ))}
            {profileSaveErr ? (
              <div style={{ fontSize: 12, color: 'var(--color-bad)', lineHeight: 1.7 }}>{profileSaveErr}</div>
            ) : null}
          </div>
        )}
      </Sheet>

      {/*
        走班班：把一个人移出这个走班班（**轻确认** —— 一句话 + 一个按钮）。
        为什么要有这一步：移出之后他不再上这门课，而这**只影响这一个走班班**
        （另一个走班班里的他、行政班里的他都照旧 —— 多对多，§27.5）。
        写的是 `class_members`，失败显式上屏。
      */}
      <Sheet
        open={!!leaveWho}
        onClose={() => {
          setLeaveWho(null)
          setLeaveErr('')
        }}
        title="移出这个走班班"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setLeaveWho(null)}>
              取消
            </Button>
            <Button block variant="danger" disabled={leaveBusy} onClick={() => void goOut()}>
              {leaveBusy ? '正在移出…' : '移出'}
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
          <p>
            把 <b>{leaveWho?.name || `（无姓名 · ${leaveWho?.studentNo ?? ''}）`}</b> 移出「{klass.name}」？
          </p>
          <p className="mt-2">他不再上这个走班班的课；行政班的名单、作业与成绩档案都不动。</p>
          {leaveErr ? (
            <p className="mt-2" style={{ color: 'var(--color-bad)' }}>{leaveErr}</p>
          ) : null}
        </div>
      </Sheet>

      {/*
        🆕 P9 / Q32 = C：**事务性呼叫** —— 班主任 / 教导处从班级管理里直接叫学生，
        **不挂任何作业档案**（`calls.assignment_id` 是空的，`schema.sql` §33.1 把它放开了）。
        ⚠️ 它落在**这个行政班**的教室端（走班班的屏不接呼叫 —— Q17）。
        ⚠️ 能不能发**不由这里决定**：数据库的 `can_call()`（§33.2）只管班级管理权那一档，
           科任老师即使把请求打进来也会被拒。
      */}
      <Sheet
        open={callOpen}
        onClose={() => setCallOpen(false)}
        title={`呼叫 ${klass.name}`}
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setCallOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!callText.trim()}
              onClick={() => {
                const picked = klass.students.filter((s) => callPicked.includes(s.id))
                const nos = picked.map((s) => archiveKeyOf(s))
                /*
                 * `assignmentId: ''` = **事务性呼叫**（不挂作业）。
                 * 文案只有一处拼（`lib/calls.ts` 的 `composeCallText`）——
                 * 页面里再拼一遍就会与作业页那一句不一致。
                 */
                sendCall({
                  assignmentId: '',
                  classId: klass.id,
                  studentNos: nos,
                  text: composeCallText(
                    picked.map((s) => s.studentNo),
                    klass.name,
                    '',
                    callText.trim(),
                  ),
                  room: klass.name,
                })
                push({
                  text: '已发送到本班教室端',
                  tone: 'ok',
                  desc: picked.length ? `${picked.length} 人` : '整班播报',
                })
                setCallText('')
                setCallPicked([])
                setCallOpen(false)
              }}
            >
              发送播报
            </Button>
          </div>
        }
      >
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
          输入想让教室端念出来的话；可以顺手勾上要叫的学生。教室端会先响一声提示音，再用系统语音播报。
        </p>
        <textarea
          className="input"
          rows={3}
          value={callText}
          onChange={(e) => setCallText(e.target.value.slice(0, CUSTOM_MAX))}
          placeholder={`例如：带上作业本到办公室。`}
          style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }}
        />
        <div className="mt-3">
          <span className="label">
            要叫谁（可不选 —— 不选就是整班播报 · 最多 {CALL_LIMIT} 人）
          </span>
          <div className="max-h-[28vh] overflow-y-auto" style={{ border: '1px solid var(--color-line2)', borderRadius: 4 }}>
            {klass.students
              .filter((s) => s.status !== 'left')
              /* 与上面的名单同一套顺序（屏上都是班内学号，别一个按序列号一个按班内学号） */
              .sort(compareStudentNo)
              .map((s) => {
                const on = callPicked.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() =>
                      setCallPicked((prev) =>
                        on
                          ? prev.filter((x) => x !== s.id)
                          : prev.length >= CALL_LIMIT
                            ? prev
                            : [...prev, s.id],
                      )
                    }
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
                    style={{
                      borderBottom: '1px solid var(--color-line)',
                      background: on ? 'var(--color-accentsoft)' : 'transparent',
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        border: '1px solid var(--color-line2)',
                        background: on ? 'var(--color-accent)' : 'transparent',
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                    <span className="num" style={{ width: 48, color: 'var(--color-ink3)' }}>
                      {s.studentNo}
                    </span>
                    <span style={{ fontWeight: 550 }}>{s.name || '—'}</span>
                  </button>
                )
              })}
          </div>
        </div>
      </Sheet>
    </>
  )
}

/**
 * 一行「值 + 复制」（教室端账号那一块用）。
 * ⚠️ 与教师账号页那个同名组件是**同一套 markup**（那一个是页面私有的 `CopyRow`，
 *    没有导出）。这一份刻意写得一样：两处的读者都要"抄一串字符过去"。
 */
function RoomRow({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy: (t: { text: string; tone: 'ok' }) => void
}) {
  return (
    <div
      className="flex items-center gap-2 p-2.5"
      style={{
        background: 'var(--color-surface2)',
        border: '1px solid var(--color-line)',
        borderRadius: 4,
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--color-ink3)', width: 58 }}>{label}</span>
      <code
        className="min-w-0 flex-1 truncate"
        style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)' }}
      >
        {value}
      </code>
      <Button
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value)
          onCopy({ text: `已复制${label}`, tone: 'ok' })
        }}
      >
        复制
      </Button>
    </div>
  )
}
