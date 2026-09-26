import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCamera,
  IconChevronRight,
  IconPaste,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, Tag, Track } from '../components/ui'
import { activeStudents, useStore, useToast } from '../data/store'
import type { Klass, Student } from '../data/types'
import * as remote from '../data/remote'
import { classKindOf, splitByKind } from '../lib/pick'
import { compareRoster, rosterStateOf, type RosterState } from '../lib/roster'
import { canEditClassFor } from '../lib/roles'
import { apiAssignStreamTeacher } from '../lib/gradeSetup'
import { loadGradeSetup } from '../data/gradeSetup'
import { listTeachers, teachableOnly, type DirTeacher } from '../lib/accounts'

/**
 * 一个班那行卡片。
 *
 * ⚠️ **行政班与走班班共用同一个渲染**，差别只有两处：
 *   · 脚注那一栏（拍照 / 粘贴 / 编辑 —— 这几件事只对行政班有意义）；
 *   · **名单从哪儿读**（`rosterState` 的 `source`）。
 *
 * 🔴 **走班班的人不在 `klass.students` 上**（多对多，`class_members`，§27.5）——
 *    原来这里对走班班也算 `analyzeRoster(klass.students)`，于是恒为「0 人 + 名单完整」
 *    两个错同时出现（"没有数据被当成一切正常"）。现在名单那一栏一律走 `rosterState`。
 */
function ClassCard({
  klass,
  rosterState,
  onOpen,
  onEdit,
  onDelete,
}: {
  klass: Klass
  rosterState: RosterState
  onOpen: () => void
  /** 传了才渲染脚注那一栏 */
  onEdit?: () => void
  /**
   * 🔴 走班班的**删除**入口（2026-10-08：内测「删不了」）。
   *    · 行政班**不传** —— 它的删除在编辑面板里（`Classes()` 那个 Sheet），原样不动；
   *    · 走班班传 —— 它没有"拍照 / 粘贴"那些脚注，删班要能在卡片上直接点到。
   *    ⚠️ 传不传由**数据库那条判据的前端影子** `canEditClassFor()` 决定（见 `Classes()`），
   *       这里只负责摆，不做权限判断。
   */
  onDelete?: () => void
}) {
  const navigate = useNavigate()
  const rs = rosterState
  const isStream = classKindOf(klass) === 'stream'
  /* 体检那一套（学号连续 / 重号 / 重名）只对**行政班**有意义：走班班没有班内学号。
     进度条也只画行政班 —— 走班班画一根按"人数/学号上限"算的条是在编一个不存在的量。 */
  const h = isStream ? null : rs.health
  const pct = h && h.count ? (h.count / Math.max(h.maxNo, h.count)) * 100 : 0
  const badge = !isStream ? (
    h && rs.kind === 'ok' ? (
      <Tag tone="ok">名单完整</Tag>
    ) : rs.kind === 'nobody' ? (
      /* 🔴 0 人 = **还没有名单**，不是"待核对"，更不是"完整" */
      <Tag tone="warn">还没有名单</Tag>
    ) : rs.kind === 'unknown' ? (
      <Tag tone="idle">名单没读到</Tag>
    ) : (
      <Tag tone="warn">待核对</Tag>
    )
  ) : null
  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        className="row"
        style={{ alignItems: 'flex-start', padding: 14 }}
        onClick={onOpen}
      >
        <span
          className="grid place-items-center shrink-0"
          style={{
            width: 40,
            height: 40,
            border: '1px solid var(--color-line2)',
            borderRadius: 4,
            background: 'var(--color-surface2)',
            color: 'var(--color-ink2)',
          }}
        >
          <IconUsers size={19} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>{klass.name}</span>
            {badge}
          </span>
          <span className="mt-0.5 block" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            {isStream
              ? `${klass.grade}${klass.year ? ` · ${klass.year}` : ''} · 走班班`
              : /* 🔴 0 人 / 没读到时不写「学号 1–0」—— 那是**编**一个不存在的量
                   （与徽章、体检块同一条口径：没有数据就是没有数据）。 */
                h
                ? `${klass.grade} · ${klass.year} · 学号 1–${h.maxNo || 0}`
                : `${klass.grade}${klass.year ? ` · ${klass.year}` : ''} · ${
                    rs.kind === 'unknown' ? '名单没读到' : '还没有名单'
                  }`}
          </span>

          <span className="mt-2 flex items-center gap-2.5">
            <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {rs.kind === 'unknown' ? '人数待读' : `${rs.count} 人`}
            </span>
            {!isStream ? (
              <span style={{ flex: 1, maxWidth: 150 }}>
                <Track value={pct} tone={rs.kind === 'ok' ? 'var(--color-ok)' : undefined} />
              </span>
            ) : null}
          </span>

          {h && !h.healthy ? (
            <span
              className="mt-2 flex flex-wrap gap-x-3 gap-y-1"
              style={{ fontSize: 11.5, color: 'var(--color-warn)' }}
            >
              {h.gaps.length ? (
                <span>
                  缺号 {h.gaps.slice(0, 6).join('、')}
                  {h.gaps.length > 6 ? '…' : ''}
                </span>
              ) : null}
              {h.dupNos.length ? <span>重号 {h.dupNos.join('、')}</span> : null}
              {h.dupNames.length ? <span>重名 {h.dupNames.join('、')}</span> : null}
            </span>
          ) : null}
        </span>
        <IconChevronRight size={17} />
      </button>

      {onEdit || onDelete ? (
        <div
          className="flex items-center gap-1 px-3 py-2"
          style={{
            borderTop: '1px solid var(--color-line)',
            background: 'var(--color-surface2)',
          }}
        >
          {onEdit && !isStream ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconCamera size={14} />}
              onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
            >
              拍照
            </Button>
          ) : null}
          {onEdit && !isStream ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPaste size={14} />}
              onClick={() => navigate(`/classes/${klass.id}/import/paste`)}
            >
              粘贴
            </Button>
          ) : null}
          <span className="flex-1" />
          {onEdit ? (
            <Button
              size="sm"
              variant="ghost"
              data-stream-edit={isStream ? '1' : undefined}
              icon={<IconPencil size={14} />}
              onClick={onEdit}
            >
              编辑
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="sm"
              variant="ghost"
              data-stream-del="1"
              icon={<IconTrash size={14} />}
              onClick={onDelete}
            >
              删除
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

/* ============================================================
   走班班的**编辑 / 删除**（2026-10-08：内测「走班班都没有编辑键」「删不了」）
   ------------------------------------------------------------
   三件事，各自复用**已有的那一条写路径**（一个新入口都不造）：
     · 改名 → `classes.name`，走 `remote.saveStreamName()`（= `saveClass`，
       它把 `kind` / `stream_key` 原样带上，不会把走班班存成行政班）；
     · 换老师 → `apiAssignStreamTeacher()`（服务端 → §32.3 `assign_stream_teacher()`，
       它同时补 `class_subjects`，**不另写一套**；上一轮"旧的行也留着"那个坑就在那里面修过）；
     · 成员 → `remote.saveStreamMembers()`（§37.1 `write_stream_members()`，
       **写的是 `class_members`**，多对多，一个学生可以同时在两个走班班里）。

   🔴 成员那一栏为什么必须手工：P7 的口径 ——「**「其他」组合的学生必须手工选走班班**」（§27.9）。
      所以这里既不是"自动算法的备胎"，也不去重跨班的关系。
   ⚠️ 界面上**故意不显示** `stream_key` / 组合标识这类内部键（§七 文案纪律：
      界面只回答"这里是什么、我能做什么"）。
   ============================================================ */
function StreamEditSheet({
  classId,
  classes,
  teacherId,
  onClose,
  onChanged,
  onDeleted,
}: {
  /** `null` = 关着 */
  classId: string | null
  classes: Klass[]
  /** 当前登录老师的 id（`saveClass` 要它当 `classes.teacher_id` 的兜底） */
  teacherId?: string
  onClose: () => void
  /** 成员写成功后 → 让外面那页重读 `class_members`（卡片上的人数要跟着变） */
  onChanged: () => void
  onDeleted: (name: string) => void
}) {
  const removeClass = useStore((s) => s.removeClass)
  const push = useToast((s) => s.push)

  const klass = classId ? classes.find((c) => c.id === classId) : undefined

  const [name, setName] = useState('')
  const [teacher, setTeacher] = useState('')
  const [teachers, setTeachers] = useState<DirTeacher[]>([])
  const [teachersKnown, setTeachersKnown] = useState(true)
  const [picker, setPicker] = useState<Student[]>([])
  const [pickerKnown, setPickerKnown] = useState(true)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  /*
   * 面板打开时这个走班班**原本**的老师。
   * 🔴 为什么要有它：`assign_stream_teacher()`（§32.3）的判据是
   *    `can_manage_grade_setup_for`（**不含班主任**），而改名那一条是 `can_manage_class_for`
   *    （**含班主任**）。所以"只改了个名字"绝不能顺手打一次换老师的 RPC ——
   *    那会让班主任改名**直接失败**（"你没有分配这个年级走班班老师的权限"）。
   */
  const [teacher0, setTeacher0] = useState('')

  /*
   * 打开面板时把三份数据取齐：这一行本身 / 全年级的学生 / 老师名录。
   * ⚠️ 全年级的学生来自 `loadGradeSetup()`（它只读**行政班**的 `students.class_id`，
   *    而一个学生**总是**挂在一个行政班上）—— 这不是"走班成员"那条读路径，
   *    走班成员在这儿是**被选中的那些**（`checked`，从 `class_members` 读）。
   * ⚠️ 走班班可能没有 `gradeId`（老数据）→ 那时选不了人，**显式说清**、不静默空着。
   */
  useEffect(() => {
    if (!classId || !klass) return
    setName(klass.name)
    setErr('')
    setConfirmDel(false)
    setChecked(new Set())
    setTeachersKnown(true)
    setPickerKnown(true)

    let alive = true
    void (async () => {
      /* ① 当前成员（`class_members` —— **不是** `klass.students`） */
      const m = await remote.loadClassMembers([classId])
      if (!alive) return
      if (m === null) {
        setPickerKnown(false)
      } else {
        setChecked(new Set(m[classId] ?? []))
      }
      /* ② 全年级的学生（走班成员只能从**本年级**里挑，§37.1 同一条口径） */
      if (klass.gradeId) {
        const g = await loadGradeSetup(klass.gradeId)
        if (!alive) return
        const all = g.classes.flatMap((c) => c.students).filter((s) => s.status === 'active')
        setPicker(all.sort(compareRoster))
        setPickerKnown(g.state !== 'unknown')
      } else {
        setPicker([])
      }
      /* ③ 老师名录 + 这个走班班现在的老师（`class_subjects`，§32.3 补的那几行） */
      const t = await listTeachers()
      if (!alive) return
      setTeachersKnown(t.ok)
      if (t.ok) setTeachers(t.data.teachers)
      const rows = await remote.loadClassSubjects([classId])
      if (!alive) return
      if (rows && rows.length) {
        setTeacher(rows[0].teacherId)
        setTeacher0(rows[0].teacherId)
      } else {
        setTeacher('')
        setTeacher0('')
      }
    })()
    return () => {
      alive = false
    }
    /* ⚠️ 只跟 `classId` 走：`klass` 每存一次都是新对象，跟着它会**无限重读** */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId])

  const toggle = (sid: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return next
    })
  }

  const save = async () => {
    if (!klass) return
    /* ⚠️ 还没拿到自己的 id 时**显式说一句**，不静默什么都不做（§三.5） */
    if (!teacherId) {
      setErr('还没读到你的账号，先刷新一下再保存。')
      return
    }
    setErr('')
    setBusy(true)
    /* ① 班名（**先写它**：它的那条路会把 `classes.teacher_id` 一并写成"当前登录人"，
          所以换老师必须在它**之后**写 —— 倒过来会把刚分配的走班老师冲掉） */
    const okName = await remote.saveStreamName({ ...klass, name: name.trim() }, teacherId)
    if (!okName) {
      setBusy(false)
      setErr('班名没能保存（数据库拒了这一条，或者断网）。')
      return
    }
    /* ② 换老师（**只在真换了人的时候打** —— 它是一次写 `classes.teacher_id` + 补 `class_subjects`，
          而且它的判据比改名那一条**窄**（不含班主任），多打一次会让纯改名也失败） */
    if (teacher && teacher !== teacher0) {
      const r = await apiAssignStreamTeacher(klass.grade ?? '', klass.id, teacher)
      if (!r.ok) {
        setBusy(false)
        setErr(r.message)
        return
      }
    }
    /* ③ 成员（整份替换；写的是 `class_members`） */
    const r = await remote.saveStreamMembers(klass.id, [...checked])
    setBusy(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    onChanged()
    push({ text: '已保存', tone: 'ok', desc: `成员 ${checked.size} 人` })
    onClose()
  }

  const del = () => {
    if (!klass) return
    removeClass(klass.id)
    onDeleted(klass.name)
  }

  const open = Boolean(classId && klass)

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="编辑走班班"
      footer={
        <div className="flex gap-2">
          <Button block onClick={onClose}>
            取消
          </Button>
          <Button block variant="primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label>
          <span className="label">班级名称</span>
          <input
            className="input"
            placeholder="例如 走班班-物化政"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label>
          <span className="label">走班老师</span>
          <select
            className="input"
            value={teacher}
            disabled={!teachersKnown}
            onChange={(e) => setTeacher(e.target.value)}
          >
            <option value="">{teachersKnown ? '还没分配' : '老师名录没读到'}</option>
            {/*
              🔴 「选老师去教书」的那一类下拉：只列**服务端说 `teachable` 的人**
              （`lib/accounts.ts` 的 `teachableOnly()`）—— 最高管理员是平台主人，
              不该被选去教书；⚠️ 教务处照旧在列。「教师管理」那一页**不筛**。
            */}
            {teachableOnly(teachers).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="flex items-baseline gap-2">
            <span className="label flex-1">走班成员</span>
            <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
              {pickerKnown ? `${checked.size} 人` : '成员没读到'}
            </span>
          </div>
          {!pickerKnown ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
              读不到这个走班班的成员（数据库可能还没跑 supabase/schema.sql 第 27 段）。
            </div>
          ) : !klass?.gradeId ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
              这个走班班没有年级，挑不了学生 —— 先在年级管理里把它挂到年级上。
            </div>
          ) : picker.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
              本年级还没有学生名单。
            </div>
          ) : (
            <div
              className="mt-2 flex flex-col overflow-y-auto"
              style={{ maxHeight: 260, border: '1px solid var(--color-line)', borderRadius: 6 }}
            >
              {picker.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 px-2.5 py-1.5"
                  style={{ borderBottom: '1px solid var(--color-line)', cursor: 'pointer' }}
                >
                  <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
                  <span className="flex-1 truncate" style={{ fontSize: 13 }}>
                    {s.name}
                  </span>
                  <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                    {s.studentNo}
                  </span>
                </label>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6 }}>
            一个学生可以同时在两个走班班里。
          </div>
        </div>

        {err ? (
          <div style={{ fontSize: 12, color: 'var(--color-bad)', lineHeight: 1.7 }}>{err}</div>
        ) : null}

        <div className="mt-2 border-t border-line pt-3">
          {confirmDel ? (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                删除「{klass?.name}」会一起删掉：{checked.size} 行成员关系、这个班的任教关系、
                挂在它上面的作业与考试、它的教室端账号；班级课表留下（只是不再属于任何班）。
                学生本身的档案不受影响。
              </div>
              <div className="mt-2 flex gap-2">
                <Button block size="sm" onClick={() => setConfirmDel(false)}>
                  先不删
                </Button>
                <Button block size="sm" variant="danger" onClick={del}>
                  确认删除
                </Button>
              </div>
            </>
          ) : (
            <Button
              block
              size="sm"
              variant="danger"
              icon={<IconTrash size={14} />}
              onClick={() => setConfirmDel(true)}
            >
              删除这个走班班
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  )
}

export default function Classes() {
  const classes = useStore((s) => s.classes)
  const addClass = useStore((s) => s.addClass)
  const updateClass = useStore((s) => s.updateClass)
  const removeClass = useStore((s) => s.removeClass)
  const myRoles = useStore((s) => s.myRoles)
  const teacherId = useStore((s) => s.teacher?.id)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', grade: '高二', year: '2025-2026' })

  /* 走班班的编辑 / 删除入口那个 id（null = 面板关着） */
  const [streamEdit, setStreamEdit] = useState<string | null>(null)

  /*
   * 🔴 **两种班分开显示**（P5 的统一模型 Q21 = A：走班班也是 `classes` 的一行）。
   *    · 这一页的语义是"行政班管理"（建班 / 录名单 / 核名单 / 班型）
   *      → 列表只列**行政班**。把走班班混进来会让"待核对"变成噪音：
   *        走班班的人来自 `class_members`（多对多），`students.class_id` 上永远是空的
   *        → 每一行都显示"缺号 1、2、3…"（**看起来很正常、其实错了**）。
   *    · 走班班单独一段列在下面，**只在真有走班班时渲染**
   *      （没有走班班的库上，这一页的字节与改造前逐字相同 —— P5 的验收第 1 条）。
   *    ⚠️ 判定入口只有 `lib/pick.ts` 的 `splitByKind()`；页面里不许再写 `kind === 'stream'`。
   */
  const { admin: adminClasses, stream: streamClasses } = splitByKind(classes)
  const totalStudents = adminClasses.reduce((n, c) => n + activeStudents(c).length, 0)

  /**
   * 走班班的成员（`class_members`，多对多）—— **懒加载 + 先探针**。
   *
   * 🔴 为什么不能像行政班那样从 `store.classes[].students` 里读：
   *    走班班的人在 `class_members` 上，`students.class_id` 里**永远没有他们**
   *    （一个学生同时在两个走班班里 = 多对多）。读错了源 → 恒为「0 人」。
   * ⚠️ `streamMembersKnown === false` = **没读到**（老库没那张表 / 断网），
   *    屏上必须写"名单没读到"，**不许写成"0 人"**（§三.4 的三态纪律）。
   */
  const [streamMembers, setStreamMembers] = useState<Record<string, Student[]>>({})
  const [streamMembersKnown, setStreamMembersKnown] = useState(false)
  const streamIds = streamClasses.map((c) => c.id).join(',')
  const streamIdList = streamIds ? streamIds.split(',') : []
  /* 🔴 一次读出来、**能重读**（走班班刚改完成员时要立刻反映到卡片的人数上 ——
         "改完屏上还是旧数字"在这个项目里会被读成"没落库"）。 */
  const loadStreamMembers = useCallback(
    () => remote.loadClassMembersFull(streamIdList),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamIds],
  )
  const refreshStreamMembers = useCallback(() => {
    void loadStreamMembers().then((r) => {
      setStreamMembersKnown(r.known)
      const by: Record<string, Student[]> = {}
      for (const [k, list] of Object.entries(r.by)) {
        by[k] = list.map((p, i) => ({
          id: p.id,
          name: p.name,
          studentNo: p.studentNo,
          status: p.status,
          createdAt: i,
        }))
      }
      setStreamMembers(by)
    })
  }, [loadStreamMembers])
  useEffect(() => {
    refreshStreamMembers()
  }, [refreshStreamMembers])

  const startNew = () => {
    setEditing(null)
    setForm({ name: '', grade: '高二', year: '2025-2026' })
    setOpen(true)
  }
  const startEdit = (id: string) => {
    const c = classes.find((x) => x.id === id)
    if (!c) return
    setEditing(id)
    setForm({ name: c.name, grade: c.grade, year: c.year })
    setOpen(true)
  }

  return (
    <>
      <PageHead
        title="班级"
        sub={
          `${adminClasses.length} 个班级 · ${totalStudents} 名学生` +
          /* 「另有 N 个走班班」只在真有走班班时才接上去 */
          (streamClasses.length ? ` · 另有 ${streamClasses.length} 个走班班` : '')
        }
        right={
          <Button size="sm" variant="primary" icon={<IconPlus size={15} />} onClick={startNew}>
            新建
          </Button>
        }
      />

      <Page>
        {adminClasses.length === 0 ? (
          <Panel className="overflow-hidden">
            <div className="empty">
              <IconUsers size={26} />
              <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>还没有班级</div>
              <Button variant="primary" size="sm" icon={<IconPlus size={15} />} onClick={startNew}>
                新建班级
              </Button>
            </div>
          </Panel>
        ) : (
          <div className="flex flex-col gap-2.5 stagger">
            {adminClasses.map((c) => (
              <ClassCard
                key={c.id}
                klass={c}
                rosterState={rosterStateOf(c.students, 'class')}
                onOpen={() => navigate(`/classes/${c.id}`)}
                onEdit={() => startEdit(c.id)}
              />
            ))}
          </div>
        )}

        {streamClasses.length ? (
          <div className="mt-5">
            <Sect>走班班</Sect>
            <div className="flex flex-col gap-2.5 stagger">
              {streamClasses.map((c) => {
                /*
                 * 🔴 走班班的编辑 / 删除入口（2026-10-08：内测「都没有编辑键」「删不了」）。
                 *
                 * 判据 = **数据库那一条的前端影子** `canEditClassFor()`（`lib/roles.ts`）——
                 * 它逐支对应 `can_manage_class_for()`：超管 / 教务处 ∪ **本年级**年级主任
                 * ∪ **本班**班主任。走班班是 `classes` 里 `kind='stream'` 的一行、**有
                 * `grade_id`**（§32.2 生成时从学生的年级取），所以年级主任那一支真的成立。
                 * ⚠️ 前端只决定**摆不摆**；真正那一刀在 `classes_update` / `classes_delete`
                 *    两条策略（以及成员那一条走 §37.1 的 `write_stream_members()`）。
                 * ⚠️ 这里**不新发明判据**：`kind` 一个字节都不参与权限判断。
                 */
                const mayManage = canEditClassFor(myRoles, c.id, c.gradeId)
                return (
                  <ClassCard
                    key={c.id}
                    klass={c}
                    rosterState={rosterStateOf(
                      streamMembers[c.id] ?? [],
                      'members',
                      streamMembersKnown,
                    )}
                    onOpen={() => navigate(`/classes/${c.id}`)}
                    onEdit={mayManage ? () => setStreamEdit(c.id) : undefined}
                    onDelete={mayManage ? () => setStreamEdit(c.id) : undefined}
                  />
                )
              })}
            </div>
          </div>
        ) : null}
      </Page>

      {/* 走班班的编辑 / 删除（改名 · 换老师 · 手工增删成员） */}
      <StreamEditSheet
        classId={streamEdit}
        classes={classes}
        teacherId={teacherId}
        onClose={() => setStreamEdit(null)}
        onChanged={() => refreshStreamMembers()}
        onDeleted={(name) => {
          setStreamEdit(null)
          push({ text: `已删除 ${name}`, tone: 'warn', desc: '成员关系与课表归属一起删掉' })
        }}
      />

      {/* 新建 / 编辑 */}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑班级' : '新建班级'}
        footer={
          <div className="flex gap-2">
            <Button block onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              block
              variant="primary"
              disabled={!form.name.trim()}
              onClick={() => {
                if (editing) {
                  updateClass(editing, form)
                  push({ text: '已保存', tone: 'ok' })
                } else {
                  const id = addClass(form)
                  push({ text: `已创建 ${form.name}`, tone: 'ok', desc: '接下来导入学生名单' })
                  navigate(`/classes/${id}`)
                }
                setOpen(false)
              }}
            >
              {editing ? '保存' : '创建并录名单'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <label>
            <span className="label">班级名称</span>
            <input
              className="input"
              placeholder="例如 高二(5)班"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">年级</span>
              <select
                className="input"
                value={form.grade}
                onChange={(e) => setForm({ ...form, grade: e.target.value })}
              >
                {['高一', '高二', '高三'].map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">学年</span>
              <input
                className="input"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
              />
            </label>
          </div>
          {editing ? (
            <Button
              variant="danger"
              block
              onClick={() => {
                removeClass(editing)
                setOpen(false)
                push({ text: '班级已删除', tone: 'warn' })
              }}
            >
              删除班级
            </Button>
          ) : null}
        </div>
      </Sheet>
    </>
  )
}
