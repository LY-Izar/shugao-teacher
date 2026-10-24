/**
 * `GET /api/admin/plugins/pending` —— 列出 `plugin/*` 分支（待审的插件）。
 *
 * 一个插件一个分支（插件库 README）⇒ 同一个 id 出现两次说明有人乱建分支，
 * 这里**如实全列**，让人看见，而不是替它挑一个。
 */

import { caller, json, rpcBool, needStage } from '../../_lib/supa'
import { listPending, type PluginEnv } from '../../_lib/pluginRepo'

export const onRequestGet: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!isSuper) return json({ ok: false, why: '只有最高管理员能审插件' }, 403)

  const r = await listPending(env)
  if (!r.ok) return json({ ok: false, why: r.why }, r.status)
  return json({ ok: true, rows: r.rows })
}
