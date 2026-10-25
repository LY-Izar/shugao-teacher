/**
 * `POST /api/admin/plugins/revoke` —— 超管**撤下一篇已放行的插件**（或恢复）。
 *
 * 请求体：`{ id, revoke?: boolean }`
 *
 * 🔴 为什么要有这条服务端出口（2026-10-25 用户报「面板里撤不下来」）：
 *   原来面板是**浏览器直接** `update plugin_registry set revoked_at=…`，
 *   而 PostgREST 在 RLS 挡住时回的是 **204 + 0 行、没有任何 error** ——
 *   界面拿不到 error 就显示"已撤下"，实际一行都没改。这就是"点了没反应"。
 *   服务端这条用**服务角色**（绕过 RLS，`plugin_registry_write` 那条策略本来就是
 *   `is_super_admin()`，这里先用同一个判据把门），并且**回读确认改了 1 行** ——
 *   改不到就明说"登记表里没有这条"，不再假装成功。
 *
 * 只动 `revoked_at`：不删行、不清 `stable_version`（撤版要能回滚，见 schema §45.1 的注释）。
 */

import { caller, json, rpcBool, needStage, read, svc } from '../../_lib/supa'
import type { PluginEnv } from '../../_lib/pluginRepo'

export const onRequestPost: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!isSuper) return json({ ok: false, why: '只有最高管理员能撤下插件' }, 403)

  let body: { id?: string; revoke?: boolean } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ ok: false, why: '请求体不是 JSON' }, 400)
  }
  const id = (body.id ?? '').trim()
  if (!id) return json({ ok: false, why: '缺 id' }, 400)
  /* 默认「撤下」：这个接口的常见用途就是撤版，恢复要显式传 `revoke: false` */
  const revoke = body.revoke !== false

  const res = await svc(env, `/rest/v1/plugin_registry?plugin_id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: revoke ? new Date().toISOString() : null }),
  })
  const out = await read(res)
  if (!out.ok) {
    const why = /source_commit|column .* does not exist/i.test(out.text)
      ? '数据库结构比这一版旧 —— 先把 supabase/schema.sql §45 补跑一次'
      : `改登记表失败：${out.text.slice(0, 160)}`
    return json({ ok: false, why }, 500)
  }
  /* 🔴 改到 0 行要**说出来**（这正是"点了没反应"的根源）：要么没这条，要么被挡住 */
  if (!out.rows.length) {
    return json({ ok: false, why: `登记表里没有 ${id} 这条 —— 它可能从来没发布过` }, 404)
  }

  return json({ ok: true, id, revoke, revoked: revoke })
}
