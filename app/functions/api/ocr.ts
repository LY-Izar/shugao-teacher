/**
 * 拍照识别的服务端中转。
 *
 * 为什么必须放服务端：DeepSeek 的 API Key 绝不能出现在前端 ——
 * 前端产物是公开的，谁都能扒出来。
 *
 * 🔴 调用者自校验（2026-09-25 加）：**这个 Function 以前谁都能调** ——
 *    只要知道地址（`<站点>/api/ocr`），任何人都能拿它去烧**这位老师的 DeepSeek 配额**，
 *    而且请求里可以塞任意大图。所以现在照 `teacher-account.ts` 那套做：
 *    先验 JWT 拿 uid，再问数据库"这个 uid 是不是本系统的人"。
 *
 *    **谁能用 OCR（口径）**：**本系统的登录账号 —— 教师、管理员、以及教室端账号都算。**
 *      · 教室端算进来的**理由**：教室一体机上本来就有「拍课表 → 识别 → 逐条核对」这一步
 *        （`Classroom.tsx` 的 `recognize(..., { scene: 'schedule' })`），
 *        它的登录身份就是教室端账号；把它挡掉等于**当场弄坏一个已经在用的功能**。
 *      · 判据不是"像不像老师"，而是**"这个 uid 在 `teachers` 表里有没有一行"** ——
 *        本系统的账号（含教室端）都由 `handle_new_user` 触发器建那一行
 *        （见 `schema.sql` §1 / §13.1，`remote.ts` 的 `loadClassroomAccount()` 也解释了这件事）。
 *        **没有这一行的 auth 用户 = 不是本校的人**，一律拒。
 *      · ⚠️ 没有为此新写一条"TS 里的规则"：判断"是不是本校的人"在数据库里就是
 *        "`teachers` 里有没有这一行"（RLS 的口径也是它），这里没有再抄一遍角色逻辑。
 *
 *    未通过时返回**人话 + 合适的 HTTP 码**（401 没登录 / 403 不是本校账号 / 503 库还没建），
 *    **不是 500**；前端 `lib/ocr.ts` 已经把这些 message 原样显示给老师。
 *
 * 部署：这是 Cloudflare Pages Function，放在 <项目根>/functions/api/ocr.ts，
 * 推送到 GitHub 后 Cloudflare 会自动带上，不需要任何额外工具。
 * 环境变量（Pages 项目 → Settings → Variables and secrets）：
 *   DEEPSEEK_API_KEY                              🔴 Secret，绝不能进前端
 *   SUPABASE_URL / VITE_SUPABASE_URL              校验调用者 JWT 用
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY    同上（公开无妨）
 */

type Env = {
  DEEPSEEK_API_KEY?: string
  SUPABASE_URL?: string
  VITE_SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  VITE_SUPABASE_ANON_KEY?: string
}

const MODEL = 'deepseek-flash'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'

type Body = {
  image?: string
  className?: string
  /** 本班在册学号，用来把识别范围收窄，大幅降低误读 */
  nos?: string[]
  /** 学科名（语文 / 物理 / …）。**可选**：只是让提示词里那句"帮一位高中X老师"更贴合场景，
   *  不传就是「高中老师」；老客户端不带这个字段照样工作。 */
  subject?: string
  /** 'collect' 查缺；'roster' 花名册；'count' 数本数；'schedule' 课表转写 */
  scene?: 'collect' | 'roster' | 'count' | 'schedule'
}

/**
 * 学科名是**用户可填的输入**（老师能在设置页写任意显示名），而它会被拼进提示词 ——
 * 所以先洗一遍：只留中英文字符，最多 8 个字。
 * 洗不出来就当没传（宁可提示词少一句，也不让输入改写提示词）。
 */
function safeSubject(v: unknown): string {
  const s = String(v ?? '')
    .replace(/[\r\n\t]/g, '')
    .trim()
  return /^[\u4e00-\u9fa5A-Za-z]{1,8}$/.test(s) ? s : ''
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function baseUrl(env: Env): string {
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
}

function anonKey(env: Env): string {
  return env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || ''
}

/**
 * 调用者是谁：拿他自己的 JWT 去问 Supabase Auth（`/auth/v1/user`）。
 * 与 `teacher-account.ts` / `classroom-account.ts` 的 `caller()` 同一个做法 —— 不自己解 JWT，
 * 免得"验签漏一处"这种事发生。token 一起返回：下面问 `teachers` 还要用它。
 */
async function caller(request: Request, env: Env): Promise<{ id: string; token: string } | null> {
  const auth = request.headers.get('Authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const key = anonKey(env)
  if (!key) return null
  const res = await fetch(`${baseUrl(env)}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return null
  const user = (await res.json()) as { id?: string }
  return user?.id ? { id: user.id, token } : null
}

/**
 * 他是不是本系统的人：`teachers` 表里有没有 id = 他的那一行。
 *
 * 为什么用**调用者自己的 JWT**（不是 service_role）问这一句：
 *   ① 这条路走的正是那套 RLS（"教师只能读自己那一行"`teachers_self`），
 *      所以它同时验证了"这张表存在 + 这一行归他管"，不需要额外的密钥；
 *   ② anon key 是公开的、JWT 是调用者的 —— 这个 Function 因此**不需要 service_role**，
 *      少一个高危密钥。
 *
 * 返回值三态：`true` 是本校账号 / `false` 不是 / `'missing'` 表还没建（要翻译成人话，
 * **不能当成 false** —— 那会告诉老师"你没权限"，而其实是库还没跑 schema.sql）。
 */
async function isSchoolMember(env: Env, token: string, uid: string): Promise<boolean | 'missing'> {
  const res = await fetch(
    `${baseUrl(env)}/rest/v1/teachers?select=id&id=eq.${encodeURIComponent(uid)}`,
    { headers: { apikey: anonKey(env), Authorization: `Bearer ${token}` } },
  )
  const text = await res.text()
  if (res.ok) {
    try {
      const rows = JSON.parse(text || '[]') as unknown[]
      return Array.isArray(rows) && rows.length > 0
    } catch {
      return false
    }
  }
  if (res.status === 404 || /42P01|PGRST205|does not exist|schema cache/i.test(text)) return 'missing'
  return false
}

/** 把「1,2,3,5-9」这类写法展开，也容忍直接给数组 */
function normalizeNos(nos: string[] | undefined): string[] {
  if (!Array.isArray(nos)) return []
  const out = new Set<string>()
  for (const raw of nos) {
    const s = String(raw).trim()
    if (!s) continue
    const range = s.match(/^(\d+)\s*[-~–—]\s*(\d+)$/)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      for (let i = Math.min(a, b); i <= Math.max(a, b) && i - Math.min(a, b) < 200; i++) out.add(String(i))
    } else if (/^\d{1,3}$/.test(s)) {
      out.add(s)
    }
  }
  return [...out]
}

function buildPrompt(b: Body, nos: string[]): string {
  const scene = b.scene ?? 'collect'
  // 「你在帮一位高中物理老师…」—— 以前这里写死了物理，语文/数学老师用同一个提示词。
  // 现在按请求里带的学科算，没带就只说「高中老师」。
  const subject = safeSubject(b.subject)
  const who = subject ? `高中${subject}老师` : '高中老师'

  /* ---- 先数本数：比认手写学号可靠得多 ---- */
  if (scene === 'count') {
    return `这是一摞学生交上来的作业本，从侧面拍的书脊/切口。

**只数有几本，不要认任何字，不要管上面写的是什么。**

数数要点：
- 最上面一本和最下面一本都要算
- 每一层的书脊就是一本，不要把同一本的封面和书页数成两本
- 边缘被压住、看不清的地方不要硬猜 —— 用 min / max 给一个区间

请输出：
{"count": 36, "min": 35, "max": 37, "confidence": "high", "notes": ""}

count 是你认为最可能的本数，min/max 是你有把握的下限与上限（完全确定时三个数相同）。
confidence 用 high 或 low。notes 写一两句数不清的地方。只输出 JSON，不要解释。`
  }

  /* ---- 课表照片：只转写成文本行，结构交给前端的解析器 ---- */
  if (scene === 'schedule') {
    return `这是一张课程表（可能是表格，也可能是手写或打印的清单）。

请把其中的**每一条课**转写成一行，格式固定为：
  周X HH:MM-HH:MM 课程名 [地点]

规则：
- 星期用「周一…周日」
- 时间统一成 24 小时制 HH:MM；若表里只有节次没有时间，按常见的中学节次表推算并照实写出
- 课程名照抄，比如「高二(3)班 语文」「备课组活动」
- 有地点就写在最后
- **表格里空格的部分不要编**（那是没课）
- 不是课表的文字（标题、备注、页眉）不要输出
- 只输出 JSON，不要解释

输出格式：
{"lines":["周二 08:55-09:40 高二(3)班 语文 高二(3)班教室","周三 14:30-15:15 备课组活动 办公室"],"notes":""}`
  }

  const rangeText = nos.length
    ? `本班在册学号共 ${nos.length} 个：${nos.join('、')}。`
    : '不知道完整的学号列表，请只按图像本身判断。'

  if (scene === 'roster') {
    return `你在帮一位${who}识别花名册照片里的学生。
${rangeText}

照片里是一张手写或打印的学生名单，每行通常有「学号 + 姓名」。
常见问题，请尽力处理：
- 字迹潦草、连笔、笔画粘连
- 光照不均匀、有阴影、反光、纸张发黄
- 手机拍摄有倾斜、透视变形
- 学号与姓名挨得很近甚至粘连
- 学号可能是 1~3 位数

要求：
1. 逐行识别，输出每个学生的 studentNo（只要数字）和 name（中文姓名）
2. 认不出的字段留空字符串，**不要瞎猜、不要跳行**
3. 每行给 confidence：high（清楚）/ low（模糊或存疑）
4. 只输出 JSON，不要解释

输出格式：
{"students":[{"studentNo":"12","name":"张三","confidence":"high","row":1}],"unreadableCount":0,"notes":"第 5 行被手指挡住"}`
  }

  return `你在帮一位${who}做「收作业查缺」。
${rangeText}

照片说明：一摞学生作业本，学号用笔写在侧面或书脊上，镜头对着这一列号码。
常见问题，请尽力处理：
- 字迹潦草、连笔、写得很小，写在**弯曲的书脊**上会有变形
- 光照不均匀、有阴影、有反光或过曝
- 号码被遮挡、只露出一部分、被翻页切断
- **除学号外还有中文姓名 —— 姓名一律忽略，绝对不要当学号，也不要用姓名去反推学号**
- 号可能是一位数或两位数；「8」和「18」在书脊上很容易混

【最重要的规则：只报你确实看见的数字】
1. **不要推理、不要解释、不要下结论**。不要判断「这可能是同一个人的多本」，
   也不要推测某个号属于谁 —— 那是教师的事，不是你的。
2. **同一个号出现两次就照实报两次**，不要合并、不要"纠正"，
   本系统自己会处理重号并推断误读。你只要如实转录。
3. **看不清就标 low**；完全看不清就只把它计入 unreadableCount。
   **宁缺毋滥：绝对不要臆造一个你没看见的号，也不要为了凑数去猜。**
4. 只输出 JSON，不要输出任何解释性文字。

要求：按数字从小到大排列；每个号给 confidence（high 清晰 / low 模糊或被遮挡）；
若某处字迹像另一个号，把原始字迹写进 raw（例如把「17」看成「11」时 value=11, raw="17"）。

输出格式：
{"numbers":[{"value":12,"confidence":"high","raw":"12"}],"unreadableCount":0,"notes":""}`
}

export async function onRequestPost(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context
  const key = env.DEEPSEEK_API_KEY
  if (!key) {
    return json(
      {
        status: 'not_configured',
        message:
          '还没配置识别服务。到 Cloudflare Pages → Settings → Variables and secrets 添加 DEEPSEEK_API_KEY，然后重新部署。',
      },
      503,
    )
  }

  /*
   * ---- 调用者自校验（在**读 body、动上游之前**）----
   * 🔴 顺序是故意的：先确认"这是谁"，再去碰图片和 DeepSeek 配额。
   *    放在后面（比如等解析完 body 再校验）等于让任何人都能先塞一张大图进来。
   */
  if (!baseUrl(env) || !anonKey(env)) {
    return json(
      {
        status: 'not_configured',
        message:
          '识别服务的登录校验还没配好：缺 SUPABASE_URL / SUPABASE_ANON_KEY。到 Cloudflare Pages 的环境变量里补上，然后重新部署。',
      },
      503,
    )
  }
  const me = await caller(request, env)
  if (!me) {
    return json(
      {
        status: 'error',
        message: '登录已过期，请重新登录后再用拍照识别',
      },
      401,
    )
  }
  const member = await isSchoolMember(env, me.token, me.id)
  if (member === 'missing') {
    return json(
      {
        status: 'error',
        message:
          '数据库还没建权限体系的表（仓库里 supabase/schema.sql 第 10 段）。先跑一遍 schema.sql，再回来用拍照识别。',
      },
      503,
    )
  }
  if (!member) {
    return json(
      {
        status: 'error',
        message:
          '这个账号不是本校的教师账号，不能用拍照识别（识别用的是学校的额度）。请用老师自己的账号登录。',
      },
      403,
    )
  }

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ status: 'error', message: '请求格式不对' }, 400)
  }

  const image = body.image
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return json({ status: 'error', message: '没有收到有效的图片' }, 400)
  }
  // 内联图片上限 32 MiB（DeepSeek 限制），前端已压到 1 MB 以内，这里兜个底
  if (image.length > 12 * 1024 * 1024) {
    return json({ status: 'error', message: '图片太大，请重新拍照' }, 413)
  }

  const nos = normalizeNos(body.nos)
  const prompt = buildPrompt(body, nos)

  let upstream: Response
  try {
    upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              // 读密集的手写数字，要保原图；low 会缩到 512×512，号码会糊
              { type: 'image_url', image_url: { url: image, detail: 'original' } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        temperature: 0,
      }),
    })
  } catch (e) {
    return json(
      { status: 'error', message: `连不上识别服务：${e instanceof Error ? e.message : String(e)}` },
      502,
    )
  }

  const text = await upstream.text()
  if (!upstream.ok) {
    return json(
      { status: 'error', message: `识别服务返回 ${upstream.status}`, detail: text.slice(0, 400) },
      502,
    )
  }

  let content = ''
  let finish = ''
  let reasoningLen = 0
  let usage = ''
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string }
        finish_reason?: string
      }>
      usage?: unknown
    }
    const ch = parsed.choices?.[0]
    content = ch?.message?.content ?? ''
    // 带思考的模型会把思维链放在 reasoning_content 里。
    // 如果 max_tokens 被思考吃光，content 就会是空的 —— 这种情况要能看出来。
    reasoningLen = (ch?.message?.reasoning_content ?? '').length
    finish = ch?.finish_reason ?? ''
    usage = JSON.stringify(parsed.usage ?? {})
  } catch {
    return json({ status: 'error', message: '识别服务返回了无法解析的内容' }, 502)
  }
  if (!content) {
    return json(
      {
        status: 'error',
        message:
          finish === 'length'
            ? '模型输出被截断了（思考占满了额度），请重试'
            : '识别服务没有返回内容，重试一次通常就好',
        detail: `finish=${finish} reasoningChars=${reasoningLen} usage=${usage}`,
      },
      502,
    )
  }

  // 模型偶尔会裹一层 ```json，稳妥起见剥掉
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let data: unknown
  try {
    data = JSON.parse(cleaned)
  } catch {
    return json({ status: 'error', message: '识别结果不是合法 JSON', detail: cleaned.slice(0, 300) }, 502)
  }

  return json({ status: 'ok', data })
}
