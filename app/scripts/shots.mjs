/**
 * 无头截图脚本：用本机 Edge 驱动，验证页面渲染与运行时错误。
 * 用法：npm run shots
 * 输出：.shots/*.png
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { registerTsResolve } from './lib/ts-resolve.mjs'

// 先装 TS 解析钩子，再 import 仓库里的种子数据（见 scripts/lib/ts-resolve.mjs）
registerTsResolve()
const { makeDemoClasses, makeDemoExams } = await import('../src/data/seed.ts')

const BASE = 'http://localhost:5178'
const OUT = '.shots'
mkdirSync(OUT, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

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

const errors = []

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const ctx = await browser.newContext({
  viewport: { width: 414, height: 880 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
})
const page = await ctx.newPage()

page.on('pageerror', (e) => errors.push(`PAGEERROR ${page.url()} :: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${page.url()} :: ${m.text()}`)
})

async function shot(name, { full = false, wait = 520 } = {}) {
  await page.waitForTimeout(wait)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full })
  console.log('shot', name)
}

await page.addInitScript((s) => {
  window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
}, TEACHER_STATE)

/**
 * 把时钟钉死在白天。
 *
 * 教室端有一批**按钟点切换的行为**（19:20 后作业区换成收尾语、0:00 恢复、
 * 课前 5 分钟下课铃、周三下午静音）。不钉时钟的话，同一份代码
 * **白天跑得过、晚上跑不过** —— 这种"看时间脸色"的回归最坑人。
 * 钉在 2026-09-19（周六，也是演示数据的日期）能覆盖到所有分支之外的默认路径。
 */
await ctx.addInitScript((fixed) => {
  const Real = Date
  const t = new Real(fixed).getTime()
  // @ts-ignore
  window.Date = class extends Real {
    constructor(...a) {
      if (a.length === 0) super(t)
      else super(...a)
    }
    static now() {
      return t
    }
  }
}, '2026-09-19T10:00:00+08:00')

// ---------- S1 ----------
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await shot('01-login')

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('02-workbench', { full: true })

await page.goto(`${BASE}/classes`, { waitUntil: 'networkidle' })
await shot('03-classes', { full: true })

await page.goto(`${BASE}/classes/c-demo-1`, { waitUntil: 'networkidle' })
await shot('04-class-detail', { full: true })

await page.goto(`${BASE}/classes/c-demo-1/import/photo`, { waitUntil: 'networkidle' })
await shot('05-photo-capture', { full: true })

await page.getByRole('button', { name: /演示（模拟结果）/ }).click()
await shot('06-photo-scanning', { wait: 700 })

await shot('07-photo-review', { full: true, wait: 2300 })

await page.goto(`${BASE}/classes/c-demo-1/import/paste`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '填入示例' }).click()
await shot('08-paste-import', { full: true })

await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await shot('09-settings', { full: true })

// ---------- S2 ----------
await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
await shot('11-assignments', { full: true })

await page.goto(`${BASE}/assignments/new`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /作业22 电源/ }).first().click()
await shot('12-assignment-new', { full: true })

await page.goto(`${BASE}/assignments/a-demo-2/collect`, { waitUntil: 'networkidle' })
await shot('13-collect-idle', { full: true })

await page.getByRole('button', { name: /演示（模拟结果）/ }).click()
await shot('14-collect-scanning', { wait: 700 })

await shot('15-collect-result', { full: true, wait: 2400 })

// ---------- S3：批改录入 ----------
const q = (seq) => page.getByRole('button', { name: `第 ${seq} 题`, exact: true })

// a-demo-4 是"待批改、未录入"的档案，用来跑完整批改流程
await page.goto(`${BASE}/assignments/a-demo-4/grade`, { waitUntil: 'networkidle' })
await shot('17-grade-idle', { full: true })

// 展开 3 号学生 → 题号就地展开在该学生正下方；标两处错
await page.getByRole('button', { name: /^3 号/ }).click()
await q(5).click()
await q(6).click()
await shot('18-grade-inline-panel')

// 双击第 3 题 → 直接拆出 2 个小题，不弹窗
await q(3).dblclick()
await shot('19-grade-quick-sub')

// 题号格里**不再有「+」**（紧挨着小小题号，点错就把题拆了）——
// 加/减小题一律走长按面板
await q(3).click({ delay: 700 })
await page.getByRole('button', { name: '增加', exact: true }).click()
await page.getByRole('button', { name: '完成', exact: true }).click()
await shot('20-grade-sub-three')

// 标 (1) 错
await page.getByRole('button', { name: '第 3 题第 1 小题' }).click()
await shot('21-grade-sub-wrong')

// 长按第 3 题 → 小题设置（取消需要确认）
await q(3).click({ delay: 700 })
await shot('22-grade-sub-settings')
await page.getByRole('button', { name: '完成', exact: true }).click()

// 换一个学生，验证就地展开跟随
await page.getByRole('button', { name: /^7 号/ }).click()
await q(2).click()
await shot('23-grade-switch', { full: true })

// 完成批改 → 两条路：临时保存 / 确认完成（未批改的记为未交）→ 再挑改错名单
await page.getByRole('button', { name: '完成批改' }).click()
await shot('24-grade-finish-choose')

// 先走「临时保存」：状态不变，进度留下
await page.getByRole('button', { name: /^临时保存/ }).click()
await page.waitForTimeout(700)
await shot('25-grade-draft-saved', { full: true })

// 再进来接着批 → 这次走「确认完成批改」+ 挑改错名单
await page.goto(`${BASE}/assignments/a-demo-4/grade`, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
await page.getByRole('button', { name: '完成批改' }).click()
await page.getByRole('button', { name: /确认完成批改/ }).click()
await shot('26-grade-pick-correction')
await page.getByRole('button', { name: '全选有错的' }).click()
await page.getByRole('button', { name: '确认完成批改' }).click()
await shot('27-grade-done', { full: true, wait: 1200 })

// 改错登记：点一下记「已改」，重点关注置顶变色，旁边能呼叫
// （用已批改且带改错名单的 a-demo-1，避免依赖前面步骤的内存状态）
await page.goto(`${BASE}/assignments/a-demo-1/correct`, { waitUntil: 'networkidle' })
await shot('28-correct', { full: true })
const beforeCorrect = await page.locator('.row').count()
await page.locator('.row').first().click()
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/29-correct-one-done.png`, fullPage: true })
console.log('correct rows', beforeCorrect)
await page.getByRole('button', { name: '更改名单' }).click()
await shot('30-correct-edit-list')
await page.getByRole('button', { name: /^完成/ }).click()
await page.getByRole('button', { name: '呼叫' }).click()
await shot('31-correct-call')
await page.getByRole('button', { name: /取消/ }).click()

// ---------- S4：统计与呼叫 ----------
await page.goto(`${BASE}/assignments/a-demo-1/stats`, { waitUntil: 'networkidle' })
await shot('26-stats', { full: true })

// 下钻到学生名单
await page.getByRole('button', { name: /^第 5 题 错误率/ }).click()
await shot('27-stats-drill', { full: true })

// 呼叫页
await page.goto(`${BASE}/assignments/a-demo-1/call`, { waitUntil: 'networkidle' })
await shot('28-call', { full: true })

// 按错题数从多到少选 3 人，并加自定义后缀
const who = page.getByRole('button', { name: /^\d+ 号 / })
await who.nth(0).click()
await who.nth(1).click()
await who.nth(2).click()
await page.getByPlaceholder('带上作业本').fill('带上作业本')
await shot('29-call-selected', { full: true })

// 预览教室端
await page.getByRole('button', { name: '预览教室端' }).click()
await shot('30-call-preview')

// 确认发送（用站内跳转，避免刷新把刚发的呼叫清掉）
await page.getByRole('button', { name: '确认发送' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: '记录' }).click()
await shot('31-calls', { full: true })

// ---------- S5：教室端（另开一个标签页，验证跨标签实时送达） ----------
const room = await ctx.newPage()
room.on('pageerror', (e) => errors.push(`PAGEERROR(room) :: ${e.message}`))
room.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE(room) :: ${m.text()}`)
})
await room.setViewportSize({ width: 1440, height: 900 })
await room.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
await room.waitForTimeout(1200)
await room.screenshot({ path: `${OUT}/32-classroom.png` })
console.log('shot 32-classroom')

// 展开错误名单（内联兜底面板，与置顶小窗同一份内容）
await room.getByRole('button', { name: '展开错误名单' }).first().click()
await room.waitForTimeout(400)
await room.screenshot({ path: `${OUT}/33-classroom-list.png` })
console.log('shot 33-classroom-list')

// 教师端发出一次呼叫 → 教室端应弹出播报浮层
/*
 * 上面开过教室端，这台设备已被标成「教室端」—— 再访问教师端会被要求重新登录
 * （这是**故意**的：学生改网址就进不去教师控制台了）。
 * 测试要继续跑教师端，所以先把角色改回来。
 */
await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
await page.goto(`${BASE}/assignments/a-demo-1/call`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /^\d+ 号 / }).nth(0).click()
await page.getByRole('button', { name: /^\d+ 号 / }).nth(1).click()
await page.getByRole('button', { name: /^\d+ 号 / }).nth(2).click()
await page.getByRole('button', { name: '发送呼叫' }).click()
await room.waitForTimeout(1600)
await room.screenshot({ path: `${OUT}/34-classroom-broadcast.png` })
console.log('shot 34-classroom-broadcast')

// ---------- 移动端底部导航：磨砂玻璃 + 液态玻璃胶囊 ----------
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.evaluate(() => window.scrollTo(0, 560))
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/35-nav-frost.png` })
console.log('shot 35-nav-frost')

await page.getByRole('link', { name: '作业' }).click()
await page.waitForTimeout(240)
await page.screenshot({ path: `${OUT}/36-nav-travel.png` })
console.log('shot 36-nav-travel')

await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/37-nav-settled.png` })
console.log('shot 37-nav-settled')

// ---------- 作业列表：班级 / 时间筛选 ----------
await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
await page.getByLabel('按班级筛选').selectOption({ index: 1 })
await page.waitForTimeout(400)
await shot('40-assignments-filter', { full: true })

// ---------- 课表 ----------
await page.goto(`${BASE}/schedule`, { waitUntil: 'networkidle' })
await shot('41-schedule', { full: true })

// ---------- 底栏拖拽：胶囊实时跟手 ----------
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)
/*
 * ⚠️ 选择器要按**语义**选，不要按样式类名选。
 * 原来写的是 `nav.nav-frost > div`，而 `nav-frost` 是底栏胶囊的一个**样式类**，
 * 被一次导航栏改版（AppShell）换掉之后，这一段就静默地找不到了 ——
 * 报错信息是 `locator.boundingBox: Timeout`，看名字完全想不到是"类名没了"。
 * 现在用 `aria-label="主导航"`（那是可访问性语义，改样式不会动它）。
 */
const strip = page.locator('nav[aria-label="主导航"] > div')
const sb = await strip.boundingBox()
if (sb) {
  await page.mouse.move(sb.x + sb.width * 0.13, sb.y + sb.height / 2)
  await page.mouse.down()
  await page.mouse.move(sb.x + sb.width * 0.58, sb.y + sb.height / 2, { steps: 14 })
  await page.waitForTimeout(120)
  await page.screenshot({ path: `${OUT}/38-nav-drag.png` })
  console.log('shot 38-nav-drag')
  await page.mouse.up()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/39-nav-dropped.png` })
  console.log('shot 39-nav-dropped')
}

// ---------- 情绪价值：把时钟拨到不同时段 ----------
// 周四早上 7:32 → 欢迎弹窗（当天只出现一次）
await page.clock.setFixedTime(new Date('2026-09-17T07:32:00'))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('42-morning-welcome', { wait: 900 })
await page.getByRole('button', { name: '开始今天' }).click()
await shot('43-morning-workbench', { full: true, wait: 500 })

// 周六下午 → 周末
await page.clock.setFixedTime(new Date('2026-09-19T15:20:00'))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('44-weekend', { full: true, wait: 600 })

// 周四 23:40 → 夜深
await page.clock.setFixedTime(new Date('2026-09-17T23:40:00'))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('45-late-night', { full: true, wait: 600 })

// 周四 19:40，把最后一份待批改的作业批完 → 弹窗会在这一刻出现
await page.clock.setFixedTime(new Date('2026-09-17T19:40:00'))
await page.goto(`${BASE}/assignments/a-demo-4/grade`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '完成批改' }).click()
await page.getByRole('button', { name: /确认完成批改/ }).click()
await page.getByRole('button', { name: '确认完成批改' }).click()
await shot('46-day-done', { wait: 1100 })
await page.getByRole('button', { name: '好的' }).click()
await page.waitForTimeout(400)
// 站内跳转回工作台（不刷新，保住刚批完的状态）
await page.getByRole('link', { name: '工作台' }).click()
await shot('47-day-done-banner', { full: true, wait: 700 })

// ---------- 法定假期与调休（数据来自国办发明电〔2025〕7号） ----------
// 2026-09-20 是周日，但按官方通知是「国庆调休上班」→ 必须按工作日对待
await page.clock.setFixedTime(new Date('2026-09-20T07:32:00'))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('48-makeup-day-welcome', { wait: 900 })
await page.getByRole('button', { name: '开始今天' }).click()
await shot('49-makeup-day-no-banner', { full: true, wait: 500 })

// 中秋假期第一天（2026-09-25）：不弹窗，工作台显示节日祝福
await page.clock.setFixedTime(new Date('2026-09-25T10:00:00'))
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('50-holiday-festive', { full: true, wait: 900 })

// 距假期 2 天 + 工作全部完成 → 收尾换成倒计时
await page.clock.setFixedTime(new Date('2026-09-23T19:40:00'))
await page.goto(`${BASE}/assignments/a-demo-4/grade`, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '完成批改' }).click()
await page.getByRole('button', { name: /确认完成批改/ }).click()
await page.getByRole('button', { name: '确认完成批改' }).click()
await shot('51-countdown-done', { wait: 1100 })

// ---------- S6：错题集，两层（班级列表 → 班级档案） ----------
/*
 * 错题集是**两层**：/wrong 先列"我任教的班级"，点一个班才进 /wrong/:classId 的档案
 * （学生名单在档案里，"班级总结错题"在档案右上角）。
 * 所以这一节必须**两层都走**：只截 /wrong 的话，第二层坏了也看不出来。
 */
await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
await page.goto(`${BASE}/wrong`, { waitUntil: 'networkidle' })
await shot('52-wrong-classes', { full: true })

// 进有数据的班（演示数据里 a-demo-* 都挂在高二(3)班）
await page.getByRole('button', { name: /高二\(3\)班/ }).first().click()
await page.waitForTimeout(600)
await shot('53-wrong-class-detail', { full: true })

// 名单里第一个人 → 个人错题明细（原来就在的 Sheet，功能不能丢）
await page.locator('.row').first().click()
await shot('54-wrong-student-sheet', { wait: 900 })
await page.getByRole('button', { name: '关闭' }).click()
await page.waitForTimeout(400)

// 右上角「班级总结错题」→ 班级高频错点 + 生成班级错题重练卷
await page.getByRole('button', { name: '班级总结错题' }).click()
await page.waitForTimeout(700)
await shot('55-wrong-class-summary', { full: true })
await page.getByRole('button', { name: '关闭' }).click()
await page.waitForTimeout(400)

// 返回按钮要回**班级列表**（而不是首页）
await page.getByRole('button', { name: '返回' }).click()
await page.waitForTimeout(700)
await shot('56-wrong-back-to-classes', { full: true })

// 高二(7)班在演示数据里只有一份未批改的档案 → 班级列表该说"还没批改过作业"，
// 档案里该是空态，而不是列一堆"全对"（那会把"没数据"渲染成"都会了"）
await page.getByRole('button', { name: /高二\(7\)班/ }).first().click()
await page.waitForTimeout(600)
await shot('57-wrong-class-empty', { full: true })

// ---------- S7：考试（建档 → 批阅 → 统计） ----------
/*
 * 考试是独立的一条 /exams 路由族。这一节要**走完整条链**，只截列表是不够的：
 * 建档页的题型清单、批阅页的"展开单人/竖列题号/确认批阅"、统计页的
 * 知识点得分率与难度区分度 —— 这三处任意一处坏了，只截列表都看不出来。
 */
await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
await shot('60-assignments-with-exam-entry', { full: true })

await page.getByRole('button', { name: '考试' }).click()
await page.waitForTimeout(500)
await shot('61-exams-list', { full: true })

// 已完成的档案点进去就是统计页（数据统计 = 用户要的那一屏）
await page.getByRole('button', { name: /物理练习8/ }).first().click()
await page.waitForTimeout(700)
await shot('62-exam-stats', { full: true })

// 逐题下钻：选项分布 + 难度/区分度
// （Sheet 里有两个「关闭」：右上角 X 是无障碍名 `关闭`，页脚那个是正文按钮 —— 取第一个）
await page.getByRole('button', { name: /^8/ }).first().click()
await page.waitForTimeout(500)
await shot('63-exam-question-drill')
await page.getByLabel('关闭').first().click()
await page.waitForTimeout(300)

// 个人诊断：薄弱知识点 + 薄弱题号 + 个人趋势
// （学生行的无障碍名是「学号 号 姓名」，与作业页那一套保持一致）
await page.getByRole('button', { name: /^\d+ 号 / }).first().click()
await page.waitForTimeout(600)
await shot('64-exam-student-diagnosis')
await page.getByLabel('关闭').first().click()
await page.waitForTimeout(300)

// 建档页：考试类型 / 数据来源 / 题型清单 / 记录模式
await page.goto(`${BASE}/exams/new`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await shot('65-exam-new', { full: true })

// 四川新高考题型待选清单（**要交给老师确认的那份**）
await page.getByRole('button', { name: '套用题型清单' }).click()
await page.waitForTimeout(600)
await shot('66-exam-preset-sheet', { full: true })
await page.getByLabel('关闭').first().click()
await page.waitForTimeout(300)

// 批阅页：点一个学生 → 其他学生隐藏，题号沿竖列展开
await page.goto(`${BASE}/exams/ex-demo-1/grade`, { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
await shot('67-exam-grade-list', { full: true })

await page.getByRole('button', { name: /^\d+ 号 / }).first().click()
await page.waitForTimeout(400)
await shot('68-exam-grade-one-student', { full: true })

// 多选题选一部分 → 按 m/n 给分（这一条是判分规则唯一能"看得见"的地方）
const mc = page.getByRole('button', { name: /第 8 题选 [A-D]/ }).first()
if (await mc.count()) {
  await mc.click()
  await page.waitForTimeout(250)
  await shot('69-exam-grade-multi-partial', { full: true })
}

// 确认批阅 → **回到整张表**（不是下一个学生顶上来）
await page.getByRole('button', { name: '确认批阅' }).click()
await page.waitForTimeout(600)
await shot('70-exam-grade-after-confirm', { full: true })

// 批阅完成：两条路（临时保存 / 确认完成）+ 确认完成的二次确认
await page.getByRole('button', { name: '批阅完成' }).click()
await page.waitForTimeout(400)
await shot('71-exam-finish-choose')
await page.getByRole('button', { name: '确认完成' }).click()
await page.waitForTimeout(400)
await shot('72-exam-finish-confirm-zero', { full: true })
await page.getByRole('button', { name: '再改改' }).click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: '临时保存' }).click()
await page.waitForTimeout(700)
await shot('73-exam-draft-saved', { full: true })

// ---------- 桌面 ----------
const wide = await ctx.newPage()
wide.on('pageerror', (e) => errors.push(`PAGEERROR(wide) :: ${e.message}`))
wide.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE(wide) :: ${m.text()}`)
})
await wide.setViewportSize({ width: 1440, height: 940 })
await wide.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await wide.waitForTimeout(700)
await wide.screenshot({ path: `${OUT}/10-desktop.png` })
console.log('shot 10-desktop')

await wide.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
await wide.waitForTimeout(700)
await wide.screenshot({ path: `${OUT}/16-desktop-assignments.png`, fullPage: true })
console.log('shot 16-desktop-assignments')

await browser.close()

if (errors.length) {
  console.log('\n=== 运行时错误 ===')
  for (const e of errors) console.log(e)
  process.exitCode = 1
} else {
  console.log('\n无运行时错误')
}
