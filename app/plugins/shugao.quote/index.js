/**
 * 祝福语插件（P2 首批搬运的第一个）
 *
 * 搬自旧教室端 `Classroom.tsx` 的 `DailyQuote` 块：同一份数据源（宿主资源
 * `class.quote`，宿主侧出自 `lib/quotes.ts`）、同一句话术格式、同一条"按北京时间
 * 日期轮换、同一天固定"的判据。行为差异只有一处，而且是插件模型本身带来的：
 * 它渲染在自己的功能块窗口里，不再固定占左栏一格。
 *
 * 刻意的写法（与宿主夹具 `scripts/fixtures/demo.helloclock` 同源）：
 *  ① 顶层零副作用（CF-04）：模块加载时什么都不做，全部在 `activate` 里；
 *  ② 不 import 任何裸模块、不碰 `window.__shell_out`（手册 §11）；
 *  ③ 没有文档时（纯 Node 契约自检）退化成普通对象，不为门禁写两套逻辑。
 */

const makeEl = () => {
  const doc = globalThis.document
  if (doc && typeof doc.createElement === 'function') {
    const wrap = doc.createElement('div')
    wrap.setAttribute('data-quote-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:16px;display:flex;flex-direction:column;' +
      'justify-content:center;text-align:center;font-family:system-ui'
    const text = doc.createElement('div')
    text.style.cssText =
      'font-weight:620;font-size:clamp(19px, 1.7vw, 27px);line-height:1.55;' +
      'letter-spacing:.01em;color:var(--color-ink)'
    const from = doc.createElement('div')
    from.style.cssText = 'margin-top:7px;font-size:13px;color:var(--color-ink3)'
    wrap.append(text, from)
    return { wrap, text, from }
  }
  /* 无 DOM（纯 Node 门禁）：只要 `container.append(x)` 能接住它就行 */
  const text = { textContent: '', style: {} }
  const from = { textContent: '', style: {} }
  const wrap = { append() {}, style: {} }
  return { wrap, text, from }
}

export default {
  async activate(ctx) {
    const el = makeEl()
    ctx.ui.container.append(el.wrap)

    const paint = async () => {
      const q = await ctx.data.read('class.quote')
      el.text.textContent = q.text ?? ''
      el.from.textContent = q.text ? `—— ${q.from ?? ''}` : ''
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.quote', () => void paint()))
    if (ctx.clock) {
      // 与旧教室端同一口径：每分钟重画一次，0 点翻天的时候句子跟着换
      ctx.onDispose(ctx.clock.onMinute(() => void paint()))
    }
  },

  async deactivate() {
    /* 宿主会拆容器、注销 onDispose 登记的订阅；这里只做自己那份 */
  },
}
