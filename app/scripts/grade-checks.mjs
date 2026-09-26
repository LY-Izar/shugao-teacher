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

    /* 已经是默认的人不重复写（反指标：不让人做无意义的确认） */
    const cur = new Map([[`s-高一(1)班-01`, { studentId: 's-高一(1)班-01', primaryCode: 'physics', secondCodes: ['chemistry', 'biology'], kind: 'standard', note: '' }]])
    const r2 = gi.collectByClassType([science], cur)
    eq('E5：已经是默认的那个人**不再写**', r2.rows.length, 1)
    eq('E6：他被记进 `unchanged`', r2.unchanged, 1)

    /* 🔴 「其他」的学生**不许被一键覆盖** */
    const other = { studentId: 's-高一(1)班-02', primaryCode: '', secondCodes: ['chemistry', 'biology'], kind: 'other', note: '转学待定' }
    const r3 = gi.collectByClassType([science], new Map([['s-高一(1)班-02', other]]))
    eq('E7：「其他」的学生**不在一键的结果里**', r3.rows.some((x) => x.studentId === 's-高一(1)班-02'), false)
    eq('E8：他被记进 `otherKept`', r3.otherKept, 1)
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
    raise exception '备份还没有发到超管邮箱（%）—— 删除流程停在这里：先把信发出去',
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
    ok(
      'O10：`/grades` 的入口只在「我的」页那一行（Settings.tsx 读 `entryVisible("/grades", …)`）',
      /entryVisible\('\/grades'/.test(src('src/pages/Settings.tsx')),
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
      eq('T4e：🔴 **备份没发出 → 删不了**（400 + 数据库那句人话）', [del0.status, /备份还没有发到超管邮箱/.test(String(del0.json.message))], [400, true])
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
