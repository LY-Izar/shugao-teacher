import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Emblem } from './Emblem'

/* ============================================================
   开屏 —— 「树高教务通」描边写出来 → 进度条 → 渐变进首页
   ============================================================

   口径（用户 2026-10-01 两次点名）：
     · 上行中文「树高教务通」、下行英文 `SD Education`，校徽在文字上方；
     · 动画**完整播一遍之后**，文字下方才从左向右出现进度条；
     · 加载好了 → 渐变过渡到首页；还没加载好 → 进度条自己模拟着爬；
     · 个人标志（IZAR）只放在这一屏（`public/izar.png`，靠 mask 染色跟着主题走）。

   🔴 为什么不是 SVG 的 `stroke-dasharray` 描边生长（桌面 `动画\6\代码.txt` 那一版）：
      SVG `<text>` **量不到轮廓长度** —— `getTotalLength()` 只在 `<path>` 上，
      `pathLength` 对 `<text>` 不生效；而那一版把 dash 估成 `fontSize * 7`，
      拉丁字母够用，一个汉字几十笔、轮廓长度是字号的十几到几十倍 ⇒ 会断笔、
      或者"动画刚开始就有几笔先显形"。逐字转 `<path>` 要引字体解析（太重）。
      所以这里改成**逐字从左到右擦出**（每个字一个 `clip-path` 擦除框），
      擦完再让填色追上来 —— 不依赖任何长度测量，中英文都稳，
      也就**不需要 gsap**（项目本来没有动画库依赖）。

   ⚠️ 只在**后端模式**（真要去等会话与数据）出现：`shots.mjs` 跑的是本地演示模式
      （`isRemote === false`，`hydrated` 恒为 true），所以它**不会**进那 141 张截图。
      本地想看：`?boot=1`（演示模式没有后端可等，进度条会立刻走满）。
   ============================================================ */

const CN = '树高教务通'
const EN = 'SD Education'

/** 每个字错开多久开始擦（ms） */
const STAGGER = 45
/** 单个字擦出来用多久（ms） */
const WIPE = 420
/** 填色比描边晚多少开始淡入（ms） */
const FILL_GAP = 230
/** 填色淡入用多久（ms） */
const FILL = 380
/** 中文写完 → 英文开头之间歇多久（ms） */
const EN_GAP = 220
/** 渐变退出用多久（ms）—— 必须与 `index.css` 的 `.splash` 过渡时长同一个数 */
const LEAVE = 420

const CN_MS = STAGGER * CN.length + WIPE
const EN_MS = STAGGER * EN.length + WIPE
/** 「动画播完一遍」的时刻：两行都擦完了（最后一笔的填色还在追） */
const ANIM_MS = CN_MS + EN_GAP + EN_MS

/** 还没加载好时，模拟进度条爬到多少就停住（剩下的留给真实的加载结果） */
const SIM_CAP = 88

export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  /* 动效开关：项目硬要求（`index.css` 末尾那条全局兜底也是这个口径）——
     关掉动效的人看到的是**静态终态**，不是"慢慢擦出来"。 */
  const [reduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  const animMs = reduced ? 0 : ANIM_MS
  /** 渐变退出用多久 —— 与内联写进 CSS 的 `--splash-leave` 必须是同一个数 */
  const leaveMs = reduced ? 200 : LEAVE

  /** 动画播完一遍了没有（播完才出进度条） */
  const [showBar, setShowBar] = useState(animMs === 0)
  const [pct, setPct] = useState(0)
  const [leaving, setLeaving] = useState(false)

  /* `onDone` 每次渲染都是新的箭头函数 —— 存进 ref，免得那个定时器 effect
     被父组件的重渲染打断、一遍遍从头计时（否则开屏可能永远退不出去） */
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  })

  /* ① 先让文字写完一遍 —— 用户口径是"待该动画播放完一遍后"才出进度条 */
  useEffect(() => {
    if (animMs === 0) return
    const t = window.setTimeout(() => setShowBar(true), animMs)
    return () => window.clearTimeout(t)
  }, [animMs])

  /* ② 进度条只往前走：没有真实结果就模拟着爬到 `SIM_CAP` 停住 */
  useEffect(() => {
    if (!showBar || ready) return
    const t0 = performance.now()
    let raf = 0
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 1200)
      setPct(Math.round(SIM_CAP * (1 - (1 - k) * (1 - k))))
      if (k < 1) raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [showBar, ready])

  /* ③ 加载好了：补满 → 停一拍 → 渐变退出 → 把屏幕交还给页面
     （补满这一下**不能**在 effect 里同步 setState：先让它按当前值渲染一帧，
       下一帧再推 100%，那一段交给 CSS 的 `transition: width` 去走） */
  useEffect(() => {
    if (!showBar || !ready) return
    const raf = window.requestAnimationFrame(() => setPct(100))
    /* 关动效的人：静态那一屏也留一下（不然只闪一帧等于没有），渐变收短一点 */
    const hold = reduced ? 400 : 520
    const t1 = window.setTimeout(() => setLeaving(true), hold)
    const t2 = window.setTimeout(() => doneRef.current(), hold + leaveMs)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [showBar, ready, reduced, leaveMs])

  const cn = useMemo(() => [...CN], [])
  const en = useMemo(() => [...EN], [])

  const vars = {
    '--splash-wipe': `${WIPE}ms`,
    '--splash-fill': `${FILL}ms`,
    '--splash-fillgap': `${FILL_GAP}ms`,
    '--splash-leave': `${leaveMs}ms`,
  } as CSSProperties

  return (
    <div
      className="splash"
      data-splash
      data-bar={showBar ? '' : undefined}
      data-leaving={leaving ? '' : undefined}
      style={vars}
    >
      <div className="splash__inner">
        <Emblem n={64} className="splash__emblem" />
        <div className="splash__title" data-splash-line="cn">
          {cn.map((ch, i) => (
            <Cell key={i} ch={ch} delay={i * STAGGER} />
          ))}
        </div>
        <div className="splash__sub" data-splash-line="en">
          {en.map((ch, i) => (
            <Cell key={i} ch={ch === ' ' ? '\u00a0' : ch} delay={CN_MS + EN_GAP + i * STAGGER} />
          ))}
        </div>
        {/* 进度条：`data-bar` 没上来之前是透明的，但**占着位置**，文字不会跳一下 */}
        <div className="splash__bar" data-splash-bar>
          <span className="splash__bar-fill" data-splash-bar-fill style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="splash__mark" data-splash-mark aria-hidden="true" />
      {/* 屏上不留百分比之类的内部数字，只给读屏软件一句状态 */}
      <span className="splash__sr" role="status">
        正在打开树高教务通
      </span>
    </div>
  )
}

/** 一个字：底下描边、上面填色；外层那圈的 `clip-path` 就是"从左到右写出来"的擦除框 */
function Cell({ ch, delay }: { ch: string; delay: number }) {
  return (
    <span className="splash-ch" style={{ '--d': `${delay}ms` } as CSSProperties}>
      <span className="splash-ch__stroke" aria-hidden="true">
        {ch}
      </span>
      <span className="splash-ch__fill" aria-hidden="true">
        {ch}
      </span>
    </span>
  )
}
