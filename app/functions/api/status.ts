/**
 * `GET /api/status` —— **全站维护状态的公开唯一出口**（2026-09-29 管理台第二期）。
 *
 * 设计见 `管理台第二期方案.md` §二.3 · 落地口径见 `功能设计与不变量.md` §二十五。
 *
 * ============================================================
 * 🔴 它回什么：**恰好四个字段**（多一个都是泄露面）
 * ============================================================
 *   `{ enabled: boolean, message: string, until: string | null, release: ReleaseBlock }`
 *
 *   · `enabled` 是**算出来的**（不是 `site_state.enabled` 原值）：到点自动开、
 *     到点自动关都落在这一处（`_lib/maintenance.ts` 的 `maintenanceEffective()`）。
 *   · **`updated_by` / `updated_at` / `scheduled_from` 一个都不回** ——
 *     "谁开的维护"是内部信息（方案 §4.1 那一行写明了）。
 *     这条纪律被 `admin-checks.mjs` 逐字断言：响应 JSON 的键集合必须相等。
 *   · 🆕 **`release`（2026-10-04）**：两档版本更新公告，与维护**共用这一次请求**
 *     （施工单 §二.4「与维护共用同一次请求，不许再开一个轮询」）。
 *     形状 = `{ read: 'ok' | 'failed', reason: string, teacher: Row | null, classroom: Row | null }`，
 *     其中 `Row` 的**字段名与 `site_state` 的列名逐字相同**
 *     （`enabled / version / force / message / url_apk / url_exe`）——
 *     这样客户端与 worker 用的是**同一个** `releaseFromRow()`，不存在第二种解析。
 *     ⚠️ 没发布那一档回 `null`：**上次填的版本号与链接不外泄**（匿名接口，多一个字段都是泄露面）。
 *     ⚠️ 版本公告那两次查询**与维护那一次分开**：合成一次的话，维护状态会被另一档
 *        的读失败连累（fail-open 的爆炸半径越小越好）。
 *
 * ============================================================
 * 🔴 匿名可读，而且是**故意的**
 * ============================================================
 *   未登录的人（登录页）与教室端那台一体机都必须知道"现在进不去"，
 *   以及"我这一版要不要更新"（更新提示在登录页上就要能弹 —— 否则
 *   「登录之后只能看见提示」这句话对没登录的设备不成立）。
 *   `site_state` 那张表**一条策略都没有、连 SELECT 都没给** —— 所以这个接口
 *   是**唯一**能读到它的地方（`site_state` 里将来放别的东西也不会跟着泄露）。
 *
 * ============================================================
 * 🔴 读不到时**按"未维护"处理**（fail-open），但必须让调用方看得出来
 * ============================================================
 *   反过来（读不到就算维护中）会让**一次接口抖动锁死全校**。
 *   所以这里不返回"假的 false"，而是回 **503 + 一个只有 `error` 字段的体**：
 *   前端看到非 200 → 按未维护放行，但**面板上必须显式写"维护状态：读不到"**（灰）。
 *   ⚠️ 503 的体里**不许出现 `enabled` / `until`** —— 那是"看起来像结论"的假结论。
 *   🆕 版本公告那一档**不跟着 503**：它自己带 `read: 'failed'` + `reason`，
 *      前端按"没有公告"放行、面板上如实写"读不到"（**不许写成"已是最新"**）。
 *
 * 部署：<项目根>/functions/api/status.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量：SUPABASE_URL / VITE_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
 *   （anon key 也用得上：本文件不校验调用者，但 `_lib/supa.ts` 的统一形状要求它）
 */

import {
  type Env,
  baseUrl,
  json,
  needStage,
  read,
  serviceKey,
  svc,
} from './_lib/supa'
import {
  MAINTENANCE_DEFAULT_MESSAGE,
  maintenanceEffective,
  type MaintenanceState,
} from './_lib/maintenance'
import { loadPublicReleases } from './_lib/release'

/** 从数据库那一行（`select=enabled,message,until,scheduled_from`）归一成状态 */
function toState(row: Record<string, unknown> | undefined): MaintenanceState {
  const ms = (v: unknown): number | null => {
    if (!v) return null
    const t = Date.parse(String(v))
    return Number.isFinite(t) ? t : null
  }
  return {
    enabled: row?.enabled === true,
    message: String(row?.message ?? ''),
    until: ms(row?.until),
    scheduledFrom: ms(row?.scheduled_from),
  }
}

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const { env } = context

  if (!baseUrl(env)) {
    return json({ error: '服务端缺少 SUPABASE_URL / VITE_SUPABASE_URL —— 维护状态读不到' }, 503)
  }
  if (!serviceKey(env)) {
    return json(
      {
        error:
          '服务端还没配置管理员密钥（SUPABASE_SERVICE_ROLE_KEY）—— 维护状态读不到。' +
          '到 Cloudflare Pages → Settings → Variables and secrets 添加它（Secret），然后重新部署。',
      },
      503,
    )
  }

  /*
   * ⚠️ 只取这四列。**取四列、回三个字段**：`scheduled_from` 是"算 effective"必须的，
   *    但它**不回给调用者**（那是内部时刻表）。
   */
  let res
  try {
    res = await read(
      await svc(env, '/rest/v1/site_state?select=enabled,message,until,scheduled_from&key=eq.maintenance'),
    )
  } catch (e) {
    return json(
      { error: `读维护状态失败（连不上数据库）：${e instanceof Error ? e.message : String(e)}` },
      503,
    )
  }
  if (!res.ok) {
    return json(
      {
        error: /42P01|PGRST205|does not exist|schema cache/i.test(res.text)
          ? needStage('23', '平台设置（维护模式）')
          : `读维护状态失败：${res.text.slice(0, 200)}`,
      },
      503,
    )
  }

  const state = toState(res.rows[0])
  const on = maintenanceEffective(state, Date.now())

  /*
   * 🆕 两档版本更新公告（**单独一次读**，见文件头那一段）。
   * ⚠️ 它自己带 read/reason，**不会**把这一整个接口变成 503 ——
   *    读不到就按"没有公告"放行（fail-open），但屏上/面板上要说得出"读不到"。
   */
  const release = await loadPublicReleases(env)

  /* 🔴 回话就是这四个键，**一个不多一个不少**（`admin-checks` 有断言钉着） */
  return json({
    enabled: on,
    message: on ? state.message.trim() || MAINTENANCE_DEFAULT_MESSAGE : '',
    until: on && state.until !== null ? new Date(state.until).toISOString() : null,
    release,
  })
}

/**
 * 其余方法一律 405 —— 这个路径**只有读**。
 * ⚠️ 显式写它（而不是让 Cloudflare 回 404）：`GET /api/status` 万一被谁写成 POST，
 *    "404 = 没部署"与"405 = 方法用错了"是两条完全不同的排错线索。
 */
export async function onRequest(): Promise<Response> {
  return json({ error: '这个地址只有 GET（维护状态是只读的）' }, 405)
}
