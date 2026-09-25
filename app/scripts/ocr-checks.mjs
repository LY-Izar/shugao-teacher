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
 *   api.deepseek.com     → 真的"识别"（这里只回一段合法 JSON）
 */
const BASE = 'https://fake.supabase.co'
const calls = []

function makeFetch({ user = null, teachers = 'missing', deepseek = 'ok' } = {}) {
  return async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, auth: init.headers?.Authorization ?? '', body: init.body ?? null })

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
    return { status: res.status, payload, deepseekCalls: calls.filter((c) => c.url.includes('deepseek')) }
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

console.log('')
if (failures.length) {
  console.log(`❌ ocr.ts 自校验回归失败：${failures.length}/${checks} 条不过`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✅ ocr.ts 自校验回归全部通过：${checks} 条断言`)
console.log('   （未登录/非本校 → 401/403 且零上游调用；教师与教室端 → 照常识别；门禁在读 body 之前）')
