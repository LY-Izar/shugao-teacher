/**
 * 插件可读表目录 · **探针侧副本**（不是第二份真相）
 *
 * ============================================================================
 * 这份文件是什么
 * ============================================================================
 * 唯一真相在 `src/lib/pluginTables.ts`。Cloudflare Functions 的构建树与 `src/`
 * 是两条彼此不可见的树，`functions/**` 里 `import '../../src/...'` 打不进产物，
 * 所以探针这一侧必须有一份**同形的字面副本** —— 它只用来让审核探针回答：
 * 「这张表是什么数据、给不给插件、为什么」。
 *
 * 🔴 **它不是第二个可以单独改的地方。**
 * `scripts/plugin-framework-checks.mjs` 的 `readTablesMirrorChecks()` 会逐张比对
 * 表名集合、`what`、`cols`（逐项且按顺序）、`deny`（原文），并钉住总数为 49。
 * 任何一项漂移 ⇒ 门禁当场变红。改目录**两处一起改，以 `src/lib/pluginTables.ts` 为准**。
 *
 * 只保留探针需要的三样：`what` / `cols` / `deny`。
 * `scope` 与 `classCol` 是宿主运行期做班级过滤用的，探针不判它们（也不该在这里出现）。
 */

export type ReadTableMirrorDef = {
  /** 一句话说这张表给插件读到的是"什么功能的数据" */
  what: string
  /** 列白名单（与源头逐项一致；`deny` 有值时必为 []） */
  cols: string[]
  /** 有值 = 拒绝，值是拒的理由（原文照抄源头） */
  deny?: string
}

export const READ_TABLE_MIRROR: Record<string, ReadTableMirrorDef> = {
  /* ---------------- 一、账号与隐私：一律不给 ---------------- */

  teachers: { what: '教师账号与姓名', cols: [], deny: '教师账号与姓名属个人信息，插件不该直接读' },
  teacher_profiles: { what: '教师联系方式（电话、邮箱、住址）', cols: [], deny: '含联系电话、邮箱、住址等联系方式' },
  student_profiles: {
    what: '学生隐私档案（出生年月、监护人电话、住址）',
    cols: [],
    deny: '含监护人电话、住址、出生年月等学生隐私',
  },

  /* ---------------- 二、教学基础数据：给最小可用列 ---------------- */

  classes: { what: '班级档案：班名、年级、届', cols: ['id', 'name', 'grade', 'year'] },
  students: { what: '本班学生名单：学号、姓名、在读状态', cols: ['id', 'class_id', 'student_no', 'name', 'status'] },
  assignments: {
    what: '作业档案：标题、学科、布置日、题量、批改进度',
    cols: ['id', 'class_id', 'title', 'subject', 'assign_date', 'question_count', 'status'],
  },
  schedule_items: {
    what: '课表：周几第几节、科目、教室',
    cols: ['id', 'class_id', 'weekday', 'start_time', 'end_time', 'title', 'room', 'kind', 'scope'],
  },
  classrooms: { what: '教室端一体机：设备名与在线状态', cols: ['id', 'class_id', 'name', 'online', 'last_seen_at'] },
  calls: {
    what: '呼叫播报记录：叫了哪些学号、播报内容、播报时间',
    cols: ['id', 'class_id', 'assignment_id', 'student_nos', 'text', 'room', 'sent_at'],
  },
  shared_files: {
    what: '老师传给教室屏的文件清单：名字、类型、大小',
    cols: ['id', 'class_id', 'name', 'mime', 'size', 'created_at'],
  },
  schools: { what: '学校档案：校名', cols: ['id', 'name'] },
  grades: { what: '年级档案：高一/高二/高三与届（不是成绩表）', cols: ['id', 'name', 'year'] },
  class_subjects: { what: '班级任课关系：这个班有哪些科目', cols: ['id', 'class_id', 'subject'] },
  subjects: { what: '学科字典：代码、名称、简称、排序', cols: ['code', 'name', 'short', 'sort'] },
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
  },

  /* ---------------- 三、成绩类：只给聚合 / 判定列 ---------------- */

  exam_scores: {
    what: '考试成绩的逐人判定列（是否批改、是否缺考），不含分数明细',
    cols: ['exam_id', 'class_id', 'student_no', 'graded', 'absent'],
  },
  student_subject_changes: {
    what: '选科变动记录：改前改后的科目（不含操作人与备注）',
    cols: ['student_id', 'before', 'after', 'changed_at'],
  },

  /* ---------------- 四、通知与公告 ---------------- */

  notices: {
    what: '发给老师的通知：标题、正文、有效期、置顶',
    cols: ['id', 'title', 'body', 'scope_kind', 'expires_at', 'pinned', 'revoked_at', 'created_at'],
  },
  notice_targets: {
    what: '通知的投递范围：年级、学科、角色',
    cols: ['notice_id', 'target_kind', 'grade_id', 'subject_code', 'target_role'],
  },
  announcements: {
    what: '全站公告：标题、正文、等级、生效区间',
    cols: ['id', 'title', 'body', 'level', 'popup', 'pin', 'active_from', 'active_to', 'revoked_at', 'created_at'],
  },

  /* ---------------- 五、选科与走班 ---------------- */

  student_subjects: { what: '学生选科：主科与二选科目', cols: ['student_id', 'primary_code', 'second_codes', 'kind'] },
  class_members: { what: '走班班成员：这个走班班有哪些学生', cols: ['class_id', 'student_id', 'primary'] },

  /* ---------------- 六、学期与校历 ---------------- */

  academic_years: { what: '学年档案：起止日期', cols: ['id', 'name', 'start_date', 'end_date'] },
  terms: { what: '学期档案：上/下半期与起止日期', cols: ['id', 'academic_year_id', 'half', 'start_date', 'end_date'] },
  school_calendar: { what: '校历：某天放假/上课/考试', cols: ['on_date', 'kind', 'note'] },
  school_calendar_events: {
    what: '校历上的活动：名称、时间点',
    cols: ['id', 'on_date', 'kind', 'title', 'at_text', 'note'],
  },

  /* ---------------- 七、调课与每日作业 ---------------- */

  schedule_temp_changes: {
    what: '临时调课：某天某节换成什么科目',
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
  },
  daily_homework: {
    what: '每日作业：今天各科留了什么',
    cols: ['id', 'class_id', 'on_date', 'subject', 'subject_code', 'content', 'seq', 'source'],
  },
  duty_assignments: {
    what: '值日安排：哪天谁值日',
    cols: ['id', 'class_id', 'on_date', 'student_id', 'source'],
  },
  teacher_departments: {
    what: '教师所属部门与主部门（只有部门归属，没有联系方式）',
    cols: ['teacher_id', 'department', 'primary'],
  },

  /* ---------------- 八、凭据 / 审计 / 平台内部账：一律不给 ---------------- */

  teacher_roles: {
    what: '教师角色与权限范围',
    cols: [],
    deny: '权限与角色配置属平台内部账，读它等于读出"谁能管谁"',
  },
  classroom_accounts: { what: '教室端账号与口令', cols: [], deny: '含教室端登录口令与账号' },
  schedule_snoozes: {
    what: '教师个人的提醒设置',
    cols: [],
    deny: '教师个人的提醒偏好，且没有班级列，按班限不住',
  },
  student_serial_counters: { what: '学号流水号计数器', cols: [], deny: '学号流水号内部计数器，属平台内部账' },
  admin_audit: { what: '管理操作审计', cols: [], deny: '管理操作审计，属平台内部账' },
  site_state: { what: '站点开关与维护状态', cols: [], deny: '站点开关与维护状态，属平台内部账' },
  frontend_errors: { what: '前端错误上报', cols: [], deny: '含页面轨迹与账号信息，属内部诊断数据' },
  feedback: { what: '用户反馈与处理记录', cols: [], deny: '含联系方式与内部处理备注' },
  grade_promotions: { what: '年级提档操作记录', cols: [], deny: '提档操作记录，属平台内部账' },
  grade_removals: {
    what: '年级删除的归档（含下载令牌与存档路径）',
    cols: [],
    deny: '含下载令牌与存档路径，属内部账与凭据',
  },
  schedule_temp_archive: {
    what: '临时调课的归档留档',
    cols: [],
    deny: '调课归档的内部留档，当前有效数据走 schedule_temp_changes',
  },
  class_rep_pins: { what: '班级代表口令哈希', cols: [], deny: '口令哈希属凭据' },
  class_rep_pin_fails: { what: '班级代表口令失败计数', cols: [], deny: '口令失败计数属凭据防线内部账' },
  push_tokens: { what: '推送令牌与邮箱', cols: [], deny: '推送令牌与邮箱属凭据与个人隐私' },
  plugin_registry: { what: '插件登记与审核记录', cols: [], deny: '插件登记与审核记录，属平台内部账' },
  plugin_data: { what: '插件自己的键值槽', cols: [], deny: '插件数据只经 storage 端口读写自己的键，不开整表' },
  plugin_quota: { what: '插件读写配额计数', cols: [], deny: '配额计数属平台内部账' },
  plugin_configs: {
    what: '教师对插件的配置与启用状态',
    cols: [],
    deny: '插件启用与配置属平台内部账，插件不该读自己被谁启用',
  },
}
