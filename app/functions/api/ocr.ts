/**
 * 拍照识别的服务端中转。
 *
 * 为什么必须放服务端：DeepSeek 的 API Key 绝不能出现在前端 ——
 * 前端产物是公开的，谁都能扒出来。
 *
 * 部署：这是 Cloudflare Pages Function，放在 <项目根>/functions/api/ocr.ts，
 * 推送到 GitHub 后 Cloudflare 会自动带上，不需要任何额外工具。
 * Key 配在 Pages 项目 → Settings → Variables and secrets，变量名 DEEPSEEK_API_KEY。
 */

type Env = { DEEPSEEK_API_KEY?: string }

const MODEL = 'deepseek-flash'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'

type Body = {
  image?: string
  className?: string
  /** 本班在册学号，用来把识别范围收窄，大幅降低误读 */
  nos?: string[]
  /** 'collect' 收作业查缺（侧面一列学号）；'roster' 花名册拍照 */
  scene?: 'collect' | 'roster'
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
  const scene = b.scene === 'roster' ? 'roster' : 'collect'
  const rangeText = nos.length
    ? `本班在册学号共 ${nos.length} 个：${nos.join('、')}。`
    : '不知道完整的学号列表，请只按图像本身判断。'

  if (scene === 'roster') {
    return `你在帮一位高中物理老师识别花名册照片里的学生。
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

  return `你在帮一位高中物理老师做「收作业查缺」。
${rangeText}

照片说明：一摞学生作业本，学号用黑色笔手写在侧面或一角，镜头对着这一列或一片号码。
常见问题，请尽力处理：
- 字迹潦草、连笔、写得很小
- **光照不均匀、有阴影、有反光或过曝**
- 号码被遮挡、只露出一部分、被翻页切断
- **除学号外还有中文姓名、科目、日期等字样 —— 只要学号数字，绝对不要把姓名当学号**
- 号可能是一位数或两位数
- 同一个号可能因为重影/反光被看成两次

要求：
1. 逐个列出你能看清的学号，按数字从小到大输出
2. 每个号给 confidence：high（清晰）/ low（模糊、被遮挡或存疑）
3. 把该处的原始字迹放进 raw 字段（例如把「17」看成「11」时，value=11, raw="17"）
4. **看不清的宁可标 low 也不要丢掉**，不要臆造不存在的号
5. 只输出 JSON，不要解释

输出格式：
{"numbers":[{"value":12,"confidence":"high","raw":"12"}],"unreadableCount":0,"notes":"第三个本子被胶带挡住一角，可能是 27"}`
}

export async function onRequestPost(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const key = context.env.DEEPSEEK_API_KEY
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

  let body: Body
  try {
    body = (await context.request.json()) as Body
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
        max_tokens: 2000,
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
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: unknown
    }
    content = parsed.choices?.[0]?.message?.content ?? ''
  } catch {
    return json({ status: 'error', message: '识别服务返回了无法解析的内容' }, 502)
  }
  if (!content) return json({ status: 'error', message: '识别服务没有返回内容' }, 502)

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
