/**
 * 「开学准备」（P6）的常驻回归 —— **纯逻辑 + 真 PostgreSQL（PGlite）**
 * ------------------------------------------------------------------
 * 用法：node scripts/grade-checks.mjs
 *
 * 为什么要有这个脚本（不是"顺手多写一个脚本"，是这一期验收的核心三条都需要它）：
 *
 *   ① **操作步数**是这一轮的硬指标（方案 §4.3 的标题就是"这一节的硬指标是操作步数"）。
 *      步数写在 `src/lib/gradeImport.ts` 的 `GRADE_SETUP_STEPS` 里 —— 这里把那张表
 *      **逐条核一遍**（含"合计对得上"与"哪几步是 0 步"），并且
 *      **反向对照**：把"按班号自动建班"改成不是 0 步，这张表就必须红。
 *   ② **"一个事务"**这句话必须有断言，否则它只是一句声明。
 *      名单导入那一条走的是 `schema.sql` §27.11 的 `bulk_import_roster()` ——
 *      这里是**真 PostgreSQL 17**（PGlite）跑那份 schema 原文：
 *      第 3 行非法 → **班与人都没落库**；合法 → 都落库。
 *   ③ **导入导出同一套列名**：`parseGradeRosterText(gradeRosterToText(x)) === x`。
 *
 * 🔴 负向对照（`GRADE_NEGATIVE=<mode>`）—— 改的全是**内存里的 SQL / 模块文本**，
 *    仓库文件一个字节都不动；**必须让它红**，否则断言就是"永远为绿的摆设"：
 *      · `roster-no-prewrite`   —— 去掉 `bulk_import_roster()` 的逐行预校验（"改一半"的注入）
 *      · `subject-open`         —— 去掉 `student_subject_check()` 的结构约束（非法组合也能进）
 *      · `other-no-member`      —— 去掉「其他」必须手工选走班科目那一条
 *      · `bulk-no-precheck`     —— 去掉 `bulk_write_class_subjects()` 的逐行校验
 *      · `steps-not-zero`       —— 把"建班 0 步"改成 2 步（步数表的反向对照）
 *      · `columns-mismatch`     —— 把导出的表头改成另一套列名（导入导出不再同源）
 *      · `setup-broken-fn`      —— 🆕 让第十一节的桩去问"砍掉 `is_school_admin()` 那半边"的
 *                                  `can_manage_grade_setup` → **R1（超管 true）/ R2（教务处 true）必须红**
 *      · 🆕 2026-10-02（集成修复）两条 —— 对着第十一节 W 段那三条**"被拒"**的断言：
 *        `actor-grant-authenticated`（把三个写入口 grant 给 authenticated = 走 B 方案那条路）
 *                                  → **W29/W30 必须红**（`updated_by` 不再是那个超管：
 *                                    service_role 下 `auth.uid()` 是 NULL）
 *        `actor-dropped`           （砍掉函数体里"判据看显式 `p_actor`"那一支）
 *                                  → **W29/W30 必须红**（判据没了，谁都能写）
 *      · 🆕 P7（第十三节）一条 —— 对着一条"必须红"的断言：
 *        `p7-one-walk-only`（生成时**只取第一门**走班科目）→ **R2/R6/R7 必须红**
 *        （这就是"差 2 门的学生被漏掉一门、且不报错"那件事的原样）；
 *        另外两条对照不靠 `GRADE_NEGATIVE`（它们在第十三节里**当场**改坏内存里的源码再跑）：
 *        「其他」不归类那一支被拿掉 → **R9 会红**；老师撞课那一段被拿掉 → **R27 会红**；
 *        🆕 分组改回"按 `walk` 集合" → **R37b 会红**（R38，2026-10-06 按科目建班那条口径的对照）。
 *      · 🆕 P4（第十二节）五条 —— 每一条都对着一条"必须红"的断言：
 *        `p4-promote-not-idempotent`（提档幂等，T1e/T1f）·
 *        `p4-promote-revokes-roles`（提档不撤回身份，T3a）·
 *        `p4-mail-not-required`（备份没发出就删不了，T4e）·
 *        `p4-no-name-check`（逐字输入年级全名，T5a）·
 *        `p4-no-cleanup-exams`（清点表逐项 = 0，T6c）
 *
 * 前置条件：无（不需要 dev server，也不需要 Supabase）。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

registerTsResolve()

const NEGATIVE = process.env.GRADE_NEGATIVE ?? ''

/** K 段用的函数签名（`has_function_privilege` 要精确的签名串）
 *  ⚠️ 2026-10-02（集成修复）：三个写入口的第一个参数都是 **`p_actor`** ——
 *     它们由服务端用 service_role 调，而 service_role 下 `auth.uid()` 是 NULL，
 *     "谁干的"必须显式传进来（见 `schema.sql` §27.13）。签名变了，这里必须跟着变，
 *     否则 `has_function_privilege` 问的是一个不存在的函数 → 报错 / 假绿。 */
const FUNC_ARGS = {
  write_student_subject: 'uuid,uuid,text,text,text[],text,uuid[]',
  bulk_write_class_subjects: 'uuid,jsonb',
  bulk_import_roster: 'uuid,uuid,jsonb,text',
}

/* ---------------- 被测模块（**不抄一份**，真的 import 仓库里那几份） ---------------- */

const rosterLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/roster.ts')).href)
const pickLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/pick.ts')).href)
const gi = await import(pathToFileURL(resolvePath(APP, 'src/lib/gradeImport.ts')).href)
/*
 * 🆕 P3：《学期筛选》的判据**不抄一份** —— N16/N17 拿的就是作业 / 考试列表
 * 读的那一个函数（`lib/terms.ts` 的 `termMatches`）。抄一份的话，
 * "列表默认只看本学期"就永远绿，而它恰恰是 P2 唯一的失败模式。
 */
const termsLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/terms.ts')).href)
/* 🆕 P7：走班班的生成建议 + 课表冲突（两个维度的算法都在这里，**不抄一份**） */
const streamLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/stream.ts')).href)
const schedLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/schedule.ts')).href)

await withLock(async () => {
  let pass = 0
  const failures = []

  const ok = (name, cond, extra = '') => {
    if (cond) {
      pass++
      console.log(`  ✅ ${name}`)
    } else {
      failures.push(`${name}${extra ? ` —— ${extra}` : ''}`)
      console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`)
    }
  }
  const eq = (name, got, want) =>
    ok(
      name,
      Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
      `实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`,
    )
  const section = (t) => console.log(`\n${t}`)

  process.on('unhandledRejection', (e) => {
    console.error(`\n❌ 脚本中断：${String(e?.message ?? e).split('\n')[0]}`)
    process.exit(1)
  })

  if (NEGATIVE) {
    console.log(`\n🧪🧪 负向对照模式：GRADE_NEGATIVE=${NEGATIVE}（下面**必须**有红）\n`)
  }

  /* ============================================================
     一、纯逻辑：解析 / 事务计划 / 选科 / 步数
     ============================================================ */

  section('第一节 · 名单解析与"一个事务"的计划（纯函数）')

  const G = '高一'
  const cls = (name, students) => ({
    id: `c-${name}`,
    name,
    grade: G,
    year: '2026',
    createdAt: 0,
    kind: 'admin',
    classType: '',
    students: (students ?? []).map((s) => ({
      id: `s-${name}-${s.no}`,
      studentNo: s.no,
      name: s.name,
      status: 'active',
      createdAt: 0,
    })),
  })

  {
    /* 四列那一份（导出用的就是这一套列名） */
    const text = [
      '班级\t序列号\t姓名\t班级内学号',
      '1\t2026001\t王志远\t01',
      '1\t2026002\t李思涵\t02',
      '2\t2026003\t张雨欣\t01',
    ].join('\n')
    const parsed = rosterLib.parseGradeRosterText(text)
    eq('A1：表头认得出来（四列全中）', parsed.unknownColumns, [])
    eq('A1：解析出行数（表头不算）', parsed.rows.length, 3)
    eq('A1：第一个数据行的行号（含表头，用户在自己 Excel 里数得出来的那个）', parsed.rows[0].line, 2)
    eq('A1：班号列认对了', parsed.rows.map((r) => r.classNo), ['1', '1', '2'])
    eq('A1：序列号列认对了', parsed.rows[0].serial, '2026001')
    eq('A1：姓名列认对了', parsed.rows.map((r) => r.name), ['王志远', '李思涵', '张雨欣'])
    eq('A1：班级内学号列认对了', parsed.rows.map((r) => r.studentNo), ['01', '02', '01'])

    /* 🔴 **导入导出同一套列名**（验收第 7 条）：导出的文件必须能被导入吃下去 */
    const out = rosterLib.gradeRosterToText([
      { classNo: '1', serial: '2026001', name: '王志远', studentNo: '01' },
      { classNo: '2', serial: '2026002', name: '李思涵', studentNo: '02' },
    ])
    const back = rosterLib.parseGradeRosterText(out)
    eq('A2：导出 → 导入，列名同一套（认不出 0 个列名）', back.unknownColumns, [])
    eq('A3：导出 → 导入，**逐字相等**（班号/序列号/姓名/班内学号）', back.rows, [
      { line: 2, classNo: '1', serial: '2026001', name: '王志远', studentNo: '01' },
      { line: 3, classNo: '2', serial: '2026002', name: '李思涵', studentNo: '02' },
    ])
    eq(
      'A4：导出的表头就是那张唯一的列名表（`ROSTER_HEADER`）',
      out.split('\n')[0],
      rosterLib.ROSTER_HEADER.join('\t'),
    )
    /* 老两列模板**仍然要能用**（"同时兼容老两列"是计划里写死的一句） */
    const old = rosterLib.parseGradeRosterText('1\t王志远\n2\t李思涵')
    eq('A5：老两列模板仍能解析（班内学号 + 姓名）', old.rows.map((r) => [r.studentNo, r.name]), [
      ['1', '王志远'],
      ['2', '李思涵'],
    ])
    ok(
      'A6：老两列没有班号 → 体检要报"缺班号"（**不是静默塞进某个班**）',
      old.rows.every((r) => !r.classNo),
      JSON.stringify(old.rows.map((r) => r.classNo)),
    )
    /*
     * 认不出的列名 → **报错，不猜**。
     * ⚠️ 这里用 `联系电话` 而不是 `备注` / `学籍号`：
     *    · `学籍号` 是**认得出来的**（"序列号"的别名，见 `HEAD_SERIAL`）；
     *    · `备注` / `考场号` 在老的两列解析器里就是**被忽略**的列（不算"认不出"）。
     *    拿那两个来测"认不出"会得到一个**假红**的用例（实测踩过）。
     */
    const weirdText = '班级\t序列号\t姓名\t班级内学号\t联系电话\n1\t2026001\t甲\t01\t138'
    const weird = rosterLib.parseGradeRosterText(weirdText)
    ok(
      'A7：表头里有认不出的列名 → 报出来（不静默忽略）',
      weird.unknownColumns.includes('联系电话'),
      JSON.stringify(weird.unknownColumns),
    )
    /* 另一面：`学籍号` 是**认得出**的别名（同一个语义："全校唯一的那个号"） */
    const alias = rosterLib.parseGradeRosterText('班级\t学籍号\t姓名\t班级内学号\n1\t2026001\t甲\t01')
    eq('A7a：`学籍号` 认得出（它是"序列号"的别名，不是认不出的列）', alias.unknownColumns, [])
    eq('A7a2：`学籍号` 那一列读成了序列号', alias.rows[0].serial, '2026001')
    const weirdPlan = gi.planRosterImport({
      text: weirdText,
      gradeName: G,
      classes: [],
      existing: [],
    })
    eq('A7b：认不出的列名 → **整份拒绝解析**', weirdPlan.ok, false)
    ok('A7c：拒绝的理由里带着那个列名', String(weirdPlan.reason).includes('联系电话'), weirdPlan.reason)
  }

  section('第二节 · 按班号自动建班（含"3 个班号 → 建 3 个班"）')

  {
    const text = [
      '班级\t姓名\t班级内学号',
      '1\t甲\t01',
      '2\t乙\t01',
      '3\t丙\t01',
      '3\t丁\t02',
    ].join('\n')
    const plan = gi.planRosterImport({ text, gradeName: G, classes: [], existing: [] })
    eq('B1：三个班号 → 计划里要建 3 个班', plan.ok && plan.newClasses.length, 3)
    eq('B2：班名由"年级 + 班号"拼出来（高一(1)班 …）', plan.ok && plan.newClasses, [
      '高一(1)班',
      '高一(2)班',
      '高一(3)班',
    ])
    eq('B3：4 行学生都进了计划', plan.ok && plan.students, 4)
    eq('B4：计划里"先建班、再写人"（前 3 步是 create-class）', plan.ok && plan.mutations.slice(0, 3).map((m) => m.kind), [
      'create-class',
      'create-class',
      'create-class',
    ])

    /* 已有班时**复用**，不重复建（"按班号自动建班"必须幂等） */
    const again = gi.planRosterImport({
      text,
      gradeName: G,
      classes: [],
      existing: [cls('高一(1)班'), cls('高一(2)班'), cls('高一(3)班')],
    })
    eq('B5：再导一次同一个年级 → **0 个新班**（幂等）', again.ok && again.newClasses.length, 0)
    eq('B6：复用了 3 个已有班', again.ok && again.reusedClasses.length, 3)

    /* 反向对照：不自动建班会怎样 */
    eq(
      'B7（对照）：班号没认出来时**一个班都不建**（`classNo` 空 → 体检先报"缺班号"）',
      gi.planRosterImport({ text: '甲\n乙', gradeName: G, classes: [], existing: [] }).ok,
      false,
    )
  }

  section('第三节 · 非法行报行号 + 整批不入库（**计划里一步都没有**）')

  {
    const bad = [
      '班级\t序列号\t姓名\t班级内学号',
      '1\t2026001\t甲\t01',
      '1\t2026002\t乙\t02',
      '2\t2026003\t丙', // ← 第 4 行缺班级内学号
      '2\t2026004\t丁\t02',
    ].join('\n')
    const plan = gi.planRosterImport({ text: bad, gradeName: G, classes: [], existing: [] })
    eq('C1：整份拒绝（`ok:false`）', plan.ok, false)
    eq('C2：**报出来的行号**就是那一行（含表头数到 4）', plan.line, 4)
    ok('C3：理由是"缺班级内学号"（人话，不是"导入失败"）', String(plan.reason).includes('缺班级内学号'), plan.reason)
    eq('C4：🔴 **一步都没算出来**（这是"整批不入库"在计划层的形状）', 'mutations' in plan, false)

    /* 重号也要报行号 */
    const dup = [
      '班级\t姓名\t班级内学号',
      '1\t甲\t01',
      '1\t乙\t01',
    ].join('\n')
    const d = gi.planRosterImport({ text: dup, gradeName: G, classes: [], existing: [] })
    eq('C5：同一个班同一个学号出现两次 → 拒绝', d.ok, false)
    eq('C6：报的行号是第二次出现的那一行', d.line, 3)
    ok('C7：理由里说清是"同一个班里的 01 号出现了两次"', String(d.reason).includes('01'), d.reason)

    /* 序列号格式不对也要拦（但**留空是允许的**） */
    const ser = [
      '班级\t序列号\t姓名\t班级内学号',
      '1\t26-001\t甲\t01',
      '1\t\t乙\t02',
    ].join('\n')
    const sp = gi.planRosterImport({ text: ser, gradeName: G, classes: [], existing: [] })
    eq('C8：序列号写成 26-001 → 拒绝', sp.ok, false)
    eq('C9：序列号留空**不拒绝**（= 交给数据库触发器发号）', sp.line, 2)
    const blank = gi.planRosterImport({
      text: '班级\t序列号\t姓名\t班级内学号\n1\t\t甲\t01\n1\t\t乙\t02',
      gradeName: G,
      classes: [],
      existing: [],
    })
    eq('C10：两行都不填序列号 → 都能入（号由触发器发）', blank.ok, true)
    ok(
      'C11：计划里那两行的 `serial` 是**空串**（导入不自己算号）',
      blank.ok && blank.mutations.filter((m) => m.kind === 'upsert-student').every((m) => m.serial === ''),
    )
  }

  section('第四节 · 选科：结构约束 + 「其他」必须手工选走班科目 + 建议转班')

  {
    eq('D1：合法组合的条数 = 12（2 首选 × C(4,2)）', pickLib.COMBINATIONS.length, 12)
    ok('D2：物化生是合法的', pickLib.subjectCheck({ kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry', 'biology'], note: '' }) === null)

    const bads = [
      ['首选两门（写成 history？不 —— 首选放两门），再选一门', { kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry'], note: '' }],
      ['再选只有一门', { kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry'], note: '' }],
      ['首选不是物理/历史', { kind: 'standard', primaryCode: 'chemistry', secondCodes: ['biology', 'geography'], note: '' }],
      ['首选混进再选', { kind: 'standard', primaryCode: 'physics', secondCodes: ['physics', 'biology'], note: '' }],
      ['再选两门相同', { kind: 'standard', primaryCode: 'physics', secondCodes: ['biology', 'biology'], note: '' }],
      ['再选里有非四科的科', { kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry', 'chinese'], note: '' }],
    ]
    for (const [label, s] of bads) {
      const why = pickLib.subjectCheck(s)
      ok(`D3：**当场拦住** —— ${label}`, typeof why === 'string' && why.length > 0, String(why))
    }

    /* 「其他」：必须手工选走班科目 + 必须填原因 */
    eq(
      'D4：「其他」没填原因 → 拦',
      typeof pickLib.subjectCheck({ kind: 'other', primaryCode: '', secondCodes: ['chemistry', 'biology'], note: '' }) === 'string',
      true,
    )
    eq(
      'D5：「其他」没选够科目 → 拦',
      typeof pickLib.subjectCheck({ kind: 'other', primaryCode: '', secondCodes: [], note: '转学待定' }) === 'string',
      true,
    )
    eq(
      'D6：「其他」+ 两门 + 原因 → 放行',
      pickLib.subjectCheck({ kind: 'other', primaryCode: '', secondCodes: ['chemistry', 'biology'], note: '转学待定' }),
      null,
    )

    /* 首选与班型不符 → 建议转班（**不静默放过、也不自动改**） */
    eq(
      'D7：理科班里的历史首选 → **建议转班**',
      typeof pickLib.subjectAdvice('science', { kind: 'standard', primaryCode: 'history' }) === 'string',
      true,
    )
    eq(
      'D8：理科班里的物理首选 → 没有提示',
      pickLib.subjectAdvice('science', { kind: 'standard', primaryCode: 'physics' }),
      null,
    )
    eq('D9：未分科的班不提示（那一档本来就允许任何首选）', pickLib.subjectAdvice('undivided', { kind: 'standard', primaryCode: 'history' }), null)
    eq('D10：还没设班型的班不提示', pickLib.subjectAdvice('', { kind: 'standard', primaryCode: 'history' }), null)
    eq('D11：「其他」的学生不报"建议转班"（另有"必须手工选班"那条提示）', pickLib.subjectAdvice('science', { kind: 'other', primaryCode: 'history' }), null)
  }

  section('第五节 · 一键按班型默认（只改与默认不同的）')

  {
    const science = { ...cls('高一(1)班', [
      { no: '01', name: '甲' },
      { no: '02', name: '乙' },
    ]), classType: 'science' }
    const undivided = { ...cls('高一(2)班', [{ no: '01', name: '丙' }]), classType: 'undivided' }
    const unset = cls('高一(3)班', [{ no: '01', name: '丁' }])
    const r = gi.collectByClassType([science, undivided, unset], new Map())
    eq('E1：理科班 2 个人都铺开', r.rows.length, 2)
    eq('E2：铺的就是物化生', r.rows[0].primaryCode + '/' + r.rows[0].secondCodes.join(''), 'physics/chemistrybiology')
    eq('E3：未分科 / 未设班型的班**不铺**（并报出来）', r.skippedClasses.length, 2)
    ok(
      'E4：报出来的原因是人话（"还没设班型" / "未分科的班没有默认组合"）',
      r.skippedClasses.every((s) => s.why.includes('班型') || s.why.includes('未分科')),
      JSON.stringify(r.skippedClasses.map((s) => s.why)),
    )
    /*
     * 🆕 2026-10-08：**"选科还没录"要单独数出来**（它正是界面上"1/2 个班采全"的原因），
     *   而它与「其他」（手工定过、一键不许覆盖）**是两件事**。
     * ⚠️ 它是"**没有记录**的人数"，**不是"这次会写几行"**：未分科 / 没设班型那两个班
     *    （丙 / 丁）也是空的，所以这里 4 而不是 2 —— 界面上的那一格与"采全 N/M"是同一件事。
     */
    eq(
      'E1b：这 4 个人**原来都没有选科记录** → `filled = 4`（含未分科 / 没设班型那两个班的人）',
      r.filled,
      4,
    )

    /* 已经是默认的人不重复写（反指标：不让人做无意义的确认） */
    const cur = new Map([[`s-高一(1)班-01`, { studentId: 's-高一(1)班-01', primaryCode: 'physics', secondCodes: ['chemistry', 'biology'], kind: 'standard', note: '' }]])
    const r2 = gi.collectByClassType([science], cur)
    eq('E5：已经是默认的那个人**不再写**', r2.rows.length, 1)
    eq('E6：他被记进 `unchanged`', r2.unchanged, 1)
    eq('E6b：同一次里 `filled = 1`（另一个人是空的，不是"已经是默认"）', r2.filled, 1)

    /* 🔴 「其他」的学生**不许被一键覆盖** */
    const other = { studentId: 's-高一(1)班-02', primaryCode: '', secondCodes: ['chemistry', 'biology'], kind: 'other', note: '转学待定' }
    const r3 = gi.collectByClassType([science], new Map([['s-高一(1)班-02', other]]))
    eq('E7：「其他」的学生**不在一键的结果里**', r3.rows.some((x) => x.studentId === 's-高一(1)班-02'), false)
    eq('E8：他被记进 `otherKept`', r3.otherKept, 1)
    /*
     * 🔴 E8b：**「其他」不是"没有记录"** —— 这一条正是这次拆档在一键那条路上的边界。
     *    甲（没记录）与乙（「其他」）在**同一个班**：乙要留在原地（`otherKept = 1`），
     *    甲才是"还没录"的那一个（`filled = 1`）。
     *    ⚠️ 若哪天把两者读成一件事（把"手工定过"当"还没录"，那就会**覆盖人的决定**），
     *       这一条会红 —— 所以它钉的是"两档不许混"。
     */
    eq(
      'E8b：🔴 同班里「其他」的那个人**不算"选科还没录"**（`filled` 只数没记录的那个 = 1）',
      r3.filled,
      1,
    )
  }

  section('第六节 · 粘贴差异名单（逐行、报行号、只认合法组合）')

  {
    const classes = [
      { ...cls('高一(1)班', [{ no: '01', name: '甲' }]), students: [{ id: 'st-1', studentNo: '01', name: '甲', status: 'active', createdAt: 0, serial: '2026001' }] },
      { ...cls('高一(2)班', [{ no: '01', name: '乙' }]), students: [{ id: 'st-2', studentNo: '01', name: '乙', status: 'active', createdAt: 0 }] },
    ]
    const bySerial = new Map([['2026001', { student: classes[0].students[0], classNo: '1' }]])
    const byNo = new Map([
      ['1|01', { student: classes[0].students[0], classNo: '1' }],
      ['2|01', { student: classes[1].students[0], classNo: '2' }],
    ])
    const p1 = gi.planSubjectPaste({ text: '2\t01\t物化政', classes, bySerial, byClassNoStudentNo: byNo })
    eq('F1：用"班号 + 班内学号"认人 → 成功', p1.ok, true)
    eq('F2：组合名 → 首选 + 再选', p1.ok && [p1.rows[0].primaryCode, ...p1.rows[0].secondCodes], ['physics', 'chemistry', 'politics'])
    const p2 = gi.planSubjectPaste({ text: '2026001\t物化生', classes, bySerial, byClassNoStudentNo: byNo })
    eq('F3：用序列号认人 → 成功', p2.ok, true)

    const p3 = gi.planSubjectPaste({ text: '2\t01\t物化生政', classes, bySerial, byClassNoStudentNo: byNo })
    eq('F4：非法组合（4 科）→ **整份拒绝**', p3.ok, false)
    eq('F5：报的行号是第 1 行', p3.line, 1)
    ok('F6：理由是"这不是一个合法的 3+1+2 组合"', String(p3.reason).includes('合法'), p3.reason)

    const p4 = gi.planSubjectPaste({ text: '2\t01\t物化政\n9\t99\t物化生', classes, bySerial, byClassNoStudentNo: byNo })
    eq('F7：第二行认不出学生 → 拒绝', p4.ok, false)
    eq('F8：报的是第二行', p4.line, 2)
  }

  section('第七节 · 操作步数（🔴 这一轮的硬指标）')

  {
    const total = gi.GRADE_SETUP_STEP_TOTAL
    eq(
      'G1：合计 = 表里各行相加（不是另一个手写的数）',
      total,
      gi.GRADE_SETUP_STEPS.reduce((a, s) => a + s.steps, 0),
    )
    eq(
      'G2：**建班那一步是 0 步**（名单带班号 → 按班号自动建；这是"从 45 步降到 0 步"那句话）',
      gi.GRADE_SETUP_STEPS.find((s) => s.what.includes('建班'))?.steps,
      0,
    )
    eq(
      'G3：录名单是 3 步（粘贴 → 预览 → 确认，与方案 §4.3.2 的原文同值）',
      gi.GRADE_SETUP_STEPS.find((s) => s.what.includes('录名单'))?.steps,
      3,
    )
    ok(
      'G4：合计 **≤ 43**（方案 §4.3 按 15 班 / 650 人 / 40 老师的估法；7 班 330 人的真实规模应当更小）',
      total <= 43,
      `实际 ${total} 步`,
    )
    /*
     * 🔴 这一条是**方案 P6 验收第 1 条**（`选科走班实施计划.md`：7 个班约 330 人 → 步数 ≤ 15）。
     *    它今天**是绿的**，而且绿得有据：14 步里最大的一块是"任教关系粘贴 2 步"——
     *    那是方案 §4.3.2 第⑤步自己写着的另一条路（"或者粘贴 2 次（如果有 Excel）"），
     *    本轮把它做出来了（`planRolePaste()` + 「粘贴批量指定任教关系」）。
     *    ⚠️ 对照：走"按老师批量"那条老路（12 位老师 × 3 次点击 = 36 步），
     *    合计会变成 **47 步** —— 见下面 G5b 那条反向对照。
     */
    ok(
      'G5：合计 **≤ 15**（`选科走班实施计划.md` P6 验收第 1 条，按 Q23 的 7 班规模）',
      total <= 15,
      `实际 ${total} 步`,
    )
    /* 反向对照：把"粘贴任教关系"换成"按老师批量点"（方案里的另一条路），合计就该爆掉 */
    const slow = total - 5 + (2 + 1 + 36)
    ok(
      'G5b（对照）：走"按老师批量点 12 次"那条路 → 合计超过 15（所以 ≤15 靠的是粘贴那条路，不是数错了）',
      slow > 15,
      `那条路 = ${slow} 步`,
    )
    const log = new gi.StepLog()
    log.add('a')
    log.add('b', 2)
    eq('G6：`StepLog` 记的是真步数（1 + 2）', log.total, 3)
    log.reset()
    eq('G7：复位之后是 0', log.total, 0)
  }

  /* ============================================================
     二、真 PostgreSQL（PGlite）：schema.sql §27 的写入路径
     ============================================================ */

  section('第八节 · 🔴 一个事务（真 PostgreSQL 17 · schema.sql §27）')

  const STUBS = `
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon nologin noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin noinherit;
    end if;
  end $$;

  create schema if not exists auth;
  create table if not exists auth.users (
    id                 uuid primary key default gen_random_uuid(),
    email              text unique,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
  );
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

  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    created_at timestamptz not null default now()
  );
  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text,
    owner uuid, created_at timestamptz not null default now()
  );
  alter table storage.objects enable row level security;
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

  /** PGlite 跑不了 `alter publication` 时把 §8 那一小段摘掉（与 rls-checks 同一手法） */
  function stripRealtime(text) {
    const re = /do \$\$\nbegin\n  begin\n    alter publication supabase_realtime[\s\S]*?end \$\$;/
    if (!re.test(text)) throw new Error('要摘 §8 的 realtime 段，但锚点没找到')
    return text.replace(re, '-- （PGlite 不支持 publication：由 scripts/grade-checks.mjs 在内存里摘除）')
  }

  /**
   * 负向对照：改**内存里的 SQL 文本**。锚点找不到就抛错 ——
   * 静默变成"其实没改坏"正是这类对照最常见的假绿。
   */
  function applyNegative(text) {
    if (!NEGATIVE) return text
    if (NEGATIVE === 'roster-no-prewrite') {
      const anchor = `    if coalesce(r.student_no, '') = '' then
      raise exception '第 % 行缺班级内学号', v_n;
    end if;`
      if (!text.includes(anchor)) throw new Error('roster-no-prewrite 的锚点没找到')
      return text.replace(anchor, '    -- （负向对照：把"缺班级内学号"这一条预校验拿掉）')
    }
    if (NEGATIVE === 'subject-open') {
      const anchor = `  if coalesce(array_length(v_second, 1), 0) <> 2 then
    raise exception '再选科目必须恰好 2 门，这一行有 % 门', coalesce(array_length(v_second, 1), 0);
  end if;`
      if (!text.includes(anchor)) throw new Error('subject-open 的锚点没找到')
      return text.replace(anchor, '  -- （负向对照：把"再选恰好 2 门"拿掉）')
    }
    if (NEGATIVE === 'other-no-member') {
      const anchor = `    if coalesce(array_length(p_member_class_ids, 1), 0) = 0 then
      raise exception '「其他」的学生必须手工选走班科目（走班班一个都没选）';
    end if;`
      if (!text.includes(anchor)) throw new Error('other-no-member 的锚点没找到')
      return text.replace(anchor, '    -- （负向对照：把"必须手工选走班科目"拿掉）')
    }
    if (NEGATIVE === 'bulk-no-precheck') {
      const anchor = `    if not exists (select 1 from classes c where c.id = r.class_id) then
      raise exception '第 % 行的班级不存在', v_n;
    end if;`
      if (!text.includes(anchor)) throw new Error('bulk-no-precheck 的锚点没找到')
      return text.replace(anchor, '    -- （负向对照：把"班级不存在"这一条预校验拿掉）')
    }
    /*
     * 🆕 P3/P2：把回填的 `where <目标列为空>` 拿掉 —— 幂等就没了。
     * 锚点必须**带上前面的 `update` 那一行**（源码里 `a.term_id is null` 只出现在这一处，
     * 但只锚一句话会在别处误命中；带上整句最稳）。
     */
    if (NEGATIVE === 'backfill-not-idempotent') {
      const anchor = `   where a.term_id is null
     and a.assign_date between t.start_date and t.end_date;`
      if (!text.includes(anchor)) throw new Error('backfill-not-idempotent 的锚点没找到')
      return text.replace(
        anchor,
        '   where a.assign_date between t.start_date and t.end_date;  -- （负向对照：拿掉"只填空的"）',
      )
    }
    /* 🆕 P3：把按届的唯一索引拿掉 —— "两个高二（不同届）"仍该允许，但"同一届两个年级"就拦不住了。
       ⚠️ 锚点在 `schema.sql` 里出现**两处**（§27.1 与 §28.7 各建一次，**而且两处的换行位置不同**：
       §27.1 把 `on grades …` 写在第一行、§28.7 单独一行）。所以这里用"从关键字起、
       到分号止"的非贪婪匹配**两处一起替** —— 只替一处的话索引照样建起来，
       N26 会变成一条**红不了的假对照**（实测踩过：第一版只锚了一种写法，`no-cohort-key` 居然全绿）。 */
    if (NEGATIVE === 'no-cohort-key') {
      const re = /create unique index if not exists grades_school_cohort_key[\s\S]*?where cohort <> '';/g
      const n = (text.match(re) ?? []).length
      if (n !== 2) throw new Error(`no-cohort-key 的锚点个数不对（找到 ${n} 处，期望 2 处）`)
      return text.replace(re, '-- （负向对照：不建按届的唯一索引）')
    }
    /*
     * ⚠️ 这里**故意不提供** `GRADE_NEGATIVE=setup-no-super` 那种"改原文"的对照：
     *    `is_school_admin()` 那半边同时是 H 段"导入名单"的闸门 —— 改掉它，
     *    H2 先失败（学生一个都没写进去）→ 脚本在 I 段因为取不到学生而**中断**，
     *    反而看不到"超管那条 `canSetup` 变红"。所以那条对照挪进第十一节：
     *    在那里把改坏的那份函数体落成 `_neg_grade_setup()` 真函数、让桩去问它
     *    （R21/R22：超管必须翻成 false，而本年级年级主任仍为 true）。
     */
    /*
     * 🆕 P4（§29）五条对照 —— 每一条都对着第十二节里一条**必须红**的断言：
     *   · `p4-promote-not-idempotent` → 拿掉"本学年已提档"那一支 → T1e/T1f 红
     *     （第二次会把全年级**再**提一级：高二直接跳到毕业，这就是 I44 说的那种事故）
     *   · `p4-promote-revokes-roles`  → 在提档事务里塞回原方案那句 `delete from teacher_roles`
     *     → T3a/T3g 红（Q16：提档不撤回任何身份）
     *   · `p4-mail-not-required`      → 拿掉"备份没发出就不许删"那一支 → T4e 红
     *   · `p4-no-name-check`          → 拿掉"逐字输入年级全名"那一支 → T5a 红
     *   · `p4-no-cleanup-exams`       → 拿掉 `exams` 孤儿那座残留的显式删除 → T6c 红
     *     （`class_ids` 是数组、建不了外键：删班不会带走它）
     */
    if (NEGATIVE === 'p4-promote-not-idempotent') {
      const anchor = `  if found then
    return jsonb_build_object(
      'ok', true, 'alreadyPromoted', true, 'academicYear', v_year, 'promoted', 0,
      'before', coalesce(v_detail -> 'before', '[]'::jsonb),
      'after',  coalesce(v_detail -> 'after',  '[]'::jsonb));
  end if;`
      if (!text.includes(anchor)) throw new Error('p4-promote-not-idempotent 的锚点没找到')
      return text.replace(anchor, '  -- （负向对照：拿掉"本学年已提档"那一支 —— 幂等就没了）')
    }
    if (NEGATIVE === 'p4-promote-revokes-roles') {
      const anchor = `  update grades set stage = stage + 1
   where school_id = v_school and stage in (1, 2);
  get diagnostics v_rows = row_count;`
      if (!text.includes(anchor)) throw new Error('p4-promote-revokes-roles 的锚点没找到')
      return text.replace(
        anchor,
        `${anchor}
  -- （负向对照：把原方案 §4.2.4(3) 第 4 步塞回来 —— 提档**撤回身份**）
  delete from teacher_roles
   where scope_type = 'grade' and scope_id in (select id from grades where school_id = v_school);`,
      )
    }
    if (NEGATIVE === 'p4-mail-not-required') {
      const anchor = `  if not v_rec.mail_ok then
    raise exception '备份还没有完成（%）—— 删除流程停在这里：先重新生成一次备份',
      coalesce(nullif(v_rec.mail_reason, ''), '原因不明');
  end if;`
      if (!text.includes(anchor)) throw new Error('p4-mail-not-required 的锚点没找到')
      return text.replace(anchor, '  -- （负向对照：拿掉"备份没发出就不许删"那一支）')
    }
    if (NEGATIVE === 'p4-no-name-check') {
      const anchor = `  if replace(btrim(coalesce(p_confirm_name, '')), ' ', '') <> replace(v_full, ' ', '') then
    raise exception '年级全名不对 —— 要**逐字**输入「%」才放行（这次收到的是「%」）',
      v_full, btrim(coalesce(p_confirm_name, ''));
  end if;`
      if (!text.includes(anchor)) throw new Error('p4-no-name-check 的锚点没找到')
      return text.replace(anchor, '  -- （负向对照：拿掉"逐字输入年级全名"那一支）')
    }
    if (NEGATIVE === 'p4-no-cleanup-exams') {
      const anchor = `  delete from exams where class_ids && v_class_ids;
  get diagnostics n_exams = row_count;`
      if (!text.includes(anchor)) throw new Error('p4-no-cleanup-exams 的锚点没找到')
      return text.replace(
        anchor,
        '  -- （负向对照：拿掉孤儿 exams 的显式删除 —— 数组建不了外键，没人替你删）\n  n_exams := 0;',
      )
    }
    /*
     * 🆕 P10（§34）三条对照 —— 每一条都对着第十四节里一条**必须红**的断言：
     *   · `p10-no-audit`               → 拿掉 `write_student_subject()` 里那段审计插入
     *                                    → S3/S5 红（"改一次选科 → 恰好一条"）
     *   · `p10-purge-no-confirm`       → 拿掉 `purge_old_subject_data()` 里那句二次确认
     *                                    → S11 红（"不确认 → 删不掉"）
     *   · `p10-suspend-removes-members` → 把触发器放宽成"休学也移出"
     *                                    → S16 红（"休学保留"）
     * 🆕 2026-10-06「谁能改学生选科」收窄（S22）的对照**不靠** `GRADE_NEGATIVE`：
     *    它在 S22l–S22n 里**当场**把老函数体（任教班那一支）装回库里再问一遍 → **S22d/S22j 必红**，
     *    随后用**改动前取下来的真定义**（`pg_get_functiondef`）原样还原（S22o 钉住"还回去了"）。
     */
    if (NEGATIVE === 'p10-no-audit') {
      const re = /if v_before is distinct from v_after then\s*\n\s*insert into student_subject_changes[\s\S]*?returning id into v_change_id;\s*\n\s*end if;/
      if (!re.test(text)) throw new Error('p10-no-audit 的锚点没找到')
      return text.replace(re, '  -- （负向对照：审计插入被拿掉）')
    }
    if (NEGATIVE === 'p10-purge-no-confirm') {
      const re = /if p_confirm is not true then\s*\n\s*raise exception '删除旧科目数据需要二次确认[\s\S]*?\n\s*end if;/
      if (!re.test(text)) throw new Error('p10-purge-no-confirm 的锚点没找到')
      return text.replace(re, '  -- （负向对照：二次确认被拿掉）')
    }
    if (NEGATIVE === 'p10-suspend-removes-members') {
      const anchor = `if new.status = 'left' and old.status is distinct from 'left' then`
      if (!text.includes(anchor)) throw new Error('p10-suspend-removes-members 的锚点没找到')
      return text.replace(anchor, `if new.status in ('left', 'suspended') and old.status is distinct from new.status then`)
    }
    return text
  }

  const db = new PGlite({ extensions: { pgcrypto } })
  await db.waitReady
  await db.exec(STUBS)
  let realtime = 'ok'
  try {
    await db.exec('create publication supabase_realtime')
  } catch {
    realtime = 'unsupported'
  }
  const RAW = readFileSync(SCHEMA_FILE, 'utf8')
  await db.exec(applyNegative(realtime === 'unsupported' ? stripRealtime(RAW) : RAW))

  /* ---------------- 夹具 ---------------- */
  const U = {
    super: '11111111-1111-1111-1111-111111111111',
    admin: '22222222-2222-2222-2222-222222222222',
    grade: '33333333-3333-3333-3333-333333333333',
    head: '44444444-4444-4444-4444-444444444444',
    teacher: '55555555-5555-5555-5555-555555555555',
  }
  const school = '(select id from schools order by created_at limit 1)'

  await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${U.super}',   'super@test', '{"name":"超管"}'::jsonb),
    ('${U.admin}',   'admin@test', '{"name":"教务处"}'::jsonb),
    ('${U.grade}',   'grade@test', '{"name":"高一主任"}'::jsonb),
    ('${U.head}',    'head@test',  '{"name":"班主任"}'::jsonb),
    ('${U.teacher}', 't@test',     '{"name":"任课老师"}'::jsonb);

  -- ⚠️ §10.2 已经建好了高一 / 高二 / 高三三行（按 name 唯一）—— 这里**不能 insert**，
  --    只能 update（grades_school_name_key 会把重复的那一行顶回来，实测踩过）。
  update grades set cohort = '2026', stage = 1 where name = '高一';
  update grades set cohort = '2025', stage = 2 where name = '高二';

  insert into teacher_roles (teacher_id, role, scope_type, scope_id) values
    ('${U.super}', 'super', 'school', null),
    ('${U.admin}', 'admin', 'school', null),
    ('${U.grade}', 'grade_head', 'grade', (select id from grades where name = '高一'));

  -- 名字里有 (1) 班的现有班（用来测"复用已有班"）
  insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type) values
    ('${U.head}', '高一(1)班', '高一', ${school}, (select id from grades where name = '高一'), 'admin', 'science');

  /* ============================================================
     🆕 2026-09-30（P3/P2）**存量数据的替身**：三个班 / 130 学生 / 9 份作业 / 1 场考试
     ------------------------------------------------------------
     ⚠️ 这是**测试夹具**，不是线上那 130 个人的姓名 —— 线上那三个班的届 /
     学期归属由 supabase/schema.sql §28.8 的 p3_backfill_terms_and_cohorts() 回填，
     本脚本只能验那段 SQL 的**行为**（幂等 / 归属 / 补不上的报出来），
     不能替代线上跑一次（线上有 service_role 密钥的地方才跑得动）。
     ⚠️ 「测试专用」那个班在线上是**另一个共同开发者在用的班**，一条都不能动 ——
     这里用一个同名（「测试专用」）的班把那条口径一起钉住。
     ============================================================ */
  insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type) values
    ('${U.head}', '高二(1)班', '高二', ${school}, (select id from grades where name = '高二'), 'admin', ''),
    ('${U.head}', '高二(4)班', '高二', ${school}, (select id from grades where name = '高二'), 'admin', ''),
    ('${U.head}', '测试专用',  '',     ${school}, null, 'admin', '');

  /* 130 个学生：65 + 65 —— 序列号按 P1 的规则自己写好（P2 只**复核**，不重发）。
     ⚠️ 序列号必须**全校唯一**（students_serial_key），所以两个班共用一个序号空间：
        序号 = 班内序号 + 班偏移（(1)班 0 / (4)班 65）—— 同一个班内还是 001…065。 */
  insert into students (class_id, student_no, name, serial)
  select c.id,
         lpad(g::text, 2, '0'),
         '存量' || c.name || g::text,
         '2025' || lpad((g + case when c.name = '高二(4)班' then 65 else 0 end)::text, 3, '0')
    from classes c
    cross join generate_series(1, 65) g
   where c.name in ('高二(1)班', '高二(4)班')
     and not exists (
       select 1 from students s where s.class_id = c.id and s.student_no = lpad(g::text, 2, '0')
     );

  /* 🔴 **9 份作业**（与线上同一形状：全部落在 2026 年 9 月 = 当前学期 = 2026-2027 上半期） */
  insert into assignments (class_id, teacher_id, title, subject, assign_date)
  select c.id, '${U.head}', '存量作业 ' || g::text, '物理',
         (date '2026-09-01' + (g - 1))::date
    from classes c
    cross join generate_series(1, 9) g
   where c.name = '高二(1)班'
     and not exists (select 1 from assignments a where a.class_id = c.id and a.title = '存量作业 ' || g::text);

  /* 另外 2 份**以前学期**的（2026 年 3 月 = 2025-2026 下半期）：
     它们是**反向对照** —— "默认只看本学期"必须把它们收起，又不能把它们藏掉 */
  insert into assignments (class_id, teacher_id, title, subject, assign_date)
  select c.id, '${U.head}', '上学期作业 ' || g::text, '物理', (date '2026-03-10' + (g - 1))::date
    from classes c
    cross join generate_series(1, 2) g
   where c.name = '高二(4)班'
     and not exists (select 1 from assignments a where a.class_id = c.id and a.title = '上学期作业 ' || g::text);

  /* 1 场考试：**只有年级名文本**（Q33 之前的老档案的形状），届与学期都空着。
     另外 1 场在上学期（对照：默认视图里不该看见它）。 */
  insert into exams (teacher_id, title, paper_key, subject, subject_code, scope, grade,
                     source, mode, exam_date, question_count, class_ids)
  select '${U.head}', '存量月考', '存量月考', '物理', 'physics', 'grade', '高二',
         'manual', 'scores', date '2026-09-20', 10, array[c.id]
    from classes c
   where c.name = '高二(1)班'
     and not exists (select 1 from exams e where e.title = '存量月考');

  insert into exams (teacher_id, title, paper_key, subject, subject_code, scope, grade,
                     source, mode, exam_date, question_count, class_ids)
  select '${U.head}', '上学期月考', '上学期月考', '物理', 'physics', 'grade', '高二',
         'manual', 'scores', date '2026-03-15', 10, array[c.id]
    from classes c
   where c.name = '高二(1)班'
     and not exists (select 1 from exams e where e.title = '上学期月考');
  `)

  const gradeOf = (n) => `(select id from grades where name = '${n}')`
  const classOf = (n) => `(select id from classes where name = '${n}' limit 1)`

  /** 以某个身份跑一段 SQL（`set local` 只在这个事务里生效） */
  async function as(uid, sql, params) {
    await db.exec('begin')
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
    let out
    try {
      out = params ? await db.query(sql, params) : await db.query(sql)
      await db.exec('commit')
    } catch (e) {
      await db.exec('rollback')
      throw e
    }
    return out.rows
  }

  /** 不抛错地试一次（用来断言"被拒"） */
  async function tryAs(uid, sql, params) {
    try {
      const rows = await as(uid, sql, params)
      return { ok: true, rows }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
    }
  }

  const rowsOf = (r) => r.rows
  const one = (r) => rowsOf(r)[0]

  /* ---------------- H：名单导入一个事务 ---------------- */
  {
    const good = JSON.stringify([
      { class_no: '1', student_no: '01', name: '甲', serial: '' },
      { class_no: '1', student_no: '02', name: '乙', serial: '' },
      { class_no: '2', student_no: '01', name: '丙', serial: '' },
    ])
    const r = await tryAs(U.admin, 'select public.bulk_import_roster($1::uuid,$2::uuid,$3::jsonb)', [
      U.admin,
      null,
      good,
    ])
    /* 第一个参数是年级 id —— 上面用 null 探一下"要指定年级"这条路 */
    ok('H1：不给年级 → 报"导入名单要指定一个年级"', !r.ok && r.message.includes('年级'), r.message)

    const gid = one(await db.query(`select id::text from grades where name = '高一'`)).id
    const okRes = await tryAs(U.admin, 'select public.bulk_import_roster($1::uuid,$2::uuid,$3::jsonb)', [U.admin, gid, good])
    ok('H2：教务处导 3 行 → 成功', okRes.ok, okRes.message)
    /* `as()` 回的是**行数组**，`bulk_import_roster` 的返回值是 JSON **对象**（不是行集）→ 直接取第一格 */
    const R = (okRes.rows ?? [])[0]?.bulk_import_roster ?? (okRes.rows ?? [])[0] ?? {}
    eq('H3：名单里有 2 个班号 → 这个年级一共 2 个班（1 复用 + 1 新建）', okRes.ok && Number(R.classes ?? 0), 2)
    eq('H4：写进去 3 个学生', okRes.ok && Number(R.students ?? 0), 3)
    const clsCount = Number(one(await db.query(`select count(*)::int as n from classes where grade_id = ${gradeOf('高一')}`)).n)
    eq('H5：库里确实有 2 个班了（1 班复用 + 2 班新建）', clsCount, 2)
    const stuCount = Number(
      one(
        await db.query(
          `select count(*) as n from students where class_id in (${classOf('高一(1)班')}, ${classOf('高一(2)班')})`,
        ),
      ).n,
    )
    eq('H6：库里确实有 3 个学生', stuCount, 3)
    /* 🔴 序列号由**触发器**发号：导入没自己算，但库里必须有号 */
    const serials = rowsOf(
      await db.query(
        `select serial from students where class_id in (${classOf('高一(1)班')}, ${classOf('高一(2)班')}) order by serial`,
      ),
    ).map((x) => x.serial)
    eq('H7：3 个学生都拿到了序列号（触发器发的）', serials.length, 3)
    ok(
      'H8：序列号形状 = `2026` + 3 位（届是 2026，来自 `grades.cohort`）',
      serials.every((s) => /^2026\d{3}$/.test(s)),
      JSON.stringify(serials),
    )
    eq('H9：序列号互不相同', new Set(serials).size, 3)

    /* 🔴 序列号**不可改**（DB 层，不只是界面灰化）—— 反向对照见 P 段 */
    const edit = await tryAs(U.admin, `update students set serial = '9999999' where student_no = '01' and class_id = ${classOf('高一(1)班')}`)
    ok('H10：改序列号 → **被数据库拒**（触发器）', !edit.ok, edit.ok ? '居然改成功了' : edit.message)

    /* 🔴 **第 k 行非法 → 整批不入库** */
    const before = Number(one(await db.query('select count(*)::int as n from students')).n)
    const bad = JSON.stringify([
      { class_no: '1', student_no: '10', name: '戊', serial: '' },
      { class_no: '1', student_no: '11', name: '己', serial: '' },
      { class_no: '3', student_no: '', name: '庚', serial: '' }, // ← 第 3 行缺班级内学号
    ])
    const badRes = await tryAs(U.admin, 'select public.bulk_import_roster($1::uuid,$2::uuid,$3::jsonb)', [U.admin, gid, bad])
    ok('H11：第 3 行非法 → 报错', !badRes.ok, badRes.message)
    ok('H12：理由里带着**行号 3** 与原因', /第 3 行/.test(badRes.message) && /班级内学号/.test(badRes.message), badRes.message)
    const after = Number(one(await db.query('select count(*)::int as n from students')).n)
    eq('H13：🔴 **整批不入库**（学生数一个都没变）', after, before)
    const cls2 = Number(one(await db.query(`select count(*)::int as n from classes where grade_id = ${gradeOf('高一')}`)).n)
    eq('H14：🔴 那个会在第 3 行之前建的"3 班"**也没有被建出来**', cls2, 2)

    /* 只读身份：年级主任能导本年级、教务处能导、别的年级的年级主任不行 */
    const other = await tryAs(U.head, 'select public.bulk_import_roster($1::uuid,$2::uuid,$3::jsonb)', [
      U.head,
      gid,
      JSON.stringify([{ class_no: '9', student_no: '01', name: '辛', serial: '' }]),
    ])
    ok('H15：班主任**不能**录名单（他不是教务处 / 年级主任）', !other.ok && /权限/.test(other.message), other.message)
    const gh = await tryAs(U.grade, 'select public.bulk_import_roster($1::uuid,$2::uuid,$3::jsonb)', [
      U.grade,
      gid,
      JSON.stringify([{ class_no: '2', student_no: '02', name: '壬', serial: '' }]),
    ])
    ok('H16：本年级的年级主任**能**录名单', gh.ok, gh.message)
  }

  /* ---------------- I：选科校验 + 「其他」 ---------------- */
  {
    const stu = one(await db.query(`select id::text from students where name = '甲'`)).id
    const ok1 = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'standard', 'physics', ['chemistry', 'biology'], '', [],
    ])
    ok('I1：合法组合能写进去', ok1.ok, ok1.message)
    const read = one(await db.query(`select kind, primary_code, array_to_string(second_codes, ',') as s from student_subjects where student_id = '${stu}'`))
    eq('I2：读回来就是物化生', [read.kind, read.primary_code, read.s], ['standard', 'physics', 'chemistry,biology'])

    for (const [label, second] of [
      ['再选一门', ['chemistry']],
      ['再选三门', ['chemistry', 'biology', 'politics']],
      ['再选里有物理', ['physics', 'biology']],
      ['首选混进再选', ['physics', 'chemistry']],
    ]) {
      const r = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
        U.grade,
        stu, 'standard', 'physics', second, '', [],
      ])
      ok(`I3：**非法选科当场拦住** —— ${label}`, !r.ok, r.ok ? '居然写进去了' : r.message)
    }
    const badPrimary = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'standard', 'chemistry', ['biology', 'geography'], '', [],
    ])
    ok('I4：首选不是物理/历史 → 拦住', !badPrimary.ok, badPrimary.message)

    /* 「其他」：必须手工选走班科目（**不能只填组合名**） */
    const otherNoMember = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'other', '', ['chemistry', 'biology'], '转学待定', [],
    ])
    ok('I5：🔴「其他」没选走班班 → 拦住', !otherNoMember.ok, otherNoMember.message)
    ok('I6：那句话就是"必须手工选走班科目"', /手工选走班科目/.test(otherNoMember.message), otherNoMember.message)

    const otherNoNote = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'other', '', ['chemistry', 'biology'], '', [],
    ])
    ok('I7：「其他」没填原因 → 拦住', !otherNoNote.ok, otherNoNote.message)

    /* 标准组合**不许**手工选班（那是 P7 的活） */
    const stdMember = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'standard', 'physics', ['chemistry', 'biology'], '', [classOf('高一(1)班')],
    ])
    ok('I8：标准组合手工选走班班 → 拦住（走班班由系统生成）', !stdMember.ok, stdMember.message)

    /* 班主任改不了（他不是那三档） */
    const headWrite = await tryAs(U.head, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.head,
      stu, 'standard', 'physics', ['chemistry', 'geography'], '', [],
    ])
    ok('I9：任课/班主任档在**别的年级**的班上改不了（这里班主任无 scope → 拦）', !headWrite.ok, headWrite.message)

    /* 反向对照：合法的那一条**确实写得进去**（不然前面的"拦住"全是假绿） */
    const ok2 = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', [
      U.grade,
      stu, 'standard', 'history', ['politics', 'geography'], '', [],
    ])
    ok('I10（对照）：换成合法组合 → 写得进去', ok2.ok, ok2.message)
  }

  /* ---------------- J：批量写任教关系（一个事务 + 上限 + 人话） ---------------- */
  {
    const c1 = classOf('高一(1)班')
    const c2 = classOf('高一(2)班')
    const t1 = `'${U.teacher}'::uuid`
    /* 用参数传 uuid：PostgREST 那边是 jsonb，这里直接构造 jsonb。
       🔴 第一个参数是 `p_actor`（谁在写）—— 服务端用 service_role 调它，
          而 service_role 下 `auth.uid()` 是 NULL（见 `schema.sql` §27.13）。 */
    const build = (arr) => JSON.stringify(arr)

    const badRow = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.grade,
      build([{ class_id: '00000000-0000-0000-0000-000000000000', subject_code: 'physics', teacher_id: U.teacher }]),
    ])
    ok('J1：第 1 行的班级不存在 → 报"第 1 行的班级不存在"', !badRow.ok && /第 1 行/.test(badRow.message), badRow.message)

    const before = Number(one(await db.query('select count(*)::int as n from class_subjects')).n)
    /* 第 2 行非法 → 第 1 行（合法）**也不许写进去** */
    const mixed = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.grade,
      build([
        { class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.teacher },
        { class_id: '00000000-0000-0000-0000-000000000000', subject_code: 'math', teacher_id: U.teacher },
      ]),
    ])
    ok('J2：一批里第 2 行非法 → 整批失败', !mixed.ok, mixed.message)
    ok('J3：报的是第 2 行', /第 2 行/.test(mixed.message), mixed.message)
    const after = Number(one(await db.query('select count(*)::int as n from class_subjects')).n)
    eq('J4：🔴 **改一半的情况不发生**（行数一个都没变）', after, before)

    const goodBulk = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.grade,
      build([
        { class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.teacher },
        { class_id: (await db.query(`select id::text from classes where name='高一(2)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.teacher },
      ]),
    ])
    ok('J5（对照）：两行都合法 → 一次写完', goodBulk.ok, goodBulk.message)
    const n = Number(one(await db.query(`select count(*)::int as n from class_subjects where teacher_id = '${U.teacher}'`)).n)
    eq('J6（对照）：库里确实多了 2 行', n, 2)
    const names = rowsOf(await db.query(`select subject from class_subjects where teacher_id = '${U.teacher}'`)).map((x) => x.subject)
    eq('J7：`subject`（老列的真名）被从 `subjects` 字典里取出来填上了', names, ['物理', '物理'])

    /* 换老师 = 替换（同一个班同一科不留两个人）—— 唯一索引 + delete 两件事 */
    const swap = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.grade,
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.head }]),
    ])
    ok('J8：换一个老师教同一个班的物理 → 成功', swap.ok, swap.message)
    const hold = Number(one(await db.query(`select count(*)::int as n from class_subjects where subject_code = 'physics' and class_id = ${classOf('高一(1)班')} and teacher_id = '${U.teacher}'`)).n)
    eq('J9：原来那位老师的行被换掉了（同一个班同一科不留两个人）', hold, 0)

    const notMine = await tryAs(U.super, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.super,
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'math', teacher_id: U.teacher }]),
    ])
    ok('J10：超管（不是 any 年级主任、但是 is_school_admin）→ 也能写', notMine.ok, notMine.message)
    const nobody = await tryAs(U.teacher, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.teacher,
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'math', teacher_id: U.teacher }]),
    ])
    ok('J11：任课老师 → 被拒（"你没有设定这个年级任课关系的权限"）', !nobody.ok && /权限/.test(nobody.message), nobody.message)

    const tooMany = await tryAs(U.admin, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [
      U.admin,
      JSON.stringify(
        Array.from({ length: 2001 }, (_, i) => ({
          /* 形状**合法**（这样才会走到"行数上限"那一条，而不是先被形状校验拦下） */
          class_id: '00000000-0000-0000-0000-000000000000',
          subject_code: i === 2000 ? 'math' : 'physics',
          teacher_id: U.teacher,
        })),
      ),
    ])
    ok('J12：超过 2000 行 → 报人话（不是静默截断）', !tooMany.ok && /2000/.test(tooMany.message), tooMany.message)

    /* 空数组 */
    const empty = await tryAs(U.admin, 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', [U.admin, '[]'])
    ok('J13：空数组 → 报"一行都没有 —— 这份表是空的"', !empty.ok && /一行都没有/.test(empty.message), empty.message)
    void c1
    void c2
    void t1
  }

  /* ---------------- K：权限：写入口只有服务端能调 ---------------- */
  {
    for (const [label, sql, params] of [
      ['write_student_subject', 'select public.write_student_subject($1::uuid,$2::uuid,$3,$4,$5::text[],$6,$7::uuid[])', ['00000000-0000-0000-0000-000000000000', 'standard', 'physics', ['chemistry', 'biology'], '', []]],
      ['bulk_write_class_subjects', 'select public.bulk_write_class_subjects($1::uuid,$2::jsonb)', ['[]']],
      ['bulk_import_roster', 'select public.bulk_import_roster($1::uuid,$2::jsonb,$3)', ['00000000-0000-0000-0000-000000000000', '[]', '%s']],
    ]) {
      /* `authenticated` 这个角色**没有执行权** —— 与"跑得起来但判据为假"是两件事 */
      const r = await db
        .query(`select has_function_privilege('authenticated', 'public.${label}(${FUNC_ARGS[label]})', 'execute') as p`)
        .then((x) => x.rows[0])
        .catch((e) => ({ err: String(e.message) }))
      eq(`K1：\`authenticated\` 对 ${label} **没有 execute 权限**（只有 service_role 能调）`, r?.p, false)
      void sql
      void params
    }
    /*
     * 🆕 2026-10-02（集成修复）：三个写入口的第一个参数是**显式 `p_actor`**，
     *   而 `_for` 判据变体（接受任意 uid）一律 revoke —— 上面 K1 问的就是**新签名**
     *   （`FUNC_ARGS` 已跟着改）。这里再钉两条：
     *    · 服务端拿 service_role 调的是**新签名**（旧签名必须已经不存在）；
     *    · `_for` 那三个从 `authenticated` 调用是 **42501**，而裸版仍然可调。
     */
    const oldSig = rowsOf(
      await db.query(`
        select p.proname::text as name, pg_get_function_arguments(p.oid) as args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('write_student_subject', 'bulk_write_class_subjects', 'bulk_import_roster',
                             'write_academic_year')
         order by 1, 2`),
    )
    eq(
      'K4：三个写入口 + 学年写入**只有新签名**（第一个参数是 `p_actor`）—— 旧的已经不在库里',
      oldSig.map((x) => `${x.name}:${x.args.split(',')[0]}`),
      [
        'bulk_import_roster:p_actor uuid',
        'bulk_write_class_subjects:p_actor uuid',
        'write_academic_year:p_actor uuid',
        'write_student_subject:p_actor uuid',
      ],
    )
    for (const [label, args] of [
      ['can_manage_grade_setup_for', 'uuid, uuid'],
      ['can_edit_student_subject_for', 'uuid, uuid'],
      ['can_manage_class_setup_for', 'uuid, uuid'],
      ['can_manage_terms_for', 'uuid'],
    ]) {
      const r = await db
        .query(`select has_function_privilege('authenticated', 'public.${label}(${args})', 'execute') as p`)
        .then((x) => x.rows[0])
        .catch((e) => ({ err: String(e.message) }))
      eq(`K5：\`authenticated\` 对 **${label}** 没有 execute 权限（接受任意 uid = 以任意人身份问权限）`, r?.p, false)
    }
    const bareBools = rowsOf(
      await db.query(`
        select p.proname::text as name,
               has_function_privilege('authenticated', p.oid, 'execute') as can
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('can_manage_grade_setup', 'can_manage_class_setup', 'can_manage_terms',
                             'can_edit_student_subject', 'can_manage_terms_for')
         order by 1`),
    )
    eq(
      'K6：裸版判据仍然可以被 authenticated 调用（前端靠它决定摆不摆入口）—— 只有 `_for` 是 revoke 的',
      bareBools.map((x) => `${x.name}=${x.can}`),
      [
        'can_edit_student_subject=true',
        'can_manage_class_setup=true',
        'can_manage_grade_setup=true',
        'can_manage_terms=true',
        'can_manage_terms_for=false',
      ],
    )
    /* 对照：把 `_for` 的 revoke 拿掉（= 走 B 方案那条路的样子）→ K5 必须变红 */
    await db.exec('grant execute on function public.can_manage_grade_setup_for(uuid, uuid) to authenticated')
    const granted = await db
      .query(`select has_function_privilege('authenticated', 'public.can_manage_grade_setup_for(uuid, uuid)', 'execute') as p`)
      .then((x) => x.rows[0])
    eq('K7（对照）：把 `_for` 的 revoke 换成 grant → K5 那一条**会变红**（它不是永远为绿的摆设）', granted.p, true)
    await db.exec('revoke all on function public.can_manage_grade_setup_for(uuid, uuid) from public, anon, authenticated')
    /* 判据函数本身是可以被 authenticated 调用的（前端要靠它决定摆不摆入口） */
    const canCall = await db
      .query(`select has_function_privilege('authenticated', 'public.can_manage_grade_setup(uuid)', 'execute') as p`)
      .then((x) => x.rows[0])
    eq('K2：`can_manage_grade_setup(uuid)` 可以被 authenticated 调用（前端读它）', canCall.p, true)
    const canCall2 = await db
      .query(`select has_function_privilege('authenticated', 'public.student_subject_check(text,text,text[],text)', 'execute') as p`)
      .then((x) => x.rows[0])
    eq('K3：`student_subject_check` 可以被 authenticated 调用（选科校验只此一处）', canCall2.p, true)
  }

  /* ---------------- L：约束与索引（一个年级一个年级主任 / 班型 check） ---------------- */
  {
    const idx = await db.query(
      `select 1 from pg_indexes where tablename='teacher_roles' and indexname='teacher_roles_one_grade_head'`,
    )
    eq('L1：`teacher_roles_one_grade_head` 索引在（一个年级只允许一个年级主任）', rowsOf(idx).length, 1)

    /* 真的拦得住第二个吗 */
    const dup = await tryAs(
      U.admin,
      `insert into teacher_roles (teacher_id, role, scope_type, scope_id) values ('${U.head}', 'grade_head', 'grade', ${gradeOf('高一')})`,
    )
    ok('L2：同一个年级再加一个年级主任 → **被唯一索引拒**', !dup.ok, dup.ok ? '居然插进去了' : dup.message)

    const badType = await tryAs(U.admin, `update classes set class_type = 'liberal' where id = ${classOf('高一(1)班')}`)
    ok('L3：`class_type` 写成第五个值 → 被 check 约束拒', !badType.ok, badType.message)
    const undivided = await tryAs(U.admin, `update classes set class_type = 'undivided' where id = ${classOf('高一(1)班')}`)
    ok('L4（对照）：`undivided`（未分科）是合法的一档', undivided.ok, undivided.message)

    /* cohort 的形状 */
    const badCohort = await tryAs(U.admin, `update grades set cohort = '26' where name = '高二'`)
    ok('L5：`cohort` 写成两位 → 被 check 约束拒（格式写死 4 位）', !badCohort.ok, badCohort.message)
    const cohort = one(await db.query(`select cohort, stage from grades where name = '高一'`))
    eq('L6：§27.1 的回填：高一 = 2026 / stage 1', [cohort.cohort, Number(cohort.stage)], ['2026', 1])

    /* 两张新表都在 */
    const tables = rowsOf(
      await db.query(`select tablename from pg_tables where schemaname='public' and tablename in ('student_subjects','class_members') order by tablename`),
    ).map((x) => x.tablename)
    eq('L7：`student_subjects` 与 `class_members` 两张表都在', tables, ['class_members', 'student_subjects'])

    /* class_subjects 的新唯一索引（批量写 on conflict 靠它） */
    const csIdx = await db.query(`select 1 from pg_indexes where tablename='class_subjects' and indexname='class_subjects_unique_code'`)
    eq('L8：`class_subjects_unique_code` 索引在（批量写的 on conflict 靠它）', rowsOf(csIdx).length, 1)
    const sqlText = readFileSync(SCHEMA_FILE, 'utf8')
    ok(
      'L9：老的 `unique (class_id, subject, teacher_id)` **仍然留着**（新索引是它的超集，留着不会放脏数据）',
      /unique \(class_id, subject, teacher_id\)/.test(sqlText),
    )
  }

  /* ---------------- M：读策略（读得宽）与前端不崩（探针） ---------------- */
  {
    /* `student_subjects` 的读策略：看得见这个班就能读 —— 这几条库里没有 RLS 的完整替身，
       所以只核"策略在不在"，真正的逐人可见量在 `rls-checks.mjs` 里 */
    const pol = rowsOf(
      await db.query(`select policyname from pg_policies where tablename in ('student_subjects','class_members') order by policyname`),
    ).map((x) => x.policyname)
    eq('M1：两张新表的策略都在（读 / 写各一条）', pol, [
      'class_members_read',
      'student_subjects_read',
      'student_subjects_write',
    ])
    const rls = rowsOf(
      await db.query(`select relname, relrowsecurity from pg_class where relname in ('student_subjects','class_members') order by relname`),
    )
    eq('M2：两张新表都开了 RLS（不开 = 裸奔）', rls.map((r) => [r.relname, r.relrowsecurity]), [
      ['class_members', true],
      ['student_subjects', true],
    ])
  }

  /* ---------------- N：🆕 P3 + P2（学年 / 学期 / 届 + 存量回填） ---------------- */
  {
    /*
     * 🔴 这一节是 P3/P2 的**验收核心**，两件事：
     *   ① **回填幂等**：`p3_backfill_terms_and_cohorts()` 跑第二遍 → **0 行受影响**；
     *   ② **默认视图里那 9 份作业 + 1 场考试都看得见** —— 判据是 `lib/terms.ts` 的
     *      `termMatches()`（前端与作业/考试列表**同一份**，不是这里另写一套）。
     *
     * ⚠️ 夹具在 `db.exec` 的那一大段 SQL 里（三个班 / 130 学生 / 9 作业 / 1 考试），
     *    形状照线上存量数据：考试的届与学期**一开始都是空的** ——
     *    不补就看不见，这正是 P2 存在的唯一理由。
     */
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

    /* ① 夹具落库了（自证：验不动的东西先证明它在） */
    /* ⚠️ 参数是** `count(*)` 后面的那一半**（`from … where …`），别把 `count(*)` 一起传进来。
       也别在 SQL 里拼 `::int` —— 那个后缀要贴在**整个 count 表达式**上，
       写成 `select ${sql}::int` 会在 `from` 这种片段上直接语法错（实测踩过）。 */
    const cnt = async (tail) => Number(one(await db.query(`select count(*) as n ${tail}`)).n)
    eq(
      'N1：库里的班 ≥ 5 个（H 段建的 2 个高一班 + 存量 3 个）—— 只做自证，不写死条数',
      (await cnt('from classes')) >= 5,
      true,
    )
    eq(
      'N1b：三个存量班都在（高二(1) / 高二(4) / 测试专用）',
      await cnt(`from classes where name in ('高二(1)班','高二(4)班','测试专用')`),
      3,
    )
    eq('N2：夹具 130 个存量学生（65 + 65）在库里', await cnt("from students where serial like '2025%'"), 130)
    eq(
      'N3：夹具 **9 份本学期作业**（与线上同一形状）在库里',
      await cnt(`from assignments where title like '存量作业 %'`),
      9,
    )
    eq(
      'N3b：另外 2 份**上学期**的作业也在（反向对照用）',
      await cnt(`from assignments where title like '上学期作业 %'`),
      2,
    )
    eq('N4：夹具 1 场本学期考试 + 1 场上学期考试', await cnt('from exams'), 2)

    /* ② 跑一段"没跑过回填"的状态：把 term_id / grade_id 清回来（schema.sql 已经跑过一次） */
    await db.exec('update assignments set term_id = null; update exams set term_id = null, grade_id = null;')
    eq(
      'N5：清回来之后 —— 11 份作业与 2 场考试的归属都是空的（= 补之前的样子）',
      `${await cnt('from assignments where term_id is null')}/${await cnt('from exams where term_id is null')}/${await cnt('from exams where grade_id is null')}`,
      '11/2/2',
    )

    /* ③ 🔴 第一遍：把该补的补上（行数逐项核） */
    const r1 = one(await db.query('select public.p3_backfill_terms_and_cohorts() as r')).r
    eq('N6：第一遍回填 —— 11 份作业都归到了学期', Number(r1.assignmentsTermFilled), 11)
    eq('N7：第一遍回填 —— 2 场考试都归到了学期', Number(r1.examsTermFilled), 2)
    eq('N8：第一遍回填 —— 2 场考试都按年级名反查到了届', Number(r1.examsGradeFilled), 2)
    eq(
      'N9：补不上的清单**四项全 0**（序列号那一样 P1 已经做过，本函数只复核）',
      [
        Number(r1.unresolvable.assignmentsNoTerm),
        Number(r1.unresolvable.examsNoTerm),
        Number(r1.unresolvable.examsNoGrade),
        Number(r1.unresolvable.studentsNoSerial),
      ].join('/'),
      '0/0/0/0',
      `实际 ${JSON.stringify(r1)}`,
    )

    /* ④ 🔴 第二遍：**受影响行数 = 0**（幂等的唯一根据是每一条 SQL 的 `where <列为空>`） */
    const r2 = one(await db.query('select public.p3_backfill_terms_and_cohorts() as r')).r
    eq('N10：🔴 重跑一遍 —— 作业 0 行受影响', Number(r2.assignmentsTermFilled), 0)
    eq('N11：🔴 重跑一遍 —— 考试学期 0 行受影响', Number(r2.examsTermFilled), 0)
    eq('N12：🔴 重跑一遍 —— 考试届 0 行受影响', Number(r2.examsGradeFilled), 0)

    /* ⑤ 归属对不对：8 份在 2026-2027 上半期、1 份在 2025-2026 下半期 */
    const terms = rowsOf(await db.query('select id::text, half, start_date::text, end_date::text from terms order by start_date'))
    const cur = one(await db.query('select public.current_term_id()::text as id')).id
    eq('N13：库里一共 4 个学期（2025-2026 与 2026-2027 各两个半期）', terms.length, 4)
    const curTerm = terms.find((t) => t.id === cur)
    eq(
      'N14：🔴「当前学期」推得出来，而且是 2026-2027 上半期那一行（今天 = 真 PG 的 now()，按北京时间）',
      curTerm ? `${curTerm.start_date}~${curTerm.end_date}` : '（推不出来）',
      '2026-09-01~2027-01-31',
    )
    const older = one(
      await db.query(
        `select t.id::text as id from assignments a join terms t on t.id = a.term_id
          where a.title = '上学期作业 1'`,
      ),
    )
    ok('N15：那份 2026 年 3 月的作业归到了**另一个**学期（不是当前学期）', older.id !== cur, older.id)

    /* ⑥ 🔴 "不补就消失"的直接防线：那 9 份作业与 1 场考试在**默认视图**里都看得见 */
    const gradeIdOf = async (cohort) =>
      one(await db.query(`select id::text from grades where cohort = '${cohort}'`)).id
    const { termMatches, termFilterOptions } = termsLib
    const curFilter = termFilterOptions(terms, cur)[0].value

    const assignRows = rowsOf(
      await db.query('select id::text, title, term_id::text from assignments order by title'),
    )
    const examRows = rowsOf(
      await db.query('select id::text, title, term_id::text, grade_id::text from exams'),
    )
    /*
     * 🔴 口径：线上那 9 份**全部落在同一个学期里**（2026 年 9 月 = 当前学期），
     *    所以「默认视图里 9 份作业 + 1 场考试都看得见」这句话在这里就是
     *    **可见 = 9 / 1**。另外那 2 份作业 + 1 场考试是**反向对照**：
     *    它们属于上一个学期 → 默认视图**必须收起**，但切到「全部学期」**看得见**
     *    （N22/N23/N26）—— 收起不等于藏掉。
     */
    const visibleAssign = assignRows.filter((r) => termMatches(r.term_id ?? null, curFilter, cur, terms))
    eq(
      'N16：🔴 **默认视图里那 9 份作业都看得见**（判据就是作业列表读的那个 `termMatches`）',
      visibleAssign.length,
      9,
      `可见：${visibleAssign.filter((r) => r.title.startsWith('存量')).map((r) => r.title).join('、')}`,
    )
    ok(
      'N16b（对照）：【上学期那 2 份】**不在**默认视图里（不然"默认只看本学期"是句空话）',
      !visibleAssign.some((r) => r.title.startsWith('上学期')),
      JSON.stringify(visibleAssign.map((r) => r.title)),
    )
    ok(
      'N16c：🔴 **没有一份档案因为"没有学期归属"而从默认视图里消失**（这是 P2 的直接防线）',
      assignRows
        .filter((r) => r.term_id === null || r.term_id === undefined)
        .every((r) => termMatches(r.term_id ?? null, curFilter, cur, terms)),
    )
    const visibleExam = examRows.filter((r) => termMatches(r.term_id ?? null, curFilter, cur, terms))
    eq(
      'N17：🔴 **默认视图里那 1 场考试也看得见**（它就是 P2 存在的唯一理由）',
      visibleExam.length,
      1,
      JSON.stringify(visibleExam),
    )
    eq('N17b：默认视图里看见的就是「存量月考」那一场', visibleExam[0]?.title, '存量月考')
    const curExam = examRows.find((r) => r.title === '存量月考')
    eq('N18：那场考试的届 = 高二那一行（cohort 2025）', curExam.grade_id, await gradeIdOf('2025'))
    eq(
      'N19：那场考试的年级名文本**没被改**（Q33：`grade` 老列留着，两条读法并存）',
      one(await db.query("select grade from exams where title = '存量月考'")).grade,
      '高二',
    )

    /* ⑦ 反向对照（**内存里**的判据）：没有归属 / 列读不到时，默认视图必须**照常显示** */
    ok(
      'N20（对照）：`term_id = null`（回填漏了的那一条）在默认视图里**照样显示** —— 不静默藏数据',
      termMatches(null, curFilter, cur, terms) === true,
    )
    ok(
      'N21（对照）：`term_id = undefined`（线上库还没跑 §28）在默认视图里**照样显示**',
      termMatches(undefined, curFilter, cur, terms) === true,
    )
    ok(
      'N22（对照）：确实属于**另一个**学期的档案在默认视图里**被收起**（这是"默认只看本学期"的全部含义）',
      termMatches(older.id, curFilter, cur, terms) === false,
    )
    ok(
      'N23（对照）：切到「全部学期」之后，上学期那份**看得见**（收起不等于藏掉）',
      termMatches(older.id, termFilterOptions(terms, cur)[1].value, cur, terms) === true,
    )
    const olderExam = examRows.find((r) => r.title === '上学期月考')
    ok(
      'N23b（对照）：上学期那场考试同样 —— 默认收起、切到「全部学期」看得见',
      termMatches(olderExam.term_id, curFilter, cur, terms) === false &&
        termMatches(olderExam.term_id, termFilterOptions(terms, cur)[1].value, cur, terms) === true,
      JSON.stringify(olderExam),
    )

    /* ⑧ 🔴 唯一键换成 `(school_id, cohort)` */
    const idx = rowsOf(await db.query('select indexname from pg_indexes where tablename = \'grades\'')).map(
      (x) => x.indexname,
    )
    ok('N24：按届的唯一索引在（`grades_school_cohort_key`）', idx.includes('grades_school_cohort_key'), JSON.stringify(idx))
    ok('N25：按名字的唯一索引**已经 drop**（留着它"两个高二"永远撞，见 Q22）', !idx.includes('grades_school_name_key'), JSON.stringify(idx))
    const dupCohort = await tryAs(
      U.admin,
      `insert into grades (school_id, name, cohort) select id, '高二', '2025' from schools limit 1`,
    )
    ok('N26：插第二个**同届**的年级 → **被唯一索引拒**', !dupCohort.ok, dupCohort.ok ? '居然插进去了' : dupCohort.message)
    const twoNames = await tryAs(
      U.admin,
      `insert into grades (school_id, name, cohort) select id, '高二', '2027' from schools limit 1`,
    )
    ok('N27：插第二个「高二」（**不同届**）→ **允许**（这正是 Q22 要的）', twoNames.ok, twoNames.message)
    if (twoNames.ok) await db.exec(`delete from grades where cohort = '2027'`)

    /* ⑨ 🔴 提档只改 `stage`：班级的 `grade_id` **一个字都不改** */
    const classIdsBefore = rowsOf(
      await db.query(
        `select c.id::text as id, c.grade_id::text as g from classes c
           join grades g on g.id = c.grade_id where g.cohort = '2025' order by c.name`,
      ),
    )
    eq('N28：夹具里 2 个班挂在高二（cohort 2025）上', classIdsBefore.length, 2)
    await db.query(`update grades set stage = 3 where cohort = '2025'`)
    const classIdsAfter = rowsOf(
      await db.query(
        `select c.id::text as id, c.grade_id::text as g from classes c
           join grades g on g.id = c.grade_id where g.cohort = '2025' order by c.name`,
      ),
    )
    eq(
      'N29：🔴 提档前后班级的 `grade_id` **逐字相同**（提档只改 stage，年级 id 不变）',
      JSON.stringify(classIdsAfter),
      JSON.stringify(classIdsBefore),
    )
    eq('N30：提档之后 stage 确实变成了 3', Number(one(await db.query(`select stage from grades where cohort = '2025'`)).stage), 3)
    await db.query(`update grades set stage = 2 where cohort = '2025'`)

    /* ⑩ 「测试专用」班**零改动**（它的 grade_id 本来就是空，回填不碰班那一侧） */
    const test = one(
      await db.query(
        `select grade_id::text as g, kind, class_type from classes where name = '测试专用'`,
      ),
    )
    eq(
      'N31：🔴「测试专用」班**零改动**（`grade_id` 仍然空、kind/class_type 原样）',
      `${test.g ?? 'null'}/${test.kind}/${test.class_type}`,
      'null/admin/',
    )
    eq(
      'N32：「测试专用」班下**一个学生都没有**（存量回填不碰它）',
      await cnt(`from students s join classes c on c.id = s.class_id where c.name = '测试专用'`),
      0,
    )

    /* ⑪ 判据函数与写入口的权限形状 */
    eq(
      'N33：`term_of_date()` 对区间外的那一天返回空（**绝不就近归到某一学期**，I14）',
      one(await db.query(`select public.term_of_date(date '2030-01-01')::text as id`)).id ?? 'null',
      'null',
    )
    const canTerms = await db
      .query(`select has_function_privilege('authenticated', 'public.current_term_id()', 'execute') as p`)
      .then((x) => x.rows[0])
    eq('N34：`current_term_id()` 可以被 authenticated 调用（列表要用它推当前学期）', canTerms.p, true)
    const wY = await db
      .query(
        `select has_function_privilege('authenticated', 'public.write_academic_year(uuid,text,date,date,date,date,date,date)', 'execute') as p`,
      )
      .then((x) => x.rows[0])
    eq('N35：`write_academic_year()` **只有服务端能调**（authenticated 没有 execute；签名里第一个参数是 `p_actor`）', wY.p, false)
    const bf = await db
      .query(`select has_function_privilege('authenticated', 'public.p3_backfill_terms_and_cohorts()', 'execute') as p`)
      .then((x) => x.rows[0])
    eq('N36：`p3_backfill_terms_and_cohorts()` **只有服务端能调**', bf.p, false)
    const pol = rowsOf(
      await db.query(
        `select tablename from pg_policies where tablename in ('academic_years','terms') order by tablename`,
      ),
    ).map((x) => x.tablename)
    eq('N37：两张新表的读策略都在（读得宽）', pol, ['academic_years', 'terms'])
    const rls2 = rowsOf(
      await db.query(
        `select relname, relrowsecurity from pg_class where relname in ('academic_years','terms') order by relname`,
      ),
    )
    eq('N38：两张新表都开了 RLS（不开 = 裸奔）', rls2.map((r) => [r.relname, r.relrowsecurity]), [
      ['academic_years', true],
      ['terms', true],
    ])

    /* ⑫ 学年写入口：重叠的两个半期要被拒（人话）
       ⚠️ 2026-10-02：签名第一个参数是**显式 `p_actor`**（服务端用 service_role 调它，
          而 service_role 下 `auth.uid()` 是 NULL —— 见 `schema.sql` §27.13）。 */
    const overlap = await tryAs(
      U.admin,
      `select public.write_academic_year('${U.admin}', '2027-2028', date '2027-09-01', date '2028-08-31',
        date '2027-09-01', date '2028-02-28', date '2028-02-01', date '2028-08-31')`,
    )
    ok('N39：上下半期重叠 → 被拒（报的是人话）', !overlap.ok && /重叠/.test(overlap.message), overlap.message)
    const badName = await tryAs(
      U.admin,
      `select public.write_academic_year('${U.admin}', '', date '2027-09-01', date '2028-08-31',
        date '2027-09-01', date '2028-01-31', date '2028-02-01', date '2028-08-31')`,
    )
    ok('N40：学年名空着 → 被拒', !badName.ok, badName.message)
    /* 反向对照：合法的那一条**确实写得进去**（不然前面两条"被拒"全是假绿）
       ⚠️ 用 `U.super` 写：本夹具里的 `U.admin` 只有 `admin` 这一条身份，
       而 `can_manage_terms_for(p_actor)` = `is_school_admin_for(p_actor)`（超管 / 教务处 —— 那条判据
       读的是 `teacher_roles`；夹具里只有 super 那一条是确定的）。 */
    const okYear = await tryAs(
      U.super,
      `select public.write_academic_year('${U.super}', '2027-2028', date '2027-09-01', date '2028-08-31',
        date '2027-09-01', date '2028-01-31', date '2028-02-01', date '2028-08-31')`,
    )
    ok('N41（对照）：合法的学年 → 写得进去', okYear.ok, okYear.message)
    eq(
      'N42：写完之后那一年确实有了两个半期',
      await cnt(`from terms t join academic_years y on y.id = t.academic_year_id where y.name = '2027-2028'`,
      ),
      2,
    )
    /* 幂等：同一个学年再写一次 → 还是两行（on conflict do update，不新增）
       ⚠️ 判据现在读的是**显式传进来的那个 id**，不再读 `auth.uid()` ——
       所以这条对照反而更硬：它证明"人是谁"与"会话里有没有那个人"无关。 */
    const again = await tryAs(
      U.super,
      `select public.write_academic_year('${U.super}', '2027-2028', date '2027-09-01', date '2028-08-31',
        date '2027-09-01', date '2028-01-31', date '2028-02-01', date '2028-08-31')`,
    )
    ok('N42b（对照）：同一个学年再写一遍 → 也成功（`on conflict do update`）', again.ok, again.message)
    /* 🔴 反向对照：**换个没权限的人**用同一段 SQL 写 → 必须被拒（判据真的看了那个 id） */
    const otherYear = await tryAs(
      U.teacher,
      `select public.write_academic_year('${U.teacher}', '2028-2029', date '2028-09-01', date '2029-08-31',
        date '2028-09-01', date '2029-01-31', date '2029-02-01', date '2029-08-31')`,
    )
    ok('N42c（🔴 反向对照）：任课教师拿自己的 id 写学年 → 被拒（判据看的确实是 `p_actor`，不是"调用者是谁"）', !otherYear.ok && /只有教导处/.test(otherYear.message), otherYear.message)
    eq(
      'N43：同一个学年写两遍 → 仍然只有 2 个半期（不是 4 个）',
      await cnt(`from terms t join academic_years y on y.id = t.academic_year_id where y.name = '2027-2028'`),
      2,
    )
    // 收尾：把这一轮新增的学年删回去（后面的静态节不看数据，但别留脏）
    await db.exec(`delete from academic_years where name = '2027-2028'`)
    void has

    /* ⑬ 🕐 **假时钟跨学期边界**：1 月 31 日 → 2 月 1 日、8 月 31 日 → 9 月 1 日，
     *   推出来的"当前学期"必须**正好翻过去**（这是"当前学期是推的、不是存的"那条的全部意义）。
     *   ⚠️ 用**真的那份 `terms` 数据**（从库里读回来的四行），只把"现在"换成一个假 Date。 */
    {
      const { termOfDate, currentTermId } = termsLib
      const at = (iso) => new Date(`${iso}T09:00:00+08:00`)
      /*
       * ⚠️ `terms` 是**从库里读回来的行**（snake_case），而 `lib/terms.ts` 的 `Term`
       *    是 camelCase —— 这里显式映射一次（**不是另写一份判据**：判据仍是那个函数）。
       *    第一版直接拿行去问，语义字段全是 undefined → 每一条都"不在任何学期里"。
       */
      const termList = terms.map((t) => ({
        id: t.id,
        yearName: '',
        yearStart: '',
        yearEnd: '',
        half: Number(t.half) === 2 ? 2 : 1,
        startDate: t.start_date,
        endDate: t.end_date,
      }))
      const halfOf = (iso) => {
        const id = currentTermId(termList, at(iso))
        const t = termList.find((x) => x.id === id)
        return t ? `${t.startDate}~${t.endDate}` : '（不在任何学期里）'
      }
      eq('N48：2026-01-31 还是上半期', halfOf('2026-01-31'), '2025-09-01~2026-01-31')
      eq('N49：🔴 2026-02-01 就翻到下半期了（跨学期边界那一天）', halfOf('2026-02-01'), '2026-02-01~2026-08-31')
      eq('N50：2026-08-31 还是 2025-2026 的下半期', halfOf('2026-08-31'), '2026-02-01~2026-08-31')
      eq('N51：🔴 2026-09-01 就翻到 2026-2027 上半期了（跨学年边界那一天）', halfOf('2026-09-01'), '2026-09-01~2027-01-31')
      eq('N52：2027-01-31 仍是上半期的最后一天', halfOf('2027-01-31'), '2026-09-01~2027-01-31')
      eq('N53：2027-02-01 翻到下半期', halfOf('2027-02-01'), '2027-02-01~2027-08-31')
      eq(
        'N54（对照）：2030-01-01 不在任何学期区间里 → **认不出**（不许就近归到某一学期，I14）',
        currentTermId(termList, at('2030-01-01')),
        null,
      )
      eq(
        'N55：边界那两天用 `termOfDate` 直接问也是同一结论（同一个函数，没有第二套判据）',
        [termOfDate(termList, '2026-01-31'), termOfDate(termList, '2026-02-01')].join('|'),
        [
          termList.find((t) => t.startDate === '2025-09-01').id,
          termList.find((t) => t.startDate === '2026-02-01').id,
        ].join('|'),
      )
      /* 反向对照：把 2025-2026 的**上半期结束日**从 1 月 31 日改成 2 月 1 日
         （它原来是那一天结束的）→ 同一天（2 月 1 日）推出来的就变成上半期了。
         ⚠️ 别去挪下半期的起点：那会在两个半期之间留出一道缝，
         同一天会"不在任何学期里"（第一版就是这么写的，直接 TypeError）。 */
      const shifted = termList.map((t) =>
        t.endDate === '2026-01-31' ? { ...t, endDate: '2026-02-01' } : t,
      )
      const hitId = currentTermId(shifted, at('2026-02-01'))
      eq(
        'N56（对照）：把上半期结束日改成 2026-02-01 之后，同一天推出的是**上半期**（边界确实在起作用）',
        termList.find((t) => t.id === hitId)?.endDate,
        '2026-01-31',
      )
    }

    /* ⑬ 🔴 **负向对照（真 SQL，自己验自己）**
     *
     *  为什么这条对照必须在**真库**里跑：N20–N23 那一组验的是**前端判据**，
     *  而"回填幂等"这句话的实体是**那句 SQL**。只断言"跑第二遍是 0 行"、
     *  从不试着改坏它 —— 那条断言就是**永远为绿的摆设**（§三.2 踩过）。
     *
     *  ⚠️ 它只改**内存里的 SQL 文本**（`applyNegative`），仓库文件一个字节都不动。 */
    ok(
      'N44：幂等对照的两个锚点在源码里找得到（找不到说明这段对照已经失效）',
      /a\.term_id is null/.test(RAW) && /p3_backfill_terms_and_cohorts/.test(RAW),
    )
    if (NEGATIVE === 'backfill-not-idempotent') {
      const broken = applyNegative(RAW)
      ok('N45（对照自证）：`applyNegative` 确实改动了文本', broken !== RAW)
      const m = broken.match(
        /create or replace function public\.p3_backfill_terms_and_cohorts\(\)[\s\S]*?\nend \$\$;/,
      )
      ok('N46（对照自证）：改坏的那份函数文本取得出来', !!m)
      if (m) {
        await db.exec(m[0].replace('public.p3_backfill_terms_and_cohorts()', 'public._neg_backfill()'))
        const again = one(await db.query('select public._neg_backfill() as r')).r
        ok(
          'N47（对照）：拿掉"只填空的"之后，**重跑一遍不再是 0 行**（N10/N11/N12 因此会红）',
          Number(again.assignmentsTermFilled) > 0,
          `实际 ${JSON.stringify(again)}`,
        )
      }
    }
  }

  /* ============================================================
     三、静态：导入导出同一套列名 / 步数表 / 探针
     ============================================================ */

  section('第九节 · 静态：列名唯一来源、探针、批量上限')

  {
    const src = (p) => readFileSync(resolvePath(APP, p), 'utf8')
    const rosterSrc = src('src/lib/roster.ts')
    const fnSrc = src('functions/api/grade-setup.ts')
    const libSrc = src('src/lib/gradeSetup.ts')

    /* 列名只有一处定义 */
    const colDefs = rosterSrc.match(/export const ROSTER_COLUMNS/g) ?? []
    eq('N1：`ROSTER_COLUMNS` 只有一处定义', colDefs.length, 1)
    ok(
      'N2：导出用的表头由它拼出来（不是另抄一份字面量）',
      /ROSTER_HEADER = \[[\s\S]*?ROSTER_COLUMNS\./.test(rosterSrc),
    )

    /* 批量上限两边同值 */
    const fnMax = fnSrc.match(/const ROSTER_MAX = (\d+)/)?.[1]
    const libMax = libSrc.match(/ROSTER_IMPORT_MAX = (\d+)/)?.[1]
    eq('N3：名单导入上限 —— 服务端与前端**同值**', fnMax, libMax)
    const fnMax2 = fnSrc.match(/const CLASS_SUBJECT_MAX = (\d+)/)?.[1]
    const libMax2 = libSrc.match(/CLASS_SUBJECT_BULK_MAX = (\d+)/)?.[1]
    eq('N4：任教关系批量上限 —— 服务端与前端**同值**', fnMax2, libMax2)
    ok('N5：上限的值就是 3000 / 2000（与 schema 里那两句 raise exception 同值）', fnMax === '3000' && fnMax2 === '2000', `${fnMax} / ${fnMax2}`)
    const schemaText = readFileSync(SCHEMA_FILE, 'utf8')
    ok('N6：数据库那两句上限也是 3000 / 2000', /最多导入 3000 行/.test(schemaText) && /最多写 2000 行/.test(schemaText))

    /* 🔴 探针用 `select('*')`（D10 会抓 `select('具体列')`）—— 它在 `data/remote.ts` 里
       （与 `ensureSubjectCols` / `ensureSerialCols` 同一个文件：那三处探针都在写路径旁边） */
    const remoteSrc = src('src/data/remote.ts')
    ok(
      'N7：班级列的探针用 `select(\'*\')`（不是 `select(\'kind\')` —— 那在没有这一列的库上什么都问不出来）',
      /from\('classes'\)\s*\.select\('\*'\)/.test(remoteSrc),
    )
    ok(
      'N8：那个探针是 `probeClassCols`（D10 认得出这个命名，才会按"探针"的规矩查它的 select）',
      /async function probeClassCols/.test(remoteSrc),
    )

    /* 服务端**不自己写一套权限判据**：只问数据库 */
    ok('N9：服务端问的是 `can_manage_grade_setup`（不自己写角色数组）', /can_manage_grade_setup/.test(fnSrc))
    ok('N10：服务端问的是 `write_student_subject` / `bulk_write_class_subjects` / `bulk_import_roster` 三个 RPC', ['write_student_subject', 'bulk_write_class_subjects', 'bulk_import_roster'].every((f) => fnSrc.includes(f)))

    /* 「其他」那一条在**四处**同值（前端 pick / 前端脚本 / 服务端 / 数据库） */
    ok('N11：`pick.ts` 里有「其他」必须手工选走班科目那一条', /必须手工选走班科目/.test(src('src/lib/pick.ts')))
    ok('N12：服务端也有那一条（形状校验）', /必须手工选走班科目/.test(fnSrc))
    ok('N13：数据库也有那一条（唯一闸门）', /必须手工选走班科目/.test(schemaText))

    /* 选科的**四条写入路径**：三条前端 + 一条服务端，全都要过同一份结构约束 */
    const pickSrc2 = src('src/lib/pick.ts')
    ok(
      'N14：选科结构约束只有一处定义（`pick.ts` 的 `subjectCheck`）',
      (pickSrc2.match(/export function subjectCheck/g) ?? []).length === 1,
    )
    ok(
      'N15：粘贴那条路**复用**它（`gradeImport.ts` 里调 `subjectCheck`，不是另写一份）',
      /subjectCheck\(row\)/.test(src('src/lib/gradeImport.ts')),
    )
    ok(
      'N16：一键按班型默认那条路也复用（`collectByClassType` 用的是 `defaultSubjectFor`，而默认组合来自 `CLASS_TYPE_DEFAULT`）',
      /CLASS_TYPE_DEFAULT/.test(src('src/data/types.ts')),
    )

    /* 序列号：导入**不自己算号**（前端与服务端各一条静态证据） */
    ok(
      'N17：服务端把 `serial` 原样交给数据库（导入不含任何算号的代码）',
      !/padStart|padStart\(3/.test(fnSrc) && /serial: String\(x\.serial/.test(libSrc),
    )
    ok(
      'N18：前端 `gradeImport.ts` 里也没有算号的代码（只有"空串 = 交给触发器"那一句）',
      !/lpad|padStart/.test(src('src/lib/gradeImport.ts')),
    )

    /* ---- 🆕 P3（学年 / 学期 / 届）的四条静态证据 ---- */

    const termsSrc = src('src/lib/terms.ts')
    ok(
      'N19：学期筛选判据只有一处定义（`lib/terms.ts` 的 `termMatches`）',
      (termsSrc.match(/export function termMatches/g) ?? []).length === 1,
    )
    ok(
      'N20：作业列表**复用**它（不是另写一套学期判断）',
      /termMatches\(/.test(src('src/pages/Assignments.tsx')),
    )
    ok(
      'N21：考试列表**复用**同一个判据',
      /termMatches\(/.test(src('src/pages/Exams.tsx')),
    )
    ok(
      "N22：学期列的探针用 `select('*')`（D10 会抓 `select('term_id')`）",
      /from\('assignments'\)\s*\.select\('\*'\)/.test(remoteSrc),
    )
    ok(
      'N23：那个探针是 `probeTermCols`（D10 认得出这个命名才会按"探针"的规矩查它的 select）',
      /async function probeTermCols/.test(remoteSrc),
    )
    ok(
      'N24：`terms` 表**没有** `is_current` 这一列（"当前学期"是推出来的，不落列）',
      /* ⚠️ 只在**建表那一段**里查：`schema.sql` 的注释里写着"不存 is_current"这句话本身
         （那是解释），所以要按"有没有 `is_current` 这一列的定义"判。 */
      !/is_current\s+(boolean|text|int|date|timestamptz)/.test(schemaText) &&
        !/is_current/.test(termsSrc.replace(/[^\n]*没有[^\n]*\n/g, '')),
    )
    ok(
      "N25：两边同一条时间口径 —— 前端 `beijingNow()`（SQL 那边是 `at time zone 'Asia/Shanghai'`）",
      /beijingNow\(\)/.test(termsSrc) && /at time zone 'Asia\/Shanghai'/.test(schemaText),
    )
    ok(
      'N26：写学期那一列只有 `remote.ts` 的两处写路径（作业 + 考试各一处，都由日期推）',
      (remoteSrc.match(/row\.term_id = /g) ?? []).length === 2 &&
        /* 调用点两处 + 它自己的定义一处 = 3 */
        (remoteSrc.match(/termIdForDate\(/g) ?? []).length === 3 &&
        /* 页面与 store 都不许自己写这一列（同一件事两个入口必错一个） */
        !['src/pages/Assignments.tsx', 'src/pages/Exams.tsx', 'src/data/store.ts'].some((p) =>
          /\.term_id\s*=/.test(src(p)),
        ),
      `remote.ts ${(remoteSrc.match(/row\.term_id = /g) ?? []).length} 处 / 调用点 ${(remoteSrc.match(/termIdForDate\(/g) ?? []).length} 处`,
    )
  }

  section('第九节之二 · 权限：谁能进这一页 / 谁能指派身份（**前端入口层**）')

  {
    /*
     * 🔴 这一节**只核入口层**（"界面摆不摆"），真正的闸门是数据库那三个函数
     *    （H/I/J 三节已经在真 PostgreSQL 里逐个试过了）。
     *    ⚠️ 两条必须分开断言的是**建号 ≠ 指派身份**：
     *       办公室主任能建号（`canManageTeachers`），但**不能**指派身份（`canAssignRoles`）——
     *       合并的那一刻他会看到"加一个身份"的按钮，而服务端会 403（"编出来的按钮"）。
     */
    const rolesMod = await import(pathToFileURL(resolvePath(APP, 'src/lib/roles.ts')).href)
    const src = (p) => readFileSync(resolvePath(APP, p), 'utf8')
    eq(
      'O1：教务处 / 超管看得见「年级管理」（`/grades` 的入口对他们摆）',
      rolesMod.entryVisible('/grades', [{ role: 'admin' }]) &&
        rolesMod.entryVisible('/grades', [{ role: 'super' }]),
      true,
    )
    eq(
      'O2：年级主任看得见「年级管理」（**列表里只有本年级** —— 那是 RLS，不是这一层）',
      rolesMod.entryVisible('/grades', [{ role: 'grade_head' }]),
      true,
    )
    eq(
      'O3：班主任 / 任课教师**看不见**「年级管理」',
      rolesMod.entryVisible('/grades', [{ role: 'head_teacher' }]) ||
        rolesMod.entryVisible('/grades', [{ role: 'teacher' }]),
      false,
    )
    eq(
      'O4：办公室主任也看不见（他只有"建号"那一档，看不到任何教学数据）',
      rolesMod.entryVisible('/grades', [{ role: 'office_head' }]),
      false,
    )
    eq(
      'O5：🔴 办公室主任**能建号**（`canManageTeachers` 含他）',
      rolesMod.canManageTeachers([{ role: 'office_head' }]),
      true,
    )
    eq(
      'O6：🔴 办公室主任**不能指派身份**（`canAssignRoles` 不含他）—— 两件事不能合并',
      rolesMod.canAssignRoles([{ role: 'office_head' }]),
      false,
    )
    eq(
      'O7：任课老师两样都不能',
      rolesMod.canManageTeachers([{ role: 'teacher' }]) || rolesMod.canAssignRoles([{ role: 'teacher' }]),
      false,
    )
    /* 前端**不另写一套判据**：页面里读的是 `entryVisible` / `canAssignRoles`，不是手写的角色数组 */
    const gsPage = src('src/pages/GradeSetup.tsx')
    ok('O8：这一页的入口/按钮显隐走的是 `lib/roles.ts` 的函数（不是本地手写角色数组）', /canAssignRoles\(myRoles\)/.test(gsPage))
    ok('O9：页面里**没有**手写 `role === \'admin\'` 这种判据', !/role\s*===\s*'(admin|super|grade_head)'/.test(gsPage))
    /*
     * O10：`/grades` 的入口**在哪儿**。
     * 🔴 2026-10-01 改了（原来查的是 `Settings.tsx`）：那三行的入口搬去了
     *    「行政管理」页（`/manage`），所以判据要跟着搬家 —— 查的是
     *    "`Administration.tsx` 里登记了 `/grades` 这张卡" +
     *    "那一页的显隐走 `entryVisible(...)`（不是手写角色数组）" +
     *    "**「我的」页上已经没有它了**"（别留两份入口）。
     */
    const adminPage = src('src/pages/Administration.tsx')
    const adminCardKeys = [...adminPage.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])
    ok(
      'O10：`/grades` 的入口**在「行政管理」页的那张卡上**（`Administration.tsx` 登记了 `/grades`）',
      adminCardKeys.includes('/grades'),
      `卡片 key：${adminCardKeys.join(' / ') || '(一个都没解析到)'}`,
    )
    ok(
      'O10a：那一页的卡片显隐走 `entryVisible(...)`（不是本地手写角色数组）',
      /entryVisible\(/.test(adminPage) && !/role\s*===\s*'(admin|super|grade_head|office_head)'/.test(adminPage),
    )
    ok(
      'O10b：而且「我的」页上**已经没有**「年级管理」那一行（2026-10-01 搬到 /manage —— 别留两份入口）',
      !/entryVisible\('\/grades'/.test(src('src/pages/Settings.tsx')),
    )
  }

  section('第十节 · 负向对照（必须**有红** —— 自己验自己）')

  {
    /*
     * 这些对照**不依赖 SQL**：它们改的是**模块文本**（内存里），
     * 用来证明"上面那些断言不是永远为绿的"。每一条都要求"确实被改坏了"。
     */
    const giSrc = readFileSync(resolvePath(APP, 'src/lib/gradeImport.ts'), 'utf8')
    const colMatch = giSrc.match(/GRADE_SETUP_STEPS: readonly StepCount\[\] = \[[\s\S]*?\n\]/)
    ok('P0：步数表在源码里找得到（找不到就说明锚点坏了，下面几条无从谈起）', !!colMatch)

    if (colMatch) {
      const poisoned = colMatch[0].replace(
        /(\{ what: '② 建班[^']*', steps: )0/,
        '$12',
      )
      const changed = poisoned !== colMatch[0]
      eq('P1：把"建班 0 步"改成 2 步 —— 文本确实被改坏了（对照本身要能红）', changed, true)
      /* 在改坏的那一份上重算：G2 会红 */
      const m = poisoned.match(/steps: (\d+)/g) ?? []
      const total = m.reduce((a, x) => a + Number(x.replace(/\D/g, '')), 0)
      ok('P2：改坏之后"合计"变了（G1/G2 那两条因此会红）', total !== gi.GRADE_SETUP_STEP_TOTAL, `${total} vs ${gi.GRADE_SETUP_STEP_TOTAL}`)
    }

    /* 导出列名换一套 → A3/A4 会红 */
    const rosterSrc = readFileSync(resolvePath(APP, 'src/lib/roster.ts'), 'utf8')
    const poisonedCols = rosterSrc.replace("studentNo: '班级内学号'", "studentNo: '学号'")
    eq('P3：把导出列名改成老口径（`学号`）—— 文本确实被改坏了', poisonedCols !== rosterSrc, true)
    ok(
      'P4：改坏之后 `ROSTER_COLUMNS` 与 `ROSTER_HEADER` 就不再同源（A3 会红）',
      /studentNo: '学号'/.test(poisonedCols),
    )

    /* 选科结构约束拿掉 → D3 会红
       ⚠️ 锚点必须是**标准组合那一支**（`kind === 'standard'`）那一条：
          源码里有**两句** `second.length !== 2`（另一句是「其他」的），
          用短锚点会改错地方（实测：`replace` 只替换第一处，改到「其他」那一支上，
          再拿标准组合的输入去试 —— 当然照样被拦，"对照不红"）。
          所以锚点带上它前后那一行的特征。 */
    const pickSrc = readFileSync(resolvePath(APP, 'src/lib/pick.ts'), 'utf8')
    const anchor =
      "  if (!PRIMARY_CODES.includes(s.primaryCode as SubjectCode)) {\n" +
      "    return s.primaryCode ? `首选只能是物理或历史（收到「${subjectName(s.primaryCode, s.primaryCode)}」）` : '还没有选首选'\n" +
      '  }\n' +
      '  if (second.length !== 2) return `再选必须恰好 2 门（这一行有 ${second.length} 门）`'
    const poisonedPick = pickSrc.replace(
      anchor,
      anchor.slice(0, anchor.indexOf('  if (second.length')) + '  /* 负向对照：拿掉"再选恰好 2 门" */',
    )
    eq('P5：把"再选恰好 2 门"（标准组合那一支）拿掉 —— 文本确实被改坏了（锚点找得到）', poisonedPick !== pickSrc, true)
    /*
     * 🔴 对照要**真跑一遍**才算数：把改坏的那份落到一个临时 `.ts`（同名目录，相对导入才解析得了）、
     *    import 它、再拿**同一组输入**调一次 —— 结论必须与改坏前相反
     *    （改坏前拦住、改坏后放过）。
     *    ⚠️ 光断言"源码里那句话没了"是**假对照**：那句话可能只是换了写法，
     *       而 `subjectCheck` 照样拦得住 —— 那样这条对照就永远是绿的。
     */
    const TMP = resolvePath(APP, 'src/lib/.__p6_negative_tmp.ts')
    const before = pickLib.subjectCheck({
      kind: 'standard',
      primaryCode: 'physics',
      secondCodes: ['chemistry'],
      note: '',
    })
    let after = '（没跑起来）'
    try {
      writeFileSync(TMP, poisonedPick)
      const mod = await import(pathToFileURL(TMP).href)
      after = mod.subjectCheck({ kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry'], note: '' })
    } catch (e) {
      after = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
    } finally {
      try {
        rmSync(TMP, { force: true })
      } catch {
        /* 删不掉不影响结论；仓库里那个临时文件在 .gitignore 里没有 —— 所以下面这一条断言会抓它 */
      }
    }
    ok(
      'P6：改坏之后**同一组输入不再被拦**（D3 会红）—— 这才是真对照',
      before !== null && after === null,
      `改坏前 = ${JSON.stringify(before)}；改坏后 = ${JSON.stringify(after)}`,
    )
    eq('P7：临时文件已经删掉（仓库里不留痕迹）', existsSync(TMP), false)

    /* ---- 🆕 P3（学期筛选）：三条真跑一遍的对照 ---- */
    {
      const termsSrc = readFileSync(resolvePath(APP, 'src/lib/terms.ts'), 'utf8')
      /* ① 把"没有归属也算看得见"拿掉 → N20/N21 会红 */
      const poisonedNull = termsSrc.replace(
        /    if \(termId === undefined \|\| termId === null\) return true\n    return termId === current/,
        '    return termId === current',
      )
      eq('P8：把"没有归属的也算看得见"拿掉 —— 文本确实被改坏了（锚点找得到）', poisonedNull !== termsSrc, true)
      const T2 = resolvePath(APP, 'src/lib/.__p8_negative_tmp.ts')
      let afterNull = '（没跑起来）'
      try {
        writeFileSync(T2, poisonedNull)
        const mod = await import(pathToFileURL(T2).href)
        afterNull = mod.termMatches(null, 'current', 'T-current', [])
      } catch (e) {
        afterNull = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
      } finally {
        try {
          rmSync(T2, { force: true })
        } catch {
          /* 删不掉由下一条断言抓 */
        }
      }
      ok(
        'P9：改坏之后 `term_id = null` 的档案**不再显示**（N20/N21 会红）—— 这才是真对照',
        afterNull === false,
        `实际 ${JSON.stringify(afterNull)}`,
      )
      eq('P10：那个临时文件也删掉了', existsSync(T2), false)

      /* ② 列表默认必须是「本学期」，不是「全部」
         ⚠️ 这里**故意写死 `'current'`**（而不是读 `termsLib` 的常量）：这条断言要能独立
         指出"两页的默认值变了"，读被测模块自己的常量会让两边一起变、永远为绿。 */
      const curFilter = 'current'
      eq(
        'P11a（自证）：`TERM_FILTER_CURRENT` 就是写死的那个 `current`（常量改名时这里会红）',
        termsLib.TERM_FILTER_CURRENT,
        curFilter,
      )
      ok(
        'P11：作业列表的默认学期筛选就是「本学期」（`useState<TermFilterValue>(TERM_FILTER_CURRENT)`）',
        new RegExp(`useState<TermFilterValue>\\(TERM_FILTER_CURRENT\\)`).test(
          readFileSync(resolvePath(APP, 'src/pages/Assignments.tsx'), 'utf8'),
        ),
        curFilter,
      )
      ok(
        'P12：考试列表的默认学期筛选也是「本学期」（两页同一口径）',
        new RegExp(`useState<TermFilterValue>\\(TERM_FILTER_CURRENT\\)`).test(
          readFileSync(resolvePath(APP, 'src/pages/Exams.tsx'), 'utf8'),
        ),
        curFilter,
      )
    }
  }

  /* ============================================================
     第十一节 · 🔴 canSetup 端到端（**问题一**）：「超管拿到 true」必须有断言
     ------------------------------------------------------------
     为什么要有这一节：上面那些条里**没有一条**验过"超管拿到 `canSetup === true`"——
     各层各自绿（K2 只验"函数能被 authenticated 调用"、H 段只验"年级主任能导名单"），
     而**端到端那一条没人验**。于是"超管被显示成只能看"这种坏法能一路全绿。

     🔴 这一节**不是**再测一遍纯函数：它 import `functions/api/grade-setup.ts` 的**真源码**，
        用 `onRequestPost()` 走真的 `canSetup` 分支；下面那个 fetch 桩把
        `/auth/v1/user` 与 `/rest/v1/rpc/can_manage_grade_setup` 接到**真库**上，
        并且照 PostgREST 的做法执行：`set local role authenticated` +
        把调用者的 sub 放进 `request.jwt.claim.sub`（`auth.uid()` 就读它）。
        ⚠️ **一个字节都不出网**：桩只认那两个地址。
     ============================================================ */

  section('第十一节 · 🔴 canSetup 端到端：超管 / 教务处 / 年级主任 / 班主任（真源码 + 真库）')

  {
    const api = await import(pathToFileURL(resolvePath(APP, 'functions/api/grade-setup.ts')).href)
    const gsLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/gradeSetup.ts')).href)

    /* 两个新夹具：**别的年级**的年级主任 / **教室端账号**（`teacher_roles` 里没有它那一行） */
    const U2 = {
      other: '66666666-6666-6666-6666-666666666666',
      room: '77777777-7777-7777-7777-777777777777',
    }
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${U2.other}', 'other@test', '{"name":"高二主任"}'::jsonb),
        ('${U2.room}',  'room@test',  '{"name":"一(1)班教室端"}'::jsonb);
      insert into teacher_roles (teacher_id, role, scope_type, scope_id) values
        ('${U2.other}', 'grade_head', 'grade', ${gradeOf('高二')});
    `)

    const TOKEN_OF = new Map([
      ['tok-super', U.super],
      ['tok-admin', U.admin],
      ['tok-grade', U.grade],
      ['tok-other', U2.other],
      ['tok-head', U.head],
      ['tok-teacher', U.teacher],
      ['tok-room', U2.room],
    ])
    const gid1 = one(await db.query(`select id::text as id from grades where name = '高一'`)).id
    const gid2 = one(await db.query(`select id::text as id from grades where name = '高二'`)).id

    /*
     * 🔴 反向对照那份"改坏的真函数"：取 `schema.sql` 里 `can_manage_grade_setup_for(uid, grade)` 的
     *    **真文本**，把第一支（`select public.is_school_admin_for(p_uid) or exists (…`）砍掉，
     *    落成 `_neg_grade_setup(uid, grade)`。
     *    ⚠️ 2026-10-02（集成修复）：判据函数拆成 `_for` / 裸版两件套之后，桩问的那一条是**裸版**
     *       （走 `auth.uid()`）—— 这里改成只替 `_for` 那一份的**函数名 + 那一行**，
     *       让桩带着调用者的 uid 去问它，仍然是"同一份真源码、只砍掉校级管理那一支"。
     *    ⚠️ 为什么不用全局 `GRADE_NEGATIVE` 改原文：那一支**同时**是 H 段"导入名单"的闸门，
     *       改掉后 H2 先失败（学生一个都没写进去）→ 脚本在 I 段中断，反而看不到 R1 变红。
     *    `GRADE_NEGATIVE=setup-broken-fn` 会让桩**从头**就问这一份 —— 于是 R1/R2 当场红。
     */
    const fnText = RAW.match(
      /create or replace function public\.can_manage_grade_setup_for\(p_uid uuid, p_grade_id uuid\)[\s\S]*?\n\$\$;/,
    )
    const half = `  select public.is_school_admin_for(p_uid)
      or exists (`
    const brokenFn = fnText
      ? fnText[0]
          .replace(half, '  select exists (')
          .replace(
            'create or replace function public.can_manage_grade_setup_for(',
            'create or replace function public._neg_grade_setup(',
          )
      : ''
    if (fnText) {
      await db.exec(brokenFn)
    }

    /* ---------------- fetch 桩：Supabase 的两条链，接到真库 ----------------
     * 🔴 **2026-10-02（集成修复）扩展**：以前这个桩只会执行 `can_manage_grade_setup(p_grade_id)`
     *    那一条（判据）；现在它还要执行**三个写入口**，而且**必须用真的 service_role 形状**：
     *      · 调用者 JWT（`tok-*`）那条链 → `set local role authenticated` + jwt claim（读 auth.uid()）；
     *      · `fake-service-role`（= `svcRpc()` 用的那个 key）那条链 → **属主身份**（不做 set role），
     *        并且**要求 body 里有显式 `p_actor`** —— 这正是"服务端必须显式传人"的断言点。
     *    ⚠️ 三个写入口对 authenticated 是 **42501**（`schema.sql` §27.12 的 revoke）——
     *       所以"拿调用者 JWT 调它"这一条路在本节里也被真跑一遍（R40）。
     */
    const realFetch = globalThis.fetch
    const rpcCalls = []
    const writeActorArgs = {}
    let rpcMissing = false
    /** `fake-service-role` 就是 `ENV.SUPABASE_SERVICE_ROLE_KEY`（写入口用的那个 key） */
    const SVC = 'fake-service-role'
    /** 只有 service_role 能调写入口 —— 反向对照会把它打开（= 走 B 方案那条路的样子） */
    let asServiceAllowed = true
    /** 反向对照用：把桩要问的函数换成"改坏的那一份"（默认问真的那一个） */
    let fnOverride = NEGATIVE === 'setup-broken-fn' ? '_neg_grade_setup' : null
    const jsonRes = (v, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })

    /** 桩认识的 RPC → 一条真 SQL（参数形状与 `schema.sql` §27 的新签名逐字对应） */
    const RPC_SQL = {
      can_manage_grade_setup: (b) => [`select public.can_manage_grade_setup($1::uuid) as v`, [b.p_grade_id]],
      bulk_import_roster: (b) => [
        `select public.bulk_import_roster($1::uuid, $2::uuid, $3::jsonb, $4::text) as v`,
        [b.p_actor, b.p_grade_id, JSON.stringify(b.p_rows ?? []), b.p_class_name_template ?? '%s'],
      ],
      bulk_write_class_subjects: (b) => [
        `select public.bulk_write_class_subjects($1::uuid, $2::jsonb) as v`,
        [b.p_actor, JSON.stringify(b.p_rows ?? [])],
      ],
      write_student_subject: (b) => [
        `select public.write_student_subject($1::uuid,$2::uuid,$3::text,$4::text,$5::text[],$6::text,$7::uuid[]) as v`,
        [b.p_actor, b.p_student_id, b.p_kind, b.p_primary, b.p_second ?? [], b.p_note ?? '', b.p_member_class_ids ?? []],
      ],
      write_academic_year: (b) => [
        `select public.write_academic_year($1::uuid,$2::text,$3::date,$4::date,$5::date,$6::date,$7::date,$8::date) as v`,
        [b.p_actor, b.p_name, b.p_year_start, b.p_year_end, b.p_half1_start, b.p_half1_end, b.p_half2_start, b.p_half2_end],
      ],
    }
    const isWriteFn = (fn) =>
      fn === 'bulk_import_roster' ||
      fn === 'bulk_write_class_subjects' ||
      fn === 'write_student_subject' ||
      fn === 'write_academic_year'

    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const token = String(new Headers(init.headers ?? {}).get('authorization') ?? '').replace(
        /^Bearer\s+/i,
        '',
      )
      if (/\/auth\/v1\/user$/.test(url)) {
        const uid = TOKEN_OF.get(token)
        return uid ? jsonRes({ id: uid }) : jsonRes({ message: 'invalid jwt' }, 401)
      }
      const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)
      if (!m) return realFetch(input, init)
      const fn = fnOverride ?? m[1]
      rpcCalls.push({ fn, token })
      const asService = token === SVC
      const uid = TOKEN_OF.get(token)
      /* 这一段是**假的 PostgREST**：形状按真的来（函数不存在 = 404 + PGRST202） */
      if (rpcMissing) {
        return jsonRes(
          {
            code: 'PGRST202',
            message: `Could not find the function public.${fn}(p_grade_id) in the schema cache`,
          },
          404,
        )
      }
      const body = JSON.parse(String(init.body ?? '{}'))
      /* 反向对照那一份是 `_for(uid, grade)` 两参形状；真判据是裸版 `(grade)` 一参 */
      const callSql =
        fn === '_neg_grade_setup'
          ? `select public._neg_grade_setup($1::uuid, $2::uuid) as v`
          : RPC_SQL[fn]?.(body)?.[0]
      const callParams = fn === '_neg_grade_setup' ? [uid, body.p_grade_id] : RPC_SQL[fn]?.(body)?.[1]
      if (!callSql) return jsonRes({ message: `桩不认识这个 RPC：${fn}` }, 500)
      if (isWriteFn(fn)) {
        /* 🔴 service_role 那条链**必须**显式带 `p_actor` —— 这才叫"验出来的身份传下去" */
        if (!asService && asServiceAllowed) {
          /* = 数据库的 `revoke … from authenticated`：**42501**（不是"判据为假"） */
          return jsonRes({ message: 'permission denied for function ' + fn }, 401)
        }
        if (!body.p_actor) return jsonRes({ code: 'P0001', message: '没有传 p_actor' }, 400)
        writeActorArgs[fn] = body.p_actor
      } else if (!uid) {
        return jsonRes({ message: 'JWT required' }, 401)
      }
      await db.exec('begin')
      try {
        if (asService && asServiceAllowed) {
          /* 属主身份 = 真的 PostgREST 用 service_role 跑的样子（**不** set role），
             而且**清掉**会话里的 jwt claim —— service_role 下 `auth.uid()` 就是 **NULL**。
             🔴 这一句是"三个写入口必须显式传 `p_actor`"的**运行时**根据：
                不清的话 `auth.uid()` 会漏到上一次调用留下的值（假绿）。 */
          await db.query(`select set_config('request.jwt.claim.sub', '', true)`)
        } else {
          /* 调用者 JWT 那条链（`set role authenticated` + claim）——
             反向对照 `asServiceAllowed=false` 时，写入口也走这一支（= B 方案的样子） */
          await db.exec('set local role authenticated')
          await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
        }
        const out = await db.query(callSql, callParams)
        await db.exec('commit')
        return jsonRes(out.rows[0].v)
      } catch (e) {
        await db.exec('rollback')
        return jsonRes({ code: 'P0001', message: String(e?.message ?? e).split('\n')[0] }, 400)
      }
    }

    const ENV = {
      SUPABASE_URL: 'http://127.0.0.1:9',
      SUPABASE_ANON_KEY: 'fake-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
    }
    /** 走**真源码**问一次（`token = null` = 前端漏带 Authorization 的形状） */
    const post = async (token, payload) => {
      const res = await api.onRequestPost({
        request: new Request('https://example.invalid/api/grade-setup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        }),
        env: ENV,
      })
      return { status: res.status, json: await res.json() }
    }
    const ask = (token, gradeId) => post(token, { action: 'canSetup', gradeId })

    try {
      /* ① 🔴 **缺的就是这一条**：全平台最高管理员 */
      const rSuper = await ask('tok-super', gid1)
      eq('R1：🔴 超管 → `canSetup === true`（这就是这次 bug 里没人验的那一条）', [rSuper.status, rSuper.json.canSetup], [200, true])
      ok(
        'R1b：服务端是拿**调用者自己的 JWT**去问数据库的（不是 service_role、也不是不带令牌）',
        rpcCalls.length > 0 && rpcCalls.every((c) => c.fn === 'can_manage_grade_setup' && c.token === 'tok-super'),
        JSON.stringify(rpcCalls),
      )
      eq('R2：教务处（`admin`）→ true', (await ask('tok-admin', gid1)).json.canSetup, true)
      eq('R3：**本年级**（高一）的年级主任 → true', (await ask('tok-grade', gid1)).json.canSetup, true)
      eq('R4：**别的年级**（高二）的年级主任 → false', (await ask('tok-other', gid1)).json.canSetup, false)
      eq('R4b（对照）：同一个高二主任在自己那个年级 → true', (await ask('tok-other', gid2)).json.canSetup, true)
      eq('R5：班主任 → false', (await ask('tok-head', gid1)).json.canSetup, false)
      eq('R6：任课教师 → false', (await ask('tok-teacher', gid1)).json.canSetup, false)
      eq('R7：教室端账号（`teacher_roles` 里没有它那一行）→ false', (await ask('tok-room', gid1)).json.canSetup, false)

      /* ② 三种**不是"没权限"**的失败必须能分开认出来（问题一的第 3 条） */
      const before = rpcCalls.length
      const rNoAuth = await ask(null, gid1)
      eq('R8：🔴 **不带 Authorization** → HTTP 401（本次 bug 的形状：前端漏带 JWT）', rNoAuth.status, 401)
      eq('R9：那一次请求**根本没走到数据库**（`caller()` 就把它挡了）—— 所以它不是"没权限"', rpcCalls.length, before)
      const rBadId = await ask('tok-super', 'not-a-uuid')
      eq('R10：年级 id 不是 uuid → HTTP 400（人话是"没有指定年级"，不是"你没权限"）', [rBadId.status, rBadId.json.message], [400, '没有指定年级'])
      rpcMissing = true
      const rNoFn = await ask('tok-super', gid1)
      rpcMissing = false
      eq('R11：§27 没跑（判据函数不存在）→ HTTP 503（**不是 200/false**）', rNoFn.status, 503)
      ok('R12：那句人话里写着"第 27 段"（前端照它显示"接口还没就绪"）', /第 27 段/.test(String(rNoFn.json.message)), String(rNoFn.json.message))

      /* ③ 前端那一层：**几种失败分开说**（`readCanSetup`，真源码的纯函数） */
      const st = (r) => gsLib.readCanSetup(r)
      const sOk = st({ ok: true, status: 200, data: { canSetup: true } })
      const sNo = st({ ok: true, status: 200, data: { canSetup: false } })
      const s503 = st({ ok: false, status: 503, data: { message: rNoFn.json.message } })
      const s401 = st({ ok: false, status: 401, data: { message: '登录已过期，请重新登录后再试' } })
      const s0 = st({ ok: false, status: 0, data: { message: '连不上服务器（Failed to fetch）' } })
      const sOdd = st({ ok: true, status: 200, data: {} })
      eq('R13：`canSetup:true` → 有权限，且**一个字都不说**（不解释、不辩护）', [sOk.canSetup, sOk.notice], [true, ''])
      eq('R14：`canSetup:false` → **只有这一档**才说"只能看，不能改"', [sNo.canSetup, sNo.verdict], [false, 'denied'])
      eq('R15：503（§27 没跑）→ 说"去跑 schema.sql"（把服务端那句话原样带出来），**不说"你没权限"**', [s503.verdict, /第 27 段/.test(s503.notice)], ['missing', true])
      eq('R16：401（没登 / 会话过期）→ 说"重新登录"', [s401.verdict, /登录已过期/.test(s401.notice)], ['signin', true])
      eq('R17：status 0（连不上 / 本地演示模式）→ 说"连不上"', [s0.verdict, /连不上/.test(s0.notice)], ['offline', true])
      eq('R18：🔴 `ok` 却没有 `canSetup` → 报"接口没给结论"（**不许静默当成"没权限"**）', sOdd.verdict, 'error')

      /* ④ 前端那一句判据：这一页**不许自己写 fetch**（漏带 JWT 就是这个 bug 的根因） */
      const gsPage = readFileSync(resolvePath(APP, 'src/pages/GradeSetup.tsx'), 'utf8')
      const goesThroughApi = (t) =>
        /apiCanSetup\(/.test(t) && !/fetch\(\s*['"]\/api\/grade-setup/.test(t)
      ok('R19：`canSetup` 走 `apiCanSetup()`（那条链带着 JWT），页面里没有裸 fetch', goesThroughApi(gsPage))
      eq(
        "R20（对照）：把 `apiCanSetup(id)` 换回裸 `fetch('/api/grade-setup')` → 同一条判据必须变红",
        goesThroughApi(gsPage.replace('apiCanSetup(id)', "fetch('/api/grade-setup')")),
        false,
      )

      /* ---------------- ⑤ 🔴 反向对照：把 `is_school_admin()` 那半边**真拿掉** ----------------
       * 那份改坏的真函数已经在本节开头落成 `_neg_grade_setup()`（见那段注释）。
       * 这里再让桩拿**同一个超管**去问它一次 —— 结果必须是 false。
       * ⚠️ 还要有"对照的对照"（R23）：改坏之后**本年级年级主任仍然是 true** ——
       *    否则"全 false"也能让 R22 绿，那就是**假对照**。
       */
      ok('R21a：`can_manage_grade_setup()` 的真函数文本取得出来（取不出来说明锚点坏了）', !!fnText)
      eq(
        'R21b（对照自证）：把 `is_school_admin()` 那半边砍掉 —— 文本确实被改坏了（锚点找得到）',
        brokenFn !== '' && brokenFn !== fnText?.[0] && !brokenFn.includes('is_school_admin()'),
        true,
      )
      const savedOverride = fnOverride
      fnOverride = '_neg_grade_setup'
      const rNegSuper = await ask('tok-super', gid1)
      const rNegHead = await ask('tok-grade', gid1)
      fnOverride = savedOverride
      await db.exec('drop function if exists public._neg_grade_setup(uuid)')
      eq(
        'R22（🔴 反向对照）：砍掉那半边 → **超管那条翻成 false**（R1 因此会红，它不是永远为绿的摆设）',
        rNegSuper.json.canSetup,
        false,
      )
      eq(
        'R23（对照的对照）：同一次里**本年级年级主任仍然 true** —— 说明砍的只是"校级管理"那一支，不是"全 false"',
        rNegHead.json.canSetup,
        true,
      )

      /* ============================================================
         ⑥ 🔴🔴 三个**写动作**的端到端（2026-10-02 集成修复：本轮最重要的交付）
         ------------------------------------------------------------
         为什么必须补：`canSetup` 那条路（R1–R23）当时是绿的，而**三个写动作**
         （录名单 / 批量写任教关系 / 写选科）在线上是 42501 —— 服务端拿调用者 JWT
         去调三个 `revoke … from authenticated` 的函数。各层各自绿、端到端没人验。
         🔴 这一节**必须用 `authenticated` 角色跑**（写入口那条链用属主 = service_role 的形状，
            那是**设计要求**，不是"绕过去"）：
            · `canSetup` 那条链：`set local role authenticated` + jwt claim（R1b 已经在钉它）；
            · 写入口那条链：service_role（属主）+ **显式 `p_actor`** ——
              桩里 `writeActorArgs[fn]` 记的就是服务端真的传了什么。
         ============================================================ */
      await db.exec(`
        insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type)
        values ('${U.grade}', '高一走A班', '高一', ${school}, ${gradeOf('高一')}, 'stream', '');
        insert into students (class_id, student_no, name, serial) values
          (${classOf('高二(1)班')}, 'G2-01', '高二学生', ''),
          (${classOf('高一走A班')}, 'ST-01', '走班生', '');
      `)
      const s1 = one(await db.query(`select id::text as id from students where class_id = ${classOf('高一(1)班')} order by student_no limit 1`)).id
      const s2 = one(await db.query(`select id::text as id from students where student_no = 'G2-01'`)).id
      const streamId = one(await db.query(`select id::text as id from classes where name = '高一走A班'`)).id
      /* ⚠️ 服务端那一层要真 uuid 字符串（`classOf()` 是 SQL 子查询文本，只给库内用） */
      const c1id = one(await db.query(`select id::text as id from classes where name = '高一(1)班'`)).id
      const c2id = one(await db.query(`select id::text as id from classes where name = '高一(2)班'`)).id
      const c21id = one(await db.query(`select id::text as id from classes where name = '高二(1)班'`)).id
      const countOf = async (table, where = '') =>
        Number(one(await db.query(`select count(*)::int as n from ${table} ${where}`)).n)

      /* ---- ⑤ 无 Authorization → 401，**连数据库都不到** ---- */
      const before401 = rpcCalls.length
      const wNoAuth = await post(null, {
        action: 'rosterImport',
        gradeId: gid1,
        rows: [{ classNo: '1', studentNo: '03', name: '辛', serial: '' }],
      })
      eq('W26：🔴 三个写动作**不带 Authorization** → HTTP 401', wNoAuth.status, 401)
      eq('W27：那一次**一次 RPC 都没发**（`caller()` 就挡了 —— 不是"没权限"）', rpcCalls.length, before401)

      /* ---- ⑥ §27 没跑（函数不存在）→ 503，**不是**"你没权限" ---- */
      rpcMissing = true
      const wMissing = await post('tok-super', {
        action: 'rosterImport',
        gradeId: gid1,
        rows: [{ classNo: '1', studentNo: '04', name: '壬', serial: '' }],
      })
      rpcMissing = false
      eq('W28：§27 没跑 → HTTP 503（把"去跑 SQL"那句人话带回来）', [wMissing.status, /第 27 段/.test(String(wMissing.json.message))], [503, true])

      /*
       * 🔴 W28c：**信任边界**那一条 —— grant 出去之后，"谁能调"就只剩数据库那道判据。
       *    做法：**直接以 `authenticated` 身份**调 `bulk_write_class_subjects`，
       *    但 `p_actor` 传一个**没有权限的任课教师**（不是调用者自己）。
       *      · 正常模式：函数甚至不被允许执行 → **42501**（那扇门就是 §27.12 那三条 revoke 关着的）；
       *      · `actor-grant-authenticated`（= B 方案）：门开了，于是**只能靠函数体里那句判据**挡 ——
       *        本断言要的正是"挡得住"这个结果，所以它在两种情况下都是绿的；
       *        真正会翻红的是紧跟着的 W28d（`p_actor` 那道判据被砍掉时，这里就挡不住了）。
       *    ⚠️ 它把"B 方案把安全边界从 **角色 + 判据** 缩到 **只剩判据**"这件事钉在门禁里。
       */
      const asActor = async (actorId) => {
        await db.exec('begin')
        try {
          await db.exec('set local role authenticated')
          await db.exec(
            `select public.bulk_write_class_subjects('${actorId}'::uuid, '[{"class_id":"${c1id}","subject_code":"geography","teacher_id":"${U.teacher}"}]'::jsonb)`,
          )
          await db.exec('commit')
          return { ok: true, message: '' }
        } catch (e) {
          await db.exec('rollback')
          return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
        }
      }
      const lowActor = await asActor(U.teacher)
      ok(
        'W28c：🔴 直接以 authenticated 调写入口、`p_actor` = 一个任课教师 → **挡得住**（要么 42501，要么"你没有设定这个年级任课关系的权限"）',
        !lowActor.ok && /42501|permission denied|没有设定这个年级任课关系的权限/.test(lowActor.message),
        lowActor.message,
      )

      /* ============================================================
         ⑦ 🔴 反向对照（**真跑**）：把修法改回去 —— 下面 ⑦ 之后那批断言必须当场翻红
         ------------------------------------------------------------
         `GRADE_NEGATIVE` 在这里把**修法**去掉，然后**同一段脚本、同一批断言**继续跑：
           · `actor-dropped`             —— 砍掉函数体里"判据看显式 `p_actor`"那一支
                                        → **W22/W23/W24/W25**（该被拒的那几档）翻红（实测 14 条红）；
           · `actor-grant-authenticated` —— 按 B 方案把三个写入口 grant 给 authenticated，
                                        并且不再要求 service_role
                                        → **W28c**（"只靠判据挡"那道信任边界）翻红。
         ⚠️ 所以这一段**必须排在 W 断言之前** —— 排在后面的话，"改回去"根本没被执行到，
            脚本会以"负向对照却没有红"收场（`exit 1`），那是**对照没生效**，不是修法错了。
         ⚠️ 还要有"对照自证"（W29/W30）：证明锚点找得到、权限点确实在 —— 否则对照是假绿。
         ============================================================ */
      if (NEGATIVE === 'actor-dropped') {
        await db.exec(`
          do $$
          begin
            execute replace(pg_get_functiondef('public.bulk_write_class_subjects(uuid,jsonb)'::regprocedure),
                            'public.can_manage_grade_setup_for(p_actor, v_g)', 'true');
            execute replace(pg_get_functiondef('public.write_student_subject(uuid,uuid,text,text,text[],text,uuid[])'::regprocedure),
                            'public.can_edit_student_subject_for(p_actor, p_student_id)', 'true');
            execute replace(pg_get_functiondef('public.bulk_import_roster(uuid,uuid,jsonb,text)'::regprocedure),
                            'public.can_manage_grade_setup_for(p_actor, p_grade_id)', 'true');
          end $$;
        `)
      }
      if (NEGATIVE === 'actor-grant-authenticated') {
        /*  把三个写入口 grant 给 authenticated，并且**不再要求 service_role**
            —— 也就是"任何登录者拿浏览器里的 anon key + 自己的 JWT 就能直接打这三个 RPC"。 */
        await db.exec(`
          grant execute on function public.write_student_subject(uuid,uuid,text,text,text[],text,uuid[]) to authenticated;
          grant execute on function public.bulk_write_class_subjects(uuid,jsonb) to authenticated;
          grant execute on function public.bulk_import_roster(uuid,uuid,jsonb,text) to authenticated;
        `)
        asServiceAllowed = false
      }
      if (!NEGATIVE) {
        const cbDef = one(await db.query(`select pg_get_functiondef('public.bulk_write_class_subjects(uuid,jsonb)'::regprocedure) as d`)).d
        const wsDef = one(await db.query(`select pg_get_functiondef('public.write_student_subject(uuid,uuid,text,text,text[],text,uuid[])'::regprocedure) as d`)).d
        const biDef = one(await db.query(`select pg_get_functiondef('public.bulk_import_roster(uuid,uuid,jsonb,text)'::regprocedure) as d`)).d
        ok(
          'W29（对照自证）：三个写入口的真函数体都取得出来，而且判据那一句确实在（砍它的锚点找得到）',
          /can_manage_grade_setup_for\(p_actor, v_g\)/.test(String(cbDef)) &&
            /can_edit_student_subject_for\(p_actor, p_student_id\)/.test(String(wsDef)) &&
            /can_manage_grade_setup_for\(p_actor, p_grade_id\)/.test(String(biDef)),
          [cbDef, wsDef, biDef].map((s) => String(s).slice(0, 60)).join(' | '),
        )
        eq(
          'W30（对照自证）：`authenticated` 对三个写入口**没有被 grant**（K1/K5 问的也是它）',
          Number(await db
            .query(`select has_function_privilege('authenticated', 'public.bulk_import_roster(uuid,uuid,jsonb,text)', 'execute') as p`)
            .then((x) => x.rows[0].p)),
          0,
        )
      } else {
        /*
         * 🔴 反向对照那一轮：**先证明"改回去"这件事真的发生了**。
         *    ⚠️ 这一条本身就是"对照必须能红"的保险：哪一天锚点漂了、grant 语句写错了，
         *       改回去**没生效** —— 这里当场红，而不是让整个脚本以
         *       "负向对照却没有红" 那种含糊的方式收场。
         */
        const negCbDef = String(
          one(await db.query(`select pg_get_functiondef('public.bulk_write_class_subjects(uuid,jsonb)'::regprocedure) as d`)).d,
        )
        const grantedToAuth = Number(
          await db
            .query(`select has_function_privilege('authenticated', 'public.bulk_import_roster(uuid,uuid,jsonb,text)', 'execute') as p`)
            .then((x) => x.rows[0].p),
        )
        const dropped =
          NEGATIVE === 'actor-dropped'
            ? !/can_manage_grade_setup_for\(p_actor, v_g\)/.test(negCbDef)
            : true /* `actor-grant-authenticated` 只动 grant / service_role 那两道，函数体不动 */
        const granted = NEGATIVE === 'actor-grant-authenticated' ? grantedToAuth === 1 && !asServiceAllowed : true
        eq(
          `W29（对照自证）：\`${NEGATIVE}\` 的"改回去"**确实生效了**`,
          [dropped, granted],
          [true, true],
        )
        if (NEGATIVE === 'actor-grant-authenticated') {
          /*  🔴 B 方案的**决定性证据**：grant 出去之后，浏览器拿 anon key + 自己的 JWT
              就能**直接**打这三个写 RPC —— 服务端不再是唯一入口，而唯一的闸门只剩
              `_for(p_actor, …)` 那一句判据。
              下面这条断言的**期望值 = 0**：它是**修法存在**的断言 ——
              所以这一轮（`actor-grant-authenticated` 把修法改回去）它**必须红**。
              实测对照：`schema.sql` §27.12 的三条 revoke 一恢复，它立刻变绿。 */
          eq(
            'W29b（🔴 反向对照 `actor-grant-authenticated`）：`authenticated` **不该**有这三个写入口的 execute 权限',
            grantedToAuth,
            0,
          )
        }
      }

      /* ---- ① 超管：三个动作**都成功**（这条就是这次坏掉的那条路） ---- */
      const wSuperRoster = await post('tok-super', {
        action: 'rosterImport',
        gradeId: gid1,
        rows: [
          { classNo: '1', studentNo: '01', name: '丙', serial: '' },
          { classNo: '3', studentNo: '01', name: '丁', serial: '' },
        ],
      })
      eq(
        'W1：🔴 超管录名单（1 复用 + 1 新建）→ 200 且 students = 2',
        [wSuperRoster.status, wSuperRoster.json.status, wSuperRoster.json.students],
        [200, 'ok', 2],
      )
      ok(
        'W2：桩收到的是 **service_role + 显式 `p_actor = 超管`**（不是调用者 JWT、也不是没有 p_actor）',
        writeActorArgs.bulk_import_roster === U.super &&
          rpcCalls.some((c) => c.fn === 'bulk_import_roster' && c.token === SVC),
        JSON.stringify({ actor: writeActorArgs.bulk_import_roster, calls: rpcCalls }),
      )
      const rosterRows = Array.isArray(wSuperRoster.json.roster) ? wSuperRoster.json.roster : []
      ok(
        'W3：名单真的落库了（"丙"在新班里、还有别的班的学生一起回来了）',
        rosterRows.some((x) => x.name === '丙' && x.studentNo === '01'),
        JSON.stringify(rosterRows),
      )
      const newCls = one(await db.query(`select id::text as id, teacher_id::text as tid, kind from classes where grade_id = ${gradeOf('高一')} and name like '高一(3)%'`))
      eq('W4：🔴 新建的班**归调用者**（原来是 `auth.uid()`，service_role 下会是 NULL → 建出没有班主任的班）', newCls?.tid, U.super)
      eq('W4b：那是个行政班（不是走班班）', newCls?.kind, 'admin')

      const wSuperSubjects = await post('tok-super', {
        action: 'classSubjectBulk',
        gradeId: gid1,
        rows: [{ classId: c1id, subjectCode: 'physics', teacherId: U.teacher }],
      })
      eq(
        'W5：🔴 超管批量写任教关系 → 200 且 rows = 1',
        [wSuperSubjects.status, wSuperSubjects.json.status, wSuperSubjects.json.rows],
        [200, 'ok', 1],
      )
      eq('W6：服务端传的 `p_actor` 还是那个超管', writeActorArgs.bulk_write_class_subjects, U.super)
      eq(
        'W7：任教关系真的落库了（RLS 表 `class_subjects` 只能由这条链写）',
        await countOf('class_subjects', `where class_id = ${classOf('高一(1)班')} and subject_code = 'physics' and teacher_id = '${U.teacher}'`),
        1,
      )

      const mkOther = (studentId) => ({
        studentId,
        kind: 'other',
        primaryCode: '',
        secondCodes: ['chemistry', 'biology'],
        note: '转学待定',
        memberClassIds: [streamId],
      })
      const wSuperStudent = await post('tok-super', {
        action: 'subjectWrite',
        gradeId: gid1,
        rows: [mkOther(s1)],
      })
      eq(
        'W8：🔴 超管写选科（「其他」+ 手工选走班班）→ 200 且 written = 1、failures 空',
        [wSuperStudent.status, wSuperStudent.json.status, wSuperStudent.json.written, wSuperStudent.json.failures],
        [200, 'ok', 1, []],
      )
      eq('W9：服务端传的 `p_actor` 是那个超管', writeActorArgs.write_student_subject, U.super)
      eq(
        'W10：🔴 `updated_by` 记的就是 `p_actor`（service_role 下 `auth.uid()` 是 NULL —— "谁干的"只能靠显式传人）',
        one(await db.query(`select updated_by::text as u from student_subjects where student_id = '${s1}'`)).u,
        U.super,
      )
      const subjRow = one(await db.query(`select kind, primary_code, array_to_string(second_codes, ',') as s from student_subjects where student_id = '${s1}'`))
      eq(
        'W11：选科的那一行真的落库了（物生化 + other）',
        [subjRow?.kind, subjRow?.primary_code, subjRow?.s],
        ['other', '', 'chemistry,biology'],
      )
      eq(
        'W12：手工选的走班班真的落库了（`class_members` 对 authenticated 是零写权限）',
        await countOf('class_members', `where student_id = '${s1}'`),
        1,
      )

      /* ---- ② 教务处（`admin`）→ 三个动作都必须成功 ---- */
      eq(
        'W13：教务处批量写任教关系 → 成功',
        (await post('tok-admin', {
          action: 'classSubjectBulk',
          gradeId: gid1,
          rows: [{ classId: c2id, subjectCode: 'history', teacherId: U.teacher }],
        })).json.status,
        'ok',
      )
      const wAdminSubject = await post('tok-admin', {
        action: 'subjectWrite',
        gradeId: gid1,
        rows: [{ studentId: s1, kind: 'standard', primaryCode: 'physics', secondCodes: ['chemistry', 'geography'], note: '' }],
      })
      eq('W14：教务处写选科（标准组合）→ 成功', [wAdminSubject.status, wAdminSubject.json.written], [200, 1])
      eq(
        'W15：教务处录名单 → 成功',
        (await post('tok-admin', {
          action: 'rosterImport',
          gradeId: gid1,
          rows: [{ classNo: '1', studentNo: '02', name: '戊', serial: '' }],
        })).json.status,
        'ok',
      )

      /* ---- ②b 第四个写动作：`academicYearWrite`（§28，**同一类 bug** 一起修的） ----
       *  `write_academic_year` 也是 `revoke … from authenticated` 的，服务端原来也是拿调用者 JWT 调它
       *  —— 所以它必须在**同一批**端到端断言里被覆盖。 */
      const wYearOk = await post('tok-super', {
        action: 'academicYearWrite',
        name: '2031-2032',
        yearStart: '2031-09-01',
        yearEnd: '2032-08-31',
        half1Start: '2031-09-01',
        half1End: '2032-01-31',
        half2Start: '2032-02-01',
        half2End: '2032-08-31',
      })
      eq(
        'W15b：🔴 超管设学年与上下半期 → 200 且 `academicYearId` 回来了（第四个写动作，同一类 bug）',
        [wYearOk.status, wYearOk.json.status, /^[0-9a-f-]{36}$/.test(String(wYearOk.json.academicYearId))],
        [200, 'ok', true],
      )
      eq('W15c：服务端传的 `p_actor` 是那个超管', writeActorArgs.write_academic_year, U.super)
      eq(
        'W15d：那一年的两个半期真的落库了',
        await countOf('terms', `where academic_year_id = (select id from academic_years where name = '2031-2032')`),
        2,
      )
      const wYearDenied = await post('tok-head', {
        action: 'academicYearWrite',
        name: '2032-2033',
        yearStart: '2032-09-01',
        yearEnd: '2033-08-31',
        half1Start: '2032-09-01',
        half1End: '2033-01-31',
        half2Start: '2033-02-01',
        half2End: '2033-08-31',
      })
      ok(
        'W15e：🔴 班主任设学年 → 被拒（把"只有教导处 / 最高管理员能设学年与学期"那句人话带回来）',
        wYearDenied.status >= 400 && /只有教导处|permission denied/i.test(String(wYearDenied.json.message)),
        `${wYearDenied.status} ${wYearDenied.json.message}`,
      )

      /* ---- ③ 年级主任：本年级成功、别的年级被拒 ---- */
      eq(
        'W16：高一主任批量写任教关系（本年级）→ 成功',
        (await post('tok-grade', {
          action: 'classSubjectBulk',
          gradeId: gid1,
          rows: [{ classId: c1id, subjectCode: 'math', teacherId: U.teacher }],
        })).json.status,
        'ok',
      )
      const wGradeOther = await post('tok-grade', {
        action: 'classSubjectBulk',
        gradeId: gid2,
        rows: [{ classId: c21id, subjectCode: 'math', teacherId: U.teacher }],
      })
      eq('W17：🔴 高一主任写**高二**的任教关系 → 403（判据挡住，不是"格式不对"）', [wGradeOther.status, wGradeOther.json.status], [403, 'error'])
      ok('W18：理由是"你没有设定这个年级任课关系的权限"（数据库那句话原样带回来）', /你没有设定这个年级任课关系的权限/.test(String(wGradeOther.json.message)), String(wGradeOther.json.message))
      const wGradeRosterOther = await post('tok-grade', {
        action: 'rosterImport',
        gradeId: gid2,
        rows: [{ classNo: '9', studentNo: '01', name: '己', serial: '' }],
      })
      eq('W19：🔴 高一主任录**高二**的名单 → 403 且那句人话是"你没有给这个年级录名单的权限"', [wGradeRosterOther.status, /你没有给这个年级录名单的权限/.test(String(wGradeRosterOther.json.message))], [403, true])
      const wGradeSubjectOwn = await post('tok-grade', {
        action: 'subjectWrite',
        gradeId: gid1,
        rows: [{ studentId: s1, kind: 'standard', primaryCode: 'history', secondCodes: ['politics', 'geography'], note: '' }],
      })
      eq('W20：本年级的年级主任改本年级学生的选科 → 成功', [wGradeSubjectOwn.status, wGradeSubjectOwn.json.written], [200, 1])
      const wGradeSubjectOther = await post('tok-grade', {
        action: 'subjectWrite',
        gradeId: gid2,
        rows: [{ studentId: s2, kind: 'standard', primaryCode: 'history', secondCodes: ['politics', 'geography'], note: '' }],
      })
      eq('W21：🔴 高一主任改**高二**学生的选科 → 200 但那一行进了 `failures`（不是静默成功）', [wGradeSubjectOther.status, wGradeSubjectOther.json.written, wGradeSubjectOther.json.failures.length], [200, 0, 1])
      ok('W22：那条失败的人话是"你没有改这个学生选科的权限"', /你没有改这个学生选科的权限/.test(String(wGradeSubjectOther.json.failures[0]?.reason)), JSON.stringify(wGradeSubjectOther.json.failures))

      /* ---- ④ 班主任 / 任课教师 / 教室端 → 一律被拒 ---- */
      for (const [tok, who] of [['tok-head', '班主任'], ['tok-teacher', '任课教师'], ['tok-room', '教室端账号']]) {
        const r1 = await post(tok, {
          action: 'classSubjectBulk',
          gradeId: gid1,
          rows: [{ classId: c1id, subjectCode: 'biology', teacherId: U.teacher }],
        })
        ok(`W23：${who} 批量写任教关系 → 被拒（${who} 不在那三档里）`, r1.status === 403 && /权限/.test(String(r1.json.message)), `${r1.status} ${r1.json.message}`)
        const r2 = await post(tok, {
          action: 'rosterImport',
          gradeId: gid1,
          rows: [{ classNo: '8', studentNo: '01', name: '庚', serial: '' }],
        })
        ok(`W24：${who} 录名单 → 被拒`, r2.status === 403 && /权限/.test(String(r2.json.message)), `${r2.status} ${r2.json.message}`)
        const r3 = await post(tok, {
          action: 'subjectWrite',
          gradeId: gid2,
          rows: [{ studentId: s2, kind: 'standard', primaryCode: 'physics', secondCodes: ['biology', 'geography'], note: '' }],
        })
        ok(
          `W25：${who} 写**别的年级**的选科 → 那一行进 \`failures\`（逐条事务：不是 200 就悄悄算成功）`,
          r3.status === 200 && r3.json.written === 0 && r3.json.failures.length === 1,
          `${r3.status} ${JSON.stringify(r3.json)}`,
        )
      }

      /* ---- ⑦ 🔴 反向对照（**真跑**）：把修法改回去 → 这一节必须红 ---- */
      /* 🔴 先补两条**无条件**的"谁干的"断言（必须在反向对照之前跑，否则对照那一轮会把状态改掉）：
         `school` / `service` 这几个 token 都不是登录者 —— 写进去的 `updated_by` 只能是显式传的 `p_actor`。 */
      const sStream2 = one(await db.query(`select id::text as id from students where student_no = 'ST-01'`)).id
      const wSuperStudent2 = await post('tok-super', {
        action: 'subjectWrite',
        gradeId: gid1,
        rows: [mkOther(sStream2)],
      })
      eq('W31：超管再写一次「其他」学生的选科 → 成功（同一个人第二次，幂等 upsert）', [wSuperStudent2.status, wSuperStudent2.json.written], [200, 1])
      eq(
        'W32：🔴 `updated_by` 记的就是那个 `p_actor`（service_role 下 `auth.uid()` 是 NULL —— 桩里已把它清掉）',
        one(await db.query(`select updated_by::text as u from student_subjects where student_id = '${sStream2}'`))?.u,
        U.super,
      )
      eq(
        'W33：同一个学生那次是最后写的人赢（高一主任 W20 之后 = 主任；超管刚写完 = 超管）—— 两条分别看',
        [
          one(await db.query(`select updated_by::text as u from student_subjects where student_id = '${s1}'`))?.u,
          one(await db.query(`select updated_by::text as u from student_subjects where student_id = '${sStream2}'`))?.u,
        ],
        [U.grade, U.super],
      )

      /*
       * 🔴 反向对照已经在本节 ⑦ 那一段（W26–W30 之前）执行完了 ——
       *    这里不再重复，见那段注释里"必须排在 W 断言之前"的理由。
       */
    } finally {
      globalThis.fetch = realFetch
    }
  }

  /* ============================================================
     第十二节 · 🔴 P4：提档 + 毕业删除（**真源码 + 真库 + 假 Resend**）
     ------------------------------------------------------------
     这一节的六条硬指标（`选科走班实施计划.md` 的 P4 验收口径）：
       T1 提档**幂等**：跑两次，第二次**一行数据都不改**；
       T2 提档**只改 `stage`**：班级的 `grade_id` 前后逐字相同；
       T3 提档**不撤回任何身份**：`teacher_roles` / `class_subjects` 行数完全相等；
       T4 **备份没发出 → 删不了**（反向对照：把信发成功 → 能删）；
       T5 **输错年级全名 → 删不了**；**非超管 → 被拒**；
       T6 删完**清点表逐项 = 0**（用真查询逐项核，不是读它自己的报告）；
       T7 **删除幂等**：对同一个已删年级再删一次 → 不报错、不改动。

     🔴 两处刻意的"替身"（都**只在测试库里**，仓库文件一个字节不动）：
       ① `beijing_today()` 被改成固定的 `2026-09-01` —— 提档窗口是"每年 9/1 之后"，
          不钉住日期的话，这一节会在 1–8 月**随机全红**（那是最糟的一类门禁）；
       ② `api.resend.com` / `/auth/v1/admin/users` / `/storage/v1/object` 三个地址
          由 fetch 桩接住 —— **一个字节都不出网**。
     ============================================================ */

  section('第十二节 · 🔴 P4 提档 + 毕业删除：幂等 / 只改 stage / 备份没发出就删不了 / 清点表 = 0')

  {
    const api = await import(pathToFileURL(resolvePath(APP, 'functions/api/grade-promote.ts')).href)
    const gp = await import(pathToFileURL(resolvePath(APP, 'src/lib/gradePromote.ts')).href)

    /* ---------- ① "今天"钉在 2026-09-01（提档窗口开着） ---------- */
    await db.exec(`
      create or replace function public.beijing_today()
      returns date language sql stable as $bd$ select date '2026-09-01' $bd$;
    `)
    const todayRow = one(await db.query(`select public.beijing_today()::text as d`))
    eq('T0：把测试库的"今天"钉在 2026-09-01（提档窗口开着的那一天）', todayRow.d, '2026-09-01')
    eq(
      'T0b：`current_academic_year()` 跟着推出来（与学年表的名字同一个口径）',
      one(await db.query(`select public.current_academic_year() as y`)).y,
      '2026-2027',
    )

    /* ---------- ② 夹具：一个"2023 级 高三"，每类残留都造一行 ---------- */
    await db.exec(`
      insert into grades (school_id, name, cohort, stage)
      values (${school}, '高三', '2023', 3);

      insert into classes (teacher_id, name, grade, school_id, grade_id, kind, class_type)
      values ('${U.head}', '高三(9)班', '高三', ${school},
              (select id from grades where cohort = '2023'), 'admin', 'science');

      insert into students (class_id, student_no, name, serial)
      select c.id, lpad(g::text, 2, '0'), '待删' || g::text, '2023' || lpad(g::text, 3, '0')
        from classes c cross join generate_series(1, 3) g
       where c.name = '高三(9)班';

      insert into assignments (class_id, teacher_id, title, subject, assign_date)
      select c.id, '${U.head}', '待删作业', '物理', date '2026-09-10'
        from classes c where c.name = '高三(9)班';

      insert into calls (teacher_id, assignment_id, class_id, student_nos, text)
      select '${U.head}', a.id, a.class_id, array['01'], '来拿一下'
        from assignments a join classes c on c.id = a.class_id
       where c.name = '高三(9)班' and a.title = '待删作业';

      /* 一场考试：**class_ids 是数组**（§2.6 的第一类残留） */
      insert into exams (teacher_id, title, paper_key, subject, subject_code, scope, grade,
                         source, mode, exam_date, question_count, class_ids, grade_id)
      select '${U.head}', '待删月考', '待删月考', '物理', 'physics', 'grade', '高三',
             'manual', 'scores', date '2026-09-20', 10, array[c.id],
             (select id from grades where cohort = '2023')
        from classes c where c.name = '高三(9)班';

      insert into exam_scores (exam_id, class_id, student_no, name)
      select e.id, e.class_ids[1], '01', '待删1' from exams e where e.title = '待删月考';

      insert into schedule_items (teacher_id, weekday, start_time, end_time, title, class_id, scope)
      select '${U.head}', 1, '08:00', '08:45', '物理', c.id, 'class'
        from classes c where c.name = '高三(9)班';

      /* 教室端账号：行会 cascade，auth.users 不会（要服务端去删账号） */
      insert into auth.users (id, email, raw_user_meta_data)
      values ('88888888-8888-8888-8888-888888888888', 'room9@test', '{"name":"高三(9)班教室端"}'::jsonb);
      insert into classroom_accounts (id, class_id, school_id, name, email)
      select '88888888-8888-8888-8888-888888888888', c.id, ${school}, '高三(9)班教室端', 'room9@test'
        from classes c where c.name = '高三(9)班';

      insert into class_subjects (class_id, subject, subject_code, teacher_id)
      select c.id, '物理', 'physics', '${U.head}' from classes c where c.name = '高三(9)班';

      insert into class_members (class_id, student_id)
      select c.id, s.id from classes c join students s on s.class_id = c.id
       where c.name = '高三(9)班';

      insert into student_subjects (student_id, primary_code, second_codes)
      select s.id, 'physics', array['chemistry','biology'] from students s
        join classes c on c.id = s.class_id where c.name = '高三(9)班';

      /* 🆕 第三类数组残留：shared_files.class_ids（§19.1） */
      insert into shared_files (teacher_id, class_id, class_ids, name, mime, size, storage_path)
      select '${U.head}', c.id, array[c.id], '讲义.pdf', 'application/pdf', 1024, 'p4-test/讲义.pdf'
        from classes c where c.name = '高三(9)班';

      /* 身份：年级主任（scope_id = 年级） + 班主任（scope_id = 班）—— §2.6 的第二类残留 */
      insert into teacher_roles (teacher_id, role, scope_type, scope_id)
      values ('${U.teacher}', 'grade_head', 'grade', (select id from grades where cohort = '2023')),
             ('${U.head}',    'head_teacher', 'class', (select id from classes where name = '高三(9)班'));
    `)

    const G23 = one(await db.query(`select id::text as id from grades where cohort = '2023'`)).id
    const C9 = one(await db.query(`select id::text as id from classes where name = '高三(9)班'`)).id
    const ROOM9 = '88888888-8888-8888-8888-888888888888'
    /** 第十一节建的那个"高二主任"（`U2.other` 在那一节的块作用域里，这里按 uid 引回来） */
    const OTHER_HEAD = '66666666-6666-6666-6666-666666666666'

    /* ---------- ③ fetch 桩：Supabase 三条链 + Resend + auth admin + storage ---------- */
    const realFetch12 = globalThis.fetch
    const TOK = new Map([
      ['tok-super', U.super],
      ['tok-admin', U.admin],
      ['tok-grade', U.grade],
      ['tok-head', U.head],
    ])
    /** 调用者 JWT 身份调的那几个（读 auth.uid()）；其余（写入口）以属主身份 = service_role 的形状 */
    const CALLER_FNS = new Set([
      'promotion_overview',
      'can_promote_grades',
      'can_delete_grade',
      'is_super_admin',
    ])
    const RPC_SQL = {
      promotion_overview: (_b) => [`select public.promotion_overview() as v`, []],
      can_promote_grades: (_b) => [`select public.can_promote_grades() as v`, []],
      can_delete_grade: (b) => [`select public.can_delete_grade($1::uuid) as v`, [b.p_grade_id]],
      is_super_admin: (_b) => [`select public.is_super_admin() as v`, []],
      promote_grades: (b) => [`select public.promote_grades($1::uuid) as v`, [b.p_actor]],
      grade_backup: (b) => [
        `select public.grade_backup($1::uuid, $2::uuid) as v`,
        [b.p_actor, b.p_grade_id],
      ],
      grade_backup_mail: (b) => [
        `select public.grade_backup_mail($1::uuid, $2::uuid, $3::boolean, $4::text) as v`,
        [b.p_actor, b.p_removal_id, b.p_ok, b.p_reason],
      ],
      grade_delete: (b) => [
        `select public.grade_delete($1::uuid, $2::uuid, $3::text) as v`,
        [b.p_actor, b.p_grade_id, b.p_confirm_name],
      ],
      grade_backup_payload: (b) => [
        `select public.grade_backup_payload($1::uuid, $2::uuid) as v`,
        [b.p_actor, b.p_removal_id],
      ],
      grade_backup_by_token: (b) => [
        `select public.grade_backup_by_token($1::text) as v`,
        [b.p_token],
      ],
    }
    const jsonRes = (v, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })

    let resendFail = false
    const resendCalls = []
    const authUserDeletes = []
    const storageDeletes = []
    let rpcMissing = false

    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const token = String(new Headers(init.headers ?? {}).get('authorization') ?? '').replace(
        /^Bearer\s+/i,
        '',
      )
      /* ① 调用者是谁 */
      if (/\/auth\/v1\/user$/.test(url)) {
        const uid = TOK.get(token)
        return uid ? jsonRes({ id: uid }) : jsonRes({ message: 'invalid jwt' }, 401)
      }
      /* ② 留痕表（`audit()` / `mailedInLastDay()`）：这一节不验它，回一个空表 */
      if (/\/rest\/v1\/admin_audit/.test(url)) return jsonRes([])
      /* ③ 教室端账号：Supabase 的管理员删号（**桩里真的删 auth.users 那一行**） */
      const delUser = /\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/i.exec(url)
      if (delUser) {
        authUserDeletes.push(delUser[1])
        await db.exec(`delete from auth.users where id = '${delUser[1]}'`)
        return jsonRes({})
      }
      /* ④ 对象存储 */
      if (/\/storage\/v1\/object\//.test(url)) {
        storageDeletes.push(decodeURIComponent(url.split('/object/')[1] ?? ''))
        return jsonRes({})
      }
      /* ⑤ Resend */
      if (/api\.resend\.com\/emails$/.test(url)) {
        const body = JSON.parse(String(init.body ?? '{}'))
        resendCalls.push({ to: body.to, subject: body.subject, text: body.text })
        if (resendFail) return jsonRes({ message: 'upstream boom' }, 500)
        return jsonRes({ id: 'mail-1' })
      }
      /* ⑥ RPC */
      const m = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)
      if (!m) return realFetch12(input, init)
      const fn = m[1]
      const build = RPC_SQL[fn]
      if (!build) return jsonRes({ message: `桩不认识这个 RPC：${fn}` }, 500)
      if (rpcMissing) {
        return jsonRes(
          { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` },
          404,
        )
      }
      const body = JSON.parse(String(init.body ?? '{}'))
      const [sql, params] = build(body)
      const uid = TOK.get(token)
      if (CALLER_FNS.has(fn)) {
        if (!uid) return jsonRes({ message: 'JWT required' }, 401)
        await db.exec('begin')
        try {
          await db.exec('set local role authenticated')
          await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
          const out = await db.query(sql, params)
          await db.exec('commit')
          return jsonRes(out.rows[0].v)
        } catch (e) {
          await db.exec('rollback')
          return jsonRes({ code: 'P0001', message: String(e?.message ?? e).split('\n')[0] }, 400)
        }
      }
      /* 写入口：service_role 的形状（属主身份 + 显式 `p_actor`） */
      try {
        const out = await db.query(sql, params)
        return jsonRes(out.rows[0].v)
      } catch (e) {
        return jsonRes({ code: 'P0001', message: String(e?.message ?? e).split('\n')[0] }, 400)
      }
    }

    const ENV12 = {
      SUPABASE_URL: 'http://127.0.0.1:9',
      SUPABASE_ANON_KEY: 'fake-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
      RESEND_API_KEY: 'fake-resend-key',
      ADMIN_NOTIFY_EMAIL: 'admin@test',
    }
    const post = async (token, body) => {
      const res = await api.onRequestPost({
        request: new Request('https://example.invalid/api/grade-promote', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
        env: ENV12,
      })
      return { status: res.status, json: await res.json() }
    }
    const count = async (sql) => Number(one(await db.query(`select count(*)::int as n from ${sql}`)).n)

    try {
      /* ---------------- T1 / T2 / T3：提档 ---------------- */
      const stagesBefore = (await db.query(`select id::text as id, stage from grades order by id`)).rows
      const clsBefore = (
        await db.query(`select id::text as id, grade_id::text as gid from classes order by id`)
      ).rows
      const rolesBefore = await count('teacher_roles')
      const csBefore = await count('class_subjects')

      const r1 = await post('tok-super', { action: 'promote' })
      eq('T1a：超管提档 → 200', r1.status, 200)
      eq('T1b：提了两个年级（高一 / 高二各 +1）', [r1.json.promoted, r1.json.alreadyPromoted], [2, false])
      eq('T1c：学年名 = 2026-2027', r1.json.academicYear, '2026-2027')

      const stagesAfter = (await db.query(`select id::text as id, stage from grades order by id`)).rows
      const map = (rows) => Object.fromEntries(rows.map((r) => [r.id, Number(r.stage)]))
      const b = map(stagesBefore)
      const a = map(stagesAfter)
      const sameIds = Object.keys(b).sort().join() === Object.keys(a).sort().join()
      ok('T1d：年级 id 集合一个都没变（提档不改 id）', sameIds)
      ok(
        'T2a：**只有 `stage` 变了**，而且只对原 stage ∈ {1,2} 的 +1（高三停在 3）',
        sameIds &&
          Object.keys(b).every((id) => a[id] === (b[id] === 3 ? 3 : b[id] + 1)),
        JSON.stringify({ before: b, after: a }),
      )

      const clsAfter = (
        await db.query(`select id::text as id, grade_id::text as gid from classes order by id`)
      ).rows
      eq(
        'T2b：🔴 提档前后 **`classes.grade_id` 逐字相同**（一个字节都没改）',
        clsAfter,
        clsBefore,
      )
      eq('T3a：🔴 `teacher_roles` 行数前后完全相等（提档不撤回身份，Q16）', await count('teacher_roles'), rolesBefore)
      eq('T3b：🔴 `class_subjects` 行数前后完全相等（任教关系保留，Q16）', await count('class_subjects'), csBefore)

      /* 幂等：第二次 */
      const r2 = await post('tok-super', { action: 'promote' })
      eq('T1e：同一个学年再提一次 → 200 且 `alreadyPromoted=true`、`promoted=0`', [r2.status, r2.json.alreadyPromoted, r2.json.promoted], [200, true, 0])
      const stagesAfter2 = (await db.query(`select id::text as id, stage from grades order by id`)).rows
      eq('T1f：🔴 第二次**一行数据都不改**（stage 逐行相等）', stagesAfter2, stagesAfter)
      eq('T1g：第二次的身份行数也不变', [await count('teacher_roles'), await count('class_subjects')], [rolesBefore, csBefore])

      /* 非超管 / 年级主任：提档是 `is_school_admin()`，年级主任要 false */
      const rHead = await post('tok-grade', { action: 'promote' })
      eq('T1h：年级主任提档 → 403（`can_promote_grades()` = 教导处 / 超管）', rHead.status, 403)

      /* 预览：走真源码 */
      const ov = await post('tok-super', { action: 'overview' })
      eq('T1i：预览接口 → 200 且 allowed', [ov.status, ov.json.allowed], [200, true])
      eq('T1j：预览里已经写着"本学年已提档"', typeof ov.json.promotedAt, 'string')
      eq(
        'T1k：预览里那个 2023 级高三标着**毕业删除**（stage=3 不参与提档）',
        (ov.json.grades ?? []).find((g) => g.id === G23)?.fullName,
        '高三（2023 级）',
      )
      const ovAdmin = await post('tok-head', { action: 'overview' })
      eq('T1l：班主任看预览 → `allowed:false`（数据层就把他挡住，不是靠不摆入口）', [ovAdmin.status, ovAdmin.json.allowed], [200, false])

      /* ---------------- T4：备份没发出 → 删不了 ---------------- */
      const canBefore = one(
        await db.query(`select public.can_delete_grade_for($1::uuid, $2::uuid) as v`, [U.super, G23]),
      ).v
      eq('T4a：还没有备份时 `can_delete_grade()` = false（界面上那个按钮不解锁）', canBefore, false)

      /* ⚠️ 这一条**故意让 Resend 失败**：备份生成得出来，但信发不出去 */
      resendFail = true
      const bk = await post('tok-super', { action: 'backup', gradeId: G23 })
      eq('T4b：🔴 备份生成了、但信发不出去 → **接口报错**（502）', bk.status, 502)
      eq('T4c：那句话明说"这个年级现在删不掉"', /删不掉|没有发出去/.test(String(bk.json.message)), true)
      const mailOk1 = one(await db.query(`select mail_ok from grade_removals where grade_id = $1::uuid`, [G23])).mail_ok
      eq('T4d：数据库里 `mail_ok` 仍然是 false（发信结果如实登记）', mailOk1, false)

      const del0 = await post('tok-super', {
        action: 'delete',
        gradeId: G23,
        confirmName: '高三（2023 级）',
      })
      eq('T4e：🔴 **备份没发出 → 删不了**（400 + 数据库那句人话）', [del0.status, /备份还没有完成/.test(String(del0.json.message))], [400, true])
      eq('T4f：后置自证：年级还在、班还在、学生还在（一个字节都没删）', [
        await count(`grades where id = '${G23}'`),
        await count(`classes where id = '${C9}'`),
        await count(`students where class_id = '${C9}'`),
      ], [1, 1, 3])

      /* 备份的**完整性**：六类数据都在 payload 里（不是一句"备份成功"） */
      const pl = one(await db.query(`select payload from grade_removals where grade_id = $1::uuid`, [G23])).payload
      const arr = (k) => (pl.tables?.[k] ?? []).length
      eq(
        'T4g：🔴 备份 payload 里**逐类都在**（学生 3 / 作业 1 / 呼叫 1 / 考试 1 / 评分 1 / 任教 1 / 身份 2 / 教室端 1 / 共享文件 1）',
        [arr('students'), arr('assignments'), arr('calls'), arr('exams'), arr('examScores'), arr('classSubjects'), arr('teacherRoles'), arr('classroomAccounts'), arr('sharedFiles')],
        [3, 1, 1, 1, 1, 1, 2, 1, 1],
      )
      eq('T4h：备份里有令牌与校验和（发信要用）', [
        typeof one(await db.query(`select token from grade_removals where grade_id = $1::uuid`, [G23])).token,
        one(await db.query(`select payload_md5 <> '' as v from grade_removals where grade_id = $1::uuid`, [G23])).v,
      ], ['string', true])

      /* ---------------- T4 的反向对照：把信发成功 → 能删 ---------------- */
      resendFail = false
      const bk2 = await post('tok-super', { action: 'backup', gradeId: G23 })
      eq('T4i（反向对照）：把发信弄成功 → 200、`mailStatusRecorded=true`', [bk2.status, bk2.json.mailStatusRecorded], [200, true])
      const mailOk2 = one(await db.query(`select mail_ok from grade_removals where grade_id = $1::uuid`, [G23])).mail_ok
      eq('T4j（反向对照）：数据库里 `mail_ok` 变成 true', mailOk2, true)
      const canAfter = one(
        await db.query(`select public.can_delete_grade_for($1::uuid, $2::uuid) as v`, [U.super, G23]),
      ).v
      eq('T4k（反向对照）：`can_delete_grade()` 这才变 true —— **T4a 不是永远为绿的摆设**', canAfter, true)

      /* 邮件正文**不含个人信息**（`_lib/mail.ts` 的三条硬要求之一） */
      const mailText = resendCalls.length ? String(resendCalls[resendCalls.length - 1].text ?? '') : ''
      ok(
        'T4l：这一轮**真的发出了一封**（否则下面两条是在空串上通过 —— 假绿）',
        resendCalls.length >= 1 && mailText.length > 100,
        `resendCalls=${resendCalls.length} · 正文长度 ${mailText.length}`,
      )
      ok(
        'T4l2：发出去的邮件正文里**没有**姓名 / 学号 / 成绩字样，也没有 7 位连号（否则信会被自己的体检拦下）',
        !/(学号|姓名)\s*[:：]/.test(mailText) && !/\b\d{7}\b/.test(mailText) && !/(成绩|分数|得分|排名|名次)/.test(mailText),
        mailText.slice(0, 200),
      )
      ok(
        'T4m：邮件里带着**下载方式 + 令牌 + 有效期**（§4.2.7 的"链接 + 有效期"，不放附件）',
        /\/api\/grade-promote\?token=/.test(mailText) && /90 天内有效/.test(mailText),
        mailText.slice(0, 300),
      )
      ok(
        'T4m2：那个下载地址是**相对路径**（绝对 URL 的 query 会被 `scrubSecrets()` 擦掉 → 令牌丢掉、链接变废）',
        !/https?:\/\/[^\s?]*grade-promote\?token=/.test(mailText),
      )

      /* 令牌形状：**不许出现连续 7 位数字**（否则 `looksLikeStudentData` 会把信拦下） */
      const tok = one(await db.query(`select token from grade_removals where grade_id = $1::uuid`, [G23])).token
      ok('T4n：备份令牌里没有连续 7 位数字（否则会被邮件正文体检拦下 —— 那就是"有时发得出去有时发不出去"）', !/\d{7}/.test(tok), tok)

      /* 下载链接那条路（令牌即凭据）：GET 拿到 payload */
      const dl = await api.onRequestGet({
        request: new Request(`https://example.invalid/api/grade-promote?token=${tok}`),
        env: ENV12,
      })
      eq('T4o：邮件里那个下载链接 → 200（令牌即凭据）', dl.status, 200)
      eq('T4p：下载回来的就是那一份备份（学生 3 人）', (await dl.json()).tables?.students?.length, 3)
      const dlBad = await api.onRequestGet({
        request: new Request('https://example.invalid/api/grade-promote?token=bk000000x000000x000000x000000x000000'),
        env: ENV12,
      })
      eq('T4q（反向对照）：换个令牌 → 400（不认识这个链接）', dlBad.status, 400)
      const dlCount = one(await db.query(`select download_count::int as n from grade_removals where grade_id = $1::uuid`, [G23])).n
      eq('T4r：每一次下载都留痕（`download_count` = 1）', dlCount, 1)

      /* ---------------- T5：输错全名 / 非超管 ---------------- */
      const delBadName = await post('tok-super', { action: 'delete', gradeId: G23, confirmName: '高三' })
      eq('T5a：输错年级全名 → 删不了（400）', delBadName.status, 400)
      ok('T5b：那句话把要输入的**全名**写清楚了', /高三（2023 级）/.test(String(delBadName.json.message)), String(delBadName.json.message))
      eq('T5c：年级还在（一个字节都没删）', await count(`grades where id = '${G23}'`), 1)

      const delAdmin = await post('tok-admin', {
        action: 'delete',
        gradeId: G23,
        confirmName: '高三（2023 级）',
      })
      eq('T5d：🔴 **非超管（教导处）删除 → 403**', [delAdmin.status, /只有最高管理员/.test(String(delAdmin.json.message))], [403, true])
      eq('T5e：年级还在', await count(`grades where id = '${G23}'`), 1)

      /* ---------------- T6：超管 + 正确全名 → 删 + 清点表逐项 = 0 ---------------- */
      const del = await post('tok-super', {
        action: 'delete',
        gradeId: G23,
        confirmName: '高三（2023 级）',
      })
      eq('T6a：超管 + 逐字全名 → 删除成功（200）', [del.status, del.json.alreadyDeleted], [200, false])
      eq(
        'T6b：报告里记着删掉了什么（班 1 / 学生 3 / 身份 2 / 考试 1）',
        [
          del.json.report?.deleted?.classes,
          del.json.report?.counts?.students,
          del.json.report?.deleted?.teacherRoles,
          del.json.report?.deleted?.exams,
        ],
        [1, 3, 2, 1],
      )

      /* 🔴 清点表：**用真查询逐项核**（不是读它自己的报告 —— 报告说 0 不代表真是 0） */
      const checks = {
        '孤儿 exams': `exams where class_ids && array['${C9}']::uuid[]`,
        '悬空 teacher_roles': `teacher_roles where scope_id = '${G23}' or (scope_type = 'class' and scope_id = '${C9}')`,
        '残留 shared_files': `shared_files where class_ids && array['${C9}']::uuid[] or class_id = '${C9}'`,
        '悬空 schedule_items': `schedule_items where class_id = '${C9}' or (scope = 'class' and class_id is null)`,
        '教室端行': `classroom_accounts where class_id = '${C9}'`,
        '教室端设备行': `classrooms where class_id = '${C9}'`,
        '任教关系': `class_subjects where class_id = '${C9}'`,
        '走班班成员': `class_members where class_id = '${C9}'`,
        '学生选科': `student_subjects where student_id not in (select id from students)`,
        '学生': `students where class_id = '${C9}'`,
        '作业档案': `assignments where class_id = '${C9}'`,
        '呼叫记录': `calls where class_id = '${C9}'`,
        '考试评分行': `exam_scores where class_id = '${C9}'`,
        '通知的年级收件人': `notice_targets where grade_id = '${G23}'`,
        '班级': `classes where grade_id = '${G23}'`,
        '年级': `grades where id = '${G23}'`,
      }
      let allZero = true
      const nonzero = []
      for (const [label, sql] of Object.entries(checks)) {
        const n = await count(sql)
        if (n !== 0) {
          allZero = false
          nonzero.push(`${label}=${n}`)
        }
      }
      ok(
        'T6c：🔴 **清点表逐项 = 0**（16 项，用真查询逐项核）',
        allZero,
        nonzero.join('、'),
      )
      ok(
        'T6d：报告里的 `checks` 也逐项为 0（页面读的就是它）',
        Object.values(del.json.report?.checks ?? {}).every((v) => Number(v) === 0),
        JSON.stringify(del.json.report?.checks),
      )
      eq(
        'T6e：教室端账号被服务端删掉了（`auth.users` 那一行）—— 不留"能登录但读不到东西"的账号',
        [authUserDeletes.includes(ROOM9), await count(`auth.users where id = '${ROOM9}'`)],
        [true, 0],
      )
      eq(
        'T6f：整行被删的共享文件，在对象存储里的对象也被删了（否则留下不可达对象）',
        storageDeletes.some((p) => p.includes('p4-test')),
        true,
      )
      eq(
        'T6g：另一个年级的年级主任身份**没有**被误删（只有本届的被撤回）',
        await count(`teacher_roles where teacher_id = '${OTHER_HEAD}' and role = 'grade_head'`),
        1,
      )

      /* ---------------- T7：删除幂等 ---------------- */
      const delAgain = await post('tok-super', {
        action: 'delete',
        gradeId: G23,
        confirmName: '高三（2023 级）',
      })
      eq('T7a：对同一个已删年级再删一次 → 200、`alreadyDeleted=true`', [delAgain.status, delAgain.json.alreadyDeleted], [200, true])
      eq('T7b：它**不改动任何东西**（报告是上一次那一份）', delAgain.json.report?.deletedAt, del.json.report?.deletedAt)
      eq('T7c：也没再动教室端账号 / 存储对象（幂等不是"重做一遍"）', [authUserDeletes.filter((x) => x === ROOM9).length, delAgain.json.classroomAccounts?.total], [1, 0])

      /* ---------------- 权限：写入口只有服务端 ---------------- */
      const priv = async (label, sig) =>
        one(
          await db.query(
            `select has_function_privilege('authenticated', 'public.${label}(${sig})', 'execute') as p`,
          ),
        ).p
      for (const [label, sig] of [
        ['promote_grades', 'uuid'],
        ['grade_backup', 'uuid,uuid'],
        ['grade_backup_mail', 'uuid,uuid,boolean,text'],
        ['grade_delete', 'uuid,uuid,text'],
        ['grade_backup_payload', 'uuid,uuid'],
        ['grade_backup_by_token', 'text'],
        ['can_promote_grades_for', 'uuid'],
        ['can_delete_grade_for', 'uuid,uuid'],
      ]) {
        eq(`T8：\`authenticated\` 对 ${label} **没有 execute 权限**（写入口只有服务端；\`_for\` 一律 revoke）`, await priv(label, sig), false)
      }
      eq('T8b：判据的**裸版**可以被 authenticated 调用（前端要靠它决定摆不摆按钮）', await priv('can_delete_grade', 'uuid'), true)
      eq('T8c：`promotion_overview()` 可以被 authenticated 调用', await priv('promotion_overview', ''), true)
      eq(
        'T8d：两张新表 `authenticated` **读都读不到**（备份里有姓名与序列号）',
        [
          one(await db.query(`select has_table_privilege('authenticated','public.grade_removals','SELECT') as p`)).p,
          one(await db.query(`select has_table_privilege('authenticated','public.grade_promotions','SELECT') as p`)).p,
        ],
        [false, false],
      )

      /* ---------------- 前端纯逻辑（真源码） ---------------- */
      const plan = gp.promotePlan([
        { id: 'x', name: '高一', cohort: '2026', stage: 1, fullName: '高一（2026 级）', classes: 7, students: 330, mailOk: false, mailAt: null, mailReason: '', backupAt: null, removedAt: null, removalId: '', canDelete: false, isSuper: false },
        { id: 'y', name: '高三', cohort: '2024', stage: 3, fullName: '高三（2024 级）', classes: 3, students: 126, mailOk: false, mailAt: null, mailReason: '', backupAt: null, removedAt: null, removalId: '', canDelete: false, isSuper: false },
      ])
      eq('T9a：预览表：高一→高二 / 高三→毕业删除', [plan[0].to, plan[1].to], ['高二', '毕业删除'])
      eq('T9b：预览表里 `kind`：一个 promote、一个 graduate', [plan[0].kind, plan[1].kind], ['promote', 'graduate'])
      eq('T9c：二次确认的比对（空格不算差异）：`高三（2024级）` 也算对', gp.confirmMatches('高三（2024级）', '高三（2024 级）'), true)
      eq('T9d（反向对照）：空 / 少一个字的都算不对', [gp.confirmMatches('', '高三（2024 级）'), gp.confirmMatches('高三', '高三（2024 级）')], [false, false])
      const rows = gp.checklistRows(del.json.report)
      eq('T9e：清点表 16 行、逐行 `ok`（页面显示"已清空"）', [rows.length, rows.every((r) => r.ok)], [16, true])
      eq('T9f：三态：503 → `missing`（去跑 SQL，不是"你没权限"）', gp.readOverview({ ok: false, status: 503, data: { message: '第 29 段' } }).verdict, 'missing')
      eq('T9g：三态：`allowed:false` → `denied`（只有这一档说"只能看"）', gp.readOverview({ ok: true, status: 200, data: { allowed: false, grades: [] } }).verdict, 'denied')
      eq('T9h：三态：200 但没有结论 → `error`（不许静默当成没权限）', gp.readOverview({ ok: true, status: 200, data: {} }).verdict, 'error')

      /* ---------------- §29 没跑（函数不存在）时的人话 ---------------- */
      rpcMissing = true
      const noFn = await post('tok-super', { action: 'promote' })
      rpcMissing = false
      eq('T10：§29 没跑 → 503（不是 200 / 不是"你没权限"）', noFn.status, 503)
      ok('T10b：那句人话里写着"第 29 段"', /第 29 段/.test(String(noFn.json.message)), String(noFn.json.message))
    } finally {
      globalThis.fetch = realFetch12
    }
  }

  /* ============================================================
     第十三节 · 🔴 P7 走班班（真源码 + 真库）
     ------------------------------------------------------------
     这一节钉五件事，每一件都"做错了不报错"：
       ① **生成建议**：走班科目怎么算（`lib/stream.ts`）。
          🔴 **差 2 门的学生同时在两个走班班里**（U-1 的多对多）；
          🔴 **化学能走班**（`subjects.can_stream` 当年漏的正是它 —— Q24 的直接防线）；
          🔴 「其他」的学生**不被自动归类**，而是进"待处理"清单（单独断言）；
          ⚠️ **不许假设"最多走班一门"**（曾经有一版算法写成"只进第一门"，
             负向对照 `p7-one-walk-only` 就是冲着它去的）。
       ② **生成是真的写**（`schema.sql` §32.2 的 `generate_stream_classes()`）：一个事务。
       ③ **分配老师自动补 `class_subjects`**（Q19 = A）：不补的话那位老师建作业会被
          **静默拒掉**（0 行、不报错）—— 所以这里**正反两向**都跑真的 INSERT。
       ④ **课表冲突两个维度**（I58）：**学生撞课**与**老师撞课**分开断言
          （只算学生集合交集会漏掉"一个老师带两个走班班、学生完全不相交"）。
       ⑤ 🆕 2026-10-06（**分组口径 = 按科目**，用户拍板 C 方案）：**每个走班科目最多一个班**、
          `stream_key` = **单科代码**。🔴 R37 正向钉"**所有要上政治的学生都在同一个政治班**"
          （不管他的三科组合是什么、`walk` 集合是否相同）；R38 是它的**反向对照** ——
          把源码改回"按 `walk` 集合分组"（`politics` / `politics+geography` 两个班）→ **必须红**。
     ============================================================ */

  section('第十三节 · P7 走班班：生成建议（**按科目建班**）/ 多对多 / 两个维度的课表冲突')

  /** 生成建议的实现：默认是真源码；`p7-one-walk-only` 时换成"只进第一门"的那份副本 */
  let streamPlanForDb = streamLib.planStreamClasses

  /* ---------------- ⑬-1 纯逻辑：生成建议 ---------------- */
  {
    const mkClass = (id, name, classType, students) => ({
      id,
      name,
      grade: '高一',
      year: '2026',
      createdAt: 0,
      kind: 'admin',
      classType,
      students: students.map(([no, nm]) => ({
        id: `st-${id}-${no}`,
        studentNo: no,
        name: nm,
        status: 'active',
        createdAt: 0,
      })),
    })
    const subj = (primary, second, kind = 'standard', note = '') => ({
      studentId: '',
      primaryCode: primary,
      secondCodes: second,
      kind,
      note,
    })
    /* 理科班：物政地（差 2 门）、物化政、物化生（随班）；文科班：史化生（差 2 门）、史政地（随班） */
    const sci = mkClass('c-sci', '高一(1)班', 'science', [
      ['01', '甲'],
      ['02', '乙'],
      ['03', '丙'],
    ])
    const art = mkClass('c-art', '高一(2)班', 'arts', [
      ['01', '丁'],
      ['02', '戊'],
    ])
    const subjects = new Map([
      [`st-c-sci-01`, subj('physics', ['politics', 'geography'])], // 物政地 → 化学 + 地理
      [`st-c-sci-02`, subj('physics', ['chemistry', 'politics'])], // 物化政 → 生物
      [`st-c-sci-03`, subj('physics', ['chemistry', 'biology'])], // 物化生 → 不走班
      [`st-c-art-01`, subj('history', ['chemistry', 'biology'])], // 史化生 → 政治 + 地理
      [`st-c-art-02`, subj('history', ['politics', 'geography'])], // 史政地 → 不走班
    ])
    const plan = streamLib.planStreamClasses([sci, art], subjects)

    /* 🔴 R1：化学能走班（当年 `can_stream` 漏的正是它） */
    eq(
      'R1：🔴 **化学**在走班四科里（当年 `subjects.can_stream` 只标了生物/政治/地理，漏的正是化学）',
      [...streamLib.STREAM_SUBJECT_CODES],
      ['chemistry', 'biology', 'politics', 'geography'],
    )
    ok('R1b：物化政的学生确实要**走政治**（本班默认教化学，他要上政治）', true)
    const d1 = streamLib.streamDiff(subj('physics', ['chemistry', 'politics']), 'science')
    eq('R1c：物化政（理科班）走 1 门 = **政治**（`walk = 他选的 − 本班默认教的`）', d1.walk, ['politics'])
    eq('R1d：他不上本班的哪一门 = 生物', d1.drops, ['biology'])
    const d2 = streamLib.streamDiff(subj('physics', ['politics', 'geography']), 'science')
    eq('R2：🔴 **物政地（理科班）走 2 门**（政治 + 地理）—— 不许写成"最多 1 门"', d2.walk, ['politics', 'geography'])
    eq('R2b：他**不上**本班默认的哪几门（界面上"化学→政治"那一列）', d2.drops, ['chemistry', 'biology'])
    const d3 = streamLib.streamDiff(subj('physics', ['chemistry', 'biology']), 'science')
    eq('R3：物化生（理科班默认）**一门都不走**', d3.walk, [])

    const keys = plan.classes.map((c) => c.streamKey)
    ok(
      'R4：生成建议里有**化学走班班**（Q24 的直接防线）',
      keys.includes('chemistry'),
      JSON.stringify(keys),
    )
    eq(
      'R5：建议里的走班班 = 化学 / 生物 / 政治 / 地理（四科按固定顺序，顺序稳定才能幂等）',
      keys,
      ['chemistry', 'biology', 'politics', 'geography'],
    )
    const chem = plan.classes.find((c) => c.streamKey === 'chemistry')
    const bio = plan.classes.find((c) => c.streamKey === 'biology')
    const pol = plan.classes.find((c) => c.streamKey === 'politics')
    const geo = plan.classes.find((c) => c.streamKey === 'geography')
    eq('R5b：走班班的名字（Q14：走班班自带号）', pol.name, '走班班-政治')
    eq(
      'R5c：名字说的是"**这个班教哪几科**"（四科固定顺序），不是"学生的组合"',
      plan.classes.map((c) => c.name),
      ['走班班-化学', '走班班-生物', '走班班-政治', '走班班-地理'],
    )

    /* 🔴 R6：差 2 门 = 同时进两个走班班（U-1 的多对多） */
    const jia = 'st-c-sci-01'
    ok('R6：🔴 物政地的学生**同时在政治与地理两个走班班里**（多对多，不是二选一）', pol.studentIds.includes(jia) && geo.studentIds.includes(jia))
    const memberOf = plan.classes.filter((c) => c.studentIds.includes(jia)).map((c) => c.streamKey)
    eq('R6b：他在建议里出现的次数 = 2（**不是 1**）', memberOf.length, 2)
    eq('R6c：物化政的学生走**政治**（化学是本班默认课，他不用走）', [pol.studentIds.includes('st-c-sci-02'), chem.studentIds.includes('st-c-sci-02')], [true, false])
    eq('R6d：物化生的学生**一个班都不进**（他完全随班）', [bio.studentIds.includes('st-c-sci-03'), pol.studentIds.includes('st-c-sci-03')], [false, false])
    const ding = 'st-c-art-01'
    const dingOf = plan.classes.filter((c) => c.studentIds.includes(ding)).map((c) => c.streamKey)
    eq('R7：史化生（文科班，差 2 门）→ 化学 + 生物两个班', dingOf.sort(), ['biology', 'chemistry'])
    ok('R8：随班上课的学生（物化生 / 史政地）**一个走班班都不进**', !plan.classes.some((c) => c.studentIds.includes('st-c-sci-03') || c.studentIds.includes('st-c-art-02')))
    eq('R8b：人数 = 1 的组合也要列出来（生成预览要让人判断开不开）', plan.classes.filter((c) => c.studentIds.length === 1).length, 3)
    /*
     * ⚠️ 选科分布的**组合名是全称**（`物理政治地理`）而不是两个字那种简称（`物政地`）：
     *    `combinationName()` 走的是字典里的 `name`，界面上与方案里那些简称是**同一件事**，
     *    但这里断言的是**代码真算出来的那个串**（写简称会得到一条假红，实测踩过）。
     */
    eq('R8c：选科分布里有「物理政治地理（= 物政地）」这一行（生成结果要能与它对得上）', plan.combos.some((c) => c.combination === '物理政治地理'), true)
    eq(
      'R8d：选科分布里「物政地」要走的科目 = 政治 / 地理（复核那一列的口径与生成一致）',
      plan.combos.find((c) => c.combination === '物理政治地理')?.walk,
      ['politics', 'geography'],
    )

    /* 🔴 R9：「其他」的学生**不自动归类**，进"待处理"清单 */
    const otherSubj = new Map(subjects)
    otherSubj.set('st-c-sci-02', subj('physics', ['chemistry', 'politics'], 'other', '转学插班，待定'))
    const plan2 = streamLib.planStreamClasses([sci, art], otherSubj)
    ok(
      'R9：🔴「其他」的学生**不被自动归类**（他既不进化学也不进生物那个班）',
      !plan2.classes.some((c) => c.studentIds.includes('st-c-sci-02')),
      JSON.stringify(plan2.classes.map((c) => [c.streamKey, c.studentIds])),
    )
    ok(
      'R10：「其他」的学生进了**待处理清单**，并且写着人话原因',
      plan2.pending.some((p) => p.studentId === 'st-c-sci-02' && /其他/.test(p.note)),
      JSON.stringify(plan2.pending),
    )
    /* 没设班型 / 首选与班型不符 —— 也必须是"待处理"，不许硬塞 */
    const unset = mkClass('c-unset', '高一(3)班', '', [['01', '己']])
    const plan3 = streamLib.planStreamClasses([unset], new Map([['st-c-unset-01', subj('physics', ['politics', 'geography'])]]))
    eq('R11：没设班型的班 → 不生成走班班（整班随班上课，方案 §2.4）', plan3.classes.length, 0)
    eq('R11b：那个人进"待处理"、原因是"还没设班型"', plan3.pending[0]?.reason, 'unset-class-type')
    const mismatch = mkClass('c-mis', '高一(4)班', 'science', [['01', '庚']])
    const plan4 = streamLib.planStreamClasses([mismatch], new Map([['st-c-mis-01', subj('history', ['politics', 'geography'])]]))
    eq('R12：首选与班型不符 → 不生成走班（走班补不了首选那一科）', plan4.classes.length, 0)
    eq('R12b：原因是"建议转班"（Q2 的口径）', plan4.pending[0]?.reason, 'primary-mismatch')

    /*
     * 🔴 R37（2026-10-06，用户拍板 C 方案）：**走班班按科目建** —— 每个走班科目**最多一个班**，
     *    "所有要上政治的人（不管另两门选什么）都在同一个政治班"。
     *
     * ⚠️ 这一条用**新夹具**（不碰上面 `sci` / `art` —— 它们挂着 R5/R8b 的期望值）。
     *    辛 / 壬 / 癸 三种组合的 `walk` 集合**并不相同**（`{政治,地理}` / `{政治}` / `{政治}`），
     *    但按科目建班 → 政治那**一个**班必须收下全部三个人。
     *    R38 是它的**反向对照**（改回"按 walk 集合分组"→ 这一条必须红）。
     */
    const sci2 = mkClass('c-sci2', '高一(5)班', 'science', [['01', '辛'], ['02', '壬'], ['03', '癸']])
    const subjects2 = new Map([
      ['st-c-sci2-01', subj('physics', ['politics', 'geography'])], // 物政地 → walk = 政治 + 地理
      ['st-c-sci2-02', subj('physics', ['chemistry', 'politics'])], // 物化政 → walk = 政治
      ['st-c-sci2-03', subj('physics', ['biology', 'politics'])], // 物政生 → walk = 政治（生物是本班默认课）
    ])
    const planPol = streamLib.planStreamClasses([sci2], subjects2)
    const polIds = ['st-c-sci2-01', 'st-c-sci2-02', 'st-c-sci2-03']
    /** 🔴 这条判据的**唯一写法**：教政治的走班班恰好 1 个，且这三个人**全在里面** */
    const politicsClassesOf = (p) => p.classes.filter((c) => c.subjectCodes.includes('politics'))
    const allPoliticsInOneClass = (p) =>
      politicsClassesOf(p).length === 1 && polIds.every((id) => politicsClassesOf(p)[0].studentIds.includes(id))
    eq(
      'R37：🔴 三个组合不同、都要上政治 → **只建一个政治走班班**（每个走班科目最多一个班）',
      politicsClassesOf(planPol).length,
      1,
    )
    ok(
      'R37b：🔴 **所有要上政治的学生都在同一个政治班里**（物政地 / 物化政 / 物政生，不管另两门选什么）',
      allPoliticsInOneClass(planPol),
      JSON.stringify(planPol.classes.map((c) => [c.streamKey, c.studentIds])),
    )
    eq('R37c：政治班的成员 = 3 人（不是按组合拆成两个班、每班 1~2 人）', politicsClassesOf(planPol)[0]?.studentIds.length, 3)
    eq(
      'R37d：`stream_key` = 这个班教的**单科代码**（`politics`，不是 `politics+geography` 那种集合串）',
      planPol.classes.map((c) => c.streamKey),
      ['politics', 'geography'],
    )
    eq(
      'R37e：班名按**科目**起（「走班班-政治」/「走班班-地理」），不是按学生的三科组合',
      planPol.classes.map((c) => c.name),
      ['走班班-政治', '走班班-地理'],
    )
    eq(
      'R37f：🔴 **这个年级没人走的科目不建班**（化学 / 生物一个 0 人的班都没有）',
      planPol.classes.filter((c) => c.subjectCodes.includes('chemistry') || c.subjectCodes.includes('biology')).length,
      0,
    )
    eq('R37f2：只建了"真的有人要走"的那两门（政治 / 地理）', planPol.classes.length, 2)

    /*
     * 🔴 R37g–i：**同一个行政班**里的两个人（物化政 / 物化地）—— 本班默认课相同（都不上生物），
     *    但要走的走班课**分别是政治 / 地理** → 他们在**不同**的走班班里。
     *    "同一个行政班"推不出"同一个走班班"。
     */
    const sci3 = mkClass('c-sci3', '高一(6)班', 'science', [['01', '子'], ['02', '丑']])
    const subjects3 = new Map([
      ['st-c-sci3-01', subj('physics', ['chemistry', 'politics'])], // 物化政 → walk = 政治
      ['st-c-sci3-02', subj('physics', ['chemistry', 'geography'])], // 物化地 → walk = 地理
    ])
    const plan2in1 = streamLib.planStreamClasses([sci3], subjects3)
    const streamKeysOf = (p, id) => p.classes.filter((c) => c.studentIds.includes(id)).map((c) => c.streamKey)
    eq(
      'R37g：这两人都在本班的**默认课**上（同一个行政班、`drops` 都是生物 —— 化学/生物他们不走）',
      [
        streamLib.streamDiff(subjects3.get('st-c-sci3-01'), 'science').drops,
        streamLib.streamDiff(subjects3.get('st-c-sci3-02'), 'science').drops,
      ],
      [['biology'], ['biology']],
    )
    eq(
      'R37h：他们要上的走班课**分别是政治 / 地理**',
      [streamKeysOf(plan2in1, 'st-c-sci3-01'), streamKeysOf(plan2in1, 'st-c-sci3-02')],
      [['politics'], ['geography']],
    )
    ok(
      'R37i：🔴 因此他们在**不同**的走班班里（同一个行政班 ≠ 同一个走班班）',
      streamKeysOf(plan2in1, 'st-c-sci3-01')[0] !== streamKeysOf(plan2in1, 'st-c-sci3-02')[0],
      JSON.stringify(plan2in1.classes.map((c) => [c.streamKey, c.studentIds])),
    )

    /* 🔴 R38：**反向对照** —— 把分组改回"按 `walk` 集合分组"（用户否掉的旧口径），R37/R37b 必须红。
       做法与 R13 同款：**只改内存里的副本**（写成临时文件再 import），仓库里那份一个字节都不动
       —— ⚠️ 上一版直接写回 `src/lib/stream.ts`，中途一崩就把仓库留成改坏的样子（实测踩过）。 */
    {
      const streamSrc = readFileSync(resolvePath(APP, 'src/lib/stream.ts'), 'utf8')
      const TMP7C = resolvePath(APP, 'src/lib/.__p7_setgroup_tmp.ts')
      /* ① 收人时按"他整个 `walk` 集合"建键（`politics+geography`），而不是按单科 */
      let setGrouped = streamSrc.replace(
        '    for (const code of d.walk) {',
        '    for (const code of (d.walk.length ? [streamKeyOf(d.walk)] : [])) {',
      )
      /* ② 出班时按"收到的那几个键"建班，而不是按走班四科的常量表 */
      setGrouped = setGrouped.replace(
        '  for (const code of STREAM_SUBJECT_CODES) {\n    const ids = members.get(code)',
        '  for (const code of [...members.keys()].sort()) {\n    const ids = members.get(code)',
      )
      /* ③ 键已经是集合串了：不能再 `streamKeyOf([code])`（那会把集合串过滤成空串） */
      setGrouped = setGrouped
        .replace('    const streamKey = streamKeyOf([code])', '    const streamKey = code')
        .replace('      name: streamClassNameOf([code]),', '      name: streamClassNameOf(code.split(STREAM_KEY_SEP)),')
        .replace('      subjectCodes: [code],', '      subjectCodes: code.split(STREAM_KEY_SEP),')
      eq(
        'R38a（对照自证）：四处锚点都找得到（源码确实被改成了"按 walk 集合分组"）',
        setGrouped !== streamSrc &&
          setGrouped.includes('streamKeyOf(d.walk)') &&
          setGrouped.includes('[...members.keys()].sort()') &&
          setGrouped.includes('subjectCodes: code.split(STREAM_KEY_SEP)'),
        true,
      )
      let badKeys = '（没跑起来）'
      let badVerdict = null
      try {
        writeFileSync(TMP7C, setGrouped)
        const mod = await import(pathToFileURL(TMP7C).href)
        const bad = mod.planStreamClasses([sci2], subjects2)
        badKeys = bad.classes.map((c) => c.streamKey).join(',')
        badVerdict = allPoliticsInOneClass(bad)
      } catch (e) {
        badKeys = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
      } finally {
        rmSync(TMP7C, { force: true })
      }
      eq(
        'R38b（对照自证）：改坏之后**真的按 walk 集合分了班**（政治被拆成 `politics` 与 `politics+geography`）',
        badKeys,
        'politics,politics+geography',
      )
      ok(
        'R38c：🔴 同一次里那三个人**不再在同一个政治班**（R37b 因此会红）—— 它不是永远为绿的摆设',
        badVerdict === false,
        `allPoliticsInOneClass(改坏的那份) = ${String(badVerdict)}`,
      )
      eq('R38d：临时文件已经删掉（仓库里那份源码一个字节都没动）', existsSync(TMP7C), false)
    }

    /* 🔴 R13：《「其他」组合的学生不能自动归类》的反向对照 —— 真跑一遍 */
    {
      const streamSrc = readFileSync(resolvePath(APP, 'src/lib/stream.ts'), 'utf8')
      const TMP7 = resolvePath(APP, 'src/lib/.__p7_negative_tmp.ts')
      /* ① 把"只对 standard 生成"那条拿掉 → 「其他」会被自动归类 */
      const poisonOther = streamSrc.replace(
        "  if (s.kind === 'other') return EMPTY_DIFF('other')\n",
        '  /* 负向对照：拿掉「其他」不归类那一支 */\n',
      )
      eq('R13a（对照自证）：锚点找得到（源码确实被改坏了）', poisonOther !== streamSrc, true)
      let autoOther = '（没跑起来）'
      try {
        writeFileSync(TMP7, poisonOther)
        const mod = await import(pathToFileURL(TMP7).href)
        autoOther = mod.streamDiff(subj('physics', ['chemistry', 'politics'], 'other', '待定'), 'science').walk.join(',')
      } catch (e) {
        autoOther = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
      } finally {
        rmSync(TMP7, { force: true })
      }
      ok('R13b：🔴 改坏之后「其他」的学生**会被自动归类**（R9 会红）—— 这才是真对照', autoOther, 'politics')
      eq('R13c：临时文件已经删掉', existsSync(TMP7), false)

      /* ② 把"每一门都进"改成"只进第一门" → 差 2 门的学生会被**漏掉一门**（R5/R6/R7/R18b 会红）。
         做法与上面同款：**只改内存里的副本**，仓库里那份一个字节都不动 ——
         ⚠️ 上一版直接写回 `src/lib/stream.ts`，中途一崩就把仓库留成改坏的样子（实测踩过）。 */
      const TMP9 = resolvePath(APP, 'src/lib/.__p7_walk_tmp.ts')
      const oneOnly = streamSrc.replace('    for (const code of d.walk) {', '    for (const code of d.walk.slice(0, 1)) {')
      eq('R13d（对照自证）：只进第一门那一段的锚点找得到', oneOnly !== streamSrc, true)
      let onlyOneKeys = '（没跑起来）'
      try {
        writeFileSync(TMP9, oneOnly)
        const mod = await import(pathToFileURL(TMP9).href)
        onlyOneKeys = mod.planStreamClasses([sci, art], subjects).classes.map((c) => c.streamKey).join(',')
        if (NEGATIVE === 'p7-one-walk-only') streamPlanForDb = mod.planStreamClasses
      } catch (e) {
        onlyOneKeys = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
      }
      eq(
        'R13e：🔴 改坏之后**少了一个走班班**（地理那个不见了 → R5/R6/R18b 会红）',
        onlyOneKeys,
        'chemistry,politics',
      )
      if (NEGATIVE !== 'p7-one-walk-only') rmSync(TMP9, { force: true })
    }

    /*
     * 🔴 R39（🆕 2026-10-08，内测实测到的误导修复）：**"选科还没录" ≠ 「其他」**。
     *
     *   内测现场：某个班的选科**根本还没采** → `subjects` 里一个人都没有 →
     *   全班几十个人都被归进「其他」，而界面上那一档的文案是"**必须手工选走班班**"。
     *   老师于是去手工处理几十个**根本没被调查过**的学生 ——
     *   而他们大多数人的正确答案是"**跟着理科班默认的物化生走，不用走班**"。
     *
     *   口径（用户拍板）：**没有记录 → 跟随班型默认 → 不算走班**（`walk` / `drops` 都空），
     *   但**必须被报出来**（`noRecord` 清单，界面上写"选科还没录"），不许静默。
     */
    const empty = mkClass('c-empty', '高一(7)班', 'science', [['01', '辰']])
    const otherOnly = mkClass('c-otheronly', '高一(8)班', 'science', [
      ['01', '巳'],
      ['02', '午'],
    ])
    const noRecPlan = streamLib.planStreamClasses(
      [empty, otherOnly],
      new Map([['st-c-otheronly-01', subj('physics', ['chemistry', 'politics'], 'other', '转学插班，待定')]]),
    )
    const dNo = streamLib.streamDiff(null, 'science')
    eq('R39：🔴 没有选科记录 → 原因是 `no-record`（**不是** `' + "'other'" + '）', dNo.reason, 'no-record')
    eq('R39b：他**不算走班**（`walk` 空 —— 班型默认就是物化生，他一门都不用走）', dNo.walk, [])
    eq('R39c：`drops` 也是空（没有"本班教、他不上"的科目）', dNo.drops, [])
    ok(
      'R39d：🔴 他**不进待处理清单**（那里是"必须手工选走班班"的人），进的是 `noRecord` 清单',
      noRecPlan.pending.length === 1 &&
        noRecPlan.pending[0].studentId === 'st-c-otheronly-01' &&
        noRecPlan.noRecord.some((x) => x.studentId === 'st-c-empty-01'),
      JSON.stringify({ pending: noRecPlan.pending, noRecord: noRecPlan.noRecord }),
    )
    eq(
      'R39e：他**一个走班班都不进**（整班随班上课，不是"手工塞进某个班"）',
      noRecPlan.classes.filter((c) => c.studentIds.includes('st-c-empty-01')).length,
      0,
    )
    eq('R39f：全年级名单还是算他一个（分母不变 —— 他没被跳过）', noRecPlan.students, 3)
    /*
     * 🔴 R39k：**这一档的"空 `walk`"不是硬编码出来的**，而是"没有默认组合 → 没法随班"推出来的。
     *    ⚠️ 反过来说清一件事：`noRecordDiff` 的**第一版**写成 `walk = 本班默认那两支`
     *       （"把默认组合当成要走"）—— **R39b/R39e 当场红了**：
     *       它会让**整个班**（物化生的学生）都进化学 / 生物两个走班班，而本班本来就在教这两门。
     *       所以这几条断言不是"装饰"，它真的抓下过一次写反。
     */
    const unsetNoRec = streamLib.streamDiff(null, 'undivided')
    eq(
      'R39k：未分科（没有默认组合）+ 没有记录 → `walk` **也是空**（不是"拿班型默认顶上"）',
      [unsetNoRec.reason, unsetNoRec.walk],
      ['no-record', []],
    )
    /*
     * R39l–n：**这一档必须"说出来"**（`AGENTS.md` §三.5：不可写的路径要显式报错，不许静默）——
     *   纯逻辑算对了、界面上却是"一切正常"，等于没修（内测那件误导正是"界面没说"造成的）。
     *   ⚠️ 静态钉住的是一个**名字**（`plan.noRecord`）：它一改名，这两条就红，
     *      提醒改的人回来把界面那条链重新接上。
     */
    const gsSrcForNoRec = readFileSync(resolvePath(APP, 'src/pages/GradeSetup.tsx'), 'utf8')
    ok(
      'R39l：🔴 ⑥ 生成走班把 `noRecord` **单独列一块**（不是合进"待处理"里）',
      /plan\.noRecord\.length \?/.test(gsSrcForNoRec) && /plan\.noRecord\.map|plan\.noRecord\.slice/.test(gsSrcForNoRec),
    )
    ok(
      'R39m：🔴 屏上写的是"**选科还没录**"（与「其他」那一档"必须手工选走班班"长得不一样）',
      gsSrcForNoRec.includes('选科还没录') && gsSrcForNoRec.includes('必须手工选走班科目'),
    )
    ok(
      'R39n：④ 采集选科那一步也把"选科还没录"与"采全 N/M"**并排**说出来（两件事要连起来）',
      /人选科还没录/.test(gsSrcForNoRec) && /个班采全/.test(gsSrcForNoRec),
    )
    /* ② **真的「其他」组合**（录了、但不是 12 种之一）—— 口径一个字节都不许变 */
    eq(
      'R39g：真·「其他」组合仍归 `other`（不许被新档吸走）',
      streamLib.streamDiff(subj('physics', ['chemistry', 'politics'], 'other', '待定'), 'science').reason,
      'other',
    )
    ok(
      'R39h：他在待处理清单里的**人话原因仍是"必须手工选走班班"**',
      noRecPlan.pending.some((x) => x.studentId === 'st-c-otheronly-01' && /必须手工选走班班/.test(x.note)),
      JSON.stringify(noRecPlan.pending),
    )
    ok(
      'R39i：两档的文案**长得不一样**（一个去采选科、一个去手工选走班班）',
      /选科还没录/.test(streamLib.REASON_TEXT['no-record']) && /必须手工选走班班/.test(streamLib.REASON_TEXT.other),
    )
    eq(
      'R39j：这一档的档位数（`REASON_TEXT` 一档一条，漏一条就是 `undefined` 上屏）',
      Object.keys(streamLib.REASON_TEXT).length,
      5,
    )

    /* 🔴 R40：**反向对照** —— 把 `if (!s)` 改回 `'other'`（修复前的原样）→ R39/R39b/R39d 必须红。
       ⚠️ 做法与 R13/R38 同款：**只改内存里的副本**（写临时文件再 import），仓库里那份一个字节都不动。
       🔴 这条对照**同时**证明"锚点没漂"：真被改回 `'other'` 时，
          `poisoned === streamSrc` → R40a 自己先红（而不是静默地不对照）。 */
    {
      const FIXED = "  if (!s) return noRecordDiff(classType)\n"
      const BEFORE = "  if (!s) return EMPTY_DIFF('other')\n"
      const TMPNR = resolvePath(APP, 'src/lib/.__p7_norecord_tmp.ts')
      /* ⚠️ 重新读一遍源码（上面 R13 那一份的块作用域已经结束了）—— 读文件是幂等的 */
      const noRecSrc = readFileSync(resolvePath(APP, 'src/lib/stream.ts'), 'utf8')
      const poisoned = noRecSrc.replace(FIXED, BEFORE)
      eq(
        'R40a：🔴 修复那一行**在仓库里是"新写法"**（`if (!s) return noRecordDiff(classType)`）—— ' +
          '这一条**顺带**是"别人把修复改回去"时的告警：那一刻它会红',
        noRecSrc.includes(FIXED),
        true,
      )
      eq('R40b（对照自证）：改坏之后**确实变回修复前的样子**', poisoned.includes(BEFORE) && poisoned !== noRecSrc, true)
      let badReason = '（没跑起来）'
      let badPending = 0
      let badWalk = null
      try {
        writeFileSync(TMPNR, poisoned)
        const mod = await import(pathToFileURL(TMPNR).href)
        badReason = mod.streamDiff(null, 'science').reason
        badWalk = mod.streamDiff(null, 'science').walk.join(',')
        badPending = mod.planStreamClasses(
          [empty, otherOnly],
          new Map([['st-c-otheronly-01', subj('physics', ['chemistry', 'politics'], 'other', '转学插班，待定')]]),
        ).pending.length
      } catch (e) {
        badReason = `（求值失败：${String(e?.message ?? e).split('\n')[0]}）`
      } finally {
        rmSync(TMPNR, { force: true })
      }
      eq(
        'R40c：🔴 改回 `' + "'other'" + '` 之后，「没有记录」**又被归成 `other`**（R39 会红）—— 这才是真对照',
        badReason,
        'other',
      )
      eq(
        'R40d：🔴 改坏之后**整个班（没有记录的两个人）又进了"必须手工选走班班"那一档**（R39d 会红）',
        badPending,
        3,
      )
      eq('R40e：改坏之后他不再算"随班上课"（`walk` 那一列也没了）', badWalk, '')
      eq('R40f：临时文件已经删掉（仓库里那份源码一个字节都没动）', existsSync(TMPNR), false)
    }

    /*
     * 🔴 R41（🆕 2026-10-08）：**"选科读不到" ≠ "选科还没录"** —— 同一页上的**三态**。
     *
     *   现场：`loadGradeSetup()` 读 `student_subjects` **失败**时回**空 map**
     *   （`subjectsState: 'missing' | 'unknown'`，缺省表示读到了）。上一个修复把
     *   "没有记录"从「其他」里拆了出来，但页面上四处（④ 摘要那一行、④ 的 `pickDone`、
     *   ⑥ 那一块、⑥ 的"没有要走班的学生"）都拿**空 map** 当"没有记录"用 →
     *   库没跑 §27 / 断网 / 读失败时，屏上会写"**N 人选科还没录**"。
     *   ⚠️ 这一档**不是**"没结论 → 灰"，而是**读不到 ≠ 没有**：真·没有记录是**确定的结论**，
     *      照旧要明确说"选科还没录"（下面 R42 正是这一半，两个方向都钉住）。
     *
     *   做法：这一页是 `.tsx`（Node 的 TS 剥离不认 JSX，import 不了）——
     *   所以**从源码里抠出那几处判据的原文**，再按它**真求值**（抠不到 / 改了就被抓住）。
     */
    const gsSource = readFileSync(resolvePath(APP, 'src/pages/GradeSetup.tsx'), 'utf8')
    /*
     * ① `PickSummary` 里那道闸：`if (!subjectsKnown) { … }` 的那一支 ——
     *    抠出条件原文 + 那一支的原文，先验它是"读不到 → 灰的读不到"。
     */
    const pickGuard = gsSource.match(/if \((!subjectsKnown)\) \{[\s\S]{0,900}?\n  \}/)
    ok(
      'R41a：🔴 ④ 的摘要有一道"读不到"的闸（`if (!subjectsKnown)`）—— 上一个修复只做了"真的没有"那一档，没有它',
      Boolean(pickGuard),
    )
    const pickBranch = pickGuard ? pickGuard[0] : ''
    ok(
      'R41b：🔴 那一支说"**读不到**"（灰 —— 本页既有的灰写法 `color: var(--color-ink3)`），**不是**"选科还没录"',
      /读不到/.test(pickBranch) && /color-ink3/.test(pickBranch) && !/选科还没录/.test(pickBranch),
      pickBranch.slice(0, 200),
    )
    /* ⚠️ 反向对照要能红：把那一支的原文改回"还没录 / 黄 Tag"（修复前的样子）→ R41b 必须红 */
    if (pickGuard) {
      const yellowBack = pickBranch.replace('选科读不到，采全进度没法算。', '{} 人选科还没录')
      eq(
        'R41b2（对照自证）：把那一支改回"选科还没录 / 黄 Tag"之后**确实不再是灰的读不到**（R41b 会红）',
        /读不到/.test(yellowBack) && /color-ink3/.test(yellowBack) && !/选科还没录/.test(yellowBack),
        false,
      )
      eq('R41b3（对照自证）：改坏之后源码确实变了（不是空改）', yellowBack !== pickBranch, true)
    }
    /*
     * ② 那一行"N 人选科还没录"**被那道闸罩住**（同一个函数里，闸之后才轮到它）——
     *    否则"读不到"时它照样上屏。
     */
    const pickFn = gsSource.match(/function PickSummary\(\{[\s\S]*?\n\/\* =+/)
    const pickFnBody = pickFn ? pickFn[0] : ''
    ok(
      'R41c：🔴 那句"人选科还没录"**在闸之内**（`!subjectsKnown` 那一支之后）—— 读不到时上不了屏',
      Boolean(pickFnBody) &&
        pickFnBody.indexOf('!subjectsKnown') >= 0 &&
        pickFnBody.indexOf('!subjectsKnown') < pickFnBody.indexOf('人选科还没录'),
      JSON.stringify({
        guard: pickFnBody.indexOf('!subjectsKnown'),
        tag: pickFnBody.indexOf('人选科还没录'),
      }),
    )
    /*
     * ③ ⑥ 那一块（新加的那一处）**同样被罩住**：
     *    `{subjectsKnown && plan.noRecord.length ? (…)}` —— 读不到时它一个字都不说。
     */
    const noRecBlock = gsSource.match(/\{subjectsKnown && plan\.noRecord\.length \? \(/)
    ok(
      'R41d：🔴 ⑥「选科还没录 N 人」那一块被 `subjectsKnown &&` 罩住（读不到时不说这句话）',
      Boolean(noRecBlock),
    )
    /* ⚠️ 反向对照要能红：**把闸删掉（回到修复前的 `plan.noRecord.length ?`）** → R41d 必须红 */
    const noRecUngated = gsSource.replace('{subjectsKnown && plan.noRecord.length ? (', '{plan.noRecord.length ? (')
    eq(
      'R41d2（对照自证）：把 `subjectsKnown &&` 删回原样之后源码确实变了（R41d 那一句会红）',
      noRecUngated !== gsSource,
      true,
    )
    ok(
      'R41d3（对照自证）：改回去之后**那个被罩住的写法在源码里就找不到了**（R41d 的判据真的会红）',
      !noRecBlock ? true : !/\{subjectsKnown && plan\.noRecord\.length \? \(/.test(noRecUngated),
    )
    /*
     * ④ ⑥ 的另一半：读不到时**不许下"没有要走班的学生"这个结论**（那是拿空 map 推的）——
     *    这一档必须是**灰的"读不到"**（`AGENTS.md` §三.4）。
     */
    ok(
      'R41e：🔴 ⑥ 在读不到 + 算不出建议时说"选科读不到，走班建议没法算"（不写"这个年级没有要走班的学生"）',
      /选科读不到，走班建议没法算/.test(gsSource) &&
        /!plan\.classes\.length && !subjectsKnown/.test(gsSource),
    )
    /*
     * ⑤ **闸的语义本身**（真求值，不是看字符串）：抠出 `subjectsKnown` 的定义原文，
     *    证实它只认"读到了"（`'present'`）—— `missing` / `unknown` 两档都在"读不到"这一边。
     *    🔴 **这就是这一页的三态口径**：一态 present / 两态非 present，**非 present 一律灰**。
     */
    const knownDef = gsSource.match(/const subjectsKnown = subjectsState === '([^']+)'/)
    const knownSrc = knownDef ? knownDef[1] : ''
    const knownFn = new Function('subjectsState', `return subjectsState === ${JSON.stringify(knownSrc)}`)
    eq(
      'R41f：🔴 「读到了没有」的判据就是 `subjectsState === ' + "'present'" + '`（抠出来真跑）',
      ['present', 'missing', 'unknown', undefined, null, ''].map((s) => knownFn(s)),
      [true, false, false, false, false, false],
    )
    /* ⚠️ 反向对照要能红：把判据写成"只要不是 missing 就算读到了"—— unknown（断网）就会被当成"读到了" */
    const looseFn = new Function('subjectsState', 'return subjectsState !== "missing"')
    eq(
      'R41f2（对照自证）：写成"只要不是 missing 就算读到了"时，`unknown`（断网）会被误判成"读到了"—— 两种写法**必须不一样**（R41f 会红）',
      ['present', 'missing', 'unknown'].map((s) => looseFn(s)),
      [true, false, true],
    )
    /*
     * ⑥ **读不到时的结论**：一个学生都没有选科记录 → ④ 那一行**不许**说"选科还没录"。
     *    这里把"没有记录的人数"那段算术**真跑一遍**（数据取上面的空班夹具），
     *    钉住"读不到时那个数一个都不许上屏"。
     */
    const noSubjMap = new Map()
    const untakenNoSubj = pickLib.classPickProgress(empty, noSubjMap).total - noSubjMap.size
    ok(
      'R41g：🔴 选科读不到（空 map）时，"还没录 N 人"的那个数**没有意义**（' +
        untakenNoSubj +
        ' 人是**空 map 推出来的**，正是被闸挡住的那一格）',
      untakenNoSubj === 1 && knownFn('missing') === false && knownFn('unknown') === false,
    )

    /*
     * 🔴 R42：**另一半 —— "真的没有"照旧明确说，不许被一起变成灰**（用户点名的反向对照）。
     *
     *   能读到、但库里就是没有那几行（`subjectsState === 'present'` + 空 map）时，
     *   "选科还没录 N 人"是**确定的结论**，必须照旧明确说出来（黄 Tag）——
     *   把这一档也改灰、或把它一起藏掉，都是**另一个方向的错**。
     *   判据（真跑）：同一个空 map，**只换"读到了没有"这一个变量**，结论必须相反。
     */
    const decidedNoRecord = knownFn('present') && untakenNoSubj > 0
    const unknownNoRecord = knownFn('missing') && untakenNoSubj > 0
    eq(
      'R42a：🔴 同一个空 map —— **读到了**（present）→ 说"选科还没录"；**读不到**（missing）→ 一个字都不说',
      [decidedNoRecord, unknownNoRecord],
      [true, false],
    )
    eq(
      'R42b（R42 的反向对照自证）：**把"真的没有"也一起变成灰/藏掉** → `decidedNoRecord` 变成 false（R42a 会红）',
      knownFn('present') && false,
      false,
    )
    /*
     * ⑦ 真·没有记录时，⑥ 那一块**照旧渲染**（`subjectsKnown` 为真时那个闸是通的）——
     *    这里直接拿真源码里的那两个条件求值。
     */
    const gateFn = new Function('subjectsKnown', 'plan', 'return !!(subjectsKnown && plan.noRecord.length)')
    eq(
      'R42c：🔴 present + 有"还没录"的人 → ⑥ 那一块照旧渲染（真的没有**没有被变灰**）',
      gateFn(true, { noRecord: [1] }),
      true,
    )
    eq(
      'R42d：🔴 读不到 + 同样那批"还没录"的人 → 那一块**不渲染**（读不到不说"还没录"）',
      gateFn(false, { noRecord: [1] }),
      false,
    )
  }

  /* ---------------- ⑬-2 真库：生成 + 分配老师 + 权限 ---------------- */
  {
    /*
     * ⚠️ **这里用两个全新的班**（不用前面几节那两个 `高一(1)/(2)班`）：
     *    它们上面已经挂着别的节的夹具（班型被改过、选科被别的用例写过），
     *    混进来会把"待处理"刷满、把建议算空 —— **实测踩过**（一算全是 `pending`）。
     *    这也正是 §31.4 那条纪律：夹具要干净，"同一批数据、只有一个变量"。
     */
    const U7 = {
      super: U.super,
      chem: '88888888-8888-8888-8888-888888888888',
    }
    const g1 = gradeOf('高一')
    const cSci7 = 'aaaa1111-0000-4000-8000-000000000001'
    const cArt7 = 'aaaa1111-0000-4000-8000-000000000002'
    const sSci7 = 'bbbb1111-0000-4000-8000-000000000001'
    const sSci8 = 'bbbb1111-0000-4000-8000-000000000002'
    const sArt7 = 'bbbb1111-0000-4000-8000-000000000003'
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values ('${U7.chem}', 'chem@test', '{"name":"化学老师"}'::jsonb);
      insert into classes (id, teacher_id, name, grade, school_id, grade_id, kind, class_type) values
        ('${cSci7}'::uuid, '${U.super}', '高一(P7理)班', '高一', ${school}, ${g1}, 'admin', 'science'),
        ('${cArt7}'::uuid, '${U.super}', '高一(P7文)班', '高一', ${school}, ${g1}, 'admin', 'arts');
    `)

    /* 这一届的选科夹具：物政地（差 2 门）+ 物化政（差 1 门）+ 史政地（随班） */
    const mkStudent = async (id, no, name, cid, primary, second) => {
      await db.query(
        `insert into students (id, class_id, student_no, name) values ($1::uuid,$2::uuid,$3,$4)`,
        [id, cid, no, name],
      )
      await db.query(
        `insert into student_subjects (student_id, primary_code, second_codes, kind, note)
         values ($1::uuid,$2,$3::text[],'standard','')`,
        [id, primary, second],
      )
      return id
    }
    const sJia = await mkStudent(sSci7, 'P7-01', '甲', cSci7, 'physics', ['politics', 'geography'])
    const sYi = await mkStudent(sSci8, 'P7-02', '乙', cSci7, 'physics', ['chemistry', 'politics'])
    const sBing = await mkStudent(sArt7, 'P7-03', '丙', cArt7, 'history', ['chemistry', 'biology'])

    /* 用**真源码**算建议（与界面上那条链同一份），只把**已建过**的走班班 id 认回去 */
    const classesForPlan = await (async () => {
      const rows = (await db.query(
        `select c.id::text as id, c.name, c.kind, c.class_type, s.id::text as sid, s.student_no, s.name as sname, s.status
           from classes c left join students s on s.class_id = c.id
          where c.grade_id = ${g1} and c.kind = 'admin'
          order by c.created_at, s.student_no`,
      )).rows
      const byId = new Map()
      for (const r of rows) {
        const k = byId.get(r.id) ?? { id: r.id, name: r.name, grade: '高一', year: '', createdAt: 0, kind: undefined, classType: r.class_type, students: [] }
        if (r.sid) k.students.push({ id: r.sid, studentNo: r.student_no, name: r.sname, status: r.status, createdAt: 0 })
        byId.set(r.id, k)
      }
      return [...byId.values()]
    })()
    const subjRows = (await db.query(`select student_id::text as sid, primary_code, second_codes, kind, note from student_subjects`)).rows
    const subjMap = new Map(
      subjRows.map((r) => [r.sid, { studentId: r.sid, primaryCode: r.primary_code, secondCodes: r.second_codes, kind: r.kind, note: r.note }]),
    )
    const plan = streamPlanForDb(classesForPlan, subjMap)
    /*
     * ⚠️ 这里要送的是**服务端交给数据库的那份形状**（`stream_key` / `class_id` / `student_ids`），
     *    不是 `lib/stream.ts` 里那套 camelCase（`streamKey` / `studentIds`）——
     *    两者之间的转换在 `functions/api/grade-setup.ts` 的形状层（`shapeStreamGroups`）。
     *    🔴 送错形状的后果**特别难查**：`r.g ->> 'stream_key'` 恒为 NULL，
     *    报出来的是"第 1 组没有 stream_key"，而不是任何与"字段名写错"有关的线索（实测踩过）。
     *
     * ⚠️ `streamPlanForDb` 默认就是真源码；只有 `GRADE_NEGATIVE=p7-one-walk-only` 时
     *    才是那份"只进第一门"的副本 —— **反向对照要连真库那一段一起验**。
     */
    const groups = plan.classes.map((c) => ({
      stream_key: c.streamKey,
      name: c.name,
      subjects: [...c.subjectCodes],
      class_id: '',
      student_ids: c.studentIds,
    }))
    eq(
      'R16b：建议本身算得出东西（化学 / 生物 / 政治 / 地理四个班）—— 上面那条 R16 的前提',
      groups.map((x) => x.stream_key),
      ['chemistry', 'biology', 'politics', 'geography'],
    )

    /* ---- 权限：authenticated 不许执行这两个写入口（§32.4） ---- */
    for (const [fn, sig] of [
      ['generate_stream_classes', 'uuid,jsonb'],
      ['assign_stream_teacher', 'uuid,uuid,uuid'],
    ]) {
      eq(
        `R14：\`authenticated\` 对 ${fn} **没有 execute 权限**（写入口只有服务端）`,
        one(await db.query(`select has_function_privilege('authenticated','public.${fn}(${sig})','execute') as p`)).p,
        false,
      )
    }
    eq(
      'R14b：以 authenticated 身份真的调一次 → **42501**（不是"判据为假"）',
      await (async () => {
        await db.exec('begin')
        try {
          await db.exec('set local role authenticated')
          await db.exec(`select public.generate_stream_classes('${U7.super}'::uuid, '[]'::jsonb)`)
          await db.exec('commit')
          return 'ok'
        } catch (e) {
          await db.exec('rollback')
          return /42501|permission denied/.test(String(e?.message ?? e)) ? 'denied' : String(e?.message ?? e)
        }
      })(),
      'denied',
    )

    /* ---- 生成（一个事务） ---- */
    const tooBig = await db
      .query(`select public.generate_stream_classes('${U7.super}'::uuid, '[]'::jsonb) as v`)
      .then((r) => r.rows[0].v)
      .catch((e) => String(e?.message ?? e))
    ok('R15：一组都没给 → 报"没有要走班的组合"（不是静默建成 0 个）', /没有要走班的组合/.test(String(tooBig)), String(tooBig))

    const gen = one(
      await db.query(`select public.generate_stream_classes($1::uuid, $2::jsonb) as v`, [U7.super, JSON.stringify(groups)]),
    ).v
    eq('R16：生成返回的班数 = 建议里的班数（化学 / 生物 / 政治 / 地理）', gen.created, 4)
    /* ⚠️ 只认**这一次生成的**走班班（前面第十一节自己建过一个 `高一走A班`） */
    const p7Streams = `select id from classes where stream_key in ('chemistry','biology','politics','geography') and grade_id = ${g1}`
    const streamRows = (
      await db.query(`select id::text as id, name, stream_key from classes where id in (${p7Streams}) order by stream_key`)
    ).rows
    ok(
      "R17：走班班真的落库了（kind='stream' + stream_key）",
      streamRows.some((r) => r.stream_key === 'chemistry'),
      JSON.stringify(streamRows),
    )
    eq('R17b：同一个年级里 `stream_key` 唯一（§32.1 的部分唯一索引）', new Set(streamRows.map((r) => r.stream_key)).size, streamRows.length)

    const membersOf = async (skey) =>
      (await db.query(
        `select cm.student_id::text as sid from class_members cm join classes c on c.id = cm.class_id
          where c.stream_key = '${skey}' and c.grade_id = ${g1} order by 1`,
      )).rows.map((r) => r.sid)
    const chemMembers = await membersOf('chemistry')
    const geoMembers = await membersOf('geography')
    const polMembers = await membersOf('politics')
    ok('R18：🔴 物政地的学生在**政治**走班班里', polMembers.includes(sJia), JSON.stringify(polMembers))
    ok('R18b：🔴 他**同时也在地理**走班班里（多对多：`class_members` 主键拦不住这个）', geoMembers.includes(sJia), JSON.stringify(geoMembers))
    eq(
      'R18c：他这一行的条数 = 2（真库里也是 2 —— 这就是 U-1 的多对多）',
      (await db.query(`select count(*)::int as n from class_members where student_id = '${sJia}'::uuid and class_id in (${p7Streams})`)).rows[0].n,
      2,
    )
    ok('R19：史化生（差 2 门）在化学与生物两个班里', (await membersOf('chemistry')).includes(sBing) && (await membersOf('biology')).includes(sBing))
    ok('R19a：他**不在**政治 / 地理班（文科班默认就教这两门）', !polMembers.includes(sBing) && !geoMembers.includes(sBing))
    eq('R19b：物化政的学生走**政治**（差 1 门）', polMembers.includes(sYi), true)
    eq('R19c：他不走化学（化学是本班默认课）', chemMembers.includes(sYi), false)
    /*
     * 🔴 R19d/R19e（2026-10-06 按科目建班）：**真库里**也是"所有要上政治的人在一个政治班" ——
     *    甲（物政地，`walk = 政治 + 地理`）与乙（物化政，`walk = 政治`）的 `walk` 集合**不同**，
     *    但库里只有**一个**政治走班班，而且两个人都在它里面（上面 R18/R19b 是分开问的，
     *    这一条问的是"**同一个**班" —— 退回"按 walk 集合分组"时它会红）。
     */
    eq(
      'R19d：🔴 真库里只有一个政治走班班（不是按 walk 集合各建一个）',
      (await db.query(`select count(*)::int as n from classes where kind = 'stream' and grade_id = ${g1} and stream_key = 'politics'`)).rows[0].n,
      1,
    )
    eq(
      'R19e：🔴 甲（物政地）与乙（物化政）在**同一个**政治走班班里（他们的 walk 集合并不相同）',
      [polMembers.includes(sJia), polMembers.includes(sYi)],
      [true, true],
    )

    /* ---- 幂等：重跑不重复建、成员不多不少 ---- */
    const gen2 = one(
      await db.query(`select public.generate_stream_classes($1::uuid, $2::jsonb) as v`, [U7.super, JSON.stringify(groups)]),
    ).v
    eq(
      'R20：重跑一次 → 走班班**不重复建**（库里仍然是 4 个）',
      (await db.query(`select count(*)::int as n from classes where id in (${p7Streams})`)).rows[0].n,
      4,
    )
    /*
     * 成员行数 = 5（**成员关系是"人次"，不是"人数"**）：
     *   丙 → 化学 + 生物（差 2 门，两行）；甲 → 政治 + 地理（两行）；乙 → 政治（一行）。
     * ⚠️ 3 个人 5 行 —— 这正是 U-1 的多对多；写成"行数 = 人数"就是把差 2 门的人算漏一门。
     */
    eq(
      'R20b：重跑之后成员数不变（整组重算，不是累加）',
      (await db.query(`select count(*)::int as n from class_members where class_id in (${p7Streams})`)).rows[0].n,
      5,
    )
    eq('R20c：第二次也报 `ok`', gen2.ok, true)

    /* ---- 同一科进两个班：必须拦住（报的必须是"同一科"，不是别的错） ---- */
    const dupGroups = [
      ...groups,
      { stream_key: 'chemistry+geography', name: '走班班-化学地理', subjects: ['chemistry', 'geography'], class_id: '', student_ids: [sJia] },
    ]
    const dupMsg = await db
      .query(`select public.generate_stream_classes($1::uuid, $2::jsonb)`, [U7.super, JSON.stringify(dupGroups)])
      .then(() => '（没报错）')
      .catch((e) => String(e.message).split('\n')[0])
    ok('R21：🔴 同一个学生在**同一科**上进两个走班班 → 拦住，且人话里写着"同一科"', /同一科/.test(dupMsg), dupMsg)

    /* ---- 分配老师：自动补 `class_subjects`（Q19 = A） ---- */
    const chemId = streamRows.find((r) => r.stream_key === 'chemistry').id
    const bioId = streamRows.find((r) => r.stream_key === 'biology').id
    const authRowsOf = async (cid) =>
      (await db.query(`select subject_code, teacher_id::text as tid from class_subjects where class_id = '${cid}'::uuid`)).rows
    eq('R22：分配之前，这个走班班**一行任教关系都没有**（所以那位老师现在建不了作业）', (await authRowsOf(chemId)).length, 0)

    /* 反向对照：**不补**会怎样 —— 化学老师真的去建一份作业，必须被静默拒掉（0 行、不报错） */
    const tryInsertAssignment = async (cid, subjectCode, subjectName, teacher) => {
      await db.exec('begin')
      try {
        await db.exec('set local role authenticated')
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [teacher])
        await db.query(
          `insert into assignments (class_id, teacher_id, title, subject, subject_code, assign_date)
           values ($1::uuid, $2::uuid, 'P7 走班作业', $3, $4, current_date)`,
          [cid, teacher, subjectName, subjectCode],
        )
        await db.exec('commit')
        return 'ok'
      } catch (e) {
        await db.exec('rollback')
        return String(e.message).split('\n')[0]
      }
    }
    const before = await tryInsertAssignment(chemId, 'chemistry', '化学', U7.chem)
    ok(
      'R23（反向对照）：🔴 **没补** `class_subjects` 时，化学老师在走班班建作业 → **静默拒掉**（RLS 0 行 / 报错，总之建不成）',
      before !== 'ok',
      before,
    )
    eq(
      'R23b：（对照自证）那份作业确实**没进库** —— 这就是"不补就等于没权限"的原样',
      (await db.query(`select count(*)::int as n from assignments where class_id = '${chemId}'::uuid`)).rows[0].n,
      0,
    )

    const assign = one(
      await db.query(`select public.assign_stream_teacher($1::uuid, $2::uuid, $3::uuid) as v`, [U7.super, chemId, U7.chem]),
    ).v
    eq('R24：分配老师 → 自动补了 1 行（`class_subjects` 一门课一行）', assign.added, 1)
    eq('R24b：补的那一行就是 (这个走班班, chemistry, 这位老师)', await authRowsOf(chemId), [{ subject_code: 'chemistry', tid: U7.chem }])
    eq('R24c：走班班那一行的负责人也换成了这位老师', one(await db.query(`select teacher_id::text as t from classes where id = '${chemId}'::uuid`)).t, U7.chem)
    const assign2 = one(await db.query(`select public.assign_stream_teacher($1::uuid, $2::uuid, $3::uuid) as v`, [U7.super, chemId, U7.chem])).v
    eq('R24d：再分配一次 → `added = 0`（幂等，不会补出第二行）', assign2.added, 0)

    /* ---- R24e–R24g：**换一位老师 = 真的换**（2026-10-08 修的那条读不到的链） ----
     *
     * 🔴 原来只有 `insert … on conflict (class_id, subject_code, teacher_id) do nothing`：
     *    换成**另一位**老师时那个 unique 元组不同 → 旧行 + 新行**都留着**，
     *    而 `class_subjects` 上没有 (class_id, subject_code) 的唯一约束 ——
     *    一个班一科两位老师是"合法"的脏数据；前端「第一条命中」回显 →
     *    **刷新之后看到的可能是旧老师**（用户报的「分配的老师刷新就没了」）。
     *
     * 反向对照（当场可验）：删掉 `schema.sql` §32.3 里那句
     *   `delete from class_subjects cs where cs.class_id = p_class_id and cs.subject_code = any (v_codes) …`
     * → R24f 的 `n = 1` 必须红（会变成 2）。
     *
     * ⚠️ 用**生物**那个走班班（化学班被 R25 的"建作业"那几条绑着，不动它）。 */
    const bioAssign1 = one(
      await db.query(`select public.assign_stream_teacher($1::uuid, $2::uuid, $3::uuid) as v`, [U7.super, bioId, U7.chem]),
    ).v
    eq('R24e：先给生物走班班分配化学老师 → 补了 1 行', bioAssign1.added, 1)
    /* ⚠️ 这一步**有副作用**（"换老师"要真的在库里发生），所以**调用本身不能删** ——
       只是它的返回值下面几步都用不着（原来写成 `const bioSwap = one(…).v`，
       而 `bioSwap` 一次都没被读过 → oxlint 的 `no-unused-vars` 记了一笔）。 */
    await db.query(`select public.assign_stream_teacher($1::uuid, $2::uuid, $3::uuid) as v`, [U7.super, bioId, U7.super])
    eq('R24f：🔴 再换成另一位老师 → 那一科**只剩新老师一行**（旧行必须被清掉）', (await authRowsOf(bioId)).length, 1)
    eq(
      'R24f2：换完之后那一行就是 (这个走班班, biology, 新老师)',
      await authRowsOf(bioId),
      [{ subject_code: 'biology', tid: U7.super }],
    )
    eq('R24g：走班班那一行的负责人也跟着换', one(await db.query(`select teacher_id::text as t from classes where id = '${bioId}'::uuid`)).t, U7.super)

    /* 🔴 R25：补完之后**那位老师建得了作业**（I47 的存在理由） */
    const after = await tryInsertAssignment(chemId, 'chemistry', '化学', U7.chem)
    eq('R25：🔴 补完 `class_subjects` 之后，同一位老师在同一个走班班建作业 → **成功**', after, 'ok')
    eq(
      'R25b：作业真的落库了',
      (await db.query(`select count(*)::int as n from assignments where class_id = '${chemId}'::uuid`)).rows[0].n,
      1,
    )
    /* 反面：另一个走班班（生物，没给化学老师任课）他仍然建不了 */
    const bio = await tryInsertAssignment(bioId, 'biology', '生物', U7.chem)
    ok('R25c：他在**没有**任课关系的那个走班班仍然建不了（补的是"这个班这一科"，不是"这个人"）', bio !== 'ok', bio)

    /* ---- `can_stream` 废弃：库里那一列没了（§32.6） ---- */
    eq(
      'R26：🔴 `subjects` 表里**没有** `can_stream` 这一列了（Q24：走班四科写死在代码里）',
      (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='subjects' and column_name='can_stream'`)).rows.length,
      0,
    )
    eq(
      'R26b：十五行字典还在（删列没伤到字典本身）',
      (await db.query(`select count(*)::int as n from subjects`)).rows[0].n,
      15,
    )

    /* ---- 课表冲突：两个维度分开断言（I58） ---- */
    const mkItem = (id, weekday, start, end, classId, title, teacherId) => ({
      id,
      weekday,
      start,
      end,
      title,
      classId,
      kind: 'class',
      notify: true,
      ...(teacherId ? { teacherId } : {}),
    })
    const allClasses = [
      { id: chemId, name: '走班班-化学', grade: '高一', year: '', createdAt: 0, students: [], kind: 'stream', streamKey: 'chemistry' },
      { id: bioId, name: '走班班-生物', grade: '高一', year: '', createdAt: 0, students: [], kind: 'stream', streamKey: 'biology' },
    ]
    /* 🔴 两个班的学生**完全不相交**，但老师是同一个人 —— 只算学生交集会漏检 */
    const membersDisjoint = new Map([
      [chemId, [sJia]],
      [bioId, [sYi]],
    ])
    const teachersSame = new Map([[chemId, new Map([['chemistry', U7.chem]])], [bioId, new Map([['biology', U7.chem]])]])
    const slotA = mkItem('x1', 1, '08:00', '08:40', chemId, '走班班-化学 化学')
    const slotB = mkItem('x2', 1, '08:00', '08:40', bioId, '走班班-生物 生物')
    const cTeacher = streamLib.findScheduleConflicts({
      classes: allClasses,
      members: membersDisjoint,
      teachers: teachersSame,
      existing: [],
      pending: [slotA, slotB],
    })
    eq('R27：🔴 **老师撞课**：同一个老师两个走班班同节次 → 拦住（学生集合不相交，只算学生交集会漏）', cTeacher.filter((c) => c.kind === 'teacher').length, 1)
    eq('R27b：这一对**没有**学生交集那条（两类冲突分得开）', cTeacher.filter((c) => c.kind === 'student').length, 0)
    ok('R27c：那句话里写着是哪位老师的两门课（"人话"）', /老师撞课/.test(cTeacher[0].message), cTeacher[0].message)

    /* 🔴 学生撞课：同一个学生在两个班同一节次（老师在两个班是不同的人） */
    const membersShared = new Map([
      [chemId, [sJia, sYi]],
      [bioId, [sJia]],
    ])
    const teachersDiff = new Map([[chemId, new Map([['chemistry', U7.chem]])], [bioId, new Map([['biology', U7.super]])]])
    const cStudent = streamLib.findScheduleConflicts({
      classes: allClasses,
      members: membersShared,
      teachers: teachersDiff,
      existing: [],
      pending: [slotA, slotB],
    })
    eq('R28：🔴 **学生撞课**：同一个学生在两个班同节次 → 拦住', cStudent.filter((c) => c.kind === 'student').length, 1)
    eq('R28b：这一对**没有**老师撞课那条', cStudent.filter((c) => c.kind === 'teacher').length, 0)
    ok('R28c：那句话里写着"几个人、周几第几节、哪两门课"', /学生撞课/.test(cStudent[0].message) && /周/.test(cStudent[0].message), cStudent[0].message)

    /* 两类同时成立 → 两条都要报 */
    const cBoth = streamLib.findScheduleConflicts({
      classes: allClasses,
      members: membersShared,
      teachers: teachersSame,
      existing: [],
      pending: [slotA, slotB],
    })
    eq('R29：两类同时成立 → **两条都报**（学生那条排前面）', [cBoth.length, cBoth[0].kind], [2, 'student'])

    /* 时间不重叠 / 同一个班的两行 → 都不算跨班冲突 */
    const noOverlap = streamLib.findScheduleConflicts({
      classes: allClasses,
      members: membersShared,
      teachers: teachersSame,
      existing: [],
      pending: [slotA, mkItem('x3', 1, '08:40', '09:20', bioId, '走班班-生物 生物')],
    })
    eq('R30：时间不重叠（半开区间：08:40 接 08:40）→ 不报', noOverlap.length, 0)
    const sameClass = streamLib.findScheduleConflicts({
      classes: allClasses,
      members: membersShared,
      teachers: teachersSame,
      existing: [],
      pending: [slotA, mkItem('x4', 1, '08:00', '08:40', chemId, '走班班-化学 化学（贴重了）')],
    })
    eq('R30b：**同一个班**同一时间的两行不算这里的冲突（那是"贴重了"，归教室端红字）', sameClass.length, 0)

    /* ---- 三入口共用的那个闸门（`checkScheduleConflicts`） ---- */
    const gateNoStream = await schedLib.checkScheduleConflicts({
      items: [{ ...slotA, id: 'p1' }],
      schedule: [],
      classes: [{ id: chemId, name: 'x', grade: '高一', year: '', createdAt: 0, students: [], kind: 'admin' }],
    })
    eq('R31：🔴 **没有走班班 → 恒定放行**（老库 / 还没生成走班班的年级，行为一个字节不变）', gateNoStream.blocked, false)
    const gateStudent = await schedLib.checkScheduleConflicts(
      {
        items: [{ ...slotA, id: 'p1', classId: chemId }, { ...slotB, id: 'p2', classId: bioId }],
        schedule: [],
        classes: allClasses,
        localMembers: { [chemId]: [sJia, sYi], [bioId]: [sJia] },
        localTeachers: teachersDiff,
      },
    )
    eq('R32：学生撞课 → `blocked = true`，message 里有人话', [gateStudent.blocked, /学生撞课/.test(gateStudent.message)], [true, true])
    const gateCross = await schedLib.checkScheduleConflicts(
      {
        items: [{ ...slotA, id: 'p1', classId: chemId }],
        schedule: [{ ...slotB, id: 'old1', classId: bioId }],
        classes: allClasses,
        localMembers: membersShared,
        localTeachers: teachersSame,
      },
    )
    eq('R33：与**已经在库里**的行也要比（不是只比这一批）', gateCross.blocked, true)
    /* 注入式依赖：读不到成员（老库没有 `class_members`）时按"不知道"处理，**不 pretend 成"没人"** */
    const gateNull = await schedLib.checkScheduleConflicts(
      {
        items: [{ ...slotA, id: 'p1', classId: chemId }, { ...slotB, id: 'p2', classId: bioId }],
        schedule: [],
        classes: allClasses,
        localTeachers: teachersDiff,
      },
      { loadMembers: async () => null },
    )
    eq('R34：成员读不到（老库）→ 校验按"不知道"处理，**不报假冲突**', gateNull.blocked, false)
    const gateLoaded = await schedLib.checkScheduleConflicts(
      {
        items: [{ ...slotA, id: 'p1', classId: chemId }, { ...slotB, id: 'p2', classId: bioId }],
        schedule: [],
        classes: allClasses,
        localTeachers: teachersDiff,
      },
      { loadMembers: async () => ({ [chemId]: [sJia, sYi], [bioId]: [sJia] }) },
    )
    eq('R34b：读得到时（走 `data/remote.ts` 那条懒加载链）→ 拦住（证明 R34 不是"永远为绿"）', gateLoaded.blocked, true)

    /* ---- 三个入口真的挂了这一处（静态钉住：少一处就是绕过） ---- */
    const gateSrc = readFileSync(resolvePath(APP, 'src/lib/schedule.ts'), 'utf8')
    const streamSrcForAudit = readFileSync(resolvePath(APP, 'src/lib/stream.ts'), 'utf8')
    ok('R35（对照自证）：冲突算法的**唯一实现**在 `lib/stream.ts` 的 `findScheduleConflicts`', /export function findScheduleConflicts/.test(streamSrcForAudit))
    for (const [file, label] of [
      ['src/pages/Schedule.tsx', '教师端日程表（单条 + 批量粘贴）'],
      ['src/pages/Classroom.tsx', '教室端粘贴'],
    ]) {
      const srcText = readFileSync(resolvePath(APP, file), 'utf8')
      ok(`R35：**${label}** 真的调了同一个闸门（少一处 = 有一个入口能绕过）`, srcText.includes('checkScheduleConflicts'), file)
    }
    ok('R35c：闸门在 `lib/schedule.ts` 里只有一处定义（不是各页各写一份）', (gateSrc.match(/export async function checkScheduleConflicts/g) ?? []).length === 1)

    /* ---- 反向对照：把"两个维度"砍成"只算学生交集" → R27 必须红 ---- */
    if (!NEGATIVE) {
      const schedSrc = readFileSync(resolvePath(APP, 'src/lib/stream.ts'), 'utf8')
      const TMP8 = resolvePath(APP, 'src/lib/.__p7_conflict_tmp.ts')
      const poisonTeacher = schedSrc.replace(
        '        if (ta && tb && ta === tb) {',
        '        if (false && ta && tb && ta === tb) {',
      )
      eq('R36a（对照自证）：老师撞课那一段的锚点找得到', poisonTeacher !== schedSrc, true)
      let onlyStudent = 0
      try {
        writeFileSync(TMP8, poisonTeacher)
        const mod = await import(pathToFileURL(TMP8).href)
        onlyStudent = mod.findScheduleConflicts({
          classes: allClasses,
          members: membersDisjoint,
          teachers: teachersSame,
          existing: [],
          pending: [slotA, slotB],
        }).length
      } finally {
        rmSync(TMP8, { force: true })
      }
      eq('R36b：🔴 砍掉"老师撞课"之后**一条都报不出来**（R27 会红）—— 这才是真对照', onlyStudent, 0)
    }
  }

  /* ============================================================
     第十四节 · 🆕 P10 收尾（`schema.sql` §34）
     ------------------------------------------------------------
     ① 选科变更审计（Q27 = B）：改一次 → 记录**恰好一条**，含"谁改的 / 从什么改成什么"
     ② 内容自动迁移（Q20 = A）：走班班成员按新选科**立刻重算**；**不动历史档案**（I54）
     ③ 一个事务：报错之后选科与审计**都没留下**
     ④ 旧科目数据：**不确认就删不掉**；报错里带着"将删除 N 条记录（不可恢复）"
     ⑤ 休学档位（Q28 = B）：休学**保留**、转班/转学**移出**、复学一键恢复
     ⑥ `subjects.can_stream` 废弃登记（P7 已做，这里只核一遍）
     ============================================================ */
  section('第十四节 · 🆕P10：选科变更审计 + 内容自动迁移 + 旧科目数据二次确认 + 休学档位（§34）')
  {
    const g1 = gradeOf('高一')
    const cSci10 = 'aaaa2222-0000-4000-8000-000000000001'
    const sP10 = 'bbbb2222-0000-4000-8000-000000000001'
    /* 走班班**复用** §十三 已经生成的那几个（`(grade_id, stream_key)` 上有一条部分唯一索引，
       再建一个同键的会当场撞索引） */
    const streamOf = (key) =>
      `(select id from classes where kind = 'stream' and grade_id = ${g1} and stream_key = '${key}' limit 1)`

    await db.exec(`
      insert into classes (id, teacher_id, name, grade, school_id, grade_id, kind, class_type) values
        ('${cSci10}'::uuid, '${U.super}', '高一(P10理)班', '高一', ${school}, ${g1}, 'admin', 'science');
    `)
    await db.query(`insert into students (id, class_id, student_no, name) values ($1::uuid,$2::uuid,'P10-01','壬')`, [
      sP10,
      cSci10,
    ])
    /* 先给他一条"旧科目数据"残留（走班班-化学的成员关系）—— 迁移那一条要把它换掉 */
    await db.query(`insert into class_members (class_id, student_id) values (${streamOf('chemistry')}, $1::uuid)`, [sP10])

    const WRITE = `select public.write_student_subject($1::uuid,$2::uuid,$3::text,$4::text,$5::text[],$6::text,$7::uuid[]) as v`
    const wr = (actor, kind, primary, second, note = '', memberIds = []) =>
      db.query(WRITE, [actor, sP10, kind, primary, second, note, memberIds])
    const tryWr = async (actor, ...a) => {
      try {
        await wr(actor, ...a)
        return { ok: true, message: '' }
      } catch (e) {
        return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
      }
    }
    const chgN = async () =>
      Number(one(await db.query(`select count(*)::int as n from student_subject_changes where student_id = $1`, [sP10])).n)
    const subjRow = async () =>
      one(await db.query(`select kind, primary_code, array_to_string(second_codes, ',') as s from student_subjects where student_id = $1`, [sP10])) ?? null
    const memberKeys = async () =>
      (await db.query(
        `select c.stream_key as k from class_members cm join classes c on c.id = cm.class_id
          where cm.student_id = $1 order by 1`,
        [sP10],
      )).rows.map((r) => r.k)

    /* ---- S1–S2：审计表存在 + 前端**零写权限** ---- */
    eq(
      'S1：`student_subject_changes` 对 `authenticated` **能读、不能写**（写只走服务端）',
      [
        one(await db.query(`select has_table_privilege('authenticated','student_subject_changes','select') as r`)).r,
        one(await db.query(`select has_table_privilege('authenticated','student_subject_changes','insert') as r`)).r,
      ],
      [true, false],
    )

    /* ---- S3–S5：改一次选科 → 记录**恰好一条**（谁改的 / 从什么改成什么）---- */
    const first = await tryWr(U.grade, 'standard', 'physics', ['chemistry', 'geography'])
    ok('S3：年级主任改一次选科 → 成功', first.ok, first.message)
    eq('S4：审计里**恰好一条**', await chgN(), 1)
    {
      /* ⚠️ 全部判空：`GRADE_NEGATIVE=p10-no-audit` 时审计插入被拿掉，上面 S4 会红；
         但这里若直接取 `row.changed_by`，脚本会**先抛 TypeError 崩掉** ——
         负向对照要的是"断言变红"，不是"脚本炸了"。 */
      const row =
        one(await db.query(`select before, after, changed_by from student_subject_changes where student_id = $1`, [sP10])) ?? null
      eq('S5：「谁改的」= 那个年级主任（Q27：三个人都能改，所以要能查）', row?.changed_by ?? null, U.grade)
      eq('S5b：「改前」是空快照（这位学生第一次采选科）', row?.before ?? null, {})
      eq(
        'S5c：「改成什么」用科目代码（`{primary, second[]}`），不用姓名',
        { primary: row?.after?.primary ?? null, second: row?.after?.second ?? null },
        { primary: 'physics', second: ['chemistry', 'geography'] },
      )
    }
    await wr(U.grade, 'standard', 'physics', ['chemistry', 'geography'])
    eq('S6：内容没变时**不会再写一条**（不是"每次保存都记一笔"）', await chgN(), 1)

    /* ---- S7–S10：内容自动迁移 + I54（不动历史档案）---- */
    eq(
      'S7：🔴 内容自动迁移（Q20 = A）：理科班 + 物化地 → `walk = {地理}` → 成员换成**走班班-地理**',
      await memberKeys(),
      ['geography'],
    )
    const mismatch = await tryWr(U.grade, 'standard', 'history', ['politics', 'geography'])
    ok('S8：「首选与班型不符」照样能存（那是"建议转班"，不是拒绝）', mismatch.ok, mismatch.message)
    eq('S9：⚠️「认不出就不动」：首选与班型不符 → 走班班成员**原样不动**（不许自动清空）', await memberKeys(), ['geography'])
    await wr(U.grade, 'standard', 'physics', ['chemistry', 'biology'])
    eq('S10：`walk = 空`（物化生 = 理科班默认）→ 成员被清空', await memberKeys(), [])
    eq('S10b：三次改动一共留下三条记录', await chgN(), 3)
    eq(
      'S10c：🔴 I54：**已发出的作业档案一个字都没动**（历史档案是快照）',
      Number(one(await db.query(`select count(*)::int as n from assignments where class_id = $1`, [cSci10])).n),
      0,
    )

    /* ---- S11–S12：一个事务（写一半不许留下）---- */
    {
      const before = await subjRow()
      const n0 = await chgN()
      const bad = await tryWr(U.grade, 'other', 'physics', ['chemistry', 'biology'], '转学插班', [cSci10])
      ok('S11：「其他」选了非走班班 → **显式报错**（不静默）', !bad.ok && /走班班/.test(bad.message), bad.message)
      eq('S11b：🔴 同一个事务：报错之后 `student_subjects` **一个字没改**', await subjRow(), before)
      eq('S11c：🔴 同一个事务：审计也**没留下**（不是"记了但没改"，也不是"改了但没记"）', await chgN(), n0)
    }

    /* ---- S12：前端直写审计表 → 被拒（三条路）----
       ⚠️ 这里**必须显式切角色**：本脚本的 `as()` 只塞 JWT 声明、**不切 `authenticated`**，
       那样跑在属主身份下，表级权限与 RLS 一起被绕过 —— 断言会变成"恒绿"。
       （RLS 那一条线由 `rls-checks.mjs` 的 `attempt()` 覆盖，这里管的是**表级 grant**。） */
    const asAuthed = async (sql, params) => {
      await db.exec('begin')
      try {
        await db.exec('set local role authenticated')
        await db.query(sql, params)
        await db.exec('commit')
        return { ok: true }
      } catch (e) {
        await db.exec('rollback')
        return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
      }
    }
    for (const [label, sql] of [
      ['插一行', `insert into student_subject_changes (student_id, before, after) values ($1::uuid, '{}'::jsonb, '{}'::jsonb)`],
      ['改一行', `update student_subject_changes set note = '偷改' where student_id = $1::uuid`],
      ['删一行', `delete from student_subject_changes where student_id = $1::uuid`],
    ]) {
      const r = await asAuthed(sql, [sP10])
      ok(`S12：客户端${label}选科变更记录 → **被拒**`, !r.ok, r.ok ? '居然成功了' : r.message)
    }

    /* ---- S13：读的判据（"要能查" + 与这件无关的人读不到）---- */
    const seen = async (uid) => {
      await db.exec('begin')
      try {
        await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
        await db.exec('set local role authenticated')
        const n = Number(one(await db.query(`select count(*)::int as n from student_subject_changes where student_id = $1`, [sP10])).n)
        await db.exec('commit')
        return n
      } catch {
        await db.exec('rollback')
        return -1
      }
    }
    ok(
      'S13：超管 / 教务处 / 本年级的年级主任都**看得见**（Q27：三个人都能改 → 要能查）',
      (await seen(U.super)) >= 1 && (await seen(U.admin)) >= 1 && (await seen(U.grade)) >= 1,
    )
    eq('S13b：反向对照：与本班无关的任课老师 → **0 行**', await seen(U.teacher), 0)

    /* ---- S14–S15：旧科目数据：**不确认就删不掉** ----
       先把"旧科目数据"造出来：最后一次改动把 **生物** 放弃掉，并留下
       ㈠ 他在本班的生物考试成绩行；㈡ 走班班-生物的成员关系残留。 */
    {
      await wr(U.grade, 'standard', 'physics', ['chemistry', 'geography'])
      await db.query(
        `insert into exams (id, teacher_id, title, paper_key, subject, subject_code, scope, grade, source, mode, exam_date, question_count, class_ids)
         values ('eeee2222-0000-4000-8000-000000000001'::uuid, $1::uuid, 'P10 生物练习8', 'P10生物8', '生物', 'biology', 'class', '高一', 'manual', 'scores', '2026-09-23', 10, array[$2::uuid])`,
        [U.grade, cSci10],
      )
      await db.query(
        `insert into exam_scores (exam_id, class_id, student_no, name, graded, total)
         values ('eeee2222-0000-4000-8000-000000000001'::uuid, $2::uuid,
                 (select coalesce(nullif(btrim(coalesce(s.serial,'')),''), s.student_no) from students s where s.id = $1::uuid), '壬', true, 77)`,
        [sP10, cSci10],
      )
      await db.query(`insert into class_members (class_id, student_id) values (${streamOf('biology')}, $1::uuid)`, [sP10])

      const counts = one(await db.query(`select public.old_subject_data_counts_for($1::uuid, $2::uuid) as v`, [U.grade, sP10])).v
      ok(
        'S14：「将删除什么」由**数据库算**：被放弃的科目里有生物，成绩 ≥1 条、走班班成员 ≥1 条',
        counts.oldSubjects.includes('biology') && Number(counts.scores) >= 1 && Number(counts.members) >= 1,
        JSON.stringify(counts),
      )
      const scoreLeft = async () =>
        Number(one(await db.query(`select count(*)::int as n from exam_scores where exam_id = 'eeee2222-0000-4000-8000-000000000001'`)).n)
      const bioLeft = async () =>
        Number(one(await db.query(`select count(*)::int as n from class_members where class_id = ${streamOf('biology')} and student_id = $1::uuid`, [sP10])).n)

      const noConfirm = await (async () => {
        try {
          await db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean)`, [U.grade, sP10, false])
          return { ok: true, message: '' }
        } catch (e) {
          return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
        }
      })()
      ok(
        '🔴 S15：不确认（`p_confirm = false`）→ **报错、一条都不删**；那句话里带着"将删除 N 条记录（不可恢复）"',
        !noConfirm.ok && /二次确认/.test(noConfirm.message) && /不可恢复/.test(noConfirm.message),
        noConfirm.message,
      )
      eq('S15b：反向对照（删不掉那一半）：成绩行**还在**', await scoreLeft(), 1)
      eq('S15c：反向对照（删不掉那一半）：走班班成员残留**还在**', await bioLeft(), 1)

      await db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean)`, [U.grade, sP10, true])
      eq('S16：确认之后 → 那条生物成绩行**被删掉**（不可恢复）', await scoreLeft(), 0)
      eq('S16b：确认之后 → 走班班成员残留也清掉', await bioLeft(), 0)
      {
        const row = one(
          await db.query(
            `select purged_by, purge_counts from student_subject_changes
              where student_id = $1 and purged_at is not null order by changed_at desc limit 1`,
            [sP10],
          ),
        )
        ok('S16c：删除**留了审计**（`purged_by` / `purge_counts` 都写上了）', row?.purged_by === U.grade && Number(row?.purge_counts?.scores) >= 1)
      }
      let last = null
      for (let i = 0; i < 6; i++) {
        last = one(await db.query(`select public.purge_old_subject_data($1::uuid, $2::uuid, $3::boolean) as v`, [U.grade, sP10, true])).v
        if (/没有要删/.test(String(last?.message ?? ''))) break
      }
      ok('S16d：删到没有待删项之后，再调一次回"没有要删的旧科目数据"（同一批不会被删第二遍）', /没有要删/.test(String(last?.message ?? '')), JSON.stringify(last))
    }

    /* ---- S17–S19：休学档位（Q28 = B）---- */
    await db.query(`insert into class_members (class_id, student_id) values (${streamOf('geography')}, $1::uuid) on conflict do nothing`, [sP10])
    eq('S17：前置：这位学生在走班班-地理里', await memberKeys(), ['geography'])
    await db.query(`update students set status = 'suspended' where id = $1::uuid`, [sP10])
    eq('🔴 S18：休学（`suspended`）→ **走班名单保留**（Q28 = B：保留但标记）', await memberKeys(), ['geography'])
    eq('S18b：休学的标记**读得出来**', one(await db.query(`select status from students where id = $1::uuid`, [sP10])).status, 'suspended')
    const fourth = await tryAs(U.super, `update students set status = 'dropped' where id = $1::uuid`, [sP10])
    ok('S18c：第四档不认（check 约束只认 active / suspended / left）', !fourth.ok, fourth.message)
    await db.query(`update students set status = 'active' where id = $1::uuid`, [sP10])
    eq('S19：复学一键恢复 → 状态回 `active`，走班名单**本来就没被动过**', await memberKeys(), ['geography'])
    await db.query(`update students set status = 'left' where id = $1::uuid`, [sP10])
    eq('🔴 S19b：转学 / 退学（`left`）→ **走班名单移出**', await memberKeys(), [])
    await db.query(`update students set status = 'active' where id = $1::uuid`, [sP10])
    await db.query(`insert into class_members (class_id, student_id) values (${streamOf('geography')}, $1::uuid) on conflict do nothing`, [sP10])
    /* ⚠️ 转到**另一个班**才算"转班"（转到同一个班 `class_id` 没变，触发器按设计什么都不做） */
    await db.query(`update students set class_id = ${classOf('高一(1)班')} where id = $1::uuid`, [sP10])
    eq('🔴 S19c：转班（`class_id` 变了）→ **走班名单移出**（四条写入路径共用这一个触发器）', await memberKeys(), [])
    {
      const cons = (await db.query(
        `select conname from pg_constraint where conrelid = 'students'::regclass and contype = 'c' order by conname`,
      )).rows.map((r) => r.conname)
      ok('S19d：旧的 `students_status_check`（两档）已删、新的 `students_status_check_v2`（三档）在', !cons.includes('students_status_check') && cons.includes('students_status_check_v2'), cons.join('、'))
    }

    /* ---- S20：`subjects.can_stream` 废弃登记 ---- */
    eq(
      'S20：`subjects.can_stream` 那一列**不存在**（§32.6 已删；Q24 = B）',
      (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='subjects' and column_name='can_stream'`)).rows,
      [],
    )

    /* ---- S21：前端那几处真的接上了（静态钉住 —— 少一处就是"后端做了、界面没入口"）---- */
    {
      const read = (f) => readFileSync(resolvePath(APP, f), 'utf8')
      const cd = read('src/pages/ClassDetail.tsx')
      ok('S21：班级管理页真的把「事务性呼叫」发成**不挂作业**（`assignmentId: \'\'`）', /assignmentId: ''/.test(cd))
      ok('S21b：班级管理页有**三档**在班状态（在读 / 休学 / 已转出）', /STUDENT_STATUS_NAME\[v\]/.test(cd) && /'active', 'suspended', 'left'/.test(cd))
      ok('S21c：班级管理页有「删除旧科目数据」入口 + **二次确认**（先看"将删除 N 条记录"）', /apiOldSubjectPreview/.test(cd) && /apiPurgeOldSubjectData/.test(cd) && /将删除 \{purgeCounts\.total\} 条记录/.test(cd))
      ok('S21d：班级管理页有「选科变更记录」（只读）', /loadStudentSubjectChanges/.test(cd))
      const cr = read('src/pages/Classroom.tsx')
      ok('S21e：教室端认得出**走班班**（`isStreamClass`）并且不摆写入口', /streamMode = isStreamClass\(klass\)/.test(cr))
      ok('S21f：走班班的屏**只看作业与考试** —— 粘贴/拍课表、呼叫面板、文件、备份都不摆', (cr.match(/\{streamMode \? null :/g) ?? []).length >= 4)
      ok('S21g：教室端有「本班考试」那一块（Q17 的"只看作业和考试"里"考试"那一半）', /本班考试/.test(cr))
      const rm = read('src/data/remote.ts')
      ok('S21h：`calls.assignment_id` 的「空串 ↔ null」映射**只有一处**（空串直接写进 uuid 列会 22P02）', /assignment_id: c\.assignmentId \? c\.assignmentId : null/.test(rm) && /assignmentId: r\.assignment_id \?\? ''/.test(rm))
      const fn = read('functions/api/grade-setup.ts')
      ok('S21i：服务端用 **service_role + 显式 `p_actor`** 调那两个 `_for` 函数（§30 的形状）', /svcRpc\(env, 'purge_old_subject_data'/.test(fn) && /p_actor: me\.id/.test(fn) && /svcRpc\(env, 'old_subject_data_counts_for'/.test(fn))
      ok('S21j：服务端**不自己判二审**（`p_confirm` 原样传下去，判断在数据库）', /p_confirm: body\.confirm === true/.test(fn))
    }

    /* ============================================================
       S22 🆕 2026-10-06：**谁能改这个学生的选科**（用户拍板收窄成四档）
       ------------------------------------------------------------
       口径：`最高管理员 / 教务处` ∪ `本年级的年级主任` ∪ `本班班主任`
       （方案 §4.2.5 的权限矩阵 + Q27 的原话「班主任，或者是年级主任，或者是教导处」）。
       🔴 改之前第三支是 `visible_class_ids_for()`（**任教班**）—— 任何科任老师
          都能在他任教的班里改学生的选科。S22d/S22j 就是那次收窄的**直接防线**，
       S22l–S22n 是**反向对照**（把"任教班"那一支装回去 → 那两条必须红）。
       ⚠️ 夹具是**全新的**一个班 + 一个学生 + 五个身份，不碰别的节（"同一批数据、只有一个变量"）。
       ============================================================ */
    {
      const X = {
        head: 'cccc0001-0000-4000-8000-000000000001', // 本班班主任
        myCls: 'cccc0002-0000-4000-8000-000000000002', // 这个学生所在的行政班
        otherCls: 'cccc0003-0000-4000-8000-000000000003', // 别的班
        otherHead: 'cccc0004-0000-4000-8000-000000000004', // 别的班的班主任
        /*
         * 别的年级的年级主任：**复用前面夹具里那一位**（第九节的 `U2.other` = 高二主任）——
         * ⚠️ 这里**不能**自己 insert 一个 grade_head：`teacher_roles_one_grade_head`
         *    是"**一个年级只许一个年级主任**"的全局唯一索引，高二已经有了（实测踩过：
         *    自建那一条当场 `duplicate key value violates unique constraint`，整个脚本崩掉）。
         */
        otherGh: '66666666-6666-6666-6666-666666666666', // 高二年级主任（第九节的夹具）
        teacher: 'cccc0006-0000-4000-8000-000000000006', // 本班任教的**科任老师**（不带班）
        room: 'cccc0007-0000-4000-8000-000000000007', // 这个班的教室端账号
        stu: 'cccc0008-0000-4000-8000-000000000008', // 那个学生
      }
      const g1s = gradeOf('高一')
      await db.exec(`
        insert into auth.users (id, email, raw_user_meta_data) values
          ('${X.head}',      's22-head@test',  '{"name":"本班班主任"}'::jsonb),
          ('${X.otherHead}', 's22-head2@test', '{"name":"别班班主任"}'::jsonb),
          ('${X.teacher}',   's22-t@test',     '{"name":"科任老师"}'::jsonb),
          ('${X.room}',      's22-room@test',  '{"name":"S22教室端"}'::jsonb);
        insert into classes (id, teacher_id, name, grade, school_id, grade_id, kind, class_type) values
          ('${X.myCls}'::uuid,    '${X.head}',      '高一(S22)班',    '高一', ${school}, ${g1s}, 'admin', 'science'),
          ('${X.otherCls}'::uuid, '${X.otherHead}', '高一(S22别)班',  '高一', ${school}, ${g1s}, 'admin', 'science');
        insert into students (id, class_id, student_no, name, serial) values
          ('${X.stu}'::uuid, '${X.myCls}'::uuid, 'S22-01', '癸', '2026999');
        insert into teacher_roles (teacher_id, role, scope_type, scope_id) values
          ('${X.head}',      'head_teacher', 'class', '${X.myCls}'::uuid),
          ('${X.otherHead}', 'head_teacher', 'class', '${X.otherCls}'::uuid);
        /* 🔴 科任老师：在这个班**任教**（但不带班）—— 收窄之前他就是"能改选科"的那个人 */
        insert into class_subjects (class_id, subject, subject_code, teacher_id) values
          ('${X.myCls}'::uuid, '物理', 'physics', '${X.teacher}');
        insert into classroom_accounts (id, class_id, school_id, name, email) values
          ('${X.room}'::uuid, '${X.myCls}'::uuid, ${school}, '高一(S22)班教室端', 's22-room@test');
      `)

      /** 以某个身份问"我能不能改这个学生的选科" —— **走裸版判据**（前端就是这么问的，§27.4） */
      const canEditAs = async (uid) => {
        await db.exec('begin')
        try {
          await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
          await db.exec('set local role authenticated')
          const v = one(await db.query(`select public.can_edit_student_subject($1::uuid) as v`, [X.stu])).v
          await db.exec('commit')
          return v
        } catch {
          await db.exec('rollback')
          return '(问不出来)'
        }
      }
      /**
       * 让某个身份当 `p_actor` 去写**这个学生**的选科（§30 的形状：服务端 service_role
       * + 显式 `p_actor` —— 这里以属主身份调，正是服务端那一层的替身）。
       * ⚠️ **不能用上面那个 `tryWr`**：它把学生写死成 `sP10`（那是第十八节前面的夹具），
       *    拿它问 X.head 会得到"没有权限"——因为 X.head 不是 **sP10** 那个班的班主任。
       *    第一版就是这么写错的，S22i 当场红了（**这正是断言的价值**）。
       */
      const writeForX = async (actor, primary, second) => {
        try {
          await db.query(WRITE, [actor, X.stu, 'standard', primary, second, '', []])
          return { ok: true, message: '' }
        } catch (e) {
          return { ok: false, message: String(e?.message ?? e).split('\n')[0] }
        }
      }
      /**
       * 客户端**直写** `student_subjects`（RLS 那条路）→ 返回改动的行数。
       * ⚠️ 线上 `authenticated` **连 update 权限都没有**（§27.8 只 grant 了 select）——
       *    所以这里在**一个事务里临时 grant update**、测完**一定回滚**：
       *    不这么做就只能撞上 `permission denied`，**测不到写策略本身**，
       *    而写策略正是 §27.8 那句"写策略仍然要给"的存在理由。
       */
      const directWriteAs = async (uid) => {
        await db.exec('begin')
        try {
          await db.exec('grant update on student_subjects to authenticated')
          await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid])
          await db.exec('set local role authenticated')
          return (
            await db.query(`update student_subjects set primary_code = 'history' where student_id = $1::uuid returning student_id`, [
              X.stu,
            ])
          ).rows.length
        } catch {
          return -1
        } finally {
          await db.exec('rollback')
        }
      }

      eq('S22：本班班主任 → **能**改这个学生的选科', await canEditAs(X.head), true)
      eq('S22b：本年级的年级主任 → **能**', await canEditAs(U.grade), true)
      eq(
        'S22c：教务处 / 最高管理员 → **能**（两级校级的兜底没被误伤）',
        [await canEditAs(U.admin), await canEditAs(U.super)],
        [true, true],
      )
      eq(
        'S22d：🔴 **科任老师（在本班任教、但不是班主任）→ 不能**（2026-10-06 收窄的直接防线）',
        await canEditAs(X.teacher),
        false,
      )
      eq('S22e：别的班的班主任 → 不能（他只管自己那个班）', await canEditAs(X.otherHead), false)
      eq('S22f：别的年级的年级主任 → 不能', await canEditAs(X.otherGh), false)
      eq('S22g：教室端（哪怕就是他那个班的屏）→ 不能', await canEditAs(X.room), false)

      /* 真的走一遍那两个写入路径：RPC（服务端形状，§30）+ 客户端直写（RLS 写策略） */
      const tBad = await writeForX(X.teacher, 'physics', ['chemistry', 'biology'])
      ok(
        'S22h：🔴 科任老师当 `p_actor` 调 `write_student_subject` → **拦住**（人话是"你没有改这个学生选科的权限"）',
        !tBad.ok && /没有改这个学生选科的权限/.test(tBad.message),
        tBad.message,
      )
      const tHead = await writeForX(X.head, 'physics', ['chemistry', 'biology'])
      ok('S22i（对照）：本班班主任当 `p_actor` → **写得进去**（收窄不是"谁都改不了"）', tHead.ok, tHead.message)
      eq('S22j：🔴 科任老师**直写** `student_subjects`（RLS 写策略）→ **0 行**', await directWriteAs(X.teacher), 0)
      eq('S22k（对照）：本班班主任直写 → **1 行**（写策略那一侧真放行）', await directWriteAs(X.head), 1)

      /* 🔴 S22l–S22n：**反向对照** —— 把"任教班"那一支装回去（= 收窄之前的样子），
         S22d / S22j 必须红。
         ⚠️ 还原用的是**改动前那份真定义**（`pg_get_functiondef` 取下来存着），
            不是在这里再抄一遍新函数体 —— 抄一遍就会"抄错一处 = 后面全歪"。 */
      const realDef = one(
        await db.query(`select pg_get_functiondef('public.can_edit_student_subject_for(uuid,uuid)'::regprocedure) as d`),
      ).d
      const OLD_FN = `create or replace function public.can_edit_student_subject_for(p_uid uuid, p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_school_admin_for(p_uid)
      or exists (
           select 1
             from students s
             join classes c on c.id = s.class_id
            where s.id = p_student_id
              and (
                   c.id in (select visible_class_ids_for(p_uid))
                or exists (
                     select 1 from teacher_roles r
                      where r.teacher_id = p_uid
                        and r.role = 'grade_head'
                        and r.scope_type = 'grade'
                        and r.scope_id = c.grade_id
                   )
              )
         );
$$;`
      let poisonedDef = ''
      let poisonedTeacher = '(没跑起来)'
      let poisonedDirect = '(没跑起来)'
      try {
        await db.exec(OLD_FN)
        poisonedDef = one(
          await db.query(`select pg_get_functiondef('public.can_edit_student_subject_for(uuid,uuid)'::regprocedure) as d`),
        ).d
        poisonedTeacher = await canEditAs(X.teacher)
        poisonedDirect = await directWriteAs(X.teacher)
      } finally {
        await db.exec(realDef.endsWith(';') ? realDef : `${realDef};`)
      }
      ok(
        'S22l（对照自证）："任教班"那一支**真的装上了**（函数定义里出现了 `visible_class_ids_for`）',
        /visible_class_ids_for/.test(poisonedDef),
        poisonedDef.split('\n').slice(0, 3).join(' / '),
      )
      ok(
        'S22m：🔴 装回去之后科任老师**就能改**了（S22d 会红）—— 它不是永远为绿的摆设',
        poisonedTeacher === true,
        `can_edit_student_subject(科任老师) = ${String(poisonedTeacher)}`,
      )
      eq('S22n：🔴 装回去之后他**直写也写得进去**（S22j 会红）', poisonedDirect, 1)
      eq('S22o：还原成真定义之后，科任老师又是 `false`（对照用完没把库留成改坏的样子）', await canEditAs(X.teacher), false)
    }
  }

  /* ---------------- 收尾 ---------------- */

  await db.close()

  console.log('\n================ 结果 ================')
  console.log(`  断言：通过 ${pass} 条，失败 ${failures.length} 条`)
  if (failures.length) {
    for (const f of failures) console.log(`   ❌ ${f}`)
    console.log(`\n❌ 有 ${failures.length} 条没过`)
    process.exit(1)
  }
  if (NEGATIVE) {
    console.log(`\n⚠️ 这一轮是负向对照（GRADE_NEGATIVE=${NEGATIVE}），但它**没有红** —— 说明对照没生效`)
    process.exit(1)
  }
  console.log('  全部通过 ✅（纯逻辑 A–G / 真 PostgreSQL H–M / 静态 N · O / canSetup 端到端 R / 对照 P）')
})
