/* ============================================================
   文件导出收拢 —— 全站**唯一**允许碰「把文件写到磁盘」的地方
   ============================================================

   为什么要有这一层（2026-10-02 实测出来的，不是设想的）
   --------------------------------------------------------
   改造前，「导出一个文件」这件事在**五个文件里各抄了一遍**，逐行同构：

     lib/docxWrite.ts:228    downloadBlob   revoke 30s
     lib/homeworkImage.ts:145downloadBlob   revoke 10s   ← 同名副本
     lib/backup.ts:735       downloadJson   revoke 30s
     lib/localStore.ts:86    saveToDisk     revoke 60s
     lib/localStore.ts:99    openLocal      revoke 60s   ← 不是存盘，是「就地打开」
     pages/GradeSetup.tsx:770 内联（无函数名）立即 revoke  ← 唯一最脆的一个

   连**回收延迟都不统一**（10 / 30 / 30 / 60 秒）—— 这是复制粘贴漂移的证据。

   🔴 而这一套写法**在壳里是不成立的**：
     · Electron：`a.download` 落进下载目录、**不弹"另存为"**（老师的反应是"我文件呢？"）
     · Android WebView：**根本不触发**（实测/推断见打包计划 §二.5）

   所以收拢到这一层，各平台各走各的，**网页那一支逐字照抄原实现**（行为零变化）。

   🔴 分派判据必须是「桥接对象在不在」
   --------------------------------------------------------
   网页版里 `window.__shell_out` **压根不存在** → 自动落回原来的 `<a download>`，
   于是同一份业务代码在网站与壳里都能跑，且**网站行为逐字不变**。

   ⚠️ **不许写成「有没有 Capacitor」** —— 那种判据在网页上也可能误判成"有壳"，
   结果就是网页分支被壳的代码接管，而那里根本没有壳。
   ============================================================ */

/**
 * 壳侧「下载完调起系统安装器」的回话（**只有 apk 新壳会回**）。
 *   · `ok:true` —— 系统安装界面已经起来了
 *   · `ok:false` + `needPermission:true` —— 这一来源还没被允许装应用（Android 8+）
 *   · `ok:false` + `why` —— 下载/安装没成，`why` 是**能给人看**的话
 */
export interface ShellInstallResult {
  ok?: boolean
  needPermission?: boolean
  why?: string
  unsupported?: boolean
}

/** 壳那边（Electron preload / Capacitor 原生插件）暴露的能力。字段全部可选 —— 网页上整个对象不存在 */
interface ShellBridge {
  saveBlob?(filename: string, blob: Blob): Promise<'saved' | 'cancelled' | 'failed'>
  openInPlace?(filename: string, blob: Blob): Promise<unknown>
  /*
   * 🔴 内置备份文件夹那两个（2026-10-03 施工单 §1）。
   *   ⚠️ **方法名不许改** —— 打包那一侧（`_src/desktop/shell-ipc.mjs`）是照着
   *   这两个名字写的，改了它那边就断。
   *   · saveToBackupDir 返回 `{ok:true, path}` 或 `{ok:false, why}`
   *   · backupDir 返回**真绝对路径**，拿不到返回 null
   */
  saveToBackupDir?(filename: string, blob: Blob): Promise<{ ok: boolean; path?: string; why?: string }>
  backupDir?(): Promise<string | null>
  /*
   * 🔴 **应用内更新：下载完调起系统安装器**（2026-10-05 施工单 `施工单-版本更新提示.md` §八）。
   *   ⚠️ **方法名不许改** —— apk 那一侧的桥接（`_src/shell-bridge-apk.js`）与原生插件
   *   （`YlxbNativePlugin.downloadAndInstall`）是照着这个名字接的，改了它那边就断。
   *   ⚠️ **只有 apk 的新壳有这两个**：两个 exe 与网页版**都没有** ⇒ `canDownloadAndInstall()`
   *   恒 false ⇒ 调用方照旧走"打开那个 https 链接"，行为一字不变。
   */
  downloadAndInstall?(url: string): Promise<ShellInstallResult>
  openInstallPermissionSettings?(): Promise<boolean>
}

function shell(): ShellBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __shell_out?: ShellBridge }
  return w.__shell_out ?? null
}

/** 现在是不是在壳里跑（界面文案、报错分支偶尔要用） */
export function inShell(): boolean {
  return shell() !== null
}

export type SaveResult = 'saved' | 'cancelled' | 'failed'

/**
 * `openInPlace` 的结局。
 *
 * 🔴 为什么**必须有**这个返回值（2026-10-03）：壳那一支有真实的失败可能
 * （系统没有能打开这个类型的程序 —— 教室端那台机器上**真的会遇到**），
 * 而调用方原先拿到的是 `void` ⇒ 点了没反应，界面也不会说为什么。
 *
 * ⚠️ `'opened'` 在**网页那一支**是"没在壳里、没报错"，**不是**"确认打开了"
 *    —— 浏览器不给这种反馈。这与 `SaveResult` 里网页支恒为 `'saved'` 同理。
 */
export type OpenResult = 'opened' | 'failed'

/**
 * 🔴 把一个 Blob 存到磁盘。
 *
 * - **壳**：走 `dialog.showSaveDialog`（弹"另存为"）或原生写文件
 * - **网页**：`<a download>`，**下面那段逐字照抄**（来自 `localStore.ts` 那份 ——
 *   六处里回收最慢、最保守的一份，取它）
 *
 * @returns 网页这一支恒为 `'saved'`（浏览器不给反馈）；壳那一支会区分用户取消
 */
export async function saveBlob(filename: string, blob: Blob): Promise<SaveResult> {
  const s = shell()
  if (s?.saveBlob) return s.saveBlob(filename, blob)

  /*
   * 🔴🔴 **壳里但没有 `saveBlob`（= apk）—— 不许继续报 `'saved'`**（2026-10-04）
   *
   * apk 的桥接（`_src/shell-bridge-apk.js`）只有 appRole / notify 那几个，
   * **没有 `saveBlob`** ⇒ 掉到下面那条 `<a download>` 分支，而：
   *   · 本文件头 `fileOut.ts:20` 记着「Android WebView 里**根本不触发**」
   *   · `_tools/preflight.mjs:124` 记着同一条
   *   · 而下面那条分支**恒回 `'saved'`**（浏览器不给反馈）
   * ⇒ apk 上点「导出备份文件」→ 屏上「**已导出：…**」，而**可能一个文件都没写**。
   *   🔴 这是 `97cf3fd` 的同款：**失败被返回值抹平**。
   *
   * ⚠️🔴 **为什么宁可报失败也不报成功（这个不对称是刻意的）**：
   *   · 报假**成功** = 老师以为手上有备份、于是不再备份 ⇒ **需要恢复那天才发现没有**
   *   · 报假**失败** = 老师多换一种方式导一次 ⇒ 顶多麻烦
   *   备份这条路上，"以为有"比"以为没有"危险得多。
   *
   * ⚠️ **这是推断、不是真机实测**（项目还欠着"apk 无真机"）。
   *   反向条件写清楚，免得后人当成实测结论：
   *   **若哪天真机证明 WebView 里 `<a download>` 其实能存，
   *   就把这一支删掉、走下面的网页分支并回 `'saved'`。**
   */
  if (s) return 'failed'

  // ⚠️ 网页分支：逐字照抄，**不许"顺手优化"**
  //（改 `a.remove()`、改回收时长、把 setTimeout 去掉 —— 每一个都是改网页行为）
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 延迟回收：立刻 revoke 会让大图还没开始下就失效（这个坑踩过，延迟是必须的）
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'saved'
}

/**
 * 🔴 **第二种能力，不是存盘**：把文件**就地打开**看。
 *
 * 对应 `localStore.ts` 的 `openLocal()`。它不能合并进 `saveBlob`：
 *   · 网页：`window.open(blobUrl)` —— 能看
 *   · Electron：新开一个窗口，**没有 Electron 的能力**（preload 没了、样式可能丢、点不了）
 *   · Android WebView：`window.open` 被拦、`blob:` 又跨源 → **什么都不发生**（静默失败）
 */
export async function openInPlace(filename: string, blob: Blob): Promise<OpenResult> {
  const s = shell()
  if (s?.openInPlace) {
    // 🔴🔴 **返回值不许扔**（2026-10-03 补，之前是 `await` 完直接 `return`）：
    //    壳侧 `shell-ipc.mjs` 的 openInPlace 有三种结局 ——
    //      'opened' / 'failed' / 抛异常，
    //    而教室端那台机器上「某个 .png 没有系统程序能打开」是**真的会发生的**。
    //    把返回值丢掉的后果：老师点了**什么都不会发生**，而界面**不会告诉他为什么**
    //    —— 这正是项目硬规矩「不可写的路径要显式报错」要防的那种静默。
    //
    // ⚠️ 这里**故意不回退到网页那一支**：网页分支是 `window.open(blobUrl)`，
    //    在壳里会新开一个**没有 Electron 能力的浏览器窗口**（样式全丢、点不了）——
    //    那才是更坏的结局（见 preload.js 里 openInPlace 上面那段说明）。
    //    失败就明确返回 'failed'，让调用方决定要不要提示"要不要改成另存为"。
    const r = await s.openInPlace(filename, blob)
    return r === 'opened' ? 'opened' : 'failed'
  }

  // 网页分支：与原 `openLocal` 逐字一致
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  // ⚠️ 网页这一支**恒为 'opened'**：浏览器不给反馈（`window.open` 被弹窗拦截也
  //    不会告诉你）。**不是**"确认打开了"，只是"没在壳里、不该报失败"。
  return 'opened'
}

/**
 * 把一个值序列化成 JSON 再存盘。
 * 单独留一个是因为 `backup.ts` 的 `downloadJson` 原来自己造 Blob ——
 * 收拢之后**它也走同一条路**，于是备份文件在壳里同样能真正落到磁盘上。
 */
export function saveJson(filename: string, data: unknown): Promise<SaveResult> {
  return saveBlob(filename, new Blob([JSON.stringify(data)], { type: 'application/json' }))
}

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴🔴 **内置备份文件夹** —— exe 自带一个目录，装上就写（2026-10-03 施工单 §1）
   ------------------------------------------------------------------------
   为什么非有它不可（不是"少个功能"，是**一个静默到没人发现的故障**）：

     教室里那台大屏**经常没有键鼠**，而"选备份文件夹"走的是网页的
     `showDirectoryPicker()` —— **必须有人点一次**，浏览器重启后还会掉权限。
     结果教室端 exe 在**没人点过文件夹**的机器上，5 分钟一次的自动备份
     一直落在 `whyNoFolder()` 那条分支 —— **一直在写、其实一份都没写**，
     而教师看到的是「自动备份开着呢」。
     → exe 自带一个备份文件夹：**装上就写，不需要任何人授权**。

   ⚠️ **apk 没有这一条**（Android WebView 没有"文件系统"这个概念）——
     `hasBuiltinBackupDir()` 在那里恒为 false，于是照旧走「选文件夹 / 手动导出」那条路。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 这一支壳**带**不自带备份文件夹 */
export function hasBuiltinBackupDir(): boolean {
  return typeof shell()?.saveToBackupDir === 'function'
}

/**
 * 内置备份文件夹的**真绝对路径** —— 界面要把它显示给老师看（能照着去 U 盘拷走）。
 * 🔴 拿不到（网页版 / apk / 三处都写不进去）一律返回 `null`，**不许返回相对路径或空串**。
 */
export async function builtinBackupDir(): Promise<string | null> {
  const s = shell()
  if (!s?.backupDir) return null
  try {
    const p = await s.backupDir()
    return p && typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}

/**
 * 写一份**到内置备份文件夹**（同名覆盖，不轮转 —— 用户原话「只有一份就一份」）。
 *
 * @returns `{ ok:true, path }` / `{ ok:false, why }`（`why` 是**能给人看**的话）。
 *   ⚠️ **不许失败就 `return false`** —— 自动备份是后台定时器，拿到 false 什么也不显示，
 *   教师会一直以为在写，直到真需要恢复那天（这是本文件存在的头号理由）。
 */
export async function saveToBuiltinBackupDir(
  filename: string,
  data: unknown,
): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const s = shell()
  if (!s?.saveToBackupDir) return { ok: false, why: '这一份没有内置备份文件夹。' }
  try {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const r = await s.saveToBackupDir(filename, blob)
    if (r?.ok === true && r.path) return { ok: true, path: r.path }
    return { ok: false, why: r?.why ?? '备份文件夹写不进去。' }
  } catch (e) {
    return {
      ok: false,
      why: e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '备份文件夹写不进去。',
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴 **应用内更新：下载完调起系统安装器**（2026-10-05 施工单 §八）
   ------------------------------------------------------------------------
   用户报的：手机上点更新公告里的「下载最新版」，**浏览器下载完就完了** ——
   老师还得自己去「文件管理」里翻出那个 apk 才装得上。

   apk 的新壳有这条能力（原生下载到私有目录 → FileProvider → 系统安装界面）；
   **两个 exe 与网页版都没有** ⇒ `canDownloadAndInstall()` 恒 false ⇒
   调用方（`components/ReleaseGate.tsx`）照旧走原来的 `<a href target="_blank">`，
   **一个字都不变**（网页版与两个 exe 的那条路是刻意留着的）。

   ⚠️ 三条物理边界（谁也别指望"自动装好"）：
     · Android **不许静默安装** ⇒ 最多弹到系统安装界面，老师仍要点两下；
     · Android 8+ 要用户对这个来源**单独授权**「安装未知应用」⇒ 没授权时回
       `needPermission:true`，由调用方**说一句人话**并引导去设置（§三.5：不许静默失败）；
     · **真机未验**（本机没有安卓设备）—— 这段只做过静态自检，真机验收只能由用户做。
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 这一支壳**带**"下载完调起安装器"吗？（apk 新壳 true；网页版 / 两个 exe / 老 apk false）
 *
 * ⚠️ 判据一律是"**桥接对象上这个方法在不在**"，不是"有没有 Capacitor" ——
 *    与 `saveBlob` 那一段同一个理由（见本文件头）。
 */
export function canDownloadAndInstall(): boolean {
  return typeof shell()?.downloadAndInstall === 'function'
}

/**
 * 让壳把安装包下下来并**调起系统安装界面**。
 *
 * 拿不到这个方法（网页版 / 两个 exe / 老 apk）→ `{ ok:false, unsupported:true }`，
 * 调用方据此**保持原来的行为**（把那个 https 链接交给浏览器）。
 */
export async function downloadAndInstall(url: string): Promise<ShellInstallResult> {
  const s = shell()
  if (!s?.downloadAndInstall) return { ok: false, unsupported: true }

  /*
   * ⚠️ 这里**不许把失败咽掉**：老师点完什么都不发生 = 这一轮要修的那个毛病本身。
   *    `why` 拿不到就给一句能给人看的话（空字符串会被界面当成"没话说"）。
   */
  try {
    const r = await s.downloadAndInstall(url)
    if (r?.ok === true) return { ok: true }
    return {
      ok: false,
      needPermission: r?.needPermission === true,
      why: r?.why || '没下下来。',
    }
  } catch (e) {
    return {
      ok: false,
      why: e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : '没下下来。',
    }
  }
}

/** 打开「安装未知应用」那一页（没授权时引导老师去开；拿不到这个方法就回 false） */
export async function openInstallPermissionSettings(): Promise<boolean> {
  const s = shell()
  if (!s?.openInstallPermissionSettings) return false
  try {
    return (await s.openInstallPermissionSettings()) === true
  } catch {
    return false
  }
}