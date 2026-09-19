/* ============================================================
   手写 .docx（零依赖）
   ------------------------------------------------------------
   docx 就是一个 zip + 几个 XML。之前已经手写过 .xlsx 生成器验证过这条路，
   这里同样不引第三方库 —— 保持整个项目零运行时依赖。

   写 zip 需要两样浏览器原生没有现成 API 的东西：
     · CRC32 —— 自己算（一张 256 项的表）
     · deflate —— 用原生 CompressionStream('deflate-raw')
   ============================================================ */

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(u8: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* ---------------- 压缩 ---------------- */

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('这个浏览器不支持本地压缩，请用较新的 Edge / Chrome')
  }
  const s = new Blob([data as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

/* ---------------- 写 zip ---------------- */

export type ZipEntry = { name: string; bytes: Uint8Array }

export async function makeZip(entries: ZipEntry[]): Promise<Blob> {
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const comp = await deflateRaw(e.bytes)
    const crc = crc32(e.bytes)
    const name = new TextEncoder().encode(e.name)

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version
    lv.setUint16(8, 8, true) // deflate
    lv.setUint32(14, crc, true)
    lv.setUint32(18, comp.length, true)
    lv.setUint32(22, e.bytes.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local as unknown as BlobPart, comp as unknown as BlobPart)

    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, comp.length, true)
    cv.setUint32(24, e.bytes.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)

    offset += local.length + comp.length
  }

  const cenBuf = new Blob(central as unknown as BlobPart[])
  const cenLen = (await cenBuf.arrayBuffer()).byteLength

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cenLen, true)
  ev.setUint32(16, offset, true)

  return new Blob([...parts, cenBuf, eocd as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

/* ---------------- 写 docx ---------------- */

/** 一段内容。图片的 rid 要预先在 images 里登记 */
export type DocBlock =
  | { t: 'p'; text: string; bold?: boolean; size?: number; align?: 'left' | 'center'; space?: number }
  | { t: 'img'; rid: string; wEmu: number; hEmu: number }
  | { t: 'rule' }
  | { t: 'pagebreak' }

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 半磅：22 = 11pt。正文用 21（10.5pt，中文公文常用五号） */
const pt = (n: number) => Math.round(n * 2)

function para(b: Extract<DocBlock, { t: 'p' }>): string {
  const jc = b.align === 'center' ? '<w:jc w:val="center"/>' : ''
  const spacing = `<w:spacing w:before="${b.space ?? 0}" w:after="${b.space ?? 0}" w:line="320" w:lineRule="auto"/>`
  const rpr = `<w:rPr>${b.bold ? '<w:b/>' : ''}<w:sz w:val="${pt(b.size ?? 10.5)}"/><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/></w:rPr>`
  return `<w:p><w:pPr>${jc}${spacing}${rpr.replace('<w:rPr>', '<w:rPr>')}</w:pPr><w:r>${rpr}<w:t xml:space="preserve">${esc(b.text)}</w:t></w:r></w:p>`
}

function image(b: Extract<DocBlock, { t: 'img' }>, id: number): string {
  const ext = `<wp:extent cx="${b.wEmu}" cy="${b.hEmu}"/>`
  return (
    `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distR="0" distB="0" distL="0">${ext}` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="图片 ${id}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="图片 ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${b.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${b.wEmu}" cy="${b.hEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  )
}

/** data URL → 字节 + 扩展名 */
export function dataUrlToBytes(url: string): { bytes: Uint8Array; ext: string } | null {
  const m = url.match(/^data:image\/(\w+);base64,(.+)$/)
  if (!m) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, ext: m[1] === 'jpeg' ? 'jpg' : m[1] }
}

export async function buildDocx(blocks: DocBlock[], images: Map<string, Uint8Array>): Promise<Blob> {
  let imgId = 0
  const body = blocks
    .map((b) => {
      if (b.t === 'p') return para(b)
      if (b.t === 'img') return image(b, ++imgId)
      if (b.t === 'rule') return para({ t: 'p', text: '─'.repeat(28), align: 'center', size: 9 })
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    })
    .join('')

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`

  /* 图片关系表 */
  const relItems: string[] = []
  const media: ZipEntry[] = []
  let r = 0
  const ridOf = new Map<string, string>()
  for (const b of blocks) {
    if (b.t !== 'img') continue
    const rid = `rIdImg${++r}`
    ridOf.set(b.rid, rid)
  }
  let n = 0
  for (const [key, bytes] of images) {
    const rid = ridOf.get(key)
    if (!rid) continue
    const name = `image${++n}.png`
    media.push({ name: `word/media/${name}`, bytes })
    relItems.push(
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
    )
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relItems.join('')}</Relationships>`

  const enc = (s: string) => new TextEncoder().encode(s)
  return makeZip([
    { name: '[Content_Types].xml', bytes: enc(contentTypes) },
    { name: '_rels/.rels', bytes: enc(rootRels) },
    { name: 'word/document.xml', bytes: enc(document) },
    { name: 'word/_rels/document.xml.rels', bytes: enc(docRels) },
    ...media,
  ])
}

/** 下载一个 Blob 到本机 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
