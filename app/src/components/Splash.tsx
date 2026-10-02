/**
 * 开屏：校徽 + 英文描边字（沿字形轮廓画出来）+ 一行小字「加载中…」。
 *
 * 2026-10-13：用户说中文那行（志莽行书「树高教务通」）"太土"，进度条也"不好看" ⇒
 * **中文整行删掉、进度条换成一行很小的「加载中…」**；校徽与英文 Playfair 那行动画留着。
 * 志莽行书的 `@font-face` 与字体文件同时清掉（不再有任何地方用它）。
 *
 * 效果照用户给的素材 `C:\Users\Administrator\Desktop\动画\6\` 做
 * （`StrokeText.tsx` + `StrokeText.css` + `配置.txt`），参数逐项照抄：
 *   fontSize 128 · fontWeight 850 · letterSpacing -3 · strokeWidth 1.2
 *   drawDuration 1.6 · fillDelay 0.3 · stagger 0.05 · fillMode 'fade'
 *   描边缓动 sine.inOut · 填色缓动 power2.out（填色时长 = drawDuration * 0.5）
 * 2026-10-05 用户定稿了两处差别：中文换「志莽行书」、英文换 Playfair Display（都是自托管
 * 子集，见 `index.css` 的 `@font-face`），笔重随之变成 400 / 900；描边 1.2 → 1.8
 * （行书笔画细，1.2 那道勾线看不出来）。
 * 机制也照抄：**两层同位置的 `<text>`** —— 下层 `fill: none` 只有描边，
 * `stroke-dasharray` 配 `stroke-dashoffset` 从 `dash` 爬到 0，沿**字形轮廓**画出来；
 * 上层是填色，等 `drawDuration + fillDelay` 之后整层淡入。
 *
 * 三处按本项目的规矩落地（效果本身不变）：
 *  1. **不引 gsap**，用浏览器原生的 WAAPI 复刻同样的时长 / 延迟 / 逐字 stagger。
 *     缓动等价：gsap `sine.inOut` = `cubic-bezier(.37,0,.63,1)`；
 *     gsap `power2.out`（= cubic out）= `cubic-bezier(.33,1,.68,1)`。
 *     浏览器没有 `Element.animate` 时直接给终态（和 reduce 那条路一样）。
 *  2. **dash 不是定值**。原配置 `Math.max(fontSize * 7, 200)` 是按拉丁字母调的：
 *     128px 时是 896，而一个汉字（比如「树」）的轮廓有两三千像素 —— 用 896 的话，
 *     动画跑完也只画得出前 896 像素，字会缺一截。所以逐字用 canvas 量一下轮廓长度，
 *     dash 取 `max(原配置那个数, 量出来的长度 × 1.15)`：拉丁字母量出来比 896 小，
 *     用的还是原配置那个数，行为逐像素相同。
 *  3. **字体子集自托管**。CSP 是 `font-src 'self'`，在线 CDN 压根加载不了；两个字体文件是
 *     Google Fonts 按 `text=` 现生成的**子集**（2–3 KB，只含开屏用的那十几个字形），
 *     授权文本跟字体放在同一目录。也正因为要等 webfont：轮廓长度与外框都必须在
 *     `document.fonts.ready` 之后再量 —— 拿系统字量出来的 dash 会把行书画缺一截。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { Emblem } from './Emblem'

/* ---------------- 配置（照抄 `配置.txt`） ---------------- */
const EN_TEXT = 'SD Education'
const EN_SIZE = 52
/**
 * 字体＝英文 Playfair Display（自托管子集）。
 * `spec` 是族名本身 —— `document.fonts.load()` 与 canvas 量轮廓都要用它；
 * 真正的回落链写在 CSS（`.splash__sub`）。
 */
const EN_FONT_SPEC = 'Playfair Display'
const EN_WEIGHT = 900
const LETTER_SPACING = -3
/** 2026-10-05 定稿：行书笔画细，原配置的 1.2 勾线几乎看不见 ⇒ 1.8 */
const STROKE_WIDTH = 1.8
const DRAW_S = 1.6
const FILL_DELAY_S = 0.3
/** 源码：`fillDuration = Math.max(0.4, drawDuration * 0.5)` */
const FILL_S = Math.max(0.4, DRAW_S * 0.5)
const STAGGER_S = 0.05
/** 缓动等价关系见文件头 */
const EASE_DRAW = 'cubic-bezier(.37, 0, .63, 1)'
const EASE_FILL = 'cubic-bezier(.33, 1, .68, 1)'

/** 整个动画（含最后一字的填色）跑完需要多久 —— 小字「加载中…」在这个点之后才出现 */
const ANIM_MS = Math.round(
  (DRAW_S + FILL_DELAY_S + FILL_S + STAGGER_S * Math.max(0, EN_TEXT.length - 1)) * 1000,
)
const LEAVE_MS = 420

type Box = { x: number; y: number; width: number; height: number }

/**
 * 量一个字形轮廓有多长（像素）：把字填进 canvas，再数边界像素 —— 汉字一笔有两侧、
 * 各算一次，累加起来就约等于轮廓总长（斜笔画会略微高估，这里宁大不小）。
 * 拿不到（没 canvas / 读不出像素）就返回 0，调用处会退回原配置那个 dash。
 */
function contourLength(char: string, fontSize: number, fontWeight: number, family: string) {
  try {
    const pad = Math.ceil(fontSize * 0.25)
    const side = Math.ceil(fontSize * 1.5)
    const canvas = document.createElement('canvas')
    canvas.width = side + pad * 2
    canvas.height = side + pad * 2
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 0
    ctx.font = `${fontWeight} ${fontSize}px ${family}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#000'
    ctx.fillText(char, pad, side)
    const { width, height } = canvas
    const pixels = ctx.getImageData(0, 0, width, height).data
    const on = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < width && y < height && pixels[(y * width + x) * 4 + 3] > 127
    let outline = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!on(x, y)) continue
        if (on(x - 1, y) && on(x + 1, y) && on(x, y - 1) && on(x, y + 1)) continue
        outline += 1
      }
    }
    return outline
  } catch {
    return 0
  }
}

type StrokeTextProps = {
  text: string
  fontSize: number
  /** 自托管字体的族名（`document.fonts.load` 与 canvas 量轮廓都用它） */
  fontSpec: string
  weight: number
  className?: string
}

function StrokeText({ text, fontSize, fontSpec, weight, className = '' }: StrokeTextProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<SVGTextElement | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  /** 字体到位了才开始画：轮廓长度按字形量，系统字量出来的 dash 会画不全 */
  const [fontReady, setFontReady] = useState(
    () => typeof document === 'undefined' || !document.fonts,
  )
  const chars = useMemo(() => Array.from(text), [text])

  /* 量字的外框（照抄源码的 useLayoutEffect：量一次 + 字体加载完再量一次） */
  useLayoutEffect(() => {
    const node = textRef.current
    if (!node) return
    let cancelled = false
    const measure = () => {
      if (cancelled || !textRef.current) return
      let bbox: DOMRect
      try {
        bbox = textRef.current.getBBox()
      } catch {
        return
      }
      if (!bbox || !bbox.width) return
      const pad = Math.max(STROKE_WIDTH, fontSize * 0.1)
      const next: Box = {
        x: bbox.x - pad,
        y: bbox.y - pad,
        width: bbox.width + pad * 2,
        height: bbox.height + pad * 2,
      }
      setBox((prev) =>
        prev &&
        Math.abs(prev.x - next.x) < 0.5 &&
        Math.abs(prev.y - next.y) < 0.5 &&
        Math.abs(prev.width - next.width) < 0.5
          ? prev
          : next,
      )
    }
    measure()
    const fonts = document.fonts
    if (!fonts) return
    /* 自托管字体是首帧才发请求：先显式催一次，再用 ready 兜住 ——
       加载完重量一次（viewBox 才是真字体的外框），同时放行下面那段起动画的。 */
    fonts.load(`${weight} ${fontSize}px "${fontSpec}"`, text).catch(() => {})
    fonts.ready
      .then(() => {
        measure()
        if (!cancelled) setFontReady(true)
      })
      .catch(() => {
        if (!cancelled) setFontReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [chars, fontSize, fontSpec, text, weight])

  /* 起动画。放在 layout 阶段：先把每个字设成"还没画"再交给 WAAPI，
     否则首帧会先闪一下整行实心字。 */
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const strokes = Array.from(root.querySelectorAll<SVGElement>('[data-stroke-char]'))
    const fills = Array.from(root.querySelectorAll<SVGElement>('[data-fill-char]'))
    if (!strokes.length) return

    const family = textRef.current ? getComputedStyle(textRef.current).fontFamily : 'sans-serif'
    /* 原配置里的 dash —— 拉丁字母用它就够 */
    const base = Math.max(fontSize * 7, 200)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const canAnimate =
      !reduced && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
    const anims: Animation[] = []

    /* 一确认字号就先把每个字按"还没画"藏住（填充也藏）：字体没到位之前也不许闪出实心字。
       这里 dash 先用原配置那个数，等字体到了下面再按真字形重量一遍。 */
    for (const el of strokes) {
      el.style.strokeDasharray = String(base)
      el.style.strokeDashoffset = String(base)
    }
    for (const el of fills) el.style.opacity = '0'

    const finish = () => {
      for (const el of strokes) el.style.strokeDashoffset = '0'
      for (const el of fills) el.style.opacity = '1'
    }

    /* 字体没就绪就先不画 —— 见文件头第 3 条 */
    if (!fontReady) return

    strokes.forEach((el, index) => {
      const dash = Math.max(base, contourLength(chars[index] ?? '', fontSize, weight, family) * 1.15)
      el.style.strokeDasharray = String(dash)
      el.style.strokeDashoffset = String(dash)
      if (!canAnimate) return
      anims.push(
        el.animate([{ strokeDashoffset: `${dash}` }, { strokeDashoffset: '0' }], {
          duration: DRAW_S * 1000,
          delay: index * STAGGER_S * 1000,
          easing: EASE_DRAW,
          fill: 'both',
        }),
      )
    })

    fills.forEach((el, index) => {
      el.style.opacity = '0'
      if (!canAnimate) return
      anims.push(
        el.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: FILL_S * 1000,
          delay: (DRAW_S + FILL_DELAY_S) * 1000 + index * STAGGER_S * 1000,
          easing: EASE_FILL,
          fill: 'both',
        }),
      )
    })

    if (!canAnimate) finish()
    /* 兜底：不管动画跑没跑成，到点就是终态 —— 宁可"啪"地出现，也不能一直看不见 */
    const safety = window.setTimeout(finish, ANIM_MS + 400)

    return () => {
      window.clearTimeout(safety)
      for (const anim of anims) anim.cancel()
    }
  }, [chars, fontSize, fontReady, weight])

  const viewBox = box
    ? `${box.x} ${box.y} ${box.width} ${box.height}`
    : `0 ${-fontSize} 600 ${fontSize * 1.3}`
  const fontStyle: CSSProperties = {
    fontSize: `${fontSize}px`,
    fontWeight: weight,
    letterSpacing: `${LETTER_SPACING}px`,
  }

  return (
    <span ref={rootRef} className={`stroke-text ${className}`.trim()} role="img" aria-label={text}>
      <svg
        className="stroke-text__svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <text
          ref={textRef}
          className="stroke-text__stroke"
          x="0"
          y="0"
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinejoin="round"
          strokeLinecap="round"
          xmlSpace="preserve"
          style={fontStyle}
        >
          {chars.map((char, index) => (
            <tspan data-stroke-char key={`s-${index}`}>
              {char}
            </tspan>
          ))}
        </text>

        <text
          className="stroke-text__fill"
          x="0"
          y="0"
          stroke="none"
          xmlSpace="preserve"
          style={fontStyle}
        >
          {chars.map((char, index) => (
            <tspan data-fill-char key={`f-${index}`}>
              {char}
            </tspan>
          ))}
        </text>
      </svg>
    </span>
  )
}

/**
 * 教师端冷启动的开屏：动画播完一遍 → 小字「加载中…」出现 → 就绪就渐隐到已经渲染好的真页面。
 * 只在后端模式出现（本地演示模式要 `?boot=1`，见 `App.tsx` 的 `bootSplash()`）。
 */
export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [reduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
  )
  const [showLoading, setShowLoading] = useState(reduced)
  const [leaving, setLeaving] = useState(false)

  /* `onDone` 每次渲染都是新的箭头函数 —— 存进 ref，免得那个定时器 effect
     被父组件的重渲染打断、一遍遍从头计时（否则开屏可能永远退不出去）。 */
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })

  const animMs = reduced ? 0 : ANIM_MS
  const leaveMs = reduced ? 200 : LEAVE_MS

  /* ① 动画播完一遍，「加载中…」才出现 */
  useEffect(() => {
    const timer = window.setTimeout(() => setShowLoading(true), animMs)
    return () => window.clearTimeout(timer)
  }, [animMs])

  /* ② 真就绪：停一下 → 渐隐 → 交班 */
  useEffect(() => {
    if (!showLoading || !ready) return
    const hold = reduced ? 400 : 300
    const leavingTimer = window.setTimeout(() => setLeaving(true), hold)
    const doneTimer = window.setTimeout(() => doneRef.current(), hold + leaveMs)
    return () => {
      window.clearTimeout(leavingTimer)
      window.clearTimeout(doneTimer)
    }
  }, [showLoading, ready, reduced, leaveMs])

  return (
    <div
      className="splash"
      data-splash=""
      data-leaving={leaving ? '' : undefined}
      style={{ '--splash-leave': `${leaveMs}ms` } as CSSProperties}
    >
      <div className="splash__inner">
        <Emblem n={150} className="splash__emblem" />
        <div className="splash__sub">
          <StrokeText text={EN_TEXT} fontSize={EN_SIZE} fontSpec={EN_FONT_SPEC} weight={EN_WEIGHT} />
        </div>
        {showLoading && (
          <div className="splash__loading" data-splash-loading="">
            加载中
          </div>
        )}
      </div>
      <span className="splash__mark" data-splash-mark="" aria-hidden="true" />
      <span className="splash__sr" role="status">
        正在打开树高教务通
      </span>
    </div>
  )
}
