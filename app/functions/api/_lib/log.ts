/**
 * 服务端的一句人话日志 —— `src/lib/log.ts` 的**同形副本**（2026-10-29）。
 *
 * 🔴 为什么是副本而不是 import：
 *    Cloudflare Functions 的构建树与 `app/src/` 是两条**彼此不可见**的树
 *    （`functions/api/_lib/pluginTables.ts` 文件头记着这条实测结论：
 *    `functions/**` 里 `import '../../src/...'` 打不进产物）。
 *    `tsc -b` 能过不代表部署能过 —— 所以这里只留一份**逐字同格式**的实现。
 *
 * ⚠️ 改格式时**两处一起改**（`src/lib/log.ts` 是源头，这边跟着它）：
 *    一次输出必须同时有「参数」「这意味着」「下一步」。
 * ⚠️ 它自己**绝不抛错**：它常出现在错误路径上，日志再炸一次就会盖住真因。
 */

/** JSON 化参数；循环引用 / BigInt 这类不能序列化的东西给一句人话，不抛错 */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return '（参数里有无法序列化的值）'
  }
}

/**
 * 统一的一句人话日志：参数照原样给，同时说清"这意味着什么 / 下一步"。
 *
 * @param scope   出问题的范围（`frontend-error` …），屏上只有一个词
 * @param what    一句话：哪件事没成
 * @param params  原始参数（只放排查要用的字段）
 * @param meaning 这件事意味着什么（**对数据/对人的影响**，不是复述报错）
 * @param next    下一步去哪儿看什么
 */
export function logIssue(
  scope: string,
  what: string,
  params: Record<string, unknown>,
  meaning: string,
  next: string,
): void {
  try {
    console.error(
      `[树高教务助手] ${what} · scope=${scope}\n` +
        `  参数: ${safeJson(params)}\n` +
        `  这意味着: ${meaning}\n` +
        `  下一步: ${next}`,
    )
  } catch {
    /* 🔴 日志自己不许再抛错（见文件头） */
  }
}
