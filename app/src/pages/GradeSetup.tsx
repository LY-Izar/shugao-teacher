import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconCheck, IconPaste } from '../components/icons'
import { Button, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { loadClassSubjects, loadGradeSetup, type ClassSubjectRow } from '../data/remote'
import { canAssignRoles } from '../lib/roles'
import { CLASS_TYPE_NAME, type ClassType, type Klass, type Student } from '../data/types'
import {
  classKindOf,
  classPickProgress,
  classTypeOf,
  isAdminClass,
  subjectAdvice,
  subjectCheck,
  PRIMARY_CODES,
  SECOND_CODES,
  type StudentSubject,
} from '../lib/pick'
import { subjectName } from '../lib/subjects'
import { ROSTER_HEADER, compareRoster, gradeRosterToText } from '../lib/roster'
import {
  applyRoster,
  classTypeLabel,
  collectByClassType,
  pickClassesBySpec,
  planRolePaste,
  planRosterImport,
  planSubjectPaste,
  type RosterPlan,
} from '../lib/gradeImport'
import {
  apiBulkClassSubjects,
  apiCanSetup,
  apiImportRoster,
  apiWriteSubjects,
  type CanSetupState,
  type ClassSubjectWriteRow,
  type SubjectWriteRow,
} from '../lib/gradeSetup'
import { listTeachers, setRole, type DirTeacher } from '../lib/accounts'

/* ============================================================
   「开学准备」页 `/grades/:id/setup`（`年级管理与选科走班方案.md` §4.3.2）
   ------------------------------------------------------------
   六步流水线：① 录名单 → ② 建班（自动）→ ③ 设班型 → ④ 采选科 → ⑤ 分配身份 → ⑥ 生成走班
   **⑥ 本轮不做**（走班班的生成是 P7）—— 界面上留着那一格，写清"还差什么"。

   🔴 四条纪律落在这个文件里的位置：
     · **操作步数**（这一轮的验收核心）：账本在 `lib/gradeImport.ts` 的 `StepLog` /
        `GRADE_SETUP_STEPS` 里，由 `grade-checks.mjs` 逐条断言 ——
        ⚠️ **它是给验收看的内部指标，一个字都不上屏**（2026-09-30：页面上那张步数表
        与"已点 N 步"整块删掉了）；
     · **一个事务**：名单导入先算 `planRosterImport()`（全成或全空），
       合法才发**一个**请求（服务端一个 RPC = 一个事务）；
     · **当场拦住**：选科粘贴逐行过 `subjectCheck()` + `planSubjectPaste()`，报行号；
     · **前端不另写判据**：`canSetup` 由服务端问数据库（`can_manage_grade_setup()`），
       这里只决定"摆不摆那几个按钮"（M1/M2）—— ⚠️ 它**必须走 `apiCanSetup()`**
       （那条链带着调用者的 JWT）；自己写一遍 `fetch` 就会漏带令牌 → 服务端 401 →
       超管被显示成"你的身份只能看"（2026-09-30 修掉的那个 bug）。
   ============================================================ */

/** 六个完成步骤（页头那一条进度用） */
const STEPS = [
  { key: 'roster', label: '录入名单' },
  { key: 'classes', label: '建班' },
  { key: 'type', label: '设班型' },
  { key: 'pick', label: '采集选科' },
  { key: 'roles', label: '分配身份' },
  { key: 'stream', label: '生成走班' },
] as const

export default function GradeSetup() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const myRoles = useStore((s) => s.myRoles)
  const atomClasses = useStore((s) => s.classes)
  const replaceGradeRoster = useStore((s) => s.replaceGradeRoster)
  const updateClassType = useStore((s) => s.updateClassType)

  const [loading, setLoading] = useState(true)
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof loadGradeSetup>> | null>(null)
  const [classes, setClasses] = useState<Klass[]>([])
  const [subjects, setSubjects] = useState<Map<string, StudentSubject>>(new Map())
  const [csRows, setCsRows] = useState<ClassSubjectRow[] | null>(null)
  const [teachers, setTeachers] = useState<DirTeacher[]>([])
  /**
   * 「我在这个年级能不能改」—— 服务端拿调用者 JWT 问数据库（`can_manage_grade_setup()`）。
   * `null` = **还在问**：这时候一个字都不说（别先喊一句"你的身份只能看，不能改"）。
   */
  const [setup, setSetup] = useState<CanSetupState | null>(null)
  const canSetup = setup?.canSetup === true

  const load = useCallback(async () => {
    const b = await loadGradeSetup(id)
    setBundle(b)
    /*
     * 远程模式的班与名单**以库里那一份为准**；本地演示模式（没有后端）用 store 里那一份。
     * ⚠️ 这不是"两套判据"：两边的形状是同一个 `Klass`，只是数据来源不同 ——
     *    与 `store.hydrate()` 在两种模式下的行为同款。
     */
    const fromStore = atomClasses.filter((k) => k.grade === b.grade?.name)
    const cls = b.classes.length ? b.classes : fromStore
    setClasses(cls)
    setSubjects(b.subjects)
    const cs = await loadClassSubjects(cls.map((k) => k.id))
    setCsRows(cs)
    setLoading(false)
  }, [id, atomClasses])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  /* 老师清单：只在「分配身份」那一步用得着 —— 读不到（本地模式）就空着，不拦着别的步骤 */
  const loadTeachers = useCallback(async () => {
    const r = await listTeachers()
    if (r.ok) setTeachers(r.data.teachers)
    else push({ text: r.message, tone: 'bad' })
  }, [push])

  useEffect(() => {
    if (!id) return
    let alive = true
    void (async () => {
      const s = await apiCanSetup(id)
      if (alive) setSetup(s)
    })()
    return () => {
      alive = false
    }
  }, [id])

  const gradeRows = useStore((s) => s.grades)
  const grade = bundle?.grade ?? gradeRows.find((g) => g.id === id) ?? null
  const admin = useMemo(() => classes.filter(isAdminClass), [classes])
  const students = useMemo(
    () => admin.flatMap((k) => k.students.filter((s) => s.status === 'active')),
    [admin],
  )

  /* ---------------- 六步各自的"完成没" ---------------- */
  const typeDone = admin.length > 0 && admin.every((k) => classTypeOf(k) !== '')
  const pickDone = students.length > 0 && students.every((s) => subjects.has(s.id))
  const headTeacherCount = teachers.filter((t) =>
    t.roles.some((r) => r.role === 'head_teacher' && admin.some((k) => k.id === r.scopeId)),
  ).length
  const rolesDone = admin.length > 0 && headTeacherCount >= admin.length
  const stepDone: Record<(typeof STEPS)[number]['key'], boolean> = {
    roster: students.length > 0,
    classes: admin.length > 0,
    type: typeDone,
    pick: pickDone,
    roles: rolesDone,
    stream: false,
  }

  /* ---------------- 弹层状态 ---------------- */
  const [sheet, setSheet] = useState<null | 'roster' | 'type' | 'pick' | 'roles'>(null)
  const closeSheet = () => setSheet(null)

  if (loading) {
    return (
      <>
        <PageHead title="开学准备" onBack={() => navigate('/grades')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在读这个年级…</span>
          </Panel>
        </Page>
      </>
    )
  }

  if (bundle?.state === 'missing') {
    return (
      <>
        <PageHead title="开学准备" onBack={() => navigate('/grades')} />
        <Page>
          <Panel bodyClass="p-4">
            <div style={{ fontSize: 14, fontWeight: 600 }}>数据库还没跑「开学准备」那一段</div>
            <p style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
              到 Supabase → SQL Editor 跑一遍仓库里 <code>supabase/schema.sql</code> 第 27 段，
              再回来刷新这一页。
            </p>
          </Panel>
        </Page>
      </>
    )
  }

  if (!grade) {
    return (
      <>
        <PageHead title="找不到这个年级" onBack={() => navigate('/grades')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>它可能已经被删了</span>
          </Panel>
        </Page>
      </>
    )
  }

  const clsNoOf = (k: Klass): string => {
    const m = k.name.match(/\(([^)]+)\)\s*班\s*$/)
    return m ? m[1] : k.name
  }

  return (
    <>
      <PageHead
        title={`开学准备 · ${grade.cohort ? `${grade.cohort}级` : ''}${grade.name}`}
        sub={`${admin.length} 个班 · ${students.length} 人`}
        onBack={() => navigate('/grades')}
        right={
          <Button size="sm" variant="ghost" onClick={() => navigate(`/grades/${grade.id}`)}>
            概览
          </Button>
        }
      />

      <Page>
        {/* ---------------- 页头那一条进度（把"还差什么"摊开，不用他记） ---------------- */}
        <Panel bodyClass="p-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s.key}
                style={{
                  fontSize: 12,
                  color: stepDone[s.key] ? 'var(--color-ok)' : 'var(--color-ink3)',
                }}
              >
                {stepDone[s.key] ? '✅' : '⬜'} {['①', '②', '③', '④', '⑤', '⑥'][i]} {s.label}
              </span>
            ))}
          </div>
          {/*
            「能不能改」只在**真的不能改**时说一句，而且说的是**真实原因**
            （没权限 / §27 没跑 / 没登 / 连不上）—— 见 `lib/gradeSetup.ts` 的 `readCanSetup`。
            班上几个人、班型设全没有，上面那一行 ✅/⬜ 已经说了，不再重复一遍。
          */}
          {setup?.notice ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
              {setup.notice}
            </div>
          ) : null}
        </Panel>

        {/* ---------------- ① 录名单 ---------------- */}
        <div className="mb-2">
          <Sect>① 录入名单</Sect>
          <Panel bodyClass="p-3">
            <RosterSummary classes={admin} students={students} subjects={subjects} />
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                icon={<IconPaste size={15} />}
                disabled={!canSetup}
                onClick={() => {
                  setSheet('roster')
                }}
              >
                从 Excel 粘贴名单
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  downloadRoster(grade.name, admin, clsNoOf)
                }}
              >
                导出名单（列名与导入同一套）
              </Button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
              四列：{ROSTER_HEADER.join(' / ')}。序列号留空就自动发号。
            </p>
          </Panel>
        </div>

        {/* ---------------- ② 建班（按班号自动） ---------------- */}
        <div className="mb-2">
          <Sect>② 建班</Sect>
          <Panel bodyClass="p-3">
            {admin.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>还没有班。</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {admin.map((k) => (
                  <Tag key={k.id} tone={classTypeOf(k) ? 'accent' : 'idle'}>
                    {k.name} {k.students.filter((s) => s.status === 'active').length} 人
                    {classTypeOf(k) ? ` · ${classTypeLabel(classTypeOf(k))}` : ''}
                  </Tag>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ---------------- ③ 批量设班型 ---------------- */}
        <div className="mb-2">
          <Sect>③ 设班型</Sect>
          <Panel bodyClass="p-3">
            <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              理科班默认物化生，文科班默认史政地。
            </div>
            <div className="mt-2.5">
              <Button
                size="sm"
                disabled={!canSetup || !admin.length}
                onClick={() => {
                  setSheet('type')
                }}
              >
                批量设班型
              </Button>
            </div>
          </Panel>
        </div>

        {/* ---------------- ④ 采集选科 ---------------- */}
        <div className="mb-2">
          <Sect>④ 采集选科</Sect>
          <Panel bodyClass="p-3">
            <PickSummary classes={admin} subjects={subjects} />
            <div className="mt-2.5">
              <Button
                size="sm"
                disabled={!canSetup || !students.length}
                onClick={() => {
                  setSheet('pick')
                }}
              >
                采集 / 改选科
              </Button>
            </div>
          </Panel>
        </div>

        {/* ---------------- ⑤ 分配身份 ---------------- */}
        <div className="mb-2">
          <Sect>⑤ 分配班主任 / 年级主任 / 任教</Sect>
          <Panel bodyClass="p-3">
            <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              班主任 {headTeacherCount}/{admin.length}
              {canAssignRoles(myRoles)
                ? ''
                : ' · 你的身份能建号，但指派身份只归教务处与最高管理员'}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canAssignRoles(myRoles) || !admin.length}
                onClick={() => {
                  if (!teachers.length) void loadTeachers()
                  setSheet('roles')
                }}
              >
                分配身份
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canSetup || !admin.length}
                onClick={() => {
                  if (!teachers.length) void loadTeachers()
                  setSheet('roles')
                }}
              >
                批量写任教关系
              </Button>
            </div>
          </Panel>
        </div>

        {/* ---------------- ⑥ 生成走班（本轮不做） ---------------- */}
        <div className="mb-4">
          <Sect>⑥ 生成走班</Sect>
          <Panel bodyClass="p-3">
            <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              走班班的生成还没做。
            </div>
          </Panel>
        </div>
      </Page>

      {/* ================= 弹层 ================= */}
      <Sheet
        open={sheet === 'roster'}
        onClose={closeSheet}
        title="录入这个年级的名单"
        footer={null}
      >
        <RosterSheet
          gradeName={grade.name}
          classes={admin}
          canSetup={canSetup}
          onDone={async (plan) => {
            const r = await apiImportRoster(
              grade.id,
              plan.rows.map((x) => ({
                classNo: x.classNo,
                studentNo: x.studentNo,
                name: x.name,
                serial: x.serial,
              })),
            )
            if (!r.ok) {
              push({ text: r.message, tone: 'bad' })
              return false
            }
            /* 本地演示模式（没有服务端）也要能看见结果 —— 走同一份计划 */
            replaceGradeRoster(grade.name, applyRoster(atomClasses, plan))
            if (r.roster.length) {
              replaceGradeRoster(
                grade.name,
                applyRosterFromServer(atomClasses, grade.name, r.roster),
              )
            }
            push({
              text: `导入完成：新建 ${r.classes} 个班、写入 ${r.students} 人`,
              tone: 'ok',
              desc: r.noSerial
                ? `⚠ ${r.noSerial} 人没拿到序列号（这一届的入校年份认不出来）`
                : undefined,
            })
            await load()
            return true
          }}
        />
      </Sheet>

      <Sheet open={sheet === 'type'} onClose={closeSheet} title="批量设班型">
        <TypeSheet
          gradeName={grade.name}
          classes={admin}
          canSetup={canSetup}
          onApply={async (patch) => {
            for (const [classId, t] of patch) updateClassType(classId, t)
            setClasses((prev) =>
              prev.map((k) => (patch.has(k.id) ? { ...k, classType: patch.get(k.id) } : k)),
            )
            push({ text: `已设 ${patch.size} 个班的班型`, tone: 'ok' })
          }}
        />
      </Sheet>

      <Sheet open={sheet === 'pick'} onClose={closeSheet} title="采集 / 改选科">
        <PickSheet
          gradeName={grade.name}
          classes={admin}
          subjects={subjects}
          canSetup={canSetup}
          write={async (rows: SubjectWriteRow[]) => {
            const r = await apiWriteSubjects(grade.id, rows)
            if (r.failures.length) {
              push({
                text: `${r.failures.length} 条没写进去`,
                tone: 'bad',
                desc: r.failures[0]?.reason,
              })
            } else if (r.ok) {
              push({ text: `已保存 ${r.written} 个学生的选科`, tone: 'ok' })
            } else {
              push({ text: r.message, tone: 'bad' })
            }
            /* 本地演示模式：服务端不在时也要看得见结果（同一个事务的落点） */
            setSubjects((prev) => {
              const next = new Map(prev)
              for (const row of rows) next.set(row.studentId, { ...row })
              return next
            })
            return r.ok
          }}
        />
      </Sheet>

      <Sheet open={sheet === 'roles'} onClose={closeSheet} title="分配身份 / 批量写任教关系">
        <RolesSheet
          grade={grade}
          classes={admin}
          teachers={teachers}
          csRows={csRows}
          canAssign={canAssignRoles(myRoles)}
          canSetup={canSetup}
          onAssignHeadTeacher={async (teacherId, classId, on) => {
            const r = await setRole({
              teacherId,
              role: 'head_teacher',
              scopeType: 'class',
              scopeId: classId,
              on,
            })
            if (!r.ok) push({ text: r.message, tone: 'bad' })
            else {
              push({ text: on ? '已设为班主任' : '已取消班主任', tone: 'ok' })
              await loadTeachers()
            }
          }}
          onAssignGradeHead={async (teacherId) => {
            const r = await setRole({
              teacherId,
              role: 'grade_head',
              scopeType: 'grade',
              scopeId: grade.id,
              on: true,
            })
            if (!r.ok) push({ text: r.message, tone: 'bad' })
            else {
              push({ text: '已设为年级主任（一个年级只允许一个）', tone: 'ok' })
              await loadTeachers()
            }
          }}
          onBulkSubjects={async (rows: ClassSubjectWriteRow[]) => {
            const r = await apiBulkClassSubjects(grade.id, rows)
            push({ text: r.message, tone: r.ok ? 'ok' : 'bad' })
            if (r.ok) {
              const cs = await loadClassSubjects(admin.map((k) => k.id))
              setCsRows(cs)
            }
          }}
        />
      </Sheet>
    </>
  )
}

/* ============================================================
   小工具
   ============================================================ */

/** 从服务端回来的名单重建班与学生（**只补这一页要显示的东西**） */
function applyRosterFromServer(
  classes: readonly Klass[],
  gradeName: string,
  roster: Array<{ id: string; classId: string; studentNo: string; name: string; serial: string }>,
): Klass[] {
  const byClass = new Map<string, typeof roster>()
  for (const r of roster) {
    const list = byClass.get(r.classId) ?? []
    list.push(r)
    byClass.set(r.classId, list)
  }
  return classes.map((k) => {
    const rows = byClass.get(k.id)
    if (!rows) return k
    return {
      ...k,
      grade: gradeName,
      students: rows
        .map((r) => {
          /*
           * ⚠️ 服务端那条 upsert **不覆盖**已有的序列号（`serial = case when '' then …`），
           *    所以本地这一份也要照同一条规矩来：**已有的序列号从本地那一份里取**。
           *    取服务端回来的值 = 前端显示一个库里其实没变的号（"看起来对了其实没写进去"）。
           */
          const prev = k.students.find((s) => s.id === r.id)
          const serial = prev?.serial || r.serial
          return {
            id: r.id,
            studentNo: r.studentNo,
            name: r.name,
            status: prev?.status ?? ('active' as const),
            ...(serial ? { serial } : {}),
            createdAt: prev?.createdAt ?? k.createdAt,
          }
        })
        /* 名单排序只有一处（`compareRoster`）：有序列号按序列号排，没有才按班内学号 */
        .sort((a, b) => compareRoster(a, b)),
    }
  })
}

/** 导出名单（**表头与导入同一套列名** —— 导出的文件能直接导回来） */
function downloadRoster(
  gradeName: string,
  classes: readonly Klass[],
  clsNoOf: (k: Klass) => string,
): void {
  const rows = classes.flatMap((k) =>
    k.students
      .filter((s) => s.status === 'active')
      .map((s) => ({
        classNo: clsNoOf(k),
        serial: s.serial ?? '',
        name: s.name,
        studentNo: s.studentNo,
      })),
  )
  const text = gradeRosterToText(rows)
  try {
    const blob = new Blob([`\ufeff${text}`], { type: 'text/tab-separated-values;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${gradeName}-名单.tsv`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    void navigator.clipboard?.writeText(text)
  }
}

/* ============================================================
   各步骤的"摘要"（页面上那几行字）
   ============================================================ */

function RosterSummary({
  classes,
  students,
  subjects,
}: {
  classes: readonly Klass[]
  students: readonly Student[]
  subjects: ReadonlyMap<string, StudentSubject>
}) {
  void subjects
  if (!students.length) {
    return (
      <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
        还没有名单。粘一次，整个年级的人都在。
      </div>
    )
  }
  const noSerial = students.filter((s) => !s.serial).length
  return (
    <div className="flex flex-wrap gap-1.5">
      <Tag tone="accent">{students.length} 人</Tag>
      <Tag tone="idle">{classes.length} 个班</Tag>
      {noSerial ? <Tag tone="warn">{noSerial} 人没有序列号</Tag> : <Tag tone="ok">序列号齐全</Tag>}
    </div>
  )
}

function PickSummary({
  classes,
  subjects,
}: {
  classes: readonly Klass[]
  subjects: ReadonlyMap<string, StudentSubject>
}) {
  if (!classes.length) {
    return <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>先录名单。</div>
  }
  const rows = classes.map((k) => ({ k, p: classPickProgress(k, subjects) }))
  const done = rows.filter((r) => r.p.complete).length
  const other = [...subjects.values()].filter((s) => s.kind === 'other').length
  return (
    <div className="flex flex-wrap gap-1.5">
      <Tag tone={done === rows.length ? 'ok' : 'idle'}>
        {done}/{rows.length} 个班采全
      </Tag>
      {other ? <Tag tone="warn">「其他」{other} 人（必须手工选走班科目）</Tag> : null}
    </div>
  )
}

/* ============================================================
   ① 录名单那一层
   ============================================================ */

function RosterSheet({
  gradeName,
  classes,
  canSetup,
  onDone,
}: {
  gradeName: string
  classes: readonly Klass[]
  canSetup: boolean
  onDone: (plan: Extract<RosterPlan, { ok: true }>) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  /* 预览 = 每敲一个字都算一遍？不 —— 只在"点了预览"之后算（省得一边贴一边报错） */
  const [plan, setPlan] = useState<RosterPlan | null>(null)
  const [showAll, setShowAll] = useState(false)

  const preview = () => {
    setPlan(planRosterImport({ text, gradeName, classes: [], existing: classes }))
  }

  return (
    <div>
      <Sect>粘贴（四列：{ROSTER_HEADER.join(' / ')}）</Sect>
      <textarea
        className="input"
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setPlan(null)
        }}
        placeholder={
          `${ROSTER_HEADER.join('\t')}\n1\t2026001\t王志远\t01\n1\t2026002\t李思涵\t02\n2\t2026003\t张雨欣\t01`
        }
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6 }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setText('')} disabled={!text}>
          清空
        </Button>
        <Button size="sm" onClick={preview} disabled={!text}>
          看预览
        </Button>
      </div>

      {plan ? (
        <div className="mt-3">
          <Sect>预览</Sect>
          {plan.ok ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Tag tone="ok">{plan.students} 行都能入</Tag>
                {plan.newClasses.length ? (
                  <Tag tone="accent">将创建 {plan.newClasses.length} 个班</Tag>
                ) : null}
                {plan.reusedClasses.length ? (
                  <Tag tone="idle">复用 {plan.reusedClasses.length} 个已有班</Tag>
                ) : null}
                <Tag tone="idle">新增 {plan.added} · 更新 {plan.updated}</Tag>
              </div>
              {plan.newClasses.length ? (
                <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                  将创建：{plan.newClasses.join('、')}
                </p>
              ) : null}
              <div className="mt-2 max-h-[34vh] overflow-y-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 48 }}>行</th>
                      <th style={{ width: 56 }}>班号</th>
                      <th style={{ width: 84 }}>序列号</th>
                      <th>姓名</th>
                      <th style={{ width: 72 }}>班内学号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? plan.checked : plan.checked.slice(0, 12)).map((r) => (
                      <tr key={r.line}>
                        <td className="num" style={{ color: 'var(--color-ink4)' }}>
                          {r.line}
                        </td>
                        <td className="num">{r.classNo}</td>
                        <td className="num" style={{ color: r.serial ? undefined : 'var(--color-ink3)' }}>
                          {r.serial || '自动发号'}
                        </td>
                        <td>{r.name}</td>
                        <td className="num">{r.studentNo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.checked.length > 12 ? (
                <button
                  type="button"
                  className="mt-1.5"
                  style={{ fontSize: 12, color: 'var(--color-accent)' }}
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? '收起' : `还有 ${plan.checked.length - 12} 行`}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <div
                className="flex items-start gap-1.5"
                style={{ color: 'var(--color-warn)', fontSize: 13 }}
              >
                <IconAlert size={15} />
                <span>
                  {plan.line ? `第 ${plan.line} 行：` : ''}
                  {plan.reason}
                </span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
                这一批一行都不会入库（一个事务）。改掉上面那一行再贴一次。
              </p>
              <div className="mt-2 max-h-[30vh] overflow-y-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 48 }}>行</th>
                      <th style={{ width: 56 }}>班号</th>
                      <th>姓名</th>
                      <th style={{ width: 72 }}>班内学号</th>
                      <th style={{ width: 120 }}>问题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.checked.slice(0, 40).map((r) => (
                      <tr key={r.line} data-flag={r.flag !== 'ok' ? 'true' : undefined}>
                        <td className="num" style={{ color: 'var(--color-ink4)' }}>
                          {r.line}
                        </td>
                        <td className="num">{r.classNo || '—'}</td>
                        <td>{r.name || '—'}</td>
                        <td className="num">{r.studentNo || '—'}</td>
                        <td style={{ fontSize: 12, color: r.flag === 'ok' ? 'var(--color-ok)' : 'var(--color-warn)' }}>
                          {r.flag === 'ok' ? '正常' : r.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="mt-4">
        <Button
          block
          variant="primary"
          disabled={!canSetup || busy || !plan?.ok}
          icon={<IconCheck size={16} />}
          onClick={async () => {
            if (!plan?.ok) return
            setBusy(true)
            const ok = await onDone(plan)
            setBusy(false)
            if (ok) {
              setText('')
              setPlan(null)
            }
          }}
        >
          {busy ? '正在导入…' : plan?.ok ? `确认导入 ${plan.students} 行` : '先看预览'}
        </Button>
      </div>
    </div>
  )
}

/* ============================================================
   ③ 设班型那一层
   ============================================================ */

function TypeSheet({
  gradeName,
  classes,
  canSetup,
  onApply,
}: {
  gradeName: string
  classes: readonly Klass[]
  canSetup: boolean
  onApply: (patch: Map<string, ClassType>) => Promise<void>
}) {
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = pickClassesBySpec(classes, gradeName, spec)
  const [perClass, setPerClass] = useState<Map<string, ClassType>>(new Map())

  const apply = async (t: ClassType) => {
    /* 两种用法共用这一处：按班号批量（有 spec）或整年级一键（spec 为空） */
    const target = spec.trim() ? parsed.hit : classes
    if (!target.length) return
    const patch = new Map<string, ClassType>()
    for (const k of target) patch.set(k.id, t)
    setBusy(true)
    await onApply(patch)
    setBusy(false)
  }

  return (
    <div>
      <Sect>整年级一键</Sect>
      <div className="flex flex-wrap gap-2">
        {(['science', 'arts', 'undivided', ''] as ClassType[]).map((t) => (
          <Button key={t || 'clear'} size="sm" disabled={!canSetup || busy} onClick={() => apply(t)}>
            {t === '' ? '全部清空' : `全部设为${CLASS_TYPE_NAME[t]}`}
          </Button>
        ))}
      </div>

      <div className="mt-4">
        <Sect>或按班号批量</Sect>
        <input
          className="input"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder="1-4 或 5,6,7"
        />
        <div className="mt-1.5" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          {spec.trim()
            ? `认到 ${parsed.hit.length} 个班：${parsed.hit.map((k) => k.name).join('、') || '（没有）'}`
            : '支持 1-4 这种区间与 5,6 这种列举'}
          {parsed.missing.length ? ` · 没有这些班：${parsed.missing.join('、')}` : ''}
          {parsed.bad.length ? ` · 认不出的写法：${parsed.bad.join('、')}` : ''}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(['science', 'arts', 'undivided'] as ClassType[]).map((t) => (
            <Button
              key={t}
              size="sm"
              disabled={!canSetup || busy || !spec.trim() || !parsed.hit.length}
              onClick={() => apply(t)}
            >
              设为{CLASS_TYPE_NAME[t]}
            </Button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <Sect>逐个班改</Sect>
        {classes.map((k) => (
          <div key={k.id} className="flex items-center gap-2 py-1.5" style={{ borderBottom: '1px solid var(--color-line)' }}>
            <span style={{ flex: 1, fontSize: 13 }}>{k.name}</span>
            <div className="seg">
              {(['', 'undivided', 'arts', 'science'] as ClassType[]).map((t) => (
                <button
                  key={t || 'unset'}
                  type="button"
                  data-on={(perClass.get(k.id) ?? classTypeOf(k)) === t}
                  disabled={!canSetup}
                  onClick={() => {
                    setPerClass((prev) => new Map(prev).set(k.id, t))
                    void onApply(new Map([[k.id, t]]))
                  }}
                >
                  {CLASS_TYPE_NAME[t]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============================================================
   ④ 采选科那一层
   ============================================================ */

function PickSheet({
  gradeName,
  classes,
  subjects,
  canSetup,
  write,
}: {
  gradeName: string
  classes: readonly Klass[]
  subjects: ReadonlyMap<string, StudentSubject>
  canSetup: boolean
  write: (rows: SubjectWriteRow[]) => Promise<boolean>
}) {
  void gradeName
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  /** 「一键全部按班型默认」的**预览**（按下按钮只算不写；再点一次「确认铺开」才落库） */
  const [preview, setPreview] = useState<ReturnType<typeof collectByClassType> | null>(null)

  const bySerial = useMemo(() => {
    const m = new Map<string, { student: Student; classNo: string }>()
    for (const k of classes) {
      const no = k.name.match(/\(([^)]+)\)\s*班\s*$/)?.[1] ?? k.name
      for (const s of k.students) {
        if (s.serial) m.set(s.serial, { student: s, classNo: no })
      }
    }
    return m
  }, [classes])

  const byClassNoStudentNo = useMemo(() => {
    const m = new Map<string, { student: Student; classNo: string }>()
    for (const k of classes) {
      const no = k.name.match(/\(([^)]+)\)\s*班\s*$/)?.[1] ?? k.name
      for (const s of k.students) m.set(`${no}|${s.studentNo}`, { student: s, classNo: no })
    }
    return m
  }, [classes])

  const plan = useMemo(
    () => (paste.trim() ? planSubjectPaste({ text: paste, classes, bySerial, byClassNoStudentNo }) : null),
    [paste, classes, bySerial, byClassNoStudentNo],
  )

  const outliers = useMemo(
    () =>
      classes.flatMap((k) => {
        const t = classTypeOf(k)
        return k.students
          .filter((s) => s.status === 'active')
          .map((s) => ({ k, s, adv: subjectAdvice(t, subjects.get(s.id) ?? null) }))
          .filter((x) => x.adv)
      }),
    [classes, subjects],
  )

  return (
    <div>
      <Sect>一键全部按班型默认</Sect>
      <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
        理科班 → 物化生 · 文科班 → 史政地。未分科 / 还没设班型的班不动，「其他」的学生不动。
      </div>
      <div className="mt-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!canSetup || busy}
          onClick={() => {
            /*
             * ⚠️ 这一步**只算不写**（"预览"）—— 与「录入名单」那一步同一款：
             *    按下之后先给一遍"将写 N 人 / 几个班的默认铺不开"，
             *    用户看过再点「确认铺开」。开学准备是一次点到库里没有回头路（这条路上没有撤销）。
             */
            setPreview(collectByClassType(classes, subjects))
          }}
        >
          一键全部按班型默认
        </Button>
      </div>

      {preview ? (
        <div
          className="mt-2"
          style={{ border: '1px solid var(--color-line2)', borderRadius: 6, padding: 10 }}
        >
          {preview.rows.length ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Tag tone="accent">将铺开 {preview.rows.length} 人</Tag>
                {preview.unchanged ? <Tag tone="idle">{preview.unchanged} 人本来就是默认</Tag> : null}
                {preview.otherKept ? <Tag tone="warn">{preview.otherKept} 个「其他」的学生不动</Tag> : null}
              </div>
              {preview.skippedClasses.length ? (
                <div style={{ fontSize: 12, color: 'var(--color-warn)', marginTop: 6, lineHeight: 1.7 }}>
                  这些班铺不开（未分科 / 还没设班型）：
                  {preview.skippedClasses.map((x) => `${x.name}（${x.why}）`).join('、')}
                </div>
              ) : null}
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
              {preview.skippedClasses.length
                ? `没有可铺开的：${preview.skippedClasses.map((x) => `${x.name}（${x.why}）`).join('、')}`
                : '已经是班型默认了，不用再写。'}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!canSetup || busy || !preview.rows.length}
              onClick={async () => {
                setBusy(true)
                const ok = await write(preview.rows)
                setBusy(false)
                setMsg(
                  [
                    ok ? `已铺开 ${preview.rows.length} 人` : `写了 ${preview.rows.length} 人，有几条被拒`,
                    preview.unchanged ? `${preview.unchanged} 人本来就是默认` : '',
                    preview.otherKept ? `${preview.otherKept} 个「其他」的学生没动` : '',
                    preview.skippedClasses.length
                      ? `没铺开的班：${preview.skippedClasses.map((x) => `${x.name}（${x.why}）`).join('、')}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
                setPreview(null)
              }}
            >
              确认铺开 {preview.rows.length} 人
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <Sect>粘贴差异名单（只贴要改的那几个人）</Sect>
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          一行一个人：{' '}
          <code>班号 · 序列号（或班内学号）· 组合名</code>，例如 <code>1 01 物化政</code>。
          合法组合只有 12 种；非法组合当场拦住。
        </div>
        <textarea
          className="input mt-2"
          rows={5}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'1\t01\t物化政\n1\t02\t物化生\n2\t2026007\t史政地'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6 }}
        />
        {plan ? (
          <div className="mt-2">
            {plan.ok ? (
              <Tag tone="ok">{plan.rows.length} 行都能入</Tag>
            ) : (
              <div className="flex items-start gap-1.5" style={{ color: 'var(--color-warn)', fontSize: 13 }}>
                <IconAlert size={15} />
                <span>
                  第 {plan.line} 行：{plan.reason}
                </span>
              </div>
            )}
            <div className="mt-1.5">
              {plan.lines.slice(0, 8).map((l) => (
                <div key={l.line} style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                  第 {l.line} 行 {l.who || '（认不出）'} {l.combo} — {l.note}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-2">
          <Button
            size="sm"
            disabled={!canSetup || busy || !plan?.ok}
            onClick={async () => {
              if (!plan?.ok) return
              setBusy(true)
              const ok = await write(plan.rows)
              setBusy(false)
              if (ok) {
                setPaste('')
                setMsg(`已改 ${plan.rows.length} 个人的选科`)
              }
            }}
          >
            确认这批选科
          </Button>
        </div>
      </div>

      {/* 首选与班型不符 → 建议转班（不静默放过、也不自动改） */}
      {outliers.length ? (
        <div className="mt-4">
          <Sect>首选与班型不符（建议转班）</Sect>
          {outliers.slice(0, 20).map((x) => (
            <div key={x.s.id} style={{ fontSize: 12.5, color: 'var(--color-warn)', lineHeight: 1.8 }}>
              {x.k.name} · {x.s.name}：{x.adv}
            </div>
          ))}
          {outliers.length > 20 ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
              还有 {outliers.length - 20} 个
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 「其他」的学生：必须手工选走班科目 */}
      <OtherPicker classes={classes} subjects={subjects} canSetup={canSetup} write={write} />

      {msg ? (
        <p style={{ fontSize: 12.5, color: 'var(--color-ink2)', marginTop: 12, lineHeight: 1.7 }}>{msg}</p>
      ) : null}
      <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 12, lineHeight: 1.7 }}>
        12 种合法组合 = 首选（{PRIMARY_CODES.map((c) => subjectName(c)).join(' / ')}）
        + 再选两门（{SECOND_CODES.map((c) => subjectName(c)).join(' / ')}）。
        学校开不出的组合走「其他」，那种学生要手工选走班科目。
      </p>
    </div>
  )
}

/** 「其他」的学生：**必须手工选走班科目**（走班班成员的唯一手工入口） */
function OtherPicker({
  classes,
  subjects,
  canSetup,
  write,
}: {
  classes: readonly Klass[]
  subjects: ReadonlyMap<string, StudentSubject>
  canSetup: boolean
  write: (rows: SubjectWriteRow[]) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [studentId, setStudentId] = useState('')
  const [note, setNote] = useState('')
  const [second, setSecond] = useState<string[]>([])
  const [member, setMember] = useState<string[]>([])

  const students = classes.flatMap((k) =>
    k.students.filter((s) => s.status === 'active').map((s) => ({ k, s })),
  )
  const streamClasses = classes.filter((k) => classKindOf(k) === 'stream')
  const picked = students.find((x) => x.s.id === studentId)
  const err = subjectCheck({ kind: 'other', primaryCode: '', secondCodes: second, note })

  if (!open) {
    return (
      <div className="mt-4">
        <Sect>「其他」的学生</Sect>
        <Button size="sm" variant="ghost" disabled={!canSetup} onClick={() => setOpen(true)}>
          标为「其他」+ 填原因 + 手选走班科目
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-4">
      <Sect>「其他」的学生</Sect>
      <select className="input" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
        <option value="">选一个学生…</option>
        {students.map((x) => (
          <option key={x.s.id} value={x.s.id}>
            {x.k.name} · {x.s.name}（{x.s.studentNo}）
          </option>
        ))}
      </select>
      <input
        className="input mt-2"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="原因，例如：转学插班，待定"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SECOND_CODES.map((c) => (
          <button
            key={c}
            type="button"
            className="tag"
            data-on={second.includes(c)}
            onClick={() =>
              setSecond((prev) =>
                prev.includes(c) ? prev.filter((x) => x !== c) : prev.length >= 2 ? prev : [...prev, c],
              )
            }
          >
            {subjectName(c)}
          </button>
        ))}
      </div>
      <div className="mt-2">
        <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          手工选走班班（至少要选一个）：
        </div>
        {streamClasses.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-warn)', marginTop: 4 }}>
            这个年级还没有走班班。
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {streamClasses.map((k) => (
              <button
                key={k.id}
                type="button"
                className="tag"
                data-on={member.includes(k.id)}
                onClick={() =>
                  setMember((prev) => (prev.includes(k.id) ? prev.filter((x) => x !== k.id) : [...prev, k.id]))
                }
              >
                {k.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {err ? (
        <p style={{ fontSize: 12.5, color: 'var(--color-warn)', marginTop: 8 }}>{err}</p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!canSetup || !!err || !studentId || !member.length}
          onClick={async () => {
            const ok = await write([
              {
                studentId,
                kind: 'other',
                primaryCode: '',
                secondCodes: second,
                note,
                memberClassIds: member,
              },
            ])
            if (ok) {
              setOpen(false)
              setStudentId('')
              setNote('')
              setSecond([])
              setMember([])
            }
          }}
        >
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          取消
        </Button>
      </div>
      {picked && subjects.get(picked.s.id)?.kind === 'other' ? (
        <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
          他已经是「其他」了：{subjects.get(picked.s.id)?.note}
        </p>
      ) : null}
    </div>
  )
}

/* ============================================================
   ⑤ 分配身份 / 批量写任教关系
   ============================================================ */

function RolesSheet({
  grade,
  classes,
  teachers,
  csRows,
  canAssign,
  canSetup,
  onAssignHeadTeacher,
  onAssignGradeHead,
  onBulkSubjects,
}: {
  grade: { id: string; name: string }
  classes: readonly Klass[]
  teachers: readonly DirTeacher[]
  csRows: ClassSubjectRow[] | null
  canAssign: boolean
  canSetup: boolean
  onAssignHeadTeacher: (teacherId: string, classId: string, on: boolean) => Promise<void>
  onAssignGradeHead: (teacherId: string) => Promise<void>
  onBulkSubjects: (rows: ClassSubjectWriteRow[]) => Promise<void>
}) {
  const [headTeacher, setHeadTeacher] = useState('')
  const [gradeHead, setGradeHead] = useState('')
  const [bulkTeacher, setBulkTeacher] = useState('')
  const [bulkSubject, setBulkSubject] = useState('chinese')
  const [bulkSpec, setBulkSpec] = useState('')
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * 粘贴的三列 → 要写的行。**用的是那个纯函数**（`planRolePaste`），
   * 所以"认不出的报行号、一行都不写"这套判据与 `grade-checks.mjs` 里断言的是同一份。
   */
  const rolePlan = useMemo(
    () => (paste.trim() ? planRolePaste({ text: paste, gradeName: grade.name, classes, teachers }) : null),
    [paste, grade.name, classes, teachers],
  )

  /** 谁在哪个班当班主任（从老师那一侧的 roles 反查 —— 与 `/accounts` 同一份数据） */
  const headOf = (classId: string): string =>
    teachers.find((t) =>
      t.roles.some((r) => r.role === 'head_teacher' && r.scopeId === classId),
    )?.name ?? ''

  const bulkTargets = bulkSpec.trim()
    ? pickClassesBySpec(classes, grade.name, bulkSpec).hit
    : classes

  return (
    <div>
      <Sect>年级主任（一个年级只允许一个）</Sect>
      <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
        一个年级只设一位年级主任；换人要先撤掉前一个。
      </div>
      <div className="mt-2 flex gap-2">
        <select className="input" value={gradeHead} onChange={(e) => setGradeHead(e.target.value)}>
          <option value="">选一位老师…</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!canAssign || !gradeHead || busy}
          onClick={async () => {
            setBusy(true)
            await onAssignGradeHead(gradeHead)
            setBusy(false)
          }}
        >
          设为年级主任
        </Button>
      </div>

      <div className="mt-4">
        <Sect>班主任（一个班一位）</Sect>
        <div className="flex gap-2">
          <select className="input" value={headTeacher} onChange={(e) => setHeadTeacher(e.target.value)}>
            <option value="">选一位老师…</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-2">
          {classes.map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-2 py-1.5"
              style={{ borderBottom: '1px solid var(--color-line)' }}
            >
              <span style={{ flex: 1, fontSize: 13 }}>{k.name}</span>
              <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>{headOf(k.id) || '未指定'}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!canAssign || !headTeacher || busy}
                onClick={async () => {
                  setBusy(true)
                  await onAssignHeadTeacher(headTeacher, k.id, true)
                  setBusy(false)
                }}
              >
                设为班主任
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <Sect>粘贴批量指定任教关系</Sect>
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          把 Excel 里那三列直接粘进来（<code>班级 · 科目 · 老师</code>）。
          认不出的班名 / 科目 / 老师会报行号，一行都不写。
        </div>
        <textarea
          className="input mt-2"
          rows={5}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder={'高一(1)班\t语文\t张老师\n高一(1)班\t数学\t李老师\n高一(2)班\t语文\t张老师'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.6 }}
        />
        {rolePlan ? (
          <div className="mt-2">
            {rolePlan.ok ? (
              <div className="flex flex-wrap gap-1.5">
                <Tag tone="ok">
                  {rolePlan.rows.length} 行 · {rolePlan.classes} 个班 × {rolePlan.subjects} 科 · 涉及{' '}
                  {rolePlan.teachers} 位老师
                </Tag>
              </div>
            ) : (
              <div className="flex items-start gap-1.5" style={{ color: 'var(--color-warn)', fontSize: 13 }}>
                <IconAlert size={15} />
                <span>
                  第 {rolePlan.line} 行：{rolePlan.reason}
                </span>
              </div>
            )}
            <div className="mt-1.5">
              {rolePlan.lines.slice(0, 6).map((l) => (
                <div key={l.line} style={{ fontSize: 12, color: l.bad ? 'var(--color-warn)' : 'var(--color-ink3)' }}>
                  第 {l.line} 行 {l.className} · {l.subject} · {l.teacher} {l.bad ? `— ${l.bad}` : ''}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!canSetup || busy || !rolePlan?.ok}
            onClick={async () => {
              if (!rolePlan?.ok) return
              setBusy(true)
              await onBulkSubjects(rolePlan.rows.map((r) => ({ classId: r.classId, subjectCode: r.subjectCode, teacherId: r.teacherId })))
              setBusy(false)
              setPaste('')
            }}
          >
            {rolePlan?.ok ? `确认写入 ${rolePlan.rows.length} 行` : '先粘贴三列'}
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <Sect>或按老师批量（一位老师教全年级）</Sect>
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          选老师 + 选学科 + 班号（`1-4` / 留空 = 全部），一次写完。
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <select className="input" value={bulkTeacher} onChange={(e) => setBulkTeacher(e.target.value)}>
            <option value="">选老师…</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select className="input" value={bulkSubject} onChange={(e) => setBulkSubject(e.target.value)}>
            {SUBJECT_OPTIONS.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={bulkSpec}
            onChange={(e) => setBulkSpec(e.target.value)}
            placeholder="1-4 或留空 = 全部"
          />
        </div>
        <div className="mt-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          将写 {bulkTargets.length} 行：{bulkTargets.map((k) => k.name).join('、') || '（没有）'}
          {csRows === null ? ' · 现有任课关系没读到（不影响写）' : ` · 现有 ${csRows.length} 行`}
        </div>
        <div className="mt-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!canSetup || !bulkTeacher || busy || !bulkTargets.length}
            onClick={async () => {
              setBusy(true)
              await onBulkSubjects(
                bulkTargets.map((k) => ({
                  classId: k.id,
                  subjectCode: bulkSubject,
                  teacherId: bulkTeacher,
                })),
              )
              setBusy(false)
            }}
          >
            写入 {bulkTargets.length} 行
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 学科下拉的选项（15 科全列；任课关系可以是任何一科，不只是走班那四科） */
const SUBJECT_OPTIONS: Array<{ code: string; name: string }> = [
  { code: 'chinese', name: '语文' },
  { code: 'math', name: '数学' },
  { code: 'english', name: '英语' },
  { code: 'physics', name: '物理' },
  { code: 'chemistry', name: '化学' },
  { code: 'biology', name: '生物' },
  { code: 'politics', name: '政治' },
  { code: 'history', name: '历史' },
  { code: 'geography', name: '地理' },
  { code: 'it', name: '信息技术' },
  { code: 'general_tech', name: '通用技术' },
  { code: 'pe', name: '体育' },
  { code: 'music', name: '音乐' },
  { code: 'art', name: '美术' },
  { code: 'mental_health', name: '心理健康' },
]
