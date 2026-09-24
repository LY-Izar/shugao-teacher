import { isoOffset } from '../lib/date'
import { DEFAULT_SUBJECT_CODE, subjectName } from '../lib/subjects'
import { normalizePaperName, round2, totalOf } from '../lib/examPaper'
import type { Exam, ExamQuestion, ExamScore } from './examTypes'
import type {
  Assignment,
  AssignmentTemplate,
  ClassroomClient,
  Klass,
  QuestionMeta,
  ScheduleItem,
  ScheduleKind,
  Student,
} from './types'

/* 演示用姓名池：全部为拼装生成的虚拟姓名，不对应任何真实个人 */

const SURNAMES =
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'

const GIVEN1 =
  '伟芳娜敏静丽强磊军洋勇艳杰娟涛明超霞平刚英华文志晓雅子雨佳思语晨宇欣宁嘉沐知书'

const GIVEN2 =
  '婷怡欣悦然轩涵豪博文远强建国明红静涵欣怡豪翔宸瀚霖瑾瑜瑄瑞'

/** 确定性伪随机，保证每次生成的演示数据一致 */
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** 只保留汉字，避免任何非中文字符混入生成的姓名 */
function pick(pool: string, rng: () => number): string {
  let clean = ''
  for (const ch of pool) {
    if (/[\u4e00-\u9fa5]/.test(ch)) clean += ch
  }
  return clean[Math.floor(rng() * clean.length)]
}

function makeName(rng: () => number): string {
  const twoChar = rng() < 0.42
  return pick(SURNAMES, rng) + pick(GIVEN1, rng) + (twoChar ? '' : pick(GIVEN2, rng))
}

export function makeStudents(count: number, seed: number): Student[] {
  const rng = makeRng(seed)
  const used = new Set<string>()
  const out: Student[] = []
  for (let i = 1; i <= count; i++) {
    let name = makeName(rng)
    let guard = 0
    while (used.has(name) && guard++ < 60) name = makeName(rng)
    used.add(name)
    out.push({
      id: `s-${seed}-${i}`,
      studentNo: String(i),
      name,
      status: 'active',
      createdAt: Date.now(),
    })
  }
  return out
}

export function makeDemoClasses(): Klass[] {
  const now = Date.now()
  return [
    {
      id: 'c-demo-1',
      name: '高二(3)班',
      grade: '高二',
      year: '2025-2026',
      createdAt: now,
      students: makeStudents(45, 20250303),
    },
    {
      id: 'c-demo-2',
      name: '高二(7)班',
      grade: '高二',
      year: '2025-2026',
      createdAt: now,
      students: makeStudents(46, 20250707),
    },
  ]
}

/**
 * 拍照识别演示数据：在一份正确名单上人为制造几处典型问题，
 * 用于展示「重复学号 / 跳号 / 识别残缺」的校验交互。
 */
export function makeScanDemoRows() {
  const base: Array<[string, string]> = [
    ['1', '王志远'],
    ['2', '李思涵'],
    ['3', '张雨欣'],
    ['4', '刘佳怡'],
    ['5', '陈明轩'],
    ['6', '杨嘉豪'],
    ['7', '黄雅静'],
    ['8', '赵子涵'],
    ['9', '吴欣悦'],
    ['10', '周'],
    ['11', '徐博文'],
    ['12', '孙志强'],
    ['12', '马晓明'],
    ['14', '朱文华'],
    ['15', '胡静怡'],
    ['16', '郭思远'],
  ]
  return base.map(([studentNo, name]) => ({ studentNo, name }))
}

/* ---------------- S2：练习册模板（物理 · 教科版 必修第三册） ----------------
 *
 * ⚠️ 这 6 条是**物理**演示模板，而 `makeTemplates()` 在**云端模式也会被调用**
 *    （没有 templates 表，它们只存在本地 store）→ 语文老师一进来也会看见。
 *    所以每条都带上 `subjectCode`，新建作业页按当前学科过滤显示：
 *    选了语文就看不到这 6 条。历史遗留的本地模板没有 code，
 *    用 `subjectCodeOf()` 按显示名反查（`lib/subjects.ts`）。
 */
export function makeTemplates(): AssignmentTemplate[] {
  const physics = DEFAULT_SUBJECT_CODE
  return [
    {
      id: 't-19',
      name: '作业19 电路的基本概念',
      questionCount: 6,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 50,
    },
    {
      id: 't-20',
      name: '作业20 电阻定律',
      questionCount: 8,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 70,
    },
    {
      id: 't-21',
      name: '作业21 实验：描绘 I-U 特性曲线',
      questionCount: 6,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 50,
    },
    {
      id: 't-22',
      name: '作业22 电源 闭合电路欧姆定律',
      questionCount: 8,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 70,
    },
    {
      id: 't-23',
      name: '作业23 电功与电功率',
      questionCount: 7,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 60,
    },
    {
      id: 't-24',
      name: '作业24 多用电表的原理',
      questionCount: 6,
      subject: subjectName(physics),
      subjectCode: physics,
      score: 50,
    },
  ]
}

/* ---------------- 教师课表（演示） ---------------- */

export function makeDemoSchedule(classes: Klass[]): ScheduleItem[] {
  const a = classes[0]?.id
  const b = classes[1]?.id
  const aName = classes[0]?.name ?? '高二(3)班'
  const bName = classes[1]?.name ?? '高二(7)班'

  const P = [
    ['08:00', '08:45'],
    ['08:55', '09:40'],
    ['10:10', '10:55'],
    ['11:05', '11:50'],
    ['14:30', '15:15'],
    ['15:25', '16:10'],
    ['16:30', '17:15'],
    ['17:25', '18:10'],
  ]
  let n = 0
  const mk = (
    weekday: number,
    period: number,
    title: string,
    classId?: string,
    room?: string,
    kind: ScheduleKind = 'class',
  ): ScheduleItem => ({
    id: `sch-${++n}`,
    weekday,
    start: P[period - 1][0],
    end: P[period - 1][1],
    title,
    classId,
    room,
    kind,
    notify: kind === 'class',
  })

  return [
    mk(1, 1, `${aName} 物理`, a, '物理实验室'),
    mk(1, 3, `${bName} 物理`, b),
    mk(1, 6, `${aName} 习题课`, a),
    mk(2, 2, `${aName} 物理`, a),
    mk(2, 4, `${bName} 物理`, b, '物理实验室'),
    mk(2, 7, '物理教研组集体备课', undefined, '教研活动室', 'other'),
    mk(3, 1, `${bName} 物理`, b),
    mk(3, 3, `${aName} 物理`, a),
    mk(3, 5, `${aName} 实验课`, a, '物理实验室'),
    mk(4, 2, `${aName} 物理`, a),
    mk(4, 4, `${bName} 习题课`, b),
    mk(4, 5, '备课组活动', undefined, '办公室', 'other'),
    mk(5, 1, `${aName} 物理`, a),
    mk(5, 3, `${bName} 物理`, b),
    mk(5, 4, `${aName} 班会`, a, undefined, 'other'),
  ]
}

/* ---------------- S4：教室端一体机 ---------------- */

export function makeClassrooms(classes: Klass[]): ClassroomClient[] {
  const now = Date.now()
  return classes.map((c, i) => ({
    id: `room-${c.id}`,
    classId: c.id,
    name: `${c.name} 一体机`,
    // 演示：第一台在线、其余离线，用来体现"播报送达反馈"
    online: i === 0,
    lastSeenAt: i === 0 ? now : now - 3600_000,
  }))
}

/* ---------------- S3/S4：一份批改好的演示数据 ---------------- */

/**
 * 造一份"已经批改过"的错题记录，让统计页与呼叫页一打开就有内容。
 *
 * 不按概率随机：每题按**目标错误率精确取人**，既保证覆盖各个讲评档位，
 * 也给每个学生一个固定的"能力值"，让错得多的总是那几个人（关注名单才有意义）。
 */
function makeDemoGrading(students: Student[], questionCount: number): Assignment['wrong'] {
  const rng = makeRng(20250918)
  const n = students.length
  // 各题目标错误率，刻意覆盖「个别辅导 / 点到即止 / 优先精讲 / 精讲+查前置」
  const rates = [0.22, 0.07, 0.38, 0.13, 0.58, 0.76, 0.31, 0.12]

  const ability = students.map(() => rng())
  const wrong: Assignment['wrong'] = {}
  for (const s of students) wrong[s.studentNo] = []

  for (let q = 1; q <= questionCount; q++) {
    const target = Math.round(rates[(q - 1) % rates.length] * n)
    const picked = students
      .map((s, i) => ({ s, key: ability[i] * 0.62 + rng() * 0.38 }))
      .sort((a, b) => a.key - b.key)
      .slice(0, target)

    for (const { s } of picked) {
      if (q === 3) {
        // 第 3 题拆了两个小题，按小题记
        if (rng() < 0.78) wrong[s.studentNo].push('3.1')
        if (rng() < 0.58) wrong[s.studentNo].push('3.2')
      } else {
        wrong[s.studentNo].push(String(q))
      }
    }
  }

  for (const no of Object.keys(wrong)) if (!wrong[no].length) delete wrong[no]
  return wrong
}

/* ---------------- S2：演示作业档案 ---------------- */

/**
 * 演示档案的题目结构（等同于从 Word 稿识别出来的东西）。
 * 本地模式是明确标注的演示数据，这里补上题型/分值，好让「题型掌握情况」有东西可看。
 */
const DEMO_META_21: Record<string, QuestionMeta> = {
  '1': { kind: 'single', score: 4, optionCount: 4, points: ['ohm'], stem: '关于电流与电压的关系，下列说法正确的是' },
  '2': { kind: 'single', score: 4, optionCount: 4, points: ['ohm'], stem: '某导体两端电压为 3 V 时通过的电流是 0.2 A' },
  '3': { kind: 'experiment', score: 12, subCount: 2, points: ['meter-experiment'], stem: '用伏安法描绘小灯泡的 I-U 特性曲线' },
  '4': { kind: 'multiple', score: 6, optionCount: 4, points: ['ohm'], stem: '关于电阻定律，下列说法正确的是' },
  '5': { kind: 'calc', score: 12, points: ['closed-circuit'], stem: '如图所示的电路中，电源电动势与内阻已知，求各支路电流' },
  '6': { kind: 'calc', score: 12, points: ['power'], stem: '滑动变阻器接入电路，求其消耗的最大功率' },
}

export function makeDemoAssignments(classes: Klass[]): Assignment[] {
  const [a, b] = classes
  if (!a) return []
  const now = Date.now()
  const pickMissing = (count: number, idx: number[]) =>
    idx.map((n) => String(n)).filter((n) => Number(n) <= count)

  const out: Assignment[] = [
    {
      id: 'a-demo-1',
      title: '作业21 实验：描绘 I-U 特性曲线',
      classId: a.id,
      subject: subjectName(DEFAULT_SUBJECT_CODE),
      subjectCode: DEFAULT_SUBJECT_CODE,
      assignDate: isoOffset(-2),
      questionCount: 6,
      status: 'graded',
      templateId: 't-21',
      createdAt: now - 2 * 86400000,
      collected: true,
      missingNos: pickMissing(a.students.length, [7, 19, 33]),
      lateNos: pickMissing(a.students.length, [12]),
      subQuestions: { '3': 2 },
      questionMeta: DEMO_META_21,
      wrong: makeDemoGrading(a.students, 6),
      confirmedNos: a.students.filter((s) => s.status === 'active').map((s) => s.studentNo),
      // 改错名单 / 已改错 / 需重点关注 —— 让改错登记页在演示数据里就有内容
      correctionNos: a.students.filter((s) => s.status === 'active').slice(0, 12).map((s) => s.studentNo),
      correctedNos: a.students.filter((s) => s.status === 'active').slice(0, 5).map((s) => s.studentNo),
      focusNos: [a.students[2]?.studentNo, a.students[8]?.studentNo].filter(Boolean) as string[],
      gradeSeconds: 254,
      gradedAt: now - 2 * 86400000 + 7200_000,
    },
    {
      id: 'a-demo-2',
      title: '作业22 电源 闭合电路欧姆定律',
      classId: a.id,
      subject: subjectName(DEFAULT_SUBJECT_CODE),
      subjectCode: DEFAULT_SUBJECT_CODE,
      assignDate: isoOffset(-1),
      questionCount: 8,
      status: 'open',
      templateId: 't-22',
      createdAt: now - 86400000,
      collected: false,
      missingNos: [],
      lateNos: [],
      subQuestions: {},
      wrong: {},
      confirmedNos: [],
    },
    {
      id: 'a-demo-4',
      title: '作业23 电功与电功率',
      classId: a.id,
      subject: subjectName(DEFAULT_SUBJECT_CODE),
      subjectCode: DEFAULT_SUBJECT_CODE,
      assignDate: isoOffset(-1),
      questionCount: 7,
      status: 'collected',
      templateId: 't-23',
      createdAt: now - 86400000,
      collected: true,
      missingNos: pickMissing(a.students.length, [4, 26]),
      lateNos: [],
      subQuestions: {},
      wrong: {},
      confirmedNos: [],
    },
  ]

  if (b) {
    out.push({
      id: 'a-demo-3',
      title: '作业22 电源 闭合电路欧姆定律',
      classId: b.id,
      subject: subjectName(DEFAULT_SUBJECT_CODE),
      subjectCode: DEFAULT_SUBJECT_CODE,
      assignDate: isoOffset(-1),
      questionCount: 8,
      status: 'open',
      templateId: 't-22',
      createdAt: now - 86400000,
      collected: false,
      missingNos: [],
      lateNos: [],
      subQuestions: {},
      wrong: {},
      confirmedNos: [],
    })
  }
  return out
}

/* ============================================================
   考试（演示）—— 结构与分值**照一份真实的物理练习卷**
   ------------------------------------------------------------
   为什么用真结构而不是随便编 10 道题：这份演示数据的用途是让老师
   一眼看懂"考试统计长什么样"。测试数据本身是编的（虚拟姓名池），
   但**卷面结构用的是真实卷面**：
     单选 7×4 + 多选 3×6（选对不全按 m/n 给分）+ 非选择 6/10/10/12/16 = 100 分
   与 `data/examPresets.ts` 里物理那一档一致 —— 两边对不上就说明有一处写错了。

   🔴 演示数据只在**本地模式**（`isDemo`）出现，云端模式一律从空开始
      （见 `store.ts` 的 `initialState()`）。
   ============================================================ */

/** 演示卷的题目结构（题号 → 题型/满分/答案/知识点） */
const DEMO_EXAM_QUESTIONS: Record<string, ExamQuestion> = {
  '1': { no: 1, kind: 'single', fullScore: 4, answer: 'D', points: ['coulomb'], stem: '关于电场强度与电势，下列说法正确的是' },
  '2': { no: 2, kind: 'single', fullScore: 4, answer: 'A', points: ['coulomb'] },
  '3': { no: 3, kind: 'single', fullScore: 4, answer: 'B', points: ['ohm'] },
  '4': { no: 4, kind: 'single', fullScore: 4, answer: 'B', points: ['ohm'] },
  '5': { no: 5, kind: 'single', fullScore: 4, answer: 'C', points: ['closed-circuit'] },
  '6': { no: 6, kind: 'single', fullScore: 4, answer: 'D', points: ['closed-circuit'] },
  '7': { no: 7, kind: 'single', fullScore: 4, answer: 'A', points: ['power'] },
  '8': { no: 8, kind: 'multiple', fullScore: 6, answer: 'AC', points: ['power'] },
  '9': { no: 9, kind: 'multiple', fullScore: 6, answer: 'CD', points: ['meter-experiment'] },
  '10': { no: 10, kind: 'multiple', fullScore: 6, answer: 'BD', points: ['meter-experiment'] },
  '11': { no: 11, kind: 'experiment', fullScore: 6, points: ['meter-experiment'], stem: '力学实验：验证机械能守恒' },
  '12': { no: 12, kind: 'experiment', fullScore: 10, points: ['meter-experiment'], stem: '电学实验：测电源电动势与内阻' },
  '13': { no: 13, kind: 'calc', fullScore: 10, points: ['closed-circuit'], stem: '计算题：闭合电路欧姆定律（2 问）', subCount: 2 },
  '14': { no: 14, kind: 'calc', fullScore: 12, points: ['power'], stem: '计算题：电功率与效率（2 问）', subCount: 2 },
  '15': { no: 15, kind: 'calc', fullScore: 16, points: ['coulomb'], stem: '计算题：带电粒子在电场中的运动（3 问）', subCount: 3 },
}

/**
 * 造一份批阅完成的演示考试（含"没批改按 0 分"与一名缺考的样本）。
 * 与作业那套一样：**按目标得分率精确取人**，让分数分布有形状，
 * 而不是纯随机（纯随机的分布看不出统计页在干什么）。
 */
export function makeDemoExams(classes: Klass[]): { exams: Exam[]; scores: ExamScore[] } {
  const a = classes[0]
  const b = classes[1]
  if (!a) return { exams: [], scores: [] }

  const qs = Object.values(DEMO_EXAM_QUESTIONS)
  const build = (
    examId: string,
    klass: Klass,
    seed: number,
    /** 缺考的学号（不参与均分） */
    absent: string[],
    /** 刻意留几个没批改的（按 0 分计）—— 让统计页的"没批改"名单有内容 */
    ungraded: string[],
  ) => {
    const rng = makeRng(seed)
    const students = klass.students.filter((s) => s.status === 'active')
    // 每个学生一个固定"水平"，再加题目层面的抖动
    const ability = new Map(students.map((s) => [s.studentNo, 0.35 + rng() * 0.62]))
    const rows: ExamScore[] = []
    for (const s of students) {
      const lv = ability.get(s.studentNo) ?? 0.6
      const scores: Record<string, number> = {}
      const answers: Record<string, string> = {}
      for (const q of qs) {
        const roll = Math.min(1, Math.max(0, lv + (rng() - 0.5) * 0.45))
        if (q.kind === 'single') {
          // 单选：对就满分、错就 0
          if (rng() < roll) answers[String(q.no)] = q.answer ?? 'A'
          else {
            const wrong = 'ABCD'.replace(q.answer ?? 'A', '')
            answers[String(q.no)] = wrong[Math.floor(rng() * wrong.length)]
          }
        } else if (q.kind === 'multiple') {
          const key = (q.answer ?? 'AC').split('')
          // 三成概率只选对一部分（演示 m/n 判分在数据上真的会出现）
          const keep = rng() < roll * 0.75 ? key.length : Math.max(1, key.length - 1)
          answers[String(q.no)] = key.slice(0, keep).join('')
        } else {
          scores[String(q.no)] = Math.round(q.fullScore * Math.min(1, roll + rng() * 0.2))
        }
      }
      const merged = { scores, answers }
      if (absent.includes(s.studentNo)) {
        rows.push({
          id: `ex-${examId}-${s.studentNo}`,
          examId,
          classId: klass.id,
          studentNo: s.studentNo,
          name: s.name,
          scores: {},
          answers: {},
          graded: false,
          absent: true,
          createdAt: Date.now(),
        })
        continue
      }
      if (ungraded.includes(s.studentNo)) {
        rows.push({
          id: `ex-${examId}-${s.studentNo}`,
          examId,
          classId: klass.id,
          studentNo: s.studentNo,
          name: s.name,
          scores: {},
          answers: {},
          graded: false,
          absent: false,
          createdAt: Date.now(),
        })
        continue
      }
      rows.push({
        id: `ex-${examId}-${s.studentNo}`,
        examId,
        classId: klass.id,
        studentNo: s.studentNo,
        name: s.name,
        scores,
        answers,
        graded: true,
        absent: false,
        total: round2(totalOf({ questionCount: qs.length, questions: DEMO_EXAM_QUESTIONS, mode: 'answers' }, merged)),
        createdAt: Date.now(),
      })
    }
    return rows
  }

  const examA: Exam = {
    id: 'ex-demo-1',
    title: '物理练习8',
    paperKey: normalizePaperName('物理练习8'),
    subject: subjectName(DEFAULT_SUBJECT_CODE),
    subjectCode: DEFAULT_SUBJECT_CODE,
    scope: b ? 'grade' : 'class',
    grade: a.grade,
    source: 'manual',
    mode: 'answers',
    examDate: isoOffset(-3),
    questionCount: qs.length,
    questions: DEMO_EXAM_QUESTIONS,
    classIds: [a.id],
    absentNos: ['7'],
    status: 'graded',
    createdBy: 't-1',
    createdAt: Date.now() - 3 * 86400000,
    gradedAt: Date.now() - 3 * 86400000 + 5400_000,
  }

  const scores = build(examA.id, a, 20260920, ['7'], ['19', '33'])

  const exams: Exam[] = [examA]

  /*
   * 同年级的另一个班建一份**同场考试**的档案：
   * 这样"年级排名 / 班级 vs 年级"在演示数据里就有真东西可看
   * （两班档案靠 paperKey + 学科 + 年级 + 日期 合起来 —— 见 schema.sql §15.5）。
   */
  if (b) {
    const examB: Exam = {
      ...examA,
      id: 'ex-demo-2',
      classIds: [b.id],
      absentNos: ['12'],
      createdBy: 't-2',
      createdAt: Date.now() - 3 * 86400000,
    }
    exams.push(examB)
    scores.push(...build(examB.id, b, 20260921, ['12'], ['5', '28']))
  }

  return { exams, scores }
}
