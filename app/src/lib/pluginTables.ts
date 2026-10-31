/**
 * 插件可读表目录（能力 `read`）—— **逐张分类，没有"通配"**。
 *
 * ============================================================================
 * 这份目录回答的问题
 * ============================================================================
 * 用户 2026-10-25 的原话：「除了隐私信息类的，其他每一个的表数据读取权限都**预留个接口**……
 * 并**确保这些端口仅有插件能调用**」。
 *
 * 所以 `schema.sql` 里**每一张表**都要在这里出现一次：
 *   · 能给的表：写 `cols`（**只列可以给出的列**）、`scope`、以及 class 域的 `classCol`；
 *   · 不能给的表：写 `deny`（一句人话理由），`cols: []` —— 它在目录里，但永远读不到。
 *
 * ============================================================================
 * 三条纪律（改这个文件之前先读）
 * ============================================================================
 * ① **隐私列不是"被过滤"，是压根不在 `cols` 里**。`resources.readPluginTable()` 只 select
 *    这里列出的列 —— 没有"先整表读回来再删字段"那条路。
 * ② **`scope` 不是建议**：`class` 的表由宿主强制按本班 `classCol` 过滤（调用方给不了别的班 id）；
 *    `school` 只是"不按班钉"，**仍然受 RLS**。所以 `school` 不等于"全校都能看"。
 * ③ **成绩类的明细列一律不给**（`score` / `raw_score` / `comment` 这类）。现在给的是
 *    "聚合与判定"需要的列；要某个学生这次考多少分，提需求单独裁决。
 *
 * ⚠️ 这个文件必须**零依赖**：`lib/pluginHost.ts` 在纯 Node 门禁里被直接 import，
 *    而 Node 的类型擦除只认带扩展名的相对导入。这里只放 type 与常量，不许 import 任何东西。
 */

export type PluginTableDef = {
  /** 一句话说这张表给插件读到的是"什么功能的数据"（探针/手册都要用这句人话） */
  what: string
  /** 列白名单：**只列可以给出的列**，这里没有的一律不返回（隐私列就这样自然被剥掉） */
  cols: string[]
  /** 'class' = 只返回本班行（必须给 classId）；'school' = 全校可见（仍受 RLS） */
  scope: 'class' | 'school'
  /** 本班行的判据列（scope==='class' 时必填）：如 students 用 'class_id'、classes 用 'id' */
  classCol?: string
  /** 有值 = **拒绝**（隐私 / 凭据 / 内部账），值是拒的理由；此时 cols 必须是 [] */
  deny?: string
}

/** `schema.sql` 里 `create table` 的张数（2026-10-25 实测）。改 schema 记得回来改这里。 */
export const PLUGIN_READ_TABLE_COUNT = 55

export const PLUGIN_READ_TABLES: Record<string, PluginTableDef> = {
  /* ---------------- 一、账号与隐私：一律不给 ---------------- */

  teachers: {
    what: '教师名单：姓名与任教学科，不含联系方式或登录信息',
    cols: ['id', 'name', 'subject'],
    scope: 'school',
  },
  teacher_profiles: {
    what: '教师联系方式（电话、邮箱、住址）',
    cols: [],
    scope: 'school',
    deny: '含联系电话、邮箱、住址等联系方式',
  },
  student_profiles: {
    what: '学生隐私档案（出生年月、监护人电话、住址）',
    cols: [],
    scope: 'school',
    deny: '含监护人电话、住址、出生年月等学生隐私',
  },

  /* ---------------- 二、教学基础数据：给最小可用列 ---------------- */

  classes: {
    what: '班级档案：班名、年级、届',
    cols: ['id', 'name', 'grade', 'year'],
    scope: 'class',
    classCol: 'id',
  },
  students: {
    what: '本班学生名单：学号、姓名、在读状态',
    cols: ['id', 'class_id', 'student_no', 'name', 'status'],
    scope: 'class',
    classCol: 'class_id',
  },
  assignments: {
    what: '作业档案：标题、学科、布置日、题量、批改进度',
    cols: ['id', 'class_id', 'title', 'subject', 'assign_date', 'question_count', 'status'],
    scope: 'class',
    classCol: 'class_id',
  },
  schedule_items: {
    what: '课表：周几第几节、科目、教室',
    cols: ['id', 'class_id', 'weekday', 'start_time', 'end_time', 'title', 'room', 'kind', 'scope'],
    scope: 'class',
    classCol: 'class_id',
  },
  classrooms: {
    what: '教室端一体机：设备名与在线状态',
    cols: ['id', 'class_id', 'name', 'online', 'last_seen_at'],
    scope: 'class',
    classCol: 'class_id',
  },
  calls: {
    what: '呼叫播报记录：叫了哪些学号、播报内容、播报时间',
    cols: ['id', 'class_id', 'assignment_id', 'student_nos', 'text', 'room', 'sent_at'],
    scope: 'class',
    classCol: 'class_id',
  },
  shared_files: {
    what: '老师传给教室屏的文件清单：名字、类型、大小',
    cols: ['id', 'class_id', 'name', 'mime', 'size', 'created_at'],
    scope: 'class',
    classCol: 'class_id',
  },
  schools: {
    what: '学校档案：校名',
    cols: ['id', 'name'],
    scope: 'school',
  },
  grades: {
    what: '年级档案：高一/高二/高三与届（不是成绩表）',
    cols: ['id', 'name', 'year'],
    scope: 'school',
  },
  class_subjects: {
    what: '班级任课关系：这个班有哪些科目',
    cols: ['id', 'class_id', 'subject'],
    scope: 'class',
    classCol: 'class_id',
  },
  subjects: {
    what: '学科字典：代码、名称、简称、排序',
    cols: ['code', 'name', 'short', 'sort'],
    scope: 'school',
  },
  exams: {
    what: '考试场次：科目、日期、覆盖班级、批改进度',
    cols: [
      'id',
      'title',
      'subject',
      'subject_code',
      'scope',
      'grade',
      'exam_date',
      'question_count',
      'class_ids',
      'status',
      'graded_at',
    ],
    scope: 'class',
    /* 🔴 这一列是**数组**（一场考试覆盖多个班），过滤用 `contains` 而不是 `eq`；
       `resources.readPluginTable()` 对 `_ids` 结尾的 classCol 走数组判据。 */
    classCol: 'class_ids',
  },

  /* ---------------- 三、成绩类：只给聚合 / 判定列 ---------------- */

  exam_scores: {
    what: '考试成绩的逐人判定列（是否批改、是否缺考），不含分数明细',
    /* 🔴 刻意**不给**：scores / answers / total / objective / subjective / name / class_rank /
       grade_rank —— 逐人分数与排名属于明细，要它得单独裁决。这四列只够算
       "参考多少人 / 缺考几个 / 批改进度"。 */
    cols: ['exam_id', 'class_id', 'student_no', 'graded', 'absent'],
    scope: 'class',
    classCol: 'class_id',
  },
  student_subject_changes: {
    what: '选科变动记录：改前改后的科目（不含操作人与备注）',
    /* 🔴 不给 changed_by / note / purged_*：操作人属内部账，备注是自由文本。 */
    cols: ['student_id', 'before', 'after', 'changed_at'],
    scope: 'school',
  },

  /* ---------------- 四、通知与公告 ---------------- */

  notices: {
    what: '发给老师的通知：标题、正文、有效期、置顶',
    cols: ['id', 'title', 'body', 'scope_kind', 'expires_at', 'pinned', 'revoked_at', 'created_at'],
    scope: 'school',
  },
  notice_targets: {
    what: '通知的投递范围：年级、学科、角色',
    /* 不给 teacher_id（点名的收件人属内部账）。 */
    cols: ['notice_id', 'target_kind', 'grade_id', 'subject_code', 'target_role'],
    scope: 'school',
  },
  announcements: {
    what: '全站公告：标题、正文、等级、生效区间',
    /* 不给 created_by / updated_by / email_*（谁建的、发了几封邮件属内部账）。 */
    cols: ['id', 'title', 'body', 'level', 'popup', 'pin', 'active_from', 'active_to', 'revoked_at', 'created_at'],
    scope: 'school',
  },

  /* ---------------- 五、选科与走班 ---------------- */

  student_subjects: {
    what: '学生选科：主科与二选科目',
    /* 不给 note（自由文本）、updated_by（操作人）。 */
    cols: ['student_id', 'primary_code', 'second_codes', 'kind'],
    scope: 'school',
  },
  class_members: {
    what: '走班班成员：这个走班班有哪些学生',
    cols: ['class_id', 'student_id', 'primary'],
    scope: 'class',
    classCol: 'class_id',
  },

  /* ---------------- 六、学期与校历 ---------------- */

  academic_years: {
    what: '学年档案：起止日期',
    cols: ['id', 'name', 'start_date', 'end_date'],
    scope: 'school',
  },
  terms: {
    what: '学期档案：上/下半期与起止日期',
    cols: ['id', 'academic_year_id', 'half', 'start_date', 'end_date'],
    scope: 'school',
  },
  school_calendar: {
    what: '校历：某天放假/上课/考试',
    cols: ['on_date', 'kind', 'note'],
    scope: 'school',
  },
  school_calendar_events: {
    what: '校历上的活动：名称、时间点',
    cols: ['id', 'on_date', 'kind', 'title', 'at_text', 'note'],
    scope: 'school',
  },

  /* ---------------- 七、调课与每日作业 ---------------- */

  schedule_temp_changes: {
    what: '临时调课：某天某节换成什么科目',
    /* 不给 from_teacher_id / to_teacher_id / actor_id / actor_name（谁跟谁换、谁操作的属内部账）。 */
    cols: [
      'id',
      'on_date',
      'weekday',
      'class_id',
      'start_time',
      'end_time',
      'schedule_item_id',
      'from_subject',
      'to_subject',
      'kind',
      'status',
      'revoked_at',
    ],
    scope: 'class',
    classCol: 'class_id',
  },
  schedule_perm_changes: {
    what: '永久调课留档：某天某节换成什么科目',
    cols: [
      'id',
      'class_id',
      'weekday',
      'start_time',
      'end_time',
      'schedule_item_id',
      'from_subject',
      'to_subject',
      'kind',
      'status',
      'revoked_at',
    ],
    scope: 'class',
    classCol: 'class_id',
  },
  daily_homework: {
    what: '每日作业：今天各科留了什么',
    /* 不给 author_id / author_name（谁录的属内部账；学生看到的只是作业正文）。 */
    cols: ['id', 'class_id', 'on_date', 'subject', 'subject_code', 'content', 'seq', 'source'],
    scope: 'class',
    classCol: 'class_id',
  },
  duty_assignments: {
    what: '值日安排：哪天谁值日',
    cols: ['id', 'class_id', 'on_date', 'student_id', 'source'],
    scope: 'class',
    classCol: 'class_id',
  },
  class_groups: {
    what: '本班小组：组名、组长和成员学号对应的学生 ID',
    cols: ['id', 'class_id', 'name', 'leader_id', 'member_ids'],
    scope: 'class',
    classCol: 'class_id',
  },
  class_seats: {
    what: '本班座位表：学生与座位行列',
    cols: ['class_id', 'student_id', 'seat_row', 'seat_col'],
    scope: 'class',
    classCol: 'class_id',
  },
  teacher_departments: {
    what: '教师所属部门与主部门（只有部门归属，没有联系方式）',
    cols: ['teacher_id', 'department', 'primary'],
    scope: 'school',
  },

  /* ---------------- 八、凭据 / 审计 / 平台内部账：一律不给 ---------------- */

  teacher_roles: {
    what: '教师角色与权限范围',
    cols: [],
    scope: 'school',
    deny: '权限与角色配置属平台内部账，读它等于读出"谁能管谁"',
  },
  classroom_accounts: {
    what: '教室端账号与口令',
    cols: [],
    scope: 'school',
    deny: '含教室端登录口令与账号',
  },
  schedule_snoozes: {
    what: '教师个人的提醒设置',
    cols: [],
    scope: 'school',
    deny: '教师个人的提醒偏好，且没有班级列，按班限不住',
  },
  student_serial_counters: {
    what: '学号流水号计数器',
    cols: [],
    scope: 'school',
    deny: '学号流水号内部计数器，属平台内部账',
  },
  admin_audit: {
    what: '管理操作审计',
    cols: [],
    scope: 'school',
    deny: '管理操作审计，属平台内部账',
  },
  site_state: {
    what: '站点开关与维护状态',
    cols: [],
    scope: 'school',
    deny: '站点开关与维护状态，属平台内部账',
  },
  frontend_errors: {
    what: '前端错误上报',
    cols: [],
    scope: 'school',
    deny: '含页面轨迹与账号信息，属内部诊断数据',
  },
  feedback: {
    what: '用户反馈与处理记录',
    cols: [],
    scope: 'school',
    deny: '含联系方式与内部处理备注',
  },
  grade_promotions: {
    what: '年级提档操作记录',
    cols: [],
    scope: 'school',
    deny: '提档操作记录，属平台内部账',
  },
  grade_removals: {
    what: '年级删除的归档（含下载令牌与存档路径）',
    cols: [],
    scope: 'school',
    deny: '含下载令牌与存档路径，属内部账与凭据',
  },
  schedule_temp_archive: {
    what: '临时调课的归档留档',
    cols: [],
    scope: 'school',
    deny: '调课归档的内部留档，当前有效数据走 schedule_temp_changes',
  },
  class_rep_pins: {
    what: '班级代表口令哈希',
    cols: [],
    scope: 'school',
    deny: '口令哈希属凭据',
  },
  class_rep_pin_fails: {
    what: '班级代表口令失败计数',
    cols: [],
    scope: 'school',
    deny: '口令失败计数属凭据防线内部账',
  },
  push_tokens: {
    what: '推送令牌与邮箱',
    cols: [],
    scope: 'school',
    deny: '推送令牌与邮箱属凭据与个人隐私',
  },
  plugin_registry: {
    what: '插件登记与审核记录',
    cols: [],
    scope: 'school',
    deny: '插件登记与审核记录，属平台内部账',
  },
  plugin_data: {
    what: '插件自己的键值槽',
    cols: [],
    scope: 'school',
    deny: '插件数据只经 storage 端口读写自己的键，不开整表',
  },
  plugin_sync_events: {
    what: '插件数据变更信号', cols: [], scope: 'school',
    deny: '实时同步内部账，只通过宿主的更新通知接口使用',
  },
  plugin_quota: {
    what: '插件读写配额计数',
    cols: [],
    scope: 'school',
    deny: '配额计数属平台内部账',
  },
  plugin_configs: {
    what: '教师对插件的配置与启用状态',
    cols: [],
    scope: 'school',
    deny: '插件启用与配置属平台内部账，插件不该读自己被谁启用',
  },
  student_teaching_entries: {
    what: '教师私有的学生标签与批注', cols: [], scope: 'school',
    deny: '教师私有批注不向教室插件开放',
  },
  subject_student_groups: {
    what: '学科教师的学生分组', cols: [], scope: 'school',
    deny: '学科教师分组可能只供作者和相关班主任查看；插件使用班级小组表',
  },
  subject_student_group_members: {
    what: '学科教师分组成员', cols: [], scope: 'school',
    deny: '学科教师分组成员只供作者和相关班主任查看；插件使用班级小组表',
  },
}

/**
 * 静态自查：目录本身自洽吗（不查库、不联网）。
 * 返回问题清单，空数组 = 通过。
 *
 * ⚠️ 这一轮**不改 `scripts/`**，所以门禁还没接它；将来接进
 * `plugin-framework-checks` 时直接调这个函数即可（它不 import 任何东西，纯 Node 能跑）。
 */
export function selfCheckReadCatalog(): string[] {
  const bad: string[] = []
  const names = Object.keys(PLUGIN_READ_TABLES)
  if (names.length !== PLUGIN_READ_TABLE_COUNT) {
    bad.push(`目录里有 ${names.length} 张表，应为 ${PLUGIN_READ_TABLE_COUNT} 张`)
  }
  for (const [name, d] of Object.entries(PLUGIN_READ_TABLES)) {
    if (d.deny) {
      if (d.cols.length) bad.push(`${name} 被拒却给了 ${d.cols.length} 列`)
      if (d.scope === 'class') bad.push(`${name} 被拒却声明了 class 域`)
      if (d.classCol) bad.push(`${name} 被拒却写了 classCol`)
      continue
    }
    if (!d.cols.length) bad.push(`${name} 给了却没列任何列`)
    if (new Set(d.cols).size !== d.cols.length) bad.push(`${name} 的 cols 有重复`)
    if (d.scope === 'class' && !d.classCol) bad.push(`${name} 是 class 域但没写 classCol`)
    if (d.scope === 'school' && d.classCol) bad.push(`${name} 是 school 域却写了 classCol`)
  }
  return bad
}
