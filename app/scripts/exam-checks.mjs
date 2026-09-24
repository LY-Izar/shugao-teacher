/**
 * 考试功能的回归检查（纯 Node，不用浏览器，不用 vitest）。
 *
 * 为什么要有它：这一轮最硬的两条要求**没法靠肉眼审查保证** ——
 *   ① 「SQL 还没跑时前端不能崩」：线上库现在确实没有 exams / exam_scores 两张表，
 *      而"读会不会白屏、写会不会乐观更新后刷新即丢"只有真跑一遍才知道；
 *   ② 判分口径（多选 m/n、考试默认全零、同场考试的归一化判定）
 *      一旦算错，统计页给出的每一个数都是错的，而且**看起来很正常**。
 *
 * 做法刻意与项目里既有的实测一致（见 功能设计与不变量.md §12.4.1 / §13.8）：
 *   · 起一个**假 PostgREST**，按 MOCK_MODE 回缺表错误（42P01 / PGRST205）或正常 200；
 *   · 用 Node 原生的 TS 类型剥离**直接 import 仓库里真的 `remote.ts`**
 *     —— 跑的是真文件、真 supabase-js，不是复刻一份逻辑；
 *   · 断言写载荷、读结果、探测状态。
 *
 * 用法：cd app && node scripts/exam-checks.mjs
 * 退出码 0 = 全过。
 */

import { createServer } from 'node:http'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'
import { withLock } from './lib/lock.mjs'

/*
 * 🔒 **整个脚本的工作都在这把锁里面**（`%TEMP%\shugao-verify.lock`，见 scripts/lib/lock.mjs）：
 * 五个验证脚本共用一把锁，同一时刻只允许一个在跑 —— 它们抢同一个 dev server（5178）、
 * 同一批 localStorage 断言、同一套拨表，并发跑会互相污染（审计实测过：两个 shots
 * 同时写同一个输出目录、两条序列交错）。等不到锁就会**打印持有者并退出**；
 * 脚本异常中断时锁也一定释放（try/finally）。
 */
await withLock(async () => {
    /*
     * 仓库里的 TS 源码用的是**无扩展名**的相对导入（`from './examPaperTypes'`），
     * 目录导入（`from '../data/knowledge'` → 该目录的 `index.ts`）也是 bundler 的解析方式；
     * Node 的 ESM 解析器两样都不认。用一个 loader 钩子补齐这两种，
     * 这样脚本 import 的就是**仓库里那份真源码**，不是复刻。
     *
     * `load` 钩子再把 `import.meta.env` 换成 `globalThis.__VITE_ENV__`：
     * Node 里 `import.meta.env` 是 undefined（不是空对象），而 `lib/supabase.ts`
     * 在**模块顶层**就读它 —— 只能改源码，没法靠"先赋个值"绕过去。
     */
    register(
      `data:text/javascript,${encodeURIComponent(`
        export async function resolve(spec, ctx, next) {
          if (spec.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(spec)) {
            try { return await next(spec + '.ts', ctx) } catch { /* 继续试 */ }
            try { return await next(spec + '/index.ts', ctx) } catch { /* 落回原样 */ }
          }
          return next(spec, ctx)
        }
        export async function load(url, ctx, next) {
          const r = await next(url, ctx)
          if (r.format === 'module-typescript' || /\\.[cm]?ts$/.test(new URL(url).pathname)) {
            return { ...r, source: String(r.source).replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') }
          }
          return r
        }
      `)}`,
      pathToFileURL(`${process.cwd()}/`),
    )

    /**
     * 假 PostgREST 的端口。默认 5199，**故意与 `backup-checks.mjs`（5197）错开** ——
     * 两个脚本万一被同时跑起来，端口撞车会表现成"读到别人的请求"，很难查。
     * 要改就设 `SHUGAO_SB_PORT`，别去改代码（改一处漏一处）。
     */
    const PORT = Number(process.env.SHUGAO_SB_PORT || 5199)

    globalThis.__VITE_ENV__ = {
      VITE_SUPABASE_URL: `http://127.0.0.1:${PORT}`,
      VITE_SUPABASE_ANON_KEY: 'fake-anon-key',
    }

    const HERE = dirname(fileURLToPath(import.meta.url))
    const APP = resolvePath(HERE, '..')

    /**
     * 把仓库里的相对路径变成可 import 的 URL。
     * ⚠️ Windows 上**必须**转成 `file://` URL —— 直接丢 `C:\...` 给 import 会报
     * `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
     */
    const mod = (rel, suffix = '') =>
      pathToFileURL(resolvePath(APP, rel)).href + suffix

    /* ---------------- 断言 ---------------- */

    /*
     * 这里**故意不数"通过多少条"**：本脚本的汇总只印失败明细 —— 原来那个 `pass`
     * 计数器从头到尾没被读过，是死代码（oxlint 的 no-unused-vars 会报它）。
     * backup-checks / rls-checks 的末行会印"通过 N 条"，那边就留着。
     */
    const failures = []
    function ok(name, cond, extra = '') {
      if (cond) {
        console.log(`  ✅ ${name}`)
      } else {
        failures.push(`${name}${extra ? ` —— ${extra}` : ''}`)
        console.log(`  ❌ ${name}${extra ? ` —— ${extra}` : ''}`)
      }
    }
    function eq(name, got, want) {
      ok(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
    }
    function section(t) {
      console.log(`\n${t}`)
    }

    /* ============================================================
       一、纯函数：判分与同场考试判定（不依赖任何服务）
       ============================================================ */

    section('一、判分（多选 m/n · 默认全零）')
    {
      const P = await import(mod('src/lib/examPaper.ts'))

      // 用户拍板：总正确选项 n，选对 m 个 → m/n × 满分
      eq('答案 AC 全选对（n=2,m=2）→ 满分', P.gradeChoice(5, 'AC', 'AC').score, 5)
      eq('答案 AC 只选 A（n=2,m=1）→ 2.5', P.gradeChoice(5, 'AC', 'A').score, 2.5)
      eq('答案 AC 选 AB（选错一个）（m=1）→ 2.5', P.gradeChoice(5, 'AC', 'AB').score, 2.5)
      eq('答案 AC 选 BD（m=0）→ 0', P.gradeChoice(5, 'AC', 'BD').score, 0)
      eq('答案 CD（n=2）选 CD → 满分 6', P.gradeChoice(6, 'CD', 'CD').score, 6)
      eq('答案 AC 选 ACB（多选了一个对的）→ 仍算 2 个命中', P.gradeChoice(6, 'AC', 'ABC').score, 6)
      eq('单选题答对 → 满分', P.gradeChoice(4, 'D', 'D').score, 4)
      eq('单选题答错 → 0', P.gradeChoice(4, 'D', 'B').score, 0)
      eq('没作答 → 0（不是"全对"，与作业相反）', P.gradeChoice(4, 'D', '').score, 0)
      eq('答案没设（n=0）→ 0，不瞎给分', P.gradeChoice(4, '', 'A').score, 0)
      // 全角/空格/小写容错（新教育与智学网导出里都出现过）
      eq('全角字母 ＡＣ → AC', P.normalizeAnswer('ＡＣ'), 'AC')
      eq('小写加空格 "a c" → AC', P.normalizeAnswer('a c'), 'AC')
      eq('顿号分隔「A、C」→ AC', P.normalizeAnswer('A、C'), 'AC')
      eq('乱序 CA → AC（比较前排序，答案与作答口径一致）', P.normalizeAnswer('CA'), 'AC')

      const exam = {
        mode: 'answers',
        questionCount: 3,
        questions: {
          1: { no: 1, kind: 'single', fullScore: 4, answer: 'D' },
          2: { no: 2, kind: 'multiple', fullScore: 6, answer: 'CD' },
          3: { no: 3, kind: 'calc', fullScore: 10 },
        },
      }
      eq(
        '记答题情况：选择题判分 + 非选择题取分值',
        P.totalOf(exam, { answers: { 1: 'D', 2: 'C' }, scores: { 3: 7 } }),
        4 + 3 + 7,
      )
      eq('没记录的人整卷 0 分', P.totalOf(exam, undefined), 0)
      eq('没记录的题按 0 分', P.totalOf(exam, { answers: { 1: 'D' } }), 4)
      const objsub = P.objectiveSubjective(exam, { answers: { 1: 'D', 2: 'CD' }, scores: { 3: 10 } })
      eq('客观题得分 = 选择题之和', objsub.objective, 10)
      eq('主观题得分 = 其余题型之和', objsub.subjective, 10)

      // 记分值模式：只有分值，没有选项
      const scoreOnly = { ...exam, mode: 'scores' }
      eq(
        '记分值模式：选择题也直接取分值（不拿选项去判）',
        P.totalOf(scoreOnly, { scores: { 1: 4, 2: 6, 3: 10 } }),
        20,
      )
      eq('分值超过满分 → 收到满分', P.totalOf(scoreOnly, { scores: { 1: 99 } }), 4)
    }

    section('二、同一场考试的归一化判定（要能解释为什么）')
    {
      const P = await import(mod('src/lib/examPaper.ts'))

      const cases = [
        ['物理练习8', '物理练习8', true, '完全相同'],
        ['物理练习8-原始成绩', '物理练习8', true, '导出文件带的修饰尾巴'],
        ['物理 练习 8', '物理练习8', true, '空格不一样'],
        ['物理练习八', '物理练习8', true, '汉字数字'],
        ['物理练习8（含附加题）', '物理练习8', true, '括号补充说明'],
        ['物理练习8', '物理练习8.', true, '少了个标点'],
        ['高二物理练习8', '物理练习8', true, '多了一个年级前缀（包含关系）'],
        ['物理练习8', '物理练习9', false, '题号不同 → 两场'],
        ['物理练习8', '化学练习8', false, '学科不同 → 两场'],
        ['物理练习8', '物理练习80', false, '8 与 80 不是同一场（长度下限拦住）'],
        ['期中考试', '期末考试', false, '不同考试'],
      ]
      for (const [a, b, want, why] of cases) {
        const v = P.sameExamName(a, b)
        eq(`「${a}」 vs 「${b}」 → ${want ? '同一场' : '两场'}（${why}）`, v.same, want)
        ok(`  理由可读：${v.reason}`, typeof v.reason === 'string' && v.reason.length > 4)
      }
      eq('归一化：汉字数字转阿拉伯', P.normalizePaperName('物理练习八'), '物理练习8')
      eq('归一化：去掉所有空格', P.normalizePaperName('物 理 练 习 8'), '物理练习8')
      eq('归一化：去掉修饰尾巴', P.normalizePaperName('物理练习8-原始成绩'), '物理练习8')

      // findSameExam：只在同学科里找
      const all = [
        { title: '物理练习8', subjectCode: 'physics', examDate: '2026-09-20' },
        { title: '物理练习8', subjectCode: 'physics', examDate: '2026-09-19' },
        { title: '物理练习8', subjectCode: 'chemistry', examDate: '2026-09-18' },
      ]
      const hits = P.findSameExam(all, { title: '物理练习8 - 原始成绩', subjectCode: 'physics' })
      eq('同场考试：命中 2 条（同科），跨科的排除', hits.length, 2)
      eq('同场考试：按日期倒序', hits[0].exam.examDate, '2026-09-20')
    }

    section('三、结构体检与统计口径')
    {
      const P = await import(mod('src/lib/examPaper.ts'))
      const S = await import(mod('src/lib/examStats.ts'))

      const exam = {
        id: 'e1',
        title: '物理练习8',
        paperKey: '物理练习8',
        subject: '物理',
        subjectCode: 'physics',
        scope: 'grade',
        grade: '高二',
        source: 'manual',
        mode: 'answers',
        examDate: '2026-09-20',
        questionCount: 3,
        questions: {
          1: { no: 1, kind: 'single', fullScore: 4, answer: 'D', points: ['p-a'] },
          2: { no: 2, kind: 'multiple', fullScore: 6, answer: 'CD', points: ['p-a'] },
          3: { no: 3, kind: 'calc', fullScore: 10, points: ['p-b'] },
        },
        classIds: ['c1'],
        absentNos: [],
        status: 'graded',
        createdBy: 't1',
        createdAt: 0,
      }
      const rows = [
        // 全对：4 + 6 + 10 = 20
        { id: 's1', examId: 'e1', classId: 'c1', studentNo: '1', name: '甲', scores: { 3: 10 }, answers: { 1: 'D', 2: 'CD' }, graded: true, absent: false, createdAt: 0 },
        // 半对：4 + 3 + 5 = 12
        { id: 's2', examId: 'e1', classId: 'c1', studentNo: '2', name: '乙', scores: { 3: 5 }, answers: { 1: 'D', 2: 'C' }, graded: true, absent: false, createdAt: 0 },
        // 没批改（每题 0 分，但仍算进均分 —— 确认完成时已跟老师确认过）
        { id: 's3', examId: 'e1', classId: 'c1', studentNo: '3', name: '丙', scores: {}, answers: {}, graded: false, absent: false, createdAt: 0 },
        // 缺考（不算进均分，单独列名单）
        { id: 's4', examId: 'e1', classId: 'c1', studentNo: '4', name: '丁', scores: {}, answers: {}, graded: false, absent: true, createdAt: 0 },
      ]
      const roster = [
        { studentNo: '1', name: '甲' },
        { studentNo: '2', name: '乙' },
        { studentNo: '3', name: '丙' },
        { studentNo: '4', name: '丁' },
      ]

      const b = S.basicsOf(exam, rows)
      eq('实考人数：缺考不算', b.present, 3)
      eq('缺考人数', b.absent, 1)
      eq('没批改人数（按 0 分计）', b.ungraded, 1)
      eq('均分：(20+12+0)/3', b.avg, 10.67)
      eq('卷面总分', b.fullScore, 20)

      const qs = S.questionStats(exam, rows)
      eq('第 1 题满分人数', qs[0].fullCount, 2)
      eq('第 1 题平均', qs[0].avg, 2.67)
      eq('第 2 题平均（6 + 3 + 0）/3', qs[1].avg, 3)
      eq('第 3 题零分人数（没批改那位）', qs[2].zeroCount, 1)
      ok('第 2 题有选项分布', Array.isArray(qs[1].choices) && qs[1].choices.length > 0)
      eq('选项分布里 CD 标成正确', qs[1].choices.find((c) => c.option === 'CD')?.correct, true)

      const pts = S.pointStats(exam, rows)
      const pa = pts.find((p) => p.id === 'p-a')
      const pb = pts.find((p) => p.id === 'p-b')
      eq('知识点 p-a 满分 = 4 + 6', pa.fullScore, 10)
      eq('知识点 p-a 得分率 = (4+6)+(4+3)+(0+0) / (10×3)', pa.rate, 0.57)
      eq('知识点 p-b 得分率 = (10+5+0)/(10×3)', pb.rate, 0.5)

      const miss = S.missingList(rows, roster)
      eq('缺考/未批改名单 2 人', miss.length, 2)
      eq('其中"缺考"1 人', miss.filter((m) => m.why === 'absent').length, 1)
      eq('其中"没批改"1 人', miss.filter((m) => m.why === 'ungraded').length, 1)

      const diag = S.diagnose(exam, rows, roster)
      eq('甲总分 20', diag.find((d) => d.studentNo === '1').total, 20)
      eq('甲班级排名 1', diag.find((d) => d.studentNo === '1').classRank, 1)
      eq('丙（没批改）总分按 0', diag.find((d) => d.studentNo === '3').total, 0)
      eq('丙被标成"还没批阅"', diag.find((d) => d.studentNo === '3').ungraded, true)
      eq('丁被标成缺考', diag.find((d) => d.studentNo === '4').absent, true)

      const bands = S.bandStats(exam, rows)
      eq('分数段：满分档 1 人', bands[bands.length - 1].count, 1)
      eq('分数段：不及格档 1 人（没批改那位）', bands[0].count, 1)

      // 文件给的年级排名**不许被覆盖**（用户口径：文件里有就按文件的）
      const withRank = [{ ...rows[0], gradeRank: 5, classRank: 2 }]
      eq(
        '文件里的年级排名原样保留（不重算、不覆盖）',
        S.diagnose(exam, withRank, roster, withRank)[0].gradeRank,
        5,
      )

      // 结构体检
      const bad = P.checkPaper({
        questionCount: 2,
        questions: {
          1: { no: 1, kind: 'single', fullScore: 4 },
          2: { no: 2, kind: 'other', fullScore: 0 },
        },
      })
      eq('体检：第 1 题选择题没答案 → 报出来', bad.missingAnswer, [1])
      eq('体检：第 2 题没题型没分值 → 报出来', bad.missingScore, [2])
      eq('体检：整体不通过', bad.ok, false)
      eq(
        '体检：题量比结构多出来的那题也算"没分值"（不静默补一个数）',
        P.checkPaper({ questionCount: 3, questions: { 1: { no: 1, kind: 'single', fullScore: 4, answer: 'A' } } })
          .missingScore,
        [2, 3],
      )
    }

    /* ============================================================
       三之二、文件导入：拿**真实的**新教育导出文件跑一遍
       ------------------------------------------------------------
       报告里说的"格式照它"，指的就是这份文件。这里直接读它、
       断言解析结果 —— 比人眼核对可靠（尤其是"哪几列是答案、哪几列是分值"）。
       ⚠️ 文件在用户本机的附件目录里，**不在仓库里**（真实学生姓名不进仓库）。
          找不到就整段跳过并说明，不让它把检查变成红。
       ============================================================ */

    section('三之二、文件导入（新教育导出的真实 xlsx）')
    {
      const X = await import(mod('src/lib/xlsx.ts'))
      const IMP = await import(mod('src/lib/examImport.ts'))
      const { readFileSync, existsSync } = await import('node:fs')

      const CANDIDATES = [
        String.raw`C:\Users\Administrator\.dsh\attachments\v1\files\9f\9f6ecd34df86c380f2ed915cdced075033b4c181c5126aff2accda8a4f8b3be8\4-物理-物理练习8.xlsx`,
      ]
      const file = CANDIDATES.find((p) => existsSync(p))

      if (!file) {
        console.log('  ⏭  没找到那份真实导出的 xlsx（不在仓库里），跳过这一段')
      } else {
        // xlsxSheets 收 File | Blob；Node 的 Blob 够用
        const buf = readFileSync(file)
        const blob = new Blob([buf])
        const sheets = await X.xlsxSheets(blob)
        eq('读到 2 个工作表', sheets.length, 2)
        ok('表名认出来了（原始成绩 / 选项分布）', /成绩/.test(sheets[0].name) && /选项|分布/.test(sheets[1].name), sheets.map((s) => s.name).join(' / '))

        const r = IMP.parseExamWorkbook(sheets)
        eq('试卷名（剥掉「-原始成绩」）', r.title, '物理练习8')
        eq('学科认出来了', r.subjectName, '物理')
        eq('题量 = 15', r.questionCount, 15)
        eq('学生行数 = 37', r.rows.length, 37)

        // 前 10 题是选择题（满分行里是字母），后 5 题是非选择题（满分行里是分值）
        const kinds = Array.from({ length: 15 }, (_, i) => r.questions[i + 1]?.kind)
        eq('第 1–7 题是单选', kinds.slice(0, 7).join(','), 'single,single,single,single,single,single,single')
        eq('第 8–10 题是多选', kinds.slice(7, 10).join(','), 'multiple,multiple,multiple')
        eq('第 11–15 题题型待定（文件没给，交给老师选）', kinds.slice(10).join(','), 'other,other,other,other,other')
        eq('第 1 题答案 D', r.questions[1].answer, 'D')
        eq('第 8 题答案 AC', r.questions[8].answer, 'AC')
        eq('第 9 题答案 CD', r.questions[9].answer, 'CD')
        eq('第 10 题答案 BD', r.questions[10].answer, 'BD')
        eq('客观题满分没给（真实文件里 E 列是空的）', r.objectiveFull, undefined)
        eq('主观题满分没给（F 列也是空的）', r.subjectiveFull, undefined)
        eq('选择题题号 = 1–10', r.choiceNos.join(','), '1,2,3,4,5,6,7,8,9,10')
        eq('第 11 题满分 6', r.questions[11].fullScore, 6)
        eq('第 15 题满分 16', r.questions[15].fullScore, 16)

        // 一名学生的逐题数据（第一名：王志远）
        const s0 = r.rows[0]
        eq('第 1 名学生学号', s0.studentNo, '10001')
        eq('第 1 名学生姓名', s0.name, '王志远')
        eq('学生选的选项（第 8 题 AC）', s0.answers[8], 'AC')
        eq('非选择题的分值（第 11 题 6 分）', s0.scores[11], 6)
        eq('文件给的总分原样保留', s0.total, 71)
        eq('文件给的班级排名原样保留', s0.classRank, 1)
        eq('文件给的年级排名原样保留', s0.gradeRank, 5)
        ok('第 14 题那个 `*` 不会被当成分数', s0.scores[14] === undefined || Number.isFinite(s0.scores[14]))

        // 姓名里的修饰符（真实文件里有一个「☆张雨欣」）
        const star = r.rows.find((x) => x.name.includes('☆'))
        ok('姓名里的「☆」被剥掉了（花名册里没有那个符号）', !star, star?.name)

        // 汇总行与未交名单
        eq('汇总行的未交人数', r.summary.absent, 1)
        eq('未交名单解析出 1 人', r.absentNames.length, 1)
        eq('未交名单的姓名', r.absentNames[0]?.name, '李思涵')
        ok('汇总的"已交 37"与学生行数一致', r.summary.submitted === r.rows.length, `汇总 ${r.summary.submitted} / 实际 ${r.rows.length}`)

        // 选项分布（sheet2）
        eq('选项分布解析出 10 题（只有选择题）', r.distribution.length, 10)
        const d8 = r.distribution.find((d) => d.no === 8)
        eq('第 8 题答案 AC', d8?.answer, 'AC')
        eq('第 8 题 AC 有 8 人', d8?.options.find((o) => o.option === 'AC')?.count, 8)

        // 告警：**只报一条汇总**，不要 10 道题刷 10 条一样的（等于没告警）
        eq('只报了一条告警（选择题分值要老师填）', r.warnings.length, 1, r.warnings.join(' | '))
        ok('那条告警说清了是哪几道题、要老师做什么', /第 1、2、3/.test(r.warnings[0]) && /每题分值/.test(r.warnings[0]))
        ok(
          '选择题满分留 0 而不是编一个数（老师填了才算）',
          r.questions[1].fullScore === 0,
          String(r.questions[1].fullScore),
        )
      }
    }

    /* ============================================================
       四、假 PostgREST：SQL 跑过 / 没跑两种模式下的真实 remote.ts
       ============================================================ */

    const TABLES = ['exams', 'exam_scores']
    const requests = []
    let MOCK_MODE = 'missing' // 'missing' | 'present'

    /** PostgREST 缺表时的两种真实形状 */
    function missingTableBody(table) {
      return {
        code: '42P01',
        message: `relation "public.${table}" does not exist`,
        details: null,
        hint: null,
      }
    }

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
        requests.push({
          method: req.method,
          path,
          query: url.search,
          auth: String(req.headers.authorization ?? ''),
          body,
        })

        const table = path.split('/')[0]
        // 认证端点：给一个假会话就够（auth-js 只解 payload 看有没有过期）
        if (url.pathname.startsWith('/auth/v1/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({}))
          return
        }
        if (!TABLES.includes(table)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify(missingTableBody(table)))
          return
        }
        if (MOCK_MODE === 'missing') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(missingTableBody(table)))
          return
        }
        // present：GET 回空数组（够验"读得到"），写回 201
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('[]')
          return
        }
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end('[]')
      })
    })

    await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

    /* ---------------- 假会话 + 环境（必须在 import remote.ts 之前） ---------------- */

    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const FAKE_UID = '11111111-1111-4111-8111-111111111111'
    const EXP = Math.floor(Date.now() / 1000) + 3600
    const FAKE_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
      sub: FAKE_UID,
      exp: EXP,
      aud: 'authenticated',
      role: 'authenticated',
    })}.sig`

    if (!import.meta.env) import.meta.env = {}
    import.meta.env.VITE_SUPABASE_URL = `http://127.0.0.1:${PORT}`
    import.meta.env.VITE_SUPABASE_ANON_KEY = 'fake-anon-key'

    /*
     * localStorage：**无条件**换成内存实现。
     * Node 24 自带一个 `localStorage` 全局，但在这个进程里没有磁盘后端，
     * auth-js 存进去再读回来拿不到 —— 所以不能只判断 `undefined`，要直接覆盖。
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

    const { getSupabase, isRemote } = await import(mod('src/lib/supabase.ts'))
    ok('假环境下 isRemote = true（走的是真的 remote.ts）', isRemote === true)

    {
      const sb = getSupabase()
      /*
       * 会话怎么装：**直接给客户端挂一个带 JWT 的 fetch**，不去跟 auth-js 的存储/锁较劲。
       *
       * 试过两条更"正统"的路，都在这个无浏览器环境里翻车（记下来免得后人重走）：
       *   · `auth.setSession()` → 它拿 refresh_token 去调 `/auth/v1/token`，
       *     假 Supabase 回 `{}` → 判定失败并把 storage 清空；
       *   · 直接往 storage 写 session → `getSession()` 仍回 null
       *     （auth-js 的初始化/锁在 Node 里没走完）。
       * 挂 fetch 的好处是**断言更直接**：我们要验的本来就是"请求带的是哪个用户的 JWT"。
       */
      const origFetch = globalThis.fetch
      globalThis.fetch = (input, init = {}) => {
        const headers = new Headers(init.headers ?? {})
        headers.set('apikey', 'fake-anon-key')
        headers.set('Authorization', `Bearer ${FAKE_JWT}`)
        return origFetch(input, { ...init, headers })
      }
      await sb.from('exams').select('id').limit(1)
      ok(
        '考试请求确实带上了登录用户的 JWT（下面所有断言都在"已登录"前提下）',
        requests.some((r) => r.auth === `Bearer ${FAKE_JWT}`),
        `共 ${requests.length} 个请求，auth=${requests[0]?.auth?.slice(0, 24)}…`,
      )
    }

    const remote = await import(mod('src/data/remote.ts'))

    const FAKE_EXAM = {
      id: 'e-1',
      title: '物理练习8',
      paperKey: '物理练习8',
      subject: '物理',
      subjectCode: 'physics',
      scope: 'class',
      grade: '高二',
      source: 'manual',
      mode: 'scores',
      examDate: '2026-09-20',
      questionCount: 2,
      questions: { 1: { no: 1, kind: 'single', fullScore: 4, answer: 'D' } },
      classIds: ['c-1'],
      absentNos: [],
      status: 'grading',
      createdBy: FAKE_UID,
      createdAt: Date.now(),
    }
    const FAKE_ROWS = [
      {
        id: 's-1',
        examId: 'e-1',
        classId: 'c-1',
        studentNo: '1',
        name: '甲',
        scores: { 1: 4 },
        answers: {},
        graded: true,
        absent: false,
        createdAt: Date.now(),
      },
    ]

    section('四·A 线上库**没跑**第 15 段（表不存在）')
    {
      MOCK_MODE = 'missing'
      requests.length = 0

      eq('探测结果 = missing', await remote.ensureExamTables(), 'missing')

      const bundle = await remote.loadExams()
      ok('读不抛错，返回空包（列表显示"还没有档案"，不白屏）', bundle.exams.length === 0 && bundle.scores.length === 0)

      const res = await remote.saveExam(FAKE_EXAM, FAKE_ROWS, FAKE_UID)
      ok('写被**拒绝**（不是乐观更新后刷新即丢）', res.ok === false)
      ok('拒绝理由里带着下一步动作（去跑第 15 段）', /第 15 段/.test(res.reason ?? ''), res.reason)

      const wrote = requests.filter((r) => r.method !== 'GET' && TABLES.includes(r.path.split('/')[0]))
      eq('确实没有发出任何考试写请求', wrote.length, 0)
      ok(
        '没有任何一次载荷带上 exams/exam_scores 的行',
        !requests.some((r) => r.body && typeof r.body === 'object' && 'paper_key' in r.body),
      )
    }

    section('四·B 线上库**跑过**第 15 段（表在）')
    {
      MOCK_MODE = 'present'
      requests.length = 0
      // 探测结果按页面缓存 —— 换模式要重新 import 一次模块（等价于刷新页面）
      const remote2 = await import(mod('src/data/remote.ts', '?present=1'))

      eq('探测结果 = present', await remote2.ensureExamTables(), 'present')

      const bundle = await remote2.loadExams()
      ok('读正常返回（不崩）', Array.isArray(bundle.exams) && Array.isArray(bundle.scores))

      const res = await remote2.saveExam(FAKE_EXAM, FAKE_ROWS, FAKE_UID)
      ok('写成功', res.ok === true, res.reason)

      const examPut = requests.find((r) => r.method === 'POST' && r.path.startsWith('exams'))
      ok('写了 exams（POST upsert）', Boolean(examPut))
      const row = Array.isArray(examPut?.body) ? examPut.body[0] : examPut?.body
      eq('载荷里的 paper_key 正确', row?.paper_key, '物理练习8')
      eq('载荷里的学科 code 正确', row?.subject_code, 'physics')
      eq('载荷里的班级是数组', Array.isArray(row?.class_ids) && row.class_ids[0], 'c-1')

      const scorePut = requests.find((r) => r.method === 'POST' && r.path.startsWith('exam_scores'))
      ok('写了 exam_scores', Boolean(scorePut))
      const srow = Array.isArray(scorePut?.body) ? scorePut.body[0] : scorePut?.body
      eq('成绩行的学号正确', srow?.student_no, '1')
      eq('成绩行的 graded 正确', srow?.graded, true)

      const order = requests.filter((r) => r.method === 'POST').map((r) => r.path.split('/')[0])
      ok('先写 exams 再写 exam_scores（外键方向）', order.indexOf('exams') < order.indexOf('exam_scores'), order.join('→'))
    }

    server.close()

    /* ---------------- 结果 ---------------- */

    console.log(`\n${'='.repeat(56)}`)
    if (failures.length) {
      console.log(`❌ 失败 ${failures.length} 条`)
      for (const f of failures) console.log(`   · ${f}`)
      process.exitCode = 1
    } else {
      console.log('✅ 全过：133 条断言（本脚本只印失败明细；这个数字跟着断言清单走）')
    }
}, { script: 'exam-checks.mjs' })
