export type StudentStatus = 'active' | 'left'

/**
 * 班型（`classes.class_type`）—— 四档，**`''` 与 `'undivided'` 是两件事**。
 *
 *   `''`           还没设置（默认；**不许默认成理科班** —— 猜错 = 全班的默认选科都错）
 *   `'undivided'`  未分科（高一的默认状态，是**显式**的一档）
 *   `'arts'`       文科班（默认 历史 + 政治 + 地理；**首选必须是历史**）
 *   `'science'`    理科班（默认 物理 + 化学 + 生物；**首选必须是物理**）
 *
 * 🔴 **班型与首选绑定**（Q2）：文科班的首选只能是历史、理科班只能是物理。
 *    不符时系统**不自动改**，只出「建议转班」提示（见 `lib/pick.ts` 的 `subjectAdvice()`）。
 */
export type ClassType = '' | 'undivided' | 'arts' | 'science'

/** 这一档班型的中文名（**唯一一处**：界面上别再各写一份 `if`） */
export const CLASS_TYPE_NAME: Record<ClassType, string> = {
  '': '未设置',
  undivided: '未分科',
  arts: '文科班',
  science: '理科班',
}

/**
 * 班型的**默认组合**（首选 + 再选两门）。`''` 与 `'undivided'` 没有默认组合 ——
 * 未分科就是"还没有默认"，不是"默认物化生"。
 *
 * ⚠️ 它只回答"这个班的默认选科是什么"，**不回答"这个学生选了什么"**
 *    （后者是 `student_subjects` 的一行）。
 */
export const CLASS_TYPE_DEFAULT: Record<ClassType, { primary: string; second: string[] } | null> = {
  '': null,
  undivided: null,
  arts: { primary: 'history', second: ['politics', 'geography'] },
  science: { primary: 'physics', second: ['chemistry', 'biology'] },
}

/**
 * 班级的**种类**（`classes.kind`）。
 *
 *   `'admin'`   行政班（高一(1)班这种）
 *   `'stream'`  走班班（「走班班-物化政」这种，`streamKey` 是它的组合标识）
 *
 * ⚠️ 默认值必须是 `'admin'`：老的写入路径不送这一列，默认值让老代码行为不变。
 */
export type ClassKind = 'admin' | 'stream'

export type Student = {
  id: string
  /** 班内学号，唯一。**它仍然可改**（班主任 / 年级主任 / 教务处三档） */
  studentNo: string
  /**
   * **序列号**（Q6）：`入校年份 4 位 + 该届内 3 位`（如 `2025001`），**全校唯一、生成后永久不可改**。
   *
   * 🔴 **它才是那 10 个字段（+2 处考试字段）的键** —— 见 `lib/keys.ts` 的 `archiveKeyOf()`。
   * 兼容期（线上库还没跑 `supabase/schema.sql` §20）：它为空 → 键退回 `studentNo`，老行为不变。
   * ⚠️ 空串不写 `undefined`：与 `subjectCode` 那套兼容期读法同一口径（"没有值"只有一种写法）。
   */
  serial?: string
  /**
   * **迁移那一刻的班内学号存档**（= 老键）。只有"从老键迁过来的"学生才有值。
   *
   * ⚠️ 它**只读不写**：前端任何时候都不许改它（数据库 §20.2 的触发器会拒），
   * 它的用途只有一个 —— 让键迁移**幂等**（`schema.sql` 的 20.4 / U-3 = B）。
   */
  legacyStudentNo?: string
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
  /**
   * 班级种类（`classes.kind`）。缺省 = `'admin'`（兼容期：老库还没跑 §27 时读不到这一列）。
   * 读的人一律走 `lib/pick.ts` 的 `classKindOf()`，别直接判 `k.kind === 'stream'`。
   */
  kind?: ClassKind
  /**
   * 班型（`classes.class_type`）。缺省 = `''`（还没设置）。
   * ⚠️ 与"未分科"（`'undivided'`）是两件事，别把空串当成未分科。
   */
  classType?: ClassType
  /** 走班班的组合标识（如 `物化政`）；行政班恒为 `''` */
  streamKey?: string
  /**
   * 这个班挂到哪个年级（`classes.grade_id`，权限判据的一环）。
   * 缺省 = 认不出来（老库 / 年级名换不出 id）—— 与 `remote.ensureGradeLookup()` 同一口径。
   */
  gradeId?: string
}

export type Teacher = {
  id: string
  name: string
  /**
   * **显示标签**（老师自己填的，可能是「物理竞赛」这种非规范写法）。
   * ⚠️ 它**不是**新作业学科默认值的来源 —— 那件事已经交给 `primarySubjectCode`。
   * 一个字段只能有一种语义：显示归显示、默认值归默认值（见 `lib/subjects.ts`）。
   */
  subject: string
  /**
   * **主学科**：学科字典里的代码（`lib/subjects.ts` 的 `SubjectCode`）。
   * 新建作业时学科 chip 的预选值就是它。
   *
   * 为 `undefined` 时表示"库里还没显式设置过"（兼容期：线上库可能还没有
   * `teachers.primary_subject_code` 这一列）—— 读的人一律走
   * `teacherPrimarySubjectCode()`，不要自己写兜底，更不要拿 `subject` 直接当判据。
   */
  primarySubjectCode?: string
  school: string
}

/* ---------------- 身份（角色） ---------------- */

/**
 * 身份代码。**判据在数据库**（`teacher_roles.role` 的 check 约束 + `schema.sql` §13.2 / §16.2 /
 * §21 的那些函数），这里只是它的前端镜像 —— 前端拿它决定「显示哪些入口 / 标签」，
 * **不用来决定"能不能写"**（见 §11.3 的纪律）。
 *
 * 2026-09-28「管理架构与角色权限」这一轮从 5 个值扩到 **12 个值**（= 用户说的 14 档身份，
 * 其中 `principal`/`vice_principal`/`principal_assistant` 三档在数据库里逐格相同，
 * 而 `classroom`（教室端）**不是**这一档 —— 它是 `classroom_accounts` 里的一行）。
 *
 * 三个容易混的身份，别再当成一个：
 *  · `super`            最高管理员（**平台**维护者，不是学校里的岗位）
 *  · `admin`            **教务处**（代号保留、显示名改。能建号、能指派身份、能看全校、能改成绩兜底）
 *  · `principal` 等三档  校长 / 副校长 / 校长助理：**全校只读** + 发全校通知，**不建号、不改成绩**
 *
 * 🔴 加一档身份 = **这里加一个值** + `lib/roles.ts` 的 `ROLE_NAME` 加一行 +
 *    `schema.sql` 的 check 约束加一个值（三处必须一起动，`roles.ts:29` 的原话）。
 *    ⚠️ 新代号**不进任何判据函数**是**对**的中间态：拿了这个身份什么都多看不到，
 *    与"没有这一档"等价（权限只做加法）。
 */
export type RoleCode =
  | 'super'
  | 'admin'
  | 'principal'
  | 'vice_principal'
  | 'principal_assistant'
  | 'office_head'
  | 'moral_edu_head'
  | 'grade_head'
  | 'head_teacher'
  | 'subject_lead'
  | 'lesson_prep_lead'
  | 'teacher'

/**
 * `teacher_roles` 的一行：一个人可以有多条（多身份是常态，不是异常）。
 *
 * `scopeType` 的五个值各有确定含义（`schema.sql` §10.1.1 的 check 约束）：
 *   `'school'`        全校或空（super / admin / 校级三档 / 办公室主任 / 德育处主任）
 *   `'grade'`         本年级（年级主任）—— `scopeId` = 年级 id
 *   `'class'`         本班（班主任）—— `scopeId` = 班级 id
 *   `'subject'`       本校一个学科、**跨年级**（教研组长）—— `subjectCode` = 学科代码
 *   `'grade_subject'` 本年级的一个学科（备课组长）—— `scopeId` = 年级 id + `subjectCode`
 * ⚠️ `'department'` **刻意不存在**：平台里没有一条数据是按部门分的（见 `schema.sql` §10.1.1）。
 *    🆕 2026-09-28 第二轮加的**部门维度**与这一列**无关**，它走的是另外两处：
 *      归属 = `teacher_departments` 表（§21.2.2，多对多且可空）；
 *      收件范围 = `notice_targets.target_kind = 'department'`（§21.3.1）。
 *      ——"属于教务处"是档案属性，"是教务处主任"才是身份，两者不能合并。
 */
export type TeacherRole = {
  role: RoleCode
  /** 管辖范围（见上） */
  scopeType?: 'school' | 'grade' | 'class' | 'subject' | 'grade_subject'
  scopeId?: string
  /**
   * 学科代码（`lib/subjects.ts` 的 `SubjectCode`）。
   * **只有组长两档才有**（`subject_lead` / `lesson_prep_lead`）——
   * 少了它，组长在平台里等于一位普通任课老师（判据永远匹配不到）。
   */
  subjectCode?: string
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
  /** 学科显示名（`subjectCode` 的显示缓存，别拿它当判据） */
  subject: string
  /** 学科代码（`lib/subjects.ts`）。老模板可能没有 —— 用 `subjectCodeOf()` 兼容读 */
  subjectCode?: string
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
  /**
   * 知识点 id（见 `lib/knowledge.ts` 的知识树）。
   *
   * 导入时按关键词自动打标 —— **只是加速器，教师随时可以改**。
   * 今天树只有物理一棵（第二阶段的活）；换成多学科字典之前，
   * 这里存的就是物理知识树的 id（`coulomb` / `ohm` …），历史档案不要迁移。
   */
  points?: string[]
  /** 题目配图（data URL）—— 生成「错题重练」文档要用 */
  imgs?: string[]
}

export type Assignment = {
  id: string
  title: string
  classId: string
  /**
   * 学科显示名。**它是 `subjectCode` 的显示缓存，没有第二种语义** ——
   * 唯一写入入口是 `store.addAssignment` / `store.updateAssignment`，
   * 值恒等于该 code 在字典里的名字，页面里不许单独写它。
   */
  subject: string
  /**
   * 学科代码（`lib/subjects.ts` 的 `SubjectCode`）。
   *
   * ⚠️ 兼容期读法：老档案（以及线上库还没跑多学科那一段 SQL 时）可能没有这一列 ——
   * 一律用 `subjectCodeOf(a)` 读，不要直接 `a.subjectCode!`。
   */
  subjectCode?: string
  /** 布置日期 YYYY-MM-DD，默认前一天 */
  assignDate: string
  /**
   * 学期归属（`schema.sql` §28，P3）—— 期末归档与"列表默认只看本学期"的判据。
   *
   * 🔴 三种取值**语义不同**（`lib/terms.ts` 的 `termMatches()` 是唯一读法）：
   *   · `undefined` —— 这一列读不到（线上库还没跑 §28）→ 列表**照样显示**；
   *   · `null`      —— 列在、这份档案还没归到任何学期 → **照样显示**；
   *   · 字符串      —— 确实属于那一个学期。
   * ⚠️ 归落由 `assign_date` 推（`remote.assignmentWriteRow` 一处说了算），
   *    不许页面各算各的 —— 与 §28.8 的 SQL 回填同一条口径。
   */
  termId?: string | null
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
  /**
   * 「改错名单」：这次作业做错了、要去改的人。
   * 与 focusNos（需重点关注）是**两张表** —— 全对的学生也可能被重点关注，
   * 而进改错名单的一定是有错的。
   */
  correctionNos?: string[]
  /** 「已改错」：改错登记时逐个点过的学号 */
  correctedNos?: string[]
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

/* ---------------- 🆕 通知（2026-09-28） ---------------- */

/**
 * 通知的**发布范围**（`notices.scope_kind` 的 check 约束，逐字相同）。
 *
 * 🔴 **呼叫 ≠ 通知**（`管理架构与角色权限方案.md` §0.1）：
 *    · 呼叫是**老师对学生**说话 → `calls` 表 → 教室那块大屏；
 *    · 通知是**学校对老师**说话 → `notices` 表 → 教师的平台界面。
 *    两者**没有一行可以共用**：`notices` 里不许出现 `student_nos` / `class_id` /
 *    `assignment_id`（I45），`calls` 的读策略一个字都不改。
 *
 * 取值含义：
 *   `school`        全校所有老师
 *   `grade`         本年级的老师（在该年级的班上有任教关系 + 该年级的班主任 / 年级主任 / 备课组长）
 *   `subject`       本学科的老师（跨年级）
 *   `grade_subject` 本年级 + 本学科的老师
 *   `role`          **某个职位**（🔴 只能发给自己级别以下的档位 —— 见下）
 *   `custom`        手勾的一批老师
 *
 * ⚠️ `role` 那一条有一处**我替用户定的保守默认**（报告里标为假设）：
 *    「发给职位」只允许发给自己级别以下的档位 —— 否则任何人都能给超管发通知，
 *    而"我给校长发了条通知"在语义上就不成立。判据在数据库（`teacher_rank()`）。
 */
export type NoticeScopeKind =
  | 'school'
  | 'grade'
  | 'subject'
  | 'grade_subject'
  | 'role'
  | 'custom'
  /** 🆕 2026-09-28 第二轮：某个**职能部门**（办公室 / 教务处 / 总务处 / 德育处） */
  | 'department'

/** 收件范围的一行（`notice_targets`）——**一行一个维度值**，按 `kind` 只有一列非空 */
export type NoticeTarget = {
  kind: NoticeScopeKind
  gradeId?: string | null
  subjectCode?: string | null
  targetRole?: string | null
  /** 🆕 部门代码（`kind === 'department'` 时才有值；**不在 `targetRole` 里复用**） */
  department?: string | null
  teacherId?: string | null
}

/** 一条通知（服务端 `/api/notice` 的 `list` 返回的形状） */
export type Notice = {
  id: string
  title: string
  body: string
  scopeKind: NoticeScopeKind
  senderId: string
  createdAt: number
  expiresAt: number | null
  pinned: boolean
  revokedAt: number | null
  expired: boolean
  /** 是不是我自己发的（自己发的永远看得见 —— I25 的同一条纪律） */
  mine: boolean
  /** 未读 = `createdAt > 我的 notice_seen_at`（I49：**只有这一个时间戳**） */
  unread: boolean
  targets: NoticeTarget[]
}

/**
 * 「我能发给谁」的一个选项（数据库的 `my_notice_scopes()` 算出来的）。
 *
 * ⚠️ 它**不是判据的第二处**：它只决定界面上**摆不摆那个选项**，
 *    真正的闸门是服务端那一次 `can_publish_notice_to()` RPC（I46）。
 *    前端藏掉"全校"那个选项**不是**安全边界 —— 手打接口就绕过去了。
 */
export type NoticeScopeOption = {
  scopeKind: NoticeScopeKind
  gradeId: string | null
  gradeName: string | null
  subjectCode: string | null
  roleCode: string | null
  /** 🆕 部门那一维的取值（`scopeKind === 'department'` 时才有） */
  departmentCode: string | null
}

/** 通知的读+写入口（`lib/notices.ts`）。表还没建时一律返回"没做成"，前端不崩。 */
export type NoticeBundle = {
  /** 表在不在（探测结论，与 `ensureExamTables()` 同一套纪律） */
  state: 'present' | 'missing' | 'unknown'
  canPublish: boolean
  scopes: NoticeScopeOption[]
  notices: Notice[]
  unread: number
  seenAt: number | null
}

export const EMPTY_NOTICE_BUNDLE: NoticeBundle = {
  state: 'missing',
  canPublish: false,
  scopes: [],
  notices: [],
  unread: 0,
  seenAt: null,
}

/* ---------------- 🆕 全站公告（2026-09-28 公告轮）----------------
 *
 * 🔴🔴 **公告 ≠ 通知** —— 这是本仓库最容易搞混的一处，先读这段再读下面的类型：
 *   · `Notice`（上面那一组）＝ **教务通知**：各职能部门发给老师的事，**有收件范围**、
 *     有未读、有 `/notices` 收件箱页。它问的是"这件事跟我有没有关系"。
 *   · `Announcement`（这一组）＝ **全站公告**：**关于平台本身**的信息
 *     （"系统今晚维护"、"新功能上线"），**全站一条、没有收件范围、没有收件人、没有未读**。
 *     形态是**顶部横幅 + 可选弹窗**。它问的是"这个平台现在是什么状态"。
 * ⛔ 两者不许互相塞：公告不进 `notices`，通知不加 `level` / `popup`。
 * 设计见 `功能设计与不变量.md` §二十四 · 表见 `supabase/schema.sql` §22。
 * ------------------------------------------------------------------ */

/**
 * 公告**等级** —— 它只回答"**多显眼**"这一个问题（`popup` 回答"弹几次"）。
 *
 *   normal    普通 —— 只出现在滚动条里
 *   important 重要 —— 排序靠前（在置顶那一条之后）+ **加粗**
 *   urgent    紧急 —— 最重的底色；且 `popup='never'` 时仍然按"每会话一次"弹
 *
 * ⚠️ 参照项目（`医路相伴`）把 `level='urgent'` 顺带用来改弹窗行为，
 *    本项目**不混**：等级只影响"多显眼"，弹窗只由 `popup` 决定（唯一例外见上）。
 */
export type AnnouncementLevel = 'normal' | 'important' | 'urgent'

/**
 * 公告**弹窗** —— 它只回答"**弹几次**"这一个问题。
 *
 *   never   不弹（例外：`level='urgent'` 按"每会话一次"弹）
 *   once    **每人一次** —— 关掉时记 localStorage（`shugao.ann.seen`）
 *   session **每会话一次** —— 弹出时记 sessionStorage（`shugao.ann.sessSeen`）
 *   always  **每次访问都弹**（慎用）
 */
export type AnnouncementPopup = 'never' | 'once' | 'session' | 'always'

/**
 * 一条公告（`announcements` 表在前端这一侧的形状，前端的 `asAnnouncement()` 归一）。
 *
 * ⚠️ 时间一律是**毫秒时间戳**（与 `Notice.createdAt` 等一致），
 *    区间两端 `null` = 那一端是 ±∞（见 `activeFrom` / `activeTo` 的注释）。
 */
export type Announcement = {
  id: string
  title: string
  body: string
  level: AnnouncementLevel
  popup: AnnouncementPopup
  /** 置顶：排在所有公告之前（与 `level` 是两个维度：一个说"钉住"，一个说"多重"） */
  pin: boolean
  /** 生效起点（毫秒）。**null = 立即生效** */
  activeFrom: number | null
  /** 生效终点（毫秒，闭区间）。**null = 不过期** */
  activeTo: number | null
  createdBy: string | null
  updatedBy: string | null
  createdAt: number
  updatedAt: number
  /** 撤下时刻（null = 有效）。⚠️ 撤下**不删行**（"这条公告曾经存在过吗"要能回答） */
  revokedAt: number | null
  /* ---- 邮件四列：🆕 2026-09-29 管理台第二期起**真正被写**（可选勾选、默认不发）----
     🔴 发的是**给管理员邮箱的一封留档**，不是群发（Resend 未验域名发不到别人）；
        四列的语义：`emailSent` = **成功**发过（失败不算"发过"）；
        `emailCount` = 成功封数；`emailFail` = 失败封数（含没配 key / 正文疑似含学生信息）。 */
  emailSent: boolean
  emailSentTs: number | null
  emailCount: number
  emailFail: number
  /**
   * 这一条是**超管在面板上点的"预览"**（不落库、不进 RLS）——
   * 它让"我要看它长什么样"能在**教师端真实的长相**里看到，包括已撤下/已过期的那一条。
   */
  preview?: boolean
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
