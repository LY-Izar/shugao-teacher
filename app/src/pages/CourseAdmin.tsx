import { useEffect, useMemo, useState } from 'react'
import { IconCheck, IconChevronRight, IconGrid, IconStack, IconSwap } from '../components/icons'
import { Button, Empty, Modal, Panel, Sect, Tag } from '../components/ui'
import * as remote from '../data/remote'
import { makeCourseAdminDemoSchedule } from '../data/seed'
import { useStore, useToast } from '../data/store'
import { WEEKDAY_TEXT, type Klass, type ScheduleItem } from '../data/types'
import { beijingNow, ymdOf } from '../lib/holiday'
import { isAdminClass, splitByKind } from '../lib/pick'
import { checkScheduleConflicts } from '../lib/schedule'
import { isRemote } from '../lib/supabase'
import {
  PERIOD_SLOTS,
  matchClassName,
  parseScheduleText,
  type ParsedScheduleItem,
} from '../lib/scheduleParse'
import { slotTextOf } from '../lib/stream'

/**
 * 「课程管理」—— **行政管理页（`/manage`）里的第四张卡展开出来的那一段**。
 *
 * 设计照 `Desktop\课程管理预览\预览-v3.html`（**已经跟用户确认过的那一版**）。
 *   第 2 轮（骨架）：层级（**年级 → 班级 → 该班课表**）· 课表两种态（录入 / 核对）· 三态标记 · 降级；
 *   第 3 轮（本轮）：**调课（临时 / 永久）· 两类换法 · 三类冲突 · 不冲突建议 · 确认弹层**。
 *   ⛔ 仍不做（第 4 轮）：教室端**读取**这一天改了没有 · 通知老师（服务端）。
 *
 * 🔴 **三条口径**（本轮的核心判断，别在别处再写一遍）：
 *
 *  ① **两种调课落在两张不同的表上**（`schema.sql` §38 的原文）：
 *     · **临时**（"只影响这一天"，过了自动恢复）→ `schedule_temp_changes`，
 *       它**不动** `schedule_items`；读的时候压在那一天上面（`schedule_day_cells(p_date)`）。
 *     · **永久**（"以后每周都变"）→ 改 `schedule_items` 那一行本身 + 留档
 *       （`apply_perm_schedule_change()`，同一笔事务）。
 *     ⚠️ 两者**不许互相顶替**：把永久写成临时 = 下周悄悄变回去；把临时写成永久 = 改坏周课表。
 *     所以界面上它们**分得明显**（琥珀 / 强调色 · 两张并排的影响范围卡 · 永久要多勾一句才点得动）。
 *
 *  ② **冲突的权威判定在数据库**（`schedule_conflicts_on(p_date)` —— 三类**只有那一份**算法）。
 *     前端**不另写一套判据**：这里只把服务端回的行翻成"① 老师 / ② 同一个班 / ③ 走班学生"三段。
 *     ⚠️ **不硬拦**：设计上允许"改完还剩 N 处没处理"继续确认（§38 的口径，确认弹层原话就是它）。
 *     ⚠️ 走班班**没有名单**时第③类**查不了 → 必须是灰**（"没结论"不是"没冲突"，§三.4 三态）。
 *
 *  ③ **权限判据一律以数据库为准**：这一页**一个角色字面量都没有**，只读服务端回的
 *     `canManageSchedule()` 那一位布尔（藏入口不是安全边界 —— 闸门是 RLS 与 §38.1.1 的触发器）。
 *
 * 🔴 **本地演示模式（`isRemote === false`）**：没有数据库可问，`schedule_day_cells` /
 *    `schedule_conflicts_on` 都够不着。这时"这一天实际上什么课"由**内存里那一层**
 *    （`store.tempScheduleChanges` + 周课表）算出来 ——
 *    这是**同一条口径的第二份实现**，只在本地演示模式下生效，页面会**明说**它是哪一种。
 *    远程模式下这一支一个字节都不会跑到（`loadScheduleDay()` 回 `'present'`）。
 */

/**
 * 🔴 **"挂在班上就算这个班的课"这一支开不开** —— **只有本地演示模式开**。
 *
 * 理由（2026-10-12 实测 S27 ⑫：`2026-09-14` 摆出 0 格）：
 *   演示夹具 = `seed.ts` 造的那一份**教师个人排课表**（`scope` 空着 → 按 `'mine'` 读），
 *   而这一页只要 `scope='class'` → 一个班一行都没有。同一份数据 `/schedule` 上摆得出来、
 *   这里摆不出来，两份界面自相矛盾。
 * ⚠️ **不许为此放宽 `scope='class'` 这条语义**：教室端（`Classroom.tsx:465`）读的就是它，
 *   放宽 = 把"不是班级课表的行"也送到教室大屏上。所以退回**只准发生在演示模式**，
 *   真实模式（`isRemote`）下这里恒为 `false`，仍然只认 `scope='class'`。
 */
const DEMO_FALLBACK = !isRemote

/** 一个年级条（`grades` 读不到时退回"按班上的年级名分组"） */
type GradeGroup = { key: string; name: string; cohort: string }

/** 课表里一条的落点：**三态，不许混**（与 `Classroom.tsx` 的 `classMark` 同一套判据） */
type Mark = 'ok' | 'red' | 'unknown'

/** 两种调课 —— **不是两种写法，是两条路** */
type TweakMode = 'temp' | 'perm'
/** 两种换法 —— "同一门课换人" vs "整个格子换掉" */
type SwapKind = 'whole' | 'teacher'

/** 一格（某班 · 某一天 · 某一节的第几节）：界面与建议算法都在这个形状上工作 */
type DayCell = {
  period: number
  start: string
  end: string
  subject: string
  teacherId: string | null
  /** 这一格被**临时调课**盖过（这一天和别天不一样） */
  changed: boolean
}

/**
 * 网格上的一格：**一天 9 节全摆出来**（照 `预览-v3.html`：周末那一列的空格子也画着）。
 *
 * 🔴 `cell === null` = **空格子**（这一节这个班没有课）。它能被点、能被选
 *    （"挪到空位"那条建议要一键选两格），但它**不是课**：
 *    · 不进 `cells`（于是不进冲突计算、不进"两格换"的科目/老师比对）；
 *    · 身上挂的是 `data-course-empty`，**不是** `data-course-cell` ——
 *      后者在门禁里是"这一格有课"的意思（`shots.mjs` S27 ⑫/⑬ 按它数格子），
 *      空格子挂上去会把"这一天有几格课"这个读数带偏。
 */
type DaySlot = {
  period: number
  start: string
  end: string
  cell: DayCell | null
}

/**
 * 整周网格里的一节（**某一格 · 某一个时段的一件事**）。
 * ⚠️ 与 `DayCell` 不是一回事：`DayCell` 是"这一天第几节"，这里的重点是**那个时段本身**
 *    （整周网格的行由时段并出来，行号不表示第几节）。
 */
type WeekLesson = {
  start: string
  end: string
  subject: string
  teacherId: string | null
  /** 这一节被**临时调课**盖过（只有"这一天"那一列可能为真） */
  changed: boolean
}

/** 一天几节 —— 就是标准节次表的长度（9）；空格子的钟点也从这张表取 */
const DAY_PERIODS = PERIOD_SLOTS.length

/** 第 N 节的标准钟点（空格子没有自己的钟点：周课表里根本没有这一行） */
function periodTime(p: number): { start: string; end: string } {
  const s = PERIOD_SLOTS[p - 1] ?? PERIOD_SLOTS[PERIOD_SLOTS.length - 1]
  return { start: s[0], end: s[1] }
}

/** 三类冲突（**别糊成一句"有冲突"**）：`kind` 就是数据库给的名字 */
type ConflictKind = 'teacher' | 'class' | 'student'
type ConflictRow = {
  key: string
  kind: ConflictKind
  period: number
  start: string
  classId: string
  /** 冲突的**另一半**在哪个班（数据库的 `other_class_id`）；`null` = 两半都在这个班 */
  otherClassId: string | null
  teacherId: string | null
  studentId: string | null
  detail: string
}

/** 建议：**真的给方案**，不是列一堆空位让人自己拼 */
type Suggestion = {
  key: string
  /** `'move'` = 挪到别的时间 · `'swap'` = 跟别的时段整格对调 */
  how: 'move' | 'swap'
  /** 这一节现在在第几节 */
  at: number
  /** 挪/对调到第几节 */
  period: number
  /** 「挪」时说清搬的是什么（对调不用） */
  title: string
  /** 「挪」时那一位老师（对调不用） */
  teacherId: string | null
  why: string
}

/** 一格在"换完之后"是什么形状（预览与落地共用同一处推导） */
type SwapPlan = {
  kind: SwapKind
  /** 被换的那一格（用户先点的那一格） */
  a: number
  /** 另一格 */
  b: number
  /** a 的"现在 → 换完" */
  aBefore: { subject: string; teacherId: string | null }
  aAfter: { subject: string; teacherId: string }
  bBefore: { subject: string; teacherId: string | null }
  bAfter: { subject: string; teacherId: string } | null
}

const MARK_TEXT: Record<Mark, string> = {
  ok: '教室里会显示',
  red: '教室里不会显示',
  unknown: '班级列表没读到，判不了',
}

const CONFLICT_HEAD: Record<ConflictKind, string> = {
  teacher: '① 同一老师、同一时段两个班',
  class: '② 同一个班、同一时段两节课',
  student: '③ 走班学生、同一时段在别的班也有课',
}

/**
 * 这一条教室端会不会显示。
 *
 * 🔴 判据**只有一处**：`lib/scheduleParse.ts` 的 `matchClassName()` ——
 *    在页面里另写一遍 `title.includes(名)` 迟早在括号 / 空格上分叉，
 *    于是这里说"认得出"、教室里一条都不显示（用户 2026-09-28 实测栽过这个坑）。
 * ⚠️ `classes` 空 = **班级列表根本没读回来** → `unknown`（灰），**绝不能红**：
 *    红只说"确实对不上"，"我没读到"是"没结论"（§三.4 三态 / I 系列不变量）。
 */
function markOf(title: string, klass: Klass, classes: Klass[]): Mark {
  if (!classes.length) return 'unknown'
  if (!title.trim()) return 'unknown'
  return matchClassName(title, classes) === klass.name ? 'ok' : 'red'
}

/** 一条「教室端会不会显示」的标记 —— 三态各自一个 `data-course-mark`（门禁的锚点） */
function MarkLine({ mark, klass }: { mark: Mark; klass: Klass }) {
  if (mark === 'ok') {
    return (
      <div data-course-mark="ok" style={{ fontSize: 11, color: 'var(--color-okink)', marginTop: 3 }}>
        ✓ {MARK_TEXT.ok}
      </div>
    )
  }
  if (mark === 'red') {
    return (
      <div
        data-course-mark="red"
        style={{ fontSize: 11, color: 'var(--color-bad)', marginTop: 3, lineHeight: 1.6 }}
      >
        ⚠ {MARK_TEXT.red} —— 标题里写上班名「{klass.name}」
      </div>
    )
  }
  return (
    <div data-course-mark="unknown" style={{ fontSize: 11, color: 'var(--color-ink3)', marginTop: 3 }}>
      {MARK_TEXT.unknown}
    </div>
  )
}

/* ============================================================
   本地演示模式那一支：**这一天实际上什么课** + 三类冲突
   ------------------------------------------------------------
   ⚠️ 只在 `isRemote === false` 时跑到（远程模式读 `schedule_day_cells` / `schedule_conflicts_on`）。
      两份实现读的是**同一份语义**（"临时调课压在那一天上面"），不是两套判据。
   ⚠️ 老师名册：本地演示模式的课表只有科目（`title` 里带班名，没有老师）。
      所以这里按科目造一份**演示用的**任课表，让"老师撞课 / 同一门课换人"画得出来。
      远程模式下老师一律来自数据库（`schedule_day_cells.teacher_id`），这份表根本用不到。
   ============================================================ */

/** 演示用的任课老师（只在 `isDemo` 时用来把界面画出来） */
const DEMO_TEACHERS: Record<string, { id: string; name: string }[]> = {
  物理: [
    { id: 'demo-t-wang', name: '王琳鑫' },
    { id: 'demo-t-zhou', name: '周庆' },
  ],
  语文: [
    { id: 'demo-t-zhu', name: '朱文熙' },
    { id: 'demo-t-tang', name: '唐以利' },
  ],
  数学: [
    { id: 'demo-t-xie', name: '谢伦菊' },
    { id: 'demo-t-luo', name: '罗建' },
  ],
  化学: [{ id: 'demo-t-chen', name: '陈立' }],
}

/** demo 老师 id → 名字（页面上要把 id 翻成人话） */
const DEMO_TEACHER_NAMES = new Map<string, string>(
  Object.values(DEMO_TEACHERS).flatMap((list) => list.map((t) => [t.id, t.name] as const)),
)

/** 从标题里认科目："高二(3)班 物理" → "物理" */
function subjectOfTitle(title: string, klassName: string): string {
  const t = title.replace(klassName, '').trim()
  return t || title.trim()
}

/**
 * 这一天**这个班**的格子（周课表 + 内存里的临时层）。
 *
 * 🔴 `demoFallback`：**只在本地演示模式**允许"挂在班上就算这个班的课"这一支 ——
 *    演示夹具（`seed.ts` 的 `makeDemoSchedule`）是**教师个人排课表**那一份（`scope` 空着 = `'mine'`），
 *    它里面没有 `scope='class'` 的行 → 不退回的话这一页摆出 0 格、整节调课点不动。
 *    ⚠️ **真实模式（`isRemote`）下 `demoFallback = false`，只看 `scope='class'`** ——
 *    教室端读的正是 `scope='class'`（`Classroom.tsx:465`）；把它放宽 = 让"不是班级课表的行"
 *    也显示到教室大屏上，那是把平台两套课表的边界模糊掉。
 */
function buildDayCells(
  klass: Klass,
  date: string,
  weekday: number,
  schedule: readonly ScheduleItem[],
  temp: readonly { date: string; classId: string; period?: number; start: string; end: string; toSubject: string; toTeacherId: string; kind: string }[],
  demoFallback = false,
): DayCell[] {
  const base = schedule
    .filter(
      (s) =>
        (s.scope === 'class' || demoFallback) && s.classId === klass.id && s.weekday === weekday,
    )
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))
  const days = temp.filter((t) => t.date === date && t.classId === klass.id)
  const out: DayCell[] = []
  base.forEach((s, i) => {
    const over = days.find((t) => t.start === s.start)
    /*
     * 🔴 这一节被**挪走了**（临时层把科目写成了空）→ **这一格就是空的**：
     *    不进格子清单 = 空格子（虚线框 + 「空」），于是也不会进冲突计算
     *    （"没课的那一格本来就没有课可撞" —— 与 `预览-v3.html:1351` 同一条口径）。
     */
    if (over && !over.toSubject) return
    /* 演示用的任课老师：同一科在同一个班上固定是第一位（这样"同一门课换人"才有得换） */
    const roster = DEMO_TEACHERS[subjectOfTitle(s.title, klass.name)] ?? []
    const fixed = roster.length ? roster[i % Math.min(roster.length, 2)] : null
    out.push({
      period: 0,
      start: s.start,
      end: s.end,
      subject: over ? over.toSubject : subjectOfTitle(s.title, klass.name),
      /*
       * 🔴 **行自己带了老师就用它**（`seed.ts:makeCourseAdminDemoSchedule` 那一批每个格子都带）——
       *    老师**不是**由"这是这一天的第几格"推出来的：按序号摊名册只是**没有老师时**的兜底。
       *    一个老师同时段在两个班有课这种冲突，只有让"老师"来自数据才构造得出来
       *    （与远程模式同一口径：那边老师来自 `schedule_day_cells.teacher_id`）。
       */
      teacherId: over ? over.toTeacherId : (s.teacherId ?? fixed?.id ?? null),
      changed: Boolean(over),
    })
  })
  /*
   * 🔴 临时层里"**挪到本来没课的那一节**"的记录：周课表里**没有对应的行**
   *    （`start` 在这个班查不到），格子得由这条记录自己摆出来 ——
   *    否则"挪到第 6 节"只在预览里成立，落地之后那一格还是空的（不报错但就是不对）。
   */
  for (const t of days) {
    if (!t.toSubject) continue
    if (base.some((s) => s.start === t.start)) continue
    out.push({
      period: 0,
      start: t.start,
      end: t.end,
      subject: t.toSubject,
      teacherId: t.toTeacherId || null,
      changed: true,
    })
  }
  /* 节次 = 按开始时间排出来的**序号**（这一页原来就是这个口径；下面 `slots` 按它摆 9 格） */
  out.sort((a, b) => a.start.localeCompare(b.start))
  out.forEach((c, i) => {
    c.period = i + 1
  })
  return out
}

export default function CourseAdmin() {
  const grades = useStore((s) => s.grades)
  const classes = useStore((s) => s.classes)
  const schedule = useStore((s) => s.schedule)
  const tempChanges = useStore((s) => s.tempScheduleChanges)
  const addTempScheduleChange = useStore((s) => s.addTempScheduleChange)
  const updateSchedule = useStore((s) => s.updateSchedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const push = useToast((s) => s.push)

  /** 展开着的那一个年级（`null` = 都收起） */
  const [openGrade, setOpenGrade] = useState<string | null>(null)
  /** 选中的那个班（点班级行才出现右边那块课表） */
  const [classId, setClassId] = useState<string | null>(null)
  /** 服务端回的"能不能改这个班的课表"（**带班 id**：换班时不把上一个班的结论当成这个班的） */
  const [capFor, setCapFor] = useState<{ id: string; state: remote.CanManageScheduleState } | null>(
    null,
  )
  /** 录入模式：粘贴框里的原文 */
  const [paste, setPaste] = useState('')
  /** 录入模式：解析出来、等着核对的那一批（`null` = 还没解析） */
  const [parsed, setParsed] = useState<ParsedScheduleItem[] | null>(null)
  /** 核对模式：「我核对过了」 */
  const [reviewed, setReviewed] = useState(false)
  /**
   * 班级课表看哪一档：`'day'` = 这一天（**默认** —— 核对流程走它）· `'week'` = 整周网格。
   * ⚠️ 只影响这一块面板；下面的调课区不跟着变。
   */
  const [courseView, setCourseView] = useState<'day' | 'week'>('day')
  /** 一句话结果 / 拦下来的原因（**不许静默**） */
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  /* ---------------- 第 3 轮：调课与冲突 ---------------- */

  /** 调课的**日期**（临时调课只看这一天；默认"今天" —— 用 `beijingNow()` 算，不碰设备时区） */
  const [date, setDate] = useState<string>(() => ymdOf(beijingNow()))
  /** **这一笔改动管多久** —— 临时 / 永久（两套界面、两条写入路） */
  const [tweak, setTweak] = useState<TweakMode>('temp')
  /** **怎么换** —— 整格换 / 只换老师 */
  const [swapKind, setSwapKind] = useState<SwapKind>('whole')
  /** 点了的那两格（0 / 1 / 2 个；第 3 次点会重开一对） */
  const [picked, setPicked] = useState<number[]>([])
  /** 永久调课："我知道以后每周都会变"那**多勾的一句**（不勾就点不动确认） */
  const [permAck, setPermAck] = useState(false)
  /** 确认弹层开着没 */
  const [confirmOpen, setConfirmOpen] = useState(false)
  /** 服务端读回来的"这一天实际上什么课" */
  const [dayRead, setDayRead] = useState<remote.ScheduleDayRead | null>(null)
  /** 服务端读回来的三类冲突 */
  const [confRead, setConfRead] = useState<remote.ScheduleConflictRead | null>(null)
  /** 读完之后要重读一次（写成功之后自增） */
  const [tick, setTick] = useState(0)
  /** 点开来看建议的那一条冲突 */
  const [openConflict, setOpenConflict] = useState<string | null>(null)
  /**
   * 「只换老师」时，这一格换成谁（第几节 → 老师 id）。
   * ⚠️ 它是**这一个班**的一次选择，换班时清掉（`pickClass` 里）。
   */
  const [teacherPick, setTeacherPick] = useState<Record<number, string>>({})

  const klass = useMemo(() => classes.find((k) => k.id === classId) ?? null, [classes, classId])
  const weekday = useMemo(() => {
    const [y, m, d] = date.split('-').map(Number)
    const w = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
    return w === 0 ? 7 : w
  }, [date])

  /*
   * 年级清单：以 `grades` 表为准，**读不到时退回"按班上的年级名分组"** ——
   * 与 `Grades.tsx:71` 的 `loadArchive` 同一条既有写法（远程以库里为准，本地用 store 那一份）。
   * ⚠️ 退回那一支不是"另一个判据"：两处读的都是数据库（RLS）给的那一份。
   */
  const groups = useMemo<GradeGroup[]>(() => {
    if (grades.length) return grades.map((g) => ({ key: g.id, name: g.name, cohort: g.cohort ?? '' }))
    const names = [...new Set(classes.map((k) => k.grade).filter(Boolean))]
    return names.map((n) => ({ key: n, name: n, cohort: '' }))
  }, [grades, classes])

  /**
   * 🔴 **课程管理专用的班级课表演示夹具**（`seed.ts:makeCourseAdminDemoSchedule`）。
   *
   * 为什么要有它（2026-10-12 实测 S27 ㉛㉜㉝㉞㊲）：`store.schedule` 那一批是**教师个人排课表**
   * （`scope` 空着 = `'mine'`），里面"同一个老师同一时段两个班 / 同一个班同一时段两节"
   * **天然构造不出来** → 冲突区永远是"没有。"，那五条断言就永远红。
   *
   * ⚠️ **它只在这一页、只在本地演示模式**（`DEMO_FALLBACK`）：
   *    · **不进 store**、也不改 `makeDemoSchedule` —— `/schedule` 与教室端（读 `scope='class'`）看不到它，
   *      所以不需要"跑完再清干净"；
   *    · 真实模式（`isRemote`）下这一支一个字节都跑不到。
   */
  const demoRows = useMemo<ScheduleItem[]>(
    () => (DEMO_FALLBACK ? makeCourseAdminDemoSchedule(classes) : []),
    [classes],
  )
  /** 这一页真正读的那份课表 = 库/内存里那一份 + 演示夹具（见上） */
  const scheduleAll = useMemo<ScheduleItem[]>(
    () => (demoRows.length ? [...schedule, ...demoRows] : schedule),
    [schedule, demoRows],
  )

  /**
   * 这个班**教室端那一份**课表。
   * 🔴 首选 `scope='class'` 那一批（教室端那块屏读的正是它 —— §17 把教室端的写收窄到 `scope='class'`）。
   * ⚠️ **退回那一支**：本地演示模式的夹具挂在班上、但 `scope` 空着（全平台按 `'mine'` 读），
   *    所以"这个班一行都没有"时退回"挂在它名下的那些行" —— 否则这一页会说"两个班都没录过课表"，
   *    而 `/schedule` 上明明摆着同一批课（两份界面自相矛盾）。
   *    退回时**只是读了同一批行的另一个标签**，判据仍然只有"这一行挂不挂在这个班上"。
   */
  const classRows = (cid: string): ScheduleItem[] => {
    const all = scheduleAll.filter((s) => s.classId === cid)
    const cls = all.filter((s) => s.scope === 'class')
    /* ⚠️ 退回那一支**只在演示模式**（见 `DEMO_FALLBACK`）：真实模式只认 `scope='class'` */
    const hit = cls.length || !DEMO_FALLBACK ? cls : all
    return hit
      .slice()
      .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
  }

  const rows = useMemo<ScheduleItem[]>(
    () => (classId ? classRows(classId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scheduleAll, classId],
  )

  /** 点一个班：选上它，并把**上一个班**留下的结论全清掉（`null` = 放下 = 什么都不选） */
  const pickClass = (id: string | null) => {
    setClassId(id)
    setPaste('')
    setParsed(null)
    setReviewed(false)
    setNote('')
    setPicked([])
    setOpenConflict(null)
    setTeacherPick({})
  }

  /**
   * 点一个班那一行的行为（用户 2026-10-12 实测指出的第①个 bug：
   * 「**选中班级后不能取消选中**」）：
   *   · 点**别的**班 → 选中它；
   *   · 点**已经选中的**那个班 → **放下**（回到"什么都没选"），而不是再选一次。
   * 🔴 判据是 `classId === id`（不是"点了同一行"这么个模糊说法）——
   *    所以它**可反向对照**：把这一个三元的 `:null` 去掉，点已选中的班就又变回"选中"。
   */
  const toggleClass = (id: string) => pickClass(classId === id ? null : id)

  /**
   * 展/收一个年级（用户实测指出的第②个 bug：
   * 「**点击到其他年级时，当前选中状态不会取消**」）。
   *
   * 🔴 为什么必须清：**那个班已经不在视图里了** —— 留着一个"看不见的选中"，
   *    右边的课表会继续显示**别的年级的**班（看着像"点了新年级没反应"）。
   * 🔴 所以：只要点的是**另一个年级**（或者收起当前年级），选中一律清掉；
   *    点**同一个**年级只是收起/展开、顺手把选中放掉（"收回这一层"的自然语义）。
   */
  const toggleGrade = (key: string) => {
    setOpenGrade(openGrade === key ? null : key)
    if (classId) pickClass(null)
  }

  /** 问服务端"我能不能改这个班的课表"（结论**带班 id**：换班时它自动变回"正在读"） */
  useEffect(() => {
    if (!classId) return
    let alive = true
    void remote.canManageSchedule(classId).then((r) => {
      if (alive) setCapFor({ id: classId, state: r })
    })
    return () => {
      alive = false
    }
  }, [classId])

  const cap = capFor && capFor.id === classId ? capFor.state : null

  /**
   * 这一天实际上什么课 + 三类冲突 —— **读一次，两处用**。
   * 🔴 权威在数据库（§38.6 / 38.6.1）；本地演示模式回 `'local'`，页面转用内存那一层。
   */
  useEffect(() => {
    if (!classId) return
    let alive = true
    void (async () => {
      const [d, c] = await Promise.all([
        remote.loadScheduleDay(date),
        remote.loadScheduleConflicts(date),
      ])
      if (!alive) return
      setDayRead(d)
      setConfRead(c)
    })()
    return () => {
      alive = false
    }
  }, [classId, date, tick])

  /** 每个班有几条课表 —— 与 `rows` **同一处口径**（年级副标题与班级行的"x 节 / 未录"都读它） */
  const countByClass = useMemo(() => {
    const m = new Map<string, number>()
    const explicit = new Set<string>()
    for (const s of scheduleAll) {
      if (!s.classId || s.scope !== 'class') continue
      explicit.add(s.classId)
      m.set(s.classId, (m.get(s.classId) ?? 0) + 1)
    }
    /* 退回那一支（本地演示模式的夹具 `scope` 空着）：**逐个班**判，不是"一个都没有才退回"；
       ⚠️ **只在演示模式** —— 真实模式只认 `scope='class'`（与 `buildDayCells` / `classRows` 同一处口径） */
    if (DEMO_FALLBACK) {
      for (const s of scheduleAll) {
        if (!s.classId || explicit.has(s.classId)) continue
        m.set(s.classId, (m.get(s.classId) ?? 0) + 1)
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleAll, classId])

  /** 这个年级的班（行政班 / 走班班分开 —— 与 `/classes` 同一处 `splitByKind`） */
  const byGrade = useMemo(() => {
    const out = new Map<string, { admin: Klass[]; stream: Klass[] }>()
    for (const g of groups) {
      const mine = classes.filter((k) => k.grade === g.name)
      out.set(g.key, splitByKind(mine))
    }
    return out
  }, [groups, classes])

  const withGrid = (g: GradeGroup): number =>
    classes.filter((k) => k.grade === g.name && (countByClass.get(k.id) ?? 0) > 0).length

  /**
   * 这一天的格子（内存那一条口径：周课表 + 内存里的临时层）。
   * ⚠️ 它不只是"本地演示模式那一支"：**数据库没给出这一天的格子时**（§38 没跑 / 没读到）
   *    也走它 —— 否则页面会「选得中班、却一格课都摆不出来」（2026-10-12 实测到的）。
   *    冲突那一段**不会**跟着变成"没有冲突"：它显式说"这一档没结论"（三态纪律）。
   */
  const localCells = useMemo<DayCell[]>(() => {
    if (!klass || dayRead?.status === 'present') return []
    /* ⚠️ 传进去的是**这个班那几行**（`classRows` 已经按"这个班 + `scope='class'` 优先"挑过），
       不是整份 `scheduleAll` —— 否则演示夹具那批显式行会与退回那一支的行**各算一遍**（同格两遍）。 */
    return buildDayCells(klass, date, weekday, classRows(klass.id), tempChanges, DEMO_FALLBACK)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klass, dayRead, date, weekday, scheduleAll, tempChanges])

  /**
   * 本地演示模式那一支的**三类冲突**（远程模式一律用数据库回的那一份）。
   * 🔴 三类**分开算、分开摆**（`kind` 就是三类的名字）；⚠️ 走班班没名单 → 第③类**查不了**（灰）。
   */
  const localConflicts = useMemo<ConflictRow[]>(() => {
    /* ⚠️ 这一支**只在本地演示模式**跑：三类冲突的权威算法在数据库（§38.6.1）。
       数据库没答上来时，冲突那一段显式说"没结论"（灰），**不拿前端那一份冒充权威**。 */
    if (dayRead?.status !== 'local') return []
    const out: ConflictRow[] = []
    const all = allCellsOf()
    /* ① 同一老师同一时段两个班 */
    const byTeacher = new Map<string, { classId: string; cell: DayCell }[]>()
    for (const [cid, list] of all) {
      for (const c of list) {
        if (!c.teacherId) continue
        const key = `${c.start}|${c.teacherId}`
        const arr = byTeacher.get(key) ?? []
        arr.push({ classId: cid, cell: c })
        byTeacher.set(key, arr)
      }
    }
    for (const [key, arr] of byTeacher) {
      const ids = [...new Set(arr.map((x) => x.classId))]
      if (ids.length < 2) continue
      const [start, tid] = key.split('|')
      out.push({
        key: `teacher|${start}|${tid}`,
        kind: 'teacher',
        period: arr[0].cell.period,
        start,
        classId: ids[0],
        otherClassId: ids[1],
        teacherId: tid,
        studentId: null,
        detail: `这位老师同一时段在 ${ids.length} 个班有课`,
      })
    }
    /* ② 同一个班同一时段两节课 */
    for (const [cid, list] of all) {
      const byStart = new Map<string, number>()
      for (const c of list) byStart.set(c.start, (byStart.get(c.start) ?? 0) + 1)
      for (const [start, n] of byStart) {
        if (n < 2) continue
        const c = list.find((x) => x.start === start)
        out.push({
          key: `class|${start}|${cid}`,
          kind: 'class',
          period: c?.period ?? 0,
          start,
          classId: cid,
          otherClassId: null,
          teacherId: c?.teacherId ?? null,
          studentId: null,
          detail: `这个班同一时段有 ${n} 节课`,
        })
      }
    }
    /* ③ 走班学生：**名单读不到就不算**（灰，不是"没冲突"） */
    for (const [cid, list] of all) {
      const sk = classes.find((k) => k.id === cid)
      if (!sk || isAdminClass(sk)) continue
      const members = sk.students.map((s) => s.id)
      if (!members.length) continue
      for (const c of list) {
        for (const [oid, olist] of all) {
          if (oid === cid) continue
          const ok = classes.find((k) => k.id === oid)
          if (!ok || !isAdminClass(ok)) continue
          const hit = olist.find((x) => x.start === c.start)
          if (!hit) continue
          const who = members.filter((m) => ok.students.some((s) => s.id === m))
          if (!who.length) continue
          out.push({
            key: `student|${c.start}|${cid}|${oid}`,
            kind: 'student',
            period: c.period,
            start: c.start,
            classId: cid,
            otherClassId: oid,
            teacherId: null,
            studentId: who[0],
            detail: `这个学生同一时段在 ${2} 个班有课`,
          })
        }
      }
    }
    return out
    /*
     * ⚠️ 依赖里那几项**都是要给 `allCellsOf()` 读的**（本地那一支现算格子用得上），
     *    而这个 lint 规则只看得见"函数体里直接引用的名字" —— 所以逐条留着并显式豁免。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayRead, classes, date, weekday, scheduleAll, tempChanges])

  /** 读的状态：`present` = 数据库答的 · `local` = 本地演示那一支 · 其余 = **没结论（灰）** */
  const readState: 'present' | 'local' | 'unknown' | 'missing' | 'pending' = !classId
    ? 'pending'
    : !dayRead
      ? 'pending'
      : dayRead.status === 'present'
        ? 'present'
        : dayRead.status === 'local'
          ? 'local'
          : dayRead.status

  /** 这个班这一天的格子（远程用数据库的，本地用内存的） */
  const cells = useMemo<DayCell[]>(() => {
    if (!klass) return []
    if (dayRead?.status === 'present') return allCellsOf().get(klass.id) ?? []
    /* 其余三态（local / missing / unknown）一律退回本地那一层：有课就摆得出来 */
    return localCells
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klass, dayRead, localCells, classes, date, weekday, scheduleAll, tempChanges])
  /**
   * 调课网格：**一天 9 节全摆出来** —— 有课的那几格 + 没课的空格子。
   * 空格子的钟点取标准节次表（`PERIOD_SLOTS`）：周课表里没有这一行，问不到别的来源。
   * ⚠️ 它只是"怎么摆"，**不是第二份判据**：`cells` 仍然是"这一天的课"的唯一来源。
   */
  const slots = useMemo<DaySlot[]>(() => {
    const n = Math.max(DAY_PERIODS, ...cells.map((c) => c.period))
    return Array.from({ length: n }, (_, i) => {
      const period = i + 1
      const cell = cells.find((c) => c.period === period) ?? null
      const t = cell ?? periodTime(period)
      return { period, start: t.start, end: t.end, cell }
    })
  }, [cells])

  /** 冲突（远程用数据库的，本地用内存的）—— **每条都留下 `otherClassId`**（另一半在哪个班） */
  const conflicts = useMemo<ConflictRow[]>(() => {
    if (!klass) return []
    const mine = (c: { classId: string | null; otherClassId: string | null }) =>
      c.classId === klass.id || c.otherClassId === klass.id
    if (confRead?.status === 'present') {
      return confRead.conflicts
        .filter((c) => c.classId === klass.id || c.otherClassId === klass.id)
        .map((c, i) => {
          const cell = cells.find((x) => x.start === c.start)
          return {
            key: `${c.kind}|${c.start}|${i}`,
            kind: c.kind,
            period: cell?.period ?? 0,
            start: c.start,
            classId: c.classId ?? klass.id,
            otherClassId:
              c.otherClassId && c.otherClassId !== c.classId ? c.otherClassId : null,
            teacherId: c.teacherId,
            studentId: c.studentId,
            detail: c.detail,
          }
        })
    }
    if (confRead?.status === 'local') return localConflicts.filter(mine)
    return []
  }, [klass, confRead, cells, localConflicts])

  /** 三类分开摆（**别糊成一句"有冲突"**） */
  const byKind = useMemo(() => {
    const out: Record<ConflictKind, ConflictRow[]> = { teacher: [], class: [], student: [] }
    for (const c of conflicts) out[c.kind].push(c)
    return out
  }, [conflicts])

  /**
   * 整周网格的列数据：第 `wd` 天这个班的课（**按 `start` 升序**）。
   * ⚠️ 只有**不是这一天**的那几列用它 —— `wd === weekday` 那一列用 `slots`（见下）。
   */
  const weekCols = useMemo<ScheduleItem[][]>(() => {
    const out: ScheduleItem[][] = []
    for (let wd = 1; wd <= 7; wd++) {
      out.push(rows.filter((r) => r.weekday === wd).sort((a, b) => a.start.localeCompare(b.start)))
    }
    return out
  }, [rows])

  /**
   * 整周网格的列内容：第 `wd` 天这一列有哪几节。
   * 🔴 「这一天」那一列用 `slots` —— 它叠过**临时调课**那一层（`changed` 就从这儿来）；
   *    别的列用 `weekCols`（周课表本体）。
   */
  const weekLessons = useMemo<WeekLesson[][]>(() => {
    const out: WeekLesson[][] = []
    for (let wd = 1; wd <= 7; wd++) {
      out.push(
        wd === weekday
          ? slots.flatMap((s) => {
              const c = s.cell
              return c
                ? [
                    {
                      start: c.start,
                      end: c.end,
                      subject: c.subject,
                      teacherId: c.teacherId,
                      changed: c.changed,
                    },
                  ]
                : []
            })
          : weekCols[wd - 1].map((r) => ({
              start: r.start,
              end: r.end,
              subject: klass ? subjectOfTitle(r.title, klass.name) : r.title,
              teacherId: r.teacherId ?? null,
              changed: false,
            })),
      )
    }
    return out
  }, [weekday, slots, weekCols, klass])

  /**
   * 整周网格的行 = **这一周这个班真的出现过的时段**（7 列所有 `start` 并起来、升序去重）。
   * 🔴 行**不是**固定 9 节：周课表的钟点并不都在标准节次表上（演示那一批只有第 1 节碰得上），
   *    按"第 N 节"硬摆会**写出错的钟点** —— 所以行标签一律由 `slotTextOf` 出
   *    （它认得出标准节次时才补「（第 N 节）」）。
   */
  const weekRowStarts = useMemo<Array<{ start: string; end: string }>>(() => {
    const ends = new Map<string, string>()
    for (const list of weekLessons) {
      for (const l of list) if (!ends.has(l.start)) ends.set(l.start, l.end)
    }
    return [...ends.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([start, end]) => ({ start, end }))
  }, [weekLessons])

  /** 这一天的撞课时刻（`conflicts` 本来只算这一天）；**读不到冲突时它是空的 → 一个角标都不挂** */
  const conflictStarts = new Set(conflicts.map((c) => c.start))

  /**
   * 走班班**这一档查不查得了**（第③类）—— **三态硬不变量**：
   *   · `'gray'`  走班班**没有名单** → 第③类查不了（**灰，不许当绿**）；
   *   · `'ok'`    有名单 → 照常查；
   *   · `'n/a'`   这个班不是走班班 → 与它无关。
   */
  const studentCheck: 'gray' | 'ok' | 'n/a' = useMemo(() => {
    if (!klass) return 'n/a'
    if (isAdminClass(klass)) return 'n/a'
    return klass.students.length ? 'ok' : 'gray'
  }, [klass])

  const hardN = byKind.teacher.length + byKind.class.length

  /**
   * 这一笔改动**管多久**的那一句话 —— **两种模式各自的"教室端会变成什么样"都要有**
   * （用户最关心这一句）。抽成纯函数是为了它**只有一处口径**：
   * 调课区那两张卡、对调预览、确认弹层三处说的是同一句话。
   */
  const classroomEffect = (m: Pick<SwapPlan, 'a' | 'b'> | null): string => {
    if (tweak === 'perm') {
      return `教室端：${klass?.name ?? '这个班'} 以后每个${WEEKDAY_TEXT[weekday - 1]}都按新的显示，不会自己恢复。`
    }
    const p = m ? `第 ${m.a} 节${m.a === m.b ? '' : ` 与第 ${m.b} 节`}` : '这一天'
    return `教室端：${klass?.name ?? '这个班'} 只有 ${date}（${WEEKDAY_TEXT[weekday - 1]}）${p}按新的显示，第二天自动恢复。`
  }

  /**
   * 这一天**所有班**的格子 —— 两处要用：
   *   · 当前这个班的课表/调课区（取 `klass.id` 那一份）；
   *   · 建议算法（"这位老师那个时段在别的班有没有课"）。
   * 远程模式建在数据库给的 `schedule_day_cells` 上；本地演示模式建在内存那一层上。
   * ⚠️ 用 `function` 声明（不是 `const`）：它在下面 `cells` 那一段之前就被读了。
   */
  function allCellsOf(): Map<string, DayCell[]> {
    const m = new Map<string, DayCell[]>()
    if (dayRead?.status === 'present') {
      for (const k of classes) {
        const list = dayRead.cells
          .filter((c) => c.classId === k.id)
          .slice()
          .sort((a, b) => a.start.localeCompare(b.start))
        if (list.length) {
          m.set(
            k.id,
            list.map((c, i) => ({
              period: i + 1,
              start: c.start,
              end: c.end,
              subject: c.subject,
              teacherId: c.teacherId,
              changed: c.changed,
            })),
          )
        }
      }
    } else if (dayRead?.status === 'local') {
      for (const k of classes) {
        /* 同 `localCells`：一个班一份（`classRows` 已挑过），别让同一格算两遍 */
        const list = buildDayCells(k, date, weekday, classRows(k.id), tempChanges, DEMO_FALLBACK)
        if (list.length) m.set(k.id, list)
      }
    }
    return m
  }

  const teacherName = (id: string | null): string => {
    if (!id) return '没定老师'
    return DEMO_TEACHER_NAMES.get(id) ?? id
  }

  /**
   * 「只换老师」那几格能换成谁。
   * ⚠️ 走的是**这个班现有老师** + 演示任课表（本地演示模式没有老师名册可问）——
   *    远程模式下"谁教这一科"由 `schedule_day_cells` 给的 `teacher_id` 反推，
   *    所以这里**不另造一份判据**，只是把已经读回来的那些 id 列出来。
   *    ⚠️ 真正"这个人能不能教这一科"的闸门在数据库（`class_subjects` / §38 的触发器），
   *       前端摆出来的是一份**候选清单**，不是判据。
   */
  const teacherOptions = useMemo<Array<{ id: string; name: string }>>(() => {
    const out = new Map<string, string>()
    for (const c of cells) if (c.teacherId) out.set(c.teacherId, teacherName(c.teacherId))
    for (const list of Object.values(DEMO_TEACHERS)) {
      for (const t of list) if (!out.has(t.id)) out.set(t.id, t.name)
    }
    return [...out.entries()].map(([id, name]) => ({ id, name }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells])

  /**
   * 选了两格之后**换完是什么样**。
   * · **整格换**：两格的（科目 + 老师）**一起换**；
   * · **只换老师**：科目**不动**，只把老师换过去。
   * ⚠️ 一格空着（那一节本来没课）时：整格换 = 把这一节挪过去、空位空着（照 v3 预览的口径）。
   * 🔴 **空格子不算课**：
   *    · 两格都空 → 没有可换的课（不画预览，下面给一句话）；
   *    · 「只换老师」→ **必须两格都有课**（换的是"这两节课的老师"），有一格空着就不成立。
   */
  const plan = useMemo<SwapPlan | null>(() => {
    if (picked.length !== 2) return null
    const [a, b] = picked
    const sa = slots.find((s) => s.period === a)
    const sb = slots.find((s) => s.period === b)
    if (!sa || !sb) return null
    const ca = sa.cell
    const cb = sb.cell
    if (!ca && !cb) return null
    /* 换谁：默认这一格现在那位老师；用户可以在下面那个下拉里改成别人 */
    const targetA = teacherPick[a] ?? null
    const targetB = teacherPick[b] ?? null
    if (swapKind === 'teacher') {
      if (!ca || !cb) return null
      /*
       * 🔴 **不勾谁是"没得预览"的意思，别拿它当闸门**（2026-10-12 实测：⑬ 红、整节断在这里）：
       *    那个"换成谁"的下拉**就长在这块预览里面**（`data-course-teacherpick` 在 `plan` 块内）——
       *    预览先要求"挑过人"才画，等于把下拉锁在自己身后：选了两格什么都不出、下拉无处可点。
       * ✅ 正解：选满两格就先出一条预览，**默认两边都保持原老师**（"科目不动"的字面意思），
       *    用户在下拉里改谁，这一条就跟着改（`teacherPick` 一改，下面 `aAfter/bAfter` 就变）。
       */
      return {
        kind: 'teacher',
        a,
        b,
        aBefore: { subject: ca.subject, teacherId: ca.teacherId },
        aAfter: { subject: ca.subject, teacherId: targetA ?? ca.teacherId ?? '' },
        bBefore: { subject: cb.subject, teacherId: cb.teacherId },
        bAfter: targetB
          ? { subject: cb.subject, teacherId: targetB }
          : cb.teacherId
            ? { subject: cb.subject, teacherId: ca.teacherId ?? '' }
            : null,
      }
    }
    return {
      kind: 'whole',
      a,
      b,
      /* 空的那一格在预览里就是「空」（科目空串 = 这一格换完没有课） */
      aBefore: { subject: ca?.subject ?? '', teacherId: ca?.teacherId ?? null },
      aAfter: { subject: cb?.subject ?? '', teacherId: cb?.teacherId ?? '' },
      bBefore: { subject: cb?.subject ?? '', teacherId: cb?.teacherId ?? null },
      bAfter: ca ? { subject: ca.subject, teacherId: ca.teacherId ?? '' } : null,
    }
  }, [picked, slots, swapKind, teacherPick])

  /** 把这一笔草稿落到**那一层**（临时 / 永久）—— 两条路，**不许互相顶替** */
  const applyPlan = () => {
    if (!klass || !plan) return
    /*
     * 🔴 两格都先**从网格上取出来**（有课的那一格 / 空格子），再决定写什么：
     *    空格子没有周课表行，`start` 只能取标准节次表 —— 它照样是一条要落的改动
     *    （"把这一节挪到空的那一节" = 源那一节写空 + 目标那一节写上课）。
     */
    const targets: Array<{
      period: number
      start: string
      end: string
      fromSubject: string
      fromTeacherId: string | null
      subject: string
      teacherId: string
    }> = []
    const add = (p: number, after: SwapPlan['aAfter'] | SwapPlan['bAfter']) => {
      if (!after) return
      const slot = slots.find((s) => s.period === p)
      if (!slot) return
      targets.push({
        period: p,
        start: slot.start,
        end: slot.end,
        fromSubject: slot.cell?.subject ?? '',
        fromTeacherId: slot.cell?.teacherId ?? null,
        subject: after.subject,
        teacherId: after.teacherId,
      })
    }
    add(plan.a, plan.aAfter)
    add(plan.b, plan.bAfter)
    /*
     * 🔴 **永久那一档做不到"把一节腾空"**：`schedule_items` 里没有"空课"这一种行
     *    （腾空 = 删掉那一行，而删行**绕开** `apply_perm_schedule_change()` 的留档纪律）。
     *    所以这一档只改"这一节上什么课"，遇到要腾空的格**整笔都不落**并**显式说一句** ——
     *    不许只写一半（目标那一节写上了、源那一节还挂着课，看着像成功）。
     */
    if (tweak === 'perm' && targets.some((t) => !t.subject)) {
      setNote(
        '永久调课改的是「这一节上什么课」—— 它做不到把一节腾空（周课表里没有"空课"这一行）。把课挪到空位请用「临时调课」那一档。',
      )
      return
    }
    setBusy(true)
    void (async () => {
      try {
        const bad: string[] = []
        for (const t of targets) {
          const cell = slots.find((s) => s.period === t.period)?.cell ?? null
          /* 🔴 两个字段一起写：`title` 是科目、`teacher_id` 是老师（§38.7 只动这两列） */
          if (tweak === 'temp') {
            if (readState === 'present') {
              const r = await remote.saveTempScheduleChange({
                onDate: date,
                classId: klass.id,
                start: t.start,
                end: t.end,
                fromSubject: t.fromSubject,
                fromTeacherId: t.fromTeacherId,
                toSubject: t.subject,
                toTeacherId: t.teacherId,
                kind: plan.kind,
              })
              if (!r.ok) bad.push(r.message)
            }
            addTempScheduleChange({
              date,
              classId: klass.id,
              start: t.start,
              end: t.end,
              fromSubject: t.fromSubject,
              fromTeacherId: t.fromTeacherId,
              toSubject: t.subject,
              toTeacherId: t.teacherId,
              kind: plan.kind,
            })
          } else {
            const item = rows.find((x) => x.weekday === weekday && x.start === t.start)
            /* 这一格该变成什么科目（**老师的名字不在 `title` 里** —— 它由 `getDayCells` 那一层接上） */
            const nextTitle =
              item && t.subject === subjectOfTitle(item.title, klass.name)
                ? item.title
                : `${klass.name} ${t.subject}`
            if (readState === 'present') {
              const r = await remote.applyPermScheduleChange({
                classId: klass.id,
                weekday,
                start: t.start,
                end: t.end,
                fromSubject: item ? subjectOfTitle(item.title, klass.name) : (cell?.subject ?? ''),
                fromTeacherId: cell?.teacherId ?? null,
                toSubject: t.subject,
                toTeacherId: t.teacherId,
                kind: plan.kind,
                scheduleItemId: item && /^[0-9a-f-]{36}$/i.test(item.id) ? item.id : null,
              })
              if (!r.ok) bad.push(r.message)
            }
            /*
             * 本地演示 / 没读到这一天的格子时，就落在**周课表草稿**上：
             * 这一格原来有课 → **改那一行**（`title` 与"老师"一起改）；原来空着 → 新加一行。
             * ⚠️ "改哪一行"只按（星期几 + 开始时间）找 —— 这一页写的就是**这一格**，
             *    同格多行是"同一个班同一时段两节课"那种异常态，不是这里要选的东西。
             */
            if (item) {
              updateSchedule(item.id, { title: nextTitle, scope: 'class' })
            } else {
              addScheduleMany([
                {
                  weekday,
                  start: t.start,
                  end: t.end,
                  title: nextTitle,
                  classId: klass.id,
                  kind: 'class',
                  notify: true,
                  scope: 'class',
                },
              ])
            }
          }
        }
        if (bad.length) {
          setNote(`有两处没改成：\n${bad.join('\n')}`)
        } else {
          push({
            text: tweak === 'temp' ? '这一天的调课记下了' : '周课表改了',
            tone: 'ok',
            desc:
              tweak === 'temp'
                ? `${date} 这一天生效，那天过了就不再生效`
                : `以后每个${WEEKDAY_TEXT[weekday - 1]}都按新的上`,
          })
        }
        setPicked([])
        setPermAck(false)
        setConfirmOpen(false)
        setTick((v) => v + 1)
      } finally {
        setBusy(false)
      }
    })()
  }

  if (!classes.length) {
    return (
      <Panel bodyClass="p-3">
        <Empty
          icon={<IconGrid size={24} />}
          title="还没有班级"
          desc="课程管理按年级列出班级。班级建好之后，这里就能一个个班看课表。"
        />
      </Panel>
    )
  }

  return (
    <div data-course-admin="1">
      <Panel bodyClass="p-3">
        <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
          看每个班的课表、核对教室里显示的那一份、调课。
        </div>

        {groups.map((g) => {
          const open = openGrade === g.key
          const split = byGrade.get(g.key) ?? { admin: [], stream: [] }
          const total = split.admin.length + split.stream.length
          const n = withGrid(g)
          return (
            <div key={g.key} className="mb-1.5">
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${g.name}的班级`}
                data-course-grade={g.key}
                className="row"
                style={{ padding: '8px 10px', border: '1px solid var(--color-line)', borderRadius: 4 }}
                onClick={() => toggleGrade(g.key)}
              >
                <span style={{ color: 'var(--color-ink3)', display: 'grid', placeItems: 'center' }}>
                  <IconStack size={14} />
                </span>
                <span className="min-w-0 flex-1" style={{ fontSize: 13.5, fontWeight: 620 }}>
                  {g.cohort ? `${g.cohort}级 · ` : ''}
                  {g.name}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  {total} 个班 · {n} 个有课表
                </span>
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    color: 'var(--color-ink3)',
                    transition: 'transform .18s ease',
                    transform: open ? 'rotate(90deg)' : 'none',
                  }}
                >
                  <IconChevronRight size={15} />
                </span>
              </button>

              {open ? (
                <div
                  data-course-grade-body={g.key}
                  className="px-2 pb-2 pt-2"
                  style={{ border: '1px solid var(--color-line)', borderTop: 'none', borderRadius: '0 0 4px 4px' }}
                >
                  {total === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '4px 2px' }}>
                      这个年级还没有班。
                    </div>
                  ) : (
                    <>
                      {split.admin.length ? (
                        <>
                          <Sect>行政班</Sect>
                          <div className="flex flex-col gap-1">
                            {split.admin.map((k) => (
                              <ClassRow
                                key={k.id}
                                klass={k}
                                on={k.id === classId}
                                count={countByClass.get(k.id) ?? 0}
                                onPick={() => toggleClass(k.id)}
                              />
                            ))}
                          </div>
                        </>
                      ) : null}
                      {split.stream.length ? (
                        <div className={split.admin.length ? 'mt-2.5' : ''}>
                          <Sect>走班班</Sect>
                          <div className="flex flex-col gap-1">
                            {split.stream.map((k) => (
                              <ClassRow
                                key={k.id}
                                klass={k}
                                on={k.id === classId}
                                count={countByClass.get(k.id) ?? 0}
                                onPick={() => toggleClass(k.id)}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </Panel>

      {klass ? (
        <div className="mt-2" data-course-schedule={klass.id}>
          <Panel
            head={`${klass.name} 的课表`}
            extra={
              <span className="flex items-center gap-2">
                {/* 🔴 只在「这个班录过课表」时才摆这两档 —— 没课表时整周是一张全空的表，
                    摆上去就是点了没反应（录入那一块仍然是唯一的入口）。 */}
                {cap && cap.canManage && rows.length ? (
                  <span className="flex items-center gap-1">
                    {(
                      [
                        ['week', '整周'],
                        ['day', '这一天'],
                      ] as Array<['week' | 'day', string]>
                    ).map(([v, label]) => {
                      const on = courseView === v
                      return (
                        <button
                          key={v}
                          type="button"
                          data-course-view={v}
                          aria-pressed={on}
                          onClick={() => setCourseView(v)}
                          style={{
                            padding: '3px 9px',
                            borderRadius: 4,
                            fontSize: 11.5,
                            cursor: 'pointer',
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line)'}`,
                            background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                          }}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </span>
                ) : null}
                {rows.length ? (
                  <Tag tone="ok">已录 {rows.length} 节</Tag>
                ) : (
                  <Tag tone="idle">还没录</Tag>
                )}
                {/* 🔴 一枚**明确的"收起"**：不看说明也知道怎么回到"什么都没选"
                    （用户 2026-10-12 指出的第①个 bug 的另一半） */}
                <Button size="sm" data-course-close="1" onClick={() => pickClass(null)}>
                  收起
                </Button>
              </span>
            }
            bodyClass="p-3"
          >
            {/* 🔴 那一句话（权限 / 结果 / 拦下来的原因）—— **上屏，不静默**（§三.5） */}
            {note ? (
              <div
                role="status"
                data-course-note="1"
                style={{
                  background: 'var(--color-warnsoft)',
                  border: '1px solid var(--color-warnline)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  fontSize: 11.5,
                  color: 'var(--color-warnink)',
                  lineHeight: 1.7,
                  marginBottom: 8,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {note}
              </div>
            ) : null}

            {cap === null ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>正在读课表…</div>
            ) : cap.canManage ? (
              rows.length ? (
                /* ---------------- 核对模式：录过了 ---------------- */
                <div data-course-mode="review">
                  {/*
                    🔴 这一层（`data-course-mode="review"`）**两档下都在** —— 它说的是"这个班录过课表"。
                       「这一天」那一支与改动前**逐字相同**（`data-course-show="all"` 与 `data-course-review`
                       都在它里面，那是门禁锚点）；换成「整周」只是把它换成下面这张周表。
                  */}
                  {courseView === 'week' ? (
                    <>
                      {/*
                        整周网格：行 = **这一周真的出现过的时段**（不是固定 9 节，见 `weekRowStarts`）
                        · 列 = 周一~周日。
                        🔴 数据格挂 `data-course-week-cell` / `data-course-week-empty`，
                           **绝不挂 `data-course-cell` / `data-course-empty`** —— 后两个是
                           「这一天摆得出几格」的口径（见下面调课区那段注释），挂上去那几条读数会变假。
                      */}
                      <div style={{ overflowX: 'auto' }}>
                        <table
                          data-course-week-grid="1"
                          style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}
                        >
                          <thead>
                            <tr>
                              <th
                                style={{
                                  width: 78,
                                  textAlign: 'left',
                                  padding: '4px 4px',
                                  borderBottom: '1px solid var(--color-line2)',
                                }}
                              />
                              {WEEKDAY_TEXT.map((label, i) => {
                                const wd = i + 1
                                /* 「没有课」= 这一列**一节都没有**（这一天那一列看叠过临时层的那一份） */
                                const none = weekLessons[wd - 1].length === 0
                                return (
                                  <th
                                    key={wd}
                                    data-course-week-head={wd}
                                    style={{
                                      padding: '4px 4px',
                                      borderBottom: '1px solid var(--color-line2)',
                                      fontSize: 11.5,
                                      color: none ? 'var(--color-ink4)' : 'var(--color-ink2)',
                                    }}
                                  >
                                    {label}
                                    <span
                                      style={{
                                        display: 'block',
                                        fontSize: 10.5,
                                        fontWeight: 400,
                                        color: 'var(--color-ink4)',
                                      }}
                                    >
                                      {none ? '没有课' : '每周'}
                                    </span>
                                  </th>
                                )
                              })}
                            </tr>
                          </thead>
                          <tbody>
                            {weekRowStarts.map((row, i) => {
                              /* 属性值那个 `p` = **行的序号（1 起）**；行本身是"这一周真的上过的时段" */
                              const p = i + 1
                              return (
                                <tr key={row.start}>
                                  <td
                                    style={{
                                      padding: '4px 4px',
                                      borderBottom: '1px solid var(--color-line)',
                                      fontSize: 11,
                                      color: 'var(--color-ink3)',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {slotTextOf(row.start, row.end)}
                                  </td>
                                  {WEEKDAY_TEXT.map((_, j) => {
                                    const wd = j + 1
                                    /* 这一格里**这一时段**的课 —— 同一时刻可能不止一节（② 类撞课），一节都不许丢 */
                                    const here = weekLessons[wd - 1].filter(
                                      (l) => l.start === row.start,
                                    )
                                    /*
                                     * 🔴 撞课只有「这一天」那一列可能撞（别的列没有"这一天"这件事）；
                                       口径用开始时间（与冲突区、与「这一天」那一格**同一把钥匙**）——
                                       读不到冲突（三态里的"没结论"）时 `conflictStarts` 是空的 → 什么都不挂。
                                     */
                                    const hit = wd === weekday && conflictStarts.has(row.start)
                                    return (
                                      <td
                                        key={wd}
                                        data-course-week={`${wd}-${p}`}
                                        style={{
                                          padding: 3,
                                          borderBottom: '1px solid var(--color-line)',
                                          borderLeft: '1px solid var(--color-line)',
                                          verticalAlign: 'top',
                                        }}
                                      >
                                        <div
                                          {...(here.length
                                            ? { 'data-course-week-cell': `${wd}-${p}` }
                                            : { 'data-course-week-empty': `${wd}-${p}` })}
                                          style={{
                                            minHeight: 32,
                                            padding: '4px 5px',
                                            borderRadius: 4,
                                            border: `1px ${here.length ? 'solid' : 'dashed'} ${
                                              here.length
                                                ? 'var(--color-line2)'
                                                : 'var(--color-line)'
                                            }`,
                                            background: here.length
                                              ? 'var(--color-surface2)'
                                              : undefined,
                                          }}
                                        >
                                          {here.length ? (
                                            here.map((l, k) => (
                                              <div
                                                key={`${l.start}-${k}`}
                                                style={
                                                  k
                                                    ? {
                                                        marginTop: 4,
                                                        paddingTop: 4,
                                                        borderTop: '1px solid var(--color-line)',
                                                      }
                                                    : undefined
                                                }
                                              >
                                                <span
                                                  style={{
                                                    display: 'block',
                                                    fontSize: 11.5,
                                                    color: 'var(--color-ink2)',
                                                  }}
                                                >
                                                  {l.subject}
                                                </span>
                                                <span
                                                  style={{
                                                    display: 'block',
                                                    fontSize: 10.5,
                                                    color: 'var(--color-ink3)',
                                                  }}
                                                >
                                                  {teacherName(l.teacherId)}
                                                </span>
                                                {/* 「只这一天」与「撞课」是两件事：同时成立就两个都挂 */}
                                                {l.changed ? <Tag tone="warn">仅此一天</Tag> : null}
                                                {hit ? <Tag tone="bad">撞课</Tag> : null}
                                              </div>
                                            ))
                                          ) : (
                                            /* 没课的那一格：照预览 —— 不说话、不挂任何角标 */
                                            <span
                                              style={{ fontSize: 11, color: 'var(--color-ink3)' }}
                                            >
                                              空
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div
                        data-course-legend="1"
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: '4px 12px',
                          marginTop: 9,
                          fontSize: 11,
                          color: 'var(--color-ink2)',
                        }}
                      >
                        <span className="flex items-center gap-1">
                          <i
                            style={{
                              flexShrink: 0,
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              background: 'var(--color-surface2)',
                              border: '1px solid var(--color-line2)',
                            }}
                          />
                          有课
                        </span>
                        <span className="flex items-center gap-1">
                          <i
                            style={{
                              flexShrink: 0,
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              border: '1px dashed var(--color-line)',
                            }}
                          />
                          空 = 没课
                        </span>
                        <span className="flex items-center gap-1">
                          <i
                            style={{
                              flexShrink: 0,
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              background: 'var(--color-warnsoft)',
                              border: '1px solid var(--color-warn)',
                            }}
                          />
                          临时调课（只这一天）
                        </span>
                        <Tag tone="bad">撞课</Tag>
                        <span style={{ color: 'var(--color-ink4)' }}>
                          周末没有课 —— 空格子就是没课，不是出错了
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                  <div
                    data-course-show="all"
                    style={{ fontSize: 12, color: 'var(--color-okink)', lineHeight: 1.7, marginBottom: 8 }}
                  >
                    ✓ 这 {rows.length} 条教室里都会显示。
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {rows.map((s) => (
                      <ScheduleRow key={s.id} item={s} />
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    {reviewed ? (
                      <Tag tone="ok">已核对</Tag>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<IconCheck size={14} />}
                        data-course-review="1"
                        onClick={() => setReviewed(true)}
                      >
                        我核对过了
                      </Button>
                    )}
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      一条条对着看，看的是教室里现在显示的那一份。
                    </span>
                  </div>
                    </>
                  )}
                </div>
              ) : (
                /* ---------------- 录入模式：还没录过 ---------------- */
                <div data-course-mode="entry">
                  <div style={{ fontSize: 12, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                    这个班还没有课表。把学校发的电子表粘进来，或者一行一条手写，核对之后再导入。
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--color-bad)', lineHeight: 1.7, marginTop: 6 }}>
                    每行都要写上班名「{klass.name}」，教室端才认得出这节课是哪个班的。
                  </div>
                  <textarea
                    className="input mt-2"
                    rows={8}
                    spellCheck={false}
                    data-course-paste="1"
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder={`一行一条，例如：\n周一 08:00-08:40 ${klass.name} 语文\n周一 08:50-09:30 ${klass.name} 数学`}
                    style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!paste.trim() || busy}
                      data-course-parse="1"
                      onClick={() => {
                        const r = parseScheduleText(paste, classes)
                        if (!r.items.length) {
                          setParsed(null)
                          setNote(`没解析出课程。一行一条写最稳，例如「周一 08:00-08:40 ${klass.name} 语文」。`)
                          return
                        }
                        setNote('')
                        setParsed(r.items)
                      }}
                    >
                      解析并核对
                    </Button>
                    {parsed ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        data-course-import="1"
                        onClick={() => {
                          const items = parsed
                            .filter((r) => r.title.trim())
                            .map((r) => ({
                              weekday: r.weekday,
                              start: r.start,
                              end: r.end,
                              title: r.title.trim(),
                              room: r.room,
                              classId: r.classId,
                              kind: r.kind,
                              notify: r.notify,
                              scope: 'class' as const,
                            }))
                          if (!items.length) {
                            setNote('没有可导入的课。')
                            return
                          }
                          setBusy(true)
                          void (async () => {
                            try {
                              /*
                               * 🔴 排课入口的走班冲突闸门（I16）：与教室端粘贴 / 日程表 / 批量粘贴
                               *    **共用同一个** `checkScheduleConflicts` —— 少挂一处就是"有一个入口能绕过"。
                               *    ⚠️ 它只挡"排课的人不知道会撞"（前端判据不是安全边界）；
                               *       "三类冲突分开列 + 给建议"是上面那一节的事。
                               */
                              const gate = await checkScheduleConflicts(
                                {
                                  items: items.map((x, i) => ({ ...x, id: `pending-${i}` })),
                                  schedule,
                                  classes,
                                },
                                {
                                  loadMembers: remote.loadClassMembers,
                                  loadSubjects: remote.loadClassSubjects,
                                },
                              )
                              if (gate.blocked) {
                                setNote(`和走班班撞了，没有导入：\n${gate.message}`)
                                return
                              }
                              const n = addScheduleMany(items)
                              setParsed(null)
                              setPaste('')
                              const hidden = items.filter(
                                (x) => markOf(x.title, klass, classes) === 'red',
                              ).length
                              push({
                                text: `已导入 ${n} 条课`,
                                tone: hidden ? 'warn' : 'ok',
                                desc: hidden ? `${hidden} 条没认出班名，教室里不会显示` : undefined,
                              })
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }}
                      >
                        导入这 {parsed.filter((r) => r.title.trim()).length} 条
                      </Button>
                    ) : null}
                  </div>

                  {parsed ? (
                    <div className="mt-3" data-course-parsed="1">
                      <Sect>核对：解析出 {parsed.length} 条</Sect>
                      <div className="flex flex-col gap-1.5">
                        {parsed.map((r, i) => (
                          <div
                            key={`${r.weekday}-${r.start}-${i}`}
                            style={{ border: '1px solid var(--color-line2)', borderRadius: 4, padding: '6px 8px' }}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="num"
                                style={{ fontSize: 11.5, color: 'var(--color-ink3)', flexShrink: 0 }}
                              >
                                {WEEKDAY_TEXT[r.weekday - 1]} {r.start}–{r.end}
                              </span>
                              <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
                                {r.title}
                              </span>
                            </div>
                            <MarkLine mark={markOf(r.title, klass, classes)} klass={klass} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            ) : (
              /*
               * 🔴 摆不了入口的三种情形，各自说清是哪一种（**都不是红**）：
               *   · `denied`  —— 数据库说这个班不归我管；
               *   · `missing` —— §38 还没跑（函数 / 表不在）→ **优雅降级**：课表照旧看得见；
               *   · `unknown` —— 这一次没读出来（断网 / 认不出的错）→ 入口先不摆。
               */
              <div data-course-locked={cap.verdict}>
                <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                  {cap.notice}
                </div>
                {rows.length ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {rows.map((s) => (
                      <ScheduleRow key={s.id} item={s} />
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 6 }}>
                    这个班还没有课表。
                  </div>
                )}
              </div>
            )}
          </Panel>

          {/* ============ 第 3 轮：调课 · 冲突 · 建议（**照着 v3 预览**） ============ */}
          {cap?.canManage && rows.length ? (
            <AdjustPanel
              klass={klass}
              date={date}
              onDate={setDate}
              weekday={weekday}
              slots={slots}
              readState={readState}
              tweak={tweak}
              onTweak={(m) => {
                setTweak(m)
                setPermAck(false)
                setPicked([])
              }}
              swapKind={swapKind}
              onSwapKind={(k) => {
                setSwapKind(k)
                setPicked([])
              }}
              picked={picked}
              onPick={(p) => {
                setPermAck(false)
                setPicked((prev) => {
                  if (prev.includes(p)) return prev.filter((x) => x !== p)
                  if (prev.length >= 2) return [p]
                  return [...prev, p]
                })
              }}
              onClearPick={() => {
                setPicked([])
                setPermAck(false)
              }}
              plan={plan}
              teacherName={teacherName}
              teacherPick={teacherPick}
              onTeacherPick={setTeacherPick}
              classroomEffect={classroomEffect}
              onApply={() => setConfirmOpen(true)}
              tempCount={tempChanges.filter((c) => c.date === date && c.classId === klass.id).length}
              teacherOptions={teacherOptions}
            />
          ) : null}

          {cap?.canManage && rows.length ? (
            <ConflictPanel
              klass={klass}
              date={date}
              weekday={weekday}
              cells={cells}
              readState={readState}
              byKind={byKind}
              hardN={hardN}
              studentCheck={studentCheck}
              classes={classes}
              openConflict={openConflict}
              onOpen={setOpenConflict}
              teacherName={teacherName}
              onJump={(cid, periods, kind) => {
                /* 🔴 点班名 → 跳到那个班的调课界面，**那一节已经替你选上**（照 v3 预览） */
                setClassId(cid)
                setSwapKind(kind)
                setPicked(periods)
                setOpenConflict(null)
                setNote(
                  `已经跳到 ${classes.find((k) => k.id === cid)?.name ?? '那个班'}，第 ${periods.join(' 节和第 ')} 节替你选上了。`,
                )
              }}
              dayCells={() => allCellsOf()}
            />
          ) : null}
        </div>
      ) : null}

      {/* ---------------- 确认弹层：**改的是哪一层 + 会发生什么** ---------------- */}
      <Modal
        open={confirmOpen && Boolean(plan)}
        onClose={() => setConfirmOpen(false)}
        labelledBy="course-confirm-title"
      >
        {plan && klass ? (
          <div data-course-confirm={tweak}>
            <h3 id="course-confirm-title" style={{ fontSize: 15, fontWeight: 700 }}>
              {tweak === 'perm' ? '确认改周课表' : '确认调课'}
            </h3>
            <div className="mt-2">
              <Tag tone={tweak === 'perm' ? 'accent' : 'warn'}>
                {tweak === 'perm' ? '永久 · 以后每周都变' : '临时 · 只影响这一天'}
              </Tag>
            </div>

            <div
              data-course-effect={tweak}
              style={{
                marginTop: 10,
                background: tweak === 'perm' ? 'var(--color-accentsoft)' : 'var(--color-warnsoft)',
                border: `1px solid ${tweak === 'perm' ? 'var(--color-accent)' : 'var(--color-warnline)'}`,
                color: tweak === 'perm' ? 'var(--color-accentink)' : 'var(--color-warnink)',
                borderRadius: 4,
                padding: '10px 12px',
                fontSize: 12.5,
                lineHeight: 1.8,
              }}
            >
              {tweak === 'perm'
                ? `这是永久调课：确认之后每周固定课表就改了 —— 以后每个${WEEKDAY_TEXT[weekday - 1]}都按新的上，不会自己恢复。`
                : `这是临时调课：确认之后只有 ${date}（${WEEKDAY_TEXT[weekday - 1]}）这一天按新的上，第二天自动回到原来的课表。`}
              <br />
              {classroomEffect(plan)}
            </div>

            <div className="mt-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
              <div>
                第 {plan.a} 节：
                {plan.aBefore.subject
                  ? ` ${plan.aBefore.subject} ${teacherName(plan.aBefore.teacherId)}`
                  : ' 空'}{' '}
                →{' '}
                <b>
                  {plan.aAfter.subject
                    ? `${plan.aAfter.subject} ${teacherName(plan.aAfter.teacherId)}`
                    : '空'}
                </b>
              </div>
              {plan.bAfter ? (
                <div>
                  第 {plan.b} 节：
                  {plan.bBefore.subject
                    ? ` ${plan.bBefore.subject} ${teacherName(plan.bBefore.teacherId)}`
                    : ' 空'}{' '}
                  →{' '}
                  <b>
                    {plan.bAfter.subject} {teacherName(plan.bAfter.teacherId)}
                  </b>
                </div>
              ) : (
                <div style={{ color: 'var(--color-ink3)' }}>第 {plan.b} 节空出来</div>
              )}
            </div>

            {tweak === 'perm' ? (
              /* 🔴 永久那一道：**多勾一句才点得动**（照 v3 预览） */
              <label
                data-course-permack="1"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 9,
                  marginTop: 12,
                  padding: '9px 10px',
                  border: '1px solid var(--color-warn)',
                  background: 'var(--color-warnsoft)',
                  borderRadius: 4,
                  fontSize: 12.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={permAck}
                  onChange={(e) => setPermAck(e.target.checked)}
                  style={{ marginTop: 3, width: 15, height: 15, accentColor: 'var(--color-accent)' }}
                />
                <span>
                  <b style={{ color: 'var(--color-warnink)' }}>
                    我知道：以后每{WEEKDAY_TEXT[weekday - 1]}都会变，不是只改这一天
                  </b>
                  <br />
                  <span style={{ color: 'var(--color-ink3)' }}>
                    要改回来，得再调一次。
                  </span>
                </span>
              </label>
            ) : null}

            {/* 🔴 **不硬拦**：设计上允许带着冲突确认（§38 的口径，这句话就是原话） */}
            {hardN ? (
              <div
                data-course-remain={hardN}
                style={{ marginTop: 10, fontSize: 12, color: 'var(--color-bad)', lineHeight: 1.7 }}
              >
                改完还剩 {hardN} 处老师撞课或班级撞课没处理。
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-okink)' }}>
                {tweak === 'perm' ? '改完这一天不撞课。' : '调完这一天不撞课。'}
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <Button size="sm" block onClick={() => setConfirmOpen(false)}>
                再想想
              </Button>
              <Button
                size="sm"
                variant="primary"
                block
                data-course-doconfirm="1"
                disabled={busy || (tweak === 'perm' && !permAck)}
                onClick={applyPlan}
              >
                {tweak === 'perm' ? '确认改周课表' : '确认调课'}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

/* ============================================================
   调课区 —— **两种模式分得明显**（琥珀 = 临时 / 强调色 + 左侧色条 = 永久）
   ============================================================ */

type AdjustPanelProps = {
  klass: Klass
  date: string
  onDate: (d: string) => void
  weekday: number
  /** **网格上的一天**（9 节全摆出来，空的那几格 `cell === null`） */
  slots: DaySlot[]
  readState: 'present' | 'local' | 'unknown' | 'missing' | 'pending'
  tweak: TweakMode
  onTweak: (m: TweakMode) => void
  swapKind: SwapKind
  onSwapKind: (k: SwapKind) => void
  picked: number[]
  onPick: (p: number) => void
  onClearPick: () => void
  plan: SwapPlan | null
  teacherName: (id: string | null) => string
  teacherOptions: Array<{ id: string; name: string }>
  teacherPick: Record<number, string>
  onTeacherPick: (m: Record<number, string>) => void
  classroomEffect: (m: Pick<SwapPlan, 'a' | 'b'> | null) => string
  onApply: () => void
  tempCount: number
}

function AdjustPanel({
  klass,
  date,
  onDate,
  weekday,
  slots,
  readState,
  tweak,
  onTweak,
  swapKind,
  onSwapKind,
  picked,
  onPick,
  onClearPick,
  plan,
  teacherName,
  teacherOptions,
  teacherPick,
  onTeacherPick,
  classroomEffect,
  onApply,
  tempCount,
}: AdjustPanelProps) {
  const perm = tweak === 'perm'
  const a = picked[0]
  /** 这一天这个班**有没有课**（9 格全摆着，但"有课"只看 `cell` 那一侧） */
  const hasCourse = slots.some((s) => s.cell)

  return (
    <Panel
      head={`调课 · ${klass.name}`}
      extra={
        <Tag tone={perm ? 'accent' : 'warn'}>
          {perm ? '永久调课 · 以后每周都变' : '临时调课 · 只影响这一天'}
        </Tag>
      }
      bodyClass="p-3"
    >
      {/* ① 调课日期（**临时看这一天**；永久只看星期几，哪一天都行） */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>调课日期</span>
        <input
          className="input"
          type="date"
          data-course-date="1"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          style={{ width: 150 }}
        />
        {(['temp', 'perm'] as TweakMode[]).map((m) => (
          <Tag key={m} tone={m === 'temp' ? 'warn' : 'accent'}>
            {m === 'temp' ? '临时看这一天' : '永久只看星期几'}
          </Tag>
        ))}
        <span className="flex-1" />
        <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }} data-course-date-hint="1">
          这一天是{WEEKDAY_TEXT[weekday - 1]}
        </span>
      </div>

      {/* ② **这一笔改动管多久** —— 两张并排的影响范围卡（用户点名："区分要一眼看得出"） */}
      <Sect>这一笔改动管多久</Sect>
      <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 12 }}>
        {(['temp', 'perm'] as TweakMode[]).map((m) => {
          const isP = m === 'perm'
          const on = tweak === m
          return (
            <button
              key={m}
              type="button"
              data-scope={m}
              aria-pressed={on}
              onClick={() => onTweak(m)}
              style={{
                textAlign: 'left',
                padding: '10px 11px',
                borderRadius: 4,
                border: `1px solid ${
                  isP ? 'var(--color-accent)' : on ? 'var(--color-warn)' : 'var(--color-warnline)'
                }`,
                borderWidth: isP ? 2 : 1,
                /* 永久多一条**左侧色条**（一眼就能看出它不是"只改这一天"那种） */
                boxShadow: isP ? 'inset 3px 0 0 var(--color-accent)' : undefined,
                background: on
                  ? isP
                    ? 'var(--color-accentsoft)'
                    : 'var(--color-warnsoft)'
                  : 'var(--color-surface)',
              }}
            >
              <span className="flex items-center gap-1.5 flex-wrap">
                <b style={{ fontSize: 13 }}>{isP ? '永久调课' : '临时调课'}</b>
                <Tag tone={isP ? 'accent' : 'warn'}>{isP ? '以后每周都变' : '只影响这一天'}</Tag>
              </span>
              <span
                style={{ display: 'block', fontSize: 11.5, color: 'var(--color-ink2)', marginTop: 4, lineHeight: 1.7 }}
              >
                {isP
                  ? '改的是每周固定课表本身 —— 以后每个星期都按新的上，不会自己恢复。'
                  : '改的是那一天的一节课 —— 第二天自动回到原来的课表。'}
              </span>
              <span
                data-course-scope-note={m}
                style={{
                  display: 'block',
                  fontSize: 11.5,
                  marginTop: 5,
                  lineHeight: 1.7,
                  color: isP ? 'var(--color-accentink)' : 'var(--color-warnink)',
                }}
              >
                {isP
                  ? `教室端：以后每个${WEEKDAY_TEXT[weekday - 1]}都按新的显示`
                  : `教室端：只有 ${date} 这一天按新的显示`}
              </span>
            </button>
          )
        })}
      </div>

      {/* ③ **怎么换** —— "同一门课换人" vs "整个格子换掉"（也要一眼看出区别） */}
      <Sect>怎么换</Sect>
      <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 12 }}>
        {(['whole', 'teacher'] as SwapKind[]).map((k) => {
          const on = swapKind === k
          const isTeacherOnly = k === 'teacher'
          return (
            <button
              key={k}
              type="button"
              data-kind={k}
              aria-pressed={on}
              onClick={() => onSwapKind(k)}
              style={{
                textAlign: 'left',
                padding: '10px 11px',
                borderRadius: 4,
                /* 🔴 用**同一套令牌**把两种换法分开：整格换 = 强调色**实框 + 强调色底** ·
                    只换老师 = 强调色**虚线框 + 更浅的底**。
                    ⚠️ **刻意不引第二套彩色令牌**：`shots` 的 F6-G 钉着一条 ——
                    `src` 里除了 `index.css` 那一处定义，**不许有任何页面引用那一个令牌**
                    （它会在紫套下多出一片要收的面积）。要再引它，先回 `index.css` 决定怎么收。 */
                border: `1px ${isTeacherOnly ? 'dashed' : 'solid'} ${
                  on ? 'var(--color-accent)' : 'var(--color-line)'
                }`,
                background: on
                  ? isTeacherOnly
                    ? 'var(--color-surface2)'
                    : 'var(--color-accentsoft)'
                  : 'var(--color-surface)',
              }}
            >
              <span className="flex items-center gap-1.5 flex-wrap">
                <b style={{ fontSize: 13 }}>{k === 'whole' ? '整格换' : '只换老师'}</b>
                <Tag tone={isTeacherOnly ? 'idle' : 'accent'}>{k === 'whole' ? '科目 + 老师一起换' : '科目不动'}</Tag>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 11.5 }}>
                <i style={{ color: 'var(--color-ink3)', fontStyle: 'normal' }}>语文 朱文熙</i>
                <IconSwap size={13} />
                <i
                  style={{
                    fontStyle: 'normal',
                    color: 'var(--color-accentink)',
                    fontWeight: 620,
                  }}
                >
                  {k === 'whole' ? '数学 王琳鑫' : '语文 唐以利'}
                </i>
              </span>
              {isTeacherOnly ? (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--color-ink3)', marginTop: 3 }}>
                  同一门课换个人上
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* ④ 一天一格：**9 节全摆出来**（没课的那几格是空格子）→ 点两格 → 预览 */}
      <div data-course-day="1" className="flex flex-col gap-1.5">
        {hasCourse ? null : (
          <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
            {readState === 'pending'
              ? '正在读这一天的课…'
              : `${WEEKDAY_TEXT[weekday - 1]}这一天这个班没有课 —— 下面这些格子都是空的。`}
          </div>
        )}
        {slots.map((s) => {
          const c = s.cell
          const on = picked.includes(s.period)
          const idx = picked.indexOf(s.period)
          return (
            <button
              key={s.period}
              type="button"
              /*
               * 🔴 **空格子不叫 `data-course-cell`**：那个属性在门禁里是"这一格有课"
               *    （`shots.mjs` S27 ⑫ 按它数"这一天摆得出几格"、⑬ 按 first/last 点两格）——
               *    空格子挂上去会让那几条读数变成假的。空格子用 `data-course-empty`。
               */
              {...(c ? { 'data-course-cell': s.period } : { 'data-course-empty': s.period })}
              data-picked={on ? '1' : '0'}
              onClick={() => onPick(s.period)}
              className="row"
              style={{
                padding: '7px 9px',
                /* 没课的那一格：**虚框 + 「空」**（照 `预览-v3.html` 周末那一列的空格子） */
                border: `1px ${c ? 'solid' : 'dashed'} ${
                  on ? 'var(--color-accent)' : 'var(--color-line)'
                }`,
                borderRadius: 4,
                background: on ? 'var(--color-accentsoft)' : undefined,
              }}
            >
              <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)', flex: '0 0 auto' }}>
                {c ? `第 ${s.period} 节 ${c.start}` : `第 ${s.period} 节`}
              </span>
              <span
                className="min-w-0 flex-1"
                style={{
                  fontSize: 13,
                  textAlign: 'left',
                  color: c ? undefined : 'var(--color-ink3)',
                }}
              >
                {c ? `${c.subject} · ${teacherName(c.teacherId)}` : '空'}
              </span>
              {c?.changed ? <Tag tone="warn">这一天已调</Tag> : null}
              {on ? <Tag tone="accent">第 {idx + 1} 格</Tag> : null}
            </button>
          )
        })}
      </div>

      {picked.length === 1 ? (
        <div style={{ fontSize: 12, color: 'var(--color-ink2)', marginTop: 9 }}>
          已选<b>第 {a} 节</b> —— 再点另一格。
          <Button size="sm" className="ml-2" onClick={onClearPick}>
            重选
          </Button>
        </div>
      ) : null}

      {/* 🔴 选了两格却**没有可换的**时，明说为什么（不许点了没反应）—— 空格子不算课 */}
      {picked.length === 2 && !plan ? (
        <div
          data-course-pairbad="1"
          style={{ fontSize: 12, color: 'var(--color-warnink)', marginTop: 9, lineHeight: 1.7 }}
        >
          {picked.every((p) => !slots.find((s) => s.period === p)?.cell)
            ? '这两格都是空的 —— 没有可换的课。'
            : '「只换老师」要两格都有课 —— 换的是这两节课的老师；有一格是空的，换不了。'}
        </div>
      ) : null}

      {/* ⑤ 对调预览：两格各自的「现在 → 换完」+ **教室端会变成什么样** */}
      {plan ? (
        <div
          data-course-plan={plan.kind}
          style={{
            marginTop: 10,
            /* 同样只用强调色一套令牌：整格换 = 实框 · 只换老师 = 虚线框（见上面那张卡的理由） */
            border: `1px ${plan.kind === 'teacher' ? 'dashed' : 'solid'} var(--color-accent)`,
            background:
              plan.kind === 'teacher' ? 'var(--color-surface2)' : 'var(--color-accentsoft)',
            borderRadius: 4,
            padding: '10px 11px',
          }}
        >
          <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 7 }}>
            <b style={{ fontSize: 13 }}>
              {plan.kind === 'teacher' ? '这两节课只换老师' : '这两节整格换'}
            </b>
            <Tag tone={plan.kind === 'teacher' ? 'idle' : 'accent'}>
              {plan.kind === 'teacher' ? '科目不动' : '科目 + 老师一起换'}
            </Tag>
            <Tag tone={perm ? 'accent' : 'warn'}>{perm ? '永久 · 每周都变' : '临时 · 只这一天'}</Tag>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            <div>
              第 {plan.a} 节：
              {plan.aBefore.subject
                ? ` ${plan.aBefore.subject} ${teacherName(plan.aBefore.teacherId)}`
                : ' 空'}{' '}
              →{' '}
              {/* 🔴 换完是**空**的时候写「空」，别留一片空白（那是"没写成"，不是"空出来"） */}
              <b>
                {plan.aAfter.subject
                  ? `${plan.aAfter.subject} ${teacherName(plan.aAfter.teacherId)}`
                  : '空'}
              </b>
            </div>
            {plan.bAfter ? (
              <div>
                第 {plan.b} 节：
                {plan.bBefore.subject
                  ? ` ${plan.bBefore.subject} ${teacherName(plan.bBefore.teacherId)}`
                  : ' 空'}{' '}
                →{' '}
                <b>
                  {plan.bAfter.subject} {teacherName(plan.bAfter.teacherId)}
                </b>
              </div>
            ) : (
              <div style={{ color: 'var(--color-ink3)' }}>第 {plan.b} 节空出来</div>
            )}
          </div>

          {plan.kind === 'teacher' ? (
            <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                第 {plan.a} 节换成谁
              </span>
              <select
                className="input"
                data-course-teacherpick={plan.a}
                value={teacherPick[plan.a] ?? ''}
                onChange={(e) => onTeacherPick({ ...teacherPick, [plan.a]: e.target.value })}
                style={{ fontSize: 12 }}
              >
                <option value="">这一格现在那位</option>
                {teacherOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* ⚠️ 两种各自的"教室端会变成什么样"那句话 —— **都要有**（用户最关心这个） */}
          <div
            data-course-classroom={tweak}
            style={{
              marginTop: 9,
              fontSize: 12,
              lineHeight: 1.8,
              color: perm ? 'var(--color-accentink)' : 'var(--color-warnink)',
            }}
          >
            {classroomEffect(plan)}
          </div>

          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" data-course-apply="1" onClick={onApply}>
              {perm ? '确认改周课表…' : '确认调课…'}
            </Button>
            <Button size="sm" onClick={onClearPick}>
              重选
            </Button>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
        {perm
          ? `永久调课改的是每周固定课表 —— 确认之后以后每个${WEEKDAY_TEXT[weekday - 1]}都按新的上。`
          : `临时调课只改 ${date} 这一天 —— 那天一过去就自动回到原来的课表。`}
        {perm && tempCount ? ` 这一天另有 ${tempCount} 处临时调课，与这次无关。` : ''}
      </div>
    </Panel>
  )
}

/* ============================================================
   冲突区 —— **三类分开列**，每条说清"冲突的另一半在哪个班"
   ============================================================ */

type ConflictPanelProps = {
  klass: Klass
  date: string
  weekday: number
  cells: DayCell[]
  readState: 'present' | 'local' | 'unknown' | 'missing' | 'pending'
  byKind: Record<ConflictKind, ConflictRow[]>
  hardN: number
  studentCheck: 'gray' | 'ok' | 'n/a'
  classes: Klass[]
  openConflict: string | null
  onOpen: (key: string | null) => void
  teacherName: (id: string | null) => string
  /** 点班名/建议 → 跳到那个班，并且**那两格已经替用户选好**（`kind` = 该用哪种换法） */
  onJump: (classId: string, periods: number[], kind: SwapKind) => void
  /** 这一天**所有班**的格子（建议算法用它算"这位老师那个时段空不空"） */
  dayCells: () => Map<string, DayCell[]>
}

function ConflictPanel({
  klass,
  date,
  cells,
  readState,
  byKind,
  hardN,
  studentCheck,
  classes,
  openConflict,
  onOpen,
  teacherName,
  onJump,
  dayCells,
}: ConflictPanelProps) {
  const nameOf = (id: string | null) => classes.find((k) => k.id === id)?.name ?? '这个班'
  const open = openConflict ? [...byKind.teacher, ...byKind.class, ...byKind.student].find((c) => c.key === openConflict) : null

  return (
    <Panel
      head="冲突与建议"
      extra={
        <Tag tone={hardN ? 'bad' : 'ok'}>{hardN ? `${hardN} 处要处理` : '没有冲突'}</Tag>
      }
      bodyClass="p-3"
    >
      {readState !== 'present' && readState !== 'local' ? (
        /* 三态：**没读到不是"没冲突"** —— 灰，且说清是哪一种 */
        <div data-course-conflict-read={readState} style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
          {readState === 'pending'
            ? '正在读这一天的冲突…'
            : readState === 'missing'
              ? '冲突检查还没开通，这里现在看不出这一天会不会撞课。'
              : '这一次没读出这一天的冲突，看不出会不会撞课。'}
        </div>
      ) : null}

      {(['teacher', 'class', 'student'] as ConflictKind[]).map((kind) => {
        const list = byKind[kind]
        /* 🔴 ③ 走班班**没有名单** → 这一档**查不了**：灰，**不许当绿** */
        const gray = kind === 'student' && studentCheck === 'gray'
        return (
          <div key={kind} style={{ marginTop: kind === 'teacher' ? 0 : 12 }}>
            <div
              data-course-conflict-head={kind}
              className="flex items-center gap-2 flex-wrap"
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: gray
                  ? 'var(--color-ink3)'
                  : kind === 'student'
                    ? 'var(--color-warnink)'
                    : 'var(--color-badink)',
                marginBottom: 7,
              }}
            >
              <span>{CONFLICT_HEAD[kind]}</span>
              {gray ? (
                <span data-course-conflict-state="gray" style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                  这个走班班没有名单，这一档查不了
                </span>
              ) : (
                <Tag tone="idle">{list.length}</Tag>
              )}
            </div>
            {gray ? null : list.length ? (
              list.map((c) => {
                const isOpen = openConflict === c.key
                const other = c.otherClassId
                return (
                  <div
                    key={c.key}
                    data-course-conflict={c.kind}
                    style={{
                      border: `1px solid ${kind === 'student' ? 'var(--color-warnline)' : 'var(--color-badline)'}`,
                      background: kind === 'student' ? 'var(--color-warnsoft)' : 'var(--color-badsoft)',
                      borderRadius: 4,
                      padding: '9px 10px',
                      marginBottom: 8,
                    }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <b style={{ fontSize: 12.5 }}>
                        第 {c.period} 节 {c.start} ·{' '}
                        {kind === 'teacher'
                          ? `${teacherName(c.teacherId)}`
                          : kind === 'class'
                            ? '同一个班压了两节'
                            : '走班学生'}
                      </b>
                      <span className="flex-1" />
                      <Button size="sm" onClick={() => onOpen(isOpen ? null : c.key)}>
                        {isOpen ? '收起' : '看怎么改'}
                      </Button>
                    </div>
                    {/* 🔴 每条都要说清"冲突的另一半在**哪个班**" */}
                    <div style={{ fontSize: 12, color: 'var(--color-ink2)', marginTop: 4, lineHeight: 1.75 }}>
                      <b>
                        {other ? `冲突的另一半在：${nameOf(other)}` : '冲突的两半都在这个班里'}
                      </b>
                      <br />
                      {c.detail}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        className="chip"
                        data-course-jump={c.classId}
                        onClick={() => onJump(c.classId, [c.period], 'whole')}
                      >
                        {nameOf(c.classId)} ›
                      </button>
                      {other ? (
                        <button
                          type="button"
                          className="chip"
                          data-course-jump={other}
                          onClick={() => onJump(other, [c.period], 'whole')}
                        >
                          跳到 {nameOf(other)} ›
                        </button>
                      ) : null}
                    </div>
                    {isOpen ? (
                      <SuggestionBlock
                        row={c}
                        klass={klass}
                        cells={cells}
                        classes={classes}
                        dayCells={dayCells}
                        onUse={(periods, kind) => onJump(klass.id, periods, kind)}
                      />
                    ) : null}
                  </div>
                )
              })
            ) : (
              <div style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>没有。</div>
            )}
          </div>
        )
      })}

      {!hardN && !byKind.student.length && readState === 'present' ? (
        <div style={{ fontSize: 12, color: 'var(--color-okink)', marginTop: 10 }}>
          {date} 这一天排得开。
        </div>
      ) : null}

      {/* 不硬拦：这一句就是设计口径 */}
      {hardN ? (
        <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
          这几处不会挡住你 —— 改完还剩几处，确认那一步会再说一遍。
        </div>
      ) : null}

      {open ? null : null}
    </Panel>
  )
}

/**
 * **不冲突的建议** —— 用户原话：「给出的是不冲突的调课建议」（**不是**列一堆空位让人自己拼）。
 *
 * 🔴 **两种都要给**（照 v3 预览）：
 *   · **挪**：「把这一节挪到**第 N 节** —— 那个时段这个班空着、这位老师也空」；
 *   · **对调**：「跟**第 M 节**整格对调 —— 两节都是同一位老师的课」。
 * 每条都**带依据**，并且**一键把两格选好**（点完就落到上面那个对调预览里，再由用户确认）。
 * ⚠️ 算法**只做局部搜索**：找同一天里"本班空着 + 这位老师也空"的时段 ——
 *    不考虑教室容量 / 连堂 / 老师路程（用户明确说那是以后的事）。
 */
function SuggestionBlock({
  row,
  klass,
  cells,
  classes,
  dayCells,
  onUse,
}: {
  row: ConflictRow
  klass: Klass
  cells: DayCell[]
  classes: Klass[]
  dayCells: () => Map<string, DayCell[]>
  /** 一键：把该选的两格选好（`kind` = 该用哪种换法：挪 = 整格换过去；对调 = 整格对调） */
  onUse: (periods: number[], kind: SwapKind) => void
}) {
  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = []
    const all = dayCells()
    const mine = cells.find((c) => c.period === row.period) ?? cells.find((c) => c.start === row.start)
    const tId = row.teacherId ?? mine?.teacherId ?? null
    const taken = new Set(cells.map((c) => c.period))
    if (!mine) return out

    /** 这位老师这一天那个时段在**别的班**有没有课（同日同格 —— 本班那一格不算） */
    const teacherBusyElsewhere = (start: string): boolean => {
      if (!tId) return false
      for (const [cid, list] of all) {
        if (cid === klass.id) continue
        if (list.some((c) => c.start === start && c.teacherId === tId)) return true
      }
      return false
    }

    /* ① 「挪」：同一天里**这个班空着**的时段 —— 就是网格上那几格**空格子**（第 1…9 节） */
    for (let p = 1; p <= DAY_PERIODS; p++) {
      if (taken.has(p)) continue
      /* 空格子的钟点取**标准节次表**（照 `预览-v3.html:1035` 的 `moveOptions`：p 就是第 p 节）；
         ⚠️ 上限只能是 `DAY_PERIODS` —— 建议里写的"第 N 节"必须是网格上**真的摆着的那一格**，
            否则一键选两格会选中一个不存在的格子（只选中一格 → 没有预览）。 */
      const { start } = periodTime(p)
      if (teacherBusyElsewhere(start)) continue
      out.push({
        key: `move|${p}`,
        how: 'move',
        at: row.period,
        period: p,
        title: mine.subject,
        teacherId: tId,
        why: `那时这个班空着${tId ? '、这位老师也空' : ''}。`,
      })
      if (out.filter((x) => x.how === 'move').length >= 2) break
    }

    /* ② 「对调」：同一天里**同一位老师的另一节**（两节都是他的课，换完他不用同时段跑两个班） */
    for (const c of cells) {
      if (c.period === row.period) continue
      if (tId && c.teacherId !== tId) continue
      out.push({
        key: `swap|${c.period}`,
        how: 'swap',
        at: row.period,
        period: c.period,
        title: mine.subject,
        teacherId: tId,
        why: `两节都是${tId ? '这位老师' : '这个班'}的课，整格对调完两边都不撞。`,
      })
      if (out.filter((x) => x.how === 'swap').length >= 2) break
    }
    return out.slice(0, 3)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, cells, classes, klass.id])

  if (!suggestions.length) {
    return (
      <div
        data-course-suggest="0"
        style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}
      >
        这一节暂时没有能空出来的时间，先跟别的老师协商一下。
      </div>
    )
  }

  return (
    <div data-course-suggest={suggestions.length} style={{ marginTop: 8 }}>
      {suggestions.map((s, i) => (
        <div
          key={s.key}
          data-course-suggest-row={s.how}
          className="flex items-start gap-2"
          style={{
            border: '1px solid var(--color-line2)',
            borderRadius: 4,
            padding: '7px 9px',
            marginBottom: 6,
            fontSize: 12.5,
            lineHeight: 1.8,
          }}
        >
          <span style={{ fontWeight: 700, color: 'var(--color-ink3)' }}>{i + 1}</span>
          <span className="min-w-0 flex-1">
            {s.how === 'move' ? (
              <>
                把 <b>{s.title}</b> 这节挪到 <b>第 {s.period} 节</b> —— {s.why}
              </>
            ) : (
              <>
                跟 <b>第 {s.period} 节</b> 整格对调 —— {s.why}
              </>
            )}
          </span>
          <Button
            size="sm"
            data-course-suggest-use={s.key}
            /* 🔴 一键把两格选好：点了之后上面那两格就是这一对，用户再点确认才落地 */
            onClick={() => onUse([s.at, s.period], 'whole')}
          >
            用这个方案
          </Button>
        </div>
      ))}
      <div style={{ fontSize: 11, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
        点了之后上面那两格就替你选好了，确认之前什么都不会变。
      </div>
    </div>
  )
}

/** 一个班一行（点一下选它 —— 右边那块课表就是它的） */
function ClassRow({
  klass,
  on,
  count,
  onPick,
}: {
  klass: Klass
  on: boolean
  count: number
  onPick: () => void
}) {
  const stream = !isAdminClass(klass)
  const noRoster = stream && klass.students.length === 0
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`看${klass.name}的课表`}
      data-course-class={klass.id}
      className="row"
      style={{
        padding: '7px 9px',
        border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line)'}`,
        borderRadius: 4,
        background: on ? 'var(--color-accentsoft)' : undefined,
      }}
      onClick={onPick}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 99,
          flex: '0 0 auto',
          background: count ? 'var(--color-ok)' : 'var(--color-ink4)',
        }}
      />
      <span className="min-w-0 flex-1" style={{ fontSize: 13, fontWeight: on ? 620 : 550 }}>
        {klass.name}
      </span>
      {/* ⚠️ 走班班的人来自 `class_members`（多对多），这里**不数人数**（照 `Grades.tsx:334`） */}
      {stream ? <Tag tone="idle">走班班</Tag> : null}
      {/* 🔴 走班班**没有名单** → 第③类冲突**查不了**：显式说成灰，不是绿 */}
      {noRoster ? (
        <span data-course-noroster="1">
          <Tag tone="idle">没有名单</Tag>
        </span>
      ) : null}
      <span
        className="num"
        style={{ fontSize: 11.5, color: count ? 'var(--color-ink3)' : 'var(--color-ink4)' }}
      >
        {count ? `${count} 节` : '未录'}
      </span>
      <IconChevronRight size={14} />
    </button>
  )
}

/**
 * 课表里的一条 —— **只列事实，不判"会不会显示"**。
 * ⚠️ 凡是**已经挂在这个班上**（`classId` 命中）的行，教室端那块屏都会显示 ——
 *    给它们标红 = 假红。三态标记只出现在**待导入的那一批**上。
 */
function ScheduleRow({ item }: { item: ScheduleItem }) {
  return (
    <div
      data-course-row={item.id}
      style={{ border: '1px solid var(--color-line2)', borderRadius: 4, padding: '6px 8px' }}
    >
      <div className="flex items-center gap-2">
        <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)', flexShrink: 0 }}>
          {WEEKDAY_TEXT[item.weekday - 1]} {item.start}–{item.end}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13 }}>
          {item.title}
        </span>
        {item.room ? <Tag tone="idle">{item.room}</Tag> : null}
      </div>
    </div>
  )
}

