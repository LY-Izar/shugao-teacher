/* ============================================================
   考试 · 从「新教育」导出的成绩 xlsx 还原成一份考试档案
   ------------------------------------------------------------
   🔴 **AI/识别只是加速器**：这里解析出来的每一个字段都要在界面上摆给老师核对，
      老师确认之前一个字节都不落库（`ExamImport` 页面负责这件事）。
      解析结果里带 `warnings`，凡是"我猜的"都写清楚，不静默采用。

   文件形状（2026-09 真实导出的 `4-物理-物理练习8.xlsx`，已逐格核对）：

   sheet1「…-原始成绩」
     第 1 行  标题：`物理练习8-原始成绩`
     第 2 行  汇总：`已交人数：37，未交人数：1，班级均分：46.84`
     第 3 行  表头：学号 | 姓名 | 班级 | 总得分 | 客观题得分 | 主观题得分 | 班级排名 | 年级排名 | 1 | 2 | … | 15
     第 4 行  **满分行**：D=100（总分）、E=46（客观）、F=54（主观）；
              第 1–10 列（题 1–10）是**正确答案**（`D` / `AC` / `CD` …），
              第 11–15 列（题 11–15）是**该题满分**（6/10/10/12/16）
     第 5 行起 学生：前 10 题存**学生选的选项**，第 11–15 题存**该题得分**
     末尾    `未交名单：\n4：李思涵`

   sheet2「…-选项分布」
     `题号|正确答案|答错人数|答对人数|正答率（%）|选项人数|学生名单`，每题一组行，
     每行一个选项（`B：11人` + 该选项的学生名单）；多选那一段的列不一样
     （多出「半对人数/半对率/全对人数/全对率」）。

   ⚠️ **不用 `sharedStrings.xml`**：新教育导出的这份文件里它是空的（全部内联字符串）。
      `lib/xlsx.ts` 两种都认，所以不用特别处理。
   ============================================================ */

import type { SheetData } from './xlsx'
import { EXAM_KIND_TEXT, isChoiceKind, normalizeAnswer, round2 } from './examPaper'
import type { ExamQuestionKind } from './examPaper'

/* ---------------- 表头识别 ---------------- */

const HEAD = {
  no: ['学号', '考号', '考籍号'],
  name: ['姓名', '学生姓名'],
  klass: ['班级', '行政班', '教学班'],
  total: ['总得分', '总分', '得分'],
  objective: ['客观题得分', '客观题', '选择题得分'],
  subjective: ['主观题得分', '主观题', '非选择题得分'],
  classRank: ['班级排名', '班名次'],
  gradeRank: ['年级排名', '校排名', '年级名次'],
}

function findCol(header: string[], keys: string[]): number {
  for (const k of keys) {
    const i = header.findIndex((h) => h === k)
    if (i >= 0) return i
  }
  return -1
}

function num(raw?: string): number | undefined {
  const s = String(raw ?? '').trim()
  if (!s) return undefined
  const v = Number(s)
  return Number.isFinite(v) ? v : undefined
}

/* ---------------- 结果类型 ---------------- */

export type ImportedStudent = {
  studentNo: string
  name: string
  /** 文件里的班号（`4` 表示 4 班）—— 平台侧要老师确认对应哪个班 */
  fileClass: string
  total?: number
  objective?: number
  subjective?: number
  classRank?: number
  gradeRank?: number
  /** 题号 → 学生选的选项（只有选择题） */
  answers: Record<string, string>
  /** 题号 → 该题得分（非选择题，或文件直接给了分的选择题） */
  scores: Record<string, number>
  /** 原始行号（1 起），报错时好定位 */
  line: number
}

export type ImportedDistribution = {
  no: number
  answer: string
  /** 选项 → 人数 */
  options: Array<{ option: string; count: number; names: string[] }>
}

export type ExamImportResult = {
  /** 从 sheet 名/标题行认出来的试卷名（**老师可以改**） */
  title: string
  subjectName: string
  rows: ImportedStudent[]
  questions: Record<number, { fullScore: number; answer?: string; kind: ExamQuestionKind }>
  questionCount: number
  /** 汇总行里的话（"已交人数：37，未交人数：1，班级均分：46.84"） */
  summaryText: string
  /** 汇总行里的数字 */
  summary: { submitted?: number; absent?: number; avg?: number }
  /** 未交名单（姓名 + 文件里的班号） */
  absentNames: Array<{ fileClass: string; name: string }>
  /** 选项分布（sheet2），有就带上 —— 统计页可以跟本地算出来的对照 */
  distribution: ImportedDistribution[]
  /** 客观/主观满分（满分行给的；真实文件里这两格可能是空的） */
  objectiveFull?: number
  subjectiveFull?: number
  /** 选择题的题号 —— 导入预览里要按这个数量让老师填"每题几分" */
  choiceNos: number[]
  warnings: string[]
}

/* ---------------- 主函数 ---------------- */

export function parseExamWorkbook(sheets: SheetData[]): ExamImportResult {
  const warnings: string[] = []
  if (!sheets.length) throw new Error('这个文件里没有工作表')

  /* 找"原始成绩"那个 sheet：名字里带"成绩"或者第一个 */
  const scoreSheet =
    sheets.find((s) => /成绩/.test(s.name)) ??
    sheets.find((s) => /原始/.test(s.name)) ??
    sheets[0]
  const distSheet = sheets.find((s) => /选项|分布/.test(s.name))

  const rows = scoreSheet.rows
  const titleRaw = String(rows[0]?.[0] ?? '').trim()
  const summaryText = String(rows[1]?.[0] ?? '').trim()

  /* 表头行：在前 8 行里找含「学号」或「姓名」的那一行 */
  let headIdx = -1
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const r = rows[i] ?? []
    if (r.some((c) => HEAD.no.includes(c)) || r.some((c) => HEAD.name.includes(c))) {
      headIdx = i
      break
    }
  }
  if (headIdx < 0) {
    throw new Error('没找到表头（应含「学号」「姓名」）。这份文件可能不是新教育导出的成绩单')
  }
  const header = rows[headIdx]
  const col = {
    no: findCol(header, HEAD.no),
    name: findCol(header, HEAD.name),
    klass: findCol(header, HEAD.klass),
    total: findCol(header, HEAD.total),
    objective: findCol(header, HEAD.objective),
    subjective: findCol(header, HEAD.subjective),
    classRank: findCol(header, HEAD.classRank),
    gradeRank: findCol(header, HEAD.gradeRank),
  }
  if (col.no < 0) warnings.push('没找到「学号」列，只能按姓名匹配学生 —— 请重点核对')

  /* 满分行：表头下一行，第 4 列（总得分）像数字、且题号列是字母或数字 */
  const maxRow = rows[headIdx + 1] ?? []
  const firstQ = header.findIndex((h) => /^\d+$/.test(String(h).trim()))
  if (firstQ < 0) {
    throw new Error('没找到题号列（表头里应有 1、2、3… 这样的列名）')
  }
  /* 题号列一直到表头末尾（遇到空列名就停，别把后面的备注列算成题） */
  const qNos: number[] = []
  const qCol: number[] = []
  for (let i = firstQ; i < header.length; i++) {
    const n = Number(String(header[i] ?? '').trim())
    if (!Number.isFinite(n) || n <= 0) break
    qNos.push(n)
    qCol.push(i)
  }
  if (!qNos.length) throw new Error('题号列是空的')

  const totalFull = num(maxRow[col.total])
  const objectiveFull = num(maxRow[col.objective])
  const subjectiveFull = num(maxRow[col.subjective])
  if (totalFull && objectiveFull && subjectiveFull && totalFull !== objectiveFull + subjectiveFull) {
    warnings.push(
      `满分行里 总分 ${totalFull} ≠ 客观 ${objectiveFull} + 主观 ${subjectiveFull} —— 请核对这份文件`,
    )
  }

  /* 逐题：满分行是字母 → 选择题（值＝正确答案）；是数字 → 非选择题（值＝满分） */
  const questions: ExamImportResult['questions'] = {}
  const choiceNos = qNos.filter((no) => /^[A-Ha-h\s,，、]+$/.test(String(maxRow[qCol[qNos.indexOf(no)]] ?? '').trim()))
  /*
   * 选择题的满分：文件**不直接给**（满分行里那几格是答案）。
   * 推法：客观题满分 ÷ 选择题数量，**只在除得尽时**才推 —— 除不尽就留 0 让老师填。
   *
   * ⚠️ 真实经历：第一份导出文件里满分行是 `["","","","100","","","","","D","A",…]`
   *    —— **客观/主观两列是空的**，于是 10 道选择题一道都推不出满分。
   *    所以这条"推不出来"只报**一条**汇总告警 + 让老师在导入预览里填一个"每题分值"，
   *    不要每道题刷一条（10 条一样的告警等于没有告警）。
   */
  const perChoice =
    objectiveFull && choiceNos.length && objectiveFull % choiceNos.length === 0
      ? objectiveFull / choiceNos.length
      : 0
  for (const [k, no] of qNos.entries()) {
    const cell = String(maxRow[qCol[k]] ?? '').trim()
    if (!cell) {
      questions[no] = { fullScore: 0, kind: 'other' }
      warnings.push(`第 ${no} 题在满分行里是空的 —— 分值和答案都没识别出来，请手工补`)
      continue
    }
    if (/^[A-Ha-h\s,，、]+$/.test(cell)) {
      const ans = normalizeAnswer(cell)
      questions[no] = {
        fullScore: perChoice,
        answer: ans,
        // 答案多于 1 个字母就是多选
        kind: ans.length > 1 ? 'multiple' : 'single',
      }
    } else {
      const sc = num(cell)
      questions[no] = {
        fullScore: sc ?? 0,
        // 非选择题：题型**不确定**，先给"待定"让老师在预览里选（不猜）
        kind: 'other',
      }
      if (sc === undefined) warnings.push(`第 ${no} 题的满分「${cell}」认不出来，请手工填`)
    }
  }
  if (choiceNos.length && !perChoice) {
    warnings.push(
      `文件满分行里没给客观题满分（或除不尽），所以 ${choiceNos.length} 道选择题（第 ${choiceNos.join('、')} 题）的每题分值算不出来 —— ` +
        `请在下面填一个「选择题每题几分」，或者建档后到批阅页手工改`,
    )
  }

  /* 学生行 */
  const out: ImportedStudent[] = []
  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? []
    const line = i + 1
    const first = String(r[0] ?? '').trim()
    /* 汇总/页脚行：以「未交名单」「备注」等结尾信息开头 */
    if (/^(未交名单|缺考|备注|说明|合计|总计|未交)/.test(first) || /^(未交名单|缺考)/.test(String(r[col.name] ?? ''))) {
      break
    }
    const rawNo = col.no >= 0 ? String(r[col.no] ?? '').trim() : ''
    const rawName = String(r[col.name] ?? '').trim()
    if (!rawNo && !rawName) continue
    /* 满分行之后可能还有一行"（班级均分…）"之类的行 —— 没学号又没名字的跳过 */
    const studentNo = rawNo.replace(/[^\dA-Za-z]/g, '')
    if (!studentNo && !rawName) continue
    /*
     * 姓名里的修饰符：真实文件里出现过「☆张雨欣」（☆ = 某种标记）。
     * 平台的花名册里没有那个符号，**归一化掉**（并在预览里让老师看到原名）。
     */
    const name = rawName.replace(/^[☆★*·\s]+/, '').trim()

    const answers: Record<string, string> = {}
    const scores: Record<string, number> = {}
    for (const [k, no] of qNos.entries()) {
      const cell = String(r[qCol[k]] ?? '').trim()
      if (!cell) continue
      if (isChoiceKind(questions[no].kind)) {
        /* 选择题列：正常是选项；但有的导出会把✓/×或"满分"写进来 —— 认不出就跳过 */
        if (/^[A-Ha-h\s,，、]+$/.test(cell)) answers[no] = normalizeAnswer(cell)
      } else {
        const v = num(cell)
        /* 非选择题列：`*` 之类的占位符 → 跳过（该题按 0 分，并在预览里能看到） */
        if (v !== undefined) scores[no] = round2(v)
      }
    }

    out.push({
      studentNo: studentNo || name,
      name,
      fileClass: col.klass >= 0 ? String(r[col.klass] ?? '').trim() : '',
      total: col.total >= 0 ? num(r[col.total]) : undefined,
      objective: col.objective >= 0 ? num(r[col.objective]) : undefined,
      subjective: col.subjective >= 0 ? num(r[col.subjective]) : undefined,
      classRank: col.classRank >= 0 ? num(r[col.classRank]) : undefined,
      gradeRank: col.gradeRank >= 0 ? num(r[col.gradeRank]) : undefined,
      answers,
      scores,
      line,
    })
  }

  if (!out.length) throw new Error('没读到任何学生行 —— 请确认这份文件的表头与格式')

  /* 未交名单：`未交名单：\n4：李思涵` 或 `未交名单：4：李思涵；5：张三` */
  const absentNames: Array<{ fileClass: string; name: string }> = []
  for (const r of rows) {
    for (const cell of r) {
      const s = String(cell ?? '')
      if (!/未交名单|缺考/.test(s)) continue
      const body = s.replace(/^[\s\S]*?(未交名单|缺考)[:：]?/, '')
      for (const m of body.matchAll(/(\d+)\s*[:：]\s*([^\s；;、,，\n]+)/g)) {
        absentNames.push({ fileClass: m[1], name: m[2].trim() })
      }
    }
  }

  /* 汇总行解析：`已交人数：37，未交人数：1，班级均分：46.84` */
  const summary: ExamImportResult['summary'] = {}
  const pick = (label: string) => {
    const m = summaryText.match(new RegExp(`${label}\\s*[:：]\\s*([\\d.]+)`))
    return m ? Number(m[1]) : undefined
  }
  summary.submitted = pick('已交人数') ?? pick('实考人数') ?? pick('参考人数')
  summary.absent = pick('未交人数') ?? pick('缺考人数')
  summary.avg = pick('班级均分') ?? pick('均分') ?? pick('平均分')
  if (summary.absent && absentNames.length && summary.absent !== absentNames.length) {
    warnings.push(
      `汇总行说未交 ${summary.absent} 人，但名单里读到 ${absentNames.length} 人 —— 请核对`,
    )
  }
  if (summary.submitted && summary.submitted !== out.length) {
    warnings.push(
      `汇总行说已交 ${summary.submitted} 人，但学生表里有 ${out.length} 行 —— 可能有重名或有同学没出现在表里，请核对`,
    )
  }

  /* 选项分布（有就解析，没有也不报错 —— 它只是"对照用"） */
  const distribution = distSheet ? parseDistribution(distSheet) : []

  /* 试卷名：sheet 名优先（`物理练习8-原始成绩` → `物理练习8`），退回标题行 */
  const fromSheet = sheetTitle(scoreSheet.name)
  const fromRow = sheetTitle(titleRaw)
  const title = fromSheet || fromRow
  if (!title) warnings.push('没能从文件名或标题行认出试卷名，请手工填')

  /* 学科名：试卷名开头两个字里如果有学科名，就认出来；否则留空让老师选 */
  const subjectName = guessSubject(titleRaw || scoreSheet.name)

  return {
    title,
    subjectName,
    rows: out,
    questions,
    questionCount: qNos.length,
    summaryText,
    summary,
    absentNames,
    distribution,
    objectiveFull,
    subjectiveFull,
    choiceNos,
    warnings,
  }
}

/* ---------------- 选项分布 ---------------- */

function parseDistribution(sheet: SheetData): ImportedDistribution[] {
  const rows = sheet.rows
  const out: ImportedDistribution[] = []
  /* 表头可能有两段（单选一段、多选又一段），所以**遇到表头就重新对齐列** */
  let colNo = 0
  let colAnswer = 1
  let colOptions = -1
  let cur: ImportedDistribution | null = null
  for (const r of rows) {
    const first = String(r[0] ?? '').trim()
    if (first === '题号') {
      colNo = 0
      colAnswer = r.findIndex((c) => /正确答案/.test(c))
      colOptions = r.findIndex((c) => /选项人数|选项/.test(c))
      if (colAnswer < 0) colAnswer = 1
      if (colOptions < 0) colOptions = r.length - 2
      continue
    }
    if (!first && !String(r[1] ?? '').trim() && !String(r[colNo] ?? '').trim()) continue
    const noRaw = String(r[colNo] ?? '').trim()
    const ansRaw = String(r[colAnswer] ?? '').trim()
    const optRaw = String(r[colOptions] ?? '').trim()
    if (/^\d+$/.test(noRaw)) {
      cur = { no: Number(noRaw), answer: normalizeAnswer(ansRaw), options: [] }
      out.push(cur)
    }
    if (!cur) continue
    const m = optRaw.match(/^([A-H]+)\s*[:：]\s*(\d+)/)
    if (!m) continue
    const names = String(r[colOptions + 1] ?? '')
      .split(/[、,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
    cur.options.push({ option: m[1], count: Number(m[2]), names })
  }
  return out
}

/* ---------------- 小工具 ---------------- */

/** `物理练习8-原始成绩` → `物理练习8`；`物理练习8-选项分布` → `物理练习8` */
function sheetTitle(raw: string): string {
  let s = String(raw ?? '').trim()
  s = s.replace(
    /[-—_·\s]*(原始成绩|成绩单|原始数据|答卷|答题卡|成绩|数据|明细|选项分布|分布|导出|汇总|统计)$/g,
    '',
  )
  return s.trim()
}

/** 从试卷名/文件名里认学科。**只做字典里的精确前缀匹配**，认不出返回空串（不猜）。 */
function guessSubject(raw: string): string {
  const s = String(raw ?? '').replace(/^\d+[-—_·\s]*/, '').trim()
  const m = s.match(/^(语文|数学|英语|物理|化学|生物|政治|思想政治|历史|地理|信息技术|通用技术|体育|音乐|美术|心理健康)/)
  if (!m) return ''
  return m[1] === '思想政治' ? '政治' : m[1]
}

/** 给预览用的题型显示名 */
export function kindLabelOf(kind: ExamQuestionKind): string {
  return EXAM_KIND_TEXT[kind] ?? '待定'
}
