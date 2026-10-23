/**
 * 假插件 · 示例时钟（`scripts/plugin-framework-checks.mjs` 的夹具）
 *
 * 这份文件同时是**手册 §15 那个示例的上位版**：门禁拿它跑 CF-01…CF-14，
 * 其他开发者照着它的形状写就能通过同一套检查。
 *
 * 三条刻意的写法：
 *  ① 顶层零副作用（CF-04）：模块加载时什么都不做，全部在 `activate` 里；
 *  ② 不 import 任何裸模块、不碰 `window.__shell_out`（手册 §11）；
 *  ③ 元素靠 `document` 拿，**没有 document 时退化成一个普通对象** ——
 *     纯 Node 门禁里没有 DOM，而插件不该为了"门禁跑得通"写两套逻辑。
 *
 * 🆕 P1（2026-10-24）：带上 `config` 能力，`showNext` 开关控制"下一节"显不显示 ——
 *    它同时是"教师改配置 → 教室端 1 秒内可见"那条验收的**屏上证据**：
 *    `ctx.config.onChange` 一来就重画（宿主把合并过默认值的生效值递进来）。
 *    ⚠️ 与 `app/src/classroom/demoPlugin.ts`（网页内置那份演示）**逐行为同源** —— 改一处想着另一处。
 */

const makeEl = () => {
  const doc = globalThis.document
  if (doc && typeof doc.createElement === 'function') {
    const el = doc.createElement('div')
    el.style.font = '600 42px/1.3 system-ui'
    return el
  }
  /* 无 DOM（纯 Node 门禁）：只要 `container.append(x)` 能接住它就行 */
  return { textContent: '', style: {} }
}

export default {
  async activate(ctx) {
    const el = makeEl()
    ctx.ui.container.append(el)

    const paint = async () => {
      const { current, next, stale } = await ctx.data.read('class.slotNow')
      /* `!== false`：演示槽里还没有这份配置时按默认值（true）走 —— 空值不是"关" */
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
    /* 教师改完配置（P1 的配置通道）→ 重画一次：这就是"配置实时跟随"的插件那一半 */
    if (ctx.config) ctx.onDispose(ctx.config.onChange(() => void paint()))

    /* 悬浮窗：拿不到能力、或壳里没开成，都必须**说人话**（手册 §9，CF-13） */
    if (ctx.pip) {
      const ok = await ctx.pip.open({ w: 360, h: 220, opacity: 1 })
      if (!ok) el.textContent = '要在教室版程序里才能弹小窗'
    }
  },

  async deactivate() {
    /* 宿主会拆容器、注销 onDispose 登记的订阅；这里只做自己那份 */
  },
}
