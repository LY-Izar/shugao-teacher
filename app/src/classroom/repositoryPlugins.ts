import { useEffect, useRef, useState } from 'react'
import { apiUrl } from '../lib/apiBase'
import { validateManifest, type PluginManifest } from '../lib/pluginHost'
import { subscribe } from '../lib/realtime'
import { getSupabase, isRemote } from '../lib/supabase'
import { availablePlugins, type AvailablePlugin } from './demoPlugin'

type RegistryRow = {
  plugin_id: string
  stable_version: string | null
  source_commit: string | null
  entry_sha256: string | null
  approved_reads: string[] | null
  revoked_at: string | null
}

function revisionOf(row: RegistryRow): string {
  return `${row.source_commit}:${row.entry_sha256}:${[...(row.approved_reads ?? [])].sort().join(',')}`
}

async function loadOne(row: RegistryRow): Promise<AvailablePlugin> {
  const id = row.plugin_id
  const url = apiUrl(`/api/plugins/bundle?id=${encodeURIComponent(id)}`)
  const manifestReply = await fetch(`${url}&part=manifest`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!manifestReply.ok) throw new Error(`清单读取失败：${manifestReply.status}`)
  const body = await manifestReply.json() as { manifest?: PluginManifest; commit?: string; sha256?: string }
  const manifest = body.manifest
  if (!manifest || manifest.id !== id || manifest.version !== row.stable_version ||
      body.commit !== row.source_commit || body.sha256 !== row.entry_sha256 ||
      !validateManifest(id, manifest).ok) {
    throw new Error('清单与已发布版本不一致')
  }
  // 管理端可以收窄已发布插件的读表范围；宿主只给获批的那部分能力。
  const approved = new Set(row.approved_reads ?? [])
  const effectiveReads = manifest.reads?.filter((read) => approved.has(read.table)) ?? []
  const effectiveManifest: PluginManifest = { ...manifest, reads: effectiveReads.length ? effectiveReads : undefined,
    permissions: effectiveReads.length ? manifest.permissions : manifest.permissions.filter((permission) => permission !== 'read') }
  const moduleReply = await fetch(`${url}&part=module`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!moduleReply.ok) throw new Error(`入口下载失败：${moduleReply.status}`)
  const source = await moduleReply.text()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const sha = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')
  if (sha !== body.sha256) throw new Error('入口指纹不一致')
  // 文件由同源审核接口给出；blob 模块使打包壳也能热载，无需重新打 exe。
  const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const imported = await import(/* @vite-ignore */ objectUrl) as {
      default?: AvailablePlugin['module']
    }
    if (typeof imported.default?.activate !== 'function') throw new Error('入口缺少 activate')
    return { dirName: id, manifest: effectiveManifest, module: imported.default, source: 'downloaded', revision: revisionOf(row) }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/** Realtime invalidation + reconnect resync. The slow timer only repairs missed events. */
export function useRepositoryPlugins(): AvailablePlugin[] {
  const [plugins, setPlugins] = useState<AvailablePlugin[]>(() => isRemote ? [] : availablePlugins())
  const pluginsRef = useRef(plugins)
  useEffect(() => {
    if (!isRemote) return
    let alive = true
    let generation = 0
    let debounce: number | undefined
    const update = async () => {
      const current = ++generation
      const sb = getSupabase()
      if (!sb) return
      const { data, error } = await sb.from('plugin_registry')
        .select('plugin_id,stable_version,source_commit,entry_sha256,approved_reads,revoked_at')
      if (!alive || current !== generation || error) {
        if (error) console.warn('[plugin] 发布清单同步失败：', error.message)
        return
      }
      const live = (data as RegistryRow[] ?? []).filter((row) =>
        row.stable_version && row.source_commit && row.entry_sha256 && !row.revoked_at)
      // 撤版或收窄授权先停用旧实例，不等其他插件的 Git 下载完成。
      const retained = pluginsRef.current.filter((plugin) => live.some((row) =>
        row.plugin_id === plugin.manifest.id && plugin.revision === revisionOf(row)))
      if (retained.length !== pluginsRef.current.length) {
        pluginsRef.current = retained
        setPlugins(retained)
      }
      const old = new Map(pluginsRef.current.filter((p) => p.source === 'downloaded').map((p) => [p.manifest.id, p]))
      const loaded = await Promise.allSettled(live.map((row) => {
        const prior = old.get(row.plugin_id)
        return prior?.revision === revisionOf(row) ? Promise.resolve(prior) : loadOne(row)
      }))
      if (!alive || current !== generation) return
      const next = live.flatMap((row, i) => {
        const result = loaded[i]
        if (result.status === 'fulfilled') return [result.value]
        console.error('[plugin] Git 插件加载失败：', row.plugin_id, result.reason)
        const prior = old.get(row.plugin_id)
        return prior?.revision === revisionOf(row) ? [prior] : []
      })
      pluginsRef.current = next
      setPlugins(next)
    }
    const schedule = () => {
      if (debounce !== undefined) window.clearTimeout(debounce)
      debounce = window.setTimeout(() => { debounce = undefined; void update() }, 100)
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') schedule() }
    const off = subscribe((message) => {
      if (message.type === 'pluginRegistry' || message.type === 'realtimeReady') schedule()
    })
    window.addEventListener('online', schedule)
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
    const safety = window.setInterval(schedule, 15 * 60_000)
    return () => {
      alive = false
      generation += 1
      off()
      window.removeEventListener('online', schedule)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(safety)
      if (debounce !== undefined) window.clearTimeout(debounce)
    }
  }, [])
  return plugins
}
