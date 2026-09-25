/**
 * `POST /api/feedback` —— **用户反馈的唯一出口**（2026-09-29 管理台第二期）。
 *
 * 设计见 `管理台第二期方案.md` §二.5 · 落地口径见 `功能设计与不变量.md` §二十五。
 *
 * ============================================================
 * 🔴🔴 **先落库、再发信**（本件的验收核心）
 * ============================================================
 *   顺序写死，而且**顺序本身就是不变量**（I51）：
 *     ① 校验 → ② **插入数据库** → ③ 发信 → ④ 把发信结果写回那一行 → ⑤ 回话
 *   · 发信失败**不回滚、也不改用户看到的结果** —— 它**真的已经落库了**
 *     （用户能看到的"我提过的"里就有那一条）；
 *   · 反过来（只发信不存库）会让邮件一失败那条反馈**永久消失**，
 *     而用户看到"发送失败"、以为没提过 —— 双方都以为送到了。
 *
 *   ⚠️ 因此这里的回话语义是 **"已送到"**（= 已经到管理员那儿了，在库里），
 *      **不是** "已发到邮箱"（那是我们控制不了的事）。
 *
 * ============================================================
 * 🔴 谁看得到什么（RLS 管不了列，所以读全走服务端）
 * ============================================================
 *   · `feedback` 表**一条策略都没有、连 SELECT 都没给**；
 *   · 作者看自己那几条 → `action:'mine'`（按 JWT 过滤 + **剥掉内部字段**）；
 *   · 超管看全部     → `action:'admin-list'`；
 *   · 判据全在数据库：`is_super_admin()` / `can_contact_admin()`。
 *
 * 🔴 **不允许匿名提交**（用户 2026-09-28 拍板："没法登录如果是前端的问题
 *    直接落到前端错误上报里面"）—— 所以 `submit` 没有 JWT 直接 401。
 *
 * 环境变量：同 `_lib/supa.ts` + `RESEND_API_KEY`
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  anonKey,
  audit,
  baseUrl,
  caller,
  countRows,
  isMissing,
  json,
  needStage,
  read,
  rpcBool,
  serviceKey,
  svc,
} from './_lib/supa'
import { beijingStamp, sendAuditedMail } from './_lib/mail'

const NEED_STAGE13 =
  '数据库还没跑权限函数（仓库里 supabase/schema.sql 第 13 段：is_super_admin）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'
const NEED_STAGE25 = needStage('25', '用户反馈')

/** 正文：**至少 5 个字**（"至少 5 个字"是参考项目原话，项目里人话版就是这句） */
const BODY_MIN = 5
/** 正文上限 1000 字（参考项目是 500 —— 一条"作业导入失败"的复现步骤真的不够） */
const BODY_MAX = 1000
const CONTACT_MAX = 120
/** 「我提过的」只给最近 5 条（方案 §二.5 的交互原文） */
const MINE_LIMIT = 5
/** 超管一页最多 200 条 */
const PAGE_MAX = 200

type Body = {
  action?: 'submit' | 'mine' | 'admin-list' | 'admin-set-handled'
  body?: string
  contact?: string
  page?: string
  env?: string
  ua?: string
  /** 提交时的身份标签快照（**只用于显示**，由前端 `currentIdentityLabel()` 给） */
  authorRoles?: string
  /** admin-list */
  keyword?: string
  /** admin-set-handled */
  id?: string
  handled?: boolean
  note?: string
  reply?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 作者看得到的字段（**内部字段一个都不在**：`mail_error` / `internal_note` / `handled_by`） */
function mineShape(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(r.id),
    createdAt: r.created_at ? Date.parse(String(r.created_at)) : null,
    body: String(r.body ?? ''),
    contact: String(r.contact ?? ''),
    page: String(r.page ?? ''),
    /** 只给一个结论（"已收到" / "已处理"），**不给处理人、不给内部备注** */
    status: r.handled_at ? '已处理' : '已收到',
    reply: String(r.reply ?? ''),
  }
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
  const action = body.action ?? 'submit'

  const me = await caller(request, env)
  if (!me) {
    return json(
      {
        status: 'error',
        message:
          '反馈需要先登录（这样才能把它和你的账号对上，你也能在「我的」里看到处理进度）。' +
          '如果是**登录不上**或者页面报错，请用「前端错误上报」那条路 —— 它不需要登录。',
      },
      401,
    )
  }

  /* ---------------- 作者那一半：submit / mine（判据 `can_contact_admin()`） ---------------- */
  if (action === 'submit' || action === 'mine') {
    const allowed = await rpcBool(env, me.token, 'can_contact_admin')
    if (allowed === 'missing') return json({ status: 'error', message: NEED_STAGE25 }, 503)
    if (!allowed) {
      return json(
        {
          status: 'error',
          message:
            '这个账号不能提反馈（只有**在册教师**能提，教室端那台屏不在这一档）。' +
            '如果是页面出错，请走「前端错误上报」。',
        },
        403,
      )
    }

    if (action === 'mine') {
      const res = await read(
        await svc(
          env,
          `/rest/v1/feedback?select=*&author_id=eq.${me.id}&order=created_at.desc&limit=${MINE_LIMIT}`,
        ),
      )
      if (!res.ok) {
        return json(
          {
            status: 'error',
            message: isMissing(res) ? NEED_STAGE25 : '读我的反馈失败',
            detail: res.text.slice(0, 200),
          },
          isMissing(res) ? 503 : 502,
        )
      }
      return json({ status: 'ok', mine: res.rows.map(mineShape) })
    }

    /* ---- submit ---- */
    const text = String(body.body ?? '').trim()
    if (text.length < BODY_MIN) {
      return json({ status: 'error', message: `请多写几个字（至少 ${BODY_MIN} 个字），不然没法定位问题` }, 400)
    }
    if (text.length > BODY_MAX) {
      /* ⚠️ **超了直接拒，不静默截断**（`notice.ts` 的 TITLE_MAX/BODY_MAX 同一条纪律） */
      return json({ status: 'error', message: `最多 ${BODY_MAX} 个字（现在 ${text.length} 个）` }, 400)
    }
    const contact = String(body.contact ?? '').trim().slice(0, CONTACT_MAX)

    /*
     * 名字取**数据库里的**（不信前端传的）；身份标签是**显示快照**，接受前端那一个
     * （它是 `roles.ts` 的 `currentIdentityLabel()` 算出来的，服务端没有这个函数，
     *  而且它只影响邮件抬头与我提过的列表，不影响任何判据）。
     */
    let authorName = ''
    const t = await read(await svc(env, `/rest/v1/teachers?select=name&id=eq.${me.id}`))
    if (t.ok && t.rows[0]) authorName = String(t.rows[0].name ?? '').slice(0, 60)

    let schoolId: string | null = null
    const schools = await read(await svc(env, '/rest/v1/schools?select=id&order=created_at&limit=1'))
    if (schools.ok && schools.rows[0]) schoolId = String(schools.rows[0].id)

    /* ② **先落库**（这一步成功 = 用户那条反馈已经到管理员那儿了） */
    const ins = await read(
      await svc(env, '/rest/v1/feedback', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          school_id: schoolId,
          author_id: me.id,
          author_name: authorName,
          author_roles: String(body.authorRoles ?? '').slice(0, 120),
          body: text,
          contact,
          page: String(body.page ?? '').slice(0, 120),
          env: String(body.env ?? '').slice(0, 20),
          ua: String(body.ua ?? '').slice(0, 300),
          mail_state: 'pending',
        }),
      }),
    )
    if (!ins.ok || !ins.rows[0]?.id) {
      /* ⚠️ 落库失败**必须**让用户看到失败（**绝不制造假成功**） */
      return json(
        {
          status: 'error',
          message: isMissing(ins)
            ? NEED_STAGE25
            : '暂时送不出去（数据库写不进）—— 请稍后再试，你的这段字还在输入框里',
          detail: ins.text.slice(0, 200),
        },
        isMissing(ins) ? 503 : 502,
      )
    }
    const id = String(ins.rows[0].id)

    /* ③ 发信（**服务端构造的正文** + 用户正文；`sendMail` 里还有一道 PII 体检） */
    const mail = await sendAuditedMail(env, {
      action: 'mail.feedback',
      actorId: me.id,
      actorName: authorName,
      subject: `【树高反馈】${String(body.authorRoles ?? '').slice(0, 40) || authorName || '教师'} · ${beijingStamp()}`,
      text: [
        '有人从「我的 → 反馈」提了一条。',
        '',
        `时间：${beijingStamp()}`,
        `账号：${authorName || me.id}`,
        `身份：${String(body.authorRoles ?? '').slice(0, 60) || '(未提供)'}`,
        `页面：${String(body.page ?? '').slice(0, 120) || '(未提供)'}`,
        `环境：${String(body.env ?? '').slice(0, 20) || '(未提供)'}`,
        contact ? `联系方式：${contact}` : '联系方式：(没留)',
        '',
        '正文：',
        text,
        '',
        '—— 这一条已经落库（数据库里有底），这封邮件只是提醒。',
      ].join('\n'),
    })

    /* ④ 把发信结果写回那一行（**这一步失败不影响"已送到"**，但要在库里看得出来） */
    const state = mail.ok ? 'sent' : mail.reason === 'failed' ? 'failed' : 'skipped'
    const patched = await read(
      await svc(env, `/rest/v1/feedback?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          mail_state: state,
          mail_error: mail.ok ? '' : mail.message.slice(0, 300),
          mail_at: new Date().toISOString(),
        }),
      }),
    )

    return json({
      status: 'ok',
      id,
      /* ⚠️ 文案写"已送到"（**不写"已发到邮箱"**）—— 那是我们控制不了的事 */
      delivered: true,
      mail: { ok: mail.ok, reason: mail.ok ? '' : mail.reason },
      /** 留痕本身没写成功时说出来（否则面板上会显示成 pending，人会以为还在发） */
      mailRecorded: patched.ok,
    })
  }

  /* ---------------- 超管那一半：admin-list / admin-set-handled ---------------- */
  const isSuper = await rpcBool(env, me.token, 'is_super_admin')
  if (isSuper === 'missing') return json({ status: 'error', message: NEED_STAGE13 }, 503)
  if (!isSuper) {
    return json(
      {
        status: 'forbidden',
        message:
          '只有最高管理员能看全部反馈。反馈正文是**老师手写的自由文本**，很可能提到具体学生，' +
          '所以教务处 / 年级主任 / 班主任都不在这一档。',
      },
      403,
    )
  }

  if (action === 'admin-list') {
    const keyword = String(body.keyword ?? '').trim().slice(0, 80)
    const safe = keyword.replace(/[^\p{L}\p{N}\s._@-]/gu, ' ').trim()
    const filter = safe ? `&or=(author_name.ilike.*${encodeURIComponent(safe)}*,body.ilike.*${encodeURIComponent(safe)}*)` : ''

    const res = await read(
      await svc(env, `/rest/v1/feedback?select=*&order=created_at.desc&limit=${PAGE_MAX}${filter}`),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE25 : '读反馈清单失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }

    const total = await countRows(env, '/rest/v1/feedback?select=id')
    const open = await countRows(env, '/rest/v1/feedback?select=id&handled_at=is.null')
    /*
     * 🔴 **"邮件没发出去"这一条必须显式报警**（I51 的末句）：没配 key 时不能静默，
     *    否则老师提的意见躺在一个没人打开的页面里，而**双方都以为送到了**。
     *    ⚠️ `pending` 也算进去（"还没试发"与"试了没成功"都该让人看一眼）。
     */
    const mailBad = await countRows(
      env,
      '/rest/v1/feedback?select=id&mail_state=in.(failed,skipped,pending)',
    )

    return json({
      status: 'ok',
      feedback: { total, open, mailBad, rows: res.rows, keyword: safe, shown: res.rows.length, pageMax: PAGE_MAX },
    })
  }

  if (action === 'admin-set-handled') {
    const id = String(body.id ?? '').trim()
    if (!UUID_RE.test(id)) return json({ status: 'error', message: '没有指定反馈' }, 400)
    const handled = body.handled !== false

    const res = await read(
      await svc(env, `/rest/v1/feedback?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          handled_at: handled ? new Date().toISOString() : null,
          handled_by: handled ? me.id : null,
          internal_note: String(body.note ?? '').slice(0, 300),
          reply: String(body.reply ?? '').slice(0, 1000),
        }),
      }),
    )
    if (!res.ok) {
      return json(
        {
          status: 'error',
          message: isMissing(res) ? NEED_STAGE25 : '改反馈状态失败',
          detail: res.text.slice(0, 200),
        },
        isMissing(res) ? 503 : 502,
      )
    }
    /* ⚠️ 这一条**可逆**（再点一下取消），所以不加确认 —— 但仍然留痕（"改动了状态"） */
    const audited = await audit(env, {
      actorId: me.id,
      action: handled ? 'feedback.handled' : 'feedback.reopen',
      target: id,
      detail: `回复：${String(body.reply ?? '').slice(0, 60) || '(无)'}`,
      affected: 1,
    })
    return json({ status: 'ok', audited })
  }

  return json({ status: 'error', message: '不认识这个操作' }, 400)
}

/** GET 自述（只为了区分"没部署"与"权限不够"） */
export async function onRequestGet(): Promise<Response> {
  return json({
    status: 'ok',
    endpoint: '/api/feedback',
    method: 'POST',
    body: { action: 'submit | mine | admin-list | admin-set-handled' },
    note: '提交/我的：在册教师（can_contact_admin）；全部：只有超管（is_super_admin）',
  })
}
