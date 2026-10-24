/**
 * 每日作业插件（P2 首批搬运：清单 7）
 *
 * 搬自旧教室端 `Classroom.tsx` 的「每日作业」块：
 *   · 数据源 = 宿主资源 `class.dailyHomework`（今天的条目，按学科分组）。分组顺序照宿主
 *     `lib/subjects.ts` 那张字典（语文数学英语…），这里照抄一份 code→序号表，不由插入顺序决定；
 *   · 话术照旧页：组头「学科」+「课代表」标签；空态「今天还没有人留作业。」；
 *   · 日期窗（今天/昨天/前天…）与"共 N 条"照 `friendlyDate` 的写法；
 *   · 「存成图片」照旧页：今天的作业 + 值日生姓名画成一张 800×600 的 PNG
 *     （版式在宿主 `lib/homeworkImage.ts`，这里是逐行副本 —— 插件不许 import 宿主模块）。
 *
 * 2026-10-25 用户拍板把值日生拆成独立插件（`shugao.duty`）：这一块屏上不再显示
 * 值日那一行，只在出图时读一次 `class.duty` 给图片页脚用。
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

/* ============================================================
   作业图片（搬自 `src/lib/homeworkImage.ts`，版式与颜色照那份壁纸工具）
   ------------------------------------------------------------
   🔴 宿主那份是 TS 且插件不许 import 宿主模块（手册 §11.3），所以这里是一份逐行副本。
      两份**同轮维护**：改版式的时候两处一起改，别以为那边跟着变了。
   ============================================================ */
const IMG = {
  W: 800,
  H: 600,
  /** 与那份壁纸工具同一对颜色（`FromArgb(130,29,190)` → `FromArgb(164,138,186)`） */
  FROM: [130, 29, 190],
  TO: [164, 138, 186],
  /** 版心：左边留 1/3 白，正文从 x=270 起（照那张图的观感） */
  X: 270,
  LINE_H: 40,
  FONT: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
}

/** 学科短名（搬自 `src/lib/subjects.ts` 的 `short` 列；单文件插件不许 import 宿主模块） */
const SUBJECT_SHORT = {
  chinese: '语',
  math: '数',
  english: '英',
  physics: '物',
  chemistry: '化',
  biology: '生',
  politics: '政',
  history: '史',
  geography: '地',
  it: '信',
  general_tech: '通',
  pe: '体',
  music: '音',
  art: '美',
  mental_health: '心',
}

/** 日期画成 `M.d`（与那份壁纸工具的 `"        M.d"` 同一个口径） */
const imgTitleOf = (iso) => {
  const [, m, d] = String(iso).split('-')
  if (!m || !d) return String(iso)
  return `${Number(m)}.${Number(d)}`
}

/** 一科一行：`语：第一条；第二条` */
const imgLinesOf = (rows) => {
  const bySubject = new Map()
  for (const r of rows) {
    const label = SUBJECT_SHORT[r.subjectCode] || r.subject || '其他'
    const list = bySubject.get(label) ?? []
    list.push(r.content)
    bySubject.set(label, list)
  }
  return [...bySubject.entries()].map(([label, list]) => `${label}：${list.join('；')}`)
}

/** 按宽度折行（中文没有词边界，逐字量最稳） */
const imgWrap = (c2d, text, maxWidth) => {
  const out = []
  let cur = ''
  for (const ch of text) {
    if (c2d.measureText(cur + ch).width > maxWidth && cur) {
      out.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 画一张 800×600：紫到紫灰渐变、左上日期、一科一行、右下角值日生与班名 */
function drawHomeworkImage(className, onDate, rows, duty) {
  const cv = globalThis.document.createElement('canvas')
  cv.width = IMG.W
  cv.height = IMG.H
  const c2d = cv.getContext('2d')
  if (!c2d) return cv

  const g = c2d.createLinearGradient(0, 0, IMG.W, IMG.H)
  g.addColorStop(0, `rgb(${IMG.FROM[0]}, ${IMG.FROM[1]}, ${IMG.FROM[2]})`)
  g.addColorStop(1, `rgb(${IMG.TO[0]}, ${IMG.TO[1]}, ${IMG.TO[2]})`)
  c2d.fillStyle = g
  c2d.fillRect(0, 0, IMG.W, IMG.H)

  c2d.textBaseline = 'top'
  c2d.fillStyle = 'rgb(255 255 255)'
  c2d.font = `700 36px ${IMG.FONT}`
  c2d.fillText(imgTitleOf(onDate), IMG.X, 46)

  c2d.font = `400 22px ${IMG.FONT}`
  let y = 116
  const lines = imgLinesOf(rows)
  const pad = IMG.W - IMG.X - 30
  if (!lines.length) {
    c2d.fillStyle = 'rgb(255 255 255 / .75)'
    c2d.fillText('今天还没有人留作业', IMG.X, y)
  } else {
    for (const line of lines) {
      for (const part of imgWrap(c2d, line, pad)) {
        c2d.fillText(part, IMG.X, y)
        y += IMG.LINE_H
      }
      y += 6
    }
  }

  c2d.font = `500 17px ${IMG.FONT}`
  c2d.fillStyle = 'rgb(255 255 255 / .82)'
  c2d.textAlign = 'right'
  if (duty) c2d.fillText(`今天的值日生 · ${duty}`, IMG.W - 30, IMG.H - 66)
  c2d.font = `500 15px ${IMG.FONT}`
  c2d.fillStyle = 'rgb(255 255 255 / .62)'
  c2d.fillText(className, IMG.W - 30, IMG.H - 40)
  c2d.textAlign = 'left'
  return cv
}

/** 画好 → 交给浏览器下载（教室端那块屏上点的，不写本机文件夹） */
const saveImage = async (className, onDate, rows, duty) => {
  const cv = drawHomeworkImage(className, onDate, rows, duty)
  const blob = await new Promise((resolve) => {
    try {
      cv.toBlob((b) => resolve(b), 'image/png')
    } catch {
      resolve(null)
    }
  })
  if (!blob) return false
  const url = URL.createObjectURL(blob)
  const a = globalThis.document.createElement('a')
  a.href = url
  a.download = `${className}-每日作业-${onDate}.png`
  globalThis.document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
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
  const sink = {
    style: {},
    textContent: '',
    append() {},
    setAttribute() {},
    addEventListener() {},
  }
  const anyEl = () => ({ ...sink, style: {}, append(...xs) { void xs } })
  return { el: anyEl, wrap: { ...sink, append() {} }, body: { innerHTML: '', append() {} } }
}

const friendlyDate = (iso) => {
  const d = new Date(`${iso}T12:00:00+08:00`)
  const now = new Date()
  const dayMs = 86400000
  const diff = Math.round((new Date(`${iso}T00:00:00+08:00`).getTime() - new Date(`${now.toISOString().slice(0, 10)}T00:00:00+08:00`).getTime()) / dayMs)
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === -2) return '前天'
  const wd = '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${wd}`
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
    const count = mk('span', 'flex:1;text-align:right;font-size:11.5px', '')
    head.append(title, count)

    const body = mk('div', 'margin-top:10px;display:flex;flex-direction:column;gap:12px')
    const empty = mk('div', 'font-size:13px;color:var(--color-ink3);line-height:1.8;display:none',
      '今天还没有人留作业。')
    const notice = mk('div', 'font-size:12px;color:var(--color-warn);line-height:1.7;display:none')

    /* 存成图片：与旧页同一个动作、同一句话术 */
    const imageRow = mk('div', 'margin-top:14px;display:flex;align-items:center;gap:10px')
    const imageBtn = mk('button', '', '存成图片')
    imageBtn.style.cssText =
      'height:34px;padding:0 14px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;' +
      'border-radius:var(--radius-sm);border:1px solid var(--color-line2);' +
      'background:var(--color-surface);color:var(--color-ink2)'
    const imageNote = mk('span', 'font-size:13px;color:var(--color-ink3)')
    imageRow.append(imageBtn, imageNote)

    wrap.append(head, body, empty, notice, imageRow)
    ctx.ui.container.append(wrap)

    /* 出图要用今天这一份：paint 时留一份给按钮，别在点击时再读一遍数据 */
    let todayIso = ''
    let todayRows = []
    let dutyName = null

    const paint = async () => {
      const today = new Date(ctx.now())
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      const [hw, dutyData] = await Promise.all([
        ctx.data.read('class.dailyHomework'),
        /* 值日生只给图片页脚用（屏上那一行由 `shugao.duty` 负责） */
        ctx.data.read('class.duty'),
      ])
      const rows = (hw.rows ?? []).filter((h) => h.onDate === iso)
      count.textContent = `${friendlyDate(iso)}${rows.length ? ` · 共 ${rows.length} 条` : ''}`
      todayIso = iso
      todayRows = rows
      dutyName = dutyData.today ? dutyData.today.name : null

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

    imageBtn.addEventListener('click', async () => {
      imageNote.textContent = ''
      const ok = await saveImage(ctx.class.name, todayIso, todayRows, dutyName)
      imageNote.textContent = ok
        ? '作业图片已生成，去浏览器的下载里拿'
        : '这张图没画出来'
    })

    await paint()
    ctx.onDispose(ctx.data.watch('class.dailyHomework', () => void paint()))
    if (ctx.clock) {
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {},
}
