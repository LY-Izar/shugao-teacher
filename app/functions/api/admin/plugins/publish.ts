/**
 * `POST /api/admin/plugins/publish` —— 超管**点一下**就放行一个版本。
 *
 * 请求体：`{ id, commit, note? }`
 *
 * 🔴 三条不信任客户端的做法（这是整个"面板一键发布"的闸门）：
 *   ① 版本、指纹、权限**一律由服务端按 commit 重新取、重新算**，不采用请求体里的值
 *      （否则改一下请求就能发布一个"没通过探针"的版本）；
 *   ② 探针有任何一条红 → **409 拒绝**，把红的条目回给界面；
 *   ③ 写库前再核一次"版本必须比已放行的大"——两个人同时点会撞车。
 *
 * 失败方向：宁可拒绝，也不许"探针没跑完就写进去"。
 */

import { caller, json, rpcBool, needStage, read, svc } from '../../_lib/supa'
import { allOk, fetchPlugin, probe, semverCmp, type PluginEnv } from '../../_lib/pluginRepo'

export const onRequestPost: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!isSuper) return json({ ok: false, why: '只有最高管理员能发布插件' }, 403)

  let body: { id?: string; commit?: string } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ ok: false, why: '请求体不是 JSON' }, 400)
  }
  const id = (body.id ?? '').trim()
  const commit = (body.commit ?? '').trim()
  if (!id || !commit) return json({ ok: false, why: '缺 id 或 commit' }, 400)

  /* ① 当前放行版本（也是"两个人同时点"的对照） */
  const reg = await read(await svc(env, `/rest/v1/plugin_registry?select=stable_version&plugin_id=eq.${encodeURIComponent(id)}`))
  const prevRaw = reg.ok && reg.rows[0] ? reg.rows[0].stable_version : null
  const prev = typeof prevRaw === 'string' && prevRaw ? prevRaw : null

  /* ② 服务端重新取 + 重新算 + 重新探 */
  const f = await fetchPlugin(env, id, commit)
  if (!f.ok) return json({ ok: false, why: f.why }, 409)

  const lines = probe(f.files, prev)
  if (!allOk(lines)) {
    return json({ ok: false, why: '探针没有全过，不能发布', lines }, 409)
  }

  const version = String(f.files.manifest.version ?? '')
  if (prev && semverCmp(version, prev) <= 0) {
    return json({ ok: false, why: `版本必须比已放行的 ${prev} 更大（本次 ${version}）` }, 409)
  }

  const row = {
    plugin_id: id,
    stable_version: version,
    entry_sha256: f.files.actualSha,
    permissions: Array.isArray(f.files.manifest.permissions) ? f.files.manifest.permissions : [],
    min_shell: String(f.files.manifest.minShellVersion ?? '0.0.0'),
    name: String(f.files.manifest.name ?? ''),
    description: String(f.files.manifest.description ?? ''),
    config_schema: (f.files.manifest.config as unknown) ?? null,
    source_commit: commit,
    released_at: new Date().toISOString(),
    revoked_at: null,
    updated_at: new Date().toISOString(),
    updated_by: me.id,
  }

  const res = await svc(env, '/rest/v1/plugin_registry?on_conflict=plugin_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([row]),
  })
  const out = await read(res)
  if (!out.ok) {
    const why = /source_commit/.test(out.text)
      ? '数据库还没有 source_commit 这一列 —— 先把 supabase/schema.sql §45 补跑一次'
      : `写登记表失败：${out.text.slice(0, 160)}`
    return json({ ok: false, why }, 500)
  }

  return json({ ok: true, id, version, commit, sha256: f.files.actualSha })
}
