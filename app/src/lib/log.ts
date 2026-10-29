/* ============================================================
   控制台的一句人话（2026-10-29）
   ------------------------------------------------------------
   为什么要有它：这个仓库里"被吞掉的失败"太多（错误上报、发信、
   自动刷新……）。`console.error('…失败', e)` 只留下一个错误对象，
   三个月后看到它的人（通常还是同一个人）得重新读一遍代码才知道
   "当时在干什么、这意味着什么、下一步看哪儿"。

   🔴 一次输出必须同时有三样（参数给人看的那份是"机器也看得懂"的）：
      · **参数**：原样给（不要只给一句"失败了"）；
      · **这意味着**：这件事对用户/数据的影响（是"没人知道"，还是"已经存了"）；
      · **下一步**：具体去哪儿看什么。
   ⚠️ 它只用于"**已经发生、但被有意吞掉**"的失败（用户不该被打扰的那一类）。
      正常流程、调试打印不要用它 —— 那会把这条输出的分量冲淡。
   ⚠️ 它自己**绝不抛错**：它常出现在错误路径上，日志再炸一次就会盖住真因。
   ============================================================ */

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
 * @param scope   出问题的范围（`frontend-error` / `welcome-mail` …），屏上只有一个词
 * @param what    一句话：哪件事没成
 * @param params  原始参数（只放排查要用的字段，别把整页 state 塞进来）
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
