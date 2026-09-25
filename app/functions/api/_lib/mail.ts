/**
 * 邮件发送助手（Resend）—— **全仓唯一一处** `POST https://api.resend.com/emails`。
 * 2026-09-29 管理台第二期新增。三处接入：**用户反馈 · 备份通知 · 公告（可选）**。
 *
 * 🔴 三条硬要求（用户点名，破坏了任何一条这一件就不算做完）：
 *   ① **没配 key 时显式报错**（人话，不是静默失败）—— 返回 `reason:'no_key'` +
 *      一句"去 Cloudflare 加 RESEND_API_KEY"，**绝不假装成功**；
 *   ② **发送失败要留痕** —— 调用方把 `reason` / `message` 写进数据库
 *      （`feedback.mail_state = 'failed'` / `mail_error = …`），界面上一眼看得见；
 *   ③ **正文里不许出现学生姓名/成绩**（邮件会离开系统）。
 *
 * 🔴 关于 ③ 的**诚实说明**（这一条必须写下来，不许含糊）：
 *    · **结构性保证**：服务端**自己构造**的正文（备份通知 / 公告留档 / 测试邮件）
 *      只放 `时间 / 身份 / 页面 / 字数` 这类**非个人**字段 —— 它们**结构上不可能**带学生数据；
 *    · **启发式**：反馈的正文是**用户手写的自由文本**，助手在发出前用一组**窄判据**
 *      （`looksLikeStudentData`）扫一遍，命中就 `reason:'pii_blocked'` **不发**、
 *      由调用方落 `skipped` 留痕。⚠️ **它会有漏**（例如只写了"张三"没写分数），
 *      所以文档与界面上**都不许写成"已脱敏"**（`功能设计与不变量.md` §二十五）。
 *
 * 🔴 收件人**由部署环境决定**：`ADMIN_NOTIFY_EMAIL` 环境变量，**代码里不写任何真实地址**。
 *    这一条取代了原先"收件人固定成一个写死的个人邮箱、不做成配置项"那句 —— 那时的判断是
 *    "一个配置项 = 一处能改错的地方"；2026-09-30 的隐私整改把它翻过来了，理由更硬：
 *    **写死在源码里的邮箱会随公开仓库发给全世界**（真实个人邮箱属于个人信息）。
 *    现在的口径是：地址是**部署环境的事**，代码只负责"没配就大声报错"。
 *    ⚠️ 连注释里都不留那个地址：`admin-checks` 有一条断言**静态扫本文件**，
 *       出现"qq 邮箱"那种形状（`@` + `qq.com`）就判红 —— 本文件里也不许出现它。
 * 🔴 **没配 `ADMIN_NOTIFY_EMAIL` 时显式报错**（`reason:'no_to'` + 一句人话 + 去处），
 *    **绝不静默发到某个默认地址**（静默 = 邮件发到别人那儿，或者你以为发了其实没发）——
 *    与下面硬要求 ① 是**同一条纪律**。
 * 🔴 发件人固定 `onboarding@resend.dev`：用户**没验域名**，Resend 只允许这个发件人，
 *    而且**只能发给账号所有者本人** —— 所以"群发给每位老师"是做不到的，
 *    公告那一处的勾选框发的是**给管理员的一封留档**（界面上写清了这一点）。
 *
 * 环境变量：`RESEND_API_KEY`（Cloudflare Pages → Settings → Variables and secrets，Secret）
 *           `ADMIN_NOTIFY_EMAIL`（同上，**收件人**；不是 secret，但不进前端产物）
 */

import {
  type Env,
  audit,
  mailedInLastDay,
  read,
  serviceKey,
  svc,
} from './supa'

export const MAIL_FROM = 'onboarding@resend.dev'

/**
 * 收件人：**只从环境变量来**（`ADMIN_NOTIFY_EMAIL`），没配就是空串 ——
 * 调用方（`sendMail`）必须显式处理，**不许填默认值**。
 * ⚠️ 为什么不做成"常量 + 兜底"：兜底值迟早会被当成"能用的默认地址"，
 *    而那正是把邮件发去另一个人邮箱的路径。
 */
export function mailTo(env: Env): string {
  return (env.ADMIN_NOTIFY_EMAIL ?? '').trim()
}

/** Resend 免费额度：100 封/天（3000 封/月）。留 10 封余量给手动的测试邮件 */
export const MAIL_DAILY_CAP = 90

/** 发出前等待的上限：Resend 挂着的时候**不许把用户的请求吊死** */
const TIMEOUT_MS = 8000

export type MailFailReason = 'no_key' | 'no_to' | 'pii_blocked' | 'quota' | 'failed'

export type MailResult =
  | { ok: true; id: string; to: string }
  | { ok: false; reason: MailFailReason; message: string; status?: number }

/* ============================================================
   ① 正文体检：**窄判据**（有漏，见文件头）
   ============================================================ */

/**
 * 这一串**故意很短**，而且每一条都要能说出"它抓的是什么"。
 * ⚠️ 加一条之前先问：正常运维文案会不会被它误伤？
 *    （"今晚 23:00–23:30 维护"、"版本 0.9.1 上线" 都不许命中 —— 那比漏提醒更烦人。）
 */
const PII_PATTERNS: Array<{ re: RegExp; why: string }> = [
  /*
   * 「85 分」/「92.5分」—— 成绩最常见的写法。
   * ⚠️ `(?!钟)` 是**实测补上的**（`admin-checks` 的反向对照当场抓到）：
   *    没有它时"今晚 23:00-23:30 升级，预计 **30 分**钟"会被判成含成绩 ——
   *    而那是最典型的正常运维文案。同一条修法在 `lib/announcements.ts` 的
   *    `announcementPrivacyHint()` 里已经踩过一次，两边保持一致。
   */
  { re: /\d{1,3}(\.\d+)?\s*分(?!钟)/, why: '出现"NN 分"这种成绩写法' },
  // 成绩类词（单独出现也算：这些词出现在一封邮件里没有别的用途）
  { re: /(成绩|分数|得分|总分|平均分|排名|名次)/, why: '出现成绩类词' },
  // 「学号：2025007」/「姓名：张三」—— 冒号是刻意的：光"姓名"两个字可能出现在说明文案里
  { re: /(学号|姓名)\s*[:：]/, why: '出现"学号/姓名："这种标注' },
  // 本项目档案键的形状 = 7 位序列号（`schema.sql` §20）—— 裸的 7 位数字
  { re: /\b\d{7}\b/, why: '出现 7 位数字（本项目的档案键/序列号形状）' },
]

/** 命中任何一条 → 判定"这条正文可能含学生信息"，**不发**。返回命中的理由（给留痕用） */
export function looksLikeStudentData(text: string): string | null {
  for (const p of PII_PATTERNS) {
    if (p.re.test(text)) return p.why
  }
  return null
}

/**
 * 洗一遍：把可能夹带的凭据痕迹擦掉（**服务端再洗一次，不指望前端**）。
 * 洗的是：URL 的 query string / `Bearer xxx` / 常见的 token 前缀 / 32 位以上的长串。
 * ⚠️ 它**不**取代"前端不许带这些"那条纪律（`功能设计与不变量.md` §二十五），
 *    它是**最后一道**：邮件会离开系统，出去了就收不回来。
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [已隐去]')
    .replace(/\b(sbp_|sk_|re_|eyJ)[A-Za-z0-9._-]{12,}/g, '[已隐去]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[已隐去]')
}

/* ============================================================
   ② 真发信（唯一一处调 Resend）
   ============================================================ */

export function mailConfigured(env: Env): boolean {
  return Boolean((env.RESEND_API_KEY ?? '').trim())
}

/**
 * 发一封纯文本邮件。
 * ⚠️ **不做 HTML 邮件**（与本仓库"通知不做富文本"同一条判断：XSS 面 + 排版调试）。
 * ⚠️ 它**不写数据库、不查配额** —— 那是 `sendAuditedMail()` 的事（分开写是有意的：
 *    "怎么发"与"发了要不要留痕 / 算不算配额"是两件事）。
 */
export async function sendMail(
  env: Env,
  mail: { subject: string; text: string },
): Promise<MailResult> {
  const key = (env.RESEND_API_KEY ?? '').trim()
  if (!key) {
    // 🔴 硬要求 ①：**显式报错**，人话 + 去处
    return {
      ok: false,
      reason: 'no_key',
      message:
        '服务端还没配置邮件密钥（RESEND_API_KEY）—— 到 Cloudflare Pages → Settings → ' +
        'Variables and secrets 添加它（Secret），然后重新部署。在此之前邮件发不出去。',
    }
  }

  /*
   * 🔴 收件人没配 → **显式报错**（与上面那条同一纪律）。
   *    注意顺序：先判 key 再判地址 —— 两条都缺时报的是"更靠前的那一步"，
   *    而"没配地址"**绝不能**用任何默认值兜底（那等于把邮件发给别人）。
   */
  const to = mailTo(env)
  if (!to) {
    return {
      ok: false,
      reason: 'no_to',
      message:
        '服务端还没配置邮件收件人（ADMIN_NOTIFY_EMAIL）—— 到 Cloudflare Pages → Settings → ' +
        'Variables and secrets 添加它（填你自己的邮箱），然后重新部署。' +
        '⚠️ 代码里**故意没有默认收件人**：静默发到某个写死的地址，等于把信发到别人那儿。',
    }
  }

  const subject = mail.subject.slice(0, 160)
  const text = scrubSecrets(mail.text).slice(0, 8000)

  // 🔴 硬要求 ③：正文体检（结构性保证 + 启发式，见文件头）
  const pii = looksLikeStudentData(text)
  if (pii) {
    return {
      ok: false,
      reason: 'pii_blocked',
      message: `正文疑似含学生信息（${pii}）—— 按纪律**不发信**；这一条会留在数据库里，面板上看得到`,
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [to],
        subject,
        text,
      }),
    })
    const body = (await res.text()).slice(0, 400)
    if (!res.ok) {
      // 🔴 硬要求 ②：失败留痕（原因原文给数据库，**不回显给用户**）
      return {
        ok: false,
        reason: 'failed',
        status: res.status,
        message: `Resend 回了 ${res.status}：${body || '(空响应)'}`,
      }
    }
    let id = ''
    try {
      id = String((JSON.parse(body) as { id?: string })?.id ?? '')
    } catch {
      id = ''
    }
    return { ok: true, id, to }
  } catch (e) {
    return {
      ok: false,
      reason: 'failed',
      message: `发信请求失败：${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================================================
   ③ 带配额与留痕的发信（三处接入都走它）
   ============================================================ */

/**
 * 发一封 + 写留痕 + 算配额。
 *
 * 配额怎么算的：**数 `admin_audit` 里最近 24 小时 `mail.*` 的行数**。
 * ⚠️ 为什么不单独建一张计数表：一张表就多一处"会被写错的计数"，
 *    而 `admin_audit` 本来就是"写动作的流水"—— 发信就是一次写动作。
 * ⚠️ 数不到（表没建 / 读失败）时**放行**：配额是保护额度，不是安全边界；
 *    因为数不到就把信全卡住，方向反了（与 I48 的 fail-open 同一条思路）。
 */
export async function sendAuditedMail(
  env: Env,
  mail: {
    /** `admin_audit.action`，形如 `mail.test` / `mail.backup` / `mail.announcement` */
    action: string
    subject: string
    text: string
    actorId: string | null
    actorName?: string
    /** 影响面（一般是 1 封） */
    affected?: number
    /** 跳过配额检查（只有"测试邮件"用：它就是用来验通道的，卡在配额上没意义） */
    skipQuota?: boolean
  },
): Promise<MailResult> {
  if (!mailConfigured(env)) {
    const r = await sendMail(env, { subject: mail.subject, text: mail.text })
    // 没配 key 也留痕 —— 否则面板上"最近 24 小时发了几封"会是 0，而人以为通道是好的
    await audit(env, {
      actorId: mail.actorId,
      actorName: mail.actorName,
      action: mail.action,
      target: mailTo(env) || '（未配置 ADMIN_NOTIFY_EMAIL）',
      detail: r.ok ? '已发出' : `未发出（${r.reason}）`,
      affected: 0,
    })
    return r
  }

  if (!mail.skipQuota) {
    const sent = await mailedInLastDay(env)
    if (sent !== null && sent >= MAIL_DAILY_CAP) {
      return {
        ok: false,
        reason: 'quota',
        message:
          `最近 24 小时已经发了 ${sent} 封，到了自己设的上限（${MAIL_DAILY_CAP} 封/天，` +
          'Resend 免费额度是 100 封/天）—— 今天先别再发了',
      }
    }
  }

  const r = await sendMail(env, { subject: mail.subject, text: mail.text })
  await audit(env, {
    actorId: mail.actorId,
    actorName: mail.actorName,
    action: mail.action,
    target: mailTo(env) || '（未配置 ADMIN_NOTIFY_EMAIL）',
    detail: r.ok ? '已发出' : `未发出（${r.reason}）：${r.message.slice(0, 200)}`,
    affected: r.ok ? (mail.affected ?? 1) : 0,
  })
  return r
}

/** 面板/接口要用的一句人话（"通道通不通"） */
export function mailReadyText(env: Env, sentToday: number | null): string {
  if (!mailConfigured(env)) {
    return 'RESEND_API_KEY **不在** —— 邮件通道没开：反馈照常落库，但不会发到你邮箱（面板上会显式报警）'
  }
  const to = mailTo(env)
  if (!to) {
    return (
      'RESEND_API_KEY 在，但 `ADMIN_NOTIFY_EMAIL`（收件人）**不在** —— ' +
      '邮件一封也发不出去：去 Cloudflare Pages → Settings → Variables and secrets 补上它。' +
      '⚠️ 代码里**故意没有**默认收件人（静默发到写死的地址 = 把信发给别人）。'
    )
  }
  const n = sentToday === null ? '读不到' : String(sentToday)
  return `RESEND_API_KEY 在 · 收件人 ${to} · 今天已发 ${n} 封（上限 ${MAIL_DAILY_CAP}/天，Resend 免费额度 100/天）`
}

/** 供接口在"留痕表还没建"时说人话（`admin_audit` 属于第 23 段） */
export function auditMissingHint(r: { ok: boolean; text: string }): boolean {
  return !r.ok && /42P01|PGRST205|does not exist|schema cache/i.test(r.text)
}

/**
 * 北京时间的一行字（邮件主题 / 正文里的时间戳）。
 *
 * ⚠️ **时间口径一律北京时间**（本项目的既有纪律：`lib/holiday.ts` 的 `beijingNow()`）。
 *    这里是一个**只用于显示**的 4 行版本 —— 服务端不让一个邮件主题去 import
 *    整个节假日数据表（`data/holidays.ts` 有一整年的假期计划，那是前端的事）。
 *    ⚠️ **它不参与任何判断**：判断口径仍然只有前端那一个 `beijingNow()`。
 */
export function beijingStamp(ms: number = Date.now()): string {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 内部用：把一封"审计里读出来的发信记录"归一成条数（给面板展示） */
export async function readMailAudit(
  env: Env,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const res = await read(
    await svc(
      env,
      `/rest/v1/admin_audit?select=*&action=like.mail.*&order=at.desc&limit=${limit}`,
    ),
  )
  return res.ok ? res.rows : []
}

/** 给"服务端还没配密钥"这一类判断用（`svc()` 之前先看一眼） */
export function hasServiceKey(env: Env): boolean {
  return Boolean(serviceKey(env))
}
