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
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'
import { launchBrowser } from './lib/edge-path.mjs'

// 先装 TS 解析钩子，再 import 仓库里的种子数据（见 scripts/lib/ts-resolve.mjs）
registerTsResolve()
const { makeDemoClasses, makeDemoExams } = await import('../src/data/seed.ts')

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
  if (ok) {
    passed++
    console.log(`     ✅ ${label}\n          实测：${observed}${extra ? `　（${extra}）` : ''}`)
  } else {
    failures.push(`[${currentStep}] ${label} —— 实测：${observed}${extra ? `（${extra}）` : ''}`)
    console.log(`     ❌ ${label}\n          实测：${observed}${extra ? `　（${extra}）` : ''}`)
  }
}

/** 每一步一个名字：失败摘要要能一眼看出停在哪（同名步骤只印一次标题） */
const printedSteps = new Set()
/** 只给排查这一节用的临时开关（见下）：是否已经走过移动端导航那一节 */
let sawMobileNavShot = false
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
  const info = await pageInfo(page)
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
    await expectPage(page, stepName, { url: expect.url ?? path, ...expect })
    if (expect.date) await clockOnScreen(page, expect.date)
  })
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
        markers: ['树高教师平台', '账号登录', 'TEACHER CONSOLE'],
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
          '打开的是「学生档案」那一张浮层',
          info.sheetOpen && info.sheetTitle.startsWith('学生档案'),
          `sheetOpen=${info.sheetOpen} · 标题=${info.sheetTitle}`,
        )
        const labels = ['民族', '出生年月', '家长电话', '家庭住址']
        check(
          '四个字段的标题都在屏上',
          labels.every((l) => info.body.includes(l)),
          labels.map((l) => `${l}:${info.body.includes(l)}`).join(' · '),
        )
        check(
          '还没录过时写的是「未录入」（**不是**「读不到」—— 三态不许混）',
          info.body.includes('未录入') && !info.body.includes('读不到学生档案'),
          short(info.body, 130),
        )
        const canEdit = await page.getByRole('button', { name: '修改档案' }).count()
        check(
          '🔴 任课教师 / 无身份 → **不摆**"修改档案"（前端只决定摆不摆，判据在数据库）',
          canEdit === 0,
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
          '🔴 班主任（`?as=head_teacher`）→ **摆**"修改档案"（用户口径：班主任通过班级改本班这些信息）',
          before === 1,
          `按钮数=${before}`,
        )
        if (before !== 1) return
        await page.getByRole('button', { name: '修改档案' }).click()
        await page.waitForTimeout(220)
        const boxCount = await page.locator('.sheet input').count()
        check('点开之后是四个输入框（民族 / 出生年月 / 家长电话 / 家庭住址）', boxCount === 4, `输入框数=${boxCount}`)
        if (boxCount !== 4) return
        await page.locator('.sheet input').nth(0).fill('汉族')
        await page.locator('.sheet input').nth(1).fill('2010-05')
        await page.locator('.sheet input').nth(2).fill('13800138000')
        await page.locator('.sheet input').nth(3).fill('某市某区某小区1号楼2单元501')
        await page.getByRole('button', { name: '保存' }).click()
        await page.waitForTimeout(450)
        const after = await pageInfo(page)
        check(
          '🔴 保存之后屏上就出现了刚录进去的家长电话（录入 → 看到是一条真链路）',
          after.body.includes('13800138000') && after.body.includes('汉族'),
          short(after.body, 130),
        )
        check(
          '而且回到了只读视图（"修改档案"又摆出来了）—— 不是卡在编辑态',
          after.sheetOpen && (await page.getByRole('button', { name: '修改档案' }).count()) === 1,
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
          '🔴 反向对照：明写 `?as=teacher`（任课教师）→ **又不摆**"修改档案"（证明上一步不是"恒摆"）',
          cnt === 0,
          `按钮数=${cnt}`,
        )
        const info = await pageInfo(page)
        check(
          '⚠️ 而字段**照旧看得见**（只读）—— 科任老师不是"看不到"，是"改不了"',
          info.body.includes('家长电话') && info.body.includes('家庭住址'),
          short(info.body, 110),
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

      await goto(page, '09 设置页', '/settings', {
        markers: ['账号 · 数据 · 关于', '备份与恢复', '教室端', '关于'],
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
          '🔴 名单里**序列号那一列**显示的是 7 位序列号（不是班内学号）',
          /2025\d{3}/.test(rowText),
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
          '🔴 编辑面板上「序列号」是**只读**（readOnly/disabled 都算）',
          ro.readOnly || ro.disabled,
          JSON.stringify(ro),
        )
        check(
          '🔴 只读框里显示的就是这个学生的序列号',
          ro.value === (who.serial ?? ''),
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
        check('改完之后名单里出现 99 号', /\b99\b/.test(after), short(after, 90))
        check(
          '🔴 改完之后**序列号没变**（被改的只是班内学号）',
          after.includes(who.serial ?? '###'),
          short(after, 90),
        )
      })
      await shot(page, '09b 改班内学号', '09b-after-rename', { full: true })

      await goto(page, '09c 档案不受影响', '/assignments/a-demo-1/collect', {
        markers: ['收作业查缺', '已交'],
      })
      await step('09c 档案不受影响', async () => {
        /*
         * `a-demo-1` 的未交名单在演示数据里是"第 7、19、33 个学生"（按档案键存的）。
         * 改完学号之后：**未交的仍是同样 3 个人**，只是其中一个现在显示 99。
         * 这正是"档案只认序列号、不认班内学号"的直接证据。
         */
        const info = await page.evaluate(() => {
          const cells = [...document.querySelectorAll('button')]
            .map((b) => (b.innerText ?? '').replace(/\s+/g, ' ').trim())
            .filter((t) => /^\d+(\s|$)/.test(t) && t.length <= 24)
          const missing = [...document.querySelectorAll('button')]
            .filter((b) => (getComputedStyle(b).backgroundColor || '').includes('rgb'))
            .map((b) => (b.innerText ?? '').replace(/\s+/g, ' ').trim())
          return { cells, missing, body: String(document.body.innerText ?? '').replace(/\s+/g, ' ') }
        })
        check(
          '🔴 收缴页上，这个孩子现在显示成 **99 号**（改的确实生效了）',
          /(^|\s)99(\s|$)/.test(info.body),
          short(info.body, 140),
        )
        const stat = await page.evaluate(() => {
          const m = String(document.body.innerText ?? '').match(/未交\s*(\d+)/)
          return m ? Number(m[1]) : -1
        })
        check(
          '🔴 未交人数**没变**（还是 3）—— 改学号没有把任何人从名单里挤出去',
          stat === 3,
          `屏上「未交 ${stat}」`,
          '演示数据 a-demo-1 的未交名单是 3 个人',
        )
      })
      await shot(page, '09c 档案不受影响', '09c-collect-after-rename', { full: true })

      // 改回去（后面的步骤看到的世界必须与这一轮开始时一致）
      await goto(page, '09d 改回原学号', '/classes/c-demo-1', { markers: ['学生名单 · 45 人'] })
      await step('09d 改回原学号', async () => {
        const who = DEMO_CLASSES[0].students[6]
        if (!who) return
        const idx = await page.evaluate(
          (name) =>
            [...document.querySelectorAll('tbody tr')].findIndex((tr) =>
              (tr.innerText ?? '').includes(name),
            ),
          who.name,
        )
        check('改回之前：还能在名单里找到他（按 99 号那行）', idx >= 0, `第 ${idx + 1} 行`)
        await page.getByRole('button', { name: '编辑' }).nth(idx).click()
        await page.waitForTimeout(300)
        await page.locator('.sheet input.num').first().fill(who.studentNo)
        await page.getByRole('button', { name: '保存' }).click()
        await page.waitForTimeout(400)
        const back = await page.evaluate(
          (name) =>
            [...document.querySelectorAll('tbody tr')]
              .map((tr) => (tr.innerText ?? '').replace(/\s+/g, ' ').trim())
              .find((t) => t.includes(name)) ?? '',
          who.name,
        )
        check('🔴 学号改回原值（这一轮结束时世界与开始时一致）', back.includes(who.studentNo), short(back, 90))
      })

      /* ================= S2：作业列表 / 新建 / 收作业查缺 ================= */

      await goto(page, '11 作业列表', '/assignments', {
        // 5 份 = 演示种子那 4 份 + 极简模式那份（a-demo-5，已批改 → 待收缴仍是 2）
        markers: ['5 份档案 · 2 份待收缴', '按上次新建', '全部班级'],
      })
      await shot(page, '11 作业列表', '11-assignments', { full: true })
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
            /const roster = isStream \? members : klass\.students/.test(cdSrc),
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

      await step(SN, async () => {
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
        await page.waitForTimeout(240)
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
        const sheet = await page.evaluate(() => {
          const box = document.querySelector('.sheet')
          return {
            open: Boolean(box),
            title: (box?.querySelector('h2')?.textContent ?? '').trim(),
            body: (box?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          }
        })
        check(
          sheet.open && sheet.title === '更多入口',
          `${SNM}：点圆按钮弹出「更多入口」`,
          `open=${sheet.open} title="${sheet.title}"`,
        )
        for (const label of ['班级', '考试', '错题集', '日程表']) {
          check(
            sheet.body.includes(label),
            `${SNM}：展开层里有「${label}」`,
            short(sheet.body, 150),
          )
        }
        check(
          !sheet.body.includes('呼叫记录'),
          `${SNM}：展开层里**没有**「呼叫记录」（用户明确说不加）`,
          sheet.body.includes('呼叫记录') ? short(sheet.body, 150) : '没有这条',
        )

        /* ============================================================
         * 🔴 2026-09-28 **第二轮**：**展开态整栏淡出**（用户改口径，这一节整体重写）
         *
         * 上一轮这一节钉的是"**展开态圆按钮仍然看得见、可点**"（做法：把 `<nav>` 抬到
         * Sheet 之上 `z-[52]`，靠 `elementFromPoint(圆按钮中心)` 命中按钮本身来证明）。
         * 用户看过之后说：「但是点开后导航栏浮在上面会不会太奇怪了 / 展开后整个导航栏淡出吧」，
         * 于是**抬层叠整个回退**（现在 `<nav>` 恒 `z-40`），语义**反过来了**：
         *
         *   展开态 → 导航必须 **不可见（`opacity: 0`）且不可点**
         *            （`elementFromPoint` 命中的**不是**导航里的任何元素）
         *
         * 三条纪律与上一轮相同（缺一条断言就变成摆设）：
         *   ① **带反向对照**：去掉淡化（`opacity` 与三处 `pointer-events` 一起还原）→ 必须红；
         *   ② **点取真中心**（`getBoundingClientRect` 算），不写死坐标；
         *   ③ 对照用**内联 `style.setProperty(…, 'important')`** —— 按元素打，与类名无关
         *      （上一轮实测过：注入 `<style>` 按类名选，改版后选择器**静默失配**，对照永远绿）。
         *
         * 🔴🔴 **本轮实测踩到的两个"断言会变成摆设"的坑（都写下来）**：
         *
         *   ① **"命中谁"在展开态证明不了"能不能点到"**：Sheet（z-51）本来就盖住导航
         *      那一整条（实测：sheet.top=475、nav.top=804），所以 `elementFromPoint(圆按钮中心)`
         *      命中 Sheet 里的东西是**理所当然**的，把淡化去掉它照样命中 Sheet
         *      —— 只按"命中谁"写，对照**永远不红**（第一版就是这么写的，实测红不了）。
         *      所以"能不能点到"改成直接量**计算出来的 `pointer-events`**：
         *      淡化在 → 圆按钮/胶囊都是 `none`；淡化去掉 → 回到 `auto`。
         *   ② **对照要连 `transition` 一起停掉**：`<nav>` 上有 260ms 的
         *      `transition-opacity`，只把 `opacity` 内联改成 1 的话，**过渡还在跑**
         *      （实测量到 `opacity=0.23`）—— 那时 `elementFromPoint` 会**跳过**这个
         *      半透明的层，命中的是下面的 Sheet，对照于是"看着没生效"。
         *      所以要一起写 `transition: none !important`，让它**立刻**是 1。
         *
         * ⚠️ 还留了一条"**真的点一下**"（不只是量样式）：在圆按钮中心 `page.mouse.click()`，
         *    断言 **URL 没动**。上一轮的回归正是"导航浮在浮层之上、点了会跳页"。
         * ⚠️ **顺序**：这条"真点一下"挪到了本节**最后** —— 那一下落在 Sheet 自己的
         *    页脚/条目上，会把 Sheet 关掉（正常语义），所以后面不能再有用 `.sheet` 的断言。
         * ============================================================ */
        const stackProbe = async (c) =>
          await page.evaluate(async ({ c }) => {
            const nav = document.querySelector('nav[aria-label="主导航"]')
            const pill = nav?.querySelector('div')
            const circle = nav?.querySelector('button[aria-haspopup="dialog"]')
            const sheet = document.querySelector('.sheet')
            const box = sheet?.querySelector('.sheet-foot-safe')
            const foot = box
              ? [...box.querySelectorAll('button')].find((b) => (b.innerText ?? '').trim() === '收起')
              : null
            if (!nav || !pill || !circle || !sheet || !box || !foot) {
              return {
                c,
                missing:
                  'nav / 胶囊 / 圆按钮 / .sheet / .sheet-foot-safe / 页脚「收起」按钮 有一样没找到',
              }
            }
            /*
             * 对照场景：
             *   · `neg-fade`  —— 去掉淡化（opacity 1 + 三处 pointer-events auto + 停掉过渡）
             *                     = 用户改口径之前那种"展开态导航还浮在上面"的样子。
             * ⚠️ 同时打三处**不是保险起见**：父级 `pointer-events: none` **挡不住**子级
             *    自己写的 `auto`（这正是"看不见却还能点到"的成因），所以坏样子要完整还原。
             */
            if (c === 'neg-fade') {
              nav.style.setProperty('opacity', '1', 'important')
              nav.style.setProperty('pointer-events', 'auto', 'important')
              nav.style.setProperty('transition', 'none', 'important')
              pill.style.setProperty('pointer-events', 'auto', 'important')
              circle.style.setProperty('pointer-events', 'auto', 'important')
            }
            const rectOf = (el) => {
              const r = el.getBoundingClientRect()
              return {
                raw: r,
                left: Math.round(r.left),
                top: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
                z: getComputedStyle(el).zIndex,
                pe: getComputedStyle(el).pointerEvents,
              }
            }
            const circleRect = rectOf(circle)
            const footRect = rectOf(foot)
            const pillRect = rectOf(pill)
            /*
             * ⚠️ 这一整段都必须在 `undo()` **之前**读：它们就是"对照到底改上没有"的证据，
             *    放在还原之后读永远是常态值（看着像"对照没生效"）。
             */
            const out = {
              case: c,
              circle: {
                pe: getComputedStyle(circle).pointerEvents,
                rect: {
                  left: circleRect.left,
                  top: circleRect.top,
                  width: circleRect.width,
                  height: circleRect.height,
                  z: circleRect.z,
                  pe: circleRect.pe,
                },
                center: [Math.round(circleRect.raw.left + circleRect.raw.width / 2), Math.round(circleRect.raw.top + circleRect.raw.height / 2)],
              },
              pill: { pe: getComputedStyle(pill).pointerEvents, width: pillRect.width },
              foot: {
                rect: {
                  left: footRect.left,
                  top: footRect.top,
                  width: footRect.width,
                  height: footRect.height,
                },
                center: [Math.round(footRect.raw.left + footRect.raw.width / 2), Math.round(footRect.raw.top + footRect.raw.height / 2)],
                padBottom: getComputedStyle(box).paddingBottom,
                /* 页脚按钮下沿距视口底多少：> 0 = 完全看得见 */
                bottomGap: Math.round(window.innerHeight - footRect.raw.bottom),
              },
              nav: {
                opacity: getComputedStyle(nav).opacity,
                pointerEvents: getComputedStyle(nav).pointerEvents,
                z: getComputedStyle(nav).zIndex,
                top: Math.round(nav.getBoundingClientRect().top),
                height: Math.round(nav.getBoundingClientRect().height),
              },
              sheet: { z: getComputedStyle(sheet).zIndex, top: Math.round(sheet.getBoundingClientRect().top) },
            }
            /* 对照改完样式到"计算值真的变了"之间隔一次样式重算：等两帧再收尾（口径照上一轮） */
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
            if (c === 'neg-fade') {
              nav.style.removeProperty('opacity')
              nav.style.removeProperty('pointer-events')
              nav.style.removeProperty('transition')
              pill.style.removeProperty('pointer-events')
              circle.style.removeProperty('pointer-events')
            }
            return out
          }, { c })

        /* 两次取数，各处只取一次：`real` = 真状态；`negFade` = 对照（去掉淡化） */
        const real = await stackProbe('real')
        const negFade = await stackProbe('neg-fade')
        for (const [c, r] of [['real', real], ['neg-fade', negFade]]) {
          if (r?.missing) throw new Error(`${SNM}：层叠探针（${c}）取数失败 —— ${r.missing}`)
        }

        /* ① 视觉上真的消失了（`opacity` 是"看不见"这件事的可量证据） */
        check(
          real.nav?.opacity === '0',
          `${SNM}：展开态**整栏淡出**（\`<nav>\` 的计算 opacity 为 0）`,
          `opacity=${real.nav?.opacity}（收起态是 1）· nav z=${real.nav?.z} · .sheet z=${real.sheet?.z}（sheet.top=${real.sheet?.top}）`,
        )
        /* ② **而且点不到** —— 两个子控件各自的 `pointer-events` 都必须被关掉。
              ⚠️ 为什么不写成"elementFromPoint 命中谁"：Sheet（z-51）本来就盖住导航那一整条，
                 命中 Sheet 里的东西是**理所当然**的、把淡化去掉也一样（实测过，那样写对照永远不红）。
                 真正会出事故的是"透明了但 `pointer-events` 还是 auto"——那才是"看不见却会误触"。 */
        check(
          real.circle?.pe === 'none' && real.pill?.pe === 'none',
          `${SNM}：展开态**两个子控件的 pointer-events 都被关掉**（不只是透明）`,
          `圆按钮 pointer-events=${real.circle?.pe} · 胶囊 pointer-events=${real.pill?.pe} · nav pointer-events=${real.nav?.pointerEvents}`,
          '父级设 none 是**挡不住**子级自己写的 auto 的 —— 所以这两处必须分别量',
        )
        /* ③ 🔴 **反向对照**：把淡化去掉（opacity 1 + 三处 pointer-events 还原成 auto + 停过渡）
              → ②那条必须红。实测：还原之后两个子控件都回到 auto。 */
        check(
          negFade.nav?.opacity === '1' &&
            negFade.circle?.pe === 'auto' &&
            negFade.pill?.pe === 'auto',
          `${SNM}：🧪 反向对照 —— 去掉淡化的瞬间，两个子控件又**变成可点**了（②那条**必须**红）`,
          `还原成 opacity=${negFade.nav?.opacity} 之后：圆按钮 pointer-events=${negFade.circle?.pe}、胶囊=${negFade.pill?.pe}`,
          '⚠️ 对照必须连 `transition:none` 一起写：只改 opacity 的话 260ms 的过渡还在跑，量到的是中间值（实测 opacity=0.23）',
        )
        /* ④ 页脚不再需要让位（`.sheet-foot-safe` 按用户要求回退）：按钮整体可见即可。
              实测 414×880：按钮占 y=826~868、距视口底 12px —— 完整可见、不用滚。 */
        check(
          real.foot?.bottomGap > 0,
          `${SNM}：页脚那个「收起」按钮**完整落在视口内**（导航不再压它，页脚恢复 p-3 也放得下）`,
          `按钮实占=${JSON.stringify(real.foot?.rect)} 中心=${JSON.stringify(real.foot?.center)} · 下沿距视口底 ${real.foot?.bottomGap}px · 页脚 pad-bottom=${real.foot?.padBottom}`,
          '这一条替代了上一轮的"页脚安全区"那条（`.sheet-foot-safe` 已按用户要求回退）',
        )

        // 展开层里点一条 → 真的跳过去（收起的四条路径之一：点条目先收起再 navigate）
        await page.locator('.sheet button').filter({ hasText: '日程表' }).first().click()
        await page.waitForURL('**/schedule', { timeout: 8000 })
        await page.waitForTimeout(400)
        const after = await pageInfo(page)
        check(
          after.url === '/schedule' && !after.sheetOpen,
          `${SNM}：点「日程表」跳过去且展开层收起`,
          `url=${after.url} sheetOpen=${after.sheetOpen}`,
        )
        /* 收回导航（上一步跳页时已经自动收起，这里显式再点一次展开，给下面的"真点一下"用） */
        await page.locator('nav[aria-label="主导航"] button[aria-haspopup="dialog"]').click({
          force: true,
        })
        await page.waitForTimeout(700)
        const reopened = await stackProbe('real')
        check(
          reopened.nav?.opacity === '0',
          `${SNM}：再展开一次，导航又是透明的（下面那条"真点一下"要在展开态量）`,
          `opacity=${reopened.nav?.opacity} · sheet.top=${reopened.sheet?.top} · 圆按钮中心=${JSON.stringify(reopened.circle?.center)}`,
        )
        /* ⑤ 🔴 **真点一下**：在圆按钮中心点一次 —— 那里现在没有导航，
              点下去命中的是 Sheet 自己的东西，并且 **URL 绝不许动**
              （"点了导航跳页"正是本轮要防的那个回归）。
              ⚠️ 不把"Sheet 还开着"当判据：那一点下面是 Sheet 的页脚/条目，
                 点到「收起」把它关掉是**正常语义**（上一轮实测也是这么记的）。
              ⚠️ 这一条必须放在**最后**：它会把 Sheet 关掉，后面不能再有 `.sheet` 断言。 */
        const urlBeforeClick = page.url()
        await page.mouse.click(reopened.circle.center[0], reopened.circle.center[1])
        await page.waitForTimeout(320)
        check(
          page.url() === urlBeforeClick,
          `${SNM}：**在圆按钮的位置真点一下 → URL 一动都不动**（那里已经不是导航了）`,
          `点之前 url=${urlBeforeClick} · 点之后 url=${page.url()}`,
          '展开态那颗按钮在 DOM 里还在（只是透明 + 不可点），所以"点不动"这件事必须实测',
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
         * 🔴 那条"白底不透明度"是**可读性的机器版**：面板上有 11.5px 的说明小字，
         *    底下可能是课表 / 名单 / 深色内容 —— 兜底白底太透就会读不清（用户第一条硬约束）。
         *    数值口径见 `index.css` 里 `.sheet:has([data-nav-glass])` 那一段的算式。 */
        await page.getByRole('button', { name: '展开更多入口' }).click()
        await page.waitForTimeout(600)
        const panel = await page.evaluate(() => {
          const sh = document.querySelector('.sheet')
          if (!sh) return null
          const cs = getComputedStyle(sh)
          const img = cs.backgroundImage
          const alphas = [...img.matchAll(/rgba?\([^)]*?([\d.]+)\)/g)].map((m) => Number(m[1]))
          return {
            radius: cs.borderTopLeftRadius,
            backdrop: cs.backdropFilter,
            minAlpha: alphas.length ? Math.min(...alphas) : null,
            headBg: getComputedStyle(sh.querySelector('.panel-head') ?? sh).backgroundColor,
            marker: Boolean(sh.querySelector('[data-nav-glass]')),
          }
        })
        check(
          panel?.marker === true &&
            panel.radius === '18px' &&
            panel.backdrop.includes('blur(') &&
            panel.backdrop.includes('url('),
          `${SG}：**展开态那张面板**也是同一块玻璃（大圆角 18 + 模糊 + 折射接上了）`,
          panel
            ? `圆角=${panel.radius} · backdrop-filter=${panel.backdrop} · 标记=${panel.marker} · 头部底=${panel.headBg}`
            : '没找到 .sheet',
        )
        check(
          panel !== null && panel.minAlpha !== null && panel.minAlpha >= 0.6,
          `${SG}：🔴 面板的**兜底白底够厚**（最浅那一档 ≥ 0.6）—— 最坏背景下菜单里的字仍读得清`,
          panel ? `白底最浅那一档 alpha=${panel.minAlpha}（${panel.minAlpha >= 0.6 ? '过' : '太透'}）` : '没找到 .sheet',
          '参考图的背景是蓝天白云，这个平台的背景可能是课表 / 名单 / 深色内容：可读性优先于好看',
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
        await page.waitForTimeout(400)
        const sig1 = await sig()
        const activeColor = sig1.find((c) => c.active)?.color ?? null
        check(
          Boolean(activeColor) && sig1.filter((c) => !c.active).every((c) => c.color !== activeColor),
          `${SG}：当前页的图标颜色与其余**明显不同**（色盲 / 强光下也不能只靠那块指示器）`,
          sig1.map((c) => `${c.name}${c.active ? '(当前)' : ''} ${c.color}`).join(' · '),
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
        await navPage.waitForTimeout(420)
      }

      /** 桌面左栏里**实际摆着**哪几项（按语义选择器，不按样式类名 —— §15.5 的教训） */
      const railLabels = () =>
        navPage.evaluate(() =>
          [...document.querySelectorAll('nav[aria-label="主导航 · 桌面"] a[aria-label]')].map((a) =>
            a.getAttribute('aria-label'),
          ),
        )

      /** 移动端展开层里那几项（点开圆按钮之后读 `.sheet`；`收起` 是页脚那个按钮，不算入口） */
      const sheetLabels = async () => {
        await navPage.getByRole('button', { name: '展开更多入口' }).click()
        await navPage.waitForTimeout(360)
        const out = await navPage.evaluate(() => {
          const box = document.querySelector('.sheet')
          return {
            open: Boolean(box),
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
        const adminCards = await navPage.evaluate(
          () => document.querySelectorAll('[data-manage-card]').length,
        )
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
        check(`${S63}：\`schema.sql\` 里找得到 \`grade_delete\` 的函数体`, at > 0, at > 0 ? `下标 ${at}` : '没找到')
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
         * 反向对照：同一页「关于」里那行**「学段学科」仍然是学科**（那一行要的就是学科）。
         * 少了这一条，把整页的"学科"都换成身份也能绿。
         */
        const body = await bodyText(idPage)
        check(
          body.includes('学段学科') && body.includes('高中 · 物理'),
          `${SID}：设置页「关于 · 学段学科」照旧写学科（那一行与身份无关，不许跟着改）`,
          short(body.match(/.{0,20}学段学科.{0,30}/)?.[0] ?? body, 120),
        )

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
          b.includes('平台') && (b.includes('项需要处理') || b.includes('拿不到数据') || b.includes('没有发现异常')),
          `${SAD}：L0 是一句人话（"基本正常 · N 项需要处理"这种），不是一串数字`,
          short(b.split('\n').find((x) => x.includes('平台')) ?? '', 100),
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

        /* --- C1：§10–§19 十段，且 §17/§18 明确"不适用" --- */
        await adPage.locator('[data-admin-toggle="④ 数据库结构漂移（C1）"]').click()
        await adPage.waitForTimeout(250)
        const c1 = (await pageInfo(adPage)).body
        for (const st of ['§10', '§15', '§17', '§18', '§19']) {
          check(c1.includes(st), `${SAD}：C1 总表列出了 ${st}`, c1.includes(st) ? '在' : '没找到')
        }
        check(
          c1.includes('不适用') && c1.includes('探不到'),
          `${SAD}：§17 / §18 明写"不适用（面板探不到）"，**没有假装它是绿的**`,
          short(c1.match(/.{0,20}不适用.{0,40}/)?.[0] ?? '', 140),
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
        const wantTopStack = (g.sync?.h ?? 0) + (g.stack?.h ?? 0)
        const gotTopStack = Number.parseFloat(String(g.varTopStack))
        check(
          Number.isFinite(gotTopStack) && Math.abs(gotTopStack - wantTopStack) <= 1,
          `${SAN}：让位量 = **报错横幅 + 公告条**（--top-stack-h 把两段加起来：${gotTopStack} ≈ ${g.sync?.h} + ${g.stack?.h}）`,
          `变量 ${g.varTopStack} · 报错横幅 ${g.sync?.h ?? '(没有)'}px + 公告条 ${g.stack?.h ?? '(没有)'}px = ${wantTopStack}px`,
        )
        await shot(annPage, SAN, '91-ann-with-sync-banner')
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
         *    公告搬进了自己那一格（概览上只留一句指路）。
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
        await shot(annPage, S2, '103-settings-feedback', { full: true })
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
        check(`${S21}：\`schema.sql\` 里找得到 \`teacher_profiles\` 的建表段`, start > 0, start > 0 ? `下标 ${start}` : '没找到')
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
         */
        const cardRevoke = (p, title) =>
          p.evaluate((t) => {
            const card = [...document.querySelectorAll('section.panel')].find((s) =>
              String(s.innerText ?? '').includes(t),
            )
            if (!card) return { found: false, has: null }
            const btn = [...card.querySelectorAll('button')].filter(
              (b) => String(b.innerText ?? '').trim() === '撤下',
            )
            return { found: true, has: btn.length > 0, n: btn.length }
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

        /* ---- C. 手动切换 + 记忆 ---- */
        await toggle.nth(visibles[0] ?? 0).click()
        await dp.waitForTimeout(250)
        const after = await readPalette(dp)
        check(
          after.theme === null && after.stored === 'light',
          'F4②：点一下 → 切到亮色，并且**落盘** `shugao.theme=light`',
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
        /* 切回暗色，把这一档留给下面几张暗色图 */
        await dp.locator('[data-theme-toggle]').nth(visibles[0] ?? 0).click()
        await dp.waitForTimeout(250)
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

    } catch (e) {
      console.log(`\n💥 脚本在第「${currentStep}」步异常中断：${e instanceof Error ? e.message : String(e)}`)
      if (crumbs.length) {
        console.log('   最后几个动作：')
        for (const c of crumbs.slice(-6)) console.log(`     · ${c}`)
      }
      if (e instanceof Error && e.stack) console.log(`\n${e.stack}`)
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
      check(
        missing.length === 0,
        `预期的 ${want.length} 张图全都产出了`,
        missing.length ? `少了 ${missing.length} 张：${missing.join('、')}` : `实际落盘 ${actual.length} 张`,
      )
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
