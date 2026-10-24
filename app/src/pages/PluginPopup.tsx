/**
 * 教室端「插件浮窗」那一屏（路由 `/popup/:pluginId`）。
 * ============================================================================
 * 它是什么：教室端里**每个插件一扇真实窗口**，壳把那扇窗指向应用内这条地址
 * （`app://-/popup/<pluginId>`），这一屏就是窗里的全部内容 ——
 * 一块玻璃卡片 + 一条能拖动窗口的顶栏 + 插件自己的真实界面。
 *
 * 🔴 为什么不再是一扇 `data:` 纸条窗（2026-10-24 改）：纸条窗只是壳按模板填的
 *    `title/body/rows`，插件真正的界面永远只在主屏上；现在窗里跑的是同一个应用、
 *    同一条路由渲染的真界面，**主屏那块功能块照旧留着**（镜像式，手册 §9）。
 *
 * ⚠️ 两条不变量：
 *  ① **网页版（没有壳）打开这条地址不能白屏**：`__shell_out` 不在也照常渲染，
 *     只是那颗 ✕ 没人接 ⇒ 干脆不摆它，改成说一句"这一屏要教室版程序才有"。
 *  ② **页面里不再叠一层不透明度**：窗口本身是透明窗，深浅由壳侧的 `setOpacity` 管；
 *     这里再乘一遍就会和壳各算一次（`?opacity=` 也不用读）。
 * ============================================================================
 */

import { useMemo, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import ClassroomPluginShell from './ClassroomPluginShell'
import ReviewPipPage from './ReviewPipPage'
import { availablePlugins } from '../classroom/demoPlugin'

/**
 * Electron 的窗口拖拽区不是 React 认识的 CSS 属性
 * （`CSSProperties` 里没有 `-webkit-app-region`）—— 这两份要原样落到 style 上。
 * 🔴 顶栏 `drag`、按钮那一段 `no-drag`：不写反了，✕ 就点不动（drag 区会吃掉点击）。
 */
const DRAG = { WebkitAppRegion: 'drag' } as unknown as CSSProperties
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as unknown as CSSProperties

/**
 * 浮窗是**透明窗**：`body` 那层实色底与 `body::before` 的背景网格必须让开 ——
 * 不让开的话，玻璃卡片四周会是一圈实色（看着像"纸条窗"，不是浮窗）。
 * ⚠️ 只在本页挂载期间生效（`<style>` 随组件一起进 DOM、一起走）。
 */
const BASE_CSS = `
  html, body { background: transparent !important; }
  body::before { display: none !important; }
`

/**
 * 玻璃卡片：深色半透明 + 模糊到能认出手感。
 * 🔴 这扇窗会盖在**任意桌面背景**上（亮壁纸 / 暗壁纸 / 幻灯片）⇒ 框本身走深色，
 *    深色框上的字用浅色 + 一圈细阴影兜住（见 `HEAD`），两种壁纸都看得清。
 * ⚠️ 阴影**只给顶栏**，不下放到内容区：插件那块界面是深色字的，加了阴影只会糊（见 `CONTENT`）。
 */
const CARD: CSSProperties = {
  borderRadius: 14,
  background: 'rgb(16 21 28 / .72)',
  border: '1px solid rgb(255 255 255 / .16)',
  boxShadow: '0 12px 32px rgb(0 0 0 / .35), inset 0 1px 0 rgb(255 255 255 / .08)',
  backdropFilter: 'blur(18px) saturate(1.2)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.2)',
}

/** 顶栏：拖动区 + 浅色字（深色框上唯一写字的地方） */
const HEAD: CSSProperties = {
  height: 34,
  borderBottom: '1px solid rgb(255 255 255 / .10)',
  color: '#f3f7fd',
  textShadow: '0 1px 2px rgb(0 0 0 / .5)',
  ...DRAG,
}

/**
 * 内容区垫的那一层浅色面。
 *
 * 🔴 为什么必须垫：教室端是**恒亮**主题（`ClassroomPluginShell` 一进来就摘掉 `data-theme`，
 *    见 `lib/theme.ts` 口径 ③）—— 插件那块界面画的是**深色字**。直接摆在深色玻璃上
 *    就是深色字压深色底。⇒ 框（顶栏、描边、圆角）保持深色，插件界面照它自己的亮色画。
 */
const CONTENT: CSSProperties = {
  background: 'rgb(246 249 253 / .94)',
  borderRadius: '0 0 13px 13px',
  color: 'var(--color-ink)',
}

/*
 * 🔴 原来这里有个 `closableWindow()`（按 `shellPlatform() === 'electron'` 判"这颗 ✕ 有没有人接"），
 *    2026-10-24 删掉：浮窗**没有 preload**，`shellPlatform()` 在窗里恒为 null ⇒ 它把真正的浮窗
 *    判成"没有壳"，于是窗里显示一句「这一屏要教室版程序才有」（而它就是那个浮窗）。
 *    `window.close()` 自己关自己不需要 preload，所以 ✕ 一律摆出来。
 */

/**
 * 顶栏上的插件名。
 *
 * ⚠️ 仓库里**没有** `loadPlugins()`（2026-10-24 核过 `src/`，没有这个导出）：
 *    能拿到 manifest 的只有内置目录 `availablePlugins()`。线上登记、没打进包的插件
 *    因此查不到名字 ⇒ **标题留空**（不拿 `pluginId` 顶上去：那是内部标识）。
 */
function pluginName(pluginId: string): string {
  if (!pluginId) return ''
  const hit = availablePlugins().find(
    (p) => p.manifest.id === pluginId || p.dirName === pluginId,
  )
  return hit?.manifest.name ?? ''
}

export default function PluginPopup() {
  const { pluginId = '' } = useParams<{ pluginId: string }>()
  const name = useMemo(() => pluginName(pluginId), [pluginId])
  /*
   * 🔴 作业讲评那一扇是**置顶小窗**，不是"能弹出的一块功能块"：
   *    用户 2026-10-24：「要原来固定版的那种」。所以它走自己那一屏（深色题号条面板），
   *    不套这层玻璃卡 —— 玻璃卡 + 整块插件界面会把「启动置顶小窗」那颗按钮也画进来，
   *    小窗里套一个小窗的按钮，正是这一版要消掉的东西。
   */
  const isPipPanel = pluginId === 'shugao.review'

  if (isPipPanel) {
    return (
      <div className="h-full w-full overflow-hidden" style={{ background: 'transparent' }}>
        <style>{BASE_CSS}</style>
        <ReviewPipPage />
      </div>
    )
  }

  return (
    <div
      className="flex h-full w-full flex-col"
      style={{ padding: 8, background: 'transparent' }}
    >
      <style>{BASE_CSS}</style>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={CARD}>
        {/* 顶栏：整条是窗口的拖动区，高 34 —— 再矮就不好按住拖 */}
        <header
          className="flex shrink-0 items-center gap-2 pl-3 pr-1.5"
          style={HEAD}
        >
          <span className="truncate text-[13px] font-semibold">{name}</span>
          <div className="ml-auto flex items-center gap-1" style={NO_DRAG}>
            {/*
              这一屏只有壳会开（`/popup/*`），所以那颗 ✕ 一律摆出来：
              窗口**没有 preload** ⇒ `shellPlatform()` 在窗里恒为 null，原来按它判就会
              在真正的浮窗里显示一句「这一屏要教室版程序才有」—— 而它**就是**那个浮窗。
              `window.close()` 自己关自己不需要 preload（壳那边也照 `closed` 事件收尾）。
            */}
            <button
              type="button"
              aria-label="关闭"
              onClick={() => window.close()}
              className="grid h-5 w-5 place-items-center rounded-md text-[11px] leading-none text-white/70 transition-colors hover:bg-white/15 hover:text-white"
            >
              ✕
            </button>
          </div>
        </header>
        {/* 内容区：插件自己的真实界面（`popupId` = 只画这一块，不画工具栏/画布） */}
        <div className="min-h-0 flex-1 overflow-hidden" style={CONTENT}>
          <ClassroomPluginShell popupId={pluginId} />
        </div>
      </div>
    </div>
  )
}
