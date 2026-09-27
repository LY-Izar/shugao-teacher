import type { ComponentPropsWithoutRef, CSSProperties, ElementType, ReactNode } from 'react'

/* ============================================================
   星光（ReactBits `StarBorder` 的移植版）—— **只暗色、只两处**
   ============================================================

   口径出自本轮上游产出 `桌面\主应用微交互\说明.md` §1，落地时**照用户拍板的那三条**：

   ① 🔴 **几何用「细高光」，不是原版字面** —— 这是用户明确拍的板，不是我改的。
      原版（`新建文件夹\5\CSS.txt`）是 `height:50%` + `bottom:-12px`：光片整片落在按钮
      **外沿之下**，只有圆角的弧形边缘探进 padding 带。原版自己的 demo 按钮 54px 高、
      padding 16px，所以它好看；平台按钮 42px、padding 更小。实测（`_work\star-final.txt`，
      同一只 220×49 按钮、1:1、底透明、12 个相位冻结后逐像素量）：

        | 口径 | 12 相位可见像素%（min / mean / max） | 底沿 3px 最亮 |
        |---|---|---|
        | 原版字面（h50% / bottom:-12px / 位移 100%） | **0.0 / 5.0 / 12.8**（12 相位里 6 个 = 0） | 亮度 62.5 |
        | **细高光（本文件）** | **7.0 / 13.0 / 14.1**（12 相位全 ≥7%） | **亮度 77.5** |

      → 原版字面在平台尺寸下"一半时间是黑的"。
      🔴 **不能为了一个装饰去改按钮尺寸**（会动整个界面的密度）→ 所以改几何。
      几何只有三点与原版不同：`height:50%` 保留、`border-radius:999px`（原版 50%，同效）、
      `bottom/top:-7px`（原版 ∓12px）、行程 `−33.33% → −66.67%`（原版 0 → −100%）。
      底沿那 3px 就是 padding 带，光就压在 `--color-canvas` 上 —— **不是压在实心 accent 底上**，
      同色压同色会看不见（这条原版结构保住了，别改成 `box-shadow`）。

   ② **不透明度用原版的 `0.7`**：原版 CSS 写死 `opacity: 0.7`，而它那两条 keyframes
      又写了 `opacity: 1 → 0` —— **动画里的 opacity 会盖掉元素上那条静态声明**，所以原版的
      参数其实从来没生效过。这里把 `0.7` 写进 keyframe 本身（真的生效），
      ⚠️ **不再留 `--sb-op` 那种"调了没反应"的旋钮**（前两轮踩过：调 .4 / .95 实测都是同一个值）。

   ③ **发光色 = `var(--color-accent)`**：星光跟强调色走（暗蓝 / 暗紫自动换），**不写死白色**。

   门控：**只暗色**（亮色 `display:none`）+ **reduced-motion `display:none`**。
   ⚠️ reduced-motion 不能用全局兜底：`index.css` 那条 `animation-duration:.001ms !important`
   会把循环扫光**冻成一颗卡在边上的光斑**，那比没有更糟（星光的全部意义就是运动）。
   ============================================================ */

type StarBorderProps<T extends ElementType> = {
  as?: T
  className?: string
  children?: ReactNode
  /** 光片行程速度（默认 `6s`，原版默认值） */
  speed?: CSSProperties['animationDuration']
  style?: CSSProperties
}

export function StarBorder<T extends ElementType = 'div'>({
  as,
  className = '',
  children,
  speed = '6s',
  style,
  ...rest
}: StarBorderProps<T> & Omit<ComponentPropsWithoutRef<T>, 'className' | 'children' | 'style'>) {
  const Component = (as || 'div') as ElementType
  return (
    <Component className={`sb${className ? ` ${className}` : ''}`} style={style} {...(rest as object)}>
      <span className="sb-glow sb-glow-b" style={{ animationDuration: speed }} aria-hidden="true" />
      <span className="sb-glow sb-glow-t" style={{ animationDuration: speed }} aria-hidden="true" />
      <span className="sb-body">{children}</span>
    </Component>
  )
}

export default StarBorder
