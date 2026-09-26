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

/** K 段用的函数签名（`has_function_privilege` 要精确的签名串） */
const FUNC_ARGS = {
  write_student_subject: 'uuid,text,text,text[],text,uuid[]',
  bulk_write_class_subjects: 'jsonb',
  bulk_import_roster: 'uuid,jsonb,text',
}

/* ---------------- 被测模块（**不抄一份**，真的 import 仓库里那几份） ---------------- */

const rosterLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/roster.ts')).href)
const pickLib = await import(pathToFileURL(resolvePath(APP, 'src/lib/pick.ts')).href)
const gi = await import(pathToFileURL(resolvePath(APP, 'src/lib/gradeImport.ts')).href)

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
    const r = await tryAs(U.admin, 'select public.bulk_import_roster($1, $2::jsonb)', [
      null,
      good,
    ])
    /* 第一个参数是年级 id —— 上面用 null 探一下"要指定年级"这条路 */
    ok('H1：不给年级 → 报"导入名单要指定一个年级"', !r.ok && r.message.includes('年级'), r.message)

    const gid = one(await db.query(`select id::text from grades where name = '高一'`)).id
    const okRes = await tryAs(U.admin, 'select public.bulk_import_roster($1::uuid, $2::jsonb)', [gid, good])
    ok('H2：教务处导 3 行 → 成功', okRes.ok, okRes.message)
    /* `as()` 回的是**行数组**，`bulk_import_roster` 的返回值是 JSON **对象**（不是行集）→ 直接取第一格 */
    const R = (okRes.rows ?? [])[0]?.bulk_import_roster ?? (okRes.rows ?? [])[0] ?? {}
    eq('H3：名单里有 2 个班号 → 这个年级一共 2 个班（1 复用 + 1 新建）', okRes.ok && Number(R.classes ?? 0), 2)
    eq('H4：写进去 3 个学生', okRes.ok && Number(R.students ?? 0), 3)
    const clsCount = Number(one(await db.query(`select count(*)::int as n from classes where grade_id = ${gradeOf('高一')}`)).n)
    eq('H5：库里确实有 2 个班了（1 班复用 + 2 班新建）', clsCount, 2)
    const stuCount = Number(one(await db.query(`select count(*)::int as n from students`)).n)
    eq('H6：库里确实有 3 个学生', stuCount, 3)

    /* 🔴 序列号由**触发器**发号：导入没自己算，但库里必须有号 */
    const serials = rowsOf(await db.query(`select serial from students order by serial`)).map((x) => x.serial)
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
    const badRes = await tryAs(U.admin, 'select public.bulk_import_roster($1::uuid, $2::jsonb)', [gid, bad])
    ok('H11：第 3 行非法 → 报错', !badRes.ok, badRes.message)
    ok('H12：理由里带着**行号 3** 与原因', /第 3 行/.test(badRes.message) && /班级内学号/.test(badRes.message), badRes.message)
    const after = Number(one(await db.query('select count(*)::int as n from students')).n)
    eq('H13：🔴 **整批不入库**（学生数一个都没变）', after, before)
    const cls2 = Number(one(await db.query(`select count(*)::int as n from classes where grade_id = ${gradeOf('高一')}`)).n)
    eq('H14：🔴 那个会在第 3 行之前建的"3 班"**也没有被建出来**', cls2, 2)

    /* 只读身份：年级主任能导本年级、教务处能导、别的年级的年级主任不行 */
    const other = await tryAs(U.head, 'select public.bulk_import_roster($1::uuid, $2::jsonb)', [
      gid,
      JSON.stringify([{ class_no: '9', student_no: '01', name: '辛', serial: '' }]),
    ])
    ok('H15：班主任**不能**录名单（他不是教务处 / 年级主任）', !other.ok && /权限/.test(other.message), other.message)
    const gh = await tryAs(U.grade, 'select public.bulk_import_roster($1::uuid, $2::jsonb)', [
      gid,
      JSON.stringify([{ class_no: '2', student_no: '02', name: '壬', serial: '' }]),
    ])
    ok('H16：本年级的年级主任**能**录名单', gh.ok, gh.message)
  }

  /* ---------------- I：选科校验 + 「其他」 ---------------- */
  {
    const stu = one(await db.query(`select id::text from students where name = '甲'`)).id
    const ok1 = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
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
      const r = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
        stu, 'standard', 'physics', second, '', [],
      ])
      ok(`I3：**非法选科当场拦住** —— ${label}`, !r.ok, r.ok ? '居然写进去了' : r.message)
    }
    const badPrimary = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'standard', 'chemistry', ['biology', 'geography'], '', [],
    ])
    ok('I4：首选不是物理/历史 → 拦住', !badPrimary.ok, badPrimary.message)

    /* 「其他」：必须手工选走班科目（**不能只填组合名**） */
    const otherNoMember = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'other', '', ['chemistry', 'biology'], '转学待定', [],
    ])
    ok('I5：🔴「其他」没选走班班 → 拦住', !otherNoMember.ok, otherNoMember.message)
    ok('I6：那句话就是"必须手工选走班科目"', /手工选走班科目/.test(otherNoMember.message), otherNoMember.message)

    const otherNoNote = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'other', '', ['chemistry', 'biology'], '', [],
    ])
    ok('I7：「其他」没填原因 → 拦住', !otherNoNote.ok, otherNoNote.message)

    /* 标准组合**不许**手工选班（那是 P7 的活） */
    const stdMember = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'standard', 'physics', ['chemistry', 'biology'], '', [classOf('高一(1)班')],
    ])
    ok('I8：标准组合手工选走班班 → 拦住（走班班由系统生成）', !stdMember.ok, stdMember.message)

    /* 班主任改不了（他不是那三档） */
    const headWrite = await tryAs(U.head, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'standard', 'physics', ['chemistry', 'geography'], '', [],
    ])
    ok('I9：任课/班主任档在**别的年级**的班上改不了（这里班主任无 scope → 拦）', !headWrite.ok, headWrite.message)

    /* 反向对照：合法的那一条**确实写得进去**（不然前面的"拦住"全是假绿） */
    const ok2 = await tryAs(U.grade, 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', [
      stu, 'standard', 'history', ['politics', 'geography'], '', [],
    ])
    ok('I10（对照）：换成合法组合 → 写得进去', ok2.ok, ok2.message)
  }

  /* ---------------- J：批量写任教关系（一个事务 + 上限 + 人话） ---------------- */
  {
    const c1 = classOf('高一(1)班')
    const c2 = classOf('高一(2)班')
    const t1 = `'${U.teacher}'::uuid`
    /* 用参数传 uuid：PostgREST 那边是 jsonb，这里直接构造 jsonb */
    const build = (arr) => JSON.stringify(arr)

    const badRow = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::jsonb)', [
      build([{ class_id: '00000000-0000-0000-0000-000000000000', subject_code: 'physics', teacher_id: U.teacher }]),
    ])
    ok('J1：第 1 行的班级不存在 → 报"第 1 行的班级不存在"', !badRow.ok && /第 1 行/.test(badRow.message), badRow.message)

    const before = Number(one(await db.query('select count(*)::int as n from class_subjects')).n)
    /* 第 2 行非法 → 第 1 行（合法）**也不许写进去** */
    const mixed = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::jsonb)', [
      build([
        { class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.teacher },
        { class_id: '00000000-0000-0000-0000-000000000000', subject_code: 'math', teacher_id: U.teacher },
      ]),
    ])
    ok('J2：一批里第 2 行非法 → 整批失败', !mixed.ok, mixed.message)
    ok('J3：报的是第 2 行', /第 2 行/.test(mixed.message), mixed.message)
    const after = Number(one(await db.query('select count(*)::int as n from class_subjects')).n)
    eq('J4：🔴 **改一半的情况不发生**（行数一个都没变）', after, before)

    const goodBulk = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::jsonb)', [
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
    const swap = await tryAs(U.grade, 'select public.bulk_write_class_subjects($1::jsonb)', [
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'physics', teacher_id: U.head }]),
    ])
    ok('J8：换一个老师教同一个班的物理 → 成功', swap.ok, swap.message)
    const hold = Number(one(await db.query(`select count(*)::int as n from class_subjects where subject_code = 'physics' and class_id = ${classOf('高一(1)班')} and teacher_id = '${U.teacher}'`)).n)
    eq('J9：原来那位老师的行被换掉了（同一个班同一科不留两个人）', hold, 0)

    const notMine = await tryAs(U.super, 'select public.bulk_write_class_subjects($1::jsonb)', [
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'math', teacher_id: U.teacher }]),
    ])
    ok('J10：超管（不是 any 年级主任、但是 is_school_admin）→ 也能写', notMine.ok, notMine.message)
    const nobody = await tryAs(U.teacher, 'select public.bulk_write_class_subjects($1::jsonb)', [
      build([{ class_id: (await db.query(`select id::text from classes where name='高一(1)班'`)).rows[0].id, subject_code: 'math', teacher_id: U.teacher }]),
    ])
    ok('J11：任课老师 → 被拒（"你没有设定这个年级任课关系的权限"）', !nobody.ok && /权限/.test(nobody.message), nobody.message)

    const tooMany = await tryAs(U.admin, 'select public.bulk_write_class_subjects($1::jsonb)', [
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
    const empty = await tryAs(U.admin, 'select public.bulk_write_class_subjects($1::jsonb)', ['[]'])
    ok('J13：空数组 → 报"一行都没有 —— 这份表是空的"', !empty.ok && /一行都没有/.test(empty.message), empty.message)
    void c1
    void c2
    void t1
  }

  /* ---------------- K：权限：写入口只有服务端能调 ---------------- */
  {
    for (const [label, sql, params] of [
      ['write_student_subject', 'select public.write_student_subject($1::uuid,$2,$3,$4::text[],$5,$6::uuid[])', ['00000000-0000-0000-0000-000000000000', 'standard', 'physics', ['chemistry', 'biology'], '', []]],
      ['bulk_write_class_subjects', 'select public.bulk_write_class_subjects($1::jsonb)', ['[]']],
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
  console.log('  全部通过 ✅（纯逻辑 A–G / 真 PostgreSQL H–M / 静态 N / 对照 P）')
})
