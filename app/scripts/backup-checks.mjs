/**
 * 备份 / 恢复的回归检查（纯 Node，不用浏览器，不用 vitest）。
 *
 * 为什么要有它：这一轮修的是一个**不报错、但不可逆丢数据**的 bug ——
 *
 *   导出带 `subjectCode` → 导入（`normalizeAssignment`）把它丢了 →
 *   恢复后随便批改一次，`saveAssignment` 就把云端 `assignments.subject_code` upsert 成 NULL。
 *
 * 症状只有"学科筛选里多了一条未标学科""同学科老师看不见"，**不报错**，
 * 所以靠肉眼审查几乎不可能发现；而云端那一列是**不可逆**的（历史数据）。
 * 这类"某一条写入路径漏了归一化"的 bug 只能靠**真的走一遍那条路径**来守。
 *
 * 做法刻意与 `scripts/exam-checks.mjs` 同一套（见 功能设计与不变量.md §12.4.1 / §13.8）：
 *   · 起一个**假 PostgREST**，把每一次写请求的载荷原样记下来，两种模式：
 *       `present`        —— 线上库跑过那一段 SQL（列存在）
 *       `missing-cols`   —— 还没跑（列不存在，写载荷带上它就会被拒）
 *   · 用 Node 原生 TS 类型剥离 + `scripts/lib/ts-resolve.mjs`，直接 import
 *     **仓库里的真源码**（`lib/backup.ts` / `data/store.ts` / `data/remote.ts`），不是复刻；
 *   · "批改一次"走**真 store 的 `setGrade`**，不是手工拼一个载荷 ——
 *     要守的正是"这条真路径"。
 *
 * 用法：cd app && node scripts/backup-checks.mjs
 * 退出码 0 = 全过。
 */

import { createServer } from 'node:http'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolvePath(HERE, '..')

/**
 * 假 Supabase 的地址。**必须在 import 任何 TS 之前设好**：
 * `lib/supabase.ts` 在模块顶层就读 `import.meta.env`（Node 里由解析钩子换成
 * `globalThis.__VITE_ENV__`）——没配就退回本地模式，那样 `remote.ts` 一次请求都不发。
 *
 * ⚠️ 端口默认 5197，**故意与 `exam-checks.mjs`（5199）错开**：两个脚本万一被同时跑起来，
 *    端口撞车会表现成"读到别人的请求"，很难查。要改就设 `SHUGAO_SB_PORT`，
 *    别去改代码（同一个端口散在 4 处，改一处漏一处）。
 */
const PORT = Number(process.env.SHUGAO_SB_PORT || 5197)
globalThis.__VITE_ENV__ = {
  VITE_SUPABASE_URL: `http://127.0.0.1:${PORT}`,
  VITE_SUPABASE_ANON_KEY: 'fake-anon-key',
}

// 解析钩子必须在 import 任何 TS 之前装上（无扩展名导入 / 目录导入 / import.meta.env）
registerTsResolve()

/**
 * 把仓库里的相对路径变成可 import 的 URL。
 * ⚠️ Windows 上**必须**转成 `file://` URL —— 直接丢 `C:\...` 给 import 会报
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 *
 * `suffix`（`?xxx`）用来**强制拿到一个新模块实例**：`ensureSubjectCols()` 的探测结果
 * 是按模块缓存的，换模式必须换实例 —— 等价于"刷新页面"。
 */
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

await withLock(async () => {
    /* ============================================================
       假 PostgREST
       ------------------------------------------------------------
       只做三件事：记下每个请求、按模式回"新列在不在"、写请求回 201 + 回显 id。
       回显 id 是必须的：`pushBackupToCloud` 会拿 `.select('id')` 数回落库行数，
       只回 `[]` 的话它会判成"只落库 0/N 行"（那是另一条纪律，别在这里误伤）。
       ============================================================ */

    /*
     * 兼容期的新列：学科那两列（第 12 段）+ `classes.grade_id`（第 10 段）
     * + `shared_files.class_ids`（第 19 段，2026-09-28）。
     * 同一批纪律：**列不存在就不许出现在载荷里**（否则整条 upsert / insert 被 PostgREST 拒掉）。
     */
    const NEW_COL = {
      assignments: 'subject_code',
      teachers: 'primary_subject_code',
      classes: 'grade_id',
      shared_files: 'class_ids',
    }
    const WRITE_TABLES = ['teachers', 'classes', 'students', 'assignments', 'schedule_items', 'classrooms', 'calls', 'shared_files']

    /**
     * `shared_files` 的读结果（第五节用）：`remote` 那一层读的是 `.select('*')`，
     * 列不存在时**只是没有那个键**、不报错 —— 这里就照那个形状喂。
     */
    let FILE_ROWS = []

    /** 'present' | 'missing-cols' */
    let MODE = 'present'
    const requests = []

    /**
     * 年级表的内容（`remote.ts` 的 `ensureGradeLookup` 拿它把
     * `classes.grade` 这个**文本**换成 `grades.id`）。第四节会改写它来验"认不出/歧义"。
     */
    const GRADE_GAO2 = '55555555-5555-4555-8555-555555555555'
    const GRADE_GAO3 = '66666666-6666-4666-8666-666666666666'
    const GRADE_GAO2B = '77777777-7777-4777-8777-777777777777'
    let GRADES_ROWS = [
      { id: GRADE_GAO2, name: '高二' },
      { id: GRADE_GAO3, name: '高三' },
    ]

    /** 载荷里带不带那两个新列（列不存在时，真实 PostgREST 会因为这两列整条拒绝） */
    function newColInPayload(table, body) {
      const col = NEW_COL[table]
      if (!col) return false
      const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []
      return rows.some((r) => r && typeof r === 'object' && col in r)
    }

    const columnMissingBody = (table, col) => ({
      code: '42703',
      message: `column "${col}" of relation "${table}" does not exist`,
      details: null,
      hint: null,
    })

    const tableMissingBody = (table) => ({
      code: '42P01',
      message: `relation "public.${table}" does not exist`,
      details: null,
      hint: null,
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const path = url.pathname.replace(/^\/rest\/v1\/?/, '')
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          body = raw
        }
        const table = path.split('/')[0]
        requests.push({ method: req.method, path, query: url.search, body })

        // 认证端点：给一个空对象就够（auth-js 只看有没有过期）
        if (url.pathname.startsWith('/auth/v1/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        /*
         * 存储端点（`uploadFile` 会先把文件传上去）：回 200 + 一个 Key 就够。
         * 不拦的话它会掉进下面那条 404（"表不存在"），`uploadFile` 会在上传这一步就抛错，
         * 第五节的"写载荷"就永远看不到了。
         */
        if (url.pathname.startsWith('/storage/v1/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ Key: `classroom-files/${url.pathname.split('/').slice(4).join('/')}` }))
          return
        }
        if (!WRITE_TABLES.includes(table)) {
          // 年级表只读（前端拿它把班级里的年级文本换成 grade_id）—— 见第四节
          if (table === 'grades' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(GRADES_ROWS))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify(tableMissingBody(table)))
          return
        }

        if (MODE === 'missing-cols') {
          // 探列：`select=subject_code` 会直接报 42703
          const select = url.searchParams.get('select') ?? ''
          const probed = Object.values(NEW_COL).find((c) => select.split(',').includes(c))
          if (probed) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify(columnMissingBody(table, probed)))
            return
          }
          // 写：载荷里带上不存在的列 → 整条 upsert / insert 被拒
          if (req.method !== 'GET' && newColInPayload(table, body)) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify(columnMissingBody(table, NEW_COL[table])))
            return
          }
        }

        if (req.method === 'GET') {
          // 文件列表：喂 FILE_ROWS（第五节用它验"列不存在时读也不崩、classIds 兜底成空数组"）
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(table === 'shared_files' ? FILE_ROWS : []))
          return
        }
        const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []
        /*
         * 回显。真实 PostgREST 在 `.single()`（Accept: application/vnd.pgrst.object+json）
         * 时回**一个对象**、否则回数组；而 `uploadFile` 走的是 `.select().single()`。
         * 这里把载荷原样回显（补上 id / created_at 两个服务端默认值）——
         * 于是 `rowToFile()` 的映射也能被断言（第五节），不只是"请求发出去了"。
         */
        const echo = rows.map((r) => ({ ...r, id: r?.id ?? crypto.randomUUID(), created_at: r?.created_at ?? new Date().toISOString() }))
        const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(wantsObject ? (echo[0] ?? null) : echo))
      })
    })

    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

    /*
     * 会话：直接给 fetch 挂一个带 JWT 的头，不去跟 auth-js 的存储/锁较劲
     * （理由与踩过的两条弯路写在 exam-checks.mjs 里，别重走）。
     */
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const FAKE_UID = '11111111-1111-4111-8111-111111111111'
    const FAKE_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: FAKE_UID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: 'authenticated',
      role: 'authenticated',
    })}.sig`
    const origFetch = globalThis.fetch
    globalThis.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers ?? {})
      headers.set('apikey', 'fake-anon-key')
      headers.set('Authorization', `Bearer ${FAKE_JWT}`)
      return origFetch(input, { ...init, headers })
    }

    /*
     * localStorage：**无条件**换成内存实现（Node 24 自带的那个在这个进程里没有磁盘后端，
     * auth-js 存进去读不回来）。
     */
    const mem = new Map()
    globalThis.localStorage = {
      getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
      setItem: (k, v) => mem.set(String(k), String(v)),
      removeItem: (k) => mem.delete(String(k)),
      clear: () => mem.clear(),
      key: (i) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size
      },
    }
    globalThis.location = { hostname: '127.0.0.1', origin: `http://127.0.0.1:${PORT}` }

    /* ---------------- 测试数据 ---------------- */

    const CLASS_ID = '22222222-2222-4222-8222-222222222222'
    const ASG_ID = '33333333-3333-4333-8333-333333333333'
    const STUDENT_ID = '44444444-4444-4444-8444-444444444444'

    const klass = () => ({
      id: CLASS_ID,
      name: '高二(1)班',
      grade: '高二',
      year: '2026',
      createdAt: 1,
      students: [{ id: STUDENT_ID, studentNo: '1', name: '甲', status: 'active', createdAt: 1 }],
    })

    /** 一份作业档案（默认「物理」，逐题数据齐全 —— 批改那套"默认全对、只记例外"一个字不动） */
    const asg = (over = {}) => ({
      id: ASG_ID,
      title: '练习册 P12',
      classId: CLASS_ID,
      subject: '物理',
      assignDate: '2026-09-20',
      questionCount: 10,
      status: 'open',
      createdAt: 1,
      collected: false,
      missingNos: [],
      lateNos: [],
      subQuestions: {},
      wrong: {},
      confirmedNos: [],
      questionMeta: {},
      statsMode: 'normal',
      grades: {},
      focusNos: [],
      correctionNos: [],
      correctedNos: [],
      ...over,
    })

    const teacher = (over = {}) => ({
      id: FAKE_UID,
      name: '王老师',
      subject: '物理',
      school: '树高中学',
      ...over,
    })

    /** 一份**原始**备份文件（默认 v1：只有中文显示名，没有 code —— 老备份的形状） */
    const backupFile = (over = {}) => ({
      v: 1,
      at: 1_700_000_000_000,
      teacher: teacher(),
      classes: [klass()],
      assignments: [asg()],
      schedule: [],
      calls: [],
      classrooms: [],
      ...over,
    })

    /** 请求记录里最近一次写某张表的载荷（第一行） */
    const lastPayload = (table) => {
      const hit = [...requests].reverse().find((r) => r.method !== 'GET' && r.path.split('/')[0] === table)
      if (!hit) return null
      return Array.isArray(hit.body) ? hit.body[0] : hit.body
    }

    /** 等 store 里那条 fire-and-forget 的写落下来 */
    async function waitForPayload(table, ms = 3000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const hit = lastPayload(table)
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 20))
      }
      return null
    }

    /** 全场扫一遍：哪些写请求把学科列写成了 null（用来钉"绝不写 null"这条） */
    const nullSubjectWrites = () =>
      requests
        .filter((r) => r.method !== 'GET' && r.body && typeof r.body === 'object')
        .flatMap((r) => {
          const table = r.path.split('/')[0]
          const rows = Array.isArray(r.body) ? r.body : [r.body]
          return rows.flatMap((row) =>
            Object.entries(NEW_COL)
              .filter(([t, col]) => t === table && row && typeof row === 'object' && row[col] === null)
              .map(([, col]) => `${table}.${col}`),
          )
        })

    /* ============================================================
       正式开始
       ============================================================ */

    try {
      const B = await import(mod('src/lib/backup.ts'))

      /* ============================================================
         一、备份归一化（纯函数，不收服务）：v1 兼容 + 认不出留 undefined
         ============================================================ */

      section('一、备份归一化：v1 老备份仍能导入 · 认不出绝不猜、绝不留 null')
      {
        const v1 = B.validateBackup(backupFile())
        eq('v1 老备份仍然能导入（向后兼容）', v1.ok, true)
        eq('收进来的版本一律归一成 v2', v1.data.v, 2)
        eq('v1 的「物理」按显示名反查 → physics', v1.data.assignments[0].subjectCode, 'physics')
        eq('v1 的老师「物理」→ primarySubjectCode physics', v1.data.teacher.primarySubjectCode, 'physics')

        const odd = B.validateBackup(
          backupFile({
            teacher: teacher({ subject: '化学竞赛' }),
            assignments: [asg({ subject: '化学竞赛' })],
          }),
        )
        ok(
          '字典外显示名（「化学竞赛」）认不出 → subjectCode 留 undefined',
          odd.data.assignments[0].subjectCode === undefined,
          String(odd.data.assignments[0].subjectCode),
        )
        ok(
          '老师的「化学竞赛」同样认不出 → primarySubjectCode undefined',
          odd.data.teacher.primarySubjectCode === undefined,
          String(odd.data.teacher.primarySubjectCode),
        )
        eq('字典外：显示名一个字都不动', odd.data.assignments[0].subject, '化学竞赛')
        eq('字典外：老师的显示名也不动', odd.data.teacher.subject, '化学竞赛')
        ok(
          'JSON 里连 "subjectCode":null 都不出现（不是"写了个 null 键"）',
          !JSON.stringify(odd.data).includes('"subjectCode":null') &&
            !JSON.stringify(odd.data).includes('"primarySubjectCode":null'),
        )

        const v2 = B.validateBackup(
          backupFile({ v: 2, assignments: [asg({ subject: '物理', subjectCode: 'chemistry' })] }),
        )
        eq('v2 带 code → 原样保留（不会被显示名带偏）', v2.data.assignments[0].subjectCode, 'chemistry')
        eq('显示名跟着 code 对齐（subject 只是 code 的显示缓存）', v2.data.assignments[0].subject, '化学')

        const badCode = B.validateBackup(
          backupFile({ v: 2, assignments: [asg({ subject: '语文', subjectCode: 'Chinese' })] }),
        )
        eq('非法 code（大小写不对）不认 → 按显示名反查兜住', badCode.data.assignments[0].subjectCode, 'chinese')

        const nullCode = B.validateBackup(
          backupFile({ v: 2, assignments: [asg({ subject: '物理竞赛', subjectCode: null })] }),
        )
        ok(
          '文件里显式写 null → 归一成 undefined（null 不往下传）',
          nullCode.data.assignments[0].subjectCode === undefined,
          String(nullCode.data.assignments[0].subjectCode),
        )

        const t2 = B.validateBackup(
          backupFile({
            v: 2,
            teacher: teacher({ subject: '化学竞赛', primarySubjectCode: 'chemistry' }),
          }),
        )
        eq('老师的 primarySubjectCode 保留', t2.data.teacher.primarySubjectCode, 'chemistry')
        eq(
          '老师的显示名**不被 code 覆盖**（「化学竞赛」是老师自己写的标签）',
          t2.data.teacher.subject,
          '化学竞赛',
        )

        eq('v3 不认（宁可报错也不猜一份看不懂的结构）', B.validateBackup(backupFile({ v: 3 })).ok, false)
        eq('没有 v 也不认', B.validateBackup({ classes: [klass()], assignments: [] }).ok, false)

        const exported = B.makeBackup({
          teacher: teacher({ subject: '化学竞赛', primarySubjectCode: 'chemistry' }),
          classes: [klass()],
          assignments: [asg({ subject: '化学', subjectCode: 'chemistry' })],
          schedule: [],
          calls: [],
          classrooms: [],
        })
        eq('makeBackup 导出的是 v2', exported.v, 2)
        ok(
          '导出的文件里真的带着 subjectCode（不是靠 import 时反查）',
          exported.assignments[0].subjectCode === 'chemistry' &&
            exported.teacher.primarySubjectCode === 'chemistry',
        )
        const roundTrip = B.validateBackup(JSON.parse(JSON.stringify(exported)))
        eq('导出 → 写文件 → 读回来：subjectCode 不丢', roundTrip.data.assignments[0].subjectCode, 'chemistry')
        eq('同上：primarySubjectCode 不丢', roundTrip.data.teacher.primarySubjectCode, 'chemistry')
      }

      /* ============================================================
         二、真 store + 真 remote（线上库**跑过**那一段 SQL）
         ============================================================ */

      section('二、核心链路：导出 → 导入 → 恢复 → 批改一次 → upsert 载荷（列存在）')
      {
        MODE = 'present'
        const { useStore } = await import(mod('src/data/store.ts'))
        const remote = await import(mod('src/data/remote.ts'))
        eq('假环境下走的是真 remote（已登录）', typeof remote.saveAssignment, 'function')

        // ---- ① 字典内学科：整条链路走一遍 ----
        requests.length = 0
        const file = JSON.parse(
          JSON.stringify(
            B.makeBackup({
              teacher: teacher({ subject: '化学竞赛', primarySubjectCode: 'chemistry' }),
              classes: [klass()],
              assignments: [asg({ subject: '化学', subjectCode: 'chemistry' })],
              schedule: [],
              calls: [],
              classrooms: [],
            }),
          ),
        )
        const parsed = B.validateBackup(file)
        eq('导入这一步没丢 code', parsed.data.assignments[0].subjectCode, 'chemistry')

        useStore.getState().restoreBackup(parsed.data)
        eq('恢复后本地档案带着 code', useStore.getState().assignments[0].subjectCode, 'chemistry')
        eq(
          '恢复后老师的主学科还在（本地模式下新建作业就靠它预选）',
          useStore.getState().teacher.primarySubjectCode,
          'chemistry',
        )
        eq('恢复后老师的显示名没被改写', useStore.getState().teacher.subject, '化学竞赛')
        eq('恢复后班级/名单照旧', useStore.getState().classes[0].students.length, 1)

        useStore.getState().setGrade(ASG_ID, {
          wrong: { 1: ['3'] },
          confirmedNos: ['1'],
          status: 'graded',
        })
        const put = await waitForPayload('assignments')
        ok('批改一次后确实发出了 assignments 写请求', Boolean(put))
        ok('载荷里**带上了** subject_code 这一列（不是碰巧没写）', Boolean(put && 'subject_code' in put))
        ok(
          '🔴 载荷里 subject_code 不是 null',
          put?.subject_code !== null && put?.subject_code !== undefined,
          JSON.stringify(put?.subject_code),
        )
        eq('🔴 载荷里 subject_code = 导入前的值', put?.subject_code, 'chemistry')
        eq('批改语义没动：wrong 原样落库', put?.wrong, { 1: ['3'] })
        eq('批改语义没动：confirmed_nos 原样落库', put?.confirmed_nos, ['1'])
        eq('批改语义没动：missing_nos 仍是空（默认全班已交、只记例外）', put?.missing_nos, [])

        // ---- ② v1 老备份（没有 code，只有显示名）：靠反查兜住 ----
        requests.length = 0
        const oldOne = B.validateBackup(backupFile({ assignments: [asg({ subject: '语文' })] }))
        useStore.getState().restoreBackup(oldOne.data)
        eq('v1 老备份恢复后 code 由显示名反查补上', useStore.getState().assignments[0].subjectCode, 'chinese')
        useStore.getState().setGrade(ASG_ID, { confirmedNos: ['1'] })
        const putOld = await waitForPayload('assignments')
        eq('🔴 v1 老备份批改后 upsert 载荷里 subject_code = chinese（不是 null）', putOld?.subject_code, 'chinese')

        // ---- ③ 字典外显示名：认不出就**不带这一列**（而不是写 null） ----
        requests.length = 0
        const oddOne = B.validateBackup(
          backupFile({
            teacher: teacher({ subject: '物理竞赛' }),
            assignments: [asg({ subject: '物理竞赛' })],
          }),
        )
        useStore.getState().restoreBackup(oddOne.data)
        eq('字典外：本地也不编一个 code', useStore.getState().assignments[0].subjectCode, undefined)
        useStore.getState().setGrade(ASG_ID, { confirmedNos: ['1'] })
        const putOdd = await waitForPayload('assignments')
        ok(
          '🔴 字典外：载荷里**不带** subject_code（不是写 null）',
          Boolean(putOdd) && !('subject_code' in putOdd),
          JSON.stringify(putOdd?.subject_code),
        )
        eq('字典外：显示名原样落库（老师写什么就是什么）', putOdd?.subject, '物理竞赛')

        // ---- 到这里为止，全场不该出现过任何一次"把学科列写成 null" ----
        eq('整场跑下来：学科列被写成 null 的次数 = 0', nullSubjectWrites(), [])

        // ---- ④ 回推云端（换账号恢复那条路）也守同一条纪律 ----
        requests.length = 0
        const msg = await B.pushBackupToCloud(B.validateBackup(file).data, FAKE_UID)
        ok('回推云端没报错', !msg.includes('⚠️'), msg)
        const tRow = lastPayload('teachers')
        eq('回推 teachers 带上了 primary_subject_code', tRow?.primary_subject_code, 'chemistry')
        const aRow = lastPayload('assignments')
        eq('回推 assignments 带上了 subject_code', aRow?.subject_code, 'chemistry')
        eq('回推之后依然没有任何 null 学科列', nullSubjectWrites(), [])

        requests.length = 0
        const msgOdd = await B.pushBackupToCloud(oddOne.data, FAKE_UID)
        ok('字典外备份回推云端也不报错', !msgOdd.includes('⚠️'), msgOdd)
        const tRow2 = lastPayload('teachers')
        ok(
          '字典外：回推 teachers **不带** primary_subject_code（不抹掉账号上已有的）',
          Boolean(tRow2) && !('primary_subject_code' in tRow2),
          JSON.stringify(tRow2?.primary_subject_code),
        )
        const aRow2 = lastPayload('assignments')
        ok(
          '字典外：回推 assignments **不带** subject_code',
          Boolean(aRow2) && !('subject_code' in aRow2),
          JSON.stringify(aRow2?.subject_code),
        )

        // ---- ⑤ 与老师那一列的**故意不同**（别顺手"统一"） ----
        requests.length = 0
        await remote.saveTeacher(teacher({ subject: '化学竞赛', primarySubjectCode: undefined }))
        const clearRow = lastPayload('teachers')
        ok(
          '老师显式清空主学科时，saveTeacher 写 null（这是"清空"动作本身，与作业那条**故意相反**）',
          clearRow?.primary_subject_code === null,
          JSON.stringify(clearRow?.primary_subject_code),
        )
      }

      /* ============================================================
         三、线上库**还没跑**那一段 SQL（列不存在）
         ============================================================ */

      section('三、列不存在时：不带这一列（也不写 null），整条 upsert 不许被拒')
      {
        MODE = 'missing-cols'
        requests.length = 0
        const remote2 = await import(mod('src/data/remote.ts', '?nocold=1'))
        eq(
          '探测结果：两列都不存在',
          await remote2.ensureSubjectCols(),
          { assignments: false, teachers: false },
        )

        requests.length = 0
        await remote2.saveAssignment({ ...asg({ subject: '化学', subjectCode: 'chemistry' }) }, FAKE_UID)
        const put = lastPayload('assignments')
        ok(
          '载荷里不含 subject_code（否则 PostgREST 会整条拒绝 → 刷新即丢）',
          Boolean(put) && !('subject_code' in put),
          JSON.stringify(put?.subject_code),
        )
        eq('这次写没有被服务端拒（写请求只有一条，且不是探列）', requests.filter((r) => r.method !== 'GET').length, 1)
        eq('载荷里其它字段照旧（title）', put?.title, '练习册 P12')
        eq('依然没有 null 学科列', nullSubjectWrites(), [])

        requests.length = 0
        await remote2.saveTeacher(teacher())
        const tPut = lastPayload('teachers')
        ok(
          'teachers 同款处理：列不存在时整列不出现',
          Boolean(tPut) && !('primary_subject_code' in tPut),
          JSON.stringify(tPut?.primary_subject_code),
        )
      }

      /* ============================================================
         四、建班要带 `grade_id`（2026-09-27：让年级主任/班主任管得动自己建的班）
         ------------------------------------------------------------
         为什么值得单独一节：`classes.grade_id` 是**权限判据的一环**
         （`visible_class_ids()` / `can_manage_class()` 里"年级主任看本年级"那一支），
         留空 → 自己建的班只有 super/admin 管得动（加不了学生、改不了班级课表）。
         前端手里只有 `classes.grade` 这个**文本**，要去 `grades` 表换 id；
         换不出来时**宁可留空也不猜** —— 猜错就是"把班交给错的年级主任"。
         ============================================================ */

      section('四、建班带 grade_id：换得出才带 · 认不出/歧义/列不存在都不带')
      {
        MODE = 'present'
        GRADES_ROWS = [
          { id: GRADE_GAO2, name: '高二' },
          { id: GRADE_GAO3, name: '高三' },
        ]
        // 每个小节用**新实例**（探测结果是按模块缓存的，换实例 = 刷新页面）
        const r3 = await import(mod('src/data/remote.ts', '?grade=1'))
        requests.length = 0
        await r3.saveClass(klass(), FAKE_UID)
        const put = lastPayload('classes')
        eq('列存在 + 年级名换得出 id → 载荷带上 grade_id', put?.grade_id, GRADE_GAO2)
        eq(
          '其它列照旧（name / grade 一个字没动）',
          { name: put?.name, grade: put?.grade, year: put?.year },
          { name: '高二(1)班', grade: '高二', year: '2026' },
        )

        // 不认识这个年级名（老师手填的、或年级表里没有）→ 整列不出现
        requests.length = 0
        await r3.saveClass({ ...klass(), grade: '高四' }, FAKE_UID)
        const putOdd = lastPayload('classes')
        ok(
          '认不出的年级名 → 连这一列都不出现（不写 null、不猜）',
          Boolean(putOdd) && !('grade_id' in putOdd),
          JSON.stringify(putOdd?.grade_id),
        )

        // 同名多条（`grades` 的唯一键是 school_id + name，跨学校可以重名）→ 歧义，同样不带
        GRADES_ROWS = [
          { id: GRADE_GAO2, name: '高二' },
          { id: GRADE_GAO2B, name: '高二' },
        ]
        const r4 = await import(mod('src/data/remote.ts', '?grade=2'))
        requests.length = 0
        await r4.saveClass(klass(), FAKE_UID)
        const putAmbig = lastPayload('classes')
        ok(
          '同一所学校外还有同名年级（歧义）→ 也不带这一列（权限字段绝不猜）',
          Boolean(putAmbig) && !('grade_id' in putAmbig),
          JSON.stringify(putAmbig?.grade_id),
        )

        // 恢复备份 → 回推云端那条路走的是 `classRows`，必须同款
        GRADES_ROWS = [{ id: GRADE_GAO2, name: '高二' }]
        const r5 = await import(mod('src/data/remote.ts', '?grade=3'))
        const rows = await r5.classRows([klass()], FAKE_UID)
        eq('回推云端用的 classRows 也带 grade_id（同一条判据）', rows[0]?.grade_id, GRADE_GAO2)

        // 老库（还没跑第 10 段：`classes.grade_id` 这一列不存在）→ 整列不出现
        MODE = 'missing-cols'
        const r6 = await import(mod('src/data/remote.ts', '?grade=4'))
        requests.length = 0
        await r6.saveClass(klass(), FAKE_UID)
        const putNoCol = lastPayload('classes')
        ok(
          'classes.grade_id 这一列不存在时 → 整列不出现（否则整条 upsert 被拒）',
          Boolean(putNoCol) && !('grade_id' in putNoCol),
          JSON.stringify(putNoCol?.grade_id),
        )
        eq(
          '这次建班没有被服务端拒（写请求只有一条，且不是探列）',
          requests.filter((r) => r.method !== 'GET').length,
          1,
        )

        MODE = 'present'
        GRADES_ROWS = [
          { id: GRADE_GAO2, name: '高二' },
          { id: GRADE_GAO3, name: '高三' },
        ]
      }

      /* ============================================================
         五、文件的班级归属（`shared_files.class_ids`，schema.sql §19，2026-09-28）
         ------------------------------------------------------------
         为什么单独一节：它是**又一条"新列 + 老库"的路**，而且比学科列更狠 ——
         学科列写错了只是偏一科，归属这一列写错/漏写就是"**传了但教室里看不见**"
         （本轮要修的那个缺口的原样重演），而且**一个字都不报**。
         三条纪律：
           ① 列在 → 写数组（一个文件可以同时属于几个班）；
           ② 列不在 → **不带这一列**（带上一列不存在的列，整条 insert 被 PostgREST 拒 → 刷新即丢），
              改走老列 `class_id`（单个班），跑完 §19 再搬（§19.2）；
           ③ 列不在 + 选了**两个以上**的班 → **当场报错**，绝不静默只存一个。
         跑的是仓库里真的 `src/lib/files.ts` + 真的 supabase-js（只把服务端换成假的）。
         ============================================================ */

      section('五、文件班级归属（class_ids，§19）：列在写数组 · 列不在就不带 · 多选+老库要报错')
      {
        const CLS_A = '99999999-9999-4999-8999-999999999991'
        const CLS_B = '99999999-9999-4999-8999-999999999992'
        /** 一个最小的"文件"：只要求 size / name / type 三样（Node 24 里 File 是全局的） */
        const PNG = () => new File([new Uint8Array([137, 80, 78, 71])], '题图.png', { type: 'image/png' })
        const fileWrites = () => requests.filter((r) => r.method !== 'GET' && r.path.split('/')[0] === 'shared_files')

        // ---- ① 列存在（跑过 §19）：归属写进数组，老列一个字都不写 ----
        MODE = 'present'
        const FA = await import(mod('src/lib/files.ts', '?files=1'))
        eq('探测：class_ids 这一列在 → { classIds: true }', await FA.ensureFileClassCols(), { classIds: true })

        requests.length = 0
        const up1 = await FA.uploadFile(PNG(), FAKE_UID, [CLS_A, CLS_B])
        const put1 = lastPayload('shared_files')
        eq('🔴 载荷带上了 class_ids（两个班都在 —— 这就是"一个课件几个班都能看"）', put1?.class_ids, [CLS_A, CLS_B])
        ok(
          '载荷里**没有**老列 class_id（一个字段一种语义：归属只在 class_ids 一处）',
          Boolean(put1) && !('class_id' in put1),
          JSON.stringify(put1?.class_id),
        )
        eq(
          '载荷的其它列照旧（teacher_id / name / mime / size）',
          { teacher_id: put1?.teacher_id, name: put1?.name, mime: put1?.mime, size: put1?.size },
          { teacher_id: FAKE_UID, name: '题图.png', mime: 'image/png', size: 4 },
        )
        ok(
          '存储路径仍按 `{teacher_id}/{uuid}-{文件名}`（§9 的桶策略就靠路径第一段判归属）',
          String(put1?.storage_path ?? '').startsWith(`${FAKE_UID}/`),
          String(put1?.storage_path),
        )
        eq('上传返回的那一行带着两个班（界面上那一行的归属显示不会错）', up1.classIds, [CLS_A, CLS_B])
        eq('这一次上传只发了一条 shared_files 写请求', fileWrites().length, 1)

        requests.length = 0
        await FA.uploadFile(PNG(), FAKE_UID, [])
        const put0 = lastPayload('shared_files')
        eq('一个班都不选 → class_ids 写成**空数组**（不是 null：null 会让读策略判不出来）', put0?.class_ids, [])
        eq(
          '整场下来 class_ids 被写成 null 的次数 = 0',
          nullSubjectWrites().filter((s) => s === 'shared_files.class_ids'),
          [],
        )

        // ---- ② 列不存在（线上库还没跑 §19）：不带这一列、改走老列；多选要当场报错 ----
        MODE = 'missing-cols'
        const FB = await import(mod('src/lib/files.ts', '?files=2'))
        eq('探测：列不存在 → { classIds: false }', await FB.ensureFileClassCols(), { classIds: false })

        requests.length = 0
        await FB.uploadFile(PNG(), FAKE_UID, [CLS_A])
        const putOld = lastPayload('shared_files')
        ok(
          '🔴 列不存在：载荷里**不含** class_ids（否则整条 insert 被 PostgREST 拒 → 刷新即丢）',
          Boolean(putOld) && !('class_ids' in putOld),
          JSON.stringify(putOld?.class_ids),
        )
        eq('列不存在：单个班改走**老列** class_id（先留住数据，跑完 §19 由 §19.2 搬）', putOld?.class_id, CLS_A)
        eq('这次上传没有被服务端拒（shared_files 写请求只有一条）', fileWrites().length, 1)

        requests.length = 0
        let multiErr = null
        try {
          await FB.uploadFile(PNG(), FAKE_UID, [CLS_A, CLS_B])
        } catch (e) {
          multiErr = e
        }
        ok(
          '🔴 列不存在 + 选了**两个**班 → 当场报错（绝不静默只存一个班）',
          Boolean(multiErr) && /只能选一个班/.test(String(multiErr?.message)),
          String(multiErr?.message ?? '(没有报错 —— 这正是最坏的那种"以为发出去了")'),
        )
        ok('  报错文案里给出了下一步（schema.sql 第 19 段）', /第 19 段/.test(String(multiErr?.message ?? '')))
        eq('🔴 报错时**一个请求都没发**（文件也没传上存储，不留孤儿）', requests.length, 0)

        // ---- ③ 读：列不存在时不崩，classIds 兜底成空数组（= 未指派 · 教室端看不到）----
        FILE_ROWS = [
          { id: 'r1', name: '有的.png', mime: 'image/png', size: 10, class_ids: [CLS_A, CLS_B], storage_path: 'x/a.png', created_at: '2026-09-28T00:00:00Z' },
          { id: 'r2', name: '没有归属的.png', mime: 'image/png', size: 20, class_ids: [], storage_path: 'x/b.png', created_at: '2026-09-28T00:00:00Z' },
          // ⚠️ 老库（没跑 §19）读出来就是这个形状：**没有 class_ids 这个键**，而不是 null
          { id: 'r3', name: '老库读出来的.png', mime: 'image/png', size: 30, class_id: CLS_A, storage_path: 'x/c.png', created_at: '2026-09-28T00:00:00Z' },
        ]
        const FC = await import(mod('src/lib/files.ts', '?files=3'))
        const list = await FC.listFiles()
        eq('读：有归属 / 空归属两行原样映射', [list[0]?.classIds, list[1]?.classIds], [[CLS_A, CLS_B], []])
        eq(
          '🔴 读：列不存在那一行**不报错**，classIds 兜底成空数组；老列 class_id **故意不兜底**（策略不看它，读了就是"界面显示一个班、教室端其实看不见"的分叉）',
          [list.length, list[2]?.classIds],
          [3, []],
        )

        FILE_ROWS = []
        MODE = 'present'
      }
    } catch (e) {
      failures.push(`脚本自身出错：${e?.stack ?? e}`)
      console.error('\n脚本自身出错：', e)
    } finally {
      server.close()
    }
}, { script: 'backup-checks.mjs' })

/* ---------------- 结果 ---------------- */

console.log(`\n${'='.repeat(56)}`)
if (failures.length) {
  console.log(`❌ 失败 ${failures.length} 条 / 通过 ${pass} 条`)
  for (const f of failures) console.log(`   · ${f}`)
  process.exitCode = 1
} else {
  console.log(`✅ 全过：${pass} 条断言`)
}
