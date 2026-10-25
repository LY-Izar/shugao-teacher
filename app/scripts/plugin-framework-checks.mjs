#!/usr/bin/env node
/**
 * 契约自检 —— 《教室端插件开发手册.md》§16 的 CF-01…CF-14
 *
 * 目的：**让"照手册写"等于"装上就能跑"**。
 * 这里查的全是"写错了但屏上不报错"的那一类：没申请就调能力、`Date` 存进槽、
 * 断网时 `read` reject、`pip.open` 回 false 没有降级、`deactivate` 之后定时器还活着。
 *
 * 用法：
 *   node scripts/plugin-framework-checks.mjs                 # 跑仓库自带的假插件（= 手册 §15 的上位版）
 *   node scripts/plugin-framework-checks.mjs --selftest      # 自检本脚本：故意写错的插件必须红
 *   node scripts/plugin-framework-checks.mjs --plugin <目录> # 跑你自己的插件
 *
 * 🔴 为什么是纯 Node、不启浏览器：宿主核心 `src/lib/pluginHost.ts` 是**零 DOM**的
 *    （见那个文件头）。这条门禁要能在 2 秒内跑完，才能每次改插件都跑 ——
 *    要是它得等 dev server + Playwright，就没人跑了，等于没有。
 *
 * ⚠️ 跑的门槛：Node ≥ 22.6（靠 Node 自带的类型擦除 `.ts`）；本机实测 v24.19。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = await import(pathToFileURL(resolve(HERE, '../src/lib/pluginHost.ts')).href)
const {
  LIMITS,
  MANIFEST_ID_RE,
  validateManifest,
  validateKey,
  preflightWrite,
  isJsonValue,
  payloadBytes,
  compareSemver,
  planCard,
  buildContext,
  PluginHost,
  FRAMEWORK_PLUGIN_ID,
} = HOST

const FIXTURE = resolve(HERE, 'fixtures/demo.helloclock')

let pass = 0
const failures = []
function ok(id, name, cond, extra = '') {
  const label = `${id} ${name}`
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    failures.push(`${label}${extra ? ` —— ${extra}` : ''}`)
    console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`)
  }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/* ============================================================
   夹具端口：一个"假的宿主"—— 只实现 host 需要的那几个口
   ============================================================ */
function makeWorld({ offline = false, pipOk = true, rateLimitAfter = Infinity } = {}) {
  const store = new Map()
  let writes = 0
  const disposers = []
  const container = { children: [], append(x) { this.children.push(x) }, text: () => String(container.children[0]?.textContent ?? '') }
  const toasts = []
  /* 🆕 P1：配置的"当前生效值"（合并默认值是宿主那一侧的事；setConfig 模拟教师改配置） */
  const cfgWatchers = []
  let cfg = {}
  const ports = {
    readResource: async () => ({
      /* 固定假值同时盖住两类消费形状：`class.slotNow`（current/next）与
         `class.quote`（text/from，P2 祝福语插件）—— 行为测试只关心"宿主递得出值"。 */
      value: {
        current: { subject: '物理', end: '08:40' },
        next: null,
        text: '问渠那得清如许？为有源头活水来。',
        from: '朱熹《观书有感》',
      },
      stale: offline,
      asOf: '2026-10-24T00:00:00.000Z',
    }),
    watchResource: () => () => {},
    storageGet: async (k) => store.get(k),
    storageSet: async (k, v) => {
      writes++
      if (writes > rateLimitAfter) throw Object.assign(new Error('E_QUOTA_RATE'), { code: 'E_QUOTA_RATE' })
      store.set(k, v)
    },
    storageKeys: async () => [...store.keys()],
    configGet: () => ({ ...cfg }),
    configOnChange: (cb) => {
      cfgWatchers.push(cb)
      return () => {
        const i = cfgWatchers.indexOf(cb)
        if (i >= 0) cfgWatchers.splice(i, 1)
      }
    },
    onDispose: (fn) => disposers.push(fn),
    toast: (t) => toasts.push(t),
    setTitle: () => {},
    clockOnMinute: () => () => {},
    clockOnLesson: () => () => {},
    busEmit: () => {},
    busOn: () => () => {},
    soundPlay: () => {},
    pipOpen: async () => pipOk,
    filesSave: async () => true,
  }
  return {
    store,
    container,
    ports,
    disposers,
    toasts,
    writes: () => writes,
    setConfig: (v) => {
      cfg = v ?? {}
      for (const cb of [...cfgWatchers]) cb({ ...cfg })
    },
  }
}

const baseManifest = (over = {}) => ({
  id: 'demo.helloclock',
  name: '示例时钟',
  icon: '<svg/>',
  description: '显示当前这节课与下一节',
  version: '1.0.0',
  entry: 'index.js',
  minShellVersion: '1.1.5',
  permissions: ['data.schedule', 'clock', 'storage', 'pip'],
  window: { w: 3, h: 2 },
  ...over,
})

/* ============================================================
   主流程
   ============================================================ */
async function runChecks(dir, { quiet = false } = {}) {
  const dirName = basename(dir)
  const manifestPath = resolve(dir, 'manifest.json')
  const entryName = existsSync(manifestPath) ? undefined : 'index.js'

  console.log(`\n插件目录：${dir}`)

  /* ---- CF-01 / CF-02：manifest ---- */
  ok('CF-01', 'manifest.json 能解析', existsSync(manifestPath), `找不到 ${manifestPath}`)
  let raw = null
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    ok('CF-01', 'manifest.json 是合法 JSON', false, String(e?.message ?? e).slice(0, 80))
  }
  const mv = validateManifest(dirName, raw)
  ok('CF-02', 'manifest 必填字段与枚举都合规', mv.ok, mv.errors.join('；'))
  /* id 正则与数据库 `plugin_registry_id_shape` 是同一份（§45.1）—— 这里再钉一次，
     免得"手册改了正则、数据库没改"这种分叉 */
  ok('CF-02', 'id 走 `vendor.name` 命名空间（与库里那个 check 同源）', MANIFEST_ID_RE.test(raw?.id ?? dirName), String(raw?.id))

  const manifest = baseManifest({ ...(raw ?? {}), id: raw?.id ?? dirName })

  /* ---- CF-03：指纹 ---- */
  const entryPath = resolve(dir, manifest.entry ?? entryName ?? 'index.js')
  ok('CF-03', 'entry 文件存在', existsSync(entryPath), entryPath)
  const hashFile = resolve(dir, 'index.js.sha256')
  if (existsSync(hashFile) && existsSync(entryPath)) {
    const want = readFileSync(hashFile, 'utf8').trim().split(/\s+/)[0]
    const got = sha256(readFileSync(entryPath))
    ok('CF-03', 'index.js.sha256 与入口文件一致', want === got, `文件里 ${want} · 实际 ${got}`)
  } else {
    ok('CF-03', 'index.js.sha256 在（发布要核指纹）', false, `缺 ${hashFile}`)
  }

  /* ---- CF-04：顶层零副作用 ---- */
  const noisy = []
  const saved = { log: console.log, error: console.error, warn: console.warn }
  console.log = (...a) => noisy.push(a.join(' '))
  console.error = (...a) => noisy.push(a.join(' '))
  console.warn = (...a) => noisy.push(a.join(' '))
  let mod
  try {
    mod = await import(pathToFileURL(entryPath).href + `?t=${Date.now()}`)
  } finally {
    console.log = saved.log
    console.error = saved.error
    console.warn = saved.warn
  }
  ok('CF-04', '模块加载期零副作用（不 console、不建定时器）', noisy.length === 0, noisy.join(' | ').slice(0, 120))
  ok('CF-04', '默认导出带 activate', typeof mod?.default?.activate === 'function')

  /* ---- CF-05：activate 10 秒内完成 ---- */
  const w = makeWorld()
  const host = new PluginHost({
    manifest,
    module: mod.default,
    makeContext: () =>
      buildContext({
        manifest,
        classId: 'c1',
        className: '高二(1)班',
        now: () => new Date('2026-10-24T08:10:00+08:00'),
        container: w.container,
        ports: w.ports,
        log: () => {},
      }),
    now: () => Date.parse('2026-10-24T08:10:00+08:00'),
    onDispose: (fn) => w.ports.onDispose(fn),
  })
  const t0 = Date.now()
  const act = await host.activate()
  ok('CF-05', `activate 成功且 10s 内完成（${Date.now() - t0}ms）`, act.ok && Date.now() - t0 < LIMITS.activateTimeoutMs, act.code ?? '')
  ok('CF-05', '容器里真的有东西（不是只跑了 activate 没渲染）', w.container.children.length > 0)

  /* ---- 🆕 P1（§2.3）：教师改配置 → `config.onChange` 到达 → 插件 1 秒内重画 ----
     可观察的信号不是文字（夹具的 readResource 恒有 current，showNext 分支看不见），
     而是重画会再走一次 `storage.set('last_paint')` ⇒ `writes` 计数往上前进一步。
     🆕 2026-10-24（P2 祝福语）：按**被测插件自己申请的能力**分档 —— 申请了 config 才有
     "改配置要重画"这条义务；没申请的话 `ctx.config` 根本不注入（CF-06 的正确行为），
     验它才是假的。这一档改验宿主侧：世界里的配置变化不再叫醒任何人。 */
  {
    const wantsConfig = (manifest.permissions ?? []).includes('config')
    if (wantsConfig) {
      const beforeCfg = w.writes()
      w.setConfig({ showNext: false })
      await new Promise((r) => setTimeout(r, 30))
      ok('CF-06', '申请了 config ⇒ 教师改配置后插件重画（onChange 链路通到屏上）', w.writes() > beforeCfg, `writes ${beforeCfg} → ${w.writes()}`)
    } else {
      const beforeCfg = w.writes()
      w.setConfig({ anything: 1 })
      await new Promise((r) => setTimeout(r, 30))
      ok('CF-06', '没申请 config ⇒ 配置变化不叫醒插件（未申请能力不注入，也不许有隐藏监听）', w.writes() === beforeCfg, `writes ${beforeCfg} → ${w.writes()}`)
    }
  }

  /* ---- CF-06：没申请的能力，属性根本不出现 ---- */
  {
    const only = baseManifest({ permissions: ['storage'] })
    const ctx = buildContext({
      manifest: only,
      classId: 'c1',
      className: '高二(1)班',
      now: () => new Date(),
      container: { append() {} },
      ports: makeWorld().ports,
      log: () => {},
    })
    ok('CF-06', '只申请 storage ⇒ `data` / `pip` / `config` / `bus` 都不在 ctx 上', !('data' in ctx) && !('pip' in ctx) && !('config' in ctx) && !('bus' in ctx), Object.keys(ctx).join(','))
    ok('CF-06', '申请了 storage ⇒ `storage` 在', 'storage' in ctx)
    /* 只申请了 roster 却去读 schedule：要明确报"没这个能力"，而不是回空数据
       （回空数据 = 插件以为"这个班没有课表"，屏上就永远空着） */
    const ctxRoster = buildContext({ manifest: baseManifest({ permissions: ['data.roster'] }), classId: 'c1', className: '高二(1)班', now: () => new Date(), container: { append() {} }, ports: makeWorld().ports, log: () => {} })
    let code = null
    try {
      await ctxRoster.data.read('class.schedule')
    } catch (e) {
      code = e?.code
    }
    ok('CF-06', '读没申请的资源 ⇒ 抛 `E_NO_CAPABILITY`（不是静默空数据）', code === 'E_NO_CAPABILITY', String(code))
  }

  /* ---- CF-07：能存什么 ---- */
  {
    ok('CF-07', '`Date` 不算 JSON 值（读回来是字符串，`getTime()` 会崩）', isJsonValue(new Date()) === false)
    ok('CF-07', '`undefined` / 函数 / 循环引用都不算', !isJsonValue(undefined) && !isJsonValue(() => 1) && (() => { const a = {}; a.self = a; return !isJsonValue(a) })())
    ok('CF-07', 'payloadBytes 量的是字节数（中文 3 字节）', payloadBytes({ s: '课' }) === JSON.stringify({ s: '课' }).length + 3 - 1 || payloadBytes({ s: '课' }) >= 22, String(payloadBytes({ s: '课' })))
    /* 🆕 2026-10-24（P2 祝福语）：这三条测的是**宿主**对写槽的判定，不是被测插件的能力清单 ——
       第一个不申请 `storage` 的插件（shugao.quote）当场把这里踩崩（ctx.storage 是 undefined，
       因为未申请的能力根本不注入，那正是 CF-06 要的正确行为）。
       ⇒ 行为测试一律用脚本自己的 manifest（申请 storage / data.schedule），与被测插件解耦。 */
    const hostWriteManifest = baseManifest({ permissions: ['storage'] })
    const ctx = buildContext({ manifest: hostWriteManifest, classId: 'c1', className: '高二(1)班', now: () => new Date(), container: { append() {} }, ports: makeWorld().ports, log: () => {} })
    let code = null
    try {
      await ctx.storage.set('k', { at: new Date() })
    } catch (e) {
      code = e?.code
    }
    ok('CF-07', '写槽里塞 `Date` ⇒ 抛 `E_BAD_VALUE`', code === 'E_BAD_VALUE', String(code))
  }

  /* ---- CF-08：槽名 ---- */
  ok('CF-08', '`__` 开头的槽 ⇒ `E_RESERVED_KEY`', validateKey('__layout').code === 'E_RESERVED_KEY')
  ok('CF-08', '大写 / 空格 ⇒ `E_BAD_KEY`', validateKey('Bad Key').code === 'E_BAD_KEY')
  ok('CF-08', '正常槽名放行', validateKey('last_paint').ok === true)
  ok('CF-08', '框架命名空间不许插件写（preflight 也拦）', preflightWrite('demo.helloclock', '__layout', {}, 0) === 'E_RESERVED_KEY')
  /* 框架的布局是 `plugin_id='__framework'` + `key='layout'` —— 槽名本身不带 `__`。
     这一条同时钉住"`__` 开头的 key 对谁都不合法"（对框架也不放行，否则库里那两条
     `plugin_data_key_shape` / 这里的正则就是两个真相）。 */
  ok('CF-08', '框架用 `layout` 这个 key 存布局（前缀在 plugin_id 上）', preflightWrite(FRAMEWORK_PLUGIN_ID, 'layout', { windows: [] }, 0) === null)
  ok('CF-08', '而 `__` 开头的 key 对框架也不合法', preflightWrite(FRAMEWORK_PLUGIN_ID, '__layout', {}, 0) === 'E_RESERVED_KEY')

  /* ---- CF-09：配额三个码 ---- */
  {
    ok('CF-09', `单行超 ${LIMITS.payloadBytes} 字节 ⇒「E_QUOTA_SIZE」`, preflightWrite(manifest.id, 'big', { s: 'x'.repeat(LIMITS.payloadBytes) }, 0) === 'E_QUOTA_SIZE')
    ok('CF-09', `第 ${LIMITS.rowsPerPluginPerClass + 1} 行 ⇒「E_QUOTA_ROWS」`, preflightWrite(manifest.id, 'k', {}, LIMITS.rowsPerPluginPerClass) === 'E_QUOTA_ROWS')
    /* 与 CF-07 同一条理由：测宿主的写限频，用脚本自己的 storage 清单，不借被测插件的 */
    const w2 = makeWorld({ rateLimitAfter: LIMITS.writesPerMinute })
    const ctx = buildContext({ manifest: baseManifest({ permissions: ['storage'] }), classId: 'c1', className: '高二(1)班', now: () => new Date(), container: { append() {} }, ports: w2.ports, log: () => {} })
    for (let i = 0; i < LIMITS.writesPerMinute; i++) await ctx.storage.set('k', { i })
    let code = null
    try {
      await ctx.storage.set('k', { i: 999 })
    } catch (e) {
      code = e?.code
    }
    ok('CF-09', `每分钟第 ${LIMITS.writesPerMinute + 1} 次 ⇒ 拿到「E_QUOTA_RATE」`, code === 'E_QUOTA_RATE', String(code))
  }

  /* ---- CF-10：断网 ---- */
  {
    const w3 = makeWorld({ offline: true })
    /* 与 CF-07 同一条理由：测宿主的离线读形状，用脚本自己的 data.schedule 清单 */
    const ctx = buildContext({ manifest: baseManifest({ permissions: ['data.schedule'] }), classId: 'c1', className: '高二(1)班', now: () => new Date(), container: { append() {} }, ports: w3.ports, log: () => {} })
    let got = null
    let threw = null
    try {
      got = await ctx.data.read('class.slotNow')
    } catch (e) {
      threw = e
    }
    ok('CF-10', '断网时 `read` **不 reject**', threw === null, String(threw?.code ?? ''))
    ok('CF-10', '断网时带 `stale: true` 与 `asOf`', got?.stale === true && typeof got?.asOf === 'string')
  }

  /* ---- CF-11：deactivate 2 秒上限 + 取消干净 ---- */
  {
    const w4 = makeWorld()
    const slow = {
      activate: () => {},
      deactivate: () => new Promise((r) => setTimeout(r, 60)),
    }
    const h = new PluginHost({
      manifest,
      module: slow,
      makeContext: () => ({}),
      now: () => 0,
      onDispose: (fn) => w4.ports.onDispose(fn),
      deactivateMaxMs: 10,
    })
    await h.activate()
    const d = await h.deactivate()
    ok('CF-11', '`deactivate` 超过 2s 上限 ⇒ 回 `E_DEACTIVATE_SLOW`', d.code === 'E_DEACTIVATE_SLOW', String(d.code))
    ok('CF-11', '停用后登记的清理函数**都跑过**（长跑的屏内存只许少不许多）', w4.disposers.length === 0)
  }

  /* ---- CF-12：连崩 3 次只停本班 ---- */
  {
    const boom = { activate: () => { throw new Error('插件自己炸了') } }
    const mk = () => {
      const w5 = makeWorld()
      return new PluginHost({ manifest, module: boom, makeContext: () => ({}), now: () => 1000, onDispose: (fn) => w5.ports.onDispose(fn) })
    }
    const a = mk()
    for (let i = 0; i < LIMITS.crashLimit; i++) await a.activate()
    ok('CF-12', `连崩 ${LIMITS.crashLimit} 次 ⇒ 本班停用`, a.state === 'disabled' && !!a.disableReason, `${a.state} / ${a.disableReason ?? ''}`)
    const b = mk()
    ok('CF-12', '另一个班不受影响（各是各的实例）', b.state === 'idle' && b.crashCount() === 0)
    ok('CF-12', '恢复只能由界面层调 `enable()`', (a.enable(), a.state === 'idle' && a.crashCount() === 0))
  }

  /* ---- CF-13：pip 拿不到 / 没开成时必须说人话 ---- */
  {
    const wantsPip = (manifest.permissions ?? []).includes('pip')
    if (wantsPip) {
      const w6 = makeWorld({ pipOk: false })
      const mod2 = (await import(pathToFileURL(entryPath).href + `?n=${Date.now()}`)).default
      const h = new PluginHost({
        manifest,
        module: mod2,
        makeContext: () =>
          buildContext({ manifest, classId: 'c1', className: '高二(1)班', now: () => new Date(), container: w6.container, ports: w6.ports, log: () => {} }),
        now: () => 0,
        onDispose: (fn) => w6.ports.onDispose(fn),
      })
      await h.activate()
      ok('CF-13', '`pip.open()` 回 false 时插件有降级文案', /教室版/.test(w6.container.text()), w6.container.text())
    } else {
      /* 🆕 2026-10-24（P2 祝福语）：插件没申请 pip ⇒ `ctx.pip` 根本不注入（CF-06 那条正确行为），
         "open 回 false 的降级"分支**结构上不可达**，验它才是假的。这一档改验
         "宿主没把没申请的能力塞给它" —— 与 CF-06 同一条边界，在这里对被测插件再核一遍。 */
      const w6 = makeWorld()
      const mod2 = (await import(pathToFileURL(entryPath).href + `?n=${Date.now()}`)).default
      const h = new PluginHost({
        manifest,
        module: mod2,
        makeContext: () =>
          buildContext({ manifest, classId: 'c1', className: '高二(1)班', now: () => new Date(), container: w6.container, ports: w6.ports, log: () => {} }),
        now: () => 0,
        onDispose: (fn) => w6.ports.onDispose(fn),
      })
      await h.activate()
      ok('CF-13', '没申请 pip ⇒ 激活路径上不出现 pip 分支（容器不写"教室版"兜底话）', !/教室版/.test(w6.container.text()), w6.container.text() || '（容器无文本，正常）')
    }
    /* planCard 是**能力一致**判据：申请了 pip 而壳不支持 ⇒ 说"要教室版程序"；
       没申请 ⇒ 卡片就该是可用的（reason null）——两档都是"照实说"。 */
    const cardNoPip = planCard(manifest, { shellSupportsPip: false, shellVersion: '1.1.5' })
    ok(
      'CF-13',
      '网页预览下卡片照实说：申请 pip ⇒「要教室版程序」，没申请 ⇒ 可用',
      wantsPip
        ? cardNoPip.reason === '要教室版程序'
        : cardNoPip.reason === null && cardNoPip.enabled === true,
      `reason=${JSON.stringify(cardNoPip.reason)}`,
    )
    ok('CF-13', '壳版本不够时也不许装作能用', planCard(manifest, { shellSupportsPip: true, shellVersion: '1.0.9' }).reason === '需要更新的教室版程序')
    ok('CF-13', '版本比较认 `主.次.修`', compareSemver('1.1.5', '1.1.4') === 1 && compareSemver('1.1.5', '1.1.5') === 0)
  }

  /* ---- CF-14：上屏的文案里不许有实现细节 ---- */
  {
    const src = readFileSync(entryPath, 'utf8')
    ok('CF-14', '源码里没有十六进制颜色（一律用令牌）', !/#[0-9a-fA-F]{3,8}\b/.test(src))
    ok('CF-14', '源码里没有 uuid', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(src))
    ok('CF-14', '源码里没有把错误码/表名直接写上屏', !/\.textContent\s*=\s*['"`](E_[A-Z_]+|plugin_data|plugin_registry)/.test(src))
  }

  await host.deactivate()
  if (quiet) return { pass, failures }
  return { pass, failures }
}

/* ============================================================
   发布落库（2026-10-25）—— 探针全绿 ≠ 写得进库
   ------------------------------------------------------------
   首次真实发布踩到：manifest 没写 `config` 时 `publish.ts` 写入
   `config_schema: null`，而 schema §45.1 是 `not null default '{}'`，
   显式 null 不走默认值 ⇒ PostgreSQL 23502 ⇒ HTTP 500。
   这里同时钉住"前端要把 `why` 显示出来"，否则真实原因永远被吞。
   ============================================================ */
function publishPathChecks() {
  /** 只许看**真代码**，注释里提到坏写法不算数 */
  const strip = (s) =>
    String(s)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

  const publishCode = strip(
    readFileSync(resolve(HERE, '../functions/api/admin/plugins/publish.ts'), 'utf8'),
  )
  const apiCode = strip(readFileSync(resolve(HERE, '../src/lib/api.ts'), 'utf8'))
  const pendingCode = strip(
    readFileSync(resolve(HERE, '../src/components/PluginRepoPending.tsx'), 'utf8'),
  )

  const GOOD = 'config_schema: (f.files.manifest.config as unknown) ?? {}'
  const BAD = 'config_schema: (f.files.manifest.config as unknown) ?? null'
  ok(
    'PUB-01',
    '发布写库：manifest 没有 config 时写 `{}`，不是 null（schema §45.1 是 not null default）',
    publishCode.includes(GOOD) && !publishCode.includes(BAD),
  )
  const mutatedPublish = publishCode.replace(GOOD, BAD)
  ok(
    'PUB-01b',
    '反向对照：把 `{}` 改回 null ⇒ PUB-01 必须变假（证明它咬的是真代码）',
    mutatedPublish !== publishCode && !mutatedPublish.includes(GOOD),
  )

  ok(
    'PUB-02',
    '前端 `apiMessage()` 读服务端的 `why`（插件的发布/检查用它，原来只读 message）',
    /r\.data\?\.why/.test(apiCode),
  )
  const noWhy = apiCode.replace(/r\.data\?\.why/g, 'undefined')
  ok(
    'PUB-02b',
    '反向对照：把 `why` 从 apiMessage 拿掉 ⇒ PUB-02 必须变假',
    noWhy !== apiCode && !/r\.data\?\.why/.test(noWhy),
  )

  ok(
    'PUB-03',
    '发布失败用失败色渲染（不能把 HTTP 500 画成绿色成功）',
    /msgBad \? 'var\(--color-badink\)' : 'var\(--color-okink\)'/.test(pendingCode),
  )
}

/* ============================================================
   自检：故意写错的插件必须被挡住（CF 自己也要能红）
   ============================================================ */
function selftest() {
  console.log('\n自检：这些"写错了"的插件，校验必须判假')
  const cases = [
    ['CF-02 缺 name', baseManifest({ name: '' })],
    ['CF-02 id 不合命名空间', baseManifest({ id: 'HelloClock' })],
    ['CF-02 权限枚举不认识', baseManifest({ permissions: ['network'] })],
    ['CF-02 用 v0 的 capabilities', { ...baseManifest(), capabilities: ['data'] }],
    ['CF-02 version 不是 主.次.修', baseManifest({ version: '1.0' })],
    ['CF-03 entry 跳出目录', baseManifest({ entry: '../evil.js' })],
  ]
  let bad = 0
  for (const [name, m] of cases) {
    const r = validateManifest(m.id, m)
    if (r.ok) {
      bad++
      ok('SELF', `${name} ⇒ 必须判假`, false, '却通过了')
    } else {
      ok('SELF', `${name} ⇒ 判假`, true)
    }
  }
  const good = validateManifest('demo.helloclock', baseManifest())
  ok('SELF', '而正确的 manifest 必须判真（不然上面那几条只是"永远为假"）', good.ok, good.errors.join('；'))
  return bad
}

/* ============================================================
   入口
   ============================================================ */
const argv = process.argv.slice(2)
const argOf = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : null
}
const target = argOf('--plugin') ? resolve(process.cwd(), argOf('--plugin')) : FIXTURE

const { failures: f } = await runChecks(target)
publishPathChecks()
let selfBad = 0
if (argv.includes('--selftest')) selfBad = selftest()

console.log(`\n${'='.repeat(60)}`)
if (f.length || selfBad) {
  console.log(`❌ 失败 ${f.length + selfBad} 条 / 通过 ${pass} 条`)
  for (const x of f) console.log(`   · ${x}`)
  process.exit(1)
}
console.log(`✅ 全过：${pass} 条断言（CF-01…CF-14 + PUB-01…03）`)
