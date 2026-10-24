/*
 * realtime-checks —— 实时通道的所有权（2026-10-24 教室端首页报错的回归门禁）
 * ------------------------------------------------------------
 * 背景：supabase 的 `client.channel(名字)` 同名时**返回同一个对象**，而通道
 * 一旦 join 过，再 `.on('postgres_changes', …)` 就抛
 *   cannot add `postgres_changes` callbacks for realtime:xxx after `subscribe()`
 * ⇒ 两个地方各自 subscribe() 时，第二个必然炸，教室端整屏只剩报错卡。
 *
 * 这个门禁**不需要浏览器、不需要后端**：它用一个"会像真的一样抛错"的假通道
 * 驱动 `src/lib/realtimeFanout.ts`，把"一条通道 · 多个订阅者"的约定钉住。
 * 另外几条是静态的：通道只许在 lib/realtime.ts 里开。
 */
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = join(HERE, '..')
const SRC = join(APP, 'src')
const FANOUT = join(SRC, 'lib', 'realtimeFanout.ts')

let pass = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    return
  }
  failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
}
function eq(name, actual, expect) {
  ok(
    name,
    JSON.stringify(actual) === JSON.stringify(expect),
    `实际 ${JSON.stringify(actual)} · 期望 ${JSON.stringify(expect)}`,
  )
}

/* ---------------- 假 supabase：同名通道复用 + join 之后不许再 on ---------------- */
function makeFake() {
  const channels = new Map() // topic → 通道
  const stats = { openCalls: 0, closeCalls: 0 }

  function channel(topic) {
    const exist = channels.get(topic)
    if (exist) return exist
    stats.openCalls += 1
    const ch = {
      topic,
      isJoined: false,
      handlers: [],
      on(type) {
        if (this.isJoined) {
          throw new Error(`cannot add \`${type}\` callbacks for ${topic} after \`subscribe()\`.`)
        }
        this.handlers.push(arguments[2])
        return this
      },
      subscribe() {
        this.isJoined = true
        return this
      },
      /** 假推一条消息（模拟 postgres_changes 到达） */
      push(payload) {
        for (const cb of this.handlers) cb(payload)
      },
    }
    channels.set(topic, ch)
    return ch
  }

  /** 真 `removeChannel` 是**异步**的：topic 要等它 resolve 才从表里消失 —— 竞态的根源 */
  function removeChannel(ch) {
    stats.closeCalls += 1
    return new Promise((resolve) => {
      setTimeout(() => {
        if (channels.get(ch.topic) === ch) channels.delete(ch.topic)
        resolve('ok')
      }, 0)
    })
  }

  return {
    channel,
    removeChannel,
    channels,
    stats,
    topics: () => [...channels.keys()],
    push: (topic, payload) => channels.get(topic)?.push(payload),
  }
}

/** 把被测的 fanout 接到假通道上：通道里的消息 → bus.emit → 各订阅者 */
function wire(create, fake, baseTopic = 'shugao-classroom') {
  const bus = create({
    baseTopic,
    open: (topic) =>
      fake.channel(topic).on('postgres_changes', {}, (p) => bus.emit(p)).subscribe(),
    close: (ch) => void fake.removeChannel(ch),
  })
  return bus
}

/* ---------------- 载入被测模块（Node 24 直接跑 .ts，只做类型剥离） ---------------- */
let createFanout
try {
  ;({ createFanout } = await import(pathToFileURL(FANOUT).href))
} catch (err) {
  console.error('💥 载入 realtimeFanout.ts 失败：', err)
  process.exit(1)
}

/* ---------------- ① ~ ⑤：一条通道 · 多个订阅者 ---------------- */
{
  const fake = makeFake()
  const bus = wire(createFanout, fake)
  const a = []
  const b = []
  const offA = bus.subscribe((m) => a.push(m))
  const offB = bus.subscribe((m) => b.push(m))

  eq('① 两个人订阅只开了一条通道', fake.stats.openCalls, 1)
  eq('①b 订阅者登记为 2 位', bus.subscriberCount, 2)

  fake.push('shugao-classroom', { n: 1 })
  eq('② 一条消息两人都收到', [a.length, b.length], [1, 1])

  offA()
  fake.push('shugao-classroom', { n: 2 })
  eq('③ 退一个人之后另一人还收得到', [a.length, b.length], [1, 2])
  eq('③b 还有人订阅时不关通道', fake.stats.closeCalls, 0)

  offB()
  eq('④ 最后一位走了才关通道', fake.stats.closeCalls, 1)

  /* 竞态：旧通道还没走完异步 unsubscribe，就来了新的订阅者 */
  const c = []
  const offC = bus.subscribe((m) => c.push(m))
  eq('⑤ 重建时用带代数的新名字（躲开异步关闭的竞态）', fake.topics().includes('shugao-classroom-2'), true)
  fake.push('shugao-classroom-2', { n: 3 })
  eq('⑤b 新订阅者收得到消息', c.length, 1)
  offC()
}

/* ---------------- ⑥：一个订阅者抛错不许带走别人 ---------------- */
{
  const fake = makeFake()
  const bus = wire(createFanout, fake, 'x')
  const got = []
  const warn = console.warn
  console.warn = () => {}
  bus.subscribe(() => {
    throw new Error('boom')
  })
  bus.subscribe((m) => got.push(m))
  let threw = false
  try {
    fake.push('x', { n: 1 })
  } catch {
    threw = true
  } finally {
    console.warn = warn
  }
  eq('⑥ 一个订阅者抛错，另一个照收且不外抛', [threw, got.length], [false, 1])
}

/* ---------------- ⑦ 反向对照：把"代数后缀"改掉，⑤ 必须变红 ---------------- */
{
  const src = readFileSync(FANOUT, 'utf8')
  const MUT = 'opts.open(generation === 1 ? opts.baseTopic : `${opts.baseTopic}-${generation}`)'
  const count = src.split(MUT).length - 1
  ok('⑦ 反向对照的替换点恰好 1 处', count === 1, `实际 ${count} 处`)
  if (count === 1) {
    const mutated = src.replace(MUT, 'opts.open(opts.baseTopic)')
    const tmp = join(APP, `.tmp-fanout-${process.pid}.ts`)
    writeFileSync(tmp, mutated, 'utf8')
    try {
      const mod = await import(pathToFileURL(tmp).href + `?t=${Date.now()}`)
      const fake = makeFake()
      const bus = wire(mod.createFanout, fake)
      bus.subscribe(() => {})()
      let red = false
      try {
        bus.subscribe(() => {})
      } catch {
        red = true
      }
      ok('⑦ 去掉代数后缀之后，重建通道必然抛错（说明 ⑤ 不是摆设）', red, '改回去了却仍然不抛')
    } finally {
      rmSync(tmp, { force: true })
    }
  }
}

/* ---------------- ⑧ ~ ⑪ 静态：通道只许在 lib/realtime.ts 里开 ---------------- */
{
  const rt = readFileSync(join(SRC, 'lib', 'realtime.ts'), 'utf8')
  eq('⑧ realtime.ts 里开通道恰好 1 处', rt.match(/\.channel\(/g)?.length ?? 0, 1)
  eq('⑨ realtime.ts 用 createFanout 管通道', rt.match(/createFanout[<(]/g)?.length ?? 0, 1)
  eq('⑩ 通道名字只在 realtime.ts 出现', rt.split("'shugao-classroom'").length - 1, 1)
}
{
  const others = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) {
        if (p === join(SRC, 'lib', 'realtime.ts')) continue
        if (readFileSync(p, 'utf8').includes('sb.channel(')) others.push(p.replace(APP, ''))
      }
    }
  }
  walk(SRC)
  eq('⑪ src 下没有别处自己开通道', others, [])
}

/* ---------------- 汇总 ---------------- */
if (failures.length) {
  console.log(`\n❌ realtime-checks 断言：通过 ${pass} 条，失败 ${failures.length} 条`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✅ realtime-checks 断言：通过 ${pass} 条，失败 0 条`)
