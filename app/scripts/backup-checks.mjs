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

/* ============================================================
   🔴 反向对照开关（AGENTS.md 第三节第 2 条：**每条新断言都要有反向对照**）
   ------------------------------------------------------------
   这一轮新加的断言守的是"**导出/导入必须带上两张档案表**"。按纪律，"把修复改回去 →
   必须红"这条对照要**真的跑过**，所以它不是嘴上说说，而是两个可执行的开关：

     node scripts/backup-checks.mjs --drop-profile-tables      # 模拟"导出里没有这两张表"
     node scripts/backup-checks.mjs --legacy-version-floor     # 模拟"老版本客户端只认到 v3"

   ⚠️ 这两个分支**只在对照时开**，平时一个字都不生效（默认两个都是 false）。
      它们模拟的正是"修复之前的那份代码"：一个把新表从导出里去掉，一个把 v4 判成不认识的版本。
   ⚠️ 有它们才叫"反向对照真跑红了"；没有它们，那两条断言就只是**永远为绿的摆设**。
   ============================================================ */
const DROP_PROFILE_TABLES = process.argv.includes('--drop-profile-tables')
const LEGACY_VERSION_FLOOR = process.argv.includes('--legacy-version-floor')

/**
 * 把"修复前"的那份行为盖回 `lib/backup.ts` 的导出结果上（**只用于反向对照**）。
 * ① 老导出：`makeBackup` 里根本没有这两项；
 * ② 老导入：`validateBackup` 只认到 v3（v4 报"版本不认识"）。
 *
 * ⚠️ ESM 的模块命名空间对象是**只读**的（`Cannot assign to read only property`），
 *    所以这里**不改命名空间，而是给调用方一份可写的浅拷贝**（函数自己引用的是模块内部
 *    的绑定，盖在拷贝上照样生效）。返回 undefined 表示"不开对照，用原样的命名空间"。
 */
function legacyShape(B) {
  if (!DROP_PROFILE_TABLES && !LEGACY_VERSION_FLOOR) return undefined
  /*
   * 🔴 **`{ ...B }` 会把 ESM 的活绑定拍成快照** —— `lastKeyUpgrade` 是 `let` 导出，
   *    展开之后读到的永远是"展开那一刻"的值（`undefined`），于是第六节三条**无关**的
   *    断言会跟着红（本轮被这个坑绊过一次）。
   *    所以只**按需重定义**要改的那一个函数，其余原样继承（活绑定照旧）。
   *    ⚠️ 而且重定义必须**先删掉继承来的那个属性**（模块命名空间的描述符
   *    `configurable: false`，不删就 `Cannot redefine property`）。
   */
  const M = {}
  Object.setPrototypeOf(M, B)
  const realValidate = B.validateBackup
  const realExport = B.exportWithProfiles
  if (LEGACY_VERSION_FLOOR) {
    M.validateBackup = (raw) => {
      const v = raw && typeof raw === 'object' ? raw.v : undefined
      if (v === 4) return { ok: false, why: `备份版本不认识（v${String(v)}）` }
      return realValidate(raw)
    }
  }
  if (DROP_PROFILE_TABLES) {
    M.exportWithProfiles = async (s) => {
      const r = await realExport(s)
      const data = { ...r.data }
      // 修复前：`makeBackup` 里根本没有这两项
      delete data.studentProfiles
      delete data.teacherProfiles
      return { data, issues: r.issues }
    }
  }
  return M
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
      // 第 20 段（P1 序列号键迁移）：`students.serial` 列不在时**一个字都不许带**
      students: 'serial',
    }
    const WRITE_TABLES = ['teachers', 'classes', 'students', 'assignments', 'schedule_items', 'classrooms', 'calls', 'shared_files',
      /* 🆕 两张档案表（第七节）：不列进来的话会被上面那条 404 挡掉，
         表现成"表不存在"（`ensureStudentProfiles()` 回 `missing`）—— 那是**假红**：
         真库里这两张表跑过 §35/§36。 */
      'student_profiles', 'teacher_profiles']

    /**
     * 两张档案表的读结果（第七节用）。按 `student_id` / `teacher_id` 的 `in.()` 过滤，
     * 形状与 PostgREST 的 `select('*')` 一致（snake_case）。
     */
    const FAKE_UID_PROF = '11111111-1111-4111-8111-111111111111'
    const STUDENT_ID_PROF = '44444444-4444-4444-8444-444444444444'
    const STUDENT_ID_PROF2 = '44444444-4444-4444-8444-444444444445'
    let STUDENT_PROFILE_ROWS = [
      { student_id: STUDENT_ID_PROF, ethnicity: '汉族', birth_month: '2010-05', guardian_phone: '13800000001', home_address: '某小区1号楼2单元501' },
      { student_id: STUDENT_ID_PROF2, ethnicity: '回族', birth_month: '2010-11', guardian_phone: '13800000002', home_address: '某小区3号楼1单元101' },
    ]
    let TEACHER_PROFILE_ROWS = [
      { teacher_id: FAKE_UID_PROF, home_address: '教师公寓5号楼', phone: '010-12345678', email: 'wang@example.com' },
    ]

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
          // 🆕 两张档案表：按 `in.(...)` 的 id 清单滤一遍（与真 PostgREST 的形状一致）
          if (table === 'student_profiles' || table === 'teacher_profiles') {
            const key = table === 'student_profiles' ? 'student_id' : 'teacher_id'
            const rowsAll = table === 'student_profiles' ? STUDENT_PROFILE_ROWS : TEACHER_PROFILE_ROWS
            const filter = url.searchParams.get(key)
            const want = filter ? filter.replace(/^in\.\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : null
            const rows = want ? rowsAll.filter((r) => want.includes(r[key])) : rowsAll
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(rows))
            return
          }
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
      const rawB = await import(mod('src/lib/backup.ts'))
      // ↳ 反向对照开关接上去（默认两个开关都是 false，"修复后"的真实行为原样）
      const B = legacyShape(rawB) ?? rawB
      /**
       * 反向对照 `--legacy-version-floor` 下 `validateBackup(v4文件)` 会是 `{ok:false}`，
       * 于是 `r.data` 是 undefined。**每条断言自己会报红**，但脚本不该在这里崩掉
       * （崩了后面的断言一条都跑不到，"哪条红了"就看不出来了）。
       * ⚠️ 只给"读的是一个 v4 文件"的那几处垫一个空壳，别到处撒 —— 那会把真问题盖住。
       * ⚠️ 空壳里也得有 `teacher` / `classes`（一份"最小形状"），否则后面的页面级代码
       *    （`teacher.primarySubjectCode` 之类）会**崩**而不是**红** —— JS 不检查这些。
       */
      const emptyBackup = () => ({
        classes: [],
        assignments: [],
        calls: [],
        /* ⚠️ `teacher` 而不是 `null`：`restoreBackup` 对 null 会保留原来那位老师，
           于是"老师的显示名没被改写"之类会**碰巧绿**（那是假绿，比红更糟）。 */
        teacher: { id: 't-1', name: '老师', subject: '物理', school: '' },
        studentProfiles: [],
        teacherProfiles: [],
      })
      const vd = (r) => r.data ?? emptyBackup()

      /* ============================================================
         一、备份归一化（纯函数，不收服务）：v1 兼容 + 认不出留 undefined
         ============================================================ */

      section('一、备份归一化：v1 老备份仍能导入 · 认不出绝不猜、绝不留 null')
      {
        const v1 = B.validateBackup(backupFile())
        eq('v1 老备份仍然能导入（向后兼容）', v1.ok, true)
        /* ⚠️ 期望值变了（不是因为代码红了才改）：**当前版本已经是 v4**（加了两张档案表），
           "收进来一律归一成当前版本"这条判据本身没变，变的是"当前版本是几"。 */
        eq('收进来的版本一律归一成 v4（当前版本）', v1.data.v, 4)
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

        /* ⚠️ 这两条的形状变了：**v4 现在是"当前版本"**（加了两张档案表），
           所以"新版本不接受"的那条判据挪到 v5 上（下一条）。这是期望值变，
           不是"为了绿而改绿"：v4 从"未来版本"变成了"我们自己写出去的那个版本"。 */
        eq('v4 收（它就是当前版本）', B.validateBackup(backupFile({ v: 4 })).ok, true)
        eq('v5 不认（比当前版本高 → 宁可报错也不猜一份看不懂的结构）', B.validateBackup(backupFile({ v: 5 })).ok, false)
        eq('没有 v 也不认', B.validateBackup({ classes: [klass()], assignments: [] }).ok, false)

        const exported = B.makeBackup({
          teacher: teacher({ subject: '化学竞赛', primarySubjectCode: 'chemistry' }),
          classes: [klass()],
          assignments: [asg({ subject: '化学', subjectCode: 'chemistry' })],
          schedule: [],
          calls: [],
          classrooms: [],
        })
        eq('makeBackup 导出的是 v4', exported.v, 4)
        ok(
          '导出的文件里真的带着 subjectCode（不是靠 import 时反查）',
          exported.assignments[0].subjectCode === 'chemistry' &&
            exported.teacher.primarySubjectCode === 'chemistry',
        )
        const roundTrip = B.validateBackup(JSON.parse(JSON.stringify(exported)))
        /* ⚠️ `?.` 是给反向对照留的：`--legacy-version-floor` 下 v4 会被判成不认识的版本，
           `roundTrip.data` 是 undefined —— 别让脚本在这里崩掉（崩了就看不到"哪条红了"） */
        eq('导出 → 写文件 → 读回来：subjectCode 不丢', roundTrip.data?.assignments?.[0]?.subjectCode, 'chemistry')
        eq('同上：primarySubjectCode 不丢', roundTrip.data?.teacher?.primarySubjectCode, 'chemistry')
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
        eq('导入这一步没丢 code', vd(parsed).assignments[0]?.subjectCode, 'chemistry')

        useStore.getState().restoreBackup(vd(parsed))
        eq('恢复后本地档案带着 code', useStore.getState().assignments[0]?.subjectCode, 'chemistry')
        eq(
          '恢复后老师的主学科还在（本地模式下新建作业就靠它预选）',
          useStore.getState().teacher?.primarySubjectCode,
          'chemistry',
        )
        eq('恢复后老师的显示名没被改写', useStore.getState().teacher?.subject, '化学竞赛')
        eq('恢复后班级/名单照旧', useStore.getState().classes[0]?.students.length, 1)

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
        useStore.getState().restoreBackup(vd(oldOne))
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
        useStore.getState().restoreBackup(vd(oddOne))
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
        const msg = await B.pushBackupToCloud(vd(B.validateBackup(file)), FAKE_UID)
        ok('回推云端没报错', !msg.includes('⚠️'), msg)
        const tRow = lastPayload('teachers')
        eq('回推 teachers 带上了 primary_subject_code', tRow?.primary_subject_code, 'chemistry')
        const aRow = lastPayload('assignments')
        eq('回推 assignments 带上了 subject_code', aRow?.subject_code, 'chemistry')
        eq('回推之后依然没有任何 null 学科列', nullSubjectWrites(), [])

        requests.length = 0
        const msgOdd = await B.pushBackupToCloud(vd(oddOne), FAKE_UID)
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

      /* ============================================================
         六、序列号键迁移（§20 / P1）：v3 与 v1 **双向**断言
         ------------------------------------------------------------
         为什么单开一节：P1 把"那 10 个字段的键"从**班内学号**换成了**序列号**（I40），
         而备份是唯一一份"离线也能把数据搬回来"的东西 —— 它必须**同时**满足两件事：
           · 导出（v3）带着序列号，导入回来键还是序列号（**不降级、不丢**）；
           · 导入一份 v1/v2 老备份（键是班内学号、学生没有序列号）时，
             按"班内学号 → 序列号"反查着**补成序列号**；补不到的**留原键**并报出来。
         两条都不是"看着对"就够 —— 它们决定恢复之后老师还能不能找到自己的学生。
         ============================================================ */

      section('六、序列号键（§20 / P1）：v3 导出不降级 · v1 老备份补成序列号 · 补不到留原键')
      {
        /*
         * 🔴 **本节自己先把 store 置成"本机已经有这一届学生"的样子**（发号基数靠它）——
         *    不能依赖上一节残留的 state：那样本节会随别人的改动忽绿忽红，
         *    而且反向对照跑出来的红会跑到**无关的**断言上去（假红比真红更贵）。
         *    ⚠️ 用与 `backup.ts` **同一个 store 实例**（无后缀那个模块）。
         */
        const store0 = (await import(mod('src/data/store.ts'))).useStore
        store0.setState({
          classes: [
            {
              id: '99999999-9999-4999-8999-999999999999',
              name: '高二(9)班',
              grade: '高二',
              year: '2026',
              createdAt: 1,
              students: [
                { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', studentNo: '1', serial: '2025001', name: '丙', status: 'active', createdAt: 1 },
                { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', studentNo: '2', serial: '2025002', name: '丁', status: 'active', createdAt: 1 },
              ],
            },
          ],
        })
        /*
         * 夹具：一份**迁移后**形状的备份（v3）：学生有序列号，档案键就是序列号。
         * ⚠️ 这份刻意用 `validateBackup` 走一遍再断言 —— 导出→写文件→读回来
         *    这条路才是真实发生的（`makeBackup` 的返回值不会被直接使用）。
         */
        const v3klass = () => ({
          id: CLASS_ID,
          name: '高二(1)班',
          grade: '高二',
          year: '2026',
          createdAt: 1,
          students: [
            { id: STUDENT_ID, studentNo: '1', serial: '2025001', name: '甲', status: 'active', createdAt: 1 },
            { id: '44444444-4444-4444-8444-444444444445', studentNo: '2', serial: '2025002', name: '乙', status: 'active', createdAt: 1 },
          ],
        })
        const v3asg = () =>
          asg({
            missingNos: ['2025002'],
            lateNos: ['2025001'],
            confirmedNos: ['2025001'],
            focusNos: ['2025002'],
            correctionNos: ['2025001'],
            correctedNos: ['2025002'],
            wrong: { '2025001': ['3.1'] },
            grades: { '2025002': '良' },
          })

        const exported3 = B.makeBackup({
          teacher: teacher(),
          classes: [v3klass()],
          assignments: [v3asg()],
          schedule: [],
          calls: [],
          classrooms: [],
        })
        /* ⚠️ 期望值变了：`makeBackup` 现在写出去的是 **v4**（加了两张档案表）。
           这一节守的是"序列号键不降级"，与版本号无关 —— 版本号那两条在第一节。 */
        eq('导出版本是 v4（当前版本）', exported3.v, 4)
        eq('v3 导出：学生的序列号进文件', exported3.classes[0].students[0].serial, '2025001')

        const back3 = B.validateBackup(JSON.parse(JSON.stringify(exported3)))
        /*
         * ⚠️ `?.` 是给反向对照 `--legacy-version-floor` 留的：v4 会被整份拒绝，
         *    `back3.data` 是 undefined。**让断言报红，别让脚本崩** ——
         *    崩了本节后面的断言（含第七节那几条）一条都跑不到。
         */
        eq('v3 形状 → 导入：版本归一成 v4', back3.data?.v, 4)
        eq('🔴 v3 → 导入：学生的序列号**不丢**', back3.data?.classes?.[0]?.students[1].serial, '2025002')
        eq(
          '🔴 v3 → 导入：档案键仍是序列号（不降级回班内学号）',
          [
            back3.data?.assignments?.[0]?.missingNos,
            back3.data?.assignments?.[0]?.lateNos,
            back3.data?.assignments?.[0]?.confirmedNos,
            back3.data?.assignments?.[0]?.focusNos,
            back3.data?.assignments?.[0]?.correctionNos,
            back3.data?.assignments?.[0]?.correctedNos,
          ],
          [['2025002'], ['2025001'], ['2025001'], ['2025002'], ['2025001'], ['2025002']],
        )
        eq('🔴 v3 → 导入：wrong 的键仍是序列号', Object.keys(back3.data?.assignments?.[0]?.wrong ?? {}), ['2025001'])
        eq('🔴 v3 → 导入：grades 的键仍是序列号', Object.keys(back3.data?.assignments?.[0]?.grades ?? {}), ['2025002'])
        eq('v3 → 导入时**没有发生升级**（本来就不用升）', B.lastKeyUpgrade, undefined)

        /*
         * v1 老备份：学生没有序列号、键是班内学号。
         * 届从哪来？本机/云端**已经**有这一届的学生（序列号 2025001…）→
         * `upgradeKeysToSerial` 拿它当编号基数，从 2025003 往后发，**不从 001 重来**。
         *
         * ⚠️ store 用的是**本节开头**那份（`store0`，与 `backup.ts` 同一个实例）——
         *    这里不再重复 setState：本节中间没有任何东西动过 classes，重复设置只是噪声。
         *    ⚠️ **不能**用带 `?xxx` 后缀 import 出来的那个实例：那是另一个模块
         *    （本脚本故意用它模拟"刷新页面"），`backup.ts` 里的 `useStore` 指向没有后缀的那个，
         *    拿错了就永远读到空状态，表现成"届认不出来、一个号都没发"。
         */
        const store = store0

        const v1 = B.validateBackup(
          backupFile({
            classes: [
              {
                id: CLASS_ID,
                name: '高二(1)班',
                grade: '高二',
                year: '2026',
                createdAt: 1,
                students: [
                  { id: STUDENT_ID, studentNo: '1', name: '甲', status: 'active', createdAt: 1 },
                  { id: '44444444-4444-4444-8444-444444444445', studentNo: '2', name: '乙', status: 'active', createdAt: 1 },
                ],
              },
            ],
            assignments: [
              asg({
                missingNos: ['2'],
                lateNos: ['1'],
                confirmedNos: ['1'],
                focusNos: ['2'],
                correctionNos: ['1'],
                correctedNos: ['2'],
                wrong: { '1': ['3.1'] },
                grades: { '2': '良' },
              }),
            ],
          }),
        )
        eq('v1 老备份仍然能导入', v1.ok, true)
        eq(
          '🔴 v1 → 导入：学生**按 U-2 追加到年级末尾**拿到序列号（不从 001 重来）',
          v1.data.classes[0].students.map((s) => s.serial),
          ['2025003', '2025004'],
        )
        eq(
          '🔴 v1 → 导入：档案键被补成**序列号**（六个数组成员全查一遍）',
          [
            v1.data.assignments[0].missingNos,
            v1.data.assignments[0].lateNos,
            v1.data.assignments[0].confirmedNos,
            v1.data.assignments[0].focusNos,
            v1.data.assignments[0].correctionNos,
            v1.data.assignments[0].correctedNos,
          ],
          [['2025004'], ['2025003'], ['2025003'], ['2025004'], ['2025003'], ['2025004']],
        )
        eq('🔴 v1 → 导入：`wrong` 的键补成序列号', Object.keys(v1.data.assignments[0].wrong), ['2025003'])
        eq('🔴 v1 → 导入：`grades` 的键补成序列号', Object.keys(v1.data.assignments[0].grades), ['2025004'])
        eq('🔴 v1 → 导入：`calls.studentNos` 也一起补（两个字段，不是十个）', v1.data.calls, [])
        ok(
          '升级统计报得出来（谁被补了几个号）',
          B.lastKeyUpgrade && B.lastKeyUpgrade.assigned === 2 && B.lastKeyUpgrade.unresolved === 0,
          JSON.stringify(B.lastKeyUpgrade),
        )
        eq(
          'v1 → 导入：`students.legacyStudentNo` **故意不进备份**（它是迁移判据，不许被恢复写坏）',
          'legacyStudentNo' in v1.data.classes[0].students[0],
          false,
        )

        // ---- 补不到的键：**留原键** + 报出来（I14：认不出不许猜） ----
        const orphan = B.validateBackup(
          backupFile({
            classes: [
              {
                id: CLASS_ID,
                name: '高二(1)班',
                grade: '高二',
                year: '2026',
                createdAt: 1,
                students: [{ id: STUDENT_ID, studentNo: '1', name: '甲', status: 'active', createdAt: 1 }],
              },
            ],
            assignments: [asg({ missingNos: ['1', '77'] })],
          }),
        )
        eq('🔴 班里查不到的键（77）**留原键**，绝不清空', orphan.data.assignments[0].missingNos, ['2025003', '77'])
        ok(
          '🔴 补不到的条数被**报出来**（不是静默丢弃）',
          B.lastKeyUpgrade && B.lastKeyUpgrade.unresolved === 1,
          JSON.stringify(B.lastKeyUpgrade),
        )

        // ---- 幂等：同一份 v1 备份跑两遍，结果一模一样 ----
        const again = B.validateBackup(
          backupFile({
            classes: [
              {
                id: CLASS_ID,
                name: '高二(1)班',
                grade: '高二',
                year: '2026',
                createdAt: 1,
                students: [
                  { id: STUDENT_ID, studentNo: '1', name: '甲', status: 'active', createdAt: 1 },
                  { id: '44444444-4444-4444-8444-444444444445', studentNo: '2', name: '乙', status: 'active', createdAt: 1 },
                ],
              },
            ],
            assignments: [
              asg({
                missingNos: ['2'],
                lateNos: ['1'],
                confirmedNos: ['1'],
                focusNos: ['2'],
                correctionNos: ['1'],
                correctedNos: ['2'],
                wrong: { '1': ['3.1'] },
                grades: { '2': '良' },
              }),
            ],
          }),
        )
        eq(
          '🔴 幂等：同一份 v1 备份再跑一遍，键与序列号**与上一次逐字相同**',
          JSON.stringify([again.data.classes[0].students, again.data.assignments[0]]),
          JSON.stringify([v1.data.classes[0].students, v1.data.assignments[0]]),
        )

        // ---- 认不出届 → **不发号**（留着原键 + 报出来），绝不猜一个年份 ----
        store.setState({ classes: [] })
        const noYear = B.validateBackup(
          backupFile({
            classes: [
              {
                id: CLASS_ID,
                name: '初三(1)班',
                grade: '初三',
                year: '',
                createdAt: 1,
                students: [{ id: STUDENT_ID, studentNo: '1', name: '甲', status: 'active', createdAt: 1 }],
              },
            ],
            assignments: [asg({ missingNos: ['1'] })],
          }),
        )
        eq('认不出届 → 学生**没有**序列号（不猜年份）', noYear.data.classes[0].students[0].serial, undefined)
        eq('认不出届 → 档案键**留原键**', noYear.data.assignments[0].missingNos, ['1'])
        ok(
          '认不出届 → 报成"补不到"（而不是悄悄当成成功）',
          B.lastKeyUpgrade && B.lastKeyUpgrade.assigned === 0 && B.lastKeyUpgrade.unresolved === 1,
          JSON.stringify(B.lastKeyUpgrade),
        )
      }

      /* ============================================================
         七、档案（2026-10 · 数据安全缺口）：两张表必须**进导出、出得来**
         ------------------------------------------------------------
         🔴 修的 bug：`app/src/lib/backup.ts` 的导出/导入**不含 `student_profiles`
            （民族 / 出生年月 / 家长电话 / 家庭住址）与 `teacher_profiles`
            （家庭住址 / 电话 / 邮箱）**。老师点「导出备份文件」（换设备 / 换账号搬数据用的
            那一个）→ 两张表**静默丢掉**；而服务端那条链（AES pg_dump 全库 + 年级备份 payload）
            是全的 —— **只有客户端这一条漏了**。

         这一节守四件事（每条都有对应的反向对照开关，见文件开头的 `DROP_PROFILE_TABLES` /
         `LEGACY_VERSION_FLOOR`）：
          ① 导出真的带上两张表；② **导出 → 导入 → 再导出，两次逐字相等**（本项目对导入导出的
          既有验收口径）；③ **v1/v2/v3 老备份（没有这两张表）导入不许报错**，缺就当空；
          ④ 缺行 / 空表 / 引用了不存在的学生或老师 → **跳过并写进结果**（照 `backup.ts:745` 那带的口径）。
         ============================================================ */

      section('七、档案：导出带上两张表 · 往返逐字相等 · 老备份缺表当空 · 孤儿跳过并报出来')
      {
        const { useStore } = await import(mod('src/data/store.ts'))
        const STUDENT2 = '44444444-4444-4444-8444-444444444445'
        const klass2 = () => ({
          id: CLASS_ID,
          name: '高二(1)班',
          grade: '高二',
          year: '2026',
          createdAt: 1,
          students: [
            { id: STUDENT_ID, studentNo: '1', serial: '2025001', name: '甲', status: 'active', createdAt: 1 },
            { id: STUDENT2, studentNo: '2', serial: '2025002', name: '乙', status: 'active', createdAt: 1 },
          ],
        })
        /** 两份学生档案 + 自己那份教师档案（**PII 就在这几个字段上**）
         *  ⚠️ 这一份与假库里 `STUDENT_PROFILE_ROWS` / `TEACHER_PROFILE_ROWS` **故意逐字相同**：
         *     `exportWithProfiles` 是从库那边读的，而 store 里那一份（恢复之后用的）必须一致，
         *     否则"往返逐字相等"会拿两份不同的东西去比（那是夹具的错，不是代码的错）。 */
        const studentProfiles = [
          {
            studentId: STUDENT_ID,
            ethnicity: '汉族',
            birthMonth: '2010-05',
            guardianPhone: '13800000001',
            homeAddress: '某小区1号楼2单元501',
          },
          {
            studentId: STUDENT2,
            ethnicity: '回族',
            birthMonth: '2010-11',
            guardianPhone: '13800000002',
            homeAddress: '某小区3号楼1单元101',
          },
        ]
        const teacherProfiles = [
          {
            teacherId: FAKE_UID,
            homeAddress: '教师公寓5号楼',
            phone: '010-12345678',
            email: 'wang@example.com',
          },
        ]
        /** 后面好几条断言都拿它当"导出时的 store 快照" */
        const snapshot = () => ({
          teacher: teacher(),
          classes: [klass2()],
          assignments: [asg()],
          schedule: [],
          calls: [],
          classrooms: [],
          studentProfiles,
          teacherProfiles,
        })

        /*
         * ⚠️ 本节**不碰全局 store**：`exportWithProfiles(s)`/`restoreBackup(b)` 里的
         *    "导出"只读传进去的那一份快照，所以这两条断言与全局 store 无关。
         *    这么做是为了不把状态漏给别的节（反向对照下漏出去的 state 会把**无关**断言弄红，
         *    那种假红比真红更难查）。v3 老备份恢复后 store 里是空那一处，见本节最后一段。
         */

        // ---- ① 导出真的带上两张表（值就是那两个字段，不是"只有个空数组"） ----
        requests.length = 0
        const x1 = await B.exportWithProfiles(snapshot())
        ok(
          '🔴 导出的文件里带着**学生档案**（两行，连家长电话都在）',
          x1.data.studentProfiles?.length === 2 &&
            x1.data.studentProfiles[0].guardianPhone === '13800000001',
          JSON.stringify(x1.data.studentProfiles?.[0]),
        )
        eq(
          '🔴 导出的文件里带着**教师档案**（老师自己的那一行）',
          x1.data.teacherProfiles?.map((p) => p.teacherId),
          [FAKE_UID],
        )
        eq('导出版本 = v4（加了两张表就是新版本）', x1.data.v, 4)

        // ---- ② 往返逐字相等：导出 → 导入 → 再导出 ----
        /*
         * ⚠️ 比的是**导入归一化之后**的两份内容（`validateBackup` 的产物）——
         *    现实里"读文件"这一步就是走它（`Settings.tsx` 先 `validateBackup` 再 `restoreBackup`），
         *    而且 v1–v3 的归一化本来就会**有意**补字段（subjectCode 等）。
         *    若直接比两次 `makeBackup` 的原始返回，比的就成了"归一化补了哪些字段"，
         *    而不是"档案丢没丢" —— 那样断言会**永远红**，等于没有。
         *
         * ⚠️ 反向对照 `--legacy-version-floor` 下这一步整段会失败（v4 进不来）。
         *    那时**让后面的断言降级成红**、把这一节跑完，而不是抛异常 ——
         *    否则"新版本文件在老客户端上会被整份拒绝"这件事在报告里只剩一句崩溃信息，
         *    看不到"到底哪几条判据在守它"。
         */
        const strip = (o) => {
          const c = JSON.parse(JSON.stringify(o))
          delete c.at // 时间戳每份都不同，不是"内容"
          return c
        }
        const v4 = B.validateBackup(JSON.parse(JSON.stringify(x1.data)))
        const d1 = strip(v4.data ?? {})
        eq('v4 文件导入成功', v4.ok, true)
        if (v4.ok) {
          useStore.getState().restoreBackup(v4.data)
        } else {
          // 降级：把"恢复"这一步的产物置空，让下面三条**照常报红**而不是崩
          useStore.setState({ studentProfiles: [], teacherProfiles: [] })
        }
        eq('导入没丢学生档案', (v4.data?.studentProfiles ?? []).length, 2)
        eq('导入没丢教师档案', (v4.data?.teacherProfiles ?? []).length, 1)
        eq(
          '恢复后本地就带着这两份档案（不是只进了返回对象）',
          [
            useStore.getState().studentProfiles.length,
            useStore.getState().teacherProfiles.length,
          ],
          [2, 1],
        )
        const x2 = await B.exportWithProfiles(snapshot())
        const d2 = strip(B.validateBackup(JSON.parse(JSON.stringify(x2.data))).data ?? {})
        eq('🔴 往返逐字相等：导出 → 导入 → 再导出，两次内容一模一样', d2, d1)
        ok(
          '🔴 而且那两份内容里真的有四段 PII 的值（不是"两次都空"这种假相等）',
          JSON.stringify(d1).includes('13800000001') &&
            JSON.stringify(d2).includes('13800000001') &&
            JSON.stringify(d2).includes('教师公寓5号楼') &&
            JSON.stringify(d2).includes('010-12345678'),
        )

        // ---- ③ 向后兼容：v1/v2/v3 老备份里**没有**这两项 → 导入不许报错，缺就当空 ----
        const legacy3 = backupFile({ v: 3 }) // ⚠️ 刻意**不带** studentProfiles / teacherProfiles 两个键
        const l3 = B.validateBackup(legacy3)
        ok('🔴 v3 老备份导入**成功**（没有那两张表也不许整份失败）', l3.ok, true, l3.ok ? '' : l3.why)
        eq('v3 老备份：学生档案缺 → 空数组（不是报错）', l3.data.studentProfiles, [])
        eq('v3 老备份：教师档案缺 → 空数组', l3.data.teacherProfiles, [])
        const saveL3 = l3.data
        /*
         * ⚠️ 这里**不能**断言"恢复后再导出是空的"：`exportWithProfiles` 是从**库**里读档案的
         *    （这正是它的职责），而假库里那两行还在 —— 那会变成一条**永远红**的断言。
         *    要守的是"老备份缺表 → restore 之后 store 里就是空"，所以断言 store 那一份
         *    （放到本节最后做，免得把 ② 已经恢复好的状态冲掉）。
         */

        // 显式 null / 乱结构也不许把整份备份搞坏（"别的数据不能丢"）
        const junk = B.validateBackup(
          backupFile({
            v: 3,
            studentProfiles: [
              null,
              'abc',
              {},
              { studentId: '', guardianPhone: '1' },
              { studentId: STUDENT_ID, ethnicity: 123, guardianPhone: 13800000001, homeAddress: null },
              { studentId: STUDENT_ID, ethnicity: '第二条' },
            ],
            teacherProfiles: [{ teacherId: FAKE_UID, phone: '  010-1  ' }],
          }),
        )
        ok('乱结构的两张表不会让整份备份失败', junk.ok, true, junk.ok ? '' : junk.why)
        eq('无主的行（没有 studentId）被丢掉', junk.data.studentProfiles.length, 1)
        eq('同一个学生两条 → 只留第一条（撞主键会让整批 upsert 落不了库）', junk.data.studentProfiles[0].ethnicity, '123')
        eq('字面 null / 非对象被丢掉', junk.data.studentProfiles[0].homeAddress, '')
        eq('字符串两端的空白被收干净', junk.data.teacherProfiles[0].phone, '010-1')
        eq('班级/作业照旧不受影响', junk.data.classes[0].students.length, 1)

        // ---- ④ 回推云端：孤儿跳过并报出来 · 两张表走对主键 · 空表不发请求 ----
        requests.length = 0
        const pushMsg = await B.pushBackupToCloud(
          // ⚠️ 反向对照下这份 v4 文件会被整份拒绝 → 用 `?.` 垫空，别让脚本崩（下面的断言照红）
          B.validateBackup(
            backupFile({
              v: 4,
              classes: [klass2()],
              // 一行挂在不存在的学生上（本地删学生留下的孤儿）、一行挂在不存在的老师上
              studentProfiles: [
                { studentId: STUDENT_ID, ethnicity: '汉族', guardianPhone: '13800000001' },
                { studentId: '99999999-9999-4999-8999-999999999999', ethnicity: '孤儿' },
              ],
              teacherProfiles: [
                { teacherId: FAKE_UID, phone: '010-12345678' },
                { teacherId: '88888888-8888-4888-8888-888888888888', phone: '别人的电话' },
              ],
            }),
          ).data ?? {},
          FAKE_UID,
        )
        ok('回推没报错', !pushMsg.includes('⚠️'), pushMsg)
        const spReq = [...requests].reverse().find((r) => r.path.split('/')[0] === 'student_profiles')
        ok('学生档案**发出去了**（不是被整段跳过）', Boolean(spReq))
        eq(
          '学生档案：孤儿行被跳过（只推备份里真有的那个学生）',
          Array.isArray(spReq?.body) ? spReq.body.map((r) => r.student_id) : [],
          [STUDENT_ID],
        )
        const tpReq = [...requests].reverse().find((r) => r.path.split('/')[0] === 'teacher_profiles')
        eq(
          '教师档案：只推自己那一行（别人那行不推）',
          Array.isArray(tpReq?.body) ? tpReq.body.map((r) => r.teacher_id) : [],
          [FAKE_UID],
        )
        ok(
          '🔴 跳过的条数被**报出来**（不是静默丢弃）',
          pushMsg.includes('已跳过') && pushMsg.includes('档案'),
          pushMsg,
        )
        ok(
          '回推结果里数得出两份档案',
          pushMsg.includes('1 份学生档案') && pushMsg.includes('1 份教师档案'),
          pushMsg,
        )
        eq('出生年月是 null/空 → 载荷里**不带** birth_month（数据库那条 check 只收 YYYY-MM）',
          'birth_month' in (spReq?.body?.[0] ?? {}),
          false,
        )

        // 空表：一个字节都不发（老备份里通常是空的）
        requests.length = 0
        const emptyMsg = await B.pushBackupToCloud(B.validateBackup(backupFile({ v: 3 })).data, FAKE_UID)
        eq(
          '两张表都空 → 连请求都不发',
          requests.filter((r) => ['student_profiles', 'teacher_profiles'].includes(r.path.split('/')[0])).length,
          0,
        )
        ok('而且结果里也不提这两张档案表（不报一个不存在的失败）',
          !emptyMsg.includes('学生档案') && !emptyMsg.includes('教师档案'), emptyMsg)

        // ---- ⑤ 收尾：v3 老备份恢复后 store 里就是空（缺 = 空，而不是"编一份出来"） ----
        useStore.getState().restoreBackup(saveL3)
        eq('v3 老备份恢复后：store 里的两张表是空的（没有凭空编出档案）', [
          useStore.getState().studentProfiles.length,
          useStore.getState().teacherProfiles.length,
        ], [0, 0])
        /* 收尾：这一节没有改过班级/老师，所以 restoreBackup 只动了"档案"两个字
           —— 但为了不给下一节留隐性输入，这里还是把班级原样写回一份有学生的形状 */
        useStore.setState({ classes: [klass2()] })
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
