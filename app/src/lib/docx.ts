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
  /** 正文文本，图片位置是 \u0000rIdN\u0000 占位符 */
  text: string
  /** rId → data URL */
  images: Map<string, string>
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

  return { text: xmlToText(marked), images }
}
