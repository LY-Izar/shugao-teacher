import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconPencil,
  IconSend,
  IconSliders,
  IconSwap,
  IconUpload,
  IconWifi,
} from '../components/icons'
import { Button, KV, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { Emblem } from '../components/Emblem'
import { StatusMark, STATUS_MARK_HOLD_MS, type StatusMarkStatus } from '../components/StatusMark'
import { activeStudents, useStore, useToast } from '../data/store'
import { signOutEverywhere } from '../hooks/useAuthBootstrap'
import { connectionMode, getSupabase, isRemote } from '../lib/supabase'
import {
  deviceRole,
  deviceRoleAt,
  restoreTeacherDevice,
  type DeviceRole,
} from '../lib/session'
import { APP_VERSION } from '../lib/version'
import { CHANGELOG } from '../lib/changelog'
import {
  backupSummary,
  downloadJson,
  exportWithProfiles,
  notifyBackupDone,
  pushBackupToCloud,
  readJsonFile,
  validateBackup,
} from '../lib/backup'
import { REMIND_BEFORE, itemsForDate } from '../lib/schedule'
// 只用到时间工具：节假日「数据来源」面板已删（见 功能设计与不变量.md §十七 17.2），
// 判定函数（isRestDay / dayKind / holidayOn / nextHoliday）仍在别处使用，没有动。
import { beijingNow, ymdOf } from '../lib/holiday'
import { toISODate, friendlyDate } from '../lib/date'
import {
  FEEDBACK_MAX,
  FEEDBACK_MIN,
  FEEDBACK_MINE_LIMIT,
  myFeedback,
  submitFeedback,
  type MyFeedback,
} from '../lib/feedback'
import {
  currentIdentityLabel,
  entryVisible,
  roleChips,
  IDENTITY_TAG_STYLE,
} from '../lib/roles'
import {
  SUBJECTS,
  DEFAULT_SUBJECT_CODE,
  subjectName,
  teacherPrimarySubjectCode,
  type SubjectCode,
} from '../lib/subjects'

/**
 * 「备份到云端」那颗状态标记四档各自的文案（见下面 `backupMark` 那处注释）。
 * ⚠️ `done` / `failed` **必须与 `pending` / `running` 不同** —— 否则同一句话
 *    会配着绿勾（或红叉）显示，一句文案说了两件事。
 */
const BACKUP_MARK_LABEL: Record<StatusMarkStatus, string> = {
  pending: '备份到云端',
  running: '正在备份…',
  done: '备份成功',
  failed: '备份失败',
  cancelled: '已取消',
}

/**
 * 「改密码」那三个格的前置校验：三个空串 → **一句人话**，或 null（可以往下走）。
 *
 * 为什么必须逐条分开：AGENTS.md §三.5 —— 不可写的路径要**显式报错**。
 * "太短 / 两次不一致 / 旧密码没填"是三种不同的错，**一句话概括会把原因吃掉**。
 * 拎成模块级纯函数，`nav-checks` 才能对每一档都喂一次（并做反向对照）。
 *
 * 🔴 下限 8 位与建号那支**同一个数**（`functions/api/teacher-account.ts`：
 *    「初始密码至少 8 位」）—— 同一个平台里"什么算合格的密码"只能有一个口径。
 * 🔴 它**只校验形状，不校验旧密码对不对** —— 那件事只有服务器说得清
 *    （见下面 `doChangePassword` 里的 `signInWithPassword`）。
 */
/**
 * 「姓名」那一格的字数上限 = 24 —— 🔴 与**另两条改名的路同一个数**：
 *   · `functions/api/teacher-account.ts` 的 `NAME_MAX = 24`（建号 / 行政管理改名共用，
 *     超了回一句「姓名最多 24 个字（现在 n 个）」）；
 *   · `TeacherAccounts.tsx` 那个输入框的 `maxLength={NAME_MAX}`。
 *
 * 为什么这里必须有：一个字段只能有一种语义。老师在自己这一页能把名字填成 60 个字、
 * `teachers.name` 也真存进去，而行政管理那一页的同一个字段**不许**填那么长 ——
 * 同一个人同一个字段两套规矩，列表还会被那种行撑烂。
 * ⚠️ 只挡输入上限，**不加新校验**：空名仍然由那颗「保存」按钮的 `disabled` 管。
 */
const SELF_NAME_MAX = 24

function pwdIssue(oldPwd: string, next: string, again: string): string | null {
  if (!oldPwd) return '请输入现在的密码'
  if (next.length < 8) return `新密码至少 8 位（现在 ${next.length} 位）`
  if (next !== again) return '两次输入的新密码不一致'
  if (next === oldPwd) return '新密码不能和现在的密码一样'
  return null
}

export default function Settings() {
  const teacher = useStore((s) => s.teacher)
  const classes = useStore((s) => s.classes)
  const myRoles = useStore((s) => s.myRoles)
  const schedule = useStore((s) => s.schedule)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const restoreBackup = useStore((s) => s.restoreBackup)
  const bkRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const mode = connectionMode()

  /* 🆕 反馈（2026-09-29 管理台第二期）—— 状态都在这一页里，不落 store（它是一次性的表单） */
  const [fbBody, setFbBody] = useState('')
  const [fbContact, setFbContact] = useState('')
  const [fbBusy, setFbBusy] = useState(false)
  const [fbMsg, setFbMsg] = useState('')
  const [fbErr, setFbErr] = useState('')
  const [fbRows, setFbRows] = useState<MyFeedback[]>([])
  const [fbLoadErr, setFbLoadErr] = useState('')
  /** 🆕 备份通知（邮件）正在发 */
  const [bkNotifyBusy, setBkNotifyBusy] = useState(false)
  /**
   * 「备份到云端」那颗状态标记的**四档**（`pending` → `running` → `done` / `failed`）。
   *
   * 🔴 为什么不能从 `bkNotifyBusy` 推：那个布尔量只说"忙不忙"，
   * **说不出"成了还是没成"** —— 而绿勾与红叉恰恰是这一档的全部信息量。
   * 所以终态由**真的结果**（`res.ok`）决定，不是"忙完了就当成功"。
   * （StatusMark 自己不会结束：原版组件里没有任何定时器，`running` 会一直转，见组件文件头。）
   */
  const [backupMark, setBackupMark] = useState<StatusMarkStatus>('pending')
  /** 终态那 1.2 秒的计时器：离开这一页就别再 setState */
  const backupMarkTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(backupMarkTimer.current), [])

  /**
   * 「我提过的」：进页面读一次。
   * ⚠️ **读不到就说读不到**（`fbLoadErr`），**不许显示成"还没有提过"** ——
   *    那两句在用户眼里是完全不同的两件事（本项目最贵的一条教训）。
   */
  useEffect(() => {
    if (!isRemote) return
    let alive = true
    void myFeedback().then((r) => {
      if (!alive) return
      if (r.ok) {
        setFbRows(r.rows)
        setFbLoadErr('')
      } else {
        setFbLoadErr(`读不到你提过的反馈：${r.message}`)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const submitFb = async () => {
    if (fbBusy) return
    setFbBusy(true)
    setFbErr('')
    setFbMsg('')
    const res = await submitFeedback({
      body: fbBody,
      contact: fbContact,
      page: '/settings',
      authorRoles: currentIdentityLabel(myRoles, teacher),
    })
    setFbBusy(false)
    if (!res.ok) {
      setFbErr(res.message)
      return
    }
    /* 🔴 文案只说"已送到"（= 已经进库、管理员看得到）——**绝不写"已发到邮箱"** */
    setFbMsg('已送到学校管理员。你可以在下面看到它的处理进度。')
    setFbBody('')
    setFbContact('')
    const again = await myFeedback()
    if (again.ok) setFbRows(again.rows)
  }

  /* 编辑教师身份 */
  const updateTeacher = useStore((s) => s.updateTeacher)
  const [editing, setEditing] = useState(false)
  const [fName, setFName] = useState('')
  const [fSchool, setFSchool] = useState('')
  const [fSubject, setFSubject] = useState('')
  /**
   * 主学科（新作业默认值）与显示名是两个字段、两种语义：
   *  · `primarySubjectCode` 决定"新建作业时学科 chip 预选哪一科"（有约束的字典代码）
   *  · `subject` 只是显示标签（老师想写「物理竞赛」也随他）
   * 以前两件事共用一个字段：在设置页改一下学科，之后新建的作业全变科，
   * 而 `class_subjects` 里的任课关系没动 → 两边不一致（权限判据与实际不符）。
   */
  const [fPrimary, setFPrimary] = useState<SubjectCode>(DEFAULT_SUBJECT_CODE)
  const openEdit = () => {
    setFName(teacher?.name ?? '')
    setFSchool(teacher?.school ?? '')
    // 显示名留空 = 跟主学科一致；这里照实填当前值，不替老师改东西
    setFSubject(teacher?.subject ?? '')
    setFPrimary(teacherPrimarySubjectCode(teacher))
    setEditing(true)
  }

  /* 改自己的密码（放在「我的身份」那张卡里，与姓名 / 主学科并列） */
  const [pwOld, setPwOld] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwNew2, setPwNew2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwErr, setPwErr] = useState('')
  const [pwOk, setPwOk] = useState('')
  const closeEdit = () => {
    setEditing(false)
    setPwOld('')
    setPwNew('')
    setPwNew2('')
    setPwErr('')
    setPwOk('')
  }

  /**
   * 改密码。
   *
   * 🔴 改的**只有自己**这一个会话（`sb.auth.updateUser`）——
   *    **没有任何地方能拿别人的 id 来改密码**；"给别人重置密码"仍旧只走
   *    教师账号那一页（由服务端那一支处理）。这里不碰 RLS、也不碰别人。
   *
   * 为什么要先 `signInWithPassword` 验一次旧密码：这个平台把**最高管理员锁死为一个**
   * （`teacher_roles_one_super`），而 `updateUser` **不校验旧密码** ——
   * 手机被人拿去、或会话留在别人机器上，就能直接把密码换掉、**原主人永久进不来**
   * （没人能给他重置）。所以这里多设一道坎：**改密码必须知道现在的密码**。
   * 代价：会把当前会话重新签一次（下面"改回教师端"那一支已经是同一套做法）。
   */
  const doChangePassword = async () => {
    if (pwBusy) return
    setPwErr('')
    setPwOk('')
    const bad = pwdIssue(pwOld, pwNew, pwNew2)
    if (bad) {
      setPwErr(bad)
      return
    }
    if (!isRemote) {
      setPwErr('本地演示环境没有账号密码，这一项要连上服务器才能用。')
      return
    }
    const sb = getSupabase()
    const email = (await sb?.auth.getUser())?.data.user?.email
    if (!sb || !email) {
      setPwErr('读不到当前账号，请重新登录后再改。')
      return
    }
    setPwBusy(true)
    const check = await sb.auth.signInWithPassword({ email, password: pwOld })
    if (check.error) {
      setPwBusy(false)
      setPwErr('现在的密码不对，没有改动。')
      return
    }
    const { error } = await sb.auth.updateUser({ password: pwNew })
    setPwBusy(false)
    if (error) {
      /* 失败**必须说出来**（网络断了 / 服务器拒了）—— 不许看起来像改成功了 */
      setPwErr(`没改成：${error.message}`)
      return
    }
    setPwOld('')
    setPwNew('')
    setPwNew2('')
    /* 当前这台设备不用重新登录（改的是这个会话自己的密码） */
    setPwOk('密码已改。这台设备不用重新登录，别的设备下次要用新密码。')
  }

  /*
   * 本机角色（这台设备算教室端还是教师端）。
   *
   * 角色存在 localStorage 里，**别的标签页**打开一次 /classroom 就会把它改掉，
   * 所以这里不光在挂载时读，回到这个标签页（focus）时再读一次 ——
   * 否则"打开教室端 → 切回来"看到的还是旧状态，教师会以为没生效。
   */
  const [role, setRole] = useState<DeviceRole>(() => deviceRole())
  const [roleAt, setRoleAt] = useState<number | null>(() => deviceRoleAt())
  useEffect(() => {
    const sync = () => {
      setRole(deviceRole())
      setRoleAt(deviceRoleAt())
    }
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])
  const [restoring, setRestoring] = useState(false)
  const [pwd, setPwd] = useState('')
  const [busyRestore, setBusyRestore] = useState(false)

  /**
   * 把设备改回教师端。
   *
   * 权限：改回教师端 = 拿到教师控制台，门槛必须和"重新登录"一样高 ——
   * 教室那台一体机是共用的，学生不能随手一点就进教师端。
   *  · 云端模式：用**当前登录的账号**复验一次密码（Supabase 重新登一次），
   *    验不过就不改；
   *  · 本地演示模式：本来就没有密码可校验（登录页任意账号密码都能进），
   *    这里只做一次显式确认，并在界面上说明白——不假装它有安全性。
   */
  const doRestore = async () => {
    if (busyRestore) return
    if (isRemote) {
      const sb = getSupabase()
      const email = (await sb?.auth.getUser())?.data.user?.email
      if (!sb || !email) {
        push({ text: '读不到当前账号，请重新登录后再试', tone: 'bad' })
        return
      }
      setBusyRestore(true)
      const { error } = await sb.auth.signInWithPassword({ email, password: pwd })
      setBusyRestore(false)
      if (error) {
        push({
          text: '密码不正确',
          tone: 'bad',
          desc: error.message === 'Invalid login credentials' ? '请输这台设备上登录用的教师密码' : error.message,
        })
        return
      }
    }
    restoreTeacherDevice()
    setRole('teacher')
    setRoleAt(deviceRoleAt())
    setRestoring(false)
    setPwd('')
    push({
      text: '这台设备已改回教师端',
      tone: 'ok',
      desc: isRemote ? '下次进教师端不用再输密码' : '演示环境里只改本机标记',
    })
  }

  const total = classes.reduce((n, c) => n + activeStudents(c).length, 0)
  /*
   * 我的身份（班主任 / 年级主任 / 行政 / 最高管理员）。
   * ⚠️ 这两个值**只决定界面上摆不摆入口**，不是判据 ——
   *    「谁能建号、谁能指派身份」由数据库的函数说了算（见 lib/roles.ts 文件头）。
   */
  const chips = roleChips(myRoles, (id) => classes.find((c) => c.id === id)?.name)
  /*
   * 🔴 这一页里那些入口的显隐，**一律读 `lib/roles.ts` 的入口表**（方案 §2.4 / N2）。
   *
   * 为什么不能在这里各写一句 `canManageTeachers(myRoles)`：那正是"同一件事两个判定入口"
   * （本仓库踩过四次的坑，§十）。
   *
   * ⚠️ 2026-10-01「行政管理」轮：**年级管理 / 档案管理 / 教师管理那三行搬走了** ——
   *    它们现在在 `/manage` 那一页上（`pages/Administration.tsx`），
   *    判据与文案一个字没变，只是换了个地方摆（原来这一页挂三行、现在挂一行入口）。
   *    这一页**只留「平台运维」那一行**（`/admin`：超管专属、不是行政管理的一部分）。
   *
   * ⚠️ `isRemote &&`**不是身份判据**，是"这个功能在本地演示模式下根本没有"：
   *    `/admin` 要 Supabase 会话（本地没有）。身份那一半一律走 `entryVisible()`。
   */
  const canAdmin = isRemote && entryVisible('/admin', myRoles)
  // 只看教师自己的排课表 —— 班级课表（scope='class'）是教室端给学生看的，混进来数字会对不上
  const todayCount = itemsForDate(schedule.filter((s) => s.scope !== 'class')).length

  return (
    <>
      <PageHead title="我的" sub="账号 · 数据 · 关于" />
      <Page>
        {/* 身份 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <div className="flex items-center gap-3 p-4">
            <span
              className="grid place-items-center shrink-0"
              style={{
                width: 46,
                height: 46,
                border: '1px solid var(--color-line2)',
                borderRadius: 6,
                background: 'var(--color-surface2)',
                color: 'var(--color-accenttext)',
              }}
            >
              {/* 🔴 校徽，不是平台的旧品牌标 —— 24px 也用**全徽**（2026-10-11 用户
                  「把所有这种（纯徽标）全部换成（全徽标）」）。
                  ⚠️ 实测 `落地清单.md` §9.1：全徽 24px 外圈线只有 **0.50px**、"刚够半个像素"、
                  圆半实半虚 —— 观感如实写进《功能设计与不变量.md》，是用户知情后的选择，
                  **别再有人把它当 bug 改回去**（那一档已经整条删掉，没有第二种图了）。
                  位图见 `public/emblem/emblem-24.png`（2x = `emblem-48.png`）。 */}
              <Emblem n={24} data-settings-emblem />
            </span>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 17, fontWeight: 660 }}>{teacher?.name ?? '未登录'}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {/*
                  身份卡上那个标签：**有管理身份显示身份（多个全露），没有才显示学科**。
                  完整清单（带班名）在下面「我的身份」那一行（`roleChips()`）。
                  ⚠️ 这一行必须 `flex-wrap`：手机上（414px）可用宽度只有约 216px，
                  3 个身份时实测这一行会横向溢出 18px、4 个身份溢出 72px ——
                  溢出的正是右边那个学校标签（被面板裁掉，看不出是"少了东西"）。
                  ⛔ 注意别把下面「学段学科」那一行也改了：那一行要的就是学科。
                */}
                <span className="tag tag-accent" style={IDENTITY_TAG_STYLE}>
                  {currentIdentityLabel(myRoles, teacher)}
                </span>
                <Tag tone="idle">{teacher?.school || '未填学校'}</Tag>
              </div>
            </div>
            <Button size="sm" variant="ghost" icon={<IconPencil size={14} />} onClick={openEdit}>
              编辑
            </Button>
          </div>
          <div className="px-4 pb-3">
            <KV k="任教班级" v={`${classes.length} 个 · ${total} 名学生`} />
            {isRemote ? (
              <KV
                k="我的身份"
                v={
                  chips.length ? (
                    <span className="flex flex-wrap items-center gap-1">
                      {chips.map((c) => (
                        <Tag key={c} tone="accent">
                          {c}
                        </Tag>
                      ))}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--color-ink3)' }}>任课教师（还没指派别的身份）</span>
                  )
                }
              />
            ) : null}
            <KV
              k="当前班级"
              v={
                <select
                  className="input"
                  style={{ height: 32, fontSize: 13, width: 'auto', display: 'inline-block' }}
                  value={currentClassId ?? ''}
                  onChange={(e) => setCurrentClass(e.target.value || null)}
                >
                  {classes.length === 0 ? <option value="">暂无班级</option> : null}
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
          {/*
            🔴 2026-10-09：**退出登录从整页最底下挪到这里**（用户实测："我的"这一页很长，
               那个按钮在最底下 = 找不到 = "应该有一个"）。
               ⚠️ 是**挪，不是复制** —— 这一页上只有这一处（`shots.mjs` 有一条断言钉着）。
               ⚠️ 那两句行为**一个字都没改**（`signOutEverywhere()` + `navigate('/login', {replace:true})`）：
                  一次误触 = 全校 100 多人重登，这套口径是用户拍板过的，别顺手"优化"它。
               ⚠️ 也不碰 `MaintenanceGate` 那句"维护期间不会被登出"的口径（那是**另一件事**：
                  它说的是"维护不会把你踢出去"，与这个按钮无关）。
          */}
          <div className="px-4 pb-4">
            <div className="border-t border-line pt-3">
              <Button
                block
                icon={<IconLogout size={16} />}
                onClick={() => {
                  void signOutEverywhere()
                  navigate('/login', { replace: true })
                }}
              >
                退出登录
              </Button>
            </div>
          </div>
        </Panel>

        {/* 日程表（教师个人的排课表，scope='mine' —— 与班级课表是两套数据） */}
        <div className="mb-4">
          <Sect>我的</Sect>
          <Panel className="overflow-hidden">
            {/*
              平台运维（超管面板，`超管运维面板方案.md` 第一期）。

              🔴 判据读表（`entryVisible('/admin', …)`），而表里那一格是
                 **`isSuperAdmin`，不是 `canManageTeachers`** ——
                 后者含教务处，而这块屏的定位是**平台维护者**（方案 §3.5 / §5.5 T7）。
                 `nav-checks.mjs` 的 A6 专门钉这一格：`[admin]` 对 `/accounts` 是 true、
                 对 `/admin` 必须是 false（"最高管理员 ≠ 教务处"在入口层的唯一断言点）。

              ⚠️ 这里只是**摆不摆入口**（"少点几下"），**不是安全边界**：
                 真正的闸门在服务端（`/api/admin/config-check` 问数据库的 `is_super_admin()`）。
                 所以 `myRoles` 读不到（表还没建 / 网络错）时这个入口不出现 ——
                 那时候直接从地址栏敲 `/admin` 照样进得去，而且**它不经过 `Guard`**，
                 被标成教室端的机器也打得开（方案 §七 T6）。
            */}
            {canAdmin ? (
              <button
                type="button"
                className="row"
                style={{ padding: 14 }}
                onClick={() => navigate('/admin')}
              >
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 4,
                    background: 'var(--color-surface2)',
                    color: 'var(--color-accenttext)',
                  }}
                >
                  <IconSliders size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span style={{ fontSize: 14.5, fontWeight: 620 }}>平台运维</span>
                  <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    版本 / 配置 / 备份 / 结构漂移 / 数据矛盾 —— 只读体检屏
                  </span>
                </span>
                <IconChevronRight size={16} />
              </button>
            ) : null}
            <button type="button" className="row" style={{ padding: 14 }} onClick={() => navigate('/files')}>
              <span
                className="grid place-items-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  background: 'var(--color-surface2)',
                  color: 'var(--color-accenttext)',
                }}
              >
                <IconUpload size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ fontSize: 14.5, fontWeight: 620 }}>传到教室大屏</span>
                <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  把题图、PDF、HTML、PPT 传到教室一体机上打开
                </span>
              </span>
              <IconChevronRight size={16} />
            </button>
            <button type="button" className="row" style={{ padding: 14 }} onClick={() => navigate('/schedule')}>
              <span
                className="grid place-items-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  background: 'var(--color-surface2)',
                  color: 'var(--color-accenttext)',
                }}
              >
                <IconCalendar size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ fontSize: 14.5, fontWeight: 620 }}>日程表</span>
                <span
                  className="mt-0.5 block"
                  style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                >
                  录入上课与日程 · 上课前 {REMIND_BEFORE} 分钟提醒
                </span>
              </span>
              <Tag tone={todayCount > 0 ? 'accent' : 'idle'}>今天 {todayCount} 项</Tag>
              <IconChevronRight size={16} />
            </button>
          </Panel>
        </div>

        {/* 备份与恢复 */}
        <div className="mb-4">
          <Sect>备份与恢复</Sect>
          <Panel bodyClass="p-3">
            <input
              ref={bkRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try {
                  const v = validateBackup(await readJsonFile(f))
                  if (!v.ok) {
                    push({ text: v.why, tone: 'bad' })
                    return
                  }
                  const yes = window.confirm(
                    `确定用这份备份覆盖当前数据吗？\n\n${backupSummary(v.data)}\n备份时间：${new Date(v.data.at).toLocaleString()}\n\n当前数据会被替换，此操作不可撤销。`,
                  )
                  if (!yes) return
                  restoreBackup(v.data)
                  const msg = await pushBackupToCloud(v.data, teacher?.id ?? '')
                  push({ text: msg, tone: 'ok' })
                } catch (err) {
                  push({ text: err instanceof Error ? err.message : '这个文件读不了', tone: 'bad' })
                }
              }}
            />
            <div className="flex flex-col gap-2">
              <Button
                block
                icon={<IconDownload size={16} />}
                onClick={async () => {
                  /*
                   * 🆕 2026-10：走 `exportWithProfiles()`（而不是直接 `makeBackup`）——
                   * 学生档案 / 教师档案在**两张独立的表**里，必须异步读出来一起打包，
                   * 否则老师点这个按钮搬走的数据里**没有家长电话 / 家庭住址 / 老师住址**
                   * （这是这一轮补的那个静默缺口）。
                   * ⚠️ 读不到时**照样导出**，但把原因说出来（`desc`）——
                   * 少两张表也比"什么都没导出"强，而"缺了却不说"是不可接受的。
                   */
                  const r = await exportWithProfiles(useStore.getState())
                  downloadJson(r.data, `树高备份-${ymdOf(beijingNow())}.json`)
                  push({
                    text: `已导出：${backupSummary(r.data)}`,
                    tone: 'ok',
                    ...(r.issues.length ? { desc: `这份文件里没有学生/教师档案（${r.issues[0]}）` } : {}),
                  })
                }}
              >
                导出备份文件
              </Button>
              {/*
                🆕 2026-09-29 管理台第二期：「**毕业备份**」那条链的落点
                   —— 备份 → 发信 → **发不出去就不许删**。

                ⚠️ 为什么要有这个按钮：备份通知邮件是"毕业归档 / 换账号搬数据"这类
                   一次性动作的留痕。没有它，那条链只有在真出毕业那件事时才第一次运行
                   —— 而它没跑通过的东西，不该压在一次不可逆的操作上。
                ⚠️ 发信失败时**必须显式说"先别删那份文件"**（这就是"不许删"的落地）。
              */}
              <Button
                block
                icon={<IconSend size={16} />}
                disabled={bkNotifyBusy}
                data-backup-notify
                onClick={async () => {
                  /* 与「导出备份文件」同一个入口（档案要一起带上，读不到就把原因说出来） */
                  const r = await exportWithProfiles(useStore.getState())
                  downloadJson(r.data, `树高备份-${ymdOf(beijingNow())}.json`)
                  setBkNotifyBusy(true)
                  window.clearTimeout(backupMarkTimer.current)
                  setBackupMark('running')
                  const res = await notifyBackupDone(`本机备份已导出：${backupSummary(r.data)}`, `文件：树高备份-${ymdOf(beijingNow())}.json`)
                  setBkNotifyBusy(false)
                  /* 🔴 终态取**真结果**：`res.ok` 是绿勾、否则红叉（红叉停住不回到 `pending`） */
                  setBackupMark(res.ok ? 'done' : 'failed')
                  if (res.ok) {
                    push({
                      text: '备份已存到云端',
                      tone: 'ok',
                      ...(r.issues.length ? { desc: `这份文件里没有学生/教师档案（${r.issues[0]}）` } : {}),
                    })
                    /* ✅ 绿勾亮满 `STATUS_MARK_HOLD_MS` 再回到常态（时长只有共享常量那一处） */
                    backupMarkTimer.current = window.setTimeout(
                      () => setBackupMark('pending'),
                      STATUS_MARK_HOLD_MS,
                    )
                  } else {
                    /* 🔴 **不发假成功**：没存上就说没存上，并把"不许删"讲清楚 */
                    push({
                      text: '备份已导出，但没能存到云端',
                      tone: 'warn',
                      desc: `${res.message}，没存上就先别删刚才那份备份文件`,
                    })
                  }
                }}
              >
                {/* StatusMark 是**替换**那句 `{busy ? '正在备份…' : '备份到云端'}` —— 这一处是
                    全站最长的等待（导出整库 + 上传，秒级到十秒级），原来十秒里屏幕上没有任何
                    "还活着"的迹象。`cancelled` 那一档**不给 `--color-bad`**（照原版）。
                    ⚠️ 文案按四档给全（`done` / `failed` 各自不同），否则"正在备份…"会
                       配着绿勾/红叉显示，等于一句话说两件事。 */}
                <StatusMark
                  status={backupMark}
                  size={16}
                  label={BACKUP_MARK_LABEL[backupMark]}
                  /* 🔴 `strike={false}`：平台气质偏克制，那个删除线表达的是"作废"，
                     而这两处说的都是"跑完了" —— 见组件文件头。 */
                  strike={false}
                  style={{ justifyContent: 'center' }}
                />
              </Button>
              <Button block icon={<IconUpload size={16} />} onClick={() => bkRef.current?.click()}>
                从备份文件恢复
              </Button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              云端是主副本，这份备份是<b>额外</b>一道保险 —— 换账号、换设备时把数据搬过去。
            </p>
          </Panel>
        </div>

        {/*
          这里原来还有一个「重置为演示数据」按钮（直接调 store.resetDemo，且没有二次确认）。
          2026-09 按用户要求删除：那个功能用不到，而且**很危险** ——
          本地模式下 `resetDemo` 会用一份演示快照整份替换当前 state，
          老师真实录入的班级 / 名单 / 作业全没了，还没法撤销。
          别以为是漏做了又加回来（见 功能设计与不变量.md §十七 17.1）。
        */}

        {/*
          这里原来还有一整栏「数据」：**导出全部数据（JSON）** + **清空全部数据**。
          2026-09-26 按用户要求**连那一栏一起删掉**（含小标题，不留空标题）。

          为什么该删：这个平台马上要装 **1000+ 学生**的真实数据，而「清空全部数据」
          是个**客户端按钮** —— 点错一次就是全校数据没了，且不可撤销。
          备份那条线（导出备份文件 / 备份到云端 / 从备份文件恢复）
          本来就够用，它才是那条该走的保险。别以为是漏做了又加回来
          （见 功能设计与不变量.md §十七 17.3）。
        */}

        {/* 教室端 */}
        <div className="mb-4">
          <Sect>教室端</Sect>
          <Panel bodyClass="p-3">
            <div
              className="mb-3 flex items-start gap-2.5"
              style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}
            >
              <IconWifi size={15} />
              <span>
                在教室一体机上用 <b>Edge / Chrome</b> 打开下面这个地址，点一次「启动置顶小窗」即可。
                小窗会浮在全屏的新教育平台之上，显示当前题号与正确率。
              </span>
            </div>
            <div
              className="flex items-center gap-2 p-3"
              style={{
                background: 'var(--color-surface2)',
                border: '1px solid var(--color-line)',
                borderRadius: 4,
              }}
            >
              <code
                className="flex-1 truncate"
                style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--color-ink2)' }}
              >
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/classroom`
                  : '/classroom'}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  const url = `${window.location.origin}/classroom`
                  void navigator.clipboard?.writeText(url)
                  push({ text: '已复制教室端地址', tone: 'ok' })
                }}
              >
                复制
              </Button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                block
                icon={<IconChevronRight size={14} />}
                onClick={() => window.open('/classroom', '_blank')}
              >
                在新标签页打开教室端
              </Button>
            </div>
          </Panel>
        </div>

        {/* 本机角色：教室端 / 教师端 —— 复原入口 */}
        <div className="mb-4">
          <Sect>本机角色</Sect>
          <Panel bodyClass="px-4 py-2">
            <KV
              k="这台设备"
              v={
                role === 'classroom' ? (
                  <Tag tone="warn">教室端</Tag>
                ) : (
                  <Tag tone="ok">教师端</Tag>
                )
              }
            />
            <KV
              k="标记时间"
              v={
                roleAt ? (
                  <span className="num">
                    {new Date(roleAt).toLocaleString('zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                ) : (
                  '—'
                )
              }
            />
          </Panel>
          <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
            这是本机标记，换台设备不生效。
          </p>
          {role === 'classroom' ? (
            <div
              className="mt-2 flex items-start gap-2.5 p-3"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid var(--color-warnline)',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={16} />
              </span>
              <div style={{ fontSize: 12.5, color: 'var(--color-warnink)', lineHeight: 1.65 }}>
                这台设备现在是<b>教室端</b>：在这台机器上进教师端会先被拦去登录页。
                输一次教师密码即可自动改回教师端，或者直接点下面的按钮。
              </div>
            </div>
          ) : null}
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              size="sm"
              block
              variant={role === 'classroom' ? 'primary' : 'default'}
              icon={<IconSwap size={14} />}
              disabled={role !== 'classroom'}
              onClick={() => {
                setPwd('')
                setRestoring(true)
              }}
            >
              {role === 'classroom' ? '改回教师端' : '已是教师端'}
            </Button>
          </div>
        </div>

        {/*
          这里原来有一块「节假日与调休」面板（数据存储 / 数据来源 / 覆盖年份 / 校准时间
          + 一段数据来源说明）。2026-09 按用户要求整块删除（"用不着说明"，
          见 功能设计与不变量.md §十七 17.2）。
          ⚠️ 只是删显示：节假日与调休的**判断**一处都没动 ——
             `isRestDay` / `dayKind` / `holidayOn` / `nextHoliday` 以及
             `data/holidays.ts` 的数据仍被教室端（今天放假 / 下课铃）和周一顺延使用。
             别因为这里空了就把 lib/holiday.ts 当成死代码删掉。
        */}

        {/* 关于 */}
        <div className="mb-4">
          <Sect>关于</Sect>
          <Panel bodyClass="px-4 py-2">
            <KV k="平台" v="树高教务通" />
            <KV k="版本" v={<span className="num">v{APP_VERSION}</span>} />
            <KV k="学段学科" v={`高中 · ${subjectName(teacherPrimarySubjectCode(teacher))}`} />
            <KV
              k="存储"
              v={mode === 'remote' ? '云端 · 手机与教室端共用一份' : '本机浏览器 · 未连云端'}
            />
          </Panel>
        </div>

        {/*
          🆕 反馈（2026-09-29 管理台第二期）—— **用户点名的位置**：
             「我的」页面最下面、**更新日志之前**（这一块与「关于」之间没有别的东西，
             下一次整理页面顺序时**别把它挪走** —— `shots.mjs` 有一条 DOM 顺序断言钉着）。

          🔴 三条口径（都写在 `功能设计与不变量.md` §二十五）：
             · **先落库、再发信**：发信失败**不改变**用户看到的结果 ——
               所以这里只说"已送到"（送到管理员那儿 = 已经进库了），
               **绝不写"已发到邮箱"**（那是我们控制不了的事）；
             · **只给管理员看、不会出现在通知里**（用户点名要处理这个混淆）；
             · **不允许匿名提交** —— 登录不上 / 页面报错走的是**前端错误上报**
               （那个匿名也能报）。
        */}
        <div className="mb-4" data-feedback-block>
          <Sect>反馈</Sect>
          <Panel bodyClass="p-3">
            <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.8 }}>
              遇到问题、想提建议，写在这里 —— 会直接送到学校管理员。
              <br />· 登录不上、或者某个页面报错打不开：不用写在这里，系统会自动上报。
            </div>
            <textarea
              className="input mt-2.5"
              style={{ minHeight: 84, fontSize: 13, lineHeight: 1.75 }}
              placeholder={`${FEEDBACK_MIN}–${FEEDBACK_MAX} 个字。写清在哪个页面、点了什么、看到什么。`}
              value={fbBody}
              onChange={(e) => setFbBody(e.target.value)}
              data-feedback-input
            />
            <input
              className="input mt-2"
              style={{ height: 34, fontSize: 13 }}
              placeholder="要不要留个联系方式？（选填，方便回你）"
              value={fbContact}
              onChange={(e) => setFbContact(e.target.value)}
              data-feedback-contact
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={fbBusy || fbBody.trim().length < FEEDBACK_MIN}
                onClick={() => void submitFb()}
                data-feedback-submit
              >
                {fbBusy ? '正在发送…' : '提交反馈'}
              </Button>
              <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                提交后可以在下面看到处理进度。
              </span>
            </div>
            {fbMsg ? (
              <div
                className="mt-2 flex items-center gap-1.5"
                style={{ fontSize: 12.5, color: 'var(--color-ok)' }}
                data-feedback-ok
              >
                <IconCheck size={14} />
                {fbMsg}
              </div>
            ) : null}
            {fbErr ? (
              <div
                className="mt-2 flex items-center gap-1.5"
                style={{ fontSize: 12.5, color: 'var(--color-bad)' }}
                data-feedback-err
              >
                <IconAlert size={14} />
                {fbErr}
              </div>
            ) : null}

            <div className="mt-3 border-t border-line pt-2.5">
              <div style={{ fontSize: 12, fontWeight: 620, color: 'var(--color-ink3)' }}>
                我提过的（最近 {FEEDBACK_MINE_LIMIT} 条）
              </div>
              {fbRows.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--color-ink4)', marginTop: 4 }}>
                  {fbLoadErr ? fbLoadErr : '还没有提过。'}
                </div>
              ) : (
                fbRows.map((r) => (
                  <div
                    key={r.id}
                    className="mt-2"
                    style={{ fontSize: 12.5, lineHeight: 1.7 }}
                    data-feedback-mine={r.id}
                  >
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1" style={{ wordBreak: 'break-word' }}>
                        {r.body}
                      </span>
                      <Tag tone={r.status === '已处理' ? 'ok' : undefined}>{r.status}</Tag>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                      {r.createdAt ? `${friendlyDate(toISODate(new Date(r.createdAt)))}` : ''}
                      {r.reply ? ` · 管理员回复：${r.reply}` : ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Panel>
        </div>

        {/* 更新日志 */}
        <div className="mb-4">
          <Sect>更新日志</Sect>
          <Panel bodyClass="p-3">
            {/*
              内容在 `lib/changelog.ts`（与 APP_VERSION 同一处，发版只改那两个文件）。
              这一页只负责渲染 —— 以前它把整份日志硬编码在这儿，
              结果「关于」写着 v0.9.0、这份日志停在 0.8.0，同一页自己跟自己打架。
            */}
            {CHANGELOG.map((log) => (
              <div key={log.v} className="mb-3 last:mb-0">
                <div className="flex items-baseline gap-2">
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700 }}>
                    v{log.v}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>{log.at}</span>
                </div>
                <ul
                  style={{
                    fontSize: 12.5,
                    color: 'var(--color-ink2)',
                    lineHeight: 1.9,
                    paddingLeft: 16,
                    listStyle: 'disc',
                    marginTop: 2,
                  }}
                >
                  {log.items.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            ))}
          </Panel>
        </div>
      </Page>

      {/* 编辑教师身份 —— 包括**改自己的密码**（用户 2026-10-11：都放在这一张卡里） */}
      <Sheet
        open={editing}
        onClose={closeEdit}
        title="我的身份"
        footer={
          <Button
            block
            variant="primary"
            disabled={!fName.trim()}
            onClick={() => {
              updateTeacher({
                name: fName.trim(),
                school: fSchool.trim(),
                // 显示名留空 = 跟主学科一致（不是"没填"，所以不留空串）
                subject: fSubject.trim() || subjectName(fPrimary),
                primarySubjectCode: fPrimary,
              })
              closeEdit()
              push({ text: '已保存', tone: 'ok' })
            }}
          >
            保存
          </Button>
        }
      >
        <label className="block">
          <span className="label">姓名</span>
          <input
            className="input"
            value={fName}
            onChange={(e) => setFName(e.target.value)}
            maxLength={SELF_NAME_MAX}
            placeholder="例如 王老师"
          />
        </label>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          这个名字会出现在问候语和账目里，建议写本名。
        </p>
        <label className="mt-4 block">
          <span className="label">学校</span>
          <input
            className="input"
            value={fSchool}
            onChange={(e) => setFSchool(e.target.value)}
            placeholder="例如 示例中学"
          />
        </label>
        <label className="mt-4 block">
          <span className="label">主学科</span>
          <select
            className="input"
            value={fPrimary}
            onChange={(e) => setFPrimary(e.target.value as SubjectCode)}
          >
            {SUBJECTS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
            新建作业时，学科会<b>默认选好这一科</b>，不用每次去点。
            改这里只影响之后新建的档案，已经建好的作业不受影响。
          </p>
        </label>
        <label className="mt-4 block">
          <span className="label">显示名称（可留空）</span>
          <input
            className="input"
            value={fSubject}
            onChange={(e) => setFSubject(e.target.value)}
            placeholder={subjectName(fPrimary)}
          />
          <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
            只在顶部和设置页显示。留空就跟主学科一致；写「物理竞赛」这类也行。
          </p>
        </label>

        {/*
          改自己的密码。
          🔴 用户 2026-10-11：「加一个吧，都放在我的页面的那个身份卡里面」——
             所以它在**这张「我的身份」卡里**，与姓名 / 主学科并列（不是另开一张卡）。
          🔴 为什么必须有：平台把**最高管理员锁死为一个**（`teacher_roles_one_super`），
             他自己忘了密码没人能给他重置 —— 只能自己改。
          ⚠️ 这里改的**只有当前这个会话自己**（`sb.auth.updateUser`），
             全仓没有"拿别人的 id 改密码"的路；给别人重置在教师账号那一页。
          ⚠️ 文案只说"这里是什么、我能做什么"（§七），不解释实现。
        */}
        <div
          className="mt-5 border-t border-line pt-4"
          data-change-password
        >
          <span className="label">改密码</span>
          <label className="mt-2 block">
            <span className="label">现在的密码</span>
            <input
              className="input"
              type="password"
              value={pwOld}
              onChange={(e) => setPwOld(e.target.value)}
              placeholder="现在用的那一个"
              autoComplete="current-password"
            />
          </label>
          <label className="mt-3 block">
            <span className="label">新密码</span>
            <input
              className="input"
              type="password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </label>
          <label className="mt-3 block">
            <span className="label">再输一遍新密码</span>
            <input
              className="input"
              type="password"
              value={pwNew2}
              onChange={(e) => setPwNew2(e.target.value)}
              placeholder="两次要一样"
              autoComplete="new-password"
            />
          </label>
          {/*
            🔴 失败与成功都**显式上屏**（§三.5）：太短 / 两次不一致 / 旧密码不对 /
               网络或权限失败，各自说各自的；成功后也说清"这台设备不用重新登录"。
          */}
          {pwErr ? (
            <p
              data-pwd-err
              role="alert"
              style={{ fontSize: 12, color: 'var(--color-danger, #c0392b)', marginTop: 8, lineHeight: 1.7 }}
            >
              {pwErr}
            </p>
          ) : null}
          {pwOk ? (
            <p
              data-pwd-ok
              style={{ fontSize: 12, color: 'var(--color-ink2)', marginTop: 8, lineHeight: 1.7 }}
            >
              {pwOk}
            </p>
          ) : null}
          <div className="mt-3">
            <Button
              block
              data-change-password-btn
              /*
               * 🔴 **只有"正在改"时才禁用** —— 空格子也让它点得下去。
               *    为什么（`nav-checks` D13-A 那条的 UI 对应）：按钮一禁用，
               *    那颗按钮就**什么都不说**了 —— "还没填旧密码"这一档就永远上不了屏，
               *    而这正是本项目最贵的那条教训（§三.5：不许静默）。
               *    点下去 → 由 `pwdIssue()` 逐条说清是哪一格的问题。
               */
              disabled={pwBusy}
              onClick={() => void doChangePassword()}
            >
              {pwBusy ? '正在改…' : '改密码'}
            </Button>
          </div>
        </div>
      </Sheet>

      {/* 改回教师端：先验身份，再改标记 */}
      <Sheet
        open={restoring}
        onClose={() => {
          setRestoring(false)
          setPwd('')
        }}
        title="把这台设备改回教师端"
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setRestoring(false)}>
              算了
            </Button>
            <Button
              block
              variant="primary"
              icon={<IconCheck size={16} />}
              disabled={busyRestore || (isRemote && !pwd)}
              onClick={() => void doRestore()}
            >
              {busyRestore ? '正在验证…' : '确认改回教师端'}
            </Button>
          </div>
        }
      >
        {isRemote ? (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
              改回教师端以后，这台设备就能直接进教师控制台。
              请<b>重新输一次教师密码</b>。
            </p>
            <label className="mt-3 block">
              <span className="label">教师密码</span>
              <input
                className="input"
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="输这台设备上登录用的密码"
                autoComplete="current-password"
              />
            </label>
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
            这台设备现在被标记成<b>教室端</b>，所以进教师端会被拦去登录页。
            改回教师端后就不拦了。
          </p>
        )}
      </Sheet>
    </>
  )
}
