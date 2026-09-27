/*
 * 🧪 临时诊断（本轮：shots 里那 2 条红）。跑完就删。
 *
 * 只驱动 shots.mjs 第 35–37 节里那两条断言，**不跑全量**：
 *   ① 「展开层：再展开一次，导航又是透明的」      → 连点前后逐档读 nav.opacity / aria-expanded / sheet 在不在
 *   ② 「液态玻璃：白块不许露到蓝框外面」          → 逐帧量外露，并把每帧的 ring/spans 几何打出来
 *
 * 用法：node scripts/_diag-f5.mjs            （默认各跑 5 遍）
 *       node scripts/_diag-f5.mjs 3          （各跑 3 遍）
 */
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'
import { launchBrowser } from './lib/edge-path.mjs'

registerTsResolve()
const { makeDemoClasses, makeDemoExams } = await import('../src/data/seed.ts')
const BASE = process.env.SHUGAO_BASE || 'http://localhost:5178'
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
const ROUNDS = Number(process.argv[2] ?? 5)
/** `SHUGAO_SLOW=4` → 每个 rAF 里空转 N ms（模拟"机器忙"时那一帧被拖长的情形） */
const SLOW = Number(process.env.SHUGAO_SLOW ?? 0)

/** 第 ① 条用的读数 */
const navState = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="主导航"]')
    const btn = nav.querySelector('button[aria-haspopup="dialog"]')
    const sheet = document.querySelector('.sheet')
    const navCS = getComputedStyle(nav)
    return {
      path: location.pathname,
      opacity: navCS.opacity,
      transition: navCS.transitionProperty + ' ' + navCS.transitionDuration,
      expanded: btn.getAttribute('aria-expanded'),
      btnPE: getComputedStyle(btn).pointerEvents,
      label: btn.getAttribute('aria-label'),
      sheet: sheet ? Math.round(sheet.getBoundingClientRect().top) : null,
      cls: nav.className,
    }
  })

/** 第 ② 条用的逐帧探针（口径与 shots.mjs 的 blobOutsideRing 完全一致，多打几何） */
const blobProbe = (page, n = 70) =>
  page.evaluate(async (N) => {
    const nav = document.querySelector('nav[aria-label="主导航"]')
    const ring = nav.querySelector('[data-hi-ring]')
    const layer = nav.querySelector('[data-jelly]')
    const spans = [...layer.querySelectorAll('span[aria-hidden]')]
    const rows = []
    const detail = []
    for (let i = 0; i < N; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      const rr = ring.getBoundingClientRect()
      const boxes = spans.map((s) => s.getBoundingClientRect())
      const per = boxes.map((b) => Math.max(rr.left - b.left, b.right - rr.right))
      const v = Math.round(Math.max(...per) * 10) / 10
      rows.push(v)
      if (v > 2 || i < 20) {
        detail.push({
          i,
          v,
          per: per.map((x) => Math.round(x * 10) / 10),
          ring: [Math.round(rr.left * 10) / 10, Math.round(rr.right * 10) / 10, Math.round(rr.width * 10) / 10],
          ringM: getComputedStyle(ring).transform,
          fillM: getComputedStyle(spans[0]).transform,
          tailM: spans[1] ? getComputedStyle(spans[1]).transform : null,
          ringTrans: getComputedStyle(ring).transitionProperty + '/' + getComputedStyle(ring).transitionDuration,
          spans: boxes.map((b) => [Math.round(b.left * 10) / 10, Math.round(b.right * 10) / 10]),
        })
      }
    }
    return {
      frames: rows.length,
      worst: Math.max(...rows),
      outside2: rows.filter((v) => v > 2).length,
      outside6: rows.filter((v) => v > 6).length,
      worstIdx: rows.indexOf(Math.max(...rows)),
      all: rows,
      detail,
    }
  }, n)

await withLock(
  async () => {
    const browser = await launchBrowser({ headless: true })
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        const ctx = await browser.newContext({
          viewport: { width: 414, height: 880 },
          deviceScaleFactor: 2,
          locale: 'zh-CN',
        })
        await ctx.clock.install({ time: new Date('2026-09-19T10:00:00') })
        await ctx.addInitScript((s) => {
          window.localStorage.setItem('shugao.teacher.v1', JSON.stringify(s))
          window.localStorage.setItem('shugao.deviceRole', 'teacher')
        }, TEACHER_STATE)
        const page = await ctx.newPage()
        page.on('pageerror', (e) => console.log('   PAGEERROR', e.message))
        if (SLOW > 0) {
          await page.addInitScript((ms) => {
            const raf = window.requestAnimationFrame.bind(window)
            window.requestAnimationFrame = (cb) =>
              raf((t) => {
                const end = performance.now() + ms
                while (performance.now() < end) {
                  /* 空转：让这一帧真的变长 */
                }
                cb(t)
              })
          }, SLOW)
        }

        /* ============ ① 展开层：再展开一次 ============ */
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(400)
        await page.getByRole('button', { name: '展开更多入口' }).click()
        await page.waitForTimeout(600)
        await page.locator('.sheet button').filter({ hasText: '日程表' }).first().click()
        await page.waitForURL('**/schedule', { timeout: 8000 })
        await page.waitForTimeout(400)
        const beforeClick = await navState(page)
        await page
          .locator('nav[aria-label="主导航"] button[aria-haspopup="dialog"]')
          .click({ force: true })
        const series = []
        for (const w of [0, 60, 140, 300, 700, 1200]) {
          if (w) await page.waitForTimeout(w === 60 ? 60 : w === 140 ? 140 : w === 300 ? 300 : w === 700 ? 400 : 500)
          series.push([w, await navState(page)])
        }
        const at700 = series.find(([w]) => w === 700)[1]
        /* 700ms 读数是红的时，再等 250ms 读一次：看是不是"同一个状态、只是量早了" */
        let after = null
        if (at700.opacity !== '0') {
          await page.waitForTimeout(250)
          after = await navState(page)
        }
        console.log(
          `\n== 第 ${round} 遍 · ① 展开层 ==\n` +
            `   点之前：${JSON.stringify(beforeClick)}\n` +
            `   点之后逐档：\n` +
            series.map(([w, s]) => `     +${w}ms  ${JSON.stringify(s)}`).join('\n') +
            `\n   ⇒ 700ms 判据 opacity==='0' ? ${at700.opacity === '0' ? '过' : '**红**'}` +
            (after ? `\n   ⇒ 再等 250ms 复读：${JSON.stringify(after)}` : ''),
        )

        /* ============ ② 白块 vs 蓝框 ============ */
        await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(900)
        const tab = await page.getByRole('link', { name: '作业' }).boundingBox()
        const poll = blobProbe(page)
        await page.mouse.click(tab.x + tab.width / 2, tab.y + tab.height / 2)
        const blob = await poll
        await page.waitForTimeout(900)
        console.log(
          `\n== 第 ${round} 遍 · ② 白块露框 ==\n` +
            `   worst=${blob.worst}px（第 ${blob.worstIdx} 帧） · >2px ${blob.outside2}/${blob.frames} · >6px ${blob.outside6}\n` +
            `   曲线：${blob.all.join(',')}`,
        )
        for (const d of blob.detail) console.log(`     frame ${JSON.stringify(d)}`)

        await ctx.close()
      }
    } finally {
      await browser.close()
    }
  },
  { script: '_diag-f5.mjs' },
)
