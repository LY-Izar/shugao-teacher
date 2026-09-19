/* ============================================================
   读 .xlsx 的单元格
   ------------------------------------------------------------
   和 docx.ts 同一套路：xlsx 也是 zip + XML，用浏览器原生
   DecompressionStream 解压，不引任何第三方库。
   好处同样是**文件不上传** —— 学校发的课表不用过任何服务器。
   ============================================================ */

type Entry = { method: number; compSize: number; localOff: number }

function findEocd(view: DataView, len: number): number {
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

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&***REMOVED***(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

/** "C12" → 3（1 基列号） */
function colOf(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** 读第一个工作表，返回二维字符串数组（保持行列位置，空格为 ''） */
export async function xlsxToRows(file: File | Blob): Promise<string[][]> {
  const buf = await file.arrayBuffer()
  if (buf.byteLength < 22) throw new Error('文件太小，不像是 .xlsx')

  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // 旧版 .xls 是 OLE 复合文档，不是 zip
  if (new TextDecoder().decode(bytes.subarray(0, 4)).startsWith('\xd0\xcf\x11\xe0')) {
    throw new Error('这是旧版 .xls 格式。请用 Excel/WPS 另存为 .xlsx，或另存为 CSV 再导入')
  }

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

  const read = async (name: string): Promise<string | null> => {
    const e = entries.get(name)
    if (!e) return null
    const nameLen = view.getUint16(e.localOff + 26, true)
    const extraLen = view.getUint16(e.localOff + 28, true)
    const start = e.localOff + 30 + nameLen + extraLen
    const raw = bytes.subarray(start, start + e.compSize)
    const out = e.method === 8 ? await inflateRaw(raw) : raw
    return new TextDecoder('utf-8').decode(out)
  }

  /* 共享字符串 */
  const shared: string[] = []
  const ssXml = await read('xl/sharedStrings.xml')
  if (ssXml) {
    for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1]))
      shared.push(parts.join(''))
    }
  }

  /* 第一个工作表：优先 sheet1.xml，否则取排序最靠前的 */
  let sheetName = 'xl/worksheets/sheet1.xml'
  if (!entries.has(sheetName)) {
    const found = [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort()
    sheetName = found[0] ?? ''
  }
  const sheet = sheetName ? await read(sheetName) : null
  if (!sheet) throw new Error('这个文件里没有工作表')

  const rows: string[][] = []
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1]
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1] ?? ''
      const t = attrs.match(/t="([^"]+)"/)?.[1] ?? ''
      const body = cm[2]
      let v = ''
      if (t === 'inlineStr') {
        v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => unescapeXml(x[1])).join('')
      } else {
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        if (raw !== undefined) v = t === 's' ? (shared[Number(raw)] ?? '') : unescapeXml(raw)
      }
      const idx = ref ? colOf(ref) - 1 : cells.length
      while (cells.length < idx) cells.push('')
      cells[idx] = v.trim()
    }
    rows.push(cells)
  }
  return rows
}

/** 读 CSV / 制表符分隔的纯文本 */
export function textToRows(text: string): string[][] {
  const sep = text.includes('\t') ? '\t' : text.includes(',') ? ',' : null
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (sep ? line.split(sep) : line.split(/\s{2,}/)).map((c) => c.trim()))
}
