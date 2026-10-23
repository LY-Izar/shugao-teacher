/**
 * 窗口管理器 · **纯逻辑核心**（P0b，教室端插件化）
 *
 * ============================================================================
 * 为什么单独一个文件、零 React 零 DOM
 * ============================================================================
 * 拖动 / 吸附 / 夹紧 / 布局归一化全是**可判定的算术**，跟渲染无关。分出来的理由
 * 与 `lib/pluginHost.ts`（P0a）同一个：判据写一份，界面只决定"摆不摆"。
 * 吸附是**一个引擎两档**（`snap: 'grid' | 'free'`，交接文档 §九 默认值 1 的口径）：
 * `applySnap()` 里只有一条路径，`free` 档只是"不取整、只夹紧"，**不是**第二套代码。
 *
 * 单位（手册 §4.1 的"别混"）：
 *   · 功能块窗口的位置/尺寸 —— **像素**存在布局里，但**格子**（1 格 = 96px）是
 *     网格档的取整单位；`manifest.window` 的 w/h 是格数，进门先换算成像素。
 *   · 悬浮窗（`pip.open`）用像素，与这里无关。
 */

/** 网格 1 格 = 96px（手册 §2.1 / §8 的口径，别改——改了要连手册一起改）。 */
export const GRID_PX = 96

export type SnapMode = 'grid' | 'free'

/** 窗口矩形（px，相对画布左上角）。 */
export interface WinRect {
  x: number
  y: number
  w: number
  h: number
}

/** 一扇窗口在布局里的那一行。`mode` 决定画不画、怎么画：
 *  · `open`      —— 正常显示；
 *  · `collapsed` —— **收起**：只剩标题栏，身体 display:none（**不卸载**——
 *                   手册 §3：收起时插件的定时器照跑，卸载了就是另一个 bug）；
 *  · `closed`    —— **收回**：不渲染（插件 deactivate）。留着这一行是为了
 *                   "收回再打开"能回到原来的位置，不是删布局。 */
export interface LayoutWin extends WinRect {
  id: string
  mode: 'open' | 'collapsed' | 'closed'
}

export interface ShellLayout {
  snap: SnapMode
  windows: LayoutWin[]
}

/** 画布尺寸（px）。 */
export interface CanvasSize {
  w: number
  h: number
}

/** 拖动/缩小的下限（px）。插件的下限来自 `manifest.window.min`（格数→px）。 */
export interface MinSize {
  w: number
  h: number
}

/** 任何人都不许把窗口拖出画布外：宽高先夹下限，再把 x/y 夹回画布内（至少留 40px 在屏上）。 */
export function clampRect(rect: WinRect, canvas: CanvasSize, min: MinSize): WinRect {
  const w = Math.max(min.w, Math.round(rect.w))
  const h = Math.max(min.h, Math.round(rect.h))
  const maxX = Math.max(0, canvas.w - 40)
  const maxY = Math.max(0, canvas.h - 40)
  return {
    w,
    h,
    x: Math.min(Math.max(Math.round(rect.x), -Math.min(w - 40, 0)), maxX),
    y: Math.min(Math.max(Math.round(rect.y), -Math.min(h - 40, 0)), maxY),
  }
}

/** 取整到网格（半格自动吸齐：四舍五入就是"拖到哪格算哪格"）。 */
function snapN(n: number): number {
  return Math.round(n / GRID_PX) * GRID_PX
}

/**
 * **一个引擎两档**：`grid` 档先取整再夹紧，`free` 档只夹紧。
 * ⛔ 不要给 `free` 档另写一条路径——它俩的差异就只有"取不取整"这一句。
 */
export function applySnap(rect: WinRect, canvas: CanvasSize, snap: SnapMode, min: MinSize): WinRect {
  if (snap === 'grid') {
    return clampRect({ x: snapN(rect.x), y: snapN(rect.y), w: snapN(rect.w), h: snapN(rect.h) }, canvas, min)
  }
  return clampRect(rect, canvas, min)
}

/** 格数 → px（manifest 的 `window` 进来用）。非正数一律兜回默认 1 格，不猜负窗口。 */
export function cellsToPx(cells: number): number {
  const n = Number.isFinite(cells) && cells > 0 ? Math.round(cells) : 1
  return n * GRID_PX
}

/**
 * 从库里/本地读回来的布局**先过一遍形状**（`normalizeLayout`）：这份 JSON 可能是
 * 老版本写的、可能被截断、也可能根本不是 JSON —— 布局坏了不能把整块屏拖崩，
 * 形状不对就整个丢掉回默认（§三.4：坏数据不是"没有布局"，是"不知道"，回默认最稳）。
 */
export function normalizeLayout(raw: unknown, validIds: ReadonlySet<string>): ShellLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.snap !== 'grid' && o.snap !== 'free') return null
  if (!Array.isArray(o.windows)) return null
  const windows: LayoutWin[] = []
  for (const w of o.windows) {
    if (!w || typeof w !== 'object') return null
    const r = w as Record<string, unknown>
    const id = r.id
    if (typeof id !== 'string' || !validIds.has(id)) return null
    const mode = r.mode === 'collapsed' || r.mode === 'closed' ? r.mode : 'open'
    const nums = [r.x, r.y, r.w, r.h]
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    windows.push({
      id,
      mode,
      x: r.x as number,
      y: r.y as number,
      w: r.w as number,
      h: r.h as number,
    })
  }
  return { snap: o.snap, windows }
}

/**
 * 默认布局：给一批"要开着的窗口"（id + 建议宽高 px），从左上角开始**先竖着排一列**，
 * 放不下一列就往右挪一列。它只在"这个班还没有布局"时用一次；之后全靠人拖。
 */
export function defaultLayout(
  opens: Array<{ id: string; w: number; h: number }>,
  canvas: CanvasSize,
  snap: SnapMode = 'grid',
): ShellLayout {
  const pad = 16
  let x = pad
  let y = pad
  let colW = 0
  const windows: LayoutWin[] = opens.map(({ id, w, h }) => {
    if (y + h > canvas.h && colW > 0) {
      x += colW + pad
      y = pad
      colW = 0
    }
    const rect = clampRect({ x, y, w, h }, canvas, { w: GRID_PX, h: GRID_PX })
    y = rect.y + rect.h + pad
    colW = Math.max(colW, rect.w)
    return { id, mode: 'open' as const, ...rect }
  })
  return { snap, windows }
}

/** 把一扇窗口挪到最前面之后，整叠窗口的 z 顺序就是数组顺序（后来者居上）。 */
export function bringToFront(ids: string[], id: string): string[] {
  const rest = ids.filter((x) => x !== id)
  rest.push(id)
  return rest
}

/**
 * **默认模板**（2026-10-24 用户拍板：「内置一个默认的模板跟原版的布局一样就行」）。
 *
 * 旧教室屏是一屏两栏（`Classroom.tsx:1918` 的 `gridTemplateColumns: 'minmax(300px, 360px) 1fr'`），
 * 所以模板也按两栏摆：左栏从上到下「大时钟课表」「呼叫播报」，右栏「老师传来的文件」，
 * 右栏剩下的地方留给 P2 之后搬过来的作业/考试/讲评（那些是插件，**这里绝不预设** ——
 * 没装就是没有，见交接文档 §7.1 第 3 条）。
 *
 * 🔴 只在"这个班还没有 `__framework` 布局行"时用一次；老师拖过之后以他存的那份为准。
 * ⚠️ 所有坐标都过 `clampRect`（和拖拽、吸附同一套算术）—— 另写一套坐标就是两个真相。
 */
export function templateLayout(canvas: CanvasSize): ShellLayout {
  const pad = 16
  /* 左栏 4 格（旧屏是 300–360，取整到 96 的倍数，吸附才对得上） */
  const leftW = GRID_PX * 4
  const callsH = GRID_PX * 2
  /* 左栏剩下的高度都给时钟：向下取整到整格，再夹进画布 */
  const clockH = Math.max(GRID_PX * 3, Math.floor((canvas.h - pad * 3 - callsH) / GRID_PX) * GRID_PX)
  const filesW = Math.max(GRID_PX * 3, Math.floor((canvas.w - pad * 3 - leftW) / GRID_PX) * GRID_PX)
  const min = { w: GRID_PX, h: GRID_PX }
  return {
    snap: 'grid',
    windows: [
      { id: '__clock', mode: 'open', ...clampRect({ x: pad, y: pad, w: leftW, h: clockH }, canvas, min) },
      { id: '__calls', mode: 'open', ...clampRect({ x: pad, y: pad + clockH + pad, w: leftW, h: callsH }, canvas, min) },
      { id: '__files', mode: 'open', ...clampRect({ x: pad * 2 + leftW, y: pad, w: filesW, h: GRID_PX * 4 }, canvas, min) },
      /* 备份是状态条性质的块：右栏**底部**——和旧屏"自动备份到本机"那张卡的阅读顺序一致 */
      {
        id: '__backup',
        mode: 'open',
        ...clampRect({ x: pad * 2 + leftW, y: canvas.h - pad - GRID_PX * 2, w: filesW, h: GRID_PX * 2 }, canvas, min),
      },
    ],
  }
}
