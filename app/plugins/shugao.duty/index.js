/**
 * 值日生插件（shugao.duty）
 *
 * 搬自旧教室端「每日作业」块里那行值日生：读宿主资源 `class.duty`，只回答一件事 ——
 * 今天轮到谁。轮换规则（按学号轮流、周末与放假跳过）由宿主 `lib/duty.ts` 算，
 * 资源里直接给 `today`，插件不抄第二份判据。
 *
 * 刻意的写法（与 `shugao.quote` / `shugao.daily` 同源）：
 * ① 顶层零副作用（CF-04）；② 不 import 任何裸模块（手册 §11.3）；
 * ③ 没有 DOM 时（纯 Node 契约自检）退化成极小的假节点，不为门禁写两套逻辑。
 */

const el = (tag, css, text) => {
  const e = document.createElement(tag)
  if (css) e.style.cssText = css
  if (text !== undefined) e.textContent = text
  return e
}

/* 纯 Node（契约自检）里没有 document —— 假骨架只够把 activate 跑完 */
const noDom = () => {
  const sink = {
    style: {},
    textContent: '',
    append() {},
    setAttribute() {},
    addEventListener() {},
  }
  const anyEl = () => ({ ...sink, style: {} })
  return { el: anyEl, wrap: { ...sink, append() {} } }
}

export default {
  async activate(ctx) {
    const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function'
    const wrap = hasDom ? document.createElement('div') : noDom().wrap
    wrap.setAttribute('data-duty-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:16px;' +
      'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
      'text-align:center;font-family:system-ui;color:var(--color-ink)'
    const mk = hasDom ? el : (() => { const d = noDom(); return d.el })()
    const label = mk('div', 'font-size:13px;color:var(--color-ink3)', '今天值日生')
    const who = mk('div', 'margin-top:4px;font-size:46px;font-weight:700;line-height:1.2;word-break:break-word')
    const empty = mk('div', 'font-size:15px;color:var(--color-ink3);line-height:1.8;display:none', '今天没有值日生')
    const hint = mk('div', 'margin-top:10px;font-size:12px;color:var(--color-ink4)', '按学号轮流，周末与放假跳过')
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
