/** Serve only the Git commit recorded by an active, reviewed registry row. */
import { json, read, svc } from '../_lib/supa'
import { allOk, fetchPlugin, probe, type PluginEnv } from '../_lib/pluginRepo'

export const onRequestGet: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const url = new URL(request.url)
  const id = (url.searchParams.get('id') ?? '').trim()
  const part = url.searchParams.get('part')
  if (!/^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9-]{2,31}$/.test(id) || !['manifest', 'module'].includes(part ?? '')) {
    return json({ ok: false, why: '插件请求不合法' }, 400)
  }
  const reg = await read(await svc(env, `/rest/v1/plugin_registry?select=plugin_id,stable_version,entry_sha256,permissions,source_commit,revoked_at,approved_reads&plugin_id=eq.${encodeURIComponent(id)}`))
  if (!reg.ok) return json({ ok: false, why: '插件登记表读取失败' }, 503)
  const row = reg.rows[0]
  const commit = String(row?.source_commit ?? '')
  if (!row?.stable_version || row.revoked_at || !/^[a-f0-9]{40}$/i.test(commit)) {
    return json({ ok: false, why: '插件未通过 Git 发布或已撤下' }, 404)
  }
  const fetched = await fetchPlugin(env, id, commit)
  if (!fetched.ok) return json({ ok: false, why: fetched.why }, 503)
  const f = fetched.files
  if (f.actualSha !== row.entry_sha256 || f.declaredSha.toLowerCase() !== f.actualSha ||
      f.manifest.id !== id || f.manifest.version !== row.stable_version ||
      JSON.stringify(f.manifest.permissions) !== JSON.stringify(row.permissions) || !allOk(probe(f, null))) {
    return json({ ok: false, why: 'Git 文件与已审核版本不一致' }, 409)
  }
  if (part === 'module') {
    return new Response(f.indexSource, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  const manifest = { ...f.manifest }
  const allowed = Array.isArray(row.approved_reads) ? new Set(row.approved_reads.map(String)) : new Set<string>()
  const approvedReads = Array.isArray(f.manifest.reads)
    ? (f.manifest.reads as Array<{ table?: string }>).filter((r) => !!r?.table && allowed.has(r.table))
    : []
  if (approvedReads.length) manifest.reads = approvedReads
  else {
    manifest.permissions = (manifest.permissions as string[]).filter((p) => p !== 'read')
    delete manifest.reads
  }
  return json({ ok: true, manifest, commit, sha256: f.actualSha })
}
