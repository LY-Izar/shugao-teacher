/**
 * 版本更新公告的**纯逻辑**（服务端）—— 2026-10-04，施工单 `施工单-版本更新提示.md`。
 *
 * 🔴 **同一段逻辑在仓库里有两处，这是刻意的、并且被断言钉住的**：
 *    · 服务端（本文件）：**权威**。`/api/status` 与 `/api/admin/release` 用它；
 *    · 前端（`app/src/lib/release.ts`）：面板表单的即时校验、面板预览、
 *      以及客户端那一次"我这一版够不够新"的比较。
 *    ⚠️ 理由与 `maintenance.ts` ↔ `_lib/maintenance.ts` 逐字相同：前端产物与
 *      Pages Function 是两个构建目标，跨目录 import 会把两边绑死。
 *    ✅ 代价用**一条整段比对**的源码断言补回来（`nav-checks.mjs`）：
 *      下面那个"共享区"在两边必须**逐字节相同**（比逐行 grep 强：漏抄一行都红）。
 *
 * 🔴 三条口径（施工单 §一，别改）：
 *    · 比较依据是**版本号** `x.y.z`，不是构建哈希（哈希每次打包都变 ⇒ 天天喊更新）；
 *    · 读不到 / 形状不对 ⇒ **不拦**（fail-open），但**不许说成"已是最新"**；
 *    · **强制与选择性由服务端这一位决定**，客户端只决定"关不关得掉"。
 */

import { type Env, type Read, isMissing, read, svc } from './supa'

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴 共享区 —— 开始（前后端**逐字节相同**；`nav-checks` 抽出来比对）

   ⚠️ 这一段里**不许出现 import**、不许用 DOM / Node / Cloudflare 的任何 API ——
      它要能原样活在浏览器与 worker 两处。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 两档：教师端一档、教室端一档（施工单 §一.5；网页端跟随教师端那一档） */
export type ReleaseTarget = 'teacher' | 'classroom'

/** 两档的**唯一枚举**（面板渲染、服务端读两行、门禁遍历都用它） */
export const RELEASE_TARGETS = ['teacher', 'classroom'] as const

/**
 * 数据库里那一行的 `key`。
 * ⚠️ 主键仍是 `key` ⇒ **一档一行**，不是一列 `target`（施工单 §二.1：两张表 = 以后一定有一张忘了加列）。
 * 🔴 这两个字符串与 `supabase/schema.sql` §23.2.1 的种子行**逐字对应**（`nav-checks` 比对）。
 */
export const RELEASE_KEYS: Record<ReleaseTarget, string> = {
  teacher: 'release:teacher',
  classroom: 'release:classroom',
}

/** 版本号形状 —— 比较依据是它，**不是构建哈希**（施工单 §一.7） */
export const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/

/** 正文上限 24 字 / 标题上限 8 字（施工单 §三） */
export const RELEASE_NOTE_MAX = 24
export const RELEASE_TITLE_MAX = 8

/** 两种档位的标题（固定措辞，超管改不了 —— 面板里改的是正文） */
export const RELEASE_TITLE_SOFT = '有新版本'
export const RELEASE_TITLE_FORCE = '请更新到最新版'

/** 两种档位的**默认正文**（`message` 留空时用；`{v}` 换成版本号） */
export const RELEASE_NOTE_SOFT = 'v{v} 已发布，建议更新。'
export const RELEASE_NOTE_FORCE = 'v{v} 已发布，更新后可继续使用。'

/** 两个按钮（固定措辞；「稍后」只出现在选择性那一档） */
export const RELEASE_BTN_DOWNLOAD = '下载最新版'
export const RELEASE_BTN_LATER = '稍后'

/** 教室端那一档多一句：那块屏要**人工装一次**（施工单 §一.5，别让值班老师干等） */
export const RELEASE_CLASSROOM_HINT = '请在教师电脑上下载后，到这台机器安装。'

/**
 * 禁词表（施工单 §三 / `AGENTS.md` §七）。
 * 🔴 全是"AI 味"和"把系统弹窗写进公告"的词：**老师自己会点**，公告不许教人点，
 *    也不许把「未知来源」「SmartScreen」这类系统弹窗搬进正文。
 */
export const RELEASE_BANNED_WORDS = [
  '点击',
  '点这里',
  '请点击',
  '注意',
  '未知来源',
  'SmartScreen',
  '安装包',
  '哈希',
  '如遇问题',
  'vc',
] as const

/** 解析 `x.y.z`；形状不对 → `null`（**认不出就说认不出**，不许当 0） */
function parseVersion(s: string): number[] | null {
  const t = String(s ?? '').trim()
  if (!RELEASE_VERSION_RE.test(t)) return null
  return t.split('.').map(Number)
}

/**
 * 版本比较：`a` 比 `b` 新 → `1`；一样 → `0`；`a` 比 `b` 旧 → `-1`；**任一个形状不对 → `null`**。
 * ⚠️ `null` 由调用方决定怎么办：客户端那一侧一律**不提示**（fail-open，施工单 §一.6）。
 */
export function cmpVersion(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

/** 默认正文（把 `{v}` 换成版本号） */
export function releaseDefaultNote(version: string, force: boolean): string {
  return (force ? RELEASE_NOTE_FORCE : RELEASE_NOTE_SOFT).replace('{v}', String(version ?? '').trim())
}

/** 标题（按 `force` 选一句） */
export function releaseTitle(force: boolean): string {
  return force ? RELEASE_TITLE_FORCE : RELEASE_TITLE_SOFT
}

/** 链接只接受 `https://`（`javascript:` / `http:` / 空串一律不算；施工单 §六的安全口径） */
export function isReleaseUrl(s: string): boolean {
  return /^https:\/\/\S+$/i.test(String(s ?? '').trim())
}

/** 正文的禁词体检：命中的**第一个**词（没命中 → `null`） */
export function bannedWordIn(text: string): string | null {
  const t = String(text ?? '')
  for (const w of RELEASE_BANNED_WORDS) if (t.includes(w)) return w
  return null
}

/** 一条**正在发**的公告（服务端算好，客户端直接用） */
export type Release = {
  version: string
  force: boolean
  /** 公告正文（"空 → 默认文案"已在服务端补好，客户端**不再自己拼**） */
  note: string
  /** 下载直链；空串 = 这一端没有链接 ⇒ 公告里**不给按钮** */
  urlApk: string
  urlExe: string
}

/**
 * 数据库那一行 → 公告（`null` = **这一档没有公告**）。
 *
 * 🔴 两件事都判成"没有公告"，且**都往 fail-open 那一侧倒**（施工单 §一.6）：
 *    · `enabled !== true` —— 没在发；
 *    · `version` 形状不对 —— 写坏了的行**不许**拿去跟客户端比（比出来的结论是假的）。
 * ⚠️ 它**不判**"调用者那一版够不够新" —— 那要用客户端自己的 `APP_VERSION`，在客户端算。
 */
export function releaseFromRow(row: Record<string, unknown> | undefined): Release | null {
  if (!row || row.enabled !== true) return null
  const version = String(row.version ?? '').trim()
  if (!RELEASE_VERSION_RE.test(version)) return null
  const force = row.force === true
  const custom = String(row.message ?? '').trim()
  return {
    version,
    force,
    note: (custom || releaseDefaultNote(version, force)).slice(0, RELEASE_NOTE_MAX),
    urlApk: String(row.url_apk ?? '').trim(),
    urlExe: String(row.url_exe ?? '').trim(),
  }
}

/** 请求体里的 `target` 认不认得出（认不出 → 400，**不许默认成教师端**） */
export function isReleaseTarget(v: unknown): v is ReleaseTarget {
  return v === 'teacher' || v === 'classroom'
}

/** 面板表单（也是 `set` 请求体的归一化结果） */
export type ReleaseForm = {
  target: ReleaseTarget
  enabled: boolean
  version: string
  /** 🔴 必须**显式**给：`null` = 没选（施工单 §二.3「force 必须显式给布尔」） */
  force: boolean | null
  note: string
  urlApk: string
  urlExe: string
}

/** 落库要写的那几列（`enabled` 在接口里单写；`message` 就是 `note`） */
export type ReleaseRow = {
  version: string
  force: boolean
  note: string
  urlApk: string
  urlExe: string
}

export type ReleaseVerdict =
  | { ok: true; row: ReleaseRow }
  | { ok: false; rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5'; error: string }

/**
 * 发布前的校验（**服务端与前端各一份，逐字相同**）。
 *
 * ⚠️ 顺序是有意的：先"填得对不对"（R1/R2），再"文案"（R3/R4），最后"链接"（R5）。
 * 🔴 **关闭（`enabled=false`）只写 `enabled`** —— 其余字段留在库里当下次预填。
 *    这与维护那边"一关就把 `message` 清空"**刻意不同**：那边 `message` 只在开启时
 *    有意义，而这边"上次发的是哪个版本、链接是什么"不发的时候也是有用的默认值。
 */
export function validateReleaseForm(form: ReleaseForm): ReleaseVerdict {
  const version = String(form.version ?? '').trim()
  const note = String(form.note ?? '').trim()
  const urlApk = String(form.urlApk ?? '').trim()
  const urlExe = String(form.urlExe ?? '').trim()

  if (!form.enabled) {
    return { ok: true, row: { version, force: form.force === true, note, urlApk, urlExe } }
  }
  if (!RELEASE_VERSION_RE.test(version)) {
    return {
      ok: false,
      rule: 'R1',
      error: '版本号要写成 1.2.3 这样三段数字 —— 客户端按它跟自己的版本比，写别的比不出来',
    }
  }
  if (typeof form.force !== 'boolean') {
    return {
      ok: false,
      rule: 'R2',
      error: '强制更新还是选择性更新，得明确选一个 —— 没选就不知道该不该让人关掉',
    }
  }
  if (!note) {
    return { ok: false, rule: 'R3', error: '公告上要有一句话 —— 面板里预填的那句就够用' }
  }
  if (note.length > RELEASE_NOTE_MAX) {
    return {
      ok: false,
      rule: 'R3',
      error: `公告正文最多 ${RELEASE_NOTE_MAX} 字 —— 长了没人读`,
    }
  }
  const banned = bannedWordIn(note)
  if (banned) {
    return {
      ok: false,
      rule: 'R4',
      error: `公告里不许出现「${banned}」—— 系统自己会问、老师自己会点，公告不该教人点`,
    }
  }
  if (!isReleaseUrl(urlApk) && urlApk) {
    return { ok: false, rule: 'R5', error: '手机那个链接必须是 https:// 开头的' }
  }
  if (!isReleaseUrl(urlExe) && urlExe) {
    return { ok: false, rule: 'R5', error: '电脑那个链接必须是 https:// 开头的' }
  }
  return { ok: true, row: { version, force: form.force === true, note, urlApk, urlExe } }
}

/** 把请求体（前端传上来的原始 JSON）归一成 `ReleaseForm` */
export function releaseFormFromBody(body: Record<string, unknown>): ReleaseForm {
  return {
    target: isReleaseTarget(body.target) ? body.target : 'teacher',
    enabled: body.enabled === true,
    version: typeof body.version === 'string' ? body.version : '',
    force: typeof body.force === 'boolean' ? body.force : null,
    note: typeof body.note === 'string' ? body.note : '',
    urlApk: typeof body.urlApk === 'string' ? body.urlApk : '',
    urlExe: typeof body.urlExe === 'string' ? body.urlExe : '',
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴 下载地址 —— **与公告那一道闸门分开**（2026-10-04 用户拍板）
   ------------------------------------------------------------
   用户原话：「公告撤下了，下载也照样能用」。

   🔴 **一种语义**：这一块答的是"面板里那两个地址填了什么"，**不问**这一档
      是不是正在发公告。`enabled=false`（撤下）时库里那两列照旧留着
      （撤下**只写 `enabled`**，其余字段留作下次预填）⇒ 这一块照样给得出来。
   🔴 **公告正文仍然守闸门**：`version` / `force` / `message` 一律由
      `releaseFromRow()` 那一道判据决定出不出（未发布的草稿一个字都不外露）——
      这两个函数**各管各的**，别把它们合成一个。
   🔴 字段名与数据库列名**逐字相同**（`url_apk` / `url_exe`）——
      与公告那一份同一条理由：只有一种解析。
   ⚠️ 空串 = 面板里那一行没填 ⇒ 调用方**不摆**那一颗按钮（不是摆一颗点不动的）。
   ═══════════════════════════════════════════════════════════════════════════ */

/** 某一端的两个下载地址（面板里那两行，**不看是否在发公告**） */
export type ReleaseDownloads = {
  /** 手机（安卓）那一颗；空串 = 没填 */
  url_apk: string
  /** Windows 那一颗；空串 = 没填 */
  url_exe: string
}

/** 两端的下载地址（`/api/status` 的 `release.downloads`） */
export type PublicDownloads = {
  teacher: ReleaseDownloads
  classroom: ReleaseDownloads
}

/** 没填任何地址的那一份（调用方拿它当"摆不出按钮"的默认值） */
export const RELEASE_DOWNLOADS_EMPTY: ReleaseDownloads = { url_apk: '', url_exe: '' }

export const PUBLIC_DOWNLOADS_EMPTY: PublicDownloads = {
  teacher: RELEASE_DOWNLOADS_EMPTY,
  classroom: RELEASE_DOWNLOADS_EMPTY,
}

/**
 * 一行 → 这一端的下载地址（**`enabled` 是真是假都给**）。
 *
 * 🔴 与 `releaseFromRow()` 的唯一区别就是这里**没有** `enabled !== true → null`
 *    那一条 —— 那一条管的是"公告弹不弹"，不该管"下载能不能用"。
 * ⚠️ 它**不判**链接形状（`isReleaseUrl` 在客户端那一份里过滤）——
 *    面板写入那一路已经校验过了（R5），这里再判一次就是第二种口径。
 */
export function releaseDownloadsFromRow(
  row: Record<string, unknown> | undefined,
): ReleaseDownloads {
  if (!row) return RELEASE_DOWNLOADS_EMPTY
  return {
    url_apk: String(row.url_apk ?? '').trim(),
    url_exe: String(row.url_exe ?? '').trim(),
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   🔴🔴 共享区 —— 结束（下面这些是**服务端专用**的）
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 读一档要用的列。
 * 🔴 与 `schema.sql` §23.2.1 加的那几列**逐字对应**（`nav-checks` 拿它比对 schema ——
 *    "两边各写一套"这个项目栽过，这里用一条断言钉住）。
 */
export const RELEASE_SELECT_COLS = 'key,enabled,message,version,force,url_apk,url_exe'

/**
 * 从查询结果里**按 `key` 挑**出指定那一档。
 *
 * 🔴 **不许写 `rows[0]`**：真 PostgREST 会按 `key=eq.…` 过滤，但
 *    （a）假库（`admin-checks.mjs`）**不过滤**、（b）任何"多回了一行"的意外，
 *    都会让这一档读成**另一档** —— 那是一张发错端的公告。
 */
export function pickReleaseRow(
  rows: Record<string, unknown>[],
  target: ReleaseTarget,
): Record<string, unknown> | undefined {
  return rows.find((r) => String(r?.key ?? '') === RELEASE_KEYS[target])
}

/** 读一档那一行（两档各一次 `eq` 查询：**不用 `in.(…)`** —— 那种语法一旦写错
 *  只会在真库上回 400，而假库"不过滤"会把这类错误藏住）。 */
export async function loadReleaseRow(env: Env, target: ReleaseTarget): Promise<Read> {
  return read(
    await svc(
      env,
      `/rest/v1/site_state?select=${RELEASE_SELECT_COLS}&key=eq.${encodeURIComponent(RELEASE_KEYS[target])}`,
    ),
  )
}

/**
 * 一行 → **给客户端的那一份**（`null` = 这一档没有公告）。
 *
 * 🔴 字段名与数据库列名**逐字相同**（`enabled` / `version` / `force` / `message` /
 *    `url_apk` / `url_exe`）⇒ 客户端用的是**同一个** `releaseFromRow()`，
 *    不存在"第二种解析"（`nav-checks` 有一条契约断言钉着这件事）。
 * 🔴 判据只有 `releaseFromRow` 那一处（没在发 / 版本号写坏了 → `null`）——
 *    所以**没发布的字段（上次填的版本号、链接）不会漏给匿名调用者**
 *    （`/api/status` 是匿名可读的，多回一个字段都是泄露面）。
 */
export function publicReleaseRow(
  row: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const r = releaseFromRow(row)
  if (!r) return null
  return {
    enabled: true,
    version: r.version,
    force: r.force,
    message: r.note,
    url_apk: r.urlApk,
    url_exe: r.urlExe,
  }
}

/**
 * 一行 → 挂进 `release` 块的 **`downloads` 子块**（2026-10-04）。
 *
 * 🔴 **它与上面那个 `null` 无关**：`publicReleaseRow()` 回 `null`（撤下 / 版本号写坏）
 *    时，这一块**照样要把库里存着的地址给出去**。
 * 🔴 字段名与列名逐字相同（`url_apk` / `url_exe`）⇒ 客户端用**同一个**
 *    `releaseDownloadsFromRow()` 解析（`nav-checks` 的契约断言也钉它）。
 * ⚠️ **这一块里只有地址**：`version` / `force` / `message` 一个字都不许混进来 ——
 *    否则"未发布的草稿不外露"那条口径就被这一块绕过去了。
 */
export function publicDownloadsBlock(
  row: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const d = releaseDownloadsFromRow(row)
  return { url_apk: d.url_apk, url_exe: d.url_exe }
}

export type PublicReleases = {
  read: 'ok' | 'failed'
  reason: string
  teacher: Record<string, unknown> | null
  classroom: Record<string, unknown> | null
  /**
   * 🆕 两端的下载地址（`GET /api/status` 的 `release.downloads`）。
   * 🔴 **读库成功就给**，与"这一档是不是在发公告"无关 —— 用户
   *    2026-10-04 拍板的那一条就落在这个字段上（公告撤下不影响下载）。
   */
  downloads: PublicDownloads
}

/** 第 23 段 §23.2.1 还没跑时要说的那句话（列与种子行都在那一段里） */
export const NEED_RELEASE_SQL =
  '数据库还没有版本更新那一块（仓库里 supabase/schema.sql 第 23 段 §23.2.1：' +
  '四列 + 两行 key=release:* 的种子）。到 Supabase → SQL Editor 跑一遍再回来；' +
  '刚跑完的话等十几秒让接口刷新一下缓存。'

/**
 * 读两档公告（`GET /api/status` 用）。
 *
 * 🔴 **读不到不抛错、也不锁人**（fail-open，施工单 §一.6）：回 `read:'failed'` + 原因，
 *    调用方照常 200 —— 一次接口抖动不能让全校进不去。
 * 🔴 它**与维护那一次读分开**（两次 `eq` 查询）：合成一次的话，维护状态会被
 *    版本公告那一侧的读失败连累 —— fail-open 的爆炸半径越小越好。
 */
export async function loadPublicReleases(env: Env): Promise<PublicReleases> {
  try {
    const t = await loadReleaseRow(env, 'teacher')
    const c = await loadReleaseRow(env, 'classroom')
    const bad = [t, c].find((r) => !r.ok)
    if (bad) {
      return {
        teacher: null,
        classroom: null,
        downloads: PUBLIC_DOWNLOADS_EMPTY,
        read: 'failed',
        reason: isMissing(bad) ? NEED_RELEASE_SQL : `读版本公告失败：${bad.text.slice(0, 200)}`,
      }
    }
    const tRow = pickReleaseRow(t.rows, 'teacher')
    const cRow = pickReleaseRow(c.rows, 'classroom')
    return {
      read: 'ok',
      reason: '',
      teacher: publicReleaseRow(tRow),
      classroom: publicReleaseRow(cRow),
      /* 🔴 **读得到库就给地址**（哪怕两档都没在发公告）—— 这一行就是
         「公告撤下了，下载也照样能用」那一条的落点。 */
      downloads: {
        teacher: releaseDownloadsFromRow(tRow),
        classroom: releaseDownloadsFromRow(cRow),
      },
    }
  } catch (e) {
    return {
      teacher: null,
      classroom: null,
      downloads: PUBLIC_DOWNLOADS_EMPTY,
      read: 'failed',
      reason: `读版本公告失败（连不上数据库）：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
