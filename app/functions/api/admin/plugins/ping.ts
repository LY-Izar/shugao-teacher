/**
 * `GET /api/admin/plugins/ping` —— 插件库配好了没有（超管）。
 *
 * 为什么单独有条 ping：环境变量漏配时，别的接口只会回一句"读不到"，
 * 而**漏配**和**GitHub 挂了**要修的地方完全不同。这条把两者分开。
 */

import { caller, json, rpcBool, needStage } from '../../_lib/supa'
import { NEED_PLUGIN_REPO, type PluginEnv } from '../../_lib/pluginRepo'

export const onRequestGet: PagesFunction<PluginEnv> = async ({ request, env }) => {
  const me = await caller(request, env)
  if (!me) return json({ ok: false, why: '请先登录' }, 401)
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ ok: false, why: needStage('§13', 'is_super_admin') }, 503)
  if (!isSuper) return json({ ok: false, why: '只有最高管理员能审插件' }, 403)

  const repo = (env.PLUGIN_REPO ?? '').trim()
  const token = (env.PLUGIN_REPO_TOKEN ?? '').trim()
  if (!repo) return json({ ok: false, repo: '', token: token ? 'configured' : 'missing', why: NEED_PLUGIN_REPO }, 200)

  /* 顺手真读一次：能读到才算"配好了"，只看变量在不在不算 */
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'shugao-pages',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  return json({
    ok: res.ok,
    repo,
    token: token ? 'configured' : 'missing',
    github: res.status,
    why: res.ok ? undefined : `GitHub 回了 ${res.status}${res.status === 403 ? '（多半是匿名限流，配 PLUGIN_REPO_TOKEN）' : ''}`,
  })
}
