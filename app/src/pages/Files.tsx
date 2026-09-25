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
  defaultFileClassIds,
  deleteFile,
  ensureFileClassCols,
  fileClassAssigned,
  fileClassLabel,
  humanSize,
  kindOf,
  listFiles,
  signedUrl,
  toggleFileClassIds,
  uploadFile,
  type SharedFile,
} from '../lib/files'

const MAX_MB = 20

/** 教师端：把讲评要用的文件传上去，教室端就能直接打开 */
export default function Files() {
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const classes = useStore((s) => s.classes)
  const currentClassId = useStore((s) => s.currentClassId)
  const teacherId = useStore((s) => s.teacher?.id)
  const remote = connectionMode() === 'remote'

  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<SharedFile[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  /*
   * 班级归属的勾选（用户口径 A：从**自己的教学班**里选，可以多选）。
   *
   * `picked === null` = 老师还没动过 → 用 `defaultFileClassIds()` 的**预填值**
   * （只教一个班就勾上那一个、在某个班的上下文里就勾那个班）——"能预填就预填"，
   * 别让他为了发一个文件先做一次选择。点过之后就以他的选择为准。
   *
   * ⚠️ 这个列表就是 `store.classes`，**已经是数据库 RLS 筛过的**（§11.3）：
   *    前端**不**再按 class_subjects 之类的东西滤一遍 —— 那是"同一件事两个判定入口"。
   *    数据库那一侧另有 `can_share_file_to_class` 判据守着同一件事（§19.4）。
   */
  const [picked, setPicked] = useState<string[] | null>(null)
  const classIds = picked ?? defaultFileClassIds(classes, currentClassId)
  /** `class_ids` 这一列在不在（线上库可能还没跑 §19）；不在就只能选一个班 */
  const [multiOk, setMultiOk] = useState(true)

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
    // 探一次「班级归属」那一列在不在（与 ensureSubjectCols 同一套纪律）
    let alive = true
    void ensureFileClassCols().then((c) => {
      if (alive) setMultiOk(c.classIds)
    })
    return () => {
      alive = false
    }
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
        await uploadFile(f, teacherId, classIds)
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
              <br />
              教室端会把文件存到<b>那台电脑上</b>，云端原件留着 —— 换一台教室电脑还能再取一次
            </span>
            </button>

            {/*
              班级归属（用户口径 A）：从**自己的教学班**里选，可以多选。
              · 只教一个班 / 在某个班的上下文里进来 → 已经预填好了，老师不用操作；
              · 一个都不勾 = 只有自己看得见（教室端看不到）—— 所以空着也要**说出来**，
                不能让他以为"默认发给所有班"（那是旧下拉框的语义，已经作废，见 §19.1）。
            */}
            {classes.length ? (
              <div className="mt-3">
                <span className="label">给哪些班看{multiOk ? '（可以多选）' : ''}</span>
                <div className="flex flex-wrap gap-1.5">
                  {classes.map((c) => {
                    const on = classIds.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPicked(toggleFileClassIds(classIds, c.id, multiOk))}
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
                        {c.name}
                      </button>
                    )
                  })}
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.6 }}>
                  {classIds.length === 0
                    ? '一个都没勾 → 只有你自己看得见（教室端看不到），随时可以再勾。'
                    : `已选 ${classIds.length} 个班：教室端只能看到勾上的班。`}
                  {/* 只是解释"为什么已经勾好了"——老师一动过（picked ≠ null）就不再解释 */}
                  {picked === null && classIds.length
                    ? classes.length === 1
                      ? ' 你只教这一个班，已经给你勾好了。'
                      : currentClassId && classIds.includes(currentClassId)
                        ? ' 默认按当前班级勾好了，要发给别的班就再点几个。'
                        : ''
                    : ''}
                </p>
                {multiOk ? null : (
                  <p style={{ fontSize: 11.5, color: 'var(--color-warn)', marginTop: 4, lineHeight: 1.6 }}>
                    线上数据库还没跑「班级归属」那一段（supabase/schema.sql 第 19 段）：
                    现在一个文件只能选一个班。
                  </p>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
                你名下还没有班级 —— 传上去只有你自己看得见（教室端看不到）。
                先建一个班、或让教导处把你的任课关系录进去。
              </p>
            )}

            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              单文件限 {MAX_MB} MB。教室端没开机时，文件会先在这儿等着。
              <br />
              ⚠️ 云端那份<b>不会</b>自动删（教室端是零写权限，删不动它）—— 不用了就在下面这一行删掉，
              免得占免费存储。
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
                        {/*
                          班级归属：空归属**必须写出来**（"未指派班级 · 教室端看不到"）——
                          显示成空白的话，老师会以为它已经发给教室了（文案只有 fileClassLabel 一处）。
                        */}
                        {fileClassAssigned(classes, f.classIds) ? (
                          <span>{fileClassLabel(classes, f.classIds)}</span>
                        ) : (
                          <Tag tone="warn">{fileClassLabel(classes, f.classIds)}</Tag>
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
