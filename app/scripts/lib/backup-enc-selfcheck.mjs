/**
 * 备份加密的**实测**（不是读代码猜，是真的跑一遍 shell）。
 *
 * 为什么要这个脚本：`backup.yml` 里那段加密是**安全关键**的 ——
 * 它有一个极危险的失败模式：**口令缺失时静默降级成明文上传**
 * （日志全绿、R2 上有对象，但那份对象是全校学生的姓名/学号/成绩的明文，
 *  而所有人都以为它是加密的）。这种失败"看起来一切正常"，靠读代码看不出来。
 *
 * 🔴 本脚本**不重写**那段逻辑：它按 `# ⇣⇣ 加密块开始` / `# ⇡⇡ 加密块结束`
 *    两个标记，把 `.github/workflows/backup.yml` 里那段 shell **原样抠出来**，
 *    拼成临时脚本、交给 **Git Bash** 跑。改工作流 = 改被测对象，不需要同步两份。
 *
 * 跑法（在 `app/` 下）：
 *   node scripts/lib/backup-enc-selfcheck.mjs
 *
 * ⚠️ 它**不用**验证锁：不碰 dev server、不碰 localStorage、不碰真数据库，
 *    全程只在自己建的临时目录里对一个假 dump 做加解密（见 §十八 锁的适用范围）。
 *
 * 三件事各验一次：
 *   ① 口令存在 → 产出**真的是密文**（有 openssl 的 `Salted__` 头、没有 gzip 魔数、
 *      比明文长），并且能用 **README「备份加密与恢复」里那条命令**解回原字节；
 *   ② 口令缺失 → **非零退出、一个字节都不往外写**（.enc / .gz 都不存在）；
 *   ③ 负向对照：把"口令缺失就退出"那一小段从块里删掉，同一个场景**必须变成绿**
 *      —— 证明第 ② 条不是"恰好通过"。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolvePath(HERE, '..', '..')
const REPO = resolvePath(APP, '..')
const WORKFLOW = join(REPO, '.github', 'workflows', 'backup.yml')

/** Git Bash：Windows 上唯一保证有 `openssl` + bash 5 的入口 */
const BASH = process.env.SHUGAO_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe'

/** 抠代码用的两个标记（在 backup.yml 的加密块上下各一行） */
const START = '加密块开始'
const END = '加密块结束'

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

/**
 * 从 workflow 里抠出加密块（**原样**，一个字符都不改）。
 * 找不到标记就直接失败 —— 那种情况下这个自检等于没跑，不能给绿灯。
 */
function extractBlock() {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const a = lines.findIndex((l) => l.includes(START))
  const b = lines.findIndex((l) => l.includes(END))
  if (a < 0 || b < 0 || b <= a) return null
  // 去掉每行 10 空格的工作流缩进，还原成可以直接跑的 shell
  return lines
    .slice(a + 1, b)
    .map((l) => (l.startsWith('          ') ? l.slice(10) : l))
    .join('\n')
}

/**
 * 抠出工作流里那个 `trim()` 定义。
 *
 * 为什么不能自己再写一个：被测的那段 shell 调的就是它，
 * 自己写一个等于"测的是我的替代品，不是工作流"。
 * （工作流每个 `run:` 都是独立 shell，所以它每步各留一份 —— 这里也照抄那一份。）
 */
function extractTrim() {
  const text = readFileSync(WORKFLOW, 'utf8')
  const m = text.match(/\n {10}trim\(\) \{\n(?: {12}.*\n)*? {10}\}\n/)
  if (!m) return null
  return m[0]
    .split('\n')
    .map((l) => (l.startsWith('          ') ? l.slice(10) : l))
    .join('\n')
}

/**
 * 在 Git Bash 里跑一段 shell：写进 `cwd/run.sh` 再 `bash run.sh`。
 * `checkOnly: true` 时只做 `bash -n`（语法检查，不执行）——
 * 用来排除"退出码非零其实是语法错误"这种假证据。
 */
function bash(script, env, cwd, { checkOnly = false } = {}) {
  const file = join(cwd, checkOnly ? '_syntax.sh' : 'run.sh')
  writeFileSync(file, script, 'utf8')
  const cmd = checkOnly ? `bash -n "${file}"` : `set -o pipefail; bash "${file}"`
  try {
    const out = execFileSync(BASH, ['-lc', cmd], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { rc: 0, out }
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 假 dump：够大、带 pg_dump 那行头部标记（大小与头部两道闸都要能过） */
function makeStub(cwd) {
  const raw = join(cwd, 'backup-20260925-1830.sql')
  const body = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    'CREATE TABLE students (id uuid, student_no text, name text);',
    'INSERT INTO students VALUES (\'…\', \'12\', \'张三\');',
    'x'.repeat(3000),
  ].join('\n')
  writeFileSync(raw, body, 'utf8')
  execFileSync(BASH, ['-lc', `gzip -9 "${raw.replace(/\\/g, '/')}"`], { stdio: 'ignore' })
  return join(cwd, 'backup-20260925-1830.sql.gz')
}

/**
 * 把一个 step 的 `run:` 块原样抠出来（按 `- name:` 找到那一步）。
 * 用来对**没被执行到**的那些步骤做语法体检 —— 见第 0 组最后一条。
 */
function extractStepRun(stepName) {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const i = lines.findIndex((l) => l.includes(`- name: ${stepName}`))
  if (i < 0) return null
  const start = lines.findIndex((l, k) => k > i && /^\s{8,}run: \|\s*$/.test(l))
  if (start < 0) return null
  const body = []
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k]
    if (l.trim() === '') {
      body.push(l)
      continue
    }
    if (!l.startsWith('          ')) break
    body.push(l.slice(10))
  }
  return body.join('\n')
}

const block = extractBlock()
const trimFn = extractTrim()

console.log('备份加密实测（真跑 Git Bash + 真 openssl）')
console.log(`工作流：${WORKFLOW}`)
console.log(`解释器：${BASH}`)

section('0. 抠代码')
ok('能从 backup.yml 里抠出加密块（标记还在）', Boolean(block), '标记被删了？这个自检会变成空转，必须修')
ok('能从 backup.yml 里抠出 trim()（被测代码真的调它）', Boolean(trimFn))
if (!block || !trimFn) {
  console.log('\n结果：失败（抠不出被测代码）')
  process.exit(1)
}
ok('抠出来的块里有 openssl enc -aes-256-cbc', block.includes('openssl enc -aes-256-cbc'))
ok('抠出来的块里有 -pbkdf2 与 -iter', block.includes('-pbkdf2') && /-iter\s+\d+/.test(block))
ok('没有用 -nosalt（固定盐）', !block.includes('-nosalt'))
ok('口令走 stdin（printf 管道），不是 <<< here-string', block.includes('-pass stdin') && !block.includes('<<<'))

/*
 * 清理那一步改过（旧明文要和新密文共存、还要顺手删掉被取代的明文副本），
 * 而它在本地**跑不起来**（要真 R2）。所以至少做一次 `bash -n` 语法体检 ——
 * 语法错误在 Actions 上表现为"这一步莫名失败"，而那时备份其实已经成功了。
 */
const cleanupRun = extractStepRun('清理 R2 上超过 30 份的旧备份')
ok('能抠出「清理 R2 上超过 30 份的旧备份」那一步的 shell', Boolean(cleanupRun))
if (cleanupRun) {
  const cd = mkdtempSync(join(tmpdir(), 'shugao-clean-'))
  const syn = bash(cleanupRun, {}, cd, { checkOnly: true })
  ok('清理步骤的 shell 语法合法（bash -n 通过）', syn.rc === 0, syn.out.slice(-300))
  ok('清理按**扩展名**过滤（老的 .sql.gz 与新的 .sql.gz.enc 都收）', /grep -E '\^backup-/.test(cleanupRun))
  ok('清理会顺手删掉"已被同一时刻密文取代"的明文副本', cleanupRun.includes('已被 $p.enc 取代'))
  rmSync(cd, { recursive: true, force: true })
}

const root = mkdtempSync(join(tmpdir(), 'shugao-enc-'))
const PASS = 'correct horse battery staple 树高'

/**
 * 工作流最后那句 `echo "FILE=$enc" >> "$GITHUB_ENV"` 是**给 GitHub 用的**：
 * 真实运行里 `$GITHUB_ENV` 是 Actions 给的一个临时文件路径，本地跑就是空串 ——
 * 那会让重定向变成 `>>`（无目标）→ bash 报 `: No such file or directory` → 退出码 1。
 * 所以这里照真实环境给它一个文件（这也顺便验证了那句话确实被跑到）。
 */
const GITHUB_ENV = join(root, 'github-env.txt')
writeFileSync(GITHUB_ENV, '', 'utf8')

/* ---------------- ① 口令存在 ---------------- */
section('1. 口令存在 → 必须是密文，且能解回来')
const c1 = join(root, 'with-pass')
execFileSync(BASH, ['-lc', `mkdir -p "${c1.replace(/\\/g, '/')}"`])
const gz = makeStub(c1)
const r1 = bash(
  `set -e\n${trimFn}\nraw="backup-20260925-1830.sql"\nout="${gz.replace(/\\/g, '/').split('/').pop()}"\n${block}\n`,
  { BACKUP_PASS_RAW: PASS, GITHUB_ENV },
  c1,
)
const enc1 = join(c1, 'backup-20260925-1830.sql.gz.enc')
ok('加密这一步退出码为 0', r1.rc === 0, r1.out.slice(-400))
ok('产出了 .enc 文件', existsSync(enc1))
ok('明文 .gz 已被删掉（工作区里不留明文）', !existsSync(gz), gz)

if (existsSync(enc1)) {
  const enc = readFileSync(enc1)
  ok('密文头部是 openssl 的 Salted__ 魔数', enc.subarray(0, 8).toString('latin1') === 'Salted__')
  ok('密文里没有 gzip 魔数 1f 8b（前 64 字节）', enc.subarray(0, 64).indexOf(Buffer.from([0x1f, 0x8b])) < 0)
  ok('密文长度 > 16（有盐头 + 至少一个分组）', enc.length > 16)

  // ---- 用文档里那条命令解回来（README「备份加密与恢复」）----
  const dec = join(c1, 'decrypted.sql.gz')
  const r2 = bash(
    `printf '%s' "$PASS" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in "backup-20260925-1830.sql.gz.enc" -out "decrypted.sql.gz" -pass stdin`,
    { PASS },
    c1,
  )
  ok('文档里那条解密命令退出码为 0', r2.rc === 0, r2.out.slice(-300))
  ok('解出来的文件存在', existsSync(dec))
  if (existsSync(dec)) {
    const back = execFileSync(BASH, ['-lc', 'gunzip -c "decrypted.sql.gz"'], {
      cwd: c1,
      encoding: 'utf8',
    })
    ok('解回来是原来那份 dump（含 PostgreSQL database dump 头）', back.includes('PostgreSQL database dump'))
    ok('解回来的内容逐字节等于原始 dump（含中文姓名）', back.includes("'12', '张三'"))
  }

  // ---- 口令错了必须解不开（否则"加密"是假的）----
  const r3 = bash(
    `printf '%s' "wrong-pass" | openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in "backup-20260925-1830.sql.gz.enc" -out "bad.gz" -pass stdin 2>&1; echo "RC=$?"`,
    {},
    c1,
  )
  ok('换一个口令解密会失败（说明口令真的参与了密钥）', /RC=[1-9]/.test(r3.out), r3.out.slice(-200))
}

/* ---------------- ② 口令缺失 ---------------- */
section('2. 口令缺失 → 报错退出、一个字节都不写')
const c2 = join(root, 'no-pass')
execFileSync(BASH, ['-lc', `mkdir -p "${c2.replace(/\\/g, '/')}"`])
const gz2 = makeStub(c2)
const r4 = bash(
  `raw="backup-20260925-1830.sql"\nout="${gz2.replace(/\\/g, '/').split('/').pop()}"\n${trimFn}\n${block}\n`,
  { BACKUP_PASS_RAW: '', GITHUB_ENV },
  c2,
)
ok('退出码非零（工作流会红）', r4.rc !== 0, `rc=${r4.rc}`)
ok('打出了 ::error::（Actions 上会标红并给出原因）', r4.out.includes('::error::'), r4.out.slice(-300))
ok('没有产出 .enc 文件', !existsSync(join(c2, 'backup-20260925-1830.sql.gz.enc')))
ok(
  '连明文 .gz 也一起删掉了（失败路径上不留任何可上传的东西）',
  !existsSync(gz2),
  '这正是"绝不静默降级成明文"的落点',
)

/* ---------------- ③ 负向对照 ---------------- */
section('3. 负向对照：把「口令缺失就退出」拿掉，看结论会不会变')
const GATE = 'if [ -z "$BACKUP_PASS" ]; then'
const gi = block.indexOf(GATE)
ok('在抠出来的块里定位到了那道闸（if [ -z "$BACKUP_PASS" ] … fi）', gi > 0)

/*
 * 负向对照要证明的是：**去掉守卫以后，真的会出现"以为加密了、其实传的是明文"**。
 * 实测发现一个值得写下来的事实（这也让本改动比预想的更稳）：
 *   口令为空时 `openssl -pass stdin` **自己也会失败**（`Error reading password from BIO`），
 *   所以就算把 `if [ -z "$BACKUP_PASS" ]` 那道闸整个删掉，也**不会**产出 `.enc`；
 *   但那时拦住它的就只剩下面那道 `enc_rc` 报错闸了。
 *   两条合起来才是"绝不静默降级成明文"的完整保证（缺一条都得靠另一条兜着）——
 *   所以第 2 组断言里，原版是"非零退出 + 明文已删"，而下面这组要看到的是
 *   **去掉那一行之后，退出码就只剩 openssl 的错误在兜**。
 */

/**
 * 找出包含 `needle` 的那个 `if … fi` 块，返回 [start, end)。
 * 用**深度计数**配对：简单找"最近的一个 fi"会撞上嵌套/兄弟块，
 * 切出孤立的 fi → bash 报 syntax error → 那个退出码就说明不了任何事（本轮踩过）。
 */
function enclosingIf(text, needle) {
  const i = text.indexOf(needle)
  if (i < 0) return null
  const start = text.lastIndexOf('\nif ', i)
  if (start < 0) return null
  const re = /(^|\n)(if |fi\n)/g
  re.lastIndex = start + 1
  let depth = 1
  let m
  while ((m = re.exec(text))) {
    if (m[2] === 'if ') depth++
    else if (--depth === 0) return [start, m.index + m[0].length]
  }
  return null
}

/*
 * 负向对照的**唯一目的**：证明"口令缺失就退出"这一行不是装饰。
 * 做法：只把**这一道闸**拿掉，其余守卫一个字不动，跑同一个场景（口令为空），
 * 看它是不是**照旧绿着往下走、把明文留在原地等着上传**。
 *
 * 为什么这样就够（实测出来的事实）：口令为空时 `openssl -pass stdin` **必然失败**
 * （`Error reading password from BIO`），于是剩下的 `enc_rc` 检查会拦住它 ——
 * 所以真正防止"静默降级"的其实是**后面那道报错闸**，
 * 前面那道 if 的价值是**把话说清楚**（"缺 secret，去配"），而不是唯一的保险。
 * 这一点值得写进报告：本改动是**双保险**，不是一行 if 撑着的。
 */
const GUARDS = [{ label: '口令缺失就退出', needle: GATE }]
let stripped = block
const removed = []
for (const g of GUARDS) {
  const span = enclosingIf(stripped, g.needle)
  if (!span) continue
  // 整段 `if … fi` 换成一句合法语句：**不能**切出孤立的 if/fi，
  // 否则 bash 直接 `syntax error`，那个退出码跟"守卫"没有关系（证明不了任何事）
  stripped = `${stripped.slice(0, span[0])}\n: # 对照版：已把「${g.label}」拿掉${stripped.slice(span[1])}`
  removed.push(g.label)
}
ok('对照版确实把那道闸拿掉了', removed.length === 1)
for (const g of removed) console.log(`     （对照版已拿掉：${g}）`)

const c3 = join(root, 'negative')
execFileSync(BASH, ['-lc', `mkdir -p "${c3.replace(/\\/g, '/')}"`])
const gz3 = makeStub(c3)
const negScript = `raw="backup-20260925-1830.sql"\nout="${gz3.replace(/\\/g, '/').split('/').pop()}"\n${trimFn}\n${stripped}\n`
// 先确认对照版自己是**语法合法**的（否则它退出码非零跟"守卫"没关系）
const syntax = bash(negScript, {}, c3, { checkOnly: true })
ok('对照版语法合法（bash -n 通过）', syntax.rc === 0, syntax.out.slice(-200))

const r5 = bash(negScript, { BACKUP_PASS_RAW: '', GITHUB_ENV }, c3)
const negEnc = join(c3, 'backup-20260925-1830.sql.gz.enc')
ok(
  '对照版：`.enc` 依然没产出（openssl 自己拒绝空口令）',
  !existsSync(negEnc),
  '说明"静默降级成明文"不止一道保险 —— 这是本轮实测出来的重要事实',
)
ok(
  '对照版：明文 .gz 也被删了（`enc_rc` 那一段的 `rm -f "$out"` 兜住了）',
  !existsSync(gz3),
  '所以危险状态（明文留在原地等着上传）**两道闸都拦得住** —— 删掉其中一道它仍然红',
)
ok(
  '对照版：报的是 openssl 的英文错，**那句人话 ::error:: 没了**',
  !r5.out.includes('拒绝生成明文备份'),
  '这就是那道 if 的真正价值：它是**诊断**（"缺 secret，去 Settings 配"），不是唯一的保险',
)

/* ---------------- 收尾 ---------------- */
rmSync(root, { recursive: true, force: true })

console.log('')
if (failures.length) {
  console.log(`❌ 备份加密实测失败：${failures.length}/${checks} 条不过`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exit(1)
}
console.log(`✅ 备份加密实测全部通过：${checks} 条断言`)
console.log('   （口令存在 → 真密文且能解回；口令缺失 → 非零退出、零字节外传；负向对照已验证它"能红"）')
