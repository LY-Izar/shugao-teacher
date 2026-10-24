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
  /**
   * 布局**代数**。换默认模板 = 换代数 ⇒ 旧布局整份丢弃回默认。
   *
   * 🔴 为什么非得有这个：老师机器上存着按旧模板摆的布局（时钟只有 370 高），
   *    而新模板把时钟抬到 480 —— 不换代数的话，老机器永远用旧的、屏幕上永远是"切一半"，
   *    改模板等于没改（2026-10-24 用户第二次截图报的就是这个：我改完模板，他刷新还是切）。
   *    `2` 起：2 = 时钟 ≥5 格、呼叫播报排在其下方、画布可滚。
   */
  v: number
}

export const LAYOUT_VERSION = 3

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
  /* 代数不对 = 旧模板摆的那份 ⇒ 整份丢回默认（理由见 `ShellLayout.v` 的注释） */
  if (o.v !== LAYOUT_VERSION) return null
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
  return { snap: o.snap, windows, v: LAYOUT_VERSION }
}

/**
 * 游标：从 `start` 开始**先竖着排一列**，放不下就往右挪一列。
 * 🔴 `defaultLayout`（新出现的窗口）与 `templateLayout`（默认模板里的插件块）**共用这一份**
 *    —— 另写一套坐标就是两个真相（`templateLayout` 的时钟/呼叫/文件那三扇是手工定的，
 *    它们的位置是模板的"骨架"，不走这里）。
 */
function flowWindows(
  opens: Array<{ id: string; w: number; h: number }>,
  canvas: CanvasSize,
  start: { x: number; y: number; colW: number },
): LayoutWin[] {
  const pad = 16
  let { x, y, colW } = start
  return opens.map(({ id, w, h }) => {
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
  return { snap, windows: flowWindows(opens, canvas, { x: pad, y: pad, colW: 0 }), v: LAYOUT_VERSION }
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
 * 所以模板也按两栏摆：左栏从上到下「大时钟课表」「呼叫播报」，右栏「老师传来的文件」。
 * ⚠️ §7.1 第 3 条原来写的是"插件绝不预设"—— 2026-10-24 用户改口：默认视图要看得见
 *    原固定版的那几个插件 ⇒ 改成由调用方把**当次目录里真实存在、能渲染的**插件传进来
 *    （`extra`），没装/被拒的仍然不会有（判据在调用方，模板只负责摆）。
 *
 * 🔴 只在"这个班还没有 `__framework` 布局行"时用一次；老师拖过之后以他存的那份为准。
 * ⚠️ 所有坐标都过 `clampRect`（和拖拽、吸附同一套算术）—— 另写一套坐标就是两个真相。
 *
 * `extra`（2026-10-24 第三次改口）：默认视图要摆上**原固定版的全部功能块**，所以模板
 * 除了三扇宿主块，还接一列**随包内置的插件**（调用方只传当次目录里能渲染的那些）。
 * 它们从**左栏呼叫播报的正下方**接着往下排，用 `flowWindows` 那份游标（与"新出现的窗口"
 * 同一套"排不下就开新列"的算术）。
 *
 * 🔴 **不升 `LAYOUT_VERSION`**：它管的是"老布局还能不能读"，与模板内容无关。老机器上
 *    已经存过 `__framework` 布局 ⇒ 看不到这份新默认模板，**这是预期**（要新模板就清掉
 *    那个班的布局行）。这里升代数反而会把老师拖好的布局整份丢掉。
 */
export function templateLayout(
  canvas: CanvasSize,
  extra: Array<{ id: string; w: number; h: number }> = [],
): ShellLayout {
  const pad = 16
  /* 左栏 4 格（旧屏是 300–360，取整到 96 的倍数，吸附才对得上） */
  const leftW = GRID_PX * 4
  const callsH = GRID_PX * 2
  /*
   * 🔴 时钟**至少 5 格（480px）**：它里面是"大钟 + 日期 + 这个班的课"三段，
   *    低于 480 就必然要把"今天放假"那张卡切一半（2026-10-24 用户两次截图都是这个）。
   *    画布更矮时不再压缩它 —— 下面的窗口靠画布滚动看见（见 ClassroomPluginShell 的撑高块）。
   */
  const clockH = Math.max(GRID_PX * 5, Math.floor((canvas.h - pad * 3 - callsH) / GRID_PX) * GRID_PX)
  const filesW = Math.max(GRID_PX * 3, Math.floor((canvas.w - pad * 3 - leftW) / GRID_PX) * GRID_PX)
  const min = { w: GRID_PX, h: GRID_PX }
  const filesH = GRID_PX * 4
  const windows: LayoutWin[] = [
    { id: '__clock', mode: 'open', ...clampRect({ x: pad, y: pad, w: leftW, h: clockH }, canvas, min) },
    /* 呼叫播报排在时钟**正下方**（旧屏左栏的阅读顺序）。它可能落到画布可视区之外 ——
       那是有意的：宁可让老师滚一下，也不要把时钟压到装不下内容。 */
    { id: '__calls', mode: 'open', x: pad, y: pad + clockH + pad, w: leftW, h: callsH },
    { id: '__files', mode: 'open', ...clampRect({ x: pad * 2 + leftW, y: pad, w: filesW, h: filesH }, canvas, min) },
    /* 🔴 自动备份不再占一格（2026-10-24 用户拍板：壳侧底层能力，不写出来）。
       以前这里有一扇 `__backup` 窗口 —— 删掉之后老布局会被 `normalizeLayout` 判成坏布局
       （`validIds` 里没有它），自动回默认模板，正是想要的结果。 */
  ]
  if (extra.length) {
    /*
     * 插件的落点 = 左栏（时钟 + 呼叫）**下面**接着排。
     * ⚠️ 这里把"可用高度"按这批内容的总高撑开：画布本来就能滚（撑高块），而按可视高度算的话
     *    第一块就必然"排不下"⇒ 当场开一列到右边界外（1280 屏上只露几十像素）或压住文件块
     *    —— 用户看到仍会是"只有三块"。撑开之后它们在同一列里依次往下，滚一下就能看全。
     */
    const top = pad + clockH + pad + callsH + pad
    const contentH = extra.reduce((sum, e) => sum + e.h + pad, top)
    windows.push(
      ...flowWindows(extra, { w: canvas.w, h: Math.max(canvas.h, contentH) }, { x: pad, y: top, colW: leftW }),
    )
  }
  return { snap: 'grid', v: LAYOUT_VERSION, windows }
}
