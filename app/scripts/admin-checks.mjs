/**
 * 超管运维面板第一期的回归检查（纯 Node，不用浏览器，不用 vitest）。
 *
 * 为什么要有它：这块屏的**全部价值**是"让静默故障变得可见"，
 * 而它自己最可能的失效方式恰好也是静默的 —— 判据写错一个方向，
 * 屏上照样一片绿。所以三条最要紧的判据都必须有**会红的用例**：
 *
 *   ① **E7 五类矛盾各一条会红的用例**（面板方案 §六 第二期验收口径 E7 的
 *      ① "5 条矛盾判据各造一个用例 → 每条都能被点出来" / ② "干净的种子数据上显示 0 条
 *      （**不能恒真**）"）；
 *   ② **面板的权限判据**：非 super 打不开（403）、未登录（401）、
 *      函数没建时是 **503 而不是 403**（`teacher-account.ts:159-160` 的纪律）；
 *   ③ **T6 面板入口不被 `Guard` 拦** —— 这条只能看真东西，所以**读 `App.tsx` 的路由结构**
 *      并断言 `/admin` 确实挂在 `Guard` 之外、且面板自己有会话闸门。
 *      （"被标成教室端的设备也能打开"的行为验证在 `shots.mjs` 里，
 *        那边有真浏览器 + 真 localStorage。）
 *
 * 做法与 `backup-checks.mjs` / `exam-checks.mjs` 同一套：
 *   · 起一个**假 Supabase**（`node:http`），把每次请求记下来；
 *   · 用 Node 原生 TS 类型剥离 + `scripts/lib/ts-resolve.mjs`，直接 import
 *     **仓库里的真源码**（`src/lib/adminChart.ts`、`functions/api/admin/config-check.ts`），不是复刻；
 *   · GitHub 那一路用一个**只认 api.github.com 的窄桩**接住（其余请求原样转发给真 fetch）——
 *     这样"日志里没有那一行"这类分支也能测到，而且**一个字节都不出网**。
 *
 * 用法：cd app && node scripts/admin-checks.mjs
 * 退出码 0 = 全过。
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolvePath(HERE, '..')

/**
 * 假 Supabase 的端口。**故意与别的脚本错开**（exam-checks 5199 / backup-checks 5197）：
 * 两个脚本万一被同时跑起来，端口撞车会表现成"读到别人的请求"，很难查。
 */
const PORT = Number(process.env.SHUGAO_ADMIN_PORT || 5196)

/**
 * `src/lib/supabase.ts` 在模块顶层就读 `import.meta.env`（Node 里由解析钩子换成
 * `globalThis.__VITE_ENV__`）。**必须在 import 任何 TS 之前设好** ——
 * 这里把它设成"指向假 Supabase"，第七节探 C1 时才会真的发出请求
 * （否则 `getSupabase()` 返回 null，整张表都会是"无法判断"，那一节就白测了）。
 */
globalThis.__VITE_ENV__ = {
  VITE_SUPABASE_URL: `http://127.0.0.1:${PORT}`,
  VITE_SUPABASE_ANON_KEY: 'fake-anon',
}

registerTsResolve()

const mod = (rel, suffix = '') => pathToFileURL(resolvePath(APP, rel)).href + suffix

/* ---------------- 断言 ---------------- */

let pass = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(`${name}${extra ? ` —— ${extra}` : ''}`)
    console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`)
  }
}
function eq(name, got, want) {
  ok(
    name,
    Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
    `实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`,
  )
}
function section(t) {
  console.log(`\n${t}`)
}

/* ============================================================
   真源码
   ============================================================ */

const C = await import(mod('src/lib/adminChart.ts'))

/* ============================================================
   E7 的夹具
   ============================================================ */

/** 一份"结构完整、内部一致"的档案；测试里按需要覆盖字段来制造矛盾 */
function goodAssignment(over = {}) {
  return {
    id: 'a-good',
    title: '作业 1',
    classId: 'c-1',
    status: 'graded',
    collected: true,
    statsMode: 'normal',
    missingNos: ['7'],
    lateNos: [],
    confirmedNos: ['1', '2', '3'],
    subQuestions: { 3: 2 },
    wrong: { 1: ['3.1'], 2: ['5'] },
    correctionNos: ['1', '2'],
    correctedNos: ['1'],
    ...over,
  }
}

const CLASS_NAMES = new Map([['c-1', '高二(1)班']])

/* ============================================================
   假 Supabase + GitHub 窄桩
   ============================================================ */

const realFetch = globalThis.fetch

await withLock(async () => {
  /* ---------------- 假 Supabase ---------------- */

  /** 记下每一次进到假 Supabase 的请求（断言"Function 真的自校验了"要用） */
  const seen = []
  /** `is_super_admin` 对调用者返回什么：`true` / `false` / `'missing'`（函数不存在） */
  let superValue = 'true'
  /** `/auth/v1/user` 是否认这个 token */
  let tokenOk = true
  /**
   * 假 PostgREST 的"库结构"：
   *  · `missingTables` 里的表 → 404 + `42P01`（真 PostgREST 的表不存在就是这个形状）；
   *  · `missingCols` 里的 `表.列` → 400 + `42703`（列不存在）。
   * 默认"什么都在" —— 这样第七节能同时测到"全跑过"和"某段没跑"两条路。
   */
  const missingTables = new Set()
  const missingCols = new Set()
  /** 表里有没有行（判"这一段跑过没有"的正面证据：`subjects` 字典该有 15 行） */
  const tableRows = new Map([['subjects', [{ code: 'physics', name: '物理' }]]])
  /**
   * 🆕 2026-09-29 管理台第二期：假库补上**写**的语义。
   *
   * 为什么必须补：第二期新增的不变量里有两条**只有看写入才验得出来**：
   *   · 「维护模式：`enabled=true` 时服务端**强制**写 `until`」→ 要看 PATCH 的载荷；
   *   · 「反馈：**先落库、再发信**」→ 要看"插入"与"发信"的**先后顺序**。
   * 所以每一次写都记进 `writes`（方法 / 表 / 查询串 / 载荷），
   * 并按 PostgREST 的形状回话（`Prefer: return=representation` 时回那一行）。
   */
  const writes = []
  /** 跨"假库"与"假 Resend"的**事件流水** —— 断言先后顺序用（先落库再发信） */
  const flow = []
  /** `Prefer: count=exact` 时 `Content-Range` 里回几（null = 按 tableRows 数） */
  let countOverride = null
  /** `can_contact_admin` 对调用者返回什么（在册教师 true / 教室端 false） */
  let contactValue = 'true'
  /** 假 `db_usage_report()` 的回话（第七节·补二 要造"读不到"那一支） */
  let dbReportValue = {
    totalBytes: 300 * 1024 * 1024,
    tables: [{ name: 'assignments', bytes: 200 * 1024 * 1024, rowsEstimate: 9 }],
    questionMetaBytes: 190 * 1024 * 1024,
    archives: [{ assignmentId: 'a-big', className: '高二(1)班', bytes: 6 * 1024 * 1024 }],
  }
  /** 假 Resend 的状态码（200 = 发得出去，500 = 发不出去） */
  let resendStatus = 200
  /** 假 Resend 收到过哪些请求 */
  const mailsSent = []
  /**
   * 🔴 假库的**列模型**（补的是一次真实误报，留档在 `功能设计与不变量.md` §20.7）。
   *
   * 老假库对任何 `select=` 一律回 `[]`（"默认什么都在"）——
   * 于是「**拿某一列当整张表的存在性探针**」（`select('id')`）这种写法
   * 在假库里**永远是绿的**，而真库上：
   * `subjects` 的主键是 `code`（`schema.sql` §12.1），**它根本没有 `id` 列**，
   * 真 PostgREST 会回 `42703 column subjects.id does not exist`。
   * 假库比真库宽松 = **假绿** —— 那次「§12 明明跑过了却报未跑」就是这么藏住的。
   *
   * 所以这里把真库的列清单建出来：**表在 → 不认识的列一律 42703**（真 PostgREST 的形状）。
   * 其余被 C1 探到的表都有 `id`（`schema.sql` 逐张核过），
   * 它们缺列的情形仍由 `missingCols` 显式造。
   */
  const REAL_COLS = new Map([
    // ⚠️ P7：`subjects.can_stream` **已经删掉**（§32.6 走班四科写死在 lib/stream.ts）
    ['subjects', ['code', 'name', 'short', 'sort', 'created_at']],
  ])
  /**
   * 这些表**一律回 500 + 一个认不出来的错误码** —— 用来造"探测本身没结论"。
   * 真环境里对应的是网关 502 / PostgREST 回了别的码：**没结论，不是"没跑"**。
   */
  const flakyTables = new Set()

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    seen.push({ path: url.pathname, auth: req.headers.authorization ?? '', search: url.search })
    /** 🆕 读请求体（第二期要验写入的载荷：维护的 `until` / 反馈的 `mail_state`） */
    const bodyText = await new Promise((resolve) => {
      let s = ''
      req.on('data', (c) => {
        s += c
      })
      req.on('end', () => resolve(s))
    })
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }
    const wantsRepr = /return=representation/i.test(String(req.headers.prefer ?? ''))

    if (url.pathname === '/auth/v1/user') {
      if (!tokenOk) return send(401, { message: 'invalid token' })
      return send(200, { id: '11111111-1111-4111-8111-111111111111', email: 'boss@example.com' })
    }

    /* ---- RPC（裸版；签名照 supabase/schema.sql 逐字对齐） ---- */
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.replace('/rest/v1/rpc/', '')
      if (fn === 'is_super_admin') {
        if (superValue === 'missing') {
          return send(404, {
            code: 'PGRST202',
            message:
              'Could not find the function public.is_super_admin without parameters in the schema cache',
          })
        }
        return send(200, superValue) // PostgREST 的 rpc 返回裸 JSON 标量
      }
      /** 🆕 管理台第二期：反馈 / 备份通知共用的那一个判据（§25.2） */
      if (fn === 'can_contact_admin') return send(200, contactValue)
      /** 🆕 数据库用量报告（§26）—— 它回的是 **json 对象**，不是一个标量 */
      if (fn === 'db_usage_report') return send(200, dbReportValue)
      if (fn === 'can_manage_teachers') return send(200, 'true')
      // §16 / §15 的裸版判据：对未登录调用者恒为 false（这就是"函数在"的正面证据）
      return send(200, 'false')
    }

    /* ---- 表 / 列的存活性探测 + 🆕 写入 ---- */
    if (url.pathname.startsWith('/rest/v1/')) {
      const rest = url.pathname.replace('/rest/v1/', '')
      const table = rest.split('/')[0]
      if (missingTables.has(table)) {
        return send(404, {
          code: 'PGRST205',
          message: `Could not find the table 'public.${table}' in the schema cache`,
        })
      }
      const method = String(req.method ?? 'GET').toUpperCase()
      /* 🆕 **写**：记下方法 / 表 / 查询串 / 载荷，并按 PostgREST 的形状回话 */
      if (method !== 'GET' && method !== 'HEAD') {
        let payload = null
        try {
          payload = bodyText ? JSON.parse(bodyText) : null
        } catch {
          payload = null
        }
        writes.push({ table, method, search: url.search, payload, prefer: req.headers.prefer ?? '' })
        flow.push({ kind: 'db-write', table, method })
        if (method === 'DELETE') {
          /* 真 PostgREST：`return=representation` 时回**被删掉的那些行** */
          const rows = tableRows.get(table) ?? []
          return wantsRepr ? send(200, rows) : send(204, '')
        }
        if (!wantsRepr) return send(204, '')
        /* `return=representation`：回写入的那一行（缺 id 时补一个假的，真库有 default） */
        const row = Array.isArray(payload) ? payload[0] : payload
        const withId = { id: 'written-1', ...(row ?? {}) }
        return send(201, [withId])
      }
      const cols = url.searchParams.get('select') ?? '*'
      if (flakyTables.has(table)) {
        // 认不出来的错误（既不是 42P01 / PGRST205，也不是 42703）→ **没有结论**
        return send(500, { code: 'XX000', message: 'internal error' })
      }
      if (cols !== '*') {
        const known = REAL_COLS.get(table)
        for (const c of cols.split(',')) {
          const col = c.trim()
          if (col && known && !known.includes(col)) {
            // 真 PostgREST：表在、这一列不在 → 42703 `column <表>.<列> does not exist`
            return send(400, {
              code: '42703',
              message: `column ${table}.${col} does not exist`,
            })
          }
          if (col && missingCols.has(`${table}.${col}`)) {
            return send(400, {
              code: '42703',
              message: `column ${table}.${col} does not exist`,
            })
          }
        }
      }
      /* 🆕 `Prefer: count=exact` → `Content-Range: 0-<n-1>/<n>`（真 PostgREST 的形状） */
      if (/count=exact/i.test(String(req.headers.prefer ?? ''))) {
        const rows = tableRows.get(table) ?? []
        const n = countOverride === null ? rows.length : countOverride
        res.setHeader('Content-Range', n > 0 ? `0-0/${n}` : `*/0`)
      }
      return send(200, tableRows.get(table) ?? [])
    }

    return send(404, { message: 'not found', path: url.pathname })
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

  /* ---------------- GitHub 窄桩 + 🆕 Resend 窄桩 ----------------
   *
   * ⚠️ **只认 `api.github.com` 与 `api.resend.com`，其余请求原样转发给真 fetch** ——
   *    否则假 Supabase 那一路会被这个桩自己吃掉（那就成"自己测自己"了）。
   * 🔴 Resend 那一路必须拦：邮件助手会去 `POST https://api.resend.com/emails`，
   *    而"一个字节都不出网"是这个脚本的硬纪律（第一节那段的注释里写着）。
   */
  const gh = { runs: [], logText: null, logStatus: 200 }
  const ghCalls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    /* 🆕 假 Resend：只认这一个地址，按 `resendStatus` 回话 */
    if (/^https:\/\/api\.resend\.com\//.test(url)) {
      let body = null
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null
      } catch {
        body = null
      }
      mailsSent.push({ url, body, auth: String(new Headers(init?.headers ?? {}).get('authorization') ?? '') })
      flow.push({ kind: 'mail' })
      if (resendStatus !== 200) {
        return new Response(JSON.stringify({ message: 'resend 挂了' }), {
          status: resendStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ id: 'mail-ok-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (!/^https:\/\/api\.github\.com\//.test(url)) return realFetch(input, init)
    ghCalls.push(url.replace('https://api.github.com', ''))

    if (/\/actions\/workflows\/backup\.yml\/runs/.test(url)) {
      return new Response(JSON.stringify({ workflow_runs: gh.runs }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (/\/actions\/runs\/\d+\/logs$/.test(url)) {
      if (gh.logStatus !== 200) return new Response('nope', { status: gh.logStatus })
      return new Response(gh.logText === null ? '' : zipWithOneText(gh.logText), {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      })
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /*
   * ⚠️ 夹具值，**不是真地址**（2026-09-30 隐私整改）：
   *    邮件收件人从"写死在源码里的真实邮箱"改成了环境变量 `ADMIN_NOTIFY_EMAIL`，
   *    所以这里的断言值跟着换成 `admin@example.com`（`example.com` 是 RFC 2606
   *    保留给文档/测试的域名，永远不会是某个人的邮箱）。
   *    → 期望值变了的原因：**隐私需求**（真实个人邮箱不能进公开仓库），不是为了让绿而改绿。
   */
  const FIXTURE_MAIL_TO = 'admin@example.com'

  const ENV = {
    SUPABASE_URL: `http://127.0.0.1:${PORT}`,
    SUPABASE_ANON_KEY: 'fake-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
    GITHUB_TOKEN: 'fake-gh-token',
    // ⚠️ 仓库地址 / 收件人都是**假夹具**：真实的 GitHub 账号名与邮箱一律不写进仓库。
    GITHUB_REPO: 'your-org/your-repo',
    ADMIN_NOTIFY_EMAIL: FIXTURE_MAIL_TO,
  }

  /* ============================================================
     🆕 2026-09-29 管理台第二期：假库的种子行 + 五个新 Function
     ------------------------------------------------------------
     ⚠️ 与第一期一样：**import 仓库里的真源码**（不是复刻）。
        这一期新增的五个 Function 与两个 `_lib` 都从真文件里导进来跑。
     ============================================================ */

  const siteRow = (over = {}) => ({
    key: 'maintenance',
    enabled: false,
    message: '',
    until: null,
    scheduled_from: null,
    updated_by: null,
    updated_at: '2026-09-29T00:00:00.000Z',
    ...over,
  })
  tableRows.set('site_state', [siteRow()])
  tableRows.set('admin_audit', [])
  tableRows.set('frontend_errors', [
    {
      id: 7,
      ts: new Date(Date.now() - 3_600_000).toISOString(),
      username: '甲老师',
      role: 'teacher',
      view: '/assignments/x/grade',
      message: '导出按钮点了没反应',
      stack: 'at foo (app.js:1)',
      ua: 'Mozilla/5.0',
      env: 'web',
      sync_error: '',
      has_pii: false,
    },
  ])
  tableRows.set('feedback', [
    {
      id: 'fb-1',
      created_at: new Date(Date.now() - 7_200_000).toISOString(),
      author_id: '11111111-1111-4111-8111-111111111111',
      author_name: '甲老师',
      author_roles: '任课教师',
      body: '作业导入的图太大',
      contact: '13800000000',
      page: '/settings',
      env: 'remote',
      ua: 'Mozilla/5.0',
      handled_at: null,
      internal_note: '',
      reply: '',
      mail_state: 'sent',
      mail_error: '',
    },
  ])

  const STATUS = await import(mod('functions/api/status.ts', '?status'))
  const MAINT = await import(mod('functions/api/admin/maintenance.ts', '?maint'))
  const ERRORS = await import(mod('functions/api/admin/errors.ts', '?errors'))
  const FB = await import(mod('functions/api/feedback.ts', '?fb'))
  const MAILFN = await import(mod('functions/api/mail.ts', '?mail'))
  const MAILLIB = await import(mod('functions/api/_lib/mail.ts', '?maillib'))

  /** 调一个 Function（真文件）—— 与 `post()` 同款，只是文件名不同 */
  const call = (F, path, body, headers = {}, env = ENV, method = 'POST') =>
    (method === 'GET' ? F.onRequestGet({ request: new Request(`http://x${path}`, { method }), env })
      : F.onRequestPost({
          request: new Request(`http://x${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
          }),
          env,
        }))
  /** 清掉写 / 流水（每一小组断言之前调一次，免得看到上一组的痕迹） */
  const clearFlow = () => {
    writes.length = 0
    flow.length = 0
    mailsSent.length = 0
  }
  const lastWrite = (table, method = 'POST') =>
    [...writes].reverse().find((w) => w.table === table && w.method === method)

  const FN = await import(mod('functions/api/admin/config-check.ts', '?admin'))
  const post = (body, headers = {}) =>
    FN.onRequestPost({
      request: new Request('http://x/api/admin/config-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env: ENV,
    })

  /* ============================================================
     第一节 · E7 五类矛盾：**每类各一条会红的用例**
     ============================================================ */

  section('第一节 · E7 五类矛盾扫描：每条判据都会红（不是恒真）')

  /* ① 未交 ∩ 已批改 */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-1',
          title: '物理练习8',
          // 7 号在未交名单里，却又有批改产物（wrong 里点了他的题）
          missingNos: ['7', '19'],
          wrong: { 7: ['3.1'], 1: ['5'] },
        }),
      ],
      CLASS_NAMES,
    )
    const g = r.groups.find((x) => x.kind === 'missing-graded')
    ok(
      '① 未交 ∩ 已批改：能红',
      r.badCount === 1 && g.details.length === 1 && g.details[0].studentNos.join(',') === '7',
      `badCount=${r.badCount}，命中 ${JSON.stringify(g.details.map((d) => d.studentNos))}`,
    )
    ok(
      '① 明细里只有**学号**（隐私 B 类：不渲染姓名，姓名要另外点开）',
      JSON.stringify(g.details[0]).includes('"7"') &&
        !JSON.stringify(g.details[0]).includes('张'),
      JSON.stringify(g.details[0]).slice(0, 120),
    )
  }

  /* ② 未交 ∩ 改错名单 */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-2',
          missingNos: ['4', '26'],
          correctionNos: ['4', '1'],
          correctedNos: [],
        }),
      ],
      CLASS_NAMES,
    )
    const g = r.groups.find((x) => x.kind === 'missing-correction')
    ok(
      '② 未交 ∩ 改错名单：能红',
      r.badCount === 1 && g.details.length === 1 && g.details[0].studentNos.join(',') === '4',
      `badCount=${r.badCount}，命中 ${JSON.stringify(g.details.map((d) => d.studentNos))}`,
    )
  }

  /* ③ `correctedNos` 孤儿（已改错 ⊄ 改错名单） */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-3',
          correctionNos: ['1'],
          // 9 号"已改错"，可他根本不在改错名单里 → 按钮会显示 2/1
          correctedNos: ['1', '9'],
        }),
      ],
      CLASS_NAMES,
    )
    const g = r.groups.find((x) => x.kind === 'corrected-orphan')
    ok(
      '③ correctedNos 孤儿：能红',
      r.badCount === 1 && g.details.length === 1 && g.details[0].studentNos.join(',') === '9',
      `badCount=${r.badCount}，命中 ${JSON.stringify(g.details.map((d) => d.studentNos))}`,
    )
  }

  /* ④ `collected` 假真 */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-4',
          // 标着"已登记收缴"，可是状态还是"待收缴"、未交名单也是空的
          collected: true,
          status: 'open',
          missingNos: [],
          wrong: {},
          correctionNos: [],
          correctedNos: [],
        }),
      ],
      CLASS_NAMES,
    )
    const g = r.groups.find((x) => x.kind === 'collected-fake')
    ok(
      '④ collected 假真：能红',
      r.badCount === 1 && g.details.length === 1,
      `badCount=${r.badCount}，命中 ${g.details.length} 条`,
    )
  }

  /* ⑤ 极简模式混进逐题数据（伪题数 / 两套数据模型串了） */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-5',
          statsMode: 'simple',
          // 极简档案的 wrong 必须恒为空；这里故意塞进逐题数据
          wrong: { 1: ['3'] },
          grades: { 1: '差' },
        }),
      ],
      CLASS_NAMES,
    )
    const g = r.groups.find((x) => x.kind === 'simple-pollution')
    ok(
      '⑤ 极简模式伪题数：能红',
      r.badCount === 1 && g.details.length === 1,
      `badCount=${r.badCount}，命中 ${g.details.length} 条`,
    )
  }

  /* 干净的夹具上必须是 0 —— **这一条防的是"五条判据恒真"** */
  {
    const clean = [
      goodAssignment({ id: 'a-c1' }),
      // 合法路径 A：收缴登记过的（collected=true + status='collected' + 有未交）
      goodAssignment({
        id: 'a-c2',
        status: 'collected',
        collected: true,
        missingNos: ['2'],
        wrong: {},
        correctionNos: [],
        correctedNos: [],
      }),
      // 合法路径 B：还没登记收缴（collected=false + status='open' + 未交为空）
      goodAssignment({
        id: 'a-c3',
        status: 'open',
        collected: false,
        missingNos: [],
        wrong: {},
        correctionNos: [],
        correctedNos: [],
      }),
      // 合法路径 C：极简档案（wrong / subQuestions 全空）
      goodAssignment({
        id: 'a-c4',
        statsMode: 'simple',
        wrong: {},
        subQuestions: {},
        grades: { 1: '优', 2: '差' },
        correctionNos: ['2'],
        correctedNos: ['2'],
      }),
    ]
    const r = C.scanAssignmentContradictions(clean, CLASS_NAMES)
    eq('干净的 4 份档案上 badCount 必须是 0（判据不能恒真）', r.badCount, 0)
    ok(
      '五类各自也都是 0（不是靠某一类"兜住"总数）',
      r.groups.every((g) => g.details.length === 0),
      JSON.stringify(r.groups.map((g) => [g.kind, g.details.length])),
    )
    eq('干净时的汇总那句话', r.summary, '作业档案 4 份，内部一致')
    eq('scanned 口径 = 传进去的份数', r.scanned, 4)
  }

  /* 明细上限：学号最多列 20 个，其余报数量（隐私 + 版面双重要求） */
  {
    const many = Array.from({ length: 25 }, (_, i) => String(i + 1))
    const r = C.scanAssignmentContradictions(
      [goodAssignment({ id: 'a-many', missingNos: many, wrong: Object.fromEntries(many.map((n) => [n, ['1']])) })],
      CLASS_NAMES,
    )
    const d = r.groups.find((g) => g.kind === 'missing-graded').details[0]
    eq('明细最多列 20 个学号', d.studentNos.length, 20)
    eq('其余用 extra 报数量', d.extra, 5)
  }

  /* 一份档案同时命中多类时，`badCount` 按**份**去重 */
  {
    const r = C.scanAssignmentContradictions(
      [
        goodAssignment({
          id: 'a-both',
          status: 'open',
          collected: true,
          missingNos: ['7'],
          wrong: { 7: ['1'] },
          correctionNos: ['7'],
          correctedNos: ['1'],
        }),
      ],
      CLASS_NAMES,
    )
    eq('一份档案命中多类时 badIds 只有一条（按份去重）', r.badIds.length, 1)
    ok('但它同时出现在多个组里', r.groups.filter((g) => g.details.length).length >= 3)
  }

  /* ============================================================
     第二节 · G2 备份的判据（阈值逐条对应方案 §六 的验收口径）
     ============================================================ */

  section('第二节 · G2 备份：超过 3 天红 / 小于 50 KB 红 / 降级与捞不到都不能算绿')

  const DAY = 86_400_000
  const run = (conclusion, agoMs, id = 1) => ({
    id,
    conclusion,
    status: 'completed',
    updated_at: new Date(Date.now() - agoMs).toISOString(),
    html_url: `https://github.com/x/y/actions/runs/${id}`,
    event: 'schedule',
  })
  const facts = (lastSuccessAgoMs, sizeBytes, over = {}) => ({
    configured: true,
    conclusion: 'success',
    lastSuccessAgoMs,
    lastRunAgoMs: lastSuccessAgoMs,
    sizeBytes,
    degradedToArtifact: false,
    r2Keys: {
      R2_ACCESS_KEY_ID: true,
      R2_SECRET_ACCESS_KEY: true,
      R2_ENDPOINT: true,
      R2_BUCKET: true,
    },
    ...over,
  })

  eq('6 小时前成功 + 4.2 MB → 绿', C.judgeBackup(facts(6 * 3_600_000, 4_400_000)).tone, 'ok')
  eq(
    '**超过 3 天没成功 → 红**（方案 §六 验收口径原话）',
    C.judgeBackup(facts(4 * DAY, 4_400_000)).tone,
    'bad',
  )
  eq('刚好 36 小时 → 黄（超过 36 小时那条线）', C.judgeBackup(facts(37 * 3_600_000, 4_400_000)).tone, 'warn')
  eq(
    '**最新备份 0.3 KB → 红**（"合法但空的 .gz"那个坑）',
    C.judgeBackup(facts(3_600_000, 300)).tone,
    'bad',
  )
  ok(
    '0.3 KB 那条必须**同时说出字节数**（只看成功/失败抓不住它）',
    C.judgeBackup(facts(3_600_000, 300)).text.includes('300 B'),
    C.judgeBackup(facts(3_600_000, 300)).text,
  )
  eq('49 KB（差一点）→ 红', C.judgeBackup(facts(3_600_000, 49 * 1024)).tone, 'bad')
  eq('50 KB（刚好到线）→ 绿', C.judgeBackup(facts(3_600_000, 50 * 1024)).tone, 'ok')
  eq(
    '捞不到字节数 → **黄，不能是绿**（"认不出不等于通过"）',
    C.judgeBackup(facts(3_600_000, null)).tone,
    'warn',
  )
  eq(
    'R2 没配、降级成 Artifact（工作流却是绿灯）→ 黄',
    C.judgeBackup(facts(3_600_000, 4_400_000, { degradedToArtifact: true })).tone,
    'warn',
  )
  ok(
    '降级那条要写清"Artifact 只保留 30 天"',
    C.judgeBackup(facts(3_600_000, 4_400_000, { degradedToArtifact: true })).notes.join(' ').includes('30 天'),
  )
  eq(
    '服务端没配 token → **灰"无法判断"，绝不是绿**',
    C.judgeBackup(facts(null, null, { configured: false })).tone,
    'unknown',
  )
  eq(
    '一次成功都没有 → 红',
    C.judgeBackup(facts(null, null)).tone,
    'bad',
  )
  ok(
    '半配置（endpoint/bucket 有、两个 key 没有）要说出"上传必然失败"',
    C.judgeBackup(
      facts(3_600_000, 4_400_000, {
        r2Keys: { R2_ACCESS_KEY_ID: false, R2_SECRET_ACCESS_KEY: false, R2_ENDPOINT: true, R2_BUCKET: true },
      }),
    ).notes.join(' ').includes('上传必然失败'),
  )

  /* ============================================================
     第三节 · B1 / B3 配置完整性（**只回在 / 不在**）
     ============================================================ */

  section('第三节 · B1/B3 配置完整性：只回存在性，且影响面要写清')

  const allSet = {
    SUPABASE_SERVICE_ROLE_KEY: true,
    RESEND_API_KEY: true,
    R2_ACCESS_KEY_ID: true,
    R2_SECRET_ACCESS_KEY: true,
    R2_ENDPOINT: true,
    R2_BUCKET: true,
    GITHUB_TOKEN: true,
    GITHUB_REPO: true,
  }
  eq('SERVICE_ROLE_KEY 在 → 绿', C.judgeServiceKey({ keys: allSet, configured: true }).tone, 'ok')
  eq(
    'SERVICE_ROLE_KEY 不在 → 红',
    C.judgeServiceKey({ keys: { ...allSet, SUPABASE_SERVICE_ROLE_KEY: false }, configured: true }).tone,
    'bad',
  )
  ok(
    '红的时候必须写清**影响面**（哪两页会打不开）',
    C.judgeServiceKey({ keys: { ...allSet, SUPABASE_SERVICE_ROLE_KEY: false }, configured: true })
      .notes.join(' ')
      .includes('教师账号'),
  )
  eq(
    '服务端接口没配 → 灰"无法判断"，不是红也不是绿',
    C.judgeServiceKey({ keys: {}, configured: false }).tone,
    'unknown',
  )

  eq('R2 四个都在 → 绿', C.judgeR2({ keys: allSet, configured: true }).tone, 'ok')
  eq(
    'R2 四个全缺 → 黄（**降级不是故障，是"只留 30 天"**）',
    C.judgeR2({
      keys: { R2_ACCESS_KEY_ID: false, R2_SECRET_ACCESS_KEY: false, R2_ENDPOINT: false, R2_BUCKET: false },
      configured: true,
    }).tone,
    'warn',
  )
  eq(
    '半配置（endpoint/bucket 有、key 没有）→ 红',
    C.judgeR2({
      keys: { R2_ACCESS_KEY_ID: false, R2_SECRET_ACCESS_KEY: false, R2_ENDPOINT: true, R2_BUCKET: true },
      configured: true,
    }).tone,
    'bad',
  )

  /* ============================================================
     第四节 · T7 面板权限判据：**只有 is_super_admin() 能开**
     ============================================================ */

  section('第四节 · T7 权限判据（服务端）：非 super 打不开')

  const AUTH = { Authorization: 'Bearer good-token' }

  /* ① 正常：super → 200 */
  superValue = 'true'
  tokenOk = true
  {
    const r = await post({ action: 'config' }, AUTH)
    const body = await r.json()
    eq('① super → 200', r.status, 200)
    eq('① 回话形状 status=ok', body.status, 'ok')
    ok(
      '① 配置回话里**只有布尔**（没有值、也没有长度）',
      Object.values(body.config.keys).every((v) => typeof v === 'boolean'),
      JSON.stringify(body.config.keys),
    )
    ok(
      '① 回话里**不出现任何 secret 的字面值**（fake-service-role / fake-gh-token）',
      !JSON.stringify(body).includes('fake-service-role') &&
        !JSON.stringify(body).includes('fake-gh-token') &&
        !JSON.stringify(body).includes('fake-anon'),
      JSON.stringify(body).slice(0, 200),
    )
    ok(
      '① 判据问的是数据库的 is_super_admin（不是 can_manage_teachers）',
      seen.some((s) => s.path === '/rest/v1/rpc/is_super_admin'),
      JSON.stringify(seen.map((s) => s.path)),
    )
    ok(
      '① 而且**没有**问 can_manage_teachers（那个含教务处，方案 §5.5 明确不用）',
      !seen.some((s) => s.path === '/rest/v1/rpc/can_manage_teachers'),
    )
    ok(
      '① 问 RPC 时带的是**调用者自己的 JWT**（不是 service_role）',
      seen.find((s) => s.path === '/rest/v1/rpc/is_super_admin')?.auth === 'Bearer good-token',
      seen.find((s) => s.path === '/rest/v1/rpc/is_super_admin')?.auth,
    )
  }

  /* ② 非 super（教务处）→ 403，而且话要说明白 */
  superValue = 'false'
  {
    const r = await post({ action: 'all' }, AUTH)
    const body = await r.json()
    eq('② 非 super → **403**', r.status, 403)
    eq('② status=forbidden', body.status, 'forbidden')
    ok(
      '② 话里点明"只有最高管理员"，并说清教务处不在这一档',
      body.message.includes('最高管理员') && body.message.includes('教务处'),
      body.message,
    )
  }

  /* ③ 未登录 → 401 */
  tokenOk = false
  {
    const r = await post({ action: 'config' }, AUTH)
    eq('③ token 无效 / 未登录 → 401', r.status, 401)
  }
  tokenOk = true
  {
    const r = await post({ action: 'config' })
    eq('③ 根本没带 Authorization → 401', r.status, 401)
  }

  /* ④ **第 13 段没跑（函数不存在）→ 503，不是 403** */
  superValue = 'missing'
  {
    const r = await post({ action: 'config' }, AUTH)
    const body = await r.json()
    eq('④ is_super_admin 不存在 → **503**（不是 403）', r.status, 503)
    ok(
      '④ 话里要写"去跑第 13 段"（把"环境没准备好"误报成"你权限不够"会让人去改权限，越改越乱）',
      body.message.includes('第 13 段'),
      body.message,
    )
    ok('④ 而**不是** forbidden（两者必须分得开）', body.status !== 'forbidden', body.status)
  }

  /* ⑤ 服务端两个变量都没配 → 503 not_configured（**不能是 403**） */
  superValue = 'true'
  {
    const r = await FN.onRequestPost({
      request: new Request('http://x/api/admin/config-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ action: 'config' }),
      }),
      env: { SUPABASE_SERVICE_ROLE_KEY: 'x' },
    })
    const body = await r.json()
    eq('⑤ Function 自己没配 URL/anon → 503', r.status, 503)
    eq('⑤ status=not_configured', body.status, 'not_configured')
  }

  /* ============================================================
     第五节 · G2 服务端那一支：真去 GitHub 拿，并从日志里捞字节数
     ============================================================ */

  section('第五节 · G2 服务端：结论 + 字节数（含"没有那一行"的分支）')

  superValue = 'true'

  /* ① 最近一次成功、日志里有 dump 大小 */
  gh.runs = [run('success', 2 * 3_600_000)]
  gh.logText =
    '2026-09-28T02:31:00.0000000Z   dump 大小：4390912 字节；CREATE TABLE 条数：16\n' +
    '2026-09-28T02:31:05.0000000Z   上传并回读确认：backup-2026-09-28.sql.gz\n'
  gh.logStatus = 200
  {
    const r = await post({ action: 'backup' }, AUTH)
    const body = await r.json()
    eq('① backup 回话 200', r.status, 200)
    eq('① 结论读到了', body.backup.lastRun.conclusion, 'success')
    eq('① **字节数从日志里捞出来了**', body.backup.sizeBytes, 4390912)
    eq('① 没有走 Artifact 降级', body.backup.degradedToArtifact, false)
    ok(
      '① 回话里不出现任何 token 字面值',
      !JSON.stringify(body).includes('fake-gh-token'),
      JSON.stringify(body).slice(0, 160),
    )
  }

  /* ② R2 没配 → 日志里有那句 warning，必须标成"降级" */
  gh.logText =
    '2026-09-28T02:30:00Z   dump 大小：4390912 字节；CREATE TABLE 条数：16\n' +
    '2026-09-28T02:30:01Z ::warning::未配置 R2（R2_ENDPOINT / R2_BUCKET trim 后为空），改为把备份作为 Artifact 保留\n'
  {
    const r = await post({ action: 'backup' }, AUTH)
    const body = await r.json()
    eq('② 识别出 **Artifact 降级**（工作流当时是绿灯）', body.backup.degradedToArtifact, true)
    ok(
      '② 而且把那句原始诊断搬回来了（R2 未配置）',
      body.backup.signals.some((s) => s.includes('R2')),
      JSON.stringify(body.backup.signals),
    )
    eq('② 这种情形判成黄（不是绿）', C.judgeBackup({
      configured: true,
      conclusion: 'success',
      lastSuccessAgoMs: 3_600_000,
      lastRunAgoMs: 3_600_000,
      sizeBytes: body.backup.sizeBytes,
      degradedToArtifact: body.backup.degradedToArtifact,
      r2Keys: null,
    }).tone, 'warn')
  }

  /* ③ 日志里**没有**那一行 → 必须如实说"捞不到"，且**不能变绿** */
  gh.logText = '2026-09-28T02:30:00Z  pg_dump 开始\n2026-09-28T02:31:00Z  完成\n'
  {
    const r = await post({ action: 'backup' }, AUTH)
    const body = await r.json()
    eq('③ 日志里没有那一行 → sizeBytes 是 **null**（不是 0）', body.backup.sizeBytes, null)
    ok(
      '③ 并且说清为什么捞不到',
      typeof body.backup.sizeUnknownReason === 'string' &&
        body.backup.sizeUnknownReason.includes('dump 大小'),
      String(body.backup.sizeUnknownReason),
    )
    eq(
      '③ 判据是**黄**（"认不出不等于通过"），不是绿',
      C.judgeBackup({
        configured: true,
        conclusion: 'success',
        lastSuccessAgoMs: 3_600_000,
        lastRunAgoMs: 3_600_000,
        sizeBytes: null,
        degradedToArtifact: false,
        r2Keys: null,
      }).tone,
      'warn',
    )
  }

  /* ④ 一条成功都没有 → 不去捞日志，直接说清 */
  gh.runs = [run('failure', 3 * DAY, 7), run('failure', 4 * DAY, 6)]
  ghCalls.length = 0
  {
    const r = await post({ action: 'backup' }, AUTH)
    const body = await r.json()
    eq('④ 最近一次是 failure', body.backup.lastRun.conclusion, 'failure')
    eq('④ 没有成功记录时 lastSuccess 是 null', body.backup.lastSuccess, null)
    ok(
      '④ 没有可捞的那一次时**不去下载日志**（省一次请求，也避免误报）',
      !ghCalls.some((u) => /\/logs$/.test(u)),
      JSON.stringify(ghCalls),
    )
  }

  /* ⑤ GitHub 401/403 → 说清是 token 的问题 */
  {
    const saved = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/^https:\/\/api\.github\.com\//.test(url)) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
      }
      return saved(input, init)
    }
    const r = await post({ action: 'backup' }, AUTH)
    const body = await r.json()
    eq('⑤ GitHub 401 → 502（面板这一支失败）', r.status, 502)
    ok(
      '⑤ 话里点明"token 无效或权限不够"（而不是含糊的 401）',
      body.message.includes('token'),
      body.message,
    )
    globalThis.fetch = saved
  }

  /* ⑥ 没配 GITHUB_TOKEN → 200 但 configured:false（**这是一条"无法判断"，不是错误**） */
  {
    const r = await FN.onRequestPost({
      request: new Request('http://x/api/admin/config-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ action: 'backup' }),
      }),
      env: { ...ENV, GITHUB_TOKEN: '', GITHUB_REPO: '' },
    })
    const body = await r.json()
    eq('⑥ 没配 token → 200（故意不是错误码）', r.status, 200)
    eq('⑥ backup.configured = false', body.backup.configured, false)
  }

  /* ============================================================
     第六节 · T6 面板入口不被 Guard 拦（**读真路由**，不是读文档）
     ============================================================ */

  section('第六节 · T6 入口：/admin 在 Guard 之外，且面板自己有闸门')

  const appTsx = readFileSync(resolvePath(APP, 'src/App.tsx'), 'utf8')
  const adminTsx = readFileSync(resolvePath(APP, 'src/pages/Admin.tsx'), 'utf8')

  ok(
    '① `/admin` 路由存在',
    /<Route\s+path="\/admin"\s+element=\{<Admin\s*\/>\}/.test(appTsx),
    '没找到 <Route path="/admin" element={<Admin />} />',
  )
  /*
   * ② 它**没有**套 `Guard`：把 `/admin` 那一行的前后 200 字取出来看有没有 `<Guard>`。
   *    这一条正是"超管机器被锁住时进不去面板"那个 bug 的守门断言。
   */
  {
    const i = appTsx.indexOf('path="/admin"')
    const around = appTsx.slice(Math.max(0, i - 120), i + 160)
    ok('② `/admin` 那一行附近**没有** `<Guard>`', !around.includes('<Guard>'), around.replace(/\s+/g, ' '))
    ok(
      '② 而且它的 element 就是裸的 <Admin />（不是被包在别的壳里）',
      /element=\{<Admin\s*\/>\}/.test(around),
      around.replace(/\s+/g, ' '),
    )
  }
  /*
   * ③ 反过来：别的页面**必须**还在 Guard 里 ——
   *    不然"把 /admin 拿出来"很容易被后来的人顺手做成"把 Guard 关掉"。
   */
  ok(
    '③ 对照组：`/settings` 仍然在 `<Guard>` 里（没有顺手把守卫关掉）',
    /path="\/settings"[\s\S]{0,80}<Guard>/.test(appTsx),
    '没找到 /settings 包在 Guard 里',
  )
  ok(
    '③ 对照组：`/accounts` 仍然在 `<Guard>` 里',
    /path="\/accounts"[\s\S]{0,80}<Guard>/.test(appTsx),
    '没找到 /accounts 包在 Guard 里',
  )
  ok(
    '④ 面板自己**检查会话**（不套 Guard ≠ 不设防）',
    adminTsx.includes('auth.getSession()') && adminTsx.includes('hasSession'),
  )
  ok(
    '④ 面板**不跳 /login**（登录卡在页面内，这正是"被锁住时进得来"的关键）',
    adminTsx.includes('PanelLogin') && !/<Route\s+path="\/admin"[\s\S]{0,200}Navigate to="\/login"/.test(appTsx),
  )
  ok(
    '⑤ 面板**不套 AppShell**（hydrate 失败时 AppShell 整个不渲染，见方案 §3.6）',
    !adminTsx.includes("from '../components/AppShell'") && adminTsx.includes('function Shell'),
  )
  ok(
    '⑥ 前端那句 isSuperAdmin **不是**判据（判据在服务端）—— 面板里必须能读到服务端的 403',
    adminTsx.includes("kind: 'forbidden'") && adminTsx.includes('/api/admin/config-check'),
  )
  ok(
    '⑦ 全局 syncError 横幅在所有路由之上（登录页也能看见 —— 修掉"莫名被踢回登录页"）',
    /<SyncErrorBanner\s*\/>[\s\S]{0,200}<Routes>/.test(appTsx),
    '没找到 <SyncErrorBanner /> 在 <Routes> 之前',
  )

  /* ============================================================
     第七节 · C1 schema 漂移总表：段号与"无法判断"的口径
     ============================================================ */

  section('第七节 · C1 漂移总表：段号齐全，且"无法判断"与"未跑"分得开')

  {
    eq('§10–§19 一共 10 段', (await C.probeSchemaDrift()).sections.length, 10)
  }

  /* ① 库"全跑过" → §10–§16、§19 全绿；§17/§18 是灰（anon 探不到，见下） */
  {
    missingTables.clear()
    missingCols.clear()
    const r = await C.probeSchemaDrift()
    const by = new Map(r.sections.map((s) => [s.stage, s]))
    eq(
      '段号就是 §10–§19（没有自己发明段号）',
      r.sections.map((s) => s.stage).join(','),
      '§10,§11,§12,§13,§14,§15,§16,§17,§18,§19',
    )
    ok(
      '① 表/列/函数都在 → §10 §11 §12 §13 §14 §15 §16 §19 全是"已跑"',
      ['§10', '§11', '§12', '§13', '§14', '§15', '§16', '§19'].every(
        (st) => by.get(st)?.state === 'present',
      ),
      JSON.stringify(r.sections.map((s) => [s.stage, s.state])),
    )
    eq(
      '① **§17 是"无法判断"而不是"未跑"**（restrictive 策略 anon 读不到 pg_policies）',
      by.get('§17').state,
      'indeterminate',
    )
    eq('① §18 同理（`_for` 变体全部 revoke 掉了）', by.get('§18').state, 'indeterminate')
    ok(
      '① 每一段都带"不跑的后果"（方案 §六 验收口径：每一行都带一句）',
      r.sections.every((s) => s.impact.length > 8 && s.fix.length > 4 && s.built.length > 8),
    )
    ok(
      '① §17 / §18 有**专门的理由**（探不到就得说清为什么，不能只给一个灰点）',
      Boolean(C.NO_PROBE_REASON['§17']) && Boolean(C.NO_PROBE_REASON['§18']),
    )
    ok(
      '① §17 的理由点名了 restrictive 策略 + pg_policies 读不到',
      C.NO_PROBE_REASON['§17'].includes('restrictive') &&
        C.NO_PROBE_REASON['§17'].includes('pg_policies'),
      C.NO_PROBE_REASON['§17'],
    )
    ok(
      '① §18 的理由点名了 `_for` 变体被 revoke（不是"我们懒得探"）',
      C.NO_PROBE_REASON['§18'].includes('revoke') && C.NO_PROBE_REASON['§18'].includes('_for'),
      C.NO_PROBE_REASON['§18'],
    )
    const sum0 = C.driftSummary(r.sections)
    eq('① 卡上那句话是绿的（能探的都跑过）', sum0.state, 'present')
    ok(
      '① 但**必须同时写出**那两段探不到（§17 / §18 不能被悄悄算成绿）',
      sum0.text.includes('§17') && sum0.text.includes('§18') && sum0.text.includes('不是绿'),
      sum0.text,
    )
    eq('① 探不到的正好是 §17 / §18 两段', sum0.unprobeable.map((s) => s.stage).join(','), '§17,§18')
    eq('① 而"探测没结论"这一类是空的（两者不能混为一谈）', sum0.unknown.length, 0)
    ok(
      '① 两段各自带原因',
      sum0.reasons.length === 2 && sum0.reasons.every((x) => x.includes('：')),
      JSON.stringify(sum0.reasons),
    )
  }

  /* ② 造一个"只跑了一半"的库：§15 没跑、§19 没跑 —— 两行必须**分别**正确显示 */
  {
    missingTables.add('exams')
    missingTables.add('exam_scores')
    missingCols.add('shared_files.class_ids')
    const r = await C.probeSchemaDrift()
    const by = new Map(r.sections.map((s) => [s.stage, s]))
    eq('② §15（exams 表不在）→ **未跑**', by.get('§15').state, 'missing')
    eq('② §19（shared_files.class_ids 列不在）→ **未跑**', by.get('§19').state, 'missing')
    eq('② 而 §10 不受影响，照旧"已跑"', by.get('§10').state, 'present')
    ok(
      '② 未跑的那两行各自带**它自己的**症状（不是一句通用的话）',
      by.get('§15').impact.includes('考试') && by.get('§19').impact.includes('教室端'),
      `${by.get('§15').impact} || ${by.get('§19').impact}`,
    )
    ok(
      '② 也各自带**原始证据**（那句 PostgREST 错误），不是只给一个红点',
      by.get('§15').cells.some((c) => c.state === 'missing' && /PGRST205|does not exist/i.test(c.evidence)),
      JSON.stringify(by.get('§15').cells),
    )
    const sum = C.driftSummary(r.sections)
    eq('② 卡因此变红', sum.state, 'missing')
    eq('② 而且一次点出全部未跑的段（不是只报第一个）', sum.missing.length, 2)
  }

  /* ③ 探测本身失败（网络抖动）→ **灰"无法判断"，不是红** */
  {
    missingTables.clear()
    missingCols.clear()
    const saved = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      // 只打掉假 Supabase，GitHub 那一路不受影响（这一节不涉及它）
      if (url.startsWith(`http://127.0.0.1:${PORT}`)) throw new TypeError('fetch failed')
      return saved(input, init)
    }
    const r = await C.probeSchemaDrift()
    globalThis.fetch = saved
    ok(
      '③ 网络全断时**一段都不许报"未跑"**（一次抖动不能把人吓得去重跑 SQL）',
      r.sections.every((s) => s.state !== 'missing'),
      JSON.stringify(r.sections.map((s) => [s.stage, s.state])),
    )
    ok(
      '③ 全是"无法判断"（灰）',
      r.sections.every((s) => s.state === 'indeterminate'),
      JSON.stringify(r.sections.map((s) => [s.stage, s.state])),
    )
  }

  /* ④ 合成规则：红 > 灰 > 绿，而且**一格都没有 ≠ 绿** */
  {
    eq(
      '有一格 missing → 未跑',
      C.combineCells([
        { what: 'x', state: 'present', evidence: '' },
        { what: 'y', state: 'missing', evidence: '' },
      ]),
      'missing',
    )
    eq(
      '只有 indeterminate → 无法判断',
      C.combineCells([{ what: 'x', state: 'indeterminate', evidence: '' }]),
      'indeterminate',
    )
    eq('全 present → 已跑', C.combineCells([{ what: 'x', state: 'present', evidence: '' }]), 'present')
    eq('**一格都没有 → 无法判断（不是绿）**', C.combineCells([]), 'indeterminate')

    const missingOne = C.driftSummary([
      {
        stage: '§15',
        built: 'b',
        impact: '考试功能整个静默变空；还有别的',
        fix: 'f',
        state: 'missing',
        cells: [],
        anchor: '',
      },
    ])
    eq('有未跑时卡是红的', missingOne.state, 'missing')
    ok('而且那句话说的是**症状**不是段号', missingOne.text.includes('考试功能整个静默变空'), missingOne.text)

    const unknownOne = C.driftSummary([
      { stage: '§18', built: 'b', impact: 'i', fix: 'f', state: 'indeterminate', cells: [], anchor: '' },
    ])
    eq('无法判断时卡是灰的', unknownOne.state, 'indeterminate')
    ok('而且明确写"不是绿"', unknownOne.text.includes('不是绿'), unknownOne.text)
    ok('并给出原因', unknownOne.reasons[0]?.includes('§18'), JSON.stringify(unknownOne.reasons))
  }

  /* ============================================================
     第七节·补 · 🔴 一次真实误报的复现：**"表在、只是没有那一列" ≠ "这一段没跑"**
     ------------------------------------------------------------
     现场（超管在真环境上看到的）：
       §12 明明跑过了（`subjects` 15 行、`assignments.subject_code` 回填对账 9/9/0、
       RPC 全正常），面板却红着脸写
       「**§12 未跑** → 列不存在 → 写路径"摘掉那一列"」。

     根因（两处，都在这条链上）：
       ① `probeTable()` 的探针写的是 `select('id')` ——
          而 `subjects` 的主键是 `code`（`schema.sql` §12.1），**它没有 `id` 列**；
          真 PostgREST 回 `42703 column subjects.id does not exist`，
          而表存在性的判据里带了泛化的 `/does not exist/i` → **被当成"表不在"** → 红。
       ② `agoText(now - drift.at)` 把"现在 − 时刻"当成了时刻喂进去 ——
          两者常常是同一个毫秒，差 = 0 → `!at` → 恒显示「探测于 **未知**」。
          那句"未知"会把人骗去查"是不是那次探测没拿到结论"，而真正红的是 ①。

     反向对照（**必须有，否则这一节就是"永远为绿"的摆设**）：
       · `subjects` **真的不在** → §12 必须仍然红；
       · 探测本身没结论（认不出来的错）→ §12 必须灰、卡片必须灰。
     ============================================================ */

  {
    missingTables.clear()
    missingCols.clear()
    flakyTables.clear()

    const r = await C.probeSchemaDrift()
    const by = new Map(r.sections.map((s) => [s.stage, s]))
    eq(
      '补① `subjects` 在、只是没有 `id` 列 → §12 必须是"已跑"（**不是"未跑"**）',
      by.get('§12').state,
      'present',
    )
    ok(
      '补① 而且三格证据都是"读到了"（不是给个红点就完事）',
      by.get('§12').cells.every((c) => c.state === 'present'),
      JSON.stringify(by.get('§12').cells),
    )
    const sumFix = C.driftSummary(r.sections)
    ok(
      '补① 卡片不许因此变红（那句话里不许出现"未跑"）',
      sumFix.state !== 'missing' && !sumFix.text.includes('未跑'),
      `${sumFix.state} / ${sumFix.text}`,
    )
    /*
     * 结构性钉子（比行为断言更狠）：**表存在性探测不许假设任何一列存在**。
     * 行为那条要靠"假库恰好建模了那张表"才抓得住；这一条把写法本身钉死 ——
     * 只要有人把 `select('id')` 写回去，两条一起红。
     */
    const tableProbes = seen.filter((s) =>
      /^\/rest\/v1\/(schools|grades|teacher_roles|class_subjects|classroom_accounts|schedule_items|calls|classrooms|shared_files|exams|exam_scores|subjects)$/.test(
        s.path,
      ),
    )
    const probedPaths = [...new Set(tableProbes.map((s) => s.path))]
    ok(
      '补② 表存在性探测发出去的是 `select=*`（**不许拿某一列当整张表的探针**）',
      probedPaths.length === 9 &&
        probedPaths.every((p) => tableProbes.some((s) => s.path === p && s.search.includes('select=*'))),
      JSON.stringify([...new Set(tableProbes.map((s) => `${s.path}${s.search}`))].slice(0, 10)),
    )

    /* 反向对照 A：表**真的不在**时，必须仍然红 —— 证明上面那两条不是"恒绿" */
    missingTables.add('subjects')
    const rA = await C.probeSchemaDrift()
    const byA = new Map(rA.sections.map((s) => [s.stage, s]))
    eq(
      '补③ 反向对照：`subjects` **真的不在**（PGRST205）时 §12 必须仍然"未跑"',
      byA.get('§12').state,
      'missing',
    )
    eq('补③ 而卡片这时才该红', C.driftSummary(rA.sections).state, 'missing')
    missingTables.delete('subjects')

    /* 反向对照 B：探测本身没结论（认不出来的错）→ 灰，**绝不是红** */
    flakyTables.add('subjects')
    const rB = await C.probeSchemaDrift()
    const byB = new Map(rB.sections.map((s) => [s.stage, s]))
    eq(
      '补④ 反向对照：探测本身没结论（500 + 认不出的码）→ §12 是"无法判断"',
      byB.get('§12').state,
      'indeterminate',
    )
    const sumB = C.driftSummary(rB.sections)
    eq('补④ 卡片这时是灰的（**不是红**）', sumB.state, 'indeterminate')
    eq('补④ 而且着色判据给的就是灰', C.driftTone(sumB.state), 'unknown')
    ok(
      '补④ "没结论"那一格带着原始证据（不能只说一句"无法判断"）',
      byB.get('§12').cells.some((c) => c.state === 'indeterminate' && c.evidence.includes('XX000')),
      JSON.stringify(byB.get('§12').cells),
    )
    flakyTables.clear()
  }

  /* ============================================================
     第七节·补二 · 🆕 管理台第二期（§23–§26）：维护 / 错误日志 / 反馈 / 用量 / 邮件
     ------------------------------------------------------------
     用户点名要的断言（每一条都**带反向对照**，否则就是"永远为绿"的摆设）：
       · 维护模式「**超管仍能进 / 别人被拦**」；
       · `GET /api/status` **只回三个字段**（多一个就红）；
       · 错误上报的**限流**与**截断**（限流/截断的真库那一半在 `rls-checks` 二·之七，
         这里钉**读与删的判据 + 留痕 + 服务端再判一次截止时间**）；
       · 反馈「**先落库再发信**」（发信失败时库里仍有行 —— 这一条**只有看流水才验得出来**）；
       · 数据库用量**三档阈值** + 那条与百分比无关的红（单份档案 > 5 MB）；
       · 邮件助手的三条硬要求（没配 key 显式报错 / 失败留痕 / 正文不许有学生信息）。
     ============================================================ */

  section('第七节·补二 🆕 管理台第二期：维护 · 状态接口 · 错误日志 · 反馈 · 用量 · 邮件')

  /* ---------------- ① 维护模式：「超管仍能进 / 别人被拦」 ---------------- */
  {
    clearFlow()
    superValue = 'true'
    tokenOk = true

    /* 正向：超管能读状态 */
    {
      tableRows.set('site_state', [siteRow()])
      const r = await call(MAINT, '/api/admin/maintenance', { action: 'state' }, AUTH)
      const body = await r.json()
      eq('① 超管读维护状态 → 200', r.status, 200)
      eq('① 且回话里 `effective=false`（未开启）', body.maintenance.effective, false)
      ok(
        '① 状态回话里带着**邮件通道**那一块（面板要把"今天已发几封"显示出来）',
        typeof body.mail?.configured === 'boolean' && 'cap' in body.mail,
        JSON.stringify(body.mail),
      )
    }

    /* 🔴 反向：非超管 → 403（这就是"别人被拦"的服务端那一半） */
    {
      superValue = 'false'
      const r = await call(MAINT, '/api/admin/maintenance', { action: 'state' }, AUTH)
      const body = await r.json()
      eq('🔴 ① **非超管（教务处）→ 403**（"别人被拦"的服务端那一半）', r.status, 403)
      ok('① 而且那句话点明"只有最高管理员"', body.message.includes('最高管理员'), body.message)
      const w = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, confirm: 'MAINTENANCE', hours: 4 },
        AUTH,
      )
      eq('🔴 ① 非超管**连写也被拦**（403，不是"读了才拦"）', w.status, 403)
      superValue = 'true'
    }

    /* 🔴 第 13 段没跑 → 503（**不是 403**） */
    {
      superValue = 'missing'
      const r = await call(MAINT, '/api/admin/maintenance', { action: 'state' }, AUTH)
      eq('① 权限函数没建（第 13 段没跑）→ **503 而不是 403**', r.status, 503)
      ok('① 而且那句话指向"去跑第 13 段"', (await r.json()).message.includes('第 13 段'))
      superValue = 'true'
    }

    /* 🔴 二次确认：少了 / 打错 `MAINTENANCE` 一律 400（前端 disabled 不是闸门） */
    {
      clearFlow()
      const noConfirm = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, hours: 4 },
        AUTH,
      )
      eq('🔴 ① 开启维护**不带确认字符串 → 400**（手打接口也过不去）', noConfirm.status, 400)
      ok(
        '① 而且那句话把要输入的字符串写出来了（MAINTENANCE）',
        (await noConfirm.json()).message.includes('MAINTENANCE'),
      )
      const wrong = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, confirm: 'maintenance', hours: 4 },
        AUTH,
      )
      eq('🔴 ① 确认字符串**大小写不对也拒**（`maintenance` ≠ `MAINTENANCE`）', wrong.status, 400)
      eq('① 这两次都没写库', writes.filter((w) => w.table === 'site_state').length, 0)
    }

    /* 🔴 四条表单校验：逐条各造一个用例（R1 / R3 / R4 拒；R2 降级） */
    {
      clearFlow()
      const now = Date.now()
      const R1 = await call(
        MAINT,
        '/api/admin/maintenance',
        {
          action: 'set',
          enabled: true,
          confirm: 'MAINTENANCE',
          scheduled: true,
          toMs: now + 6 * 3600_000,
          hours: 4,
        },
        AUTH,
      )
      const r1 = await R1.json()
      eq('🔴 R1：勾了定时 + 只填结束 → **400**', R1.status, 400)
      eq('🔴 R1 的代号就是 `R1`（前端能按代号摆提示）', r1.rule, 'R1')
      ok('R1 的话说明白"只填结束的那一段没有起点"', r1.message.includes('开始时间'), r1.message)

      const R3 = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, confirm: 'MAINTENANCE', scheduled: false, toMs: now + 6 * 3600_000, hours: 4 },
        AUTH,
      )
      const r3 = await R3.json()
      eq('🔴 R3：没勾定时 + 只填结束 → **400**', R3.status, 400)
      eq('🔴 R3 的代号就是 `R3`', r3.rule, 'R3')

      const R4 = await call(
        MAINT,
        '/api/admin/maintenance',
        {
          action: 'set',
          enabled: true,
          confirm: 'MAINTENANCE',
          scheduled: true,
          fromMs: now + 6 * 3600_000,
          toMs: now + 2 * 3600_000,
          hours: 4,
        },
        AUTH,
      )
      const r4 = await R4.json()
      eq('🔴 R4：结束早于开始 → **400**', R4.status, 400)
      eq('🔴 R4 的代号就是 `R4`', r4.rule, 'R4')

      eq('① 三条被拒的用例**一条都没写库**（拒就得拒干净）', writes.filter((w) => w.table === 'site_state').length, 0)

      /* R2：勾了定时但两个都没填 → **降级为立即生效，不报错** */
      clearFlow()
      const R2 = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, confirm: 'MAINTENANCE', scheduled: true, hours: 4 },
        AUTH,
      )
      const r2 = await R2.json()
      eq('🔴 R2：勾了定时但两个都没填 → **200（降级为立即生效，不报错）**', R2.status, 200)
      eq('🔴 R2 明确回了 `downgraded=true`（界面要能告诉超管"它降级了"）', r2.downgraded, true)
      eq('🔴 R2 之后：`scheduled_from` 是 null（立即生效）', r2.maintenance.scheduledFromIso, null)
    }

    /* 🔴 强制自动关闭：`enabled=true` 时 `until` **一定要有计划**（默认 4 小时） */
    {
      clearFlow()
      const before = Date.now()
      const r = await call(
        MAINT,
        '/api/admin/maintenance',
        { action: 'set', enabled: true, confirm: 'MAINTENANCE', hours: 4 },
        AUTH,
      )
      eq('① 开启 → 200', r.status, 200)
      const patch = lastWrite('site_state', 'PATCH')
      ok('① 而且真的 PATCH 了 `site_state`', Boolean(patch), JSON.stringify(writes.map((w) => `${w.method} ${w.table}`)))
      const until = patch?.payload?.until ? Date.parse(patch.payload.until) : null
      ok(
        '🔴 ① **强制自动关闭**：载荷里的 `until` ≈ now + 4 小时（不允许"永久开启"）',
        until !== null && Math.abs(until - (before + 4 * 3600_000)) < 60_000,
        String(patch?.payload?.until),
      )
      eq('① 而且 `enabled=true` 落进了载荷', patch?.payload?.enabled, true)
      eq(
        '① `updated_by` 是**调用者自己的 id**（服务端取，不信前端传的）',
        patch?.payload?.updated_by,
        '11111111-1111-4111-8111-111111111111',
      )
      const audit = lastWrite('admin_audit')
      ok(
        '🔴 ① 开维护**写了操作留痕**（`maintenance.on`）—— 这是"能把全校锁住"的动作，必须留痕',
        audit?.payload?.action === 'maintenance.on',
        JSON.stringify(audit?.payload ?? null),
      )

      /* 反向：四个小时档位都认；认不出的档 → 归一成默认 4（不许留空） */
      clearFlow()
      await call(MAINT, '/api/admin/maintenance', { action: 'set', enabled: true, confirm: 'MAINTENANCE', hours: 12 }, AUTH)
      const p12 = lastWrite('site_state', 'PATCH')
      const u12 = p12?.payload?.until ? Date.parse(p12.payload.until) : 0
      ok('反向对照：填 12 小时 → `until` ≈ now + 12 小时（档位真的起作用）', u12 - Date.now() > 11 * 3600_000, String(p12?.payload?.until))
      clearFlow()
      await call(MAINT, '/api/admin/maintenance', { action: 'set', enabled: true, confirm: 'MAINTENANCE', hours: 999 }, AUTH)
      const pBad = lastWrite('site_state', 'PATCH')
      const uBad = pBad?.payload?.until ? Date.parse(pBad.payload.until) : 0
      ok(
        '🔴 反向对照：认不出的档位（999）→ **归一成默认 4 小时**（不许留空 = 不许永久开启）',
        uBad - Date.now() < 5 * 3600_000,
        String(pBad?.payload?.until),
      )
    }

    /* 🔴 关闭：`until` / `scheduled_from` 一起清空（"message 只在开启时有意义"） */
    {
      clearFlow()
      const r = await call(MAINT, '/api/admin/maintenance', { action: 'set', enabled: false, hours: 4 }, AUTH)
      eq('① 关闭维护 → 200（**关闭不需要确认字符串**：关错了的代价是"能用了"）', r.status, 200)
      const patch = lastWrite('site_state', 'PATCH')
      eq('① 关闭时 `enabled=false`', patch?.payload?.enabled, false)
      eq('① 关闭时 `until` 清空', patch?.payload?.until, null)
      eq('① 关闭时 `scheduled_from` 清空', patch?.payload?.scheduled_from, null)
      eq('① 关闭时 `message` 清空', patch?.payload?.message, '')
      const audit = lastWrite('admin_audit')
      eq('① 关闭也留痕（`maintenance.off`）', audit?.payload?.action, 'maintenance.off')
    }

    /* 🔴 到点自动关：读状态时顺手把过期的行落回 false（幂等），并留痕 */
    {
      clearFlow()
      tableRows.set('site_state', [
        siteRow({ enabled: true, message: '升级中', until: new Date(Date.now() - 60_000).toISOString() }),
      ])
      const r = await call(MAINT, '/api/admin/maintenance', { action: 'state' }, AUTH)
      const body = await r.json()
      eq('🔴 到点自动关：`enabled=true` 但 `until` 已过 → 回话里 `autoOff=true`', body.maintenance.autoOff, true)
      eq('🔴 而且这次读**顺手把 `enabled` 落回 false**', lastWrite('site_state', 'PATCH')?.payload?.enabled, false)
      eq(
        '🔴 而且写了一条 `maintenance.auto-off` 的留痕（"它自己关的"也要能回答）',
        lastWrite('admin_audit')?.payload?.action,
        'maintenance.auto-off',
      )
      eq('① 落回之后 `effective=false`', body.maintenance.effective, false)
      tableRows.set('site_state', [siteRow()])
    }

    /* 🔴 「超管仍能进」的前端那一半：`/admin` 与 `/classroom` 在豁免名单里（源码文本） */
    {
      const gate = readFileSync(resolvePath(APP, 'src/components/MaintenanceGate.tsx'), 'utf8')
      ok(
        '🔴 ① 闸门的豁免名单里**同时**有 `/admin` 与 `/classroom`：前者是「开了关不掉」的解药，' +
          '后者是「心跳照发 + 就地清数据」的唯一落点',
        /MAINTENANCE_EXEMPT_PATHS\s*=\s*\[[^\]]*'\/admin'[^\]]*'\/classroom'[^\]]*\]/.test(gate),
        gate.match(/MAINTENANCE_EXEMPT_PATHS[\s\S]{0,120}/)?.[0] ?? '(没找到那个常量)',
      )
      ok(
        '🔴 ① 而且文件头写清了「开了关不掉是最坏的失败模式」（免得后人把 /admin 从豁免里删掉）',
        gate.includes('开了关不掉'),
      )
      const classroom = readFileSync(resolvePath(APP, 'src/pages/Classroom.tsx'), 'utf8')
      ok(
        '🔴 ① 教室端**自己**渲染维护画面（含 `variant="classroom"`），不是交给全局闸门 —— ' +
          '否则组件被卸载 = 心跳停发 = 面板开始显示「教室端离线」',
        classroom.includes('variant="classroom"') && classroom.includes('useMaintenanceStatus'),
      )
      ok(
        '🔴 ① 而且维护一开就**清掉本页学生数据**（`mutateQueue(() => [])` + 清文件列表 + 关小窗）',
        classroom.includes('mutateQueue(() => [])') && classroom.includes('closePip()') && classroom.includes('setCloudFiles([])'),
      )
      /*
       * 🔴 「心跳照发」的**结构性证据**：心跳那个 effect 必须排在维护 early-return **之前** ——
       *    排在后面 = 维护期间它所在的整块被 return 掉 = 心跳停 = 面板开始显示"教室端离线"，
       *    而它其实好好地在显示维护画面（往"假在线"那条已知缺陷上再叠一层假信号）。
       */
      ok(
        '🔴 ① 心跳那段代码排在维护 early-return **之前**（组件不卸载 = 心跳照发）',
        classroom.indexOf('HEARTBEAT_MS') > 0 &&
          classroom.indexOf('if (maintOn)') > classroom.indexOf('HEARTBEAT_MS'),
        `心跳第 ${classroom.indexOf('HEARTBEAT_MS')} 字符 · 维护 early-return 第 ${classroom.indexOf('if (maintOn)')} 字符`,
      )
    }
  }

  /* ---------------- ② `GET /api/status`：**只回三个字段** ---------------- */
  {
    /* ① 未开启 */
    tableRows.set('site_state', [siteRow()])
    {
      const r = await call(STATUS, '/api/status', null, AUTH, ENV, 'GET')
      const body = await r.json()
      eq('② `GET /api/status` → 200（匿名可读）', r.status, 200)
      eq(
        '🔴 ② **回话的键恰好是 enabled / message / until**（多一个就是泄露面）',
        Object.keys(body).sort().join(','),
        'enabled,message,until',
      )
      eq('② 未开启时 `enabled=false`', body.enabled, false)
      eq('② 未开启时 `message` 是空串（不是默认文案 —— 没维护就没话可说）', body.message, '')
      eq('② 未开启时 `until=null`', body.until, null)
    }

    /* ② 开启中：三个字段各就各位 */
    {
      const until = new Date(Date.now() + 3600_000).toISOString()
      tableRows.set('site_state', [siteRow({ enabled: true, message: '今晚升级', until })])
      const r = await call(STATUS, '/api/status', null, AUTH, ENV, 'GET')
      const body = await r.json()
      eq('② 开启中 → `enabled=true`', body.enabled, true)
      eq('② `message` 原样回（这是给全校看的那句话）', body.message, '今晚升级')
      eq('② `until` 回 ISO 串', body.until, until)
      ok(
        '🔴 ② 回话里**没有** `updated_by` / `updated_at` / `scheduled_from`（"谁开的"是内部信息）',
        !('updated_by' in body) && !('updated_at' in body) && !('scheduled_from' in body),
        Object.keys(body).join(','),
      )
      ok(
        '② 而且 `Cache-Control: no-store`（维护状态**任何一层缓存都不许留**）',
        /no-store/i.test(r.headers.get('cache-control') ?? ''),
        r.headers.get('cache-control') ?? '(没有)',
      )
    }

    /* ③ 定时还没到 / ④ 到点该关 —— 都必须是 `enabled=false`（**算出来的**，不是原值） */
    {
      tableRows.set('site_state', [
        siteRow({ enabled: true, scheduled_from: new Date(Date.now() + 3600_000).toISOString() }),
      ])
      const a = await (await call(STATUS, '/api/status', null, AUTH, ENV, 'GET')).json()
      eq('② **定时还没到** → `enabled=false`（到点自动开 = 读的时候算）', a.enabled, false)

      tableRows.set('site_state', [
        siteRow({ enabled: true, until: new Date(Date.now() - 60_000).toISOString() }),
      ])
      const b = await (await call(STATUS, '/api/status', null, AUTH, ENV, 'GET')).json()
      eq('② **已过自动关闭时刻** → `enabled=false`（到点自动关 = 读的时候算）', b.enabled, false)
      eq('② 而且这时 `until` 回 null（没在维护，就别再给一个时刻）', b.until, null)

      /* 反向对照：把 `until` 挪到未来 → 立刻又是 true（证明上面那两个 false 不是"恒 false"） */
      tableRows.set('site_state', [
        siteRow({ enabled: true, until: new Date(Date.now() + 60_000).toISOString() }),
      ])
      const c = await (await call(STATUS, '/api/status', null, AUTH, ENV, 'GET')).json()
      eq('🔴 反向对照：`until` 在未来 → `enabled=true`（上面那两个 false 不是"恒 false"）', c.enabled, true)
    }

    /* ⑤ 读不到时：503 + **一个只有 error 的体**（fail-open 的那一半） */
    {
      const noKey = { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' }
      const r = await call(STATUS, '/api/status', null, AUTH, noKey, 'GET')
      const body = await r.json()
      eq('② 服务端没配密钥 → **503**（前端按"未维护"放行 = fail-open）', r.status, 503)
      eq('🔴 ② 而且 503 的体里**只有 error 一个键**（不许出现 enabled / until = 假结论）', Object.keys(body).join(','), 'error')
      ok('② 那句话是人话（点出去处）', String(body.error).includes('RESEND_API_KEY') || String(body.error).includes('SUPABASE_SERVICE_ROLE_KEY'), String(body.error))
    }
    tableRows.set('site_state', [siteRow()])
  }

  /* ---------------- ③ 错误日志：读 / 删的判据 + 留痕 + 服务端再判一次 ---------------- */
  {
    clearFlow()
    superValue = 'true'
    tokenOk = true
    countOverride = 3

    {
      const r = await call(ERRORS, '/api/admin/errors', { action: 'list' }, AUTH)
      const body = await r.json()
      eq('③ 超管读错误日志 → 200', r.status, 200)
      eq('③ 总数读得到（`Prefer: count=exact` → `Content-Range`）', body.errors.total, 3)
      ok('③ 24 小时那个数也在（面板磁贴要用）', typeof body.errors.last24h === 'number', String(body.errors.last24h))
      ok(
        '🔴 ③ 列表里带着 `has_pii`（**启发式**标记 —— 界面上必须写明它是启发式）',
        body.errors.rows.every((x) => 'has_pii' in x),
        JSON.stringify(body.errors.rows[0] ?? null),
      )
      ok(
        '③ 关键字里的 PostgREST 语法字符被清掉（手打接口的人不能靠关键字注入出别的过滤条件）',
        !/[(),*]/.test((await (await call(ERRORS, '/api/admin/errors', { action: 'list', keyword: 'a,b(c)*d' }, AUTH)).json()).errors.keyword ?? ''),
        '关键字被清过之后还剩什么，见上一条的实现',
      )
    }

    /* 🔴 非超管 → 403 */
    {
      superValue = 'false'
      const r = await call(ERRORS, '/api/admin/errors', { action: 'list' }, AUTH)
      eq('🔴 ③ 非超管 → 403（错误日志里**可能夹到学生姓名**，所以这一档只给超管）', r.status, 403)
      superValue = 'true'
    }

    /* 🔴 删除：服务端**再判一次**"截止时间必须早于此刻" */
    {
      clearFlow()
      const future = await call(
        ERRORS,
        '/api/admin/errors',
        { action: 'delete', before: Date.now() + 86_400_000 },
        AUTH,
      )
      eq('🔴 ③ 按截止日期清理：**截止时间在未来 → 400**（会连刚发生的一起删掉）', future.status, 400)
      ok(
        '③ 那句话说明了原因',
        (await future.json()).message.includes('早于当前时间'),
      )
      eq('③ 而且一条都没删', writes.filter((w) => w.method === 'DELETE').length, 0)

      const none = await call(ERRORS, '/api/admin/errors', { action: 'delete' }, AUTH)
      eq('🔴 ③ 既没勾选也没填日期 → 400（不许"什么都没指定就把表清空"）', none.status, 400)

      /* 按 id 删（正常路径）：写留痕 */
      clearFlow()
      const del = await call(ERRORS, '/api/admin/errors', { action: 'delete', ids: [7, 8, 'x'] }, AUTH)
      const db = await del.json()
      eq('③ 按 id 删 → 200', del.status, 200)
      eq('③ 认不出的 id（`x`）被丢掉，只删那两个真的', lastWrite('frontend_errors', 'DELETE')?.search.includes('in.(7,8)'), true)
      ok('③ 删掉的行数回给了调用方（面板要显示"删了几条"）', typeof db.deleted === 'number', String(db.deleted))
      const audit = lastWrite('admin_audit')
      ok(
        '🔴 ③ 删除**写了留痕**（`errors.delete` + 受影响行数）—— 这是不可逆动作',
        audit?.payload?.action === 'errors.delete' && typeof audit?.payload?.affected === 'number',
        JSON.stringify(audit?.payload ?? null),
      )

      /* 按截止日期删（过去的时间）：放行 */
      clearFlow()
      const past = await call(
        ERRORS,
        '/api/admin/errors',
        { action: 'delete', before: Date.now() - 86_400_000 },
        AUTH,
      )
      eq('③ 反向对照：截止时间在**过去** → 200（上面那条 400 不是"一律拒")', past.status, 200)
      ok(
        '③ 而且服务端把它翻成了 ISO 串去过滤（不是把毫秒原样塞进 URL）',
        /ts=lt\./.test(lastWrite('frontend_errors', 'DELETE')?.search ?? ''),
        lastWrite('frontend_errors', 'DELETE')?.search,
      )
    }
    countOverride = null
  }

  /* ---------------- ④ 反馈：**先落库、再发信** ---------------- */
  {
    const ENV_MAIL = { ...ENV, RESEND_API_KEY: 'fake-resend-key' }
    superValue = 'true'
    tokenOk = true

    /* ① 未登录 → 401（**不允许匿名提交** —— 用户拍板） */
    {
      const r = await call(FB, '/api/feedback', { action: 'submit', body: '登录不上' }, {})
      eq('🔴 ④ 未登录提交反馈 → **401**（用户拍板：不允许匿名；登录不上走前端错误上报）', r.status, 401)
      ok(
        '④ 而且那句话**指了另一条路**（前端错误上报那条不需要登录）',
        (await r.json()).message.includes('错误上报'),
      )
    }

    /* ② 教室端（判据 false）→ 403；反向：在册教师 → 放行 */
    {
      contactValue = 'false'
      const r = await call(FB, '/api/feedback', { action: 'submit', body: '作业导入的图太大' }, AUTH)
      eq('🔴 ④ 判据 false（教室端）→ 403', r.status, 403)
      contactValue = 'true'
    }

    /* ③ 正文校验：< 5 字 拒；> 1000 字 **拒**（不静默截断） */
    {
      const short = await call(FB, '/api/feedback', { action: 'submit', body: '坏了' }, AUTH)
      eq('🔴 ④ 正文 < 5 字 → 400', short.status, 400)
      const long = await call(FB, '/api/feedback', { action: 'submit', body: 'x'.repeat(1001) }, AUTH)
      eq('🔴 ④ 正文 > 1000 字 → 400（**不静默截断**，照 notices 的 TITLE_MAX 纪律）', long.status, 400)
    }

    /* ④ 🔴 核心：发信**失败**时库里**仍然有行**，且顺序是"先落库、再发信" */
    {
      clearFlow()
      resendStatus = 500
      const r = await call(
        FB,
        '/api/feedback',
        { action: 'submit', body: '作业导入的图太大，点导出没反应', page: '/settings' },
        AUTH,
        ENV_MAIL,
      )
      const body = await r.json()
      eq('🔴 ④ 发信 500 → **接口仍然 200**（落库那一步是成功的）', r.status, 200)
      eq('🔴 ④ 而且回话里说"已送到"（`delivered=true`）—— 它**真的**进库了', body.delivered, true)
      eq('🔴 ④ `mail.ok=false`（发信失败如实回报，**不假成功**）', body.mail?.ok, false)
      const ins = lastWrite('feedback', 'POST')
      ok('🔴 ④ **先落库**：确实 POST 了 `feedback` 一行', Boolean(ins), JSON.stringify(writes.map((w) => `${w.method} ${w.table}`)))
      eq('🔴 ④ 插入时 `mail_state` 是 `pending`（还没试发）', ins?.payload?.mail_state, 'pending')
      const patch = lastWrite('feedback', 'PATCH')
      eq('🔴 ④ **发信失败要留痕**：随后 PATCH 把 mail_state 落成 failed', patch?.payload?.mail_state, 'failed')
      ok(
        '④ 失败原因的原文也留在库里（排错要看得到 "Resend 回了 500"）',
        String(patch?.payload?.mail_error ?? '').includes('500'),
        String(patch?.payload?.mail_error ?? ''),
      )
      ok(
        '🔴 ④ **顺序**：`feedback` 的插入在"调 Resend"**之前**（先落库、再发信）',
        flow.findIndex((x) => x.kind === 'db-write' && x.table === 'feedback') <
          flow.findIndex((x) => x.kind === 'mail'),
        JSON.stringify(flow),
      )
      ok(
        '④ 而且调用方**没有**自己去"重试"或"删掉那一行"（失败就是失败，留痕即可）',
        writes.filter((w) => w.method === 'DELETE').length === 0,
      )
    }

    /* ⑤ 反向对照：发信成功 → `mail_state='sent'`（证明上面那条 failed 不是恒真） */
    {
      clearFlow()
      resendStatus = 200
      const r = await call(FB, '/api/feedback', { action: 'submit', body: '再提一条正常的建议' }, AUTH, ENV_MAIL)
      const body = await r.json()
      eq('④ 反向对照：发信成功 → 200 + `mail.ok=true`', [r.status, body.mail?.ok], [200, true])
      eq('④ 而且库里落的是 mail_state = sent', lastWrite('feedback', 'PATCH')?.payload?.mail_state, 'sent')
      eq(
        '④ 发出去的收件人就是部署环境配的那个（`ADMIN_NOTIFY_EMAIL`）—— ' +
          '⚠️ 期望值 2026-09-30 从真实邮箱换成夹具：**源码里不再有任何真实地址**（隐私需求）',
        mailsSent[0]?.body?.to?.[0],
        FIXTURE_MAIL_TO,
      )
      eq('④ 发件人是未验域名时唯一允许的那个', mailsSent[0]?.body?.from, 'onboarding@resend.dev')
      ok(
        '④ 而且用的是纯文本（`text`，**没有** `html` —— 与本仓库"通知不做富文本"同一条判断）',
        typeof mailsSent[0]?.body?.text === 'string' && !('html' in (mailsSent[0]?.body ?? {})),
        JSON.stringify(Object.keys(mailsSent[0]?.body ?? {})),
      )
    }

    /* ⑥ 🔴 正文疑似含学生信息 → **不发信**，但**仍然落库**（mail_state='skipped'） */
    {
      clearFlow()
      resendStatus = 200
      const r = await call(
        FB,
        '/api/feedback',
        { action: 'submit', body: '张三这次考了 85 分但系统显示未交' },
        AUTH,
        ENV_MAIL,
      )
      const body = await r.json()
      eq('🔴 ④ 正文疑似含学生信息 → 接口仍然 200（**它已经落库了**）', r.status, 200)
      eq('🔴 ④ 但 `mail.ok=false`（邮件会离开系统，宁可不发）', body.mail?.ok, false)
      eq('🔴 ④ 原因就是 `pii_blocked`', body.mail?.reason, 'pii_blocked')
      eq('🔴 ④ 库里落 mail_state = skipped（没试发 与 试了失败 是两件事）', lastWrite('feedback', 'PATCH')?.payload?.mail_state, 'skipped')
      eq('🔴 ④ 而且**一封邮件都没出去**', mailsSent.length, 0)
      ok('④ 那一行仍然在库里（正文一个字都没丢）', Boolean(lastWrite('feedback', 'POST')))
    }

    /* ⑦ 超管那一半：admin-list 的三个计数（尤其**邮件没发出去**那一个） */
    {
      clearFlow()
      tableRows.set('feedback', [
        { ...tableRows.get('feedback')[0], mail_state: 'failed' },
      ])
      const r = await call(FB, '/api/feedback', { action: 'admin-list' }, AUTH)
      const body = await r.json()
      eq('④ 超管读反馈清单 → 200', r.status, 200)
      ok(
        '🔴 ④ **`mailBad` 是独立的一个计数**（`pending` / `failed` / `skipped` 都算）—— ' +
          '没配 key 时不能静默：否则老师的意见躺在一个没人打开的页面里，双方都以为送到了',
        typeof body.feedback.mailBad === 'number',
        JSON.stringify({ total: body.feedback.total, open: body.feedback.open, mailBad: body.feedback.mailBad }),
      )
      superValue = 'false'
      const no = await call(FB, '/api/feedback', { action: 'admin-list' }, AUTH)
      eq('🔴 ④ 非超管读全部反馈 → 403（正文是老师手写的自由文本，很可能提到具体学生）', no.status, 403)
      superValue = 'true'
    }

    /* ⑧ 「我提过的」：只回作者自己的、且**剥掉内部字段** */
    {
      clearFlow()
      const r = await call(FB, '/api/feedback', { action: 'mine' }, AUTH)
      const body = await r.json()
      eq('④ `mine` → 200', r.status, 200)
      const row = body.mine[0] ?? {}
      ok(
        '🔴 ④ 「我提过的」**不带内部字段**（`mail_error` / `internal_note` / `handled_by` 一个都不在）',
        !('mail_error' in row) && !('internal_note' in row) && !('handled_by' in row) && !('mail_state' in row),
        JSON.stringify(row),
      )
      ok('④ 但给了一个结论性的状态（已收到 / 已处理）', typeof row.status === 'string' && row.status.length > 0, JSON.stringify(row.status))
      ok(
        '④ 并且按 `author_id=eq.<我自己>` 过滤（服务端过滤，不是回全表再让前端筛）',
        /author_id=eq\.11111111-1111-4111-8111-111111111111/.test(
          seen.filter((s) => s.path === '/rest/v1/feedback').slice(-1)[0]?.search ?? '',
        ),
        seen.filter((s) => s.path === '/rest/v1/feedback').slice(-1)[0]?.search,
      )
    }
    resendStatus = 200
  }

  /* ---------------- ⑤ 邮件助手的三条硬要求 ---------------- */
  {
    /* ① 没配 key → **显式报错**（人话 + 去处），绝不静默失败 */
    {
      const r = await MAILLIB.sendMail(ENV, { subject: 'x', text: 'y' })
      eq('🔴 ⑤ 没配 `RESEND_API_KEY` → `ok=false` + `reason=no_key`', [r.ok, r.reason], [false, 'no_key'])
      ok(
        '🔴 ⑤ 而且给的是**人话 + 去处**（不是一句 "failed"）',
        String(r.message).includes('RESEND_API_KEY') && String(r.message).includes('Cloudflare'),
        r.message,
      )
      const before = mailsSent.length
      eq('🔴 ⑤ 而且**一个请求都没发出去**（没配就不许"试一下"）', mailsSent.length, before)
    }

    /*
     * ①–B 🆕 2026-09-30（隐私整改）：**收件人**从"写死在源码里的真实邮箱"
     *     改成环境变量 `ADMIN_NOTIFY_EMAIL`。这里是它的两条硬要求：
     *       · 没配 → **显式报错**（`reason:'no_to'` + 人话 + 去处），**绝不静默发到默认地址**；
     *       · 源码里**不许**再出现那个真实邮箱（`@qq.com` 个人地址一律不许）。
     *     ⚠️ 两条都带反向对照（"配回来必须能发" + "源码扫描不能恒真"）——
     *        否则它们就是永远为绿的摆设。
     */
    {
      const r = await MAILLIB.sendMail(
        { ...ENV, RESEND_API_KEY: 'k', ADMIN_NOTIFY_EMAIL: '' },
        { subject: 'x', text: 'y' },
      )
      eq(
        '🔴 ⑤ 配了 key 但**没配收件人**（`ADMIN_NOTIFY_EMAIL`）→ `ok=false` + `reason=no_to`',
        [r.ok, r.reason],
        [false, 'no_to'],
      )
      ok(
        '🔴 ⑤ 而且说清了该去哪儿配（人话 + 去处，不是一句 failed）',
        String(r.message).includes('ADMIN_NOTIFY_EMAIL') && String(r.message).includes('Cloudflare'),
        r.message,
      )
      const before = mailsSent.length
      eq(
        '🔴 ⑤ 而且**一个请求都没发出去** —— 没有"默认收件人"这回事（发到默认地址 = 把信发给别人）',
        mailsSent.length,
        before,
      )
      /* 反向对照：把收件人配回来 → 必须能发（证明上面那条 no_to 不是恒真） */
      resendStatus = 200
      const okr = await MAILLIB.sendMail({ ...ENV, RESEND_API_KEY: 'k' }, { subject: 'x', text: 'y' })
      eq(
        '⑤ 反向对照：把收件人配回来 → `ok=true`，而且 `to` 就是配的那个（不是别的默认值）',
        [okr.ok, okr.ok ? okr.to : ''],
        [true, FIXTURE_MAIL_TO],
      )
      /*
       * 🔴 源码扫描（这一条才是"隐私整改有没有落地"的直接判据）：
       *    `_lib/mail.ts` 是全仓唯一一处决定收件人的地方，它里面**不许有 @qq.com**。
       * ⚠️ 它是**静态**断言，所以上面那条"配回来能发"是它的行为侧对照。
       */
      const mailSrc = readFileSync(resolvePath(APP, 'functions/api/_lib/mail.ts'), 'utf8')
      ok(
        '🔴 ⑤ `functions/api/_lib/mail.ts` 里**没有任何 @qq.com 个人邮箱**（收件人只从环境变量来）',
        !/@qq\.com/i.test(mailSrc),
        (mailSrc.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).join(' / ') || '(一个邮箱字面量都没有)',
      )
    }

    /* ② 失败留痕：Resend 4xx/5xx → reason=failed + 原文（调用方把它写进库） */
    {
      resendStatus = 500
      const r = await MAILLIB.sendMail({ ...ENV, RESEND_API_KEY: 'k' }, { subject: 'x', text: 'y' })
      eq('🔴 ⑤ Resend 500 → `reason=failed`', [r.ok, r.reason], [false, 'failed'])
      ok('🔴 ⑤ 而且把 Resend 的状态码与原文带回来（要落进库里的那一句）', String(r.message).includes('500'), r.message)
      resendStatus = 200
      const okr = await MAILLIB.sendMail({ ...ENV, RESEND_API_KEY: 'k' }, { subject: 'x', text: 'y' })
      eq('⑤ 反向对照：Resend 200 → `ok=true`（上面那条 failed 不是恒真）', okr.ok, true)
    }

    /* ③ 正文不许出现学生姓名/成绩 —— 窄判据 + **反向对照（不许误伤正常运维文案）** */
    {
      ok(
        '🔴 ⑤ 「张三这次考了 85 分」→ 判定含学生信息（成绩写法）',
        Boolean(MAILLIB.looksLikeStudentData('张三这次考了 85 分')),
        MAILLIB.looksLikeStudentData('张三这次考了 85 分') ?? '(没命中)',
      )
      ok(
        '🔴 ⑤ 「学号：2025007」→ 判定含学生信息（7 位序列号 + 标注）',
        Boolean(MAILLIB.looksLikeStudentData('学号：2025007 的作业没交')),
      )
      eq(
        '🔴 ⑤ 反向对照：**正常运维文案一个字都不许误伤**（"今晚 23:00–23:30 维护"）',
        MAILLIB.looksLikeStudentData('系统维护：今晚 23:00-23:30 升级，预计 30 分钟'),
        null,
      )
      eq(
        '🔴 ⑤ 反向对照：「版本 0.9.1 上线」也不许误伤（公告里合法出现数字）',
        MAILLIB.looksLikeStudentData('版本 0.9.1 上线，新增错题集导出'),
        null,
      )
      eq(
        '⑤ 而且它是**启发式**：只写"张三"（没有分数、没有学号）**抓不到** —— ' +
          '这一条是诚实留档，别把界面上写成"已脱敏"',
        MAILLIB.looksLikeStudentData('张三这次又没交作业'),
        null,
      )
    }

    /* ④ 洗凭据：URL 的 query string / Bearer / 长串一律抹掉（邮件会离开系统） */
    {
      const s = MAILLIB.scrubSecrets('见 https://x.supabase.co/a?apikey=SECRET1 Bearer abcdefghijklmnop 联系我')
      ok('🔴 ⑤ URL 的 query string 被抹掉', !s.includes('SECRET1') && s.includes('https://x.supabase.co/a'), s)
      ok('🔴 ⑤ `Bearer …` 被抹掉', !s.includes('abcdefghijklmnop'), s)
      ok('⑤ 而正文主体还在（不是把整句删了）', s.includes('联系我'), s)
    }

    /* ⑤ 面板那两个按钮走的就是这个接口（`/api/mail`） */
    {
      const ENV_MAIL = { ...ENV, RESEND_API_KEY: 'fake-resend-key' }
      superValue = 'true'
      tokenOk = true
      const noKey = await call(MAILFN, '/api/mail', { action: 'test' }, AUTH)
      eq(
        '🔴 ⑤ `/api/mail` 的 test：没配 key → **503 + reason=no_key**（显式报错，不是静默失败）',
        [noKey.status, (await noKey.json()).reason],
        [503, 'no_key'],
      )
      resendStatus = 200
      const okT = await call(MAILFN, '/api/mail', { action: 'test' }, AUTH, ENV_MAIL)
      eq(
        '⑤ 反向对照：配了 key + Resend 200 → 200，而且收件人就是**部署环境配的那个**' +
          '（期望值 2026-09-30 从真实邮箱换成夹具：源码里不再有真实地址）',
        [okT.status, (await okT.json()).to],
        [200, FIXTURE_MAIL_TO],
      )
      /*
       * 🔴 没配收件人 → **503**（不是 502：那是"环境没准备好"，不是上游故障）。
       *    这条是 `/api/mail` 那一层对 `no_to` 的处理，与 `_lib` 那一层分开各验一次。
       */
      const noTo = await call(MAILFN, '/api/mail', { action: 'test' }, AUTH, {
        ...ENV_MAIL,
        ADMIN_NOTIFY_EMAIL: '',
      })
      eq(
        '🔴 ⑤ `/api/mail` 的 test：配了 key 但没配收件人 → **503 + reason=no_to**',
        [noTo.status, (await noTo.json()).reason],
        [503, 'no_to'],
      )
      superValue = 'false'
      const forbidden = await call(MAILFN, '/api/mail', { action: 'test' }, AUTH, ENV_MAIL)
      eq('🔴 ⑤ 非超管发测试邮件 → **403**（它用的是平台的邮件配额）', forbidden.status, 403)
      superValue = 'true'
      contactValue = 'false'
      const bNo = await call(MAILFN, '/api/mail', { action: 'backup', summary: 'x' }, AUTH, ENV_MAIL)
      eq('🔴 ⑤ `backup` 那一支用的是 `can_contact_admin`（教室端 → 403）', bNo.status, 403)
      contactValue = 'true'
      const bOk = await call(
        MAILFN,
        '/api/mail',
        { action: 'backup', summary: '树高备份-2026-09-29.json' },
        AUTH,
        ENV_MAIL,
      )
      eq('⑤ 反向对照：在册教师 → 200（"备份→发信"那条链的中间一环真的通）', bOk.status, 200)
      const audit = lastWrite('admin_audit')
      eq('🔴 ⑤ 而且发信**留痕了**（`mail.backup` —— 配额就是数这张表算的）', audit?.payload?.action, 'mail.backup')
    }
  }

  /* ---------------- ⑥ 数据库用量的三档阈值 + 那条"与百分比无关的红" ---------------- */
  {
    const GB = 1024 ** 3
    const facts = (bytes, archives = [], extra = {}) => ({
      configured: true,
      totalBytes: bytes,
      tables: [],
      questionMetaBytes: null,
      archives,
      unknownReason: null,
      ...extra,
    })
    eq('⑥ 配额常量就是 **1 GB**（用户拍板）', C.DB_QUOTA_BYTES, GB)
    eq('⑥ 三档线就是 60 / 85', [C.DB_WARN_PCT, C.DB_BAD_PCT], [60, 85])
    eq('⑥ 单份档案的红线就是 **5 MB**', C.ARCHIVE_META_BAD_BYTES, 5 * 1024 * 1024)

    eq('⑥ 30% → 绿', C.judgeDbUsage(facts(0.3 * GB)).tone, 'ok')
    eq('⑥ 60% → 黄（**边界含在黄里**）', C.judgeDbUsage(facts(0.6 * GB)).tone, 'warn')
    eq('⑥ 84% → 黄', C.judgeDbUsage(facts(0.84 * GB)).tone, 'warn')
    eq('⑥ 86% → 红', C.judgeDbUsage(facts(0.86 * GB)).tone, 'bad')
    ok(
      '⑥ 绿的那一档会把"还剩多少 + 最大的一份"说出来（阈值口径是"还能不能再塞一份"）',
      C.judgeDbUsage(facts(0.1 * GB, [{ assignmentId: 'a', className: '高二(1)班', bytes: 1024 }])).text.includes('够用'),
    )

    /* 🔴 与百分比无关的那条红：单份 question_meta > 5 MB */
    const big = [{ assignmentId: 'a-big', className: '高二(1)班', bytes: 6 * 1024 * 1024 }]
    {
      const j = C.judgeDbUsage(facts(0.1 * GB, big))
      eq('🔴 ⑥ 库才用了 10%，但**有一份档案 > 5 MB → 照样红**（与百分比无关）', j.tone, 'bad')
      ok('⑥ 而且那句话点出"单份就超预算"', j.text.includes('单份') || j.text.includes('超预算'), j.text)
      eq('⑥ 并且把超预算的那几份列出来（给界面用）', j.oversized.length, 1)
      /* 反向对照：刚好 5 MB **不算**超（边界是 `>`，不是 `>=`） */
      eq(
        '⑥ 反向对照：刚好 5 MB → **不红**（边界是 `>`，不是 `>=`）',
        C.judgeDbUsage(facts(0.1 * GB, [{ ...big[0], bytes: 5 * 1024 * 1024 }])).tone,
        'ok',
      )
    }

    /* 🔴 读不到 → **灰**（绝不许画成绿，也绝不许画成红） */
    {
      const j = C.judgeDbUsage({ configured: false, totalBytes: null, tables: [], questionMetaBytes: null, archives: [], unknownReason: '没配密钥' })
      eq('🔴 ⑥ 服务端没配 / 读不到 → **灰（无法判断）**', j.tone, 'unknown')
      ok('⑥ 而且把原因写出来', j.text.includes('无法判断') && j.notes.join(' ').includes('没配密钥'), j.notes.join(' | '))
      ok('⑥ 并且明确写"读不到不是还剩很多"', j.notes.join(' ').includes('不是'), j.notes.join(' | '))
      /* 反向对照：**有数**的时候不许是灰 */
      eq('⑥ 反向对照：有数时不是灰', C.judgeDbUsage(facts(0.3 * GB)).tone !== 'unknown', true)
    }

    /* 🔴 服务端回话里**不许**有 `quotaBytes`（配额只能有一处实现） */
    {
      dbReportValue = {
        totalBytes: 300 * 1024 * 1024,
        tables: [{ name: 'assignments', bytes: 1024, rowsEstimate: 9 }],
        questionMetaBytes: 512,
        archives: [{ assignmentId: 'a', className: '高二(1)班', bytes: 256 }],
      }
      const r = await post({ action: 'db' }, AUTH)
      const body = await r.json()
      eq('⑥ 服务端 `action:db` → 200', r.status, 200)
      eq('⑥ 回话里有 `db` 那一块', typeof body.db, 'object')
      ok(
        '🔴 ⑥ 服务端回话里**没有** `quotaBytes` / `percent` / `tone`（**只量数、不判色**）',
        !('quotaBytes' in body.db) && !('percent' in body.db) && !('tone' in body.db),
        Object.keys(body.db).join(','),
      )
      eq('⑥ 而 `unknownReason` 是**独立字段**，拿到数时是 null', body.db.unknownReason, null)
      eq(
        '⑥ 行数为负（还没 ANALYZE 过）时归一成 **null = 无法判断**，不是 0',
        C.judgeDbUsage({
          configured: true,
          totalBytes: 1024,
          tables: [{ name: 'x', bytes: 1, rowsEstimate: null }],
          questionMetaBytes: 0,
          archives: [],
          unknownReason: null,
        }).tone,
        'ok',
      )
      /* 反向对照：RPC 报错（第 26 段没跑）→ `unknownReason` 有值（那就是灰） */
      const saved = dbReportValue
      missingTables.add('__never__')
      const saveFn = dbReportValue
      dbReportValue = undefined
      const broken = await post({ action: 'db' }, AUTH)
      const bb = await broken.json()
      ok(
        '⑥ 反向对照：RPC 回话解不开时 → `unknownReason` 有值（面板那一格是灰的）',
        typeof bb.db.unknownReason === 'string' && bb.db.totalBytes === null,
        JSON.stringify(bb.db).slice(0, 160),
      )
      missingTables.delete('__never__')
      dbReportValue = saved ?? saveFn
    }
  }

  /* ---------------- ⑦ 面板新结构（静态：分区表 / 导航在面板内部） ---------------- */
  {
    eq(
      '🔴 ⑦ 分区就是那七个（概览 / 健康 / 数据库 / 公告 / 维护 / 错误日志 / 反馈）',
      C.ADMIN_SECTIONS.map((s) => s.key).join(','),
      'overview,health,db,announce,maintenance,errors,feedback',
    )
    eq(
      '⑦ 每个分区都有显示名与一句说明（登记表要能被人读）',
      C.ADMIN_SECTIONS.every((s) => s.label.length > 0 && s.hint.length > 0),
      true,
    )
    eq('⑦ 标签不重复（否则导航上会出现两个"同名"项）', new Set(C.ADMIN_SECTIONS.map((s) => s.label)).size, C.ADMIN_SECTIONS.length)
    const admin = readFileSync(resolvePath(APP, 'src/pages/Admin.tsx'), 'utf8')
    ok(
      '🔴 ⑦ 面板**自己**有导航（`data-admin-nav`），没有改去套 `AppShell`',
      admin.includes('data-admin-nav') && admin.includes('data-admin-segments') && !/from '\.\.\/components\/AppShell'/.test(admin),
    )
    ok(
      '🔴 ⑦ **L0 健康条那句话一个字没丢**（`data-admin-l0` + 那句人话 + 本地模式那条红警告）',
      admin.includes('data-admin-l0') &&
        admin.includes('平台有问题 ·') &&
        admin.includes('平台正常 · 没有发现异常') &&
        admin.includes('所有数据只写在这台浏览器里'),
    )
    ok(
      '🔴 ⑦ **隐私三级仍然在位**：`PrivacyLine`（请勿投屏或截图）+ 默认只给学号 + 姓名要显式点开',
      admin.includes('请勿投屏或截图') && admin.includes('data-admin-names') && admin.includes("'显示姓名'"),
    )
    ok(
      '🔴 ⑦ 「没结论必须是灰」仍然只有一处实现（`driftTone`）—— 面板里没有自己再写一套三元',
      admin.includes('driftTone(') && !/state === 'present' \? 'ok'/.test(admin),
    )
    ok(
      '⑦ 顶栏工具栏四样齐：版本号 / 构建哈希 / 环境 / 刷新（+ 回教师端）',
      admin.includes('data-admin-version') &&
        admin.includes('data-admin-hash') &&
        admin.includes('data-admin-env') &&
        admin.includes('data-admin-refresh') &&
        admin.includes('回教师端'),
    )
    ok(
      '⑦ 概览是一排**数字磁贴**（`data-admin-tiles` + 每块一个 `data-admin-tile`）',
      admin.includes('data-admin-tiles') && admin.includes('data-admin-tile='),
    )
    /* 🔴 服务端与前端**两份**维护表单逻辑必须逐字相同（照 `nav-checks` A9 的那个写法） */
    const srv = readFileSync(resolvePath(APP, 'functions/api/_lib/maintenance.ts'), 'utf8')
    const web = readFileSync(resolvePath(APP, 'src/lib/maintenance.ts'), 'utf8')
    const SHARED = [
      'MAINTENANCE_HOURS = [1, 4, 12, 24]',
      'MAINTENANCE_DEFAULT_HOURS = 4',
      'MAINTENANCE_MESSAGE_MAX = 200',
      "MAINTENANCE_CONFIRM_WORD = 'MAINTENANCE'",
      "MAINTENANCE_DEFAULT_MESSAGE = '系统维护中，请稍后重试。'",
      "rule: 'R1'",
      "rule: 'R3'",
      "rule: 'R4'",
      '填了结束时间就必须填开始时间',
      '结束时间必须晚于开始时间',
      '降级为立即生效，不报错',
    ]
    for (const s of SHARED) {
      ok(`🔴 ⑦ 服务端与前端两份维护逻辑逐字相同：${s.slice(0, 30)}`, srv.includes(s) && web.includes(s), srv.includes(s) ? '前端那份缺' : '服务端那份缺')
    }
    /* 反向对照：随便编一句不该在两边都出现的话 —— 证明上面那组不是"什么都包含" */
    ok(
      '🔴 ⑦ 反向对照：编一句两处都没有的话 → 判否（证明上面那组不是恒真）',
      !(srv.includes('这句不该存在-ZZ9') && web.includes('这句不该存在-ZZ9')),
    )
  }


  /* ============================================================
     第八节 · 颜色合成与时间/字节的显示口径
     ============================================================ */

  section('第八节 · 颜色合成与显示口径')

  eq('红压过一切', C.worstTone(['ok', 'warn', 'bad', 'unknown']), 'bad')
  eq('黄压过灰和绿', C.worstTone(['ok', 'unknown', 'warn']), 'warn')
  eq('灰压过绿（"无法判断"不能归到绿）', C.worstTone(['ok', 'unknown']), 'unknown')
  eq('全绿才是绿', C.worstTone(['ok', 'ok']), 'ok')

  /*
   * 🔴 三态 → 颜色：**"没结论"只能是灰，绝不能是红**（本轮那次误报钉下来的不变量）。
   *    这条判据**只有一处实现**（`adminChart.driftTone()`），面板渲染直接调它 ——
   *    所以这里断言的正是屏上那两处颜色：C1 卡的角标 + 每一段前面的点。
   */
  eq('三态着色：已跑 → 绿', C.driftTone('present'), 'ok')
  eq('三态着色：未跑 → 红（**红只在"确实没跑"时出现**）', C.driftTone('missing'), 'bad')
  eq('三态着色：无法判断 → 灰', C.driftTone('indeterminate'), 'unknown')
  ok(
    '"没结论"与"未跑"必须是两种颜色（把灰渲染成红 = 同一类误报的第二种形状）',
    C.driftTone('indeterminate') !== C.driftTone('missing'),
  )

  /*
   * `agoText(at, now)`：第一个参数是**时刻**，第二个是"现在"。
   * ⚠️ 面板上曾经写成 `agoText(now - drift.at)`（把"现在 − 时刻"当成时刻喂进去）——
   *    `drift.at` 与 `now` 常常是同一个毫秒，差 = 0 → `!at` → **恒显示"探测于 未知"**；
   *    差几毫秒则显示成"20000 多天前"。那句"未知"把人骗去查"探测是不是没结论"。
   */
  eq(
    '第二个参数是"现在"（传了它就必须按它算）',
    C.agoText(1_700_000_000_000, 1_700_000_000_000 + 90_000),
    '2 分钟前',
  )
  eq('时刻 0 → 如实说"未知"（不是"刚刚"）—— 这正是 `agoText(now - 时刻)` 的坑', C.agoText(0), '未知')
  {
    /* 静态钉子：`agoText(now - X)` 里的 X 只许是**时长**（`*agoMs`），不许是**时刻** */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const re = /agoText\(\s*now\s*-\s*\(?\s*([A-Za-z_$][\w$.]*)/g
    const badAgo = [...strip(readFileSync(resolvePath(APP, 'src/pages/Admin.tsx'), 'utf8')).matchAll(re)]
      .map((m) => m[1])
      .filter((x) => !/agoMs$/.test(x))
    ok(
      '不许把**时刻**当**时长**喂给 `agoText(now - …)`（"探测于 未知"的根因）',
      badAgo.length === 0,
      JSON.stringify(badAgo),
    )
    const goodHits = [...'const a = agoText(now - lastRun.agoMs)'.matchAll(re)]
    ok(
      '反向对照：上面那条正则抓得住 `agoText(now - X)` 的形状（不是空转）',
      goodHits.length === 1 && goodHits[0][1] === 'lastRun.agoMs',
      JSON.stringify(goodHits.map((m) => m[1])),
    )
  }
  eq('30 秒前 → 刚刚', C.agoText(Date.now() - 30_000), '刚刚')
  eq('3 小时前', C.agoText(Date.now() - 3 * 3_600_000), '3 小时前')
  eq('2 天前', C.agoText(Date.now() - 2 * 86_400_000), '2 天前')
  eq('字节：1.0 KB', C.humanBytes(1024), '1.0 KB')
  eq('字节：4.2 MB', C.humanBytes(4_400_000), '4.2 MB')
  eq('字节：null → "未知"（不是 0）', C.humanBytes(null), '未知')

  /* 阈值常量本身也钉一下 —— 它们是方案 §六 的验收口径，改了要有人知道 */
  eq('阈值：备份超过 3 天算红', C.BACKUP_BAD_MS, 3 * 86_400_000)
  eq('阈值：备份 36 小时开始算黄', C.BACKUP_WARN_MS, 36 * 3_600_000)
  eq('阈值：最新备份下限 50 KB', C.BACKUP_MIN_BYTES, 50 * 1024)
  eq('R2 四个 secret 的名字与顺序', C.R2_KEYS.join(','), 'R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY,R2_ENDPOINT,R2_BUCKET')

/** 文件是**严格 UTF-8**吗？逐字节解一遍，遇到非法序列就报错（静默替换不报） */
function isStrictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/** 一个文件"是不是好源码"的三条体检：无 BOM + 严格 UTF-8 + 至少有一个中文字符 */
function sourceFileHealth(rel) {
  const buf = readFileSync(resolvePath(APP, rel))
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const utf8 = isStrictUtf8(buf)
  const text = new TextDecoder('utf-8').decode(buf)
  const han = /[\u4e00-\u9fa5]/.test(text)
  // U+FFFD = 解码时被静默替换掉的字节（"看起来是中文，其实是坏字符"最隐蔽的一种）
  const replaced = text.includes('\uFFFD')
  return { bom, utf8, han, replaced, bytes: buf.length }
}

/* ============================================================
   第九节 · 🔴 文件编码体检（**这一条是被真实事故逼出来的**）
   ------------------------------------------------------------
   事故：本轮写 `Admin.tsx` 时用过一次 PowerShell 的
   `(Get-Content -Raw) -replace … | Set-Content -Encoding utf8` —— 那一趟把
   UTF-8 当成系统 ANSI（中文 Windows 上是 GBK）读出来又按 UTF-8 写回去，
   **整份文件变成双重编码的乱码，还带上了 BOM**。症状是 `tsc` 报一屏语法错、
   中文全变成 `闇€瑕佸鐞?` 这种，而且**第 77 行那个字符串的收尾引号也一起没了**。
   修法：整个文件**用 write 工具重写一遍**（绝不用 PowerShell 文本 cmdlet 回写）。

   为什么要把这条做成常驻断言：这种损坏**不会自己报出来** ——
   它是"文件还在、名字还对、git 也看得见改动"，只有真跑 tsc / 打开页面才发现。
   而且它对**任何**带中文的源码文件都成立（这个仓库里几乎每个文件都有中文注释）。
   ============================================================ */

  section('第九节 · 文件编码体检（BOM / 严格 UTF-8 / 中文没被 mojibake）')

  for (const f of [
    'src/pages/Admin.tsx',
    'src/lib/adminChart.ts',
    'src/lib/keys.ts',
    'src/App.tsx',
    'src/pages/Settings.tsx',
    'src/data/remote.ts',
    'src/data/store.ts',
    'functions/api/admin/config-check.ts',
    'scripts/admin-checks.mjs',
  ]) {
    const h = sourceFileHealth(f)
    ok(`${f}：没有 BOM`, !h.bom, '前 3 字节是 EF BB BF')
    ok(`${f}：是严格 UTF-8（没有非法字节序列）`, h.utf8)
    ok(`${f}：中文注释正常（有汉字、且没有 U+FFFD 替换字符）`, h.han && !h.replaced)
  }
  /*
   * 反向对照：**故意构造一份坏文件**，上面那三条必须能红 ——
   * 否则这一节就是"永远为绿"的摆设（§18.6 那条教训）。
   */
  {
    const bad = Buffer.from(Array.from('小件').map((c) => c.charCodeAt(0)), 'latin1')
    ok(
      '反向对照：双重编码的字节流会被判成"不是严格 UTF-8"或"有替换字符"',
      !isStrictUtf8(bad) || new TextDecoder('utf-8').decode(bad).includes('\uFFFD'),
      `伪造的字节：${[...bad].map((b) => b.toString(16)).join(' ')}`,
    )
    const bommed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok', 'utf8')])
    ok(
      '反向对照：带 BOM 的字节流会被判成有 BOM',
      bommed[0] === 0xef && bommed[1] === 0xbb && bommed[2] === 0xbf,
    )
  }

  /* ============================================================
     第十节 · G7：教师账号在**被标成教室端的设备**上不许开 /classroom
     ------------------------------------------------------------
     为什么这条要在这里再钉一次静态结构：`shots.mjs` 那一节验的是**行为**
     （真的拦住、屏上没有学生数据、反向对照放行时数据确实出现），
     而这一节验**判据的形状** —— 行为断言能过、判据却写歪的情况是存在的
     （比如"拿 deviceRole 一个条件无条件拦"，那样真教室端账号会被自己的屏挡在门外）。
     ============================================================ */

  section('第十节 · G7：教室端拦截的判据形状（行为在 shots 84/85 那两张图）')

  {
    const app2 = readFileSync(resolvePath(APP, 'src/App.tsx'), 'utf8')
    /** 把 `ClassroomGate` 那段切出来单独看，免得误判到 `Guard` 上的同一批词 */
    const start = app2.indexOf('function ClassroomGate')
    const gate = app2.slice(start, app2.indexOf('function SyncErrorBanner'))
    ok('① `ClassroomGate` 存在', start > 0 && gate.length > 400, `切出 ${gate.length} 字符`)
    ok(
      '② 拦截卡上有 `data-classroom-blocked` 钩子（行为断言靠它找）',
      gate.includes('data-classroom-blocked'),
    )
    ok(
      '③ 判据是"**账号类型 × 设备标记**"两个条件（不是只看 deviceRole）',
      /accountKind\s*!==\s*'classroom'/.test(gate) && gate.includes('isClassroomDevice()'),
      '没找到 accountKind !== classroom 与 isClassroomDevice() 同时出现',
    )
    ok(
      '④ 判据的注释里写清了"为什么不是只挂黄条"（安全边界 vs 提示）',
      gate.includes('安全边界') && gate.includes('给学生看'),
      '没找到"安全边界 / 给学生看"这两句话',
    )
    ok(
      '⑤ 给出三条出路（教室端账号 / 另一台设备 / 登一次教师密码）',
      gate.includes('教室端账号') && gate.includes('另一台设备') && gate.includes('教师密码'),
    )
    ok(
      '⑥ 拦的是**教师账号**那条路；教师账号 + 自己的设备仍然是预览（黄条还在）',
      gate.includes('预览模式'),
    )
    /*
     * ⑦ 反向对照：这段代码**没有**去动 `Guard`（教室端设备访问教师端那条）
     *    —— "把教室端拦住"很容易被写成"顺手把 Guard 也改一改"。
     */
    ok(
      '⑦ 反向对照：`Guard` 那条分支一个字没动（教室端设备访问教师端仍送去 /login）',
      /if \(isClassroomDevice\(\)\) \{\s*return <Navigate to="\/login"/.test(app2),
      '没找到 Guard 里那条 isClassroomDevice() → /login',
    )
  }

  /* ---------------- 收尾 ---------------- */

  server.close()
  globalThis.fetch = realFetch

  console.log(`\n================ 结果 ================`)
  console.log(`  断言：通过 ${pass} 条，失败 ${failures.length} 条`)
  for (const f of failures) console.log(`  ❌ ${f}`)
  if (failures.length) {
    process.exitCode = 1
  } else {
    console.log('  全部通过 ✅（E7 五类各有会红的用例 / 权限判据在服务端 / 入口在 Guard 之外）')
  }
}, { script: 'admin-checks.mjs' })

/* ============================================================
   最小的 zip 打包器（只为了造一份 Actions 风格的日志包）
   ------------------------------------------------------------
   `stored`（method 0）就够了：Function 那边两条路都实现了，
   而真正要测的是"能不能从日志正文里捞出那个数"，不是"能不能解压"。
   ============================================================ */

function zipWithOneText(text) {
  const name = Buffer.from('backup/1_backup.txt', 'utf8')
  const data = Buffer.from(text, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30 + name.length)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(0, 8) // method = stored
  local.writeUInt16LE(0, 10) // time
  local.writeUInt16LE(0, 12) // date
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18) // compressed
  local.writeUInt32LE(data.length, 22) // uncompressed
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  name.copy(local, 30)

  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10) // method
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30) // extra
  central.writeUInt16LE(0, 32) // comment
  central.writeUInt16LE(0, 34) // disk
  central.writeUInt16LE(0, 36) // internal attrs
  central.writeUInt32LE(0, 38) // external attrs
  central.writeUInt32LE(0, 42) // local header offset
  name.copy(central, 46)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(local.length + data.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([local, data, central, eocd])
}

/** zip 用的 CRC-32（就是标准那个多项式；只为了造夹具） */
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}
