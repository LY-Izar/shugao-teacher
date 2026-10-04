/* ============================================================
   版本更新公告（前端这一份）—— 2026-10-04，施工单 `施工单-版本更新提示.md`
   ------------------------------------------------------------
   🔴 **权威在服务端**（`app/functions/api/_lib/release.ts`）：这个文件里的
      `validateReleaseForm()` 只用于**面板表单的即时校验与预览**，
      而"要不要提示、能不能关掉"的判据全都来自服务端那一位 `force`。
      ⚠️ 手打 `/api/admin/release` 的人绕不过服务端 —— 那边会**再判一次**。

   🔴 **两处实现必须逐字节相同的那一段叫"共享区"**（与 `maintenance.ts` ↔
      `_lib/maintenance.ts` 同一条理由：前端产物与 Pages Function 是两个构建目标，
      跨目录 import 会把两边绑死）。代价用 `nav-checks.mjs` 的**整段比对**补回来。

   🔴 **没有第二个轮询**（施工单 §二.4 原话「与维护共用同一次请求」）：
      两档公告跟着 `GET /api/status` 一起回来（`useMaintenance.ts` 的那一次取数），
      `useRelease.ts` 只做"取哪一档 + 我够不够新"的纯计算。
   ============================================================ */

import type { ShellPlatform, ShellRole } from './classroomShell'

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
   🔴🔴 共享区 —— 结束（下面这些是**前端专用**的）
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 这一次读数是怎么来的：
 *  · `ok`      —— 服务端那一块读到了（两档都是**结论**）；
 *  · `failed`  —— 服务端**读不到库**（按"没有公告"放行，但**不许**说成"已是最新"）；
 *  · `missing` —— 服务端回话里**没有这一段**（旧版服务端 / 没部署到这一版）。
 */
export type ReleaseRead = 'ok' | 'failed' | 'missing'

export type ReleaseSlots = {
  teacher: Release | null
  classroom: Release | null
  read: ReleaseRead
  /** 读不到时的原文（面板上要显示） */
  reason: string
}

export const RELEASE_SLOTS_UNKNOWN: ReleaseSlots = {
  teacher: null,
  classroom: null,
  read: 'missing',
  reason: '',
}

/**
 * `/api/status` 回话里的 `release` 块 → 两档公告。
 *
 * 🔴 **线上一档的字段名与数据库列名逐字相同**（`enabled/version/force/message/url_apk/url_exe`）
 *    —— 所以两边用的是**同一个** `releaseFromRow()`，不存在"第二种解析"。
 *    这也是 `nav-checks` 那条契约断言能成立的原因（列名 ↔ 字段名逐字一致）。
 */
export function releaseSlotsFromStatus(raw: unknown): ReleaseSlots {
  if (!raw || typeof raw !== 'object') {
    return {
      ...RELEASE_SLOTS_UNKNOWN,
      read: 'missing',
      reason: '服务端回话里没有 release 这一段（服务端还是旧版）',
    }
  }
  const o = raw as Record<string, unknown>
  const asRow = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined)
  return {
    teacher: releaseFromRow(asRow(o.teacher)),
    classroom: releaseFromRow(asRow(o.classroom)),
    read: o.read === 'failed' ? 'failed' : 'ok',
    reason: typeof o.reason === 'string' ? o.reason : '',
  }
}

/**
 * 我这一台属于**哪一档**（施工单 §一.5）。
 *
 * 🔴 判据只有这两条，**唯一实现在这里**：
 *    · 壳说是教室端（`appRole === 'classroom'`，exe 的 `additionalArguments` 带进来的）；
 *    · 或者就在 `/classroom` 这个路由上（教室端账号在浏览器里打开时走的就是它）。
 * ⚠️ 别在别处再写"路径里有没有 classroom"这种散判据。
 * ⚠️ 网页端（教师控制台）落在 `'teacher'` —— 施工单 §一.5 写的就是"网页端跟随教师端那一档"。
 */
export function releaseTargetOf(role: ShellRole, pathname: string): ReleaseTarget {
  if (role === 'classroom') return 'classroom'
  return pathname === '/classroom' ? 'classroom' : 'teacher'
}

/**
 * 「下载最新版」点出去是哪条链接（施工单 §一.5：**谁在用哪个端就点哪个**）。
 *
 * ⚠️ 手机 **只给 apk**、电脑**只给 exe** —— 拿错了那个包根本装不上，
 *    所以宁可**不给按钮**（返回空串）也不给错的。
 * ⚠️ 网页版（`platform === null`，含补 `platform` 之前的老 apk）：先电脑的，
 *    没有再给手机的 —— 教师控制台多数开在电脑上。
 */
export function pickReleaseUrl(r: Release, platform: ShellPlatform): string {
  if (platform === 'capacitor') return r.urlApk
  if (platform === 'electron') return r.urlExe
  return r.urlExe || r.urlApk
}

/**
 * 「我这一版够不够新」——**三态，不是两态**（施工单 §一.6：灰就是灰）。
 *
 *  · `behind`     —— 有公告、而且我比它旧 ⇒ **要提示**；
 *  · `uptodate`   —— 有公告、我这一版不比它旧（**真·已是最新**）；
 *  · `none`       —— 这一档没有公告；
 *  · `notnew`     —— 有公告，但版本号比不出来（写坏了）⇒ **没结论，不提示**；
 *  · `unreadable` —— 这一段没读到（旧服务端 / 读库失败）⇒ **没结论，不提示**。
 * ⚠️ 后两个**不许**合并进 `uptodate` —— "没结论"与"已是最新"在面板上是两种颜色。
 */
export type ReleaseCheck = 'behind' | 'uptodate' | 'none' | 'notnew' | 'unreadable'

/** 这一刻该怎么判（**只有这一处**算它） */
export function releaseCheck(
  slots: ReleaseSlots,
  target: ReleaseTarget,
  appVersion: string,
): ReleaseCheck {
  const notice = slots[target]
  if (slots.read !== 'ok') return 'unreadable'
  if (!notice) return 'none'
  const c = cmpVersion(appVersion, notice.version)
  if (c === null) return 'notnew'
  return c < 0 ? 'behind' : 'uptodate'
}
