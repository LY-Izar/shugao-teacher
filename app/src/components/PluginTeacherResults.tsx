import { useEffect, useState } from 'react'
import { loadPluginConfigs } from '../classroom/configs'
import { subscribe } from '../lib/realtime'
import { getSupabase, isRemote } from '../lib/supabase'
import { Panel } from './ui'

type ResultDecl = { key: string; label: string }
type PluginResults = { id: string; name: string; results: ResultDecl[] }
type ResultValue = { present: boolean; payload: unknown; updatedAt: string | null; error?: string }

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2) ?? 'null'
}

/** 教师端只展示已发布版本在 manifest.teacherResults 声明的槽。 */
export function PluginTeacherResults({ classId }: { classId: string }) {
  const [plugins, setPlugins] = useState<PluginResults[] | null>(null)
  const [values, setValues] = useState<Record<string, ResultValue>>({})
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!isRemote) return
    const sb = getSupabase()
    if (!sb) return
    let alive = true
    let catalogueRevision = 0
    const readRevisions = new Map<string, number>()
    let current: PluginResults[] = []
    const resultId = (pluginId: string, key: string) => `${pluginId}\u0000${key}`
    const readOne = async (pluginId: string, key: string) => {
      const id = resultId(pluginId, key)
      const revision = (readRevisions.get(id) ?? 0) + 1
      readRevisions.set(id, revision)
      try {
        const { data, error } = await sb.rpc('plugin_teacher_result' as never, {
          p_class_id: classId, p_plugin_id: pluginId, p_key: key,
        } as never)
        if (!alive || readRevisions.get(id) !== revision) return
        const body = data as { ok?: boolean; code?: string; present?: boolean; payload?: unknown; updated_at?: string } | null
        const item: ResultValue = error || !body?.ok
          ? { present: false, payload: null, updatedAt: null,
              error: error?.message ?? body?.code ?? '结果暂时读不到' }
          : { present: body.present === true, payload: body.payload, updatedAt: body.updated_at ?? null }
        setValues((before) => ({ ...before, [id]: item }))
      } catch (error) {
        if (alive && readRevisions.get(id) === revision) setValues((before) => ({ ...before, [id]: {
          present: false, payload: null, updatedAt: null, error: String(error),
        } }))
      }
    }
    const readAll = (rows: PluginResults[]) => {
      for (const plugin of rows) for (const result of plugin.results) void readOne(plugin.id, result.key)
    }
    const reload = async () => {
      const revision = ++catalogueRevision
      const [config, registry] = await Promise.all([
        loadPluginConfigs(classId),
        sb.from('plugin_registry').select('plugin_id,name,stable_version,revoked_at,results_schema'),
      ])
      if (!alive || catalogueRevision !== revision) return
      if (config.state !== 'ok' || registry.error) {
        setNotice(config.notice || registry.error?.message || '插件结果清单暂时读不到')
        return
      }
      const enabled = new Set(config.rows.filter((row) => row.enabled).map((row) => row.pluginId))
      current = (registry.data ?? []).filter((row) =>
        enabled.has(String(row.plugin_id)) && row.stable_version && !row.revoked_at && Array.isArray(row.results_schema),
      ).map((row) => ({
        id: String(row.plugin_id), name: String(row.name || row.plugin_id),
        results: (row.results_schema as ResultDecl[]).filter((item) => item && typeof item.key === 'string' && typeof item.label === 'string'),
      })).filter((row) => row.results.length)
      setPlugins(current)
      setNotice('')
      readAll(current)
    }
    void reload()
    const off = subscribe((message) => {
      if (message.type === 'pluginResult' && message.classId === classId &&
          current.some((plugin) => plugin.id === message.pluginId && plugin.results.some((result) => result.key === message.key)))
        void readOne(message.pluginId, message.key)
      if (message.type === 'realtimeReady' || message.type === 'pluginRegistry' ||
          (message.type === 'pluginConfigs' && message.classId === classId)) void reload()
    })
    const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
    const onOnline = () => void reload()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    const fallback = window.setInterval(() => { if (document.visibilityState === 'visible') void reload() }, 15 * 60_000)
    return () => {
      alive = false; off(); window.clearInterval(fallback)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [classId])

  return <Panel head="插件结果" className="mt-4" bodyClass="p-3">
    {!isRemote ? <p style={{ fontSize: 12 }}>本地演示没有已审核的插件结果。</p> : null}
    {notice ? <p style={{ fontSize: 12, color: 'var(--color-warn)' }}>{notice}</p> : null}
    {isRemote && !notice && plugins === null ? <p style={{ fontSize: 12 }}>正在读取插件结果…</p> : null}
    {isRemote && !notice && plugins?.length === 0 ? <p style={{ fontSize: 12, color: 'var(--color-ink3)' }}>当前班级启用的插件没有声明教师端结果。</p> : null}
    {plugins?.map((plugin) => <div key={plugin.id} className="mb-3 rounded-md border p-3" style={{ borderColor: 'var(--color-line2)' }}>
      <strong>{plugin.name}</strong>
      {plugin.results.map((result) => {
        const value = values[`${plugin.id}\u0000${result.key}`]
        return <div key={result.key} className="mt-2" style={{ fontSize: 12 }}>
          <div style={{ color: 'var(--color-ink3)' }}>{result.label}{value?.updatedAt ? ` · ${new Date(value.updatedAt).toLocaleString('zh-CN')}` : ''}</div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value?.error || (value ? value.present ? renderValue(value.payload) : '暂无结果' : '正在读取…')}</div>
        </div>
      })}
    </div>)}
  </Panel>
}
