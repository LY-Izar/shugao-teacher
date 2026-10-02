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

/** 壳那边（Electron preload / Capacitor 原生插件）暴露的能力。字段全部可选 —— 网页上整个对象不存在 */
interface ShellBridge {
  saveBlob?(filename: string, blob: Blob): Promise<'saved' | 'cancelled' | 'failed'>
  openInPlace?(filename: string, blob: Blob): Promise<unknown>
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