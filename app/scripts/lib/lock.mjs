/**
 * 回归脚本的**全局互斥锁**（`%TEMP%\shugao-verify.lock`）。
 *
 * ============================================================
 * 为什么要有这个文件（审计实测到的事故，写下来免得再发明一遍）
 * ============================================================
 * 「跑验证脚本之前先拿 `%TEMP%\shugao-verify.lock`」这条约定**曾经只存在于
 * 发指令的人脑子里** —— 仓库里 grep 0 命中，于是每个 agent 都在自己重新发明一套。
 * 实测后果（2026-09-27 审计）：
 *
 *   · `.shots/` 里同时躺着 **4 个批次**的图，旧图冒充这一轮（现在靠 `.shots/<runId>/` 兜住）；
 *   · **两个 `shots.mjs` 并发写同一个目录**，两条序列交错；
 *   · 更隐蔽的一类：两个脚本各自拨各自的假时钟、各自 `selectOption`，谁也看不出对方在跑。
 *
 * 所以约定必须**落到代码里**，而且五个脚本**共用同一份**（别再各自手写）。
 *
 * ============================================================
 * 用法
 * ============================================================
 * ```js
 * import { withLock } from './lib/lock.mjs'
 *
 * await withLock(async () => {
 *   // …整个脚本的主流程（含它自己的 try/finally：关浏览器、关假服务端）…
 * }, { script: 'shots.mjs' })
 * ```
 *
 * 规矩（`功能设计与不变量.md` §十八）：
 *   ① **一个脚本 = 一次 `withLock`**，包住**它自己的全部工作**，不是只包某一段；
 *   ② 锁在 `finally` 里释放 → **异常路径也必须释放**（脚本崩了不能把别人锁死）；
 *   ③ 拿不到锁**要等**（等前一个脚本跑完），超过上限**退出并打印持有者是谁**；
 *   ④ 陈旧锁（进程已死 / 超过 N 分钟）可以抢，但**必须打印警告**。
 *
 * ============================================================
 * 实现要点
 * ============================================================
 * · **原子性靠 `mkdir`**：`fs.mkdirSync(dir)` 在 Windows / POSIX 上都是原子的 ——
 *   目录已存在就抛 `EEXIST`，只有一个进程能赢。**不要**改用"先 exists 再写文件"那种
 *   检查-写入两步做法（那正是竞态的原文）。
 * · 锁目录里放 `owner.json`：pid / 脚本名 / 启动时刻 / 主机名 / 完整命令。
 *   "谁持有"这句话必须能直接打出来，否则下次还是要靠猜。
 * · 释放前核对 `token`（`pid-时间戳-随机`）：**只删自己建的锁**，
 *   免得把抢占者刚建的锁删掉（陈旧锁被抢 + 原持有者随后释放 = 经典误删）。
 * · **同一进程内可重入**：已经持有就直接执行 `fn`（`depth++`），不做第二次抢占。
 *   这条是给"一个脚本内部嵌套 `withLock`"和"同进程连跑多个检查"用的 ——
 *   不会自己把自己锁死（用户明确点过这一条）。
 *
 * 环境变量（一般不用动）：
 *   `SHUGAO_LOCK`            —— 换个锁目录（默认 `%TEMP%\shugao-verify.lock`）
 *   `SHUGAO_LOCK_WAIT_MS`    —— 等锁上限（默认 20 分钟）
 *   `SHUGAO_LOCK_STALE_MS`   —— 超过多久算陈旧锁（默认 20 分钟）
 *   `SHUGAO_LOCK_QUIET=1`    —— 不打印"正在等锁"的提示（断言/输出比对时才用）
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** 锁目录：`%TEMP%\shugao-verify.lock`（`os.tmpdir()` 在 Windows 上就是 `%TEMP%`） */
export const LOCK_DIR = process.env.SHUGAO_LOCK || join(tmpdir(), 'shugao-verify.lock')

/** 等不到锁时的重试间隔 */
const RETRY_MS = 500

/** 等锁上限：超过就打印持有者并退出（默认 20 分钟，比最长的脚本还宽出一大截） */
const WAIT_MS = Number(process.env.SHUGAO_LOCK_WAIT_MS ?? 20 * 60 * 1000)

/**
 * 陈旧锁阈值（默认 20 分钟）。
 * 为什么是 20 分钟：五个脚本里最长的是 `shots.mjs`（约 3 分钟），
 * 留足一个数量级，宁可"多等一会儿"也不要"把正在跑的脚本的锁抢掉"。
 */
const STALE_MS = Number(process.env.SHUGAO_LOCK_STALE_MS ?? 20 * 60 * 1000)

const QUIET = process.env.SHUGAO_LOCK_QUIET === '1'

/** 毫秒 → 人话（不足 1 分钟就按秒说，免得打出"等 0 分钟"这种读不懂的话） */
const humanMs = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`)

/* ---------------- 进程内的重入状态 ---------------- */

/** 本进程当前持有的锁（null = 没持有） */
let held = null
/** 重入深度：`withLock` 嵌套时只有最外层真正释放 */
let depth = 0
/** exit 钩子只登记一次 */
let exitHookInstalled = false

/* ---------------- 小工具 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function nowIso() {
  // 用本地时间 + 时区偏移写成人看得懂的串（本机应为 +08:00，见 §一 时间口径）
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 调用方的脚本名：优先显式传，否则从 argv[1] 取文件名 */
function scriptName(explicit) {
  if (explicit) return explicit
  const arg = process.argv[1] ?? ''
  return arg.split(/[\\/]/).pop() || '(未知脚本)'
}

/** 读锁里的持有者信息；锁在但读不出来时返回 `{ unreadable: true }` */
export function readOwner() {
  try {
    const raw = readFileSync(join(LOCK_DIR, 'owner.json'), 'utf8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : { unreadable: true, raw }
  } catch (e) {
    return { unreadable: true, reason: String(e?.code ?? e?.message ?? e) }
  }
}

/** 把持有者信息打成**一句人话**（"谁在跑、什么时候开始的、这个进程还活着吗"） */
export function describeOwner(o = readOwner()) {
  if (!o || o.unreadable) {
    return `锁目录存在但读不出持有者信息（${o?.reason ?? 'owner.json 缺失或损坏'}）—— 可能是别的工具建的，也可能是陈旧锁`
  }
  const ageMin = o.startedAtMs ? Math.round((Date.now() - o.startedAtMs) / 60000) : null
  const alive = o.pid ? pidAlive(o.pid) : null
  const parts = [
    `脚本 ${o.script ?? '(未写)'}`,
    `pid ${o.pid ?? '(未写)'}${alive === false ? '（**这个进程已经不存在了**）' : alive === true ? '（进程还活着）' : ''}`,
    `开始于 ${o.startedAt ?? '(未写)'}${ageMin === null ? '' : `（已 ${ageMin} 分钟）`}`,
    `主机 ${o.host ?? '(未写)'}`,
  ]
  return parts.join(' · ')
}

/**
 * 进程还活着吗。`process.kill(pid, 0)` 只做"存在性 + 权限"检查，不发信号。
 * ⚠️ Windows 上它**不抛异常**就说明进程存在；`EPERM` 也算存在（只是没权限）。
 * 只在"陈旧判定"里当**辅助证据**，判定的主依据仍是时间戳。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** 陈旧锁？—— 超过 `STALE_MS`，或者（更早就能确定）持有者进程已经不在了 */
function isStale(o) {
  if (!o || o.unreadable) {
    // 读不出来的锁：按目录 mtime 判不了（我们没记），一律按"时间戳缺失"当成不陈旧，
    // 靠 WAIT_MS + '锁文件坏了' 的诊断信息让人去删 —— 不在这里冒险抢。
    return false
  }
  const age = typeof o.startedAtMs === 'number' ? Date.now() - o.startedAtMs : 0
  if (age > STALE_MS) return true
  // 进程没了 + 至少活过 5 秒（避免 pid 复用/刚 fork 出来的瞬间误判）
  return age > 5000 && pidAlive(o.pid) === false
}

/* ---------------- 抢锁 ---------------- */

function writeOwner(token, script) {
  const owner = {
    token,
    pid: process.pid,
    script,
    cwd: process.cwd(),
    host: hostname(),
    argv: process.argv.slice(2),
    startedAt: nowIso(),
    startedAtMs: Date.now(),
  }
  writeFileSync(join(LOCK_DIR, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
  return owner
}

/**
 * 试一次抢锁。**同步的** —— `mkdirSync` 是原子的，赢家只有一个。
 * @returns {{ok: true, owner: object} | {ok: false, owner: object|null}}
 */
function tryAcquire(script) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    mkdirSync(LOCK_DIR) // 已存在 → EEXIST（这就是互斥本身）
  } catch (e) {
    if (e?.code === 'EEXIST') return { ok: false, owner: readOwner() }
    throw e
  }
  // 赢了才写持有者信息：写失败也不释放锁（宁可让后来者看到"读不出持有者"，
  // 也不要出现"锁存在但没人认领"的中间态被抢走）
  let owner
  try {
    owner = writeOwner(token, script)
  } catch {
    owner = { token, pid: process.pid, script, startedAt: nowIso(), startedAtMs: Date.now() }
  }
  return { ok: true, owner }
}

function releaseLock() {
  if (!held) return
  const me = readOwner()
  /*
   * ⚠️ **只在"这个目录确实是自己建的"时才删**：token 是每次抢锁现生成的随机串，
   * 对不上说明锁已经被别人抢走（我这边已经变成陈旧锁持有者）—— 那时候删掉就等于
   * 把抢占者正在用的锁删了，两个人同时跑。
   *
   * `owner.json` 读不出来（`unreadable`）时按"可能是我自己把文件写坏了"处理，照删 ——
   * 宁可留一个空目录被当成陈旧锁，也不要让一个读不出来的锁把后面所有人都堵死。
   * 删完必须把 `held` 清掉：**释放动作与状态是两件事，先清状态再删文件就会漏删**
   * （这个 bug 本轮真的写出来过：`withLock` 里先 `held = null` 再调 `releaseLock()`，
   *  守卫 `if (!held) return` 直接返回，锁目录留在了盘上 —— 自检第 ③ 组才把它抓出来）。
   */
  if (me && !me.unreadable && me.token !== held.token) return
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true })
  } catch {
    /* 删不掉就留给陈旧锁机制；不能在这里抛，会盖住真正的失败原因 */
  }
  held = null
}

/** 进程退出兜底：脚本被 Ctrl-C / 未捕获异常掀翻时也要把锁解开 */
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    if (depth > 0 || held) releaseLock()
  })
}

/**
 * 拿锁（等不到时按 `waitMs` 一直等）。一般用 `withLock`；只有在"主流程要包在
 * 别的东西里"时才手工配对 `acquireLock()` / `releaseLockHandle()`。
 *
 * ⚠️ 它是 **async** 的：等待循环每 250ms `await` 一次，把事件循环让出去 ——
 *    这样"另一个进程跑完删掉锁"能被看见，同进程里挂着的定时器也不会被饿死。
 *    同步版（`Atomics.wait` 独占线程）会把两者一起卡死。
 *
 * @param {{script?: string, waitMs?: number}} [opts]
 * @returns {Promise<object>} 锁句柄
 */
export async function acquireLock(opts = {}) {
  const script = scriptName(opts.script)
  if (held) return held // 同进程重入：不重复抢

  const waitMs = opts.waitMs ?? WAIT_MS
  const deadline = Date.now() + waitMs
  const t0 = Date.now()
  let warned = false
  let staleWarned = false

  for (;;) {
    const got = tryAcquire(script)
    if (got.ok) {
      held = got.owner
      installExitHook()
      const waited = Date.now() - t0
      if (waited > 1000) {
        console.log(`🔓 拿到验证锁（等了 ${(waited / 1000).toFixed(1)} 秒）：${LOCK_DIR}`)
      }
      return held
    }

    const owner = got.owner
    // 陈旧锁：可以抢，但**必须打印警告**（否则永远是"神秘地少了一轮"）
    if (!staleWarned && isStale(owner)) {
      staleWarned = true
      const ageMin = owner?.startedAtMs ? Math.round((Date.now() - owner.startedAtMs) / 60000) : null
      console.log(
        `⚠️  发现**陈旧验证锁**：${describeOwner(owner)}` +
          `${ageMin === null ? '' : ` —— 已 ${ageMin} 分钟，超过阈值 ${humanMs(STALE_MS)}`}。` +
          `\n    这个锁的持有者多半已经不在了，脚本按"死锁可抢"处理：删掉它重新抢。`,
      )
      try {
        rmSync(LOCK_DIR, { recursive: true, force: true })
      } catch (e) {
        console.log(`    抢占失败（${e?.code ?? e?.message}）—— 手工删掉 ${LOCK_DIR} 再跑。`)
      }
      continue // 抢完立刻重试
    }

    if (Date.now() >= deadline) {
      const msg = [
        `\n⛔ 等验证锁超过 ${humanMs(waitMs)}，放弃：**有人正在跑验证脚本**。`,
        `   锁：${LOCK_DIR}`,
        `   持有者：${describeOwner(owner)}`,
        `   怎么办：等它跑完再跑本脚本；确认它已经死了就删掉上面这个目录（或设 SHUGAO_LOCK_STALE_MS 调小陈旧阈值）。`,
        `   为什么必须等：同一个 dev server（5178）+ 同一批 localStorage 断言，两个脚本并发会互相污染，`,
        `   而且截图/假时钟会交错成一团（见 功能设计与不变量.md §十八）。`,
      ].join('\n')
      console.error(msg)
      process.exit(3)
    }

    if (!warned && !QUIET) {
      warned = true
      console.log(
        `⏳ 验证锁被占用，等待中……\n   持有者：${describeOwner(owner)}` +
          `\n   （等 ${humanMs(waitMs)} 仍拿不到就退出并重新打印这条）`,
      )
    }
    // 每 250ms 让一次事件循环：阻塞式等待会把同进程的定时器一起饿死
    sleepSync(Math.min(RETRY_MS, 250))
    await sleep(0)
  }
}

/**
 * 同步小睡（`Atomics.wait`）—— 抢锁循环是同步的，用它比 async sleep 更直白。
 * ⚠️ 代价：它**完全不还给事件循环**。所以循环里每 250ms 会 `await` 一次（见下），
 *    否则同进程里挂着的定时器/I-O 会被一起饿死（自检里"3 秒后放锁"的
 *    `setTimeout` 就是这么被饿死的 —— 表现为"等了 20 分钟还没等到"）。
 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/** 手工释放（只有配过 `acquireLock()` 才需要调） */
export function releaseLockHandle() {
  releaseLock()
}

/** 主接口：拿锁 → 跑 `fn` → 无论正常/抛异常都释放 */
export async function withLock(fn, opts = {}) {
  await acquireLock(opts) // 已持有则直接返回（同进程重入，见文件头）
  depth++
  try {
    return await fn()
  } finally {
    depth--
    if (depth === 0) {
      // ⚠️ 释放必须在这里：`fn` 抛异常时也要走到（脚本崩了不能把后面的人锁死）
      //    注意**只调 releaseLock()**，别提前把 `held` 置空（它自己会在删完之后清）
      releaseLock()
    }
  }
}
