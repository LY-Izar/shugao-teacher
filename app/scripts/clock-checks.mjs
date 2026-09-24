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
 * ⚠️ 这暴露了一个真实的产品裂缝（见文末「已知裂缝」）：
 * 同一个字段既要"能被 matchClass 认出班号"、又要"科目在前老师在后"，
 * 只有写成「高二(3)班 语文 张老师」才能同时满足 —— 而那样 `splitTitle` 会把
 * 班名当成科目，卡上显示成大字的「高二(3)班」。所以这个脚本用它验证**导入链路**，
 * 再用 CLS_ROWS 覆盖一遍教室端真正要读的数据（和种子数据同形状）。
 */
const CLASS_SCHEDULE = `
周四 08:55-09:35 ${DEMO_CLASS} 语文 张老师
周四 11:05-11:45 ${DEMO_CLASS} 英语 陈老师
周五 10:50-11:30 ${DEMO_CLASS} 化学 李老师
周日 08:50-09:30 ${DEMO_CLASS} 历史 周老师
`.trim()

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
 * 「正在上课」那张卡：科目 / 老师两行的文案、字号、对齐，还有时间区间。
 *
 * 找法**不靠层级**：那一块是 Panel 里唯一带内联 `font-size: 30px` / `16px`
 * 且 `text-align: center` 的 div（卡片形状是这部分设计的一部分，
 * 按样式认比按第几层子节点认稳），再拿「正在上课」那一行做交叉验证。
 */
async function readCurrentCard(page) {
  /** 期望的时间区间，从外面传进去 —— page.evaluate 的函数体会被序列化成字符串，
   *  写在里面的 \uXXXX 转义会被吃掉（这个坑踩过一次），所以别在里面拼转义。 */
  const rangeWant = {
    start: CARD_SCHEDULE.thu1.start,
    end: CARD_SCHEDULE.thu1.end,
    dash: '–',
    text: `${CARD_SCHEDULE.thu1.start}–${CARD_SCHEDULE.thu1.end}`,
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

  // ③ 换成「科目 老师」标题的那份（见 CLS_ROWS 上方注释：粘贴链路给不出这种标题）
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
    check(
      after.cls.length === 4 && after.graded.length >= 2,
      '准备就绪：4 条班级课表 + ≥2 份已批改档案（日期选择器才会渲染）',
      `class=${after.cls.length} 条，graded=${after.graded.length} 份`,
    )
  }

  /* ================= ① 某节课正在进行的中间时刻 ================= */

  say(`【场景 1】${'2026-09-24'}（周四）09:15 —— 第 1 节 ${CARD_SCHEDULE.thu1.start}–${CARD_SCHEDULE.thu1.end} 正在进行`)
  await ctx.clock.setFixedTime(new Date('2026-09-24T09:15:00'))
  await goto(page, '/classroom', { clock: '09:15', date: '2026-09-24', weekday: '四' })
  const card = await readCurrentCard(page)
  const body1 = await bodyText(page)
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
    check(/正在上课/.test(card.panelText), '第一行是「正在上课」+ 起止时间', short(card.panelText, 90))
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
  const pickInfo = await page.evaluate(() => {
    const outside = [...document.querySelectorAll('button')].filter((b) => !b.closest('.sheet'))
    const withArrow = outside.filter((b) => (b.textContent ?? '').includes('▾'))
    return {
      n: withArrow.length,
      text: withArrow[0] ? (withArrow[0].textContent ?? '').replace(/\s+/g, ' ').trim() : '',
    }
  })
  const sheetBefore = await page.locator('.sheet').count()
  check(
    pickInfo.n === 1 && /▾$/.test(pickInfo.text) && /^\d{2}\/\d{2}/.test(pickInfo.text),
    '只显示当前日期 + ▾（不是一排平铺小按钮）',
    `页面上（Sheet 外）带 ▾ 的按钮 ${pickInfo.n} 个，文案「${pickInfo.text}」`,
  )
  check(sheetBefore === 0, '未点击时 Sheet 是收起的', `页面上 .sheet 数量 = ${sheetBefore}`)

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
  check(sheet.rows.length >= 1, 'Sheet 里列出了可选日期', `${sheet.rows.length} 个日期行：${sheet.rows.join(' | ')}`)

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
  const stubOn = await page.evaluate(() => Boolean(window.__tts?.installed))
  check(stubOn, 'TTS 桩已装好（speechSynthesis.speak 会立刻触发 onerror）', stubOn ? 'window.__tts.installed = true' : '没装上')

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

  /* ================= 收尾：设备角色复位 ================= */

  say('【收尾】把本机设备角色改回 teacher（教室端会把它标成 classroom）')
  const roleBefore = await page.evaluate(() => localStorage.getItem('shugao.deviceRole'))
  await page.evaluate(() => localStorage.setItem('shugao.deviceRole', 'teacher'))
  const roleAfter = await page.evaluate(() => localStorage.getItem('shugao.deviceRole'))
  check(roleAfter === 'teacher', '设备角色已复位为 teacher', `${roleBefore} → ${roleAfter}`, '教室端自身会把它写成 classroom')
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
 * 跑这个脚本时发现的两处裂缝（**没改**，因为它们都在别人正在动的文件 /
 * 本轮范围之外 —— 留在这里免得下次又踩）
 * ============================================================
 *
 * ① 班级课表的标题里，「班名」和「科目 老师」这两件事只能二选一。
 *    教室端只显示 `scope='class'` 且 `classId === 本班` 的行；
 *    而「粘贴课表」链路里 classId 是 `matchClass()` 从**标题文本**里认班名才给的
 *    （lib/scheduleParse.ts）。于是：
 *      · 标题不写班名（如「语文 张老师」）→ classId 是空的 → 教室端一条都不显示；
 *      · 标题写班名（如「高二(3)班 语文 张老师」）→ classId 对了，但
 *        `splitTitle()` 按第一个空格拆，卡上会把「高二(3)班」当成科目显示成 30px 大字。
 *    真实课表和 `seed.ts` 的教师课表都走第二条路（标题＝「班级 科目」，没有老师那一节），
 *    所以「正在上课」卡目前在这份数据上永远只有一行（老师那行是空的、不渲染）。
 *    本脚本的做法是：用带班名的数据验证**导入链路**，再用「科目 老师」的数据
 *    验证**教室端显示**（形状和种子数据一致，只是 scope 换成 class）。
 *
 * ② `Classroom.tsx` 里「按钟点」的那几处仍然读设备本地 `new Date()`
 *    （时钟、closing、下课铃、dayItems…），没有走 §一 约定的 `beijingNow()`。
 *    本机时区是 +08:00 时两者等价，所以现在测得过；一旦设备时区不是 +08:00，
 *    这块屏就会按当地时间切换。本脚本开头有时区检查，会当场把这件事报出来。
 */

