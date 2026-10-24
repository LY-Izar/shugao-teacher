/**
 * 班级课表插件（P2 收尾 ②：旧教室端「班级课表录入」→ **只读显示**）
 *
 * ============================================================================
 * 2026-10-24 用户拍板（第二次改口）：**课表不由教室端录入**
 * ============================================================================
 * 录入在教师端「班级管理 → 本班课表」那一块（早就有了，路由与判据都在那边）；
 * 教室屏只负责**显示**。所以这个插件是只读的：
 *   · `permissions` 里**没有** `write`，`manifest` 里**没有** `writes`；
 *   · 旧页那块「粘贴解析 / 拍照 OCR / 手改格子 / 确认导入」整块**不进插件**
 *     （那段代码仍原样留在旧 `Classroom.tsx` 里，P2 收尾才整块删）。
 *
 * 判据全在宿主，插件不自己造：
 *   · `class.schedule` —— 本班 `scope='class'` 的每一节：weekday / start / end /
 *     subject / teacherName（筛选在 `src/classroom/resources.ts`，与大屏同源）；
 *   · `class.slotNow` —— 「当前这一节 / 下一节」，宿主用 `dayState()` 算的
 *     （含分钟级倒计时），插件只负责把它标在屏上。
 * 插件自己只干两件事：把**今天**那几节按时间摆开、把 `slotNow` 的当前那一节标出来。
 *
 * 刻意的写法（与 `shugao.quote` / `shugao.review` 同源）：
 *  ① 顶层零副作用（CF-04）；② 不 import 任何裸模块（手册 §11.3）；
 *  ③ 没有 DOM 时（纯 Node 契约自检）退化成极小的假节点，不为门禁写两套逻辑。
 */

/* ============================================================
   无 DOM 时的小假节点 —— 只够契约自检跑完（容器 append 得接住、textContent 读得出）
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

const mk = (tag, css, text) => {
  const e = hasDom() ? globalThis.document.createElement(tag) : new FakeEl(tag)
  if (css) e.style.cssText = css
  if (text !== undefined) e.textContent = text
  return e
}

/** 星期几（1 = 周一…7 = 周日）—— 与 `ScheduleItem.weekday` 同一口径（宿主 `weekdayOf`）。
 *  ⚠️ `Date.getDay()` 是 0 = 周日，只在这一处换算，别在别处再写一遍。 */
const weekdayOf = (d) => d.getDay() || 7

const WD_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export default {
  async activate(ctx) {
    const root = mk(
      'div',
      'height:100%;box-sizing:border-box;padding:12px 14px;overflow:auto;' +
        'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
        'font-family:system-ui;color:var(--color-ink);display:flex;flex-direction:column;gap:10px',
    )
    root.setAttribute('data-schedule-slot', '')
    ctx.ui.container.append(root)

    const head = mk('div', 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap')
    const headTitle = mk('span', 'font-weight:700;font-size:17px', '本班课表')
    const headDay = mk('span', 'font-size:14px;color:var(--color-ink3)')
    head.append(headTitle, mk('span', 'flex:1'), headDay)

    /* 当前 / 下一节：`slotNow` 是宿主算的，这里只负责摆上屏 */
    const nowLine = mk(
      'div',
      'padding:9px 11px;border-radius:var(--radius-sm);font-size:15px;line-height:1.7;' +
        'background:var(--color-accentsoft);border:1px solid var(--color-accent);color:var(--color-accentink)',
    )

    const list = mk('div', 'display:flex;flex-direction:column;gap:6px')
    const empty = mk('div', 'font-size:15px;color:var(--color-ink3);line-height:1.8;display:none', '今天没课。')

    root.append(head, nowLine, list, empty)

    const paint = async () => {
      const now = ctx.now()
      const wd = weekdayOf(now)
      headDay.textContent = `${WD_TEXT[wd - 1]} · ${now.getMonth() + 1} 月 ${now.getDate()} 日`

      const [sched, slot] = await Promise.all([
        ctx.data.read('class.schedule'),
        ctx.data.read('class.slotNow'),
      ])
      const cur = slot.current ?? null
      const next = slot.next ?? null

      /* 今天那几节：只按宿主给的 `weekday` 筛，按开始时间排（HH:MM 字符串序即时间序） */
      const today = (sched.items ?? [])
        .filter((it) => Number(it.weekday) === wd && String(it.start ?? ''))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      /* `slotNow` 的 Slot 只带 subject/subjectCode/start/end（不带老师）——
         老师那一截从同校次的课表行上取，别在 `slotNow` 上期待没有的字段。 */
      const curItem = cur ? today.find((it) => it.start === cur.start) ?? null : null
      const nextItem = next ? today.find((it) => it.start === next.start) ?? null : null

      const line = (head, s, item) => {
        const teacher = item && item.teacherName ? ` ${item.teacherName}` : ''
        return head === 'cur'
          ? `正在上 · ${s.subject}${teacher} · 到 ${s.end}`
          : `下一节 · ${s.subject}${teacher} · ${s.start} 开始`
      }

      if (cur) {
        nowLine.textContent = line('cur', cur, curItem)
        nowLine.style.display = 'block'
      } else if (next) {
        nowLine.textContent = line('next', next, nextItem)
        nowLine.style.display = 'block'
      } else {
        nowLine.style.display = 'none'
        nowLine.textContent = ''
      }

      list.innerHTML = ''
      empty.style.display = today.length ? 'none' : 'block'
      for (const it of today) {
        const on = Boolean(cur && cur.start === it.start)
        const row = mk(
          'div',
          'display:flex;align-items:baseline;gap:10px;padding:7px 10px;border-radius:var(--radius-sm);' +
            `border:1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'};` +
            `background:${on ? 'var(--color-accentsoft)' : 'var(--color-surface)'}`,
        )
        /* 时间在前（旧页与课程管理同一口径） */
        row.append(
          mk(
            'span',
            'flex:none;font-size:14px;font-variant-numeric:tabular-nums;color:' +
              (on ? 'var(--color-accentink)' : 'var(--color-ink2)'),
            `${it.start}–${it.end}`,
          ),
          mk(
            'span',
            'min-width:0;flex:1;font-size:16px;font-weight:650;overflow:hidden;' +
              'text-overflow:ellipsis;white-space:nowrap',
            it.subject || '',
          ),
          mk('span', 'flex:none;font-size:13px;color:var(--color-ink3)', it.teacherName || ''),
        )
        if (on) {
          row.append(
            mk(
              'span',
              'flex:none;font-size:12px;font-weight:700;padding:1px 7px;border-radius:var(--radius-sm);' +
                'background:var(--color-accent);color:var(--color-onaccent)',
              '正在上',
            ),
          )
        }
        list.append(row)
      }
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.schedule', () => void paint()))
    ctx.onDispose(ctx.data.watch('class.slotNow', () => void paint()))
    if (ctx.clock) {
      /* 整分钟重画：当前/下一节是按分钟翻的（与旧页 `dayState` 同一口径） */
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {
    /* 宿主会拆容器、注销 onDispose 登记的订阅；这里只做自己那份 */
  },
}
