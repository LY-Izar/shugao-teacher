import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconCheck, IconPlus, IconRefresh, IconUser, IconX } from '../components/icons'
import { Button, Empty, Panel, PageHead, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import {
  NAME_MAX,
  assignSubject,
  createTeacher,
  listTeachers,
  renameTeacher,
  resetTeacherPassword,
  saveTeacherProfile,
  setDepartment,
  setRole,
  type CreatedAccount,
  type Directory,
  type DirTeacher,
} from '../lib/accounts'
import { DEPARTMENTS, departmentName } from '../lib/departments'
import { goBackOr } from '../lib/back'
import { canAssignRoles, canManageTeachers, roleName } from '../lib/roles'
import { SUBJECTS, asSubjectCode, subjectName } from '../lib/subjects'
import {
  TEACHER_PROFILE_FIELDS,
  loadTeacherProfiles,
  type TeacherProfile,
} from '../lib/teacherProfile'

/**
 * 教师账号（建号 · 主学科 · 任课关系 · 身份 · 🆕部门 · 🆕显示姓名 · 🆕教师档案）。
 *
 * 六件事在这一页上合起来才有用：
 *   ① **建号时就带上学科** —— 落进 `teachers.primary_subject_code`，
 *      新老师第一次登录时新建作业的学科 chip 就是预选好的那一科，不是物理。
 *   ② **任课关系**（谁教哪个班哪一科）—— 它决定这位老师登录后
 *      看得见哪些班、以及**哪一科的作业**（见 `schema.sql` §13.4 的读策略）。
 *   ③ **身份** —— 班主任 / 年级主任看一个班（年级）的**所有学科**；
 *      最高管理员和教导处都能管账号、**都能指派身份**
 *      （用户 2026-09-27：「班主任，年级主任的身份也要由行政管理（教导处）给」）。
 *   ④ 🆕 **部门**（2026-09-28 第二轮）—— 他属于哪个**职能部门**
 *      （办公室 / 教务处 / 总务处 / 德育处）。它决定**通知能不能发到他**：
 *      教务处发一条"发给教务处"的通知，这个部门里的人就收得到。
 *      ⚠️ 两点与身份不同：**一个人可以属于多个部门**、**也可以一个都不属于**（纯任课老师）；
 *      而且它**不是身份**（教务处的干事属于教务处，但没有 `admin` 的全部权限）。
 *      维护判据与"建号"同一档（超管 / 教务处 / 办公室主任），详情见服务端那两句注释。
 *   ⑤ 🆕 **显示姓名**（2026-09-28 第三轮）—— 姓名打错了、或写法要统一（"李老师" / "李某某"）时改它。
 *      它与部门一样是**档案属性**，判据同"建号"那一档；
 *      🔴 改的只是 `teachers.name`，**不动登录账号**：任教关系 / 身份 / 部门 / 登录方式一字不变。
 *   ⑥ 🆕 **教师档案**（2026-10-06）—— **家庭住址 / 电话号码 / 邮箱**（用户口径原话：
 *      「除了给老师建号，应该也可以记录老师的个人信息的，例如家庭住址，电话号码，邮箱」）。
 *      · 表是 `teacher_profiles`（`schema.sql` §1.1，与 `students` 那一侧的
 *        `student_profiles` 同一套做法：**RLS 只能按行收口、不能按列**，
 *        所以个人信息放**单独一张表**，而不是 `teachers` 上加三列）。
 *      · 判据：**读** = 自己那一行 ∪ `can_create_teacher_accounts()`；**写** = 同一个判据。
 *        🔴 **班主任 / 年级主任不在里面** —— 老师的家庭住址不是班主任该看的。
 *      · 三个字段**全可空**：没录过就是空着，建号那条路一个字都不碰它。
 *      · 🔴 `email` 是**联系邮箱**，不是登录账号（登录名在 `auth.users.email`）。
 *
 * 🔴 这一页的按钮显隐只是"少点几下"，**不是判据**：
 *    真正的闸门在服务端（`functions/api/teacher-account.ts` 拿你的 JWT 去问
 *    数据库的 `can_create_teacher_accounts()` / `can_assign_roles()` / `is_super_admin()`）。
 *    所以就算有人把这一页的入口撬开，他也什么都做不成 —— 包括那条"显示姓名"：
 *    它摆不摆由 `canManage` 决定，写不写得进去由服务端问数据库决定。教师档案同理
 *    （读那一侧另有数据库的行策略兜着：读得到名单 ≠ 读得到档案）。
 */
/**
 * 每一档身份的**范围形状** + 界面上的那句说明（下拉里的一条 = 一行）。
 *
 * 🆕 2026-09-28：14 档身份里有**五种**形状（`none` / `grade` / `class` / `subject` /
 * `grade_subject`）。它必须与服务端的 `SCOPE_OF`（`functions/api/teacher-account.ts`）
 * **逐档相同**：服务端按同一张表拼过滤条件，两边不一致就会出现
 * "指派成功了、判据却匹配不到"（而这一页**看不出**任何异常）。
 * ⚠️ 以服务端为准：这里是把那张表照着写一份给界面用。
 *
 * ⚠️ **`teacher`（任课教师）刻意不在这一组里**：它不是一个"头衔"，
 *    而是 `class_subjects` 里的任课关系（见 `schema.sql` §10.6）——
 *    上面那一块"任课关系"就是它。
 */
const ROLE_ITEMS: { code: string; note: string }[] = [
  { code: 'grade_head', note: '看本年级所有学科' },
  { code: 'head_teacher', note: '看本班所有学科' },
  { code: 'subject_lead', note: '只读本学科跨年级的数据 + 发本学科通知' },
  { code: 'lesson_prep_lead', note: '只读本年级本学科的数据 + 发本年级本学科通知' },
  { code: 'office_head', note: '只能建号 + 发全校通知（看不到任何教学数据）' },
  { code: 'moral_edu_head', note: '看全校教学数据（只读）+ 发全校通知' },
  { code: 'principal', note: '全校只读 + 发全校通知' },
  { code: 'vice_principal', note: '与校长逐格相同' },
  { code: 'principal_assistant', note: '与校长逐格相同' },
  { code: 'admin', note: '教务处：建号 / 指派身份 / 看全校 / 改成绩兜底' },
  { code: 'super', note: '全部权限（平台维护者）' },
]

const ROLE_SCOPE: Record<string, 'none' | 'grade' | 'class' | 'subject' | 'grade_subject'> = {
  super: 'none',
  admin: 'none',
  principal: 'none',
  vice_principal: 'none',
  principal_assistant: 'none',
  office_head: 'none',
  moral_edu_head: 'none',
  grade_head: 'grade',
  head_teacher: 'class',
  subject_lead: 'subject',
  lesson_prep_lead: 'grade_subject',
}

export default function TeacherAccounts() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const myRoles = useStore((s) => s.myRoles)
  const userId = useStore((s) => s.userId)
  const refreshMyRoles = useStore((s) => s.refreshMyRoles)
  const canAssign = canAssignRoles(myRoles)
  /** 🆕 谁能维护**档案属性**（部门归属 / 显示姓名）：与"建号"同一档（超管 / 教务处 / 办公室主任）—— 见文件头 ④ */
  const canManage = canManageTeachers(myRoles)

  const [dir, setDir] = useState<Directory | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openNew, setOpenNew] = useState(false)
  /** 每次打开建号面板就 +1：用它当 key，面板重新挂载 → 表单自然清空（不必在 effect 里 setState） */
  const [newKey, setNewKey] = useState(0)
  const [created, setCreated] = useState<CreatedAccount | null>(null)
  const [target, setTarget] = useState<DirTeacher | null>(null)
  /**
   * 🆕 教师档案（家庭住址 / 电话号码 / 邮箱）—— **与名单分开读**：
   * 名单是"谁能建号 / 教什么"（所有人都看得到），档案是**个人信息**（读得到的行少得多）。
   * 读不到时 `profileErr` 写一句人话 —— 界面上「读不到」与「没录过」**分开说**（三态）。
   */
  const [profiles, setProfiles] = useState<Map<string, TeacherProfile>>(new Map())
  const [profileErr, setProfileErr] = useState<string | null>(null)

  // 读名单 + 状态。⚠️ 不写成 useCallback：这一页没有需要稳定引用的下游，
  // 而 effect 里"同步 setState"的告警会盯着 useCallback 里的 setState（与 Files.tsx 同一写法）
  const load = async () => {
    const r = await listTeachers()
    setLoading(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setErr(null)
    setDir(r.data)
    // 弹层里那份要跟着刷新，否则改完还显示旧身份
    setTarget((prev) => (prev ? (r.data.teachers.find((t) => t.id === prev.id) ?? null) : null))
    /* 🆕 档案：拿得到名单的人**不一定**读得到档案（行由数据库的读策略收口）——
       所以这一支单独读、单独报错，**绝不**因为读不到档案就让整页打不开 */
    const p = await loadTeacherProfiles(r.data.teachers.map((t) => t.id))
    if (p.ok) {
      setProfiles(p.profiles)
      setProfileErr(null)
    } else {
      setProfiles(new Map())
      setProfileErr(p.message)
    }
  }

  // 首屏拉一次（loading 初值就是 true，这里不再同步 setState）
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 身份变动之后：重拉名单 + 刷新自己的身份（那一行按钮的显隐跟着变） */
  const afterRoleChange = async (tid: string) => {
    await load()
    if (tid === userId) await refreshMyRoles()
  }

  /**
   * 🆕 改完姓名 → **就地改那一行**（不重拉整张名单）。
   *
   * 为什么这次不 `load()`：服务端回话里就有改后的姓名，
   * 而重拉会把整页（5 个班 + 所有人的任课关系 / 身份 / 部门）再读一遍 ——
   * 为了一个字符串不值当。⚠️ 部门那几处仍然走 `load()`：那边一次改一批人，回话里没有明细。
   */
  const afterRename = (id: string, name: string) => {
    setDir((prev) =>
      prev ? { ...prev, teachers: prev.teachers.map((t) => (t.id === id ? { ...t, name } : t)) } : prev,
    )
    setTarget((prev) => (prev && prev.id === id ? { ...prev, name } : prev))
  }

  /**
   * 🆕 改完档案 → **就地改那一份**（不重拉整张名单，与 `afterRename` 同一条理由：
   * 回话里就是存下来的三个值）。
   */
  const afterProfileSaved = (id: string, p: TeacherProfile) => {
    setProfiles((prev) => new Map(prev).set(id, p))
    setProfileErr(null)
  }

  return (
    <>
      <PageHead
        title="教师管理"
        sub="建号 · 学科 · 任课关系 · 身份 · 部门"
        /*
         * 🔴 **不许裸用 `navigate(-1)`**（`lib/back.ts` 的纪律）：这一页能从
         *    「行政管理」那一行点进来，**也能直接打开**（书签 / 手打地址）——
         *    直开时这个 SPA 内部没有上一页，裸 `-1` 会把老师**带出应用**。
         *    有上一页就回上一页；没有（`history.state.idx === 0`）就回「我的」。
         */
        onBack={() => goBackOr(navigate, '/settings')}
      />
      <Page>
        {err ? (
          <Panel bodyClass="p-4">
            <div className="flex items-start gap-2.5">
              <span style={{ color: 'var(--color-warn)', marginTop: 2 }}>
                <IconAlert size={16} />
              </span>
              <div className="min-w-0 flex-1" style={{ fontSize: 13, lineHeight: 1.75 }}>
                <div style={{ fontWeight: 620 }}>这一页现在打不开</div>
                <div style={{ color: 'var(--color-ink2)', marginTop: 4 }}>{err}</div>
              </div>
            </div>
            <div className="mt-3">
              <Button
                icon={<IconRefresh size={15} />}
                onClick={() => {
                  setLoading(true)
                  void load()
                }}
                disabled={loading}
              >
                {loading ? '正在重试…' : '重试'}
              </Button>
            </div>
          </Panel>
        ) : null}

        {!err && loading && !dir ? (
          <Panel bodyClass="p-4">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在读取教师名单…</span>
          </Panel>
        ) : null}

        {dir ? (
          <>
            <div className="mb-4">
              <Sect>建号</Sect>
              <Panel bodyClass="p-3">
                <Button
                  block
                  variant="primary"
                  icon={<IconPlus size={16} />}
                  onClick={() => {
                    setNewKey((k) => k + 1)
                    setOpenNew(true)
                  }}
                >
                  给老师建账号
                </Button>
              </Panel>
            </div>

            <div className="mb-4">
              <Sect>教师 · {dir.teachers.length} 人</Sect>
              <Panel className="overflow-hidden">
                {dir.teachers.length === 0 ? (
                  <div className="p-4">
                    <Empty
                      icon={<IconUser size={22} />}
                      title="还没有别的老师"
                      desc="建一个账号，他就能用自己的邮箱登录、只看见自己教的那一科。"
                    />
                  </div>
                ) : (
                  dir.teachers.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="row"
                      style={{ padding: 14 }}
                      onClick={() => setTarget(t)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span style={{ fontSize: 14.5, fontWeight: 620 }}>{t.name}</span>
                          <Tag tone="accent">
                            {t.primarySubjectCode
                              ? subjectName(t.primarySubjectCode, t.subject)
                              : t.subject || '未设学科'}
                          </Tag>
                          {t.id === userId ? <Tag tone="idle">我</Tag> : null}
                          {/*
                            🔴 服务端给的 `teachable` 在这里**只读、不筛**：
                            这一页是**管理名单**，所有人照旧在列 ——
                            这个标记只是说清"他为什么不出现在那些选老师的下拉里"。
                          */}
                          {!t.teachable ? <Tag tone="idle">不参与任教分配</Tag> : null}
                        </span>
                        <span
                          className="mt-1 flex flex-wrap items-center gap-1"
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                        >
                          {t.roles.length ? (
                            t.roles.map((r) => (
                              <span key={`${r.role}-${r.scopeId}`}>
                                {roleName(r.role)}
                                {r.scopeLabel ? ` · ${r.scopeLabel}` : ''}
                              </span>
                            ))
                          ) : (
                            <span>任课教师</span>
                          )}
                          {t.subjects.length ? (
                            <span>
                              · 教 {t.subjects.length} 个班（
                              {t.subjects
                                .map((s) => s.className || '班级已删除')
                                .slice(0, 3)
                                .join('、')}
                              {t.subjects.length > 3 ? '…' : ''}）
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-warn)' }}>· 还没有任课关系</span>
                          )}
                          {/* 🆕 部门：0 个也写出来（"不属于任何部门"是**正常状态**，不是缺失） */}
                          <span>
                            ·{' '}
                            {(t.departments ?? []).length
                              ? (t.departments ?? []).map((d) => departmentName(d)).join(' / ')
                              : '不属于任何部门'}
                          </span>
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </Panel>
            </div>

            {/* 🆕 部门归属 · 批量（开学时一次分几十位老师 —— 用户的口径是"不要手工点几百下"） */}
            <DepartmentBatch dir={dir} canManage={canManage} onDone={load} />
          </>
        ) : null}
      </Page>

      {/* ---------------- 建号 ---------------- */}
      {/* key 跟着打开次数变：每次打开都重新挂载，表单自然是空的（不在 effect 里 setState 清空） */}
      <CreateSheet
        key={`new-${newKey}`}
        open={openNew}
        onClose={() => setOpenNew(false)}
        dir={dir}
        onDone={(acc) => {
          setOpenNew(false)
          setCreated(acc)
          void load()
        }}
      />

      {/* ---------------- 建号结果：密码只显示这一次 ---------------- */}
      <Sheet
        open={!!created}
        onClose={() => setCreated(null)}
        title="账号建好了"
        footer={
          <Button
            block
            variant="primary"
            icon={<IconCheck size={16} />}
            onClick={() => setCreated(null)}
          >
            我知道了
          </Button>
        }
      >
        {created ? (
          <>
            <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
              把下面两行抄给 {created.name}。<b>密码只显示这一次</b>，关掉就看不到了
              （忘了可以在这页点「重置密码」）。
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <CopyRow label="登录账号" value={created.email} onCopy={push} />
              <CopyRow label="初始密码" value={created.password} onCopy={push} />
              <div
                className="flex items-center gap-2 p-2.5"
                style={{
                  background: 'var(--color-surface2)',
                  border: '1px solid var(--color-line)',
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: 'var(--color-ink3)' }}>主学科</span>
                <span style={{ fontWeight: 620 }}>{created.subject}</span>
              </div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              他第一次登录后「我的 → 编辑」里能看到这科；新建作业时学科已经预选好这一科。
            </p>
          </>
        ) : null}
      </Sheet>

      {/* ---------------- 单个老师：任课关系 + 身份 + 🆕部门 ---------------- */}
      {/* key 跟着人选变：换个人就重新挂载，输入框/新密码不会串到别人身上 */}
      <TeacherSheet
        key={target?.id ?? 'none'}
        teacher={target}
        dir={dir}
        canAssign={canAssign}
        canManage={canManage}
        isMe={target?.id === userId}
        profile={target ? (profiles.get(target.id) ?? null) : null}
        profileErr={profileErr}
        onProfileSaved={afterProfileSaved}
        onClose={() => setTarget(null)}
        onChanged={afterRoleChange}
        onRenamed={afterRename}
      />
    </>
  )
}

/* ============================================================
   🆕 部门归属 · 批量（2026-09-28 第二轮）
   ------------------------------------------------------------
   用户口径：开学时要能给**一批**老师分部门，"不要手工点几百下"——
   所以形状是**两个多选**（部门 × 老师），一笔请求写完（服务端按笛卡尔积写）。

   🔴 判据不在这里：`canManage` 只是"摆不摆这一块"，真正的闸门是服务端
      `POST /api/teacher-account` 的 `department` 动作（它拿调用者 JWT 去问
      `can_create_teacher_accounts()`）。把这一块撬开也什么都做不成。
   ============================================================ */

function DepartmentBatch({
  dir,
  canManage,
  onDone,
}: {
  dir: Directory
  canManage: boolean
  onDone: () => Promise<void>
}) {
  const push = useToast((s) => s.push)
  const [depts, setDepts] = useState<string[]>([])
  const [ids, setIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  /* 不能维护的人（年级主任 / 组长 / 班主任…）连这一块都看不到 —— 那是"少点几下"，不是判据 */
  if (!canManage) return null

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]

  const apply = async (on: boolean) => {
    if (busy) return
    if (!depts.length || !ids.length) {
      push({ text: '先选部门、再选老师', tone: 'warn' })
      return
    }
    setBusy(true)
    const r = await setDepartment({ teacherIds: ids, departments: depts, on })
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad', desc: r.detail })
      return
    }
    push({
      text: on
        ? `已加上：${ids.length} 位老师 × ${depts.length} 个部门`
        : `已去掉：${ids.length} 位老师 × ${depts.length} 个部门`,
      tone: 'ok',
    })
    await onDone()
  }

  const chip = (on: boolean) => ({
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 12.5,
    border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
    background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
    color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
    fontWeight: on ? 650 : 500,
  })

  return (
    <div className="mb-4">
      <Sect>部门 · 批量（谁属于哪个处室）</Sect>
      <Panel bodyClass="p-3">
        <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
          一个人可以属于多个部门，也可以不属于任何部门。
        </p>

        <div className="mt-3">
          <span className="label">① 选部门（可多选）</span>
          <div className="flex flex-wrap gap-1.5">
            {DEPARTMENTS.map((d) => {
              const on = depts.includes(d.code)
              return (
                <button
                  key={d.code}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDepts((prev) => toggle(prev, d.code))}
                  style={chip(on)}
                  title={d.note}
                >
                  {d.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-3">
          <span className="label">
            ② 选老师（可多选）· 已选 <span className="num">{ids.length}</span> 位
          </span>
          <div
            className="flex flex-wrap gap-1.5"
            style={{ maxHeight: 176, overflowY: 'auto' }}
          >
            {dir.teachers.map((t) => {
              const on = ids.includes(t.id)
              const has = (t.departments ?? []).map((d) => departmentName(d)).join('/')
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setIds((prev) => toggle(prev, t.id))}
                  style={chip(on)}
                >
                  {t.name}
                  {has ? ` · ${has}` : ''}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={() => setIds(dir.teachers.map((t) => t.id))}
              disabled={!dir.teachers.length}
            >
              全选
            </Button>
            <Button size="sm" onClick={() => setIds([])} disabled={!ids.length}>
              清空
            </Button>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <Button
            block
            variant="primary"
            disabled={busy || !depts.length || !ids.length}
            onClick={() => void apply(true)}
          >
            {busy ? '正在写…' : '加上所选部门'}
          </Button>
          <Button block disabled={busy || !depts.length || !ids.length} onClick={() => void apply(false)}>
            从这些老师身上去掉
          </Button>
        </div>
      </Panel>
    </div>
  )
}

/* ============================================================
   建号
   ============================================================ */

function CreateSheet({
  open,
  onClose,
  dir,
  onDone,
}: {
  open: boolean
  onClose: () => void
  dir: Directory | null
  onDone: (acc: CreatedAccount) => void
}) {
  const push = useToast((s) => s.push)
  const [name, setName] = useState('')
  const [account, setAccount] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [classIds, setClassIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    const c = asSubjectCode(code)
    if (!name.trim() || !account.trim() || !c) {
      push({ text: '姓名、账号、学科都要填', tone: 'warn' })
      return
    }
    setBusy(true)
    const r = await createTeacher({
      name: name.trim(),
      account: account.trim(),
      subjectCode: c,
      subject: subjectName(c),
      password: password.trim(),
      classIds,
    })
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad', desc: r.detail })
      return
    }
    for (const w of r.data.warnings ?? []) push({ text: w, tone: 'warn' })
    onDone(r.data.account)
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="给老师建账号"
      footer={
        <div className="flex gap-2">
          <Button block onClick={onClose}>
            取消
          </Button>
          <Button
            block
            variant="primary"
            disabled={busy || !name.trim() || !account.trim() || !code}
            onClick={() => void submit()}
          >
            {busy ? '正在创建…' : '创建账号'}
          </Button>
        </div>
      }
    >
      <label className="block">
        <span className="label">姓名</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 李老师"
        />
      </label>

      <label className="mt-4 block">
        <span className="label">登录账号</span>
        <input
          className="input"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder="邮箱，或直接敲 QQ 号"
          autoComplete="off"
        />
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          敲 QQ 号会自动补成 <span className="num">号码@qq.com</span>；
          他登录时也这么敲，两边是同一套规则。
        </p>
      </label>

      {/*
        学科**必须选**（这一页的核心）：它落进 teachers.primary_subject_code，
        决定新作业预选哪一科，也决定他看得见哪一科的作业。
      */}
      <div className="mt-4">
        <span className="label">主学科 *</span>
        <div className="flex flex-wrap gap-1.5">
          {SUBJECTS.map((s) => {
            const on = code === s.code
            return (
              <button
                key={s.code}
                type="button"
                aria-pressed={on}
                onClick={() => setCode(s.code)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 4,
                  fontSize: 12.5,
                  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                  background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                  color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                  fontWeight: on ? 650 : 500,
                }}
              >
                {s.name}
              </button>
            )
          })}
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          教两科的话，建完号在这里再加一条任课关系即可。
        </p>
      </div>

      <div className="mt-4">
        <span className="label">任教班级（可留空）</span>
        {dir && dir.classes.length ? (
          <div className="flex flex-wrap gap-1.5">
            {dir.classes.map((c) => {
              const on = classIds.includes(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setClassIds((prev) =>
                      prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                    )
                  }
                  style={{
                    padding: '4px 10px',
                    borderRadius: 4,
                    fontSize: 12.5,
                    border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                    background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                    color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                    fontWeight: on ? 650 : 500,
                  }}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>数据库里还没有班级。</p>
        )}
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          选了他才看得见这些班；不选的话他登录后<b>一个班都没有</b>，之后可以在这页补上。
        </p>
      </div>

      <label className="mt-4 block">
        <span className="label">初始密码（留空自动生成）</span>
        <input
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 8 位；留空则生成一串随机的"
          autoComplete="new-password"
        />
      </label>
    </Sheet>
  )
}

/* ============================================================
   单个老师：任课关系 + 身份 + 重置密码
   ============================================================ */

function TeacherSheet({
  teacher,
  dir,
  canAssign,
  canManage,
  isMe,
  profile,
  profileErr,
  onProfileSaved,
  onClose,
  onChanged,
  onRenamed,
}: {
  teacher: DirTeacher | null
  dir: Directory | null
  canAssign: boolean
  /** 🆕 能不能维护**档案属性**（部门归属 / 显示姓名 / 🆕教师档案）—— 与"建号"同一档：超管 / 教务处 / 办公室主任 */
  canManage: boolean
  isMe: boolean
  /** 🆕 这位老师的档案（`teacher_profiles`）；`null` = 没读到 / 没这行 —— 两者由 `profileErr` 分开说 */
  profile: TeacherProfile | null
  /** 🆕 读不到档案时那一句人话（读到过就是 null） */
  profileErr: string | null
  /** 🆕 改完档案：把存下来的三个值就地写回那一份 */
  onProfileSaved: (teacherId: string, p: TeacherProfile) => void
  onClose: () => void
  onChanged: (teacherId: string) => Promise<void>
  /** 🆕 改完姓名：把新名字就地写回那一行（`id` + `name`） */
  onRenamed: (id: string, name: string) => void
}) {
  const push = useToast((s) => s.push)
  const [busy, setBusy] = useState(false)
  const [newClassId, setNewClassId] = useState('')
  const [newCode, setNewCode] = useState('')
  const [roleKind, setRoleKind] = useState('')
  const [scopeId, setScopeId] = useState('')
  const [pwd, setPwd] = useState('')
  /** 🆕 显示姓名：**跟着这个人挂载**（`key` 是人 id，换个人自然是空的 —— 不串到别人身上） */
  const [name, setName] = useState('')
  /**
   * 🆕 教师档案的三个草稿值：同样**跟着这个人挂载**（`key` = 人 id）。
   * 初值来自上面读到的 `profile`（没录过 = 空串），编辑时就地改，保存后由回话覆盖。
   */
  const [pDraft, setPDraft] = useState<Record<string, string>>(() => ({
    homeAddress: profile?.homeAddress ?? '',
    phone: profile?.phone ?? '',
    email: profile?.email ?? '',
  }))

  if (!teacher || !dir) {
    return (
      <Sheet open={false} onClose={onClose} title="老师">
        <span />
      </Sheet>
    )
  }

  const run = async (fn: () => Promise<{ ok: boolean; message?: string; detail?: string }>) => {
    if (busy) return
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message ?? '操作失败', tone: 'bad', desc: r.detail })
      return
    }
    await onChanged(teacher.id)
  }

  const shape = roleKind ? (ROLE_SCOPE[roleKind] ?? 'none') : 'none'
  const needsScope = shape === 'grade' || shape === 'class'
  const needsSubject = shape === 'subject' || shape === 'grade_subject'
  const scopeOptions = shape === 'grade' || shape === 'grade_subject' ? dir.grades : shape === 'class' ? dir.classes : []
  const scopeReady = (!needsScope || !!scopeId) && (!needsSubject || !!newCode)

  /** 🆕 档案那三个格：与读到的值比一比，**没改动就不让点保存**（与显示姓名那个按钮同一条） */
  const savedProfile = {
    homeAddress: profile?.homeAddress ?? '',
    phone: profile?.phone ?? '',
    email: profile?.email ?? '',
  }
  const pDirty = TEACHER_PROFILE_FIELDS.some(
    (f) => String(pDraft[f.key] ?? '').trim() !== savedProfile[f.key],
  )

  return (
    <Sheet open={!!teacher} onClose={onClose} title={teacher.name}>
      <div className="flex items-center gap-2">
        <Tag tone="accent">
          {teacher.primarySubjectCode
            ? subjectName(teacher.primarySubjectCode, teacher.subject)
            : teacher.subject || '未设学科'}
        </Tag>
        {teacher.roles.length ? (
          teacher.roles.map((r) => (
            <Tag key={`${r.role}-${r.scopeId}`} tone="ok">
              {roleName(r.role)}
              {r.scopeLabel ? ` · ${r.scopeLabel}` : ''}
            </Tag>
          ))
        ) : (
          <Tag tone="idle">任课教师</Tag>
        )}
      </div>

      {/* ---- 🆕 显示姓名（只改显示名，登录账号不动） ---- */}
      {canManage ? (
        <div className="mt-5">
          <span className="label">显示姓名</span>
          <div className="flex gap-2">
            <input
              className="input min-w-0 flex-1"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder={teacher.name}
              aria-label="显示姓名"
            />
            <Button
              disabled={busy || !name.trim() || name.trim() === teacher.name}
              onClick={() =>
                void run(async () => {
                  const r = await renameTeacher(teacher.id, name.trim())
                  if (!r.ok) return { ok: false, message: r.message, detail: r.detail }
                  /* 就地改那一行，**不重拉整张名单**（回话里就是新名字） */
                  onRenamed(teacher.id, r.data.teacher.name)
                  /* 填入服务端回话的新名字（原来清空成 ''，看着像没保存上） */
                  setName(r.data.teacher.name)
                  return { ok: true }
                })
              }
            >
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- 🆕 教师档案（家庭住址 / 电话号码 / 邮箱） ----
           判据在数据库（`teacher_profiles` 的读策略 = 自己那一行 ∪ 建号那一档，写 = 建号那一档，§36）；
           这里只决定摆不摆："能建号的人"摆输入框，其余人**只读**——一行都读不到时什么都不摆。 */}
      {canManage ? (
        <div className="mt-5">
          <span className="label">教师档案</span>
          <div className="flex flex-col gap-2">
            {TEACHER_PROFILE_FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1">
                <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>{f.label}</span>
                <input
                  className="input"
                  value={pDraft[f.key] ?? ''}
                  maxLength={f.key === 'homeAddress' || f.key === 'email' ? 120 : 40}
                  placeholder={f.hint}
                  aria-label={f.label}
                  onChange={(e) => setPDraft((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            <div className="flex justify-end">
              <Button
                disabled={busy || !pDirty}
                onClick={() =>
                  void run(async () => {
                    const r = await saveTeacherProfile(teacher.id, {
                      homeAddress: (pDraft.homeAddress ?? '').trim(),
                      phone: (pDraft.phone ?? '').trim(),
                      email: (pDraft.email ?? '').trim(),
                    })
                    if (!r.ok) return { ok: false, message: r.message, detail: r.detail }
                    const saved = r.data.profile
                    onProfileSaved(teacher.id, { teacherId: teacher.id, ...saved })
                    setPDraft({ homeAddress: saved.homeAddress, phone: saved.phone, email: saved.email })
                    return { ok: true }
                  })
                }
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      ) : (profile && TEACHER_PROFILE_FIELDS.some((f) => String(profile[f.key] ?? '').trim() !== '')) ? (
        <div className="mt-5">
          <span className="label">教师档案</span>
          <div className="flex flex-col gap-1">
            {TEACHER_PROFILE_FIELDS.map((f) => {
              const v = String(profile[f.key] ?? '').trim()
              if (!v) return null
              return (
                <div key={f.key} className="flex gap-2" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                  <span style={{ color: 'var(--color-ink3)', minWidth: 56 }}>{f.label}</span>
                  <span className="min-w-0 flex-1 break-all">{v}</span>
                </div>
              )
            })}
          </div>
        </div>
      ) : profileErr ? (
        <div className="mt-5">
          <span className="label">教师档案</span>
          <p style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>{profileErr}</p>
        </div>
      ) : null}

      {/* ---- 任课关系 ---- */}
      <div className="mt-5">
        <span className="label">任课关系（他教哪个班哪一科）</span>
        <div className="flex flex-col gap-1.5">
          {teacher.subjects.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
              还没有。没有任课关系，他登录后看不到任何班级。
            </p>
          ) : (
            teacher.subjects.map((s) => (
              <div
                key={`${s.classId}-${s.subjectCode || s.subject}`}
                className="flex items-center gap-2 p-2.5"
                style={{
                  background: 'var(--color-surface2)',
                  border: '1px solid var(--color-line)',
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {s.className || '班级已删除'} · {subjectName(s.subjectCode, s.subject) || s.subject}
                </span>
                <button
                  type="button"
                  aria-label="删掉这条任课关系"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      assignSubject({
                        teacherId: teacher.id,
                        classId: s.classId,
                        subjectCode: asSubjectCode(s.subjectCode) ?? '',
                        subject: s.subject,
                        on: false,
                      }),
                    )
                  }
                  style={{ color: 'var(--color-ink3)' }}
                >
                  <IconX size={15} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <select className="input" value={newClassId} onChange={(e) => setNewClassId(e.target.value)}>
            <option value="">选班级…</option>
            {dir.classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input" value={newCode} onChange={(e) => setNewCode(e.target.value)}>
            <option value="">选学科…</option>
            {SUBJECTS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            block
            disabled={busy || !newClassId || !newCode}
            icon={<IconPlus size={15} />}
            onClick={() =>
              void run(async () => {
                const c = asSubjectCode(newCode)
                if (!c) return { ok: false, message: '选一科' }
                const r = await assignSubject({
                  teacherId: teacher.id,
                  classId: newClassId,
                  subjectCode: c,
                  subject: subjectName(c),
                  on: true,
                })
                return r.ok ? { ok: true } : { ok: false, message: r.message, detail: r.detail }
              })
            }
          >
            加上这条任课关系
          </Button>
        </div>
      </div>

      {/* ---- 身份 ---- */}
      <div className="mt-5">
        <span className="label">身份</span>
        {canAssign ? (
          <>
            <div className="flex flex-col gap-2">
              <select className="input" value={roleKind} onChange={(e) => {
                setRoleKind(e.target.value)
                setScopeId('')
                setNewCode('')
              }}>
                <option value="">加一个身份…</option>
                {ROLE_ITEMS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {roleName(r.code)}（{r.note}）
                  </option>
                ))}
              </select>
              {needsScope ? (
                <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                  <option value="">{shape === 'class' ? '选班级…' : '选年级…'}</option>
                  {scopeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {/*
                🔴 组长两档**必须带学科**：少了它，判据永远匹配不到 ——
                   界面上看起来"指派成功了"，而他登录后等于一位普通任课老师。
                   所以这里不是可选项（服务端也会 400 拒掉）。
              */}
              {needsSubject ? (
                <select className="input" value={newCode} onChange={(e) => setNewCode(e.target.value)}>
                  <option value="">选学科…</option>
                  {SUBJECTS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                block
                disabled={busy || !roleKind || !scopeReady}
                icon={<IconPlus size={15} />}
                onClick={() =>
                  void run(async () => {
                    const r = await setRole({
                      teacherId: teacher.id,
                      role: roleKind,
                      scopeId: needsScope ? scopeId : '',
                      roleSubjectCode: needsSubject ? newCode : '',
                      on: true,
                    })
                    return r.ok ? { ok: true } : { ok: false, message: r.message, detail: r.detail }
                  })
                }
              >
                加上这个身份
              </Button>
            </div>
            {teacher.roles.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {teacher.roles.map((r) => (
                  <button
                    key={`del-${r.role}-${r.scopeId}`}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        /*
                         * 删的键必须和插的键**逐字一致**（服务端按 SCOPE_OF 拼），
                         * 所以这里把**这一行自己**的形状原样传回去（含学科代码）——
                         * 少传一个字段就会出现"看起来取消成功了、其实那行还在"。
                         */
                        const res = await setRole({
                          teacherId: teacher.id,
                          role: r.role,
                          scopeType: r.scopeType,
                          scopeId: r.scopeId,
                          roleSubjectCode: r.subjectCode ?? '',
                          on: false,
                        })
                        return res.ok ? { ok: true } : { ok: false, message: res.message, detail: res.detail }
                      })
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 8px',
                      borderRadius: 4,
                      fontSize: 12,
                      border: '1px solid var(--color-line2)',
                      background: 'var(--color-surface)',
                      color: 'var(--color-ink2)',
                    }}
                  >
                    {roleName(r.role)}
                    {r.scopeLabel ? ` · ${r.scopeLabel}` : ''}
                    <IconX size={13} />
                  </button>
                ))}
              </div>
            ) : null}
            {isMe ? (
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
                这是你自己。最后一条「{roleName('super')}」摘不掉。
              </p>
            ) : null}
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
            <b>指派身份是教务处与最高管理员的事</b> —— 你现在没有这两档身份里的任何一个，
            所以这一页只能看。
          </p>
        )}
      </div>

      {/* ---- 🆕 部门（职能部门归属：可以多个，也可以一个都没有） ---- */}
      <div className="mt-5">
        <span className="label">部门（办公室 / 教务处 / 总务处 / 德育处）</span>
        {canManage ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {DEPARTMENTS.map((d) => {
                const on = (teacher.departments ?? []).includes(d.code)
                return (
                  <button
                    key={d.code}
                    type="button"
                    aria-pressed={on}
                    disabled={busy}
                    title={d.note}
                    onClick={() =>
                      void run(async () => {
                        const r = await setDepartment({
                          teacherIds: [teacher.id],
                          departments: [d.code],
                          on: !on,
                        })
                        return r.ok ? { ok: true } : { ok: false, message: r.message, detail: r.detail }
                      })
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '3px 9px',
                      borderRadius: 4,
                      fontSize: 12.5,
                      border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                      background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                      color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                      fontWeight: on ? 650 : 500,
                    }}
                  >
                    {on ? d.name : `+ ${d.name}`}
                    {on ? <IconX size={13} /> : null}
                  </button>
                )
              })}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
              点一下加上、再点一下去掉。<b>可以多选</b>；<b>一个都不选也是正常的</b>（纯任课老师）。
            </p>
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
            {(teacher.departments ?? []).length
              ? (teacher.departments ?? []).map((d) => departmentName(d)).join(' · ')
              : '不属于任何部门'}
            <br />
            <b>改部门归属是教务处 · 办公室 · 最高管理员的事</b> ——
            你现在没有这三档身份里的任何一个，所以这里只能看。
          </p>
        )}
      </div>

      {/* ---- 重置密码 ---- */}
      <div className="mt-5">
        <span className="label">重置密码</span>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.65 }}>
          忘密码时用。生成一串新的，旧密码立刻失效。
        </p>
        <div className="mt-2">
          <Button
            block
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await resetTeacherPassword(teacher.id)
                if (!r.ok) return { ok: false, message: r.message, detail: r.detail }
                setPwd(r.data.password)
                return { ok: true }
              })
            }
          >
            生成新密码
          </Button>
        </div>
        {pwd ? <div className="mt-2"><CopyRow label="新密码" value={pwd} onCopy={push} /></div> : null}
      </div>
    </Sheet>
  )
}

/* ---------------- 一行「值 + 复制」 ---------------- */

function CopyRow({
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
