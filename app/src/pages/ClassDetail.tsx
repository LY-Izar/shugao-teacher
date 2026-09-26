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
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { STUDENT_STATUS_NAME, type Student, type StudentStatus } from '../data/types'
import { compareStudentNo, rosterStateOf } from '../lib/roster'
import { CALL_LIMIT, CUSTOM_MAX, composeCallText } from '../lib/calls'
import { archiveKeyOf } from '../lib/keys'
import { classKindOf } from '../lib/pick'
import { canEditClassFor } from '../lib/roles'
import { subjectName } from '../lib/subjects'
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
import {
  PASSWORD_SHOWN_ONCE,
  apiClassroomAccountStatus,
  apiCreateClassroomAccount,
  apiResetClassroomPassword,
  apiSetClassroomDisabled,
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
  /** 重置前的二次确认浮层 */
  const [roomConfirmResetOpen, setRoomConfirmResetOpen] = useState(false)
  /** 新密码那一张浮层（关掉还能用「看新密码」再打开一次；**重进这一页就没有了**） */
  const [roomPwdOpen, setRoomPwdOpen] = useState(false)
  /** 「为什么看不到原密码」那一页（块右上角那个 ⓘ） */
  const [roomInfo, setRoomInfo] = useState(false)
  /** 换了一个班就重读一次（底下的 `loadRoom` 依赖它） */
  const [roomTick, setRoomTick] = useState(0)
  /** 名单里那些 id（拼成串当依赖：学生一增一删就要重读一次） */
  const profileIds = (klass?.students ?? []).map((s) => s.id).join(',')
  /** 教室端账号那一块的班 id（`''` = 班还没读出来；换班时它变 → 下面那个 effect 重读） */
  const roomId = klass?.id ?? ''

  useEffect(() => {
    if (!klass) return
    let alive = true
    void loadStudentProfiles(klass.students.map((s) => s.id)).then((r) => {
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
  const isStream = classKindOf(klass) === 'stream'
  const [members, setMembers] = useState<Student[]>([])
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
        return
      }
      const tid = rows[0].teacherId
      const r = await listTeachers()
      if (!alive) return
      const t = r.ok ? r.data.teachers.find((x) => x.id === tid) : undefined
      /* ⚠️ 认不出名字时**显示 id 而不是空白**：空白会被读成"没分配"（这个项目最忌的形状） */
      setTeacherName(t?.name ?? tid)
    })()
    return () => {
      alive = false
    }
  }, [id, isStream])

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
   * 屏上那一份名单 = **这一页唯一的名单**：
   *   · 行政班 → `klass.students`（`students.class_id`）；
   *   · 走班班 → `members`（`class_members`，多对多）。
   * 其余（搜索 / 人数 / 空态）全部从它算 —— 两边各写一套就是第二个判定入口。
   */
  const roster = isStream ? members : klass.students
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

  /** 正在编辑的那个学生 —— 编辑面板上要显示他的**序列号（只读）** */
  const editingStudent = klass.students.find((x) => x.id === editing)

  /* ---- 学生档案 ------------------------------------------------------------------
     ⚠️ "摆不摆修改入口"用的就是上面那一个 `canManageThis`（判据只有一处）——
        这里不再算第二遍，也不再另起一个名字。 */
  const profileStudent = klass.students.find((x) => x.id === profileFor)
  const shownProfile = profileFor ? (profiles.get(profileFor) ?? emptyProfile(profileFor)) : null

  const openProfile = (sid: string) => {
    setProfileFor(sid)
    setProfileEdit(false)
    setProfileSaveErr('')
    setProfileForm(profiles.get(sid) ?? emptyProfile(sid))
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
   * 重置密码：**先把代价说清再动手**（旧密码立刻失效 —— 教室那台机器下次登录要用新的）。
   * 🔴 新密码只在这一回合的回话里，**再查一次也拿不到**（库里是哈希），所以浮层上写死那句话。
   */
  const resetRoomPassword = async () => {
    setRoomConfirmResetOpen(false)
    setRoomBusy(true)
    setRoomPwd('')
    const r = await apiResetClassroomPassword(roomId)
    setRoomBusy(false)
    if (!applyRoomResult(r)) return
    setRoomPwd(readAccount(r)?.password ?? '')
    setRoomPwdOpen(true)
    push({ text: '密码已重置', tone: 'warn', desc: '旧密码立刻失效' })
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
              {teacherUnknown ? '没读到' : teacherName || '还没分配'}
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
                          <button
                            type="button"
                            onClick={() => openEdit(s.id)}
                            aria-label="编辑"
                            style={{ color: 'var(--color-ink3)' }}
                          >
                            <IconPencil size={16} />
                          </button>
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
          转班学生请使用「设为已转出」而非删除，历史作业数据会随之保留。
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
                      onClick={() => setRoomConfirmResetOpen(true)}
                    >
                      重置密码
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
      </Page>

      {/*
        「为什么看不到原密码」的那一页（教室端账号块右上角那个 ⓘ）。
        写得短：这里只回答"密码去哪了 / 要密码怎么办"。
      */}
      <Sheet open={roomInfo} onClose={() => setRoomInfo(false)} title="教室端账号">
        <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
          <p>这个班的大屏用一个账号登录，学生能碰到那台机器。</p>
          <p className="mt-2">
            密码存进去就取不出原文了，所以这里看不到。要密码就点「重置密码」——
            会生成一串新的、当场显示一次，旧密码立刻失效。
          </p>
        </div>
      </Sheet>

      {/* 重置密码：**先把代价说清再动手**（它会让教室那台机器下次登录要用新密码） */}
      <Sheet
        open={roomConfirmResetOpen}
        onClose={() => setRoomConfirmResetOpen(false)}
        title="重置密码"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setRoomConfirmResetOpen(false)}>
              取消
            </Button>
            <Button block variant="primary" disabled={roomBusy} onClick={() => void resetRoomPassword()}>
              确认重置
            </Button>
          </div>
        }
      >
        <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.85 }}>
          <p>旧密码立刻失效，教室那台大屏下次登录要用新密码。</p>
          <p className="mt-2">新密码只显示一次，请当场抄下来。</p>
        </div>
      </Sheet>

      {/* 重置结果：新密码**只在这里一次**（关掉就看不到了 —— 库里存的不是原文） */}
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
