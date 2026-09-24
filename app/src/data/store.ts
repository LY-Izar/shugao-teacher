import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { isRemote } from '../lib/supabase'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import * as remote from './remote'
import { makeClassrooms, makeDemoAssignments, makeDemoClasses, makeDemoSchedule, makeTemplates } from './seed'
import type {
  Assignment,
  AssignmentTemplate,
  CallRecord,
  CallState,
  ClassroomClient,
  ImportRow,
  Klass,
  QuestionMeta,
  ScheduleItem,
  Student,
  StudentStatus,
  Teacher,
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
  currentClassId: string | null
  templates: AssignmentTemplate[]
  assignments: Assignment[]
  /* ---- S4 ---- */
  classrooms: ClassroomClient[]
  calls: CallRecord[]
  /* ---- 课表 ---- */
  schedule: ScheduleItem[]
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

  hydrate: () => Promise<void>
  clearSyncError: () => void

  signIn: (name: string) => void
  signOut: () => void
  /** 改自己的姓名 / 学校 / 学科 */
  updateTeacher: (patch: Partial<Pick<Teacher, 'name' | 'school' | 'subject'>>) => void

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

  /* ---- S2 ---- */
  addAssignment: (input: {
    title: string
    classId: string
    assignDate: string
    questionCount: number
    templateId?: string
    subject?: string
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
 */
function pickTransferNo(
  s: Pick<State, 'classes' | 'assignments' | 'calls'>,
  target: Klass,
  want: string,
): string {
  const used = new Set<string>()
  const taken = new Set(target.students.map((st) => st.studentNo))
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

function freshDemo() {
  const classes = makeDemoClasses()
  return {
    classes,
    currentClassId: classes[0]?.id ?? null,
    templates: makeTemplates(),
    assignments: makeDemoAssignments(classes),
    classrooms: makeClassrooms(classes),
    calls: [] as CallRecord[],
    schedule: makeDemoSchedule(classes),
    isDemo: true,
  }
}

/** 连了后端就从空开始 —— 数据在服务器上，不能再撒演示数据 */
function initialState() {
  if (!isRemote) return freshDemo()
  return {
    classes: [] as Klass[],
    currentClassId: null,
    templates: makeTemplates(),
    assignments: [] as Assignment[],
    classrooms: [] as ClassroomClient[],
    calls: [] as CallRecord[],
    schedule: [] as ScheduleItem[],
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

      /* ---------------- 后端 ---------------- */

      hydrate: async () => {
        if (!isRemote) {
          set({ hydrated: true })
          return
        }
        const snap = await remote.loadSnapshot()
        if (!snap) {
          set({ hydrated: true })
          return
        }
        set({
          userId: snap.userId,
          teacher: snap.teacher,
          classes: snap.classes,
          assignments: snap.assignments,
          schedule: snap.schedule,
          classrooms: snap.classrooms,
          calls: snap.calls,
          // 上次选的那个班还在就沿用它，否则退回第一个
          currentClassId: readCurrentClass(snap.classes),
          isDemo: false,
          hydrated: true,
          lastSeenAt: Date.now(),
        })
      },

      clearSyncError: () => set({ syncError: null }),

      signIn: (name) =>
        set((s) => ({
          teacher: {
            id: 't-1',
            name: name.trim() || '物理老师',
            subject: '物理',
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
          hydrated: !isRemote,
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
              const st: Student = {
                id: uid(),
                studentNo: no || String(base.length + 1),
                name,
                status: 'active',
                createdAt: Date.now(),
              }
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
         */
        const no = pickTransferNo(st, to, moved.studentNo)
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

      /* ---- S2：作业档案 ---- */

      addAssignment: ({
        title,
        classId,
        assignDate,
        questionCount,
        templateId,
        subject,
        subQuestions,
        questionMeta,
        statsMode,
      }) => {
        const id = uid()
        const item: Assignment = {
          id,
          title: title.trim() || '未命名作业',
          classId,
          subject: subject ?? get().teacher?.subject ?? '物理',
          assignDate,
          questionCount: Math.max(1, Number(questionCount) || 1),
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
          assignments: s.assignments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
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

      saveTemplate: ({ name, questionCount, subject, score }) => {
        const id = `t-${uid()}`
        set((s) => ({
          isDemo: false,
          templates: [...s.templates, { id, name: name.trim(), questionCount, subject, score }],
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

      restoreBackup: (b) => {
        set({
          teacher: b.teacher ?? get().teacher,
          classes: b.classes,
          currentClassId: b.classes[0]?.id ?? null,
          assignments: b.assignments,
          schedule: b.schedule,
          calls: b.calls,
          classrooms: b.classrooms,
          isDemo: false,
        })
      },

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
          isDemo: false,
          streakDays: 1,
          hydrated: !isRemote,
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
