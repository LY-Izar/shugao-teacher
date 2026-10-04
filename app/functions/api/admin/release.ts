/**
 * `POST /api/admin/release` —— **版本更新公告的唯一写出口 + 超管读两档状态**
 * （2026-10-04，施工单 `施工单-版本更新提示.md` §二.3）。
 *
 * ============================================================
 * 🔴 判据：`is_super_admin()`（服务端问数据库；前端一个字都不判）
 * ============================================================
 *   与维护模式同一条口径（`functions/api/admin/maintenance.ts` 的文件头写了理由）：
 *   发一条公告 = **全校（含教室端大屏）的旧版会被拦下来**，误触的代价是不对称的。
 *   `false` → **403**；函数没建（第 13 段没跑）→ **503「去跑第 13 段」**。
 *
 * ============================================================
 * 🔴 为什么**不塞进** `admin/maintenance.ts`（施工单 §二.3 点名的）
 * ============================================================
 *   维护是"**全站停**"、更新是"**版本落后**"：语义、豁免范围、失败代价都不同。
 *   揉一处以后一定有人改错其中一个（而改错的后果是"全校进不去"或"该拦的没拦"）。
 *   两档公告（教师端 / 教室端）之间也是**分开的**：一次发布只动一档。
 *
 * ============================================================
 * 🔴 写路径的"静默失败"必须堵死（本项目栽过的那一类）
 * ============================================================
 *   `PATCH ...?key=eq.release:teacher` 打在**一行都没有**的表上时，PostgREST 回 **204**，
 *   什么都不写、也不报错 —— 面板上会显示"发布成功"，而外面谁都没被拦。
 *   ⇒ 这里用 `Prefer: return=representation`，**回 0 行就显式报"去跑 §23.2.1"**。
 *   （维护那边用的是 `return=minimal`：它那一行是 `create table` 时就种下的，
 *     而版本更新这两行是后加的 —— 少跑一段就正好落进这个坑。）
 *
 * 环境变量：SUPABASE_URL / VITE_SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  type Read,
  anonKey,
  audit,
  baseUrl,
  caller,
  isMissing,
  json,
  read,
  rpcBool,
  serviceKey,
  svc,
} from '../_lib/supa'
import {
  NEED_RELEASE_SQL,
  RELEASE_KEYS,
  RELEASE_SELECT_COLS,
  RELEASE_TARGETS,
  type ReleaseTarget,
  isReleaseTarget,
  pickReleaseRow,
  publicReleaseRow,
  releaseFormFromBody,
  validateReleaseForm,
} from '../_lib/release'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin / can_manage_teachers）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

type Body = {
  action?: 'state' | 'set'
  /** 🔴 发布**哪一档**（认不出 → 400，**不许默认成教师端**） */
  target?: unknown
  /** set */
  enabled?: boolean
  version?: string
  force?: boolean | null
  note?: string
  urlApk?: string
  urlExe?: string
}

/** 面板要的那一份：预填字段（连没发布的草稿）+ 审计口 + "外面现在看到的是什么" */
function adminSlot(row: Record<string, unknown> | undefined) {
  return {
    /** 那一行**在不在**（不在 = §23.2.1 的两行种子没跑） */
    present: Boolean(row),
    enabled: row?.enabled === true,
    version: String(row?.version ?? ''),
    force: row?.force === true,
    note: String(row?.message ?? ''),
    urlApk: String(row?.url_apk ?? ''),
    urlExe: String(row?.url_exe ?? ''),
    /**
     * 🔴 服务端**算好**的那一份（`null` = 没在发）——
     *    面板上的预览必须用它，**不许前端自己拼**：否则"面板显示的和外面看到的"会分叉。
     */
    live: publicReleaseRow(row),
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
    updatedBy: row?.updated_by ? String(row.updated_by) : null,
  }
}

async function loadSlot(env: Env, target: ReleaseTarget): Promise<Read> {
  return read(
    await svc(
      env,
      `/rest/v1/site_state?select=${RELEASE_SELECT_COLS},updated_by,updated_at` +
        `&key=eq.${encodeURIComponent(RELEASE_KEYS[target])}`,
    ),
  )
}

export async function onRequestPost(context: { request: Request; env: Env }): Promise<Response> {
  const { request, env } = context

  if (!baseUrl(env) || !anonKey(env)) return json({ status: 'error', message: NEED_SUPABASE }, 503)
  if (!serviceKey(env)) return json({ status: 'error', message: NEED_SERVICE_KEY }, 503)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }
  const action = body.action ?? 'state'

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /* 🔴 本能力的全部安全性就在这一句（判据在数据库，不在这里重写规则） */
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!isSuper) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员能发布版本更新公告。它会把全校的旧版拦在门外' +
          '（含教室端大屏 —— 那台机器要人工去装一次），所以教务处 / 年级主任都不在这一档。',
      },
      403,
    )
  }

  /* ---------------- state：读两档（含没发布的草稿与审计口） ---------------- */
  if (action === 'state') {
    const slots: Record<string, ReturnType<typeof adminSlot>> = {}
    for (const target of RELEASE_TARGETS) {
      let r: Read
      try {
        r = await loadSlot(env, target)
      } catch (e) {
        return json(
          { status: 'error', message: `读版本公告失败：${e instanceof Error ? e.message : String(e)}` },
          502,
        )
      }
      if (!r.ok) {
        return json(
          { status: 'error', message: isMissing(r) ? NEED_RELEASE_SQL : `读版本公告失败：${r.text.slice(0, 200)}` },
          isMissing(r) ? 503 : 502,
        )
      }
      slots[target] = adminSlot(pickReleaseRow(r.rows, target))
    }
    return json({ status: 'ok', release: slots })
  }

  /* ---------------- set：发布 / 撤下**一档** ---------------- */
  if (action === 'set') {
    if (!isReleaseTarget(body.target)) {
      return json({ status: 'error', message: '要发布哪一档？教师端还是教室端（target）' }, 400)
    }
    const target: ReleaseTarget = body.target

    const form = releaseFormFromBody(body as Record<string, unknown>)
    const verdict = validateReleaseForm(form)
    if (!verdict.ok) {
      /* 五条校验各自带代号（R1…R5），界面上直接显示这句话 */
      return json({ status: 'error', rule: verdict.rule, message: verdict.error }, 400)
    }

    const patch = await read(
      await svc(env, `/rest/v1/site_state?key=eq.${encodeURIComponent(RELEASE_KEYS[target])}`, {
        method: 'PATCH',
        /* 🔴 `return=representation`：**回 0 行要能看见**（见文件头那一段） */
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          enabled: form.enabled,
          message: verdict.row.note,
          version: verdict.row.version,
          force: verdict.row.force,
          url_apk: verdict.row.urlApk,
          url_exe: verdict.row.urlExe,
          updated_by: me.id,
          updated_at: new Date().toISOString(),
        }),
      }),
    )
    if (!patch.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(patch) ? NEED_RELEASE_SQL : '写版本公告失败',
          detail: patch.text.slice(0, 200),
        },
        isMissing(patch) ? 503 : 502,
      )
    }
    if (patch.rows.length === 0) {
      /* 🔴 静默失败堵死：一行都没写上 = 面板会说"发布成功"而外面什么都没发生 */
      return json({ status: 'error', message: NEED_RELEASE_SQL, detail: 'PATCH 回了 0 行' }, 503)
    }

    const audited = await audit(env, {
      actorId: me.id,
      action: form.enabled ? 'release.publish' : 'release.unpublish',
      target: RELEASE_KEYS[target],
      detail: form.enabled
        ? `${target === 'classroom' ? '教室端' : '教师端'} · v${verdict.row.version} · ` +
          `${verdict.row.force ? '强制' : '选择性'} · 正文：${verdict.row.note.slice(0, 60)}` +
          ` · 链接：${verdict.row.urlApk ? '手机有' : '手机无'} / ${verdict.row.urlExe ? '电脑有' : '电脑无'}`
        : `${target === 'classroom' ? '教室端' : '教师端'}：已撤下（上次发的字段留着当下次预填）`,
      affected: 1,
    })

    return json({
      status: 'ok',
      release: { [target]: adminSlot(patch.rows[0]) },
      /** ⚠️ 留痕失败要把话说出来（它不是"没发生"，是"没记上"） */
      audited,
    })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/**
 * GET 回一份"接口活着"的自述 —— **不回任何状态**。
 * 用途只有一个：让人能确认"这个路径部署上去了没有"（否则 404 与 403 很难区分）。
 */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/admin/release',
    method: 'POST',
    body: {
      action: 'state | set',
      set: { target: 'teacher | classroom', enabled: true, version: '1.1.1', force: false, note: '…' },
    },
    note: '需要登录，且判据是数据库的 is_super_admin()',
  })
}
