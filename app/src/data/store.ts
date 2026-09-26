import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { isRemote } from '../lib/supabase'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import { normalizePaperName } from '../lib/examPaper'
import { clampQuestionCount } from '../lib/assignments'
import { withSerial } from '../lib/serial'
import {
  alignAssignmentSubject,
  alignTeacherPrimarySubject,
  asSubjectCode,
  subjectCodeOfName,
  subjectName,
  teacherPrimarySubjectCode,
  DEFAULT_SUBJECT_CODE,
} from '../lib/subjects'
import * as remote from './remote'
import type { GradeRow } from './gradeSetup'
import type { Term } from '../lib/terms'
import * as noticeApi from '../lib/notices'
import * as annApi from '../lib/announcements'
import { makeClassrooms, makeDemoAssignments, makeDemoClasses, makeDemoExams, makeDemoSchedule, makeTemplates } from './seed'
import type { Exam, ExamScore } from './examTypes'
import type {
  Announcement,
  Assignment,
  AssignmentTemplate,
  CallRecord,
  CallState,
  ClassType,
  ClassroomClient,
  ImportRow,
  Klass,
  Notice,
  NoticeScopeOption,
  QuestionMeta,
  ScheduleItem,
  Student,
  StudentStatus,
  Teacher,
  TeacherRole,
} from './types'

/**
 * 生成主键。
 *
 * ⚠️ 必须是**标准 UUID**：数据库里这些列是 uuid 类型，`c-abc123` 这种短串会被直接拒绝
 * （invalid input syntax for type uuid）。而且跨设备各自新建时，UUID 天然不会撞。
 *
 * 另：`crypto.randomUUID` 只在安全上下文（https / localhost）存在。
 * 手机通过局域网 http 访问开发服务器时它是 undefined，所以这里手写一个 v4 兜底。
 */
function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const uid = uuid

/**
 * **确定性** UUID（v5 式：SHA-1(namespace + name)）。
 *
 * 考试为什么会用到它：一份**试卷**（同 paper_key + 学科 + 班级）在两台设备上
 * 各自新建时必须落到同一行 —— 否则"同一个班同一次考试"会变成两份档案，
 * 年级排名就会把同一个人算两遍。有了它，upsert 的 onConflict('id') 天然幂等。
 *
 * ⚠️ 它**不是**随机 id：同一个 (classId, paperKey) 永远得到同一个 uuid。
 *    改试卷名 = 换一份档案（符合语义：名字不同就是不同的考试，见 §14 同场判定）。
 *    `crypto.subtle` 只在安全上下文有（与 `uuid()` 的注释同一件事），
 *    没有时退回随机 id —— 功能不受影响，只是没了跨设备的幂等。
 */
async function stableUuid(namespace: string, name: string): Promise<string> {
  const c = globalThis.crypto
  if (!c?.subtle) return uid()
  try {
    const data = new TextEncoder().encode(`${namespace}\u0000${name}`)
    const buf = await c.subtle.digest('SHA-1', data)
    const b = new Uint8Array(buf).subarray(0, 16)
    b[6] = (b[6] & 0x0f) | 0x50
    b[8] = (b[8] & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  } catch {
    return uid()
  }
}

/** 一个学生的一次考试那一行的 id —— 只由 (考试, 学号) 决定，重跑导入不会插重 */
export function examScoreId(examId: string, studentNo: string): Promise<string> {
  return stableUuid(`exam-score:${examId}`, String(studentNo))
}

export type ImportMode = 'merge' | 'replace' | 'append'

/** 上次选中的班级（设备本地偏好：教室机想看 3 班、手机想看 1 班，各记各的更合理） */
const CURRENT_CLASS_KEY = 'shugao.currentClass'

function readCurrentClass(classes: Klass[]): string | null {
  let saved = ''
  try {
    saved = localStorage.getItem(CURRENT_CLASS_KEY) ?? ''
  } catch {
    /* 忽略 */
  }
  return classes.find((c) => c.id === saved)?.id ?? classes[0]?.id ?? null
}

type State = {
  teacher: Teacher | null
  classes: Klass[]
  /**
   * 🆕 2026-09-30：**年级表那一份**（`grades`）。
   *
   * 哪儿来的：
   *   · 远程模式 = `remote.loadGrades()`（`loadSnapshot` **不管**年级表 —— 它是一条
   *     独立的路，理由与考试/通知那两张表一样：年级表不在时不该让整份快照作废）；
   *   · 本地演示模式 = `demoGrades()`（由 `classes.grade` 推出来的三个年级）。
   *
   * ⚠️ **只读**：这一轮没有任何写年级的入口（建年级 / 提档是 P3/P4 的活）。
   *    它的唯一用途是"开学准备"页要知道有哪些年级、以及它们的届（`cohort`）。
   */
  grades: GradeRow[]
  /**
   * 🆕 2026-09-30（P3）：**学年与学期那一份**（`academic_years` + `terms`，`schema.sql` §28）。
   *
   * 🔴 **它不是本地数据模型的一部分** —— 档案的 `term_id` 由 `remote` 在写库那一刻
   *    按日期推（`remote.termIdForDate`），这里这一份只服务**列表的筛选**：
   *    "当前学期"是推出来的（今天落在哪个学期区间里），列表默认只看它。
   *
   * 读不到的三种情形（本地模式 / §28 还没跑 / 网络）一律是空数组 + `current = null`，
   * 而 `current = null` 时列表**不筛**（宁可多看见，绝不静默藏档案，见 `lib/terms.ts`）。
   */
  terms: Term[]
  /** 推导出来的"当前学期"（`lib/terms.ts` 的 `currentTermId`）；认不出是 `null` */
  currentTermId: string | null
  currentClassId: string | null
  templates: AssignmentTemplate[]
  assignments: Assignment[]
  /* ---- S4 ---- */
  classrooms: ClassroomClient[]
  calls: CallRecord[]
  /* ---- 课表 ---- */
  schedule: ScheduleItem[]
  /* ---- 考试（见 功能设计与不变量.md §十四）---- */
  exams: Exam[]
  examScores: ExamScore[]
  /**
   * `exams` / `exam_scores` 两张表在不在线上库里。
   *
   * `'missing'` = 还没跑 `schema.sql` 第 15 段。这时：
   *   · 读：列表显示"还没有考试档案"（**不白屏**）
   *   · 写：**拒绝并说明**（不乐观更新 —— 那会变成"刷新即丢"）
   * 探测一次、本页缓存（见 `remote.ensureExamTables`）。
   */
  examTables: 'unknown' | 'present' | 'missing'

  /* ---- 🆕 通知（2026-09-28，见 功能设计与不变量.md I45–I50）---- */
  /**
   * `notices` / `notice_targets` 两张表在不在线上库里。
   *
   * `'missing'` = 还没跑 `schema.sql` 第 21 段。这时：
   *   · 读：通知页显示"还没有通知"（**不白屏**）
   *   · 写：**拒绝并说明**（服务端也会拒）
   * 探测一次、本页缓存（见 `lib/notices.ts` 的 `ensureNoticeTables`）。
   */
  noticesState: 'unknown' | 'present' | 'missing'
  /**
   * 我看得到的通知。**这是数据库 RLS 筛过的结果** ——
   * 前端**不再筛一遍**（M3 / §11.3）：教室端读不到、范围外的人读不到，都是数据库在拦。
   */
  notices: Notice[]
  /** 我能不能发通知（**摆不摆那个入口**；能不能发给某个范围由服务端判） */
  noticesCanPublish: boolean
  /** 「我能发给谁」的选项清单 —— 由数据库 `my_notice_scopes()` 算出来（不是前端拼的） */
  noticesScopes: NoticeScopeOption[]
  /** 我上次把通知看到哪儿的时刻（`teachers.notice_seen_at`，一行一个老师 —— I49） */
  noticesSeenAt: number | null

  /* ---- 🆕 全站公告（2026-09-28 公告轮，见 功能设计与不变量.md §二十四）----
   *
   * 🔴 **公告 ≠ 通知**：`notices*` 那一组是「学校对老师说话」（有收件范围），
   *    这一组是「**平台**对老师说话」（全站一条、没有范围、没有未读）。
   *    两者各自独立，**一个字都不共享**（两个数据模型、两个表、两个接口）。
   */
  /** `announcements` 那张表在不在线上库里（`'missing'` = §22 还没跑，横幅整条不出现） */
  announcementsState: 'unknown' | 'present' | 'missing'
  /** 我看得到的公告（**数据库 RLS 筛过的结果**：未撤下 + 在生效区间内 + 不是教室端） */
  announcements: Announcement[]
  /**
   * 超管在面板上点的「预览」那一条（**不落库**）。
   * ⚠️ 它存在 localStorage（`shugao.ann.preview`）**是刻意的**：超管在 `/admin` 点完
   *    "预览"，往往要**走到教师端**才看得到真实长相，而那是**换一次页面加载**。
   *    显示过一次就自动清掉（`clearAnnPreview`），所以不会长期挂在那里。
   */
  annPreview: Announcement | null
  /** 是否仍是初始演示数据（未做任何真实改动） */
  isDemo: boolean
  lastSeenAt: number
  streakDays: number
  /* ---- 后端 ---- */
  /** 已连后端时的登录用户 id；本地模式为 null */
  userId: string | null
  /** 首次数据就绪（本地模式立即为 true） */
  hydrated: boolean
  /** 最近一次同步失败的原因，非空时界面顶部会提示 */
  syncError: string | null
  /**
   * 这次登录的是**教师**还是**教室端账号**？
   *
   * 判据只有一个：`classroom_accounts` 里有没有 id = 自己 uid 的那一行。
   * 不能靠"有没有 teachers 行"来判断 —— `handle_new_user` 触发器会给每一个
   * auth 用户都建一行 teachers，教室端账号也有。
   * 本地演示模式恒为 'teacher'。
   */
  accountKind: 'teacher' | 'classroom'
  /**
   * 我的身份（`teacher_roles` 里属于我的行）。**多身份是常态**，所以是数组。
   *
   * 用途只有一个：决定界面上**摆不摆**那些入口（「教师账号」页 / 「指派身份」按钮）。
   * 它**不参与**任何数据行过滤 —— 谁能看到哪些行由数据库 RLS 收口
   * （见 `功能设计与不变量.md` §11.3、`lib/roles.ts` 的文件头）。
   * 读不到（表还没建 / 没登录）时是 `[]`，界面按"没指派身份"显示。
   */
  myRoles: TeacherRole[]

  hydrate: () => Promise<void>
  clearSyncError: () => void
  /**
   * 重新读一次「我的身份」。
   * 只在一种情况下需要：**刚给指到自己头上的身份做了改动**（比如超管给自己加了行政身份）——
   * 别人改了身份不影响我这次会话里已经拿到的 myRoles。
   */
  refreshMyRoles: () => Promise<void>
  /**
   * 🆕 2026-09-30（P3）：重新读一遍学年与学期（教导处刚改完日期时用）。
   * 判据不在这一层 —— 能不能**写**由服务端问数据库（`can_manage_terms()`）。
   */
  refreshTerms: () => Promise<void>

  /* ---- 🆕 通知（2026-09-28）---- */
  /**
   * 读通知 + "我能发哪些范围"。
   * ⚠️ **教室端根本到不了这条路**（`App.tsx` 的 `accountKind` 一支 + 数据库不给它任何行）。
   */
  hydrateNotices: () => Promise<void>
  /** 把"我上次看到哪儿"推到最新（未读归 0）。**不记录"谁读过哪一条"**（I49） */
  markNoticesSeen: () => Promise<void>
  publishNotice: (input: noticeApi.PublishInput) => Promise<{ ok: true } | { ok: false; message: string }>
  revokeNotice: (noticeId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  pinNotice: (
    noticeId: string,
    pinned: boolean,
  ) => Promise<{ ok: true } | { ok: false; message: string }>

  /* ---- 🆕 全站公告（2026-09-28）---- */
  /**
   * 读公告（横幅 + 弹窗的那一份数据）。**所有老师都读**（含班主任与任课教师），
   * 教室端拿到的是 0 行（数据库那条策略里没有它的分支）。
   */
  hydrateAnnouncements: () => Promise<void>
  /** 超管点「预览」：让某一条**在教师端真实的长相里**出现一次（不落库、不进 RLS） */
  previewAnnouncement: (a: Announcement | null) => void
  /** 预览显示过一次之后清掉（同时清 localStorage 里那一份） */
  clearAnnPreview: () => void

  signIn: (name: string) => void
  signOut: () => void
  /**
   * 改自己的姓名 / 学校 / 学科。
   * `subject` 是**显示标签**，`primarySubjectCode` 是**主学科**（新作业默认值），
   * 两者分开写、分开读 —— 见 `lib/subjects.ts`。
   */
  updateTeacher: (
    patch: Partial<Pick<Teacher, 'name' | 'school' | 'subject' | 'primarySubjectCode'>>,
  ) => void

  addClass: (input: { name: string; grade: string; year: string }) => string
  updateClass: (id: string, patch: Partial<Pick<Klass, 'name' | 'grade' | 'year'>>) => void
  removeClass: (id: string) => void
  setCurrentClass: (id: string | null) => void

  addStudents: (
    classId: string,
    rows: Pick<ImportRow, 'studentNo' | 'name'>[],
    mode: ImportMode,
  ) => { added: number; updated: number }

  updateStudent: (classId: string, studentId: string, patch: Partial<Student>) => void
  setStudentStatus: (classId: string, studentId: string, status: StudentStatus) => void
  removeStudent: (classId: string, studentId: string) => void
  transferStudent: (studentId: string, fromClassId: string, toClassId: string) => void
  /**
   * 🆕 2026-09-30「开学准备」（P6）：把这一页**算好的一批班与学生**整体换进 store。
   *
   * 🔴 为什么不是"一个一个 `addStudents()`"：
   *    开学准备的一条纪律是**一个事务**（要么全成、要么一行都不落）——
   *    逐个调用就是 N 次局部更新，中间任何一次失败都会留下"导了一半"的状态。
   *    这里进来的 `next` 已经是**算完整份**的班级数组（`applyRoster()` 的产物）。
   *
   * @param gradeName 只换这个年级里的班（别的年级一个字节都不动）
   * @param next      同一个年级的**完整**班级数组（含新班与更新后的名单）
   */
  replaceGradeRoster: (gradeName: string, next: Klass[]) => void
  /**
   * 🆕 2026-09-30：改一个班的班型（`classes.class_type`）。
   * 本地即时生效 + 后台落库（与 `updateClass` 同款的乐观更新）。
   */
  updateClassType: (classId: string, classType: ClassType) => void

  /* ---- S2 ---- */
  addAssignment: (input: {
    title: string
    classId: string
    assignDate: string
    questionCount: number
    templateId?: string
    /**
     * 学科代码（`lib/subjects.ts`）。**不传也行** —— 会按老师的主学科预选好，
     * 永远有值、永不弹窗（反指标：每次作业新增手工录入字段数 = 0）。
     */
    subjectCode?: string
    /** 统计模式：普通（逐题）或极简（只记优/良/差） */
    statsMode?: 'normal' | 'simple'
    /** 从 Word 稿识别出的结构，可直接带上 */
    subQuestions?: Record<string, number>
    questionMeta?: Record<string, QuestionMeta>
  }) => string
  updateAssignment: (id: string, patch: Partial<Assignment>) => void
  removeAssignment: (id: string) => void
  setCollection: (
    id: string,
    data: { missingNos?: string[]; lateNos?: string[]; collected?: boolean },
  ) => void
  saveTemplate: (t: Omit<AssignmentTemplate, 'id'>) => string
  /** S3：批改录入的整档保存 */
  setGrade: (
    id: string,
    data: {
      wrong?: Record<string, string[]>
      confirmedNos?: string[]
      subQuestions?: Record<string, number>
      status?: Assignment['status']
      gradeSeconds?: number
      /** 极简模式的等级 */
      grades?: Record<string, string>
      /** 需重点关注名单 */
      focusNos?: string[]
      /** 改错名单 / 已改错名单 */
      correctionNos?: string[]
      correctedNos?: string[]
      /** 显式覆盖未交名单（「确认完成批改」时把未批改的人登记为未交） */
      missingNos?: string[]
    },
  ) => void

  /* ---- S4 ---- */
  sendCall: (input: {
    assignmentId: string
    classId: string
    studentNos: string[]
    text: string
    room: string
  }) => CallRecord
  repeatCall: (callId: string) => void
  setCallState: (callId: string, studentNo: string, state: CallState) => void
  setClassroomOnline: (id: string, online: boolean) => void
  /** 只重读教室端设备状态（发呼叫前用），返回最新列表 */
  refreshClassrooms: () => Promise<ClassroomClient[]>
  /** 教室端首次打开时给自己登记一台设备（后端模式下没有种子数据，必须自建） */
  ensureClassroom: (classId: string, name: string) => void
  /* ---- 课表 ---- */
  addSchedule: (item: Omit<ScheduleItem, 'id'>) => string
  /** 批量加入（一次 upsert，别发 N 个请求） */
  addScheduleMany: (items: Omit<ScheduleItem, 'id'>[]) => number
  updateSchedule: (id: string, patch: Partial<ScheduleItem>) => void
  removeSchedule: (id: string) => void

  /* ---- 考试 ---- */
  /**
   * 读一次考试数据（表不在时静默为空 + 把 `examTables` 标成 'missing'）。
   * **不进 `hydrate()`**：那是"任一失败就整份快照作废"的那一组，
   * 线上库没跑第 15 段时混进去会让整个应用一起看不到数据。
   */
  hydrateExams: () => Promise<void>
  /**
   * 建一份考试档案。
   *
   * 学科与 `subject` 显示名的成对写入在这里（页面里不许单独写）——
   * 与 `addAssignment` 同一条不变量（§12.3 I13）。
   * 返回 `{ id, saved }`：`saved=false` 时是"表还没建"，界面要如实说，不能假装建好了。
   */
  addExam: (input: {
    title: string
    subjectCode?: string
    scope: Exam['scope']
    source: Exam['source']
    mode: Exam['mode']
    examDate: string
    questionCount: number
    questions: Exam['questions']
    classIds: string[]
    grade?: string
    absentNos?: string[]
    /** 从文件带进来的学生行（导入路径用） */
    rows?: ExamScore[]
  }) => Promise<{ id: string; saved: boolean; reason?: string }>
  updateExam: (id: string, patch: Partial<Exam>) => void
  /** 删档案（连带这个档案的成绩行） */
  removeExam: (id: string) => void
  /**
   * 写一个人的成绩行（**唯一的成绩写入口**）。
   *
   * 不变量 E1：`graded` 只由「确认批阅」「文件导入」这两条路置 true，
   * 点开学生/展开题号**不算**批阅（与作业 I1 同一条纪律）。
   */
  setExamScore: (
    examId: string,
    row: {
      studentNo: string
      classId: string
      name?: string
      scores?: Record<string, number>
      answers?: Record<string, string>
      graded?: boolean
      absent?: boolean
      total?: number
      objective?: number
      subjective?: number
      classRank?: number
      gradeRank?: number
    },
  ) => void
  /** 批量写（导入、确认完成时一次落库） */
  setExamScores: (examId: string, rows: ExamScore[]) => void
  /** 重新探一次考试表在不在（老师跑完 SQL 后不用刷新页面） */
  refreshExamTables: () => Promise<void>

  /**
   * 把整份 state 换成一份演示快照（**危险操作**）。
   *
   * ⚠️ 调用方只剩一个：`Workbench.tsx` 的「演示数据提示」横幅 ——
   *    那条横幅**只在 `isDemo === true` 时渲染**（看到的本来就是演示数据），所以够不到真实数据。
   *    远程模式这一支其实只是重新 `hydrate()`，不删云端任何东西。
   *
   * 🔴 `Settings.tsx`（我的）里原来那个**不看 `isDemo`、也没有二次确认**的
   *    「重置为演示数据」按钮已于 2026-09 按用户要求删除：本地模式下它会把老师
   *    真实录入的班级 / 名单 / 作业整份换掉，且不可撤销。
   *    **别再把它摆回设置页或其它无条件显示的地方**（见 功能设计与不变量.md）。
   */
  resetDemo: () => void
  /** 从备份文件恢复（覆盖当前数据，调用前必须让用户确认） */
  restoreBackup: (b: {
    teacher?: Teacher | null
    classes: Klass[]
    assignments: Assignment[]
    schedule: ScheduleItem[]
    calls: CallRecord[]
    classrooms: ClassroomClient[]
  }) => void
  clearAll: () => void
  touchStreak: () => void
}

/**
 * 给「转进来」的学生挑一个学号（W7）。
 *
 * 为什么不能原样搬：**学号即身份** —— 收缴（`missingNos`/`lateNos`）、
 * 批改（`confirmedNos`/`wrong`）、等级（`grades`）、改错名单全都以学号为键存在**班级的档案**上。
 * 一个孩子从 3 班转到 7 班、还叫 12 号，他在 7 班立刻"继承"了原来那个 12 号的全部成绩；
 * 更糟的是数据库 `students` 有 `unique (class_id, student_no)`，
 * 撞号会让整条 upsert 被拒 —— 云端模式下这才是**静默丢数据**。
 *
 * 规则：
 *  · 目标班这个号**空着**，而且**从来没有任何记录引用过** → 保留原号（教师看着最自然）；
 *  · 否则取「目标班出现过的最大号 + 1」。
 *    刻意**不复用空号**：空号多半是转走/转出的人留下的，复用就等于把他的记录接着往下记。
 *
 * 🔴 **P1（序列号键迁移）之后这条规则松了一半**（`schema.sql` §20 / Q6）：
 *    学生一旦有了**序列号**，那 10 个字段的键就**不再是学号**了 ——
 *    转班**不用换号**也不会继承任何东西（W33 从"策略问题"变成"结构上不可能"）。
 *    所以"这个号有没有被记录引用过"这件事**只在学生还没有序列号时**才需要看
 *    （= 线上库还没跑 §20，或者这一行还没生成序列号）。
 *    ⚠️ 但**目标班名单里已经有人用这个号**这一条**任何情况下都不能省**：
 *       `unique (class_id, student_no)` 是数据库的硬约束，撞了 = 整条 upsert 被拒。
 */
function pickTransferNo(
  s: Pick<State, 'classes' | 'assignments' | 'calls'>,
  target: Klass,
  want: string,
  /** 这个学生**已经有序列号**吗？有 → 档案键不再是学号，不用再避让历史记录 */
  keyedBySerial = false,
): string {
  const used = new Set<string>()
  const taken = new Set(target.students.map((st) => st.studentNo))
  if (!keyedBySerial) {
    for (const a of s.assignments) {
      if (a.classId !== target.id) continue
      for (const list of [
        a.missingNos,
        a.lateNos,
        a.confirmedNos,
        a.focusNos,
        a.correctionNos,
        a.correctedNos,
      ]) {
        for (const n of list ?? []) used.add(String(n))
      }
      for (const n of Object.keys(a.wrong ?? {})) used.add(n)
      for (const n of Object.keys(a.grades ?? {})) used.add(n)
    }
    // 呼叫记录也按学号存（"已叫/已到/已订正"），同样不能继承
    for (const c of s.calls ?? []) {
      if (c.classId !== target.id) continue
      for (const n of c.studentNos ?? []) used.add(String(n))
      for (const n of Object.keys(c.states ?? {})) used.add(n)
    }
  }

  const free = (n: string) => n !== '' && !taken.has(n) && !used.has(n)
  if (free(want)) return want

  let max = 0
  for (const n of [...taken, ...used]) {
    const v = Number(n)
    if (n !== '' && Number.isFinite(v) && v > max) max = Math.floor(v)
  }
  let candidate = String(max + 1)
  while (!free(candidate)) candidate = String(Number(candidate) + 1)
  return candidate
}

/* ============================================================
   🆕 年级表的**本地演示夹具**（2026-09-30「开学准备」）
   ------------------------------------------------------------
   🔴 为什么本地模式也要有它：`shots.mjs` 跑的是**本地演示模式**，而"年级管理"那一页
      的第一句话就是"有哪些年级"。没有这份夹具时这一页在截图里永远是空态 ——
      于是"名单 / 班型 / 选科那几步长什么样"**一句都断言不了**。
   ⚠️ 它是从 `classes.grade` **推**出来的（不硬编码三个年级）：
      演示数据里有哪些年级，这一页就有哪些 —— 加了演示班不会出现"年级对不上班"。
   ⚠️ `cohort` 按演示数据的口径写死（高一 2026 / 高二 2025 / 高三 2024，Q18 给过的那三个），
      推不出来就**留空串**（`grades.cohort` 的空串语义就是"还没填"）—— 不猜。
   ------------------------------------------------------------ */
const DEMO_COHORT: Record<string, string> = { 高一: '2026', 高二: '2025', 高三: '2024' }
const DEMO_STAGE: Record<string, number> = { 高一: 1, 高二: 2, 高三: 3 }

function demoGrades(classes?: readonly { grade: string }[]): GradeRow[] {
  const names = [...new Set((classes ?? []).map((c) => c.grade).filter(Boolean))]
  const out: GradeRow[] = names.map((name) => ({
    id: `demo-grade-${name}`,
    name,
    cohort: DEMO_COHORT[name] ?? '',
    stage: DEMO_STAGE[name] ?? 1,
    year: '',
  }))
  /*
   * 演示模式**至少**要有高一 / 高二 / 高三三行（就算演示班只挂在其中一个上）——
   * 否则"一个年级 7 个班"那张清单在截图里只剩一行，看不出"三个年级并存"这个目标形态。
   */
  for (const name of ['高一', '高二', '高三']) {
    if (!out.some((g) => g.name === name)) {
      out.push({
        id: `demo-grade-${name}`,
        name,
        cohort: DEMO_COHORT[name] ?? '',
        stage: DEMO_STAGE[name] ?? 1,
        year: '',
      })
    }
  }
  return out
}

function freshDemo() {
  const classes = makeDemoClasses()
  // 演示考试也来自 seed（结构与真实物理卷一致，见 seed.ts 的说明）
  const examDemo = makeDemoExams(classes)
  return {
    classes,
    grades: demoGrades(classes),
    currentClassId: classes[0]?.id ?? null,
    templates: makeTemplates(),
    assignments: makeDemoAssignments(classes),
    classrooms: makeClassrooms(classes),
    calls: [] as CallRecord[],
    schedule: makeDemoSchedule(classes),
    exams: examDemo.exams,
    examScores: examDemo.scores,
    isDemo: true,
  }
}

/* ============================================================
   🆕 全站公告的**本地演示夹具**（2026-09-28 公告轮）
   ------------------------------------------------------------
   🔴 **两条都是 `popup: 'never'`，这是刻意的，别顺手改成 `once` / `urgent`**：
      本地模式（`npm run dev` 没有 Supabase 变量）就是 `shots.mjs` 跑的那一套，
      而它有 90 多张截图 —— 一条会弹窗的公告会在**每一张图**上盖一个弹窗，
      整套截图立刻变成废物。
      "弹窗长什么样"由**超管面板的「预览」那个按钮**摆出来（那是真功能，
      参照项目也有 `adminPreviewAnnouncements()`），**不是靠夹具**。

   ⚠️ 为什么夹具放在**初始状态**里、而不是像通知那样放在 `hydrateNotices()` 里：
      `hydrate()` 在本地模式下**第一句就 return**（`if (!isRemote)`），
      所以"只有 hydrate 里才灌夹具"的那条路在本地模式**根本不会跑** ——
      也就是说 `hydrateNotices()` 的那两条夹具通知在实践中是**够不着的**
      （本轮实测发现的一处既有不一致，**没有顺手去改它**：那是通知那一轮的事）。
      公告这一轮不重复那个形状：夹具进 `initialState()` 这一侧。
   ============================================================ */
function demoAnnouncements(): Announcement[] {
  const now = Date.now()
  return [
    {
      id: 'demo-a1',
      title: '系统维护：今晚 23:00–23:30',
      body:
        '今晚 23:00–23:30 平台升级数据库，期间可能有一两次保存失败。' +
        '那个时间段请先不要录入成绩，等升级完成再继续。',
      level: 'important',
      popup: 'never',
      pin: true,
      activeFrom: null,
      activeTo: null,
      createdBy: 't-1',
      updatedBy: null,
      createdAt: now - 1800_000,
      updatedAt: now - 1800_000,
      revokedAt: null,
      emailSent: false,
      emailSentTs: null,
      emailCount: 0,
      emailFail: 0,
    },
    {
      id: 'demo-a2',
      title: '新功能：按学科看考试统计',
      body: '这次上线了「按学科看考试统计」，在「考试 → 统计」那一页右上角。用得不对的地方直接说。',
      level: 'normal',
      popup: 'never',
      pin: false,
      activeFrom: null,
      activeTo: null,
      createdBy: 't-1',
      updatedBy: null,
      createdAt: now - 7200_000,
      updatedAt: now - 7200_000,
      revokedAt: null,
      emailSent: false,
      emailSentTs: null,
      emailCount: 0,
      emailFail: 0,
    },
  ]
}

/** 连了后端就从空开始 —— 数据在服务器上，不能再撒演示数据 */
function initialState() {  if (!isRemote) return freshDemo()
  return {
    classes: [] as Klass[],
    /* 🆕 年级表：远程模式由 `hydrate()` 里那句 `loadGrades()` 灌进来（这里先给空的） */
    grades: [] as GradeRow[],
    currentClassId: null,
    templates: makeTemplates(),
    assignments: [] as Assignment[],
    classrooms: [] as ClassroomClient[],
    calls: [] as CallRecord[],
    schedule: [] as ScheduleItem[],
    exams: [] as Exam[],
    examScores: [] as ExamScore[],
    terms: [] as Term[],
    currentTermId: null,
    isDemo: false,
  }
}

/** 后端模式下不走 localStorage：数据以服务器为准，避免换账号后看到上一个人的缓存 */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      teacher: null,
      ...initialState(),
      lastSeenAt: 0,
      streakDays: 1,
      userId: null,
      hydrated: !isRemote,
      syncError: null,
      accountKind: 'teacher',
      myRoles: [],
      exams: [],
      examScores: [],
      terms: [],
      currentTermId: null,
      examTables: 'unknown',
      noticesState: 'unknown',
      notices: [],
      noticesCanPublish: false,
      noticesScopes: [],
      noticesSeenAt: null,
      announcementsState: isRemote ? 'unknown' : 'present',
      announcements: isRemote ? [] : demoAnnouncements(),
      /*
       * 🔴 预览快照**在 store 创建时就本机读一次**（`shugao.ann.preview`）——
       *    超管在 `/admin` 点完「预览」要走**一次页面加载**才到得了教师端，
       *    而 `hydrateAnnouncements()` 在本地模式下根本不会被调到
       *    （`hydrate()` 第一句就 return），所以不在这里读就永远读不到。
       */
      annPreview: annApi.readPreview(),

      /* ---------------- 后端 ---------------- */

      hydrate: async () => {
        /*
         * 🆕 2026-09-30：**年级表那一份**（`grades`）——本地演示模式也要有。
         * ⚠️ 顺序：这段必须在 `if (!isRemote)` 那一句**之前** ——
         *    本地模式第一句就 return，放在后面永远读不到
         *    （`demoAnnouncements` 踩过同一个坑，见它上面那段注释）。
         * ⚠️ `loadGrades()` 在没有后端时回 `missing`，所以本地模式要另给一份
         *    `demoGrades()`（由 `classes.grade` 推出来的三个年级）。
         */
        const g = await remote.loadGrades()
        set({ grades: g.state === 'present' && g.grades.length ? g.grades : demoGrades() })
        /*
         * 🆕 2026-09-30（P3）：学年与学期 —— 与年级表同一处、同一个理由
         * （列表要用它推"当前学期"）。**读不到就是空 + current = null**，
         * 而 current = null 时列表不按学期筛（`lib/terms.ts` 文件头 ②）。
         */
        const tm = await remote.loadTerms()
        set({ terms: tm.terms, currentTermId: tm.current })
        if (!isRemote) {
          set({ hydrated: true })
          return
        }
        const snap = await remote.loadSnapshot()
        if (!snap) {
          set({ hydrated: true })
          return
        }
        /*
         * 顺便判定这是教师还是教室端账号 —— 路由守卫靠它分流。
         * 教室端账号能看到的班级由数据库收口（visible_class_ids 里的
         * classroom_accounts 那一支），前端这里只负责"该送去哪个界面"。
         */
        const room = await remote.loadClassroomAccount()
        /*
         * 考试数据**单独读**（见 remote.loadExams 的注释：那两张表不进
         * `loadSnapshot` 的"任一失败就整份快照作废"那一组 —— 线上库还没跑
         * schema.sql 第 15 段时，混进去会让整个应用一起看不到数据）。
         * 失败/表不存在时它返回空包，这里照常 set，页面上是"还没有考试档案"。
         */
        const examBundle = await remote.loadExams()
        const examState = await remote.ensureExamTables()
        set({
          userId: snap.userId,
          teacher: snap.teacher,
          classes: snap.classes,
          assignments: snap.assignments,
          schedule: snap.schedule,
          classrooms: snap.classrooms,
          calls: snap.calls,
          exams: examBundle.exams,
          examScores: examBundle.scores,
          examTables: examState,
          // 上次选的那个班还在就沿用它，否则退回第一个
          currentClassId: readCurrentClass(snap.classes),
          isDemo: false,
          hydrated: true,
          accountKind: room ? 'classroom' : 'teacher',
          myRoles: snap.roles,
          lastSeenAt: Date.now(),
        })
        /*
         * 🆕 通知**单独读**（与考试同一套理由，见上面那段）：
         * 线上库还没跑 `schema.sql` 第 21 段时它返回空包，页面上是"还没有通知"，
         * 而**整个应用照常可用**。
         * ⚠️ 刻意**不**并进上面那个 `set({...})`：那样"通知读不到"就会和
         *    "快照读到了"混在同一帧里，读的人分不出是哪一个成功。
         */
        await get().hydrateNotices()
        /*
         * 🆕 公告也**单独读**（同一套理由）：线上库还没跑 `schema.sql` 第 22 段时
         * 它返回空包，页面上是"没有公告"（横幅整条不出现），而**整个应用照常可用**。
         * ⚠️ 它与通知是**两条独立的路**（`announcements` 表 / `/api/announcement`），
         *    一个读不到不影响另一个 —— 这是"公告 ≠ 通知"在代码里的样子。
         */
        await get().hydrateAnnouncements()
      },

      clearSyncError: () => set({ syncError: null }),

      refreshMyRoles: async () => {
        const id = get().userId
        if (!id) return
        set({ myRoles: await remote.loadMyRoles(id) })
      },

      refreshTerms: async () => {
        remote.clearTermsCache()
        const tm = await remote.loadTerms(true)
        set({ terms: tm.terms, currentTermId: tm.current })
      },

      /* ---- 🆕 通知（2026-09-28，见 功能设计与不变量.md I45–I50） ---- */

      hydrateNotices: async () => {
        /*
         * 本地演示模式：**没有服务端**，所以给两条夹具通知。
         * ⚠️ 这不是"假权限" —— `canPublish` / `scopes` 在演示模式下恒为空，
         *    所以 `?as=` 注入的身份在演示里**看不见**「发通知」那个入口
         *    （那一条由 `nav-checks.mjs` 的纯函数断言钉，不靠界面）。
         *    夹具只让"通知页长什么样"这件事在截图里看得见。
         */
        if (!isRemote) {
          const now = Date.now()
          set({
            noticesState: 'present',
            notices: [
              {
                id: 'demo-n1',
                title: '全体教师会（周三 16:30 · 报告厅）',
                body: '本周三下午 16:30 在报告厅开全体教师会，请各位老师提前安排好课务。会后各教研组留下开短会。',
                scopeKind: 'school',
                senderId: 't-1',
                createdAt: now - 3600_000,
                expiresAt: null,
                pinned: true,
                revokedAt: null,
                expired: false,
                mine: false,
                unread: true,
                targets: [{ kind: 'school' }],
              },
              {
                id: 'demo-n2',
                title: '高二物理集体备课改到周五',
                body: '本周集体备课时间调整到周五第 8 节，地点在物理实验室（一）。请带上本周的练习册统计。',
                scopeKind: 'grade_subject',
                senderId: 't-1',
                createdAt: now - 7200_000,
                expiresAt: null,
                pinned: false,
                revokedAt: null,
                expired: false,
                mine: false,
                unread: true,
                targets: [{ kind: 'grade_subject', gradeId: null, subjectCode: 'physics' }],
              },
            ],
            noticesCanPublish: false,
            noticesScopes: [],
            noticesSeenAt: null,
          })
          return
        }
        const bundle = await noticeApi.loadNotices()
        set({
          noticesState: bundle.state,
          notices: bundle.notices,
          noticesCanPublish: bundle.canPublish,
          noticesScopes: bundle.scopes,
          noticesSeenAt: bundle.seenAt,
        })
      },

      markNoticesSeen: async () => {
        if (!isRemote) {
          // 演示模式：只在内存里把未读抹掉（没有数据库可写）
          set((s) => ({
            notices: s.notices.map((n) => ({ ...n, unread: false })),
            noticesSeenAt: Date.now(),
          }))
          return
        }
        const at = Date.now()
        if (await noticeApi.markNoticesSeen(at)) {
          set((s) => ({
            notices: s.notices.map((n) => ({ ...n, unread: false })),
            noticesSeenAt: at,
          }))
        }
      },

      publishNotice: async (input) => {
        const res = await noticeApi.publishNotice(input)
        if (res.ok) await get().hydrateNotices()
        return res.ok ? { ok: true as const } : { ok: false as const, message: res.message }
      },

      revokeNotice: async (noticeId) => {
        const res = await noticeApi.revokeNotice(noticeId)
        if (res.ok) await get().hydrateNotices()
        return res.ok ? { ok: true as const } : { ok: false as const, message: res.message }
      },

      pinNotice: async (noticeId, pinned) => {
        const res = await noticeApi.pinNotice(noticeId, pinned)
        if (res.ok) await get().hydrateNotices()
        return res.ok ? { ok: true as const } : { ok: false as const, message: res.message }
      },

      /* ---- 🆕 全站公告（2026-09-28，见 功能设计与不变量.md §二十四）---- */

      hydrateAnnouncements: async () => {
        /*
         * 🔴 **本地演示模式**：没有服务端。夹具见上面的 `demoAnnouncements()`
         *    （那一段写清了"为什么两条都不弹窗"）。
         * ⚠️ 本地模式的初始状态里**已经**灌了同一份夹具（见 create 那一段）——
         *    这里再灌一次是**幂等**的：`hydrate()` 在本地模式下不会走到这条路，
         *    但"本地模式下刚登出再登入"之类的路会调它，那时读到的仍然该是那两条。
         */
        if (!isRemote) {
          set({
            announcementsState: 'present',
            announcements: demoAnnouncements(),
            annPreview: annApi.readPreview(),
          })
          return
        }
        const bundle = await annApi.loadAnnouncements()
        set({
          announcementsState: bundle.state,
          announcements: bundle.announcements,
          annPreview: annApi.readPreview(),
        })
      },

      previewAnnouncement: (a) => {
        annApi.writePreview(a)
        set({ annPreview: a })
      },

      clearAnnPreview: () => {
        annApi.writePreview(null)
        set({ annPreview: null })
      },

      signIn: (name) =>
        set((s) => ({
          teacher: {
            id: 't-1',
            name: name.trim() || '老师',
            // 本地演示模式：学科取字典兜底值，别再手写「物理」第二份
            subject: subjectName(DEFAULT_SUBJECT_CODE),
            primarySubjectCode: DEFAULT_SUBJECT_CODE,
            school: '树高中学',
          },
          lastSeenAt: Date.now(),
          streakDays: s.streakDays || 1,
        })),

      signOut: () => {
        set({
          teacher: null,
          userId: null,
          classes: [],
          currentClassId: null,
          assignments: [],
          classrooms: [],
          calls: [],
          schedule: [],
          // 考试数据跟着会话走：换账号后不能还留着上一个人的成绩
          exams: [],
          examScores: [],
          examTables: 'unknown',
          // 学年与学期也跟着会话走（它是**库里的**一份数据，不是本机设置）
          terms: [],
          currentTermId: null,
          // 通知也跟着会话走：换账号后不能还留着上一个人看得到的通知
          noticesState: 'unknown',
          notices: [],
          noticesCanPublish: false,
          noticesScopes: [],
          noticesSeenAt: null,
          // 公告同一条：换账号后不能还留着上一个人看得到的公告
          // ⚠️ `annPreview` 是**超管的预览快照**，它是本机的东西（localStorage），
          //    与"这个账号看得到什么"无关 —— 所以这里不清它（清不清由 `clearAnnPreview` 决定）
          announcementsState: 'unknown',
          announcements: [],
          hydrated: !isRemote,
          // 身份跟着会话走，别把上一个账号的类型留在内存里
          accountKind: 'teacher',
          myRoles: [],
        })
      },

      updateTeacher: (patch) => {
        const t = get().teacher
        if (!t) return
        const next = { ...t, ...patch }
        set({ teacher: next })
        // 本地模式下 saveTeacher 是空操作
        void remote.saveTeacher(next)
      },

      addClass: ({ name, grade, year }) => {
        const id = uid()
        const klass: Klass = { id, name, grade, year, createdAt: Date.now(), students: [] }
        set((s) => ({
          classes: [...s.classes, klass],
          currentClassId: s.currentClassId ?? id,
          isDemo: false,
        }))
        const tid = get().teacher?.id
        if (tid) void remote.saveClass(klass, tid)
        return id
      },

      updateClass: (id, patch) => {
        set((s) => ({
          classes: s.classes.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          isDemo: false,
        }))
        const k = get().classes.find((c) => c.id === id)
        const tid = get().teacher?.id
        if (k && tid) void remote.saveClass(k, tid)
      },

      removeClass: (id) => {
        set((s) => {
          const classes = s.classes.filter((c) => c.id !== id)
          /*
           * 删班要**照着云端的级联一起删**。
           *
           * 数据库里 `assignments / students / classrooms / calls` 都是
           * `class_id ... on delete cascade`，班级课表是 `on delete set null` ——
           * 云端模式删一个班，这个班的作业档案当天就一起没了。
           * 本地模式没有数据库帮忙：只删班级的话，那些档案会永远挂在「班级已删除」上，
           * 既打不开也删不掉（列表里还占着统计），只是攒垃圾。
           * 所以这里就地做一遍同样的清理，两种模式的结果保持一致。
           */
          const gone = new Set(
            s.assignments.filter((a) => a.classId === id).map((a) => a.id),
          )
          return {
            classes,
            currentClassId: s.currentClassId === id ? (classes[0]?.id ?? null) : s.currentClassId,
            assignments: s.assignments.filter((a) => a.classId !== id),
            // 呼叫挂在这两个键上（assignment_id + class_id），按档案和班级各清一遍
            calls: (s.calls ?? []).filter(
              (c) => c.classId !== id && !gone.has(c.assignmentId),
            ),
            classrooms: (s.classrooms ?? []).filter((c) => c.classId !== id),
            // 班级课表**不删**：云端是 set null（教师自己录的课不该因为删班就消失）
            schedule: (s.schedule ?? []).map((it) =>
              it.classId === id ? { ...it, classId: undefined } : it,
            ),
            isDemo: false,
          }
        })
        void remote.deleteClass(id)
      },

      setCurrentClass: (id) => {
        set({ currentClassId: id })
        // 后端模式不走 zustand 持久化，这里单独记一下，免得一刷新就回到第一个班
        try {
          localStorage.setItem(CURRENT_CLASS_KEY, id ?? '')
        } catch {
          /* 忽略 */
        }
      },

      addStudents: (classId, rows, mode) => {
        let added = 0
        let updated = 0
        const touched: Student[] = []
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) => {
            if (c.id !== classId) return c
            const base = mode === 'replace' ? [] : [...c.students]
            const byNo = new Map(base.map((st) => [st.studentNo, st]))
            for (const r of rows) {
              const no = String(r.studentNo).trim()
              const name = String(r.name).trim()
              if (!no && !name) continue
              const hit = byNo.get(no)
              if (hit) {
                if (hit.name !== name) {
                  hit.name = name
                  updated++
                  touched.push({ ...hit })
                }
                continue
              }
              const st: Student = withSerial(
                {
                  id: uid(),
                  studentNo: no || String(base.length + 1),
                  name,
                  status: 'active',
                  createdAt: Date.now(),
                },
                c,
                s.classes,
              )
              base.push(st)
              byNo.set(st.studentNo, st)
              touched.push(st)
              added++
            }
            base.sort(
              (a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name),
            )
            return { ...c, students: base }
          }),
        }))
        void remote.saveStudents(classId, touched)
        return { added, updated }
      },

      updateStudent: (classId, studentId, patch) => {
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) =>
            c.id === classId
              ? {
                  ...c,
                  students: c.students.map((st) => (st.id === studentId ? { ...st, ...patch } : st)),
                }
              : c,
          ),
        }))
        const st = get().classes.find((c) => c.id === classId)?.students.find((x) => x.id === studentId)
        if (st) void remote.saveStudent(st, classId)
      },

      setStudentStatus: (classId, studentId, status) =>
        get().updateStudent(classId, studentId, { status }),

      removeStudent: (classId, studentId) => {
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) =>
            c.id === classId
              ? { ...c, students: c.students.filter((st) => st.id !== studentId) }
              : c,
          ),
        }))
        void remote.deleteStudent(studentId)
      },

      transferStudent: (studentId, fromClassId, toClassId) => {
        if (fromClassId === toClassId) return
        const st = get()
        const from = st.classes.find((c) => c.id === fromClassId)
        const moved = from?.students.find((x) => x.id === studentId)
        const to = st.classes.find((c) => c.id === toClassId)
        if (!moved || !to) return
        /*
         * 学号要重新定（见 pickTransferNo）：原样搬过去就是**继承别人的记录**。
         * 目标班这个号空着、也从没被任何记录用过时才保留原号。
         * 🔴 P1 之后：学生**有序列号**时档案键不再是学号 → 只需要避开目标班已占用的号。
         */
        const no = pickTransferNo(st, to, moved.studentNo, !!moved.serial)
        const next: Student = no === moved.studentNo ? moved : { ...moved, studentNo: no }
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) => {
            if (c.id === fromClassId) {
              return { ...c, students: c.students.filter((x) => x.id !== studentId) }
            }
            if (c.id === toClassId) {
              // 插进去之后照样按学号排序，别让新来的挂在名单末尾
              return {
                ...c,
                students: [...c.students, next].sort(
                  (a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name),
                ),
              }
            }
            return c
          }),
        }))
        void remote.saveStudent(next, toClassId)
      },

      /* ---- 🆕 开学准备（P6）---- */

      replaceGradeRoster: (gradeName, next) => {
        /*
         * 🔴 **只换这个年级里的班**（`c.grade === gradeName`）：别的年级一个字节都不动。
         *    进来的 `next` 已经是"算完整份"的结果（`lib/gradeImport.ts` 的 `applyRoster()`）
         *    —— 所以这一处**不做任何合并逻辑**，全成或全空由调用方那一个事务决定。
         */
        set((s) => {
          const keep = s.classes.filter((c) => c.grade !== gradeName)
          const replaced = next.map((k) => ({ ...k, grade: k.grade || gradeName }))
          const classes = [...keep, ...replaced]
          return {
            isDemo: false,
            classes,
            currentClassId: classes.some((c) => c.id === s.currentClassId)
              ? s.currentClassId
              : (classes[0]?.id ?? null),
          }
        })
        /* 远程模式：服务端那一个 RPC 已经把班与学生写完了（见 `lib/gradeSetup.ts`），
           这里只是把**本地那一份**对齐 —— 不再逐个 upsert（那会变成第二条写入路径）。 */
      },

      updateClassType: (classId, classType) => {
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) => (c.id === classId ? { ...c, classType } : c)),
        }))
        const k = get().classes.find((c) => c.id === classId)
        const tid = get().teacher?.id
        if (k && tid) void remote.saveClass(k, tid)
      },

      /* ---- S2：作业档案 ---- */

      addAssignment: ({
        title,
        classId,
        assignDate,
        questionCount,
        templateId,
        subjectCode,
        subQuestions,
        questionMeta,
        statsMode,
      }) => {
        const id = uid()
        /*
         * 🔴 学科是**唯一写入入口**在这里（页面里不许写 `subject` / `subjectCode`）。
         *
         * 取值顺序：显式传参（新建页选中的 chip、「按上次新建」带过来的）→ 老师的主学科。
         * **永远有值**，所以这里既不会弹窗、也不会把学科变成必填项
         * （反指标：每次作业教师新增手工录入字段数 = 0）。
         *
         * `subject` 与 `subjectCode` 是同一次赋值的两个面：
         * `subject` 只是 code 的显示缓存，**不再**是"老师是谁教什么的"那个标签 ——
         * 以前它俩共用一个字段，老师在设置页改一下学科，之后新作业全变科，
         * 而 `class_subjects` 里的任课关系没变，两边从此不一致。
         */
        const code = asSubjectCode(subjectCode) ?? teacherPrimarySubjectCode(get().teacher)
        const item: Assignment = {
          id,
          title: title.trim() || '未命名作业',
          classId,
          subject: subjectName(code),
          subjectCode: code,
          assignDate,
          /*
           * 🔴 题量的**唯一守门人**就在这里（不变量 I8）。
           *
           * 数据库有 `check (question_count between 1 and 60)`，越界会让**整条 upsert 被拒**；
           * 而云端模式本地不做持久化 → 界面提示"已建立"，刷新之后连收缴、批改一起没。
           * 以前这里只有下界（`Math.max(1, …)`），靠"每个调用方自己记得夹 60"兜着 ——
           * 那种保证在新加一条写入路径的那天就失效（`lib/assignments.ts` 的
           * `clampQuestionCount` 是这一段的单一来源，`updateAssignment` 与
           * `restoreBackup` 也过它）。
           */
          questionCount: clampQuestionCount(questionCount),
          status: 'open',
          templateId,
          createdAt: Date.now(),
          collected: false,
          missingNos: [],
          lateNos: [],
          subQuestions: subQuestions ?? {},
          wrong: {},
          confirmedNos: [],
          questionMeta: questionMeta ?? {},
          statsMode: statsMode ?? 'normal',
          grades: {},
          focusNos: [],
        }
        set((s) => ({ isDemo: false, assignments: [item, ...s.assignments] }))
        const tid = get().teacher?.id
        if (tid) void remote.saveAssignment(item, tid)
        return id
      },

      updateAssignment: (id, patch) => {
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.map((a) => {
            if (a.id !== id) return a
            const next = { ...a, ...patch }
            /*
             * 学科不变量要在**所有**写入路径上守（不只 addAssignment）：
             * `subject` 永远是 `subjectCode` 的显示缓存。
             *  · 传了合法 code       → 显示名跟着 code 走
             *  · 只改了显示名        → 按名字反查 code（兼容期老写法）
             *  · 两个都认不出来      → 原样留着，绝不猜（猜错会写进不可逆的历史数据）
             */
            const code =
              asSubjectCode(next.subjectCode) ??
              subjectCodeOfName(next.subject) ??
              asSubjectCode(a.subjectCode)
            if (code) {
              next.subjectCode = code
              next.subject = subjectName(code)
            }
            /*
             * 题量在**这条路径上也要守**（I8）：`updateAssignment` 收的是 `Partial<Assignment>`，
             * 「补导入题目」正是走它写 `questionCount` 的 —— 上次那个"识别到 70 题"的洞
             * 就是从这里进来的。只在补丁真的带了这一列时才夹，免得无谓地改动别的档案。
             */
            if (patch.questionCount !== undefined) {
              next.questionCount = clampQuestionCount(next.questionCount)
            }
            return next
          }),
        }))
        const a = get().assignments.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (a && tid) void remote.saveAssignment(a, tid)
      },

      removeAssignment: (id) => {
        set((s) => ({ isDemo: false, assignments: s.assignments.filter((a) => a.id !== id) }))
        void remote.deleteAssignment(id)
      },

      setCollection: (id, data) => {
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.map((a) =>
            a.id === id
              ? {
                  ...a,
                  missingNos: data.missingNos ?? a.missingNos,
                  lateNos: data.lateNos ?? a.lateNos,
                  collected: data.collected ?? true,
                  status: a.status === 'open' ? 'collected' : a.status,
                }
              : a,
          ),
        }))
        const a = get().assignments.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (a && tid) void remote.saveAssignment(a, tid)
      },

      /*
       * 存练习册模板。
       *
       * `subjectCode` 决定这份模板属于哪一科：新建页按当前学科过滤显示。
       * 以前模板写死 `subject: '物理'`（而且与老师教什么无关，恒为物理），
       * 而 `makeTemplates()` 在**云端模式**也会被调用 → 语文老师一进来
       * 就看见 6 个物理练习册模板。
       */
      saveTemplate: ({ name, questionCount, subject, subjectCode, score }) => {
        const id = `t-${uid()}`
        const code = asSubjectCode(subjectCode) ?? teacherPrimarySubjectCode(get().teacher)
        set((s) => ({
          isDemo: false,
          templates: [
            ...s.templates,
            {
              id,
              name: name.trim(),
              questionCount,
              subject: subject.trim() || subjectName(code),
              subjectCode: code,
              score,
            },
          ],
        }))
        return id
      },

      setGrade: (id, data) => {
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.map((a) => {
            if (a.id !== id) return a
            /**
             * 批改过的人一律视为「已交」。
             * 有同学当天才交作业，教师会先批改再回头登记 ——
             * 批完还挂着"未交"的话，查人界面会显示成红的，自相矛盾。
             */
            const done = new Set(a.confirmedNos ?? [])
            for (const no of data.confirmedNos ?? []) done.add(no)
            /**
             * 「已改错」必须跟着改错名单一起收缩。
             * 只写名单不清理的话，一次"全选有错"把名单换掉就会留下孤儿记录，
             * 列表按钮会显示「2/1」这种"已改的比该改的还多"的数。
             * 名单是 `?? ` 继承来的，所以这里按**合并后**的名单过滤，谁写都能兜住。
             */
            const correctionNos = data.correctionNos ?? a.correctionNos ?? []
            return {
              ...a,
              wrong: data.wrong ?? a.wrong,
              confirmedNos: data.confirmedNos ?? a.confirmedNos,
              subQuestions: data.subQuestions ?? a.subQuestions,
              status: data.status ?? a.status,
              gradeSeconds: data.gradeSeconds ?? a.gradeSeconds,
              grades: data.grades ?? a.grades,
              focusNos: data.focusNos ?? a.focusNos,
              correctionNos,
              correctedNos: (data.correctedNos ?? a.correctedNos ?? []).filter((n) =>
                correctionNos.includes(n),
              ),
              missingNos: (data.missingNos ?? a.missingNos).filter((n) => !done.has(n)),
              lateNos: (a.lateNos ?? []).filter((n) => !done.has(n)),
              /*
               * ⚠️ `collected` 是**收缴登记**的标记（列表据此说"已交 36/36 · 全员交齐"），
               * 只有「收缴登记」和「确认完成批改」这两条真正点过全班的路才能置它。
               *
               * 以前这里还有一句 `|| Boolean(data.confirmedNos?.length)` ——
               * 只要临时保存时批了几个人，列表就宣称"全员交齐"（`missingNos` 还是空的），
               * 教师会以为收缴登记做过了。批改过的人算"已交"这件事，
               * 已经由上一行的 `missingNos.filter(!done)` 表达，不需要动 `collected`。
               *
               * `missingNos` 只有「确认完成批改」会传（未批改的人一律登记为未交），
               * 那一步确实把全班都定下来了，所以那一种情况可以置。
               */
              collected: a.collected || data.missingNos !== undefined,
              gradedAt:
                data.status === 'graded' || data.status === 'reviewed' ? Date.now() : a.gradedAt,
            }
          }),
        }))
        const a = get().assignments.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (a && tid) void remote.saveAssignment(a, tid)
      },

      /* ---- S4：呼叫 ---- */

      sendCall: ({ assignmentId, classId, studentNos, text, room }) => {
        const record: CallRecord = {
          id: uid(),
          assignmentId,
          classId,
          studentNos,
          text,
          room,
          sentAt: [Date.now()],
          states: Object.fromEntries(studentNos.map((n) => [n, 'called' as CallState])),
        }
        set((s) => ({ isDemo: false, calls: [record, ...s.calls] }))
        const tid = get().teacher?.id
        if (tid) void remote.saveCall(record, tid)
        /*
         * 广播归 store 管。
         *
         * 本地模式没有数据库推送，教室端**只能**靠这条广播收到呼叫；
         * 而发出呼叫的地方有四处（作业页、改错登记页、班级页自由播报、再播一遍），
         * 以前只有作业页那一处 emit —— 另外三条路教室里一声不响，
         * 教师还以为学生已经听见了。收在唯一的写入口上就不会再漏。
         */
        emit({ type: 'call', call: record })
        return record
      },

      repeatCall: (callId) => {
        set((s) => ({
          calls: s.calls.map((c) =>
            c.id === callId ? { ...c, sentAt: [...(c.sentAt ?? []), Date.now()] } : c,
          ),
        }))
        const c = get().calls.find((x) => x.id === callId)
        if (!c) return
        const tid = get().teacher?.id
        if (tid) void remote.saveCall(c, tid)
        /*
         * 「再播一遍」= 追加一个时间戳，也是一次**新的播报**：
         * 教室端按「id + 最后一次时间」去重，所以必须把改过的这条重新广播出去。
         * 后端模式下这条走 Realtime 的 UPDATE（见 lib/realtime.ts）。
         */
        emit({ type: 'call', call: c })
      },

      setCallState: (callId, studentNo, state) => {
        set((s) => ({
          calls: s.calls.map((c) =>
            c.id === callId ? { ...c, states: { ...c.states, [studentNo]: state } } : c,
          ),
        }))
        const c = get().calls.find((x) => x.id === callId)
        const tid = get().teacher?.id
        if (c && tid) void remote.saveCall(c, tid)
      },

      setClassroomOnline: (id, online) => {
        set((s) => ({
          classrooms: s.classrooms.map((c) =>
            c.id === id ? { ...c, online, lastSeenAt: Date.now() } : c,
          ),
        }))
        const c = get().classrooms.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (c && tid) void remote.saveClassroom(c, tid)
      },

      refreshClassrooms: async () => {
        const list = await remote.loadClassrooms()
        if (!list) return get().classrooms
        // 只镜像，**不回写** —— 否则和教室端的心跳互相触发，形成写入回环
        set({ classrooms: list })
        return list
      },

      ensureClassroom: (classId, name) => {
        if (get().classrooms.some((c) => c.classId === classId)) return
        const item: ClassroomClient = {
          id: uid(),
          classId,
          name,
          online: true,
          lastSeenAt: Date.now(),
        }
        set((s) => ({ classrooms: [...s.classrooms, item] }))
        const tid = get().teacher?.id
        if (tid) void remote.saveClassroom(item, tid)
      },

      /* ---- 考试（见 功能设计与不变量.md §十四） ---- */

      hydrateExams: async () => {
        const state = await remote.ensureExamTables()
        if (state === 'missing') {
          set({ examTables: 'missing', exams: [], examScores: [] })
          return
        }
        const bundle = await remote.loadExams()
        set({ examTables: state, exams: bundle.exams, examScores: bundle.scores })
      },

      refreshExamTables: async () => {
        /*
         * 探测结果是按页面缓存的（`remote.ensureExamTables`），
         * 老师跑完 SQL 后要点一下这个 → **先把缓存清掉**再重探。
         *
         * 🔴 这里原来说着"先清缓存"、其实**没有清**（`功能设计与不变量.md` §十 留档）：
         *    以前只有 `set({ examTables: 'unknown' })`，然后 `hydrateExams()`
         *    → `ensureExamTables()` → **命中同一个已经 resolve 的 Promise** →
         *    拿到的是上次那份"表不在"。全仓对 `examTablesProbe` 只有三处引用
         *    （定义 / 探测内部自清 / 没有别处），**没有任何外部清理入口**。
         *    后果：`Exams.tsx` 上那个「重试」按钮**是空操作** ——
         *    跑完 §15 必须**整页刷新**才生效，而界面看上去是"点过了、还是不行"。
         *
         *    这正是本面板要抓的那一族故障（"按钮看起来在动、其实什么都没做"），
         *    所以修法是**给探测缓存补上唯一的外部清理入口**（`remote.resetExamTablesProbe()`），
         *    而不是在页面里绕过它。
         */
        remote.resetExamTablesProbe()
        set({ examTables: 'unknown' })
        await get().hydrateExams()
      },

      addExam: async (input) => {
        const code = asSubjectCode(input.subjectCode) ?? teacherPrimarySubjectCode(get().teacher)
        const title = input.title.trim() || '未命名考试'
        const paperKey = normalizePaperName(title)
        /*
         * 班级考试：档案 id 由 (班级, 试卷键) 决定 → 同一场考试在两台设备上建也落到同一行。
         * 年级考试：老师可能一次勾好几个班，用**排序后的班级列表**一起进键 ——
         * 于是"同一位老师对同一场考试"只有一份档案，改一次两个班都更新。
         *
         * ⚠️ 另一位老师给自己班建的那一份是**另一行**（班级不同 → id 不同），
         *    这是刻意的：两边的数据各归各，靠 `paperKey` 在读取时合成年级排名
         *    （见 schema.sql §15.5）。这样谁也不会覆盖谁的分数。
         */
        const ids = [...new Set(input.classIds)].sort()
        const id = await stableUuid('exam', `${ids.join(',')}|${code}|${paperKey}`)
        const grade =
          input.grade ??
          get().classes.find((c) => c.id === ids[0])?.grade ??
          ''
        const exam: Exam = {
          id,
          title,
          paperKey,
          subjectCode: code,
          subject: subjectName(code),
          scope: input.scope,
          grade,
          source: input.source,
          mode: input.mode,
          examDate: input.examDate,
          questionCount: clampQuestionCount(input.questionCount),
          questions: input.questions ?? {},
          classIds: ids,
          absentNos: input.absentNos ?? [],
          status: 'grading',
          createdBy: get().teacher?.id ?? '',
          createdAt: Date.now(),
        }
        const incoming = input.rows ?? []
        const prev = get().exams.some((x) => x.id === id)
        set((s) => ({
          isDemo: false,
          exams: prev ? s.exams.map((x) => (x.id === id ? { ...exam, createdAt: x.createdAt } : x)) : [exam, ...s.exams],
          examScores: incoming.length
            ? [...s.examScores.filter((r) => r.examId !== id), ...incoming]
            : s.examScores,
        }))
        const tid = get().teacher?.id
        if (!tid) return { id, saved: true }
        const res = await remote.saveExam(exam, incoming, tid)
        if (!res.ok) set({ examTables: 'missing' })
        return { id, saved: res.ok, reason: res.reason }
      },

      updateExam: (id, patch) => {
        set((s) => ({
          isDemo: false,
          exams: s.exams.map((e) => {
            if (e.id !== id) return e
            const next = { ...e, ...patch }
            /*
             * 学科不变量在**所有**写入路径上守（不只 addExam，与 §12.3 I13 同一句纪律）：
             * `subject` 永远是 `subjectCode` 的显示缓存。
             *  · 传了合法 code → 显示名跟着 code 走
             *  · 只改了显示名   → 按名字反查 code（兼容期老写法）
             *  · 两个都认不出来 → 原样留着，**绝不猜**
             */
            const code =
              asSubjectCode(next.subjectCode) ??
              subjectCodeOfName(next.subject) ??
              asSubjectCode(e.subjectCode)
            if (code) {
              next.subjectCode = code
              next.subject = subjectName(code)
            }
            // 改了名字 → 试卷键跟着变（同场判定读 paperKey，不读 title）
            if (patch.title !== undefined) next.paperKey = normalizePaperName(next.title)
            return next
          }),
        }))
        const e = get().exams.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (e && tid) void remote.saveExam(e, [], tid)
      },

      removeExam: (id) => {
        set((s) => ({
          isDemo: false,
          exams: s.exams.filter((e) => e.id !== id),
          examScores: s.examScores.filter((r) => r.examId !== id),
        }))
        void remote.deleteExam(id)
      },

      setExamScore: (examId, row) => {
        const exam = get().exams.find((e) => e.id === examId)
        if (!exam) return
        const id = uuid()
        const prev = get().examScores.find(
          (r) => r.examId === examId && r.studentNo === row.studentNo,
        )
        const next: ExamScore = {
          id: prev?.id ?? id,
          examId,
          classId: row.classId,
          studentNo: row.studentNo,
          name: row.name ?? prev?.name ?? '',
          scores: row.scores ?? prev?.scores ?? {},
          answers: row.answers ?? prev?.answers ?? {},
          graded: row.graded ?? prev?.graded ?? false,
          absent: row.absent ?? prev?.absent ?? false,
          total: row.total ?? prev?.total,
          objective: row.objective ?? prev?.objective,
          subjective: row.subjective ?? prev?.subjective,
          classRank: row.classRank ?? prev?.classRank,
          gradeRank: row.gradeRank ?? prev?.gradeRank,
          createdAt: prev?.createdAt ?? Date.now(),
        }
        set((s) => ({
          isDemo: false,
          examScores: prev
            ? s.examScores.map((r) => (r.id === next.id ? next : r))
            : [...s.examScores, next],
        }))
        const tid = get().teacher?.id
        if (tid) void remote.saveExam(exam, [next], tid)
      },

      setExamScores: (examId, rows) => {
        if (!rows.length) return
        const exam = get().exams.find((e) => e.id === examId)
        if (!exam) return
        const byId = new Map(rows.map((r) => [r.id, r]))
        set((s) => ({
          isDemo: false,
          examScores: [...s.examScores.filter((r) => !byId.has(r.id)), ...rows],
        }))
        const tid = get().teacher?.id
        if (tid) void remote.saveExam(exam, rows, tid)
      },

      /* ---- 课表 ---- */

      addSchedule: (item) => {
        const id = uid()
        const full: ScheduleItem = { ...item, id }
        set((s) => ({ isDemo: false, schedule: [...s.schedule, full] }))
        const tid = get().teacher?.id
        if (tid) void remote.saveSchedule(full, tid)
        return id
      },

      addScheduleMany: (items) => {
        if (!items.length) return 0
        const full: ScheduleItem[] = items.map((it) => ({ ...it, id: uid() }))
        set((s) => ({ isDemo: false, schedule: [...s.schedule, ...full] }))
        const tid = get().teacher?.id
        if (tid) void remote.saveSchedules(full, tid)
        return full.length
      },

      updateSchedule: (id, patch) => {
        set((s) => ({
          isDemo: false,
          schedule: s.schedule.map((x) => (x.id === id ? { ...x, ...patch } : x)),
        }))
        const item = get().schedule.find((x) => x.id === id)
        const tid = get().teacher?.id
        if (item && tid) void remote.saveSchedule(item, tid)
      },

      removeSchedule: (id) => {
        set((s) => ({ isDemo: false, schedule: s.schedule.filter((x) => x.id !== id) }))
        void remote.deleteSchedule(id)
      },

      /*
       * 从备份恢复：**逐条过写入路径的归一化，不裸 set**。
       *
       * 为什么不能直接把 `b.assignments` 塞进 state：`restoreBackup` 也是一条**写入路径**，
       * 而"学科不变量要在所有写入路径上守"（§12.3 I13）。
       * 这里曾经漏过一次（`lib/backup.ts` 的 `normalizeAssignment` 不带 `subjectCode`），
       * 后果不报错但不可逆：恢复完再批改一次 → `saveAssignment` 把云端 `subject_code`
       * 写成 NULL；本地模式下老师的主学科也一起没了（化学竞赛老师新建作业默认成"物理"）。
       *
       * `validateBackup` 已经归一过一遍，这里再对齐一次是**第二道闸**：
       * 恢复是不可逆动作，且它现在/将来可能被别处调用（页面、脚本、测试），
       * 不能假设调用方都先跑过 `validateBackup`。
       *
       * 题量同理（I8）：`lib/backup.ts` 的 `normalizeAssignment` 会夹到 1–60，
       * 但备份是**外部文件**，结构补齐漏一处就是"整条 upsert 被拒、刷新即丢"。
       */
      restoreBackup: (b) => {
        const teacher = b.teacher ? alignTeacherPrimarySubject(b.teacher) : get().teacher
        set({
          teacher,
          classes: b.classes,
          currentClassId: b.classes[0]?.id ?? null,
          assignments: b.assignments.map((a) => ({
            ...alignAssignmentSubject(a),
            questionCount: clampQuestionCount(a.questionCount),
          })),
          schedule: b.schedule,
          calls: b.calls,
          classrooms: b.classrooms,
          isDemo: false,
        })
      },

      /**
       * 危险：本地模式下 `set({...freshDemo()})` = 丢掉当前全部数据。
       * 唯一的 UI 入口是 Workbench 的演示横幅（仅 `isDemo` 时可见）；
       * 设置页那个无条件显示的入口已删（见接口处的说明）。
       */
      resetDemo: () => {
        if (isRemote) {
          void get().hydrate()
          return
        }
        set({ ...freshDemo() })
      },

      clearAll: () => {
        const tid = get().teacher?.id
        if (isRemote && tid) void remote.purgeAll(tid)
        set({
          teacher: null,
          userId: null,
          classes: [],
          currentClassId: null,
          templates: isRemote ? [] : [],
          assignments: [],
          classrooms: [],
          calls: [],
          schedule: [],
          exams: [],
          examScores: [],
          examTables: 'unknown',
          noticesState: 'unknown',
          notices: [],
          noticesCanPublish: false,
          noticesScopes: [],
          noticesSeenAt: null,
          announcementsState: 'unknown',
          announcements: [],
          isDemo: false,
          streakDays: 1,
          hydrated: !isRemote,
          myRoles: [],
        })
      },

      touchStreak: () =>
        set((s) => {
          const day = 86400000
          if (!s.lastSeenAt) return { lastSeenAt: Date.now(), streakDays: 1 }
          const gap = Date.now() - s.lastSeenAt
          if (gap > day * 1.5) return { lastSeenAt: Date.now(), streakDays: 1 }
          return { lastSeenAt: Date.now() }
        }),
    }),
    {
      name: 'shugao.teacher.v1',
      version: 1,
      // 后端模式不落 localStorage：数据以服务器为准
      storage: createJSONStorage(() => (isRemote ? noopStorage : localStorage)),
      partialize: (s) =>
        ({
          teacher: s.teacher,
          classes: s.classes,
          currentClassId: s.currentClassId,
          templates: s.templates,
          assignments: s.assignments,
          classrooms: s.classrooms,
          calls: s.calls,
          schedule: s.schedule,
          exams: s.exams,
          examScores: s.examScores,
          isDemo: s.isDemo,
          lastSeenAt: s.lastSeenAt,
          streakDays: s.streakDays,
        }) as unknown as State,
    },
  ),
)

/* ---------------- 教室端心跳（本地模式） ---------------- */

/*
 * 本地模式下两个标签页各有各的 store：教室端每 4 秒广播一次心跳，
 * 教师端收到后必须**把 lastSeenAt 也刷新掉** —— 只把 online 从 false 翻成 true 是不够的。
 * 在线判定读的是 `now - lastSeenAt > OFFLINE_AFTER_MS(12s)`：
 * 心跳不刷时间戳，刚被翻成"在线"的教室端 12 秒后又被判离线，
 * 于是 4 秒一次的心跳反而让状态每 16 秒抖一次（教师端一会儿在线一会儿离线，
 * 呼叫前的"教室端在线吗"提示跟着乱跳）。
 *
 * 后端模式不走这里：那时心跳是写库 + Realtime，写回环由 useClassroomPresence 挡住。
 */
if (!isRemote) {
  subscribe((m) => {
    if (m.type !== 'heartbeat') return
    const st = useStore.getState()
    const c = st.classrooms.find((x) => x.id === m.classroomId)
    if (!c) return
    // 同一条心跳不必反复改 state（每次改都会让订阅了 classrooms 的页面重渲染，也写一次本地存档）
    if (c.online && Date.now() - c.lastSeenAt < HEARTBEAT_MS / 2) return
    st.setClassroomOnline(m.classroomId, true)
  })
}

/* ---------------- 同步失败提示 ---------------- */

remote.setSyncErrorHandler((where, detail) => {
  useStore.setState({ syncError: `${where}失败：${detail ?? '未知错误'}` })
})

/* ---------------- 派生选择器 ---------------- */

export const activeStudents = (k: Klass | undefined): Student[] =>
  (k?.students ?? []).filter((s) => s.status === 'active')

export const className = (classes: Klass[], id: string | null): string =>
  classes.find((c) => c.id === id)?.name ?? '未选择班级'

/* ---------------- 轻量 Toast ---------------- */

export type Toast = {
  id: string
  text: string
  tone: 'ok' | 'warn' | 'bad' | 'info'
  desc?: string
}

type ToastState = {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: string) => void
}

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = uid()
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 2600)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))
