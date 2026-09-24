/* ============================================================
   从 .docx 里抽出纯文本
   ------------------------------------------------------------
   docx 本质是一个 zip，正文在 word/document.xml。

   刻意**不引第三方库**：浏览器原生有 DecompressionStream('deflate-raw')，
   配一个几十行的 zip 中央目录解析就够了。
   好处是这一步完全在本机跑 —— **文件不上传**，教师不用担心稿子外流。
   ============================================================ */

type Entry = { method: number; compSize: number; localOff: number }

function findEocd(view: DataView, len: number): number {
  // End of Central Directory 签名 0x06054b50，从尾部往前找（注释最长 64KB）
  const floor = Math.max(0, len - 66000)
  for (let i = len - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i
  }
  return -1
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持本地解压，请改用「粘贴文字」的方式导入')
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** XML → 纯文本。段落之间留换行，单元格之间留制表符（选项常在一行里用制表符隔开）。 */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r\n?/g, '\n')
}

/** 读 docx 的正文文本 */
export async function docxToText(file: File | Blob): Promise<string> {
  const buf = await file.arrayBuffer()
  if (buf.byteLength < 22) throw new Error('文件太小，不像是 .docx')

  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  const header = new TextDecoder().decode(bytes.subarray(0, 4))
  if (header.startsWith('PK')) {
    // 正常的 zip
  } else if (header.startsWith('\xd0\xcf\x11\xe0')) {
    throw new Error('这是旧版 .doc 格式。请用 Word 另存为 .docx 再导入')
  } else {
    throw new Error('这不是 .docx 文件')
  }

  const eocd = findEocd(view, buf.byteLength)
  if (eocd < 0) throw new Error('文件结构不完整（找不到 zip 目录）')

  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  let target: Entry | null = null

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    let compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOff = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))

    if (name === 'word/document.xml') {
      // 少数写手会把中央目录里的长度留成 0，此时退回读本地头
      if (compSize === 0 && localOff + 30 <= buf.byteLength) {
        compSize = view.getUint32(localOff + 18, true)
      }
      target = { method, compSize, localOff }
      break
    }
    p += 46 + nameLen + extraLen + commentLen
  }

  if (!target) {
    throw new Error('这个文件里没有正文。如果是从 WPS/Word 导出的 .doc，请另存为 .docx')
  }

  const nameLen = view.getUint16(target.localOff + 26, true)
  const extraLen = view.getUint16(target.localOff + 28, true)
  const start = target.localOff + 30 + nameLen + extraLen
  const raw = bytes.subarray(start, start + target.compSize)
  const out = target.method === 8 ? await inflateRaw(raw) : raw

  return xmlToText(new TextDecoder('utf-8').decode(out))
}

/* ============================================================
   带图的抽取
   ------------------------------------------------------------
   练习册的 Word 稿里，每道题的配图是**独立图片且与题号对齐**
   （已用真实文档验证：9 张图严格对应第 1–8、10 题，第 9 题是纯文字题所以没图）。

   做法：把 <w:drawing> 整段替换成一个占位符 `\u0000rIdN\u0000`，
   这样图片在正文里的**位置信息就保留下来了**，再按题号切块时自然能对上。
   ============================================================ */

export type DocxParts = {
  /** 正文文本，图片位置是哨兵占位符 */
  text: string
  /** rId → data URL */
  images: Map<string, string>
  /**
   * 浮动锚定的图片数量（wp:anchor）。
   *
   * 随文图片（wp:inline）在 XML 里的先后顺序 = 视觉顺序，按位置归属可靠；
   * 浮动图片的位置是「锚在某个段落上、但画在别处」，XML 顺序与视觉顺序**可能不一致** ——
   * 这时候必须让教师人工核对，不能默认它对。
   */
  anchored: number
  /**
   * 压缩后的体积报告（题图会以 base64 存进 `question_meta`，见下面的「题图体积上限」）。
   *
   * `dropped > 0` 意味着**有图没进档案** —— 调用方应当把这件事说出来，
   * 而不是让教师以为图都在。
   */
  imageBudget: ImageBudget
}

export type ImageBudget = {
  /** 保留的图片张数 */
  kept: number
  /** 因为太大被重新编码（分辨率/画质下调）的张数 */
  reduced: number
  /** 压缩到地板仍然装不下、最终没保留的张数 */
  dropped: number
  /** 保留的图片合计字符数（data URL 长度） */
  chars: number
}

/* ------------------------------------------------------------
   题图体积上限
   ------------------------------------------------------------
   为什么要有：题图是**以 base64 直接塞进 `question_meta`（jsonb）** 的。
   练习册 Word 稿里的照片/扫描图动辄几 MB，一张 3000×4000 的 PNG 转成
   base64 就有十几 MB —— 一旦超出发送端的请求体积，**整条 assignment upsert
   都会被拒**：题量、分值、知识点、收缴与批改记录一起丢（云端模式刷新即丢，
   而界面已经提示"已导入"）。这是"静默丢数据"里最贵的一种。

   取舍：**先把图压小，而不是把图丢掉**。
   铁律是「AI/OCR 只是加速器，不能变成拦路虎，识别结果必须人工可确认」——
   所以这里不拒绝导入、不让保存失败：
     1. 单张够小（<= IMG_MAX_CHARS）就**原样保留**，不动一个像素；
     2. 太大就按阶梯重编码（长边逐级下调 + JPEG 画质逐级下调），
        打印在 A4 上（正文宽约 10.5 cm）1200 px 已经够清楚；
     3. 一整份稿子的合计还超（IMGS_TOTAL_MAX_CHARS）时，**所有图一起再降一档**，
        而不是从后面砍图 —— 保住"每题都有图"，宁可略糊；
     4. 阶梯到底仍然装不下的极端情况（几十张大图），才按小的优先保留，
        并把张数如实报给调用方（`imageBudget.dropped`）。
   ------------------------------------------------------------ */

/** 单张题图上限：data URL 字符数（base64 约 4/3 膨胀，≈180 KB 二进制） */
export const IMG_MAX_CHARS = 240_000
/** 一份稿子所有题图合计上限：≈1.2 MB 二进制，留足余量给同一行的其它字段 */
export const IMGS_TOTAL_MAX_CHARS = 1_600_000

/** 重编码阶梯：长边像素 × JPEG 画质，从好到差 */
const IMG_LADDER: Array<{ maxDim: number; quality: number }> = [
  { maxDim: 1600, quality: 0.85 },
  { maxDim: 1280, quality: 0.78 },
  { maxDim: 1000, quality: 0.7 },
  { maxDim: 820, quality: 0.6 },
  { maxDim: 640, quality: 0.5 },
]

/** 画到 canvas 上重编码。解码不了（浏览器不认的格式）就返回 null，由调用方兜底。 */
async function reencode(
  dataUrl: string,
  step: { maxDim: number; quality: number },
): Promise<string | null> {
  if (typeof document === 'undefined') return null
  try {
    const img = new Image()
    img.decoding = 'sync'
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = dataUrl
    })
    if (!loaded) return null
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!w || !h) return null

    const scale = Math.min(1, step.maxDim / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // 白底：PNG 的透明区域转 JPEG 会变黑，物理题图基本都在白纸上
    ctx.fillStyle = '***REMOVED***fff'
    ctx.fillRect(0, 0, cw, ch)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, cw, ch)
    const out = canvas.toDataURL('image/jpeg', step.quality)
    // 有些图（纯色/线框）JPEG 反而更大，那就退回原来的
    return out && out.length < dataUrl.length ? out : null
  } catch {
    return null
  }
}

/** 按阶梯把一张图压到 maxChars 以内；压不动就返回原图（由总量那一步兜底） */
export async function shrinkToLimit(dataUrl: string, maxChars: number): Promise<string> {
  if (dataUrl.length <= maxChars) return dataUrl
  for (const step of IMG_LADDER) {
    const next = await reencode(dataUrl, step)
    if (next && next.length <= maxChars) return next
  }
  // 阶梯走完还是大：至少把它降到地板（画质最差的那一档）
  const floor = await reencode(dataUrl, IMG_LADDER[IMG_LADDER.length - 1])
  return floor && floor.length < dataUrl.length ? floor : dataUrl
}

/**
 * 把一组题图压进预算。
 *
 * 先逐张压到单张上限，再整份看合计：超了就**所有图一起降到下一档**
 * （宁可大家都略糊一点，也不能"前 5 题有图、后面全没图"）。
 */
export async function fitImages(
  images: Map<string, string>,
  opts: { imgMax?: number; totalMax?: number } = {},
): Promise<{ images: Map<string, string>; budget: ImageBudget }> {
  const imgMax = opts.imgMax ?? IMG_MAX_CHARS
  const totalMax = opts.totalMax ?? IMGS_TOTAL_MAX_CHARS
  const budget: ImageBudget = { kept: 0, reduced: 0, dropped: 0, chars: 0 }
  if (images.size === 0) return { images: new Map(), budget }

  const entries = [...images.entries()]
  const out = new Map<string, string>()
  let reduced = 0

  // 第一遍：逐张压到单张上限
  for (const [rid, url] of entries) {
    const next = await shrinkToLimit(url, imgMax)
    if (next !== url) reduced++
    out.set(rid, next)
  }

  // 第二遍：合计还超就整份再降档（保留每一张，只牺牲分辨率）
  const sum = () => [...out.values()].reduce((n, u) => n + u.length, 0)
  if (sum() > totalMax) {
    for (const step of IMG_LADDER) {
      for (const [rid, url] of entries) {
        const next = await reencode(url, step)
        if (next) out.set(rid, next)
      }
      if (sum() <= totalMax) break
      // 整份都到了地板还是超：只能少留几张，小的优先（大的压缩收益更低）
      if (step === IMG_LADDER[IMG_LADDER.length - 1]) break
    }
    reduced = [...out.entries()].filter(([rid, u]) => u !== images.get(rid)).length
  }

  // 第三遍：仍然超预算（阶梯到底了）→ 按小的优先保留，如实报出丢了几张
  if (sum() > totalMax) {
    const ranked = [...out.entries()].sort((a, b) => a[1].length - b[1].length)
    const kept = new Map<string, string>()
    let used = 0
    for (const [rid, url] of ranked) {
      if (used + url.length > totalMax) continue
      kept.set(rid, url)
      used += url.length
    }
    // 恢复正文顺序（Map 的插入顺序就是图在稿子里出现的顺序）
    const ordered = new Map<string, string>()
    for (const [rid] of entries) {
      const url = kept.get(rid)
      if (url) ordered.set(rid, url)
    }
    budget.dropped = entries.length - ordered.size
    budget.reduced = reduced
    budget.kept = ordered.size
    budget.chars = used
    return { images: ordered, budget }
  }

  budget.reduced = reduced
  budget.kept = out.size
  budget.chars = sum()
  return { images: out, budget }
}

/** 图片占位符用的哨兵字符：私有区 U+E000，正文里不可能自然出现 */
const IMG_MARK = '\uE000'

export function imageMarker(rid: string): string {
  return `${IMG_MARK}${rid}${IMG_MARK}`
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  emf: 'image/emf',
  wmf: 'image/wmf',
}

function toBase64(u8: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode(...u8.subarray(i, i + CH))
  }
  return btoa(s)
}

export async function docxToParts(file: File | Blob): Promise<DocxParts> {
  const buf = await file.arrayBuffer()
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  const eocd = findEocd(view, buf.byteLength)
  if (eocd < 0) throw new Error('文件结构不完整（找不到 zip 目录）')

  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  const entries = new Map<string, Entry>()

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    let compSize = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const localOff = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    if (compSize === 0 && localOff + 30 <= buf.byteLength) {
      compSize = view.getUint32(localOff + 18, true)
    }
    entries.set(name, { method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }

  const readRaw = async (name: string): Promise<Uint8Array | null> => {
    const e = entries.get(name)
    if (!e) return null
    const nl = view.getUint16(e.localOff + 26, true)
    const el = view.getUint16(e.localOff + 28, true)
    const start = e.localOff + 30 + nl + el
    const raw = bytes.subarray(start, start + e.compSize)
    return e.method === 8 ? await inflateRaw(raw) : raw
  }
  const readText = async (name: string) => {
    const b = await readRaw(name)
    return b ? new TextDecoder('utf-8').decode(b) : null
  }

  const docXml = await readText('word/document.xml')
  if (!docXml) {
    throw new Error('这个文件里没有正文。如果是从 WPS/Word 导出的 .doc，请另存为 .docx')
  }

  /* 关系表：rId → media 路径 */
  const rels = (await readText('word/_rels/document.xml.rels')) ?? ''
  const relMap = new Map<string, string>()
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2].replace(/^\/?word\//, ''))
  }

  /* 把每个 drawing / pict 整段换成一个占位符，位置就留住了 */
  const anchored = [...docXml.matchAll(/<wp:anchor\b/g)].length
  const used = new Set<string>()
  const marked = docXml
    .replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, (seg) => {
      const rid = seg.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1]
      if (!rid) return ''
      used.add(rid)
      return imageMarker(rid)
    })
    .replace(/<w:pict\b[\s\S]*?<\/w:pict>/g, (seg) => {
      const rid = seg.match(/r:id="([^"]+)"/)?.[1] ?? seg.match(/r:embed="([^"]+)"/)?.[1]
      if (!rid) return ''
      used.add(rid)
      return imageMarker(rid)
    })

  /* 读图 */
  const images = new Map<string, string>()
  for (const rid of used) {
    const target = relMap.get(rid)
    if (!target) continue
    const data = await readRaw(`word/${target}`)
    if (!data) continue
    const ext = (target.split('.').pop() ?? 'png').toLowerCase()
    const mime = MIME[ext] ?? 'image/png'
    // emf / wmf 浏览器画不出来，docx 里也生成不了，直接跳过
    if (mime === 'image/emf' || mime === 'image/wmf') continue
    images.set(rid, `data:${mime};base64,${toBase64(data)}`)
  }

  /*
   * 题图最后要**以 base64 存进 question_meta**，所以在这里就把体积收进预算内 ——
   * 超限的话整条 assignment upsert 会被拒（题量/分值/收缴/批改一起丢）。
   * 详见上面「题图体积上限」那段取舍说明。
   */
  const fitted = await fitImages(images)

  return { text: xmlToText(marked), images: fitted.images, anchored, imageBudget: fitted.budget }
}
