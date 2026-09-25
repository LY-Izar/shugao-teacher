/**
 * 权限体系的常驻回归（PGlite = WebAssembly 版**真 PostgreSQL 17**，纯 Node，不用浏览器）。
 *
 * 为什么要有它（这是全项目风险最高、却长期没有任何自动化把关的边界）：
 *   · 「教室端只看得见自己班」「改网址被弹回」「学科教师只看自己那科」——
 *     这三条以前**全靠人在真机上手工点过**；
 *   · `功能设计与不变量.md` §13.8 / §16.10 里记着「PGlite 40 条 / Function 34 条 /
 *     前端 24 条全过」的实测，但**那些脚本是临时的、跑完就删了**，
 *     `schema.sql` 里还写着「见报告」而报告不在仓库 —— 最高风险的那条边界，
 *     唯一一次验证**没有留下任何痕迹**；
 *   · RLS 的失效方式恰恰是**不报错**：读策略少一支就是"读不到行"（教室大屏整片变空）、
 *     写策略写反了就是"保存失败 = 刷新即丢"（乐观更新先改本地，失败只进 syncError）。
 *     肉眼看代码几乎不可能发现，所以必须有一个**能常驻、能一键跑、红了就说明真坏了**的脚本。
 *
 * 做法（刻意与 `exam-checks.mjs` / `backup-checks.mjs` 同一套路）：
 *   ① 把 `supabase/schema.sql` 的**原文**灌进 PGlite —— 不是抄一份 SQL 到脚本里
 *      （抄一份 = 从今往后与真 schema 分叉，而且分叉了没人知道）；
 *   ② 灌之前先建出 **Supabase 的最小替身**：`auth.uid()` / `auth.users` /
 *      `storage.buckets` / `storage.objects` / `authenticated` / `anon` /
 *      `supabase_realtime` —— **schema.sql 一个字都不改**；
 *   ③ `set local role authenticated` + 会话变量里塞假 uid，**逐个身份真跑策略**，
 *      断言"谁能看见什么、谁能改什么"；
 *   ④ 写操作一律用**前端真实的 upsert 载荷形状** —— 列名来自仓库里真的
 *      `src/data/remote.ts` 的 `*ToRow`（Node 原生 import 真文件，不是手抄一份列名）；
 *   ⑤ 同一批固定数据跑**两个库**（A = 去掉第 16 段 / B = 全文），逐人逐表对比可见量，
 *      复现 §16.4「删旧策略前后可见量必须相等」这条验收口径。
 *
 * 用法：
 *   cd app
 *   node scripts/rls-checks.mjs          ***REMOVED*** 全过 → 退出码 0；红一条 → 退出码 1
 *   npm run rls-checks
 *
 * 负向对照（证明它不是"永远绿的摆设"）——故意把一条策略改坏，脚本**必须变红**：
 *   $env:RLS_NEGATIVE='classroom-write'    ; node scripts/rls-checks.mjs   ***REMOVED*** 给教室端开一个 assignments 的 INSERT
 *   $env:RLS_NEGATIVE='head-teacher-write' ; node scripts/rls-checks.mjs   ***REMOVED*** 让班主任也能改成绩
 *   $env:RLS_NEGATIVE='classes-insert'     ; node scripts/rls-checks.mjs   ***REMOVED*** 拿掉 classes_insert 里的 owns_class(id)
 *   $env:RLS_NEGATIVE='crack-a'            ; node scripts/rls-checks.mjs   ***REMOVED*** 把「教室端不许改自己那行 teachers」改回去
 *   $env:RLS_NEGATIVE='crack-b'            ; node scripts/rls-checks.mjs   ***REMOVED*** 把「教室端不许写 scope=mine 排课表」改回去
 *   $env:RLS_NEGATIVE='crack-c'            ; node scripts/rls-checks.mjs   ***REMOVED*** 把「教室端不许写 shared_files」改回去
 *   $env:RLS_NEGATIVE='exam-for-everyone'  ; node scripts/rls-checks.mjs   ***REMOVED*** 让考试写判据对**所有人**为真（谁都能改别人的考试档案）
 *   （改的全是**内存里的 SQL 文本**，仓库文件一个字节都不动。）
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { registerTsResolve } from './lib/ts-resolve.mjs'
import { withLock } from './lib/lock.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolvePath(HERE, '..')
const REPO = resolvePath(APP, '..')
const SCHEMA_FILE = resolvePath(REPO, 'supabase/schema.sql')

// 解析钩子必须在 import 任何 TS 之前装上（无扩展名导入 / 目录导入 / import.meta.env）。
// 它把 `import.meta.env` 换成 `globalThis.__VITE_ENV__`（默认 `{}`）= **本地模式**：
// `lib/supabase.ts` 不会去建客户端，而 `*ToRow` 这些纯函数照常可用。
registerTsResolve()

/**
 * 🔴 载荷形状的**唯一来源**：仓库里真的 `remote.ts`。
 * 手抄一份列名就等于又造了一个判定入口 —— 前端改了列名而这里没改，
 * 这里的"写成功"就成了假通过（真 PostgREST 会因为未知列把整条请求拒掉）。
 */
const M = await import(pathToFileURL(resolvePath(APP, 'src/data/remote.ts')).href)

/* ---------------- 主流程 ---------------- */

/*
 * 🔒 **整个脚本的工作都在这把锁里面**（`%TEMP%\shugao-verify.lock`，见 scripts/lib/lock.mjs）：
 * 五个验证脚本共用一把锁，同一时刻只允许一个在跑。这个脚本虽然不用 dev server / 浏览器，
 * 也照样上锁 —— 一是纪律统一（"跑验证"这件事本身就是全局的），
 * 二是内存里的 PGlite 很吃内存，和浏览器脚本叠在一起跑会互相拖慢、偶发超时。
 */
await withLock(async () => {
    /* ============================================================
       断言工具（与 exam-checks / backup-checks 同款）
       ============================================================ */

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
    /*
     * ⚠️ 这里原来有一个 `note()`（记录型发现：不影响通过/失败）。
     * 2026-09-25 两条裂缝收紧之后它的**最后一个调用方没了** —— 那两条"记录"变成了硬断言。
     * 留着它反而是个陷阱：下一个发现裂缝的人会顺手 `note()` 一下，然后看着绿灯收工，
     * 而裂缝真回来时脚本照样退 0。**要记就断言，要断言就让它能红。**
     */

    /** 意外中断只留一行人话：PGlite 的原生报错会把整份 SQL 回显出来，太吵 */
    process.on('unhandledRejection', (e) => {
      console.error(`\n❌ 脚本中断：${String(e?.message ?? e).split('\n')[0]}`)
      process.exit(1)
    })

    /* ============================================================
       固定数据集：一所学校 / 五个班 / 八种身份
       ------------------------------------------------------------
       id 全部写死（不随机），这样两个库（A/B）与两次运行之间的每一行都能对得上，
       「删旧策略前后可见量相等」才是一个**可复现**的断言而不是碰运气。
       ============================================================ */

    const mk = (tag, n) => `${tag}000000-0000-4000-8000-${String(n).padStart(12, '0')}`

    const U = {
      super: mk('a0', 1),
      admin: mk('a0', 2),
      grade: mk('a0', 3),
      head: mk('a0', 4),
      phy: mk('a0', 5),
      chn: mk('a0', 6),
      fresh: mk('a0', 7),
      room: mk('a0', 8),
    }
    const C = { c1: mk('c0', 1), c2: mk('c0', 2), c3: mk('c0', 3), c4: mk('c0', 4), c5: mk('c0', 5) }
    const S = { s1: mk('50', 1), s2: mk('50', 2), s3: mk('50', 3), s4: mk('50', 4), s5: mk('50', 5), s6: mk('50', 6), s7: mk('50', 7), s8: mk('50', 8) }
    const E = { a1: mk('e0', 1), a2: mk('e0', 2), a3: mk('e0', 3), a4: mk('e0', 4), a5: mk('e0', 5), a6: mk('e0', 6) }
    const CALL = { c1: mk('ca', 1), c2: mk('ca', 2) }
    const DEV = { d1: mk('d0', 1), d2: mk('d0', 2) }
    const SCH = { s1: mk('5c', 1), s2: mk('5c', 2), s3: mk('5c', 3) }
    const CS = { x1: mk('c5', 1), x2: mk('c5', 2), x3: mk('c5', 3) }
    const ROLE = { r1: mk('40', 1), r2: mk('40', 2), r3: mk('40', 3), r4: mk('40', 4) }
    /** 考试档案 / 分数行（第十三节用来打 `can_edit_exam_for` 与 exams 的写策略） */
    const EX = { e1: mk('e1', 1), e2: mk('e1', 2), e3: mk('e1', 3), e4: mk('e1', 4) }
    const EXS = { s1: mk('e2', 1), s2: mk('e2', 2) }
    /** 教室端账号行的 id **就是**它的 auth uid（`classroom_accounts.id references auth.users`） */
    const ACCT = { a1: U.room }
    /**
     * `shared_files` 的两行夹具（裂缝 C，2026-09-27）：
     *   f1 = 物理老师传的文件（真实形状）；
     *   f2 = **挂在教室端账号名下**的一行 —— 真实的教室端没有上传入口，
     *        这一行是**夹具**，专门用来钉"收紧写权限时不许把读也一起挡掉"
     *        （restrictive 的 `using` 对 SELECT 也生效，写成一条 `for all` 就会挡掉它）。
     */
    const F = { f1: mk('f0', 1), f2: mk('f0', 2), f3: mk('f0', 3), f4: mk('f0', 4) }

    /** 身份名（打印用）与顺序 —— 与文档 §16.4 那张表同一组人 */
    const WHO = {
      super: '最高管理员 super',
      admin: '教导处 admin',
      grade: '年级主任（高二）',
      head: '班主任（高二(1)班）',
      phy: '物理老师（教 1/4 班物理）',
      chn: '语文老师（教 1 班语文）',
      room: '教室端（高二(1)班）',
      fresh: '无身份新老师（只建了高一(1)班）',
    }
    const ORDER = ['super', 'admin', 'grade', 'head', 'phy', 'chn', 'room', 'fresh']

    /** 逐人可见量（**期望值** = 文档 §16.4 ① 那张「该看见」的表） */
    const EXPECTED = {
      super: { classes: 5, students: 8, assignments: 6, calls: 2, schedule_mine: 0, schedule_class: 2, classrooms: 2, class_subjects: 3, classroom_accounts: 1, teachers: 1, teacher_roles: 1 },
      admin: { classes: 5, students: 8, assignments: 6, calls: 2, schedule_mine: 0, schedule_class: 2, classrooms: 2, class_subjects: 3, classroom_accounts: 1, teachers: 1, teacher_roles: 1 },
      grade: { classes: 2, students: 5, assignments: 4, calls: 2, schedule_mine: 0, schedule_class: 2, classrooms: 2, class_subjects: 3, classroom_accounts: 1, teachers: 1, teacher_roles: 1 },
      head: { classes: 2, students: 4, assignments: 3, calls: 1, schedule_mine: 0, schedule_class: 1, classrooms: 1, class_subjects: 2, classroom_accounts: 1, teachers: 1, teacher_roles: 1 },
      phy: { classes: 2, students: 5, assignments: 3, calls: 2, schedule_mine: 1, schedule_class: 2, classrooms: 2, class_subjects: 3, classroom_accounts: 1, teachers: 1, teacher_roles: 0 },
      chn: { classes: 1, students: 3, assignments: 2, calls: 1, schedule_mine: 0, schedule_class: 1, classrooms: 1, class_subjects: 2, classroom_accounts: 1, teachers: 1, teacher_roles: 0 },
      room: { classes: 1, students: 3, assignments: 3, calls: 1, schedule_mine: 0, schedule_class: 1, classrooms: 1, class_subjects: 2, classroom_accounts: 1, teachers: 1, teacher_roles: 0 },
      fresh: { classes: 1, students: 1, assignments: 1, calls: 0, schedule_mine: 0, schedule_class: 0, classrooms: 0, class_subjects: 0, classroom_accounts: 0, teachers: 1, teacher_roles: 0 },
    }

    /* ============================================================
       Supabase 的最小替身
       ------------------------------------------------------------
       ⚠️ 必须在灌 schema.sql **之前**建好：schema.sql 里
         · §1 的触发器挂在 `auth.users` 上；
         · §6 给 `authenticated` / `anon` 授权；
         · §8 `alter publication supabase_realtime`；
         · §9 往 `storage.buckets` 插一行 + 在 `storage.objects` 上建三条策略（要 `storage.foldername`）；
         · §10 起所有策略都调 `auth.uid()`。
       替身之外，**schema.sql 一个字节都不改**（唯一的兜底是 PGlite 真不支持 publication 时
       摘掉 §8 那一小段，而且会在输出里说明）。
       ============================================================ */

    const STUBS = `
    -- ① 角色：Supabase 的 authenticated / anon（PGlite 里只有 postgres）
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin noinherit;
      end if;
    end $$;

    -- ② auth：只做 schema.sql 真正用到的那两样（users 表 + uid()）
    create schema if not exists auth;

    create table if not exists auth.users (
      id                 uuid primary key default gen_random_uuid(),
      email              text unique,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      created_at         timestamptz not null default now()
    );

    -- 与 Supabase 同款：从会话里的 JWT 声明取 sub。
    -- 假 uid 就是这么"登进去"的 —— 不碰 schema.sql 的任何一行。
    create or replace function auth.uid()
    returns uuid
    language sql
    stable
    as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid
    $$;

    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;

    -- ③ storage：schema.sql §9 往 buckets 插一行、在 objects 上建三条策略
    create schema if not exists storage;

    create table if not exists storage.buckets (
      id         text primary key,
      name       text not null,
      public     boolean not null default false,
      created_at timestamptz not null default now()
    );

    create table if not exists storage.objects (
      id         uuid primary key default gen_random_uuid(),
      bucket_id  text,
      name       text,
      owner      uuid,
      created_at timestamptz not null default now()
    );
    alter table storage.objects enable row level security;

    -- 与 storage-api 同款：剥掉最后一段（文件名），留下目录数组
    create or replace function storage.foldername(name text)
    returns text[]
    language sql
    immutable
    as $$
      select (string_to_array(name, '/'))[1:greatest(coalesce(array_length(string_to_array(name, '/'), 1), 1) - 1, 0)]
    $$;

    grant usage on schema storage to anon, authenticated;
    grant select on storage.buckets to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    `

    /* ============================================================
       灌 schema.sql
       ============================================================ */

    const RAW_SCHEMA = readFileSync(SCHEMA_FILE, 'utf8')

    /** 第 16 段的起点。A 库 = 砍掉它 = 「删旧策略之前」的样子。 */
    function splitBeforeStage5(text) {
      const at = text.indexOf('--  16. 收口')
      if (at < 0) throw new Error('schema.sql 里找不到「16. 收口」这一节的标题 —— A/B 对照没法做了')
      const bar = text.lastIndexOf('-- ============', at)
      if (bar < 0) throw new Error('找不到第 16 段上面那条分隔线')
      return text.slice(0, bar)
    }

    /** PGlite 跑不了 `alter publication` 时，把 §8 那一小段摘掉（其余原样） */
    function stripRealtime(text) {
      const re = /do \$\$\nbegin\n  begin\n    alter publication supabase_realtime[\s\S]*?end \$\$;/
      if (!re.test(text)) throw new Error('要摘 §8 的 realtime 段，但锚点没找到 —— 请检查 schema.sql 第 8 段')
      return text.replace(re, '-- （PGlite 不支持 publication：这一段由 scripts/rls-checks.mjs 在内存里摘除）')
    }

    /**
     * 负向对照：把一条策略**故意改坏**。
     * 改的全是**内存里的 SQL 文本**，`supabase/schema.sql` 一个字节都不动。
     * 锚点找不到就抛错（说明策略被重写了，这条负向对照要跟着更新 —— 不能静默变成"其实没改坏"）。
     *
     * ⚠️ `mode === 'direct-revert'` 是**手工负向对照**用的（把 §17 的收紧改回去），
     *    它形如 `direct-revert:crack-a` / `direct-revert:crack-b`，可以叠在 `RLS_NEGATIVE` 上：
     *    此时 A 库（= 删旧策略之前的那份）**只受 direct-revert 影响、不受 RLS_NEGATIVE 注入影响** ——
     *    否则"把收紧改回去"这件事会同时落到 A 库上，把 tenth section 的"两边可见量相等"搅浑。
     */
    function applyNegative(text, mode, { abOnly = false } = {}) {
      if (!mode) return text
      // A 库（砍掉第 16 段的那份）**永不注入**：它的职责是"删旧策略之前的样子"，
      // 混进任何注入都会让第十节的对照失去意义。
      if (abOnly && !mode.startsWith('direct-revert:')) return text

      if (mode === 'classroom-write') {
        // 红线：教室里那台机器拿到了 assignments 的写权限（学生碰得到它）
        return (
          text +
          `
    -- ⚠️ 负向对照注入：给教室端一个 assignments 的 INSERT（设计红线，正常情况下绝不能有）
    drop policy if exists rls_negative_control on assignments;
    create policy rls_negative_control on assignments for insert to authenticated
      with check (class_id in (select class_id from classroom_accounts where id = auth.uid() and not disabled));
    `
        )
      }
      if (mode === 'head-teacher-write') {
        // 正是 §16.2 警告过的那件事：把 head_teacher 加回 can_grade
        const re = /or teaches_subject_for\(p_uid, p_class_id, p_subject_code, p_subject\);/
        if (!re.test(text)) throw new Error('负向对照锚点没找到：can_grade_subject_for 的函数体变了')
        return text.replace(
          re,
          `or teaches_subject_for(p_uid, p_class_id, p_subject_code, p_subject)\n    or has_role_for(p_uid, 'head_teacher');`,
        )
      }
      if (mode === 'classes-insert') {
        // I26：拿掉 upsert「冲突转更新」那条口子
        const re = /or owns_class\(id\)\s+-- 既有行再存一次/
        if (!re.test(text)) throw new Error('负向对照锚点没找到：classes_insert 里的 owns_class(id) 那一支变了')
        return text.replace(re, 'or false                      -- 负向对照：拿掉 owns_class')
      }
      /*
       * 手工负向对照（`RLS_NEGATIVE=direct-revert:crack-a` 这种）：把 §17 的收紧改回去。
       * 与下面的 `crack-a` 模式**同一套锚点**，只是名字不同、好认。
       */
      if (mode.startsWith('direct-revert:')) {
        return applyNegative(text, mode.slice('direct-revert:'.length), { abOnly })
      }
      if (mode === 'crack-a') {
        /*
         * 裂缝 A 的负向对照：把 teachers 上那三条 restrictive 策略里的守卫拿掉
         * （`not is_classroom_account()` → `true`）= 策略恒真 = **不存在**，
         * 正是"收紧之前"的样子。其余 SQL 一个字不动。
         *
         * ⚠️ 只在 teachers 那三条里改（用策略名切片定位），别全局 replace ——
         * 那会把裂缝 B 的守卫也一起改掉，两条断言一起红，看不出是哪一条在起作用。
         */
        let out = text
        for (const p of ['teachers_not_classroom_insert', 'teachers_not_classroom_update', 'teachers_not_classroom_delete']) {
          const seg = new RegExp(`(create policy ${p}[\\s\\S]*?;\\n)`)
          const m = out.match(seg)
          if (!m) throw new Error(`负向对照锚点没找到：${p} 这条策略不见了（模式 crack-a）`)
          const stripped = m[1].replace(/not is_classroom_account\(\)/g, 'true')
          if (stripped === m[1]) throw new Error(`负向对照锚点没找到：${p} 里的守卫不见了（模式 crack-a）`)
          out = out.replace(seg, stripped)
        }
        return out
      }
      if (mode === 'crack-b') {
        /*
         * 裂缝 B 的负向对照：`schedule_mine_write` 正文里的守卫删掉，
         * 那条 restrictive 策略改成恒真（= 不存在）。等价于"把这次收紧改回去"。
         */
        let out = text
        const re1 = /(create policy schedule_mine_write[\s\S]*?;\n)/
        const m1 = out.match(re1)
        if (!m1) throw new Error('负向对照锚点没找到：schedule_mine_write 的形状变了（模式 crack-b）')
        const s1 = m1[1].replace(/and not is_classroom_account\(\)/g, '')
        if (s1 === m1[1]) throw new Error('负向对照锚点没找到：schedule_mine_write 里的守卫不见了（模式 crack-b）')
        out = out.replace(re1, s1)
        const re2 = /(create policy schedule_classroom_scope_only[\s\S]*?;\n)/
        const m2 = out.match(re2)
        if (!m2) throw new Error('负向对照锚点没找到：schedule_classroom_scope_only 不见了（模式 crack-b）')
        out = out.replace(re2, m2[1].replace(/not is_classroom_account\(\) or scope = 'class'/g, 'true'))
        return out
      }
      if (mode === 'crack-c') {
        /*
         * 裂缝 C 的负向对照：把 `shared_files` 上那三条 restrictive 策略里的守卫拿掉
         * （`not is_classroom_account()` → `true` = 策略恒真 = **不存在**），
         * 正是"2026-09-27 收紧之前"的样子。其余 SQL 一个字不动。
         * ⚠️ 只在 shared_files 那三条里改（按策略名切片），别全局 replace ——
         *    那会把裂缝 A / B 的守卫一起改掉，三条断言一起红，看不出是哪一条在起作用。
         */
        let out = text
        for (const p of ['shared_files_not_classroom_insert', 'shared_files_not_classroom_update', 'shared_files_not_classroom_delete']) {
          const seg = new RegExp(`(create policy ${p}[\\s\\S]*?;\\n)`)
          const m = out.match(seg)
          if (!m) throw new Error(`负向对照锚点没找到：${p} 这条策略不见了（模式 crack-c）`)
          const stripped = m[1].replace(/not is_classroom_account\(\)/g, 'true')
          if (stripped === m[1]) throw new Error(`负向对照锚点没找到：${p} 里的守卫不见了（模式 crack-c）`)
          out = out.replace(seg, stripped)
        }
        return out
      }
      if (mode === 'exam-for-everyone') {
        /*
         * 第十三节的负向对照：把考试写判据改成**恒真** —— 等于"谁都能建 / 改别人的考试档案"
         * （考试那一行判据就是"谁能建 / 改考试档案"，它是这一段唯一守门的东西）。
         * 只换函数体的 select 一句，签名与其它 SQL 一个字不动。
         */
        const re = /(create or replace function public\.can_edit_exam_for\([\s\S]*?\nas \$\$)([\s\S]*?)(\$\$;)/
        const m = text.match(re)
        if (!m) throw new Error('负向对照锚点没找到：can_edit_exam_for 的形状变了（模式 exam-for-everyone）')
        return text.replace(re, `$1\n  select true\n$3`)
      }
      throw new Error(`不认识的 RLS_NEGATIVE=${mode}`)
    }

    const NEGATIVE = process.env.RLS_NEGATIVE ?? ''
    /*
     * 🔴 A/B 切分必须在注入之前：
     *   · **B 库**（全文）拿注入后的 SQL —— `RLS_NEGATIVE` 与手工的 `direct-revert:*` 都作用在它身上；
     *   · **A 库**（= 砍掉第 16 段 = 删旧策略之前）拿**未注入**的 SQL。
     *   否则"把收紧改回去"会同时落到 A 库上，第十节"删旧策略前后可见量相等"那条
     *   会跟着一起红/绿，读的人分不清是哪个原因（本轮手工负向对照实测踩过）。
     */
    const SCHEMA_RAW_SPLIT = splitBeforeStage5(RAW_SCHEMA)
    const SCHEMA_FULL = applyNegative(RAW_SCHEMA, NEGATIVE)
    const SCHEMA_BEFORE_STAGE5 = applyNegative(SCHEMA_RAW_SPLIT, NEGATIVE, { abOnly: true })

    /** 建一个库：替身 → create publication → schema.sql 原文 → 固定数据 */
    async function makeDb(schemaText) {
      const db = new PGlite({ extensions: { pgcrypto } })
      await db.waitReady
      await db.exec(STUBS)

      let text = schemaText
      let realtime = 'ok'
      try {
        await db.exec('create publication supabase_realtime')
      } catch {
        realtime = 'unsupported'
        text = stripRealtime(text)
      }

      await db.exec(text)
      await db.exec(seedSql())
      return { db, realtime }
    }

    /* ---------------- 固定数据 ---------------- */

    function seedSql() {
      const school = '(select id from schools order by created_at limit 1)'
      const grade = (n) => `(select id from grades where name = '${n}')`
      return `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${U.super}', 'super@shugao.test', '{"name":"最高管理员","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.admin}', 'admin@shugao.test', '{"name":"教导处","subject":"化学","subject_code":"chemistry"}'::jsonb),
      ('${U.grade}', 'grade@shugao.test', '{"name":"高二年级主任","subject":"数学","subject_code":"math"}'::jsonb),
      ('${U.head}',  'head@shugao.test',  '{"name":"高二(1)班班主任","subject":"英语","subject_code":"english"}'::jsonb),
      ('${U.phy}',   'phy@shugao.test',   '{"name":"物理老师","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.chn}',   'chn@shugao.test',   '{"name":"语文老师","subject":"语文","subject_code":"chinese"}'::jsonb),
      ('${U.fresh}', 'fresh@shugao.test', '{"name":"新来的老师","subject":"历史","subject_code":"history"}'::jsonb),
      ('${U.room}',  'room1@shugao.test', '{"name":"高二(1)班教室"}'::jsonb);

    -- c5 是「班主任刚建、还没挂年级」的班（grade_id 为空）——
    -- §16.3.0 那条「建完就消失」的回归就靠它。
    -- ⚠️ 2026-09-27 起前端 saveClass 会**尽力**带上 grade_id（按班里的年级文本
    --    去 grades 表换 id），但"换不出来"的路仍然存在（年级文本不在表里 / 老库还没跑
    --    第 10 段 / 同名多条歧义 → 一律留空，见 remote.ts 的 ensureGradeLookup）——
    --    所以这个空 grade_id 的样本**不是过时的夹具**，"自己建的"那一支照旧不能省。
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id) values
      ('${C.c1}', '${U.head}',  '高二(1)班', '高二', '2025', ${school}, ${grade('高二')}),
      ('${C.c2}', '${U.phy}',   '高二(4)班', '高二', '2025', ${school}, ${grade('高二')}),
      ('${C.c3}', '${U.admin}', '高三(1)班', '高三', '2024', ${school}, ${grade('高三')}),
      ('${C.c4}', '${U.fresh}', '高一(1)班', '高一', '2026', ${school}, ${grade('高一')}),
      ('${C.c5}', '${U.head}',  '高一(2)班', '高一', '2026', ${school}, null);

    insert into students (id, class_id, student_no, name) values
      ('${S.s1}', '${C.c1}', '1', '甲'), ('${S.s2}', '${C.c1}', '2', '乙'), ('${S.s3}', '${C.c1}', '3', '丙'),
      ('${S.s4}', '${C.c2}', '1', '丁'), ('${S.s5}', '${C.c2}', '2', '戊'),
      ('${S.s6}', '${C.c3}', '1', '己'),
      ('${S.s7}', '${C.c4}', '1', '庚'),
      ('${S.s8}', '${C.c5}', '1', '辛');

    -- 任课关系：物理老师教两个班的物理；语文老师教 1 班语文
    insert into class_subjects (id, class_id, subject, subject_code, teacher_id) values
      ('${CS.x1}', '${C.c1}', '物理', 'physics', '${U.phy}'),
      ('${CS.x2}', '${C.c2}', '物理', 'physics', '${U.phy}'),
      ('${CS.x3}', '${C.c1}', '语文', 'chinese', '${U.chn}');

    -- 身份：四档管理身份；任课老师**不写 teacher_roles**（§10.6 的口径）
    insert into teacher_roles (id, teacher_id, role, scope_type, scope_id) values
      ('${ROLE.r1}', '${U.super}', 'super',        'school', ${school}),
      ('${ROLE.r2}', '${U.admin}', 'admin',        'school', ${school}),
      ('${ROLE.r3}', '${U.grade}', 'grade_head',   'grade',  ${grade('高二')}),
      ('${ROLE.r4}', '${U.head}',  'head_teacher', 'class',  '${C.c1}');

    -- 作业档案：注意 a4 —— 语文老师建的**物理**档案（"自己建的永远看得见"那条纪律的活样本）
    insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count) values
      ('${E.a1}', '${C.c1}', '${U.phy}',   '1班物理练习1', '物理', 'physics', '2026-09-20', 10),
      ('${E.a2}', '${C.c2}', '${U.phy}',   '4班物理练习1', '物理', 'physics', '2026-09-20', 10),
      ('${E.a3}', '${C.c1}', '${U.chn}',   '1班语文练习1', '语文', 'chinese', '2026-09-21', 10),
      ('${E.a4}', '${C.c1}', '${U.chn}',   '1班物理练习0', '物理', 'physics', '2026-09-19', 10),
      ('${E.a5}', '${C.c3}', '${U.admin}', '3班物理练习1', '物理', 'physics', '2026-09-22', 10),
      ('${E.a6}', '${C.c4}', '${U.fresh}', '1班物理练习1', '物理', 'physics', '2026-09-22', 10);

    insert into calls (id, teacher_id, assignment_id, class_id, text) values
      ('${CALL.c1}', '${U.phy}', '${E.a1}', '${C.c1}', '请甲同学到办公室'),
      ('${CALL.c2}', '${U.phy}', '${E.a2}', '${C.c2}', '请丁同学到办公室');

    insert into classrooms (id, teacher_id, class_id, name) values
      ('${DEV.d1}', '${U.head}', '${C.c1}', '高二(1)班教室'),
      ('${DEV.d2}', '${U.phy}',  '${C.c2}', '高二(4)班教室');

    insert into classroom_accounts (id, class_id, name, email, created_by) values
      ('${ACCT.a1}', '${C.c1}', '高二(1)班教室', 'room1@shugao.test', '${U.head}');

    insert into schedule_items (id, teacher_id, weekday, start_time, end_time, title, class_id, scope) values
      ('${SCH.s1}', '${U.phy}',  1, '08:00', '08:40', '高二(1)班 物理', '${C.c1}', 'mine'),
      ('${SCH.s2}', '${U.head}', 1, '08:50', '09:30', '高二(1)班 语文', '${C.c1}', 'class'),
      ('${SCH.s3}', '${U.phy}',  1, '10:50', '11:30', '高二(4)班 物理', '${C.c2}', 'class');

    -- 文件互传（§9）：裂缝 C 的夹具。f1 是老师真传的一份；f2 挂在教室端账号名下
    -- （真实教室端没有上传入口 —— 它是夹具，用来钉"收紧写不许把读一起挡掉"）。
    insert into shared_files (id, teacher_id, class_id, name, mime, size, storage_path) values
      ('${F.f1}', '${U.phy}',  '${C.c1}', '老师传的题图.png', 'image/png', 1024, '${U.phy}/aa-题图.png'),
      ('${F.f2}', '${U.room}', '${C.c1}', '夹具-教室端名下那一行.png', 'image/png', 2048, '${U.room}/bb-夹具.png');

    -- 考试档案（第十三节）：四份，把"读得宽 / 写得窄"的每一面都摆出来
    --   e1 物理老师建的**单班**物理（c1）        → 他自己可写；班主任/年级主任只读；教室端读得到
    --   e2 物理老师建的**多班**物理（c1 + c2）   → 钉"多班数组"这条语义（两班他都教）
    --   e3 语文老师建的单班语文（c1）            → 物理老师**写不了**（不是他建的、也不是他那一科）
    --   e4 教导处建的高三化学（c3）              → 教室端**看不见**（不是他的班）
    insert into exams (id, teacher_id, title, paper_key, subject, subject_code, scope, grade, source, mode, exam_date, question_count, class_ids, absent_nos) values
      ('${EX.e1}', '${U.phy}',   '高二(1)班物理练习8', '物理练习8', '物理', 'physics',  'class', '高二', 'manual', 'scores', '2026-09-20', 15, array['${C.c1}']::uuid[], '{}'),
      ('${EX.e2}', '${U.phy}',   '高二物理练习8',     '物理练习8', '物理', 'physics',  'grade', '高二', 'manual', 'scores', '2026-09-20', 15, array['${C.c1}','${C.c2}']::uuid[], '{}'),
      ('${EX.e3}', '${U.chn}',   '高二(1)班语文练习8', '语文练习8', '语文', 'chinese',  'class', '高二', 'manual', 'scores', '2026-09-21', 10, array['${C.c1}']::uuid[], '{}'),
      ('${EX.e4}', '${U.admin}', '高三(1)班化学练习8', '化学练习8', '化学', 'chemistry','class', '高三', 'manual', 'scores', '2026-09-22', 10, array['${C.c3}']::uuid[], '{}');

    insert into exam_scores (id, exam_id, class_id, student_no, name, graded, total) values
      ('${EXS.s1}', '${EX.e1}', '${C.c1}', '1', '甲', true, 88),
      ('${EXS.s2}', '${EX.e1}', '${C.c1}', '2', '乙', false, null);
    `
    }

    /* ============================================================
       以某个身份跑 SQL
       ------------------------------------------------------------
       `set local role authenticated` + 会话变量里的假 uid；
       **整段包在事务里、结束一律 rollback** —— 写操作测试不会污染后面的可见量断言。
       ============================================================ */

    const claimsOf = (uid) => JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' })
    const shortErr = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 110)

    async function asUser(db, uid, fn) {
      await db.exec('begin')
      try {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [claimsOf(uid)])
        await db.exec('set local role authenticated')
        return await fn()
      } finally {
        await db.exec('rollback')
      }
    }

    async function countAs(db, uid, sql, params = []) {
      return asUser(db, uid, async () => Number((await db.query(sql, params)).rows[0].n))
    }

    async function idsAs(db, uid, sql, params = []) {
      return asUser(db, uid, async () => (await db.query(sql, params)).rows.map((r) => r.id))
    }

    /**
     * 一次写尝试。三种结果（与 §16.4 的词汇一致）：
     *   ok      —— 真的改到了行
     *   blocked —— 没报错，但 0 行（被策略的 using 静默筛掉）
     *   denied  —— 报错（INSERT 的 with check 不满足 / 连表级权限都没给）
     */
    async function attempt(db, uid, sql, params = []) {
      return asUser(db, uid, async () => {
        try {
          const r = await db.query(sql, params)
          const affected = Number(r.affectedRows ?? r.rows.length)
          return { outcome: affected > 0 ? 'ok' : 'blocked', affected, detail: `${affected} 行` }
        } catch (e) {
          const m = shortErr(e)
          const kind = /row-level security/.test(m) ? '策略拒绝' : /permission denied/.test(m) ? '表权限拒绝' : '出错'
          return { outcome: 'denied', affected: 0, detail: `${kind}：${m}` }
        }
      })
    }

    /** 断言"被拒"：denied 或 blocked 都算 —— 关键是**一行都没改到** */
    function denied(name, res) {
      ok(`${name} → 被拒（${res.outcome}）`, res.outcome === 'denied' || res.outcome === 'blocked', res.detail)
    }
    function allowed(name, res) {
      ok(`${name} → 通过`, res.outcome === 'ok', res.detail)
    }

    /* ---------------- 写载荷：形状来自 remote.ts 的 *ToRow ---------------- */

    const NOW = Date.UTC(2026, 8, 27, 4, 0, 0)

    const localKlass = (o) => ({ id: o.id, name: o.name, grade: o.grade ?? '高二', year: o.year ?? '2025', createdAt: NOW, students: [] })
    const localStudent = (o) => ({ id: o.id, studentNo: o.studentNo, name: o.name ?? '新同学', status: 'active', createdAt: NOW })
    const localAssignment = (o) => ({
      id: o.id,
      title: o.title ?? '新作业',
      classId: o.classId,
      subject: o.subject ?? '物理',
      subjectCode: o.subjectCode ?? 'physics',
      assignDate: '2026-09-27',
      questionCount: 10,
      status: 'open',
      createdAt: NOW,
      collected: false,
      missingNos: [],
      lateNos: [],
      subQuestions: {},
      questionMeta: {},
      wrong: {},
      confirmedNos: [],
      statsMode: 'normal',
      grades: {},
      focusNos: [],
      correctionNos: [],
      correctedNos: [],
    })
    const localCall = (o) => ({
      id: o.id,
      assignmentId: o.assignmentId,
      classId: o.classId,
      studentNos: [],
      text: o.text ?? '请到办公室',
      room: '',
      sentAt: [NOW],
      states: {},
    })
    const localClassroom = (o) => ({ id: o.id, classId: o.classId, name: o.name ?? '教室一体机', online: true, lastSeenAt: NOW })
    const localSchedule = (o) => ({
      id: o.id,
      weekday: 1,
      start: '09:40',
      end: '10:20',
      title: o.title ?? '班级课表',
      classId: o.classId,
      room: '',
      kind: 'class',
      notify: true,
      scope: o.scope ?? 'class',
    })

    /**
     * 考试档案的落库载荷 —— 形状来自 `remote.ts` 的 `examToRow`（Node 原生 import 真文件，
     * 不是手抄列名）。第十三节的写断言全走它，所以"前端改了列名"这里会一起红。
     */
    const localExam = (o) => ({
      id: o.id,
      title: o.title ?? '高二物理练习9',
      paperKey: o.paperKey ?? '物理练习9',
      subject: o.subject ?? '物理',
      subjectCode: o.subjectCode ?? 'physics',
      scope: o.scope ?? 'class',
      grade: '高二',
      source: 'manual',
      mode: 'scores',
      examDate: '2026-09-27',
      questionCount: 15,
      questions: {},
      classIds: o.classIds ?? [],
      absentNos: [],
      status: 'grading',
      gradedAt: null,
      note: '',
    })

    /**
     * 作业档案的落库载荷 —— 与 `remote.ts` 的 `assignmentWriteRow` 同一条口径：
     * 认得出学科就把 `subject_code` 带上（这里库是全文 schema，那一列在）。
     */
    const assignmentRow = (a, uid) => ({ ...M.assignmentToRow(a, uid), ...(a.subjectCode ? { subject_code: a.subjectCode } : {}) })

    /** 列类型显式声明：jsonb / 数组参数不显式转型会在赋值时报类型不符 */
    const CAST = {
      missing_nos: '::text[]', late_nos: '::text[]', confirmed_nos: '::text[]', focus_nos: '::text[]',
      correction_nos: '::text[]', corrected_nos: '::text[]', student_nos: '::text[]', sent_at: '::timestamptz[]',
      class_ids: '::uuid[]', absent_nos: '::text[]',
      wrong: '::jsonb', sub_questions: '::jsonb', question_meta: '::jsonb', grades: '::jsonb', states: '::jsonb',
      questions: '::jsonb', scores: '::jsonb', answers: '::jsonb',
    }

    function placeholders(row) {
      const cols = Object.keys(row)
      const values = []
      const holders = cols.map((c) => {
        const v = row[c]
        values.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v)
        return `$${values.length}${CAST[c] ?? ''}`
      })
      return { cols, holders, values }
    }

    /** 纯插入（PostgREST 的 insert 路径） */
    function insertSql(table, row) {
      const { cols, holders, values } = placeholders(row)
      return { sql: `insert into ${table} (${cols.join(', ')}) values (${holders.join(', ')}) returning id`, values }
    }

    /** 前端真实的保存路径：upsert（PostgREST 的 insert ... on conflict (id) do update） */
    function upsertSql(table, row) {
      const { cols, holders, values } = placeholders(row)
      const sets = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`)
      return {
        sql: `insert into ${table} (${cols.join(', ')}) values (${holders.join(', ')}) on conflict (id) do update set ${sets.join(', ')} returning id`,
        values,
      }
    }

    const write = (db, uid, q) => attempt(db, uid, q.sql, q.values)

    /* ---------------- 可见量快照 ---------------- */

    const SNAPSHOT_SQL = `
    select
      (select count(*) from classes)::int                                              as classes,
      (select count(*) from students)::int                                             as students,
      (select count(*) from assignments)::int                                          as assignments,
      (select count(*) from calls)::int                                                as calls,
      (select count(*) from schedule_items where coalesce(scope,'mine') = 'mine')::int  as schedule_mine,
      (select count(*) from schedule_items where scope = 'class')::int                  as schedule_class,
      (select count(*) from classrooms)::int                                           as classrooms,
      (select count(*) from class_subjects)::int                                       as class_subjects,
      (select count(*) from classroom_accounts)::int                                   as classroom_accounts,
      (select count(*) from teachers)::int                                             as teachers,
      (select count(*) from teacher_roles)::int                                        as teacher_roles
    `
    const snapshot = (db, uid) =>
      asUser(db, uid, async () => {
        const r = (await db.query(SNAPSHOT_SQL)).rows[0]
        return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]))
      })

    /* ============================================================
       开跑
       ============================================================ */

    console.log('树高教师平台 · 权限体系回归（PGlite = WASM 版真 PostgreSQL 17）')
    console.log(`schema 原文：${SCHEMA_FILE}`)
    console.log('载荷形状来自：app/src/data/remote.ts 的 *ToRow（Node 原生 import 真文件）')
    if (NEGATIVE) {
      console.log(`\n🔴🔴 负向对照已开启：RLS_NEGATIVE=${NEGATIVE} —— 脚本**应该**变红。`)
      console.log('     （改的是内存里的 SQL 文本；仓库文件没有被改动。）')
    }

    const B = await makeDb(SCHEMA_FULL)
    const A = await makeDb(SCHEMA_BEFORE_STAGE5)
    const db = B.db

    /* ============================================================
       一、装载与替身
       ============================================================ */

    section('一、把 schema.sql 原文灌进去 + Supabase 最小替身')
    {
      eq('schema.sql 全文执行成功（PGlite 上没有一句 SQL 报错）', true, true)
      ok(
        B.realtime === 'ok'
          ? 'supabase_realtime publication：已建，§8 原文照跑'
          : 'supabase_realtime：PGlite 不支持 create publication，§8 那一小段由脚本在内存里摘除（其余原样）',
        true,
      )

      const gen = await db.query(`select gen_random_uuid() as id`)
      ok('gen_random_uuid() 可用（§0 的 pgcrypto 已装载）', /^[0-9a-f-]{36}$/.test(gen.rows[0].id))

      const seen = await asUser(db, U.phy, async () => (await db.query('select auth.uid() as uid')).rows[0].uid)
      eq('auth.uid() 桩读到会话里的假 uid（"登录成谁"就这一条路）', seen, U.phy)

      const bypass = await db.query(`select rolsuper, rolbypassrls from pg_roles where rolname = 'authenticated'`)
      eq('authenticated 不是超级用户、也不能绕过 RLS', [bypass.rows[0].rolsuper, bypass.rows[0].rolbypassrls], [false, false])

      const noRls = await db.query(
        `select tablename from pg_tables where schemaname = 'public' and rowsecurity = false order by tablename`,
      )
      eq('§14 自检：public 下没有一张表漏开 RLS', noRls.rows.map((r) => r.tablename), [])

      const backfill = await db.query(`select (select count(*) from schools) as s, (select count(*) from grades) as g`)
      eq('§10.2 回填：1 所学校 / 3 个年级', [Number(backfill.rows[0].s), Number(backfill.rows[0].g)], [1, 3])

      const codes = await db.query(`select id, primary_subject_code from teachers where id in ($1, $2)`, [U.phy, U.chn])
      const byId = Object.fromEntries(codes.rows.map((r) => [r.id, r.primary_subject_code]))
      eq('建号带学科：触发器件 §13.1 把 subject_code 写进 primary_subject_code', [byId[U.phy], byId[U.chn]], ['physics', 'chinese'])

      ok('载荷形状来自真的 remote.ts（*ToRow 是函数，不是手抄的列名表）', typeof M.assignmentToRow === 'function' && typeof M.classToRow === 'function')
    }

    /* ============================================================
       二、判据函数（§13.2 / §16.2）—— 策略里只准调它们
       ============================================================ */

    section('二、判据函数（§13.2 拆身份 / §16.2 管得着这个班）')
    {
      const f = (uid, expr) => asUser(db, uid, async () => Boolean((await db.query(`select ${expr} as v`)).rows[0].v))

      eq('is_super_admin()：超管 true', await f(U.super, 'is_super_admin()'), true)
      eq('is_super_admin()：教导处 false（**两种身份、判据分开**，I17）', await f(U.admin, 'is_super_admin()'), false)
      eq('is_school_admin()：超管 / 教导处都 true', [await f(U.super, 'is_school_admin()'), await f(U.admin, 'is_school_admin()')], [true, true])
      eq('is_school_admin()：任课老师 false', await f(U.phy, 'is_school_admin()'), false)
      eq(
        'can_manage_teachers()：超管 / 教导处 true（建号与指派身份同档，§16.8）',
        [await f(U.super, 'can_manage_teachers()'), await f(U.admin, 'can_manage_teachers()')],
        [true, true],
      )
      eq('can_manage_teachers()：任课老师 false', await f(U.phy, 'can_manage_teachers()'), false)
      eq('has_role(grade_head)：年级主任 true / 班主任 false', [await f(U.grade, `has_role('grade_head')`), await f(U.head, `has_role('grade_head')`)], [true, false])

      const manage = (uid, cid) => f(uid, `can_manage_class('${cid}')`)
      eq('can_manage_class：年级主任管得着本年级的班', await manage(U.grade, C.c1), true)
      eq('can_manage_class：年级主任管不着别的年级', await manage(U.grade, C.c3), false)
      eq('can_manage_class：班主任管得着本班', await manage(U.head, C.c1), true)
      eq('can_manage_class：班主任管不着同年级别的班', await manage(U.head, C.c2), false)
      eq('can_manage_class：**任课老师不算**（故意不含他）', await manage(U.phy, C.c1), false)

      const grade = (uid, cid, code, name) => f(uid, `can_grade_subject('${cid}', '${code}', '${name}')`)
      eq('can_grade_subject：物理老师改得了 1 班物理', await grade(U.phy, C.c1, 'physics', '物理'), true)
      eq('can_grade_subject：物理老师改不了同班语文', await grade(U.phy, C.c1, 'chinese', '语文'), false)
      eq('can_grade_subject：物理老师改不了别的班物理', await grade(U.phy, C.c3, 'physics', '物理'), false)
      eq('can_grade_subject：**班主任改不了本班成绩**（只读，I27 的核心）', await grade(U.head, C.c1, 'physics', '物理'), false)
      eq('can_grade_subject：年级主任改不了本年级成绩（只读）', await grade(U.grade, C.c1, 'physics', '物理'), false)
      eq(
        'can_grade_subject：超管 / 教导处兜底 true',
        [await grade(U.super, C.c3, 'physics', '物理'), await grade(U.admin, C.c3, 'chinese', '语文')],
        [true, true],
      )
      eq('can_grade_subject：教室端 false（改成绩的门都摸不到）', await grade(U.room, C.c1, 'physics', '物理'), false)

      eq('teaches_in_class：物理老师在本班任教', await f(U.phy, `teaches_in_class('${C.c1}')`), true)
      eq('teaches_in_class：语文老师不在 4 班任教', await f(U.chn, `teaches_in_class('${C.c2}')`), false)
      eq(
        'owns_class：班主任建的 1 班 true / 不是他建的 4 班 false',
        [await f(U.head, `owns_class('${C.c1}')`), await f(U.head, `owns_class('${C.c2}')`)],
        [true, false],
      )

      // 兼容期口径（§12.4 / §13.3）：老列按显示名精确比对；**认不出来 = 不匹配，不猜**
      const legacy = await db.query(`
        select
          teaches_subject_for('${U.chn}', '${C.c1}', null, '语文')          as legacy_name,
          teaches_subject_for('${U.chn}', '${C.c1}', null, '高中语文')       as unknown_name,
          teaches_subject_for('${U.chn}', '${C.c1}', 'physics', '语文')      as code_first
      `)
      eq(
        '兼容期：老行按显示名能匹配、字典外的写法不匹配（不猜，I14）、code 优先',
        [legacy.rows[0].legacy_name, legacy.rows[0].unknown_name, legacy.rows[0].code_first],
        [true, false, false],
      )
    }

    /* ============================================================
       三、逐人可见量（文档 §16.4 ① 那张「该看见」的表）
       ============================================================ */

    section('三、逐人可见量（8 个身份 × 11 张表）')
    {
      const rows = []
      for (const who of ORDER) {
        const got = await snapshot(db, U[who])
        eq(`${WHO[who]}：可见量`, got, EXPECTED[who])
        rows.push([who, got])
      }

      const cols = Object.keys(EXPECTED.super)
      const w = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0)))
      const cw = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map(([, g]) => String(g[c]).length)) + 2]))
      console.log('\n  ┌ 逐人可见行数（B 库 = schema.sql 全文）')
      console.log(`  │ ${w('身份', 32)}${cols.map((c) => w(c, cw[c])).join('')}`)
      for (const [who, got] of rows) console.log(`  │ ${w(WHO[who], 32)}${cols.map((c) => w(got[c], cw[c])).join('')}`)
      console.log('  └')
    }

    /* ============================================================
       四、学科教师：只见自己任教班 + 自己那科
       ============================================================ */

    section('四、学科教师（只看自己那科，写也只写自己那科）')
    {
      const visIds = (uid, table = 'assignments') => idsAs(db, uid, `select id from ${table} order by id`)
      const sorted = (a) => [...a].sort()

      eq('物理老师看得见的作业 = {1班物理, 4班物理, 语文老师建的那份物理}', await visIds(U.phy), sorted([E.a1, E.a2, E.a4]))
      eq('物理老师**看不见**同班语文（学科收窄生效）', (await visIds(U.phy)).includes(E.a3), false)
      eq('物理老师看不见别年级的作业', (await visIds(U.phy)).includes(E.a5), false)
      eq('物理老师看不见无身份老师的班', (await visIds(U.phy)).includes(E.a6), false)

      const base = { classId: C.c1, subject: '物理', subjectCode: 'physics', title: '1班物理练习2' }
      let r = await write(db, U.phy, insertSql('assignments', assignmentRow(localAssignment({ ...base, id: mk('e0', 90) }), U.phy)))
      allowed('物理老师建本班本科的档案', r)

      r = await write(db, U.phy, insertSql('assignments', assignmentRow(localAssignment({ ...base, id: mk('e0', 91), subject: '语文', subjectCode: 'chinese' }), U.phy)))
      denied('物理老师建**别科**档案（1 班语文）', r)

      r = await write(db, U.phy, insertSql('assignments', assignmentRow(localAssignment({ ...base, id: mk('e0', 92), classId: C.c3 }), U.phy)))
      denied('物理老师建**别班**档案（高三 1 班）', r)

      r = await write(db, U.phy, { sql: `update assignments set wrong = '{"1":["3"]}'::jsonb where id = $1 returning id`, values: [E.a1] })
      allowed('物理老师批改本班本科（UPDATE 走 can_grade_subject）', r)

      r = await write(db, U.phy, { sql: `update assignments set wrong = '{"1":["3"]}'::jsonb where id = $1 returning id`, values: [E.a3] })
      denied('物理老师改**别科**（1 班语文）', r)

      r = await write(db, U.phy, { sql: `update assignments set wrong = '{}'::jsonb where id = $1 returning id`, values: [E.a5] })
      denied('物理老师改**别班**（高三 1 班）', r)

      // 「自己建的永远看得见」（§16.3.0 / I25）—— 语文老师建的那份物理档案
      eq('自己建的永远看得见：语文老师看得见自己建的那份**物理**档案', (await visIds(U.chn)).includes(E.a4), true)
      eq('语文老师看得见的作业 = {1班语文, 自己建的物理}', await visIds(U.chn), sorted([E.a3, E.a4]))
      r = await write(db, U.chn, { sql: `update assignments set wrong = '{}'::jsonb where id = $1 returning id`, values: [E.a4] })
      denied('"自己建的"不等于"改得动"：语文老师改不了那份物理档案的成绩', r)
      r = await write(db, U.chn, { sql: `delete from assignments where id = $1 returning id`, values: [E.a4] })
      allowed('自己建的删得掉（任课关系撤了也不留孤儿档案）', r)
    }

    /* ============================================================
       五、班主任 / 年级主任：看得宽、**改不了成绩**
       ============================================================ */

    section('五、班主任 / 年级主任（一个班 / 一个年级的全科，但只读）')
    {
      const visIds = (uid) => idsAs(db, uid, 'select id from assignments order by id')
      const sorted = (a) => [...a].sort()

      eq('班主任看得见本班**全科**（物理 + 语文 + 别人建的物理）', await visIds(U.head), sorted([E.a1, E.a3, E.a4]))
      eq('班主任看不见同年级别的班', (await visIds(U.head)).includes(E.a2), false)
      eq('年级主任看得见本年级全科（1 班 + 4 班）', await visIds(U.grade), sorted([E.a1, E.a2, E.a3, E.a4]))
      eq('年级主任看不见别的年级', (await visIds(U.grade)).includes(E.a5), false)

      let r = await write(db, U.head, { sql: `update assignments set wrong = '{"1":["3"]}'::jsonb where id = $1 returning id`, values: [E.a1] })
      denied('🔴 班主任改本班物理成绩', r)
      r = await write(db, U.head, { sql: `update assignments set confirmed_nos = ARRAY['1'] where id = $1 returning id`, values: [E.a3] })
      denied('🔴 班主任改本班语文成绩', r)
      r = await write(db, U.grade, { sql: `update assignments set wrong = '{}'::jsonb where id = $1 returning id`, values: [E.a1] })
      denied('🔴 年级主任改本年级物理成绩', r)

      r = await write(db, U.head, insertSql('assignments', assignmentRow(localAssignment({ id: mk('e0', 93), classId: C.c1 }), U.head)))
      denied('班主任建本班作业档案（他不教这一科 —— 口径 A 的直接推论）', r)

      r = await write(db, U.head, { sql: `delete from assignments where id = $1 returning id`, values: [E.a1] })
      allowed('删档案另有一套：班主任删得掉本班别人的档案（用户口径）', r)

      r = await write(db, U.head, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 90), studentNo: '90' }), C.c1)))
      allowed('班主任加学生（本班）', r)
      r = await write(db, U.head, { sql: `delete from students where id = $1 returning id`, values: [S.s1] })
      allowed('班主任删学生（本班）', r)
      r = await write(db, U.head, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 91), studentNo: '91' }), C.c2)))
      denied('班主任加学生（同年级**别的**班）', r)

      r = await write(db, U.grade, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 92), studentNo: '92' }), C.c1)))
      allowed('年级主任加学生（本年级）', r)
      r = await write(db, U.grade, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 93), studentNo: '93' }), C.c3)))
      denied('年级主任加学生（别的年级）', r)

      r = await write(db, U.phy, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 94), studentNo: '94' }), C.c1)))
      denied('任课老师**不能**加学生（用户口径②：加删学生归管理身份）', r)

      r = await write(db, U.head, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 90), classId: C.c1 }), U.head)))
      allowed('班主任改本班班级课表', r)
      r = await write(db, U.phy, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 91), classId: C.c1 }), U.phy)))
      denied('任课老师改班级课表（班级课表归管理身份）', r)
      r = await write(db, U.phy, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 92), classId: C.c1, scope: 'mine' }), U.phy)))
      allowed('任课老师写**自己的**排课表（scope=mine，个人数据）', r)
    }

    /* ============================================================
       六、教导处 / 最高管理员：全校 + 改任何班成绩（兜底）
       ============================================================ */

    section('六、教导处 / 最高管理员（全校可见 + 改成绩兜底）')
    {
      let r = await write(db, U.super, { sql: `update assignments set wrong = '{"1":["2"]}'::jsonb where id = $1 returning id`, values: [E.a1] })
      allowed('超管改别的班别的科的成绩（兜底）', r)
      r = await write(db, U.admin, { sql: `update assignments set wrong = '{"1":["2"]}'::jsonb where id = $1 returning id`, values: [E.a5] })
      allowed('教导处改任何班任何科的成绩（全校兜底）', r)

      r = await write(db, U.admin, insertSql('assignments', assignmentRow(localAssignment({ id: mk('e0', 94), classId: C.c3, subject: '语文', subjectCode: 'chinese' }), U.admin)))
      allowed('教导处在高三建语文档案（兜底支）', r)

      r = await write(db, U.head, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 90), name: '高二(9)班' }), U.head)))
      allowed('班主任建班（用户口径①）', r)
      r = await write(db, U.grade, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 91), name: '高二(8)班' }), U.grade)))
      allowed('年级主任建班', r)
      r = await write(db, U.admin, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 95), name: '高三(9)班' }), U.admin)))
      allowed('教导处建班', r)
      r = await write(db, U.phy, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 92), name: '高二(7)班' }), U.phy)))
      denied('任课老师建班', r)
    }

    /* ============================================================
       七、教室端：只有自己班 + 11 条写操作全拒 + 两条有限写
       ============================================================ */

    section('七、教室端（学生碰得到那台机器 —— 全项目的安全边界）')
    {
      const visIds = (table) => idsAs(db, U.room, `select id from ${table} order by id`)

      eq('教室端只看得见本班这一个班', await visIds('classes'), [C.c1])
      eq('教室端看不见别班的学生', await visIds('students'), [S.s1, S.s2, S.s3].sort())
      eq(
        '🔴 I20：教室端看得见本班**全科**作业（少了这一支，大屏的逐题正确率会整片变空且不报错）',
        await visIds('assignments'),
        [E.a1, E.a3, E.a4].sort(),
      )
      eq('教室端看不见别班的呼叫', await visIds('calls'), [CALL.c1])

      // ---- 11 条写操作：一条都不许过 ----
      const writeOps = [
        ['① 建作业档案', insertSql('assignments', assignmentRow(localAssignment({ id: mk('e0', 95), classId: C.c1 }), U.room))],
        ['② 改成绩（批改）', { sql: `update assignments set wrong = '{"1":["3"]}'::jsonb where id = $1 returning id`, values: [E.a1] }],
        ['③ 删作业档案', { sql: `delete from assignments where id = $1 returning id`, values: [E.a1] }],
        ['④ 加学生', insertSql('students', M.studentToRow(localStudent({ id: mk('50', 95), studentNo: '95' }), C.c1))],
        ['⑤ 发呼叫', insertSql('calls', M.callToRow(localCall({ id: mk('ca', 90), assignmentId: E.a1, classId: C.c1 }), U.room))],
        ['⑥ 改班级', { sql: `update classes set name = '被改了' where id = $1 returning id`, values: [C.c1] }],
        ['⑦ 改**别班**课表', upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 93), classId: C.c2 }), U.room))],
        ['⑧ 改教师行（**别人**那一行）', { sql: `update teachers set name = '被改了' where id = $1 returning id`, values: [U.head] }],
        ['⑨ 插身份行', { sql: `insert into teacher_roles (teacher_id, role, scope_type) values ($1, 'super', 'school') returning id`, values: [U.room] }],
        ['⑩ 插任课关系', { sql: `insert into class_subjects (class_id, subject, teacher_id) values ($1, '物理', $2) returning id`, values: [C.c1, U.room] }],
        ['⑪ 删教室端账号行', { sql: `delete from classroom_accounts where id = $1 returning id`, values: [ACCT.a1] }],
      ]
      for (const [name, q] of writeOps) denied(`教室端 ${name}`, await write(db, U.room, q))

      /*
       * ---- 🔴 裂缝 A（2026-09-25 已收紧）：教室端**不许**改 teachers 里自己那一行 ----
       *
       * 根因是两件事叠在一起：① `teachers_self`（§7）是 `for all`、条件是 `id = auth.uid()`；
       * ② `handle_new_user` 触发器**给每个 auth 用户都建了一行 teachers** —— 教室端账号也有。
       * 收紧在 `schema.sql` §17.1（`teachers_self` 重写成 select/insert/update 三条，
       * 写的那两条带 `and not is_classroom_account()`）。
       *
       * ⚠️ 这两条原来只是 `note()`（记录、不判失败）——**这就是"红不了"的那种断言**：
       *    裂缝真的回来时，报告里多一行字，退出码照样 0。现在它们必须让脚本变红。
       */
      const selfRow = await write(db, U.room, { sql: `update teachers set name = '教室端把自己这行改名了' where id = $1 returning id`, values: [U.room] })
      denied('🔴 教室端改 **teachers 里自己那一行**（裂缝 A：那块屏是给学生看的，零写权限）', selfRow)

      const selfUpsert = await write(db, U.room, upsertSql('teachers', { id: U.room, name: '教室端自己改名（upsert）', subject: '物理' }))
      denied('🔴 教室端用**前端真实载荷**（upsert teachers 自己那行）改自己 —— upsert 这条路也堵上了', selfUpsert)

      const otherRow = await write(db, U.room, { sql: `update teachers set name = '被改了' where id = $1 returning id`, values: [U.chn] })
      denied('教室端改不了**别人**那一行 teachers（安全上要紧的是这一半）', otherRow)

      // 反向对照：**真正的教师**必须照旧能改自己那一行（别为了收裂缝 A 把老师一起挡了）。
      // 这就是 `is_classroom_account()` 里"教室端有没有自己那一行"这个判据的意义：
      // 老师不在 classroom_accounts 里 → 恒为假 → 一个字都不受影响。
      const teacherSelf = await write(db, U.phy, upsertSql('teachers', { id: U.phy, name: '物理老师改了名字', subject: '物理' }))
      allowed('对照：真老师照旧能改自己那一行 teachers（收紧没有误伤教师）', teacherSelf)
      const teacherSelfUpdate = await write(db, U.phy, { sql: `update teachers set name = '物理老师又改了一次' where id = $1 returning id`, values: [U.phy] })
      allowed('对照：真老师走 UPDATE 那条路也照旧通', teacherSelfUpdate)
      const headSelf = await write(db, U.head, upsertSql('teachers', { id: U.head, name: '班主任改了名字', subject: '英语' }))
      allowed('对照：班主任（有身份的人）也照旧能改自己那一行', headSelf)

      // ---- 两条有限写：必须仍然有效 ----
      // 真实路径：Classroom.tsx 心跳 → store.setClassroomOnline → saveClassroom(c, 当前登录者的 id)
      // （`store.ts` 里 tid = get().teacher?.id，教室端就是教室端账号自己）
      let r = await write(db, U.room, upsertSql('classrooms', M.classroomToRow(localClassroom({ id: DEV.d1, classId: C.c1 }), U.room)))
      allowed('教室端心跳（upsert classrooms 设备行）', r)

      // 心跳这条 upsert 顺带把设备行的**建档人**改写成教室端账号自己（载荷里的 teacher_id
      // 就是当前登录者）。这不是本轮引入的，但它是 W4 那串问题的同一个根：
      // 设备行的归属跟着"最后一次写它的人"走。
      const ownerAfter = await asUser(db, U.room, async () => {
        const q = upsertSql('classrooms', M.classroomToRow(localClassroom({ id: DEV.d1, classId: C.c1 }), U.room))
        await db.query(q.sql, q.values)
        return (await db.query(`select teacher_id from classrooms where id = $1`, [DEV.d1])).rows[0].teacher_id
      })
      eq('心跳之后设备行的 teacher_id = 教室端账号（建档人被改写，见 §九 W4 的同一条根）', ownerAfter, U.room)
      r = await write(db, U.room, upsertSql('classrooms', M.classroomToRow(localClassroom({ id: DEV.d1, classId: C.c1 }), U.head)))
      denied('拿**别人**的 teacher_id 去 upsert 设备行（心跳载荷只带当前登录者，否则 INSERT 的 with check 会拦下它）', r)

      r = await write(db, U.room, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 94), classId: C.c1 }), U.room)))
      allowed('教室端粘贴**本班**班级课表（scope=class）', r)
      r = await write(db, U.room, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 95), classId: C.c2 }), U.room)))
      denied('教室端粘贴**别班**课表', r)

      /*
       * ---- 🔴 裂缝 B（2026-09-25 已收紧）：教室端**不许**写自己名下 scope='mine' 的行 ----
       *
       * `schedule_mine_write`（§16.3）只要求 `teacher_id = auth.uid()`，而教室端账号也是
       * auth.uid() → 它能在策略上给自己塞一行 `scope='mine'` 的排课表。前端走不到这条路
       * （`Classroom.tsx` 的粘贴课表恒写 `scope:'class'`），所以影响面≈0 ——
       * 但"教室端只有两处有限写"这句话在策略清单上不成立，而策略清单是这项目的安全边界说明书。
       * 收紧：§16.3 的策略正文加了 `and not is_classroom_account()`，§17.2 另有
       * 一条 restrictive 策略把边界声明出来（AND，不放宽任何东西）。
       */
      r = await write(db, U.room, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 96), classId: C.c1, scope: 'mine' }), U.room)))
      denied("🔴 教室端写**自己名下** scope='mine' 的排课表行", r)

      r = await write(db, U.room, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 98), classId: C.c1, scope: 'mine' }), U.head)))
      denied('教室端写 scope=mine 但**建档人是别人**的课表行', r)

      // 反向对照：**真正的教师**写自己的排课表必须照旧通（§五 已经在下面验过一次，
      // 这里再在"裂缝 B 的现场"钉一次：同一个 scope='mine' 的载荷，换个身份就通）。
      r = await write(db, U.phy, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 99), classId: C.c1, scope: 'mine' }), U.phy)))
      allowed("对照：真老师写**自己名下** scope='mine' 的排课表照旧通", r)
      r = await write(db, U.head, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 89), classId: C.c1, scope: 'mine' }), U.head)))
      allowed("对照：班主任写自己名下 scope='mine' 的排课表照旧通", r)

      /*
       * ---- 🔴 裂缝 C（2026-09-27 已收紧）：教室端**不许**往 `shared_files` 写 ----
       *
       * 根因与 A / B 同一个（触发器给每个 auth 用户建了一行 teachers + 策略只认 auth.uid()）：
       * `shared_files_own`（§9）是 `for all ... using (teacher_id = auth.uid())`，
       * 而 `Files.tsx` 上传时 `teacher_id` 就是当前登录者 —— 所以教室端也能"上传"。
       * 收紧在 `schema.sql` **§17.6**：三条逐动作 restrictive（insert / update / delete）
       * + `not is_classroom_account()`，`shared_files_own` 的**正文一个字没动**。
       *
       * ⚠️ **读的那一半不许被误伤**（这一段最要紧的一条）：教室那块屏要读这个表
       *    （`Classroom.tsx` → `listFiles()`，老师传过去的题图就靠它拉下来）。
       *    restrictive 的 `using` 对 SELECT 也生效 —— 当初裂缝 A 写成一条 `for all`
       *    就把教室端"读自己那行 teachers"挡掉了（第三节可见量 teachers 1 → 0）。
       *    所以下面除了"写被拒"，还有一条**读照旧**的反向对照（用 `f2` 那行夹具量）。
       */
      const fileRow = (o) => ({
        id: o.id,
        teacher_id: o.teacherId,
        class_id: o.classId ?? null,
        name: o.name ?? '题图.png',
        mime: 'image/png',
        size: 1234,
        storage_path: `${o.teacherId}/cc-${o.name ?? '题图.png'}`,
      })

      r = await write(db, U.room, insertSql('shared_files', fileRow({ id: F.f3, teacherId: U.room, classId: C.c1, name: '教室端自己传的.png' })))
      denied('🔴 教室端往 shared_files **插**一行（裂缝 C：前端真实上传载荷，teacher_id = 它自己）', r)

      r = await write(db, U.room, { sql: `update shared_files set name = '被教室端改名了' where id = $1 returning id`, values: [F.f2] })
      denied('🔴 教室端**改** shared_files 里自己名下那一行', r)

      r = await write(db, U.room, { sql: `delete from shared_files where id = $1 returning id`, values: [F.f2] })
      denied('🔴 教室端**删** shared_files 里自己名下那一行', r)

      // 反向对照一：**真正的教师**三条路（插 / 改 / 删）必须照旧通 —— 收裂缝不许误伤老师
      // ⚠️ 删的那一条要删**种子里的**那一行：每次 attempt 都在自己的事务里跑完就 rollback，
      //    所以"上一条刚插进去的行"到下一条已经不存在了（那样量到的是 0 行 = 假失败）。
      r = await write(db, U.phy, insertSql('shared_files', fileRow({ id: F.f4, teacherId: U.phy, classId: C.c1, name: '老师新传的答案.pdf' })))
      allowed('对照：真老师照旧能**上传**（插自己名下那一行 shared_files）', r)
      r = await write(db, U.phy, { sql: `update shared_files set name = '题图（改过名）.png' where id = $1 returning id`, values: [F.f1] })
      allowed('对照：真老师照旧能**改**自己传的那一行', r)
      r = await write(db, U.phy, { sql: `delete from shared_files where id = $1 returning id`, values: [F.f1] })
      allowed('对照：真老师照旧能**删**自己传的那一行', r)

      // 反向对照二：**读**那一半没被误伤（这就是"写成一条 for all"会挡掉的东西）
      // ⚠️ 这里刻意只断言"**读得到自己那一行**"，**不**钉总行数：今天教室端读不到
      //    老师上传的行（`shared_files_own` 只给"自己传的"），那是 §9 的老形状、
      //    本轮没动它（发现记在 `功能设计与不变量.md` §十七·补 的补.4）。
      //    钉成精确清单的话，将来谁把那条读补宽（让教室端看得见本班的文件）都会撞红
      //    —— 而那不是"收紧把读弄坏了"，是修另一件事。
      const roomFiles = await idsAs(db, U.room, `select id from shared_files order by id`)
      ok(
        '🔴 裂缝 C 的**读**那一半没被误伤：教室端照旧读得到自己名下那一行 shared_files（restrictive 里没有 SELECT）',
        roomFiles.includes(F.f2),
        `读到 ${JSON.stringify(roomFiles)}（期望含 ${F.f2}；今天它读不到老师上传的那行 —— §9 老形状，本轮没动读）`,
      )
      eq(
        '对照：物理老师照旧读得到自己传的文件那一行',
        await idsAs(db, U.phy, `select id from shared_files order by id`),
        [F.f1],
      )

      // ---- 静态审计：设计红线在策略清单上也要看得见 ----
      const pol = await db.query(
        `select policyname, cmd, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename = 'assignments' order by cmd, policyname`,
      )
      eq('assignments 上只有逐动作策略（select/insert/update/delete），**没有一条 for all**', pol.rows.map((x) => x.cmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      ok(
        '🔴 assignments 的任何一条策略里**都不出现** classroom_accounts（教室端绝无写权限）',
        pol.rows.every((x) => !/classroom_accounts/.test(x.body)),
        pol.rows.filter((x) => /classroom_accounts/.test(x.body)).map((x) => x.policyname).join(','),
      )

      /*
       * ---- 静态审计：两条裂缝在**策略清单**上必须看得出来 ----
       * 上面那些是"真打一遍"；这两条钉的是"下一个读策略清单的人不会再犯一遍"。
       * 判据不收窄成某个函数名（`is_classroom_account` 改名不该让这里变红），
       * 只要求"教室里那块屏"这个身份在策略正文里被提到。
       */
      const tPol = await db.query(
        `select policyname, cmd, permissive, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename = 'teachers' order by cmd, policyname`,
      )
      eq(
        '裂缝 A：teachers 上的策略清单（§7 的 for all + §17.1 三条逐动作 restrictive）',
        tPol.rows.map((x) => `${x.policyname}:${x.cmd}:${x.permissive}`),
        [
          'teachers_self:ALL:PERMISSIVE',
          'teachers_not_classroom_delete:DELETE:RESTRICTIVE',
          'teachers_not_classroom_insert:INSERT:RESTRICTIVE',
          'teachers_not_classroom_update:UPDATE:RESTRICTIVE',
        ],
      )
      /*
       * 🔴 这一条是"清单上看得出来"，所以判据是**函数名里那个词**（classroom_account），
       * 而不是 `classroom_accounts` —— `is_classroom_account()` 的**函数体**在渲染出来的
       * 策略正文里是看不到的（只有调用），拿表名去 grep 会恒假（本轮踩过一次）。
       */
      const tGuard = tPol.rows.filter((x) => x.permissive === 'RESTRICTIVE')
      ok(
        '🔴 裂缝 A：teachers 上有三条逐动作 restrictive 策略（insert/update/delete），且都调教室端判据',
        tGuard.length === 3 && tGuard.every((x) => /classroom_account/.test(x.body)),
        tGuard.map((x) => `${x.policyname}:${/classroom_account/.test(x.body) ? '有' : '没有'}`).join(' · ') || '(没有 restrictive 策略)',
      )
      eq(
        '🔴 裂缝 A 的**读**那一半没被误伤：restrictive 里没有 SELECT（写成 for all 会把教室端读自己那行也挡掉）',
        tGuard.filter((x) => x.cmd === 'SELECT').length,
        0,
      )
      const sPol = await db.query(
        `select policyname, cmd, permissive, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename = 'schedule_items' order by policyname`,
      )
      eq(
        '裂缝 B：schedule_items 上的策略清单（读两路 + 写三路 + 一条教室端边界）',
        sPol.rows.map((x) => `${x.policyname}:${x.cmd}${x.permissive === 'RESTRICTIVE' ? ':RESTRICTIVE' : ''}`),
        [
          'schedule_class_visible:SELECT',
          'schedule_class_write:ALL',
          'schedule_classroom_scope_only:ALL:RESTRICTIVE',
          'schedule_classroom_write:ALL',
          'schedule_mine_read:SELECT',
          'schedule_mine_write:ALL',
        ],
      )
      ok(
        '🔴 裂缝 B：schedule_mine_write 的正文里也提到教室端（清单上不能长得像"谁都能写自己的排课表"）',
        sPol.rows.filter((x) => x.policyname === 'schedule_mine_write').every((x) => /classroom_account/.test(x.body)),
        sPol.rows.filter((x) => x.policyname === 'schedule_mine_write').map((x) => shortErr(x.body)).join(' · '),
      )

      /*
       * ---- 静态审计：裂缝 C 在**策略清单**上也必须看得出来 ----
       * ⚠️ 这里刻意**不钉** `shared_files_own` 的正文（它一个字没动，见 §17.6 的理由：
       *    它一条 `for all` 同时给着 SELECT，改正文会把教室端的读一起改掉）。
       *    所以"清单上看得出来"这件事由三条**名字里带 not_classroom** 的 restrictive 承担。
       */
      const fPol = await db.query(
        `select policyname, cmd, permissive, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename = 'shared_files' order by cmd, policyname`,
      )
      eq(
        '裂缝 C：shared_files 上的策略清单（§9 的 for all + §17.6 三条逐动作 restrictive）',
        fPol.rows.map((x) => `${x.policyname}:${x.cmd}:${x.permissive}`),
        [
          'shared_files_own:ALL:PERMISSIVE',
          'shared_files_not_classroom_delete:DELETE:RESTRICTIVE',
          'shared_files_not_classroom_insert:INSERT:RESTRICTIVE',
          'shared_files_not_classroom_update:UPDATE:RESTRICTIVE',
        ],
      )
      const fGuard = fPol.rows.filter((x) => x.permissive === 'RESTRICTIVE')
      ok(
        '🔴 裂缝 C：三条逐动作 restrictive（insert/update/delete）都调教室端判据',
        fGuard.length === 3 && fGuard.every((x) => /classroom_account/.test(x.body)),
        fGuard.map((x) => `${x.policyname}:${/classroom_account/.test(x.body) ? '有' : '没有'}`).join(' · ') || '(没有 restrictive 策略)',
      )
      eq(
        '🔴 裂缝 C 的**读**那一半没被误伤：restrictive 里没有 SELECT（写成 for all 会把教室端读文件列表也挡掉）',
        fGuard.filter((x) => x.cmd === 'SELECT').length,
        0,
      )
    }

    /* ============================================================
       八、无身份的新老师：只有自己建的
       ============================================================ */

    section('八、无身份的新老师（没有角色、没有任课关系）')
    {
      const visIds = (table) => idsAs(db, U.fresh, `select id from ${table} order by id`)

      eq('只看得见自己建的班', await visIds('classes'), [C.c4])
      eq('只看得见自己班的名单', await visIds('students'), [S.s7])
      eq('只看得见自己建的作业', await visIds('assignments'), [E.a6])
      eq('什么都看不见：呼叫', await visIds('calls'), [])
      eq('什么都看不见：教室端设备', await visIds('classrooms'), [])

      let r = await write(db, U.fresh, insertSql('assignments', assignmentRow(localAssignment({ id: mk('e0', 96), classId: C.c4 }), U.fresh)))
      denied('新老师建作业（**没有任课关系就建不了** —— 口径 A 的直接推论）', r)
      r = await write(db, U.fresh, insertSql('students', M.studentToRow(localStudent({ id: mk('50', 96), studentNo: '96' }), C.c4)))
      denied('新老师给自己班加学生（加删学生归管理身份）', r)
      r = await write(db, U.fresh, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 93), name: '高一(9)班' }), U.fresh)))
      denied('新老师建班（他没有任何管理身份）', r)
      r = await write(db, U.fresh, upsertSql('schedule_items', M.scheduleToRow(localSchedule({ id: mk('5c', 97), classId: C.c4, scope: 'mine' }), U.fresh)))
      allowed('新老师写自己的排课表（scope=mine，谁都能录自己的课）', r)
      r = await write(db, U.fresh, { sql: `update classes set name = '自己建的班改个名' where id = $1 returning id`, values: [C.c4] })
      allowed('新老师改自己建的班（upsert 那条路不能误伤）', r)
    }

    /* ============================================================
       九、upsert：冲突转更新**也要过 INSERT 的 with check**（I26）
       ------------------------------------------------------------
       这是上一轮真 PG 实测出来、并决定了 classes_insert 为什么留 `owns_class(id)` 一支的那条。
       负向对照 RLS_NEGATIVE=classes-insert 专门拿它开刀。
       ============================================================ */

    section('九、upsert：冲突转更新也要过 INSERT 的 with check（I26）')
    {
      // 物理老师既不是 super/admin，也不是年级主任/班主任 —— 他只满足 UPDATE 策略。
      // 他能改名自己建的 4 班，唯一靠的就是 classes_insert 里 `owns_class(id)` 那一支。
      let r = await write(db, U.phy, upsertSql('classes', M.classToRow(localKlass({ id: C.c2, name: '高二(4)班（改过名）' }), U.phy)))
      allowed('🔴 任课老师 upsert 自己建的班（靠 classes_insert 的 owns_class(id) 一支放行）', r)

      r = await write(db, U.head, upsertSql('classes', M.classToRow(localKlass({ id: C.c1, name: '高二(1)班（改过名）' }), U.head)))
      allowed('班主任 upsert 自己建的班（他是 head_teacher，两条支路都成立）', r)

      r = await write(db, U.phy, upsertSql('classes', M.classToRow(localKlass({ id: mk('c0', 94), name: '高二(6)班' }), U.phy)))
      denied('**真新建**（id 不存在）仍然只有那四档身份能过 —— upsert 没把"建"放宽', r)

      r = await write(db, U.chn, upsertSql('classes', M.classToRow(localKlass({ id: C.c2, name: '高二(4)班（别人改的）' }), U.chn)))
      denied('不是他建的、也管不着的班：upsert 一样被拒（证明上一条不是"upsert 恒过"）', r)

      r = await write(db, U.phy, upsertSql('assignments', assignmentRow(localAssignment({ id: E.a1, classId: C.c1 }), U.phy)))
      allowed('真实保存路径：物理老师 upsert 自己的作业档案（批改落库走的就是它）', r)

      r = await write(db, U.room, upsertSql('classrooms', M.classroomToRow(localClassroom({ id: DEV.d1, classId: C.c1 }), U.room)))
      allowed('真实保存路径：教室端 upsert 设备行（心跳）', r)
    }

    /* ============================================================
       十、删旧策略前后：逐人可见量必须**完全相等**（§16.4 ①）
       ============================================================ */

    section('十、删旧策略前后对照（A = 去掉第 16 段 / B = 全文）')
    {
      const OLD = ['classes_own', 'students_own', 'assignments_own', 'calls_own', 'schedule_own', 'classrooms_own']
      const oldOf = (target) =>
        target.db
          .query(`select policyname from pg_policies where schemaname='public' and policyname = any($1) order by policyname`, [OLD])
          .then((r) => r.rows.map((x) => x.policyname))
      eq('A 库（删之前）：六条旧 `for all` 策略都还在', await oldOf(A), [...OLD].sort())
      eq('B 库（收口后）：六条旧策略已删', await oldOf(B), [])

      let same = true
      const diff = []
      for (const who of ORDER) {
        const a = await snapshot(A.db, U[who])
        const b = await snapshot(B.db, U[who])
        const equal = JSON.stringify(a) === JSON.stringify(b)
        if (!equal) {
          same = false
          diff.push(`${WHO[who]}：A=${JSON.stringify(a)} B=${JSON.stringify(b)}`)
        }
        ok(`① ${WHO[who]}：删旧策略前后可见量相等`, equal, equal ? '' : diff.at(-1))
      }
      ok('① 汇总：8 个身份 × 11 张表，删旧策略一行都没让人少看见', same, diff.join(' | '))

      // 「自己建的永远看得见」在 B 库上单独再钉一次（I25）。
      // 上面的"两边相等"还不够：两边可能**一起错**（A 靠旧策略、B 靠 16.3.0 补的那几支）。
      const pins = await db.query(`
        select
          (select count(*) from pg_policies where schemaname='public' and policyname='classes_visible'     and qual ~ 'uid\\(\\)')::int
        + (select count(*) from pg_policies where schemaname='public' and policyname='students_visible'    and qual ~ 'owns_class')::int
        + (select count(*) from pg_policies where schemaname='public' and policyname='calls_visible'       and qual ~ 'uid\\(\\)')::int
        + (select count(*) from pg_policies where schemaname='public' and policyname='classrooms_visible'  and qual ~ 'uid\\(\\)')::int
        + (select count(*) from pg_policies where schemaname='public' and policyname='assignments_visible' and qual ~ 'uid\\(\\)')::int
          as n`)
      eq('I25：B 库里"自己建的"读分支五张表都在（classes/students/assignments/calls/classrooms）', Number(pins.rows[0].n), 5)

      eq('I25 的活样本：班主任刚建、还没挂年级的班（grade_id 为空）他自己看得见', await idsAs(db, U.head, `select id from classes where id = $1`, [C.c5]), [C.c5])
      eq('同一个班，年级主任看不见（grade_id 为空 → 按年级收敛判不到）—— 所以"自己建的"那一支不能省', await idsAs(db, U.grade, `select id from classes where id = $1`, [C.c5]), [])
      eq('同一批数据在 A 库上也是同一个结论（不是 B 库特有的）', await idsAs(A.db, U.head, `select id from classes where id = $1`, [C.c5]), [C.c5])
      /*
       * `grade_id` 的写入判据在 `remote.ts` 的 `ensureGradeLookup()`（这是纯前端逻辑，
       * PGlite 这一层验不了"前端有没有送这一列"）。这里只钉**数据库侧的后果**：
       * 空 `grade_id` = 年级主任管不着这个班，所以前端必须尽力把它填上。
       */
    }

    /* ============================================================
       十一、策略清单审计（§16.6 ③）
       ============================================================ */

    section('十一、策略清单审计（哪些表有哪些动作）')
    {
      const per = (table) =>
        db
          .query(`select cmd, policyname, (with_check is not null) as has_check from pg_policies where schemaname='public' and tablename=$1 order by cmd, policyname`, [table])
          .then((r) => r.rows)

      for (const table of ['classes', 'students', 'assignments', 'calls', 'classrooms']) {
        const rows = await per(table)
        eq(`${table}：四个动作逐条成策略（没有 for all）`, [...new Set(rows.map((r) => r.cmd))].sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      }
      const sch = await per('schedule_items')
      eq(
        'schedule_items：读两路（自己的 + 班级的）+ 写三路（自己 / 班级 / 教室端）+ §17.2 的教室端边界',
        sch.map((r) => r.policyname).sort(),
        ['schedule_class_visible', 'schedule_class_write', 'schedule_classroom_scope_only', 'schedule_classroom_write', 'schedule_mine_read', 'schedule_mine_write'],
      )

      const upd = await db.query(`select count(*)::int as n from pg_policies where schemaname='public' and cmd='UPDATE' and with_check is null`)
      eq('I28：所有 UPDATE 策略都写了 with check（using 与 with check 同款）', Number(upd.rows[0].n), 0)
      const ins = await db.query(`select count(*)::int as n from pg_policies where schemaname='public' and cmd='INSERT' and with_check is null`)
      eq('所有 INSERT 策略都有 with check（没有"只写 using"的）', Number(ins.rows[0].n), 0)

      const readonly = await db.query(
        `select tablename, cmd from pg_policies where schemaname='public'
           and tablename in ('teacher_roles','class_subjects','classroom_accounts','subjects','schools','grades')
           and cmd <> 'SELECT' order by tablename`,
      )
      eq('身份 / 任课关系 / 教室端账号 / 字典：数据库层**一条写策略都没有**（写只走服务端）', readonly.rows, [])

      const grants = await db.query(`
        select table_name, privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_schema = 'public'
           and table_name in ('teacher_roles','class_subjects','classroom_accounts')
           and privilege_type <> 'SELECT' order by table_name, privilege_type`)
      eq('而且这几张表连 INSERT/UPDATE/DELETE 的 grant 都没有（客户端连门都摸不到）', grants.rows, [])
    }

    /* ============================================================
       十二、存储策略（教师端 → 教室端 的文件互传）
       ============================================================ */

    section('十二、storage：只能读写自己目录下的文件（§9）')
    {
      const mine = await write(db, U.phy, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.phy}/aa-题图.png`] })
      allowed('往自己目录里传文件', mine)
      const other = await write(db, U.phy, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.chn}/aa-别人的.png`] })
      denied('往**别人**目录里传文件', other)
      const readOther = await countAs(db, U.phy, `select count(*)::int as n from storage.objects where name like $1`, [`${U.chn}/%`])
      eq('读不到别人目录里的文件', readOther, 0)
    }

    /* ============================================================
       十三、考试档案的写判据（`can_edit_exam_for`，schema.sql §15.2 / §18）
       ------------------------------------------------------------
       为什么单开一节：在这一节之前，**考试那条写判据一条断言都没有**。
       原因是它没有 `_for` 变体 —— 裸版 `can_edit_exam(...)` 读 `auth.uid()`，
       而"以某个人的身份问一句"这件事在没有登录态的地方（SQL 编辑器 / 本脚本的
       直接调用）都做不到：编辑器里 `auth.uid()` 是 NULL，判据对**任何人**都返回 false，
       看起来像"权限收得很紧"，其实是**什么都没验**（schema.sql §18.1 把这条写成了约定）。
       2026-09-27 补上 `can_edit_exam_for(uid, class_ids[], code, name)` 之后才有这一节。
       负向对照：`RLS_NEGATIVE=exam-for-everyone`（把判据改成恒真）必须让本节变红。
       ============================================================ */

    section('十三、考试档案的写判据（谁能建 / 改 exams，§15.2 / §18）')
    {
      const canEdit = (uid, classIds, code, name) =>
        db
          .query(`select can_edit_exam_for($1, $2::uuid[], $3, $4) as v`, [uid, classIds, code, name])
          .then((r) => Boolean(r.rows[0].v))
      /** 裸版（读 auth.uid()）：只能"以某人的身份"问 —— 这正是编辑器里做不到的那件事 */
      const canEditAs = (uid, classIds, code, name) =>
        asUser(db, uid, async () => Boolean((await db.query(`select can_edit_exam($1::uuid[], $2, $3) as v`, [classIds, code, name])).rows[0].v))

      // ---- ① 学科教师：自己教的班 + 自己那一科 ----
      eq('can_edit_exam_for：物理老师 + 1 班 + 物理 → true', await canEdit(U.phy, [C.c1], 'physics', '物理'), true)
      eq('can_edit_exam_for：物理老师 + **同一个班**但别科（1 班语文）→ false', await canEdit(U.phy, [C.c1], 'chinese', '语文'), false)
      eq('can_edit_exam_for：物理老师 + **别班**（高三 1 班）→ false', await canEdit(U.phy, [C.c3], 'physics', '物理'), false)
      eq('can_edit_exam_for：物理老师 + 4 班（他教的第二个班）→ true', await canEdit(U.phy, [C.c2], 'physics', '物理'), true)
      eq(
        'can_edit_exam_for：语文老师反过来（1 班语文 true / 1 班物理 false）',
        [await canEdit(U.chn, [C.c1], 'chinese', '语文'), await canEdit(U.chn, [C.c1], 'physics', '物理')],
        [true, false],
      )

      // ---- ② 兜底：super / admin（用户 2026-09-27 拍板保留）----
      eq(
        'can_edit_exam_for：超管 / 教导处 → true（兜底，两个人都保留）',
        [await canEdit(U.super, [C.c3], 'physics', '物理'), await canEdit(U.admin, [C.c3], 'chinese', '语文')],
        [true, true],
      )

      // ---- ③ 班主任 / 年级主任：读得宽、**写不了别人的班**（I27 同族）----
      eq('can_edit_exam_for：班主任 + 本班物理 → false（他不教这一科，只读）', await canEdit(U.head, [C.c1], 'physics', '物理'), false)
      eq('can_edit_exam_for：年级主任 + 本年级物理 → false（只读）', await canEdit(U.grade, [C.c1], 'physics', '物理'), false)

      // ---- ④ 教室端 / 无身份 ----
      eq('🔴 can_edit_exam_for：教室端 → false（那块屏在 exams 上一条写策略都没有）', await canEdit(U.room, [C.c1], 'physics', '物理'), false)
      eq('can_edit_exam_for：无身份的新老师 → false', await canEdit(U.fresh, [C.c4], 'physics', '物理'), false)

      // ---- ⑤ 兼容期口径（与 §13.3 的 teaches_subject_for 同一套：认不出来不猜）----
      eq('兼容期：code 认不出时按显示名反查字典（null, 物理）→ true', await canEdit(U.phy, [C.c1], null, '物理'), true)
      eq('兼容期：字典外的写法（null, 高中物理）→ false（不猜）', await canEdit(U.phy, [C.c1], null, '高中物理'), false)

      /*
       * ---- ⑥ 🔴 多班数组的语义：**any**（钉死，改它的人必须先看见这条）----
       *
       * `can_edit_exam_for(uid, [我教的班, 我不教的班], 我教的科, 科名)` = **true**。
       * 也就是说数组的语义是"**这份档案涉及哪些班**"，不是"要求我教全部这些班"。
       * 依据（schema.sql §15.2 的"为什么任一班就够"）：班级考试只有一个班；
       * 年级考试是多人协作 —— 别的班的分数由那个班的任课老师自己录。
       * 真值来自函数体里的 `cs.class_id = any (p_class_ids)` + EXISTS（存在一行即真）。
       */
      eq(
        '🔴 多班数组 = any：[我教的班, 我不教的班] → true（不是"每班都要我教"）',
        await canEdit(U.phy, [C.c1, C.c3], 'physics', '物理'),
        true,
      )
      eq(
        '多班数组：**全是不教的班** → false（any 不等于恒真）',
        await canEdit(U.phy, [C.c3, C.c4], 'physics', '物理'),
        false,
      )
      eq(
        '多班数组：空数组 / NULL → 任课老师 false；super 仍然 true（兜底那一支不看班）',
        [
          await canEdit(U.phy, [], 'physics', '物理'),
          await canEdit(U.phy, null, 'physics', '物理'),
          await canEdit(U.super, [], 'physics', '物理'),
        ],
        [false, false, true],
      )

      // ---- ⑦ 裸版 = 薄包装：必须与 `_for` 判据逐字等价（签名没改，正文改成转调）----
      eq(
        '薄包装等价：物理老师走 can_edit_exam()（读 auth.uid()）与 _for(他自己) 同结论',
        [await canEditAs(U.phy, [C.c1], 'physics', '物理'), await canEditAs(U.phy, [C.c3], 'physics', '物理')],
        [true, false],
      )
      eq('薄包装等价：超管兜底那一支在裸版上也成立', await canEditAs(U.super, [C.c3], 'chinese', '语文'), true)
      eq('薄包装等价：教室端走裸版 → false', await canEditAs(U.room, [C.c1], 'physics', '物理'), false)

      /*
       * ---- ⑧ 🔴 没有登录态时裸版对**所有人**都是 false ----
       * 这一条不是在测权限，是在**钉住"为什么必须有 `_for` 变体"**：
       * 用户实测过 —— 在 Supabase SQL 编辑器里跑 `can_edit_exam(...)`，
       * 示例教师 / demo-teacher / 所有班**全是 false**，于是"示例教师能不能建高二(1)班的物理考试"
       * 这个问题当时没有答案。这里以脚本身份（无会话、auth.uid() = NULL）复现同一件事。
       */
      const editorNull = await db.query(`select can_edit_exam(array[$1]::uuid[], 'physics', '物理') as v`, [C.c1])
      eq(
        '🔴 没有登录态（auth.uid() = NULL）时 can_edit_exam() 恒 false —— 所以必须有 _for 变体（§18.1）',
        Boolean(editorNull.rows[0].v),
        false,
      )
      const stillTrue = await canEdit(U.phy, [C.c1], 'physics', '物理')
      eq('🔴 同一件事用 _for 变体问得出来（这正是补它的理由）', stillTrue, true)

      // ---- ⑨ `_for` 变体必须**全部 revoke**（§16.2 的纪律，机器审计）----
      const forFns = await db.query(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname like '%\\_for'
           and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or has_function_privilege('anon', p.oid, 'EXECUTE'))
         order by 1`)
      eq('🔴 §18.5：所有 `*_for` 判据对 authenticated / anon 都 revoke 了（一个都不能执行）', forFns.rows.map((r) => r.proname), [])
      const forCount = await db.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%\\_for'`)
      eq('`_for` 变体一共 12 个（id 变体也算判据的两件套 —— 新增判据别只写裸版）', Number(forCount.rows[0].n), 12)
      const hasBare = await db.query(`select has_function_privilege('authenticated', 'public.can_edit_exam(uuid[], text, text)', 'EXECUTE') as v`)
      eq('裸版 can_edit_exam 对 authenticated **有** EXECUTE（策略要调它）', Boolean(hasBare.rows[0].v), true)
      const hasFor = await db.query(`select has_function_privilege('authenticated', 'public.can_edit_exam_for(uuid, uuid[], text, text)', 'EXECUTE') as v`)
      eq('而 `can_edit_exam_for` **没有**（接受任意 uid = 以任意人身份问权限）', Boolean(hasFor.rows[0].v), false)

      // ---- ⑩ 真打一遍 exams 的写策略（载荷形状来自 remote.ts 的 examToRow）----
      let r = await write(db, U.phy, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 90), classIds: [C.c1] }), U.phy)))
      allowed('物理老师建本班本科的考试档案', r)

      r = await write(db, U.phy, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 91), classIds: [C.c1], subject: '语文', subjectCode: 'chinese' }), U.phy)))
      denied('物理老师建**同一个班的别科**考试档案（1 班语文）', r)

      r = await write(db, U.phy, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 92), classIds: [C.c3] }), U.phy)))
      denied('物理老师建**别班**的考试档案（高三 1 班物理）', r)

      r = await write(db, U.phy, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 93), classIds: [C.c1, C.c3] }), U.phy)))
      allowed('🔴 物理老师建**多班**考试档案（1 班 + 高三 1 班）→ 过：多班数组是 any（与 §6 同一条语义，落到了策略上）', r)

      r = await write(db, U.phy, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 94), classIds: [C.c1] }), U.head)))
      denied('拿**别人**的 teacher_id 建考试档案（with check 里 teacher_id = auth.uid()）', r)

      r = await write(db, U.phy, upsertSql('exams', M.examToRow(localExam({ id: EX.e1, classIds: [C.c1], title: '改过的标题' }), U.phy)))
      allowed('物理老师改**自己建的**考试档案（改标题/换班都走这条路）', r)

      r = await write(db, U.phy, { sql: `update exams set title = '被别人改了' where id = $1 returning id`, values: [EX.e3] })
      denied('🔴 物理老师改**别人建的**考试档案（语文老师那份，I25 "看得见 ≠ 改得动"）', r)

      r = await write(db, U.head, { sql: `update exams set title = '班主任改了' where id = $1 returning id`, values: [EX.e1] })
      denied('🔴 班主任改本班物理考试档案（只读 —— 与 can_grade_subject 同口径）', r)

      r = await write(db, U.grade, { sql: `update exams set title = '年级主任改了' where id = $1 returning id`, values: [EX.e1] })
      denied('🔴 年级主任改本年级物理考试档案（只读）', r)

      r = await write(db, U.head, insertSql('exams', M.examToRow(localExam({ id: mk('e1', 95), classIds: [C.c1] }), U.head)))
      denied('班主任建本班考试档案（他也不教这一科 —— 口径 A 的直接推论）', r)

      // ---- ⑪ 真打一遍 exam_scores 的写策略（写自己那份考试的分）----
      const scoreRow = (o) => M.examScoreToRow({
        id: o.id,
        examId: o.examId,
        classId: o.classId,
        studentNo: o.studentNo ?? '3',
        name: o.name ?? '丙',
        scores: {},
        answers: {},
        graded: false,
        absent: false,
        total: null,
        objective: null,
        subjective: null,
        classRank: null,
        gradeRank: null,
      })
      r = await write(db, U.phy, insertSql('exam_scores', scoreRow({ id: mk('e2', 90), examId: EX.e1, classId: C.c1 })))
      allowed('物理老师往**自己建的**考试里录分', r)

      r = await write(db, U.chn, insertSql('exam_scores', scoreRow({ id: mk('e2', 91), examId: EX.e1, classId: C.c1 })))
      denied('🔴 语文老师往**别人建的**考试里插分（§15.3 的写策略再查一次 exams.teacher_id）', r)

      r = await write(db, U.head, insertSql('exam_scores', scoreRow({ id: mk('e2', 92), examId: EX.e1, classId: C.c1 })))
      denied('班主任往本班考试里插分（只读）', r)

      r = await write(db, U.room, insertSql('exam_scores', scoreRow({ id: mk('e2', 93), examId: EX.e1, classId: C.c1 })))
      denied('🔴 教室端往考试里插分（红线：绝不给那块屏任何成绩的 UPDATE / INSERT）', r)

      r = await write(db, U.room, upsertSql('exams', M.examToRow(localExam({ id: EX.e1, classIds: [C.c1] }), U.room)))
      denied('🔴 教室端 upsert 考试档案（前端真实保存路径也被拒）', r)

      r = await write(db, U.room, { sql: `delete from exams where id = $1 returning id`, values: [EX.e1] })
      denied('🔴 教室端删考试档案', r)

      // ---- ⑫ 读：读得宽（与写无关的那一半，别顺手收紧）----
      eq('班主任**读得到**本班考试（读得宽：不看学科）', await idsAs(db, U.head, `select id from exams order by id`), [EX.e1, EX.e2, EX.e3].sort())
      eq('年级主任读得到本年级的考试（1 班 + 4 班），读不到高三', await idsAs(db, U.grade, `select id from exams order by id`), [EX.e1, EX.e2, EX.e3].sort())
      eq('无身份的新老师读不到别人的考试', await idsAs(db, U.fresh, `select id from exams order by id`), [])
      /*
       * 🔴 教室端**读得到**本班考试 —— **口径已定**（2026-09-27 用户拍板：以代码为准，可以读）。
       *    `schema.sql` §15.3 的注释是**刻意**这么写的（"教室端需要展示本次考试逐题正确率，
       *    读得到、写不了；真正的红线是绝不给它任何成绩的 UPDATE"），
       *    `功能设计与不变量.md` §14.7 现在写的是**同一句话**（那一节原来有一句
       *    "教室端连 exams 的 select 都拿不到"，与实码不符，已按拍板改成"能读本班、改不了任何数据"）。
       *    这里钉的是**实际行为**，三个方向都有：
       *      ① 读得到本班的（这一条）· ② 读不到别班的（下一条）· ③ 写一律被拒（上面 ⑩⑪）。
       *    ⚠️ 别再把它当"待拍板"：要收读的口子，得**先**改 §14.7 与 §15.3，两边一起改。
       */
      eq('教室端读得到**本班**的考试（用户 2026-09-27 拍板：可以读；§15.3 刻意如此）', await idsAs(db, U.room, `select id from exams order by id`), [EX.e1, EX.e2, EX.e3].sort())
      eq('教室端读不到**别班**的考试（高三那份）', (await idsAs(db, U.room, `select id from exams order by id`)).includes(EX.e4), false)
      eq('教室端读得到本班的分数行（逐题正确率要用）', await countAs(db, U.room, `select count(*)::int as n from exam_scores`), 2)

      // ---- ⑬ 策略清单静态审计：exams / exam_scores 上有什么 ----
      const exPol = await db.query(
        `select tablename, policyname, cmd, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename in ('exams','exam_scores')
          order by tablename, policyname`,
      )
      eq(
        'exams / exam_scores 各两条策略（visible=SELECT / write=ALL），没有第三条',
        exPol.rows.map((x) => `${x.tablename}:${x.policyname}:${x.cmd}`),
        ['exam_scores:exam_scores_visible:SELECT', 'exam_scores:exam_scores_write:ALL', 'exams:exams_visible:SELECT', 'exams:exams_write:ALL'],
      )
      ok(
        '🔴 两条写策略的正文里都提到判据（`can_edit_exam`）与建档人（`teacher_id`/`uid()`）',
        exPol.rows.filter((x) => x.cmd === 'ALL').length === 2 &&
          exPol.rows.filter((x) => x.cmd === 'ALL').every((x) => /can_edit_exam/.test(x.body) && /teacher_id|uid\(\)/.test(x.body)),
        exPol.rows.filter((x) => x.cmd === 'ALL').map((x) => `${x.policyname}:${/can_edit_exam/.test(x.body) ? '有判据' : '没判据'}`).join(' · '),
      )
      ok(
        '🔴 exams / exam_scores 的任何一条策略里都**不出现** classroom_accounts（教室端绝无写权限）',
        exPol.rows.every((x) => !/classroom_accounts/.test(x.body)),
        exPol.rows.filter((x) => /classroom_accounts/.test(x.body)).map((x) => x.policyname).join(','),
      )
    }

    /* ============================================================
       收尾
       ============================================================ */

    await B.db.close()
    await A.db.close()

    console.log(`\n${'='.repeat(64)}`)
    if (NEGATIVE) {
      console.log(`\n🔴 负向对照 RLS_NEGATIVE=${NEGATIVE}：`)
      if (failures.length) {
        console.log(`   如预期**变红**了（${failures.length} 条）—— 说明这些断言真的在测策略，不是摆设。`)
        for (const f of failures) console.log(`   · ${f}`)
        process.exitCode = 1
      } else {
        console.log('   ❌ 竟然全绿 —— 这个负向对照没被任何断言覆盖，脚本对这条策略是瞎的！')
        process.exitCode = 2
      }
    } else if (failures.length) {
      console.log(`\n❌ 失败 ${failures.length} 条 / 通过 ${pass} 条`)
      for (const f of failures) console.log(`   · ${f}`)
      process.exitCode = 1
    } else {
      console.log(`\n✅ 全过：${pass} 条断言`)
    }
}, { script: 'rls-checks.mjs' })
