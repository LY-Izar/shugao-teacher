/**
 * `POST /api/mail` —— **发信的两个手动出口**（2026-09-29 管理台第二期）。
 *
 * 设计见 `管理台第二期方案.md` §二.5 的"邮件那一半" · 落地见 `_lib/mail.ts`。
 *
 * | action | 谁 | 判据 | 发什么 |
 * |---|---|---|---|
 * | `test` | 只有超管 | `is_super_admin()` | 一封**测试邮件**（面板上一个按钮，不用等到毕业才验通道） |
 * | `backup` | 在册教师 | `can_contact_admin()` | **备份完成通知**（"备份→发信→发不出去就不许删"那条链的中间一环） |
 *
 * 第三处（**公告**）不在这里：它挂在 `POST /api/announcement` 的 `create` 上
 * （勾选框、**默认不发**），因为"发一条公告"这个动作本来就在那个 Function 里。
 *
 * 🔴 **为什么 `backup` 的判据是 `can_contact_admin()`**：它与"用户反馈"守的是
 *    同一件共同的事 —— "这位在册教师能不能给管理员发消息"。**一个判据一种语义**，
 *    不为这一条路再发明一个名字相近的函数（那是"同一件事两个判定入口"的开始）。
 *
 * 🔴 **没配 key 时显式报错**（硬要求 ①）：`sendAuditedMail()` 会回
 *    `reason:'no_key'` + 一句人话，这个接口把它原样交给调用方 ——
 *    **绝不静默失败**（静默失败会让"毕业备份"那条链上的人以为通知已经发出去了）。
 * 🔴 **收件人由部署环境决定**（`ADMIN_NOTIFY_EMAIL`，2026-09-30 隐私整改）：
 *    源码里**不写任何真实邮箱**；没配时回 `reason:'no_to'` + 一句人话，
 *    同样**绝不静默发到某个默认地址**。面板上把"key 在不在"与"收件人在不在"分两行说。
 *
 * 环境变量：同 `_lib/supa.ts` + `RESEND_API_KEY` + `ADMIN_NOTIFY_EMAIL`
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  anonKey,
  baseUrl,
  caller,
  json,
  mailedInLastDay,
  needStage,
  rpcBool,
  serviceKey,
} from './_lib/supa'
import { MAIL_DAILY_CAP, beijingStamp, mailConfigured, sendAuditedMail } from './_lib/mail'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'
const NEED_STAGE25 = needStage('25', '用户反馈（`can_contact_admin` 判据就在那一段）')

type Body = {
  action?: 'test' | 'backup'
  /** backup：一句话摘要（**服务端构造的正文**只放它 + 时间戳） */
  summary?: string
  /** backup：备份文件名 / 条数之类的**非个人**信息 */
  detail?: string
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
  const action = body.action ?? 'test'

  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  /* ---------------- test：只有超管 ---------------- */
  if (action === 'test') {
    const isSuper = await rpcBool(env, me.token, 'is_super_admin')
    if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
    if (!isSuper) {
      return json(
        { status: 'forbidden', message: '只有最高管理员能发测试邮件（它用的是平台的邮件配额）' },
        403,
      )
    }
    /*
     * ⚠️ 测试邮件**不卡配额**（`skipQuota`）：它存在的意义就是"验通道"，
     *    而配额已经留了 10 封余量（`MAIL_DAILY_CAP = 90` vs Resend 的 100）。
     *    它**仍然留痕**（进了 `admin_audit`，所以明天的配额计数算得到它）。
     */
    const sent = await mailedInLastDay(env)
    const r = await sendAuditedMail(env, {
      action: 'mail.test',
      actorId: me.id,
      subject: `【树高平台】邮件通道自测 · ${beijingStamp()}`,
      text: [
        '这是一封测试邮件 —— 你在「管理台 → 维护 / 发测试邮件」点了那个按钮。',
        '',
        `时间：${beijingStamp()}`,
        `发件人：onboarding@resend.dev（Resend 未验域名时的固定发件人）`,
        `收件人：这个邮箱（Resend 未验域名时只能发给账号所有者本人）`,
        `今天已发：${sent === null ? '读不到' : sent} 封（上限 ${MAIL_DAILY_CAP}/天，Resend 免费额度 100/天）`,
        '',
        '收到这封信 = 邮件通道是通的。',
        /* ⚠️ 措辞同样避开那四个触发词（见下面 backup 那一支的注释） */
        '⚠️ 本邮件正文**不含任何学生个人信息**（发信助手的三条硬要求之一）。',
      ].join('\n'),
      skipQuota: true,
    })
    if (!r.ok) {
      /* 🔴 硬要求 ①：没配 key / 没配收件人 / 发失败都要**显式**说出来（人话 + 去处）。
       *    `no_key` / `no_to` 都是"**环境没准备好**" → 503（不是 502：别把环境问题
       *    报成上游故障，人会去查 Resend）。
       */
      return json(
        {
          status: 'error',
          reason: r.reason,
          message: r.message,
          configured: mailConfigured(env),
        },
        r.reason === 'no_key' || r.reason === 'no_to' ? 503 : 502,
      )
    }
    return json({ status: 'ok', id: r.id, to: r.to, sentToday: sent })
  }

  /* ---------------- backup：备份完成通知 ---------------- */
  if (action === 'backup') {
    const allowed = await rpcBool(env, me.token, 'can_contact_admin')
    if (allowed === 'missing') return json({ status: 'error', message: NEED_STAGE25 }, 503)
    if (!allowed) {
      return json(
        { status: 'error', message: '只有**在册教师**能发备份通知（教室端那台屏不在这一档）' },
        403,
      )
    }
    const summary = String(body.summary ?? '').slice(0, 200)
    const detail = String(body.detail ?? '').slice(0, 400)

    const r = await sendAuditedMail(env, {
      action: 'mail.backup',
      actorId: me.id,
      subject: `【树高备份】${beijingStamp()}`,
      text: [
        '有一次备份完成了。',
        '',
        summary || '(没有摘要)',
        detail ? `细节：${detail}` : '',
        '',
        `时间：${beijingStamp()}`,
        '',
        /*
         * 🔴 这一句的措辞是**被断言逼出来的**（`admin-checks` ⑤ 反向对照当场抓到）：
         *    第一版写的是"没有任何学生姓名 / 学号 / **成绩**"，而 `looksLikeStudentData()`
         *    里有一条"出现成绩类词" → **这句免责声明把自己给拦下了**（备份通知永远发不出去）。
         *    → 服务端自己构造的正文里，**别出现那四个触发词**（成绩 / 分数 / 得分 / 排名 / 名次）。
         */
        '⚠️ 本邮件由服务端构造正文：**只有摘要与时间，没有任何学生个人信息**。',
        '🔴 如果这封信没发出去，那条链上的规矩是：**不许删**（本机备份文件要留着）。',
      ]
        .filter((x) => x !== '')
        .join('\n'),
    })
    if (!r.ok) {
      return json(
        { status: 'error', reason: r.reason, message: r.message },
        r.reason === 'no_key' || r.reason === 'no_to' ? 503 : 502,
      )
    }
    return json({ status: 'ok', id: r.id, to: r.to })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/** GET 自述 */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/mail',
    method: 'POST',
    body: { action: 'test | backup' },
    note: 'test 只有超管；backup 在册教师。三处接入：反馈 / 备份 / 公告（公告挂在 /api/announcement）',
  })
}
