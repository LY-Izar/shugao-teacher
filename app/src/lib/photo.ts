/* ============================================================
   拍照识别的图像预处理
   ------------------------------------------------------------
   手机直接拍出来的照片，直接丢给模型效果会明显差一截：
     · 分辨率过高（4000×3000）→ 上传慢，且模型侧会缩放，等于白传
     · 光照不均 / 背光 / 过曝 → 手写字迹与纸面对比度不够
     · 拍歪了 → 数字倾斜，连笔更容易粘连
   这里在**本机**先做一轮处理，再把图送出去。本机处理还有个好处：
   原始照片不出设备，外发的是处理后的副本。
   ============================================================ */

export type Rotate = 0 | 90 | 180 | 270

export type PrepareOptions = {
  /** 长边上限，默认 1600 —— 够读手写数字，又不至于传一张几 MB 的原图 */
  maxSide?: number
  /** 自动对比度拉伸，默认开 */
  enhance?: boolean
  rotate?: Rotate
  quality?: number
}

export type PreparedPhoto = {
  dataUrl: string
  width: number
  height: number
  /** 增强后的平均亮度 0–255 */
  meanLuma: number
  /** 直方图太窄 = 画面发灰、光不够 */
  lowContrast: boolean
  /** 过暗或过亮，值得提醒教师补光重拍 */
  tooDark: boolean
  tooBright: boolean
}

/** 平均亮度 */
function meanLumaOf(d: Uint8ClampedArray): number {
  let sum = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  }
  return sum / n
}

/**
 * 自动对比度拉伸（就地改像素）。
 * 取亮度直方图的 2% 与 98% 分位当黑白点，把中间拉开 ——
 * 这是对付「光照不清晰」最有效也最稳的一招，比固定阈值鲁棒得多。
 */
function stretchInPlace(d: Uint8ClampedArray): { lo: number; hi: number } {
  const hist = new Uint32Array(256)
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++
  }

  const cut = Math.max(1, Math.round(n * 0.02))
  let acc = 0
  let lo = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= cut) {
      lo = v
      break
    }
  }
  acc = 0
  let hi = 255
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc >= cut) {
      hi = v
      break
    }
  }
  if (hi - lo < 16) return { lo: 0, hi: 255 }

  const lut = new Uint8ClampedArray(256)
  const k = 255 / (hi - lo)
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, (v - lo) * k))

  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]
    d[i + 1] = lut[d[i + 1]]
    d[i + 2] = lut[d[i + 2]]
  }
  return { lo, hi }
}

export async function preparePhoto(file: Blob, opts: PrepareOptions = {}): Promise<PreparedPhoto> {
  const maxSide = opts.maxSide ?? 1600
  const rot = ((opts.rotate ?? 0) % 360) as Rotate

  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error('这张图片读不出来，换一张或重拍试试')
  }

  const swap = rot === 90 || rot === 270
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const cw = swap ? h : w
  const ch = swap ? w : h

  const cv = document.createElement('canvas')
  cv.width = cw
  cv.height = ch
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持画布处理')

  ctx.save()
  ctx.translate(cw / 2, ch / 2)
  ctx.rotate((rot * Math.PI) / 180)
  ctx.drawImage(bmp, -w / 2, -h / 2, w, h)
  ctx.restore()
  bmp.close?.()

  const img = ctx.getImageData(0, 0, cw, ch)
  let lowContrast = false
  if (opts.enhance !== false) {
    const { lo, hi } = stretchInPlace(img.data)
    lowContrast = hi - lo < 100
  } else {
    lowContrast = false
  }
  ctx.putImageData(img, 0, 0)

  const meanLuma = meanLumaOf(img.data)

  return {
    dataUrl: cv.toDataURL('image/jpeg', opts.quality ?? 0.86),
    width: cw,
    height: ch,
    meanLuma,
    lowContrast,
    tooDark: meanLuma < 70,
    tooBright: meanLuma > 215,
  }
}
