/* ============================================================
   分块（chunk）加载失败的**自愈**与**给老师看的那一句**（2026-10-06 真机反馈）
   ------------------------------------------------------------
   🔴 **现场**（老师手机上的原话，来自 `/admin` 的错误日志）：
      `2026/10/6 03:06:04 唐友余 teacher [渲染] Failed to fetch dynamically
       imported module: https://shugao-teacher.pages.dev/assets/Workbench-DwBWPkZLY.js`
      补充：**安卓 10 系统上登录时出的**。

   根因（与 `AGENTS.md` §九.5 同一族，但这一条不是 dev server 的 `?v=` 那个）：
   **低版本 WebView + 部署换代**。老师的浏览器里还留着**上一版的 `index.html`**
   （它写死了 `assets/Workbench-<旧哈希>.js`），而新部署一上线，**旧分块已经不在**
   ⇒ 点进那个页面时那次动态 `import()` 直接失败 ⇒ 页面卡在"加载中…"。
   ⚠️ 这不是"网络不好"：**重试同一个 URL 一百次都是 404**。唯一的解法是
   **重新取一份新的 `index.html`**（也就是真重载一次）。

   🔴 **所以这个文件的全部职责只有两件事**：
     ① 命中这类失败 ⇒ **自动重载一次**（同一个会话只自愈一次，见下面的防循环）；
     ② 重载之后**又**失败 ⇒ **不再重载**，交给 `components/ErrorBoundary.tsx`
        给老师那句人话 + 错误码（`FE-CHUNK-01`）。

   🔴 **它不许成为新的错误源**：
     · 监听器里**一行都不许抛**（抛出去会被 `installErrorReporting()` 接住 ⇒ 自己报自己）；
     · 上报走**既有的那一个封装** `reportFrontendError()`（`lib/errors.ts`）——
       **绝不新造第二条上报链**（`report_frontend_error` 是 RPC，匿名可调）。
   ============================================================ */

import { reportFrontendError } from './errors'
import { APP_VERSION_LABEL } from './version'

/** 出错阶段：`加载` = 分块/资源没拉到（本文件）· `渲染` = 代码跑起来了但抛了错 */
export const CHUNK_PHASE = '加载'

/** 给老师看的错误码。**只有这一个**：分块加载失败。 */
export const CHUNK_ERROR_CODE = 'FE-CHUNK-01'

/**
 * 🔴🔴 **调试期 / 正式期的唯一开关**（用户 2026-10-06 原话：
 *    「这些报错上屏仅限于目前调试阶段，后面正式使用时……用户只用看见
 *      XXXX 发生错误，请即时反馈的弹窗就行了」）。
 *
 * `DEBUG_ERROR_SCREEN = true`  → 兜底界面上多一行小字：**失败的 URL 原文**
 *                                （调试期排"是哪个分块、哪一次部署"必需的东西）
 * `DEBUG_ERROR_SCREEN = false` → **只留那句人话 + 错误码**（正式期）
 *
 * ⚠️ 切正式期 = **只改这一行**。别在页面里另写一处判断（两处就会走散）。
 * ⚠️ 无论开关是哪一档，**给老师的那一句与错误码都不变**（错误码是唯一的排查线索，
 *    老师截图一张就够我们定位到"分块加载失败"）。
 */
export const DEBUG_ERROR_SCREEN = true

/**
 * 失败原因的形状（只留上报需要的三样，**不带任何个人信息**）。
 * `message` 是**给排查用的**（进 `frontend_errors.message`），**不上屏**。
 */
export type ChunkFailure = { message: string; url: string; filename?: string }

/**
 * "分块拉不到"这一类的**唯一识别器**（事件之外还要靠它 —— 见 `installChunkRecovery`）。
 *
 * `vite:preloadError` 是首选信号，但它**只在 Vite 的 preload helper 那一层**发得出来；
 * 低版本 WebView 上还有几种走法：静态 `import` 失败后抛的 TypeError、
 * Page Not Found 的 404、以及 `<link rel=stylesheet>` 拉不到。
 * 所以下面那条正则里的**五支原文都要认**（`Failed to fetch dynamically imported module` /
 * `error loading dynamically imported module` / `Importing a module script failed` /
 * `Unable to preload CSS` / `dynamically imported module`），多认一种不多花一分钱，少认一种就是老师卡住。
 */
const CHUNK_FAIL_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|dynamically imported module/i

/** 这段文案是给**人**（老师 / 我们排查）看的判据：改识别器就必须改它 */
export function isChunkFailure(message: string): boolean {
  try {
    return CHUNK_FAIL_RE.test(String(message ?? ''))
  } catch {
    return false
  }
}

/** 从一段原文里抠出那个 URL（**抠不到返回空串**，绝不编一个） */
function urlOf(text: string): string {
  try {
    const m = /https?:\/\/[^\s)"']+/.exec(String(text ?? ''))
    const u = m ? m[0] : String(text ?? '')
    return u.slice(0, 300)
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------
   防循环：**同一个标签页会话里只自愈一次**
   ------------------------------------------------------------
   🔴 每一次 reload 之前**先把标记写下去**（顺序要紧）：
      写标记在前 ⇒ 万一重载被浏览器挡住、页面还停在原地，下次再失败也是
      "已经试过了"⇒ 走人话那一档；反过来写就成了**无限刷新**（老师手机上一秒一刷，
      电量和流量全烧光，而且他还是进不去）。
   ⚠️ `sessionStorage` 而不是 `localStorage`：会话级就够（新开一次标签页 = 重新试一次），
      而且本项目的口径一贯是"本机记性不落库"。
   ⚠️ 隐私模式下 `sessionStorage` 会**抛异常** ⇒ 所有读写都在 try 里，
      读不到就当作"没试过"（宁可多自愈一次，也不要一个卡死的页面）。
   ------------------------------------------------------------ */
const RELOAD_MARK = 'shugao.chunkReloaded'

function reloadAlreadyTried(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_MARK) === '1'
  } catch {
    return false
  }
}

/**
 * 真跑一次重载。
 *
 * 🔴 为什么不是裸 `location.reload()`：**在 URL 上挂一个一次性查询参数**。
 *    `reload()` 有可能照旧吃浏览器的 bfcache / 那份旧 `index.html`（低版本 WebView 上真会），
 *    换一个 URL 就等于强制走一次网络 ⇒ 拿到的一定是新部署的 `index.html`。
 *    ⚠️ `replace()` 而不是 `assign()`：**别往老师的历史里塞一条记录**
 *       （塞了之后他按返回键会回到那个坏页面）。
 *    ⚠️ 只留一个参数：反复进 `/admin` 时先把上一次那个参数摘掉，URL 不会越滚越长。
 */
function hardReload(): void {
  try {
    const u = new URL(location.href)
    u.searchParams.delete('_r')
    u.searchParams.set('_r', String(Date.now()))
    location.replace(u.toString())
  } catch {
    try {
      location.reload()
    } catch {
      /* 连 reload 都不给（某些内嵌 WebView）—— 那就只能靠屏上那句话了 */
    }
  }
}

/** 会话内"正在自愈"的闸：同一时刻只允许一个（`vite:preloadError` 与 `window.onerror` 可能同帧都来） */
let healing = false

/** 同一次失败会连发好几个事件（Vite 那个 + `lazy()` 抛出来的 reject）—— 这个窗口里只处理第一个 */
const HEAL_BURST_MS = 1000

/**
 * 命中一次分块加载失败 ⇒ **自愈一次**。
 *
 * ⚠️ 顺序是**先落标记 → 再上报 → 最后重载**：
 *    重载本身可能失败（浏览器拒绝 / 用户正好锁屏），**先报的那一条就留下了证据** ——
 *    而"老师卡在这一页"正是我们最需要看见的那一条。
 *    上报里带 `自愈=已重载`，所以这一条**不是故障**，是"这个老师踩过旧部署"的计数。
 *    ⚠️ 标记必须排在重载**之前**（反了就是无限刷新，见本文件上面那一段）。
 * ⚠️ 它**永不抛错**（正常情况下这个函数不会返回，因为页面已经去重载了）。
 */
export function recoverChunkFailure(failure: ChunkFailure): void {
  try {
    if (healing) return
    healing = true

    const d = failure ?? { message: '', url: '' }
    if (reloadAlreadyTried()) {
      /* ② 已经自愈过一次还是坏 ⇒ 走人话那一档（`ErrorBoundary` 里读 `selfHealFailed()`） */
      reportChunkFailure(d, '仍失败（已重载过 1 次）')
      return
    }
    /* ① 先落标记，再重载（顺序见本文件上面那一段：反过来就是无限刷新） */
    try {
      sessionStorage.setItem(RELOAD_MARK, '1')
    } catch {
      /* 写不进去（隐私模式）—— 照旧自愈一次 */
    }
    reportChunkFailure(d, '已重载')
    hardReload()
  } catch {
    /* 静默：自愈逻辑自己绝不能变成错误源 */
  } finally {
    /*
     * 🔴 **闸必须自己松开**（真机评审 2026-10-06 抓到的真 bug）：
     *    原来这里不松闸 ⇒ 只要**第一次重载被浏览器挡住**（内嵌 WebView 拒绝跳转是很常见的），
     *    `healing` 就永远是 `true` ⇒ 之后每一次事件都被当成"重复事件"直接丢掉 ⇒
     *    **那个老师这一整页从此再也不会自愈**，而屏上那句人话也不会出现
     *    （`ErrorBoundary` 那一侧只在他恰好点进某个页面时才会走到）。
     * ✅ 松开之后：同一次失败的连发事件由 `HEAL_BURST_MS` 那个窗口挡住，
     *    而**真正晚到的下一次失败**（下拉刷新 / 再点一次）仍然能自愈。
     * ⚠️ 不许用 `healing = false` 直接收尾 —— 那样同帧连发的第二个事件会**再重载一次**，
     *    等于把"只自愈一次"破掉。
     */
    setTimeout(() => {
      try {
        healing = false
      } catch {
        /* 忽略 */
      }
    }, HEAL_BURST_MS)
  }
}

/** 上屏之前要问的一句话："这次是不是已经自愈过了？"（`ErrorBoundary` 用它选那一档文案） */
export function selfHealFailed(): boolean {
  return reloadAlreadyTried()
}

/** 上报（**复用 `lib/errors.ts` 的那个封装，不另造一条链**）——失败一律静默 */
function reportChunkFailure(d: ChunkFailure, heal: string): void {
  try {
    const url = d.url || urlOf(d.message) || d.filename || '(分块名没拿到)'
    reportFrontendError({
      /*
       * 🔴 这一行的形状是**结构化的**（不是把原文丢上去）：错误码 / 阶段 / 自愈状态 /
       *    失败的分块 URL / 出错页面 / 前端版本号 —— 超管面板里一眼能读。
       * ⚠️ 这里**不带任何学生或老师个人信息**：姓名/班级/学号一个都没有
       *    （`reportFrontendError()` 自己那一层另有脱敏，见 `lib/errors.ts` 的文件头）。
       */
      message: `[${CHUNK_ERROR_CODE}][阶段=${CHUNK_PHASE}][自愈=${heal}][url=${url}][页面=${pagePath()}][版本=${APP_VERSION_LABEL}]`,
      stack: String(d.message ?? ''),
      view: pagePath(),
    })
  } catch {
    /* 静默：上报失败绝不许再抛 */
  }
}

function pagePath(): string {
  try {
    return typeof location === 'undefined' ? '' : location.pathname
  } catch {
    return ''
  }
}

/**
 * 接住这几类失败（**两个事件都要**，少一个就漏一半现场）：
 *   ① `vite:preloadError` —— Vite 官方那条：**动态 import 的分块拉不到**时由 preload
 *      helper 派发（升 Vite 也不会改名）。`preventDefault()` 是官方要求的：
 *      不接就等于让它在控制台里以未处理错误的样子再抛一遍。
 *   ② `error` / `unhandledrejection` —— 低版本 WebView 上那几种**不发 ①** 的走法
 *      （404 / Page Not Found / 模块脚本解析失败）。
 *
 * 🔴 **必须在 `createRoot()` 之前装**（所以在 `main.tsx` 的模块作用域里调）：
 *    React `lazy()` 失败时抛出来的那个 reject 比 `useEffect` 早得多 ——
 *    装在 effect 里的话，"第一次进这一页"那一半现场就永远接不住。
 *    先到先得还有一个好处：**自愈抢在 React 把那句话画上屏之前**
 *    ⇒ 老师看到的是"重载一下就进去了"，而不是先闪一个错误页。
 */
export function installChunkRecovery(): () => void {
  if (typeof window === 'undefined') return () => undefined

  const onPreloadError = (ev: Event) => {
    try {
      ev.preventDefault()
      const detail = ev as Event & { payload?: { message?: string; filename?: string } }
      const m = String(detail.payload?.message ?? '') || 'Failed to fetch dynamically imported module'
      recoverChunkFailure({ message: m, url: urlOf(m), filename: detail.payload?.filename })
    } catch {
      /* 静默 */
    }
  }

  const onGlobal = (ev: Event) => {
    try {
      const e = ev as ErrorEvent & { reason?: unknown }
      const raw = e.error ?? e.reason ?? e.message
      const msg =
        typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object' && 'message' in raw
            ? String((raw as { message?: unknown }).message ?? '')
            : ''
      /* ⚠️ 只认这一类：别的 JS 错误照旧走 `lib/errors.ts` 那三个入口（职责不重叠） */
      if (!isChunkFailure(msg)) return
      recoverChunkFailure({ message: msg, url: urlOf(msg), filename: e.filename })
    } catch {
      /* 静默 */
    }
  }

  try {
    window.addEventListener('vite:preloadError', onPreloadError)
    window.addEventListener('error', onGlobal as EventListener)
    window.addEventListener('unhandledrejection', onGlobal as EventListener)
  } catch {
    return () => undefined
  }
  return () => {
    try {
      healing = false
      window.removeEventListener('vite:preloadError', onPreloadError)
      window.removeEventListener('error', onGlobal as EventListener)
      window.removeEventListener('unhandledrejection', onGlobal as EventListener)
    } catch {
      /* 忽略 */
    }
  }
}
