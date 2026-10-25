import { useCallback, useEffect, useState } from 'react'
import { Button } from './ui'
import { apiMessage, getApi, postApi } from '../lib/api'

/**
 * 「从插件库待审」—— 超管在 `/admin` 里**点一下**就能放行一个版本。
 *
 * 流程：列出 `plugin/*` 分支 → 点「检查」跑服务端探针 → 全绿才出现「通过并发布」。
 *
 * 🔴 三条不许在这里做的事（都是"看起来更快、其实更糟"）：
 *   ① **不在浏览器里算指纹、不在浏览器里判合规**：那两件事在
 *      `functions/api/_lib/pluginRepo.ts`，服务端算。浏览器只显示结果 ——
 *      否则改一下 JS 就能伪造一个绿点，超管照着绿点发布。
 *   ② **不自己拼发布参数**：版本、指纹、权限、配置 schema 全由服务端按 commit 重新取、
 *      重新算（`publish.ts` 的做法）。这里只发 `{id, commit}`。
 *   ③ **探针没全过不许出现发布按钮**：不给"明知红还点得下去"的机会。
 */
type PendingRow = { id: string; branch: string; commit: string; message: string; at: string }
type CheckLine = { id: string; name: string; ok: boolean; detail?: string; hint?: string }
type Inspect = {
  ok: boolean
  version?: string
  name?: string
  description?: string
  permissions?: string[]
  sha256?: string
  lines?: CheckLine[]
  pass?: boolean
  note?: string
  why?: string
}

export function PluginRepoPending({ onPublished }: { onPublished?: () => void }) {
  const [rows, setRows] = useState<PendingRow[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [seen, setSeen] = useState<Record<string, Inspect>>({})
  const [msg, setMsg] = useState('')
  /** 🔴 失败也必须一眼看出是失败：`msg` 原来固定用成功色渲染（2026-10-25 改） */
  const [msgBad, setMsgBad] = useState(false)

  /**
   * 只取数据、**不 setState** —— 这样 effect 里调它不会触发
   * `react/set-state-in-effect`（那条规则要的是"别在挂载那一帧同步写状态"）。
   */
  const fetchRows = useCallback(async () => getApi('/api/admin/plugins/pending'), [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await fetchRows()
      if (!alive) return
      if (!r.ok) {
        setRows([])
        setErr(apiMessage(r, '读不到插件库的待审分支'))
        return
      }
      setRows(Array.isArray(r.data.rows) ? (r.data.rows as PendingRow[]) : [])
    })()
    return () => {
      alive = false
    }
  }, [fetchRows])

  /** 刷新按钮用：清错 + 重取（在事件里 setState，规则不拦） */
  const reload = useCallback(async () => {
    setErr('')
    const r = await fetchRows()
    if (!r.ok) {
      setRows([])
      setErr(apiMessage(r, '读不到插件库的待审分支'))
      return
    }
    setRows(Array.isArray(r.data.rows) ? (r.data.rows as PendingRow[]) : [])
  }, [fetchRows])

  const inspect = useCallback(
    async (row: PendingRow) => {
      setBusy(row.id)
      setMsg('')
      const r = await getApi(
        `/api/admin/plugins/inspect?id=${encodeURIComponent(row.id)}&ref=${encodeURIComponent(row.commit)}`,
      )
      setSeen((prev) => ({ ...prev, [row.id]: (r.data as unknown as Inspect) ?? { ok: false, why: apiMessage(r, '检查失败') } }))
      setBusy('')
    },
    [],
  )

  const publish = useCallback(
    async (row: PendingRow) => {
      setBusy(row.id)
      setMsg('')
      setMsgBad(false)
      const r = await postApi('/api/admin/plugins/publish', { id: row.id, commit: row.commit })
      if (r.ok) {
        setMsgBad(false)
        setMsg(`已发布 ${String(r.data.name ?? row.id)} v${String(r.data.version ?? '')} —— 教室端下个轮询周期生效`)
        setSeen((prev) => {
          const next = { ...prev }
          delete next[row.id]
          return next
        })
        await reload()
        onPublished?.()
      } else {
        const lines = (r.data.lines as CheckLine[] | undefined) ?? []
        setMsgBad(true)
        setMsg(
          `${apiMessage(r, '发布失败')}${lines.length ? `（${lines.filter((l) => !l.ok).map((l) => l.id).join('、')} 没过）` : ''}`,
        )
      }
      setBusy('')
    },
    [reload, onPublished],
  )

  return (
    <div className="p-3" style={{ border: '1px solid var(--color-line2)', borderRadius: 6 }} data-admin-plugins-repo>
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontSize: 13, fontWeight: 650 }}>从插件库待审</span>
        <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
          开发者推 <span className="num">plugin/&lt;id&gt;</span> 分支后出现在这里
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void reload()}>
          刷新
        </Button>
      </div>

      {err ? (
        <div className="mt-2" style={{ fontSize: 12, color: 'var(--color-badink)' }} data-admin-plugins-repo-err>
          {err}
        </div>
      ) : null}
      {msg ? (
        <div
          className="mt-2"
          style={{ fontSize: 12, color: msgBad ? 'var(--color-badink)' : 'var(--color-okink)' }}
          data-admin-plugins-repo-msg
          data-bad={msgBad ? '1' : '0'}
        >
          {msg}
        </div>
      ) : null}

      {rows === null ? (
        <div className="mt-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          正在读…
        </div>
      ) : rows.length === 0 && !err ? (
        <div className="mt-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          没有待审分支。开发者把插件推到 <span className="num">plugin/&lt;id&gt;</span> 分支后，点「刷新」。
        </div>
      ) : null}

      {(rows ?? []).map((row) => {
        const res = seen[row.id]
        return (
          <div key={`${row.id}:${row.commit}`} className="mt-2 flex flex-col gap-1.5 p-2.5" style={{ border: '1px solid var(--color-line2)', borderRadius: 6 }} data-admin-pending-row={row.id}>
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ fontSize: 13, fontWeight: 650 }}>{row.id}</span>
              <span className="num" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                {row.branch} @ {row.commit.slice(0, 7)}
              </span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void inspect(row)}>
                {busy === row.id ? '检查中…' : '检查'}
              </Button>
              {res?.pass ? (
                <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void publish(row)}>
                  通过并发布
                </Button>
              ) : null}
            </div>
            {row.message ? (
              <div style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>{row.message}</div>
            ) : null}

            {res && !res.ok ? (
              <div style={{ fontSize: 12, color: 'var(--color-badink)' }}>{res.why ?? '检查失败'}</div>
            ) : null}

            {res?.lines ? (
              <div className="flex flex-col gap-1">
                <div style={{ fontSize: 12, color: 'var(--color-ink2)' }}>
                  {res.name} · <span className="num">v{res.version}</span> · 指纹{' '}
                  <span className="num">{String(res.sha256 ?? '').slice(0, 12)}…</span>
                  {res.permissions?.length ? ` · 能力 ${res.permissions.join('、')}` : ''}
                </div>
                {res.lines.map((l) => {
                  /* CF-12 是"读表清单"：一行一张表，长文本要能整段读，不能挤成一行被截掉。 */
                  const multi = l.id === 'CF-12'
                  return (
                    <div
                      key={l.id}
                      style={{
                        fontSize: 11.5,
                        color: l.ok ? 'var(--color-okink)' : 'var(--color-badink)',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      <div>
                        {l.ok ? '✅' : '❌'} <span className="num">{l.id}</span> {l.name}
                        {!multi && l.detail ? ` —— ${l.detail}` : ''}
                      </div>
                      {l.hint ? (
                        <div style={{ marginLeft: 16, fontSize: 11, color: 'var(--color-ink4)' }}>{l.hint}</div>
                      ) : null}
                      {multi && l.detail ? (
                        <div
                          style={{
                            marginLeft: 16,
                            marginTop: 2,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            lineHeight: 1.7,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {l.detail}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                <div style={{ fontSize: 11, color: 'var(--color-ink4)', lineHeight: 1.7 }}>{res.note}</div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
