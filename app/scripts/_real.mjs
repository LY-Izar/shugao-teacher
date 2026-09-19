/**
 * 用三张真实作业摞照片跑真实识别链路。
 * 关键：**先过一遍应用同款的图像预处理**，测的就是教师实际会遇到的效果。
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const DIR = 'C:\\Users\\Administrator\\.dsh\\attachments\\v1\\objects'
const FILES = [
  ['照片1 近景清晰', `${DIR}\\20\\2034c55d662bed74a5eefd9a433a6ea5f8953521629f0233062c4b53c158cd8f`],
  ['照片2 较远偏暗', `${DIR}\\3f\\3fbd5b5dd8c288b3d567f57d4732f4af8a1c427b84f2ec6f9b15a281a16f6b14`],
  ['照片3 同角度', `${DIR}\\3f\\3f88064f4234fc4b6946036256a390b40389a33d5afe3054aaee1861ed01086d`],
]

// 高二(4)班真实名单（学号已按顺序重排为 1–36）
const ROSTER = `1漆奕萱 2罗文瑜 3王梓馨 4曾绪杨 5李思涵 6代玺 7王志远 8杜添榏 9黄哲宇睿 10黄子皓
11贾清云 12姜瑞希 13李昊阳 14李林潞 15林子杰 16刘善桥 17刘雨薇 18吕思瑞 19马梓涵 20饶瑾轩
21宋思为 22谭思嘉 23万晨瑞 24徐梓茗 25杨侯童浩 26张雨欣 27杨欣怡 28杨雅雯 29张涵宇 30张婧宇
31张清宇 32张书旗 33赵奕鸣 34郑思宇 35邹开旭 36邹润豪`.split(/\s+/)
const NOS = ROSTER.map((s) => s.replace(/\D/g, ''))

const b = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
const p = await (await b.newContext()).newPage()
await p.goto('http://localhost:5178/', { waitUntil: 'domcontentloaded' })
await p.waitForTimeout(600)

for (const [label, path] of FILES) {
  const b64 = readFileSync(path).toString('base64')
  console.log(`\n${'='.repeat(64)}\n${label}  (${Math.round((b64.length * 0.75) / 1024)} KB)`)

  // 1) 应用同款预处理
  const prep = await p.evaluate(async (b64) => {
    const { preparePhoto } = await import('/src/lib/photo.ts')
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const r = await preparePhoto(new Blob([arr]), { enhance: true })
    return {
      url: r.dataUrl,
      w: r.width,
      h: r.height,
      luma: Math.round(r.meanLuma),
      dark: r.tooDark,
      bright: r.tooBright,
      low: r.lowContrast,
      kb: Math.round((r.dataUrl.length * 0.75) / 1024),
    }
  }, b64)

  console.log(
    `预处理: ${prep.w}x${prep.h} · ${prep.kb} KB · 亮度 ${prep.luma}` +
      `${prep.dark ? ' [偏暗]' : ''}${prep.bright ? ' [偏亮]' : ''}${prep.low ? ' [发灰]' : ''}`,
  )

  // 2) 真实接口
  const t0 = Date.now()
  const res = await fetch('https://shugao-teacher.pages.dev/api/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: prep.url, scene: 'collect', className: '高二(4)班', nos: NOS }),
  })
  const json = await res.json()
  const secs = ((Date.now() - t0) / 1000).toFixed(1)

  if (json.status !== 'ok') {
    console.log(`HTTP ${res.status} · ${secs}s · 失败: ${JSON.stringify(json)}`)
    continue
  }

  const nums = (json.data.numbers ?? []).slice().sort((a, c) => a.value - c.value)
  console.log(`HTTP ${res.status} · ${secs}s`)
  console.log(
    '识别到:',
    nums.map((n) => `${n.value}${n.confidence === 'low' ? '(low)' : ''}`).join(' ') || '（空）',
  )
  const raws = nums.filter((n) => n.raw && n.raw !== String(n.value))
  if (raws.length) console.log('原始字迹:', raws.map((n) => `值${n.value}/写作"${n.raw}"`).join(' '))
  console.log('备注  :', json.data.notes || '无')

  const nameOf = (v) => ROSTER.find((s) => s.replace(/\D/g, '') === String(v))?.replace(/^\d+/, '') ?? '?'
  console.log('对应学生:', nums.map((n) => `${n.value}=${nameOf(n.value)}`).join(' '))
  if (json.data.students?.length) {
    console.log('未交(推定):', json.data.students.length)
  }
}

await b.close()
