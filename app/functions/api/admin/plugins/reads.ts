/** Change only the reviewed Git version's requested read-table subset. */
import { caller, json, needStage, read, rpcBool, svc } from '../../_lib/supa'
import { fetchPlugin, type PluginEnv } from '../../_lib/pluginRepo'

export const onRequestPost: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const superAdmin = await rpcBool(env, me.token, 'is_super_admin')
  if (superAdmin === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!superAdmin) return json({ ok: false, why: '只有最高管理员能更改插件读取范围' }, 403)
  let body: { id?: string; tables?: unknown } = {}
  try { body = await request.json() as typeof body } catch { return json({ ok: false, why: '请求体不是 JSON' }, 400) }
  const id = String(body.id ?? '')
  if (!/^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9-]{2,31}$/.test(id) ||
      !Array.isArray(body.tables) || body.tables.length > 12 ||
      body.tables.some((x) => typeof x !== 'string') ||
      new Set(body.tables).size !== body.tables.length) {
    return json({ ok: false, why: '读表范围不合法' }, 400)
  }
  const reg = await read(await svc(env, `/rest/v1/plugin_registry?select=source_commit,entry_sha256,stable_version,revoked_at&plugin_id=eq.${encodeURIComponent(id)}`))
  if (!reg.ok) return json({ ok: false, why: '登记表读取失败' }, 503)
  const row = reg.rows[0]
  const commit = String(row?.source_commit ?? '')
  if (!row || !/^[a-f0-9]{40}$/i.test(commit) || !row.stable_version) {
    return json({ ok: false, why: '此插件未从 Git 发布' }, 409)
  }
  const f = await fetchPlugin(env, id, commit)
  if (!f.ok || f.files.actualSha !== row.entry_sha256 || f.files.manifest.version !== row.stable_version) {
    return json({ ok: false, why: 'Git 文件与已发布版本不一致' }, 409)
  }
  const requested = new Set(Array.isArray(f.files.manifest.reads)
    ? (f.files.manifest.reads as Array<{ table?: string }>).map((x) => x.table)
    : [])
  if ((body.tables as string[]).some((table) => !requested.has(table))) {
    return json({ ok: false, why: '只能批准该版本提交时声明的表；新增表须重新提交 Git 版本' }, 409)
  }
  const out = await read(await svc(env, `/rest/v1/plugin_registry?plugin_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ approved_reads: body.tables, updated_by: me.id, updated_at: new Date().toISOString() }),
  }))
  if (!out.ok || out.rows.length !== 1) return json({ ok: false, why: '读取范围没有存进去' }, 500)
  return json({ ok: true, id, approved_reads: body.tables })
}
