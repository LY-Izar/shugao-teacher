import { useRef, useState } from 'react'
import { IconAlert, IconCheck, IconList, IconMinus, IconPlus, IconRefresh, IconUpload } from './icons'
import { Button, Panel, Tag } from './ui'
import { KIND_ORDER, KIND_TEXT, type ParsedExam, type ParsedQuestion } from '../lib/examParse'

/**
 * 从练习册 Word 稿导入作业结构。
 *
 * 两个刻意的设计：
 * 1. **文件不上传** —— 解析完全在本机浏览器里做（原生 DecompressionStream 解 zip）。
 *    教师的稿子不用过任何服务器。
 * 2. **识别结果必须过一遍人眼** —— 抽出来先摊开给教师看，能逐题改题型、分值、小问数。
 *    永远不静默采用。
 */
export function WordImport({
  questions,
  parsed,
  error,
  busy,
  adopted,
  onFile,
  onPatch,
  onAdopt,
  onReset,
}: {
  questions: ParsedQuestion[] | null
  parsed: ParsedExam | null
  error: string
  busy: boolean
  adopted: boolean
  onFile: (f: File) => void
  onPatch: (no: number, patch: Partial<ParsedQuestion>) => void
  onAdopt: () => void
  onReset: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const totalScore = (questions ?? []).reduce((n, q) => n + (q.score ?? 0), 0)
  const withSubs = (questions ?? []).filter((q) => q.subCount > 1).length
  const missingScore = (questions ?? []).filter((q) => q.score === undefined).length

  return (
    <Panel bodyClass="p-3.5">
      <input
        ref={inputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />

      {!questions ? (
        /* ---- 未导入：投放区 ---- */
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const f = e.dataTransfer.files?.[0]
            if (f) onFile(f)
          }}
          className="flex w-full flex-col items-center gap-2 px-4 py-6 transition-colors"
          style={{
            border: `1px dashed ${over ? 'var(--color-accent)' : 'var(--color-line2)'}`,
            background: over ? 'var(--color-accentsoft)' : 'var(--color-surface2)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          <span style={{ color: over ? 'var(--color-accent)' : 'var(--color-ink3)' }}>
            {busy ? <IconRefresh size={22} /> : <IconUpload size={22} />}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-ink)' }}>
            {busy ? '正在识别…' : '把练习册 Word 稿拖进来'}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.6 }}>
            或点击选择 .docx 文件 · 题量、题型、分值、小问自动识别
          </span>
        </button>
      ) : (
        /* ---- 已导入：核对表 ---- */
        <>
          <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="flex items-center gap-1.5" style={{ fontSize: 13, fontWeight: 620 }}>
              <IconCheck size={15} />
              {parsed?.title || '已识别'}
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={onReset}>
              重新选择
            </Button>
          </div>

          <div
            className="mb-2.5 flex flex-wrap items-center gap-x-4 gap-y-1"
            style={{ fontSize: 12, color: 'var(--color-ink2)' }}
          >
            <span className="num">{questions.length} 题</span>
            {totalScore > 0 ? <span className="num">总分 {totalScore}</span> : null}
            {withSubs > 0 ? <span className="num">{withSubs} 题含小问</span> : null}
          </div>

          {parsed?.warnings.length ? (
            <div
              className="mb-2.5 flex items-start gap-2 p-2.5"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 4,
                fontSize: 11.5,
                color: '***REMOVED***8a5a12',
                lineHeight: 1.6,
              }}
            >
              <span style={{ marginTop: 1, flexShrink: 0 }}>
                <IconAlert size={14} />
              </span>
              <span>{parsed.warnings.join('；')}</span>
            </div>
          ) : null}

          {/* 逐题核对 —— 题型点一下循环切换，小问数可加减 */}
          <div
            className="overflow-hidden"
            style={{ border: '1px solid var(--color-line)', borderRadius: 4 }}
          >
            <div className="max-h-[320px] overflow-y-auto">
              {questions.map((q) => (
                <div
                  key={q.no}
                  className="flex items-center gap-2 px-2.5 py-2"
                  style={{ borderBottom: '1px solid var(--color-line)' }}
                >
                  <span
                    className="num shrink-0 text-center"
                    style={{ width: 22, fontSize: 12.5, fontWeight: 700, color: 'var(--color-ink2)' }}
                  >
                    {q.no}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      const i = KIND_ORDER.indexOf(q.kind)
                      onPatch(q.no, { kind: KIND_ORDER[(i + 1) % KIND_ORDER.length] })
                    }}
                    className="shrink-0"
                    title="点一下切换题型"
                  >
                    <Tag tone={q.kind === 'other' ? 'idle' : 'accent'}>{KIND_TEXT[q.kind]}</Tag>
                  </button>

                  <input
                    className="input num shrink-0"
                    style={{ width: 48, padding: '2px 5px', fontSize: 12, textAlign: 'center' }}
                    value={q.score ?? ''}
                    placeholder="—"
                    inputMode="numeric"
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d.]/g, '')
                      onPatch(q.no, { score: v === '' ? undefined : Number(v) })
                    }}
                  />

                  <span
                    className="flex shrink-0 items-center"
                    title="小题数"
                    style={{ opacity: q.subCount > 1 ? 1 : 0.4 }}
                  >
                    <button
                      type="button"
                      className="grid place-items-center"
                      style={{ width: 26, height: 26 }}
                      onClick={() => onPatch(q.no, { subCount: Math.max(1, q.subCount - 1) })}
                    >
                      <IconMinus size={13} />
                    </button>
                    <span
                      className="num"
                      style={{ fontSize: 12, width: 16, textAlign: 'center', fontWeight: 600 }}
                    >
                      {q.subCount}
                    </span>
                    <button
                      type="button"
                      className="grid place-items-center"
                      style={{ width: 26, height: 26 }}
                      onClick={() => onPatch(q.no, { subCount: Math.min(9, q.subCount + 1) })}
                    >
                      <IconPlus size={13} />
                    </button>
                  </span>

                  <span
                    className="min-w-0 flex-1 truncate"
                    style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                    title={q.stem}
                  >
                    {q.stem || '（题干为空）'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            <span style={{ fontSize: 11.5, color: 'var(--color-ink3)', flex: 1, lineHeight: 1.6 }}>
              {missingScore > 0 ? `${missingScore} 题没识别到分值，可直接填` : '识别结果都能改'}
            </span>
            <Button size="sm" variant={adopted ? 'ghost' : 'primary'} onClick={onAdopt}>
              {adopted ? '已采用' : '采用这份结构'}
            </Button>
          </div>
        </>
      )}

      {error ? (
        <div
          className="mt-2.5 flex items-start gap-2 p-2.5"
          style={{
            background: 'var(--color-badsoft)',
            border: '1px solid ***REMOVED***f0c9c9',
            borderRadius: 4,
            fontSize: 11.5,
            color: '***REMOVED***8f2b2b',
            lineHeight: 1.6,
          }}
        >
          <span style={{ marginTop: 1, flexShrink: 0 }}>
            <IconAlert size={14} />
          </span>
          <span>
            {error}
            <br />
            也可以直接在下面手工填写题量建档，不影响使用。
          </span>
        </div>
      ) : null}

      {!questions && !error ? (
        <p
          className="mt-2.5 flex items-start gap-1.5"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.65 }}
        >
          <IconList size={13} />
          <span>
            文件只在本机解析，<b>不会上传</b>。识别不准时可以逐题改，或直接跳过这一步手工建档。
          </span>
        </p>
      ) : null}
    </Panel>
  )
}
