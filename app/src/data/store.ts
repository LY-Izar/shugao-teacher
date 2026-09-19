import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { makeClassrooms, makeDemoAssignments, makeDemoClasses, makeDemoSchedule, makeTemplates } from './seed'
import type {
  Assignment,
  AssignmentTemplate,
  CallRecord,
  CallState,
  ClassroomClient,
  ImportRow,
  Klass,
  ScheduleItem,
  Student,
  StudentStatus,
  Teacher,
} from './types'

const uid = () => Math.random().toString(36).slice(2, 10)

export type ImportMode = 'merge' | 'replace' | 'append'

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

  signIn: (name: string) => void
  signOut: () => void

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
  }) => string
  updateAssignment: (id: string, patch: Partial<Assignment>) => void
  removeAssignment: (id: string) => void
  setCollection: (
    id: string,
    data: { missingNos?: string[]; lateNos?: string[]; collected?: boolean },
  ) => void
  saveTemplate: (t: Omit<AssignmentTemplate, 'id'>) => string
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
  /* ---- 课表 ---- */
  addSchedule: (item: Omit<ScheduleItem, 'id'>) => string
  updateSchedule: (id: string, patch: Partial<ScheduleItem>) => void
  removeSchedule: (id: string) => void
  /** S3：批改录入的整档保存 */
  setGrade: (
    id: string,
    data: {
      wrong?: Record<string, string[]>
      confirmedNos?: string[]
      subQuestions?: Record<string, number>
      status?: Assignment['status']
      gradeSeconds?: number
    },
  ) => void

  resetDemo: () => void
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

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      teacher: null,
      ...freshDemo(),
      lastSeenAt: 0,
      streakDays: 1,

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

      signOut: () => set({ teacher: null }),

      addClass: ({ name, grade, year }) => {
        const id = `c-${uid()}`
        set((s) => ({
          classes: [...s.classes, { id, name, grade, year, createdAt: Date.now(), students: [] }],
          currentClassId: s.currentClassId ?? id,
          isDemo: false,
        }))
        return id
      },

      updateClass: (id, patch) =>
        set((s) => ({
          classes: s.classes.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          isDemo: false,
        })),

      removeClass: (id) =>
        set((s) => {
          const classes = s.classes.filter((c) => c.id !== id)
          return {
            classes,
            currentClassId: s.currentClassId === id ? (classes[0]?.id ?? null) : s.currentClassId,
            isDemo: false,
          }
        }),

      setCurrentClass: (id) => set({ currentClassId: id }),

      addStudents: (classId, rows, mode) => {
        let added = 0
        let updated = 0
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
                }
                continue
              }
              const st: Student = {
                id: `s-${uid()}`,
                studentNo: no || String(base.length + 1),
                name,
                status: 'active',
                createdAt: Date.now(),
              }
              base.push(st)
              byNo.set(st.studentNo, st)
              added++
            }
            base.sort((a, b) => Number(a.studentNo) - Number(b.studentNo) || a.name.localeCompare(b.name))
            return { ...c, students: base }
          }),
        }))
        return { added, updated }
      },

      updateStudent: (classId, studentId, patch) =>
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
        })),

      setStudentStatus: (classId, studentId, status) =>
        get().updateStudent(classId, studentId, { status }),

      removeStudent: (classId, studentId) =>
        set((s) => ({
          isDemo: false,
          classes: s.classes.map((c) =>
            c.id === classId
              ? { ...c, students: c.students.filter((st) => st.id !== studentId) }
              : c,
          ),
        })),

      transferStudent: (studentId, fromClassId, toClassId) =>
        set((s) => {
          const from = s.classes.find((c) => c.id === fromClassId)
          const moved = from?.students.find((st) => st.id === studentId)
          if (!moved || fromClassId === toClassId) return {}
          return {
            isDemo: false,
            classes: s.classes.map((c) => {
              if (c.id === fromClassId) {
                return { ...c, students: c.students.filter((st) => st.id !== studentId) }
              }
              if (c.id === toClassId) {
                return { ...c, students: [...c.students, moved] }
              }
              return c
            }),
          }
        }),

      /* ---- S2：作业档案 ---- */

      addAssignment: ({ title, classId, assignDate, questionCount, templateId, subject }) => {
        const id = `a-${uid()}`
        set((s) => ({
          isDemo: false,
          assignments: [
            {
              id,
              title: title.trim() || '未命名作业',
              classId,
              subject: subject ?? s.teacher?.subject ?? '物理',
              assignDate,
              questionCount: Math.max(1, Number(questionCount) || 1),
              status: 'open',
              templateId,
              createdAt: Date.now(),
              collected: false,
              missingNos: [],
              lateNos: [],
              subQuestions: {},
              wrong: {},
              confirmedNos: [],
            },
            ...s.assignments,
          ],
        }))
        return id
      },

      updateAssignment: (id, patch) =>
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),

      removeAssignment: (id) =>
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.filter((a) => a.id !== id),
        })),

      setCollection: (id, data) =>
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
        })),

      saveTemplate: ({ name, questionCount, subject, score }) => {
        const id = `t-${uid()}`
        set((s) => ({
          isDemo: false,
          templates: [...s.templates, { id, name: name.trim(), questionCount, subject, score }],
        }))
        return id
      },

      setGrade: (id, data) =>
        set((s) => ({
          isDemo: false,
          assignments: s.assignments.map((a) =>
            a.id === id
              ? {
                  ...a,
                  wrong: data.wrong ?? a.wrong,
                  confirmedNos: data.confirmedNos ?? a.confirmedNos,
                  subQuestions: data.subQuestions ?? a.subQuestions,
                  status: data.status ?? a.status,
                  gradeSeconds: data.gradeSeconds ?? a.gradeSeconds,
                  gradedAt:
                    data.status === 'graded' || data.status === 'reviewed'
                      ? Date.now()
                      : a.gradedAt,
                }
              : a,
          ),
        })),

      /* ---- S4：呼叫 ---- */

      sendCall: ({ assignmentId, classId, studentNos, text, room }) => {
        const record: CallRecord = {
          id: `call-${uid()}`,
          assignmentId,
          classId,
          studentNos,
          text,
          room,
          sentAt: [Date.now()],
          states: Object.fromEntries(studentNos.map((n) => [n, 'called' as CallState])),
        }
        set((s) => ({ isDemo: false, calls: [record, ...s.calls] }))
        return record
      },

      repeatCall: (callId) =>
        set((s) => ({
          calls: s.calls.map((c) =>
            c.id === callId ? { ...c, sentAt: [...c.sentAt, Date.now()] } : c,
          ),
        })),

      setCallState: (callId, studentNo, state) =>
        set((s) => ({
          calls: s.calls.map((c) =>
            c.id === callId ? { ...c, states: { ...c.states, [studentNo]: state } } : c,
          ),
        })),

      setClassroomOnline: (id, online) =>
        set((s) => ({
          classrooms: s.classrooms.map((c) =>
            c.id === id ? { ...c, online, lastSeenAt: Date.now() } : c,
          ),
        })),

      /* ---- 课表 ---- */

      addSchedule: (item) => {
        const id = `sch-${uid()}`
        set((s) => ({ isDemo: false, schedule: [...s.schedule, { ...item, id }] }))
        return id
      },

      updateSchedule: (id, patch) =>
        set((s) => ({
          isDemo: false,
          schedule: s.schedule.map((x) => (x.id === id ? { ...x, ...patch } : x)),
        })),

      removeSchedule: (id) =>
        set((s) => ({ isDemo: false, schedule: s.schedule.filter((x) => x.id !== id) })),

      resetDemo: () => set({ ...freshDemo() }),

      clearAll: () =>
        set({
          teacher: null,
          classes: [],
          currentClassId: null,
          templates: [],
          assignments: [],
          classrooms: [],
          calls: [],
          schedule: [],
          isDemo: false,
          streakDays: 1,
        }),

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
    },
  ),
)

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
