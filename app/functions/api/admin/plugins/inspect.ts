/**
 * `GET /api/admin/plugins/inspect?id=<插件 id>&ref=<commit>` —— 服务端探针。
 *
 * 只读：取三件套 → 真算指纹 → 逐条给结论（不短路，超管要看到哪几条红）。
 * ⚠️ 这里**不能**跑运行期检查（Cloudflare 里不执行第三方 JS）⇒ 界面上必须如实写
 *    "运行期由提交方自检"，不许把静态通过说成"全过"。
 */

import { caller, json, rpcBool, needStage, read, svc } from '../../_lib/supa'
import { allOk, fetchPlugin, probe, type PluginEnv } from '../../_lib/pluginRepo'

export const onRequestGet: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!isSuper) return json({ ok: false, why: '只有最高管理员能审插件' }, 403)

  const url = new URL(request.url)
  const id = (url.searchParams.get('id') ?? '').trim()
  const ref = (url.searchParams.get('ref') ?? '').trim()
  if (!id || !ref) return json({ ok: false, why: '缺 id 或 ref' }, 400)

  /* 当前已放行的版本：给"版本只增"那一条当对照 */
  let prev: string | null = null
  const reg = await read(await svc(env, `/rest/v1/plugin_registry?select=stable_version&plugin_id=eq.${encodeURIComponent(id)}`))
  if (reg.ok && reg.rows[0]) {
    const v = reg.rows[0].stable_version
    prev = typeof v === 'string' && v ? v : null
  }

  const f = await fetchPlugin(env, id, ref)
  if (!f.ok) return json({ ok: false, why: f.why }, 404)

  const lines = probe(f.files, prev)
  return json({
    ok: true,
    id,
    ref,
    version: String(f.files.manifest.version ?? ''),
    name: String(f.files.manifest.name ?? ''),
    description: String(f.files.manifest.description ?? ''),
    permissions: Array.isArray(f.files.manifest.permissions) ? f.files.manifest.permissions : [],
    sha256: f.files.actualSha,
    declaredSha: f.files.declaredSha,
    lines,
    pass: allOk(lines),
    /* 界面上原样显示这句：不能让人以为"点通过就万事大吉" */
    note: '运行期（生命周期、配额、崩溃熔断）不在服务端探针里，由提交方用 plugin-framework-checks 自检。',
  })
}
