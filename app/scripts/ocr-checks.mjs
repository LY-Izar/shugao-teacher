/**
 * `functions/api/ocr.ts` 的**调用者自校验**回归（纯 Node，不用浏览器、不开端口、不用锁）。
 *
 * 为什么要有它：这个 Function 以前**谁都能调** —— 知道 `<站点>/api/ocr` 就能拿学校的
 * DeepSeek 额度去识别任意图片。加门禁这件事有两个方向都会出错，而且都**看不出来**：
 *   · 挡得太松 → 等于没加（攻击面原样保留，日志上什么异常都没有）；
 *   · 挡得太紧 → **教室端「拍课表识别」当场坏掉**（那台机器用的是教室端账号），
 *     而它坏起来只是"识别失败"一句话，没人会想到是这轮改的。
 * 所以两个方向都要断言：**未登录 = 一个字节都不发给 DeepSeek；教室端 = 照样能用**。
 *
 * 做法：**import 仓库里真的那个文件**（Node 原生类型剥离），只把全局 `fetch` 换成假的，
 * 按调用目标（Auth / teachers / DeepSeek）分别回不同的答案，并记下每一次调用。
 * 不是复刻一份逻辑 —— 改 Function = 改被测对象。
 *
 * 跑法（在 `app/` 下）：`node scripts/ocr-checks.mjs`  退出码 0 = 全过。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 🔴 2026-10-17：`ocr.ts` 现在 `import { audit, countRecentActions } from './_lib/supa'
//   （为配额判据，见该文件 `OCR_DAILY_CAP`）。`ocr.ts` 里这是**第一条**相对导入，
//   而 `_lib/supa.ts` 是无扩展名路径 —— Node 的 ESM 两样都不认 ⇒ 报 ERR_MODULE_NOT_FOUND。
//   补上回归脚本通用的那个解析钩子（`grade-checks` / `shots` 已经在用它），
//   让被测对象底下那一层跟着一起是真的，而不是复刻。
import { registerTsResolve } from './lib/ts-resolve.mjs'

registerTsResolve()

const HERE = new URL('.', import.meta.url)
const OCR_TS = new URL('../functions/api/ocr.ts', HERE).href

const failures = []
let checks = 0
function ok(name, cond, extra = '') {
  checks++
  if (cond) console.log(`  ✅ ${name}`)
  else {
    console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`)
    failures.push(name)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/* ---------------- 假 fetch ---------------- */
/*
 * 三个上游各有各的答案：
 *   /auth/v1/user        → 令牌认不认
 *   /rest/v1/teachers    → 这个 uid 是不是本校账号（RLS 那一句）
 *   /rest/v1/admin_audit → 🔴 配额判据 / 成功后的记账（2026-10-17 加，随 `_lib/supa` 一起进来）
 *   api.deepseek.com     → 真的"识别"（这里只回一段合法 JSON）
 */
const BASE = 'https://fake.supabase.co'
const calls = []
/** 🔴 假的 `admin_audit`：配额读数与记账都落这一张。`scenario.audit` 决定"有多少行"（也就是"已经用了几张"）。 */
function makeFetch({ user = null, teachers = 'missing', deepseek = 'ok', audit = null } = {}) {
  return async (url, init = {}) => {
    const u = String(url)
    calls.push({
      // 🔴 method **必须真的记**（记账那一路是显式 POST、读数是缺省 GET）。
      method: init.method ?? 'GET',
      url: u,
      auth: init.headers?.Authorization ?? '',
      body: init.body ?? null,
    })

    if (u.includes('/auth/v1/user')) {
      if (!user) return new Response('{"msg":"invalid token"}', { status: 401 })
      return new Response(JSON.stringify({ id: user }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u.includes('/rest/v1/teachers')) {
      if (teachers === 'missing') {
        return new Response('{"code":"42P01","message":"relation \\"teachers\\" does not exist"}', {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (teachers === 'none') return new Response('[]', { status: 200 })
      return new Response(`[{"id":"${teachers}"}]`, { status: 200 })
    }
    if (u.includes('/rest/v1/admin_audit')) {
      // 两路都到这张表：读数（GET，count=exact）与记账（POST）。
      const n = audit ?? 0
      if (!init.method || init.method === 'GET') {
        const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (u.includes('api.deepseek.com')) {
      if (deepseek === 'http500') return new Response('boom', { status: 500 })
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"numbers":[{"value":12,"confidence":"high"}]}' }, finish_reason: 'stop' }],
          usage: { total_tokens: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error(`假的 fetch 不认识这个地址：${u}`)
  }
}

/** 一次调用：换掉全局 fetch → 调真 Function → 还原 */
async function callOcr({ env, headers = {}, body = {}, scenario = {} }) {
  const mod = await import(`${OCR_TS}?t=${Math.random()}`)
  const real = globalThis.fetch
  calls.length = 0
  globalThis.fetch = makeFetch(scenario)
  try {
    const req = new Request('https://shugao.test/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const res = await mod.onRequestPost({ request: req, env })
    const text = await res.text()
    let payload = {}
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
    return {
      status: res.status,
      payload,
      deepseekCalls: calls.filter((c) => c.url.includes('deepseek')),
      /* 🔴 2026-10-17：让第 4 节能看见 `admin_audit` 的读数（GET）与记账（POST）——
         method 由假 fetch 一路记下来（سك выше），这里原样透传、不做推断。 */
      /* 🔴🔴 必须是**快照**（2026-10-17 踩到真身才补上）：`calls` 是**模块级共享数组**，
         而 `callOcr()` 每次开头 `calls.length = 0` —— 直接透传引用会把**上一个 caller**
         的记录一起清掉 ⇒ q2/q3 跑完，q1 的 upstreamCalls 就是空数组 ⇒
         "成功要记账" 那条判据**恒红**（且看起来像 Function 没记账 —— 极难分辨）。
         断言时刻快照一份才有意义：`[...calls]`（浅拷贝够用，元素是只读对象）。 */
      upstreamCalls: [...calls],
    }
  } finally {
    globalThis.fetch = real
  }
}



const GOOD_ENV = {
  DEEPSEEK_API_KEY: 'sk-test',
  SUPABASE_URL: BASE,
  SUPABASE_ANON_KEY: 'anon-test',
}
const IMG = 'data:image/jpeg;base64,AAAA'
const TOKEN = 'header.payload.signature'

console.log('ocr.ts 调用者自校验回归（import 真文件 + 假 fetch）')
console.log(`被测文件：${OCR_TS.replace(/^file:\/\/\//, '')}`)

/* ---------------- 0. 抠代码：门禁在不在 ----------------
 * 这一组是"**别把门禁删了还以为测试全绿**"的锚点：
 * 全部靠上面的行为断言兜住，但如果有人把门禁挪到读 body 之后，
 * 行为断言看不出来（结果一样）—— 所以顺便钉一下**顺序**。
 */
section('0. 门禁在源码里的位置（顺序也是要求）')
const src = readFileSync(fileURLToPath(OCR_TS), 'utf8')
const iAuth = src.indexOf('const me = await caller(request, env)')
const iBody = src.indexOf('await request.json()')
ok('源码里调了 caller(request, env)（真的验了 JWT）', iAuth > 0)
ok('源码里调了 isSchoolMember(', src.includes('await isSchoolMember(env, me.token, me.id)'))
ok(
  '🔴 门禁在读 body **之前**（否则任何人可以先塞一张大图进来）',
  iAuth > 0 && iBody > 0 && iAuth < iBody,
  `caller@${iAuth} body@${iBody}`,
)

/* ---------------- 1. 挡住的那些 ---------------- */
section('1. 不该放行的，一律不放行（且一个字节都不发给 DeepSeek）')

const r1 = await callOcr({
  env: { ...GOOD_ENV, DEEPSEEK_API_KEY: '' },
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect' },
  scenario: { user: 'u1', teachers: 'u1' },
})
ok('没配 DEEPSEEK_API_KEY → 503 + not_configured（原来的行为不变）', r1.status === 503 && r1.payload.status === 'not_configured', JSON.stringify(r1.payload))
ok('  且没打上游', r1.deepseekCalls.length === 0)

const r2 = await callOcr({
  env: { DEEPSEEK_API_KEY: 'sk-test' },
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect' },
})
ok('缺 SUPABASE_URL / ANON_KEY → 503 + 人话（不是 500）', r2.status === 503 && /没配好/.test(r2.payload.message ?? ''), JSON.stringify(r2.payload))
ok('  且没打上游', r2.deepseekCalls.length === 0)

const r3 = await callOcr({
  env: GOOD_ENV,
  headers: {},
  body: { image: IMG, scene: 'collect' },
  scenario: { user: 'u1', teachers: 'u1' },
})
ok('🔴 不带 Authorization → 401（这就是"知道地址就能烧配额"的那个洞）', r3.status === 401, `status=${r3.status} ${JSON.stringify(r3.payload)}`)
ok('  报的是人话（"登录已过期，请重新登录…"）', /登录/.test(r3.payload.message ?? ''))
ok('🔴 一个字节都没发给 DeepSeek', r3.deepseekCalls.length === 0)

const r4 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: 'Bearer forged-token' },
  body: { image: IMG, scene: 'collect' },
  scenario: { user: null },
})
ok('令牌无效（Auth 回 401）→ 401', r4.status === 401, `status=${r4.status}`)
ok('  一个字节都没发给 DeepSeek', r4.deepseekCalls.length === 0)

const r5 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect' },
  scenario: { user: 'outsider', teachers: 'none' },
})
ok('登录了、但 teachers 里没有他（不是本校账号）→ 403', r5.status === 403, `status=${r5.status} ${JSON.stringify(r5.payload)}`)
ok('  报的是人话（"不是本校的教师账号"）', /本校/.test(r5.payload.message ?? ''))
ok('  一个字节都没发给 DeepSeek', r5.deepseekCalls.length === 0)

const r6 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect' },
  scenario: { user: 'u1', teachers: 'missing' },
})
ok('库还没建 teachers（42P01）→ 503 + 指向 schema.sql', r6.status === 503 && /schema\.sql/.test(r6.payload.message ?? ''), JSON.stringify(r6.payload))
ok('  一个字节都没发给 DeepSeek', r6.deepseekCalls.length === 0)

/* ---------------- 2. 放行的那些 ---------------- */
section('2. 本校账号照常能用（教师 + 教室端 —— 别把现成功能挡坏）')

const r7 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect', nos: ['1', '2'] },
  scenario: { user: 'teacher-1', teachers: 'teacher-1' },
})
ok('教师账号 → 200', r7.status === 200, `status=${r7.status} ${JSON.stringify(r7.payload).slice(0, 200)}`)
ok('  识别结果正常返回（status: ok + numbers）', r7.payload.status === 'ok' && Array.isArray(r7.payload.data?.numbers))
ok('  确实打了一次 DeepSeek', r7.deepseekCalls.length === 1)
ok(
  '  转发给 DeepSeek 时带的是**服务端的** API Key（不是调用者的 JWT）',
  /^Bearer sk-test$/.test(r7.deepseekCalls[0]?.auth ?? ''),
  `实际：${r7.deepseekCalls[0]?.auth}`,
)

// 教室端账号：`handle_new_user` 给每个 auth 用户都建了 teachers 行，
// 所以它在库里长得就是"本校账号" —— 教室端的「拍课表识别」靠这一条活着。
const r8 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'schedule', className: '高二(4)班' },
  scenario: { user: 'classroom-account-1', teachers: 'classroom-account-1' },
})
ok('🔴 教室端账号（教室一体机的「拍课表」）→ 200 —— 这条挡掉就是弄坏现成功能', r8.status === 200, `status=${r8.status}`)
ok('  确实打了一次 DeepSeek', r8.deepseekCalls.length === 1)

const r9 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'roster' },
  scenario: { user: 'admin-1', teachers: 'admin-1', deepseek: 'http500' },
})
ok('上游 DeepSeek 挂掉 → 502 + 人话（门禁不该把这个翻译成 401/403）', r9.status === 502 && /识别服务返回/.test(r9.payload.message ?? ''), `status=${r9.status} ${JSON.stringify(r9.payload)}`)

/* ---------------- 3. 顺序：未登录时*连*「图片太大」都不该先报 ---------------- */
section('3. 未登录的请求不会因为"图片太大/格式不对"得到别的答案（顺序锚点）')
const r10 = await callOcr({
  env: GOOD_ENV,
  headers: {},
  body: { image: 'not-an-image' },
  scenario: { user: 'u1', teachers: 'u1' },
})
ok('未登录 + 假图片 → 仍然只报 401（不给攻击者任何额外信息）', r10.status === 401 && r10.payload.status === 'error', `status=${r10.status} ${JSON.stringify(r10.payload)}`)

/* ══════════════════════════════════════════════════════════════════════════
   4. 配额（2026-10-17）：/api/ocr 打的是**付费**接口，原来一个字都不限。
   三个方向都要断言 —— 挡得太松 = 配额不存在；挡得太紧 = 正常用一次就废；
   不记账 = 下一轮读数永远 0 = 配额自己失灵。
   ══════════════════════════════════════════════════════════════════════════ */
section('4. 配额（付费接口的保护层）：读数 ≥ 上限 → 429 · 成功 → 记账 · 失败 → 不记账')

const OCR_CAP_DIFFERENCE = 40 // 与 functions/api/ocr.ts 的 OCR_DAILY_CAP 对号（写死，便于跨文件信任）

/** condition: 假 audit 表里有几行 = "这位老师已经用掉几张"。 */
const q1 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect', nos: ['1'] },
  scenario: { user: 'teacher-1', teachers: 'teacher-1', audit: 0 },
})
ok('🔴 配额读数 0 → 照常识别（正常用量**一次都不会被误杀**）', q1.status === 200 && q1.payload.status === 'ok', `status=${q1.status}`)

const q2 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'collect', nos: ['1'] },
  scenario: { user: 'teacher-1', teachers: 'teacher-1', audit: OCR_CAP_DIFFERENCE },
})
ok(
  `🔴 读数已到上限（${OCR_CAP_DIFFERENCE}）→ 429 + **一个字节都不发给 DeepSeek**（付费额度不再可被一人烧光）`,
  q2.status === 429 && q2.deepseekCalls.length === 0,
  `status=${q2.status} · deepseek 调用 ${q2.deepseekCalls.length} 次（期望 0）`,
)

/* 反向对照（对**真源码**本身）：判据退化成 "used > CAP"（差一）或 "读不到也挡" 都要立刻被看出来 */
const OCR_SRC = src // ← 第 0 节里读好的那段
ok(
  '🧪④ 对照① 判据用的是 `>=`（读数恰好等于上限就挡 —— 差一会让配额形同虚设）',
  OCR_SRC.includes('used !== null && used >= OCR_DAILY_CAP') && !OCR_SRC.includes('used > OCR_DAILY_CAP)'),
  `源码里 \`used >= OCR_DAILY_CAP\` = ${OCR_SRC.includes('used >= OCR_DAILY_CAP')}`,
)
ok(
  '🧪④ 对照② 读不到时**放行**（`used !== null` 前置 —— §三.4 的三态，读不到 ≠ 读到 0）',
  OCR_SRC.includes('if (used !== null && used >= OCR_DAILY_CAP)'),
)

/* 记账那一路是显式 POST —— `audit()` 里给的就是 `init.method`（下 `svc()` 透传），
   假 fetch 已把 method 原样记下（不需要推断）。这里**避开已加过的 GET**（配额读数）。 */
const POST_AUDIT = (q1.upstreamCalls ?? []).find(
  (c) => c.method === 'POST' && c.url.includes('/rest/v1/admin_audit'),
)
ok(
  '🔴 成功一次 → **记账**（POST admin_audit；漏了这一行，下一轮读数仍 0 ⇒ 配额永不挡人）',
  POST_AUDIT !== undefined,
  `记账：${POST_AUDIT ? '在' : '没有'} · q1 上游共 ${(q1.upstreamCalls ?? []).length} 次调用`,
)
ok(
  '   记账里**没有四位数以上的号**（这张表会跟着备份走 —— §二十四的同一句纪律）',
  !POST_AUDIT || !/[0-9]{4,}/.test(POST_AUDIT.body ?? ''),
  `target 片段 = ${(POST_AUDIT?.body ?? '').slice(0, 80)}`,
)

// 🔴 失败不消耗额度：DeepSeek 挂（502）→ 那一行**不**写进去。
const q4 = await callOcr({
  env: GOOD_ENV,
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: { image: IMG, scene: 'roster' },
  scenario: { user: 'teacher-1', teachers: 'teacher-1', deepseek: 'http500', audit: 0 },
})
const failedRecords = (q4.upstreamCalls ?? []).filter(
  (c) => c.method === 'POST' && c.url.includes('/rest/v1/admin_audit'),
)
ok('🔴 DeepSeek 挂掉（502）→ **不记账**（失败不该消耗额度）', q4.status === 502 && failedRecords.length === 0, `status=${q4.status} · 记账 ${failedRecords.length} 次（期望 0）`)

console.log('')
if (failures.length) {
  console.log(`❌ ocr.ts 自校验回归失败：${failures.length}/${checks} 条不过`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✅ ocr.ts 自校验回归全部通过：${checks} 条断言`)
console.log('   （未登录/非本校 → 401/403 且零上游调用；教师与教室端 → 照常识别；门禁在读 body 之前）')
