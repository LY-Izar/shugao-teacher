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
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { registerTsResolve } from './lib/ts-resolve.mjs'

// 先装 TS 解析钩子，再 import 仓库里的种子数据（见 scripts/lib/ts-resolve.mjs）
registerTsResolve()
const { makeDemoClasses, makeDemoExams } = await import('../src/data/seed.ts')

const BASE = 'http://localhost:5178'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

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
]

/* ---------------- 断言与日志 ---------------- */

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
async function step(name, fn) {
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

/* ---------------- 主流程 ---------------- */

const errors = []
let browser = null
let runErr = null

mkdirSync(OUT, { recursive: true })

try {
  console.log('【截图冒烟 · 教师端】')
  console.log(`  目标：${BASE}`)
  console.log(`  输出：${OUT_REL}/（本轮 ${EXPECTED_FILES.length} 张）`)

  browser = await chromium.launch({ executablePath: EDGE, headless: true })
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
    markers: ['2 个班级 · 91 名学生', '名单完整', '学号是系统的唯一索引'],
  })
  await shot(page, '03 班级列表', '03-classes', { full: true })

  await goto(page, '04 班级详情', '/classes/c-demo-1', {
    markers: ['学生名单 · 45 人', '名单体检通过'],
  })
  await shot(page, '04 班级详情', '04-class-detail', { full: true })

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

  /* ================= S2：作业列表 / 新建 / 收作业查缺 ================= */

  await goto(page, '11 作业列表', '/assignments', {
    markers: ['4 份档案 · 2 份待收缴', '按上次新建', '全部班级'],
  })
  await shot(page, '11 作业列表', '11-assignments', { full: true })

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
    expect: { url: '/calls', markers: ['呼叫记录', '仅教师可见'] },
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

  /* ================= 移动端底部导航：磨砂玻璃 + 液态玻璃胶囊 ================= */

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

  /* ================= 作业列表：班级筛选 ================= */

  const SF = '40 作业列表筛选'
  await step(SF, async () => {
    await page.goto(`${BASE}/assignments`, { waitUntil: 'networkidle' })
    await expectPage(page, SF, { url: '/assignments', markers: ['4 份档案'], date: D0919 })
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

  await goto(page, '41 课表', '/schedule', {
    // 课表那两块标题跟着时钟走（今天 · 周X），所以这里要的是**结构**不是具体星期
    markers: ['我的课表', '整周课表', '今天 · 周'],
  })
  await shot(page, '41 课表', '41-schedule', { full: true, wait: 0 })

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
      markers: ['错题集', '我任教的班级 · 点进去看这个班的错题档案', '我任教的 2 个班 · 91 名学生'],
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
      markers: ['我任教的班级 · 点进去看这个班的错题档案'],
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
      markers: ['4 份档案 · 2 份待收缴', '考试'],
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
    await expectPage(wide, SDE, { url: '/assignments', markers: ['4 份档案'] })
  })
  await shotRaw(wide, SDE, '16-desktop-assignments', { full: true })
} catch (e) {
  runErr = e
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
  if (!runErr && missing.length === 0 && extra.length === 0) {
    try {
      writeFileSync(join(SHOTS_ROOT, 'LATEST'), `${runId}\n`, 'utf8')
    } catch {
      /* 忽略 */
    }
  }
} catch (e) {
  failures.push(`清单比对本身出错：${e instanceof Error ? e.message : String(e)}`)
}

if (runErr) {
  failures.push(`脚本异常中断在第「${currentStep}」步：${runErr instanceof Error ? runErr.message : String(runErr)}`)
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
