import type { CSSProperties, HTMLAttributes } from 'react'

/* ============================================================
   校徽（成都市树德实验高级中学）—— **位图**，不是矢量
   ============================================================

   口径出自 `徽标方案\落地清单.md`（第 5 版），落地时一个字没改：

   ① **一律全徽**（不裁掉校名环）：用户明确要过「都用全徽，别用纯徽」。
      ⚠️ 全徽有阈值：**≥48px 才"值得看"**（外圈那道 15px 粗的圆线在 48px 下角向最弱
         才第一次 ≥0.45 → 每一个角度都还连着）；**32px 是"还认得出是枚校徽"的下限**；
         **＜32px 不要用全徽**（20px 那一档是"圆形浅块 + 中间一坨深紫"，不是校徽）。
         所以这里只接受 32 / 40 / 48 / 64 四档 —— 传别的数会在 2x 屏上取到不存在的图。
   ② **盒子 = 徽 / 0.87**（比徽本身大 13%）：这 13% 现在**就是**徽墨与相邻文字之间那点距离
      （32px 档单侧 2.39px、40px 档 2.99px、48px 档 3.59px）。
      🔴 删掉它 → 徽自己不动、**相邻文字整体朝徽挪 2.4~3.6px**（§12.3 实测表）。
      ⚠️ 落位必须是 `inline-grid + place-items: center`，且**不许用 `transform: scale()` 裁图**
         （`overflow: hidden` 压不住 `display: inline-block`，本轮为此踩过两次，见 §〇）。
   ③ **提亮只在暗色**（`--emblem-boost`，见 `index.css` 那一段）——
      亮色下原色紫压白 7.7:1，本来就不需要动；暗色下不提亮只有 1.77~1.94:1，等于看不见。
   ④ 🔴 **外围不加框线、下不加盘**：亮色 `--plate: none`（白盘在白卡上等于隐身），
      暗色也没有盘。📌 别用 `border` / `box-shadow: inset` 给"盘"描边 —— 那 4 处删过一遍了。
   ⑤ **1x / 2x 两档真位图**（`srcSet`）：48px 的图在 2x 屏上要 96 个设备像素，
      让浏览器放大 48px 的位图才是真的糊（一眼看得出违反"保持清晰"）。

   ⚠️ 每一档位图都在 `public/emblem/`（`emblem-40.png` / `emblem-80.png` …），
      由仓库外的 `徽标方案\生成PWA图标.py` 从 720×720 源图 Lanczos 生成。
   ⚠️ **favicon 那一档（16px）用的是"纯徽"**，不在这个组件里 —— 理由见 `落地清单.md` §11.1。
   ============================================================ */

/** 徽本体的像素尺寸（只开放全徽成立的那几档 + 24px 那一档纯徽） */
export type EmblemSize = 24 | 32 | 40 | 48 | 64

/** 盒子的留白比例：盒 = 徽 / 0.87（§12.3；盘没了之后它就是"徽到文字"的间距） */
const PAD_RATIO = 0.87

export function Emblem({
  n,
  pure = false,
  style,
  className,
  ...rest
}: {
  n: EmblemSize
  /**
   * 🔴 **纯徽**（`public/emblem/emblem-pure-24.png`，只 24px 这一档）。
   *
   * 用在"全徽装不下"的位置（`落地清单.md` §9.1 实测）：24px 全徽的外圈线只有 **0.50px**，
   * "刚够半个像素"、圆半实半虚 → 认不出是枚校徽；纯徽丢了校名环，但轮廓立得住。
   * ⚠️ 它**不再是一枚"校徽"**（丢了校名环那层信息），只该出现在"反正读不清"的小位。
   */
  pure?: boolean
  style?: CSSProperties
  className?: string
} & Omit<HTMLAttributes<HTMLSpanElement>, 'style' | 'className' | 'children'>) {
  const box = n / PAD_RATIO
  const prefix = pure ? 'emblem-pure' : 'emblem'
  const src = `/emblem/${prefix}-${n}.png`
  return (
    <span
      data-emblem={n}
      data-emblem-pure={pure ? '' : undefined}
      className={className}
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
        width: box,
        height: box,
        /* 暗色 ×1.7 / 亮色 none（`index.css` 的 `--emblem-boost`）；滤镜管不到图标文件，
           所以 favicon / PWA 图标走的是"白盘 + 原色"那一条路（静态图，四套主题共用）。 */
        filter: 'var(--emblem-boost)',
        ...style,
      }}
      {...rest}
    >
      <img
        src={src}
        /* 纯徽只生成了 1x 那一张 —— 别写 2x 的 `srcSet`，否则浏览器会去取一个不存在的
           `emblem-pure-48.png`（2x 屏上真会请求）。 */
        srcSet={pure ? undefined : `${src} 1x, /emblem/${prefix}-${n * 2}.png 2x`}
        width={n}
        height={n}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: n, height: n, display: 'block' }}
      />
    </span>
  )
}
