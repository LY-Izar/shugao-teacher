/** 一次性：校徽 150 档 + 英文 52px 的实际渲染（DPR 1 / 2），跑完即删。 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser } from './lib/edge-path.mjs'

const OUT = String.raw`C:\Users\Administrator\Desktop\树高教师平台\app\.tmp-emblem`
mkdirSync(OUT, { recursive: true })
const browser = await launchBrowser({ headless: true })
const out = []
for (const dpr of [1, 2]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
  const page = await ctx.newPage()
  const res = []
  const failed = []
  const errs = []
  page.on('response', (r) => { if (/emblem-/.test(r.url())) res.push(`${r.status()} ${r.url().split('/').pop()}`) })
  page.on('requestfailed', (r) => failed.push(r.url().slice(-44)))
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)))
  await page.goto('http://localhost:5178/?boot=1', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3300)
  const s = await page.evaluate(() => {
    const emblem = document.querySelector('.splash__emblem')
    const img = emblem?.querySelector('img')
    const er = emblem?.getBoundingClientRect()
    const scaleOf = (sel) => {
      const svg = document.querySelector(sel)
      if (!svg) return null
      const vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number)
      const r = svg.getBoundingClientRect()
      return {
        box: [Math.round(r.width), Math.round(r.height)],
        vb: [Math.round(vb[2]), Math.round(vb[3])],
        scale: Number((r.width / vb[2]).toFixed(3)),
      }
    }
    const en = scaleOf('.splash__sub svg')
    const cn = scaleOf('.splash__title svg')
    const txt = document.querySelector('.splash__sub .stroke-text__fill')
    return {
      emblemN: emblem?.getAttribute('data-emblem'),
      emblemBox: er ? [Math.round(er.width), Math.round(er.height)] : null,
      emblemSrc: img?.currentSrc?.split('/').pop(),
      cn,
      en,
      enTextRect: txt
        ? [Math.round(txt.getBoundingClientRect().width), Math.round(txt.getBoundingClientRect().height)]
        : null,
      effectiveEnPx: en ? Number((52 * en.scale).toFixed(1)) : null,
      innerH: Math.round(document.querySelector('.splash__inner')?.getBoundingClientRect().height ?? 0),
    }
  })
  await page.screenshot({ path: join(OUT, `dpr${dpr}.png`) })
  out.push({ dpr, s, res, failed, errs })
  await ctx.close()
}
console.log(JSON.stringify(out))
await browser.close()
