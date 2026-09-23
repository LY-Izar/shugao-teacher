import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { WordImport } from '../components/WordImport'
import { IconCheck } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { docxToParts } from '../lib/docx'
import {
  parseExam,
  resolveImages,
  toQuestionMeta,
  type ParsedExam,
  type ParsedQuestion,
} from '../lib/examParse'

/**
 * 给**已有档案**补一次 Word 导入。
 *
 * 存在的理由：手工建的档案（只填了"几题"）没有 question_meta ——
 * 于是错题重练卷里没有图、没有分值、也没有知识点。
 * 以前只能删掉重建，那份档案上的批改记录就一起没了。
 *
 * 这里**只回填题目信息**，绝不动已有的收缴与批改数据。
 */
export default function AssignmentImport() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  const klass = useStore((s) => s.classes.find((c) => c.id === assignment?.classId))
  const updateAssignment = useStore((s) => s.updateAssignment)

  const [questions, setQuestions] = useState<ParsedQuestion[] | null>(null)
  const [parsed, setParsed] = useState<ParsedExam | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [adopted, setAdopted] = useState(false)

  if (!assignment) {
    return (
      <>
        <PageHead title="档案不存在" onBack={() => navigate('/assignments')} />
        <Page>
          <Empty icon={<IconCheck size={20} />} title="这份作业档案已被删除" />
        </Page>
      </>
    )
  }

  const handleFile = async (f: File) => {
    setBusy(true)
    setErr('')
    setParsed(null)
    setQuestions(null)
    setAdopted(false)
    try {
      const parts = await docxToParts(f)
      const r = parseExam(parts.text, f.name.replace(/\.docx$/i, ''))
      if (parts.anchored > 0) {
        r.warnings.push(
          `这份稿子里有 ${parts.anchored} 张图是「浮动」排版，图与题号的对应关系可能不准，请对着缩略图核对`,
        )
      }
      const lost = r.questions.filter((q) => q.imgs.length === 0 && q.figRefs > 0)
      if (lost.length) {
        r.warnings.push(`第 ${lost.map((q) => q.no).join('、')} 题提到了图但没找到图片 —— 请核对原稿`)
      }
      if (r.questions.length === 0) {
        setErr(r.warnings[0] ?? '没有从这份稿子里识别出题目。')
      } else {
        setParsed(r)
        setQuestions(resolveImages(r.questions, parts.images))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const patchQuestion = (no: number, patch: Partial<ParsedQuestion>) =>
    setQuestions((prev) => prev?.map((q) => (q.no === no ? { ...q, ...patch } : q)) ?? prev)

  const save = () => {
    if (!questions?.length) return
    const withImgs = questions.filter((q) => q.imgs.length > 0).length
    updateAssignment(id, {
      questionMeta: toQuestionMeta(questions),
      questionCount: questions.length,
    })
    push({
      text: `已导入 ${questions.length} 题的题目信息${withImgs ? `（含 ${withImgs} 张配图）` : ''}`,
      tone: 'ok',
    })
    navigate('/assignments')
  }

  return (
    <>
      <PageHead
        title="补导入题目"
        sub={`${klass?.name ?? '—'} · 原 ${assignment.questionCount} 题 → 以导入为准`}
        onBack={() => navigate('/assignments')}
      />

      <Page>
        <div
          className="mb-3 p-3"
          style={{
            background: 'var(--color-accentsoft)',
            border: '1px solid var(--color-line2)',
            borderRadius: 6,
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--color-accentink)',
          }}
        >
          只补<b>题目信息</b>（题量 / 题型 / 分值 / 知识点 / 配图）。
          这份档案已有的<b>收缴与批改记录不会被改动</b>。
        </div>

        <div className="mb-4">
          <Sect>导入练习册电子稿</Sect>
          <WordImport
            questions={questions}
            parsed={parsed}
            error={err}
            busy={busy}
            adopted={adopted}
            onFile={(f) => void handleFile(f)}
            onPatch={patchQuestion}
            onAdopt={() => {
              if (parsed) {
                setQuestions(parsed.questions)
                setAdopted(true)
              }
            }}
            onReset={() => {
              setParsed(null)
              setQuestions(null)
              setErr('')
              setAdopted(false)
            }}
          />
        </div>

        {questions?.length ? (
          <Panel bodyClass="p-3">
            <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <span>
                将写入 <b className="num">{questions.length}</b> 题的题目信息
              </span>
              <span className="flex-1" />
              <Button variant="primary" icon={<IconCheck size={16} />} onClick={save}>
                确认补导入
              </Button>
            </div>
          </Panel>
        ) : null}
      </Page>
    </>
  )
}
