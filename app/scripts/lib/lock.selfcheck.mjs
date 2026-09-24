/**
 * 锁模块的**自检**（不依赖 dev server / 浏览器，十几秒跑完）。
 *
 *     node scripts/lib/lock.selfcheck.mjs        ***REMOVED*** 从 app/ 或仓库根都能跑
 *
 * 为什么要有它：这个模块的职责是"让两个脚本别同时跑"，而它本身**没有断言就没人能验**。
 * 它验 6 件事：
 *   ① 拿到锁 → 锁目录里写着持有者（pid / 脚本名 / 时间戳）；
 *   ② 同进程重入：锁已经被**本进程**持有时，再 `withLock` 一次不死锁、且只有最外层释放；
 *   ③ 锁被**别的进程**持有时，`withLock` **会等**（不并发跑）；
 *   ④ 等不到时**退出码 3 + 打印持有者**（不是无声地并发跑）；
 *   ⑤ **陈旧锁可抢 + 打印警告**；异常路径也要把锁放掉；
 *   ⑥ 锁目录在但 `owner.json` 缺失/损坏时，诊断信息仍是人话。
 *
 * ⚠️ 它用**自己的锁目录**（`SHUGAO_LOCK` 指到一个临时目录），不碰真正的
 *    `%TEMP%\shugao-verify.lock` —— 自检不该影响正在跑的那五个脚本。
 *
 * ⚠️ 设计上刻意**不让子进程去"扮演持锁的脚本"**：子进程自己也跑这个文件，
 *    它会顺手 `rmSync` 自己的沙箱，把父进程刚建的锁一起删掉（第一版自检就栽在这里）。
 *    "别人持锁"这个局面由父进程亲手摆出来，子进程只负责"抢不到时的行为"。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
/*
 * ⚠️ 一律用 `os.tmpdir()` 拼路径，**不要**混用 `process.env.TEMP`：
 * 本机 `%TEMP%` 是 8.3 短路径（`C:\Users\ADMINI~1\...`）而 `os.tmpdir()` 是长路径
 * （`C:\Users\Administrator\...`）—— 两者指向同一个目录，但**字符串不相等**，
 * 混用会表现成"锁明明建了，`existsSync(同一个字面量)` 却是 false"（本次真实踩到过）。
 */
const SANDBOX = join(tmpdir(), `shugao-lock-selfcheck-${process.pid}`)
const LOCK = join(SANDBOX, 'shugao-verify.lock')

let pass = 0
const failures = []
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`)
  }
}

/** 手工摆一个"别人正在持锁"的局面（`lock.mjs` 的接管点就是这两个文件） */
function giveLockTo(owner) {
  rmSync(LOCK, { recursive: true, force: true })
  mkdirSync(LOCK)
  writeFileSync(join(LOCK, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
}

/* ============================================================
   子进程模式：拿一把"别人持着的锁"，应当等不到而退出
   ============================================================ */
if (process.argv[2] === 'wait.mjs') {
  const { withLock } = await import(pathToFileURL(join(HERE, 'lock.mjs')).href)
  await withLock(async () => console.log('❌ 本不该跑到这里（说明没等锁就并发跑了）'), {
    script: 'wait.mjs',
    waitMs: Number(process.env.WAIT_MS ?? 1200),
  })
  process.exit(0)
}

mkdirSync(SANDBOX, { recursive: true })
/*
 * ⚠️ **必须在 import `lock.mjs` 之前设好**：它在**模块顶层**读这个变量
 * （`LOCK_DIR = process.env.SHUGAO_LOCK || …`）。import 完再设就晚了 ——
 * 自检会去动真正的锁，反而变成抢占者。
 */
process.env.SHUGAO_LOCK = LOCK
const { withLock, readOwner, describeOwner, LOCK_DIR } = await import(
  pathToFileURL(join(HERE, 'lock.mjs')).href
)

console.log('【锁自检】')
console.log(`  自检用的锁目录：${LOCK}`)
console.log(`  真脚本用的锁目录：${LOCK_DIR}（自检不碰它）`)

/* ---- ① + ② 拿锁 / 重入 / 释放 ---- */
{
  let nested = false
  await withLock(
    async () => {
      const o = readOwner()
      ok(
        '① 拿到锁后 owner.json 里有 pid / 脚本名 / 时间戳',
        Number.isInteger(o.pid) && Boolean(o.script) && Boolean(o.startedAt),
        JSON.stringify(o),
      )
      ok('① owner.json 真的写在锁目录里', readdirSync(LOCK).includes('owner.json'), LOCK)
      await withLock(
        async () => {
          nested = true
        },
        { script: 'nested' },
      )
      ok('② 同进程重入不抛错（不会自己锁死自己）', nested)
      ok('② 重入返回后最外层的锁还在（内层没提前放掉）', existsSync(LOCK), LOCK)
    },
    { script: 'selfcheck-outer' },
  )
  ok('① 出 withLock 之后锁被释放（try/finally）', !existsSync(LOCK), LOCK)
}

/* ---- ⑤a 异常路径也要释放 ---- */
{
  await withLock(async () => {
    throw new Error('故意抛的')
  }, { script: 'thrower' }).catch(() => {})
  ok('⑤ 异常路径下锁也被释放了（脚本崩了不锁死别人）', !existsSync(LOCK), LOCK)
}

/* ---- ③ 锁被**别的进程**持有时，父进程要等 ---- */
{
  // 摆出"另一个脚本正在跑"：pid 用当前进程（一定活着），时间戳是刚刚
  giveLockTo({
    token: 'someone-else-fake',
    pid: process.pid,
    script: 'someone-else.mjs',
    startedAt: '刚刚',
    startedAtMs: Date.now(),
  })
  // 3 秒后由定时器把它撤掉 —— 模拟"那个脚本跑完了"
  const timer = setTimeout(() => rmSync(LOCK, { recursive: true, force: true }), 3000)
  const t0 = Date.now()
  let logSeen = ''
  const origLog = console.log
  console.log = (...a) => {
    logSeen += `${a.join(' ')}\n`
    origLog(...a)
  }
  await withLock(async () => {}, { script: 'parent-waits' })
  console.log = origLog
  clearTimeout(timer)
  const waited = Date.now() - t0
  ok('③ 锁被别人持着时，withLock **真的等了**（没有并发跑）', waited > 2000, `实际等了 ${waited}ms`)
  ok(
    '③ 等待期间打印了"谁持有"（脚本名 + pid + 开始时间）',
    /someone-else\.mjs/.test(logSeen) && /pid \d+/.test(logSeen) && /开始于/.test(logSeen),
    logSeen.split('\n')[0],
  )
  ok('③ 抢到之后照常释放', !existsSync(LOCK), LOCK)
}

/* ---- ④ 等不到 → 退出码 3 + 打印持有者 + 没有并发跑 ---- */
{
  giveLockTo({
    token: 'blocker-fake',
    pid: process.pid,
    script: 'blocker.mjs',
    startedAt: '刚刚',
    startedAtMs: Date.now(),
  })
  const w = spawnSync(process.execPath, [SELF, 'wait.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, SHUGAO_LOCK: LOCK, WAIT_MS: '1200' },
  })
  ok('④ 等不到锁时退出码 = 3', w.status === 3, `实际 ${w.status}`)
  const all = `${w.stdout ?? ''}${w.stderr ?? ''}`
  ok(
    '④ 退出时打印了"谁持有"（脚本名 + pid + 开始时间）',
    /blocker\.mjs/.test(all) && /pid \d+/.test(all) && /开始于/.test(all),
    all.split('\n').filter(Boolean).slice(0, 3).join(' / '),
  )
  ok('④ 没有无声地并发跑（那句"本不该跑到这里"没出现）', !/本不该跑到这里/.test(w.stdout ?? ''))
  ok('④ 别人的锁没被删掉（等不到 ≠ 抢）', existsSync(LOCK), LOCK)
  rmSync(LOCK, { recursive: true, force: true })
}

/* ---- ⑤b 陈旧锁：pid 已死 / 时间戳很久以前 → 抢掉 + 警告 ---- */
{
  giveLockTo({
    token: 'ghost-fake',
    pid: 999999,
    script: 'ghost.mjs',
    startedAt: '2020-01-01 00:00:00 +08:00',
    startedAtMs: Date.now() - 3 * 60 * 60 * 1000,
    host: 'ghost',
  })
  let logs = ''
  const origLog = console.log
  console.log = (...a) => {
    logs += `${a.join(' ')}\n`
    origLog(...a)
  }
  await withLock(async () => {}, { script: 'stale-taker' })
  console.log = origLog
  ok(
    '⑤ 陈旧锁被抢掉，并且**打印了警告**（说清是谁的、多久了）',
    /陈旧验证锁/.test(logs) && /ghost\.mjs/.test(logs),
    logs.split('\n')[0],
  )
  ok('⑤ 抢完之后锁归自己，退出 withLock 时释放', !existsSync(LOCK), LOCK)
}

/* ---- ⑥ 锁在但 owner.json 缺失 ---- */
{
  mkdirSync(LOCK)
  const d = describeOwner(readOwner())
  ok('⑥ 锁存在但 owner.json 缺失时，诊断信息是人话', /读不出持有者/.test(d), d)
  rmSync(LOCK, { recursive: true, force: true })
}

/* ---- 收尾：真脚本用的锁目录不许被自检动过 ---- */
{
  const real = join(tmpdir(), 'shugao-verify.lock')
  ok(
    '自检没有碰真正的锁目录（%TEMP%\\shugao-verify.lock 现在应当不存在）',
    !existsSync(real) || real === LOCK,
    real,
  )
}

rmSync(SANDBOX, { recursive: true, force: true })

console.log(`\n${'='.repeat(48)}`)
if (failures.length) {
  console.log(`❌ 锁自检失败 ${failures.length} 条 / 通过 ${pass} 条`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log(`✅ 锁自检全过：${pass} 条`)
}
