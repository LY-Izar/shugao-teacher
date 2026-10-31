import { useState } from 'react'
import { apiMessage, getApi, postApi } from '../lib/api'
import { Button } from './ui'

type ReadRequest = { table: string; why: string }

export function PluginReadGrants({ id, commit, approved, onSaved }: {
  id: string
  commit: string | null
  approved: string[]
  onSaved(): void
}) {
  const [open, setOpen] = useState(false)
  const [requested, setRequested] = useState<ReadRequest[] | null>(null)
  const [selected, setSelected] = useState<string[]>(approved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const inspect = async () => {
    if (!commit) return
    setOpen(true)
    setBusy(true)
    setError('')
    const r = await getApi(`/api/admin/plugins/inspect?id=${encodeURIComponent(id)}&ref=${encodeURIComponent(commit)}`)
    setBusy(false)
    if (!r.ok) { setError(apiMessage(r, '读取申请范围失败')); return }
    setRequested(Array.isArray(r.data.reads) ? r.data.reads as ReadRequest[] : [])
    setSelected(approved)
  }

  const save = async () => {
    setBusy(true)
    setError('')
    const r = await postApi('/api/admin/plugins/reads', { id, tables: selected })
    setBusy(false)
    if (!r.ok) { setError(apiMessage(r, '保存失败')); return }
    setOpen(false)
    onSaved()
  }

  if (!commit) return <span style={{ fontSize: 11, color: 'var(--color-warn)' }}>未关联 Git 提交</span>
  return <div style={{ width: '100%' }}>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => open ? setOpen(false) : void inspect()}>
      {open ? '收起读取范围' : `读取范围 · 已批准 ${approved.length} 张表`}
    </Button>
    {open ? <div className="mt-2 flex flex-col gap-2" style={{ fontSize: 12 }}>
      <div>只可批准该 Git 版本申请的表；新增申请须提交新版本。</div>
      {requested?.length === 0 ? <div>此版本没有申请直接读表。</div> : null}
      {(requested ?? []).map((item) => <label key={item.table} className="flex items-start gap-2">
        <input type="checkbox" checked={selected.includes(item.table)} disabled={busy}
          onChange={(e) => setSelected((before) => e.target.checked
            ? [...before, item.table]
            : before.filter((x) => x !== item.table))} />
        <span><strong>{item.table}</strong>：{item.why}</span>
      </label>)}
      {error ? <div style={{ color: 'var(--color-badink)' }}>{error}</div> : null}
      {requested ? <div><Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
        {busy ? '保存中…' : '保存批准范围'}
      </Button></div> : null}
    </div> : null}
  </div>
}
