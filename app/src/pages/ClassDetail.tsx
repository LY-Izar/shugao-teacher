import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconHash,
  IconMegaphone,
  IconPaste,
  IconPencil,
  IconPlus,
  IconSearch,
  IconSwap,
  IconUsers,
  IconX,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, StatStrip, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { STUDENT_STATUS_NAME, type StudentStatus } from '../data/types'
import { analyzeRoster, compareRoster } from '../lib/roster'
import { CALL_LIMIT, CUSTOM_MAX, composeCallText } from '../lib/calls'
import { archiveKeyOf } from '../lib/keys'
import { hasManagingRole } from '../lib/roles'
import { subjectName } from '../lib/subjects'
import {
  apiOldSubjectPreview,
  apiPurgeOldSubjectData,
  type OldSubjectCounts,
} from '../lib/gradeSetup'
import { isRemote } from '../lib/supabase'
import * as remote from '../data/remote'

/** 一条选科快照 → 人话（`物化生`）；空快照 = "还没采过" */
function comboText(snap: Record<string, unknown> | undefined): string {
  const primary = String(snap?.primary ?? '')
  const raw = snap?.second
  const second = Array.isArray(raw) ? raw.map(String) : []
  const parts = [primary, ...second].filter(Boolean)
  if (!parts.length) return '还没采过'
  return parts.map((c) => subjectName(c, c)).join('')
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
   * 🔴 这**只是"摆不摆入口"**（M1/M2 那条纪律），**不是判据**：
   *    真正能不能发由数据库的 `can_call()` 说了算（`schema.sql` §33.2）——
   *    事务性呼叫只给班级管理权那一档，**科任老师一定会被拒**。
   *    这里用 `hasManagingRole()`（已有的那个粗档）只是免得科任老师看着一个
   *    必然失败的按钮。⚠️ 它**不覆盖"本班班主任"**（那是 `teacher_roles` 的一行），
   *    所以入口对班主任也是摆着的 —— 那正是要的（Q32 = C）。
   */
  const myRoles = useStore((s) => s.myRoles)
  const canManageClass = hasManagingRole(myRoles)

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

  const health = useMemo(() => analyzeRoster(klass?.students ?? []), [klass])

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

  const list = klass.students
    .filter((s) => {
      if (!q.trim()) return true
      const k = q.trim()
      // 搜学号时**序列号也认**（老师手上可能是导出表里的那一列）
      return s.name.includes(k) || s.studentNo.includes(k) || (s.serial ?? '').includes(k)
    })
    // 统一排序只有一处（`compareRoster`）：有序列号按序列号，没有才按班内学号
    .sort(compareRoster)

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

  const problems = health.gaps.length + health.dupNos.length + health.dupNames.length

  return (
    <>
      <PageHead
        title={klass.name}
        sub={`${klass.grade} · ${klass.year}`}
        onBack={() => navigate('/classes')}
        right={
          <div className="flex items-center gap-2">
            {/*
              事务性呼叫的入口（Q32 = C）。**摆不摆**用 `hasManagingRole()` 这个粗档；
              能不能发由数据库的 `can_call()` 说了算（科任老师一定被拒，见 §33.2）。
            */}
            {canManageClass ? (
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
        {/* 体检 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <StatStrip
            items={[
              { k: '学生', v: health.count },
              { k: '学号区间', v: `1–${health.maxNo || 0}` },
              {
                k: '待核对',
                v: problems === 0 ? '正常' : problems,
                tone: problems === 0 ? 'var(--color-ok)' : 'var(--color-warn)',
              },
            ]}
          />
          <div
            className="flex items-start gap-2.5 p-3"
            style={{
              borderTop: '1px solid var(--color-line)',
              background: problems === 0 ? 'var(--color-oksoft)' : 'var(--color-warnsoft)',
            }}
          >
            <span
              style={{ color: problems === 0 ? 'var(--color-ok)' : 'var(--color-warn)', marginTop: 1 }}
            >
              {problems === 0 ? <IconCheck size={16} /> : <IconAlert size={16} />}
            </span>
            <div className="flex-1" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              {problems === 0 ? (
                <span style={{ color: '#0b6b4a' }}>
                  名单体检通过：学号 1–{health.maxNo} 连续无缺号，无重号重名。
                </span>
              ) : (
                <span style={{ color: '#8a5a12' }}>
                  {health.gaps.length ? `缺号 ${health.gaps.join('、')}； ` : ''}
                  {health.dupNos.length ? `学号重复 ${health.dupNos.join('、')}； ` : ''}
                  {health.dupNames.length ? `重名 ${health.dupNames.join('、')}； ` : ''}
                  {health.noNumber ? `另有 ${health.noNumber} 人学号非数字` : ''}
                </span>
              )}
            </div>
          </div>
        </Panel>

        {/* 操作 */}
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
              setAddForm({ studentNo: String(health.maxNo + 1), name: '' })
              setAddOpen(true)
            }}
          >
            加学生
          </Button>
        </div>

        {/* 名单 */}
        <div>
          <Sect>学生名单 · {klass.students.length} 人</Sect>
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
                  {klass.students.length === 0 ? '名单还是空的' : '没有匹配的学生'}
                </div>
                {klass.students.length === 0 ? (
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
      </Page>

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
                    border: '1px solid #ecd9ae',
                    background: 'var(--color-warnsoft)',
                    borderRadius: 4,
                    padding: '8px 10px',
                    fontSize: 12,
                    lineHeight: 1.8,
                  }}
                >
                  <div style={{ color: '#8a5a12', fontWeight: 600 }}>
                    将删除 {purgeCounts.total} 条记录（无可恢复）
                  </div>
                  <div style={{ color: '#8a5a12' }}>
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
              .sort(compareRoster)
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
