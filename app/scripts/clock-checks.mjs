/**
 * 假时钟验证：教室端「依赖今天是哪天、现在几点」的行为
 * ------------------------------------------------------------------
 * 用法：npm run dev 先跑起来（5178），然后
 *        node scripts/clock-checks.mjs
 *        node scripts/clock-checks.mjs --base=http://localhost:5178
 *
 * 为什么要有这个脚本：
 *   《功能设计与不变量.md》§7.1 的规矩是「凡是依赖时钟的行为都必须用假时钟验」，
 *   但以前每次都是临时脚本、验完就删，下次改这块又得从头来一遍。
 *   这里是那批检查的常驻版本 —— `shots`（截图冒烟）之外多一道针对时钟的关卡。
 *
 * 覆盖的场景（每条都印出**实际观察到的值**，不是只说 passed）：
 *   ① 某节课正在进行的中间时刻                 → 「正在上课」卡（科目 30px 居中、老师 16px 居中、时间区间）
 *   ② 那节课刚下课、下一节还没开始             → 卡片消失，恢复成当天的课表列表
 *   ③ 放假当天（中秋节，日期从 holidays.ts 里读）→ 「今天放假 · 中秋节」，一条课都不显示
 *   ④ 调休上班日（workdays[0]，周末但要上课）  → 正常显示课表，**不显示**「今天放假」
 *   ⑤ 19:19 / 19:21 / 23:59 / 00:01           → 与 §7.1 记的一致（19:21 起收尾语、0:00 起恢复）
 *   ⑥ TTS 不可用时派一条呼叫                   → 浮层至少停留 max(3.5 秒, 字数 × 180ms)
 *   ⑦ 「按日期选作业」点击展开（Sheet 列出所有日期）
 *   ⑧ 「正在上课」卡在各种标题形状下显示什么   → splitTitle 要剥掉开头的班名（粘贴链路给的就是带班名的标题）
 *   ⑨ 课前 5 分钟的下课铃（AudioContext 桩数振荡器）→ **只响一声 1174.7Hz 的轻声铃**，不响「叮咚」
 *   ⑩ 周三静音时段 / 考试模式静音              → 呼叫**不响不念不霸屏**，但**队列留着**，静音一结束从队首接着播
 *
 * 时钟怎么钉的：`ctx.clock.install()` + `ctx.clock.setFixedTime(本地墙上时间)`。
 * 本机时区是 +08:00（和 beijingNow() 一个口径），所以本地时间 == 北京时间；
 * 每次导航都会把屏上时钟读回来核对（`goto()` 里那句断言），钉错了当场报出来。
 * ⚠️ 钉住之后 **Date.now() 不走**了 —— 量时长一律用 performance.now()。
 *
 * 数据怎么来的：dev server 没有 Supabase 环境变量 → 本地演示模式，数据来自 store 的演示种子。
 * 演示种子里课表的 `scope` 是 `mine`，而教室端只读 `scope='class'`，
 * 所以脚本走**真实的「粘贴课表」入口**（parse → 核对 → 导入）把班级课表录进去 ——
 * 顺带把那条链路也跑了一遍，比往 localStorage 里硬塞更接近真实操作。
 *
 * 前置条件：dev server 在 5178 上跑着（`npm run dev`）。没跑的话脚本会以
 * 「等不到课表面板」失败退出，不会静默跳过。
 *
 * ⚠️ 教室端会把本机标成「设备角色 = classroom」，跑完必须复位成 teacher，
 *    否则同一浏览器里后续教师端的用例会全被 Guard 拦到登录页。
 */
import { chromium } from 'playwright-core'

/* ---------------- 配置 ---------------- */

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = (process.argv.find((a) => a.startsWith('--base=')) ?? '').split('=')[1] || 'http://localhost:5178'
const HEADED = process.argv.includes('--headed')

/** 本机时区必须是 +08:00，否则「本地时间 == 北京时间」这个前提不成立 */
const BEIJING_TZ = /China Standard Time|Asia\/Shanghai|\+08:00/i

const DEMO_CLASS = '高二(3)班'
/** 演示种子里第一个班的 id（seed.ts 里写死的），教室端默认就选它 */
const DEMO_CLASS_ID = 'c-demo-1'
const CLS_KEY = 'shugao.teacher.v1'

/**
 * 班级课表（scope='class'）—— 最终要打进快照的那份。
 *
 * 标题照**项目约定**写「科目 任课老师」（`splitTitle` 靠这个空格拆两行），
 * 也就是教室端「正在上课」卡能正确工作的写法；`classId` 直接给本班。
 * 这和种子里的教师课表（`高二(3)班 物理`，`classId` 由字段给）是同一个形状，
 * 只是把 scope 换成 class。
 *
 * 注意这份**不带班名**：粘贴链路产出的是带班名的那种（见下面 CLASS_SCHEDULE）。
 * 两种形状现在都测（场景 1/2 用这份，场景 8 用形状矩阵逐个量）。
 */
const CLS_ROWS = [
  { weekday: 4, start: '08:55', end: '09:35', title: '语文 张老师' },
  { weekday: 4, start: '11:05', end: '11:45', title: '英语 陈老师' },
  { weekday: 5, start: '10:50', end: '11:30', title: '化学 李老师' },
  { weekday: 7, start: '08:50', end: '09:30', title: '历史 周老师' },
].map((r, i) => ({
  ...r,
  id: `sch-clock-${i + 1}`,
  classId: DEMO_CLASS_ID,
  kind: 'class',
  notify: true,
  scope: 'class',
}))

/**
 * 「粘贴课表」那条链路的输入。
 *
 * 为什么这里每行前面要带班名：教室端只显示 `scope='class'` **且 classId 等于本班** 的课，
 * 而粘贴链路里 classId 是 `matchClass()` 从**标题**里认出班名才给的
 * （见 lib/scheduleParse.ts）—— 标题不写班名，导进去的行 classId 是空的，
 * 教室端一条都不会显示。真实课表本来也写着班名，所以照实写。
 *
 * ⚠️ 这段输入**就是**那条"标题里必须有班名"的裂缝的现场：
 * 导进来的标题是「高二(3)班 语文 张老师」——`splitTitle` 修好之前，
 * 卡上会把「高二(3)班」当成科目显示成 30px 大字（修复见 §七）。
 * 所以下面**先用这份数据验一次「正在上课」卡**（端到端：粘贴 → matchClass → 卡片），
 * 再用 CLS_ROWS 把数据换成"不带班名"的写法，验后面几个场景不受影响。
 */
const CLASS_SCHEDULE = `
周四 08:55-09:35 ${DEMO_CLASS} 语文 张老师
周四 11:05-11:45 ${DEMO_CLASS} 英语 陈老师
周五 10:50-11:30 ${DEMO_CLASS} 化学 李老师
周日 08:50-09:30 ${DEMO_CLASS} 历史 周老师
`.trim()

/**
 * 「正在上课」卡的标题形状矩阵（场景 8）。
 *
 * 教室端能收到课，靠的是标题里有班名（matchClass 认出来）；
 * 而卡上要显示的是「科目 / 老师」两行 —— 这两种要求都由 `splitTitle` 调和：
 * 它先把**开头的班名**剥掉，再按第一个空格拆。这里逐个形状量一遍。
 */
const TITLE_SHAPES = [
  { raw: '语文 张老师', subject: '语文', teacher: '张老师', why: '不带班名（教室端只显示这一种形状也能工作）' },
  { raw: `${DEMO_CLASS} 语文 张老师`, subject: '语文', teacher: '张老师', why: '半角括号班名（粘贴链路真实产出）' },
  { raw: '高二（4）班 语文 张老师', subject: '语文', teacher: '张老师', why: '全角括号班名' },
  { raw: '高三(12)班 语文 张老师', subject: '语文', teacher: '张老师', why: '高三位数班号' },
  { raw: '高二(4)班 语文', subject: '语文', teacher: '', why: '有班名、没有老师 —— 不能把「语文」当成老师' },
  { raw: '班会', subject: '班会', teacher: '', why: '没有老师的课' },
  { raw: '自习', subject: '自习', teacher: '', why: '没有老师的课' },
  { raw: '选修课', subject: '选修课', teacher: '', why: '没有老师的课' },
]

/** 期望在屏幕上看到的（标题按 `splitTitle` 拆成两行） */
const CARD_SCHEDULE = {
  thu1: { title: '语文 张老师', subject: '语文', teacher: '张老师', start: '08:55', end: '09:35' },
  thu2: { title: '英语 陈老师', subject: '英语', teacher: '陈老师', start: '11:05', end: '11:45' },
  fri1: { title: '化学 李老师', subject: '化学', teacher: '李老师', start: '10:50', end: '11:30' },
  sun1: { title: '历史 周老师', subject: '历史', teacher: '周老师', start: '08:50', end: '09:30' },
}

/**
 * 第二份「已批改」档案 —— 给「按日期选作业」用。
 *
 * 演示种子里 c-demo-1 只有 a-demo-1 是 graded（a-demo-4 还停在 collected），
 * 而那个日期筛选按钮**只有 ≥2 份已批改时才渲染**，不补一条就根本测不到。
 * 这里直接往快照里加一条（形状照 a-demo-2，只把 status 改成 graded），
 * 不走 UI 批改流程 —— 本脚本要验的是日期选择器，不是批改链路。
 */
const FAKE_GRADED = {
  id: 'a-clock-check-2',
  title: '作业22 电源 闭合电路欧姆定律',
  classId: DEMO_CLASS_ID,
  subject: '物理',
  assignDate: '2026-09-21',
  questionCount: 8,
  status: 'graded',
  templateId: 't-22',
  createdAt: 0,
  collected: true,
  missingNos: [],
  lateNos: [],
  subQuestions: {},
  wrong: {},
  confirmedNos: [],
}

/**
 * 播报浮层最短展示时长的两个常量。
 * **从源码里读**，不在这里抄一份 —— 抄一份就等于测试和自己的副本比，
 * 改了源码里的值它也不会响（这正是「一份定义两处实现」的坑）。
 * 源码里找不到就当场失败。
 */
const SRC_CLASSROOM = new URL('../src/pages/Classroom.tsx', import.meta.url)
const SRC_HOLIDAYS = new URL('../src/data/holidays.ts', import.meta.url)
/** 静音时段表也从源码里读（见 tts.ts 的 QUIET_SLOTS）—— 不在脚本里再抄一份 */
const SRC_TTS = new URL('../src/lib/tts.ts', import.meta.url)

const runtime = { BUBBLE_MIN_MS: null, BUBBLE_MS_PER_CHAR: null }

/* ---------------- 断言 ---------------- */

let passed = 0
const failures = []

function check(ok, label, observed, extra = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${label}\n       实测：${observed}${extra ? `　（${extra}）` : ''}`)
  } else {
    failures.push(`${label} —— 实测：${observed}${extra ? `（${extra}）` : ''}`)
    console.log(`  ❌ ${label}\n       实测：${observed}${extra ? `　（${extra}）` : ''}`)
  }
}

function say(msg) {
  console.log(`\n${msg}`)
}
function note(msg) {
  console.log(`  · ${msg}`)
}
function short(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/* ---------------- 小工具 ---------------- */

function readConsts(src, names) {
  const out = {}
  for (const n of names) {
    // \b 别省：BUBBLE_MS 是 BUBBLE_MS_PER_CHAR 的前缀，不加边界会读错值
    const m = src.match(new RegExp(`\\b${n}\\b\\s*=\\s*([0-9_]+)`))
    out[n] = m ? Number(m[1].replace(/_/g, '')) : null
  }
  return out
}

async function readSource(url) {
  const { readFileSync } = await import('node:fs')
  return readFileSync(url, 'utf8')
}

/* ---------------- 日期/时刻小算术（静音时段、下课铃都要拿它算具体某天） ---------------- */

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 基准日**所在那一周**（周一为一周之始）里的某个星期几。
 * weekday: 0=周日 … 6=周六，与 Date.getDay() 一致。
 * ⚠️ 别写成"往后找最近的那个星期X" —— 那会跨到下一周去（踩过一次：
 *    基准日周四、目标周三，结果算成了 6 天后的下周三）。
 */
function isoOfWeekdayInWeek(baseIso, weekday) {
  const d = new Date(`${baseIso}T12:00:00`)
  const fromMonday = (d.getDay() + 6) % 7 // 周一=0 … 周日=6
  d.setDate(d.getDate() - fromMonday + ((weekday + 6) % 7))
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** `HH:MM` 加减分钟，跨零点回绕 */
function shiftHHMM(hhmm, deltaMin) {
  const [h, m] = hhmm.split(':').map(Number)
  const t = (((h * 60 + m + deltaMin) % 1440) + 1440) % 1440
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`
}

const weekdayCharOf = (iso) => '日一二三四五六'[new Date(`${iso}T12:00:00`).getDay()]
/** 与产品同一个口径的星期文案（Classroom.tsx 用的是 WEEKDAY_TEXT，带「周」字） */
const weekdayTextOf = (iso) => `周${weekdayCharOf(iso)}`

/** 页面上「这个班的课」那一坨（课表面板）的文本 */
async function schedText(page) {
  return page.evaluate(() => {
    const secs = [...document.querySelectorAll('section.panel')]
    const t = secs.find((s) => /这个班的课/.test(s.textContent ?? ''))
    return t ? (t.querySelector(':scope > div')?.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  })
}

/** 等课表面板出现（Vite 首包 + store 水合要一点时间；HMR 重建时偶尔会慢一拍） */
async function waitSched(page, timeout = 20_000) {
  const t0 = Date.now()
  for (;;) {
    const t = await schedText(page)
    if (t) return t
    if (Date.now() - t0 > timeout) {
      const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 200))
      throw new Error(`等不到课表面板（${timeout}ms）；页面开头是：${body}`)
    }
    await page.waitForTimeout(200)
  }
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())
}

/** 屏上的教室端时钟（大字 + 秒）与日期行 */
async function clockOnScreen(page) {
  return page.evaluate(() => {
    const secs = [...document.querySelectorAll('section.panel')]
    const p = secs[0]
    const t = (p?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const m = t.match(/(\d{2}):(\d{2})(\d{2})(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日 · 周([日一二三四五六])/)
    return m
      ? {
          clock: `${m[1]}:${m[2]}`,
          date: `${m[4]}-${String(m[5]).padStart(2, '0')}-${String(m[6]).padStart(2, '0')}`,
          weekday: m[7],
          raw: t,
        }
      : { clock: null, date: null, weekday: null, raw: t }
  })
}

/**
 * 导航 + 等渲染，并核对「屏上的钟 == 我们钉的钟」。
 * 偶尔首页那次请求会慢一拍（Vite 空闲后重编译），所以整个导航重试三次 ——
 * 但最后仍然是**断言失败**，不是静默跳过。
 */
async function goto(page, path, expect) {
  let on = null
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 })
      await waitSched(page, 20_000)
      await page.waitForTimeout(300)
      on = await clockOnScreen(page)
      if (on.clock) break
      lastErr = new Error('屏上读不到时钟')
    } catch (e) {
      lastErr = e
      if (attempt < 3) {
        note(`第 ${attempt} 次导航没渲染出来（${e instanceof Error ? e.message : e}），2 秒后重试`)
        await page.waitForTimeout(2000)
      }
    }
  }
  if (!on) throw lastErr ?? new Error('导航失败')
  const ok = on.clock === expect.clock && on.date === expect.date && on.weekday === expect.weekday
  check(ok, '假时钟真的生效了（把屏上时钟读回来核对）', `屏上 ${on.date} 周${on.weekday} ${on.clock}`, `钉的是 ${expect.date} 周${expect.weekday} ${expect.clock}`)
  return on
}

/**
 * 卡上那一行「正在上课」，以及**时间区间的文本**。
 *
 * ⚠️ 这里刻意**不用 `/正在上课/` 找元素再拿它自证**：卡片本身就是靠这个正则找到的，
 *    再用同一个正则断言"第一行是正在上课"是**恒真**的（这条假断言 2026-09-27 已删）。
 *    所以下面量的是**别的东西**：这一行的整段文案、起止时间是不是数据里的那两个时刻。
 */
async function readCardLineText(page, range = CARD_SCHEDULE.thu1) {
  return page.evaluate(
    (rangeWant) => {
      const secs = [...document.querySelectorAll('section.panel')]
      const panel = secs.find((s) => (s.textContent ?? '').includes('正在上课'))
      if (!panel) return { found: false }
      const desc = [...panel.querySelectorAll('div')]
      const first = desc.find(
        (d) =>
          (d.textContent ?? '').includes('正在上课') &&
          ![...d.children].some((c) => (c.textContent ?? '').includes('正在上课')),
      )
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
      const texts = []
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim()
        if (t) texts.push(t)
      }
      return {
        found: true,
        text: (first?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        hasStart: texts.includes(rangeWant.start),
        hasEnd: texts.includes(rangeWant.end),
        texts: texts.slice(0, 14),
      }
    },
    { start: range.start, end: range.end },
  )
}

/**
 * 「按日期选作业」那个选择器的**产品口径**：只有 `graded.length > 1` 才渲染。
 * 返回页面上那个带 ▾ 的按钮文案（没有就是 null），以及"当前小窗显示：第 N 题"那行。
 */
async function readDatePicker(page) {
  return page.evaluate(() => {
    const outside = [...document.querySelectorAll('button')].filter((b) => !b.closest('.sheet'))
    const withArrow = outside.filter((b) => (b.textContent ?? '').includes('▾'))
    const pip = [...document.querySelectorAll('span')].find((s) =>
      /^当前小窗显示：第 \d+ 题/.test((s.textContent ?? '').trim()),
    )
    return {
      n: withArrow.length,
      text: withArrow[0] ? (withArrow[0].textContent ?? '').replace(/\s+/g, ' ').trim() : '',
      pip: pip ? (pip.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
    }
  })
}

/**
 * 「正在上课」那张卡：科目 / 老师两行的文案、字号、对齐，还有时间区间。
 *
 * 找法**不靠层级**：那一块是 Panel 里唯一带内联 `font-size: 30px` / `16px`
 * 且 `text-align: center` 的 div（卡片形状是这部分设计的一部分，
 * 按样式认比按第几层子节点认稳），再拿「正在上课」那一行做交叉验证。
 */
async function readCurrentCard(page, range = CARD_SCHEDULE.thu1) {
  /** 期望的时间区间，从外面传进去 —— page.evaluate 的函数体会被序列化成字符串，
   *  写在里面的 \uXXXX 转义会被吃掉（这个坑踩过一次），所以别在里面拼转义。 */
  const rangeWant = {
    start: range.start,
    end: range.end,
    dash: '–',
    text: `${range.start}–${range.end}`,
  }
  return page.evaluate(
    (rangeWant) => {
      const secs = [...document.querySelectorAll('section.panel')]
      const panel = secs.find((s) => /正在上课/.test(s.textContent ?? ''))
      if (!panel) return { found: false }
      const body = panel.querySelector(':scope > div') ?? panel
      const desc = [...panel.querySelectorAll('div')]
      const pick = (px) =>
        desc.filter(
          (d) =>
            d.style.fontSize === px &&
            d.style.textAlign === 'center' &&
            (d.textContent ?? '').trim(),
        )
      const subjEl = pick('30px')[0] ?? null
      const teachEl = pick('16px')[0] ?? null
      const line = desc.find(
        (d) =>
          /正在上课/.test(d.textContent ?? '') &&
          ![...d.children].some((c) => /正在上课/.test(c.textContent ?? '')),
      )
      // 「08:55–09:35」这一行在 DOM 里其实是三个文本节点（起 / en dash / 止）拼的，
      // TreeWalker 拿到的是分开的片段 —— 所以顺着文本流找「起、破折号、止」三连。
      // （这里不用正则、不写转义：page.evaluate 的函数体会被序列化成字符串，
      //   写在里面的 \uXXXX 会被吃掉，这个坑踩过一次。）
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
      const texts = []
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim()
        if (t) texts.push(t)
      }
      const dashIdx = texts.indexOf(rangeWant.dash)
      const rangeHit =
        dashIdx > 0 &&
        dashIdx + 1 < texts.length &&
        texts[dashIdx - 1] === rangeWant.start &&
        texts[dashIdx + 1] === rangeWant.end
          ? `${texts[dashIdx - 1]}${rangeWant.dash}${texts[dashIdx + 1]}`
          : null
      const rangeEl = rangeHit ? { textContent: rangeHit } : null
      const info = (el) =>
        el
          ? {
              tag: el.tagName,
              text: (el.textContent ?? '').trim(),
              textAlign: getComputedStyle(el).textAlign,
              styleTextAlign: el.style.textAlign,
              fontSize: getComputedStyle(el).fontSize,
              styleFontSize: el.style.fontSize,
            }
          : null
      return {
        found: true,
        panelText: (panel.textContent ?? '').replace(/\s+/g, ' ').trim(),
        bodyText: (body.textContent ?? '').replace(/\s+/g, ' ').trim(),
        line: (line?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        range: rangeEl ? rangeEl.textContent : null,
        rangeWant: rangeWant.text,
        texts: texts.slice(0, 14),
        subjectLine: info(subjEl),
        teacherLine: info(teachEl),
        children: [...(body.children ?? [])].map((k) => ({
          tag: k.tagName,
          text: (k.textContent ?? '').replace(/\s+/g, ' ').trim(),
          fontSize: k.style.fontSize || '',
        })),
      }
    },
    rangeWant,
  )
}

/**
 * 「正在上课」那张卡上的**两行**：科目（30px 居中）/ 任课老师（16px 居中）。
 * 和 readCurrentCard 是同一套找法（按内联样式认，不按第几层子节点认），
 * 只是这里只关心「拆成了什么」，用于验 splitTitle 的各种标题形状。
 */
async function readCardLines(page) {
  return page.evaluate(() => {
    const secs = [...document.querySelectorAll('section.panel')]
    const panel = secs.find((s) => (s.textContent ?? '').includes('正在上课'))
    if (!panel) return { found: false }
    const pick = (px) =>
      [...panel.querySelectorAll('div')].find(
        (d) => d.style.fontSize === px && d.style.textAlign === 'center' && (d.textContent ?? '').trim(),
      ) ?? null
    const subj = pick('30px')
    const teach = pick('16px')
    return {
      found: true,
      subject: subj ? (subj.textContent ?? '').trim() : null,
      teacher: teach ? (teach.textContent ?? '').trim() : null,
      subjectPx: subj ? subj.style.fontSize : null,
      teacherPx: teach ? teach.style.fontSize : null,
      panelText: (panel.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }
  })
}

/* ---------------- 声音：数振荡器（AudioContext 桩） ---------------- */

/** 桩记下来的振荡器：{ f, type, gainPeak }（gainPeak = 该音的音量峰值） */
async function readAudio(page) {
  return page.evaluate(() => ({
    installed: Boolean(window.__audio),
    ctxCount: window.__audio?.ctxCount ?? -1,
    osc: (window.__audio?.osc ?? []).map((o) => ({ ...o })),
  }))
}

/** 等到至少有 n 个振荡器（下课铃的 tick 是 20 秒一次，窗开宽一点） */
async function waitOsc(page, n, timeout = 25_000) {
  const t0 = Date.now()
  for (;;) {
    const a = await readAudio(page)
    if (a.osc.length >= n) return a
    if (Date.now() - t0 > timeout) return a
    await page.waitForTimeout(500)
  }
}

async function readTts(page) {
  return page.evaluate(() => ({
    installed: Boolean(window.__tts?.installed),
    calls: (window.__tts?.calls ?? []).map((c) => ({ ...c })),
  }))
}

/**
 * 等 speak() 被调用。
 * ⚠️ 别一看到浮层就立刻读：`playHead()` 是**先响「叮咚」、隔
 * SPEAK_AFTER_CHIME_MS（680ms）才开口**，读早了永远是 0 次（踩过一次）。
 */
async function waitTts(page, n, timeout = 6000) {
  const t0 = Date.now()
  for (;;) {
    const t = await readTts(page)
    if (t.calls.length >= n) return t
    if (Date.now() - t0 > timeout) return t
    await page.waitForTimeout(150)
  }
}

/** 把两个计数器清零（量"这一段里到底有没有出声"之前必须先清） */
async function resetSoundCounters(page) {
  await page.evaluate(() => {
    if (window.__audio) {
      window.__audio.osc.length = 0
      window.__audio.gains.length = 0
    }
    if (window.__tts) {
      window.__tts.calls.length = 0
      window.__tts.cancelled = 0
    }
  })
}

const audioText = (a) =>
  a.osc.length
    ? a.osc.map((o) => `${o.f}Hz@${o.gainPeak}`).join('、')
    : '一个振荡器都没有'

/* ---------------- 播报浮层：盯住它有没有出现过 ---------------- */

/**
 * 用 MutationObserver 盯「播报浮层」（`div.fixed.inset-0.z-[70]`）。
 * 静音期间要证明的是「**一次都没出现过**」—— 轮询采样会把一闪而过的浮层漏掉，
 * 所以这里在派发呼叫**之前**就装上观察器。
 * ⚠️ 别在这里写 CSS 转义选择器（`z-\\[70\\]`）：page.evaluate 的函数体是字符串，
 *    转义容易被吃掉（同上文 3 个坑里的那个）；用 className 判断最稳。
 */
async function overlayWatchStart(page) {
  await page.evaluate(() => {
    const isOverlay = (el) =>
      el.tagName === 'DIV' && String(el.className).includes('fixed inset-0 z-[70]')
    window.__ov = { seen: 0, first: null, texts: [] }
    const scan = () => {
      for (const el of document.querySelectorAll('div')) {
        if (!isOverlay(el)) continue
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (window.__ov.seen === 0) window.__ov.first = { at: performance.now(), text }
        window.__ov.seen++
        if (window.__ov.texts.length < 4) window.__ov.texts.push(text)
      }
    }
    scan()
    window.__ov.obs = new MutationObserver(scan)
    window.__ov.obs.observe(document.body, { childList: true, subtree: true })
  })
}

async function overlayWatchRead(page) {
  return page.evaluate(() => {
    window.__ov?.obs?.disconnect()
    return {
      seen: window.__ov?.seen ?? -1,
      first: window.__ov?.first ?? null,
      texts: window.__ov?.texts ?? [],
      now: [...document.querySelectorAll('div')].some((d) =>
        String(d.className).includes('fixed inset-0 z-[70]'),
      ),
    }
  })
}

/** 当前浮层上写着什么（没有浮层就是 null） */
async function overlayText(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) =>
      String(d.className).includes('fixed inset-0 z-[70]'),
    )
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  })
}

/** 等浮层出现（静音解除后队列接着播的那一刻） */
async function waitOverlay(page, timeout = 20_000) {
  const t0 = Date.now()
  for (;;) {
    const t = await overlayText(page)
    if (t) return t
    if (Date.now() - t0 > timeout) return null
    await page.waitForTimeout(150)
  }
}

/* ---------------- 派一条呼叫（走真实的 BroadcastChannel，和教师端同一条路） ---------------- */

async function openCallChannel(page) {
  return page.evaluateHandle(() => new BroadcastChannel('shugao.classroom.v1'))
}

async function postCall(page, handle, id, text) {
  await page.evaluate(
    ([bc, id, text, classId]) => {
      bc.postMessage({
        type: 'call',
        call: {
          id,
          assignmentId: 'a-demo-1',
          classId,
          studentNos: ['1'],
          text,
          room: '教师办公室',
          sentAt: [Date.now()],
          states: {},
        },
      })
    },
    [handle, id, text, DEMO_CLASS_ID],
  )
}

async function closeCallChannel(page, handle) {
  await page.evaluate((bc) => bc.close(), handle)
}

/* ---------------- 主流程 ---------------- */

const errors = []
let browser

try {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const srcClassroom = await readSource(SRC_CLASSROOM)
  const srcHolidays = await readSource(SRC_HOLIDAYS)
  const c = readConsts(srcClassroom, ['BUBBLE_MIN_MS', 'BUBBLE_MS_PER_CHAR'])
  runtime.BUBBLE_MIN_MS = c.BUBBLE_MIN_MS
  runtime.BUBBLE_MS_PER_CHAR = c.BUBBLE_MS_PER_CHAR

  console.log('【假时钟验证 · 教室端】')
  console.log(`  目标：${BASE}`)
  console.log(`  Node 时区：${tz}`)

  if (!BEIJING_TZ.test(tz)) {
    throw new Error(
      `本机时区是 ${tz}，不是 +08:00 —— 脚本里钉的「本地墙上时间」就不等于北京时间了。` +
        `请把机器时区设成中国标准时间再跑（或改脚本用 UTC 构造时刻）。`,
    )
  }
  if (c.BUBBLE_MIN_MS === null || c.BUBBLE_MS_PER_CHAR === null) {
    throw new Error('没能从 Classroom.tsx 里读到 BUBBLE_MIN_MS / BUBBLE_MS_PER_CHAR')
  }

  /* ---- 假期日期不从天上掉下来：直接从官方数据里挑，并核对它的性质 ---- */
  const holiday = srcHolidays.match(/name: '中秋节', start: '([\d-]+)', end: '([\d-]+)'/)
  const makeup = srcHolidays.match(/workdays: \[([^\]]+)\]/)
  if (!holiday || !makeup) throw new Error('没能从 holidays.ts 里读到中秋节 / 调休上班日')
  const HOLIDAY_ISO = holiday[1]
  const MAKEUP_ISO = makeup[1].match(/'([\d-]+)'/)[1]

  const dow = (iso) => new Date(`${iso}T12:00:00`).getDay()
  console.log(`  假期数据：中秋节 ${HOLIDAY_ISO}–${holiday[2]}（周${'日一二三四五六'[dow(HOLIDAY_ISO)]}）`)
  console.log(`  调休上班日（workdays 第一条）：${MAKEUP_ISO}（周${'日一二三四五六'[dow(MAKEUP_ISO)]}）`)
  console.log(`  浮层最短展示：max(${c.BUBBLE_MIN_MS}ms, 字数 × ${c.BUBBLE_MS_PER_CHAR}ms)`)

  /* ---- 下课铃的两个声音特征也从 tts.ts 里读（不在脚本里抄一份，改了源码它会响） ---- */
  const srcTts = await readSource(SRC_TTS)
  const num = (m) => (m ? Number(m[1]) : null)
  const SOFT_F = num(srcTts.match(/softChime[\s\S]{0,600}?frequency\.value\s*=\s*([\d.]+)/))
  const SOFT_VOL = num(srcTts.match(/softChime[\s\S]{0,600}?exponentialRampToValueAtTime\(([\d.]+)/))
  const LOUD_FS = [...srcTts.matchAll(/\{\s*f:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  if (SOFT_F === null || SOFT_VOL === null || LOUD_FS.length < 2) {
    throw new Error('没能从 tts.ts 里读到下课铃/提示音的频率与音量（softChime 那段改过？）')
  }
  console.log(`  下课铃：${SOFT_F}Hz / 音量 ${SOFT_VOL}；播报提示音：${LOUD_FS.join('、')}Hz`)

  /* ---- 静音时段同样从源码读：挑第一条槽位，算出"那一周的哪一天、几点" ---- */
  const slotRaw = srcTts.match(
    /weekday:\s*(\d+)\s*,\s*from:\s*'([\d:]+)'\s*,\s*to:\s*'([\d:]+)'\s*,\s*why:\s*'([^']*)'/,
  )
  if (!slotRaw) throw new Error('没能从 tts.ts 里读到 QUIET_SLOTS 的时段')
  const QUIET_SLOT = { weekday: Number(slotRaw[1]), from: slotRaw[2], to: slotRaw[3], why: slotRaw[4] }
  // 用 2026-09-24 那一周（演示数据与其它场景都钉在这一周），避免跨周跑到假期上
  const QUIET_ISO = isoOfWeekdayInWeek('2026-09-24', QUIET_SLOT.weekday)
  const QUIET_AT = `${QUIET_ISO}T${shiftHHMM(QUIET_SLOT.from, 5)}:00` // 时段内（开始后 5 分钟）
  const AFTER_AT = `${QUIET_ISO}T${shiftHHMM(QUIET_SLOT.to, 1)}:00` // 时段刚过 1 分钟
  console.log(
    `  静音时段（${QUIET_SLOT.why}）：周${QUIET_SLOT.weekday} ${QUIET_SLOT.from}–${QUIET_SLOT.to} → ` +
      `取 ${QUIET_ISO}：静音中 ${QUIET_AT.slice(11, 16)} / 解除后 ${AFTER_AT.slice(11, 16)}`,
  )

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })

  // 演示数据是「相对今天」生成的，先用一个中间时刻把种子的日期钉住，后面再逐场景拨表
  const SEED_TIME = '2026-09-24T14:00:00'
  await ctx.clock.install({ time: new Date(SEED_TIME) })

  // 登录态 + 设备角色。**只在缺失时写**，否则每次导航都会把教室端自己写的存档盖掉
  await ctx.addInitScript(() => {
    try {
      if (!window.localStorage.getItem('shugao.deviceRole')) {
        window.localStorage.setItem('shugao.deviceRole', 'teacher')
      }
      if (!window.localStorage.getItem('shugao.teacher.v1')) {
        window.localStorage.setItem(
          'shugao.teacher.v1',
          JSON.stringify({
            state: { teacher: { id: 't-1', name: '王老师', subject: '物理', school: '树高中学' } },
            version: 1,
          }),
        )
      }
    } catch {
      /* 隐私模式：下面的断言会以「等不到课表面板」的形式报出来 */
    }
  })

  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${page.url()} :: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CONSOLE ${page.url()} :: ${m.text()}`)
  })

  /* ================= 第 0 步：把班级课表录进去 ================= */

  say('【准备】打开教室端，用「粘贴课表」把班级课表（scope=class）录进去')
  await page.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
  await waitSched(page)

  // ① 先触发一次 store 变化，让 persist 快照真正落盘（本地模式下它不会在启动时自动写回）
  const before = await page.evaluate((k) => (localStorage.getItem(k) ?? '').length, CLS_KEY)
  if (before < 200) {
    await page.selectOption('select.input', { index: 1 })
    await page.waitForTimeout(300)
    await page.selectOption('select.input', { index: 0 })
    await page.waitForTimeout(600)
  }

  // ② 走真实的导入链路：粘贴课表 → 解析并核对 → 确认导入
  await page.getByRole('button', { name: '粘贴课表' }).click()
  await page.locator('textarea').fill(CLASS_SCHEDULE)
  await page.getByRole('button', { name: '解析并核对' }).click()
  await page.waitForTimeout(200)
  const reviewed = await page.evaluate(() =>
    [...document.querySelectorAll('textarea, input.input')].length,
  )
  await page.getByRole('button', { name: /确认导入（\d+ 条）/ }).click()
  await page.waitForTimeout(600)

  const saved = await page.evaluate((k) => {
    const st = JSON.parse(localStorage.getItem(k) ?? '{}').state ?? {}
    const rows = (st.schedule ?? []).filter((s) => s.scope === 'class')
    return {
      total: (st.schedule ?? []).length,
      cls: rows.map((s) => [s.weekday, s.start, s.end, s.title, s.classId ?? '(无班号)']),
      mine: (st.schedule ?? []).filter((s) => s.scope !== 'class').length,
    }
  }, CLS_KEY)
  console.log(`  · 核对页输入框数：${reviewed}（导入弹层的每一格都能改）`)
  console.log(`  · 课表落盘：共 ${saved.total} 条，其中 scope='class' ${saved.cls.length} 条 / scope='mine'（演示的教师课表）${saved.mine} 条`)
  for (const r of saved.cls) console.log(`      - 周${r[0]} ${r[1]}-${r[2]} 「${r[3]}」 classId=${r[4]}`)
  check(
    saved.cls.length === 4 && saved.cls.every((r) => r[4] === DEMO_CLASS_ID),
    '「粘贴课表」导入的 4 条是 scope=class，且班号认成了本班',
    `class=${saved.cls.length} 条，班号 ${[...new Set(saved.cls.map((r) => r[4]))].join('/')}`,
    `不写班名的话 matchClass 给不出 classId，教室端一条都不显示`,
  )

  // ②.5 端到端验一次**粘贴链路的真实数据**：库里的标题是「高二(3)班 语文 张老师」，
  //      direct 进教室端看卡上写什么（这一段就是"标题里必须有班名"的现场）
  say('【准备】用刚粘贴进来的那份数据（标题带班名）看一眼「正在上课」卡')
  await ctx.clock.setFixedTime(new Date('2026-09-24T09:15:00'))
  await goto(page, '/classroom', { clock: '09:15', date: '2026-09-24', weekday: '四' })
  const pastedCard = await readCardLines(page)
  if (!pastedCard.found) {
    check(false, '粘贴进来的数据能在教室端显示成「正在上课」卡', `没找到卡片；课表区：${short(await schedText(page))}`)
  } else {
    console.log(`  · 库里那份标题是「${DEMO_CLASS} 语文 张老师」（matchClass 就是从这个班名认出 classId 的）`)
    console.log(`  · 卡上两行：科目「${pastedCard.subject ?? '(无)'}」/ 老师「${pastedCard.teacher ?? '(无)'}」`)
    check(
      pastedCard.subject === '语文' && pastedCard.subjectPx === '30px',
      '卡上第一行是科目「语文」，不是班名',
      `实测「${pastedCard.subject ?? '(无)'}」 font-size=${pastedCard.subjectPx ?? '(无)'}`,
      '修 splitTitle 之前这里显示的是 30px 的「高二(3)班」',
    )
    check(
      pastedCard.teacher === '张老师',
      '卡上第二行是任课老师「张老师」',
      `实测「${pastedCard.teacher ?? '(无)'}」 font-size=${pastedCard.teacherPx ?? '(无)'}`,
    )
    check(
      !(pastedCard.panelText ?? '').includes(DEMO_CLASS),
      '班名没有漏到卡片上',
      (pastedCard.panelText ?? '').includes(DEMO_CLASS)
        ? `卡上还有「${DEMO_CLASS}」：${short(pastedCard.panelText, 90)}`
        : `卡上只有：${short(pastedCard.panelText, 90)}`,
    )
  }

  // ③ 换成不带班名的那种标题（见 CLS_ROWS 上方注释）—— 后面几个场景都用它
  await page.evaluate(
    ([k, rows, extra]) => {
      const snap = JSON.parse(localStorage.getItem(k) ?? '{}')
      snap.state.schedule = [...snap.state.schedule.filter((s) => s.scope !== 'class'), ...rows]
      const asgs = snap.state.assignments ?? []
      if (!asgs.some((a) => a.id === extra.id)) snap.state.assignments = [...asgs, extra]
      localStorage.setItem(k, JSON.stringify(snap))
    },
    [CLS_KEY, CLS_ROWS, FAKE_GRADED],
  )
  {
    const after = await page.evaluate(
      ([k, id]) => {
        const st = JSON.parse(localStorage.getItem(k) ?? '{}').state ?? {}
        const rows = (st.schedule ?? []).filter((s) => s.scope === 'class')
        return {
          cls: rows.map((s) => [s.weekday, s.start, s.end, s.title, s.classId]),
          graded: (st.assignments ?? []).filter((a) => a.status === 'graded').map((a) => [a.id, a.assignDate]),
          hasExtra: (st.assignments ?? []).some((a) => a.id === id),
        }
      },
      [CLS_KEY, FAKE_GRADED.id],
    )
    console.log('  · 教室端要读的那份课表（标题＝「科目 老师」）：')
    for (const r of after.cls) console.log(`      - 周${r[0]} ${r[1]}-${r[2]} 「${r[3]}」 classId=${r[4]}`)
    console.log(`  · c-demo-1 的已批改档案：${after.graded.map((g) => `${g[0]}(${g[1]})`).join('、')}`)
    /*
     * ⚠️ 这里**故意不断言** `cls.length === 4 && graded.length >= 2` ——
     *    那是"脚本刚写进去的东西等于脚本刚写进去的东西"，**自证**、恒真（2026-09-27 删）。
     *    有价值的核对放到产品真渲染出来之后：见下面场景 1 里的 `readDatePicker` 断言
     *    （"日期选择器真的渲染出来了"只有 graded 真的 ≥2 才会发生）与卡上两行。
     */
    note('上面这些是脚本**写入**的内容（自证不算断言）；真正核对产品渲染见场景 1')
  }

  /* ================= ① 某节课正在进行的中间时刻 ================= */

  say(`【场景 1】${'2026-09-24'}（周四）09:15 —— 第 1 节 ${CARD_SCHEDULE.thu1.start}–${CARD_SCHEDULE.thu1.end} 正在进行`)
  await ctx.clock.setFixedTime(new Date('2026-09-24T09:15:00'))
  await goto(page, '/classroom', { clock: '09:15', date: '2026-09-24', weekday: '四' })
  const card = await readCurrentCard(page)
  const body1 = await bodyText(page)
  /*
   * 「准备」那一节写进去的东西，到这里**真的渲染出来了吗**？
   * 这是把那条自证断言换成产品断言的地方：
   *   · 「按日期选作业」那个选择器**只有 graded.length > 1 才渲染**（Classroom.tsx），
   *     它出现了 = 产品确实读到了 ≥2 份已批改档案；
   *   · 它显示的日期必须是 FAKE_GRADED 那条的日期（产品按 assignDate 筛出来的）。
   */
  /*
   * 选中的那份日期 —— 从**快照里产品要读的那份数据**算出来（不是脚本当场拍一个常量）：
   * 教室端默认选中的是 `graded` 里的第一份（`assignment` 由 classId + status 推出）。
   */
  const wantPicked = await page.evaluate(
    ([k, classId]) => {
      const st = JSON.parse(localStorage.getItem(k) ?? '{}').state ?? {}
      const graded = (st.assignments ?? []).filter((a) => a.classId === classId && a.status === 'graded')
      return graded[0] ? graded[0].assignDate : null
    },
    [CLS_KEY, DEMO_CLASS_ID],
  )
  const picker1 = await readDatePicker(page)
  check(
    picker1.n === 1 &&
      Boolean(wantPicked) &&
      picker1.text.includes(wantPicked.slice(5).replace('-', '/')),
    '「按日期选作业」选择器真的渲染了，且显示的是产品选中的那份已批改档案的日期（读到了 ≥2 份）',
    `带 ▾ 的按钮 ${picker1.n} 个，文案「${picker1.text}」`,
    `只有 graded.length > 1 才渲染；期望含 ${wantPicked ? wantPicked.slice(5).replace('-', '/') : '(快照里没有 graded 档案)'}`,
  )
  check(
    /^当前小窗显示：第 \d+ 题/.test(picker1.pip ?? ''),
    '当前小窗那一行也在（作业与小窗都挂上了）',
    String(picker1.pip),
  )
  if (!card.found) {
    check(false, '出现「正在上课」卡片', `没找到，课表区文案：${short(await schedText(page))}`)
    // 失败时把课表数据摊出来，省得下次还要另写探针
    const dbg = await page.evaluate((k) => {
      const st = JSON.parse(localStorage.getItem(k) ?? '{}').state ?? {}
      const now = new Date()
      const wd = now.getDay() === 0 ? 7 : now.getDay()
      return {
        now: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} 周${now.getDay()}`,
        weekdayOfNow: wd,
        classKey: localStorage.getItem('shugao.classroom.classId'),
        currentClassId: st.currentClassId,
        classes: (st.classes ?? []).map((c) => [c.id, c.name]),
        todayRows: (st.schedule ?? [])
          .filter((s) => s.weekday === wd)
          .map((s) => [s.start, s.end, s.title, s.scope ?? '(undef)', s.classId ?? '(undef)']),
        nSchedule: (st.schedule ?? []).length,
      }
    }, CLS_KEY)
    console.log(`  · 现场数据：${JSON.stringify(dbg)}`)
  } else {
    console.log(`  · 卡片文本：${short(card.panelText, 120)}`)
    /*
     * ⚠️ 原来这里是 `check(/正在上课/.test(card.panelText), …)` —— **恒真**：
     *    `card` 就是靠 `/正在上课/` 找出来的（readCurrentCard 里那句），
     *    拿同一个正则再断言一次等于什么都没验。2026-09-27 换成量**别的东西**：
     *    那一行的整段文案、起止时间是不是数据里那两个时刻、字号与对齐。
     */
    const line1 = await readCardLineText(page, CARD_SCHEDULE.thu1)
    check(
      line1.found &&
        line1.text.includes('正在上课') &&
        line1.hasStart &&
        line1.hasEnd,
      '第一行是「正在上课」+ 起止时间（08:55 与 09:35 都在这一行里）',
      line1.found
        ? `这一行「${line1.text}」；起 ${line1.hasStart ? '在' : '不在'} / 止 ${line1.hasEnd ? '在' : '不在'}；面板文本节点=${JSON.stringify(line1.texts)}`
        : '没找到那一行',
    )
    check(
      card.range === `${CARD_SCHEDULE.thu1.start}–${CARD_SCHEDULE.thu1.end}`,
      '第一行的时间区间正确（08:55–09:35）',
      String(card.range),
      card.range ? '' : `面板里的文本节点=${JSON.stringify(card.texts)}`,
    )
    check(
      card.subjectLine?.text === CARD_SCHEDULE.thu1.subject &&
        card.subjectLine?.fontSize === '30px' &&
        card.subjectLine?.textAlign === 'center',
      '第二行科目 30px 居中',
      card.subjectLine
        ? `"${card.subjectLine.text}" font-size=${card.subjectLine.fontSize} text-align=${card.subjectLine.textAlign}`
        : `没找到 30px 居中的那一行；面板里的行：${JSON.stringify(card.children ?? [])}`,
      `期望 "${CARD_SCHEDULE.thu1.subject}" 30px center`,
    )
    check(
      card.teacherLine?.text === CARD_SCHEDULE.thu1.teacher &&
        card.teacherLine?.fontSize === '16px' &&
        card.teacherLine?.textAlign === 'center',
      '第三行任课老师 16px 居中',
      card.teacherLine
        ? `"${card.teacherLine.text}" font-size=${card.teacherLine.fontSize} text-align=${card.teacherLine.textAlign}`
        : `没找到 16px 居中的那一行；面板里的行：${JSON.stringify(card.children ?? [])}`,
      `期望 "${CARD_SCHEDULE.thu1.teacher}" 16px center`,
    )
    check(
      !/\d{2}:\d{2}/.test(card.panelText.replace(`${CARD_SCHEDULE.thu1.start}–${CARD_SCHEDULE.thu1.end}`, '')),
      '课表区整块换成了这张卡（当天课表列表不再出现）',
      `面板里除该时间区间外没有别的时间：${short(card.panelText, 90)}`,
    )
    check(
      !body1.includes(CARD_SCHEDULE.thu2.title),
      '另一节课的列表项不在了（整块被卡片顶掉）',
      body1.includes(CARD_SCHEDULE.thu2.title)
        ? `还在：${CARD_SCHEDULE.thu2.title}`
        : `页面里没有「${CARD_SCHEDULE.thu2.title}」`,
    )
  }

  /* ================= ② 刚下课、下一节还没开始 ================= */

  say('【场景 2】2026-09-24（周四）09:45 —— 第 1 节刚下课（09:35 下课），下一节 11:05 还没开始')
  await ctx.clock.setFixedTime(new Date('2026-09-24T09:45:00'))
  await goto(page, '/classroom', { clock: '09:45', date: '2026-09-24', weekday: '四' })
  const sched2 = await waitSched(page)
  const body2 = await bodyText(page)
  check(!/正在上课/.test(sched2), '「正在上课」卡片消失', short(sched2, 140))
  check(
    [CARD_SCHEDULE.thu1.start, CARD_SCHEDULE.thu2.start].every((t) => sched2.includes(t)),
    '恢复成当天的课表列表（两条课都在）',
    short(sched2, 140),
  )
  check(
    body2.includes(`${CARD_SCHEDULE.thu2.title}`),
    '列表里的标题仍是「科目 老师」整串',
    CARD_SCHEDULE.thu2.title,
  )

  /* ================= ⑦ 「按日期选作业」点击展开 ================= */

  say('【场景 7】「按日期选作业」—— 只显示当前日期 + ▾，点一下弹出 Sheet 列出所有日期')
  const pickInfo = await readDatePicker(page)
  const sheetBefore = await page.locator('.sheet').count()
  check(
    pickInfo.n === 1 && /▾$/.test(pickInfo.text) && /^\d{2}\/\d{2}/.test(pickInfo.text),
    '只显示当前日期 + ▾（不是一排平铺小按钮）',
    `页面上（Sheet 外）带 ▾ 的按钮 ${pickInfo.n} 个，文案「${pickInfo.text}」`,
  )
  check(sheetBefore === 0, '未点击时 Sheet 是收起的', `页面上 .sheet 数量 = ${sheetBefore}`)

  /**
   * Sheet 里**应该**列出哪些日期：产品是按 `graded` 的 `assignDate` 去重排的
   * （Classroom.tsx：`[...new Set(graded.map(a => a.assignDate))].sort(desc).slice(0,30)`，
   *  每行渲染成 `MM/DD` + 星期）。
   * 这里从**本班的已批改档案**（快照里读，与产品同一个数据源）算出这份集合，
   * 再和屏上列出来的逐一对齐 —— 原来那条 `>= 1` 兜得太低：
   * 设计上要列**所有**可选日期，只列 1 个也是"坏了一半"却照样绿。
   */
  const wantDates = await page.evaluate(
    ([k, classId]) => {
      const st = JSON.parse(localStorage.getItem(k) ?? '{}').state ?? {}
      const graded = (st.assignments ?? []).filter((a) => a.classId === classId && a.status === 'graded')
      return [...new Set(graded.map((a) => a.assignDate))].sort((x, y) => (x < y ? 1 : -1)).slice(0, 30)
    },
    [CLS_KEY, DEMO_CLASS_ID],
  )
  const wantRowText = wantDates.map((d) => `${d.slice(5).replace('-', '/')}${weekdayTextOf(d)}`.replace(/\s+/g, ''))

  await page.locator('button', { hasText: '▾' }).first().click()
  await page.waitForTimeout(400)
  const sheet = await page.evaluate(() => {
    const box = document.querySelector('.sheet')
    const rows = [...(box?.querySelectorAll('button') ?? [])].filter((b) =>
      /^\d{2}\/\d{2}周[日一二三四五六]/.test((b.textContent ?? '').replace(/\s+/g, '')),
    )
    return {
      open: Boolean(box),
      title: (box?.querySelector('h2')?.textContent ?? '').trim(),
      rows: rows.map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()),
      nRowsInSheet: box ? box.querySelectorAll('button').length : 0,
    }
  })
  check(sheet.open && sheet.title === '选择日期', '点击后弹出 Sheet（标题「选择日期」）', `open=${sheet.open} title="${sheet.title}"`)
  {
    const got = sheet.rows.map((r) => r.replace(/\s+/g, ''))
    const missing = wantRowText.filter((w) => !got.includes(w))
    const extra = got.filter((g) => !wantRowText.includes(g))
    check(
      wantRowText.length > 0 && missing.length === 0 && extra.length === 0,
      `Sheet 列出了**全部**可选日期（本班 ${wantDates.length} 个已批改日期：${wantDates.join('、')}）`,
      `${got.length} 个日期行：${sheet.rows.join(' | ')}`,
      missing.length || extra.length
        ? `少 ${JSON.stringify(missing)} / 多 ${JSON.stringify(extra)}`
        : '与快照里 graded 的 assignDate 集合完全一致',
    )
  }

  // 点一个「不是当前」的日期 → 上面的作业选择器要真的跟着切，Sheet 收起
  if (sheet.rows.length >= 2) {
    const before = await page.evaluate(() => {
      const s = [...document.querySelectorAll('select.input')].find((x) => x.options.length > 1 && /作业/.test(x.options[0]?.textContent ?? ''))
      return s ? s.options[s.selectedIndex]?.textContent ?? '' : ''
    })
    await page
      .locator('.sheet button')
      .filter({ hasText: sheet.rows[1].replace(/\s+/g, '') })
      .first()
      .click()
    await page.waitForTimeout(450)
    const after = await page.evaluate(() => {
      const s = [...document.querySelectorAll('select.input')].find((x) => x.options.length > 1 && /作业/.test(x.options[0]?.textContent ?? ''))
      return {
        now: s ? s.options[s.selectedIndex]?.textContent ?? '' : '',
        sheetOpen: Boolean(document.querySelector('.sheet')),
      }
    })
    check(
      after.now !== before && !after.sheetOpen,
      '点日期后 Sheet 收起、并真的切到了那天的作业',
      `作业选择器：「${before}」→「${after.now}」；Sheet 还在吗：${after.sheetOpen}`,
    )
  }

  /* ================= ⑧ 「正在上课」卡在各种标题形状下显示什么 ================= */

  say('【场景 8】「正在上课」卡的标题形状：先剥开头班名，再按第一个空格拆科目/老师')
  await ctx.clock.setFixedTime(new Date('2026-09-24T09:15:00'))
  await goto(page, '/classroom', { clock: '09:15', date: '2026-09-24', weekday: '四' })

  /**
   * 把周四第 1 节的标题换成一个形状，重新打开教室端，读卡上的两行。
   * ⚠️ 走的是**真实渲染路径**（快照 → dayState → 卡片），不是单独调 splitTitle：
   *    量到的就是"这种标题在屏幕上到底长什么样"。
   */
  async function cardForTitle(title) {
    await page.evaluate(
      ([k, t]) => {
        const snap = JSON.parse(localStorage.getItem(k) ?? '{}')
        snap.state.schedule = (snap.state.schedule ?? []).map((s) =>
          s.scope === 'class' && s.weekday === 4 && s.start === '08:55' ? { ...s, title: t } : s,
        )
        localStorage.setItem(k, JSON.stringify(snap))
      },
      [CLS_KEY, title],
    )
    await goto(page, '/classroom', { clock: '09:15', date: '2026-09-24', weekday: '四' })
    return readCardLines(page)
  }

  for (const shape of TITLE_SHAPES) {
    const got = await cardForTitle(shape.raw)
    const subject = got.found ? (got.subject ?? '') : '(没找到卡片)'
    const teacher = got.found ? (got.teacher ?? '') : '(没找到卡片)'
    console.log(`\n  ── 标题「${shape.raw}」—— ${shape.why}`)
    check(
      got.found && subject === shape.subject && got.subjectPx === '30px',
      `科目＝「${shape.subject}」（30px 居中）`,
      got.found ? `实测「${subject}」 font-size=${got.subjectPx ?? '(无)'}` : `没找到「正在上课」卡：${short(got.panelText)}`,
    )
    check(
      got.found && teacher === shape.teacher,
      shape.teacher ? `老师＝「${shape.teacher}」（16px 居中）` : '老师那行不渲染（没有老师）',
      got.found
        ? teacher
          ? `实测「${teacher}」 font-size=${got.teacherPx ?? '(无)'}`
          : '实测：没有 16px 的那一行'
        : '没找到「正在上课」卡',
    )
  }

  /* ================= ③ 放假当天 ================= */

  say(`【场景 3】${HOLIDAY_ISO}（周${'日一二三四五六'[dow(HOLIDAY_ISO)]}）10:15 —— 中秋节假期，本该有周五的课`)
  await ctx.clock.setFixedTime(new Date(`${HOLIDAY_ISO}T10:15:00`))
  await goto(page, '/classroom', { clock: '10:15', date: HOLIDAY_ISO, weekday: '日一二三四五六'[dow(HOLIDAY_ISO)] })
  const sched3 = await waitSched(page)
  const body3 = await bodyText(page)
  console.log(`  · 课表区文本：${short(sched3, 160)}`)
  check(/今天放假 · 中秋节/.test(sched3), '显示「今天放假 · 中秋节」', short(sched3, 100))
  check(/没有课，好好休息/.test(sched3), '显示「没有课，好好休息」', short(sched3, 100))
  check(
    !sched3.includes(CARD_SCHEDULE.fri1.title) && !sched3.includes(CARD_SCHEDULE.fri1.start),
    '一条课都不显示（连课表列表也没有）',
    /周五|10:50|化学/.test(sched3) ? `出现了课：${short(sched3)}` : '课表区没有 10:50 / 化学 / 列表项',
  )
  check(!/正在上课/.test(sched3), '放假当天不会出现「正在上课」卡', short(sched3, 80))
  check(!body3.includes(DEMO_CLASS + ' 物理'), '演示的教师课表也没漏进来', body3.includes('物理') ? '页面上还有「物理」字样' : '没有')

  /* ================= ④ 调休上班日 ================= */

  say(`【场景 4】${MAKEUP_ISO}（周${'日一二三四五六'[dow(MAKEUP_ISO)]}）08:00 —— 官方调休上班日，周末但要上课`)
  await ctx.clock.setFixedTime(new Date(`${MAKEUP_ISO}T08:00:00`))
  await goto(page, '/classroom', { clock: '08:00', date: MAKEUP_ISO, weekday: '日一二三四五六'[dow(MAKEUP_ISO)] })
  const sched4 = await waitSched(page)
  console.log(`  · 课表区文本：${short(sched4, 200)}`)
  check(!/今天放假/.test(sched4), '不显示「今天放假」', short(sched4, 100))
  check(
    sched4.includes(CARD_SCHEDULE.sun1.start) && sched4.includes(CARD_SCHEDULE.sun1.title),
    `正常显示课表（周日那条 ${CARD_SCHEDULE.sun1.start} ${CARD_SCHEDULE.sun1.title} 在）`,
    short(sched4, 160),
  )
  check(/今天是调休上班日/.test(sched4), '同时给出「调休上班日，按周X课表上」的提示', short(sched4, 120))

  /* ================= ⑤ 19:19 / 19:21 / 23:59 / 00:01 ================= */

  const CLOSING = /恭喜，今日的课业已全部完成/
  const HOME = /明天 0:00 自动恢复显示作业情况/

  say('【场景 5】§7.1 的钟点行为：19:20 后作业区换收尾语，0:00 自动恢复')
  for (const [time, expectClosing, label] of [
    ['2026-09-17T19:19:00', false, '19:19 —— 还差一分钟，作业区照旧'],
    ['2026-09-17T19:21:00', true, '19:21 —— 已过 19:20，换成收尾语'],
    ['2026-09-17T23:59:00', true, '23:59 —— 收尾语仍在'],
    ['2026-09-18T00:01:00', false, '次日 00:01 —— 自动恢复显示作业'],
  ]) {
    const d = new Date(time)
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const wd = '日一二三四五六'[d.getDay()]
    console.log(`\n  ── ${label}`)
    await ctx.clock.setFixedTime(d)
    await goto(page, '/classroom', { clock: hhmm, date: iso, weekday: wd })
    const body = await bodyText(page)
    const hasClosing = CLOSING.test(body)
    const hasWork = /当前题目/.test(body) && HOME.test(body) === hasClosing
    const closingLine = (body.match(/恭喜，今日的课业已全部完成[^。]*。?/) ?? [''])[0]
    console.log(`  · 收尾语：「${closingLine || '(无)'}」`)
    check(
      hasClosing === expectClosing,
      expectClosing ? '出现收尾语' : '不出现收尾语',
      hasClosing ? `出现了：「${closingLine}」` : '没有「恭喜，今日的课业已全部完成」',
    )
    check(
      hasWork === !expectClosing,
      expectClosing ? '作业区被替换（「当前题目」不再显示）' : '作业正常显示（「当前题目」在）',
      expectClosing
        ? (/当前题目/.test(body) ? '「当前题目」还在' : '「当前题目」已隐藏')
        : (/当前题目/.test(body) ? '「当前题目」在' : '「当前题目」不见了'),
    )
    if (expectClosing) {
      check(HOME.test(body), '收尾语下方写着「明天 0:00 自动恢复显示作业情况」', HOME.test(body) ? '在' : '不在')
    }
  }

  /* ================= ⑥ TTS 不可用时的浮层最短展示 ================= */

  say('【场景 6】把 speechSynthesis 打坏（说话立刻报 onerror），派一条呼叫量浮层停留时长')
  await ctx.clock.setFixedTime(new Date('2026-09-24T14:00:00'))
  await goto(page, '/classroom', { clock: '14:00', date: '2026-09-24', weekday: '四' })

  // 只在**当前页面**装桩：addInitScript 只影响本次导航之后的新文档
  await page.addInitScript(() => {
    window.__tts = { installed: true, calls: [], cancelled: 0 }
    class StubUtterance {
      constructor(text) {
        this.text = String(text ?? '')
        this.onend = null
        this.onerror = null
        this.lang = ''
        this.rate = 1
        this.pitch = 1
        this.volume = 1
        this.voice = null
      }
    }
    const stub = {
      speak(u) {
        // 立刻报「合成失败」—— 模拟这台机器没装语音包 / 被系统打断
        window.__tts.calls.push({ text: u.text, at: performance.now() })
        try {
          u.onerror?.(new Event('error'))
        } catch {
          /* 忽略 */
        }
      },
      cancel() {
        window.__tts.cancelled++
      },
      getVoices: () => [],
      pause() {},
      resume() {},
      addEventListener() {},
      removeEventListener() {},
      onvoiceschanged: null,
      speaking: false,
      pending: false,
      paused: false,
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: StubUtterance, configurable: true, writable: true })
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true, writable: true })
  })

  await page.goto(`${BASE}/classroom`, { waitUntil: 'networkidle' })
  await waitSched(page)
  await page.waitForTimeout(300)
  /*
   * ⚠️ 这里原来只验 `window.__tts.installed` —— 那是**桩自己的标志位**，
   *    产品坏掉（不问 TTS 就自己出队）它照样是 true，恒真（2026-09-27 改）。
   *    "装好没装好"真正的判据是**桩有没有被调用过**，而那要等下面派完呼叫才量得到：
   *    见场景 6 里 `m1.tts.calls.length >= 1` 那条（speak() 被调用 = 产品真的在走 TTS）。
   *    这里保留一句提示，把"装好了"和"用上了"分开说。
   */
  const stubOn = await page.evaluate(() => Boolean(window.__tts?.installed))
  note(
    `TTS 桩已装载：${stubOn ? 'window.__tts 在' : '**没装上**'}（真正的判据是下面 speak() 被调用过几次）`,
  )

  const CALL_TEXT = '请 12 号、37 号，到物理老师办公室。'
  const CHARS = await page.evaluate((t) => t.replace(/\s+/g, '').length, CALL_TEXT)
  const EXPECT_HOLD = Math.max(runtime.BUBBLE_MIN_MS, CHARS * runtime.BUBBLE_MS_PER_CHAR)
  note(`呼叫文案：「${CALL_TEXT}」（去空白后 ${CHARS} 字）`)
  note(`按源码常量算：max(${runtime.BUBBLE_MIN_MS}, ${CHARS} × ${runtime.BUBBLE_MS_PER_CHAR}) = ${EXPECT_HOLD}ms`)

  /**
   * 量一条呼叫的浮层停留时长。
   * 出队靠「语音回调」和「最短展示」两个计时器抢，这里播的桩会让语音那边**立刻**结束，
   * 所以量到的就是最短展示那段 —— 也就是"语音不可用时人到底能看到多久"。
   */
  async function measureBubble(callId) {
    // 用 MutationObserver 盯**浮层本身**（文案 46px 那一层最外面的 fixed 遮罩），
    // 不用轮询 body.innerText —— 那样只能采到"某一刻在不在"，
    // 采到 0ms 也分不清是真的秒跳还是采样没跟上。
    await page.evaluate(() => {
      window.__bub?.obs?.disconnect()
      // ⚠️ 这里必须用 performance.now()：时钟被 setFixedTime 钉住之后 Date.now()
      // **根本不走**，拿它量时长永远是 0（这个坑踩过一次，量出来"停留 0ms"）。
      window.__bub = { up: null, down: null, samples: [] }
      const b = window.__bub
      const isOverlay = (n) =>
        n.nodeType === 1 && n.tagName === 'DIV' && n.className.includes('fixed inset-0 z-[70]')
      const scan = (root) => {
        for (const el of root.querySelectorAll?.('div') ?? []) {
          if (!isOverlay(el)) continue
          if (b.up === null) b.up = { at: performance.now(), html: el.outerHTML.slice(0, 90) }
        }
      }
      scan(document.body)
      b.obs = new MutationObserver(() => {
        if (b.up && b.down) return
        scan(document.body)
        const nowThere = Boolean(document.querySelector('div.fixed.inset-0.z-\\[70\\]'))
        if (!nowThere && b.up && b.down === null) b.down = { at: performance.now() }
        if (b.samples.length < 8) b.samples.push([Math.round(performance.now()), nowThere])
      })
      b.obs.observe(document.body, { childList: true, subtree: true })
    })
    const handle = await page.evaluateHandle(() => new BroadcastChannel('shugao.classroom.v1'))
    const postedAt = await page.evaluate(
      ([bc, id, text]) => {
        const at = performance.now()
        bc.postMessage({
          type: 'call',
          call: {
            id,
            assignmentId: 'a-demo-1',
            classId: 'c-demo-1',
            studentNos: ['12', '37'],
            text,
            room: '物理老师办公室',
            sentAt: [Date.now()],
            states: { 12: 'called', 37: 'called' },
          },
        })
        return at
      },
      [handle, callId, CALL_TEXT],
    )
    const t0 = Date.now()
    let bub = null
    for (;;) {
      const s = await page.evaluate(() => ({
        up: window.__bub?.up ?? null,
        down: window.__bub?.down ?? null,
        samples: window.__bub?.samples?.slice(0, 8) ?? [],
      }))
      if (s.up && s.down) {
        bub = s
        break
      }
      if (Date.now() - t0 > 30_000) {
        bub = s
        break
      }
      await page.waitForTimeout(50)
    }
    const tts = await page.evaluate(() => ({
      installed: window.__tts.installed,
      calls: window.__tts.calls.map((c) => ({ ...c })),
      cancelled: window.__tts.cancelled,
    }))
    await page.evaluate(() => {
      window.__bub?.obs?.disconnect()
    })
    await page.evaluate((bc) => bc.close(), handle)
    const spokeAt = tts.calls.at(-1)?.at ?? null
    return {
      bub,
      tts,
      hold: bub?.up && bub?.down ? bub.down.at - bub.up.at : null,
      showDelay: bub?.up ? bub.up.at - postedAt : null,
      speakAt: spokeAt === null ? null : spokeAt - postedAt,
    }
  }

  // 确认队列是空的（上一场景留过浮层的话先关掉）
  const closeAll = page.getByRole('button', { name: '关闭' })
  for (let i = 0; i < 6 && (await closeAll.count()) > 0; i++) {
    await closeAll.first().click()
    await page.waitForTimeout(1500)
  }

  const m1 = await measureBubble('clockcheck-call-1')
  console.log(`  · 浮层轨迹：${JSON.stringify(m1.bub)}`)
  if (!m1.bub?.up) {
    check(false, '呼叫浮层出现了', '30 秒内页面上没看到播报浮层（div.fixed.inset-0.z-[70]）')
  } else {
    const calls = m1.tts.calls.length
    note(
      `TTS 侧：speak() 被调用 ${calls} 次，桩每次都立刻回调 onerror —— ` +
        `语音这条路 ${m1.speakAt}ms 就走完了；浮层是派发后 ${m1.showDelay}ms 出现的`,
    )
    /*
     * TTS 桩"真的被用上了"的判据（原来只验 window.__tts.installed，那是恒真的）。
     * 顺带证明派发出去的文案确实交给了语音这条路 —— 桩没被调用 = 产品没走 TTS。
     */
    check(
      calls >= 1 && m1.tts.calls.some((c) => c.text.includes(CALL_TEXT.slice(0, 6))),
      'TTS 桩真的被调用了（speak() 收到的是这条呼叫的文案）',
      `speak() 调用 ${calls} 次：${m1.tts.calls.map((c) => short(c.text, 24)).join(' / ') || '(一次都没有)'}`,
      stubOn ? '桩已装载' : '⚠️ 桩连装载都没成功',
    )
    check(
      m1.hold !== null && m1.hold >= EXPECT_HOLD - 150,
      `浮层停留 ≥ max(${runtime.BUBBLE_MIN_MS}ms, 字数×${runtime.BUBBLE_MS_PER_CHAR}ms) = ${EXPECT_HOLD}ms`,
      m1.hold === null ? '没量到（浮层一直没消失）' : `实测停留 ${m1.hold}ms`,
      '容差 150ms（25ms 轮询采样）',
    )
    check(
      m1.hold !== null && m1.hold >= 3000,
      '不再「1 秒就被顶掉」',
      m1.hold === null ? '没量到' : `实测停留 ${m1.hold}ms（旧行为是 onerror 立刻出队，约 0.7 秒）`,
    )
    // 出队后浮层要消失，队列要能继续走
    await page.waitForTimeout(400)
    const gone = await page.evaluate((t) => !document.body.innerText.includes(t), CALL_TEXT)
    check(gone, '停留结束后浮层自动消失（队列能接着走）', gone ? '已消失' : '还挂在屏幕上')

    // 再派一条，确认不是"第一次特例"
    const m2 = await measureBubble('clockcheck-call-2')
    check(
      m2.hold !== null && m2.hold >= EXPECT_HOLD - 150,
      '第二条呼叫同样守住了最短展示时长（不是一次性的巧合）',
      m2.hold === null ? '没量到' : `实测停留 ${m2.hold}ms`,
      `期望 ≈ ${EXPECT_HOLD}ms`,
    )
  }

  /* ================= ⑨ 课前 5 分钟的下课铃（softChime） ================= */

  say('【场景 9】课前 5 分钟的下课铃：周四 08:50（第 1 节 08:55 开始）')
  note(
    `从 tts.ts 读到：下课铃 ${SOFT_F}Hz / 音量峰值 ${SOFT_VOL}；` +
      `播报提示音「叮咚」${LOUD_FS.join('、')}Hz（音量 0.22）`,
  )

  /**
   * AudioContext 桩：**数振荡器**。
   *
   * 为什么数得出来"响的是哪一种"：两种声音都是 WebAudio 现场合成的（不加载音频文件）——
   *   · `chime()`（播报前「叮咚」）= **2 个**振荡器（988 / 1319Hz，音量 0.22）
   *   · `softChime()`（下课铃）    = **1 个**振荡器（1174.7Hz，音量 0.07，所以要"轻"）
   * 频率 + 个数 + 音量峰值三样一起看，就能把「下课铃」和「播报提示音」分开。
   *
   * 装成 **context 级**（`ctx.addInitScript`）：从这一刻起每个新文档开头都生效，
   * 导航过去时桩已经在位（page 级的只影响那一个 page，这里统一用 ctx 级）。
   */
  await ctx.addInitScript(() => {
    window.__audio = { ctxCount: 0, osc: [], gains: [] }
    const A = window.__audio
    class StubGain {
      constructor() {
        this.gain = {
          setValueAtTime() {},
          exponentialRampToValueAtTime(v) {
            A.gains.push(v)
          },
        }
      }
      connect() {}
    }
    class StubOsc {
      constructor() {
        this.type = ''
        this.frequency = { value: 0 }
      }
      connect() {}
      start(t) {
        this._start = t
      }
      stop() {
        // tts.ts 是 createOscillator → createGain → 设音量 → start/stop，
        // 所以 stop 这一刻最后一个 gain 上挂的就是这个音的音量包络。
        const ramp = A.gains.slice(-2)
        A.osc.push({
          f: this.frequency.value,
          type: this.type,
          gainPeak: ramp.length ? Math.max(...ramp) : null,
        })
      }
    }
    class StubAudioContext {
      constructor() {
        A.ctxCount++
        this.state = 'running'
        this.currentTime = 0
        this.destination = {}
      }
      createOscillator() {
        return new StubOsc()
      }
      createGain() {
        return new StubGain()
      }
      resume() {
        return Promise.resolve()
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      value: StubAudioContext,
      configurable: true,
      writable: true,
    })
  })

  await ctx.clock.setFixedTime(new Date('2026-09-24T08:50:00'))
  await goto(page, '/classroom', { clock: '08:50', date: '2026-09-24', weekday: '四' })
  const stubOn9 = await readAudio(page)
  /*
   * ⚠️ 原来这里是 `check(stubOn9.installed, '桩已装好')` —— 验的是**桩自己的标志位**，
   *    产品根本不用 WebAudio 时它照样是 true，恒真（2026-09-27 改）。
   *    "AudioContext 真的被用上了"的判据是**振荡器被记下来了**，也就是下面那两条：
   *    soft ≥ 1（下课铃响了）、loud = 0（响的不是播报提示音）。
   */
  note(
    `AudioContext 桩已装载：${stubOn9.installed ? 'window.__audio 在' : '**没装上**'}，` +
      `ctxCount=${stubOn9.ctxCount}（真正的判据是下面数出来的振荡器）`,
  )

  // 下课铃的 tick 是 20 秒一次，窗开宽一点：宁可多等，也不要时好时坏
  const bell = await waitOsc(page, 1, 25_000)
  const soft = bell.osc.filter((o) => Math.abs(o.f - SOFT_F) < 1)
  const loud = bell.osc.filter((o) => LOUD_FS.some((f) => Math.abs(o.f - f) < 1))
  console.log(`  · 观察到的振荡器：${audioText(bell)}（AudioContext 建了 ${bell.ctxCount} 个）`)
  check(
    soft.length >= 1,
    `课前 5 分钟响了下课铃（${SOFT_F}Hz 的振荡器 ≥ 1 个）`,
    `实测响了 ${soft.length} 声，全部振荡器：${audioText(bell)}`,
    '每节课只响一次（rungRef 去重），但断言只要求 ≥ 1，避免 tick 抖动变 flaky',
  )
  check(
    loud.length === 0 && soft.every((o) => o.gainPeak !== null && o.gainPeak <= 0.1),
    '响的是「轻声」下课铃，不是播报前的「叮咚」',
    `频率 ${bell.osc.map((o) => `${o.f}Hz`).join('、') || '(无)'}；音量峰值 ` +
      `${bell.osc.map((o) => o.gainPeak).join('、') || '(无)'}`,
    `期望只有 ${SOFT_F}Hz、音量 ≈ ${SOFT_VOL}（播报的「叮咚」是 ${LOUD_FS.join('/')}Hz、0.22）`,
  )

  say('  ── 负例①：周四 08:45（课前 10 分钟）不该响 —— 时间窗是"正好 5 分钟"')
  await ctx.clock.setFixedTime(new Date('2026-09-24T08:45:00'))
  await goto(page, '/classroom', { clock: '08:45', date: '2026-09-24', weekday: '四' })
  await page.waitForTimeout(21_000) // 20 秒一次的 tick 至少跑过一轮，否则"没响"可能只是还没轮到
  const early = await readAudio(page)
  check(
    early.osc.length === 0,
    '课前 10 分钟不响（不是"每节课前一直响"）',
    audioText(early),
    '等了 21 秒（覆盖至少一轮 tick，避开 20 秒窗口）',
  )

  say(`  ── 负例②：${HOLIDAY_ISO}（中秋节）10:45 不该响 —— 放假那天根本没课`)
  await ctx.clock.setFixedTime(new Date(`${HOLIDAY_ISO}T10:45:00`))
  await goto(page, '/classroom', {
    clock: '10:45',
    date: HOLIDAY_ISO,
    weekday: weekdayCharOf(HOLIDAY_ISO),
  })
  await page.waitForTimeout(21_000)
  const restDay = await readAudio(page)
  check(
    restDay.osc.length === 0,
    '放假当天不响下课铃（isRestDay 拦住了）',
    audioText(restDay),
    `那天课表里本该有周五 ${CARD_SCHEDULE.fri1.start} 的课 —— 所以这是真的拦住了，不是没课可响`,
  )

  /* ================= ⑩ 静音 = 暂停（周三 QUIET_SLOTS / 考试模式） ================= */

  say(
    `【场景 10】周三静音时段（${QUIET_SLOT.from}–${QUIET_SLOT.to}）：呼叫**不响不念不霸屏**，` +
      `但**队列留着**，${QUIET_SLOT.to} 后从队首接着播`,
  )
  const QUIET_CALL_1 = '静音甲：请 1 号到办公室。'
  const QUIET_CALL_2 = '静音乙：请 2 号到办公室。'
  await ctx.clock.setFixedTime(new Date(QUIET_AT))
  await goto(page, '/classroom', {
    clock: QUIET_AT.slice(11, 16),
    date: QUIET_ISO,
    weekday: weekdayCharOf(QUIET_ISO),
  })

  // 派呼叫**之前**就装上观察器：要证明的是"一次都没出现过"，轮询采样会漏掉一闪而过的浮层
  await overlayWatchStart(page)
  await resetSoundCounters(page)
  const bcQuiet = await openCallChannel(page)
  await postCall(page, bcQuiet, 'clockcheck-quiet-1', QUIET_CALL_1)
  await postCall(page, bcQuiet, 'clockcheck-quiet-2', QUIET_CALL_2)
  await page.waitForTimeout(3000) // 不静音的话，浮层在派发后几十毫秒就出现了（场景 6 实测 42ms）
  const during = await overlayWatchRead(page)
  const duringAudio = await readAudio(page)
  const duringTts = await readTts(page)
  const duringBody = await bodyText(page)
  console.log(
    `  · 静音期间（派了 2 条呼叫、等了 3 秒）：浮层出现 ${during.seen} 次；` +
      `振荡器 ${duringAudio.osc.length} 个；speak() ${duringTts.calls.length} 次`,
  )
  check(
    during.seen === 0 && !duringBody.includes(QUIET_CALL_1),
    '不霸屏：浮层一次都没出现',
    `浮层出现 ${during.seen} 次；页面里${duringBody.includes(QUIET_CALL_1) ? '**有**呼叫文案' : '没有呼叫文案'}`,
  )
  check(duringAudio.osc.length === 0, '不响：一个振荡器都没建', audioText(duringAudio))
  check(
    duringTts.calls.length === 0,
    '不念：speak() 一次都没被调用',
    `speak() 调用 ${duringTts.calls.length} 次`,
  )

  // 静音结束：**不重新派发**，看队列里的两条会不会自己接着播
  await ctx.clock.setFixedTime(new Date(AFTER_AT))
  const resumed = await waitOverlay(page, 20_000)
  const afterAudio = await readAudio(page)
  const afterTts = await waitTts(page, 1) // 响铃 → 隔 680ms 才开口，这里等它
  const afterClock = await clockOnScreen(page)
  console.log(`  · 解除后屏上时钟：${afterClock.date} ${afterClock.clock}（钉的是 ${AFTER_AT.slice(11, 16)}）`)
  console.log(`  · 解除后浮层：「${short(resumed ?? '(没等到)', 60)}」`)
  check(
    Boolean(resumed) && resumed.includes(QUIET_CALL_1),
    '静音结束后**从队首接着播**（没有重新派发，说明队列真的留着了）',
    resumed ? `浮层：「${short(resumed, 60)}」` : '20 秒内浮层没出现（队列被丢了？）',
  )
  check(
    Boolean(resumed) && resumed.includes('后面还有') && resumed.includes('1'),
    '两条都还在队列里（浮层上写着「后面还有 1 条呼叫在排队」）',
    resumed ? `浮层：「${short(resumed, 80)}」` : '没等到浮层',
  )
  check(
    afterAudio.osc.length >= 2 &&
      LOUD_FS.every((f) => afterAudio.osc.some((o) => Math.abs(o.f - f) < 1)),
    '解除静音后才真的出声（播报前的「叮咚」= 2 个振荡器）',
    `${audioText(afterAudio)}；speak() ${afterTts.calls.length} 次`,
  )
  await closeCallChannel(page, bcQuiet)

  say('【场景 11】考试模式静音：同一套断言（不响不念不霸屏 + 队列留着）')
  const EXAM_CALL = '考试静音：请 9 号到办公室。'
  await ctx.clock.setFixedTime(new Date('2026-09-24T14:00:00'))
  await goto(page, '/classroom', { clock: '14:00', date: '2026-09-24', weekday: '四' })
  await page.getByRole('button', { name: '考试静音' }).click()
  await page.waitForTimeout(500)
  const examOn = await bodyText(page)
  check(
    examOn.includes('考试进行中 · 已静音'),
    '考试静音已打开（全屏黑底时钟）',
    examOn.includes('考试进行中') ? '屏上写着「考试进行中 · 已静音」' : short(examOn, 120),
  )

  await overlayWatchStart(page)
  // 计数器清零：点「考试静音」时 unlockAudio() 会 speak 一次空串、并 new 一个 AudioContext
  await resetSoundCounters(page)
  const bcExam = await openCallChannel(page)
  await postCall(page, bcExam, 'clockcheck-exam-1', EXAM_CALL)
  await page.waitForTimeout(3000)
  const examDuring = await overlayWatchRead(page)
  const examAudio = await readAudio(page)
  const examTts = await readTts(page)
  const examBody = await bodyText(page)
  console.log(
    `  · 考试静音期间：浮层出现 ${examDuring.seen} 次；振荡器 ${examAudio.osc.length} 个；` +
      `speak() ${examTts.calls.length} 次`,
  )
  check(
    examDuring.seen === 0 && !examBody.includes(EXAM_CALL),
    '不霸屏：浮层一次都没出现',
    `浮层出现 ${examDuring.seen} 次；页面里${examBody.includes(EXAM_CALL) ? '**有**呼叫文案' : '没有呼叫文案'}`,
    '考试是全屏黑底时钟，呼叫不该盖在它上面',
  )
  check(examAudio.osc.length === 0, '不响：一个振荡器都没建', audioText(examAudio))
  check(examTts.calls.length === 0, '不念：speak() 一次都没被调用', `speak() 调用 ${examTts.calls.length} 次`)

  // 「结束考试」有两个（面板上那个 + 黑屏里那个），点**后一个**：黑屏盖在最上面，点得到
  await page.getByRole('button', { name: '结束考试' }).last().click()
  const examResumed = await waitOverlay(page, 20_000)
  const examAfter = await waitTts(page, 1) // 同上：先响「叮咚」，680ms 后才开口
  check(
    Boolean(examResumed) && examResumed.includes(EXAM_CALL),
    '结束考试后从队首接着播（考试期间队列没被丢掉）',
    examResumed ? `浮层：「${short(examResumed, 60)}」` : '20 秒内浮层没出现（队列被丢了？）',
  )
  check(examAfter.calls.length >= 1, '解除后真的念了', `speak() 调用 ${examAfter.calls.length} 次`)
  await closeCallChannel(page, bcExam)

  /* ================= 收尾：设备角色复位 ================= */

  /*
   * ⚠️ 这里原来是 `check(roleAfter === 'teacher', '设备角色已复位')` —— 读回的正是脚本
   *    自己上一句 `setItem` 写进去的值，**验的是脚本不是产品**，恒真（2026-09-27 改）。
   *    有价值的其实是 `roleBefore`（教室端有没有把设备标掉，只当提示打印了）。
   *
   *    现在改成断言**产品行为**：复位之后重新加载设置页，
   *      · 没有被 Guard 拦去登录页（URL 还是 /settings）；
   *      · 设置页的「本机角色 · 这台设备」显示的是**教师端**（Settings.tsx 按 deviceRole() 渲染）。
   *    这两条合起来就是"复位真的生效了"——产品坏了（Guard 改错 / 角色没读回来）会红。
   */
  say('【收尾】把本机设备角色改回 teacher，再用**产品行为**验一次（教室端会把它标成 classroom）')
  const roleBefore = await page.evaluate(() => localStorage.getItem('shugao.deviceRole'))
  note(`复位前 shugao.deviceRole = ${roleBefore}（教室端自身会把它写成 classroom）`)
  await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const afterReset = await page.evaluate(() => {
    /*
     * 「本机角色 → 这台设备」那一行是 ui.tsx 的 KV：一个 flex div，左边标签右边 Tag。
     * 按**文本**找（标签「这台设备」），不按第几层子节点找 —— 那正是本文件一贯的找法。
     */
    const row = [...document.querySelectorAll('div')].find((d) => {
      const t = (d.textContent ?? '').replace(/\s+/g, '')
      return t.startsWith('这台设备') && t.length < 30
    })
    return {
      url: location.pathname,
      roleText: row ? (row.textContent ?? '').replace(/\s+/g, ' ').trim() : null,
      h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
    }
  })
  check(
    afterReset.url === '/settings',
    '复位后能直接进设置页（没有被 Guard 拦去登录页）',
    `屏上 url = ${afterReset.url}`,
    '被拦的话这里会是 /login',
  )
  check(
    (afterReset.roleText ?? '').includes('教师端') && !(afterReset.roleText ?? '').includes('教室端'),
    '设置页「本机角色 · 这台设备」显示的是**教师端**',
    afterReset.roleText ? `这一行：「${afterReset.roleText}」` : `没找到那一行（h1=${JSON.stringify(afterReset.h1)}）`,
    'Settings.tsx 按 deviceRole() 渲染，产品没读回来的话这里还是「教室端」',
  )
} catch (e) {
  failures.push(`脚本异常：${e instanceof Error ? e.message : String(e)}`)
  console.log(`\n💥 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
} finally {
  try {
    await browser?.close()
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 结果 ---------------- */

if (errors.length) {
  console.log(`\n=== 运行时报错（${errors.length} 条）===`)
  for (const e of errors.slice(0, 20)) console.log(`  ${e}`)
  failures.push(`控制台/页面报了 ${errors.length} 条错误`)
}

console.log(`\n================ 结果 ================`)
console.log(`  通过 ${passed} 条，失败 ${failures.length} 条`)
for (const f of failures) console.log(`  ❌ ${f}`)
if (failures.length) process.exitCode = 1
else console.log('  全部通过 ✅')

/*
 * ============================================================
 * 跑这个脚本时发现的问题（留档：哪些修了、哪些还在）
 * ============================================================
 *
 * ① ✅ **已修**（2026-09-25）：班级课表的标题里，「班名」和「科目 老师」曾经只能二选一。
 *    教室端只显示 `scope='class'` 且 `classId === 本班` 的行；
 *    而「粘贴课表」链路里 classId 是 `matchClass()` 从**标题文本**里认班名才给的
 *    （lib/scheduleParse.ts）。于是：
 *      · 标题不写班名（如「语文 张老师」）→ classId 是空的 → 教室端一条都不显示；
 *      · 标题写班名（如「高二(3)班 语文 张老师」）→ classId 对了，但
 *        `splitTitle()` 按第一个空格拆，卡上会把「高二(3)班」当成科目显示成 30px 大字。
 *    修法是让 `splitTitle()` **先剥掉开头的班名**再拆（Classroom.tsx），
 *    这样两种标题形状都能用。本脚本现在两头都验：
 *      · 「准备」一节用**粘贴链路的真实数据**（标题带班名）看卡片（端到端）；
 *      · 场景 8 逐个形状量一遍（带/不带班名、全角/半角括号、只有科目、班会自习选修课）。
 *    ⚠️ 标题里的班名**不能删**：删了 `matchClass()` 就给不出 classId，教室端一条课都不显示。
 *
 * ② ⚠️ **仍是现状**：`Classroom.tsx` 里「按钟点」的那几处仍然读设备本地 `new Date()`
 *    （时钟、closing、下课铃、dayItems…），没有走 §一 约定的 `beijingNow()`。
 *    本机时区是 +08:00 时两者等价，所以现在测得过；一旦设备时区不是 +08:00，
 *    这块屏就会按当地时间切换。本脚本开头有时区检查，会当场把这件事报出来。
 */

