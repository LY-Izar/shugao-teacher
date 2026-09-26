import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconCalendar,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconGrid,
  IconList,
  IconPlus,
  IconUsers,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Tag } from '../components/ui'
import { WordImport } from '../components/WordImport'
import { useStore, useToast } from '../data/store'
import { UNASSIGNED_CLASS_ID, clampQuestionCount, isUnassigned } from '../lib/assignments'
import { ensureISO, isoOffset } from '../lib/date'
import { docxToParts } from '../lib/docx'
import { isAdminClass, isStreamClass } from '../lib/pick'
import {
  SUBJECTS,
  subjectCodeOf,
  subjectName,
  teacherPrimarySubjectCode,
  type SubjectCode,
} from '../lib/subjects'
import {
  KIND_TEXT,
  parseExam,
  resolveImages,
  toQuestionMeta,
  toSubQuestions,
  type ParsedExam,
  type ParsedQuestion,
} from '../lib/examParse'

export default function AssignmentNew() {
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const templates = useStore((s) => s.templates)
  const teacher = useStore((s) => s.teacher)
  const addAssignment = useStore((s) => s.addAssignment)
  const saveTemplate = useStore((s) => s.saveTemplate)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  /*
   * 🔴 默认选中的班（P5 的统一模型）：
   *    · `currentClassId` 是**当前班**，但它可能是走班班 → 走班作业挂走班班那一行，照收；
   *    · 否则退回**第一个行政班**（不是 `classes[0]`）——
   *      `classes` 是按 `created_at` 排的，走班班一旦建出来就可能排在前面，
   *      那时"默认班"会悄悄变成一个走班班（老师看不出区别，但那份作业收的是另一批人）。
   *    · 一个行政班都没有时才退回第一个班；仍然没有就留空。
   *    ⚠️ `UNASSIGNED`（空串）= **未归属**，由老师显式勾选，**绝不作为默认值** ——
   *      默认值必须是"有归属"的班，否则老师一点"建立"就建出一份谁也看不见的档案。
   */
  const adminClasses = useMemo(() => classes.filter(isAdminClass), [classes])
  const firstClass =
    currentClassId ??
    adminClasses[0]?.id ??
    classes[0]?.id ??
    ''
  /** 可以一次勾多个班 —— 提交时为每个班各建一份独立档案 */
  const [classIds, setClassIds] = useState<string[]>(firstClass ? [firstClass] : [])
  const [title, setTitle] = useState('')
  const [questionCount, setQuestionCount] = useState('6')
  const [assignDate, setAssignDate] = useState(isoOffset(-1))
  /**
   * 学科：**默认已经预选好**，来自老师自己的主学科（`teachers.primary_subject_code`，
   * 没设过就按显示名反查 → 字典兜底），所以老师不需要做任何额外操作。
   *
   * 🔴 反指标：每次作业教师新增手工录入字段数 = 0。
   *    · 它**不是必填校验**，也不参与"建立并去收缴"是否可点；
   *    · 用 chip 而不是下拉框/输入框：改选只要点一下，不改就一眼看见当前是哪一科；
   *    · 这里是 useState 初值 —— 页面挂在 `Guard` 里等 `hydrated` 之后，
   *      所以拿到的一定是已经就绪的老师（别改成在 effect 里补，那样晚到的数据
   *      会覆盖老师刚点的选择）。
   */
  const [subjectCode, setSubjectCode] = useState<SubjectCode>(() =>
    teacherPrimarySubjectCode(teacher),
  )
  /** 统计模式：普通 = 逐题记录；极简 = 只记优/良/差 */
  const [statsMode, setStatsMode] = useState<'normal' | 'simple'>('normal')
  const [templateId, setTemplateId] = useState<string | undefined>(undefined)
  const [alsoTemplate, setAlsoTemplate] = useState(false)

  /**
   * 只显示当前学科的练习册模板。
   *
   * 演示模板（`seed.ts` 的 6 条）是物理的，而 `makeTemplates()` 在**云端模式也会被调用**
   * （模板只存在本地 store，没有 templates 表）—— 不过滤的话，语文老师一进来
   * 就看见 6 个物理练习册模板。
   * 认不出学科的（历史遗留本地模板）**照常显示**：宁可多显示一条，
   * 也不能把老师自己存过的模板藏起来。
   */
  const shownTemplates = templates.filter((t) => {
    const c = subjectCodeOf(t)
    return !c || c === subjectCode
  })

  /** 换学科：顺手把不属于新学科的已选模板清掉，免得拿物理模板建语文作业 */
  const pickSubject = (code: SubjectCode) => {
    setSubjectCode(code)
    const picked = templates.find((t) => t.id === templateId)
    const pickedCode = subjectCodeOf(picked)
    if (pickedCode && pickedCode !== code) setTemplateId(undefined)
  }

  /* ---- Word 稿导入 ---- */
  const [parsed, setParsed] = useState<ParsedExam | null>(null)
  const [questions, setQuestions] = useState<ParsedQuestion[] | null>(null)
  const [parseErr, setParseErr] = useState('')
  const [parsing, setParsing] = useState(false)
  const [adopted, setAdopted] = useState(false)

  /** 预览用第一个班就够了（题干、人数只跟题目有关） */
  const klass = classes.find((c) => c.id === classIds[0])
  const n = clampQuestionCount(Number(questionCount) || 0)

  const handleFile = async (f: File) => {
    setParsing(true)
    setParseErr('')
    setParsed(null)
    setQuestions(null)
    setAdopted(false)
    try {
      const parts = await docxToParts(f)
      const r = parseExam(parts.text, f.name.replace(/\.docx$/i, ''))
      // 浮动锚定的图，XML 顺序和视觉顺序可能不一致 —— 必须让教师核对，不能默认它对
      if (parts.anchored > 0) {
        r.warnings.push(
          `这份稿子里有 ${parts.anchored} 张图是「浮动」排版，图与题号的对应关系可能不准，请对着下面的缩略图核对`,
        )
      }
      const lostFig = r.questions.filter((q) => q.imgs.length === 0 && q.figRefs > 0)
      if (lostFig.length) {
        r.warnings.push(
          `第 ${lostFig.map((q) => q.no).join('、')} 题的正文提到了图，但没找到对应图片 —— 请核对原稿`,
        )
      }
      if (r.questions.length === 0) {
        setParseErr(r.warnings[0] ?? '没有从这份稿子里识别出题目。')
      } else {
        setParsed(r)
        // Word 稿里与题号对齐的配图，挂到对应题目上（生成「错题重练」要用）
        setQuestions(resolveImages(r.questions, parts.images))
      }
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e))
    } finally {
      setParsing(false)
    }
  }

  const patchQuestion = (no: number, patch: Partial<ParsedQuestion>) =>
    setQuestions((prev) => prev?.map((q) => (q.no === no ? { ...q, ...patch } : q)) ?? prev)

  const adopt = () => {
    if (!questions?.length) return
    if (parsed?.title) setTitle(parsed.title)
    setQuestionCount(String(questions.length))
    setTemplateId(undefined)
    setAdopted(true)
    push({ text: `已采用 ${questions.length} 题的结构`, tone: 'ok' })
  }

  /** 只取前 n 题的结构，教师改了题量也不会对不上 */
  const structure = questions?.length
    ? {
        subQuestions: toSubQuestions(questions.filter((q) => q.no <= n)),
        questionMeta: toQuestionMeta(questions.filter((q) => q.no <= n)),
      }
    : {}

  /** 采用的题型分布，例：单选 5 · 多选 2 · 计算 3 */
  const kindSummary = (() => {
    const use = (questions ?? []).filter((q) => q.no <= n)
    if (!use.length) return ''
    const count = new Map<string, number>()
    for (const q of use) count.set(q.kind, (count.get(q.kind) ?? 0) + 1)
    return [...count.entries()].map(([k, c]) => `${KIND_TEXT[k as keyof typeof KIND_TEXT]} ${c}`).join(' · ')
  })()
  const subCount = (questions ?? []).filter((q) => q.no <= n && q.subCount > 1).length

  return (
    <>
      <PageHead
        title="新建作业档案"
        sub="有 Word 稿就导入，没有就手工填题量"
        onBack={() => navigate('/assignments')}
      />

      <Page>
        {classes.length === 0 ? (
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>
              还没有班级，请先到「班级」里建立班级并录入学生名单。
            </div>
            <Button
              className="mt-3"
              size="sm"
              variant="primary"
              onClick={() => navigate('/classes')}
            >
              去建立班级
            </Button>
          </Panel>
        ) : (
          <>
            {/* 第 1 步 · Word 稿导入 */}
            <div className="mb-4">
              <Sect>第 1 步 · 导入练习册电子稿（推荐）</Sect>
              <WordImport
                questions={questions}
                parsed={parsed}
                error={parseErr}
                busy={parsing}
                adopted={adopted}
                onFile={handleFile}
                onPatch={patchQuestion}
                onAdopt={adopt}
                onReset={() => {
                  setParsed(null)
                  setQuestions(null)
                  setParseErr('')
                  setAdopted(false)
                }}
              />
            </div>

            {/* 模板 */}
            <div className="mb-4">
              <Sect>第 2 步 · 或选练习册模板（可跳过）</Sect>
              <Panel bodyClass="p-3">
                {shownTemplates.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                    这一科还没有模板。下面勾上「存为模板」，下次就能一键带出。
                  </p>
                ) : (
                <div className="flex flex-wrap gap-2">
                  {shownTemplates.map((t) => {
                    const on = templateId === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          if (on) {
                            setTemplateId(undefined)
                            return
                          }
                          setTemplateId(t.id)
                          setTitle(t.name)
                          setQuestionCount(String(t.questionCount))
                        }}
                        className="flex items-center gap-2 px-2.5 py-2 text-left transition-all"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                          maxWidth: '100%',
                        }}
                      >
                        <IconClipboard size={15} />
                        <span style={{ fontSize: 12.5, fontWeight: 550 }} className="truncate">
                          {t.name}
                        </span>
                        <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                          {t.questionCount} 题
                        </span>
                        {on ? <IconCheck size={14} /> : null}
                      </button>
                    )
                  })}
                </div>
                )}
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.65 }}>
                  模板存的是「这个作业有几道题」，<b>按学科分开</b>（换了上面的学科，这里只显示这一科的）。
                  建过一次就永久复用 —— 之后批改页展开的题号就是 1…N，
                  <b>完全不依赖图像识别</b>。周末卷子直接手填题数即可。
                </p>
              </Panel>
            </div>

            {/* 基本信息 */}
            <div className="mb-4">
              <Sect>第 3 步 · 档案信息</Sect>
              <Panel bodyClass="p-4">
                {/*
                  学科 chip：**已经预选好了**（老师的主学科），所以它不是必填项、
                  也不拦着下面的按钮。想换一科点一下就行 —— 那是可选动作。
                */}
                <div className="mb-4">
                  <span className="label">学科</span>
                  <div className="flex flex-wrap gap-1.5">
                    {SUBJECTS.map((s) => {
                      const on = subjectCode === s.code
                      return (
                        <button
                          key={s.code}
                          type="button"
                          aria-pressed={on}
                          onClick={() => pickSubject(s.code)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 4,
                            fontSize: 12.5,
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                            fontWeight: on ? 650 : 500,
                          }}
                        >
                          {s.name}
                        </button>
                      )
                    })}
                  </div>
                  <p
                    style={{
                      fontSize: 11.5,
                      color: 'var(--color-ink3)',
                      marginTop: 6,
                      lineHeight: 1.6,
                    }}
                  >
                    默认按你的主学科（{subjectName(teacherPrimarySubjectCode(teacher))}）选好，不用管；
                    教别的科时点一下换掉。
                  </p>
                </div>

                <label className="block">
                  <span className="label">作业名称</span>
                  <input
                    className="input"
                    placeholder="例如 作业22 第 3 章练习"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value)
                      setTemplateId(undefined)
                    }}
                  />
                </label>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  {/* 极简模式不记题，题目数量没有意义 —— 直接不显示 */}
                  {statsMode === 'normal' ? (
                    <label>
                      <span className="label">题目数量</span>
                      <input
                        className="input num"
                        type="number"
                        min={1}
                        max={60}
                        value={questionCount}
                        onChange={(e) => setQuestionCount(e.target.value)}
                      />
                    </label>
                  ) : null}
                  <label>
                    <span className="label">布置日期</span>
                    <input
                      className="input"
                      type="date"
                      value={assignDate}
                      onChange={(e) => setAssignDate(ensureISO(e.target.value, assignDate))}
                    />
                    {/* 一体机上点原生日期控件很费劲，给三个最常用的快捷选项 */}
                    <div className="mt-1.5 flex gap-1.5">
                      {[
                        ['今天', 0],
                        ['昨天', -1],
                        ['前天', -2],
                      ].map(([label, off]) => {
                        const iso = isoOffset(off as number)
                        const on = assignDate === iso
                        return (
                          <button
                            key={label as string}
                            type="button"
                            onClick={() => setAssignDate(iso)}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 4,
                              fontSize: 12,
                              border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                              background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                              color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                              fontWeight: on ? 650 : 500,
                            }}
                          >
                            {label as string}
                          </button>
                        )
                      })}
                    </div>
                  </label>
                </div>

                {/* 统计模式 */}
                <div className="mt-4">
                  <span className="label">统计模式</span>
                  <div className="flex gap-2">
                    {(
                      [
                        ['normal', '普通模式', '逐题记录对错，能出错题统计与知识点分析'],
                        ['simple', '极简模式', '只记每人 优 / 良 / 差，不涉及具体题目'],
                      ] as const
                    ).map(([k, label, desc]) => {
                      const on = statsMode === k
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setStatsMode(k)}
                          className="flex-1 p-2.5 text-left"
                          style={{
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            borderRadius: 4,
                          }}
                        >
                          <span
                            style={{
                              display: 'block',
                              fontSize: 13.5,
                              fontWeight: on ? 680 : 550,
                              color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                            }}
                          >
                            {label}
                          </span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 11,
                              color: 'var(--color-ink3)',
                              lineHeight: 1.5,
                              marginTop: 2,
                            }}
                          >
                            {desc}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {statsMode === 'simple' ? (
                    <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.6 }}>
                      极简模式不进错题集，也没有逐题错误率 —— 只有等级分布。
                    </p>
                  ) : null}
                </div>

                {/* 题号预览 */}
                {statsMode === 'normal' ? (
                <div className="mt-4">
                  <span className="label">批改页将按这些题号展开</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: n }).map((_, i) => (
                      <span
                        key={i}
                        className="num grid place-items-center"
                        style={{
                          width: 26,
                          height: 26,
                          border: '1px solid var(--color-line2)',
                          borderRadius: 3,
                          background: 'var(--color-surface2)',
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--color-ink2)',
                        }}
                      >
                        {i + 1}
                      </span>
                    ))}
                  </div>
                </div>
                ) : null}
              </Panel>
            </div>

            {/* 班级 —— 可以**一次勾多个班**：同一份作业常常要布置给两个班 */}
            <div className="mb-4">
              <Sect>第 4 步 · 布置班级{classIds.length > 1 ? ` · 已选 ${classIds.length} 个` : ''}</Sect>
              <Panel bodyClass="p-3">
                <div className="flex flex-wrap gap-2">
                  {classes.map((c) => {
                    const on = classIds.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setClassIds((cur) =>
                            cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id],
                          )
                        }
                        className="flex items-center gap-2 px-3 py-2"
                        style={{
                          border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                          background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                          borderRadius: 4,
                          color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                        }}
                      >
                        <span
                          className="grid shrink-0 place-items-center"
                          style={{
                            width: 15,
                            height: 15,
                            borderRadius: 3,
                            border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                            background: on ? 'var(--color-accent)' : 'transparent',
                            /* 勾画在**实心 accent 块**上 → 暗色下它必须是近黑（见 index.css） */
                            color: 'var(--color-onaccent)',
                          }}
                        >
                          {on ? <IconCheck size={11} strokeWidth={3} /> : null}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 550 }}>{c.name}</span>
                        {/*
                          走班班也要能选中（P5：作业的归属可以是走班班那一行）。
                          只是标一个"走班"，因为它的"应交人数"来自成员关系而不是 `students`。
                        */}
                        {isStreamClass(c) ? <Tag tone="idle">走班</Tag> : null}
                        <span className="num" style={{ fontSize: 11.5, opacity: 0.75 }}>
                          {c.students.filter((s) => s.status === 'active').length} 人
                        </span>
                      </button>
                    )
                  })}
                  {/*
                    🔴 **未归属**（P5 第 5 条验收：`assignments.class_id` 可空之后，
                       "不属于任何班的作业"也能建）。它必须能被建、而且建完看得见 ——
                       数据库那侧的口径见 `schema.sql` §31.3：**只有 super/admin 与建档人自己**
                       能建未归属的档案，且**只有建档人自己看得见**（`teacher_id = auth.uid()`）。
                    ⚠️ 它**只是"这条归属通道"**，不是必填项：老师不点它，一切都和以前一样
                       （反指标：每次作业教师新增手工录入字段数 = 0）。
                  */}
                  {classes.length ? (
                    <button
                      type="button"
                      onClick={() => setClassIds([UNASSIGNED_CLASS_ID])}
                      className="flex items-center gap-2 px-3 py-2"
                      style={{
                        border: `1px solid ${
                          classIds.includes(UNASSIGNED_CLASS_ID)
                            ? 'var(--color-accent)'
                            : 'var(--color-line2)'
                        }`,
                        background: classIds.includes(UNASSIGNED_CLASS_ID)
                          ? 'var(--color-accentsoft)'
                          : 'var(--color-surface)',
                        borderRadius: 4,
                        color: classIds.includes(UNASSIGNED_CLASS_ID)
                          ? 'var(--color-accentink)'
                          : 'var(--color-ink2)',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 550 }}>未归属</span>
                    </button>
                  ) : null}
                </div>
                {classIds.length > 1 ? (
                  <p
                    style={{
                      fontSize: 11.5,
                      color: 'var(--color-ink3)',
                      marginTop: 8,
                      lineHeight: 1.7,
                    }}
                  >
                    会为这 <b className="num">{classIds.length}</b> 个班<b>各建一份独立档案</b>
                    （题目、分值、知识点共用），收缴与批改各算各的。
                  </p>
                ) : null}
              </Panel>
            </div>

            {/* 汇总 */}
            <Panel className="mb-4" bodyClass="p-3">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2" style={{ fontSize: 12.5 }}>
                <span className="flex items-center gap-1.5">
                  <IconClipboard size={14} />
                  {/*
                    ⚠️ 未归属那一档**不叫"未选班级"**：它是老师**明确选的**一种归属
                    （见上面那个「未归属」按钮），与"还没选"是两件事。
                  */}
                  {isUnassigned(classIds[0]) ? '未归属（走班）' : (klass?.name ?? '未选班级')}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconList size={14} />
                  {subjectName(subjectCode)}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconGrid size={14} />
                  <span className="num">{n}</span> 题
                </span>
                <span className="flex items-center gap-1.5">
                  <IconCalendar size={14} />
                  {assignDate}
                </span>
                <span className="flex items-center gap-1.5">
                  <IconUsers size={14} />
                  {/*
                    ⚠️ 走班班的"应交人数"**不在这里算**：它的人来自 `class_members`（多对多），
                    而那一列要按需懒加载（`loadClassMembers`，P7 的成员页才需要）。
                    写 0 会让人以为"这个班没人" —— 所以照实说清。
                  */}
                  {isStreamClass(klass) ? (
                    '走班班 · 应收按成员'
                  ) : (
                    <>
                      应交{' '}
                      <span className="num">
                        {klass?.students.filter((s) => s.status === 'active').length ?? 0}
                      </span>{' '}
                      人
                    </>
                  )}
                </span>
                {kindSummary ? (
                  <span className="flex items-center gap-1.5" style={{ color: 'var(--color-ink3)' }}>
                    <IconList size={14} />
                    {kindSummary}
                  </span>
                ) : null}
                {subCount > 0 ? (
                  <span className="flex items-center gap-1.5" style={{ color: 'var(--color-ink3)' }}>
                    <IconGrid size={14} />
                    <span className="num">{subCount}</span> 题含小问
                  </span>
                ) : null}
              </div>
            </Panel>

            <label className="mb-4 flex items-center gap-2.5 px-1" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={alsoTemplate}
                onChange={(e) => setAlsoTemplate(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: 'var(--color-accent)' }}
              />
              <span style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
                把「{n} 题」存为模板，下次一键带出
              </span>
            </label>

            <div className="flex gap-2">
              <Button
                block
                onClick={() => {
                  if (!classIds.length || !title.trim()) return
                  // 勾了几个班就建几份 —— 各算各的收缴与批改
                  for (const cid of classIds) {
                    addAssignment({
                      title,
                      classId: cid,
                      assignDate,
                      questionCount: n,
                      statsMode,
                      templateId,
                      subjectCode,
                      ...structure,
                    })
                  }
                  push({
                    text:
                      classIds.length > 1
                        ? `已为 ${classIds.length} 个班各建一份档案`
                        : '档案已建立',
                    tone: 'ok',
                  })
                  navigate('/assignments')
                }}
                disabled={!title.trim() || !classIds.length}
              >
                仅建立档案
              </Button>
              <Button
                block
                variant="primary"
                icon={<IconChevronRight size={16} />}
                disabled={!title.trim() || !classIds.length}
                onClick={() => {
                  if (!classIds.length || !title.trim()) return
                  let lastId = ''
                  for (const cid of classIds) {
                    lastId = addAssignment({
                      title,
                      classId: cid,
                      assignDate,
                      questionCount: n,
                      statsMode,
                      templateId,
                      subjectCode,
                      ...structure,
                    })
                  }
                  if (alsoTemplate) {
                    // 模板跟着当前选的学科走（以前这里写死 '物理'，与老师教什么无关）
                    saveTemplate({
                      name: title,
                      questionCount: n,
                      subject: subjectName(subjectCode),
                      subjectCode,
                    })
                    push({ text: '已存为模板', tone: 'ok' })
                  }
                  navigate(`/assignments/${lastId}/collect`)
                }}
              >
                建立并去收缴
              </Button>
            </div>

            {!title.trim() ? (
              <p
                style={{
                  fontSize: 12,
                  color: 'var(--color-ink3)',
                  textAlign: 'center',
                  marginTop: 8,
                }}
              >
                <IconPlus size={12} /> 填写作业名称后即可创建
              </p>
            ) : null}
          </>
        )}
      </Page>
    </>
  )
}
