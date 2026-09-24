import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconCheck, IconPlus, IconRefresh, IconUser, IconX } from '../components/icons'
import { Button, Empty, Panel, PageHead, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import {
  assignSubject,
  createTeacher,
  listTeachers,
  resetTeacherPassword,
  setRole,
  type CreatedAccount,
  type Directory,
  type DirTeacher,
} from '../lib/accounts'
import { isSuperAdmin, roleName } from '../lib/roles'
import { SUBJECTS, asSubjectCode, subjectName } from '../lib/subjects'

/**
 * 教师账号（建号 · 主学科 · 任课关系 · 身份）。
 *
 * 三件事在这一页上合起来才有用：
 *   ① **建号时就带上学科** —— 落进 `teachers.primary_subject_code`，
 *      新老师第一次登录时新建作业的学科 chip 就是预选好的那一科，不是物理。
 *   ② **任课关系**（谁教哪个班哪一科）—— 它决定这位老师登录后
 *      看得见哪些班、以及**哪一科的作业**（见 `schema.sql` §13.4 的读策略）。
 *   ③ **身份** —— 班主任 / 年级主任看一个班（年级）的**所有学科**；
 *      行政老师和最高管理员能管账号，但**只有最高管理员能指派身份**。
 *
 * 🔴 这一页的按钮显隐只是"少点几下"，**不是判据**：
 *    真正的闸门在服务端（`functions/api/teacher-account.ts` 拿你的 JWT 去问
 *    数据库的 `can_manage_teachers()` / `is_super_admin()`）。
 *    所以就算有人把这一页的入口撬开，他也什么都做不成。
 */
export default function TeacherAccounts() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const myRoles = useStore((s) => s.myRoles)
  const userId = useStore((s) => s.userId)
  const refreshMyRoles = useStore((s) => s.refreshMyRoles)
  const superAdmin = isSuperAdmin(myRoles)

  const [dir, setDir] = useState<Directory | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openNew, setOpenNew] = useState(false)
  /** 每次打开建号面板就 +1：用它当 key，面板重新挂载 → 表单自然清空（不必在 effect 里 setState） */
  const [newKey, setNewKey] = useState(0)
  const [created, setCreated] = useState<CreatedAccount | null>(null)
  const [target, setTarget] = useState<DirTeacher | null>(null)

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
  }

  // 首屏拉一次（loading 初值就是 true，这里不再同步 setState）
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const afterChange = async (tid: string) => {
    await load()
    if (tid === userId) await refreshMyRoles()
  }

  return (
    <>
      <PageHead title="教师账号" sub="建号 · 学科 · 任课关系 · 身份" onBack={() => navigate(-1)} />
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
                <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.75 }}>
                  建号时<b>必须选学科</b> —— 它决定两件事：这位老师第一次登录时新建作业预选哪一科，
                  以及他登录后<b>看得见哪一科的作业</b>（同班别的科目他看不到，除非他同时是班主任或年级主任）。
                </p>
                <div className="mt-3">
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
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
                  只有<b>最高管理员</b>和<b>行政老师</b>能建号。指派身份（班主任 / 年级主任）只有最高管理员能做。
                </p>
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
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </Panel>
            </div>
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

      {/* ---------------- 单个老师：任课关系 + 身份 ---------------- */}
      {/* key 跟着人选变：换个人就重新挂载，输入框/新密码不会串到别人身上 */}
      <TeacherSheet
        key={target?.id ?? 'none'}
        teacher={target}
        dir={dir}
        superAdmin={superAdmin}
        isMe={target?.id === userId}
        onClose={() => setTarget(null)}
        onChanged={afterChange}
      />
    </>
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
        <span className="label">主学科</span>
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
          这一科决定他登录后看得见哪一科的成绩与错题。教两科的话，建完号在这里再加一条任课关系即可
          （主学科只影响新建作业的预选）。
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
  superAdmin,
  isMe,
  onClose,
  onChanged,
}: {
  teacher: DirTeacher | null
  dir: Directory | null
  superAdmin: boolean
  isMe: boolean
  onClose: () => void
  onChanged: (teacherId: string) => Promise<void>
}) {
  const push = useToast((s) => s.push)
  const [busy, setBusy] = useState(false)
  const [newClassId, setNewClassId] = useState('')
  const [newCode, setNewCode] = useState('')
  const [roleKind, setRoleKind] = useState('')
  const [scopeId, setScopeId] = useState('')
  const [pwd, setPwd] = useState('')

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

  const roleNeedsScope = roleKind === 'grade_head' || roleKind === 'head_teacher'
  const scopeOptions = roleKind === 'grade_head' ? dir.grades : roleKind === 'head_teacher' ? dir.classes : []

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
        {superAdmin ? (
          <>
            <div className="flex flex-col gap-2">
              <select className="input" value={roleKind} onChange={(e) => {
                setRoleKind(e.target.value)
                setScopeId('')
              }}>
                <option value="">加一个身份…</option>
                <option value="grade_head">{roleName('grade_head')}（看本年级所有学科）</option>
                <option value="head_teacher">{roleName('head_teacher')}（看本班所有学科）</option>
                <option value="admin">{roleName('admin')}（能建号，看全校）</option>
                <option value="super">{roleName('super')}（全部权限）</option>
              </select>
              {roleNeedsScope ? (
                <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                  <option value="">{roleKind === 'grade_head' ? '选年级…' : '选班级…'}</option>
                  {scopeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <Button
                block
                disabled={busy || !roleKind || (roleNeedsScope && !scopeId)}
                icon={<IconPlus size={15} />}
                onClick={() =>
                  void run(async () => {
                    const r = await setRole({
                      teacherId: teacher.id,
                      role: roleKind,
                      scopeType: roleKind === 'grade_head' ? 'grade' : roleKind === 'head_teacher' ? 'class' : '',
                      scopeId: roleNeedsScope ? scopeId : '',
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
                        const res = await setRole({
                          teacherId: teacher.id,
                          role: r.role,
                          scopeType: r.scopeType,
                          scopeId: r.scopeId,
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
                这是你自己。最后一条「{roleName('super')}」摘不掉（摘了没人能再指派身份）。
              </p>
            ) : null}
          </>
        ) : (
          <p style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
            指派身份（班主任 / 年级主任 / 行政老师 / 最高管理员）<b>只有最高管理员能做</b>。
            你是行政老师：建号、任课关系、重置密码都可以。
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
