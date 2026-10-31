/**
 * 宿主**内置插件**（P0b 起步是演示插件，P2 起正式插件在真下载落地前也走这里）。
 *
 * 它与 `scripts/fixtures/demo.helloclock/`（契约自检 CF-01…CF-14 的夹具）是**同一份
 * 契约的两个载体**：夹具在纯 Node 里钉"宿主核心判得对不对"，这一份在真浏览器里钉
 * "加载器接线接得对不对"（容器、能力注入、storage 假槽、时钟、pip 降级）。
 * 🔴 两份的 manifest 字段保持一致 —— 改一份要想着另一份（它们各自被两道门禁盯）。
 *
 * ⚠️ 走 `import()` 的真下载要等壳侧的 `downloadPlugin`（`classroomShell.ts` 顶部那四条
 *    约定）；在那之前，正式插件（P2 首批）与本演示插件一样以内置副本进教室端，
 *    三件套照常放在 `app/plugins/<id>/` 供契约自检与发布。
 */

import type { PluginManifest } from '../lib/pluginHost'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ReviewBlock, ScheduleBlock, type ReviewCtx, type ScheduleCtx } from './blocks/pluginViews'
import { downloadBlob, homeworkImageBlob, homeworkImageName } from '../lib/homeworkImage'
import type { DailyHomework } from '../data/types'

export interface AvailablePlugin {
  /** 插件目录名（= manifest.id，校验就是查这两个相等）。 */
  dirName: string
  manifest: PluginManifest
  module: {
    activate?: (ctx: Record<string, unknown>) => unknown
    deactivate?: () => unknown
  }
  /** P0b 只有内置演示这一种来源；真下载（壳侧 `downloadPlugin`）进来后加 `'downloaded'`。 */
  source: 'bundled' | 'downloaded'
  /** Git commit；更换版本时让运行中的窗口卸载旧模块并启动新模块。 */
  revision?: string
}

export const DEMO_MANIFEST: PluginManifest = {
  id: 'demo.helloclock',
  name: '示例时钟',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  description: '显示当前这节课与下一节',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.schedule', 'clock', 'storage', 'config', 'pip'],
  window: { w: 3, h: 2 },
  config: {
    fields: [{ key: 'showNext', type: 'switch', label: '显示下一节', default: true }],
  },
}

/** 与夹具 `index.js` 同一份行为（注释也同源 —— 它为什么这么写，看夹具里那三条）。 */
const makeEl = () => {
  const el = document.createElement('div')
  el.setAttribute('data-cps-plugin-slot', '')
  el.style.cssText =
    'padding:16px;font:600 42px/1.3 system-ui;color:var(--color-ink);' +
    "fontVariantNumeric:'tabular-nums';height:100%;box-sizing:border-box;" +
    'display:flex;flex-direction:column;justify-content:center;text-align:center'
  return el
}

type DemoCtx = {
  ui: { container: HTMLElement }
  data: {
    read(resource: string): Promise<{ current?: { subject: string; end: string } | null; next?: { subject: string } | null; stale?: boolean }>
    watch(resource: string, cb: () => void): () => void
  }
  storage: { set(key: string, value: unknown): Promise<void> }
  config: {
    get(): Record<string, unknown>
    onChange(cb: (next: Record<string, unknown>) => void): () => void
  }
  clock?: { onMinute(cb: () => void): () => void }
  pip?: { open(opts: Record<string, unknown>): Promise<boolean> }
  now(): Date
  onDispose(fn: () => void): void
}

const demoModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as DemoCtx
    const el = makeEl()
    ctx.ui.container.append(el)

    const paint = async () => {
      const { current, next, stale } = await ctx.data.read('class.slotNow')
      /* `!== false`：还没有这份配置时按默认值（true）走 —— 空值不是"关" */
      const showNext = ctx.config.get().showNext !== false
      const line = current
        ? `${current.subject} 到 ${current.end}`
        : next && showNext
          ? `下一节 ${next.subject}`
          : '今天没课'
      el.textContent = stale ? `${line}（离线）` : line
      /* 存一次就够了：高频状态留在内存里，别每帧写库（手册 §7.3） */
      await ctx.storage.set('last_paint', ctx.now().toISOString())
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.slotNow', () => void paint()))
    if (ctx.clock) ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    /* 教师改完配置（P1 的配置通道）→ 重画一次：这就是"配置实时跟随"的插件那一半。
       与 `scripts/fixtures/demo.helloclock/index.js`（契约自检的夹具）**逐行为同源**。 */
    ctx.onDispose(ctx.config.onChange(() => void paint()))

    /* 悬浮窗：拿不到能力、或壳里没开成，都必须**说人话**（手册 §9，CF-13）。
       网页预览下 `ctx.pip` 根本不存在（§9 的表），这一支自然不进去 —— 那是正确行为。 */
    if (ctx.pip) {
      const ok = await ctx.pip.open({ w: 360, h: 220, opacity: 1 })
      if (!ok) el.textContent = '要在教室版程序里才能弹小窗'
    }
  },

  async deactivate() {
    /* 宿主会拆容器、注销 onDispose 登记的订阅；这里只做自己那份 */
  },
}

export const DEMO_PLUGIN: AvailablePlugin = {
  dirName: DEMO_MANIFEST.id,
  manifest: DEMO_MANIFEST,
  module: demoModule,
  source: 'bundled',
}

/* ============================================================================
   P2 首批搬运 ①：祝福语（shugao.quote）
   ----------------------------------------------------------------------------
   真下载（壳侧 `downloadPlugin`）落地之前，教室端要能跑的插件只能**内置** ——
   与演示插件同一个"双载体"约定：`app/plugins/shugao.quote/` 三件套是给契约自检
   与发布用的那份，这里的 TS 副本与之**逐行为同源**（改一处想着另一处）。
   出现条件与真插件完全一致：教师启用（plugin_configs.enabled）＋登记表放行；
   `?demoPlugin=1` 的演示直通对它同样生效（手册 §12 的演示地址）。
   ============================================================================ */

export const QUOTE_MANIFEST: PluginManifest = {
  id: 'shugao.quote',
  name: '每日祝福语',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l2.3 5 5.4.6-4 3.7 1.1 5.3L12 14.9l-4.8 2.7 1.1-5.3-4-3.7 5.4-.6z"/></svg>',
  description: '教室大屏上给学生看的那一句，按日期轮换，同一天固定',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.quote', 'clock'],
  window: { w: 4, h: 2, min: { w: 2, h: 1 } },
}

type QuoteCtx = {
  ui: { container: HTMLElement }
  data: {
    read(resource: string): Promise<{ text?: string; from?: string; stale?: boolean }>
    watch(resource: string, cb: () => void): () => void
  }
  clock?: { onMinute(cb: () => void): () => void }
  now(): Date
  onDispose(fn: () => void): void
}

const quoteModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as QuoteCtx
    const wrap = document.createElement('div')
    wrap.setAttribute('data-quote-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:16px;display:flex;flex-direction:column;' +
      'justify-content:center;text-align:center;font-family:system-ui'
    const text = document.createElement('div')
    text.style.cssText =
      'font-weight:620;font-size:clamp(19px, 1.7vw, 27px);line-height:1.55;' +
      'letter-spacing:.01em;color:var(--color-ink)'
    const from = document.createElement('div')
    from.style.cssText = 'margin-top:7px;font-size:13px;color:var(--color-ink3)'
    wrap.append(text, from)
    ctx.ui.container.append(wrap)

    const paint = async () => {
      const q = await ctx.data.read('class.quote')
      text.textContent = q.text ?? ''
      from.textContent = q.text ? `—— ${q.from ?? ''}` : ''
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.quote', () => void paint()))
    if (ctx.clock) {
      // 与旧教室端同一口径：每分钟重画一次，0 点翻天的时候句子跟着换
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {},
}

export const QUOTE_PLUGIN: AvailablePlugin = {
  dirName: QUOTE_MANIFEST.id,
  manifest: QUOTE_MANIFEST,
  module: quoteModule,
  source: 'bundled',
}

/* ============================================================================
   P2 首批搬运 ②：每日作业（shugao.daily）—— 与 `app/plugins/shugao.daily/`
   三件套逐行为同源（分组顺序照宿主 subjects 字典、空态与「课代表」标签照旧页话术）。
   2026-10-25 用户拍板把值日生拆出去（`shugao.duty`）：这一块只摆作业，
   只在出图时读一次 `class.duty` 给图片页脚用，屏上不再有值日那一行。
   ============================================================================ */

export const DAILY_MANIFEST: PluginManifest = {
  id: 'shugao.daily',
  name: '每日作业',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  description: '今天各科留的作业，按学科分组',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.dailyHomework', 'data.duty', 'clock'],
  window: { w: 4, h: 4, min: { w: 3, h: 2 } },
}

/* 学科字典的顺序照抄宿主 `lib/subjects.ts`（语文数学英语…）—— 单文件插件里
   无法 import 宿主模块（手册 §11.3），这份顺序副本与三件套里那份同轮维护。 */
const DAILY_SUBJECT_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['chinese', '语文'], ['math', '数学'], ['english', '英语'], ['physics', '物理'],
  ['chemistry', '化学'], ['biology', '生物'], ['politics', '政治'], ['history', '历史'],
  ['geography', '地理'], ['it', '信息技术'], ['general_tech', '通用技术'], ['pe', '体育'],
  ['music', '音乐'], ['art', '美术'], ['mental_health', '心理健康'],
]

type DailyHwRow = { subject: string; subjectCode: string; content: string; onDate: string; source: string }
type DutyData = { today: { no: string; name: string } | null; roster: Array<{ no: string; name: string }> }

type DailyCtx = {
  ui: { container: HTMLElement }
  class: { id: string; name: string }
  data: {
    read(resource: string): Promise<{ rows?: DailyHwRow[]; today?: DutyData['today']; notice?: string; stale?: boolean }>
    watch(resource: string, cb: () => void): () => void
  }
  clock?: { onMinute(cb: () => void): () => void }
  now(): Date
  onDispose(fn: () => void): void
}

function dailyGroupBy(rows: DailyHwRow[]) {
  const order = new Map(DAILY_SUBJECT_ORDER.map(([c], i) => [c, i]))
  const names = new Map(DAILY_SUBJECT_ORDER)
  const groups: Array<{ key: string; label: string; code: string; rep: boolean; items: DailyHwRow[] }> = []
  const byKey = new Map<string, (typeof groups)[number]>()
  for (const h of rows) {
    const code = h.subjectCode || ''
    const key = code || h.subject || '其他'
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: code ? (names.get(code) ?? code) : h.subject || '其他', code, rep: false, items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    if (h.source === 'rep') g.rep = true
    g.items.push(h)
  }
  groups.sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
  return groups
}

const dailyModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as DailyCtx
    const el = (tag: string, css: string, text?: string) => {
      const e = document.createElement(tag)
      if (css) e.style.cssText = css
      if (text !== undefined) e.textContent = text
      return e
    }

    const wrap = el('div', '')
    wrap.setAttribute('data-daily-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:12px 16px;overflow:auto;' +
      'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
      'font-family:system-ui;color:var(--color-ink)'
    const head = el('div', 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--color-ink3)')
    const title = el('span', 'font-weight:700;font-size:14.5px;color:var(--color-ink)', '每日作业')
    const count = el('span', 'flex:1;text-align:right;font-size:11.5px', '')
    head.append(title, count)
    const body = el('div', 'margin-top:10px;display:flex;flex-direction:column;gap:12px')
    const empty = el('div', 'font-size:13px;color:var(--color-ink3);line-height:1.8;display:none', '今天还没有人留作业。')
    const notice = el('div', 'font-size:12px;color:var(--color-warn);line-height:1.7;display:none')
    /* 存成图片：与旧页同一个动作、同一句话术（版式在 `lib/homeworkImage.ts`） */
    const actions = el('div', 'margin-top:14px;display:flex;align-items:center;gap:10px')
    const imgBtn = el('button',
      'height:34px;padding:0 14px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;' +
      'border-radius:var(--radius-sm);border:1px solid var(--color-line2);' +
      'background:var(--color-surface);color:var(--color-ink2)', '存成图片')
    const imgMsg = el('span', 'font-size:13px;color:var(--color-ink3)')
    actions.append(imgBtn, imgMsg)
    wrap.append(head, body, empty, notice, actions)
    ctx.ui.container.append(wrap)

    /* 日期口径：今天 = `ctx.now()`（宿主 beijingNow）的年月日 —— 与旧页 friendlyDate 同判据 */
    const isoOf = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    /* 出图要用今天这一份：paint 时留一份给按钮，别在点击时再读一遍数据 */
    let todayIso = ''
    let todayRows: DailyHwRow[] = []
    let dutyName: string | null = null

    const paint = async () => {
      const iso = isoOf(ctx.now())
      const [hw, dutyData] = await Promise.all([
        ctx.data.read('class.dailyHomework'),
        /* 值日生只给图片页脚用（屏上那一行由 `shugao.duty` 负责） */
        ctx.data.read('class.duty'),
      ])
      const rows = (hw.rows ?? []).filter((h) => h.onDate === iso)
      const wd = '日一二三四五六'[ctx.now().getDay()]
      count.textContent = `${ctx.now().getMonth() + 1} 月 ${ctx.now().getDate()} 日 · 周${wd}${rows.length ? ` · 共 ${rows.length} 条` : ''}`
      todayIso = iso
      todayRows = rows
      dutyName = dutyData.today ? dutyData.today.name : null

      body.innerHTML = ''
      const groups = dailyGroupBy(rows)
      if (!groups.length) {
        empty.style.display = 'block'
      } else {
        empty.style.display = 'none'
        for (const g of groups) {
          const box = el('div', '')
          box.setAttribute('data-daily-subject', g.code || g.key)
          const gh = el('div', 'display:flex;align-items:center;gap:8px')
          gh.append(el('span', 'font-size:12.5px;font-weight:700', g.label))
          if (g.rep) {
            gh.append(el('span',
              'font-size:10.5px;padding:1px 7px;border-radius:999px;' +
              'border:1px solid var(--color-line2);background:var(--color-surface);color:var(--color-ink2)',
              '课代表'))
          }
          box.append(gh)
          for (const h of g.items) {
            box.append(el('div',
              'font-size:13px;color:var(--color-ink2);line-height:1.75;margin-top:2px;word-break:break-word',
              h.content))
          }
          body.append(box)
        }
      }
      notice.textContent = hw.notice || ''
      notice.style.display = hw.notice ? 'block' : 'none'
    }

    imgBtn.addEventListener('click', async () => {
      imgMsg.textContent = ''
      const blob = await homeworkImageBlob({
        className: ctx.class.name,
        onDate: todayIso,
        rows: todayRows as unknown as DailyHomework[],
        duty: dutyName,
      })
      if (!blob) {
        imgMsg.textContent = '这张图没画出来'
        return
      }
      downloadBlob(blob, homeworkImageName(ctx.class.name, todayIso))
      imgMsg.textContent = '作业图片已生成，去浏览器的下载里拿'
    })

    await paint()
    ctx.onDispose(ctx.data.watch('class.dailyHomework', () => void paint()))
    if (ctx.clock) {
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {},
}

export const DAILY_PLUGIN: AvailablePlugin = {
  dirName: DAILY_MANIFEST.id,
  manifest: DAILY_MANIFEST,
  module: dailyModule,
  source: 'bundled',
}

/* ============================================================================
   P2 首批搬运 ②b：值日生（shugao.duty）—— 2026-10-25 从「每日作业与值日」拆出，
   与 `app/plugins/shugao.duty/` 三件套逐行为同源。
   轮换规则（按学号轮流、周末与放假跳过）在宿主 `lib/duty.ts` 里算，资源直接给
   `today`；插件只负责把"今天轮到谁"摆上屏，不抄第二份判据。
   ============================================================================ */

export const DUTY_MANIFEST: PluginManifest = {
  id: 'shugao.duty',
  name: '值日生',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3.2"/><path d="M5 21c0-4 3.1-6.5 7-6.5s7 2.5 7 6.5"/></svg>',
  description: '今天轮到谁值日',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.duty', 'clock'],
  window: { w: 3, h: 2, min: { w: 2, h: 1 } },
}

type DutyCtx = {
  ui: { container: HTMLElement }
  data: {
    read(resource: string): Promise<{ today?: { no: string; name: string } | null; stale?: boolean }>
    watch(resource: string, cb: () => void): () => void
  }
  clock?: { onMinute(cb: () => void): () => void }
  now(): Date
  onDispose(fn: () => void): void
}

const dutyModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as DutyCtx
    const el = (tag: string, css: string, text?: string) => {
      const e = document.createElement(tag)
      if (css) e.style.cssText = css
      if (text !== undefined) e.textContent = text
      return e
    }

    const wrap = el('div', '')
    wrap.setAttribute('data-duty-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:16px;' +
      'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
      'text-align:center;font-family:system-ui;color:var(--color-ink)'
    const label = el('div', 'font-size:13px;color:var(--color-ink3)', '今天值日生')
    const who = el('div', 'margin-top:4px;font-size:46px;font-weight:700;line-height:1.2;word-break:break-word')
    const empty = el('div', 'font-size:15px;color:var(--color-ink3);line-height:1.8;display:none', '今天没有值日生')
    const hint = el('div', 'margin-top:10px;font-size:12px;color:var(--color-ink4)', '按学号轮流，周末与放假跳过')
    wrap.append(label, who, empty, hint)
    ctx.ui.container.append(wrap)

    const paint = async () => {
      const { today } = await ctx.data.read('class.duty')
      const name = today ? today.name : ''
      who.textContent = name
      who.style.display = name ? 'block' : 'none'
      label.style.display = name ? 'block' : 'none'
      empty.style.display = name ? 'none' : 'block'
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.duty', () => void paint()))
    /* 0 点翻天：整分钟重画一次，日期换了名字跟着换（与 `shugao.quote` 同一口径） */
    if (ctx.clock) {
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {},
}

export const DUTY_PLUGIN: AvailablePlugin = {
  dirName: DUTY_MANIFEST.id,
  manifest: DUTY_MANIFEST,
  module: dutyModule,
  source: 'bundled',
}

/* ============================================================================
   P2 首批搬运 ③：本班考试（shugao.exams）—— 与 `app/plugins/shugao.exams/` 同源。
   旧页 0 场时整块不摆；插件模型里块由教师启用，空清单给一句空态（唯一形态差异）。
   ============================================================================ */

export const EXAMS_MANIFEST: PluginManifest = {
  id: 'shugao.exams',
  name: '本班考试',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 3h11l3 3v15H5z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>',
  description: '最近六场考试的日期、学科与批阅状态',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.exams'],
  window: { w: 4, h: 3, min: { w: 3, h: 2 } },
}

type ExamsCtx = {
  ui: { container: HTMLElement }
  data: {
    read(resource: string): Promise<{ rows?: Array<{ examDate: string; subject: string; status: string }> }>
    watch(resource: string, cb: () => void): () => void
  }
  now(): Date
  onDispose(fn: () => void): void
}

const examsModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as ExamsCtx
    const el = (css: string, text?: string) => {
      const e = document.createElement('div')
      if (css) e.style.cssText = css
      if (text !== undefined) e.textContent = text
      return e
    }

    const wrap = el('')
    wrap.setAttribute('data-exams-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:12px 16px;overflow:auto;' +
      'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
      'font-family:system-ui;color:var(--color-ink)'
    const head = el('display:flex;align-items:center;gap:8px')
    const headTitle = el('font-weight:700;font-size:14.5px;color:var(--color-ink)', '本班考试')
    const count = el('flex:1;text-align:right;font-size:11.5px;color:var(--color-ink3)', '')
    head.append(headTitle, count)
    const list = el('margin-top:8px')
    const empty = el('font-size:13px;color:var(--color-ink3);line-height:1.8;display:none', '最近没有排考试。')
    wrap.append(head, list, empty)
    ctx.ui.container.append(wrap)

    const paint = async () => {
      const { rows } = await ctx.data.read('class.exams')
      count.textContent = rows?.length ? `共 ${rows.length} 场` : ''
      list.innerHTML = ''
      if (!rows?.length) {
        empty.style.display = 'block'
        return
      }
      empty.style.display = 'none'
      for (const e of rows) {
        const row = el('display:flex;align-items:center;gap:8px;padding:6px 0')
        const date = el(
          "flex:none;width:48px;font-size:12.5px;color:var(--color-ink2);fontVariantNumeric:'tabular-nums'",
          String(e.examDate ?? '').slice(5).replace('-', '/'))
        const subject = el(
          'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:550',
          e.subject ?? '')
        const tag = el(
          'flex:none;font-size:10.5px;padding:1px 7px;border-radius:999px;' +
          (e.status === 'graded'
            ? 'border:1px solid var(--color-line2);background:var(--color-surface);color:var(--color-ink2)'
            : 'border:1px solid var(--color-accent);background:var(--color-accentsoft);color:var(--color-accentink)'),
          e.status === 'graded' ? '已定稿' : '批阅中')
        row.append(date, subject, tag)
        list.append(row)
      }
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.exams', () => void paint()))
  },

  async deactivate() {},
}

export const EXAMS_PLUGIN: AvailablePlugin = {
  dirName: EXAMS_MANIFEST.id,
  manifest: EXAMS_MANIFEST,
  module: examsModule,
  source: 'bundled',
}

/* ============================================================================
   P2 收尾 ①：作业讲评（shugao.review）
   ----------------------------------------------------------------------------
   与 `app/plugins/shugao.review/` 三件套**逐行为同源**：同一份只读资源
   （`class.gradedHomework` / `class.roster`）、同一套话术、同一条「点一行切题」、
   同一个置顶小窗降级口径。
   差别只在渲染层：内置副本直接复用旧页那个**真组件**（`components/PipPanel.tsx`，
   视图在 `blocks/pluginViews.tsx`），三件套里是等价的单文件原生 DOM 回填
   （插件不许 import 宿主模块，手册 §11.3）。
   ⚠️ 2026-10-25：「存成图片」挪去每日作业后，讲评不再读 `class.dailyHomework` /
   `class.duty`，但两份 manifest 里那两项权限还留着（三件套的 manifest 这一轮不在改动范围，
   demoPlugin 这份就跟着不动）—— 下次碰 manifest 时两处一起收。
   ============================================================================ */

export const REVIEW_MANIFEST: PluginManifest = {
  id: 'shugao.review',
  name: '作业讲评',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9h5M7 13h3"/><path d="M15 13l2 2 3-4"/><path d="M9 21h6"/></svg>',
  description: '已批改作业的逐题正确率，点一行切题，可推成置顶小窗',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.gradedHomework', 'data.roster', 'pip'],
  window: { w: 5, h: 4, min: { w: 3, h: 2 } },
}

const reviewModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as {
      ui: { container: HTMLElement }
      onDispose(fn: () => void): void
    }
    const host = document.createElement('div')
    host.setAttribute('data-review-slot', '')
    host.style.cssText = 'height:100%;box-sizing:border-box'
    ctx.ui.container.append(host)
    const root = createRoot(host)
    ctx.onDispose(() => {
      root.unmount()
      host.remove()
    })
    root.render(createElement(ReviewBlock, { ctx: rawCtx as unknown as ReviewCtx }))
  },

  async deactivate() {
    /* 宿主会拆容器与 onDispose 登记的卸载；这里只做自己那份 */
  },
}

export const REVIEW_PLUGIN: AvailablePlugin = {
  dirName: REVIEW_MANIFEST.id,
  manifest: REVIEW_MANIFEST,
  module: reviewModule,
  source: 'bundled',
}

/* ============================================================================
   P2 收尾 ②：班级课表（shugao.schedule）—— 与 `app/plugins/shugao.schedule/`
   三件套**逐行为同源**。
   🔴 2026-10-24 用户拍板（第二次改口）：**课表不由教室端录入** —— 录入在教师端
   「班级管理 → 本班课表」（早就有了），教室屏只负责**显示**。所以它只读：清单里
   没有 `write`、没有 `writes`，`version` 1.0.0 → **1.1.0**（行为从"录入"改成"只读显示"）。
   ============================================================================ */

export const SCHEDULE_MANIFEST: PluginManifest = {
  id: 'shugao.schedule',
  name: '班级课表',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/><path d="M7 13h4M7 17h7"/></svg>',
  description: '在教室屏上显示本班今天有哪些课，标出正在上的那一节',
  version: '1.1.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.schedule', 'clock'],
  window: { w: 4, h: 3, min: { w: 3, h: 2 } },
}

const scheduleModule = {
  async activate(rawCtx: Record<string, unknown>) {
    const ctx = rawCtx as unknown as {
      ui: { container: HTMLElement }
      onDispose(fn: () => void): void
    }
    const host = document.createElement('div')
    host.setAttribute('data-schedule-slot', '')
    host.style.cssText = 'height:100%;box-sizing:border-box'
    ctx.ui.container.append(host)
    const root = createRoot(host)
    ctx.onDispose(() => {
      root.unmount()
      host.remove()
    })
    root.render(createElement(ScheduleBlock, { ctx: rawCtx as unknown as ScheduleCtx }))
  },

  async deactivate() {
    /* 宿主会拆容器与 onDispose 登记的卸载；这里只做自己那份 */
  },
}

export const SCHEDULE_PLUGIN: AvailablePlugin = {
  dirName: SCHEDULE_MANIFEST.id,
  manifest: SCHEDULE_MANIFEST,
  module: scheduleModule,
  source: 'bundled',
}

/**
 * 教师端**本地演示模式**的插件卡清单（线上模式读 `plugin_registry`，不经这里）。
 * P2 搬一个加一个：新插件的三件套 + 这里的 manifest 同轮落。
 */
export const BUNDLED_MANIFESTS: PluginManifest[] = [
  DEMO_MANIFEST,
  QUOTE_MANIFEST,
  DAILY_MANIFEST,
  DUTY_MANIFEST,
  EXAMS_MANIFEST,
  REVIEW_MANIFEST,
  SCHEDULE_MANIFEST,
]

/**
 * 教室端可加载的内置插件清单：**全部在列**，挂不挂由壳的 catalog 闸决定
 * （教师启用 + 登记表放行；`?demoPlugin=1` 是演示直通，对清单里每一个都生效）。
 * 🔴 不能只带演示插件：否则教师在班级详情里启用"示例时钟"、屏上却永远不出现 ——
 *    那张启用开关就成了骗子（P2 祝福语进场时当场纠正）。
 * P2 搬一个加一个：三件套 + 这里的清单同轮落。
 */
export function availablePlugins(): AvailablePlugin[] {
  return [DEMO_PLUGIN, QUOTE_PLUGIN, DAILY_PLUGIN, DUTY_PLUGIN, EXAMS_PLUGIN, REVIEW_PLUGIN, SCHEDULE_PLUGIN]
}
