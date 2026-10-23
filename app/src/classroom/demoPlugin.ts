/**
 * 宿主自带的**演示插件**（手册 §12：`?demoPlugin=1` 时加载它）。
 *
 * 它与 `scripts/fixtures/demo.helloclock/`（契约自检 CF-01…CF-14 的夹具）是**同一份
 * 契约的两个载体**：夹具在纯 Node 里钉"宿主核心判得对不对"，这一份在真浏览器里钉
 * "加载器接线接得对不对"（容器、能力注入、storage 假槽、时钟、pip 降级）。
 * 🔴 两份的 manifest 字段保持一致 —— 改一份要想着另一份（它们各自被两道门禁盯）。
 *
 * ⚠️ 走 `import()` 的真下载要等壳侧的 `downloadPlugin`（`classroomShell.ts` 顶部那四条
 *    约定）；P0b 能在网页里演示的就是这一份内置的。
 */

import type { PluginManifest } from '../lib/pluginHost'

export interface AvailablePlugin {
  /** 插件目录名（= manifest.id，校验就是查这两个相等）。 */
  dirName: string
  manifest: PluginManifest
  module: {
    activate?: (ctx: Record<string, unknown>) => unknown
    deactivate?: () => unknown
  }
  /** P0b 只有内置演示这一种来源；真下载（壳侧 `downloadPlugin`）进来后加 `'downloaded'`。 */
  source: 'bundled'
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

/** P0b 的插件来源就这一个；`demoPlugin=1` 才把它列进加载清单（手册 §12 的那条地址）。 */
export function availablePlugins(demoPlugin: boolean): AvailablePlugin[] {
  return demoPlugin ? [DEMO_PLUGIN] : []
}
