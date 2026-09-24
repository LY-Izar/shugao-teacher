/**
 * 浏览器可执行文件的**唯一解析处**（`shots.mjs` / `clock-checks.mjs` 共用）。
 *
 * ============================================================
 * 为什么要有它
 * ============================================================
 * 两个脚本原来各自写死了一行：
 *
 *     const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
 *
 * 后果（审计列的）：换一台机器（Edge 装在 64 位目录 / 只装了 Chrome / 用非管理员账户装的）
 * **两个脚本一起崩**，而且报的是 playwright 那句"browserType.launch: Failed to launch …"
 * —— 看不懂、也不告诉你"是找不到浏览器"，更没法用参数换一个。
 *
 * 现在按这个**回退顺序**解析（第一个能用的就赢）：
 *
 *   ① `SHUGAO_EDGE`        —— 显式指定可执行文件（跨机器/CI 的唯一正解）
 *   ② `SHUGAO_EDGE_CHANNEL`—— 显式指定 playwright 的 channel（如 `msedge` / `chrome`）
 *   ③ 常见安装路径（逐个 `existsSync`）：
 *        · `%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`（本机就是这条）
 *        · `%ProgramFiles%\Microsoft\Edge\Application\msedge.exe`
 *        · `%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`
 *        · `%ProgramFiles%\Google\Chrome\Application\chrome.exe`
 *        · `%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`
 *        · `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
 *        · 以及 PATH 里的 `msedge` / `chrome`
 *   ④ **都不在就退回 `chromium.launch({ channel: 'msedge' })`** —— 让 playwright
 *      自己去找它认得的安装（它认得注册表和标准目录）。找不到时 playwright 抛错，
 *      由我们用**人话**包一层再抛出去（说清"怎么指定 SHUGAO_EDGE"，而不是只丢英文栈）。
 *
 * 用法：
 * ```js
 * import { launchBrowser } from './lib/edge-path.mjs'
 * browser = await launchBrowser({ headless: true })
 * // 需要自己 launch 时也可以只拿配置：
 * const cfg = resolveBrowserLaunch()   // → { executablePath } 或 { channel: 'msedge' }
 * ```
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

/** 常见安装路径（按"本机最可能命中"排序）。`%VAR%` 从 env 展开，取不到就跳过。 */
const CANDIDATES = [
  ['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft/Edge/Application/msedge.exe'],
  ['ProgramFiles', 'Google/Chrome/Application/chrome.exe'],
  ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'],
  ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe'],
]

/** PATH 里按名字找（`where` 的等价物，不额外起进程） */
function fromPath(names) {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const p = join(dir, name)
      try {
        if (existsSync(p)) return p
      } catch {
        /* 路径里可能有非法字符，跳过 */
      }
    }
  }
  return null
}

/**
 * 算出 `chromium.launch()` 要用的参数。
 * @returns {{executablePath: string, source: string} | {channel: string, source: string}}
 */
export function resolveBrowserLaunch() {
  const explicit = process.env.SHUGAO_EDGE
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(
        `SHUGAO_EDGE 指向的文件不存在：${explicit}\n` +
          `  它必须是**浏览器可执行文件**的完整路径，例如\n` +
          `  C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\n` +
          `  （不想要这个变量了就把 SHUGAO_EDGE 删掉，脚本会自己去常见路径里找）`,
      )
    }
    return { executablePath: explicit, source: 'SHUGAO_EDGE' }
  }

  const channel = process.env.SHUGAO_EDGE_CHANNEL
  if (channel) return { channel, source: 'SHUGAO_EDGE_CHANNEL' }

  for (const [envKey, rel] of CANDIDATES) {
    const base = process.env[envKey]
    if (!base) continue
    const p = join(base, ...rel.split('/'))
    try {
      if (existsSync(p)) return { executablePath: p, source: `%${envKey}%/${rel}` }
    } catch {
      /* 继续找下一个 */
    }
  }

  const onPath = fromPath(
    process.platform === 'win32' ? ['msedge.exe', 'chrome.exe'] : ['msedge', 'google-chrome', 'chromium'],
  )
  if (onPath) return { executablePath: onPath, source: 'PATH' }

  // 最后交给 playwright：它认得注册表 / 标准安装目录（`channel` 走它自己的查找）
  return { channel: 'msedge', source: 'playwright channel=msedge（本机常见路径都没找到）' }
}

/**
 * 起一个浏览器。**唯一入口** —— 别再在脚本里写 `chromium.launch({ executablePath: 'C:\\...' })`。
 *
 * @param {{headless?: boolean, args?: string[]}} [opts]
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function launchBrowser(opts = {}) {
  const cfg = resolveBrowserLaunch()
  const { source, ...launch } = cfg
  try {
    const browser = await chromium.launch({ ...launch, headless: opts.headless ?? true, args: opts.args })
    console.log(`  🌐 浏览器：${source}${'executablePath' in cfg ? ` → ${cfg.executablePath}` : ` → channel=${cfg.channel}`}`)
    return browser
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      `起不了浏览器（解析到的来源：${source}）。\n` +
        `  最可能的原因：这台机器上没装 Edge / Chrome，或者它们装在别处。\n` +
        `  办法：把浏览器可执行文件的完整路径给 SHUGAO_EDGE，例如\n` +
        `    $env:SHUGAO_EDGE = 'D:\\Edge\\Application\\msedge.exe'\n` +
        `  或者用 SHUGAO_EDGE_CHANNEL=chrome 换一个 playwright 认得的 channel。\n` +
        `  原始报错：${detail.split('\n')[0]}`,
    )
  }
}
