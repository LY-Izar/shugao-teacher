/**
 * 低版本 WebView 的**运行时 API** 补丁（2026-10-02，用户报"安卓低版本系统适配"）。
 *
 * 为什么需要：`vite.config.ts` 的 `build.target: 'es2015'` 只降**语法**——
 *   `Object.fromEntries`（Chrome 73）/ `Array.prototype.flat/flatMap`（Chrome 69）
 *   这类**方法**是运行时缺失：老机器（Android 6/7 出厂时的 WebView 可能是 Chrome 50
 *   那一代）会在**用到的那一行**抛 TypeError，整块功能悄悄坏掉（不白屏、更难报障）。
 *
 * ⚠️ **必须在 `main.tsx` 里当第一个 import**：ESM 模块体按 import 顺序执行，
 *    晚于任何业务模块就白补了。
 * ⚠️ 只补本仓 grep 实际用到的那几个（fromEntries ×4 / flat·flatMap ×20 / globalThis ×9），
 *    探测式写法（`if (!存在)`）—— 新引擎上**零开销、零行为变化**。
 *    `replaceAll` / `structuredClone` / `allSettled` / `.at()` 全仓 0 使用，不补。
 * 📌 哪天把 `build.target` 降到更低或升到更高，回这里对一遍名单。
 */

/* ---- globalThis（Chrome 71+）——个别模块在"非浏览器全局"探测时用到 ---- */
type GlobalWithNames = typeof globalThis & {
  globalThis?: unknown
}
const g = globalThis as GlobalWithNames
if (typeof g.globalThis === 'undefined') {
  (g as { globalThis: unknown }).globalThis = g
}

/* ---- Object.fromEntries（Chrome 73+）---- */
if (typeof Object.fromEntries !== 'function') {
  Object.defineProperty(Object, 'fromEntries', {
    writable: true,
    configurable: true,
    value: function fromEntries(entries: Iterable<[PropertyKey, unknown]>): Record<PropertyKey, unknown> {
      const out: Record<PropertyKey, unknown> = {}
      for (const pair of Array.from(entries)) {
        if (!pair || typeof pair !== 'object' && typeof pair !== 'function') continue
        const k = (pair as Array<[PropertyKey, unknown]>)[0]
        if (typeof k !== 'string' && typeof k !== 'symbol' && typeof k !== 'number') continue
        out[k as PropertyKey] = (pair as Array<[PropertyKey, unknown]>)[1]
      }
      return out
    },
  })
}

/* ---- Array.prototype.flat / flatMap（Chrome 69+）----
 * 本仓的调用都是 `flat()` / `flatMap(fn)`（无深度参数 / 单层），实现按"拍平一层"兜底：
 * 真正嵌套多层的调用点全仓没有（grep 过），这里不追求 Infinity 的完整语义。 */
if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    writable: true,
    configurable: true,
    value: function flat(this: unknown[]): unknown[] {
      const out: unknown[] = []
      for (const item of this) {
        if (Array.isArray(item)) out.push(...(item as unknown[]))
        else out.push(item)
      }
      return out
    },
  })
}
if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    writable: true,
    configurable: true,
    value: function flatMap<T, U>(
      this: T[],
      fn: (item: T, index: number, arr: T[]) => U | U[],
    ): U[] {
      const out: U[] = []
      const src = this as T[]
      for (let i = 0; i < src.length; i++) {
        const mapped = fn(src[i], i, src)
        if (Array.isArray(mapped)) out.push(...(mapped as U[]))
        else out.push(mapped)
      }
      return out
    },
  })
}

export {}
