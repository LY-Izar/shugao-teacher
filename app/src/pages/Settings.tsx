import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  Logo,
  IconAlert,
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconPencil,
  IconSliders,
  IconSwap,
  IconUpload,
  IconUsers,
  IconWifi,
} from '../components/icons'
import { Button, KV, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
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
  makeBackup,
  pushBackupToCloud,
  readJsonFile,
  validateBackup,
} from '../lib/backup'
import { REMIND_BEFORE, itemsForDate } from '../lib/schedule'
// 只用到时间工具：节假日「数据来源」面板已删（见 功能设计与不变量.md §十七 17.2），
// 判定函数（isRestDay / dayKind / holidayOn / nextHoliday）仍在别处使用，没有动。
import { beijingNow, ymdOf } from '../lib/holiday'
import {
  canManageTeachers,
  currentIdentityLabel,
  IDENTITY_TAG_STYLE,
  isSuperAdmin,
  roleChips,
} from '../lib/roles'
import {
  SUBJECTS,
  DEFAULT_SUBJECT_CODE,
  subjectName,
  teacherPrimarySubjectCode,
  type SubjectCode,
} from '../lib/subjects'

export default function Settings() {
  const teacher = useStore((s) => s.teacher)
  const classes = useStore((s) => s.classes)
  const myRoles = useStore((s) => s.myRoles)
  const schedule = useStore((s) => s.schedule)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const clearAll = useStore((s) => s.clearAll)
  const restoreBackup = useStore((s) => s.restoreBackup)
  const bkRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const mode = connectionMode()

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
      desc: isRemote ? '下次进教师端不用再输密码' : '演示环境没有密码可校验，这一步只是本机标记',
    })
  }

  const total = classes.reduce((n, c) => n + activeStudents(c).length, 0)
  /*
   * 我的身份（班主任 / 年级主任 / 行政 / 最高管理员）。
   * ⚠️ 这两个值**只决定界面上摆不摆入口**，不是判据 ——
   *    「谁能建号、谁能指派身份」由数据库的函数说了算（见 lib/roles.ts 文件头）。
   */
  const chips = roleChips(myRoles, (id) => classes.find((c) => c.id === id)?.name)
  const canManage = isRemote && canManageTeachers(myRoles)
  // 只看教师自己的排课表 —— 班级课表（scope='class'）是教室端给学生看的，混进来数字会对不上
  const todayCount = itemsForDate(schedule.filter((s) => s.scope !== 'class')).length

  const exportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      teacher,
      classes,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `树高教师平台-数据导出-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    push({ text: '已导出全部数据', tone: 'ok', desc: 'JSON 格式，不锁定在平台内' })
  }

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
                color: 'var(--color-accent)',
              }}
            >
              <Logo size={24} />
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
        </Panel>

        {/* 日程表（教师个人的排课表，scope='mine' —— 与班级课表是两套数据） */}
        <div className="mb-4">
          <Sect>我的</Sect>
          <Panel className="overflow-hidden">
            {canManage ? (
              <button
                type="button"
                className="row"
                style={{ padding: 14 }}
                onClick={() => navigate('/accounts')}
              >
                <span
                  className="grid place-items-center shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    border: '1px solid var(--color-line2)',
                    borderRadius: 4,
                    background: 'var(--color-surface2)',
                    color: 'var(--color-accent)',
                  }}
                >
                  <IconUsers size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span style={{ fontSize: 14.5, fontWeight: 620 }}>教师账号</span>
                  <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    建号（带学科）· 任课关系 · 班主任 / 年级主任
                  </span>
                </span>
                <IconChevronRight size={16} />
              </button>
            ) : null}
            {/*
              平台运维（超管面板，`超管运维面板方案.md` 第一期）。

              🔴 判据用 `isSuperAdmin()`，**不是** `canManageTeachers()` ——
                 后者含教导处，而这块屏的定位是**平台维护者**（方案 §3.5 / §5.5 T7）。
                 `lib/roles.ts` 里那个函数一直"没有调用方"，注释写着"留着它是因为
                 『只有最高管理员』这件事仍然是一个**独立的判据**" —— 这里就是它的调用方。

              ⚠️ 这里只是**摆不摆入口**（"少点几下"），**不是安全边界**：
                 真正的闸门在服务端（`/api/admin/config-check` 问数据库的 `is_super_admin()`）。
                 所以 `myRoles` 读不到（表还没建 / 网络错）时这个入口不出现 ——
                 那时候直接从地址栏敲 `/admin` 照样进得去，而且**它不经过 `Guard`**，
                 被标成教室端的机器也打得开（方案 §七 T6）。
            */}
            {isSuperAdmin(myRoles) ? (
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
                    color: 'var(--color-accent)',
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
                  color: 'var(--color-accent)',
                }}
              >
                <IconUpload size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ fontSize: 14.5, fontWeight: 620 }}>教室端文件</span>
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
                  color: 'var(--color-accent)',
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
                onClick={() => {
                  const b = makeBackup(useStore.getState())
                  downloadJson(b, `树高备份-${ymdOf(beijingNow())}.json`)
                  push({ text: `已导出：${backupSummary(b)}`, tone: 'ok' })
                }}
              >
                导出备份文件
              </Button>
              <Button block icon={<IconUpload size={16} />} onClick={() => bkRef.current?.click()}>
                从备份文件恢复
              </Button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              云端是主副本，这份备份是<b>额外</b>一道保险。主要防两件事：
              误点下面的「清空全部数据」、以及换账号时把数据搬过去。
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

        {/* 数据 */}
        <div className="mb-4">
          <Sect>数据</Sect>
          <Panel bodyClass="p-3">
            <div className="flex flex-col gap-2">
              <Button block icon={<IconDownload size={16} />} onClick={exportJson}>
                导出全部数据（JSON）
              </Button>
              <Button
                block
                variant="danger"
                onClick={() => {
                  clearAll()
                  push({ text: '已清空全部数据', tone: 'warn', desc: '包含班级与学生名单' })
                  navigate('/login', { replace: true })
                }}
              >
                清空全部数据
              </Button>
            </div>
          </Panel>
        </div>

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
            <p
              style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}
            >
              ⚠️ 打开教室端会把<b>这台设备</b>标记成教室端（浏览器共用一个标记）——
              之后在这台机器上进教师端，会先要求重新输一次教师密码。
              要改回来，见下面「本机角色」。
            </p>
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
            教室端和教师端用的是<b>同一个账号</b>，所以用「这台设备是不是教室端」来拦住
            "学生在教室里把网址后缀一改就进教师控制台"。在浏览器里打开过一次
            <span className="num"> /classroom </span>
            就会打上教室端标记，想回教师端要重新验一次身份；在这里也可以手动改回来。
            这只是本机标记，不是加密级的安全 —— 真正的隔离要靠教室端独立账号 + 数据库权限。
          </p>
          {role === 'classroom' ? (
            <div
              className="mt-2 flex items-start gap-2.5 p-3"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={16} />
              </span>
              <div style={{ fontSize: 12.5, color: '***REMOVED***8a5a12', lineHeight: 1.65 }}>
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
            <KV k="平台" v="树高教师平台" />
            <KV k="版本" v={<span className="num">v{APP_VERSION}</span>} />
            <KV k="学段学科" v={`高中 · ${subjectName(teacherPrimarySubjectCode(teacher))}`} />
            <KV
              k="存储"
              v={mode === 'remote' ? '云端 · 手机与教室端共用一份' : '本机浏览器 · 未连云端'}
            />
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
      </Page>

      {/* 编辑教师身份 */}
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
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
              setEditing(false)
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
            placeholder="例如 王老师"
          />
        </label>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          这个名字会出现在问候语和账目里。刚注册时它默认取邮箱前缀，建议改成本名。
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
            只在顶部和设置页显示。留空就跟主学科一致；写「物理竞赛」这类也行 ——
            它<b>不参与</b>任何判据。
          </p>
        </label>
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
              改回教师端以后，这台设备就能直接进教师控制台（成绩、名单都在里面）。
              为防学生在一体机上随手改回来，请<b>重新输一次教师密码</b>。
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
            这台设备现在被标记成<b>教室端</b>（在本机打开过 /classroom），
            所以进教师端会被拦去登录页。改回教师端后就不拦了。
            <br />
            <br />
            当前是<b>本地演示模式</b>（没连云端），本机没有可校验的密码，
            所以这一步只是本机标记 —— 它挡的是"改网址"，不是有心人。
          </p>
        )}
      </Sheet>
    </>
  )
}
