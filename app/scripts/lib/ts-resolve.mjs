/**
 * 让 Node 能直接 import 仓库里的 **TS 源码**（回归脚本共用）。
 *
 * 为什么需要它：仓库里的 TS 用的是 bundler 的解析方式 ——
 * `from './examPaperTypes'`（无扩展名）、`from '../data/knowledge'`（目录 → index.ts）。
 * Node 的 ESM 解析器两样都不认；但**直接跑真源码**远比复刻一份逻辑可靠
 * （项目里 §12.4.1 / §13.8 的两次实测也是这个路子）。
 *
 * 顺带把 `import.meta.env` 换成 `globalThis.__VITE_ENV__`：
 * Node 里它是 `undefined`（不是空对象），而 `lib/supabase.ts` 在**模块顶层**就读它，
 * 只能改源码，没法靠"先赋个值"绕过去。
 *
 * 用法（必须在 import 任何 TS 之前调用一次）：
 *   import { registerTsResolve } from './lib/ts-resolve.mjs'
 *   registerTsResolve()
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

export function registerTsResolve() {
  register(
    `data:text/javascript,${encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(spec)) {
          try { return await next(spec + '.ts', ctx) } catch { /* 继续试 */ }
          try { return await next(spec + '/index.ts', ctx) } catch { /* 落回原样 */ }
        }
        return next(spec, ctx)
      }
      export async function load(url, ctx, next) {
        const r = await next(url, ctx)
        if (r.format === 'module-typescript' || /\\.[cm]?ts$/.test(new URL(url).pathname)) {
          return { ...r, source: String(r.source).replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') }
        }
        return r
      }
    `)}`,
    pathToFileURL(`${process.cwd()}/`),
  )
  // 没配后端时 supabase.ts 会退回本地模式 —— 这正是 shots.mjs 需要的（演示数据）
  globalThis.__VITE_ENV__ ??= {}
}
