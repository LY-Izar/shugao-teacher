/* ============================================================
   每日作业 → 一张图片（800×600）
   ------------------------------------------------------------
   为什么要有它：桌面那套「把作业做成图片当壁纸」的小工具
   （`C:\Users\Administrator\Desktop\新建文件夹 (2)\每日作业`）已经有人写了，
   用户 2026-10-02 的口径是**把它内置进教室端**：屏上按那张图的版式显示 +
   能导出同一张图（老师可以拿去做壁纸 / 发班级群）。

   🔴 这一层只做"画一张图"，不碰数据库、不碰 React：
      谁调用它（教室端那块「每日作业」）自己决定拿什么数据。
   🔴 版式照抄那份壁纸工具：紫→紫灰渐变（`rgb(130,29,190)` → `rgb(164,138,186)`，
      与 `make_hw.ps1` 里那两个 `FromArgb` 一致）、日期在左上、每科一行、
      行距 40px。⚠️ 两份实现**不共享代码**（那份是 PowerShell + `System.Drawing`）——
      改这里的时候，别以为那边跟着变了。
   ============================================================ */

import { subjectShort } from './subjects'
import type { DailyHomework } from '../data/types'

const W = 800
const H = 600
/** 与那份壁纸工具同一对颜色（`FromArgb(130,29,190)` → `FromArgb(164,138,186)`） */
const FROM = [130, 29, 190] as const
const TO = [164, 138, 186] as const
/** 版心：左边留 1/3 白，正文从 x=270 起（照那张图的观感） */
const X = 270
const PAD = W - X - 30
const LINE_H = 40
const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif'

export type HomeworkImageInput = {
  /** 班名（画在右下角，用来认出这是哪个班的作业） */
  className: string
  /** 日期 `YYYY-MM-DD`（`beijing_today()` 那一口径的日期） */
  onDate: string
  /** 那一天的每日作业（同一天同一科可以不止一条） */
  rows: readonly DailyHomework[]
  /** 值日生（没有就不画那一行） */
  duty?: string | null
}

/** 日期画成 `M.d`（与那份壁纸工具的 `"        M.d"` 同一个口径） */
function titleOf(iso: string): string {
  const [, m, d] = iso.split('-')
  if (!m || !d) return iso
  return `${Number(m)}.${Number(d)}`
}

/** 一科一行：`语：第一条；第二条` */
function linesOf(rows: readonly DailyHomework[]): string[] {
  const bySubject = new Map<string, string[]>()
  for (const r of rows) {
    const label = subjectShort(r.subjectCode, r.subject) || r.subject || '其他'
    const list = bySubject.get(label) ?? []
    list.push(r.content)
    bySubject.set(label, list)
  }
  return [...bySubject.entries()].map(([label, list]) => `${label}：${list.join('；')}`)
}

/** 按宽度折行（中文没有词边界，逐字量最稳） */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      out.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 画好但**不下载**（导出前可以先在屏上预览） */
export function drawHomeworkImage(input: HomeworkImageInput): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  if (!ctx) return cv

  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, `rgb(${FROM[0]}, ${FROM[1]}, ${FROM[2]})`)
  g.addColorStop(1, `rgb(${TO[0]}, ${TO[1]}, ${TO[2]})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  ctx.textBaseline = 'top'
  ctx.fillStyle = 'rgb(255 255 255)'
  ctx.font = `700 36px ${FONT}`
  ctx.fillText(titleOf(input.onDate), X, 46)

  ctx.font = `400 22px ${FONT}`
  let y = 116
  const lines = linesOf(input.rows)
  if (!lines.length) {
    ctx.fillStyle = 'rgb(255 255 255 / .75)'
    ctx.fillText('今天还没有人留作业', X, y)
  } else {
    for (const line of lines) {
      for (const part of wrap(ctx, line, PAD)) {
        ctx.fillText(part, X, y)
        y += LINE_H
      }
      y += 6
    }
  }

  /* 右下角：班名 + 今天的值日生（那份壁纸工具里没有，是这一轮新加的） */
  ctx.font = `500 17px ${FONT}`
  ctx.fillStyle = 'rgb(255 255 255 / .82)'
  ctx.textAlign = 'right'
  if (input.duty) {
    ctx.fillText(`今天的值日生 · ${input.duty}`, W - 30, H - 66)
  }
  ctx.font = `500 15px ${FONT}`
  ctx.fillStyle = 'rgb(255 255 255 / .62)'
  ctx.fillText(input.className, W - 30, H - 40)
  ctx.textAlign = 'left'

  return cv
}

/** 导出的文件名：`高二(4)班-每日作业-2026-10-02.png` */
export function homeworkImageName(className: string, onDate: string): string {
  return `${className}-每日作业-${onDate}.png`
}

/** 画好 → PNG（失败回 `null`，调用方自己决定怎么说话） */
export function homeworkImageBlob(input: HomeworkImageInput): Promise<Blob | null> {
  const cv = drawHomeworkImage(input)
  return new Promise((resolve) => {
    try {
      cv.toBlob((b) => resolve(b), 'image/png')
    } catch {
      resolve(null)
    }
  })
}

/** 交给浏览器下载（教室端那块屏上点的，不写本机文件夹） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
