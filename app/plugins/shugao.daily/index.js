/**
 * 每日作业与值日插件（P2 首批搬运的第二、三件合一：清单 7）
 *
 * 搬自旧教室端 `Classroom.tsx` 的「每日作业」块与值日生行：
 *   · 数据源 = 宿主资源 `class.dailyHomework`（今天的条目，按学科分组）与
 *     `class.duty`（今天值日生）、`class.todaySchedule`（与主屏同口径的今日课表）。
 *     分组顺序照宿主 `lib/subjects.ts` 那张字典
 *     （语文数学英语…），这里照抄一份 code→序号表，不由插入顺序决定；
 *   · 话术照旧页：组头「学科」+「课代表」标签；空态「今天还没有人留作业。」；
 *   · 日期窗（今天/昨天/前天…）与"共 N 条"照 `friendlyDate` 的写法；
 *   · 值日生一行放头部（旧页在时钟下方，插件模型里它是本块的一条信息行）。
 *
 * 刻意的写法（与宿主夹具同源）：顶层零副作用；不 import 裸模块；无 DOM 时退化。
 */

/* 学科字典的顺序照抄宿主 `lib/subjects.ts`（语文数学英语…）—— 排序判据只有一处，
   这里是它在这份单文件里的固化副本；宿主改字典要连着这里改（发布新版本）。 */
const SUBJECT_ORDER = [
  'chinese', 'math', 'english', 'physics', 'chemistry', 'biology', 'politics',
  'history', 'geography', 'it', 'general_tech', 'pe', 'music', 'art', 'mental_health',
]
const SUBJECT_NAME = {
  chinese: '语文', math: '数学', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', politics: '政治', history: '历史', geography: '地理', it: '信息技术',
  general_tech: '通用技术', pe: '体育', music: '音乐', art: '美术', mental_health: '心理健康',
}

const el = (tag, css, text) => {
  const e = document.createElement(tag)
  if (css) e.style.cssText = css
  if (text !== undefined) e.textContent = text
  return e
}

/* 纯 Node（契约自检）里没有 document —— 与夹具同一条纪律：不为门禁写两套逻辑，
   paint 里所有取值都落在普通对象上，append 什么都不做。 */
const noDom = () => {
  const sink = { style: {}, textContent: '', append() {}, setAttribute() {} }
  const anyEl = () => ({ ...sink, style: {}, append(...xs) { void xs } })
  return { el: anyEl, wrap: { ...sink, append() {} }, body: { innerHTML: '', append() {} } }
}

const groupBy = (rows) => {
  const order = new Map(SUBJECT_ORDER.map((c, i) => [c, i]))
  const groups = []
  const byKey = new Map()
  for (const h of rows) {
    const code = h.subjectCode || ''
    const key = code || h.subject || '其他'
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: code ? SUBJECT_NAME[code] : (h.subject || '其他'), code, rep: false, items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    if (h.source === 'rep') g.rep = true
    g.items.push(h)
  }
  groups.sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
  return groups
}

export default {
  async activate(ctx) {
    /* 无 DOM（纯 Node 门禁）：建一份假骨架，让整条 activate 逻辑照跑（数据读取、
       分组、判空都真跑），只是不落 DOM —— 门禁盯的正是"逻辑不因环境分叉"。 */
    const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function'
    const wrap = hasDom
      ? document.createElement('div')
      : noDom().wrap
    wrap.setAttribute('data-daily-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:12px 16px;overflow:auto;' +
      'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
      'font-family:system-ui;color:var(--color-ink)'
    const mk = hasDom ? el : (() => { const d = noDom(); return d.el })()
    const head = mk('div', 'display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--color-ink3)')
    const title = mk('span', 'font-weight:700;font-size:14.5px;color:var(--color-ink)', '每日作业')
    const duty = mk('span', '')
    const count = mk('span', 'flex:1;text-align:right;font-size:11.5px', '')
    head.append(title, duty, count)

    const schedule = mk('div',
      'margin-top:12px;padding:10px 12px;border:1px solid var(--color-line2);' +
      'border-radius:6px;background:var(--color-surface)')
    const scheduleTitle = mk('div', 'font-size:12.5px;font-weight:700;color:var(--color-ink)')
    const scheduleBody = mk('div', 'margin-top:7px;display:flex;flex-direction:column;gap:5px')
    schedule.append(scheduleTitle, scheduleBody)
    const body = mk('div', 'margin-top:12px;display:flex;flex-direction:column;gap:12px')
    const empty = mk('div', 'font-size:13px;color:var(--color-ink3);line-height:1.8;display:none',
      '今天还没有人留作业。')
    const notice = mk('div', 'font-size:12px;color:var(--color-warn);line-height:1.7;display:none')
    wrap.append(head, schedule, body, empty, notice)
    ctx.ui.container.append(wrap)

    let paintToken = 0
    const paint = async () => {
      const token = ++paintToken
      const today = new Date(ctx.now())
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const [hw, dutyData, timetable] = await Promise.all([
        ctx.data.read('class.dailyHomework'),
        ctx.data.read('class.duty'),
        ctx.data.read('class.todaySchedule'),
      ])
      if (token !== paintToken) return
      const rows = (hw.rows ?? []).filter((h) => h.onDate === iso)
      count.textContent = `${today.getMonth() + 1} 月 ${today.getDate()} 日 · 周${'日一二三四五六'[today.getDay()]}${rows.length ? ` · 共 ${rows.length} 条` : ''}`

      const t = dutyData.today
      duty.textContent = t ? `今天值日生 · ${t.name}` : ''
      duty.style.cssText = t
        ? 'font-size:13px;color:var(--color-ink3)'
        : 'display:none'

      scheduleTitle.textContent = `今日课表 · ${'一二三四五六日'[(timetable.weekday || 1) - 1]}`
      scheduleBody.innerHTML = ''
      if (timetable.restDay) {
        scheduleBody.append(mk('div', 'font-size:12px;color:var(--color-ink3)',
          timetable.restName ? `今天放假 · ${timetable.restName}` : '今天放假'))
      } else if (!timetable.items?.length) {
        scheduleBody.append(mk('div', 'font-size:12px;color:var(--color-ink3)', '今天没有排课'))
      } else {
        for (const it of timetable.items) {
          const row = mk('div', 'display:flex;align-items:center;gap:8px;font-size:12px;line-height:1.5')
          row.append(mk('span', 'flex:none;font-variant-numeric:tabular-nums;color:var(--color-ink3)',
            `${it.start}–${it.end}`))
          row.append(mk('span',
            `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${it.current ? 'font-weight:700;color:var(--color-accent)' : 'color:var(--color-ink)'}`,
            it.subject))
          if (it.current) row.append(mk('span', 'color:var(--color-accent);flex:none', '上课中'))
          else if (it.next) row.append(mk('span', 'color:var(--color-accent);flex:none', '下一节'))
          if (it.adjusted) row.append(mk('span', 'color:var(--color-warn);flex:none', '已调整'))
          scheduleBody.append(row)
        }
      }
      for (const conflict of timetable.conflicts ?? []) {
        scheduleBody.append(mk('div', 'font-size:11px;color:var(--color-warn);line-height:1.4', `⚠ ${conflict}`))
      }

      body.innerHTML = ''
      const groups = groupBy(rows)
      if (!groups.length) {
        empty.style.display = 'block'
      } else {
        empty.style.display = 'none'
        for (const g of groups) {
          const box = mk('div', '')
          box.setAttribute('data-daily-subject', g.code || g.key)
          const gh = mk('div', 'display:flex;align-items:center;gap:8px')
          gh.append(mk('span', 'font-size:12.5px;font-weight:700', g.label))
          if (g.rep) {
            const tag = mk('span',
              'font-size:10.5px;padding:1px 7px;border-radius:999px;' +
              'border:1px solid var(--color-line2);background:var(--color-surface);color:var(--color-ink2)',
              '课代表')
            gh.append(tag)
          }
          box.append(gh)
          for (const h of g.items) {
            box.append(mk('div',
              'font-size:13px;color:var(--color-ink2);line-height:1.75;margin-top:2px;word-break:break-word',
              h.content))
          }
          body.append(box)
        }
      }
      notice.textContent = hw.notice || ''
      notice.style.display = hw.notice ? 'block' : 'none'
    }

    await paint()
    let queued = false
    const refresh = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => { queued = false; void paint() })
    }
    ctx.onDispose(ctx.data.watch('class.dailyHomework', refresh))
    ctx.onDispose(ctx.data.watch('class.duty', refresh))
    ctx.onDispose(ctx.data.watch('class.todaySchedule', refresh))
    if (ctx.clock) {
      ctx.onDispose(ctx.clock.onMinute(refresh))
    }
  },

  async deactivate() {},
}
