import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCheck,
  IconDownload,
  IconEye,
  IconImage,
  IconList,
  IconTrash,
  IconUpload,
} from '../components/icons'
import { PageHead, Panel, Sect, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { connectionMode } from '../lib/supabase'
import {
  KIND_TEXT,
  canViewInline,
  deleteFile,
  humanSize,
  kindOf,
  listFiles,
  signedUrl,
  uploadFile,
  type SharedFile,
} from '../lib/files'

const MAX_MB = 20

/** 教师端：把讲评要用的文件传上去，教室端就能直接打开 */
export default function Files() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const classes = useStore((s) => s.classes)
  const teacherId = useStore((s) => s.teacher?.id)
  const remote = connectionMode() === 'remote'

  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<SharedFile[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [classId, setClassId] = useState('')

  const reload = async () => {
    try {
      setFiles(await listFiles())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!remote) {
      setLoading(false)
      return
    }
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote])

  const doUpload = async (list: FileList | null) => {
    if (!list?.length || !teacherId) return
    setErr('')
    let ok = 0
    for (const f of Array.from(list)) {
      if (f.size > MAX_MB * 1024 * 1024) {
        push({ text: `${f.name} 超过 ${MAX_MB} MB，跳过了`, tone: 'warn' })
        continue
      }
      setBusy(f.name)
      try {
        await uploadFile(f, teacherId, classId || undefined)
        ok++
      } catch (e) {
        setErr(`${f.name}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy('')
    if (ok) {
      push({ text: `已上传 ${ok} 个文件`, tone: 'ok' })
      await reload()
    }
  }

  const open = async (f: SharedFile) => {
    const url = await signedUrl(f.storagePath)
    if (!url) {
      push({ text: '取不到访问链接，重试一次', tone: 'bad' })
      return
    }
    window.open(url, '_blank', 'noopener')
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0)

  if (!remote) {
    return (
      <>
        <PageHead title="教室端文件" onBack={() => navigate('/settings')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
              这个功能要把文件存到云端，现在还没连接。
              <br />
              连上 Supabase 之后就能用了。
            </div>
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="教室端文件"
        sub={`${files.length} 个文件 · 共 ${humanSize(totalBytes)}`}
        onBack={() => navigate('/settings')}
      />

      <Page>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf,.html,.htm,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.mp4,.mov"
          className="hidden"
          onChange={(e) => {
            void doUpload(e.target.files)
            e.target.value = ''
          }}
        />

        {/* 上传 */}
        <div className="mb-4">
          <Sect>上传到教室端</Sect>
          <Panel bodyClass="p-3">
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 px-4 py-5"
              style={{
                border: '1px dashed var(--color-line2)',
                background: 'var(--color-surface2)',
                borderRadius: 6,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              <span style={{ color: 'var(--color-accent)' }}>
                <IconUpload size={22} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                {busy ? `正在上传 ${busy}…` : '选择文件'}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.6 }}>
                图片 / PDF / HTML 能在教室一体机上直接打开
                <br />
                PPT、Word 会以「下载」形式给到，用一体机的 Office 打开
              </span>
            </button>

            {classes.length ? (
              <label className="mt-3 block">
                <span className="label">给哪个班看（不选 = 所有班）</span>
                <select
                  className="input"
                  value={classId}
                  onChange={(e) => setClassId(e.target.value)}
                >
                  <option value="">所有班级</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              单文件限 {MAX_MB} MB —— 免费版存储只有 1 GB，<b>用完记得删</b>。
            </p>
          </Panel>
        </div>

        {err ? (
          <div
            className="mb-3 flex items-start gap-2 p-3"
            style={{
              background: 'var(--color-badsoft)',
              border: '1px solid ***REMOVED***f0c9c9',
              borderRadius: 6,
              fontSize: 12,
              color: '***REMOVED***8f2b2b',
              lineHeight: 1.6,
            }}
          >
            <span style={{ marginTop: 1, flexShrink: 0 }}>
              <IconAlert size={15} />
            </span>
            <span>{err}</span>
          </div>
        ) : null}

        {/* 列表 */}
        <div className="mb-4">
          <Sect>已上传</Sect>
          <Panel className="overflow-hidden">
            {loading ? (
              <div className="px-3 py-4" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                读取中…
              </div>
            ) : files.length === 0 ? (
              <div className="px-3 py-5 text-center" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                还没有文件。传一个试试，教室端会立刻出现。
              </div>
            ) : (
              files.map((f, i) => {
                const k = kindOf(f.name, f.mime)
                const viewable = canViewInline(k)
                return (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                    style={{
                      borderBottom:
                        i === files.length - 1 ? undefined : '1px solid var(--color-line)',
                    }}
                  >
                    <span
                      className="grid place-items-center shrink-0"
                      style={{
                        width: 32,
                        height: 32,
                        border: '1px solid var(--color-line2)',
                        borderRadius: 4,
                        background: 'var(--color-surface2)',
                        color: 'var(--color-ink2)',
                      }}
                    >
                      {k === 'image' ? <IconImage size={16} /> : <IconList size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>
                        {f.name}
                      </span>
                      <span
                        className="mt-0.5 flex items-center gap-2"
                        style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                      >
                        <Tag tone={viewable ? 'accent' : 'idle'}>{KIND_TEXT[k]}</Tag>
                        <span className="num">{humanSize(f.size)}</span>
                        {f.classId ? (
                          <span>{classes.find((c) => c.id === f.classId)?.name ?? ''}</span>
                        ) : (
                          <span>所有班</span>
                        )}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={viewable ? '打开' : '下载'}
                      onClick={() => void open(f)}
                      className="grid place-items-center shrink-0"
                      style={{ width: 32, height: 32, color: 'var(--color-accent)' }}
                    >
                      {viewable ? <IconEye size={16} /> : <IconDownload size={16} />}
                    </button>
                    <button
                      type="button"
                      aria-label="删除"
                      onClick={async () => {
                        try {
                          await deleteFile(f)
                          push({ text: '已删除', tone: 'warn' })
                          await reload()
                        } catch (e) {
                          setErr(e instanceof Error ? e.message : String(e))
                        }
                      }}
                      className="grid place-items-center shrink-0"
                      style={{ width: 32, height: 32, color: 'var(--color-ink4)' }}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                )
              })
            )}
          </Panel>
          <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}>
            <IconCheck size={12} /> 文件放在私有存储里，链接是限时的 —— 外人拿到地址也打不开。
          </p>
        </div>
      </Page>
    </>
  )
}
