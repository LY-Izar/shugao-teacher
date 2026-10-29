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
 *      🆕 2026-10-06：**家长电话 / 家庭住址 / 民族 / 出生年月**（学生档案那四个字段，
 *      `schema.sql` §2.1 / §35）也是这一条管的 —— 它们是**第三方 PII**，
 *      一封备份通知带出去就是全校家长电话出了系统。
 *      🆕 同日，**老师自己的档案**（家庭住址 / 电话号码 / 邮箱，§1.1 / §36）同样算：
 *      老师的个人信息也是个人信息（这一侧只加一条 —— 邮箱地址的形状，见 `PII_PATTERNS`）。
 *
 * 🔴 关于 ③ 的**诚实说明**（这一条必须写下来，不许含糊）：
 *    ⚠️ **2026-10-06 实测补充**（"结构上不可能"这句话曾经被自己打脸两次，第 2、3 次见
 *       `SYSTEM_MAIL_BODIES` 上面那段说明）：系统正文**不会夹带**学生数据，
 *       但**会被自己的窄判据误伤**（免责声明里写了"成绩"、正文里印了发件人地址）。
 *       → 所以系统正文也必须**逐条喂给 `looksLikeStudentData()` 做自测**，
 *         见 `admin-checks` 第五节 ③-B。
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
 * 🔴 发件人：**显示名固定「树高教务助手」**，地址固定 `onboarding@resend.dev` ——
 *    用户**没验域名**，Resend 只允许这个发件地址，而且**只能发给账号所有者本人**
 *    ⇒ "群发给每位老师"仍然做不到；所以公告那一处发的是**给管理员的一封留档 + 一份
 *    可以照着逐个转发的收件清单**（`MailDoc.intendedTo`，见下面 ①-A）。
 *
 * 🆕 **2026-10-29：改成做 HTML 邮件了**（旧判断必须留档，不许偷偷删掉）：
 *    · **以前为什么不做**：XSS 面 + 排版调试成本，而通知用纯文本已经够读
 *      （原话是"与本仓库『通知不做富文本』同一条判断"）；
 *    · **现在为什么做**：用户明确要求「排版好看、能照着转发」—— 纯文本做不出
 *      顶部色块、两列参数表、浅黄转发块这些东西，而它们正是"一眼看懂该转给谁"的载体；
 *    · **风险怎么收**：HTML **一个标签都不从用户输入拼**（`escapeHtml()` **逐字转义**），
 *      600px + table 布局 + **全部内联样式** + **零外部图片 / 字体 / JS / 链接**；
 *    · **纯文本照旧每封都带**：`MailDoc` 同源渲染出 `renderText()` / `renderHtml()`
 *      两份，**同一份内容，不许各写一份**；而且 PII 体检只扫纯文本那一份（见 ②）。
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

/**
 * 发件人三件套（2026-10-29 用户点名）：
 *   · **显示名**是给收件箱里那个人看的 —— 收件箱里一排 `onboarding@resend.dev` 分不清是谁发的；
 *   · **地址**仍然是 Resend 未验域名时唯一允许的那个（换掉它 Resend 会直接拒发）；
 *   · `MAIL_FROM` 是 Resend 要的完整写法（`显示名 <地址>`），**发信只认它**。
 * ⚠️ 这个地址**只出现在发件人字段**里：正文/页脚都不复述它（复述会被"邮箱形状"判据拦下，
 *    2026-10-06 线上恒 502 那次事故就是它）。
 */
export const MAIL_FROM_NAME = '树高教务助手'
export const MAIL_FROM_ADDRESS = 'onboarding@resend.dev'
export const MAIL_FROM = `${MAIL_FROM_NAME} <${MAIL_FROM_ADDRESS}>`

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
   ①-A 一封信的结构化模型 —— **纯文本与 HTML 同源**
   ------------------------------------------------------------
   为什么先立这个模型、而不是继续传字符串：
     · 用户要"看起来高级"，但更强调"能照着转发" —— 前者是 HTML，后者是纯文本
       （复制到微信/粘贴到转发框里那一份）。两样都要，就**只能有同一份内容**；
     · 各写一份一定会分叉（改了一处忘了另一处），而这个仓库已经被"同一件事两份写法"
       咬过很多次（见文件头与 `AGENTS.md` §四）。
   所以：**所有系统正文都返回 `MailDoc`**，发送时 `renderText()` / `renderHtml()` 各渲染一次。
   ============================================================ */

/** 一封信的结构化模型：纯文本与 HTML 都从它渲染 —— 同一份内容，不许各写一份 */
export type MailDoc = {
  /** 邮件内的大标题；主题由调用方给 */
  title: string
  /** 标题下一行小字（可空），例如"全站公告 · 高优先级" */
  subtitle?: string
  /** 开头一段人话：这封信为什么发给你（可选） */
  lead?: string
  /** 键值段：k = 参数名，v = 值，note = **这句参数意味着什么**（人话，可选但强烈建议） */
  rows?: Array<{ k: string; v: string; note?: string }>
  /** 自由正文（公告正文 / 用户反馈 / 错误详情）；HTML 渲染时**逐字转义** */
  body?: string
  /** 建议动作（每行一句人话，渲染成有序列表；可选） */
  actions?: string[]
  /** 🔴 代为转发块：这封信**本来该发给谁**（一堆邮箱）；有值就渲染成醒目的一块 */
  intendedTo?: string[]
  /** 页脚（可选；不给就用默认那句） */
  footer?: string
}

/** 页面宽度：600px 是邮件客户端里"正文不至于读成一行"的通行宽度 */
const MAIL_WIDTH = 600
/** 品牌蓝（与前端同一个色值） */
const BRAND_BLUE = '#0B5CF0'
/** 一套不依赖外部字体的字体栈（系统里有什么用什么，**不引 webfont**） */
const MAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei','PingFang SC',Arial,sans-serif"

/** 页脚默认那句（发件人**只写显示名**，正文里不复述那个地址） */
const DEFAULT_MAIL_FOOTER = '本邮件由树高教务通自动发出 · 发件人 树高教务助手 · 请勿直接回复'

/** 转发块的标题 / 那句人话：纯文本与 HTML 用**同一份措辞** */
const INTENDED_TITLE = '这封信本来应该发给'
const INTENDED_HINT = '现在统一发给你，转发时按上面这几个地址发'

/** 逐字转义（HTML 里**一个用户字符都不许当标签**；`&` 必须最先换） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 自由正文逐行转 `<br>` —— **先转义、再换行**。
 * ⚠️ CSS 的 `white-space: pre-wrap` 在 Outlook / 部分手机邮箱里不生效，
 *    所以换行必须在 HTML 字符串里**显式**变成 `<br>`（不然整段会挤成一行）。
 */
function htmlLines(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>')
}

/** 纯文本版的转发块（`sendMail` 里也用它把这一块单独拼回去，见 ②） */
function intendedTextBlock(list: string[]): string {
  return [
    `【${INTENDED_TITLE}】`,
    ...list.map((addr) => `  ${addr}`),
    `（${INTENDED_HINT}。）`,
  ].join('\n')
}

/**
 * 渲染**纯文本**那一份。
 * ⚠️ 它同时是"发出去的 text"与"PII 体检的底稿"（见 `sendMail`）——
 *    体检与发送长得不一样，就是两种失效方式。
 */
export function renderText(doc: MailDoc): string {
  const out: string[] = []
  /** 只在上一行不是空行时补空行 —— 别把正文里用户自己的空行吃掉 */
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('')
  }
  out.push(doc.title)
  if (doc.subtitle) out.push(doc.subtitle)
  if (doc.lead) {
    blank()
    out.push(doc.lead)
  }
  if (doc.rows?.length) {
    blank()
    for (const row of doc.rows) {
      out.push(`${row.k}：${row.v}`)
      /* note = "这个参数意味着什么"：缩进一行，读起来像注解而不是另一个参数 */
      if (row.note) out.push(`  ↳ ${row.note}`)
    }
  }
  if (doc.body) {
    blank()
    out.push(doc.body)
  }
  if (doc.actions?.length) {
    blank()
    out.push('接下来可以这样做：')
    doc.actions.forEach((action, i) => out.push(`  ${i + 1}. ${action}`))
  }
  if (doc.intendedTo?.length) {
    blank()
    out.push(intendedTextBlock(doc.intendedTo))
  }
  blank()
  out.push(doc.footer ?? DEFAULT_MAIL_FOOTER)
  return `${out.join('\n').replace(/\s+$/, '')}\n`
}

/**
 * 渲染**HTML**那一份。
 * 🔴 硬约束（用户点名，也是邮件客户端的现实）：
 *   · 600px、**table 布局**（Outlook 不认 flex/grid）、**全部内联样式**；
 *   · **零外部图片 / 字体 / JS / 链接** —— 不引 webfont、不挂像素、不放 `<a>`；
 *   · 用户内容（标题 / 参数 / 正文 / 反馈）**全部经过 `escapeHtml()`**，
 *     任何 `<` `>` `"` 都只能变成字面字符，**没有一处拼标签**。
 */
export function renderHtml(doc: MailDoc): string {
  const rows = doc.rows ?? []
  const actions = doc.actions ?? []
  const intended = doc.intendedTo ?? []

  const subtitleHtml = doc.subtitle
    ? `<tr><td style="padding:14px 28px 0;font-size:12px;line-height:20px;color:#6b7280;">${escapeHtml(doc.subtitle)}</td></tr>`
    : ''
  const leadHtml = doc.lead
    ? `<tr><td style="padding:14px 28px 0;font-size:15px;line-height:24px;color:#1f2328;">${htmlLines(doc.lead)}</td></tr>`
    : ''
  const rowsHtml = rows.length
    ? `<tr><td style="padding:18px 28px 4px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
${rows
  .map(
    (row) => `<tr>
<td width="34%" valign="top" style="padding:10px 12px 10px 0;border-bottom:1px solid #eef0f3;font-size:13px;line-height:20px;color:#5b6472;vertical-align:top;">${escapeHtml(row.k)}</td>
<td valign="top" style="padding:10px 0;border-bottom:1px solid #eef0f3;font-size:14px;line-height:22px;color:#1f2328;vertical-align:top;">${htmlLines(row.v)}${
      row.note
        ? `<div style="margin-top:4px;font-size:12px;line-height:18px;color:#8a94a6;">${escapeHtml(row.note)}</div>`
        : ''
    }</td>
</tr>`,
  )
  .join('\n')}
</table>
</td></tr>`
    : ''
  const bodyHtml = doc.body
    ? `<tr><td style="padding:18px 28px 0;font-size:14px;line-height:24px;color:#1f2328;">${htmlLines(doc.body)}</td></tr>`
    : ''
  const actionsHtml = actions.length
    ? `<tr><td style="padding:18px 28px 0;">
<div style="font-size:14px;line-height:22px;font-weight:700;color:#1f2328;">接下来可以这样做</div>
<ol style="margin:8px 0 0;padding-left:22px;font-size:14px;line-height:24px;color:#1f2328;">
${actions.map((action) => `<li style="margin:0 0 6px;">${escapeHtml(action)}</li>`).join('\n')}
</ol>
</td></tr>`
    : ''
  const intendedHtml = intended.length
    ? `<tr><td style="padding:18px 28px 4px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#fff8e1;border-left:5px solid #f0a020;">
<tr><td style="padding:14px 16px;">
<div style="font-size:13px;line-height:20px;font-weight:700;color:#8a5a00;">${INTENDED_TITLE}</div>
<div style="margin-top:6px;font-size:13px;line-height:22px;color:#5c4700;word-break:break-all;">${intended.map((addr) => escapeHtml(addr)).join('<br>')}</div>
<div style="margin-top:8px;font-size:12px;line-height:20px;color:#8a6d1f;">${INTENDED_HINT}。</div>
</td></tr>
</table>
</td></tr>`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="${MAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${MAIL_WIDTH}px;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;font-family:${MAIL_FONT};">
<tr><td style="background:${BRAND_BLUE};padding:22px 28px;">
<div style="font-size:12px;line-height:18px;color:#dbeafe;letter-spacing:1px;">树高教务通 · 树高教务助手</div>
<div style="margin-top:8px;font-size:23px;line-height:32px;color:#ffffff;font-weight:700;">${escapeHtml(doc.title)}</div>
</td></tr>
${subtitleHtml}
${leadHtml}
${rowsHtml}
${bodyHtml}
${actionsHtml}
${intendedHtml}
<tr><td style="padding:18px 28px 22px;border-top:1px solid #e8ebf2;font-size:12px;line-height:20px;color:#8a94a6;">${escapeHtml(doc.footer ?? DEFAULT_MAIL_FOOTER)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`
}

/**
 * 发出去之前统一洗一遍凭据（与旧的 `scrubSecrets(text)` 同一个位置、同一件事）。
 * 🔴 **转发目标不洗**：那些地址就是给人复制去转发的，洗掉这一块等于把这封信的功能删了。
 */
function scrubDoc(doc: MailDoc): MailDoc {
  const clean = (value: string) => scrubSecrets(value)
  return {
    title: clean(doc.title),
    subtitle: doc.subtitle ? clean(doc.subtitle) : undefined,
    lead: doc.lead ? clean(doc.lead) : undefined,
    rows: doc.rows?.map((row) => ({
      k: clean(row.k),
      v: clean(row.v),
      ...(row.note ? { note: clean(row.note) } : {}),
    })),
    body: doc.body ? clean(doc.body) : undefined,
    actions: doc.actions?.map((action) => clean(action)),
    /* ⚠️ 只有这一块**不做 scrubSecrets**（理由见上）；空白地址顺手剔掉 */
    intendedTo: doc.intendedTo?.map((addr) => addr.trim()).filter(Boolean),
    footer: doc.footer ? clean(doc.footer) : undefined,
  }
}

/**
 * **体检底稿**：`sendMail()` 实际喂给 `looksLikeStudentData()` 的那一份。
 *
 * 🔴 转发块是**结构性豁免**（不是放宽判据！）：
 *    · 先 `renderText({ ...doc, intendedTo: [] })` —— 把"本来该发给谁"那一块整段摘掉；
 *    · 再把块里**逐个列出的那几个地址**在别处出现时换成占位符 —— 因为像"登录账号"
 *      这种参数会在正文里也写一次同一个地址，它和转发块里那一行**是同一件事**；
 *    · 除此之外一个字都不放过：不是这些地址、不是这一块，命中照旧 `pii_blocked`。
 * ⚠️ 这个豁免只覆盖**我们自己构造的转发目标**（调用点给的值，不是用户随手写的正文）；
 *    它没有改 `PII_PATTERNS` 里任何一条判据。
 */
export function piiCheckText(doc: MailDoc): string {
  const clean = scrubDoc(doc)
  const targets = clean.intendedTo ?? []
  let text = renderText({ ...clean, intendedTo: [] })
  for (const addr of targets) {
    text = text.split(addr).join('（转发目标地址）')
  }
  return text
}

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
  /*
   * 🆕 2026-10-06 学生档案那四个字段（`schema.sql` §2.1 / §35）：
   * 家长电话与家庭住址是**第三方 PII**（不是老师自己的隐私），一封备份通知带出去
   * 就是全校家长电话出了系统 —— 所以它们进这一串窄判据。
   * ⚠️ 三条都刻意**认形状、不认人名**（"张三"那种裸姓名照旧抓不到，诚实说明见文件头）。
   */
  {
    re: /(家长电话|监护人电话|联系电话|手机号|家庭住址|现住址|住址|出生年月|出生日期|民族)\s*[:：]/,
    why: '出现"家长电话/家庭住址/出生年月/民族："这种标注',
  },
  // 家长电话最常见的形状：11 位手机号（⚠️ 正常运维文案里不会出现这种连号）
  { re: /\b1[3-9]\d{9}\b/, why: '出现 11 位手机号' },
  /*
   * 民族名（带"族"字）。⚠️ **刻意不收裸的"民族"两个字** —— 那在历史/政治的
   * 正常文案里到处都有（"民族区域自治"），误伤比漏提醒更烦人；
   * 带标注的写法（`民族：`）由上面那一条兜住。
   */
  {
    re: /(汉族|回族|满族|壮族|苗族|彝族|土家族|藏族|蒙古族|维吾尔族|侗族|瑶族|白族|朝鲜族|畲族|黎族|傣族|佤族|纳西族|羌族)/,
    why: '出现民族名',
  },
  /*
   * 🆕 2026-10-06 教师档案那三个字段（`schema.sql` §1.1 / §36）：
   * **家庭住址 / 电话号码 / 邮箱**也是 PII（老师的个人信息同样是个人信息）。
   * ⚠️ 老师这一侧**只加一条**，理由要说清楚（免得后来的人以为漏了）：
   *    · **住址**：上面那条标注判据（`…|住址|…`）已经把「住址：…」「家庭住址：…」收进来了；
   *      而**裸的门牌写法**（"3号楼2单元501"）**刻意不收** —— 它和"版本 1.2.3"、
   *      "第 3 单元测试"这种正常文案撞车，误伤比漏提醒更烦人（与"民族"那一条同一个取舍）。
   *    · **电话**：上面那条 11 位手机号的形状判据**已经**兜住了，一个字都不用加。
   *    · **邮箱**：见下面新增的那一条 —— **只认 `@` 的形状，不认"邮箱"两个字**。
   */
  {
    /*
     * 🔴 **「邮箱」两个字本身不是触发词**（与"民族"那一条同一个道理）：
     *    邮件正文里说"有问题发我邮箱"完全正常，为它整封信不发是误伤。
     *    邮箱一旦**写出来**就必然带 `@` —— 所以只收**地址的形状**。
     *    ⚠️ 与 `report_frontend_error` 里那条（`@` 的形状）**同源**，两边一起改。
     *
     * 🔴 **2026-10-06 收窄**（这一条曾经**过宽**，实测抓到三处误伤 —— 只看"值"不看"词"）：
     *    · 第一版是 `[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+` ——
     *      **最后一段允许纯数字**，于是"版本 1.2.3@2026.10.06"、"报告.docx@2026-10-06"
     *      这种**带 `@` 的正常写法**会被判成邮箱（地址的 TLD 不可能是纯数字）。
     *    · 现在**要求最后一段以 2 个以上字母结尾**（`.com` / `.cn` / `.dev` / `.edu.cn`）；
     *      真地址一个都没漏（`admin-checks` ⑤ 有一条正向断言钉着）。
     *    ⚠️ **本地部分（`@` 前面）故意不管**：这里量的是"正文会不会把一句话连人带字发出去"，
     *       不是"这个地址能不能收到信"—— 判形状，判到"像个人人都会读成邮箱的东西"就够。
     */
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    why: '出现邮箱地址的形状（`@` + 域名）',
  },
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

/* ============================================================
   ①-B 系统自动发出的邮件正文 —— **唯一的一份目录**（自测与"体检清单"都读它）
   ------------------------------------------------------------
   🔴 为什么要有这个目录（同一个坑的**第三次预防**）：
     · **第 1 次**：备份通知的免责声明里写了"成绩"两个字 → 被自己的"成绩类词"判据拦下；
     · **第 2 次**：测试邮件正文里写了 `onboarding@resend.dev` → 被自己的"邮箱形状"判据拦下，
       线上「发测试邮件」恒 **502**（`/api/mail {action:'test'}`）；
     · **第 3 次**（也就是这一节）：公告通知的免责声明里**同样**印着那个发件人地址 ——
       它一起被拦下了，只是那一处是"勾选框可选"，坏得没那么显眼。
   三次的**形状完全相同**：**系统自己构造的正文，被系统自己的 PII 判据拦下**。
   治法不是"每次都记得避开触发词"（那靠不住），而是：
     1. 把**所有**系统正文收进下面这个目录（一处构造 = 一处能体检的正文）；
     2. `admin-checks` ⑤ 拿 `looksLikeStudentData()` **逐条喂一遍**，任何一条命中就判红；
     3. 反向对照：往正文里塞回一个真地址 → 必须红。
   ⚠️ **新加一处发信 = 往 `SYSTEM_MAIL_BODIES` 里加一条**，否则它就是一条**没被体检过**的正文
      （目录里有几条，自测就断言几条；漏了不会红，所以"加发信"与"加目录"必须一起做）。
   ⚠️ 目录里放的是**正文构造**（纯函数 + 显式入参），不是"正文模板字符串"：
     `mail.ts` / `announcement.ts` / `feedback.ts` / `grade-promote.ts` **真的用它**，
     自测量到的才与线上发出去的是同一份东西（复刻一份 = 从今往后与真正文分叉）。
   ============================================================ */

/** 系统正文的公共入参（时间戳一律北京时间的 `beijingStamp()` 结果） */
export type MailBodyCtx = {
  /** 北京时间的那一行字（`beijingStamp()`） */
  stamp: string
  /** 最近 24 小时发了几封（`mailedInLastDay()`；读不到是 `null`） */
  sentToday: number | null
}

/** 公告通知（`POST /api/announcement` 的 `create` + 勾选框） */
export type AnnouncementMailArgs = {
  title: string
  level: string
  popup: string
  pin: boolean
  from: string | null
  to: string | null
  /** 公告正文（**服务端原样带上**；PII 体检在 `sendMail()` 里） */
  text: string
  /**
   * 🔴 「这封信本来应该发给」—— 平台里老师们的登录地址。
   * ⚠️ 它**不在 PII 体检范围里**（结构性豁免，见 `piiCheckText()`）：这是转发目标清单，
   *    不是被夹带出去的第三方数据；没有它，未验域名时这封信根本没法逐个转发。
   */
  intendedTo?: string[]
}

/** 反馈回执（`POST /api/feedback` 的 `submit`；⚠️ 正文是**用户手写的自由文本**） */
export type FeedbackMailArgs = {
  stamp: string
  /** 作者显示名（库里那一份） */
  authorName: string
  /** 作者 id（没有名字时兜底） */
  authorId: string
  authorRoles: string
  page: string
  env: string
  /** 用户自己留的联系方式（可空；**它是本人自愿填的**，与"正文夹带"是两件事） */
  contact: string
  /** 用户手写的正文 */
  text: string
}

/** 毕业备份通知（`POST /api/grade-promote` 的 `backup`） */
export type GradeBackupMailArgs = {
  stamp: string
  /** 年级名（**不是学生**） */
  gradeName: string
  /** 已经算好的一句话（班级数 / 学生数 / 档案数） */
  countsLine: string
  /** 已经算好的一句话（备份大小） */
  sizeLine: string
  /** 已经算好的一句话（md5；32 位十六进制会被 `scrubSecrets()` 洗掉） */
  checksumLine: string
  /** 相对路径 + 令牌（**故意的**：绝对 URL 的 query string 会被 `scrubSecrets()` 擦掉） */
  tokenPath: string
}

/** 登录成功后的欢迎信（另一个 agent 在 `teacher-account.ts` 建号成功后调用） */
export type WelcomeMailArgs = MailBodyCtx & {
  /** 这位老师的登录地址（= `auth.users.email`）—— 也是这封信**本来该发给**的人 */
  to: string
  /** 登录账号（通常就是 `to`） */
  account: string
  /** 身份的人话，例如「任课教师 · 语文」 */
  roleText: string
  /** 登录页地址（给老师的那个入口） */
  loginUrl: string
}

/** 前端报错汇总（另一个 agent 在 `frontend-error.ts` 调用；同一类错误已合并） */
export type FrontendErrorMailArgs = MailBodyCtx & {
  /** 本次合并了多少条（可能多于下面 items 的条数） */
  count: number
  items: Array<{
    page: string
    who: string
    at: string
    message: string
    stack?: string
    browser: string
  }>
}

const readOut = (v: number | null) => (v === null ? '读不到' : String(v))

/** 公告等级 / 弹窗方式的人话（**与数据库的枚举逐字对应**，见 `lib/announcements.ts`） */
const LEVEL_TEXT: Record<string, string> = { normal: '普通', important: '重要', urgent: '紧急' }
const POPUP_TEXT: Record<string, string> = {
  never: '不弹窗',
  once: '只弹一次',
  session: '本次登录弹一次',
  always: '每次都弹',
}

/**
 * 系统自动发出的**全部**正文（`looksLikeStudentData()` 的自测清单就是它的键）。
 * ⚠️ 这几个函数**不引用本文件以外的任何东西**（只引用 `MAIL_DAILY_CAP` 与几个纯函数），
 *    否则自测会把整条服务端依赖链拖进来。
 *
 * 🆕 **2026-10-29：每一项从"返回字符串"改成"返回 `MailDoc`"** ——
 *    纯文本 / HTML 都由 `renderText()` / `renderHtml()` 从同一份模型渲染，
 *    再也不会出现"HTML 里改了、纯文本还是旧话"这种分叉。
 */
export const SYSTEM_MAIL_BODIES = {
  /** 管理台 → 维护 →「发测试邮件」（只有超管；线上恒 502 的那一条就是这个） */
  test: (c: MailBodyCtx): MailDoc => ({
    title: '邮件通道自测',
    subtitle: '管理台 → 维护 · 发测试邮件',
    lead: '这是一封测试邮件 —— 你在「管理台 → 维护 / 发测试邮件」点了那个按钮。',
    rows: [
      {
        k: '发送时间',
        v: c.stamp,
        note: '这是服务器的北京时间；如果差了几个小时，说明时区设置有问题',
      },
      {
        k: '今天已发',
        v: `${readOut(c.sentToday)} 封（上限 ${MAIL_DAILY_CAP} 封/天）`,
        note: '这个数字只算最近 24 小时；到了上限系统会自动停发，第二天恢复',
      },
    ],
    /*
     * ⚠️ 这里**不许写出发件地址**（2026-10-06 线上恒 502 的根因）：
     *    正文里一出现 `@` 的形状，就会被 `looksLikeStudentData()` 的邮箱判据拦下。
     *    发件人是谁由 `MAIL_FROM` 那一个常量决定，正文里不复述。
     */
    body: '收到这封信 = 邮件通道是通的。',
    actions: [
      '不用做任何事；这封信只是用来确认通道',
      '没收到时先看垃圾邮件；还是没有，就检查 RESEND_API_KEY 与 ADMIN_NOTIFY_EMAIL 两个环境变量',
    ],
  }),

  /** 备份完成通知（备份 → 发信 → 出问题就不许删） */
  backup: (c: MailBodyCtx & { summary: string; detail: string }): MailDoc => ({
    title: '备份完成通知',
    subtitle: '管理台 · 手动通知',
    lead: '有一次备份完成了。',
    rows: [
      {
        k: '摘要',
        v: c.summary || '(没有摘要)',
        note: '这是你点按钮时填的一句话，用来提醒这次备份是哪一次',
      },
      {
        k: '细节',
        v: c.detail || '(没有细节)',
        note: '文件名或条数；没填不影响备份本身',
      },
      { k: '完成时间', v: c.stamp, note: '服务器记下的北京时间' },
    ],
    /*
     * 🔴 这一句的措辞是**被断言逼出来的**（第 1 次那个坑）：
     *    第一版写的是"没有任何学生姓名 / 学号 / 成绩"，而 `looksLikeStudentData()`
     *    里有一条"出现成绩类词" → **这句免责声明把自己给拦下了**（备份通知永远发不出去）。
     *    → 服务端自己构造的正文里，**别出现那四个触发词**（成绩 / 分数 / 得分 / 排名 / 名次）。
     */
    body:
      '⚠️ 本邮件由服务端构造正文：只有摘要与时间，没有任何学生个人信息。\n' +
      '🔴 如果这一环没能完成，那条链上的规矩是：**不许删**（本机备份文件要留着）。',
    actions: ['确认备份文件还在本机', '没收到这封信就先检查通道，再补发一次'],
  }),

  /** 公告留档（不是群发；`/api/announcement` 勾选框那一支） */
  announcement: (c: MailBodyCtx & AnnouncementMailArgs): MailDoc => ({
    title: c.title,
    subtitle: `全站公告 · ${LEVEL_TEXT[c.level] ?? c.level}${c.pin ? ' · 置顶' : ''} · ${c.stamp}`,
    lead: '你在管理台发布了一条全站公告。这封信是留档，方便你原样转给各位老师。',
    rows: [
      {
        k: '等级',
        v: LEVEL_TEXT[c.level] ?? c.level,
        note: '决定这条公告在顶部横幅里的轻重缓急；紧急的那一档会更显眼',
      },
      {
        k: '弹窗',
        v: POPUP_TEXT[c.popup] ?? c.popup,
        note: '决定老师打开页面时会不会被这条公告挡一下；不弹窗就只显示顶部横幅',
      },
      {
        k: '置顶',
        v: c.pin ? '是' : '否',
        note: '置顶时这条会排在其它公告前面，不会被别的公告压下去',
      },
      {
        k: '生效时间',
        v: `${c.from ?? '立即'} → ${c.to ?? '不过期'}`,
        note: '左边是开始显示的时间，右边是自动消失的时间；不过期就一直留着',
      },
      { k: '发布时间', v: c.stamp, note: '这条公告写进数据库的时间（北京时间）' },
    ],
    body: c.text,
    actions: [
      '照着下方「这封信本来应该发给」里的地址，一个一个转发',
      '内容要改就回管理台改，不用重新发信',
    ],
    intendedTo: c.intendedTo ?? [],
  }),

  /** 反馈回执（⚠️ 只有"用户手写的正文"与"他自己留的联系方式"是自由文本） */
  feedback: (a: FeedbackMailArgs): MailDoc => ({
    title: '收到一条用户反馈',
    subtitle: `我的 → 反馈 · 已落库 · ${a.stamp}`,
    lead: '有人从「我的 → 反馈」提了一条。这一条已经落库，这封邮件只是提醒。',
    rows: [
      { k: '提交时间', v: a.stamp, note: '服务器记下的北京时间' },
      {
        k: '提交账号',
        v: a.authorName || a.authorId,
        note: '这是提交那条反馈的账号；后面要找他核对，就按这一行认人',
      },
      {
        k: '身份',
        v: a.authorRoles || '(未提供)',
        note: '他自己在平台上选的身份标签；不对说明他的账号身份要调整',
      },
      {
        k: '页面',
        v: a.page || '(未提供)',
        note: '他在哪一页提的；按这个页面去复现最快',
      },
      {
        k: '环境',
        v: a.env || '(未提供)',
        note: '他从哪个端提的（网页 / 桌面端 / 教室端）',
      },
      {
        k: '联系方式',
        v: a.contact || '(没留)',
        note: '这是他自己愿意留的；没留就只能等他自己再来问',
      },
    ],
    body: a.text,
    actions: ['到管理台「反馈」里回复或标记已处理', '如果是页面出错，让他改用「前端错误上报」再报一次，那里有堆栈'],
  }),

  /** 毕业备份通知（备份没完成 = 这个年级删不掉） */
  gradeBackup: (a: GradeBackupMailArgs): MailDoc => ({
    title: `${a.gradeName}的毕业备份已生成`,
    subtitle: '提档与毕业 · 下载凭证',
    lead: '这一届的数据已经打包好了。备份没完成，这个年级就删不掉。',
    rows: [
      {
        k: '这一届的数据',
        v: a.countsLine,
        note: '每个数字是这一届在库里留下的行数；跟你预期的班级数对不上就先别删',
      },
      {
        k: '备份大小',
        v: a.sizeLine,
        note: '文件的大小；0 或读不到说明备份内容可能有问题',
      },
      {
        k: '校验和（md5）',
        v: a.checksumLine,
        note: '用来核对下载到的文件有没有损坏；跟下载后算出来的对不上就重新下一份',
      },
    ],
    body:
      '下载备份（90 天内有效）：\n' +
      '① 在平台上打开「提档与毕业」→「下载备份」（推荐，走登录态）\n' +
      `② 或把下面这一串接到本站地址后面：${a.tokenPath}\n` +
      '\n' +
      '⚠️ 这是「毕业删除」的第一道保护：**备份没能完成，这个年级就删不掉**。\n' +
      '⚠️ 删除只有最高管理员能做，而且要逐字输入年级全名。\n' +
      '⚠️ 本邮件正文不含任何学生个人信息。',
    actions: ['先在平台上确认能下载', '确认之后再回「提档与毕业」做删除'],
  }),

  /**
   * 🆕 欢迎信（另一个 agent 在 `teacher-account.ts` 建号成功后调用）。
   * 🔴 未验域名时它只能先发到管理员那个地址，所以 `intendedTo` 写明真实的收信人。
   */
  welcome: (c: WelcomeMailArgs): MailDoc => ({
    title: '欢迎使用树高教务通',
    subtitle: '账号已开通 · 请尽快登录',
    /*
     * ⚠️ 措辞要**两种身份都读得通**：教师端建号与**教室端一体机**建号共用这一份
     *    （`classroom-account.ts` 也调它，只是 `roleText` 不同）。
     *    所以这里不写"你的教师账号"—— 那封信读起来会变成"一体机收到一封教师欢迎信"。
     */
    lead: '有一个新账号已经建好了，下面是登录需要的信息。',
    rows: [
      {
        k: '登录账号',
        v: c.account,
        note: '用它登录，忘了可以找管理员重置',
      },
      {
        k: '身份',
        v: c.roleText,
        note: '决定你登录后能看哪些班、能做什么；不对就找管理员改',
      },
      {
        k: '登录地址',
        v: c.loginUrl,
        note: '在浏览器里打开这个地址，用上面的账号登录',
      },
    ],
    actions: [
      '打开登录地址，用登录账号登录',
      '第一次登录后把密码改成只有你知道的',
      '忘了密码就找管理员点「重置密码」',
    ],
    intendedTo: [c.to],
  }),

  /**
   * 🆕 前端报错汇总（另一个 agent 在 `frontend-error.ts` 调用）。
   * ⚠️ 报错原文是**技术文本**，但每一条后面都要有一句人话 —— 否则收到信的人只知道"报错了"。
   */
  frontendError: (c: FrontendErrorMailArgs): MailDoc => {
    const times = c.items.map((item) => item.at).filter(Boolean).sort()
    const range =
      times.length === 0
        ? '(没有记录)'
        : times[0] === times[times.length - 1]
          ? times[0]
          : `${times[0]} → ${times[times.length - 1]}`
    const body = c.items
      .map((item, i) => {
        const stack = (item.stack ?? '').trim()
        const stackLines = stack ? stack.replace(/\r\n?/g, '\n').split('\n') : []
        return [
          `${i + 1}. 页面：${item.page || '(未知页面)'}`,
          `   谁：${item.who || '(不知道)'}`,
          `   时间：${item.at || '(没有记录)'}`,
          `   浏览器：${item.browser || '(未知)'}`,
          `   报错原文：${item.message || '(空)'}`,
          ...(stackLines.length
            ? [
                `   堆栈（最多 6 行）：`,
                ...stackLines.slice(0, 6).map((line) => `     ${line}`),
                ...(stackLines.length > 6 ? [`     …（还有 ${stackLines.length - 6} 行）`] : []),
              ]
            : []),
          '   这句人话：这类报错通常是页面拿不到数据，或者点了一个已经过期的按钮。',
        ].join('\n')
      })
      .join('\n\n')
    return {
      title: '前端报错汇总',
      subtitle: '自动上报 · 同类错误已合并',
      lead: `有 ${c.count} 条前端报错，下面是合并后的详情。`,
      rows: [
        {
          k: '本次合并',
          v: `${c.count} 条`,
          note: '同一个错误在短时间内反复出现会被合并成一条；数字大说明那一处一直在报',
        },
        {
          k: '时间范围',
          v: range,
          note: '从最早的一条到最晚的一条；跨度大说明这个问题拖了很久',
        },
      ],
      body,
      actions: [
        '先看是不是同一个页面反复报（同一处 bug 的概率最大）',
        '去管理台「错误日志」看完整堆栈与更多条',
      ],
    }
  },
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
 * 发一封信（**纯文本 + HTML 两份都带**，同一份 `MailDoc` 渲染）。
 *
 * 🔴 **2026-10-29 改掉了"不做 HTML 邮件"那条旧判断**：用户明确要求排版好看、能照着转发，
 *    所以顶部色块 / 两列参数表 / 浅黄转发块都做进 HTML 里了（风险怎么收见文件头）。
 * ⚠️ 纯文本**一封都不能省**：它是"复制粘贴去转发"的那一份，也是 PII 体检唯一扫的那一份。
 * ⚠️ 它**不写数据库、不查配额** —— 那是 `sendAuditedMail()` 的事（分开写是有意的：
 *    "怎么发"与"发了要不要留痕 / 算不算配额"是两件事）。
 */
export async function sendMail(
  env: Env,
  mail: { subject: string; doc: MailDoc },
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

  /*
   * 🔴 硬要求 ③：正文体检（结构性保证 + 启发式，见文件头）。
   *
   * **只扫纯文本**，而且用 `piiCheckText()` —— 它把 `intendedTo` 那一块整段排除，
   * 再把块里那几个地址在别处出现时换成占位符。为什么这是**结构性豁免**、不是放宽判据：
   *   ① 豁免范围是**调用方显式给出的转发目标**（不是用户正文里随手写的地址）；
   *   ② 那几个地址出现在这封信里就是**目的本身**（"该转给谁"），不是被夹带出去的第三方数据；
   *   ③ 换个位置，同一串地址照旧会被"邮箱形状"判据拦住 —— `PII_PATTERNS` 一个字没动；
   *   ④ 测试里专门有一条反向对照：往普通正文里塞一个邮箱 → 仍然 `pii_blocked`。
   * ⚠️ 不这样做的话**每一封公告都会被自己的转发清单拦下**，一封也发不出去。
   */
  const pii = looksLikeStudentData(piiCheckText(mail.doc))
  if (pii) {
    return {
      ok: false,
      reason: 'pii_blocked',
      message: `正文疑似含学生信息（${pii}）—— 按纪律**不发信**；这一条会留在数据库里，面板上看得到`,
    }
  }

  /*
   * 洗凭据 + 渲染：**先洗 `MailDoc` 再渲染两份** ——
   * 这样 HTML 与纯文本洗的是同一份内容（不是洗完其中一份、另一份原样）。
   */
  const clean = scrubDoc(mail.doc)
  const text = renderText(clean).slice(0, 8000)
  /* ⚠️ HTML 不截断：截断可能把某个标签拦腰砍断（纯文本 8000 字是旧上限，留着） */
  const html = renderHtml(clean)

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
        html,
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
    /** 一封信的结构化内容（纯文本与 HTML 都由它渲染） */
    doc: MailDoc
    actorId: string | null
    actorName?: string
    /** 影响面（一般是 1 封） */
    affected?: number
    /** 跳过配额检查（只有"测试邮件"用：它就是用来验通道的，卡在配额上没意义） */
    skipQuota?: boolean
  },
): Promise<MailResult> {
  if (!mailConfigured(env)) {
    const r = await sendMail(env, { subject: mail.subject, doc: mail.doc })
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

  const r = await sendMail(env, { subject: mail.subject, doc: mail.doc })
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
