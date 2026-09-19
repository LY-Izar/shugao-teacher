import type { SVGProps } from 'react'

/* ============================================================
   自绘线条图标集
   规范：24×24 网格 · 1.6 描边 · 圆头圆角 · 无填充 · currentColor
   全部手工绘制，几何统一，不使用任何图标库
   ============================================================ */

export type IconProps = {
  size?: number
  strokeWidth?: number
} & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>

function Svg({ size = 22, strokeWidth = 1.6, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ---------- 品牌标：坐标轴 + 上升折线 + 节点（物理与进度的双关） ---------- */
export const Logo = ({ size = 24, ...p }: IconProps) => (
  <Svg size={size} strokeWidth={1.7} {...p}>
    <path d="M3.8 3.6v16.8h16.8" />
    <path d="m7.4 15.8 3.5-4.3 2.7 2.4 3.7-5.2" />
    <circle cx="17.3" cy="8.7" r="1.35" />
  </Svg>
)

/* ---------- 导航 ---------- */
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 18.6a9 9 0 1 1 17 0" />
    <path d="m12 18.6 4.1-5.7" />
    <circle cx="12" cy="18.6" r="1.15" />
    <path d="M5.9 15.4l1.3.75M12 6.1v1.5M18.1 15.4l-1.3.75" />
  </Svg>
)

export const IconClipboard = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.1 3.9h5.8v2.3H9.1z" />
    <path d="M9.1 5H7.3A1.7 1.7 0 0 0 5.6 6.7v12.6A1.7 1.7 0 0 0 7.3 21h9.4a1.7 1.7 0 0 0 1.7-1.7V6.7A1.7 1.7 0 0 0 16.7 5h-1.8" />
    <path d="m9.4 13.3 1.85 1.85L14.9 11.3" />
  </Svg>
)

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8.8" cy="8.4" r="3.05" />
    <path d="M3.4 19.7c0-3 2.42-5.4 5.4-5.4s5.4 2.4 5.4 5.4" />
    <path d="M15.7 5.7a3.05 3.05 0 0 1 0 5.4" />
    <path d="M17.3 14.6c1.85.72 3.1 2.5 3.1 4.55" />
  </Svg>
)

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.1" r="3.4" />
    <path d="M5.4 20.4c0-3.6 2.95-6.2 6.6-6.2s6.6 2.6 6.6 6.2" />
  </Svg>
)

/* ---------- 核心动作 ---------- */
export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.3 8.7A1.85 1.85 0 0 1 5.15 6.85h2.05l1.2-2h7.2l1.2 2h2.05a1.85 1.85 0 0 1 1.85 1.85v8.5a1.85 1.85 0 0 1-1.85 1.85H5.15a1.85 1.85 0 0 1-1.85-1.85z" />
    <circle cx="12" cy="12.9" r="3.35" />
  </Svg>
)

export const IconScan = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 8.6V5.7a2.1 2.1 0 0 1 2.1-2.1h2.9" />
    <path d="M15.4 3.6h2.9a2.1 2.1 0 0 1 2.1 2.1v2.9" />
    <path d="M20.4 15.4v2.9a2.1 2.1 0 0 1-2.1 2.1h-2.9" />
    <path d="M8.6 20.4H5.7a2.1 2.1 0 0 1-2.1-2.1v-2.9" />
    <path d="M3.6 12h16.8" />
  </Svg>
)

export const IconPaste = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.1 3.9h5.8v2.3H9.1z" />
    <path d="M9.1 5H7.3A1.7 1.7 0 0 0 5.6 6.7v12.6A1.7 1.7 0 0 0 7.3 21h9.4a1.7 1.7 0 0 0 1.7-1.7V6.7A1.7 1.7 0 0 0 16.7 5h-1.8" />
    <path d="M8.9 11.6h6.2M8.9 14.8h6.2M8.9 18h3.4" />
  </Svg>
)

export const IconStack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.4 3.8 7.6 12 11.8l8.2-4.2z" />
    <path d="m3.8 12 8.2 4.2 8.2-4.2" />
    <path d="m3.8 16.4 8.2 4.2 8.2-4.2" />
  </Svg>
)

export const IconMegaphone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.2 10.3v3.4a1.6 1.6 0 0 0 1.6 1.6h1.9l6.5 3.6a.85.85 0 0 0 1.28-.74V5.84a.85.85 0 0 0-1.28-.74L7.7 8.7H5.8a1.6 1.6 0 0 0-1.6 1.6z" />
    <path d="M18.3 9.3a3.9 3.9 0 0 1 0 5.4" />
    <path d="M20.5 6.9a7.3 7.3 0 0 1 0 10.2" />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.7 3.3 3.4 10.2l6.5 2.9 2.9 6.5z" />
    <path d="m9.9 13.1 5.3-5.3" />
  </Svg>
)

export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.8 20.3h16.4" />
    <path d="M7.3 20V11.5M12 20V4.7M16.7 20v-5.7" />
  </Svg>
)

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.4" height="6.4" rx="1" />
    <rect x="13.6" y="4" width="6.4" height="6.4" rx="1" />
    <rect x="4" y="13.6" width="6.4" height="6.4" rx="1" />
    <rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1" />
  </Svg>
)

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <circle cx="12" cy="12" r="3.4" />
  </Svg>
)

export const IconZap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.3 2.8 4.6 13.5h6.2l-.9 7.7 8.7-10.7h-6.2z" />
  </Svg>
)

export const IconHash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.9 9.2h14.2M4.9 14.8h14.2M10.3 4.2 8.7 19.8M15.5 4.2l-1.6 15.6" />
  </Svg>
)

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.8" y="5.4" width="16.4" height="15" rx="1.8" />
    <path d="M3.8 10.1h16.4M8.4 3.4v3.9M15.6 3.4v3.9" />
  </Svg>
)

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3.1 1.9" />
  </Svg>
)

export const IconWifi = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.3 9.5a11.2 11.2 0 0 1 15.4 0" />
    <path d="M7.3 12.9a6.8 6.8 0 0 1 9.4 0" />
    <path d="M10.3 16.2a2.5 2.5 0 0 1 3.4 0" />
    <circle cx="12" cy="19.4" r=".95" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 12S6.5 5.7 12 5.7 21.4 12 21.4 12 17.5 18.3 12 18.3 2.6 12 2.6 12z" />
    <circle cx="12" cy="12" r="2.85" />
  </Svg>
)

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 6.1A9.6 9.6 0 0 1 12 5.7c5.5 0 9.4 6.3 9.4 6.3a17 17 0 0 1-3.2 3.9" />
    <path d="M6.4 7.6A17.4 17.4 0 0 0 2.6 12s3.9 6.3 9.4 6.3a9.5 9.5 0 0 0 3.9-.8" />
    <path d="M9.8 9.8a2.85 2.85 0 0 0 4 4" />
    <path d="m4 4 16 16" />
  </Svg>
)

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.8 8.3h8.6M17.6 8.3h2.6" />
    <circle cx="15.1" cy="8.3" r="2.2" />
    <path d="M3.8 15.7h4.4M13.2 15.7h7" />
    <circle cx="10.7" cy="15.7" r="2.2" />
  </Svg>
)

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 4.5H6.2a1.8 1.8 0 0 0-1.8 1.8v11.4a1.8 1.8 0 0 0 1.8 1.8h3.4" />
    <path d="m15 8.2 3.8 3.8L15 15.8M9.4 12h9.2" />
  </Svg>
)

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16.4V4.7M7.7 9 12 4.7 16.3 9" />
    <path d="M4.5 15.2v3.5a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-3.5" />
  </Svg>
)

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.7v11.7M7.7 12.1 12 16.4l4.3-4.3" />
    <path d="M4.5 15.2v3.5a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-3.5" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.2 12a8.2 8.2 0 1 1-2.65-6.03" />
    <path d="M20.3 4.6v4.7h-4.7" />
  </Svg>
)

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16.75 4.35a2.06 2.06 0 0 1 2.9 2.9L8.6 18.3l-4.2 1.4 1.4-4.2z" />
    <path d="m14.9 6.2 2.9 2.9" />
  </Svg>
)

export const IconSwap = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.4 9.5h11.3l-2.6-2.6" />
    <path d="M19.6 14.5H8.3l2.6 2.6" />
  </Svg>
)

export const IconBan = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="m6.2 6.2 11.6 11.6" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 7.2h14.8" />
    <path d="M9.4 7.2V5.4a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8" />
    <path d="m6.4 7.2.9 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.9-12" />
    <path d="M10.3 11.2v6M13.7 11.2v6" />
  </Svg>
)

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.1 16.4V10.7a5.9 5.9 0 0 1 11.8 0v5.7l1.1 1.9a.55.55 0 0 1-.47.83H5.47a.55.55 0 0 1-.47-.83z" />
    <path d="M10.2 19.4a2 2 0 0 0 3.6 0" />
  </Svg>
)

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.1" />
    <path d="M12 2.8v2.2M12 19v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.8 12H5M19 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
  </Svg>
)

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8z" />
  </Svg>
)

export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.2 13.9 9.4 20.1 11.3 13.9 13.2 12 19.4 10.1 13.2 3.9 11.3 10.1 9.4z" />
  </Svg>
)

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4.1 2.9 19.9h18.2z" />
    <path d="M12 9.6v4.4" />
    <circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 11.2v5" />
    <circle cx="12" cy="8.2" r=".95" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.5 15.5 4.6 4.6" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.9 12.6 4.9 4.9L19.1 6.6" />
  </Svg>
)

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.3 6.3 17.7 17.7M17.7 6.3 6.3 17.7" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Svg>
)

export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.2 12h13.6" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.6 6.4 5.6 5.6-5.6 5.6" />
  </Svg>
)

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.4 6.4-5.6 5.6 5.6 5.6" />
  </Svg>
)

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.8 12H4.2M10.6 5.6 4.2 12l6.4 6.4" />
  </Svg>
)

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.6 6.6h11.2M8.6 12h11.2M8.6 17.4h11.2" />
    <path d="M4.7 6.6h.01M4.7 12h.01M4.7 17.4h.01" strokeWidth={2.1} />
  </Svg>
)

/* 图中标记（用于画册/校名等场景） */
export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.6" y="4.6" width="16.8" height="14.8" rx="1.8" />
    <circle cx="9" cy="9.6" r="1.5" />
    <path d="m4.4 17 4.3-4.1 3.4 3.2 3.1-2.9 4.4 4" />
  </Svg>
)
