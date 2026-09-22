export type StudentStatus = 'active' | 'left'

export type Student = {
  id: string
  /** 班内学号，唯一 */
  studentNo: string
  name: string
  status: StudentStatus
  note?: string
  createdAt: number
}

export type Klass = {
  id: string
  name: string
  grade: string
  year: string
  createdAt: number
  students: Student[]
}

export type Teacher = {
  id: string
  name: string
  subject: string
  school: string
}

/** 导入校对表的行 —— 校验标记决定用户是否需要人工确认 */
export type ImportFlag = 'dup-no' | 'dup-name' | 'gap' | 'bad' | null

export type ImportRow = {
  key: string
  studentNo: string
  name: string
  flag: ImportFlag
  /** 覆盖掉原有学生时标记 */
  existing?: boolean
}

export type Roster = {
  id: string
  classId: string
  name: string
  subject: string
  createdAt: number
  students: Student[]
}

/* ---------------- S2：作业档案与收作业 ---------------- */

/**
 * 练习册模板：题号结构来自一次性建立的模板，不依赖任何图像识别。
 * 例：作业21 = 第 1~6 题。
 */
export type AssignmentTemplate = {
  id: string
  name: string
  questionCount: number
  subject: string
  /** 分值，仅作展示 */
  score?: number
}

export type AssignmentStatus = 'open' | 'collected' | 'graded' | 'reviewed' | 'archived'

/* ---- 题目结构（从练习册 Word 稿识别而来，教师可改） ---- */

export type QuestionKind = 'single' | 'multiple' | 'blank' | 'calc' | 'experiment' | 'other'

export const KIND_TEXT: Record<QuestionKind, string> = {
  single: '单选',
  multiple: '多选',
  blank: '填空',
  calc: '计算',
  experiment: '实验',
  other: '待定',
}

export const KIND_ORDER: QuestionKind[] = [
  'single',
  'multiple',
  'blank',
  'calc',
  'experiment',
  'other',
]

export type QuestionMeta = {
  kind: QuestionKind
  /** 分值；稿子里没写就没有 */
  score?: number
  /** 小问数，>1 才存 */
  subCount?: number
  /** 选项数，选择题用 */
  optionCount?: number
  /** 难度星数 */
  stars?: number
  /** 题干摘要，用于核对 */
  stem?: string
  /** 知识点 id（见 lib/knowledge.ts），导入时按关键词自动打标 */
  points?: string[]
  /** 题目配图（data URL）—— 生成「错题重练」文档要用 */
  imgs?: string[]
}

export type Assignment = {
  id: string
  title: string
  classId: string
  subject: string
  /** 布置日期 YYYY-MM-DD，默认前一天 */
  assignDate: string
  questionCount: number
  status: AssignmentStatus
  templateId?: string
  createdAt: number
  /**
   * 收缴采用「只记例外」：默认全班已交，只存未交与迟交的学号。
   * collected 表示是否已经登记过一次。
   */
  collected: boolean
  missingNos: string[]
  lateNos: string[]

  /* ---- S3：批改录入 ---- */

  /**
   * 小题结构：题号 → 小题数。只需在批改第一份时设置一次，自动同步整个档案。
   * 例：{ "3": 2 } 表示第 3 题拆成 (1)(2)。
   */
  subQuestions: Record<string, number>
  /**
   * 题目结构：题号 → 题型/分值/小问数/难度。来自练习册 Word 稿的识别结果，
   * 教师可以在建档时改。用于讲评时标注题型、以及后续按题型自动判分。
   */
  questionMeta?: Record<string, QuestionMeta>
  /**
   * 错题记录，同样「只记例外」——默认全对，只存错的。
   * 键为学号，值为错题键数组：无小题是 "3"，有小题是 "3.1"。
   */
  wrong: Record<string, string[]>
  /** 已展开过题号列表的学生学号（区分「确实对」与「根本没看」） */
  confirmedNos: string[]
  /** 本次批改耗时（秒），完成批改时写入 */
  gradeSeconds?: number
  gradedAt?: number

  /* ---- 统计模式与重点关注 ---- */

  /**
   * 统计模式：
   *  · 'normal'（默认）逐题记录，能出错题统计与知识点分析
   *  · 'simple' 只记每个学生优 / 良 / 差，**没有逐题数据**
   */
  statsMode?: 'simple' | 'normal'
  /**
   * 本次作业的「需重点关注」学号。
   * **与「改错名单」是两回事**：改错名单是"错了要改的人"，
   * 重点关注是教师批改时觉得这孩子不对劲、单独标的（哪怕他全对）。
   */
  focusNos?: string[]
  /** 极简模式的等级：学号 → 优 / 良 / 差 */
  grades?: Record<string, string>
}

/** 错题键：无小题为 "3"，有小题为 "3.1" */
export const qKey = (seq: number, sub?: number) => (sub ? `${seq}.${sub}` : String(seq))

export const parseQKey = (k: string): { seq: number; sub?: number } => {
  const [a, b] = k.split('.')
  return b ? { seq: Number(a), sub: Number(b) } : { seq: Number(a) }
}

export const STATUS_TEXT: Record<AssignmentStatus, string> = {
  open: '待收缴',
  collected: '待批改',
  graded: '已批改',
  reviewed: '已讲评',
  archived: '已归档',
}

/* ---------------- S4：教室端与呼叫 ---------------- */

/** 教室端一体机。心跳决定播报是否真的被听到。 */
export type ClassroomClient = {
  id: string
  classId: string
  /** 设备名，如「高二(3)班 一体机」 */
  name: string
  online: boolean
  lastSeenAt: number
}

/** 呼叫后学生状态：已叫 → 已到 → 已订正 */
export type CallState = 'called' | 'arrived' | 'corrected'

export type CallRecord = {
  id: string
  assignmentId: string
  classId: string
  /** 被叫学生的学号 */
  studentNos: string[]
  /** 实际播报的整句 */
  text: string
  room: string
  /** 每次呼叫的时间戳（「再播一遍」会追加） */
  sentAt: number[]
  states: Record<string, CallState>
}

export const CALL_STATE_TEXT: Record<CallState, string> = {
  called: '已叫',
  arrived: '已到',
  corrected: '已订正',
}

/* ---------------- 教师自定义课表 ---------------- */

export type ScheduleKind = 'class' | 'other'

/** 每周重复的一条日程。weekday：1 = 周一 … 7 = 周日 */
export type ScheduleItem = {
  id: string
  weekday: number
  /** HH:MM */
  start: string
  /** HH:MM */
  end: string
  title: string
  classId?: string
  room?: string
  kind: ScheduleKind
  /** 上课前 10 分钟提醒 */
  notify: boolean
  /**
   * 归属 —— 这两者是完全不同的东西，不能混：
   *  · 'mine'  教师自己的排课表：我什么时候上哪个班（只有我教的科目）
   *  · 'class' 班级课表：这个班整天所有科目（数学、语文…），贴在教室给学生看
   */
  scope?: 'mine' | 'class'
}

export const WEEKDAY_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
