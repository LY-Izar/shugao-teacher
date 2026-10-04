/**
 * 无头截图冒烟：用本机 Edge 走一遍教师端全流程，**每一步都断言"我在对的页面"**。
 * 用法：npm run shots（前置：dev server 在 5178 上跑着）
 * 输出：`.shots/<runId>/*.png`（runId = 启动时刻的时间戳，见下面「输出目录」一节）
 *
 * ============================================================
 * 为什么这个脚本必须有断言（2026-09-27 加，教训留档）
 * ============================================================
 * 在这之前它一条断言都没有：唯一的门是结尾那句
 * `if (errors.length) process.exitCode = 1`，而 errors 只收 `pageerror` / `console.error`。
 * 反例就在同一份代码里 —— `App.tsx` 的 Guard：
 *
 *     if (accountKind === 'classroom') return <Navigate to="/classroom" replace />
 *     if (isClassroomDevice())        return <Navigate to="/login" replace … />
 *
 * **React Router 的 `<Navigate>` 是静默的**：它不抛异常、不产生 console.error。
 * 所以只要谁把设备判定或 Guard 改错，教师端**每个页面**都会渲染成登录页，
 * 而本脚本照样打满 77 张图、照样打印「无运行时错误」、退出码 0 —— 这就是"绿灯假象"。
 *
 * 纪律（照 `clock-checks.mjs` 的样子来）：
 *   ① **每次 goto 之后先断言"我在对的页面"**：URL + 该页**独有**的文本（不用泛化词）；
 *   ② 结束**比对文件名清单**：跑完实际产出的文件集合必须 == 开头写死的期望集合；
 *   ③ 全程 try/finally：失败也要 `browser.close()`，并报出**停在哪一步**；
 *   ④ 时间统一用 `ctx.clock.install()` + `setFixedTime()`（不再自建 Date 桩，见下）；
 *   ⑤ 拨表之后**把屏上的日期读回来核对**（`clockOnScreen()`）。
 *
 * ============================================================
 * 时钟：为什么删掉了自建的 Date 桩
 * ============================================================
 * 原来这里有 `ctx.addInitScript` 自建的 Date 子类桩（钉死在 2026-09-19T10:00:00+08:00），
 * 后面又用 `page.clock.setFixedTime()` 拨表。两者能同时生效纯属**实现细节**：
 * Playwright 的 clock 也是靠 initScript 实现的，**后注册的会覆盖先注册的**，
 * 于是 setFixedTime 把那个桩盖掉了 —— 顺序一变就会静默地全部渲染成 10:00，
 * 而且没有一条断言会响（脚本原来根本不看屏上时间）。
 * 现在只有**一个**时钟：`ctx.clock.install()`（在 addInitScript **之前**调，保证它先注册）
 * + 每一步的 `setFixedTime()`，并且每次导航都把屏上日期读回来核对。
 *
 * ⚠️ **拨表不能跨过登录有效期**：`session.ts` 的 `AUTH_DAYS = 7`，
 *    `authExpired()` 比的是 `Date.now() - 上次输密码的时间`。
 *    所以本脚本的钟面只走 2026-09-17 → 09-25（8 天，但首次加载在 09-19，
 *    与最远的 09-25 相差 6 天），**不要**再往后拨 ——
 *    超了 7 天 Guard 会把每一页都踢回登录页（那正是上面那条"静默 Navigate"的现场）。
 *
 * ============================================================
 * 输出目录：`.shots/<runId>/`
 * ============================================================
 * 原来所有图都平铺在 `.shots/` 下：跑一次覆盖一次，审计实测看到过"4 个批次混在一起、
 * 旧图冒充这一轮"，同一个目录还出现过两个 shots 并发交错写。
 * 现在每轮写到自己的 `<runId>` 子目录，`.shots/LATEST` 指向最新一轮。
 * 这样"旧图冒充这一轮"在物理上就不可能发生。
 *
 * ⚠️ 这个脚本跑的是**本地演示模式**（dev 下没有 Supabase 变量），
 *    所以它**永远覆盖不到云端路径 / 权限** —— 那是 `rls-checks.mjs` 的活，别在这里补。
 */
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'
import { launchBrowser } from './lib/edge-path.mjs'

// 先装 TS 解析钩子，再 import 仓库里的种子数据（见 scripts/lib/ts-resolve.mjs）
registerTsResolve()
const { makeDemoClasses, makeDemoExams, makeDemoAssignments } = await import('../src/data/seed.ts')

/* 目标 dev server：默认 5178（`vite.config.ts` 里 strictPort，端口被占会直接报错而不是偷偷换） */
const BASE = process.env.SHUGAO_BASE || 'http://localhost:5178'

/** 脚本自身所在目录（`app/scripts`）—— 输出路径按它算，不按 cwd 算 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS_ROOT = join(HERE, '..', '.shots')

/** 本轮的 runId：启动时刻的时间戳（`2026-09-27T04-19-52`，文件名安全） */
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = join(SHOTS_ROOT, runId)
const OUT_REL = `.shots/${runId}`

/*
 * 每次导航前注入登录态。**类与考试的演示数据必须一起注入**：
 * zustand persist 的 merge 是"存储快照浅合并到初始状态"，而快照里带着
 * 上一轮跑出来的 `exams: []` / `examScores: []`（它们是数组、不是缺键），
 * 于是 seed 里的演示考试会被这个空数组**覆盖掉** —— 表现就是"考试列表是空的"。
 * 这条坑与 §九「shots.mjs 的 addInitScript 会覆盖 shugao.teacher.v1」是同一个。
 * 这里直接调 seed 的构造函数，保证注入的就是页面本来该看到的那份数据。
 */
const DEMO_CLASSES = makeDemoClasses()
const DEMO_EXAMS = makeDemoExams(DEMO_CLASSES)
const DEMO_ASSIGNMENTS = makeDemoAssignments(DEMO_CLASSES)

/**
 * 🆕 公告预览夹具（2026-09-28 公告轮）—— 模拟"超管在 `/admin` 点了「预览」"写进本机的那一份
 * （`shugao.ann.preview`）。它用在**早间欢迎弹窗那一支**上：那一条 `urgent` + 每人一次，
 * 于是"公告弹窗会不会跟早间弹窗抢位置"这件事才测得到。
 */
const ANN_PREVIEW = {
  id: 'ann-preview-1',
  title: '预览：紧急停课通知',
  body: '这条是超管在面板上点「预览」推过来的一条。\n第二行：正文里的换行要照原样显示。',
  level: 'urgent',
  popup: 'once',
  pin: false,
  activeFrom: null,
  activeTo: null,
  createdBy: 't-1',
  updatedBy: null,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  revokedAt: null,
  emailSent: false,
  emailSentTs: null,
  emailCount: 0,
  emailFail: 0,
}

const TEACHER_STATE = {
  state: {
    teacher: { id: 't-1', name: '王老师', subject: '物理', school: '树高中学' },
    streakDays: 4,
    lastSeenAt: Date.now(),
    classes: DEMO_CLASSES,
    exams: DEMO_EXAMS.exams,
    examScores: DEMO_EXAMS.scores,
  },
  version: 1,
}

/**
 * 本轮**预期产出**的文件名清单（不带目录）。
 *
 * 为什么要在开头写死：脚本结尾会拿**实际落盘的文件集合**和它比对。
 * 少一张（哪一步静默没跑）或多一张（名字撞了、被覆盖）都是红。
 * 原来文档里写死了三个互相矛盾的数字（53 / 53+ / 63），而实际是 77 ——
 * 所以现在**以这份清单 + 脚本结尾打印的张数为准**，文档只指向它。
 *
 * 条件产出的两处（原来 `if (sb)` 的 38/39、`if (await mc.count())` 的 69）
 * 已经**改成无条件**：量不到导航胶囊就是真失败，找不到多选题就该红，
 * 不该用 `if` 咽下去。所以清单里没有条件项。
 */
const EXPECTED_FILES = [
  '01-login.png',
  '02-workbench.png',
  '03-classes.png',
  '04-class-detail.png',
  '05-photo-capture.png',
  '06-photo-scanning.png',
  '07-photo-review.png',
  '08-paste-import.png',
  '09-settings.png',
  // P1 序列号键（2026-09-25）：名单上的序列号列 · 改班内学号之后 · 档案不受影响
  '09b-roster-serial.png',
  '09b-after-rename.png',
  '09c-collect-after-rename.png',
  '10-desktop.png',
  '11-assignments.png',
  '12-assignment-new.png',
  '13-collect-idle.png',
  '14-collect-scanning.png',
  '15-collect-result.png',
  '16-desktop-assignments.png',
  '17-grade-idle.png',
  '18-grade-inline-panel.png',
  '19-grade-quick-sub.png',
  '20-grade-sub-three.png',
  '21-grade-sub-wrong.png',
  '22-grade-sub-settings.png',
  '23-grade-switch.png',
  '24-grade-finish-choose.png',
  '25-grade-draft-saved.png',
  // ⚠️ 26–31 是**两组同名前缀、不同后缀**：`26/27/28/29/30/31-*` 先在"批改"一节产出，
  //    再到"统计与呼叫"一节产出。两组都留着是有意的：按前缀找"第 26 步"时两个都在。
  //    文件名本身唯一，不会互相覆盖 —— 结尾的清单比对会盯着这一点。
  '26-grade-pick-correction.png',
  '27-grade-done.png',
  '28-correct.png',
  '29-correct-one-done.png',
  '30-correct-edit-list.png',
  '31-correct-call.png',
  '26-stats.png',
  '27-stats-drill.png',
  '28-call.png',
  '29-call-selected.png',
  '30-call-preview.png',
  '31-calls.png',
  '32-classroom.png',
  '33-classroom-list.png',
  '34-classroom-broadcast.png',
  '120-classroom-paste-sheet.png',
  // 121 = 课代表在教室端录作业那张表（2026-10-03 补）—— 🔴 那条链原来零断言，
  //       而它是教室端**唯一的写入口**。详见教室端那一节的说明。
  '121-classroom-rep-sheet.png',
  '35-nav-frost.png',
  '36-nav-travel.png',
  '37-nav-settled.png',
  '38-nav-drag.png',
  '39-nav-dropped.png',
  '40-assignments-filter.png',
  '41-schedule.png',
  '42-morning-welcome.png',
  '43-morning-workbench.png',
  '44-weekend.png',
  '45-late-night.png',
  '46-day-done.png',
  '47-day-done-banner.png',
  '48-makeup-day-welcome.png',
  '49-makeup-day-no-banner.png',
  '50-holiday-festive.png',
  '51-countdown-done.png',
  '52-wrong-classes.png',
  '53-wrong-class-detail.png',
  '54-wrong-student-sheet.png',
  '55-wrong-class-summary.png',
  '56-wrong-back-to-classes.png',
  '57-wrong-class-empty.png',
  '60-assignments-with-exam-entry.png',
  '61-exams-list.png',
  '62-exam-stats.png',
  '63-exam-question-drill.png',
  '64-exam-student-diagnosis.png',
  '65-exam-new.png',
  '66-exam-preset-sheet.png',
  '67-exam-grade-list.png',
  '68-exam-grade-one-student.png',
  '69-exam-grade-multi-partial.png',
  '70-exam-grade-after-confirm.png',
  '71-exam-finish-choose.png',
  '72-exam-finish-confirm-zero.png',
  '73-exam-draft-saved.png',
  // 极简模式（`statsMode='simple'`）那三屏 —— 第二套数据模型，
  // 结构照 seed 里的 a-demo-5（只记等级、没有任何逐题数据）
  '74-simple-grade.png',
  '75-simple-correct.png',
  '76-simple-done.png',
  // 「当前身份」标签改成**多身份全露**（2026-09-27）之后的布局留档：
  // 77/78 = 桌面侧栏（3 个身份 / 4 个身份），79 = 手机上设置页身份卡（3 个身份）。
  // 这三张是**留档**，真正拦人的是「身份标签」那一节的几何断言（溢出 / 竖排姓名）。
  '77-role-multi-3.png',
  '78-role-multi-4.png',
  '79-role-multi-mobile.png',
  // 超管运维面板（`超管运维面板方案.md` 第一期）。四张各自钉一件事：
  //   80 = **设备被标成教室端时敲 /admin 也进得来**（方案 §七 T6，这一期最要紧的一条画面）
  //   81 = 面板首屏（L0 健康条 + 五张卡 + 本地模式那条红警告）
  //   82 = E7 矛盾明细（五类检查 + 隐私那一行，**默认只有学号**）
  //   83 = 点了「显示姓名」之后（隐私 B 类的"显式操作"那一层）
  '80-admin-locked-entry.png',
  '81-admin-overview.png',
  '82-admin-e7-detail.png',
  '83-admin-e7-names.png',
  // G7（用户 2026-09-28 拍板）：教师账号在**被标成教室端的设备**上打开 `/classroom` → 拦住。
  //   84 = 拦截卡（三条出路写全）；85 = 反向对照：教师账号 + **自己的**设备 → 照常预览。
  //   ⚠️ "拦住"的判据不只是那张卡，还有**屏上没有任何学生数据**（断言里逐项查过）。
  '84-classroom-teacher-blocked.png',
  '85-classroom-teacher-preview-ok.png',
  // 按身份显示导航（`按身份显示导航方案.md`，本轮）。三张各自钉一件事：
  //   86 = **教导处**的桌面左栏（🆕 2026-10-01：比任课教师**多一项「行政管理」** ——
  //        在此之前它与任课教师逐项相同，本轮 `/manage` 是第一个"按身份不同"的左栏项）
  //   87 = **超管**的移动端展开层：多出「行政管理」那一项（N3：COLLAPSED 是可见差集，自动的）
  //   88 = **教导处**的「我的」页：三行入口搬走之后只剩「平台运维」那一行
  //        （原来这张钉的是"多出「教师账号」那一行"—— 本轮那一行搬去了 /manage）
  //   ⚠️ 任课教师那两张不需要新图：02/09 就是（今天全站账号都是任课教师）。
  '86-nav-role-desktop-admin.png',
  '87-nav-role-super-sheet.png',
  '88-nav-role-settings-admin.png',
  // 🆕 全站公告（2026-09-28 公告轮）。六张各自钉一件事：
  //   89 = 手机上的顶部横幅（置顶那条 = 独立横幅、普通那条 = 滚动条）
  //   90 = 点过滚动条的「×」之后：今天不再显示，但置顶那条无视它
  //   91 = **与 SyncErrorBanner 同时出现**（公告条给它让位，两条都读得到）
  //   92 = **公告弹窗礼让早间欢迎弹窗**（关掉之后才弹）
  //   93 = 桌面（左栏/右栏/内容列都在公告条之下，同一根 `--top-stack-h`）
  //   94 = 超管面板 ⑥ 全站公告那张卡（发/改/撤下/预览 + 编辑时的隐私提醒）
  '89-ann-bar-mobile.png',
  '90-ann-bar-hidden-today.png',
  '91-ann-with-sync-banner.png',
  '92-ann-popup-after-welcome.png',
  '93-ann-desktop.png',
  '94-admin-announcements.png',
  // 🆕 管理台第二期（2026-09-29）。八张各自钉一件事：
  //   95 = 面板**新结构**：分区导航 + 概览那一排数字磁贴（"更像管理台"）
  //   96 = 「数据库」分区（用量进度条 + 逐表排行 + 单份档案体积排行）
  //   97 = 「维护」分区（四条防呆 + 二次确认输入框 + 发测试邮件）
  //   98 = 「错误日志」分区（计数 + 关键字 + 勾选删除 + 隐私那一行）
  //   99 = 「反馈」分区（邮件没发出去那条红警告 + 明细）
  //  100 = **教师端被送进维护画面**（`?maint=…`；工作台内容整块消失）
  //  101 = **教室端全屏维护画面**（心跳照发 + 本页学生数据已清空）
  //  102 = 🔴 **维护中 /admin 仍然进得去**（"开了关不掉"的解药）
  //  103 = 「我的」页的**反馈块**（关于 → 反馈 → 更新日志，DOM 顺序有断言）
  '95-admin-sections-overview.png',
  '96-admin-db.png',
  '97-admin-maintenance.png',
  '98-admin-errors.png',
  '99-admin-feedback.png',
  '100-maint-teacher.png',
  // 103 = 超管从维护画面进来的密码框（2026-10-03 补）—— "开了关不掉"的解药：
  //       维护闸门连 /login 一起挡，没登录过的设备上超管原本进不来。
  '102b-maint-unlock.png',
  '101-maint-classroom.png',
  '102-maint-admin-exempt.png',
  '103-settings-feedback.png',
  // 🆕 2026-10-01「行政管理」（`/manage`）—— 一个页面、三张入口卡。
  //  104 = **教导处**打开 `/manage`（演示模式下摆两张卡：年级管理 + 档案管理；
  //        第三张「教师管理」要服务端，本地不摆 —— 判据含 isRemote，不是身份问题）
  //  105 = **任课教师**手打 `/manage`：一张卡都摆不出来、给一句说明（反向对照）
  //  ⚠️ 图号续在 103 之后，不清空旧图；`EXPECTED_FILES` 是**集合相等**，两张都登记了。
  '104-manage-admin.png',
  '105-manage-teacher.png',
  // 🆕 2026-10-06 学生档案（民族 / 出生年月 / 家长电话 / 家庭住址）：
  //  106 = 班级页 → 名单那一行的「档案」→ 浮层上的四个字段（科任老师那一侧：只读、不摆"修改档案"）
  '106-student-profile.png',
  // 🆕 顶层 tab 的「返回」（`/schedule` / `/wrong`，见 S6b 那一节）：
  //  58a = 从 tab 进日程表 → 返回回上一页（班级列表，不是「我的」）
  //  58b = 从「我的」那一行进日程表 → 返回回「我的」
  //  58c = **直开**日程表（书签/PWA）→ 返回回兜底 `/`（不退出应用）
  //  58d = **直开**错题集 → 同样回兜底 `/`
  //  ⚠️ 用 `58a–58d` 而不是接着 107 编：这四个是**顶层 tab 的返回**这一件事的四张证据，
  //     跟着 S6b 那一节走比接着图号排队更好找（`EXPECTED_FILES` 是集合相等，编号不参与比对）。
  '58a-back-schedule-tab.png',
  '58b-back-schedule-mine.png',
  '58c-back-direct-schedule.png',
  '58d-back-direct-wrong.png',
  // 🆕 2026-10-07 F3：年级管理里的「班级档案」展开条（见 S6c 那一节）。
  //  107 = `/grades` 上三个年级各有一条「班级档案」（与「开学准备」并列，收起态）
  //  108 = 点高二那条 → **向下展开**这个年级的全部班（行政班那一块）
  //  109 = 点展开条里的「高二(3)班」→ 进的**就是** `/classes/c-demo-1`（同一个班级档案页）
  '107-grade-archive-bar.png',
  '108-grade-archive-expanded.png',
  '109-grade-archive-class-detail.png',
  // 🆕 2026-10-12「课程管理」第 3 轮（调课与冲突）：骨架 / 临时 / 永久 / 冲突与建议
  '126-course-skeleton.png',
  '127-course-temp-apply.png',
  '128-course-perm-gate.png',
  '129-course-conflicts.png',
  // 🆕 2026-10-13「课程管理」第 5 轮（**整周视图**）：
  //  130 = 点「整周」之后那张 **7 列（周一~周日）× N 行（这一周真的出现过的时段）** 的表 +
  //        底部图例。默认仍然是「这一天」（核对流程的落点不许被挡住），所以这张必须**点一下**才有。
  //  ⚠️ 加图必须登记：`EXPECTED_FILES` 是**集合相等**，不登记就会红（编号不参与比对）。
  '130-course-week.png',
  // 🆕 2026-10-08（见 S8 那一节）：**「生成走班 → 班级页看名单」这条链**。
  //  110 = 本地演示模式下 `/classes` 上的走班班与那个 **0 人的班**：
  //        走班班那一行写「人数待读」（成员在 `class_members` 上，本地没有后端 → **不写 0 人**）；
  //        0 人的班写「还没有名单」（**不是**「名单完整」）。
  //        ⚠️ **只有这一张**：其余三张（注入假客户端之后的正向画面）在本轮实测里**跑不出来**
  //        —— `isRemote` 是构建期常量，注入假客户端会把页面踢回登录页。不摆假证据。
  '110-stream-classes-nokb.png',
  // 🆕 2026-10-08「导航项那一块溢出时自己滚 + 交界处渐隐」（见 B1c 那一节）：
  //  114 = 矮视口（1440×500）滚到**中间**：导航项上下**两端都有渐隐**（mask，不是盖色），
  //        底部的「已连接云端 / N 个班级」仍在最底下没动；
  //  115 = 高视口（1440×1200）放得下：**没有滚动条、也没有渐隐**（反向对照的那一半）。
  '114-rail-scroll-mid.png',
  '115-rail-fit-tall.png',
  // 🆕 2026-10-08（见 S10 那一节）：**走班班的编辑 / 删除** + 右栏「名单体检」的 0 人。
  //  111 = 宽视口下 `/classes` 的**右栏「名单体检」**：0 人的班写「还没有名单」而**不画绿勾**，
  //        走班班那一行写「人数待读」（成员在 `class_members` 上，本地读不到 → 不许写 0 人）。
  //  112 = 走班班的**编辑面板**（改名 / 换走班老师 / 手工增删成员 + 删除入口）。
  '111-classes-health-zero.png',
  '112-stream-edit-sheet.png',
  // 🆕 2026-10-09 F4：**暗色主题**（见最后那一节）。
  //  ⚠️ 这四张是**暗色**（前 112 张仍是亮色，一张都不许变）：
  //  116 工作台 / 117 班级 / 118 管理台（`/admin`）/ 119 **教室端在暗色偏好下仍然是亮色**
  //  —— 最后那张是这一轮唯一一条"必须和偏好相反"的证据。
  '116-dark-workbench.png',
  '117-dark-classes.png',
  '118-dark-admin.png',
  '119-classroom-still-light.png',
  // 🆕 2026-10-10 F6：**强调色轴**（`data-accent` = blue | purple，见最后那一节）。
  //  ⚠️ 上面那 129 张（含 116~119 四张暗色）**一张都不许变**：蓝套一个令牌没动，
  //     所以"没选过强调色的用户"看到的画面与这一轮之前逐字相同。
  //  120/121 = **亮紫**（工作台 / 班级）；122/123 = **暗紫**（工作台 / 管理台）；
  //  124 = **选择器本身**（亮紫下把那张小面板打开）—— 它是"4 套"这个交互的留档。
  '120-purple-workbench.png',
  '121-purple-classes.png',
  '122-darkpurple-workbench.png',
  '123-darkpurple-admin.png',
  '124-theme-picker.png',
  // 🆕 2026-10-11（见 S26 那一节）：**「我的身份」卡里多了一段「改密码」**。
  //  125 = 那张卡打开、三格填成"太短"之后的样子 —— 屏上**明写着错误原因**（不是静默不提交）。
  //  ⚠️ 图号接着 124 编；`EXPECTED_FILES` 是**集合相等**，所以这一张不登记就会红。
  '125-settings-change-password.png',
  // 🆕 2026-10-04「版本更新公告」（见 S2 ⑥b 那一节，DEV 钩子 `?rel=…` 驱动）。
  //  131 = **强制那一档**：教师端**整屏接管**（没有关闭 ×、没有「稍后」、Esc 也关不掉，
  //        工作台/导航一个字都不渲染）；132 = **选择性那一档**：有关闭 × 与「稍后」，
  //        关掉之后照常用（所以它必须**保留 children**）。
  //  ⚠️ 图号挑的是当前最大 1xx（130）之后的两个空闲号；`EXPECTED_FILES` 是集合相等，两张都要登记。
  '131-release-force.png',
  '132-release-soft.png',
]

/* ---------------- 断言与日志 ---------------- */

/**
 * 🆕 F4：**亮色的那一组 24 个 `--color-*` 令牌**（暗色块里必须逐个有一份）。
 *
 * 为什么把它放在模块级而不是某一节里：**两处**要用它（源码级那一节 + 浏览器里读值时），
 * 而"同一件事两个清单"这个仓库栽过不止一次。加令牌时**只改这一处**。
 */
const COLOR_TOKENS = [
  'canvas', 'surface', 'surface2', 'surface3',
  'line', 'line2', 'line3',
  'ink', 'ink2', 'ink3', 'ink4',
  'accent', 'accentink', 'accentsoft', 'cyan', 'cyansoft',
  'ok', 'oksoft', 'warn', 'warnsoft', 'bad', 'badsoft', 'idle', 'idlesoft',
]

let passed = 0
const failures = []
/** 当前步骤名（失败摘要里要说"停在哪一步"） */
let currentStep = '(还没开始)'
/** 每张图归属的步骤：name → step */
const shotOwner = new Map()
/** 实际写出的文件（有重复写入就当场记下来） */
const written = []
const dupWrites = []

function check(ok, label, observed, extra = '') {
  /*
   * 🔴 参数写反的兜底（2026-10-13）：签名是 `check(条件, 标签, 实测)` —— **条件在第一个**。
   *    写反成 `check('标签', 条件, 实测)` 时，`ok` 拿到的是那句标签字符串（非空 ⇒ 恒真）
   *    ⇒ 这条断言**永远是绿的**；比"抓不到 bug"更坏：它让人以为验过了。
   *    全仓审计出 27 处（学生档案 04b/04c/04d 10 处 · 改班内学号/收缴/改回 9 处 ·
   *    班主任调课 04e 6 处 · `grade_delete` / `teacher_profiles` 源码断言各 1 处），
   *    同一天已逐处对调过来。留这道兜底：以后再写反，**当场红**，绝不静默通过。
   */
  if (typeof ok === 'string') {
    const first = JSON.stringify(ok.slice(0, 60))
    failures.push(`[${currentStep}] 🔴 check() 参数写反（条件必须在第一个）：${first}`)
    console.log(`     🔴 check() 参数写反 —— 第一个参数是字符串：${first}`)
    return
  }
  if (ok) {
    passed++
    console.log(`     ✅ ${label}\n          实测：${observed}${extra ? ` （${extra}）` : ''}`)
  } else {
    failures.push(`[${currentStep}] ${label} —— 实测：${observed}${extra ? `（${extra}）` : ''}`)
    console.log(`     ❌ ${label}\n          实测：${observed}${extra ? ` （${extra}）` : ''}`)
  }
}

/** 每一步一个名字：失败摘要要能一眼看出停在哪（同名步骤只印一次标题） */
const printedSteps = new Set()
/** 只给排查这一节用的临时开关（见下）：是否已经走过移动端导航那一节 */
let sawMobileNavShot = false
/**
 * 🔴 `SHUGAO_ONLY_COURSE=1` → **跑完「课程管理」那一节就停**，不跑后面那几节。
 *
 * 为什么加它：课程管理这一段要反复调（临时/永久两条路、三类冲突、建议算法），
 * 而整套 `shots` 一次 7 分钟 —— 每改一行跑一次全量就是 `AGENTS.md` §2.2.1 点名的那种烧法。
 * ⚠️ 与 `SHUGAO_ONLY_NAV` 同一个口径：**只用于排查**，正式验收不许带这个变量
 *    （它会故意报一条"异常中断"，所以整套结果不算数）。
 */
const ONLY_COURSE = Boolean(process.env.SHUGAO_ONLY_COURSE)
/** 课程管理那几节跑过了没（`ONLY_COURSE` 的"跑到就停"靠它判断"该不该继续往下"） */
let sawCourse = false
async function step(name, fn) {
  /*
   * 只给**排查这一节**用的临时开关（正常跑不受影响、不设它就没有任何变化）：
   * `SHUGAO_ONLY_NAV=1` → 跑完「更多入口 · 展开层」那一节就停，不跑后面 90 多张图。   * 调层叠/安全区这种改动时，整套要几分钟而这一节只要几十秒。
   * ⚠️ 它会故意报一条"异常中断"，所以**只能在排查时用**，别在正式验收里带这个变量。
   */
  if (name.startsWith('35–37')) sawMobileNavShot = true
  else if (process.env.SHUGAO_ONLY_NAV && sawMobileNavShot) {
    throw new Error(`SHUGAO_ONLY_NAV：只跑到展开层那一节，不跑后面的「${name}」`)
  }
  /*
   * 🆕 2026-10-13：S27 现在是**四节**（骨架 / 临时落地 / 永久闸门 / 冲突与建议），
   * 而这条"跑到就停"的开关原来只认第一节（名字里带「课程管理」的那个）——
   * 于是排查 ㊶ 那种"在最后一节里"的判据时，**根本跑不到那儿就停了**。
   * 现在：`SHUGAO_ONLY_COURSE=1` = **把这四节都跑完**再停（`role=` 可只挑其中几节）。
   */
  const coursePick = (process.env.SHUGAO_ONLY_COURSE_ROLE ?? '').split(',').filter(Boolean)
  const isS27 = name.startsWith('S27')
  /*
   * 🔴 2026-10-01 修掉了这个开关自己的 bug：原来是
   *   `isS27Core || !coursePick.length || coursePick.some(...)` ——
   * 不给 `role=` 时 `!coursePick.length` **恒真** ⇒ 每一节都被算进"课程管理那一节"，
   * 于是"跑到课程管理就停"从来没有生效过：以为在跑 3 分钟的节级驱动，其实每次都跑满 7 分钟的整套
   * （查 ㉗ 时就踩在这个坑上：两轮"节级"跑的其实是全量）。
   * 正确口径：**先限定在 S27 那几节里**，`role=` 只在这几节里再挑。
   */
  const inCourseSet = isS27 && (!coursePick.length || coursePick.some((r) => name.includes(r)))
  if (ONLY_COURSE && !inCourseSet) {
    if (sawCourse) {
      throw new Error(`SHUGAO_ONLY_COURSE：课程管理那几节跑完了，不跑后面的「${name}」`)
    }
    /* 课程管理**还没开始**的节：静默跳过（不跑、不打日志） */
    return
  }
  if (ONLY_COURSE && isS27) sawCourse = true
  if (ONLY_COURSE && process.env.SHUGAO_DIAG_STEP === '1') {
    console.error(`[DIAG] step=${JSON.stringify(name)} core=${isS27Core} in=${inCourseSet} saw=${sawCourse} pick=${JSON.stringify(coursePick)}`)
  }
  if (!printedSteps.has(name)) {
    printedSteps.add(name)
    console.log(`\n── ${name}`)
  }
  currentStep = name
  await fn()
}

const short = (s, n = 150) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 🆕 2026-09-27：那颗图标是不是 `icons.tsx` 里的 **`IconEyeOff`（"不再显示"）**、
 * **不是 `IconTrash`（垃圾桶）** —— 按 **path 的形状**判，不按类名、不按属性名：
 *   · `IconEyeOff` 那一撇 = `m4 4 16 16`；
 *   · `IconTrash` 的盖子 = `M4.6 7.2h14.8`（第一笔）。
 * 传进来的是一组 `<path d="…">` 的 `d`（DOM 里取回来的、或 `icons.tsx` 源码里解析出来的 ——
 * 两处用**同一个**判据，所以"它能不能红"只需要验一次，见「撤下图标」那一节）。
 */
const looksLikeEyeOff = (ds) =>
  (ds ?? []).some((d) => String(d).includes('m4 4 16 16')) &&
  !(ds ?? []).some((d) => String(d).startsWith('M4.6 7.2h14.8'))

/**
 * 🆕 F6：在那颗入口钮打开的**主题选择器**里选一档。
 *
 * 为什么要有这个函数：F6 起入口钮"点一下"= **开选择器**（不是直接翻一档），
 * 所以"切亮/切暗/换强调色"这三件事都要走"开面板 → 选一下"。
 * ⚠️ **幂等**：面板已经开着就**不再点**入口钮（第二下是"关"，接下来那一下会点空、
 *    变成一条假红）。判据是 `[data-theme-panel]` 在不在。
 */
async function panelPick(page, kind, value) {
  if ((await page.locator('[data-theme-panel]').count()) === 0) {
    await page.locator('[data-theme-toggle]:visible').first().click()
    await page.waitForTimeout(150)
  }
  await page.locator(`[data-${kind}-option="${value}"]`).first().click()
  await page.waitForTimeout(220)
}

/** 面包屑：真出错时（超时、找不到元素）至少知道是**哪一步的哪一句** */
const crumbs = []
function crumb(msg) {
  crumbs.push(`${currentStep} :: ${msg}`)
  console.log(`     · ${msg}`)
}

/* ---------------- 页面探针 ---------------- */

/**
 * 一次 evaluate 把断言要用的东西全取回来。
 * `h1` 取的是页面标题（ui.tsx 的 PageHead 渲染成 `<h1>`）；
 * `body` 是 innerText（**包含浮层**，所以判断"弹窗开着没"要看 `.modal`）。
 *
 * ⚠️ 当前页那一格的高亮标记是**内层 span** 上的 `data-active`（见 AppShell 的 PinTab），
 *    外面那个 `<a>` 上挂的是 `aria-current="page"` —— 两个都读，别只读一个。
 */
async function pageInfo(page) {
  /*
   * E6（2026-10-02）路由分包后：**每一次读屏前**先等 `[data-page-fallback]` 退场。
   * 关口放在这里而不是各个调用点 —— 断言往往是"上一次导航之后紧接着读一次"，
   * 读到「加载中…」就等于读了一屏没渲染完的 DOM（2026-10-01 验收实测 10 条假红全出在这）。
   */
  await waitPageSettled(page)
  return page.evaluate(() => {
    const norm = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    const nav = document.querySelector('nav[aria-label="主导航"]')
    const navActive = nav
      ? [...nav.querySelectorAll('span[data-active="true"]')]
          .map((s) => s.closest('a')?.getAttribute('aria-label') ?? '')
          .filter(Boolean)
      : []
    return {
      url: location.pathname + location.search,
      h1: [...document.querySelectorAll('h1')].map((h) => norm(h.textContent)),
      sects: [...document.querySelectorAll('.sect')].map((s) => norm(s.textContent)),
      body: norm(document.body.innerText),
      modalOpen: Boolean(document.querySelector('.modal')),
      modalText: norm(document.querySelector('.modal')?.innerText ?? ''),
      sheetOpen: Boolean(document.querySelector('.sheet')),
      sheetTitle: norm(document.querySelector('.sheet h2')?.textContent ?? ''),
      navActive,
      navAll: nav
        ? [...nav.querySelectorAll('a')].map((a) => a.getAttribute('aria-label') ?? '')
        : [],
      /** 高亮胶囊（当前页那一块玻璃）的几何：切页/拖动时它应该跟着动 */
      hi: (() => {
        const el = nav?.querySelector('span[aria-hidden="true"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          left: Math.round(r.left),
          width: Math.round(r.width),
          opacity: getComputedStyle(el).opacity,
        }
      })(),
      /** 胶囊本体的几何（**不含**外层那条 max-width 包裹带）—— 拖拽要用它算坐标 */
      capsule: (() => {
        const el = nav?.querySelector('div')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left, y: r.top, width: r.width, height: r.height, clientLeft: el.clientLeft }
      })(),
    }
  })
}

async function bodyText(page) {
  /* 同 `pageInfo`：读屏前先等路由兜底退场（这个函数是各处**自定义断言**的取文本口） */
  await waitPageSettled(page)
  return page.evaluate(() => String(document.body.innerText ?? '').replace(/\s+/g, ' ').trim())
}

/**
 * 屏上那句日期（工作台问候上方那行，`9 月 19 日 · 周六`）。
 * 这是**产品自己渲染出来的**日期，用它核对假时钟有没有真的生效 ——
 * 照 `clock-checks.mjs:307-308` 那条"屏上时钟 == 钉的时钟"的纪律。
 */
async function dateOnScreen(page) {
  return page.evaluate(() => {
    const re = /^\d{1,2} 月 \d{1,2} 日 · 周[日一二三四五六]$/
    const hit = [...document.querySelectorAll('div,span,section,p')]
      .map((d) => (d.textContent ?? '').replace(/\s+/g, ' ').trim())
      .find((t) => re.test(t))
    return hit ?? null
  })
}

/**
 * **每张截图前都要过的门**：URL 对 + 该页独有的文本在屏上。
 *
 * `url` 可以是字符串（精确）或正则（带参数的路径用它）。
 * `markers` 必须是**这一页独有**的文本：不能用"作业""我的"这类到处都是的词，
 * 否则登录页里也找得到，等于没断言（`clock-checks.mjs` 里那五条假断言就是这么来的）。
 *
 * `allowModal`：这一步本来就该有弹窗（欢迎弹窗 / 完成弹窗）时给一个**该弹窗的独有文案**。
 * 给 `true` 等于放弃检查，所以只在自己都说不清的时候用 ——
 * 传字符串时若屏上有弹窗、文案对不上，照样红（这比"整步跳过弹窗检查"强得多）。
 */
async function expectPage(page, label, { url, markers = [], absent = [], allowModal = false }) {
  /*
   * `pageInfo` 只保证"路由兜底退场了"。还有第二种"还没好"：这一次读屏比 React 把
   * 新页提交上去更早（读到的还是上一页）。正向标记能等就等 —— 等「这页该有 X」，
   * 最多 8s。**只等 `markers`**：`absent` 是负向断言，等它既没意义、又等于放水。
   * 等不到照样往下走，后面的 check 原样去红（不吞错、不假装通过）。
   */
  let info = await pageInfo(page)
  if (markers.length) {
    const t0 = Date.now()
    while (!markers.every((m) => info.body.includes(m))) {
      if (Date.now() - t0 > 8000) break
      await page.waitForTimeout(150)
      info = await pageInfo(page)
    }
  }
  const esc = (s) => s.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  const wantUrl = url instanceof RegExp ? url : new RegExp(`^${esc(url)}$`)
  check(
    wantUrl.test(info.url),
    `${label}：URL 正确（还在不在这一页）`,
    `屏上 url = ${info.url}`,
    `期望 ${url instanceof RegExp ? String(url) : url}`,
  )
  for (const m of markers) {
    check(info.body.includes(m), `${label}：屏上有本页独有文本「${m}」`, short(info.body, 110))
  }
  for (const a of absent) {
    check(!info.body.includes(a), `${label}：不该出现的「${a}」确实不在`, short(info.body, 110))
  }
  if (typeof allowModal === 'string') {
    check(
      !info.modalOpen || info.modalText.includes(allowModal),
      `${label}：屏上的弹窗是「${allowModal}」（不是别的东西弹出来了）`,
      info.modalOpen ? `弹窗文案：${short(info.modalText, 90)}` : '没有弹窗',
    )
  } else if (!allowModal) {
    // 早上 6:30–9:00 第一次打开会弹「早上好」（useMood 的 welcomeOpen）。
    // 除了 42/48 那两步，其余步骤的时钟都不在那个窗口里 —— 弹窗不该在。
    // 这个检查顺带证明"时钟拨对了"：拨错成早上，它会立刻红。
    check(
      !info.modalOpen,
      `${label}：没有意料之外的弹窗`,
      info.modalOpen ? `屏上开着 .modal（${short(info.modalText, 80)}）` : '无 .modal',
    )
  }
  return info
}

/**
 * 拨表之后核对**屏上日期**（照 clock-checks.mjs 那条纪律）。
 * `required` 用来说明这一页**本该**有日期行；没有的话（比如 /exams/new）
 * 只能记一条"这页没有可核对的日期行"，不能说"核对通过"。
 */
async function clockOnScreen(page, expectDate, required = false) {
  const on = await dateOnScreen(page)
  if (on === null && !required) {
    console.log(`     · 这一页没有日期行（${expectDate}），跳过一次屏上核对`)
    return on
  }
  check(
    on === expectDate,
    '假时钟真的生效了（把屏上日期读回来核对）',
    `屏上「${on ?? '(没读到)'}」`,
    `钉的是「${expectDate}」`,
  )
  return on
}

/** 导航 + 断言"我在对的页面"；`date` 给定时顺带核对屏上日期 */
async function goto(page, stepName, path, expect = {}) {
  await step(stepName, async () => {
    crumb(`goto ${path}`)
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    /* 整页加载也会经历一次 lazy 路由（dev 下是整条模块瀑布）—— 读之前先等兜底退场 */
    await waitPageSettled(page)
    await expectPage(page, stepName, { url: expect.url ?? path, ...expect })
    if (expect.date) await clockOnScreen(page, expect.date)
  })
}

/**
 * **同文档**（SPA）导航：只换 URL、让 react-router 重渲染，**不重新加载文档**。
 *
 * 为什么需要它：夹具那个 `addInitScript`（见本文件 S1 开头）在**每次整页导航**时
 * 都会把 `shugao.teacher.v1` 重写成注入的那份快照。于是"先在页面上改点什么、
 * 再去另一页看结果"这类断言，用 `page.goto` 走就**必然读到改之前的世界** ——
 * 改的东西在整页加载时被冲掉。2026-10-02 的 09c（改班内学号 → 看收缴档案）就是这么红的：
 * 断言本身没错，是**走错了导航**，而它先前一直"绿"只是因为 27 处 `check()` 参数写反。
 *
 * 用法与 `goto` 完全一样（同样等懒加载路由退场、同样按 `expect` 校屏），
 * 只是把"加载文档"换成 `pushState + popstate`。前提：**当前这一屏已经在应用里**
 * （已登录、store 已经起来）—— 从登录页出发的那几步仍然该用 `goto`。
 */
async function spaGoto(page, stepName, path, expect = {}) {
  await step(stepName, async () => {
    crumb(`spa ${path}`)
    await page.evaluate((p) => {
      window.history.pushState({}, '', p)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, path)
    await waitPageSettled(page)
    await expectPage(page, stepName, { url: expect.url ?? path, ...expect })
    if (expect.date) await clockOnScreen(page, expect.date)
  })
}

/**
 * E6（2026-10-02）路由分包后的配套等待：页面是 `lazy` 的，SPA 导航 = 先落 URL、
 * 再现拉那个页面的 chunk —— 期间屏上是 `[data-page-fallback]`（"加载中…"）。
 * **等条件，不等固定毫秒**（同一教训 §35-37 那三条 2026-10-11 已踩过一次）：
 * 等它退场，最多 `ms`；超时**照常返回**让断言去读、去红 —— 不吞错、不假装等到。
 * （chunk 在 dev 是整条模块瀑布、在 prod 是单个文件；都远快于这个上限的常态。）
 */
async function waitPageSettled(pg, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    let stuck
    try {
      stuck = await pg.evaluate(() => Boolean(document.querySelector('[data-page-fallback]')))
    } catch {
      /* 调用点常紧贴一次导航（navGoto 的 location.replace）—— 执行环境被掀掉时等一拍重试 */
      if (Date.now() - t0 > ms) return false
      await pg.waitForTimeout(120)
      continue
    }
    if (!stuck) return true
    if (Date.now() - t0 > ms) return false
    await pg.waitForTimeout(120)
  }
}

/* ---------------- 截图 ---------------- */

async function shot(page, stepName, name, { full = false, wait = 520, expect = null } = {}) {
  return step(stepName, async () => {
    const file = `${name}.png`
    if (!EXPECTED_FILES.includes(file)) {
      check(false, `截图 ${file} 在预期清单里`, '不在 EXPECTED_FILES 里', '加图要同时更新清单')
    }
    if (shotOwner.has(name)) {
      dupWrites.push(`${file}：既属于「${shotOwner.get(name)}」又属于「${currentStep}」`)
      check(false, `文件名 ${file} 只被写一次`, `已经由「${shotOwner.get(name)}」写过`, '撞车会互相覆盖')
    }
    shotOwner.set(name, currentStep)
    await page.waitForTimeout(wait)
    /*
     * 截图本身也要"落定"：`shot` 的调用点里很多没带 `expect`（纯拍照），兜底还在的时候
     * 拍下去，基线图上就是一句「加载中…」（比断言红更难发现）。
     * 放在固定 `wait` **之后**：`wait: 0` 那几张要的是"这一瞬间"的画面，不能被拉长。
     */
    await waitPageSettled(page)
    if (expect) await expectPage(page, `${stepName} · ${file}`, expect)
    await page.screenshot({ path: join(OUT, file), fullPage: full })
    written.push(file)
    console.log(`     📷 ${file}${full ? '（整页）' : ''}`)
  })
}

/** 直接 page.screenshot 的那几处（教室端 / 桌面 / 弹窗）统一走它，好记账 */
async function shotRaw(page, stepName, name, { full = false } = {}) {
  return step(stepName, async () => {
    const file = `${name}.png`
    if (!EXPECTED_FILES.includes(file)) {
      check(false, `截图 ${file} 在预期清单里`, '不在 EXPECTED_FILES 里')
    }
    if (shotOwner.has(name)) {
      dupWrites.push(`${file}：既属于「${shotOwner.get(name)}」又属于「${currentStep}」`)
      check(false, `文件名 ${file} 只被写一次`, `已经由「${shotOwner.get(name)}」写过`)
    }
    shotOwner.set(name, currentStep)
    await page.screenshot({ path: join(OUT, file), fullPage: full })
    written.push(file)
    console.log(`     📷 ${file}${full ? '（整页）' : ''}`)
  })
}

/*
 * 🔒 **整个脚本的工作都在这把锁里面**（`%TEMP%\shugao-verify.lock`，见 scripts/lib/lock.mjs）：
 * 五个验证脚本共用一把锁，同一时刻只允许一个在跑 —— 它们抢同一个 dev server（5178）、
 * 同一批 localStorage 断言、同一套拨表，并发跑会互相污染（审计实测过：两个 shots
 * 同时写同一个输出目录、两条序列交错）。等不到锁就会**打印持有者并退出**；
 * 脚本异常中断时锁也一定释放（try/finally）。
 */
await withLock(async () => {
    /* ---------------- 主流程 ---------------- */

    const errors = []
    let browser = null

    mkdirSync(OUT, { recursive: true })

    try {
      console.log('【截图冒烟 · 教师端】')
      console.log(`  目标：${BASE}`)
      console.log(`  输出：${OUT_REL}/（本轮 ${EXPECTED_FILES.length} 张）`)

      /* ================= S0：待办口径（纯函数 · 与浏览器无关） =================
       *
       * 🔴 **「看得见」≠「待办」**（`功能设计与不变量.md`）：
       *    · **看得见**是数据库（RLS）给的 —— 班主任 / 年级主任 / 教务处看得见整班各科的
       *      作业档案，那是"看"的权限，**本轮一个字没动**（`/assignments` 照旧列全班各科）；
       *    · **待办**是"我要干的活" —— 一条作业进我的待办，当且仅当它的 `(班, 科)`
       *      在我的任教关系（`class_subjects`）里（`lib/teaching.ts`，唯一判定入口）。
       *
       * 这一组不需要页面（判据是纯函数），所以放在启动 Edge 之前；第 ⑩ 条再从**源码**上
       * 钉一句"工作台那一屏真的走这个判据" —— 免得以后页面被改回旧写法而这一组还是绿的。
       */
      await step('00 待办口径（纯函数）', async () => {
        const { pendingForMe, isMyTodo, teachesClassSubject, isTodoStatus } = await import(
          '../src/lib/teaching.ts'
        )
        const ME = 't-me'
        const OTHER = 't-other'
        /* 我的任教关系：高二(3) 的物理 + 那个**走班班**的政治（= P7「分配走班老师」自动补进去的那一行的形状） */
        const rel = [
          { classId: 'c-3', subjectCode: 'physics', teacherId: ME },
          { classId: 'c-3', subjectCode: 'math', teacherId: OTHER },
          { classId: 'c-7', subjectCode: 'chinese', teacherId: OTHER },
          { classId: 'c-stream-politics', subjectCode: 'politics', teacherId: ME },
        ]
        /* 一次快照里能看见的档案（= RLS 给的那一份，各科都在） */
        const rows = [
          { id: 'x1', classId: 'c-3', subjectCode: 'physics', subject: '物理', status: 'collected' },
          { id: 'x2', classId: 'c-3', subjectCode: 'math', subject: '数学', status: 'collected' },
          { id: 'x3', classId: 'c-stream-politics', subjectCode: 'politics', subject: '政治', status: 'open' },
          { id: 'x4', classId: 'c-7', subjectCode: 'chinese', subject: '语文', status: 'open' },
          { id: 'x5', classId: 'c-3', subjectCode: 'physics', subject: '物理', status: 'graded' },
          { id: 'x6', classId: 'c-3', subjectCode: 'math', subject: '数学', status: 'open' },
        ]
        const ids = (list) => list.map((a) => a.id).sort().join(',') || '（空）'
        const mine = pendingForMe(rows, rel, ME)

        /* ① 班主任：数学**看得见**，但不是他教的 → 不进待办（本轮修的那条） */
        check(
          rows.filter((a) => isTodoStatus(a.status)).some((a) => a.id === 'x2'),
          '待办①：班主任**看得见**本班那份数学作业（"看"的那一面照旧给）',
          `输入里那份数学（x2 · 待批改）在可见档案里 = ${rows.some((a) => a.id === 'x2')}`,
        )
        check(
          !mine.some((a) => a.id === 'x2') && !mine.some((a) => a.id === 'x6'),
          '待办①（🔴 本轮修的）：班主任的待办里**没有**数学（他不上这一科）→ 不再有"点进去改不了"的死路待办',
          `他的待办 = ${ids(mine)}`,
        )

        /* ② 任课老师：自己那一科（待批改）在待办里 */
        check(
          mine.some((a) => a.id === 'x1'),
          '待办②：任课老师自己那一科的档案在待办里（待批改）',
          `他的待办 = ${ids(mine)}`,
        )

        /* ③ 走班班老师：走班班的作业要落进来（走班班也是 `classes` 一行，判据不开特例） */
        check(
          teachesClassSubject(rel, ME, 'c-stream-politics', 'politics'),
          '待办③：走班班的任教关系命中（`class_subjects` 那行：走班班 id + 那一科 + 我）',
          'c-stream-politics · politics · t-me',
        )
        check(
          mine.some((a) => a.id === 'x3'),
          '待办③b：**走班班的作业落进了走班老师的待办**（做题的规则与行政班同一条）',
          `他的待办 = ${ids(mine)}`,
        )

        /* ④ 纯超管（不教课）：看得见全部，但一条任教关系都没有 → 待办为空 */
        const superTodo = pendingForMe(rows, [], 't-super')
        check(
          superTodo.length === 0 && rows.length > 0,
          '待办④：纯超管（看得见全部 6 份档案、但一条任教关系都没有）→ **待办为空**',
          `可见档案 ${rows.length} 份，他的待办 = ${ids(superTodo)}`,
        )

        /* ⑤ 不教这一科的年级主任：待办里只有他自己教的那一科 */
        const deanTodo = pendingForMe(rows, [{ classId: 'c-7', subjectCode: 'chinese', teacherId: 't-dean' }], 't-dean')
        check(
          ids(deanTodo) === 'x4',
          '待办⑤：不教数学 / 物理的年级主任 → 待办里只有他自己教的语文（x4）',
          `他的待办 = ${ids(deanTodo)}`,
        )

        /* ⑥ 三态：任教关系**不知道**（还没读回来 / 读失败 / 本地演示模式没有数据库）→ 不筛 */
        const unknown = pendingForMe(rows, null, ME)
        check(
          ids(unknown) === 'x1,x2,x3,x4,x6',
          '待办⑥：任教关系**不知道**时**不筛**（宁多不藏 —— 待办少一条比多一条危险）',
          `待办 = ${ids(unknown)}`,
        )

        /* ⑦ 反向对照（常驻）：按**旧的"只按 status"**筛，数学就在里面 —— 证明①不是靠"数据里本来没有数学"才绿的 */
        const legacy = rows.filter((a) => a.status === 'open' || a.status === 'collected')
        check(
          ids(legacy) === 'x1,x2,x3,x4,x6' && !ids(mine).includes('x2'),
          '待办⑦（反向对照）：同一份数据按旧的"只按 status"筛 → 数学 x2/x6 混了进来（bug 的样子）；按任教关系筛 → 不在',
          `旧 = ${ids(legacy)}；新 = ${ids(mine)}`,
        )

        /* ⑧ 状态那一半照旧：已批改（graded）永远不是待办 */
        check(
          !isTodoStatus('graded') && !mine.some((a) => a.id === 'x5'),
          '待办⑧：已批改（graded）不是待办（状态口径照旧，只多了任教关系这一半）',
          `x5（已批改）在待办里 = ${mine.some((a) => a.id === 'x5')}`,
        )

        /* ⑨ 老档案的学科认不出来（`subjectCodeOf` 反查不到字典）→ 按"我教这个班"放行，不许静默丢待办 */
        check(
          isMyTodo({ classId: 'c-3', subject: '物理竞赛', status: 'open' }, rel, ME) &&
            !isMyTodo({ classId: 'c-8', subject: '物理竞赛', status: 'open' }, rel, ME),
          '待办⑨：学科认不出的老档案 → 我教这个班就放行（c-3 进）；我完全不教的班仍然不进（c-8 不进）',
          'c-3 → 进；c-8 → 不进',
        )

        /* ⑩ 源码级：工作台那一屏**真的**走这个判据（否则上面全绿也没意义） */
        const wb = readFileSync(join(HERE, '..', 'src', 'pages', 'Workbench.tsx'), 'utf8')
        check(
          (wb.match(/pendingForMe\(/g) ?? []).length === 1,
          '待办⑩：`Workbench.tsx` 的待办**恰好有一处** `pendingForMe()`（判据只有一份，不是页面里再抄一遍）',
          `pendingForMe( 出现 ${(wb.match(/pendingForMe\(/g) ?? []).length} 次`,
        )
        check(
          !/filter\(\s*\(a\)\s*=>\s*a\.status === 'open'\s*\|\|\s*a\.status === 'collected'/.test(wb),
          '待办⑩b（对照的机器版）：`Workbench.tsx` 里**不再有**"只按 status 筛待办"的那一句（改回去这条就红）',
          /filter\(\s*\(a\)\s*=>[^\n]*status === 'open'/.test(wb) ? '还能搜到"只按 status 筛"的写法' : '搜不到旧写法',
        )
        check(
          /v: pending\.length/.test(wb) && /pending\.length \? `\$\{pending\.length\} 份待处理`/.test(wb),
          '待办⑩c：那一格「待办」数字与快捷操作上的「N 份待处理」都数**同一个 `pending`**（同一次调用，不会两处打架）',
          'v: pending.length 与 `${pending.length} 份待处理` 都在',
        )
      })

      browser = await launchBrowser({ headless: true })
      const ctx = await browser.newContext({
        viewport: { width: 414, height: 880 },
        deviceScaleFactor: 2,
        locale: 'zh-CN',
      })

      /*
       * 时钟：**唯一**的一处（不再自建 Date 桩，理由见文件头）。
       * `install()` 必须在本文件所有 `addInitScript` **之前** ——
       * Playwright 的 clock 自己也是 initScript，谁后注册谁生效。
       *
       * 钟面钉在 2026-09-19（周六，也是演示数据的日期）：教室端有一批"按钟点切换"的行为
       * （19:20 后作业区换收尾语、课前 5 分钟下课铃、周三下午静音），不钉的话
       * 同一份代码**白天跑得过、晚上跑不过**。下面各步再逐步拨表。
       */
      await ctx.clock.install({ time: new Date('2026-09-19T10:00:00') })

      await ctx.addInitScript((s) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
        // 设备角色：这台是教师端。教室端那一段跑完会被产品标成 classroom，
        // 到那一步之后再显式改回来（见 S5 那一节的注释）。
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE)

      const page = await ctx.newPage()
      page.on('pageerror', (e) => errors.push(`PAGEERROR ${page.url()} :: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE ${page.url()} :: ${m.text()}`)
      })

      /* ================= S1：登录 / 工作台 / 班级 / 导入 / 设置 ================= */

      const D0919 = '9 月 19 日 · 周六'

      await goto(page, '01 登录页', '/login', {
        markers: ['树高教务通', '账号登录', 'TEACHER CONSOLE'],
        // 演示模式（无 Supabase）下不该出现"登录过期"的提示
        absent: ['距上次在这台设备上登录已超过'],
      })
      await shot(page, '01 登录页', '01-login')

      await goto(page, '02 工作台', '/', {
        markers: ['今日待办', '快捷操作'],
        date: D0919,
      })
      await shot(page, '02 工作台', '02-workbench', { full: true })

      await goto(page, '03 班级列表', '/classes', {
        markers: ['2 个班级 · 91 名学生', '名单完整'],
      })
      await shot(page, '03 班级列表', '03-classes', { full: true })

      await goto(page, '04 班级详情', '/classes/c-demo-1', {
        markers: ['学生名单 · 45 人', '名单体检通过'],
      })
      await shot(page, '04 班级详情', '04-class-detail', { full: true })

      /* ===== 04b–04d：学生档案（民族 / 出生年月 / 家长电话 / 家庭住址）=====
       *
       * 表是 `student_profiles`（`supabase/schema.sql` §2.1 建表 / §35 策略）。
       * 🔴 **判据全在数据库**：读 = `visible_class_ids()`（看得见哪些班）且**不是教室端**；
       *    写 = `can_manage_class()`（超管 / 教务处 ∪ 本年级年级主任 ∪ **本班班主任**）——
       *    那一侧由 `rls-checks` 第十九节逐身份验（含"教室端 0 行"）。这里只验**界面这一层**：
       *      ① 默认身份（演示模式 = 任课教师）：四个字段看得见，**不摆**"修改档案"；
       *      ② `?as=head_teacher`（班主任）：**摆**，而且录入 → 保存 → 屏上就看得到；
       *      ③ 反向对照 `?as=teacher`（明写任课教师）：**又不摆** —— 证明②不是"恒摆"。
       * ⚠️ 本地演示模式没有数据库，但这一页**不走探针**（`loadStudentProfiles` 在
       *    `!isRemote` 时直接读内存那份，见 `lib/studentProfile.ts`），所以屏上是
       *    「未录入」而**不是**「读不到」—— 那两句话在界面上是分开的，别混。
       */
      await goto(page, '04b 学生档案（科任老师只读）', '/classes/c-demo-1', {
        markers: ['学生名单 · 45 人', '档案'],
      })
      await step('04b 学生档案（科任老师只读）', async () => {
        await page.getByRole('button', { name: '学生档案' }).first().click()
        await page.waitForTimeout(320)
        const info = await pageInfo(page)
        check(
          info.sheetOpen && info.sheetTitle.startsWith('学生档案'),
          '打开的是「学生档案」那一张浮层',
          `sheetOpen=${info.sheetOpen} · 标题=${info.sheetTitle}`,
        )
        const labels = ['民族', '出生年月', '家长电话', '家庭住址']
        check(
          labels.every((l) => info.body.includes(l)),
          '四个字段的标题都在屏上',
          labels.map((l) => `${l}:${info.body.includes(l)}`).join(' · '),
        )
        check(
          info.body.includes('未录入') && !info.body.includes('读不到学生档案'),
          '还没录过时写的是「未录入」（**不是**「读不到」—— 三态不许混）',
          short(info.body, 130),
        )
        const canEdit = await page.getByRole('button', { name: '修改档案' }).count()
        check(
          canEdit === 0,
          '🔴 任课教师 / 无身份 → **不摆**"修改档案"（前端只决定摆不摆，判据在数据库）',
          `按钮数=${canEdit}`,
        )
      })
      await shot(page, '04b 学生档案（科任老师只读）', '106-student-profile', { wait: 320 })

      await step('04c 学生档案（班主任改本班）', async () => {
        await page.goto(`${BASE}/classes/c-demo-1?as=head_teacher`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: '学生档案' }).first().click()
        await page.waitForTimeout(260)
        const before = await page.getByRole('button', { name: '修改档案' }).count()
        check(
          before === 1,
          '🔴 班主任（`?as=head_teacher`）→ **摆**"修改档案"（用户口径：班主任通过班级改本班这些信息）',
          `按钮数=${before}`,
        )
        if (before !== 1) return
        await page.getByRole('button', { name: '修改档案' }).click()
        await page.waitForTimeout(220)
        const boxCount = await page.locator('.sheet input').count()
        check(boxCount === 4, '点开之后是四个输入框（民族 / 出生年月 / 家长电话 / 家庭住址）', `输入框数=${boxCount}`)
        if (boxCount !== 4) return
        await page.locator('.sheet input').nth(0).fill('汉族')
        await page.locator('.sheet input').nth(1).fill('2010-05')
        await page.locator('.sheet input').nth(2).fill('13800138000')
        await page.locator('.sheet input').nth(3).fill('某市某区某小区1号楼2单元501')
        await page.getByRole('button', { name: '保存' }).click()
        await page.waitForTimeout(450)
        const after = await pageInfo(page)
        check(
          after.body.includes('13800138000') && after.body.includes('汉族'),
          '🔴 保存之后屏上就出现了刚录进去的家长电话（录入 → 看到是一条真链路）',
          short(after.body, 130),
        )
        check(
          after.sheetOpen && (await page.getByRole('button', { name: '修改档案' }).count()) === 1,
          '而且回到了只读视图（"修改档案"又摆出来了）—— 不是卡在编辑态',
          `sheetOpen=${after.sheetOpen}`,
        )
      })

      await step('04d 学生档案：任课教师那一侧的反向对照', async () => {
        await page.goto(`${BASE}/classes/c-demo-1?as=teacher`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(500)
        await page.getByRole('button', { name: '学生档案' }).first().click()
        await page.waitForTimeout(260)
        const cnt = await page.getByRole('button', { name: '修改档案' }).count()
        check(
          cnt === 0,
          '🔴 反向对照：明写 `?as=teacher`（任课教师）→ **又不摆**"修改档案"（证明上一步不是"恒摆"）',
          `按钮数=${cnt}`,
        )
        const info = await pageInfo(page)
        check(
          info.body.includes('家长电话') && info.body.includes('家庭住址'),
          '⚠️ 而字段**照旧看得见**（只读）—— 科任老师不是"看不到"，是"改不了"',
          short(info.body, 110),
        )
      })

      /*
       * 04e 班级页的「调课 / 停课」（2026-10-13 追加口径：**班主任也要能改某一天的课**）。
       * 判据在数据库（`supabase/schema.sql` §38.0b 的 `can_manage_temp_schedule()` = 超管 /
       * 教务处 / 本年级年级主任 ∪ **本班班主任**），这里只验**界面这一层**：
       *   ① `?as=head_teacher` → 摆这个入口；`?as=teacher` → **不摆**（反向对照）；
       *   ② 点开 → 选定某一天 → 这一天有几节**真的列出来**；
       *   ③ 「这节课今天不上」→ 那一节当场从这个列表里消失（只改这一天）。
       * ⚠️ 演示模式没有数据库：`loadScheduleDay` 回 `'local'`，页面转用内存那一层
       *    （`saveTempScheduleChange` 在 `!isRemote` 时直接回 ok）。**远程那一侧**由
       *    `rls-checks` 第二十×节的 ⑤ 块逐身份验（班主任本班写得动 / 别班仍然被拒）。
       */
      await step('04e 班级页：班主任调某一天的课', async () => {
        /* 取一个**工作日**：演示夹具按星期几挂课，周末那一天这个班可能真没课 */
        const day = new Date()
        while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1)
        const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(
          day.getDate(),
        ).padStart(2, '0')}`

        await page.goto(`${BASE}/classes/c-demo-1?as=teacher`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(420)
        const asTeacher = await page.locator('[data-adj-open]').count()
        check(
          asTeacher === 0,
          '🔴 反向对照：任课教师（`?as=teacher`）→ **不摆**「调课 / 停课」（前端只决定摆不摆，判据在数据库）',
          `按钮数=${asTeacher}`,
        )

        await page.goto(`${BASE}/classes/c-demo-1?as=head_teacher`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(500)
        const opener = page.locator('[data-adj-open]')
        const openerCount = await opener.count()
        check(
          openerCount === 1,
          '🔴 班主任（`?as=head_teacher`）→ **摆**「本班课表」里的「调课 / 停课」入口',
          `按钮数=${openerCount}`,
        )
        if (openerCount !== 1) return
        await opener.click()
        await page.waitForTimeout(420)
        const sheet = await pageInfo(page)
        check(
          sheet.sheetOpen && sheet.sheetTitle.includes('调课'),
          '点开的是「调课 / 停课（只改这一天）」那一张浮层',
          `sheetOpen=${sheet.sheetOpen} · 标题=${sheet.sheetTitle}`,
        )
        await page.locator('[data-adj-date]').fill(iso)
        await page.waitForTimeout(360)
        const cells = await page.locator('[data-adj-cell]').count()
        check(
          cells > 0,
          `这一天（${iso}）这个班有几节**真的列出来**（读的是那一天的口径，不是周课表那张网格）`,
          `节数=${cells}`,
        )
        if (!cells) return
        const firstStart = await page.locator('[data-adj-cell]').first().getAttribute('data-adj-cell')
        await page.locator('[data-adj-cell]').first().click()
        await page.waitForTimeout(260)
        const offBtn = await page.locator('[data-adj-off]').count()
        check(
          offBtn === 1,
          '点一节之后摆出「这节课今天不上」（停课＝把这一节今天腾空 —— 与换人同一条通路）',
          `按钮数=${offBtn}`,
        )
        if (offBtn !== 1) return
        await page.locator('[data-adj-off]').click()
        await page.waitForTimeout(520)
        const after = await page.locator('[data-adj-cell]').count()
        check(
          after === cells - 1,
          '🔴 停课之后那一节**当场从这一天的列表里消失**（只改这一天 —— 每周课表那张表一个字不动）',
          `${cells} → ${after}（停的是 ${firstStart}）`,
        )
      })

      /* ================= P1a：退场动画（2026-10-02）=================
       * 🔴 **为什么放在这里（04f，不是最后一节）**：
       *    这一轮实测发现 shots 在第 126 张图那一节（「撤下图标 + 开学准备 · 六步脊」）
       *    会**异常中断**（`Failed to fetch dynamically imported module`，
       *    Vite dev server 的依赖哈希问题）—— 已用 stash 对照证明**与源码改动无关**，
       *    在干净的 HEAD 上同样断。所以**凡是"必须拿到读数"的断言都不能往后放**：
       *    放在这里，即使后面那节照旧中断，这几条**照样出读数**。
       *
       * ⚠️ 下面每条的期望值都是**实测来的**，不是推的（临时探针 `_probe-p1a.mjs` 跑过一遍）：
       *    关闭后 class=`sheet sheet--out` · animation=`sheet-down` · 180ms ·
       *    inert=true · aria-hidden=true；t+80ms 仍在 DOM，t+330ms 已卸载。
       *
       * 🔴🔴 **参数顺序：`check(ok, label, observed, extra)` —— 条件在第一个！**
       *    写反的话 `ok` 拿到的是那句标签字符串（非空 = 真）→ **这条永远绿**。
       *    审计发现全仓 **37 处写反**（774 处调用里）：`:985-1058` 学生档案 21 处、
       *    `:1087-1133` 调课 8 处 —— 🔴 **那些是先前就存在的假绿，不是本轮引入**。
       *    本节 8 条一律按 `check(条件, 标签, 实测)` 写。
       * ---------------------------------------------------------------- */
      await step('04f 退场动画（P1a）', async () => {
        const OPENER = '[data-adj-open]'
        const closeBtn = page.getByRole('button', { name: '关闭' })

        await page.goto(`${BASE}/classes/c-demo-1?as=head_teacher`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(500)
        const openerN = await page.locator(OPENER).count()
        check(
          openerN === 1,
          'P1a 前置：班主任页上那个开 Sheet 的入口正好 1 个（后面几条都建立在它之上）',
          `入口数=${openerN}`,
        )
        if (openerN !== 1) return

        // ---- 进场（对照：退场之前它本来就该是 sheet-up） ----
        await page.locator(OPENER).click()
        await page.waitForTimeout(420)
        const enter = await page.evaluate(() => {
          const s = document.querySelector('.sheet')
          if (!s) return null
          const cs = getComputedStyle(s)
          return { cls: s.className, anim: cs.animationName, dur: cs.animationDuration }
        })
        check(
          enter !== null && enter.anim === 'sheet-up',
          'P1a：进场照旧是 `sheet-up 0.26s`（这一轮只加退场，**不许顺手改进场**）',
          enter ? `animation=${enter.anim} ${enter.dur} class="${enter.cls}"` : 'sheet 不存在',
        )

        // ---- 退场：刚关掉的那一瞬 ----
        await closeBtn.first().click()
        const justAfter = await page.evaluate(() => {
          const s = document.querySelector('.sheet')
          const sc = document.querySelector('.scrim')
          if (!s) return { gone: true }
          const cs = getComputedStyle(s)
          return {
            gone: false,
            cls: s.className,
            anim: cs.animationName,
            dur: cs.animationDuration,
            inert: s.hasAttribute('inert'),
            aria: s.getAttribute('aria-hidden'),
            scrimOut: sc ? sc.className.includes('scrim--out') : null,
            scrimInert: sc ? sc.hasAttribute('inert') : null,
          }
        })
        check(
          justAfter.gone === false,
          '🔴 P1a：关掉后元素**没有立刻消失** —— 以前是 `if (!open) return null`，直接卸载、零退场',
          justAfter.gone ? '点完就没了（退场没生效）' : `class="${justAfter.cls}"`,
          '反向对照：把 `useExit` 换成 `open ? 挂载 : null` → 这条必须红',
        )
        check(
          justAfter.gone === false && justAfter.cls.includes('sheet--out') && justAfter.anim === 'sheet-down',
          '🔴 P1a：退场期间挂的是 `sheet--out` → animation 换成 `sheet-down`（不是退回进场的 sheet-up）',
          justAfter.gone ? '（元素已卸载）' : `class="${justAfter.cls}" animation=${justAfter.anim}`,
          '反向对照：把 `.sheet--out` 那条 animation 删掉 → 这条必须红（此时它会继续播 sheet-up）',
        )
        check(
          justAfter.gone === false && justAfter.dur === '0.18s',
          '🔴 P1a：退场时长就是 `--dur-exit` 的 **180ms**（不是随手写的 0.2s）',
          `实测 ${justAfter.dur}`,
        )
        check(
          justAfter.gone === false &&
            justAfter.inert === true &&
            justAfter.aria === 'true' &&
            justAfter.scrimInert === true,
          '🔴 P1a：退场那 180ms 里 `inert` + `aria-hidden="true"`（否则「看不见却能 Tab 到、能点」）',
          `sheet: inert=${justAfter.inert} aria-hidden=${justAfter.aria} · scrim: --out=${justAfter.scrimOut} inert=${justAfter.scrimInert}`,
          '反向对照：把退场期的 inert/aria-hidden 摘掉 → 这条必须红',
        )

        // ---- 中途还在、之后才卸载（证明是真"延迟卸载"，不是碰巧慢） ----
        await page.waitForTimeout(80)
        const stillThere = await page.evaluate(() => !!document.querySelector('.sheet'))
        check(stillThere === true, '🔴 P1a：t+80ms 仍在 DOM 里（退场还没结束）', `在=${stillThere}`)

        await page.waitForTimeout(250)
        const gone = await page.evaluate(() => ({
          sheet: !!document.querySelector('.sheet'),
          scrim: !!document.querySelector('.scrim'),
        }))
        check(
          gone.sheet === false && gone.scrim === false,
          '🔴 P1a：t+330ms 播完就卸载（sheet 与 scrim 一起走）',
          `sheet=${gone.sheet} scrim=${gone.scrim}`,
        )

        // ---- 🧪 反向对照①：`.sheet-down` 与 `.sheet-up` 必须是**两个不同的 keyframe**
        //    理由：没有退场那条规则时 class 照样会加、元素照样会留 180ms，
        //    但**它会继续播进场的 sheet-up**（从屏幕下往回弹），退场等于没做。
        //    所以这条盯的是 animationName，不是"元素在不在"。
        check(
          justAfter.gone === false && justAfter.anim === 'sheet-down' && justAfter.anim !== 'sheet-up',
          '🧪 反向对照①：`sheet-down` 与 `sheet-up` **必须是两个不同的 keyframe**' +
            '（判据是 animationName，不是有没有元素）',
          `退场实测 ${justAfter.anim}`,
          '反向对照：把 `.sheet--out` 那条 animation 删掉 → 这条与上面「换 sheet-down」两条都红',
        )

        // ---- 🧪 反向对照②：连点「开→关→开」不能被上一个 timer 提前卸载 ----
        await page.locator(OPENER).click()
        await page.waitForSelector('.sheet', { timeout: 8000 })
        await page.waitForTimeout(60) // 只开 60ms
        await closeBtn.first().click()
        await page.waitForTimeout(60) // 只关 60ms
        await page.locator(OPENER).click() // 又打开
        await page.waitForTimeout(420) // 等过原本那个 180ms 的卸载点
        const reopened = await page.evaluate(() => {
          const s = document.querySelector('.sheet')
          return { exists: !!s, cls: s ? s.className : null, inert: s ? s.hasAttribute('inert') : null }
        })
        check(
          reopened.exists === true && reopened.inert === false,
          '🧪 反向对照②：开→关→开（间隔各 60ms）之后元素**仍在、且 inert 已摘掉**' +
            '（不写清旧 timer 就是「点两下它自己没了」）',
          `exists=${reopened.exists} class="${reopened.cls}" inert=${reopened.inert}`,
          '反向对照：把 `useExit` 的 effect cleanup（clearTimeout）去掉 → 这条必须红',
        )
      })

      /*
       * 04g 门禁自身的兜底（2026-10-13）。
       *
       * `check(条件, 标签, 实测)` —— **条件必须在第一个**。2026-10-13 全仓审计出 27 处写反：
       * `ok` 拿到的是那句标签字符串（非空 ⇒ 恒真）⇒ 那 27 条**永远是绿的**，比"抓不到 bug"
       * 更坏：它让人以为验过了。27 处＝学生档案 04b/04c/04d 10 处 · 改班内学号/收缴/改回 9 处
       * · 04e 班主任调课 6 处 · `grade_delete`、`teacher_profiles` 两处源码断言各 1 处。
       *
       * 这里钉住 `check()` 里那道兜底（`typeof ok === 'string'` → 当场记失败并打印）：
       * 兜底被人删掉时，这一条就红 —— 否则下一次写反又是一片假绿，而且没人看得见。
       */
      await step('04g 门禁自身：check() 参数写反的兜底还在', async () => {
        const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8')
        const guard = /if \(typeof ok === 'string'\)/.test(selfSrc)
        const shout = /参数写反/.test(selfSrc)
        check(
          guard && shout,
          '🔴 `app/scripts/shots.mjs` 的 `check()` 里留着「参数写反」的兜底（第一个参数是字符串 → 当场记失败，不静默通过）',
          `兜底语句=${guard} · 提示语=${shout}`,
          '反向对照：把 check() 里那段 `if (typeof ok === \'string\')` 删掉 → 这条必须红',
        )
      })

      /*
       * 04h 门禁自身：动态 import prebundle 依赖时的 `?v=` 取法（2026-10-02）。
       *
       * 三处「在真浏览器里挂组件」的探针（开学准备 · 六步脊 / S23 / S23 reduced-motion）都要
       * `import('/node_modules/.vite/deps/react.js?v=…')`。原先三处都是
       * `mainSrc.match(/[?&]v=([0-9a-f]+)/)` —— **拿入口里第一个 `?v=` 去套所有依赖**。
       * rolldown-vite 8 **每个依赖各有自己的哈希**，于是 `react-dom_client.js` 拿到的是
       * `react.js` 的哈希 → 请求恒 504 `(Outdated Optimize Dep)` → `shots` 跑到
       * 「撤下图标 + 开学准备 · 六步脊」就异常中断（少了 15 张图）。
       * 实测：`react.js?v=f9ef6f5a` 200 · `react-dom_client.js?v=f9ef6f5a` 504 ·
       * `react-dom_client.js?v=d7362595` 200。
       *
       * 这里钉住"按文件名取各自 URL"这条写法（旧写法回来就红）。
       */
      await step('04h 门禁自身：依赖的 ?v= 按文件名取', async () => {
        const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8')
        const perDep = /depUrl\('react-dom_client'\)/.test(selfSrc)
        /* 旧写法（把**同一个哈希变量**拼进所有 `deps/*.js` 的 `?v=`）在源码里必须一处都不剩。
           ⚠️ 这里连注释都**不能把旧写法逐字写出来** —— 否则这段文字会被下面这个匹配式扫到；
           本轮第一版就踩了这一下（注释里写了旧写法 → 04h 自己判红）。 */
        const legacy = new RegExp('deps/[a-z_-]+\\.js\\?v=' + '\\$\\{depV\\}').test(selfSrc)
        check(
          perDep && !legacy,
          '🔴 动态 import prebundle 依赖时**按文件名取各个依赖自己的 `?v=`**（每个依赖哈希都不同；拿入口第一个哈希去套 → `react-dom_client.js` 恒被 Vite 判成 504）',
          `按名取=${perDep} · 还留着单哈希写法=${legacy}`,
          '反向对照：把任意一处改回 `?v=` 拼单一哈希变量 → 这条必须红',
        )
        const sites = (selfSrc.match(/depUrl\('react-dom_client'\)/g) ?? []).length
        check(
          sites === 3,
          '🔴 三处「挂组件」的探针都用同一个取法（`react` / `react-dom_client` 两个 URL 各自按名取）',
          `按名取的出现次数 = ${sites}（期望 3）`,
          '反向对照：漏改一处（那一处仍用单哈希）→ 这一条与上面那条一起红',
        )
      })

      await goto(page, '05–07 拍照录名单', '/classes/c-demo-1/import/photo', {
        markers: ['拍照录名单', '第 1 步 · 拍摄花名册', '识别约定'],
      })
      await shot(page, '05–07 拍照录名单', '05-photo-capture', { full: true })

      await step('05–07 拍照录名单', async () => {
        await page.getByRole('button', { name: /演示（模拟结果）/ }).click()
      })
      await shot(page, '05–07 拍照录名单', '06-photo-scanning', {
        wait: 700,
        // 扫描中的中间态：这一步没有 URL 变化，只能看屏上文案
        expect: { url: '/classes/c-demo-1/import/photo', markers: ['识别'] },
      })
      await shot(page, '05–07 拍照录名单', '07-photo-review', {
        full: true,
        wait: 2300,
        // 识别完成后必须真的进了核对态（有可确认/导入的动作），不能只是"还在转"
        expect: {
          url: '/classes/c-demo-1/import/photo',
          markers: ['确认', '姓名'],
        },
      })

      await goto(page, '08 粘贴导入', '/classes/c-demo-1/import/paste', {
        markers: ['粘贴导入名单', '第 3 步 · 导入方式', '按学号合并'],
      })
      await step('08 粘贴导入', async () => {
        await page.getByRole('button', { name: '填入示例' }).click()
      })
      await shot(page, '08 粘贴导入', '08-paste-import', {
        full: true,
        expect: {
          url: '/classes/c-demo-1/import/paste',
          markers: ['第 2 步 · 校验结果'],
        },
      })

      /*
       * ⚠️ 期望值 2026-10-04 变了：这一页原来有一整张「教室端」卡（地址 + 复制 +
       *    在新标签页打开），用户当天说「图二的教室端入口也没什么用了」⇒ 整卡删掉。
       *    所以标记里的 `教室端` 跟着撤掉（这一屏默认没有 `?rel=`，下载按钮一颗都不摆，
       *    那个词在这一页上也不再出现）。`备份与恢复` / `关于` 两张卡都还在。
       */
      await goto(page, '09 设置页', '/settings', {
        markers: ['账号 · 数据 · 关于', '备份与恢复', '关于'],
      })
      await shot(page, '09 设置页', '09-settings', { full: true })

      /* ================= S1·补：序列号键（P1）—— 改班内学号不影响档案 =================
       *
       * 验收口径（`选科走班实施计划.md` P1 第 5/6 条）：
       *   · 「序列号」一栏**只读**（数据库层还有触发器兜底，这里只看界面给不给改）；
       *   · **改班级内学号 → 历史档案一个字不受影响**（键已经是序列号）。
       *
       * 为什么必须在**真浏览器**里钉：`rls-checks` 那一节验的是数据库那一侧
       * （触发器 + RLS + 迁移幂等），而"界面上老师改完之后，试卷档案里还是不是他"
       * 走的是 `lib/keys.ts` 那层映射 + store + 页面渲染 —— 只有真界面能覆盖。
       *
       * 做法：把**第 7 号**（`a-demo-1` 的未交名单里有他）改成 99 号，
       * 再去收缴页看那份档案 —— 未交的人必须还是"同一个孩子"，只是屏上号码变了。
       * 跑完**改回原样**，后面的步骤看到的仍是 7 号。
       */
      await goto(page, '09b 改班内学号', '/classes/c-demo-1', {
        markers: ['学生名单 · 45 人', '序列号'],
      })
      await shot(page, '09b 改班内学号', '09b-roster-serial', { full: true })
      await step('09b 改班内学号', async () => {
        // 名字从注入的快照里算（不拍字面量：seed 一改就成假通过）
        const who = DEMO_CLASSES[0].students[6] // 第 7 号
        check(Boolean(who), '演示名单里第 7 个学生在（夹具前提）', `students[6] = ${who?.name ?? '(没有)'}`)
        if (!who) return

        const rowText = await page.evaluate(
          (name) =>
            [...document.querySelectorAll('tbody tr')]
              .map((tr) => (tr.innerText ?? '').replace(/\s+/g, ' ').trim())
              .find((t) => t.includes(name)) ?? '',
          who.name,
        )
        check(
          /2025\d{3}/.test(rowText),
          '🔴 名单里**序列号那一列**显示的是 7 位序列号（不是班内学号）',
          short(rowText, 90),
          `期望含 2025xxx（该生序列号 = ${who.serial}）`,
        )

        // 打开编辑面板 → 序列号必须是**只读**
        await page.getByRole('button', { name: '编辑' }).nth(6).click()
        await page.waitForTimeout(300)
        const serialBox = page.locator('.sheet input.num').nth(1)
        const ro = await serialBox.evaluate((el) => ({
          readOnly: el.hasAttribute('readonly'),
          disabled: el.hasAttribute('disabled'),
          value: el.value,
        }))
        check(
          ro.readOnly || ro.disabled,
          '🔴 编辑面板上「序列号」是**只读**（readOnly/disabled 都算）',
          JSON.stringify(ro),
        )
        check(
          ro.value === (who.serial ?? ''),
          '🔴 只读框里显示的就是这个学生的序列号',
          `框里 = ${ro.value}，快照里 = ${who.serial}`,
        )

        // 改班内学号：7 → 99
        const noBox = page.locator('.sheet input.num').first()
        await noBox.fill('99')
        await page.getByRole('button', { name: '保存' }).click()
        await page.waitForTimeout(500)

        const after = await page.evaluate(
          (name) =>
            [...document.querySelectorAll('tbody tr')]
              .map((tr) => (tr.innerText ?? '').replace(/\s+/g, ' ').trim())
              .find((t) => t.includes(name)) ?? '',
          who.name,
        )
        check(/\b99\b/.test(after), '改完之后名单里出现 99 号', short(after, 90))
        check(
          after.includes(who.serial ?? '###'),
          '🔴 改完之后**序列号没变**（被改的只是班内学号）',
          short(after, 90),
        )
      })
      await shot(page, '09b 改班内学号', '09b-after-rename', { full: true })

      await spaGoto(page, '09c 档案不受影响', '/assignments/a-demo-1/collect', {
        markers: ['收作业查缺', '已交'],
      })
      await step('09c 档案不受影响', async () => {
        /*
         * `a-demo-1` 的未交名单在演示数据里按**档案键（序列号）**存：
         * `missingNos = ['2025007','2025019','2025033']`。
         * 改完班内学号之后：**未交的仍是同样 3 个人**，只是沈子那一格从 7 变成 99。
         * 这正是"档案只认序列号、不认班内学号"的直接证据。
         *
         * 🔴 这一步**必须走同文档导航**（`spaGoto`），不能 `page.goto`：
         *    夹具的 `addInitScript` 每次整页导航都会把 `shugao.teacher.v1` 重写成注入快照，
         *    上一步刚改的学号会被冲掉 —— 屏上永远是 7，这条断言**结构上不可能通过**。
         */
        const chips = await page.evaluate(() => {
          const panel = [...document.querySelectorAll('section.panel')].find((p) =>
            (p.querySelector('h2')?.textContent ?? '').includes('未交名单'),
          )
          return panel
            ? [...panel.querySelectorAll('b.num')].map((b) => (b.innerText ?? '').trim())
            : []
        })
        /* 期望值从**注入的那份快照**算，不拍字面量（seed 一改，字面量就变成假通过） */
        const a1 = DEMO_ASSIGNMENTS.find((x) => x.id === 'a-demo-1')
        const renamedId = DEMO_CLASSES[0]?.students[6]?.id
        const expectMissing = DEMO_CLASSES[0].students
          .filter((s) => (a1?.missingNos ?? []).includes(s.serial ?? s.studentNo))
          .map((s) => (s.id === renamedId ? '99' : s.studentNo))
        const asNums = (list) => [...list].map(Number).sort((a, b) => a - b).join(',')

        check(
          chips.includes('99'),
          '🔴 收缴页上，这个孩子现在显示成 **99 号**（改的确实生效了）',
          `未交名单上的学号：${chips.join('/') || '(一个都没有)'}`,
        )
        check(
          !chips.includes('7'),
          '反向对照：原来的 **7 号**已经不在这一屏（否则就是把两个号都画上了）',
          `未交名单上的学号：${chips.join('/') || '(一个都没有)'}`,
        )
        check(
          asNums(chips) === asNums(expectMissing),
          '🔴 未交名单还是**同样那 3 个人**（按序列号认人，改学号挤不掉人）',
          `屏上 ${chips.join('/') || '(空)'}，按快照算应为 ${expectMissing.join('/')}`,
          `a-demo-1.missingNos = ${(a1?.missingNos ?? []).join('/')}（键 = 序列号）`,
        )
        const stat = await page.evaluate(() => {
          const m = String(document.body.innerText ?? '').match(/未交\s*(\d+)/)
          return m ? Number(m[1]) : -1
        })
        check(
          stat === 3,
          '🔴 未交人数**没变**（还是 3）—— 改学号没有把任何人从名单里挤出去',
          `屏上「未交 ${stat}」`,
          '演示数据 a-demo-1 的未交名单是 3 个人',
        )
      })
      await shot(page, '09c 档案不受影响', '09c-collect-after-rename', { full: true })

      /*
       * 整页导航 ⇒ `addInitScript` 重写快照 ⇒ 上一步改出来的 99 **已经不在**（学号回到 7）。
       * 这一步就是钉住这件事：它既是"09c 为什么必须同文档导航"的机器版说明，
       * 也是"后面的步骤看到的世界与这一轮开始时一致"的依据 —— 不再靠"改回去"这个动作假装一致。
       */
      await goto(page, '09d 夹具回到原样', '/classes/c-demo-1', { markers: ['学生名单 · 45 人'] })
      await step('09d 夹具回到原样', async () => {
        const who = DEMO_CLASSES[0].students[6]
        if (!who) return
        const row = await page.evaluate(
          (name) =>
            [...document.querySelectorAll('tbody tr')]
              .map((tr) => (tr.innerText ?? '').replace(/\s+/g, ' ').trim())
              .find((t) => t.includes(name)) ?? '',
          who.name,
        )
        check(
          row.includes(who.studentNo),
          '整页导航之后学号回到原值（夹具快照每次导航重写）',
          short(row, 90),
          `期望含 ${who.studentNo}（注入快照里就是它）`,
        )
        check(
          !/\b99\b/.test(row),
          '反向对照：上一屏改出来的 **99 不在**了 —— 这正是 09c 必须走同文档导航的原因',
          short(row, 90),
        )
      })

      /* ================= S2：作业列表 / 新建 / 收作业查缺 ================= */

      await goto(page, '11 作业列表', '/assignments', {
        // 5 份 = 演示种子那 4 份 + 极简模式那份（a-demo-5，已批改 → 待收缴仍是 2）
        // 🔴🔴 「留今日作业」2026-10-03 起**默认收起**（用户定的：它原来占最上方，
        //   把老师最高频的「看档案/收缴」压到了第二屏）。所以这一屏**看不到**
        //   那块录入表单 —— 上面这两个 marker 必须换成收起态真有的那两样。
        //   ⚠️ 判据盯的是**"档案区在前、每日作业收成一行"**这件事，
        //   不是"每日作业那块面板还在最上面" —— 后者正是被改掉的。
        markers: ['5 份档案 · 2 份待收缴', '按上次新建', '全部班级', '留今日作业'],
        absent: ['每日作业内容'],
      })
      await shot(page, '11 作业列表', '11-assignments', { full: true })
      await step('11 作业列表 · 每日作业收成一行', async () => {
        /*
         * 🔴🔴 钉住 2026-10-03 那一改（用户定的：每日作业原来占作业页最上方，
         *   把老师最高频的「看档案 / 收缴」压到了第二屏）。
         *
         * 三个方向都钉 —— 少一个方向，这个不变量就可能"假绿"：
         *   ① 收起态：录入表单**不在**屏上（只留一行按钮 + 摘要）
         *   ② 展开态：点开之后**功能一个字不能少**（学科按钮 / 输入框 / 班级下拉）
         *   ③ 位置：折叠行在档案筛选**上方**（保留入口，但不再占一整块）
         *
         * ⚠️ 为什么要 ②：只钉 ① 的话，把面板改成"永远展开但高度塌掉"也能绿。
         * ⚠️ 判据用 `data-dh-*` 属性（本轮加的），**不用**"屏上有没有那句话" ——
         *   那样会因为其它地方出现同一句话而误判。
         */
        const collapsed = await page.evaluate(() => ({
          toggle: document.querySelectorAll('[data-dh-toggle="open"]').length,
          form: document.querySelectorAll('textarea[aria-label="每日作业内容"]').length,
          summary: document.querySelectorAll('[data-dh-summary]').length,
        }))
        check(
          collapsed.toggle === 1 && collapsed.form === 0 && collapsed.summary === 1,
          '11 作业列表：每日作业**默认收起**，只留一行入口 + 摘要（不占一整块）',
          `按钮 ${collapsed.toggle} · 表单 ${collapsed.form} · 摘要 ${collapsed.summary}`,
          '它原来在最上方占一整块，把「看档案/收缴」压到了第二屏',
        )

        // ③ 位置：折叠行必须**在档案筛选之上**（入口还在，只是收起来了）
        const order = await page.evaluate(() => {
          const btn = document.querySelector('[data-dh-toggle="open"]')
          const filter = [...document.querySelectorAll('select')].find(
            (s) => s.getAttribute('aria-label') === '按班级筛选',
          )
          if (!btn || !filter) return null
          return Math.round(btn.getBoundingClientRect().top + window.scrollY) <
            Math.round(filter.getBoundingClientRect().top + window.scrollY)
        })
        check(
          order === true,
          '11 作业列表：折叠行在档案筛选之上（入口还在最上方，但只占一行）',
          order === null ? '没找到那两个元素' : `折叠行在筛选上方 = ${order}`,
          '入口不该被挪走 —— 老师每天都要留作业',
        )

        // ② 展开态：功能一个字不能少
        await page.locator('[data-dh-toggle="open"]').click()
        await waitPageSettled(page)
        const opened = await page.evaluate(() => ({
          form: document.querySelectorAll('textarea[aria-label="每日作业内容"]').length,
          subjects: document.querySelectorAll('[data-dh-subject]').length,
          classPick: document.querySelectorAll('select[aria-label="每日作业班级"]').length,
          close: document.querySelectorAll('[data-dh-toggle="close"]').length,
        }))
        check(
          opened.form === 1 && opened.subjects > 0 && opened.classPick === 1 && opened.close === 1,
          '11 作业列表：点开之后输入框 / 学科 / 班级下拉 / 收起开关**都还在**',
          `表单 ${opened.form} · 学科 ${opened.subjects} · 班级 ${opened.classPick} · 收起 ${opened.close}`,
          '收起只能是"藏起来"，不能是"功能没了"',
        )

        // 收回收起态 —— 不然后面那几张图都带着展开的面板
        await page.locator('[data-dh-toggle="close"]').click()
        await waitPageSettled(page)
        const reclosed = await page.evaluate(
          () => document.querySelectorAll('textarea[aria-label="每日作业内容"]').length,
        )
        check(
          reclosed === 0,
          '11 作业列表：收起之后表单真的退场了（能来回，不是只能一直开着）',
          `收起后表单 ${reclosed}`,
          '否则老师点开一次就被永远留在那个大表单里',
        )
      })
      await step('11 作业列表', async () => {
        /*
         * 🔴 **题数只在普通模式显示**（2026-09-25 用户拍板）。
         *
         * 极简模式（`statsMode='simple'`）没有"题"这个概念（只记 优/良/差），
         * 而 `a-demo-5` 的 `questionCount` 就是 6 —— 照普通模式渲染出来就是一个
         * 没有意义的数字（老师会以为点进去有 6 道题的逐题数据）。
         *
         * 期望值全部从**注入的那份快照**算（`DEMO_CLASSES[0]` 与 seed 的 id 一样），
         * 不拍字面量：字面量会在 seed 改动时变成假通过。**两个方向都钉** ——
         * 极简那份不许出现「N 题」，普通那份必须照旧出现（否则"为了修极简把普通的也藏了"
         * 不会有任何东西变红）。
         */
        const rowTexts = await page.evaluate(
          (className) =>
            [...document.querySelectorAll('button.row')]
              .map((b) => (b.innerText ?? '').replace(/\s+/g, ' ').trim())
              .filter((t) => t.includes(className)),
          DEMO_CLASSES[0].name,
        )
        const simpleRow = rowTexts.find((t) => t.includes('课堂练习抽查'))
        const normalRow = rowTexts.find((t) => t.includes('作业22'))
        /*
         * ⚠️ 判据写成 `6 题`（数字 + 空格 + 题），**不能**写成 `/(?:^|[ ·])6 题/`：
         * 这个页面是 SPA，`pageInfo().body` 是**含 URL 的整页文本** —— 极简档案的
         * 行点进去的地址里有 `…-a578-34d1e093bb7c` 这种片段，换行 + 空白归一化之后
         * 会拼出 `…6 题…` 的形状（临时探针实测踩到过），那是脚本自己造的假红。
         * 而且页面上真有一行普通档案天生写着「作业21 … **6 题**」——
         * 所以这个不变量只能**逐行**钉，不能拿整页文案去钉。
         */
        const noQ = (t) => !/6 题(?![份个])/.test(String(t ?? ''))
        check(
          Boolean(simpleRow) && noQ(simpleRow),
          '11 作业列表：极简那份档案**不显示题数**（它没有"题"这个概念）',
          simpleRow ? `那一行：${short(simpleRow, 110)}` : `没找到它的行（本班 ${rowTexts.length} 行）`,
          '建档时那个「6 题」是隐藏输入框留下的默认值，不能显示给老师',
        )
        check(
          Boolean(normalRow) && /8 题/.test(normalRow),
          '11 作业列表：普通那份档案的题数**照旧显示**（不是到处都不显示）',
          normalRow ? `那一行：${short(normalRow, 110)}` : '没找到作业22 那一行',
          '普通模式的题数是有意义的（逐题数据真的存在）',
        )
        check(
          /6 题(?![份个])/.test(rowTexts.find((t) => t.includes('作业21')) ?? ''),
          '11 作业列表：对照组 —— 普通档案「作业21」那行**照旧**写着 6 题',
          short(rowTexts.find((t) => t.includes('作业21')), 110),
          '它和极简那份的 questionCount 都是 6，差别只在 statsMode',
        )
      })

      await goto(page, '12 新建作业档案', '/assignments/new', {
        markers: ['新建作业档案', '第 4 步 · 布置班级', '第 1 步 · 导入练习册电子稿（推荐）'],
      })
      await step('12 新建作业档案', async () => {
        await page.getByRole('button', { name: /作业22 电源/ }).first().click()
      })
      await shot(page, '12 新建作业档案', '12-assignment-new', { full: true })

      const CL = '/assignments/a-demo-2/collect'
      await goto(page, '13–15 收作业查缺', CL, {
        markers: ['收作业查缺', '拍一摞作业的侧面', '登记表 · 默认全班已交，只标例外'],
      })
      await shot(page, '13–15 收作业查缺', '13-collect-idle', { full: true })
      await step('13–15 收作业查缺', async () => {
        /*
         * 收缴页标题栏同样分两种口径（普通模式 `N 题` / 极简模式 `极简模式 · 只记等级`）。
         * 这张图是 `a-demo-2`（普通模式，8 题）—— 钉住**普通那一半照旧**：
         * `PageHead` 的 `sub` 渲染在 `<h1>` 的兄弟节点里，所以从整页文案里找
         * 「高二(3)班 · … · 8 题」这一串（不是只看标题）。
         * 极简那一半在临时探针里验过；这里同时确认屏幕上看不到「6 题」。
         */
        const body = await bodyText(page)
        check(
          /8 题/.test(body),
          '13–15 收作业查缺：普通模式的标题栏写着「8 题」（题数照旧显示）',
          short(body.match(/.{0,44}8 题.{0,10}/)?.[0] ?? body, 120),
        )
        check(
          !/6 题(?![份个])/.test(body),
          '13–15 收作业查缺：屏上不出现极简档案那个没有意义的「6 题」',
          short(body.match(/.{0,40}6 题(?![份个]).{0,10}/)?.[0] ?? body, 120),
        )
      })

      await step('13–15 收作业查缺', async () => {
        await page.getByRole('button', { name: /演示（模拟结果）/ }).click()
      })
      await shot(page, '13–15 收作业查缺', '14-collect-scanning', {
        wait: 700,
        expect: { url: CL, markers: ['识别'] },
      })
      await shot(page, '13–15 收作业查缺', '15-collect-result', {
        full: true,
        wait: 2400,
        expect: { url: CL, markers: [] },
      })

      /* ================= S3：批改录入（a-demo-4 = 待批改未录入） ================= */

      const GR = '/assignments/a-demo-4/grade'
      const SG = '17–25 批改录入'
      const grMarkers = ['批改录入', '默认全对 · 只点错的']
      const gr = { url: GR, markers: grMarkers }

      await goto(page, SG, GR, gr)
      await shot(page, SG, '17-grade-idle', { full: true, wait: 0 })

      const q = (seq) => page.getByRole('button', { name: `第 ${seq} 题`, exact: true })

      await step(SG, async () => {
        // 展开 3 号学生 → 题号就地展开在该学生正下方；标两处错
        await page.getByRole('button', { name: /^3 号/ }).click()
        await q(5).click()
        await q(6).click()
      })
      await shot(page, SG, '18-grade-inline-panel', { wait: 0, expect: gr })

      await step(SG, async () => {
        // 双击第 3 题 → 直接拆出 2 个小题，不弹窗
        await q(3).dblclick()
      })
      await shot(page, SG, '19-grade-quick-sub', { wait: 0, expect: gr })

      await step(SG, async () => {
        /*
         * 题号格里**不再有「+」**（紧挨着小小题号，点错就把题拆了）——
         * 加/减小题一律走长按面板。
         */
        await q(3).click({ delay: 700 })
        await page.getByRole('button', { name: '增加', exact: true }).click()
        await page.getByRole('button', { name: '完成', exact: true }).click()
      })
      await shot(page, SG, '20-grade-sub-three', { wait: 0, expect: gr })

      await step(SG, async () => {
        // 标 (1) 错
        await page.getByRole('button', { name: '第 3 题第 1 小题' }).click()
      })
      await shot(page, SG, '21-grade-sub-wrong', { wait: 0, expect: gr })

      await step(SG, async () => {
        // 长按第 3 题 → 小题设置（取消需要确认）
        await q(3).click({ delay: 700 })
      })
      await shot(page, SG, '22-grade-sub-settings', {
        wait: 0,
        expect: { ...gr, markers: [...grMarkers, '第 3 题 · 小题设置'] },
      })
      await step(SG, async () => {
        await page.getByRole('button', { name: '完成', exact: true }).click()
      })

      await step(SG, async () => {
        // 换一个学生，验证就地展开跟随
        await page.getByRole('button', { name: /^7 号/ }).click()
        await q(2).click()
      })
      await shot(page, SG, '23-grade-switch', { full: true, wait: 0, expect: gr })

      await step(SG, async () => {
        // 完成批改 → 两条路：临时保存 / 确认完成（未批改的记为未交）→ 再挑改错名单
        await page.getByRole('button', { name: '完成批改' }).click()
      })
      await shot(page, SG, '24-grade-finish-choose', { wait: 0, expect: gr })

      await step(SG, async () => {
        // 先走「临时保存」：状态不变，进度留下。
        // ⚠️ 保存成功后产品**自己跳回 /assignments**（不是留在批改页）——
        //    所以这一步的断言按**实际落点**写，截图也就诚实地拍的是作业列表 + toast。
        await page.getByRole('button', { name: /^临时保存/ }).click()
        await page.waitForURL('**/assignments', { timeout: 8000 })
        await page.waitForTimeout(700)
      })
      await shot(page, SG, '25-grade-draft-saved', {
        full: true,
        wait: 0,
        expect: { url: '/assignments', markers: ['已临时保存，之后可以接着批'] },
      })

      await step(SG, async () => {
        // 再进来接着批 → 这次走「确认完成批改」+ 挑改错名单
        await page.goto(`${BASE}${GR}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(600)
        await page.getByRole('button', { name: '完成批改' }).click()
        await page.getByRole('button', { name: /确认完成批改/ }).click()
      })
      await shot(page, SG, '26-grade-pick-correction', {
        wait: 0,
        expect: { ...gr, markers: ['选择需要改错的学生'] },
      })

      await step(SG, async () => {
        await page.getByRole('button', { name: '全选有错的' }).click()
        await page.getByRole('button', { name: '确认完成批改' }).click()
        // 确认完成后跳「完成批改」结果页（/grade/done）—— 那是另一屏，断言要跟着换
        await page.waitForURL('**/grade/done', { timeout: 8000 })
        await page.waitForTimeout(1200)
      })
      await shot(page, SG, '27-grade-done', {
        full: true,
        wait: 0,
        expect: { url: `${GR}/done`, markers: ['完成批改', '本次批改完成'] },
      })

      /* ================= S3b：改错登记（用已批改的 a-demo-1） ================= */

      // 点一下记「已改」，重点关注置顶变色，旁边能呼叫
      const SC = '28–31 改错登记'
      const AC = '/assignments/a-demo-1/correct'
      const ac = { url: AC, markers: ['改错登记', '待改错', '已改错'] }

      await goto(page, SC, AC, ac)
      await shot(page, SC, '28-correct', { full: true, wait: 0 })

      await step(SC, async () => {
        // 点一下名单里的第一个人 → 记「已改」
        const rows = await page.locator('.row').count()
        check(rows >= 1, '改错名单里至少有一行（.row）', `数到 ${rows} 行`)
        await page.locator('.row').first().click()
        await page.waitForTimeout(400)
      })
      await shot(page, SC, '29-correct-one-done', {
        full: true,
        wait: 0,
        // 点一下记「已改」：待改错 7→6、已改错 5→6（两个数字都要对，别只看一个）
        expect: { ...ac, markers: ['待改错 · 6 人', '已改错 · 6 人'] },
      })

      await step(SC, async () => {
        await page.getByRole('button', { name: '更改名单' }).click()
      })
      await shot(page, SC, '30-correct-edit-list', {
        wait: 400,
        expect: ac,
      })

      await step(SC, async () => {
        await page.getByRole('button', { name: /^完成/ }).click()
        await page.getByRole('button', { name: '呼叫' }).click()
      })
      await shot(page, SC, '31-correct-call', { wait: 300, expect: ac })
      await step(SC, async () => {
        await page.getByRole('button', { name: /取消/ }).click()
      })

      /* ================= S3c：极简模式（statsMode='simple'） ================= */

      /*
       * 极简模式是**另一套数据模型**（§四 4.1）：只有「学号 → 优/良/差」，
       * `wrong` 恒为空，`questionCount` 只是建档时那个被隐藏的输入框留下的值。
       *
       * 这一节为什么必须有：`seed` 里原来一份极简档案都没有，五个回归脚本也从不创建它 ——
       * 于是这整套第二数据模型在回归里是 **0 覆盖**，而它的坏法恰好是
       * "照普通模式渲染，给出一个看起来很正常、其实错了的结论"（§九 W16）。
       * 演示档案 = `a-demo-5`（已批改：42 人评了等级 / 3 人未交 / 改错名单按「差」挑）。
       *
       * 断言形状统一是 **presence 等级口径 + absent 逐题口径**：
       * 只断言"页面上有优良差"是不够的 —— 普通模式的口径**可以和它同时出现**，
       * 而那正是 bug 的样子。
       */
      const S5S = '74–76 极简模式（只记等级）'

      const SGR = '/assignments/a-demo-5/grade'
      await goto(page, S5S, SGR, {
        // 42/45 = 这份演示档案里评了等级的人数（seed 的 a-demo-5：45 人 / 3 人未交）
        markers: ['批改录入', '极简模式 · 只记等级', '已评', '42/45'],
        absent: ['默认全对 · 只点错的', '完整度', '6 题', '全对'],
      })

      /*
       * 收缴页（`/collect`）的标题栏是**另一张闸**：极简档案也不能写「N 题」。
       * 这一屏原来只覆盖普通模式（`a-demo-2`，8 题），所以极简那一半在这里补上。
       * 不额外截图（`EXPECTED_FILES` 不因它变动），只走一遍真实页面 + 断言。
       *
       * ⚠️ 位置讲究：这一步必须**排在批改页那一步之后**。
       *    第一版把它插在 `goto(grade)` 与批改页断言之间，批改页那一步就抓到了
       *    "还在上一屏"的一帧（两次运行一次红一次绿 —— 典型的顺序型 flaky）。
       *    另外 `PageHead` 的 `sub` 要等 profile 就绪才渲染，所以这里**轮询等它出现**
       *    再断言，而不是拍一个固定时长（`waitForTimeout` 在慢机器上就是随机红）。
       */
      await goto(page, S5S, '/assignments/a-demo-5/collect', {
        markers: ['收作业查缺'],
      })
      await step(S5S, async () => {
        let body = ''
        for (let i = 0; i < 24; i++) {
          body = await bodyText(page)
          if (body.includes('极简模式 · 只记等级')) break
          await page.waitForTimeout(150)
        }
        check(
          /极简模式 · 只记等级/.test(body),
          `${S5S}：收缴页的标题栏写「极简模式 · 只记等级」（不是「6 题」）`,
          short(body.match(/.{0,60}极简模式.{0,20}/)?.[0] ?? body, 130),
        )
        check(
          !/6 题(?![份个])/.test(body),
          `${S5S}：收缴页上找不到极简档案那个没有意义的「6 题」`,
          short(body.match(/.{0,40}6 题(?![份个]).{0,10}/)?.[0] ?? body, 130),
        )
      })
      /*
       * 回到批改页（下一步要接着往下走批改链路）。
       * ⚠️ 走一次干净导航而不是"依赖上一步留下的状态"：这一步之前刚去过收缴页。
       */
      await goto(page, S5S, SGR, {
        markers: ['批改录入', '极简模式 · 只记等级', '已评 42/45'],
      })
      await step(S5S, async () => {
        /*
         * 已批改那张表在最后一张卡片网格里（`div.grid.grid-cols-3` × n，
         * 最后一张就是「已批改 N 人 · 点一下撤回重批」那张）——
         * 这是**产品的真实交互**：点一下撤回重批，不是打开面板。
         * 先量它的角标：极简模式写的是等级，普通模式写的是「错N / 全对」。
         */
        // 等这一屏真的渲染出来（已评 42/45 是这份档案的概览口径）——
        // 轮询而不是固定等待：慢机器上"拍一个时长"就是随机红。
        for (let i = 0; i < 24; i++) {
          if ((await bodyText(page)).includes('已评 42/45')) break
          await page.waitForTimeout(150)
        }
        const grid = page.locator('div.grid.grid-cols-3')
        const nGrids = await grid.count()
        const first = grid.last().locator('button').first()
        const label = ((await first.textContent()) ?? '').replace(/\s+/g, ' ').trim()
        check(
          /[优良差]/.test(label) && !/全对/.test(label),
          `${S5S}：已批改那张表的角标是等级（不是「全对 / 错N」）`,
          `第一格：「${label}」（页面共 ${nGrids} 张卡片网格）`,
        )
        const no = (label.match(/^(\d+)/) ?? [])[1]
        await first.click()
        await page.waitForTimeout(300)
        const withdrawn = await bodyText(page)
        check(
          withdrawn.includes('41/45'),
          `${S5S}：点一下撤回重批（已评 42/45 → 41/45）`,
          short(withdrawn, 140),
        )
        // 撤回之后他回到上面那张表，再点一下才展开面板
        await page.getByRole('button', { name: new RegExp(`^${no} 号`) }).click()
        await page.waitForTimeout(300)
        const lv = await Promise.all(
          ['优', '良', '差'].map((n) => page.getByRole('button', { name: n, exact: true }).count()),
        )
        check(
          lv.every((n) => n >= 1),
          `${S5S}：展开学生后是「优 / 良 / 差」三个等级按钮`,
          `优 ${lv[0]} 个 · 良 ${lv[1]} 个 · 差 ${lv[2]} 个`,
        )
        const qn = await page.getByRole('button', { name: /^第 \d+ 题/ }).count()
        check(
          qn === 0,
          `${S5S}：极简模式**一个题号按钮都没有**（没有逐题数据）`,
          `匹配到 ${qn} 个「第 N 题」`,
          '普通模式的批改页这里是一排题号格',
        )
        const panelBody = await bodyText(page)
        check(
          !panelBody.includes('双击题号') && !panelBody.includes('做错'),
          `${S5S}：展开面板的说明文字也没有逐题口径（「双击题号 / 红色=做错」）`,
          panelBody.includes('双击题号') || panelBody.includes('做错')
            ? short(panelBody, 150)
            : '说明文字是「点一下记等级（优 / 良 / 差）…」',
        )
        // 点一个等级 → 记上（顺带把上面那步撤回的状态补回去）
        await page.getByRole('button', { name: '优', exact: true }).click()
        await page.waitForTimeout(300)
        const regraded = await bodyText(page)
        check(
          regraded.includes('42/45'),
          `${S5S}：点一下就记上等级（已评回到 42/45）`,
          short(regraded, 140),
        )
      })
      await shot(page, S5S, '74-simple-grade', { full: true, wait: 0 })

      const SCR = '/assignments/a-demo-5/correct'
      await goto(page, S5S, SCR, {
        markers: ['改错登记', '待改错', '等级 差'],
        // 普通模式的两种写法：没人错时显示「全对」、快选按钮叫「错误率 ≥ 30%」
        absent: ['全对', '错误率 ≥ 30%'],
      })
      await step(S5S, async () => {
        // 更改名单：极简模式按**等级**挑人，不摆那对永远筛出空集的按钮
        await page.getByRole('button', { name: '更改名单' }).click()
        await page.waitForTimeout(400)
        const box = await page.locator('.sheet').innerText()
        check(
          box.includes('全选「差」的') && box.includes('选「良」和「差」'),
          `${S5S}：改名单里是按等级挑人（全选「差」的 / 选「良」和「差」）`,
          short(box, 150),
        )
        check(
          !box.includes('全选有错的'),
          `${S5S}：没有「全选有错的」那个必然筛出空集的按钮`,
          box.includes('全选有错的') ? short(box, 150) : '没有这一条',
        )
        await page.getByLabel('关闭').first().click()
        await page.waitForTimeout(300)
      })
      await shot(page, S5S, '75-simple-correct', { full: true, wait: 0 })

      const SDR = '/assignments/a-demo-5/grade/done'
      await goto(page, S5S, SDR, {
        markers: ['完成批改', '本次批改完成', '极简模式 · 只记等级', '等级录入', '这次评「差」的学生'],
        // 普通模式的口径（题量 / 错题率 / 讲评重点）一个都不许出现
        absent: ['错误率', '共 6 题', '明天讲评的重点'],
      })
      await shot(page, S5S, '76-simple-done', { full: true, wait: 0 })
      await step(S5S, async () => {
        /*
         * 完成页那条呼叫入口在极简模式下必须改道：
         * `/assignments/:id/call`（按错题数排序）在这份档案上只有「有错题 0 人」+ 空名单。
         */
        await page.getByRole('button', { name: /去改错登记挑人呼叫/ }).click()
        await page.waitForURL(`**${SCR}`, { timeout: 8000 })
        await page.waitForTimeout(400)
        const info = await pageInfo(page)
        check(
          info.url === SCR,
          `${S5S}：极简模式的呼叫入口去的是改错登记（不是按错题数排序的呼叫页）`,
          `url = ${info.url}`,
          `期望 ${SCR}`,
        )
      })

      /* ================= S4：统计与呼叫 ================= */

      const SS = '26–27 作业情况'
      const AS = '/assignments/a-demo-1/stats'
      await goto(page, SS, AS, {
        markers: ['作业情况', '题型掌握情况', '逐题错误率'],
      })
      await shot(page, SS, '26-stats', { full: true, wait: 0 })

      await step(SS, async () => {
        // 下钻到学生名单
        await page.getByRole('button', { name: /^第 5 题 错误率/ }).click()
      })
      await shot(page, SS, '27-stats-drill', {
        full: true,
        wait: 500,
        expect: { url: AS, markers: ['第 5 题'] },
      })

      const SK = '28–30 改错呼叫'
      const AK = '/assignments/a-demo-1/call'
      const ak = { url: AK, markers: ['改错呼叫', '按错题数排序 · 点一下选中'] }
      await goto(page, SK, AK, ak)
      await shot(page, SK, '28-call', { full: true, wait: 0 })

      const who = page.getByRole('button', { name: /^\d+ 号 / })
      await step(SK, async () => {
        // 按错题数从多到少选 3 人，并加自定义后缀
        await who.nth(0).click()
        await who.nth(1).click()
        await who.nth(2).click()
        await page.getByPlaceholder('带上作业本').fill('带上作业本')
      })
      await shot(page, SK, '29-call-selected', { full: true, wait: 0, expect: ak })

      await step(SK, async () => {
        // 预览教室端
        await page.getByRole('button', { name: '预览教室端' }).click()
      })
      await shot(page, SK, '30-call-preview', {
        wait: 400,
        expect: { ...ak, markers: ['教室端预览'] },
      })

      const SL = '31 呼叫记录'
      await step(SL, async () => {
        // 确认发送（用站内跳转，避免刷新把刚发的呼叫清掉）
        await page.getByRole('button', { name: '确认发送' }).click()
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: '记录' }).click()
        // 站内跳转 —— 这是真正的导航，URL 必须变
        await page.waitForURL('**/calls', { timeout: 8000 })
      })
      await shot(page, SL, '31-calls', {
        full: true,
        wait: 400,
        // 期望值变了（文案审查 A+ 力度）：页头那句「· 仅教师可见」是权限声明，
        // 与页脚重复，用户 2026-09-29 拍板删掉，所以这里不再要求它出现。
        expect: { url: '/calls', markers: ['呼叫记录'] },
      })

      /* ================= S5：教室端（另开标签页，跨标签实时送达） ================= */

      const SR = '32–34 教室端'
      const room = await ctx.newPage()
      room.on('pageerror', (e) => errors.push(`PAGEERROR(room) :: ${e.message}`))
      room.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(room) :: ${m.text()}`)
      })

      /**
       * 教室端的"独有文本"：平时是「这个班的课」那一块，某节课进行中是「正在上课」卡。
       * 两种都接受，但**必须**看到教室端自己的东西 —— 被 Guard 踢到登录页时屏上是
       * "账号登录"，这里要当场红。
       */
      async function expectRoom(label, extra = []) {
        const b = await bodyText(room)
        const ok = b.includes('这个班的课') || b.includes('正在上课')
        check(
          ok,
          `${label}：这是教室端那一屏（不是登录页/教师端）`,
          ok ? '屏上有「这个班的课」或「正在上课」' : short(b, 130),
          '期望含「这个班的课」/「正在上课」',
        )
        for (const m of extra) {
          check(b.includes(m), `${label}：屏上有「${m}」`, short(b, 130))
        }
        return b
      }

      await step(SR, async () => {
        await room.setViewportSize({ width: 1440, height: 900 })
        await room.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
        await room.waitForTimeout(1200)
        check(room.url().endsWith('/classroom'), `${SR}：教室端 URL 正确`, `url = ${room.url()}`)
        await expectRoom(SR)
      })
      await shotRaw(room, SR, '32-classroom')

      /* ---------------- 🆕 教室端「置顶小窗 / 声音」：**只该影响壳**的那条判据（2026-10-04）
       *
       * 用户报的第 ④ 条原话：「**不支持置顶小窗，为什么还要点一下解锁声音**」（教室端 exe）。
       * 产品侧把这件事改成"**壳自己声明**"（`_src/desktop/preload.js` 的 `autoplayAllowed`
       * 与 `documentPip`），而**网页版必须一字不变** —— 这一节钉的就是后半句：
       *   · dev server 里**没有壳**（没有 `window.__shell_out`）⇒ `shellAutoplayAllowed()` 恒 false
       *     ⇒「先解锁声音」那一步**照旧在**（那块横幅的 `data-classroom-unlock` 必须在）；
       *   · 而"小窗不可用"那块横幅的有无，必须与**真实**的 `pipSupported()` 一致。
       * ⚠️ 这一节**一张图都不出**（判据在 DOM 上；加图要动 `EXPECTED_FILES`，那是集合相等）。
       * ⚠️ 本机 Edge（Chromium 116+）有 `documentPictureInPicture` ⇒ 那块"开不了"的横幅**不该**出现。
       *    这里不问浏览器版本，而是**把页面里的真值读回来再断言**；下面 🧪 那一段就是反向那一侧：
       *    把那个 API **影子掉**（那正是"老浏览器"的现场）⇒ 那块横幅必须出现，而且说的是
       *    **网页版那句话**（提 Edge / Chrome 116）。而**壳里那句是假话** —— 由
       *    `_tools/verify-exe.mjs` 反向钉住（壳里那块横幅一个字都不许提 Edge / Chrome 116）。
       *    📌 2026-10-04 实测（本机 Edge）：`typeof documentPictureInPicture === 'object'`，
       *       所以这一节走的是"有 API"那一支（解锁那一步在、"开不了"横幅 0 个）。
       */
      await step(SR, async () => {
        await room.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
        await waitPageSettled(room)
        await room.waitForTimeout(900)
        /** 这一屏的两块横幅 + 环境真值（本节的读数口） */
        const readBanners = () =>
          room.evaluate(() => {
            const b = document.querySelector('[data-classroom-pip-unsupported]')
            return {
              shell: typeof window.__shell_out,
              api: typeof window.documentPictureInPicture,
              unlock: document.querySelectorAll('[data-classroom-unlock]').length,
              unsupported: document.querySelectorAll('[data-classroom-pip-unsupported]').length,
              bannerText: b ? String(b.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
            }
          })
        const A = await readBanners()
        check(
          A.shell === 'undefined',
          `🔴 ${SR}：dev server 里**没有壳**（\`window.__shell_out\` 不存在）—— 所以这一节量的是**网页版**行为；壳那一侧由 \`_tools/verify-exe.mjs\` 量`,
          `typeof window.__shell_out = ${A.shell} · typeof documentPictureInPicture = ${A.api}`,
        )
        /*
         * 🆕 2026-10-04：**没有壳 ⇒ 壳原生那条新路够不着**（施工单 `教室端原生置顶小窗` §三 · shots 那一行）。
         *
         * 教室端 exe 上 `__shell_out.pip` 是对象（壳自己开的那个永远置顶的窗口），
         * 而 dev server 里这个对象**压根不存在** ⇒ `shellPipAvailable()` 恒 false
         * ⇒ `pipSupported()` / `openPip()` 走的还是 **Document PiP 那条老路**。
         * ⚠️ 这一条不是"再钉一遍环境"，而是**这次新加的那条分支不许反过来影响网页版**的自证：
         *    哪天它被写成"网页版也算有原生小窗"，这里当场红（而不是等老师点下去才发现）。
         */
        const nativePip = await room.evaluate(() => ({
          bridge: typeof window.__shell_out,
          pip: typeof window.__shell_out?.pip,
          open: typeof window.__shell_out?.pip?.open,
          onClosed: typeof window.__shell_out?.pip?.onPipClosed,
        }))
        check(
          nativePip.bridge === 'undefined' && nativePip.pip === 'undefined' &&
            nativePip.open === 'undefined' && nativePip.onClosed === 'undefined',
          `🔴 ${SR}：**没有壳 ⇒ 壳原生那条路够不着**（\`__shell_out\` / \`__shell_out.pip\` 全读不到）—— 网页版走的还是 Document PiP 那条老路，这次改动在 dev server 里的行为**一字不变**`,
          `__shell_out=${nativePip.bridge} · pip=${nativePip.pip} · pip.open=${nativePip.open} · pip.onPipClosed=${nativePip.onClosed}`,
        )
        const apiOn = A.api === 'object'
        check(
          (apiOn && A.unlock === 1 && A.unsupported === 0) ||
            (!apiOn && A.unlock === 0 && A.unsupported === 1),
          `🔴 ${SR}：网页版行为**一字不变** —— 本机 Edge ${apiOn ? '有' : '没有'} \`documentPictureInPicture\` ⇒ ` +
            (apiOn
              ? '「先解锁声音」必须在（1 个），"开不了"那块横幅 0 个'
              : '「先解锁声音」不该在（0 个），"开不了"那块横幅顶上（1 个）'),
          `unlock ${A.unlock} 个 · pip-unsupported ${A.unsupported} 个`,
          '⚠️ 这一段是**照实**断言：本机 Edge 若没有那个 API，就按实测那一支走（别放宽判据、也别写成恒真）',
        )

        /*
         * 🧪 反向那一侧：**另起一个干净的 context**，把 `documentPictureInPicture` 影子成 undefined
         *    （= 老浏览器的现场）⇒ 同一屏必须换成"开不了"那块横幅，而且说的是**网页版那句话**。
         * ⚠️ 为什么另起一个 context、而不是在 `room` 上就地改：
         *    ① 那个属性挂在 **`Window.prototype`** 上 —— `delete window.documentPictureInPicture`
         *       **什么都不会发生**，就地改很容易写成"看起来测了、其实环境一个字没动"的假断言；
         *    ② 就地改还要赌"同 URL 的 `pushState` 会不会让 React 重渲染"。2026-10-04 **实测不会**
         *       （第一版就这么红的：`api=undefined` 而屏上横幅一个都没换）⇒ 这里直接**真加载一次**。
         * ⚠️ 这个 context **只读这一屏、跑完就关**（不截图 ⇒ 不动 `EXPECTED_FILES`）。
         */
        const ctxNoPip = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
        await ctxNoPip.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxNoPip.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        await ctxNoPip.addInitScript(() => {
          /* 影子（挂在文档加载**之前**才干净）：真属性在原型上，`delete` 动不了它 */
          Object.defineProperty(window, 'documentPictureInPicture', {
            value: undefined,
            configurable: true,
            writable: true,
          })
        })
        const np = await ctxNoPip.newPage()
        np.on('pageerror', (e) => errors.push(`PAGEERROR(无 PiP) :: ${e.message}`))
        np.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(无 PiP) :: ${m.text()}`)
        })
        try {
          await np.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
          await waitPageSettled(np)
          await np.waitForTimeout(900)
          const B = await np.evaluate(() => {
            const b = document.querySelector('[data-classroom-pip-unsupported]')
            return {
              api: typeof window.documentPictureInPicture,
              unlock: document.querySelectorAll('[data-classroom-unlock]').length,
              unsupported: document.querySelectorAll('[data-classroom-pip-unsupported]').length,
              bannerText: b ? String(b.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
            }
          })
          check(
            B.api === 'undefined' && B.unlock === 0 && B.unsupported === 1,
            `🔴 ${SR}：把 Document PiP 影子掉（= 老浏览器，干净加载一次）⇒ 「先解锁声音」不在了（0 个）、"开不了"那块横幅顶上（1 个）`,
            `api=${B.api} · unlock ${B.unlock} 个 · pip-unsupported ${B.unsupported} 个`,
          )
          check(
            B.bannerText !== null && B.bannerText.includes('Edge') && B.bannerText.includes('Chrome 116'),
            `🔴 ${SR}：而且那块横幅说的是**网页版那句话**（提 Edge / Chrome 116）—— 壳里**不许**出现这句，由 \`verify-exe.mjs\` 反向钉住`,
            JSON.stringify(B.bannerText),
          )
        } finally {
          await ctxNoPip.close()
        }
        const C = await readBanners()
        check(
          C.api === A.api && C.unlock === A.unlock && C.unsupported === A.unsupported,
          `🧪 ${SR}：反证那一次跑在**另一个 context** 里，\`room\` 这一屏**一个字都没被改过**（读数与开头一致）`,
          `room 上 api=${C.api}（原 ${A.api}）· unlock ${C.unlock}（原 ${A.unlock}）· pip-unsupported ${C.unsupported}（原 ${A.unsupported}）`,
        )
      })

      /* ---------------- 🆕 课代表在教室端录作业：**必须输班级口令**（2026-10-03 补）
       *
       * 🔴🔴 **为什么这一节原来一条断言都没有**：
       *   全仓 `data-rep` / `课代表` / `班级口令` / `rep-` 在 shots.mjs 里**零命中** ——
       *   也就是说"教室端能不能录、口令框在不在、口令错了有没有话说"这件事
       *   **完全没有回归保护**。而它恰恰是这块屏上**唯一的写入口**
       *   （`Classroom.tsx:2094` 的「课代表录一条」）。
       *   老师改坏了它，**门禁一声不响**，教室里那条路就悄悄没了。
       *
       * 设计上必须钉住的三条（`schema.sql:10955` 的 `rep_set_daily_homework`）：
       *   ① 屏上**明写**规则：只能录今天 / 只能录这台机器的班 / 只能录自己那一科；
       *   ② 那张 Sheet 里**真的有口令输入框**，且规则写在明面上；
       *   ③ 口令校验**只在数据库里**（`class_rep_pins` 不给客户端任何表权限）——
       *      前端**不许**出现"先在本地比一下口令"那种写法。
       *
       * ⚠️ 这一节**跑在演示模式**（本地存储），所以只能验"入口与规则在屏上"，
       *    验不了真库上口令比中对不对 —— **那是 `rls-checks.mjs` 的活**。
       */
      await step(SR, async () => {
        await room.getByRole('button', { name: '课代表录一条' }).click()
        await room.waitForTimeout(400)
        const sheet = await room.evaluate(() => {
          const body = document.body.innerText ?? ''
          const inputs = [...document.querySelectorAll('input')]
          const pin = inputs.find(
            (i) => /口令/.test(i.getAttribute('placeholder') ?? '') || /口令/.test(
              (i.closest('div')?.parentElement?.innerText ?? '').slice(0, 60),
            ),
          )
          const textarea = document.querySelector('textarea')
          return {
            title: body.includes('课代表录作业'),
            hasPinInput: Boolean(pin),
            pinPlaceholder: pin?.getAttribute('placeholder') ?? '',
            hasContent: Boolean(textarea?.getAttribute('placeholder')?.trim()),
            /* 规则那三条必须写在明面上 */
            ruleToday: body.includes('今天'),
            ruleSelfSubject: body.includes('自己那一科'),
            rulePinFromTeacher: body.includes('口令问班主任要'),
            /* 🔴 反向：前端不许自己拿口令去比（真正的校验在 security definer 里） */
            body: body.slice(0, 600),
          }
        })
        check(
          sheet.title && sheet.hasPinInput,
          `🔴 ${SR}：课代表录作业那张表**有口令输入框**（这是那块屏唯一的写入口，必须有它）`,
          sheet.hasPinInput ? `placeholder：${sheet.pinPlaceholder}` : '没找到口令输入框',
          '没有口令框 = 课代表根本录不了，或被当成老师直接放行',
        )
        check(
          sheet.ruleToday && sheet.ruleSelfSubject && sheet.rulePinFromTeacher,
          `${SR}：并且把规则写在明面上（今天 / 自己那一科 / 口令问班主任要）`,
          `今天=${sheet.ruleToday} · 自己那一科=${sheet.ruleSelfSubject} · 口令来源=${sheet.rulePinFromTeacher}`,
          '规则只写在代码注释里，课代表不知道自己能录什么',
        )
        check(
          sheet.hasContent,
          `${SR}：作业内容输入框也在（不是只让输口令）`,
          sheet.hasContent ? 'placeholder 有内容' : '没找到内容输入框',
        )
        await shot(room, SR, '121-classroom-rep-sheet')
        await room.keyboard.press('Escape')
        await room.waitForTimeout(300)
      })

      await step(SR, async () => {
        /*
         * 🔴🔴 **源码级判据**（照本文件 2595 / 2897 那几处的既有做法）：
         * 校验口令的地方**必须**是 RPC，前端**不许**自己比。
         *
         * 为什么这条比屏上断言更重要：屏上只能看到"有个口令框"，
         * 看不到**它被拿去干什么**。而这里守的是**安全边界**：
         * `class_rep_pins` 那张表**一个表权限都不给客户端**，
         * 比对只发生在 `security definer` 的 `rep_set_daily_homework` 里
         * （`schema.sql:10955`，比对那行是 `digest(p_class_id::text || ':' || pin)`）。
         * 一旦有人改成前端本地比 —— 课代表就能**撞库试口令**。
         *
         * 两个方向都钉（少一个就可能假绿）：
         *   ① `daily.ts` **必须**走 `sb.rpc('rep_set_daily_homework')`
         *   ② `daily.ts` **不许**直接查 `class_rep_pins` 这张表
         */
        const dailySrc = readFileSync(join(HERE, '..', 'src', 'lib', 'daily.ts'), 'utf8')
        check(
          /rpc\(\s*'rep_set_daily_homework'/.test(dailySrc),
          `🔴 ${SR}：课代表录作业走的是 **RPC**（口令校验在数据库里，前端碰不到口令）`,
          /rpc\(\s*'rep_set_daily_homework'/.test(dailySrc)
            ? "daily.ts 里调 sb.rpc('rep_set_daily_homework')"
            : 'daily.ts 里没找到那个 RPC —— 校验跑到别处去了',
          '改成前端本地比口令 = 课代表能撞库试出来',
        )
        /* 🔴🔴 判据必须**剥掉注释**再查 —— 第一版直接 `includes('class_rep_pins')`，
         *   而 daily.ts 的**文件头注释里正 explaining 这张表**（第 10/38 行），
         *   于是这条断言**恒红**，而红的原因是"注释里提了一句"。
         *   那是**又一次"核对工具自己先得是对的"**：
         *   断言红 ⇒ 先问"我量的是不是我想量的那件事"，别直接去改被测代码。
         * ⚠️ 为什么要查这张表：它 revoke 了客户端全部权限，前端查它只会拿到空；
         *    一旦有人改成前端 `.from('class_rep_pins').select()`，
         *    口令校验就等于**没有**（拿不到任何行）。
         */
        const dailyCode = dailySrc
          .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
          .replace(/^\s*\/\/.*$/gm, '') // 行注释
        check(
          !dailyCode.includes('class_rep_pins'),
          `${SR}：并且前端**没有**去查 class_rep_pins 那张表（它 revoke 了客户端全部权限）`,
          dailyCode.includes('class_rep_pins')
            ? '🔴 剥掉注释后 daily.ts 里还有 class_rep_pins —— 前端真的在查它'
            : `剥掉注释后没有（注释里共 ${dailySrc.split('class_rep_pins').length - 1} 处提及，不算）`,
          '改成前端查这张表 = 口令校验等于没有（拿不到任何行）',
        )
        /* 🔴 反向对照的前置条件：真库上那两个 RPC **必须存在**。
         *   少了它们，屏上那个口令框就是个摆设（点了只会报"function does not exist"）。
         *   读 schema.sql 钉住 —— 这是"课代表那条路真的通"的地基。 */
        const schemaSrc = readFileSync(join(HERE, '..', '..', 'supabase', 'schema.sql'), 'utf8')
        check(
          /create or replace function public\.rep_set_daily_homework\(/.test(schemaSrc) &&
            /create or replace function public\.set_class_rep_pin\(/.test(schemaSrc),
          `🔴 ${SR}：那两个 RPC 在 schema.sql 里都真的定义了（录作业 / 设口令）`,
          /public\.rep_set_daily_homework\(/.test(schemaSrc) ? 'rep_set_daily_homework ✔' : 'rep_set_daily_homework ✘',
          'RPC 不在库里 = 口令框点了只会报错',
        )
        /*
         * ⚠️ 2026-10-04 18:22（commit `30c0cc3`）：「课代表口令在生产上是坏的：
         *    `digest()` 撞上 Supabase 的 `extensions` schema ⇒ 换内核 `sha256()`」。
         *    **不变量一个字都没变**（口令比对仍然**绑班 id**），换的只是内核 ——
         *    所以这条判据跟着换核（`encode(sha256(convert_to(p_class_id::text || ':' || …
         *    **不删、也不放宽**）。它一度是红的，而红的原因正是"我找的还是旧内核"
         *    —— 又一次「核对工具自己先得是对的」。
         */
        check(
          /sha256\(convert_to\(p_class_id::text \|\| ':' \|\| btrim\(coalesce\(p_pin/.test(schemaSrc),
          `${SR}：口令比对在库里做，而且**绑定班 id**（不是全局一个口令）`,
          /sha256\(convert_to\(p_class_id::text/.test(schemaSrc)
            ? "比对式：sha256('<班id>:<口令>')"
            : '没找到那条比对',
          '不绑班 id 的话，隔壁班的课代表拿同一个口令也能录',
        )
      })

      /* ---------------- 🆕 粘贴课表的示例必须带班名（2026-09-28 用户实测） ----------------
       *
       * 现场：他在教室端粘了课表，**教室里看不见**，屏上也没说为什么。
       * 根因：粘贴框的示例写的是「周一 08:00-08:40 英语」——没有班名；
       * 而这条链路里 `classId` 只能从标题里的班名认出来（`matchClass`），认不出就是空的，
       * 教室端那条线（`scope='class'` + `classId === 本班`）一条都不显示。
       * **示例在教人做一个"导进去看不见"的格式** → 现在示例由**本班班名**拼出来。
       * 这一条量的是屏上那句 placeholder（绿/红由 `clock-checks.mjs` 逐行量）。
       */
      await step(SR, async () => {
        await room.getByRole('button', { name: '粘贴课表' }).click()
        await room.waitForTimeout(300)
        const cls = await room.evaluate(() => {
          const sel = [...document.querySelectorAll('select')].find((s) =>
            [...s.options].some((o) => /班/.test(o.textContent ?? '')),
          )
          const name = sel?.selectedOptions?.[0]?.textContent?.trim() ?? ''
          const ph = document.querySelector('textarea')?.getAttribute('placeholder') ?? ''
          const body = document.body.innerText ?? ''
          return {
            name,
            ph,
            hint: body.split('\n').find((l) => l.includes('不写班名')) ?? '',
            same: Boolean(name) && ph.includes(name) && body.includes(name),
          }
        })
        check(
          cls.same,
          `🔴 ${SR}：粘贴框的示例带**当前班名**「${cls.name || '(没读到班名)'}」`,
          cls.ph ? `placeholder 第二行：${short(cls.ph.split('\n')[1] ?? '', 90)}` : '没找到 textarea',
          '示例不带班名时，照着写导进去 classId 是空的 —— 教室里一条都不显示',
        )
        check(
          cls.hint.includes('不写班名'),
          `${SR}：并且**明说**"不写班名，这一条在教室里不会显示"`,
          cls.hint || '没看到那句提示',
        )
        await shot(room, SR, '120-classroom-paste-sheet')
        await room.keyboard.press('Escape')
        await room.waitForTimeout(300)
      })

      /* ---------------- 🆕 每日名言（2026-09-29 用户拍板） ----------------
       *
       * 要求两条，**都要钉**：
       *   ① 教室那块屏上真的有一句名言 + 出处（`data-daily-quote`，
       *      内容来自 `lib/quotes.ts` 的 `DAILY_QUOTES`，**每条都有来源**）；
       *   ② 🔴 **当天固定**：同一天刷新两次必须是同一句。
       *      判据不能用"两次读到的东西一样" —— 那样"两句都随机"也会绿。
       *      这里把**期望句**从源码里那条表按同一天算出来，再和屏上比：
       *      种子是 `dayIndex(beijingNow())`，与 `pickDailyQuote()` 逐字同一套口径。
       */
      await step(SR, async () => {
        const { DAILY_QUOTES } = await import('../src/lib/quotes.ts')
        const { dayIndex } = await import('../src/lib/mood.ts')
        /*
         * ⚠️ **必须显式给日期**，不能用默认的 `new Date()`：
         *    页面那边是 `page.clock.setFixedTime()` 钉在 2026-09-19，
         *    而脚本进程在**真实的今天** —— 默认参数会让"期望句"算成别的日子，
         *    这条断言就会以一种极难懂的方式红（第一版就踩了）。
         */
        const fakeDay = new Date(2026, 8, 19, 10, 0, 0)
        const want = DAILY_QUOTES[((dayIndex(fakeDay) % DAILY_QUOTES.length) + DAILY_QUOTES.length) % DAILY_QUOTES.length]

        const readQuote = async () =>
          room.evaluate(() => {
            const el = document.querySelector('[data-daily-quote]')
            return el ? String(el.innerText).replace(/\s+/g, ' ').trim() : null
          })

        const first = await readQuote()
        check(
          first !== null && first.includes(want.text) && first.includes(want.from),
          `${SR}：教室那块屏上有「每日名言」——而且**写出了出处**`,
          first ?? '没找到 [data-daily-quote]',
          `期望含「${want.text}」（${want.from}）`,
        )
        check(
          DAILY_QUOTES.every((q) => q.text && q.from),
          `${SR}：库里每一句名言都有出处（可考据，不许留空）`,
          `${DAILY_QUOTES.length} 条，缺出处的 ${DAILY_QUOTES.filter((q) => !q.text || !q.from).length} 条`,
        )

        /* 🔴 刷新一次再读：必须**一字不差**是同一句（当天固定，不是随机） */
        await room.reload({ waitUntil: 'networkidle' })
        await room.waitForTimeout(900)
        const second = await readQuote()
        check(
          second === first && second !== null,
          `${SR}：刷新两次是**同一句**（当天固定 —— 用日期做种子，不是随机）`,
          `第一次：${short(first, 60)} ／ 第二次：${short(second, 60)}`,
        )
      })

      /*
       * 教室端那块「逐题正确率」**不能收极简档案**。
       *
       * 极简模式没有任何逐题数据（`wrong` 恒为空），照普通模式渲染的话
       * 每一题都是 0% 错误率、看起来像"全班全对"（§九 W16 的教室端那一半）。
       * 判据在 `lib/wrongbook.ts` 的 `ranked` 里（§11.5「判据只有一处」），
       * 这一条断言就是钉住"教室端真的用了它"。
       *
       * ⚠️ 期望值 = **1 份**，不是 2：教室端是 `room.goto()` 打开的，而
       *    `addInitScript` 每次导航都会把 `shugao.teacher.v1` 覆盖成注入的那份快照，
       *    快照里**没有** `assignments` → 浅合并之后作业回到 seed 的初始状态
       *    （a-demo-1 已批改 / a-demo-2 与 a-demo-4 未批改 / a-demo-5 极简已批改）。
       *    所以这一屏上"能进教室端的"只有 a-demo-1 一份 ——
       *    把极简那份也算进来的话这里会变成 2 份，那正是要红的。
       */
      await step(SR, async () => {
        const opts = await room.evaluate(() =>
          [...document.querySelectorAll('select')]
            .map((s) => [...s.options].map((o) => (o.textContent ?? '').trim()))
            .find((list) => list.some((t) => t.includes('作业'))) ?? [],
        )
        check(
          opts.length === 1 && opts[0].includes('作业21'),
          `${SR}：作业选择器里只有普通模式档案（极简模式那份不在）`,
          `选项：${opts.join(' | ') || '(没找到作业选择器)'}`,
          '把极简那份也算进来的话这里会是 2 份',
        )
        const body = await bodyText(room)
        check(
          !body.includes('课堂练习抽查'),
          `${SR}：极简模式那份档案整个没进教室端`,
          body.includes('课堂练习抽查') ? short(body, 150) : '屏上没有它',
        )
      })

      await step(SR, async () => {
        // 展开错误名单（内联兜底面板，与置顶小窗同一份内容）
        await room.getByRole('button', { name: '展开错误名单' }).first().click()
        await room.waitForTimeout(400)
      })
      await step(SR, async () => {
        await expectRoom(SR)
      })
      await shotRaw(room, SR, '33-classroom-list')

      await step(SR, async () => {
        /*
         * 这台设备在教室里打开过 /classroom —— 但**角色并没有被标成 classroom**，
         * 因为当前身份是**教师账号**（accountKind === 'teacher'）：那属于"预览教室端"。
         * 只有教室端账号才会被标（Classroom.tsx: `if (accountKind === 'classroom') setDeviceRole('classroom')`），
         * 见 §十三/§十五 —— 教师账号看自己的班是产品设计，不是漏洞。
         * 所以这里断言的是**真正的产品行为**：教师账号预览不留痕、还能正常回教师端。
         */
        const role = await page.evaluate(() => localStorage.getItem('shugao.deviceRole'))
        check(
          role === 'teacher',
          '教师账号预览教室端**不会**把设备标成 classroom（只有教室端账号才会）',
          `shugao.deviceRole = ${role}`,
          '见 Classroom.tsx:618 与 §十三「账号身份 ≠ 设备标记」',
        )
        await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))

        // 教师端发出一次呼叫 → 教室端应弹出播报浮层
        await page.goto(`${BASE}${AK}`, { waitUntil: 'networkidle' })
        await expectPage(page, SR, { url: AK, markers: ak.markers })
        await page.getByRole('button', { name: /^\d+ 号 / }).nth(0).click()
        await page.getByRole('button', { name: /^\d+ 号 / }).nth(1).click()
        await page.getByRole('button', { name: /^\d+ 号 / }).nth(2).click()
        await page.getByRole('button', { name: '发送呼叫' }).click()
        await room.waitForTimeout(1600)
      })
      await step(SR, async () => {
        // 教室端真的收到并弹了浮层 —— 跨标签送达的唯一证据
        const b = await bodyText(room)
        check(
          /\d+ 号/.test(b) && /办公室/.test(b),
          '呼叫真的送到教室端了（浮层上有学号与地点）',
          short(b, 160),
        )
      })
      await shotRaw(room, SR, '34-classroom-broadcast')

      /*
       * ============================================================
       * S8（2026-10-08）：**「生成走班 → 班级页看名单」这条链**
       * ============================================================
       * 内测现场：⑥ 生成走班说「走班班-地理 2 人」，而班级页说「走班班-地理 名单完整 **0 人**」
       *   —— **同一份数据两个页面自相矛盾**。
       *
       * 根因（读的那一侧，不是写的那一侧，见 `功能设计与不变量.md` §四十六）：
       *   走班班的人在 `class_members`（多对多，§27.5），`students.class_id` 上**永远没有他们**；
       *   而班级列表 / 班级页原来读的都是 `klass.students` → 恒为 0 人，
       *   而 `analyzeRoster([])` 又把它判成「名单完整」（0 人没有缺号、没有重号）
       *   —— "没有数据被当成一切正常"，这个项目栽过最多次的形状。
       *
       * ⚠️ **这一节能验到哪一层（如实登记，别把它读成"整条链都验过了"）**：
       *   ① 判据层（纯函数）：四态 + "0 人不是完整" —— **正反两路都在这一层钉死**；
       *   ② 界面层：真浏览器打开 `/classes`，看**0 人的班那一行**（本地演示模式下可跑）；
       *   ③ 源码层：班级页走班那一支必须从 `class_members` 读、两页都走 `rosterStateOf()`。
       *   🔴 **验不到的一层（已知限制）**：本地演示模式下 `isRemote` 是**构建期常量 false**
       *      → `getSupabase()` 恒回 null → `class_members` / `class_subjects` 那两条**真读库**的路
       *      在本地跑不出来（本轮实测过：注入假客户端会让 zustand persist 的 rehydrate 走另一支，
       *      页面被 Guard 踢回登录页）。"生成之后班级页的人数 = 生成时的人数"这一条
       *      **只在有后端的环境上**成立；本节用①+③两条合起来逼近它：
       *      判据对 + 页面无第二个判定入口 → 线上不会分叉。
       */
      const S8 = 'S8 生成走班 → 班级页（名单 / 老师 / 0 人）'
      const S8_STREAM = '走班班-地理'
      const S8_ZERO = '高二(9)班'

      const ctxS8 = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
      await ctxS8.clock.install({ time: new Date('2026-09-19T10:00:00') })
      /** 注入那一份班级快照：两个行政班（原样）+ 一个走班班 + **一个 0 人的行政班** */
      await ctxS8.addInitScript((base) => {
        const classes = [
          ...base.classes.map((c) => ({ ...c })),
          {
            id: 'c-stream-geo',
            name: '走班班-地理',
            grade: '高二',
            year: '2025-2026',
            createdAt: 1,
            students: [],
            kind: 'stream',
            streamKey: 'geography',
          },
          { id: 'c-demo-9', name: '高二(9)班', grade: '高二', year: '2025-2026', createdAt: 2, students: [] },
        ]
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state: { ...base, classes }, version: 1 }))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE.state)

      const s8Page = await ctxS8.newPage()
      s8Page.on('pageerror', (e) => errors.push(`PAGEERROR(${S8}) :: ${e.message}`))
      s8Page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${S8}) :: ${m.text()}`)
      })

      await step(S8, async () => {
        /* ---------- ① 判据层：四态（正反两路都在这一层） ---------- */
        const { rosterStateOf, analyzeRoster } = await import('../src/lib/roster.ts')
        const mk = (n, nos) =>
          Array.from({ length: n }, (_, i) => ({
            id: `p${i}`,
            name: `学生${i + 1}`,
            studentNo: String(nos[i]),
            status: 'active',
            createdAt: i,
          }))
        const none = rosterStateOf([], 'class')
        const ok2 = rosterStateOf(mk(2, [1, 2]), 'members')
        const gap = rosterStateOf(mk(2, [1, 3]), 'class')
        const lost = rosterStateOf(mk(2, [1, 2]), 'members', false)
        check(
          none.kind === 'nobody' && ok2.kind === 'ok' && gap.kind === 'warn' && lost.kind === 'unknown',
          `${S8}：名单**四态分得开**（0 人 = 还没有名单 / 2 人 = 完整 / 缺号 = 待核对 / 没读到 = unknown）`,
          `nobody=${none.kind} · ok=${ok2.kind} · warn=${gap.kind} · unknown=${lost.kind}`,
        )
        check(
          ok2.count === 2 && none.count === 0 && lost.count === 0,
          `${S8}：**2 人的走班班与 0 人的班在判据这一层就长得不一样**（不是靠文案）`,
          `走班班 2 人 → ${ok2.count} · 空班 → ${none.count} · 没读到 → ${lost.count}`,
        )
        check(
          analyzeRoster([]).healthy === false && analyzeRoster(mk(2, [1, 2])).healthy === true,
          `${S8} ③ 🔴 **0 人不是"名单完整"**（反向对照：把 analyzeRoster 的 healthy 改回"只看缺号重号" → 这条红）`,
          `空名单 healthy=${analyzeRoster([]).healthy} · 2 人 healthy=${analyzeRoster(mk(2, [1, 2])).healthy}`,
        )
        /* 班级页体检那一块的三档（它由 rosterState 推出来，这里钉那三档的输入输出） */
        check(
          ok2.kind === 'ok' && ok2.health !== null && ok2.health.maxNo === 2 && none.health === null,
          `${S8}：2 人的走班班 → 体检块写"名单完整"；0 人的班 → **没有 health**（写不出"学号 1–0"）`,
          `2 人 health.maxNo=${ok2.health?.maxNo} · 0 人 health=${String(none.health)}`,
        )
        check(
          rosterStateOf(mk(2, [1, 2]), 'members').source === 'members' &&
            rosterStateOf(mk(2, [1, 2]), 'class').source === 'class',
          `${S8}：人数从哪儿来的**分得清**（走班班 = class_members / 行政班 = students.class_id）`,
          'source 逐条不同',
        )

        /* ---------- ② 界面层：0 人的班那一行（本地演示模式真的能跑这一段） ---------- */
        await s8Page.goto(`${BASE}/classes`, { waitUntil: 'networkidle' })
        await s8Page.waitForTimeout(700)
        check(
          s8Page.url().endsWith('/classes'),
          `${S8}：这一遍**真的落在 /classes**（不是被 Guard 踢回登录页 —— 那样后面的断言会假绿）`,
          s8Page.url(),
        )
        const b = await bodyText(s8Page)
        check(
          b.includes(S8_ZERO) && b.includes('还没有名单'),
          `${S8} ③：0 人的班在班级列表上写**「还没有名单」**`,
          short(b.match(new RegExp(`${S8_ZERO}[^]{0,40}`))?.[0] ?? b, 140),
        )
        check(
          !new RegExp(`${S8_ZERO}[^]{0,40}名单完整`).test(b),
          `${S8} ③b：0 人的班**不写**「名单完整」（反向对照：把班级卡片的徽章改回 h.healthy ? … → 这条红）`,
          short(b.match(new RegExp(`${S8_ZERO}[^]{0,40}`))?.[0] ?? b, 140),
        )
        check(
          b.includes('人数待读'),
          `${S8}：走班班的卡片上写**「人数待读」**（本地演示模式读不到 ` + '`class_members`' + ` 时就是这个状态；
             线上读得到时写真实人数 —— **不许写 0 人**）`,
          short(b.match(new RegExp(`${S8_STREAM}[^]{0,60}`))?.[0] ?? b, 90),
        )
        check(
          !b.includes('学号 1–0'),
          `${S8} ③c：**没有任何一张卡片写"学号 1–0"**（0 人的班不许编一个不存在的学号区间）`,
          b.includes('学号 1–0') ? '还在写 学号 1–0' : '搜不到 学号 1–0',
        )
        await shot(s8Page, S8, '110-stream-classes-nokb', { full: true })

        /* ---------- ③ 源码层：读成员那条路**只有一处**，页面上不许退回 klass.students ---------- */
        const cdSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'ClassDetail.tsx'), 'utf8')
        const clSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'Classes.tsx'), 'utf8')
        check(
          /loadClassMembersFull\(\[id\]\)/.test(cdSrc) &&
            /* ⚠️ 2026-10-11：名单那一份挪到 `if (!klass)` **之前**了（档案那一次读也要按它读），
               所以现在是 `(klass?.students ?? [])`，不再是 `klass.students`（这一句跟着改）。
               ⚠️ 2026-10-13：`roster` 外面包了 `useMemo`（lint 的 exhaustive-deps 嫌它每渲染都是新数组），
               原来那行字面量拆成了「先取 `classStudents`，再 `useMemo` 里 `isStream ? members : (classStudents ?? [])`」
               —— 判据盯的仍然是同一件事：**走班班那一支读 `members`（class_members），不是 `klass.students`**。 */
            /const classStudents = klass\?\.students/.test(cdSrc) &&
            /const roster = useMemo\(/.test(cdSrc) &&
            /\(\) => \(isStream \? members : \(classStudents \?\? \[\]\)\)/.test(cdSrc),
          `${S8}：班级页的名单 —— 走班班那一支从 class_members 读（loadClassMembersFull），不是 klass.students`,
          /loadClassMembersFull/.test(cdSrc) ? '读成员那一路在' : '搜不到（改回旧写法这条就红）',
        )
        check(
          /rosterStateOf\(/.test(cdSrc) && /rosterStateOf\(/.test(clSrc),
          `${S8}：班级页与班级列表**都用 rosterStateOf() 判四态**（页面里没有第二套"0 人就完整"）`,
          `ClassDetail=${(cdSrc.match(/rosterStateOf\(/g) ?? []).length} 处 · Classes=${(clSrc.match(/rosterStateOf\(/g) ?? []).length} 处`,
        )
        check(
          !/h\.healthy \? <Tag/.test(clSrc),
          `${S8}（对照的机器版）：班级列表里**不再有**"healthy 就写名单完整"那一句`,
          /h\.healthy \? <Tag/.test(clSrc) ? '还能搜到旧写法' : '搜不到旧写法',
        )
        check(
          /loadClassMembersFull/.test(readFileSync(join(HERE, '..', 'src', 'data', 'remote.ts'), 'utf8')),
          `${S8}：读成员那一份（带姓名 / 学号）在 data/remote.ts 里**只有一处实现**`,
          'loadClassMembersFull 在',
        )

        /* ---------- ④ 走班班的**行内那一格**：不是"编辑学生"，是「移出这个走班班」 ----------
         *
         * 内测现场（2026-10-09）：走班班-地理 的班级档案页，名单每行右边那颗**铅笔点了没反应**。
         * 根因：`openEdit` 拿 `klass.students`（= `students.class_id`）去 `find` 这个人，
         *   而走班班的人**永远不在** `students.class_id` 上（在 `class_members`，§27.5）
         *   → `s` 是 `undefined` → 早退、`editing` 不设 → 浮层不打开。
         *   ⚠️ 按钮本身**摆着**，所以看起来"点了没反应"，不是"没权限"。
         *
         * 语义（本轮拍板）：姓名 / 学号 / 在班状态属于他的**行政班**，在走班班的页面上改不合理；
         *   走班班这一格该做的事是「移出这个走班班」（他不再上这门课，写 `class_members`）。
         *
         * ⚠️ 能验到哪一层（如实登记）：本地演示模式读不到 `class_members`（`isRemote` 是构建期
         *   常量 false，见上面那段已知限制）→ **点一下真发请求那一段在本地跑不出来**。
         *   所以这里钉三件事：① 那一格的**摆法**（源码层）② 移出的**写路径**（已有函数，不新写）
         *   ③「移出一个人」= 集合减一个，且**碰不到 `students.class_id`**（判据层真算一遍）。
         */
        /* ⚠️ 取**第二处** `{isStream ? (` —— 这一页**前面**还有一个同形的块（走班班老师那一行），
           不加锚点会切到那儿去（实测切错一次）。 */
        const cellAt = cdSrc.indexOf('{isStream ? (', cdSrc.indexOf('{isStream ? (') + 1)
        const cell = cdSrc.slice(cellAt, cellAt + 1100)
        check(
          cellAt > 0 &&
            /data-stream-leave="1"/.test(cell) &&
            !/openEdit\(s\.id\)/.test(cell.split(') : (')[0] ?? ''),
          `${S8} ④ 🔴 **走班班那一格摆的是「移出」**（反向对照：把它改回 \`openEdit(s.id)\` → 这条红）`,
          short(cell.match(/\{isStream \?[^]{0,160}/)?.[0] ?? cell, 170),
        )
        check(
          /openEdit\(s\.id\)/.test(cell) &&
            /<button[\s\S]{0,200}?aria-label="编辑"[\s\S]{0,200}?<IconPencil/.test(cell),
          `${S8} ④ **行政班那一格照旧是铅笔**（改姓名 / 学号 / 在班状态是行政班的事）；` +
            `反向对照：把它一起换掉 → 这条红`,
          short(cell.match(/\) : \([\s\S]{0,150}/)?.[0] ?? cell, 170),
        )
        check(
          /remote\.saveStreamMembers\(klass\.id, next\)/.test(cdSrc) &&
            !/from\('class_members'\)[\s\S]{0,120}\.(insert|delete|upsert)\(/.test(cdSrc),
          `${S8} ④ 🔴 移出走的是**已有的** ` + '`saveStreamMembers()`' + `（§37.1 \`write_stream_members\`）` +
            `—— 页面里**没有第二条写 \`class_members\` 的路**（不新写写路径）`,
          `saveStreamMembers=${/remote\.saveStreamMembers\(/.test(cdSrc)} · 页面里直接写 class_members=${/from\('class_members'\)[\s\S]{0,120}\.(insert|delete|upsert)\(/.test(cdSrc)}`,
        )
        /* ③ 判据层：真算一遍"移出一个人" + 那个写函数**只碰 `class_members`** */
        const before = ['s1', 's2', 's3']
        const after = before.filter((x) => x !== 's2')
        check(
          after.length === before.length - 1 && !after.includes('s2') && JSON.stringify(after) === '["s1","s3"]',
          `${S8} ④ 移出一个人 = **整份替换里少他一个**（` + '`class_members`' + ` 真的少一行）`,
          `${before.join(',')} → ${after.join(',')}`,
        )
        /*
         * ⚠️ 只切**移出那个函数体**（`goOut`）—— 这一页开头的 `const updateStudent = useStore(…)`
         *   与**行政班**那个编辑浮层里的 `updateStudent(klass…)` 是**对的那条路**，
         *   拿整份文件去搜会把它们一起搜出来（实测踩过：这条一开始就是那样假红的）。
         */
        const goOutBody = cdSrc.slice(cdSrc.indexOf('const goOut = async'), cdSrc.indexOf('const saveProfile = async'))
        check(
          goOutBody.includes('saveStreamMembers') &&
            !/update students[\s\S]{0,80}class_id/i.test(goOutBody) &&
            !/updateStudent\(klass/.test(goOutBody) &&
            !/removeStudent\(klass/.test(goOutBody),
          `${S8} ④ 🔴 「移出」那个函数体**只写 ` + '`class_members`' + `**，一个字节都没碰 ` +
            '`students.class_id`' + `（学生还在他的行政班里）；反向对照：把它写成 \`updateStudent(klass…\` → 这条红`,
          `saveStreamMembers=${goOutBody.includes('saveStreamMembers')} · updateStudent(klass=${/updateStudent\(klass/.test(goOutBody)} · removeStudent(klass=${/removeStudent\(klass/.test(goOutBody)}`,
        )
        /* ②b 读哪些人的档案 = **同一份名单**（不是回去读 klass.students） */
        check(
          /loadStudentProfiles\(profileIds \? profileIds\.split\(','\) : \[\]\)/.test(cdSrc) &&
            !/loadStudentProfiles\(klass\.students/.test(cdSrc),
          `${S8} ④ 走班班学生的**档案也读得出来**（读的是同一份名单）：` +
            `反向对照：把这一句改回 \`klass.students\` → 走班班成员的档案恒「未录入」，这条红`,
          /loadStudentProfiles\(profileIds/.test(cdSrc) ? '按名单读' : '又回去读 klass.students',
        )
        /* ②c 摆不摆那个「移出」入口 = 与这一页别处**同一个判据**（不新发明）。
           ⚠️ 顺序是 `{isStream ? ( canManageThis ? ( … data-stream-leave …` ——
              `data-stream-leave` **在** `canManageThis ? (` **之后**，别写反（实测写反过）。
           ⚠️ 别拿 `…\) : null` 去跨那一段收尾（`)` 与 `null` 之间隔着别的括号）——
              只钉"判据就是 canManageThis + 里面确实是那颗按钮"。 */
        check(
          /\{isStream \? \(\s*canManageThis \? \([\s\S]{0,300}?data-stream-leave="1"/.test(
            cdSrc.slice(cellAt, cellAt + 1400),
          ),
          `${S8} ④ 「移出」入口的判据就是 \`canManageThis\`（= \`can_manage_class_for\` 的前端影子）` +
            `—— 老师这一档**看不到**这个按钮，直接调接口仍由函数里的 \`can_manage_class\` 拒`,
          'canManageThis ? (…移出… ) : null',
        )
      })

      await ctxS8.close()


      /*
       * ============================================================
       * S10（2026-10-08）：**走班班的编辑 / 删除** + 右栏「名单体检」的 0 人
       * ============================================================
       * 内测现场：①「走班班都没有编辑键」②「删不了」③ 右栏「名单体检」给 0 人的班画绿勾。
       *
       * ①② 的根因（**读的那一侧**，不是权限那一侧）：
       *   走班班是 `classes` 里 `kind='stream'` 的一行、**有 `grade_id`**，
       *   `classes_update` / `classes_delete` 用的 `can_manage_class_for()` 对它**天然成立**
       *   —— 也就是说"能做，只是没摆"。补的是**入口**（前端）+ **成员那一条写路径**
       *   （`class_members` 对 `authenticated` 零写权限，所以要 §37.1 那个函数）。
       *   ⚠️ 判据层那几条（年级主任 / 科任 / 别班班主任 / 教室端）在 `rls-checks.mjs` 第二十二节。
       *
       * ⚠️ **这一节能验到哪一层**（如实登记）：本地演示模式 `isRemote` 是构建期常量 false
       *    → `class_members` / `class_subjects` 两条真读库的路跑不出来（见 S8 那段）。
       *    所以这里验的是：**入口摆不摆**（判据层用假的 `myRoles` 注入）+ **右栏那两行字**
       *    （本地能跑的那一半）+ **源码层**（成员写的是 `class_members`，不是 `students.class_id`）。
       */
      const S10 = 'S10 走班班的编辑/删除 + 右栏名单体检的 0 人'
      const S10_STREAM = '走班班-政治'
      const S10_ZERO = '高二(8)班'

      const ctxS10 = await browser.newContext({ viewport: { width: 1500, height: 900 }, locale: 'zh-CN' })
      await ctxS10.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxS10.addInitScript((base) => {
        const classes = [
          ...base.classes.map((c) => ({ ...c })),
          {
            id: 'c-s10-stream',
            name: '走班班-政治',
            grade: '高二',
            year: '2025-2026',
            createdAt: 1,
            students: [],
            kind: 'stream',
            streamKey: 'politics',
          },
          { id: 'c-s10-zero', name: '高二(8)班', grade: '高二', year: '2025-2026', createdAt: 2, students: [] },
        ]
        /* `?roles=` 注入身份（与身份标签那一节同一个手法）——**只影响"摆不摆入口"** */
        const raw = new URLSearchParams(location.search).get('roles')
        const state = raw ? { ...base, classes, myRoles: JSON.parse(raw) } : { ...base, classes }
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE.state)

      const s10Page = await ctxS10.newPage()
      s10Page.on('pageerror', (e) => errors.push(`PAGEERROR(${S10}) :: ${e.message}`))
      s10Page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${S10}) :: ${m.text()}`)
      })

      /** 右栏「名单体检」那一块：每行 = `名称|文字|是哪一颗图标`（**按 svg 的 path 认**，不按"有没有 svg"） */
      const healthRows = () =>
        s10Page.evaluate(() => {
          const sec = [...document.querySelectorAll('section.panel')].find((s) =>
            (s.textContent ?? '').includes('名单体检'),
          )
          if (!sec) return []
          return [...sec.querySelectorAll('div.flex.items-center.gap-2')].map((d) => {
            const svg = d.querySelector('svg')
            /* 绿勾只有那一条 path（`IconCheck`）；`IconAlert` 是别的形状 ——
               ⚠️ **不能**用"有没有 svg"当判据：两个图标都是 svg，那样量出来恒为 true（第一版就这么栽的） */
            const html = svg ? svg.innerHTML : ''
            return {
              text: (d.innerText ?? '').replace(/\s+/g, ' ').trim(),
              icon: !svg ? 'none' : /4\.9 12\.6/.test(html) ? 'check' : 'alert',
            }
          })
        })

      await step(S10, async () => {
        /* ---------- ① 右栏名单体检：0 人的班不许是绿勾 ---------- */
        await s10Page.goto(`${BASE}/classes?roles=${encodeURIComponent('[{"role":"super"}]')}`, {
          waitUntil: 'networkidle',
        })
        await s10Page.waitForTimeout(700)
        check(
          new URL(s10Page.url()).pathname === '/classes',
          `${S10}：这一遍**真的落在 /classes**（不是被 Guard 踢回登录页 —— 那样后面的断言会假绿）`,
          s10Page.url(),
        )
        const rows = await healthRows()
        check(
          rows.length >= 3,
          `${S10}：右栏「名单体检」这一块**真的渲染了**（不然下面两条是假绿）`,
          `读到 ${rows.length} 行：${rows.map((r) => r.text).join(' / ')}`,
        )
        const zeroRow = rows.find((r) => r.text.includes(S10_ZERO))
        check(
          Boolean(zeroRow) && /还没有名单/.test(zeroRow.text),
          `${S10} 🔴 0 人的班（${S10_ZERO}）右栏写**「还没有名单」**，不写「0 人」`,
          zeroRow ? zeroRow.text : '右栏里找不到这一行',
        )
        check(
          Boolean(zeroRow) && zeroRow.icon !== 'check',
          `${S10} 🔴 **0 人的班不许画绿勾**（反向对照：把右栏改回 issues === 0 ? <IconCheck/> → 这条红）`,
          zeroRow ? `图标=${zeroRow.icon} · 文字=${zeroRow.text}` : '右栏里找不到这一行',
        )
        const streamRow = rows.find((r) => r.text.includes(S10_STREAM))
        check(
          Boolean(streamRow) && /人数待读|还没有名单|名单没读到/.test(streamRow.text),
          `${S10}：走班班那一行的人数**从 ` + '`class_members`' + ` 来** —— 本地读不到就写「人数待读」，**绝不写 0 人**`,
          streamRow ? `图标=${streamRow.icon} · 文字=${streamRow.text}` : '右栏里找不到这一行',
        )
        check(
          Boolean(streamRow) && streamRow.icon !== 'check',
          `${S10} 🔴 走班班**名单没读到**时也不许画绿勾（同一条：没有数据 ≠ 一切正常）`,
          streamRow ? `图标=${streamRow.icon} · 文字=${streamRow.text}` : '右栏里找不到这一行',
        )
        await shot(s10Page, S10, '111-classes-health-zero', { full: true })

        /* ---------- ② 走班班的编辑 / 删除入口（摆不摆 = 判据的前端影子） ---------- */
        const entries = () =>
          s10Page.evaluate(() => ({
            edit: document.querySelectorAll('[data-stream-edit="1"]').length,
            del: document.querySelectorAll('[data-stream-del="1"]').length,
          }))
        const eSuper = await entries()
        check(
          eSuper.edit === 1 && eSuper.del === 1,
          `${S10}：超管在班级页**点得到**走班班的编辑与删除（内测「都没有编辑键」「删不了」）`,
          `编辑=${eSuper.edit} 删除=${eSuper.del}`,
        )

        await s10Page.goto(`${BASE}/classes?roles=${encodeURIComponent('[{"role":"teacher"}]')}`, {
          waitUntil: 'networkidle',
        })
        await s10Page.waitForTimeout(600)
        const eTeacher = await entries()
        check(
          eTeacher.edit === 0 && eTeacher.del === 0,
          `${S10} 🔴 **反向对照**：只有任课教师这一档 → 走班班的编辑 / 删除入口**一个都不摆**` +
            `（反向对照：把入口的判据放宽成"任何登录者" → 这条红）`,
          `编辑=${eTeacher.edit} 删除=${eTeacher.del}`,
        )

        await s10Page.goto(
          `${BASE}/classes?roles=${encodeURIComponent('[{"role":"grade_head","scopeType":"grade"}]')}`,
          { waitUntil: 'networkidle' },
        )
        await s10Page.waitForTimeout(600)
        const eGrade = await entries()
        check(
          eGrade.edit === 1 && eGrade.del === 1,
          `${S10}：**本年级**年级主任摆（走班班有 grade_id，` + '`can_manage_class_for`' + ` 的年级那一支成立）`,
          `编辑=${eGrade.edit} 删除=${eGrade.del}`,
        )

        /* ---------- ③ 面板真的打得开：这三件事都在里面 ---------- */
        await s10Page.goto(`${BASE}/classes?roles=${encodeURIComponent('[{"role":"super"}]')}`, {
          waitUntil: 'networkidle',
        })
        await s10Page.waitForTimeout(600)
        await s10Page.click('[data-stream-edit="1"]')
        await s10Page.waitForTimeout(500)
        const sheet = await bodyText(s10Page)
        check(
          sheet.includes('编辑走班班') &&
            sheet.includes('走班老师') &&
            sheet.includes('走班成员') &&
            sheet.includes('删除这个走班班'),
          `${S10}：面板里三件事齐（改名 / 换走班老师 / 手工增删成员）+ 删除入口`,
          short(sheet.match(/编辑走班班[^]{0,120}/)?.[0] ?? sheet, 160),
        )
        check(
          sheet.includes('一个学生可以同时在两个走班班里'),
          `${S10}：成员那一栏写清了口径（**多对多**，一个学生可以在两个走班班）`,
          short(sheet.match(/走班成员[^]{0,90}/)?.[0] ?? sheet, 120),
        )
        await s10Page.click('button:has-text("删除这个走班班")')
        await s10Page.waitForTimeout(300)
        const confirmText = await bodyText(s10Page)
        check(
          /会一起删掉/.test(confirmText) && /确认删除/.test(confirmText) && /先不删/.test(confirmText),
          `${S10}：删除要**二次确认**，而且说清会删掉什么`,
          short(confirmText.match(/删除「[^]{0,140}/)?.[0] ?? confirmText, 170),
        )
        await shot(s10Page, S10, '112-stream-edit-sheet', { full: true })

        /* ---------- ④ 源码层：成员写的是 `class_members`，不是 `students.class_id` ---------- */
        const clSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'Classes.tsx'), 'utf8')
        const rmSrc = readFileSync(join(HERE, '..', 'src', 'data', 'remote.ts'), 'utf8')
        const sqlSrc = readFileSync(join(HERE, '..', '..', 'supabase', 'schema.sql'), 'utf8')
        check(
          /saveStreamMembers/.test(clSrc) && /write_stream_members/.test(rmSrc),
          `${S10} 🔴 加删成员走的是 ` + '`write_stream_members()`' + `（写 ` + '`class_members`' + `）`,
          '面板 → remote.saveStreamMembers → write_stream_members',
        )
        check(
          /insert into class_members \(class_id, student_id\)/.test(sqlSrc) &&
            !/update students set class_id[\s\S]{0,200}write_stream_members/.test(sqlSrc),
          `${S10} 🔴 那个函数写的是 ` + '`class_members`' + `，**没有**去碰 ` + '`students.class_id`' + `（上一轮栽过）`,
          'class_members 那一句在 · students.class_id 那一句不在',
        )
        check(
          /delete from class_members where class_id = p_class_id/.test(sqlSrc) &&
            /grant execute on function public\.write_stream_members\(uuid, uuid\[\]\) to authenticated/.test(
              sqlSrc,
            ),
          `${S10}：整份替换（先清再插）+ ` + '`authenticated`' + ` 能调（函数自己问 ` + '`can_manage_class`' + `）`,
          'delete + insert + grant 都在',
        )
        check(
          /canEditClassFor\(myRoles, c\.id, c\.gradeId\)/.test(clSrc),
          `${S10}：入口判据是 ` + '`canEditClassFor()`' + `（` + '`can_manage_class_for`' + ` 的前端影子）——` +
            `这里**不新发明判据**、` + '`kind`' + ` 不参与权限判断`,
          'canEditClassFor(myRoles, c.id, c.gradeId) 在',
        )
        check(
          /name: name\.trim\(\)/.test(clSrc) && /\bapiAssignStreamTeacher\(/.test(clSrc),
          `${S10}：改名走 ` + '`saveStreamName`' + `、换老师走 **已有**的 ` +
            '`apiAssignStreamTeacher`' + `（§32.3，它会补 class_subjects，不另写一套）` +
            ` —— ⚠️ 换老师**不能**顺手打一次：那一条的判据比改名窄（不含班主任），多打会让纯改名也失败`,
          `saveStreamName=${/saveStreamName/.test(clSrc)} · apiAssignStreamTeacher=${/\bapiAssignStreamTeacher\(/.test(clSrc)} · name.trim=${/name: name\.trim\(\)/.test(clSrc)}`,
        )

        /* ---------- ⑤ 源码层：右栏那一块也不许再有"0 人也画勾" ---------- */
        const asSrc = readFileSync(join(HERE, '..', 'src', 'components', 'AppShell.tsx'), 'utf8')
        check(
          /rosterStateOf\(/.test(asSrc) && !/const h = analyzeRoster\(c\.students\)/.test(asSrc),
          `${S10} 🔴 右栏「名单体检」走 ` + '`rosterStateOf()`' + ` 四态，不再自己算 ` + '`analyzeRoster`',
          /rosterStateOf\(/.test(asSrc) ? 'rosterStateOf 在 · 旧写法不在' : '旧写法还在',
        )
        check(
          /classKindOf\(c\) === 'stream'/.test(asSrc) && /loadClassMembersFull/.test(asSrc),
          `${S10}：右栏对走班班从 ` + '`class_members`' + ` 数（` + '`loadClassMembersFull`' + `），不是 ` +
            '`students.class_id`',
          'classKindOf + loadClassMembersFull 都在',
        )
      })

      await ctxS10.close()


      /*
       * ============================================================
       * G7（用户 2026-09-28 拍板）：教师账号在**被标成教室端的设备**上打开 /classroom → 拦住
       * ============================================================
       * 为什么这不是"把黄条改红"那么轻的一件事：
       *   这块屏是**挂在教室里给学生看的**，而教师账号在它上面渲染的是**他自己的全部班级数据**
       *   （名单、收缴、讲评材料）。只提醒一句就放行 = **用一条提示代替了一道安全边界**，
       *   而这条边界两端不对等：拦错的代价是"老师去自己电脑上看"，
       *   放过的代价是"全班学生看到教师数据"。
       *
       * 三条断言，**正反两路都要**（只钉"拦住"的话，把教室端账号也一起拦掉照样绿）：
       *   ① 教师账号 + 设备被标成教室端 → **拦住**，而且屏上没有任何班级数据；
       *   ② 教室端账号 + 同一台设备      → **照常放行**（那正是这块屏的主人）；
       *   ③ 教师账号 + 自己的设备        → **照常是预览**（否则老师没法核对那块屏长什么样）。
       */
      const SG7 = 'G7 教师账号不许在一体机上开教室端'

      const ctxG7 = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
      await ctxG7.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxG7.addInitScript((base) => {
        const kind = new URLSearchParams(location.search).get('kind')
        const role = new URLSearchParams(location.search).get('role') ?? 'classroom'
        // 身份注入沿用身份标签那一节的 `?roles=` 手法（见那里的长注释）
        const raw = new URLSearchParams(location.search).get('roles')
        const state = raw ? { ...base, myRoles: JSON.parse(raw) } : base
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
        window.localStorage.setItem('shugao.deviceRole', role)
        if (kind) window.localStorage.setItem('shugao.accountKindProbe', kind)
      }, TEACHER_STATE.state)
      const g7Page = await ctxG7.newPage()
      g7Page.on('pageerror', (e) => errors.push(`PAGEERROR(${SG7}) :: ${e.message}`))
      g7Page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${SG7}) :: ${m.text()}`)
      })

      await step(SG7, async () => {
        /*
         * ① 教师账号 + 设备被标成教室端。
         * 本地模式（这个脚本跑的就是本地模式）里 `accountKind` 恒为 'teacher'
         * —— 那正是"教师账号"，判据 `accountKind !== 'classroom'` 成立。
         * ⚠️ 这里**不用** `?roles=` 注入身份：判据读的是 `accountKind`（账号类型），
         *    与 `teacher_roles` 无关 —— 而且 `ADMIN_ROLES` 那个常量定义在更后面
         *    （超管面板那一节），在这里引用会 TDZ 报错（第一版就踩了）。
         */
        await g7Page.goto(`${BASE}/classroom?role=classroom`, { waitUntil: 'networkidle' })
        await g7Page.waitForTimeout(600)
        const b = await bodyText(g7Page)
        const blocked = await g7Page.evaluate(
          () => document.querySelectorAll('[data-classroom-blocked]').length,
        )
        check(
          blocked === 1,
          `${SG7}：教师账号 + 这台设备被标成教室端 → **拦住**（出的是拦截卡，不是那块屏）`,
          `[data-classroom-blocked] 节点数 = ${blocked}`,
        )
        check(
          b.includes('教师账号不能在这台设备上打开教室端'),
          `${SG7}：而且把"为什么"写清楚（那块屏是给学生看的，教师账号在上面是自己的班级数据）`,
          short(b, 200),
        )
        check(
          b.includes('教室端账号') && b.includes('/classroom') && b.includes('教师密码'),
          `${SG7}：给出三条出路（用教室端账号 / 去另一台设备核对 / 登一次教师密码改回教师端）`,
          short(b.match(/.{0,20}三条出路.{0,120}/)?.[0] ?? b, 200),
        )
        /*
         * 🔴 最要紧的一条：**屏上不许有任何班级数据**。
         *    拦住的判据不是"有个卡片"，而是"名单/收缴/讲评一个字都没渲染出来"。
         *
         * ⚠️ 判据要**只看真数据**，不能查"未交""名单"这种词 ——
         *    拦截卡自己的说明文字里就写着「名单、收缴、讲评材料」，那样查会自证失败
         *    （第一版就踩了：`b.includes('未交')` 命中的是卡片文案）。
         *    这里换成三类**只可能来自数据**的东西：班名、学生姓名、收缴计数格子。
         */
        const demo = DEMO_CLASSES[0]
        const studentNames = demo.students.slice(0, 15).map((s) => s.name)
        const leaked = [
          demo.name,
          `… ${demo.name}`,
          ...studentNames,
          // 教室端「本次作业」那块面板的三格标题；拦截卡不长这样
          '本次作业',
        ].filter((x) => x && b.includes(x))
        check(
          leaked.length === 0,
          `${SG7}：**屏上一个字的学生数据都没有**（这才是"拦住"的判据，不是"有张卡片"）`,
          leaked.length ? `泄漏了：${leaked.join('、')}` : '没有班名 / 学生姓名 / 「本次作业」面板',
        )
        // 反向对照：同一份数据在**放行**的那一轮里**必须**出现 —— 否则上面那条是恒真的
        await shotRaw(g7Page, SG7, '84-classroom-teacher-blocked')

        /* ② 数据确实"本该出现在屏上" —— 这一条是 ① 的**反向对照**。
         *
         * 为什么要它：① 那条断言"屏上没有班名/学生姓名"**有可能是恒真的**
         * （比如注入的数据根本没进去）。所以这里先证明"同一份数据在**没被拦**的时候
         * 真的会渲染出来" —— 两条合起来才说明"拦住"这个动作真的起了作用。
         */
        const probeCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
        await probeCtx.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await probeCtx.addInitScript(
          (base) => {
            window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state: base, version: 1 }))
            window.localStorage.setItem('shugao.deviceRole', 'teacher')
          },
          TEACHER_STATE.state,
        )
        const probePage = await probeCtx.newPage()
        await probePage.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
        await probePage.waitForTimeout(600)
        const probeBody = await bodyText(probePage)
        const probeShowsClass = probeBody.includes(demo.name)
        const probeShowsStudent = demo.students.slice(0, 15).some((s) => probeBody.includes(s.name))
        check(
          probeShowsClass || probeShowsStudent,
          `${SG7}：反向对照 —— 同一份数据在**放行**时确实会渲染出班级数据（所以①那条不是恒真）`,
          `放行那一轮：班名=${probeShowsClass}，学生姓名=${probeShowsStudent}`,
        )
        await probeCtx.close()

        /* ③ 教师账号 + 自己的设备（deviceRole=teacher）→ 照常放行 */
        await g7Page.goto(`${BASE}/classroom?role=teacher`, { waitUntil: 'networkidle' })
        await g7Page.waitForTimeout(600)
        const ownBlocked = await g7Page.evaluate(
          () => document.querySelectorAll('[data-classroom-blocked]').length,
        )
        const ownBody = await bodyText(g7Page)
        check(
          ownBlocked === 0,
          `${SG7}：教师账号 + **自己的**设备 → 照常放行（老师要能核对那块屏长什么样）`,
          `拦截卡节点数 = ${ownBlocked}；屏上：${short(ownBody, 120)}`,
        )
        await shotRaw(g7Page, SG7, '85-classroom-teacher-preview-ok')
      })
      await ctxG7.close()


      /* ============ 移动端底部导航：**亮色**液态玻璃 + 液态玻璃胶囊 ============ */

      /*
       * 35/36/37 三张原来**字节完全相同**（188492/188492/188492）——
       * 说明那 240ms/900ms 的等待在这个场景**没产生任何视觉差异**，截图证明不了"落定"态。
       * 现在除了 URL，还量**高亮胶囊的位置**（`nav span[aria-hidden]` 的 left）：
       *   · 点之前高亮在「工作台」那一格；
       *   · 点之后 URL 必须变成 /assignments，高亮必须滑到「作业」那一格（left 变大）。
       * 位置真的变了，三张图才可能是不同的画面。
       */
      const SN = '35–37 移动端底部导航'
      let hiBefore = null

      /*
       * 🔴 **2026-10-11：这三条"等固定毫秒"的等待换成了"等条件"** —— 根因是**实测**出来的，不是保险起见。
       *
       * 现象：同一条断言时红时绿（同一台机、同一份代码，一次红 4 条、一次红 1 条，
       * 而"再展开一次导航又是透明的"那条**三次里红了两次**）。
       *
       * 根因：**页面在后台时，CSS 过渡的时钟不动**。实测（临时诊断，4 组对照）：
       *   · 被测页在前台：`opacity-0` 类已加上 → computed `opacity = 0`、`getAnimations() = []` ✅
       *   · 先把**另一个标签页** `bringToFront()`（= 被测页进后台）：
       *     **类还是 `opacity-0`、`aria-expanded=true`、Sheet 也在**，但 computed `opacity = 1`、
       *     `getAnimations() = ['running']` —— 过渡**卡在起点**，后台 2/2 复现 ❌
       *   · 再 `bringToFront()` 拿回前台 → 立刻又变回 `opacity = 0`（2/2）✅
       * 而 `shots.mjs` 跑到这一节时，**前面已经开过好几个 page**（S1–S34 各自 `newPage`），
       * 谁是前台页并没有保证 —— 这就是"时红时绿"的来源。
       *
       * 所以三条修法（都不是"把等待调长"）：
       *   ① **`bringToFront()`**：断言之前显式把被测页拿到前台；
       *   ② **等条件**（`pollUntil`）：等 computed 值真的到位，而不是等固定毫秒；
       *   ③ 超时后**照常断言** —— 红的时候读数里带着 `timeout` 标记，一眼看出是"没等到"还是"值不对"。
       */
      const ENV_SN = { front: false }
      const ensureFront = async () => {
        if (ENV_SN.front) return
        ENV_SN.front = true
        await page.bringToFront()
        await page.waitForTimeout(120)
      }
      /** 等 `readFn()` 返回期望值；超时返回最后一次读数 + `timeout: true`（**不抛**，让断言去红） */
      const pollUntil = async (readFn, okFn, ms = 4000) => {
        const t0 = Date.now()
        let last = null
        for (;;) {
          last = await readFn()
          if (okFn(last)) return last
          if (Date.now() - t0 > ms) return { ...(last ?? {}), timeout: true }
          await page.waitForTimeout(50)
        }
      }

      await step(SN, async () => {
        await ensureFront()
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await expectPage(page, SN, { url: '/', markers: ['今日待办'], date: D0919 })
        await page.evaluate(() => window.scrollTo(0, 560))
        await page.waitForTimeout(700)
        const info = await pageInfo(page)
        check(
          JSON.stringify(info.navActive) === JSON.stringify(['工作台']),
          '胶囊里高亮的是「工作台」',
          `data-active=true 的是 ${JSON.stringify(info.navActive)}（胶囊共 ${info.navAll.length} 格：${info.navAll.join('、')}）`,
        )
        hiBefore = info.hi
        check(Boolean(hiBefore), '量到了高亮胶囊的位置（后面要拿它比"有没有动"）', JSON.stringify(hiBefore))
      })
      await shot(page, SN, '35-nav-frost', { wait: 0, expect: { url: '/' } })

      await step(SN, async () => {
        /*
         * 点「作业」→ **必须真的跳过去**。导航出过"看着点了其实没跳"的故障
         * （pointerdown 就 setPointerCapture，里面的 NavLink 收不到 click）。
         * 这里等 URL 真的变成 /assignments，超时就是红。
         */
        await page.getByRole('link', { name: '作业' }).click()
        await page.waitForURL('**/assignments', { timeout: 8000 })
        await waitPageSettled(page)
      })
      await shot(page, SN, '36-nav-travel', {
        wait: 0,
        expect: { url: '/assignments', markers: ['按上次新建'] },
      })

      await step(SN, async () => {
        const info = await pageInfo(page)
        check(
          JSON.stringify(info.navActive) === JSON.stringify(['作业']),
          '落定后高亮滑到了「作业」',
          `data-active=true 的是 ${JSON.stringify(info.navActive)}`,
        )
        check(Boolean(info.hi), '量到了落定后的高亮位置', JSON.stringify(info.hi))
        // 高亮的 left 必须真的移动过 —— 没动说明"滑动"这件事根本没发生（三张图就会是同一张）
        check(
          hiBefore && info.hi && info.hi.left !== hiBefore.left,
          '高亮胶囊的位置**真的变了**（三张图不是同一张）',
          `点击前 left=${hiBefore?.left} → 落定后 left=${info.hi?.left}`,
          '三张图字节相同就说明等待没起作用，所以这里量 DOM 而不是比字节',
        )
        await page.waitForTimeout(900)
      })
      await shot(page, SN, '37-nav-settled', {
        wait: 0,
        expect: { url: '/assignments' },
      })

      /*
       * 展开层（右边那颗圆按钮）里到底有哪些入口。
       *
       * 为什么必须断言它：这一层是**推导**出来的（`COLLAPSED = NAV − PIN_KEYS`），
       * 往 NAV 里加/改一条，胶囊不会变、这一层会变 —— 而它平时是收起的，
       * 截图里看不见。用户 2026-09-27 拍板：「日程表」要进这一层
       * （个人的排课表原来只在「我的」里，而它和班级课表是两套数据，都叫"课表"分不清）；
       * 同时明确「呼叫记录」**不进**这一层。
       */
      const SNM = '35–37 移动端底部导航 · 展开层'
      await step(SNM, async () => {
        /*
         * 🆕 **圆按钮是"展开 / 收起"开关**（2026-09-28 用户拍板：原来那个纸飞机语义不对）。
         * 换图标本身是外观，**要钉住的是"开着还是关着看得出来"** ——
         * 这里在点之前/之后各量一次同一个按钮：
         *   · 无障碍名：`展开更多入口` → `收起更多入口`（视觉与 aria-label 必须一致）；
         *   · `aria-expanded`：false → true；
         *   · 里面那个箭头的 `transform`：未展开朝上 / 已展开朝下，两次必须**不一样**。
         * ⚠️ 名字那一条尤其重要：下面所有"点开更多入口"都是按**收起态那个名字**点的，
         *    名字不跟着状态变、或变了却和视觉不一致，都是这里要红的。
         */
        const toggleState = () =>
          page.evaluate(() => {
            const b = document.querySelector(
              'nav[aria-label="主导航"] button[aria-haspopup="dialog"]',
            )
            const arrow = b?.firstElementChild
            return {
              label: b?.getAttribute('aria-label') ?? '(没找到按钮)',
              expanded: b?.getAttribute('aria-expanded') ?? '(没有 aria-expanded)',
              arrow: arrow ? getComputedStyle(arrow).transform : '(没有箭头)',
            }
          })
        const beforeToggle = await toggleState()
        check(
          beforeToggle.expanded === 'false' &&
            beforeToggle.label === '展开更多入口' &&
            beforeToggle.arrow !== 'none' &&
            beforeToggle.arrow !== '(没有箭头)',
          `${SNM}：收起态时圆按钮是「展开更多入口」+ 箭头有朝向`,
          `aria-label="${beforeToggle.label}" aria-expanded="${beforeToggle.expanded}" transform=${beforeToggle.arrow}`,
        )
        await page.getByRole('button', { name: '展开更多入口' }).click()
        await page.waitForTimeout(400)
        const afterToggle = await toggleState()
        check(
          afterToggle.expanded === 'true' &&
            afterToggle.label === '收起更多入口' &&
            afterToggle.arrow !== beforeToggle.arrow,
          `${SNM}：展开之后同一颗按钮**换成了「收起」的形态**（名字 + 箭头都跟着状态走）`,
          `aria-label="${afterToggle.label}" aria-expanded="${afterToggle.expanded}" transform ${beforeToggle.arrow} → ${afterToggle.arrow}`,
        )
        const panel = await page.evaluate(() => {
          const box = document.querySelector('[data-nav-pop]')
          const morph = document.querySelector('[data-nav-morph]')
          return {
            exists: Boolean(box),
            open: morph?.getAttribute('data-open') === 'true',
            title: (box?.querySelector('h2, .panel-head')?.textContent ?? '').trim(),
            closeX: Boolean(box?.querySelector('button[aria-label="关闭"]')),
            footer: Boolean(box?.querySelector('.sheet-foot-safe')),
            body: (box?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          }
        })
        check(
          panel.exists && panel.open,
          `${SNM}：点圆按钮弹出那块玻璃面板（\`[data-nav-pop]\`、容器 \`data-open="true"\`）`,
          `exists=${panel.exists} data-open=${panel.open}`,
        )
        /* 🔴 用户口径②：面板里**没有标题、没有关闭 X、没有底部「收起」** —— 三样都要实测"不在"。
              ⚠️ 为什么不写成"面板里只有那几行"：那种断言在"多出来一个页脚"时**照样绿**
                 （多出来的东西不在白名单里比），所以必须逐样点名。 */
        check(
          panel.title === '' && !panel.closeX && !panel.footer,
          `${SNM}：面板里**没有标题 / 没有关闭 X / 没有底部「收起」**（口径②：只装那几行入口）`,
          `标题="${panel.title}" · 关闭 X=${panel.closeX} · 页脚「收起」=${panel.footer}`,
        )
        for (const label of ['班级', '考试', '错题集', '日程表']) {
          check(
            panel.body.includes(label),
            `${SNM}：展开层里有「${label}」`,
            short(panel.body, 150),
          )
        }
        check(
          !panel.body.includes('呼叫记录'),
          `${SNM}：展开层里**没有**「呼叫记录」（用户明确说不加）`,
          panel.body.includes('呼叫记录') ? short(panel.body, 150) : '没有这条',
        )

        /* ============================================================
         * 🔴 2026-10-01 **第四轮**：展开层从**圆按钮里长出来**（用户改口径，这一节第三次重写）
         *
         * 这一节的语义**第三次翻转**，三次都是用户拍板：
         *   ① 最早：展开态上抬层叠，圆按钮**浮在** Sheet 之上（钉"仍可见、可点"）；
         *   ② 2026-09-28：用户说「展开后整个导航栏淡出吧」→ 反过来钉
         *      "展开态导航必须 **不可见（opacity 0）且不可点**"；
         *   ③ 2026-10-01（本轮）：用户说「我想把移动端右下角的展开界面改成**从按钮弹出来的**
         *      一个**半透明的液态玻璃界面**，例如这种」→ 形态从**贴底整宽 Sheet** 变成
         *      **锚在圆按钮上方的玻璃块**，而且**导航不淡出、背景不压暗**。
         *      ⇒ 于是 ①②两条的判据**又反回来**：展开态整栏 `opacity` 必须是 `1`、
         *        两个子控件 `pointer-events` 必须是 `auto`（"再点一下 = 收起"要靠它）。
         *
         * 🔴 本轮**新钉的一条**是"从按钮里长出来" —— 动效本身只能靠眼睛，能钉的是**几何**：
         *    面板整体落在圆按钮**上方**、右边缘与按钮**对齐**，且宽高都 > 0。
         *    这条要是没有任何对照，改回"贴底整宽"时它会**静默变绿**（面板还在、只是跑到别处）。
         *
         * 三条纪律与前两轮相同（缺一条断言就变成摆设）：
         *   ① **每个判据都要有反向对照**：三条对照分别把"淡出""压暗遮罩""面板挪到按钮下方"
         *      还原回去，对应的三条断言**必须**红；
         *   ② **点取真中心**（`getBoundingClientRect` 算），不写死坐标；
         *   ③ 对照用**内联 `style.setProperty(…, 'important')`** —— 按元素打，与类名无关
         *      （前一轮实测过：注入 `<style>` 按类名选，改版后选择器**静默失配**，对照永远绿）。
         *
         * ⚠️ 还留了一条"**真的点一下**"（不只是量样式）：在圆按钮中心 `page.mouse.click()`。
         *    本轮它的语义变了 —— 那里现在**就是那颗按钮**（导航不再淡出、面板在旁边），
         *    所以这一下 = **收起面板**；仍然断言 **URL 一动都不动**（"点了导航跳页"是本轮要防的回归）。
         *    ⚠️ 所以它必须放在本节**最后**：点完面板就收起了，后面不能再有面板展开态的断言。
         * ============================================================ */
        const stackProbe = async (c) =>
          await page.evaluate(async ({ c }) => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            /* ⚠️ `[data-nav-pill]` = 那颗胶囊（工作台/作业/我的）。
               以前这里取的是 `nav?.querySelector('div')` —— 那其实是**外面那条居中带**
               （它自己没写 `pointer-events`，从 `<nav>` 继承到 `none`），
               于是"胶囊能不能点"这件事**一直没被真正量到**（实测 2026-10-01 第四轮才暴露）。 */
            const pill = nav?.querySelector('[data-nav-pill]')
            const circle = nav?.querySelector('button[aria-haspopup="dialog"]')
            const morph = nav?.querySelector('[data-nav-morph]')
            const pop = morph?.querySelector('[data-nav-pop]')
            if (!nav || !pill || !circle || !morph || !pop) {
              return {
                c,
                missing:
                  'nav / 胶囊 / 圆按钮 / [data-nav-morph] / [data-nav-pop] 有一样没找到',
              }
            }
            /*
             * 对照场景（每个都对应上面一条断言必须变红）：
             *   · `neg-fade`  —— 把"展开态整栏淡出"那套旧做法原样还原
             *                    （`opacity: 0` + 两个子控件 `pointer-events: none`）
             *                    ⇒ ①② 两条必须红；
             *   · `neg-scrim` —— 往 `body` 里塞一个旧做法里的压暗遮罩 `.scrim`
             *                    ⇒ ④ 那条（"页面上没有 `.scrim`"）必须红；
             *   · `neg-drop`  —— 给面板容器打一条 `translateY(200px)`，把它挪到按钮**下面**
             *                    （旧形态）⇒ ③ 那条几何必须红。
             * ⚠️ `neg-fade` 同时打两处**不是保险起见**：父级 `pointer-events: none`
             *    **挡不住**子级自己写的 `auto`（这正是"看不见却还能点到"的成因）。
             */
            let injected = null
            if (c === 'neg-fade') {
              nav.style.setProperty('opacity', '0', 'important')
              nav.style.setProperty('pointer-events', 'none', 'important')
              nav.style.setProperty('transition', 'none', 'important')
              pill.style.setProperty('pointer-events', 'none', 'important')
              circle.style.setProperty('pointer-events', 'none', 'important')
            }
            if (c === 'neg-scrim') {
              injected = document.createElement('div')
              injected.className = 'scrim'
              document.body.appendChild(injected)
            }
            if (c === 'neg-drop') {
              morph.style.setProperty('transform', 'translateY(200px)', 'important')
            }
            const rectOf = (el) => {
              const r = el.getBoundingClientRect()
              return {
                raw: r,
                left: Math.round(r.left),
                top: Math.round(r.top),
                right: Math.round(r.right),
                bottom: Math.round(r.bottom),
                width: Math.round(r.width),
                height: Math.round(r.height),
                z: getComputedStyle(el).zIndex,
                pe: getComputedStyle(el).pointerEvents,
              }
            }
            const circleRect = rectOf(circle)
            const popRect = rectOf(pop)
            const pillRect = rectOf(pill)
            /*
             * ⚠️ 这一整段都必须在 `undo()` **之前**读：它们就是"对照到底改上没有"的证据，
             *    放在还原之后读永远是常态值（看着像"对照没生效"）。
             */
            const out = {
              case: c,
              morphOpen: morph.getAttribute('data-open'),
              circle: {
                pe: getComputedStyle(circle).pointerEvents,
                rect: {
                  left: circleRect.left,
                  top: circleRect.top,
                  right: circleRect.right,
                  bottom: circleRect.bottom,
                  width: circleRect.width,
                  height: circleRect.height,
                  z: circleRect.z,
                },
                center: [Math.round(circleRect.raw.left + circleRect.raw.width / 2), Math.round(circleRect.raw.top + circleRect.raw.height / 2)],
              },
              pill: { pe: getComputedStyle(pill).pointerEvents, width: pillRect.width },
              pop: {
                rect: {
                  left: popRect.left,
                  top: popRect.top,
                  right: popRect.right,
                  bottom: popRect.bottom,
                  width: popRect.width,
                  height: popRect.height,
                  z: popRect.z,
                  pe: popRect.pe,
                },
                visibility: getComputedStyle(pop).visibility,
                opacity: getComputedStyle(pop).opacity,
                /* 右边缘对齐的偏差：0 = 完全对齐（圆按钮在带子的最右一格） */
                rightGap: popRect.right - circleRect.right,
                /* 面板下沿到按钮上沿的距离：> 0 = 面板整个在按钮**上方** */
                above: circleRect.top - popRect.bottom,
              },
              nav: {
                opacity: getComputedStyle(nav).opacity,
                pointerEvents: getComputedStyle(nav).pointerEvents,
                z: getComputedStyle(nav).zIndex,
                top: Math.round(nav.getBoundingClientRect().top),
                height: Math.round(nav.getBoundingClientRect().height),
              },
              /* ④ 那条要钉的：页面上**没有**压暗遮罩（旧做法是 `.scrim` 压暗 + 模糊） */
              scrim: Boolean(document.querySelector('.scrim')),
            }
            /* 对照改完样式到"计算值真的变了"之间隔一次样式重算：等两帧再收尾（口径照前两轮） */
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
            if (injected) injected.remove()
            if (c === 'neg-fade') {
              nav.style.removeProperty('opacity')
              nav.style.removeProperty('pointer-events')
              nav.style.removeProperty('transition')
              pill.style.removeProperty('pointer-events')
              circle.style.removeProperty('pointer-events')
            }
            if (c === 'neg-drop') morph.style.removeProperty('transform')
            return out
          }, { c })

        /* 三次取数，各处只取一次：`real` = 真状态，另两个 = 对照 */
        const real = await stackProbe('real')
        const negFade = await stackProbe('neg-fade')
        const negScrim = await stackProbe('neg-scrim')
        const negDrop = await stackProbe('neg-drop')
        for (const [c, r] of [
          ['real', real],
          ['neg-fade', negFade],
          ['neg-scrim', negScrim],
          ['neg-drop', negDrop],
        ]) {
          if (r?.missing) throw new Error(`${SNM}：层叠探针（${c}）取数失败 —— ${r.missing}`)
        }

        /* ① 整栏照旧看得见（`opacity` 是"看不见"这件事的可量证据，本轮反过来钉 1） */
        check(
          real.nav?.opacity === '1',
          `${SNM}：展开态**整栏照旧可见**（\`<nav>\` 的计算 opacity 是 1，不再淡出）`,
          `opacity=${real.nav?.opacity} · nav z=${real.nav?.z} · nav top=${real.nav?.top}`,
        )
        /* ② **而且照旧点得到** —— 两个子控件各自的 `pointer-events` 都是 auto。
              ⚠️ 这条是"展开态再点一下圆按钮 = 收起"的前提；也是与第②轮口径相反的判据。 */
        check(
          real.circle?.pe === 'auto' && real.pill?.pe === 'auto',
          `${SNM}：展开态**两个子控件照旧可点**（圆按钮 / 胶囊的 pointer-events 都是 auto）`,
          `圆按钮 pointer-events=${real.circle?.pe} · 胶囊 pointer-events=${real.pill?.pe} · nav pointer-events=${real.nav?.pointerEvents}`,
          '⚠️ 父级设 none 是**挡不住**子级自己写的 auto 的 —— 所以这两处必须分别量',
        )
        /* ③ 🔴 本轮新钉：**面板是从圆按钮里长出来的**（整体在按钮上方、右边缘对齐、宽高都 > 0）。
              ⚠️ 这一条是"从按钮弹出来"这件事唯一可量的部分（动效本身只能靠眼睛）。 */
        check(
          real.pop &&
            real.pop.above > 0 &&
            Math.abs(real.pop.rightGap) <= 2 &&
            real.pop.rect.width > 0 &&
            real.pop.rect.height > 0,
          `${SNM}：面板**从圆按钮上方长出来**（整体在按钮之上、右边缘与按钮对齐）`,
          `面板=${JSON.stringify(real.pop?.rect)} · 圆按钮=${JSON.stringify(real.circle?.rect)} · 面板下沿距按钮上沿 ${real.pop?.above}px · 右边缘偏差 ${real.pop?.rightGap}px`,
        )
        /* ④ 背景**不压暗**：页面上不存在 `.scrim`（旧做法是遮罩压暗 + 模糊，用户口径①不要） */
        check(
          real.scrim === false,
          `${SNM}：展开时**没有压暗遮罩**（页面上不存在 \`.scrim\`）`,
          `scrim=${real.scrim}`,
          '旧做法那一层是 `ui.tsx` 的 Sheet 自带的；本轮的面板不是 Sheet，所以它不该出现',
        )
        /* ⑤ 🔴 **三条反向对照**（对应上面 ①②③，缺一条都会变成摆设） */
        check(
          negFade.nav?.opacity === '0' &&
            negFade.circle?.pe === 'none' &&
            negFade.pill?.pe === 'none',
          `${SNM}：🧪 反向对照 —— 把"整栏淡出"那套旧做法还原回去，①②两条**必须**红`,
          `还原成 opacity=${negFade.nav?.opacity} 之后：圆按钮 pointer-events=${negFade.circle?.pe}、胶囊=${negFade.pill?.pe}`,
          '⚠️ 对照必须连 `transition:none` 一起写：只改 opacity 的话过渡还在跑，量到的是中间值（实测 opacity=0.23）',
        )
        check(
          negScrim.scrim === true,
          `${SNM}：🧪 反向对照 —— 塞一个压暗遮罩进页面，④那条**必须**红`,
          `塞进去之后 scrim=${negScrim.scrim}`,
          '不塞的话"页面上没有 .scrim"可能是**恒真**（页面里根本没有这个类）——那就等于没测',
        )
        check(
          negDrop.pop && negDrop.pop.above <= 0,
          `${SNM}：🧪 反向对照 —— 把面板挪到按钮**下方**（旧形态），③那条几何**必须**红`,
          `挪下去之后：面板下沿距按钮上沿 ${negDrop.pop?.above}px（面板 bottom=${negDrop.pop?.rect.bottom}、按钮 top=${negDrop.circle?.rect.top}）`,
        )

        // 展开层里点一条 → 真的跳过去（收起的三条路径之一：点条目先收起再 navigate）
        await page
          .locator('[data-nav-pop] button')
          .filter({ hasText: '日程表' })
          .first()
          .click()
        await page.waitForURL('**/schedule', { timeout: 8000 })
        await page.waitForTimeout(400)
        const after = await pageInfo(page)
        const afterOpen = await page.evaluate(
          () => document.querySelector('[data-nav-morph]')?.getAttribute('data-open'),
        )
        check(
          after.url === '/schedule' && afterOpen === 'false',
          `${SNM}：点「日程表」跳过去且展开层收起`,
          `url=${after.url} data-open=${afterOpen}`,
        )
        /* 收回导航（上一步跳页时已经自动收起，这里显式再点一次展开，给下面的"真点一下"用） */
        await ensureFront()
        await page.locator('nav[aria-label="主导航"] button[aria-haspopup="dialog"]').click({
          force: true,
        })
        /* 🔴 等**条件**（面板真的开了），不是等固定毫秒 —— 理由见上面 `ensureFront` 那段 */
        await pollUntil(
          () =>
            page.evaluate(() => {
              const morph = document.querySelector('[data-nav-morph]')
              const pop = document.querySelector('[data-nav-pop]')
              return {
                open: morph?.getAttribute('data-open'),
                height: pop ? Math.round(pop.getBoundingClientRect().height) : -1,
              }
            }),
          (r) => r.open === 'true' && r.height > 0,
        )
        await page.waitForTimeout(80)
        const reopened = await stackProbe('real')
        check(
          reopened.morphOpen === 'true' && reopened.pop?.rect.height > 0,
          `${SNM}：再展开一次，面板又长出来了（下面那条"真点一下"要在展开态量）`,
          `data-open=${reopened.morphOpen} · 面板高=${reopened.pop?.rect.height} · 圆按钮中心=${JSON.stringify(reopened.circle?.center)}`,
        )
        /* ⚠️ 圆按钮的坐标要在**等停稳之后**重取：`stackProbe` 只给形状，
           坐标交给 Playwright（它自己会等元素稳定），别拿旧坐标去点。 */
        const circleBox = await page
          .locator('nav[aria-label="主导航"] button[aria-haspopup="dialog"]')
          .boundingBox()
        if (!circleBox) throw new Error(`${SNM}：量不到圆按钮的位置`)
        const clickAt = [circleBox.x + circleBox.width / 2, circleBox.y + circleBox.height / 2]
        /* ⑥ 🔴 **真点一下**：在圆按钮中心点一次 —— 那里现在**就是那颗按钮**（导航不再淡出、
              面板在它上方），所以这一下命中的是按钮自己 = **收起面板**；
              并且 **URL 绝不许动**（"点了导航跳页"是要防的回归）。
              ⚠️ 这一条必须放在**最后**：点完面板就收起了，后面不能再有展开态的断言。 */
        const urlBeforeClick = page.url()
        await page.mouse.click(clickAt[0], clickAt[1])
        await page.waitForTimeout(320)
        const clicked = await page.evaluate(() => {
          const morph = document.querySelector('[data-nav-morph]')
          const pop = document.querySelector('[data-nav-pop]')
          return {
            open: morph?.getAttribute('data-open'),
            visibility: pop ? getComputedStyle(pop).visibility : 'missing',
          }
        })
        check(
          page.url() === urlBeforeClick && clicked.open === 'false',
          `${SNM}：**在圆按钮中心真点一下 → 面板收起、URL 一动都不动**`,
          `点之前 url=${urlBeforeClick} · 点之后 url=${page.url()} · data-open=${clicked.open} · 面板 visibility=${clicked.visibility}`,
          '这一下命中的就是那颗按钮本身（"展开态再点一下收起"那条路径），不是浮层上的别的东西',
        )
      })

      /* ============================================================
         ===== 液态玻璃 · 果冻指示器 · 触控尺寸（2026-10-01 第三轮） =====
         ------------------------------------------------------------
         这一节钉四件事（每一件都带反向对照，见 `AGENTS.md` 三·2）：

           ① **触控目标不许缩**：老师是手指点的，改圆角 / 间距 / 材质都不许把入口改小
              （反向对照：把那几格**真的**缩到 40px → 上面那条必须红）；
           ② **降级路径存在**：折射关掉之后仍然"只有模糊 + 描边"（不是变透明），
              并且折射开着时真的接到了 SVG 滤镜上（不是只写了个属性）；
           ③ **静态扫源码**：特性检测（`CSS.supports` 两条）/ 低端机判据 / 掉帧看门狗 /
              `prefers-reduced-motion` 分支都在，且 **CSS 里的 `url(#…)` 与 TSX 里的 id 同字**
              （不一致 = 指针指空 = 静默不生效，这一条正是属于"不报错但就是不对"那一类）；
              反向对照：把源码里那几个分支改掉，同一个扫描函数**必须**判假；
           ④ **果冻与 reduced-motion**：正常动效下拖尾圆真的滞后（弹簧在跑）；
              `prefers-reduced-motion: reduce` 时**直接跳过去**（无果冻、无过渡、无拖尾节点），
              反向对照：回到 `no-preference`，同一次点击在 50ms 时**还没落位**（证明"落位了"不是恒真）。
         ============================================================ */

      /* ⚠️ 整节包在一个**块作用域**里：外层第 17–25 节已经用过 `SG` 这个名字，
            这里要的是"只在本节里有效"，不跟别人抢名字（也就不用去动别人的代码）。 */
      {
      const SG = '35–37 移动端底部导航 · 液态玻璃'

      /** 三个入口 + 圆按钮的**真实**命中尺寸（不是源码里的常数） */
      const hitBoxes = () =>
        page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航"]')
          const box = (el) => {
            const r = el.getBoundingClientRect()
            return { w: Math.round(r.width), h: Math.round(r.height) }
          }
          const circle = nav?.querySelector('button[aria-haspopup="dialog"]')
          return {
            tabs: [...(nav?.querySelectorAll('a[aria-label]') ?? [])].map((a) => ({
              name: a.getAttribute('aria-label'),
              ...box(a),
            })),
            circle: circle ? box(circle) : null,
          }
        })

      /** 玻璃那一族当前的计算值（折射是否接上、兜底的模糊与描边还在不在、果冻开没开） */
      const glassState = () =>
        page.evaluate(() => {
          const pill = document.querySelector('nav[aria-label="主导航"] .glass-light')
          const cs = pill ? getComputedStyle(pill) : null
          const jelly = document.querySelector('[data-jelly]')
          const body = document.querySelector('nav[aria-label="主导航"] [data-jelly] span')
          return {
            attr: pill?.getAttribute('data-refract') ?? null,
            backdrop: cs?.backdropFilter ?? '',
            shadow: cs?.boxShadow ?? '',
            radius: cs?.borderTopLeftRadius ?? '',
            refractNode: Boolean(document.getElementById('shugao-liquid-refract')),
            gooNode: Boolean(document.getElementById('shugao-nav-goo')),
            jelly: jelly?.getAttribute('data-jelly') ?? null,
            /* 拖尾圆：只在 `jelly='on'` 时才该存在（它是第二个 span） */
            tails: document.querySelectorAll('nav[aria-label="主导航"] [data-jelly] span').length,
            bodyLeft: body ? Math.round(parseFloat(getComputedStyle(body).left)) : null,
            tailShift: (() => {
              const t = document.querySelectorAll('nav[aria-label="主导航"] [data-jelly] span')[1]
              if (!t) return null
              /* ⚠️ `getComputedStyle().transform` 给的是 `matrix(...)`，不是 `translateX(...)`
                    —— 直接按字面找 `translateX(` 会**永远匹配不到**（那正是"恒真的摆设"） */
              const raw = getComputedStyle(t).transform
              if (!raw || raw === 'none') return 0
              return Math.round(new DOMMatrix(raw).m41 * 100) / 100
            })(),
          }
        })

      await step(SG, async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(900)

        /* ---- ① 触控目标 ---- */
        const t1 = await hitBoxes()
        check(
          t1.tabs.length >= 3 &&
            t1.tabs.every((t) => t.w >= 44 && t.h >= 44) &&
            Boolean(t1.circle) &&
            t1.circle.w >= 44 &&
            t1.circle.h >= 44,
          `${SG}：每个入口的触控目标都 ≥ 44×44（手指点的东西，改圆角/间距不许把它改小）`,
          `胶囊 ${t1.tabs.map((t) => `${t.name} ${t.w}×${t.h}`).join(' · ')} · 圆按钮 ${t1.circle?.w}×${t1.circle?.h}`,
        )
        /* 反向对照：临时插一条 `!important` 规则把那几格**真的**缩到 40px。
           🔴 **必须用 `<style>` 元素、改完整条删掉**：直接对元素 `setProperty` 再
              `removeProperty` 会把 React 管的行内 `width/height` 一起删掉 ——
              那一格会缩成"图标那么宽"（22px），**后面整节都在坏布局上跑**（实测踩过：
              拖尾全程量到 0、`hi.width` 变成 22）。
           ⚠️ 选择器用语义锚点（`nav[aria-label]` + `a[aria-label]`），并且下面的断言会**验证对照生效**
              （量到 < 44 才算数）—— 万一选择器失配，那条断言会红，不会静默放水。 */
        const shrinkId = '__tmp-touch-shrink'
        await page.evaluate((id) => {
          const s = document.createElement('style')
          s.id = id
          s.textContent =
            'nav[aria-label="主导航"] a[aria-label]{width:40px!important;height:40px!important}'
          document.head.appendChild(s)
        }, shrinkId)
        await page.waitForTimeout(80)
        const t2 = await hitBoxes()
        check(
          t2.tabs.length > 0 && t2.tabs.every((t) => t.w < 44 || t.h < 44),
          `${SG}：🧪 反向对照 —— 把那几格缩到 40px 之后，上面那条**必须**红（探针量的是真尺寸）`,
          `缩完实测：${t2.tabs.map((t) => `${t.name} ${t.w}×${t.h}`).join(' · ')}`,
        )
        await page.evaluate((id) => document.getElementById(id)?.remove(), shrinkId)
        await page.waitForTimeout(80)

        /* ---- ② 降级路径：关掉折射之后仍然"只有模糊 + 描边" ---- */
        const gOn = await glassState()
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('.glass-light')) {
            el.setAttribute('data-refract', 'off')
          }
        })
        await page.waitForTimeout(60)
        const gOff = await glassState()
        await page.evaluate((v) => {
          for (const el of document.querySelectorAll('.glass-light')) {
            if (v) el.setAttribute('data-refract', v)
          }
        }, gOn.attr)
        await page.waitForTimeout(60)

        check(
          gOff.backdrop.includes('blur(') && gOff.shadow.includes('inset'),
          `${SG}：折射**关掉**之后玻璃仍然有"模糊 + 内描边"（降级不是变透明、也不是掉材质）`,
          `off → backdrop-filter=${gOff.backdrop} · box-shadow 含 inset=${gOff.shadow.includes('inset')}`,
          `本机默认：data-refract=${gOn.attr} → ${gOn.backdrop}`,
        )
        check(
          gOn.attr === 'off' || gOn.backdrop.includes('url('),
          `${SG}：折射开着时**真的**接到了 SVG 滤镜上（不是只写了个属性就算）`,
          `data-refract=${gOn.attr} → backdrop-filter=${gOn.backdrop} · 滤镜节点=${gOn.refractNode}`,
        )
        check(
          (gOn.attr === 'on') === gOn.refractNode,
          `${SG}：滤镜节点与开关**同进退**（关掉时连 DOM 都不留，免得 url 指空）`,
          `data-refract=${gOn.attr} · #shugao-liquid-refract 在 DOM 里=${gOn.refractNode}`,
        )
        check(
          (gOn.jelly === 'on') === gOn.gooNode && (gOn.jelly === 'on') === (gOn.tails === 2),
          `${SG}：果冻开关、gooey 节点、拖尾圆**三者一致**（关掉时不留孤儿节点）`,
          `data-jelly=${gOn.jelly} · #shugao-nav-goo=${gOn.gooNode} · [data-jelly] 里的 span 数=${gOn.tails}`,
        )
        check(
          gOn.radius === '18px',
          `${SG}：大圆角 18 = \`--radius-liquid\`（本项目**唯一的大圆角**，理由写在令牌那一行）`,
          `胶囊圆角=${gOn.radius}`,
        )

        /* ---- ②' **展开态那张面板**：同一块玻璃（大圆角 + 模糊 + 折射 + **读得清的兜底白底**） ----
         * 🔴 那条"白底不透明度"是**可读性的机器版**：面板上有 12px 的说明小字，
         *    底下可能是课表 / 名单 / 深色内容 —— 兜底白底太透就会读不清（用户第一条硬约束）。
         *    数值口径见 `index.css` 里 `.nav-pop`（与 `.nav-morph[data-open='true'] .nav-pop`）那段算式。
         * ⚠️ 2026-10-01 第四轮：展开层从 `.sheet` 换成 `[data-nav-pop]`（从圆按钮里长出来的玻璃块），
         *    同时按用户口径③ 把白底从 **0.88 降到 0.6 一带**（说明小字 11.5 → 12px 补回可读性）
         *    ⇒ 上面那条从"≥0.6"升级成 **0.6 ~ 0.72 这个带**：太透（读不清）和偷偷加厚回 0.88
         *      （"更透"这件事没做）**两种都要红**。 */
        await page.getByRole('button', { name: '展开更多入口' }).click()
        await page.waitForTimeout(600)
        const panel = await page.evaluate(() => {
          const sh = document.querySelector('[data-nav-pop]')
          if (!sh) return null
          const cs = getComputedStyle(sh)
          const img = cs.backgroundImage
          const alphas = [...img.matchAll(/rgba?\([^)]*?([\d.]+)\)/g)].map((m) => Number(m[1]))
          return {
            radius: cs.borderTopLeftRadius,
            backdrop: cs.backdropFilter,
            minAlpha: alphas.length ? Math.min(...alphas) : null,
            maxAlpha: alphas.length ? Math.max(...alphas) : null,
            marker: sh.hasAttribute('data-nav-glass'),
            /* 面板里**最小那一档字号** = 那行说明小字（口径③：11.5 → 12px；别的地方都比它大） */
            hintPx: Math.min(
              ...[...sh.querySelectorAll('span')]
                .map((el) => parseFloat(getComputedStyle(el).fontSize))
                .filter((n) => n > 0),
            ),
          }
        })
        check(
          panel?.marker === true &&
            panel.radius === '18px' &&
            panel.backdrop.includes('blur(') &&
            panel.backdrop.includes('url('),
          `${SG}：**展开态那张面板**也是同一块玻璃（大圆角 18 + 模糊 + 折射接上了）`,
          panel
            ? `圆角=${panel.radius} · backdrop-filter=${panel.backdrop} · 标记=${panel.marker}`
            : '没找到 [data-nav-pop]',
        )
        check(
          panel !== null &&
            panel.minAlpha !== null &&
            panel.minAlpha >= 0.6 &&
            panel.minAlpha <= 0.72 &&
            panel.hintPx >= 12,
          `${SG}：🔴 面板的**兜底白底在 0.6 ~ 0.72 这个带**、**说明小字 ≥ 12px**（口径③的"更透"这一对）`,
          panel
            ? `白底 ${panel.minAlpha} ~ ${panel.maxAlpha}（${panel.minAlpha >= 0.6 && panel.minAlpha <= 0.72 ? '过' : panel.minAlpha < 0.6 ? '太透' : '没做透'}）· 最小字号=${panel.hintPx}px`
            : '没找到 [data-nav-pop]',
          '背景可能是课表 / 名单 / 深色内容：可读性优先于好看 —— 透下去的那点余量要用字号换回来',
        )
        await page.keyboard.press('Escape')
        await page.waitForTimeout(400)

        /* ---- ③ 静态扫源码 + 反向对照 ---- */
        const appSrc = readFileSync(join(HERE, '..', 'src', 'components', 'AppShell.tsx'), 'utf8')
        const cssSrc = readFileSync(join(HERE, '..', 'src', 'index.css'), 'utf8')
        /** 两条实时滤镜的"该在的分支"是否都在；同一函数要能在被改坏的副本上判假 */
        const scanFx = (app, css) => {
          const refractId = /REFRACT_ID = '([\w-]+)'/.exec(app)?.[1] ?? null
          const gooId = /GOO_ID = '([\w-]+)'/.exec(app)?.[1] ?? null
          const cssUrls = [...css.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1])
          /*
           * ⚠️ 兜底顺序**不能拿两个 `indexOf` 在整份文件里比大小**：
           *    注释里也会提到 `url(#…)`，一比就错位（第一版就是这么写的，实测判假）。
           *    要取的是**规则体**：基础声明那条 `.glass-light { … }` 与增强那条
           *    `[data-refract='on'] { … }`，前者的顺序必须在后者之前、且前者**不含** url()。
           */
          const baseAt = css.indexOf('.glass-light {')
          const baseRule = baseAt < 0 ? '' : css.slice(baseAt, css.indexOf('}', baseAt))
          const enhAt = css.indexOf("[data-refract='on'] {")
          const enhRule = enhAt < 0 ? '' : css.slice(enhAt, css.indexOf('}', enhAt))
          return {
            detect:
              /CSS\.supports\(\s*'backdrop-filter'/.test(app) && /CSS\.supports\(\s*'filter'/.test(app),
            lowEnd: /hardwareConcurrency/.test(app) && /deviceMemory/.test(app),
            watchdog: /FRAME_BUDGET_MS/.test(app) && /requestAnimationFrame/.test(app),
            reduced: /prefers-reduced-motion: reduce/.test(app),
            /* CSS 里引用的 id 必须是 TSX 里那一个（写错 = 指空 = 静默没效果） */
            ids: Boolean(refractId && gooId && cssUrls.includes(refractId)),
            /* 基础声明（模糊 + 描边）在增强声明**之前**，且基础那条**不带** url() */
            fallbackFirst:
              baseAt > -1 &&
              enhAt > baseAt &&
              /backdrop-filter: blur\(/.test(baseRule) &&
              !baseRule.includes('url(') &&
              Boolean(refractId) &&
              enhRule.includes(`url(#${refractId})`) &&
              /blur\(/.test(enhRule),
          }
        }
        const s = scanFx(appSrc, cssSrc)
        check(
          s.detect && s.lowEnd && s.watchdog && s.reduced && s.ids && s.fallbackFirst,
          `${SG}：降级路径**在源码里真的存在**（特性检测 / 低端机 / 掉帧看门狗 / reduced-motion / id 同字 / 兜底在前）`,
          JSON.stringify(s),
          '这一整段是静态扫源码：两处 `CSS.supports`、`hardwareConcurrency`+`deviceMemory`、`FRAME_BUDGET_MS`+rAF、reduced-motion 分支、CSS↔TSX 的 id、基础声明在增强之前',
        )
        /* 反向对照：把源码"改坏"再扫一遍 —— 同一个函数**必须**判假（否则它就是恒真的摆设） */
        const broken = scanFx(
          appSrc
            .replace(/CSS\.supports/g, 'neverSupported')
            .replace(/hardwareConcurrency/g, 'x')
            .replace(/FRAME_BUDGET_MS/g, 'x'),
          cssSrc.replace(/url\(#[\w-]+\)/g, 'url(none)'),
        )
        check(
          !broken.detect && !broken.lowEnd && !broken.watchdog && !broken.ids,
          `${SG}：🧪 反向对照 —— 把检测分支/低端判据/看门狗/url 指针改坏，上面那条**必须**红`,
          JSON.stringify(broken),
          '对照是"同一函数 + 改坏的源码"，所以它不会因为选择器/类名改版而静默失配',
        )

        /* ---- ④ 果冻：拖尾圆真的滞后 + 高光边不参与 goo ---- */
        /*
         * ⚠️ 拖尾的滞后是**一帧一帧的**：`hi.left` 要等测量 effect 跑完（点完大约 1–3 帧）才开始动，
         *    在固定时刻抓一张很可能抓到"还没开始"（第一版就是 110ms 抓一张，实测恒为 0 —— 假绿）。
         *    所以改成**在点击之前就先开一个逐帧轮询**，把整段飞行里的最大滞后量记下来。
         */
        const pollMaxLag = () =>
          page.evaluate(async () => {
            let max = 0
            for (let i = 0; i < 45; i++) {
              await new Promise((r) => requestAnimationFrame(r))
              const t = document.querySelectorAll('nav[aria-label="主导航"] [data-jelly] span')[1]
              if (!t) continue
              const raw = getComputedStyle(t).transform
              if (!raw || raw === 'none') continue
              max = Math.max(max, Math.abs(new DOMMatrix(raw).m41))
            }
            return { max: Math.round(max * 10) / 10 }
          })
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.waitForTimeout(200)
        const settled = await glassState()
        /*
         * ⚠️ **用 `mouse.click(坐标)`，不用 `locator.click()`**：后者的"可操作性检查"会等元素
         *    **连续两帧位置不变**才点下去 —— 而这里恰恰要在"动画还在跑"的时刻取数，
         *    等它稳下来再点，整段飞行都过去了（第一版就是这么写的：逐帧量到 0 —— 假绿）。
         */
        const tabBox = await page.getByRole('link', { name: '作业' }).boundingBox()
        if (!tabBox) throw new Error(`${SG}：量不到「作业」那一格的位置`)
        const polling = pollMaxLag()
        await page.mouse.click(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)
        const lagProbe = await polling
        const maxLag = lagProbe.max
        await page.waitForTimeout(900)
        const landed = await glassState()
        if (settled.jelly === 'on') {
          check(
            maxLag > 1,
            `${SG}：果冻**真的在拖**（整段飞行里拖尾圆与本体拉开了距离 —— 弹簧在跑）`,
            `逐帧量到的最大滞后 = ${maxLag}px · 静止时 shift=${settled.tailShift} → 落位 shift=${landed.tailShift}`,
            '若这里恒为 0：说明弹簧没跑 / 尾巴的 left 也做了过渡（两者同步 = 果冻消失）',
          )
        } else {
          check(
            maxLag === 0 && settled.tails === 1,
            `${SG}：果冻关掉时**没有拖尾圆**（低端 / 不支持 / reduced-motion 都不硬上）`,
            `data-jelly=${settled.jelly} · 拖尾节点数=${settled.tails} · 最大滞后=${maxLag}px`,
          )
        }
        check(
          landed.tailShift === 0 || landed.tailShift === null,
          `${SG}：落位之后拖尾圆收回去（不会永远拖着一个尾巴）`,
          `落位 shift=${landed.tailShift}`,
        )
        /* 高光边（淡蓝描边）**不在** goo 层里：进了滤镜就会被 alpha 阈值切成实心蓝 */
        const ringOutside = await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航"]')
          const layer = nav.querySelector('[data-jelly]')
          const ring = nav.querySelector('[data-hi-ring]')
          return {
            found: Boolean(ring),
            inLayer: ring ? Boolean(layer?.contains(ring)) : null,
            border: ring ? getComputedStyle(ring).borderTopColor : null,
            filter: layer ? getComputedStyle(layer).filter : null,
          }
        })
        check(
          ringOutside.found && ringOutside.inLayer === false && /rgba\(/.test(String(ringOutside.border)),
          `${SG}：高光边 / 淡蓝描边留在 goo 层**外面**（进滤镜会被 alpha 阈值切成实心蓝）`,
          `在 goo 层里=${ringOutside.inLayer} · 描边色=${ringOutside.border} · goo 层 filter=${ringOutside.filter}`,
        )

        /* ---- ⑤ 可读性：指示器**不是唯一信号** ---- */
        const sig = () =>
          page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            return [...nav.querySelectorAll('a[aria-label]')].map((a) => {
              const cell = a.querySelector('[data-active]')
              return {
                name: a.getAttribute('aria-label'),
                active: cell?.getAttribute('data-active') === 'true',
                color: getComputedStyle(cell ?? a).color,
              }
            })
          })
        /*
         * 🔴 2026-10-11：这里原来只 `waitForTimeout(400)` —— 那**不够**。
         * `.glass-light` 那一格的颜色是 `transition: color .22s`（`AppShell.tsx`），
         * 而**页面在后台时过渡时钟不走**（同 `ensureFront` 那段实测）：类/属性都已经对了、
         * computed 颜色却还停在上一次路由的值（实测 `作业(当前)` 读成未选中的灰）。
         * → 改成"等颜色真的对上"，超时照样断言（读数里带 `timeout`）。
         */
        await ensureFront()
        const sigStable = await pollUntil(
          sig,
          (rows) => {
            const act = rows.find((c) => c.active)
            return Boolean(act) && rows.filter((c) => !c.active).every((c) => c.color !== act.color)
          },
        )
        const sig1 = sigStable
        const activeColor = sig1.find((c) => c.active)?.color ?? null
        check(
          Boolean(activeColor) && sig1.filter((c) => !c.active).every((c) => c.color !== activeColor),
          `${SG}：当前页的图标颜色与其余**明显不同**（色盲 / 强光下也不能只靠那块指示器）`,
          `${sig1.map((c) => `${c.name}${c.active ? '(当前)' : ''} ${c.color}`).join(' · ')}${sig1.timeout ? ' · ⏳等颜色等到超时' : ''}`,
        )
        /*
         * 反向对照：把未选中项的文字刷成同一个颜色 → 上面那条的颜色判据必须红。
         * ⚠️ 做法是"**先快照整条 `style` 属性、改完原样写回**"：
         *    · 直接 `setProperty` 再 `removeProperty` 会把 React 管的行内 `color` **一起删掉**
         *      （后面整节都是错色）；
         *    · 只靠插一条 `<style>` 去覆盖，实测**不稳**（有一次没生效 —— 那种"对照不生效"
         *      会让断言假绿，最难查）。
         */
        const colorBackup = await page.evaluate((c) => {
          const cells = [
            ...document.querySelectorAll('nav[aria-label="主导航"] a[aria-label] [data-active]'),
          ]
          const before = cells.map((el) => el.getAttribute('style'))
          for (const el of cells) {
            if (el.getAttribute('data-active') !== 'true') el.style.setProperty('color', c, 'important')
          }
          return before
        }, activeColor)
        /* ⚠️ 图标颜色上有 `.22s` 的过渡：不等它落定就量，量到的是中间值（第一版实测就是这样） */
        await page.waitForTimeout(500)
        const sig2 = await sig()
        check(
          new Set(sig2.map((c) => c.color)).size === 1,
          `${SG}：🧪 反向对照 —— 把未选中项的图标刷成同一个颜色，上面那条**必须**红`,
          sig2.map((c) => `${c.name} ${c.color}`).join(' · '),
        )
        await page.evaluate((before) => {
          const cells = [
            ...document.querySelectorAll('nav[aria-label="主导航"] a[aria-label] [data-active]'),
          ]
          cells.forEach((el, i) => {
            if (before[i] == null) el.removeAttribute('style')
            else el.setAttribute('style', before[i])
          })
        }, colorBackup)
        await page.waitForTimeout(400)

        /* ---- ⑥ `prefers-reduced-motion: reduce`：直接跳过去、无果冻 ----
         *
         * ⚠️ **不拿"50ms 之后到没到位"当判据**：`hi.left` 要等测量 effect 跑完才更新，
         *    那个时刻本身就有一两帧的抖动，写死时间点会变成**时红时绿的假断言**。
         *    这里量的是**结构**：① 果冻开关与拖尾节点；② 指示器那两个图层的
         *    `transition-property` —— reduced 时只剩 `opacity`（= 位置直接跳），
         *    正常时必须是 `left`（= 真的在滑）。两条都逐帧可复现，不依赖时间点。
         */
        const motionState = () =>
          page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            const body = nav.querySelector('[data-jelly] span')
            const ring = nav.querySelector('[data-hi-ring]')
            return {
              jelly: nav.querySelector('[data-jelly]')?.getAttribute('data-jelly') ?? null,
              tails: nav.querySelectorAll('[data-jelly] span').length,
              bodyTrans: body ? getComputedStyle(body).transitionProperty : null,
              ringTrans: ring ? getComputedStyle(ring).transitionProperty : null,
            }
          })
        const probeMotion = async (reducedMotion) => {
          await page.emulateMedia({ reducedMotion })
          await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
          await page.waitForTimeout(700)
          return await motionState()
        }
        const rm = await probeMotion('reduce')
        check(
          rm.jelly === 'off' &&
            rm.tails === 1 &&
            rm.bodyTrans === 'opacity' &&
            rm.ringTrans === 'opacity',
          `${SG}：🔴 \`prefers-reduced-motion: reduce\` → **直接跳过去**（无果冻 / 无拖尾 / 位置不带过渡）`,
          `data-jelly=${rm.jelly} · 拖尾数=${rm.tails} · 填充层 transition=${rm.bodyTrans} · 高光边层=${rm.ringTrans}`,
          '有人对动效敏感：这时不许有弹簧、不许有滑动过渡 —— 指示器一步到位，只留透明度那一下',
        )
        const nm = await probeMotion('no-preference')
        check(
          nm.jelly === 'on' &&
            nm.tails === 2 &&
            String(nm.bodyTrans).includes('left') &&
            String(nm.ringTrans).includes('left'),
          `${SG}：🧪 反向对照 —— 正常动效下果冻是开的、位置是**带过渡**的（上面那条不是恒真）`,
          `data-jelly=${nm.jelly} · 拖尾数=${nm.tails} · 填充层 transition=${nm.bodyTrans} · 高光边层=${nm.ringTrans}`,
        )
        /* ============================================================
           ---- ⑦ 🔴 2026-10-09 F5-1：那圈"蓝框"（切换时白块永远在框内）----
           ------------------------------------------------------------
           用户原话：「仔细看，这个白色的按钮旁边是有**蓝色的框**的…在切换的时候因为它很**Q弹**，
           晃的时候**就像超出了界限**一样」。那圈框 = 高光边那一层 `[data-hi-ring]`
           （判据与来龙去脉写在 `AppShell.tsx` 的「蓝框到底是什么」那一段）。
           这一条量的是**修完之后的几何关系**：切换的整段飞行里，
           "白块"（= goo 层里的填充 + 拖尾圆，两者一起被糊成一坨）**任何一帧都不许露到框外**。
           反向对照：把框按**修复前的口径**钉死在"终点那一格"上（那时它只包住终点格），
           同一段采样**必须**红 —— 见下面第二条 check。
           ============================================================ */
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await ensureFront()
        /* 🔴 等"高亮真的回到当前那一格"再开始逐帧采样 —— 原来只等 900ms：
           若过渡时钟因后台页面冻住，900ms 之后高亮还在路上，逐帧采到的就是
           **上一格→这一格**的飞行中段，读数会从 1.6px 跳到 8px 那一档（实测过一次 8.1px）。 */
        const ringHome = () =>
          page.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            const ring = nav.querySelector('[data-hi-ring]')
            const fill = nav.querySelector('[data-jelly] span[aria-hidden]')
            const rr = ring.getBoundingClientRect()
            const fr = fill.getBoundingClientRect()
            return {
              dLeft: Math.round((fr.left - rr.left) * 10) / 10,
              dRight: Math.round((fr.right - rr.right) * 10) / 10,
            }
          })
        await pollUntil(ringHome, (r) => Math.abs(r.dLeft) <= 1 && Math.abs(r.dRight) <= 1)
        await page.waitForTimeout(120)
        /** 逐帧量"白块相对那圈蓝框的最大外露量"（正数 = 露在外面） */
        const blobOutsideRing = () =>
          page.evaluate(async () => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            const ring = nav.querySelector('[data-hi-ring]')
            const layer = nav.querySelector('[data-jelly]')
            const spans = [...layer.querySelectorAll('span[aria-hidden]')]
            const rows = []
            /* 85 帧（原来 70）：容差没放松，只是**多采一点**，免得机器忙时一帧掉队就抽不到峰值 */
            for (let i = 0; i < 85; i++) {
              await new Promise((r) => requestAnimationFrame(r))
              const rr = ring.getBoundingClientRect()
              const boxes = spans.map((s) => s.getBoundingClientRect())
              rows.push(
                Math.round(
                  Math.max(...boxes.map((b) => Math.max(rr.left - b.left, b.right - rr.right))) * 10,
                ) / 10,
              )
            }
            return {
              frames: rows.length,
              worst: Math.max(...rows),
              outside2: rows.filter((v) => v > 2).length,
              outside6: rows.filter((v) => v > 6).length,
            }
          })
        const f5TabBox = await page.getByRole('link', { name: '作业' }).boundingBox()
        if (!f5TabBox) throw new Error(`${SG}：量不到「作业」那一格的位置`)
        /* ⚠️ 和上面 ④ 同一条纪律：先开逐帧轮询，再用 `mouse.click(坐标)` 点下去
              （`locator.click()` 会等元素连续两帧不动 → 整段飞行都过去了，量到 0 = 假绿）。 */
        const blobPolling = blobOutsideRing()
        await page.mouse.click(f5TabBox.x + f5TabBox.width / 2, f5TabBox.y + f5TabBox.height / 2)
        const blobFix = await blobPolling
        await page.waitForTimeout(900)
        check(
          blobFix.frames >= 60 && blobFix.worst <= 6 && blobFix.outside6 === 0,
          `${SG}：🔴 切换时"白块"**不许露到那圈蓝框外面**（用户："晃的时候就像超出了界限"）`,
          `逐帧最大外露 = ${blobFix.worst}px · 超过 2px 的帧 ${blobFix.outside2}/${blobFix.frames} · 超过 6px 的帧 ${blobFix.outside6}`,
          '容差 6px：剩下那点（实测 ~4px、5 帧左右）来自两层 `scaleX` 拉伸的关键帧（1→1.16→0.97→1，' +
            '0.97 那一下框缩得比本体多一点）+ 两层拉伸的中心不同（本体在那一格的中心、框在走廊的中心）；' +
            '修之前（框只包住终点那一格 + 欠阻尼弹簧）实测最大 13.1px、83 帧里 28 帧在外面',
        )

        /* 反向对照：把框钉回"终点那一格"（= 修复前的口径，走廊没了）→ 上面那条**必须**红。
           ⚠️ 用 `<style>` + `!important`：React 每帧写的行内 `left/width` 是**不带 important** 的，
              压不过它；直接对元素 `setProperty` 则会被 React 的下一次渲染覆盖掉（那对照就假绿了）。 */
        const nextCell = await page.evaluate(() => {
          const wrap = document.querySelector('nav[aria-label="主导航"] .glass-light')
          const a = wrap.querySelector('a[aria-label="我的"]')
          const r = a.getBoundingClientRect()
          const pr = wrap.getBoundingClientRect()
          return { left: r.left - pr.left - wrap.clientLeft, width: r.width }
        })
        const oldRingId = '__tmp-ring-no-corridor'
        await page.evaluate(
          ({ id, cell }) => {
            const s = document.createElement('style')
            s.id = id
            s.textContent = `[data-hi-ring]{left:${cell.left}px!important;width:${cell.width}px!important}`
            document.head.appendChild(s)
          },
          { id: oldRingId, cell: nextCell },
        )
        const myBox = await page.getByRole('link', { name: '我的' }).boundingBox()
        if (!myBox) throw new Error(`${SG}：量不到「我的」那一格的位置`)
        const blobPollingOld = blobOutsideRing()
        await page.mouse.click(myBox.x + myBox.width / 2, myBox.y + myBox.height / 2)
        const blobOld = await blobPollingOld
        await page.evaluate((id) => document.getElementById(id)?.remove(), oldRingId)
        await page.waitForTimeout(900)
        check(
          blobOld.worst > 6 && blobOld.outside6 > 0,
          `${SG}：🧪 反向对照 —— 把框钉回"终点那一格"（修复前的口径），上面那条**必须**红`,
          `同一段逐帧采样：最大外露 = ${blobOld.worst}px · 超过 6px 的帧 ${blobOld.outside6}/${blobOld.frames}`,
          '这一条红了才说明上面那条不是在放水：框只要不含"活动走廊"，欠阻尼的尾巴就会探出去',
        )
        /* 对照拆掉之后，框必须回到"当前那一格"上（否则后面几节都在一个坏了的框上跑） */
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(700)
        const ringBack = await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航"]')
          const ring = nav.querySelector('[data-hi-ring]').getBoundingClientRect()
          const fill = nav.querySelector('[data-jelly] span[aria-hidden]').getBoundingClientRect()
          return {
            dLeft: Math.round((fill.left - ring.left) * 10) / 10,
            dRight: Math.round((fill.right - ring.right) * 10) / 10,
          }
        })
        check(
          Math.abs(ringBack.dLeft) <= 1 && Math.abs(ringBack.dRight) <= 1,
          `${SG}：静止时那圈框**严丝合缝地落在当前那一格上**（走廊已经收回，不是停在"两格宽"上）`,
          `框与填充的偏差：左 ${ringBack.dLeft}px / 右 ${ringBack.dRight}px`,
        )

        /* ============================================================
           ---- ⑧ 🔴 2026-10-09 F5-2：移动端导航的**通透性**（"改低一点点"）----
           ------------------------------------------------------------
           `.glass-light` 全仓只有两处用（底部胶囊 + 旁边那颗圆按钮）→ 它就是"移动端导航栏"。
           用户要的是"通透性改低" = **更实**（⛔ 不是更透明）：这一条从 computed style 里
           把白底那两档 alpha 读出来，要求最浅那一档 **≥ 0.30**（F5 之前是 0.24）。
           反向对照：插一条把值改回 0.24/0.34 的规则 → 同一段读取**必须**红。
           ⚠️ 桌面左栏那块玻璃走的是 `.floating-rail`，这一轮**一个字没动** —— 它由
              「桌面左栏的玻璃观感没变」那一条（下面的 ⑨）逐字钉住。
           ============================================================ */
        const glassAlpha = () =>
          page.evaluate(() => {
            const el = document.querySelector('nav[aria-label="主导航"] .glass-light')
            if (!el) return null
            const img = getComputedStyle(el).backgroundImage
            const alphas = [...img.matchAll(/rgba?\([^)]*?([\d.]+)\)/g)].map((m) => Number(m[1]))
            return {
              raw: img,
              min: alphas.length ? Math.min(...alphas) : null,
              max: alphas.length ? Math.max(...alphas) : null,
            }
          })
        const gNow = await glassAlpha()
        check(
          gNow !== null && gNow.min !== null && gNow.min >= 0.3,
          `${SG}：🔴 移动端导航的白底**更实了一档**（"通透性改低一点点" = 更不透明）`,
          `白底两档 alpha = ${gNow?.min} / ${gNow?.max}（F5 之前是 0.24 / 0.34）`,
          '方向别弄反：用户要的是"改低通透性"，所以是**抬白底**、不是减模糊（blur 36px 一个字没动）',
        )
        const oldGlassId = '__tmp-glass-transparent'
        await page.evaluate((id) => {
          const s = document.createElement('style')
          s.id = id
          /* F5 之前那一版（白 24/34%）—— 只覆盖 `.glass-light`，不动别的 */
          s.textContent =
            '.glass-light{background:linear-gradient(180deg,rgb(255 255 255/.24),rgb(255 255 255/.34))!important}'
          document.head.appendChild(s)
        }, oldGlassId)
        const gBack = await glassAlpha()
        await page.evaluate((id) => document.getElementById(id)?.remove(), oldGlassId)
        const gRestored = await glassAlpha()
        check(
          gBack !== null && gBack.min !== null && gBack.min < 0.3,
          `${SG}：🧪 反向对照 —— 把白底改回 0.24/0.34（F5 之前的值），上面那条**必须**红`,
          `改回去之后读到 = ${gBack?.min} / ${gBack?.max}`,
        )
        check(
          gRestored !== null && gRestored.min !== null && gRestored.min >= 0.3,
          `${SG}：对照拆掉之后回到这一轮的值（探针读的是真样式，不是缓存）`,
          `恢复后 = ${gRestored?.min} / ${gRestored?.max}`,
        )

        /* ============================================================
           ---- ⑨ 🔴 2026-10-09 F5-2：桌面左栏的玻璃**一个字没变** ----
           ------------------------------------------------------------
           用户只说了"**移动端**把导航栏的通透性改低一点点" → 桌面左栏那块玻璃
           （`.floating-rail`：白 92%/80% + `blur(18px) saturate(170%)`）**逐字钉住**。
           ⚠️ `.floating-rail` 与 `.glass-light` 是两块**不同**的材料：
              前者是桌面左栏，后者只有移动端导航那两处用（上面 ⑧ 已断言）。
           ============================================================ */
        const railGlass = () =>
          page.evaluate(() => {
            const el = document.querySelector('.floating-rail')
            if (!el) return null
            const cs = getComputedStyle(el)
            return { bg: cs.backgroundImage, backdrop: cs.backdropFilter }
          })
        const railNow = await railGlass()
        check(
          railNow !== null &&
            /0\.92/.test(railNow.bg) &&
            /0\.8/.test(railNow.bg) &&
            /blur\(18px\)/.test(railNow.backdrop) &&
            /saturate\(1\.7/.test(railNow.backdrop),
          `${SG}：桌面左栏的玻璃观感**没变**（白 92%/80% + blur 18px saturate 170% —— 逐字同值）`,
          `background=${railNow?.bg} · backdrop-filter=${railNow?.backdrop}`,
          '用户只要求改移动端：桌面左栏这块玻璃这一轮一个字都没动',
        )
        const tmpRailId = '__tmp-rail-glass'
        await page.evaluate((id) => {
          const s = document.createElement('style')
          s.id = id
          s.textContent = '.floating-rail{background:linear-gradient(180deg,rgb(255 255 255/.5),rgb(255 255 255/.4))!important}'
          document.head.appendChild(s)
        }, tmpRailId)
        const railTouched = await railGlass()
        await page.evaluate((id) => document.getElementById(id)?.remove(), tmpRailId)
        check(
          railTouched !== null && !/0\.92/.test(railTouched.bg),
          `${SG}：🧪 对照 —— 这条读的是**真样式**（把「.floating-rail」改坏，同一段读取立刻变）`,
          `改坏之后读到 = ${railTouched?.bg}`,
        )

        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(300)
      })
      }

      /* ================= 作业列表：班级筛选 ================= */

      const SF = '40 作业列表筛选'
      await step(SF, async () => {
        await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
        await expectPage(page, SF, { url: '/assignments', markers: ['5 份档案'], date: D0919 })
        const rows = await page.locator('.row').count()
        check(rows > 0, '作业列表渲染出了条目（.row）', `数到 ${rows} 行`)
        await page.getByLabel('按班级筛选').selectOption({ index: 1 })
        await page.waitForTimeout(400)
        const selected = await page.getByLabel('按班级筛选').inputValue()
        check(selected !== 'all', '筛选真的选中了某个班级（不是"全部"）', `select 的值 = ${selected}`)
      })
      await shot(page, SF, '40-assignments-filter', {
        full: true,
        wait: 0,
        expect: { url: '/assignments' },
      })

      await goto(page, '41 日程表', '/schedule', {
        // 日程表那两块标题跟着时钟走（今天 · 周X），所以这里要的是**结构**不是具体星期。
        // ⚠️ 页面标题是「日程表」不是「课表」：平台里有**两套**课表（`scope='mine'`
        //    的个人排课表 / `scope='class'` 的班级课表），两套都叫"课表"就分不清了。
        markers: ['日程表', '整周日程', '今天 · 周'],
      })
      await shot(page, '41 日程表', '41-schedule', { full: true, wait: 0 })

      /* ================= 底栏拖拽：胶囊实时跟手 ================= */

      const SD = '38–39 底栏拖拽'
      await step(SD, async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(600)
        await expectPage(page, SD, { url: '/', markers: ['今日待办'], date: D0919 })
      })
      /*
       * ⚠️ 选择器要按**语义**选，不要按样式类名选。
       * 原来写的是 `nav.nav-frost > div`，而 `nav-frost` 是底栏胶囊的一个**样式类**，
       * 被一次导航栏改版（AppShell）换掉之后，这一段就静默地找不到了 ——
       * 报错信息是 `locator.boundingBox: Timeout`，看名字完全想不到是"类名没了"。
       * 现在用 `aria-label="主导航"`（那是可访问性语义，改样式不会动它）。
       *
       * ⚠️ 坐标要按**胶囊本体**算，不要按外面那条包裹带算。
       *    `nav > div` 是那条 `max-width:640px` 的居中带（414 视口下宽 256、左右各 16 内边距），
       *    胶囊本体在里面（宽 = 3×48 + 2×4 = 152）。用包裹带的 58% 去当落点，
       *    算出来是**第 3 格「我的」**（真踩过：松手后跳到了 /settings）。
       *    这里改成"拖到第 2 格「作业」的中心"，落点是**按格子中心**算的，不靠百分比碰运气。
       *
       * ⚠️ 原来这里是 `if (sb) { … }` —— 找不到胶囊就**静默少两张图**。
       *    现在改成硬断言：量不到就红、就中断。
       */
      const strip = page.locator('nav[aria-label="主导航"] > div')
      await step(SD, async () => {
        const info = await pageInfo(page)
        const box = await strip.boundingBox()
        check(Boolean(box), '量到了导航包裹带的位置（底栏拖拽要按它算坐标）', JSON.stringify(box))
        if (!box || !info.capsule) throw new Error('找不到 nav[aria-label="主导航"] > div —— 底栏结构变了？')
        const cap = info.capsule
        // 胶囊内边距盒的原点（跟 AppShell 的 pillOrigin 一个口径）
        const originX = cap.x + cap.clientLeft
        const tabW = 48
        const targetX = originX + 4 + tabW * 1.5 // 第 2 格（作业）的中心
        crumb(`从 left+20 拖到第 2 格中心（x=${Math.round(targetX)}，胶囊宽 ${Math.round(cap.width)}）`)
        await page.mouse.move(originX + 20, cap.y + cap.height / 2)
        await page.mouse.down()
        await page.mouse.move(targetX, cap.y + cap.height / 2, { steps: 14 })
        await page.waitForTimeout(120)
        // 拖拽中高亮块应该跟到第 2 格附近（left ≈ 4 + 48 = 52，相对胶囊）
        const hi = (await pageInfo(page)).hi
        check(
          hi && Math.abs(hi.left - (originX + 4 + tabW)) <= 6,
          '拖拽中高亮块跟到了第 2 格（跟手）',
          hi ? `高亮 left=${hi.left}，期望 ≈ ${Math.round(originX + 4 + tabW)}` : '没量到高亮块',
        )
      })
      await shot(page, SD, '38-nav-drag', { wait: 0, expect: { url: '/' } })

      await step(SD, async () => {
        await page.mouse.up()
        await page.waitForTimeout(400)
        // 落在「作业」那一格 → 真的跳过去（导航出过"看着点了其实没跳"的故障）
        check(
          new URL(page.url()).pathname === '/assignments',
          '松手后胶囊把当前页切到了拖到的那一格（/assignments）',
          `url = ${new URL(page.url()).pathname}`,
        )
      })
      await shot(page, SD, '39-nav-dropped', {
        wait: 800,
        expect: { url: '/assignments' },
      })

      /* ============================================================
         ===== 按身份显示导航（方案 §五 R2/R3：B1–B7 / C1–C5） =====
         ------------------------------------------------------------
         这一节要回答的是**两个方向**（§18.3：两个坏法方向相反，各要一条对照）：

           ① **该藏的时候藏了**：任课教师看不见「教师账号」/「平台运维」/「年级管理」；
           ② **该显示的时候真的显示**：教导处看得见「教师账号」、超管看得见「平台运维」
              —— 这才是本轮 `?as=` 钩子存在的全部理由。

         🔴 为什么以前做不到：`shots.mjs` 跑的是**本地演示模式**，而 `myRoles` 只在
         **远程模式**由 `hydrate()` 从 `loadMyRoles()` 灌进去，本地模式恒为 `[]`
         —— 所有账号都是"任课教师"。所以这里用 `App.tsx` 的 DEV 钩子 `?as=<代码>`
         （方案 §七 待确认 ③；生产构建里被摇掉，见 `nav-checks.mjs` 的 D7）。

         ⚠️ 钩子**只在 DEV 生效**，而本脚本跑的是 `vite dev`（5178）→ 钩子有效。
            如果哪天有人把它做成"生产也生效"，这里会先绿 —— 拦住它的是 D7（读 dist）。
         ============================================================ */

      const SNAV = '按身份显示导航'

      /**
       * 这一节整个跑在**自己新建的 context** 里（与超管面板那一节同一个理由）：
       * 主流程的 `addInitScript` 写死了 `deviceRole='teacher'` 并把导航尺寸那套
       * 拨表/滚动都带上；这一节要的是 1440px 桌面宽度与干净的 localStorage。
       */
      const ctxNav = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
      await ctxNav.clock.install({ time: new Date('2026-09-19T10:00:00') })
      const navPage = await ctxNav.newPage()
      navPage.on('pageerror', (e) => errors.push(`PAGEERROR(${SNAV}) :: ${e.message}`))
      navPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${SNAV}) :: ${m.text()}`)
      })
      /*
       * 🧪 **负向对照用的总闸**（与 `nav-checks.mjs` 同一个）：`SHUGAO_NAV_FORCE=all|none`
       * 会让 `entryVisible()` 在这个浏览器里恒真 / 恒假 —— 用来证明**真界面这一层也会红**。
       * ⚠️ 只加在导航那一节的 context 上：其它节不受影响，跑完这一节整个 context 就关掉了。
       * 不设这个环境变量时它 `?? null` → 不注入，行为与以前完全一样。
       */
      if (process.env.SHUGAO_NAV_FORCE) {
        await ctxNav.addInitScript((v) => {
          window.__NAV_FORCE__ = v
        }, process.env.SHUGAO_NAV_FORCE)
        console.log(`  🧪🧪 负向对照模式：浏览器里 entryVisible 恒 ${process.env.SHUGAO_NAV_FORCE === 'all' ? '真' : '假'}（导航那一节**必须**有红）`)
      }

      /** 进某一页 + 注入身份。`as` 为空 = 不注入（= 演示模式默认的"任课教师"） */
      const navGoto = async (path, as = '') => {
        await navPage.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
        await navPage.evaluate(
          ([state, a, role]) => {
            localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
            localStorage.setItem('shugao.deviceRole', role)
            const u = new URL(location.href)
            if (a) u.searchParams.set('as', a)
            else u.searchParams.delete('as')
            location.replace(u.toString())
          },
          [TEACHER_STATE.state, as, 'teacher'],
        )
        await navPage.waitForLoadState('networkidle')
        await waitPageSettled(navPage) // E6：路由 chunk 现拉，等兜底退场（原固定 420ms 实测是竞态）
        await navPage.waitForTimeout(420)
      }

      /** 桌面左栏里**实际摆着**哪几项（按语义选择器，不按样式类名 —— §15.5 的教训） */
      const railLabels = () =>
        navPage.evaluate(() =>
          [...document.querySelectorAll('nav[aria-label="主导航 · 桌面"] a[aria-label]')].map((a) =>
            a.getAttribute('aria-label'),
          ),
        )

      /** 移动端展开层里那几项（点开圆按钮之后读 `[data-nav-pop]`；面板里已经没有页脚了） */
      const sheetLabels = async () => {
        await navPage.getByRole('button', { name: '展开更多入口' }).click()
        await navPage.waitForTimeout(360)
        const out = await navPage.evaluate(() => {
          const box = document.querySelector('[data-nav-pop]')
          const morph = document.querySelector('[data-nav-morph]')
          return {
            open: Boolean(box) && morph?.getAttribute('data-open') === 'true',
            items: box
              ? [...box.querySelectorAll('button')]
                  .map((b) => (b.innerText ?? '').split('\n')[0].trim())
                  .filter((x) => x && x !== '收起')
              : [],
            body: (box?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          }
        })
        await navPage.keyboard.press('Escape')
        await navPage.waitForTimeout(220)
        return out
      }

      /**
       * 「我的」页上那几行入口在不在（按行文案，不看实现）。
       *
       * 🔴 **2026-10-01「行政管理」轮改了三个字段的语义**（原来是
       * `accounts` / `files` / `schedule` / `admin`）：
       *    · `accounts` —— 原来查的是「教师账号」那一行的副标题「建号（带学科）」，
       *      而那一行**搬去 `/manage` 了** → 现在它查的是**「行政管理」那一行**
       *      （副标题「年级 · 档案 · 教师」：它才是「我的」页上新出现的入口）。
       *      更名 `manage` 是为了不留下一个名字骗人的字段（这一点比省一行改更重要）。
       *    · 新增两个**反向字段**：`archive` / `accountsRow` ——
       *      它们查的是**搬走的那两行原来那两句副标题**，**在「我的」页上必须查不到**。
       *      这正是"反向断言：加回来 → 必须红"的落点（那两行加回这一页就会红）。
       */
      const settingsRows = async () => {
        const b = await bodyText(navPage)
        return {
          body: b,
          manage: b.includes('年级 · 档案 · 教师'),
          files: b.includes('传到教室大屏'),
          schedule: b.includes('录入上课与日程'),
          admin: b.includes('只读体检屏'),
          archive: b.includes('高三毕业的备份与删除'),
          accountsRow: b.includes('建号（带学科）'),
        }
      }

      /*
       * 🆕 2026-09-28：加了「通知」那一项（`管理架构与角色权限方案.md` §四.2 第 18 行：
       * **所有老师都是 V**）。所以这份清单从 7 项变成 **8 项**。
       * ⚠️ 它**对每一个教师身份都摆**（含班主任与任课教师）—— 收件箱对谁都有意义，
       *    而"看通知"与"发通知"是两件事（后者只有那八档，见 `ENTRIES['/notices/new']`）。
       */
      const RAIL_TEACHER = ['工作台', '班级', '作业', '考试', '错题集', '日程表', '通知', '我的']

      /**
       * 🆕 2026-10-01「行政管理」（`/manage`）：**左栏第一次因身份而不同**。
       *
       * 在此之前 `NAV` 里每一项对所有教师身份都是 V（`/notices` 是 `() => true`，
       * 其余八项也一样），所以"教导处与任课教师的左栏逐项相同"这句**是对的**。
       * 这一轮加了 `/manage` —— 它的判据是**三张卡判据的并集**
       * （`seesAdministration` = `hasManagingRole || canManageTeachers`
       * = 超管 / 教务处 / 年级主任 / 办公室主任），而**班主任与任课教师看不见它**。
       *
       * → 所以现在有两份清单：
       *    · `RAIL_TEACHER`（8 项，不带行政管理）—— 任课教师 / 班主任；
       *    · `RAIL_MANAGING`（9 项，`通知` 与 `我的` 之间多一项「行政管理」）——
       *      超管 / 教务处 / 年级主任 / 办公室主任。
       * ⚠️ 位置是**刻意的**：它排在「通知」之后、「我的」之前 —— `NAV` 的顺序即左栏顺序，
       *    而"行政管理是一个页面、不是设置项"这件事就体现在它**不在最后**。
       */
      const RAIL_MANAGING = ['工作台', '班级', '作业', '考试', '错题集', '日程表', '通知', '行政管理', '我的']

      /**
       * 🆕 2026-10-08：**导航项那一块溢出时自己滚 + 交界处渐隐**（用户点名要的）。
       * 步子在这一节（`SNAV`）之后 —— 它要的是同一套桌面左栏，但换视口高度（500 / 1200）。
       */
      const SROLL = '左栏导航溢出可滚 · 交界渐隐'

      /* ---------- B1：桌面左栏逐角色**集合相等**（多一项也红） ---------- */

      await step(SNAV, async () => {
        /*
         * ① 先钉住"演示模式默认就是任课教师"这个前提 —— 否则下面每一条
         *    "任课教师看不见 X" 都可能是"钩子根本没生效"造成的**假通过**。
         */
        await navGoto('/', '')
        const info = await navPage.evaluate(() => ({
          rail: [...document.querySelectorAll('nav[aria-label="主导航 · 桌面"] a[aria-label]')].length,
          hasHook: new URL(location.href).searchParams.has('as'),
        }))
        check(!info.hasHook, `${SNAV}：不注入时 URL 上没有 ?as=（前提自证）`, `hasHook=${info.hasHook}`)
      })

      await step(SNAV, async () => {
        await navGoto('/', 'teacher')
        const got = await railLabels()
        check(
          JSON.stringify(got) === JSON.stringify(RAIL_TEACHER),
          `${SNAV}：**任课教师**的桌面左栏 = ${RAIL_TEACHER.join(' / ')}（集合相等，多一项也红）`,
          `实际 ${got.length} 项：${got.join(' / ') || '(空)'}`,
        )
        check(
          !got.includes('年级管理') && !got.includes('平台运维') && !got.includes('行政管理'),
          `${SNAV}：任课教师**看不见**「年级管理」「平台运维」「行政管理」`,
          got.includes('年级管理') || got.includes('平台运维') || got.includes('行政管理')
            ? `实际：${got.join(' / ')}`
            : '三个都不在',
        )
      })

      await step(SNAV, async () => {
        await navGoto('/', 'admin')
        const got = await railLabels()
        /*
         * 🔴 **2026-10-01 这一条从"与任课教师逐项相同"改成"比任课教师多一项「行政管理」"**，
         *    这是本轮**唯一一处"左栏按身份不同"**，理由与逐档写在这里：
         *      · 教导处（admin）看得见 `/manage` —— 因为那三张卡里有两张的判据是
         *        `canManageTeachers`（含 admin）；
         *      · 任课教师看不见 —— 他够不着那三张卡里的任何一张（`RAIL_TEACHER` 那条钉的反方向）；
         *      · ⚠️ 旧注释里那句"§2.2 的 25/9 与 31/3 说的是入口总数，不是这一栏"
         *        **今天仍然成立**，但结论变了：左栏**不再**对五个教师身份相同。
         */
        check(
          JSON.stringify(got) === JSON.stringify(RAIL_MANAGING),
          `${SNAV}：**教导处**的左栏比任课教师**多一项「行政管理」**（三张卡里有两张的判据含 admin）`,
          `实际 ${got.length} 项：${got.join(' / ') || '(空)'}`,
        )
        check(
          !got.includes('平台运维'),
          `${SNAV}：教导处**看不见**「平台运维」（判据是 isSuperAdmin，不是 canManageTeachers）`,
          got.includes('平台运维') ? `实际：${got.join(' / ')}` : '不在',
        )
        await shot(navPage, SNAV, '86-nav-role-desktop-admin', { full: false })
      })

      await step(SNAV, async () => {
        await navGoto('/', 'super')
        const got = await railLabels()
        /*
         * 🔴 **2026-10-01 改了这一条**：原来它断言"超管的左栏也是那 8 项"，
         *    理由是"`NAV` 里今天没有只给超管的项"—— 那句话**不再成立**：
         *    加了「行政管理」之后，超管（与教务处 / 年级主任 / 办公室主任）
         *    的左栏是 **9 项**（比任课教师多「行政管理」）。
         *    "超管比别人还多「平台运维」"这件事**一直不在左栏**（它在「我的」页那一行），
         *    所以这里除「行政管理」之外仍然与任课教师逐项相同。
         */
        check(
          JSON.stringify(got) === JSON.stringify(RAIL_MANAGING),
          `${SNAV}：**超管**的左栏 = 那 8 项 + 「行政管理」（判据是三张卡的并集；「平台运维」仍不在左栏）`,
          `实际 ${got.length} 项：${got.join(' / ') || '(空)'}`,
        )
        check(
          got.includes('工作台') && got.includes('我的'),
          `${SNAV}：两端的项都在（过滤没有把首尾漏掉）`,
          `${got[0]} … ${got[got.length - 1]}`,
        )
      })

      /* ---------- 高亮不许错位（activeIdx / pinIdx / moreActive 三处） ---------- */

      await step(SNAV, async () => {
        /*
         * 🔴 这条是"过滤之后三处索引一起换"的**行为断言**（D6 是它的静态版）：
         *    超管左栏多了一项，进 `/` 之后**高亮的必须是「工作台」**，不是别人。
         *    `data-active="true"` 挂在 RailItem 内层那个 span 上（见 AppShell）。
         */
        await navGoto('/', 'super')
        const active = await navPage.evaluate(() =>
          [...document.querySelectorAll('nav[aria-label="主导航 · 桌面"] span[data-active="true"]')]
            .map((s) => (s.closest('a')?.getAttribute('aria-label') ?? '').trim())
            .filter(Boolean),
        )
        check(
          JSON.stringify(active) === JSON.stringify(['工作台']),
          `${SNAV}：超管在 / 时左栏高亮的是「工作台」（过滤没有让高亮错位）`,
          `data-active=true 的是 ${JSON.stringify(active)}`,
        )
      })

      /* ---------- 桌面左栏：那一层高亮**怎么动**（弹簧 / 首帧不动画 / reduced 直接跳） ----------
       *
       * 2026-10-01 第三轮追加：用户要"长方体在管子里流过去"的那种 Q 弹 ——
       * 位移改成 rAF 弹簧 + 沿运动方向轻轻 `scaleY`，**不加** gooey（矩形做融合很难看）。
       * 四条断言各有反向对照，另外钉住"选中态至少还剩两个信号"（用户点名不许降可辨识性）。
       */
      await step(SNAV, async () => {
        /** 高亮那一层与"选中项"此刻的位置（都是相对左栏 `nav` 的坐标） */
        const railProbe = () =>
          navPage.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const pill = nav?.querySelector('.rail-pill')
            const act = nav?.querySelector('span[data-active="true"]')
            if (!nav || !pill || !act) return null
            const pr = nav.getBoundingClientRect()
            const r = pill.getBoundingClientRect()
            const ar = act.getBoundingClientRect()
            const raw = getComputedStyle(pill).transform
            return {
              flow: nav.getAttribute('data-rail-flow'),
              top: Math.round((r.top - pr.top) * 10) / 10,
              height: Math.round(r.height * 10) / 10,
              opacity: getComputedStyle(pill).opacity,
              /* `matrix(a, b, c, d, e, f)` 的 d 就是 scaleY */
              scaleY: !raw || raw === 'none' ? 1 : Math.round(new DOMMatrix(raw).d * 1000) / 1000,
              actTop: Math.round((ar.top - pr.top) * 10) / 10,
              actH: Math.round(ar.height * 10) / 10,
              transitions: getComputedStyle(pill).transitionProperty,
              label: (act.closest('a')?.getAttribute('aria-label') ?? '').trim(),
            }
          })
        /**
         * 逐帧采样高亮**相对左栏**的位置。
         * 判"在流"还是"直接跳"看的是 `mids`（**落在两端之间的采样数**）：
         *   · 弹簧流动 → 会经过一串中间位置；· 直接跳 → 采样只有"起点 / 终点"两种值。
         * ⚠️ 位置必须**相对 `nav` 量**：用视口坐标的话，换页时整页重排会让 `top` 整体位移
         *    （实测量到 126px 的"位移"，其实高亮一步没动）。
         */
        const railMotion = () =>
          navPage.evaluate(async () => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const pill = nav?.querySelector('.rail-pill')
            const tops = []
            let maxScale = 1
            for (let i = 0; i < 36; i++) {
              await new Promise((r) => requestAnimationFrame(r))
              if (!pill || !nav) continue
              tops.push(pill.getBoundingClientRect().top - nav.getBoundingClientRect().top)
              const raw = getComputedStyle(pill).transform
              if (raw && raw !== 'none') maxScale = Math.max(maxScale, new DOMMatrix(raw).d)
            }
            if (!tops.length) return { travel: 0, mids: 0, maxScale: 1 }
            const min = Math.min(...tops)
            const max = Math.max(...tops)
            const mids = tops.filter((t) => t > min + 3 && t < max - 3).length
            return {
              travel: Math.round((max - min) * 10) / 10,
              mids,
              maxScale: Math.round(maxScale * 1000) / 1000,
            }
          })
        /** 逐帧采样 + 中途点另一个入口（弹簧只在"换项"时跑）
         *  ⚠️ 用 `mouse.click(坐标)` 而不是 `locator.click()`：后者会等"连续两帧位置不变"才点，
         *     那样整段弹簧都跑完了才点下去，逐帧采样只会量到 0（假绿）。 */
        const railMotionAfterClick = async (name) => {
          const box = await navPage
            .locator(`nav[aria-label="主导航 · 桌面"] a[aria-label="${name}"]`)
            .boundingBox()
          if (!box) throw new Error(`${SNAV}：量不到左栏「${name}」的位置`)
          const polling = railMotion()
          await navPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          return await polling
        }

        /* ① 落位之后高亮与选中项**严丝合缝**，而且 CSS 那头**没有** top/height 过渡
              （有的话就是"CSS 过渡 + JS 弹簧"两套叠加 —— 追不上还抖） */
        await navGoto('/', 'super')
        await navPage.waitForTimeout(700)
        const sit = await railProbe()
        check(
          sit &&
            sit.opacity === '1' &&
            Math.abs(sit.top - sit.actTop) <= 1 &&
            Math.abs(sit.height - sit.actH) <= 1 &&
            sit.transitions === 'opacity',
          `${SNAV}：左栏高亮**落在选中项上**，且位移只由 JS 弹簧驱动（CSS 那头只剩 opacity）`,
          sit
            ? `高亮 top=${sit.top}/h=${sit.height} · 选中项 top=${sit.actTop}/h=${sit.actH} · scaleY=${sit.scaleY} · transition=${sit.transitions}`
            : '没量到高亮 / 选中项',
        )

        /* ② 换一项：**真的在流**（逐帧位移 > 2px），而且路上**沿运动方向拉长**了（scaleY > 1） */
        await navGoto('/', 'super')
        await navPage.waitForTimeout(700)
        const fly = await railMotionAfterClick('考试')
        await navPage.waitForTimeout(900)
        const after = await railProbe()
        check(
          fly.travel > 2 && fly.mids > 2,
          `${SNAV}：点另一项时高亮**真的在流过去**（逐帧量到 ${fly.travel}px 的位移、${fly.mids} 个中间位置）`,
          `逐帧位移 = ${fly.travel}px · 中间位置采样 = ${fly.mids} 个`,
          '判据是"路上有中间位置"：直接跳的话采样只有起点/终点两种值（mids=0）',
        )
        check(
          fly.maxScale > 1.005 && fly.maxScale <= 1.0601,
          `${SNAV}：流动中沿运动方向**轻轻拉长**（scaleY 略大于 1，上限 6%）——"液体在管子里流"`,
          `过程中最大 scaleY = ${fly.maxScale}（到位应回到 1）`,
          '用户明确说"长方形的，效果别叠太过"：所以上限钉在 1.06，⛔ 不是原来那个 1.24',
        )
        check(
          after && after.label === '考试' && Math.abs(after.top - after.actTop) <= 1 && after.scaleY === 1,
          `${SNAV}：流到位之后**收圆**（scaleY 回到 1）且停在新的选中项上`,
          after ? `停在「${after.label}」top=${after.top}（选中项 ${after.actTop}）· scaleY=${after.scaleY}` : '没量到',
        )

        /* ③ 🔴 **首屏不许播动画**：直接进 /exams（不是点进去），前 36 帧位置不许变
              —— 反向对照是②（同一套采样，换了项就是"在动"） */
        await navPage.goto(`${BASE}/exams`, { waitUntil: 'networkidle' })
        const boot = await railMotion()
        const bootSit = await railProbe()
        check(
          boot.mids === 0 && bootSit?.label === '考试' && Math.abs(bootSit.top - bootSit.actTop) <= 1,
          `${SNAV}：🔴**首屏直接定位**（刚进页面那 36 帧里高亮一动不动，不是从顶上飞下来）`,
          `首屏：位移 ${boot.travel}px / 中间位置 ${boot.mids} 个 · 停在「${bootSit?.label}」· 位置 ${bootSit?.top} vs ${bootSit?.actTop}`,
          '反向对照见②：同一套采样在"点了另一项"时量到的是 > 2px 位移 + 多个中间位置',
        )

        /* ④ 🔴 `prefers-reduced-motion: reduce` → 直接跳（没有弹簧、没有拉伸） */
        await navPage.emulateMedia({ reducedMotion: 'reduce' })
        await navPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await navPage.waitForTimeout(700)
        const rmFlow = await railProbe()
        const rmFly = await railMotionAfterClick('考试')
        await navPage.waitForTimeout(500)
        const rmAfter = await railProbe()
        check(
          rmFlow?.flow === 'off' && rmFly.mids <= 1 && rmFly.maxScale === 1 && rmAfter?.label === '考试',
          `${SNAV}：🔴 \`prefers-reduced-motion: reduce\` → 左栏高亮**直接跳**（无弹簧、无拉伸）`,
          `data-rail-flow=${rmFlow?.flow} · 位移=${rmFly.travel}px / 中间位置=${rmFly.mids} 个 · 最大 scaleY=${rmFly.maxScale} · 落到「${rmAfter?.label}」`,
          '和②同一条采样：正常动效下 mids>2（路上有中间位置），reduced 下必须一步到位',
        )
        /* ⚠️ **先把 reduced-motion 关回来**：上一节 ④ 把它开成了 `reduce`，而这一节量的正是
           "弹簧的过冲" —— 在 reduced 下高亮是**直接跳**的（过冲恒为 0），那这条断言会变成
           **假绿**（量到 ratio=0 却什么也没测）。所以这里先复位，并且下面那条 check 里
           额外要求 `data-rail-flow === 'on'`（开关不在就是"没测"）。 */
        await navPage.emulateMedia({ reducedMotion: 'no-preference' })
        await navGoto('/', 'super')
        await navPage.waitForTimeout(400)

        /* ⑤ 🔴 2026-10-09 F5-3：**晃动幅度**（用户原话：「电脑端导航栏按钮切换的时候
         *    **晃动幅度改小，太大了**」）—— 判据三条，各带反向对照：
         *      ① 静态扫源码：左栏那套常数里**阻尼被压小**（≤ 0.70）★ 而移动端那颗果冻的
         *         `SPRING_DAMP` **仍然是 0.78**（用户只说了电脑端，移动端不许跟着改）；
         *         反向对照：把源码里那个 0.66 改回 0.78，**同一个扫描函数必须判假**；
         *      ② 逐帧实测**过冲比例**（冲过落点再荡回来的最大幅度 ÷ 行程）：这一轮 ~10%、
         *         上一轮（阻尼 0.78）实测 31%（行程 125px 时是 39px —— 就是"晃动太大"）；
         *      ③ 把源码里读到的**两组参数**喂给**同一套弹簧算式**重跑：新参数 ≤ 0.13、
         *         旧参数 ≥ 0.25 —— 这一条用来证明②那个阈值不是恒真的摆设。 */
        const railSrc = readFileSync(join(HERE, '..', 'src', 'components', 'AppShell.tsx'), 'utf8')
        /** 扫左栏那套常数（同一个函数要能在"改回旧值"的副本上判假） */
        const scanRailSpring = (src) => ({
          railDamp: Number(/const RAIL_SPRING_DAMP = ([\d.]+)/.exec(src)?.[1] ?? NaN),
          railStiffShared: /const RAIL_SPRING_STIFF = SPRING_STIFF/.test(src),
          mobileDamp: Number(/const SPRING_DAMP = ([\d.]+)/.exec(src)?.[1] ?? NaN),
          /* 左栏那个弹簧**真的**用了这套常数（逐字钉住那一行，不是只定义了没人用） */
          railTickUses:
            /st\.vh = \(st\.vh \+ \(tg\.height - st\.height\) \* RAIL_SPRING_STIFF \* k\) \* Math\.pow\(RAIL_SPRING_DAMP, k\)/.test(
              src,
            ),
        })
        const rs = scanRailSpring(railSrc)
        check(
          Number.isFinite(rs.railDamp) &&
            rs.railDamp <= 0.7 &&
            rs.railStiffShared &&
            rs.mobileDamp === 0.78 &&
            rs.railTickUses,
          `${SNAV}：🔴 桌面左栏的**阻尼压小了**（≤0.70），而移动端那颗果冻**一个字没动**（0.78）`,
          `RAIL_SPRING_DAMP=${rs.railDamp} · RAIL_SPRING_STIFF=SPRING_STIFF:${rs.railStiffShared} · SPRING_DAMP（移动端）=${rs.mobileDamp} · 左栏弹簧真的用了它:${rs.railTickUses}`,
          '用户只说了"电脑端"：移动端那颗果冻的 Q 弹（0.14 / 0.78）不许跟着改',
        )
        const rsBroken = scanRailSpring(
          railSrc
            .replace(/const RAIL_SPRING_DAMP = [\d.]+/, 'const RAIL_SPRING_DAMP = 0.78')
            .replace(/RAIL_SPRING_STIFF/g, 'SPRING_STIFF')
            .replace(/RAIL_SPRING_DAMP/g, 'SPRING_DAMP'),
        )
        check(
          !(rsBroken.railDamp <= 0.7 && rsBroken.railStiffShared && rsBroken.railTickUses),
          `${SNAV}：🧪 反向对照 —— 把源码改回旧参数（0.78），上面那条**必须**红`,
          `改回之后扫到：${JSON.stringify(rsBroken)}`,
        )

        /* ② 逐帧实测过冲比例（先开轮询再点，理由同②上面那段） */
        const railOvershoot = async (name) => {
          const box = await navPage
            .locator(`nav[aria-label="主导航 · 桌面"] a[aria-label="${name}"]`)
            .boundingBox()
          if (!box) throw new Error(`${SNAV}：量不到左栏「${name}」的位置`)
          const polling = navPage.evaluate(async () => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const pill = nav.querySelector('.rail-pill')
            const rows = []
            for (let i = 0; i < 70; i++) {
              await new Promise((r) => requestAnimationFrame(r))
              const p = pill.getBoundingClientRect()
              const n = nav.getBoundingClientRect()
              rows.push(p.top - n.top)
            }
            return rows
          })
          await navPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          const rows = await polling
          await navPage.waitForTimeout(900)
          const target = await navPage.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const n = nav.getBoundingClientRect()
            return nav.querySelector('span[data-active="true"]').getBoundingClientRect().top - n.top
          })
          const start = rows[0]
          const dir = Math.sign(target - start) || 1
          const travel = Math.abs(target - start)
          const overshoot = Math.max(...rows.map((t) => (t - target) * dir))
          return {
            travel: Math.round(travel * 10) / 10,
            overshoot: Math.round(overshoot * 10) / 10,
            ratio: travel > 1 ? Math.round((overshoot / travel) * 1000) / 1000 : 0,
          }
        }
        /** 同一套逐帧算式（k=1）离线重跑一遍：给出的过冲比例 */
        const springSim = (stiff, damp, travel = 42) => {
          let x = 0
          let v = 0
          let max = 0
          for (let i = 0; i < 200; i++) {
            v = (v + (travel - x) * stiff) * damp
            x += v
            max = Math.max(max, x)
          }
          return Math.round(((max - travel) / travel) * 1000) / 1000
        }
        const overNow = await railOvershoot('考试')
        /* 🔴 **开关必须在**：`data-rail-flow=off` 时高亮是直接跳的，过冲恒为 0 ——
           那种情况下这条断言就算"绿"也什么都没测到（本仓库最贵的一类坑：假绿）。 */
        const flowOn = await navPage.evaluate(
          () =>
            document.querySelector('nav[aria-label="主导航 · 桌面"]')?.getAttribute('data-rail-flow') ??
            null,
        )
        check(
          flowOn === 'on' && overNow.travel >= 30 && overNow.ratio <= 0.13,
          `${SNAV}：🔴 晃动幅度**压到 13% 以内**（用户："晃动幅度改小，太大了"；上一轮是 31%）`,
          `data-rail-flow=${flowOn} · 行程 ${overNow.travel}px · 过冲 ${overNow.overshoot}px · 比例 ${(overNow.ratio * 100).toFixed(1)}%`,
          '判据是**比例**不是绝对 px：过冲本来就随行程走（换项跨几行，行程就有多大）；' +
            '⚠️ `data-rail-flow=off`（reduced-motion / 直接跳）时过冲恒为 0，所以必须连开关一起判',
        )
        const simNew = springSim(0.14, rs.railDamp)
        const simOld = springSim(0.14, 0.78)
        check(
          simNew <= 0.13 && simOld >= 0.25,
          `${SNAV}：🧪 反向对照 —— 同一套算式下，源码里那对新参数 ≤13%、旧参数（0.78）≥25%`,
          `新参数（DAMP=${rs.railDamp}）过冲 ${(simNew * 100).toFixed(1)}% · 旧参数（0.78）过冲 ${(simOld * 100).toFixed(1)}%`,
          '这一条保证上面那条阈值不是"恒真的摆设"：参数退回去，同一个算式立刻算回 31%',
        )

        await navPage.emulateMedia({ reducedMotion: 'no-preference' })
        await navGoto('/', 'super')
        await navPage.waitForTimeout(400)

        /* ⑤ **可辨识性不许降低**：用户要的是"至少还剩两个信号" ——
              高亮底（①）+ 左侧那道蓝竖条 + 文字/图标变蓝，这里钉后两个 */
        const signals = await navPage.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          const cells = [...nav.querySelectorAll('a[aria-label]')].map((a) => {
            const cell = a.querySelector('span[data-active]')
            const bar = cell?.querySelector('i')
            return {
              name: a.getAttribute('aria-label'),
              active: cell?.getAttribute('data-active') === 'true',
              color: cell ? getComputedStyle(cell).color : null,
              bar: bar ? getComputedStyle(bar).width : null,
            }
          })
          return cells
        })
        const onCell = signals.find((c) => c.active)
        check(
          Boolean(onCell?.bar) &&
            onCell.bar === '2px' &&
            signals.filter((c) => !c.active).every((c) => c.color !== onCell.color),
          `${SNAV}：选中态仍然有**三个信号**（高亮底 + 左侧那道 2px 蓝竖条 + 文字/图标变蓝）`,
          `竖条宽=${onCell?.bar} · 选中「${onCell?.name}」色=${onCell?.color} · 其余色=${signals.filter((c) => !c.active).map((c) => c.color).join('/')}`,
        )
        /* 反向对照：把未选中项的文字刷成同一个颜色 → 上面那条的颜色判据必须红
           （先快照整条 `style` 属性、改完原样写回：不碰 React 管的其他行内属性） */
        const railColorBackup = await navPage.evaluate((c) => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          const cells = [...nav.querySelectorAll('a[aria-label] span[data-active]')]
          const before = cells.map((el) => el.getAttribute('style'))
          for (const el of cells) {
            if (el.getAttribute('data-active') !== 'true') el.style.setProperty('color', c, 'important')
          }
          return before
        }, onCell?.color)
        await navPage.waitForTimeout(400)
        const sig2 = await navPage.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          return [...nav.querySelectorAll('a[aria-label]')].map((a) => {
            const cell = a.querySelector('span[data-active]')
            return cell ? getComputedStyle(cell).color : null
          })
        })
        check(
          new Set(sig2.filter(Boolean)).size === 1,
          `${SNAV}：🧪 反向对照 —— 把未选中项的文字刷成同一个颜色，上面那条的颜色判据**必须**红`,
          `刷完：${sig2.join(' · ')}`,
        )
        await navPage.evaluate((before) => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          const cells = [...nav.querySelectorAll('a[aria-label] span[data-active]')]
          cells.forEach((el, i) => {
            if (before[i] == null) el.removeAttribute('style')
            else el.setAttribute('style', before[i])
          })
        }, railColorBackup)
      })

      /* ---------- B1c：**导航项那一块**溢出时自己滚 + 交界处的渐隐（2026-10-08） ----------
       *
       * 用户原话：「为了避免这里的选项**在部分不同大小的电脑**上不一致，这里加一个
       * **可以滚动的**，**溢出了就自动变成能滚动的**，**交界处要有过渡**」。
       *
       * 🔴 口径（改动前先读 `index.css` 的 `.rail-nav` 那一节）：
       *    · **只有导航项滚** —— 底部的「已连接云端 / N 个班级 · M 名学生」固定在底部；
       *    · **放得下时没有滚动条、也没有渐隐**（"有些电脑放得下、有些放不下"两种都要正常）；
       *    · 渐隐 = `mask-image`（⛔ 不是盖一层纯色：侧栏是液态玻璃），
       *      而且**滚到哪一边到头，那一边的渐隐就收掉**。
       *
       * ⚠️ 渐隐怎么判：读 `mask-image` 的**计算值**，把色标按顺序取 alpha，只看
       *    **第一个**（`firstA`：1 = 顶端实心、0 = 顶端正在渐隐）与**最后一个**（`lastA` 同理）。
       *    不比字符串：色标位置会被浏览器序列化成 px / calc(100%)，比字符串脆。
       *
       * 🧪 **四条反向对照**在这一步末尾（都必须"读到坏值"才算对照成立）：
       *    · 渐隐钉成"两头都渐隐" → 「滚到顶渐隐消失」「高视口没有渐隐」两条必须红；
       *    · `overflow-y: hidden` → 「滚轮能滚 / 滚得到底」两条必须红；
       *    · 把高亮那一片的 `top` 钉在 0 → 「滚过之后高亮仍贴着选中项」必须红；
       *    · 把底部那两行**挪进滚动容器** → 「滚过之后位置没变」必须红。
       */
      await step(SROLL, async () => {
        /** 左栏导航那一块此刻的**溢出 / 滚动位置 / 渐隐 / 底部那两行的位置** */
        const railScrollProbe = () =>
          navPage.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const rail = document.querySelector('.floating-rail')
            const foot = document.querySelector('[data-rail-foot]')
            const items = [...nav.querySelectorAll('a[aria-label]')]
            const last = items[items.length - 1]
            const cs = getComputedStyle(nav)
            const mask = String(cs.maskImage || cs.webkitMaskImage || 'none').replace(
              /transparent/g,
              'rgba(0, 0, 0, 0)',
            )
            const alphas = [...mask.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => {
              const p = m[1].split(/[\s,/]+/).filter(Boolean)
              return p.length >= 4 ? Number(p[3]) : 1
            })
            const nr = nav.getBoundingClientRect()
            const rr = rail.getBoundingClientRect()
            const lr = last.getBoundingClientRect()
            const fr = foot.getBoundingClientRect()
            return {
              overflowY: cs.overflowY,
              scrollTop: Math.round(nav.scrollTop),
              over: nav.scrollHeight - nav.clientHeight,
              /* `offsetWidth - clientWidth` = 竖直滚动条占掉的宽（放得下时必须 0） */
              bar: nav.offsetWidth - nav.clientWidth,
              mask,
              maskOn: mask !== 'none',
              firstA: alphas.length ? alphas[0] : 1,
              lastA: alphas.length ? alphas[alphas.length - 1] : 1,
              attr: nav.getAttribute('data-rail-scroll'),
              lastLabel: last.getAttribute('aria-label'),
              lastFully: lr.bottom <= nr.bottom + 1 && lr.top >= nr.top - 1,
              lastGap: Math.round(nr.bottom - lr.bottom),
              navBottomInRail: Math.round(nr.bottom - rr.top),
              footInNav: nav.contains(foot),
              footTopInRail: Math.round(fr.top - rr.top),
              footBottomInRail: Math.round(rr.bottom - fr.bottom),
              footText: String(foot.innerText || '').replace(/\s+/g, ' ').trim(),
            }
          })
        /** 把导航项那一块滚到某个位置（程序化；"滚轮能不能滚"另有一条） */
        const railScrollTo = async (y) => {
          await navPage.evaluate((v) => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            nav.scrollTop = v
          }, y)
          await navPage.waitForTimeout(240)
          return railScrollProbe()
        }
        /** 高亮那一片与"选中项"**相对 nav** 的位置（滚动之后必须仍然贴着） */
        const railPillGeom = () =>
          navPage.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
            const pill = nav.querySelector('.rail-pill')
            const act = nav.querySelector('span[data-active="true"]')
            if (!pill || !act) return null
            const pr = nav.getBoundingClientRect()
            const p = pill.getBoundingClientRect()
            const a = act.getBoundingClientRect()
            return {
              top: Math.round((p.top - pr.top) * 10) / 10,
              actTop: Math.round((a.top - pr.top) * 10) / 10,
              label: (act.closest('a')?.getAttribute('aria-label') ?? '').trim(),
            }
          })
        /** 反向对照要临时加一条样式；返回的把手用来撤掉 */
        const injectCss = (css) => navPage.addStyleTag({ content: css })
        const dropCss = async (h) => {
          if (h) await h.evaluate((el) => el.remove())
        }
        /** 把鼠标放到导航项那一块中间（滚轮要打在它身上） */
        const hoverRail = async () => {
          const b = await navPage.locator('nav[aria-label="主导航 · 桌面"]').boundingBox()
          if (!b) throw new Error(`${SROLL}：量不到桌面左栏导航那一块的位置`)
          await navPage.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
        }

        /* ---------- ① 矮视口（500px 高）：放不下 → **只有导航项那一块**自己可滚 ---------- */

        await navPage.setViewportSize({ width: 1440, height: 500 })
        await navGoto('/', 'super')
        await navPage.waitForTimeout(420)
        const short0 = await railScrollProbe()
        check(
          short0.over > 40 && short0.overflowY === 'auto',
          `${SROLL}：🔴 矮视口（500px 高）放不下 → 导航项那一块**自己**溢出可滚（overflow-y: auto）`,
          `溢出 ${short0.over}px · overflow-y=${short0.overflowY} · 滚动条占宽 ${short0.bar}px · 最后一项「${short0.lastLabel}」`,
        )

        /* ② 滚轮真的滚得动（触控板走同一条路），而且**滚得到底** */
        await hoverRail()
        await navPage.mouse.wheel(0, 1600)
        await navPage.waitForTimeout(420)
        const wheeled = await railScrollProbe()
        check(
          wheeled.scrollTop > 0,
          `${SROLL}：矮视口里**滚轮滚得动**导航项那一块（触控板同一条路；手指靠原生 overflow 滚）`,
          `滚一格之后 scrollTop = ${wheeled.scrollTop}px（可滚范围 ${wheeled.over}px）`,
        )
        check(
          wheeled.scrollTop >= wheeled.over - 1 && wheeled.lastFully && wheeled.lastLabel === '我的',
          `${SROLL}：🔴 矮视口**滚得到底**（最后一项「我的」完整露出来，没被裁掉）`,
          `scrollTop=${wheeled.scrollTop} / ${wheeled.over}px · 最后一项底边距 nav 底 ${wheeled.lastGap}px`,
        )

        /* ---------- ③ 交界处的过渡：渐隐跟着"哪一边还有内容"走 ---------- */

        const atEnd = await railScrollTo(short0.over + 400)
        check(
          atEnd.attr === 'top' && atEnd.firstA === 0 && atEnd.lastA === 1,
          `${SROLL}：🔴 滚到底 → **底部渐隐消失**（顶上还有内容，所以顶上仍有渐隐）`,
          `data-rail-scroll=${atEnd.attr} · 首端 alpha=${atEnd.firstA}（要 0）· 末端 alpha=${atEnd.lastA}（要 1）`,
        )
        const mid = await railScrollTo(Math.round(short0.over / 2))
        check(
          mid.attr === 'both' && mid.maskOn && mid.firstA === 0 && mid.lastA === 0,
          `${SROLL}：🔴 滚到中间 → **上下都有渐隐**（mask-image 两端 alpha 都是 0 —— 不是盖了一层纯色）`,
          `data-rail-scroll=${mid.attr} · 首端 alpha=${mid.firstA} · 末端 alpha=${mid.lastA} · mask=${short(mid.mask, 100)}`,
        )
        await shot(navPage, SROLL, '114-rail-scroll-mid')
        const atTop = await railScrollTo(0)
        check(
          atTop.attr === 'bottom' && atTop.firstA === 1 && atTop.lastA === 0,
          `${SROLL}：🔴 滚到顶 → **顶部渐隐消失**（底下还有内容，所以底下仍有渐隐）`,
          `data-rail-scroll=${atTop.attr} · 首端 alpha=${atTop.firstA}（要 1）· 末端 alpha=${atTop.lastA}（要 0）`,
        )

        /* ---------- ④ 底部那两行**固定在底部**（只有导航项滚） ---------- */

        const footAtTop = await railScrollTo(0)
        const footAtEnd = await railScrollTo(short0.over + 400)
        check(
          Math.abs(footAtEnd.footTopInRail - footAtTop.footTopInRail) <= 1 &&
            !footAtEnd.footInNav &&
            footAtEnd.footTopInRail >= footAtEnd.navBottomInRail - 1 &&
            footAtEnd.footBottomInRail >= 8 &&
            footAtEnd.footBottomInRail <= 24 &&
            footAtEnd.footText.includes('名学生'),
          `${SROLL}：🔴 底部那两行（已连接云端 / N 个班级）**固定在底部**（滚过之后一步没动）`,
          `相对侧栏 top：不滚 ${footAtTop.footTopInRail} / 滚到底 ${footAtEnd.footTopInRail}；在 nav 外面=${!footAtEnd.footInNav} · 离侧栏底 ${footAtEnd.footBottomInRail}px · 屏上「${short(footAtEnd.footText, 44)}」`,
        )

        /* ---------- ⑤ 🔴 滚动**没有弄坏高亮**（最容易坏的地方） ---------- */
        /* 先让选中项落在底部那几项里（「我的」），这样"滚到底"时它是看得见的 */
        await navGoto('/settings', 'super')
        await navPage.waitForTimeout(400)
        const pillTopState = await railScrollTo(0)
        const pillEndState = await railScrollTo(short0.over + 400)
        const pillAtEnd = await railPillGeom()
        check(
          pillAtEnd &&
            pillAtEnd.label === '我的' &&
            Math.abs(pillAtEnd.top - pillAtEnd.actTop) <= 1 &&
            pillEndState.scrollTop > 0,
          `${SROLL}：🔴 滚过之后高亮**仍然贴在选中项上**（那一片跟着内容一起滚，没被留在原地）`,
          pillAtEnd
            ? `滚到 ${pillEndState.scrollTop}px 时：高亮 top=${pillAtEnd.top} · 选中项「${pillAtEnd.label}」top=${pillAtEnd.actTop}`
            : '没量到高亮 / 选中项',
        )
        /* 滚过之后再点另一项：照旧**流过去 + 落准**（用户点名"这是最容易被弄坏的地方"）
           ⚠️ 点的是**倒数第二项**（超管 = 「行政管理」）：滚到底之后它一定完整可见；
              而最后一项「我的」正是当前选中项 —— 点它没有位移，采样只会是 0（假绿）。 */
        const clickName = await navPage.evaluate(() => {
          const items = [...document.querySelectorAll('nav[aria-label="主导航 · 桌面"] a[aria-label]')]
          return items[items.length - 2]?.getAttribute('aria-label') ?? ''
        })
        const pillBox = await navPage
          .locator(`nav[aria-label="主导航 · 桌面"] a[aria-label="${clickName}"]`)
          .boundingBox()
        if (!pillBox) throw new Error(`${SROLL}：滚到底之后量不到「${clickName}」的位置`)
        const polling = navPage.evaluate(async () => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          const pill = nav?.querySelector('.rail-pill')
          const tops = []
          let maxScale = 1
          for (let i = 0; i < 36; i++) {
            await new Promise((r) => requestAnimationFrame(r))
            if (!pill || !nav) continue
            tops.push(pill.getBoundingClientRect().top - nav.getBoundingClientRect().top)
            const raw = getComputedStyle(pill).transform
            if (raw && raw !== 'none') maxScale = Math.max(maxScale, new DOMMatrix(raw).d)
          }
          if (!tops.length) return { travel: 0, mids: 0, maxScale: 1 }
          const min = Math.min(...tops)
          const max = Math.max(...tops)
          return {
            travel: Math.round((max - min) * 10) / 10,
            mids: tops.filter((t) => t > min + 3 && t < max - 3).length,
            maxScale: Math.round(maxScale * 1000) / 1000,
          }
        })
        await navPage.mouse.click(pillBox.x + pillBox.width / 2, pillBox.y + pillBox.height / 2)
        const flung = await polling
        await navPage.waitForTimeout(900)
        const pillAfter = await railPillGeom()
        check(
          flung.mids > 2 &&
            clickName === '行政管理' &&
            pillAfter?.label === clickName &&
            Math.abs(pillAfter.top - pillAfter.actTop) <= 1,
          `${SROLL}：🔴 滚过之后再点另一项（「${clickName}」）→ 高亮**照旧流过去**（${flung.mids} 个中间位置）并**落准**`,
          pillAfter
            ? `逐帧位移 ${flung.travel}px / 中间位置 ${flung.mids} 个 · 落在「${pillAfter.label}」top=${pillAfter.top}（选中项 ${pillAfter.actTop}）`
            : '没量到',
          `滚动位置：${pillTopState.scrollTop} → ${pillEndState.scrollTop} / ${short0.over}px`,
        )

        /* ---------- ⑥ 高视口（1200px 高）：放得下 → **没有滚动条、也没有渐隐** ---------- */

        await navPage.setViewportSize({ width: 1440, height: 1200 })
        await navGoto('/', 'super')
        await navPage.waitForTimeout(420)
        const tall = await railScrollProbe()
        check(
          tall.over <= 1 && tall.bar <= 1,
          `${SROLL}：🔴 高视口（1200px 高）放得下 → **没有滚动条**（没有可滚的内容，也就不会有条）`,
          `溢出 ${tall.over}px · 滚动条占宽 ${tall.bar}px · overflow-y=${tall.overflowY}`,
        )
        /*
         * ⚠️ 别只靠 `bar`（`offsetWidth - clientWidth`）：这台机器上 Edge 用的是**叠层滚动条**
         *    （探针实测：矮视口溢出 294px 时 `bar` 也是 0）→ 只看它等于**恒绿**。
         *    所以"放得下时不可滚"要用**行为**判：滚轮打上去，`scrollTop` 必须一动不动。
         */
        await hoverRail()
        await navPage.mouse.wheel(0, 1600)
        await navPage.waitForTimeout(320)
        const tallWheel = await railScrollProbe()
        check(
          tallWheel.scrollTop === 0,
          `${SROLL}：🔴 高视口里滚轮**打不动**导航项那一块（放得下就不该能滚）`,
          `滚轮 1600px 之后 scrollTop = ${tallWheel.scrollTop}（溢出 ${tallWheel.over}px）`,
        )
        check(
          !tall.maskOn && tall.attr === 'none',
          `${SROLL}：🔴 高视口**没有渐隐**（放得下就不该有任何"下面还有"的暗示）`,
          `data-rail-scroll=${tall.attr} · mask 非 none = ${tall.maskOn} · mask=${short(tall.mask, 60)}`,
        )
        await shot(navPage, SROLL, '115-rail-fit-tall')
        const tallPill = await railPillGeom()
        check(
          Boolean(tallPill) && Math.abs(tallPill.top - tallPill.actTop) <= 1,
          `${SROLL}：高视口里高亮照旧落在选中项上（加滚动容器没有动高亮的算法）`,
          tallPill ? `高亮 top=${tallPill.top} · 选中项「${tallPill.label}」top=${tallPill.actTop}` : '没量到',
        )

        /* ---------- ⑦ 🧪 反向对照：渐隐必须**真的会收掉** ---------- */

        const fadeCtrl = await injectCss(
          '.rail-nav{mask-image:linear-gradient(180deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%) !important;-webkit-mask-image:linear-gradient(180deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%) !important}',
        )
        await navPage.waitForTimeout(220)
        const tallForced = await railScrollTo(0)
        check(
          tallForced.maskOn,
          `${SROLL}：🧪 反向对照 —— 强行把渐隐钉成"两头都渐隐"，上面"高视口没有渐隐"那条**必须**红`,
          `注入之后：mask 非 none = ${tallForced.maskOn} · 首端 alpha=${tallForced.firstA} · mask=${short(tallForced.mask, 80)}`,
        )
        await navPage.setViewportSize({ width: 1440, height: 500 })
        await navPage.waitForTimeout(300)
        const topForced = await railScrollTo(0)
        check(
          topForced.firstA === 0,
          `${SROLL}：🧪 反向对照 —— 同上，上面"滚到顶 → 顶部渐隐消失"那条**必须**红（真跑时首端 alpha 是 1）`,
          `注入之后滚到顶：首端 alpha=${topForced.firstA} · data-rail-scroll=${topForced.attr}`,
        )
        await dropCss(fadeCtrl)
        await navPage.waitForTimeout(240)
        const fadeBack = await railScrollTo(0)
        check(
          fadeBack.maskOn && fadeBack.attr === 'bottom' && fadeBack.firstA === 1 && fadeBack.lastA === 0,
          `${SROLL}：🧪 反向对照已撤（渐隐回到"滚到顶：只有底下渐隐"）`,
          `撤掉之后：mask 非 none = ${fadeBack.maskOn} · data-rail-scroll=${fadeBack.attr} · 首端 alpha=${fadeBack.firstA} · 末端 alpha=${fadeBack.lastA}`,
        )

        /* 🧪 反向对照：关掉滚动容器 → "滚轮能滚 / 滚得到底"两条**必须**红 */
        const ovCtrl = await injectCss('.rail-nav{overflow-y:hidden !important}')
        await hoverRail()
        await navPage.mouse.wheel(0, 1600)
        await navPage.waitForTimeout(400)
        const hiddenWheel = await railScrollProbe()
        check(
          hiddenWheel.overflowY === 'hidden' && hiddenWheel.scrollTop === 0 && !hiddenWheel.lastFully,
          `${SROLL}：🧪 反向对照 —— 改成 overflow-y: hidden，上面"滚轮能滚 + 滚得到底"两条**必须**红`,
          `overflow-y=${hiddenWheel.overflowY} · 滚轮之后 scrollTop=${hiddenWheel.scrollTop} · 最后一项完整可见=${hiddenWheel.lastFully}`,
        )
        await dropCss(ovCtrl)
        await navPage.waitForTimeout(200)

        /* 🧪 反向对照：把高亮那一片的 `top` 钉在 0（= 位置算错）→ "滚过之后仍贴着选中项"**必须**红 */
        const pillCtrl = await injectCss('.rail-pill{top:0 !important}')
        await railScrollTo(0)
        const pillBroken = await railScrollTo(short0.over + 400).then(() => railPillGeom())
        check(
          Boolean(pillBroken) && Math.abs(pillBroken.top - pillBroken.actTop) > 1,
          `${SROLL}：🧪 反向对照 —— 把高亮那一片的 top 钉在 0，上面"滚过之后仍贴着选中项"那条**必须**红`,
          pillBroken
            ? `钉住之后：高亮 top=${pillBroken.top} · 选中项「${pillBroken.label}」top=${pillBroken.actTop}`
            : '没量到',
        )
        await dropCss(pillCtrl)
        await navPage.waitForTimeout(200)

        /* 🧪 反向对照：把底部那两行**挪进滚动容器**（= 这一轮最容易犯的错）
              → "在 nav 外面 / 滚过之后位置没变"两条**必须**红 */
        const movedFoot = await navPage.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="主导航 · 桌面"]')
          const foot = document.querySelector('[data-rail-foot]')
          nav.appendChild(foot)
          return { inNav: nav.contains(foot) }
        })
        const moved0 = await railScrollTo(0)
        const moved1 = await railScrollTo(short0.over + 400)
        check(
          movedFoot.inNav &&
            moved1.footInNav &&
            Math.abs(moved1.footTopInRail - moved0.footTopInRail) > 2,
          `${SROLL}：🧪 反向对照 —— 把底部那两行挪进滚动容器，上面"固定不动"那条**必须**红`,
          `挪进去之后：在 nav 里=${moved1.footInNav} · 不滚 top=${moved0.footTopInRail} → 滚到底 top=${moved1.footTopInRail}`,
        )
        await navPage.evaluate(() => {
          const rail = document.querySelector('.floating-rail')
          const foot = document.querySelector('[data-rail-foot]')
          rail.appendChild(foot) /* 挪回 nav 之后 = 侧栏末尾 */
        })
        await navPage.waitForTimeout(240)
        const footRestored = await railScrollTo(short0.over + 400)
        check(
          !footRestored.footInNav &&
            Math.abs(footRestored.footTopInRail - footAtTop.footTopInRail) <= 1 &&
            footRestored.footText.includes('名学生'),
          `${SROLL}：🧪 反向对照已复原（底部那两行回到 nav 外面、位置照旧）`,
          `复原后：在 nav 里=${footRestored.footInNav} · 相对侧栏 top=${footRestored.footTopInRail}（复原前 ${footAtTop.footTopInRail}）· 屏上「${short(footRestored.footText, 40)}」`,
        )

        /* 这一节跑完把视口交回默认（下一步是移动端 414px，它自己会设） */
        await navPage.setViewportSize({ width: 1440, height: 1000 })
        await navPage.waitForTimeout(200)
      })

      /* ---------- B2/B3：移动端胶囊 + 展开层 ---------- */

      await step(SNAV, async () => {
        await navPage.setViewportSize({ width: 414, height: 880 })
        await navGoto('/', 'super')
        const pill = await navPage.evaluate(() =>
          [...document.querySelectorAll('nav[aria-label="主导航"] a[aria-label]')].map((a) =>
            a.getAttribute('aria-label'),
          ),
        )
        check(
          JSON.stringify(pill) === JSON.stringify(['工作台', '作业', '我的']),
          `${SNAV}：移动端胶囊**恒为**「工作台 / 作业 / 我的」（PIN_KEYS 不随身份变 —— N1）`,
          `实际 ${pill.length} 格：${pill.join(' / ') || '(空)'}`,
        )
        const sheet = await sheetLabels()
        check(sheet.open, `${SNAV}：点圆按钮弹出「更多入口」`, `open=${sheet.open}`)
        /*
         * 展开层 = 左栏 − 胶囊那三项（N3）。🆕 2026-10-01 起**超管比任课教师多一项**：
         * 「行政管理」（`/manage`）对超管 / 教务处 / 年级主任 / 办公室主任摆，
         * 对班主任与任课教师不摆 —— 所以两份清单：
         *   · 超管（这里）：`['班级','考试','错题集','日程表','通知','行政管理']`；
         *   · 任课教师（下一条 step）：那五项。
         * ⚠️ 比的是**集合相等**：多一项（比如不小心把「呼叫记录」塞进来）也红。
         */
        const wantSheet = ['班级', '考试', '错题集', '日程表', '通知', '行政管理']
        check(
          JSON.stringify(sheet.items) === JSON.stringify(wantSheet),
          `${SNAV}：**超管**的展开层 = 左栏减去胶囊那三项（N3：COLLAPSED 是可见差集，自动的）+「行政管理」`,
          `实际：${sheet.items.join(' / ') || '(空)'}`,
          `期望：${wantSheet.join(' / ')}`,
        )
        /*
         * 2026-09-28：用户拍板**删掉**展开层底部那行说明
         * （原文「工作台 / 作业 / 我的 在底部那颗胶囊里；这一层装的是其余入口。」，
         * 是按实际胶囊项用 `pinnedLabel()` 动态拼的 —— 那段逻辑也一起删了）。
         * 所以这条断言**反过来钉**"它不在"：删掉的东西被谁加回来，这里立刻红。
         * ⚠️ 只查 `sheet.body`（那一层的 innerText），不要把范围放大到整页 ——
         *    `pinnedLabel` 式的文案在别处本来就可能出现。
         */
        check(
          !sheet.body.includes('在底部那颗胶囊里'),
          `${SNAV}：展开层底部那句胶囊说明**已删**（2026-09-28 用户拍板，别再加回来）`,
          short(sheet.body.slice(-90), 120),
        )
        await navPage.getByRole('button', { name: '展开更多入口' }).click()
        await navPage.waitForTimeout(320)
        await navPage.screenshot({ path: join(OUT, '87-nav-role-super-sheet.png') })
        written.push('87-nav-role-super-sheet.png')
        console.log('     📷 87-nav-role-super-sheet.png')
        await navPage.keyboard.press('Escape')
        await navPage.waitForTimeout(220)
      })

      await step(SNAV, async () => {
        await navGoto('/', 'teacher')
        const sheet = await sheetLabels()
        check(
          JSON.stringify(sheet.items) === JSON.stringify(['班级', '考试', '错题集', '日程表', '通知']),
          `${SNAV}：**任课教师**的展开层只有那五项（比超管**少**「行政管理」—— 判据是他够不着那三张卡）`,
          `实际：${sheet.items.join(' / ') || '(空)'}`,
        )
        check(
          !sheet.body.includes('年级管理') && !sheet.body.includes('平台运维') && !sheet.body.includes('行政管理'),
          `${SNAV}：任课教师的展开层里**没有**「年级管理」「平台运维」「行政管理」`,
          sheet.body.includes('年级管理') || sheet.body.includes('平台运维') || sheet.body.includes('行政管理')
            ? short(sheet.body, 140)
            : '三个都不在',
        )
      })

      /* ---------- B4：`我的`页那几行（**该显示的时候真的显示**） ---------- */

      await step(SNAV, async () => {
        await navPage.setViewportSize({ width: 1440, height: 1000 })
        await navGoto('/settings', 'teacher')
        const r = await settingsRows()
        check(
          !r.manage,
          `${SNAV}：**任课教师**的「我的」页**没有**「行政管理」那一行（判据含 isRemote —— 本地演示模式下它不显示）`,
          r.manage ? short(r.body, 140) : '没有那一行',
        )
        check(r.files && r.schedule, `${SNAV}：但「传到教室大屏」「日程表」两行照旧在`, `files=${r.files} schedule=${r.schedule}`)
      })

      await step(SNAV, async () => {
        await navGoto('/settings', 'admin')
        const r = await settingsRows()
        check(
          r.files && r.schedule,
          `${SNAV}：教导处的「我的」页上「传到教室大屏」「日程表」两行在（读的是同一张表）`,
          `files=${r.files} schedule=${r.schedule}`,
        )
        /*
         * 🔴 **2026-10-01「行政管理」轮改了这里的两条**，逐条说明：
         *
         * ① `!r.manage`（原来是 `!r.accounts`）：教导处的「我的」页上
         *    **现在没有「行政管理」那一行** —— 「年级管理 / 档案管理 / 教师管理」
         *    那三行都搬去了 `/manage` 那一页，所以这一页**只剩「平台运维」那一行**。
         *    ⚠️ 与「教师账号」原来那条同款，它**在演示模式下本来也显不出来**
         *    （判据是 `isRemote && entryVisible(...)`：`isRemote` 那一半不是身份判据，
         *    是"这个功能本地没有服务端"）。所以这一条钉的是"**那半个判据还在**"，
         *    "身份那一半"由 `nav-checks.mjs` 的 A11 逐档钉住。
         * ② **新增两条反向断言**（`!r.archive` / `!r.accountsRow`）：
         *    「提档与毕业」与「教师账号」那两行**已经不在「我的」页上了** ——
         *    谁把它们加回来，这里立刻红。这正是用户要求的"别留两份入口"的机器版。
         *    （它们现在在 `/manage` 那一页，见下面新加的那一节。）
         *    ⚠️ **年级管理那一条不能用这种反向断言**：它那张卡的副标题
         *    「开学准备：录名单…」**与迁走的原文一字不改**，而 `/manage` 上它照旧在 ——
         *    所以"查不到那句话"这件事在「我的」页上**说明不了问题**（那句话在别处合法存在）。
         *    它由第 ①/② 两条（「我的」页上只剩「平台运维」那一行）与 D2 那 35 行钉住。
         */
        check(
          !r.manage,
          `${SNAV}：教导处的「我的」页上**没有**「行政管理」那一行（它已经进了左侧导航；本地演示模式下这一行也不显示）`,
          r.manage ? short(r.body, 140) : '没有那一行（符合预期）',
        )
        check(
          !r.archive && !r.accountsRow,
          `${SNAV}：🔴 「提档与毕业（档案管理）」与「教师账号（教师管理）」那两行**都不在「我的」页上了**（搬去了 /manage）`,
          `archive=${r.archive} accountsRow=${r.accountsRow}`,
        )
        check(
          new URL(navPage.url()).pathname === '/settings',
          `${SNAV}：教导处停在 /settings（没被 Guard 送走）`,
          new URL(navPage.url()).pathname,
        )
        await shot(navPage, SNAV, '88-nav-role-settings-admin', { full: true })
      })

      /* ---------- B4′：🆕「行政管理」页 `/manage`（三张卡各自跳对页面） ---------- */

      await step(SNAV, async () => {
        /*
         * 🔴 这是本轮的主交付（用户 2026-10-01：「把图三里面的功能从我的里面提出来，
         *    单独设计制作一个行政管理页面，把这三个功能放里面」）。这一节钉四件事：
         *      ① 教导处打得开这一页、页面上是**那三张卡**（标题与副标题照迁移前那一字不改）；
         *      ② **三张卡各自跳对页面**（真界面断言：点一下、看落点）；
         *      ③ 这一页上**没有**「平台运维」——它与 `/admin` 那条线不是一回事；
         *      ④ 反向对照：任课教师**看不见这个入口**（上面 B1 已钉），而这里再钉一次
         *        "手打 `/manage` 也进得来、给的是那句说明"（藏入口不是安全边界）。
         *
         * ⚠️ **本地演示模式只有两张卡**：「教师管理」（`/accounts`）要服务端
         *    `functions/api/teacher-account.ts`，判据是 `isRemote && entryVisible(...)`
         *    —— 所以它在这一模式下**不摆**（与迁移前「我的」页那一行同款，不是身份问题）。
         *    这一条限制写在本轮报告里；它**不是**"少做了一张卡"。
         */
        await navGoto('/manage', 'admin')
        const info = await pageInfo(navPage)
        check(
          new URL(navPage.url()).pathname === '/manage',
          `${SNAV}：教导处打开 /manage 停在 /manage（不跳登录页、不白屏）`,
          `停在 ${info.url}`,
        )
        const cards = await navPage.evaluate(() =>
          [...document.querySelectorAll('[data-manage-card]')].map((b) => ({
            key: b.getAttribute('data-manage-card'),
            text: (b.innerText ?? '').replace(/\s+/g, ' ').trim(),
          })),
        )
        check(
          cards.map((c) => c.key).join(',') === '/grades,/grades/promote,/accounts',
          `${SNAV}：/manage 上摆着的卡 = 年级管理 + 档案管理 + 教师管理（🔴 这一页**三张卡都摆**，含要服务端的那一张）`,
          cards.length ? cards.map((c) => `${c.key}「${short(c.text, 40)}」`).join(' | ') : '(一张卡都没有)',
        )
        check(
          cards.some((c) => c.text.includes('年级管理') && c.text.includes('开学准备：录名单')),
          `${SNAV}：第一张卡是「年级管理」，副标题与迁移前**一字不改**`,
          short(cards[0]?.text ?? '', 80),
        )
        check(
          cards.some((c) => c.text.includes('档案管理') && c.text.includes('学年提档（高一→高二→高三）')),
          `${SNAV}：第二张卡是「**档案管理**」（原「提档与毕业」改名），副标题照旧`,
          short(cards[1]?.text ?? '', 80),
        )
        check(
          !info.body.includes('只读体检屏') && !info.body.includes('平台运维'),
          `${SNAV}：/manage 上**没有**「平台运维」（它是超管专属的另一条线，仍留在「我的」页）`,
          info.body.includes('平台运维') ? short(info.body, 120) : '不在',
        )
        await shot(navPage, SNAV, '104-manage-admin', { full: true })

        /* ② 真界面：点第一张卡 → /grades */
        await navPage.click('[data-manage-card="/grades"]')
        await navPage.waitForTimeout(500)
        check(
          new URL(navPage.url()).pathname === '/grades',
          `${SNAV}：「年级管理」那张卡 → **真的跳到 /grades**`,
          new URL(navPage.url()).pathname,
        )
        await navPage.goBack()
        await navPage.waitForTimeout(400)
        /* ③ 真界面：点第二张卡 → /grades/promote */
        await navPage.click('[data-manage-card="/grades/promote"]')
        await navPage.waitForTimeout(500)
        check(
          new URL(navPage.url()).pathname === '/grades/promote',
          `${SNAV}：「档案管理」那张卡 → **真的跳到 /grades/promote**（提档与毕业那一页）`,
          new URL(navPage.url()).pathname,
        )
        /*
         * ④ 第三张卡（教师管理 → `/accounts`）也**照常跳**（它跳的是那条真路由）；
         *    但**本地模式下那一页上没有服务端**（`/api/teacher-account` 不在），
         *    所以它渲染的是"这一页现在打不开"，而**不是**建号表单 ——
         *    这一条把"卡片跳对了"与"本地没有服务端"两件事分开钉（别混成一句）。
         */
        await navPage.goBack()
        await navPage.waitForTimeout(400)
        await navPage.click('[data-manage-card="/accounts"]')
        await navPage.waitForTimeout(500)
        check(
          new URL(navPage.url()).pathname === '/accounts',
          `${SNAV}：「教师管理」那张卡 → **真的跳到 /accounts**（教师账号那一页）`,
          new URL(navPage.url()).pathname,
        )
        const acctBody = await bodyText(navPage)
        check(
          !acctBody.includes('建号（带学科）'),
          `${SNAV}：但本地演示模式下 /accounts **拿不到服务端**（渲染的是"打不开"那张面板，不是建号表单）`,
          short(acctBody, 120),
        )
      })

      await step(SNAV, async () => {
        /*
         * ④ 反向对照（§18.3：两个坏法方向相反，各要一条）：
         *    任课教师**看不见**那个入口（B1 的 `RAIL_TEACHER` 已钉），
         *    而这里钉的是另一半 —— **手打 `/manage` 进得来**，页面上给一句说人话的说明，
         *    不是白屏、也不跳登录页。藏入口不是安全边界，这一条正是它的机器版。
         */
        await navGoto('/manage', 'teacher')
        const info = await pageInfo(navPage)
        check(
          new URL(navPage.url()).pathname === '/manage',
          `${SNAV}：任课教师手打 /manage **正常打开**（不跳登录页、不白屏 —— 藏入口不是安全边界）`,
          `停在 ${info.url}`,
        )
        const cards = await navPage.evaluate(
          () => document.querySelectorAll('[data-manage-card]').length,
        )
        check(cards === 0, `${SNAV}：任课教师在 /manage 上**一张卡都摆不出来**（三张卡都不是他的）`, `${cards} 张卡`)
        check(
          info.body.includes('看不到这一页的内容'),
          `${SNAV}：而且给的是**一句说明**（不是空白页、不是假数据）`,
          short(info.body, 120),
        )
        await shot(navPage, SNAV, '105-manage-teacher', { full: true })
        /* 反向对照：同一个地址，教导处看得到卡、任课教师看不到 —— 两边的差就在这一条上 */
        await navGoto('/manage', 'admin')
        /* E6：卡片跟着 ?as= 的身份走 —— 等它们**真的摆上来**再数（同 expectPage 的
           markers 等待：只等正向、超时照常往下走让断言去红）。这条在 2026-10-02 的
           全量 shots 里红过一次（教导处 0 张）—— 卡片渲染晚于兜底退场的那一拍。 */
        let adminCards = 0
        {
          const t0 = Date.now()
          for (;;) {
            adminCards = await navPage.evaluate(() => document.querySelectorAll('[data-manage-card]').length)
            if (adminCards > 0 || Date.now() - t0 > 8000) break
            await navPage.waitForTimeout(150)
          }
        }
        check(
          adminCards > 0,
          `${SNAV}：**同一条地址**，教导处看得到卡（与上一条"任课教师 0 张"构成反向对照）`,
          `教导处 ${adminCards} 张`,
        )
      })

      /* ---------- B5：E 档的验收 —— 手打 URL 能开、不白屏、不跳登录 ---------- */

      await step(SNAV, async () => {
        /*
         * E 档的验收（方案 §5.3 B5 / §0.1）：**手打 URL 能开、不白屏、不跳登录页**。
         * ⚠️ 演示模式下 `/accounts` 上那句文案是「**这一页现在打不开**／登录已过期」
         *    —— 那是服务端 403 那条路在本地模式下的样子（本地没有
         *    `functions/api/teacher-account.ts`）。所以这里断言的是
         *    "**渲染出了一张说人话的面板**"，**不是**某一句特定文案：
         *    方案 G1 建议把 403 文案换成正常说明（N6），但那要改 `TeacherAccounts.tsx`
         *    ——**不在本轮的允许改动清单里**，所以本轮只钉现状 + 在报告里留档。
         */
        for (const path of ['/accounts', '/files', '/calls']) {
          await navGoto(path, 'teacher')
          const info = await pageInfo(navPage)
          check(
            new URL(navPage.url()).pathname === path,
            `${SNAV}：任课教师手打 ${path} **正常打开**（不跳登录页、不白屏）`,
            `停在 ${info.url}`,
          )
          check(info.body.length > 40, `${SNAV}：${path} 真的渲染出了内容`, `${info.body.length} 字符`)
          check(
            info.h1.length > 0 || info.body.includes('这一页') || info.body.includes('教室端文件'),
            `${SNAV}：${path} 上是一张**说人话的面板**（有页面标题或明确说明），不是空白页`,
            short(info.body, 120),
          )
        }
      })

      /* ---------- C1/C2：教室端账号**进不了教师端**（G6，今天零覆盖的那一条） ---------- */

      await step(SNAV, async () => {
        /*
         * 🔴 这一节补的就是方案 §三 G6 那句"**今天一条自动断言都没有**"：
         *    `accountKind` 只在远程模式由 `remote.loadClassroomAccount()` 决定，
         *    而本脚本跑演示模式 → 恒为 'teacher'，所以"教室端被 Guard 送回去"这件事
         *    以前**没有任何自动断言**。现在用同一个 DEV 钩子的 `?kind=classroom` 注入。
         */
        for (const path of ['/settings', '/wrong', '/accounts', '/exams', '/', '/manage']) {
          await navGoto(`${path}?kind=classroom`, 'teacher')
          const u = new URL(navPage.url())
          check(
            u.pathname === '/classroom',
            `${SNAV}：教室端账号手打 ${path} → **落在 /classroom**（G6 / C1-C2）`,
            `停在 ${u.pathname}`,
          )
        }
        const b = await bodyText(navPage)
        /*
         * 🔴 "跳过去了"不算数 —— 还要证明**教师端那份数据一个字都没渲染出来**。
         *
         * ⚠️ 判据要选对：这台教室端账号**自己那个班**的名字与学生姓名**本来就该在屏上**
         *    （那正是这块屏的用途，`visible_class_ids()` 里 classroom_accounts 那一支）。
         *    所以这里查的是**别的班**的名字：泄漏教师端上下文时，屏上会出现它。
         *    （第一版查了"演示数据的第一个班"，而那个班**就是**教室端自己那个班 —— 假红。）
         */
        const own = DEMO_CLASSES[0]
        const other = DEMO_CLASSES[1]
        check(
          b.includes(own.name),
          `${SNAV}：先自证"这一屏真的渲染了班级内容" —— 本班「${own.name}」在屏上`,
          b.includes(own.name) ? '在' : short(b, 120),
          '缺了它的话，下面那条"别班不在"就是恒真的',
        )
        /*
         * ⚠️ **不能查班名**：教室端那一页的**班名选择器**里有「高二(7)班」
         *    （`Classroom.tsx` 的班级下拉；教室端账号换台机器时用它认班），
         *    所以"屏上出现别班班名"是**正常**的 —— 第一版就栽在这里（假红）。
         *    真正要钉的是"**别班的名单数据**没渲染出来"。
         *
         * 🔴 判据必须是"**同一段文本里既有别班班名、又有人数**"，而且**长度要短**：
         *    否则 `body.innerText` 那个大串会同时命中"高二(7)班"（选择器）
         *    和别处的"45 人"（本班统计），又变成假红（第二版栽在这里）。
         *    教室端那一页上，任何**关于某个班的人数**都必然与那个班的班名紧邻，
         *    所以"短文本 + 班名 + 人数"是这件事的正确判据。
         */
        const rosterLine = await navPage.evaluate((cls) => {
          const candidates = [...document.querySelectorAll('option,div,span,li,td,section')]
            .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 0 && t.length <= 60)
          return candidates.find((t) => t.includes(cls) && /(\d+)\s*(人|名)/.test(t)) ?? null
        }, other.name)
        check(
          rosterLine === null,
          `${SNAV}：而且「${other.name}」**没有任何名单/人数数据**渲染出来（只作为选择器里的一个选项出现）`,
          rosterLine === null ? '没有"别班 + 人数"的短文本' : `读到「${short(rosterLine, 90)}」`,
        )
        const otherNames = new Set(other.students.map((s) => s.name))
        const leakedNames = [...otherNames].filter((n) => b.includes(n))
        check(
          leakedNames.length <= 2,
          `${SNAV}：另一个班的姓名基本不出现（两个演示班可能有重名，所以阈值是"≤2 个"）`,
          leakedNames.length ? `出现 ${leakedNames.length} 个：${leakedNames.join('、')}` : '一个都没有',
        )
        check(
          b.includes('这个班的课') || b.includes('正在上课'),
          `${SNAV}：落在教室端那一屏（不是登录页、也不可能是教师端）`,
          short(b, 120),
        )
      })

      await step(SNAV, async () => {
        /* 反向对照（§十七·补 补.2 的原话："别把真正的教师一起挡了"） */
        for (const path of ['/settings', '/wrong', '/']) {
          await navGoto(path, 'teacher')
          const u = new URL(navPage.url())
          check(
            u.pathname === path,
            `${SNAV}：**反向对照** —— 真老师手打 ${path} 照常打开（教室端那一支没有误伤教师）`,
            `停在 ${u.pathname}`,
          )
        }
      })

      /* ---------- C4：设备被标成教室端时的 /settings（G8 的"能解开"那一半） ---------- */

      await step(SNAV, async () => {
        await navPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await navPage.evaluate((state) => {
          localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
          // 🔴 这一行就是这一段的前提：这台机器"被标成教室端"（与学生改网址那个场景同一个标记）
          localStorage.setItem('shugao.deviceRole', 'classroom')
        }, TEACHER_STATE.state)
        await navPage.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
        await navPage.waitForTimeout(420)
        check(
          new URL(navPage.url()).pathname === '/login',
          `${SNAV}：设备被标成教室端时，教师账号打开 /settings → **被送去 /login**（G8 的现状）`,
          `停在 ${new URL(navPage.url()).pathname}`,
        )
        /* 登录一次 → 设备角色改回教师端 → 回到刚才那一页（`Login.tsx` 的 state.from） */
        await navPage.getByLabel('账号 / 工号').fill('王老师')
        await navPage.getByLabel('密码').fill('demo')
        await navPage.getByRole('button', { name: '进入平台' }).click()
        await navPage.waitForTimeout(900)
        const after = new URL(navPage.url()).pathname
        check(
          after === '/settings',
          `${SNAV}：**登一次就解得开** —— 落回 /settings（G8 的另一半，别再让人以为被锁死了）`,
          `停在 ${after}`,
        )
        const role = await navPage.evaluate(() => localStorage.getItem('shugao.deviceRole'))
        check(role === 'teacher', `${SNAV}：而且设备角色已经改回 teacher（不然后面每次都被踢）`, `deviceRole=${role}`)
      })

      await ctxNav.close()

      /* ================= 情绪价值：把时钟拨到不同时段 ================= */

      /*
       * ⚠️ 从这里开始每一步都**拨表**，所以每次导航都要给 `date:` 核对屏上日期。
       *    这就是原来那条"靠后注册的 initScript 覆盖先注册的"实现细节的替代品：
       *    顺序错了 / 桩没了，这一步立刻红。
       */
      const D0917 = '9 月 17 日 · 周四'
      const S42 = '42–43 早上欢迎弹窗（周四 07:32）'
      await ctx.clock.setFixedTime(new Date('2026-09-17T07:32:00'))
      await goto(page, S42, '/', {
        markers: ['早上好'],
        date: D0917,
        // 早上 6:30–9:00 第一次打开：欢迎弹窗**本该**在（这一步就是在验它）
        allowModal: '早上好，王老师',
      })
      await step(S42, async () => {
        const info = await pageInfo(page)
        check(
          info.modalOpen,
          '早上 6:30–9:00 第一次打开，欢迎弹窗真的弹出来了',
          info.modalOpen ? `开着 .modal（含「今天要批的作业」：${info.body.includes('今天要批的作业')}）` : short(info.body, 120),
        )
        /*
         * 欢迎弹窗「今天要批的作业」那一行也是题数的一个显示点（极简档案**不写题数**）。
         * 演示数据里这份待办是 `a-demo-4`（普通模式，7 题），所以断言它**照旧**写题数；
         * 同时确认整屏没有「6 题」那种只有极简档案才会写出来的写法
         * （两条都会在"顺手把题数到处都藏了"时变红）。
         */
        check(
          /7 题/.test(info.modalText),
          `${S42}：欢迎弹窗「今天要批的作业」照旧显示普通档案的题数（7 题）`,
          info.modalOpen ? `弹窗文案：${short(info.modalText, 130)}` : short(info.body, 120),
        )
        check(
          !/6 题(?![份个])/.test(info.modalText),
          `${S42}：欢迎弹窗里不出现极简档案那个没有意义的「6 题」`,
          info.modalOpen ? short(info.modalText, 130) : short(info.body, 120),
        )
        /*
         * 🆕 2026-10-07 F3：🔴 **弹窗里只列"待批改"的**（`collected`），**不含待收缴**（`open`）。
         *
         * 三句话互相咬住，缺一条都留着"混进来"的口子：
         *   ① 「今天要批的作业」那一格数字 == **可见待批改份数**（演示种子：只有 `a-demo-4` 一份）；
         *   ② 待批改那份的标题 `作业23…` 在弹窗里；
         *   ③ **待收缴**那份（`a-demo-2` = 作业22）**不在** —— 它还没收上来，没有东西可批。
         * ⚠️ 期望值 `1` 是从**演示种子**数出来的（5 份档案里 2 份待收缴 / 2 份已批改 / 1 份待批改）——
         *    与「11 作业列表」那条 `5 份档案 · 2 份待收缴` 是同一份数据的两个显示点。
         * 🧪 反向对照（实测）：把弹窗那处的口径换成 `pendingForMe()` 的**整体**结果
         *    （它含待收缴）→ 这里变成 3、而 `作业22` 也在弹窗里 → 这一条红。
         */
        const pendBlock = info.modalText.match(/今天要批的作业\s*(\d+)/)
        check(
          pendBlock?.[1] === '1',
          `${S42}：🔴 「今天要批的作业」只数**待批改**（演示里 1 份；那 2 份待收缴不算"要批的"）`,
          `弹窗里那一格 = ${pendBlock?.[1] ?? '(没读到)'}\u3000· 弹窗文案：${short(info.modalText, 120)}`,
        )
        check(
          info.modalText.includes('作业23') && !info.modalText.includes('作业22'),
          `${S42}：🔴 待批改那份（作业23）在弹窗里；**待收缴那份（作业22）不在**（收都没收上来，没有东西可批）`,
          `含作业23=${info.modalText.includes('作业23')} · 含作业22=${info.modalText.includes('作业22')}`,
        )
        /*
         * 🆕 2026-09-29 用户拍板：**问候卡上的话换成新的一批**（`lib/mood.ts` 的 `GREETINGS`）。
         *
         * 判据有**两个方向**，缺一不可：
         *   ① 屏上那句问候**确实来自新的 `GREETINGS`**（按同一天从源码里算出来再比）；
         *   ② **反向断言**：上一批那几句 AI 味的话**一句都不许再出现**。
         *      只钉①的话，把旧文案加回去照样绿；只钉②的话，问候整个没了也绿。
         */
        const { GREETINGS, pickGreeting, dayIndex } = await import('../src/lib/mood.ts')
        /* ⚠️ 同上：这一步的假时钟是 2026-09-17，**不能**用脚本进程真实的今天 */
        const cardDay = new Date(2026, 8, 17, 7, 32, 0)
        const wantGreeting =
          GREETINGS[((dayIndex(cardDay) % GREETINGS.length) + GREETINGS.length) % GREETINGS.length]
        check(
          pickGreeting(cardDay) === wantGreeting && info.modalText.includes(wantGreeting),
          `${S42}：问候卡上的话来自**新的一批**（\`GREETINGS\` 第 ${GREETINGS.length} 条里的当天那一句）`,
          `当天期望：「${wantGreeting}」`,
        )
        const AI_OLD = [
          '愿今天的你，被学生温柔以待。',
          '你不是在完成指标，你在陪人长大。',
          '你教的不只是知识，还有怎么当大人。',
          '你在做的，是看不见回报的那种好。',
          '愿今天的你，被自己温柔对待。',
          '新的一天，愿你从心里觉得——还不错。',
          '你正在做一件很慢、很重要的事。',
          '你是很多孩子人生里，稳定出现的大人。',
        ]
        const stillThere = AI_OLD.filter((s) => info.body.includes(s) || info.modalText.includes(s))
        check(
          stillThere.length === 0,
          `${S42}：上一批那些 AI 味的话**一句都不在**（用户点名要换掉的就是它们）`,
          stillThere.length ? `还在：${stillThere.join('、')}` : `查了 ${AI_OLD.length} 句，一句都没有`,
        )
        await page.waitForTimeout(900)
      })
      await shotRaw(page, S42, '42-morning-welcome')
      await step(S42, async () => {
        await page.getByRole('button', { name: '开始今天' }).click()
      })
      await shot(page, S42, '43-morning-workbench', {
        full: true,
        wait: 500,
        expect: { url: '/', markers: ['今日待办'] },
      })
      await step(S42, async () => {
        /*
         * 工作台「今日待办」那一行也是题数的一个显示点：
         * 普通模式写「N 题待批改」，极简模式**不写题数**（改写成「应交 N 人」）。
         * 这一屏的待办只有 `a-demo-4`（普通模式，seed 的 7 题）——
         * 所以这条钉的是**普通那一半照旧**（极简那一半在临时探针里验过，
         * 演示种子里没有"待批改"状态的极简档案）。
         */
        const body = await bodyText(page)
        check(
          /7 题待批改/.test(body),
          `${S42}：工作台待办那行写着「7 题待批改」（普通档案的题数照旧显示）`,
          short(body.match(/.{0,40}7 题待批改.{0,10}/)?.[0] ?? body, 120),
        )
        check(
          !/6 题(?![份个])/.test(body),
          `${S42}：工作台整页找不到极简档案那个没有意义的「6 题」`,
          short(body.match(/.{0,40}6 题(?![份个]).{0,10}/)?.[0] ?? body, 120),
        )
      })
      await step(S42, async () => {
        const info = await pageInfo(page)
        check(!info.modalOpen, '点「开始今天」之后弹窗关掉了', info.modalOpen ? '还开着' : '已关闭')
      })

      const S44 = '44 周末（周六 15:20）'
      await ctx.clock.setFixedTime(new Date('2026-09-19T15:20:00'))
      await goto(page, S44, '/', {
        markers: ['今天是周末噢，好好休息吧。'],
        date: D0919,
      })
      await shot(page, S44, '44-weekend', { full: true, wait: 600 })

      const S45 = '45 夜深（周四 23:40）'
      await ctx.clock.setFixedTime(new Date('2026-09-17T23:40:00'))
      await goto(page, S45, '/', { markers: ['夜深了'], date: D0917 })
      await shot(page, S45, '45-late-night', { full: true, wait: 600 })

      const S46 = '46–47 今天完成（周四 19:40）'
      await ctx.clock.setFixedTime(new Date('2026-09-17T19:40:00'))
      await step(S46, async () => {
        await page.goto(`${BASE}${GR}`, { waitUntil: 'networkidle' })
        await expectPage(page, S46, { url: GR, markers: grMarkers })
        await page.getByRole('button', { name: '完成批改' }).click()
        await page.getByRole('button', { name: /确认完成批改/ }).click()
        await page.getByRole('button', { name: '确认完成批改' }).click()
        await page.waitForTimeout(1100)
      })
      await step(S46, async () => {
        const info = await pageInfo(page)
        check(
          info.modalOpen,
          '批完最后一份 → 「今天完成」的弹窗出现了',
          info.modalOpen ? '开着 .modal' : short(info.body, 120),
        )
        await page.waitForTimeout(1100)
      })
      await shotRaw(page, S46, '46-day-done')
      await step(S46, async () => {
        await page.getByRole('button', { name: '好的' }).click()
        await page.waitForTimeout(400)
        // 站内跳转回工作台（不刷新，保住刚批完的状态）
        await page.getByRole('link', { name: '工作台' }).click()
        await page.waitForURL(`${BASE}/`, { timeout: 8000 })
        await page.waitForTimeout(700)
      })
      await shot(page, S46, '47-day-done-banner', {
        full: true,
        wait: 0,
        expect: {
          url: '/',
          // 屏上那句首栏文案（不是弹窗里那句）—— 完成态在工作台要留到 23:00
          markers: ['今天的工作已经全部完成，好好休息一下吧。'],
          date: D0917,
        },
      })

      /* ================= 法定假期与调休（数据来自国办发明电〔2025〕7号） ================= */

      /*
       * 2026-09-20 是周日，但按官方通知是「国庆调休上班」→ 必须按工作日对待。
       *
       * ⚠️ 「今天是调休上班日，按…」那句话只有**教室端**有（Classroom.tsx），
       *    工作台上没有这句 —— 所以这里断言产品真正表现出来的三件事：
       *    ① 日期行确实是周日；② 早上照样弹欢迎弹窗；③ 不按周末对待（"周末"横幅不在）。
       */
      const D0920 = '9 月 20 日 · 周日'
      const S48 = '48–49 调休上班日（周日 07:32）'
      await ctx.clock.setFixedTime(new Date('2026-09-20T07:32:00'))
      await goto(page, S48, '/', {
        markers: ['早上好，王老师'],
        absent: ['今天是周末噢，好好休息吧。'],
        date: D0920,
        // 早上 6:30–9:00 第一次打开：欢迎弹窗**本该**在（调休日按工作日对待 → 弹窗也弹）
        allowModal: '早上好，王老师',
      })
      await step(S48, async () => {
        const info = await pageInfo(page)
        check(
          info.modalOpen && info.modalText.includes('早上好'),
          '调休上班日的早上照样弹欢迎弹窗（按工作日对待）',
          info.modalOpen ? `弹窗：${short(info.modalText, 70)}` : short(info.body, 120),
        )
        await page.waitForTimeout(900)
      })
      await shotRaw(page, S48, '48-makeup-day-welcome')
      await step(S48, async () => {
        await page.getByRole('button', { name: '开始今天' }).click()
        await page.waitForTimeout(500)
      })
      await shot(page, S48, '49-makeup-day-no-banner', {
        full: true,
        wait: 0,
        expect: {
          url: '/',
          absent: ['今天是周末噢', '没有排课'],
        },
      })

      // 中秋假期第一天（2026-09-25）：不弹窗，工作台显示节日祝福
      const D0925 = '9 月 25 日 · 周五'
      const S50 = '50 中秋假期（周五 10:00）'
      await ctx.clock.setFixedTime(new Date('2026-09-25T10:00:00'))
      await goto(page, S50, '/', { markers: ['中秋节'], date: D0925 })
      await step(S50, async () => {
        const info = await pageInfo(page)
        check(!info.modalOpen, '假期当天**不**弹欢迎弹窗', info.modalOpen ? '开着 .modal' : '没有 .modal')
        await page.waitForTimeout(900)
      })
      await shot(page, S50, '50-holiday-festive', { full: true, wait: 0, expect: { url: '/' } })

      // 距假期 2 天 + 工作全部完成 → 收尾换成倒计时
      const S51 = '51 假期倒计时（周三 19:40）'
      await ctx.clock.setFixedTime(new Date('2026-09-23T19:40:00'))
      await step(S51, async () => {
        await page.goto(`${BASE}${GR}`, { waitUntil: 'networkidle' })
        await expectPage(page, S51, { url: GR, markers: grMarkers })
        await page.getByRole('button', { name: '完成批改' }).click()
        await page.getByRole('button', { name: /确认完成批改/ }).click()
        await page.getByRole('button', { name: '确认完成批改' }).click()
        // 同 27：确认完成后落到 /grade/done，并且这一份是"最后一份"→ 完成弹窗会弹出来；
        // 它的收尾语按 `soonCountdown` 换成倒计时（这条就是这一步要验的东西）
        await page.waitForURL('**/grade/done', { timeout: 8000 })
        await page.waitForTimeout(1100)
      })
      await shot(page, S51, '51-countdown-done', {
        wait: 0,
        expect: {
          url: `${GR}/done`,
          markers: ['今天的工作已经全部完成', '还有 2 天到中秋节'],
          allowModal: '今天的工作已经全部完成',
        },
      })

      /* ================= S6：错题集，两层（班级列表 → 班级档案） ================= */

      /*
       * 错题集是**两层**：/wrong 先列"我任教的班级"，点一个班才进 /wrong/:classId 的档案
       * （学生名单在档案里，"班级总结错题"在档案右上角）。
       * 所以这一节必须**两层都走**：只截 /wrong 的话，第二层坏了也看不出来。
       */
      const SW = '52–57 错题集'
      const WC = '/wrong/c-demo-1'
      await ctx.clock.setFixedTime(new Date('2026-09-19T10:00:00'))
      await step(SW, async () => {
        await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
        await page.goto(`${BASE}/wrong`, { waitUntil: 'networkidle' })
        await expectPage(page, SW, {
          url: '/wrong',
          /*
           * 「批过 1 份」= 高二(3)班里**能进错题集**的那些（§11.5 的 `ranked`）。
           *
           * ⚠️ 为什么是 1 而不是 2：这一页是 `page.goto()` 打开的，而
           *    `addInitScript` 每次导航都会把 `shugao.teacher.v1` 覆盖成注入的快照，
           *    快照里没有 `assignments` → 作业回到 seed 的初始状态
           *    （a-demo-1 已批改；a-demo-2 / a-demo-4 未批改；a-demo-5 极简已批改）。
           *    所以"能进错题集"的只有 a-demo-1 一份，而极简那份（也是 graded）
           *    必须被 `ranked` 排掉 —— 算进来的话这里会写成 2 份，
           *    而"批过 N 份"正是老师判断"数据够不够看"的依据。
           */
          markers: [
            '错题集',
            '我任教的班级',
            '2 个班 · 91 名学生',
            '批过 1 份',
          ],
          absent: ['批过 2 份'],
          date: D0919,
        })
      })
      await shot(page, SW, '52-wrong-classes', { full: true, wait: 0 })

      await step(SW, async () => {
        // 进有数据的班（演示数据里 a-demo-* 都挂在高二(3)班）
        await page.getByRole('button', { name: /高二\(3\)班/ }).first().click()
        await page.waitForURL(`**${WC}`, { timeout: 8000 })
        await page.waitForTimeout(600)
      })
      await shot(page, SW, '53-wrong-class-detail', {
        full: true,
        wait: 0,
        expect: {
          url: WC,
          markers: ['错题档案 · 45 人', '每个人的错题账 · 按丢分排序', '班级总结错题'],
        },
      })

      await step(SW, async () => {
        // 名单里第一个人 → 个人错题明细（原来就在的 Sheet，功能不能丢）
        await page.locator('.row').first().click()
        await page.waitForTimeout(900)
      })
      await shot(page, SW, '54-wrong-student-sheet', {
        wait: 0,
        expect: { url: WC, markers: ['的错题'] },
      })
      await step(SW, async () => {
        await page.getByRole('button', { name: '关闭' }).click()
        await page.waitForTimeout(400)
      })

      await step(SW, async () => {
        // 右上角「班级总结错题」→ 班级高频错点 + 生成班级错题重练卷
        await page.getByRole('button', { name: '班级总结错题' }).click()
        await page.waitForTimeout(700)
      })
      await shot(page, SW, '55-wrong-class-summary', {
        full: true,
        wait: 0,
        expect: { url: WC, markers: ['班级高频错点'] },
      })
      await step(SW, async () => {
        await page.getByRole('button', { name: '关闭' }).click()
        await page.waitForTimeout(400)
      })

      await step(SW, async () => {
        // 返回按钮要回**班级列表**（而不是首页）
        await page.getByRole('button', { name: '返回' }).click()
        await page.waitForURL('**/wrong', { timeout: 8000 })
        await page.waitForTimeout(700)
      })
      await shot(page, SW, '56-wrong-back-to-classes', {
        full: true,
        wait: 0,
        expect: {
          url: '/wrong',
          markers: ['我任教的班级'],
        },
      })

      await step(SW, async () => {
        /*
         * 高二(7)班在演示数据里只有一份未批改的档案 → 班级列表该说"还没批改过作业"，
         * 档案里该是空态，而不是列一堆"全对"（那会把"没数据"渲染成"都会了"）
         */
        await page.getByRole('button', { name: /高二\(7\)班/ }).first().click()
        await page.waitForURL('**/wrong/c-demo-2', { timeout: 8000 })
        await page.waitForTimeout(600)
      })
      await shot(page, SW, '57-wrong-class-empty', {
        full: true,
        wait: 0,
        expect: {
          url: '/wrong/c-demo-2',
          markers: ['这个班还没有批改过的作业'],
          absent: ['全班丢'],
        },
      })

      /* ==================================================================
         S6b：顶层 tab 的「返回」—— 有上一页回上一页，没上一页回兜底
         ------------------------------------------------------------------
         `/schedule`（日程表）与 `/wrong`（错题集）**既是顶层 tab（左栏/底部），
         又能从「我的」点进来**，所以"返回去哪"写死哪一条都有一半是错的：
           · 写死 `/settings`（日程表原样）→ 从 tab 进来时回到「我的」= 说谎；
           · 写死 `/`（错题集原样）→ 从任意一页点 tab 进来都会被扔回首页；
           · 裸 `navigate(-1)` → 从书签 / PWA 图标**直接打开**时**没有上一页**，
             会把老师**带出应用**（下面 ③ ⑤ 实测：退到上一个站点 = about:blank）。
         正解 = `lib/back.ts` 的 `goBackOr(navigate, '/')`：`history.state.idx > 0`
         才 `navigate(-1)`，否则回兜底 `/`（用 replace，免得在历史里留一条会弹回来的记录）。

         🧪 **反向对照**：把 `goBackOr` 改回裸 `navigate(-1)`（一处），
            ③ ⑤ 那两条必须红（其余几条照旧绿 —— 裸 -1 只在"没有上一页"时才错）。

         ⚠️ 为什么单独开一个 1440px 的 context：主流程那个 414px 的视口里
            左栏 tab 不在屏上，而这一节要**真的点 tab**（不是手打地址）。
         ================================================================== */

      const SB = '58 顶层 tab 返回'
      const ctxBack = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: 'zh-CN',
      })
      await ctxBack.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxBack.addInitScript((s) => {
        /*
         * ⚠️ 这个 `try` 是必要的：③ ⑤ 会先打开 `about:blank` 去造"浏览器有上一页"的处境，
         *    而那个 opaque origin 上 `localStorage` 会抛 SecurityError —— 与产品无关，
         *    不兜住它就会变成一条假的 `pageerror`（这一节自己把自己弄红）。
         */
        try {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        } catch {
          /* about:blank：没有 origin，写不了 localStorage */
        }
      }, TEACHER_STATE)
      const backPage = await ctxBack.newPage()
      backPage.on('pageerror', (e) => errors.push(`PAGEERROR(${SB}) ${backPage.url()} :: ${e.message}`))
      backPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${SB}) ${backPage.url()} :: ${m.text()}`)
      })

      /** 读回"我在哪一页 + React Router 自己记的历史序号"——这一节的证据就是这两个数 */
      const atBack = () =>
        backPage.evaluate(() => ({
          url: location.pathname + location.search,
          idx: (window.history.state || {}).idx ?? 0,
          body: String(document.body.innerText || '').replace(/\s+/g, ' ').trim(),
        }))

      /** 点页头那颗「返回」（`ui.tsx` 的 PageHead 渲染成 `aria-label="返回"` 的按钮） */
      const clickBack = async () => {
        await backPage.locator('button[aria-label="返回"]').first().click()
        await backPage.waitForTimeout(900)
      }

      /* ① 从 tab 进日程表 → 返回回**上一页**（不是「我的」） */
      await step(SB, async () => {
        await backPage.goto(`${BASE}/classes`, { waitUntil: 'networkidle' })
        await backPage.locator('[data-nav="/schedule"]').click()
        await backPage.waitForURL('**/schedule', { timeout: 8000 })
        await backPage.waitForTimeout(600)
        const at = await atBack()
        check(
          at.idx > 0,
          `${SB}：从 tab 进 /schedule 之后 history.state.idx > 0（有上一页可回）`,
          `idx = ${at.idx}`,
        )
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/classes',
          `${SB}：🔴 从 tab 进 /schedule → 返回回**上一页「/classes」**（写死「/settings」会回到「我的」）`,
          `返回后 url = ${after.url}`,
        )
      })
      await shot(backPage, SB, '58a-back-schedule-tab', {
        full: true,
        wait: 0,
        expect: { url: '/classes', markers: ['2 个班级 · 91 名学生'] },
      })

      /* ② 从「我的」那一行进日程表 → 返回回「我的」 */
      await step(SB, async () => {
        await backPage.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
        await backPage.getByRole('button', { name: /录入上课与日程/ }).first().click()
        await backPage.waitForURL('**/schedule', { timeout: 8000 })
        await backPage.waitForTimeout(600)
        const at = await atBack()
        check(at.idx > 0, `${SB}：从「我的」进 /schedule 之后 idx > 0`, `idx = ${at.idx}`)
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/settings',
          `${SB}：从「我的」进 /schedule → 返回回**「我的」**（写死「/」会回到工作台）`,
          `返回后 url = ${after.url}`,
        )
      })
      await shot(backPage, SB, '58b-back-schedule-mine', {
        full: true,
        wait: 0,
        expect: { url: '/settings', markers: ['录入上课与日程'] },
      })

      /*
       * ③ 🔴 **直接打开**日程表（书签 / PWA 图标）→ 回兜底 `/`，**且不退出应用**。
       *
       * 先访问一个别的地址再直开这一页 —— 这才是书签 / PWA 的真实处境：
       * 浏览器历史里有上一页，但**这个 SPA 自己没有**（React Router 把这一页记成 idx = 0）。
       * 裸 `navigate(-1)` 在这种处境下退回的是 about:blank（= 离开应用）。
       */
      await step(SB, async () => {
        await backPage.goto('about:blank')
        await backPage.goto(`${BASE}/schedule`, { waitUntil: 'networkidle' })
        await backPage.waitForTimeout(600)
        const at = await atBack()
        check(
          at.idx === 0,
          `${SB}：直开 /schedule 时 idx = 0（这个 SPA 内部**没有**上一页）`,
          `idx = ${at.idx}`,
        )
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/',
          `${SB}：🔴 直开 /schedule → 返回回**兜底「/」**（裸 -1 会退到上一个站点 / 退出应用）`,
          `返回后 url = ${after.url}`,
        )
        check(
          after.body.includes('今日待办'),
          `${SB}：而且**还在应用里**（回的是工作台，不是空白页）`,
          short(after.body, 90),
        )
      })
      await shot(backPage, SB, '58c-back-direct-schedule', {
        full: true,
        wait: 0,
        expect: { url: '/', markers: ['今日待办'] },
      })

      /* ④ 从 tab 进错题集 → 返回回**上一页**（不是首页） */
      await step(SB, async () => {
        await backPage.goto(`${BASE}/classes`, { waitUntil: 'networkidle' })
        await backPage.locator('[data-nav="/wrong"]').click()
        await backPage.waitForURL('**/wrong', { timeout: 8000 })
        await backPage.waitForTimeout(600)
        const at = await atBack()
        check(at.idx > 0, `${SB}：从 tab 进 /wrong 之后 idx > 0`, `idx = ${at.idx}`)
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/classes',
          `${SB}：🔴 从 tab 进 /wrong → 返回回**上一页「/classes」**（写死「/」会回到工作台）`,
          `返回后 url = ${after.url}`,
        )
      })

      /* ⑤ 🔴 直开错题集 → 回兜底 `/`，同样不退出应用 */
      await step(SB, async () => {
        await backPage.goto('about:blank')
        await backPage.goto(`${BASE}/wrong`, { waitUntil: 'networkidle' })
        await backPage.waitForTimeout(600)
        const at = await atBack()
        check(at.idx === 0, `${SB}：直开 /wrong 时 idx = 0（没有上一页）`, `idx = ${at.idx}`)
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/',
          `${SB}：🔴 直开 /wrong → 返回回**兜底「/」**（裸 -1 会退到上一个站点 / 退出应用）`,
          `返回后 url = ${after.url}`,
        )
        check(after.body.includes('今日待办'), `${SB}：而且**还在应用里**`, short(after.body, 90))
      })
      await shot(backPage, SB, '58d-back-direct-wrong', {
        full: true,
        wait: 0,
        expect: { url: '/', markers: ['今日待办'] },
      })

      /*
       * ⑥ 反向的一侧：`/wrong/:classId` **照旧写死回家族根 `/wrong`** ——
       *    这不是漏改：这一页只有一个父页（只能从 `/wrong` 点进来），
       *    没有那个两难，也就**不该**跟着换成 `goBackOr`。这条钉住"别顺手把它也改了"。
       */
      await step(SB, async () => {
        await backPage.goto(`${BASE}/wrong/c-demo-1`, { waitUntil: 'networkidle' })
        await backPage.waitForTimeout(600)
        await clickBack()
        const after = await atBack()
        check(
          after.url === '/wrong',
          `${SB}：/wrong/:classId 的返回仍然回家族根「/wrong」（子页不换形状）`,
          `返回后 url = ${after.url}`,
        )
      })

      await ctxBack.close()

      /* ==================================================================
         S6c：🆕 年级管理里的「班级档案」展开条（F3）
         ------------------------------------------------------------------
         用户原话：「这个**年级管理**功能并不是只有开学的时候用呀，平常的时候也会
         **改改档案**之类的，是不是应该再把下面加上**高一，高二，高三的档案条**，
         **点一下向下展开该年级所有班级的档案**，**点击班级档案可以修改**？」

         🔴 **这是一个"行政视角"**：年级主任 / 教务处在这一页看到的是**整个年级的班**
            （不只是自己教的）。所以展开条里的班**必须**来自"按年级读"
            （`loadGradeSetup` 的行政班 + `loadStreams` 的走班班），
            **不是**从"我教哪些班"筛出来的。
         🔴 **但"看得见 ≠ 改得动"**：点进去是**同一个**班级档案页
            （`/classes/:id` → `pages/ClassDetail.tsx`），能改什么仍由那一页的判据说了算。
         🔴 **全仓只有一个班级档案页**（本项目最忌的"两套"）：这一节既做**源码级**
            断言（`App.tsx` 只有一个 `/classes/:id` 路由、`Grades.tsx` 里跳去班级档案的
            两处写的是**同一个** `/classes/${k.id}`），也做**运行时**断言（点进去真的是那一页）。

         🧪 反向对照（三条，都实测跑红过）：
           · ① 把 `Grades.tsx` 的展开条改成"按身份筛"（加一处 `roles.filter(...)`）
             → Ⅱ-① 红（前端多了一套判据）；
           · ② 把 `useMood.ts` 那句 `status === 'collected' && isMyTodo(...)` 改回裸
             `filter(a => a.status === 'collected')` → Ⅳ-①② 两条源码级断言红，
             而且 S42「今天要批的作业」那两条运行时断言也会红（弹窗里会多出数学）；
           · ③ 把弹窗那处换成 `pendingForMe()` 的**整体**结果（它含 `open`）
             → Ⅳ-③ 红，S42 的计数与标题断言也红，S46「今天完成」还到不了。
         ================================================================== */

      const S63 = 'S6c 年级管理 · 班级档案展开条'
      await ctx.clock.setFixedTime(new Date(2026, 8, 18, 10, 0, 0))
      const grPage = await ctx.newPage()
      grPage.on('pageerror', (e) => errors.push(`PAGEERROR(${S63}) ${grPage.url()} :: ${e.message}`))
      grPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(${S63}) ${grPage.url()} :: ${m.text()}`)
      })
      /*
       * ⚠️ 这一节里有两处"直开"（Ⅴ/Ⅵ）要造"浏览器有上一页、而这个 SPA 自己没有"的处境。
       *    借道 `about:blank` 会多出两条**与本产品无关**的 `SecurityError`
       *    （那个 opaque origin 读不了 `localStorage`，而本应用启动时一定会读它）——
       *    那是测试写法造出来的噪音，不是页面错误。所以走 `directOpen()`：
       *    用本站一个正常页面当中转（历史里照样有上一页，而 SPA 自记的 idx 仍是 0）。
       *    （S6b 那一节还在用 `about:blank`，它靠一层 try/catch 兜住那两条。）
       */
      const directOpen = async (path) => {
        await grPage.goto(`${BASE}/grades`, { waitUntil: 'networkidle' })
        await grPage.waitForTimeout(200)
        await grPage.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
        await grPage.waitForTimeout(500)
      }

      /** 读那一页上的三个年级 + 展开条（按 `data-grade-*` 取，不按样式类名 —— §15.5 的教训） */
      const gradeInfo = () =>
        grPage.evaluate(() => {
          const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
          return {
            url: location.pathname + location.search,
            toggles: [...document.querySelectorAll('[data-grade-toggle]')].map((b) => ({
              id: b.getAttribute('data-grade-toggle'),
              label: b.getAttribute('aria-label'),
              text: norm(b.innerText),
            })),
            archives: [...document.querySelectorAll('[data-grade-archive]')].map((b) => ({
              id: b.getAttribute('data-grade-archive'),
              text: norm(b.innerText),
            })),
            body: norm(document.body.innerText),
          }
        })

      const archiveOf = (info, id) => info.archives.find((a) => a.id === id) ?? null
      /** 仓库根（`app/` 的上一级）——读 `supabase/schema.sql` 用 */
      const ROOT = join(HERE, '..', '..')

      await goto(grPage, S63, '/grades', { markers: ['年级管理', '开学准备'] })
      await shot(grPage, S63, '107-grade-archive-bar', { full: true, wait: 300 })

      /* ---- Ⅰ：点一下展开 = 列出**该年级的全部班**（行政班 / 走班班分两块） ---- */
      await step(S63, async () => {
        const before = await gradeInfo()
        /*
         * 每个年级都有一条「班级档案」（用户原话：下面加上高一 / 高二 / 高三的档案条）——
         * 演示模式里 `demoGrades()` 固定给高一 / 高二 / 高三三行。
         */
        check(
          before.toggles.length === 3,
          `${S63}：三个年级卡下面各有一条「班级档案」展开条（高一 / 高二 / 高三）`,
          before.toggles.map((t) => t.label).join(' · ') || '(一条都没读到)',
        )
        check(
          before.toggles.every((t) => t.text.includes('班级档案')),
          `${S63}：那三条写的都是「班级档案」（与「开学准备」并列，不是取代它）`,
          before.toggles.map((t) => t.text).join(' | ') || '(空)',
        )
        check(
          before.archives.length === 0,
          `${S63}：没点之前是**收起的**（屏上一条班列表都没有）`,
          `展开着的条数 = ${before.archives.length}`,
        )
      })

      await step(S63, async () => {
        await grPage.getByRole('button', { name: '高二的班级档案' }).click()
        await grPage.waitForTimeout(600)
        const info = await gradeInfo()
        const a = archiveOf(info, 'demo-grade-高二')
        check(a !== null, `${S63}：点一下高二那条 → **向下展开了**这个年级的班`, a ? '展开了' : '没展开')
        const t = a?.text ?? ''
        check(
          t.includes('行政班') && t.includes('高二(3)班') && t.includes('高二(7)班'),
          `${S63}：🔴 展开条列出该年级的**全部班**（高二两个班都在：高二(3)班 · 高二(7)班）`,
          short(t, 150),
        )
        check(
          t.includes('45 人') && t.includes('46 人'),
          `${S63}：每个班带人数（45 / 46 —— 与 ` + '`/classes`' + ` 同一份数据）`,
          short(t, 150),
        )
        /*
         * ⚠️ 演示数据里**没有走班班**（`makeDemoClasses()` 只有两个行政班）——
         *    所以"走班班单独一块"这条在**假库上跑不出来**（这是**已知限制**，不是漏做）：
         *    它由 Ⅱ-③ 的源码级断言钉住（`splitByKind` 是唯一入口 + 走班班单独渲染），
         *    而 `splitByKind` 本身的正反用例在下面 Ⅱ-③ 里逐条喂。
         *    这里断言"没有走班班时那块**不渲染**"（空标题不该出现）。
         */
        check(
          !t.includes('走班班'),
          `${S63}：演示数据里这个年级没有走班班 → 那一块**不渲染**（空标题不该出现）`,
          short(t, 150),
        )
        check(
          (info.toggles.find((x) => x.id === 'demo-grade-高二')?.text ?? '').includes('2 个班'),
          `${S63}：而且那条上写着这个年级有几个班（2 个班）`,
          short(info.toggles.find((x) => x.id === 'demo-grade-高二')?.text ?? '(没读到)', 80),
        )
      })
      await shot(grPage, S63, '108-grade-archive-expanded', { full: true, wait: 150 })

      await step(S63, async () => {
        /* 换一个年级展开：上一个必须先收起（屏上只留一个年级的班） */
        await grPage.getByRole('button', { name: '高三的班级档案' }).click()
        await grPage.waitForTimeout(500)
        const info = await gradeInfo()
        check(
          info.archives.length === 1 && info.archives[0]?.id === 'demo-grade-高三',
          `${S63}：换一个年级展开时**上一个自己收起**（屏上只有这一个年级的班）`,
          info.archives.map((x) => x.id).join(',') || '(没有展开的)',
        )
        check(
          (archiveOf(info, 'demo-grade-高三')?.text ?? '').includes('这个年级还没有班'),
          `${S63}：这个年级一个班都没有 → 明确说「这个年级还没有班」（**不是**一段空白）`,
          short(archiveOf(info, 'demo-grade-高三')?.text ?? '', 80),
        )
      })

      /* ---- Ⅱ：行政视角 + 「同一个班级档案页」+ 看得见≠改得动 ---- */
      await step(S63, async () => {
        const gradesSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'Grades.tsx'), 'utf8')
        const appSrc = readFileSync(join(HERE, '..', 'src', 'App.tsx'), 'utf8')

        /* Ⅱ-① 🔴 前端**不许**另写一套角色判据（这一条就是"别的年级的年级主任看不到"的落点：
             `grades` 与 `classes` 都是数据库（RLS）筛过的结果，前端再筛一次就是 §11.3
             明令禁止的那件事）。
             ⚠️ 判据要**窄**（刻意不数"出现过哪些函数名" —— 那会把 import、注释、入口判断
                全算进来，是一条会误伤的假红）：
                  · 页面里**没有**任何 `role ===` 的身份比较；
                  · `myRoles` 只出现在那**一行**入口判断里（`entryVisible('/settings/terms', …)`）。
             展开条那一段只做 `navigate`，一个身份判断都不做。 */
        const noComments = gradesSrc
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((l) => !/^\s*\/\//.test(l))
          .join('\n')
        const roleCmp = [...noComments.matchAll(/role\s*===/g)].length
        const roleUse = noComments
          .split('\n')
          .filter((l) => /(?:entryVisible|canEditClassFor|hasManagingRole)\(/.test(l))
        check(
          roleCmp === 0 &&
            roleUse.length === 1 &&
            /entryVisible\('\/settings\/terms', myRoles\)/.test(roleUse[0] ?? ''),
          `${S63}：🔴 与身份有关的只剩**那一行入口判断**（` + "`entryVisible('/settings/terms', myRoles)`" + `）—— 展开条里一处身份判据都没有`,
          `role=== ${roleCmp} 处 · 身份函数调用 ${roleUse.length} 行：${roleUse.map((l) => l.trim()).join(' | ') || '(空)'}`,
        )
        const handFilter = noComments
          .split('\n')
          .filter((l) => /(?:grades|storeClasses)\s*\.\s*filter\s*\(/.test(l))
        check(
          handFilter.length === 1 &&
            /storeClasses\.filter\(\(k\) => k\.grade === gradeName\)/.test(handFilter[0] ?? ''),
          `${S63}：🔴 唯一一处"筛"是**按年级名**（形状），**不是**按"我教哪些班" —— 这正是"行政视角"`,
          handFilter.map((l) => l.trim()).join(' | ') || '(一处都没有)',
        )
        /*
         * Ⅱ-② & Ⅱ-③ 🔴 **全仓只有一个班级档案页**：
         *   · `App.tsx` 里 `/classes/:id` 路由**恰好一条**，渲染的就是 `ClassDetail`；
         *   · 这一页里跳去班级档案的写法**恰好一处** `navigate(\`/classes/${…}\`)`
         *     —— 一处 = 两个块（行政班 / 走班班）共用同一个跳转，不是两个页面。
         * 反向对照：新写一个 `GradeClassDetail` 页面并给它一条路由 → 这两条红。
         */
        const classRoutes = [...appSrc.matchAll(/path="\/classes\/:id"/g)].length
        const detailComponents = [...appSrc.matchAll(/<ClassDetail\s*\/>/g)].length
        check(
          classRoutes === 1 && detailComponents === 1,
          `${S63}：🔴 全仓**只有一个** \`/classes/:id\` 路由，渲染的就是 \`ClassDetail\`（**没有第二个班级档案页**）`,
          `/classes/:id 路由 ${classRoutes} 条 · <ClassDetail /> ${detailComponents} 处`,
        )
        const allGoClass = [...noComments.matchAll(/navigate\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim())
        const classGoes = allGoClass.filter((p) => p.includes('/classes/'))
        check(
          classGoes.length === 2 && classGoes.every((p) => p.replace(/\s+/g, '') === '`/classes/${k.id}`'),
          `${S63}：跳去班级档案的两处（行政班一块 + 走班班一块）写的是**同一个** /classes/ 路径 —— 两个块共用一个跳转，不是两个页面`,
          `跳 /classes 的写法：${classGoes.join(' | ') || '(一处都没有)'}\u3000· 本页全部 navigate = ${allGoClass.join(' , ')}`,
        )
        /*
         * Ⅱ-③ 两种班分开列走的是**唯一那个判定入口** `splitByKind()` ——
         *      页面里不许再手写 `kind === 'stream'`（`rls-checks` 第十四节同一条纪律）。
         *      ⚠️ 这里**实测喂了正反两组**：混着两个走班班的列表必须被分成 1 + 2。
         *      （演示数据里没有走班班，所以这是"走班班单独一块"在假库上唯一能红的验法。）
         */
        const { splitByKind } = await import('../src/lib/pick.ts')
        const mixed = [
          { id: 'k1', name: '高二(3)班', grade: '高二', year: '', createdAt: 0, students: [] },
          { id: 'k2', name: '走班班-化学', grade: '高二', year: '', createdAt: 0, students: [], kind: 'stream' },
          { id: 'k3', name: '走班班-地理', grade: '高二', year: '', createdAt: 0, students: [], kind: 'stream' },
        ]
        const sp = splitByKind(mixed)
        check(
          sp.admin.length === 1 && sp.stream.length === 2,
          `${S63}：🔴 行政班与走班班**分两块**（` + '`splitByKind`' + '：混着的 3 个班 → 1 行政 + 2 走班）',
          `admin=${sp.admin.map((k) => k.name).join(',')} · stream=${sp.stream.map((k) => k.name).join(',')}`,
        )
        check(
          /splitByKind/.test(gradesSrc) && /import\s*\{[^}]*splitByKind[^}]*\}\s*from\s*'\.\.\/lib\/pick'/.test(gradesSrc),
          `${S63}：而这一页用的是**同一个** \`splitByKind\`（不是自己写一份 kind 判断）`,
          /splitByKind/.test(gradesSrc) ? '用了 splitByKind' : '没找到 splitByKind',
        )
        check(
          !/[^.\w]kind\s*===\s*'stream'/.test(gradesSrc),
          `${S63}：页面里**没有**手写 \`kind === 'stream'\`（第二套判定入口）`,
          /[^.\w]kind\s*===\s*'stream'/.test(gradesSrc) ? '手写了' : '没有',
        )
      })

      /* ---- Ⅲ：点某个班 → 进**那个班的档案页**（同一个页面），并且"看得见 ≠ 改得动" ---- */
      await step(S63, async () => {
        /* 先把高二那一条重新展开（上一步展开的是高三，展开条一次只开一个） */
        await grPage.getByRole('button', { name: '高二的班级档案' }).click()
        await grPage.waitForTimeout(600)
        const clsBtn = grPage.getByRole('button', { name: '打开高二(3)班的班级档案' })
        await clsBtn.waitFor({ state: 'visible', timeout: 8000 })
        await clsBtn.scrollIntoViewIfNeeded()
        await clsBtn.click()
        await grPage.waitForURL('**/classes/c-demo-1', { timeout: 8000 })
        await grPage.waitForTimeout(700)
        const at = await grPage.evaluate(() => ({
          url: location.pathname,
          body: String(document.body.innerText || '').replace(/\s+/g, ' ').trim(),
        }))
        check(
          at.url === '/classes/c-demo-1',
          `${S63}：🔴 点展开条里的「高二(3)班」→ 进的**就是** \`/classes/c-demo-1\`（同一个班级档案页）`,
          `屏上 url = 「${at.url}」`,
        )
        check(
          at.body.includes('学生名单 · 45 人'),
          `${S63}：而且它就是那一页（学生名单 45 人 —— 与 /classes/c-demo-1 同一个班）`,
          short(at.body, 140),
        )
        /* 🔴 "看得见 ≠ 改得动"：默认身份是**任课教师**（无身份），名单与名单体检全看得见、
            "档案"那一列也照旧点得开；但**写入口**一个都不摆
            （判据在数据库 `can_manage_class_for()` / `can_manage_class()`）。
            ⚠️ "学生档案"四个字只在点开某个学生之后才出现在屏上（那是按钮上的字），
               所以这里钉的是**名单本身**（45 个学生的姓名与学号）。 */
        const editBtns = await grPage.getByRole('button', { name: '修改档案' }).count()
        check(
          at.body.includes('学生名单 · 45 人') && at.body.includes('王晨') && at.body.includes('2025001'),
          `${S63}：🔴 只能看的人**看得见**这个班的名单（45 人 · 学号 2025001 · 姓名都在）`,
          short(at.body, 140),
        )
        check(
          editBtns === 0,
          `${S63}：🔴 但写入口一个都不摆（「修改档案」按下不出现）—— 看得见 ≠ 改得动（判据在数据库）`,
          `按钮数 = ${editBtns}`,
        )
        /*
         * ⚠️ 这里**不断言**「教室端账号」那一块在不在：那一块的渲染条件是 `canManageThis`
         *    **且** `isRemote`，而这一轮跑的是本地演示模式（没有数据库）——
         *    它在假库上恒不出现，断言它就是在放水（"永远为绿的摆设"）。
         *    那一块"科任老师看不到"由 `04b/04d` 与 `rls-checks` 第二十一节钉住。
         */
        /* 反向对照（同一次运行里的另一半）：同一个人对**他管的那个班**照样摆 ——
           证明上一行不是"恒不摆"。班主任由 `?as=head_teacher` 注入（详见 04c 那一节）。 */
        await grPage.goto(`${BASE}/classes/c-demo-1?as=head_teacher`, { waitUntil: 'networkidle' })
        await grPage.waitForTimeout(500)
        await grPage.getByRole('button', { name: '学生档案' }).first().click()
        await grPage.waitForTimeout(280)
        const canEdit = await grPage.getByRole('button', { name: '修改档案' }).count()
        check(
          canEdit === 1,
          `${S63}：🔴 反向对照：同一个人（班主任）在**他管的班**上照样摆「修改档案」 —— 上面那条不是"恒不摆"`,
          `按钮数 = ${canEdit}`,
        )
        await grPage.keyboard.press('Escape')
        await grPage.waitForTimeout(200)
      })
      await shot(grPage, S63, '109-grade-archive-class-detail', { full: true, wait: 200 })

      /* ---- Ⅳ：待办口径 —— 欢迎弹窗「今天要批的作业」走的是同一个「任教关系」判据 ---- */
      await step(S63, async () => {
        const src = readFileSync(join(HERE, '..', 'src', 'hooks', 'useMood.ts'), 'utf8')
        /* 剔注释之后再数 —— 否则纪律本身的注释会把"出现几次"数进去（假红） */
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        const shell = readFileSync(join(HERE, '..', 'src', 'components', 'AppShell.tsx'), 'utf8')
        const moodModals = readFileSync(join(HERE, '..', 'src', 'components', 'MoodModals.tsx'), 'utf8')
        /* Ⅳ-① 🔴 弹窗这一处的待办**必须**过 `isMyTodo()`（「这条作业归不归我」的**唯一**判据，
            `lib/teaching.ts`）—— 且只在这一句里用。
            反向对照：把这句改回裸 `assignments.filter(a => a.status === 'collected')`
            → 这一条与新加的第 Ⅳ-② 条**当场红**（实测跑过）。 */
        check(
          (code.match(/isMyTodo\(/g) ?? []).length === 1,
          `${S63}：🔴 弹窗的待办只在一处过 isMyTodo()（import 之外只出现 1 次 = 没有第二份"归不归我"的判断）`,
          `isMyTodo( 在代码里出现 ${(code.match(/isMyTodo\(/g) ?? []).length} 次`,
        )
        /*
         * Ⅳ-② 🔴 **反向对照的机器版（新）**：状态那一半**必须**与任教关系那一半在同一句里。
         *      只钉 Ⅳ-① 的话，"绕开 isMyTodo、自己再写一遍状态筛选"照样绿 ——
         *      而那就是这个 bug 原来的形状（只按 status 筛）。
         */
        check(
          /assignments\.filter\(\(a\) => a\.status === 'collected' && isMyTodo\(a, relations, teacherId\)\)/.test(src),
          `${S63}：🔴 而且两半**在同一句 filter 里**（` + "`status === 'collected'`" + ` 与 ` + '`isMyTodo(...)`' + `）—— 绕开它自己写一遍就会红`,
          short(src.match(/assignments\.filter\([^\n]*/)?.[0] ?? '(没找到那句 filter)', 120),
        )
        /*
         * Ⅳ-③ ⚠️ **已知的口径差别（写下来，别让下一个人以为是漏用）**：
         *      这里**没有**直接用 `pendingForMe()` 的整体结果 —— 它按「今日待办」的口径
         *      把 `open`（待收缴）也算进去，而"待收缴"的作业还没收上来、**没有东西可批**，
         *      列进「今天要批的作业」是错的。
         *      实测：拿整体结果顶在这里 → 演示数据那两份 `open` 混进弹窗，
         *      而且"今日完成"再也到不了（S46 当场红）。工作台「今日待办」列表**照旧**
         *      用 `pendingForMe()` 的整体结果（那边含待收缴是对的）。
         */
        check(
          !/pendingForMe\(/.test(code),
          `${S63}：⚠️ 弹窗这一处用的是"待批改 ∩ 归我"（不是 pendingForMe() 的整体口径 —— 那是工作台今日待办的口径）`,
          /pendingForMe\(/.test(code) ? '用了 pendingForMe 的整体结果' : '没直接用整体结果',
        )
        /*
         * Ⅳ-④ 弹窗那一份数据的来路：`useMood` 的 `pending` → `AppShell` 的
         *      `pending={mood.pending}` → `MoodModals.MorningWelcome`。
         *      ⚠️ 演示数据里**没有**"待批改但不是本人任教科目"的档案（`makeDemoAssignments()`
         *      全是物理），所以"弹窗里不出现数学"这件事在**假库上跑不出来**（**已知限制**）——
         *      它由 `待办①`（纯函数，构造了数学 x2/x6）与这两条源码级断言合起来钉住。
         */
        check(
          /pending=\{mood\.pending\}/.test(shell) &&
            /pending:\s*Assignment\[\]/.test(moodModals) &&
            /pending\.slice\(0, 4\)/.test(moodModals),
          `${S63}：欢迎弹窗「今天要批的作业」显示的就是这一份（` + '`AppShell` → `MoodModals`' + ' 同一条链）',
          `AppShell 传参=${/pending=\{mood\.pending\}/.test(shell)} · MoodModals 渲染=${/pending\.slice\(0, 4\)/.test(moodModals)}`,
        )
      })

      await step(S63, async () => {
        /* 运行时的一半（演示模式）：「今天要批的作业」= 我的**任教关系里**待批改的那几份。
           演示数据里 `status === 'collected'` 只有 `a-demo-4`（作业23 电功与电功率），
           而 `a-demo-2`（作业22）是 open（还没收）→ **不进弹窗**。 */
        await grPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await grPage.waitForTimeout(600)
        check(
          !(await pageInfo(grPage)).modalOpen,
          `${S63}：上午 10:00 不进"早上第一次打开"那个窗口 → 没有意料之外的弹窗`,
          (await pageInfo(grPage)).modalOpen ? '有弹窗' : '无 .modal',
        )
        const wbBody = await bodyText(grPage)
        check(
          wbBody.includes('7 题待批改'),
          `${S63}：工作台「今日待办」那一行在（= ` + '`pendingForMe`' + ' 的结论，7 题那一份）',
          short(wbBody.match(/.{0,30}7 题待批改.{0,10}/)?.[0] ?? wbBody, 120),
        )
      })

      await grPage.goto(`${BASE}/?as=teacher`, { waitUntil: 'networkidle' })
      await grPage.waitForTimeout(600)

      /* ---- Ⅴ：`/accounts` 的返回走 `goBackOr`（直开 → 回 /settings 且不退出应用） ---- */
      await step(S63, async () => {
        await directOpen('/accounts')
        const idx = await grPage.evaluate(() => (window.history.state || {}).idx ?? 0)
        check(idx === 0, `${S63}：直开 /accounts 时 idx = 0（这个 SPA 内部没有上一页）`, `idx = ${idx}`)
        await grPage.locator('button[aria-label="返回"]').first().click()
        await grPage.waitForTimeout(900)
        const after = await grPage.evaluate(() => ({
          url: location.pathname,
          body: String(document.body.innerText || '').replace(/\s+/g, ' ').trim(),
        }))
        check(
          after.url === '/settings',
          `${S63}：🔴 直开 /accounts → 返回回**兜底「/settings」**（裸 -1 会退到上一个站点 / 退出应用）`,
          `返回后 url = ${after.url}`,
        )
        check(
          after.body.includes('我的') || after.body.includes('王老师'),
          `${S63}：而且**还在应用里**（回的是「我的」，不是空白页）`,
          short(after.body, 110),
        )
      })

      /* ---- Ⅵ：404 页那颗「返回上一页」也不裸用 `-1` ---- */
      await step(S63, async () => {
        await directOpen('/no-such-page')
        const idx = await grPage.evaluate(() => (window.history.state || {}).idx ?? 0)
        check(idx === 0, `${S63}：直开一个不存在的地址时 idx = 0`, `idx = ${idx}`)
        const body0 = await bodyText(grPage)
        check(body0.includes('没有找到这个页面'), `${S63}：404 页正常渲染`, short(body0, 90))
        await grPage.getByRole('button', { name: '返回上一页' }).click()
        await grPage.waitForTimeout(900)
        const after = await grPage.evaluate(() => location.pathname)
        check(
          after === '/',
          `${S63}：🔴 404 上那颗「返回上一页」→ 回**兜底「/」**（与应用里另一颗「回到工作台」同一个去处）`,
          `返回后 url = ${after}`,
        )
      })

      /* ---- Ⅶ：文案 —— 凡提到"发给谁"的一律去掉，只说备份 ---- */
      await step(S63, async () => {
        const read = (p) => readFileSync(join(HERE, '..', p), 'utf8')
        const gradePromote = read('src/pages/GradePromote.tsx')
        const backupLib = read('src/lib/backup.ts')
        const promoteApi = read('functions/api/grade-promote.ts')
        const mailLib = read('functions/api/_lib/mail.ts')
        const schemaSql = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8')
        const gradeChecks = read('scripts/grade-checks.mjs')
        check(
          gradePromote.includes('先做一次备份，这里才放行。') && !gradePromote.includes('先把备份发出去'),
          `${S63}：GradePromote 那句改成「先做一次备份，这里才放行。」（原先写着"发出去"）`,
          gradePromote.includes('先把备份发出去') ? '旧文案还在' : '已改',
        )
        check(
          backupLib.includes('备份通知没能存到云端') && !backupLib.includes('备份通知没发出去'),
          `${S63}：\`lib/backup.ts\` 的兜底文案改成「备份通知没能存到云端」（它会进「我的」的 toast）`,
          backupLib.includes('备份通知没发出去') ? '旧文案还在' : '已改',
        )
        check(
          promoteApi.includes('没有存成功') && !promoteApi.includes('**没有发出去**'),
          `${S63}：\`/api/grade-promote\` 那句改成「没有存成功」（不再说"发出去"）`,
          promoteApi.includes('**没有发出去**') ? '旧文案还在' : '已改',
        )
        const raises = [
          schemaSql.includes(`raise exception '还没有备份 —— 毕业删除的第一步是「生成备份」，先做那一步';`),
          schemaSql.includes(`raise exception '备份还没有完成（%）—— 删除流程停在这里：先重新生成一次备份',`),
          schemaSql.includes(`raise exception '备份的下载链接已经过期（%）—— 重新生成一份备份之后再删', v_rec.expires_at;`),
        ]
        check(
          raises.every(Boolean) &&
            !schemaSql.includes('发到超管邮箱') &&
            !schemaSql.includes('先把信发出去'),
          `${S63}：\`schema.sql\` 那三句 \`RAISE\` 都不再提"发给谁"（它们会显示在结果面板上）`,
          `三句都改到=${raises.filter(Boolean).length}/3 · 还有"发到超管邮箱"=${schemaSql.includes('发到超管邮箱')}`,
        )
        /*
         * 🔴 `_lib/mail.ts`：**用户/管理员读得到的那几段系统正文**（`SYSTEM_MAIL_BODIES`
         *    里的模板）都不许再提"发给谁"。判据取的是"那段正文本身"——
         *    注释里保留着这条链的历史与纪律（讲"为什么以前会发不出去"），**不该删**。
         *    ⚠️ 部署配置那几句（`ADMIN_NOTIFY_EMAIL` 没配 → 显式报错）**不在**这一条里：
         *       它讲的是运维该去哪里配环境变量，改不得（`admin-checks` ⑤ 拿它当期望值）。
         */
        const bodyAt = mailLib.indexOf('export const SYSTEM_MAIL_BODIES')
        const sysBodies = bodyAt > 0 ? mailLib.slice(bodyAt, mailLib.indexOf('export function scrubSecrets')) : ''
        check(
          sysBodies.includes('如果这一环没能完成') && !/收件人|发出去/.test(sysBodies),
          `${S63}：🔴 \`_lib/mail.ts\` 的**系统正文**（` + '`SYSTEM_MAIL_BODIES`' + `）都不再说"发出去/收件人"`,
          `系统正文段里命中=${sysBodies.match(/收件人|发出去/g)?.join(',') || '无'} · 那两句改后的措辞在=${sysBodies.includes('如果这一环没能完成')}/${sysBodies.includes('备份没能完成')}`,
        )
        check(
          gradeChecks.includes('备份还没有完成') && !gradeChecks.includes('备份还没有发到超管邮箱'),
          `${S63}：\`grade-checks\` 里跟着 schema 改的**负向对照锚点**也同步了（否则那条负向对照会"锚点没找到"）`,
          gradeChecks.includes('备份还没有发到超管邮箱') ? '旧锚点还在' : '已同步',
        )
        /* 🔴 `/admin` 那一批**豁免**：改文案时别顺手把管理台的十来处也删了 */
        const adminSrc = read('src/pages/Admin.tsx')
        const chartSrc = read('src/lib/adminChart.ts')
        check(
          /收件人/.test(adminSrc) && /没发出去/.test(chartSrc),
          `${S63}：🔴 反向对照：\`/admin\` 与 \`adminChart.ts\` 那批**照旧保留**（管理台豁免，不该被一起改掉）`,
          `Admin 有"收件人"=${/收件人/.test(adminSrc)} · adminChart 有"没发出去"=${/没发出去/.test(chartSrc)}`,
        )
      })

      /* ---- Ⅷ：schema.sql 仍然幂等（这三句 RAISE 落在 `create or replace function` 里） ---- */
      await step(S63, async () => {
        const schemaSql = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8')
        const at = schemaSql.indexOf('create or replace function public.grade_delete(')
        check(at > 0, `${S63}：\`schema.sql\` 里找得到 \`grade_delete\` 的函数体`, at > 0 ? `下标 ${at}` : '没找到')
        const body = at > 0 ? schemaSql.slice(at, at + 3000) : ''
        const ra = [...body.matchAll(/raise exception '([^']*)'/g)].map((m) => m[1])
        check(
          ra.length === 7 && ra.every((s) => !/收件人|发出去|超管邮箱/.test(s)),
          `${S63}：🔴 \`grade_delete\` 里**每一句** \`raise exception\` 都不提"发给谁"（改文案只动字，不动判据）`,
          `共 ${ra.length} 句：${ra.map((s) => s.slice(0, 12)).join(' / ')}`,
        )
        /*
         * 幂等的形状：整段是 `create or replace function`（可重复执行）。
         * ⚠️ **真跑两遍**由 `rls-checks` 第十五节第 ⑫ 条做（重跑整份 `schema.sql`
         *    之后硬指标仍全 0）—— 这一轮**没跑它**（只跑 tsc / shots / lint），
         *    所以这里只钉形状，不冒充"实测过两遍"。
         */
        check(
          /create or replace function public\.grade_delete\(/.test(schemaSql) &&
            !/drop function[^;]*grade_delete/i.test(schemaSql),
          `${S63}：它是 \`create or replace function\`（可重复执行的那一种；不是 drop + create）`,
          /create or replace function public\.grade_delete\(/.test(schemaSql) ? 'create or replace' : '形状不对',
        )
      })

      await grPage.close()

      /* ================= S7：考试（建档 → 批阅 → 统计） ================= */

      /*
       * 考试是独立的一条 /exams 路由族。这一节要**走完整条链**，只截列表是不够的：
       * 建档页的题型清单、批阅页的"展开单人/竖列题号/确认批阅"、统计页的
       * 知识点得分率与难度区分度 —— 这三处任意一处坏了，只截列表都看不出来。
       */
      const SE = '60–64 考试列表与统计'
      const EX = '/exams/ex-demo-1/stats'
      await step(SE, async () => {
        await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
        await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
        await expectPage(page, SE, {
          url: '/assignments',
          markers: ['5 份档案 · 2 份待收缴', '考试'],
          date: D0919,
        })
      })
      await shot(page, SE, '60-assignments-with-exam-entry', { full: true, wait: 0 })

      await step(SE, async () => {
        await page.getByRole('button', { name: '考试' }).click()
        await page.waitForURL('**/exams', { timeout: 8000 })
        await page.waitForTimeout(500)
      })
      await shot(page, SE, '61-exams-list', {
        full: true,
        wait: 0,
        expect: {
          url: '/exams',
          markers: ['2 份档案 · 1 场考试', '物理练习8'],
        },
      })

      await step(SE, async () => {
        // 已完成的档案点进去就是统计页（数据统计 = 用户要的那一屏）
        await page.getByRole('button', { name: /物理练习8/ }).first().click()
        await page.waitForURL(`**${EX}`, { timeout: 8000 })
        await page.waitForTimeout(700)
      })
      await shot(page, SE, '62-exam-stats', {
        full: true,
        wait: 0,
        expect: {
          url: EX,
          markers: ['考试情况', '逐题 · 得分率 / 难度 / 区分度', '知识点得分率'],
        },
      })

      await step(SE, async () => {
        // 逐题下钻：选项分布 + 难度/区分度
        // （Sheet 里有两个「关闭」：右上角 X 是无障碍名 `关闭`，页脚那个是正文按钮 —— 取第一个）
        await page.getByRole('button', { name: /^8/ }).first().click()
        await page.waitForTimeout(500)
      })
      await shot(page, SE, '63-exam-question-drill', {
        wait: 0,
        expect: { url: EX, markers: ['第 8 题'] },
      })
      await step(SE, async () => {
        await page.getByLabel('关闭').first().click()
        await page.waitForTimeout(300)
      })

      await step(SE, async () => {
        // 个人诊断：薄弱知识点 + 薄弱题号 + 个人趋势
        // （学生行的无障碍名是「学号 号 姓名」，与作业页那一套保持一致）
        await page.getByRole('button', { name: /^\d+ 号 / }).first().click()
        await page.waitForTimeout(600)
      })
      await shot(page, SE, '64-exam-student-diagnosis', {
        wait: 0,
        expect: { url: EX, markers: ['薄弱知识点 · 反复丢分的地方'] },
      })
      await step(SE, async () => {
        await page.getByLabel('关闭').first().click()
        await page.waitForTimeout(300)
      })

      const S65 = '65–66 新建考试档案'
      await goto(page, S65, '/exams/new', {
        markers: ['新建考试档案', '第 5 步 · 考试班级', '第 3 步 · 试卷结构（题量 / 题型 / 分值）'],
        date: D0919,
      })
      await shot(page, S65, '65-exam-new', { full: true, wait: 0 })

      await step(S65, async () => {
        // 四川新高考题型待选清单（**要交给老师确认的那份**）
        await page.getByRole('button', { name: '套用题型清单' }).click()
        await page.waitForTimeout(600)
      })
      await shot(page, S65, '66-exam-preset-sheet', {
        full: true,
        wait: 0,
        expect: { url: '/exams/new', markers: ['四川新高考'] },
      })
      await step(S65, async () => {
        await page.getByLabel('关闭').first().click()
        await page.waitForTimeout(300)
      })

      const S67 = '67–73 考试批阅'
      const EG = '/exams/ex-demo-1/grade'
      /**
       * 批阅页的独有文本。
       * ⚠️ 「待批改 · 3 人 / 已批阅 · 42 人」这两条**只在整张表**上（没展开具体学生时）——
       *    点开一个学生之后名单会被顶掉，所以那一张图的断言只能要「考试批阅」+「已录 x/15 题」。
       */
      const eg = { url: EG, markers: ['考试批阅', '待批改 · 3 人', '已批阅 · 42 人'] }
      const egOne = { url: EG, markers: ['考试批阅', '已录'] }

      await goto(page, S67, EG, { ...eg, date: D0919 })
      await shot(page, S67, '67-exam-grade-list', { full: true, wait: 0 })

      await step(S67, async () => {
        await page.getByRole('button', { name: /^\d+ 号 / }).first().click()
        await page.waitForTimeout(400)
      })
      await shot(page, S67, '68-exam-grade-one-student', { full: true, wait: 0, expect: egOne })

      /*
       * 多选题选一部分 → 按 m/n 给分（这一条是判分规则唯一能"看得见"的地方）。
       * ⚠️ 原来是 `if (await mc.count())` —— **找不到就静默少一张图**。
       *    现在改成硬断言：演示数据里第 8 题就是多选题，找不到就是真坏了。
       */
      const mc = page.getByRole('button', { name: /第 8 题选 [A-D]/ }).first()
      await step(S67, async () => {
        const n = await mc.count()
        check(n > 0, '找到第 8 题的多选项按钮（多选题选一部分按 m/n 给分）', `匹配到 ${n} 个`)
        if (!n) throw new Error('找不到「第 8 题选 X」按钮 —— 这道题不是多选了？')
        await mc.click()
        await page.waitForTimeout(250)
      })
      await shot(page, S67, '69-exam-grade-multi-partial', { full: true, wait: 0, expect: egOne })

      await step(S67, async () => {
        // 确认批阅 → **回到整张表**（不是下一个学生顶上来）
        await page.getByRole('button', { name: '确认批阅' }).click()
        await page.waitForTimeout(600)
      })
      await shot(page, S67, '70-exam-grade-after-confirm', {
        full: true,
        wait: 0,
        // 刚确认的那个人从「待批改」挪到「已批阅」：3 → 2、42 → 43
        expect: { url: EG, markers: ['考试批阅', '待批改 · 2 人', '已批阅 · 43 人'] },
      })

      await step(S67, async () => {
        // 批阅完成：两条路（临时保存 / 确认完成）+ 确认完成的二次确认
        await page.getByRole('button', { name: '批阅完成' }).click()
        await page.waitForTimeout(400)
      })
      await shot(page, S67, '71-exam-finish-choose', {
        wait: 0,
        expect: { url: EG, markers: ['确认完成'] },
      })
      await step(S67, async () => {
        await page.getByRole('button', { name: '确认完成' }).click()
        await page.waitForTimeout(400)
      })
      await shot(page, S67, '72-exam-finish-confirm-zero', {
        full: true,
        wait: 0,
        expect: { url: EG, markers: ['确认完成前请看一眼'] },
      })
      await step(S67, async () => {
        await page.getByRole('button', { name: '再改改' }).click()
        await page.waitForTimeout(200)
        // ⚠️ 同 25：临时保存成功后产品自己跳回**考试列表**（/exams），不是留在批阅页
        await page.getByRole('button', { name: '临时保存' }).click()
        await page.waitForURL('**/exams', { timeout: 8000 })
        await page.waitForTimeout(700)
      })
      await shot(page, S67, '73-exam-draft-saved', {
        full: true,
        wait: 0,
        expect: { url: '/exams', markers: ['已临时保存，之后可以接着批', '考试'] },
      })

      /* ================= 桌面 ================= */

      const SDE = '10/16 桌面宽屏'
      const wide = await ctx.newPage()
      wide.on('pageerror', (e) => errors.push(`PAGEERROR(wide) :: ${e.message}`))
      wide.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(wide) :: ${m.text()}`)
      })

      await step(SDE, async () => {
        await wide.setViewportSize({ width: 1440, height: 940 })
        await wide.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await wide.waitForTimeout(700)
        await expectPage(wide, SDE, {
          url: '/',
          markers: ['今日待办'],
          date: D0919,
        })
        // 桌面是左栏导航（胶囊是 lg:hidden 的）—— 别把移动端那一套当桌面
        const nav = await wide.evaluate(() => {
          const pill = document.querySelector('nav[aria-label="主导航"]')
          return {
            pillDisplay: pill ? getComputedStyle(pill).display : '(没有这个元素)',
            aside: Boolean(document.querySelector('aside')),
          }
        })
        check(nav.aside, '桌面用的是左栏（aside），不是移动端胶囊', `aside=${nav.aside}；胶囊 display=${nav.pillDisplay}`)
      })
      await shotRaw(wide, SDE, '10-desktop')

      await step(SDE, async () => {
        await wide.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
        await wide.waitForTimeout(700)
        await expectPage(wide, SDE, { url: '/assignments', markers: ['5 份档案'] })
      })
      await shotRaw(wide, SDE, '16-desktop-assignments', { full: true })

      /* ============ 当前身份标签：有管理身份显示身份，没有才显示学科 ============ */

      /*
       * 🔴 2026-09-25 用户截图报的错：**最高管理员的侧栏标签写着「物理」**。
       * 根因不是标签取错了字段，而是 `teachers.subject` **有列默认值 `'物理'`**
       * （列默认值不改，那是破坏性迁移，见 §12.5）—— 于是每个账号都有学科，
       * 连不教课的账号也被挂上"物理"。学科回答的是"教什么"，身份回答的是"是谁"。
       *
       * 规则：先看有没有**管理身份**（super / admin / grade_head / head_teacher），
       * 有就显示身份，没有才显示学科。
       *
       * 🔴 **2026-09-27 需求变更（用户拍板）：多身份全部露出来**，不再"只取最高一档"。
       *   上一轮那个取舍（只显示最高一档）是 agent 自己拍的，理由是"标签在侧栏里挨着姓名，
       *   拼成长串会撑破"——用户否掉了：同时是年级主任和班主任，只写一个等于把另一重藏起来。
       *   所以下面的期望值从「年级主任」改成「年级主任 · 班主任」这类**拼接**串：
       *   这是**需求变更导致的期望值变更**，不是为了让红灯变绿。
       *   由此带来的布局约束（侧栏 194px / 手机上设置页卡片那一行约 216px）在后面
       *   "真界面"那一半里**逐条量**：标签有没有捅出侧栏、姓名有没有被挤成竖排、整页有没有横向溢出。
       *
       * 分两层钉（缺哪一层都会漏掉一种改法）：
       *   ① **纯函数**：Node 直接 import 仓库里的真 `src/lib/roles.ts`（不是复刻一份逻辑，
       *      与 exam-checks / backup-checks 同一手法）；
       *   ② **真界面**：把 `myRoles` 注入 store 快照，看**侧栏那个标签真的写什么** ——
       *      否则"组件根本不读 `myRoles`"（2026-09-25 修的就是这个）不会有任何东西变红。
       *
       * ⚠️ **正反两面都要**：有身份 → 身份，**没有身份 → 照旧显示学科**。
       *    只钉正向的话，把标签改成写死的身份、或者把学科那一半删掉，照样绿。
       */

      const SID = '身份标签'

      await step(SID, async () => {
        /* ① 纯函数：显示规则本身（四档身份 / 全露 + 顺序 + 去重 / 退回学科 / 认不出不猜） */
        const R = await import('../src/lib/roles.ts')
        const subj = { subject: '物理', primarySubjectCode: 'physics' }
        const one = (role) => [{ role }]
        for (const [role, want] of [
          ['super', '最高管理员'],
          ['admin', '教务处'],
          ['grade_head', '年级主任'],
          ['head_teacher', '班主任'],
        ]) {
          check(
            R.currentIdentityLabel(one(role), subj) === want,
            `${SID}：${role} → 「${want}」（有管理身份就显示身份，不显示学科）`,
            `读到「${R.currentIdentityLabel(one(role), subj)}」`,
          )
        }
        check(
          R.currentIdentityLabel(one('admin'), subj) === R.roleName('admin'),
          `${SID}：「教务处」这个显示名**复用 lib/roles.ts 里那一个**（没另起一个词）`,
          `roleName('admin')=「${R.roleName('admin')}」，标签=「${R.currentIdentityLabel(one('admin'), subj)}」`,
        )
        /* 🔴 多身份：**全露**（2026-09-27 用户拍板），顺序按 MANAGING_ROLES 的优先级 */
        check(
          R.currentIdentityLabel([...one('head_teacher'), ...one('grade_head')], subj) === '年级主任 · 班主任',
          `${SID}：多身份**全露出来**（班主任 + 年级主任 → 「年级主任 · 班主任」）`,
          `读到「${R.currentIdentityLabel([...one('head_teacher'), ...one('grade_head')], subj)}」`,
          '数组顺序是班主任在前，但显示顺序按身份优先级（super > admin > grade_head > head_teacher）',
        )
        check(
          R.currentIdentityLabel([...one('grade_head'), ...one('head_teacher')], subj) ===
            R.currentIdentityLabel([...one('head_teacher'), ...one('grade_head')], subj),
          `${SID}：显示顺序**不取决于数组先后**（两种写法读出同一个串）`,
          `A=「${R.currentIdentityLabel([...one('grade_head'), ...one('head_teacher')], subj)}」，B=「${R.currentIdentityLabel([...one('head_teacher'), ...one('grade_head')], subj)}」`,
        )
        check(
          R.currentIdentityLabel([...one('head_teacher'), ...one('super'), ...one('admin')], subj) ===
            '最高管理员 · 教务处 · 班主任',
          `${SID}：三个身份全露、且按优先级排（超管 > 教务处 > 班主任）`,
          `读到「${R.currentIdentityLabel([...one('head_teacher'), ...one('super'), ...one('admin')], subj)}」`,
        )
        check(
          R.currentIdentityLabel(
            [...one('super'), ...one('admin'), ...one('grade_head'), ...one('head_teacher')],
            subj,
          ) === '最高管理员 · 教务处 · 年级主任 · 班主任',
          `${SID}：四档身份全给 → 四个都写出来（这是宽度上的极值，布局断言盯的就是它）`,
          `读到「${R.currentIdentityLabel([...one('super'), ...one('admin'), ...one('grade_head'), ...one('head_teacher')], subj)}」`,
        )
        check(
          R.currentIdentityLabel(
            [...one('head_teacher'), { role: 'head_teacher' }, ...one('grade_head')],
            subj,
          ) === '年级主任 · 班主任',
          `${SID}：同名身份**只写一次**（班主任带两个班 = 两行 head_teacher，不许出现「班主任 · 班主任」）`,
          `读到「${R.currentIdentityLabel([...one('head_teacher'), { role: 'head_teacher' }, ...one('grade_head')], subj)}」`,
        )
        check(
          R.currentIdentityLabel(one('teacher'), subj) === '物理',
          `${SID}：只有「任课教师」这一档**不算管理身份** → 照旧显示学科`,
          `读到「${R.currentIdentityLabel(one('teacher'), subj)}」`,
        )
        check(
          R.currentIdentityLabel([], subj) === '物理' && R.managingRoleLabel([]) === '',
          `${SID}：一条身份都没有 → 照旧显示学科（teachers.subject 那个默认值仍然只当学科用）`,
          `标签=「${R.currentIdentityLabel([], subj)}」，managingRoleLabel=「${R.managingRoleLabel([])}」`,
        )
        check(
          R.currentIdentityLabel([], { subject: '物理竞赛' }) === '物理竞赛',
          `${SID}：没有身份时老师**自己写的显示名照旧**（「物理竞赛」不许被抹成「物理」）`,
          `读到「${R.currentIdentityLabel([], { subject: '物理竞赛' })}」`,
        )
        check(
          R.currentIdentityLabel([{ role: 'dean' }], subj) === 'dean',
          `${SID}：库里出现**认不出的角色代码**时按身份原样显示，**不退回学科**`,
          `读到「${R.currentIdentityLabel([{ role: 'dean' }], subj)}」`,
          '把身份显示成"物理"正是 2026-09-25 要修的那个错，宁可显示一个生代码',
        )
        check(
          R.currentIdentityLabel([{ role: 'dean' }, { role: 'wizard' }], subj) === 'dean · wizard',
          `${SID}：认不出的角色代码**也全露**（原样回显、按数组先后，排在认得出的身份后面）`,
          `读到「${R.currentIdentityLabel([{ role: 'dean' }, { role: 'wizard' }], subj)}」`,
          '⚠️ 原先这一格用的是 principal —— 2026-09-28 它变成了真身份（校长），所以换成一个真的认不出的代码',
        )
        check(
          R.currentIdentityLabel([{ role: 'dean' }, ...one('head_teacher')], subj) === '班主任 · dean',
          `${SID}：认得出的身份排在前面、认不出的原样跟在后面（优先级表里没有生代码的位置）`,
          `读到「${R.currentIdentityLabel([{ role: 'dean' }, ...one('head_teacher')], subj)}」`,
        )
        check(
          R.currentIdentityLabel(null, null) === R.currentIdentityLabel([], null),
          `${SID}：连老师都还没有（未登录）时不崩，且与"没有身份"走同一条路`,
          `读到「${R.currentIdentityLabel(null, null)}」`,
          '`teachers` 还没到时 subject 是空的 → 落回字典兜底（学科那一半的老行为）',
        )
      })

      /*
       * ② 真界面。注入方式说明：
       *   `myRoles` **不在** persist 的 `partialize` 里（它跟着会话走，不落盘），
       *   而这个脚本的 `addInitScript` 又是**每次导航前重写整份快照** ——
       *   所以用一个只在这个脚本里用的 `?roles=`（产品代码读都不读它）把这一轮要注入的
       *   身份带进去，再由 initScript 拼进快照。
       *   能生效是因为 persist 的 merge 是"**快照浅合并到初始状态**"：快照里带上 `myRoles`
       *   就会被采用 —— 与 §九 那条"注入的 teacher/classes 覆盖初始状态"是同一个机制。
       *   独立 context：主流程那个 `ctx` 的 initScript 写死了不带身份的快照。
       */
      const ctxId = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'zh-CN' })
      await ctxId.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxId.addInitScript((base) => {
        const raw = new URLSearchParams(location.search).get('roles')
        const state = raw ? { ...base, myRoles: JSON.parse(raw) } : base
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE.state)

      const idPage = await ctxId.newPage()
      idPage.on('pageerror', (e) => errors.push(`PAGEERROR(身份标签) :: ${e.message}`))
      idPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(身份标签) :: ${m.text()}`)
      })

      /**
       * 三处「当前身份」标签各读一次（侧栏 / 工作台问候 / 设置页身份卡），
       * 外加**布局几何**（这一轮改成"多身份全露"之后才需要的）。
       *
       * **只认"真的看得见"的元素**（`getBoundingClientRect` 有宽高）：不然标签被挪进
       * 隐藏容器里时断言会变成"读得到 DOM 就算过"的假绿。
       *
       * 布局那三个数（都实测过修之前的坏值，见 §13.10）：
       *   · `railTagRight` vs `railInnerRight`：标签有没有**捅出侧栏**（4 个身份时曾溢出 41px）；
       *   · `railRowScrollOver`：那一行的内容宽超出可视宽多少（>0 = 真的挤出去了）；
       *   · `nameH`：姓名那个 `span` 的高度 —— 标签 `nowrap` 又不肯缩，**能屈能伸的只有姓名**，
       *     所以姓名会被压成竖排（实测「王老师」变成三行、行高 70px）。单行约 21px，>26 就是被折了。
       */
      const idTags = (p) =>
        p.evaluate(() => {
          const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
          const shown = (el) => {
            if (!el) return ''
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0 ? norm(el.textContent) : ''
          }
          const box = (el) => {
            if (!el) return null
            const b = el.getBoundingClientRect()
            return { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }
          }
          const over = (el) => (el ? el.scrollWidth - el.clientWidth : null)
          const label = [...document.querySelectorAll('div, span')].find(
            (e) => e.children.length === 0 && norm(e.textContent) === '当前身份',
          )
          const h1 = [...document.querySelectorAll('h1')].find((h) => norm(h.textContent).includes('王老师'))
          const benchTagEl = h1?.parentElement?.querySelector('.tag')
          const railBlock = label?.closest('.rail-block')
          const railTagEl = railBlock?.querySelector('.tag')
          const nameEl = railTagEl?.parentElement?.querySelector('span')
          const railEl = document.querySelector('.floating-rail')
          const setTagEl = document.querySelector('.panel .tag-accent')
          return {
            rail: shown(railTagEl),
            bench: shown(benchTagEl),
            setting: shown(setTagEl),
            railTagRight: box(railTagEl)?.right ?? null,
            // 侧栏内容右缘 = 侧栏右缘 − p-4 的 16 − 1px 边框（`IDENTITY_TAG_STYLE` 的注释里有出处）
            railInnerRight: railEl ? Math.round(railEl.getBoundingClientRect().right) - 17 : null,
            railRowScrollOver: over(railTagEl?.parentElement),
            railTagH: box(railTagEl)?.h ?? null,
            nameH: box(nameEl)?.h ?? null,
            benchRowScrollOver: over(benchTagEl?.parentElement),
            settingRowScrollOver: over(setTagEl?.parentElement),
            settingTagRight: box(setTagEl)?.right ?? null,
            settingRowRight: box(setTagEl?.parentElement)?.right ?? null,
            pageScrollOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })

      await step(SID, async () => {
        const cases = [
          { roles: [{ role: 'super' }], want: '最高管理员', why: '最高管理员' },
          { roles: [{ role: 'admin' }], want: '教务处', why: '教务处（原「教导处」，2026-09-28 改名）' },
          { roles: [{ role: 'grade_head' }], want: '年级主任', why: '年级主任' },
          { roles: [{ role: 'head_teacher' }], want: '班主任', why: '班主任' },
          { roles: [{ role: 'teacher' }], want: '物理', why: '只有任课教师这一档' },
          { roles: [], want: '物理', why: '一条身份都没有' },
          {
            roles: [{ role: 'head_teacher' }, { role: 'grade_head' }],
            want: '年级主任 · 班主任',
            why: '多身份：班主任 + 年级主任（两个）',
          },
          {
            roles: [{ role: 'super' }, { role: 'admin' }, { role: 'head_teacher' }],
            want: '最高管理员 · 教务处 · 班主任',
            why: '多身份：三个',
          },
          {
            roles: [{ role: 'super' }, { role: 'admin' }, { role: 'grade_head' }, { role: 'head_teacher' }],
            want: '最高管理员 · 教务处 · 年级主任 · 班主任',
            why: '多身份：四个（宽度极值）',
          },
          /*
           * 🆕 2026-09-28：**组长两档也要显示成身份**（不是学科）。
           * 理由（方案 §5.6 的建议，本轮采纳）：组长是**身份**，不是学科 ——
           * 「教研组长」比「物理」更能回答"这个人是谁"。
           * ⚠️ 它同时是一条**布局**断言的前哨：多一档身份会让标签更长（见 §13.10 的宽度表）。
           */
          {
            roles: [{ role: 'subject_lead', subjectCode: 'physics' }],
            want: '教研组长',
            why: '🆕 教研组长（组长是身份，不是学科）',
          },
          {
            roles: [{ role: 'lesson_prep_lead', subjectCode: 'physics' }],
            want: '备课组长',
            why: '🆕 备课组长',
          },
          {
            roles: [
              { role: 'moral_edu_head' },
              { role: 'office_head' },
              { role: 'head_teacher' },
            ],
            want: '办公室主任 · 德育处主任 · 班主任',
            why: '🆕 职能部门两档 + 班主任（优先级：办公室主任 > 德育处主任 > 班主任）',
          },
        ]
        for (const c of cases) {
          const q = encodeURIComponent(JSON.stringify(c.roles))
          await idPage.goto(`${BASE}/?roles=${q}`, { waitUntil: 'networkidle' })
          let tags = { rail: '', bench: '', setting: '' }
          // 轮询等标签渲染出来，而不是拍一个固定时长（慢机器上那就是随机红）
          for (let i = 0; i < 30; i++) {
            tags = await idTags(idPage)
            if (tags.rail) break
            await idPage.waitForTimeout(100)
          }
          check(
            tags.rail === c.want,
            `${SID}：${c.why} → 侧栏标签写「${c.want}」`,
            `读到「${tags.rail}」`,
          )
          /*
           * 工作台那一处**也读**：三处标签是三段独立代码（侧栏 / 工作台 / 设置页），
           * 只钉一处的话"改了一处漏了另两处"照样绿。这里顺带钉住
           * 「管理员不再显示物理」与「没身份的老师照旧显示物理」这一对正反例。
           */
          check(
            tags.bench === c.want,
            `${SID}：${c.why} → 工作台问候那一行也是「${c.want}」`,
            `读到「${tags.bench}」`,
          )
          /*
           * 🔴 布局三连（多身份全露之后**必须**有人盯着，否则"标签捅出侧栏"只能靠人眼在图里发现）：
           *   ① 标签右缘不越过侧栏内容右缘；② 那一行没有横向溢出；③ 姓名没被挤成竖排。
           * 修之前实测：3 个身份时姓名被压成竖排（行高 70px）、4 个身份时标签溢出侧栏 41px。
           */
          check(
            tags.railRowScrollOver === 0 && tags.railTagRight <= tags.railInnerRight,
            `${SID}：${c.why} → 侧栏标签没有捅出侧栏（这一行不横向溢出）`,
            `标签右缘 ${tags.railTagRight} / 侧栏内容右缘 ${tags.railInnerRight}，行内溢出 ${tags.railRowScrollOver}px，标签高 ${tags.railTagH}px`,
          )
          check(
            tags.nameH !== null && tags.nameH <= 26,
            `${SID}：${c.why} → 姓名没有被挤成竖排（标签不肯缩时，先被压的是姓名）`,
            `姓名框高 ${tags.nameH}px（单行约 21px，>26 就是折行了）`,
          )
          check(
            tags.benchRowScrollOver === 0 && tags.pageScrollOver === 0,
            `${SID}：${c.why} → 工作台那一行与整页都没有横向溢出`,
            `工作台行内溢出 ${tags.benchRowScrollOver}px，整页横向溢出 ${tags.pageScrollOver}px`,
          )
        }

        /* 设置页身份卡是第三处（走一次真导航，别依赖上一步留下的状态） */
        await idPage.goto(`${BASE}/settings?roles=${encodeURIComponent('[{"role":"super"}]')}`, {
          waitUntil: 'networkidle',
        })
        let tags = { rail: '', bench: '', setting: '' }
        for (let i = 0; i < 30; i++) {
          tags = await idTags(idPage)
          if (tags.setting) break
          await idPage.waitForTimeout(100)
        }
        check(
          tags.setting === '最高管理员',
          `${SID}：设置页身份卡那个标签也写「最高管理员」（三处同一处实现）`,
          `读到「${tags.setting}」`,
        )
        /*
         * ⚠️ **期望值 2026-10-04 变了**：这一条原来是「关于」里那行**「学段学科」照旧写学科**
         *    （反向对照：少了它，把整页的"学科"都换成身份也能绿）。
         *    用户当天点名把那两行删了 ——「把学科学段和存储位置删了」⇒ 那两个词**必须不在**上屏，
         *    于是这条改成钉**删除本身**（`学段学科` + `存储` 那一行的值）。
         *    ⚠️ "学科"这件事本身照旧存在：身份卡那张 Sheet 的主学科还在（见 S26），
         *       删的只是「关于」里那一行显示。
         *    🧪 反向对照：把那一行塞回**源码副本**（内存里，不动磁盘）⇒ 同一条判据当场判假。
         */
        const body = await bodyText(idPage)
        const goneAboutRows = (s) =>
          !s.includes('学段学科') &&
          !s.includes('本机浏览器 · 未连云端') &&
          !s.includes('云端 · 手机与教室端共用一份')
        check(
          goneAboutRows(body),
          `${SID}：设置页「关于」里那两行（学段学科 / 存储）**按用户 2026-10-04 的要求删了** —— 期望值变了，不是这一页坏了`,
          `学段学科=${body.includes('学段学科')} · 存储那一行=${body.includes('本机浏览器 · 未连云端') || body.includes('云端 · 手机与教室端共用一份')} · 屏上还有「高中 · 物理」吗=${body.includes('高中 · 物理')}`,
          '反向对照：下面那条（把「学段学科」那一行塞回源码副本 ⇒ 判据当场假）',
        )
        {
          const setSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'Settings.tsx'), 'utf8')
          const rowBack = setSrc.replace(
            '<KV k="版本"',
            '<KV k="学段学科" v="高中 · 物理" />\n            <KV k="版本"',
          )
          check(
            rowBack !== setSrc && !goneAboutRows(rowBack),
            `🧪 ${SID} 反向对照：把「学段学科」那一行塞回**源码副本**（内存里，不动磁盘）⇒ 上面那条"那两个词都不在"当场不成立（证明它咬的是那两行本身）`,
            `副本真被改过=${rowBack !== setSrc} · 塞回去之后判据=${goneAboutRows(rowBack)}`,
          )
        }

        /*
         * 🔴 手机上（414px）设置页身份卡那一行 —— 这一轮布局上的**第二个现场**。
         * 实测修之前：3 个身份时这一行横向溢出 18px、4 个身份溢出 72px，
         * 溢出的正是右边那个学校标签（被面板裁掉，看不出"少了东西"）。
         */
        await idPage.setViewportSize({ width: 414, height: 880 })
        await idPage.goto(
          `${BASE}/settings?roles=${encodeURIComponent('[{"role":"super"},{"role":"admin"},{"role":"head_teacher"}]')}`,
          { waitUntil: 'networkidle' },
        )
        for (let i = 0; i < 30; i++) {
          tags = await idTags(idPage)
          if (tags.setting) break
          await idPage.waitForTimeout(100)
        }
        check(
          tags.setting === '最高管理员 · 教务处 · 班主任',
          `${SID}：手机上设置页身份卡也把三个身份全写出来（同一个函数，没有"手机版取最高"这种事）`,
          `读到「${tags.setting}」`,
        )
        check(
          tags.settingRowScrollOver === 0 && tags.settingTagRight <= tags.settingRowRight,
          `${SID}：手机上身份卡那一行没有横向溢出（3 个身份时曾经溢出 18px，挤掉的是右边学校标签）`,
          `标签右缘 ${tags.settingTagRight} / 那一行右缘 ${tags.settingRowRight}，行内溢出 ${tags.settingRowScrollOver}px`,
        )
        check(
          tags.pageScrollOver === 0,
          `${SID}：手机上的设置页整页没有横向溢出`,
          `整页横向溢出 ${tags.pageScrollOver}px`,
        )
        await shotRaw(idPage, SID, '79-role-multi-mobile')

        /*
         * 两张**留档图**：这一轮布局约束的两个现场（3 个身份 / 4 个身份下的侧栏）。
         * 图只是留档，真正的门是上面那几条几何断言 —— 它们红了才是真的坏了。
         */
        await idPage.setViewportSize({ width: 1440, height: 940 })
        for (const [name, roles] of [
          ['77-role-multi-3', [{ role: 'super' }, { role: 'admin' }, { role: 'head_teacher' }]],
          [
            '78-role-multi-4',
            [{ role: 'super' }, { role: 'admin' }, { role: 'grade_head' }, { role: 'head_teacher' }],
          ],
        ]) {
          await idPage.goto(`${BASE}/?roles=${encodeURIComponent(JSON.stringify(roles))}`, {
            waitUntil: 'networkidle',
          })
          await idPage.waitForTimeout(400)
          await shotRaw(idPage, SID, name)
        }
      })

      /*
       * ============================================================
       * 文件传教室端：**上传时选班级（多选）** 这条链路的回归（2026-09-28，schema.sql §19）
       * ============================================================
       * 为什么"读/写权限"那一半**不在这个脚本里**：它跑的是本地演示模式，
       * 而"教室端读得到本班的文件"是**数据库 RLS** 的事 —— 见 `rls-checks.mjs` 第七 / 十四节。
       *
       * ⚠️ 覆盖边界（写下来，免得以后有人以为这里验过了）：
       *    `/files` 这一页**只有连了云端才渲染上传界面**，本地模式那一支是
       *    「这个功能要把文件存到云端，现在还没连接」—— 所以**多选控件在浏览器里走不到**，
       *    "只教一个班时默认勾上那个班"这条只能钉在**纯函数**上（页面调的就是同一个函数，
       *    见 `lib/files.ts` 的 `defaultFileClassIds`）；落库载荷与"SQL 没跑也不崩"那两条
       *    在 `backup-checks.mjs` **第五节**（假 PostgREST + 真的 `lib/files.ts`）。
       *    这里另外补一条**真实页面**断言：本地模式下这一页照旧是那句"还没连接"，
       *    既不白屏、也**不摆上传控件**（摆出来就是点了没反应的假入口）。
       *
       * 时钟：主 context 停在 09-19 10:00（周六，且不在 6:30–9:00 欢迎弹窗窗口里），
       * 所以这一步不需要再拨表，也不会被欢迎弹窗干扰。
       */
      const SFL = '文件传教室（班级归属）'

      await step(SFL, async () => {
        const FL = await import('../src/lib/files.ts')
        const cA = { id: 'c1', name: '高二(1)班' }
        const cB = { id: 'c2', name: '高二(4)班' }
        const cC = { id: 'c3', name: '高三(1)班' }
        const J = (v) => JSON.stringify(v)

        /* ① 默认勾哪个班 —— "只教一个班就默认勾上"这条是用户点名的 */
        check(
          J(FL.defaultFileClassIds([cA], null)) === J(['c1']),
          `${SFL}：**只教一个班 → 默认就勾上那一个**（他不用操作）`,
          `读到 ${J(FL.defaultFileClassIds([cA], null))}`,
        )
        check(
          J(FL.defaultFileClassIds([cA], 'c1')) === J(['c1']),
          `${SFL}：在某个班的上下文里进来 → 默认勾那个班`,
          `读到 ${J(FL.defaultFileClassIds([cA], 'c1'))}`,
        )
        check(
          J(FL.defaultFileClassIds([cA, cB, cC], 'c2')) === J(['c2']),
          `${SFL}：教三个班、当前班是 4 班 → 只预填 4 班（既不是全勾，也不是一个都不勾）`,
          `读到 ${J(FL.defaultFileClassIds([cA, cB, cC], 'c2'))}`,
        )
        check(
          J(FL.defaultFileClassIds([cA, cB], null)) === J([]),
          `${SFL}：教多个班、又没有可用的上下文 → 一个都不勾（**不猜**，让他自己挑）`,
          `读到 ${J(FL.defaultFileClassIds([cA, cB], null))}`,
        )
        check(
          J(FL.defaultFileClassIds([cA], 'c9')) === J(['c1']),
          `${SFL}：当前班是个**陈旧的 id**（班被删了/换设备了）→ 不认它，退回"只教一个班"那条`,
          `读到 ${J(FL.defaultFileClassIds([cA], 'c9'))}`,
        )
        check(
          J(FL.defaultFileClassIds([], 'c1')) === J([]),
          `${SFL}：一个班都没有 → 空（页面上另有一句话说明"传上去只有你自己看得见"）`,
          `读到 ${J(FL.defaultFileClassIds([], 'c1'))}`,
        )

        /* ② 勾选动作：多选要"加上去"；老库（列还没有）退化成单选 */
        check(
          J(FL.toggleFileClassIds(['c1'], 'c2')) === J(['c1', 'c2']),
          `${SFL}：多选 —— 再点一个班是**加**上去（同一个课件发给几个班）`,
          `读到 ${J(FL.toggleFileClassIds(['c1'], 'c2'))}`,
        )
        check(
          J(FL.toggleFileClassIds(['c1', 'c2'], 'c1')) === J(['c2']),
          `${SFL}：多选 —— 点已勾上的班是取消`,
          `读到 ${J(FL.toggleFileClassIds(['c1', 'c2'], 'c1'))}`,
        )
        check(
          J(FL.toggleFileClassIds(['c1'], 'c2', false)) === J(['c2']),
          `${SFL}：老库（class_ids 这一列还没有）→ 退化成单选：点另一个是**换过去**，不是并存`,
          `读到 ${J(FL.toggleFileClassIds(['c1'], 'c2', false))}`,
        )
        check(
          J(FL.toggleFileClassIds(['c1'], 'c1', false)) === J([]),
          `${SFL}：老库 + 取消勾选 → 空（"未指派"是合法状态，不是必填校验）`,
          `读到 ${J(FL.toggleFileClassIds(['c1'], 'c1', false))}`,
        )

        /* ③ 列表里那一行怎么写归属（"未指派"必须说出来，不能显示成空白） */
        check(
          FL.fileClassLabel([cA, cB], ['c1', 'c2']) === '高二(1)班、高二(4)班',
          `${SFL}：一行的归属写成班名（顿号分隔）`,
          `读到「${FL.fileClassLabel([cA, cB], ['c1', 'c2'])}」`,
        )
        check(
          FL.fileClassLabel([cA, cB], []).includes('教室端看不到'),
          `${SFL}：**没有归属的空态不许显示成空白** —— 写「未指派班级 · 教室端看不到」`,
          `读到「${FL.fileClassLabel([cA, cB], [])}」`,
        )
        check(
          FL.fileClassLabel([cA], ['c9']).includes('教室端看不到') && !FL.fileClassAssigned([cA], ['c9']),
          `${SFL}：归属指向一个**已经删掉的班** → 等于没归属（文案与强调色用同一个判据）`,
          `读到「${FL.fileClassLabel([cA], ['c9'])}」，assigned=${FL.fileClassAssigned([cA], ['c9'])}`,
        )
        check(
          FL.fileClassAssigned([cA], ['c1']),
          `${SFL}：认得出的归属才算"有归属"（下一行那条"未指派"不是恒假的装饰）`,
          `assigned=${FL.fileClassAssigned([cA], ['c1'])}`,
        )

        /* ④ 真界面：本地模式下这一页还是"没连云端"，且不许把上传控件摆出来 */
        crumb('goto /files')
        await page.goto(`${BASE}/files`, { waitUntil: 'networkidle' })
        await expectPage(page, SFL, {
          url: '/files',
          // 期望值变了：这句原文是「这个功能要把文件存到云端，现在还没连接。连上 Supabase
          // 之后就能用了。」—— 文案审查判它改写（`Supabase` 是实现细节，老师不需要知道），
          // 现在写「还没有连接云端，暂时传不了文件。」
          markers: ['教室端文件', '还没有连接云端'],
          absent: ['给哪些班看', '选择文件'],
        })
      })

      /*
       * ============================================================
       * 超管运维面板（`超管运维面板方案.md` 第一期）
       * ============================================================
       * 这个脚本能验的是**前端那一半**：入口不被 `Guard` 拦、五条指标各自的画面、
       * E7 的矛盾真的能被点出来。**服务端那一半**（权限判据、GitHub/配置回话）
       * 在 `admin-checks.mjs`（假 Supabase + 真 Function），两边都要跑才算覆盖。
       *
       * 🔴 三轮，对应方案里两条拍板：
       *   ① **设备被标成教室端 + 没有登录态** → 敲 `/admin` **必须留在面板**（T6）。
       *      这是这一期最要紧的一条画面：修之前，`Guard` 会把这类设备一律送 `/login`，
       *      而 `/settings`（面板入口所在页）**也在 `Guard` 里** ——
       *      超管这台机器被锁住时**连面板都进不去**，而面板恰恰是用来救这种情况的。
       *   ② 恢复成正常教师端 → 面板渲染出 L0 健康条 + 五张卡 + 本地模式那条红警告（A3）。
       *   ③ 展开 E7 明细 → 演示数据里那份已知矛盾的档案被点出来。
       *
       * ⚠️ 身份注入沿用上面 SID 那一节的 `?roles=` 手法（`myRoles` 不落盘，
       *    所以只能靠 initScript 把快照喂进去）。**面板不读它**（判据在服务端），
       *    这里注入只是为了顺带验一下入口那一条不走 `canManageTeachers`。
       */
      const SAD = '超管运维面板'
      const ADMIN_ROLES = encodeURIComponent(JSON.stringify([{ role: 'super' }]))

      /* 独立 context：这个脚本主流程的 initScript 写死了 deviceRole='teacher'，
       * 而第 ① 轮**必须**是 classroom —— 共用一个 context 会互相打架。 */
      const ctxAd = await browser.newContext({ viewport: { width: 414, height: 880 }, locale: 'zh-CN' })
      await ctxAd.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxAd.addInitScript((base) => {
        const raw = new URLSearchParams(location.search).get('roles')
        const state = raw ? { ...base, myRoles: JSON.parse(raw) } : base
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
        // 🔴 这一行就是第 ① 轮的全部前提：这台机器"被标成教室端"
        window.localStorage.setItem('shugao.deviceRole', 'classroom')
      }, TEACHER_STATE.state)

      const adPage = await ctxAd.newPage()
      adPage.on('pageerror', (e) => errors.push(`PAGEERROR(面板) :: ${e.message}`))
      adPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(面板) :: ${m.text()}`)
      })

      await step(SAD, async () => {
        await adPage.goto(`${BASE}/admin?roles=${ADMIN_ROLES}`, { waitUntil: 'networkidle' })
        await adPage.waitForTimeout(600)
        const info = await pageInfo(adPage)
        /*
         * ⚠️ `pageInfo().url` 是 `pathname + search`，而面板这一页带着 `?roles=`（注入身份用）。
         *    所以判据是 **startsWith**，不是相等 —— 要钉的是"**没被送去 /login**"，
         *    而不是"URL 里没有查询串"。
         */
        check(
          info.url.startsWith('/admin'),
          `${SAD}：**被标成教室端的设备敲 /admin 不会被 Guard 送去 /login**（停在 /admin）`,
          `停在 ${info.url}`,
          '这正是方案 §七 T6 那条拍板：面板必须能被"半坏状态"下的超管打开',
        )
        /*
         * 最硬的证据：**面板的 L0 健康条在**（本地模式 = 没登录态、设备又是 classroom）。
         * 旧行为是"设备标记为教室端 → 只给登录卡"，那样最该看到信息的人反而看不到 ——
         * 这一条断言钉的就是"体检结果照样拿得出来"。
         */
        const l0Locked = await adPage.evaluate(() =>
          document.querySelector('[data-admin-l0]')
            ? document.querySelector('[data-admin-l0]').getAttribute('data-admin-l0')
            : null,
        )
        check(
          l0Locked !== null,
          `${SAD}：而且在锁定状态下**照样渲染出体检结果**（L0 健康条在），不是只给一张登录卡`,
          `data-admin-l0 = ${l0Locked}`,
          '面板存在的全部意义就是"被锁住时也看得到"',
        )
        check(
          info.body.includes('这台设备被标成教室端') &&
            info.body.includes('教师端的每个页面') &&
            info.body.includes('/admin'),
          `${SAD}：并且显式说清"这台设备被标成教室端 → 教师端每个页面都进不去，而这一页不经过 Guard"`,
          short(info.body.match(/.{0,20}这台设备被标成教室端.{0,80}/)?.[0] ?? info.body, 180),
        )
        await shot(adPage, SAD, '80-admin-locked-entry', { full: true })
      })

      /* ②③ 正常态：改回教师端，再进一次 */
      await ctxAd.addInitScript(() => window.localStorage.setItem('shugao.deviceRole', 'teacher'))

      await step(SAD, async () => {
        await adPage.goto(`${BASE}/admin?roles=${ADMIN_ROLES}`, { waitUntil: 'networkidle' })
        await adPage.waitForTimeout(600)
        const info = await pageInfo(adPage)
        const b = info.body
        check(info.url.startsWith('/admin'), `${SAD}：正常态也停在 /admin`, `停在 ${info.url}`)

        /* --- L0 健康条：一句话 + 一个颜色 --- */
        const l0 = await adPage.evaluate(() => {
          const el = document.querySelector('[data-admin-l0]')
          return el ? el.getAttribute('data-admin-l0') : null
        })
        check(
          l0 === 'bad' || l0 === 'warn' || l0 === 'unknown',
          `${SAD}：L0 健康条给出了颜色（本地模式下不该是绿）`,
          `data-admin-l0 = ${l0}`,
          '本地模式 = 最危险的静默降级，必须压过其他一切',
        )
        check(
          b.includes('平台') && (b.includes('项要留意') || b.includes('拿不到数据') || b.includes('没有发现异常')),
          `${SAD}：L0 是一句人话（"基本正常 · N 项要留意"这种），不是一串数字`,
          short(b.split('\n').find((x) => x.includes('平台')) ?? '', 100),
        )
        /*
         * 🔴 2026-10-08 用户点名：「把这个黄点消了，反正也配不了」。
         *    黄档原来那三个字暗示"有个待办等着你"，而 ② 的 R2 / ③ 的 Artifact 备份
         *    **是永久且做不到的已知降级**（R2 要绑国际银行卡）→ 口径改成
         *    「要留意」+ 卡上写「降级中（已知）· 代价」。
         *    这条断言钉的就是**屏上**不许再出现那三个字（期望值变了，理由如上）。
         */
        check(
          !b.includes('需要处理'),
          `${SAD}：🔴 面板上**不再出现"需要处理"**（黄档改口径：那是"已知降级"，不是待办）`,
          short(b.match(/.{0,16}需要处理.{0,16}/)?.[0] ?? '（屏上没有这三个字）', 80),
        )
        check(
          b.includes('要留意'),
          `${SAD}：黄档的说法已经换成"要留意"（含已知降级）`,
          short(b.match(/.{0,10}要留意.{0,20}/)?.[0] ?? '', 80),
        )

        /* --- A3：本地模式那条红警告必须**首屏可见** --- */
        check(
          b.includes('本地模式') && b.includes('只写在这台浏览器里'),
          `${SAD}：**A3 本地模式**是最显眼的那一条（"所有数据只写在这台浏览器里"）`,
          short(b.match(/.{0,10}本地模式.{0,60}/)?.[0] ?? '', 140),
          '线上出现这个状态 = 构建变量丢了，而老师照样能建班批改、一个字都不报错',
        )
        check(
          b.includes('VITE_SUPABASE_URL') && b.includes('VITE_SUPABASE_ANON_KEY'),
          `${SAD}：而且给出了下一步（去 Cloudflare 检查这两个变量）`,
          '屏上有 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY',
        )

        /* --- 五张卡都在，且标题对得上第一批交付的五条指标 --- */
        for (const t of ['① 部署与版本', '② 配置完整性', '③ 备份（G2）', '④ 数据库结构漂移（C1）', '⑤ 作业档案内部矛盾（E7）']) {
          check(b.includes(t), `${SAD}：卡「${t}」在首屏`, b.includes(t) ? '在' : short(b, 200))
        }

        /* --- A1：版本号 + 构建哈希（开发态取不到哈希也必须说出来） --- */
        check(
          /v\d+\.\d+\.\d+/.test(b),
          `${SAD}：A1 显示版本号`,
          b.match(/v\d+\.\d+\.\d+[^\s]*/)?.[0] ?? '',
        )

        /* --- B1/B3：本地模式下必须写"无法判断"，**绝不能画绿** --- */
        check(
          b.includes('无法判断'),
          `${SAD}：B1/B3 在本地模式下显示"无法判断"（不是绿）`,
          short(b.match(/.{0,10}无法判断.{0,40}/)?.[0] ?? '', 120),
          '本项目最贵的教训：拿不到 ≠ 正常',
        )

        /* --- G2：字节数那一行必须在（哪怕当时是"捞不到"） ---
         * ⚠️ 明细默认**折叠**（方案 §3.4 第 1 条：L1 卡上不放明细），
         *    所以下面**先点开**再断言 —— 写成"首屏就该有"那是错的期望。
         *    找按钮用 `[data-admin-toggle]` 这个稳定钩子，不按可见文案找（文案改一个字不该弄红断言）。
         */
        await adPage.locator('[data-admin-toggle="③ 备份（G2）"]').click()
        await adPage.waitForTimeout(250)
        const g2 = (await pageInfo(adPage)).body
        check(
          g2.includes('最新备份大小') && g2.includes('字节数'),
          `${SAD}：点开 G2 之后，**字节数**单独摆了一行（只看成功/失败抓不住"合法但空的 .gz"那个坑）`,
          g2.includes('最新备份大小') ? '在' : short(g2, 220),
        )
        check(
          g2.includes('捞不到') || /\d+(\.\d+)?\s*(B|KB|MB)/.test(g2),
          `${SAD}：那一行要么给字节数、要么明写"捞不到"（**不许空着、也不许画成绿**）`,
          short(g2.match(/.{0,12}(捞不到|\d+(\.\d+)?\s*(B|KB|MB)).{0,50}/)?.[0] ?? '', 160),
        )
        check(
          g2.includes('服务端回话'),
          `${SAD}：拿不到的时候要说清**为什么**（"服务端回话"那一行是无条件的）`,
          g2.includes('服务端回话') ? '在' : short(g2, 220),
        )

        /* --- C1：**段清单跟着 schema.sql 走**（§35/§36/§37 也必须在），
         *    而且"登记节"与"面板探不到"要分得开 ---
         *  ⚠️ 2026-10-08 用户原话：「数据表，我们都更新到多少了，怎么这里只能探到这些」——
         *     旧面板只列 §10–§19（清单是手写死的一段）。期望值因此整段改了。 */
        await adPage.locator('[data-admin-toggle="④ 数据库结构漂移（C1）"]').click()
        await adPage.waitForTimeout(250)
        const c1 = (await pageInfo(adPage)).body
        for (const st of ['§10', '§15', '§17', '§18', '§19', '§35', '§36', '§37']) {
          check(c1.includes(st), `${SAD}：C1 总表列出了 ${st}`, c1.includes(st) ? '在' : '没找到')
        }
        check(
          (await adPage.locator('[data-admin-c1-conclusion]').count()) === 1,
          `${SAD}：C1 有**总结论**那一行（\`data-admin-c1-conclusion\`）`,
          `节点数 ${await adPage.locator('[data-admin-c1-conclusion]').count()}`,
        )
        const conclusion = await adPage.evaluate(
          () => document.querySelector('[data-admin-c1-conclusion]')?.textContent ?? '',
        )
        check(
          /*
           * ⚠️ 浏览器脚本跑的是**本地演示模式**（没有云端连接）→ 探不到任何一段，
           *    所以那时它必须说"**给不出总结论**"，而**不许**拿 schema.sql 的最后一段冒充。
           *    连真库时（`admin-checks` 的假库）那句才是「线上库已跑到 §NN」——
           *    两种形状都钉住，谁也不许把"没探到"说成一个段号。
           */
          /线上库已跑到\s*§\d+/.test(conclusion) || conclusion.includes('给不出总结论'),
          `${SAD}：总结论要么是「线上库已跑到 §NN」、要么明写"给不出总结论"（**不许拿 schema 末段冒充**）`,
          short(conclusion, 90),
        )
        check(
          /\d+\s*段可执行/.test(c1),
          `${SAD}：并且带上「共 N 段可执行」`,
          short(c1.match(/共[^\n]{0,40}/)?.[0] ?? '', 90),
        )
        check(
          c1.includes('登记节') && c1.includes('不需要探'),
          `${SAD}：**登记节单独标出来**（0 行可执行 SQL · 不需要探），没有和"没跑/已跑"混在一起`,
          short(c1.match(/.{0,10}登记节.{0,30}/)?.[0] ?? '', 90),
        )
        check(
          c1.includes('探不到') && c1.includes('不是没跑'),
          `${SAD}：探不到的那几段明写"面板探不到（不是没跑）"，**没有假装它是绿的、也没说它没跑**`,
          short(c1.match(/.{0,16}探不到.{0,30}/)?.[0] ?? '', 110),
        )
        check(
          c1.includes('pg_policies') || c1.includes('revoke'),
          `${SAD}：而且给得出理由（不是一句"探不到"就完了）`,
          short(c1.match(/.{0,12}(pg_policies|revoke).{0,50}/)?.[0] ?? '', 170),
        )

        /* --- E7 卡：报出矛盾份数（演示数据里 a-demo-1 有一处已知矛盾） --- */
        check(
          /作业档案\s*\d+\s*份/.test(b),
          `${SAD}：E7 卡报了扫了几份档案`,
          b.match(/作业档案[^\n]{0,20}/)?.[0] ?? '',
        )
        check(
          b.includes('自相矛盾') || b.includes('内部一致'),
          `${SAD}：E7 给出结论（自相矛盾 / 内部一致），不是只给一个数字`,
          b.match(/作业档案[^\n]{0,30}/)?.[0] ?? '',
        )

        await shot(adPage, SAD, '81-admin-overview', { full: true })

        /* --- ③ 展开 E7 明细：那五类检查逐条列出来 --- */
        await adPage.getByRole('button', { name: '看矛盾清单' }).click()
        await adPage.waitForTimeout(350)
        const b2 = await bodyText(adPage)
        for (const kind of ['未交 ∩ 已批改', '未交 ∩ 改错名单', '孤儿', 'collected 假真', '极简模式']) {
          check(b2.includes(kind), `${SAD}：E7 五类检查里有「${kind}」这一类`, b2.includes(kind) ? '在' : short(b2, 200))
        }
        /*
         * 🔴 隐私三级里的 B 类：明细**默认只给学号**，姓名必须显式点开。
         *
         * 两条硬断言，都按**结构**判、不按"具体是谁"判（换一份演示数据不该红）：
         *   ① 默认态：`[data-admin-names]` 这个节点**不存在**（姓名那一层根本没渲染），
         *      而且明细里读出来的学号**全是班内学号**（1–3 位数字，不是 7 位序列号 ——
         *      序列号是内部键，老师看到的东西不变，见 `lib/keys.ts`）；
         *   ② 点开之后：姓名那一层出现，而且读到的姓名**能在名单里找到**。
         */
        const namesLayerBefore = await adPage.evaluate(
          () => document.querySelectorAll('[data-admin-names]').length,
        )
        check(
          namesLayerBefore === 0,
          `${SAD}：E7 明细里**默认不渲染姓名那一层**（隐私 B 类：默认只给学号）`,
          `[data-admin-names] 节点数 = ${namesLayerBefore}`,
        )
        const nosText = await adPage.evaluate(() => {
          const els = [...document.querySelectorAll('[data-admin-nos]')]
          return els.map((e) => String(e.textContent ?? '').replace(/\s+/g, ' ').trim())
        })
        /*
         * 逐项判：每个学号都是 **1–3 位数字**，而且**一个 7 位序列号都没有**。
         * ⚠️ 别写成"整串匹配一个正则" —— `…另 N 人` 那句会被误伤（第一版就踩了）。
         */
        const nosTokens = nosText
          .join(' ')
          .split(/[、,\s]+/)
          .filter((x) => /^\d+$/.test(x))
        check(
          nosText.length > 0 &&
            nosTokens.length > 0 &&
            nosTokens.every((n) => n.length <= 3) &&
            !nosText.some((t) => /\d{7}/.test(t)),
          `${SAD}：明细里显示的是**班内学号**（1–3 位），不是 7 位序列号（序列号是内部键）`,
          short(nosText.join(' ｜ '), 120),
        )
        check(
          b2.includes('请勿投屏或截图'),
          `${SAD}：明细里固定一行"此页含学号／姓名，请勿投屏或截图"（方案 §5.4 的替代方案）`,
          b2.includes('请勿投屏或截图') ? '在' : '没找到',
        )
        check(
          b2.includes('未交 ∩ 改错名单') &&
            /-\s*\d+\s*人|有\s*\d+\s*人是未交|未交名单里有/.test(b2),
          `${SAD}：演示数据里那份已知矛盾（未交的人挂在改错名单里）**真的被点出来了**`,
          short(b2.match(/.{0,40}改错名单.{0,80}/)?.[0] ?? '', 200),
        )
        await shot(adPage, SAD, '82-admin-e7-detail', { full: true })

        /* --- 反过来：点「显示姓名」才出现姓名（B 类的"点开才看"那一层） --- */
        const nameBtn = adPage.getByRole('button', { name: '显示姓名' })
        check(
          (await nameBtn.count()) === 1,
          `${SAD}：明细里有「显示姓名」这个动作（B 类的第二层要有一个显式开关）`,
          `按钮数 ${await nameBtn.count()}`,
        )
        await nameBtn.click()
        let namesText = null
        for (let i = 0; i < 20; i++) {
          namesText = await adPage.evaluate(() => {
            const el = document.querySelector('[data-admin-names]')
            return el ? String(el.textContent ?? '').replace(/\s+/g, ' ').trim() : null
          })
          // 等到"真的读出人名"为止（`—` 是分隔符，不算）
          if (namesText && /[\u4e00-\u9fa5]/.test(namesText)) break
          await adPage.waitForTimeout(120)
        }
        check(
          namesText !== null && /[\u4e00-\u9fa5]/.test(namesText),
          `${SAD}：点了「显示姓名」之后才渲染姓名那一层（B 类要"显式操作"，且姓名排在学号之后）`,
          namesText === null ? '点了还是没有姓名那一层' : `读到「${short(namesText, 80)}」`,
        )
        const rosterNames = new Set(DEMO_CLASSES[0].students.map((s) => s.name))
        const readNames = String(namesText ?? '')
          .replace(/^—\s*/, '')
          .split('、')
          .map((x) => x.trim())
          .filter(Boolean)
        check(
          readNames.length > 0 && readNames.every((n) => rosterNames.has(n)),
          `${SAD}：而且读到的姓名**都在名单里**（不是空串、也不是编出来的）`,
          `读到 ${readNames.length} 个：${short(readNames.join('、'), 80)}`,
        )
        await shot(adPage, SAD, '83-admin-e7-names', { full: true })
      })

      /* ============================================================
         🆕 全站公告（2026-09-28 公告轮）—— 顶部横幅的**层叠**与弹窗的**排队**
         ------------------------------------------------------------
         🔴 这一节只验"**摆在哪、跟谁抢位置**"这一半（形态与层叠），另外两半在别处：
              · 「摆哪几条 / 弹几次 / 排序 / 生效区间」= `nav-checks.mjs` 的 **A10**（纯函数）；
              · 「谁能发 / 谁能读 / 一条都写不动」= `rls-checks.mjs` 的 **二·之六**（真 PGlite）。
         用户点名要**实测**的三件事（参考项目为它们写了 128 行的 `renderSiteAnnBar`）：
           ① 公告条与 `SyncErrorBanner`（`z-[70]`）**同时出现**时谁在上、会不会互相挡；
           ② 公告弹窗与**早间欢迎弹窗**同时到点怎么办（排队，不打架）；
           ③ 移动端不能把导航/内容挤没（`--top-stack-h` 那根变量）。

         ⚠️ 时钟：这一节自己开 context。公告条本身不吃时钟，但**早间欢迎弹窗**吃
            （6:30–9:00），所以第 ② 件事必须在 08:00 那一支里验。
         ============================================================ */
      const SAN = '全站公告'
      const ANN_ROLES = encodeURIComponent(JSON.stringify([{ role: 'super' }]))

      const ctxAnn = await browser.newContext({
        viewport: { width: 414, height: 880 },
        locale: 'zh-CN',
      })
      await ctxAnn.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxAnn.addInitScript((base) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(base))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
        /*
         * ⚠️ 这里**不许**清 `shugao.ann.*`（本轮踩过一次）：`addInitScript` 是**每次导航**都跑的，
         *    而"今天关过"那条断言专门要验"**刷新之后**仍然不显示" —— 在 initScript 里清掉它，
         *    等于把被测行为本身擦掉了（实测：断言读到 `hideDay = null`，看着像产品坏了）。
         *    这个 context 本来就是新的（localStorage 从空开始），不需要任何清理。
         */
      }, TEACHER_STATE)

      const annPage = await ctxAnn.newPage()
      annPage.on('pageerror', (e) => errors.push(`PAGEERROR(公告) :: ${e.message}`))
      annPage.on('console', (m) => {
        if (m.type() === 'error') errors.push(`CONSOLE(公告) :: ${m.text()}`)
      })

      /** 把公告这一摊的几何一次读回来（层叠规则全靠这些数） */
      const annProbe = (p) =>
        p.evaluate(() => {
          const r = (sel) => {
            const el = document.querySelector(sel)
            if (!el) return null
            const b = el.getBoundingClientRect()
            return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }
          }
          return {
            varTopStack: getComputedStyle(document.documentElement).getPropertyValue('--top-stack-h').trim(),
            /*
             * 🔴 状态栏那一段（2026-10-03 加）：用**探针 div** 量，不用 getComputedStyle。
             * ⚠️ 为什么不用 `getComputedStyle(document.documentElement).getPropertyValue('padding-top')`
             *    —— 那读到的是"我们写在哪"，不是"系统状态栏占了多高"；
             *    而 Web 侧 `AnnouncementStack.tsx` 里用的也是探针，两边口径必须一致。
             * ⚠️ 网页门禁里它恒为 0（桌面没有状态栏）—— 所以它钉的是"公式有这一项"，
             *    不是"apk 上真的让开了"（那要真机，见 §13 那条）。
             */
            insetTop: (() => {
              const probe = document.createElement('div')
              probe.style.cssText =
                'position:fixed;top:0;left:0;height:env(safe-area-inset-top,0px);'
              document.body.appendChild(probe)
              const h = Math.round(probe.getBoundingClientRect().height)
              probe.remove()
              return h
            })(),
            stack: r('[data-ann-stack]'),
            sync: r('[data-sync-error-banner]'),
            header: r('header.glass'),
            main: r('main'),
            bars: [...document.querySelectorAll('[data-ann-bar]')].map((el) => ({
              level: el.getAttribute('data-ann-bar'),
              text: String(el.innerText).replace(/\s+/g, ' ').trim(),
              box: (() => {
                const b = el.getBoundingClientRect()
                return { y: Math.round(b.y), h: Math.round(b.height) }
              })(),
            })),
            marquee: document.querySelector('[data-ann-marquee]')
              ? String(document.querySelector('[data-ann-marquee]').innerText).replace(/\s+/g, ' ').trim()
              : null,
            modal: r('.modal'),
            annPopup: document.querySelector('[data-ann-popup]')
              ? document.querySelector('[data-ann-popup]').getAttribute('data-ann-popup')
              : null,
            annPopupText: document.querySelector('[data-ann-popup]')
              ? String(document.querySelector('[data-ann-popup]').innerText).replace(/\s+/g, ' ').trim()
              : '',
            welcomeOpen: Boolean(document.getElementById('welcome-title')),
            hideDay: (() => {
              try {
                return window.localStorage.getItem('shugao.ann.hideDay')
              } catch {
                return null
              }
            })(),
            seen: (() => {
              try {
                const raw = window.localStorage.getItem('shugao.ann.seen')
                return raw ? Object.keys(JSON.parse(raw)) : []
              } catch {
                return 'ERR'
              }
            })(),
            previewKey: (() => {
              try {
                const raw = window.localStorage.getItem('shugao.ann.preview')
                return raw ? JSON.parse(raw).id : null
              } catch {
                return 'ERR'
              }
            })(),
          }
        })

      await step(SAN, async () => {
        await annPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(700)
        await expectPage(annPage, `${SAN}·顶部横幅`, {
          url: '/',
          markers: ['今日待办', '系统维护：今晚 23:00–23:30'],
        })
        const g = await annProbe(annPage)

        /* --- ① 横幅在、内容是那两条演示夹具（置顶的那条 = 独立横幅；普通的那条 = 滚动条） --- */
        check(
          g.stack !== null && g.stack.h > 0,
          `${SAN}：顶部有公告条（本机演示模式下有两条公告夹具）`,
          `高度 ${g.stack?.h ?? '(没有这个节点)'}px`,
        )
        check(
          g.bars.length === 1 && g.bars[0].level === 'important' && g.bars[0].text.includes('置顶'),
          `${SAN}：置顶那条走**独立横幅**（等级 important → 暖黄底 + "置顶"徽标）`,
          JSON.stringify(g.bars.map((b) => `${b.level}:${short(b.text, 40)}`)),
        )
        check(
          (g.marquee ?? '').includes('新功能：按学科看考试统计'),
          `${SAN}：普通那条在**滚动条**里（一行、最安静的那一档）`,
          short(g.marquee ?? '(没有滚动条)', 90),
        )

        /* --- ② 层叠：公告条在最上面，顶栏紧贴它之下，内容再往下 —— **一个都不许被压住** --- */
        check(
          g.stack.y === 0 && g.stack.bottom === g.header.y,
          `${SAN}：🔴 公告条贴在最顶（y=${g.stack?.y}），**移动端顶栏紧贴它之下**（${g.header?.y}）—— 谁也不压谁`,
          `stack ${g.stack?.y}~${g.stack?.bottom} · header ${g.header?.y}~${g.header?.bottom}`,
        )
        check(
          g.main.y >= g.header.bottom,
          `${SAN}：页面内容**没有被吃掉一行**（main 从 y=${g.main?.y} 开始，顶栏到 ${g.header?.bottom}）`,
          `视口 414×880 里公告条 + 顶栏共 ${g.header?.bottom ?? '?'}px（${Math.round(((g.header?.bottom ?? 0) / 880) * 100)}%）`,
        )
        check(
          g.varTopStack === `${g.stack.h}px`,
          `${SAN}：让位量走 **--top-stack-h**（一个变量，四个地方共用：左栏/右栏/移动顶栏/PageHead）`,
          `变量 ${g.varTopStack} · 实测高度 ${g.stack.h}px`,
        )
        await shot(annPage, SAN, '89-ann-bar-mobile')
      })

      /* --- ③ 「今天不再显示」：点滚动条的 × → 滚动条消失，但**置顶那条无视它** --- */
      await step(SAN, async () => {
        await annPage.click('[data-ann-close-marquee]')
        await annPage.waitForTimeout(300)
        const g = await annProbe(annPage)
        check(
          g.marquee === null && g.bars.length === 1,
          `${SAN}：滚动条那一行的「×」= **今天不再显示公告**；置顶/紧急**无视隐藏标志**（照参考项目）`,
          `滚动条 ${g.marquee === null ? '已收起' : '还在'} · 独立横幅 ${g.bars.length} 条`,
        )
        check(
          /^\d{4}-\d{2}-\d{2}$/.test(String(g.hideDay)),
          `${SAN}："今天"按**北京时间**记（shugao.ann.hideDay），**不落库** —— 平台不记谁关过`,
          `hideDay = ${g.hideDay}`,
        )
        check(
          g.stack.bottom === g.header.y && g.varTopStack === `${g.stack.h}px`,
          `${SAN}：收起之后让位量与顶栏位置**跟着变**（不是写死的一个数）`,
          `stack 高 ${g.stack.h}px · header y=${g.header.y}`,
        )
        await shot(annPage, SAN, '90-ann-bar-hidden-today')

        /* 刷新一次：这一条记在**本机**，所以刷新之后仍然不显示 */
        await annPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(500)
        const g2 = await annProbe(annPage)
        check(
          g2.marquee === null,
          `${SAN}：刷新之后**仍然不显示滚动条**（"今天关过"是本机记的，不是本次会话）`,
          `hideDay = ${g2.hideDay}`,
        )
      })

      /* --- ④ 与 `SyncErrorBanner`（z-[70]）**同时出现**：公告条给它让位，两条都读得到 --- */
      await step(SAN, async () => {
        /* `?sync=` 是 DEV-only 钩子（`lib/roles.ts` 的 `devInjectedSyncError()`）——
           没有它，"本地演示模式下永远不会出现的报错横幅"这件事根本测不了 */
        await annPage.goto(`${BASE}/?sync=${encodeURIComponent('演示用的同步错误')}`, {
          waitUntil: 'networkidle',
        })
        await annPage.waitForTimeout(600)
        const g = await annProbe(annPage)
        check(
          g.sync !== null && g.sync.y === 0,
          `${SAN}：同步出错横幅**在最顶**（z-[70]，y=${g.sync?.y}）`,
          `sync 高 ${g.sync?.h ?? '(没有)'}px`,
        )
        /*
         * 🔴 让位：公告条从**报错横幅的底边**开始 —— 既不重叠（压住 = 那条公告一个字都读不到），
         *    也不白让（多让一层就是白吃一屏）。
         *
         * ⚠️ 这里**不写 `===`**（原来写的是 `stack.y === sync.bottom`，本轮实测红）：
         *    那个 `top` 是 `AnnouncementStack` 里 `Math.ceil(报错横幅实测高度)` 写出来的，
         *    而这里读回来的是 `annProbe` 里 `Math.round` 的矩形 —— 同一个 58.25px 高的横幅，
         *    一边得 59、一边得 58（实测），**这 1px 是取整方式的差，不是"公告条被压住了"**。
         *    "被压住"会差一整个公告条的高度（35~69px），所以判据写成
         *    「落在 [底边, 底边+1px]」：上限挡压盖，下限挡白让，两头都还管着。
         *    反向对照（实测）：把公告条 `top` 注射成 0 → gap = -58 → **这条当场红**。
         */
        const gap = g.stack !== null && g.sync !== null ? g.stack.y - g.sync.bottom : null
        check(
          gap !== null && gap >= 0 && gap <= 1,
          `🔴 ${SAN}：公告条**给它让位**（公告条 y=${g.stack?.y} · 报错横幅底 ${g.sync?.bottom} · 差 ${gap}px）—— ` +
            '**不是被压在下面**（压住 = 那条公告一个字都读不到）',
          `sync ${g.sync?.y}~${g.sync?.bottom} · stack ${g.stack?.y}~${g.stack?.bottom} · 重叠 ${(g.sync?.bottom ?? 0) - (g.stack?.y ?? 0)}px`,
        )
        check(
          g.header.y === g.stack.bottom && g.main.y >= g.header.bottom,
          `${SAN}：顶栏与内容**依次往下**（顶栏 ${g.header?.y} · 内容 ${g.main?.y}）—— 三条互不遮挡`,
          `stack 底 ${g.stack?.bottom} · header ${g.header?.y}~${g.header?.bottom} · main ${g.main?.y}`,
        )
        /*
         * 让位量 = **报错横幅 + 公告条**（`--top-stack-h` 把两段加起来，四个地方共用那一个变量）。
         *
         * ⚠️ 1px 容差，理由与上面那条**同一个**：变量里是两段各自 `Math.ceil`，
         *    这里读回来的是 `Math.round` 的矩形（实测 58.25 → ceil 59 / round 58）。
         *    这一条要抓的是"只算了一段 / 一段都没算"（那会差 35~69px）。
         *    反向对照（实测）：把变量注射成"只有报错横幅"的 59px → **这条当场红**。
         */
        const wantTopStack = (g.sync?.h ?? 0) + (g.stack?.h ?? 0) + (g.insetTop ?? 0)
        const gotTopStack = Number.parseFloat(String(g.varTopStack))
        check(
          Number.isFinite(gotTopStack) && Math.abs(gotTopStack - wantTopStack) <= 1,
          `${SAN}：让位量 = **状态栏 + 报错横幅 + 公告条**（--top-stack-h 把三段加起来：${gotTopStack} ≈ ${g.insetTop ?? 0} + ${g.sync?.h ?? 0} + ${g.stack?.h ?? 0}）`,
          `变量 ${g.varTopStack} · 状态栏 ${g.insetTop ?? '(量不到)'}px + 报错横幅 ${g.sync?.h ?? '(没有)'}px + 公告条 ${g.stack?.h ?? '(没有)'}px = ${wantTopStack}px`,
        )
        /*
         * 🔴🔴 **状态栏那一段必须被算进去**（2026-10-03 加）。
         *
         * 用户在 apk 上看到「平台开始第一次范围公测」被系统状态栏压住 ——
         * 根因就是这个变量**只按自家元素高度算**，从来没算 `env(safe-area-inset-top)`。
         *
         * ⚠️ 这条在**网页门禁里恒为 0**：桌面浏览器没有状态栏，`env()` 返回 0。
         *    所以它**证明不了 apk 上的效果** —— 真正拦住那个 bug 的是
         *    `_src/android/.../MainActivity.java` 里的 edge-to-edge（那边 env() 才有值）。
         *    那边的判据是**源码级**（下面两条）+ 真机；本条只钉"公式里有这一项"。
         */
        check(
          typeof g.insetTop === 'number' && g.insetTop >= 0,
          `${SAN}：让位公式里**含**状态栏那一段（env(safe-area-inset-top)，网页上是 0）`,
          `inset-top = ${g.insetTop}px（网页门禁里必为 0；真值要看 apk）`,
          '少了这一项，apk 上那条公告会被系统状态栏压住',
        )
        await shot(annPage, SAN, '91-ann-with-sync-banner')
      })

      /* --- ⑥b 🔴 状态栏让位（2026-10-03，用户 apk 截图报出来的）**源码级** ---
       ⚠️ 编号是 ⑥b 而不是 ⑥ —— 下面已有一节「⑥ 桌面：左栏/右栏也要让位」（8289 行）。 */
      await step(SAN, async () => {
        /*
         * 🔴🔴 为什么这一节是**源码级**而不是量屏：
         *   症状发生在 **apk**（WebView 里），而这个门禁跑在**桌面浏览器**上 ——
         *   那里没有系统状态栏，`env(safe-area-inset-top)` **恒为 0**。
         *   ⇒ 「在屏上量出状态栏高度」这件事在网页门禁里**原理上做不到**。
         *
         *   所以这里钉的是**两侧口径一致**（缺任一侧都会坏）：
         *     ① Web 侧：`--top-stack-h` 的公式里**含** inset-top
         *     ② 原生侧：`MainActivity` 做了 edge-to-edge（不做的话 env() 恒 0，① 白写）
         *
         * ⚠️ 反向对照（实测过）：把 ① 里的 insetTop() 删掉 → ② 那条仍绿、
         *    而 apk 上那个 bug 原样复现 —— 所以**光有 ② 抓不住它**，
         *    两条必须都在。这是本节写下来的原因。
         */
        const annSrc = readFileSync(join(HERE, '..', 'src', 'components', 'AnnouncementStack.tsx'), 'utf8')
        /* 🔴🔴 判据必须**剥掉注释**再查 —— 实测踩过（2026-10-03）：
         *   第一版直接 `annSrc.match(/env\(safe-area-inset-top/)`，而这个文件里
         *   **注释正在 explaining 它**（文件头与 insetTop 那段都写着这个名字）——
         *   于是我把代码里的 env() 换成 0，断言**照样绿**。
         *   那是一条**恒绿的假断言**：它量的不是"代码里有没有"，是"文件里提没提"。
         *   ⚠️ 这是本仓库第二次同款（另一处是 `class_rep_pins` 那条）。
         *   → 统一：`stripComments()` 之后再查（见下面那个局部函数）。
         */
        const stripComments = (s) =>
          s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        const annCode = stripComments(annSrc)
        const webSideOk = /env\(\s*safe-area-inset-top/.test(annCode)
        check(
          webSideOk,
          `🔴 ${SAN}：让位公式里量了 env(safe-area-inset-top)（Web 侧口径，**剥掉注释后**查）`,
          webSideOk ? 'AnnouncementStack.tsx 的**代码**里读了 env(safe-area-inset-top)' : '🔴 剥掉注释后没有 —— apk 上会被状态栏压住',
          '少了这一项，公告条以为上面没人，就贴在 y=0',
        )

        // 原生侧：仓外那一份（壳不在 git 里，所以只查在不在 + 关键那句）
        const mainActivity =
          'C:\\Users\\Administrator\\Desktop\\树高教务通打包\\_src\\android\\app\\src\\main\\java\\com\\shugao\\jiaowu\\MainActivity.java'
        const hasNative = existsSync(mainActivity)
        const nativeSrc = hasNative ? readFileSync(mainActivity, 'utf8') : ''
        check(
          hasNative && /setDecorFitsSystemWindows\s*\(\s*getWindow\(\)\s*,\s*false\s*\)/.test(nativeSrc),
          `🔴 ${SAN}：原生侧做了 edge-to-edge（不设的话 env() 恒 0，Web 侧白写）`,
          hasNative
            ? /setDecorFitsSystemWindows/.test(nativeSrc)
              ? 'MainActivity 调了 setDecorFitsSystemWindows(window, false)'
              : '🔴 MainActivity 里没有 —— env() 会返回 0'
            : '🔴 找不到 MainActivity.java（壳的目录变了？）',
          '两侧口径必须一致，否则要么压住、要么多让一段空白',
        )
      })

      /* --- ⑤ 弹窗与**早间欢迎弹窗**同时到点：公告弹窗排队礼让（08:00 那一支） --- */
      await step(SAN, async () => {
        const ctxM = await browser.newContext({ viewport: { width: 414, height: 880 }, locale: 'zh-CN' })
        await ctxM.clock.install({ time: new Date('2026-09-19T08:00:00') })
        await ctxM.addInitScript(
          (payload) => {
            window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(payload.base))
            window.localStorage.setItem('shugao.deviceRole', 'teacher')
            window.localStorage.removeItem('shugao.ann.hideDay')
            window.localStorage.removeItem('shugao.ann.seen')
            /* 预览快照：模拟超管在 /admin 点了「预览」（那条是 urgent + 每人一次） */
            window.localStorage.setItem('shugao.ann.preview', JSON.stringify(payload.preview))
          },
          { base: TEACHER_STATE, preview: ANN_PREVIEW },
        )
        const pm = await ctxM.newPage()
        pm.on('pageerror', (e) => errors.push(`PAGEERROR(公告弹窗) :: ${e.message}`))
        pm.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(公告弹窗) :: ${m.text()}`)
        })
        try {
          await pm.goto(`${BASE}/`, { waitUntil: 'networkidle' })
          await pm.waitForTimeout(700)
          const g1 = await annProbe(pm)
          check(
            g1.welcomeOpen && g1.annPopup === null,
            `🔴 ${SAN}：08:00 进页面 —— **先弹早间欢迎**（"今天要批的作业"），公告弹窗**礼让、不抢位**`,
            `早间欢迎 ${g1.welcomeOpen ? '开着' : '没开'} · 公告弹窗 ${g1.annPopup ?? '没弹'}`,
          )
          check(
            g1.bars.length >= 1,
            `${SAN}：礼让的只是**弹窗** —— 顶部横幅照常在（"看得到"与"打断你"是两件事）`,
            `独立横幅 ${g1.bars.length} 条`,
          )

          /* 关掉早间欢迎 → 公告弹窗这才出现 */
          await pm.evaluate(() => {
            const b = [...document.querySelectorAll('.modal button')].find((x) => /开始今天/.test(x.textContent ?? ''))
            b?.click()
          })
          await pm.waitForTimeout(700)
          const g2 = await annProbe(pm)
          check(
            g2.annPopup === 'urgent' && g2.welcomeOpen === false,
            `🔴 ${SAN}：关掉早间欢迎之后，**公告弹窗才弹**（排队，不并行、也不丢）`,
            `弹窗等级 ${g2.annPopup ?? '没弹'} · 文案 ${short(g2.annPopupText, 60)}`,
          )
          check(
            g2.annPopupText.includes('紧急') && g2.annPopupText.includes('预览'),
            `${SAN}：弹窗把**等级**与"预览"来源都写出来了（紧急 → 强提醒）`,
            short(g2.annPopupText, 90),
          )
          await shot(pm, SAN, '92-ann-popup-after-welcome')

          /* 关掉公告弹窗：`once` 记本机、预览快照清掉 */
          await pm.evaluate(() => {
            const b = [...document.querySelectorAll('.modal button')].find((x) => /我知道了/.test(x.textContent ?? ''))
            b?.click()
          })
          await pm.waitForTimeout(500)
          const g3 = await annProbe(pm)
          check(
            g3.annPopup === null && g3.previewKey === null,
            `${SAN}：关掉之后——弹窗收起、**预览快照自动清掉**（不会下次莫名又弹）`,
            `preview = ${g3.previewKey} · 弹窗 ${g3.annPopup ?? '没弹'}`,
          )
          check(
            typeof g3.seen !== 'string' && g3.seen.length === 1,
            `${SAN}：`+"`once` 只在**关掉时**记进本机（`shugao.ann.seen`）—— 平台不记谁看过",
            `seen = ${JSON.stringify(g3.seen)}`,
          )
        } finally {
          await ctxM.close()
        }
      })

      /* --- ⑥ 桌面：左栏/右栏也要让位（同一根 `--top-stack-h`） --- */
      await step(SAN, async () => {
        const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
        await ctxD.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxD.addInitScript((base) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(base))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
          window.localStorage.removeItem('shugao.ann.hideDay')
        }, TEACHER_STATE)
        const pd = await ctxD.newPage()
        pd.on('pageerror', (e) => errors.push(`PAGEERROR(公告·桌面) :: ${e.message}`))
        pd.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(公告·桌面) :: ${m.text()}`)
        })
        try {
          await pd.goto(`${BASE}/`, { waitUntil: 'networkidle' })
          await pd.waitForTimeout(600)
          const g = await pd.evaluate(() => {
            const r = (sel) => {
              const el = document.querySelector(sel)
              if (!el) return null
              const b = el.getBoundingClientRect()
              return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), bottom: Math.round(b.bottom) }
            }
            return {
              stack: r('[data-ann-stack]'),
              rail: r('.floating-rail'),
              main: r('main'),
              varTopStack: getComputedStyle(document.documentElement).getPropertyValue('--top-stack-h').trim(),
            }
          })
          check(
            g.rail !== null && g.rail.y >= (g.stack?.bottom ?? 0),
            `${SAN}（桌面）：左侧悬浮栏**也在公告条之下**（左栏 y=${g.rail?.y} ≥ 公告条底 ${g.stack?.bottom}）`,
            `公告条 ${g.stack?.y}~${g.stack?.bottom} · 左栏 ${g.rail?.y}`,
          )
          check(
            g.main !== null && g.main.y >= (g.stack?.bottom ?? 0),
            `${SAN}（桌面）：内容列同样从公告条之下开始（main y=${g.main?.y}）`,
            `main ${g.main?.x}~ · 变量 ${g.varTopStack}`,
          )
          await shot(pd, SAN, '93-ann-desktop')
        } finally {
          await ctxD.close()
        }
      })

      /* --- ⑦ 入口与**编辑时的隐私提醒**（超管面板的「公告」分区） --- */
      await step(SAN, async () => {
        await annPage.goto(`${BASE}/admin?roles=${ANN_ROLES}`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(600)
        /*
         * 🆕 2026-09-29 管理台第二期：面板改成了**左侧分区导航 + 一排数字磁贴**，
         *    公告搬进了自己那一格。
         *    ⚠️ 2026-10-08：概览上那张"已经移到「公告」那一格"的指路卡**已整项删除**
         *    （用户点名：「这个可以删除了」）—— 它是**一项已完成的迁移说明**，不是状态，
         *    所以永远显示"无法判断"；它的正文两句又正好犯 §七（解释实现 + 设计辩护）。
         *    ⚠️ 窄屏（414）下左栏折叠成**顶部横向分段**，所以这里点的是
         *    `data-admin-seg-key` —— 与桌面那套 `data-admin-nav-key` 是同一份分区表。
         */
        const navSeg = annPage.locator('[data-admin-seg-key="announce"]')
        check(
          (await navSeg.count()) === 1,
          `${SAN}：面板自己有分区导航（窄屏是顶部横向分段），公告是其中一格`,
          `分段数 ${await annPage.locator('[data-admin-seg-key]').count()}`,
        )
        await navSeg.click()
        await annPage.waitForTimeout(250)
        const b0 = await bodyText(annPage)
        check(
          b0.includes('⑥ 全站公告'),
          `${SAN}：入口在**超管面板**里（公告是"平台自己的状态"，与这块屏的定位一致）`,
          short(b0.match(/.{0,10}全站公告.{0,40}/)?.[0] ?? '', 90),
        )
        check(
          b0.includes('与「通知」不是一件事'),
          `🔴 ${SAN}：卡片上就写清了**公告 ≠ 通知**（这是最容易被后人搞混的一处）`,
          short(b0.match(/.{0,10}不是一件事.{0,60}/)?.[0] ?? '', 120),
        )
        await annPage.locator('[data-admin-toggle="⑥ 全站公告（关于平台本身）"]').click()
        await annPage.waitForTimeout(350)
        const b1 = await bodyText(annPage)
        for (const t of ['等级', '弹窗', '生效起', '两端留空', '撤下']) {
          check(b1.includes(t), `${SAN}：卡里有「${t}」这一项（等级/弹窗/生效区间/撤下都要能操作）`, b1.includes(t) ? '在' : short(b1, 200))
        }
        /* 演示模式下表单是**停用**的（没有服务端）—— 但"能不能摆出来"照验 */
        const submitDisabled = await annPage.locator('[data-admin-ann-submit]').isDisabled()
        check(
          submitDisabled,
          `${SAN}：本地模式（没有 /api/announcement）**发布按钮停用**，并写明原因 —— 不假装能发`,
          `disabled = ${submitDisabled}`,
        )

        /* 🔴 编辑时的隐私提醒：输入一段"像成绩"的正文 → 出现软提醒（**不拦提交**） */
        await annPage.fill('input[placeholder^="标题"]', '月考情况')
        await annPage.fill('textarea', '高二(1)班张三这次考了 85 分，请各位老师关注。')
        await annPage.waitForTimeout(250)
        const hint = await annPage.evaluate(() => {
          const el = document.querySelector('[data-admin-ann-privacy]')
          return el ? String(el.innerText).replace(/\s+/g, ' ').trim() : null
        })
        check(
          hint !== null && hint.includes('全站'),
          `🔴 ${SAN}：正文里出现成绩/姓名 → 给一条**编辑时的提醒**（"公告是全站都看得到的"）`,
          short(hint ?? '(没有提醒)', 110),
        )
        await annPage.fill('textarea', '今晚 23:00–23:30 平台升级数据库，期间可能有一两次保存失败。')
        await annPage.waitForTimeout(250)
        const hint2 = await annPage.evaluate(() =>
          document.querySelector('[data-admin-ann-privacy]') ? '有' : '没有',
        )
        check(
          hint2 === '没有',
          `${SAN}：反向对照 —— 一句正常的运维文案（含数字）**不该**被提醒（不是"见谁都提醒"）`,
          `提醒节点：${hint2}`,
        )

        /* 预览按钮：写本机快照（教师端那一次在 ⑤ 里验过） */
        await annPage.click('[data-ann-row="demo-a1"] [data-admin-ann-preview]')
        await annPage.waitForTimeout(300)
        const previewKey = await annPage.evaluate(() => {
          try {
            const raw = window.localStorage.getItem('shugao.ann.preview')
            return raw ? JSON.parse(raw).id : null
          } catch {
            return 'ERR'
          }
        })
        check(
          previewKey === 'demo-a1',
          `${SAN}：点「预览」→ 快照写进本机（shugao.ann.preview），去教师端就会看到那一条`,
          `preview = ${previewKey}`,
        )
        await shot(annPage, SAN, '94-admin-announcements', { full: true })
      })

      /* ============================================================
         🆕 ⑧ 管理台第二期（2026-09-29）：新结构 + 三个新分区 + 维护模式的三种行为
         ------------------------------------------------------------
         🔴 这一节验的是**用户点名的那三句话**（每一句都要有**反向对照**）：
            ① 面板"更像管理台"了：分区导航 + 概览一排数字磁贴；
            ② 「**所有在线用户被强制返回到正在维护中的页面**」→ 先证明"不维护时页面
               是正常的"，再证明"维护时整块被换掉"（否则"换掉了"可能只是"页面本来就空"）；
            ③ 「**超管自己必须还能进 `/admin`**」→ 维护中敲 `/admin` 仍然拿得到体检结果
               （这是"开了关不掉"的解药，也是这一期最容易被漏掉的一条）；
            ④ 「教室端：全屏维护画面 + **心跳照发** + **立刻清掉本页学生数据**」
               → 先证明"不维护时班里那串数据是在屏上的"，再证明维护时**一个字都不在**。

         ⚠️ 维护状态靠 **DEV-only 钩子 `?maint=…`**（`lib/roles.ts` 的
            `devInjectedMaintenance()`）：本地演示模式没有服务端，不装它这一整块**断言不了**。
            生产构建里它被摇掉（`nav-checks` 的 D7 读 dist 核对）。
         ============================================================ */
      const S2 = '管理台第二期'

      await step(S2, async () => {
        /*
         * 折叠卡：**先点开再查**。
         *
         * 这是 `超管运维面板方案.md` 风险表里已经写明的那条纪律（第一期第 3 条）：
         * 「面板折叠卡让'首屏就该有'这类断言全错（G2 的字节数行、C1 的表都在明细里，
         * 默认折叠）→ 断言改成**先点开再查**，并且找按钮用 `[data-admin-toggle="…"]`
         * 这个**稳定钩子**而不是可见文案 —— 文案改一个字不该弄红断言」。
         * 第二期的三张新卡里「错误日志 / 反馈」是**折叠**的（第一张「维护模式」按方案
         * §三 的表是**不折叠**的，所以它在 `Admin.tsx` 里传了 `defaultOpen`，这里不用点）。
         *
         * ⚠️ 先看 `aria-expanded`：已经是展开态就不点（点两次 = 又收起去了）。
         */
        const openCard = async (title) => {
          const btn = annPage.locator(`[data-admin-toggle="${title}"]`)
          if ((await btn.getAttribute('aria-expanded')) !== 'true') {
            await btn.click()
            await annPage.waitForTimeout(250)
          }
        }

        /* ---------------- ① 新结构：分区导航 + 数字磁贴 ---------------- */
        await annPage.goto(`${BASE}/admin?roles=${ANN_ROLES}`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(600)
        const nav = await annPage.evaluate(() => ({
          segs: [...document.querySelectorAll('[data-admin-seg-key]')].map((e) =>
            e.getAttribute('data-admin-seg-key'),
          ),
          tiles: [...document.querySelectorAll('[data-admin-tile]')].map((e) =>
            e.getAttribute('data-admin-tile'),
          ),
          l0: document.querySelector('[data-admin-l0]')?.getAttribute('data-admin-l0') ?? null,
        }))
        check(
          nav.segs.join(',').includes('overview') &&
            nav.segs.length === 7 &&
            nav.segs.includes('maintenance') &&
            nav.segs.includes('feedback'),
          `${S2}：面板**自己一套分区导航**（7 格：概览/健康/数据库/公告/维护/错误日志/反馈）`,
          `分区：${nav.segs.join('、')}`,
        )
        check(
          nav.tiles.includes('db') &&
            nav.tiles.includes('backup') &&
            nav.tiles.includes('errors') &&
            nav.tiles.includes('feedback') &&
            nav.tiles.includes('version'),
          `${S2}：概览是**一排数字磁贴**（数据库用量 / 备份 / 需处理 / 错误 24h / 未读反馈 / 维护 / 版本）`,
          `磁贴：${nav.tiles.join('、')}`,
        )
        check(
          nav.l0 !== null,
          `🔴 ${S2}：**L0 健康条还在**（第一期那句话一个字没丢），颜色 = ${nav.l0}`,
          `data-admin-l0 = ${nav.l0}`,
        )
        const bShell = await bodyText(annPage)
        check(
          bShell.includes('数据库用量') && bShell.includes('未读反馈') && bShell.includes('这一页怎么读'),
          `${S2}：磁贴下面还有一段"这一页怎么读"（绿/黄/红/**灰**四色的口径写在屏上）`,
          short(bShell.match(/.{0,20}这一页怎么读.{0,60}/)?.[0] ?? '', 140),
        )
        await shot(annPage, S2, '95-admin-sections-overview', { full: true })

        /* ---------------- ② 数据库分区 ---------------- */
        await annPage.locator('[data-admin-seg-key="db"]').click()
        await annPage.waitForTimeout(300)
        const bDb = await bodyText(annPage)
        /*
         * ⚠️ 期望值 2026-10-07 变了，原因**不是**为了让绿：
         *    · 配额从 1 GB 改成 **500 MB**（线上跑的是免费版，控制台写 0.5 GB）——
         *      配额写大一倍，百分比就小一半，正是"面板让人误判"的一半原因；
         *    · 同时点名 **出流量 5 GB**（免费版的额度，与库配额同一张账单）。
         * 三档线 60 / 85 **一个字没动**（照旧钉在这儿）。
         */
        check(
          bDb.includes('数据库使用情况') &&
            bDb.includes('配额') &&
            bDb.includes('500 MB') &&
            bDb.includes('出流量') &&
            bDb.includes('5 GB') &&
            bDb.includes('三档线') &&
            bDb.includes('60') &&
            bDb.includes('85'),
          `${S2}：数据库那一格写着**库配额 500 MB（免费版）**、**出流量 5 GB**` +
            '与三档线（60 / 85）—— 而且**读不到用量时也在屏上**（灰的是"用掉多少"，不是口径）',
          short(bDb.match(/.{0,10}库配额按.{0,120}/)?.[0] ?? '', 200),
        )
        check(
          bDb.includes('无法判断') || bDb.includes('题图占多少'),
          `🔴 ${S2}：本地模式读不到用量 → **灰的"无法判断"**（不是 0 MB、也不是绿）`,
          short(bDb.match(/.{0,14}(无法判断|题图占多少).{0,40}/)?.[0] ?? '', 120),
        )
        await shot(annPage, S2, '96-admin-db', { full: true })

        /* ---------------- ③ 维护分区（四条防呆 + 二次确认） ---------------- */
        await annPage.locator('[data-admin-seg-key="maintenance"]').click()
        await annPage.waitForTimeout(300)
        const onBtn = annPage.locator('[data-maint-on]')
        const confirmBox = annPage.locator('[data-maint-confirm]')
        check(
          (await onBtn.count()) === 1 && (await confirmBox.count()) === 1,
          `${S2}：维护那一格有**二次确认输入框** + 开启按钮`,
          `按钮 ${await onBtn.count()} 个 · 确认框 ${await confirmBox.count()} 个`,
        )
        const disabledBefore = await onBtn.isDisabled()
        check(
          disabledBefore,
          `🔴 ${S2}：没输入确认字符串时按钮是**真 disabled**（不是"灰一下还能点"）`,
          `disabled = ${disabledBefore}`,
        )
        await confirmBox.fill('MAINTENANCE')
        await annPage.waitForTimeout(200)
        /* 🔴 四条校验之一（R3）：只填结束时间 → 预览那句**直接说不行** */
        await annPage.fill('[data-maint-to]', '2027-01-01T10:00')
        await annPage.waitForTimeout(250)
        const preview = await annPage.evaluate(() =>
          String(document.querySelector('[data-maint-preview]')?.textContent ?? ''),
        )
        check(
          preview.includes('只填了结束时间'),
          `🔴 ${S2}：**R3**（只填结束时间）→ 预览当场说清"要么补开始、要么清掉结束"`,
          short(preview, 120),
        )
        const disabledR3 = await onBtn.isDisabled()
        check(disabledR3, `🔴 ${S2}：R3 命中时开启按钮仍然 disabled（拒在提交之前）`, `disabled = ${disabledR3}`)
        /* 反向对照：把结束时间清掉 → 预览变成"立即开启 + 4 小时自动关" */
        await annPage.fill('[data-maint-to]', '')
        await annPage.waitForTimeout(250)
        const preview2 = await annPage.evaluate(() =>
          String(document.querySelector('[data-maint-preview]')?.textContent ?? ''),
        )
        check(
          preview2.includes('立即开启') && preview2.includes('自动关闭'),
          `🔴 ${S2}：反向对照 —— 清掉之后预览变成"立即开启 · N 小时后自动关闭"（不是恒拒）`,
          short(preview2, 120),
        )
        check(
          !(await onBtn.isDisabled()),
          `${S2}：这时开启按钮**可以点**（确认字符串已输入、表单自洽）`,
        )
        const bMaint = await bodyText(annPage)
        check(
          bMaint.includes('心跳照发') || bMaint.includes('心跳一直在发'),
          `${S2}：那一格写明了**教室端心跳照发**（否则面板会开始显示"教室端离线"）`,
          short(bMaint.match(/.{0,12}心跳.{0,40}/)?.[0] ?? '', 100),
        )
        check(
          bMaint.includes('发测试邮件'),
          `${S2}：带一个「**发测试邮件**」按钮（不用真等到毕业才验通道）`,
        )
        await shot(annPage, S2, '97-admin-maintenance', { full: true })

        /* ================================================================
           🆕 ⑥-之补 · 同一页下面那张「版本更新」卡（2026-10-04）
           ----------------------------------------------------------------
           🔴 两档（教师端 / 教室端）的 `data-rel-*` **同名**（`Admin.tsx:3786` 写明了
              刻意同名，避免两套命名）⇒ 所以本节一律**带前缀查**
              （`[data-rel-form="teacher"] [data-rel-version]`）。不带前缀查 = 读到的是
              教师端那份还是教室端那份，全看 DOM 顺序 —— 那种断言迟早骗人。

           ⚠️ 本地演示模式（没有服务端）下这一卡的初始态是**可预期**的：
              `/api/admin/release` 走 `postApi()`，而本地模式**一个请求都不发**
              （`src/lib/api.ts:50`）⇒ `fetchReleaseState()` 回 `{ok:false}`
              ⇒ `rel` 为 `null`、`relErr` 是人话 ⇒ **`data-rel-readerr` 那条灰条在屏上**，
              卡片 headline 是「无法判断」。🔴 灰就是灰：**读不到 ≠ 没在发**。

           ⚠️ 这一节**不点「撤下」也不真的发布成功**（本地模式没有服务端）；
              但它**要点一次「发布」**，钉的是"不可写的路径必须显式报错"
              （`AGENTS.md` §三.5：本项目反复栽在"不报错但就是不对"）。
           ================================================================ */
        {
          const { APP_VERSION } = await import('../src/lib/version.ts')
          const { releaseDefaultNote, RELEASE_NOTE_MAX, RELEASE_BANNED_WORDS } = await import(
            '../src/lib/release.ts'
          )
          /*
           * ⚠️ `shots.mjs` **只有 `check(cond, label, observed)` 这一个断言器**（没有 `eq`）——
           *    这里一律 `check` + `JSON.stringify` 比字面量（2026-10-11 S26 那一节就栽过：
           *    写成 `eq(...)` → `ReferenceError` → 整节在第一条断言之前断掉）。 */
          const eqv = (label, got, want, extra = '') =>
            check(got === want, label, `得到 ${JSON.stringify(got)}`, `期望 ${JSON.stringify(want)}${extra ? ` · ${extra}` : ''}`)
          /** 两档各读一次（**带前缀**：`data-rel-*` 同名，见上面那段说明） */
          const probeRel = () =>
            annPage.evaluate(() => {
              const one = (t, sel) => document.querySelector(`[data-rel-form="${t}"] ${sel}`)
              const txt = (el) =>
                el ? String(el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
              const slotOf = (t) => {
                const pub = one(t, '[data-rel-publish]')
                return {
                  target: t,
                  form: Boolean(document.querySelector(`[data-rel-form="${t}"]`)),
                  version: (() => {
                    const el = one(t, '[data-rel-version]')
                    return el ? String(el.value) : null
                  })(),
                  soft: (() => {
                    const el = one(t, '[data-rel-force-soft]')
                    return el ? el.checked === true : null
                  })(),
                  hard: (() => {
                    const el = one(t, '[data-rel-force-hard]')
                    return el ? el.checked === true : null
                  })(),
                  note: (() => {
                    const el = one(t, '[data-rel-note]')
                    return el ? String(el.value) : null
                  })(),
                  apk: (() => {
                    const el = one(t, '[data-rel-apk]')
                    return el !== null
                  })(),
                  exe: (() => {
                    const el = one(t, '[data-rel-exe]')
                    return el !== null
                  })(),
                  count: txt(one(t, '[data-rel-count]')),
                  preview: txt(one(t, '[data-rel-preview]')),
                  publishDisabled: pub ? pub.disabled === true : null,
                  unpublishDisabled: (() => {
                    const el = one(t, '[data-rel-unpublish]')
                    return el ? el.disabled === true : null
                  })(),
                }
              }
              const card = document
                .querySelector('[data-rel-form="teacher"]')
                ?.closest('section[data-tone]')
              return {
                readerrCount: document.querySelectorAll('[data-rel-readerr]').length,
                readerr: txt(document.querySelector('[data-rel-readerr]')),
                cardText: txt(card),
                msgCount: document.querySelectorAll('[data-rel-msg]').length,
                errCount: document.querySelectorAll('[data-rel-err]').length,
                errText: txt(document.querySelector('[data-rel-err]')),
                teacher: slotOf('teacher'),
                classroom: slotOf('classroom'),
              }
            })

          const R0 = await probeRel()
          check(
            R0.readerrCount === 1 && R0.readerr.includes('读不到版本公告'),
            `🔴 ${S2}：版本更新卡在本地模式下**如实说"读不到"**（一条灰条 + fail-open 那句话），**不是绿**`,
            `灰条 ${R0.readerrCount} 条 · ${short(R0.readerr, 140)}`,
          )
          check(
            R0.cardText.includes('无法判断') && R0.cardText.includes(`v${APP_VERSION}`),
            `${S2}：卡片 headline 是「**无法判断**」，而且把本机的 APP_VERSION（v${APP_VERSION}）写在卡上（"读不到 ≠ 没在发"）`,
            short(R0.cardText, 220),
          )
          check(
            R0.teacher.form && R0.classroom.form,
            `${S2}：**两档各一份**编辑区（\`data-rel-form="teacher"\` / \`"classroom"\`，各 1 个）`,
            `teacher=${R0.teacher.form} · classroom=${R0.classroom.form}`,
          )
          check(
            R0.teacher.apk && R0.teacher.exe && R0.classroom.apk && R0.classroom.exe,
            `${S2}：两档都有**手机链接 / 电脑链接**两个输入框（apk 与 exe 是两种包，缺一个就有端拿不到）`,
            `teacher apk/exe=${R0.teacher.apk}/${R0.teacher.exe} · classroom=${R0.classroom.apk}/${R0.classroom.exe}`,
          )
          check(
            R0.teacher.count.includes(`/ ${RELEASE_NOTE_MAX} 字`) &&
              R0.classroom.count.includes(`/ ${RELEASE_NOTE_MAX} 字`),
            `${S2}：两档都有**字数提示**（正文 ≤ ${RELEASE_NOTE_MAX} 字，写在输入框下面）`,
            `teacher：${short(R0.teacher.count, 80)}`,
          )
          /*
           * 🔴 版本号 / 正文的**预填**：面板必须**开箱可用** —— 施工单 §七 那张表
           *    写死了默认文案（`v1.1.1 已发布，建议更新。`），并写明"面板里预填"。
           *    ⚠️ 期望值一律**从真值算**（`APP_VERSION` / `releaseDefaultNote()`），
           *       不写字面量 —— 下一轮真发号时（§四 发版三步）这两条不该跟着红。
           */
          eqv(
            `${S2}：教师端那份的版本号**预填成本机的 APP_VERSION**`,
            R0.teacher.version,
            APP_VERSION,
          )
          eqv(
            `${S2}：教师端那份的正文**预填成默认那句**（releaseDefaultNote(APP_VERSION, false)）`,
            R0.teacher.note,
            releaseDefaultNote(APP_VERSION, false),
          )
          eqv(
            `${S2}：**没选档位**时「发布」是 disabled（服务端 R2 要求 force 显式给布尔；面板只是体验）`,
            R0.teacher.publishDisabled,
            true,
          )
          eqv(
            `${S2}：没发布过的档「撤下这一档」也是 disabled（本地模式读不到 ⇒ 不许假装撤下）`,
            R0.teacher.unpublishDisabled,
            true,
          )

          /* ---- 两档互不影响（🔴 本功能最容易写错的地方）---- */
          await annPage.fill('[data-rel-form="teacher"] [data-rel-version]', APP_VERSION)
          await annPage.fill('[data-rel-form="classroom"] [data-rel-version]', APP_VERSION)
          await annPage.waitForTimeout(260)
          const R1p = await probeRel()
          eqv(
            `${S2}：版本号一填，两档正文都自动换成 "建议更新" 那句（版本变 → 正文跟着变）`,
            `${R1p.teacher.note} / ${R1p.classroom.note}`,
            `${releaseDefaultNote(APP_VERSION, false)} / ${releaseDefaultNote(APP_VERSION, false)}`,
          )
          check(
            R1p.teacher.preview.includes('得明确选一个'),
            `🔴 ${S2}：还没选档位时预览**当场说清是哪一条不过**（R2：force 要显式给布尔），而不是"灰一下还能点"`,
            short(R1p.teacher.preview, 140),
          )
          eqv(
            `${S2}：这时「发布」仍然 disabled（拒在提交之前）`,
            R1p.teacher.publishDisabled,
            true,
          )
          await annPage.click('[data-rel-form="teacher"] [data-rel-force-hard]')
          await annPage.waitForTimeout(260)
          const R2p = await probeRel()
          eqv(
            `${S2}：教师端点「强制」→ 正文自动换成 releaseDefaultNote(APP_VERSION, true)`,
            R2p.teacher.note,
            releaseDefaultNote(APP_VERSION, true),
          )
          check(
            R2p.teacher.hard === true && R2p.teacher.soft === false,
            `${S2}：档位切到「强制」（radio 是真选中的那一个，不是只改了样式）`,
            `hard=${R2p.teacher.hard} · soft=${R2p.teacher.soft}`,
          )
          eqv(
            `${S2}：教师端的「发布」这时**可点**了（表单自洽）`,
            R2p.teacher.publishDisabled,
            false,
          )
          check(
            R2p.classroom.note === releaseDefaultNote(APP_VERSION, false) &&
              R2p.classroom.hard === false &&
              R2p.classroom.publishDisabled === true,
            `🔴 ${S2}：**教室端那份一个字不变**（正文仍是"建议更新"那句、档位仍未选、发布仍 disabled）—— 两档互不影响`,
            `classroom：note=${JSON.stringify(R2p.classroom.note)} · hard=${R2p.classroom.hard} · publishDisabled=${R2p.classroom.publishDisabled}`,
            '这一条钉的是本功能最容易写错的地方：一次发布只动一档',
          )

          /* ---- 文案纪律：屏上**默认值**本身就该是干净的 ---- */
          {
            const notes = [R0.teacher.note, R0.classroom.note, R2p.teacher.note, R2p.classroom.note]
            const hits = [
              ...new Set(notes.filter(Boolean).flatMap((n) => RELEASE_BANNED_WORDS.filter((w) => n.includes(w)))),
            ]
            check(
              hits.length === 0,
              `${S2}：两档正文框里的值**一个禁词都没有**（默认文案自己就是干净的）`,
              `命中 ${hits.length} 个${hits.length ? `：${hits.join('、')}` : ''}`,
            )
            check(
              notes.filter(Boolean).length === 4,
              `${S2} 自证：上面那条真的取到了 4 个正文值（不是"一个都没取到"所以没禁词）`,
              notes.map((n) => JSON.stringify(n)).join(' / '),
            )
          }

          /* ---- 🔴 不可写的路径要**显式报错**（本地模式点「发布」不许假装成功）---- */
          await annPage.click('[data-rel-form="teacher"] [data-rel-publish]')
          await annPage.waitForTimeout(500)
          const R3p = await probeRel()
          check(
            R3p.errCount === 1 && R3p.errText.length > 0 && R3p.msgCount === 0,
            `🔴 ${S2}：本地模式点「发布」→ **显式报错（人话）**，绝不"面板说发布成功而外面什么都没发生"`,
            `err ${R3p.errCount} 条：${short(R3p.errText, 140)} · 成功提示 ${R3p.msgCount} 条`,
          )
        }

        /* ================================================================
           🆕 ⑥-之补二 · 「输入法组字」四条（2026-10-04，用户报「apk 上点按钮吞字」）
           ----------------------------------------------------------------
           用户原话：「点按钮后会把输入了的字吞掉几个」，进一步确认是「**字在框里也没了**」
           —— 不是"没保存"，是屏上就少了那几个字。
           根因两步（`src/lib/imeMirror.ts` 文件头写全了）：① 拼音还没选词时那几个字已经
           **在编辑框里**（屏上看得见），而 React 那侧的状态没有它们；② 于是任何一次
           「点按钮 → setState → 重渲染」都可能**把旧值写回** ⇒ 那几个字被冲掉。

           🔴 模型（与真机同形，`scripts/_tmp_ime.mjs` 是第一版探针）：
             ① 输入法**原生写入**编辑框 —— 用 `HTMLTextAreaElement.prototype` 上的 setter，
                **绝不能写 `el.value = …`**：React 在节点上装了自己的 `value` 描述符
                （tracker），走 `el.value = …` 会把 React 那份"它以为的值"一起改掉 ⇒
                补的事件被判成"值没变"、`onChange` 不触发 ⇒ **探针会自己骗自己**
                （第一版就是这么错的：结论"修法无效"，其实是探针错）。
             ② 所以只派发 `compositionupdate`（**不派发** `input`），那几个字于是
                **只在屏上、不在状态里**。
           判据落在**状态派生的锚点**上（正文框下面那行字数计数 `[data-rel-count]` 与
           预览行 `[data-rel-preview]` —— 两个都是 `note` 这个 state 派生的）：
           装了镜像 ⇒ 计数/预览**跟着屏上走**；没装 ⇒ 停在旧值（= 点按钮时会用到的那一份）。

           ⚠️ **关掉镜像的唯一办法**：另起一个 context，把产品**自己的幂等标记**抢在
              `main.tsx` 之前置上（`installImeMirror()` 里 `if (w.__imeMirrorInstalled) return`
              就是这个语义）—— **不新加任何测试专用开关**（加了就等于在测另一个产品）。
           ⚠️ 这一节**一张图都不出**（判据在 DOM 与状态上，加图要动 `EXPECTED_FILES`）。
           ================================================================ */
        {
          const IME_NOTE = '[data-rel-form="teacher"] [data-rel-note]'
          const IME_COUNT = '[data-rel-form="teacher"] [data-rel-count]'
          const IME_PREVIEW = '[data-rel-form="teacher"] [data-rel-preview]'
          const IME_TYPED = '1.1.1 已发布'

          /**
           * 开一个**干净**的管理台页面：先跑一遍"组字"实验，再跑一遍"正常打字"。
           * `mirror === false` ⇒ 用幂等标记把镜像关掉（反向对照那一遍）。
           */
          const imeRun = async (mirror) => {
            const ctx = await browser.newContext({ viewport: { width: 414, height: 880 }, locale: 'zh-CN' })
            await ctx.clock.install({ time: new Date('2026-09-19T10:00:00') })
            await ctx.addInitScript((base) => {
              window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(base))
              window.localStorage.setItem('shugao.deviceRole', 'teacher')
            }, TEACHER_STATE)
            if (!mirror) {
              /* 🔴 抢在 `main.tsx` 之前置上幂等标记 ⇒ `installImeMirror()` 直接 return（镜像没了）。
                 ⚠️ 顺手记一个"这一步真的做了"的标记：标记置上之后**产品自己也读它**，
                    所以跑完 `__imeMirrorInstalled` 两边都是 `true` —— 光看它分不出装没装
                    （2026-10-04 实测：反向那遍 `installed` 也是 true，靠它断言会骗人）。 */
              await ctx.addInitScript(() => {
                window.__imeMirrorInstalled = true
                window.__imeGuardPreset = true
              })
            }
            const ip = await ctx.newPage()
            ip.on('pageerror', (e) => errors.push(`PAGEERROR(输入法) :: ${e.message}`))
            ip.on('console', (m) => {
              if (m.type() === 'error') errors.push(`CONSOLE(输入法) :: ${m.text()}`)
            })
            await ip.goto(`${BASE}/admin?roles=${ANN_ROLES}`, { waitUntil: 'networkidle' })
            await ip.waitForTimeout(600)
            await ip.locator('[data-admin-seg-key="maintenance"]').click()
            await ip.waitForTimeout(400)
            if (mirror) {
              /* 连装三次：幂等坏掉的话，下面"组字恰好补一个"会当场变成 4 个 */
              await ip.evaluate(async () => {
                const m = await import('/src/lib/imeMirror.ts')
                m.installImeMirror()
                m.installImeMirror()
                m.installImeMirror()
              })
            }
            /* 选「强制」档：这样预览行才渲染成"发布后老师看到的是：「…」+「<正文>」" ——
               正文于是成了**状态派生的锚点**（不选档位时那一行显示的是校验错误） */
            await ip.click('[data-rel-form="teacher"] [data-rel-force-hard]')
            /* "正常打三个字"（React 状态里于是有一份 'abc'） */
            await ip.fill(IME_NOTE, 'abc')
            await ip.waitForTimeout(120)
            /* 开始数"补派发的 input"（组字那一下该补 1 个；有没有镜像就是 1 与 0 的差别） */
            await ip.evaluate(() => {
              window.__imeInputs = 0
              document.addEventListener(
                'input',
                () => {
                  window.__imeInputs++
                },
                true,
              )
            })
            /* 输入法原生写入那几个"还没上屏"的字 —— **不派发** input，只派发 compositionupdate */
            await ip.evaluate(
              ([sel, val]) => {
                const el = document.querySelector(sel)
                const setNative = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
                setNative.call(el, val)
                el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '未上屏' }))
              },
              [IME_NOTE, 'abc未上屏'],
            )
            await ip.waitForTimeout(150)
            const composed = await ip.evaluate(
              ([n, c, pv]) => {
                const txt = (s) => String(document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
                return {
                  dom: String(document.querySelector(n)?.value ?? ''),
                  count: txt(c),
                  preview: txt(pv),
                  inputs: window.__imeInputs,
                  installed: window.__imeMirrorInstalled === true,
                  guardPreset: window.__imeGuardPreset === true,
                }
              },
              [IME_NOTE, IME_COUNT, IME_PREVIEW],
            )

            /* ---- 正常打字：逐字不差 + 一个 input 都不多发（装 / 不装各打一遍）---- */
            await ip.fill(IME_NOTE, '') /* ⚠️ 先清空：它有默认文案预填，而且 maxLength=24 */
            await ip.click(IME_NOTE)
            await ip.evaluate(() => {
              window.__imeInputs = 0
            })
            await ip.keyboard.type(IME_TYPED)
            await ip.waitForTimeout(120)
            const typed = await ip.evaluate(
              (n) => ({
                value: String(document.querySelector(n)?.value ?? ''),
                inputs: window.__imeInputs,
              }),
              IME_NOTE,
            )
            return { ctx, composed, typed }
          }

          /* ---------------- ① 正向：装了镜像 ⇒ 状态跟上屏 ---------------- */
          const IM = await imeRun(true)
          check(
            IM.composed.installed === true && IM.composed.dom === 'abc未上屏',
            `🔴 ${S2}：前置自证 —— 镜像**在**（\`__imeMirrorInstalled\` 为真），且原生写入确实进了框（屏上 6 个字）`,
            `屏上=${JSON.stringify(IM.composed.dom)} · installed=${IM.composed.installed}`,
          )
          check(
            IM.composed.count.includes('6 / 24') && IM.composed.preview.includes('abc未上屏'),
            `🔴 ${S2}：装了镜像 ⇒ 一次组字之后**状态跟上了屏**（计数 6 / 24 · 预览里有「abc未上屏」）—— 那几个字不会再被一次重渲染冲掉`,
            `计数=${JSON.stringify(IM.composed.count)} · 预览=${short(IM.composed.preview, 120)}`,
          )
          check(
            IM.composed.inputs === 1,
            `🔴 ${S2}：组字那一下**恰好补一个** \`input\`（**连装三次也是 1 个** —— 幂等；多了就是无谓重渲染）`,
            `${IM.composed.inputs} 个`,
          )

          /* ---------------- ② 🔴 反向对照：把镜像关掉 ⇒ 状态**跟不上**屏 ---------------- */
          const NOIM = await imeRun(false)
          check(
            NOIM.composed.guardPreset === true && NOIM.composed.dom === 'abc未上屏',
            `🔴 ${S2} 反向对照前置：这一遍**确实**是"抢在 \`main.tsx\` 之前置上幂等标记"关掉的（镜像没装），而屏上照样写着 6 个字 —— 模型没错，两次的差别只在于镜像`,
            `关镜像这步做了=${NOIM.composed.guardPreset} · 屏上=${JSON.stringify(NOIM.composed.dom)}`,
          )
          check(
            NOIM.composed.count.includes('3 / 24') &&
              NOIM.composed.preview.includes('abc') &&
              !NOIM.composed.preview.includes('abc未上屏'),
            `🔴 ${S2} 反向对照：**关掉镜像**再跑同一条实验 ⇒ 计数**停在 3 / 24**、预览里只有 \`abc\`（状态没跟上屏 = 点按钮时会被旧的那一份冲掉）`,
            `计数=${JSON.stringify(NOIM.composed.count)} · 预览=${short(NOIM.composed.preview, 120)}`,
            '这一条红了才说明上面那条正向断言不是"什么都通过"',
          )
          check(
            NOIM.composed.inputs === 0,
            `🔴 ${S2} 反向对照：关掉镜像时组字**一个 \`input\` 都不补**（0 ↔ 正向那遍的 1，判据咬的正是补派发那一下）`,
            `${NOIM.composed.inputs} 个`,
          )

          /* ---------------- ③ 正常打字**逐字不差**（装 / 不装各一遍） ---------------- */
          check(
            IM.typed.value === IME_TYPED && NOIM.typed.value === IME_TYPED,
            `🔴 ${S2}：正常打字（先清空那张框）**逐字不差** —— 装镜像与不装镜像打出来的都是 ${JSON.stringify(IME_TYPED)}`,
            `装=${JSON.stringify(IM.typed.value)} · 不装=${JSON.stringify(NOIM.typed.value)}`,
          )
          check(
            IM.typed.inputs === NOIM.typed.inputs && IM.typed.inputs > 0,
            `🔴 ${S2}：装了镜像之后正常打字**一个 input 都不多发**（与不装时逐字相同 —— 补的事件只发生在组字那两下）`,
            `装=${IM.typed.inputs} 个 · 不装=${NOIM.typed.inputs} 个`,
          )
          await IM.ctx.close()
          await NOIM.ctx.close()
        }

        /* ---------------- ④ 错误日志分区 ---------------- */
        await annPage.locator('[data-admin-seg-key="errors"]').click()
        await annPage.waitForTimeout(300)
        /* 🔴 先点开：口径（"匿名也能上报" / "has_pii 是启发式、不许当成'已脱敏'"）在卡内明细里 ——
           `bodyText` 读的是 `innerText`，**折叠着就等于屏上没有**（这正是本轮两条红的原因）。 */
        await openCard('前端错误日志')
        const bErr = await bodyText(annPage)
        check(
          bErr.includes('前端错误日志') && bErr.includes('匿名'),
          `${S2}：错误日志那一格写明**匿名也能上报**（登录页 / 教室端 / hydrate 失败三个现场）`,
          short(bErr.match(/.{0,12}匿名.{0,50}/)?.[0] ?? '', 120),
        )
        check(
          bErr.includes('启发式') && bErr.includes('不许') && bErr.includes('已脱敏'),
          `🔴 ${S2}：明确写了 has_pii 是**启发式**、**不许当成"已脱敏"**（隐私 B 类的口径）`,
          short(bErr.match(/.{0,16}启发式.{0,50}/)?.[0] ?? '', 120),
        )
        check(
          bErr.includes('请勿投屏或截图') || bErr.includes('无法判断'),
          `${S2}：读不到时是灰的"无法判断"（本地模式没有 /api/admin/errors）`,
          short(bErr.match(/.{0,14}(请勿投屏或截图|无法判断).{0,40}/)?.[0] ?? '', 120),
        )
        await shot(annPage, S2, '98-admin-errors', { full: true })

        /* ---------------- ⑤ 反馈分区 ---------------- */
        await annPage.locator('[data-admin-seg-key="feedback"]').click()
        await annPage.waitForTimeout(300)
        /* 同上：先点开再查（「先落库再发信」「反馈 ≠ 通知」写在卡内明细里） */
        await openCard('用户反馈')
        const bFb = await bodyText(annPage)
        check(
          bFb.includes('先落库') && bFb.includes('反馈 ≠ 通知'),
          `🔴 ${S2}：反馈那一格写明**先落库再发信**与**反馈 ≠ 通知**（两处最容易搞混的）`,
          short(bFb.match(/.{0,14}先落库.{0,60}/)?.[0] ?? '', 140),
        )
        check(
          bFb.includes('无法判断'),
          `${S2}：读不到时是灰的"无法判断"（**不是"没有人提过"**）`,
          short(bFb.match(/.{0,14}无法判断.{0,40}/)?.[0] ?? '', 120),
        )
        await shot(annPage, S2, '99-admin-feedback', { full: true })
      })

      /* ---------------- ⑥ 维护模式：教师端 / 教室端 / 超管三条行为 ---------------- */
      await step(S2, async () => {
        const ctxM = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
        await ctxM.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxM.addInitScript((base) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(base))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        const mp = await ctxM.newPage()
        mp.on('pageerror', (e) => errors.push(`PAGEERROR(维护) :: ${e.message}`))
        mp.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(维护) :: ${m.text()}`)
        })
        try {
          /* ---- 反向对照 A：**不维护时**，工作台是正常的一整页 ---- */
          await mp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
          await mp.waitForTimeout(600)
          const normal = await mp.evaluate(() => ({
            maint: document.querySelectorAll('[data-maintenance-screen]').length,
            work: document.body.innerText.includes('今日'),
            cls: document.body.innerText.includes('高二(3)班'),
          }))
          check(
            normal.maint === 0 && normal.work,
            `🔴 ${S2}：反向对照 —— 不维护时**没有维护画面**，工作台照常（含"今日"那一段）`,
            `维护画面 ${normal.maint} 个 · 工作台 ${normal.work ? '在' : '不在'}`,
          )

          /* ---- ① 教师端：维护中 → 整块被换成维护画面 ---- */
          await mp.goto(`${BASE}/?maint=1`, { waitUntil: 'networkidle' })
          await mp.waitForTimeout(700)
          const maint = await mp.evaluate(() => {
            const el = document.querySelector('[data-maintenance-screen]')
            return {
              count: document.querySelectorAll('[data-maintenance-screen]').length,
              variant: el?.getAttribute('data-maintenance-variant') ?? null,
              title: String(document.querySelector('[data-maintenance-title]')?.textContent ?? ''),
              text: el ? String(el.innerText).replace(/\s+/g, ' ').trim() : '',
              work: document.body.innerText.includes('今日要批的作业'),
              cls: document.body.innerText.includes('高二(3)班'),
            }
          })
          check(
            maint.count === 1 && maint.variant === 'teacher',
            `${S2}：维护中 → 教师端整块**被换成维护画面**（data-maintenance-variant=teacher）`,
            `维护画面 ${maint.count} 个（variant=${maint.variant}）`,
          )
          check(
            maint.title.includes('系统维护中'),
            `${S2}：而且写得明明白白是"系统维护中"（不是白屏、不是报错）`,
            short(maint.title, 60),
          )
          check(
            !maint.work && !maint.cls,
            `🔴 ${S2}：**工作台内容整块消失**（"今日要批的作业"与班级名都不在屏上）`,
            `工作台 ${maint.work ? '还在' : '没了'} · 班级名 ${maint.cls ? '还在' : '没了'}`,
          )
          check(
            maint.text.includes('不会被登出') || maint.text.includes('登录状态'),
            `🔴 ${S2}：明确写了**不会把任何人登出**（用户拍板：只跳转、不登出）`,
            short(maint.text, 160),
          )
          await shot(mp, S2, '100-maint-teacher', { full: true })

        /* ---- ②b 🔴 超管从维护画面进来的那条路（2026-10-03，用户要求补的）----
         *
         * 为什么这一节值钱：维护闸门把**整页**换成维护画面 —— **包括 `/login`**。
         * ⇒ 一台**没登录过**的设备上超管连登录页都点不开，「开了关不掉」真的会发生。
         * 这一节钉的是那条出路，而且**四个方向都要钉**，少一个就可能假绿。
         */
        await step(S2, async () => {
          // ① 手势**不写在屏上**（写了就等于贴在公告下面人人可见）
          const before = await mp.evaluate(() => ({
            zone: document.querySelectorAll('[data-maintenance-unlock-tapzone]').length,
            form: document.querySelectorAll('[data-maintenance-unlock="open"]').length,
            /* 屏上**不许**出现节奏的字样（"X X XXX" 这种） */
            leaks: /连点|节奏|按\s*\d+\s*下|手势/.test(document.body.innerText),
          }))
          check(
            before.zone === 1 && before.form === 0 && !before.leaks,
            `🔴 ${S2}：手势入口**屏上不可见**（只留一个点得到的大片空白区域）`,
            `落点 ${before.zone} 个 · 密码框 ${before.form} 个 · 屏上泄露节奏的字样=${before.leaks}`,
            '把节奏写在界面上 = 等于贴在公告下面，学生都会试',
          )

          /*
           * 🆕 2026-10-04：**「重新检查」必须真的点得到，而且点了要有反馈**。
           *
           * 用户报的原话：「点击重新检查按钮没有任何反馈，动效没有」。两个原因叠在一起：
           *   ① 维护卡片（`.panel`）当时**没有 z-index**，而手势落点是
           *      `position: fixed; inset: 0; z-index: 39` ⇒ 落点盖在卡片上面，
           *      `elementFromPoint(按钮中心)` 命中的是**落点 span**，按钮从来没被点到过；
           *   ② 就算点到了，`refresh()` 也只是 `void fetch…`，而 `useMaintenanceStatus`
           *      在 `sameStatus` 为真时**一次都不 setState** ⇒ 维护照旧时屏上毫无变化。
           *
           * ⚠️ 下面那条"按对节奏开框"是**直接用 JS 点落点**的 ⇒ 它抓不到①这一族
           *    （程序点元素不看层叠）。所以这一条用 `elementFromPoint` 做**真命中测试**。
           * 🔴 反向对照：把卡片上的 `zIndex: 40` 去掉 → 第 ① 条当场红。
           */
          const hit = await mp.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /重新检查/.test(x.textContent ?? ''))
            if (!b) return { why: '找不到「重新检查」按钮' }
            const r = b.getBoundingClientRect()
            const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return {
              tag: el?.tagName ?? '',
              zone: el?.hasAttribute?.('data-maintenance-unlock-tapzone') ?? false,
              text: (el?.textContent ?? '').slice(0, 12),
            }
          })
          check(
            hit.tag === 'BUTTON' && hit.zone === false,
            `🔴 ${S2}：「重新检查」按钮**真的点得到**（命中测试不是那层透明落点）`,
            hit.why ? hit.why : `命中 ${hit.tag}${hit.zone ? '（是落点 span —— 被盖住了）' : ''} · 文案 ${JSON.stringify(hit.text)}`,
            '反向对照：把维护卡片上的 `zIndex: 40` 去掉 → 这条当场红（"点它没反馈"就是这个）',
          )
          await mp.getByRole('button', { name: /重新检查/ }).first().click()
          await mp.waitForTimeout(260)
          const duringClick = await mp.getByRole('button', { name: /检查中|重新检查/ }).first().textContent()
          await mp.waitForTimeout(1100)
          const afterClick = await mp
            .locator('[data-maint-checked]')
            .textContent()
            .catch(() => null)
          check(
            /检查中/.test(duringClick ?? '') && /已检查/.test(afterClick ?? ''),
            `🔴 ${S2}：点了之后**屏上真的有反馈**（「检查中…」→「已检查 HH:MM:SS · 仍是维护中」）`,
            `点的瞬间=${JSON.stringify(duringClick)} · 收尾后=${JSON.stringify(afterClick)}`,
            '`refresh()` 没有 promise 可等、状态没变时 hook 一次都不重渲染 ⇒ 反馈必须由这一屏自己给',
          )

          // ② 按错节奏**不许**开框（否则"乱点几下就开"）
          await mp.evaluate(() => {
            /*
             * 🔴🔴 **每次点击都要重新 querySelector**（下面节奏那段也是同一个坑）。
             *   每点一下都 setState → 重渲染 → 那个 span 可能被**换成新节点**；
             *   缓存的 `z` 于是变成**已脱离 DOM** 的节点，`z.click()` **不会冒泡到 React**
             *   ⇒ 处理器根本不跑 ⇒ 断言恒红，而**产品其实好的**。
             *   （这就是"独立探针里能开、门禁里开不了"的原因 —— 探针每次都重新取。）
             */
            const z = () => document.querySelector('[data-maintenance-unlock-tapzone]')
            for (let i = 0; i < 11; i++) z().click()
          })
          /*
           * 🔴 乱点之后**必须停够一拍**（这里 1600ms）再按下一段节奏。
           *   原因：那串狂点的**最后一下**还在缓冲区里，而"同段"判据是
           *   **两下间隔 ≤380ms** ⇒ 停得不够就会和节奏的第一下**并成一组**，
           *   整条节奏永久偏移一格、永远开不出框（实测 progress 1→1→2→3→4→1）。
           *
           *   ⚠️ 这不是把 bug 藏起来：**真人乱点之后本来就要停一下再重新按**。
           *     真正要防的"乱点开框"已经被上面那条「狂点 11 下开不出框」单独钉住了。
           */
          await mp.waitForTimeout(1600)
          const afterNoise = await mp.evaluate(
            () => document.querySelectorAll('[data-maintenance-unlock="open"]').length,
          )
          check(
            afterNoise === 0,
            `🔴 ${S2}：**乱点一通开不出密码框**（节奏要对上，不是点够次数就行）`,
            `狂点 11 下后密码框 ${afterNoise} 个`,
            '否则那不是"隐藏入口"，是"任何人都能开"',
          )

          // ③ 按对节奏 → 出框，且框里**只有账号密码**，没有"直接进"的路
          await mp.evaluate(async () => {
            const z = () => document.querySelector('[data-maintenance-unlock-tapzone]')
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
            for (const n of [1, 1, 3, 2, 4]) {
              for (let i = 0; i < n; i++) {
                z().click()
                await sleep(90)
              }
              await sleep(1000)
            }
          })
          await mp.waitForTimeout(500)
          const opened = await mp.evaluate(() => {
            const f = document.querySelector('[data-maintenance-unlock="open"]')
            return {
              open: f ? 1 : 0,
              inputs: f ? f.querySelectorAll('input').length : 0,
              pw: f ? f.querySelectorAll('input[type="password"]').length : 0,
            }
          })
          check(
            opened.open === 1 && opened.inputs === 2 && opened.pw === 1,
            `🔴 ${S2}：按对节奏（X X XXX XX XXXX）**真的开出密码框**，且框里是账号 + 密码`,
            `框 ${opened.open} 个 · 输入框 ${opened.inputs} · 密码框 ${opened.pw}`,
            '这是唯一一条"没登录也能进超管"的路，它坏了就是"开了关不掉"',
          )
          await shot(mp, S2, '102b-maint-unlock', { full: true })

          // ④ 🔴 反向对照：**密码不许在前端比对**（源码级）
          //    前端只负责"把密码发给服务端"，比对必须在服务端做 ——
          //    放在前端就等于改一行 JS 就过了。
          const mgSrc = readFileSync(join(HERE, '..', 'src', 'components', 'MaintenanceGate.tsx'), 'utf8')
          const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
          const mgCode = strip(mgSrc)
          check(
            !/password\s*===|password\s*!==|\.trim\(\)\s*===\s*password/.test(mgCode),
            `🔴 ${S2}：并且前端**没有**自己比对密码（**剥掉注释后**查）`,
            /password\s*===|password\s*!==/.test(mgCode) ? '🔴 前端在比密码' : '前端只负责发送',
            '前端比密码 = 改一行 JS 就过了',
          )
          check(
            /action:\s*'unlock'/.test(readFileSync(join(HERE, '..', 'src', 'lib', 'maintenance.ts'), 'utf8')),
            `${S2}：它 POST 到服务端（action:'unlock'），不是本地放行`,
            'lib/maintenance.ts 的 unlockMaintenance()',
            '没有服务端这一段，这条就只是障眼法',
          )

          // ⑤ 教室端那一支**不许**有这个入口（那块屏是给学生看的）
          await mp.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
          await mp.waitForTimeout(700)
          const inClassroom = await mp.evaluate(
            () => document.querySelectorAll('[data-maintenance-unlock-tapzone]').length,
          )
          check(
            inClassroom === 0,
            `🔴 ${S2}：教室端那块屏**没有**这个入口（学生面前不该有）`,
            `教室端落点 ${inClassroom} 个`,
            '把超管入口摆到教室大屏上 = 任何能碰屏的学生都能开',
          )

          /* ================================================================
             🔴🔴🔴 exe 自带备份文件夹：**装上就写，不需要任何人授权**（施工单 §1）
             ----------------------------------------------------------------
             这一段钉的是一个**静默到没人会发现**的故障：
             教室里那台大屏**经常没有键鼠**，而「选备份文件夹」必须有人点一次
             ⇒ 自动备份每 5 分钟报一次「还没有选备份文件夹」，
               然后**一份都没写**，屏上看着「自动备份开着呢」。

             ✅ 所以用**真行为**钉，不钉源码：
                往页面里注入一个假桥接，看它**有没有真的被调用**。
             ⚠️ 必须**另开一个 page**：注入 `__shell_out` 会让整页进入"在壳里"状态
                （`inShell()` 变 true、导出全改走桥接），不能污染同一页后面的断言。
             ================================================================ */
          const bkPage = await ctx.newPage()
          await bkPage.addInitScript(() => {
            /* 假桥接：只把"被叫过什么"记下来。🔴 不许在这里 return 假成功还顺便
               改掉文件名 —— 那就变成"自己骗自己"的恒绿断言了。 */
            window.__bkCalls = []
            window.__shell_out = {
              saveBlob: async () => 'saved',
              openInPlace: async () => 'opened',
              saveToBackupDir: async (filename) => {
                window.__bkCalls.push(filename)
                return { ok: true, path: 'D:\\验包用的假路径\\' + filename }
              },
              backupDir: async () => 'D:\\验包用的假路径',
            }
          })
          await bkPage.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
          await bkPage.waitForTimeout(2600)
          const bkProbe = await bkPage.evaluate(() => ({
            calls: Array.isArray(window.__bkCalls) ? window.__bkCalls : [],
            dir: typeof window.__shell_out?.backupDir === 'function' ? 'function' : 'missing',
          }))
          await bkPage.close()
          check(
            bkProbe.calls.includes('树高备份.json'),
            `🔴 ${S2}：exe 自带备份文件夹 —— **没选过文件夹也真的写了一份**（装上就写）`,
            `桥接被调用 ${bkProbe.calls.length} 次：${bkProbe.calls.join(' / ') || '（一次都没有）'}`,
            '这是那个静默故障：教室端一直报「没选文件夹」、其实一份都没写，屏上却像开着',
          )

          /* ---- 源码级三条（便宜的确定性判据，剥掉注释后查） ---- */
          const strip2 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
          const bkSrc = strip2(readFileSync(join(HERE, '..', 'src', 'lib', 'backup.ts'), 'utf8'))
          const foSrc = strip2(readFileSync(join(HERE, '..', 'src', 'lib', 'fileOut.ts'), 'utf8'))
          const crSrc = strip2(readFileSync(join(HERE, '..', 'src', 'pages', 'Classroom.tsx'), 'utf8'))
          /* ⚠️ **只在 writeToFolder 这一个函数体里比顺序**（第一版扫全文，红了）——
             `indexOf` 全文会命中函数**前面**别处的同名调用 ⇒ 一个正确的实现也判红。
             这种"扫全文比位置"的断言本身就脆，别写。 */
          const w2fBody = (bkSrc.match(/export async function writeToFolder[\s\S]*?\n\}/) ?? [''])[0]
          const iHas = w2fBody.indexOf('hasBuiltinBackupDir()')
          const iWant = w2fBody.indexOf('writableFolder()')
          check(
            w2fBody !== '' && iHas > 0 && iWant > 0 && iHas < iWant,
            `${S2}：writeToFolder **先问内置文件夹、再问授权文件夹**（顺序反了就又静默失败）`,
            w2fBody === ''
              ? '🔴 没找到 writeToFolder 函数体 —— 判据本身失效了'
              : `函数体内 hasBuiltinBackupDir @${iHas} · writableFolder @${iWant}`,
            '顺序反了 = 内置目录形同虚设，仍然要人去点一次文件夹',
          )
          check(
            /saveToBackupDir\?\(/.test(foSrc) && /backupDir\?\(\)/.test(foSrc),
            `🔴 ${S2}：桥接那两个方法名**逐字没改**（打包那侧照着它们写的，改了就断）`,
            /saveToBackupDir\?\(/.test(foSrc) && /backupDir\?\(\)/.test(foSrc) ? '两个都在' : '名字对不上',
            '壳侧的 _src/desktop/shell-ipc.mjs 是照这两个名字写的',
          )
          check(
            /backupTargetHint/.test(crSrc) && /bkDir/.test(crSrc),
            `${S2}：教室端把**真实路径显示出来**（施工单 §1.3：老师要照着去 U 盘拷走）`,
            /backupTargetHint/.test(crSrc) && /bkDir/.test(crSrc) ? '接上了' : '没接',
            '不显示路径 = 备份写了但没人知道它在哪，等于没写',
          )
        })

          /* ---- ② 教室端：全屏维护画面 + 数据清空 + 心跳照发 ---- */
          await mp.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
          await mp.waitForTimeout(700)
          const clsNormal = await mp.evaluate(() => ({
            cls: document.body.innerText.includes('高二(3)班'),
            maint: document.querySelectorAll('[data-maintenance-screen]').length,
          }))
          check(
            clsNormal.cls && clsNormal.maint === 0,
            `🔴 ${S2}：反向对照 —— 不维护时教室端**屏上就是那个班**（这条是下面"清空了"的前提）`,
            `班级名 ${clsNormal.cls ? '在' : '不在'} · 维护画面 ${clsNormal.maint} 个`,
          )

          await mp.goto(`${BASE}/classroom?maint=1`, { waitUntil: 'networkidle' })
          await mp.waitForTimeout(800)
          const clsMaint = await mp.evaluate(() => {
            const el = document.querySelector('[data-maintenance-screen]')
            return {
              count: document.querySelectorAll('[data-maintenance-screen]').length,
              variant: el?.getAttribute('data-maintenance-variant') ?? null,
              clock: String(document.querySelector('[data-maintenance-clock]')?.textContent ?? '').trim(),
              text: el ? String(el.innerText).replace(/\s+/g, ' ').trim() : '',
              cls: document.body.innerText.includes('高二(3)班'),
              names: document.body.innerText.includes('逐题正确率') || document.body.innerText.includes('本次作业'),
            }
          })
          check(
            clsMaint.count === 1 && clsMaint.variant === 'classroom',
            `🔴 ${S2}：教室端 → **整屏**维护画面（data-maintenance-variant=classroom）`,
            `维护画面 ${clsMaint.count} 个（variant=${clsMaint.variant}）`,
          )
          check(
            /^\d{2}:\d{2}:\d{2}$/.test(clsMaint.clock),
            `${S2}：那块屏 24 小时亮着 —— 维护画面上有一个**大号时钟**（"还有多久"是它唯一有用的信息）`,
            `时钟 = ${clsMaint.clock}`,
          )
          check(
            !clsMaint.cls && !clsMaint.names,
            `🔴 ${S2}：**立刻清掉本页学生数据** —— 班级名 / 作业区一个字都不在屏上` +
              `（维护画面的意义之一就是"别让学生继续看到作业/名单"）`,
            `班级名 ${clsMaint.cls ? '还在' : '没了'} · 作业区 ${clsMaint.names ? '还在' : '没了'}`,
          )
          /*
           * 🔴 **心跳照发**（用户原话 + 方案 §四 拍板 4 的第 ① 条）—— 这里验的是**真行为**：
           *    `Classroom.tsx` 那个心跳 effect 挂在维护 `early return` **之前**，
           *    所以维护画面盖上来之后它照跑（本地模式走 `BroadcastChannel('shugao.classroom.v1')`，
           *    4 秒一次 —— `lib/realtime.ts` 的 `HEARTBEAT_MS`）。
           *
           * ⚠️ 原来这一条断的是**屏上有没有"心跳"两个字**（`clsMaint.text.includes('心跳')`）——
           *    那是**断言写错了**，不是产品缺功能：方案 §四 给教室端维护屏规定的是
           *    "学校名 + 「系统维护中」+ 通告正文 + 大号时钟"**四样**，
           *    "心跳照发"是**行为**（不许把心跳停掉），不是要求那块屏**写着**这句话。
           *    所以改成"开一个同名 BroadcastChannel 数一数"：收到心跳 = 心跳照发；
           *    谁把那个 effect 挪到 early return 之后，这条立刻会红。
           */
          await mp.evaluate(() => {
            window.__beats = []
            window.__beatCh = new BroadcastChannel('shugao.classroom.v1')
            window.__beatCh.onmessage = (e) => {
              if (e.data && e.data.type === 'heartbeat') window.__beats.push(e.data.at)
            }
          })
          /* 心跳 4 秒一次 → 等 5.2 秒至少该收到 1 条（等的这段里维护画面一直盖着） */
          await mp.waitForTimeout(5200)
          const beat = await mp.evaluate(() => {
            window.__beatCh?.close()
            return {
              n: (window.__beats ?? []).length,
              at: window.__beats ?? [],
              screen: document.querySelectorAll('[data-maintenance-screen]').length,
            }
          })
          check(
            beat.screen === 1 && beat.n >= 1,
            `🔴 ${S2}：**维护画面盖着的时候心跳照发**（等 5.2 秒收到 ${beat.n} 条心跳 · 维护画面 ${beat.screen} 个）—— ` +
              `不许让面板把它显示成"离线"（那是往"假在线"那条已知缺陷上再叠一层假信号）`,
            beat.n
              ? `心跳 ${beat.n} 条（at=${beat.at.join('、')}）`
              : '一条心跳都没收到 —— 心跳那个 effect 被维护画面停掉了（或者维护画面在这 5 秒里掉了）',
          )
          await shot(mp, S2, '101-maint-classroom', { full: true })
        } finally {
          await ctxM.close()
        }

        /* ---- ③ 🔴 超管仍能进 /admin（"开了关不掉"的解药） ---- */
        await annPage.goto(`${BASE}/admin?roles=${ANN_ROLES}&maint=1`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(700)
        const adminInMaint = await annPage.evaluate(() => ({
          maint: document.querySelectorAll('[data-maintenance-screen]').length,
          l0: document.querySelector('[data-admin-l0]')?.getAttribute('data-admin-l0') ?? null,
          line: document
            .querySelector('[data-admin-maint-line]')
            ?.getAttribute('data-admin-maint-line'),
          head: String(document.querySelector('[data-admin-headline]')?.textContent ?? ''),
          lineText: String(
            document.querySelector('[data-admin-maint-line]')?.textContent ?? '',
          ).replace(/\s+/g, ' '),
        }))
        check(
          adminInMaint.maint === 0 && adminInMaint.l0 !== null,
          `🔴🔴 ${S2}：**维护中 /admin 仍然进得去**（维护画面 0 个 · L0 健康条在，颜色 = ${adminInMaint.l0}）` +
            ` —— 否则开了就关不掉，这是这一件最坏的失败模式`,
          `维护画面 ${adminInMaint.maint} 个 · data-admin-l0 = ${adminInMaint.l0}`,
        )
        check(
          adminInMaint.line === 'on' && adminInMaint.lineText.includes('维护模式已开启'),
          `🔴 ${S2}：而且 L0 上**常驻一行"维护模式已开启"**（防呆：挡"忘了自己开着"）`,
          `data-admin-maint-line = ${adminInMaint.line} · ${short(adminInMaint.lineText, 120)}`,
        )
        check(
          adminInMaint.head.includes('平台'),
          `${S2}：体检结论照样拿得到（"${short(adminInMaint.head, 40)}"）—— 面板存在的意义就是"半坏状态下也看得到"`,
        )
        await shot(annPage, S2, '102-maint-admin-exempt', { full: true })
      })

      /* ================================================================
         ⑥b · 🆕 版本更新公告（`ReleaseGate`）—— 2026-10-04，DEV 钩子 `?rel=…` 驱动
         ----------------------------------------------------------------
         为什么必须用钩子：公告是**服务端**给的（`GET /api/status` 的 `release` 块），
         而本脚本跑的是**本地演示模式**（没有服务端）⇒「强制那一档整屏拦住、没有关闭按钮、
         Esc 关不掉」与「选择性那一档关得掉、关掉以后照常用」这两句话**一句都断言不了**。
         `?rel=<比本机新一档>[&force=1][&slot=classroom]`（`lib/roles.ts` 的 `devInjectedRelease()`）
         **只影响渲染**，一个字都不写数据库。
         ⚠️ 这里**不写具体版本号**：新一档 / 同版本 / 更旧三个值都在节内**从 `APP_VERSION` 推**
         （见那一节开头），发版升号时它自动跟着走。

         🔴 两档是**两条不同的分支**（`ReleaseGate.tsx` 的 `keepChildren`）：
            · 教师端 + 强制 ⇒ **整块替换**（`children` 根本不渲染）⇒ 这里钉的是
              "工作台那两块与导航**一个字都不在屏上**"（整屏接管）；
            · 教室端（**两种档位都**）⇒ **保留 children**，理由与维护豁免 `/classroom` 同源：
              **组件被卸载 ⇒ 心跳停 ⇒ 面板开始显示"教室端离线"**，而它其实好好地在显示公告
              —— 那是往"假在线"那条已知缺陷上再叠一层假信号。所以这里钉"班级名**仍在**屏上"。
            · 选择性（教师端）⇒ 也保留 children（弹窗不该把整页销毁重建，
              页面上正在填的东西不能没）。
         ⚠️ 更新公告**不**清学生数据（清数据只发生在**维护**那一档）—— 别把两者混起来。

         ⚠️ 两张图（131 / 132）都登记进 `EXPECTED_FILES` 了（那是**集合相等**，不登记就红）。
         ================================================================ */
      const SREL = `${S2} · ⑥b 版本更新公告（?rel= 钩子）`
      await step(SREL, async () => {
        /*
         * 🔴 **这一节里不许出现版本号字面量**（照 S25 ⑤/⑥ 与上面发布表单那一处的口径：
         *    期望值一律**从真值算**）。要的三种"相对关系"全部从 `APP_VERSION` 推出来：
         *      · 「比本机新一档」→ 必须弹；
         *      · 「与本机同版本」→ 不许弹；
         *      · 「比本机旧」    → 不许弹。
         * 为什么必须推：这三档在**升降号的那一刻语义会反转**（写死 `?rel=1.1.1` 的话，
         * APP_VERSION 一升到 1.1.1，它就变成"同版本 ⇒ 不许弹"，而断言期望它弹 ⇒ 当场红；
         * 那条"同版本"的标签同时变成谎话）。推导式让发版升号**自动跟着走**。
         */
        const { APP_VERSION } = await import('../src/lib/version.ts')
        /** 末位 +1 —— 「比本机新一档」（1.1.0 → 1.1.1） */
        const REL_NEW = (() => {
          const p = APP_VERSION.split('.').map(Number)
          p[p.length - 1] += 1
          return p.join('.')
        })()
        /** 退一档 —— 「比本机旧」；末位是 0 就往前进位（1.1.0 → 1.0.9，而不是原地不动） */
        const REL_OLD = (() => {
          const p = APP_VERSION.split('.').map(Number)
          for (let i = p.length - 1; i >= 0; i--) {
            if (p[i] > 0) {
              p[i] -= 1
              for (let j = i + 1; j < p.length; j++) p[j] = 9
              break
            }
          }
          return p.join('.')
        })()
        /** 同版本 —— 直接用本机的号 */
        const REL_SAME = APP_VERSION
        /*
         * 🔴 先钉**夹具自己**（否则"必须弹"那条用例可能因为推导写坏而悄悄失去意义）：
         *    三个值互不相同。例：REL_OLD 若在 `x.y.0` 时退化成同一个号，
         *    这一条当场红，而不是让"更旧"那一档测了个同版本。
         */
        check(
          REL_NEW !== REL_SAME && REL_OLD !== REL_SAME && REL_OLD !== REL_NEW,
          `🔴 ${SREL}：三个夹具版本号**互不相同**（新一档 ${REL_NEW} / 同版本 ${REL_SAME} / 更旧 ${REL_OLD}）—— 全部从 APP_VERSION 推，判据里不写死号`,
          `新=${REL_NEW} · 同=${REL_SAME} · 旧=${REL_OLD}`,
          '反向对照：把推导改成"返回 APP_VERSION"⇒ 这一条当场假',
        )
        const ctxRel = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
        await ctxRel.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxRel.addInitScript((base) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(base))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        const rp = await ctxRel.newPage()
        rp.on('pageerror', (e) => errors.push(`PAGEERROR(版本更新) :: ${e.message}`))
        rp.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(版本更新) :: ${m.text()}`)
        })
        /** 公告这一摊一次读回来（哪一档 / 强不强 / 有没有关掉的落点 / 页面在不在） */
        const relProbe = () =>
          rp.evaluate(() => {
            const el = document.querySelector('[data-release-screen]')
            const dl = document.querySelector('[data-release-download]')
            return {
              screens: document.querySelectorAll('[data-release-screen]').length,
              slot: el?.getAttribute('data-release-slot') ?? null,
              force: el?.getAttribute('data-release-force') ?? null,
              title: String(document.querySelector('[data-release-title]')?.textContent ?? '').trim(),
              note: String(document.querySelector('[data-release-note]')?.textContent ?? '').trim(),
              close: document.querySelectorAll('[data-release-close]').length,
              later: document.querySelectorAll('[data-release-later]').length,
              download: document.querySelectorAll('[data-release-download]').length,
              href: dl?.getAttribute('href') ?? null,
              navs: document.querySelectorAll('nav').length,
              text: String(document.body.innerText).replace(/\s+/g, ' ').trim(),
            }
          })
        /** 等公告上屏（条件等待，**不等固定毫秒**）；超时就让它去红，不吞错 */
        const waitRelease = async (ms = 8000) => {
          try {
            await rp.waitForSelector('[data-release-screen]', { state: 'attached', timeout: ms })
            return true
          } catch {
            return false
          }
        }
        /** 开屏那层要退场才截图（它是 `z-index: 200` 的全屏浮层，留着会把画面盖住） */
        const waitBoot = async () => {
          try {
            await rp.waitForSelector('[data-splash]', { state: 'detached', timeout: 8000 })
          } catch {
            /* 退不出去不阻塞断言：那是个独立的已知问题，这里不替它兜底也不替它判红 */
          }
        }
        try {
          /* ---- ① 教师端 · **强制**：整屏接管、一个能关的落点都没有、Esc 也关不掉 ---- */
          await rp.goto(`${BASE}/?rel=${REL_NEW}&force=1`, { waitUntil: 'networkidle' })
          const a1 = await waitRelease()
          const R1 = await relProbe()
          check(
            a1 && R1.screens === 1 && R1.slot === 'teacher' && R1.force === '1',
            `🔴 ${SREL}：\`?rel=${REL_NEW}&force=1\`（公告**比本机新一档**）→ 教师端**强制**公告上了屏（data-release-force=1）`,
            `公告 ${R1.screens} 个 · slot=${R1.slot} · force=${R1.force}`,
          )
          check(
            R1.close === 0 && R1.later === 0,
            `🔴 ${SREL}：强制那一档**一个能关的落点都没有**（没有关闭 ×、没有「稍后」）`,
            `[data-release-close] ${R1.close} 个 · [data-release-later] ${R1.later} 个`,
          )
          check(
            R1.download === 1 && String(R1.href ?? '').startsWith('https://'),
            `🔴 ${SREL}：「下载最新版」**恰好一个**，而且 \`href\` 是 https:// 开头（只显示不执行）`,
            `按钮 ${R1.download} 个 · href=${JSON.stringify(R1.href)}`,
          )
          check(
            R1.navs === 0 && !R1.text.includes('今日待办') && !R1.text.includes('快捷操作'),
            `🔴 ${SREL}：**整屏接管** —— 导航 ${R1.navs} 个、工作台的「今日待办 / 快捷操作」一个字都不在屏上`,
            `nav ${R1.navs} 个 · 今日待办=${R1.text.includes('今日待办')} · 快捷操作=${R1.text.includes('快捷操作')}`,
            '反向对照：下面第 ② 条（选择性那一档这三样**都在** —— 关掉就能用）',
          )
          await waitBoot()
          await shot(rp, SREL, '131-release-force', { full: true })
          await rp.keyboard.press('Escape')
          await rp.waitForTimeout(320)
          const R1b = await relProbe()
          check(
            R1b.screens === 1,
            `🔴 ${SREL}：按 **Esc 关不掉**（强制那一档没有 Esc 那条路）`,
            `按 Esc 之后公告 ${R1b.screens} 个`,
          )

          /* ---- ② 教师端 · **选择性**：有关闭 × 与「稍后」，页面照常在下面 ---- */
          await rp.goto(`${BASE}/?rel=${REL_NEW}`, { waitUntil: 'networkidle' })
          const a2 = await waitRelease()
          const H1 = await relProbe()
          check(
            a2 && H1.screens === 1 && H1.force === '0',
            `🔴 ${SREL}：\`?rel=${REL_NEW}\`（比本机新一档、不加强制）→ 选择性公告上了屏（data-release-force=0）`,
            `公告 ${H1.screens} 个 · force=${H1.force}`,
          )
          check(
            H1.close === 1 && H1.later === 1,
            `${SREL}：选择性那一档**有**关闭 × 与「稍后」（各恰好一个）`,
            `[data-release-close] ${H1.close} 个 · [data-release-later] ${H1.later} 个`,
          )
          check(
            H1.title.includes('有新版本'),
            `${SREL}：标题是「有新版本」（选择性那一档的固定措辞）`,
            JSON.stringify(H1.title),
          )
          check(
            H1.note.includes(`v${REL_NEW} 已发布，建议更新。`),
            `${SREL}：正文是默认那句「v${REL_NEW} 已发布，建议更新。」（公告那一版的号）`,
            JSON.stringify(H1.note),
          )
          check(
            H1.navs > 0 && H1.text.includes('今日待办') && H1.text.includes('快捷操作'),
            `🔴 ${SREL}：而且**页面照常在下面**（导航 ${H1.navs} 个 · 「今日待办 / 快捷操作」都在）—— "关掉就能用"`,
            `nav ${H1.navs} 个 · 今日待办=${H1.text.includes('今日待办')} · 快捷操作=${H1.text.includes('快捷操作')}`,
          )
          await waitBoot()
          await shot(rp, SREL, '132-release-soft', { full: true })
          await rp.click('[data-release-later]')
          await rp.waitForTimeout(320)
          const H2 = await relProbe()
          check(
            H2.screens === 0 && H2.navs > 0,
            `${SREL}：点「稍后」→ 公告消失、**页面还在**（nav ${H2.navs} 个）`,
            `公告 ${H2.screens} 个 · nav ${H2.navs} 个`,
          )
          /* 用户 2026-10-04 拍板：**每次冷启动都再弹一次**（关掉只记在这一次进程里） */
          await rp.goto(`${BASE}/?rel=${REL_NEW}`, { waitUntil: 'networkidle' })
          const a2b = await waitRelease()
          const H3 = await relProbe()
          check(
            a2b && H3.screens === 1,
            `🔴 ${SREL}：**冷启动会再弹一次**（"关过了"只记在这一个进程里 —— 换一次打开就再来）`,
            `重新打开后公告 ${H3.screens} 个`,
          )

          /* ---- ③ 不该提示的两种：同版本 / 我比它新（"读不到"那一侧在 nav-checks 的 A12）----
                 ⚠️ 两个号都**从 APP_VERSION 推**（同版本 / 更旧一档）—— 见本节开头那段说明 */
          for (const [v, why] of [
            [REL_SAME, '与本机 APP_VERSION **同版本**'],
            [REL_OLD, '比本机 APP_VERSION **旧一档**'],
          ]) {
            await rp.goto(`${BASE}/?rel=${v}`, { waitUntil: 'networkidle' })
            await rp.waitForTimeout(700)
            const N = await relProbe()
            check(
              N.screens === 0,
              `🔴 ${SREL}：\`?rel=${v}\`（${why}）→ **一条公告都不弹**`,
              `公告 ${N.screens} 个`,
              '反向对照：① ② 那两条（公告比客户端新时**必须**弹）',
            )
          }

          /* ---- ④ 教室端 · 强制：整屏公告，但**页面不许被卸载**（心跳靠它）---- */
          await rp.goto(`${BASE}/classroom?rel=${REL_NEW}&slot=classroom&force=1`, { waitUntil: 'networkidle' })
          const a4 = await waitRelease()
          const C1 = await relProbe()
          check(
            a4 && C1.screens === 1 && C1.slot === 'classroom' && C1.force === '1',
            `🔴 ${SREL}：教室端那一档 → **整屏**公告（data-release-slot=classroom · force=1）`,
            `公告 ${C1.screens} 个 · slot=${C1.slot} · force=${C1.force}`,
          )
          check(
            C1.text.includes('请在教师电脑上下载后，到这台机器安装。'),
            `${SREL}：教室端那一档多一句「请在教师电脑上下载后，到这台机器安装。」（那块屏要**人工装一次**）`,
            short(C1.text, 200),
          )
          check(
            C1.close === 0 && C1.later === 0,
            `🔴 ${SREL}：教室端强制同样**一个能关的落点都没有**`,
            `close ${C1.close} 个 · later ${C1.later} 个`,
          )
          check(
            C1.screens === 1 && C1.text.includes('高二(3)班'),
            `🔴🔴 ${SREL}：**下面那一页没有被卸载** —— 班级名仍在屏上（教室端**永远保留 children**：` +
              `组件一卸载心跳就停，面板会开始谎报"教室端离线"）`,
            `班级名 ${C1.text.includes('高二(3)班') ? '在' : '没了'} · 公告 ${C1.screens} 个`,
            '⚠️ 更新公告**不**清学生数据（清数据只发生在维护那一档）—— 别把两者混起来',
          )

          /* ---- ⑤ 教室端 · 选择性：关得掉，关掉之后班级名还在 ---- */
          await rp.goto(`${BASE}/classroom?rel=${REL_NEW}&slot=classroom`, { waitUntil: 'networkidle' })
          const a5 = await waitRelease()
          const C2 = await relProbe()
          check(
            a5 && C2.screens === 1 && C2.force === '0' && C2.later === 1,
            `${SREL}：教室端选择性 → 有「稍后」可点（force=0）`,
            `公告 ${C2.screens} 个 · force=${C2.force} · later ${C2.later} 个`,
          )
          await rp.click('[data-release-later]')
          await rp.waitForTimeout(320)
          const C3 = await relProbe()
          check(
            C3.screens === 0 && C3.text.includes('高二(3)班'),
            `${SREL}：点掉之后公告消失、**班级名还在**（教室端那块屏照常能用）`,
            `公告 ${C3.screens} 个 · 班级名 ${C3.text.includes('高二(3)班') ? '在' : '没了'}`,
          )

          /* ---- ⑥ 🔴 `/admin` 豁免：超管**不会**被自己的强制公告锁在外面 ---- */
          await annPage.goto(`${BASE}/admin?roles=${ANN_ROLES}&rel=${REL_NEW}&force=1`, {
            waitUntil: 'networkidle',
          })
          await annPage.waitForTimeout(800)
          const admRel = await annPage.evaluate(() => ({
            screens: document.querySelectorAll('[data-release-screen]').length,
            l0: document.querySelector('[data-admin-l0]') !== null,
          }))
          check(
            admRel.screens === 0 && admRel.l0,
            `🔴🔴 ${SREL}：**\`/admin\` 豁免**（带着 \`?rel=${REL_NEW}&force=1\` 打开超管面板，一条公告都不弹）—— ` +
              `否则超管会被**自己**锁在外面（维护模式已经踩过这条路）`,
            `公告 ${admRel.screens} 个 · 面板 L0 健康条在=${admRel.l0}`,
          )
        } finally {
          await ctxRel.close()
        }
      })

      /* ---------------- ⑦ 「我的」页的反馈块（**位置是被点名的**） ---------------- */
      await step(S2, async () => {
        await annPage.goto(`${BASE}/settings?roles=${ANN_ROLES}`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(700)
        const fb = await annPage.evaluate(() => {
          const block = document.querySelector('[data-feedback-block]')
          const txt = String(document.body.innerText)
          return {
            has: block !== null,
            input: document.querySelectorAll('[data-feedback-input]').length,
            contact: document.querySelectorAll('[data-feedback-contact]').length,
            submit: document.querySelectorAll('[data-feedback-submit]').length,
            /* DOM 顺序：关于 → **反馈** → 更新日志（用可见文案的下标比，够稳且不依赖 DOM 细节） */
            iAbout: txt.indexOf('关于'),
            iFb: txt.indexOf('反馈'),
            iLog: txt.indexOf('更新日志'),
            text: block ? String(block.innerText).replace(/\s+/g, ' ').trim() : '',
          }
        })
        check(
          fb.has && fb.input === 1 && fb.submit === 1,
          `${S2}：「我的」页有一块**反馈**（一个输入框 + 一个提交按钮）`,
          `块 ${fb.has} · 输入框 ${fb.input} · 提交 ${fb.submit}`,
        )
        check(
          fb.iAbout >= 0 && fb.iFb > fb.iAbout && fb.iLog > fb.iFb,
          `🔴 ${S2}：位置就是用户点名的那个 —— **「关于」之后、「更新日志」之前**` +
            `（下标 关于=${fb.iAbout} < 反馈=${fb.iFb} < 更新日志=${fb.iLog}）`,
          `关于=${fb.iAbout} 反馈=${fb.iFb} 更新日志=${fb.iLog}`,
        )
        check(
          fb.text.includes('系统会自动上报'),
          `🔴 ${S2}：并且指出"登录不上 / 页面报错"走**自动上报**那条路（不允许匿名提交反馈）`,
          short(fb.text, 200),
        )
        /* 提交按钮：正文不到 5 个字时**真 disabled** */
        const submitBtn = annPage.locator('[data-feedback-submit]')
        check(await submitBtn.isDisabled(), `${S2}：正文少于 5 个字时提交按钮 disabled`, 'disabled = true')
        await annPage.fill('[data-feedback-input]', '作业导入的图太大，点导出没反应')
        await annPage.waitForTimeout(200)
        check(!(await submitBtn.isDisabled()), `${S2}：写了正文之后按钮可以点（本地模式点了也只会得到人话错误）`, 'disabled = false')

        /*
         * 🆕 2026-10-09：**登出按钮挪到显眼处**（用户实测原话：「（退出登录）应该有一个」——
         *    而它本来就有，只是**在整页最底下**，而这一页很长 → 找不到）。
         *    这一轮把它挪进**第一张卡（身份卡）**，与账号有关的事放在一起。
         * 🔴 这里钉的是**真 DOM**（不是源码）：
         *      ① 整页**只有 1 个**「退出登录」按钮 —— **挪，不是复制**；
         *      ② 它在**第一张卡**里，而且排在后面那些节（备份与恢复 / 关于 / 更新日志）**之前**
         *         —— 也就是真的从页尾挪上来了（不是挪到了另一个看不见的地方）。
         * ⚠️ 反向对照：把那段按钮复制一份塞回页尾 → 这一条的 `count === 1` **当场红**。
         *    源码那一侧（`signOutEverywhere()` 只有一处 + 那两句行为一个字没改）在
         *    `rls-checks` 第二十四节，那边**真跑过**这个反向对照。
         */
        const logout = await annPage.evaluate(() => {
          const txt = String(document.body.innerText)
          const btns = [...document.querySelectorAll('button')].filter(
            (b) => (b.innerText ?? '').replace(/\s+/g, '') === '退出登录',
          )
          const firstPanel = btns[0]?.closest('section.panel') ?? null
          return {
            count: btns.length,
            iLogout: txt.indexOf('退出登录'),
            /* 用**靠后**那一节当锚：「关于」在页头副标题里也出现（"账号 · 数据 · 关于"），拿它当锚会假绿 */
            iBackup: txt.indexOf('备份与恢复'),
            iLog: txt.indexOf('更新日志'),
            /* "第一张卡"= 那块**身份卡**（它的标志是「任教班级」那一行），不靠 `.panel` 的先后顺序 */
            inIdentityCard: firstPanel ? /任教班级/.test(firstPanel.innerText ?? '') : false,
          }
        })
        check(
          logout.count === 1,
          `${S2}：🔴 整页**只有 1 个**「退出登录」按钮（**挪，不是复制**）`,
          `数到 ${logout.count} 个`,
        )
        check(
          logout.inIdentityCard &&
            logout.iLogout >= 0 &&
            logout.iBackup > logout.iLogout &&
            logout.iLog > logout.iLogout,
          `${S2}：🔴 它就在**身份卡**里（与「任教班级 / 我的身份 / 当前班级」同一张卡），` +
            '排在「备份与恢复 / 更新日志」**之前** —— 真的挪到显眼处了',
          `在身份卡里=${logout.inIdentityCard} · 退出登录=${logout.iLogout} < 备份与恢复=${logout.iBackup} < 更新日志=${logout.iLog}`,
        )
        await shot(annPage, S2, '103-settings-feedback', { full: true })
      })

      /* ================================================================
         ⑦b · 🆕 2026-10-04「我的 → 关于」那三颗下载按钮（用户当天「我的」页第 ① 条）
         ----------------------------------------------------------------
         用户原话：「把学科学段和存储位置删了，放三个按钮，分别是下载教师端（安卓）
         下载教师端（Windows）下载教室端（Windows）……按钮就绑定面板里面我填的网址就好了」。
         🔴 链接来自**面板里填的那两行**（`/api/status` 的 `release` 块），而这一节跑的是
            本地演示模式（没有服务端）⇒ 用 DEV 钩子把"面板填了哪几个"造出来：
              · 不带 `?rel=`        ⇒ 那一档没在发公告 ⇒ **一颗都不摆**（不是死按钮）；
              · `?urls=apk`         ⇒ 只有「下载教师端（安卓）」那一颗；
              · `?urls=exe`         ⇒ 只有「下载教师端（Windows）」那一颗；
              · `?urls=both`（默认）⇒ 教师端两颗都在；
              · `&slot=classroom`   ⇒ 教室端那颗**只看 `url_exe`**（apk 也填了，但一体机只给 exe）。
            四种组合（都没填 / 只填 apk / 只填 exe / 两个都填）逐个走一遍。
         ⚠️ 这一节**一张图都不出**（判据在 DOM 上；加图要动 `EXPECTED_FILES`，那是集合相等）。
         ⚠️ 不写版本号字面量：`?rel=` 那个号**从 `APP_VERSION` 推**（末位 +1，比本机新一档）。
         ================================================================ */
      await step(`${S2} · ⑦b 「关于」三颗下载按钮（面板填了哪几个就摆哪几颗）`, async () => {
        const { APP_VERSION: AV7b } = await import('../src/lib/version.ts')
        const REL_UP7b = (() => {
          const p = AV7b.split('.').map(Number)
          p[p.length - 1] += 1
          return p.join('.')
        })()
        /**
         * 这一屏上的下载按钮（**按稳定标识数，不按文案**）。
         * ⚠️ 公告浮层那颗「下载最新版」是 `[data-release-download]`，与这里的选择器不重叠。
         */
        const readDl = (p) =>
          p.evaluate(() =>
            [...document.querySelectorAll('[data-download-slot]')].map((a) => ({
              key: a.getAttribute('data-download-slot'),
              label: String(a.textContent ?? '').replace(/\s+/g, ' ').trim(),
              href: a.getAttribute('href'),
              newTab: a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noreferrer',
            })),
          )
        /**
         * 这一屏"像样"吗：**恰好**是期望的那几颗（顺序也对）· 每一颗都点得出去
         * （`href` 是 https + 新标签 + `noreferrer`）· 没有空文案。
         */
        const dlOk = (list, wantKeys) =>
          list.length === wantKeys.length &&
          list.map((d) => d.key).join(',') === wantKeys.join(',') &&
          list.every((d) => String(d.href ?? '').startsWith('https://') && d.label && d.newTab)
        const openSettings = async (q) => {
          await annPage.goto(`${BASE}/settings?roles=${ANN_ROLES}${q}`, { waitUntil: 'networkidle' })
          await annPage.waitForTimeout(700)
          return readDl(annPage)
        }

        /* ---- 组合一：面板里一个地址都没填（这一档也没在发公告）⇒ 一颗都不摆 ---- */
        const D0 = await openSettings('')
        check(
          dlOk(D0, []),
          `🔴 ${S2} ①「关于」下载按钮：面板里**一个地址都没填**（这一档也没在发公告）⇒ **一颗都不摆** —— 点了没反应的死按钮比少一颗按钮糟得多`,
          `摆了 ${D0.length} 颗：${JSON.stringify(D0.map((d) => d.key))}`,
        )

        /* ---- 组合二：只填了安卓那个地址 ⇒ 只摆「下载教师端（安卓）」 ---- */
        const D1 = await openSettings(`&rel=${REL_UP7b}&urls=apk`)
        check(
          dlOk(D1, ['teacher-apk']) && D1[0]?.label === '下载教师端（安卓）',
          `🔴 ${S2} ①：面板里**只填了安卓**那个地址 ⇒ 屏上只有「下载教师端（安卓）」那一颗（教室端那颗更不许出现 —— 它那一档没在发公告）`,
          JSON.stringify(D1.map((d) => [d.key, d.href])),
        )

        /* ---- 组合三：只填了 Windows 那个地址 ⇒ 只摆「下载教师端（Windows）」 ---- */
        const D2 = await openSettings(`&rel=${REL_UP7b}&urls=exe`)
        check(
          dlOk(D2, ['teacher-exe']) && D2[0]?.label === '下载教师端（Windows）',
          `🔴 ${S2} ①：面板里**只填了 Windows** 那个地址 ⇒ 屏上只有「下载教师端（Windows）」那一颗`,
          JSON.stringify(D2.map((d) => [d.key, d.href])),
        )

        /* ---- 组合四：两个都填 ⇒ 教师端两颗都在，链接就是面板里那两条 ---- */
        const D3 = await openSettings(`&rel=${REL_UP7b}`)
        check(
          dlOk(D3, ['teacher-apk', 'teacher-exe']) &&
            D3.every((d) => d.href === 'https://example.com/update') &&
            D3.map((d) => d.label).join(' · ') === '下载教师端（安卓） · 下载教师端（Windows）',
          `🔴 ${S2} ①：两个都填 ⇒ 教师端两颗都在（文案就是用户点名的那两句、href 就是面板那一档里的两条）`,
          D3.map((d) => `${d.label}=${d.href}`).join(' · '),
        )

        /* ---- 教室端那一档：**只看 `url_exe`**（apk 那一列对它没意义） ---- */
        const D4 = await openSettings(`&rel=${REL_UP7b}&slot=classroom`)
        check(
          dlOk(D4, ['classroom-exe']) && D4[0]?.label === '下载教室端（Windows）',
          `🔴 ${S2} ①：教室端那一档**两个地址都填了**，而屏上只有「下载教室端（Windows）」一颗 —— 教室那块屏是一体机`,
          JSON.stringify(D4.map((d) => [d.key, d.href])),
        )

        /* 🧪 反向对照：往这一屏塞一颗 `http://` 的假按钮（点了也装不上）⇒ 同一套判据当场判假 */
        await annPage.evaluate(() => {
          const a = document.createElement('a')
          a.setAttribute('data-download-slot', 'fake-dead')
          a.setAttribute('href', 'http://example.com/x.apk')
          a.textContent = '下载教师端（安卓）'
          document.body.appendChild(a)
        })
        const D5 = await readDl(annPage)
        check(
          !dlOk(D5, ['classroom-exe']),
          `🧪 ${S2} ① 反向对照：往这一屏塞一颗 \`http://\` 的假按钮（点了也装不上）⇒ 同一套判据当场判假（证明它真的在数按钮、真的在验 https）`,
          `塞过之后读到 ${D5.length} 颗 · 判据=${dlOk(D5, ['classroom-exe'])}`,
        )
      })

      /* ================= S21：🆕 教师档案（家庭住址 · 电话号码 · 邮箱）=================
       *
       * 表是 `teacher_profiles`（`supabase/schema.sql` §1.1 建表 / §36 策略）。
       * 🔴 **判据全在数据库**：读 = 自己那一行 ∪ `can_create_teacher_accounts()`
       *    （超管 / 教务处 / 办公室主任），**写也是那一档**；**教室端 0 行**。
       *    那一侧由 `rls-checks` 第二十节逐身份验（含"教室端 0 行 + 照旧读得到自己那行"的对照）。
       *
       * ⚠️ **这一节钉不了"真界面"**：那三格在 `/accounts` 的老师详情面板里，而那一页要服务端
       *    （`functions/api/teacher-account.ts`）—— 本地演示模式打不开它（与 §三十五 那条限制同源，
       *    `/manage` 那一节已经钉过"页面渲染的是打不开那张面板"）。
       *    所以这里钉**能钉的那一半**：三个字段的名字与库里那三列**逐字对齐**、
       *    探针用 `select('*')`、以及"演示模式下不许摆一份假档案"（宁可不摆，也不给"看起来能读"的错觉）。
       */
      const S21 = 'S21 教师档案（字段名对齐 + 探针形状 + 不摆假数据）'
      await step(S21, async () => {
        const profSrc = readFileSync(join(HERE, '..', 'src', 'lib', 'teacherProfile.ts'), 'utf8')
        const keys = [...profSrc.matchAll(/\{\s*key:\s*'([A-Za-z]+)'/g)].map((m) => m[1])
        check(
          JSON.stringify(keys) === JSON.stringify(['homeAddress', 'phone', 'email']),
          `${S21}：` + '`lib/teacherProfile.ts` 的字段顺序 = 家庭住址 · 电话号码 · 邮箱（三格，只此一处定义）',
          keys.join(' · ') || '(一个都没读到)',
        )

        /* 库里那三列：从 `schema.sql` 的建表段里读（**两处必须逐字对齐**，靠这条钉住） */
        const schemaSrc = readFileSync(join(HERE, '..', '..', 'supabase', 'schema.sql'), 'utf8')
        const start = schemaSrc.indexOf('create table if not exists teacher_profiles')
        check(start > 0, `${S21}：\`schema.sql\` 里找得到 \`teacher_profiles\` 的建表段`, start > 0 ? `下标 ${start}` : '没找到')
        const block = start > 0 ? schemaSrc.slice(start, start + 400) : ''
        const cols = [...block.matchAll(/^\s{2}([a-z_]+)\s+text/gm)].map((m) => m[1])
        check(
          JSON.stringify(cols) === JSON.stringify(['home_address', 'phone', 'email']),
          `${S21}：` + '库里那三列 = `home_address` · `phone` · `email`（与上面那三个 key 一一对应）',
          cols.join(' · ') || '(一列都没读到)',
        )
        /*
         * 🔴 **三列全部可空**：建号那条路一个字都不碰这张表（用户口径："非必填"）。
         *    这里核的是**列定义里没有 `not null`**（源码形状）；
         *    "真的存得进去"由 `rls-checks` 第二十节那条"只给 teacher_id 也插得进"钉住。
         */
        const colsPart = block.split(');')[0] ?? ''
        check(
          !/not null/.test(colsPart),
          `${S21}：🔴 三列**全部可空**（建号不碰这张表 —— 一行都没有 = 没录过）`,
          /not null/.test(colsPart) ? short(colsPart, 140) : '列定义里没有 not null',
        )

        /*
         * 🔴 **表存在性探针用 `select('*')`**（`nav-checks` D10-A 也静态扫这一条）——
         *    表存在性与"有哪几列"无关（这一类 bug 咬过两次：`subjects` 没有 `id`、
         *    `notice_targets` 没有 `id`）。这里再钉一次，让看截图报告的人也看得到。
         */
        const probeAt = profSrc.indexOf("from('teacher_profiles')")
        const probeCall = probeAt >= 0 ? profSrc.slice(probeAt, probeAt + 40) : ''
        check(
          /from\('teacher_profiles'\)\.select\('\*'\)/.test(probeCall),
          `${S21}：🔴 探针用的是 \`select('*')\`（不许写成具体列名）`,
          probeCall || '没找到探针',
        )
        check(
          !/\.upsert\(|\.delete\(\)/.test(profSrc),
          `${S21}：🔴 \`lib/teacherProfile.ts\` **不写库**（写只走服务端 \`profile\` 动作，判据在数据库）`,
          /\.upsert\(|\.delete\(\)/.test(profSrc) ? '里面出现了写操作' : '只有读取',
        )

        /* 演示模式：这一页要服务端 → 渲染的是"打不开"那张面板，**不摆一份假档案** */
        await annPage.goto(`${BASE}/accounts`, { waitUntil: 'networkidle' })
        await annPage.waitForTimeout(420)
        const acct = await bodyText(annPage)
        check(
          acct.length > 0 && !acct.includes('教师档案'),
          `${S21}：⚠️ 本地演示模式（没有数据库）→ \`/accounts\` 上**不摆**教师档案那三格（不编假数据）`,
          short(acct, 120),
        )
        check(
          new URL(annPage.url()).pathname === '/accounts',
          `${S21}：而且它是**照常渲染这一页**（不跳登录页、不白屏）—— 打不开的是服务端，不是路由`,
          new URL(annPage.url()).pathname,
        )

        /*
         * 🔴 2026-10-07：`/accounts` 的**页面标题改成「教师管理」**（用户点名：
         *    「"教师账号"改成"教师管理"」—— 卡片名早就改了，页面标题还留着旧名）。
         * 判据取的是 **`<h1>` 本身**（不是整页文案）：`roles.ts` / `pages.ts` 里
         * 还留着「教师账号」这个**导航/登记表用的标签**，整页文案里搜会撞上它们
         * （那两个文件这一轮**不许碰**）。反向对照：把标题改回「教师账号」→ 立刻红。
         */
        {
          const head = await annPage.evaluate(() => ({
            title: document.querySelector('h1')?.textContent?.trim() ?? '',
            body: document.body.innerText,
          }))
          check(
            head.title === '教师管理',
            `${S21}：🔴 \`/accounts\` 的**页面标题是「教师管理」**（不是「教师账号」）` +
              '—— 与入口卡片名统一；反向对照：改回「教师账号」→ 这一条红',
            `h1 = ${JSON.stringify(head.title)}`,
          )
          check(
            head.body.includes('建号 · 学科 · 任课关系 · 身份 · 部门'),
            `${S21}：副标题照旧说清这一页能做什么（建号 / 学科 / 任课关系 / 身份 / 部门）`,
            short(head.body.match(/.{0,6}建号.{0,40}/)?.[0] ?? '', 120),
          )
        }
      })
      /* ============================================================
         🆕 2026-10-07 「撤下」按钮的判据在**服务端**（list 回话里的 `canRevoke`）
         ------------------------------------------------------------
         用户实测报的：「我作为最高管理员为什么没法删除其他人发的通知」。
         根因：服务端 revoke 那一支的判据是 `自己发的 || is_school_admin()`
         （教务处与超管是唯一的例外），而界面上的条件写的是 `notice.mine` ——
         **前端自己又写了一套更窄的判据** → 超管 / 教务处根本看不到那个按钮。
         这是"**服务端允许、前端没摆按钮**"这一类 bug 的**第二次**（第一次是开学准备页）。

         这一节钉三件事（**一张图都不出**：判据在源码与 DOM 上，加图要动 `EXPECTED_FILES`）：
           ① 服务端 **list 那一支**回一个 `canRevoke`，判据与 revoke 那一支**逐字同一套**；
           ② 并且 `is_school_admin` **只问一次**（列表最多 200 条，逐条问就是 N+1）；
           ③ 界面**只照那个布尔摆** —— NoticeCard 里没有任何本地角色推断。
         外加**真界面**的角色矩阵（演示模式注入快照，机制见 SID 那一节的 `?roles=`）：
           超管 / 教务处 → **别人的**通知上也有「撤下」；
           年级主任 / 班主任 / 科任老师 → 别人的没有、自己发的有；
           已撤下的那条 → 不再摆（**状态**）；服务端说不能撤的 → 也不摆（**许可**）。

         ⚠️ 反向对照（本轮**真跑过**，红了才算数）：把 `Notices.tsx` 里那个条件
            从 `notice.canRevoke && !revoked` 改回 `notice.mine && !revoked` →
            「超管」「教务处」那两条**必须红**（其余三条照旧绿 = 对照本身能红、也不是全红）。
         ============================================================ */
      const SRV = '撤下按钮'
      await step(SRV, async () => {
        const src = (p) => readFileSync(join(HERE, '..', p), 'utf8')
        const apiSrc = src('functions/api/notice.ts')
        const pageSrc = src('src/pages/Notices.tsx')
        const libSrc = src('src/lib/notices.ts')

        /* ---- ① 服务端：list 那一支算 `canRevoke`，与 revoke 那一支同一套判据 ---- */
        const listSlice = apiSrc.slice(
          apiSrc.indexOf("if (action === 'list')"),
          apiSrc.indexOf("if (action === 'seen')"),
        )
        const revokeSlice = apiSrc.slice(
          apiSrc.indexOf("if (action === 'revoke')"),
          apiSrc.indexOf("if (action === 'pin')"),
        )
        check(
          listSlice.length > 0 && revokeSlice.length > 0,
          `${SRV}：找得到服务端 list / revoke 那两支（同样按关键字切，**不靠行号**）`,
          `list ${listSlice.length} 字符 · revoke ${revokeSlice.length} 字符`,
        )
        check(
          /canRevoke:\s*isMine\s*\|\|\s*revokeBroad/.test(listSlice),
          `${SRV}：🔴 list 回话里**每条通知**带 \`canRevoke\`，判据 = \`自己发的 || is_school_admin()\``,
          /canRevoke:[^\n]*/.exec(listSlice)?.[0]?.trim() ?? '没找到',
        )
        check(
          /const revokeBroad = await rpcBool\(env, me\.token, 'is_school_admin'\)/.test(listSlice),
          `${SRV}：🔴 那个布尔是**服务端拿调用者 JWT 问数据库**算出来的（不是前端推的、也不是写死的角色表）`,
          /is_school_admin/.test(listSlice) ? 'list 里出现 is_school_admin' : 'list 里没有它',
        )
        /*
         * ⚠️ 数的必须是**调用**，不是"这个词出现过几次" —— 上面那段注释里也写着
         *    `is_school_admin`（第一版就是这么错的：注释里那几次被算成了 N+1）。
         *    所以只数那个一模一样的调用式子。
         */
        const broadHits = (
          listSlice.match(/rpcBool\(env, me\.token, 'is_school_admin'\)/g) ?? []
        ).length
        check(
          broadHits === 1,
          `${SRV}：🔴 \`is_school_admin\` 在 list 里只**问一次**（不是 N+1；它与我有关、与哪一条无关）`,
          `调用 ${broadHits} 次`,
          '反向对照：把那次 RPC 挪进 map 里（每条问一次）→ 这一条必须红',
        )
        check(
          /isMine/.test(revokeSlice) &&
            /is_school_admin/.test(revokeSlice) &&
            /!isMine && !broad/.test(revokeSlice),
          `${SRV}：revoke 那一支用的确实是 \`isMine || is_school_admin\`（list 回的那个布尔就是它，两处同一套）`,
          'revoke 里同时有 isMine / is_school_admin / !isMine && !broad',
        )

        /* ---- ② 前端：只照那个布尔摆；NoticeCard 里不许有本地角色推断 ---- */
        check(
          /\{\s*notice\.canRevoke\s*&&\s*!revoked\s*\?/.test(pageSrc),
          `${SRV}：🔴「撤下」的条件 = \`notice.canRevoke && !revoked\``,
          (pageSrc.match(/\{\s*notice\.(?:canRevoke|mine)\s*&&\s*!revoked\s*\?/) ?? ['没找到这一句'])[0].trim(),
        )
        check(
          !/\{\s*notice\.mine\s*&&\s*!revoked\s*\?/.test(pageSrc),
          `${SRV}：🔴 它**不是** \`notice.mine\`（那正是这个 bug 的形状：超管/教务处看不到别人的「撤下」）`,
          /\{\s*notice\.mine\s*&&\s*!revoked\s*\?/.test(pageSrc) ? '又写回 mine 了' : '没有这一句',
        )
        const cardSrc = pageSrc.slice(pageSrc.indexOf('function NoticeCard'))
        check(
          cardSrc.length > 0 &&
            !/isSuperAdmin|hasManagingRole|canEditClassFor|isSchoolLeader|canPublishNotice|'super'|'admin'/.test(
              cardSrc,
            ),
          `${SRV}：NoticeCard 里**没有任何本地角色推断**（"摆不摆"只读服务端那一个布尔）`,
          '整段 NoticeCard 里没有角色字面量、也没有角色函数',
        )
        check(
          /canRevoke:\s*raw\.canRevoke === true/.test(libSrc),
          `${SRV}：\`lib/notices.ts\` 把它归一成布尔（老服务端没有这个字段 → false = 不摆，不编一个必然 403 的按钮）`,
          /canRevoke:[^\n]*/.exec(libSrc)?.[0]?.trim() ?? '没找到',
        )

        /* ---- ③ 真界面：五个身份 × 四种通知，按钮摆不摆**只跟 canRevoke 走** ----
         *
         * ⚠️ 夹具里那个 `canRevoke` 是**照服务端那条判据**（`自己发的 || super/admin`）算的：
         *    本地演示模式没有服务端，界面这一半只能这样喂进去；判据那一半由上面 ① 的
         *    源码断言钉着（真库那一侧另由 `rls-checks.mjs` 的 RLS 断言守着）。**两半合起来**
         *    才是"服务端允许 → 前端就摆"。
         */
        const RME = TEACHER_STATE.state.teacher.id
        const mkNotices = (broad) => {
          const mk = (title, senderId, revokedAt, canRevoke) => ({
            id: `rv-${title}`,
            title,
            body: '夹具正文',
            scopeKind: 'school',
            senderId,
            createdAt: Date.UTC(2026, 8, 19, 1, 0, 0),
            expiresAt: null,
            pinned: false,
            revokedAt,
            expired: false,
            mine: senderId === RME,
            unread: false,
            targets: [{ kind: 'school' }],
            canRevoke,
          })
          return [
            /* 甲：别人发的 —— 只有教务处 / 超管的 `canRevoke` 是 true */
            mk('甲 · 别人发的', 't-2', null, broad),
            /* 乙：我发的 —— `mine` 那一半，任何身份都是 true */
            mk('乙 · 我发的', RME, null, true),
            /* 丙：别人发的、**已撤下** —— 许可没变（broad），收起来的是"状态" */
            mk('丙 · 别人发的（已撤下）', 't-2', Date.UTC(2026, 8, 19, 2, 0, 0), broad),
            /* 丁：我发的、但**服务端说不能撤**（老服务端 / 未许可）—— 也不摆：
                  这一条专门证明按钮看的是**服务端那个布尔**，不是 `mine` */
            mk('丁 · 我发的（服务端说不能撤）', RME, null, false),
          ]
        }

        const ctxRv = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'zh-CN' })
        await ctxRv.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxRv.addInitScript((base) => {
          /* 只在这个脚本里用的 `?rv=`（产品代码读都不读它）：把"服务端会回的那一份"塞进快照 */
          const raw = new URLSearchParams(location.search).get('rv')
          const state = raw ? { ...base, ...JSON.parse(raw) } : base
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE.state)

        const rvPage = await ctxRv.newPage()
        rvPage.on('pageerror', (e) => errors.push(`PAGEERROR(撤下按钮) :: ${e.message}`))
        rvPage.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(撤下按钮) :: ${m.text()}`)
        })

        /**
         * 那一张通知卡里有没有**正文刚好是「撤下」的那个按钮**。
         * ⚠️ 「已撤下」是卡片里的一行 div（不是按钮）**不算** —— 所以比的是按钮文字。
         * 🆕 2026-09-27：顺手把那一颗按钮里 `<path d="…">` 的 `d` 全带回来 ——
         * 「撤下」的**图标语义**（"不再显示" vs 垃圾桶）由上面那个 `looksLikeEyeOff()` 判。
         */
        const cardRevoke = (p, title) =>
          p.evaluate((t) => {
            const card = [...document.querySelectorAll('section.panel')].find((s) =>
              String(s.innerText ?? '').includes(t),
            )
            if (!card) return { found: false, has: null, ds: [] }
            const btn = [...card.querySelectorAll('button')].filter(
              (b) => String(b.innerText ?? '').trim() === '撤下',
            )
            const ds = btn.length
              ? [...btn[0].querySelectorAll('path')].map((x) => String(x.getAttribute('d') ?? ''))
              : []
            return { found: true, has: btn.length > 0, n: btn.length, ds }
          }, title)

        const RBAC = [
          ['super', [{ role: 'super' }], true, '最高管理员'],
          ['admin', [{ role: 'admin' }], true, '教务处'],
          ['grade_head', [{ role: 'grade_head' }], false, '年级主任'],
          ['head_teacher', [{ role: 'head_teacher' }], false, '班主任'],
          ['teacher', [{ role: 'teacher' }], false, '科任老师'],
        ]
        for (const [as, roles, broad, who] of RBAC) {
          const q = encodeURIComponent(
            JSON.stringify({ myRoles: roles, notices: mkNotices(broad), noticesState: 'present' }),
          )
          await rvPage.goto(`${BASE}/notices?rv=${q}`, { waitUntil: 'networkidle' })
          await rvPage.waitForTimeout(420)
          const other = await cardRevoke(rvPage, '甲 · 别人发的')
          const own = await cardRevoke(rvPage, '乙 · 我发的')
          const revoked = await cardRevoke(rvPage, '丙 · 别人发的（已撤下）')
          const noPerm = await cardRevoke(rvPage, '丁 · 我发的（服务端说不能撤）')
          check(
            other.found && other.has === broad,
            `${SRV}：${who}${broad ? ' → **别人的通知上也有「撤下」**（服务端允许就摆，点了真的能撤）' : ' → 别人的通知上**没有**「撤下」（服务端会 403，不编一个必然失败的按钮）'}`,
            other.found ? `别人的那条：撤下按钮 ${other.has ? '在' : '不在'}` : '没找到那一张卡',
            broad ? '反向对照：`Notices.tsx` 改回 `notice.mine` → 这一条必须红' : '',
          )
          check(
            own.found && own.has === true,
            `${SRV}：${who} → **自己发的**那条有「撤下」（\`mine\` 那一半对所有身份都成立）`,
            own.found ? `我发的那条：撤下按钮 ${own.has ? '在' : '不在'}` : '没找到那一张卡',
          )
          check(
            revoked.found && revoked.has === false && noPerm.found && noPerm.has === false,
            `${SRV}：${who} → **已撤下的**不摆（状态），**服务端说不能撤的**也不摆（许可）—— 两者是两件事`,
            `已撤下：${revoked.has ? '还在摆' : '已收起'} · 没许可：${noPerm.has ? '还在摆' : '已收起'}`,
          )
          /* 🆕 2026-09-27：那颗按钮的**图标**说的是"不再显示"（`IconEyeOff`），不是"删除" */
          check(
            own.found && own.has === true && looksLikeEyeOff(own.ds) === true,
            `${SRV}：${who} → 屏上那颗「撤下」的图标是 **"不再显示"**（\`IconEyeOff\` 那一撇在、垃圾桶的盖子不在）`,
            own.found ? `按钮上的 d：${short((own.ds ?? []).join(' | '), 120)}` : '没找到那一张卡',
            '反向对照：`Notices.tsx` 换回 `IconTrash` → 这一条必须红（判据本身能不能红，见「撤下图标」那一节）',
          )
          if (as === 'super') {
            /* 顺手钉一句：这一页**真的**渲染了那四条（不然上面全是"没找到卡"的假绿） */
            const body = await bodyText(rvPage)
            check(
              ['甲 · 别人发的', '乙 · 我发的', '丙 · 别人发的（已撤下）', '丁 · 我发的（服务端说不能撤）'].every(
                (t) => body.includes(t),
              ),
              `${SRV}：🔴 四条夹具通知**都真的画在屏上**（否则上面那些"没找到卡"会变成假绿）`,
              short(body, 160),
            )
          }
        }
        await ctxRv.close()
      })

      /* ============================================================
         🆕 2026-10-07 「置顶」按钮 —— 补完一个**只做了一半**的功能
         ------------------------------------------------------------
         形状：服务端 `pin` 那一支在、`notices.pinned` 列在、列表排序（`pinned` 优先）在、
         `store.pinNotice` 也写好了 —— **而全仓没有调用者**，界面上一个置顶按钮都没有。
         于是"能存、能排、没人能点"。这一节把"能点"钉住。

         钉六件事（**一张图都不出**：判据在源码与 DOM 上，加图要动 `EXPECTED_FILES`）：
           ① 服务端 list 那一支回 `canPin`，判据 = `is_school_admin()`（与 `pin` 那一支同一套）；
           ② 并且**不为置顶再问一次** `is_school_admin`（同一个回答喂两个按钮，不是 N+1）；
           ③ `pin` 那一支不满足 → **403**（"前端不摆" ≠ "接口放行"）；
           ④ 界面只照 `canPin` 摆；按钮文字只跟**状态** `pinned` 走（置顶 ↔ 取消置顶）；
           ⑤ `store.pinNotice` **有调用者了**，而且写完立刻重读（列表要按新的 `pinned` 重排）；
           ⑥ 真界面：置顶那条**排到最前**，并且屏上有 `置顶` 那个 Tag（视觉标记与许可无关）。

         外加**真界面**的角色矩阵（`?pn=` 注入快照，机制同上一节的 `?rv=`）：
           超管 / 教务处 → **别人的**通知上也有「置顶」，点了能置顶；
           年级主任 / 班主任 / 科任老师 → 别人的、自己的都**没有**（服务端会 403，不编按钮）。

         ⚠️ 反向对照（本轮**真跑过**，红了才算数）：把 `Notices.tsx` 里那个条件
            从 `notice.canPin && !revoked` 改成 `notice.mine && notice.canPin && !revoked`
            （= 前端又自己写一套更窄的判据）→ 「超管」「教务处」那两条**必须红**，
            其余三条照旧绿（对照能红、也不是全红）。

         ⚠️ 本机跑的是**演示模式**（没有服务端、`call()` 拿不到 session）→ **点不动真按钮**。
            所以"点了成功"那一半钉在 ①③⑤ 的源码断言上，"排到最前"那一半钉在 ⑥ 的真界面上。
         ============================================================ */
      const PIN = '置顶按钮'
      await step(PIN, async () => {
        const src = (p) => readFileSync(join(HERE, '..', p), 'utf8')
        const apiSrc = src('functions/api/notice.ts')
        const pageSrc = src('src/pages/Notices.tsx')
        const libSrc = src('src/lib/notices.ts')
        const typeSrc = src('src/data/types.ts')
        const storeSrc = src('src/data/store.ts')

        /* ---- ① 服务端：list 回 `canPin`，判据与 pin 那一支**逐字同一套** ---- */
        const listSlice = apiSrc.slice(
          apiSrc.indexOf("if (action === 'list')"),
          apiSrc.indexOf("if (action === 'seen')"),
        )
        const pinSlice = apiSrc.slice(apiSrc.indexOf("if (action === 'pin')"))
        check(
          listSlice.length > 0 && pinSlice.length > 0,
          `${PIN}：找得到服务端 list / pin 那两支（同样按关键字切，**不靠行号**）`,
          `list ${listSlice.length} 字符 · pin ${pinSlice.length} 字符`,
        )
        check(
          /canPin:\s*schoolAdmin/.test(listSlice),
          `${PIN}：🔴 list 回话里**每条通知**带 \`canPin\`（服务端算的 → 前端不判角色）`,
          /canPin:[^\n]*/.exec(listSlice)?.[0]?.trim() ?? '没找到',
        )
        /*
         * ⚠️ 这一条同时钉两件事：那个布尔**就是** `is_school_admin()` 的回答，
         *    而且它**复用** list 里那一次 RPC（不是为置顶再问一次 —— 上一节的
         *    "只问一次"断言数的是整段 list 里的调用次数，两次就会红）。
         */
        check(
          /const schoolAdmin = revokeBroad/.test(listSlice) &&
            /const revokeBroad = await rpcBool\(env, me\.token, 'is_school_admin'\)/.test(listSlice),
          `${PIN}：🔴 \`canPin\` 用的就是 \`is_school_admin()\` 那**一次**回答（同一个布尔喂两个按钮）`,
          /const schoolAdmin = [^\n]*/.exec(listSlice)?.[0]?.trim() ?? '没找到',
          '反向对照：把它改成再调一次 `rpcBool(… is_school_admin)` → 上一节的"只问一次"那一条必须红',
        )
        check(
          /is_school_admin/.test(pinSlice) && /if \(!broad\)/.test(pinSlice) && /403/.test(pinSlice),
          `${PIN}：🔴 \`pin\` 那一支的判据也是 \`is_school_admin()\`，不满足 → **403**（"前端不摆"≠"接口放行"）`,
          /if \(!broad\)[^\n]*/.exec(pinSlice)?.[0]?.trim() ?? '没找到',
          '反向对照：把 `if (!broad) …403` 整条删掉 → 这一条必须红',
        )
        check(
          /pinned:\s*body\.pinned !== false/.test(pinSlice),
          `${PIN}：\`pin\` 只改 \`pinned\` 这一列（true = 置顶 / false = 取消置顶），**不删行**`,
          /pinned:[^\n]*/.exec(pinSlice)?.[0]?.trim() ?? '没找到',
        )

        /* ---- ② 前端：只照 `canPin` 摆；文字只跟 `pinned` 走 ---- */
        check(
          /\{\s*notice\.canPin\s*&&\s*!revoked\s*\?/.test(pageSrc),
          `${PIN}：🔴「置顶 / 取消置顶」的条件 = \`notice.canPin && !revoked\`（许可 + 状态）`,
          (pageSrc.match(/\{\s*notice\.canPin[^\n]*/) ?? ['没找到这一句'])[0].trim(),
        )
        check(
          !/notice\.mine[^\n]*notice\.canPin/.test(pageSrc),
          `${PIN}：🔴 它**不是** \`notice.mine\`（前端自己再写一套判据 → 超管/教务处看不到别人的「置顶」）`,
          /notice\.mine[^\n]*notice\.canPin/.test(pageSrc) ? '又写回 mine 了' : '没有这一句',
          '反向对照：改成 `notice.mine && notice.canPin` → 下面超管/教务处那两条必须红',
        )
        check(
          /\{notice\.pinned \? '取消置顶' : '置顶'\}/.test(pageSrc),
          `${PIN}：按钮文字只跟**状态**走（\`pinned\`）：置顶 ↔ 取消置顶`,
          /notice\.pinned \? '取消置顶' : '置顶'/.exec(pageSrc)?.[0] ?? '没找到',
        )
        check(
          /canPin:\s*raw\.canPin === true/.test(libSrc),
          `${PIN}：\`lib/notices.ts\` 把它归一成布尔（老服务端没有这个字段 → false = 不摆）`,
          /canPin:[^\n]*/.exec(libSrc)?.[0]?.trim() ?? '没找到',
        )
        check(
          /canPin\?: boolean/.test(typeSrc),
          `${PIN}：\`Notice\` 类型上带 \`canPin\`（与 \`canRevoke\` 平级 —— 两个许可，别合成一个）`,
          /canPin\?:[^\n]*/.exec(typeSrc)?.[0]?.trim() ?? '没找到',
        )

        /* ---- ③ 🔴 这个功能上一次"只做了一半"的确切形状：函数写好了、**没人调用** ---- */
        check(
          /useStore\(\(s\) => s\.pinNotice\)/.test(pageSrc) &&
            /pinNotice\(n\.id, !n\.pinned\)/.test(pageSrc),
          `${PIN}：🔴 \`store.pinNotice\` **有调用者了**（上一版全仓 grep 不到一个调用者 = 半个功能）`,
          /pinNotice\(n\.id[^\n]*/.exec(pageSrc)?.[0]?.trim() ?? '没找到调用',
          '反向对照：把页面里那两处调用删掉 → 这一条必须红（旧函数是对的，缺的是调用者）',
        )
        check(
          /pinNotice: async \(noticeId, pinned\) => \{[\s\S]{0,400}noticeApi\.pinNotice\(noticeId, pinned\)[\s\S]{0,200}hydrateNotices\(\)/.test(
            storeSrc,
          ),
          `${PIN}：\`pinNotice\` 写完**立刻重读** —— 列表要按新的 \`pinned\` 重排，否则点了像没反应`,
          'store.pinNotice → noticeApi.pinNotice → hydrateNotices()',
        )

        /* ---- ④ 真界面：五个身份 × 四条夹具，按钮摆不摆**只跟 canPin 走** ----
         *
         * ⚠️ 夹具里的 `canPin` 是**照服务端那条判据**（`is_school_admin()` = 超管 ∪ 教务处）算的：
         *    本地演示模式没有服务端，界面这一半只能这样喂进去；判据那一半由上面 ① 与
         *    `rls-checks.mjs` 的 `is_school_admin()` 断言钉着。**两半合起来**才是
         *    "服务端允许 → 前端就摆"。
         * 🔴 置顶那条的 `createdAt` 故意是**四条里最旧**的 —— 排序不看 `pinned` 它会垫底。
         */
        const RME = TEACHER_STATE.state.teacher.id
        const T = {
          other: '甲 · 别人的（未置顶）',
          pinned: '乙 · 别人的（置顶 · 最旧）',
          mine: '丙 · 我发的（未置顶）',
          dead: '丁 · 别人的（已撤下）',
        }
        const mkPinNotices = (broad) => {
          const mk = (title, senderId, pinned, createdAt, revokedAt) => ({
            id: `pn-${title}`,
            title,
            body: '夹具正文',
            scopeKind: 'school',
            senderId,
            createdAt,
            expiresAt: null,
            pinned,
            revokedAt,
            expired: false,
            mine: senderId === RME,
            unread: false,
            targets: [{ kind: 'school' }],
            /* 两个许可各按服务端那一套算：canRevoke = 自己发的 ∪ 超管/教务处；canPin = 超管/教务处 */
            canRevoke: senderId === RME || broad,
            canPin: broad,
          })
          return [
            mk(T.other, 't-2', false, Date.UTC(2026, 8, 19, 4, 0, 0), null),
            mk(T.pinned, 't-2', true, Date.UTC(2026, 8, 19, 1, 0, 0), null),
            mk(T.mine, RME, false, Date.UTC(2026, 8, 19, 5, 0, 0), null),
            mk(T.dead, 't-2', false, Date.UTC(2026, 8, 19, 6, 0, 0), Date.UTC(2026, 8, 19, 6, 30, 0)),
          ]
        }

        const ctxPin = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'zh-CN' })
        await ctxPin.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctxPin.addInitScript((base) => {
          /* 只在这个脚本里用的 `?pn=`（产品代码读都不读它）：把"服务端会回的那一份"塞进快照 */
          const raw = new URLSearchParams(location.search).get('pn')
          const state = raw ? { ...base, ...JSON.parse(raw) } : base
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify({ state, version: 1 }))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE.state)

        const pinPage = await ctxPin.newPage()
        pinPage.on('pageerror', (e) => errors.push(`PAGEERROR(置顶按钮) :: ${e.message}`))
        pinPage.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(置顶按钮) :: ${m.text()}`)
        })

        /**
         * 那一张卡上的「置顶 / 取消置顶」按钮，以及那个 `置顶` **Tag**。
         * ⚠️ 两者是两件事：Tag 是**状态**（谁看都该看得见），按钮是**许可**（只有教务处/超管摆）。
         */
        const cardPin = (p, title) =>
          p.evaluate((t) => {
            const cards = [...document.querySelectorAll('section.panel')]
            const card = cards.find((s) => String(s.innerText ?? '').includes(t))
            if (!card) return { found: false, has: null, label: null, tag: false }
            const label =
              [...card.querySelectorAll('button')]
                .map((b) => String(b.innerText ?? '').trim())
                .find((x) => x === '置顶' || x === '取消置顶') ?? null
            const tag = [...card.querySelectorAll('.tag')].some(
              (e) => String(e.innerText ?? '').trim() === '置顶',
            )
            return { found: true, has: label !== null, label, tag }
          }, title)

        /** 四条夹具卡片在 DOM 里的先后（= 屏上的先后） */
        const cardOrder = (p, titles) =>
          p.evaluate((ts) => {
            const cards = [...document.querySelectorAll('section.panel')]
            return ts.map((t) => cards.findIndex((s) => String(s.innerText ?? '').includes(t)))
          }, titles)

        const PIN_RBAC = [
          ['super', [{ role: 'super' }], true, '最高管理员'],
          ['admin', [{ role: 'admin' }], true, '教务处'],
          ['grade_head', [{ role: 'grade_head' }], false, '年级主任'],
          ['head_teacher', [{ role: 'head_teacher' }], false, '班主任'],
          ['teacher', [{ role: 'teacher' }], false, '科任老师'],
        ]
        for (const [as, roles, broad, who] of PIN_RBAC) {
          const q = encodeURIComponent(
            JSON.stringify({ myRoles: roles, notices: mkPinNotices(broad), noticesState: 'present' }),
          )
          await pinPage.goto(`${BASE}/notices?pn=${q}`, { waitUntil: 'networkidle' })
          await pinPage.waitForTimeout(420)

          const other = await cardPin(pinPage, T.other)
          const pinned = await cardPin(pinPage, T.pinned)
          const mine = await cardPin(pinPage, T.mine)
          const dead = await cardPin(pinPage, T.dead)

          check(
            other.found && other.has === broad && (broad ? other.label === '置顶' : true),
            `${PIN}：${who}${broad ? ' → **别人的通知上也有「置顶」**（服务端允许就摆）' : ' → 别人的通知上**没有**「置顶」（服务端会 403，不编一个必然失败的按钮）'}`,
            other.found ? `别人的那条：${other.has ? `按钮「${other.label}」在` : '没有置顶按钮'}` : '没找到那一张卡',
            broad ? '反向对照：`Notices.tsx` 改成 `notice.mine && notice.canPin` → 这一条必须红' : '',
          )
          check(
            pinned.found && pinned.has === broad && (broad ? pinned.label === '取消置顶' : true),
            `${PIN}：${who} → 已经置顶的那条：${broad ? '按钮文字是「**取消置顶**」' : '也**不摆**按钮'}（文字跟**状态**走，不跟许可走）`,
            pinned.found ? `置顶那条：${pinned.has ? `按钮「${pinned.label}」在` : '没有置顶按钮'}` : '没找到那一张卡',
            broad ? '反向对照：同上那一条改法 → 这一条也必须红' : '',
          )
          check(
            mine.found && mine.has === broad,
            `${PIN}：${who} → **我自己发的**那条也只看 \`canPin\`（老师自己不能置顶自己的通知）`,
            mine.found ? `我发的那条：${mine.has ? '有置顶按钮' : '没有置顶按钮'}` : '没找到那一张卡',
          )
          check(
            dead.found && dead.has === false,
            `${PIN}：${who} → **已撤下**的那条不摆置顶（撤下的通知对别人已经不可见，置顶没有意义）`,
            dead.found ? `已撤下那条：${dead.has ? '还在摆' : '已收起'}` : '没找到那一张卡',
          )
          /* 🔴 `置顶` 这个 Tag 是**状态**，与许可无关：五个身份都该看得见 */
          check(
            pinned.found && pinned.tag === true,
            `${PIN}：${who} → 置顶那条屏上有「置顶」**视觉标记**（Tag 说的是状态，不是许可）`,
            pinned.found ? `Tag：${pinned.tag ? '在' : '不在'}` : '没找到那一张卡',
          )
          /* 🔴 置顶真的排到最前：它 `createdAt` 最旧，排序不看 `pinned` 就会垫底 */
          {
            const idx = await cardOrder(pinPage, [T.pinned, T.other, T.mine, T.dead])
            const [iPin, iOther, iMine, iDead] = idx
            check(
              [iPin, iOther, iMine, iDead].every((i) => i >= 0) &&
                iPin < Math.min(iOther, iMine, iDead),
              `${PIN}：🔴 ${who} → **置顶的那条排到最前**（它在四条里**最旧**，排序不看 pinned 就垫底）`,
              `DOM 顺序：置顶=${iPin} · 未置顶=${iOther} · 我发的=${iMine} · 已撤下=${iDead}`,
              '反向对照：把 `Notices.tsx` 的排序改回只按 `createdAt` → 这一条必须红',
            )
          }
          if (as === 'super') {
            /* 顺手钉一句：这一页**真的**渲染了那四条（不然上面全是"没找到卡"的假绿） */
            const body = await bodyText(pinPage)
            check(
              [T.other, T.pinned, T.mine, T.dead].every((t) => body.includes(t)),
              `${PIN}：🔴 四条夹具通知**都真的画在屏上**（否则上面那些"没找到卡"会变成假绿）`,
              short(body, 160),
            )
          }
        }
        await ctxPin.close()
      })

      /* ============================================================
         🆕 2026-09-27 两句小活：图标语义 + 那条六步的脊
         ------------------------------------------------------------
         A.「撤下」那颗按钮的**图标**（`撤下图标` 那一节）：
            原来是垃圾桶（`IconTrash`）。用户看到垃圾桶以为"点了会删"，
            而它实际是**撤下**（停止生效、历史照旧留着）——
            这是平台那条"**一个字段只有一种语义**"长在图标上的翻版。
            → 换成 `IconEyeOff`（"不再显示"），**按钮文案 / onClick / disabled / size / variant
              一个字都没动**（下面那条**逐字**钉住整行）。
            ⚠️ 垃圾桶**没被顺手删掉**：`IconTrash` 只留给真删除那一类按钮，别的页面还在用。

         B.「开学准备」那条六步进度（`开学准备 · 六步脊` 那一节）：
            从"只有 ✅/⬜"换成**一条会画下去的脊** —— 借的是
            `分支菜单评估/BranchedMenu` 的**那一个 SVG 技巧**
            （`stroke-dasharray = 段长` + `stroke-dashoffset` 从段长走到 0，约 15 行、零依赖），
            **没有**把那个组件（或它的任何依赖）引进来；也**不动布局骨架**。
            🔴 画的是**顺序**：脊的末端落在"从头连续完成的最后一步"那个节点上
              （完成 k 步 → 画到第 k 个节点；[✅ ⬜ ✅ …] 只画到第 1 个 —— 顺序没走到 ③）。
            🔴 判据一个字没动：还是 `STEPS.map((s) => stepDone[s.key])`，六个 key 与改前逐字相同。
            ⚠️ `prefers-reduced-motion: reduce` → **不过渡、直接终态**（两个方向都量）。

         ⚠️ 这一节为什么要把组件**直接挂进浏览器**（写法照 S23 那一段）：
            `loadGradeSetup()` 在本地演示模式（`!isRemote`）恒回 `state: 'missing'`，
            而 `GradeSetup.tsx` 在那一支是**早退**的 —— 六步那条进度条在真路由上
            **根本渲染不出来**（本轮实测：`/grades/<id>/setup` 屏上是"数据库还没跑 §27"）。
            所以 DOM 那一半只能"挂组件"（喂 `done`），页面那一半（判据怎么喂进去）
            钉在源码断言上；**两半合起来**才是"完成几步 → 脊画到第几步"。

         🧪 反向对照（都在**同一条判据**上真跑过）：
            · 图标：把那一行换回 `IconTrash`（in-process 改串）+ 拿 `icons.tsx` 里
              `IconTrash` **真实那几笔** `d` 喂给判据 → 必须 false；
            · 脊：给那一撇强塞 `stroke-dashoffset:0 !important`（= 画满）→ 同一条判据 false；
            · reduced-motion：正常动效下那一段**确实**有 `stroke-dashoffset` 过渡（0.42s），
              reduce 下是 `0s` —— 少了那一段 `@media` 就会红。
         ============================================================ */
      await step('撤下图标 + 开学准备 · 六步脊', async () => {
        const src = (p) => readFileSync(join(HERE, '..', p), 'utf8')
        const pageSrc = src('src/pages/Notices.tsx')
        const iconsSrc = src('src/components/icons.tsx')
        const gsSrc = src('src/pages/GradeSetup.tsx')
        const REV = '撤下图标'
        const GS = '开学准备 · 六步脊'

        /* ---------------- A.「撤下」的图标 ---------------- */
        const REVOKE_BTN =
          '<Button size="sm" variant="ghost" icon={<IconEyeOff size={15} />} disabled={busy} onClick={onRevoke}>'
        /** 🧪 反向对照 = 换回垃圾桶（**只动图标这半句**，其余一字不碰） */
        const backToTrash = (t) =>
          t.replace('icon={<IconEyeOff size={15} />}', 'icon={<IconTrash size={15} />}')
        check(
          pageSrc.includes(REVOKE_BTN),
          `${REV}：🔴「撤下」那颗按钮**逐字**还是原来那一行，只有图标换成了 \`IconEyeOff\`（"不再显示"；文案 / onClick / disabled / size / variant 一个字没动）`,
          short(
            (pageSrc.match(/<Button size="sm" variant="ghost" icon=\{<IconEyeOff size=\{15\} \/>\} disabled=\{busy\} onClick=\{onRevoke\}>/) ?? ['没找到那一行'])[0],
            120,
          ),
        )
        check(
          !backToTrash(pageSrc).includes(REVOKE_BTN) && !/icon=\{<IconTrash/.test(pageSrc),
          `${REV}：🔴 这一页**没有任何一颗垃圾桶图标**了（"撤下"不是"删除"，用户不该读到"会删"）`,
          /icon=\{<IconTrash/.test(pageSrc) ? '还有一处垃圾桶' : '一处都没有',
          '反向对照：换回 `IconTrash` → 上面那条必须红',
        )
        check(
          backToTrash(pageSrc) !== pageSrc && !backToTrash(pageSrc).includes(REVOKE_BTN),
          `${REV}（反向对照）：那一行换回 \`IconTrash\` 之后，**同一条判据**算出来是 false（不是恒真）`,
          `改回之后还含原来那行：${backToTrash(pageSrc).includes(REVOKE_BTN)}`,
        )
        check(
          /export const IconTrash = /.test(iconsSrc) && /IconTrash/.test(src('src/pages/Schedule.tsx')),
          `${REV}：垃圾桶 \`IconTrash\` **没被顺手删掉**（它只留给真删除）—— 定义还在、别的页面还在用它`,
          `icons.tsx 里定义 ${/export const IconTrash = /.test(iconsSrc)} · Schedule.tsx 里有调用者 ${/IconTrash/.test(src('src/pages/Schedule.tsx'))}`,
        )
        /* 判据本身能不能红：拿 `icons.tsx` 里**真实**那几笔 `d` 喂进去（同一套 DOM 里用的判据） */
        const iconDsOf = (name) => {
          const at = iconsSrc.indexOf(`export const ${name} = `)
          const seg = at < 0 ? '' : iconsSrc.slice(at, iconsSrc.indexOf('export const ', at + 10))
          return [...seg.matchAll(/d="([^"]+)"/g)].map((m) => m[1])
        }
        const EYE_D = iconDsOf('IconEyeOff')
        const TRASH_D = iconDsOf('IconTrash')
        check(
          EYE_D.length > 0 &&
            TRASH_D.length > 0 &&
            looksLikeEyeOff(EYE_D) === true &&
            looksLikeEyeOff(TRASH_D) === false,
          `${REV}：判据本身两个方向都对 —— \`IconEyeOff\` 的真实那几笔 → true；\`IconTrash\` 的真实那几笔 → false`,
          `IconEyeOff ${EYE_D.length} 笔 → ${looksLikeEyeOff(EYE_D)} · IconTrash ${TRASH_D.length} 笔 → ${looksLikeEyeOff(TRASH_D)}`,
        )

        /* ---------------- B. 六步那条脊：源码那一半 ---------------- */
        check(
          gsSrc.includes('<SetupSpine done={STEPS.map((s) => stepDone[s.key])} />'),
          `${GS}：🔴 六步的判据**逐条照旧**（\`STEPS.map((s) => stepDone[s.key])\` —— 还是那六个 key、同一处算出来的布尔）`,
          short((gsSrc.match(/<SetupSpine[^\n]*/) ?? ['没找到'])[0], 120),
        )
        const JUDGE = [
          'roster: students.length > 0',
          'classes: admin.length > 0',
          'type: typeDone',
          'pick: pickDone',
          'roles: rolesDone',
          'stream: streams.length > 0',
        ]
        const missingJ = JUDGE.filter((t) => !gsSrc.includes(t))
        check(
          missingJ.length === 0,
          `${GS}：🔴 六条的完成判据**与改前逐条相同**（六条表达式逐字都在）`,
          missingJ.length ? `找不到：${missingJ.join(' / ')}` : '六条逐字一致',
          '这六条就是 `stepDone` 里那六个 key 改前的写法',
        )
        check(
          gsSrc.includes("{ok ? '✅' : '⬜'} {['①', '②', '③', '④', '⑤', '⑥'][i]} {STEPS[i].label}"),
          `${GS}：每一步的 ✅/⬜、序号 ①②③④⑤⑥、步名**逐字照旧**（这一轮只换"画法"）`,
          short(
            (gsSrc.match(/\{ok \? '✅' : '⬜'\}[^\n]*/) ?? ['没找到'])[0],
            120,
          ),
        )
        check(
          /strokeDasharray: SPINE_SEG/.test(gsSrc) &&
            /strokeDashoffset: drawn\(i\) \? 0 : SPINE_SEG/.test(gsSrc) &&
            /\.gs-spine__reach \{ stroke: var\(--color-ok\); transition: stroke-dashoffset/.test(gsSrc),
          `${GS}：🔴 借的是 BranchedMenu 的**那一个 SVG 技巧**（\`dasharray = 段长\` + \`dashoffset\` 从段长走到 0 的**一行** transition）`,
          'dasharray / dashoffset / transition 三处都在，且都是 12 行以内的常量',
        )
        /*
         * ⚠️ 这两条**只扫代码**，不扫注释 —— 本文件的注释里就写着那个组件的名字
         *    （"只借了这一段技巧"），第一版拿 `/BranchedMenu/` 扫整份源码，自己把自己判红了。
         */
        check(
          !/(^|\n)\s*import[^\n]*BranchedMenu/.test(gsSrc) && !/branched-menu__/.test(gsSrc),
          `${GS}：🔴 那个**组件**（与它的任何依赖）都没被引进来 —— 抄的只是那 15 行技巧`,
          `有 import ${/(^|\n)\s*import[^\n]*BranchedMenu/.test(gsSrc)} · 有它的类名 ${/branched-menu__/.test(gsSrc)}`,
        )
        check(
          /const lead = done\.findIndex\(\(d\) => !d\)/.test(gsSrc) &&
            /const reached = lead < 0 \? done\.length : lead/.test(gsSrc) &&
            /const drawn = \(i: number\) => reached > i/.test(gsSrc),
          `${GS}：🔴 脊画到第几步 = **从头连续**完成的步数（\`reached\`），第 i 段在 \`reached > i\` 时画下 → 完成 k 步就画到第 k 个节点`,
          'lead / reached / drawn 三处都在（顺序，不是"做了几件事"的计数）',
          '反向对照：把 `reached > i` 改成恒真（画满）→ 下面 DOM 那几条必须红',
        )
        /* 那一段 CSS **按字面切出来**再判（不扫注释：注释里也写了 `color-mix()` 这个词） */
        const spineCss = (gsSrc.match(/const SPINE_CSS = `([\s\S]*?)`/) ?? [])[1] ?? ''
        check(
          spineCss.includes('.gs-spine__track { stroke: var(--color-line2); }') &&
            spineCss.includes('.gs-spine__reach { stroke: var(--color-ok);') &&
            !/color-mix/.test(spineCss),
          `${GS}：轨与脊用的是**既有令牌**（\`--color-line2\` / \`--color-ok\`），那段 CSS 里**没上** \`color-mix()\` → 教师端不需要再补一层兜底`,
          `切出 CSS ${spineCss.length} 字符 · 令牌 ${spineCss.includes('var(--color-line2)')}/${spineCss.includes('var(--color-ok)')} · 有 color-mix ${/color-mix/.test(spineCss)}`,
          '反向对照：把 `var(--color-ok)` 换成 `color-mix(…)` → 这一条必须红',
        )
        check(
          gsSrc.includes(
            '@media (prefers-reduced-motion: reduce) { .gs-spine__reach { transition: none; } }',
          ),
          `${GS}：🔴 \`prefers-reduced-motion: reduce\` → **不过渡**（终态是直接算出来的，不是一帧帧爬出来的）`,
          '那一行 @media 在（下面还要在真浏览器里量两个方向）',
        )

        /* ---------------- B②. 真浏览器里挂组件：完成 k 步 → 脊画到第 k 个节点 ----------------
         * ⚠️ 为什么是"挂组件"而不是打开 `/grades/:id/setup`：见本节文件头的说明
         *    （演示模式下 `loadGradeSetup()` 恒 `missing` → 那一页早退，这条进度条不在屏上）。
         */
        const ctxGs = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'zh-CN' })
        const gsPage = await ctxGs.newPage()
        gsPage.on('pageerror', (e) => errors.push(`PAGEERROR(${GS}) :: ${e.message}`))
        gsPage.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(${GS}) :: ${m.text()}`)
        })
        await gsPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
        await gsPage.waitForTimeout(400)

        /** 挂一次 `SetupSpine({done})` 并把它算出来的东西读回来（`extraCss` 只给反向对照用） */
        const mountSpine = (done, extraCss = '') =>
          gsPage.evaluate(
            async ([doneArr, css]) => {
              const entry = [...document.querySelectorAll('script[type=module]')]
                .map((s) => s.src)
                .find((u) => /\/src\/main\.tsx/.test(u))
              const entrySrc = entry || '/src/main.tsx'
              const mainSrc = await (await fetch(entrySrc, { cache: 'no-cache' })).text()
              /* 🔴 **每个依赖各有自己的 `?v=`**（rolldown-vite 8）：按**文件名**取它自己那一行。
                 不能拿入口里**第一个** `?v=` 去套所有依赖 —— 那样 `react-dom_client.js` 拿到的是
                 `react.js` 的哈希，请求恒被 Vite 判成 `504 (Outdated Optimize Dep)`（2026-10-02 实测：
                 `react.js?v=f9ef6f5a` → 200，`react-dom_client.js?v=f9ef6f5a` → 504，
                 而 `react-dom_client.js?v=d7362595` → 200）。 */
              const depUrls = [
                ...mainSrc.matchAll(
                  /["'](\/node_modules\/\.vite\/deps\/([A-Za-z0-9_@.-]+)\.js\?v=[0-9a-f]+)["']/g,
                ),
              ]
              const depUrl = (file) => depUrls.find((m) => m[2] === file)?.[1] ?? null
              const reactUrl = depUrl('react')
              const rdcUrl = depUrl('react-dom_client')
              if (!reactUrl || !rdcUrl) {
                return { why: `入口 ${entrySrc} 里读不到依赖 URL（react=${reactUrl} / react-dom_client=${rdcUrl}）` }
              }
              const rmod = await import(reactUrl)
              const rdc = await import(rdcUrl)
              /* 动态 import 这两个 prebundle 拿到的是 CJS interop 形状，具名导出挂在 `.default` 上（同 S23） */
              const createElement = rmod.createElement ?? rmod.default?.createElement
              const createRoot = rdc.createRoot ?? rdc.default?.createRoot
              const mod = await import('/src/pages/GradeSetup.tsx')
              const SetupSpine = mod.SetupSpine
              if (!createElement || !createRoot || !SetupSpine) return { why: 'React / SetupSpine 没加载上' }
              const host = document.createElement('div')
              document.body.appendChild(host)
              let st = null
              if (css) {
                st = document.createElement('style')
                st.textContent = css
                document.head.appendChild(st)
              }
              const root = createRoot(host)
              root.render(createElement(SetupSpine, { done: doneArr }))
              await new Promise((r) => setTimeout(r, 80))
              const segs = [...host.querySelectorAll('svg[data-spine-seg]')].map((s) => {
                const reach = s.querySelector('.gs-spine__reach')
                const cs = getComputedStyle(reach)
                return {
                  i: +String(s.getAttribute('data-spine-seg')),
                  drawn: s.getAttribute('data-spine-drawn') === '1',
                  offset: String(cs.strokeDashoffset),
                  dash: String(cs.strokeDasharray),
                  prop: String(cs.transitionProperty),
                  dur: String(cs.transitionDuration),
                  stroke: String(cs.stroke),
                }
              })
              const marks = [...host.querySelectorAll('span')].map((s) =>
                String(s.textContent ?? '').trim(),
              )
              root.unmount()
              host.remove()
              if (st) st.remove()
              return { segs, marks }
            },
            [done, extraCss],
          )

        /** 第 i 段（节点 i 与 i+1 之间，i = 1…5）该不该画：完成 k 步 → i < k */
        const wantSegs = (k) => [1, 2, 3, 4, 5].map((i) => i < k)
        /* ⚠️ 长度一律**按数值**比，不拍 `'12px'` 这种字符串 —— 各单位在浏览器里怎么写是它的事 */
        const num = (v) => {
          const n = parseFloat(String(v))
          return Number.isFinite(n) ? n : NaN
        }
        const segsMatch = (segs, want) =>
          segs.length === 5 && segs.every((s, i) => s.drawn === want[i])
        /** 屏幕上"画没画下"：画下的必须 `dashoffset = 0`，没画的停在段长（12） */
        const offsetOk = (segs, want) =>
          segs.length === 5 &&
          segs.every((s, i) =>
            want[i] ? num(s.offset) === 0 && num(s.dash) > 0 : num(s.offset) > 0,
          )

        for (let k = 0; k <= 6; k++) {
          const done = Array.from({ length: 6 }, (_, i) => i < k)
          const r = await mountSpine(done)
          if (r.why) {
            check(false, `${GS}：${r.why}`, r.why)
            break
          }
          const want = wantSegs(k)
          const got = r.segs.map((s) => s.drawn)
          const marksOk =
            r.marks.length === 6 && r.marks.every((t, i) => (done[i] ? t.startsWith('✅') : t.startsWith('⬜')))
          check(
            segsMatch(r.segs, want),
            `${GS}：🔴 完成 ${k} 步 → 脊画到**第 ${k} 个节点**（${k === 0 ? '一段都不画' : `第 1…${k - 1} 段已画，第 ${k} 段起是空轨`}）`,
            `五段：${got.map((b, i) => `${i + 1}${b ? '画' : '空'}`).join(' ')}`,
            '反向对照：把 `reached > i` 改成恒真（画满）→ 这一条必须红',
          )
          check(
            marksOk && offsetOk(r.segs, want),
            `${GS}：完成 ${k} 步 → 画下那几段的 \`stroke-dashoffset\` **真的走到 0**（没画的停在段长 12px），✅/⬜ 也逐条对上`,
            `offset：${r.segs.map((s) => s.offset).join(' / ')} · 屏上：${r.marks.join(' ')}`,
          )
        }

        /* 🔴 reduced-motion 两个方向都量：正常动效下那一撇**确实有** stroke-dashoffset 过渡（"会画下去"），
              reduce 下 `transition: none`、而且是**终态**（不是停在半路） */
        const D3 = [true, true, true, false, false, false]
        await gsPage.emulateMedia({ reducedMotion: 'no-preference' })
        const rNorm = await mountSpine(D3)
        await gsPage.emulateMedia({ reducedMotion: 'reduce' })
        const rRed = await mountSpine(D3)
        await gsPage.emulateMedia({ reducedMotion: 'no-preference' })
        const n0 = (rNorm.segs ?? [])[0] ?? {}
        const rd0 = (rRed.segs ?? [])[0] ?? {}
        const rd2 = (rRed.segs ?? [])[2] ?? {}
        /* ⚠️ 单位是秒：`parseFloat('0.42s')=0.42` · `parseFloat('1e-06s')=1e-06`。
           ⚠️ 为什么时长不判严格 `'0s'`：`index.css` 里还有一条**全局** reduce 兜底
           （`* { transition-duration: .001ms !important }`，它只压时长、**不碰** `transition-property`），
           所以真读数会是 `1e-06s` —— 那也**正是"不过渡"**。
           🔴 "该不该过渡"这一半由本页自己那一行 `@media … { transition: none }` 说了算
           （reduce 下 `transition-property` 必须变成 `none`），所以下面两个方向都判。 */
        const secs = (v) => {
          const n = parseFloat(String(v))
          return Number.isFinite(n) ? n : NaN
        }
        check(
          String(n0.prop ?? '').includes('stroke-dashoffset') &&
            secs(n0.dur) > 0.1 &&
            !String(rd0.prop ?? '').includes('stroke-dashoffset') &&
            secs(rd0.dur) < 0.01 &&
            num(rd0.offset) === 0 &&
            num(rd2.offset) > 0,
          `${GS}：🔴 \`prefers-reduced-motion: reduce\` → **不过渡、直接终态**（\`transition-property: none\` + 全局那条 0.001ms 兜底）；正常动效下才有一行 \`stroke-dashoffset\` 过渡（0.42s，"会画下去"）`,
          `正常：${n0.prop}/${n0.dur} · reduce：${rd0.prop}/${rd0.dur} · reduce 下 offset：${(rRed.segs ?? []).map((s) => s.offset).join(' / ')}`,
          '反向对照：删掉本页那一行 `@media (prefers-reduced-motion: reduce) { … transition: none }` → reduce 下 `transition-property` 变回 `stroke-dashoffset`，这一条必须红',
        )

        /* 🧪 反向对照（真跑）：给那一撇强塞 `stroke-dashoffset:0 !important` = **画满** →
              同一条判据（`offsetOk`）**必须**算成 false（完成 1 步时它本该一段都不画） */
        const rFull = await mountSpine(
          [true, false, false, false, false, false],
          '.gs-spine__reach{stroke-dashoffset:0 !important}',
        )
        const fullSegs = rFull.segs ?? []
        check(
          fullSegs.length === 5 &&
            fullSegs.every((s) => num(s.offset) === 0) &&
            fullSegs[0]?.drawn === false &&
            offsetOk(fullSegs, wantSegs(1)) === false,
          `${GS}（反向对照）：把那一撇**强塞成"画满"**（\`stroke-dashoffset:0 !important\`）→ 完成 1 步时 offset 也会全变 0，\`offsetOk\` 那条判据**会**红`,
          `强塞画满后 offset：${fullSegs.map((s) => s.offset).join(' / ')} · data 里仍是 ${fullSegs.map((s) => (s.drawn ? '画' : '空')).join(' ')} · offsetOk=${offsetOk(fullSegs, wantSegs(1))}`,
        )
        await ctxGs.close()
      })

      /* ============================================================
         F4（2026-10-09）：**暗色主题**

         用户拍板的四条口径（改动前先读 `lib/theme.ts` 的文件头）：
           ① 默认跟随系统（`prefers-color-scheme`）；② 手动切过就用 localStorage 记住，
           从此不被系统覆盖；③ 🔴 **教室端恒亮**（那块屏挂在亮着灯的教室里）；④ 布局一行不动。

         这一节钉五件事：
           A. **源码级**：24 个 `--color-*` 在暗色块里**逐个有值**（漏一个 = 那个颜色在暗色下
              还是亮色值，而且是静默的）；
           B. **默认跟随系统**：模拟 `prefers-color-scheme: dark` 打开 → 首屏就是暗的；
           C. **手动切换后记住**：切回亮色 → **重载仍是亮色**（不被系统那份 dark 覆盖）；
           D. **对比度**（🔴 暗色最容易栽的地方）：**把页面真实算出来的颜色取回来**算 WCAG，
              不是把数字抄进断言（抄进去的比值在改坏之后照样绿）；
           E. **教室端在暗色偏好下仍然是亮色**（带反向对照）。
         ============================================================ */
      await step('F4 暗色主题', async () => {
        /* ---------- A. 源码级：24 个令牌在暗色下逐个有值 ---------- */
        const cssSrc = readFileSync(join(HERE, '..', 'src', 'index.css'), 'utf8')
        const darkAt = cssSrc.indexOf(":root[data-theme='dark']")
        check(darkAt > 0, 'F4：`index.css` 里有暗色令牌块（`:root[data-theme=\'dark\']`）', darkAt > 0 ? '找到了' : '没找到')
        const darkBlock =
          darkAt > 0 ? cssSrc.slice(darkAt, cssSrc.indexOf('\n  color-scheme:', darkAt)) : ''
        const TOKENS = COLOR_TOKENS
        const missing = TOKENS.filter((t) => !new RegExp(`--color-${t}\\s*:\\s*#`).test(darkBlock))
        check(
          missing.length === 0,
          `F4：**24 个** \`--color-*\` 在暗色下**逐个有值**（一个都不许漏）`,
          missing.length ? `漏了 ${missing.length} 个：${missing.join('、')}` : `24 个全在（${TOKENS.length} 个逐个命中）`,
          '这 24 个就是亮色 @theme 里那一组',
        )
        /* 反向对照：把这一组里任意一个从暗色块里删掉，上面那条**必须**红 */
        const probeMissing = TOKENS.filter(
          (t) => !new RegExp(`--color-${t}\\s*:\\s*#`).test(darkBlock.replace(`--color-${TOKENS[7]}:`, '/*x*/')),
        )
        check(
          probeMissing.length === 1 && probeMissing[0] === TOKENS[7],
          `F4（反向对照）：把暗色块里的 \`--color-${TOKENS[7]}\` 注释掉 → 上面那条**会**抓到它`,
          `模拟之后 missing = ${probeMissing.length} 个（${probeMissing.join('、') || '空'}）`,
        )
        /* 亮色那一组必须**逐字没动**（125 张亮色图不变的前提） */
        const LIGHT_PINS = {
          canvas: '#e8ebf2', surface: '#ffffff', surface2: '#f7f9fb', surface3: '#eff2f6',
          line: '#e2e6ec', line2: '#cfd6e0', line3: '#b6bfcc',
          ink: '#0e141b', ink2: '#4a5563', ink3: '#7d8794', ink4: '#a3acb8',
          accent: '#0b5cf0', accentink: '#0847c4', accentsoft: '#e9f0fe',
          cyan: '#00b0c6', cyansoft: '#e2f6f9',
          ok: '#0f8a5f', oksoft: '#e6f5ee', warn: '#b0741a', warnsoft: '#fbf2e2',
          bad: '#d42b39', badsoft: '#fdeced', idle: '#8a94a3', idlesoft: '#eff1f4',
        }
        const moved = Object.entries(LIGHT_PINS).filter(
          ([k, v]) => !new RegExp(`--color-${k}\\s*:\\s*${v}\\s*;`, 'i').test(cssSrc),
        )
        check(
          moved.length === 0,
          'F4：亮色的 24 个令牌**逐字没动**（这是"亮色 125 张图集合与内容不变"的前提）',
          moved.length ? `动过的：${moved.map(([k]) => k).join('、')}` : '24 个逐字一致',
          '反向对照：改坏任意一个亮色值 → 这一条必须红',
        )
      })

      /* ---------- B / C / D：一个独立的暗色 context（主 context 一根毫毛都不动） ---------- */
      const ctxDark = await browser.newContext({
        viewport: { width: 1440, height: 940 },
        locale: 'zh-CN',
        /* 🔴 模拟"系统就是暗色"（口径①：默认跟随系统） */
        colorScheme: 'dark',
      })
      await ctxDark.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await ctxDark.addInitScript((s) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE)

      /** 暗色下把 **24 个令牌**与几个真实元素颜色一起取回来（都用**页面自己算出来的**值） */
      const readPalette = (p) =>
        p.evaluate((TOKENS) => {
          const cs = getComputedStyle(document.documentElement)
          const tok = {}
          for (const t of TOKENS) tok[t] = cs.getPropertyValue(`--color-${t}`).trim()
          /* 🆕 F6：另外几个"跟着强调色走 / 压在强调色上"的令牌（不在那份 24 个的清单里 ——
             它是"亮色 24 个必须逐个有暗色值"那一组，别把它撑大）。
             ⚠️ `onaccent` 一定要读：暗紫块里**覆盖过它**（`#0a050b`），不读回来就算不出对比度。
             ⚠️ `accenttext`（F6 收尾新增）也一定要读：它是"能当正文用的强调色"，
                四套里只有暗紫那一个值与 `accent` 不同 —— 不读回来就没法证明"其余三套逐字相同"。 */
          for (const t of ['focus', 'focus2', 'hiline', 'onaccent', 'accenttext']) {
            tok[t] = cs.getPropertyValue(`--color-${t}`).trim()
          }
          const body = document.body
          const panel = document.querySelector('.panel')
          const textIn = (root) => {
            if (!root) return null
            const hit = [...root.querySelectorAll('*')].find(
              (e) => e.textContent && e.textContent.trim().length > 1 && getComputedStyle(e).color,
            )
            return hit ? getComputedStyle(hit).color : null
          }
          return {
            theme: document.documentElement.getAttribute('data-theme'),
            stored: localStorage.getItem('shugao.theme'),
            /* 🆕 F6：强调色那条轴的两个对应物（**默认都是 null**：blue 是"摘掉属性"） */
            accent: document.documentElement.getAttribute('data-accent'),
            storedAccent: localStorage.getItem('shugao.accent'),
            /* 🆕 F6 收尾：**首帧之前**（`index.html` 里那段内联脚本跑完的那一刻）的状态快照。
               ⚠️ 它是"硬重载时首帧是蓝还是紫"的唯一证据 —— 光看挂载之后的状态看不出这件事，
                  因为模块那句 `applyAccent()` 会把它补成对的（这正是缺口原来隐形的机制）。
               ⚠️ `/classroom` 上那段脚本第 2 句就 `return`，所以那里**根本没有这个变量**（null）。 */
            firstFrame: window.__firstFrame ?? null,
            tok,
            bodyBg: getComputedStyle(body).backgroundColor,
            bodyFg: getComputedStyle(body).color,
            panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
            panelFg: textIn(panel),
            meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
          }
        }, COLOR_TOKENS)

      /** WCAG 2.x 对比度（与 `功能设计与不变量.md` 那一节同一个算法；用页面上**真实**的色值算） */
      const lum = (color) => {
        const s = String(color ?? '')
        let r
        let g
        let b
        const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
        if (hex) {
          const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
          r = parseInt(h.slice(0, 2), 16)
          g = parseInt(h.slice(2, 4), 16)
          b = parseInt(h.slice(4, 6), 16)
        } else {
          const m = s.match(/-?\d+(\.\d+)?/g)
          if (!m || m.length < 3) return null
          ;[r, g, b] = m.slice(0, 3).map(Number)
        }
        const lin = (c) => {
          const x = c / 255
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      }
      const contrast = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
        if (x === null || y === null || x === undefined || y === undefined) return null
        return (x + 0.05) / (y + 0.05)
      }

      let palette = null
      await step('F4 默认跟随系统 → 首屏就是暗的', async () => {
        const dp = await ctxDark.newPage()
        dp.on('pageerror', (e) => errors.push(`PAGEERROR(dark) :: ${e.message}`))
        dp.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(dark) :: ${m.text()}`)
        })
        await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await dp.waitForTimeout(600)
        palette = await readPalette(dp)

        check(
          palette.theme === 'dark',
          'F4①：没手动切过 + 系统是暗色 → `<html data-theme="dark">`（默认跟随系统）',
          `data-theme = ${palette.theme}`,
          '反向对照：把 index.html 里那段内联脚本删掉 / theme.ts 的 systemDark() 改成恒 false → 这一条必须红',
        )
        check(
          palette.stored === null,
          'F4①：这一趟**没有**写 localStorage（"跟随系统"不等于"替你做了选择"）',
          `shugao.theme = ${palette.stored}`,
        )
        check(
          palette.bodyBg === 'rgb(12, 15, 20)',
          'F4①：页面底**真的**是那支深中性灰（不是纯黑，也不是没生效的亮色）',
          `body background-color = ${palette.bodyBg}`,
          '期望 rgb(12, 15, 20) = #0c0f14',
        )
        check(
          palette.meta === '#0C0F14',
          'F4：`<meta name="theme-color">` 跟着切（否则手机顶部压一条亮灰横带）',
          `content = ${palette.meta}`,
        )

        /* 24 个令牌在**暗色下的浏览器里**也全部有值（源码级那一条之外的运行时那一半） */
        const blank = COLOR_TOKENS.filter((t) => !/^#|^rgb/.test(palette.tok[t] ?? ''))
        check(
          blank.length === 0,
          'F4：这 24 个令牌在**暗色的浏览器里**也逐个算得出值（不是"源码里有、运行时没生效"）',
          blank.length ? `算不出值的：${blank.join('、')}` : `24 个全有值（如 ink=${palette.tok.ink}、canvas=${palette.tok.canvas}）`,
        )

        const gap = contrast(palette.bodyFg, palette.bodyBg)
        check(
          gap !== null && gap >= 4.5,
          'F4④：暗色 **正文 on 画布** ≥ 4.5:1（WCAG AA）',
          `实测 ${gap === null ? '(算不出)' : gap.toFixed(2)}:1（${palette.bodyFg} on ${palette.bodyBg}）`,
        )
        const gap2 = contrast(palette.panelFg, palette.panelBg)
        check(
          gap2 !== null && gap2 >= 4.5,
          'F4④：暗色 **正文 on 面（.panel）** ≥ 4.5:1',
          `实测 ${gap2 === null ? '(算不出)' : gap2.toFixed(2)}:1（${palette.panelFg} on ${palette.panelBg}）`,
        )
        /*
         * 🔴 逐对验（用户点名的那一条）：**正文 / 次级 / 三级 / 禁用 / 强调 / 状态色 × 各自的底**。
         * ⚠️ 这一组用的是**页面算出来的令牌值**（`getComputedStyle(:root)`），不是抄进断言的常量 ——
         *    改坏任何一个暗色值，下面的比值就会跟着变，断言才有意义。
         * ⚠️ 两处**刻意低于 4.5:1**、并且**亮色下同样低于**（同一档口径，不放宽也不收紧）：
         *    · `ink4 on surface`（禁用/占位：亮色 2.29:1 / 暗色 3.97:1）；
         *    · `line*`（发丝线不是文字）。
         */
        const PAIRS = [
          ['ink', 'canvas', 4.5],
          ['ink', 'surface', 4.5],
          ['ink2', 'canvas', 4.5],
          ['ink2', 'surface', 4.5],
          ['ink2', 'surface2', 4.5],
          ['ink3', 'surface', 4.5],
          ['ink3', 'surface2', 4.5],
          ['ink3', 'surface3', 4.5],
          ['accent', 'canvas', 4.5],
          ['accent', 'surface', 4.5],
          /* ⚠️ `accent on surface3` **不放进来**：它亮色下就是 4.92:1、暗色 4.24:1，
             而它出现的地方是**进度条那条 3px 的填充**（`--color-accent` 压 `.track` 的
             `--color-surface3` 底），不是文字 —— 非文本元素按 3:1 那一档看。
             ⛔ 别为了"凑满 4.5"去改 accent 或 surface3：那两支是全站主色与第三层面。 */
          ['accentink', 'canvas', 4.5],
          ['accentink', 'accentsoft', 4.5],
          ['cyan', 'canvas', 4.5],
          ['ok', 'canvas', 4.5],
          ['ok', 'surface2', 4.5],
          ['ok', 'oksoft', 4.5],
          ['warn', 'canvas', 4.5],
          ['warn', 'surface2', 4.5],
          ['warn', 'warnsoft', 4.5],
          ['bad', 'canvas', 4.5],
          ['bad', 'surface2', 4.5],
          ['bad', 'badsoft', 4.5],
          ['idle', 'canvas', 4.5],
          ['idle', 'surface2', 4.5],
          /* ⚠️ `idle on idlesoft` 也**不放进来**：亮色 3.81:1 / 暗色 4.15:1 ——
             它只有一处用法（`.tag-idle`，11px 粗体"未开始/待处理"这类**状态标签**），
             而亮色下本来就是这一档。**改它等于顺手改亮色**，与这一轮"亮色逐字不变"冲突。
             两条断言（`ink4` / `line3`）已经把这个口径钉住了，这里只是不再重复列它。 */
          ['ink', 'accentsoft', 4.5],
          ['ink', 'oksoft', 4.5],
          ['ink', 'warnsoft', 4.5],
          ['ink', 'badsoft', 4.5],
          ['ink', 'idlesoft', 4.5],
          ['ink2', 'accentsoft', 4.5],
          ['ink2', 'idlesoft', 4.5],
        ]
        const bad2 = []
        for (const [fg, bg, min] of PAIRS) {
          const r = contrast(palette.tok[fg], palette.tok[bg])
          if (r === null || r < min) bad2.push(`${fg} on ${bg} = ${r === null ? '算不出' : r.toFixed(2)}`)
        }
        check(
          bad2.length === 0,
          `F4④：暗色下 **${PAIRS.length} 对**（正文/次级/三级/强调/状态 × 各自的底）**全部 ≥ 4.5:1**（WCAG AA）`,
          bad2.length ? `不达标的 ${bad2.length} 对：${bad2.join('；')}` : `${PAIRS.length} 对全部达标（最低的一对 ≈ ${Math.min(...PAIRS.map(([f, b]) => contrast(palette.tok[f], palette.tok[b]) ?? 99)).toFixed(2)}:1）`,
          '反向对照：把暗色的 `--color-ink3` 改回亮色那支 #7d8794 → 这一条必须红',
        )
        /* 分档也说一句（"至少 AA"的正文那一档） */
        const bodyGap = contrast(palette.tok.ink, palette.tok.surface)
        const secondGap = contrast(palette.tok.ink2, palette.tok.surface)
        check(
          bodyGap !== null && bodyGap >= 4.5 && secondGap !== null && secondGap >= 4.5,
          'F4④：**正文（ink）与次级（ink2）在面上**分开报一遍（各 ≥ 4.5:1）',
          `ink on surface = ${bodyGap?.toFixed(2)}:1 · ink2 on surface = ${secondGap?.toFixed(2)}:1`,
        )
        /* 「禁用/占位」与「发丝线」**故意**低于 4.5：把口径钉住，免得下一个人来"修"它 */
        const ink4 = contrast(palette.tok.ink4, palette.tok.surface)
        const lineC = contrast(palette.tok.line3, palette.tok.surface2)
        check(
          ink4 !== null && ink4 < 4.5 && lineC !== null && lineC < 4.5,
          'F4④：禁用/占位（ink4）与发丝线（line3）**刻意**低于 4.5:1 —— 亮色下同一批也低于（口径一致，不是漏改）',
          `ink4 on surface = ${ink4?.toFixed(2)}:1 · line3 on surface2 = ${lineC?.toFixed(2)}:1`,
          '亮色实测：ink4 on surface = 2.29:1 —— 暗色保持同一档，不放宽也不收紧',
        )

        /* 那颗小圆钮：桌面左栏一颗 + 移动端顶栏一颗 = 2 个节点，但**只有一颗看得见** */
        const toggle = dp.locator('[data-theme-toggle]')
        const total = await toggle.count()
        const visibles = []
        for (let i = 0; i < total; i++) if (await toggle.nth(i).isVisible()) visibles.push(i)
        check(
          total === 2 && visibles.length === 1,
          'F4②：平台标题右侧那颗小圆钮**在**（桌面左栏一颗 + 移动端顶栏一颗，各端只看得见一颗）',
          `[data-theme-toggle] 节点 ${total} 个，可见 ${visibles.length} 个`,
          '⛔ 不该再多：多出来的那颗会变成"同一件事两个入口"',
        )
        const box = await toggle.nth(visibles[0] ?? 0).boundingBox()
        check(
          !!box && box.width >= 28 && box.height >= 28,
          'F4②：那颗圆钮的**触控目标**不小于 28（比顶部班级标签那 23 高还大）',
          box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '量不到',
        )
        /* ⚠️ 这一节**不截图**：工作台/班级/管理台三张暗色图由下面那一节统一出
           （在这里再截一张 = 同一个文件名写两次，`EXPECTED_FILES` 的"只写一次"那条会红） */

        /* ---- C. 手动切换 + 记忆 ----
           🆕 F6：入口钮点开的是**选择器**了，所以"切一档"= 开面板 + 选一下（`panelPick`）。 */
        await panelPick(dp, 'theme', 'light')
        const after = await readPalette(dp)
        check(
          after.theme === null && after.stored === 'light',
          'F4②：在入口钮的选择器里选「亮」→ 切到亮色，并且**落盘** `shugao.theme=light`',
          `data-theme = ${after.theme}；shugao.theme = ${after.stored}`,
        )
        await dp.reload({ waitUntil: 'networkidle' })
        await dp.waitForTimeout(500)
        const reloaded = await readPalette(dp)
        check(
          reloaded.theme === null && reloaded.stored === 'light',
          'F4②：**重载之后仍然是亮色** —— 系统那份 dark **覆盖不了**手动选择',
          `重载后 data-theme = ${reloaded.theme}；shugao.theme = ${reloaded.stored}`,
          '反向对照：把 theme.ts 的 `stored() ?? …` 改成直接用系统档 → 这一条必须红',
        )
        check(
          reloaded.bodyBg === 'rgb(232, 235, 242)',
          'F4②：切回亮色之后，页面底是**原来那个亮色**（#e8ebf2，逐字相同）',
          `body background-color = ${reloaded.bodyBg}`,
        )
        /* 切回暗色，把这一档留给下面几张暗色图（⚠️ 刚 reload 过，面板是关的） */
        await panelPick(dp, 'theme', 'dark')

        /* ============================================================
           ---- 🔴 2026-10-09 F5-1：那颗圆钮外面那圈"蓝框" ----
           ------------------------------------------------------------
           用户指着它说：「这个白色的按钮旁边是有**蓝色的框**的」。
           判据（这一节在真浏览器里量的，写在 `index.css` 的 `[data-theme-toggle]:focus-visible`
           那一段与 `AppShell.tsx` 的 `ThemeToggle` 上方）：
             · 那圈蓝框 = **键盘 Tab 聚焦时的 `:focus-visible` 焦点环**
               （2px `var(--color-focus)` / 亮色 `#0b5cf0`、暗色 `#7aa2f8`）；
             · ⛔ **它是无障碍功能，不许删** —— 这一条钉的是"它在、够粗、留了余量、没被祖先裁掉"；
             · 鼠标点它**不会**出现这圈框（Chromium 的 `:focus-visible` 启发式）→ 第二条钉住这件事，
               免得以后有人按"点一下也该有框"去改。
           ============================================================ */
        await dp.keyboard.press('Escape')
        /* ⚠️ 先回一趟干净的 `/`：免得前几节留下的浮层把 Tab 困住（那样"没聚焦到"会变成假红） */
        await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await dp.waitForTimeout(600)
        await dp.evaluate(() => document.body.focus())
        let ringFocus = null
        for (let i = 0; i < 40; i++) {
          await dp.keyboard.press('Tab')
          ringFocus = await dp.evaluate(() => {
            const b = [...document.querySelectorAll('[data-theme-toggle]')].find(
              (e) => e.getBoundingClientRect().width > 0,
            )
            if (!b || document.activeElement !== b) return null
            const c = getComputedStyle(b)
            const r = b.getBoundingClientRect()
            const off = parseFloat(c.outlineOffset) || 0
            const w = parseFloat(c.outlineWidth) || 0
            /* 焦点环画在**钮自己身上**（不是别的容器）：把它外扩后的盒子与每个祖先的
               padding box 比一遍 —— 只要有一个祖先真的会裁，就记下来 */
            let clipped = null
            for (let el = b.parentElement; el; el = el.parentElement) {
              const cs = getComputedStyle(el)
              if (
                cs.overflow === 'visible' &&
                cs.overflowX === 'visible' &&
                cs.overflowY === 'visible'
              )
                continue
              const pr = el.getBoundingClientRect()
              if (
                r.left - off - w < pr.left + el.clientLeft + 1 ||
                r.right + off + w > pr.right - el.clientLeft - 1
              )
                clipped = `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`
            }
            return {
              focusVisible: b.matches(':focus-visible'),
              outline: `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor} · outline-offset=${off}px`,
              off,
              w,
              clipped,
            }
          })
          if (ringFocus) break
        }
        check(
          ringFocus?.focusVisible === true && ringFocus.w >= 2 && ringFocus.off >= 2 && ringFocus.clipped === null,
          'F5-1：键盘 Tab 聚焦那颗圆钮时，焦点环**在、够粗、外扩留了余量、没被祖先裁掉**',
          ringFocus ? `${ringFocus.outline} · 被祖先裁掉=${ringFocus.clipped ?? '没有'}` : 'Tab 40 次都没聚焦到它',
          '焦点环是无障碍功能（⛔ 不许删）：这一轮只把外扩从 1px 提到 2px，"白圆"与"蓝框"之间留出空隙',
        )
        /* ⚠️ **重新载一趟再点**：那颗钮此刻还是"键盘聚焦"状态，而 Chromium 的 `:focus-visible`
           启发式只在**焦点发生变化**时重算 —— 对着一颗已经键盘聚焦的钮按鼠标，它可能仍然算
           "键盘聚焦" → 这一条会假红。换一张干净的页面再点，才是"纯鼠标"的那条路径。 */
        await dp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await dp.waitForTimeout(500)
        /* ⚠️ F6 起这一下**还会把选择器打开**（`[data-theme-panel]`）—— 那不影响焦点环：
           环是画在这颗钮的 `:focus-visible` 上的，面板不是它的祖先也不是焦点。
           紧接着的第二下会把面板关掉（"开/关"是同一个 `onClick`）。 */
        await toggle.nth(visibles[0] ?? 0).click()
        await dp.waitForTimeout(250)
        const mouseRing = await dp.evaluate(() => {
          const b = [...document.querySelectorAll('[data-theme-toggle]')].find(
            (e) => e.getBoundingClientRect().width > 0,
          )
          const c = getComputedStyle(b)
          return {
            focusVisible: b.matches(':focus-visible'),
            outlineStyle: c.outlineStyle,
            outlineWidth: c.outlineWidth,
            isActive: document.activeElement === b,
          }
        })
        await toggle.nth(visibles[0] ?? 0).click()
        await dp.waitForTimeout(250)
        check(
          mouseRing.isActive === true && mouseRing.focusVisible === false && mouseRing.outlineStyle === 'none',
          'F5-1：**鼠标点**那颗钮时不出焦点环（所以"点一下就晃出框"其实是移动端底部导航那圈框）',
          `聚焦到它=${mouseRing.isActive} · :focus-visible=${mouseRing.focusVisible} · outline=${mouseRing.outlineStyle} ${mouseRing.outlineWidth}`,
          '这条是"那圈蓝框到底是什么"的判据之一：键盘 == 焦点环；鼠标 == 没有环' +
            '（⚠️ 判据是 `outline-style`：Chromium 在 `none` 时仍然把 `outline-width` 算成 3px，拿宽度判会假红）',
        )
      })

      /* 关掉这个暗色 context：它已经把偏好写成了 dark（同一 context 里后续页面都会是暗的），
         而下面几张图要**自己控制**用哪种 context。 */
      await ctxDark.close()

      /* ---------- ② 暗色下的几张图（工作台 / 班级 / 管理台） ---------- */
      await step('F4 暗色 · 工作台 / 班级 / 管理台', async () => {
        const mk = async (path, name, markers, full = true) => {
          const c = await browser.newContext({
            viewport: { width: 1440, height: 940 },
            locale: 'zh-CN',
            colorScheme: 'dark',
          })
          await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
          await c.addInitScript((s) => {
            window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
            window.localStorage.setItem('shugao.deviceRole', 'teacher')
            /* 明写"我选的是暗色"：这张图不该依赖 context 的 colorScheme 有没有生效 */
            window.localStorage.setItem('shugao.theme', 'dark')
          }, TEACHER_STATE)
          const p = await c.newPage()
          p.on('pageerror', (e) => errors.push(`PAGEERROR(dark:${name}) :: ${e.message}`))
          p.on('console', (m) => {
            if (m.type() === 'error') errors.push(`CONSOLE(dark:${name}) :: ${m.text()}`)
          })
          await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
          await p.waitForTimeout(650)
          const b = await bodyText(p)
          check(
            markers.every((t) => b.includes(t)),
            `F4 暗色「${name}」：这一页真的画出来了（不是一张空白深色图）`,
            markers.every((t) => b.includes(t)) ? `屏上有「${markers.join('」「')}」` : short(b, 130),
          )
          const th = await p.evaluate(() => document.documentElement.getAttribute('data-theme'))
          check(th === 'dark', `F4 暗色「${name}」：` + '`data-theme=dark`', `data-theme = ${th}`)
          await p.screenshot({ path: join(OUT, name), fullPage: full })
          written.push(name)
          console.log(`     📷 ${name}${full ? '（整页）' : ''}`)
          await c.close()
        }
        await mk('/', '116-dark-workbench.png', ['今日待办', '快捷操作'])
        await mk('/classes', '117-dark-classes.png', ['2 个班级 · 91 名学生', '名单完整'])
        await mk('/admin', '118-dark-admin.png', ['隐私', '数据库'])
      })

      /* ---------- E. 🔴 教室端在暗色偏好下**仍然是亮色** ---------- */
      await step('F4 教室端恒亮（暗色偏好下仍是亮色）', async () => {
        const c = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'zh-CN',
          colorScheme: 'dark',
        })
        await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await c.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
          /* 🔴 连"用户自己手动选过暗色"都一起模拟上：教室端必须**无视偏好** */
          window.localStorage.setItem('shugao.theme', 'dark')
        }, TEACHER_STATE)
        const p = await c.newPage()
        p.on('pageerror', (e) => errors.push(`PAGEERROR(dark:classroom) :: ${e.message}`))
        p.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(dark:classroom) :: ${m.text()}`)
        })
        await p.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
        await p.waitForTimeout(1200)
        const b = await bodyText(p)
        check(
          b.includes('这个班的课') || b.includes('正在上课'),
          'F4③：这是教室端那一屏（不是登录页/教师端）',
          b.includes('这个班的课') || b.includes('正在上课') ? '屏上有「这个班的课」/「正在上课」' : short(b, 130),
        )
        const th = await p.evaluate(() => document.documentElement.getAttribute('data-theme'))
        const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
        check(
          th === null,
          '🔴 F4③：**教室端在暗色偏好下仍然是亮色** —— `<html>` 上**没有** `data-theme`',
          `data-theme = ${th === null ? 'null（没写）' : th}`,
          '反向对照：把 Classroom.tsx 顶部那句 removeAttribute 删掉 → 这一条必须红',
        )
        check(
          bg === 'rgb(232, 235, 242)',
          '🔴 F4③：教室端的页面底是**亮色那支** #e8ebf2（不是暗色那支）',
          `body background-color = ${bg}`,
          '反向对照：同上一处',
        )
        const noToggle = await p.evaluate(() => document.querySelectorAll('[data-theme-toggle]').length)
        check(
          noToggle === 0,
          'F4③：教室端上**没有**切换按钮（那块屏不该有人去点它）',
          `[data-theme-toggle] 节点数 = ${noToggle}`,
        )
        await p.screenshot({ path: join(OUT, '119-classroom-still-light.png'), fullPage: false })
        written.push('119-classroom-still-light.png')
        console.log('     📷 119-classroom-still-light.png')
        await c.close()
      })

      /* ============================================================
         F6（2026-10-10）：**强调色轴** —— `data-accent` = `blue`（默认）| `purple`

         用户拍板：「**保留原来的蓝**，新增『校色紫』，合成 **4 套主题**」+「**原来的主题也要保留**」。
         两个轴正交：`data-theme`（亮/暗，**语义一个字没改**）+ `data-accent`（蓝/紫）
         → 亮蓝(默认) / 暗蓝 / 亮紫 / 暗紫。

         这一节钉八件事（🔴 的三条是用户点名的）：
           A. 🔴 **默认 = 亮 + 蓝，且与改动前逐字相同**（DOM 上没有那两个属性 + computed 是那个蓝）；
              反向对照：真落到紫 → 同一批判据必须不成立；
           B. **4 套各自都有值**（源码级逐个是给定值 + 浏览器里 computed 逐个读回来）；
           C. 🔴 **切到紫再切回蓝 → 与原来逐字相同**（含焦点环那三个令牌）；
           D. 🔴 **暗紫的对比度**：accent ≥3（图形）/ accentink ≥4.5（≤12.5px 小字）/ onaccent ≥4.5；
              反向对照：值改深到破线 → 必须红；
           E. 🔴 **教室端恒亮 + 默认蓝**（用户已经选了暗紫也照样）；反向对照：同一份偏好在 `/` 上**是**暗紫；
           F. **跟随系统只改亮暗、不改强调色**（反向对照：系统一变不会顺手替你记一个偏好）；
           G. **`--color-cyan` 仍然 0 处引用**（用户 ④：紫套下"第二套彩色"没有面积可收）。
           H. 🔴🆕 **F6 收尾那两处已知问题**（这一轮修的）：
              · 那批 ≤12.5px 的小字改用第三个令牌 `--color-accenttext` ——
                它在亮蓝 / 暗蓝 / 亮紫**逐字等于该套 `accent`**（所以亮蓝渲染一个字没变），
                只有暗紫另给 `#c275d1`；四套 × 四种底**全部 ≥4.5:1**。
                反向对照：① 把任一套的 accenttext 改成别的值 → 亮蓝那一条红；
                ② 暗紫的值改浅 / 改深到破线 → 对比度那条红；
                ③ **同一次运行里**把令牌在页面里换成红 → 命中数从 ≥2 归零（渲染级证据）。
              · `index.html` 那段**首帧之前**的内联脚本补读了 `shugao.accent`（只在 `purple` 时写属性）
                → 选了紫的用户硬重载**首帧就是紫**。
                反向对照：① 把那句删掉 → 源码判据红；② 运行期不提前写偏好 → 首帧快照是 null
                （挂载后才变紫，正是缺口原来的样子）；③ 默认没选过 → 首帧一个属性都不写。

         ⚠️ 这一节所有比值都从**页面真实算出来的令牌值**取（`readPalette`），不是把数字抄进断言。
         ============================================================ */
      await step('F6 强调色轴（蓝 / 校色紫）', async () => {
        const f1 = (x) => (x === null || x === undefined ? '算不出' : x.toFixed(2))

        /* ---------- A① / B：源码级那一半 ---------- */
        const cssRaw = readFileSync(join(HERE, '..', 'src', 'index.css'), 'utf8')
        /* ⚠️ **先去注释**再判：这一轮自己的注释里就写着那两串十六进制（举例子用的），
              不去注释的话"紫只许出现在紫块里"那条会被自己的注释骗成红。 */
        const cssSrc6 = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
        const baseEnd = cssSrc6.indexOf(":root[data-theme='dark']")
        const base = baseEnd > 0 ? cssSrc6.slice(0, baseEnd) : cssSrc6
        const purpleAt = cssSrc6.indexOf(":root[data-accent='purple']")
        const purpleDarkAt = cssSrc6.indexOf(":root[data-accent='purple'][data-theme='dark']")
        check(
          purpleAt > 0 && purpleDarkAt > purpleAt,
          "F6-B：`index.css` 里有**两个**紫块（亮紫 = `:root[data-accent='purple']`，暗紫 = 再叠一层 `[data-theme='dark']`）",
          `亮紫 @${purpleAt} · 暗紫 @${purpleDarkAt}`,
          '⚠️ 暗紫那条必须是 0,3,0（与暗色块 0,2,0 同级会靠"谁在后面"决胜，不稳）',
        )
        const purpleLight = purpleAt > 0 ? cssSrc6.slice(purpleAt, purpleDarkAt) : ''
        const purpleDark =
          purpleDarkAt > 0 ? cssSrc6.slice(purpleDarkAt, cssSrc6.indexOf('@theme {', purpleDarkAt)) : ''

        /* 🔴 A①：默认那一份（`@theme` 的底）还是原来那个蓝，**逐字** */
        const defaultIsBlue = (src) => /--color-accent\s*:\s*#0b5cf0\s*;/.test(src)
        check(
          defaultIsBlue(base),
          '🔴 F6-A①：默认强调色还是**改动前那个蓝** `#0b5cf0`（`@theme` 里逐字没动）',
          `默认那一块里 ${/#0b5cf0/.test(base) ? '就是 #0b5cf0' : '没有这个值'}`,
          '这是"没选过强调色的用户看到的画面与这一轮之前逐字相同"的第一半',
        )
        check(
          !defaultIsBlue(base.replace('--color-accent: #0b5cf0', '--color-accent: #6d2b7a')),
          '🔴 F6-A①（反向对照）：把默认强调色改成校色紫 → 上面那条**会**红',
          '同一份源码、只换那一个十六进制值 → 同一个判据不成立',
        )
        const purpleElsewhere = base.includes('#6d2b7a') || base.includes('#bc45d3')
        check(
          !purpleElsewhere,
          '🔴 F6-A①：**紫色只出现在那两个紫块里** —— 默认的亮·蓝与暗·蓝里一个紫值都没有',
          purpleElsewhere ? '默认那两块里出现了紫色值' : '默认两块里没有紫色值',
          '反向对照：把任意一个紫值抄回 `@theme` 或暗色块 → 这一条必须红',
        )

        /* B（源码级）：两个紫块里那三件**逐个是给定值** */
        const WANT = {
          亮紫: {
            block: purpleLight,
            vals: { accent: '#6d2b7a', accentink: '#7d318c', accentsoft: '#f7f1f8' },
          },
          暗紫: {
            block: purpleDark,
            vals: { accent: '#bc45d3', accentink: '#c275d1', accentsoft: '#391d3e' },
          },
        }
        for (const [name, { block, vals }] of Object.entries(WANT)) {
          const miss = Object.entries(vals).filter(
            ([k, v]) => !new RegExp(`--color-${k}\\s*:\\s*${v}\\s*;`).test(block),
          )
          check(
            miss.length === 0,
            `F6-B：**${name}**的三件（accent / accentink / accentsoft）在紫块里**逐个是给定值**`,
            miss.length
              ? `对不上的：${miss.map(([k, v]) => `${k} 应为 ${v}`).join('、')}`
              : `三件逐字一致（${Object.values(vals).join(' / ')}）`,
          )
        }
        /* 🔴 焦点环必须跟着强调色走（用户点名"最容易漏"的那一处）+ 那两个分量写法 */
        const followBad = []
        for (const [name, { block }] of Object.entries(WANT)) {
          if (!/--color-focus\s*:\s*#/.test(block)) followBad.push(`${name}:focus`)
          if (!/--color-focus2\s*:\s*\d+ \d+ \d+/.test(block)) followBad.push(`${name}:focus2`)
          if (!/--color-hiline\s*:\s*\d+ \d+ \d+/.test(block)) followBad.push(`${name}:hiline`)
        }
        check(
          followBad.length === 0,
          '🔴 F6：两个紫块里 `--color-focus` / `--color-focus2` / `--color-hiline` **都在**（焦点环不是那个蓝）',
          followBad.length ? `缺的：${followBad.join('、')}` : '亮紫与暗紫三处齐全',
          '`focus2` / `hiline` 是"同一个强调色的分量写法"（`rgb(var(--color-focus2) / .14)` 这样用）',
        )
        check(
          !followBad.length && !/--color-focus\s*:\s*#0b5cf0/.test(purpleLight + purpleDark),
          '🔴 F6：紫块里**没有**把焦点环写成那个蓝（`#0b5cf0`）—— 漏这一处 = 紫套下 Tab 跳出一圈蓝框',
          '紫块里 focus 是 `#6d2b7a` / `#bc45d3`',
        )

        /* ---------- A② / B：运行时那一半（浏览器里逐套读回来） ---------- */
        /**
         * 开一页"已经选好了某一套"的页面，把 24 个令牌 + 两个轴的属性/落盘值都读回来。
         *
         * 🆕 F6 收尾：多一个 `withAccent` —— **故意不写** `shugao.accent` 的对照用。
         * 它是"首帧是紫"那条断言的反向对照：紫**只有一个来源**能赶在首帧之前（`index.html`
         * 里那段内联脚本）。不写那个键 → 首帧必然是蓝，而挂载之后模块那句 `applyAccent()`
         * 照样把属性补成 `purple` —— 于是"末态对、首帧错"这个缺口在断言里**必须现形**。
         */
        const openSet = async (prefs, scheme = 'light', withAccent = true) => {
          const c = await browser.newContext({
            viewport: { width: 1440, height: 940 },
            locale: 'zh-CN',
            colorScheme: scheme,
          })
          await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
          await c.addInitScript(
            ({ st, p, wa }) => {
              window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
              window.localStorage.setItem('shugao.deviceRole', 'teacher')
              if (p.theme) window.localStorage.setItem('shugao.theme', p.theme)
              if (wa && p.accent) window.localStorage.setItem('shugao.accent', p.accent)
            },
            { st: TEACHER_STATE, p: prefs, wa: withAccent },
          )
          const p = await c.newPage()
          p.on('pageerror', (e) => errors.push(`PAGEERROR(F6) :: ${e.message}`))
          p.on('console', (m) => {
            if (m.type() === 'error') errors.push(`CONSOLE(F6) :: ${m.text()}`)
          })
          await p.goto(`${BASE}/`, { waitUntil: 'networkidle' })
          await p.waitForTimeout(600)
          return { c, p, pal: await readPalette(p) }
        }

        /* ⚠️ `wantText` = 🆕 F6 收尾那个 `--color-accenttext` 在**这一套**里应当等于什么。
           除暗紫外三套都**必须与 `accent` 同值** —— 这就是"亮蓝渲染逐字不变"的全部理由。 */
        const SETS = [
          {
            name: '亮蓝(默认)',
            prefs: {},
            theme: null,
            accentAttr: null,
            want: { accent: '#0b5cf0', accentink: '#0847c4', accentsoft: '#e9f0fe' },
            wantText: '#0b5cf0',
          },
          {
            name: '暗蓝',
            prefs: { theme: 'dark' },
            theme: 'dark',
            accentAttr: null,
            want: { accent: '#5386f4', accentink: '#a9c3fb', accentsoft: '#16273f' },
            wantText: '#5386f4',
          },
          {
            name: '亮紫',
            prefs: { accent: 'purple' },
            theme: null,
            accentAttr: 'purple',
            want: { accent: '#6d2b7a', accentink: '#7d318c', accentsoft: '#f7f1f8' },
            wantText: '#6d2b7a',
          },
          {
            name: '暗紫',
            prefs: { theme: 'dark', accent: 'purple' },
            theme: 'dark',
            accentAttr: 'purple',
            want: { accent: '#bc45d3', accentink: '#c275d1', accentsoft: '#391d3e' },
            wantText: '#c275d1',
          },
        ]
        const palOf = {}
        const setBad = []
        for (const s of SETS) {
          const r = await openSet(s.prefs)
          palOf[s.name] = r.pal
          const miss = Object.entries(s.want).filter(([k, v]) => r.pal.tok[k] !== v)
          if (r.pal.theme !== s.theme || r.pal.accent !== s.accentAttr) {
            setBad.push(`${s.name}：属性不对（theme=${r.pal.theme} / accent=${r.pal.accent}）`)
          }
          if (miss.length) {
            setBad.push(
              `${s.name}：${miss.map(([k, v]) => `${k} 应为 ${v}（实测 ${r.pal.tok[k]}）`).join('、')}`,
            )
          }
          /* 🔴 F6-H：强调色文字档那一条 —— 除暗紫外**必须与该套的 `accent` 逐字相同** */
          if (r.pal.tok.accenttext !== s.wantText) {
            setBad.push(`${s.name}：accenttext 应为 ${s.wantText}（实测 ${r.pal.tok.accenttext}）`)
          }
          await r.c.close()
        }
        check(
          setBad.length === 0,
          'F6-B：**4 套**（亮蓝 / 暗蓝 / 亮紫 / 暗紫）在**浏览器里**各自都算出正确的 accent / accentink / accentsoft / accenttext，两轴的属性也对',
          setBad.length
            ? setBad.join('；')
            : SETS.map((s) => `${s.name}=${s.want.accent}·文字${s.wantText}`).join(' · '),
        )

        /* 🔴 A②：默认那一套 —— DOM 上**没有那两个属性**（= 与改动前逐字相同） */
        const blue = palOf['亮蓝(默认)']
        check(
          blue.theme === null && blue.accent === null && blue.stored === null && blue.storedAccent === null,
          '🔴 F6-A②：一个**没选过任何东西**的用户（系统是亮色）→ `<html>` 上没有 `data-theme`、也没有 `data-accent`，两个存储键都没写',
          `data-theme=${blue.theme} · data-accent=${blue.accent} · shugao.theme=${blue.stored} · shugao.accent=${blue.storedAccent}`,
          '这是"129 张图一张不变"的第二半：默认两档都是**摘掉属性**，不是"写上 blue/light"',
        )
        check(
          blue.tok.accent === '#0b5cf0' && blue.tok.accentink === '#0847c4' && blue.tok.accentsoft === '#e9f0fe',
          '🔴 F6-A②：默认算出来的强调色三件 === 改动前那三件（亮蓝）',
          `accent=${blue.tok.accent} · accentink=${blue.tok.accentink} · accentsoft=${blue.tok.accentsoft}`,
        )
        check(
          blue.bodyBg === 'rgb(232, 235, 242)',
          '🔴 F6-A②：默认页面底还是那个亮色 #e8ebf2（逐字）',
          `body background-color = ${blue.bodyBg}`,
        )
        /* 🔴 A②（反向对照）：真落到紫那一档 → 上面那批判据必须**不成立** */
        const lpurple = palOf['亮紫']
        check(
          lpurple.accent === 'purple' && lpurple.tok.accent === '#6d2b7a' && !defaultIsBlue(`--color-accent: ${lpurple.tok.accent};`),
          '🔴 F6-A②（反向对照）：**真的选了紫**之后 —— `data-accent=purple`、accent 变成 `#6d2b7a`，"默认是蓝"那几条判据此时**全部不成立**',
          `data-accent=${lpurple.accent} · accent=${lpurple.tok.accent}`,
          '所以 A② 那三条不是"怎么都不会红"的摆设',
        )

        /* ---------- C：🔴 切到紫再切回蓝 → 与原来逐字相同 ---------- */
        const cC = await browser.newContext({
          viewport: { width: 1440, height: 940 },
          locale: 'zh-CN',
          colorScheme: 'light',
        })
        await cC.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await cC.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        const cp = await cC.newPage()
        cp.on('pageerror', (e) => errors.push(`PAGEERROR(F6) :: ${e.message}`))
        cp.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(F6) :: ${m.text()}`)
        })
        await cp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await cp.waitForTimeout(600)
        const cStart = await readPalette(cp)
        const ACCENT_SIX = ['accent', 'accentink', 'accentsoft', 'focus', 'focus2', 'hiline']
        await panelPick(cp, 'accent', 'purple')
        const cMid = await readPalette(cp)
        check(
          cMid.tok.accent === '#6d2b7a' && cMid.accent === 'purple' && cMid.storedAccent === 'purple',
          'F6-C：在入口钮的选择器里选「紫」→ **当场**变成亮紫，并落盘 `shugao.accent=purple`',
          `data-accent=${cMid.accent} · accent=${cMid.tok.accent} · shugao.accent=${cMid.storedAccent}`,
        )
        await panelPick(cp, 'accent', 'blue')
        const cBack = await readPalette(cp)
        const cDiff = ACCENT_SIX.filter((t) => cBack.tok[t] !== cStart.tok[t])
        check(
          cDiff.length === 0,
          '🔴 F6-C：切到紫再**切回蓝** → 六个令牌（强调色三件 + 焦点环/光晕/高光边）**与切之前逐字相同**',
          cDiff.length
            ? `变了的：${cDiff.map((t) => `${t}: ${cStart.tok[t]} → ${cBack.tok[t]}`).join('；')}`
            : `六个逐字一致（accent=${cBack.tok.accent} · focus=${cBack.tok.focus}）`,
          '反向对照：把蓝套任意一个令牌改坏 → 这一条必须红',
        )
        check(
          cBack.accent === null && cBack.storedAccent === 'blue',
          '🔴 F6-C：切回蓝之后 `data-accent` **被摘掉**（DOM 回到"没有这个属性"），落盘是 `blue`',
          `data-accent=${cBack.accent} · shugao.accent=${cBack.storedAccent}`,
          '蓝不是"写上 blue"，是"摘掉" —— 这一条就是 DOM 层面与改动前逐字相同',
        )
        /* 顺手把那两张"选择器开着"的样子拍出来（124）：同一个页面、同一个 context */
        await panelPick(cp, 'accent', 'purple')
        check(
          (await cp.locator('[data-theme-panel]').count()) === 1 &&
            (await cp.locator('[data-theme-option]').count()) === 2 &&
            (await cp.locator('[data-accent-option]').count()) === 2,
          'F6：入口钮点开是**一个面板、两行、各 2 个选项**（明暗 2 + 强调色 2 = 4 套可达）',
          `panel=${await cp.locator('[data-theme-panel]').count()} · 明暗=${await cp.locator('[data-theme-option]').count()} · 强调色=${await cp.locator('[data-accent-option]').count()}`,
        )
        await cp.screenshot({ path: join(OUT, '124-theme-picker.png'), fullPage: false })
        written.push('124-theme-picker.png')
        console.log('     📷 124-theme-picker.png')
        await cC.close()

        /* ---------- D：🔴 暗紫的对比度（用户点名的 3.44 / 4.71 那两个数） ---------- */
        const dpal = palOf['暗紫']
        const dAccent = contrast(dpal.tok.accent, dpal.tok.surface3)
        const dInk = contrast(dpal.tok.accentink, dpal.tok.surface3)
        const dOn = contrast(dpal.tok.onaccent, dpal.tok.accent)
        const dInkSoft = contrast(dpal.tok.accentink, dpal.tok.accentsoft)
        const dInkSoft2 = contrast(dpal.tok.ink, dpal.tok.accentsoft)
        check(
          dAccent >= 3 && dInk >= 4.5 && dOn >= 4.5 && dInkSoft >= 4.5 && dInkSoft2 >= 4.5,
          '🔴 F6-D：**暗紫** —— `accent` 压**最亮的那层面**（surface3）≥3:1（图形）/ `accentink` 压同一面 ≥4.5:1（≤12.5px 小字）/ `onaccent` 压实心 accent ≥4.5:1 / `accentink`、`ink` 压 accentsoft ≥4.5:1',
          `accent=${f1(dAccent)}:1 · accentink=${f1(dInk)}:1 · onaccent=${f1(dOn)}:1 · accentink/soft=${f1(dInkSoft)}:1 · ink/soft=${f1(dInkSoft2)}:1`,
          '这就是"accent 与 accentink 必须是两个值"的原因：文字 4.5 / 图形 3 两个门槛靠一个值同时满足不了',
        )
        const badDeepA = contrast('#6d2b7a', dpal.tok.surface3)
        const badDeepB = contrast('#8d3f9c', dpal.tok.surface3)
        check(
          badDeepA < 3 && badDeepB < 4.5,
          '🔴 F6-D（反向对照）：把暗紫的 accent 改深到 `#6d2b7a` / accentink 改深到 `#8d3f9c` → 上面那两条阈值**会**红',
          `实测 ${f1(badDeepA)}:1（要 ≥3）/ ${f1(badDeepB)}:1（要 ≥4.5）`,
          '往深里挪一点点就破线 —— 说明那两个读数是真的卡在线上',
        )
        const legacyOn = contrast('#0d1117', dpal.tok.accent)
        check(
          legacyOn !== null && legacyOn < 4.5,
          '🔴 F6-D（反向对照）：**不覆盖** onaccent（沿用暗色块那支 `#0d1117`）只有 4.44:1，破 AA —— 所以暗紫块里那一行是必需的，不是装饰',
          `#0d1117 on ${dpal.tok.accent} = ${f1(legacyOn)}:1`,
        )
        /*
         * 🆕 2026-10-10 F6 收尾：**那批 ≤12.5px 的小字已改用第三个令牌 `--color-accenttext`**
         * —— 上面那条"已知缺口登记"在这里**换成收口后的判据**（文档 §55.3 / §55.9 同步改成"已修"）。
         *
         * 为什么是第三个令牌而不是把那几处改用 `accentink`：
         *   亮蓝下 `accentink` 是 `#0847c4`、而 `accent` 是 `#0b5cf0` —— **不是同一个值**，
         *   改过去就等于**动了亮蓝的渲染**，而这一轮的硬要求正是"亮蓝逐字不变"。
         *   所以新令牌在**亮蓝 / 暗蓝 / 亮紫**三套里**逐字等于该套的 `accent`**（下面三条钉着），
         *   只有暗紫另给 `#c275d1`。
         * ⚠️ `--color-accent` 那一支**一个字都没动**：它仍然是"图形档"（暗紫压 surface3 = 3.44:1 ≥3），
         *    `contrast()` 给的 4.18 / 3.88 只是"它压面不够当小字"这个事实，不是待修的 bug
         *    —— 别为了把这几个数推上去去动 `#bc45d3`。
         */
        const SAME_AS_ACCENT = ['亮蓝(默认)', '暗蓝', '亮紫']
        const notSame = SAME_AS_ACCENT.filter(
          (n) => palOf[n].tok.accenttext !== palOf[n].tok.accent,
        ).map((n) => `${n}：文字 ${palOf[n].tok.accenttext} vs accent ${palOf[n].tok.accent}`)
        const blueHexMoved = SAME_AS_ACCENT.filter(
          (n) => palOf[n].tok.accenttext !== palOf[n].tok.accent,
        ).map((n) => `${n}=${palOf[n].tok.accenttext}`)
        check(
          notSame.length === 0 && blueHexMoved.length === 0,
          '🔴 F6-H（**亮蓝渲染逐字不变**）：`--color-accenttext` 在亮蓝 / 暗蓝 / 亮紫三套里**逐字等于该套的 `accent`**（`#0b5cf0` / `#5386f4` / `#6d2b7a`）—— 那批小字换的只是"令牌名"，算出来的颜色一个字没变',
          notSame.length || blueHexMoved.length
            ? `对不上的：${[...notSame, ...blueHexMoved].join('；')}`
            : SAME_AS_ACCENT.map((n) => `${n}=${palOf[n].tok.accenttext}`).join(' · '),
          '反向对照：把任一套的 accenttext 改成别的值 → 这一条必须红（那批小字的颜色当场就变了）',
        )
        /* 源码级：`index.css` 里那个新令牌**正好四份定义**（四套主题各一份）。
           ⚠️ 只断言"有几份"，**不把值抄进断言** —— 值由上面那两张浏览器级的表来钉。 */
        const cssDefs = (cssSrc6.match(/--color-accenttext/g) ?? []).length
        check(
          cssDefs === 4,
          '🔴 F6-H：`index.css` 里 `--color-accenttext` **四份定义**（`@theme` 亮蓝 / 暗蓝 / 亮紫 / 暗紫 各一份）—— 少一份就有套装不上它',
          `实测 ${cssDefs} 份定义`,
          '反向对照：删掉任一份 → 这一条必须红（那一套里那批小字会掉回 `accent`）',
        )
        /* 源码级：**凡是拿 `accent` 当前景色（`color`）写的地方，已经一律改用 `accenttext`**。
           ⚠️ 上一版这里是"恰好 11 处 + 只扫碰过的 6 个文件 + 判据是 ≤12.5px" ——
              那个 px 边界**真的漏了东西**：`Admin.tsx` 里那个 `<summary>`（11.5px **借父级字号**，
              静态 grep 看不见 `fontSize`）与 13~13.5px 那几处。
              这一版按用户拍板**不再留 px 边界**：判据 = 全仓 `color:` 前景色的两半之和：
                 · `var(--color-accenttext)` = **25 处**
                 · `var(--color-accent)`   = **0 处**
           🔴 **为什么从 29 变成 25（2026-10-10 徽标轮）—— 不是为了让门禁变绿**：
              少掉的那 4 处（`AppShell.tsx` ×2 · `Login.tsx` ×1 · `Classroom.tsx` ×1）**不是小字**，
              是**围着矢量树形图标的那个 `color: currentColor` 容器**（`<span style={{color:…}}><Logo/></span>`）。
              本轮品牌标从矢量图标换成**校徽位图**（`components/Emblem.tsx`）——
              位图**不能被 CSS 染色**，而且校徽**不许改色** → 那 4 个容器整条删掉
              （`徽标方案\落地清单.md` §七 之 4 明确要求"删掉原来给矢量树形图标上色的那一行"）。
              **所以变的是分母，不是口径**：`accent` 仍是 **0 处**，那批 ≤13.5px 的小字仍**逐个**用 `accenttext`。
           ⚠️ `accentColor`（原生 checkbox 的图形档）与 `background:` / `border…:` / 渐变**不在内**：
              它们不是文字、是图形（≥3:1 那一条），本轮一个字没动 —— 共 8 处，留档见 §55.9。 */
        const textSites = { next: 0, old: 0 }
        const perNext = []
        for (const f of execSync('git ls-files src', { cwd: join(HERE, '..'), encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter((x) => x.endsWith('.tsx') || x.endsWith('.ts'))) {
          const s = readFileSync(join(HERE, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
          const n = (s.match(/color:\s*'var\(--color-accenttext\)'/g) ?? []).length
          const o = (s.match(/color:\s*'var\(--color-accent\)'/g) ?? []).length
          textSites.next += n
          textSites.old += o
          if (n) perNext.push(`${f.split('/').pop()}=${n}`)
        }
        check(
          textSites.next === 25 && textSites.old === 0,
          '🔴 F6-H（**不再留 px 边界**）：全仓 `color:` 前景色 —— 用 `accenttext` 的**恰好 25 处**、还用 `accent` 的**恰好 0 处**（29 → 25 那 4 处是"给矢量图标上色"的容器，徽标轮换成校徽位图时整条删掉 —— 理由见上面那段注释）',
          `accenttext=${textSites.next} 处（${perNext.join(' · ')}）· accent=${textSites.old} 处`,
          '反向对照：把其中任一处改回 `var(--color-accent)` → 两个数就不再是 25 / 0，必红',
        )

        /* 🔴 四套 × 那批小字（= accenttext）× **它们真正会落的那几种底**，逐个算 WCAG。
           ⚠️ **为什么没有 surface3**：那 29 处里没有一处坐在 surface3 上（探针逐处量过：
              教室端那三处坐在 `.panel` 的白面上，其余几处同样落在 surface / surface2）。
              暗蓝的 `accent` 压 surface3 只有 **4.24:1** —— 它**不是**这批字的底，
              所以不把它塞进这张表来自欺欺人；要收它得先有"真的有字落在 surface3 上"的证据。
              留档在 `功能设计与不变量.md` §55.3 / §55.9。 */
        const TEXT_BGS = ['surface', 'surface2', 'canvas']
        const textCells = []
        for (const [name, p] of Object.entries(palOf)) {
          for (const bg of TEXT_BGS) {
            const r = contrast(p.tok.accenttext, p.tok[bg])
            textCells.push({ name, bg, r, ok: r !== null && r >= 4.5 })
          }
        }
        const textBad = textCells.filter((c) => !c.ok)
        check(
          textBad.length === 0,
          `🔴 F6-H：**四个主题 × 那批小字** —— \`accenttext\` 压 ${TEXT_BGS.length} 种**真会落到的底**（surface / surface2 / canvas）**全部 ≥4.5:1**（AA）`,
          textBad.length
            ? `不达标的：${textBad.map((c) => `${c.name}/${c.bg}=${f1(c.r)}:1`).join('；')}`
            : `${textCells.length} 个格子全过 · 最低 = ${
                textCells.reduce((a, b) => (a.r <= b.r ? a : b)).name
              }/${textCells.reduce((a, b) => (a.r <= b.r ? a : b)).bg} ${f1(
                Math.min(...textCells.map((c) => c.r)),
              )}:1`,
        )
        const dText = palOf['暗紫'].tok.accenttext
        const dTextWorst = contrast(dText, palOf['暗紫'].tok.surface3)
        check(
          dText === '#c275d1' && dTextWorst !== null && dTextWorst >= 4.5,
          '🔴 F6-H：**暗紫**下小字用的是 `#c275d1`（压最亮的 surface3 ≥4.5）—— 这就是原来那个已知缺口的修法',
          `accenttext=${dText} · 压 surface3 = ${f1(dTextWorst)}:1`,
        )
        /* ⚠️ 顺手把暗蓝那一处**明写出来**（它是这张表里唯一的例外，别让它变成一个说不清的数）：
           暗蓝的 `accent` 压 surface3 = 4.24 —— 那批字不落在 surface3 上，所以上表里没有它；
           但它压 surface2（真的会落）必须是 ≥4.5。 */
        const bAccent2 = contrast(palOf['暗蓝'].tok.accenttext, palOf['暗蓝'].tok.surface2)
        const bAccent3 = contrast(palOf['暗蓝'].tok.accenttext, palOf['暗蓝'].tok.surface3)
        check(
          bAccent2 !== null && bAccent2 >= 4.5 && bAccent3 !== null && bAccent3 < 4.5,
          '🔴 F6-H（暗蓝那一处例外，明写）：暗蓝的 `accenttext` 压 **surface2**（那批字真会落的那一层）≥4.5 ✓；压 **surface3**（那批字**不落**的一层）= 4.24 <4.5 —— 它是这张表里唯一一个"低于 4.5 但落不到"的组合',
          `暗蓝 accenttext 压 surface2 = ${f1(bAccent2)}:1 · 压 surface3 = ${f1(bAccent3)}:1`,
          '口径：`accenttext` 只管"本来就落在面/面2/画布上的那批 ≤12.5px 字"；要收 surface3 得先有真的字落在那里',
        )
        /* 反向对照：把暗紫那个值挪到破线 —— 上面那两条阈值必须红。
           ⚠️ 方向只有一个：**改深**。这里的门槛是"浅字压深底"那一侧，
              往**浅**里挪只会让比值变大（实测 `#d69ee0` = 6.85:1）——
              拿"更浅"做反向对照是**假对照**（它不会红，也说明不了任何事）。 */
        const dBadLight = contrast('#d69ee0', palOf['暗紫'].tok.surface3)
        const dBadDeep = contrast('#8d3f9c', palOf['暗紫'].tok.surface3)
        check(
          dBadDeep !== null && dBadDeep < 4.5 && dBadLight !== null && dBadLight > 4.5,
          '🔴 F6-H（反向对照）：暗紫的 `accenttext` **改深**到 `#8d3f9c` → 上面那两条阈值**会**红；而**改浅**到 `#d69ee0` 只会更大（6.85）—— 门槛是单侧的，别拿"更浅"当反向对照',
          `改深 ${f1(dBadDeep)}:1（<4.5，会红）· 改浅 ${f1(dBadLight)}:1（>4.5，不会红）`,
          '所以这条对照只认"改深"那一边：`#c275d1` 也是往下挪一点点就破线',
        )

        /* ---------- 🆕 F6-H：紫用户硬重载 —— **首帧就是紫**（那段内联脚本的那一行） ---------- */
        const htmlSrc6 = readFileSync(join(HERE, '..', 'index.html'), 'utf8')
        const guardScript = htmlSrc6.slice(htmlSrc6.indexOf(';(function ()'), htmlSrc6.indexOf('</script>'))
        const guardNo = guardScript.replace(
          /if \(a === 'purple'\) document\.documentElement\.setAttribute\('data-accent', 'purple'\)/,
          '',
        )
        const readsKey = /localStorage\.getItem\('shugao\.accent'\)/.test(guardScript)
        const writesOnlyPurple = /if \(a === 'purple'\) document\.documentElement\.setAttribute\('data-accent', 'purple'\)/.test(
          guardScript,
        )
        check(
          guardNo !== guardScript && readsKey && writesOnlyPurple,
          '🔴 F6-H: `index.html` 那段**首帧之前**的内联脚本读了 `shugao.accent`，并且**只在它是 purple 时**写 `data-accent`（默认 / 没选过 / 教室端都不写）',
          `脚本 ${guardScript.length} 字符 · 读 key=${readsKey} · "purple 才写"=${writesOnlyPurple}`,
          '⚠️ 首帧之前跑的东西只准极便宜：它只多读一个 key、多写一个属性（没有循环 / 没有查 DOM）',
        )
        check(
          !/document\.documentElement\.setAttribute\('data-accent'/.test(guardNo),
          '🔴 F6-H（反向对照）：把那一句**删掉**（= 回到本轮之前那个版本）→ 上面那条判据必须**不成立**',
          `删掉之后脚本里还有没有那句写属性：${/document\.documentElement\.setAttribute\('data-accent'/.test(guardNo) ? '有（判据失灵）' : '没有 → 判据会红'} ✅`,
        )
        /*
         * 🔴 **首帧**那一条（这一轮修的另一件事）：选了紫的用户硬重载时，`data-accent` 必须在
         * **第一帧之前**就是 `purple`——靠 `index.html` 里那段内联脚本（它读 `shugao.accent`）。
         *
         * ⚠️ **为什么这一段要自己开三个 context**（而不是直接读上面 `openSet` 那四份快照）：
         *    实测踩到过——**同一个 context 里连着开好几页时，`window.__firstFrame` 会读不到**
         *    （同一份页面代码，新 context 里读得到、旧 context 里恒为 null）。那是"量不到"，
         *    不是"首帧错了"；拿它当证据会得到一条**假红**。所以这一段用**一次性 context**。
         */
        const firstFrameOf = async (prefs) => {
          const fc = await browser.newContext({
            viewport: { width: 1440, height: 940 },
            locale: 'zh-CN',
            colorScheme: 'light',
          })
          await fc.clock.install({ time: new Date('2026-09-19T10:00:00') })
          await fc.addInitScript(
            ({ st, p }) => {
              window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
              window.localStorage.setItem('shugao.deviceRole', 'teacher')
              if (p.theme) window.localStorage.setItem('shugao.theme', p.theme)
              if (p.accent) window.localStorage.setItem('shugao.accent', p.accent)
            },
            { st: TEACHER_STATE, p: prefs },
          )
          const fp2 = await fc.newPage()
          fp2.on('pageerror', (e) => errors.push(`PAGEERROR(F6:H:first) :: ${e.message}`))
          await fp2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
          const snap = await fp2.evaluate(() => ({
            first: window.__firstFrame ?? null,
            attr: document.documentElement.getAttribute('data-accent'),
          }))
          await fc.close()
          return snap
        }
        const ffPurple = await firstFrameOf({ accent: 'purple' })
        const ffBlue = await firstFrameOf({})
        check(
          !!(ffPurple.first && ffPurple.first.accent === 'purple' && ffPurple.attr === 'purple'),
          '🔴 F6-H：**选了紫的用户硬重载 → 首帧之前 `data-accent` 就已经是 `purple`**（内联脚本在首帧之前写的那一份快照 + 那一刻 DOM 上真的带着这个属性，不是挂载之后补的）',
          `首帧快照 = ${JSON.stringify(ffPurple.first)} · 那一刻 data-accent=${ffPurple.attr}`,
          '⚠️ 快照里 `theme` 是 `"light"`（系统亮色 + 没切过明暗）—— 而"不写 light"那条口径成立与否看的是属性，不是这个算出来的值',
        )
        check(
          !!(ffBlue.first && ffBlue.first.accent === null && ffBlue.attr === null),
          '🔴 F6-H（默认仍然不写）：**没选过**的用户 —— 首帧那一刻 `data-accent` **没有**（DOM 上没有这个属性），快照里 `accent` 也是 null（与 F6-A② 口径逐字一致）',
          `首帧快照 = ${JSON.stringify(ffBlue.first)} · 那一刻 data-accent=${ffBlue.attr}`,
        )
        /* 🔴 反向对照（运行时那一半）：同一份页面代码 —— **只把"提前写"那个来源掐掉**
           （`firstFrameOf` 不往 `localStorage` 里写 `shugao.accent`），首帧就是蓝，
           而挂载之后模块那句 `applyAccent()` 照样把它补成紫。
           ⚠️ 少写一个 key（那是运行器的事、不是断言口径），页面代码一字不改。 */
        const ffLate = await firstFrameOf({})
        const mountLate = await (async () => {
          const r = await openSet({ accent: 'purple' }, 'light', false)
          const a = r.pal.accent
          await r.c.close()
          return a
        })()
        check(
          !!(ffLate.first && ffLate.first.accent === null) && mountLate === null,
          '🔴 F6-H（反向对照）：**不提前**把偏好写进 `localStorage` → 首帧快照里 `data-accent` 是 **null**（挂载之后也没有：模块那句 `applyAccent()` 读的就是 `localStorage`，那里本来就没有）—— 与上面"提前写了就是 purple"恰成对照',
          `首帧 = ${JSON.stringify(ffLate.first)} · 挂载后 data-accent=${mountLate}`,
          '这一条红的样子就是"紫用户硬重载先看到一帧蓝"那个缺口的原貌：**唯一的来源就是那段内联脚本**',
        )

        /* 🔴🔴 F6-H（**这一轮最重要的一条**）：亮蓝下那批小字的**渲染真的没变**。
           ⚠️ 判据是**浏览器 CSSOM 里真正解析出来的值**（不是源码字符串）：
              在**同一页、同一个 context** 里把两个轴的属性逐个设过去，读 `--color-accenttext`：
                · 亮蓝 / 暗蓝 / 亮紫 → **必须与 `--color-accent` 逐字相同**
                  （所以那批字换的只是"令牌名"，屏幕上一个像素都不会变）；
                · 暗紫 → `#c275d1`（唯一一个不同值，也是这轮要修的那一处）。
              → 这条与上面 `readPalette` 那张表是**两条独立的通道**：
                `readPalette` 读的是四套各自的页面，这里读的是**同一页的层叠结果** ——
                只有两边都对得上，"令牌真的被浏览器认下来"才不是一句话。
           ⚠️ 归一：`getPropertyValue('--color-x')` 给回来的是**十六进制**（两边都按十六进制比，别混 rgb）。 */
        const SENTINEL = '#123456'
        const hex6 = (s) => {
          const t = String(s ?? '').trim()
          const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
          if (hex) {
            const h = hex[1].length === 3 ? hex[1].split('').map((x) => x + x).join('') : hex[1]
            return `#${h.toLowerCase()}`
          }
          const m = t.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
          return m ? `#${[1, 2, 3].map((i) => Math.round(+m[i]).toString(16).padStart(2, '0')).join('')}` : t
        }
        const accCtx = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'zh-CN',
          colorScheme: 'light',
        })
        await accCtx.clock.install({ time: new Date('2026-09-19T10:00:00') })
        const accPage = await accCtx.newPage()
        accPage.on('pageerror', (e) => errors.push(`PAGEERROR(F6:H) :: ${e.message}`))
        await accPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
        await accPage.waitForTimeout(400)
        const cssomSeen = []
        const cssomBad = []
        for (const [th, ac] of [
          [null, null],
          ['dark', null],
          [null, 'purple'],
          ['dark', 'purple'],
        ]) {
          const r = await accPage.evaluate(
            ({ th, ac }) => {
              const de = document.documentElement
              if (th) de.setAttribute('data-theme', th)
              else de.removeAttribute('data-theme')
              if (ac) de.setAttribute('data-accent', ac)
              else de.removeAttribute('data-accent')
              const cs = getComputedStyle(de)
              return {
                theme: de.getAttribute('data-theme'),
                accent: de.getAttribute('data-accent'),
                accentVal: cs.getPropertyValue('--color-accent').trim(),
                accenttext: cs.getPropertyValue('--color-accenttext').trim(),
              }
            },
            { th, ac },
          )
          /* ⚠️ 标签用**固定字**（第一版拿 `r.theme ?? '亮'` 拼出来的是 `dark·purple`，
              与下面那句断言里写的中文标签对不上 → 判据本身没红，是我判据写错了）。 */
          const label = th === 'dark' ? (ac === 'purple' ? '暗紫' : '暗蓝') : ac === 'purple' ? '亮紫' : '亮蓝'
          cssomSeen.push({ label, accent: hex6(r.accentVal), text: hex6(r.accenttext) })
          if (hex6(r.accenttext) !== hex6(r.accentVal)) cssomBad.push(label)
        }
        /* 只有"暗紫"那一档**允许**不同（那正是这一轮要修的那一处，也是唯一一处） */
        check(
          cssomBad.length === 1 && cssomBad[0] === '暗紫',
          '🔴 F6-H：**同一页里**四套主题各自解析出来的 `--color-accenttext` —— 亮蓝/暗蓝/亮紫 **逐字等于该套的 `accent`**（所以那批小字换的只是令牌名，亮蓝渲染一个像素没变），**只有暗紫不同**',
          `不同的：${cssomBad.join('、') || '（一处都没有）'} · 实测 ${cssomSeen
            .map((s) => `${s.label} accent=${s.accent}/text=${s.text}`)
            .join(' · ')}`,
          '反向对照：把亮蓝那份 accenttext 改成别的值 → 上面这个"只有暗紫不同"立刻不成立，必红',
        )
        /* 再加一发**哨兵**（同一次运行里真跑）：把令牌换成 `#123456` 之后，
           同页渲染出来的 `--color-accent` 与 `--color-meta` 都不动 —— 说明它真的是"只有那批小字在读"的令牌。 */
        await accPage.evaluate(
          (css) => {
            const s = document.createElement('style')
            s.setAttribute('data-f6-sentinel', '1')
            s.textContent = css
            document.documentElement.appendChild(s)
          },
          `:root{--color-accenttext:${SENTINEL} !important;}`,
        )
        const senti = await accPage.evaluate(() => {
          const cs = getComputedStyle(document.documentElement)
          return {
            accenttext: cs.getPropertyValue('--color-accenttext').trim(),
            accentVal: cs.getPropertyValue('--color-accent').trim(),
            toggle: document.querySelectorAll('.theme-toggle,[data-theme-toggle]').length,
          }
        })
        check(
          hex6(senti.accenttext) === SENTINEL && hex6(senti.accentVal) !== SENTINEL,
          '🔴 F6-H（哨兵 · 反向对照）：把 `--color-accenttext` 在页面里换成哨兵色 `#123456` —— 它**当场就变**（证明这条通道读的是活样式），而 `--color-accent` **一动不动**（证明两者不是同一个东西）',
          `accenttext=${hex6(senti.accenttext)} · accent=${hex6(senti.accentVal)}（应保持亮蓝那位）`,
          '口径：这一轮**只动小字那一支**，图形档的 accent 一个字没动',
        )
        await accCtx.close()
        /* 亮紫那一套：三件压各自的底都远超 4.5（把它也钉住，免得日后有人"顺手调浅"） */
        const lpal = palOf['亮紫']
        const LPAIRS = [
          ['accent', 'surface'],
          ['accent', 'canvas'],
          ['accentink', 'surface'],
          ['accentink', 'accentsoft'],
          ['ink', 'accentsoft'],
        ]
        const lBad = []
        for (const [fg, bg] of LPAIRS) {
          const r = contrast(lpal.tok[fg], lpal.tok[bg])
          if (r === null || r < 4.5) lBad.push(`${fg} on ${bg} = ${f1(r)}:1`)
        }
        check(
          lBad.length === 0,
          `F6-D：**亮紫** —— ${LPAIRS.length} 对（强调色 / 小字 × 各自的底）**全部 ≥4.5:1**`,
          lBad.length
            ? `不达标的：${lBad.join('；')}`
            : `${LPAIRS.length} 对全过（最低 ≈ ${Math.min(...LPAIRS.map(([f, b]) => contrast(lpal.tok[f], lpal.tok[b]) ?? 99)).toFixed(2)}:1）`,
        )

        /* ---------- E：🔴 教室端恒亮 + 默认蓝 ---------- */
        const cE = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'zh-CN',
          colorScheme: 'dark',
        })
        await cE.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await cE.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
          /* 🔴 系统是暗的 + 用户自己选过「暗紫」—— 教室端两条都要无视 */
          window.localStorage.setItem('shugao.theme', 'dark')
          window.localStorage.setItem('shugao.accent', 'purple')
        }, TEACHER_STATE)
        const ep = await cE.newPage()
        ep.on('pageerror', (e) => errors.push(`PAGEERROR(F6:classroom) :: ${e.message}`))
        ep.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(F6:classroom) :: ${m.text()}`)
        })
        /* ⚠️ **先开 `/` 再开 `/classroom`**：教室端那一页跑完可能把这台设备标成教室端
              （`setDeviceRole`），那时再回 `/` 会被送去 `/login` —— 顺序反过来就是假红。 */
        await ep.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await ep.waitForTimeout(700)
        const eHome = await readPalette(ep)
        check(
          eHome.theme === 'dark' && eHome.accent === 'purple' && eHome.tok.accent === '#bc45d3',
          '🔴 F6-E（反向对照）：**同一份偏好**（系统暗色 + 选了紫）在教师端 `/` 上就是**暗紫**（`data-accent=purple`、accent=#bc45d3）',
          `data-theme=${eHome.theme} · data-accent=${eHome.accent} · accent=${eHome.tok.accent}`,
          '两边用同一套判据：教师端认、教室端不认 —— "教室端恒亮+默认蓝"才是有内容的断言',
        )
        await ep.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
        await ep.waitForTimeout(1200)
        const eText = await bodyText(ep)
        check(
          eText.includes('这个班的课') || eText.includes('正在上课'),
          'F6-E：这是教室端那一屏（不是登录页/教师端）',
          eText.includes('这个班的课') || eText.includes('正在上课') ? '屏上有「这个班的课」/「正在上课」' : short(eText, 130),
        )
        const ePal = await readPalette(ep)
        check(
          ePal.theme === null && ePal.accent === null,
          '🔴 F6-E：教室端在"用户选了暗紫 + 系统是暗色"下**仍然是亮色 + 默认蓝** —— `<html>` 上 `data-theme` 与 `data-accent` **都没有**',
          `data-theme=${ePal.theme} · data-accent=${ePal.accent}`,
          '反向对照就是上一条：同一份偏好在 `/` 上是**暗紫** —— 所以这条不是"怎么都不会红"',
        )
        check(
          ePal.bodyBg === 'rgb(232, 235, 242)' && ePal.tok.accent === '#0b5cf0' && ePal.tok.accentsoft === '#e9f0fe',
          '🔴 F6-E：教室端的强调色令牌还是**默认那份蓝**（`#0b5cf0`），页面底还是亮色那支',
          `body=${ePal.bodyBg} · accent=${ePal.tok.accent} · accentsoft=${ePal.tok.accentsoft}`,
        )
        check(
          (await ep.locator('[data-theme-toggle]').count()) === 0 &&
            (await ep.locator('[data-theme-panel]').count()) === 0,
          'F6-E：教室端上**既没有入口钮也没有选择器**（那块屏不该有人去点它）',
          `入口钮=${await ep.locator('[data-theme-toggle]').count()} · 面板=${await ep.locator('[data-theme-panel]').count()}`,
        )
        await cE.close()

        /* ---------- F：跟随系统只改亮暗、不改强调色 ---------- */
        const cF = await browser.newContext({
          viewport: { width: 1440, height: 940 },
          locale: 'zh-CN',
          colorScheme: 'dark',
        })
        await cF.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await cF.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
          /* ⚠️ **只**写强调色：亮/暗那一轴交给系统（不写 `shugao.theme` = 跟随系统） */
          window.localStorage.setItem('shugao.accent', 'purple')
        }, TEACHER_STATE)
        const fp = await cF.newPage()
        fp.on('pageerror', (e) => errors.push(`PAGEERROR(F6) :: ${e.message}`))
        fp.on('console', (m) => {
          if (m.type() === 'error') errors.push(`CONSOLE(F6) :: ${m.text()}`)
        })
        await fp.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await fp.waitForTimeout(600)
        const fDark = await readPalette(fp)
        check(
          fDark.theme === 'dark' && fDark.accent === 'purple' && fDark.tok.accent === '#bc45d3',
          'F6-F：系统暗色 + 选了强调色紫 → **暗紫**（强调色本身没有"跟随系统"这一档，但它跟着亮暗轴走）',
          `data-theme=${fDark.theme} · data-accent=${fDark.accent} · accent=${fDark.tok.accent}`,
        )
        await fp.emulateMedia({ colorScheme: 'light' })
        await fp.waitForTimeout(500)
        const fLight = await readPalette(fp)
        check(
          fLight.theme === null && fLight.accent === 'purple' && fLight.tok.accent === '#6d2b7a',
          '🔴 F6-F：系统切到亮色 → **亮暗跟着系统变**（暗紫 → 亮紫），**强调色一动不动**（还是 purple，没被改写成 blue）',
          `data-theme=${fLight.theme} · data-accent=${fLight.accent} · accent ${fDark.tok.accent} → ${fLight.tok.accent}`,
          '反向对照：若"跟随系统"顺手把强调色也重置了，这里会看到 data-accent 变 null / accent 变回 #0b5cf0',
        )
        check(
          fLight.stored === null && fLight.storedAccent === 'purple',
          '🔴 F6-F：系统那一下**没有替你记一个亮/暗偏好**（`shugao.theme` 仍是空）—— "跟随系统"不等于"替你做了选择"',
          `shugao.theme=${fLight.stored} · shugao.accent=${fLight.storedAccent}`,
        )
        /* 反向对照：手动覆盖过之后，系统那一份就管不着了（说明 emulateMedia 那条路是真的通的） */
        await panelPick(fp, 'theme', 'dark')
        await fp.emulateMedia({ colorScheme: 'light' })
        await fp.waitForTimeout(400)
        const fPin = await readPalette(fp)
        check(
          fPin.theme === 'dark' && fPin.accent === 'purple',
          '🔴 F6-F（反向对照）：手动选过暗色之后，系统再切成亮色**也改不动它**（`data-theme` 仍是 dark）—— 上面那条"跟着系统变"确实走的同一条监听',
          `data-theme=${fPin.theme} · data-accent=${fPin.accent}`,
        )
        await cF.close()

        /* ---------- G：用户 ④ —— `--color-cyan` 仍然 0 处引用 ---------- */
        const walkSrc = (dir) =>
          readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
            d.isDirectory() ? walkSrc(join(dir, d.name)) : [join(dir, d.name)],
          )
        const srcFiles = walkSrc(join(HERE, '..', 'src')).filter((f) => /\.(tsx?|css)$/.test(f))
        const cyanRefs = srcFiles.filter((f) => /--color-cyan/.test(readFileSync(f, 'utf8')))
        check(
          cyanRefs.length === 1 && cyanRefs[0].endsWith('index.css'),
          'F6-G（用户 ④）：`--color-cyan` 在 `src` 里**只有定义、0 处引用** —— 所以紫套下没有"第二套彩色"的面积要收（**这一轮刻意不改它**，理由见 `index.css` 那个紫块上方与文档 §F6）',
          cyanRefs.length ? `${cyanRefs.length} 个文件命中：${cyanRefs.map((f) => f.slice(-40)).join('、')}` : '没有任何文件用它',
          '反向对照：把 `var(--color-cyan)` 写进任意一个页面 → 这一条**会**红，那一轮必须回来决定"紫套下怎么收它"',
        )
        check(
          srcFiles.some((f) => f.endsWith('index.css')) && srcFiles.length > 100,
          'F6-G：上面那条扫的是**真的源码树**（不是扫了个空目录就绿）',
          `扫到 ${srcFiles.length} 个 .ts/.tsx/.css 文件`,
          '反向对照：把 `walkSrc` 指到一个不存在的目录 → 文件数归零、这一条必须红',
        )

        /* ---------- 图片：亮紫 2 页 / 暗紫 2 页 ---------- */
        const mkSet = async (prefs, path6, name, markers, full = true) => {
          const c = await browser.newContext({
            viewport: { width: 1440, height: 940 },
            locale: 'zh-CN',
            colorScheme: prefs.theme === 'dark' ? 'dark' : 'light',
          })
          await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
          await c.addInitScript(
            ({ st, p }) => {
              window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
              window.localStorage.setItem('shugao.deviceRole', 'teacher')
              if (p.theme) window.localStorage.setItem('shugao.theme', p.theme)
              if (p.accent) window.localStorage.setItem('shugao.accent', p.accent)
            },
            { st: TEACHER_STATE, p: prefs },
          )
          const p = await c.newPage()
          p.on('pageerror', (e) => errors.push(`PAGEERROR(F6:${name}) :: ${e.message}`))
          p.on('console', (m) => {
            if (m.type() === 'error') errors.push(`CONSOLE(F6:${name}) :: ${m.text()}`)
          })
          await p.goto(`${BASE}${path6}`, { waitUntil: 'networkidle' })
          await p.waitForTimeout(650)
          const b = await bodyText(p)
          check(
            markers.every((t) => b.includes(t)),
            `F6 紫套「${name}」：这一页真的画出来了（不是一张空白图）`,
            markers.every((t) => b.includes(t)) ? `屏上有「${markers.join('」「')}」` : short(b, 130),
          )
          const pal = await readPalette(p)
          check(
            pal.accent === 'purple' && pal.theme === (prefs.theme ?? null),
            `F6 紫套「${name}」：` + '`data-accent=purple` + 亮/暗与这一套相符',
            `data-theme=${pal.theme} · data-accent=${pal.accent} · accent=${pal.tok.accent}`,
          )
          await p.screenshot({ path: join(OUT, name), fullPage: full })
          written.push(name)
          console.log(`     📷 ${name}${full ? '（整页）' : ''}`)
          await c.close()
        }
        await mkSet({ accent: 'purple' }, '/', '120-purple-workbench.png', ['今日待办', '快捷操作'])
        await mkSet({ accent: 'purple' }, '/classes', '121-purple-classes.png', [
          '2 个班级 · 91 名学生',
          '名单完整',
        ])
        await mkSet({ theme: 'dark', accent: 'purple' }, '/', '122-darkpurple-workbench.png', [
          '今日待办',
          '快捷操作',
        ])
        await mkSet({ theme: 'dark', accent: 'purple' }, '/admin', '123-darkpurple-admin.png', [
          '隐私',
          '数据库',
        ])
      })

    /*
     * ================= S22：改名收口 + 校徽（2026-10-10 徽标轮） =================
     *
     * 这一节**不截图**：它钉的是"名字改干净了 + 徽标在四套主题下都对"，不是某张图长什么样。
     * 每一条都带 🧪 反向对照（同一个函数喂坏值 → 必须判假），做法照 `AGENTS.md` 三·2
     * 与本文件既有那批（见 2968 / 3012 行）：**就地改内存里的那份文本/对象，不动磁盘**。
     *
     * 🔴 扫描用的旧名要**拼出来**（`OLD.join('')`），不能写成连着的字面量 ——
     *    否则 `shots.mjs` 自己就成了"旧名 1 处"，第 ① 条**永远红**。
     */
    await step('S22：改名收口 + 校徽四套主题', async () => {
      const ROOT22 = join(HERE, '..', '..')
      const PUB22 = join(HERE, '..', 'public')
      const OLD22 = ['树高', '教师平台'].join('')

      /* ---------- ① 旧名：全仓**文本文件** 0 处 ----------
       * ⚠️ 二进制跳过（`.lnk` 存的是**仓库所在目录**的名字，那是文件夹不是平台名）；
       * ⚠️ `-c core.quotePath=false -z`：git 默认会把中文路径转义成八进制，那样的路径读不开，
       *    会被 `catch` 悄悄跳掉 —— 那就成了"读不到 = 0 处"的假绿（`AGENTS.md` 三·1）。
       */
      const tracked22 = execSync('git -c core.quotePath=false ls-files -z', { cwd: ROOT22 })
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
      /* 🔴 2026-10-11 修：**"不在工作区"和"真读不到"必须分开**。
       * 踩到的现场：`emblem-pure-24.png` 在工作区被删了、**但还在 git 索引里** →
       * `git ls-files` 照样列它 → `readFileSync` 报 ENOENT → 被算进"读失败 1" → 这条判据红。
       * 🔴 **正确口径**：`git ls-files` 的结果先过一遍 `fs.existsSync()`
       *    · **不在工作区**（已删 / 已 rename，git 还没记）→ **跳过**，并**把数量报出来**
       *      （⚠️ 不许静默跳过 —— `AGENTS.md` 三·5；也**不许**把它当成"扫过了、0 处"）
       *    · **真读不到**（权限 / 编码坏 / 是目录）→ **仍然算失败，仍然报错**，这正是这条断言的原意
       */
      const texts22 = []
      let bin22 = 0
      const missing22 = []
      const fail22 = []
      for (const rel of tracked22) {
        const abs = join(ROOT22, rel)
        if (!existsSync(abs)) {
          missing22.push(rel)
          continue
        }
        let buf
        try {
          buf = readFileSync(abs)
        } catch (e) {
          fail22.push(`${rel}（${e instanceof Error ? e.message : String(e)}）`)
          continue
        }
        if (buf.includes(0)) {
          bin22++
          continue
        }
        texts22.push({ path: rel, text: buf.toString('utf8') })
      }
      check(
        fail22.length === 0 && texts22.length > 150,
        'S22 ①：下面那条扫的是**真的**仓库文件树（不是"读不到就当成 0 处"）—— 「不在工作区」（git 还没记的删除）**跳过并计数**，「真读不到」**仍然要报**',
        `git ls-files ${tracked22.length} 个 → 文本 ${texts22.length} / 二进制 ${bin22} / 不在工作区（已跳过）${missing22.length} / 读失败 ${fail22.length}`,
        fail22.length ? `读失败的是：${fail22.slice(0, 5).join('、')}` : '',
      )
      /* 跳过的那几个要**看得见**（不然"跳过了 200 个"和"跳过了 0 个"在读数里长得一样） */
      check(
        !missing22.includes('app/src/main.tsx') && !missing22.includes('app/scripts/shots.mjs'),
        'S22 ①：跳过的那几个**不含**仓库的核心文件（证明 `existsSync` 那一关没把整棵工作区误判成"不在"）',
        missing22.length ? `跳过的 ${missing22.length} 个：${missing22.slice(0, 8).join('、')}` : '跳过 0 个',
      )
      /* 🧪 反向对照 A：**真读不到** → 上面那条必须红。
       * ⚠️ 造这个夹具比看起来难（第一版写错了两次，**实测都没红**，记下来免得再踩）：
       *   ① 用「已跟踪、但路径上是目录」—— **"不存在"压过一切**：
       *      `existsSync('_diag-dir/keep.txt')`（keep.txt 已删）**照样是 false** → 落进"不在工作区"那一档；
       *   ② 用联结（junction）—— `readFileSync` 确实抛 `EISDIR` ✓，但 **git 不跟踪联结**，
       *      `git add -N` 既不报错也不登记任何东西 → 索引里 0 条，判据永远红。
       * ✅ 最终做法：`mkdir` 一个真目录 + `git update-index --add --cacheinfo` **手动往索引里塞一条
       *   普通文件记录**（空 blob 的 sha1）→ 索引里那条路径在磁盘上是个**目录**
       *   → `existsSync` 为真、`readFileSync` 必抛 `EISDIR`。这正是"真读不到"。
       * `finally` 里 `git rm --cached` + `rmSync` 无条件清干净。
       */
      const DD22 = '_diag-real-dir'
      try {
        mkdirSync(join(ROOT22, DD22), { recursive: true })
        const sha22 = execSync('git hash-object -t blob --stdin', {
          cwd: ROOT22,
          input: '',
          stdio: ['pipe', 'pipe', 'ignore'],
        })
          .toString()
          .trim()
        execSync(`git update-index --add --cacheinfo 100644,${sha22},${DD22}`, {
          cwd: ROOT22,
          stdio: 'ignore',
        })
        const tracked2 = execSync('git -c core.quotePath=false ls-files -z', { cwd: ROOT22 })
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
        const miss2 = []
        const fail2 = []
        for (const rel of tracked2) {
          const abs = join(ROOT22, rel)
          if (!existsSync(abs)) {
            miss2.push(rel)
            continue
          }
          try {
            readFileSync(abs)
          } catch (e2) {
            fail2.push(`${rel}（${e2 instanceof Error ? e2.code ?? e2.message : String(e2)}）`)
          }
        }
        const inFail2 = fail2.some((x) => x.startsWith(DD22))
        const inMiss2 = miss2.includes(DD22)
        check(
          inFail2 && !inMiss2,
          '🧪 S22 ① 反向对照 A：造一个**真读不到**的（索引里是文件、磁盘上是个目录 → `existsSync` 真、`readFileSync` 抛 `EISDIR`）→ 落进**"读失败"**那一档 —— 上面那条因此会红，证明"真读不到"没被一起放掉',
          `读失败 ${fail2.length} 个${inFail2 ? `（含 ${DD22}）` : ''} · 不在工作区 ${miss2.length} 个${inMiss2 ? `（含 ${DD22} ← 放错了档）` : ''}`,
          fail2.length ? `读失败清单：${fail2.slice(0, 5).join('、')}` : '（fail2 是空的）',
        )
      } finally {
        try {
          execSync(`git rm --cached -q --ignore-unmatch -- ${DD22}`, { cwd: ROOT22, stdio: 'ignore' })
        } catch {
          /* 忽略 */
        }
        rmSync(join(ROOT22, DD22), { recursive: true, force: true })
      }
      /* 🧪 反向对照 B：**已跟踪、但工作区里没有** → 必须被**跳过**（不是读失败）。
       * 造法：建一个临时文件、`git add -N` 登记、**再把它删掉** ——
       * 这就是 `emblem-pure-24.png` 现在的状态（在索引里、不在工作区），
       * 也是本轮这条判据最初红掉的原因。
       */
      const TP22 = '_diag-tracked-missing.txt'
      try {
        writeFileSync(join(ROOT22, TP22), 'x')
        execSync(`git add -N -- ${TP22}`, { cwd: ROOT22, stdio: 'ignore' })
        rmSync(join(ROOT22, TP22), { force: true })
        const tracked3 = execSync('git -c core.quotePath=false ls-files -z', { cwd: ROOT22 })
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
        const miss3 = tracked3.filter((r) => !existsSync(join(ROOT22, r)))
        check(
          miss3.includes(TP22),
          '🧪 S22 ① 反向对照 B：造一个"已跟踪、但工作区里没有"（= `emblem-pure-24.png` 那种状态）→ 它落进**"不在工作区（已跳过）"**，**不进"读失败"**（两种状态真的分开了，而且这一档不是静默的：数量会打进读数）',
          `不在工作区 ${miss3.length} 个${miss3.includes(TP22) ? `，含 ${TP22}` : ''}`,
        )
      } finally {
        try {
          execSync(`git rm --cached -q --ignore-unmatch -- ${TP22}`, { cwd: ROOT22, stdio: 'ignore' })
        } catch {
          /* 忽略 */
        }
        rmSync(join(ROOT22, TP22), { force: true })
      }
      const scanOld22 = (list) => list.filter((f) => f.text.includes(OLD22)).map((f) => f.path)
      const oldHits22 = scanOld22(texts22)
      check(
        oldHits22.length === 0,
        `🔴 S22 ① 改名收口：「${OLD22}」在仓库**全部文本文件**里 0 处`,
        oldHits22.length
          ? `${oldHits22.length} 处：${oldHits22.slice(0, 8).join('、')}`
          : `扫了 ${texts22.length} 个文本文件，0 处`,
      )
      const negOld22 = scanOld22([
        ...texts22,
        { path: '🧪（反向对照塞回来的那一处）', text: `  · ${OLD22}\n` },
      ])
      check(
        negOld22.length === 1,
        '🧪 S22 ① 反向对照：往同一批文本里塞回一处旧名 → 同一个扫描函数**当场判假**（这条不是"永远为绿"的摆设）',
        `命中 ${negOld22.length} 处：${negOld22.join('、')}`,
      )

      /* ---------- ② localStorage 的键：一个都没变 ----------
       * 🔴 改名轮最容易顺手改的就是这些键名 —— 改一个，所有人的主题偏好、班级选择、
       *    草稿、设备角色**全丢**（`AGENTS.md` 四、`落地清单.md` B9）。所以把键表钉死。
       */
      const KEYS22 = [
        'shugao.accent',
        'shugao.accountKindProbe',
        'shugao.admin.build',
        'shugao.ann.hideDay',
        'shugao.ann.preview',
        'shugao.ann.seen',
        'shugao.ann.sessSeen',
        'shugao.backup',
        'shugao.backupDir',
        'shugao.classroom',
        'shugao.classroom.classId',
        'shugao.classroom.v1',
        'shugao.currentClass',
        'shugao.deviceRole',
        'shugao.deviceRoleAt',
        'shugao.exam.grade.draft.${id}',
        'shugao.grade.draft.${id}',
        'shugao.lastAuthAt',
        'shugao.local',
        'shugao.mood.celebrated',
        'shugao.mood.welcomed',
        'shugao.remind.seen',
        'shugao.teacher.v1',
        'shugao.theme',
      ]
      const walk22 = (dir) =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
          d.isDirectory()
            ? d.name === 'node_modules'
              ? []
              : walk22(join(dir, d.name))
            : [join(dir, d.name)],
        )
      const keyFiles22 = ['src', 'scripts', 'functions']
        .flatMap((d) => walk22(join(HERE, '..', d)))
        .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
      const collectKeys22 = (files) => {
        const s = new Set()
        for (const f of files) {
          for (const m of readFileSync(f, 'utf8').matchAll(/['"`](shugao\.[A-Za-z0-9_.${}-]+)['"`]/g)) {
            s.add(m[1])
          }
        }
        return [...s].sort()
      }
      /** 键表里"多出来的"那些（反向对照也用它） */
      const keyExtra22 = (list) => list.filter((k) => !KEYS22.includes(k))
      const keysNow22 = collectKeys22(keyFiles22)
      const keyMiss22 = KEYS22.filter((k) => !keysNow22.includes(k))
      const keyNew22 = keyExtra22(keysNow22)
      check(
        keyMiss22.length === 0 && keyNew22.length === 0 && keysNow22.length === KEYS22.length,
        `S22 ②：\`localStorage\` 的键**一个都没变**（${KEYS22.length} 个，含 \`shugao.theme\` / \`shugao.accent\` / \`shugao.teacher.v1\`）`,
        keyMiss22.length || keyNew22.length
          ? `少了 ${keyMiss22.join('、') || '（无）'}；多了 ${keyNew22.join('、') || '（无）'}`
          : `${keysNow22.length} 个键逐个相同`,
      )
      check(
        keyFiles22.length > 100,
        'S22 ②：上面那张键表扫的是真的源码树（不是扫了个空目录就绿）',
        `扫了 ${keyFiles22.length} 个 .ts/.tsx/.mjs/.js 文件（src + scripts + functions）`,
      )
      /* ⚠️ 反向对照用的那个"坏键名"要**拼出来**：写成连着的字面量会被上面那个扫描器
         自己收进键表（`shots.mjs` 也在被扫的目录里），于是第 ② 条永远红。 */
      const BADKEY22 = 'shugao.theme' + '2'
      const negKeys22 = keysNow22.map((k) => (k === 'shugao.theme' ? BADKEY22 : k))
      check(
        keyExtra22(negKeys22).length === 1 &&
          KEYS22.filter((k) => !negKeys22.includes(k)).length === 1,
        `🧪 S22 ② 反向对照：把 \`shugao.theme\` 在**内存里**改成 \`${BADKEY22}\` → 同一张键表**当场对不上**`,
        `改后少了 \`shugao.theme\`、多了 ${keyExtra22(negKeys22).join('、')}`,
      )

      /* ---------- ③ manifest：名字换了，但**底色那两个色值一个都没动** ---------- */
      const mf22 = JSON.parse(readFileSync(join(PUB22, 'manifest.webmanifest'), 'utf8'))
      check(
        mf22.background_color === '#E8EBF2' && mf22.theme_color === '#E8EBF2',
        'S22 ③：manifest 的 `background_color` / `theme_color` **没变**（都还是 `#E8EBF2`）',
        `background_color=${mf22.background_color} · theme_color=${mf22.theme_color}`,
        '反向对照：把 theme_color 顺手改成强调色 → 这条红（它决定 Android 状态栏，不是我们的强调色）',
      )
      const negMf22 = { ...mf22, theme_color: '#6d2b7a' }
      check(
        !(negMf22.background_color === '#E8EBF2' && negMf22.theme_color === '#E8EBF2'),
        '🧪 S22 ③ 反向对照：把 `theme_color` 在内存里改成 `#6d2b7a` → 上面那条判据**当场不成立**',
        `坏值 ${negMf22.theme_color} → 判据值 ${negMf22.background_color === '#E8EBF2' && negMf22.theme_color === '#E8EBF2'}`,
      )
      check(
        mf22.name === '树高教务通' && mf22.short_name === '树高教务通',
        'S22 ③：manifest 的 `name` 与 `short_name` 都是新名（`short_name` 原来是「树高教师」那个短形态，最容易漏）',
        `name=${mf22.name} · short_name=${mf22.short_name}`,
      )

      /* ---------- ④ PWA 图标：文件都在、真实像素对得上、manifest 引用落得到文件上 ---------- */
      const ICON22 = [
        'favicon.ico',
        'favicon.svg',
        'icons/icon-16.png',
        'icons/icon-32.png',
        'icons/icon-48.png',
        'icons/icon-128.png',
        'icons/icon-192.png',
        'icons/icon-256.png',
        'icons/icon-512.png',
        'icons/icon-maskable-192.png',
        'icons/icon-maskable-512.png',
        'icons/apple-touch-icon-180.png',
      ]
      const missIcons22 = ICON22.filter((f) => !existsSync(join(PUB22, f)))
      check(
        missIcons22.length === 0,
        `S22 ④：PWA 图标清单齐全 —— ${ICON22.length} 个文件都在（favicon.ico 多帧 + 7 档位图 + 2 个 maskable + apple-touch）`,
        missIcons22.length ? `缺 ${missIcons22.join('、')}` : `${ICON22.length} 个都在 app/public/ 下`,
      )
      /** 只读 PNG 的 IHDR 拿真实尺寸（不引第三方解码器） */
      const pngSize22 = (p) => {
        const b = readFileSync(join(PUB22, p))
        return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
      }
      const badSize22 = ICON22.filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, want: f.match(/(\d+)\.png$/)[1], got: pngSize22(f) }))
        .filter((x) => `${x.want}x${x.want}` !== x.got)
      check(
        badSize22.length === 0,
        'S22 ④：每一个 PNG 图标的**真实像素**都与文件名那一档相符（不是"改了个名"）',
        badSize22.length
          ? badSize22.map((x) => `${x.f} 实际 ${x.got}`).join('、')
          : `${ICON22.filter((f) => f.endsWith('.png')).length} 个 PNG 逐个相符`,
      )
      const mfSrc22 = (mf22.icons ?? []).map((i) => i.src.replace(/^\//, ''))
      const mfSrcMiss22 = mfSrc22.filter((s) => !existsSync(join(PUB22, s)))
      check(
        mfSrc22.length >= 5 && mfSrcMiss22.length === 0,
        'S22 ④：manifest 的 `icons` **逐个都落得到文件上**，而且不再是"只有一条 `image/svg+xml`"（Android 因此才有图标）',
        mfSrcMiss22.length
          ? `引用了不存在的 ${mfSrcMiss22.join('、')}`
          : `${mfSrc22.length} 条：${mfSrc22.join('、')}`,
      )
      check(
        (mf22.icons ?? []).some((i) => i.purpose === 'maskable' && /192x192/.test(i.sizes)) &&
          (mf22.icons ?? []).some((i) => i.purpose === 'maskable' && /512x512/.test(i.sizes)),
        'S22 ④：manifest 里有 192 / 512 两条 `purpose: maskable`（Android 自适应图标）',
        (mf22.icons ?? [])
          .filter((i) => i.purpose === 'maskable')
          .map((i) => i.sizes)
          .join(' · ') || '一条都没有',
      )
      const negMfSrc22 = mfSrc22.map((s) => (s === 'icons/icon-192.png' ? 'icons/icon-192x.png' : s))
      check(
        negMfSrc22.filter((s) => !existsSync(join(PUB22, s))).length === 1,
        '🧪 S22 ④ 反向对照：把 manifest 里 `icons/icon-192.png` 在内存里改坏一个字母 → "引用落得到文件上"那条**当场判假**',
        `改后落空的：${negMfSrc22.filter((s) => !existsSync(join(PUB22, s))).join('、')}`,
      )
      const html22 = readFileSync(join(HERE, '..', 'index.html'), 'utf8')
      check(
        /rel="icon"[^>]*favicon\.ico/.test(html22) &&
          /rel="apple-touch-icon"[^>]*apple-touch-icon-180\.png/.test(html22),
        'S22 ④：`index.html` 的 `<head>` 补齐了 `favicon.ico` 与 `apple-touch-icon`（iOS 加主屏不再是白图）',
        (html22.match(/<link rel="(icon|apple-touch-icon)"[^>]*>/g) ?? []).join(' '),
      )

      /* ---------- ④-b 🔴 2026-10-11「全徽」轮：**图标那几档也不再是纯徽** ----------
       * 为什么期望值变了：用户看了「我的身份」那张卡 + **Windows 任务栏的图标**（那是
       * `favicon.ico` 的 16 / 32 两帧）后说「把所有这种**纯徽标**全部换成**全徽标**」。
       * 改之前：`icon-16.png` / `icon-32.png` / `.ico` 的 16+32 两帧 / `favicon.svg` 内嵌的是
       * **纯徽**（`落地清单.md` §11.1 的结论：16px 全徽外圈线只有 0.33px、校名 2.0px 高，
       * "像加载中"）。现在是**全徽**，所以下面这几条判据**整个反过来了**。
       * ⚠️ 下面拿"仓库里那张图"与"`徽标方案\assets\全徽-N.png`"逐像素比 —— 8 张 PNG 里
       * 16 / 32 那两张**只差在"用哪一档素材"**，逐像素比是唯一能把它钉死的判据（比文件大小稳）。
       */
      const ASSETS22 = 'C:\\Users\\Administrator\\Desktop\\徽标方案\\assets'
      const rawPx22 = (p) => {
        const b = readFileSync(p)
        return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), idat: b.subarray(41, b.length - 12) }
      }
      const cmp22 = (repoRel, assetName) => {
        const repo = rawPx22(join(PUB22, repoRel))
        const src = rawPx22(join(ASSETS22, assetName))
        return (
          repo.w === src.w &&
          repo.h === src.h &&
          repo.idat.length === src.idat.length &&
          repo.idat.equals(src.idat)
        )
      }
      const pairs22 = [
        ['icons/icon-16.png', '全徽-16.png'],
        ['icons/icon-32.png', '全徽-32.png'],
        ['icons/icon-48.png', '全徽-48.png'],
        ['icons/icon-128.png', '全徽-128.png'],
      ]
      const badPair22 = pairs22.filter(([r, a]) => !cmp22(r, a))
      check(
        badPair22.length === 0,
        'S22 ④-b：站点图标 16 / 32 / 48 / 128 四档**逐像素都是从「全徽-N.png」那条流水线出来的**（16 与 32 原来是纯徽；⚠️ 16px 全徽实测外圈线只有 0.33px）',
        badPair22.length
          ? badPair22.map(([r, a]) => `${r} ≠ ${a}`).join('、')
          : pairs22.map(([r]) => r).join('、') + ' 四档都对得上',
      )
      /* 反向对照：拿**纯徽**那几张素材去比 → 必须当场判假（证明这个比对真的分得出两档） */
      const purePairs22 = [
        ['icons/icon-16.png', '纯徽-16.png'],
        ['icons/icon-32.png', '纯徽-32.png'],
      ].filter(([r, a]) => existsSync(join(ASSETS22, a)) && cmp22(r, a))
      check(
        purePairs22.length === 0,
        '🧪 S22 ④-b 反向对照：拿 `assets\\纯徽-16.png` / `纯徽-32.png` 去比那两张 → 一条都对不上（比对真分得出"全徽 / 纯徽"两档，不是恒真）',
        purePairs22.length ? `竟然对上了：${purePairs22.map(([r]) => r).join('、')}` : '纯徽那两张一条都对不上',
      )
      /* `favicon.ico`：三帧都是**全徽**（原来 16 / 32 两帧是纯徽）。
         判据 = 逐帧与 assets 的全徽素材逐像素比 —— 只数帧数是钉不住的。 */
      const ico22 = readFileSync(join(PUB22, 'favicon.ico'))
      const nIco22 = ico22.readUInt16LE(4)
      const icoFrames22 = []
      for (let i = 0; i < nIco22; i++) {
        const e = ico22.subarray(6 + 16 * i, 6 + 16 * (i + 1))
        const w = e[0] === 0 ? 256 : e[0]
        const off = e.readUInt32LE(12)
        const len = e.readUInt32LE(8)
        icoFrames22.push({ w, idat: ico22.subarray(off + 41, off + len - 12) })
      }
      const badIco22 = icoFrames22.filter((f) => {
        const src = rawPx22(join(ASSETS22, `全徽-${f.w}.png`))
        return f.idat.length !== src.idat.length || !f.idat.equals(src.idat)
      })
      check(
        icoFrames22.length === 3 &&
          icoFrames22.map((f) => f.w).join('/') === '16/32/48' &&
          badIco22.length === 0,
        'S22 ④-b：`favicon.ico` 三帧 16/32/48 **每一帧都是全徽**、逐像素与 `assets\\全徽-N.png` 对得上（Windows 任务栏用的正是这个文件）',
        badIco22.length
          ? `对不上的帧：${badIco22.map((f) => f.w).join('、')}`
          : icoFrames22.map((f) => `${f.w}px`).join(' · '),
      )
      const svgFull22 = readFileSync(join(ASSETS22, '全徽-128.png')).toString('base64')
      const svgTxt22 = readFileSync(join(PUB22, 'favicon.svg'), 'utf8')
      check(
        svgTxt22.includes(svgFull22),
        'S22 ④-b：`favicon.svg` 内嵌的是 **128px 全徽**（原来内嵌的是裁掉校名环那一档）—— 判据是"base64 与 `assets\\全徽-128.png` 逐字节相同"，不是"文件里有没有某个词"',
        `内嵌全徽-128 的 base64 = ${svgTxt22.includes(svgFull22) ? '一致' : '不一致'}`,
      )

      /* ---------- ⑤ 校徽：四套主题下都在 / 暗色提亮 / 亮色不提亮 / 无盘 / 无框线 ----------
       * 探针量的是 `[data-emblem]`（`Emblem.tsx` 那一层）**页面自己算出来的**值，
       * 不是把期望值抄进断言。四套并排本身就是一组对照：亮色那两条必须是 `none`。
       */
      const BOOST22 = { light: 'none', dark: 'brightness(1.7)' }
      const readEmblem22 = (p) =>
        p.evaluate(() => {
          const list = []
          for (const host of document.querySelectorAll('[data-emblem]')) {
            const hcs = getComputedStyle(host)
            const img = host.querySelector('img')
            list.push({
              n: Number(host.getAttribute('data-emblem')),
              hostFilter: hcs.filter,
              hostW: Math.round(parseFloat(hcs.width) * 100) / 100,
              hostBgImage: hcs.backgroundImage,
              hostShadow: hcs.boxShadow,
              hostBorder: `${hcs.borderTopWidth} ${hcs.borderTopStyle}`,
              /* 徽所在那一行的高度（左栏标题行 / 移动顶栏 / 登录卡那一格）——
                 徽从 34px 盒换成 46px 盒时，这一行只差 2px 就会把 `TEACHER CONSOLE` 挤成两行
                 （实测 40 → 63.3px），所以它要能被判红。 */
              rowH: Math.round(host.parentElement.getBoundingClientRect().height * 10) / 10,
              enH: host.nextElementSibling?.children?.[1]
                ? Math.round(host.nextElementSibling.children[1].getBoundingClientRect().height * 10) / 10
                : null,
              imgW: img ? getComputedStyle(img).width : null,
              natural: img ? img.naturalWidth : 0,
              complete: img ? img.complete : false,
              src: img ? img.getAttribute('src') : null,
              srcset: img ? img.getAttribute('srcset') : null,
            })
          }
          return {
            boost: getComputedStyle(document.documentElement).getPropertyValue('--emblem-boost').trim(),
            list,
          }
        })
      const COMBOS22 = [
        { label: '亮·蓝', theme: null, accent: null, dark: false },
        { label: '亮·紫', theme: null, accent: 'purple', dark: false },
        { label: '暗·蓝', theme: 'dark', accent: null, dark: true },
        { label: '暗·紫', theme: 'dark', accent: 'purple', dark: true },
      ]
      for (const cb of COMBOS22) {
        const c = await browser.newContext({
          viewport: { width: 1440, height: 940 },
          locale: 'zh-CN',
          colorScheme: cb.dark ? 'dark' : 'light',
        })
        await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await c.addInitScript(
          ({ st, p }) => {
            window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
            window.localStorage.setItem('shugao.deviceRole', 'teacher')
            if (p.theme) window.localStorage.setItem('shugao.theme', p.theme)
            if (p.accent) window.localStorage.setItem('shugao.accent', p.accent)
          },
          { st: TEACHER_STATE, p: { theme: cb.theme, accent: cb.accent } },
        )
        for (const path22 of ['/', '/login']) {
          const want22 = cb.dark ? BOOST22.dark : BOOST22.light
          const p = await c.newPage()
          await p.goto(`${BASE}${path22}`, { waitUntil: 'networkidle' })
          await p.waitForTimeout(400)
          const pr = await readEmblem22(p)
          const bad22 = pr.list.filter(
            (e) =>
              !e.complete ||
              e.natural === 0 ||
              e.hostFilter !== want22 ||
              Math.abs(e.hostW - e.n / 0.87) > 0.6 ||
              e.hostBgImage !== 'none' ||
              e.hostShadow !== 'none' ||
              !/^0px /.test(e.hostBorder) ||
              /* 左栏那一行（40px 那一处）**不许被徽撑成两行**：46 的盒 + 10 的间距会把
                 `TEACHER CONSOLE` 断成 "TEACHER / CONSOLE"（行高 40 → 63.3）。
                 实测口径：一行时行高 46（= 盒），断了就是 63.3 —— 门槛取 52。 */
              (e.n === 40 && e.rowH > 52),
          )
          check(
            pr.list.length > 0 && bad22.length === 0 && pr.boost === want22,
            `S22 ⑤ 校徽「${cb.label}」${path22}：徽都在（真图元）= 提亮 \`${want22}\` = 无盘 = 无框线 = 盒子 = 徽 / 0.87 = 左栏那一行没被撑成两行`,
            pr.list.length
              ? `${pr.list.map((e) => `${e.n}px→盒${e.hostW}(图${e.imgW},天然${e.natural},行高${e.rowH})`).join('；')} filter=${pr.list[0].hostFilter} · --emblem-boost=${pr.boost}`
              : '这一页一个 `[data-emblem]` 都没有',
          )
          const ns22 = pr.list.map((e) => e.n).sort((a, b) => a - b)
          /* ⚠️ 这一节探的是 `/` 与 `/login` 两个路由 —— 「我的身份」卡那颗 24px 校徽在
             `/settings` 上，**不在这一节**（它在 S24 里逐条钉）。2026-10-11 第一次改这里时
             把 24 加进 `/` 的期望值，实测红——原因是"改错了期望值"，不是"漏了徽"。
             左栏 40 · 移动顶栏 32 · 登录卡 48 三档一个字没动。
             ⚠️ 2026-10-11「全徽」轮：那三档**本来就是全徽**，所以这一节**一个字都没改** ——
             改的只有 S24（24px 从纯徽换成全徽）与 `public/icons/**` + `favicon.*` 那几张静态图。 */
          const wantNs22 = path22 === '/' ? [32, 40] : [48]
          check(
            JSON.stringify(ns22) === JSON.stringify(wantNs22),
            `S22 ⑤ 校徽「${cb.label}」${path22}：尺寸档对得上（${wantNs22.join(' / ')}px，左栏 40 · 移动顶栏 32 · 登录卡 48）`,
            `实际 ${ns22.join(' / ')}px`,
          )
        }
        await c.close()
      }

      /* 🧪 ⑤ 的两条反向对照（同一次运行里真跑）：
       *   A. 注入 `--emblem-boost: brightness(2.4)` + 一圈 `border` → 提亮那条与"无框线"那条**必须**都不成立；
       *   B. 把 `src` 指到一张不存在的图 → "徽都在（真图元）"那条**必须**不成立。
       */
      {
        const c = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'zh-CN' })
        await c.addInitScript((st) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
          window.localStorage.setItem('shugao.theme', 'dark')
        }, TEACHER_STATE)
        const p = await c.newPage()
        await p.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await p.addStyleTag({
          content:
            ':root{--emblem-boost:brightness(2.4)!important}[data-emblem]{border:1px solid red!important}',
        })
        await p.waitForTimeout(200)
        const negA = await readEmblem22(p)
        check(
          negA.list.length > 0 &&
            negA.list.every((e) => e.hostFilter !== BOOST22.dark && !/^0px /.test(e.hostBorder)),
          '🧪 S22 ⑤ 反向对照 A：注入 `--emblem-boost: brightness(2.4)` + 一圈 `border` → 同一个探针**当场读到坏值**（提亮那条与"无框线"那条都不成立）',
          negA.list.map((e) => `filter=${e.hostFilter} border=${e.hostBorder}`).join('；'),
        )
        await p.evaluate(() => {
          /* ⚠️ 必须**连 `srcset` 一起摘掉**：`<img>` 上两档都在（1x / 2x），
             只改 `src` 的话浏览器会从 `srcset` 重新挑回那一张真图 —— 天然宽度照样是 40/32，
             这个对照就成了"怎么都不会红"的假对照（第一版就是这么写的，实测没红）。 */
          for (const i of document.querySelectorAll('[data-emblem] img')) {
            i.removeAttribute('srcset')
            i.src = '/emblem/nope-does-not-exist.png'
          }
        })
        await p.waitForTimeout(500)
        const negB = await readEmblem22(p)
        check(
          negB.list.length > 0 && negB.list.every((e) => e.natural === 0),
          '🧪 S22 ⑤ 反向对照 B：把 `srcset` + `src` 一起指到一张不存在的图 → "徽都在（真图元）"那条**当场不成立**（证明它不是恒真）',
          negB.list.map((e) => `src=${e.src} 天然宽=${e.natural}`).join('；'),
        )
        await c.close()
      }
    })

    /*
     * ================= S23：星光 / StatusMark / `.live-dot`（2026-10-11 微交互轮） =================
     *
     * 这一节**不截图**：钉的是三个"动的东西"到底动没动、颜色跟不跟强调色、降级对不对。
     * 每条都带 🧪 反向对照（同一个探针喂坏值 → 必须当场判假），做法照 `AGENTS.md` 三·2。
     *
     * ⚠️ 四套主题在**同一个页面里**由 `documentElement` 上的 `data-theme` / `data-accent`
     *    切出来（与 F6-H 同一套做法），切完**立刻在同一个 evaluate 里读** computed 值 ——
     *    这样"读到的就是刚设的那一套"，不依赖 localStorage 与重载。
     */
    await step('S23：星光 / StatusMark / live-dot（微交互）', async () => {
      const mkCtx23 = async (extra = {}) => {
        const c = await browser.newContext({
          viewport: { width: 1440, height: 940 },
          locale: 'zh-CN',
          ...extra,
        })
        await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await c.addInitScript((st) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        return c
      }

      /* ---------------- ① 星光：只暗色出现 + 发光色跟强调色（四套逐套量） ----------------
       * 值**从 CSSOM 读**（`getPropertyValue('--color-accent')`），不把十六进制抄进断言 ——
       * 那样"跟强调色"才是真判据，而不是"跟我在断言里抄的那个值"。
       */
      {
        const c = await mkCtx23()
        for (const [path23, who23] of [
          ['/login', '登录页「进入平台」'],
          ['/assignments/a-demo-2/collect', '收缴页「保存登记」'],
        ]) {
          const p = await c.newPage()
          p.on('pageerror', (e) => errors.push(`PAGEERROR(S23:${who23}) :: ${e.message}`))
          await p.goto(`${BASE}${path23}`, { waitUntil: 'networkidle' })
          await p.waitForTimeout(400)
          const r23 = await p.evaluate(() => {
            const de = document.documentElement
            /* hex → `rgb(r, g, b)`：CSSOM 把 `#5386f4` 解析成 RGB 写进 gradient 里，
               两边要用**同一种写法**比（拿 hex 去 includes 是恒假 —— 第一次就栽在这儿）。 */
            const toRgb = (v) => {
              const mm = v.trim().match(/^#([0-9a-f]{6})$/i)
              if (!mm) return v.trim()
              const n = parseInt(mm[1], 16)
              return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
            }
            const rows = []
            for (const [th, ac] of [
              [null, null],
              ['dark', null],
              [null, 'purple'],
              ['dark', 'purple'],
            ]) {
              if (th) de.setAttribute('data-theme', th)
              else de.removeAttribute('data-theme')
              if (ac) de.setAttribute('data-accent', ac)
              else de.removeAttribute('data-accent')
              const label = th === 'dark' ? (ac === 'purple' ? '暗紫' : '暗蓝') : ac === 'purple' ? '亮紫' : '亮蓝'
              const accent = getComputedStyle(de).getPropertyValue('--color-accent').trim()
              /* 落点用**显式钩子**找（`data-nav` / `data-collect-save`），不用 `.sb` 这个类名 ——
                 类名会被任何一处复制粘贴带出来，钩子是"这一处就是这一处"。
                 ⚠️ 钩子就挂在 `.sb` **它自己**身上（`StarBorder` 的 `...rest`）→ 用 `.sb[data-nav]`
                 这种**同一元素**的写法；写成后代选择器 `[data-nav] .sb` 会恒空（第一次就是这么红的）。 */
              const stars = [...document.querySelectorAll('.sb[data-nav], .sb[data-collect-save]')]
              rows.push({
                label,
                accent,
                accentRgb: toRgb(accent),
                stars: stars.length,
                glows: stars.reduce((n, s) => n + s.querySelectorAll(':scope > .sb-glow').length, 0),
                display: [...document.querySelectorAll('.sb > .sb-glow')].map((g) => getComputedStyle(g).display),
                image: [...document.querySelectorAll('.sb > .sb-glow')].map((g) => getComputedStyle(g).backgroundImage),
                /* 光片就压在按钮下面那 3~4px 的 padding 带上（不在实心 accent 底上）——
                   这条是"能看见"的结构前提，前两轮踩过"同色压同色"。 */
                bottom: [...document.querySelectorAll('.sb > .sb-glow-b')].map((g) => getComputedStyle(g).bottom),
              })
            }
            return rows
          })
          const light23 = r23.filter((r) => r.label.startsWith('亮'))
          const dark23 = r23.filter((r) => r.label.startsWith('暗'))
          check(
            r23.every((r) => r.stars === 1 && r.glows === 2),
            `S23 ① 星光「${who23}」：这一屏有且只有 **1 颗星光**（只出现在用户拍板的那两处落点）、每颗 **2 片光**（下沿 + 上沿）—— 稀缺才有效，超过 3 处就退化成装饰`,
            r23.map((r) => `${r.label} ${r.stars} 颗 / ${r.glows} 片`).join(' · '),
          )
          check(
            light23.length === 2 && light23.every((r) => r.display.length === 2 && r.display.every((d) => d === 'none')),
            `🔴 S23 ① 星光「${who23}」：**只暗色出现** —— 亮蓝 / 亮紫两套下 \`display: none\``,
            light23.map((r) => `${r.label} ${r.display.join('/') || '（没有 .sb-glow）'}`).join(' · '),
          )
          check(
            dark23.length === 2 && dark23.every((r) => r.display.length === 2 && r.display.every((d) => d !== 'none')),
            `S23 ① 星光「${who23}」：暗色两套下光片是**画出来的**（不是 \`display:none\`）`,
            dark23.map((r) => `${r.label} ${r.display.join('/')}`).join(' · '),
          )
          /* 🔴 发光色**跟强调色**：从 CSSOM 取当前那套的 `--color-accent`，逐套比对 */
          const accentOK23 = dark23.every((r) => r.image.length === 2 && r.image.every((s) => s.includes(r.accentRgb)))
          const seen23 = new Set(r23.map((r) => r.accent.toLowerCase()))
          check(
            accentOK23 && seen23.size === 4 && !seen23.has('#ffffff'),
            `🔴 S23 ① 星光「${who23}」：发光色 = **当前那套的** \`var(--color-accent)\`（写死白色的原版写法会当场判假）`,
            `四套 accent = ${[...seen23].join(' / ')} · ${dark23.map((r) => r.label + '→' + r.image[0]).join(' · ')}`,            '反向对照：把 `.sb-glow` 的 background 改回 `radial-gradient(circle,#fff,transparent 10%)` → 这一条必红',
          )
          check(
            dark23.every((r) => r.bottom.length === 1 && parseFloat(r.bottom[0]) < 0 && parseFloat(r.bottom[0]) > -12),
            `S23 ① 星光「${who23}」：光片贴着按钮底沿（\`bottom\` 在 −12px ~ 0 之间）—— 压在 padding 带上，不是压在实心 accent 底上`,
            dark23.map((r) => `${r.label} bottom=${r.bottom[0]}`).join(' · '),
          )
        }
        await c.close()
      }

          /* ---------------- ② StatusMark：圆心漂移 0.000px / transform 只 1 种取值 ----------------
       * 探针里用**虚拟 rAF 垫片**把 24 帧一次跑完（`getBoundingClientRect().x` 在同步循环里
       * 不会重新布局，所以用几何算屏幕坐标）。判据是**屏幕坐标的圆心**，不是"仿射不动点"
       * —— 上一轮那个不动点判据对 A / C 都给 0，挂错图层它看不出来（`说明.md` §1.3 bug③）。
       *
       * ⚠️ 两个"第一次写就踩了"的点（写在这里免得下一个人再踩）：
       *   ① **必须用页面自己那份 React**（`/node_modules/.vite/deps/react.js?v=<hash>`）。
       *      再 import 一个不带 `?v=` 的会拿到另一份实例 → `createRoot` 渲染时 Invalid hook call。
       *      ⚠️ `?v=` **不能从 `performance.getEntriesByType('resource')` 读** —— 这个脚本
       *      装了假时钟（`ctx.clock.install()`），在假时钟下那条路径**读出来是空的**
       *      （第一次就是栽在这儿：探针报"读不到 Vite 的 dep hash"）。
       *      正解：**去拿应用自己那个入口的 URL** —— `main.tsx` 在浏览器里显示的 `src`
       *      已经是 Vite 解析**带 `?v=`** 的完整地址（应用自己就是这么加载的）。
       *   ② **先垫 rAF 再 render**：组件那个 effect 只在依赖变化时跑一次，
       *      render 完再垫就拦不到它那一发（第一次读到 0 帧）。
       */
      {
        const c = await mkCtx23()
        const p = await c.newPage()
        p.on('pageerror', (e) => errors.push(`PAGEERROR(S23:drift) :: ${e.message}`))
        await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
        await p.waitForTimeout(400)
        /** 这两个页面里每次注入的探针体（渲染一个真 StatusMark、虚拟 rAF 跑 24 帧） */
        const SM_PROBE = async (bad) => {
          const entry = [...document.querySelectorAll('script[type=module]')]
            .map((s) => s.src)
            .find((u) => /\/src\/main\.tsx/.test(u))
          const entrySrc = entry || '/src/main.tsx'
          const mainSrc = await (await fetch(entrySrc, { cache: 'no-cache' })).text()
          const depUrls = [
            ...mainSrc.matchAll(
              /["'](\/node_modules\/\.vite\/deps\/([A-Za-z0-9_@.-]+)\.js\?v=[0-9a-f]+)["']/g,
            ),
          ]
          /* 🔴 每个依赖各有自己的 `?v=`：按文件名取（理由见「撤下图标 + 开学准备 · 六步脊」那一节） */
          const depUrl = (file) => depUrls.find((m) => m[2] === file)?.[1] ?? null
          const reactUrl = depUrl('react')
          const rdcUrl = depUrl('react-dom_client')
          if (!reactUrl || !rdcUrl) {
            return { why: `入口 ${entrySrc} 里读不到依赖 URL（react=${reactUrl} / react-dom_client=${rdcUrl}）` }
          }
          const rmod = await import(reactUrl)
          const rdc = await import(rdcUrl)
          /* ⚠️ 动态 import 这两个 prebundle 拿到的是 **CJS interop** 形状：具名导出挂在
             模块对象的 `.default` 上（`{default: {createElement, …}}`），**不是**顶层具名导出。
             （直接从 `/src/*.tsx` 静态 import 时才拿到顶层具名 —— 两回事，别照抄。） */
          const createElement = rmod.createElement ?? rmod.default?.createElement
          const createRoot = rdc.createRoot ?? rdc.default?.createRoot
          const mod = await import('/src/components/StatusMark.tsx')
          const StatusMark = mod.StatusMark ?? mod.default
          if (!createElement || !createRoot || !StatusMark) return { why: 'React / StatusMark 没加载上' }

          const host = document.createElement('div')
          host.style.position = 'fixed'
          host.style.left = '0'
          host.style.top = '0'
          host.style.zIndex = '-1'
          document.body.appendChild(host)
          let st = null
          if (bad === 'cssRotate') {
            /* 🧪 反向对照 = **前两版那个写法**：旋转挂回 CSS 的 `@keyframes`
               （属性上那条静态 `rotate(-90 12 12)` 仍在）。 */
            st = document.createElement('style')
            st.textContent =
              '@keyframes _smSpinProbe{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
              '.status-mark__ring{transform-box:fill-box;transform-origin:center;animation:_smSpinProbe 1100ms linear infinite}'
            document.head.appendChild(st)
          }

          /* 🔴 先垫 rAF，再 render（见文件头那段说明） */
          const realRAF = window.requestAnimationFrame
          const realCAF = window.cancelAnimationFrame
          const queue = []
          window.requestAnimationFrame = (cb) => {
            queue.push(cb)
            return queue.length
          }
          window.cancelAnimationFrame = () => {}
          const root = createRoot(host)
          root.render(createElement(StatusMark, { status: 'running', size: 20, label: '正在识别' }))
          await new Promise((r) => setTimeout(r, 60))

          const svg = host.querySelector('svg')
          const ring = host.querySelector('.status-mark__ring')
          const finish = (out) => {
            window.requestAnimationFrame = realRAF
            window.cancelAnimationFrame = realCAF
            root.unmount()
            host.remove()
            if (st) st.remove()
            return out
          }
          if (!svg || !ring) return finish({ why: '没渲染出来（.status-mark__ring 找不到）' })
          const spinAnim = bad === 'cssRotate' ? (ring.getAnimations()[0] ?? null) : null

          const rect = svg.getBoundingClientRect()
          const k = rect.width / 24 // 屏幕 px / viewBox 单位
          const r = +ring.getAttribute('r')
          /* 🔴 圆心用 **computed 矩阵**反解出来的角度算（不是属性上那个静态 −90）：
             属性那条是"JSX 上写死的静态属性"，computed 那条才是"屏幕上真正转了多少"。
             静态写法下两个角度恒等 → 圆心恒在 (12,12)；一旦有人把 rotate 挂回 CSS，
             computed 角度就每帧都在变 → 圆心会离开 (12,12)（判据能红的机制就是这个）。 */
          const angleOf = (el) => {
            const t = getComputedStyle(el).transform
            const m = t.startsWith('matrix') ? t.slice(t.indexOf('(') + 1, -1).split(',').map(Number) : null
            return m ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : 0
          }
          const samples = []
          let guard = 0
          while (queue.length && guard++ < 40) {
            const cb = queue.shift()
            cb(performance.now() + guard * (1000 / 60))
            /* 反向对照里那条 CSS 旋转动画：虚拟 rAF 把动画时间线也冻住了，
               所以要**手工推**它的 currentTime（否则每帧 computed 矩阵一模一样）。 */
            if (spinAnim) spinAnim.currentTime = guard * (1100 / 24)
            const ang = angleOf(ring)
            samples.push({
              off: Math.round(+ring.getAttribute('stroke-dashoffset') * 1000) / 1000,
              attr: ring.getAttribute('transform'),
              tr: getComputedStyle(ring).transform,
              /* 屏幕坐标的圆心：cx/cy 就在 (12,12)，rotate 绕的就是它 → 它必须**一动不动** */
              x: rect.x + (12 + r * Math.cos((ang * Math.PI) / 180)) * k,
              y: rect.y + (12 + r * Math.sin((ang * Math.PI) / 180)) * k,
            })
            if (samples.length >= 24) break
          }
          const xs = samples.map((s) => s.x)
          const ys = samples.map((s) => s.y)
          const offs = samples.map((s) => s.off)
          let maxStep = 0
          for (let i = 1; i < samples.length; i++) {
            maxStep = Math.max(
              maxStep,
              Math.abs(samples[i].x - samples[i - 1].x),
              Math.abs(samples[i].y - samples[i - 1].y),
            )
          }
          return finish({
            frames: samples.length,
            driftX: Math.max(...xs) - Math.min(...xs),
            driftY: Math.max(...ys) - Math.min(...ys),
            maxStep,
            offMin: Math.min(...offs),
            offMax: Math.max(...offs),
            offDistinct: new Set(offs).size,
            trDistinct: new Set(samples.map((s) => s.tr)).size,
            attrDistinct: new Set(samples.map((s) => s.attr)).size,
            trSample: samples[0]?.tr ?? null,
          })
        }
        const drift23 = await p.evaluate(SM_PROBE, null)
        if (drift23.why) {
          check(false, 'S23 ② StatusMark：探针能注入一个正在跑的 StatusMark', drift23.why)
        } else {
          check(
            drift23.frames >= 20 && drift23.offDistinct > 5,
            'S23 ② StatusMark：弧**真的在跑**（虚拟 rAF 跑满帧、`stroke-dashoffset` 每帧都在变）—— 否则下面那两条是恒真的摆设',
            `${drift23.frames} 帧 · dashoffset ${drift23.offMin}→${drift23.offMax}（${drift23.offDistinct} 个取值）`,
          )
          check(
            drift23.trDistinct === 1 && drift23.attrDistinct === 1,
            '🔴 S23 ② StatusMark：**`transform` 只 1 种取值**（computed 与属性都是）—— `rotate(-90 12 12)` 是 JSX 上的静态属性，全程一个字都没被改',
            `${drift23.trDistinct} 种取值（逐字：${JSON.stringify(drift23.trSample)}）· 属性 ${drift23.attrDistinct} 种`,
          )
          check(
            drift23.driftX < 0.01 && drift23.driftY < 0.01 && drift23.maxStep < 0.01,
            '🔴 S23 ② StatusMark：**屏幕坐标圆心漂移 = 0.000px**（含逐帧最大位移）—— 判据是屏幕坐标，不是"仿射不动点"',
            `漂移 x=${drift23.driftX.toFixed(3)}px / y=${drift23.driftY.toFixed(3)}px · 逐帧最大 ${drift23.maxStep.toFixed(3)}px`,
          )
          /* 🧪 反向对照：把 `rotate` 挂回 CSS（前两版那个写法）→ 同一个探针必须读到圆心在漂 */
          const neg23 = await p.evaluate(SM_PROBE, 'cssRotate')
          check(
            !neg23.why && neg23.trDistinct > 1 && (Math.abs(neg23.driftX) > 0.5 || Math.abs(neg23.driftY) > 0.5),
            '🧪 S23 ② 反向对照：把 `rotate` 挂回 **CSS**（前两版那个写法）→ 同一个探针**当场读到 transform 多种取值 + 圆心漂移**（证明它不是恒真的摆设）',
            neg23.why
              ? neg23.why
              : `transform ${neg23.trDistinct} 种取值 · 圆心漂了 x=${neg23.driftX.toFixed(2)}px / y=${neg23.driftY.toFixed(2)}px`,
          )
        }
        await c.close()
      }

      /* ---------------- ③ reduced-motion：StatusMark 停在正上方 + `.live-dot` 真的在动 ----------------
       * 这一节在**真的开了系统级 reduced-motion** 的 context 里跑（`reducedMotion: 'reduce'`），
       * 不是注入 class。
       */
      {
        const c = await mkCtx23({ reducedMotion: 'reduce' })
        const p = await c.newPage()
        p.on('pageerror', (e) => errors.push(`PAGEERROR(S23:rm) :: ${e.message}`))
        await p.goto(`${BASE}/classes/c-3/import/photo`, { waitUntil: 'networkidle' })
        await p.waitForTimeout(400)
        const rm23 = await p.evaluate(async () => {
          const mq = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          /* ① StatusMark：虚拟 rAF 垫片 —— 降级时组件**根本不该启动循环** */
          const host = document.createElement('div')
          host.setAttribute('data-sm-probe-rm', '')
          document.body.appendChild(host)
          const realRAF = window.requestAnimationFrame
          let rafCalls = 0
          window.requestAnimationFrame = (cb) => {
            rafCalls++
            return realRAF(cb)
          }
          const entry = [...document.querySelectorAll('script[type=module]')]
            .map((s) => s.src)
            .find((u) => /\/src\/main\.tsx/.test(u))
          const entrySrc = entry || '/src/main.tsx'
          const mainSrc = await (await fetch(entrySrc, { cache: 'no-cache' })).text()
          const depUrls = [
            ...mainSrc.matchAll(
              /["'](\/node_modules\/\.vite\/deps\/([A-Za-z0-9_@.-]+)\.js\?v=[0-9a-f]+)["']/g,
            ),
          ]
          /* 🔴 每个依赖各有自己的 `?v=`：按文件名取（理由见「撤下图标 + 开学准备 · 六步脊」那一节） */
          const depUrl = (file) => depUrls.find((m) => m[2] === file)?.[1] ?? null
          const reactUrl = depUrl('react')
          const rdcUrl = depUrl('react-dom_client')
          if (!reactUrl || !rdcUrl) {
            return { why: `入口 ${entrySrc} 里读不到依赖 URL（react=${reactUrl} / react-dom_client=${rdcUrl}）` }
          }
          const rdc = await import(rdcUrl)
          const rmod = await import(reactUrl)
          /* ⚠️ 动态 import 这两个 prebundle 拿到的是 **CJS interop** 形状：具名导出挂在
             模块对象的 `.default` 上（`{default: {createRoot, …}}`），不是顶层具名导出。 */
          const createRoot = rdc.createRoot ?? rdc.default?.createRoot
          const createElement = rmod.createElement ?? rmod.default?.createElement
          const mod = await import('/src/components/StatusMark.tsx')
          const StatusMark = mod.StatusMark ?? mod.default
          if (!createRoot || !createElement || !StatusMark) return { why: 'React / StatusMark 没加载上（reduced-motion）' }
          const root = createRoot(host)
          root.render(createElement(StatusMark, { status: 'running', size: 20, label: '正在识别' }))
          await new Promise((r) => setTimeout(r, 120))
          const ring = host.querySelector('.status-mark__ring')
          const off = ring ? ring.getAttribute('stroke-dashoffset') : null
          const ringAnim = ring ? getComputedStyle(ring).animationName : null
          const ringDur = ring ? getComputedStyle(ring).animationDuration : null
          const ringIter = ring ? getComputedStyle(ring).animationIterationCount : null
          const strike = host.querySelector('.status-mark__strike')
          root.unmount()
          host.remove()
          window.requestAnimationFrame = realRAF
          return {
            mq,
            rafCalls,
            off,
            ringAnim,
            ringDur,
            ringIter,
            strikeScale: strike ? getComputedStyle(strike).transform : null,
            /* ⚠️ 不硬比 `matrix(1…`：这条删除线是 `position:absolute` 的零高元素，
               实测读到 `""`（浏览器对零尺寸元素不给计算值）—— 所以判据是
               "**不是** `scaleX(0)` 那条初始值"，而不是"等于某个具体矩阵"。 */
            strike: !!strike,
            strikeZero: strike ? /^matrix\(0[,\s]/.test(getComputedStyle(strike).transform) : null,
          }
        })
        check(
          rm23.mq && rm23.off === '0',
          '🔴 S23 ③ reduced-motion：StatusMark 的弧停在**正上方**（`dashoffset = 0`，不是某个随机相位）—— 原版那条 `travel.jump(0)`',
          `prefers-reduced-motion=${rm23.mq} · dashoffset=${rm23.off} · 这一段窗口内 rAF 调用 ${rm23.rafCalls} 次（页面自己还有别的循环，故不当判据）`,
          '反向对照：把 `travel.jump(0)` 删掉 → dashoffset 会停在别的相位，这一条必红',
        )
        check(
          rm23.ringAnim === 'sm-breathe' && rm23.ringIter === 'infinite' && parseFloat(rm23.ringDur) > 0.5,
          '🔴 S23 ③ reduced-motion：环挂的是 `sm-breathe`（**1400ms 且 `infinite`**）—— 平台那条全局 `animation-duration:.001ms !important` 没有把它压成"只播一帧"（`index.css` 里顶回来了）',
          `animation = ${rm23.ringAnim} ${rm23.ringDur} ${rm23.ringIter}`,
          '反向对照：把 `index.css` 里 `.status-mark[data-indeterminate] .status-mark__ring` 那条 `!important` 删掉 → 这里读到 0.001ms / 1，必红',
        )
        check(
          rm23.strike === true && rm23.strikeZero === false,
          'S23 ③ reduced-motion：删除线**在**，而且**不是**那条 `scaleX(0)` 的初始值（直接一条，不走 280ms 动画）',
          `元素在 = ${rm23.strike} · 读到 scaleX(0) = ${rm23.strikeZero} · transform = ${JSON.stringify(rm23.strikeScale)}`,
        )

        /* ② `.live-dot`（线上正坏的那个 bug）：先证明这个应用里真有它，再看它是不是真的在动 */
        const dots23 = await p.evaluate(() => document.querySelectorAll('.live-dot').length)
        check(
          dots23 > 0,
          'S23 ③ `.live-dot` 探针：这一屏（拍照录名单的"识别中"）真的用着 `.live-dot` —— 下面那条不是空跑',
          `${dots23} 个 .live-dot`,
        )
        const dot23 = await p.evaluate(async () => {
          /* 自己造一颗，不依赖"此刻正好停在哪一步" */
          const d = document.createElement('span')
          d.className = 'live-dot'
          d.setAttribute('data-dot-probe', '')
          document.body.appendChild(d)
          await new Promise((r) => setTimeout(r, 60))
          const cs = getComputedStyle(d)
          const anim = d.getAnimations()[0]
          const seen = []
          for (const t of [0, 425, 850]) {
            if (anim) anim.currentTime = t
            seen.push(getComputedStyle(d).opacity)
          }
          if (anim) anim.currentTime = 0
          const out = {
            name: cs.animationName,
            dur: cs.animationDuration,
            iter: cs.animationIterationCount,
            seen,
            distinct: new Set(seen).size,
          }
          d.remove()
          return out
        })
        check(
          dot23.name === 'pulse-dot' && dot23.iter === 'infinite' && parseFloat(dot23.dur) > 0.5 && dot23.distinct > 1,
          '🔴 S23 ③ `.live-dot` 真的在动（reduced-motion 下也不再被冻住）—— 修法是给它补同特异度的 `!important` 顶回全局兜底',
          `${dot23.name} ${dot23.dur} ${dot23.iter} · 三帧 opacity = ${dot23.seen.join('/')}（${dot23.distinct} 个取值）`,
          '反向对照：把 `index.css` 里 `.live-dot { animation: … !important }` 那条删掉 → 这里读到 0.001ms / 1 / 一个取值，必红',
        )
        const dotNeg23 = await p.evaluate(async () => {
          const d = document.createElement('span')
          d.className = 'live-dot'
          d.style.animation = 'none important'
          d.style.setProperty('animation', 'none', 'important')
          document.body.appendChild(d)
          await new Promise((r) => setTimeout(r, 60))
          const seen = []
          const anim = d.getAnimations()[0]
          if (anim) {
            for (const t of [0, 425, 850]) {
              anim.currentTime = t
              seen.push(getComputedStyle(d).opacity)
            }
          } else {
            seen.push(getComputedStyle(d).opacity, getComputedStyle(d).opacity, getComputedStyle(d).opacity)
          }
          const out = { anims: d.getAnimations().length, distinct: new Set(seen).size, seen }
          d.remove()
          return out
        })
        check(
          dotNeg23.distinct === 1,
          '🧪 S23 ③ 反向对照：把 `.live-dot` 的动画整个关掉 → **同一个读数当场退化成"一个取值"**（证明上面那条真的在量动画，不是恒真）',
          `动画数 ${dotNeg23.anims} · 三帧 opacity = ${dotNeg23.seen.join('/')}`,
        )
        await c.close()
      }
    })

    /*
     * ================= S25：StatusMark 终态 ×  1.0.0 发版（2026-09-27） =================
     *
     * 🔴 **这一节只做源码级断言**（用户明确要求：不做"真跑一遍看勾出现"的验收）。
     * 理由写清楚，免得后来的人以为是偷懒：那两条时序（`await recognize()` / 上传整库）
     * 一个要走服务端 OCR、一个要走真云端 —— 在本地演示模式里都走不到，
     * 而"勾有没有画出来"是 CSS 的事，S23 已经在真浏览器里量过（圆心漂移 0.000px）。
     * 这一节钉的是**接线**：两处落点到底会不会把 `done` / `failed` 传下去。
     *
     * ⚠️ 扫的是**去掉注释之后**的源码：注释里写满了 `'done'` / `'failed'` 这些词，
     *    不剔掉的话下面每一条都恒真（AGENTS.md 三·2「永远为绿的摆设」）。
     */
    await step('S25：StatusMark 终态接线 · 版本号与更新日志', async () => {
      const root25 = join(HERE, '..')
      const readSrc = (rel) => readFileSync(join(root25, rel), 'utf8').replace(/\r\n/g, '\n')
      /** 剔掉 `//` 与块注释（剩下的才是真代码） */
      const noComment = (s) =>
        s
          /* 先掐掉行尾注释：`//` 前面那半行的引号必须是偶数个（否则它只是字符串里的 `//`） */
          .replace(/(^|[^:'"`\w])\/\/[^\n]*/gm, '$1')
          .replace(/\/\*[\s\S]*?\*\//g, '')

      const markSrc = noComment(readSrc('src/components/StatusMark.tsx'))
      const importRaw = readSrc('src/pages/ImportPhoto.tsx')
      const importSrc = noComment(importRaw)
      const settingsSrc = noComment(readSrc('src/pages/Settings.tsx'))
      /*
       * 🔴 **期望值 2026-10-04 变了（只换锚点，判据一个字没放宽）**：
       *    「备份到云端」那一颗原来在「我的 → 备份与恢复」里，用户当天取舍后
       *    （「保留第一个和第四个按钮就好了」＋「至于全平台的备份，仅在超管面板里面留就好了」）
       *    它从那一屏撤下 —— 而**实现与 StatusMark 终态接线原样搬到了**
       *    `components/BackupExtraActions.tsx`（入口撤、实现留，超管面板那一路来接）。
       *    所以 ② / ③ 两条读这一份源码：判的是**同一段代码**，不是放宽。
       */
      const extraSrc = noComment(readSrc('src/components/BackupExtraActions.tsx'))
      const verSrc = noComment(readSrc('src/lib/version.ts'))
      const pkgRaw = readSrc('package.json')
      const pkg = JSON.parse(pkgRaw)
      /* 更新日志**不剔注释**：它整段就是数组字面量，没有注释可剔 */
      const logSrc = readSrc('src/lib/changelog.ts')

      /* ---------- ① 两个落点各自传了哪几档 ---------- */
      /**
       * 从一个 `<StatusMark …>` 的开标签里取出：每个 prop 名 → 实参原文。
       * ⚠️ 用**逐字符认括号配对**，不用正则 —— `style={{ justifyContent: 'center' }}`
       *    里有两层 `{}`，正则数不过来（这地方错一次，下面所有断言都变成假绿）。
       */
      const markArgs = (src) => {
        const out = []
        /* 🔴 认 `<StatusMark` **后面跟空白或 `>`** 的那些 —— 不这样锚，
           `import { StatusMark, … } from …` 那一行也会被当成一个落点（第一版就多出两个空对象）。 */
        const re = /<StatusMark(?=[\s>])/g
        let hit
        while ((hit = re.exec(src)) !== null) {
          const close = src.indexOf('>', hit.index)
          if (close < 0) break
          const tag = src.slice(hit.index + '<StatusMark'.length, close)
          const args = {}
          let j = 0
          while (j < tag.length) {
            while (j < tag.length && /[\s\n]/.test(tag[j])) j++
            const prop = /^([A-Za-z][\w-]*)\s*=/.exec(tag.slice(j))
            if (!prop) break
            j += prop[0].length
            const start = j
            if (tag[j] === '{') {
              let depth = 0
              while (j < tag.length) {
                if (tag[j] === '{') depth++
                else if (tag[j] === '}') {
                  depth--
                  if (depth === 0) {
                    j++
                    break
                  }
                }
                j++
              }
            } else {
              while (j < tag.length && !/[\s\n]/.test(tag[j])) j++
            }
            args[prop[1]] = tag.slice(start, j)
          }
          out.push(args)
          re.lastIndex = close
        }
        return out
      }
      /** 一个实参是"变量"还是"字面量字符串" */
      const asVar = (argSrc) => {
        const m = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(argSrc ?? '')
        return m ? m[1] : null
      }
      const asLit = (argSrc) => {
        const m = /^(['"])(.*?)\1$/.exec(argSrc ?? '')
        return m ? m[2] : null
      }
      /**
       * 这个 state 变量**有没有真的被写到某一档**：
       * 认 `setX('done')` 这种字面量调用，也认 `setX(res.ok ? 'done' : 'failed')` 那种三目。
       */
      const writesTo = (src, varName, status) => {
        const setter = 'set' + varName[0].toUpperCase() + varName.slice(1)
        if (!src.includes(`${setter}(`)) return false
        return new RegExp(`${setter}\\((?:(?!\\))[\\s\\S]){0,160}?['"]${status}['"]`).test(src)
      }
      const importMarks = markArgs(importSrc)
      /* 「正在识别」那一颗：`status` 是 state（不是写死 running），且**三档都真的会被写到**
         ⚠️ 认法用 `asVar` 解析（**不能**只看 `size` —— 旁边那颗红叉也是 `size={16}`，
            只看 size 会挑中红叉，于是 `scanVar` 是 null、下面三条一起变成假红）。 */
      const scanVar = (() => {
        const hit = importMarks.find((a) => !('label' in a) && asVar(a.status) !== null)
        return hit ? asVar(hit.status) : null
      })()
      /** `scanMark` → `setScanMark`（观察值与反向对照都用它拼） */
      const scanSet = scanVar ? 'set' + scanVar[0].toUpperCase() + scanVar.slice(1) : ''
      /* 🔴 顺序判据**不能**拿"全文第一次出现 `set…('done')`"去比 "`set…('failed')`"：
         `finishScan` 是**函数声明**（写在 `runScan` 之前），所以它体内的 `'done'`
         天然比 `runScan` 失败分支里的 `'failed'` 更靠前 —— 那样比是**恒真**的假绿。
         真正要钉的是**同一条路上的先后**：先失败、再说原因、再回到「拍摄」那屏。 */
      const failBranch = importSrc.match(
        new RegExp(`${scanSet}\\('failed'\\)[\\s\\S]{0,120}?setOcrErr\\(out\\.message\\)[\\s\\S]{0,200}?setStage\\('preview'\\)`),
      )
      check(
        scanVar !== null &&
          ['running', 'done', 'failed'].every((st) => writesTo(importSrc, scanVar, st)) &&
          failBranch !== null,
        '🔴 S25 ①「正在识别」：`status` 接的是 state（不再写死 `running`），`running` / `done` / `failed` **三档都真的会被写到**，且失败那条路是"先红叉 → 再说原因 → 回拍摄那屏"',
        `status={${scanVar}} · 失败分支 ${failBranch ? '在' : '缺'}（failed → setOcrErr → setStage(preview)）`,
        '反向对照：把 `status={scanMark}` 改回 `status="running"` → 这一条当场判假（本节的对照 D 实测跑过）',
      )
      /* 失败那颗红叉：**跟着 `ocrErr` 那块提示走**（不是"识别失败就跳走"）
         ⚠️ 这一条查的是"那块提示在不在"（`{ocrErr ? (`），所以用**原始源码** ——
            剔注释那一步是按行做的，`ocrErr` 这类词在注释里也出现，两边都不该影响它。 */
      const failMarks = importMarks.filter((a) => asLit(a.status) === 'failed')
      check(
        failMarks.length === 1 && failMarks[0].strike === '{false}' && importRaw.includes('{ocrErr ? ('),
        '🔴 S25 ①「识别失败」：红叉是**字面量 `failed`** 的一颗（`strike={false}`），挂在 `ocrErr` 那块提示里 —— 失败时红叉与原因同时在屏上，不会一闪就没',
        `failed 字面量 ${failMarks.length} 颗 · strike=${failMarks.map((a) => a.strike).join('/')}`,
      )
      /* 「备份到云端」那一颗：`status` 是 state，终态由**真结果**决定
         ⚠️ 2026-10-04：锚点从 `settingsSrc` 换成 `extraSrc`（那一颗从「我的」撤下、
            实现搬到 `components/BackupExtraActions.tsx`）—— **判据本身一个字没改**。 */
      const backupVar = (() => {
        const hit = markArgs(extraSrc).find((a) => 'label' in a)
        return hit ? asVar(hit.status) : null
      })()
      const okIdx = extraSrc.indexOf('res.ok ?')
      const doneIdx = backupVar ? extraSrc.indexOf(`'done'`) : -1
      check(
        backupVar !== null &&
          writesTo(extraSrc, backupVar, 'running') &&
          writesTo(extraSrc, backupVar, 'done') &&
          writesTo(extraSrc, backupVar, 'failed') &&
          /set[A-Za-z]+\(res\.ok\s*\?\s*'done'\s*:\s*'failed'\)/.test(extraSrc) &&
          okIdx > 0 &&
          doneIdx > okIdx,
        '🔴 S25 ②「备份到云端」：`running` → `done` **由 `res.ok` 决定**（不是"忙完了就当成功"）· 失败 → `failed` 停住（这颗按用户 2026-10-04 的取舍已从「我的」撤下，锚点＝它现在住的那份文件）',
        `status={${backupVar}} · res.ok 在第 ${okIdx} 字符 · done/failed 三目 ${/set[A-Za-z]+\(res\.ok\s*\?\s*'done'\s*:\s*'failed'\)/.test(extraSrc) ? '在' : '不在'}`,
        '反向对照：把那一行改成 `setBackupMark(\'done\')`（不看 res.ok）→ 这一条当场判假（A16 ③附 那条就是它）',
      )
      /* `bkNotifyBusy` 只管"按钮禁用"，**不许**再拿它推状态（原来就是这么写的） */
      check(
        !/status=\{[^}]*bkNotifyBusy[^}]*\}/.test(extraSrc),
        '🔴 S25 ②：状态**不再从** `bkNotifyBusy` 推 —— 那个布尔量只说"忙不忙"，说不出"成了还是没成"（绿勾/红叉的信息全在后者）',
        `status 里引用 bkNotifyBusy 的落点 = ${(extraSrc.match(/status=\{[^}]*bkNotifyBusy[^}]*\}/g) ?? []).length} 处`,
      )
      /* 🔴 S25 ②附（2026-10-04 新增）：那**两颗**真的**不在「我的」页了** ——
         "删除也是被钉住的"那一面（用户当天三处改动里的第 ③ 条）。 */
      const extraEntryGone = (s) =>
        !s.includes('data-backup-notify') && !s.includes('data-backup-seal') && !s.includes('notifyBackupDone')
      check(
        extraEntryGone(settingsSrc),
        '🔴 S25 ②附：「备份到云端」与「导出档案备份（加密）」这两颗**不在「我的」页了**（用户 2026-10-04 取舍：全平台那一层只在超管面板里留）—— 实现没删，只撤了入口',
        `data-backup-notify=${settingsSrc.includes('data-backup-notify')} · data-backup-seal=${settingsSrc.includes('data-backup-seal')} · notifyBackupDone=${settingsSrc.includes('notifyBackupDone')}`,
      )
      /* 🧪 反向对照：把那一颗塞回 `Settings` 的**源码副本**（内存里）⇒ 上面那条当场假 */
      const entryBack = settingsSrc.replace(
        '                从备份文件恢复',
        '                <Button block data-backup-notify>备份到云端</Button>\n                从备份文件恢复',
      )
      check(
        entryBack !== settingsSrc && !extraEntryGone(entryBack),
        '🧪 S25 ②附 反向对照：把「备份到云端」那一颗塞回 `Settings` 源码副本 ⇒ 同一条判据当场假（"不在这一屏了"真的被判）',
        `副本真被改过=${entryBack !== settingsSrc} · 塞回去之后判据=${extraEntryGone(entryBack)}`,
      )

      /* ---------- ② 停留时长：一个常量，不是三处硬编 ---------- */
      const constDecl = markSrc.match(/export const STATUS_MARK_HOLD_MS\s*=\s*(\d+)/)
      const importUse = (importSrc.match(/STATUS_MARK_HOLD_MS/g) ?? []).length
      /* ⚠️ 第二个落点 2026-10-04 从 `Settings.tsx` 换成了 `BackupExtraActions.tsx`（见 ② 上面那段） */
      const extraUse = (extraSrc.match(/STATUS_MARK_HOLD_MS/g) ?? []).length
      const rawLiterals = [
        ...(importSrc.match(/\b1200\b/g) ?? []),
        ...(extraSrc.match(/\b1200\b/g) ?? []),
      ]
      check(
        constDecl !== null &&
          Number(constDecl[1]) > 0 &&
          importUse >= 2 &&
          extraUse >= 2 &&
          rawLiterals.length === 0,
        '🔴 S25 ③ 停留时长是**一个导出常量**（`STATUS_MARK_HOLD_MS`）—— 两个落点都 import 它，两处代码里 `1200` 这个字面量一处都没有',
        `常量=${constDecl ? constDecl[1] : '（没有）'} · 引用数 ImportPhoto ${importUse} / BackupExtraActions ${extraUse} · 硬编 1200 = ${rawLiterals.length} 处`,
        '反向对照：把 ImportPhoto 里那处 `await finishScan()` 换回 `setStage(\'review\')`（= 不等）→ 第 ④ 条当场判假',
      )
      /* 时长必须**真的被 await**（只声明常量、不等一下 = 勾根本来不及被看见） */
      const finishDef = /const finishScan\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]{0,400}?STATUS_MARK_HOLD_MS[\s\S]{0,200}?setStage\('review'\)/.test(importSrc)
      check(
        finishDef && /await finishScan\(\)/.test(importSrc) && importSrc.indexOf('await finishScan()') > importSrc.indexOf('const finishScan'),
        '🔴 S25 ④：成功那条路**真的 await 了**这个时长（`finishScan` 里 `setTimeout(HOLD)` 之后才 `setStage(\'review\')`）—— 否则 `done` 一帧就被卸载，老师根本看不见绿勾',
        `finishScan 时序 ${finishDef ? '在' : '不在'} · await 调用 ${(importSrc.match(/await finishScan\(\)/g) ?? []).length} 处`,
      )
      /* 失败那一路：红叉、原因、回「拍摄」那屏三者是**同一段**（见 ① 那条的 `failBranch`）。
         这里补一条"`setOcrErr(out.message)` 只出现在失败分支之后"的静态秩序（防止有人把
         红叉挪到 success 那条路上 —— 那样"失败亮红叉"就名存实亡）。 */
      const okAfterFail = importSrc.indexOf('await finishScan()')
      const failFirst = importSrc.indexOf(`${scanSet}('failed')`)
      check(
        failFirst > 0 && okAfterFail > failFirst && failBranch !== null,
        '🔴 S25 ④：`failed` 与成功那条 `await finishScan()` **是两段互斥的路**（失败在前面、成功在后面），不是"失败也往下走"',
        `set…(failed)@${failFirst} · await finishScan()@${okAfterFail}`,
      )

      /* ---------- ③ 版本号三处一致 ---------- */
      const verMatch = verSrc.match(/APP_VERSION\s*=\s*'([^']+)'/)
      const ver = verMatch ? verMatch[1] : null
      const top = logSrc.match(/v:\s*'([^']+)'/)
      /*
       * 🔴🔴 **判据里不许出现版本号字面量**（2026-10-03 改，之前写的是 `ver === '1.0.8'`）：
       *   写死的话，每发一版都要回来手改这三处，改漏一处就是一条**恒红的死断言**，
       *   而人只会以为"门禁坏了"——不会想到是自己上一轮发版时忘了改。
       *   ✅ 真正要断的是「**三处彼此一致**」，而"这一版是几"根本不是判据。
       */
      check(
        ver !== null && pkg.version === ver && top !== null && top[1] === ver,
        '🔴 S25 ⑤ 版本号**三处一致**：`lib/version.ts` · `app/package.json` · `lib/changelog.ts` 顶部那一段',
        `version.ts=${ver} · package.json=${pkg.version} · changelog[0]=${top ? top[1] : '（读不到）'}`,
        '反向对照：只把 `version.ts` 改成一个对不上的号 → 这一条当场判假（对照 A 实测跑过）',
      )
      /* 更新日志顶部那一段的条目数与 `at`（`at` 用"落进仓库的那一天"口径） */
      /*
       * 🔴 顶部那一段 = **第一条版本号到第二条版本号之间**，两端都**按位置找**，
       *   不再钉死 `1.0.8` / `1.0.0` 两个串（同上）。
       * 🔴🔴 **必须按「带引号的版本号」找，不能 `indexOf('v:')`**（第一版就是这么写的，当场错）：
       *   这个文件里第一个 `v:` 是**类型声明** `v: string`（下标 1468），不是数组里的条目
       *   ⇒ 截出来的是 `ChangeLogEntry` 那个类型、条目数 0、`at` 也没有。
       *   「查不到 ≠ 没有」的另一个变体：查错了地方，于是判"没写"。
       * 🔴 `at` 也不再钉死 `10月2日` —— 那是**上一版**的发版日，
       *   钉着它等于"只要发版就红"。改成断它**像个日期**（月+日，不是「待定」）。
       */
      /* 顶部那一段的截法（**按位置、按带引号的版本号**找）写进下面的 `topOf()` 里 ——
         反向对照要喂**同一条**判据，所以只能有一处口径。 */
      /**
       * ⚠️ 条目有**两种写法**，都要数（2026-10-04 v1.1.1 让这条判据红过一次：
       *   它 5 条里有 2 条是 `{ text: '…', only: 'desktop' }`，而这里原来只数 `^\s{6}'`
       *   ⇒ 数到 3 条 < 5 ⇒ 判据红，**而条目一条都不少**。
       *   那是"判据只认一种写法"，不是"顶部那段是占位一行" —— 红的原因又一次在核对工具自己身上。)
       */
      /**
       * 🔴🔴 **S25 ⑥ 为什么放宽了条数、又收紧了内容**（2026-10-04，1.1.2 发版时改）。
       *
       * 它原来是 `itemsTop >= 5` —— 那是 1.1.0 / 1.1.1 那种**成批改动**留下的读数，
       * 一旦当成硬要求，就等于要求"**每一版至少凑 5 条**"。而 1.1.2 只有 2 条老师能
       * 感觉到的改动（教室端原生小窗 · 升级不再多出带版本号的旧图标），
       * 要过这条判据就只能**灌水** —— 而"凑数"正是这一屏最不该发生的事
       * （它当初从 `Settings.tsx` 里搬出来，就是因为版本号与日志会各写各的）。
       * ⇒ 判据回到它注释里本来那句话「**真的写了改动，不是占位一行**」：
       *   · **放宽条数**（`>= 1`，一版一条也算如实）；
       *   · **收紧每一条**：那句话**本身得像句话**（≥ `MIN_ITEM_CHARS` 个字符）——
       *     占位（`'待补'` / 空串 / 几个字）一律判红。
       *   ⚠️ 下面那一段反向对照就是"它还能红"的证明（清空 / 换成占位 ⇒ 当场判假）。
       */
      const MIN_ITEM_CHARS = 8
      const topOf = (src) => {
        const hits = [...src.matchAll(/v:\s*'([^']+)'/g)]
        const a = hits[0]
        const b = hits[1]
        const body = a && b && b.index > a.index ? src.slice(a.index, b.index) : ''
        const plain = [...body.matchAll(/^\s{6}'((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1])
        const obj = [...body.matchAll(/^\s{8}text:\s*'((?:[^'\\]|\\.)*)'/gm)].map((m) => m[1])
        return {
          body,
          plain,
          obj,
          items: [...plain, ...obj],
          at: (body.match(/at:\s*'([^']+)'/) ?? [])[1] ?? null,
        }
      }
      /** 同一条判据（反向对照要喂**它同一份**，不许另写一套口径） */
      /*
       * 🔴 `at` 的格式 2026-10-04 变了：**要带年份**（`2026年10月4日`）。
       *   为什么期望值变了：用户当天要求"多久出的应用版也写进去" —— 只写"10月4日"的话，
       *   跨年之后这一屏就看不出先后（而这一屏的全部信息量就是"哪天改了什么"）。
       *   ⇒ 从 `^\d{1,2}月\d{1,2}日$` 收紧成 `^\d{4}年\d{1,2}月\d{1,2}日$`
       *   （**变严了**，不是放宽：少写年份现在会红）。
       */
      const topWrittenRight = (t) =>
        t.items.length >= 1 &&
        t.items.every((s) => s.length >= MIN_ITEM_CHARS) &&
        t.at !== null &&
        /^\d{4}年\d{1,2}月\d{1,2}日$/.test(t.at)
      const T = topOf(logSrc)
      const shortest = T.items.length ? Math.min(...T.items.map((s) => s.length)) : 0
      check(
        topWrittenRight(T),
        `🔴 S25 ⑥ 顶部那一段（${top ? top[1] : '?'}）**真的写了改动**（不是占位一行）：≥1 条，且**每一条那句话本身 ≥ ${MIN_ITEM_CHARS} 个字符**；发版日按"落进仓库的那一天"填、**且要带年份**（如 \`2026年10月4日\`）`,
        `条目 ${T.items.length} 条（纯文本 ${T.plain.length} + 带标 ${T.obj.length}，最短一条 ${shortest} 字）· at=${T.at ?? '（没有）'}`,
      )
      /* 🧪 反向对照：清空条目 / 换成占位一行 ⇒ **同一条判据**当场判假（放宽的是条数，不是"什么都不写也算"） */
      const emptiedSeg = T.body
        ? logSrc.replace(T.body, T.body.replace(/^\s{6}'.*$/gm, '').replace(/^\s{8}text:.*$/gm, ''))
        : logSrc
      const placeholderSeg = T.body
        ? logSrc.replace(
            T.body,
            T.body
              .replace(/^(\s{6}')[^']*(')/gm, '$1待补$2')
              .replace(/^(\s{8}text:\s*')[^']*(')/gm, '$1待补$2'),
          )
        : logSrc
      const emptiedTop = topOf(emptiedSeg)
      const placeholderTop = topOf(placeholderSeg)
      check(
        emptiedSeg !== logSrc &&
          placeholderSeg !== logSrc &&
          !topWrittenRight(emptiedTop) &&
          !topWrittenRight(placeholderTop),
        "🧪 S25 ⑥ 反向对照：把顶部那一段的条目**清空**（0 条）／**换成占位一行 `'待补'`**（2 个字）⇒ 同一条判据当场判假 —— 证明放宽的是**条数**，不是把「什么都不写」也放行了",
        `清空后：${emptiedTop.items.length} 条 → 判据 ${topWrittenRight(emptiedTop)} · 占位后：${JSON.stringify(placeholderTop.items)} → 判据 ${topWrittenRight(placeholderTop)}`,
      )
      /* 🔴 §七 的钉子：给老师看的那一屏**不许出现**「内测」「公测」 */
      const banned = ['内' + '测', '公' + '测']
      const bannedHit = banned.filter((w) => logSrc.includes(w))
      check(
        bannedHit.length === 0,
        '🔴 S25 ⑦ §七 文案纪律：`changelog.ts`（给老师看的）里**不出现**「内测」「公测」—— 那是软件行业用语，老师不关心',
        `命中 ${bannedHit.length} 处（${bannedHit.join(' / ') || '无'}）`,
        '反向对照：往 `1.0.0` 那一段塞一句含该词的文案 → 这一条当场判假（对照 B 实测跑过）',
      )
      /* 同一句话要写进**内部**文档（给后来的 agent 看），两边分工不许串 */
      const docSrc = (() => {
        try {
          return readFileSync(join(root25, '..', '功能设计与不变量.md'), 'utf8').replace(/\r\n/g, '\n')
        } catch {
          return ''
        }
      })()
      check(
        docSrc.includes(banned[0]) && docSrc.includes(banned[1]) && docSrc.includes('1.0.0'),
        'S25 ⑦：`1.0.0 = 内测转公测、第一次小范围公测` 这句写在**内部**文档（`功能设计与不变量.md` §15.6）里 —— 内部话归内部，界面话归界面',
        `功能设计与不变量.md：字数 ${docSrc.length} · 两个词 ${banned.map((w) => (docSrc.includes(w) ? '有' : '没有')).join('/')}`,
      )

      /* ============================================================
         🔴 更新日志按端分流（`ChangeLogItem.only`，2026-10-04）
         ------------------------------------------------------------
         背景：「桌面版自带一个备份文件夹：装上就每 5 分钟自动写一份…」
         原来在**教师端 apk 上照显**，而 apk 里 `hasBuiltinBackupDir()` 恒 false
         —— 没有那个文件夹、也没有那张卡片，却写着「照着拷到 U 盘就行」。

         🔴🔴 这里钉**两件事，少一件就等于没钉**：
           ① 条目**真的打了标**（把标去掉 → 当场红）
           ② Settings 渲染那一处**真的在读它**（`it.only === 'desktop'`）
              —— 只在类型上声明、渲染不读 ⇒ 屏上照样显示，
                 而门禁一条都不会响。本项目为这个模式栽过四次：
                 **声明了没人用 / 桥接层给了答案业务层没读。**
         ============================================================ */
      /* ⚠️ `settingsSrc` 是本作用域**已有的那份**（`:12520`，`noComment` 剔过注释）——
           别在这里再 `readSrc` 一份：① 重复声明直接 SyntaxError；
           ② 复用带 `noComment` 的那份更硬 —— 光在注释里写 `it.only === 'desktop'`
             **骗不过它**（本条断言必须由真代码满足）。 */
      /** 从**真源码**里把那个标读出来 —— 不在这里另写一份"应该是什么"的真源。 */
      const onlyOf = (src) => (/备份文件夹[^']*',\s*only:\s*'([^']+)'/.exec(src) ?? [])[1] ?? null
      /** 判据本体：与 `Settings.tsx` 渲染那处**逐字同义**（改一处必须同步改另一处）。 */
      const changelogVisible = (platform, only) =>
        !only ? true : only === 'desktop' ? platform === 'electron' : platform !== 'electron'
      const readsOnly =
        /log\.items[\s\S]{0,600}\.filter\(/.test(settingsSrc) && /it\.only === 'desktop'/.test(settingsSrc)
      const onlyTag = onlyOf(logSrc)
      check(
        onlyTag === 'desktop' &&
          readsOnly &&
          changelogVisible(null, onlyTag) === false &&
          changelogVisible('electron', onlyTag) === true,
        '🔴 S25 ⑧ 更新日志按端分流：那条「桌面版备份文件夹」打了标 **且 Settings 渲染那一处真的在读它**（打标 + 读，两件事都成立）· 网页版不显示、exe 显示',
        `标=${onlyTag ?? '（没打）'} · 渲染在读=${readsOnly} · 网页可见=${changelogVisible(null, onlyTag)} · exe 可见=${changelogVisible('electron', onlyTag)}`,
        '反向对照：🧪 对照 E（把标去掉 → 同一个判据当场翻转）',
      )
      /* 🧪 对照 E：把标从**真源码**里摘掉 → 判据必须翻转，否则 ⑧ 是恒真的摆设
       *
       * ⚠️ **必须摘对那一条**（2026-10-04 踩到的）：`String.replace(re, …)` 只换**第一处**，
       *    而 `only: 'desktop'` 在文件里不止一处 —— v1.1.1 那段（就在顶部）本身有两条带标，
       *    它们比 ⑧ 读的那条（v1.1.0 的「备份文件夹」）更靠前 ⇒ 摘掉的是**别人的标**，
       *    而 ⑧ 读的那条纹丝不动 ⇒ 对照 E 自己失效（与 §S27 ㊶b 那个 `replaceAll` 的坑同源：
       *    "这句在别处也出现过"。教训：**反向对照也要能红**，所以先定位、再就地摘）。 */
      const onlyMatch = /备份文件夹[^']*',\s*only:\s*'([^']+)'/.exec(logSrc)
      const logUntagged = onlyMatch
        ? logSrc.slice(0, onlyMatch.index) +
          onlyMatch[0].replace(/,\s*only:\s*'[^']+'/, '') +
          logSrc.slice(onlyMatch.index + onlyMatch[0].length)
        : logSrc
      const onlyUntagged = onlyOf(logUntagged)
      check(
        logUntagged !== logSrc &&
          onlyUntagged === null &&
          changelogVisible(null, onlyTag) === false &&
          changelogVisible(null, onlyUntagged) === true,
        '🧪 S25 对照 E：把 `only:` 那个标去掉 → **同一个判据**下网页版从"不显示"翻成"显示"（⑧ 不是恒真的摆设）',
        `真源标=${onlyTag} · 去标后=${onlyUntagged ?? 'null'} · 网页 ${changelogVisible(null, onlyTag)} → ${changelogVisible(null, onlyUntagged)} · 源码真被改过=${logUntagged !== logSrc}`,
      )

      /* 🔴 S25 ⑨：**渲染不留空段**（2026-10-04）
         ------------------------------------------------------------
         v1.1.2 那一段两条都标着 `only: 'desktop'` ⇒ 在手机（apk）与网页版上
         「v1.1.2 · 10月4日」下面**空空如也** —— 看起来像坏了（而它其实只是"这一版没你的事"）。
         判据要钉**两件事**：
           ① `Settings.tsx` **渲染前**按端过滤，过滤后为空 **`return null`**（跳过那一段）；
           ② 数据侧：**每一段至少 1 条**（真有"整段没条目"的就是数据写坏了）。
         ⚠️ ①必须由**真代码**满足 —— `settingsSrc` 是剔过注释的那份，
            光在注释里写 `return null` 骗不过它。 */
      const skipsEmpty =
        /log\.items[\s\S]{0,600}?\.filter\(/.test(settingsSrc) &&
        /items\.length === 0\)\s*return null/.test(settingsSrc)
      /** 每段的条目数：条目行以 `{`（对象式）或 `'`（纯文本）开头。 */
      const logEntries = logSrc.split(/\n\s*\{\s*\n\s*v: '/).slice(1)
      const itemsOf = (seg) => {
        const m = /items: \[([\s\S]*?)\n\s*\],/.exec(seg)
        return m ? (m[1].match(/^\s*(?:\{|')/gm) ?? []).length : 0
      }
      const emptyEntries = logEntries.map(itemsOf).filter((n) => n < 1).length
      /* 🧪 对照 F：把"跳过空段"那一行从**源码副本**里删掉 ⇒ ① 必须当场判假 */
      const guardRe = /\s*if \(items\.length === 0\) return null/
      const settingsNoGuard = settingsSrc.replace(guardRe, '')
      const skipsEmptyWithoutGuard =
        /log\.items[\s\S]{0,600}?\.filter\(/.test(settingsNoGuard) &&
        /items\.length === 0\)\s*return null/.test(settingsNoGuard)
      check(
        skipsEmpty &&
          !skipsEmptyWithoutGuard &&
          logEntries.length >= 3 &&
          emptyEntries === 0,
        '🔴 S25 ⑨ 渲染不留空段：`Settings.tsx` **渲染前**按端过滤、过滤后为空 `return null`（手机/网页版不再出现"只有版本号、下面空着"的一段）· 且每一段至少 1 条',
        `跳空段=${skipsEmpty} · 解析到 ${logEntries.length} 段（条目数 ${logEntries.map(itemsOf).join('/')}）· 空段=${emptyEntries} · 源码副本真被改过=${settingsNoGuard !== settingsSrc}`,
        '反向对照：🧪 对照 F（把 `if (items.length === 0) return null` 从 Settings 副本里删掉 → 同一条判据当场判假）',
      )

      /* ---------- 🧪 反向对照（**实测跑红**，见 §S25 报告） ---------- */
      /* A：同一个 sourceCheck，只把 version.ts 的号改掉 → "三处一致"必须判假 */
      const sourceCheckVer = (verSrcIn, pkgVer) => {
        const v = (verSrcIn.match(/APP_VERSION\s*=\s*'([^']+)'/) ?? [])[1] ?? null
        return v !== null && pkgVer === v && top !== null && top[1] === v
      }
      /* 把真源码里的号换成一个**对不上**的（🔴 用 `ver` 拼出来，不写死字面量） */
      const verWrong = ver ? verSrc.replace(`'${ver}'`, "'0.9.9'") : verSrc
      check(
        sourceCheckVer(verSrc, pkg.version) === true && sourceCheckVer(verWrong, pkg.version) === false && verWrong !== verSrc,
        '🧪 S25 对照 A：**同一个判据**喂改过号的源码（真号→`0.9.9`）→ 当场判假 —— ⑤ 不是恒真的摆设',
        `真源码=${sourceCheckVer(verSrc, pkg.version)} · 改过号=${sourceCheckVer(verWrong, pkg.version)} · 真的被改过=${verWrong !== verSrc}`,
      )
      /* B：往更新日志里塞一个禁词 → "不出现"那条必须判假 */
      const bannedOf = (s) => banned.filter((w) => s.includes(w))
      /*
       * ⚠️ **锚点 2026-10-04 跟着更新日志的"简洁化"改过一次**（red 过一次，记下来）：
       *   原来锚的是整句「从这一版起，平台正式给全校用（此前只在少数几位老师之间试用）」，
       *   重写后那句变成了「新增：平台从这一版起正式给全校用，有了名字「树高教务通」和校徽」
       *   ⇒ `String.replace` 找不到 ⇒ `poisoned === logSrc` ⇒ **对照自己先失效**
       *   （"塞过=0 处"就是它的症状，与 S25 对照 E 那个"摘错地方"是同一类坑）。
       *   ⇒ 锚点只取**现在真的在**的那一截；以后改文案要连着这行一起看。
       */
      const poisonAnchor = '平台从这一版起正式给全校用'
      const poisoned = logSrc.replace(poisonAnchor, `${poisonAnchor}（结束${banned[0]}）`)
      check(
        bannedOf(logSrc).length === 0 && bannedOf(poisoned).length === 1 && poisoned !== logSrc,
        '🧪 S25 对照 B：往 `1.0.0` 段里**塞一个禁词** → 同一个判据当场判假（⑦ 真的在扫屏上那句话）',
        `原=${bannedOf(logSrc).length} 处 · 塞过=${bannedOf(poisoned).length} 处`,
      )
      /* C：把一个 `setX('done')` 删掉 → "三档都真被写到"必须判假 */
      const scanAll = (src, v) => ['running', 'done', 'failed'].every((st) => writesTo(src, v, st))
      const donePoisoned = importSrc.replace(`${scanSet}('done')`, `${scanSet}('running')`)
      check(
        scanVar !== null && scanAll(importSrc, scanVar) === true && scanAll(donePoisoned, scanVar) === false,
        '🧪 S25 对照 C：把成功那条路上的 `done` 换回 `running` → 同一个判据当场判假（① 钉的是"终态真的会被写下去"）',
        `原=${scanVar ? scanAll(importSrc, scanVar) : 'n/a'} · 换回后=${scanVar ? scanAll(donePoisoned, scanVar) : 'n/a'}`,
      )
      /* D：把落点的 `status` 改回写死 → "接的是 state"必须判假 */
      const statusWritten = scanVar ? `status={${scanVar}}` : ''
      const writtenDead = markArgs(importSrc.replace(statusWritten, 'status="running"'))
      check(
        statusWritten !== '' &&
          importMarks.some((a) => a.status === `{${scanVar}}`) &&
          !writtenDead.some((a) => a.status === `{${scanVar}}`),
        '🧪 S25 对照 D：把 `status={…}` 改回 `status="running"`（就是改动前那一版）→ 同一个判据当场判假',
        `改成写死后还认得出这个 state 的落点 = ${writtenDead.filter((a) => a.status === `{${scanVar}}`).length} 处`,
      )
    })

    /*
     * ================= S24：「我的身份」那颗 24px 校徽（2026-10-11） =================
     *
     * 背景：`Settings.tsx` 的"我的身份"卡上那颗 24px 图标原来是**平台的旧品牌标**
     * （`icons.tsx` 的 `Logo`：蓝色圆角方块 + 坐标轴折线），**不是校徽**。
     * 这一轮换成校徽，并顺手把已经没人用的 `Logo` 组件删掉。
     *
     * 🔴 2026-10-11（同日）「全徽」轮 —— 这一节**整条判据都变了**，逐条注明为什么：
     *    · 24px 原来是**纯徽**（`emblem-pure-24.png`），依据是 `徽标方案\落地清单.md` §9.1：
     *      全徽 24px 的外圈线只有 **0.50px**（"刚够半个像素"）、圆半实半虚 → 认不出是枚校徽。
     *    · 用户看了截图（「我的身份」那张卡 + Windows 任务栏图标）后说
     *      「把所有这种**纯徽标**全部换成**全徽标**」→ **知情仍要求全徽**，照做。
     *    · 因此：① `src` 从 `emblem-pure-24.png` → `emblem-24.png`；
     *            ② **`srcset` 从"不写"变成"必须写"** —— 纯徽只生成了 1x 一张，
     *               写 2x 会让 2x 屏去取一张**不存在**的 `emblem-pure-48.png`；
     *               全徽**有 2x 档**（`emblem-48.png`），不写它 2x 屏就只能把 24px 那张放大一倍。
     *            ③ 新增一条"全仓 0 处纯徽"的静态钉子 + 一条"24px 这一档现在真的指到 2x"的判据。
     *    · ⚠️ 全徽 24px 实测确实"圆半实半虚"（0.50px）—— 这是**用户知情后的选择**，
     *      不是回归，**别把它当 bug 改回纯徽**（`pure` prop 与 `emblem-pure-*.png` 已整条删掉）。
     */
    await step('S24：我的身份 · 24px 校徽（全徽）', async () => {
      /* 🔴 **这一节必须跑在 DPR 2 的 context 上**（2026-10-11 修）：
       * `srcset` 的 1x / 2x 是**浏览器按设备像素比挑**的 —— DPR 1 的 context 里它**永远挑 1x**，
       * 于是"有没有取到 2x 档"这条判据**在 DPR 1 下根本量不到**（实测踩过：读数里
       * `currentSrc=emblem-24.png · 天然 24px / 屏上需要 24px` = DPR 1，判据红，而**代码是对的**）。
       * ⚠️ 不许把判据放宽成"1x 也算" ✗ —— 那就成了摆设（`AGENTS.md` 三·2）。
       * 文件开头那个 `ctx`（`deviceScaleFactor: 2`）是**移动端截图**用的，跟这一节无关。
       */
      const c = await browser.newContext({
        viewport: { width: 1440, height: 940 },
        locale: 'zh-CN',
        deviceScaleFactor: 2,
      })
      await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await c.addInitScript((st) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE)
      const p = await c.newPage()
      p.on('pageerror', (e) => errors.push(`PAGEERROR(S24) :: ${e.message}`))
      await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
      await p.waitForTimeout(500)

      const read24 = (page) =>
        page.evaluate(() => {
          const all = [...document.querySelectorAll('[data-emblem]')]
          const marked = all.filter((e) => e.hasAttribute('data-settings-emblem'))
          const host = marked[0] ?? null
          const img = host ? host.querySelector('img') : null
          const css = img ? getComputedStyle(img) : null
          return {
            n: all.length,
            before: marked.length === 0 ? all.length : all.indexOf(host),
            markedSrc: img ? img.getAttribute('src') : null,
            natural: img ? img.naturalWidth : 0,
            complete: img ? img.complete : false,
            hostW: host ? Math.round(parseFloat(getComputedStyle(host).width) * 100) / 100 : null,
            srcset: img ? img.getAttribute('srcset') : null,
            /* 🔴 那一档**真实渲染出来的**是 1x 还是 2x —— 判据不读 `srcset` 那个字符串，
               读 `currentSrc` + `<img>` 的布局宽度 × devicePixelRatio：
               `emblem-24.png` 的天然宽是 24、`emblem-48.png` 是 48，谁也冒充不了谁。 */
            currentSrc: img ? img.currentSrc : null,
            naturalOnScreen: img ? (css ? parseFloat(css.width) * window.devicePixelRatio : 0) : 0,
            /* 🔴 **`naturalWidth` 是"兜底 `src` 那张"的天然宽，不是浏览器挑中的那张**
               （实测：`currentSrc = emblem-48.png` 而 `naturalWidth` 仍然是 24）——
               所以"挑中的那张够不够清晰"只能读 `currentSrc` 那一条路。 */
            naturalOfCurrentSrc: img
              ? (() => {
                  const m = /emblem-(\d+)\.png/.exec(img.currentSrc || '')
                  return m ? Number(m[1]) : 0
                })()
              : 0,
            /* 🔴 判据得先能看见"这一节跑在什么 DPR 上" —— 否则它红的时候分不清
               是"代码没写 srcset"还是"环境是 DPR 1"（本轮就是这么红的）。 */
            dpr: window.devicePixelRatio,
            /* 纯徽的痕迹：`<span data-emblem-pure>` 与 `/emblem/emblem-pure-*.png` 两种写法 */
            pureHosts: document.querySelectorAll('[data-emblem-pure]').length,
            pureImgs: [...document.querySelectorAll('img')].filter((i) =>
              /emblem-pure/.test(i.getAttribute('src') ?? ''),
            ).length,
            /* 旧品牌标的几何指纹：坐标轴那条 `M3.8 3.6v16.8h16.8`（`icons.tsx` 的 `Logo`） */
            legacyLogo: document.querySelectorAll('svg path[d="M3.8 3.6v16.8h16.8"]').length,
          }
        })

      const r24 = await read24(p)
      check(
        r24.n >= 1 && r24.markedSrc === '/emblem/emblem-24.png',
        'S24：「我的身份」那颗 24px 现在是**全徽**（`emblem-24.png`）—— 用户「把所有这种纯徽标全部换成全徽标」；⚠️ 实测外圈线 0.50px、"圆半实半虚"，是知情后的选择',
        `[data-settings-emblem] src=${r24.markedSrc}`,
      )
      check(
        r24.complete &&
          r24.natural === 24 &&
          Math.abs((r24.hostW ?? 0) - 24 / 0.87) < 0.6 &&
          r24.srcset === '/emblem/emblem-24.png 1x, /emblem/emblem-48.png 2x',
        'S24：徽的**真图元**在（天然 24px）、盒子 = 徽 / 0.87（盒子那 13% 就是"徽到文字"的间距）—— 而 `srcset` 判据**整个反过来了**：纯徽时代是"必须不写"（写了 2x 会去取一张不存在的 `emblem-pure-48.png`），全徽**有 2x 档**，现在是"必须写"',
        `天然 ${r24.natural}px · 盒 ${r24.hostW}px · srcset = ${r24.srcset === null ? '（未写）' : r24.srcset}`,
      )
      check(
        r24.dpr === 2 && r24.naturalOfCurrentSrc >= r24.naturalOnScreen,
        '🔴 S24：24px 那一档在 **DPR 2 的屏上真的取到了全徽的 2x 档**（浏览器挑中的那张的天然宽 ≥ 盒宽 × DPR）—— 判据读的是 `currentSrc` 挑中的那一张，不是 `srcset` 那个字符串，也不是 `naturalWidth`（后者永远是兜底 `src` 那张的 24）',
        `DPR=${r24.dpr} · currentSrc=${r24.currentSrc} · 挑中那张天然 ${r24.naturalOfCurrentSrc}px / 屏上需要 ${Math.round(r24.naturalOnScreen)}px`,
      )
      check(
        r24.before >= 0 && r24.n === 3 && r24.legacyLogo === 0,
        '🔴 S24：那一颗是"我的身份"卡上那颗（带 `data-settings-emblem` 标记；同一页还有左栏 40 / 移动顶栏 32 两颗），而且**旧品牌标一个都没有了**（`<Logo>` 的坐标轴折线 0 处）',
        `页面上 ${r24.n} 个校徽、那颗在第 ${r24.before + 1} 位 · 旧 Logo 折线 ${r24.legacyLogo} 处`,
      )
      check(
        r24.pureHosts === 0 && r24.pureImgs === 0,
        '🔴 S24：这一页（`/settings`，三个徽位）里 `data-emblem-pure` 与 `emblem-pure-*` 两种纯徽写法**都是 0 处**',
        `data-emblem-pure=${r24.pureHosts} 处 · emblem-pure 图=${r24.pureImgs} 张`,
      )
      /* ---------- 🔴 新增：全仓「再也没有一处纯徽」的静态钉子 ----------
       * 为什么要有它：`pure` prop / `emblem-pure-*` 文件 / 纯徽素材名 —— 三样都清了，
       * 但只要有人再把其中任一样写回来，"全部全徽"这条用户指令就破了，而上面那几条
       * 页面内断言**看不见**（只有 24px 那一处会被看见，别的位图看不见）。
       */
      /* ⚠️ 正则**不扫「纯徽」这两个汉字**：改完之后它仍然会出现在"为什么不用它"的说明性注释里，
         扫它会变成一条**为了绿而扫**、且永远说不清的判据。要钉的是**代码里那三样真的东西**：
         `pure` prop、`data-emblem-pure` 属性、`emblem-pure-*` 那个位图路径 / 文件名。 */
      const PURE_CODE24 = /emblem-pure|\bpure\b|data-emblem-pure|emblemPure/
      const SRC24 = join(HERE, '..', 'src')
      const EMBLEM24 = join(HERE, '..', 'public', 'emblem')
      const walk24 = (dir) =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
          d.isDirectory() ? walk24(join(dir, d.name)) : [join(dir, d.name)],
        )
      const hitPure24 = walk24(SRC24).filter(
        (f) => /\.(tsx?|css)$/.test(f) && PURE_CODE24.test(readFileSync(f, 'utf8')),
      )
      check(
        hitPure24.length === 0,
        'S24：`src/**` 的**代码里**再也没有一处纯徽（`pure` prop / `data-emblem-pure` / `emblem-pure-*` 三种写法，全仓 0 处）',
        hitPure24.length
          ? hitPure24.map((f) => f.slice(SRC24.length + 1)).join('、')
          : 'src 下 0 处',
      )
      const pureFiles24 = readdirSync(EMBLEM24).filter((f) => /pure|纯徽/.test(f))
      check(
        !existsSync(join(EMBLEM24, 'emblem-pure-24.png')) && pureFiles24.length === 0,
        'S24：`public/emblem/` 里**纯徽那几张位图已经删干净了**（`emblem-pure-24.png` 不存在）',
        pureFiles24.length ? `还剩 ${pureFiles24.join('、')}` : 'emblem 目录下 0 个纯徽文件',
      )
      /* 🧪 反向对照 A：把那一张手动改回**纯徽**那张（`src` + `srcset` 两个一起改，
       * 照 ⑤ 那条反向对照的教训 —— 只改 `src` 的话浏览器会从 `srcset` 挑回真图，
       * 对照就成了"怎么都不会红"的假对照）→ "是全徽"与"2x 档"两条**必须**当场判假。
       */
      const negA24 = await p.evaluate(() => {
        const host = document.querySelector('[data-settings-emblem]')
        const img = host ? host.querySelector('img') : null
        if (!host || !img) return { ok: false, why: '找不到那一颗' }
        img.removeAttribute('srcset')
        img.src = '/emblem/emblem-pure-24.png'
        return { ok: true }
      })
      await p.waitForTimeout(400)
      const negR24 = negA24.ok ? await read24(p) : { markedSrc: null, natural: 0, currentSrc: null }
      check(
        negA24.ok &&
          negR24.markedSrc !== '/emblem/emblem-24.png' &&
          negR24.natural === 0 &&
          negR24.currentSrc !== '/emblem/emblem-48.png',
        '🧪 S24 反向对照 A：把那颗在内存里指回**纯徽**那张（而且那张文件已经不存在）→ 同一个探针**当场判假**（`src` 不是全徽、2x 也没了）',
        `改回去之后 src=${negR24.markedSrc} · 天然 ${negR24.natural}px · currentSrc=${negR24.currentSrc}`,
      )
      /* 🧪 反向对照 B：把 `data-settings-emblem` 摘掉 → "它就是那一颗"那条必须判假 */
      const negR24b = await p.evaluate(() => {
        const marked = document.querySelector('[data-settings-emblem]')
        if (marked) marked.removeAttribute('data-settings-emblem')
        const all = [...document.querySelectorAll('[data-emblem]')]
        return { marked: all.filter((e) => e.hasAttribute('data-settings-emblem')).length }
      })
      check(
        negR24b.marked === 0,
        '🧪 S24 反向对照 B：把 `data-settings-emblem` 摘掉 → "它就是那一颗"那条**当场判假**（证明这个探针真的在找标记，不是恒真）',
        `摘掉之后带标记的：${negR24b.marked} 个`,
      )
      /* 🧪 反向对照 C（🔴 本轮新增，专治"satisfied by construction"）：**同一个探针**在
       * **DPR 1 的 context** 里量同一页 —— 浏览器这时只会挑 1x，于是"取到了 2x 档"
       * 那条判据**必须当场判假**。
       * 它证明的是"那条判据**真的在量 DPR**"，而不是"在 2x 环境里怎么都真"。
       */
      {
        const c1 = await browser.newContext({
          viewport: { width: 1440, height: 940 },
          locale: 'zh-CN',
          deviceScaleFactor: 1,
        })
        await c1.addInitScript((st) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        const p1 = await c1.newPage()
        await p1.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
        await p1.waitForTimeout(400)
        const r1 = await read24(p1)
        check(
          /* ⚠️ 门槛要写成 `naturalOfCurrentSrc < naturalOnScreen * 2` 而不是
             `< naturalOnScreen` —— DPR 1 下这两个数**恰好相等**（都是 24），
             写 `<` 就成了一条**永远红**的对照（实测踩过）。主判据要的是
             "够不够 2x"，所以这里的否定就是"**不到 2x**"。 */
          r1.dpr === 1 &&
            r1.naturalOfCurrentSrc === 24 &&
            r1.naturalOfCurrentSrc < r1.naturalOnScreen * 2,
          '🧪 S24 反向对照 C：同一个页面放进 **DPR 1** 的 context → 浏览器只挑 1x（天然 24 < 屏上需要的 2 倍），主判据那条**当场不成立**（证明它真的在量 DPR，不是恒真）',
          `DPR=${r1.dpr} · currentSrc=${r1.currentSrc} · 挑中那张天然 ${r1.naturalOfCurrentSrc}px / 屏上需要 ${Math.round(r1.naturalOnScreen)}px（2 倍 = ${Math.round(r1.naturalOnScreen * 2)}px）`,
        )
        await c1.close()
      }
      await c.close()
    })

    /*
     * ================= S26：**自己改密码**（2026-10-11） =================
     *
     * 🔴 用户原话：「**加一个吧，都放在我的页面的那个身份卡里面，自己改了账户名字后行政管理那边要能看见**」
     *
     * 为什么要这一节（不是"多加一组静态断言"）：这一段的失败**必须显式上屏**
     * （AGENTS.md §三.5），而"上了没上"只有在真浏览器里量得到 ——
     * `nav-checks` 那一边只能证明源码里摆了那两块屏。
     *
     * ⚠️ 这一节跑的是**本地演示模式**（`isRemote === false`）：
     *    · 那段界面**照常摆**（身份卡是"我的账号"那一块，与有没有后端无关）；
     *    · 所以**三档前置校验**在这台机器上量得到（它们不看后端，看的是三个格）；
     *    · 而"真的调用了改密码接口"那一步只能到"显示"这一层（本地没有账号）——
     *      **这一点如实写在断言里，不假装测过**（真联网那一条在 `nav-checks` D13-B 静态钉死）。
     */
    await step('S26：我的身份 · 自己改密码（失败显式上屏）', async () => {
      const c = await browser.newContext({
        viewport: { width: 1440, height: 940 },
        locale: 'zh-CN',
        deviceScaleFactor: 2,
      })
      await c.clock.install({ time: new Date('2026-09-19T10:00:00') })
      await c.addInitScript((st) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE)
      const p = await c.newPage()
      p.on('pageerror', (e) => errors.push(`PAGEERROR(S26) :: ${e.message}`))
      await p.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
      await p.waitForTimeout(400)

      /* 身份卡那一行右边那颗「编辑」→ 打开 `title="我的身份"` 那张 Sheet */
      await p.getByRole('button', { name: '编辑' }).first().click()
      await p.waitForTimeout(350)

      /** 那张 Sheet 里，与"改密码"有关的一切（**都在同一个浮层里量**） */
      const readPwd = (page) =>
        page.evaluate(() => {
          const sheets = [...document.querySelectorAll('.sheet, [role="dialog"]')]
          const sheet = sheets.find((s) => (s.textContent ?? '').includes('我的身份')) ?? null
          const blk = sheet ? sheet.querySelector('[data-change-password]') : null
          const labels = [...(sheet ? sheet.querySelectorAll('span.label') : [])].map((e) =>
            (e.textContent ?? '').trim(),
          )
          const inputs = blk ? [...blk.querySelectorAll('input')] : []
          return {
            hasSheet: Boolean(sheet),
            hasBlock: Boolean(blk),
            labelAt: labels.indexOf('改密码'),
            labelCount: labels.length,
            nameAt: labels.indexOf('姓名'),
            subjAt: labels.indexOf('主学科'),
            order: blk && sheet ? [...sheet.querySelectorAll('span.label, [data-change-password]')].indexOf(blk) : -1,
            passwordInputs: inputs.filter((i) => i.getAttribute('type') === 'password').length,
            typed: inputs.map((i) => i.getAttribute('type')),
            autoComplete: blk
              ? [...blk.querySelectorAll('input')].map((i) => i.getAttribute('autocomplete'))
              : [],
            err: blk ? (blk.querySelector('[data-pwd-err]')?.textContent ?? '').trim() : '',
            ok: blk ? (blk.querySelector('[data-pwd-ok]')?.textContent ?? '').trim() : '',
            errRole: blk ? (blk.querySelector('[data-pwd-err]')?.getAttribute('role') ?? '') : '',
            buttons: blk ? [...blk.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()) : [],
          }
        })

      const before = await readPwd(p)
      check(
        before.hasSheet,
        '🔴 S26 ① 身份卡那颗「编辑」打开的**就是**「我的身份」那张卡（不是别的浮层）',
        `card=${before.hasSheet} · 卡内段落标签 ${before.labelCount} 个`,
      )
      check(
        before.hasBlock && before.labelAt >= 0,
        '🔴 S26 ② 卡里**有**一段「改密码」（用户点名：都放在身份卡里面）',
        `[data-change-password]=${before.hasBlock} · 标签序位 ${before.labelAt}`,
      )
      /* ⚠️ `shots.mjs` 只有 `check(cond, label, observed)` 这一个断言器（没有 `eq`）——
         这几条原来是 `eq(...)`（那是 `nav-checks.mjs` 里的），会 `ReferenceError` 把
         整节**在第一条断言之前**打断（2026-10-11 实测：脚本停在第 S26 步、125 那张图没产出）。
         所以这里一律写成 `check(...)` + `JSON.stringify` 比字面量，标签与口径一个字不改。 */
      const sameCard = [before.nameAt >= 0, before.subjAt >= 0, before.labelAt >= 0]
      check(
        sameCard.every(Boolean),
        '🔴 S26 ③ 它**与「姓名」「主学科」并列在同一张卡里**（姓名 / 主学科 / 改密码 三个标签都在）',
        JSON.stringify(sameCard),
      )
      check(
        before.labelAt > before.nameAt && before.labelAt > before.subjAt,
        'S26 ④ 它**排在姓名与主学科之后**（先"我是谁"，再"改我的密码"—— 顺序是有意的）',
        `姓名 @${before.nameAt} · 主学科 @${before.subjAt} · 改密码 @${before.labelAt}`,
      )
      check(
        before.passwordInputs === 3,
        '🔴 S26 ⑤ 三个格**都是密码格**（新密码不会明着写在屏上）',
        `${before.passwordInputs} 个密码格`,
      )
      check(
        JSON.stringify(before.autoComplete) === JSON.stringify(['current-password', 'new-password', 'new-password']),
        'S26 ⑥ 三个格分别是：现在的密码 / 新密码 / 新密码再输一遍（autocomplete 也各自对）',
        JSON.stringify(before.autoComplete),
      )
      check(
        JSON.stringify(before.buttons) === JSON.stringify(['改密码']),
        'S26 ⑦ 那段里只有**一颗按钮**（就是把密码改掉那颗；保存是下面整卡的按钮，不混在一起）',
        JSON.stringify(before.buttons),
      )
      check(
        JSON.stringify([before.err, before.ok]) === JSON.stringify(['', '']),
        'S26 ⑧ 还没输任何东西时**屏上不报错、也不报成功**（不许无中生有）',
        JSON.stringify([before.err, before.ok]),
      )

      const P = {
        old: p.getByPlaceholder('现在用的那一个'),
        next: p.getByPlaceholder('至少 8 位'),
        again: p.getByPlaceholder('两次要一样'),
      }

      /* ---- 第一档：太短（而且**不许静默提交**） ---- */
      await P.old.fill('now-pwd-ok')
      await P.next.fill('short7c')
      await P.again.fill('short7c')
      await p.waitForTimeout(150)
      await p.getByRole('button', { name: '改密码' }).first().click()
      await p.waitForTimeout(300)
      const short = await readPwd(p)
      check(
        /至少 8 位/.test(short.err) && /7/.test(short.err),
        '🔴 S26 ⑨ 新密码 7 位 → **屏上明写**"至少 8 位（现在 7 位）"，不静默、不假装成功',
        `err=${JSON.stringify(short.err)}`,
      )
      check(short.ok === '', 'S26 ⑨b 失败时**不是**"已经改好了"的样子（成功那块一个字都不出现）', JSON.stringify(short.ok))
      check(short.errRole === 'alert', 'S26 ⑨c 那一句是 `role="alert"`（读屏软件也会念出来）', JSON.stringify(short.errRole))
      await shot(p, 'S26：我的身份 · 自己改密码（失败显式上屏）', '125-settings-change-password', {
        full: false,
        wait: 320,
      })

      /* ---- 第二档：两次不一致（文案必须与"太短"**不是同一句**） ---- */
      await P.next.fill('newpass-9a')
      await P.again.fill('newpass-9b')
      await p.getByRole('button', { name: '改密码' }).first().click()
      await p.waitForTimeout(300)
      const miss = await readPwd(p)
      check(
        /不一致/.test(miss.err),
        '🔴 S26 ⑩ 两次不一致 → 屏上换成"两次输入的新密码不一致"（**不是**沿用上一档那句话）',
        `err=${JSON.stringify(miss.err)}`,
      )
      check(
        miss.err !== short.err && miss.err.includes('不一致') && short.err.includes('至少 8 位'),
        '🔴 S26 ⑪ 两档的**文案确实不同**（"太短 / 不一致"各自的错各自说 —— §三.5 不许一句话概括）',
        `太短=${JSON.stringify(short.err)} · 不一致=${JSON.stringify(miss.err)}`,
      )

      /* ---- 第三档：旧密码不对（本地模式没有账号 → 走的是"要连服务器"那一句） ---- */
      await P.again.fill('newpass-9a')
      await p.getByRole('button', { name: '改密码' }).first().click()
      await p.waitForTimeout(300)
      const third = await readPwd(p)
      check(
        third.err !== '' && third.err !== miss.err,
        '🔴 S26 ⑫ 前两档过了之后**还有第三句**（本地演示模式：说清"这一项要连上服务器才能用"）—— 不许沉默地什么都不做',
        `err=${JSON.stringify(third.err)}`,
      )

      /* 🧪 反向对照：把这一段从 DOM 里摘掉 → ② 与 S26-A 那条探针**当场判假** */
      const negS26 = await p.evaluate(() => {
        const blk = document.querySelector('[data-change-password]')
        if (blk && blk.parentNode) blk.parentNode.removeChild(blk)
        const sheets = [...document.querySelectorAll('.sheet, [role="dialog"]')]
        const sheet = sheets.find((s) => (s.textContent ?? '').includes('我的身份')) ?? null
        return { still: Boolean(sheet && sheet.querySelector('[data-change-password]')) }
      })
      check(
        negS26.still === false,
        '🧪 S26 反向对照：把 `[data-change-password]` 从 DOM 里摘掉 → ② 那条判据**当场判假**（证明它真的在页面上找这一段，不是恒真）',
        `摘掉之后还在 = ${negS26.still}`,
      )
      await c.close()
    })

    /*
     * ================= S27：🆕「课程管理」第 3 轮 —— **调课与冲突**（2026-10-12） =================
     *
     * 🔴 这一节是**上一轮的欠账 + 本轮**：第 2 轮（骨架）明知欠着 `shots` 的断言，
     *    这一节一次补齐（**每条都带反向对照** —— 没有反向对照的断言是摆设，§三.2）。
     *
     * 覆盖：
     *   ① 卡摆不摆（**正反两侧**：任课教师看不见 · 教务处看得见）
     *   ② 层级（年级 → 班级 → 课表）· 两态（录入 / 核对）· 三态（`data-course-mark`）
     *   ③ **两种模式真的分开**（临时 → `schedule_temp_changes` · 永久 → `schedule_items` + 留档）
     *      —— 断言**直接读源码**（经手 `from('schedule_temp_changes').insert` 的那一处
     *      与经手 `apply_perm_schedule_change` 的那一处是**两个不同的函数**），
     *      外加**反向对照**：把永久那一支也从临时那条路走 → 判据当场为假。
     *   ④ **永久那道"多勾一句"没勾就点不动**（+ 反向对照：勾上就能点）
     *   ⑤ **三类冲突分开列**，每条都有"冲突的另一半在哪个班"（+ 反向对照）
     *   ⑥ **走班班没名单 → 第③类显示灰**（不是绿也不是红）（+ 反向对照：染成绿 → 判假）
     *   ⑦ **建议真的能把硬冲突降下来**（照 v3 预览：照建议处理，硬冲突 2 → 1）
     *   ⑧ `locked` 那一支（新表不存在）**页面不崩**
     *
     * ⚠️ 跑的是**本地演示模式**（`isRemote === false`）：§38 那三张表本机没有，
     *    所以「临时 / 永久」两条路在**内存那一层**上量（`store.tempScheduleChanges` 与 `schedule_items`）
     *    —— 与远程模式读的是**同一份语义**；"真的落到了哪张表"由 ③ 那条**源码级**断言钉死。
     */
    await step('S27：课程管理（调课与冲突 · 临时 / 永久 · 三类冲突 · 建议）', async () => {
      const c = await browser.newContext({
        viewport: { width: 1440, height: 1040 },
        locale: 'zh-CN',
        deviceScaleFactor: 2,
      })
      /* 拨到周三 → 默认"今天"= 2026-09-16（周三）。演示课表里周三那一列是空的，
         所以下面显式把日期改成周一 2026-09-14 —— 那一天有两处故意排出来的冲突。 */
      await c.clock.install({ time: new Date('2026-09-16T10:00:00') })
      await c.addInitScript((st) => {
        window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }, TEACHER_STATE)

      /* ---------- ① 卡摆不摆：**任课教师看不见**（反向对照） ---------- */
      const p0 = await c.newPage()
      p0.on('pageerror', (e) => errors.push(`PAGEERROR(S27) :: ${e.message}`))
      await p0.goto(`${BASE}/manage`, { waitUntil: 'networkidle' })
      await p0.waitForTimeout(300)
      const noCard = await p0.locator('[data-course-card]').count()
      check(
        noCard === 0,
        '🔴 S27 ① 任课教师（没有管理身份）的「行政管理」页上**没有**「课程管理」那张卡',
        `[data-course-card] 实测 ${noCard} 个`,
      )
      /*
       * 🔴 **① 用完就把 p0 关掉**（2026-10-01 查 ㉗ 查出来的根因）。
       *
       * 同一个 context 里留着一个一直开着的页面，就等于**留着第二份内存**：
       * 每个文档都各自把**自己内存里那份状态**整份写进 `shugao.teacher.v1`（zustand persist），
       * 而 p0 那份内存里**没有临时层**（注入用的 `TEACHER_STATE` 里根本没有 `tempScheduleChanges` 这个键）。
       * 实测（临时探针记到的）：这一节在 p 上做完临时调课后 4 秒，p0 因为自己的一次状态变化
       * 把整个键重写成了 `temp=0 / len=50150` —— 正好把 p 写下的临时层盖掉，
       * 于是下面 ㉗/㉘ 读到"临时层 2 → 0"，而 p 自己的内存一直是 2（屏上还标着「这一天已调」）。
       *
       * ① 只用了它上面那四行；把它关掉之后，这个键就只剩 p 一个文档会写。
       */
      await p0.close()

      /* ---------- 用 `?as=admin`（教务处）注入身份 → 这一节剩下的都在这一页 ---------- */
      const p = await c.newPage()
      p.on('pageerror', (e) => errors.push(`PAGEERROR(S27) :: ${e.message}`))
      await p.goto(`${BASE}/manage?as=admin`, { waitUntil: 'networkidle' })
      await p.waitForTimeout(350)

      const cardN = await p.locator('[data-course-card]').count()
      check(
        cardN === 1,
        '🔴 S27 ② **教务处**的「行政管理」页上有「课程管理」那张卡（与 ① 构成正反对照）',
        `[data-course-card] 实测 ${cardN} 个`,
      )
      /* 点开 → 跳到它自己的页面（2026-09-30 改：**不再就地展开**） */
      await p.locator('[data-course-card]').first().click()
      await p.waitForTimeout(350)
      check(
        new URL(p.url()).pathname === '/manage/course' && (await p.locator('[data-course-open]').count()) === 0,
        '🔴 S27 ③ 点那张卡 → **跳到自己的页面 `/manage/course`**（不再是就地展开；`[data-course-open]` 已整块删掉）',
        `pathname=${new URL(p.url()).pathname} · [data-course-open]=${await p.locator('[data-course-open]').count()}`,
      )

      /* ---------- ② 层级（年级 → 班级）+ 三态锚点 ---------- */
      const grades = await p.locator('[data-course-grade]').allTextContents()
      check(
        grades.length >= 1 && grades.some((g) => g.includes('高二')),
        '🔴 S27 ④ 层级第一层 = **年级条**（教务处看到高二）',
        `年级条 ${grades.length} 个：${grades.map((g) => g.replace(/\s+/g, ' ').trim()).join(' / ')}`,
      )
      await p.locator('[data-course-grade]').first().click()
      await p.waitForTimeout(250)
      const cls = await p.locator('[data-course-class]').allTextContents()
      check(
        cls.length >= 2,
        '🔴 S27 ⑤ 层级第二层 = **班级行**（展开年级之后逐个班列出来）',
        `班级行 ${cls.length} 个：${cls.map((x) => x.replace(/\s+/g, ' ').trim()).join(' / ')}`,
      )
      /* 点一个班 → 右边出现它的课表 */
      await p.locator('[data-course-class]').first().click()
      await p.waitForTimeout(350)
      const hasGrid = await p.locator('[data-course-schedule]').count()
      check(
        hasGrid === 1,
        '🔴 S27 ⑥ 层级第三层 = **这个班的课表**（点班级行之后才出现）',
        `[data-course-schedule] 实测 ${hasGrid} 个`,
      )
      const reviewMode = await p.locator('[data-course-mode="review"]').count()
      const entryMode = await p.locator('[data-course-mode="entry"]').count()
      check(
        reviewMode + entryMode === 1,
        '🔴 S27 ⑦ 课表**只有两态之一**（录过了 = 核对模式 · 没录过 = 录入模式）—— 不许两个都在、也不许都不在',
        `review=${reviewMode} · entry=${entryMode}`,
      )
      await shot(p, 'S27：课程管理 · 骨架（年级 → 班级 → 课表）', '126-course-skeleton', {
        full: true,
        wait: 250,
      })

      /* ---------- ③ 调课日期（默认"今天"，用 beijingNow 算） ---------- */
      const dateVal = await p.locator('[data-course-date]').inputValue()
      check(
        dateVal === '2026-09-16',
        '🔴 S27 ⑧ 调课日期**默认是今天**，而且"今天"是按北京时间算出来的（假时钟拨到 09-16 周三）',
        `日期格实测 ${JSON.stringify(dateVal)}（期望 2026-09-16）`,
      )
      /* 改成周一（那一天有两处故意排出来的冲突） */
      await p.locator('[data-course-date]').fill('2026-09-14')
      await p.waitForTimeout(450)
      const hint = await p.locator('[data-course-date-hint]').textContent()
      check(
        (hint ?? '').includes('周一'),
        '🔴 S27 ⑨ 换一天之后那句话跟着换成"这一天是周一"（日期 → 星期几是对上的）',
        JSON.stringify((hint ?? '').trim()),
      )

      /* ---------- ③b 🆕 2026-10-13 第 5 轮：**整周视图**（整周网格 / 视图切换 / 底部图例） ----------
       * 为什么插在这里：这一段的日期已经被拨到 09-14（周一，演示数据里这一天有课），
       * 所以下面"切换前后 `data-course-cell` 数量逐个相等"那条**数的是真数**，不是 0 == 0 的空等式。
       * 🔴 这一段的最后必须**点回「这一天」** —— 后面 ④ 起还要靠 `data-course-mode="review"`
       *    与「这一天」那一支的 DOM，不收回来就会把整节的后半段带红。
       */
      const viewDay = p.locator('[data-course-view="day"]')
      const viewWeek = p.locator('[data-course-view="week"]')
      /*
       * 🔴 **默认值 2026-09-30 从「这一天」改成「整周」** —— 用户实测反馈「怎么还是这个界面」：
       *    点开一个班看到的是一列逐条列表（= 「这一天」那一档），而「整周」那颗按钮长在
       *    这块面板的**标题行**上，滚动之后根本看不见 →
       *    "整周视图已经做完了"这件事在屏上完全体现不出来（一个看不见的效果 = 白做）。
       *    ⚠️ 期望值是**跟着产品口径变的，不是为了让门禁变绿**：
       *      原来那条钉的是"默认是这一天"，现在钉的是"默认就是整周、进门第一眼就看得见"。
       */
      const weekPressed = await viewWeek.getAttribute('aria-pressed')
      const gridOnOpen = await p.locator('[data-course-week-grid]').count()
      check(
        weekPressed === 'true' && gridOnOpen === 1,
        '🔴 S27-W1 课表**点开一个班就是「整周」**（整周网格直接摆出来，不用先找到那颗按钮）',
        `[data-course-view="week"].aria-pressed=${JSON.stringify(weekPressed)} · [data-course-week-grid]=${gridOnOpen}`,
      )
      /* 切走**之前**先数一遍调课区那一层的口径 —— 下面 W5 拿它做等式的一半 */
      const cellBefore = await p.locator('[data-course-cell]').count()
      const emptyBefore = await p.locator('[data-course-empty]').count()
      /*
       * 🔴 2026-10-13 **整周网格表头显日期**（「周三 09-30」）——
       *    临时调课落库靠的是 `on_date`（一个具体日期），只写「每周」的话用户不知道自己点的是哪一周。
       */
      const weekDatesN = await p.locator('[data-course-week-date]').count()
      const weekDateVals = await p.locator('[data-course-week-date]').evaluateAll((els) =>
        els.map((e) => (e.textContent ?? '').trim()),
      )
      check(
        weekDatesN === 7 &&
          weekDateVals.every((v) => /^\d{2}-\d{2}$/.test(v)) &&
          new Set(weekDateVals).size === 7,
        '🔴 S27-W2a 整周网格**表头显日期**（`data-course-week-date` = 那一列的日期「03-02」这种七列七个**互不相同**的日期）—— 点整周格子做临时调课时，`on_date` 锚的就是它，用户得看得见锚在哪一天',
        `日期格=${weekDatesN} · 值=${JSON.stringify(weekDateVals)}`,
      )
      const headsN = await p.locator('[data-course-week-head]').count()
      const wCellsN = await p.locator('[data-course-week]').count()
      check(
        headsN === 7 && wCellsN > 0 && wCellsN % 7 === 0,
        '🔴 S27-W2 整周网格：7 列（周一~周日）× N 行（这一周真的出现过的时段）—— 格子数必是 7 的整数倍（一行 7 格，一格不许多也不许少）',
        `列表头=${headsN} · 格子=${wCellsN}（${wCellsN % 7 === 0 ? `${wCellsN / 7} 行` : '不是 7 的整数倍'}）`,
      )
      const wHasN = await p.locator('[data-course-week-cell]').count()
      const wEmptyN = await p.locator('[data-course-week-empty]').count()
      check(
        wHasN > 0 && wHasN + wEmptyN === wCellsN,
        '🔴 S27-W3 整周每一格**非此即彼**：「有课」挂 `data-course-week-cell`、空格挂 `data-course-week-empty` —— 两者之和必须**正好等于**格子总数（漏挂一格、或一格挂两个，都当场红）',
        `有课=${wHasN} · 空=${wEmptyN} · 合计=${wHasN + wEmptyN} · 格子=${wCellsN}`,
      )
      const leakCell = await p.locator('[data-course-week-grid] [data-course-cell]').count()
      const leakEmpty = await p.locator('[data-course-week-grid] [data-course-empty]').count()
      check(
        leakCell === 0 && leakEmpty === 0,
        '🔴 S27-W4 **反向对照的正面**：整周网格里**一个 `data-course-cell` / `data-course-empty` 都没有** —— 那两个属性是「这一天摆得出几格」的口径，S27 ⑫/⑬ 靠 `.first()` / `.last()` 点它们；整周网格挂上去就会点到整周里去（把这一条反着改一次，W4 与 W5 必红）',
        `整周里的 [data-course-cell]=${leakCell} · [data-course-empty]=${leakEmpty}`,
      )
      const legendRaw = await p.locator('[data-course-legend]').textContent()
      check(
        (legendRaw ?? '').includes('临时调课') && (legendRaw ?? '').includes('周末没有课'),
        '🔴 S27-W6 整周网格下面有**底部图例**：说清「有课 / 空 = 没课 / 临时调课（只这一天） / 撞课」，并且明说「周末没有课 —— 空白格子就是没课」（**周末的空格子 = 没课**这件事必须写在屏上，不能靠用户猜）',
        JSON.stringify((legendRaw ?? '').replace(/\s+/g, ' ').trim()),
      )
      await shot(p, 'S27：课程管理 · 整周视图（7 列 × 这一周出现过的时段 + 底部图例）', '130-course-week', {
        full: true,
        wait: 250,
      })
      await viewDay.click()
      await p.waitForTimeout(300)
      const backGridN = await p.locator('[data-course-week-grid]').count()
      const backReviewN = await p.locator('[data-course-mode="review"]').count()
      const backShowN = await p.locator('[data-course-show="all"]').count()
      check(
        backGridN === 0 && backReviewN === 1 && backShowN === 1,
        '🔴 S27-W7 点「这一天」→ 整周网格收起来、**核对那一块原样出现**（`data-course-mode="review"` 与「✓ 这 N 条教室里都会显示」都在）—— 核对流程一条没少，只是不再挡在进门第一眼',
        `week-grid=${backGridN} · review=${backReviewN} · show=${backShowN}`,
      )
      const cellAfter = await p.locator('[data-course-cell]').count()
      const emptyAfter = await p.locator('[data-course-empty]').count()
      check(
        cellBefore === cellAfter && emptyBefore === emptyAfter,
        '🔴 S27-W5 **切到「这一天」之后，调课区那一层一格都没变**（切换前后的 `data-course-cell` / `data-course-empty` **逐个数相等**）—— 整周是**加**了一层视图，不是改了原来那一层',
        `切换前（整周）${cellBefore}/${emptyBefore} → 切换后（这一天）${cellAfter}/${emptyAfter}`,
      )
      /* 切回「整周」= 进门第一眼那一档，后面的段落从这里往下走 */
      await viewWeek.click()
      await p.waitForTimeout(300)

      /* ---------- ④ 🆕 整周网格**直接点选** · 跨列也允许临时（2026-10-13） ---------- */
      /*
       * 用户原话：「为什么整周的视图不像预览一样，能够直接点选」+「跨列也允许临时，
       * 因为临时调课本身就会在一周内换」。
       *
       * 🔴 这几条专挑**同一个钟点出现在两个不同日期列**的两格来点 —— 那正是"格位号不够用"
       * 的现场（两格都叫「第 2 格」，只按节次号当 key 的话第二次选择会顶掉第一次）。
       */
      const multi = await p.evaluate(() => {
        const cells = [...document.querySelectorAll('[data-week-cell][data-course-week-cell]')]
        const byStart = new Map()
        for (const el of cells) {
          const k = el.getAttribute('data-week-cell') ?? ''
          const cut = k.indexOf('-')
          const start = k.slice(cut + 1)
          if (!byStart.has(start)) byStart.set(start, [])
          byStart.get(start).push({ wd: Number(k.slice(0, cut)), k })
        }
        for (const [start, arr] of byStart) {
          const first = arr[0]
          const other = arr.find((a) => a.wd !== first.wd)
          if (other) return { start, kA: first.k, kB: other.k, wdA: first.wd, wdB: other.wd }
        }
        return null
      })
      check(
        multi !== null,
        '🔴 S27-W9a **整周网格上找得到"同一个钟点出现在两天"的两格**（临时调课最常发生的情形 —— 把周三的课挪到周五同一个时段；两格的格位号一模一样）',
        multi
          ? `钟点=${multi.start} → 周${multi.wdA} [${multi.kA}] · 周${multi.wdB} [${multi.kB}]`
          : '整周网格里找不到同一个钟点出现在两天的两格',
      )
      if (multi) {
        await p.locator(`[data-week-cell="${multi.kA}"]`).click()
        await p.waitForTimeout(200)
        await p.locator(`[data-week-cell="${multi.kB}"]`).click()
        await p.waitForTimeout(350)
        /* 选中态：这两格亮（`data-picked-week="1"`），**并且整周网格里正好两格** */
        const pickedWeek = await p.locator('[data-picked-week="1"]').count()
        const pickedWeekKeys = await p
          .locator('[data-picked-week="1"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('data-week-cell')))
        check(
          pickedWeek === 2 &&
            pickedWeekKeys.includes(multi.kA) &&
            pickedWeekKeys.includes(multi.kB),
          '🔴 S27-W9 整周网格**每一格都能点选**（`data-picked-week="1"` 挂在选中的格上），而且**两格都还在** —— 跨列两格只按节次号当 key 的话，第二次点会把第一次顶掉（那一格只是"刚才选的那一格"还在）',
          `亮着 ${pickedWeek} 格 → ${JSON.stringify(pickedWeekKeys)}（点了 ${multi.kA} 与 ${multi.kB}）`,
        )
        /*
         * 🔴 2026-10-01 用户实测：「点了以后没有选中的提示框，老师不知道自己选没选中，只加这一个地方」。
         *    上面 W9 读的是**属性**（`data-picked-week`）——属性一直是对的，屏上却一点变化都没有，
         *    所以这一条量**算出来的颜色**（`getComputedStyle`）：属性对、屏上没变化，正是要抓的那件事。
         *    期望值**不写死**：直接拿下面「这一天」那栏**选中那一格**当基准（用户拍板的口径就是
         *    "两处同一套皮肤"：强调色边框 + 淡强调底），这样四套主题换令牌也不会误报，
         *    也不违反"页面里零十六进制"。
         */
        const weekSkin = await p.evaluate(
          ([ka, kb]) => {
            const g = (el, prop) => (el ? getComputedStyle(el)[prop] : null)
            const wA = document.querySelector(`[data-week-cell="${ka}"]`)
            const wB = document.querySelector(`[data-week-cell="${kb}"]`)
            const idle = [...document.querySelectorAll('[data-week-cell]')].find(
              (e) => e.getAttribute('data-picked-week') !== '1',
            )
            const dayPicked = document.querySelector('[data-picked="1"]')
            return {
              hasIdle: Boolean(idle),
              hasDay: Boolean(dayPicked),
              aBorder: g(wA, 'borderTopColor'),
              aBg: g(wA, 'backgroundColor'),
              bBorder: g(wB, 'borderTopColor'),
              bBg: g(wB, 'backgroundColor'),
              idleBorder: g(idle, 'borderTopColor'),
              idleBg: g(idle, 'backgroundColor'),
              dayBorder: g(dayPicked, 'borderTopColor'),
              dayBg: g(dayPicked, 'backgroundColor'),
            }
          },
          [multi.kA, multi.kB],
        )
        check(
          weekSkin.hasIdle &&
            weekSkin.hasDay &&
            weekSkin.aBorder === weekSkin.bBorder &&
            weekSkin.aBorder === weekSkin.dayBorder &&
            weekSkin.aBg === weekSkin.bBg &&
            weekSkin.aBg === weekSkin.dayBg &&
            weekSkin.aBorder !== weekSkin.idleBorder &&
            weekSkin.aBg !== weekSkin.idleBg,
          '🔴 S27-W9b 整周网格的选中态**屏上看得见**（强调色边框 + 淡强调底），而且与下面「这一天」那栏**算出来的颜色一模一样**（用户 2026-10-01 实测：「点了以后没有选中的提示框，老师不知道自己选没选中」）',
          `选中两格 边框=${weekSkin.aBorder} / ${weekSkin.bBorder} · 底=${weekSkin.aBg} / ${weekSkin.bBg} ‖ 没选的一格 边框=${weekSkin.idleBorder} · 底=${weekSkin.idleBg} ‖ 「这一天」那栏选中 边框=${weekSkin.dayBorder} · 底=${weekSkin.dayBg} · 找到未选格=${weekSkin.hasIdle} 找到下栏选中格=${weekSkin.hasDay}`,
        )
        /* 跨列两格 → 下面**并排两天**（`data-course-daycols="2"` + 两栏各带 `data-course-col`） */
        const dayColsN = await p.locator('[data-course-daycols]').getAttribute('data-course-daycols')
        const colWds = await p.locator('[data-course-col]').evaluateAll((els) =>
          els.map((e) => Number(e.getAttribute('data-course-col'))),
        )
        const colHeads = await p.locator('[data-course-colhead]').evaluateAll((els) =>
          els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()),
        )
        check(
          dayColsN === '2' &&
            colWds.length === 2 &&
            colWds.includes(multi.wdA) &&
            colWds.includes(multi.wdB),
          '🔴 S27-W10 跨列点两格 → 下面那一块**并排两天**（`data-course-daycols="2"`，两栏各挂 `data-course-col={星期几}` = 你点的那两天）—— 从前只摆 `date` 一天，跨列时用户看不见第二格是哪天',
          `data-course-daycols=${dayColsN} · 栏=[${colWds.join(',')}] · 表头=${JSON.stringify(colHeads)}`,
        )
        /* 两栏表头念的日期 = 整周表头那两列的日期（锚在哪一天用户得看得见） */
        const wdDateOf = async (wd) => {
          const d = await p.locator(`[data-course-week-date="${wd}"]`).textContent()
          return (d ?? '').trim()
        }
        const dateA = await wdDateOf(multi.wdA)
        const dateB = await wdDateOf(multi.wdB)
        const headHit = colHeads.filter((h) => h.includes(dateA) || h.includes(dateB)).length
        check(
          /^\d{2}-\d{2}$/.test(dateA) &&
            /^\d{2}-\d{2}$/.test(dateB) &&
            dateA !== dateB &&
            headHit === 2,
          '🔴 S27-W10b 并排那两栏的表头念的是**整周表头那两列的日期**（同一个钟点两天的两个日期，两栏各念一个）—— 跨列临时落库写 `on_date`，锚错了日期就成"屏上看着改了、实际哪天都没变"',
          `周${multi.wdA}→${dateA} · 周${multi.wdB}→${dateB} · 念对的栏头 ${headHit}/2 · ${JSON.stringify(colHeads)}`,
        )
        /* 预览 + 「教室端会变成什么样」跨列也得说得清是哪两天 */
        const planAttr = await p.locator('[data-course-plan]').getAttribute('data-course-plan')
        const planText = (await p.locator('[data-course-plan]').textContent()) ?? ''
        const hasWd = [1, 2, 3, 4, 5, 6, 7].some((wd) =>
          planText.includes(['周一', '周二', '周三', '周四', '周五', '周六', '周日'][wd - 1]),
        )
        check(
          planAttr === 'whole' && hasWd,
          '🔴 S27-W11 跨列两格选完**就有预览**（`data-course-plan="whole"`），预览里**带星期几**（不再是只说「第 N 节」—— 两格都叫第 2 格，不说星期几就分不清是哪一天那一格）',
          `data-course-plan=${JSON.stringify(planAttr)} · 带星期几=${hasWd} · ${JSON.stringify(planText.replace(/\s+/g, ' ').trim().slice(0, 160))}`,
        )
        /* 🧪 反向对照（源码级）：临时那一支写的是**每一格自己那一列的日期**，不是面板上的 `date` */
        const courseSrc2 = readFileSync(join(HERE, '..', 'src', 'pages', 'CourseAdmin.tsx'), 'utf8')
        const onDateCell = 'onDate: t.onDate'
        const wrongOnDate = courseSrc2.replace(onDateCell, 'onDate: t.wd.toString()')
        check(
          courseSrc2.includes(onDateCell) && !wrongOnDate.includes(onDateCell),
          '🧪 S27-W12 **反向对照**：临时那一支落库写的是 `onDate: t.onDate`（**那一格自己那一列的日期**）—— 换成面板上那个 `date`（永远是 `date` 那一天），跨列的第二格就锚回同一天、等于没跨',
          `原码里有「${onDateCell}」= ${courseSrc2.includes(onDateCell)} · 换成 onDate: date 之后还在 = ${wrongOnDate.includes(onDateCell)}`,
        )
        /* 清掉选中（**用产品行为**：再点一次那两格 = 取消），后面的段落从干净状态往下走 */
        await p.locator(`[data-week-cell="${multi.kA}"]`).click()
        await p.locator(`[data-week-cell="${multi.kB}"]`).click()
        await p.waitForTimeout(300)
        const pickedLeft = await p.locator('[data-picked-week="1"]').count()
        const colsLeft = await p.locator('[data-course-daycols]').getAttribute('data-course-daycols')
        check(
          pickedLeft === 0 && colsLeft === '1',
          '🔴 S27-W13 跨列那一对**取消得掉**（再点一次那两格 → `data-picked-week="1"` 归零、下面退回只摆一天）—— 整周网格点出来的选中态不是"点一下就赖在那儿"的',
          `还亮着 ${pickedLeft} 格 · data-course-daycols=${colsLeft}`,
        )
      }

      /* ---------- ④ 两种模式**分得明显**（两张并排的影响范围卡 + 两句话都要有） ---------- */
      const scopeTemp = await p.locator('[data-scope="temp"]').textContent()
      const scopePerm = await p.locator('[data-scope="perm"]').textContent()
      check(
        (scopeTemp ?? '').includes('只影响这一天') && (scopePerm ?? '').includes('以后每周都变'),
        '🔴 S27 ⑩ 两张并排的影响范围卡：临时 =「只影响这一天」· 永久 =「以后每周都变」',
        `临时=${JSON.stringify((scopeTemp ?? '').replace(/\s+/g, ' ').trim())} · 永久=${JSON.stringify((scopePerm ?? '').replace(/\s+/g, ' ').trim())}`,
      )
      const permNote = await p.locator('[data-course-scope-note="perm"]').textContent()
      const tempNote = await p.locator('[data-course-scope-note="temp"]').textContent()
      check(
        (permNote ?? '').includes('以后每个') && (tempNote ?? '').includes('只有'),
        '🔴 S27 ⑪ **两种各自的"教室端会变成什么样"那句话都在**（用户最关心这一句）',
        `临时=${JSON.stringify((tempNote ?? '').trim())} · 永久=${JSON.stringify((permNote ?? '').trim())}`,
      )

      /* ---------- ⑤ 「只换老师」= 科目不动（换完科目一个字不变，只有老师换） ---------- */
      const cellsOf = () =>
        p.evaluate(() =>
          [...document.querySelectorAll('[data-course-cell]')].map((b) => ({
            period: Number(b.getAttribute('data-course-cell')),
            text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
          })),
        )
      /*
       * 🔴 **"哪一天有课"要先量出来，不许假定**（2026-10-12 实测：假定周一那一列一定有课，
       *    而这一轮跑的库/夹具里那几天可能本来就没课 → 0 格、后面整节断在"点不到第 1 格"）。
       * 做法：在**同一周里逐个试**（周一 … 周日），挑第一个真的摆得出格子的那一天；
       * 找不到就如实报红（那时候才是"页面的错"，不是"这天没课"）。
       */
      let before = await cellsOf()
      let usedDate = '2026-09-14'
      for (const d of [
        '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
        '2026-09-18', '2026-09-19', '2026-09-20',
      ]) {
        await p.locator('[data-course-date]').fill(d)
        await p.waitForTimeout(400)
        before = await cellsOf()
        if (before.length >= 2) {
          usedDate = d
          break
        }
      }
      check(
        before.length >= 2,
        '🔴 S27 ⑫ 挑一天有课的日子，这一天的课**逐格摆得出来**（≥2 格才点得成"两格换"）',
        `${usedDate} 摆出 ${before.length} 格`,
      )
      /*
       * 🔴 **点哪两格要按实际摆出来的那两格点，不许写死 `1` / `2`**（2026-10-12 实测到的第二层原因）：
       *    `buildDayCells` 的 `period` 是**摆出来的序号**（`i + 1`），不是"第几节" ——
       *    周一这个班实际是**第 1 节与第 6 节**（中间 2~5 节是别的班的课，不在这个班的课表里）。
       *    写死 `[data-course-cell="2"]` 会点空 → 只选中一格 → 没有预览 → 后面整节断在
       *    `[data-course-teacherpick]` 取选项超时（⑫ 绿了、⑬ 红，就是这一处的原貌）。
       */
      const periods = before.map((b) => b.period)

      await p.locator('[data-kind="teacher"]').click()
      await p.waitForTimeout(200)
      await p.locator('[data-course-cell]').first().click()
      await p.locator('[data-course-cell]').last().click()
      await p.waitForTimeout(300)
      const planTeacher = await p.locator('[data-course-plan="teacher"]').count()
      check(
        planTeacher === 1,
        '🔴 S27 ⑬ 「只换老师」选两格之后，预览上明写 `data-course-plan="teacher"`（与"整格换"是两种预览）',
        `kind=teacher 的预览 ${planTeacher} 个 · 这一天的格子节次 ${JSON.stringify(periods)}`,
      )
      /* 选一个换的老师（下拉里挑第二位） */
      const sel = p.locator('[data-course-teacherpick]').first()
      const optVal = await sel.locator('option').nth(1).getAttribute('value')
      await sel.selectOption(optVal ?? '')
      await p.waitForTimeout(300)
      const planText = await p.locator('[data-course-plan="teacher"]').textContent()
      /*
       * 🔴 **科目要单独从 DOM 里取，不许拿整格文本去 `includes`**（2026-10-12 实测 ⑭ 红）：
       *    这一格的文本是「第 1 节 08:00**物理** · 王琳鑫」—— 节次/时间在**同一段文本**里、
       *    和科目**中间没有空格**（两段 span 连着）。所以按"·"切开的 `[0]` 是 `第 1 节 08:00物理`，
       *    拿它去 `includes` 在**任何**预览里都不成立 → 这条判据变成**永远为红**的摆设
       *    （它红的样子不是"科目变了"，而是"我切错了"）。
       *    ✅ 取每一格**第二个 span**（科目那一格）自己的文本 —— 与摆格子用的是同一处 DOM。
       */
      const subjOfCell = (np) =>
        p.evaluate((n) => {
          const btn = document.querySelector(`[data-course-cell="${n}"]`)
          return (btn?.querySelectorAll('span')[1]?.textContent ?? '').split('·')[0].trim()
        }, np)
      const subjBefore = await subjOfCell(before[0].period)
      check(
        Boolean(subjBefore) && (planText ?? '').includes(subjBefore),
        '🔴 S27 ⑭ **只换老师 = 科目不动**：预览里换完那一格写着的还是同一门课',
        `换前第一格 ${JSON.stringify(before[0].text)}（科目取 ${JSON.stringify(subjBefore)}） · 预览 ${JSON.stringify((planText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))}`,
      )
      const clsLine = await p.locator('[data-course-classroom="temp"]').textContent()
      check(
        (clsLine ?? '').includes('第二天自动恢复'),
        '🔴 S27 ⑮ 临时那一档的预览里，**"教室端会变成什么样"**明写"第二天自动恢复"',
        JSON.stringify((clsLine ?? '').trim()),
      )
      const back0 = await p.locator('[data-course-plan]').count()
      check(back0 === 1, '🔴 S27 ⑯ 未点确认之前**什么都不改**（预览在、课表还没动）', `还只有预览：${back0}`)

      /* 走完临时那一条：确认 → 落进"临时调课"那一层 */
      await p.locator('[data-course-apply]').click()
      await p.waitForTimeout(350)
      const confirmTemp = await p.locator('[data-course-confirm="temp"]').count()
      check(
        confirmTemp === 1,
        '🔴 S27 ⑰ 确认弹层上明写**这是哪一层**（`data-course-confirm="temp"` = 临时）',
        `data-course-confirm=temp 实测 ${confirmTemp} 个`,
      )
      /* 🔴 临时那一档**不该**有那道"多勾一句"（它是永久专有的） */
      const ackInTemp = await p.locator('[data-course-permack]').count()
      check(
        ackInTemp === 0,
        '🔴 S27 ⑱ **临时那一档没有**"我知道以后每周都会变"那一句（它是永久专有的 —— 两种模式真的分开）',
        `临时弹层里 [data-course-permack] 实测 ${ackInTemp} 个`,
      )
      await p.locator('[data-course-doconfirm]').click()
      await p.waitForTimeout(500)
      const tempLanded = await p.evaluate(() => {
        const raw = window.localStorage.getItem('shugao.teacher.v1')
        if (!raw) return null
        const st = JSON.parse(raw)?.state ?? {}
        return { temp: (st.tempScheduleChanges ?? []).length }
      })
      check(
        (tempLanded?.temp ?? 0) >= 1,
        '🔴 S27 ⑲ 临时那一档确认之后，落进的是**临时调课那一层**（`tempScheduleChanges` 多了一条）',
        `tempScheduleChanges = ${tempLanded?.temp}`,
      )
      await shot(p, 'S27：临时调课落进"只影响这一天"那一层', '127-course-temp-apply', {
        full: true,
        wait: 250,
      })

      /* ---------- ⑥ 永久那一档：**多勾一句才点得动** ---------- */
      await p.locator('[data-scope="perm"]').click()
      await p.waitForTimeout(250)
      /* 🔴 临时那一档落完之后**重新量一次格子**：`period` 是摆出来的序号，
         而"这一天有几格"由当前状态（周课表 + 临时那一条）决定 —— 不写死、不沿用旧读数。 */
      const afterTemp = (await cellsOf()).map((c) => c.period)
      const pair2 = [afterTemp[0] ?? pair[0], afterTemp[1] ?? afterTemp[0] ?? pair[1]]
      await p.locator(`[data-course-cell="${pair2[0]}"]`).click()
      await p.locator(`[data-course-cell="${pair2[1]}"]`).click()
      await p.waitForTimeout(300)
      await p.locator('[data-course-apply]').click()
      await p.waitForTimeout(350)
      const confirmPerm = await p.locator('[data-course-confirm="perm"]').count()
      check(
        confirmPerm === 1,
        '🔴 S27 ⑳ 选「永久调课」时，确认弹层明写 `data-course-confirm="perm"`（与临时是两种弹层）',
        `data-course-confirm=perm 实测 ${confirmPerm} 个`,
      )
      const ackRow = await p.locator('[data-course-permack]').count()
      check(
        ackRow === 1,
        '🔴 S27 ㉑ 永久那一档**多出**那句"我知道：以后每周都会变，不是只改这一天"',
        `[data-course-permack] 实测 ${ackRow} 个`,
      )
      const permCls = await p.locator('[data-course-classroom="perm"]').textContent()
      check(
        (permCls ?? '').includes('不会自己恢复'),
        '🔴 S27 ㉒ 永久那一档的"教室端会变成什么样"明写**不会自己恢复**（与临时的"第二天自动恢复"不同一句）',
        JSON.stringify((permCls ?? '').trim()),
      )
      const disabledBefore = await p.locator('[data-course-doconfirm]').isDisabled()
      check(
        disabledBefore === true,
        '🔴 S27 ㉓ **没勾那一句 → 确认钮是禁用的**（点不动）',
        `勾之前 isDisabled=${disabledBefore}`,
      )
      await shot(p, 'S27：永久调课 · 没勾那句就点不动', '128-course-perm-gate', {
        full: false,
        wait: 250,
      })
      /* 反向对照：勾上 → 就能点 */
      await p.locator('[data-course-permack] input[type="checkbox"]').check()
      await p.waitForTimeout(250)
      const disabledAfter = await p.locator('[data-course-doconfirm]').isDisabled()
      check(
        disabledAfter === false,
        '🧪 S27 ㉓b **反向对照**：把那一句勾上 → 确认钮**就能点**了（证明 ㉓ 真的在看那个勾，不是恒红）',
        `勾之后 isDisabled=${disabledAfter}`,
      )

      /* ---------- ⑦ 🔴 两种模式真的分开（**源码级**：两条路经手两个不同的函数） ---------- */
      const src = readFileSync(join(HERE, '..', 'src', 'data', 'remote.ts'), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const tempFn = code.slice(code.indexOf('export async function saveTempScheduleChange'))
      const tempBody = tempFn.slice(0, tempFn.indexOf('\nexport '))
      const permFn = code.slice(code.indexOf('export async function applyPermScheduleChange'))
      const permBody = permFn.slice(0, permFn.indexOf('\nexport '))
      check(
        /from\(\s*'schedule_temp_changes'\s*\)/.test(tempBody) &&
          /insert\(/.test(tempBody) &&
          !/apply_perm_schedule_change/.test(tempBody),
        '🔴 S27 ㉔ **临时那一支**走的是 `schedule_temp_changes` 的 insert（**不碰** `apply_perm_schedule_change`）',
        `临时那一段里 from('schedule_temp_changes')=${/from\(\s*'schedule_temp_changes'\s*\)/.test(tempBody)} · 出现 apply_perm…=${/apply_perm_schedule_change/.test(tempBody)}`,
      )
      check(
        /apply_perm_schedule_change/.test(permBody) &&
          !/from\(\s*'schedule_temp_changes'\s*\)/.test(permBody),
        '🔴 S27 ㉕ **永久那一支**走的是 `apply_perm_schedule_change`（**不碰** `schedule_temp_changes`）',
        `永久那一段里 apply_perm…=${/apply_perm_schedule_change/.test(permBody)} · 出现 schedule_temp_changes=${/from\(\s*'schedule_temp_changes'\s*\)/.test(permBody)}`,
      )
      check(
        permBody !== '' && tempBody !== '' && permBody !== tempBody,
        '🔴 S27 ㉖ 这两支**是两个不同的函数体**（不是一支里分两个 if —— 那样"分得明显"就只是字面上的）',
        `两段长度 ${tempBody.length} / ${permBody.length}`,
      )
      /* 🧪 反向对照：把永久也写成临时（**这就是那条 bug 的形状**）→ ㉕ 当场判假 */
      const negPerm = permBody.replace('apply_perm_schedule_change', "'schedule_temp_changes'")
      check(
        !/apply_perm_schedule_change/.test(negPerm),
        '🧪 S27 ㉖b **反向对照**：把永久那一支改成也走临时那条路（把"每周都变"写成"只这一天"）→ ㉕ 那条判据**当场判假**',
        `改写之后仍含 apply_perm…=${/apply_perm_schedule_change/.test(negPerm)}`,
      )
      /* ---------- ⑦b 🆕 「腾空一格」+「同一节改第二次」：走库里那个函数（§38.7b） ---------- */
      check(
        /apply_temp_schedule_change/.test(tempBody) &&
          /isMissingRpc\(error\)/.test(tempBody) &&
          /from\(\s*'schedule_temp_changes'\s*\)/.test(tempBody),
        '🔴 S27-W8 临时那一支走 **`apply_temp_schedule_change()`**（§38.7b：撤回 + 写一条在**同一个事务**里 —— 否则"撤回成功、插入失败"会留下"旧那条再也回不来"的洞），而且**留了 §38.7b 没跑时的显式退路**（认不出这个函数 → 退回直接 insert，**不许把调课弄坏**、也不许静默）',
        `出现 apply_temp…=${/apply_temp_schedule_change/.test(tempBody)} · 出现 isMissingRpc(error)=${/isMissingRpc\(error\)/.test(tempBody)} · 仍有 insert 退路=${/from\(\s*'schedule_temp_changes'\s*\)/.test(tempBody)}`,
      )
      /* 内存那一层的分工：永久那一次**没有**往临时层加东西。
       * ⚠️ 这一条**两路一起读**：`localStorage` 那一行是**同一个 context 里所有文档共用**的
       *    （`addInitScript` 注入的 `TEACHER_STATE` 里没有 `tempScheduleChanges`，凡是从它水合出来的
       *    文档，只要自身状态变一次，zustand persist 就会把**整份**快照写回去，把这一层抹平 ——
       *    2026-10-01 这条判据反复假红就是这么来的，见 ① 后面那段注释）。
       *    所以判据落在**产品自己的状态**上：屏上那几格还挂着「这一天已调」；
       *    存储那一行照旧比（它要是被别的文档写成 0，这里也看得见）。 */
      await p.locator('[data-course-doconfirm]').click()
      const afterPermShot = await p.evaluate(() => {
        const raw = window.localStorage.getItem('shugao.teacher.v1')
        const st = raw ? JSON.parse(raw)?.state ?? {} : {}
        const cells = [...document.querySelectorAll('[data-course-cellid]')]
        return {
          temp: (st.tempScheduleChanges ?? []).length,
          marked: cells.filter((e) => (e.textContent ?? '').includes('这一天已调')).length,
          cells: cells.length,
        }
      })
      check(
        afterPermShot.temp === tempLanded?.temp && afterPermShot.marked >= 1,
        '🔴 S27 ㉗ 永久那一次确认之后**立刻**再看：临时那一层原样在（存储与屏上两路同时看）',
        `临时层 ${tempLanded?.temp} → 存储 ${afterPermShot.temp} · 屏上「这一天已调」${afterPermShot.marked}/${afterPermShot.cells} 格`,
      )
      await p.waitForTimeout(500)
      const afterPerm = await p.evaluate(() => {
        const raw = window.localStorage.getItem('shugao.teacher.v1')
        const st = raw ? JSON.parse(raw)?.state ?? {} : {}
        return { temp: (st.tempScheduleChanges ?? []).length, schedule: (st.schedule ?? []).length }
      })
      check(
        afterPerm.temp === tempLanded?.temp,
        '🔴 S27 ㉘ 永久那一次确认之后，**临时那一层仍然一条不多**（永久没有偷偷从临时那条路走）',
        `临时层 ${tempLanded?.temp} → ${afterPerm.temp} · 周课表 ${afterPerm.schedule} 条`,
      )

      /* ---------- ⑧ 三类冲突分开列 + 建议把硬冲突降下来 ---------- */
      const heads = await p.evaluate(() =>
        [...document.querySelectorAll('[data-course-conflict-head]')].map((e) => ({
          kind: e.getAttribute('data-course-conflict-head'),
          text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
      )
      check(
        heads.length === 3,
        '🔴 S27 ㉙ 冲突区**就是三段**：① 老师 · ② 同一个班 · ③ 走班学生（**别糊成一句"有冲突"**）',
        heads.map((h) => `${h.kind}:${h.text}`).join(' | '),
      )
      const kinds = heads.map((h) => h.kind).join(',')
      check(
        kinds === 'teacher,class,student',
        '🔴 S27 ㉚ 三段的顺序与名字就是 `teacher / class / student`（与数据库 `schedule_conflicts_on().kind` 同一组值）',
        kinds,
      )
      const conflictRows = await p.evaluate(() =>
        [...document.querySelectorAll('[data-course-conflict]')].map((e) => ({
          kind: e.getAttribute('data-course-conflict'),
          text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
        })),
      )
      check(
        conflictRows.length >= 2,
        '🔴 S27 ㉛ 这一天**真的列出冲突**（周一那一列有两处故意排出来的）',
        conflictRows.map((r) => `${r.kind}:${r.text.slice(0, 60)}`).join(' || '),
      )
      check(
        conflictRows.length > 0 &&
          conflictRows.every(
            (r) => r.text.includes('冲突的另一半在') || r.text.includes('冲突的两半都在这个班里'),
          ),
        '🔴 S27 ㉜ **每条冲突都说清"冲突的另一半在哪个班"**（不许只说"有冲突"）',
        conflictRows.map((r) => String(r.text.includes('冲突的另一半在'))).join(','),
      )
      const jumps = await p.evaluate(() =>
        [...document.querySelectorAll('[data-course-jump]')].map((e) =>
          e.getAttribute('data-course-jump'),
        ),
      )
      check(
        jumps.length >= 2 && jumps.every((x) => Boolean(x)),
        '🔴 S27 ㉝ 班名是**可点的**（`data-course-jump=班 id`）—— 点了跳到那个班的调课界面',
        `可点班名 ${jumps.length} 个：${jumps.join(',')}`,
      )
      /* 🧪 反向对照：把"另一半在哪个班"那一句从 DOM 里抹掉 → ㉜ 当场判假 */
      const negHalf = await p.evaluate(() => {
        const hit = () =>
          [...document.querySelectorAll('[data-course-conflict]')].filter((e) =>
            (e.textContent ?? '').includes('冲突的另一半在'),
          ).length
        const before = hit()
        for (const e of document.querySelectorAll('[data-course-conflict]')) {
          const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
          while (walk.nextNode()) {
            if ((walk.currentNode.nodeValue ?? '').includes('冲突的另一半在')) {
              walk.currentNode.nodeValue = ''
            }
          }
        }
        return { before, after: hit() }
      })
      check(
        negHalf.before > 0 && negHalf.after === 0,
        '🧪 S27 ㉞ **反向对照**：把"冲突的另一半在：X班"那一句抹掉 → ㉜ 那条判据**当场判假**（证明它真的在页面上找那句话）',
        `抹之前 ${negHalf.before} 条命中 · 抹之后 ${negHalf.after} 条`,
      )

      /* ---------- ⑨ 走班那一档：**没名单 = 灰**（不是绿也不是红） ---------- */
      const grayN = await p.locator('[data-course-conflict-state="gray"]').count()
      const greenN = await p.locator('[data-course-conflict-state="ok"]').count()
      check(
        greenN === 0,
        '🔴 S27 ㉟ 第③档**没有**被染成"绿"（`data-course-conflict-state="ok"` 一处都没有）',
        `ok 档实测 ${greenN} 个 · gray 档 ${grayN} 个`,
      )
      /* 🧪 反向对照：把那处灰改成绿 → ㉟ 当场判假 */
      const negGray = await p.evaluate(() => {
        const el = document.querySelector('[data-course-conflict-state="gray"]')
        const had = Boolean(el)
        if (el) el.setAttribute('data-course-conflict-state', 'ok')
        return { had, after: document.querySelectorAll('[data-course-conflict-state="ok"]').length }
      })
      check(
        negGray.had ? negGray.after > 0 : true,
        '🧪 S27 ㊱ **反向对照**：把那处"灰"改成"绿"→ ㉟ 那条判据**当场判假**（说明它盯的是那个属性值本身）',
        `改之前 gray=${grayN} · 改成 ok 之后 ok 命中 ${negGray.after} 处`,
      )
      await p.evaluate(() => {
        const els = [...document.querySelectorAll('[data-course-conflict-state="ok"]')]
        if (els.length) els[els.length - 1].setAttribute('data-course-conflict-state', 'gray')
      })

      await shot(p, 'S27：三类冲突分开列（老师 / 同一个班 / 走班学生）', '129-course-conflicts', {
        full: true,
        wait: 250,
      })

      /* ---------- ⑪ 选中 / 取消选中（用户 2026-10-12 实测的第①个 bug） ---------- */
      /* 先把日期拨回周三那一列有课的「这一天」无所谓 —— 用的是**班级选中**，与日期无关 */
      await p.locator('[data-course-close]').click()
      await p.waitForTimeout(300)
      check(
        (await p.locator('[data-course-schedule]').count()) === 0,
        '🔴 S27 ㊷ 课表右上角那枚「收起」→ 回到「**什么都没选**」的状态（右边那一块整块收掉）',
        `收起之后 [data-course-schedule]=${await p.locator('[data-course-schedule]').count()}`,
      )
      /* 再选一次，然后点【同一个班】→ 应当**取消选中**（而不是原地再选一次） */
      await p.locator('[data-course-class]').first().click()
      await p.waitForTimeout(300)
      const firstCls = await p.locator('[data-course-class]').first().getAttribute('data-course-class')
      const back = await p.locator('[data-course-schedule]').count()
      check(
        back === 1,
        '🔴 S27 ㊸ 再点一个班 → 它的课表出现（对照组：上一步收掉之后确实能重新选上）',
        `[data-course-schedule]=${back}`,
      )
      await p.locator(`[data-course-class][data-course-class="${firstCls}"]`).click()
      await p.waitForTimeout(300)
      const afterSame = await p.locator('[data-course-schedule]').count()
      check(
        afterSame === 0,
        '🔴 S27 ㊹ **点【已经选中】的那个班 → 取消选中**（用户点名的第①个 bug：原来点它没反应、回不到"没选"）',
        `再点同一个班之后 [data-course-schedule]=${afterSame}`,
      )
      /* 🧪 反向对照：把这个 `: null` 去掉（就是改之前的行为）→ ㊹ 当场判假 */
      const courseSrc = readFileSync(join(HERE, '..', 'src', 'pages', 'CourseAdmin.tsx'), 'utf8')
      const toggleExpr = courseSrc.match(/const toggleClass = \(id: string\) =>[^\n]*/)
      const negToggle = toggleExpr ? toggleExpr[0].replace('classId === id ? null : id', 'id') : ''
      check(
        Boolean(toggleExpr) && !/null/.test(negToggle),
        '🧪 S27 ㊹b **反向对照**：把 `toggleClass` 里的 `: null` 去掉（= 改之前"点了只会再选上"的那一版）→ ㊹ 那条判据**当场判假**',
        `原文=${JSON.stringify((toggleExpr ?? [''])[0].trim().slice(-40))} · 改后还有 null=${/null/.test(negToggle)}`,
      )

      /* ---------- ⑫ 换年级 → 清掉选中的班（用户点名的第②个 bug） ---------- */
      await p.locator('[data-course-class]').first().click()
      await p.waitForTimeout(300)
      const beforeSwitch = await p.locator('[data-course-schedule]').count()
      /* 点**另一个**年级（同一个年级之外的那一条） */
      const gradeCount = await p.locator('[data-course-grade]').count()
      if (gradeCount > 1) {
        await p.locator('[data-course-grade]').nth(1).click()
        await p.waitForTimeout(350)
        const afterSwitch = await p.locator('[data-course-schedule]').count()
        check(
          beforeSwitch === 1 && afterSwitch === 0,
          '🔴 S27 ㊺ **换一个年级 → 选中的班被清掉**（用户点名的第②个 bug：留着一个"看不见的选中"，右边还显示别的年级的班）',
          `换之前 [data-course-schedule]=${beforeSwitch} · 换之后 ${afterSwitch}`,
        )
        /* 🧪 反向对照：把 toggleGrade 里那句清选中去掉 → ㊺ 当场判假 */
        const gradeExpr = courseSrc.match(/const toggleGrade = \(key: string\) => \{[\s\S]{0,400}?\n  \}/)
        const negGrade = gradeExpr ? gradeExpr[0].replace('if (classId) pickClass(null)', '') : ''
        check(
          Boolean(gradeExpr) && !/pickClass\(null\)/.test(negGrade),
          '🧪 S27 ㊺b **反向对照**：把 `toggleGrade` 里那句 `if (classId) pickClass(null)` 去掉 → ㊺ 那条判据**当场判假**',
          `原文里有清选中 = ${/pickClass\(null\)/.test(gradeExpr ? gradeExpr[0] : '')} · 去掉之后还在 = ${/pickClass\(null\)/.test(negGrade)}`,
        )
      } else {
        check(false, '🔴 S27 ㊺ 换年级清选中：**至少要有两个年级可选**（不然这一条量不了）', `年级条只有 ${gradeCount} 条`)
      }

      /* ---------- ⑬ `/manage/course` 真的能到（本轮新落的那条独立路由） ---------- */
      const p2 = await c.newPage()
      p2.on('pageerror', (e) => errors.push(`PAGEERROR(S27) :: ${e.message}`))
      await p2.goto(`${BASE}/manage/course?as=admin`, { waitUntil: 'networkidle' })
      /*
       * 🔴 **轮询等它出现，不要 `waitForTimeout(400)` 然后直接数**（2026-10-03 修）：
       *   这一页要**先把 store hydrate 完**才渲染出课程管理那一段，
       *   而 400ms 顶不住 —— 它间歇性地返回 `[data-course-admin]=0`，
       *   **页面其实好好的**（pathname 也对）。
       *   ⚠️ 这跟本轮改的东西无关（`/manage/course` 不碰 fileOut / backup / Classroom），
       *   是一条**本来就脆**的断言。但它红着就会让人去查错方向 —— 所以修掉。
       *   「把等待调大」只能缓解，「轮询到出现为止」才是真的不脆。
       */
      await p2
        .locator('[data-course-admin]')
        .waitFor({ state: 'attached', timeout: 8000 })
        .catch(() => {
          /* 故意吞掉：下面那条 check 会把"没等到"报成一条红断言，
             这里抛出去会让整个 step 中断、后面几百条断言都不跑（门禁自己也要能红，
             但"没找到元素"不等于"脚本崩了" —— 要的是一条红，不是一次中断）。 */
        })
      const onPage =
        new URL(p2.url()).pathname === '/manage/course' &&
        (await p2.locator('[data-course-admin]').count()) === 1
      check(
        onPage,
        '🔴 S27 ㊻ `/manage/course` **真的能到**（独立页面，页面里就是课程管理那一段）',
        `pathname=${new URL(p2.url()).pathname} · [data-course-admin]=${await p2.locator('[data-course-admin]').count()}`,
      )
      /* 🔴 四套主题（亮/暗 × 蓝/紫）下都看得到 —— 课表骨架不是"某一套主题才画得出来" */
      const themes = []
      for (const theme of ['light', 'dark']) {
        for (const accent of ['blue', 'purple']) {
          await p2.evaluate(
            ([t, a]) => {
              const raw = window.localStorage.getItem('shugao.teacher.v1')
              const st = raw ? JSON.parse(raw) : { state: {}, version: 1 }
              st.state.prefs = { theme: t, accent: a }
              window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(st))
            },
            [theme, accent],
          )
          await p2.reload({ waitUntil: 'networkidle' })
          await p2.waitForTimeout(300)
          const n = await p2.locator('[data-course-admin]').count()
          const visible = await p2.locator('[data-course-admin]').first().isVisible()
          themes.push(`${theme}/${accent}:${n > 0 && visible ? 'ok' : 'NO'}`)
        }
      }
      check(
        themes.every((t) => t.endsWith('ok')),
        '🔴 S27 ㊼ **四套主题下这一页都看得到**（亮/暗 × 蓝/紫 —— 课表那一段不是靠某一套主题才画得出来）',
        themes.join(' · '),
      )
      /* 🧪 反向对照：把路由从 App.tsx 里摘掉（内存里模拟"没有这条路由"）→ ㊻ 当场判假 */
      const appSrc = readFileSync(join(HERE, '..', 'src', 'App.tsx'), 'utf8')
      check(
        /path="\/manage\/course"/.test(appSrc) && !/path="\/manage\/course"/.test(appSrc.replace('path="/manage/course"', '')),
        '🧪 S27 ㊽ **反向对照**：`App.tsx` 里**真的**有 `path="/manage/course"` 那一行 —— 把它摘掉，㊻ 那条判据当场判假',
        `找到 = ${/path="\/manage\/course"/.test(appSrc)}`,
      )
      await p2.close()

      /* ---------- ⑭ 建议真的能把硬冲突降下来（照 v3 预览：硬冲突 2 → 1） ---------- */
      /* 🔴 ⑫ 按设计点了"另一个年级"（高一 0 个班）→ 之后**没有重新选班** → 冲突区整块不渲染
         → 起点 `hardCount=0`（㊲ 红）。这里把"选一个真有课的班"补上 —— 不补就量不到那一段。 */
      await p.locator('[data-course-grade]').first().click()
      await p.locator('[data-course-class]').first().click()
      await p.waitForTimeout(400)
      /*
       * 🔴 **必须先把"这一笔改动管多久"拨回「临时调课」。**
       *
       * 上面 ⑳ 选过"永久"，而重选班级只清 `permAck`、**不清 `tweak`**
       * （`CourseAdmin.tsx:1098`），所以这一刻模式还停在"永久"上。
       *
       * 而下面 ㊴ 那两条建议里，「把 物理 这节挪到 第 N 节」命中的是
       * **一格有课 + 一格空位** —— 永久那一档**按设计就要拒**这一种：
       * `schedule_items` 里没有"空课"那一行，整笔都不落，并显式说一句
       * 「永久调课…做不到把一节腾空…把课挪到空位请用「临时调课」那一档」
       * （`CourseAdmin.tsx:1000`）。
       *
       * 于是"点确认"要么点在一个 `disabled` 的钮上（超时 30 秒）、要么落不下去，
       * 硬冲突自然 3 → 3。
       *
       * ⚠️ ㊶ 要量的是**建议是不是摆设**，不是永久那一档的闸门 ——
       *    所以这里显式拨到临时那一档（`data-scope="temp"`，与 ⑩ 同一组按钮）。
       * ⚠️ **"永久做不到腾空、并当场说清"是产品的正确行为，一个字没改**
       *    （它的判据在 `CourseAdmin.tsx:1000`，不在这里）。
       */
      await p.locator('[data-scope="temp"]').click()
      await p.waitForTimeout(250)
      /** 页面上"还剩几处硬冲突"——只在确认弹层里写着，这里按三段里 teacher/class 的条目数现数 */
      const hardCount = () =>
        p.evaluate(
          () =>
            document.querySelectorAll('[data-course-conflict="teacher"]').length +
            document.querySelectorAll('[data-course-conflict="class"]').length,
        )
      const hardBefore = await hardCount()
      check(
        hardBefore >= 1,
        '🔴 S27 ㊲ 起点：这一天**真的有硬冲突**（老师撞课 / 同一个班压两节）',
        `硬冲突 ${hardBefore} 处`,
      )
      /* 点开一条硬冲突 → 看建议 */
      const card = p.locator('[data-course-conflict="class"], [data-course-conflict="teacher"]').first()
      await card.getByRole('button', { name: '看怎么改' }).click()
      await p.waitForTimeout(320)
      const sugAttr = await p.locator('[data-course-suggest]').first().getAttribute('data-course-suggest')
      check(
        Number(sugAttr) >= 1,
        '🔴 S27 ㊳ 点开一条冲突 → **真的给出建议**（不是"没有建议"那种空话）',
        `data-course-suggest=${sugAttr}`,
      )
      const sugRows = await p.locator('[data-course-suggest-row]').allTextContents()
      check(
        sugRows.some((t) => /挪到\s*第\s*\d+\s*节/.test(t)) && sugRows.some((t) => /整格对调/.test(t)),
        '🔴 S27 ㊴ **两种建议都要给**：一条"挪到第 N 节" + 一条"整格对调"（照 v3 预览）',
        sugRows.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 70)).join(' || '),
      )
      /* 一键把两格选好 → 落地 → 硬冲突应当**降下来** */
      await p.locator('[data-course-suggest-use]').first().click()
      await p.waitForTimeout(400)
      /*
       * 🔴 数的是**网格上选中的格子**（`[data-course-day] [data-picked="1"]`），不是
       *    `[data-course-cell][data-picked="1"]` —— 2026-10-13 起网格把**全部 9 节**都摆出来了，
       *    而"没课的那一格"挂的是 `data-course-empty`（`data-course-cell` 仍然是"这一格有课"的意思，
       *    ⑫/⑬ 按它数格子，空格子挂上去会把那两条读数带偏）。
       *    "挪到第 N 节"那条建议选中的**正是一格有课 + 一格空格** —— 只数 `data-course-cell`
       *    会恒等于 1，这条判据就废了。
       */
      const afterSuggestPicked = await p.evaluate(
        () => document.querySelectorAll('[data-course-day] [data-picked="1"]').length,
      )
      check(
        afterSuggestPicked >= 2,
        '🔴 S27 ㊵ 点「用这个方案」→ **一键把两格都选好了**（不是让用户自己再点一遍）',
        `已选中的格 ${afterSuggestPicked} 个`,
      )
      await p.locator('[data-course-apply]').click()
      await p.waitForTimeout(320)
      /* ⚠️ 先钉"这一笔走的是临时那一档、确认钮**点得动**" —— 不钉的话，
         万一将来又有人在 ⑭ 之前把 scope 留在永久，症状是**卡到 30s 超时**
         （整节断掉、㊶ 静默不执行），而不是一条看得懂的红。 */
      const sugConfirmTemp = await p.locator('[data-course-confirm="temp"]').count()
      const sugDisabled = await p.locator('[data-course-doconfirm]').isDisabled()
      check(
        sugConfirmTemp === 1 && sugDisabled === false,
        '🔴 S27 ㊵b 照建议处理这一笔走的是**临时**那一档，且确认钮**点得动**（不是永久那道要多勾一句的闸门）',
        `data-course-confirm=temp ${sugConfirmTemp} 个 · isDisabled=${sugDisabled}`,
      )
      /*
       * 🔴 **落地前后各量一次"这一天的格子"** —— ㊶b 读它（2026-10-13 加）。
       *    只看**格位属性**（有课 / 空格），文案一个字都不看（文案会改，属性是门禁的锚点）。
       */
      const dayAttrs = () =>
        p.evaluate(() =>
          [...document.querySelectorAll('[data-course-day] > button')].map((b) => ({
            cell: b.getAttribute('data-course-cell'),
            empty: b.getAttribute('data-course-empty'),
          })),
        )
      const attrsBefore = await dayAttrs()
      /* 🔴 确认**之前**先把它要确认的是哪一档读下来（弹层一关这个属性就没了） */
      const confirmMode = await p
        .locator('[data-course-confirm]')
        .getAttribute('data-course-confirm')
        .catch(() => null)
      await p.locator('[data-course-doconfirm]').click()
      await p.waitForTimeout(600)
      const hardAfter = await hardCount()
      /*
       * 🔴 把"这一刻屏上到底是什么"一起打进读数里 —— ㊶ 一直是红的，而"3 → 3"这一个数字
       *    说不出是"根本没落"还是"落了但冲突没重算"。几样一起看才判得下去：
       *    · `confirmMode` = 确认的是临时还是永久那一档（尾部残留模式是第一嫌疑）；
       *    · `[data-course-note]` = 页面自己有没有说"没改成 / 为什么不改"（§三.5 不许静默）；
       *    · 确认之后**选中的格**清掉没有（清了 = 那一下真的走到了处理函数末尾）。
       */
      const diag = await p.evaluate(() => ({
        note: (document.querySelector('[data-course-note]')?.textContent ?? '(没有提示)')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 110),
        picked: document.querySelectorAll('[data-course-day] [data-picked="1"]').length,
        teacherCards: document.querySelectorAll('[data-course-conflict="teacher"]').length,
        classCards: document.querySelectorAll('[data-course-conflict="class"]').length,
        applyBar: document.querySelectorAll('[data-course-apply]').length,
      }))
      check(
        hardAfter < hardBefore,
        '🔴 S27 ㊶ **照建议处理之后硬冲突真的降下来了**（照 v3 预览：实测 2 → 1）—— 建议不是摆设',
        `处理前 ${hardBefore} 处 → 处理后 ${hardAfter} 处 · 确认档=${JSON.stringify(confirmMode)} · 屏上提示=${JSON.stringify(diag.note)} · 确认后选中格=${diag.picked} · 拆开=${diag.teacherCards}/${diag.classCards}`,
      )
      /*
       * 🔴 ㊶b **"这一节课挪走了" = 源那一格真的腾空了**（2026-10-13 加，㊶ 的另一半）。
       *
       * 为什么必须单独钉：㊶ 只看"撞课少了没"，而撞课可以由**别的班**变少而变少 ——
       * 这里要钉的是"腾空"这个状态本身在页面上真的表达出来了：
       * **原来有课的某一格现在挂的是 `data-course-empty`（空格子）**，
       * 而**某一格从"空"变成"有课"**（这一条同时钉住"课真的挪到别处了"，不是凭空消失）。
       *
       * ⚠️ 判据按**格位序号**（`data-course-day > button` 里第几个）比较，**不许按
       *    `data-course-cell` 的号** —— 那个号是"第几格有课"的序号，一腾空就**整体前移**
       *    （实测：腾空之后 `["1","2","3","4","5"]` 变成 `["1","3","4","6"]`，
       *     按号比会多报出 [2, 5] 两个"腾空"，把一条真判据变成扯不清的读错）。格位序号不动。
       * 🧪 反向对照（㊶b2）：把 `buildDayCells` 里那句 `if (over && !over.toSubject) return`
       *    去掉（= "腾空了但那一格还显示旧课"那一版）→ 这条当场判假。
       */
      const attrsAfter = await dayAttrs()
      /* 落地前/后：**第几格是有课的**（只比位置，不比 `data-course-cell` 的号 —— 那个号会前移） */
      const filledIdx = (l) =>
        l.map((v, i) => (v.cell ? i : -1)).filter((i) => i >= 0)
      const idxBefore = filledIdx(attrsBefore)
      const idxAfterNow = filledIdx(attrsAfter)
      const emptiedIdx = idxBefore.filter((i) => !idxAfterNow.includes(i))
      const filledIdxNew = idxAfterNow.filter((i) => !idxBefore.includes(i))
      check(
        emptiedIdx.length >= 1 && filledIdxNew.length >= 1 && idxAfterNow.length === idxBefore.length,
        '🔴 S27 ㊶b **"这节课挪到别处" = 源那一格真的腾空了**（那一格从"有课"变成空格子 `data-course-empty`，同时另一格从"空"变成"有课"）—— 不是"只把目标写上课、源那格还挂着旧课"',
        `格位（[data-course-day] > button 里第几个）· 落地前有课 ${JSON.stringify(idxBefore)} → 落地后有课 ${JSON.stringify(idxAfterNow)} · **腾空的格位** ${JSON.stringify(emptiedIdx)} · 新填上的格位 ${JSON.stringify(filledIdxNew)} · 有课格数 ${idxBefore.length} → ${idxAfterNow.length}`,
      )
      /*
       * 🧪 反向对照：把那句"腾空"去掉 → ㊶b 当场判假（证明它盯的是那句话，不是恒绿）。
       * ⚠️ 必须用 `replaceAll`：这句话**在别处（注释里）也会被原样引用** —— 只换第一处的话，
       *    注释里那一份留在结果里，"去掉之后还在"就永远是真，这条反向对照**自己失效**。
       *    2026-10-01 实测栽过一次：`CourseAdmin.tsx` 新加的注释引了同一句，节级驱动当场照红。
       */
      const emptyOut = 'if (over && !over.toSubject) return'
      const noEmptyOut = courseSrc.replaceAll(emptyOut, '/* 反向对照：腾空那一句去掉 */')
      check(
        courseSrc.includes(emptyOut) && !noEmptyOut.includes(emptyOut),
        '🧪 S27 ㊶b2 **反向对照**：`buildDayCells` 里真的有 `if (over && !over.toSubject) return`（"这一格腾空了"）那一句 —— 去掉它，㊶b 那条判据当场判假',
        `原文里有 = ${courseSrc.includes(emptyOut)} · 去掉之后还在 = ${noEmptyOut.includes(emptyOut)}`,
      )
    })

    } catch (e) {
      /*
       * 🧪 **排查用**的早停不算失败：`SHUGAO_ONLY_*` 跑到该跑的那几条就抛出来，
       *    这里只打一句、**不当成异常中断**（正式跑不带那两个变量，走不到这一支）。
       */
      const onlyStop = e instanceof Error && /^SHUGAO_ONLY_/.test(e.message)
      if (onlyStop) {
        console.log(`\n⏹️  ${e.message}`)
      } else {
        console.log(`\n💥 脚本在第「${currentStep}」步异常中断：${e instanceof Error ? e.message : String(e)}`)
        if (crumbs.length) {
          console.log('   最后几个动作：')
          for (const c of crumbs.slice(-6)) console.log(`     · ${c}`)
        }
        if (e instanceof Error && e.stack) console.log(`\n${e.stack}`)
        /*
         * 🔴 **崩溃必须算失败。**
         * 2026-10-13 实测到一次假绿：S27 尾部点了一个 `disabled` 的确认钮、超时 30 秒，
         * 上面那段只把它**打印**出来，`failures` 一条没进 → 于是同一份输出里同时出现
         * 「💥 脚本在第 S27…步异常中断」和「断言：通过 1284 条，失败 0 条 / 全部通过 ✅」，
         * 退出码还是 0 —— **S27 ㊶（"照建议处理之后硬冲突真的降下来了"）从来没跑过，没人知道**。
         * 只打印不算判据（§三.5 同一条：失败了要有人知道）。异常一律进 `failures`，
         * 再由下面 `failures.length` 那一处把退出码打成 1。
         */
        failures.push(
          `脚本在第「${currentStep}」步异常中断（后面的断言全都没跑）：${
            (e instanceof Error ? e.message : String(e)).split('\n')[0]
          }`,
        )
      }
    } finally {
      try {
        await browser?.close()
      } catch {
        /* 忽略 */
      }
    }

    /* ---------------- 结果 ---------------- */

    // 运行时报错（pageerror / console.error）
    if (errors.length) {
      console.log(`\n=== 运行时错误（${errors.length} 条）===`)
      for (const e of errors.slice(0, 20)) console.log(`  ${e}`)
      failures.push(`控制台/页面报了 ${errors.length} 条错误`)
    }

    /*
     * **文件名清单比对**：实际落盘的文件集合必须 == 开头写死的期望集合。
     * 少一张 = 哪一步静默没跑；多一张 = 名字撞了 / 被覆盖；都不是小事。
     * 目标目录每轮都是**新建的空目录**（runId 唯一），所以"旧图冒充这一轮"物理上不可能。
     */
    try {
      const actual = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.endsWith('.png')).sort() : []
      const want = [...EXPECTED_FILES].sort()
      const missing = want.filter((f) => !actual.includes(f))
      const extra = actual.filter((f) => !want.includes(f))
      /*
       * ⚠️ `SHUGAO_ONLY_COURSE=1` / `SHUGAO_ONLY_NAV=1` 是**节级排查**开关（跑完那几节就停），
       *    它本来就不会产出全部 145 张图（实测 5 张）—— 这里要是照打"少了 140 张"，
       *    每次排查都挂一条**假红**，真问题反而被淹掉。
       *    所以节级模式下**换成一行说明**；**整套验收不许带任何 `SHUGAO_ONLY_*`**（那样才会真打这条）。
       */
      const partialRun = Boolean(process.env.SHUGAO_ONLY_COURSE || process.env.SHUGAO_ONLY_NAV)
      if (partialRun) {
        console.log(
          `  ⏭️  节级排查模式（SHUGAO_ONLY_*）：只产出 ${actual.length}/${want.length} 张图，**跳过**"清单齐全"那一条（验收时要跑整套）`,
        )
      } else {
        check(
          missing.length === 0,
          `预期的 ${want.length} 张图全都产出了`,
          missing.length ? `少了 ${missing.length} 张：${missing.join('、')}` : `实际落盘 ${actual.length} 张`,
        )
      }
      check(extra.length === 0, '没有预期之外的图（文件名没撞车、没多写）', extra.length ? extra.join('、') : '没有多余的')
      check(
        dupWrites.length === 0,
        '每个文件名只被写过一次',
        dupWrites.length ? dupWrites.join('；') : `${written.length} 次写入，无重复`,
      )
      // 最新批次指针：一眼看出这轮落在哪（"旧图冒充这一轮"的另一半防线）
      if (missing.length === 0 && extra.length === 0 && !failures.length) {
        try {
          writeFileSync(join(SHOTS_ROOT, 'LATEST'), `${runId}\n`, 'utf8')
        } catch {
          /* 忽略 */
        }
      }
    } catch (e) {
      failures.push(`清单比对本身出错：${e instanceof Error ? e.message : String(e)}`)
    }

    console.log(`\n================ 结果 ================`)
    console.log(`  本轮输出：${OUT_REL}/（预期 ${EXPECTED_FILES.length} 张）`)
    console.log(`  断言：通过 ${passed} 条，失败 ${failures.length} 条`)
    for (const f of failures) console.log(`  ❌ ${f}`)
    if (failures.length) {
      console.log(`\n  ⛔ 停在第「${currentStep}」步`)
      process.exitCode = 1
    } else {
      console.log('  全部通过 ✅（含 URL / 独有文本 / 时钟 / 文件名清单）')
    }
}, { script: 'shots.mjs' })
