import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * 🔴 把产物里的 `@layer` **摊平**（2026-10-04，用户报"安卓较低版本的设备上 UI 不能正常显示"）。
 *
 * 为什么必须做：Tailwind v4 把**全部**样式放进 `@layer theme/base/components/utilities`，
 * 而 `@layer` 的浏览器底线是 **Chrome 99 / Android WebView 99**（2022-03）——
 * 更老的 WebView **不认识 `@layer`，会把整块连同里面的规则一起丢掉**
 * ⇒ 页面等于**完全没有样式**（用户看到的"不能正常显示"就是这个）。
 *
 * 摊平 = 把 `@layer x { … }` 的外壳去掉、内容原地留下（顺序不变 ⇒ 层叠结果一致：
 * Tailwind 那几层的先后本来就是按 theme → base → components → utilities 输出的，
 * 而项目自己的 CSS 在 `@import "tailwindcss"` **之后**，摊平后仍然排在后面、照样赢平局）。
 *
 * ⚠️ 只动**产物**，不动 `index.css` 的写法（那边继续用 Tailwind 的层，开发时该有的语义不变）。
 * ⚠️ 这一段必须 `enforce: 'post'` 且挂在 `generateBundle` 上 —— 要在 Tailwind 的插件
 *    已经产出最终 CSS **之后**再摊，早一步摊的是半成品。
 * 📌 门禁：`nav-checks` 的 D17 直接读 `dist/` 断言"产物里没有 `@layer`"（反向对照也在那儿）。
 */
export function flattenCssLayers(css: string): string {
  let out = ''
  let i = 0
  const n = css.length
  const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_-]/.test(c)
  while (i < n) {
    if (css.startsWith('@layer', i) && !isWordChar(css[i - 1])) {
      let j = i + '@layer'.length
      while (j < n && css[j] !== '{' && css[j] !== ';') j++
      if (css[j] === ';') {
        /* `@layer a, b;`（层顺序声明）整条丢掉 */
        i = j + 1
        continue
      }
      if (css[j] === '{') {
        let depth = 0
        let k = j
        for (; k < n; k++) {
          if (css[k] === '{') depth++
          else if (css[k] === '}') {
            depth--
            if (depth === 0) break
          }
        }
        out += flattenCssLayers(css.slice(j + 1, k)) // 递归：层里还可能嵌层
        i = k + 1
        continue
      }
    }
    out += css[i]
    i++
  }
  return out
}

function shugaoCssCompat() {
  return {
    name: 'shugao-css-compat',
    enforce: 'post' as const,
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const file of Object.values(bundle) as Array<Record<string, unknown>>) {
        if (file?.type !== 'asset' || typeof file.fileName !== 'string') continue
        if (!file.fileName.endsWith('.css')) continue
        const src = typeof file.source === 'string' ? file.source : String(file.source)
        file.source = flattenCssLayers(src)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), shugaoCssCompat()],
  build: {
    /*
     * 🔴 产物语法底线：**es2015**（2026-10-04 加，同一个报障）。
     *    不写它时 Vite/rolldown 按"现代基线"产出 —— 实测产物里有 `?.`（59 处）与
     *    `??`（91 处），那是 **Chrome 80+** 才认的语法 ⇒ 更老的 Android WebView
     *    **整个 bundle 解析失败**（白屏，连"UI 不正常"都看不到）。
     *    es2015 = Chrome 49+ ⇒ 覆盖 minSdk 23（Android 6）那一档的老机器。
     *    ⚠️ 代价是产物大一点（async/await 会被降级）；换来的是"老机器能打开"。
     */
    target: 'es2015',
  },
  server: {
    host: true,
    port: 5178,
    /*
     * 🔴 **`strictPort` 必须为 true**（2026-09-27 加，审计实测的事故）：
     * 不写它时，5178 被占（另一个 checkout 的 dev server、上一次没关干净的进程、
     * 别人的调试实例）vite 会**静默改到 5179** 并照常打印 "ready"，
     * 而 `shots.mjs` / `clock-checks.mjs` 打的是**写死的 5178** ——
     * 于是脚本可能在测**别人更早起的那个 server**（甚至另一个 checkout 的代码），
     * 断言全绿、图也对，测的却不是这一份源码。这是最难查的一类假通过。
     * 打开它之后端口被占会**直接报错退出**（错误信息里写着 5178 在用），
     * 让人当场看见，而不是偷偷换端口。
     */
    strictPort: true,
    watch: {
      /*
       * Windows + 编辑器的原子写入（会先建临时目录再改名替换）会让原生
       * 文件监听抛 EBUSY 并**静默失效** —— 表现为服务器一直发旧代码，
       * 改了不生效、路由对不上。改用轮询，彻底规避这一类问题。
       * node_modules 已被忽略，轮询成本可忽略。
       */
      usePolling: true,
      interval: 400,
      ignored: ['**/node_modules/**', '**/dist/**', '**/.shots/**', '**/*.tmpdir/**', '**/*.tmp'],
    },
  },
})
