/**
 * 超管运维面板的**服务端只读回话**（Cloudflare Pages Function，`POST /api/admin/config-check`）。
 *
 * ============================================================
 * 为什么必须有这个 Function（而不是前端硬查）
 * ============================================================
 * 面板第一期有两类指标，**anon key 根本够不着**：
 *   · B1 / B3 配置完整性 —— `SUPABASE_SERVICE_ROLE_KEY` 与 R2 四个 secret 都是
 *     **Cloudflare Pages 的环境变量**，前端产物里没有、也不该有；
 *   · G2 备份最近成功 + **最新备份字节数** —— 要 GitHub Actions 的运行结果与运行日志，
 *     需要 GitHub token。
 * 「为了看得全而在前端硬查」是不可能的（前端拿不到这些东西），
 * 「把 key 塞进前端产物」更是绝不允许（anon key 是公开的）。
 * 所以照 `api/teacher-account.ts` 的**自校验**套路来。
 *
 * ============================================================
 * 🔴 权限判据：只有 `is_super_admin()`，**不是** `can_manage_teachers()`
 * ============================================================
 * `can_manage_teachers()` = 最高管理员 + **教务处**（`schema.sql` §13.2）。
 * 而这块屏是**平台维护者**的视角（面板方案 §5.5 的拍板）：
 *   「谁能打开：**只有 `super`** —— 判据 `is_super_admin()`（⚠️ **不是** `can_manage_teachers()`，
 *     那个含教务处）」
 * 教务处要看学校数据状态，走他们自己的 `/grades` / `/classes`。
 *
 * **判据落在哪里**：就在这个 Function 里，而且**不是**在 TypeScript 里重写一遍规则
 * （那正是 `teacher-account.ts:9-16` 明确反对的写法，`classroom-account.ts` 的
 * `mayManage()` 就是那个反例）。做法是：拿**调用者自己的 JWT** 去
 * `POST /rest/v1/rpc/is_super_admin`，让**数据库**回答。
 * 前端藏不藏入口是另一件事（那只是"少点几下"，不是安全边界）。
 *
 * ⚠️ 一条容易做错的区分（`teacher-account.ts:159-160` 的纪律）：
 *    **函数不存在（第 13 段没跑）→ 503「去跑第 13 段」，不是 403。**
 *    把"环境没准备好"误报成"你权限不够"，会让人去改权限设置，越改越乱。
 *
 * ============================================================
 * 🔴 配置完整性只回报"**在 / 不在**"
 * ============================================================
 * **绝不回报值，也绝不回报长度** —— `keepalive.yml:55-57` 与 `backup.yml:45-49`
 * 都专门写了这条纪律（连长度都能泄露"这个 key 是不是被截断了"这类信息，
 * 而且一旦开了"回报长度"的口子，下一步就会有人回报前缀）。
 * 所以 `config` 那一支的响应形状只有 `Record<string, boolean>`。
 *
 * ============================================================
 * 部署与环境变量（全部在 Cloudflare Pages → Settings → Variables and secrets）
 * ============================================================
 *   SUPABASE_URL / VITE_SUPABASE_URL          —— 校验调用者 JWT 与 RPC 用
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY                 —— 🔴 Secret（本 Function 只检查它在不在）
 *   RESEND_API_KEY                            —— 🆕 2026-09-29 起**已有代码引用**：
 *        `functions/api/_lib/mail.ts` 是全仓唯一一处调 Resend 的地方，
 *        三处接入（用户反馈 / 备份通知 / 公告可选）。
 *        ⚠️ 第一期 B2 那一行原来写的是"目前全仓无代码引用它"—— **那句话现在不成立了**，
 *        面板上的文案跟着改了（**面板说谎是最坏的一种**，方案 §二.6 R3）。
 *   ADMIN_NOTIFY_EMAIL                        —— 🆕 2026-09-30（隐私整改）：**邮件收件人**。
 *        🔴 以前这个地址是**写死在源码里**的，2026-09-30 抽成环境变量并把这个字面量
 *        从仓库里删掉（真实个人邮箱不能随公开仓库发出去）。
 *        ⚠️ 与 `RESEND_API_KEY` 是**两件事**：只有 key、没有它，邮件一封也发不出去
 *        （`sendMail()` 会显式回 `reason:'no_to'`，**绝不静默发到默认地址**）。
 *        本 Function 只检查它**在不在**（`Record<string, boolean>`），不看值。
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT / R2_BUCKET
 *                                             —— 🔴 Secret（同样只检查存在性）
 *   GITHUB_TOKEN                              —— 🔴 Secret，**细粒度 PAT，只给 Actions: Read**
 *   GITHUB_REPO                               —— 形如 `你的组织/这个仓库`（例：`your-org/your-repo`）
 * ⚠️ **不要把 R2 的凭据塞进 GitHub 之外的任何前端位置**：本 Function 从头到尾
 *    **不读它们的值**，只用 `Boolean(env.X)` 判断在不在。
 */

type Env = {
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  RESEND_API_KEY?: string
  ADMIN_NOTIFY_EMAIL?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_ENDPOINT?: string
  R2_BUCKET?: string
  GITHUB_TOKEN?: string
  GITHUB_REPO?: string
}

type Body = { action?: 'config' | 'backup' | 'db' | 'all' }

/**
 * 🆕 2026-09-29（管理台第二期）：`action` 从三个变四个 —— 多了 **`db`**（数据库用量）。
 * ⚠️ 严格照第一期 `§4.3` 第 2 条："**只加一个 Function、多个 action**……
 *    不要为每条指标建一个接口（19 个接口 = 19 处判据 = 19 个可能漏掉自校验的地方）"。
 *    ⚠️ **不是**新开 `/api/admin/db`：那会变成第二个"只有超管能打"的接口，
 *       而它的判据本来就和这里逐字相同（`is_super_admin()`）。
 */

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin / can_manage_teachers）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

/** 🆕 管理台第二期：数据库用量那一段（§26 的 `db_usage_report()`） */
const NEED_STAGE26 =
  '数据库还没跑运维只读报告那一段（仓库里 supabase/schema.sql 第 26 段：db_usage_report）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 面板是"体检屏"，**任何一层缓存都不许留**：看到的是上一次的结论比看不到更坏
      'Cache-Control': 'no-store',
    },
  })
}

function baseUrl(env: Env): string {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
}

function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
}

/* ---------------- 调用者是谁 + 他有没有权限（判据在数据库） ---------------- */

async function caller(request: Request, env: Env): Promise<{ id: string; token: string } | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const key = anonKey(env)
  if (!key) return null
  const res = await fetch(`${baseUrl(env)}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user?.id ? { id: user.id, token } : null
}

/**
 * 问数据库：这个权限函数对我返回什么？
 * `'missing'` = 函数还没建（第 13 段没跑）—— 调用方要把它翻成人话，**不能当成 false**。
 */
async function rpcBool(env: Env, token: string, fn: string): Promise<boolean | 'missing'> {
  const res = await fetch(`${baseUrl(env)}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: anonKey(env),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const text = await res.text()
  if (res.ok) return text.trim() === 'true'
  if (res.status === 401 || res.status === 403) return false
  if (res.status === 404 || /PGRST202|does not exist|schema cache/i.test(text)) return 'missing'
  return false
}

/* ============================================================
   最小的 zip 读取器（只为了从 Actions 运行日志里捞出那句"dump 大小"）
   ------------------------------------------------------------
   为什么要读日志：**`backup.yml` 没有把文件大小写进任何结构化输出**。
   它只在 `:249` 打印 `  dump 大小：$bytes 字节；CREATE TABLE 条数：$tables`
   （面板方案 §七 T3 把这个缺口记着："有没有把大小写进任何结构化输出 —— 未确认"）。
   而"最新备份大小"**必须显示**：`:9-11` 留档过一个真会丢备份的坑 ——
   旧写法管道里 `$?` 拿到的是 gzip 的退出码，pg_dump 挂了会被吞掉，
   **留下一个「合法但空」的 .gz，工作流还显示绿灯**。
   只看成功/失败抓不住它。

   所以这里**照它现有的输出解析**，不改 workflow（`backup.yml` 属于别的改动批次）。
   代价：解析失败时只能显示"捞不到" —— 那就如实说"捞不到"，
   **绝不把"捞不到"画成绿**（本项目最贵的一条教训）。
   ============================================================ */

/** zip 的中央目录项（只取我们需要的四个字段） */
type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}

function u32(b: Uint8Array, o: number): number {
  // >>> 0 把有符号的结果掰回无符号（zip 里有 0xFFFFFFFF 这种哨兵值）
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

/** 从中央目录读条目清单 —— 只在尾部 64 KB 里找 EOCD，不扫全文 */
function readZipEntries(buf: Uint8Array): ZipEntry[] {
  const EOCD = 0x06054b50
  const start = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= start; i--) {
    if (u32(buf, i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []
  const count = u16(buf, eocd + 10)
  let p = u32(buf, eocd + 16)
  const out: ZipEntry[] = []
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (u32(buf, p) !== 0x02014b50) break
    const method = u16(buf, p + 10)
    const compressedSize = u32(buf, p + 20)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOffset = u32(buf, p + 42)
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
    out.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * raw deflate 解压。
 * · Cloudflare Workers / Node 18+ / 浏览器：用 `DecompressionStream('deflate-raw')`；
 * · 老运行时没有它（或它抛 NotSupportedError）→ 返回 null，调用方显示"捞不到"。
 * ⚠️ **不引第三方 zip 库**：为了一个数字不值得，而且沙箱里装依赖这件事本身就该避免。
 */
async function inflateRaw(bytes: Uint8Array): Promise<string | null> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => unknown }).DecompressionStream
  if (!DS) return null
  try {
    const ds = new DS('deflate-raw') as { readable: ReadableStream; writable: WritableStream }
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(
      ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    )
    const text = await new Response(stream).text()
    return text
  } catch {
    return null
  }
}

/** 从 zip 里取出**第一个** `.txt` 条目的正文（Actions 的日志包就是这个形状） */
async function readFirstTextEntry(zip: Uint8Array): Promise<string | null> {
  for (const e of readZipEntries(zip)) {
    if (!/\.txt$/i.test(e.name)) continue
    if (e.method === 0) {
      return new TextDecoder().decode(zip.subarray(e.localOffset + 30, e.localOffset + 30 + e.compressedSize))
    }
    if (e.method !== 8) continue // 只认 store / deflate —— 别的压缩方式不猜
    // 本地文件头长度不固定（name/extra 长度在头里），要读出来
    const nameLen = u16(zip, e.localOffset + 26)
    const extraLen = u16(zip, e.localOffset + 28)
    const dataStart = e.localOffset + 30 + nameLen + extraLen
    return inflateRaw(zip.subarray(dataStart, dataStart + e.compressedSize))
  }
  return null
}

/* ============================================================
   GitHub Actions：备份 workflow 的最近一次成功 + 最新备份字节数
   ============================================================ */

type GhRun = {
  id?: number
  conclusion?: string | null
  status?: string
  created_at?: string
  updated_at?: string
  html_url?: string
  event?: string
  head_sha?: string
  display_title?: string
}

type GhRuns = { workflow_runs?: GhRun[] }

type BackupReport = {
  configured: boolean
  /** GitHub 上最近一次运行（不管成败） */
  lastRun: {
    conclusion: string | null
    at: number | null
    agoMs: number | null
    htmlUrl: string | null
    event: string | null
  } | null
  /** 最近一次**成功**的运行 */
  lastSuccess: { at: number | null; agoMs: number | null; htmlUrl: string | null } | null
  /** 从那次成功的运行日志里捞到的字节数（捞不到是 null，**不是 0**） */
  sizeBytes: number | null
  /** 日志里出现过的关键诊断行（已按"只报事实"的口径挑过，**不含任何 key 字面值**） */
  signals: string[]
  /** 这次是不是走了 Artifact 降级（R2 没配） */
  degradedToArtifact: boolean
  /** 为什么捞不到 —— 给界面用（`null` = 一切正常拿到了） */
  sizeUnknownReason: string | null
  /** 这次解析用到的运行 id（排错时能对得上） */
  runId: number | null
}

/**
 * 日志里那些"值得搬到屏上"的行 —— 只认这几条固定文案，**不做通用日志分析**。
 *
 * ⚠️ 这是**刻意的脆弱**，而且脆弱的地方写在这里：
 *    这些正则在匹配 `backup.yml` 的**人类可读输出**（`:249`、`:337`、`:345`…）。
 *    workflow 改了文案 → 面板显示"捞不到/没有诊断行"，**不会显示错的数**。
 *    `probeSchemaDrift`/G2 那条纪律"认不出不等于通过"在这里同样适用：
 *    捞不到就是黄，不是绿。
 */
const SIGNAL_PATTERNS: RegExp[] = [
  /dump 大小：\s*\d+\s*字节/,
  /未配置 R2（[^）\n]*）/,
  /改为把备份作为 Artifact 保留/,
  /上传必然失败/,
  /回读校验失败/,
  /pg_dump 主版本[^\n]{0,80}/,
  /SUPABASE_DB_URL 首尾有空白/,
]

/** 一行里只要命中一条就够（同一行可能同时是"未配置 R2"与"Artifact 降级"） */
const isArtifactDegrade = (line: string) =>
  /Artifact 降级|改为把备份作为 Artifact 保留|未配置 R2/.test(line)

/** 从日志正文里捞"dump 大小" —— 取**最后一次**出现的（万一重跑过步骤） */
function parseDumpBytes(text: string): number | null {
  const re = /dump 大小：\s*(\d+)\s*字节/g
  let m: RegExpExecArray | null
  let last: number | null = null
  while ((m = re.exec(text))) {
    const n = Number(m[1])
    if (Number.isFinite(n)) last = n
  }
  return last
}

async function gh(env: Env, path: string, accept = 'application/vnd.github+json'): Promise<Response> {
  const repo = (env.GITHUB_REPO ?? '').trim().replace(/^\/+|\/+$/g, '')
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${(env.GITHUB_TOKEN ?? '').trim()}`,
      'User-Agent': 'shugao-admin-panel',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}

function parseTime(s?: string | null): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

async function backupReport(env: Env): Promise<BackupReport | { error: string }> {
  const token = (env.GITHUB_TOKEN ?? '').trim()
  const repo = (env.GITHUB_REPO ?? '').trim()
  if (!token || !repo) {
    return { error: 'not_configured' }
  }

  const base: BackupReport = {
    configured: true,
    lastRun: null,
    lastSuccess: null,
    sizeBytes: null,
    signals: [],
    degradedToArtifact: false,
    sizeUnknownReason: null,
    runId: null,
  }

  // ① 最近一次运行（不管成败）—— 它的结论本身就是一条指标
  let runsRes: Response
  try {
    runsRes = await gh(env, '/actions/workflows/backup.yml/runs?per_page=5')
  } catch (e) {
    return { error: `连不上 GitHub API：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!runsRes.ok) {
    const body = (await runsRes.text()).slice(0, 200)
    return {
      error:
        runsRes.status === 404
          ? 'GitHub 说找不到这个仓库或这个 workflow（核对 GITHUB_REPO；workflow 文件名必须是 backup.yml）'
          : runsRes.status === 401 || runsRes.status === 403
            ? 'GitHub token 无效或权限不够（需要细粒度 PAT，只给 Actions: Read 就够）'
            : `GitHub API 返回 ${runsRes.status}：${body}`,
    }
  }
  const runs = (await runsRes.json()) as GhRuns
  const list = runs.workflow_runs ?? []
  const now = Date.now()
  const first = list[0]
  if (first) {
    const at = parseTime(first.updated_at) ?? parseTime(first.created_at)
    base.lastRun = {
      conclusion: first.conclusion ?? first.status ?? null,
      at,
      agoMs: at === null ? null : now - at,
      htmlUrl: first.html_url ?? null,
      event: first.event ?? null,
    }
  }
  const ok = list.find((r) => r.conclusion === 'success')
  if (!ok) {
    // 一条成功的都没有：把话说到位，并**不去捞日志**（没有可捞的那一次）
    base.sizeUnknownReason = list.length
      ? '最近 5 次运行里没有一次是 success'
      : 'GitHub 上一条 backup 运行记录都没有（workflow 从没跑过？）'
    return base
  }
  const at = parseTime(ok.updated_at) ?? parseTime(ok.created_at)
  base.lastSuccess = { at, agoMs: at === null ? null : now - at, htmlUrl: ok.html_url ?? null }
  base.runId = ok.id ?? null

  // ② 那次成功运行的日志（zip → 第一段 .txt）
  if (!ok.id) {
    base.sizeUnknownReason = 'GitHub 没给这次运行的 id'
    return base
  }
  try {
    const logRes = await gh(env, `/actions/runs/${ok.id}/logs`)
    if (!logRes.ok) {
      base.sizeUnknownReason = `下载运行日志失败（HTTP ${logRes.status}）`
      return base
    }
    const zip = new Uint8Array(await logRes.arrayBuffer())
    const text = await readFirstTextEntry(zip)
    if (text === null) {
      base.sizeUnknownReason =
        '日志包解不开（zip 用的是不认识的压缩方式，或本运行时没有 DecompressionStream）'
      return base
    }
    const bytes = parseDumpBytes(text)
    base.sizeBytes = bytes
    if (bytes === null) {
      base.sizeUnknownReason = '这份日志里没有「dump 大小：N 字节」那一行'
    }
    let degrade = false
    for (const re of SIGNAL_PATTERNS) {
      const m = re.exec(text)
      if (!m) continue
      base.signals.push(m[0])
      if (isArtifactDegrade(m[0])) degrade = true
    }
    base.degradedToArtifact = degrade
  } catch (e) {
    base.sizeUnknownReason = `读日志出错：${e instanceof Error ? e.message : String(e)}`
  }
  return base
}

/* ============================================================
   🆕 数据库用量（`action:'db'`，2026-09-29 管理台第二期）
   ------------------------------------------------------------
   设计见 `管理台第二期方案.md` §二.2 · 落地口径见 `功能设计与不变量.md` §二十五。

   🔴 **为什么必须走服务端**：`pg_database_size()` / `pg_total_relation_size()` 是
      目录表上的函数，anon key 够不着（前端也不该有）。它们被包在 `schema.sql` §26 的
      `db_usage_report()` 里，**只 grant 给 service_role**（对 anon / authenticated revoke）。

   🔴 **它只量数、不判色**：配额（1 GB）与三档阈值在 `app/src/lib/adminChart.ts` ——
      **一个常量只能有一处**。这里回话里**没有** `quotaBytes`（有断言钉着这一点）。

   🔴 **`unknownReason` 必须是独立字段**，且为 `null` 才允许显示绿 ——
      这是第一期 G2 那条纪律（"字节数捞不到 → 黄，不是绿"）的同一条（§20.3 / I45）。
   ============================================================ */

type DbReport = {
  configured: boolean
  /** 全库字节数（`pg_database_size`）。捞不到是 **null**，不是 0 */
  totalBytes: number | null
  /** 逐表排行（已按字节降序，最多 12 张） */
  tables: Array<{ name: string; bytes: number; rowsEstimate: number | null }>
  /** `assignments.question_meta` 的总字节（题图的 base64 就存在那一列里） */
  questionMetaBytes: number | null
  /** 体积最大的几份档案：**只有班级名 / 档案 id / 字节数**，没有任何成绩与题目内容 */
  archives: Array<{ assignmentId: string; className: string; bytes: number }>
  /** 为什么捞不到 —— 给界面用（`null` = 一切正常拿到了） */
  unknownReason: string | null
}

/** 用**管理员密钥**调 Supabase（绕过 RLS）—— 只有"读数据库用量"这一步用它 */
function sb(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  return fetch(`${baseUrl(env)}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

const emptyDb = (unknownReason: string): DbReport => ({
  configured: true,
  totalBytes: null,
  tables: [],
  questionMetaBytes: null,
  archives: [],
  unknownReason,
})

async function dbReport(env: Env): Promise<DbReport> {
  if (!(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()) {
    /* 🔴 没配密钥 = **无法判断**（灰），**绝不是"0 MB"、也绝不是绿** */
    return {
      configured: false,
      totalBytes: null,
      tables: [],
      questionMetaBytes: null,
      archives: [],
      unknownReason: '服务端还没有管理员密钥（SUPABASE_SERVICE_ROLE_KEY），数据库用量读不到',
    }
  }
  let res: Response
  try {
    res = await sb(env, '/rest/v1/rpc/db_usage_report', { method: 'POST', body: '{}' })
  } catch (e) {
    return emptyDb(`连不上数据库：${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  if (!res.ok) {
    return emptyDb(
      /PGRST202|does not exist|schema cache/i.test(text)
        ? NEED_STAGE26
        : `读数据库用量失败（HTTP ${res.status}）：${text.slice(0, 160)}`,
    )
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return emptyDb('数据库用量回话解不开（不是 JSON）')
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const tables = Array.isArray(raw.tables)
    ? (raw.tables as Array<Record<string, unknown>>).map((t) => ({
        name: String(t.name ?? ''),
        bytes: num(t.bytes) ?? 0,
        /* ⚠️ `reltuples < 0`（还没 ANALYZE 过）在 SQL 里已经归一成 null = **无法判断**，
           这里**不许**把它掰成 0（"0 行"与"还没统计过"是两件事） */
        rowsEstimate: num(t.rowsEstimate),
      }))
    : []
  const archives = Array.isArray(raw.archives)
    ? (raw.archives as Array<Record<string, unknown>>).map((a) => ({
        assignmentId: String(a.assignmentId ?? ''),
        className: String(a.className ?? ''),
        bytes: num(a.bytes) ?? 0,
      }))
    : []
  const totalBytes = num(raw.totalBytes)
  return {
    configured: true,
    totalBytes,
    tables,
    questionMetaBytes: num(raw.questionMetaBytes),
    archives,
    unknownReason: totalBytes === null ? '回话里没有 totalBytes（SQL 那一段可能没跑全）' : null,
  }
}

/* ============================================================
   配置完整性：**只回答"在 / 不在"**
   ============================================================ */

const CONFIG_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  /* 🆕 2026-09-30：邮件收件人（以前写死在源码里，现在必须由部署环境给） */
  'ADMIN_NOTIFY_EMAIL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'GITHUB_TOKEN',
  'GITHUB_REPO',
] as const

function configReport(env: Env): {
  keys: Record<string, boolean>
  /** 这个接口自己需要的两个变量（不在的话整个回话都拿不到东西） */
  selfReady: boolean
  /** 前端接入地址（**不是 secret**，是"有没有走中转"的关键证据） */
  supabaseHost: string
} {
  const keys: Record<string, boolean> = {}
  for (const k of CONFIG_KEYS) {
    // 🔴 只回布尔。**不回值、不回长度、不回前缀** —— 见文件头那段纪律。
    keys[k] = Boolean((env[k] ?? '').trim())
  }
  let host = ''
  try {
    host = baseUrl(env) ? new URL(baseUrl(env)).host : ''
  } catch {
    host = ''
  }
  return { keys, selfReady: Boolean(baseUrl(env) && anonKey(env)), supabaseHost: host }
}

/* ---------------- 入口 ---------------- */

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!baseUrl(env) || !anonKey(env)) {
    return json(
      {
        status: 'not_configured',
        message: '缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY，请到 Cloudflare Pages 的环境变量里补上。',
      },
      503,
    )
  }

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  const action = body.action ?? 'all'

  // ---- 1. 这是谁？----
  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /*
   * ---- 2. 他是不是**最高管理员**？----
   *
   * 🔴 这里刻意用 `is_super_admin` 而**不是** `can_manage_teachers`：
   *    后者含教务处（`schema.sql` §13.2），而这块屏的定位是平台维护者
   *    （面板方案 §5.5 的拍板，T7）。判据在数据库，不在这里重写规则。
   */
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!isSuper) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员能打开平台运维面板。你的账号在 teacher_roles 里没有 super 行 —— ' +
          '教务处 / 年级主任 / 班主任都不在这一档（见 schema.sql §10.6 的身份指派模板）。',
      },
      403,
    )
  }

  // ---- 3. 回话 ----
  const cfg = configReport(env)

  if (action === 'config') {
    return json({ status: 'ok', config: cfg })
  }

  if (action === 'backup') {
    const r = await backupReport(env)
    if ('error' in r) {
      if (r.error === 'not_configured') {
        return json({
          status: 'ok',
          backup: { configured: false },
          message: '服务端还没配 GITHUB_TOKEN / GITHUB_REPO —— 面板**无法判断**备份状态（这不是"备份正常"）',
        })
      }
      return json({ status: 'error', message: r.error }, 502)
    }
    return json({ status: 'ok', backup: r })
  }

  /* 🆕 数据库用量（只读，只有超管；配额与阈值在前端 `adminChart.ts`） */
  if (action === 'db') {
    return json({ status: 'ok', db: await dbReport(env) })
  }

  const r = await backupReport(env)
  return json({
    status: 'ok',
    config: cfg,
    backup: 'error' in r ? { configured: Boolean((env.GITHUB_TOKEN ?? '').trim() && (env.GITHUB_REPO ?? '').trim()), error: r.error } : r,
    db: await dbReport(env),
  })
}

/**
 * GET 也回一份"接口活着"的自述 —— **不回任何配置细节**。
 * 用途只有一个：让人能确认"这个路径部署上去了没有"（否则 404 与 403 很难区分）。
 */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/admin/config-check',
    method: 'POST',
    body: { action: 'config | backup | db | all' },
    note: '需要登录，且判据是数据库的 is_super_admin()',
  })
}
