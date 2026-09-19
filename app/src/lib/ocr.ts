/* ============================================================
   识别的客户端
   ------------------------------------------------------------
   走自己的 /api/ocr 中转（Cloudflare Pages Function），
   由它去调 DeepSeek 多模态模型 —— API Key 只在服务端。
   ============================================================ */

export type OcrNumber = {
  value: number
  confidence: 'high' | 'low'
  /** 该处的原始字迹，供教师核对 */
  raw?: string
}

export type OcrStudent = {
  studentNo: string
  name: string
  confidence: 'high' | 'low'
  row?: number
}

export type OcrOutcome =
  | {
      status: 'ok'
      numbers: OcrNumber[]
      students: OcrStudent[]
      unreadableCount: number
      notes: string
      /** 只有 scene: 'count' 才有 */
      count?: OcrCount
      /** 只有 scene: 'schedule' 才有：转写出来的课表文本行 */
      lines?: string[]
    }
  | { status: 'not_configured' | 'error'; message: string; detail?: string }

const TIMEOUT_MS = 60_000

/** 「数本数」的结果。min/max 是模型的把握区间，用于判断能不能下结论 */
export type OcrCount = {
  typical: number
  min: number
  max: number
  confidence: 'high' | 'low'
  note?: string
}

function asConfidence(v: unknown): 'high' | 'low' {
  return String(v).toLowerCase().startsWith('low') ? 'low' : 'high'
}

/** 模型返回的东西一律当不可信数据来洗 */
function sanitize(raw: unknown): OcrOutcome {
  const d = (raw ?? {}) as {
    numbers?: unknown
    students?: unknown
    unreadableCount?: unknown
    notes?: unknown
    count?: unknown
    min?: unknown
    max?: unknown
    confidence?: unknown
  }

  /* 数本数 */
  let count: OcrCount | undefined
  if (d.count !== undefined || d.min !== undefined || d.max !== undefined) {
    const c = Math.round(Number(d.count))
    let lo = Math.round(Number(d.min))
    let hi = Math.round(Number(d.max))
    if (Number.isFinite(c) && c >= 0) {
      if (!Number.isFinite(lo)) lo = c
      if (!Number.isFinite(hi)) hi = c
      // 容错：模型偶尔把 min/max 写反
      if (lo > hi) [lo, hi] = [hi, lo]
      count = {
        typical: c,
        min: Math.max(0, Math.min(lo, c)),
        max: Math.max(hi, c),
        confidence: asConfidence(d.confidence),
        note: typeof d.notes === 'string' ? d.notes.slice(0, 200) : undefined,
      }
    }
  }

  const numbers: OcrNumber[] = []
  if (Array.isArray(d.numbers)) {
    for (const item of d.numbers) {
      const o = item as { value?: unknown; confidence?: unknown; raw?: unknown }
      const n = Math.round(Number(o.value))
      // 学号只可能是 1–999 的整数；别的一律丢掉
      if (!Number.isFinite(n) || n < 1 || n > 999) continue
      numbers.push({
        value: n,
        confidence: asConfidence(o.confidence),
        raw: typeof o.raw === 'string' ? o.raw.slice(0, 12) : undefined,
      })
    }
  }

  const students: OcrStudent[] = []
  if (Array.isArray(d.students)) {
    for (const item of d.students) {
      const o = item as { studentNo?: unknown; name?: unknown; confidence?: unknown; row?: unknown }
      const no = String(o.studentNo ?? '').replace(/\D/g, '').slice(0, 4)
      const name = String(o.name ?? '').trim().slice(0, 12)
      if (!no && !name) continue
      students.push({
        studentNo: no,
        name,
        confidence: asConfidence(o.confidence),
        row: Number.isFinite(Number(o.row)) ? Number(o.row) : undefined,
      })
    }
  }

  return {
    status: 'ok',
    numbers,
    students,
    unreadableCount: Math.max(0, Math.round(Number(d.unreadableCount) || 0)),
    notes: typeof d.notes === 'string' ? d.notes.slice(0, 300) : '',
    count,
    lines: Array.isArray((d as { lines?: unknown }).lines)
      ? ((d as { lines: unknown[] }).lines
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 200) as string[])
      : undefined,
  }
}

export async function recognize(
  image: string,
  opts: { scene: 'collect' | 'roster' | 'count' | 'schedule'; className?: string; nos?: string[] },
): Promise<OcrOutcome> {
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        image,
        scene: opts.scene,
        className: opts.className,
        nos: opts.nos?.slice(0, 400),
      }),
    })

    const body = (await res.json().catch(() => null)) as
      | { status?: string; data?: unknown; message?: string; detail?: string }
      | null

    if (!body) {
      return {
        status: 'error',
        message:
          res.status === 404
            ? '识别服务还没部署（缺少 /api/ocr）。请重新部署一次，或检查 functions 目录。'
            : `识别服务返回了无法解析的内容（HTTP ${res.status}）`,
      }
    }

    if (body.status === 'not_configured') {
      return { status: 'not_configured', message: body.message ?? '还没配置识别服务' }
    }
    if (body.status !== 'ok') {
      return {
        status: 'error',
        message: body.message ?? `识别失败（HTTP ${res.status}）`,
        detail: body.detail,
      }
    }
    return sanitize(body.data)
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    return {
      status: 'error',
      message: aborted
        ? '识别超时了。可能是网络慢，或照片太大 —— 重试一次试试。'
        : `请求失败：${e instanceof Error ? e.message : String(e)}`,
    }
  } finally {
    window.clearTimeout(timer)
  }
}

/** 识别到的号（含低置信）去重后交给对账逻辑；低置信单独留一份给界面标黄 */
export function splitByConfidence(numbers: OcrNumber[]): {
  all: string[]
  lowConfidence: Set<string>
} {
  const all: string[] = []
  const lowConfidence = new Set<string>()
  for (const n of numbers) {
    const s = String(n.value)
    all.push(s)
    if (n.confidence === 'low') lowConfidence.add(s)
  }
  return { all, lowConfidence }
}
