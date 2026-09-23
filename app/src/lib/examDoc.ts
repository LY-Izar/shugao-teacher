import { POINT_NAME } from './knowledge'
import { buildDocx, dataUrlToBytes, downloadBlob, type DocBlock, type DocImage } from './docxWrite'
import type { WrongItem } from './wrongbook'

/* ============================================================
   组「错题重练」卷
   ------------------------------------------------------------
   个人和班级共用这一套：给一批 WrongItem，出一份能打印的 docx。
   题目按知识点分组，每题留出作答空间。
   ============================================================ */

const A4_W = 3800000 // EMU，约 10.5 cm

export type PracticeOptions = {
  /** 卷头标题，例如「错题重练 · 高二(4)班 张三」 */
  title: string
  /** 副标题，例如「按知识点整理 · 共 6 题」 */
  subtitle?: string
  /** 要不要留作答空行（班级整卷一般留） */
  answerSpace?: boolean
}

/** 同一道题可能被多个学生错，去重后题号唯一 */
function distinct(items: WrongItem[]): WrongItem[] {
  const seen = new Map<string, WrongItem>()
  for (const it of items) seen.set(`${it.assignmentId}-${it.seq}`, it)
  return [...seen.values()].sort((x, y) =>
    x.date === y.date ? x.seq - y.seq : x.date < y.date ? 1 : -1,
  )
}

export async function buildPracticeDocx(
  items: WrongItem[],
  opts: PracticeOptions,
): Promise<{ blob: Blob; count: number; images: number }> {
  const list = distinct(items)
  const blocks: DocBlock[] = []
  const images = new Map<string, DocImage>()

  blocks.push({ t: 'p', text: opts.title, bold: true, size: 15, align: 'center', space: 100 })
  if (opts.subtitle) {
    blocks.push({ t: 'p', text: opts.subtitle, size: 10.5, align: 'center', space: 40 })
  }
  blocks.push({
    t: 'p',
    text: '姓名：________________    班级：____________    日期：________________',
    size: 10.5,
    space: 80,
  })

  /* 按知识点分组：先列出这批题覆盖了哪些知识点，教师一眼知道在练什么 */
  const byPoint = new Map<string, number>()
  for (const it of list) {
    const pts = it.points.length ? it.points : ['__none__']
    for (const p of pts) byPoint.set(p, (byPoint.get(p) ?? 0) + 1)
  }
  if (byPoint.size) {
    const names = [...byPoint.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${POINT_NAME[p] ?? '未归类'}(${n})`)
      .join('、')
    blocks.push({ t: 'p', text: `涉及知识点：${names}`, size: 10, space: 60 })
  }
  blocks.push({ t: 'rule' })

  let n = 0
  for (const it of list) {
    n++
    const pts = it.points.map((p) => POINT_NAME[p] ?? '').filter(Boolean).join('、')
    blocks.push({
      t: 'p',
      text: `${n}. （${it.score ?? '?'} 分）${pts ? `【${pts}】` : ''}`,
      bold: true,
      size: 11,
      space: 80,
    })

    /* 题干里的换行 Word 里要用 <w:br>，这里简单拆成多段 */
    const stem = (it.stem ?? '').trim()
    if (stem) blocks.push({ t: 'p', text: stem, size: 10.5, space: 40 })

    /* 一题可能不止一张图（比如「图甲」「图乙」）—— 全部嵌进去，别只取第一张 */
    for (const [k, url] of (it.imgs ?? []).entries()) {
      const d = dataUrlToBytes(url)
      if (!d) continue
      const rid = `p${n}_${k}`
      images.set(rid, d)
      blocks.push({ t: 'img', rid, wEmu: A4_W, hEmu: Math.round(A4_W * 0.68) })
    }

    blocks.push({ t: 'p', text: `（${it.assignmentTitle} · ${it.date}）`, size: 9, space: 40 })

    if (opts.answerSpace !== false) {
      for (let i = 0; i < 3; i++) blocks.push({ t: 'p', text: '', size: 10.5, space: 240 })
    }
    blocks.push({ t: 'rule' })
  }

  const blob = await buildDocx(blocks, images)
  return { blob, count: list.length, images: images.size }
}

/** 生成并直接下载 */
export async function downloadPracticeDocx(
  items: WrongItem[],
  opts: PracticeOptions,
  filename: string,
): Promise<number> {
  const { blob, count } = await buildPracticeDocx(items, opts)
  downloadBlob(blob, filename)
  return count
}
