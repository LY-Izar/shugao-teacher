import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { isRemote } from '../lib/supabase'
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
          return {
            classes,
            currentClassId: s.currentClassId === id ? (classes[0]?.id ?? null) : s.currentClassId,
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
        const from = get().classes.find((c) => c.id === fromClassId)
        const moved = from?.students.find((st) => st.id === studentId)
        if (!moved || fromClassId === toClassId) return
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) => {
            if (c.id === fromClassId) {
              return { ...c, students: c.students.filter((st) => st.id !== studentId) }
            }
            if (c.id === toClassId) return { ...c, students: [...c.students, moved] }
            return c
          }),
        }))
        void remote.saveStudent(moved, toClassId)
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
            return {
              ...a,
              wrong: data.wrong ?? a.wrong,
              confirmedNos: data.confirmedNos ?? a.confirmedNos,
              subQuestions: data.subQuestions ?? a.subQuestions,
              status: data.status ?? a.status,
              gradeSeconds: data.gradeSeconds ?? a.gradeSeconds,
              grades: data.grades ?? a.grades,
              focusNos: data.focusNos ?? a.focusNos,
              correctionNos: data.correctionNos ?? a.correctionNos,
              correctedNos: data.correctedNos ?? a.correctedNos,
              missingNos: (data.missingNos ?? a.missingNos).filter((n) => !done.has(n)),
              lateNos: (a.lateNos ?? []).filter((n) => !done.has(n)),
              // 已经有人在批 = 收缴这一步事实上过去了
              collected: a.collected || Boolean(data.confirmedNos?.length) || Boolean(data.missingNos),
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
        return record
      },

      repeatCall: (callId) => {
        set((s) => ({
          calls: s.calls.map((c) =>
            c.id === callId ? { ...c, sentAt: [...c.sentAt, Date.now()] } : c,
          ),
        }))
        const c = get().calls.find((x) => x.id === callId)
        const tid = get().teacher?.id
        if (c && tid) void remote.saveCall(c, tid)
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
