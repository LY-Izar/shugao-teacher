/**
 * 版本号只在这里改一处。
 * 之前左栏写 v0.6.0、登录页写 v0.2.0，两处互相矛盾 —— 就是因为各写各的。
 *
 * ***REMOVED******REMOVED*** 两个值，两种语义（别合并）
 *
 * | 导出 | 谁写 | 用途 |
 * | --- | --- | --- |
 * | `APP_VERSION` | **人手写**，发版时改 | 给人看的"第几版"（更新日志按它对号） |
 * | `BUILD_HASH` | **构建时自动**（本文件从产物 URL 里取） | 判断"线上跑的是哪一次构建" |
 *
 * 为什么要第二个：这个值一直停在 0.8.0、从没随发版递增过，于是排查部署问题时
 * "线上是不是我这一版"根本答不出来 —— 上一次最后是靠**手工比对线上 JS 的文件哈希**
 * 才确认的。哈希本来就在产物 URL 里，顺手取出来显示即可，不需要任何构建配置。
 *
 * ***REMOVED******REMOVED*** 发版三步（顺手做，一次一分钟）
 * 1. 改本文件的 `APP_VERSION`（语义化：修 bug 加末位、加功能加中位、不兼容改首位）
 * 2. 同步 `app/package.json` 的 `version`
 * 3. 在「我的 → 更新日志」（`pages/Settings.tsx`）顶部加一段
 *
 * 三件事都在这一处注释里写着 —— 因为"忘了改版本号"是这套流程里唯一会静默发生的事故。
 */

/** 发版号：**每次发版顺手改这里**（并同步 `app/package.json`、更新日志）。 */
export const APP_VERSION = '0.9.1'

/**
 * 构建产物哈希（生产是 `/assets/index-XXXXXXXX.js` 里那一段）。
 *
 * - 打包后本模块与入口同在一个 chunk，`import.meta.url` 就是那个 chunk 的地址；
 * - 开发态是 `/src/lib/version.ts`，取不到 → `null`；
 * - 取不到时**只显示版本号**，绝不编一个假哈希（那会让人以为两次部署是同一份）。
 */
function readBuildHash(): string | null {
  try {
    const m = /\/assets\/[^/]*?-([A-Za-z0-9_-]{6,})\.[cm]?js(?:[?***REMOVED***]|$)/.exec(import.meta.url)
    return m ? m[1] : null
  } catch {
    return null
  }
}

export const BUILD_HASH = readBuildHash()

/**
 * 界面上一律用这个（含 `v` 前缀）：`v0.9.0 · huMJaX7k`。
 * 两个部署的版本号一样、哈希不一样 → 就是"代码改了但没人改版本号"，
 * 一眼看得出来，不用再去下载线上的 JS 比对。
 */
export const APP_VERSION_LABEL = BUILD_HASH
  ? `v${APP_VERSION} · ${BUILD_HASH}`
  : `v${APP_VERSION}`
