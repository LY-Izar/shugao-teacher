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
 *   node scripts/rls-checks.mjs          # 全过 → 退出码 0；红一条 → 退出码 1
 *   npm run rls-checks
 *
 * 负向对照（证明它不是"永远绿的摆设"）——故意把一条策略改坏，脚本**必须变红**：
 *   $env:RLS_NEGATIVE='classroom-write'    ; node scripts/rls-checks.mjs   # 给教室端开一个 assignments 的 INSERT
 *   $env:RLS_NEGATIVE='head-teacher-write' ; node scripts/rls-checks.mjs   # 让班主任也能改成绩
 *   $env:RLS_NEGATIVE='classes-insert'     ; node scripts/rls-checks.mjs   # 拿掉 classes_insert 里的 owns_class(id)
 *   $env:RLS_NEGATIVE='crack-a'            ; node scripts/rls-checks.mjs   # 把「教室端不许改自己那行 teachers」改回去
 *   $env:RLS_NEGATIVE='crack-b'            ; node scripts/rls-checks.mjs   # 把「教室端不许写 scope=mine 排课表」改回去
 *   $env:RLS_NEGATIVE='crack-c'            ; node scripts/rls-checks.mjs   # 把「教室端不许写 shared_files」改回去
 *   $env:RLS_NEGATIVE='exam-for-everyone'  ; node scripts/rls-checks.mjs   # 让考试写判据对**所有人**为真（谁都能改别人的考试档案）
 *   $env:RLS_NEGATIVE='file-read-wider'    ; node scripts/rls-checks.mjs   # 文件的班级归属读策略改成恒真（谁都能读所有文件）
 *   $env:RLS_NEGATIVE='file-read-closed'   ; node scripts/rls-checks.mjs   # 读策略改成恒假（教室端的文件列表又变成空的）
 *   $env:RLS_NEGATIVE='file-object-wider'  ; node scripts/rls-checks.mjs   # 存储对象的读策略改成恒真（桶里任何文件都能签直链）
 *   $env:RLS_NEGATIVE='department-open'    ; node scripts/rls-checks.mjs   # 🆕 部门那一支两半判据拿掉（空部门也能发 + 年级主任也能发）
 *   $env:RLS_NEGATIVE='teacher-tier-by-roles' ; node scripts/rls-checks.mjs # 🔴「任课教师」档改回"没有身份行才算"（2026-09-26 那个漏人的形状）
 *   $env:RLS_NEGATIVE='p9-stream-write'    ; node scripts/rls-checks.mjs   # 拿掉"走班班的屏零写"那三条收窄（它能往自己班粘课表）
 *   $env:RLS_NEGATIVE='p9-call-no-manage'  ; node scripts/rls-checks.mjs   # 事务性呼叫放宽成"任教就能发"（科任老师也能叫人）
 *   $env:RLS_NEGATIVE='p10-no-audit'       ; node scripts/rls-checks.mjs   # 拿掉选科变更审计（三个人改了，谁也查不出）
 *   $env:RLS_NEGATIVE='p10-purge-no-confirm' ; node scripts/rls-checks.mjs # 拿掉旧科目数据的二次确认（不确认也能删）
 *   $env:RLS_NEGATIVE='p10-suspend-removes-members' ; node scripts/rls-checks.mjs # 让"休学也移出走班名单"（Q28 = B 明确否掉）
 *   $env:RLS_NEGATIVE='one-super-index-drop' ; node scripts/rls-checks.mjs     # 🆕 拿掉"全平台只有一个 super"那条部分唯一索引（插第二个超管必须变红）
 *   （改的全是**内存里的 SQL 文本**，仓库文件一个字节都不动。）
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
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
/* `lib/assignments.ts` 那两个纯函数（`isUnassigned` 是"未归属"的**唯一判据**，P5）： */
const ASG = await import(pathToFileURL(resolvePath(APP, 'src/lib/assignments.ts')).href)
/*
 * 🆕 2026-10-06：邮件正文体检那一个纯函数（`looksLikeStudentData`）——
 * 第十九节要验"学生档案那四个字段（家长电话 / 住址 / 民族 / 出生年月）进没进那条窄判据"。
 * 跑的是**仓库里那份真文件**，不是这里手抄一份判据。
 */
const MAILLIB = await import(pathToFileURL(resolvePath(APP, 'functions/api/_lib/mail.ts')).href)

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
      /* 🆕 2026-09-28「管理架构与角色权限」这一轮的 5 档新身份（见 `newRoleSeedSql()`） */
      prin: mk('a1', 1),
      vprin: mk('a1', 2),
      ohead: mk('a1', 3),
      moral: mk('a1', 4),
      slead: mk('a1', 5),
      llead: mk('a1', 6),
      /* 🆕 2026-10-08「超管锁死」这一轮的两个人（见 `superLockSeedSql()`） */
      super2: mk('a1', 7),
      head2: mk('a1', 8),
    }
    const C = { c1: mk('c0', 1), c2: mk('c0', 2), c3: mk('c0', 3), c4: mk('c0', 4), c5: mk('c0', 5) }
    const S = { s1: mk('50', 1), s2: mk('50', 2), s3: mk('50', 3), s4: mk('50', 4), s5: mk('50', 5), s6: mk('50', 6), s7: mk('50', 7), s8: mk('50', 8) }
    const E = { a1: mk('e0', 1), a2: mk('e0', 2), a3: mk('e0', 3), a4: mk('e0', 4), a5: mk('e0', 5), a6: mk('e0', 6) }
    const CALL = { c1: mk('ca', 1), c2: mk('ca', 2) }
    const DEV = { d1: mk('d0', 1), d2: mk('d0', 2) }
    const SCH = { s1: mk('5c', 1), s2: mk('5c', 2), s3: mk('5c', 3) }
    const CS = { x1: mk('c5', 1), x2: mk('c5', 2), x3: mk('c5', 3) }
    const ROLE = {
      r1: mk('40', 1), r2: mk('40', 2), r3: mk('40', 3), r4: mk('40', 4),
      /* 🆕 新身份那 6 行（见 `newRoleSeedSql()`） */
      r5: mk('41', 5), r6: mk('41', 6), r7: mk('41', 7),
      r8: mk('41', 8), r9: mk('41', 9), r10: mk('41', 10),
    }
    /** 考试档案 / 分数行（第十三节用来打 `can_edit_exam_for` 与 exams 的写策略） */
    const EX = { e1: mk('e1', 1), e2: mk('e1', 2), e3: mk('e1', 3), e4: mk('e1', 4) }
    const EXS = { s1: mk('e2', 1), s2: mk('e2', 2) }
    /** 教室端账号行的 id **就是**它的 auth uid（`classroom_accounts.id references auth.users`） */
    const ACCT = { a1: U.room }
    /** 🆕 2026-09-28 通知的四条夹具（见 `noticeSeedSql()`） */
    const NOTICE = { n1: mk('90', 1), n2: mk('90', 2), n3: mk('90', 3), n4: mk('90', 4), n5: mk('90', 5) }
    /**
     * 🆕 2026-09-28「公告轮」的六条夹具（见 `announcementSeedSql()`）——
     * **公告 ≠ 通知**：这张表里**没有收件范围、没有收件人**，所以夹具摆的不是"谁收得到"，
     * 而是"**生效区间 + 撤下**这两种状态各自挡不挡得住"。
     */
    const ANN = { a1: mk('92', 1), a2: mk('92', 2), a3: mk('92', 3), a4: mk('92', 4), a5: mk('92', 5), a6: mk('92', 6) }
    /**
     * `shared_files` 的夹具（裂缝 C 2026-09-27；班级归属 2026-09-28 / schema.sql §19）：
     *   f1 = 物理老师传给 1 班的文件（真实形状）；
     *   f2 = **挂在教室端账号名下**的一行 —— 真实的教室端没有上传入口，
     *        这一行是**夹具**，专门用来钉"收紧写权限时不许把读也一起挡掉"
     *        （restrictive 的 `using` 对 SELECT 也生效，写成一条 `for all` 就会挡掉它）；
     *   f3 / f4 = 两条写断言的空位（教室端插、老师插）；
     *   f5 = **同班另一位老师**（语文）传给 1 班的 —— 钉"两位老师互相看得到材料"；
     *   f6 = 物理老师**一次传给两个班**（1 班 + 4 班）—— 钉多选那条语义；
     *   f7 = 无身份新老师传给**他自己那个班**（高一）的 —— 别班/别人看不见的样本；
     *   f8 = 物理老师传的**没有班级归属**的老文件（class_ids 空）—— 教室端看不到；
     *   f9 = **老形状**（只写了老列 `class_id`，`class_ids` 还空着）—— §19.2 搬迁的样本。
     */
    const F = {
      f1: mk('f0', 1),
      f2: mk('f0', 2),
      f3: mk('f0', 3),
      f4: mk('f0', 4),
      f5: mk('f0', 5),
      f6: mk('f0', 6),
      f7: mk('f0', 7),
      f8: mk('f0', 8),
      f9: mk('f0', 9),
    }

    /** 身份名（打印用）与顺序 —— 与文档 §16.4 那张表同一组人 */
    const WHO = {
      super: '最高管理员 super',
      admin: '教务处 admin',
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
    /*
     * ⚠️ **`teachers` / `teacher_roles` 这两列永远是 1 或 0，与新加的身份无关**：
     *    2026-09-28 加的那 6 档新身份（`newRoleSeedSql()`）**不会**让任何人多看到一行 ——
     *      ① `teachers_self` / `teacher_roles_read` 都是 `teacher_id = auth.uid()`（只看得见自己那一行）；
     *      ② `teachers_not_classroom` 那条 restrictive 又把教室端压回自己那一行。
     *    所以这张表**一个字都不用改**（这也是一条隐性的断言：新身份没有把别人的行漏出来）。
     */

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
      if (mode === 'p5-lose-kind') {
        /*
         * 🔴 P5 第十六节的负向对照：**把"列表按 kind 收窄"这条纪律从改造后那一侧拿掉**。
         *    它不是"改 SQL 文本"，而是"改第十六节那条对照查询的形状" ——
         *    真正动手的地方在第十六节开头（`LOSE_KIND` 那个开关）。
         *    SQL 一个字节都不动，所以这里原样返回。
         * 期望：对照法那两条**必须变红** —— 证明它们真在测 kind，不是恒绿的摆设。
         */
        return text
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
      if (mode === 'file-read-wider' || mode === 'file-read-closed') {
        /*
         * 第十四节的负向对照（`shared_files` 的班级归属**读**策略，§19.3）：
         *   · `file-read-wider`  —— 条件换成 `true` = "谁都能读所有文件"：
         *     教室那块屏就会看到别班的材料、连**没标班**的也看得到；
         *   · `file-read-closed` —— 条件换成 `false` = "教室端又变成空列表"：
         *     正是这一节要修的那个毛病本身（空列表而且不报错）。
         * 🔴 两个方向都要各跑一次：只钉"读不到别班"会漏掉"读不到本班"，反之亦然。
         * ⚠️ 只换这一条策略的正文（按策略名切片），其余 SQL 一个字不动。
         */
        const re = /(create policy shared_files_class_read on shared_files[\s\S]*?using \()[\s\S]*?(\);\n)/
        const m = text.match(re)
        if (!m) throw new Error(`负向对照锚点没找到：shared_files_class_read 的形状变了（模式 ${mode}）`)
        return text.replace(re, `$1${mode === 'file-read-wider' ? 'true' : 'false'}$2`)
      }
      if (mode === 'department-open') {
        /*
         * 🆕 部门那一支的负向对照（**放宽**方向）：把两半判据一起拿掉 ——
         *   · `notice_department_has_members(p_department)` → true：**空部门也能发**
         *     （"发给一个谁都不在的部门"这一类通知就发得出去）；
         *   · `notice_can_publish_school_level(p_uid)` → true：**年级主任 / 组长也能给部门发**
         *     （"下级通知上级平台不承载"那条口径被推翻）。
         * 期望：二·之五 里"空部门 = 拒绝"与"年级主任 / 组长 ❌"那两条**必须变红**。
         * ⚠️ 锚点只落在**部门那一支**（`and public.notice_department_has_members(…)` 那一句）——
         *    全局 replace 会把 `school` 那一支的判据一起改掉，两条断言一起红就看不出是谁的问题。
         */
        const re =
          /and public\.notice_department_has_members\(p_department\)\s*\n\s*and public\.notice_can_publish_school_level\(p_uid\)/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：部门那一支的两半判据变了（模式 department-open）')
        }
        return text.replace(re, 'and true\n        and true')
      }
      if (mode === 'file-object-wider') {
        /*
         * 第十二节的负向对照（**存储对象**那一侧的读策略，§19.4.3）：
         * 条件换成 `true` = "桶里任何对象都能签出直链" ——
         * 那样"教室端读不到别班/没标班的**字节**"这几条必须红
         * （行读策略还拦着，但直链拿到手就等于材料泄出去了）。
         *
         * 🔴 锚点必须钉在**最后那一版**（§19.4.3）：`classroom_files_read` 这个名字在文件里
         *    出现**两次**（§9 定义一次、§19.4.3 又 drop + create 一次），而 §9 那一版**不含**
         *    `objects.name`。第一版锚点写成"从第一个 `create policy` 起、一直到 `objects.name` 为止"，
         *    `[\s\S]*?` 于是**跨过了 §9 到 §19.3 的全部内容**，把 schema 咬掉一大块 ——
         *    报出来的是 `column "school_id" of relation "classes" does not exist`（A 库建不起来），
         *    **而 `if (!m) throw` 那条守卫抓不到它**（正则照样匹配上了）。
         *    教训：负向对照的锚点自己写歪，比不做对照更危险。所以这里用 `lastIndexOf` 显式取最后一版，
         *    并要求正文里必须出现 `objects.name`（只有 §19.4.3 那一版有）。
         */
        const marker = 'create policy classroom_files_read on storage.objects'
        const at = text.lastIndexOf(marker)
        if (at < 0) throw new Error('负向对照锚点没找到：classroom_files_read 不见了（模式 file-object-wider）')
        const seg = text.slice(at)
        const m = seg.match(/^create policy classroom_files_read on storage\.objects[\s\S]*?using \(([\s\S]*?)\);\n/)
        if (!m || !/objects\.name/.test(m[1])) {
          throw new Error('负向对照锚点没找到：最后一版 classroom_files_read 的形状变了（模式 file-object-wider）')
        }
        return (
          text.slice(0, at) +
          'create policy classroom_files_read on storage.objects\n  for select to authenticated\n  using (true);\n' +
          seg.slice(m[0].length)
        )
      }
      /*
       * 🆕 P9（第十七节）三条负向对照 —— 每一条都对着一条"必须红"的断言。
       */
      if (mode === 'p9-stream-write') {
        /*
         * 走班班的屏**零写**那一半（§33.4 的三条 restrictive 策略）：
         * 把它们的条件换成 `true` = 策略恒真 = **不存在**，
         * 正是"2026-10-05 收紧之前"的样子（教室端能往**走班班**上粘贴课表）。
         * 期望：第十七节"走班班的屏写全部被拒"里那三条 schedule_items 的断言**必须红**，
         *      而同节"行政班的教室端仍然能粘贴本班课表"那一条**必须照旧绿**
         *      （那一条是"收紧没有误伤"的对照）。
         */
        let out = text
        for (const p of [
          'schedule_classroom_admin_only_insert',
          'schedule_classroom_admin_only_update',
          'schedule_classroom_admin_only_delete',
          'calls_classroom_admin_only',
        ]) {
          const seg = new RegExp(`(create policy ${p}[\\s\\S]*?;\\n)`)
          const m = out.match(seg)
          if (!m) throw new Error(`负向对照锚点没找到：${p} 这条策略不见了（模式 p9-stream-write）`)
          const stripped = m[1].replace(
            /not is_classroom_account\(\)\s*\n\s*or exists \(select 1 from classes c where c\.id = class_id and c\.kind = 'admin'\)/g,
            'true',
          )
          if (stripped === m[1]) {
            throw new Error(`负向对照锚点没找到：${p} 里的那条"只许行政班"的守卫不见了（模式 p9-stream-write）`)
          }
          out = out.replace(seg, stripped)
        }
        return out
      }
      if (mode === 'p9-call-no-manage') {
        /*
         * 事务性呼叫那一支（§33.2）：把"只有班级管理权"改成"**任教就能发**" ——
         * 那正是"科任老师也能从班级管理里直接叫人"的形状（Q32 = C 明确不要）。
         * 期望：第十七节"科任老师发事务性呼叫 → 被拒"那一条**必须红**。
         * ⚠️ 只改**事务性**那一支（`when ... = ''`），作业呼叫那一支一个字不动。
         */
        const re =
          /when coalesce\(btrim\(p_assignment_id::text\), ''\) = '' then\s*\n\s*public\.can_manage_class_for\(p_uid, p_class_id\)\s*\n\s*and exists \(select 1 from classes c where c\.id = p_class_id and c\.kind = 'admin'\)/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：can_call_for 的"事务性"那一支变了（模式 p9-call-no-manage）')
        }
        return text.replace(
          re,
          `when coalesce(btrim(p_assignment_id::text), '') = '' then
      public.can_manage_class_for(p_uid, p_class_id)
      or public.teaches_in_class_for(p_uid, p_class_id)`,
        )
      }
      if (mode === 'p10-no-audit') {
        /*
         * 选科变更审计（§34）的**两半**一起拿掉 —— 它们各自对应一条"必须红"的断言：
         *   ① `write_student_subject` 里"内容变了就写一条记录"整段：
         *      那正是"三个人都能改，但谁也查不出改了什么"的形状（Q27 = B 明确要它）
         *      → 第十八节"改一次选科 → 记录恰好一条"必须红；
         *   ② 读策略里的 `not is_classroom_account()`：
         *      教室里那块屏就会读到"谁改了谁的选科"
         *      → 第十八节"教室端 → 0 行"必须红。
         */
        const re = /if v_before is distinct from v_after then\s*\n\s*insert into student_subject_changes[\s\S]*?returning id into v_change_id;\s*\n\s*end if;/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：write_student_subject 里那段审计插入不见了（模式 p10-no-audit）')
        }
        const out = text.replace(re, '/* 负向对照：审计插入被拿掉 */')
        const re2 = /not is_classroom_account\(\) and public\.can_edit_student_subject\(student_id\)/
        if (!re2.test(out)) {
          throw new Error('负向对照锚点没找到：审计读策略里的教室端守卫不见了（模式 p10-no-audit）')
        }
        return out.replace(re2, 'public.can_edit_student_subject(student_id)')
      }
      if (mode === 'p10-purge-no-confirm') {
        /*
         * 旧科目数据的**二次确认**（§34.3）：把 `if p_confirm is not true then raise …` 拿掉 ——
         * 那正是"不确认也能删"的形状，而删除**不可恢复**。
         * 期望：第十八节"不确认 → 删不掉"那一条**必须红**（而且那一行会被真删掉，
         *       所以它后面还跟着一条"确认后才删得掉"的断言，两条一起看）。
         */
        const re =
          /if p_confirm is not true then\s*\n\s*raise exception '删除旧科目数据需要二次确认[\s\S]*?\n\s*end if;/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：purge_old_subject_data 里那句二次确认不见了（模式 p10-purge-no-confirm）')
        }
        return text.replace(re, '/* 负向对照：二次确认被拿掉 */')
      }
      if (mode === 'p10-suspend-removes-members') {
        /*
         * 休学那一档（§34.5 的触发器）：把"只在 `left` 时移出"放宽成"**休学也移出**" ——
         * 那正是 Q28 = B 明确否掉的做法（"休学保留但标记"）。
         * 期望：第十八节"休学 → 走班名单**保留**"那一条**必须红**。
         */
        const re = /if new\.status = 'left' and old\.status is distinct from 'left' then/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：触发器里那句 `new.status = \'left\'` 不见了（模式 p10-suspend-removes-members）')
        }
        return text.replace(re, "if new.status in ('left', 'suspended') and old.status is distinct from new.status then")
      }
      if (mode === 'teacher-tier-by-roles') {
        /*
         * 🔴 「任课教师」那一档的负向对照（2026-09-26 实测的一处**真漏人**）：
         *    把判据**改回**修之前那一版 —— "一格 `teacher_roles` 都没有才算任课教师"。
         *    ⚠️ 两处必须**一起**退（收件人那一支 + `notice_role_has_members('teacher')`）：
         *    只退一处，退回去的就不是那个 bug，而是另一个形状（403 发不出去 / 收件人是空的）。
         * 期望：二·之四 ⑤′ 里"**有头衔 + 也教课**的老师必须收到"那一条**必须红**
         *    （唐友余那个形状 —— 这正是用户实测漏掉的人）；
         *    而"纯任课教师必须收到"仍然绿（phy / chn 一格身份行都没有，旧口径正好也能捞到他们）。
         */
        const NEW = 'and exists (select 1 from class_subjects cs where cs.teacher_id = t.id)'
        const OLD = 'and not exists (select 1 from teacher_roles r where r.teacher_id = t.id)'
        const hits = text.split(NEW).length - 1
        if (hits !== 2) {
          throw new Error(
            `负向对照锚点对不上：'${NEW}' 在 schema.sql 里出现 ${hits} 次（应为 2 —— ` +
              `收件人那一支 + notice_role_has_members）`,
          )
        }
        return text.split(NEW).join(OLD)
      }
      if (mode === 'assignment-delete-manage-class') {
        /*
         * 🆕 负向对照（2026-10-06 收窄 `assignments_delete`）：把去掉的那一支
         * `can_manage_class(class_id)` **加回去** = "班主任 / 年级主任 / 教务处删得掉别人的作业档案"
         *（= 这一轮之前那个形状：改不了却删得掉，而删除不可恢复）。
         * 期望：第五节的「① 班主任删…被拒」「② 年级主任…」「③ 教务处…」**必须红**；
         *      而「④ 建档人自己仍删得掉」「⑤ 本班本科老师删得掉」照旧绿。
         */
        const re =
          /(create policy assignments_delete on assignments for delete to authenticated\s*\n\s*using \(\s*\n\s*teacher_id = auth\.uid\(\)\s*\n)/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：assignments_delete 那条策略的形状变了（模式 assignment-delete-manage-class）')
        }
        return text.replace(re, '$1    or can_manage_class(class_id)\n')
      }
      if (mode === 'profile-classroom') {
        /*
         * 🆕 学生档案（§35）的负向对照①：把读策略里那句 `not is_classroom_account()`
         * 拿掉 = "教室端也读得到家长电话/家庭住址"（= 这一轮之前那个形状）。
         * 期望：第十九节"教室端一行都读不到"**必须红**（而且它一定会红成"读到 3 行"）。
         * 🆕 同一句也作用在**教师档案**（§36）那条读策略上：
         *    期望第二十节"教室端读教师档案 0 行"**也必须红**。
         */
        const re =
          /(create policy student_profiles_visible on student_profiles[\s\S]*?)not is_classroom_account\(\)\s*\n\s*and /
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：student_profiles_visible 里那句教室端守卫不见了（模式 profile-classroom）')
        }
        let out = text.replace(re, '$1')
        const reT =
          /(create policy teacher_profiles_visible on teacher_profiles[\s\S]*?)not is_classroom_account\(\)\s*\n\s*and /
        if (!reT.test(out)) {
          throw new Error('负向对照锚点没找到：teacher_profiles_visible 里那句教室端守卫不见了（模式 profile-classroom）')
        }
        out = out.replace(reT, '$1')
        return out
      }
      if (mode === 'profile-write-open') {
        /*
         * 🆕 负向对照②：把三条写策略里的 `can_manage_class(…)` 换成恒真
         * = "谁都能改学生档案"（正是"读得宽"被错当成"写得宽"的那个形状）。
         * 期望：第十九节"科任老师改不了"那三条**必须红**（班主任那几条照旧绿）。
         * 🆕 同一模式也把**教师档案**（§36）那两条写策略换成恒真：
         *    期望第二十节"老师本人 / 年级主任 / 班主任 / 教室端改不了"**必须红**。
         */
        const re =
          /(create policy student_profiles_(?:insert|update|delete) on student_profiles[\s\S]*?)(?=;\n)/g
        if (!/create policy student_profiles_update/.test(text)) {
          throw new Error('负向对照锚点没找到：student_profiles 那三条写策略不见了（模式 profile-write-open）')
        }
        let n = 0
        const out = text.replace(re, (seg) => {
          n++
          return seg.replace(
            /can_manage_class\(\(select s\.class_id from students s where s\.id = student_profiles\.student_id\)\)/g,
            'true',
          )
        })
        if (n !== 3) throw new Error(`负向对照锚点对不上：只改到 ${n} 条写策略（应为 3）`)
        const reT =
          /(create policy teacher_profiles_(?:insert|update) on teacher_profiles[\s\S]*?)(?=;\n)/g
        if (!/create policy teacher_profiles_update/.test(out)) {
          throw new Error('负向对照锚点没找到：teacher_profiles 那两条写策略不见了（模式 profile-write-open）')
        }
        let nt = 0
        const out2 = out.replace(reT, (seg) => {
          nt++
          return seg.replace(/can_create_teacher_accounts\(\)/g, 'true')
        })
        if (nt !== 2) throw new Error(`负向对照锚点对不上：只改到 ${nt} 条教师档案写策略（应为 2）`)
        return out2
      }
      if (mode === 'profile-mask-off') {
        /*
         * 🆕 负向对照③：把 `report_frontend_error()` 里那两句"抹掉学生档案 PII 值"拿掉
         * = 上报的正文里**原样留着**家长电话（正是这一轮之前的样子）。
         * 期望：第十九节"值被抹掉"**必须红**，而"has_pii 标出来了"照旧绿。
         */
        const re =
          /\n\s*v_message := regexp_replace\(v_message, '\(家长电话[\s\S]*?\[已隐去\]', 'g'\);\n\s*v_stack   := regexp_replace\(v_stack,   '\(家长电话[\s\S]*?\[已隐去\]', 'g'\);/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：report_frontend_error 里那两句 PII 抹除不见了（模式 profile-mask-off）')
        }
        return text.replace(re, '\n  -- 负向对照：PII 抹除被拿掉')
      }
      if (mode === 'profile-teacher-mask-off') {
        /*
         * 🆕 教师档案（§1.1 / §36）的负向对照⑤：把 `report_frontend_error()` 里那两句
         * "抹掉邮箱域名"拿掉 = 上报的正文里**原样留着** `lilaoshi@example.com`。
         * 期望：第二十节"域名被抹掉"**必须红**，而"`has_pii` 标出来了"照旧绿
         *    （顺序没被改回去 —— 这正好把"先判再洗"那条纪律也一起钉住）。
         */
        const re =
          /\n\s*--\s*🆕 教师档案的\*\*邮箱\*\*[\s\S]*?v_stack   := regexp_replace\(v_stack,   '\(@\)\[A-Za-z0-9\.-\]\+\\\.\[A-Za-z\]\{2,\}', '\\1\[已隐去\]', 'g'\);/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：report_frontend_error 里那两句邮箱抹除不见了（模式 profile-teacher-mask-off）')
        }
        const marker = '-- 负向对照：邮箱抹除被拿掉'
        let out = text.replace(re, `\n  ${marker}`)
        /*
         * ⚠️ 上面那段正则吃掉的是**两句**（`v_message` + `v_stack`），但替换只写回一行 ——
         *    所以下面按"抹除只剩几处"再核一次：两处都该没了。
         */
        const left = (out.match(/\(@\)\[A-Za-z0-9\.-\]/g) ?? []).length
        if (left !== 0 || !out.includes(marker)) {
          throw new Error(`负向对照锚点对不上：邮箱抹除还剩 ${left} 处（应为 0）`)
        }
        return out
      }
      if (mode === 'profile-drop-from-payload') {
        /*
         * 🆕 负向对照④：把备份 payload（§29.5）里的 `studentProfiles` 那一项拿掉
         * = "删掉一个年级时那批家长电话**静默消失**"（备份里没有、界面上也没了）。
         * 期望：第十九节"逐表 dump 覆盖到学生档案"**必须红**。
         */
        const re =
          /\n\s*-- 🆕 学生档案整表带走[\s\S]*?'studentProfiles', coalesce\(\(select jsonb_agg\(to_jsonb\(x\)\) from student_profiles x\n\s*where x\.student_id in \(select id from s\)\), '\[\]'::jsonb\),/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：payload 里的 studentProfiles 那一项不见了（模式 profile-drop-from-payload）')
        }
        return text.replace(re, '')
      }
      if (mode === 'one-super-index-drop') {
        /*
         * 🆕 2026-10-08「超管锁死」的负向对照：把 `teacher_roles_one_super` 那条
         * **部分唯一索引**从 schema 文本里拿掉 = "超管又可以不只一个了"（这一轮之前的形状）。
         * 期望：§二·之二·之二的「插第二个 super 被数据库拒」**必须红**。
         *
         * ⚠️ 与 `direct-revert:*` 同一套路：改的是**内存里的 SQL 文本**，
         *    仓库里的 `schema.sql` 一个字节都不动。
         */
        const re = /\ncreate unique index if not exists teacher_roles_one_super\n[^;]*;\n/
        if (!re.test(text)) {
          throw new Error('负向对照锚点没找到：teacher_roles_one_super 那条部分唯一索引不见了（模式 one-super-index-drop）')
        }
        return text.replace(re, '\n-- 负向对照：teacher_roles_one_super 被拿掉\n')
      }
      if (mode === 'room-account-wider') {
        /*
         * 🆕 第二十一节的负向对照：**SQL 一个字节都不动** ——
         * 那一支改的是**服务端源码**（`functions/api/classroom-account.ts` 的 `mayManage()`），
         * 真正动手的地方在第二十一节开头那个 `widened` 开关（与 `p5-lose-kind` 同一套路）。
         * 期望：那一节里"别的年级的年级主任"那几条**必须变红**。
         */
        return text
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
    async function makeDb(schemaText, withFileFixtures) {
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
      /*
       * ⚠️ 文件夹具（`shared_files`）**只灌 B 库**：A 库是"§16 之前"那一份，
       *    而 §19（班级归属）也在切掉的范围里 —— 它连 `class_ids` 这一列都没有，
       *    灌进去会当场 42703。A 库的职责只有"删旧策略之前的可见量"，与文件无关
       *    （逐人可见量那张快照里没有 shared_files，见 SNAPSHOT_SQL）。
       */
      if (withFileFixtures) await db.exec(fileSeedSql())
      /*
       * 🆕 新身份夹具（2026-09-28）与文件夹具**同一个开关**：只有 B 库灌。
       * 理由也一样：新身份依赖 §10.1.1 的 `subject_code` 那一列，而 A 库是"§16 之前"
       * 那一份 —— 它连那一列都没有（灌进去当场 42703）。
       * ⚠️ 它们**不影响逐人可见量那张快照**：`teachers` / `teacher_roles` 两列都是
       *    `teacher_id = auth.uid()`（只看得见自己那一行），加人不改变任何人的计数。
       */
      if (withFileFixtures) await db.exec(newRoleSeedSql())
      /* 🆕 通知夹具也只在 B 库（同一个理由：§21 的表在 A 库里不存在） */
      if (withFileFixtures) await db.exec(noticeSeedSql())
      /* 🆕 公告夹具同理（§22 那张表在 A 库里不存在） */
      if (withFileFixtures) await db.exec(announcementSeedSql())
      return { db, realtime }
    }

    /* ---------------- 固定数据 ---------------- */

    function seedSql() {
      const school = '(select id from schools order by created_at limit 1)'
      const grade = (n) => `(select id from grades where name = '${n}')`
      return `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${U.super}', 'super@shugao.test', '{"name":"最高管理员","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.admin}', 'admin@shugao.test', '{"name":"教务处","subject":"化学","subject_code":"chemistry"}'::jsonb),
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

    -- 文件互传（shared_files）的夹具**不在这里** —— 它在 fileSeedSql() 里、只有 B 库会灌：
    --   class_ids（§19）这一列在 A 库上根本不存在（A 是"§16 之前"那一份，§19 也被切掉了）。

    -- 考试档案（第十三节）：四份，把"读得宽 / 写得窄"的每一面都摆出来
    --   e1 物理老师建的**单班**物理（c1）        → 他自己可写；班主任/年级主任只读；教室端读得到
    --   e2 物理老师建的**多班**物理（c1 + c2）   → 钉"多班数组"这条语义（两班他都教）
    --   e3 语文老师建的单班语文（c1）            → 物理老师**写不了**（不是他建的、也不是他那一科）
    --   e4 教务处建的高三化学（c3）              → 教室端**看不见**（不是他的班）
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

    /**
     * `shared_files` 的夹具（§9 裂缝 C + §19 班级归属）—— **只有 B 库会跑**（理由见 `makeDb`）：
     *   f1 老师真传的一份（归 1 班）；f2 挂在教室端账号名下（真实教室端没有上传入口 ——
     *   它是夹具，用来钉"收紧写不许把读一起挡掉"）；f5 **同班另一位老师**传的；
     *   f6 一个文件**同时归两个班**；f7 别班（高一，无身份老师自己建的班）的；
     *   f8 **没有班级归属**（教室端看不到）；f9 **老形状**：只写了老列 `class_id`（§19.2 搬迁样本）。
     *   ⚠️ 这里是超级用户直接插的（RLS 不过），所以 f9 这种"新前端已经不会再写"的形状插得进去。
     */
    function fileSeedSql() {
      return `
    insert into shared_files (id, teacher_id, class_id, class_ids, name, mime, size, storage_path) values
      ('${F.f1}', '${U.phy}',   '${C.c1}', array['${C.c1}']::uuid[],           '老师传的题图.png', 'image/png', 1024, '${U.phy}/aa-题图.png'),
      ('${F.f2}', '${U.room}',  '${C.c1}', array['${C.c1}']::uuid[],           '夹具-教室端名下那一行.png', 'image/png', 2048, '${U.room}/bb-夹具.png'),
      ('${F.f5}', '${U.chn}',   '${C.c1}', array['${C.c1}']::uuid[],           '同班语文老师传的答案.pdf', 'application/pdf', 4096, '${U.chn}/cc-答案.pdf'),
      ('${F.f6}', '${U.phy}',   '${C.c1}', array['${C.c1}','${C.c2}']::uuid[], '一个课件给两个班.png', 'image/png', 8192, '${U.phy}/dd-两个班.png'),
      ('${F.f7}', '${U.fresh}', '${C.c4}', array['${C.c4}']::uuid[],           '别班的文件.png', 'image/png', 512, '${U.fresh}/ee-别班.png'),
      ('${F.f8}', '${U.phy}',   null,      '{}',                               '老文件-没有班级归属.png', 'image/png', 256, '${U.phy}/ff-没归属.png'),
      ('${F.f9}', '${U.phy}',   '${C.c3}', '{}',                               '老形状-只写了老列.png', 'image/png', 128, '${U.phy}/gg-老列.png');

    -- 桶里对应的对象（§19.4.3 那一条读策略按 storage_path = objects.name 关联）：
    --   "行读得到 → 对象也读得到"，所以这一半必须和上面那七行**一一对上**。
    insert into storage.objects (bucket_id, name) values
      ('classroom-files', '${U.phy}/aa-题图.png'),
      ('classroom-files', '${U.room}/bb-夹具.png'),
      ('classroom-files', '${U.chn}/cc-答案.pdf'),
      ('classroom-files', '${U.phy}/dd-两个班.png'),
      ('classroom-files', '${U.fresh}/ee-别班.png'),
      ('classroom-files', '${U.phy}/ff-没归属.png'),
      ('classroom-files', '${U.phy}/gg-老列.png');
    `
    }

    /**
     * 🆕 2026-09-28「管理架构与角色权限」这一轮的**新身份夹具**（§二·之二 / §十九 用它）。
     *
     * 只有 **B 库**会灌它（与 `fileSeedSql()` 同一个理由：A 库是"§16 之前"那一份，
     * 而新身份依赖 §10.1.1 的 `subject_code` 那一列 —— A 库上根本没有）。
     *
     * 六个人，覆盖**五种范围形状** + 三档校级同权：
     *   prin  校长            scope 无            → 全校只读 + 发全校通知
     *   vprin 副校长          scope 无            → 与校长逐格相同（**这条要单独断言**）
     *   ohead 办公室主任      scope 无            → **只建号 + 发全校通知**，看不到任何教学数据
     *   moral 德育处主任      scope 无            → 全校**只读** + 发全校通知
     *   slead 教研组长（物理）scope='subject'      → 只读本学科**跨年级**
     *   llead 备课组长（物理）scope='grade_subject' → 只读**本年级**本学科
     *   🆕 2026-10-08 再加两个（「超管锁死」那一节用，见 §二·之二·之二）：
     *   super2 打算当第二个超管的人（**这一节不带任何身份行** —— 身份由断言现加）
     *   head2  第二个班主任（证明"别的角色照旧可以多人"）
     *
     * ⚠️ 他们**不写 `class_subjects`**（组长可以不带课 —— 那正是这个职务的意义，
     *    见 §13.3.1 那段注释：判据来自"哪些班开了这一科"，不是"哪些班我任课"）。
     */
    function newRoleSeedSql() {
      const school = '(select id from schools order by created_at limit 1)'
      const grade = (n) => `(select id from grades where name = '${n}')`
      return `
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${U.prin}',  'principal@shugao.test', '{"name":"校长","subject":"语文","subject_code":"chinese"}'::jsonb),
      ('${U.vprin}', 'vice@shugao.test',      '{"name":"副校长","subject":"数学","subject_code":"math"}'::jsonb),
      ('${U.ohead}', 'office@shugao.test',    '{"name":"办公室主任","subject":"历史","subject_code":"history"}'::jsonb),
      ('${U.moral}', 'moral@shugao.test',     '{"name":"德育处主任","subject":"政治","subject_code":"politics"}'::jsonb),
      ('${U.slead}', 'slead@shugao.test',     '{"name":"物理教研组长","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.llead}', 'llead@shugao.test',     '{"name":"高二物理备课组长","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.super2}','super2@shugao.test',    '{"name":"实习维护者","subject":"物理","subject_code":"physics"}'::jsonb),
      ('${U.head2}', 'head2@shugao.test',     '{"name":"高二(4)班班主任","subject":"物理","subject_code":"physics"}'::jsonb);

    insert into teacher_roles (id, teacher_id, role, scope_type, scope_id, subject_code) values
      ('${ROLE.r5}',  '${U.prin}',  'principal',        'school',        ${school},        null),
      ('${ROLE.r6}',  '${U.vprin}', 'vice_principal',   'school',        ${school},        null),
      ('${ROLE.r7}',  '${U.ohead}', 'office_head',      'school',        ${school},        null),
      ('${ROLE.r8}',  '${U.moral}', 'moral_edu_head',   'school',        ${school},        null),
      ('${ROLE.r9}',  '${U.slead}', 'subject_lead',     'subject',       null,             'physics'),
      ('${ROLE.r10}', '${U.llead}', 'lesson_prep_lead', 'grade_subject', ${grade('高二')}, 'physics');
    `
    }

    /* ============================================================
       🆕 通知夹具（2026-09-28）—— 五条，把"谁能读到哪条"的每一面都摆出来
       ------------------------------------------------------------
         n1 教务处发的**全校**通知        → 所有教师都读得到；**教室端读不到**（I47 的核心）
         n2 年级主任发给**本年级**的       → 该年级有任教关系的老师 + 班主任 / 年级主任 / 备课组长
         n3 教研组长发给**本学科**的       → 本校这一科有任教关系的老师 + 该学科组长
         n4 校长发的**已撤下**的全校通知   → **谁都读不到**（撤下 ≠ 删除，但它从可见集里消失）
         n5 🆕 教务处发的**发给教务处**的  → 归在 `teacher_departments` 里那几个人（多对多那一维）

       🆕 **部门归属夹具**（`teacher_departments`，同一段里灌）：
         office    ：办公室主任（ohead）
         academic  ：教务处主任（admin）**+ 物理老师（phy，兼教务处干事）** ← 多对多 / 兼岗的活样本
         moral_edu ：德育处主任（moral）
         logistics ：**一个人都没有** ← 专门用来钉"空部门 = 拒绝"（与"空职位"同一个洞）
       而 prin / vprin / grade / head / chn / slead / llead / fresh **一个部门都不属于** ——
       "不属于任何部门"是**正常状态**（纯任课老师），不是数据缺失。
       ============================================================ */
    function noticeSeedSql() {
      const school = '(select id from schools order by created_at limit 1)'
      const grade = (n) => `(select id from grades where name = '${n}')`
      return `
    insert into notices (id, school_id, sender_id, title, body, scope_kind, created_at) values
      ('${NOTICE.n1}', ${school}, '${U.admin}', '全体教师会', '周三 16:30 报告厅', 'school',         now() - interval '3 hours'),
      ('${NOTICE.n2}', ${school}, '${U.grade}', '高二年级会', '周五第 8 节',       'grade',          now() - interval '2 hours'),
      ('${NOTICE.n3}', ${school}, '${U.slead}', '物理教研活动', '下周二下午',      'subject',        now() - interval '1 hours'),
      ('${NOTICE.n4}', ${school}, '${U.prin}',  '已撤下的通知', '这条不该被任何人看到', 'school',    now() - interval '30 minutes'),
      ('${NOTICE.n5}', ${school}, '${U.admin}', '教务处内部安排', '周五下午教务例会', 'department', now() - interval '20 minutes');

    update notices set revoked_at = now() where id = '${NOTICE.n4}';

    insert into notice_targets (notice_id, target_kind, grade_id, subject_code, target_role, teacher_id, target_department) values
      ('${NOTICE.n1}', 'school',         null,            null,      null, null, null),
      ('${NOTICE.n2}', 'grade',          ${grade('高二')}, null,      null, null, null),
      ('${NOTICE.n3}', 'subject',        null,            'physics', null, null, null),
      ('${NOTICE.n4}', 'school',         null,            null,      null, null, null),
      ('${NOTICE.n5}', 'department',     null,            null,      null, null, 'academic');

    -- 🆕 部门归属（老师 ↔ 职能部门，多对多且可空）
    insert into teacher_departments (teacher_id, department) values
      ('${U.ohead}', 'office'),
      ('${U.admin}', 'academic'),
      ('${U.phy}',   'academic'),
      ('${U.moral}', 'moral_edu');
    `
    }

    /* ============================================================
       🆕 全站公告夹具（2026-09-28 公告轮 · `schema.sql` §22）
       ------------------------------------------------------------
       🔴 **公告 ≠ 通知**：`announcements` 里**没有收件范围 / 收件人**（那是通知的字段），
          所以这六条摆的不是"谁收得到"，而是**可见性的四种状态**：
            a1 普通 · 生效中（两端都空 = 立即生效 / 不过期）      → 所有老师都看得到
            a2 重要 + 置顶 · 生效中                                → 同上（置顶只影响"排在哪"）
            a3 紧急 · 生效中                                       → 同上（等级只影响"多显眼"）
            a4 **已撤下**（`revoked_at` 非空）                      → **谁都读不到**（撤下 ≠ 删行）
            a5 **未生效**（`active_from` 在未来）                   → 谁都读不到（还没到点）
            a6 **已过期**（`active_to` 在过去）                     → 谁都读不到（过期自动消失）

       ⚠️ 与通知夹具同一个开关：**只有 B 库**灌它（A 库是"§16 之前"那一份，§22 那张表不存在）。
       ============================================================ */
    function announcementSeedSql() {
      const school = '(select id from schools order by created_at limit 1)'
      return `
    insert into announcements (id, school_id, title, body, level, popup, pin,
                               active_from, active_to, created_by, updated_by, created_at) values
      ('${ANN.a1}', ${school}, '系统维护：今晚 23:00–23:30', '平台升级数据库，期间可能有一两次保存失败。',
       'normal',    'never',   false, null,                        null,                      '${U.super}', '${U.super}', now() - interval '3 hours'),
      ('${ANN.a2}', ${school}, '新功能上线：按学科看统计',       '在「考试 → 统计」那一页右上角。',
       'important', 'once',    true,  now() - interval '2 hours',  null,                      '${U.super}', '${U.super}', now() - interval '2 hours'),
      ('${ANN.a3}', ${school}, '紧急：请立刻改密码',             '检测到一次异常登录，请今天就换掉密码。',
       'urgent',    'never',   false, null,                        null,                      '${U.super}', '${U.super}', now() - interval '1 hours'),
      ('${ANN.a4}', ${school}, '已撤下的公告',                   '这条不该被任何人看到。',
       'normal',    'never',   false, null,                        null,                      '${U.super}', '${U.super}', now() - interval '40 minutes'),
      ('${ANN.a5}', ${school}, '还没生效的公告',                 '明天的活动预告。',
       'normal',    'never',   false, now() + interval '1 day',    null,                      '${U.super}', '${U.super}', now() - interval '30 minutes'),
      ('${ANN.a6}', ${school}, '已经过期的公告',                 '上个月的事。',
       'normal',    'never',   false, now() - interval '10 days',  now() - interval '9 days', '${U.super}', '${U.super}', now() - interval '20 minutes');

    -- 撤下走的是 update（**不是 delete**）：行还在，只是从"看得见"里消失
    update announcements set revoked_at = now() where id = '${ANN.a4}';
    `
    }

    /* ============================================================
       以某个身份跑 SQL       ------------------------------------------------------------
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
     *
     * 🆕 2026-10-08：`denied` 再带上 PG 的 `code` 与 `constraint`（`outcome` / `sqlState` / `constraint`）——
     * 「超管锁死」那一节要分清**是谁拒的**：策略拒（42501）还是**唯一索引**拒（23505）。
     * 只看 `denied` 是不够的：`denied` 的两种原因在这里恰恰是**两件不同的事**。
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
          return {
            outcome: 'denied',
            affected: 0,
            detail: `${kind}：${m}`,
            sqlState: e?.code ?? null,
            constraint: e?.constraint ?? null,
          }
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

    const B = await makeDb(SCHEMA_FULL, true)
    const A = await makeDb(SCHEMA_BEFORE_STAGE5, false)
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
      eq('is_super_admin()：教务处 false（**两种身份、判据分开**，I17）', await f(U.admin, 'is_super_admin()'), false)
      eq('is_school_admin()：超管 / 教务处都 true', [await f(U.super, 'is_school_admin()'), await f(U.admin, 'is_school_admin()')], [true, true])
      eq('is_school_admin()：任课老师 false', await f(U.phy, 'is_school_admin()'), false)
      eq(
        '🔴 is_school_admin()：年级主任 / 班主任 false（2026-10-07 起它还管着"能不能置顶通知"）',
        [await f(U.grade, 'is_school_admin()'), await f(U.head, 'is_school_admin()')],
        [false, false],
      )
      eq(
        'can_manage_teachers()：超管 / 教务处 true（建号与指派身份同档，§16.8）',
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
        'can_grade_subject：超管 / 教务处兜底 true',
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
       二·之二 🆕 2026-09-28：拆 `can_manage_teachers`（**建号 ≠ 指派身份**）
       ------------------------------------------------------------
       这是本轮**唯一变宽的写权限**（办公室主任建号）的守门断言，
       也是用户点名"一条不能省的安全步骤"的那一条。

       🔴 它为什么必须拆：`can_manage_teachers()` 原本**同时**管三件事 ——
          建号 / 维护任课关系 / **指派身份**。直接给它加 `office_head`，
          办公室主任就能**给自己发一条 `super`**。
       🔴 下面这一组断言的价值全在**两个函数的差集**上：
          `can_create_teacher_accounts` 与 `can_assign_roles` 在
          **办公室主任**那一档必须**不相等** —— 相等就说明拆了等于没拆。
       ============================================================ */

    section('二·之二 🆕 拆 can_manage_teachers：建号 ≠ 指派身份（办公室主任能建号、不能指派）')
    {
      const f = (uid, expr) => asUser(db, uid, async () => Boolean((await db.query(`select ${expr} as v`)).rows[0].v))

      /* ---- ① 两个函数的逐档真值表（8 档身份 × 2 个判据） ---- */
      const CASES = [
        ['super', U.super, true, true],
        ['admin 教务处', U.admin, true, true],
        ['office_head 办公室主任', U.ohead, true, false],
        ['principal 校长', U.prin, false, false],
        ['moral_edu_head 德育处主任', U.moral, false, false],
        ['grade_head 年级主任', U.grade, false, false],
        ['teacher 任课教师', U.phy, false, false],
        ['classroom 教室端', U.room, false, false],
      ]
      for (const [label, uid, canCreate, canAssign] of CASES) {
        eq(
          `建号：${label}`,
          await f(uid, 'can_create_teacher_accounts()'),
          canCreate,
        )
        eq(
          `指派身份：${label}`,
          await f(uid, 'can_assign_roles()'),
          canAssign,
        )
      }

      /* ---- ② 🔴 本段的核心：两个判据在办公室主任上**必须不同** ---- */
      {
        const cc = await f(U.ohead, 'can_create_teacher_accounts()')
        const ca = await f(U.ohead, 'can_assign_roles()')
        ok(
          '🔴 办公室主任：**能建号**（true）但**不能指派身份**（false）—— 拆函数的意义全在这一条',
          cc === true && ca === false,
          `can_create=${cc} / can_assign=${ca}`,
        )
        ok(
          '🔴 这两个判据在办公室主任上**不相等** —— 相等就说明"拆了等于没拆"（负向对照 Q1 就是打这一条）',
          cc !== ca,
          `can_create=${cc} / can_assign=${ca}`,
        )
      }

      /* ---- ③ 旧函数一个字没改：`can_manage_teachers()` 仍是 super + admin ---- */
      eq(
        'can_manage_teachers() 语义**一个字没改**（super / admin true；办公室主任 false）',
        [
          await f(U.super, 'can_manage_teachers()'),
          await f(U.admin, 'can_manage_teachers()'),
          await f(U.ohead, 'can_manage_teachers()'),
        ],
        [true, true, false],
      )

      /* ---- ④ 两件套（I33）：`_for` 变体一律 revoke，裸版才 grant ---- */
      const twoPiece = async (fn, sig, arg) => {
        const r = await asUser(db, U.phy, async () => {
          try {
            await db.query(`select ${fn}(${arg})`)
            return 'ok'
          } catch (e) {
            const m = shortErr(e)
            return /permission denied/.test(m) ? 'denied' : `err:${m}`
          }
        })
        return r
      }
      eq(
        '🔴 两件套（I33）：`can_create_teacher_accounts_for(uid)` 对教师**已 revoke** → 被拒',
        await twoPiece('can_create_teacher_accounts_for', '(uuid)', `'${U.ohead}'`),
        'denied',
      )
      eq(
        '🔴 两件套（I33）：`can_assign_roles_for(uid)` 对教师**已 revoke** → 被拒',
        await twoPiece('can_assign_roles_for', '(uuid)', `'${U.admin}'`),
        'denied',
      )
      eq(
        '🔴 两件套（I33）：`subject_lead_class_ids_for(uid)` 对教师**已 revoke** → 被拒',
        await twoPiece('subject_lead_class_ids_for', '(uuid)', `'${U.slead}'`),
        'denied',
      )
      eq(
        '🔴 两件套（I33）：`notice_recipient_ids_for(notice_id)` 对教师**已 revoke** → 被拒',
        await twoPiece('notice_recipient_ids_for', '(uuid)', `'${NOTICE.n1}'`),
        'denied',
      )
    }

    /* ============================================================
       二·之二·之二 🆕 2026-10-08：**最高管理员锁死成一个**
       ------------------------------------------------------------
       用户拍板：「超管锁死，只能有我一个」（设计文档里 2026-09-24 那句
       「只留 Izar 一个最高管理员」是同一件事）。背景是教师列表里真的出现了
       第二个 `super`（内测账号「Gold Award」挂着 6 个身份、其中一个是 `super`）。

       两半，各管一件事：
         · **数据库那一半**（`schema.sql` §10.1.1 ⑥ 的部分唯一索引 `teacher_roles_one_super`）
           = "多不了"。这是**锁死**，不是报警 —— 报警只能告诉你有两个。
         · **判据那一半**（§13.2.2 `can_assign_super_role`）
           = "谁有资格发"。`can_assign_roles()`（超管 ∪ 教务处）**一个字不动** ——
           教务处照旧能发班主任 / 年级主任 / 组长，只是**发不了 super**。

       🔴 反向对照（`RLS_NEGATIVE=one-super-index-drop`）：把那条索引 drop 掉 →
         下面「插第二个 super」**必须变红**（证明它拦的就是这条约束，不是别的东西顺手挡的）。
       ============================================================ */

    section('二·之二·之二 🆕 超管唯一：插第二个 super 被数据库拒 · 教务处发不了 super · 别的角色不受影响')
    {
      const f = (uid, expr) => asUser(db, uid, async () => Boolean((await db.query(`select ${expr} as v`)).rows[0].v))

      /**
       * 🔴 这一节**故意不走 `authenticated` 那条路**（与别节不同，理由要写清楚）：
       *    `teacher_roles` 对 authenticated **只 grant 了 select**（§10.4；写一律走服务端
       *    `/api/teacher-account`，用 service_role 穿过 RLS）。所以从 `authenticated`
       *    插第二行 super，先撞上的是**表权限**（42501），根本走不到唯一索引 ——
       *    那样的"被拒"是**假断言**（§三.1 那条反面教材：看起来被拒，其实没走到那一层）。
       *
       *    这里要验的恰恰是**唯一索引**（约束）—— 它在**任何**角色上都对表生效，
       *    而线上服务端正是用 service_role 写这张表的。所以用连接的所有者身份直插，
       *    断言必须是 **23505 + teacher_roles_one_super**（不是"被拒"两个字）。
       */
      const rawInsertRole = (uid, role) =>
        db.query(
          `insert into teacher_roles (teacher_id, role, scope_type) values ($1, $2::text, 'school') returning id`,
          [uid, role],
        )

      /* ---- ① 🔴 核心：插第二个 super → 被拒，而且是**唯一索引**拒的（23505） ---- */
      {
        let deniedRes = null
        try {
          await rawInsertRole(U.super2, 'super')
        } catch (e) {
          deniedRes = { code: e?.code ?? null, constraint: e?.constraint ?? null, msg: shortErr(e) }
        }
        ok('🔴 插第二个 `super` → 被数据库拒（锁死，不是报警）', deniedRes !== null, '居然插进去了')
        eq(
          '🔴 而且是**唯一索引**拒的（23505 / `teacher_roles_one_super`）—— 不是别的什么顺手挡的',
          [deniedRes?.code ?? null, deniedRes?.constraint ?? null],
          ['23505', 'teacher_roles_one_super'],
        )
        eq(
          '拒绝之后库里仍然只有 1 个 super（那一行**一个字都没写进去**）',
          Number((await db.query(`select count(*)::int as n from teacher_roles where role = 'super'`)).rows[0].n),
          1,
        )
      }

      /* ---- ② 反向对照：把索引 drop 掉 → ① 必须红（**证明上面那条不是摆设**） ---- */
      {
        await db.exec('drop index teacher_roles_one_super')
        let okAfterDrop = true
        try {
          await rawInsertRole(U.super2, 'super')
        } catch {
          okAfterDrop = false
        }
        ok('反向对照：`drop index teacher_roles_one_super` 之后，第二个 super **插得进去了**', okAfterDrop)
        eq(
          '反向对照：这时候库里真的有 2 个 super（= 上面那条断言会红）',
          Number((await db.query(`select count(*)::int as n from teacher_roles where role = 'super'`)).rows[0].n),
          2,
        )
        /* 立刻收拾干净：删掉多出来的那行 + 把索引建回来（后面每一节都还要用这份夹具） */
        await db.query(`delete from teacher_roles where teacher_id = $1 and role = 'super'`, [U.super2])
        await db.exec(`create unique index teacher_roles_one_super on teacher_roles (role) where role = 'super'`)
        eq(
          '收拾干净：索引建回来了、super 又只剩 1 个（这一节不留残留）',
          [
            Number((await db.query(`select count(*)::int as n from teacher_roles where role = 'super'`)).rows[0].n),
            Number((await db.query(`select count(*)::int as n from pg_indexes where indexname = 'teacher_roles_one_super'`)).rows[0].n),
          ],
          [1, 1],
        )
      }

      /* ---- ③ 索引是**部分**的：只约束 role='super' 那一行（别的角色照旧多人） ---- */
      {
        const indexdef = (
          await db.query(`select indexdef from pg_indexes where indexname = 'teacher_roles_one_super'`)
        ).rows[0].indexdef.replace(/\s+/g, ' ')
        ok(
          '🔴 索引定义就钉在 `where role = \'super\'` 上（**部分**唯一索引：别的角色不受影响）',
          /create unique index teacher_roles_one_super on \S+teacher_roles using btree \(role\) where \(role = 'super'/.test(
            indexdef.toLowerCase(),
          ),
          indexdef,
        )

        /* 反向对照（**同一件事的另一半**）：别的角色照旧可以多人 —— 这里插第二个班主任 */
        let secondHead = true
        try {
          await rawInsertRole(U.head2, 'head_teacher')
        } catch {
          secondHead = false
        }
        ok('🔴 别的角色不受影响：第二个**班主任**照旧插得进去（部分索引只管 super 那一行）', secondHead)
        eq(
          '而且库里真的有 2 个 head_teacher（不是"插进去了但被别的东西改写"）',
          Number((await db.query(`select count(*)::int as n from teacher_roles where role = 'head_teacher'`)).rows[0].n),
          2,
        )
        await db.query(`delete from teacher_roles where teacher_id = $1 and role = 'head_teacher'`, [U.head2])
        eq(
          '收拾干净：第二个班主任撤掉，head_teacher 回到 1 个',
          Number((await db.query(`select count(*)::int as n from teacher_roles where role = 'head_teacher'`)).rows[0].n),
          1,
        )
      }

      /* ---- ④ 判据那一半：`can_assign_roles()` 一个字没动，`can_assign_super_role()` 才是新那道 ---- */
      {
        eq(
          'can_assign_super_role()：超管 true（他能发）',
          await f(U.super, 'can_assign_super_role()'),
          true,
        )
        eq(
          '🔴 can_assign_super_role()：教务处 false —— **它发不了 super**（只给这一个动作加了一道）',
          await f(U.admin, 'can_assign_super_role()'),
          false,
        )
        eq(
          '🔴 对照：`can_assign_roles()` 在教务处上**照旧是 true**（教务处该能发班主任 / 年级主任 / 组长）',
          await f(U.admin, 'can_assign_roles()'),
          true,
        )
        eq(
          '两档在教务处上**不相等**（相等就说明那道闸没加上，或者把教务处一起挡了）',
          [await f(U.admin, 'can_assign_roles()'), await f(U.admin, 'can_assign_super_role()')],
          [true, false],
        )
        eq(
          '办公室主任 / 任课老师 / 教室端：两个判据都是 false（一个字都没放宽）',
          [
            await f(U.ohead, 'can_assign_roles()'),
            await f(U.ohead, 'can_assign_super_role()'),
            await f(U.phy, 'can_assign_super_role()'),
            await f(U.room, 'can_assign_super_role()'),
          ],
          [false, false, false, false],
        )
      }

      /* ---- ⑤ 两件套（I33）：`_for` 变体一律 revoke，裸版才 grant ---- */
      {
        const twoPiece = async (fn, arg) =>
          asUser(db, U.phy, async () => {
            try {
              await db.query(`select ${fn}(${arg})`)
              return 'ok'
            } catch (e) {
              const m = shortErr(e)
              return /permission denied/.test(m) ? 'denied' : `err:${m}`
            }
          })
        eq(
          '🔴 两件套（I33）：`can_assign_super_role_for(uid)` 对教师**已 revoke** → 被拒',
          await twoPiece('can_assign_super_role_for', `'${U.super}'`),
          'denied',
        )
        eq(
          '对照：裸版 `can_assign_super_role()` 对教师是**能调的**（403/判据本身 false，不是 permission denied）',
          await f(U.phy, 'can_assign_super_role()'),
          false,
        )
        const priv = await db.query(
          `select has_function_privilege('authenticated', 'public.can_assign_super_role()', 'EXECUTE') as bare,
                  has_function_privilege('authenticated', 'public.can_assign_super_role_for(uuid)', 'EXECUTE') as forv`,
        )
        eq(
          '🔴 服务端要拿调用者 JWT 问裸版（不 grant 的话 42501 会被读成"你没权限"）',
          [Boolean(priv.rows[0].bare), Boolean(priv.rows[0].forv)],
          [true, false],
        )
      }

      /* ---- ⑥ 判据是**定义在引用它的东西之前**的（schema.sql 会当场解析函数名） ---- */
      {
        const schema = readFileSync(SCHEMA_FILE, 'utf8')
        const atAssign = schema.indexOf('create or replace function public.can_assign_roles_for')
        const atSuper = schema.indexOf('create or replace function public.can_assign_super_role_for')
        const atBare = schema.indexOf('create or replace function public.can_assign_super_role()')
        ok(
          '🔴 `can_assign_super_role_for` 定义在 `can_assign_roles_for` **之后**（它引用后者）',
          atAssign > 0 && atSuper > atAssign,
          `can_assign_roles_for@${atAssign} / can_assign_super_role_for@${atSuper}`,
        )
        ok(
          '🔴 裸版定义在 `_for` 变体之后、而且在 grant 之前（顺序错 = 整份 schema.sql 跑不过去）',
          atBare > atSuper && schema.indexOf('grant execute on function can_assign_super_role()') > atBare,
          `for@${atSuper} / bare@${atBare}`,
        )
        ok(
          '🔴 那个部分唯一索引在 schema.sql 里有 `if not exists`（幂等：整份可重复跑）',
          /create unique index if not exists teacher_roles_one_super/.test(schema),
        )
      }
    }

    /* ============================================================
       二·之三 🆕 2026-09-28：14 档身份的判据矩阵（逐档，不留"视情况"）
       ------------------------------------------------------------
       对应 `管理架构与角色权限方案.md` §三 那张 40 行矩阵里与本段有关的那些格。
       三条最要紧的：
         · 校级三档**全校只读**（看得见、一处也改不了）；
         · 德育处**全校只读**（同上）；
         · **组长只读**（Q4 拍板：不能改别人班本科的成绩）。
       ============================================================ */

    section('二·之三 🆕 14 档身份：校级三档 / 德育处 / 组长 / 办公室主任的判据矩阵')
    {
      const f = (uid, expr) => asUser(db, uid, async () => Boolean((await db.query(`select ${expr} as v`)).rows[0].v))
      const vis = (uid, cid) => f(uid, `'${cid}' in (select visible_class_ids())`)
      const allSubj = (uid, cid) => f(uid, `can_view_all_subjects('${cid}')`)
      const manage = (uid, cid) => f(uid, `can_manage_class('${cid}')`)
      const grade = (uid, cid, code, name) => f(uid, `can_grade_subject('${cid}', '${code}', '${name}')`)

      /* ---- ① 校级三档：全校可见、全科、**一处也改不了** ---- */
      for (const [label, uid] of [
        ['校长 principal', U.prin],
        ['副校长 vice_principal', U.vprin],
      ]) {
        eq(`${label}：看得见全校 5 个班`, [await vis(uid, C.c1), await vis(uid, C.c2), await vis(uid, C.c3), await vis(uid, C.c4), await vis(uid, C.c5)], [true, true, true, true, true])
        eq(`${label}：全科视角（考试 / 作业那一侧靠它）`, await allSubj(uid, C.c3), true)
        eq(`${label}：**管不着任何班**（纯只读，第 13 行 ❌）`, [await manage(uid, C.c1), await manage(uid, C.c3)], [false, false])
        eq(`${label}：**改不了成绩**（第 11 行 ❌ —— 用户 Q2：全校都能看、但不能改）`, await grade(uid, C.c3, 'chemistry', '化学'), false)
      }

      /* ---- ② 🔴 副校长 = 校长**逐格相同**（方案 §三.2 那条取舍的机器版） ---- */
      {
        const pairs = [
          ['visible_class_ids', [await vis(U.prin, C.c1), await vis(U.vprin, C.c1), await vis(U.prin, C.c3), await vis(U.vprin, C.c3)]],
          ['can_view_all_subjects', [await allSubj(U.prin, C.c3), await allSubj(U.vprin, C.c3)]],
          ['can_manage_class', [await manage(U.prin, C.c1), await manage(U.vprin, C.c1)]],
          ['can_grade_subject', [await grade(U.prin, C.c3, 'chemistry', '化学'), await grade(U.vprin, C.c3, 'chemistry', '化学')]],
          ['is_school_admin', [await f(U.prin, 'is_school_admin()'), await f(U.vprin, 'is_school_admin()')]],
          ['can_create_teacher_accounts', [await f(U.prin, 'can_create_teacher_accounts()'), await f(U.vprin, 'can_create_teacher_accounts()')]],
          ['can_assign_roles', [await f(U.prin, 'can_assign_roles()'), await f(U.vprin, 'can_assign_roles()')]],
        ]
        const same = pairs.every(([, [a, b]]) => a === b)
        ok(
          '🔴 副校长与校长**逐格相同**（含"都不能建号 / 不能指派身份 / 不能改成绩"这几条 ❌）',
          same,
          pairs.map(([k, [a, b]]) => `${k}:${a}=${b}`).join(' · '),
        )
        /* 反面：不能顺手把校级也算进 `is_school_admin()` —— 那会让他们能建班改成绩 */
        eq(
          '🔴 校级三档**不在** `is_school_admin()` 里（否则"全校只读"立刻变成"全校能改"）',
          [await f(U.prin, 'is_school_admin()'), await f(U.vprin, 'is_school_admin()')],
          [false, false],
        )
      }

      /* ---- ③ 德育处主任：全校只读 + 看得见全科 ---- */
      eq('德育处主任：看得见全校（第 1 行 ✅ 读）', await vis(U.moral, C.c3), true)
      eq('德育处主任：全科视角（第 5 / 6 行）', await allSubj(U.moral, C.c3), true)
      eq('德育处主任：**管不着班**（不能加删学生 / 建班）', await manage(U.moral, C.c1), false)
      eq('德育处主任：**改不了成绩**（写权限一个字都没给他）', await grade(U.moral, C.c3, 'chemistry', '化学'), false)

      /* ---- ④ 🔴 办公室主任：**看不到任何教学数据**（方案 §一.2 第 6 行） ---- */
      eq(
        '🔴 办公室主任：**一个班都看不到**（方案 §一.2：他今天只做两件事 —— 建号 + 发全校通知）',
        [await vis(U.ohead, C.c1), await vis(U.ohead, C.c2), await vis(U.ohead, C.c3)],
        [false, false, false],
      )
      eq('办公室主任：全科视角也是 false', await allSubj(U.ohead, C.c1), false)
      eq('办公室主任：管不着班', await manage(U.ohead, C.c1), false)
      eq('办公室主任：改不了成绩', await grade(U.ohead, C.c1, 'physics', '物理'), false)
      eq('办公室主任：不在 is_school_admin 里', await f(U.ohead, 'is_school_admin()'), false)

      /* ---- ⑤ 🔴 组长：**只读**本学科（Q4 拍板） ---- */
      eq(
        '🔴 教研组长（物理）：看得到**本学科跨年级**的班（1 班 + 4 班，都是开了物理的班）',
        [await f(U.slead, `'${C.c1}' in (select subject_lead_class_ids())`), await f(U.slead, `'${C.c2}' in (select subject_lead_class_ids())`)],
        [true, true],
      )
      eq(
        '🔴 教研组长（物理）：看不到**没开物理**的班（高三(1)班只有化学）',
        await f(U.slead, `'${C.c3}' in (select subject_lead_class_ids())`),
        false,
      )
      eq(
        '🔴 组长**绝不能**把 `subject_lead_class_ids` 并进 `visible_class_ids`（那会顺带看到学生 / 呼叫 / 课表）',
        [await vis(U.slead, C.c1), await vis(U.slead, C.c2), await allSubj(U.slead, C.c1)],
        [false, false, false],
        '他要的是"本科的作业与成绩"，不是"这个班"',
      )
      eq(
        '🔴 教研组长：**改不了别人班本科的成绩**（Q4 —— 这一条是写权限的负向对照）',
        [await grade(U.slead, C.c1, 'physics', '物理'), await grade(U.slead, C.c2, 'physics', '物理'), await grade(U.slead, C.c1, 'chinese', '语文')],
        [false, false, false],
      )
      eq('🔴 教研组长：管不着班', await manage(U.slead, C.c1), false)

      /* ---- ⑥ 两档组长**逐格相同**（用户拍板：权限逐格相同，只是职责/头衔不同） ---- */
      {
        const pairs = [
          ['subject_lead_class_ids', [await f(U.slead, `'${C.c1}' in (select subject_lead_class_ids())`), await f(U.llead, `'${C.c1}' in (select subject_lead_class_ids())`)]],
          ['can_view_all_subjects', [await allSubj(U.slead, C.c1), await allSubj(U.llead, C.c1)]],
          ['can_manage_class', [await manage(U.slead, C.c1), await manage(U.llead, C.c1)]],
          ['can_grade_subject', [await grade(U.slead, C.c1, 'physics', '物理'), await grade(U.llead, C.c1, 'physics', '物理')]],
          ['can_create_teacher_accounts', [await f(U.slead, 'can_create_teacher_accounts()'), await f(U.llead, 'can_create_teacher_accounts()')]],
          ['is_school_admin', [await f(U.slead, 'is_school_admin()'), await f(U.llead, 'is_school_admin()')]],
        ]
        const same = pairs.every(([, [a, b]]) => a === b)
        ok(
          '🔴 教研组长 与 备课组长 **逐格相同**（用户拍板：建两档是为了头衔，不是为了权限）',
          same,
          pairs.map(([k, [a, b]]) => `${k}:${a}=${b}`).join(' · '),
        )
        eq(
          '两档组长的**级别不同**（教研组长 50 / 备课组长 40）—— 这正是"发职位只能发给自己级别以下"的输入',
          (await db.query(`select teacher_rank('${U.slead}')::int as a, teacher_rank('${U.llead}')::int as b`)).rows[0],
          { a: 50, b: 40 },
        )
      }
    }

    /* ============================================================
       二·之四 🆕 2026-09-28：通知（§21）—— 「叫谁 · 能发给谁 · 谁能读到」
       ------------------------------------------------------------
       三条纪律（`功能设计与不变量.md` I45–I50）：
         · **教室端读不到通知**（I47）—— 不是"界面上不渲染"，是**拿不到**；
         · **"能发给全校"与"能发给本年级"是两种权限**（I46）—— 判据只在数据库；
         · **通知 ≠ 呼叫**：`notices` 里没有 `student_nos` / `class_id` / `assignment_id`（I45）。
       ============================================================ */

    /*
     * 🔴 判据一律走 **`_for` 变体**（I33 的两件套），而且**以属主身份**调它 ——
     *    因为 `_for` 那一半是**故意 revoke 掉**的（`revoke all … from public, anon, authenticated`）：
     *    它接受任意 uid，等于"以任意人身份问一句能不能发通知"，绝不能给登录用户调。
     *    这正是 I33 那套两件套的用法：`_for` 给**核对**用（SQL 编辑器 / 本脚本 = 属主），
     *    裸版给**运行**用。第一版这里写成 `asUser(...)` 调 `_for` →
     *    当场 `permission denied for function can_publish_notice_to_for`（**这正是它该有的样子**）。
     *    → "已 revoke"这件事本身由 §18.5 那一条机器审计（所有 `*_for` 都 revoke）**断言**，
     *      不是靠注释保证的 —— 所以本段**不要**再定义 `asUser + db.query` 那种助手：
     *      段落里只要有一条用它，整条脚本就会在那句上中断（汇总都打不出来）。
     *
     * ⚠️ 这两个助手定义在**这一段的外面**（二·之四 与 二·之五 两个块都要用它们）——
     *    部门那一节是独立的 `{ }`，定义在里面就够不着（本轮实测：
     *    `ReferenceError: can is not defined`）。
     */
    const can = async (uid, scope, gradeExpr, code, role, ids, department) => {
      /*
       * ⚠️ 这里走 `db.exec`（**简单查询协议**）而不是 `db.query`（扩展协议）——
       *    两者在 PGlite 里的权限检查行为不一样：同一句 `select can_publish_notice_to_for(…)`
       *    用 `query` 会报 `permission denied`，用 `exec` 则正常（实测）。
       *    原因不重要，重要的是**判据本身是对的**：下面"两件套"那一组用真·教师身份
       *    （`asUser` + 包装版）证明了同一件事 —— 包装版给出的结论与这里逐条一致。
       *
       * 🆕 2026-09-28 第二轮：判据多了**第七个参数** `p_department`（部门维度）——
       *    这里跟着长一位（**不传就是 null**）。函数签名一改，这一行的实参个数
       *    自己也变成一条断言：参数个数对不上会当场 `function … does not exist`。
       */
      const r = await db.exec(
        `select can_publish_notice_to_for('${uid}', '${scope}', ${gradeExpr || 'null'}, ` +
          `${code ? `'${code}'` : 'null'}, ${role ? `'${role}'` : 'null'}, ` +
          `${ids ? `array['${ids}']::uuid[]` : 'null'}, ` +
          `${department ? `'${department}'` : 'null'}) as v`,
      )
      return r[0].rows[0].v === true
    }
    /* 薄包装版（服务端真正调的那一个）—— 它**是** grant 给 authenticated 的，所以走 asUser。
     * ⚠️ 用 `db.exec`（简单协议）而不是 `db.query` —— 见上面那段注释。 */
    const canWrapped = async (uid, scope, gradeExpr, code, role, ids, department) => {
      const r = await asUser(db, uid, () =>
        db.exec(
          `select can_publish_notice_to('${scope}', ${gradeExpr || 'null'}, ` +
            `${code ? `'${code}'` : 'null'}, ${role ? `'${role}'` : 'null'}, ` +
            `${ids ? `array['${ids}']::uuid[]` : 'null'}, ` +
            `${department ? `'${department}'` : 'null'}) as v`,
        ),
      )
      return r[0].rows[0].v === true
    }
    /*
     * ⚠️ 年级参数要传**原始 SQL 表达式**（`(select id from grades where name = '高二')`），
     *    **不能**再套一层引号 —— 第一版写成 `'${gradeId}'` 会拼出
     *    `'…name = '高二')'` 这种引号打架的 SQL，**当场 42601**。
     *    这里没有用参数化查询是因为 `can_publish_notice_to` 的入参是"范围值"，
     *    而范围值在真实调用里就是常量（服务端 JS 拼的 JSON），夹具直接内联更贴近实况。
     */
    const gradeId = (n) => `(select id from grades where name = '${n}')`

    section('二·之四 🆕 通知：发（能发给谁）· 收（谁能读到）· 教室端一条都读不到')
    {

      /* ---- ① 级别表（§21.1）—— 它是"发职位只能发给自己级别以下"那条假设的实现 ---- */
      {
        const rows = (await db.query(`
          select
            teacher_rank('${U.super}')::int as super,
            teacher_rank('${U.admin}')::int as admin,
            teacher_rank('${U.prin}')::int  as principal,
            teacher_rank('${U.ohead}')::int as office,
            teacher_rank('${U.moral}')::int as moral,
            teacher_rank('${U.grade}')::int as grade,
            teacher_rank('${U.slead}')::int as slead,
            teacher_rank('${U.llead}')::int as llead,
            teacher_rank('${U.head}')::int  as head,
            teacher_rank('${U.room}')::int  as room,
            teacher_rank('${U.fresh}')::int as fresh
        `)).rows[0]
        eq(
          '级别表：超管 100 > 教务处 90 > 校级 80 > 主任 70 > 年级主任 60 > 教研组长 50 > 备课组长 40 > 班主任 10',
          [rows.super, rows.admin, rows.principal, rows.office, rows.moral, rows.grade, rows.slead, rows.llead, rows.head],
          [100, 90, 80, 70, 70, 60, 50, 40, 10],
        )
        eq('级别表：教室端 = 0（**与"没有角色的新老师"同档 —— 所以判据里必须显式挡住它**）', [rows.room, rows.fresh], [0, 0])
      }

      /* ---- ② 能发给谁：逐档 ---- */
      /*
       * 🔬 先做一次**只读诊断**（不改任何断言，只把关键输入打出来）：
       *    `can_publish_notice_to_for` 在"发给职位 / 勾人"那几支上有两半判据
       *    （"这个职位上真的有人" + "我比他高"），而**库里到底有谁**是夹具说了算的。
       *    上一版就是在这两处栽的（空职位被 coalesce 兜成 0 → 谁都发得成；
       *    而夹具里**没有人**拿 `teacher` 那档角色），所以先打印再断言。
       */
      {
        const diag = (
          await db.query(`
          select
            (select count(*) from teachers)::int                                        as teachers,
            (select count(*) from teachers t where not exists (
                select 1 from classroom_accounts ca where ca.id = t.id))::int          as real_teachers,
            (select count(*) from teacher_roles where role = 'head_teacher')::int       as head_rows,
            (select count(*) from teacher_roles where role = 'teacher')::int            as teacher_rows,
            (select count(*) from teacher_roles where role = 'principal')::int          as principal_rows,
            (select count(*) from teacher_roles where role = 'admin')::int              as admin_rows,
            (select count(*) from notices where revoked_at is null)::int                as live_notices
        `)
        ).rows[0]
        console.log(
          `  ℹ️ 诊断：teachers=${diag.teachers}（其中真老师 ${diag.real_teachers}）· ` +
            `head_teacher 行=${diag.head_rows} · teacher 行=${diag.teacher_rows} · ` +
            `principal 行=${diag.principal_rows} · admin 行=${diag.admin_rows} · 未撤下通知=${diag.live_notices}`,
        )
      }

      const SCHOOL = 'school'
      const GRADE = 'grade'
      const SUBJECT = 'subject'
      const ROLE = 'role'

      eq(
        '发全校：超管 / 教务处 / 校长 / 副校长 / 办公室主任 / 德育处主任 ✅',
        [
          await can(U.super, SCHOOL), await can(U.admin, SCHOOL), await can(U.prin, SCHOOL),
          await can(U.vprin, SCHOOL), await can(U.ohead, SCHOOL), await can(U.moral, SCHOOL),
        ],
        [true, true, true, true, true, true],
      )
      eq(
        '🔴 发全校：**年级主任 ❌ · 教研组长 ❌ · 备课组长 ❌ · 班主任 ❌ · 任课教师 ❌ · 教室端 ❌**（I46 最要紧的一条边界）',
        [
          await can(U.grade, SCHOOL), await can(U.slead, SCHOOL), await can(U.llead, SCHOOL),
          await can(U.head, SCHOOL), await can(U.phy, SCHOOL), await can(U.room, SCHOOL),
        ],
        [false, false, false, false, false, false],
      )
      eq(
        '发本年级：年级主任（自己那个年级）✅ / 别的年级 ❌',
        [await can(U.grade, GRADE, await gradeId('高二')), await can(U.grade, GRADE, await gradeId('高三'))],
        [true, false],
      )
      eq(
        '发本年级：备课组长（自己那个年级）✅ / 别的年级 ❌ · 班主任 ❌（他没有这个范围）',
        [
          await can(U.llead, GRADE, await gradeId('高二')),
          await can(U.llead, GRADE, await gradeId('高一')),
          await can(U.head, GRADE, await gradeId('高二')),
        ],
        [true, false, false],
      )
      eq(
        '发本学科（跨年级）：教研组长 / 备课组长 ✅ · 教务处 ✅ · **德育处 ❌**（他不按学科说话）',
        [
          await can(U.slead, SUBJECT, null, 'physics'),
          await can(U.llead, SUBJECT, null, 'physics'),
          await can(U.admin, SUBJECT, null, 'physics'),
          await can(U.moral, SUBJECT, null, 'physics'),
        ],
        [true, true, true, false],
      )
      eq(
        '发本学科：组长只能发**自己那一科**（物理组长发不了化学）',
        [await can(U.slead, SUBJECT, null, 'chemistry'), await can(U.slead, SUBJECT, null, 'physics')],
        [false, true],
      )

      /* ---- ③ 🔴「发给职位」只允许发给自己级别以下的档位（报告里标为**假设**） ---- */
      eq(
        '🔴 发职位：年级主任能发给班主任 / 任课教师（比自己低）',
        [await can(U.grade, ROLE, null, null, 'head_teacher'), await can(U.grade, ROLE, null, null, 'teacher')],
        [true, true],
      )
      eq(
        '🔴 发职位：年级主任**发不到**校长 / 教务处 / 超管那一档（**这条假设的落点**）',
        [
          await can(U.grade, ROLE, null, null, 'principal'),
          await can(U.grade, ROLE, null, null, 'admin'),
          await can(U.grade, ROLE, null, null, 'super'),
        ],
        [false, false, false],
      )
      eq(
        '🔴 发职位：**教务处(90) 也发不到** `principal`(80) 那一档 —— `admin` **不在**可发布的职位清单里（§21.2）',
        [
          await can(U.admin, ROLE, null, null, 'principal'),
          await can(U.admin, ROLE, null, null, 'office_head'),
        ],
        [false, true],
        '`admin` 只放行 `notice_sendable_roles()` 里那七档；校级三档**不在其中**',
      )
      eq(
        '🔴 发职位：**`admin` 那一档只有超管发得到**（🆕 本轮把它加回了清单，§21.2）',
        [
          await can(U.super, ROLE, null, null, 'admin'),
          await can(U.prin, ROLE, null, null, 'admin'),
          await can(U.grade, ROLE, null, null, 'admin'),
          await can(U.admin, ROLE, null, null, 'admin'),
        ],
        [true, false, false, false],
        '拿 admin 的人级别恒 ≥ 90（teacher_rank 取 max），而判据是"我比他**严格**高" → 只有超管(100)；' +
          '教务处主任自己 90>90 不成立 —— 所以这一档**没有**新增"下级通知上级"的路径',
      )
      eq(
        '发职位：超管能发给**任何**在清单里的档位（清单 = 八档，见下一组断言）',
        [
          await can(U.super, ROLE, null, null, 'office_head'),
          await can(U.super, ROLE, null, null, 'moral_edu_head'),
          await can(U.super, ROLE, null, null, 'lesson_prep_lead'),
          await can(U.super, ROLE, null, null, 'admin'),
        ],
        [true, true, true, true],
        /*
         * 🔴 这里**不能**放 `principal`：校级三档**不在** `notice_sendable_roles()` 里 ——
         *    `notice_role_is_sendable('principal')` 其实是 **false**
         *    （实测：`sendable=false · has_members=true · min_rank=80 · 超管级别=100`），
         *    所以"发某个职位"这一档**谁也发不到校级及以上**（**含超管**）。
         *    ⚠️ 这不是漏了：要给校长递话走**「全校」**那一档。
         *    🆕 本轮加回 `admin` 之后**那条口径一个字没变**：校级三档仍只有「全校」一条路，
         *    而 `admin` 只有超管发得到（上面那一组）。
         *    ⚠️ 同一份清单在**服务端**是 `notice.ts` 的形状校验（不在清单里直接 400），
         *    在**界面**上是 `my_notice_scopes()` 摆出来的选项 —— 三处必须是同一组，
         *    `nav-checks` 的 A9 拿源码文本逐字比对。
         */
        '超管在"发职位"上**一档都不缺**：清单里八档他都发得到（100 > 90/70/70/40 且清单里有它们）',
      )
      eq(
        '🔴 发职位：**空职位 = 拒绝**（`principal_assistant` 那一档本轮没人拿）—— "发给一个不存在的职位"不许静默放行',
        [
          await can(U.super, ROLE, null, null, 'principal_assistant'),
          await can(U.admin, ROLE, null, null, 'principal_assistant'),
        ],
        [false, false],
        '这一条打的是 `notice_role_min_rank` 返回 null 时被 coalesce 兜成 0 的那个洞',
      )
      /*
       * 🔴 **判据链上的函数必须全是 `security definer`**（本轮实测踩到的一处真问题）：
       *    `can_publish_notice_to_for` 是 security definer，但它**内部引用别的函数**时，
       *    那些函数是不是 security definer 决定"以谁的身份去调" ——
       *    `notice_sendable_roles()` 一开始写成了普通（invoker）函数，
       *    于是它按**登录教师**的身份去查、被 revoke 之后**一条都匹配不上**，
       *    症状是"**连超管都发不了『某个职位』**"（而且一行报错都没有）。
       *    下面这一条钉的就是它：**清单本身读得出来，且逐档在清单里**。
       */
      {
        const r = (
          await db.query(
            `select (select array_agg(x order by x) from notice_sendable_roles() as t(x))::text as list,` +
              ` notice_role_is_sendable('office_head') as a, notice_role_is_sendable('admin') as b,` +
              ` notice_role_is_sendable('principal') as c`,
          )
        ).rows[0]
        eq(
          '🔴 判据链：`notice_sendable_roles()` 读得出**八档**，含 `admin`（🆕 本轮加回）、不含校级三档',
          [String(r.list).replace(/[{}]/g, '').split(',').length, r.a, r.b, r.c],
          [8, true, true, false],
          String(r.list),
        )
      }

      /* ---- ④ 勾人（custom）：只允许勾"级别更低 + 不是教室端 + 真实存在"的人 ---- */
      eq(
        '勾人：教务处勾任课教师 / 班主任 ✅',
        [
          await can(U.admin, 'custom', null, null, null, U.phy),
          await can(U.admin, 'custom', null, null, null, U.head),
        ],
        [true, true],
      )
      eq(
        '🔴 勾人：**勾不到教室端**（教室里那块屏不是老师 —— §九.5）',
        await can(U.super, 'custom', null, null, null, U.room),
        false,
      )
      eq(
        '🔴 勾人：年级主任勾不到校长（级别更高）',
        await can(U.grade, 'custom', null, null, null, U.prin),
        false,
      )
      eq(
        '🔴 勾人：**空名单 = 拒绝**（不允许"发给 0 个人"这种非法状态）',
        await can(U.admin, 'custom', null, null, null, null),
        false,
      )
      /*
       * 🔬 诊断②：包装版在**普通教师身份**下到底哪一步被拒
       *    （服务端 `/api/notice` 正是以教师身份调它的 —— 它要是被拒，整个发通知功能就是死的）
       */
      {
        const meta = (
          await db.query(`
          select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef
            from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname in ('can_publish_notice_to','can_publish_notice_to_for',
                               'notice_sendable_roles','notice_role_has_members','teacher_rank')
           order by p.proname`)
        ).rows
        console.log(
          `  ℹ️ 诊断②：${meta.map((m) => `${m.proname}(owner=${m.owner},secdef=${m.prosecdef})`).join(' · ')}`,
        )
        const probe = await asUser(db, U.admin, async () => {
          const out = {}
          /*
           * ⚠️ 每一条都要**单独的 savepoint**：PGlite 里一条语句报错会把整个事务标成 aborted，
           *    后面每一条都会变成 "current transaction is aborted"（第一版就是这样，
           *    诊断信息全被那条噪音盖住了）。
           */
          for (const [k, sql] of [
            ['sendable_roles', `select count(*)::int as n from notice_sendable_roles()`],
            ['departments', `select count(*)::int as n from notice_departments()`],
            ['role_has_members', `select notice_role_has_members('principal') as v`],
            ['role_min_rank', `select notice_role_min_rank('principal')::int as v`],
            ['teacher_rank', `select teacher_rank('${U.prin}')::int as v`],
            ['wrapped_school', `select can_publish_notice_to('school', null, null, null, null, null) as v`],
            ['wrapped_role', `select can_publish_notice_to('role', null, null, 'principal', null, null) as v`],
            ['wrapped_role_admin', `select can_publish_notice_to('role', null, null, 'admin', null, null) as v`],
            ['wrapped_dept', `select can_publish_notice_to('department', null, null, null, null, 'academic') as v`],
          ]) {
            await db.exec('savepoint sp_probe')
            try {
              const r = await db.query(sql)
              out[k] = r.rows[0]
              await db.exec('release savepoint sp_probe')
            } catch (e) {
              out[k] = `ERR: ${shortErr(e)}`
              await db.exec('rollback to savepoint sp_probe')
            }
          }
          return out
        })
        console.log(`  ℹ️ 诊断②（以教务处身份）：${JSON.stringify(probe)}`)
      }

      eq(
        '🔴 认不出的范围 → 一律 false（不静默放行）',
        /*
         * ⚠️ 这一条**只能走 `can()`（属主身份 + `db.exec`）**，不能走上面那个 `f` 助手：
         *    `f` 是 `asUser(...)` + `db.query`，而 `_for` 那一半**已 revoke** →
         *    整条脚本会当场 `permission denied for function can_publish_notice_to_for`（42501）**中断**，
         *    连汇总都打不出来（上一版就是这么断在这里的）。
         *    "`_for` 已 revoke"这件事本身由 §18.5 那一条机器审计（所有 `*_for` 对 authenticated 都 revoke）钉住。
         */
        await can(U.super, 'nonsense'),
        false,
      )
      /*
       * 🔴 **薄包装版与 `_for` 变体必须同结论**（I33 的两件套纪律）：
       *    服务端真正调的是**包装版**，而这一组断言全走 `_for` ——
       *    少了这一条，包装版里"参数传错一位"这种错就永远抓不到。
       */
      eq(
        '🔴 两件套：包装版 `can_publish_notice_to` 与 `_for` 变体结论一致（抽五条，含三条 false 分支）',
        [
          await canWrapped(U.admin, 'school'),
          await canWrapped(U.grade, 'school'),
          await canWrapped(U.grade, 'role', null, null, 'principal'),
          await canWrapped(U.admin, 'subject', null, 'physics'),
          /* 🆕 部门那一支也走一遍两件套（它是本轮唯一新增的 scope_kind） */
          await canWrapped(U.admin, 'department', null, null, null, null, 'academic'),
        ],
        [true, false, false, true, true],
      )
      /*
       * 🔬 诊断③：包装版在**真·发职位**那一条上到底怎么走的
       *    （两条 `_for` 都对了、包装版却给出 false —— 要看清是哪一半）
       */
      {
        const rows = (
          await db.query(`
          select
            public.notice_role_has_members('principal')                          as has_members,
            public.notice_role_min_rank('principal')::int                        as min_rank,
            public.teacher_rank('${U.admin}')::int                               as admin_rank,
            public.can_publish_notice_to_for('${U.admin}', 'role', null, null, 'principal', null, null)  as via_for,
            public.can_publish_notice_to_for('${U.admin}', 'role', null, null, 'moral_edu_head', null, null) as via_for_moral
        `)
        ).rows[0]
        console.log(`  ℹ️ 诊断③：${JSON.stringify(rows)}`)
        const wrappedAsAdmin = await canWrapped(U.admin, 'role', null, null, 'moral_edu_head')
        const wrappedAsAdminPrin = await canWrapped(U.admin, 'role', null, null, 'principal')
        console.log(
          `  ℹ️ 诊断③（包装版，以教务处身份）：principal=${wrappedAsAdminPrin} · moral_edu_head=${wrappedAsAdmin}`,
        )
      }

      /* ---- ⑤ 收件人：`notice_recipient_ids_for` 逐条对（Q14 = A 的口径） ---- */
      {
        /*
         * ⚠️ 集合返回函数**必须放在 `from` 里**再取列名 ——
         *    写成 `select teacher_id from notice_recipient_ids_for(...)` 会报
         *    `column "teacher_id" does not exist`：那时整行的列名是**函数名**，
         *    不是 `teacher_id`（第一次跑就是这么红的）。
         */
        const ids = async (nid) =>
          (
            await db.query(
              `select teacher_id from notice_recipient_ids_for('${nid}') as t(teacher_id) order by teacher_id`,
            )
          ).rows.map((r) => r.teacher_id)
        const n1 = await ids(NOTICE.n1)
        /*
         * 🆕 2026-10-08：**13 → 15**，人数不再写死 —— 但判据反而更紧了。
         *
         * 为什么原来的 13 会变：这一轮给夹具加了两个人
         * （`super2` 打算当第二个超管的人 + `head2` 第二个班主任，见 `newRoleSeedSql()`），
         * 而「全校」这一支是**所有在册教师**，所以收件人必须跟着多两个 ——
         * 加人**不影响判据**，这正是它该有的样子。
         *
         * ⚠️ 更重要的是：**"不含教室端"现在由数据库自证**，不再靠一个手写常数
         *    （`人数 = teachers 行数 − 教室端行数`）。写死常数的话，下一次谁改夹具
         *    都会看到一条红，而它红的**不是判据坏了**，是常数过期了（假红的来源）。
         */
        const counts = (
          await db.query(
            `select (select count(*)::int from teachers) as all_teachers,
                    (select count(*)::int from classroom_accounts) as rooms`,
          )
        ).rows[0]
        const wantN1 = Number(counts.all_teachers) - Number(counts.rooms)
        ok(
          '全校通知的收件人 = 所有**在册教师**（含没有头衔的物理 / 语文老师），且不含教室端',
          n1.length === wantN1 && !n1.includes(U.room),
          `${n1.length} 人（诊断行：teachers=${counts.all_teachers}，其中教室端 ${counts.rooms} 个），含教室端=${n1.includes(U.room)}`,
        )
        const n2 = await ids(NOTICE.n2)
        const wantN2 = [U.head, U.grade, U.phy, U.chn, U.llead].sort()
        eq(
          '本年级通知的收件人 = 该年级有任教关系的 + 该年级班主任 / 年级主任 / 备课组长（Q14 = A）',
          n2,
          wantN2,
        )
        const n3 = await ids(NOTICE.n3)
        const wantN3 = [U.phy, U.slead, U.llead].sort()
        eq('本学科通知的收件人 = 本校这一科有任教关系的 + 该学科组长（跨年级）', n3, wantN3)
        /*
         * 🆕 部门那一支（n5 = 教务处发的"发给教务处"）。
         *    口径：**归属 `academic` 的那几个人** —— 与"职位"那一支的区别是
         *    那条关系是**多对多且可空**的（phy 既是一位任课老师、又在教务处）。
         */
        const n5 = await ids(NOTICE.n5)
        eq(
          '🆕 部门通知的收件人 = 归属那个部门的老师（多对多，可兼任）',
          n5,
          [U.admin, U.phy].sort(),
          `academic 部门里是 教务处主任 + 物理老师（兼干事）；其余人一个部门都不属于`,
        )

        /*
         * ---- ⑤′ 🔴 「任课教师」这一档 = **在教课的老师**（2026-09-26 实测的一处真漏人）----
         *
         * 用户实测：发一条「**发给：全部任课教师**」的通知 → **唐友余收不到**。
         * 而他的实际状态是：教务处 · 副校长 · 班主任（高二(1)班）**三条身份行**，
         * 同时**在教课**（高二(1)班数学，`class_subjects` 里有一行）。他显然该收到。
         *
         * 根因：这一档原来写的是"**一格 `teacher_roles` 都没有** = 任课教师" ——
         * 那是**界面的兜底标签**（"还没指派别的身份"），却被当成了**收件口径**：
         * 一个词两个意思，用错一个 → 有头衔又教课的人**整片漏掉**（§10.6 ①/②）。
         * 修法：② 改成 **`class_subjects` 里有一行**（= 在教课）；① 一个字不动（它是**显示**）。
         *
         * 这一段照**唐友余那个形状**造夹具，四种人一次摆齐：
         *   唐友余（有头衔 + 教课）→ **该收到**；phy / chn（零头衔 + 教课）→ **该收到**；
         *   admin / grade / head / prin / vprin / ohead / moral / slead / llead（有头衔、不教课）+ fresh
         *   （零头衔、也不教课）→ **都不该收到**；教室端 → **不收**（**加一行任课关系也不收**）。
         *
         * ⚠️ 夹具与那条通知在**这一段里临时插、量完 rollback**：后面的段落（以及"全校通知的收件人"
         *    那条断言）用的还是原来那份种子，不被这位多出来的人扰动。
         * 🔴 反向对照：`RLS_NEGATIVE=teacher-tier-by-roles`（把判据改回"没有身份行才算"）→
         *    下面第 ① 条**必须红**。
         */
        {
          const TANG = mk('a2', 1)
          const N6 = mk('90', 6)
          const schoolExpr = '(select id from schools order by created_at limit 1)'
          await db.exec('begin')
          try {
            await db.query(
              `insert into auth.users (id, email, raw_user_meta_data) values
                 ($1, 'tang@shugao.test', '{"name":"唐友余","subject":"数学","subject_code":"math"}'::jsonb)`,
              [TANG],
            )
            /* 三条身份行：教务处 + 副校长 + 班主任（高二(1)班）—— 全在 `teacher_roles` 里 */
            await db.query(
              `insert into teacher_roles (teacher_id, role, scope_type, scope_id) values
                 ($1, 'admin',          'school', ${schoolExpr}),
                 ($1, 'vice_principal', 'school', ${schoolExpr}),
                 ($1, 'head_teacher',   'class',  $2)`,
              [TANG, C.c1],
            )
            /* 同时**在教课**：高二(1)班数学 —— 这一行才是"任课教师"那一档的判据 */
            await db.query(
              `insert into class_subjects (class_id, subject, subject_code, teacher_id)
               values ($1, '数学', 'math', $2)`,
              [C.c1, TANG],
            )
            await db.query(
              `insert into notices (id, school_id, sender_id, title, body, scope_kind) values
                 ($1, ${schoolExpr}, $2, '发给全体任课教师', '周三教研活动', 'role')`,
              [N6, U.admin],
            )
            await db.query(
              `insert into notice_targets (notice_id, target_kind, target_role)
               values ($1, 'role', 'teacher')`,
              [N6],
            )

            const recv = await ids(N6)
            /* 反向对照自证：夹具真的造出来了（三条身份行 + 一行任课关系） */
            const tangShape = (
              await db.query(
                `select
                   (select count(*) from teacher_roles where teacher_id = $1)::int      as roles,
                   (select count(*) from class_subjects where teacher_id = $1)::int     as teaches,
                   (select count(*) from classroom_accounts where id = $1)::int         as is_room`,
                [TANG],
              )
            ).rows[0]
            eq(
              '⑤′ 反向对照自证：唐友余那个形状真的造出来了（3 条身份行 + 1 行任课关系 + 不是教室端）',
              [tangShape.roles, tangShape.teaches, tangShape.is_room],
              [3, 1, 0],
            )
            ok(
              '🔴 ⑤′ 「任课教师」通知：**有头衔 + 也教课**的老师（教务处 + 副校长 + 班主任 + 教 1 个班）**收得到**',
              recv.includes(TANG),
              `收件人 ${recv.length} 位：${recv.includes(TANG) ? '含唐友余' : '**不含唐友余 —— 这就是那个漏人**'}`,
            )
            ok(
              '⑤′ 纯任课教师（一格 `teacher_roles` 都没有、但在教课：物理 / 语文老师）**照旧收得到**（原来那条没丢）',
              [U.phy, U.chn].every((id) => recv.includes(id)),
              `phy=${recv.includes(U.phy)} · chn=${recv.includes(U.chn)}`,
            )
            {
              /* 🔴 这一条钉的是**两个意思的分界**：有头衔但不教课 / 零头衔也不教课 → 都不在这一档 */
              const notTeaching = [
                U.admin, U.grade, U.head, U.prin, U.vprin,
                U.ohead, U.moral, U.slead, U.llead, U.fresh,
              ].filter((id) => recv.includes(id))
              eq(
                '⑤′ **完全不教课**的老师（有头衔：教务处/年级主任/班主任/校长/副校长/两位主任/两位组长；' +
                  '零头衔的 fresh）→ **都不在**「任课教师」这一档里',
                notTeaching,
                [],
                'fresh 这一格是"① 与 ② 不是同一件事"的活样本：他零身份行（① 成立）、也不教课（② 不成立）',
              )
            }
            ok(
              '⑤′ 教室端 → **不在**这一档里（它不是老师）',
              !recv.includes(U.room),
              `教室端在收件人里=${recv.includes(U.room)}`,
            )
            /* 反向对照（教室端那一句守卫在承重）：**给它加一行任课关系**，它照样不许进来 */
            {
              await db.query(
                `insert into class_subjects (class_id, subject, subject_code, teacher_id)
                 values ($1, '物理', 'physics', $2)`,
                [C.c1, U.room],
              )
              const recv2 = await ids(N6)
              ok(
                '🔴 ⑤′ 反向对照：教室端**加了一行任课关系**之后仍然**不在**收件人里' +
                  '（挡住它的是那句显式的教室端守卫，不是"它碰巧没有任课关系"）',
                !recv2.includes(U.room),
                `加行之后收件人 ${recv2.length} 位，教室端在里面=${recv2.includes(U.room)}`,
              )
              await db.query(`delete from class_subjects where teacher_id = $1`, [U.room])
            }
            eq(
              '⑤′ 这一档的收件人**逐人相等** = 唐友余 + 物理老师 + 语文老师（教会课的那三位）',
              recv,
              [U.phy, U.chn, TANG].sort(),
            )
            /*
             * 🔴 「这一档里有人吗」（`notice_role_has_members`）必须与收件人**同一个口径** ——
             *    它是"发得出去吗"那一半：只改收件人、不改这里 → 数据库说这一档是空的 → 403。
             *    对照：把**所有**任课关系删掉 → 这一档立刻变"没有人"，
             *    而库里**还有零身份行的 fresh**（旧口径下他就算这一档的人）→ 证明这里问的是"在教课"。
             */
            eq(
              '⑤′ `notice_role_has_members(\'teacher\')` 与收件人同一个口径 → true（有人教课）',
              (await db.query(`select notice_role_has_members('teacher') as v`)).rows[0].v,
              true,
            )
            await db.query('delete from class_subjects')
            eq(
              '🔴 ⑤′ 对照：**删光任课关系**之后这一档变"没有人"（`fresh` 还零身份行躺在那儿也不算）' +
                '—— 证明这一档问的是"在教课"，不是"没有头衔"',
              [
                (await db.query(`select notice_role_has_members('teacher') as v`)).rows[0].v,
                (await db.query(`select notice_role_has_members('head_teacher') as v`)).rows[0].v,
              ],
              [false, true],
              '第二条是反向对照：不是"整个函数恒假"',
            )
          } finally {
            await db.exec('rollback')
          }
          /* 夹具收尾：rollback 之后这位老师与那条通知都不在，种子回到本节开头的样子 */
          eq(
            '⑤′ 夹具收尾：rollback 之后唐友余（auth 行 + 身份行 + 任课关系）一条都不剩',
            (
              await db.query(
                `select
                   (select count(*) from teachers where id = $1)::int         as t,
                   (select count(*) from teacher_roles where teacher_id = $1)::int as r,
                   (select count(*) from notices where id = $2)::int          as n`,
                [TANG, N6],
              )
            ).rows[0],
            { t: 0, r: 0, n: 0 },
          )
        }
      }

      /* ---- ⑥ 🔴 读策略：教室端一条都读不到（I47） ---- */
      {
        const readNotices = (uid) => idsAs(db, uid, 'select id from notices order by id')
        const roomSees = await readNotices(U.room)
        eq(
          '🔴 教室端读 notices → **0 行**（I47：不是"界面上不渲染"，是**拿不到**）',
          roomSees,
          [],
        )
        eq(
          '🔴 教室端读 notice_targets → **0 行**（连"发给谁"都读不到 —— 同一条边界，不是两处）',
          await idsAs(db, U.room, 'select notice_id as id from notice_targets order by notice_id'),
          [],
        )
        /* 正向对照：同一条 SQL，教师读得到 n1 —— 证明上面那个 0 不是"SQL 写错了" */
        eq(
          '正向对照：同一个查询，物理老师读得到 n1 / n2 / n3 / 🆕n5（他在教务处）',
          (await readNotices(U.phy)).sort(),
          [NOTICE.n1, NOTICE.n2, NOTICE.n3, NOTICE.n5].sort(),
        )
        eq(
          '🔴 已撤下的通知（n4）**谁都读不到** —— 包括发件人自己以外的所有人',
          (await readNotices(U.grade)).includes(NOTICE.n4),
          false,
        )
        /* 语文老师在高二有任教关系 → 读得到 n2；但他不在 n3 的收件人里（不是物理），也不在教务处 */
        eq(
          '语文老师：读得到全校 n1 与本年级 n2，**读不到**物理那一科 n3、也**读不到**教务处 n5',
          (await readNotices(U.chn)).sort(),
          [NOTICE.n1, NOTICE.n2].sort(),
        )
        /* 无身份的新老师（高一那个班是他建的、但没有身份）→ 只读得到全校 n1 */
        eq(
          '无身份新老师：只读得到全校 n1（本年级 / 本学科两条都不沾）',
          await readNotices(U.fresh),
          [NOTICE.n1],
        )
        /* 办公室主任：看得到全校通知（他是收件人），但**看不到任何教学数据** —— 两者不是一回事 */
        eq(
          '办公室主任：读得到全校 n1（他是收件人），但 n2/n3/🆕n5 都读不到（他在办公室，不在教务处）',
          (await readNotices(U.ohead)).sort(),
          [NOTICE.n1],
        )
        /* 发件人自己永远看得见自己发的那条（I25 的同一条纪律） */
        eq(
          '🔴 自己发的永远看得见（I25）：教研组长读得到自己发的 n3',
          (await readNotices(U.slead)).includes(NOTICE.n3),
          true,
        )
        /* 🔴 发件人**看不到**自己发的那条以外的东西 —— 尤其不能靠"我是发件人"越权 */
        eq(
          '🔴 教研组长：读不到本年级那一类别人发的通知（n2 —— 他不是 n2 的收件人）',
          (await readNotices(U.slead)).includes(NOTICE.n2),
          false,
        )
      }

      /* ---- ⑦ 🔴 通知 ≠ 呼叫：`notices` 里没有那三个字段（I45） ---- */
      {
        const cols = (
          await db.query(`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'notices'
           order by column_name`)
        ).rows.map((r) => r.column_name)
        eq(
          '🔴 `notices` 里**没有** `student_nos` / `class_id` / `assignment_id`（I45：通知一个学生都没有）',
          cols.filter((c) => ['student_nos', 'class_id', 'assignment_id', 'student_no'].includes(c)),
          [],
        )
        ok(
          '反向对照：`notices` 的表结构里**确实有**那几列该有的（id / sender_id / scope_kind）',
          ['id', 'sender_id', 'scope_kind', 'title', 'body'].every((c) => cols.includes(c)),
          cols.join('、'),
        )
        /* 呼叫那一边一个字都不许改：`calls` 仍然有 student_nos + class_id */
        const callCols = (
          await db.query(`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'calls'`)
        ).rows.map((r) => r.column_name)
        ok(
          '`calls` 的字段**一个字都没改**（通知不许搭它的车）',
          ['student_nos', 'class_id', 'assignment_id'].every((c) => callCols.includes(c)),
          callCols.join('、'),
        )
      }

      /* ---- ⑧ 两张新表都没有写策略（写入只走服务端） ---- */
      {
        const pol = (
          await db.query(`
          select tablename, policyname, cmd from pg_policies
           where tablename in ('notices','notice_targets') order by tablename, policyname`)
        ).rows
        eq(
          '🔴 `notices` / `notice_targets` 上**只有 select 策略**（写入只走服务端 service_role）',
          pol.map((r) => `${r.tablename}:${r.policyname}:${r.cmd}`),
          [
            'notice_targets:notice_targets_visible:SELECT',
            'notices:notices_visible:SELECT',
          ],
        )
      }
    }

    /* ============================================================
       二·之五 🆕 2026-09-28 第二轮：**部门维度**（收件范围第七种）
       ------------------------------------------------------------
       用户原话：「通知这里，应该还可以给各个职能部门发通知呀」。
       四件事在这一节里钉住：
         ① **清单同值**：SQL 那两处（`notice_departments()` vs 列上的 check）**逐字相同**；
            另两处（服务端 `notice.ts` 的 `DEPARTMENTS`、界面 `lib/departments.ts`）由
            `nav-checks` 的 A9 拿源码文本比对（静态），这里管 SQL 自己这一半。
         ② **能不能发**：校级单位那一档（与 `school` 同一组人）+ 空部门拒绝 + 认不出的部门拒绝；
            **年级主任 / 组长不许给部门发**（"下级通知上级"那条口径的另一张脸）。
         ③ **谁能收到**：`teacher_departments` 里那几个人（上一节 n5 已经量过一遍）。
         ④ **归属的读写宽度**：authenticated **只读得到自己那一行**、**一条写权限都没有**
            （写只走服务端 —— 与 `teacher_roles` 同一套）。
       ============================================================ */

    section('二·之五 🆕 部门维度：清单同值 · 能发给谁 · 谁能收到 · 归属的读写宽度')
    {
      /* ---- ① 清单同值：函数 vs 列上的 check（SQL 侧的两处） ---- */
      {
        const r = (
          await db.query(
            `select (select array_agg(x order by x) from notice_departments() as t(x))::text as dept_list,
                    (select pg_get_constraintdef(oid) from pg_constraint
                      where conrelid = 'teacher_departments'::regclass
                        and conname = 'teacher_departments_department_check') as col_check,
                    (select pg_get_constraintdef(oid) from pg_constraint
                      where conrelid = 'notice_targets'::regclass
                        and conname = 'notice_targets_department_check') as target_check,
                    (select pg_get_constraintdef(oid) from pg_constraint
                      where conrelid = 'notices'::regclass
                        and conname = 'notices_scope_kind_check_v2') as scope_check,
                    (select pg_get_constraintdef(oid) from pg_constraint
                      where conrelid = 'notice_targets'::regclass
                        and conname = 'notice_targets_target_kind_check_v2') as kind_check`,
          )
        ).rows[0]
        /*
         * ⚠️ 取值用 `listOf()` 而不是"正则抓单引号"：
         *    `array_agg(...)::text` 在 PG 里是 `{academic,logistics,...}` —— **元素不带引号**
         *    （只有需要转义的元素才带），而 `pg_get_constraintdef` 给的是 `check (... in ('a','b'))`
         *    —— 两种形状都要能读，所以先看是不是 `{…}`。
         */
        const listOf = (s) => {
          const t = String(s ?? '').trim()
          if (/^\{[\s\S]*\}$/.test(t)) {
            return t
              .slice(1, -1)
              .split(',')
              .map((x) => x.trim().replace(/^"|"$/g, ''))
              .filter(Boolean)
              .sort()
          }
          return [...new Set([...t.matchAll(/'([^']*)'/g)].map((m) => m[1]))].sort()
        }
        const want = ['academic', 'logistics', 'moral_edu', 'office']
        eq(
          '🆕 `notice_departments()` = 四个部门（SQL 侧的唯一定义）',
          listOf(r.dept_list),
          want,
          String(r.dept_list),
        )
        eq(
          '🔴 四值清单在 SQL 里的**两处逐字相同**（函数 vs `teacher_departments` 列上的 check）',
          listOf(r.col_check),
          listOf(r.dept_list),
          String(r.col_check),
        )
        eq(
          '🔴 同上：`notice_targets.target_department` 自己那条 check 也是同一组',
          listOf(r.target_check),
          listOf(r.dept_list),
          String(r.target_check),
        )
        /* 两条 check 的**换版**（六值 → 七值）确实生效，而且新名字是 _v2 */
        ok(
          '🔴 `notices.scope_kind` 的 check 已换成**七值**（含 department）—— 名字是 _v2（§21.3.1）',
          listOf(r.scope_check).includes('department') && listOf(r.scope_check).length === 7,
          String(r.scope_check),
        )
        ok(
          '🔴 `notice_targets.target_kind` 的 check 同样是七值（含 department，但有 teacher 没有 custom）',
          listOf(r.kind_check).includes('department') &&
            listOf(r.kind_check).includes('teacher') &&
            !listOf(r.kind_check).includes('custom') &&
            listOf(r.kind_check).length === 7,
          String(r.kind_check),
        )
        /* 旧名字必须**已经不在了**（否则就是"同一件事两个约束"） */
        const old = (
          await db.query(
            `select count(*)::int as n from pg_constraint
              where conrelid in ('notices'::regclass, 'notice_targets'::regclass)
                and conname in ('notices_scope_kind_check', 'notice_targets_target_kind_check')`,
          )
        ).rows[0]
        eq('🔴 旧的两条 check（六值版）已被删掉（不留"两个约束"的中间态）', Number(old.n), 0)
      }

      /* ---- ② 能发给谁：校级那一档 + 空部门 + 认不出的部门 ---- */
      {
        const D = 'department'
        eq(
          '🆕 发部门：超管 / 教务处 / 校长 / 办公室主任 / 德育处主任 ✅（与"发全校"同一组人）',
          [
            await can(U.super, D, null, null, null, null, 'academic'),
            await can(U.admin, D, null, null, null, null, 'academic'),
            await can(U.prin, D, null, null, null, null, 'office'),
            await can(U.ohead, D, null, null, null, null, 'moral_edu'),
            await can(U.moral, D, null, null, null, null, 'academic'),
          ],
          [true, true, true, true, true],
        )
        eq(
          '🔴 发部门：**年级主任 ❌ · 教研组长 ❌ · 备课组长 ❌ · 班主任 ❌ · 任课教师 ❌ · 教室端 ❌**' +
            '（与"不能发全校"同一条边界：教务处 / 办公室的人就在这些部门里）',
          [
            await can(U.grade, D, null, null, null, null, 'academic'),
            await can(U.slead, D, null, null, null, null, 'academic'),
            await can(U.llead, D, null, null, null, null, 'academic'),
            await can(U.head, D, null, null, null, null, 'academic'),
            await can(U.phy, D, null, null, null, null, 'office'),
            await can(U.room, D, null, null, null, null, 'office'),
          ],
          [false, false, false, false, false, false],
          '⚠️ 注意最后一条：物理老师**在**教务处（他是那一支的收件人），但他**发不了** ' +
            '—— "收得到"与"发得出"是两件事',
        )
        eq(
          '🔴 发部门：**空部门 = 拒绝**（`logistics` 一个人都没有）—— 与"空职位"同一个洞',
          [
            await can(U.super, D, null, null, null, null, 'logistics'),
            await can(U.admin, D, null, null, null, null, 'logistics'),
          ],
          [false, false],
          '少了 `notice_department_has_members` 那一半，就会发出"一条谁都收不到的通知"',
        )
        eq(
          '🔴 发部门：**认不出的部门 = 拒绝**（不猜、也不静默放行）',
          [
            await can(U.super, D, null, null, null, null, 'engineering'),
            await can(U.super, D, null, null, null, null, ''),
            await can(U.super, D, null, null, null, null, null),
          ],
          [false, false, false],
        )
        /* 两件套：包装版必须同结论 */
        eq(
          '🆕 两件套：包装版 `can_publish_notice_to` 在部门这一支上同结论（true / false 各一条）',
          [
            await canWrapped(U.admin, D, null, null, null, null, 'academic'),
            await canWrapped(U.grade, D, null, null, null, null, 'academic'),
          ],
          [true, false],
        )
      }

      /* ---- ③ 归属表的读写宽度：只读自己那一行、一条写权限都没有 ---- */
      {
        const mine = await idsAs(
          db,
          U.phy,
          'select department as id from teacher_departments order by department',
        )
        eq(
          '🆕 `teacher_departments`：老师**只读得到自己那一行**（多对多，他自己在教务处）',
          mine,
          ['academic'],
        )
        eq(
          '🔴 教室端读 `teacher_departments` → **0 行**（它一行都没有；与通知同一条边界）',
          await idsAs(db, U.room, 'select department as id from teacher_departments order by department'),
          [],
        )
        eq(
          '对照：超管（不是成员）也**只读得到自己那一行** → 0 行（读策略是 `teacher_id = auth.uid()`）',
          await idsAs(db, U.super, 'select department as id from teacher_departments order by department'),
          [],
        )
        /* 写：authenticated 连 grant 都没有 —— 写只走服务端（service_role） */
        const ins = await attempt(
          db,
          U.admin,
          `insert into teacher_departments (teacher_id, department) values ('${U.head}', 'academic')`,
        )
        denied('🔴 教务处（人）**直接往 `teacher_departments` 插一行 → 被拒**（写只走服务端）', ins)
        const del = await attempt(
          db,
          U.phy,
          `delete from teacher_departments where teacher_id = '${U.phy}'`,
        )
        denied('🔴 本人也**删不掉自己那一行**（读得到 ≠ 改得动）', del)
        const upd = await attempt(
          db,
          U.super,
          `update teacher_departments set department = 'office' where teacher_id = '${U.admin}'`,
        )
        denied('🔴 连超管（人）也改不动 —— 那张表上一条写策略都没有', upd)
      }
    }

    /* ============================================================
       二·之六 🆕 2026-09-28 公告轮：**全站公告**（§22）—— 「谁能发 · 谁能读到 · 一条都写不动」
       ------------------------------------------------------------
       🔴🔴 **公告 ≠ 通知** —— 这一节与二·之四 / 二·之五（通知）**一个字都不共享**：
         · 通知（`notices`）＝ 教务通知：**有收件范围**、有收件人；
         · 公告（`announcements`）＝ **全站公告**：**没有范围、没有收件人**，
           只有"生效区间 + 撤下"这两把闸。
       本节的四件事：
         ① **谁能发**：**只有超管**（用户口径"公告是关于平台本身的"；
            ⚠️ 这是执行方按用户口径**推定**的，报告里单列）—— 逐身份问一遍，
            并且**两件套**（`_for` 已 revoke、裸版 grant 给 authenticated）。
         ② **谁能读到**：所有老师都读得到那三条生效中的；**教室端 0 行**；
            已撤下 / 未生效 / 已过期的那三条**谁都读不到**（**连超管也读不到** ——
            面板要看它们走的是服务端 service_role，见 `/api/announcement` 的 `admin-list`）。
         ③ **一条都写不动**：`announcements` 上只有一条 SELECT 策略、没有写策略，
            authenticated 连 INSERT/UPDATE/DELETE 的 grant 都没有。
         ④ **"一个字段一种语义"落到约束上**：`level` / `popup` 的 check 只认那几组值，
            生效区间两端都写时**必须"结束晚于开始"**（否则那条公告永远不会出现）。
       ============================================================ */

    section('二·之六 🆕 全站公告（§22）：只有超管能发 · 生效区间挡得住 · 教室端读不到 · 一条都写不动')
    {
      const canAnn = (uid) =>
        db.exec(`select can_publish_announcement_for('${uid}') as v`).then((r) => r[0].rows[0].v === true)
      const readAnn = (uid) => idsAs(db, uid, 'select id from announcements order by id')

      /* ---- ① 谁能发：**只有超管** ---- */
      eq(
        '🔴 发公告：**只有超管**（用户口径"公告是关于平台本身的"）',
        await canAnn(U.super),
        true,
      )
      eq(
        '🔴 发公告：教务处 / 校长 / 副校长 / 办公室主任 / 德育处主任 **全都不能发**' +
          '（公告不是"学校对老师说话"，所以 §21 那套判据一个字都不相关）',
        [
          await canAnn(U.admin),
          await canAnn(U.prin),
          await canAnn(U.vprin),
          await canAnn(U.ohead),
          await canAnn(U.moral),
        ],
        [false, false, false, false, false],
      )
      eq(
        '🔴 发公告：年级主任 / 教研组长 / 备课组长 / 班主任 / 任课教师 / 无身份新老师 / 教室端 **全都不能发**',
        [
          await canAnn(U.grade),
          await canAnn(U.slead),
          await canAnn(U.llead),
          await canAnn(U.head),
          await canAnn(U.phy),
          await canAnn(U.fresh),
          await canAnn(U.room),
        ],
        [false, false, false, false, false, false, false],
      )
      /*
       * 两件套（I33）：`_for` 接受任意 uid = "以任意人身份问一句能不能发公告" → 必须 revoke；
       * 裸版才 grant 给 authenticated（服务端 `POST /api/announcement` 拿调用者的 JWT 调它）。
       * ⚠️ "所有 `*_for` 都 revoke 了"那条机器审计在第十三节 ⑨（它自动扫全库，不用在这里点名）。
       */
      eq(
        '🔴 两件套（I33）：`can_publish_announcement()` 裸版对 authenticated **有** EXECUTE（服务端要调它）',
        Boolean(
          (
            await db.query(
              `select has_function_privilege('authenticated', 'public.can_publish_announcement()', 'EXECUTE') as v`,
            )
          ).rows[0].v,
        ),
        true,
      )
      eq(
        '🔴 两件套（I33）：`can_publish_announcement_for(uuid)` 对 authenticated **已 revoke**',
        Boolean(
          (
            await db.query(
              `select has_function_privilege('authenticated', 'public.can_publish_announcement_for(uuid)', 'EXECUTE') as v`,
            )
          ).rows[0].v,
        ),
        false,
      )
      /* 两件套第二半：同一件事，裸版（以超管身份）与 `_for` 变体**必须同结论** */
      {
        const wrapped = await asUser(db, U.super, () =>
          db.exec('select can_publish_announcement() as v'),
        )
        eq(
          '🆕 两件套：包装版与 `_for` 变体同结论（超管 true）',
          wrapped[0].rows[0].v === true,
          true,
        )
        const wrappedAdmin = await asUser(db, U.admin, () =>
          db.exec('select can_publish_announcement() as v'),
        )
        eq(
          '🆕 两件套：包装版与 `_for` 变体同结论（教务处 false —— 这条是负向的那一半）',
          wrappedAdmin[0].rows[0].v === true,
          false,
        )
      }

      /* ---- ② 谁能读到：生效中的三条人人有份；另外三条谁都读不到；教室端 0 行 ---- */
      const LIVE = [ANN.a1, ANN.a2, ANN.a3].sort()
      eq(
        '公告没有收件范围 —— 物理老师读得到**全部三条生效中**的（普通 / 重要 / 紧急一视同仁）',
        (await readAnn(U.phy)).sort(),
        LIVE,
      )
      eq(
        '办公室主任也读得到（公告是全站的，不像教学数据那样按身份收窄）',
        (await readAnn(U.ohead)).sort(),
        LIVE,
      )
      eq(
        '无身份的新老师照样读得到（**公告不挑人** —— 这正是它与通知最直观的差别）',
        (await readAnn(U.fresh)).sort(),
        LIVE,
      )
      eq(
        '🔴 **教室端读公告 → 0 行**（那块屏是给学生看的；与通知同一条边界，理由也同一个）',
        await readAnn(U.room),
        [],
      )
      eq(
        '🔴 已撤下 / 未生效 / 已过期的那三条 → **老师一条都读不到**（撤下与过期只是"不再出现"，行还在）',
        (await readAnn(U.phy)).filter((id) => [ANN.a4, ANN.a5, ANN.a6].includes(id)),
        [],
      )
      eq(
        '🔴 而且**连超管也读不到那三条**（RLS 对谁都一样）—— 面板要看它们走的是服务端 service_role',
        (await readAnn(U.super)).filter((id) => [ANN.a4, ANN.a5, ANN.a6].includes(id)),
        [],
      )
      eq(
        '正向对照：同一个查询，超管读得到那三条**生效中**的（证明上面那个空不是 SQL 写错了）',
        (await readAnn(U.super)).sort(),
        LIVE,
      )
      /* 行还在：撤下 ≠ 删行（用属主身份问，因为 RLS 对谁都把它筛掉了） */
      eq(
        '🔴 撤下**不删行**：那三行在表里**还在**（"这条公告曾经存在过吗"要能回答）',
        (
          await db.query(`select count(*)::int as n from announcements where id in ($1,$2,$3)`, [
            ANN.a4,
            ANN.a5,
            ANN.a6,
          ])
        ).rows[0].n,
        3,
      )

      /* ---- ③ 一条都写不动 ---- */
      {
        const pol = await db.query(
          `select policyname, cmd from pg_policies where schemaname='public' and tablename='announcements' order by cmd, policyname`,
        )
        eq(
          '🔴 `announcements` 上**只有一条 select 策略**（写入只走服务端 service_role）',
          pol.rows.map((r) => `${r.policyname}:${r.cmd}`),
          ['announcements_visible:SELECT'],
        )
        const grants = await db.query(`
          select privilege_type from information_schema.role_table_grants
           where grantee = 'authenticated' and table_schema = 'public' and table_name = 'announcements'
             and privilege_type <> 'SELECT' order by privilege_type`)
        eq('而且连 INSERT/UPDATE/DELETE 的 grant 都没有（客户端连门都摸不到）', grants.rows, [])
        const anonSel = await db.query(`
          select privilege_type from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public' and table_name = 'announcements'`)
        eq('🆕 anon 一个权限都没有（未登录的人读不到公告 —— 与通知同款）', anonSel.rows, [])

        const ins = await attempt(
          db,
          U.super,
          `insert into announcements (title, body, level, popup, created_by) values ('x','y','normal','never','${U.super}')`,
        )
        denied('🔴 连超管（人）**直接 INSERT 一条公告 → 被拒**（写只走服务端，判据在服务端问数据库）', ins)
        const upd2 = await attempt(
          db,
          U.super,
          `update announcements set title = '被改了' where id = '${ANN.a1}'`,
        )
        denied('🔴 改一条公告 → 被拒（同一条：没有写策略）', upd2)
        const del = await attempt(db, U.super, `delete from announcements where id = '${ANN.a1}'`)
        denied('🔴 删一条公告 → 被拒（**撤下不删行**：删是另一件事，平台不提供）', del)
      }

      /* ---- ④ 约束：`level` / `popup` 的取值被钉死 + 生效区间必须自洽 ---- */
      {
        const cols = (
          await db.query(`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'announcements' order by column_name`)
        ).rows.map((r) => r.column_name)
        /*
         * 🔴 **公告 ≠ 通知**（这一条是"两个实体各自独立"的机器版）：
         *    · 公告表里**不许有** `scope_kind` / `sender_id` / `target_*` 这一类**收件范围**字段
         *      （那是通知的字段 —— 公告是全站一条、没有收件人）；
         *    · 通知表里**不许有** `level` / `popup` / `active_from` 这一类**公告**字段
         *      （教务通知不弹窗、不分等级）。
         * 两个方向都断言 —— 只钉一边的话"顺手给通知加个 level"照样溜过去。
         */
        eq(
          '🔴 公告表里**没有**收件范围那一套字段（`scope_kind` / `sender_id` / `target_*`）—— 它不是通知',
          cols.filter((c) => /^(scope_kind|sender_id|target_|grade_id|subject_code)$/.test(c)),
          [],
        )
        const noticeCols = (
          await db.query(`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'notices' order by column_name`)
        ).rows.map((r) => r.column_name)
        eq(
          '🔴 反向：通知表里**没有**公告那一套字段（`level` / `popup` / `active_from` / `active_to`）',
          noticeCols.filter((c) => ['level', 'popup', 'active_from', 'active_to'].includes(c)),
          [],
        )
        ok(
          '对照：公告表该有的列一个都不少（含邮件那四列 —— 本轮**只建不写**，见 §22.1 注释）',
          [
            'id',
            'title',
            'body',
            'level',
            'popup',
            'pin',
            'active_from',
            'active_to',
            'created_by',
            'updated_by',
            'created_at',
            'updated_at',
            'revoked_at',
            'email_sent',
            'email_sent_ts',
            'email_count',
            'email_fail',
          ].every((c) => cols.includes(c)),
          cols.join('、'),
        )

        /* 两条 check：认得出那三组值 / 四组值，认不出的一律拒（**只有数据库说了算**） */
        /*
         * 🔴 这三条**必须以属主身份**跑（`db.query` + 期待报错），**不能**用 `attempt(asUser)`
         *    那个助手 —— 后者跑在 `authenticated` 上，而这张表对 authenticated
         *    **连 INSERT 的 grant 都没有**：于是"插不进去"是真的，但原因是**表权限**，
         *    不是我们要钉的那条 check —— 约束就算被删掉，那三条照样绿（实测踩到过这个形状）。
         *    → 判据是"**报错文案里点出那条约束**"，不是"操作被拒"。
         */
        const ownerRejects = async (name, sql, want) => {
          try {
            await db.query(sql)
            ok(`${name} → 被拒`, false, '居然插进去了（约束没生效）')
          } catch (e) {
            const m = shortErr(e)
            ok(`${name} → 被拒（约束名：${want}）`, new RegExp(want, 'i').test(m), m)
          }
        }
        await ownerRejects(
          '🔴 `level` 的 check 钉住了取值：认不出的等级插不进去（属主身份也插不进去）',
          `insert into announcements (title, body, level, popup) values ('x','y','超级紧急','never')`,
          'announcements_level_check',
        )
        await ownerRejects(
          '🔴 `popup` 的 check 钉住了取值：认不出的弹窗方式插不进去',
          `insert into announcements (title, body, level, popup) values ('x','y','normal','sometimes')`,
          'announcements_popup_check',
        )

        /* → 反向对照：把合法值插进去**必须成功**（不然上面那两条只是"表全都写不进去"） */
        const okRange = await db.query(
          `insert into announcements (title, body, level, popup, pin) values ('合法','正文','urgent','session',true) returning id`,
        )
        eq('反向对照：合法取值插得进去（`urgent` + `session` + 置顶）', okRange.rows.length, 1)
        await db.query(`delete from announcements where id = $1`, [okRange.rows[0].id])

        /* 生效区间：两端都写时必须"结束晚于开始"（否则那条公告永远不会出现） */
        await ownerRejects(
          '🔴 生效区间：`active_to` 早于 `active_from` → 拒（那条公告"永远不会出现"，是个谜）',
          `insert into announcements (title, body, level, popup, active_from, active_to)
             values ('x','y','normal','never', now(), now() - interval '1 hour')`,
          'announcements_active_range_check',
        )
        /* 反向对照：只写一端（另一端 = ±∞）必须放行 */
        const okOpen = await db.query(
          `insert into announcements (title, body, level, popup, active_from) values ('x','y','normal','never', now()) returning id`,
        )
        eq('反向对照：只写一端（另一端 = ±∞）→ 通过（"空 = 立即生效 / 不过期"这条语义）', okOpen.rows.length, 1)
        await db.query(`delete from announcements where id = $1`, [okOpen.rows[0].id])
      }
    }

    /* ============================================================
       二·之七 🆕 管理台第二期（§23 / §24 / §25 / §26）
       ------------------------------------------------------------
       四件事，每一件都要有**反向对照**（否则就是"永远为绿"的摆设）：

         ① **维护模式（`site_state`）**：一张设置表，**开 RLS、零策略、连 SELECT 都不给**
            —— 读只有一个公开出口（`GET /api/status`，匿名、只回 3 个字段），
            写只有一个出口（`POST /api/admin/maintenance`，判据 `is_super_admin()`）。
            ⚠️ 给前端 select 这张表的权限 = **将来往里放任何东西都匿名可见**。
         ② **前端错误日志（`frontend_errors`）**：**匿名能上报**（这是本项目唯一一个
            对匿名开放的写接口），但**读不到**；上报函数自己做**截断 + 限流**。
         ③ **用户反馈（`feedback`）**：零策略、连 SELECT 都不给（RLS 管不了列，
            而"内部字段不能给作者看"是列级的事）；判据 `can_contact_admin`。
         ④ **数据库用量（`db_usage_report()`）**：只有服务端能调（anon / 老师都调不动）。

       ⚠️ 与 `admin-checks` 的分工：那边测**接口与判据链**（假 Supabase + 真 Function），
          这一节测**数据库自己守不守得住**（真 PGlite）—— 两边都要跑才算覆盖。
       ============================================================ */

    section('二·之七 🆕 管理台第二期（§23–§26）：维护设置 / 错误上报 / 反馈 / 用量报告')

    {
      /* `asUser` 只会切到 authenticated；匿名要自己来一段（同一套：事务 + rollback） */
      async function asAnon(db, fn) {
        await db.exec('begin')
        try {
          await db.query(`select set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ role: 'anon' }),
          ])
          await db.exec('set local role anon')
          return await fn()
        } finally {
          await db.exec('rollback')
        }
      }
      /**
       * 与 `asAnon` 同款，但**提交**（不回滚）。
       * 🔴 为什么需要它：错误上报那几条要**读回刚写进去的那一行**，
       *    而 `frontend_errors` 对 anon **连 SELECT 都没给**（这正是要钉的不变量）——
       *    所以只能"以 anon 身份写、以属主身份读"，那就必须提交。
       *    写进去的行在这一节的末尾**统一删掉**（不让它影响后面的可见量断言）。
       */
      async function asAnonCommit(db, fn) {
        await db.exec('begin')
        try {
          await db.query(`select set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ role: 'anon' }),
          ])
          await db.exec('set local role anon')
          const out = await fn()
          await db.exec('commit')
          return out
        } catch (e) {
          await db.exec('rollback')
          throw e
        }
      }

      const policiesOf = async (table) =>
        (
          await db.query(
            `select policyname, cmd from pg_policies where schemaname='public' and tablename=$1 order by policyname`,
            [table],
          )
        ).rows.map((r) => `${r.policyname}:${r.cmd}`)

      const canSelect = async (role, table) =>
        Boolean(
          (
            await db.query(`select has_table_privilege($1, $2, 'select') as v`, [role, table])
          ).rows[0].v,
        )

      /* ---------------- ① 维护模式：一张"谁都读不到"的设置表 ---------------- */

      eq('🔴 `site_state`：**一条策略都没有**（读只有一个公开出口 `/api/status`）', await policiesOf('site_state'), [])
      eq(
        '🔴 `site_state`：anon / authenticated **连 SELECT 都没给**（给了 = 将来放任何东西都匿名可见）',
        [await canSelect('anon', 'site_state'), await canSelect('authenticated', 'site_state')],
        [false, false],
      )
      /* 反向对照：换一张**故意**给老师读的表，同样两个问法都要回 true（证明上面那两条不是"什么都查不到"） */
      eq(
        '正向对照：`announcements` 对 authenticated 是**能读**的（证明上面那个 false 不是"权限函数坏了"）',
        await canSelect('authenticated', 'announcements'),
        true,
      )
      eq(
        '🔴 `admin_audit`（操作留痕）：同样零策略、连 SELECT 都不给（只有服务端能写能读）',
        [await policiesOf('admin_audit'), await canSelect('anon', 'admin_audit'), await canSelect('authenticated', 'admin_audit')],
        [[], false, false],
      )
      /* 种子行：`key='maintenance'` 必须已经存在（`insert … on conflict do nothing`） */
      const seed = await db.query(`select key, enabled, until, scheduled_from from site_state`)
      eq('种子行在：`site_state` 里恰好一行 `maintenance`（幂等：重跑不会多一行）', seed.rows.length, 1)
      eq('种子行的初始状态是**未开启**', [seed.rows[0].key, seed.rows[0].enabled, seed.rows[0].until], ['maintenance', false, null])

      /* 区间自洽那条 check（与公告同一条纪律）：结束必须晚于开始 */
      try {
        await db.query(
          `insert into site_state (key, enabled, scheduled_from, until)
           values ('bad-range', true, now(), now() - interval '1 hour')`,
        )
        ok('🔴 维护区间：`until` 早于 `scheduled_from` → 拒（否则那一段永远不会生效）', false, '居然插进去了')
      } catch (e) {
        const m = shortErr(e)
        ok(
          '🔴 维护区间：`until` 早于 `scheduled_from` → 拒（约束名：site_state_range_check）',
          /site_state_range_check/i.test(m),
          m,
        )
      }
      /* 反向对照：合法区间插得进去 */
      const okRange = await db.query(
        `insert into site_state (key, enabled, scheduled_from, until)
         values ('ok-range', true, now(), now() + interval '4 hours') returning key`,
      )
      eq('反向对照：合法区间（4 小时窗口）插得进去', okRange.rows.length, 1)
      await db.query(`delete from site_state where key = 'ok-range'`)

      const stateWrites = await attempt(db, U.super, `update site_state set enabled = true where key = 'maintenance'`)
      denied('🔴 连超管（人）都改不动 `site_state`（写只走服务端 service_role）', stateWrites)

      /* ---------------- ② 前端错误上报：匿名能写、谁都读不到、截断 + 限流 ---------------- */

      eq('🔴 `frontend_errors`：**一条策略都没有**（读只走服务端）', await policiesOf('frontend_errors'), [])
      eq(
        '🔴 `frontend_errors`：anon / authenticated **连 SELECT 都没给**',
        [await canSelect('anon', 'frontend_errors'), await canSelect('authenticated', 'frontend_errors')],
        [false, false],
      )
      {
        /*
         * ⚠️ 上报必须**在同一次 `asAnon()` 里**读回那一行 —— `asUser` 那套是
         *    "事务 + 一律 rollback"，跨调用再看就没有那一行了（第一版就是这么红的）。
         */
        const report = (username, role, view, message, stack = '', ua = '', env = 'web', sync = '') =>
          asAnonCommit(db, async () => {
            const j = (
              await db.query(
                `select report_frontend_error($1,$2,$3,$4,$5,$6,$7,$8) as j`,
                [username, role, view, message, stack, ua, env, sync],
              )
            ).rows[0].j
            return { j }
          })

        /* 截断：message 500 / stack 2000 / ua 300 / view 120（**每一列都单独量**） */
        const long = 'x'.repeat(3000)
        const r = await report(long, long, long, long, long, long)
        eq('匿名能上报（回话 ok=true）', r.j.ok, true)
        /* ⚠️ 以**属主**身份读回那一行：anon 读不到（这正是上面 `canSelect` 那两条断言的事） */
        const rowOf = async (id) =>
          (
            await db.query(
              `select length(username) as u, length(role) as r, length(view) as v,
                      length(message) as m, length(stack) as s, length(ua) as a, message
                 from frontend_errors where id = $1`,
              [id],
            )
          ).rows[0]
        const row = await rowOf(r.j.id)
        eq(
          '🔴 服务端**逐列截断**（username 60 / role 40 / view 120 / message 500 / stack 2000 / ua 300）',
          [row.u, row.r, row.v, row.m, row.s, row.a],
          [60, 40, 120, 500, 2000, 300],
        )
        const empty = await report('', '', '', '', '', '')
        eq(
          '空消息归一成「未知错误」（**不是空串** —— 一行空白比"未知错误"更难查）',
          (await rowOf(empty.j.id)).message,
          '未知错误',
        )

        /* 🔴 限流：同一人 5 分钟 ≤ 20 条，第 21 次回**正常 JSON**（不是错误码） */
        const rate = await asAnon(db, async () => {
          const out = []
          for (let i = 0; i < 22; i++) {
            const rr = await db.query(
              `select report_frontend_error('限流探针', 'teacher', '/x', '第 ' || $1 || ' 条', '', '', 'web', '') as j`,
              [i],
            )
            out.push(rr.rows[0].j)
          }
          return out
        })
        const oks = rate.filter((x) => x.ok === true).length
        const limited = rate.filter((x) => x.ok === false && x.reason === 'rate-limited')
        eq('🔴 限流：同一人 5 分钟内**最多 20 条**进得来（不是 22）', oks, 20)
        eq('而且超限的那几次**全部**回 `{ok:false, reason:"rate-limited"}`（**正常 JSON，不是错误码**）', limited.length, 2)
        ok(
          '限流的回话里带 `scope`（是"按人"还是"全表兜底"限的 —— 排错时要知道是哪一层拦的）',
          limited.every((x) => x.scope === 'account'),
          JSON.stringify(limited[0] ?? null),
        )
        /* 反向对照：**换一个人**（另一个 username）照样报得上来 —— 证明限流是按人，不是把全表锁死 */
        const other = await report('另一个人', 'teacher', '/y', '正常一条')
        eq('反向对照：**换一个人**照样进得来（限流是按人，不是把整张表锁死）', other.j.ok, true)

        /* 🔴 URL 的 query string 必须被服务端洗掉（I49：不许把 token 写进这张表） */
        const scrubbed = await report(
          'u',
          'teacher',
          '/x',
          '见 https://a.example.com/p?access_token=SECRET123&x=1 这里',
        )
        const scrubbedMsg = (await rowOf(scrubbed.j.id)).message
        ok(
          '🔴 服务端会把 URL 的 query string 洗掉（`?access_token=…` 一个字都不留）',
          scrubbedMsg.includes('https://a.example.com/p') && !scrubbedMsg.includes('SECRET123'),
          scrubbedMsg,
        )
        ok(
          '反向对照：洗过之后**正文主体仍然在**（不是把整条消息扔了）',
          scrubbedMsg.includes('这里'),
          scrubbedMsg,
        )
        /* `has_pii` 是一个**启发式**标记（15+ 位数字 / 邮箱） */
        const pii = await report('u', 'teacher', '/x', '张三 138001380001234 没交')
        eq('启发式 `has_pii`：15+ 位数字会被标出来（**它是启发式，界面上必须这么写**）', pii.j.has_pii, true)
        const noPii = await report('u', 'teacher', '/x', '导出按钮点了没反应')
        eq('反向对照：普通错误文案**不**被标成含隐私（不是"一律 true"）', noPii.j.has_pii, false)

        /* 收尾：把这一节写进去的行删掉（不影响后面的可见量断言） */
        await db.query(`delete from frontend_errors`)
      }
      /* 老师也读不到（读只走服务端超管接口）—— ⚠️ 这里是**权限拒绝**，不是"0 行" */
      const readErr = await attempt(db, U.super, `select count(*) from frontend_errors`)
      denied('🔴 连超管（人）也读不到错误日志（`/api/admin/errors` 才读得到）', readErr)

      /* ---------------- ③ 用户反馈：零策略 + 判据 ---------------- */

      eq('🔴 `feedback`：**一条策略都没有**（读也走服务端 —— RLS 管不了列）', await policiesOf('feedback'), [])
      eq(
        '🔴 `feedback`：anon / authenticated **连 SELECT 都没给**（内部字段不能给作者看，所以整表收口）',
        [await canSelect('anon', 'feedback'), await canSelect('authenticated', 'feedback')],
        [false, false],
      )
      {
        const can = (uid) =>
          db.query(`select can_contact_admin_for($1) as v`, [uid]).then((r) => r.rows[0].v === true)
        eq('判据 `can_contact_admin`：在册教师 → true', await can(U.phy), true)
        eq('判据：**教室端 → false**（那块屏没有「我的」页，也没有"给学校提意见"这个身份）', await can(U.room), false)
        eq('判据：认不出的 uid → false（service_role 那条路不能凭幽灵 id 写库）', await can('00000000-0000-0000-0000-000000000000'), false)
        /* 两件套：裸版 grant 给 authenticated，`_for` 变体 revoke（I33） */
        eq(
          '两件套（I33）：`can_contact_admin()` 裸版对 authenticated **有** EXECUTE',
          Boolean(
            (
              await db.query(
                `select has_function_privilege('authenticated', 'public.can_contact_admin()', 'EXECUTE') as v`,
              )
            ).rows[0].v,
          ),
          true,
        )
        /* `mail_state` 的四值由 check 钉死；塞第五个值必须报错（属主身份也插不进去） */
        try {
          await db.query(
            `insert into feedback (author_id, body, mail_state) values ($1, '探针', 'nonsense')`,
            [U.phy],
          )
          ok('🔴 `mail_state` 的 check 钉住了取值（第五个值插不进去）', false, '居然插进去了')
        } catch (e) {
          const m = shortErr(e)
          ok('🔴 `mail_state` 的 check 钉住了取值（第五个值插不进去）', /feedback_mail_state_check/i.test(m), m)
        }
        const okFb = await db.query(
          `insert into feedback (author_id, body) values ($1, '合法的一条') returning id, mail_state`,
          [U.phy],
        )
        eq('反向对照：合法的一条插得进去，且 `mail_state` 默认 `pending`（"还没试发"）', okFb.rows[0].mail_state, 'pending')
        await db.query(`delete from feedback where id = $1`, [okFb.rows[0].id])
      }

      /* ---------------- ④ 数据库用量报告：只有服务端能调 ---------------- */

      {
        eq(
          '🔴 `db_usage_report()` 对 anon / authenticated **都 revoke 了**（只有 service_role 能调）',
          [
            Boolean(
              (
                await db.query(
                  `select has_function_privilege('anon', 'public.db_usage_report()', 'EXECUTE') as v`,
                )
              ).rows[0].v,
            ),
            Boolean(
              (
                await db.query(
                  `select has_function_privilege('authenticated', 'public.db_usage_report()', 'EXECUTE') as v`,
                )
              ).rows[0].v,
            ),
          ],
          [false, false],
        )
        /* 正向对照：以属主身份调它 —— 四个键必须在，而且**只量数、不判色** */
        const rep = (await db.query(`select db_usage_report() as j`)).rows[0].j
        eq(
          '正向对照：属主调得到，回话就是那四个键（totalBytes / tables / questionMetaBytes / archives）',
          Object.keys(rep).sort(),
          ['archives', 'questionMetaBytes', 'tables', 'totalBytes'],
        )
        ok('而且 `totalBytes` 是个**数字**（不是颜色、也不是布尔 —— 判色在前端）', typeof rep.totalBytes === 'number', typeof rep.totalBytes)
        ok(
          '🔴 回话里**没有** `quotaBytes`（配额那一个常量只许在 `adminChart.ts` 一处 —— 两处实现迟早对不上）',
          !('quotaBytes' in rep),
          Object.keys(rep).join('、'),
        )
        ok(
          '而且档案排行里**只有** 档案 id / 班级名 / 字节数（没有任何学生、题目、成绩字段）',
          rep.archives.length > 0 &&
            rep.archives.every((a) => Object.keys(a).sort().join(',') === 'assignmentId,bytes,className'),
          JSON.stringify(rep.archives[0] ?? null),
        )
      }
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
      denied('🔴 ① 班主任删**本班别人的**档案（他不教这一科）—— 2026-10-06 收窄后「改不了 ⇒ 也删不掉」', r)
      r = await write(db, U.grade, { sql: `delete from assignments where id = $1 returning id`, values: [E.a2] })
      denied('🔴 ② 年级主任删本年级的档案（同上：他不是当科老师）', r)
      r = await write(db, U.admin, { sql: `delete from assignments where id = $1 returning id`, values: [E.a1] })
      denied(
        '🔴 ③ 教务处删**别人建的**档案（校级兜底在 `can_grade_subject` 里有、`teaches_subject` 里没有 ——' +
          ' 收窄后它也删不掉，这是有意的：删是不可逆的那一头）',
        r,
      )
      r = await write(db, U.chn, { sql: `delete from assignments where id = $1 returning id`, values: [E.a4] })
      allowed(
        '④ 🔴 **建档人自己仍删得掉**（`teacher_id = auth.uid()` 那一支：他教的是语文、这份是物理）' +
          ' —— 这一支存在的理由就是这条，**必须钉**',
        r,
      )
      /* ⚠️ "建档人"那一支的**极端形状**由 §四 的 E.a4 与 §六 的 E.a5 各钉一次
         （那两位老师**都不教那一科**）：这里不再现建一份 ——
         无身份那位老师**建不出**别班/自己不教的档案（INSERT 也走 `can_grade_subject`），
         硬造只会得到一条"建不了"的假红。 */
      r = await write(db, U.phy, { sql: `delete from assignments where id = $1 returning id`, values: [E.a1] })
      allowed('⑤ 反向对照：**本班本科老师删得掉**（上面那三条"被拒"不是"谁都删不动"）', r)

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
       六、教务处 / 最高管理员：全校 + 改任何班成绩（兜底）
       ============================================================ */

    section('六、教务处 / 最高管理员（全校可见 + 改成绩兜底）')
    {
      let r = await write(db, U.super, { sql: `update assignments set wrong = '{"1":["2"]}'::jsonb where id = $1 returning id`, values: [E.a1] })
      allowed('超管改别的班别的科的成绩（兜底）', r)
      r = await write(db, U.admin, { sql: `update assignments set wrong = '{"1":["2"]}'::jsonb where id = $1 returning id`, values: [E.a5] })
      allowed('教务处改任何班任何科的成绩（全校兜底）', r)

      /*
       * 🆕 2026-10-06（`assignments_delete` 收窄）：**建档人自己那一支照旧管用** ——
       * E.a5 是**教务处自己建的**（高三那个班），所以它**删得掉**：
       * `teacher_id = auth.uid()` 那一支过，与"他教不教那一科"无关（他谁都不教）。
       * ⚠️ 这一条与 §五 那三条"教务处删**别人建的**→ 被拒"合起来才是完整的一对：
       *    收窄去掉的是"当班主任 / 年级主任那一支"，**没有**动"自己建的那一支"。
       * ⚠️ 删完就没了：后面几节**没有一处**再引用 E.a5（已逐条核过），所以这里删是安全的。
       */
      r = await write(db, U.admin, { sql: `delete from assignments where id = $1 returning id`, values: [E.a5] })
      allowed('🔴 收窄后**建档人（教务处）删得掉自己建的高三那一份** —— `teacher_id` 那一支没被去掉', r)

      r = await write(db, U.admin, insertSql('assignments', assignmentRow(localAssignment({ id: mk('e0', 94), classId: C.c3, subject: '语文', subjectCode: 'chinese' }), U.admin)))
      allowed('教务处在高三建语文档案（兜底支）', r)

      r = await write(db, U.head, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 90), name: '高二(9)班' }), U.head)))
      allowed('班主任建班（用户口径①）', r)
      r = await write(db, U.grade, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 91), name: '高二(8)班' }), U.grade)))
      allowed('年级主任建班', r)
      r = await write(db, U.admin, insertSql('classes', M.classToRow(localKlass({ id: mk('c0', 95), name: '高三(9)班' }), U.admin)))
      allowed('教务处建班', r)
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
        class_ids: o.classIds ?? [],
        name: o.name ?? '题图.png',
        mime: 'image/png',
        size: 1234,
        storage_path: `${o.teacherId}/cc-${o.name ?? '题图.png'}`,
      })

      r = await write(db, U.room, insertSql('shared_files', fileRow({ id: F.f3, teacherId: U.room, classIds: [C.c1], name: '教室端自己传的.png' })))
      denied('🔴 教室端往 shared_files **插**一行（裂缝 C：前端真实上传载荷，teacher_id = 它自己）', r)

      r = await write(db, U.room, { sql: `update shared_files set name = '被教室端改名了' where id = $1 returning id`, values: [F.f2] })
      denied('🔴 教室端**改** shared_files 里自己名下那一行', r)

      r = await write(db, U.room, { sql: `delete from shared_files where id = $1 returning id`, values: [F.f2] })
      denied('🔴 教室端**删** shared_files 里自己名下那一行', r)

      // 反向对照一：**真正的教师**三条路（插 / 改 / 删）必须照旧通 —— 收裂缝不许误伤老师
      // ⚠️ 删的那一条要删**种子里的**那一行：每次 attempt 都在自己的事务里跑完就 rollback，
      //    所以"上一条刚插进去的行"到下一条已经不存在了（那样量到的是 0 行 = 假失败）。
      r = await write(db, U.phy, insertSql('shared_files', fileRow({ id: F.f4, teacherId: U.phy, classIds: [C.c1], name: '老师新传的答案.pdf' })))
      allowed('对照：真老师照旧能**上传**（插自己名下那一行 shared_files）', r)
      r = await write(db, U.phy, { sql: `update shared_files set name = '题图（改过名）.png' where id = $1 returning id`, values: [F.f1] })
      allowed('对照：真老师照旧能**改**自己传的那一行', r)
      r = await write(db, U.phy, { sql: `delete from shared_files where id = $1 returning id`, values: [F.f1] })
      allowed('对照：真老师照旧能**删**自己传的那一行', r)

      /*
       * ---- 反向对照二：收紧"写"不许把"读"一起弄坏 ----
       *
       * ⚠️ 这一段 2026-09-28 改过：原来是"只断言读得到自己那一行，刻意**不**钉总行数"，
       *    因为那时教室端**读不到老师上传的行**（`shared_files_own` 只给"自己传的"，
       *    §9 的老形状）—— 钉精确清单会让"将来把读补宽"撞红。
       *    那个"将来"就是 **§19**（班级归属，用户拍板 A）。现在读得到本班的文件是**要求**，
       *    所以这里换成**精确清单**：多一条（读宽了）少一条（读坏了）都要红。
       */
      const roomFiles = await idsAs(db, U.room, `select id from shared_files order by id`)
      eq(
        '🔴 教室端读得到**本班**的文件（§19 的读策略：老师传的 f1 · 同班另一位老师传的 f5 · 多班共用的 f6 · 自己名下那行 f2）',
        roomFiles,
        [F.f1, F.f2, F.f5, F.f6].sort(),
      )
      ok(
        '🔴 教室端读不到**别班**的文件（f7 是高一那个班的）',
        !roomFiles.includes(F.f7),
        `读到 ${JSON.stringify(roomFiles)}（不该含 ${F.f7}）`,
      )
      ok(
        '🔴 教室端读不到**没标班**的文件（f8 空归属 —— "无归属 = 教室端看不到"这条语义）',
        !roomFiles.includes(F.f8),
        `读到 ${JSON.stringify(roomFiles)}（不该含 ${F.f8}）`,
      )
      eq(
        '对照：物理老师读得到"自己传的 ∪ 自己任教班的"（含同班语文老师传的 f5 与教室端名下那行 f2 —— 前一条就是"两位老师互相看得见"）',
        await idsAs(db, U.phy, `select id from shared_files order by id`),
        [F.f1, F.f2, F.f5, F.f6, F.f8, F.f9].sort(),
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
        '裂缝 B：schedule_items 上的策略清单（读两路 + 写三路 + 一条教室端边界 + 🆕P9 三条"走班班的屏零写"）',
        sPol.rows.map((x) => `${x.policyname}:${x.cmd}${x.permissive === 'RESTRICTIVE' ? ':RESTRICTIVE' : ''}`),
        [
          'schedule_class_visible:SELECT',
          'schedule_class_write:ALL',
          'schedule_classroom_admin_only_delete:DELETE:RESTRICTIVE',
          'schedule_classroom_admin_only_insert:INSERT:RESTRICTIVE',
          'schedule_classroom_admin_only_update:UPDATE:RESTRICTIVE',
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
       * 🔴 2026-09-28（§19）之后这张清单多了三条：一条读（`shared_files_class_read`）
       *    与两条归属写守卫（`shared_files_class_scope_*`）。**它们一条 SELECT 的 restrictive
       *    都不是** —— restrictive 的 `using` 对 SELECT 也生效，多一条就会把读挡掉。
       */
      const fPol = await db.query(
        `select policyname, cmd, permissive, coalesce(qual,'') || ' ' || coalesce(with_check,'') as body
           from pg_policies where schemaname = 'public' and tablename = 'shared_files' order by cmd, policyname`,
      )
      eq(
        'shared_files 上的策略清单（§9 的 for all + §17.6 三条教室端守卫 + §19 一条读 + 两条归属守卫）',
        fPol.rows.map((x) => `${x.policyname}:${x.cmd}:${x.permissive}`),
        [
          'shared_files_own:ALL:PERMISSIVE',
          'shared_files_not_classroom_delete:DELETE:RESTRICTIVE',
          'shared_files_class_scope_insert:INSERT:RESTRICTIVE',
          'shared_files_not_classroom_insert:INSERT:RESTRICTIVE',
          'shared_files_class_read:SELECT:PERMISSIVE',
          'shared_files_class_scope_update:UPDATE:RESTRICTIVE',
          'shared_files_not_classroom_update:UPDATE:RESTRICTIVE',
        ],
      )
      const fGuard = fPol.rows.filter((x) => x.permissive === 'RESTRICTIVE')
      ok(
        '🔴 裂缝 C：三条逐动作 restrictive（insert/update/delete）都调教室端判据',
        fGuard.filter((x) => /not_classroom/.test(x.policyname)).length === 3 &&
          fGuard.filter((x) => /not_classroom/.test(x.policyname)).every((x) => /classroom_account/.test(x.body)),
        fGuard.map((x) => `${x.policyname}:${/classroom_account/.test(x.body) ? '有' : '没有'}`).join(' · ') || '(没有 restrictive 策略)',
      )
      eq(
        '🔴 restrictive 里一条 SELECT 都没有（写成 for all 会把教室端"读文件列表"也挡掉）',
        fGuard.filter((x) => x.cmd === 'SELECT').length,
        0,
      )
      ok(
        '🔴 §19：两条班级归属写守卫都调归属判据（`can_share_file_to_class`），"只能发给自己的班"在清单上看得见',
        fGuard.filter((x) => /class_scope/.test(x.policyname)).length === 2 &&
          fGuard.filter((x) => /class_scope/.test(x.policyname)).every((x) => /can_share_file_to_class/.test(x.body)),
        fGuard.filter((x) => /class_scope/.test(x.policyname)).map((x) => `${x.policyname}:${/can_share_file_to_class/.test(x.body) ? '有' : '没有'}`).join(' · '),
      )
      ok(
        '🔴 §19：读策略里用的是既有判据 `visible_class_ids()`（同一件事只有一个判定入口，没有另写一套过滤）',
        fPol.rows
          .filter((x) => x.policyname === 'shared_files_class_read')
          .every((x) => /visible_class_ids/.test(x.body)),
        fPol.rows.filter((x) => x.policyname === 'shared_files_class_read').map((x) => shortErr(x.body)).join(' · '),
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
       八·之二 🆕 2026-09-28 第三轮：改老师**显示姓名**，任教关系 / 身份 / 部门一字不变
       ------------------------------------------------------------
       这一节量的是**数据库那一侧**（接口那一侧在 `admin-checks` 第十一节）：
         · 「改显示姓名」到底动了什么 —— 只动 `teachers.name` 这一列；
         · 那三样（任教关系 / 身份 / 部门）**改前改后逐字相同**。

       🔴 这就是"改姓名为什么比重建号好"的直接证据：重建号 = 删掉那个 auth 用户
          （`teachers.id` 是 `references auth.users on delete cascade`）→
          `class_subjects` / `teacher_roles` / `teacher_departments` 三张表**跟着一起走**
          （它们全是 `references teachers (id) on delete cascade`）。
          否定对照就在下面最后那一步：删那一行，三样当场全空。
       ============================================================ */

    section('八·之二 🆕 改显示姓名：只动 name 那一列，任教关系 / 身份 / 部门一字不变')

    {
      /** 一个人此刻的"三样"（任教关系 / 身份 / 部门）—— 顺序固定，好逐字比 */
      const snapshot = async (uid) => {
        const q = async (sql) => (await db.query(sql, [uid])).rows
        return {
          relations: await q(
            `select class_id::text as class_id, subject, coalesce(subject_code, '') as code
               from class_subjects where teacher_id = $1 order by class_id, subject`,
          ),
          roles: await q(
            /*
             * ⚠️ `scope_id` 是 **uuid** 列：`coalesce(scope_id, '')` 会被 PostgreSQL
             *    当成"把 '' 转成 uuid" → `invalid input syntax for type uuid: ""`（踩过一次）。
             *    所以先转文本再兜底空串。
             */
            `select role, coalesce(scope_type, '')::text as scope_type,
                    coalesce(scope_id::text, '') as scope_id,
                    coalesce(subject_code, '')::text as subject_code
               from teacher_roles where teacher_id = $1 order by role`,
          ),
          departments: await q(
            `select department from teacher_departments where teacher_id = $1 order by department`,
          ),
        }
      }

      /* 物理老师：有任教关系（1 班物理）+ 一个部门（教务处）—— 一个"活样本" */
      const before = await snapshot(U.phy)
      ok(
        '自证：这个夹具**真的有三样**（任教关系 1 条、部门 1 个）—— 否则下面"一字不变"是空断言',
        before.relations.length > 0 && before.departments.length > 0,
        `任教关系 ${before.relations.length} 条 / 身份 ${before.roles.length} 条 / 部门 ${before.departments.length} 个`,
      )

      /*
       * 服务端那一步：`PATCH /rest/v1/teachers?id=eq.<id>` 载荷**只有 `{ name }`**
       * （一行 update、service_role）。这里用属主身份执行那句 SQL 是**故意**的：
       * 它量的是"这句 SQL 本身会不会顺手动别的东西"，
       * 而不是"service_role 能不能绕过 RLS"（那是 `admin-checks` 那一侧的事）。
       */
      const renamed = await db.query(
        `update teachers set name = $1 where id = $2 returning id, name`,
        ['李某某', U.phy],
      )
      eq('改姓名：**正好 1 行**被改到（0 行必须报错，见 admin-checks 第十一节 ④）', renamed.rows.length, 1)
      eq('改姓名：库里真的是新名字', renamed.rows[0]?.name, '李某某')

      const after = await snapshot(U.phy)
      eq('🔴 任教关系：改前改后**逐字相同**', after.relations, before.relations)
      eq('🔴 身份：改前改后**逐字相同**（他本来没有 identity 行，改完也没有）', after.roles, before.roles)
      eq('🔴 部门归属：改前改后**逐字相同**', after.departments, before.departments)

      /* 反向对照：把"只改 name"换成"重建号"（删掉那一行）→ 三样必须**当场全空** */
      {
        /*
         * ⚠️ 用**现有的一位老师**（auth.users 里真的有人）当样本：`teachers.id` 是
         *    `references auth.users (id)`，凭空造一个 uuid 插进去会当场外键报错。
         *    而这一节给他加的三样必须**用完就撤**（种子夹具后十节还要用，多一样就换一个人设）——
         *    所以前后各包一个事务、量完 rollback：
         *      ① 「一样不少」→ rollback（撤掉加的三样）
         *      ② 「删掉就全空」→ rollback（撤销那次删除）
         */
        const victim = U.fresh
        const seed = async () => {
          await db.query(
            `insert into class_subjects (class_id, subject, subject_code, teacher_id) values ($1, '物理', 'physics', $2)`,
            [C.c1, victim],
          )
          await db.query(
            `insert into teacher_roles (teacher_id, role, scope_type) values ($1, 'grade_head', 'grade')`,
            [victim],
          )
          await db.query(
            `insert into teacher_departments (teacher_id, department) values ($1, 'academic')`,
            [victim],
          )
        }

        await db.exec('begin')
        await seed()
        const built = await snapshot(victim)
        await db.exec('rollback')
        ok(
          '反向对照自证：重建前的这个人一样不少（1 条任教关系 / 1 条身份 / 1 个部门）',
          built.relations.length === 1 && built.roles.length === 1 && built.departments.length === 1,
          JSON.stringify(built),
        )
        const clean = await snapshot(victim)
        eq(
          '反向对照收尾：那三样已经撤掉（夹具回到本节开头的样子）',
          [clean.relations.length, clean.roles.length, clean.departments.length],
          [0, 0, 0],
        )

        /* ② 真正的对照：把这个人**删掉**（= 重建号）→ 三样一起没（三张表都是 on delete cascade） */
        await db.exec('begin')
        await seed()
        await db.query(`delete from teachers where id = $1`, [victim])
        const gone = await snapshot(victim)
        await db.exec('rollback')
        eq(
          '🔴 反向对照：**重建号**（删掉那一行）= 任教关系 / 身份 / 部门全空 —— 这就是改姓名的价值',
          [gone.relations.length, gone.roles.length, gone.departments.length],
          [0, 0, 0],
        )
        const back = await snapshot(victim)
        eq(
          '反向对照收尾：夹具已还原（rollback 之后一行都没少）',
          [back.relations.length, back.roles.length, back.departments.length],
          [0, 0, 0],
        )
      }
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
        'schedule_items：读两路（自己的 + 班级的）+ 写三路（自己 / 班级 / 教室端）+ §17.2 的教室端边界' +
          ' + 🆕P9 三条（走班班的屏零写）',
        sch.map((r) => r.policyname).sort(),
        [
          'schedule_class_visible',
          'schedule_class_write',
          'schedule_classroom_admin_only_delete',
          'schedule_classroom_admin_only_insert',
          'schedule_classroom_admin_only_update',
          'schedule_classroom_scope_only',
          'schedule_classroom_write',
          'schedule_mine_read',
          'schedule_mine_write',
        ],
      )

      const upd = await db.query(`select count(*)::int as n from pg_policies where schemaname='public' and cmd='UPDATE' and with_check is null`)
      eq('I28：所有 UPDATE 策略都写了 with check（using 与 with check 同款）', Number(upd.rows[0].n), 0)
      const ins = await db.query(`select count(*)::int as n from pg_policies where schemaname='public' and cmd='INSERT' and with_check is null`)
      eq('所有 INSERT 策略都有 with check（没有"只写 using"的）', Number(ins.rows[0].n), 0)

      const readonly = await db.query(
        `select tablename, cmd from pg_policies where schemaname='public'
           and tablename in ('teacher_roles','class_subjects','classroom_accounts','subjects','schools','grades','announcements')
           and cmd <> 'SELECT' order by tablename`,
      )
      eq('身份 / 任课关系 / 教室端账号 / 字典 / 🆕公告：数据库层**一条写策略都没有**（写只走服务端）', readonly.rows, [])

      /* 🆕 `teacher_departments`（部门归属）走的是**同一个形状**：一条 select 策略 + 零条写策略 */
      const deptPol = await db.query(
        `select cmd, policyname from pg_policies where schemaname='public' and tablename='teacher_departments'
          order by cmd, policyname`,
      )
      eq(
        '🆕 `teacher_departments`：只有一条 select 策略（`teacher_id = auth.uid()`），没有写策略',
        deptPol.rows.map((r) => `${r.policyname}:${r.cmd}`),
        ['teacher_departments_read:SELECT'],
      )

      const grants = await db.query(`
        select table_name, privilege_type from information_schema.role_table_grants
         where grantee = 'authenticated' and table_schema = 'public'
           and table_name in ('teacher_roles','class_subjects','classroom_accounts','teacher_departments')
           and privilege_type <> 'SELECT' order by table_name, privilege_type`)
      eq('而且这几张表连 INSERT/UPDATE/DELETE 的 grant 都没有（客户端连门都摸不到）', grants.rows, [])
    }

    /* ============================================================
       十二、存储策略（教师端 → 教室端 的文件互传）
       ============================================================ */

    section('十二、storage：自己目录 · 以及"指向我读得到的那一行"的对象（§9 + §19.4.3）')
    {
      const mine = await write(db, U.phy, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.phy}/zz-新传的.png`] })
      allowed('往自己目录里传文件', mine)
      const other = await write(db, U.phy, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.chn}/zz-别人的.png`] })
      denied('往**别人**目录里传文件', other)
      /*
       * ⚠️ 这一条原来量的是"读不到 `{语文老师}/` 下的任何对象"（= 0）。
       *    §19.4.3（2026-09-28）之后那句不再成立：语文老师传给**1 班**的那一份，
       *    物理老师（教 1 班）**应该**读得到 —— 从 `Files.tsx` 里点开同事那份文件靠的就是它。
       *    所以判据收窄成"**别人目录里、又没有归到我读得到的行**的那些"。
       */
      const readOther = await countAs(db, U.phy, `select count(*)::int as n from storage.objects where name = $1`, [`${U.fresh}/ee-别班.png`])
      eq('读不到**别人目录里、又没有归到自己班**的文件对象', readOther, 0)

      /*
       * ---- 🔴 §19.4.3：对象的**读**要跟着表走（"行读通了、字节读不通"那一半）----
       *
       * 少了这一支：教室端读得到 `shared_files` 那一行、列表上也看得见，
       * 但 `createSignedUrl()` 签不出直链 → `fetchBlob()` 拿到 null →
       * 那一行**永远停在「待取回」，而且不报错**（列表里看得见、点开没反应）。
       * 判据是**委托**给 §19.3 的："`shared_files` 里有一行指着我读得到的对象"。
       */
      const objectsIn = async (uid) =>
        asUser(db, uid, async () =>
          (await db.query(`select name from storage.objects order by name`)).rows.map((r) => r.name),
        )

      eq(
        '🔴 教室端读得到**本班那几份文件的对象**（f1 物理老师的 / f5 语文老师的 / f6 两个班共用的 / f2 自己名下那行）',
        await objectsIn(U.room),
        [`${U.chn}/cc-答案.pdf`, `${U.phy}/aa-题图.png`, `${U.phy}/dd-两个班.png`, `${U.room}/bb-夹具.png`].sort(),
      )
      ok(
        '🔴 教室端读不到**别班**文件的对象（f7 是高一那个班的）',
        !(await objectsIn(U.room)).includes(`${U.fresh}/ee-别班.png`),
      )
      ok(
        '🔴 教室端读不到**没标班**文件的对象（f8 —— 老师自己留着的，教室里不该拿到）',
        !(await objectsIn(U.room)).includes(`${U.phy}/ff-没归属.png`),
      )
      eq(
        '🔴 物理老师读得到**同事**（语文老师）传给同一个班的那一份对象 —— 否则 Files 页里点「打开」没反应',
        await objectsIn(U.phy),
        [`${U.chn}/cc-答案.pdf`, `${U.phy}/aa-题图.png`, `${U.phy}/dd-两个班.png`, `${U.phy}/ff-没归属.png`, `${U.phy}/gg-老列.png`, `${U.room}/bb-夹具.png`].sort(),
      )
      eq(
        '语文老师读得到 1 班的那几份（与表的读口径一致）、读不到物理老师没标班的那份',
        await objectsIn(U.chn),
        [`${U.chn}/cc-答案.pdf`, `${U.phy}/aa-题图.png`, `${U.phy}/dd-两个班.png`, `${U.room}/bb-夹具.png`].sort(),
      )
      eq('无身份新老师只读得到自己目录里的', await objectsIn(U.fresh), [`${U.fresh}/ee-别班.png`])
      eq(
        '（对照）超管读得到 5 个（有班级归属的那 5 份）—— 上面那些清单不是"恒真"（换个人读出来就不一样）',
        (await objectsIn(U.super)).length,
        5,
      )
      ok(
        '🔴 连超管也**读不到那两份"没有班级归属"的对象**（它们只认上传者，与表的读口径逐条一致）',
        !(await objectsIn(U.super)).includes(`${U.phy}/ff-没归属.png`) &&
          !(await objectsIn(U.super)).includes(`${U.phy}/gg-老列.png`),
        JSON.stringify(await objectsIn(U.super)),
      )

      // 反向对照：**写**那两条一个字没动（别为了放宽读把写也放了）
      const delOther = await write(db, U.phy, { sql: `delete from storage.objects where name = $1 returning id`, values: [`${U.chn}/cc-答案.pdf`] })
      denied('对照：老师**删不掉**别人目录下的对象（写策略没被放宽）', delOther)
      const roomDel = await write(db, U.room, { sql: `delete from storage.objects where name = $1 returning id`, values: [`${U.phy}/aa-题图.png`] })
      denied('🔴 对照：教室端**删不掉**老师那份对象（读得到，但写一律拒 —— 所以"取走即删"做不到）', roomDel)
      const roomPutOther = await write(db, U.room, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.phy}/教室端想塞的东西.png`] })
      denied('🔴 对照：教室端往**老师的目录**里插对象 → 被拒', roomPutOther)
      /*
       * ⚠️ 这一条钉的是**既有行为**（不是本次改动带来的）：桶的三条策略是**按路径第一段**判归属的，
       *    所以任何登录者都能往**自己目录**里塞对象 —— 教室端账号也不例外。
       *    它为什么没造成"教室里多出东西"：**它建不出 shared_files 那一行**（§17.6 三条 restrictive），
       *    而列表读的是表、不是桶。钉在这里是为了"以后谁改了它会红"，不是"这是对的"。
       */
      const roomPutOwn = await write(db, U.room, { sql: `insert into storage.objects (bucket_id, name) values ('classroom-files', $1) returning id`, values: [`${U.room}/教室端自己目录里的.png`] })
      allowed('（既有行为）教室端能往**自己目录**插对象，但建不出元数据行 —— 所以列表里永远看不到它', roomPutOwn)
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
        'can_edit_exam_for：超管 / 教务处 → true（兜底，两个人都保留）',
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
       * **两位真实教师 / 所有班全是 false**（真名不写进仓库，见隐私整改），
       * 于是"某位老师能不能建高二(1)班的物理考试"这个问题当时没有答案。
       * 这里以脚本身份（无会话、auth.uid() = NULL）复现同一件事。
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
      const forCount = await db.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like '%\\_for' order by 1`,
      )
      /*
       * ⚠️ 用 `ok(...)` 而不是 `eq(...)`：`eq` 只接三个参数，报错只给"实际 22"这一个数字 ——
       *    看不出多的是哪一个（本轮实测吃过一次）。`ok` 的第三个参数会把**全部名字**打出来。
       *
       * 🆕 21 → **22**：`can_publish_announcement_for` 是**同日「公告轮」（`schema.sql` §22）**
       *    新增的判据（公告 ≠ 通知，两个实体各自独立），它同样守两件套（`_for` + 裸版 + 一律 revoke）。
       * 🆕 22 → **23**：`can_contact_admin_for`（**管理台第二期**，`schema.sql` §25）——
       *    它守的是"**在册教师 且 不是教室端** 才能给管理员发消息"，
       *    被**用户反馈**（`/api/feedback`）与**备份通知**（`/api/mail` 的 `backup`）**共用**
       *    （一个判据一种语义：不为第二条路再发明一个名字相近的函数）。
       * 🆕 23 → **25**：`can_promote_grades_for` / `can_delete_grade_for`（**P4**，`schema.sql` §29）——
       *    提档与毕业删除的判据（"教导处/超管能不能提档"、"超管能不能删这个年级"）。
       *    它们**必须**有 `_for` 版：§29 的写入口是 `revoke … from authenticated` 的，
       *    服务端只能用 service_role 调，而 service_role 那条路上 `auth.uid()` 是 NULL ——
       *    判据只能靠**显式传进来的 `p_actor`**（`grade-checks` 第十二节的 T1/T4/T5 就是拿它验的）。
       * 🆕 25 → **29**：**2026-10-02 集成修复**（`schema.sql` §27.7 / §27.13 / §28.5）——
       *    §27 那三个写入口（录名单 / 批量写任教关系 / 写选科）与 §28 的 `write_academic_year`
       *    也改成了"service_role + 显式 `p_actor`"（它们原来拿**调用者 JWT** 调被 revoke 的函数
       *    → 线上必 42501）。于是它们判据链上的四条也拆成了两件套：
       *    `can_manage_grade_setup_for` / `can_edit_student_subject_for` /
       *    `can_manage_class_setup_for` / `can_manage_terms_for`。
       *    这一行只是"数一数"的记账：**判据别只写裸版**这条纪律一个字没变。
       * 🆕 29 → **30**：**P5 统一模型**（`schema.sql` §31）新增 `assignments_write_ok_for` ——
       *    它是作业写策略的判据（`class_id` 可空之后要能容纳"未归属"），
       *    与 §13/§16 的 `can_grade_subject` 并列、**不替换它**，所以也要两件套 + revoke。
       */
      const forNames = forCount.rows.map((r) => r.proname)
      ok(
        '`_for` 变体一共 33 个（13 + 管理架构轮 8 个 + 公告轮 1 个 `can_publish_announcement_for`' +
          ' + 管理台第二期 1 个 `can_contact_admin_for`' +
          ' + 🆕P4 2 个 `can_promote_grades_for` / `can_delete_grade_for`' +
          ' + 🆕集成修复 4 个 `can_manage_grade_setup_for` / `can_edit_student_subject_for` /' +
          ' `can_manage_class_setup_for` / `can_manage_terms_for`' +
          ' + 🆕P5 1 个 `assignments_write_ok_for`' +
          ' + 🆕P9 1 个 `can_call_for`（事务性呼叫的判据）' +
          ' + 🆕P10 1 个 `old_subject_data_counts_for`（旧科目数据的清单）' +
          ' + 🆕2026-10-08 超管唯一 1 个 `can_assign_super_role_for`（发 super 只有超管能发））' +
          ' —— id 变体也算判据的两件套，新增判据别只写裸版',
        forNames.length === 33,
        `实际 ${forNames.length} 个：${forNames.join('、')}`,
      )
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
       十四、教师端 → 教室端：文件的**班级归属**（`schema.sql` §19，2026-09-28）
       ------------------------------------------------------------
       为什么单开一节：在这一节之前，`shared_files` 上只有一条 `for all`（§9），
       教室端**读不到老师上传的行**（列表恒为空、**而且不报错**），教师之间也互相看不到对方的材料。
       这条链路在**本地演示模式下完全正常**（本地不走 RLS），所以它只能靠这一节守 ——
       `shots.mjs` 永远覆盖不到它（dev 下没有 Supabase 变量，那一页渲染的是"还没连接云端"）。
       四件事：① 归属判据（两件套）② 逐身份读矩阵 ③ "只能发给自己的班"的写守卫 ④ 老数据搬迁。
       第五件事（**存储对象那一侧的读**）在**第十二节**：行读通了、字节读不通一样是白修。
       负向对照（`schema.sql` 里改的是内存文本，仓库文件不动）：
         · `RLS_NEGATIVE=file-read-wider`  —— 读策略改成恒真（谁都能读所有文件）→ 必须红；
         · `RLS_NEGATIVE=file-read-closed` —— 读策略改成恒假（教室端又变成空列表）→ 必须红；
         · `RLS_NEGATIVE=file-object-wider` —— 存储对象的读策略改成恒真（直链谁都能签）→ 必须红。
       ============================================================ */

    section('十四、文件的班级归属（§19：读得通 + 只能发给自己的班 + 老数据搬迁）')
    {
      const sorted = (a) => [...a].sort()
      const fileIds = (uid) => idsAs(db, uid, `select id from shared_files order by id`)
      const share = (uid, cid) =>
        db.query(`select can_share_file_to_class_for($1, $2) as v`, [uid, cid]).then((r) => Boolean(r.rows[0].v))
      /** 裸版（读 auth.uid()）：只能"以某人的身份"问 */
      const shareAs = (uid, cid) =>
        asUser(db, uid, async () => Boolean((await db.query(`select can_share_file_to_class($1) as v`, [cid])).rows[0].v))

      // ---- ① 归属判据：与 `classes_visible` 逐字同款（看得见这个班 · 或这个班是我建的）----
      eq(
        '归属判据：物理老师 → 他教的两个班 true',
        [await share(U.phy, C.c1), await share(U.phy, C.c2)],
        [true, true],
      )
      eq('归属判据：物理老师 → 别班（高三 1 班，他不教、也不是他建的）false', await share(U.phy, C.c3), false)
      eq(
        '🔴 归属判据：无身份新老师 → **自己建的班** true（少了这一支，他建的班自己反而发不进去 —— 与 §16.3.0 同一条纪律）',
        await share(U.fresh, C.c4),
        true,
      )
      eq('归属判据：无身份新老师 → 别人的班 false', await share(U.fresh, C.c1), false)
      eq(
        '归属判据：班主任 → 本班 true / 同年级别的班 false',
        [await share(U.head, C.c1), await share(U.head, C.c2)],
        [true, false],
      )
      eq(
        '归属判据：年级主任 → 本年级两个班都 true',
        [await share(U.grade, C.c1), await share(U.grade, C.c2)],
        [true, true],
      )
      eq(
        '归属判据：超管 / 教务处 → 任意班 true（兜底）',
        [await share(U.super, C.c3), await share(U.admin, C.c3)],
        [true, true],
      )
      eq(
        '归属判据：教室端 → 本班 true（它确实"看得见这个班"）；写仍然被 §17.6 三条挡住 —— 两条闸各管一件事',
        await share(U.room, C.c1),
        true,
      )
      eq(
        '薄包装等价：裸版（读 auth.uid()）与 _for 同结论',
        [await shareAs(U.phy, C.c1), await shareAs(U.phy, C.c3)],
        [true, false],
      )
      const shareNoLogin = await db.query(`select can_share_file_to_class($1) as v`, [C.c1])
      eq(
        '🔴 没有登录态（auth.uid() = NULL）时裸版恒 false —— 所以必须有 _for 变体（§18.1）',
        Boolean(shareNoLogin.rows[0].v),
        false,
      )

      // ---- ② 逐身份读矩阵（教室端那一半在第七节，这里看教师侧）----
      eq(
        '物理老师：自己传的（f1/f6/f8/f9）∪ 自己任教班的（f2 教室端名下那行 / f5 同班语文老师传的）',
        await fileIds(U.phy),
        sorted([F.f1, F.f2, F.f5, F.f6, F.f8, F.f9]),
      )
      eq(
        '🔴 语文老师：看得见 1 班的全部（含**物理老师**传的 f1/f6）—— 同一个班的两位老师互相看得到材料',
        await fileIds(U.chn),
        sorted([F.f1, F.f2, F.f5, F.f6]),
      )
      eq('班主任（本班）：同上一份清单（读得宽，与 assignments/students 同口径）', await fileIds(U.head), sorted([F.f1, F.f2, F.f5, F.f6]))
      eq('年级主任（本年级 = 1 班 + 4 班）：同样看得见这几份', await fileIds(U.grade), sorted([F.f1, F.f2, F.f5, F.f6]))
      eq('无身份新老师：只看得到自己传的那一份（f7）', await fileIds(U.fresh), [F.f7])
      ok(
        '🔴 **没有班级归属**的那一份（f8）除了上传者谁都看不到（班主任也看不到 —— "无归属 = 教室端看不到"这条语义的另一面）',
        !(await fileIds(U.head)).includes(F.f8) && !(await fileIds(U.grade)).includes(F.f8),
        `班主任读到 ${JSON.stringify(await fileIds(U.head))}`,
      )
      ok('🔴 别班的文件（f7 是高一那个班的）物理老师看不到', !(await fileIds(U.phy)).includes(F.f7))
      ok('🔴 老形状那一行（f9：只写了老列 class_id、class_ids 还空着）在搬迁之前谁都看不到（上传者除外）', !(await fileIds(U.head)).includes(F.f9))

      // ---- ③ 写：只能把文件归到自己看得见的班（判据在数据库，不在前端）----
      const fileRow2 = (o) => ({
        id: o.id,
        teacher_id: o.teacherId,
        class_ids: o.classIds ?? [],
        name: o.name ?? '新传的题图.png',
        mime: 'image/png',
        size: 1234,
        storage_path: `${o.teacherId}/hh-新传.png`,
      })

      let r = await write(db, U.phy, insertSql('shared_files', fileRow2({ id: mk('f0', 90), teacherId: U.phy, classIds: [C.c1] })))
      allowed('物理老师上传到**自己教的班**（1 班）→ 通过', r)
      r = await write(db, U.phy, insertSql('shared_files', fileRow2({ id: mk('f0', 91), teacherId: U.phy, classIds: [C.c1, C.c2] })))
      allowed('🔴 物理老师**一次发给两个班**（1 班 + 4 班，两个都是他教的）→ 通过（多选那条语义落到了策略上）', r)
      r = await write(db, U.phy, insertSql('shared_files', fileRow2({ id: mk('f0', 92), teacherId: U.phy, classIds: [C.c1, C.c3] })))
      denied('🔴 一个班是自己教的、另一个不是 → **整条被拒**（数组里每一个都要过判据）', r)
      r = await write(db, U.phy, insertSql('shared_files', fileRow2({ id: mk('f0', 93), teacherId: U.phy, classIds: [C.c3] })))
      denied('🔴 物理老师想把文件发给**自己看不见的班**（高三 1 班）→ 被拒（前端也不会列出来，但判据在数据库）', r)
      r = await write(db, U.phy, insertSql('shared_files', fileRow2({ id: mk('f0', 94), teacherId: U.phy, classIds: [] })))
      allowed('物理老师传一份**不指定班级**的（只有自己看得见）→ 通过（空归属是合法状态，不是"必填校验"）', r)
      r = await write(db, U.fresh, insertSql('shared_files', fileRow2({ id: mk('f0', 95), teacherId: U.fresh, classIds: [C.c4] })))
      allowed('🔴 无身份新老师发给自己**建的**班 → 通过（写判据与读判据同款，不能比他看得见的更窄）', r)
      r = await write(db, U.admin, insertSql('shared_files', fileRow2({ id: mk('f0', 96), teacherId: U.admin, classIds: [C.c3] })))
      allowed('教务处发给任意班 → 通过（兜底）', r)
      r = await write(db, U.phy, { sql: `update shared_files set class_ids = array[$1]::uuid[] where id = $2 returning id`, values: [C.c3, F.f1] })
      denied('🔴 老师**改**自己那行的归属、把它挪到自己看不见的班 → 被拒（using 与 with check 同款，I28）', r)
      r = await write(db, U.phy, { sql: `update shared_files set class_ids = array[$1, $2]::uuid[] where id = $3 returning id`, values: [C.c1, C.c2, F.f1] })
      allowed('对照：老师把自己那行改成"两个自己教的班" → 通过（守卫没有误伤正常改法）', r)
      r = await write(db, U.room, insertSql('shared_files', fileRow2({ id: mk('f0', 97), teacherId: U.room, classIds: [C.c1] })))
      denied('🔴 教室端上传（judgment 那一层它是 true：本班）→ 仍被 §17.6 三条 restrictive 拒掉', r)

      /*
       * ---- ④ 老数据搬迁（§19.2）：只搬 `class_id` 非空的那一批 ----
       *
       * 这一段**真的把那句 SQL 跑一遍**（从 schema 原文里切出来，跑的是仓库里那一句，
       * 不是脚本里手抄的一份 —— 与 §16 的 A/B 切分同一个手法）。
       * 它跑在 B 库上、在**所有读断言之后**，所以不会影响上面的矩阵。
       * ⚠️ 跑它的身份是**属主**（没有 RLS）—— 与在 Supabase SQL 编辑器里跑本节是同一种情形。
       */
      const backfillRe = /update shared_files\n\s+set class_ids = array\[class_id\][\s\S]*?;\n/
      const backfill = RAW_SCHEMA.match(backfillRe)
      if (!backfill) throw new Error('§19.2 的搬迁 SQL 找不到（schema.sql 里那句 update 被改写了？）')

      const before9 = await db.query(`select class_ids from shared_files where id = $1`, [F.f9])
      eq('搬迁前：老形状那一行（f9）的 class_ids 还是空的', before9.rows[0].class_ids, [])
      await db.exec(backfill[0])
      const after9 = await db.query(`select class_ids from shared_files where id = $1`, [F.f9])
      eq('🔴 搬迁：`class_id` 非空的老行填上了那一个班（f9 → [高三 1 班]）', after9.rows[0].class_ids, [C.c3])
      const after8 = await db.query(`select class_ids from shared_files where id = $1`, [F.f8])
      eq('🔴 搬迁：`class_id` 为空的老行**一个字不动**（f8 仍是空归属 = 教室端看不到，绝不猜一个班）', after8.rows[0].class_ids, [])
      await db.exec(backfill[0])
      const again8 = await db.query(`select class_ids from shared_files where id = $1`, [F.f8])
      const again9 = await db.query(`select class_ids from shared_files where id = $1`, [F.f9])
      eq(
        '搬迁可以重跑（幂等）：空归属照旧留空、搬过的不会被改回去',
        [again8.rows[0].class_ids, again9.rows[0].class_ids],
        [[], [C.c3]],
      )
      // 搬迁之后：那一行仍然只归**高三**，教室端（高二 1 班）照旧看不到
      ok(
        '搬迁之后教室端仍然看不到它（归属是高三 1 班，不是本班）',
        !(await idsAs(db, U.room, `select id from shared_files order by id`)).includes(F.f9),
      )
    }

    /* ============================================================
       十五、序列号键迁移（`schema.sql` §20 / P1 · 2026-09-25）
       ------------------------------------------------------------
       为什么单开一节：P1 把"那 10 个字段的键"从**班内学号**换成**序列号**（I40），
       而这件事有三处**只能靠真数据库验**、前端与浏览器都覆盖不到：
         ① **"序列号生成后永久不可改"必须是数据库层拒的**（触发器，不是界面灰化）——
            这里真跑一条 `update students set serial=…`，必须报错；
         ② **迁移必须幂等**：同一个函数跑第二遍**受影响行数必须是 0** ——
            这一条是本期的头号风险（U-3：判据选错 = 把成果当垃圾再迁一次，而且不报错）；
         ③ **两处考试字段**（`exams.absent_nos` / `exam_scores.student_no`）的作用域是
            **班级集合**，与那 10 个字段的单班作用域不同，很容易漏。
       本节刻意**自己造一批"迁移前"的夹具**（一个新年级 + 一个新班 + 3 个没有序列号的学生），
       不动上面那批固定数据 —— 上面各节的可见量断言因此一个都不受影响。
       ============================================================ */

    section('十五、序列号键迁移（§20：不可改 · 幂等 · 两处考试字段）')
    {
      const G7 = mk('90', 1) // 新年级（**故意先不给届** —— 验"认不出就不生成"）
      const C7 = mk('c7', 1)
      const S7 = [mk('70', 1), mk('70', 2), mk('70', 3)]
      const A7 = mk('e7', 1)
      const CA7 = mk('cb', 1)
      const X7 = mk('e8', 1)
      const XS7 = mk('e9', 1)

      const q = (sql, params) => db.query(sql, params).then((r) => r.rows)
      const num = async (sql, params) => Number((await q(sql, params))[0]?.n ?? -1)

      // ---- 夹具：一个**认不出届**的新年级 + 迁移前形状的班/学生/档案 ----
      await db.exec(`
        insert into grades (id, school_id, name, year)
          values ('${G7}', (select id from schools order by created_at limit 1), '初一', '');
        insert into classes (id, teacher_id, school_id, name, grade, year, grade_id)
          values ('${C7}', '${U.phy}', (select id from schools order by created_at limit 1),
                  '初一(1)班', '初一', '', '${G7}');
        insert into students (id, class_id, student_no, name) values
          ('${S7[0]}', '${C7}', '1', '子'), ('${S7[1]}', '${C7}', '2', '丑'), ('${S7[2]}', '${C7}', '12', '寅');
        insert into assignments (id, class_id, teacher_id, title, subject, subject_code,
          assign_date, question_count, missing_nos, late_nos, confirmed_nos, focus_nos,
          correction_nos, corrected_nos, wrong, grades)
        values ('${A7}', '${C7}', '${U.phy}', '初一练习1', '物理', 'physics', '2026-09-20', 10,
          array['1','12'], array['2'], array['1','2'], array['12'], array['1'], array['2'],
          '{"1":["3"],"12":["4.1"]}'::jsonb, '{"2":"良"}'::jsonb);
        insert into calls (id, teacher_id, assignment_id, class_id, student_nos, text, states)
        values ('${CA7}', '${U.phy}', '${A7}', '${C7}', array['1','12'], '请子同学到办公室',
          '{"1":"called","12":"arrived"}'::jsonb);
        insert into exams (id, teacher_id, title, paper_key, subject, subject_code, scope, grade,
          exam_date, question_count, class_ids, absent_nos)
        values ('${X7}', '${U.phy}', '初一练习8', '初一练习8', '物理', 'physics', 'class', '初一',
          '2026-09-20', 10, array['${C7}']::uuid[], array['1','12']);
        insert into exam_scores (id, exam_id, class_id, student_no, name, graded)
        values ('${XS7}', '${X7}', '${C7}', '1', '子', true);
      `)
      /*
       * 把上面那批固定数据也摆成**迁移前**的形状（只补 `legacy_student_no`，不动 serial）：
       *   §20.9 的"届回填"在**建库那一刻**就跑过了 → 那 8 个学生是被 §20.2b 的触发器
       *   自动发的号，`legacy_student_no` 还是空的。于是他们班里那些**老档案**
       *   （`exam_scores` 里那两行 `student_no = '1' / '2'`）在迁移时**反查不出来**，
       *   会被算成"查不到的键"。
       *   这不是 bug，而是**真实会发生的一种状态**（先跑 SQL、后导入老档案）；
       *   本节要验的是"老键能反查"那条路，所以在这里把老键存档补上 ——
       *   等价于"这批档案是迁移前产生的"。
       *   ⚠️ 初一的 3 个**故意不补**：它们要留在"从没发过号"的状态，
       *      否则下面第①步"认不出届 → 不生成"就无从验起。
       */
      await db.exec(`
        update students set legacy_student_no = student_no
         where class_id <> '${C7}' and legacy_student_no = ''
      `)

      // ---- ① 认不出入校年份 → **不生成**（I14：认不出不许猜）----
      let gen = (await q(`select * from assign_student_serials()`))[0]
      eq('认不出届 → 一个号都不发（绝不用"今年"顶上去）', [Number(gen.assigned), Number(gen.unresolved)], [0, 3])
      eq(
        '认不出届 → 3 个学生的 serial 仍是空串',
        await num(`select count(*)::int as n from students where class_id = $1 and serial = ''`, [C7]),
        3,
      )

      // ---- ② 补上届（Q18 口径：届 = 4 位入校年份）→ 按 U-2 = A 追加到年级末尾 ----
      await db.exec(`update grades set year = '2027' where id = '${G7}'`)
      gen = (await q(`select * from assign_student_serials()`))[0]
      eq('补上届之后 → 3 个人都拿到了号', [Number(gen.assigned), Number(gen.unresolved)], [3, 0])
      eq(
        '🔴 序列号形状 = 4 位入校年份 + 3 位届内序号（2027xxx）',
        await num(`select count(*)::int as n from students where class_id = $1 and serial ~ '^2027[0-9]{3}$'`, [C7]),
        3,
      )
      eq(
        '🔴 生成序列号时**同时**写下了老键存档（`legacy_student_no` = 当时的班内学号）',
        Object.fromEntries(
          (await q(`select student_no, legacy_student_no from students where class_id = $1`, [C7])).map((r) => [
            r.student_no,
            r.legacy_student_no,
          ]),
        ),
        { '1': '1', '2': '2', '12': '12' },
      )
      eq(
        '再跑一遍生成：一个号都不发（它只给还没有序列号的人发）',
        Number((await q(`select * from assign_student_serials()`))[0].assigned),
        0,
      )

      // ---- ③ 唯一索引：新学生的号由**触发器**发，且**追加到年级末尾**（U-2 = A）----
      const S7N = mk('70', 4)
      await db.exec(`insert into students (id, class_id, student_no, name) values ('${S7N}', '${C7}', '20', '卯')`)
      eq(
        '🔴 新建学生：`students_serial_fill` 触发器自动发号，且**接在末尾**（不复用空号）',
        (await q(`select serial, legacy_student_no from students where id = $1`, [S7N]))[0],
        { serial: '2027004', legacy_student_no: '' },
      )
      eq(
        '新发的号**不写** legacy_student_no（"不是从老键迁过来的"）',
        (await q(`select legacy_student_no from students where id = $1`, [S7N]))[0].legacy_student_no,
        '',
      )
      /*
       * 🔴 **一次插多行**（粘贴导入就是一次 upsert 几十行）：
       *    BEFORE INSERT 触发器里那句 `select max(serial)` **看不见同一条语句里刚插的行**
       *    （语句开始时的快照）—— 没有计数器的话这 3 行会算出**同一个号**，整批撞唯一索引。
       *    这一条就是"导入 50 个学生"的真实形状。
       */
      await db.exec(`
        insert into students (id, class_id, student_no, name) values
          ('${mk('70', 5)}', '${C7}', '21', '辰'),
          ('${mk('70', 6)}', '${C7}', '22', '巳'),
          ('${mk('70', 7)}', '${C7}', '23', '午')
      `)
      eq(
        '🔴 一次插 3 行：拿到 3 个**不同**的号，且接在末尾（计数器逐行取号，不靠 max()）',
        (await q(`select serial from students where class_id = $1 and student_no in ('21','22','23') order by student_no`, [C7])).map(
          (x) => x.serial,
        ),
        ['2027005', '2027006', '2027007'],
      )
      // 收尾：把这 3 行删掉，免得影响下面的"信号"断言（本节最后还会整份重跑一遍 schema）
      await db.exec(`delete from students where id in ('${mk('70', 5)}','${mk('70', 6)}','${mk('70', 7)}')`)
      /*
       * 🔴 upsert（PostgREST 的 `on conflict (id) do update`）**也会走 BEFORE INSERT**：
       *    那一行本来就有序列号，触发器**不许再发一个** —— 否则 BEFORE UPDATE 的守卫
       *    会当场把整条 upsert 拒掉，而"保存失败 = 刷新即丢"（前端不能崩）。
       */
      let r = await db.query(
        `insert into students (id, class_id, student_no, name) values ($1, $2, '20', '卯(改名)')
         on conflict (id) do update set name = excluded.name returning id, serial, name`,
        [S7N, C7],
      )
      eq(
        '🔴 upsert 改学生（载荷不带 serial）→ **不被拒**，序列号一个字不动',
        r.rows[0] && { serial: r.rows[0].serial, name: r.rows[0].name },
        { serial: '2027004', name: '卯(改名)' },
      )

      // ---- ④ 键值迁移（**第一遍**）----
      const run1 = await q(`select * from migrate_nos_to_serial()`)
      eq('迁移一共 7 段（6 个 text[]/jsonb + 2 处考试字段合并成 7 步）', run1.length, 7)
      ok(
        '🔴 第一遍：7 段**都真的改到了行**（不是"跑过了但什么都没做"）',
        run1.every((x) => Number(x.rows_affected) > 0),
        run1.map((x) => `${x.step}=${x.rows_affected}`).join(' · '),
      )

      // ---- ⑤ 迁移（**第二遍**）：受影响行数必须全为 0（幂等 = U-3 的验收）----
      const run2 = await q(`select * from migrate_nos_to_serial()`)
      ok(
        '🔴🔴 第二遍：7 段**全部 0 行**（幂等 —— 判据靠 `legacy_student_no`，不猜形状）',
        run2.every((x) => Number(x.rows_affected) === 0),
        run2.map((x) => `${x.step}=${x.rows_affected}`).join(' · '),
      )

      // ---- ⑥ 迁移结果：12 个字段的键**全是序列号** ----
      const a7 = (await q(`select * from assignments where id = $1`, [A7]))[0]
      const serialOf = Object.fromEntries(
        (await q(`select student_no, serial from students where class_id = $1`, [C7])).map((x) => [
          x.student_no,
          x.serial,
        ]),
      )
      eq(
        '🔴 `assignments` 的 6 个 text[] 字段：键全变成序列号',
        [a7.missing_nos, a7.late_nos, a7.confirmed_nos, a7.focus_nos, a7.correction_nos, a7.corrected_nos],
        [
          [serialOf['1'], serialOf['12']],
          [serialOf['2']],
          [serialOf['1'], serialOf['2']],
          [serialOf['12']],
          [serialOf['1']],
          [serialOf['2']],
        ],
      )
      eq(
        '🔴 `assignments.wrong` 的键：序列号（值里的错题键一个字没动）',
        a7.wrong,
        { [serialOf['1']]: ['3'], [serialOf['12']]: ['4.1'] },
      )
      eq('🔴 `assignments.grades` 的键：序列号', a7.grades, { [serialOf['2']]: '良' })
      const c7 = (await q(`select * from calls where id = $1`, [CA7]))[0]
      eq(
        '🔴 `calls.student_nos` + `calls.states`：两个字段一起迁（少一个就是"两套键"）',
        [c7.student_nos, c7.states],
        [
          [serialOf['1'], serialOf['12']],
          { [serialOf['1']]: 'called', [serialOf['12']]: 'arrived' },
        ],
      )
      eq(
        '🔴 `exams.absent_nos`（作用域 = 班级集合）：也迁了',
        (await q(`select absent_nos from exams where id = $1`, [X7]))[0].absent_nos,
        [serialOf['1'], serialOf['12']],
      )
      eq(
        '🔴 `exam_scores.student_no`（**值**迁移；列类型与 unique 约束都没动）：键变成序列号',
        (await q(`select student_no from exam_scores where id = $1`, [XS7]))[0].student_no,
        serialOf['1'],
      )
      eq(
        '列类型自检：两处考试字段仍是 text / text[]（Q6："值迁移，不是改类型"）',
        await q(`
          select (select data_type from information_schema.columns
                   where table_name = 'exam_scores' and column_name = 'student_no') as a,
                 (select data_type from information_schema.columns
                   where table_name = 'exams' and column_name = 'absent_nos') as b`),
        [{ a: 'text', b: 'ARRAY' }],
      )

      // ---- ⑦ 自检函数：所有"该为 0"的数都是 0 ----
      const report = await q(`select * from serial_migration_report()`)
      const hard = report.filter((x) => x.kind === '硬指标')
      eq(
        '🔴 硬指标：没有序列号的人数 = 0、序列号重复数 = 0',
        hard.map((x) => `${x.item}=${x.n}`),
        ['students 序列号重复=0', 'students 没有序列号=0'],
      )
      const pending = report.filter((x) => x.kind === '待迁键（必须为 0）')
      ok(
        '🔴 十键（+2）自检：**待迁键全部为 0**，而且 12 个字段**每个都出了一行**（全 0 看得见）',
        pending.length === 12 && pending.every((x) => Number(x.n) === 0),
        pending.map((x) => `${x.item}=${x.n}`).join(' · '),
      )
      const unknown = report.filter((x) => x.kind.startsWith('查不到的键'))
      ok(
        '查不到的键：也逐字段列出（0 就是 0，有的话必须人工看）',
        unknown.length === 12 && unknown.every((x) => Number(x.n) === 0),
        unknown.map((x) => `${x.item}=${x.n}`).join(' · '),
      )

      // ---- ⑧ 🔴 "序列号生成后永久不可改" —— **数据库层拒**（不是界面灰化）----
      /*
       * ⚠️ 这一组**必须**满足两个条件，否则就是一条假断言（负向对照实测踩过）：
       *   ① 用**管得着这个班**的身份（教务处）去改 —— 用任课老师的话，
       *      `students_update` 的 RLS 会先把他筛成 0 行，于是"被拒"看起来成立，
       *      而**触发器有没有生效根本验不到**（把守卫删掉照样是 0 行、照样绿）；
       *   ② 判据必须是 `denied`（**报错**），不能是 `blocked`（0 行）——
       *      前者是触发器抛的异常，后者是策略静默筛掉的行。
       *   同一身份紧接着改一次**班内学号**（下面 ⑨）必须通过 ——
       *   那一条是"他确实改得动这一行"的对照，没有它上面那两条也可能是"他什么都改不了"。
       */
      const strictDenied = (name, res, expectMsg) =>
        ok(
          `${name} → **报错拒绝**，且报的就是守卫那句话（不是被策略静默筛成 0 行、也不是别的错）`,
          res.outcome === 'denied' && new RegExp(expectMsg).test(res.detail),
          `${res.outcome}：${res.detail}`,
          `期望报错里含「${expectMsg}」`,
        )
      // ⚠️ `attempt(db, uid, sql, params)` 的签名与 `write(db, uid, {sql, values})` **不同**
      let w = await attempt(db, U.admin, `update students set serial = '2027999' where id = $1 returning id`, [S7[0]])
      strictDenied('🔴 教务处改序列号（值 → 另一个值）', w, '序列号生成后永久不可改')
      w = await attempt(db, U.admin, `update students set serial = '' where id = $1 returning id`, [S7[0]])
      strictDenied('🔴 教务处把序列号**清空**（想绕开唯一索引）', w, '序列号生成后永久不可改')
      w = await attempt(db, U.super, `update students set legacy_student_no = 'x' where id = $1 returning id`, [S7[0]])
      strictDenied('🔴 改 `legacy_student_no`（迁移判据）', w, 'legacy_student_no 是迁移判据')
      eq(
        '被拒之后那两行一个字都没变',
        await q(`select serial, legacy_student_no from students where id = $1`, [S7[0]]),
        [{ serial: serialOf['1'], legacy_student_no: '1' }],
      )
      // 对照：**同一个身份**改成"值没变"的序列号 → 通过（不是"他什么都改不了"）
      w = await attempt(db, U.admin, `update students set serial = serial where id = $1 returning id`, [S7[0]])
      allowed('对照：教务处把序列号写成**它自己**（值没变）→ 通过 —— 证明上两条不是"他改不动这一行"', w)

      // ---- ⑨ 班内学号**可改**，而且改它不影响档案（键已经是序列号）----
      // 三档：班主任 / 年级主任 / 教务处（Q6）—— 这里用教务处；任课老师**不算**（下面那条对照）
      w = await attempt(db, U.admin, `update students set student_no = '99' where id = $1 returning id`, [S7[0]])
      allowed('🔴 改**班级内学号**（教务处）→ 通过', w)
      w = await attempt(db, U.phy, `update students set student_no = '98' where id = $1 returning id`, [S7[0]])
      denied('对照：**任课老师**改学号 → 被拒（他不在"三档"里，RLS 判的是 can_manage_class）', w)
      eq(
        '🔴 改班内学号之后：档案里的键**一个字都没动**（它认的是序列号）',
        [
          (await q(`select missing_nos, wrong from assignments where id = $1`, [A7]))[0],
          (await q(`select absent_nos from exams where id = $1`, [X7]))[0].absent_nos,
          (await q(`select student_no from exam_scores where id = $1`, [XS7]))[0].student_no,
        ],
        [
          { missing_nos: [serialOf['1'], serialOf['12']], wrong: { [serialOf['1']]: ['3'], [serialOf['12']]: ['4.1'] } },
          [serialOf['1'], serialOf['12']],
          serialOf['1'],
        ],
      )

      // ---- ⑩ 回退脚本（与正向一起写、一起测）：键写回老学号，也幂等 ----
      const rev1 = await q(`select * from revert_nos_to_legacy()`)
      ok(
        '回退：7 段都改到了行',
        rev1.every((x) => Number(x.rows_affected) > 0),
        rev1.map((x) => `${x.step}=${x.rows_affected}`).join(' · '),
      )
      eq(
        '🔴 回退之后：键回到**迁移前那个样子**（班内学号）',
        [
          (await q(`select missing_nos, wrong from assignments where id = $1`, [A7]))[0],
          (await q(`select absent_nos from exams where id = $1`, [X7]))[0].absent_nos,
          (await q(`select student_no from exam_scores where id = $1`, [XS7]))[0].student_no,
        ],
        [
          { missing_nos: ['1', '12'], wrong: { '1': ['3'], '12': ['4.1'] } },
          ['1', '12'],
          '1',
        ],
      )
      const rev2 = await q(`select * from revert_nos_to_legacy()`)
      ok(
        '回退也可以重跑（第二遍 7 段全 0）',
        rev2.every((x) => Number(x.rows_affected) === 0),
        rev2.map((x) => `${x.step}=${x.rows_affected}`).join(' · '),
      )
      const run3 = await q(`select * from migrate_nos_to_serial()`)
      ok('再正向迁回去（键又全是序列号）', run3.every((x) => Number(x.rows_affected) > 0))
      const run4 = await q(`select * from migrate_nos_to_serial()`)
      ok(
        '🔴 来回一轮之后再跑一遍：仍然 7 段全 0（幂等不依赖"只跑过一次"）',
        run4.every((x) => Number(x.rows_affected) === 0),
        run4.map((x) => `${x.step}=${x.rows_affected}`).join(' · '),
      )

      // ---- ⑪ 三个会改数据的函数**不给前端调**（revoke）----
      w = await attempt(db, U.phy, `select * from assign_student_serials()`)
      denied('🔴 `assign_student_serials()` 已 revoke：教师调不到', w)
      w = await attempt(db, U.phy, `select * from migrate_nos_to_serial()`)
      denied('🔴 `migrate_nos_to_serial()` 已 revoke：教师调不到', w)
      w = await attempt(db, U.phy, `select * from revert_nos_to_legacy()`)
      denied('🔴 `revert_nos_to_legacy()` 已 revoke：**教师不能把键写回老学号**', w)

      // ---- ⑫ 第二遍整份 schema.sql：全量幂等（不能因为 §20 已经迁过就报错或再迁）----
      await db.exec(SCHEMA_FULL)
      const after = await q(`select * from serial_migration_report()`)
      ok(
        '🔴 重跑整份 `schema.sql` 之后：硬指标与待迁键**仍然全 0**（这一段可以安全重复执行）',
        after.filter((x) => x.kind !== '查不到的键（留原键 + 出清单）').every((x) => Number(x.n) === 0),
        after.filter((x) => Number(x.n) !== 0).map((x) => `${x.kind}/${x.item}=${x.n}`).join(' · '),
      )
      eq(
        '重跑之后序列号没被改过（学生 1 号仍是原来那个号）',
        (await q(`select serial from students where id = $1`, [S7[0]]))[0].serial,
        serialOf['1'],
      )
    }

    /* ============================================================
       十六、🔴 P5 统一模型（`schema.sql` §31）：**对照法** + 正反两向
       ------------------------------------------------------------
       为什么这一段用"对照法"：
         P5 的失败方式是**静默的** —— 漏一处 `classId` 过滤点不会报错，
         只会让列表少几行（或让走班班的作业谁也看不见）。
         所以这一期的验收口径是**逐行比对**，而不是"看一眼没报错"：
           D  = 完整 `schema.sql` **去掉 §31**（= 改造前：`class_id` 还是 `not null`）
           D' = 完整 `schema.sql`（= 改造后）
         同一个人、同一个查询、同一批数据 → **逐行相等**（走班班为空的那一半）。
       正反两向：
           ① 没有走班班时：改造前后逐行相等（D vs D'）；
           ② 造一个走班班 + 一份挂它的作业：**看得见**（有权限的人）；
           ③ 同一份作业 + **没权限的人**：**看不见**（反向对照 —— 证明 ② 不是恒真）。
       ============================================================ */

    section('十六、P5 统一模型：对照法（改造前 D vs 改造后 D\') + 走班班正反两向')
    {
      /** §31 的起点。D 库 = 砍掉它 = **改造前**（`assignments.class_id` 还是 not null）。 */
      function splitBeforeP5(text) {
        const at = text.indexOf('--  31. 统一模型')
        if (at < 0) throw new Error('schema.sql 里找不到「31. 统一模型」这一节的标题 —— 对照法没法做了')
        const bar = text.lastIndexOf('-- ============', at)
        if (bar < 0) throw new Error('找不到第 31 段上面那条分隔线')
        return text.slice(0, bar)
      }

      const SCHEMA_BEFORE_P5 = splitBeforeP5(applyNegative(RAW_SCHEMA, NEGATIVE))
      /*
       * 🔴 **两边都用"全新的库"**，不能拿上面那个 `db`（B 库）当改造后那一边：
       *    B 库已经被前面的十几节用过了（里面有别的测试建出来的班 / 档案 / 学年行），
       *    那些**侧效应**会让"逐行相等"这条对照变成"两边不一样"的假红 ——
       *    对照法的前提是"**同一批数据、只有 schema 不同**"。
       */
      const Dp = await makeDb(SCHEMA_BEFORE_P5, true) // 改造前（`not null` 还在）
      const D = await makeDb(SCHEMA_FULL, true) // 改造后（全文）

      const CLS_ADMIN2 = mk('c0', 6) // 改造前/后都存在的第 6 个**行政班**
      const CLS_STREAM = mk('c0', 7) // 只有 D' 才建的**走班班**
      const E_STREAM = mk('e0', 20) // 挂走班班的那份作业（`class_id` = 走班班 id）
      const E_ORPHAN = mk('e0', 8) // **未归属**的那份作业（`class_id = null`）
      const STUD = mk('50', 9) // 同时属于两个走班班的学生

      /*
       * 两库灌**同一批数据**（全部落在"改造前就存在的东西"上）：
       *   一个行政班 + 一个学生 + 一份挂它的作业。
       * 这一批是"对照法"的基准 —— 它上面不能有任何走班班。
       */
      const CONTROL_FIXTURE = `
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id) values
      ('${CLS_ADMIN2}', '${U.phy}', '高二(6)班', '高二', '2025',
       (select id from schools order by created_at limit 1),
       (select id from grades where name = '高二'));
    insert into students (id, class_id, student_no, name) values
      ('${STUD}', '${CLS_ADMIN2}', '1', '壬');
    insert into class_subjects (id, class_id, subject, subject_code, teacher_id) values
      ('${mk('c5', 4)}', '${CLS_ADMIN2}', '物理', 'physics', '${U.phy}');
    insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count) values
      ('${mk('e0', 9)}', '${CLS_ADMIN2}', '${U.phy}', '6班物理练习1', '物理', 'physics', '2026-09-23', 10);
      `
      /*
       * ⚠️ **D 库先于 D' 建出来**（`makeDb` 里就灌了）：所以上面这一批要两库都灌。
       *    顺序：先建两个库 → 各自灌对照夹具 → **D' 再建走班班**（下面 ②/③）。
       */
      await Dp.db.exec(CONTROL_FIXTURE)
      await D.db.exec(CONTROL_FIXTURE)

      eq(
        '① 改造前的库：`assignments.class_id` 是 `not null`（对照法的前提）',
        (await Dp.db.query(
          `select attnotnull from pg_attribute
            where attrelid = 'assignments'::regclass and attname = 'class_id'`,
        )).rows[0].attnotnull,
        true,
      )
      eq(
        "① 改造后的库：`assignments.class_id` 已经是可空（`not null` 被去掉）",
        (await D.db.query(
          `select attnotnull from pg_attribute
            where attrelid = 'assignments'::regclass and attname = 'class_id'`,
        )).rows[0].attnotnull,
        false,
      )

      /*
       * ---- ① 对照法：**逐行相等**（8 个身份 × 两张表）----
       *
       * 「改造前 / 改造后」在**查询**这一侧的形状差别只有一处：
       *   改造前的列表页 = 全部档案（那时不可能有走班班，所以"全部"就是"行政班全部"）；
       *   改造后的列表页 = 默认收窄到"有归属且那个班是行政班"（P5 的 kind 读取纪律）。
       * 口径：
       *   · 改造后：`admin_ids` 先挑出行政班（`kind = 'admin'`），再要**那些班**的档案；
       *   · 改造前：**没有 kind 这个列**，所以"行政班集合"取全部班、档案取全部 ——
       *     两库的数据完全一样（改造后库里一个 `kind='stream'` 的行都还没有），
       *     于是两边**必须逐行相等**。任何一处漏判 kind / 漏过滤，这里就会红。
       */
      const ROWS_ALL_CLASSES = `select id from classes order by id`
      const ROWS_ALL_ASSIGNMENTS = `select id from assignments order by id`
      /*
       * 🔴 **对照法里的"改造后"那一侧 —— 这就是 P5 的 kind 读取纪律本身**。
       *    它必须写对，而"写对"这件事靠一条**负向对照**证明：
       *    `RLS_NEGATIVE=p5-lose-kind` 时它退回"不判 kind"的形状
       *    （= P5 之前的写法），纪律那一条断言必须当场变红 —— 否则它就是"永远为绿的摆设"。
       * ⚠️ **`LOSE_KIND` 必须在第 ① 段对照跑完之后才能生效**：第 ① 段比的是
       *    "走班班为空时两库逐行相等"，那时两边本来就该相等，拿掉 kind 也看不出来。
       */
      const ROWS_ADMIN_CLASSES = `select id from classes where kind = 'admin' order by id`
      const ROWS_ADMIN_ASSIGNMENTS_P5 = `
        select a.id from assignments a
         where a.class_id in (select id from classes where kind = 'admin')
         order by a.id`
      const ROWS_ADMIN_ASSIGNMENTS_OLD = `
        select a.id from assignments a
         where a.class_id in (select id from classes)
         order by a.id`

      /*
       * 每一行的 `classes` 快照（名字 / kind / 班型）也要相等 ——
       * 光比 id 会漏掉"kind 判错但恰好 id 集合一样"这一类。
       * ⚠️ 这一句**不判 kind**（两库同一句）：它比的是"逐行形状"，
       *    而"kind 该不该过滤"这件事由上面那两条对照断言负责。
       */
      const classShape = async (dbb, uid) =>
        asUser(dbb, uid, async () => {
          const r = await dbb.query(
            `select id, name, kind, class_type, stream_key from classes order by id`,
          )
          return r.rows.map((x) => [x.id, x.name, x.kind, x.class_type, x.stream_key])
        })
      const compareClassShape = async (label) => {
        let same = true
        const diff = []
        for (const who of ORDER) {
          const a = await classShape(Dp.db, U[who])
          const b = await classShape(D.db, U[who])
          if (JSON.stringify(a) !== JSON.stringify(b)) {
            same = false
            diff.push(`${WHO[who]}：${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
          }
        }
        ok(label, same, diff.join(' | '))
      }

      /*
       * ============================================================
       * 🔴 **对照法（本期的核心验收）**
       * ------------------------------------------------------------
       * 到这一行为止，两库里**一个 `kind='stream'` 的行都还没有**、
       * 也**一份未归属的档案都还没有** —— 正是"改造前那一批数据"。
       * 而下面第 ① 段的每一步都会把这些东西真的造出来，
       * 所以**这一段必须在这里跑完**（造出来之后再跑就不是对照了，见 §2.10 的成本 4）。
       *
       * 查的两侧：
       *   · 改造前（Dp）—— **没有 kind 这一列**，所以"班级列表 = 全部班"、"作业列表 = 全部档案"；
       *   · 改造后（D） —— 走 **P5 的 kind 读取纪律**（行政班集合 → 那些班的档案）。
       * 两库数据逐字相同 → 两边**必须逐行相等**。任何一处漏判 kind / 漏过滤，这里就红。
       * ============================================================
       */
      let controlSame = true
      const controlDiff = []
      for (const who of ORDER) {
        const pairs = [
          [
            `${WHO[who]}·班级列表`,
            await idsAs(Dp.db, U[who], ROWS_ALL_CLASSES),
            await idsAs(D.db, U[who], ROWS_ADMIN_CLASSES),
          ],
          [
            `${WHO[who]}·作业列表`,
            await idsAs(Dp.db, U[who], ROWS_ALL_ASSIGNMENTS),
            await idsAs(D.db, U[who], ROWS_ADMIN_ASSIGNMENTS_P5),
          ],
        ]
        for (const [name, a, b] of pairs) {
          const equal = JSON.stringify(a) === JSON.stringify(b)
          if (!equal) {
            controlSame = false
            controlDiff.push(`${name}：改造前=${JSON.stringify(a)} 改造后=${JSON.stringify(b)}`)
          }
        }
      }
      ok(
        '① 🔴 **对照法**：没有走班班时，8 个身份 × 2 张表（班级列表 / 作业列表）**改造前后逐行相等**',
        controlSame,
        controlDiff.join(' | '),
      )
      /*
       * 补一条"老形状"的对照（与上面同一个意思，但**两边跑同一句 SQL**）：
       *   把"改造后"的查询写成"改造前那种不判 kind"的形状 → 两边必须也相等。
       *   它抓的是"§31 有没有偷偷改掉读路径的**行集**"（而不是"kind 过滤写对没有"）。
       */
      eq(
        '① 补充：同一句"不判 kind"的查询在两库上逐行相等（§31 没改读路径的行集）',
        await idsAs(D.db, U.super, ROWS_ADMIN_ASSIGNMENTS_OLD),
        await idsAs(Dp.db, U.super, ROWS_ALL_ASSIGNMENTS),
      )
      await compareClassShape(
        '① 对照法：同一批数据在两库上 `classes` 的逐行形状（名字/kind/班型/组合）也相等',
      )

      /*
       * ---- ⑤ `assignments.class_id` 可空：行政班作业照旧、未归属作业也能建 ----
       * 先钉"改造前建不出来"（证明这一条不是恒真），再钉"改造后建得出来"。
       *
       * ⚠️ **建成之后要有一条"看得见"的断言**（下面那句 `eq`）—— 只建得出来还不够：
       *    RLS 的两个方向要**同时**对（写策略放行 + 读策略让建档人自己看得见），
       *    否则就是"建了但刷新即没"。
       */
      /*
       * ⚠️ `attempt()` 是**一回合一 rollback**（见 `asUser`）—— 所以"写入之后再看"必须
       *    分成两步：① 用 `attempt` 证明"这条写**被接受**"；② 以**属主身份**把那一行真的插进去，
       *    再用 `idsAs` 验"谁看得见"。两张皮缺一张就会得出相反的错误结论：
       *      · 只看 ① → 不知道建完还看不看得见（"建了但刷新即没"这一类）；
       *      · 只看 ② → 证明不了那条写策略的方向（属主身份绕过 RLS）。
       */
      const orphanWrite = async (dbb, uid, label, id) =>
        attempt(
          dbb,
          uid,
          `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
           values ($1, null, $2, $3, '物理', 'physics', '2026-09-27', 10)`,
          [id, uid, label],
        )
      for (const [label, dbb] of [
        ['改造前的库', Dp.db],
        ['改造后的库', D.db],
      ]) {
        const res = await orphanWrite(dbb, U.phy, '未归属的作业', E_ORPHAN)
        if (label === '改造前的库') {
          denied(`⑤ ${label}：\`class_id = null\` 建不出来（\`not null\` 还在）—— 反向对照`, res)
        } else {
          allowed(`⑤ ${label}：**未归属的作业建得出来**（P5 第 5 条验收）`, res)
        }
      }
      // 超管 / 教务处也建得出未归属的作业（`assignments_write_ok` 里的 `is_school_admin` 那一支）
      allowed(
        '⑤ 教务处也建得出未归属的作业（`super/admin` 那一支仍在）',
        await orphanWrite(D.db, U.admin, '教务处建的未归属作业', mk('e0', 14)),
      )
      // 未归属的行**只由属主落在 D 库里**（改造前那个库建不出来，也不需要）
      await D.db.exec(`
    insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
    values ('${E_ORPHAN}', null, '${U.phy}', '未归属的作业', '物理', 'physics', '2026-09-27', 10);
      `)
      // 行政班作业在**两库上都要照旧建得出来**（改造没有误伤老路径）
      for (const [label, dbb] of [
        ['改造前的库', Dp.db],
        ['改造后的库', D.db],
      ]) {
        const res = await attempt(
          dbb,
          U.phy,
          `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
           values ($1, $2, $3, '行政班作业照旧', '物理', 'physics', '2026-09-27', 10)`,
          [mk('e0', 10), CLS_ADMIN2, U.phy],
        )
        allowed(`⑤ ${label}：行政班作业照旧建得出来`, res)
      }
      /*
       * 未归属的作业**只有建档人自己看得见**（读策略里"看得见这个班"那一支对 null 恒假）。
       * ⚠️ 这正是 §31.3 刻意的口径：放宽成"谁都能建未归属的作业"没有收益，只是多一个说不清的入口。
       */
      eq(
        '⑤ 未归属的作业：建档人自己看得见',
        await idsAs(D.db, U.phy, `select id from assignments where id = $1`, [E_ORPHAN]),
        [E_ORPHAN],
      )
      eq(
        '⑤ 未归属的作业：**同年级的另外三位老师/主任都看不见**（反向对照）',
        [
          ...(await idsAs(D.db, U.chn, `select id from assignments where id = $1`, [E_ORPHAN])),
          ...(await idsAs(D.db, U.grade, `select id from assignments where id = $1`, [E_ORPHAN])),
          ...(await idsAs(D.db, U.head, `select id from assignments where id = $1`, [E_ORPHAN])),
        ],
        [],
      )
      /*
       * 语文老师**建不了**未归属的作业（`teacher_id = auth.uid()` 这一支过不了另一条：
       * `assignments_write_ok` 对未归属只认 super/admin 与"这条 INSERT 的 teacher_id 就是自己"
       * —— 见 §31.3。语文老师把自己写成 `teacher_id` 时当然过得了，所以这条断言换一种打：
       * 让他**替别人建**一份未归属的 → 必须被拒）。
       */
      const other = await attempt(
        D.db,
        U.chn,
        `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
         values ($1, null, $2, '替别人建的未归属作业', '语文', 'chinese', '2026-09-27', 10)`,
        [mk('e0', 12), U.phy],
      )
      denied('⑤ 未归属的作业：**不能替别人建**（`teacher_id` 必须是当前登录者）', other)

      /*
       * 🔴 **反向对照（对照法的那条纪律在这里再钉一次）**：
       *    库里已经有了一份**未归属**的档案（`class_id = null`）——
       *    "默认列表按 kind / 归属收窄"这条纪律**必须把它挡在外面**。
       *    ⚠️ 这一条就是 `RLS_NEGATIVE=p5-lose-kind` 会打红的那一条
       *       （那一侧退回"不判 kind"之后，未归属的行会被一起捞进来）。
       * ⚠️ 用"两个集合的差"而不是"两个身份各自的条数"：`super` 与别人看到的
       *    **行数本来就不一样**（各自建的档案都在），拿两个账号的数字相减是错的对照。
       * ⚠️ 而且必须用**这份档案的建档人**（`U.phy`）来读：未归属的行在 RLS 上
       *    只有建档人看得见（上面刚钉过），拿 `super` 读会两边都是空集 —— 那就成了假对照。
       * 🔴 这一条**同时**是 `RLS_NEGATIVE=p5-lose-kind` 的反向对照：
       *    那一侧退回"不判 kind"之后，未归属的行会被**一起捞进默认列表** → 当场变红。
       */
      {
        /*
         * ⚠️ "老形状"这一句**必须在内存里现写**，不能拿 `ROWS_ADMIN_ASSIGNMENTS_OLD` 顶替 ——
         *    那一句也写了 `class_id in (select id from classes)`，而 `null in (…)` 是 NULL
         *    → **它同样捞不到未归属的行**，两边都一样就等于没对照（本轮实测踩过）。
         *    这里显式写成"**不判归属**"，才是 P5 之前那种"一个字段全捞"的写法。
         */
        const oldShape = await idsAs(D.db, U.phy, `select id from assignments order by id`)
        const newShape = await idsAs(D.db, U.phy, ROWS_ADMIN_ASSIGNMENTS_P5)
        eq(
          '⑤ 反向对照：**未归属的档案不进默认列表**（kind / 归属纪律挡住了它）',
          oldShape.filter((id) => !newShape.includes(id)),
          [E_ORPHAN],
        )
      }
      await compareClassShape('① 造走班班**之前**：两库 `classes` 的逐行形状仍然相等（夹具本身没有偷改 kind）')

      /*
       * ---- ② / ③ 造一个走班班 + 一份挂它的作业：正反两向 ----
       * `classes.kind = 'stream'` 由 `is_school_admin`（超管/教务处）来建 ——
       * 与 `classes_insert` 的既有判据完全一致（**没有新判据**，见 §31.1 的核对）。
       */
      const mkStream = await attempt(
        D.db,
        U.admin,
        `insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, stream_key)
         values ($1, $2, '走班班-物化政', '高二', '2025',
                 (select id from schools order by created_at limit 1),
                 (select id from grades where name = '高二'), 'stream', '物化政')`,
        [CLS_STREAM, U.admin],
      )
      allowed('② 教务处建得出走班班（`classes_insert` 的既有判据不需要动一个字）', mkStream)
      // 反向对照：一位**任课老师**（没有管理身份）建不了班 —— 与改造前同一个结论
      const mkByPhy = await attempt(
        D.db,
        U.phy,
        `insert into classes (id, teacher_id, name, grade, year, school_id, kind)
         values ($1, $2, '走班班-乱建的', '高二', '2025',
                 (select id from schools order by created_at limit 1), 'stream')`,
        [mk('c0', 8), U.phy],
      )
      denied('② 反向对照：**任课老师建不了班**（走班班也不行 —— 判据没有放宽）', mkByPhy)

      /*
       * ⚠️ 这里同样是**两张皮**（见上面 ⑤ 的说明）：
       *   `attempt` 证明"这条写被接受"（然后 rollback），
       *   下面这句 `exec`（属主身份）才把那一行真的留在库里，给后面的"谁看得见"用。
       */
      await D.db.exec(`
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, stream_key)
    values ('${CLS_STREAM}', '${U.admin}', '走班班-物化政', '高二', '2025',
            (select id from schools order by created_at limit 1),
            (select id from grades where name = '高二'), 'stream', '物化政');
    insert into class_subjects (id, class_id, subject, subject_code, teacher_id) values
      ('${mk('c5', 5)}', '${CLS_STREAM}', '物理', 'physics', '${U.phy}');
    insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
    values ('${E_STREAM}', '${CLS_STREAM}', '${U.phy}', '走班班物理练习1', '物理', 'physics', '2026-09-24', 10);
      `)

      // ② 有权限的人（走班班的物理老师）建得出挂它的作业
      const mkStreamAsg = await attempt(
        D.db,
        U.phy,
        `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
         values ($1, $2, $3, '走班班物理练习2', '物理', 'physics', '2026-09-24', 10)`,
        [mk('e0', 15), CLS_STREAM, U.phy],
      )
      allowed('② 走班班的作业**建得出来**（`can_grade_subject` 的入参形状一个字没改）', mkStreamAsg)

      /*
       * ============================================================
       * 🔴 **对照法的反向对照接线证明**（这一段是**承重**的，不是装饰）
       * ------------------------------------------------------------
       * 上面那几条对照断言，在"正常"与"拿掉 kind 纪律"两种情况下**都得成立才叫好断言** ——
       * 但恰恰因此，它们自己**证明不了"开关真的接上了"**。这一轮实测踩过一次
       * （负向模式下"竟然全绿"），根因是 SQL 的三值逻辑：
       * `class_id in (subquery)` 对 `null` **恒不匹配** —— 未归属的行在"两边"都进不来，
       * 于是"拿掉 kind"看不出任何差别（这正是本仓库"假断言"那一类）。
       *
       * 所以这里改用**一句直接问 class_subjects 的 SQL**：
       *   改造后那一库多了一个 `kind='stream'` 的班 + 一份挂它的作业；
       *   `kind='admin'` 那一支**不许**把它算进来。
       *   · 正常模式：`kind='admin'` 的档案 = 8 份（7 份老的 + 控制夹具那份）；
       *   · `RLS_NEGATIVE=p5-lose-kind`：kind 那一支被拿掉 → 变成 9 份 → **当场变红**。
       * 这一条就是"对照法能红"的证明，也是 P5 最怕的那个 bug（漏判 kind = 多捞数据）的形状。
       * ============================================================
       */
      {
        const LOSE_KIND = NEGATIVE === 'p5-lose-kind'
        const countAdminKind = async (dbb) =>
          asUser(dbb, U.super, async () => {
            const r = await dbb.query(
              LOSE_KIND
                ? `select count(*)::int as n from assignments a
                    where a.class_id in (select id from classes)`
                : `select count(*)::int as n from assignments a
                    where a.class_id in (select id from classes where kind = 'admin')`,
            )
            return Number(r.rows[0].n)
          })
        const aSide = await countAdminKind(Dp.db)
        const bSide = await countAdminKind(D.db)
        ok(
          '② 对照法的反向对照**已接线**：改造后"行政班那一支"**没有**多捞走班班那份档案' +
            '（`RLS_NEGATIVE=p5-lose-kind` 时这一条会红 —— 那就是"漏判 kind"的形状）',
          aSide === 7 && bSide === 7,
          `改造前=${aSide} 份 / 改造后=${bSide} 份（都期望 7；拿掉 kind 时改造后会变 8）`,
        )
      }
      // 反向对照：**不在这个走班班任教**的语文老师建不出来
      const mkStreamByChn = await attempt(
        D.db,
        U.chn,
        `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
         values ($1, $2, $3, '走班班语文练习（不该建出来）', '语文', 'chinese', '2026-09-24', 10)`,
        [mk('e0', 13), CLS_STREAM, U.chn],
      )
      denied('③ 反向对照：**不在走班班任教的老师建不出这份作业**', mkStreamByChn)

      // ② 有权限的人看得见走班班 + 它那份作业
      eq('② 走班班的物理老师看得见这个走班班', await idsAs(D.db, U.phy, `select id from classes where id = $1`, [CLS_STREAM]), [CLS_STREAM])
      eq('② 走班班的物理老师看得见挂它的那份作业', await idsAs(D.db, U.phy, `select id from assignments where id = $1`, [E_STREAM]), [E_STREAM])
      eq('② 教务处（全校）也看得见', await idsAs(D.db, U.admin, `select id from classes where id = $1`, [CLS_STREAM]), [CLS_STREAM])
      eq('② 本年级的年级主任也看得见（`grade_id` 那一支对走班班天然成立）', await idsAs(D.db, U.grade, `select id from classes where id = $1`, [CLS_STREAM]), [CLS_STREAM])

      // ③ 反向对照：与本走班班无关的人看不见
      eq('③ 反向对照：语文老师看不见这个走班班', await idsAs(D.db, U.chn, `select id from classes where id = $1`, [CLS_STREAM]), [])
      eq('③ 反向对照：语文老师看不见走班班的那份作业', await idsAs(D.db, U.chn, `select id from assignments where id = $1`, [E_STREAM]), [])
      eq('③ 反向对照：另一位年级的老师/新老师也看不见', await idsAs(D.db, U.fresh, `select id from classes where id = $1`, [CLS_STREAM]), [])

      /*
       * ---- ④ `class_members` 多对多：**一个学生同时属于两个走班班**（U-1 = A）----
       * 这一条钉的是"多对多不能被写成一门一对一"。
       */
      const CLS_STREAM2 = mk('c0', 9)
      await D.db.exec(`
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, stream_key)
    values ('${CLS_STREAM2}', '${U.admin}', '走班班-物化生', '高二', '2025',
            (select id from schools order by created_at limit 1),
            (select id from grades where name = '高二'), 'stream', '物化生');
    insert into class_members (class_id, student_id) values
      ('${CLS_STREAM}',  '${STUD}'),
      ('${CLS_STREAM2}', '${STUD}');
      `)
      eq(
        '④ 一个学生**同时在两个走班班里**（多对多，U-1 = A）：两条成员关系都在',
        (await D.db.query(
          `select count(*)::int as n from class_members where student_id = $1`,
          [STUD],
        )).rows[0].n,
        2,
      )
      eq(
        '④ 反过来：一个走班班有几个成员也数得出来',
        (await D.db.query(`select count(*)::int as n from class_members where class_id = $1`, [CLS_STREAM])).rows[0].n,
        1,
      )
      eq(
        '④ 走班班的成员读得到（读策略跟"看得见这个班"走）—— 走班班的物理老师看得见',
        await idsAs(D.db, U.phy, `select student_id as id from class_members where class_id = $1`, [CLS_STREAM]),
        [STUD],
      )
      const cmWrite = await attempt(
        D.db,
        U.phy,
        `insert into class_members (class_id, student_id) values ($1, $2)`,
        [CLS_STREAM2, S.s1],
      )
      denied('④ `class_members` 客户端**零写权限**（P7 走服务端）', cmWrite)

      /*
       * ---- ⑥ 反指标：布置作业**没有新增任何必填项** ----
       * 判据不是"读界面"（那是 `shots.mjs` 的活），而是**载荷形状**：
       *   · `assignmentToRow()` 的列集**与改造前一模一样**（`class_id` 本来就在里面）；
       *   · "未归属"只是 `classId` 的一种取值（空串 → 载荷 `null`），**不是新列**；
       *   · 老师不碰它 → 一切与改造前相同（默认值仍是有归属的班，见 `AssignmentNew`）。
       */
      const probeAsg = localAssignment({ id: E.a1, classId: C.c1 })
      const rowOld = M.assignmentToRow(probeAsg, U.phy)
      eq(
        '⑥ 反指标：`assignmentToRow` 的列集**与改造前一模一样**（没有新增任何手工录入字段）',
        Object.keys(rowOld).sort(),
        [
          'assign_date', 'class_id', 'collected', 'confirmed_nos', 'corrected_nos',
          'correction_nos', 'focus_nos', 'grade_seconds', 'graded_at', 'grades', 'id',
          'late_nos', 'missing_nos', 'question_count', 'question_meta', 'stats_mode',
          'status', 'sub_questions', 'subject', 'teacher_id', 'template_id', 'title', 'wrong',
        ],
      )
      eq(
        '⑥ 反指标：未归属**只是空串**，不是新字段（`classId: ""` → 载荷 `class_id: null`）',
        M.assignmentToRow(localAssignment({ id: E.a2, classId: '' }), U.phy).class_id,
        null,
      )
      ok(
        '⑥ 「未归属」的判据**只有一处**（`lib/assignments.ts` 的 `isUnassigned`），页面里没有第二种写法',
        ASG.isUnassigned('') === true && ASG.isUnassigned(null) === true && ASG.isUnassigned(CLS_ADMIN2) === false,
      )

      /*
       * ---- ⑦ `kind` 漏判的**机器审计** ----
       * P5 的施工单要求"逐处清单"（那是文档产物，见 `功能设计与不变量.md` §三十一）；
       * 这里再补一条**能红的**机器断言：页面上不许出现"手写 `kind === 'stream'`"这种判定
       * （= 第二个判定入口），一律走 `lib/pick.ts` 的 `classKindOf()` / `isStreamClass()`。
       *
       * ⚠️ 两处**豁免**（它们不是"判定"，是"行 → 模型"的归一化）：
       *    `data/remote.ts` 与 `data/gradeSetup.ts` 里把数据库那一列读进来的
       *    `row.kind === 'stream' ? { kind: 'stream' } : {}` —— 那是**唯一的映射口**，
       *    去掉它前端就没有 kind 可判了。所以正则把 `row.kind` 排除掉，
       *    只抓页面/业务层里对**模型对象**的手写判断。
       * ⚠️ 还要**逐行剔掉注释**：纪律本身就得写成 `不许再写 kind === 'stream'`
       *    （本轮实测被自己的注释判了一次假红 —— 注释里出现这个词是必然的）。
       */
      const srcFiles = [
        'src/pages/Classes.tsx',
        'src/pages/WrongBook.tsx',
        'src/pages/Assignments.tsx',
        'src/pages/AssignmentNew.tsx',
        'src/pages/Workbench.tsx',
        'src/pages/GradeDetail.tsx',
        'src/pages/GradeSetup.tsx',
        'src/pages/ClassDetail.tsx',
        'src/pages/ExamNew.tsx',
        'src/data/store.ts',
      ].map((p) => readFileSync(resolvePath(APP, p), 'utf8'))
      const codeOf = (t) =>
        t
          .split('\n')
          .filter((line) => {
            const s = line.trim()
            return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
          })
          .join('\n')
      const handKind = srcFiles.filter((t) => /[^.\w]kind\s*===\s*'stream'/.test(codeOf(t))).length
      const pickSrc = readFileSync(resolvePath(APP, 'src/lib/pick.ts'), 'utf8')
      eq('⑦ `kind` 的手写判定**只有 `lib/pick.ts` 一处**（10 个页面/数据文件里没有第二处）', handKind, 0)
      ok(
        '⑦ 而 `lib/pick.ts` 里确实有那唯一一处（证明上面不是"文件读错了"的假绿）',
        /k\?\.kind === 'stream'/.test(pickSrc),
      )
      const rowMap = readFileSync(resolvePath(APP, 'src/data/remote.ts'), 'utf8')
      ok(
        '⑦ "行 → 模型"的 kind 映射确实在（`remote.ts` 读库那一行；两处豁免的根据）',
        /row\.kind === 'stream'/.test(rowMap),
      )

      /* ============================================================
         十七、🆕 P9：教室端的两块新能力（`schema.sql` §33）
         ------------------------------------------------------------
         Q17：走班班的屏**有屏但只读**（只看作业与考试；**不接呼叫**；**不许能写**）
         Q32 = C：**允许呼叫不挂作业**（事务性呼叫 —— 班主任 / 教导处从班级管理直接叫人）

         🔴 这一节的形状照 `功能设计与不变量.md` §十七·补：**单独收紧 + 反向对照断言**。
            所以"零写"那一段是**逐动作**列的，而且每一条都能被 `RLS_NEGATIVE=p9-stream-write` 弄红。
         ============================================================ */
      section('十七、🆕P9：走班班的屏（只读作业 + 只读考试 + 走班班零写 + 不接呼叫）+ 事务性呼叫')

      const R2 = mk('a0', 9)          // 走班班那块屏的账号（`classroom_accounts.id` 就是它的 auth uid）
      const CS_BIO = mk('c0', 10)     // 走班班-生物（`stream_key = 'biology'`）
      const CS_GEO = mk('c0', 11)     // 走班班-地理
      const CS_CHEM = mk('c0', 12)    // 走班班-化学
      const ASG_STREAM = mk('e0', 30) // 挂走班班的作业（教室端要"读得到"的那一份）
      const EX_STREAM = mk('e1', 30)  // 挂走班班的考试
      const S9 = mk('50', 10)         // 走班生：行政班 c1，走班班-生物
      const CALL_TX = mk('ca', 3)     // 事务性呼叫（`assignment_id` 为空）
      const CALL_STREAM = mk('ca', 4) // 走班班上的一条呼叫（给"改/删"两条探针当靶子）
      const SCH_STREAM = mk('5c', 30) // 走班班上的一条课表（给"改/删"两条探针当靶子）

      await D.db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${R2}', 'room2@shugao.test', '{"name":"走班班生物教室"}'::jsonb);

    -- 走班班：**单科一个班**（stream_key = 科目代码 —— 与 lib/stream.ts 的 streamKeyOf 同口径）
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, stream_key) values
      ('${CS_BIO}',  '${U.phy}', '走班班-生物', '高二', '2025', (select id from schools order by created_at limit 1), (select id from grades where name = '高二'), 'stream', 'biology'),
      ('${CS_GEO}',  '${U.phy}', '走班班-地理', '高二', '2025', (select id from schools order by created_at limit 1), (select id from grades where name = '高二'), 'stream', 'geography'),
      ('${CS_CHEM}', '${U.phy}', '走班班-化学', '高二', '2025', (select id from schools order by created_at limit 1), (select id from grades where name = '高二'), 'stream', 'chemistry');

    -- 班主任那个班设成理科班（P10 的"内容自动迁移"要靠班型算 walk）
    update classes set class_type = 'science' where id = '${C.c1}';

    -- 走班生：**行政班是 c1**（所以他的呼叫落 c1 那块屏 —— Q17）；走班班-生物
    insert into students (id, class_id, student_no, name) values ('${S9}', '${C.c1}', '9', '壬');
    insert into class_members (class_id, student_id) values ('${CS_BIO}', '${S9}');

    -- 走班班上的一份作业 + 一场考试（教室端"读得到"的那两样）
    --   ⚠️ 走班班的任教关系**要有**（P7 的"分配走班老师"会补）：不然连那位老师都看不见它
    insert into class_subjects (id, class_id, subject, subject_code, teacher_id) values
      ('${mk('c5', 40)}', '${CS_BIO}', '生物', 'biology', '${U.phy}');
    insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count)
    values ('${ASG_STREAM}', '${CS_BIO}', '${U.phy}', '走班班生物练习1', '生物', 'biology', '2026-09-25', 10);
    insert into exams (id, teacher_id, title, paper_key, subject, subject_code, scope, grade, source, mode, exam_date, question_count, class_ids, absent_nos)
    values ('${EX_STREAM}', '${U.phy}', '走班班生物练习8', '生物练习8', '生物', 'biology', 'class', '高二', 'manual', 'scores', '2026-09-25', 10, array['${CS_BIO}']::uuid[], '{}');

    -- 走班班上的一条呼叫 + 一条课表（**只给"改 / 删"两条探针当靶子**，正常路径建不出它们）
    insert into calls (id, teacher_id, assignment_id, class_id, text)
    values ('${CALL_STREAM}', '${U.phy}', '${ASG_STREAM}', '${CS_BIO}', '走班班上的呼叫');
    insert into schedule_items (id, teacher_id, weekday, start_time, end_time, title, class_id, scope)
    values ('${SCH_STREAM}', '${U.phy}', 2, '15:00', '15:40', '走班班生物', '${CS_BIO}', 'class');

    -- 另一个学生的选科行（给"教室端能不能改选科"那条探针当靶子）
    insert into student_subjects (student_id, primary_code, second_codes, kind)
    values ('${S.s1}', 'physics', array['chemistry','biology'], 'standard');

    -- 教室端账号：**指向走班班那一行**（§2.11 的结论：class_id 本来就能指它）
    insert into classroom_accounts (id, class_id, name, email, created_by)
    values ('${R2}', '${CS_BIO}', '走班班生物教室', 'room2@shugao.test', '${U.phy}');
      `)

      /* ---- ① 读得到：作业 + 考试（Q17 的"只看作业和考试"）---- */
      eq(
        '① 走班班的屏**读得到**挂在它上的作业（Q17：只读作业）',
        await idsAs(D.db, R2, `select id from assignments where id = $1`, [ASG_STREAM]),
        [ASG_STREAM],
      )
      eq(
        '① 走班班的屏**读得到**挂在它上的考试（Q17：只读考试）',
        await idsAs(D.db, R2, `select id from exams where id = $1`, [EX_STREAM]),
        [EX_STREAM],
      )
      eq(
        '① 反向对照：走班班的屏读不到**行政班**的作业',
        await idsAs(D.db, R2, `select id from assignments where id = $1`, [E.a1]),
        [],
      )
      eq(
        '① 反向对照：走班班的屏读不到**别班**的考试',
        await idsAs(D.db, R2, `select id from exams where id = $1`, [EX.e1]),
        [],
      )

      /* ---- ② 🔴 零写：**逐动作**（这一期的红线；`RLS_NEGATIVE=p9-stream-write` 时必须红）---- */
      const streamWriteProbes = [
        ['assignments 插一行', `insert into assignments (id, class_id, teacher_id, title, subject, subject_code, assign_date, question_count) values ($1, $2, $3, '教室端试写', '生物', 'biology', '2026-09-26', 10)`, [mk('e0', 41), CS_BIO, R2]],
        ['assignments 改一行', `update assignments set title = '被教室端改名了' where id = $1 returning id`, [ASG_STREAM]],
        ['assignments 删一行', `delete from assignments where id = $1 returning id`, [ASG_STREAM]],
        ['students 改一行', `update students set name = '被教室端改名了' where id = $1 returning id`, [S9]],
        ['students 删一行', `delete from students where id = $1 returning id`, [S9]],
        ['calls 插一行（作业呼叫）', `insert into calls (id, teacher_id, assignment_id, class_id, text) values ($1, $2, $3, $4, '教室端试写')`, [mk('ca', 5), R2, ASG_STREAM, CS_BIO]],
        ['calls 改一行', `update calls set text = '被教室端改了' where id = $1 returning id`, [CALL_STREAM]],
        ['calls 删一行', `delete from calls where id = $1 returning id`, [CALL_STREAM]],
        ['exams 插一行', `insert into exams (id, teacher_id, title, subject, subject_code, scope, grade, source, mode, exam_date, question_count, class_ids) values ($1, $2, '教室端试写', '生物', 'biology', 'class', '高二', 'manual', 'scores', '2026-09-26', 10, array[$3]::uuid[])`, [mk('e1', 41), R2, CS_BIO]],
        ['exam_scores 插一行', `insert into exam_scores (id, exam_id, class_id, student_no, name) values ($1, $2, $3, '9', '壬')`, [mk('e2', 41), EX_STREAM, CS_BIO]],
        ['schedule_items **往自己那个走班班插**（§33.4 本轮唯一新增的收窄）', `insert into schedule_items (id, teacher_id, weekday, start_time, end_time, title, class_id, scope) values ($1, $2, 3, '15:00', '15:40', '教室端试写', $3, 'class')`, [mk('5c', 31), R2, CS_BIO]],
        ['schedule_items 改走班班那一行', `update schedule_items set title = '被教室端改了' where id = $1 returning id`, [SCH_STREAM]],
        ['schedule_items 删走班班那一行', `delete from schedule_items where id = $1 returning id`, [SCH_STREAM]],
        ['shared_files 插一行', `insert into shared_files (id, teacher_id, class_id, class_ids, name, mime, size, storage_path) values ($1, $2, $3, array[$3]::uuid[], '教室端想传的.png', 'image/png', 10, $4)`, [mk('f0', 41), R2, CS_BIO, `${R2}/hh-教室端.png`]],
        ['classes 插一行', `insert into classes (id, teacher_id, name, grade, year) values ($1, $2, '教室端建的班', '高二', '2025')`, [mk('c0', 41), R2]],
        ['class_members 插一行', `insert into class_members (class_id, student_id) values ($1, $2)`, [CS_GEO, S9]],
        ['student_subjects 改一行', `update student_subjects set primary_code = 'history' where student_id = $1 returning student_id`, [S.s1]],
        ['teachers 改自己那一行', `update teachers set name = '走班班那块屏把自己改名了' where id = $1 returning id`, [R2]],
      ]
      for (const [name, sql, params] of streamWriteProbes) {
        denied(`🔴 走班班的屏 ${name}`, await attempt(D.db, R2, sql, params))
      }
      /* 反向对照（"收紧不许误伤"）：**行政班那块屏照旧能粘贴本班课表** ——
         §11.1 的两处有限写一个字没动，§33.4 只收窄了"走班班"那一半。 */
      allowed(
        '② 反向对照：**行政班**的教室端仍然能粘贴本班课表（§11.1 那两处有限写没被误伤）',
        await attempt(
          D.db,
          U.room,
          `insert into schedule_items (id, teacher_id, weekday, start_time, end_time, title, class_id, scope)
           values ($1, $2, 4, '15:00', '15:40', '教室端粘贴的课', $3, 'class')`,
          [mk('5c', 32), U.room, C.c1],
        ),
      )

      /* ---- ③ `calls.assignment_id` 允许为空（Q32 = C 的破坏性迁移）---- */
      {
        const nn = await D.db.query(
          `select attnotnull from pg_attribute
            where attrelid = 'calls'::regclass and attname = 'assignment_id'`,
        )
        eq('③ `calls.assignment_id` **允许为空**（Q32 = C；旧列级 not null 已去掉）', Boolean(nn.rows[0].attnotnull), false)
      }

      /* ---- ④ 事务性呼叫：谁能发（**判据在数据库**；两条路共用 `can_call`）---- */
      /*
       * 一条事务性呼叫的载荷（**前端真实形状**）：`assignment_id` 为 `null`、
       * `teacher_id` 必须是调用者自己（`calls_insert` 里那一句一个字没改）。
       * `student_nos` 里放的是**档案键**（序列号优先 —— 与 `lib/keys.ts` 的 `archiveKeyOf` 同口径）。
       */
      const TX_SQL = `insert into calls (id, teacher_id, assignment_id, class_id, student_nos, text)
           values ($1, $2, null, $3,
                   array[(select coalesce(nullif(btrim(coalesce(s.serial,'')),''), s.student_no) from students s where s.id = $4)],
                   '请壬同学到办公室')`
      allowed(
        '⑤ 事务性呼叫：**班主任**从班级管理直接叫人（`assignment_id` 为空）→ 通过',
        await attempt(D.db, U.head, TX_SQL, [CALL_TX, U.head, C.c1, S9]),
      )
      allowed(
        '⑤ 事务性呼叫：**教务处**也能发',
        await attempt(D.db, U.admin, TX_SQL, [mk('ca', 6), U.admin, C.c1, S9]),
      )
      allowed(
        '⑤ 事务性呼叫：**本年级的年级主任**也能发',
        await attempt(D.db, U.grade, TX_SQL, [mk('ca', 7), U.grade, C.c1, S9]),
      )
      denied(
        '🔴 反向对照：**科任老师**发事务性呼叫 → 被拒（他没有班级管理权 —— Q32 = C 的口径）',
        await attempt(D.db, U.phy, TX_SQL, [mk('ca', 8), U.phy, C.c1, S9]),
      )
      allowed(
        '⑤ 反向对照：**作业呼叫**一个字没被收窄 —— 科任老师照样能发（老口径 `teaches_in_class`）',
        await attempt(
          D.db,
          U.phy,
          `insert into calls (id, teacher_id, assignment_id, class_id, text) values ($1, $2, $3, $4, '作业呼叫')`,
          [mk('ca', 9), U.phy, E.a1, C.c1],
        ),
      )
      denied(
        '🔴 事务性呼叫的归属**不许是走班班**（Q17：走班班的屏不接呼叫）—— 教务处也不行',
        await attempt(
          D.db,
          U.admin,
          `insert into calls (id, teacher_id, assignment_id, class_id, text) values ($1, $2, null, $3, '想发到走班班')`,
          [mk('ca', 10), U.admin, CS_BIO],
        ),
      )
      /*
       * ⚠️ **两张皮**（与 §十六 那一段同一个理由）：上面 `attempt` 证明"这条写被接受"，
       *    但它整条包在一个事务里、**最后 rollback**（它只判策略，不留数据）。
       *    下面这一句（属主身份）才把那条呼叫**真的留在库里**，给"谁看得见"那几条用。
       */
      await D.db.exec(`
    insert into calls (id, teacher_id, assignment_id, class_id, student_nos, text)
    values ('${CALL_TX}', '${U.head}', null, '${C.c1}',
            array[(select coalesce(nullif(btrim(coalesce(s.serial,'')),''), s.student_no) from students s where s.id = '${S9}')],
            '请壬同学到办公室');
      `)

      /* ---- ⑦ 可见范围：事务性呼叫**落行政班**（这一节的核心断言）---- */
      eq(
        '⑦ 给一个**走班生**发的呼叫，出现在他**行政班**的教室端（c1）',
        await idsAs(D.db, U.room, `select id from calls where id = $1`, [CALL_TX]),
        [CALL_TX],
      )
      eq(
        '🔴 走班班的屏**收不到呼叫**（Q17：一块都读不到 —— 连它自己那个走班班上的作业呼叫也读不到）',
        await countAs(D.db, R2, `select count(*)::int as n from calls`),
        0,
      )
      ok(
        '⑦ 反向对照：**行政班**那块屏照旧读得到本班的呼叫（§33.5 的收窄没有误伤它）',
        (await idsAs(D.db, U.room, `select id from calls where id = $1`, [CALL_TX])).length === 1,
      )
      eq(
        '⑦ 反向对照：换一个不该看见这条呼叫的人（高一的新老师）→ 看不见',
        await idsAs(D.db, U.fresh, `select id from calls where id = $1`, [CALL_TX]),
        [],
      )
      eq(
        '⑦ 而这条呼叫的班主任看得见（他管这个班）',
        await idsAs(D.db, U.head, `select id from calls where id = $1`, [CALL_TX]),
        [CALL_TX],
      )

      /* ---- ⑧ `assignment_id is null` 的兼容：**三处读都不丢行** ----
         判据是"一条事务性呼叫在任何一处都不会因为 null 被筛掉"：
           · 教室端轮询（`loadRecentCalls` → `select('*')` 按 class_id 取）；
           · `rowToCall` / `callToRow` 的双向映射（`''↔null`，**只此一处**）；
           · 统计页按 `assignment_id` 分组时不把它算进任何一份作业。 */
      {
        const c = await asUser(D.db, U.room, async () => {
          const r = await D.db.query(`select * from calls where class_id = $1 order by created_at desc limit 20`, [C.c1])
          return r.rows.map((x) => M.rowToCall(x))
        })
        const tx = c.find((x) => x.id === CALL_TX)
        ok(
          '⑧ 教室端轮询读到的这条事务性呼叫：`assignmentId` 收敛成空串（不是 null / 不是 undefined）',
          Boolean(tx) && tx.assignmentId === '',
          tx ? `assignmentId=${JSON.stringify(tx.assignmentId)}` : '没读到那一行',
        )
        const back = M.callToRow(tx, U.head)
        eq('⑧ 再写回去：空串 → 载荷里的 `null`（只此一处映射，PostgREST 不会拿空串去比 uuid）', back.assignment_id, null)
        ok(
          '⑧ 统计页按 `assignmentId` 分组时，它**不会**被算进任何一份作业（空串 ≠ 任何档案 id）',
          c.filter((x) => x.assignmentId === E.a1).every((x) => x.id !== CALL_TX),
        )
      }

      /* ============================================================
         十八、🆕 P10：收尾（`schema.sql` §34）
         ------------------------------------------------------------
         ① 选科变更审计（Q27 = B：三个人都能改 → 出问题要能查）
         ② 旧科目数据**经确认后**删除（Q20 = A）—— 不确认就删不掉
         ③ 休学档位 + 转班/转学移出走班名单（Q28 = B）
         ④ `subjects.can_stream` 废弃登记（P7 已做，§32.6）
         ============================================================ */
      section('十八、🆕P10：选科变更审计 + 旧科目数据二次确认删除 + 休学档位（§34）')

      const chgCount = async () => Number(
        (await D.db.query(`select count(*)::int as n from student_subject_changes where student_id = $1`, [S9]))
          .rows[0].n,
      )
      const subjectOf = async () =>
        (await D.db.query(`select kind, primary_code, second_codes from student_subjects where student_id = $1`, [S9]))
          .rows[0] ?? null
      const membersOf9 = async () =>
        (await D.db.query(`select class_id from class_members where student_id = $1 order by class_id`, [S9]))
          .rows.map((r) => r.class_id)
      const writeSubject = (actor, kind, primary, second, note = '', memberIds = []) =>
        D.db.query(
          `select public.write_student_subject($1::uuid, $2::uuid, $3::text, $4::text, $5::text[], $6::text, $7::uuid[]) as v`,
          [actor, S9, kind, primary, second, note, memberIds],
        )
      const tryWriteSubject = async (actor, ...args) => {
        try {
          await writeSubject(actor, ...args)
          return { ok: true, message: '' }
        } catch (e) {
          return { ok: false, message: shortErr(e) }
        }
      }

      /* ---- ① 改一次选科 → 记录**恰好一条**（`before` / `after` 是科目代码快照）---- */
      await writeSubject(U.head, 'standard', 'physics', ['chemistry', 'geography'])
      eq('① 改一次选科 → `student_subject_changes` 里**恰好一条**', await chgCount(), 1)
      {
        /* ⚠️ 判空行不行都要**走到断言**（负向对照要"断言红"，不是"脚本炸"） */
        const row = (await D.db.query(
          `select before, after, changed_by from student_subject_changes where student_id = $1`,
          [S9],
        )).rows[0] ?? null
        eq('① 记录里的"**谁改的**"= 那个班主任（Q27：三个人都能改，所以要能查）', row?.changed_by ?? null, U.head)
        eq('① 记录里的"**改前**"是空快照（这位学生第一次采选科）', row?.before ?? null, {})
        eq(
          '① 记录里的"**改成什么**"用**科目代码**、不用姓名',
          { primary: row?.after?.primary ?? null, second: row?.after?.second ?? null },
          { primary: 'physics', second: ['chemistry', 'geography'] },
        )
      }
      /* 原样再存一次**不写第二条**（否则"变更记录"会被无意义的保存刷满） */
      await writeSubject(U.head, 'standard', 'physics', ['chemistry', 'geography'])
      eq('① 内容没变时**不会再写一条**（这不是"每次保存都记一笔"）', await chgCount(), 1)

      /* ---- ② 内容自动迁移：走班班成员按新选科**立刻重算**（Q20 = A 的另一半）---- */
      eq(
        '② 内容自动迁移：理科班 + 物化地 → walk = {地理} → 成员只剩**走班班-地理**',
        await membersOf9(),
        [CS_GEO],
      )
      const mismatch = await tryWriteSubject(U.head, 'standard', 'history', ['politics', 'geography'])
      ok('② 「首选与班型不符」照样能存（那是"建议转班"，不是拒绝）', mismatch.ok, mismatch.message)
      eq(
        '② ⚠️「认不出就不动」：首选与班型不符 → 走班班成员**原样不动**（不许自动清空）',
        await membersOf9(),
        [CS_GEO],
      )
      await writeSubject(U.head, 'standard', 'physics', ['chemistry', 'biology'])
      eq('② walk = 空（物化生 = 理科班默认）→ 成员被清空', await membersOf9(), [])
      eq('② 而这三次改动一共留下三条记录', await chgCount(), 3)
      eq(
        '② 已发出的作业档案**一个字都没动**（I54：历史档案是快照）',
        await countAs(D.db, U.phy, `select count(*)::int as n from assignments where id = $1`, [ASG_STREAM]),
        1,
      )

      /* ---- ③ 一个事务：写一半不许留下（审计与选科**同生共死**）---- */
      {
        const before = await subjectOf()
        const n0 = await chgCount()
        /* 「其他」+ 选了一个**行政班** → 在 `student_subject_changes` **之后**那一支才报错：
           这正是"两次 PostgREST 请求 = 两个事务"会留下半截的那种失败。 */
        const r = await tryWriteSubject(U.head, 'other', 'physics', ['chemistry', 'biology'], '转学插班', [C.c2])
        ok('③ 「其他」选了非走班班 → **显式报错**（不静默）', !r.ok && /走班班/.test(r.message), r.message)
        eq('③ 🔴 同一个事务：报错之后 `student_subjects` **一个字没改**（不是"改了一半"）', await subjectOf(), before)
        eq('③ 🔴 同一个事务：审计记录也**没留下**（否则就成了"改了但没记"或"记了但没改"）', await chgCount(), n0)
      }

      /* ---- ④ 写权限：**前端一个字都不许写**这张审计表 ---- */
      denied(
        '④ `student_subject_changes` 客户端**插**一行 → 被拒（与 class_subjects / class_members 同一条纪律）',
        await attempt(D.db, U.head, `insert into student_subject_changes (student_id, before, after) values ($1, '{}'::jsonb, '{}'::jsonb)`, [S9]),
      )
      denied(
        '④ 客户端**改**一行 → 被拒',
        await attempt(D.db, U.super, `update student_subject_changes set note = '偷改' where student_id = $1 returning id`, [S9]),
      )
      denied(
        '④ 客户端**删**一行 → 被拒',
        await attempt(D.db, U.super, `delete from student_subject_changes where student_id = $1 returning id`, [S9]),
      )

      /* ---- ⑤ 读的判据：能改的人才能看（Q27：「要能查」）---- */
      const chgSeen = async (uid) =>
        countAs(D.db, uid, `select count(*)::int as n from student_subject_changes where student_id = $1`, [S9])
      ok('⑤ 班主任看得见自己班学生的变更记录', (await chgSeen(U.head)) >= 1)
      ok('⑤ 本年级的年级主任看得见', (await chgSeen(U.grade)) >= 1)
      ok('⑤ 教务处 / 超管看得见', (await chgSeen(U.admin)) >= 1 && (await chgSeen(U.super)) >= 1)
      eq('⑤ 反向对照：与本班无关的老师（高一的新老师）→ **0 行**', await chgSeen(U.fresh), 0)
      eq(
        '⑤ 反向对照：**教室端**（学生碰得到那台机器）→ **0 行**（"谁改了谁的选科"是人事留痕，不是教学内容）',
        await chgSeen(U.room),
        0,
      )

      /* ---- ⑥ 旧科目数据：**不确认就删不掉**（Q20 = A）---- */
      {
        /* 先把"旧科目数据"造出来：一次改动把**生物**放弃掉，并留下两条"该删的东西"：
             ㈠ 他在 c1 的生物考试成绩行；㈡ 走班班-生物的成员关系残留（模拟"手工选过班"）。 */
        await writeSubject(U.head, 'standard', 'physics', ['chemistry', 'geography'])
        const EX_BIO = mk('e1', 42)
        await D.db.exec(`
    insert into exams (id, teacher_id, title, paper_key, subject, subject_code, scope, grade, source, mode, exam_date, question_count, class_ids, absent_nos)
    values ('${EX_BIO}', '${U.head}', '高二(1)班生物练习8', '生物练习8', '生物', 'biology', 'class', '高二', 'manual', 'scores', '2026-09-23', 10, array['${C.c1}']::uuid[], '{}');
    insert into exam_scores (id, exam_id, class_id, student_no, name, graded, total)
    values ('${mk('e2', 42)}', '${EX_BIO}', '${C.c1}',
            (select coalesce(nullif(btrim(coalesce(s.serial,'')),''), s.student_no) from students s where s.id = '${S9}'),
            '壬', true, 77);
    insert into class_members (class_id, student_id) values ('${CS_BIO}', '${S9}');
        `)

        const counts = await D.db.query(
          `select public.old_subject_data_counts_for($1::uuid, $2::uuid) as v`,
          [U.head, S9],
        )
        const cv = counts.rows[0].v
        ok(
          '⑥ 「将删除什么」的清单由**数据库算**：被放弃的科目里有生物，且考试成绩 ≥1 条、走班班成员 ≥1 条',
          cv.oldSubjects.includes('biology') && Number(cv.scores) >= 1 && Number(cv.members) >= 1,
          JSON.stringify(cv),
        )
        const scoreLeft = () => countAs(D.db, U.super, `select count(*)::int as n from exam_scores where exam_id = $1`, [EX_BIO])
        const bioMemberLeft = () => countAs(D.db, U.super, `select count(*)::int as n from class_members where class_id = $1 and student_id = $2`, [CS_BIO, S9])
        eq('⑥ 删之前：那条生物成绩行在', await scoreLeft(), 1)

        const noConfirm = await (async () => {
          try {
            await D.db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean)`, [U.head, S9, false])
            return { ok: true, message: '' }
          } catch (e) {
            return { ok: false, message: shortErr(e) }
          }
        })()
        ok(
          '🔴 不确认（`p_confirm = false`）→ **报错，一条都不删**；报错里带着"将删除 N 条记录（不可恢复）"',
          !noConfirm.ok && /二次确认/.test(noConfirm.message) && /不可恢复/.test(noConfirm.message),
          noConfirm.message,
        )
        eq('🔴 反向对照（删不掉那一半）：成绩行**还在**', await scoreLeft(), 1)
        eq('🔴 反向对照（删不掉那一半）：走班班成员残留**还在**', await bioMemberLeft(), 1)

        await D.db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean)`, [U.head, S9, true])
        eq('⑥ 确认之后：那条生物成绩行**被删掉**（不可恢复）', await scoreLeft(), 0)
        eq('⑥ 确认之后：走班班成员残留也清掉', await bioMemberLeft(), 0)
        const row = (await D.db.query(
            `select purged_at, purged_by, purge_counts from student_subject_changes
              where student_id = $1 and purged_at is not null order by changed_at desc limit 1`,
            [S9],
          )).rows[0]
        ok('⑥ 删除**留了审计**：`purged_at` / `purged_by` / `purge_counts` 都写上了', Boolean(row) && row.purged_by === U.head && Number(row.purge_counts.scores) >= 1)
        /*
         * ⚠️ 这里全部用可选链 + 显式判空：`RLS_NEGATIVE=p10-no-audit` 时审计插入被拿掉，
         *    上面那几条会**红**；但如果这里写 `rows[0].purge_counts`，脚本会**先抛 TypeError 崩掉** ——
         *    负向对照要的是"断言变红"，不是"脚本炸了"（后者会掩盖掉"到底哪条断言在起作用"）。
         */
        const purgedRow = (await D.db.query(
          `select id, purge_counts from student_subject_changes
            where student_id = $1 and purged_at is not null order by changed_at desc limit 1`,
          [S9],
        )).rows[0]
        const purgedId = purgedRow?.id ?? null
        const countsBefore = purgedRow?.purge_counts ?? null

        /*
         * 🔴 "同一批不会被删第二遍"：一次改动**只删一次**。
         *    ⚠️ 这里必须**删到没有待删项为止**再断言 —— 上面 ⑥ 自己那次改选科
         *       （物化地）也留下了一批（它的旧科目是 地理/政治/历史），
         *       所以"第二次调用"按设计确实还有活干。真正的幂等断言是
         *       "**已经删过的那条记录不再被当成待删项**" + "没有待删项时回一句人话"。
         */
        let last = null
        for (let i = 0; i < 6; i++) {
          last = await D.db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean) as v`, [U.head, S9, true])
          if (/没有要删/.test(String(last.rows[0].v?.message ?? ''))) break
        }
        ok(
          '⑥ 同一批**不会被删第二遍**：删到没有待删项之后，再调一次回"没有要删的旧科目数据"',
          /没有要删/.test(String(last.rows[0].v?.message ?? '')),
          JSON.stringify(last.rows[0].v),
        )
        eq(
          '⑥ 而**已经删过的那条**记录不会被改写（`purge_counts` 与第一次删完时逐字相同）',
          purgedId ? (await D.db.query(`select purge_counts from student_subject_changes where id = $1`, [purgedId])).rows[0].purge_counts : null,
          countsBefore,
        )
      }

      /* ---- ⑦ 休学档位（Q28 = B）：休学**保留**、转班/转学**移出**、复学一键恢复 ---- */
      {
        await D.db.exec(`insert into class_members (class_id, student_id) values ('${CS_GEO}', '${S9}') on conflict do nothing`)
        eq('⑦ 前置：这位学生在走班班-地理里', await membersOf9(), [CS_GEO])

        await D.db.query(`update students set status = 'suspended' where id = $1`, [S9])
        eq(
          '🔴 休学（`suspended`）：**走班名单保留**（Q28 = B：保留但标记）',
          await membersOf9(),
          [CS_GEO],
        )
        eq(
          '🔴 休学的标记是**读得出来**的（`students.status`）',
          (await D.db.query(`select status from students where id = $1`, [S9])).rows[0].status,
          'suspended',
        )
        const bad = await attempt(D.db, U.super, `update students set status = 'dropped' where id = $1 returning id`, [S9])
        denied('⑦ 第四档不认（check 约束只认 active / suspended / left）', bad)

        await D.db.query(`update students set status = 'active' where id = $1`, [S9])
        eq('⑦ 复学一键恢复：状态回 `active`，而走班名单**本来就没被动过**', await membersOf9(), [CS_GEO])
        eq(
          '⑦ 复学之后状态就是在读',
          (await D.db.query(`select status from students where id = $1`, [S9])).rows[0].status,
          'active',
        )

        await D.db.query(`update students set status = 'left' where id = $1`, [S9])
        eq('🔴 转学 / 退学（`left`）：**走班名单移出**（Q28 = B 的另一半）', await membersOf9(), [])

        await D.db.query(`update students set status = 'active' where id = $1`, [S9])
        await D.db.exec(`insert into class_members (class_id, student_id) values ('${CS_GEO}', '${S9}') on conflict do nothing`)
        await D.db.query(`update students set class_id = $1 where id = $2`, [C.c2, S9])
        eq('🔴 转班（`class_id` 变了）：**走班名单移出**（四条写入路径共用这一个触发器）', await membersOf9(), [])
        await D.db.query(`update students set class_id = $1 where id = $2`, [C.c1, S9])
      }

      /* ---- ⑧ `students.status` 的约束形状（幂等迁移的落点）---- */
      {
        const cons = await D.db.query(
          `select conname from pg_constraint
            where conrelid = 'students'::regclass and contype = 'c' order by conname`,
        )
        const names = cons.rows.map((r) => r.conname)
        ok('⑧ 旧的 `students_status_check`（只认两档）**已经删掉**', !names.includes('students_status_check'), names.join('、'))
        ok('⑧ 新的 `students_status_check_v2`（三档）在', names.includes('students_status_check_v2'), names.join('、'))
      }

      /* ---- ⑨ `subjects.can_stream` 废弃登记（✅ P7 已经删列 —— 这里只核一遍）----
         判据就是计划里那一句：**全仓搜索 `can_stream` → 只剩注释与那一句 `drop column`**。
         ⚠️ 这里刻意不扫 `src/**`：`lib/subjects.ts` 与 `lib/stream.ts` 的注释里**必须要提它**
            （不提就没人知道它为什么没了），扫源码只会得到一堆注释命中、证明不了任何事。 */
      {
        const col = await D.db.query(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'subjects' and column_name = 'can_stream'`,
        )
        eq('⑨ `subjects.can_stream` 那一列**不存在**（§32.6 已删；Q24 = B）', col.rows, [])
        const codeHits = readFileSync(SCHEMA_FILE, 'utf8')
          .split('\n')
          .filter((l) => !l.trim().startsWith('--') && /can_stream/.test(l))
          .map((l) => l.trim())
        eq(
          '⑨ `schema.sql` 里 `can_stream` 只剩那一句 `drop column`（其余全是注释 —— 计划里那条验收）',
          codeHits,
          ['alter table subjects drop column if exists can_stream;'],
        )
      }

      await Dp.db.close()
    }

    /* ============================================================
       十九、🆕 学生档案（民族 · 出生年月 · 家长电话 · 家庭住址）
             表 `student_profiles`（`schema.sql` §2.1 建表 / §35 策略）+ **PII 三道配套**
       ------------------------------------------------------------
       用户口径（2026-10-06）：
         · 科任老师**通过班级看得见**这些字段（= "看得见哪些班"那一套）；
         · **班主任通过班级改得了**（= `can_manage_class()`，§16.2 那一个判据，没另造）；
         · 🔴 **教室端那块给学生看的屏，一个字都不许读到**。
       另外三件配套（这一轮的另一半）：① 备份邮件正文那条窄判据 · ② 错误日志的
       `has_pii` 与"抹掉值" · ③ 年级删除备份 payload 的逐表覆盖。

       🔴 每一条都带**反向对照**（`RLS_NEGATIVE=profile-classroom` / `profile-write-open` /
          `profile-mask-off` / `profile-drop-from-payload`）——跑得红的那种断言才算数。
       ============================================================ */
    section('十九、🆕 学生档案（PII）：科任老师只读 · 教室端读不到 · 班主任改本班 + PII 三道')
    {
      const gradeOf = async (name) =>
        (await db.query(`select id from grades where name = $1`, [name])).rows[0].id
      const G2 = await gradeOf('高二')
      const G3 = await gradeOf('高三')
      const sorted = (...ids) => [...ids].sort()

      /* 固定夹具：三个班各一条（s1 → c1 高二(1) · s4 → c2 高二(4) · s6 → c3 高三(1)） */
      await db.exec(`
    insert into student_profiles (student_id, ethnicity, birth_month, guardian_phone, home_address) values
      ('${S.s1}', '汉族', '2010-05', '13800138000', '某市某区某小区1号楼2单元501'),
      ('${S.s4}', '回族', '2010-09', '13900139000', '某市某区某街12号'),
      ('${S.s6}', '满族', '2009-11', '13700137000', '某市某县某村3组');
    `)

      const seenIds = (uid) => idsAs(db, uid, `select student_id as id from student_profiles order by student_id`)
      const canSelect = (role) =>
        db
          .query(`select has_table_privilege($1, 'student_profiles', 'select') as v`, [role])
          .then((r) => Boolean(r.rows[0].v))

      /* ---- ① 谁看得见：**复用 `visible_class_ids()`**（科任老师 = 自己任教的班）---- */
      eq(
        '① 超管 / 教务处：全校三条都看得见',
        [await seenIds(U.super), await seenIds(U.admin)],
        [sorted(S.s1, S.s4, S.s6), sorted(S.s1, S.s4, S.s6)],
      )
      eq('① 年级主任：只有**本年级**（高二两条 s1 + s4；高三那条看不到）', await seenIds(U.grade), sorted(S.s1, S.s4))
      eq('① 班主任：**本班**那条（c1 的 s1）', await seenIds(U.head), [S.s1])
      eq(
        '🔴 ① 物理老师（教 c1 + c2）：**只看得见自己任教的那两个班**（s1 + s4）',
        await seenIds(U.phy),
        sorted(S.s1, S.s4),
      )
      eq('① 语文老师（只教 c1）：只有 s1', await seenIds(U.chn), [S.s1])
      eq('🔴 ① 非任教班的老师（无身份那位，带的是 c4）→ **一条都看不到**', await seenIds(U.fresh), [])
      eq(
        '① 校级三档 / 德育处主任（全校只读）：三条都看得见',
        [await seenIds(U.prin), await seenIds(U.moral)],
        [sorted(S.s1, S.s4, S.s6), sorted(S.s1, S.s4, S.s6)],
      )
      eq(
        '① 办公室主任 / 两个组长：一条都看不到（他们本来就不看教学数据）',
        [await seenIds(U.ohead), await seenIds(U.slead), await seenIds(U.llead)],
        [[], [], []],
      )

      /* ---- ② 🔴 教室端：一行都读不到（那块屏是给学生看的）---- */
      eq('🔴 ② 教室端（高二(1)班那块屏）读学生档案 → **0 行**（不是"界面上不渲染"，是拿不到）', await seenIds(U.room), [])
      eq(
        '🔴 ② 而它**照旧读得到本班的学生行**（这一轮没有动 `students` 的可见性 —— I20 那条线没断）',
        await idsAs(db, U.room, 'select id from students order by id'),
        sorted(S.s1, S.s2, S.s3),
      )
      {
        const q = (
          await db.query(
            `select policyname, qual from pg_policies
              where schemaname = 'public' and tablename = 'student_profiles' and cmd = 'SELECT'`,
          )
        ).rows
        eq(
          '🔴 ② 而且**策略清单上看得出来**：那条读策略里就写着教室端守卫（`is_classroom_account`）',
          [q.length, q.every((x) => /classroom_account/.test(String(x.qual)))],
          [1, true],
        )
      }

      /* ---- ③ 谁改得动：班主任本班 ∪ 本年级年级主任 ∪ 教务处 / 超管 ---- */
      const upsertProfile = (sid, phone) => ({
        sql: `insert into student_profiles (student_id, guardian_phone) values ($1, $2)
              on conflict (student_id) do update set guardian_phone = excluded.guardian_phone
              returning student_id`,
        values: [sid, phone],
      })
      const delProfile = (sid) => ({
        sql: `delete from student_profiles where student_id = $1 returning student_id`,
        values: [sid],
      })
      allowed('③ 班主任改**本班**学生的档案（用户口径那一支）', await write(db, U.head, upsertProfile(S.s1, '13800138001')))
      allowed('③ 年级主任改**本年级**的', await write(db, U.grade, upsertProfile(S.s4, '13900139001')))
      allowed('③ 教务处改**任何班**的（兜底）', await write(db, U.admin, upsertProfile(S.s6, '13700137001')))
      allowed('③ 超管照旧（兜底）', await write(db, U.super, upsertProfile(S.s6, '13700137002')))
      denied(
        '🔴 ③ 科任老师（物理，正教着这个班）改**本班**的档案 —— **读得宽、写得窄**',
        await write(db, U.phy, upsertProfile(S.s1, '13000000000')),
      )
      denied('🔴 ③ 班主任改**别班**的（c2 的 s4）', await write(db, U.head, upsertProfile(S.s4, '13000000000')))
      denied('🔴 ③ 年级主任改**别年级**的（高三的 s6）', await write(db, U.grade, upsertProfile(S.s6, '13000000000')))
      denied('🔴 ③ 教室端改本班学生的档案（那块屏零写权限）', await write(db, U.room, upsertProfile(S.s1, '13000000000')))
      denied('③ 无身份的老师改别班的', await write(db, U.fresh, upsertProfile(S.s1, '13000000000')))
      denied(
        '🔴 ③ 教室端**插**一条新行（给本班另一个学生）',
        await write(db, U.room, {
          sql: `insert into student_profiles (student_id, guardian_phone) values ($1, $2) returning student_id`,
          values: [S.s2, '13000000000'],
        }),
      )
      denied('🔴 ③ **读得到 ≠ 删得掉**：科任老师删本班那一行', await write(db, U.phy, delProfile(S.s1)))
      allowed(
        '③ 反向对照：班主任删本班那一行**删得掉**（上面那几条"被拒"不是"谁都写不动"）',
        await write(db, U.head, delProfile(S.s1)),
      )

      /* ---- ④ 形状与语义：四个字段**全部可空**；出生年月不是年龄 ---- */
      denied(
        '④ `birth_month` 拒掉「13岁」（它是**出生年月**，不是年龄 —— 一个字段一种语义）',
        await write(db, U.super, {
          sql: `update student_profiles set birth_month = '13岁' where student_id = $1 returning student_id`,
          values: [S.s4],
        }),
      )
      denied(
        '④ 也拒掉「2010年5月」（形状只有 `YYYY-MM`）',
        await write(db, U.super, {
          sql: `update student_profiles set birth_month = '2010年5月' where student_id = $1 returning student_id`,
          values: [S.s4],
        }),
      )
      allowed(
        '④ 反向对照：`2010-05` 存得进去（上面两条不是"永远为红"）',
        await write(db, U.super, {
          sql: `update student_profiles set birth_month = '2010-05' where student_id = $1 returning student_id`,
          values: [S.s4],
        }),
      )
      allowed(
        '④ 🔴 **四个字段全部可空**：只给一个 `student_id` 也存得进去（建班录名单不会被卡住）',
        await write(db, U.head, {
          sql: `insert into student_profiles (student_id) values ($1) returning student_id`,
          values: [S.s3],
        }),
      )

      /* ---- ⑤ 表的形状与权限（为什么是独立一张表）---- */
      eq(
        '🔴 ⑤ 这四个字段**不在 `students` 上**（挂上去 = 教室端那句 `select(\'*\')` 必然把它们读走）',
        (
          await db.query(
            `select column_name from information_schema.columns
              where table_schema = 'public' and table_name = 'students'
                and column_name in ('ethnicity', 'birth_month', 'guardian_phone', 'home_address')`,
          )
        ).rows.map((r) => r.column_name),
        [],
      )
      eq('⑤ 表级权限：anon 什么都不给 · authenticated 给（行由策略收口）', [await canSelect('anon'), await canSelect('authenticated')], [false, true])
      eq(
        '⑤ 策略清单：1 条读 + 3 条写（逐动作 —— 不写 `for all`，免得把读也一起改掉）',
        (
          await db.query(
            `select policyname, cmd from pg_policies
              where schemaname = 'public' and tablename = 'student_profiles' order by policyname`,
          )
        ).rows.map((r) => `${r.policyname}:${r.cmd}`),
        [
          'student_profiles_delete:DELETE',
          'student_profiles_insert:INSERT',
          'student_profiles_update:UPDATE',
          'student_profiles_visible:SELECT',
        ],
      )
      eq(
        '⑤ 年级管理那一层**没有第二个判据**：还是 `can_manage_grade_setup_for()`（本年级 true / 别年级 false）',
        [
          (await db.query(`select public.can_manage_grade_setup_for($1::uuid, $2::uuid) as v`, [U.grade, G2])).rows[0].v,
          (await db.query(`select public.can_manage_grade_setup_for($1::uuid, $2::uuid) as v`, [U.grade, G3])).rows[0].v,
          (await db.query(`select public.can_manage_grade_setup_for($1::uuid, $2::uuid) as v`, [U.phy, G2])).rows[0].v,
        ],
        [true, false, false],
      )

      /* ============================================================
         十九·之二 PII 之一：**备份邮件正文**那条窄判据（`_lib/mail.ts`）
         ------------------------------------------------------------
         跑的是仓库里那份真文件。⚠️ 它仍然是**启发式**（裸姓名抓不到，见文件头），
         但"家长电话 / 住址 / 民族 / 出生年月"这四种写法必须认得出来。
         ============================================================ */
      const mailHit = (t) => MAILLIB.looksLikeStudentData(t)
      ok('🔴 ⑥ 「家长电话：13800138000」→ 判定含学生信息（**这封信不发**）', Boolean(mailHit('家长电话：13800138000')), String(mailHit('家长电话：13800138000')))
      ok('🔴 ⑥ 「家庭住址：某市某区某小区1号楼2单元501」→ 命中', Boolean(mailHit('家庭住址：某市某区某小区1号楼2单元501')))
      ok('🔴 ⑥ 「民族：汉族」→ 命中', Boolean(mailHit('民族：汉族')))
      ok('🔴 ⑥ 「出生年月：2010-05」→ 命中', Boolean(mailHit('出生年月：2010-05')))
      ok('🔴 ⑥ 裸的 11 位手机号（没有标注）也命中', Boolean(mailHit('学生留的是 13800138000')))
      eq('🔴 ⑥ 反向对照：**正常运维文案一个字都不许误伤**（维护通知）', mailHit('系统维护：今晚 23:00-23:30 升级，预计 30 分钟'), null)
      eq('🔴 ⑥ 反向对照：版本公告也不误伤', mailHit('版本 0.9.1 上线，新增错题集导出'), null)
      eq(
        '⑥ 反向对照：**刻意不收裸的「民族」两个字** —— 历史老师那句正常文案不误伤' +
          '（误伤比漏提醒更烦人，见 `PII_PATTERNS` 的注释）',
        mailHit('这次考试考民族区域自治制度'),
        null,
      )

      /* ============================================================
         十九·之三 PII 之二：**管理台错误日志**（`report_frontend_error`，§24.2）
         ------------------------------------------------------------
         上报的正文里出现这四种字段时：**标出来**（`has_pii`）+ **把值抹掉**。
         ⚠️ `has_pii` 必须在那道"抹一遍"之前算 —— 顺序反了会"永远标不出来"，
            而那种失败**不报错**（所以下面既有"抹掉了"也有"标出来了"两条）。
         ============================================================ */
      {
        const reportAsAnon = async (msg) => {
          await db.exec('begin')
          try {
            await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
            await db.exec('set local role anon')
            const r = await db.query(
              `select report_frontend_error('u', 'teacher', '/x', $1, '', '', 'web', '') as j`,
              [msg],
            )
            await db.exec('commit')
            return r.rows[0].j
          } catch (e) {
            await db.exec('rollback')
            throw e
          }
        }
        const rowOf = async (id) =>
          (await db.query(`select message, has_pii from frontend_errors where id = $1`, [id])).rows[0]

        const r1 = await reportAsAnon('张三的家长电话：13800138000 打不通')
        const m1 = await rowOf(r1.id)
        eq('🔴 ⑦ `has_pii` 认得出「家长电话：…」', m1.has_pii, true)
        ok(
          '🔴 ⑦ 而且**值被抹掉**（`13800138000` 一个字都不留在库里）',
          !m1.message.includes('13800138000') && m1.message.includes('[已隐去]'),
          m1.message,
        )
        ok('⑦ 正文主体仍在（不是把整句删了）', m1.message.includes('张三的家长电话'), m1.message)

        const r2 = await reportAsAnon('家庭住址：某小区3号楼2单元501')
        const m2 = await rowOf(r2.id)
        eq('🔴 ⑦ 住址：同一套判据（标出来 + 抹掉）', [m2.has_pii, !m2.message.includes('3号楼')], [true, true])

        const r3 = await reportAsAnon('学生留的是 13800138000')
        const m3 = await rowOf(r3.id)
        eq('🔴 ⑦ **裸的 11 位手机号**：也标出来、也抹掉', [m3.has_pii, !m3.message.includes('13800138000')], [true, true])

        const r4 = await reportAsAnon('导出按钮点了没反应')
        eq('⑦ 反向对照：普通错误文案**不**被标成含隐私（不是"一律 true"）', (await rowOf(r4.id)).has_pii, false)
        const r5 = await reportAsAnon('这次考试考民族区域自治制度')
        const m5 = await rowOf(r5.id)
        eq(
          '⑦ 反向对照：裸的「民族」两个字**不**命中（历史文案不误伤），正文也一个字没被抹',
          [m5.has_pii, m5.message.includes('民族区域自治')],
          [false, true],
        )

        /* 收尾：这一节写进去的行删掉（不影响别的断言） */
        await db.query(`delete from frontend_errors`)
      }

      /* ============================================================
         十九·之四 PII 之三：**年级删除备份**的 payload 必须逐表覆盖到学生档案
         ------------------------------------------------------------
         `grade_removals.payload` 是"删一个年级之前"那份 JSON 备份 ——
         漏了学生档案 = 删完之后那批家长电话**静默消失**（备份里没有、界面上也没了）。
         （`payload` 的唯一构造处是 `grade_backup_payload_json()`，§29.5。）
         ============================================================ */
      {
        const payloadOf = async (gid) =>
          (await db.query(`select public.grade_backup_payload_json($1::uuid) as p`, [gid])).rows[0].p
        const p2 = await payloadOf(G2)
        const list2 = p2?.tables?.studentProfiles ?? []
        eq(
          '🔴 ⑧ 备份 payload 里有 `studentProfiles` 这一类，且 `counts` 那个数与条数**对得上**',
          [list2.length, Number(p2?.counts?.studentProfiles ?? -1)],
          [2, 2],
        )
        const one = list2.find((x) => x.student_id === S.s1) ?? {}
        ok(
          '🔴 ⑧ 而且**四个字段逐个都在**（少一个就是"删年级时静默丢 PII"）',
          [one.ethnicity, one.birth_month, one.guardian_phone, one.home_address].every(
            (v) => typeof v === 'string' && v !== '',
          ),
          JSON.stringify(one),
        )
        const p3 = await payloadOf(G3)
        eq(
          '🔴 ⑧ 换一个年级（高三）：只带自己那个班的那一条（高二两条不许混进来）',
          (p3?.tables?.studentProfiles ?? []).map((x) => x.student_id),
          [S.s6],
        )
      }
    }

    /* ============================================================
       二十、🆕 教师档案（家庭住址 · 电话号码 · 邮箱）
             表 `teacher_profiles`（`schema.sql` §1.1 建表 / §36 策略）
       ------------------------------------------------------------
       用户口径（2026-10-06）：「教师管理页面除了给老师建号，应该也可以记录老师的个人信息，
       例如家庭住址，电话号码，邮箱。」
         · **读 / 写都只认 `can_create_teacher_accounts()`**（超管 / 教务处 / 办公室主任）——
           档案属性那一档；
         · **自己那一行自己看得到**（`teacher_id = auth.uid()`）；
         · 🔴 **别的老师读不到同事的**（家庭住址是隐私）；**班主任 / 年级主任也不读**；
         · 🔴 **教室端 0 行**（拿 `teachers` 自己那一行做对照，证明不是"整体读不到"）。
       另外：老师这一侧的 PII 配套（错误日志清洗 / **不进年级备份 payload**）。

       🔴 每条都带**反向对照**：`RLS_NEGATIVE=profile-classroom`（拿掉教室端守卫）/
          `profile-write-open`（三条写策略换成恒真）/ `profile-teacher-mask-off`（拿掉邮箱抹除）。
       ============================================================ */
    section('二十、🆕 教师档案（PII）：建号那一档读写 · 自己那一行 · 别的老师与教室端读不到 + PII 配套')
    {
      const sorted2 = (...ids) => [...ids].sort()
      const gradeIdOf = async (name) => (await db.query(`select id from grades where name = $1`, [name])).rows[0].id
      const G2b = await gradeIdOf('高二')

      /* 固定夹具：**三位老师 + 教室端自己那一行**（教室端也有一行 `teachers` —— 触发器给每个 auth 用户都建）。
         ⚠️ 教室端那一行是**故意的**：没有它，"教室端读不到教师档案"那条断言的负向对照会**假绿**
         （拿掉 `not is_classroom_account()` 之后它仍然读到 0 行 —— 因为库里根本没有它那一行），
         实测踩过一次。 */
      await db.exec(`
      insert into teacher_profiles (teacher_id, home_address, phone, email) values
        ('${U.super}', '某市某区某小区1号楼2单元501', '13800138000', 'super@shugao.test'),
        ('${U.grade}', '某市某区某街12号',           '010-12345678', 'grade@shugao.test'),
        ('${U.head}',  '某市某县某村3组',            '13900139000 转 8021', 'head@shugao.test'),
        ('${U.room}',  '教室端那一行（不该被它自己读到）', '13800138009', 'room@shugao.test');
    `)

      const profIds = (uid) => idsAs(db, uid, `select teacher_id as id from teacher_profiles order by teacher_id`)
      const canSelectProf = (role) =>
        db
          .query(`select has_table_privilege($1, 'teacher_profiles', 'select') as v`, [role])
          .then((r) => Boolean(r.rows[0].v))

      /* ---- ① 谁读得到：**能建号那一档**（超管 / 教务处 / 办公室主任）---- */
      eq(
        '🔴 ① 超管 / 教务处 / 办公室主任（= `can_create_teacher_accounts()` 那一档）：四条都读得到',
        [await profIds(U.super), await profIds(U.admin), (await profIds(U.ohead)).length],
        [sorted2(U.super, U.grade, U.head, U.room), sorted2(U.super, U.grade, U.head, U.room), 4],
      )
      eq(
        '🔴 ① 而办公室主任**读得到 ≠ 判据更宽**：他对学生档案一条都读不到（两张表两套判据，别混）',
        await idsAs(db, U.ohead, 'select student_id as id from student_profiles order by student_id'),
        [],
      )

      /* ---- ② 🔴 别人读不到：自己的那一行看得到、同事的一行看不到 ---- */
      eq(
        '🔴 ② 年级主任 / 班主任 / 物理老师：**只有自己那一行**（同事的家庭住址读不到）',
        [await profIds(U.grade), await profIds(U.head), await profIds(U.phy)],
        [[U.grade], [U.head], []],
      )
      eq(
        '🔴 ② 无身份的新老师：一行都读不到（他自己还没录过 —— 这是"没有行"，不是"被挡"）',
        await profIds(U.fresh),
        [],
      )
      eq(
        '🔴 ② 而他们**照旧读得到自己的 `teachers` 那一行**（这一轮没有动 `teachers` 的可见性）',
        await idsAs(db, U.head, 'select id from teachers order by id'),
        [U.head],
      )

      /* ---- ③ 🔴 教室端：一行都读不到（那块屏是给学生看的）---- */
      eq('🔴 ③ 教室端读教师档案 → **0 行**（不是"界面上不渲染"，是拿不到）', await profIds(U.room), [])
      eq(
        '🔴 ③ 而它**照旧读得到自己那一行 `teachers`**（证明上面那条不是"整体读不到"）',
        await idsAs(db, U.room, 'select id from teachers order by id'),
        [U.room],
      )
      {
        const q = (
          await db.query(
            `select policyname, qual from pg_policies
              where schemaname = 'public' and tablename = 'teacher_profiles' and cmd = 'SELECT'`,
          )
        ).rows
        eq(
          '🔴 ③ 而且**策略清单上看得出来**：那条读策略里就写着教室端守卫（`is_classroom_account`）',
          [q.length, q.every((x) => /classroom_account/.test(String(x.qual)))],
          [1, true],
        )
      }

      /* ---- ④ 谁改得动：**能建号那一档**（老师本人**改不了自己那一行**）---- */
      const upsertProf = (tid, phone) => ({
        sql: `insert into teacher_profiles (teacher_id, phone) values ($1, $2)
              on conflict (teacher_id) do update set phone = excluded.phone
              returning teacher_id`,
        values: [tid, phone],
      })
      allowed('④ 超管改（兜底）', await write(db, U.super, upsertProf(U.head, '13700137001')))
      allowed('④ 教务处改（兜底）', await write(db, U.admin, upsertProf(U.head, '13700137002')))
      allowed('④ 办公室主任改（他与建号同一档）', await write(db, U.ohead, upsertProf(U.head, '13700137003')))
      denied(
        '🔴 ④ **老师本人改不了自己那一行**（`teachers` 上的 `teachers_self` 管不到这张表 —— 写只给建号那一档）',
        await write(db, U.head, upsertProf(U.head, '13000000000')),
      )
      denied(
        '🔴 ④ 年级主任改不了（他不是"建号那一档"，老师的家庭住址也不归他管）',
        await write(db, U.grade, upsertProf(U.head, '13000000000')),
      )
      denied('🔴 ④ 班主任改不了同事的（班主任只在学生档案那一侧有写权）', await write(db, U.head, upsertProf(U.grade, '13000000000')))
      denied('🔴 ④ 教室端改不了（那块屏零写权限）', await write(db, U.room, upsertProf(U.head, '13000000000')))
      denied(
        '🔴 ④ 教室端**插**一条新行也不行',
        await write(db, U.room, {
          sql: `insert into teacher_profiles (teacher_id, phone) values ($1, $2) returning teacher_id`,
          values: [U.phy, '13000000000'],
        }),
      )
      eq(
        '④ 而且**表上没有 DELETE 策略**（删老师走删账号那条路，不在这张表上删行）',
        (
          await db.query(
            `select cmd from pg_policies where schemaname = 'public' and tablename = 'teacher_profiles' order by cmd`,
          )
        ).rows.map((r) => r.cmd),
        ['INSERT', 'SELECT', 'UPDATE'],
      )

      /* ---- ⑤ 形状：三个字段**全部可空**；电话/邮箱只挡明显不合法（固话/带区号/分机都要存得下）---- */
      allowed(
        '⑤ 🔴 **三个字段全部可空**：只给一个 `teacher_id` 也存得进去（建号那条路一个字都不碰这张表）',
        await write(db, U.super, {
          sql: `insert into teacher_profiles (teacher_id) values ($1) returning teacher_id`,
          values: [U.phy],
        }),
      )
      allowed(
        '⑤ **固话带区号 + 分机**存得下（`010-12345678 转 8021` 这种写法不许被 check 挡掉）',
        await write(db, U.super, {
          sql: `update teacher_profiles set phone = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, '010-12345678 转 8021'],
        }),
      )
      allowed(
        '⑤ 国际写法也存得下（`+86 138 0013 8000`）',
        await write(db, U.super, {
          sql: `update teacher_profiles set phone = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, '+86 138 0013 8000'],
        }),
      )
      allowed(
        '⑤ 反向对照：一个**正常邮箱**存得进去（上面那几条"被拒"不是"永远为红"）',
        await write(db, U.super, {
          sql: `update teacher_profiles set email = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, 'zhang.san+work@mail.example.cn'],
        }),
      )
      denied(
        '⑤ 电话那一格拒掉**带备注**的（`备用号 13800138000` 有 11 位数字、形状却不合 —— 一个字段一种语义）',
        await write(db, U.super, {
          sql: `update teacher_profiles set phone = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, '备用号 13800138000'],
        }),
      )
      denied(
        '⑤ 也拒掉整句中文（`不是电话`：既没有 7 位数字、字符也不在允许集里）',
        await write(db, U.super, {
          sql: `update teacher_profiles set phone = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, '不是电话'],
        }),
      )
      denied(
        '⑤ 邮箱那一格拒掉明显不合形状的（没有 `@`）',
        await write(db, U.super, {
          sql: `update teacher_profiles set email = $2 where teacher_id = $1 returning teacher_id`,
          values: [U.head, 'zhangsan.example.com'],
        }),
      )

      /* ---- ⑥ 表的形状与权限（为什么是独立一张表）---- */
      eq(
        '🔴 ⑥ 这三个字段**不在 `teachers` 上**（挂上去 = 任何能读 `teachers` 的人都读得到同事的家庭住址）',
        (
          await db.query(
            `select column_name from information_schema.columns
              where table_schema = 'public' and table_name = 'teachers'
                and column_name in ('home_address', 'phone', 'email', 'teacher_phone')`,
          )
        ).rows.map((r) => r.column_name),
        [],
      )
      eq(
        '⑥ 表级权限：anon 什么都不给 · authenticated 给（行由策略收口）',
        [await canSelectProf('anon'), await canSelectProf('authenticated')],
        [false, true],
      )
      eq(
        '⑥ 策略清单：1 条读 + insert / update（逐动作 —— 不写 `for all`，免得把读也一起改掉）',
        (
          await db.query(
            `select policyname, cmd from pg_policies
              where schemaname = 'public' and tablename = 'teacher_profiles' order by policyname`,
          )
        ).rows.map((r) => `${r.policyname}:${r.cmd}`),
        ['teacher_profiles_insert:INSERT', 'teacher_profiles_update:UPDATE', 'teacher_profiles_visible:SELECT'],
      )
      eq(
        '⑥ 四列都在（`teacher_id` 主键 + 那三个字段；少一列 = 界面读到 undefined 而**不报错**）',
        (
          await db.query(
            `select column_name from information_schema.columns
              where table_schema = 'public' and table_name = 'teacher_profiles' order by column_name`,
          )
        ).rows.map((r) => r.column_name),
        ['email', 'home_address', 'phone', 'teacher_id'].sort(),
      )
      eq(
        '⑥ 三个字段**全部可空**（`is_nullable = YES`：建号那条路一个字都不碰这张表）',
        (
          await db.query(
            `select is_nullable from information_schema.columns
              where table_schema = 'public' and table_name = 'teacher_profiles'
                and column_name in ('home_address', 'phone', 'email')`,
          )
        ).rows.map((r) => r.is_nullable),
        ['YES', 'YES', 'YES'],
      )

      /* ============================================================
         二十·之二 🔴 **教师档案不进「年级备份」payload**（这是一个**判断**，钉住它）
         ------------------------------------------------------------
         F1 把 `studentProfiles` 加进了 `grade_backup_payload_json()`（§29.5），因为学生
         **属于某个年级**（按年级删数据，漏了他就是静默丢 PII）。老师**不属于某个年级**
         （他跨年级任教），所以：把 `teacherProfiles` 塞进去 = 同一个老师的家庭住址在
         **每个年级的 payload 里各存一份**，而且删掉某个年级时那份"备份"里会**多出**
         一批"这个年级根本不曾拥有的"个人信息（那是 PII 的无谓扩散）。
         结论：**不加** —— 这一条断言把"不加"钉住（后来的人"顺手照 F1 补上"会立刻红）。
         ⚠️ 老师档案的兜底是那条 AES `pg_dump` **全库链**（与 `teachers` 表本身同款），
           不在年级 payload 这一层。
         ============================================================ */
      {
        const payloadOf = async (gid) =>
          (await db.query(`select public.grade_backup_payload_json($1::uuid) as p`, [gid])).rows[0].p
        const p2 = await payloadOf(G2b)
        const keys = Object.keys(p2?.tables ?? {})
        eq(
          '🔴 ⑦ 年级备份 payload 里**照旧**有 `studentProfiles`（F1 那一半没被这一轮动到）',
          keys.includes('studentProfiles'),
          true,
        )
        eq(
          '🔴 ⑦ 而**没有 `teacherProfiles`** —— 老师跨年级、不属于某个年级的 payload（不加是判断，不是漏）',
          [keys.includes('teacherProfiles'), Object.keys(p2?.counts ?? {}).includes('teacherProfiles')],
          [false, false],
        )
      }

      /* ============================================================
         二十·之三 老师这一侧的 PII 清洗：**邮箱值要抹掉**（`report_frontend_error`，§24.2）
         ------------------------------------------------------------
         `has_pii` 早就认邮箱的形状（原来就有那条判据）；本轮补的是**抹值**这一半。
         ⚠️ 顺序仍是"先判 `has_pii`、再洗一遍"（拿掉抹除那一句时 `has_pii` 照旧为真，
            红的是"值还在库里"那一条 —— 负向对照 `profile-teacher-mask-off` 钉着）。
         ============================================================ */
      {
        const reportAsAnon = async (msg) => {
          await db.exec('begin')
          try {
            await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
            await db.exec('set local role anon')
            const r = await db.query(
              `select report_frontend_error('u', 'teacher', '/x', $1, '', '', 'web', '') as j`,
              [msg],
            )
            await db.exec('commit')
            return r.rows[0].j
          } catch (e) {
            await db.exec('rollback')
            throw e
          }
        }
        const rowOf = async (id) =>
          (await db.query(`select message, has_pii from frontend_errors where id = $1`, [id])).rows[0]

        const r1 = await reportAsAnon('李老师的邮箱 lilaoshi@example.com 发不出去')
        const m1 = await rowOf(r1.id)
        eq('🔴 ⑧ 邮箱地址：`has_pii` 标出来了', m1.has_pii, true)
        ok(
          '🔴 ⑧ 而且**域名被抹掉**（`example.com` 一个字都不留在库里）',
          !m1.message.includes('example.com') && m1.message.includes('@[已隐去]'),
          m1.message,
        )
        ok('⑧ 正文主体仍在（不是把整句删了）', m1.message.includes('李老师的邮箱'), m1.message)

        const r2 = await reportAsAnon('住址：某小区3号楼2单元501 记一下')
        const m2 = await rowOf(r2.id)
        eq(
          '🔴 ⑧ 老师住址：同一套标注判据（标出来 + 抹掉）',
          [m2.has_pii, !m2.message.includes('3号楼')],
          [true, true],
        )

        const r3 = await reportAsAnon('点了导出没反应')
        const m3 = await rowOf(r3.id)
        eq(
          '🔴 ⑧ 反向对照：普通错误文案既**不**被标成含隐私、也一个字没被抹（不是"一律 true / 一律抹"）',
          [m3.has_pii, m3.message],
          [false, '点了导出没反应'],
        )
        /* 收尾：这一节写进去的行删掉（不影响别的断言） */
        await db.query(`delete from frontend_errors`)
      }
    }

    /* ============================================================
       二十一、🆕 教室端账号的入口（班级档案里那一块）+ 走班班由年级主任代管
       ------------------------------------------------------------
       用户口径（2026-10-06 两件）：
         ① 「有权限在行政管理－年级管理里看班级档案的，可以在里面看见对应班级的
             教室端账号和密码」→ 入口放在**班级档案**；
         ② 「走班班没有班主任，由年级主任统一管理」→ 年级主任对本年级**所有班**
            （含走班班）有班主任那一档的权限、**在班级页直接管**。

       🔴 这一节跑的是**仓库里的真服务端**（`functions/api/classroom-account.ts` 的
          `onRequestPost`）+ 真的 PostgREST 形状 —— 桩底下的 SQL 是**真的 PGlite**，
          所以"谁能重置"这件事是**真跑一遍**，不是照着注释念一遍。

       🔴 两件事的核实结论（写在这里免得后人再核一遍）：
         · **判据一处都没新写**：服务端 `mayManage()` 逐支等于 `can_manage_class_for()`
           （超管 / 教务处 ∪ 本年级年级主任 ∪ 本班班主任）；下面 W2/W3 逐档比对。
         · **"看得到密码"做不到**：Supabase 的密码是**哈希**存的，服务端也拿不回原文 ——
           所以做的是「重置密码 → 新密码回话里带回一次」（W5 钉住"库里不存明文"）。
         · **走班班本来就已经成立**（本轮一个字没改 schema，见 W6 那五条）：
           走班班是 `classes` 里 `kind='stream'` 的一行、`grade_id` 照旧有值，
           而 `grade_head` 那一支按 `grade_id` 取、**与 kind 无关**；`visible_class_ids_for`
           同款。所以"年级主任管得动本年级的走班班"是**既有事实**，补的是**证明**。

       🔴 反向对照：`RLS_NEGATIVE=room-account-wider`（把 `mayManage` 的年级主任那一支
          放宽成"任何年级主任都算"）→ W4/W6 里"别的年级的年级主任"那几条**必须红**。
       ============================================================ */
    section('二十一、🆕 教室端账号的入口（真服务端 onRequestPost）+ 走班班由年级主任代管')
    {
      /* 夹具：一个**别年级**的年级主任、一个**走班班的班主任**（"走班班没有班主任"
         这件事是口径，但库里可能留着一行假数据 —— 这里专门摆一行来钉住"它也管不动别人班的走班班"）。
         ⚠️ 走班班这一行**建在 B 库**（本节所有断言用的 `db`）——第十七节那一批走班班在 D 库里，
            两库不通用；同一节里再建一个 stream_key 不同的走班班，不与 §32.1 的唯一键打架。
         ⚠️ 都插在**事务外**，别名与别节不撞。 */
      const G3 = (await db.query(`select id from grades where name = '高三'`)).rows[0].id
      const G2 = (await db.query(`select id from grades where name = '高二'`)).rows[0].id
      const STREAM_CLS = mk('c0', 23)
      const STREAM_ROOM = mk('a0', 24)
      const R_OTHER_HEAD = mk('a0', 21)
      const R_STREAM_HEAD = mk('a0', 22)
      await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${R_OTHER_HEAD}', 'grade3@shugao.test', '{"name":"高三年级主任"}'::jsonb),
      ('${R_STREAM_HEAD}', 'streamhead@shugao.test', '{"name":"走班班班主任"}'::jsonb),
      ('${STREAM_ROOM}', 'politics-room@shugao.test', '{"name":"走班班政治教室"}'::jsonb);

    -- 走班班：**单科一个班**、**有 grade_id**（§32.2 生成时从学生的年级取）——
    -- 「年级主任管得动它」这条路就架在这个 grade_id 上，与 kind 无关（§31.1）。
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, stream_key) values
      ('${STREAM_CLS}', '${U.phy}', '走班班-政治', '高二', '2025',
       (select id from schools order by created_at limit 1), '${G2}', 'stream', 'politics');

    -- 这个走班班**也有自己的教室端账号**（§2.11：classroom_accounts.class_id 本来就能指走班班）——
    -- 没有它的话"年级主任重置得了吗"那一条会落在 404（"这个班还没有账号"）上，
    -- 而 404 与 403 是两件事：前者是"没账号"，后者才是"你管不着"。
    insert into classroom_accounts (id, class_id, name, email, created_by)
    values ('${STREAM_ROOM}', '${STREAM_CLS}', '走班班政治教室', 'g2-politics@shugao.local', '${U.phy}');

    insert into teacher_roles (id, teacher_id, role, scope_type, scope_id) values
      ('${mk('42', 21)}', '${R_OTHER_HEAD}', 'grade_head',   'grade', '${G3}'),
      ('${mk('42', 22)}', '${R_STREAM_HEAD}', 'head_teacher', 'class', '${STREAM_CLS}');
      `)

      const API_TOKEN = 'tok-room-account'      // 调用者的 JWT（桩按它认人）
      const SVC_KEY = 'svc-room-account'        // 服务端自己的 service_role key（桩走属主身份）
      const ENV = {
        SUPABASE_URL: 'https://sb.shugao.test',
        SUPABASE_ANON_KEY: 'anon-room-account',
        SUPABASE_SERVICE_ROLE_KEY: SVC_KEY,
      }
      /** 重置密码那一路打给 GoTrue 的请求（**新密码只能从回话里拿**，这里单独记账） */
      const pwSets = []
      /** 换一个人就把 token 映射换掉 */
      let TOKEN_OF = new Map()
      const asActor = (uid, cls) => {
        TOKEN_OF = new Map([[API_TOKEN, uid]])
        PW.classId = cls
      }

      /*
       * 🔴 假 PostgREST：**不是"任何 select 都回 []"那种放水桩** ——
       *    每一条查询都拼成真 SQL 打到 PGlite 上，而**调用者那条链走 `authenticated`**
       *    （于是 `classroom_accounts_read` 那条真策略真的会被执行到）。
       *    服务端的 service_role 那条链走属主身份（与真的 service_role 同款：绕 RLS）。
       */
      const PW = { classId: C.c1 }
      const REST_COLS = {
        classes: { id: 'text', name: 'text', grade_id: 'text', school_id: 'text' },
        teacher_roles: { role: 'text', scope_type: 'text', scope_id: 'text' },
        classroom_accounts: { id: 'text', email: 'text', disabled: 'boolean' },
      }
      const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
      function restGet(table, params) {
        const cols = Object.keys(REST_COLS[table]).map((c) => `"${c}"`).join(', ')
        const where = [...params.entries()]
          .filter(([k]) => k !== 'select' && k !== 'limit')
          .map(([k, v]) => `"${k}" = ${lit(String(v).replace(/^eq\./, ''))}`)
        return `select ${cols} from ${table}${where.length ? ` where ${where.join(' and ')}` : ''}`
      }
      /** 表名或列名不在 → 与 PostgREST 同款：**42P01** + `relation … does not exist` */
      const missingTable = () =>
        jsonRes({ code: '42P01', message: 'relation "public.classroom_accounts" does not exist' }, 404)

      const realFetch = globalThis.fetch
      /** PostgREST / GoTrue 的回话形状 */
      const jsonRes = (v, status = 200) =>
        new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = String(init?.method ?? 'GET').toUpperCase()
        const token = String(new Headers(init.headers ?? {}).get('authorization') ?? '').replace(
          /^Bearer\s+/i,
          '',
        )
        const body = init?.body ? JSON.parse(String(init.body)) : {}

        /* ---- GoTrue：校验调用者 / 建号 / 改密码 ---- */
        if (/\/auth\/v1\/user$/.test(url)) {
          const uid = TOKEN_OF.get(token)
          return uid ? jsonRes({ id: uid, email: `${uid}@shugao.test` }) : jsonRes({ message: 'invalid jwt' }, 401)
        }
        if (/\/auth\/v1\/admin\/users$/.test(url)) {
          const id = mk('a0', 30 + pwSets.length)
          await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, body.email])
          pwSets.push({ op: 'create', id, email: body.email, password: body.password })
          return jsonRes({ id, email: body.email }, 200)
        }
        if (/\/auth\/v1\/admin\/users\//.test(url)) {
          pwSets.push({ op: 'reset', id: url.split('/').pop(), password: body.password })
          return jsonRes({ id: url.split('/').pop() }, 200)
        }
        if (!/\/rest\/v1\//.test(url)) return realFetch(input, init)

        const u = new URL(url)
        const table = u.pathname.replace('/rest/v1/', '')
        if (!(table in REST_COLS)) return missingTable()
        const params = u.searchParams

        /*
         * 服务端那条链用 service_role key → **属主身份**（与真的 service_role 同款：绕 RLS）；
         * 调用者那条链 → `set local role authenticated` + 假 uid（`classroom_accounts_read`
         * 那条真策略会在这里被执行到）。
         * ⚠️ 整段包在事务里、结束一律 rollback —— 不这么做，`set local role` 会**漏到下一条断言**去，
         *    而症状是 `asUser()` 的 `begin` 报"已经在事务里"（不是本节的红，是一堆看不懂的错）。
         */
        await db.exec('begin')
        try {
          if (token !== SVC_KEY) {
            await db.query(`select set_config('request.jwt.claims', $1, true)`, [claimsOf(token)])
            await db.exec('set local role authenticated')
          }
          if (method === 'GET') {
            const r = await db.query(restGet(table, params))
            return jsonRes(r.rows)
          }
          if (method === 'PATCH') {
            const r = await db.query(
              `update classroom_accounts set disabled = $1 where class_id = $2 returning id`,
              [Boolean(body.disabled), PW.classId],
            )
            return r.rows.length
              ? new Response(null, { status: 204 })
              : jsonRes({ code: 'PGRST116', message: 'no rows updated' }, 404)
          }
          if (method === 'POST') {
            await db.query(
              `insert into classroom_accounts (id, class_id, school_id, name, email, created_by)
               values ($1, $2, (select id from schools order by created_at limit 1), $3, $4,
                       (select id from teachers order by created_at limit 1))`,
              [body.id, PW.classId, body.name, body.email],
            )
            return new Response(null, { status: 201 })
          }
          return jsonRes({ message: `unsupported ${method}` }, 405)
        } catch (e) {
          const m = String(e?.message ?? e)
          return jsonRes({ code: /does not exist/.test(m) ? '42P01' : '23505', message: m }, 409)
        } finally {
          await db.exec('rollback')
        }
      }

      try {
        /*
         * 🔴 负向对照：把 `mayManage()` 里"年级主任"那一支**放宽一档**
         *    （原来要 `scope_id = 本班所在年级`，改成一个恒真的 `true`）——
         *    改的是**内存里的源码文本**，仓库文件一个字节都不动。
         *    期望：下面"别的年级的年级主任"那几条**必须变红**。
         *
         * ⚠️ 写到一个一次性的 `.ts` 再 import：Node 的类型剥离只认**磁盘上的** `.ts` 文件 ——
         *    `data:` URL 走另一条加载路径，`type Env = {` 会当场语法错（试过）。
         *    收尾一律 `rmSync` 删掉那个临时目录。
         */
        const src = readFileSync(resolvePath(APP, 'functions/api/classroom-account.ts'), 'utf8')
        const widened = src.replace(
          /if \(r\.role === 'grade_head'\) return cls\.grade_id != null && r\.scope_id === cls\.grade_id/,
          `if (r.role === 'grade_head') return true /* 负向对照：放宽一档 */`,
        )
        if (NEGATIVE === 'room-account-wider' && widened === src) {
          throw new Error('负向对照锚点没找到：mayManage 里年级主任那一支变了（模式 room-account-wider）')
        }
        const modSrc = NEGATIVE === 'room-account-wider' ? widened : src
        const tmpDir = mkdtempSync(join(tmpdir(), 'shugao-roomacct-'))
        const tmpFile = join(tmpDir, 'classroom-account.ts')
        writeFileSync(tmpFile, modSrc, 'utf8')
        let mod
        try {
          mod = await import(pathToFileURL(tmpFile).href)
        } finally {
          rmSync(tmpDir, { recursive: true, force: true })
        }
        const call = async (body) => {
          const req = new Request('https://x.test/api/classroom-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
            body: JSON.stringify(body),
          })
          const res = await mod.onRequestPost({ request: req, env: ENV })
          return { status: res.status, body: await res.json().catch(() => ({})) }
        }

        /* `classroom_accounts` 里已有的那一行（高二(1)班，§10 的夹具）——
           `status` 这一条要在它上面真读一次库。 */
        const c1Email = (
          await db.query(`select email from classroom_accounts where class_id = $1`, [C.c1])
        ).rows[0].email

        /* ---- ① 🔴 一个字节都不回密码：`status` 三个身份都只拿到账号 ---- */
        for (const [who, uid] of [
          ['超管', U.super],
          ['教务处', U.admin],
          ['本年级年级主任', U.grade],
          ['本班班主任', U.head],
        ]) {
          asActor(uid, C.c1)
          const r = await call({ action: 'status', classId: C.c1 })
          eq(
            `① ${who} 看得见这个班的教室端账号（只回账号）`,
            [r.status, r.body.hasAccount, r.body.account?.email, 'password' in (r.body.account ?? {})],
            [200, true, c1Email, false],
          )
        }
        /* 反向对照：**别的年级的年级主任 / 科任老师 / 教室端** 三档都拿不到结论 */
        for (const [who, uid, cls] of [
          ['别的年级的年级主任（高三）', R_OTHER_HEAD, C.c1],
          ['科任老师（语文老师，教 c1 但不管班）', U.chn, C.c1],
          ['教室端自己', U.room, C.c1],
        ]) {
          asActor(uid, cls)
          const r = await call({ action: 'status', classId: cls })
          eq(
            `🔴 ① 反向对照：${who} → 拿不到（403 / 教室端是那句专门的拒绝）`,
            [r.status, String(r.body.message ?? '').includes('教室端账号没有管理账号的权限') || r.status === 403],
            [403, true],
          )
        }

        /* ---- ② 判据只有一处：逐档比对 `mayManage` 与数据库的 `can_manage_class_for` ---- */
        {
          const rows = (uid) =>
            db
              .query(
                `select role, scope_type::text as scope_type, scope_id::text as scope_id
                   from teacher_roles where teacher_id = $1`,
                [uid],
              )
              .then((r) => r.rows)
          const clsRow = (cid) =>
            db
              .query(`select id, name, grade_id::text as grade_id, school_id::text as school_id from classes where id = $1`, [cid])
              .then((r) => r.rows[0])
          const cases = [
            ['超管', U.super, C.c1],
            ['教务处', U.admin, C.c1],
            ['本年级年级主任', U.grade, C.c1],
            ['本班班主任', U.head, C.c1],
            ['科任老师（语文）', U.chn, C.c1],
            ['别的年级的年级主任', R_OTHER_HEAD, C.c1],
            ['走班班班主任（非本年级主任）', R_STREAM_HEAD, STREAM_CLS],
            ['本年级年级主任 → 本年级的走班班', U.grade, STREAM_CLS],
            ['高三的年级主任 → 高二的走班班', R_OTHER_HEAD, STREAM_CLS],
          ]
          const mismatches = []
          for (const [who, uid, cid] of cases) {
            const mine = mod.mayManage(await rows(uid), await clsRow(cid))
            const dbs = (
              await db.query(`select public.can_manage_class_for($1::uuid, $2::uuid) as v`, [uid, cid])
            ).rows[0].v
            if (mine !== dbs) mismatches.push(`${who}: 服务端 ${mine} / 数据库 ${dbs}`)
          }
          eq(
            '🔴 ② `mayManage()` 九档逐档等于 `can_manage_class_for()`（同一件事没有第二个入口）',
            mismatches,
            [],
          )
        }

        /* ---- ③ 重置密码：四个有权的人都能重置（真打一遍 onRequestPost）---- */
        for (const [who, uid, cls] of [
          ['超管', U.super, C.c1],
          ['教务处', U.admin, C.c1],
          ['本年级年级主任', U.grade, C.c1],
          ['本班班主任', U.head, C.c1],
          ['本年级年级主任 → 本年级的走班班', U.grade, STREAM_CLS],
          /*
           * ⚠️ **已知边界**（核过、写在这里）：库里**真的**挂着一行"走班班的班主任"时，
           *    这个人**管得动**那个走班班 —— 因为 `can_manage_class_for` 的 head_teacher 那一支
           *    判的是 `scope_id = classes.id`，**不看 kind**。用户的口径是"走班班**没有**班主任"，
           *    那是**不发这一行**，不是在代码里另加一句话去挡它（挡它就得再发明一个判据，
           *    而且会顺带把"他能不能批改这个走班班的作业"之类一起搅进来）。
           */
          ['走班班的班主任（库里真挂了一行）→ 他自己的走班班', R_STREAM_HEAD, STREAM_CLS],
        ]) {
          asActor(uid, cls)
          const before = pwSets.length
          const r = await call({ action: 'reset', classId: cls })
          const sent = pwSets.slice(before)
          ok(
            `③ ${who} 重置密码 → 新密码在回话里`,
            r.status === 200 &&
              typeof r.body.account?.password === 'string' &&
              r.body.account.password.length === 12 &&
              sent.length === 1 &&
              sent[0].password === r.body.account.password,
            `HTTP ${r.status} · 回话 ${String(r.body.account?.password ?? '').length} 位 · 打给 GoTrue ${sent.length} 次`,
          )
        }

        /* ---- ④ 🔴 反向对照：没有权限的三档**重置不了**（403，一个 12 位口令都没发出去）---- */
        for (const [who, uid, cls] of [
          ['别的年级的年级主任（高三 → 高二的班）', R_OTHER_HEAD, C.c1],
          ['科任老师（语文老师，教 c1 但不管班）', U.chn, C.c1],
          ['别的年级的年级主任（高三 → 高二的走班班）', R_OTHER_HEAD, STREAM_CLS],
          ['教室端自己', U.room, C.c1],
        ]) {
          asActor(uid, cls)
          const before = pwSets.length
          const r = await call({ action: 'reset', classId: cls })
          eq(
            `🔴 ④ ${who} 重置密码 → 被拒（403），而且**没有任何口令打给 GoTrue**`,
            [r.status, pwSets.length - before],
            [403, 0],
          )
        }

        /* ---- ⑤ 🔴 重置之后：新密码在回话里，**库里不存明文**（再查一次也拿不到）---- */
        {
          asActor(U.head, C.c1)
          const r = await call({ action: 'reset', classId: C.c1 })
          const pw = String(r.body.account?.password ?? '')
          const row = (
            await db.query(`select * from classroom_accounts where class_id = $1`, [C.c1])
          ).rows[0]
          ok(
            '🔴 ⑤ 重置后的那一行里**没有任何一列**等于新密码（Supabase 里存的是哈希，原文拿不回）',
            pw.length === 12 && !Object.values(row).some((v) => String(v) === pw),
            `回话里 ${pw.length} 位 · 行里的列：${Object.keys(row).join('/')}`,
          )
          /* 再查一次（这一回合之后）：`status` 照旧只回账号 */
          const again = await call({ action: 'status', classId: C.c1 })
          eq(
            '🔴 ⑤ 再查一次：照旧**没有** `password` 这个键（"看原密码"这件事本身做不到）',
            [again.status, 'password' in (again.body.account ?? {}), again.body.account?.email],
            [200, false, c1Email],
          )
        }

        /* ---- ⑥ 🆕 走班班：年级主任在班级页看得见、管得动（**本来就已经成立**，这里钉住）---- */
        eq(
          '⑥ 年级主任**看得见**本年级的走班班（`visible_class_ids_for`：按 `grade_id` 取，与 kind 无关）',
          await idsAs(db, U.grade, `select id from classes where id = $1`, [STREAM_CLS]),
          [STREAM_CLS],
        )
        eq(
          '⑥ 反向对照：**高三**的年级主任看不见高二的走班班',
          await idsAs(db, R_OTHER_HEAD, `select id from classes where id = $1`, [STREAM_CLS]),
          [],
        )
        eq(
          '🔴 ⑥ 走班班**有没有 `grade_id`** —— 有值才是"年级主任管得动"的前提（P7 生成时从学生的年级取）',
          (await db.query(`select grade_id::text as g from classes where id = $1`, [STREAM_CLS])).rows[0].g,
          G2,
        )
        ok(
          '🔴 ⑥ 而 **schema 没有把"走班班必须有年级"这条钉住**（`classes.grade_id` 可空、也没有 check）—— ' +
            '手工建的走班班一旦漏了年级，年级主任就静默看不见它（本轮**不加约束**：线上可能已有这种行，加了会让 schema.sql 跑不过；' +
            '入口那一侧照旧——`/classes` 列表与班级页都在，见下面这条）',
          (await db.query(
            `select is_nullable from information_schema.columns
              where table_name = 'classes' and column_name = 'grade_id'`,
          )).rows[0].is_nullable === 'YES',
        )
        const classesPageSrc = readFileSync(resolvePath(APP, 'src/pages/Classes.tsx'), 'utf8')
        ok(
          '⑥ 班级页（`/classes`）**两种班都列**（走班班单独一块，`splitByKind` 是唯一入口）—— 所以年级主任有个地方点进去',
          /splitByKind/.test(classesPageSrc) && /streamClasses/.test(classesPageSrc),
        )
        eq(
          '⑥ 反过来：**行政班**的班主任（非年级主任）管不动别人的走班班',
          await idsAs(db, U.head, `select id from classes where id = $1`, [STREAM_CLS]),
          [],
        )

        /* ---- ⑦ 前端那一层：**摆不摆**（静态读源码 —— 本地演示模式打不开这个块）----
           走班班在班级页上、教室端账号那一块也在班级页上，所以这一节顺手把"前端只决定摆不摆"
           这条纪律也钉住。⚠️ 这里**不是**端到端：本地演示模式没有服务端（`isRemote` false），
           这个块在屏上根本不渲染（`shots.mjs` 也就拍不到它）—— 真正能不能读/能不能重置，
           上面 ①–⑤ 已经在**真服务端 + 真库**上跑过了。 */
        const detailSrc = readFileSync(resolvePath(APP, 'src/pages/ClassDetail.tsx'), 'utf8')
        ok(
          '⑦ 班级档案里那一块**只对管得着这个班的人摆**（`{canManageThis ? … : null}`）—— 科任老师一个字节都看不到账号',
          /\{canManageThis \? \(/.test(detailSrc),
        )
        ok(
          '🔴 ⑦ 而且它**复用页面上已有的那一个粗档**（`canEditClassFor`）—— 没有为它另写一套 role 判断',
          (detailSrc.match(/canEditClassFor\(\s*myRoles/g) ?? []).length === 1 &&
            !/role === 'grade_head'/.test(detailSrc),
          `调用点 ${(detailSrc.match(/canEditClassFor\(\s*myRoles/g) ?? []).length} 处 · 页面里出现 role 判断 ${/role === 'grade_head'/.test(detailSrc) ? '有' : '无'}`,
        )
        ok(
          '⑦ 界面上写着"密码只在生成时显示这一次"（照教师账号那块既有写法；文案只有 `lib/classroomAccount.ts` 那一处）',
          /PASSWORD_SHOWN_ONCE/.test(detailSrc) &&
            /PASSWORD_SHOWN_ONCE\s*=/.test(
              readFileSync(resolvePath(APP, 'src/lib/classroomAccount.ts'), 'utf8'),
            ),
        )
      } finally {
        globalThis.fetch = realFetch
      }
    }

    /* ============================================================
       二十二、🆕 走班班的编辑 / 删除（§37：手工增删 `class_members` 的判据）
       ------------------------------------------------------------
       内测现场：「走班班都没有编辑键」「删不了」。
       核出来的结论：**能做，只是没摆** —— 走班班是 `classes` 里 `kind='stream'` 的一行、
       **有 `grade_id`**，所以 `classes_update` / `classes_delete` 用的
       `can_manage_class_for()` 对它天然成立（§32.6 / 第二十一节已经核过一遍）。
       真正缺的是**成员那一条写路径**：`class_members` 对 `authenticated` **零写权限**
       （§27.8 / §32.4），所以 §37.1 新增了 `write_stream_members()`。

       本节钉的就是那一个函数的判据 + 写法（**判据一个新发明都没有**：
       函数体里第一句就是 `can_manage_class(p_class_id)`）。

       ⚠️ 仍然守着那条纪律：`can_manage_class_for` 的 `head_teacher` 那一支判
          `scope_id = classes.id`、**不看 kind** —— 库里真挂一行"走班班的班主任"时他管得动。
          这不是漏洞，是用户口径（"走班班没有班主任"= **不发那一行**，不是在代码里加一句话去挡）。
       ============================================================ */
    section('二十二、🆕 走班班的编辑 / 删除（`write_stream_members` 的判据与写法）')

    const S10 = {
      cls: mk('c8', 1),
      cls2: mk('c8', 2),
      stu: mk('53', 1),
      stu2: mk('53', 2),
      stuStranger: mk('53', 9),
      /** 高三的年级主任（**本节自己的夹具** —— 第二十一节那个出不了它的作用域） */
      otherHead: mk('a3', 1),
    }
    const SCHOOL1 = '(select id from schools order by created_at limit 1)'
    const G2 = `(select id from grades where name = '高二')`
    const G3 = `(select id from grades where name = '高三')`

    /* 夹具（**必须由属主写**：`class_members` 对 authenticated 零写权限，这正是本节的主题）：
       · 两个**高二**的走班班（单科键，不与 §32.1 的唯一索引打架）
       · 三个高二的学生 + 一个**高三**的学生（年级那一支的反向对照要用）
       · 一个**高三的年级主任**（"管不着高二的走班班"那一档 —— ⚠️ 每个年级只有一个年级主任
         那条部分唯一索引在，所以**先让出**这一档，否则夹具插不进去） */
    await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${S10.otherHead}', 's10-other-head@shugao.test', '{"name":"高三的年级主任"}'::jsonb)
    on conflict (id) do nothing;
    delete from teacher_roles
     where role = 'grade_head' and scope_type = 'grade'
       and scope_id = (select id from grades where name = '高三')
       and teacher_id <> '${S10.otherHead}';
    insert into teacher_roles (id, teacher_id, role, scope_type, scope_id) values
      ('${mk('42', 31)}', '${S10.otherHead}', 'grade_head', 'grade', ${G3})
    on conflict (id) do nothing;
    insert into classes (id, teacher_id, name, grade, year, school_id, grade_id, kind, class_type, stream_key) values
      ('${S10.cls}',  '${U.head}', '走班班-生物', '高二', '2025', ${SCHOOL1}, ${G2}, 'stream', '', 'biology'),
      ('${S10.cls2}', '${U.head}', '走班班-地理', '高二', '2025', ${SCHOOL1}, ${G2}, 'stream', '', 'geography')
    on conflict (id) do nothing;
    insert into students (id, class_id, student_no, name) values
      ('${S10.stu}',  '${C.c1}', '11', '走班甲'),
      ('${S10.stu2}', '${C.c2}', '11', '走班乙'),
      ('${S10.stuStranger}', '${C.c3}', '11', '高三丙')
    on conflict (id) do nothing;
    `)

    /* ⚠️ 用 `countAs`（**不是 `attempt`**）：`attempt` 判的是 `affectedRows`，而
       `select <函数>` 的 affectedRows 是 0（它没有 DML 计数），会被读成"blocked"——
       那是**假红**。`countAs` 只判"这一回合有没有报错"，报错就是被拒（§三.1 的假绿 / 假红）。 */
    const callMembers = (uid, cid, ids) =>
      countAs(db, uid, `select public.write_stream_members($1::uuid, $2::uuid[]) is not null as n`, [
        cid,
        ids,
      ])
        .then((n) => ({ outcome: n === 1 ? 'ok' : 'blocked', detail: String(n) }))
        .catch((e) => ({ outcome: 'denied', detail: shortErr(e) }))
    const memberCount = (cid) =>
      db
        .query(`select count(*)::int as n from class_members where class_id = $1`, [cid])
        .then((r) => Number(r.rows[0].n))

    /* 前置：夹具真的落成"走班班"了（不然下面每条都会以别的理由红，读不出真原因） */
    eq(
      '⓪ 前置：夹具那一行真的是 `kind = stream`（函数第一句判的就是它）',
      (
        await db.query(`select kind, grade_id::text as g from classes where id = $1`, [S10.cls])
      ).rows[0],
      { kind: 'stream', g: (await db.query(`select id::text as g from grades where name = '高二'`)).rows[0].g },
    )

    /* ---- ① 判据那一档：能管这个走班班的人都能增删（与 `can_manage_class_for` 同一把尺子）----
       ⚠️ `U.head`（c1 的班主任）**不在这里** —— 他不是这个走班班的班主任，见下面 ② 的反向对照。 */
    for (const [who, uid] of [
      ['最高管理员', U.super],
      ['教务处', U.admin],
      ['本年级（高二）的年级主任', U.grade],
    ]) {
      const r = await callMembers(uid, S10.cls, [S10.stu, S10.stu2])
      allowed(`① ${who} 手工增删走班班成员`, r)
    }

    /* ---- ② 反向对照：不管这个班的人一律拒（**真的走到函数体里那句 can_manage_class**）---- */
    for (const [who, uid] of [
      ['科任老师（教这个走班班所在的年级，但不是管理身份）', U.phy],
      ['无身份的新老师', U.fresh],
      ['别的年级（高三）的年级主任', S10.otherHead],
      ['教室端账号', U.room],
      ['这个走班班的**行政班**班主任（`U.head` 是 c1 的班主任，管不着 c1 之外的班）', U.head],
    ]) {
      const r = await callMembers(uid, S10.cls, [S10.stu])
      denied(`🔴 ② 反向对照：${who} → 改不动`, r)
    }

    /* ---- ③ 反向对照：拿一个**行政班**的 id 进来 → 显式报错（不许静默）---- */
    {
      const r = await callMembers(U.super, C.c1, [S10.stu])
      denied('🔴 ③ 反向对照：拿**行政班**的 id 调它 → 报错"这不是走班班"（显式，不静默）', r)
      ok(
        '🔴 ③ 而且报的是**人话**（不是 42501 那种"权限"）—— 说明它真的走到了"kind 不对"那一句',
        /这不是走班班/.test(String(r.detail ?? '')),
        String(r.detail ?? '').slice(0, 120),
      )
    }

    /* ---- ④ 反向对照：**别年级**的学生塞不进来（年级那一支）---- */
    {
      const r = await callMembers(U.super, S10.cls, [S10.stuStranger])
      denied('🔴 ④ 反向对照：**高三**的学生不能塞进高二的走班班', r)
      ok(
        '🔴 ④ 报的是年级那句人话（不是静默放进去了）',
        /不在这个走班班所属的年级/.test(String(r.detail ?? '')),
        String(r.detail ?? '').slice(0, 120),
      )
    }

    /* ---- ⑤ 真的写进去了（两张皮：`attempt` 里那一回合写完就 rollback，所以另起一步由属主写）---- */
    await db.exec(`insert into class_members (class_id, student_id) values
      ('${S10.cls}', '${S10.stu}'), ('${S10.cls}', '${S10.stu2}') on conflict do nothing`)
    eq('⑤ 增：两个成员真的落在 `class_members` 上（不是 `students.class_id`）', await memberCount(S10.cls), 2)
    eq(
      '⑤ 而且**没碰** `students.class_id`（学生的行政班照旧是 c1 / c2）',
      (
        await db.query(`select class_id::text as c from students where id = $1`, [S10.stu])
      ).rows[0].c,
      C.c1,
    )
    await db.exec(`delete from class_members where class_id = '${S10.cls}' and student_id = '${S10.stu2}'`)
    eq('⑤ 删：移掉一个成员 → 只剩一行', await memberCount(S10.cls), 1)

    /* ---- ⑥ 🔴 一个学生同时在两个走班班（多对多，**不许被去重**）---- */
    await db.exec(`insert into class_members (class_id, student_id) values
      ('${S10.cls2}', '${S10.stu}') on conflict do nothing`)
    eq(
      '🔴 ⑥ 一个学生**同时在两个走班班**里 → 两行都在（多对多没被去重）',
      (
        await db.query(
          `select class_id::text as id from class_members where student_id = $1 order by class_id`,
          [S10.stu],
        )
      ).rows.map((r) => r.id).sort(),
      [S10.cls, S10.cls2].sort(),
    )

    /* ---- ⑦ 🔴 反向对照（判据那一侧）：把"能管"放宽一档 → 上面 ② 里那些"被拒"必须变红 ----
       ⚠️ 这条对照**不跑**（它是给人看的判据说明），真正的负向对照由 `RLS_NEGATIVE=p10-…` 那套跑。
          这里只核**同一把尺子**：函数的结论 == `can_manage_class_for()` 的结论。 */
    {
      const mismatches = []
      for (const [who, uid] of [
        ['超管', U.super],
        ['教务处', U.admin],
        ['高二的年级主任', U.grade],
        ['科任老师', U.phy],
        ['无身份新老师', U.fresh],
        ['c1 的班主任', U.head],
        ['教室端', U.room],
      ]) {
        const direct = (
          await db.query(`select public.can_manage_class_for($1::uuid, $2::uuid) as v`, [uid, S10.cls])
        ).rows[0].v
        const viaFn = await callMembers(uid, S10.cls, [])
        if (direct !== (viaFn.outcome === 'ok')) mismatches.push(`${who}: 函数 ${viaFn.outcome} / 判据 ${direct}`)
      }
      eq(
        '🔴 ⑦ `write_stream_members()` 的结论**逐档等于** `can_manage_class_for()`（同一件事没有第二个判据）',
        mismatches,
        [],
      )
    }

    /* ---- ⑧ 客户端**照旧**零写权限（函数是唯一那条路）---- */
    denied(
      '⑧ `class_members` 客户端直写**照旧被拒**（写只走 §37.1 那个函数）',
      await attempt(
        db,
        U.super,
        `insert into class_members (class_id, student_id) values ($1, $2)`,
        [S10.cls2, S10.stu2],
      ),
    )
    eq(
      '⑧ 对照：上面那条"被拒"不是"这一行本来就存在"（换成另一个学生也拒）',
      (await attempt(db, U.admin, `insert into class_members (class_id, student_id) values ($1, $2)`, [S10.cls, S10.stuStranger])).outcome,
      'denied',
    )

    /* ---- ⑨ `classes_delete` 对走班班天然成立（"删不了"那一半的判据）---- */
    eq(
      '🔴 ⑨ 年级主任**删得掉**本年级的走班班（`classes_delete` 用的就是 `can_manage_class_for`，不看 kind）',
      (await attempt(db, U.grade, `delete from classes where id = $1 returning id`, [S10.cls2])).outcome,
      'ok',
    )
    denied(
      '🔴 ⑨ 反向对照：**别的老师**（`U.fresh`，c4 的班主任但没有任何管理身份）删不掉这个走班班',
      await attempt(db, U.fresh, `delete from classes where id = $1 returning id`, [S10.cls]),
    )
    /* ⚠️ **不用 `U.head` 当这一条的反向对照**：他是这个走班班的 `teacher_id`（夹具里那么写的），
       而 `classes_delete` 的策略是 `can_manage_class(id) or owns_class(id)` ——
       `owns_class()` 那一支对"建档人"放行，那是**既有语义**（§16.3），不是漏洞。
       拿他当"删不掉"的反例会得出"策略坏了"的错误结论（假红）。 */
    eq(
      '🔴 ⑨ 反过来（登记这条已知边界）：**这个走班班的 `teacher_id` 本人**删得掉 —— `owns_class()` 那一支放行',
      (await attempt(db, U.head, `delete from classes where id = $1 returning id`, [S10.cls])).outcome,
      'ok',
    )
    denied(
      '🔴 ⑨ 反向对照：科任老师删不掉（`U.phy` 教 c1 / c2，但这个走班班不归他管）',
      await attempt(db, U.phy, `delete from classes where id = $1 returning id`, [S10.cls]),
    )
    eq(
      '🔴 ⑨ `class_members` 是 `on delete cascade` —— 删走班班**不留孤儿成员行**',
      await memberCount(S10.cls),
      1,
    )
    eq(
      '🔴 ⑨ 反向对照：`class_members.class_id` 对 `classes(id)` 的那条外键写着 cascade（不是"靠人清"）',
      (
        await db.query(
          `select confdeltype::text as t from pg_constraint
            where conrelid = 'class_members'::regclass and contype = 'f'
              and conkey = array[(select attnum from pg_attribute
                                   where attrelid = 'class_members'::regclass and attname = 'class_id')]`,
        )
      ).rows.map((r) => r.t),
      ['c'],
    )

    /* ---- ⑩ 前端那一层：入口判据是数据库那条的前端影子，且成员写的是 `class_members` ---- */
    {
      const clSrc = readFileSync(resolvePath(APP, 'src/pages/Classes.tsx'), 'utf8')
      ok(
        '⑩ 班级页的走班班入口用 `canEditClassFor(myRoles, c.id, c.gradeId)`（`can_manage_class_for` 的前端影子）',
        /canEditClassFor\(myRoles, c\.id, c\.gradeId\)/.test(clSrc),
      )
      ok(
        '🔴 ⑩ 而且这个判据**不复用 `.kind`**（权限判断与"是不是走班班"是两件事）',
        !/canEditClassFor\([^)]*kind/.test(clSrc),
      )
      ok(
        '🔴 ⑩ 成员那一条写路径的名字对得上（`saveStreamMembers` → `write_stream_members`）',
        /saveStreamMembers/.test(clSrc) &&
          /write_stream_members/.test(readFileSync(resolvePath(APP, 'src/data/remote.ts'), 'utf8')),
      )
    }



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
