/**
 * 教室端新本体骨架（P0b · 插件化改版）
 * ============================================================================
 * 它是什么：`/classroom` 的**第二块本体**（"万物皆可插件"那一个）。旧 `Classroom`
 * **一行没动**也照旧是默认 —— 两块本体由 App.tsx 的壳切换二选一，进入方式：
 *
 *     /classroom?newShell=1     ← 走一次就**记住**（localStorage），之后一直进新壳
 *     /classroom?newShell=0     ← 回旧壳（也记住）
 *     /classroom?newShell=1&demoPlugin=1   ← 再带上宿主自带的演示插件
 *
 * 🔴 为什么必须有"记住"这一档：教室端 exe 是全屏 kiosk，没人能敲参数 ——
 *    只认参数的话，P0b 在真机上永远进不去（施工交接 §5.2）。
 *
 * 范围（交接文档 §五 "功能分家清单"，**只搬清单里的**）：
 *   · 基建：登录链（在 App.tsx 的 Gate 上）、心跳/离线、数据同步、维护画面豁免、
 *     声音解锁、亮屏恒亮（#F4 硬规矩，shots 的那组断言同样盯着这一屏）；
 *   · 内置功能块两件：大时钟课表（清单 5）+ 呼叫播报（清单 10）—— 从旧
 *     `Classroom.tsx` **搬代码不改行为**；展示层之外只删了"分家给插件的"那几块
 *     （祝福语 6 / 作业值日 7 / 考试板 8 / 讲评 9 / 文件 11 / 课表录入 12 / 备份 13）；
 *   · 窗口管理器（`classroom/winman.ts` 的纯逻辑）+ 插件加载器（`classroom/loader.ts`，
 *     判据全部来自 `lib/pluginHost.ts`，这里只接线）；
 *   · 布局按班记忆：`plugin_data` 的 `__framework` / `layout`（演示模式落 localStorage）。
 *
 * ⚠️ 真悬浮窗（透明窗 / 推屏 / 下载插件）要壳侧作业（`classroomShell.ts` 顶部那四条
 *    约定）；网页预览下这些按钮一律置灰并说"要教室版程序"——降级不撒谎（手册 §1.4）。
 * ============================================================================
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Panel, Tag } from '../components/ui'
import { Emblem } from '../components/Emblem'
import {
  IconAlert,
  IconBellOff,
  IconCheck,
  IconClock,
  IconInfo,
  IconMegaphone,
  IconWifi,
} from '../components/icons'
import { useStore, useToast, type Toast } from '../data/store'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import { isRemote } from '../lib/supabase'
import { setDeviceRole } from '../lib/session'
import * as remote from '../data/remote'
import { useMaintenanceStatus } from '../lib/useMaintenance'
import { MaintenanceScreen } from '../components/MaintenanceGate'
import {
  shellAutoplayAllowed,
  shellCloseAllFloating,
  shellOpenTransparentWindow,
  shellPushBlockScreen,
  shellTransparentWindowAvailable,
} from '../lib/classroomShell'
import {
  awayText,
  dayState,
  maybeShift,
  toMinutes,
  weekdayOf,
} from '../lib/schedule'
import { beijingNow, dayKind, holidayOn, isRestDay, nextHoliday, ymdOf } from '../lib/holiday'
import { splitLessonTitle } from '../lib/scheduleParse'
import { isStreamClass } from '../lib/pick'
import {
  chime,
  isSilenced,
  quietNow,
  setExamMuted,
  softChime,
  speak,
  speechBudgetMs,
  stopSpeaking,
  unlockAudio,
} from '../lib/tts'
import { WEEKDAY_TEXT, type CallRecord, type ScheduleItem } from '../data/types'
import { buildContext, PluginHost, LIMITS, type PluginManifest } from '../lib/pluginHost'
import {
  GRID_PX,
  applySnap,
  bringToFront,
  cellsToPx,
  defaultLayout,
  normalizeLayout,
  type CanvasSize,
  type LayoutWin,
  type MinSize,
  type ShellLayout,
  type WinRect,
} from '../classroom/winman'
import {
  ClockBus,
  LocalBus,
  makeHostPorts,
  makeSlot,
  loadCrashRecord,
  saveCrashRecord,
  preflightPlugin,
  type PluginSlot,
} from '../classroom/loader'
import { availablePlugins, type AvailablePlugin } from '../classroom/demoPlugin'
import { toSlot } from '../classroom/resources'
import { configDefaults, loadPluginConfigs } from '../classroom/configs'
import { getSupabase } from '../lib/supabase'

/** 与旧教室端同一个键：一台机器两个壳记住的是同一个班。 */
const CLASS_KEY = 'shugao.classroom.classId'

/* ---------------- 播报队列的几个常数（与旧教室端同一批，改一处要想着另一处） ---------------- */
const MAX_QUEUE = 12
const BUBBLE_MIN_MS = 3_500
const BUBBLE_MS_PER_CHAR = 180
const SEEN_TTL_MS = 20 * 60_000
const SPEAK_AFTER_CHIME_MS = 680
const CLOSE_GUARD_MS = 1200

const lastAt = (c: CallRecord) => Math.max(0, ...(c.sentAt ?? []))
const callKey = (c: CallRecord) => `${c.id}:${lastAt(c)}`

type TempDayCell = { subject: string; teacherId: string | null; end: string }

/* ============================================================================
   大时钟（从旧 Classroom.tsx 原样搬来 —— 它自己的 1 秒 tick 只重渲染自己）
   ============================================================================ */
const ClockBig = memo(function ClockBig({ klassName }: { klassName: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <div className="p-5 text-center">
      <div className="num" style={{ fontSize: 62, fontWeight: 650, letterSpacing: '-.05em', lineHeight: 1 }}>
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span style={{ fontSize: 24, color: 'var(--color-ink4)', marginLeft: 4 }}>{pad(now.getSeconds())}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 8 }}>
        {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周
        {'日一二三四五六'[now.getDay()]} · {klassName}
      </div>
    </div>
  )
})

/* ============================================================================
   内置功能块 1：大时钟课表（清单 5 的屏面；写入口"粘贴/拍课表"随清单 12 走插件）
   ============================================================================ */
const ClockScheduleBlock = memo(function ClockScheduleBlock({
  klassName,
  weekdayLabel,
  day,
  dayConflicts,
  adjustedIds,
  restDay,
  restName,
  isMakeup,
  useWeekday,
  weekOverride,
  setWeekOverride,
  nowMin,
}: {
  klassName: string
  weekdayLabel: string
  day: ReturnType<typeof dayState>
  dayConflicts: string[]
  adjustedIds: ReadonlySet<string>
  restDay: boolean
  restName: string
  isMakeup: boolean
  useWeekday: number
  weekOverride: number | null
  setWeekOverride: (w: number | null) => void
  nowMin: number
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <ClockBig klassName={klassName} />
      <div className="panel overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-3" style={{ fontSize: 12.5 }}>
          <IconClock size={15} />
          <span style={{ color: 'var(--color-ink2)' }}>这个班的课 · {weekdayLabel}</span>
        </div>
        <div className="p-4 pt-2">
          {isMakeup ? (
            <div
              className="mb-2 flex flex-wrap items-center gap-1.5 p-2"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid var(--color-warnline)',
                borderRadius: 4,
                fontSize: 11.5,
                color: 'var(--color-warnink)',
              }}
            >
              <span>今天是调休上班日，按</span>
              {[1, 2, 3, 4, 5].map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWeekOverride(w)}
                  style={{
                    padding: '1px 7px',
                    borderRadius: 3,
                    fontSize: 11.5,
                    fontWeight: useWeekday === w && weekOverride !== null ? 700 : 500,
                    background:
                      useWeekday === w && weekOverride !== null
                        ? 'var(--color-warn)'
                        : 'rgb(255 255 255 / .6)',
                    /* ⚠️ 教室端恒亮（`data-theme` 永远不写），`#fff` 压在暖黄块上是有意的
                       （旧教室端同一处注释留档）；shots 的 F6 那两条数的是**插件**屏面，不含框架自己 */
                    color: useWeekday === w && weekOverride !== null ? '#fff' : 'inherit',
                  }}
                >
                  {WEEKDAY_TEXT[w - 1]}
                </button>
              ))}
              <span>的课表上</span>
              {weekOverride !== null ? (
                <button
                  type="button"
                  onClick={() => setWeekOverride(null)}
                  style={{ color: 'var(--color-ink3)', textDecoration: 'underline' }}
                >
                  还原
                </button>
              ) : null}
            </div>
          ) : null}

          {dayConflicts.length ? (
            <div
              className="mb-2 p-2"
              style={{
                background: 'var(--color-badsoft)',
                border: '1px solid var(--color-badline)',
                borderRadius: 4,
                fontSize: 11.5,
                color: 'var(--color-badink)',
                lineHeight: 1.6,
              }}
            >
              {dayConflicts.map((c) => (
                <div key={c}>⚠ {c}</div>
              ))}
            </div>
          ) : null}

          {restDay ? (
            <div
              style={{
                border: '1px solid var(--color-line2)',
                background: 'var(--color-surface)',
                borderRadius: 6,
                padding: '18px 16px',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700 }}>
                {restName ? `今天放假 · ${restName}` : '今天放假'}
              </div>
              <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
                没有课，好好休息 —— 明天按课表上课
              </div>
            </div>
          ) : day.current ? (
            <div
              style={{
                border: '1px solid var(--color-accent)',
                background: 'var(--color-accentsoft)',
                borderRadius: 6,
                padding: '14px 16px',
              }}
            >
              <div
                className="flex items-center gap-2"
                style={{ fontSize: 12, color: 'var(--color-accentink)' }}
              >
                <span
                  className="live-dot"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 99,
                    background: 'var(--color-accent)',
                    display: 'inline-block',
                  }}
                />
                正在上课
                <span className="flex-1" />
                <span className="num">
                  {day.current.start}–{day.current.end}
                </span>
              </div>
              <div
                style={{
                  fontSize: 30,
                  fontWeight: 750,
                  letterSpacing: '-.01em',
                  marginTop: 10,
                  lineHeight: 1.15,
                  textAlign: 'center',
                }}
              >
                {splitLessonTitle(day.current.title).subject}
              </div>
              {splitLessonTitle(day.current.title).teacher ? (
                <div
                  style={{
                    fontSize: 16,
                    color: 'var(--color-ink2)',
                    marginTop: 6,
                    textAlign: 'center',
                  }}
                >
                  {splitLessonTitle(day.current.title).teacher}
                </div>
              ) : null}
            </div>
          ) : day.items.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
              今天没有排课
            </div>
          ) : (
            <div>
              {day.items.map((it) => {
                const live = day.current?.id === it.id
                const next = day.next?.id === it.id
                const done = toMinutes(it.end) <= nowMin
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-3 py-1.5"
                    style={{ opacity: done ? 0.42 : 1 }}
                  >
                    <span
                      className="num shrink-0"
                      style={{
                        width: 46,
                        fontSize: 13,
                        fontWeight: 700,
                        color: live || next ? 'var(--color-accent)' : 'var(--color-ink2)',
                      }}
                    >
                      {it.start}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate"
                      style={{ fontSize: 13.5, fontWeight: live ? 700 : 550 }}
                    >
                      {it.title}
                    </span>
                    {live ? (
                      <Tag tone="ok">上课中</Tag>
                    ) : next && day.minutesToNext !== null ? (
                      <Tag tone="accent">下一节 {awayText(day.minutesToNext)}</Tag>
                    ) : null}
                    {adjustedIds.has(it.id) ? <Tag tone="warn">已调整</Tag> : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

/* ============================================================================
   内置功能块 2：呼叫播报（清单 10 的面板；收发与播报的 effect 在壳组件里，原样搬）
   ============================================================================ */
const CallsPanel = memo(function CallsPanel({
  exam,
  onExam,
  onTry,
}: {
  exam: boolean
  onExam: () => void
  onTry: () => void
}) {
  return (
    <div className="p-4">
      <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
        <IconMegaphone size={15} />
        <span style={{ color: 'var(--color-ink2)' }}>呼叫播报已就绪</span>
      </div>
      <Button size="sm" block className="mt-3" onClick={onTry}>
        试播一句
      </Button>
      <Button
        size="sm"
        block
        className="mt-2"
        variant={exam ? 'primary' : 'ghost'}
        icon={exam ? <IconCheck size={15} /> : <IconBellOff size={15} />}
        onClick={onExam}
      >
        {exam ? '结束考试' : '考试静音'}
      </Button>
    </div>
  )
})

/* ============================================================================
   内置块 3：19:20 收尾语（清单 5 的最后一条；0:00 起自己消失）
   ============================================================================ */
const ClosingPanel = memo(function ClosingPanel({ text }: { text: string }) {
  return (
    <div className="p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          className="grid place-items-center"
          style={{
            width: 46,
            height: 46,
            borderRadius: 99,
            background: 'var(--color-oksoft)',
            color: 'var(--color-ok)',
          }}
        >
          <IconCheck size={24} strokeWidth={2.4} />
        </span>
        <div style={{ fontSize: 17, fontWeight: 650, lineHeight: 1.6 }}>{text}</div>
        <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          明天 0:00 自动恢复显示作业情况
        </div>
      </div>
    </div>
  )
})

/* ============================================================================
   功能块窗口（窗口管理器的渲染那一半；算术在 `classroom/winman.ts`）
   ============================================================================ */
const WIN_TITLE_H = 34

function BlockWindow({
  win,
  title,
  z,
  floatAvailable,
  onFocus,
  onRect,
  onMode,
  onFloat,
  children,
}: {
  win: LayoutWin
  title: string
  z: number
  floatAvailable: boolean
  onFocus: (id: string) => void
  onRect: (id: string, rect: WinRect) => void
  /** 传的是**补丁**（`{ mode: … }`）—— 收口在壳的 patchWin，别在这里再造一种写法 */
  onMode: (id: string, patch: Partial<LayoutWin>) => void
  onFloat: (id: string) => void
  children: React.ReactNode
}) {
  const collapsed = win.mode === 'collapsed'
  const dragRef = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; orig: WinRect } | null>(null)

  const begin = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    e.preventDefault()
    onFocus(win.id)
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: { x: win.x, y: win.y, w: win.w, h: win.h } }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      const dy = ev.clientY - d.startY
      onRect(
        win.id,
        mode === 'move'
          ? { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }
          : { ...d.orig, w: d.orig.w + dx, h: d.orig.h + dy },
      )
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      data-cps-window={win.id}
      className="panel anim-in absolute flex flex-col overflow-hidden"
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: collapsed ? WIN_TITLE_H : win.h,
        zIndex: z,
      }}
      onPointerDown={() => onFocus(win.id)}
    >
      <div
        className="flex shrink-0 items-center gap-2 px-2.5"
        style={{
          height: WIN_TITLE_H,
          borderBottom: '1px solid var(--color-line)',
          cursor: 'move',
          touchAction: 'none',
          userSelect: 'none',
        }}
        onPointerDown={(e) => begin(e, 'move')}
      >
        <span className="truncate" style={{ fontSize: 12.5, fontWeight: 650 }}>
          {title}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          disabled={!floatAvailable}
          title={floatAvailable ? undefined : '要教室版程序'}
          onClick={() => onFloat(win.id)}
          style={{ fontSize: 11, color: floatAvailable ? 'var(--color-accenttext)' : 'var(--color-ink4)' }}
        >
          弹出
        </button>
        <button
          type="button"
          onClick={() => onMode(win.id, { mode: collapsed ? 'open' : 'collapsed' })}
          style={{ fontSize: 11, color: 'var(--color-ink2)' }}
        >
          {collapsed ? '展开' : '收起'}
        </button>
        <button
          type="button"
          title="收回"
          onClick={() => onMode(win.id, { mode: 'closed' })}
          style={{ fontSize: 12, color: 'var(--color-ink3)' }}
        >
          ✕
        </button>
      </div>
      <div
        data-cps-body=""
        className="min-h-0 flex-1 overflow-auto"
        style={{
          display: collapsed ? 'none' : undefined,
          /*
           * 🔴 窗口可以被拖到比内容还矮（老师会试）。这时**必须看得出"下面还有"**：
           * 浏览器默认的 overlay 滚动条是"滚动时才出现"，一眼看过去就是"文字被切了一半"
           * —— 2026-10-24 用户截图报的就是这个。⇒ 显式细滚动条 + 底部留一点空，
           * 让最后一行不会正好压在裁切边上。
           */
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--color-line2) transparent',
          overscrollBehavior: 'contain',
          paddingBottom: 8,
        }}
      >
        {children}
      </div>
      {!collapsed ? (
        <div
          aria-hidden
          onPointerDown={(e) => begin(e, 'resize')}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 16,
            height: 16,
            cursor: 'nwse-resize',
            touchAction: 'none',
            background:
              'linear-gradient(135deg, transparent 0 50%, var(--color-line2) 50% 58%, transparent 58% 66%, var(--color-line2) 66% 74%, transparent 74%)',
          }}
        />
      ) : null}
    </div>
  )
}

/* ============================================================================
   插件窗口：装载 → activate → 崩溃熔断 → 恢复（判据全在 pluginHost / loader）
   ============================================================================ */
type PluginUiState = 'booting' | 'active' | 'error' | 'disabled'

function PluginWindow({
  plugin,
  classId,
  className,
  clockBus,
  bus,
  push,
  onSize,
  onTitle,
  getConfig,
  onConfigChange,
  pipOpen,
  onStatus,
}: {
  plugin: AvailablePlugin
  classId: string
  className: string
  clockBus: ClockBus
  bus: LocalBus
  push: (t: Omit<Toast, 'id'>) => void
  onSize: (pluginId: string, w: number, h: number) => void
  /** `ctx.ui.setTitle` 落到这里：窗口标题是壳的 DOM，插件只报名字 */
  onTitle: (pluginId: string, title: string) => void
  /** P1 配置通道：壳侧算好的"当前生效值"与变化叫醒（手册 §2.3）。 */
  getConfig: (pluginId: string) => Record<string, unknown>
  onConfigChange: (pluginId: string, cb: (next: Record<string, unknown>) => void) => () => void
  pipOpen: (pluginId: string, opts: Record<string, unknown>) => Promise<boolean>
  onStatus: (pluginId: string, st: { ui: PluginUiState; reason: string | null }) => void
}) {
  const [ui, setUi] = useState<PluginUiState>('booting')
  const [reason, setReason] = useState<string | null>(null)
  const hostRef = useRef<PluginHost | null>(null)
  const slotRef = useRef<PluginSlot | null>(null)
  const startRef = useRef<(() => Promise<void>) | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const id = plugin.manifest.id

  useEffect(() => {
    let alive = true
    const slot = makeSlot(classId, id)
    slotRef.current = slot
    onStatus(id, { ui: 'booting', reason: null })

    /** 停用要说的话（手册 §10）：屏上留一行，恢复只能由人点 */
    const markDisabled = (why: string) => {
      if (!alive) return
      setUi('disabled')
      setReason(why)
      onStatus(id, { ui: 'disabled', reason: why })
    }

    const start = async (): Promise<void> => {
      /* 🔴 显式标注：`makeContext` 闭包里要引用 `host` 自己 —— 不标注 TS 会绕圈推不出来 */
      const host: PluginHost = new PluginHost({
        manifest: plugin.manifest,
        module: plugin.module,
        makeContext: () =>
          buildContext({
            manifest: plugin.manifest,
            classId,
            className,
            now: () => beijingNow(),
            container: containerRef.current,
            pipSupported: shellTransparentWindowAvailable(),
            ports: makeHostPorts({
              classId,
              pluginId: id,
              host,
              slot,
              clock: clockBus,
              bus,
              toast: (text) => push({ text, tone: 'info' }),
              setTitle: (t) => onTitle(id, t),
              setSize: (w, h) => onSize(id, w, h),
              getConfig: () => getConfig(id),
              onConfigChange: (cb) => onConfigChange(id, cb),
              pipOpen: (opts) => pipOpen(id, opts),
              log: (...a: unknown[]) => console.log('[plugin]', ...a),
            }),
            log: (...a: unknown[]) => console.log('[plugin]', ...a),
          }),
        now: () => Date.now(),
        onDispose: () => {},
        onDisabled: (why) => {
          markDisabled(why)
          void saveCrashRecord(slot, id, { reason: why, at: Date.now() })
          // 停用要收掉悬浮窗（classroomShell.ts 顶部约定第 4 条的那一行）
          shellCloseAllFloating()
        },
      })
      hostRef.current = host
      setUi('booting')
      onStatus(id, { ui: 'booting', reason: null })
      const r = await host.activate()
      if (!alive) return
      if (r.ok) {
        setUi('active')
        setReason(null)
        onStatus(id, { ui: 'active', reason: null })
      } else {
        // 单次失败 = "插件出错"（还没到熔断线）：屏上说明，码进日志（手册 §4.3 / §11.8）
        const msg = r.code === 'E_ACTIVATE_TIMEOUT' ? '启动超时了' : '启动没成功'
        console.error(`[plugin] ${id} activate 失败：`, r.code)
        setUi('error')
        setReason(msg)
        onStatus(id, { ui: 'error', reason: msg })
      }
    }
    startRef.current = start

    void (async () => {
      // 🔴 先查停用记录、再决定要不要 activate —— 顺序反了就等于"重启一下熔断就自己解了"
      const rec = await loadCrashRecord(slot, id)
      if (!alive) return
      if (rec) {
        markDisabled(rec.reason)
        return
      }
      await start()
    })()

    return () => {
      alive = false
      startRef.current = null
      void hostRef.current?.deactivate()
      hostRef.current = null
      slot.dispose()
    }
    // 插件清单与班级不变就不会重挂 —— key 在外面管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, classId])

  const recover = () => {
    const slot = slotRef.current
    if (!slot) return
    void (async () => {
      await saveCrashRecord(slot, id, null)
      hostRef.current?.enable()
      await startRef.current?.()
    })()
  }

  return (
    <div className="relative h-full" data-cps-plugin={id}>
      {/* 容器一直挂在 DOM 上：收起/展开只是显隐，插件 DOM 不许被拆（手册 §3 收起那一行） */}
      <div ref={containerRef} className="h-full" style={{ display: ui === 'active' || ui === 'booting' ? undefined : 'none' }} />
      {ui !== 'active' && ui !== 'booting' ? (
        <div
          className="grid h-full place-items-center p-4 text-center"
          data-cps-plugin-error
          style={{ fontSize: 13, color: 'var(--color-ink2)', lineHeight: 1.8 }}
        >
          <div>
            <div style={{ fontWeight: 650, fontSize: 15 }}>
              {ui === 'disabled' ? '插件已停用，可在教师端恢复' : '插件出错'}
            </div>
            {reason ? (
              <div className="mt-1" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                {reason}
              </div>
            ) : null}
            {ui === 'disabled' ? (
              <Button size="sm" className="mt-3" onClick={recover}>
                恢复这个插件
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ============================================================================
   壳本体
   ============================================================================ */

/** 一扇窗口在目录里的那一行（渲染与默认摆放都要它）。 */
interface WinDef {
  id: string
  title: string
  kind: 'clock' | 'calls' | 'closing' | 'plugin'
  plugin?: AvailablePlugin
  min: MinSize
  suggest: { w: number; h: number }
  /** 加载前就被拒（清单不合法 / 壳版本不够）—— 窗口照摆，只显示原因，不 activate */
  blocked?: string
}

const pluginMinOf = (m: PluginManifest): MinSize => ({
  w: cellsToPx(m.window?.min?.w ?? 2),
  h: cellsToPx(m.window?.min?.h ?? 2),
})
const pluginSuggestOf = (m: PluginManifest) => ({
  w: cellsToPx(m.window?.w ?? 4),
  h: cellsToPx(m.window?.h ?? 3),
})

export default function ClassroomPluginShell() {
  const classes = useStore((s) => s.classes)
  const classrooms = useStore((s) => s.classrooms)
  const setClassroomOnline = useStore((s) => s.setClassroomOnline)
  const ensureClassroom = useStore((s) => s.ensureClassroom)
  const hydrated = useStore((s) => s.hydrated)
  const teacher = useStore((s) => s.teacher)
  const schedule = useStore((s) => s.schedule)
  const push = useToast((s) => s.push)
  const navigate = useNavigate()

  /*
   * 🔴 教室端恒亮（#F4 硬规矩）—— 第三道（`lib/theme.ts` 与 `index.html` 是前两道），
   *    注释全文在旧 `Classroom.tsx` 同一处；这条路由被直接打开时在这里无条件清一次。
   *    shots 的 F4 组断言对新壳照样盯着它（本文件底部那次截图那一节）。
   */
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme')
  }, [])

  const [classId, setClassId] = useState(() => {
    try {
      return localStorage.getItem(CLASS_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const klass = classes.find((c) => c.id === classId) ?? classes[0]
  const client = classrooms.find((c) => c.classId === klass?.id)

  /* 记住选的是哪个班（与旧教室端同一语义） */
  useEffect(() => {
    if (!klass) return
    try {
      localStorage.setItem(CLASS_KEY, klass.id)
    } catch {
      /* 忽略 */
    }
  }, [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 时钟：顶层只到**分钟**（秒针归 ClockBig 自己）；整分同时喂插件的 clock.onMinute */
  const clockBus = useMemo(() => new ClockBus(), [])
  const [now, setNow] = useState(() => beijingNow())
  const lastMinuteRef = useRef('')
  useEffect(() => {
    const t = window.setInterval(() => {
      const d = beijingNow()
      setNow((v) => (v.getHours() === d.getHours() && v.getMinutes() === d.getMinutes() ? v : d))
      /*
       * 🔴 `onMinute` 是**整分** tick（手册 §4），不是每秒：这个 interval 每秒都在跑，
       *    不拦的话插件每秒被叫一次 —— 假插件每秒写一次槽，一分钟就撞上 60/min 的
       *    写入配额（E_QUOTA_RATE），第一次真机演示就会"莫名其妙被停用"。
       */
      const key = `${d.getHours()}:${d.getMinutes()}`
      if (lastMinuteRef.current !== key) {
        lastMinuteRef.current = key
        clockBus.emitMinute(d)
      }
    }, 1000)
    return () => window.clearInterval(t)
  }, [clockBus])

  /* 声音解锁：壳里不需要那一步（初值见旧教室端同一段注释），网页版照旧要点一下 */
  const [armed, setArmed] = useState(() => shellAutoplayAllowed())

  /* 考试模式：全屏黑底时钟，所有声音停掉 */
  const [exam, setExam] = useState(false)
  useEffect(() => {
    setExamMuted(exam)
    return () => setExamMuted(false)
  }, [exam])
  const silenced = exam || quietNow(now).quiet

  /* 课表重排只认"今天是星期几"（与旧教室端同一份口径与注释来源） */
  const [weekOverride, setWeekOverride] = useState<number | null>(null)
  const isMakeup = dayKind(ymdOf(now)) === 'makeup'
  const useWeekday = isMakeup && weekOverride !== null ? weekOverride : weekdayOf(now)
  const todayIso = ymdOf(now)
  const nowWeekday = weekdayOf(now)

  /* 今天有临时调整的那几格（数据源 = §38.6 的 `schedule_day_cells`；注释全文在旧页） */
  const localTempChanges = useStore((s) => s.tempScheduleChanges)
  const [dbTempCells, setDbTempCells] = useState<Record<string, TempDayCell>>({})
  const klassName = klass?.name ?? ''
  useEffect(() => {
    if (!isRemote || !klass?.id) return
    let alive = true
    const load = () => {
      void remote.loadScheduleDay(todayIso).then((r) => {
        if (!alive || r.status !== 'present') return
        const m: Record<string, TempDayCell> = {}
        for (const c of r.cells ?? []) {
          if (c.changed && c.classId === klass.id) {
            m[c.start] = { subject: c.subject, teacherId: c.teacherId, end: c.end }
          }
        }
        setDbTempCells(m)
      })
    }
    load()
    const t = window.setInterval(load, 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [klass?.id, todayIso])

  const tempOfDay = useMemo(() => {
    if (isRemote) return dbTempCells
    const m: Record<string, TempDayCell> = {}
    for (const c of localTempChanges ?? []) {
      if (c.date === todayIso && c.classId === klass?.id) {
        m[c.start] = { subject: c.toSubject, teacherId: c.toTeacherId ?? null, end: c.end }
      }
    }
    return m
  }, [dbTempCells, localTempChanges, todayIso, klass?.id])

  /* 今天的课（临时层合并 + 周一顺延）—— 与旧教室端逐行同源，别在此改口径 */
  const dayItems = useMemo(() => {
    const raw = schedule.filter(
      (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === useWeekday,
    )
    const used = new Set<string>()
    const merged: ScheduleItem[] = []
    for (const it of raw) {
      const t = tempOfDay[it.start]
      if (!t || used.has(it.start)) {
        merged.push(it)
        continue
      }
      used.add(it.start)
      if (!t.subject) continue
      merged.push({ ...it, title: `${klassName} ${t.subject}`.trim(), teacherId: t.teacherId ?? undefined })
    }
    for (const [start, t] of Object.entries(tempOfDay)) {
      if (!t.subject || used.has(start)) continue
      merged.push({
        id: `temp-${start}`,
        weekday: useWeekday,
        start,
        end: t.end,
        title: `${klassName} ${t.subject}`.trim(),
        kind: 'class',
        notify: false,
        scope: 'class',
        classId: klass?.id,
        teacherId: t.teacherId ?? undefined,
      })
    }
    merged.sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
    return maybeShift(merged, nowWeekday)
  }, [schedule, klass?.id, klassName, useWeekday, nowWeekday, tempOfDay])

  const adjustedIds = useMemo(() => {
    const ids = new Set<string>()
    const rows = schedule.filter(
      (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === useWeekday,
    )
    const used = new Set<string>()
    for (const it of rows) {
      const t = tempOfDay[it.start]
      if (!t || used.has(it.start)) continue
      used.add(it.start)
      if (t.subject) ids.add(it.id)
    }
    for (const [start, t] of Object.entries(tempOfDay)) {
      if (t.subject && !used.has(start)) ids.add(`temp-${start}`)
    }
    return ids
  }, [schedule, klass?.id, useWeekday, tempOfDay])

  const day = useMemo(() => dayState(dayItems.items, now, useWeekday), [dayItems.items, now, useWeekday])

  const restDay = isRestDay(todayIso)
  const restName = restDay ? (holidayOn(todayIso)?.name ?? '') : ''
  const nowMin = now.getHours() * 60 + now.getMinutes()

  /* 19:20 收尾语（与旧教室端同一份措辞与分档） */
  const closing = useMemo(() => {
    const h = now.getHours()
    const m = now.getMinutes()
    if (h < 19 || (h === 19 && m < 20)) return null
    const today = ymdOf(now)
    const nh = nextHoliday(today)
    if (nh && nh.daysLeft <= 7) {
      return `恭喜，今日的课业已全部完成，距离${nh.span.name}还有${nh.daysLeft}天`
    }
    const wd = now.getDay()
    const days = wd === 0 ? 0 : 6 - (wd - 1)
    return days <= 0
      ? '恭喜，今日的课业已全部完成，周末愉快'
      : `恭喜，今日的课业已全部完成，距离周末还有${days}天`
  }, [now])

  /* 下课铃：开始前 5 分钟一声轻"叮"（与旧教室端同一支，含放假/调休两个坑） */
  const rungRef = useRef('')
  useEffect(() => {
    const tick = () => {
      const n = new Date()
      if (isRestDay(ymdOf(n))) return
      const m = n.getHours() * 60 + n.getMinutes()
      for (const it of dayItems.items) {
        if (toMinutes(it.start) - m !== 5) continue
        const key = `${ymdOf(n)}-${it.id}`
        if (rungRef.current === key) continue
        rungRef.current = key
        softChime()
      }
    }
    tick()
    const t = window.setInterval(tick, 20_000)
    return () => window.clearInterval(t)
  }, [dayItems.items])

  /* 课程事件 → 插件的 clock.onLesson（换课/下课/考试开关；换算用 resources 的同一条） */
  const lessonRef = useRef<{ id: string | null; exam: boolean }>({ id: null, exam: false })
  useEffect(() => {
    const curId = dayItems.items.find((i) => i.id === day.current?.id) ?? null
    const prev = lessonRef.current
    const m = nowMin
    if (prev.id && prev.id !== (curId?.id ?? null)) {
      const prevItem = dayItems.items.find((i) => i.id === prev.id) ?? null
      if (prevItem) clockBus.emitLesson({ kind: 'lessonEnd', slot: toSlot(prevItem, 'current', m) })
    }
    if (curId && curId.id !== prev.id) {
      clockBus.emitLesson({ kind: 'lessonStart', slot: toSlot(curId, 'current', m) })
    }
    if (prev.exam !== exam) {
      clockBus.emitLesson({ kind: 'modeChange', mode: exam ? 'exam' : 'normal' })
    }
    lessonRef.current = { id: curId?.id ?? null, exam }
  }, [day.current?.id, exam, clockBus, dayItems.items, nowMin])

  /* 教室端自我登记 + 心跳（教师端"在线状态"靠它）—— 与旧教室端同一支 */
  useEffect(() => {
    if (!klass) return
    ensureClassroom(klass.id, '一体机')
  }, [klass?.id, ensureClassroom]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!client) return
    const beat = () => {
      if (isRemote) {
        setClassroomOnline(client.id, true)
      } else {
        emit({ type: 'heartbeat', classroomId: client.id, at: Date.now() })
        if (!client.online) setClassroomOnline(client.id, true)
      }
    }
    beat()
    const t = window.setInterval(beat, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [client?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 标记设备是教室端（只在教室端账号登录时；注释全文在旧页） */
  const accountKind = useStore((s) => s.accountKind)
  useEffect(() => {
    if (accountKind === 'classroom') setDeviceRole('classroom')
  }, [accountKind])

  /* ============================================================
     呼叫接收 + 播报队列（清单 10 的机制；与旧教室端逐行同源）
     ============================================================ */
  const [queue, setQueueState] = useState<CallRecord[]>([])
  const queueRef = useRef<CallRecord[]>([])
  const mutateQueue = useCallback((fn: (q: CallRecord[]) => CallRecord[]) => {
    const next = fn(queueRef.current)
    if (next === queueRef.current) return
    queueRef.current = next
    setQueueState(next)
  }, [])
  const broadcast = queue[0] ?? null
  const playedRef = useRef<Map<string, number>>(new Map())
  const seededRef = useRef(false)

  useEffect(() => {
    if (!klass) return
    /*
     * 🔴 Q17：**走班班的屏不接呼叫**（呼叫一律落到该学生行政班那块屏上）——
     *    与旧教室端同一支：连轮询都不开，目录里那扇"呼叫播报"窗口也不会出现。
     */
    if (isStreamClass(klass)) return
    const play = (c: CallRecord) => {
      const k = callKey(c)
      if (playedRef.current.has(k)) return
      if (queueRef.current.length >= MAX_QUEUE) return
      playedRef.current.set(k, Date.now())
      mutateQueue((q) => [...q, c])
    }
    stopSpeaking()
    mutateQueue(() => [])
    playedRef.current.clear()
    seededRef.current = false
    const off = subscribe((m) => {
      if (m.type !== 'call') return
      if (m.call.classId !== klass.id) return
      play(m.call)
    })
    let alive = true
    const tick = async () => {
      const list = await remote.loadRecentCalls(klass.id, Date.now() - 15 * 60_000)
      if (!alive) return
      const ordered = [...list].reverse().sort((a, b) => lastAt(a) - lastAt(b))
      if (!seededRef.current) {
        for (const c of ordered) playedRef.current.set(callKey(c), Date.now())
        seededRef.current = true
        return
      }
      const nowMs = Date.now()
      for (const [k, at] of playedRef.current) {
        if (nowMs - at > SEEN_TTL_MS) playedRef.current.delete(k)
      }
      for (const c of ordered) play(c)
    }
    void tick()
    const t = window.setInterval(() => void tick(), 8000)
    return () => {
      alive = false
      window.clearInterval(t)
      off()
    }
  }, [klass?.id, mutateQueue]) // eslint-disable-line react-hooks/exhaustive-deps

  const playHeadRef = useRef<() => void>(() => {})
  const closeAtRef = useRef(-Infinity)
  const headKey = broadcast ? callKey(broadcast) : ''
  useEffect(() => {
    if (!broadcast || silenced) return
    const key = callKey(broadcast)
    let done = false
    let speakTimer = 0
    let fallbackTimer = 0
    let holdTimer = 0
    let shownAt = Date.now()
    const advance = () => {
      if (done) return
      done = true
      mutateQueue((q) => (q[0] && callKey(q[0]) === key ? q.slice(1) : q))
    }
    const holdMs = () =>
      Math.max(BUBBLE_MIN_MS, broadcast.text.replace(/\s+/g, '').length * BUBBLE_MS_PER_CHAR)
    const finishSpeech = () => {
      const left = shownAt + holdMs() - Date.now()
      if (left > 0) holdTimer = window.setTimeout(advance, left)
      else advance()
    }
    const playHead = () => {
      chime()
      shownAt = Date.now()
      window.clearTimeout(speakTimer)
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(holdTimer)
      speakTimer = window.setTimeout(() => {
        if (isSilenced()) return
        speak(broadcast.text, { onEnd: finishSpeech })
      }, SPEAK_AFTER_CHIME_MS)
      fallbackTimer = window.setTimeout(
        () => {
          if (!isSilenced()) finishSpeech()
        },
        SPEAK_AFTER_CHIME_MS + speechBudgetMs(broadcast.text),
      )
    }
    playHeadRef.current = playHead
    playHead()
    return () => {
      window.clearTimeout(speakTimer)
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(holdTimer)
      playHeadRef.current = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headKey, silenced, mutateQueue])

  /* ============================================================
     维护模式：这一屏**自己**渲染维护画面（心跳照发；注释全文在旧页）
     ============================================================ */
  const maint = useMaintenanceStatus()
  const maintOn = maint.enabled
  useEffect(() => {
    if (!maintOn) return
    stopSpeaking()
    shellCloseAllFloating()
    setExam(false)
    mutateQueue(() => [])
  }, [maintOn, mutateQueue])

  /* ============================================================
     插件框架：目录 / 布局 / 悬浮窗的账
     ============================================================ */
  const [demoPlugin] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demoPlugin'),
  )
  const plugins = useMemo(() => availablePlugins(demoPlugin), [demoPlugin])
  const bus = useMemo(() => new LocalBus(), [])

  const streamMode = klass ? isStreamClass(klass) : false

  /* ============================================================
     P1 · 配置通道：教师端写 plugin_configs（§46），这块屏只读并执行。
     ------------------------------------------------------------
     · 出现/消失：目录里只进"教师启用 + 登记表放行"的插件 —— 教师一关，
       窗口整扇撤掉（PluginWindow 卸载 → deactivate，手册 §3 的"停用"那一行）。
     · 实时跟随：Realtime（`pluginConfigs` 门铃）+ 30s 轮询兜底（websocket 会
       悄悄断，旧教室端对呼叫也是这两条一起走的）。
     · 离线态：读失败**保留上一份清单**照跑（§6.4 的免疫力 —— 断网不许把屏清空），
       `loadPluginConfigs` 回 `unknown` 时这里直接不用它。
     ============================================================ */
  const [configsMap, setConfigsMap] = useState<
    Record<string, { enabled: boolean; config: Record<string, unknown> }>
  >({})
  const configsRef = useRef(configsMap)
  const configListenersRef = useRef(new Map<string, Set<(v: Record<string, unknown>) => void>>())
  const prevConfigJsonRef = useRef<Record<string, string>>({})

  /** 默认值 ∪ 教师设置（手册 §2.3：`ctx.config.get()` 拿到的是**已合并**的生效值）。 */
  const mergedConfig = useCallback(
    (pid: string): Record<string, unknown> => {
      const p = plugins.find((x) => x.manifest.id === pid)
      return { ...configDefaults(p?.manifest), ...(configsRef.current[pid]?.config ?? {}) }
    },
    [plugins],
  )

  const getConfig = useCallback((pid: string) => mergedConfig(pid), [mergedConfig])

  const onConfigChange = useCallback((pid: string, cb: (v: Record<string, unknown>) => void) => {
    const set = configListenersRef.current.get(pid) ?? new Set()
    set.add(cb)
    configListenersRef.current.set(pid, set)
    return () => {
      set.delete(cb)
    }
  }, [])

  const reloadConfigs = useCallback(async () => {
    const cid = klass?.id
    if (!cid) return
    const r = await loadPluginConfigs(cid)
    if (r.state !== 'ok') return
    const next: Record<string, { enabled: boolean; config: Record<string, unknown> }> = {}
    for (const row of r.rows) next[row.pluginId] = { enabled: row.enabled, config: row.config }
    configsRef.current = next
    setConfigsMap(next)
    // 谁的生效值变了叫醒谁（值按合并后的比 —— 默认值变了也算变了）
    for (const [pid, listeners] of configListenersRef.current) {
      if (!listeners.size) continue
      const merged = mergedConfig(pid)
      const json = JSON.stringify(merged)
      if (prevConfigJsonRef.current[pid] !== json) {
        prevConfigJsonRef.current[pid] = json
        for (const cb of [...listeners]) cb(merged)
      }
    }
  }, [klass?.id, mergedConfig])

  useEffect(() => {
    void reloadConfigs()
    const t = window.setInterval(() => void reloadConfigs(), 30_000)
    const off = subscribe((m) => {
      if (m.type === 'pluginConfigs' && m.classId === klass?.id) void reloadConfigs()
    })
    return () => {
      window.clearInterval(t)
      off()
    }
  }, [reloadConfigs, klass?.id])

  /* 登记表（§45.1，全员读）：放行且没撤下的插件才允许激活（手册 §3"停用"那一行）。 */
  const [liveIds, setLiveIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!isRemote) {
      setLiveIds(null)
      return
    }
    let alive = true
    const load = async () => {
      const sb = getSupabase()
      if (!sb) return
      try {
        const { data, error } = await sb
          .from('plugin_registry')
          .select('plugin_id, stable_version, revoked_at')
        if (!alive || error) return
        const set = new Set<string>()
        for (const r of Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) {
          if (r?.plugin_id && r.stable_version && !r.revoked_at) set.add(String(r.plugin_id))
        }
        setLiveIds(set)
      } catch {
        /* 读不到保持现状 —— 不把活着的插件停掉 */
      }
    }
    void load()
    const t = window.setInterval(() => void load(), 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  /** 插件状态上报（功能块清单上要显示"已停用/出错"）。 */
  const [pluginStatus, setPluginStatus] = useState<Record<string, { ui: PluginUiState; reason: string | null }>>({})
  const onStatus = useCallback((id: string, st: { ui: PluginUiState; reason: string | null }) => {
    setPluginStatus((prev) => ({ ...prev, [id]: st }))
  }, [])
  /** 插件 `ctx.ui.setTitle` 报上来的窗口标题（壳的 DOM，插件只报名字）。 */
  const [winTitles, setWinTitles] = useState<Record<string, string>>({})
  const onTitle = useCallback((id: string, t: string) => {
    setWinTitles((prev) => (prev[id] === t ? prev : { ...prev, [id]: t }))
  }, [])

  const floatAvailable = shellTransparentWindowAvailable()
  const floatingCountRef = useRef(0)
  const pipOpen = useCallback(
    async (pluginId: string, opts: Record<string, unknown>) => {
      if (!floatAvailable) {
        push({ text: '要教室版程序', tone: 'warn', desc: '悬浮窗要在教室版程序里才能弹' })
        return false
      }
      if (floatingCountRef.current >= LIMITS.floatingWindowsMax) {
        push({ text: '悬浮窗到上限了', tone: 'warn', desc: '先收掉几块再弹' })
        return false
      }
      const o = opts as { w?: number; h?: number; opacity?: number; transparent?: boolean }
      const r = await shellOpenTransparentWindow({
        w: o.w ?? 360,
        h: o.h ?? 220,
        opacity: o.opacity,
        transparent: o.transparent,
      })
      if (!r.ok) {
        push({ text: r.why, tone: 'warn' })
        return false
      }
      floatingCountRef.current += 1
      // 壳只画模板（one-way）；内容镜像由壳侧模板决定（附录 A 第 3 条）
      shellPushBlockScreen({ pluginId, w: o.w ?? 360, h: o.h ?? 220 })
      return true
    },
    [floatAvailable, push],
  )

  /** 加载前的两道闸在这里过：不合的进目录但**不 activate**，窗口里只说原因。 */
  const catalog: WinDef[] = useMemo(() => {
    const list: WinDef[] = [
      { id: '__clock', kind: 'clock', title: '大时钟课表', min: { w: 360, h: 360 }, suggest: { w: 432, h: 640 } },
    ]
    if (klass && !streamMode) {
      list.push({ id: '__calls', kind: 'calls', title: '呼叫播报', min: { w: 300, h: 200 }, suggest: { w: 432, h: 180 } })
    }
    if (closing) {
      list.push({ id: '__closing', kind: 'closing', title: '今日收尾', min: { w: 320, h: 140 }, suggest: { w: 620, h: 180 } })
    }
    for (const p of plugins) {
      /*
       * 🔴 P1 的开关链：`?demoPlugin=1` 是**演示直通**（不管配置硬上 —— 那是手册 §12
       *    的演示地址）；真开关在教师端：启用（plugin_configs.enabled）**且**登记表放行
       *    （stable_version 有值、没撤下）。两个条件缺一个就不进目录 —— 窗口随之消失。
       */
      const enabled = demoPlugin || (configsMap[p.manifest.id]?.enabled === true && (liveIds === null || liveIds.has(p.manifest.id)))
      if (!enabled) continue
      const gate = preflightPlugin(p)
      list.push({
        id: p.manifest.id,
        kind: 'plugin',
        title: p.manifest.name,
        plugin: p,
        min: pluginMinOf(p.manifest),
        suggest: pluginSuggestOf(p.manifest),
        blocked: gate.ok ? undefined : gate.reason,
      })
    }
    return list
  }, [klass?.id, streamMode, closing, plugins, demoPlugin, configsMap, liveIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const catalogById = useMemo(() => new Map(catalog.map((d) => [d.id, d])), [catalog])
  /* 布局归一化的"合法 id"要**稳定**（收尾语那扇时有时无，不能因为它把旧布局判成坏） */
  const stableIds = useMemo(
    () => new Set(['__clock', '__calls', '__closing', ...plugins.map((p) => p.manifest.id)]),
    [plugins],
  )

  /* 画布尺寸（窗口摆位与吸附都要它） */
  const canvasRef = useRef<HTMLDivElement>(null)
  const [canvas, setCanvas] = useState<CanvasSize>({ w: 1280, h: 720 })
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => setCanvas({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* 框架槽：布局按班记忆（`__framework` / `layout`） */
  const fwSlot = useMemo(() => (klass ? makeSlot(klass.id, '__framework') : null), [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => fwSlot?.dispose(), [fwSlot])

  const [layout, setLayout] = useState<ShellLayout | null>(null)
  useEffect(() => {
    if (!fwSlot) {
      setLayout(null)
      return
    }
    let alive = true
    void (async () => {
      const raw = await fwSlot.get('layout')
      if (!alive) return
      const norm = normalizeLayout(raw, stableIds)
      setLayout(norm ?? defaultLayout(
        [
          { id: '__clock', w: 432, h: 640 },
          ...(!streamMode ? [{ id: '__calls', w: 432, h: 180 }] : []),
          ...plugins.map((p) => ({ id: p.manifest.id, ...pluginSuggestOf(p.manifest) })),
        ],
        canvas,
        'grid',
      ))
    })()
    return () => {
      alive = false
    }
    // canvas 只在首挂时参与默认摆放；之后的人为布局都从库里来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fwSlot, stableIds])

  /* 目录里新增的窗口（收尾语出现 / 插件挂上）补进布局 —— 已有的不碰 */
  useEffect(() => {
    setLayout((prev) => {
      if (!prev) return prev
      const missing = catalog.filter((d) => !prev.windows.some((w) => w.id === d.id))
      if (!missing.length) return prev
      return {
        ...prev,
        windows: [
          ...prev.windows,
          ...missing.map((d) => ({ id: d.id, mode: 'open' as const, x: 16, y: 16, ...clampInto(d.suggest, canvas, d.min) })),
        ],
      }
    })
  }, [catalog, canvas])

  const persistTimer = useRef(0)
  const persistLayout = useCallback(
    (next: ShellLayout) => {
      if (!fwSlot) return
      window.clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(() => {
        // 高频状态去抖 800ms 再落库（手册 §7.3）
        void fwSlot.set('layout', next as unknown as Record<string, unknown>).catch((e) => {
          console.warn('[plugin] 窗口布局没存上：', e)
        })
      }, 800)
    },
    [fwSlot],
  )

  const patchWin = useCallback(
    (id: string, patch: Partial<LayoutWin>) => {
      setLayout((prev) => {
        if (!prev) return prev
        const windows = prev.windows.map((w) => (w.id === id ? { ...w, ...patch } : w))
        const next = { ...prev, windows }
        persistLayout(next)
        return next
      })
    },
    [persistLayout],
  )

  /** 拖动/缩放/`ui.setSize` 的唯一收口：在这里过吸附（一个引擎两档） */
  const moveRect = useCallback(
    (id: string, raw: WinRect) => {
      setLayout((prev) => {
        if (!prev) return prev
        const min = catalogById.get(id)?.min ?? { w: GRID_PX, h: GRID_PX }
        const snapped = applySnap(raw, canvas, prev.snap, min)
        const windows = prev.windows.map((w) => (w.id === id ? { ...w, ...snapped } : w))
        const next = { ...prev, windows }
        persistLayout(next)
        return next
      })
    },
    [canvas, catalogById, persistLayout],
  )

  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    if (layout && order.length === 0) setOrder(layout.windows.map((w) => w.id))
    // order 只初始化一次；之后由点击置前
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])
  const focusWin = useCallback((id: string) => {
    setOrder((prev) => (prev[prev.length - 1] === id ? prev : bringToFront(prev, id)))
  }, [])

  /* 功能块清单：收回的窗口从这里回来（否则 ✕ 一点就永远找不回来了） */
  const [launcherOpen, setLauncherOpen] = useState(false)

  const setSnap = useCallback(
    (snap: ShellLayout['snap']) => {
      setLayout((prev) => {
        if (!prev) return prev
        const next = { ...prev, snap }
        persistLayout(next)
        return next
      })
    },
    [persistLayout],
  )

  /* ---------- 以下全是整屏状态（与旧教室端同一批，措辞逐字相同） ---------- */
  if (maintOn) {
    return (
      <Shell>
        <MaintenanceScreen status={maint} variant="classroom" />
      </Shell>
    )
  }
  if (isRemote && !hydrated) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 15, fontWeight: 640 }}>正在同步数据…</div>
        </Panel>
      </Shell>
    )
  }
  if (isRemote && !teacher) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>教室端还没有登录</div>
          <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
            这台一体机需要用教师账号登录一次，之后会一直保持登录。
            <br />
            登录后回到本页即可。
          </div>
          <Button variant="primary" className="mt-4" onClick={() => navigate('/login')}>
            去登录
          </Button>
        </Panel>
      </Shell>
    )
  }
  if (!klass) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>还没有班级数据</div>
        </Panel>
      </Shell>
    )
  }

  /* 画布上真正渲染的窗口：开着/收起的、目录里有的，按置前顺序排 */
  const shown = (layout?.windows ?? [])
    .filter((w) => w.mode !== 'closed' && catalogById.has(w.id))
    .slice()
    .sort((a, b) => {
      const ia = order.indexOf(a.id)
      const ib = order.indexOf(b.id)
      return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib)
    })

  return (
    <Shell>
      <div data-cps-root className="relative z-[1] mx-auto flex min-h-full w-full flex-col">
        {/* 顶栏 = 基建状态条（手册 §8：它不是一个窗口，插件不许占位） */}
        <div
          className="glass sticky top-0 z-30 flex flex-wrap items-center gap-3 px-5"
          style={{ height: 62, borderBottom: '1px solid var(--color-line)' }}
        >
          <span className="flex items-center gap-2.5">
            <Emblem n={40} />
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>树高教务通</span>
            <Tag tone="accent">教室端</Tag>
            {streamMode ? <Tag tone="warn">走班班 · 只读</Tag> : null}
          </span>

          <span className="flex-1" />

          <select
            className="input"
            style={{ width: 'auto', height: 34, fontSize: 13 }}
            value={klass.id}
            onChange={(e) => setClassId(e.target.value)}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <span className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            <span
              className={client?.online ? 'live-dot' : ''}
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: client?.online ? 'var(--color-ok)' : 'var(--color-warn)',
                display: 'inline-block',
              }}
            />
            <IconWifi size={14} />
            <span style={{ color: 'var(--color-ink3)' }}>{client?.name ?? '未绑定'}</span>
          </span>

          {!armed ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconInfo size={14} />}
              onClick={() => {
                unlockAudio()
                setArmed(true)
                chime()
                push({ text: '已解锁声音', tone: 'ok', desc: '现在可以听到呼叫播报' })
              }}
            >
              先解锁声音
            </Button>
          ) : null}

          <button
            type="button"
            data-cps-snap={layout?.snap ?? 'grid'}
            onClick={() => setSnap(layout?.snap === 'grid' ? 'free' : 'grid')}
            style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}
          >
            吸附{layout?.snap === 'free' ? '关' : '开'}
          </button>

          {/* 功能块清单：每一块都能 收回/收起/打开 —— 收回的窗口从这儿回来 */}
          <span className="relative">
            <button
              type="button"
              data-cps-launcher
              onClick={() => setLauncherOpen((v) => !v)}
              style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}
            >
              功能块
            </button>
            {launcherOpen ? (
              <div
                className="panel absolute right-0 top-8 z-40 w-64 p-2"
                style={{ boxShadow: 'var(--lift-2)' }}
              >
                {catalog.map((d) => {
                  const lw = layout?.windows.find((x) => x.id === d.id)
                  const st = pluginStatus[d.id]
                  return (
                    <div key={d.id} className="flex items-center gap-2 py-1.5" style={{ fontSize: 12.5 }}>
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      {st?.ui === 'disabled' ? <Tag tone="bad">已停用</Tag> : null}
                      {st?.ui === 'error' ? <Tag tone="warn">出错</Tag> : null}
                      {lw?.mode === 'closed' ? (
                        <button
                          type="button"
                          style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
                          onClick={() => {
                            patchWin(d.id, { mode: 'open' })
                            focusWin(d.id)
                          }}
                        >
                          打开
                        </button>
                      ) : lw?.mode === 'collapsed' ? (
                        <button
                          type="button"
                          style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}
                          onClick={() => patchWin(d.id, { mode: 'open' })}
                        >
                          展开
                        </button>
                      ) : (
                        <button
                          type="button"
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                          onClick={() => patchWin(d.id, { mode: 'collapsed' })}
                        >
                          收起
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </span>
        </div>

        {/* 画布：窗口随便摆，基建不占格 */}
        <div
          ref={canvasRef}
          className="relative w-full flex-1"
          style={{ height: 'calc(100vh - 62px)', minHeight: 360, overflow: 'hidden' }}
        >
          <SyncBannerOverlay />

          {shown.map((w) => {
            const def = catalogById.get(w.id)
            if (!def) return null
            return (
              <BlockWindow
                key={w.id}
                win={w}
                title={winTitles[w.id] ?? def.title}
                z={10 + shown.indexOf(w)}
                floatAvailable={floatAvailable}
                onFocus={focusWin}
                onRect={moveRect}
                onMode={patchWin}
                onFloat={(id) => {
                  // 框架自己的弹出与插件同一扇透明窗（附录 A：单例复用）
                  void pipOpen(id, { w: Math.round(w.w * 0.8), h: Math.round(w.h * 0.8) })
                }}
              >
                {def.kind === 'clock' ? (
                  <ClockScheduleBlock
                    klassName={klassName}
                    weekdayLabel={WEEKDAY_TEXT[weekdayOf(now) - 1]}
                    day={day}
                    dayConflicts={dayItems.conflicts}
                    adjustedIds={adjustedIds}
                    restDay={restDay}
                    restName={restName}
                    isMakeup={isMakeup}
                    useWeekday={useWeekday}
                    weekOverride={weekOverride}
                    setWeekOverride={setWeekOverride}
                    nowMin={nowMin}
                  />
                ) : def.kind === 'calls' ? (
                  <CallsPanel
                    exam={exam}
                    onExam={() => {
                      unlockAudio()
                      setExam((v) => !v)
                    }}
                    onTry={() => {
                      unlockAudio()
                      setArmed(true)
                      chime()
                      window.setTimeout(
                        () => speak('请 12 号、37 号，到老师办公室。'),
                        SPEAK_AFTER_CHIME_MS,
                      )
                    }}
                  />
                ) : def.kind === 'closing' ? (
                  <ClosingPanel text={closing ?? ''} />
                ) : def.plugin ? (
                  def.blocked ? (
                    <div
                      className="grid h-full place-items-center p-4 text-center"
                      style={{ fontSize: 13, color: 'var(--color-ink2)', lineHeight: 1.8 }}
                    >
                      {def.blocked}
                    </div>
                  ) : (
                    <PluginWindow
                      key={`${klass.id}:${def.id}`}
                      plugin={def.plugin}
                      classId={klass.id}
                      className={klassName}
                      clockBus={clockBus}
                      bus={bus}
                      push={push}
                      onSize={(pid, cw, ch) =>
                        moveRect(pid, { x: w.x, y: w.y, w: cellsToPx(cw), h: cellsToPx(ch) })
                      }
                      onTitle={onTitle}
                      getConfig={getConfig}
                      onConfigChange={onConfigChange}
                      pipOpen={pipOpen}
                      onStatus={onStatus}
                    />
                  )
                ) : null}
              </BlockWindow>
            )
          })}

          {/* 考试模式：全屏黑底时钟（与旧教室端同一块，原样搬） */}
          {exam ? (
            <div
              className="fixed inset-0 z-[90] flex flex-col items-center justify-center"
              style={{ background: '#000' }}
            >
              <div
                className="num"
                style={{
                  fontSize: 'clamp(72px, 17vw, 190px)',
                  fontWeight: 200,
                  color: '#fff',
                  lineHeight: 1,
                  letterSpacing: '.02em',
                }}
              >
                {String(now.getHours()).padStart(2, '0')}
                <span style={{ opacity: 0.35 }}>:</span>
                {String(now.getMinutes()).padStart(2, '0')}
              </div>
              <div
                style={{
                  marginTop: 18,
                  fontSize: 14,
                  letterSpacing: '.24em',
                  color: 'rgb(255 255 255 / .42)',
                }}
              >
                考试进行中 · 已静音
              </div>
              <button
                type="button"
                onClick={() => setExam(false)}
                style={{
                  marginTop: 46,
                  fontSize: 13,
                  color: 'rgb(255 255 255 / .34)',
                  textDecoration: 'underline',
                }}
              >
                结束考试
              </button>
            </div>
          ) : null}

          {/* 播报浮层（与旧教室端同一块，原样搬：静音期间不显示，队列留着） */}
          {broadcast && !silenced ? (
            <div
              className="anim-in fixed inset-0 z-[70] flex flex-col items-center justify-center px-10"
              style={{ background: 'rgb(10 14 20 / .95)' }}
            >
              <div
                className="flex items-center gap-2.5"
                style={{ color: 'rgb(255 255 255 / .55)', fontSize: 14, letterSpacing: '.14em' }}
              >
                <span
                  className="live-dot"
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 99,
                    background: '#4ade9a',
                    display: 'inline-block',
                  }}
                />
                正在播报
              </div>
              <div
                style={{
                  color: '#fff',
                  fontSize: 46,
                  fontWeight: 700,
                  lineHeight: 1.5,
                  textAlign: 'center',
                  marginTop: 26,
                  maxWidth: 1200,
                }}
              >
                {broadcast.text}
              </div>
              {queue.length > 1 ? (
                <div
                  style={{
                    marginTop: 18,
                    fontSize: 14,
                    color: 'rgb(255 255 255 / .5)',
                    letterSpacing: '.06em',
                  }}
                >
                  后面还有 <b className="num">{queue.length - 1}</b> 条呼叫在排队，会依次播报
                </div>
              ) : null}
              <div className="mt-10 flex gap-3">
                <Button onClick={() => playHeadRef.current()}>再播一遍</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const at = Date.now()
                    if (at - closeAtRef.current < CLOSE_GUARD_MS) return
                    closeAtRef.current = at
                    stopSpeaking()
                    mutateQueue((q) => q.slice(1))
                  }}
                >
                  关闭
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Shell>
  )
}

/* ---------------- 基建的小件（与旧教室端同款，原样搬） ---------------- */

/** 建议尺寸夹进画布（新窗口第一次出现时用一次） */
function clampInto(s: { w: number; h: number }, canvas: CanvasSize, min: MinSize): { w: number; h: number } {
  return {
    w: Math.max(min.w, Math.min(s.w, Math.max(min.w, canvas.w - 32))),
    h: Math.max(min.h, Math.min(s.h, Math.max(min.h, canvas.h - 32))),
  }
}

/* 教室端不套教师端的应用壳（与旧教室端同一行） */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-[1] mx-auto min-h-full w-full">{children}</div>
}

/** 同步失败横幅 —— 教室里这块屏也得自己说出来（与旧教室端逐字同一份） */
function SyncBannerOverlay() {
  const syncError = useStore((s) => s.syncError)
  const clearSyncError = useStore((s) => s.clearSyncError)
  if (!syncError) return null
  return (
    <div className="absolute inset-x-3 top-3 z-40">
      <button
        type="button"
        onClick={clearSyncError}
        className="anim-in flex w-full items-start gap-2.5 p-3.5 text-left"
        style={{
          background: 'var(--color-warnsoft)',
          border: '1px solid var(--color-warnline)',
          borderRadius: 6,
        }}
      >
        <span style={{ color: 'var(--color-warn)', marginTop: 1, flexShrink: 0 }}>
          <IconAlert size={17} />
        </span>
        <span style={{ flex: 1 }}>
          <span
            style={{ display: 'block', fontSize: 13.5, fontWeight: 620, color: 'var(--color-warnink)' }}
          >
            数据没能存到服务器
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 12,
              color: 'var(--color-warnink2)',
              marginTop: 3,
              lineHeight: 1.7,
            }}
          >
            {syncError} · 本地已保留，网络好了再操作一次
          </span>
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--color-warnink2)', flexShrink: 0 }}>知道了</span>
      </button>
    </div>
  )
}

/** 未登录 / 同步中 / 没有班级这三种整屏状态下也要能看见同步失败 */
function SyncWrap() {
  const syncError = useStore((s) => s.syncError)
  if (!syncError) return null
  return (
    <div className="mx-auto w-full px-5 pt-4" style={{ maxWidth: 1360 }}>
      <SyncBannerOverlay />
    </div>
  )
}
