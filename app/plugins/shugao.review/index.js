/**
 * 作业讲评插件（P2 收尾 ①：旧教室端「作业讲评」块 → 插件）
 *
 * 搬自 `app/src/pages/Classroom.tsx` 的那一串：
 *   已批改列表 → 逐题正确率 → 点行切题 → 当前题目大屏 → 置顶小窗推屏 → 作业图片生成。
 *
 * 判据与话术**一个字没改**（逐条对应写在下面各行）：
 *   · 「已批改」不是 status 判断，是宿主的 `ranked()`（资源 `class.gradedHomework` 已经照它筛好，
 *     理由见 `src/classroom/resources.ts` 那个 case 的注释：极简档案会混进来被画成全班全对）；
 *   · 错误率 = 错的人数 ÷ 应交人数；分档、档名、「N 人错」、「全对」全部来自宿主
 *     `BAND_META`（资源随题递 `bandLabel` / `bandColor`，插件不抄第二张分档表）；
 *   · 题号条 / 当前题 / 名单 / 上一题下一题 —— 与旧页 `components/PipPanel.tsx` 同一套交互；
 *   · 空态两句、置顶小窗的降级话术、存图片的三句提示，逐字照旧页。
 *
 * 与旧页只有一处形态差异（插件模型本身带来的）：它渲染在自己那块功能块窗口里，
 * 老师启用才出现。旧界面那一块**原样留着**（P2 收尾才整块删）。
 *
 * 刻意的写法（与 `shugao.quote` / `shugao.daily` 同源）：
 *  ① 顶层零副作用（CF-04）：模块加载时什么都不做，全部在 activate 里；
 *  ② 不 import 任何裸模块、不碰 window.__shell_out（手册 §11）；
 *  ③ 没有 DOM 时（纯 Node 契约自检）退化成极小的假节点，不为门禁写两套逻辑。
 */

/* ============================================================
   无 DOM 时的小假节点 —— 只够 `scripts/plugin-framework-checks.mjs` 跑完
   （容器 append 得接住、textContent 得读得出、事件不炸）。真浏览器里一律用真节点。
   ============================================================ */
class FakeEl {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this._text = ''
    this._attrs = {}
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v)
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null
  }
  append(...xs) {
    for (const x of xs) {
      if (x && typeof x === 'object') x.parentNode = this
      this.children.push(x)
    }
  }
  appendChild(x) {
    this.append(x)
    return x
  }
  removeChild(x) {
    const i = this.children.indexOf(x)
    if (i >= 0) this.children.splice(i, 1)
    return x
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  addEventListener() {}
  removeEventListener() {}
  get firstChild() {
    return this.children[0] ?? null
  }
  set innerHTML(v) {
    if (v === '') this.children.length = 0
    this._text = ''
  }
  get innerHTML() {
    return ''
  }
  set textContent(v) {
    this._text = String(v)
    this.children.length = 0
  }
  get textContent() {
    let s = this._text
    for (const c of this.children) {
      s += c && typeof c === 'object' ? String(c.textContent ?? '') : String(c ?? '')
    }
    return s
  }
}

const hasDom = () => {
  const d = globalThis.document
  return !!d && typeof d.createElement === 'function'
}

/** 建节点（无 DOM 时给假节点）。`css` 一律写设计令牌，不写十六进制（手册 §8.1）。 */
const mk = (tag, css, text) => {
  const e = hasDom() ? globalThis.document.createElement(tag) : new FakeEl(tag)
  if (css) e.style.cssText = css
  if (text !== undefined) e.textContent = text
  return e
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

/* ============================================================
   插件本体
   ============================================================ */
export default {
  async activate(ctx) {
    const rows = [] /* 已批改的作业（资源 `class.gradedHomework`） */
    let roster = [] /* 本班在读学生：`wrongNos` 是学号，姓名靠它配 */
    let idx = 0
    let seq = 1
    let showList = false
    let pipOn = false

    const nameOf = (no) => {
      const s = roster.find((x) => x.no === no)
      return s ? s.name : ''
    }
    const isoOf = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    /* ---------------- 骨架 ---------------- */
    const root = mk(
      'div',
      'height:100%;box-sizing:border-box;padding:12px 14px;overflow:auto;' +
        'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
        'font-family:system-ui;color:var(--color-ink);display:flex;flex-direction:column;gap:10px',
    )
    root.setAttribute('data-review-slot', '')
    ctx.ui.container.append(root)

    const head = mk('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap')
    const headTitle = mk('span', 'font-weight:700;font-size:17px', '作业讲评')
    const counts = mk('span', 'font-size:15px;color:var(--color-ink3)')
    const pick = mk(
      'select',
      'height:38px;max-width:100%;font-size:15px;font-family:inherit;padding:0 8px;' +
        'border:1px solid var(--color-line2);border-radius:var(--radius-sm);' +
        'background:var(--color-surface);color:var(--color-ink)',
    )
    const headGap = mk('span', 'flex:1')
    const pipBtn = mk('button', '', '启动置顶小窗')
    const stylePipBtn = () => {
      pipBtn.style.cssText =
        'height:38px;padding:0 14px;font-size:15px;font-family:inherit;font-weight:600;cursor:pointer;' +
        'border-radius:var(--radius-sm);border:1px solid ' +
        (pipOn ? 'var(--color-accent)' : 'var(--color-line2)') +
        ';background:' +
        (pipOn ? 'var(--color-accentsoft)' : 'var(--color-surface)') +
        ';color:' +
        (pipOn ? 'var(--color-accentink)' : 'var(--color-ink2)')
    }
    stylePipBtn()
    head.append(headTitle, counts, headGap, pick, pipBtn)

    /* 置顶小窗的状态行（拿不到能力 / 没开成时**必须**说人话，手册 §9） */
    const pipNote = mk(
      'div',
      'display:none;font-size:14px;line-height:1.7;color:var(--color-warn)',
    )

    /* 空态：与旧页逐字相同 */
    const empty = mk('div', 'display:none;padding:6px 0')
    empty.append(
      mk('div', 'font-size:16px;font-weight:620', '本班还没有已批改的作业'),
      mk('div', 'margin-top:4px;font-size:14px;color:var(--color-ink4)', '极简模式的档案没有逐题正确率。'),
    )

    /* 当前题目（旧页「小窗同款面板」：不支持置顶小窗时，这就是兜底） */
    const curPanel = mk(
      'div',
      'display:flex;flex-direction:column;gap:9px;padding:10px 12px;' +
        'border:1px solid var(--color-line2);border-radius:var(--radius-md);background:var(--color-surface)',
    )
    const curHead = mk('div', 'display:flex;align-items:center;gap:8px')
    const curHeadTitle = mk('span', 'font-weight:700;font-size:15.5px', '当前题目')
    const syncTag = mk('span', 'font-size:13px;color:var(--color-ink3)', '')
    curHead.append(curHeadTitle, mk('span', 'flex:1'), syncTag)
    const numsRow = mk('div', 'display:flex;flex-wrap:wrap;gap:5px')
    const curRate = mk('div', 'display:flex;align-items:baseline;gap:10px')
    const curSeq = mk('span', 'font-size:26px;font-weight:700;letter-spacing:-.02em')
    const curTotal = mk('span', 'font-size:14px;color:var(--color-ink3)')
    const curRateGap = mk('span', 'flex:1')
    const curRateBig = mk('span', 'font-size:40px;font-weight:700;font-variant-numeric:tabular-nums')
    curRate.append(curSeq, curTotal, curRateGap, curRateBig)
    const curMeta = mk('div', 'display:flex;align-items:center;gap:10px;font-size:14px;color:var(--color-ink3)')
    const curBand = mk('span', 'padding:1px 8px;border-radius:var(--radius-sm);font-size:13px;font-weight:700')
    const curWrong = mk('span')
    curMeta.append(curBand, curWrong)
    const nameList = mk(
      'div',
      'display:none;max-height:132px;overflow:auto;scrollbar-width:thin;' +
        'scrollbar-color:var(--color-line2) transparent;padding:6px 8px;border-radius:var(--radius-sm);' +
        'background:var(--color-surface2);font-size:15px;line-height:1.9',
    )
    const curBtns = mk('div', 'display:flex;gap:6px')
    const btnPrev = mk('button', '', '◀')
    const btnNext = mk('button', '', '▶')
    const btnList = mk('button', '', '名单')
    const styleSmallBtn = (b, on) => {
      b.style.cssText =
        'flex:1;height:34px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;' +
        'display:grid;place-items:center;border-radius:var(--radius-sm);' +
        'border:1px solid ' +
        (on ? 'var(--color-accent)' : 'var(--color-line2)') +
        ';background:' +
        (on ? 'var(--color-accentsoft)' : 'var(--color-surface)') +
        ';color:' +
        (on ? 'var(--color-accentink)' : 'var(--color-ink)')
    }
    styleSmallBtn(btnPrev, false)
    styleSmallBtn(btnNext, false)
    styleSmallBtn(btnList, false)
    curBtns.append(btnPrev, btnNext, btnList)
    curPanel.append(curHead, numsRow, curRate, curMeta, nameList, curBtns)

    /* 逐题正确率（点一行切题） */
    const rowsPanel = mk(
      'div',
      'border:1px solid var(--color-line2);border-radius:var(--radius-md);' +
        'background:var(--color-surface);overflow:hidden;display:none',
    )
    const rowsHead = mk(
      'div',
      'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--color-line2)',
    )
    const rowsCount = mk('span', 'font-size:13px;color:var(--color-ink3)')
    rowsHead.append(
      mk('span', 'font-weight:700;font-size:15.5px', '逐题正确率 · 点一行切换小窗'),
      mk('span', 'flex:1'),
      rowsCount,
    )
    const rowsBody = mk('div', '')
    rowsPanel.append(rowsHead, rowsBody)

    /* 作业图片：与旧页「存成图片」同一个动作、同一句话术 */
    const imageRow = mk('div', 'display:flex;align-items:center;gap:10px;display:none')
    const imageBtn = mk('button', '', '存成图片')
    imageBtn.style.cssText =
      'height:34px;padding:0 14px;font-size:14px;font-family:inherit;font-weight:600;cursor:pointer;' +
      'border-radius:var(--radius-sm);border:1px solid var(--color-line2);' +
      'background:var(--color-surface);color:var(--color-ink2)'
    const imageNote = mk('span', 'font-size:13px;color:var(--color-ink3)')
    imageRow.append(imageBtn, imageNote)

    root.append(head, pipNote, empty, curPanel, rowsPanel, imageRow)

    /* ---------------- 选中的那一份 / 当前那一题 ---------------- */
    const current = () => rows[idx] ?? rows[0] ?? null
    const questionsOf = (row) => (row && Array.isArray(row.questions) ? row.questions : [])
    const curOf = (row) => {
      const qs = questionsOf(row)
      return qs[seq - 1] ?? null
    }

    /* ---------------- 画 ---------------- */
    const paintPick = (row) => {
      const want = String(row ? row.id : '')
      const have = Array.from(pick.children).map((o) => String(o.value ?? ''))
      const ids = rows.map((r) => String(r.id))
      if (have.length === ids.length && have.every((v, i) => v === ids[i])) {
        pick.value = want
        return
      }
      pick.innerHTML = ''
      for (const r of rows) {
        const o = mk('option', '', String(r.title ?? ''))
        o.value = String(r.id)
        pick.append(o)
      }
      pick.value = want
    }

    const paintNums = (row) => {
      numsRow.innerHTML = ''
      const total = questionsOf(row).length
      for (let n = 1; n <= total; n++) {
        const q = questionsOf(row)[n - 1]
        const on = n === seq
        const col = q ? q.bandColor : 'var(--color-ink4)'
        const b = mk('button', '', `${n} ${Math.round((q ? q.rate : 0) * 100)}%`)
        b.setAttribute('aria-label', `第 ${n} 题`)
        b.style.cssText =
          'display:flex;align-items:baseline;gap:4px;padding:3px 7px;border-radius:var(--radius-sm);' +
          'font-family:inherit;cursor:pointer;flex-shrink:0;font-size:14px;font-weight:700;' +
          'font-variant-numeric:tabular-nums;border:1px solid ' +
          (on ? col : 'var(--color-line2)') +
          ';background:' +
          (on ? 'var(--color-accentsoft)' : 'var(--color-surface2)') +
          ';color:' +
          col
        b.addEventListener('click', () => go(n))
        numsRow.append(b)
      }
    }

    const paintCur = (row) => {
      const q = curOf(row)
      const total = questionsOf(row).length
      curSeq.textContent = q ? `第 ${seq} 题` : '—'
      curTotal.textContent = q ? `/ ${total}` : ''
      curRateBig.textContent = q ? `${Math.round(q.rate * 100)}%` : ''
      curRateBig.style.color = q ? q.bandColor : 'var(--color-ink4)'
      curBand.textContent = q ? q.bandLabel : ''
      curBand.style.cssText =
        'padding:1px 8px;border-radius:var(--radius-sm);font-size:13px;font-weight:700;' +
        'background:var(--color-surface2);color:' +
        (q ? q.bandColor : 'var(--color-ink4)')
      curWrong.textContent = q ? `${q.wrongCount} 人错` : ''
      curBand.style.display = q ? 'inline-block' : 'none'
      curWrong.style.display = q ? 'inline-block' : 'none'

      nameList.innerHTML = ''
      if (q && showList) {
        for (const no of q.wrongNos ?? []) {
          const item = mk('span', 'margin-right:10px;white-space:nowrap', `${no} ${nameOf(no)}`)
          nameList.append(item)
        }
        nameList.style.display = 'block'
      } else {
        nameList.style.display = 'none'
      }
      btnList.textContent = showList ? '隐藏名单' : `名单 ${q ? q.wrongCount : 0}`
      styleSmallBtn(btnList, showList)
      /* 旧页那句「与小窗同步」：开着小窗时这儿也有一行字，不是空的 */
      syncTag.textContent = pipOn ? '与小窗同步' : ''
      btnPrev.disabled = !q
      btnNext.disabled = !q
      btnPrev.style.opacity = q ? '1' : '.45'
      btnNext.style.opacity = q ? '1' : '.45'
    }

    const paintRows = (row) => {
      rowsBody.innerHTML = ''
      const total = questionsOf(row).length
      rowsCount.textContent = `共 ${total} 题`
      rowsPanel.style.display = total ? 'block' : 'none'
      for (const q of questionsOf(row)) {
        const on = q.seq === seq
        const b = mk(
          'button',
          'width:100%;display:flex;align-items:center;gap:12px;padding:11px 12px;' +
            'font-family:inherit;text-align:left;cursor:pointer;border:0;border-left:3px solid ' +
            (on ? 'var(--color-accent)' : 'transparent') +
            ';background:' +
            (on ? 'var(--color-accentsoft)' : 'transparent'),
        )
        const box = mk(
          'span',
          'flex:none;width:34px;height:34px;display:grid;place-items:center;font-size:16px;' +
            'font-weight:700;border:1px solid var(--color-line2);border-radius:var(--radius-sm);' +
            'background:var(--color-surface);font-variant-numeric:tabular-nums',
          String(q.seq),
        )
        const mid = mk('span', 'min-width:0;flex:1;display:flex;flex-direction:column;gap:5px')
        const line1 = mk('span', 'display:flex;align-items:baseline;gap:12px')
        const rate = mk(
          'span',
          'font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;min-width:66px;color:' +
            (q.wrongCount ? q.bandColor : 'var(--color-ink4)'),
          `${Math.round(q.rate * 100)}%`,
        )
        const wrong = mk('span', 'font-size:14px;color:var(--color-ink3)', `${q.wrongCount} 人错`)
        const gap = mk('span', 'flex:1')
        const tag = mk(
          'span',
          'font-size:12.5px;font-weight:700;padding:1px 8px;border-radius:var(--radius-sm);' +
            'background:var(--color-surface2);color:' +
            (q.wrongCount ? q.bandColor : 'var(--color-ok)'),
          q.wrongCount ? q.bandLabel : '全对',
        )
        line1.append(rate, wrong, gap, tag)
        const barWrap = mk(
          'span',
          'display:block;height:6px;border-radius:3px;overflow:hidden;background:var(--color-surface3)',
        )
        const bar = mk(
          'i',
          `display:block;height:100%;width:${Math.max(2, Math.round(q.rate * 100))}%;background:${q.bandColor}`,
        )
        barWrap.append(bar)
        mid.append(line1, barWrap)
        b.append(box, mid)
        b.addEventListener('click', () => go(q.seq))
        rowsBody.append(b)
      }
    }

    const paint = async () => {
      const [graded, people] = await Promise.all([
        ctx.data.read('class.gradedHomework'),
        ctx.data.read('class.roster'),
      ])
      rows.length = 0
      for (const r of graded.rows ?? []) rows.push(r)
      roster = people.students ?? []
      if (idx >= rows.length) idx = 0
      seq = Math.min(Math.max(1, seq), Math.max(1, questionsOf(current()).length))

      const has = rows.length > 0
      empty.style.display = has ? 'none' : 'block'
      curPanel.style.display = has ? 'flex' : 'none'
      imageRow.style.display = has ? 'flex' : 'none'
      head.style.display = has ? 'flex' : 'none'
      if (!has) {
        rowsPanel.style.display = 'none'
        return
      }
      const row = current()
      paintPick(row)
      counts.textContent = row
        ? `应交 ${row.total} · 已交 ${row.submitted} · 未交 ${row.missing}`
        : ''
      counts.style.color = row && row.missing ? 'var(--color-bad)' : 'var(--color-ink3)'
      paintNums(row)
      paintCur(row)
      paintRows(row)
    }

    /* ---------------- 切题 / 切作业 ---------------- */
    const go = (n) => {
      const total = questionsOf(current()).length
      seq = Math.min(Math.max(1, n), Math.max(1, total))
      showList = false
      const row = current()
      paintNums(row)
      paintCur(row)
      paintRows(row)
      /* 小窗那边由宿主重推（插件只有 open/close，没有推内容的通道 —— 手册 §4.1） */
      if (pipOn) ctx.pip.open({ w: 360, h: 220, opacity: 1 })
    }

    pick.addEventListener('change', () => {
      idx = Math.max(0, rows.findIndex((r) => String(r.id) === String(pick.value)))
      seq = 1
      showList = false
      void paint()
    })
    btnPrev.addEventListener('click', () => go(seq - 1))
    btnNext.addEventListener('click', () => go(seq + 1))
    btnList.addEventListener('click', () => {
      showList = !showList
      paintCur(current())
    })

    /* ---------------- 置顶小窗（手册 §9） ---------------- */
    const openPip = async () => {
      if (!ctx.pip) {
        pipNote.style.display = 'block'
        pipNote.textContent = '这台机器上开不了置顶小窗。讲评时请用手机或平板看题号与正确率。'
        return false
      }
      const ok = await ctx.pip.open({ w: 360, h: 220, opacity: 1 })
      pipOn = ok
      stylePipBtn()
      pipBtn.textContent = ok ? '小窗已开启' : '启动置顶小窗'
      pipNote.style.display = ok ? 'none' : 'block'
      if (!ok) pipNote.textContent = '置顶小窗要教室版程序才能开。讲评时看屏上这一份，或者用手机和平板。'
      syncTag.textContent = ok ? '与小窗同步' : ''
      return ok
    }
    pipBtn.addEventListener('click', async () => {
      if (pipOn) {
        if (ctx.pip) ctx.pip.close()
        pipOn = false
        stylePipBtn()
        pipBtn.textContent = '启动置顶小窗'
        pipNote.style.display = 'none'
        syncTag.textContent = ''
        return
      }
      await openPip()
    })

    /* ---------------- 存成图片 ---------------- */
    imageBtn.addEventListener('click', async () => {
      const [hw, duty] = await Promise.all([
        ctx.data.read('class.dailyHomework'),
        ctx.data.read('class.duty'),
      ])
      const today = isoOf(ctx.now())
      const todayHw = (hw.rows ?? []).filter((h) => h.onDate === today)
      imageNote.textContent = ''
      const ok = await saveImage(
        ctx.class.name,
        today,
        todayHw,
        duty.today ? duty.today.name : null,
      )
      if (!ok) {
        ctx.ui.toast('这张图没画出来')
        return
      }
      ctx.ui.toast('作业图片已生成，去浏览器的下载里拿')
    })

    await paint()
    ctx.onDispose(ctx.data.watch('class.gradedHomework', () => void paint()))
    ctx.onDispose(ctx.data.watch('class.roster', () => void paint()))

    /*
     * 🔴 置顶小窗在**挂上这块时**就试一次（手册 §9 的镜像式：主屏功能块保留，小窗同一份数据）。
     *    两种失败都必须说人话，且不能只有一句 toast —— 屏上那行提示留着：
     *    · 网页预览下 `ctx.pip` **根本不存在**（手册 §9 的表）→ 说"这台机器上开不了"；
     *    · 壳里没开成 → 说"要教室版程序"。
     *    带「教室版」这三个字是手册 §9 那张表的规定话术，不是随口写的。
     */
    await openPip()
  },

  async deactivate() {
    /* 宿主会拆容器、注销 onDispose 登记的订阅；这里只做自己那份 */
  },
}
