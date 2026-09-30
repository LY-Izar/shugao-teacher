/**
 * 「调课之后给被调到的老师发一条系统通知」（`schema.sql` §38 · 本平台第 4 轮）。
 *
 * 🔴 **为什么必须走服务端**：`notices` 这张表**只有服务端一条写路径**（§21.2）——
 *    前端一条写策略都没有（多一条就多一个能绕过的口子）。所以"调完课顺手发通知"
 *    只能在这里做，页面侧只负责说一句"这一笔调完了"。
 *
 * 🔴 **通知发给谁 —— 由数据库那一行说了算，不信前端传来的名单**：
 *    · 收件人 = 这一笔里**课被动过的老师**（原来那位 ∪ 换成的那位，去重、去掉空值）。
 *      整格换 / 对调时**两个老师都变了**，所以两位都发（用户口径："被调到的老师收到通知"）。
 *    · 🔴 这一笔的 `actor_id` 必须就是**调用者本人**：只有"这笔调课是我做的"才能就它发通知。
 *      没有这一条，任何一个能管课表的人都能拿别人的 `changeId` 去发一批通知。
 *      这与 `apply_perm_schedule_change()` 返回的 `notifyTeacherIds` 是**同一组人**
 *      （那边 `array_agg(distinct [from, to])`，这里从那一行现读 from/to —— 一个口径两处取）。
 *
 * 🔴 **调用者身份只认 JWT，不认前端说的**：`caller()` 拿 Authorization 去 `/auth/v1/user` 验；
 *    判据只问数据库那一个函数 `can_manage_schedule(p_class_id)`
 *    （它以 `auth.uid()` = **调用者**求值，§38.0；超管 / 教务处全校 · 年级主任本年级）。
 *    ⚠️ 这里**不写第二套角色判断**（"前端/服务端各判一份"必然分叉）。
 *
 * ⚠️ **署名是「教务处」**（用户点名：不许写"系统"、不许写"管理员"）——
 *    通知列表里**不显示发件人姓名**（`notices` 只有 `sender_id`），
 *    所以署名落在**正文最后那一行**上；`sender_id` 照旧是**真实发信人**（调用者本人），
 *    不许拿一个幽灵 id 冒充教务处账号。
 *
 * 部署：<项目根>/functions/api/schedule-notice.ts，推 GitHub 后 Cloudflare 自动带上。
 * 环境变量与 `notice.ts` 共用：SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY。
 */

import {
  NEED_SERVICE_KEY,
  NEED_SUPABASE,
  type Env,
  caller,
  json,
  needStage,
  read,
  ready,
  rpcBool,
  svc,
} from './_lib/supa'

/** 与 `CourseAdmin.tsx` 递上来的那两种一致（§38.1 的 `kind` 不是这个 —— 那是换法，不是表） */
const CHANGE_KINDS = ['temp', 'perm'] as const
type ChangeKind = (typeof CHANGE_KINDS)[number]

type Body = {
  /** 哪一张表上的那一笔：`temp` = `schedule_temp_changes` · `perm` = `schedule_perm_changes` */
  changeKind?: string
  /** 那一笔的 id（前端写完拿到的回执） */
  changeId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WEEKDAY_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const TITLE_MAX = 120
const BODY_MAX = 2000

/** `08:50:00` → `08:50`（库里是 `time`，PostgREST 会给成 `HH:MM:SS`） */
function hhmm(v: unknown): string {
  const s = String(v ?? '')
  return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : s
}

/** `2026-10-13` → `10 月 13 日`（**不做任何时区换算**：库里那一天就是那一天） */
function mdOf(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''))
  return m ? `${Number(m[2])} 月 ${Number(m[3])} 日` : String(v ?? '')
}

/** 一行标题（`10 月 13 日 调课` / `每周二 课表调整`），正文照 §七：只说"这里是什么、我能做什么" */
function compose(row: {
  kind: ChangeKind
  className: string
  weekday: number
  start: string
  end: string
  subject: string
  toName: string
  fromName: string
  date: string | null
}): { title: string; body: string } {
  const wd = WEEKDAY_TEXT[Math.min(7, Math.max(1, row.weekday)) - 1]
  const slot = `${row.start}–${row.end}`
  const when = row.kind === 'temp' ? `${mdOf(row.date)}（${wd}）` : `以后每个${wd}`
  const who = row.toName ? `${row.toName} 老师` : '另一位老师'
  const was = row.fromName && row.fromName !== row.toName ? `（原 ${row.fromName} 老师）` : ''
  const subject = row.subject || '那一节课'
  return {
    title:
      row.kind === 'temp' ? `${mdOf(row.date)} 调课` : `${wd} 课表调整`,
    body:
      `${row.className} ${when} ${slot} 那一节的${subject}改由 ${who} 上${was}。\n` +
      `—— 教务处`,
  }
}

export async function onRequestPost(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context

  if (!ready(env)) {
    return json(
      { status: 'not_configured', message: env.SUPABASE_SERVICE_ROLE_KEY ? NEED_SUPABASE : NEED_SERVICE_KEY },
      503,
    )
  }

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }

  /*
   * 🔴 调用者是谁 —— 只从 Authorization 那个 JWT 上问（`/auth/v1/user`）。
   *    前端**塞不进**"我是教务处"（§四：权限判据一律以数据库为准）。
   */
  const me = await caller(request, env)
  if (!me) return json({ status: 'error', message: '登录已过期，请重新登录后再试' }, 401)

  const changeKind = String(body.changeKind ?? '').trim() as ChangeKind
  if (!(CHANGE_KINDS as readonly string[]).includes(changeKind)) {
    return json({ status: 'error', message: '不认识这个调课种类' }, 400)
  }
  const changeId = String(body.changeId ?? '').trim()
  if (!UUID_RE.test(changeId)) return json({ status: 'error', message: '没有指定这一笔调课' }, 400)

  const table = changeKind === 'temp' ? 'schedule_temp_changes' : 'schedule_perm_changes'

  /*
   * ① 读那一笔 —— 用管理员密钥读（`schedule_perm_changes` 客户端读得到，
   *    但这里刻意用**同一个形状**读两张表：判据不因为"读得到"而变化）。
   *    ⚠️ `select=*`：探针不许假设任何列存在（§三.3）。
   */
  const res = await read(
    await svc(env, `/rest/v1/${table}?select=*&id=eq.${encodeURIComponent(changeId)}&limit=1`),
  )
  if (!res.ok) {
    return json(
      {
        status: 'error',
        message: /42P01|PGRST20[45]|does not exist|schema cache/i.test(res.text)
          ? needStage('38', '课程管理（调课）')
          : '读这一笔调课失败',
        detail: res.text.slice(0, 200),
      },
      /42P01|PGRST20[45]/.test(res.text) ? 503 : 502,
    )
  }
  const row = res.rows[0]
  if (!row) return json({ status: 'error', message: '找不到这一笔调课' }, 404)

  const classId = String(row.class_id ?? '')
  if (!UUID_RE.test(classId)) return json({ status: 'error', message: '这一笔调课没有归属班' }, 400)

  /*
   * 🔴 ② 就这一笔发通知的**资格**：
   *    · 它必须是**调用者本人**做的那一笔（`actor_id = 我`）—— 见文件头那条理由；
   *    · 并且我**现在**仍然能管这个班的课表（判据问数据库，问的是"我"）。
   */
  if (String(row.actor_id ?? '') !== me.id) {
    return json({ status: 'error', message: '这一笔调课不是你的操作，不能由你来发通知' }, 403)
  }
  const allowed = await rpcBool(env, me.token, 'can_manage_schedule', { p_class_id: classId })
  if (allowed === 'missing') return json({ status: 'error', message: needStage('38', '课程管理（调课）') }, 503)
  if (!allowed) return json({ status: 'error', message: '你没有改这个班课表的权限' }, 403)

  /*
   * ③ 收件人 = **这一笔里课被动过的老师**（原来是哪位 ∪ 换成哪位）。
   *    `notifyTeacherIds`（`apply_perm_schedule_change` 的返回值）就是这两位，
   *    这里从那一行**现读**，因为前端那份名单不算数。
   */
  const ids = [...new Set([row.from_teacher_id, row.to_teacher_id].filter(Boolean).map(String))]
  const recipients = ids.filter((v) => UUID_RE.test(v))
  if (!recipients.length) {
    return json({ status: 'error', message: '这一笔里没有"被调到的老师"，没有可发的收件人' }, 400)
  }

  /* 名字只为写进正文（决定不了权限，也决定不了收件人名单） */
  const tRes = await read(
    await svc(env, `/rest/v1/teachers?select=*&id=in.(${recipients.join(',')})`),
  )
  const nameOf = (id: unknown) => {
    const hit = tRes.rows.find((t) => String(t.id) === String(id))
    return hit ? String(hit.name ?? '') : ''
  }
  const cRes = await read(
    await svc(env, `/rest/v1/classes?select=*&id=eq.${encodeURIComponent(classId)}&limit=1`),
  )
  const className = String(cRes.rows[0]?.name ?? '这个班')

  const draft = compose({
    kind: changeKind,
    className,
    weekday: Number(row.weekday ?? 1),
    start: hhmm(row.start_time),
    end: hhmm(row.end_time),
    subject: String(row.to_subject ?? ''),
    toName: nameOf(row.to_teacher_id),
    fromName: nameOf(row.from_teacher_id),
    date: changeKind === 'temp' ? String(row.on_date ?? '') : null,
  })
  if (draft.title.length > TITLE_MAX || draft.body.length > BODY_MAX) {
    return json({ status: 'error', message: '这条通知太长了，发不出去' }, 400)
  }

  /* 学校 id：与 `notice.ts` 同一口径（多校预留）。取不到就留空，不因此拒发 */
  let schoolId: string | null = null
  const schools = await read(await svc(env, '/rest/v1/schools?select=*&order=created_at&limit=1'))
  if (schools.ok && schools.rows[0]) schoolId = String(schools.rows[0].id)

  /* ④ 发通知（**范围 = 自定义名单**，名单就是上面那两位） */
  const ins = await read(
    await svc(env, '/rest/v1/notices', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        school_id: schoolId,
        // 🔴 发件人 = **调用者本人**（服务端从 JWT 取的），不是前端传的
        sender_id: me.id,
        title: draft.title,
        body: draft.body,
        scope_kind: 'custom',
        expires_at: null,
      }),
    }),
  )
  if (!ins.ok || !ins.rows[0]?.id) {
    return json(
      { status: 'error', message: '发通知失败', detail: ins.text.slice(0, 200) },
      502,
    )
  }
  const noticeId = String(ins.rows[0].id)

  const tIns = await read(
    await svc(env, '/rest/v1/notice_targets', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(recipients.map((id) => ({ notice_id: noticeId, target_kind: 'teacher', teacher_id: id }))),
    }),
  )
  if (!tIns.ok) {
    /* 范围没写进去 → **撤下**这条通知（与 `notice.ts` 同一条处置：一条谁都收不到的通知是个谜） */
    await svc(env, `/rest/v1/notices?id=eq.${noticeId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    })
    return json(
      { status: 'error', message: '通知的收件人没写进去，已自动撤下这条通知（谁都不会收到）' },
      502,
    )
  }

  return json({ status: 'ok', noticeId, teacherIds: recipients, title: draft.title })
}
