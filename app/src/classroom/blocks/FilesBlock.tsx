import { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '../../components/ui'
import {
  KIND_TEXT,
  canViewInline,
  fetchBlob,
  humanSize,
  kindOf,
  listFiles,
  type SharedFile,
} from '../../lib/files'
import {
  allFiles,
  clearFiles,
  openLocal,
  putFile,
  saveToDisk,
  type LocalFile,
} from '../../lib/localStore'
import { isRemote } from '../../lib/supabase'

/**
 * 「老师传来的文件」—— **本体功能块**（2026-10-24 用户改口：这是教室屏默认能力，不走插件）。
 *
 * 这一块是从旧教室端 `Classroom.tsx` 的同一块**逐行搬过来的**（行为一个字没改），
 * 搬的时候只换了两样东西：外面那层 `Panel` 由新壳的窗口标题栏代替；吐司走新壳的 `push`。
 *
 * 🔴 三条搬过来时必须一起搬的判据（少一条就退化成"屏上什么都不说"）：
 *   ① 读不到列表要**说出来**（旧实现曾经是 `catch { return }`，屏上挂"还没有文件"，
 *      值班老师会以为"没人传"而不是"这台机器读不到"）；
 *   ② 取回失败/打不开都要有话说（`openLocal` 返回结局这件事是 2026-10-03 补的，
 *      壳里"系统没有能打开它的程序"是真会发生的）；
 *   ③ 走班班的屏**不摆这一块**（Q17：只看作业与考试），连字节都不拉。
 *
 * ⚠️ 教室端对 `shared_files` 是**只读**（schema.sql §17.6 用户拍板），所以这里没有删除/上传，
 *    清理入口只有教师端「教室端文件」。
 */
export function FilesBlock({
  classId,
  className,
  streamMode,
  push,
}: {
  classId: string
  className: string
  /** 走班班（Q17）：整块不摆，也不拉字节 */
  streamMode: boolean
  push: (t: { text: string; tone: 'ok' | 'bad' | 'warn' | 'info'; desc?: string }) => void
}) {
  const [cloudFiles, setCloudFiles] = useState<SharedFile[]>([])
  const [localFiles, setLocalFiles] = useState<LocalFile[]>([])
  const [pulling, setPulling] = useState('')
  const [filesErr, setFilesErr] = useState('')

  const refreshLocal = useCallback(async () => {
    try {
      setLocalFiles(await allFiles())
    } catch {
      /* 本机库不可用时不影响上课 */
    }
  }, [])

  useEffect(() => {
    /* 异步读本机库：同步 setState 会触发级联渲染（oxlint react/set-state-in-effect） */
    let alive = true
    void (async () => {
      try {
        const list = await allFiles()
        if (alive) setLocalFiles(list)
      } catch {
        /* 本机库不可用时不影响上课 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!isRemote || streamMode || !classId) return
    let alive = true

    const pull = async () => {
      let pending: SharedFile[] = []
      try {
        /* 能读到哪些行由数据库读策略说了算（`shared_files_class_read`，schema §19.3）；
           前端**不再**按班级筛一遍 —— 那是"同一件事两个判定入口"（§11.3） */
        pending = await listFiles()
        if (alive) setFilesErr('')
      } catch (e) {
        if (alive) setFilesErr(e instanceof Error ? e.message : String(e))
        return
      }
      if (!alive) return

      const have = new Set((await allFiles()).map((f) => f.id))
      setCloudFiles(pending.filter((f) => !have.has(f.id)))

      for (const f of pending) {
        if (have.has(f.id) || !alive) continue
        setPulling(f.name)
        const blob = await fetchBlob(f.storagePath)
        if (!alive) return
        if (blob) {
          await putFile({
            id: f.id,
            name: f.name,
            mime: f.mime,
            size: f.size,
            blob,
            savedAt: Date.now(),
          })
        }
        setPulling('')
      }
      if (alive) await refreshLocal()
    }

    void pull()
    const t = window.setInterval(() => void pull(), 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [classId, streamMode, refreshLocal])

  if (streamMode) {
    return (
      <div className="grid h-full place-items-center p-4 text-center" style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
        走班班的屏只看作业和考试，这一块不摆
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {pulling ? (
        <div
          className="shrink-0 px-3 py-2"
          style={{
            fontSize: 12.5,
            color: 'var(--color-accenttext)',
            borderBottom: '1px solid var(--color-line)',
          }}
        >
          正在取回「{pulling}」…
        </div>
      ) : null}

      {filesErr ? (
        <div
          className="shrink-0 px-3 py-2.5"
          style={{
            fontSize: 12,
            color: 'var(--color-badink)',
            background: 'var(--color-badsoft)',
            borderBottom: '1px solid var(--color-badline)',
            lineHeight: 1.7,
          }}
        >
          读不到文件列表：{filesErr}
          <br />
          每隔一分钟会自动重试一次。
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {localFiles.length === 0 && cloudFiles.length === 0 ? (
          <div className="px-3 py-4" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
            {filesErr ? '(列表读不到，不代表没人传)' : <>这个班还没有文件</>}
          </div>
        ) : (
          <>
            {cloudFiles.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-3 px-3 py-2.5"
                style={{ borderBottom: '1px solid var(--color-line)' }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>
                    {f.name}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    <Tag tone="warn">待取回</Tag> <span className="num">{humanSize(f.size)}</span>
                  </span>
                </span>
              </div>
            ))}
            {localFiles.map((f, i) => {
              const k = kindOf(f.name, f.mime)
              const viewable = canViewInline(k)
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-3 px-3 py-2.5"
                  style={{
                    borderBottom: i === localFiles.length - 1 ? undefined : '1px solid var(--color-line)',
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>
                      {f.name}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      <Tag tone={viewable ? 'accent' : 'idle'}>{KIND_TEXT[k]}</Tag>{' '}
                      <span className="num">{humanSize(f.size || f.blob.size)}</span>
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant={viewable ? 'primary' : 'ghost'}
                    onClick={() => {
                      /* 不能看图/文档的那一类改走"另存为"——这是那台机器上唯一的出路 */
                      if (!viewable) {
                        void saveToDisk(f)
                        return
                      }
                      void openLocal(f).then((r) => {
                        if (r === 'opened') return
                        push({
                          text: '这台机器打不开它',
                          tone: 'bad',
                          desc: '系统里没有能打开这个文件的程序。要不改成另存为，放到电脑上再看？',
                        })
                      })
                    }}
                  >
                    {viewable ? '打开' : '下载'}
                  </Button>
                </div>
              )
            })}
          </>
        )}
      </div>

      <p
        className="shrink-0 px-3 py-2"
        style={{
          fontSize: 11.5,
          color: 'var(--color-ink3)',
          lineHeight: 1.7,
          borderTop: '1px solid var(--color-line)',
        }}
      >
        取回的文件已存在这台电脑上，断网也能打开。
        {localFiles.length ? (
          <>
            {' '}
            本机共 <span className="num">{localFiles.length}</span> 个 ·{' '}
            <span className="num">
              {humanSize(localFiles.reduce((n, f) => n + (f.size || f.blob.size), 0))}
            </span>
            <button
              type="button"
              style={{ marginLeft: 8, color: 'var(--color-bad)', textDecoration: 'underline' }}
              onClick={async () => {
                await clearFiles()
                await refreshLocal()
              }}
            >
              全部清理
            </button>
          </>
        ) : null}
        {' — '}
        {className}
      </p>
    </div>
  )
}
