/**
 * 插件库（GitHub）读写 + **服务端探针** —— `/api/admin/plugins/*` 共用。
 *
 * ============================================================
 * 为什么这些判断必须在服务端
 * ============================================================
 * 面板上的"探针通过"如果由浏览器算出来，改一下 JS 就能让它全绿，然后超管照着一个
 * 假的绿点发布 —— 那比没有探针更糟。所以 manifest 校验、指纹重算、禁区扫描**就这一份**，
 * 在 Cloudflare 里跑；浏览器只负责把结果显示出来。
 *
 * ⚠️ 与浏览器侧的 `src/lib/pluginHost.ts` 是**同一套判据的两份实现**（前者给插件运行时，
 *    后者给发布闸门，两边的运行环境不同没法共享模块）。两边必须同判 —— 门禁
 *    `plugin-framework-checks` 里有对照样例，改一处要想着另一处。
 *
 * ============================================================
 * 环境变量
 * ============================================================
 *   PLUGIN_REPO        形如 `LY-Izar/shugao-plugins`（公开仓库）
 *   PLUGIN_REPO_TOKEN  **只读** fine-grained token（Contents: Read）。
 *                      不配也能读公开仓库，但匿名限额 60 次/小时/IP，而 Cloudflare 出口 IP
 *                      是共享的 ⇒ 生产上迟早撞 403，所以配上是正常形态。
 */

import { type Env as BaseEnv, json } from './supa'
import { READ_TABLE_MIRROR } from './pluginTables'

export type PluginEnv = BaseEnv & {
  PLUGIN_REPO?: string
  PLUGIN_REPO_TOKEN?: string
}

export const NEED_PLUGIN_REPO =
  '服务端还没配插件库。到 Cloudflare Pages → Settings → Variables and secrets 添加 ' +
  'PLUGIN_REPO（Text，形如 LY-Izar/shugao-plugins），然后重新部署。'

export const NEED_PLUGIN_TOKEN_HINT =
  '读 GitHub 被限流或拒绝（匿名每小时 60 次）。到 Cloudflare 加 PLUGIN_REPO_TOKEN（Secret，只读 Contents），然后重新部署。'

function repo(env: PluginEnv): string {
  return (env.PLUGIN_REPO ?? '').trim()
}

function ghHeaders(env: PluginEnv): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'shugao-pages',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const t = (env.PLUGIN_REPO_TOKEN ?? '').trim()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

/** GitHub 错误统一翻成能看懂的话（哪一步、为什么），别把 403 原样甩给超管 */
async function gh(env: PluginEnv, path: string): Promise<{ ok: true; data: unknown } | { ok: false; why: string; status: number }> {
  const r = repo(env)
  if (!r) return { ok: false, why: NEED_PLUGIN_REPO, status: 503 }
  const res = await fetch(`https://api.github.com/repos/${r}${path}`, { headers: ghHeaders(env) })
  if (res.ok) return { ok: true, data: await res.json() }
  const text = await res.text().catch(() => '')
  if (res.status === 404) return { ok: false, why: `插件库里找不到：${path}`, status: 404 }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, why: NEED_PLUGIN_TOKEN_HINT, status: 403 }
  }
  return { ok: false, why: `GitHub 回了 ${res.status}：${text.slice(0, 120)}`, status: 502 }
}

/* ============================================================================
   一、列待审分支
   ============================================================================ */

export type PendingPlugin = {
  id: string
  branch: string
  commit: string
  /** 该分支 HEAD 的提交说明（"1.2.0：修了 XX"） */
  message: string
  /** 该提交的时间（ISO） */
  at: string
}

/**
 * 从分支名推出**插件 id**（`plugin/<id>`）。
 *
 * 🔴 2026-10-25 修（面板上真踩到）：有人把分支开成了 `plugin/ruofeng.class-attendance-2.0.4`
 *    —— 带了个版本尾巴。原来直接 `slice('plugin/'.length)` 当 id ⇒ `ruofeng.class-attendance-2.0.4`
 *    不合命名空间正则 ⇒ 面板只写一句「插件 id 不合法」，**检查都点不了**，那个人的 PR 就卡住了。
 *    而分支里的目录其实还叫 `plugins/ruofeng.class-attendance`（目录名才是 id）。
 *
 * 规则（宽进严出，宁可多认一种写法，也不要让人卡在分支命名上）：
 *  ① 原名就合法 ⇒ 用它；
 *  ② 去掉末尾的 `-1.2.3` 之后合法 ⇒ 用去掉后的；
 *  ③ 都不合法 ⇒ 原样返回（面板照旧会报"不合法"，那是真不该猜的情况）。
 * ⚠️ 只认 `-主.次.修` 这一种尾巴；别加"去掉任何后缀"这种模糊规则 —— 那会把
 *    `a.b-c` 与 `a.b` 认成同一个插件。
 */
export function pluginIdFromBranch(branch: string): string {
  const raw = branch.startsWith('plugin/') ? branch.slice('plugin/'.length) : branch
  if (ID_RE.test(raw)) return raw
  const noVer = raw.replace(/-\d+\.\d+\.\d+$/, '')
  return ID_RE.test(noVer) ? noVer : raw
}

/**
 * `plugin/<id>` 分支 = 待审的插件。**一个插件一个分支**（交接文档 / 插件库 README）
 * ⇒ 同一个 id 出现多次是不可能的；出现多次说明有人乱建分支，这里**如实全列**，
 * 让人看见，而不是替它挑一个。
 */
export async function listPending(env: PluginEnv): Promise<{ ok: true; rows: PendingPlugin[] } | { ok: false; why: string; status: number }> {
  const r = await gh(env, '/branches?per_page=100')
  if (!r.ok) return r
  const branches = (r.data as Array<{ name: string; commit: { sha: string } }>) ?? []
  const mine = branches.filter((b) => b.name.startsWith('plugin/'))
  const rows: PendingPlugin[] = []
  for (const b of mine) {
    /* 分支名 → 插件 id：有人会写成 `plugin/<id>-<版本>`，见 `pluginIdFromBranch` 的注释 */
    const id = pluginIdFromBranch(b.name)
    let message = ''
    let at = ''
    const c = await gh(env, `/commits/${b.commit.sha}`)
    if (c.ok) {
      const cm = c.data as { commit?: { message?: string; committer?: { date?: string } } }
      message = (cm.commit?.message ?? '').split('\n')[0].slice(0, 120)
      at = cm.commit?.committer?.date ?? ''
    }
    rows.push({ id, branch: b.name, commit: b.commit.sha, message, at })
  }
  return { ok: true, rows }
}

/* ============================================================================
   二、按 commit 取三件套
   ============================================================================ */

export type PluginFiles = {
  id: string
  commit: string
  manifest: Record<string, unknown>
  entry: string
  indexSource: string
  /** 仓库里 `index.js.sha256` 写的值（可能跟实际不符 —— 那正是要查的） */
  declaredSha: string
  /** 服务端对取到的 index.js 真算出来的值 */
  actualSha: string
}

async function fetchFile(env: PluginEnv, id: string, ref: string, name: string): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const r = await gh(env, `/contents/plugins/${encodeURIComponent(id)}/${name}?ref=${ref}`)
  if (!r.ok) return { ok: false, why: `取不到 ${name}：${r.why}` }
  const d = r.data as { content?: string; encoding?: string }
  if (!d?.content) return { ok: false, why: `${name} 是空文件或不是普通文件` }
  try {
    const bin = Uint8Array.from(atob(d.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))
    return { ok: true, text: new TextDecoder().decode(bin) }
  } catch {
    return { ok: false, why: `${name} 解码失败` }
  }
}

/** 指纹按**字节**算（与 CI 同口径：`sha256(index.js 原文)`） */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchPlugin(env: PluginEnv, id: string, ref: string): Promise<{ ok: true; files: PluginFiles } | { ok: false; why: string }> {
  if (!/^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9-]{2,31}$/.test(id)) {
    return { ok: false, why: `插件 id 不合法：${id}` }
  }
  const mf = await fetchFile(env, id, ref, 'manifest.json')
  if (!mf.ok) return mf
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(mf.text) as Record<string, unknown>
  } catch {
    return { ok: false, why: 'manifest.json 不是合法 JSON' }
  }
  const entry = typeof manifest.entry === 'string' && manifest.entry.trim() ? manifest.entry : 'index.js'
  const src = await fetchFile(env, id, ref, entry)
  if (!src.ok) return src
  const shaFile = await fetchFile(env, id, ref, 'index.js.sha256')
  const declaredSha = shaFile.ok ? (shaFile.text.trim().split(/\s+/)[0] ?? '') : ''
  return {
    ok: true,
    files: {
      id,
      commit: ref,
      manifest,
      entry,
      indexSource: src.text,
      declaredSha,
      actualSha: await sha256Hex(src.text),
    },
  }
}

/* ============================================================================
   三、静态探针（能静态判的那些；运行期仍由提交方自检）
   ============================================================================ */

export type CheckLine = {
  id: string
  name: string
  ok: boolean
  detail?: string
  /** 检查行下面的一行小字（CF-12 用它显示"壳 ≥ x · 能力 n 项"） */
  hint?: string
}

const ID_RE = /^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9-]{2,31}$/
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
/** 与手册 §5 同一份枚举 */
export const PERMS = [
  'storage',
  'data.roster',
  'data.schedule',
  'data.dailyHomework',
  'data.duty',
  'data.assignments',
  'data.quote',
  'config',
  'clock',
  'bus',
  'sound',
  'pip',
  'files',
  'keepAwake',
  'write',
  /*
   * 🆕 2026-10-25：逐张读目录允许的表（manifest.reads，最多 12 张）。
   * 与 `src/lib/pluginHost.ts` 的 PLUGIN_PERMISSIONS 是同一套枚举 ——
   * 少这一项，所有声明 read 的插件都会被 CF-05 判红。
   */
  'read',
] as const

/**
 * 🆕 可写业务表白名单（2026-10-24 用户拍板「开通用写入但必须可审计」）。
 * ⚠️ 与 `src/lib/pluginHost.ts` 的 `WRITABLE_TABLES` **同一份** —— 服务端独立判一次，
 *    不能只信客户端。加表两处一起加。
 */
export const WRITABLE_TABLES = [
  'schedule_items',
  'classes',
  'students',
  'class_subjects',
  'assignments',
  'daily_homework',
  'duty_assignments',
  'school_calendar',
  'school_calendar_events',
  'calls',
  'shared_files',
  'exams',
  'score_rows',
  'wrongbook',
] as const

/**
 * 表 → **平台里的哪个功能**（给超管看的那一列）。
 * 用户原话：「审核探针里面写清楚这个插件要动哪些表，这些表对应的数据是哪些功能调用的」。
 * 漏登记的会显示「（未登记功能）」—— 那比不显示更醒目，是刻意的。
 */
export const TABLE_FEATURE: Record<string, string> = {
  schedule_items: '课表 / 日程（我的日程表、班级课表）',
  classes: '班级档案',
  students: '学生名单',
  class_subjects: '任课关系（谁教哪个班哪一科）',
  assignments: '作业档案（收缴与批改）',
  daily_homework: '每日作业（教室屏上"今天各科留了什么"）',
  duty_assignments: '值日生',
  school_calendar: '校历（某天放不放假）',
  school_calendar_events: '校历上的活动 / 考试',
  calls: '呼叫播报（教室屏叫学生）',
  shared_files: '老师传给教室屏的文件',
  exams: '考试档案',
  score_rows: '成绩明细',
  wrongbook: '错题本',
}

/** 剥注释再扫：插件里写「不碰 window.__shell_out」这种说明也会被正则命中（2026-10-24 真踩过） */
export function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const BANNED: Array<[RegExp, string]> = [
  [/\bimport\s*(?:\(|['"{*])/, '单文件插件不能导入其他模块'],
  [/window\.__shell_out/, '碰了壳桥 __shell_out'],
  [/\bfetch\s*\(/, '自己联网 fetch('],
  [/\bXMLHttpRequest\b/, '自己联网 XMLHttpRequest'],
  [/\bWebSocket\b/, '自己联网 WebSocket'],
  [/\blocalStorage\b/, '碰了宿主 localStorage'],
]

export function semverCmp(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return 0
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  return 0
}

/**
 * 逐条给结论，**不短路**：超管要看到"哪几条红"，而不是"第一条红就停"。
 * `prevVersion` 是登记表里这个插件的当前放行版本（没有就 null）。
 */
export function probe(files: PluginFiles, prevVersion: string | null): CheckLine[] {
  const m = files.manifest as Record<string, unknown>
  const src = stripComments(files.indexSource)
  const perms = Array.isArray(m.permissions) ? (m.permissions as unknown[]) : null
  const lines: CheckLine[] = []

  lines.push({ id: 'CF-01', name: 'id 是 vendor.name 且与目录/分支一致', ok: ID_RE.test(String(m.id ?? '')) && m.id === files.id, detail: String(m.id ?? '') })
  lines.push({ id: 'CF-02', name: '必填字段齐全（name / description / icon / version）', ok: ['name', 'description', 'icon', 'version'].every((k) => typeof m[k] === 'string' && String(m[k]).trim()), detail: '' })
  lines.push({ id: 'CF-02b', name: '字段名是 permissions，不是 capabilities', ok: !('capabilities' in m) })
  lines.push({ id: 'CF-03', name: '版本是 主.次.修', ok: SEMVER.test(String(m.version ?? '')), detail: String(m.version ?? '') })
  lines.push({
    id: 'CF-04',
    name: '版本比已放行的更大',
    ok: !prevVersion || semverCmp(String(m.version ?? '0.0.0'), prevVersion) > 0,
    detail: prevVersion ? `已放行 ${prevVersion}，本次 ${String(m.version ?? '')}` : '首次发布',
  })
  lines.push({
    id: 'CF-05',
    name: 'permissions 全在枚举内',
    ok: Array.isArray(perms) && perms.length > 0 && perms.every((p) => (PERMS as readonly string[]).includes(String(p))),
    detail: Array.isArray(perms) ? perms.join(',') : '缺失',
  })
  lines.push({ id: 'CF-06', name: '入口 export default {...}', ok: /export\s+default\s*\{/.test(src) })
  const banned = BANNED.filter(([re]) => re.test(src))
  lines.push({ id: 'CF-07', name: '没有禁区写法', ok: banned.length === 0, detail: banned.map(([, why]) => why).join('；') })
  lines.push({
    id: 'CF-08',
    name: '指纹对得上',
    ok: files.declaredSha.length === 64 && files.declaredSha === files.actualSha,
    detail: files.declaredSha ? `声明 ${files.declaredSha.slice(0, 12)}… / 实际 ${files.actualSha.slice(0, 12)}…` : '缺 index.js.sha256',
  })
  const pii: Array<[RegExp, string]> = [
    [/1[3-9]\d{9}/, '疑似手机号'],
    [/\d{17}[\dXx]/, '疑似身份证号'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '疑似邮箱'],
  ]
  const piiHits = pii.filter(([re]) => re.test(files.indexSource) || re.test(JSON.stringify(files.manifest))).map(([, why]) => why)
  lines.push({ id: 'CF-09', name: '没有个人信息样式串', ok: piiHits.length === 0, detail: piiHits.join('；') })
  lines.push({ id: 'CF-10', name: '入口不超过 512 KB（单文件约定）', ok: new TextEncoder().encode(files.indexSource).length <= 512 * 1024, detail: `${Math.round(new TextEncoder().encode(files.indexSource).length / 1024)} KB` })

  /*
   * 🆕 CF-11（2026-10-24 用户拍板）：**这个插件要动哪些表、这些表对应平台的哪个功能**。
   *
   * 用户原话：「审核探针里面写清楚这个插件要动哪些表，这些表对应的数据是哪些功能调用的，
   * 我根据这个插件实现的功能判断这个请求是否合理再决定上架」。
   * ⇒ 这一行就是那句话的落地：**写不写**、**写哪几张**、**每张是什么功能**、**为什么**。
   *    白名单外的表直接判红；`why` 空着也判红（没有理由的写请求不该被通过）。
   */
  {
    const writes = Array.isArray(m.writes) ? (m.writes as Array<{ table?: string; why?: string }>) : []
    const hasPerm = perms?.includes('write') ?? false
    if (writes.length === 0) {
      lines.push({
        id: 'CF-11',
        name: hasPerm ? '写了 write 能力但没声明要写哪张表' : '不写任何业务表',
        ok: !hasPerm,
        detail: hasPerm ? '必须逐张声明（writes），否则审核时无法判断' : '',
      })
    } else {
      const bad = writes.filter(
        (w) => !w?.table || !(WRITABLE_TABLES as readonly string[]).includes(w.table) || !w.why?.trim(),
      )
      const detail = writes
        .map((w) => {
          const t = String(w?.table ?? '')
          const feat = TABLE_FEATURE[t] ?? '（未登记功能，白名单外的表）'
          return `${t} → ${feat}｜理由：${w?.why ?? '（没写）'}`
        })
        .join(' ; ')
      lines.push({
        id: 'CF-11',
        name: `声明要写 ${writes.length} 张表（逐张看下面）`,
        ok: bad.length === 0,
        detail,
      })
    }
  }

  /*
   * 🆕 CF-12（2026-10-25 用户要求）：**读表清单** —— 这个插件要读哪些库里的数据。
   *
   * 与 CF-11 同一个审核口径：读不读、读哪几张、每张是什么功能、为什么。
   * 判据以探针侧镜像 `./pluginTables.ts` 为准（它是 `src/lib/pluginTables.ts` 的副本，
   * 两边漂移由 `plugin-framework-checks` 的 RT-01…RT-05 挡住）。
   * 全绿时 `detail` 逐行写「表 → 这张表是什么数据 ｜ 申请人的理由」。
   */
  {
    const rawReads = m.reads
    const reads = Array.isArray(rawReads) ? (rawReads as Array<{ table?: string; why?: string }>) : []
    const hasPerm = perms?.includes('read') ?? false
    const names = reads.map((r) => String(r?.table ?? ''))
    const bad: string[] = []

    if (rawReads !== undefined && !Array.isArray(rawReads)) bad.push('reads 必须是数组')
    if (rawReads !== undefined && !hasPerm) bad.push('声明了 reads，但没申请 read 能力')
    if (hasPerm && reads.length === 0) bad.push('申请了 read 能力，却没写 reads（必须逐张声明要读的表）')
    if (reads.length > 12) bad.push(`声明了 ${reads.length} 张表，最多 12 张`)

    for (const r of reads) {
      const t = String(r?.table ?? '')
      if (!t) {
        bad.push('有一条没写表名')
        continue
      }
      const def = READ_TABLE_MIRROR[t]
      if (!def) {
        bad.push(`${t} → 目录里没有这张表`)
        continue
      }
      if (def.deny) {
        bad.push(`${t} → ${def.deny}`)
        continue
      }
      const why = typeof r?.why === 'string' ? r.why : ''
      if (!why.trim()) bad.push(`${t} → 没写 why（给审核看的一句人话）`)
      else if (why.length > 40) bad.push(`${t} → why 超过 40 字`)
    }

    const detail = bad.length
      ? bad.join('\n')
      : reads
          .map((r) => {
            const t = String(r?.table ?? '')
            return `${t} → ${READ_TABLE_MIRROR[t]?.what ?? ''} ｜ ${r?.why ?? ''}`
          })
          .join('\n')

    lines.push({
      id: 'CF-12',
      name: reads.length ? `读 ${reads.length} 张表：${names.join('、')}` : '不读任何表',
      ok: bad.length === 0,
      detail,
      /* 壳要求与能力数：审核时和"读了什么"挨着看（界面拿不到 manifest，只能由探针带过去） */
      hint: `壳 ≥ ${
        typeof m.minShellVersion === 'string' && m.minShellVersion ? m.minShellVersion : '?'
      } · 能力 ${perms?.length ?? 0} 项`,
    })
  }
  {
    const raw = m.teacherResults
    const results = Array.isArray(raw) ? raw as Array<{ key?: unknown; label?: unknown }> : []
    const keys = new Set<string>()
    const bad: string[] = []
    if (raw !== undefined && !Array.isArray(raw)) bad.push('teacherResults 必须是数组')
    if (results.length > 12) bad.push('教师端结果最多 12 项')
    if (results.length && !perms?.includes('storage')) bad.push('教师端结果需要 storage 能力')
    for (const item of results) {
      const key = item?.key
      const label = item?.label
      if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(key) || keys.has(key))
        bad.push(`结果槽名无效或重复：${String(key)}`)
      else keys.add(key)
      if (typeof label !== 'string' || !label.trim() || label.length > 24)
        bad.push(`结果 ${String(key)} 的展示名称无效`)
    }
    lines.push({ id: 'CF-13', name: results.length ? `教师端展示 ${results.length} 项插件结果` : '不向教师端展示插件结果',
      ok: bad.length === 0, detail: bad.length ? bad.join('；') : results.map((r) => `${r.key} → ${r.label}`).join('；') })
  }
  return lines
}

/** 探针全过才算过（运行期那几条做不到，界面上要如实写） */
export function allOk(lines: CheckLine[]): boolean {
  return lines.every((l) => l.ok)
}

export { json }
