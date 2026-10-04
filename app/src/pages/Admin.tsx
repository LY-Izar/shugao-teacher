import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../data/store'
import { getSupabase, isRemote, connectionMode, SUPABASE_URL } from '../lib/supabase'
import { apiUrl } from '../lib/apiBase'
import { APP_VERSION, APP_VERSION_LABEL, BUILD_HASH } from '../lib/version'
import { deviceRole, deviceRoleAt, authDaysLeft } from '../lib/session'
import { loginFailText, toEmail } from '../lib/accounts'
import { isSuperAdmin } from '../lib/roles'
import { getExamTablesProbeStatus, probeReport } from '../data/remote'
import { getFileClassColsProbeAt, getFileClassColsStatus } from '../lib/files'
import { displayNoOfArchiveKey, studentOfArchiveKey } from '../lib/keys'
import type { Klass } from '../data/types'
import {
  agoText,
  humanBytes,
  judgeBackup,
  judgeDbUsage,
  judgeEgress,
  judgeErrorLog,
  judgeFeedback,
  judgeR2,
  judgeServiceKey,
  judgeSuperAdminCount,
  probeSchemaDrift,
  scanAssignmentContradictions,
  dirtyGroups,
  driftSummary,
  driftTone,
  worstTone,
  ADMIN_SECTIONS,
  ARCHIVE_META_BAD_BYTES,
  DB_QUOTA_BYTES,
  EGRESS_QUOTA_BYTES,
  NO_PROBE_REASON,
  R2_KEYS,
  withFileProbe,
  type AdminTab,
  type BackupFacts,
  type ClientProbeReport,
  type DbFacts,
  type DriftSection,
  type EgressFacts,
  type EgressJudgement,
  type ErrorFacts,
  type FeedbackFacts,
  type SecretFacts,
  type SuperAdminFacts,
  type Tone,
  looksLikeServerReport,
} from '../lib/adminChart'
import {
  adminDeleteErrors,
  adminListErrors,
  fetchDbUsage,
  fetchReleaseState,
  sendTestMail,
  setMaintenance,
  setRelease,
  type AdminErrorRow,
  type AdminReleaseSlot,
  type DbReport,
  type ErrorsReport,
} from '../lib/adminOps'
import {
  adminListFeedback,
  adminSetFeedbackHandled,
  type AdminFeedbackReport,
} from '../lib/feedback'
import {
  MAINTENANCE_CONFIRM_WORD,
  MAINTENANCE_DEFAULT_HOURS,
  MAINTENANCE_DEFAULT_MESSAGE,
  MAINTENANCE_HOURS,
  MAINTENANCE_MESSAGE_MAX,
  fetchMaintenanceAdminState,
  inputToMs,
  previewText,
  validateMaintenanceForm,
  type AdminMaintenanceState,
} from '../lib/maintenance'
import { useMaintenanceStatus } from '../lib/useMaintenance'
import {
  RELEASE_NOTE_MAX,
  RELEASE_NOTE_SOFT,
  RELEASE_TITLE_FORCE,
  RELEASE_TITLE_SOFT,
  isReleaseUrl,
  releaseDefaultNote,
  releaseTitle,
  validateReleaseForm,
} from '../lib/release'
import { Button, Track } from '../components/ui'
/* 🔴 2026-10-04：「导出档案备份（加密）」与「导出本机备份并发一封通知邮件」这两颗
   从「我的」撤下来、搬进「③ 备份（G2）」卡 —— **实现只有那一份文件**，
   这里只 import、不复制（同一个东西两套实现是这个仓库反复栽过的坑）。 */
import { BackupExtraActions } from '../components/BackupExtraActions'
import { downloadJson, readJsonFile } from '../lib/backup'
import {
  isAdminSealed,
  openAdminSealed,
  type AdminSealed,
  type AdminSealedPayload,
} from '../lib/backupCrypto'
import { beijingNow, ymdOf } from '../lib/holiday'
import {
  LEVEL_TEXT,
  POPUP_TEXT,
  adminListAnnouncements,
  announcementPrivacyHint,
  createAnnouncement,
  isActiveAt,
  revokeAnnouncement,
  updateAnnouncement,
  type AnnouncementInput,
} from '../lib/announcements'
import type { Announcement, AnnouncementLevel, AnnouncementPopup } from '../data/types'
import {
  IconAlert,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconGauge,
  IconInfo,
  IconList,
  IconLock,
  IconMegaphone,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSliders,
  IconTrash,
  IconUpload,
  IconWifi,
} from '../components/icons'

/* ============================================================
   超管运维面板（第一期）
   ------------------------------------------------------------
   方案：`超管运维面板方案.md`（第一期 = 「静默故障可见化」）。
   实装的五条指标：G2 备份 · B1/B3 配置 · A1/A3 版本与连接模式 ·
   C1 schema 段漂移总表 · E7 assignments 内部矛盾扫描。

   🔴 **为什么这个页面不在 `AppShell` / `Guard` 里**（面板方案 §3.6 与 §七 T6）
      `Guard` 会把两类人送去 `/login`：① 账号是教室端的；② **这台设备被标成教室端的**。
      而 `/settings`（面板入口所在页）也在 `Guard` 里 ——
      **超管这台机器被标成教室端时，他连面板都进不去**，而面板恰恰是用来救这种情况的。
      `hydrate()` 失败时也是同一条路：用户被踢到登录页，而登录页不渲染 `syncError`，
      症状是"**莫名被踢回登录页，毫无解释**"。

      所以这个页面：**不套 AppShell、不进 Guard、自己取数**，
      并且**允许"半坏状态"下打开** —— 能拿到的显示，拿不到的如实写"无法判断"。

   🔴 **权限判据在服务端**（`/api/admin/config-check` 里问数据库的 `is_super_admin()`）。
      本文件里那句 `isSuperAdmin(myRoles)` **只决定界面摆不摆东西**，
      和 `App.tsx` 对 `/accounts` 的口径一致：「藏入口是"少点几下"，**不是安全边界**」。
   ============================================================ */

/* ============================================================
   🆕 2026-09-29 管理台第二期：**面板自己一套左侧分区导航**
   ------------------------------------------------------------
   用户原话："这个是管理台，你能不能设计一下它的页面让它更像管理台一点？"
   改之前的问题：它是**一列从上到下的卡片**（部署 / 配置 / 备份 / 漂移 / 矛盾 / 公告），
   像"一串报告"，功能一多就变成十几张卡的长列表。

   🔴 **仍然不套 `AppShell`、不进 `Guard`**（I41 那条纪律一个字没动）——
      这套导航是**面板内部**自己的，与 `AppShell` 的左栏无关：
      `AppShell` 只在 `Guard` 通过后才渲染，而这块屏最该起作用的时候恰恰是
      "Guard 不让人进"的时候（设备被标成教室端 / hydrate 失败）。
   🔴 **移动端能用**：窄屏时左栏折叠成**顶部横向分段**；
      但"大表格类"功能（错误日志明细、逐表体积）仍走"请在电脑上使用"的口径。
      ⚠️ 分区表（`ADMIN_SECTIONS` / `AdminTab`）在 `lib/adminChart.ts` ——
        放在那边是因为组件文件里导出常量会让 Fast Refresh 失效，
        而它本身是"可被断言的数据"（`admin-checks` 直接读它核对）。
   ============================================================ */

/* ---------------- 服务端回话的形状（与 functions/api/admin/config-check.ts 对齐） ---------------- */

type ServerReport = {
  status?: string
  config?: { keys: Record<string, boolean>; selfReady: boolean; supabaseHost: string }
  backup?: {
    configured: boolean
    lastRun?: {
      conclusion: string | null
      agoMs: number | null
      htmlUrl: string | null
      event: string | null
    } | null
    lastSuccess?: { agoMs: number | null; htmlUrl: string | null } | null
    sizeBytes?: number | null
    signals?: string[]
    degradedToArtifact?: boolean
    sizeUnknownReason?: string | null
    error?: string
  }
  /**
   * 🆕 2026-10-07 · `all` 那一支也带数据库用量 + **出流量**。
   * ⚠️ 这里**只用它的 `egress`**（库大小那半走 `adminOps.fetchDbUsage()`，
   *    回话形状由那个文件负责）—— 出流量是**另一条来源**（Management API），
   *    它的字段进不了 `DbReport`，所以直接从原始回话里读。
   */
  db?: { egress?: EgressFacts }
  message?: string
}

/** 一次服务端回话的结果：ok / 没权限 / 没配置 / 其它错误（**四种，不合并**） */
type ServerState =
  | { kind: 'loading' }
  | { kind: 'ok'; report: ServerReport }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_configured'; message: string }
  | { kind: 'error'; message: string }

/* ---------------- 小件 ---------------- */

/**
 * 四档颜色 → 屏上那个词。
 *
 * 🔴 **2026-10-08 用户拍板：黄档的词从「需要处理」改成「要留意」**。
 *    原话：「**把这个黄点消了，反正也配不了**」——
 *    「需要处理」暗示"**有个动作等着你**"，而这一档里最典型的两个
 *    （② 的 R2 四个 secret、③ 的 Artifact 备份）**是永久且做不到的**：
 *    R2 要绑国际银行卡，当前账号做不到 → **那是已接受的降级，不是待办**。
 *    → 黄档改叫「要留意」；**"已知 · 已接受 + 代价"写在卡自己的标题句里**（见下两处 `chipText`）。
 *    ⚠️ 这条口径是断言钉着的（`admin-checks` 第七节·补三 + `shots`：屏上**不许出现**"需要处理"）。
 */
const TONE_STYLE: Record<Tone, { dot: string; chip: string; text: string }> = {
  ok: { dot: 'var(--color-ok)', chip: 'tag tag-ok', text: '正常' },
  warn: { dot: 'var(--color-warn)', chip: 'tag tag-warn', text: '要留意' },
  bad: { dot: 'var(--color-bad)', chip: 'tag tag-bad', text: '异常' },
  unknown: { dot: 'var(--color-idle)', chip: 'tag tag-idle', text: '无法判断' },
}

function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      style={{
        width: 9,
        height: 9,
        borderRadius: 99,
        background: TONE_STYLE[tone].dot,
        display: 'inline-block',
        flex: 'none',
      }}
    />
  )
}

/**
 * 一条 L1 分诊卡。
 *
 * 方案 §3.4 第 1 条：「**L1 卡上不放明细，只放"颜色 + 一句话 + 一个数字"**。
 * 想放第二个数字，就说明该拆卡。」
 * 所以明细一律走 `children`，而 `children` **在点开之后**才渲染。
 */
function Card({
  tone,
  title,
  headline,
  note,
  chipText,
  children,
  openLabel = '看明细',
  defaultOpen = false,
}: {
  tone: Tone
  title: string
  headline: string
  note?: string
  /**
   * 🆕 覆盖角标上那个词（默认取 `TONE_STYLE[tone].text`）。
   *
   * 只有"**已知 · 已接受**"那种黄卡用它：② 的 R2 与 ③ 的 Artifact 备份
   * **不是"有个待办"**，是永久状态（用户 2026-10-08：「把这个黄点消了，反正也配不了」）——
   * 所以角标写「降级中（已知）」，**代价写在 headline 里**。
   * ⚠️ 颜色仍由 `tone` 决定（不新增第五档，`index.css` 里那套 `[data-tone]` 一个字不动）。
   */
  chipText?: string
  children?: React.ReactNode
  openLabel?: string
  /**
   * 🆕 默认展开（只有「维护模式」那一张用）。
   *
   * 为什么要有它：`管理台第二期方案.md` §三 的表里写着维护模式那一张 **不折叠**
   * ——「🔴 它是全屏唯一一个"我现在正开着"的状态，**藏起来就是藏事故**」。
   * 但 `Card` 原来的唯一形态是"`children` 点开才渲染"（方案 §3.4 第 1 条：L1 卡上不放明细），
   * 于是这句话在实现里**落了空**：常态下 `data-maint-confirm` / `data-maint-on`
   * 连 DOM 里都没有（`shots.mjs` 的第一期纪律是"先点开再查"，但这一张按方案不该有那一步）。
   *
   * ⚠️ 它只是**初值**（`useState(defaultOpen)`）：超管仍然可以手动收起。
   */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      className="panel mb-3 overflow-hidden"
      data-tone={tone}
      /*
       * 🆕 2026-10-04：**L0 那句"N 项要留意"展开后每条的「看这一块」按它找卡**。
       * 用属性找、不用可见文案 —— 与 `data-admin-toggle` 同一条纪律（§18.2）：
       * 文案改一个字就把断言弄红，那是"测试比产品还脆"。
       */
      data-admin-card={title}
    >
      <div className="flex items-start gap-3 p-3.5">
        <span style={{ paddingTop: 5 }}>
          <Dot tone={tone} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontSize: 14.5, fontWeight: 650 }}>{title}</span>
            <span className={TONE_STYLE[tone].chip}>{chipText ?? TONE_STYLE[tone].text}</span>
          </div>
          <div className="mt-1" style={{ fontSize: 13, lineHeight: 1.7 }}>
            {headline}
          </div>
          {note ? (
            <div
              className="mt-1"
              style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}
            >
              {note}
            </div>
          ) : null}
        </div>
        {children ? (
          /*
           * `data-admin-toggle`（稳定的机器可读钩子）+ `aria-expanded`（无障碍语义）。
           * 回归脚本按**属性**找它，不按可见文案 —— 文案改一个字就把断言弄红，
           * 那是"测试比产品还脆"（§18.2 的纪律：断言要能"产品坏了就红"，而不是"改了字就红"）。
           */
          <Button
            size="sm"
            variant="ghost"
            data-admin-toggle={title}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起' : openLabel}
          </Button>
        ) : null}
      </div>
      {open && children ? (
        <div
          className="border-t border-line"
          style={{ background: 'var(--color-surface2)' }}
          data-admin-detail={title}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

/** 明细里的一个小标题 */
function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '.1em',
        color: 'var(--color-ink3)',
        padding: '10px 14px 4px',
      }}
    >
      {children}
    </div>
  )
}

/** 「只能提示」那一类动作 —— 方案 §3.4 要求**显式写清是第三类** */
function HintOnly({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-3.5 mb-3 flex items-start gap-2 p-2.5"
      style={{
        background: 'var(--color-idlesoft)',
        border: '1px solid var(--color-line)',
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.7,
        color: 'var(--color-ink2)',
      }}
    >
      <IconInfo size={14} />
      <span className="flex-1">
        <b>只能提示（面板点一下修不了）</b>：{children}
      </span>
    </div>
  )
}

/** 明细里那一行固定说明（方案 §5.4：不做"谁看过"留痕，改用这一行） */
function PrivacyLine() {
  return (
    <div
      className="mx-3.5 mb-2 flex items-center gap-2 px-2.5 py-1.5"
      style={{
        background: 'var(--color-warnsoft)',
        border: '1px solid var(--color-warnline)',
        color: 'var(--color-warnink)',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      <IconEyeOff size={14} />
      <span>此页含学号／姓名，请勿投屏或截图</span>
    </div>
  )
}

/** 一行 KV（不复用 ui.tsx 的 KV：那一行是右对齐的，明细里要左对齐） */
function Line({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      className="flex items-baseline gap-3 px-3.5 py-1.5"
      style={{ borderBottom: '1px solid var(--color-line)', fontSize: 12.5 }}
    >
      <span style={{ color: 'var(--color-ink3)', minWidth: 96, flex: 'none' }}>{k}</span>
      <span className="min-w-0 flex-1" style={{ wordBreak: 'break-word' }}>
        {v}
      </span>
    </div>
  )
}

/* ============================================================
   🆕 2026-10-04「N 项要留意」点一下 → 全部列出来
   ------------------------------------------------------------
   用户原话："维护面板，能不能我点一下概览里面要留意的，就把所以黄色或者红色
   状态的全部列出来呀，一个一个找有点麻烦"。

   🔴 **只列黄与红**（`attentionItems` 已经滤过）：**灰 = "没结论 / 量不到"，
      它不是"要留意"**（三态纪律）。灰项只在末尾附一行"另有 N 项" ——
      混进黄红清单里就是把"我没量到"说成"平台上出事了"。
   ============================================================ */

/**
 * 「要留意」清单里的一条。
 *
 * 🔴 `reason` **必须与那张卡 `headline` 逐字相同**（同一次计算的值，
 *    不是"另写一套措辞、另算一遍"）。所以这个数组在渲染处**只建一次**：
 *    顶部那个数字、这份清单、以及每张卡自己，全都从它取。
 *
 * ⚠️ 只有"读不到"的灰项**不进这个数组**（三态纪律）—— 它们另算一行。
 */
type AttentionItem = {
  key: string
  tone: Tone
  /** 哪一块 —— 逐字等于下面那张卡的 `title`（也是 `data-admin-card` 的值） */
  title: string
  reason: string
  /** 不在当前这一栏时要先切过去（`null` = 就在当前这栏里） */
  tab: AdminTab | null
  /** 这一条的东西在哪一栏（`data-admin-pane` 的值）—— 用于核对"切过去真的找得到" */
  pane: string
}

/**
 * 展开后的**汇总清单**：一行一条，四样东西 —— 状态点 / 哪一块 / 一句话原因 / 「看这一块」。
 *
 * 🔴 条数**不由它自己算**：`items` 就是顶部那个数字的来源（同一份数据）。
 * 🔴 灰项**不在 `items` 里**，只在末尾单独一行 —— 它不算"要留意"。
 * ⚠️ 一整行就是一颗原生 `button`（键盘 Tab / 回车都能触发），**不是**往 div 上挂 `onClick`。
 */
function AttentionList({
  items,
  unknownCount,
  onGo,
}: {
  items: readonly AttentionItem[]
  unknownCount: number
  onGo: (item: AttentionItem) => void
}) {
  return (
    <div
      id="admin-attention-list"
      className="px-3.5 py-2.5"
      style={{ borderTop: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
      data-admin-attention-list
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onGo(item)}
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 py-1 text-left"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
          data-admin-attention-row
          data-attention-card={item.title}
          data-attention-tone={item.tone}
        >
          <Dot tone={item.tone} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{item.title}</span>
          <span
            className="min-w-0 flex-1"
            style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--color-ink2)' }}
          >
            {item.reason}
          </span>
          <span
            style={{
              flex: 'none',
              fontSize: 12.5,
              fontWeight: 600,
              /* ⚠️ 同上：不用 `accenttext`（F6-H 钉着恰好 25 处）—— 靠加粗 + 下划线 */
              color: 'var(--color-ink)',
              textDecoration: 'underline',
            }}
          >
            看这一块
          </span>
        </button>
      ))}
      {unknownCount > 0 ? (
        <div
          className="pt-1.5"
          style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
          data-admin-attention-unknown
        >
          另有 <span className="num">{unknownCount}</span> 项无法判断（拿不到数据，不算"要留意"）
        </div>
      ) : null}
    </div>
  )
}

/**
 * L0 那句话 + 「N 项要留意」那颗按钮 + 展开后的清单 —— **一个整体**。
 *
 * 🔴 为什么合成一个组件：那句话里的数字与清单的条数**必须是同一份数据算出来的**。
 *    摆在一个组件里，`items.length` 就是两者唯一的来源 —— 想让它俩不一致都做不到。
 * 🔴 0 项时**不产生按钮**（整句只是一句陈述），所以屏上不会出现"0 项要留意"
 *    那种看着像出错的样子。
 * 🔴 灰（"量不到"）**不进 `items`**，只在清单末尾附一行 —— 它不算"要留意"。
 */
function AttentionBar({
  toneAll,
  items,
  unknownCount,
  onGo,
}: {
  /** 全屏汇总色（与原写法同一个 `worstTone(allTones)`）—— 它决定那句话的前半截 */
  toneAll: Tone
  items: readonly AttentionItem[]
  unknownCount: number
  onGo: (item: AttentionItem) => void
}) {
  const [open, setOpen] = useState(false)
  /*
   * 🔴 数字 = `items.length`（**就是清单本身**）。不是另数一遍 `allTones` ——
   *    那样两个数会各自漂移，而用户点开就是为了核这份清单。
   * ⚠️ "项异常" / "项要留意"沿用原来那句人话（`toneAll === 'bad' ? … : …`），
   *    文案一个字没换。
   */
  const bad = toneAll === 'bad'
  return (
    <>
      <div style={{ fontSize: 16, fontWeight: 680 }} data-admin-headline>
        {bad
          ? '平台有问题 · '
          : toneAll === 'warn'
            ? '平台基本正常 · '
            : toneAll === 'unknown'
              ? '平台状态无法完全判断 · '
              : '平台正常 · 没有发现异常'}
        {items.length > 0 ? (
          <button
            type="button"
            data-admin-attention-toggle
            aria-expanded={open}
            aria-controls="admin-attention-list"
            onClick={() => setOpen((v) => !v)}
            style={{
              background: 'transparent',
              border: 0,
              padding: 0,
              font: 'inherit',
              /*
               * ⚠️ **不能改成 `--color-accenttext`**：`shots` 的 F6-H 钉着"全仓 `color:`
               *    前景色用 accenttext 的**恰好 25 处**"（四个主题 × 那批小字的对比度锚点）。
               *    所以这一颗（以及清单里那行「看这一块」）用**墨色加粗 + 下划线**表达
               *    "这里能点" —— 可点性靠 `underline` + `cursor: pointer` + 原生 button。
               */
              color: 'var(--color-ink)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            <span className="num">{items.length}</span>
            {bad ? ' 项异常' : ' 项要留意'}
          </button>
        ) : null}
      </div>
      {open && items.length > 0 ? (
        <AttentionList items={items} unknownCount={unknownCount} onGo={onGo} />
      ) : null}
    </>
  )
}

/**
 * 「维护模式」那张卡的 headline —— **提到组件外面**，因为它是**两个地方**共用的那一句话：
 * 卡自己、以及 L0 展开的「要留意」清单（🔴 逐字同一句，不许另写）。
 */
function maintenanceHeadline(state: AdminMaintenanceState | null, error: string): string {
  if (state === null) return `无法判断 —— 读不到维护状态${error ? `（${error}）` : ''}`
  if (state.effective) return `🔴 **正在维护中** —— ${state.message || MAINTENANCE_DEFAULT_MESSAGE}`
  if (state.enabled) return `已定时 / 已到点：${state.text}`
  return '未开启（全校正常）'
}

/**
 * 「版本更新」那张卡的 headline —— **提到组件外面**，因为它是**两个地方**共用的那一句话：
 * 卡自己、以及 L0 展开的「要留意」清单（🔴 逐字同一句，不许另写）。
 */
function releaseHeadline(
  slots: { teacher: AdminReleaseSlot; classroom: AdminReleaseSlot } | null,
  error: string,
): string {
  const say = (s: AdminReleaseSlot | undefined) =>
    !s ? '无法判断' : s.enabled && s.live ? `正在发 v${s.version}（${s.force ? '强制' : '选择性'}）` : '没发'
  if (error) return `无法判断 —— 读不到版本公告${error ? `（${error}）` : ''}`
  if (!slots) return '无法判断 —— 还没取到'
  return `教师端：${say(slots.teacher)} · 教室端：${say(slots.classroom)}`
}

/**
 * 「版本更新」那张卡的颜色 —— **两个地方共用**（卡自己 + L0 的清单/颜色汇总）。
 * 🔴 读不到 = 灰（`unknown`）；有公告在生效 = 黄；都没有 = 绿。
 */
function releaseTone(
  slots: { teacher: AdminReleaseSlot; classroom: AdminReleaseSlot } | null,
  error: string,
): Tone {
  if (error || !slots) return 'unknown'
  return slots.teacher.enabled || slots.classroom.enabled ? 'warn' : 'ok'
}

/** 「看这一块」要找的那个元素：先按卡找，卡不存在时按磁贴找（"最高管理员"只有磁贴） */
function cardEl(target: string): Element | null {
  return document.querySelector(
    `[data-admin-card="${target}"], [data-admin-tile="${target}"]`,
  )
}

/* ---------------- ⑥ 档案解密：只有超管能开 ----------------
 *
 * 用户口径（2026-10-03）：「人人可点，但是能不能加密？**就是只有找超管才能解开**」。
 * 封那一步在 `/settings`（「导出档案备份（加密）」→ `lib/backupCrypto.ts` 的 `sealForAdmin`，
 * 公钥**写死在代码里**）；开只能在这里，用的是超管手里的私钥
 * （`超管档案备份私钥.pem`，存在密码管理器 / 离线文件里 —— **没进仓库、没进数据库、没进聊天**）。
 *
 * 🔴 私钥**只在这台机器的这次解密里过一遍内存**：不写 `localStorage`、不上传、不进日志。
 * 🔴 解出来的正文是**明文 PII**（家长电话 / 住址）：屏上挂了「请勿投屏」，下载按钮写明"用完删掉"。
 * 🔴 失败必须有话说 —— `openAdminSealed` 把三类失败分开了，其中
 *    "**这把私钥不是封它时的那一对**"才是超管最可能碰上的（换过钥匙 / 拿错了文件）。
 * ⚠️ 它**不是恢复入口**：档案只从云端回来；这份解密件是"云端真没了 / 要打电话"时用的。
 *
 * 🔴🔴 **与"钥匙不进面板"那条决定的界线（2026-10-04 用户 ③ 之后写清）**：
 *    · **这一张是本地当场解密的工具**：超管自己把那一段私钥粘进来、当场开、当场清 ——
 *      私钥**不进服务端**（`openAdminSealed` 是纯前端 WebCrypto）、**不落库、不落本机存储**、
 *      不进日志（见上面三行）。所以它不违反 ③。
 *    · **新增的备份 / 恢复那一套一律不许在面板里出现钥匙** ——
 *      整库口令（`BACKUP_ENCRYPTION_PASSPHRASE`）与档案私钥都留在超管手上；
 *      面板只读状态，**不做任何口令 / 私钥的输入框或上传口**（落点是「③ 备份（G2）」那张卡）。
 *    · ⚠️ 换句话说：**别拿这一张当先例**，往备份 / 恢复流程里加钥匙输入 —— 那是被明确否掉的。
 *    🔴 **已知缺口**：这一张现在**一条门禁都没钉**（`app/scripts` 里
 *       `档案解密|SealDecrypt|私钥` 零命中）—— 补门禁是下一轮的事，不是"它没问题"。
 */
function SealDecryptCard() {
  const store = useStore()
  const [doc, setDoc] = useState<AdminSealed | null>(null)
  const [name, setName] = useState('')
  const [pem, setPem] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [out, setOut] = useState<AdminSealedPayload | null>(null)
  const pick = useRef<HTMLInputElement>(null)

  /* 档案里只有学生 uuid：屏上要给看得懂的东西（**班内学号** / 姓名，查不到就明写查不到）。
     ⚠️ 这里直接取 `studentNo`（= 界面上永远显示的那个号），**不许**自己写
     `serial || studentNo` 那种回落 —— 号与键的翻译只有 `lib/keys.ts` 一处（D12 会红）。 */
  const who = useMemo(() => {
    const m = new Map<string, { no: string; name: string }>()
    for (const k of store.classes) {
      for (const s of k.students) m.set(s.id, { no: s.studentNo, name: s.name })
    }
    return m
  }, [store.classes])

  async function onPick(f: File) {
    setName(f.name)
    setDoc(null)
    setOut(null)
    setErr('')
    try {
      const raw = await readJsonFile(f)
      if (!isAdminSealed(raw)) {
        setErr('这个文件不是「加密的档案备份」（少了封存标记 shugao-admin-sealed）')
        return
      }
      setDoc(raw)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '这个文件读不了')
    }
  }

  async function onOpen() {
    if (!doc) return
    setBusy(true)
    setErr('')
    setOut(null)
    try {
      setOut(await openAdminSealed(doc, pem))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const nStu = out?.studentProfiles.length ?? 0
  const nTea = out?.teacherProfiles.length ?? 0

  return (
    <Card
      tone={err ? 'bad' : out ? 'ok' : 'unknown'}
      title="⑥ 档案解密（只有超管能开）"
      headline={
        doc
          ? `已选：${name} —— 里面学生 ${doc.n.studentProfiles} 条 / 教师 ${doc.n.teacherProfiles} 条`
          : '选一份「导出档案备份（加密）」的文件，用超管的私钥解开'
      }
      note={doc ? `封存于 ${doc.at} · 钥匙指纹 ${doc.kid}` : undefined}
      openLabel="展开解密台"
    >
      <SubHead>第一步 · 选加密档案（`.json` 可以随便传阅，没有私钥打不开）</SubHead>
      <div className="flex items-center gap-2 px-3.5 pb-2">
        <input
          ref={pick}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void onPick(f)
          }}
        />
        <Button size="sm" icon={<IconLock size={14} />} onClick={() => pick.current?.click()}>
          选择加密档案文件
        </Button>
        {name ? <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>{name}</span> : null}
      </div>

      <SubHead>第二步 · 私钥（只在这次解密的内存里过一遍：不写本机、不上传、不进日志）</SubHead>
      <div className="px-3.5 pb-2">
        <textarea
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={'-----BEGIN PRIVATE KEY-----\n…把那一整段粘进来…\n-----END PRIVATE KEY-----'}
          className="w-full"
          style={{
            height: 92,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11.5,
            lineHeight: 1.6,
            padding: 8,
            background: 'var(--color-idlesoft)',
            border: '1px solid var(--color-line)',
            borderRadius: 4,
            color: 'var(--color-ink)',
            resize: 'vertical',
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<IconLock size={14} />}
            disabled={!doc || !pem.trim() || busy}
            onClick={() => void onOpen()}
          >
            {busy ? '正在解开…' : '解开这份档案'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!pem && !out}
            onClick={() => {
              /* 清空 = 私钥与已解出的明文一起从内存里撤掉（不留在这块屏上） */
              setPem('')
              setOut(null)
              setErr('')
            }}
          >
            清空私钥与明文
          </Button>
        </div>
      </div>

      {err ? (
        <div
          className="mx-3.5 mb-3 flex items-start gap-2 p-2.5"
          style={{
            background: 'var(--color-badsoft)',
            border: '1px solid var(--color-badline)',
            color: 'var(--color-badink)',
            borderRadius: 4,
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          <IconAlert size={14} />
          <span className="flex-1">{err}</span>
        </div>
      ) : null}

      {out ? (
        <>
          <PrivacyLine />
          <SubHead>解开的内容（明文 —— 请勿投屏或截图）</SubHead>
          <Line k="学生档案" v={`${nStu} 条`} />
          <Line k="教师档案" v={`${nTea} 条`} />
          <Line
            k="填了的"
            v={`有家长电话 ${out.studentProfiles.filter((p) => p.guardianPhone.trim()).length} 条 · 有家庭住址 ${out.studentProfiles.filter((p) => p.homeAddress.trim()).length} 条`}
          />
          {nStu ? (
            <>
              <SubHead>最前面 5 条（全部内容在下面那份文件里）</SubHead>
              <div className="px-3.5">
                <table className="w-full" style={{ fontSize: 12 }}>
                  <tbody>
                    {out.studentProfiles.slice(0, 5).map((p) => {
                      const w = who.get(p.studentId)
                      return (
                        <tr key={p.studentId} style={{ borderBottom: '1px solid var(--color-line)' }}>
                          <td
                            style={{
                              padding: '5px 8px 5px 0',
                              color: 'var(--color-ink3)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {w ? w.no : '查不到'}
                          </td>
                          <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                            {w ? w.name : '（本机没有这个学生）'}
                          </td>
                          <td className="num" style={{ padding: '5px 0' }}>
                            {p.guardianPhone || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <div className="px-3.5 py-2">
            <Button
              size="sm"
              icon={<IconUpload size={14} />}
              onClick={() => downloadJson(out, `树高档案-已解密-${ymdOf(beijingNow())}.json`)}
            >
              下载已解密的档案（明文 JSON）
            </Button>
            <div
              className="mt-2"
              style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
            >
              ⚠️ 这份文件是<b>明文</b>的家长电话 / 住址 —— 只在本机保存，用完删掉。
              平时不该导出它：**云端才是主副本**，解开只为"云端真没了"和"要打电话"这两件事。
            </div>
          </div>
        </>
      ) : null}

      <HintOnly>
        私钥**丢了就永远打不开**（没有第二把，也没有"找回"这条路）—— 生成时那份
        `超管档案备份私钥.pem` 要存进密码管理器 / 离线文件。轮换钥匙 = 重新生成一对 +
        改 `lib/backupCrypto.ts` 里的公钥 + 重新发版；**旧信封只能用旧私钥开**（按信封上的
        `kid` 分辨是哪一把）。
      </HintOnly>
    </Card>
  )
}

/* ---------------- 登录卡（**面板自己的，不是 /login**） ----------------
 *
 * 为什么要有它：这台机器被标成教室端（或 hydrate 失败）时，用户**进不去 /settings**，
 * 也就看不到面板入口，而面板又要求登录 —— 于是"最该起作用的时候打不开"。
 * 所以面板把登录**放在自己里面**：地址栏敲 `/admin` 就能到，登录完留在面板。
 * ⚠️ 它**不绕过任何鉴权**：登录仍然是 Supabase 的密码登录，
 *    判据仍然是服务端的 `is_super_admin()`。
 */
function PanelLogin({ reason }: { reason: string }) {
  const hydrate = useStore((s) => s.hydrate)
  const navigate = useNavigate()
  const [account, setAccount] = useState('')
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr('')
    const sb = getSupabase()
    if (!sb) {
      setBusy(false)
      setErr('当前是本地模式，没有云端会话可登录。')
      return
    }
    /*
     * 🔴 2026-10-01（A5）：这里原来**自己拼了一个"只补 @qq.com"的版本**，
     *    与登录页 / 建号用的规则不一致（`lib/accounts.ts` 文件头那条纪律：
     *    "建号与登录必须用同一个函数"）—— 短名账号在这个入口根本敲不进去。改成 `toEmail()`。
     * 🔴 失败文案同样走 `loginFailText()`：**不回显 GoTrue 原文**
     *    （原文会漏"账号在不在 / 有没有确认过 / 有没有被限流"）。
     */
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(account), password: pwd })
    if (error) {
      setBusy(false)
      setErr(loginFailText(error.message))
      return
    }
    await hydrate()
    setBusy(false)
  }

  return (
    <div className="mx-auto w-full px-4 py-8" style={{ maxWidth: 420 }}>
      <div className="panel overflow-hidden">
        <div className="panel-head">
          <h2>平台运维面板</h2>
          <span className="flex-1" />
          <span className="tag tag-idle num">{APP_VERSION_LABEL}</span>
        </div>
        <div className="p-4">
          <div
            className="mb-4 p-2.5"
            style={{
              background: 'var(--color-warnsoft)',
              border: '1px solid var(--color-warnline)',
              borderRadius: 4,
              fontSize: 12.5,
              lineHeight: 1.7,
              color: 'var(--color-warnink)',
            }}
          >
            {reason}
          </div>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label>
              <span className="label">邮箱 / 账号</span>
              <input
                className="input"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="最高管理员的账号"
                autoComplete="username"
              />
            </label>
            <label>
              <span className="label">密码</span>
              <input
                className="input"
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {err ? <div style={{ fontSize: 12.5, color: 'var(--color-bad)' }}>{err}</div> : null}
            <Button type="submit" variant="primary" block disabled={busy}>
              {busy ? '正在进入…' : '登录'}
            </Button>
          </form>
          <div className="mt-3" style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
            只有<b>最高管理员</b>（`teacher_roles` 里的 `super` 行）能打开这块屏。
            教务处、年级主任、班主任都不在这一档 —— 要看学校业务数据请走各自的页面。
            <br />
            <button
              type="button"
              className="mt-2"
              style={{ color: 'var(--color-accenttext)', fontSize: 12 }}
              onClick={() => navigate('/login')}
            >
              去普通登录页 →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 主页面 ---------------- */

export default function Admin() {
  const navigate = useNavigate()
  const hydrated = useStore((s) => s.hydrated)
  const userId = useStore((s) => s.userId)
  const myRoles = useStore((s) => s.myRoles)
  const syncError = useStore((s) => s.syncError)
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const accountKind = useStore((s) => s.accountKind)

  const [sessionChecked, setSessionChecked] = useState(!isRemote)
  const [hasSession, setHasSession] = useState(!isRemote)

  /**
   * 「现在」不是渲染的一部分，是**一次取数动作的产物**。
   *
   * 三条理由，缺一条都会把这一屏做歪：
   *  ① 渲染必须是纯的 —— 在渲染里读时钟会被判成不纯调用，
   *     而 React 也可能把同一次渲染重跑，那样两半屏的相对时间会互相矛盾；
   *  ② 面板上的"多久以前"是给人判断用的，**同一屏必须共用一个"现在"**；
   *  ③ 它天然该跟着「重测」一起更新 —— 不重测就不该假装时间是新的。
   * 所以：初始 0（还没取数），每次取数成功时盖一个时间戳。
   */
  const [now, setNow] = useState(0)
  const stamp = () => setNow(Date.now())

  /**
   * 会话：**直接问 supabase**，不看 `store.teacher`。
   * `hydrate()` 失败时 `teacher` 是 null，但**会话本身可能是好的** ——
   * 那正是"超管被莫名踢回登录页"那一刻，面板必须还能判断出"你其实是登录着的"。
   */
  useEffect(() => {
    if (!isRemote) return
    let alive = true
    const sb = getSupabase()
    void Promise.resolve(sb ? sb.auth.getSession() : null)
      .then((res) => {
        if (!alive) return
        setHasSession(Boolean(res?.data.session))
        setSessionChecked(true)
      })
      .catch(() => {
        if (!alive) return
        setHasSession(false)
        setSessionChecked(true)
      })
    return () => {
      alive = false
    }
  }, [userId])

  /* 1. 服务端回话（配置完整性 + 备份） */
  const [server, setServer] = useState<ServerState>({ kind: 'loading' })
  const fetchServer = useCallback(async (): Promise<ServerState> => {
    const sb = getSupabase()
    if (!sb) {
      return { kind: 'not_configured', message: '本地模式：没有云端连接，配置与备份都查不到。' }
    }
    try {
      const {
        data: { session },
      } = await sb.auth.getSession()
      const r = await fetch(apiUrl('/api/admin/config-check'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ action: 'all' }),
      })
      const body = (await r.json().catch(() => ({}))) as ServerReport
      if (r.status === 403) {
        return { kind: 'forbidden', message: body.message ?? '只有最高管理员能打开这块屏。' }
      }
      if (r.status === 503) {
        return { kind: 'not_configured', message: body.message ?? '服务端还没配置好。' }
      }
      if (!r.ok) return { kind: 'error', message: body.message ?? `HTTP ${r.status}` }
      /*
       * 🔴 **HTTP 200 ≠ "拿到了那份回话"**（2026-10-04，apk 实测）。
       *
       * 两个壳的 origin 都不是线上域名（exe `app://-` / apk `https://localhost`）
       * ⇒ `fetch('/api/…')` 会被**壳自己的本地服务器**接走，而它对不认识的路径回
       * **200 + index.html**：`r.ok` 真、`r.json()` 抛错被上面 `.catch` 咽成 `{}`。
       * 旧逻辑只看 `r.ok` ⇒ 判成"服务端在、只是 secret 没配" ⇒ 面板写「未配置」（**假红**），
       * 还让超管去 Cloudflare 加 secret —— 而真病因是那条请求根本没出壳。
       * 形状不对 ⇒ 按"读不到"处理（灰）。判据在 `lib/adminChart.looksLikeServerReport`。
       */
      if (!looksLikeServerReport(body)) {
        return {
          kind: 'error',
          message:
            '面板接口没回那份 JSON（拿到了 200，但内容不是它）—— 多半是这条请求没出壳 / 没到线上域名。',
        }
      }
      return { kind: 'ok', report: body }
    } catch (e) {
      return {
        kind: 'error',
        message: `连不上面板接口：${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }, [])

  const reloadServer = useCallback(() => {
    setServer({ kind: 'loading' })
    void fetchServer().then((s) => {
      stamp()
      setServer(s)
    })
  }, [fetchServer])

  useEffect(() => {
    if (!sessionChecked || !hasSession) return
    let alive = true
    void fetchServer().then((s) => {
      if (!alive) return
      stamp()
      setServer(s)
    })
    return () => {
      alive = false
    }
  }, [sessionChecked, hasSession, fetchServer])

  /**
   * 2. C1 结构漂移。
   *
   * 首屏**也跑一次**：方案 §3.2 把探针放在"默认全部折叠、点了才算"那一层，
   * 理由是 F 组（业务体检）要为每个人跑一遍权限判据 —— 那是真贵。
   * 而 C1 只是十来次廉价的存在性探测（表 / 列 / 函数），量级完全不同。
   */
  const [drift, setDrift] = useState<{ at: number; sections: DriftSection[] } | null>(null)
  const [driftBusy, setDriftBusy] = useState(false)
  const reloadDrift = useCallback(() => {
    setDriftBusy(true)
    void probeSchemaDrift()
      .then((d) => {
        stamp()
        setDrift(d)
      })
      .finally(() => setDriftBusy(false))
  }, [])

  useEffect(() => {
    let alive = true
    void probeSchemaDrift().then((d) => {
      if (!alive) return
      stamp()
      setDrift(d)
    })
    return () => {
      alive = false
    }
  }, [])

  /*
   * 🆕 2026-10-08：**最高管理员有几个**（「超管锁死」那一格的数）。
   *
   * 一次 `select('*')` 只读——🔴 **`select('*')` 不是 `select('id')`**（本项目踩过两次：
   * `subjects` 没有 `id` 列；探针一旦假设"每张表都有 id"，那条卡在任何正确的库上都是红的）。
   * 这里读的是**真的行**（不是探针），但表可能还没建（旧库）——所以照三态处理：
   * 读失败 → 灰"无法判断"；读到 0 行 → **红**（谁也管不了平台）；1 行 → 绿；>1 行 → 红。
   *
   * ⚠️ RLS：`teacher_roles_read` 只给"自己那一行"，而这一屏只有超管打得开
   *    —— 读到的恰好就是他自己那一条。**判据仍在数据库**，前端只负责显示。
   */
  const [superAdmins, setSuperAdmins] = useState<SuperAdminFacts>(() =>
    /*
     * 🔴 「本地模式（没有连数据库）」这一档**在初值里就说清**，不再留到 effect 里 `setState` ——
     *    "在 effect 体里同步 setState"会被 oxlint 的 `react(set-state-in-effect)` 记一笔
     *    （这一批要 lint 0/0），而这一档本来就是个**常量**，没必要多绕一轮渲染。
     *    结论与行为一字不变：这一屏在 `sessionChecked` 之前根本不画（见下面的 early return）。
     */
    getSupabase()
      ? { readable: false, count: null, unknownReason: null }
      : { readable: false, count: null, unknownReason: '本地模式（没有连数据库）' },
  )
  useEffect(() => {
    if (!sessionChecked || !hasSession) return
    let alive = true
    const sb = getSupabase()
    /* 本地模式那一档已经由初值说过了（见上）——这里没什么可问的 */
    if (!sb) return
    void sb
      .from('teacher_roles')
      .select('*')
      .eq('role', 'super')
      .then(({ data, error }) => {
        if (!alive) return
        if (error) {
          setSuperAdmins({
            readable: false,
            count: null,
            unknownReason: `${error.message}${error.code ? `（${error.code}）` : ''}`,
          })
          return
        }
        setSuperAdmins({ readable: true, count: (data ?? []).length, unknownReason: null })
      })
    return () => {
      alive = false
    }
  }, [sessionChecked, hasSession])

  /*
   * 3. C2 前端探测汇总（读现成状态，**不改任何写入路径**）。
   * 🆕 2026-10-08：把**第四个探测**（`lib/files.ts` 的 `ensureFileClassCols`）也并进来 ——
   *    它以前缺一个只读 getter，所以那一行永远缺着（面板自己底部写着这件事）。
   *    合并是纯函数（`withFileProbe`），**不新增第二套判据**，也不碰 `data/remote.ts`。
   */
  const probes: ClientProbeReport = useMemo(
    () => withFileProbe(probeReport(), getFileClassColsStatus(), getFileClassColsProbeAt()),
    [],
  )
  const examProbe = getExamTablesProbeStatus()
  /* 4. E7 矛盾扫描（🟢 纯前端、零额外请求） */
  const classNames = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes])
  const contradictions = useMemo(
    () => scanAssignmentContradictions(assignments, classNames),
    [assignments, classNames],
  )
  const dirty = dirtyGroups(contradictions)
  const [showNames, setShowNames] = useState(false)
  /**
   * 档案键（`missingNos` / `wrong` 的键）→ 班内学号 / 姓名。
   *
   * 🔴 **两个键的世界**（`lib/keys.ts` 的 I40，2026-09-25 起）：档案里那 10 个字段的键
   *    **已经换成全校唯一的序列号**（`students.serial`，7 位 `YYYY`+`NNN`），
   *    而**界面上永远显示班内学号**（老师看到的东西不变）。
   *    E7 明细里的 `studentNos` 因此可能是 `2025007` 这种序列号 ——
   *    面板必须走 `lib/keys.ts` 那一处唯一入口去翻译，**不许自己写 `s.serial || s.studentNo`**
   *    （那条纪律写在 `keys.ts` 文件头：漏一处就是静默少一个人，而且不报错）。
   *
   * 🔴 隐私三级里的 **B 类**：明细里**默认只有班内学号**（"学号即身份"，§一 全局约定），
   *    姓名要显式点「显示姓名」才渲染，而且**排在最后**。
   *    这是方案 §5.3 的原话："明细里第一列是学号，第二列才是姓名"。
   */
  const rosterOf = useMemo(() => {
    const byAssignment = new Map<string, Klass['students']>()
    for (const a of assignments) {
      const k = classes.find((c) => c.id === a.classId)
      if (k) byAssignment.set(a.id, k.students)
    }
    return (assignmentId: string) => byAssignment.get(assignmentId)
  }, [assignments, classes])
  const noOf = useCallback(
    (assignmentId: string, key: string) => displayNoOfArchiveKey(rosterOf(assignmentId), key),
    [rosterOf],
  )
  const nameOf = useCallback(
    (assignmentId: string, key: string) =>
      studentOfArchiveKey(rosterOf(assignmentId), key)?.name ?? '',
    [rosterOf],
  )

  /* ============================================================
     🆕 第二期：分区导航 + 四个新数据源（数据库用量 / 错误日志 / 反馈 / 维护）
     ------------------------------------------------------------
     ⚠️ 四条都是**只读**（维护那一条是"读状态"，写走它自己的按钮）；
        每一条都各有一个 `Err` 槽位 —— **"读不到"绝不能与"没有"共用一个状态**
        （本项目最贵的一条教训：拿不到 ≠ 正常）。
     ============================================================ */
  const [tab, setTab] = useState<AdminTab>('overview')
  /**
   * L0 上那一行"维护模式已开启 · 还剩 1h12m"要的是**和用户同一份**状态
   * （方案 §二.3 的防呆 4：'开了之后面板自己持续显示'——挡"忘了自己开着"）。
   * ⚠️ 这里用的是公开接口那一条路（`useMaintenanceStatus`），不是超管接口 ——
   *    两者在"是不是维护中"上必须同值；超管接口那份只用于**改**。
   */
  const maintLive = useMaintenanceStatus()

  const [db, setDb] = useState<DbReport | null>(null)
  const [dbErr, setDbErr] = useState('')
  const [errReport, setErrReport] = useState<ErrorsReport | null>(null)
  const [errErr, setErrErr] = useState('')
  const [fbReport, setFbReport] = useState<AdminFeedbackReport | null>(null)
  const [fbErr, setFbErr] = useState('')
  const [maint, setMaint] = useState<AdminMaintenanceState | null>(null)
  const [maintErr, setMaintErr] = useState('')
  /* 🆕 版本更新公告（两档；`null` = 读不到 —— 与"没在发"**绝不共用**一个状态） */
  const [rel, setRel] = useState<{ teacher: AdminReleaseSlot; classroom: AdminReleaseSlot } | null>(null)
  const [relErr, setRelErr] = useState('')
  const [opsBusy, setOpsBusy] = useState(false)

  /* 纯取数（**不 setState**）—— 与这块屏上 `fetchServer` 同一条口径 */
  const fetchOps = useCallback(async () => {
    const [d, e, f, m, r] = await Promise.all([
      fetchDbUsage(),
      adminListErrors(''),
      adminListFeedback(''),
      fetchMaintenanceAdminState(),
      fetchReleaseState(),
    ])
    return { d, e, f, m, r }
  }, [])

  const reloadOps = useCallback(() => {
    setOpsBusy(true)
    void fetchOps()
      .then(({ d, e, f, m, r }) => {
        stamp()
        if (d.ok) {
          setDb(d.report)
          setDbErr('')
        } else {
          setDb(null)
          setDbErr(d.message)
        }
        if (e.ok) {
          setErrReport(e.report)
          setErrErr('')
        } else {
          setErrReport(null)
          setErrErr(e.message)
        }
        if (f.ok) {
          setFbReport(f.report)
          setFbErr('')
        } else {
          setFbReport(null)
          setFbErr(f.message)
        }
        if (m.ok) {
          setMaint(m.state)
          setMaintErr('')
        } else {
          setMaint(null)
          setMaintErr(m.message)
        }
        if (r.ok) {
          setRel({ teacher: r.teacher, classroom: r.classroom })
          setRelErr('')
        } else {
          setRel(null)
          setRelErr(r.message)
        }
      })
      .finally(() => setOpsBusy(false))
  }, [fetchOps])

  useEffect(() => {
    if (!sessionChecked || !hasSession) return
    let alive = true
    void fetchOps().then(({ d, e, f, m, r }) => {
      if (!alive) return
      stamp()
      if (d.ok) setDb(d.report)
      else setDbErr(d.message)
      if (e.ok) setErrReport(e.report)
      else setErrErr(e.message)
      if (f.ok) setFbReport(f.report)
      else setFbErr(f.message)
      if (m.ok) setMaint(m.state)
      else setMaintErr(m.message)
      if (r.ok) setRel({ teacher: r.teacher, classroom: r.classroom })
      else setRelErr(r.message)
    })
    return () => {
      alive = false
    }
  }, [sessionChecked, hasSession, fetchOps])

  /* ---------------- 判据 ---------------- */

  const localMode = connectionMode() === 'local'

  /* A1：哈希与版本号是否自洽（**只做不需要对照物的那两半**） */
  const hashMissing = BUILD_HASH === null
  const versionDrift = useMemo(() => {
    if (!BUILD_HASH) return false
    try {
      const raw = localStorage.getItem('shugao.admin.build')
      const prev = raw ? (JSON.parse(raw) as { hash?: string; version?: string }) : null
      const drifted = Boolean(
        prev?.version && prev.version === APP_VERSION && prev.hash && prev.hash !== BUILD_HASH,
      )
      localStorage.setItem(
        'shugao.admin.build',
        JSON.stringify({ hash: BUILD_HASH, version: APP_VERSION }),
      )
      return drifted
    } catch {
      return false
    }
  }, [])

  /* B1 / B3 */
  const serverOk = server.kind === 'ok'
  const secretFacts: SecretFacts = {
    keys: serverOk ? (server.report.config?.keys ?? {}) : {},
    configured: serverOk,
  }
  const serviceKey = judgeServiceKey(secretFacts)
  const r2 = judgeR2(secretFacts)

  /* G2 */
  const b = serverOk ? server.report.backup : undefined
  const lastRun = b?.lastRun ?? null
  const lastSuccess = b?.lastSuccess ?? null
  const backupFacts: BackupFacts = {
    configured: Boolean(b?.configured),
    conclusion: lastRun?.conclusion ?? null,
    lastSuccessAgoMs: lastSuccess?.agoMs ?? null,
    lastRunAgoMs: lastRun?.agoMs ?? null,
    sizeBytes: b?.sizeBytes ?? null,
    degradedToArtifact: b?.degradedToArtifact === true,
    r2Keys: serverOk ? (server.report.config?.keys ?? null) : null,
  }
  const backup = judgeBackup(backupFacts)

  /* ---------------- 🆕 第二期的三条判据（数据库 / 错误日志 / 反馈） ---------------- */
  const dbFacts: DbFacts = {
    configured: db?.configured === true,
    totalBytes: db?.totalBytes ?? null,
    tables: db?.tables ?? [],
    questionMetaBytes: db?.questionMetaBytes ?? null,
    archives: db?.archives ?? [],
    unknownReason: dbErr || (db?.unknownReason ?? null),
  }
  const dbJudge = judgeDbUsage(dbFacts)

  /*
   * 🆕 出流量（Supabase Management API 那一份）。
   *
   * 🔴 **三态**：没配 / 读不到 → 灰；只有真拿到了才显示数字与颜色。
   *    `configured` 为 false 的两种情形必须分开说：服务端整个读不到（本地模式
   *    或 `/api/*` 没部署）vs 服务端在、但两个变量没配 —— 后者才是"去配一下就好"。
   */
  const eg = serverOk ? server.report.db?.egress : undefined
  const egressFacts: EgressFacts = {
    configured: eg?.configured === true,
    bytes: eg?.bytes ?? null,
    dbSizeBytes: eg?.dbSizeBytes ?? null,
    wholeDbBytes: db?.totalBytes ?? null,
    reason:
      eg?.reason ??
      (serverOk
        ? null
        : server.kind === 'not_configured'
          ? `服务端还没配置好：${server.message}`
          : '读不到服务端的 `all` 回话（本地模式 / 接口没部署）'),
    source: eg?.source ?? '',
    periodStart: eg?.periodStart ?? null,
    periodEnd: eg?.periodEnd ?? null,
  }
  const egressJudge = judgeEgress(egressFacts)

  const errFacts: ErrorFacts = {
    readable: errReport !== null,
    total: errReport?.total ?? null,
    last24h: errReport?.last24h ?? null,
    lastAt: errReport?.rows[0]?.at ?? null,
    lastView: errReport?.rows[0]?.view ?? '',
    unknownReason: errErr || null,
  }
  const errJudge = judgeErrorLog(errFacts)

  const fbFacts: FeedbackFacts = {
    readable: fbReport !== null,
    total: fbReport?.total ?? null,
    open: fbReport?.open ?? null,
    mailBad: fbReport?.mailBad ?? null,
    unknownReason: fbErr || null,
  }
  const fbJudge = judgeFeedback(fbFacts)

  /*
   * 🆕 最高管理员那一格（用户 2026-10-08：「超管锁死，只能有我一个」）。
   * 🔴 它**不是**"多 super 报警" —— 数据库那条部分唯一索引让"多"不可能。
   *    它防的是 **0 个**：一个都没有 = 谁也管不了平台，而且**不报错**。
   */
  const superJudge = judgeSuperAdminCount(superAdmins)

  /* C1 */
  const driftInfo = drift ? driftSummary(drift.sections) : null

  /* 各卡的颜色（红 > 黄 > 灰 > 绿；"不会出事"就不该红） */
  const toneDeploy: Tone = worstTone([
    localMode ? 'bad' : 'ok',
    hashMissing ? 'bad' : 'ok',
    versionDrift ? 'warn' : 'ok',
  ])
  const toneConfig: Tone = worstTone([serviceKey.tone, r2.tone])
  /*
   * 🔴 C1 的三态 → 颜色**只走 `driftTone()` 这一处**（`lib/adminChart.ts`）。
   *    以前这里内联了一串三元，虽然当时的映射是对的，但它把"灰 ≠ 红"这条不变量
   *    拆成了"渲染里的一份 + 判据里的另一份" —— 而 §20.7 那次误报的现场恰恰就是
   *    "卡片红着脸说 §12 未跑"，只看屏上根本分不清是判据错了还是颜色画错了。
   *    合成一个具名函数之后，`admin-checks` 第七节·补 断言的就是屏上用的那一份。
   */
  const toneSchema: Tone = driftInfo ? driftTone(driftInfo.state) : 'unknown'
  const toneData: Tone = !hydrated ? 'unknown' : contradictions.badCount > 0 ? 'bad' : 'ok'
  const toneBackup: Tone = backup.tone
  /*
   * 🆕 第二期的四条。⚠️ 它们与上面五条**同权**地进 `allTones`：
   *    "有没有人遇到问题而我不知道"（错误 / 反馈）与"有没有空间"（数据库）不该
   *    只躺在各自的标签页里 —— 概览的 L0 一句话就要把它们算进去。
   *  ⚠️ 维护**读不到**时给 'unknown'（灰），**不是绿**（I48 那条纪律的落地）。
   */
  const toneDb: Tone = dbJudge.tone
  const toneErrors: Tone = errJudge.tone
  const toneFeedback: Tone = fbJudge.tone
  const toneMaint: Tone = maintLive.read === 'failed' ? 'unknown' : maintLive.enabled ? 'warn' : 'ok'
  /*
   * 🆕 最高管理员那一格也进 `allTones`：**"0 个 super"必须让概览那句话说出口**，
   *    不能只躺在磁贴里（那正是"谁也管不了平台"最容易被漏掉的地方）。
   */
  const toneSuper: Tone = superJudge.tone
  /*
   * 🆕 「版本更新」那一张也进颜色汇总：它**有正在生效的公告**时是黄的 ——
   *    "有版本公告挂着"本来就该出现在概览那句话里（不然只能自己翻到「维护」那一栏）。
   *    ⚠️ 颜色只由 `releaseTone()` 一处算（卡自己调的是同一个函数，见那里的注释）。
   */
  const toneRelease: Tone = releaseTone(rel, relErr)

  const allTones = [toneDeploy, toneConfig, toneSchema, toneData, toneBackup, toneDb, toneErrors, toneFeedback, toneMaint, toneSuper, toneRelease]
  const toneAll = worstTone(allTones)
  /*
   * 🔴 **计数与清单同源**（2026-10-04 用户要求）。
   *
   * 以前这两个数是在 L0 那句话里**当场数的**（`allTones.filter(...)`），而"哪几项"
   * 只能靠人一张卡一张卡翻。现在只留**一份** `attentionAll`：
   *   · 顶部那个数字 = 从它数出来的（不是另数一遍 `allTones`）；
   *   · 展开后的清单 = 它自己滤出来的；
   *   · 每条卡自己的 `headline` = 同一个 `reason`（见下面每张卡的 `headline={…}`）。
   * ⚠️ 有一项（最高管理员）**没有单张卡**，它的结论只在磁贴 `sub` 上 —— 所以
   *    `reason` 也逐字取磁贴 `sub` 那一句，`anchor` 指那块磁贴。
   */
  /**
   * ⚠️⚠️ **这些 `xxxReason` 常量必须定义在 `attentionAll` 之前**。
   * 踩过的坑：写成 `cardReason('deploy')` 那种"查表"调用 → `attentionAll` 初始化到一半时
   * 去访问 `attentionAll` 自己 ⇒ `ReferenceError: Cannot access 'attentionAll' before initialization`
   * （TDZ），整屏变成"这一页出了点问题"。所以这里是**普通局部 const**，不是查表。
   */
  const deployReason = localMode
    ? '**本地模式** —— 平台上所有数据其实只在这台浏览器里'
    : hashMissing
      ? `${APP_VERSION_LABEL} —— **这是开发态或哈希取不到，线上出现就是构建异常**`
      : versionDrift
        ? '代码改了但没人改版本号（两个部署版本号一样、哈希不一样）'
        : '线上构建标识正常'
  const configReason =
    serviceKey.tone === 'bad'
      ? '`SUPABASE_SERVICE_ROLE_KEY` 未配置 → 建号 / 指派身份那两页会打不开'
      : r2.text
  const dataReason = !hydrated
    ? '数据还没就绪（hydrate 没成功）—— **无法判断**，不是"没有矛盾"'
    : contradictions.badCount
      ? `作业档案 ${contradictions.badCount} 份自相矛盾（扫了 ${contradictions.scanned} 份）`
      : `作业档案 ${contradictions.scanned} 份，内部一致`
  const maintReason = maintenanceHeadline(maint, maintErr)
  const releaseReason = releaseHeadline(rel, relErr)
  /* 这一项（最高管理员）**没有卡** —— 结论只在概览那块磁贴上，所以 `reason` 取的是磁贴那句 */
  const superReason =
    superAdmins.readable && superAdmins.count === 0
      ? '🔴 谁也管不了平台'
      : superAdmins.readable
        ? '全平台只留一个'
        : '无法判断（不是"有 1 个"）'

  const attentionAll: (AttentionItem & { anchor?: string })[] = [
    {
      key: 'deploy',
      tone: toneDeploy,
      title: '① 部署与版本',
      reason: deployReason,
      tab: null,
      pane: 'overview+health',
    },
    {
      key: 'config',
      tone: toneConfig,
      title: '② 配置完整性',
      reason: configReason,
      tab: null,
      pane: 'overview+health',
    },
    {
      key: 'backup',
      tone: toneBackup,
      title: '③ 备份（G2）',
      reason: backup.text,
      tab: null,
      pane: 'overview+health',
    },
    {
      key: 'schema',
      tone: toneSchema,
      title: '④ 数据库结构漂移（C1）',
      reason: driftInfo ? driftInfo.text : '正在探测…',
      tab: null,
      pane: 'overview+health',
    },
    {
      key: 'data',
      tone: toneData,
      title: '⑤ 作业档案内部矛盾（E7）',
      reason: dataReason,
      tab: null,
      pane: 'overview+health',
    },
    {
      key: 'db',
      tone: toneDb,
      title: '数据库使用情况',
      reason: dbJudge.text,
      tab: 'db',
      pane: 'db',
    },
    {
      key: 'maint',
      tone: toneMaint,
      title: '维护模式',
      reason: maintReason,
      tab: 'maintenance',
      pane: 'maintenance',
    },
    {
      key: 'release',
      tone: toneRelease,
      title: '版本更新',
      reason: releaseReason,
      tab: 'maintenance',
      pane: 'maintenance',
    },
    {
      key: 'errors',
      tone: toneErrors,
      title: '前端错误日志',
      reason: errJudge.text,
      tab: 'errors',
      pane: 'errors',
    },
    {
      key: 'feedback',
      tone: toneFeedback,
      title: '用户反馈',
      reason: fbJudge.text,
      tab: 'feedback',
      pane: 'feedback',
    },
    {
      /* ⚠️ 这一项**没有卡** —— 它的结论只写在概览那块磁贴上（所以 `anchor` 指磁贴） */
      key: 'super',
      tone: toneSuper,
      title: '超级管理员',
      reason: superReason,
      tab: null,
      pane: 'overview',
      anchor: 'super',
    },
  ]
  const badCount = attentionAll.filter((a) => a.tone === 'bad').length
  const warnCount = attentionAll.filter((a) => a.tone === 'warn').length
  const attentionItems: AttentionItem[] = attentionAll.filter(
    (a) => a.tone === 'bad' || a.tone === 'warn',
  )
  /**
   * 卡上那句 `headline` 就是清单里那一条的 `reason` —— **查一次、用两处**
   * （🔴 不许在卡上再写一遍措辞：那正是"同一句话被抄成两份、改一处漏一处"的来源）。
   * ⚠️ 它只能在 `attentionAll` **之后**定义，而且**绝不能**反过来被 `attentionAll` 调用
   *    （那会踩 TDZ —— 见上面那段说明）。
   */
  function cardReason(key: string): string {
    return attentionAll.find((a) => a.key === key)?.reason ?? ''
  }
  /*
   * 反向对照用的那一句：`attentionAll` 与 `allTones` **必须逐项对上** ——
   * 谁要是以后只补了 `allTones`（进颜色汇总）却忘了补清单，或者反过来，
   * 这里就是"计数与清单不再同源"的第一个露头处。
   */
  const toneCountsMatch =
    allTones.filter((t) => t === 'bad').length === badCount &&
    allTones.filter((t) => t === 'warn').length === warnCount
  void toneCountsMatch
  /**
   * 🔴 **灰（"量不到 / 没结论"）不算"要留意"**（三态纪律）——
   * 它**只**在清单末尾附一行"另有 N 项无法判断"，绝不混进黄红清单里，
   * 也不让上面那个数字带上它。
   */
  const unknownCount = allTones.filter((t) => t === 'unknown').length
  /**
   * 「看这一块」要**先切栏、再滚**（那一栏是 `hidden` 不是不渲染，滚的是同一个 DOM）。
   * 用一个 ref 记下目标：切换 tab 是异步的，等这一帧渲染完（`useEffect`）再滚。
   */
  const pendingScroll = useRef<string>('')
  useEffect(() => {
    const target = pendingScroll.current
    if (!target) return
    pendingScroll.current = ''
    cardEl(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [tab])
  const goToCard = (item: AttentionItem & { anchor?: string }) => {
    const target = item.anchor ?? item.title
    if (item.tab && item.tab !== tab) {
      pendingScroll.current = target
      setTab(item.tab)
      return
    }
    cardEl(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /* ---------------- 这台设备被标成教室端？ ----------------
   *
   * 这是**面板存在的第一个理由**（方案 §七 T6 / §九 W22）：`Guard` 会把"被标成教室端的设备"
   * 一律送去 `/login`，而 `/settings`（面板入口所在页）**也在 `Guard` 里** ——
   * 于是超管这台机器被锁住时，他连面板都进不去。
   *
   * 🔴 所以这里**只显示、不跳转**：`/admin` 是 `Guard` 之外的独立入口，
   *    未登录时页面内给一张登录卡；**已经在面板里、只是设备标记不对时，照样把体检结果拿出来**。
   *    （旧行为是"设备标记为教室端 → 一律只给登录卡"，那会把最该看到信息的人挡在门外。）
   */
  const lockedDevice = deviceRole() === 'classroom'
  const lockedReason =
    `这台设备被标记为教室端${deviceRoleAt() ? '（标记于 ' + agoText(deviceRoleAt(), now) + '）' : ''}，` +
    '所以教师端的每个页面（包括「我的」）都会把你送去登录页。' +
    '这个面板是独立入口、**不经过那道守卫** —— 你在这里看得到全部体检结果。'

  /* ---------------- 未登录（**不跳 /login**） ---------------- */
  if (!sessionChecked) {
    return (
      <Shell>
        <div className="p-8 text-center" style={{ fontSize: 13, color: 'var(--color-ink3)' }}>
          正在确认会话…
        </div>
      </Shell>
    )
  }
  if (!hasSession) {
    return (
      <Shell>
        <PanelLogin
          reason={lockedDevice ? lockedReason : '这个面板不在教师端的路由守卫里，所以它自己要求一次登录。'}
        />
      </Shell>
    )
  }
  if (!isRemote && accountKind === 'classroom') {
    return (
      <Shell>
        <PanelLogin reason="这个账号是教室端账号，不是最高管理员。" />
      </Shell>
    )
  }

  return (
    <AdminFrame
      tab={tab}
      setTab={setTab}
      busy={opsBusy}
      onReload={() => {
        /* 顶栏那个"刷新"= **把这一屏上所有取数动作都重跑一遍**（读、不写） */
        reloadServer()
        reloadDrift()
        reloadOps()
      }}
    >
      {/* ---------------- L0 健康条（**永远在最上面**，工具条正下方） ---------------- */}
      <div data-admin-l0={toneAll}>
        <div className="panel overflow-hidden">
          <div className="flex items-center gap-3 p-3.5">
            <Dot tone={toneAll} />
            <div className="min-w-0 flex-1">
              {/*
                🆕 2026-10-04（用户原话）：「我点一下概览里面要留意的，就把所有黄色或者红色
                状态的全部列出来呀，一个一个找有点麻烦」——那句话里的「N 项要留意」
                **整颗是可点的按钮**（原生 `button`：键盘 Tab / 回车都触发），点开在下面
                展开一份**汇总清单**；再点一次收起。

                🔴 数字与清单**同一份数据**（`AttentionBar` 里就一个 `items.length`）——
                见那个组件上面那段注释。
              */}
              <AttentionBar
                toneAll={toneAll}
                items={attentionItems}
                unknownCount={unknownCount}
                onGo={goToCard}
              />
              <div
                className="mt-0.5"
                style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}
              >
                {APP_VERSION_LABEL}（{hashMissing ? '哈希取不到' : '构建哈希已显示'}）· 备份{' '}
                {backup.text.replace(/^备份\s*/, '').slice(0, 26)} · 作业档案 {contradictions.scanned}{' '}
                份 · 错误 24h {errReport?.last24h ?? '读不到'} · 反馈待处理 {fbReport?.open ?? '读不到'}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconRefresh size={14} />}
              disabled={opsBusy}
              onClick={() => {
                reloadServer()
                reloadDrift()
                reloadOps()
              }}
            >
              重测
            </Button>
          </div>
          {/*
            🆕 维护模式那一行（方案 §二.3 的防呆 4）：**开了就常驻在 L0 上**。
            "忘了自己开着"是这个功能最现实的失败模式。
            ⚠️ 读不到时显示成**灰的"读不到"**，不是绿（I48）。
          */}
          <div
            className="flex items-start gap-2 px-3.5 py-2.5"
            data-admin-maint-line={maintLive.enabled ? 'on' : maintLive.read === 'failed' ? 'unknown' : 'off'}
            style={{
              background:
                maintLive.enabled
                  ? 'var(--color-warnsoft)'
                  : maintLive.read === 'failed'
                    ? 'var(--color-idlesoft)'
                    : 'transparent',
              borderTop: '1px solid var(--color-line)',
              color: maintLive.enabled ? 'var(--color-warnink)' : 'var(--color-ink3)',
              fontSize: 12.5,
              lineHeight: 1.7,
            }}
          >
            <IconSliders size={14} />
            <span className="flex-1">
              {maintLive.read === 'failed' ? (
                <>
                  维护状态：**读不到**（按未维护处理）—— {maintLive.reason}
                  <br />⚠️ 读不到**不是**"没在维护"：这一格永远是灰的（fail-open 的代价必须显式露出来）。
                </>
              ) : maintLive.enabled ? (
                <>
                  🔴 <b>维护模式已开启</b> —— {maintLive.message || MAINTENANCE_DEFAULT_MESSAGE}
                  {maintLive.until
                    ? `（自动关闭：${new Date(maintLive.until).toLocaleString('zh-CN')}）`
                    : ''}
                  <br />全校（含教室端大屏）已被切到维护画面；**这一页不受影响**（超管必须能把关掉）。
                </>
              ) : (
                <>维护模式：未开启（若要开，去左边「维护」那一栏 —— 开之前请先读那四条防呆）</>
              )}
            </span>
          </div>
          {localMode ? (
            <div
              className="flex items-start gap-2 px-3.5 py-2.5"
              style={{
                background: 'var(--color-badsoft)',
                borderTop: '1px solid var(--color-badline)',
                color: 'var(--color-badink)',
                fontSize: 13,
                lineHeight: 1.75,
              }}
              data-admin-local-warning
            >
              <IconAlert size={16} />
              <span className="flex-1">
                <b>本地模式 —— 所有数据只写在这台浏览器里，换台机器 / 清缓存就没了。</b>
                <br />
                老师照样能建班、能批改、能录入，**一个字都不报错**，只是数据进不了云端。线上出现这个状态
                = 构建时的 <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code> 丢了。
              </span>
            </div>
          ) : null}
          {lockedDevice ? (
            <div
              className="flex items-start gap-2 px-3.5 py-2.5"
              style={{
                background: 'var(--color-warnsoft)',
                borderTop: '1px solid var(--color-warnline)',
                color: 'var(--color-warnink)',
                fontSize: 12.5,
                lineHeight: 1.75,
              }}
              data-admin-locked-device
            >
              <IconInfo size={15} />
              <span className="flex-1">
                <b>这台设备被标成教室端</b> —— 教师端的每个页面（包括「我的」）都会把你送去登录页，
                所以**面板入口在那边看不到**。而这一页是独立入口、不经过 `Guard`，
                地址栏敲 <code>/admin</code> 就到。要恢复教师端：去登录页用教师密码登一次
                （登录会自动把角色改回教师端）。
              </span>
            </div>
          ) : null}
          {syncError ? (
            <div
              className="px-3.5 py-2.5"
              style={{
                background: 'var(--color-badsoft)',
                borderTop: '1px solid var(--color-badline)',
                color: 'var(--color-badink)',
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              当前同步错误（原文，别改写）：<code>{syncError}</code>
              <br />⚠️ 它只接得住"INSERT 违反 with check"那一类；**UPDATE / DELETE 被 `using`
              静默筛掉（0 行、无错误）它接不住** —— 那才是真正静默的一类。
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3" />

      {/* ============================================================
          「概览」那一栏：**先一排数字磁贴**（仪表盘），下面才是明细。
          用户原话："概览页 = 仪表盘：一排数字磁贴（大数字 + 标签 + 状态色），下面才是明细。"
          ============================================================ */}
      <div hidden={tab !== 'overview'} data-admin-pane="overview">
        <Tiles
          items={[
            {
              key: 'db',
              label: '数据库用量',
              value: dbJudge.pct === null ? '读不到' : `${dbJudge.pct.toFixed(1)}%`,
              sub:
                dbJudge.pct === null
                  ? '无法判断'
                  : `${humanBytes(dbFacts.totalBytes)} / ${humanBytes(DB_QUOTA_BYTES)}`,
              tone: toneDb,
            },
            {
              /* 🆕 2026-10-07：出流量（用户点名）—— 与库用量同一张账单，磁贴挨着放 */
              key: 'egress',
              label: '出流量',
              value: egressJudge.pct === null ? '读不到' : `${egressJudge.pct.toFixed(1)}%`,
              sub:
                egressFacts.bytes === null
                  ? '无法判断（不是"还有 5 GB"）'
                  : `${humanBytes(egressFacts.bytes)} / ${humanBytes(EGRESS_QUOTA_BYTES)}`,
              tone: egressJudge.tone,
            },
            {
              /*
               * 🆕 最高管理员（用户 2026-10-08：「超管锁死，只能有我一个」）。
               * 🔴 **不是报警，是健康检查**：数据库那条部分唯一索引让"多"不可能 ——
               *    这一格真正要暴露的是 **0 个**（谁也管不了平台，而且不报错）。
               * ⚠️ 读不到 = 灰（不是"有 1 个"，也不是"一个都没有"）。
               */
              key: 'super',
              label: '超级管理员',
              value: superAdmins.readable && superAdmins.count !== null ? String(superAdmins.count) : '读不到',
              sub:
                superAdmins.readable && superAdmins.count === 0
                  ? '🔴 谁也管不了平台'
                  : superAdmins.readable
                    ? '全平台只留一个'
                    : '无法判断（不是"有 1 个"）',
              tone: toneSuper,
              to: 'health',
            },
            {
              key: 'backup',
              label: '备份',
              value:
                backupFacts.lastSuccessAgoMs === null
                  ? '读不到'
                  : backupFacts.lastSuccessAgoMs >= 86_400_000
                    ? `${Math.floor(backupFacts.lastSuccessAgoMs / 86_400_000)} 天`
                    : `${Math.floor(backupFacts.lastSuccessAgoMs / 3_600_000)} 小时`,
              sub: backupFacts.lastSuccessAgoMs === null ? '无法判断（不是"备份正常"）' : '距上次成功',
              tone: toneBackup,
            },
            {
              key: 'health',
              /*
               * 🔴 2026-10-08：这一格原来叫「需要处理」——用户点名「把这个黄点消了，反正也配不了」。
               *    黄档里最典型的两项（R2 / Artifact 备份）是**永久且做不到的已知降级**，
               *    不是"等着你去处理"的待办 → 词改成「要留意」（口径见 `TONE_STYLE` 上面那段）。
               */
              label: '要留意',
              value: String(badCount + warnCount),
              sub: badCount ? `其中 ${badCount} 项异常` : '体检没结论的不算进来',
              tone: badCount ? 'bad' : warnCount ? 'warn' : toneAll === 'unknown' ? 'unknown' : 'ok',
            },
            {
              key: 'errors',
              label: '错误日志 24h',
              value: errReport?.last24h === null || errReport === null ? '读不到' : String(errFacts.last24h),
              sub: errErr ? '接口/表读不到' : `历史 ${errReport?.total ?? '?'} 条`,
              tone: toneErrors,
            },
            {
              key: 'feedback',
              label: '未读反馈',
              value: fbReport?.open === null || fbReport === null ? '读不到' : String(fbFacts.open),
              sub:
                fbReport && fbReport.mailBad
                  ? `⚠️ ${fbReport.mailBad} 条没发到邮箱`
                  : fbErr
                    ? '接口/表读不到'
                    : '未处理',
              tone: toneFeedback,
            },
            {
              key: 'maint',
              label: '维护模式',
              value: maintLive.read === 'failed' ? '读不到' : maintLive.enabled ? '维护中' : '未开启',
              sub: maintLive.enabled ? '全校被拦在门外' : maintLive.read === 'failed' ? '按未维护处理（灰）' : '正常',
              tone: toneMaint,
            },
            {
              key: 'version',
              label: '当前版本',
              value: APP_VERSION_LABEL,
              sub: BUILD_HASH ? `哈希 ${BUILD_HASH.slice(0, 8)}` : '哈希取不到（开发态）',
              tone: toneDeploy,
            },
          ]}
          tab={tab}
          setTab={setTab}
        />
        <div
          className="mb-3 p-3"
          style={{
            background: 'var(--color-surface2)',
            border: '1px solid var(--color-line)',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.85,
            color: 'var(--color-ink2)',
          }}
        >
          <b>这一页怎么读</b>：上面每块磁贴点一下就到对应的分区；左边那一列是分区导航。
          <br />· **绿 = 正常 · 黄 = 要留意（含已知降级）· 红 = 异常 · <span style={{ color: 'var(--color-ink3)' }}>灰 = 无法判断</span>**
          —— 灰**绝不是**绿：拿不到数据就是不画绿（本项目最贵的一条教训）。
          <br />· 黄里有几项是**已经接受的降级**（角标写着「降级中（已知）」）——
          它们的**代价**写在卡里（例：Artifact 备份 30 天后自动删除，要留档得手动下载）。
          那**不是待办**：R2 要绑国际银行卡，做不到就是做不到。
          <br />· 明细一律在分区里，**这一屏只放"要不要现在去看一眼"**。
        </div>
      </div>

      {/*
        「概览」与「健康」**共用这一块**（同一份 DOM，切标签只是显示 / 隐藏）：
        拆成两份会变成"同一件事两个渲染入口"，而这两栏要展示的本来就是同一批信息
        —— 概览 = 磁贴 + 这批卡的结论，健康 = 只留这批卡的明细。
      */}
      <div hidden={tab !== 'overview' && tab !== 'health'} data-admin-pane="overview+health">
        {/* ---------------- L1 分诊卡 ---------------- */}
        {server.kind === 'forbidden' ? (
          <Card
            tone="bad"
            title="权限判据：不是最高管理员"
            headline={server.message}
            note="判据在服务端（数据库的 is_super_admin()），不是前端藏了入口。"
          />
        ) : null}

        {/* ① 部署与版本（A1 / A3 / B4） */}
        <Card
          tone={toneDeploy}
          title="① 部署与版本"
          headline={cardReason('deploy')}
          note={`当前版本 ${APP_VERSION_LABEL}`}
        >
          <SubHead>线上跑的是哪一次构建</SubHead>
          <Line k="版本号" v={<code>{APP_VERSION}</code>} />
          <Line
            k="构建哈希"
            v={
              BUILD_HASH ? (
                <code>{BUILD_HASH}</code>
              ) : (
                <span style={{ color: 'var(--color-bad)' }}>取不到（开发态）</span>
              )
            }
          />
          <Line
            k="和 HEAD 对照"
            v={
              <span style={{ color: 'var(--color-ink3)' }}>
                未接（要 Cloudflare API token 或只读 GitHub token —— 方案里那是 A2，**第二期**）。
                现在能判的只有"哈希与版本号是否自洽"。
              </span>
            }
          />
          <SubHead>后端连接模式（A3 · 最危险的静默降级）</SubHead>
          <Line
            k="模式"
            v={
              localMode ? (
                <span style={{ color: 'var(--color-bad)', fontWeight: 600 }}>
                  本地模式（local）—— 数据只在这台浏览器里
                </span>
              ) : (
                <span style={{ color: 'var(--color-ok)', fontWeight: 600 }}>
                  云端模式（已连 Supabase）
                </span>
              )
            }
          />
          <Line k="接入地址" v={SUPABASE_URL ? <code>{SUPABASE_URL}</code> : '（空）'} />
          <Line
            k="有没有走中转"
            v={
              /\/api\/sb$/.test(SUPABASE_URL) ? (
                <span style={{ color: 'var(--color-ok)' }}>
                  已走自己的中转 /api/sb（国内不会被 SNI 阻断）
                </span>
              ) : /supabase\.co/i.test(SUPABASE_URL) ? (
                <span style={{ color: 'var(--color-bad)' }}>
                  **没走中转** —— 国内网络会被 SNI 阻断，前端所有请求会报 Failed to fetch
                  （很容易被误判成密码错或权限问题）
                </span>
              ) : (
                <span style={{ color: 'var(--color-ink3)' }}>本地开发地址，不适用</span>
              )
            }
          />
          <Line
            k="anon key"
            v={
              <span style={{ color: 'var(--color-ink3)' }}>
                绝不显示（虽然是公开的，但没有理由把它铺在屏上）
              </span>
            }
          />
          <HintOnly>
            面板**不能**替你去改环境变量、也**不能**重新部署。去 Cloudflare Pages → Settings →
            Environment variables 检查 <code>VITE_SUPABASE_URL</code> /{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>，然后 Retry deployment。
          </HintOnly>
        </Card>

        {/* ② 配置完整性（B1 / B3）
            🔴 `chipText`：黄的那一档是 **R2 四个都没配** —— 那是**已知 · 已接受**的降级，
               不是待办（用户 2026-10-08：「把这个黄点消了，反正也配不了」）。
               真要处理的是**半配置**（ENDPOINT/BUCKET 配了、key 没配），那一档照旧是红。 */}
        <Card
          tone={toneConfig}
          chipText={toneConfig === 'warn' ? '降级中（已知）' : undefined}
          title="② 配置完整性"
          headline={cardReason('config')}
          note={
            server.kind === 'not_configured'
              ? server.message
              : server.kind === 'error'
                ? server.message
                : undefined
          }
        >
          <SubHead>账号服务（B1）</SubHead>
          <Line
            k="SERVICE_ROLE_KEY"
            v={serverOk ? (secretFacts.keys.SUPABASE_SERVICE_ROLE_KEY ? '在' : '不在') : '无法判断'}
          />
          <Line k="影响面" v={serviceKey.notes[0] ?? '——'} />
          <Line
            k="RESEND_API_KEY"
            v={
              serverOk ? (
                secretFacts.keys.RESEND_API_KEY ? (
                  <span>
                    在（<b>尚未接入代码</b>：全仓没有一处引用它，所以"在"不等于"邮件功能正常"）
                  </span>
                ) : (
                  <span style={{ color: 'var(--color-warn)' }}>
                    不在 —— 影响：将来的邮件通知（**当前无代码引用，不影响任何现有功能**）
                  </span>
                )
              ) : (
                '无法判断'
              )
            }
          />
          <SubHead>R2 四个 secret（B3，全部只回"在 / 不在"）</SubHead>
          {R2_KEYS.map((k) => (
            <Line key={k} k={k} v={serverOk ? (secretFacts.keys[k] ? '在' : '不在') : '无法判断'} />
          ))}
          <Line k="判据" v={r2.text} />
          {[...serviceKey.notes.slice(1), ...r2.notes].map((n, i) => (
            <div
              key={i}
              className="px-3.5 py-1.5"
              style={{
                borderBottom: '1px solid var(--color-line)',
                fontSize: 12,
                color: 'var(--color-ink2)',
                lineHeight: 1.75,
              }}
            >
              · {n}
            </div>
          ))}
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
          >
            ⚠️ 按 `keepalive.yml:55-57` 与 `backup.yml:45-49` 的纪律：这里**只回"在 / 不在"**，
            **绝不回值、也绝不回长度**。
          </div>
          <HintOnly>
            改 secret 只能在 Cloudflare 控制台做 —— 面板**不给按钮**（那是运维动作，点一下修不好）。
          </HintOnly>
        </Card>

        {/* ③ 备份与外部依赖（G2 · 第一期最该先做的一条）
            🔴 `chipText`：Artifact 降级那一档是**已知 · 已接受**（R2 要绑国际银行卡，做不到）。
               ⚠️ 角标下方那行「最近一次运行」**照旧保留** —— 那是功能性的，与口径无关。 */}
        <Card
          tone={toneBackup}
          chipText={toneBackup === 'warn' ? '降级中（已知）' : undefined}
          title="③ 备份（G2）"
          headline={cardReason('backup')}
          note={
            lastRun
              ? `最近一次运行：${lastRun.conclusion ?? '结论未知'} · ${agoText(
                  lastRun.agoMs === null ? null : now - lastRun.agoMs,
                )}${lastRun.event === 'workflow_dispatch' ? ' · 手动触发' : ''}`
              : undefined
          }
        >
          <SubHead>最近一次运行</SubHead>
          <Line k="结论" v={lastRun?.conclusion ?? '拿不到'} />
          <Line
            k="时间"
            v={
              lastRun?.agoMs === null || lastRun?.agoMs === undefined
                ? '拿不到'
                : agoText(now - lastRun.agoMs)
            }
          />
          <Line
            k="最近一次成功"
            v={
              lastSuccess?.agoMs === null || lastSuccess?.agoMs === undefined
                ? '拿不到'
                : agoText(now - lastSuccess.agoMs)
            }
          />
          <SubHead>最新备份大小（**只看成功/失败抓不住这个坑**）</SubHead>
          <Line
            k="字节数"
            v={
              b?.sizeBytes === null || b?.sizeBytes === undefined ? (
                <span style={{ color: 'var(--color-warn)' }}>
                  捞不到{b?.sizeUnknownReason ? `（${b.sizeUnknownReason}）` : ''} ——
                  **认不出不等于通过**
                </span>
              ) : (
                <span className="num">
                  {humanBytes(b.sizeBytes)}（{b.sizeBytes} 字节）
                </span>
              )
            }
          />
          {/*
           * 「最近一次成功的运行」那一行也**无条件保留**（哪怕当时没捞到）。
           * 理由：写"备份 无法判断"的时候，人第一眼要问的是"**为什么**无法判断" ——
           * 是没配 token、是最近 5 次全失败、还是日志里没有那一行。
           * 少了这一行，卡片就只剩一句没有依据的"无法判断"。
           */}
          <Line
            k="服务端回话"
            v={
              b ? (
                <span>
                  最近一次成功{' '}
                  {lastSuccess?.agoMs === null || lastSuccess?.agoMs === undefined
                    ? '拿不到'
                    : agoText(now - lastSuccess.agoMs)}
                  {b.sizeUnknownReason ? ` · 字节数捞不到的原因：${b.sizeUnknownReason}` : ''}
                </span>
              ) : (
                <span style={{ color: 'var(--color-ink3)' }}>
                  拿不到（本地模式 / 服务端没配 <code>GITHUB_TOKEN</code> + <code>GITHUB_REPO</code>）
                </span>
              )
            }
          />
          <Line
            k="为什么非要它"
            v={
              <span style={{ fontSize: 12, lineHeight: 1.75 }}>
                `backup.yml:9-11` 留档过一个真会丢备份的坑：旧写法
                `pg_dump … | gzip -9 &gt; f.gz` 里 <code>$?</code> 拿到的是 **gzip 的退出码**，
                pg_dump 挂了会被吞掉，**留下一个「合法但空」的 .gz，工作流还显示绿灯**。
                所以小于 50 KB 要红。
              </span>
            }
          />
          {(b?.signals ?? []).length ? (
            <>
              <SubHead>日志里的关键诊断行</SubHead>
              {(b?.signals ?? []).map((s, i) => (
                <div
                  key={i}
                  className="px-3.5 py-1.5"
                  style={{
                    borderBottom: '1px solid var(--color-line)',
                    fontSize: 12,
                    color: 'var(--color-ink2)',
                  }}
                >
                  · {s}
                </div>
              ))}
            </>
          ) : null}
          {backup.notes.map((n, i) => (
            <div
              key={i}
              className="px-3.5 py-1.5"
              style={{
                borderBottom: '1px solid var(--color-line)',
                fontSize: 12,
                color: 'var(--color-ink2)',
                lineHeight: 1.75,
              }}
            >
              · {n}
            </div>
          ))}
          <Line
            k="R2 上有几份"
            v={
              <span style={{ color: 'var(--color-ink3)' }}>
                无法判断 —— anon key 够不着 R2（它是 Cloudflare 账号级的、不经过 Supabase），
                而列对象要 S3 凭据。第一期**不做**（方案 §四 把这条标成"要 R2 凭据"）。
              </span>
            }
          />
          {/*
            ============================================================
            🆕 2026-10-04 · ①「整库备份」引导档（用户这一条的原话）：
              「面板里写清**整库备份的真实位置与怎么恢复**」。
            ------------------------------------------------------------
            🔴 **照实写，不许编一个不存在的"云端备份"**。2026-10-04 查实的三件事：
              ① `backup.yml` 每天北京 02:30 跑 `pg_dump → gzip → AES-256 → R2`；
              ② R2 短期开通不了（要绑国际银行卡）⇒ **今天真正的备份落在 GitHub Actions
                 的 Artifact**：保留 30 天、要登录 GitHub 才能下载、这一屏拿不到那个文件；
              ③ 拉回本机是超管在**打包机**上双击 `_tools\拉取整库备份.cmd`
                 （落到 `树高教务通打包\整库备份\`、只留 30 份、不解密），恢复也在打包机上人工做。
            🔴 「恢复前先在打包机导一份当前库」这句**必须在**（用户 ④：不可逆操作先留退路）。
            🔴 钥匙**不进面板**（用户 ③）：整库口令与档案私钥都留在超管手上 ——
               所以这一块只有"读"，**没有任何口令 / 私钥的输入框或上传口**。
            ⚠️ 这块东西住在「③ 备份（G2）」卡**点开之后**的明细里（方案 §3.4 第 1 条：
               L1 卡上不放明细）—— 回归脚本按 `[data-admin-toggle]` 先点开再读。
            ============================================================
          */}
          <SubHead>整库备份在哪 · 怎么拉回来 · 怎么恢复</SubHead>
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 12.5, lineHeight: 1.85, color: 'var(--color-ink2)' }}
          >
            <b>
              <code>backup.yml</code> 每天北京 02:30 在 GitHub 的机器上跑一次
            </b>
            ：<code>pg_dump</code> → <code>gzip</code> → AES-256 加密 → 传 R2。
            <br />
            R2 是原定的云端位置，
            <b>短期开通不了（要绑国际银行卡）</b>
            ⇒ 今天真正的备份落在 <b>GitHub Actions 的 Artifact</b>：
            <b>保留 30 天</b>（过期自动删除），而且要<b>登录 GitHub 才能下载</b> ——
            这一屏拿不到那个文件。
          </div>
          <Line
            k="拉回本机"
            v={
              <span style={{ fontSize: 12, lineHeight: 1.75 }}>
                超管在<b>打包机</b>上双击 <code>_tools\拉取整库备份.cmd</code>：把 Artifact
                拉到 <code>树高教务通打包\整库备份\</code>，<b>只留最近 30 份</b>，<b>不解密</b>。
              </span>
            }
          />
          <Line
            k="怎么恢复"
            v={
              <span style={{ fontSize: 12, lineHeight: 1.75 }}>
                <b>在打包机上人工做</b>（这一屏点不了）。
                🔴 <b>恢复前先在打包机导一份当前库</b> —— 恢复不可逆，先把退路留下。
              </span>
            }
          />
          <Line
            k="钥匙"
            v={
              <span style={{ fontSize: 12, lineHeight: 1.75 }}>
                解它要的整库口令（<code>BACKUP_ENCRYPTION_PASSPHRASE</code>）与档案私钥都在
                <b>超管手上</b> —— 这一屏只读状态，<b>不收口令、不收私钥</b>。
              </span>
            }
          />

          <HintOnly>
            前端拿不到 R2 里的备份文件，所以**不给"立刻下载备份"**（硬做只会做成一个坏掉的按钮）。
            手动触发：GitHub → Actions → backup → Run workflow。
          </HintOnly>

          {/*
            ============================================================
            🆕 2026-10-04 · ②「备份到云端」那颗**搬进面板并改成如实的名字**。
            ------------------------------------------------------------
            🔴 名字：**「导出本机备份并发一封通知邮件」**（唯一实现在
               `components/BackupExtraActions.tsx`，这里只摆它、**不许写第二份**）。
            🔴 为什么必须改名（查实的事实，别再叫回"云端"）：它**不上传任何文件** ——
               只导出本机明文 JSON，再经 `/api/mail {action:'backup'}`
               （`functions/api/mail.ts`）给超管**发一封通知邮件**。
            ⚠️ 这一块里**没有**任何口令 / 私钥的输入框或上传口（用户 ③）：
               整库口令与档案私钥都留在超管手上，面板只读状态。
            ============================================================
          */}
          <SubHead>本机导出与通知（全平台那一层）</SubHead>
          <div className="px-3.5 pt-1 pb-2">
            <BackupExtraActions />
          </div>
          <div
            className="px-3.5 pb-3"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            这一颗只把本机这一份存到这台设备上，再给超管发一封通知邮件 —— 它不上传任何东西；
            整库那一份走上面那条链。
          </div>
        </Card>

        {/* ④ 数据库结构（C1 + C2）
            ⚠️ `agoText(at, now)`：第一个参数是**时刻**，第二个才是"现在"。
            曾经写成 `agoText(now - drift.at)` —— 而 `drift.at` 与 `now` 常常是同一个毫秒
            （`probeSchemaDrift()` 里 `at: Date.now()` 与 `stamp()` 只隔一个微任务），
            差 = 0 → `!at` → **恒显示「探测于 未知」**；差几毫秒则显示成"20000 多天前"。
            那句"未知"会把人骗去查"那次探测是不是没拿到结论"（§20.7 的误报留档）。 */}
        <Card
          tone={toneSchema}
          title="④ 数据库结构漂移（C1）"
          headline={cardReason('schema')}
          note={
            drift
              ? `探测于 ${agoText(drift.at, now)}（刷新即重探）` +
                (driftInfo
                  ? ` · 共 ${driftInfo.executableCount} 段可执行（登记节 ${driftInfo.registry.length} 段 · 面板探不到 ${driftInfo.unprobeable.length} 段）`
                  : '')
              : undefined
          }
          openLabel="看逐段总表"
        >
          {/*
            🔴 **总结论**（用户真正要的那个数：「我们都更新到多少了」）。
            ⚠️ 本地模式 / 断网时**给不出**这个数 —— 那就明写"给不出来"，
               **绝不许**拿 `schema.sql` 的最后一段冒充"线上库跑到了那里"（那是假绿）。
            它挂 `data-admin-c1-conclusion` 是为了让回归脚本按**结构**找它（不按文案）。
          */}
          <div
            data-admin-c1-conclusion
            className="px-3.5 py-2"
            style={{
              fontSize: 12.5,
              fontWeight: 620,
              lineHeight: 1.8,
              color: driftInfo?.latest ? 'var(--color-ink)' : 'var(--color-ink3)',
            }}
          >
            {driftInfo
              ? driftInfo.latest !== null
                ? `线上的库已跑到 §${driftInfo.latest} · 共 ${driftInfo.executableCount} 段可执行`
                : `给不出总结论 —— 一段都没探到（本地模式 / 断网？）；登记节 ${driftInfo.registry.length} 段不计入`
              : '正在探测…'}
          </div>
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            🔴 **段清单是从 <code>supabase/schema.sql</code> 自动生成的**（跑{' '}
            <code>node scripts/admin-checks.mjs --gen-stages</code> 更新）——
            段号、标题、行号、探针都跟着文件走，**不会再出现"手写死一段、只列到 §19"**。
            <br />
            判据全部走**调用者自己的会话**（表看 <code>42P01</code>/<code>PGRST205</code>、列看{' '}
            <code>42703</code>、函数看裸版 RPC，**策略**（🆕 2026-10-11）看{' '}
            <code>pg_policies</code>），**没有为了"看得全"而绕开 RLS**。
            <br />
            ⚠️ **策略探针要看库肯不肯答**：PostgREST 默认只暴露 <code>public</code>，读不到{' '}
            <code>pg_catalog.pg_policies</code> 时，"只加策略"的段**如实留在「面板探不到」**——
            绝不拿"它落在那张表上"冒充"它跑过了"。
            <br />⚠️ **三档要分清**（这正是以前看不懂的原因）：
            <b>登记节</b> = 0 行可执行 SQL（没东西可跑，也没东西可探）；
            <b>面板探不到</b> = 有东西可跑、但 anon 会话探不到（**不是"没跑"**）；
            <b>无法判断</b>（灰）= 探了、没结论 —— **灰绝不是绿**。
          </div>
          {(drift?.sections ?? []).map((s) => (
            <div key={s.stage} style={{ borderTop: '1px solid var(--color-line)' }}>
              <div className="flex items-start gap-2.5 px-3.5 py-2">
                <span style={{ paddingTop: 5 }}>
                  {/*
                   * 🔴 **登记节不画点**（用户 2026-10-08：「"登记节"要单独标出来，别和"没跑"混在一起」）：
                   *    它既不是"已跑"也不是"无法判断"，所以既不给绿点也不给灰点 ——
                   *    改用一枚中性角标。三态那三档才有点（灰 ≠ 红，仍然由 `driftTone` 一处决定）。
                   */}
                  {s.kind === 'registry' ? (
                    <span className="tag tag-idle" style={{ fontSize: 10.5 }}>
                      登记
                    </span>
                  ) : (
                    <Dot tone={driftTone(s.state)} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: 13, fontWeight: 620 }}>
                    {s.stage}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--color-ink3)' }}>
                      {s.kind === 'registry'
                        ? '登记节（0 行可执行 SQL · 不需要探）'
                        : s.cells.length === 0
                          ? '面板探不到（不是没跑）'
                          : s.state === 'present'
                            ? '已跑'
                            : s.state === 'missing'
                              ? '未跑'
                              : '无法判断'}
                    </span>
                    {s.title ? (
                      <span style={{ fontWeight: 400, color: 'var(--color-ink4)', fontSize: 12 }}>
                        {' '}
                        · {s.title}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-ink2)', lineHeight: 1.7 }}>
                    {s.built}
                  </div>
                  {s.state === 'missing' ? (
                    <div style={{ fontSize: 12, color: 'var(--color-bad)', lineHeight: 1.7 }}>
                      影响：{s.impact}
                      <br />
                      修法：{s.fix}
                      <br />⚠️ 这一段**依赖前面各段**，别只跑后半段（整份文件里有 7 处"后段重定义前段"）。
                    </div>
                  ) : null}
                  {s.state === 'indeterminate' ? (
                    <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                      {s.cells.length
                        ? '探测本身没有结论（网络 / 权限错误）—— '
                        : '这一段的产物 anon 会话根本探不到 —— '}
                      {NO_PROBE_REASON[s.stage] ?? s.noProbe ?? ''}
                    </div>
                  ) : null}
                  {s.kind === 'registry' ? (
                    <div style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}>
                      {NO_PROBE_REASON[s.stage] ??
                        '这一段**没有可执行 SQL**（整段都是说明 / 登记）—— 没有东西可跑，也就没有"跑没跑"。'}
                    </div>
                  ) : null}
                  <div
                    className="mt-1"
                    style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.7 }}
                  >
                    {s.cells.length
                      ? s.cells
                          .map(
                            (c) =>
                              `${c.what}：${
                                c.state === 'present'
                                  ? '在'
                                  : c.state === 'missing'
                                    ? '不在'
                                    : '无法判断'
                              }`,
                          )
                          .join(' · ')
                      : s.kind === 'registry'
                        ? '（0 行可执行 SQL —— 这一节没有可探的对象）'
                        : '（这一段只加策略 / 带参数的函数 —— 策略只在 `pg_policies` 里，' +
                          'PostgREST 默认只暴露 `public` 读不到它；带参数的函数要伪造实参。' +
                          '**两种都不是"没跑"**）'}
                    <br />
                    出处：{s.anchor}
                  </div>
                </div>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-2 px-3.5 py-3">
            <Button
              size="sm"
              icon={<IconRefresh size={14} />}
              disabled={driftBusy}
              onClick={reloadDrift}
            >
              {driftBusy ? '正在重探…' : '重新探测'}
            </Button>
            <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
              只重探，**不写任何东西**
            </span>
          </div>

          <SubHead>C2 · 前端探测的汇总（它自己以为哪些列/表在）</SubHead>
          {probes.items.map((p) => (
            <Line
              key={p.key}
              k={p.label}
              v={
                <span>
                  <span
                    style={{
                      color:
                        p.state === 'present'
                          ? 'var(--color-ok)'
                          : p.state === 'missing'
                            ? 'var(--color-bad)'
                            : /*
                               * 🔴 「认不出」这一档是**灰**，不是黄、更不是红：
                               *    三态里"没结论"绝不能染成红（`AGENTS.md` §三.4 的硬不变量）。
                               *    它以前借用了 `--color-warn`，"没结论"看着像"要留意"—— 改回灰。
                               */
                              'var(--color-idle)',
                      fontWeight: 600,
                    }}
                  >
                    {p.state === 'present' ? '在' : p.state === 'missing' ? '不在' : '认不出（灰·没结论）'}
                  </span>{' '}
                  <code style={{ fontSize: 11.5 }}>{p.target}</code>{' '}
                  <span style={{ color: 'var(--color-ink4)', fontSize: 11.5 }}>
                    {p.at ? agoText(p.at, now) : '本次会话还没探过'}
                  </span>
                  {p.note ? (
                    <span style={{ color: 'var(--color-ink4)', fontSize: 11 }}>
                      {' '}
                      · {p.note}
                    </span>
                  ) : null}
                </span>
              }
            />
          ))}
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            考试表那一个的**真实探针状态**是 <code>{examProbe}</code>
            （`indeterminate` = 探测本身没结论，而项目纪律是"一律当作有" —— 所以那个结果
            **不可信**，面板上必须显式标出来）。
            <br />🆕 **「文件归属列」这一格以前不在汇总里** —— 因为它当时**没有对外的只读
            getter**（`ensureFileClassCols()` 只回 <code>{'{ classIds }'}</code>，而"探测没结论"
            被兜底成了 <code>true</code>，屏上"列在"与"没问出来"长得一模一样）。
            现在 <code>lib/files.ts</code> 补了 <code>getFileClassColsStatus()</code> /
            <code>getFileClassColsProbeAt()</code>（只读、不改任何缓存语义），所以它进来了。
          </div>
        </Card>

        {/* ⑤ 数据可信度（E7） */}
        <Card
          tone={toneData}
          title="⑤ 作业档案内部矛盾（E7）"
          headline={cardReason('data')}
          note="🟢 纯前端计算，**零额外请求**"
          openLabel="看矛盾清单"
        >
          {!hydrated ? (
            <div className="px-3.5 py-3" style={{ fontSize: 12.5, lineHeight: 1.75 }}>
              这一页的数据来自教师端的 store。它现在**没有 hydrate 成功**，所以查不出矛盾 ——
              但"查不出"**不等于**"没有矛盾"。
              {syncError ? (
                <>
                  <br />
                  当前 <code>syncError</code>：<code>{syncError}</code>
                </>
              ) : null}
            </div>
          ) : (
            <>
              <PrivacyLine />
              <div
                className="px-3.5 pb-2"
                style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
              >
                五类检查逐条对应 `功能设计与不变量.md` §十 里那五条"**看起来很正常**"的错数据：
                未交∩已批改 / 未交∩改错名单 / `correctedNos` 孤儿 / `collected` 假真 /
                极简模式伪题数。**不给自动修复** —— 这五条的修法都涉及"哪个字段说了算"，
                自动修必然猜错。
              </div>
              <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2">
                {contradictions.groups.map((g) => (
                  <span key={g.kind} className={g.details.length ? 'tag tag-bad' : 'tag tag-idle'}>
                    {g.label} {g.details.length ? `· ${g.details.length}` : '· 0'}
                  </span>
                ))}
              </div>
              {dirty.length === 0 ? (
                <div className="flex items-center gap-2 px-3.5 py-2" style={{ fontSize: 12.5 }}>
                  <IconCheck size={15} /> 五类检查都没有命中（扫了 {contradictions.scanned} 份档案）
                </div>
              ) : (
                dirty.map((g) => (
                  <div key={g.kind} style={{ borderTop: '1px solid var(--color-line)' }}>
                    <SubHead>
                      {g.label} · {g.assignments} 份档案 · {g.hits} 人·次
                    </SubHead>
                    {g.details.map((d, i) => (
                      <div
                        key={i}
                        className="px-3.5 py-2"
                        style={{ borderTop: '1px solid var(--color-line)' }}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {d.title}
                          <span style={{ fontWeight: 400, color: 'var(--color-ink3)' }}>
                            {d.className ? ` · ${d.className}` : ''}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--color-bad)', lineHeight: 1.7 }}>
                          {d.detail}
                        </div>
                        <div
                          style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
                        >
                          {d.why}
                        </div>
                        {d.studentNos.length || d.extra ? (
                          <div className="mt-1" style={{ fontSize: 11.5 }}>
                            <span className="num" data-admin-nos>
                              {/* 键 → **班内学号**（序列号永远不给人看：老师看到的东西不变） */}
                              {d.studentNos.map((k) => noOf(d.assignmentId, k)).join('、')}
                              {d.extra ? ` …另 ${d.extra} 人` : ''}
                            </span>
                            {showNames ? (
                              /*
                               * `data-admin-names` 是给回归脚本读的钩子（`shots.mjs` 那一条断言）——
                               * 光靠"屏上出现了姓名"去匹配太脆（换一份演示数据就红），
                               * 而这个属性的存在本身就说明"姓名这一层被显式打开了"。
                               */
                              <span data-admin-names style={{ color: 'var(--color-ink3)' }}>
                                {' — '}
                                {d.studentNos
                                  .map((k) => nameOf(d.assignmentId, k))
                                  .filter(Boolean)
                                  .join('、')}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="mt-1"
                          style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
                          onClick={() => navigate(`/assignments/${d.assignmentId}/grade`)}
                        >
                          去这份档案 →
                        </button>
                      </div>
                    ))}
                  </div>
                ))
              )}
              <div className="flex items-center gap-2 px-3.5 py-3">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={showNames ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  onClick={() => setShowNames((v) => !v)}
                >
                  {showNames ? '隐藏姓名' : '显示姓名'}
                </Button>
                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  默认只显示**学号**（学号即身份）；姓名要显式点开，且排在最后
                </span>
              </div>
            </>
          )}
        </Card>

        {/* 入口与边界说明 */}
        <Card
          tone="unknown"
          title="这块屏的边界（读一次，免得做错事）"
          headline="面板只回答「平台自己好不好」，不回答「学校该怎么办学」"
          openLabel="展开"
        >
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 12, lineHeight: 1.85, color: 'var(--color-ink2)' }}
          >
            · **入口与判据**：`/admin` 独立入口，**不被 `Guard` 拦**（被标成教室端的机器也进得来）；
            权限判据在服务端 —— `POST /api/admin/config-check` 拿你的 JWT 去问数据库的
            `is_super_admin()`，**不是** `can_manage_teachers()`（那个含教导处）。
            <br />· **不做的事**：建班 / 加学生 / 建号 / 指派身份 / 排课 / 改成绩 —— 一件都不做，
            也不给按钮（同一件事两个入口是本仓库出过四次的坑）。
            <br />· **写操作只有三处**（都走服务端 + 判据 `is_super_admin()` + 操作留痕）：
            开 / 关维护模式、删前端错误日志、标记反馈已处理。**其余一律只读。**
            <br />· **隐私三级**：聚合计数直接显示；能定位到人但不含内容的**默认只给计数、
            点开才看、学号在前姓名最后**；**教学内容与成绩一律不显示**（连均分 / 最高分都没有
            —— 这块屏里根本没有那些字段）。"谁看了什么"不做，明细里固定一行"请勿投屏或截图"。
            <br />· **本机 vs 线上**：设备角色 / 登录有效期这些**只对这台机器有效**，
            面板上看不到别人机器的状态。
          </div>
          <div
            className="px-3.5 pb-3"
            style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.8 }}
          >
            当前这台机器：身份标记 <code>{deviceRole()}</code>
            {deviceRoleAt() ? `（标记于 ${agoText(deviceRoleAt(), now)}）` : ''} ·
            登录有效期还剩 <code>{authDaysLeft()}</code> 天 · 会话{' '}
            <code>{isRemote ? '云端' : '本地'}</code> · 我的身份{' '}
            <code>
              {isSuperAdmin(myRoles)
                ? '含 super'
                : '未读到 super（角色表读不到时会这样，此时判据仍在服务端）'}
            </code>
          </div>
        </Card>

        {/* ⑥ 档案解密（只有超管能开）。
            ⚠️ 放在「这块屏的边界」**之后**：它是一条**动作**卡，不属于那五条
            "平台自己好不好"的指标，也不参与 `index.css` 那套 `[data-tone]`。
            ⚠️ 标题前缀用 ⑥，与公告分区的「⑥ 全站公告」**不在同一个分区**，
               `[data-admin-toggle="…"]` 是按整串标题找的，不会互相撞。 */}
        <SealDecryptCard />

        <div
          className="flex items-center gap-2 px-1 pb-2"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <IconWifi size={13} />
          <span>
            数据来源：本机会话 + `/api/admin/config-check` + `/api/admin/maintenance` +
            `/api/admin/errors` + `/api/feedback` + `schema.sql` 存在性探测 + 教师端 store。
            拿不到的**如实写"无法判断"**，绝不画绿。
          </span>
        </div>
      </div>

      {/* ============================================================
          其余六个分区：**一次只显示一个**（`hidden` 而不是条件渲染 ——
          这样"某个分区里的东西被谁不小心挪进另一个分区"这种改动会立刻在
          截图断言里露出来；而条件渲染会让"没渲染"与"渲染了但空"看起来一样）。
          ============================================================ */}
      <div hidden={tab !== 'db'} data-admin-pane="db">
        <DbCard
          report={db}
          error={dbErr}
          judge={dbJudge}
          egressFacts={egressFacts}
          egressJudge={egressJudge}
          now={now}
          /* 🔴 卡上那句话 = L0 清单里那一条的 `reason`（同一份数据，见 `attentionAll`） */
          headline={cardReason('db')}
        />
      </div>
      <div hidden={tab !== 'announce'} data-admin-pane="announce">
        <AnnounceCard />
      </div>
      <div hidden={tab !== 'maintenance'} data-admin-pane="maintenance">
        <MaintenanceCard
          state={maint}
          error={maintErr}
          live={maintLive}
          now={now}
          onReload={reloadOps}
          busy={opsBusy}
        />
        {/*
          🆕 版本更新公告那一张（2026-10-04，施工单 §二.6：**维护卡旁边**加一张）。
          ⚠️ 两档（教师端 / 教室端）**各发各的** —— 一次发布只动一档。
          ⚠️ 它与维护**不是**一个开关（施工单 §四）：维护是"全站停"，这里是"版本落后"。
        */}
        <ReleaseCard
          slots={rel}
          error={relErr}
          live={maintLive}
          onReload={reloadOps}
          busy={opsBusy}
        />
      </div>
      <div hidden={tab !== 'errors'} data-admin-pane="errors">
        <ErrorsCard
          report={errReport}
          error={errErr}
          judge={errJudge}
          now={now}
          onReload={reloadOps}
          busy={opsBusy}
          headline={cardReason('errors')}
        />
      </div>
      <div hidden={tab !== 'feedback'} data-admin-pane="feedback">
        <FeedbackCard
          report={fbReport}
          error={fbErr}
          judge={fbJudge}
          now={now}
          onReload={reloadOps}
          busy={opsBusy}
          headline={cardReason('feedback')}
        />
      </div>
    </AdminFrame>
  )
}

/* ============================================================
   面板自己的外壳 —— **不套 `AppShell`**。
 *
 * 理由见文件头：`AppShell` 只在 `Guard` 通过后才渲染，而这块屏的生命周期里
 * 最要紧的那一刻恰恰是"Guard 不让人进"的时候。所以它自带一个最小外壳。
 */
function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  return (
    <div className="min-h-full">
      <header
        className="sticky top-0 z-30 flex items-center gap-3 px-4"
        style={{
          height: 52,
          /*
           * 🔴 同 `components/ui.tsx:204`：`color-mix()` 要 Chrome 111，老 WebView
           * 认不出 → **整条 `background` 被丢** → 这个 sticky 顶栏**透明**、列表从底下穿过去。
           * ⚠️ 兜底键**必须排在 `background` 之前**（顺序反了新浏览器也会恒不透明）——
           *    理由见 `ui.tsx` 那处的注释（三处同款，改一处要看另外两处）。 */
          backgroundColor: 'var(--color-canvas)',
          background: 'color-mix(in srgb, var(--color-canvas) 88%, transparent)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid var(--color-line)',
        }}
      >
        <div className="min-w-0 flex-1">
          <h1 className="truncate" style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.25 }}>
            平台运维
          </h1>
          <div className="truncate" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            超管专用 · 只读体检屏
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate('/')}>
          回教师端
        </Button>
      </header>
      {children}
    </div>
  )
}

/* ============================================================
   ⑥ 全站公告（2026-09-28 公告轮）—— 超管的发公告入口
   ------------------------------------------------------------
   🔴🔴 **这一块与「通知」不是一件事**（本仓库最容易搞混的一处）：

     | | 通知（`/notices/new`） | 公告（本卡） |
     |---|---|---|
     | 谁发的 | 各职能部门（教务处 / 办公室 / 德育处 / 年级主任 / 组长） | **只有超管** |
     | 说什么 | **学校对老师**的事（开会、调课、备课） | **关于平台本身**（维护、新功能、提醒） |
     | 收件范围 | 七种维度（全校 / 年级 / 学科 / …） | **没有**，全站一条 |
     | 形态 | `/notices` 收件箱 + 未读红点 | **顶部横幅 + 可选弹窗** |
     | 表 / 接口 | `notices` / `/api/notice` | `announcements` / `/api/announcement` |

   ⚠️ 入口为什么落在这里（而不是 `/settings` 里再开一行）：公告是"**平台自身**的状态"，
      与这块屏的定位逐字一致（"面板只回答『平台自己好不好』"）；
      而 `/settings → 通知` 那一行已经是**教务通知**的落点，两条并排摆最容易被人当成一件事。
      **因此本轮没有新增任何路由 / 入口 key**（`PAGES` / `ENTRIES` / 那两张角色矩阵一个字没动）。
   ⚠️ 判据仍然只在服务端（`/api/announcement` → `can_publish_announcement()`）：
      这块卡摆不摆按钮**不是**安全边界（手打接口照样被 403）。
   ============================================================ */
function AnnounceCard() {
  const preview = useStore((s) => s.annPreview)
  const setPreview = useStore((s) => s.previewAnnouncement)
  const hydrateAnnouncements = useStore((s) => s.hydrateAnnouncements)

  const [rows, setRows] = useState<Announcement[]>([])
  const [loadErr, setLoadErr] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState('')
  const [editingId, setEditingId] = useState('')
  /*
   * 「现在」是**一次取数的产物**（照这块屏上 `now` 的口径）：渲染必须是纯的，
   * 所以在渲染里读 `Date.now()` 会被 `react(purity)` 标成警告，而本仓库要求 lint 0 warning。
   * 它只用来判"这条现在生效吗"（未生效 / 生效中 / 已过期），每次重新取清单时跟着刷。
   */
  const [nowMs, setNowMs] = useState(() => Date.now())

  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [level, setLevel] = useState<AnnouncementLevel>('normal')
  const [popup, setPopup] = useState<AnnouncementPopup>('never')
  const [pin, setPin] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /**
   * 🆕 2026-09-29：**是否同时发一封邮件**（可选勾选、**默认不发** —— 用户点名）。
   * ⚠️ 它只在**新建**时生效（服务端只在 `create` 那一支发信）；
   *    编辑一条旧公告不会补发（否则"改个字"就会多一封邮件，配额会被悄悄吃掉）。
   */
  const [sendEmail, setSendEmail] = useState(false)

  /**
   * 清单。🔴 两种来源**都是真的**：
   *   · 云端：`/api/announcement` 的 `admin-list`（service_role，**含已撤下 / 已过期**——
   *     "这条公告曾经存在过吗"要能回答）；
   *   · 本地模式（没有服务端）：直接拿教师端 store 里那两条**演示夹具** ——
   *     这样"预览"这个按钮在没有后端的机器上照样能用（那正是它存在的意义）。
   * ⚠️ 这个函数**不 setState**（纯取数）—— 于是"在 effect 里同步 setState"那条 lint 警告
   *    就不存在了（与这块屏上 `fetchServer` 那一段同款：数据都在异步回来之后才进 state）。
   */
  const loadRows = useCallback(async (): Promise<{ rows: Announcement[]; err: string }> => {
    if (!isRemote) return { rows: useStore.getState().announcements, err: '' }
    const res = await adminListAnnouncements()
    return res.ok ? { rows: res.announcements, err: '' } : { rows: [], err: res.message }
  }, [])

  const reload = useCallback(async () => {
    const r = await loadRows()
    setRows(r.rows)
    setLoadErr(r.err)
    setNowMs(Date.now())
  }, [loadRows])

  useEffect(() => {
    let alive = true
    void loadRows().then((r) => {
      if (!alive) return
      setRows(r.rows)
      setLoadErr(r.err)
      setNowMs(Date.now())
    })
    return () => {
      alive = false
    }
  }, [loadRows])

  const resetForm = () => {
    setEditingId('')
    setTitle('')
    setText('')
    setLevel('normal')
    setPopup('never')
    setPin(false)
    setFrom('')
    setTo('')
    setSendEmail(false)
  }

  const startEdit = (a: Announcement) => {
    setEditingId(a.id)
    setTitle(a.title)
    setText(a.body)
    setLevel(a.level)
    setPopup(a.popup)
    setPin(a.pin)
    setFrom(a.activeFrom ? toLocalInput(a.activeFrom) : '')
    setTo(a.activeTo ? toLocalInput(a.activeTo) : '')
    setMsg('')
    setErr('')
  }

  /** 提交：新建 / 更新**走同一个不变量**（同一个服务端动作组、同一个判据） */
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    setMsg('')
    const input: AnnouncementInput = {
      title,
      body: text,
      level,
      popup,
      pin,
      activeFrom: from ? new Date(from).toISOString() : '',
      activeTo: to ? new Date(to).toISOString() : '',
      /* 🆕 只有**新建**才带这个勾选（编辑不会补发 —— 见 `sendEmail` 的注释） */
      sendEmail: editingId ? false : sendEmail,
    }
    const res = editingId
      ? await updateAnnouncement(editingId, input)
      : await createAnnouncement(input)
    setBusy(false)
    if (!res.ok) {
      setErr(res.message)
      return
    }
    /*
     * 🆕 邮件那一半的回话要说清楚（**不许让超管以为"全校老师都收到邮件了"**）：
     *    发的是给管理员邮箱的一封留档；没配 key 时它发不出去，而公告本身照发。
     */
    const mail = (res.data?.mail ?? {}) as { ok?: boolean; reason?: string }
    if (sendEmail && !editingId && !mail.ok) {
      setMsg(
        '公告已发布 —— ⚠️ 但那封**留档邮件没发出去**' +
          (mail.reason === 'no_key'
            ? '（服务端没配 `RESEND_API_KEY`）'
            : mail.reason === 'pii_blocked'
              ? '（正文疑似含学生信息 → 按纪律不发信）'
              : mail.reason === 'quota'
                ? '（今天到配额上限了）'
                : '') +
          '。公告本身已经生效（教师端横幅会自己出现）。',
      )
    } else {
      setMsg(editingId ? '已更新（教师端下一次刷新就能看到）' : '已发布 —— 教师端顶部横幅会自己出现')
    }
    resetForm()
    await reload()
    /* 让教师端那一条横幅立刻跟着变（不然超管会以为没发出去） */
    await hydrateAnnouncements()
  }

  const doRevoke = async (id: string) => {
    if (busy) return
    setBusy(true)
    setErr('')
    const res = await revokeAnnouncement(id)
    setBusy(false)
    setConfirmId('')
    if (!res.ok) {
      setErr(res.message)
      return
    }
    setMsg('已撤下 —— **行还在**（"这条公告曾经存在过吗"要能回答）')
    await reload()
    await hydrateAnnouncements()
  }

  const hint = announcementPrivacyHint(title, text)
  const activeCount = rows.filter((a) => isActiveAt(a, nowMs)).length

  return (
    <Card
      tone="unknown"
      title="⑥ 全站公告（关于平台本身）"
      headline={
        loadErr
          ? `读不到公告清单：${loadErr}`
          : rows.length
            ? `共 ${rows.length} 条公告 · 当前生效 ${activeCount} 条`
            : '还没有公告 —— 下面可以发第一条（例如"系统今晚维护"）'
      }
      note="🔴 与「通知」不是一件事：公告是**平台对全站**说的话，没有收件范围；学校对老师的事走「通知」"
      openLabel="管理公告"
    >
      <div
        className="px-3.5 py-2"
        style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.8 }}
      >
        · **等级**只说"多显眼"：普通（滚动条）/ 重要（排序靠前 + 加粗）/ 紧急（最重的红底）。<br />
        · **弹窗**只说"弹几次"：不弹 / 每人一次 / 每会话一次 / 每次都弹。
        ⚠️ 唯一一处交集：`不弹 + 紧急` 仍然按"每会话一次"弹（紧急公告就是要在登录时被看到）。<br />
        · **生效区间**：两端都可以留空（空 = 立即生效 / 永不过期）；**撤下不删行**。<br />
        · **预览**会把这一条推到教师端的真实长相里（横幅 + 弹窗各一次），
        {isRemote ? '点完去工作台看' : '本地模式下用演示数据预览'}。
      </div>

      {rows.length ? (
        <div style={{ borderTop: '1px solid var(--color-line)' }}>
          {rows.map((a) => {
            const live = isActiveAt(a, nowMs)
            const state = a.revokedAt
              ? '已撤下'
              : live
                ? '生效中'
                : a.activeFrom !== null && nowMs < a.activeFrom
                  ? '未生效'
                  : '已过期'
            return (
              <div
                key={a.id}
                data-ann-row={a.id}
                className="px-3.5 py-2.5"
                style={{ borderTop: '1px solid var(--color-line)' }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={
                      a.level === 'urgent'
                        ? 'tag tag-bad'
                        : a.level === 'important'
                          ? 'tag tag-warn'
                          : 'tag tag-idle'
                    }
                  >
                    {LEVEL_TEXT[a.level]}
                  </span>
                  {a.pin ? <span className="tag tag-accent">置顶</span> : null}
                  <span className="tag tag-idle">弹窗：{POPUP_TEXT[a.popup]}</span>
                  <span className={state === '生效中' ? 'tag tag-ok' : 'tag tag-idle'}>{state}</span>
                  {/*
                    🆕 邮件四列**真的用起来了**（方案 §二.5："额度/失败计数要给到界面上"）：
                    · `emailSent` = 有没有**成功**发过（失败不算"发过"，否则会把失败画成绿）；
                    · `emailFail` = 失败封数（含"没配 key"与"正文疑似含学生信息"）。
                  */}
                  {a.emailFail > 0 ? (
                    <span className="tag tag-bad" data-ann-email="fail">
                      邮件失败 {a.emailFail}
                    </span>
                  ) : a.emailSent ? (
                    <span className="tag tag-ok" data-ann-email="sent">
                      邮件已发 {a.emailCount}
                    </span>
                  ) : null}
                  {preview?.id === a.id ? <span className="tag tag-accent">预览中</span> : null}
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 620, marginTop: 4 }}>{a.title}</div>
                <div style={{ fontSize: 12, color: 'var(--color-ink2)', lineHeight: 1.7 }}>{a.body}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconEye size={14} />}
                    data-admin-ann-preview={a.id}
                    onClick={() => {
                      setPreview(a)
                      setMsg('预览已备好 —— 去工作台（或任意教师端页面）就会看到那条横幅与弹窗各一次')
                    }}
                  >
                    预览
                  </Button>
                  {!a.revokedAt ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(a)}>
                        编辑
                      </Button>
                      {confirmId === a.id ? (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          data-admin-ann-revoke-confirm={a.id}
                          onClick={() => void doRevoke(a.id)}
                        >
                          确认撤下
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmId(a.id)}>
                          撤下
                        </Button>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                      {a.revokedAt ? `撤下于 ${new Date(a.revokedAt).toLocaleString('zh-CN')}` : ''}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      <SubHead>{editingId ? '编辑这条公告' : '发一条新公告'}</SubHead>
      <div className="px-3.5 pb-3" data-admin-ann-form>
        <input
          className="input"
          style={{ height: 34, fontSize: 13 }}
          placeholder="标题，例如：系统维护：今晚 23:00–23:30"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="input mt-2"
          style={{ minHeight: 76, fontSize: 13, lineHeight: 1.7 }}
          placeholder="正文（纯文本）。⚠️ 这是全站都看得到的，不要写学生姓名 / 学号 / 成绩。"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {hint ? (
          <div
            className="mt-2 flex items-start gap-2 p-2.5"
            data-admin-ann-privacy
            style={{
              background: 'var(--color-warnsoft)',
              border: '1px solid var(--color-warnline)',
              color: 'var(--color-warnink)',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <IconInfo size={14} />
            <span>{hint}</span>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="input"
            style={{ height: 34, fontSize: 13, width: 128 }}
            aria-label="等级"
            value={level}
            onChange={(e) => setLevel(e.target.value as AnnouncementLevel)}
          >
            <option value="normal">普通（滚动条）</option>
            <option value="important">重要（加粗靠前）</option>
            <option value="urgent">紧急（强提醒）</option>
          </select>
          <select
            className="input"
            style={{ height: 34, fontSize: 13, width: 168 }}
            aria-label="弹窗"
            value={popup}
            onChange={(e) => setPopup(e.target.value as AnnouncementPopup)}
          >
            <option value="never">不弹窗</option>
            <option value="once">每人弹一次</option>
            <option value="session">每会话一次</option>
            <option value="always">每次都弹（慎用）</option>
          </select>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            置顶
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            生效起
            <input
              type="datetime-local"
              className="input"
              style={{ height: 32, fontSize: 12.5, width: 190 }}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            生效止
            <input
              type="datetime-local"
              className="input"
              style={{ height: 32, fontSize: 12.5, width: 190 }}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            两端留空 = 立即生效 / 永不过期
          </span>
        </div>
        {/*
          🆕 邮件那一半（2026-09-29）：**可选勾选、默认不发**（用户点名）。
          🔴 文案里必须写清两件事，否则超管会以为"群发成功了"：
             ① 发的是**给管理员邮箱的一封留档**（Resend 未验域名只能发给账号所有者本人）；
             ② 免费额度 100 封/天。
        */}
        <div className="mt-2.5">
          <label className="flex items-start gap-1.5" style={{ fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={sendEmail}
              disabled={Boolean(editingId)}
              onChange={(e) => setSendEmail(e.target.checked)}
              style={{ marginTop: 3 }}
              data-ann-send-email
            />
            <span style={{ lineHeight: 1.7 }}>
              同时发一封邮件**留档**（默认不发；**只在新建时生效**）
              <span className="block" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                ⚠️ 它**不是群发**：未验域名时 Resend 只能从 `onboarding@resend.dev` 发给你自己那个邮箱。
                免费额度 3000 封/月、**100 封/天** —— 所以默认不勾。
              </span>
            </span>
          </label>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={<IconMegaphone size={15} />}
            disabled={busy || !isRemote}
            data-admin-ann-submit
            onClick={() => void submit()}
          >
            {editingId ? '保存修改' : '发布公告'}
          </Button>
          {editingId ? (
            <Button size="sm" variant="ghost" onClick={resetForm}>
              取消编辑
            </Button>
          ) : null}
          {!isRemote ? (
            <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
              本地模式没有服务端（`/api/announcement`），**发布按钮停用** ——
              上面那两条是演示数据，「预览」照常可用。
            </span>
          ) : null}
        </div>
        {msg ? (
          <div
            className="mt-2 flex items-center gap-1.5"
            style={{ fontSize: 12.5, color: 'var(--color-ok)' }}
          >
            <IconCheck size={14} />
            {msg}
          </div>
        ) : null}
        {err ? (
          <div
            className="mt-2 flex items-center gap-1.5"
            style={{ fontSize: 12.5, color: 'var(--color-bad)' }}
          >
            <IconAlert size={14} />
            {err}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

/** 毫秒时间戳 → `datetime-local` 输入框要的 `YYYY-MM-DDTHH:MM`（**本地时区**） */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ============================================================
   🆕 管理台的外壳：**顶栏工具栏 + 左侧分区导航**
   ------------------------------------------------------------
   用户原话："顶栏工具栏：版本号 + 构建哈希 + 环境（线上/本地模式）+ 刷新 + 回教师端"。
   ⚠️ 仍然**不套 `AppShell`**（I41）：这套壳是面板自己的，`Shell`（登录卡那几条路）
      一个字都没动 —— 那几条路恰恰是"最坏情况下也要能打开"的路。
   ============================================================ */

function AdminFrame({
  tab,
  setTab,
  onReload,
  busy,
  children,
}: {
  tab: AdminTab
  setTab: (t: AdminTab) => void
  onReload: () => void
  busy: boolean
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  const localMode = connectionMode() === 'local'
  return (
    <div className="min-h-full">
      {/* ---------------- 顶栏 ---------------- */}
      <header
        className="sticky top-0 z-30 flex flex-wrap items-center gap-2 px-4 py-2"
        style={{
          /* 🔴 同 `components/ui.tsx:204`：`color-mix()` 兜底，理由见那处。
             ⚠️ 兜底键在前、`background` 在后 —— 顺序反了新浏览器也恒不透明。 */
          backgroundColor: 'var(--color-canvas)',
          background: 'color-mix(in srgb, var(--color-canvas) 88%, transparent)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid var(--color-line)',
        }}
      >
        <div className="min-w-0 flex-1">
          <h1 className="truncate" style={{ fontSize: 16, fontWeight: 650, lineHeight: 1.25 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconGauge size={17} />
              平台运维
            </span>
          </h1>
          <div className="truncate" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            超管专用 · 只读体检屏（三个写动作都留痕）
          </div>
        </div>
        <span className="tag tag-idle num" data-admin-version>
          {APP_VERSION_LABEL}
        </span>
        <span
          className="tag tag-idle num"
          data-admin-hash={BUILD_HASH ?? 'none'}
          title="构建哈希：用来回答'线上跑的到底是哪一次构建'"
        >
          {BUILD_HASH ? BUILD_HASH.slice(0, 8) : '哈希取不到'}
        </span>
        <span className={localMode ? 'tag tag-bad' : 'tag tag-ok'} data-admin-env>
          {localMode ? '本地模式' : '线上'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconRefresh size={14} />}
          disabled={busy}
          onClick={onReload}
          data-admin-refresh
        >
          {busy ? '刷新中…' : '刷新'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => navigate('/')}>
          回教师端
        </Button>
      </header>

      <div className="mx-auto flex w-full gap-4 px-4 pt-4" style={{ maxWidth: 1180 }}>
        {/* ---------------- 左侧分区导航（宽屏） ---------------- */}
        <aside className="hidden shrink-0 lg:block" style={{ width: 176 }}>
          <nav className="panel sticky overflow-hidden" style={{ top: 72 }} data-admin-nav>
            {ADMIN_SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                data-admin-nav-key={s.key}
                aria-current={tab === s.key}
                onClick={() => setTab(s.key)}
                className="block w-full px-3 py-2 text-left"
                style={{
                  borderBottom: '1px solid var(--color-line)',
                  background: tab === s.key ? 'var(--color-surface2)' : 'transparent',
                  fontSize: 13,
                  fontWeight: tab === s.key ? 650 : 500,
                  color: tab === s.key ? 'var(--color-ink)' : 'var(--color-ink2)',
                }}
              >
                {s.label}
                <span
                  className="block truncate"
                  style={{ fontSize: 10.5, color: 'var(--color-ink4)', fontWeight: 400 }}
                >
                  {s.hint}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 pb-10">
          {/* 窄屏：左栏折叠成**顶部横向分段**（用户要求"移动端能用"） */}
          <div
            className="mb-3 flex gap-1.5 overflow-x-auto pb-1 lg:hidden"
            data-admin-segments
          >
            {ADMIN_SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                data-admin-seg-key={s.key}
                aria-current={tab === s.key}
                onClick={() => setTab(s.key)}
                className={tab === s.key ? 'tag tag-accent' : 'tag tag-idle'}
                style={{ flex: 'none', fontSize: 12.5, padding: '5px 10px' }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {children}
        </main>
      </div>
    </div>
  )
}

/* ============================================================
   概览的**数字磁贴**（用户原话："一排数字磁贴（大数字 + 标签 + 状态色）"）
   ============================================================ */

type TileItem = {
  key: string
  label: string
  value: string
  sub: string
  tone: Tone
  /** 点它去哪个分区（不填 = 不可点，例如"当前版本"） */
  to?: AdminTab
}

function Tiles({
  items,
  setTab,
}: {
  items: TileItem[]
  tab: AdminTab
  setTab: (t: AdminTab) => void
}) {
  const targets: Partial<Record<string, AdminTab>> = {
    db: 'db',
    /* 🆕 出流量与库用量在同一格里（同一张账单的两个数） */
    egress: 'db',
    backup: 'health',
    health: 'health',
    errors: 'errors',
    feedback: 'feedback',
    maint: 'maintenance',
  }
  return (
    <div
      className="mb-3 grid gap-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))' }}
      data-admin-tiles
    >
      {items.map((it) => {
        const to = it.to ?? targets[it.key]
        return (
          <button
            key={it.key}
            type="button"
            data-admin-tile={it.key}
            data-tile-tone={it.tone}
            onClick={to ? () => setTab(to) : undefined}
            className="panel overflow-hidden p-3 text-left"
            style={{ cursor: to ? 'pointer' : 'default' }}
          >
            <div className="flex items-center gap-1.5">
              <Dot tone={it.tone} />
              <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>{it.label}</span>
            </div>
            <div
              className="num mt-1 truncate"
              style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}
              title={it.value}
            >
              {it.value}
            </div>
            <div className="truncate" style={{ fontSize: 11, color: 'var(--color-ink4)' }}>
              {it.sub}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/* ============================================================
   数据库用量（`DbCard`）
   ------------------------------------------------------------
   🔴 与第一期 J2 的关系（**方案点名"最容易踩的重复"**）：
      · 本卡回答"**全库还剩多少**"；
      · 明细里的"体积最大的几份档案"回答"**哪一份档案最大**"（一份就能到十几 MB）。
      两者**在同一页互相指路**，而且**只有一张排行表**（不再各做一张）。
   🔴 **2026-10-07 修"这张卡让人误判"**（用户实测：控制台 11% / 面板 1.4%）：
      · **百分比只能按"整库"算**（`pg_database_size`，与控制台同一口径）；
      · 逐表排行**留着**（它对找大头有用），但必须**标明它是"用户表之和"**，
        而且把两个数**并排写出来 + 解释差额**（系统目录 / WAL / 其他 schema）——
        两个数看着矛盾，正是这张卡原来的样子；
      · 新增**出流量**那一格（Management API，只读 PAT；三态，读不到=灰）。
   🔴 隐私：这一整卡是 **A 类（聚合计数 / 字节数）**，唯一的 B 类是"哪份档案大"
      —— 给的是**班级名 + 档案 id + 字节数**，**没有学生、没有题目、没有成绩**
      （`db_usage_report()` 返回的对象里根本没有那些字段）。
   ============================================================ */

function DbCard({
  report,
  error,
  judge,
  egressFacts,
  egressJudge,
  now,
  headline,
}: {
  report: DbReport | null
  error: string
  judge: ReturnType<typeof judgeDbUsage>
  egressFacts: EgressFacts
  egressJudge: EgressJudgement
  now: number
  /** 卡上那句话（🔴 与 L0 清单里那一条**逐字同一句**） */
  headline: string
}) {
  const pct = judge.pct
  /**
   * 🔴 配额口径 —— **它不是量出来的数，是判据本身**，所以两种模式下都要在屏上：
   *    · 有服务端：`report !== null` → 这一行在 `note` 里；
   *    · 本地演示模式（没有 `/api/*`）：`report === null` → 用量是**灰的"无法判断"**，
   *      但"按 500 MB 算 / 出流量 5 GB / 三档线 60 / 85"照写（灰的是数，不是口径）。
   *
   * 原来这句话只写在 `report !== null` 那一支里 → 本地模式整句从屏上消失，
   * 而 `shots.mjs` 那条断言（"数据库那一格写着配额与三档线"）是按"有服务端"写的
   * —— 于是 `admin-checks` ⑥（断的是常量与判据函数）全绿、真界面上却是空的。
   * 同一件事的另一半在 `admin-checks.mjs` ⑥：`DB_QUOTA_BYTES === 500 MB`、三档线 60 / 85。
   *
   * ⚠️ **2026-10-07 配额从 1 GB 改成 500 MB**（免费版的库上限，控制台写 0.5 GB）：
   *    1 GB 是估数 —— 配额写大一倍，百分比就小一半，正是"面板让人误判"的一半原因。
   *    三档线**一个字没动**（60 / 85）。
   */
  const quotaNote =
    '库配额按 **500 MB** 算（免费版 · 三档线 🟢 <60% · 🟡 60–85% · 🔴 >85%）· ' +
    '出流量按 **5 GB/账单周期** 算（免费版）'
  return (
    <Card
      tone={judge.tone}
      title="数据库使用情况"
      headline={headline}
      note={
        report === null
          ? `${error || '正在读…'} —— ${quotaNote}`
          : `${quotaNote} · 逐表体积含索引与 TOAST（pg_total_relation_size）`
      }
      openLabel="看明细"
    >
      {report === null ? (
        <div className="px-3.5 py-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          {error ? (
            <>
              <b>读不到</b>：{error}
              <br />⚠️ **读不到不是"还剩很多"**，也不是"满了" —— 这一格永远是灰的。
            </>
          ) : (
            '正在读…（服务端拿 service_role 跑 `db_usage_report()`）'
          )}
        </div>
      ) : (
        <>
          <SubHead>整库 / 已用 / 剩余（A 类：聚合计数，直接显示）</SubHead>
          <Line
            k="整库"
            v={
              <span className="num">
                {humanBytes(report.totalBytes)} —— 🔴 **百分比按这个数算**（与控制台同一个口径：
                `pg_database_size`）
              </span>
            }
          />
          <Line
            k="剩余"
            v={<span className="num">{judge.freeBytes === null ? '未知' : humanBytes(judge.freeBytes)}</span>}
          />
          <Line k="配额" v={<span className="num">{humanBytes(DB_QUOTA_BYTES)}（500 MB · 免费版）</span>} />
          <Line
            k="百分比"
            v={
              pct === null ? (
                '无法判断'
              ) : (
                <span className="num">
                  {pct.toFixed(1)}%（🟢 &lt;60% · 🟡 60–85% · 🔴 &gt;85%）
                </span>
              )
            }
          />
          <div className="px-3.5 pb-2">
            <Track value={pct ?? 0} tone={judge.tone} />
          </div>
          <Line
            k="题图占多少"
            v={
              report.questionMetaBytes === null ? (
                '无法判断'
              ) : (
                <span className="num">
                  {humanBytes(report.questionMetaBytes)} —— 题图**以 base64 存在
                  `assignments.question_meta`** 里（这是真实的爆库路径）
                </span>
              )
            }
          />

          {/* ============================================================
              🔴 两个口径并排（2026-10-07 修）：上面那一行是**整库**，这一块是
                 **用户表之和** —— 不写清楚，屏上就是"整库 53 MB"配一张加起来
                 才 14.8 MB 的排行表，看着自相矛盾。
              ============================================================ */}
          <SubHead>按表排行（前 12 名 · 口径 = **用户表之和**，不是整库）</SubHead>
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            🔴 下面这张表**只统计 `public` 里那些表**（含索引与 TOAST），它们加起来的
            <b>用户表之和</b>
            {judge.userTableBytes === null ? '没读到' : ` = ${humanBytes(judge.userTableBytes)}`}
            ，**比上面的整库小** —— 差的是<b>系统目录 / WAL / 其他 schema</b>（auth / storage /
            realtime…）。🔴 **两个数不是矛盾，是两个口径**：百分比只按整库算（控制台也只认整库）。
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full" style={{ fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--color-ink3)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 14px', fontWeight: 600 }}>表</th>
                  <th style={{ padding: '4px 8px', fontWeight: 600 }}>体积</th>
                  <th style={{ padding: '4px 8px', fontWeight: 600 }}>行数（估算）</th>
                </tr>
              </thead>
              <tbody>
                {/* ⚠️ 服务端现在给的是 **public 全部表**（面板要算"用户表之和"这个完整口径），
                    所以这里**显示时才取前 12 名** —— 与下面那句"前 12 名"对齐。 */}
                {report.tables.slice(0, 12).map((t) => (
                  <tr key={t.name} style={{ borderTop: '1px solid var(--color-line)' }}>
                    <td style={{ padding: '4px 14px' }} className="num" data-db-table={t.name}>
                      {t.name} 表
                    </td>
                    <td style={{ padding: '4px 8px' }} className="num">
                      {humanBytes(t.bytes)}
                    </td>
                    <td style={{ padding: '4px 8px' }} className="num">
                      {/* ⚠️ 估算是 null（还没 ANALYZE 过）就写"未知"，**不许写 0** */}
                      {t.rowsEstimate === null ? '未知（还没统计过）' : `${t.rowsEstimate} 行`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            ⚠️ 口径：写「`assignments` 表：9 行」，**不写**「作业：9 份」——
            表名与业务名**语义不同**（第一期 J1 的原话）。⚠️ 行数是**规划器估算**，不是精确值
            （还没统计过就写"未知"）。
          </div>

          {/* ============================================================
              🆕 2026-10-07 · 出流量（用户点名）—— 与"③ 备份"那一格同款的三态：
                 没配 / 读不到 = **灰**（不是红、不是 0）；只有真拿到才判色。
              ============================================================ */}
          <SubHead>
            出流量（本账单周期 · 免费版 5 GB）
            <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Dot tone={egressJudge.tone} />
              <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                {TONE_STYLE[egressJudge.tone].text}
              </span>
            </span>
          </SubHead>
          <Line
            k="已用"
            v={
              egressFacts.bytes === null ? (
                <span style={{ color: 'var(--color-ink3)' }}>读不到</span>
              ) : (
                <span className="num">{humanBytes(egressFacts.bytes)}</span>
              )
            }
          />
          <Line
            k="限额"
            v={
              <span className="num">
                {humanBytes(EGRESS_QUOTA_BYTES)}（5 GB · 免费版 · **按账单周期清零**）
              </span>
            }
          />
          <Line
            k="百分比"
            v={egressJudge.pct === null ? '无法判断' : <span className="num">{egressJudge.pct.toFixed(1)}%</span>}
          />
          <div className="px-3.5 pb-2">
            <Track value={egressJudge.pct ?? 0} tone={egressJudge.tone} />
          </div>
          <Line k="判据" v={egressJudge.text} />
          {egressJudge.notes.map((n, i) => (
            <div
              key={i}
              className="px-3.5 py-1.5"
              style={{
                borderBottom: '1px solid var(--color-line)',
                fontSize: 12,
                color: 'var(--color-ink2)',
                lineHeight: 1.75,
              }}
            >
              · {n}
            </div>
          ))}
          {egressFacts.periodStart || egressFacts.periodEnd ? (
            <Line
              k="账单周期"
              v={`${egressFacts.periodStart ?? '?'} → ${egressFacts.periodEnd ?? '?'}（Management API 报的）`}
            />
          ) : null}

          <PrivacyLine />
          <SubHead>体积最大的几份档案（答案："还能不能再塞一份"）</SubHead>
          <div
            className="px-3.5 pb-1"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            只给**体积 + 班级 + 档案 id**：题图只显示"体积"，**绝不显示图片**，也没有任何成绩与题目
            内容（服务端那个函数里根本没有那些字段）。红线：单份 &gt;{' '}
            {humanBytes(ARCHIVE_META_BAD_BYTES)} 就是红（**与百分比无关**）。
          </div>
          {report.archives.length === 0 ? (
            <div className="px-3.5 py-2" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
              还没有任何 `question_meta` 数据（或者这一栏读不到）。
            </div>
          ) : (
            report.archives.map((a) => {
              const over = a.bytes > ARCHIVE_META_BAD_BYTES
              return (
                <div
                  key={a.assignmentId}
                  data-db-archive={a.assignmentId}
                  className="flex items-center gap-2 px-3.5 py-2"
                  style={{ borderTop: '1px solid var(--color-line)', fontSize: 12.5 }}
                >
                  <span className="num" style={{ minWidth: 84 }}>
                    {humanBytes(a.bytes)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{a.className || '（没有班级名）'}</span>
                  {over ? <span className="tag tag-bad">超预算</span> : null}
                  <button
                    type="button"
                    style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
                    onClick={() => window.open(`/assignments/${a.assignmentId}/grade`, '_blank')}
                  >
                    去这份档案 →
                  </button>
                </div>
              )
            })
          )}
          <HintOnly>
            面板**不给**"清理题图""压缩档案"按钮 —— 题图是老师拍的原始材料，删了找不回来。
            真要腾空间：先确认 G2 最近一次备份是成功的，再人工处理那几份超预算的档案。
          </HintOnly>
          <div className="px-3.5 pb-3" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            读数时刻：{now ? agoText(now) : '未知'} · 两个来源：库大小走 `db_usage_report()`
            （`schema.sql` §26，只 grant 给 service_role）· 出流量走 Supabase Management API
            （只读 `SUPABASE_PAT`，服务端代取）
          </div>
        </>
      )}
    </Card>
  )
}

/* ============================================================
   维护模式（`MaintenanceCard`）—— **本期唯一一个"能把全校锁住"的按钮**
   ------------------------------------------------------------
   🔴 防呆（用户点名，逐条落在这里 + 服务端）：
      ① **二次确认要输入字符串 `MAINTENANCE`**（输入不匹配就 `disabled`；
         服务端**还会再判一次** —— 手打接口的人绕不过去）；
      ② **强制自动关闭**（四档 1/4/12/24，**默认 4 小时**，不许留空）；
      ③ **超管永远进得去**（`/admin` 不参与维护判定 —— 在 `MaintenanceGate.tsx`）；
      ④ **开了之后 L0 上常驻一行**（见上面的 L0）；
      ⑤ **不做"维护时强制登出"**（登录态 7 天，一次误触 = 100 多人重登）。
   🔴 四条表单校验（R1/R2/R3/R4）在 `lib/maintenance.ts` —— **服务端有一份逐字相同的**
      （`functions/api/_lib/maintenance.ts`，`nav-checks` 逐条比对两边的常量与报错文案）。
   ============================================================ */

function MaintenanceCard({
  state,
  error,
  live,
  now,
  onReload,
  busy,
}: {
  state: AdminMaintenanceState | null
  error: string
  live: { enabled: boolean; read: string; reason: string; message: string; until: number | null }
  /** 「现在」是**一次取数的产物**（渲染必须是纯的 —— 所以这里不调 `Date.now()`） */
  now: number
  onReload: () => void
  busy: boolean
}) {
  const [message, setMessage] = useState('')
  const [hours, setHours] = useState<number>(MAINTENANCE_DEFAULT_HOURS)
  const [scheduled, setScheduled] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy2, setBusy2] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [mailMsg, setMailMsg] = useState('')
  const [mailErr, setMailErr] = useState('')

  /*
   * 把服务端那一份状态填进表单（每次读到新状态都刷 —— 面板要显示"现在真的是什么"）。
   * ⚠️ 走一个 0ms 定时器：effect 里**同步** setState 会触发级联渲染
   *    （`react(set-state-in-effect)`，本仓库要求 lint 0 warning）。
   * ⚠️ `state` 的**引用**每次取数都是新的 → 这个 effect 会跟着重跑，
   *    这正是我们要的（超管点了"重新读取"之后表单要跟上）。
   */
  useEffect(() => {
    if (!state) return
    const t = window.setTimeout(() => {
      setMessage(state.message)
      setScheduled(state.scheduledFrom !== null)
      setFrom(state.scheduledFrom ? toLocalInput(state.scheduledFrom) : '')
      setTo(state.until && state.scheduledFrom ? toLocalInput(state.until) : '')
    }, 0)
    return () => window.clearTimeout(t)
  }, [state])

  const form = {
    enabled: true,
    message,
    hours,
    scheduled,
    fromMs: inputToMs(from),
    toMs: inputToMs(to),
  }
  /* ⚠️ `now` 是**一次取数的产物**（渲染里不调 `Date.now()`）；还没取到时用 0 ——
     0 只影响"预览里那个自动关闭时刻"的显示，不影响四条校验（它们只比 from/to） */
  const verdict = validateMaintenanceForm(form, now)
  const canTurnOff = state?.effective === true || state?.enabled === true

  const doSet = async (enabled: boolean) => {
    if (busy2) return
    setBusy2(true)
    setErr('')
    setMsg('')
    const f = enabled
      ? form
      : { enabled: false, message: '', hours, scheduled: false, fromMs: null, toMs: null }
    /*
     * ⚠️ 这里用的是**本屏共用的那一个「现在」**（`now`，一次取数的产物），
     *    不是当场调 `Date.now()`：渲染必须纯（`react(purity)`），而且这块屏
     *    的口径本来就是"同一屏共用一个现在"。
     *    🔴 它**不影响提交结果**：`until` 是**服务端**用自己的 now 算的
     *    （客户端算出来的那个 `until` 只用于下面那句预览）。
     */
    const v = validateMaintenanceForm(f, now)
    if (!v.ok) {
      setBusy2(false)
      setErr(v.error)
      return
    }
    const r = await setMaintenance({
      enabled,
      message: f.message,
      hours: v.hours,
      scheduled: f.scheduled,
      fromMs: f.fromMs,
      toMs: f.toMs,
      confirm: enabled ? confirm.trim() : '',
    })
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(
      enabled
        ? `已提交：${r.text}${r.downgraded ? '（定时两个都没填 → **已降级为立即生效**）' : ''}`
        : '已关闭维护模式 —— 全校（含教室端）下一次轮询就会恢复',
    )
    setConfirm('')
    onReload()
  }

  const doTestMail = async () => {
    setMailErr('')
    setMailMsg('')
    const r = await sendTestMail()
    if (!r.ok) setMailErr(r.message)
    else setMailMsg(`已发出（收件人 ${r.to || '部署环境配的那个邮箱'}）—— 去邮箱看一眼就知道通道通不通`)
    onReload()
  }

  return (
    <Card
      tone={state?.effective ? 'bad' : state === null ? 'unknown' : 'ok'}
      /* ⚠️ 这一张**不折叠**（方案 §二.3 的防呆 4：它是全屏唯一一个"我现在正开着"的状态，
         藏起来就是藏事故）—— 所以明细永远展开。
         🆕 2026-09-26：`defaultOpen` 就是这句话的**实现**（原来只是一句注释 —— `Card`
         的 `children` 默认不渲染，于是常态下"二次确认输入框 + 开启按钮"连 DOM 都没有）。 */
      defaultOpen
      title="维护模式"
      headline={maintenanceHeadline(state, error)}
      note={
        state === null
          ? '⚠️ 读不到**不是**"没在维护"，也**不是**"在维护" —— 这一格永远是灰的'
          : `上次改动：${state.updatedAt ? agoText(state.updatedAt) : '未知'} · 判据：数据库的 is_super_admin()`
      }
    >
      <div className="px-3.5 py-2" style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.85 }}>
        · **开了会发生什么**：所有在线用户（含教室端大屏）在下一次轮询 / 下一次切回标签页时，
        整屏被换成维护画面。**超管自己不受影响**（`/admin` 不参与维护判定 —— 否则开了关不掉）。
        <br />· **不会登出任何人**（用户拍板）：登录态是 7 天，一次误触 = 100 多人重登。
        <br />· **自动关闭是强制的**：`enabled=true` 时一定有 `until`（默认 4 小时），
        **不允许"永久开启"** —— 那是"开了忘了关"这种事故的温床。
        <br />· 教室端：**全屏维护画面 + 心跳照发 + 立刻清掉本页学生数据**（三件事都在 `Classroom.tsx`）。
      </div>

      {live.read === 'failed' ? (
        <div
          className="mx-3.5 mb-2 p-2.5"
          style={{
            background: 'var(--color-idlesoft)',
            border: '1px solid var(--color-line)',
            fontSize: 12,
            lineHeight: 1.75,
            color: 'var(--color-ink2)',
          }}
        >
          公开接口 `GET /api/status` **读不到**（{live.reason}）—— 各端按"未维护"放行（fail-open）。
          ⚠️ 这个代价必须显式露出来：否则就是"无法判断归到绿"。
        </div>
      ) : null}

      <SubHead>当前状态（超管接口读的）</SubHead>
      <Line k="生效中" v={state === null ? '无法判断' : state.effective ? '是' : '否'} />
      <Line k="定时开启" v={state?.scheduledFrom ? new Date(state.scheduledFrom).toLocaleString('zh-CN') : '（没有定时）'} />
      <Line
        k="自动关闭"
        v={
          state?.until ? (
            new Date(state.until).toLocaleString('zh-CN')
          ) : (
            <span style={{ color: 'var(--color-ink3)' }}>（没有 —— 关闭状态下本来是空的）</span>
          )
        }
      />
      <Line k="通告正文" v={state?.message || '（空 → 用默认文案）'} />
      <Line k="谁改的" v={state?.updatedBy ?? '（读不到 / 从没改过）'} />
      {state?.autoOff ? (
        <Line
          k="刚刚发生"
          v={<span style={{ color: 'var(--color-warn)' }}>到点自动关闭 —— 已把 `enabled` 落回 false（幂等）</span>}
        />
      ) : null}

      <SubHead>开启 / 定时（四条校验在服务端与本页各判一次）</SubHead>
      <div className="px-3.5 pb-3" data-maint-form>
        <textarea
          className="input"
          style={{ minHeight: 60, fontSize: 13, lineHeight: 1.7 }}
          placeholder={`给全校看的通告正文（最多 ${MAINTENANCE_MESSAGE_MAX} 字）。留空 = 用默认文案「${MAINTENANCE_DEFAULT_MESSAGE}」`}
          value={message}
          maxLength={MAINTENANCE_MESSAGE_MAX}
          onChange={(e) => setMessage(e.target.value)}
          data-maint-message
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            自动关闭
            <select
              className="input"
              style={{ height: 32, fontSize: 12.5, width: 92 }}
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              data-maint-hours
            >
              {MAINTENANCE_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} 小时
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={scheduled}
              onChange={(e) => setScheduled(e.target.checked)}
              data-maint-scheduled
            />
            定时开启
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            开始
            <input
              type="datetime-local"
              className="input"
              style={{ height: 32, fontSize: 12.5, width: 186 }}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-maint-from
            />
          </label>
          <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
            结束
            <input
              type="datetime-local"
              className="input"
              style={{ height: 32, fontSize: 12.5, width: 186 }}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-maint-to
            />
          </label>
        </div>
        <div
          className="mt-2"
          data-maint-preview
          style={{
            fontSize: 12,
            lineHeight: 1.75,
            color: verdict.ok ? 'var(--color-ink2)' : 'var(--color-bad)',
          }}
        >
          {now > 0 ? previewText(form, now) : '正在取数…（取到之后这里会写清"这样提交会发生什么"）'}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className="input"
            style={{ height: 34, fontSize: 13, width: 210 }}
            placeholder={`输入 ${MAINTENANCE_CONFIRM_WORD} 确认`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            data-maint-confirm
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy2 || !verdict.ok || confirm.trim() !== MAINTENANCE_CONFIRM_WORD}
            onClick={() => void doSet(true)}
            data-maint-on
          >
            开启维护模式
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy2 || !canTurnOff}
            onClick={() => void doSet(false)}
            data-maint-off
          >
            立即关闭
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
            重新读取状态
          </Button>
        </div>
        {msg ? (
          <div className="mt-2 flex items-center gap-1.5" style={{ fontSize: 12.5, color: 'var(--color-ok)' }} data-maint-msg>
            <IconCheck size={14} />
            {msg}
          </div>
        ) : null}
        {err ? (
          <div className="mt-2 flex items-center gap-1.5" style={{ fontSize: 12.5, color: 'var(--color-bad)' }} data-maint-err>
            <IconAlert size={14} />
            {err}
          </div>
        ) : null}
      </div>

      <SubHead>邮件通道（Resend）</SubHead>
      <div className="px-3.5 py-2" style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--color-ink2)' }}>
        {state?.mail?.configured ? (
          <>
            `RESEND_API_KEY` **在**（第一期那条"尚未接入代码"的黄灯已经不成立了）·
            今天已发 <span className="num">{state.mail.sentToday ?? '读不到'}</span> 封 ·
            上限 {state.mail.cap ?? '?'}/天（Resend 免费额度 100/天）
            {/*
              🔴 收件人与密钥是**两件事**：只有 key、没有 `ADMIN_NOTIFY_EMAIL` 时，
                 邮件一封也发不出去。不报这一项，这行字就会说"通道是好的" —— 面板说谎。
            */}
            {state.mail.recipientConfigured === false ? (
              <>
                <br />⚠️ 但 `ADMIN_NOTIFY_EMAIL`（**收件人**）**不在** —— 邮件一封也发不出去。
                去 Cloudflare Pages → Settings → Variables and secrets 补上它（填你自己的邮箱）。
              </>
            ) : null}
          </>
        ) : (
          <>
            ⚠️ `RESEND_API_KEY` **不在** —— 邮件通道没开：反馈照常落库，但**不会发到你邮箱**
            （反馈那一栏会显式报警）。去 Cloudflare Pages → Settings → Variables and secrets 加它。
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={<IconSend size={14} />}
            disabled={busy2}
            onClick={() => void doTestMail()}
            data-mail-test
          >
            发测试邮件
          </Button>
          <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            收件人是**部署环境配的** `ADMIN_NOTIFY_EMAIL`、发件人固定 `onboarding@resend.dev`
            （未验域名时 Resend 只能这样发）
          </span>
        </div>
        {mailMsg ? (
          <div className="mt-2" style={{ fontSize: 12.5, color: 'var(--color-ok)' }}>
            {mailMsg}
          </div>
        ) : null}
        {mailErr ? (
          <div className="mt-2" style={{ fontSize: 12.5, color: 'var(--color-bad)' }} data-mail-err>
            {mailErr}
          </div>
        ) : null}
      </div>

      <HintOnly>
        面板**不做**"自动触发维护"（例如"空间不足自动开维护"）：把全校锁住的触发条件
        不该是一台机器的时钟 + 一次网络请求。要开就人来开。
      </HintOnly>
    </Card>
  )
}

/* ============================================================
   版本更新公告（`ReleaseCard`）—— 2026-10-04，施工单 `施工单-版本更新提示.md` §二.6
   ------------------------------------------------------------
   🔴 **两档各发各的**：教师端一档（**网页端跟随这一档**）、教室端一档（大屏）。
      一次发布**只动一档** —— 给教师端发强制，教室端那块屏照常能用（反之亦然）。

   🔴 判据全在服务端：`is_super_admin()` + 五条校验（R1…R5，见 `lib/release.ts`）。
      这里只是**表单 + 预览**：手打 `/api/admin/release` 的人绕不过服务端那一道。

   🔴 **文案纪律**（施工单 §三 / `AGENTS.md` §七，`admin-checks` 有反向对照钉着）：
      正文 ≤ 24 字、标题 ≤ 8 字；禁词（`点击` / `点这里` / `请点击` / `注意` / `未知来源` /
      `SmartScreen` / `安装包` / `哈希` / `vc` / `如遇问题`）一条都不许出现 ——
      系统自己会问、老师自己会点，**公告不该教人点**。

   ⚠️ 两个 `ReleaseSlotForm` 的 `data-rel-*` 属性**同名**（避免两套命名），
      所以在门禁里要**带前缀查**：`[data-rel-form="teacher"] [data-rel-version]`。
   ============================================================ */

/** 占位符里露一句默认正文（只是给超管看个例子；`{v}` 换成版本号） */
const RELEASE_NOTE_EXAMPLE = RELEASE_NOTE_SOFT.replace('{v}', '1.1.1')

function ReleaseCard({
  slots,
  error,
  live,
  onReload,
  busy,
}: {  slots: { teacher: AdminReleaseSlot; classroom: AdminReleaseSlot } | null
  error: string
  live: { enabled: boolean; read: string; reason: string }
  onReload: () => void
  busy: boolean
}) {
  /*
   * 🔴 颜色**只由 `releaseTone()` 一处算** —— 概览的颜色汇总与「要留意」清单取的是
   *    同一个函数；卡这里只是把它调出来（不然同一件事会有两份颜色判据）。
   */
  const tone: Tone = releaseTone(slots, error)

  return (
    <Card
      tone={tone}
      defaultOpen
      title="版本更新"
      headline={releaseHeadline(slots, error)}
      note={`本机的 APP_VERSION 是 v${APP_VERSION} —— 客户端的版本比公告旧才会提示`}
    >
      <div className="px-3.5 py-2" style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.85 }}>
        · **发出去会发生什么**：版本比公告旧的客户端（含 apk / exe / 网页）会看到一条更新公告；
        **强制**那一档整屏接管、**关不掉**，登录之后除 `/login` 与 `/admin` 外进不去；
        **选择性**那一档有关掉的地方，但**每次重新打开应用都会再弹一次**。
        <br />· **两档互不影响**：给教师端发强制，教室端那块屏照常能用（两边各发各的）。
        <br />· **教室端被拦时那台机器要人工装一次**（大屏在教室里）—— 公告里会多一句
        「请在教师电脑上下载后，到这台机器安装。」提醒值班老师。
        <br />· **已经装在老师机器上的旧包不会有任何提示**：这段代码是这一版才加的，
        本功能对"这一版之后发布的版本"才生效。
        <br />· 链接只接受 `https://`，**只显示不执行**（点了是浏览器/系统去下载）。
      </div>

      {error ? (
        <div
          className="mx-3.5 mb-2 p-2.5"
          style={{
            background: 'var(--color-idlesoft)',
            border: '1px solid var(--color-line)',
            fontSize: 12,
            lineHeight: 1.75,
            color: 'var(--color-ink2)',
          }}
          data-rel-readerr
        >
          读不到版本公告（{error}）—— 各端按"没有更新"放行（fail-open）。
          ⚠️ 这个代价必须显式露出来：否则就是"无法判断归到绿"。
        </div>
      ) : null}

      {live.read === 'failed' ? (
        <div
          className="mx-3.5 mb-2 p-2.5"
          style={{
            background: 'var(--color-idlesoft)',
            border: '1px solid var(--color-line)',
            fontSize: 12,
            lineHeight: 1.75,
            color: 'var(--color-ink2)',
          }}
        >
          公开接口 `GET /api/status` 那一段**读不到**（{live.reason}）—— 各端按"没有更新"放行，
          但面板上不能写成"已是最新"（**灰就是灰**）。
        </div>
      ) : null}

      <SubHead>教师端（含网页端）</SubHead>
      <ReleaseSlotForm target="teacher" slot={slots?.teacher ?? null} busy={busy} onReload={onReload} />

      <SubHead>教室端（教室里那块大屏）</SubHead>
      <ReleaseSlotForm target="classroom" slot={slots?.classroom ?? null} busy={busy} onReload={onReload} />

      <HintOnly>
        发布前先问一句**下载链接填了没有**：两个链接都空 = 公告里**不给按钮**，
        老师只能自己在群里找包 —— 那时正文里要写清去哪儿拿。
        链接的取法（Cloudflare R2 一步一步）见仓库根 `施工单-版本更新提示.md` §七。
      </HintOnly>
    </Card>
  )
}

/** 一档的编辑区（教师端 / 教室端各一个实例） */
function ReleaseSlotForm({
  target,
  slot,
  busy,
  onReload,
}: {
  target: 'teacher' | 'classroom'
  /** `null` = 这一档读不到（与"没在发"不是一件事） */
  slot: AdminReleaseSlot | null
  busy: boolean
  onReload: () => void
}) {
  /*
   * ⚠️ 初值就是"这一版该发的样子"（版本号 = 本机 `APP_VERSION`、正文 = 默认那句）——
   *    **不许**留空等取数：读不到那一档时（本地模式 / 服务端 503）表单也得是**能看懂**的，
   *    否则超管看到的是一张空表 + 一条灰条，不知道"该填成什么样"。
   *    下面那个 effect 只在**读到了**服务端那一份时覆盖它。
   */
  const [version, setVersion] = useState(APP_VERSION)
  const [force, setForce] = useState<boolean | null>(null)
  const [note, setNote] = useState(() => releaseDefaultNote(APP_VERSION, false))
  const [urlApk, setUrlApk] = useState('')
  const [urlExe, setUrlExe] = useState('')
  const [busy2, setBusy2] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  /*
   * 把服务端那一份填进表单（每次读到新状态都刷）。
   * ⚠️ 走一个 0ms 定时器：effect 里**同步** setState 会触发级联渲染
   *    （`react(set-state-in-effect)`，本仓库要求 lint 0 warning）。
   * ⚠️ 没发过的档：`present` 为真但字段是空的 ⇒ 正文用**默认那句**预填，
   *    强制/选择性则由超管自己选（`force=null` ⇒ 面板挡住"发布"）。
   */
  useEffect(() => {
    if (!slot) return
    const t = window.setTimeout(() => {
      const v = slot.version || APP_VERSION
      const f = slot.present ? slot.force : null
      setVersion(v)
      setForce(f)
      setNote(slot.note || releaseDefaultNote(v, f === true))
      setUrlApk(slot.urlApk)
      setUrlExe(slot.urlExe)
    }, 0)
    return () => window.clearTimeout(t)
  }, [slot])

  /** 正文的"自动那句"（版本/档位一变就跟着变，**除非超管自己改过**） */
  const autoNote = (v: string, f: boolean | null) => (v ? releaseDefaultNote(v, f === true) : '')
  const changeVersion = (v: string) => {
    setNote((cur) => (cur === autoNote(version, force) || !cur ? autoNote(v, force) : cur))
    setVersion(v)
  }
  const changeForce = (f: boolean) => {
    setNote((cur) => (cur === autoNote(version, force) || !cur ? autoNote(version, f) : cur))
    setForce(f)
  }

  const verdict = validateReleaseForm({
    target,
    enabled: true,
    version,
    force,
    note,
    urlApk,
    urlExe,
  })
  const label = target === 'classroom' ? '教室端' : '教师端'
  const canUnpublish = slot?.enabled === true

  const doSet = async (enabled: boolean) => {
    if (busy2) return
    setBusy2(true)
    setErr('')
    setMsg('')
    const r = await setRelease({ target, enabled, version, force: force === true, note, urlApk, urlExe })
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(
      enabled
        ? `已发布：${label} · v${version} · ${force ? '强制' : '选择性'} · 客户端 30 秒内会看到`
        : `已撤下：${label}（上次发的字段留着当下次预填）`,
    )
    onReload()
  }

  return (
    <div className="px-3.5 pb-3" data-rel-form={target}>
      {slot && !slot.present ? (
        <div
          className="mb-2 p-2.5"
          style={{
            background: 'var(--color-idlesoft)',
            border: '1px solid var(--color-line)',
            fontSize: 12,
            lineHeight: 1.75,
            color: 'var(--color-ink2)',
          }}
          data-rel-noseed
        >
          ⚠️ 数据库里**没有**这一档的种子行（`site_state` 的 `release:{target}`）——
          发布会被服务端拒掉（它不会假装成功）。去 Supabase → SQL Editor 跑一遍
          `schema.sql` 第 23 段 §23.2.1。
        </div>
      ) : null}

      {slot?.live ? (
        <div className="mb-2" style={{ fontSize: 12, lineHeight: 1.8 }} data-rel-live>
          <Line
            k="外面现在看到"
            v={
              <span style={{ color: 'var(--color-warn)' }}>
                v{slot.version} · {slot.force ? '强制' : '选择性'} · 正文「{String(slot.live.message ?? '')}」·
                链接：手机{slot.urlApk ? '有' : '无'} / 电脑{slot.urlExe ? '有' : '无'}
              </span>
            }
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
          版本号
          <input
            className="input"
            style={{ height: 32, fontSize: 12.5, width: 96 }}
            placeholder="1.1.1"
            value={version}
            onChange={(e) => changeVersion(e.target.value.trim())}
            data-rel-version
          />
        </label>
        <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
          <input
            type="radio"
            name={`rel-force-${target}`}
            checked={force === false}
            onChange={() => changeForce(false)}
            data-rel-force-soft
          />
          选择性（可关，但每次打开都弹）
        </label>
        <label className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
          <input
            type="radio"
            name={`rel-force-${target}`}
            checked={force === true}
            onChange={() => changeForce(true)}
            data-rel-force-hard
          />
          强制（关不掉）
        </label>
      </div>

      <textarea
        className="input mt-2"
        style={{ minHeight: 54, fontSize: 13, lineHeight: 1.7 }}
        placeholder={`公告正文（最多 ${RELEASE_NOTE_MAX} 字）。默认是「${RELEASE_NOTE_EXAMPLE}」`}
        value={note}
        maxLength={RELEASE_NOTE_MAX}
        onChange={(e) => setNote(e.target.value)}
        data-rel-note
      />
      <div className="mt-1" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }} data-rel-count>
        {note.length} / {RELEASE_NOTE_MAX} 字 · 标题固定为「{RELEASE_TITLE_SOFT}」/「{RELEASE_TITLE_FORCE}」
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
          手机链接
          <input
            className="input"
            style={{ height: 32, fontSize: 12.5, width: 300 }}
            placeholder="https://…/树高教务通-教师端-v1.1.1-vc30.apk（可空）"
            value={urlApk}
            onChange={(e) => setUrlApk(e.target.value)}
            data-rel-apk
          />
        </label>
        <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
          电脑链接
          <input
            className="input"
            style={{ height: 32, fontSize: 12.5, width: 300 }}
            placeholder="https://…/树高教务通-教师端-v1.1.1.exe（可空）"
            value={urlExe}
            onChange={(e) => setUrlExe(e.target.value)}
            data-rel-exe
          />
        </label>
      </div>
      <div className="mt-1" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
        {isReleaseUrl(urlApk) || !urlApk ? '' : '⚠️ 手机链接必须是 https:// 开头 · '}
        {isReleaseUrl(urlExe) || !urlExe ? '' : '⚠️ 电脑链接必须是 https:// 开头 · '}
        apk 与 exe 都是**要下载之后再装的**文件，老师得自己动手；两个都空 = 公告里不给按钮。
      </div>

      <div
        className="mt-2"
        data-rel-preview
        style={{
          fontSize: 12,
          lineHeight: 1.75,
          color: verdict.ok ? 'var(--color-ink2)' : 'var(--color-bad)',
        }}
      >
        {verdict.ok
          ? `发布后老师看到的是：「${releaseTitle(force === true)}」+「${note}」+ ${
              urlApk || urlExe ? '一个「下载最新版」按钮' : '**没有按钮**（两个链接都空）'
            }`
          : `⚠️ ${verdict.error}`}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={force === true ? 'danger' : 'primary'}
          disabled={busy2 || !verdict.ok}
          onClick={() => void doSet(true)}
          data-rel-publish
        >
          {force === true ? '发布（强制）' : '发布'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy2 || !canUnpublish}
          onClick={() => void doSet(false)}
          data-rel-unpublish
        >
          撤下这一档
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
          重新读取
        </Button>
        {slot?.updatedAt ? (
          <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            上次改动：{agoText(slot.updatedAt)}
            {slot.updatedBy ? ` · ${slot.updatedBy}` : ''}
          </span>
        ) : null}
      </div>

      {msg ? (
        <div className="mt-2 flex items-center gap-1.5" style={{ fontSize: 12.5, color: 'var(--color-ok)' }} data-rel-msg>
          <IconCheck size={14} />
          {msg}
        </div>
      ) : null}
      {err ? (
        <div className="mt-2 flex items-center gap-1.5" style={{ fontSize: 12.5, color: 'var(--color-bad)' }} data-rel-err>
          <IconAlert size={14} />
          {err}
        </div>
      ) : null}
    </div>
  )
}

/* ============================================================
   前端错误日志（`ErrorsCard`）
   ------------------------------------------------------------
   🔴 **隐私：B 类（可能升到 C，所以要防）**（方案 §4.1 逐条）：
      `message` / `stack` 里**可能夹到学生姓名**（老师自己写的 `throw new Error('张三…')`，
      或 Postgres 的 `Key (student_no)=(…) already exists`）。三条措施：
        ① 表里**根本没有**学生字段（不是"界面不渲染"，是**想显示都显示不出来**）；
        ② 固定一行 `PrivacyLine`（"请勿投屏或截图"）+ `stack` 默认折叠在 `<details>` 里；
        ③ `has_pii` 是**启发式**（邮箱 / 15+ 位数字）—— **屏上必须写明它是启发式**，
           **不许写成"已脱敏"**。
   🔴 **删除不可逆**：前端 `confirm` + 服务端再判一次（截止时间必须早于此刻）+ **写留痕**。
   🔴 **与 `syncError` / H 组的关系**在卡片上写清楚了（方案 §二.4 的"别重复"那一栏）：
      它们是**并列**不是替代 —— `syncError` 是"上一次写库失败的那一句话"（一个槽位、无历史），
      这张表是浏览器 JS 异常的时间序列；而 H 组是"服务端调用与设备心跳"。
   ============================================================ */

function ErrorsCard({
  report,
  error,
  judge,
  now,
  onReload,
  busy,
  headline,
}: {
  report: ErrorsReport | null
  error: string
  judge: { tone: Tone; text: string; notes: string[] }
  now: number
  onReload: () => void
  busy: boolean
  /** 卡上那句话（🔴 与 L0 清单里那一条**逐字同一句**） */
  headline: string
}) {
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [before, setBefore] = useState('')
  const [busy2, setBusy2] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const rows: AdminErrorRow[] = report?.rows ?? []
  const picked = rows.filter((r) => selected[r.id]).map((r) => r.id)

  const doSearch = async () => {
    setBusy2(true)
    setErr('')
    const r = await adminListErrors(keyword)
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(`筛出 ${r.report.shown} 条（最近 ${r.report.pageMax} 条里的）`)
    onReload()
  }

  /** 「全选本页」**只选当前这一页**（`limit ≤ 200`）—— 照参考项目，**不许扩成"全选全部"** */
  const selectAllPage = () => {
    const next: Record<string, boolean> = {}
    for (const r of rows) next[r.id] = true
    setSelected(next)
  }

  const doDeleteIds = async () => {
    if (!picked.length) return
    if (!window.confirm(`确认删除这 ${picked.length} 条错误日志？**删了就没了**（不可逆）。`)) return
    setBusy2(true)
    setErr('')
    const r = await adminDeleteErrors({ ids: picked })
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(`已删除 ${r.deleted} 条（操作已留痕）`)
    setSelected({})
    onReload()
  }

  const doDeleteBefore = async () => {
    const ms = inputToMs(before)
    if (ms === null) {
      setErr('先选一个截止日期')
      return
    }
    if (!window.confirm(`确认清理 ${new Date(ms).toLocaleString('zh-CN')} 之前的全部错误日志？**不可逆**。`)) return
    setBusy2(true)
    setErr('')
    const r = await adminDeleteErrors({ before: ms })
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(`已清理 ${r.deleted} 条（操作已留痕）`)
    onReload()
  }

  return (
    <Card
      tone={judge.tone}
      title="前端错误日志"
      headline={headline}
      note={
        report === null
          ? error || '正在读…'
          : `共 ${report.total ?? '读不到'} 条 · 这一页显示 ${report.shown} 条（上限 ${report.pageMax}）`
      }
      openLabel="看明细 / 清理"
    >
      {report === null ? (
        <div className="px-3.5 py-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          {error ? (
            <>
              <b>读不到</b>：{error}
              <br />⚠️ **读不到不是"没有错误"** —— 这一格永远是灰的。
            </>
          ) : (
            '正在读…'
          )}
        </div>
      ) : null}
      {/* 🔴 下面这一块是**口径**（"这张表怎么读"），与这一轮有没有读到数**无关**：
          「匿名也能上报」「has_pii 是启发式、不许当成"已脱敏"」说的都是产品的判据，
          本地演示模式（没有 `/api/admin/errors`）里它们同样该在屏上。
          原来整块写在 `report !== null` 那一支里 → 本地模式屏上只剩一句"读不到"，
          而 `shots.mjs` 那两条断言照着"有服务端"写 → 真界面空着、断言却在别处绿。 */}
      <div
        className="px-3.5 py-2"
        style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.85 }}
      >
        {report === null ? null : (
          <>
            · 近 24 小时 <b className="num">{report.last24h ?? '读不到'}</b> 条 ·
            历史共 <b className="num">{report.total ?? '读不到'}</b> 条
            <br />
          </>
        )}
            · 上报走的是 `report_frontend_error()`（**匿名也能调**：登录页 / 教室端 /
        hydrate 失败那三个现场都没有会话）；它自己做**截断**（message 500 / stack 2000 /
        ua 300）与**限流**（同一人 5 分钟 20 条 + 全表 5 分钟 200 条兜底）。
        <br />· 与 `syncError` **并列不替代**：那是"上一次写库失败的那一句话"（一个字符串槽位、
        没有时间没有历史）；这一张是浏览器 JS 异常的时间序列。与 H 组（调用与设备心跳）
        **零重叠** —— 但"推送断了心跳照常"在浏览器侧的症状常常就是一批未处理的 Promise。
      </div>

      <PrivacyLine />
      <div
        className="mx-3.5 mb-2 p-2.5"
        style={{
          background: 'var(--color-idlesoft)',
          border: '1px solid var(--color-line)',
          borderRadius: 4,
          fontSize: 11.5,
          lineHeight: 1.75,
          color: 'var(--color-ink2)',
        }}
      >
        ⚠️ 带「疑似含隐私」标记的行是**启发式**判出来的（邮箱 / 连续 15+ 位数字），
        **它会有漏、也可能误标** —— 所以**不许**把这一栏当成"已脱敏"。
        这张表里**根本没有**学生字段（想显示都显示不出来）。
      </div>
      {report === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2">
            <input
              className="input"
              style={{ height: 34, fontSize: 13, width: 220 }}
              placeholder="关键字（同时匹账号与错误文本）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              data-err-keyword
            />
            <Button size="sm" icon={<IconSearch size={14} />} disabled={busy2} onClick={() => void doSearch()}>
              筛选
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || busy2} onClick={onReload}>
              重新读取
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2">
            <Button size="sm" variant="ghost" icon={<IconList size={14} />} onClick={selectAllPage} data-err-select-page>
              全选本页（{rows.length}）
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<IconTrash size={14} />}
              /* ⚠️ 真 `disabled`（不是"灰一下还能点"） */
              disabled={!picked.length || busy2}
              onClick={() => void doDeleteIds()}
              data-err-delete
            >
              删除选中（{picked.length}）
            </Button>
            <label className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
              <input
                type="datetime-local"
                className="input"
                style={{ height: 32, fontSize: 12.5, width: 186 }}
                value={before}
                onChange={(e) => setBefore(e.target.value)}
                data-err-before
              />
              之前
            </label>
            <Button size="sm" variant="ghost" disabled={busy2} onClick={() => void doDeleteBefore()} data-err-clean>
              清理此日期前
            </Button>
          </div>
          {msg ? (
            <div className="px-3.5 pb-2" style={{ fontSize: 12.5, color: 'var(--color-ok)' }}>
              <IconCheck size={13} /> {msg}
            </div>
          ) : null}
          {err ? (
            <div className="px-3.5 pb-2" style={{ fontSize: 12.5, color: 'var(--color-bad)' }}>
              <IconAlert size={13} /> {err}
            </div>
          ) : null}

          <SubHead>最近 {rows.length} 条（新→旧）</SubHead>
          {/* 大表格类功能：窄屏给一句"请在电脑上使用"的口径（不是不显示，是提醒） */}
          <div className="px-3.5 pb-1 lg:hidden" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            ⚠️ 这一栏是明细表格，**在电脑上看得清楚得多**（手机上一行会被折成好几段）。
          </div>
          {rows.length === 0 ? (
            <div className="px-3.5 py-2" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
              这一页没有命中任何一条。
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.id}
                data-err-row={r.id}
                className="px-3.5 py-2"
                style={{ borderTop: '1px solid var(--color-line)', fontSize: 12.5 }}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={selected[r.id] === true}
                    onChange={(e) => setSelected((s) => ({ ...s, [r.id]: e.target.checked }))}
                    style={{ marginTop: 3 }}
                    aria-label={`选择 ${r.id}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span style={{ color: 'var(--color-ink3)' }}>
                        {r.at ? `${new Date(r.at).toLocaleString('zh-CN')}（${agoText(r.at, now)}）` : '时间读不到'}
                      </span>
                      <span className="tag tag-idle">{r.username || '（未登录）'}</span>
                      <span className="tag tag-idle">{r.role || '身份未记录'}</span>
                      <span className="tag tag-idle">{r.env === 'kiosk' ? '教室端' : '教师端'}</span>
                      {r.hasPii ? <span className="tag tag-warn">疑似含隐私（启发式）</span> : null}
                    </div>
                    <div style={{ color: 'var(--color-bad)', wordBreak: 'break-word', marginTop: 2 }}>
                      {r.message}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      页面 <code>{r.view || '（没记）'}</code>
                      {r.syncError ? (
                        <>
                          {' '}· 当时的 syncError：<code>{r.syncError}</code>
                        </>
                      ) : null}
                    </div>
                    {r.stack ? (
                      <details style={{ fontSize: 11.5, color: 'var(--color-ink2)' }}>
                        <summary style={{ cursor: 'pointer', color: 'var(--color-accenttext)' }}>
                          堆栈（默认折叠 —— 它可能夹到学生姓名）
                        </summary>
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '4px 0 0' }}>
                          {r.stack}
                        </pre>
                      </details>
                    ) : null}
                    {r.ua ? (
                      <div style={{ fontSize: 11, color: 'var(--color-ink4)', wordBreak: 'break-word' }}>
                        {r.ua}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
          {judge.notes.map((n, i) => (
            <div
              key={i}
              className="px-3.5 py-1.5"
              style={{
                borderTop: '1px solid var(--color-line)',
                fontSize: 11.5,
                color: 'var(--color-ink3)',
                lineHeight: 1.75,
              }}
            >
              · {n}
            </div>
          ))}
        </>
      )}
    </Card>
  )
}

/* ============================================================
   用户反馈（`FeedbackCard`）
   ------------------------------------------------------------
   🔴 **红线**（I51）：`mail_state <> 'sent'` 的条数**必须显式报警** ——
      没配 key 时不能静默，否则老师提的意见躺在一个没人打开的页面里，
      而**双方都以为送到了**（老师那边看到的是"已送到"，那是对的：它真的进库了）。
   🔴 **隐私：B 类**（正文是老师手写的自由文本，**很可能提到具体学生**）：
      固定一行 `PrivacyLine`；`contact` **只在明细里**出现，不摆在列表行上；
      **不做**任何"统计提到最多的学生"这类自动分析（那会变成行为监控）。
   ============================================================ */

function FeedbackCard({
  report,
  error,
  judge,
  now,
  onReload,
  busy,
  headline,
}: {
  report: AdminFeedbackReport | null
  error: string
  judge: { tone: Tone; text: string; notes: string[] }
  now: number
  onReload: () => void
  busy: boolean
  /** 卡上那句话（🔴 与 L0 清单里那一条**逐字同一句**） */
  headline: string
}) {
  const [keyword, setKeyword] = useState('')
  const [busy2, setBusy2] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [replyOf, setReplyOf] = useState('')
  const [replyText, setReplyText] = useState('')

  const rows = report?.rows ?? []

  const doSearch = async () => {
    setBusy2(true)
    setErr('')
    const r = await adminListFeedback(keyword)
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(`筛出 ${r.report.shown} 条`)
    onReload()
  }

  const doHandled = async (id: string, handled: boolean, reply = '') => {
    setBusy2(true)
    setErr('')
    const r = await adminSetFeedbackHandled(id, handled, '', reply)
    setBusy2(false)
    if (!r.ok) {
      setErr(r.message)
      return
    }
    setMsg(handled ? '已标记为已处理（老师下一次打开「我的」会看到）' : '已改回未处理')
    setReplyOf('')
    setReplyText('')
    onReload()
  }

  return (
    <Card
      tone={judge.tone}
      title="用户反馈"
      headline={headline}
      note={
        report === null
          ? error || '正在读…'
          : `共 ${report.total ?? '读不到'} 条 · 未处理 ${report.open ?? '读不到'} · 邮件没发出去 ${
              report.mailBad ?? '读不到'
            } 条`
      }
      openLabel="看明细"
    >
      {report === null ? (
        <div className="px-3.5 py-3" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          {error ? (
            <>
              <b>读不到</b>：{error}
              <br />⚠️ **读不到不是"没有人提过"** —— 这一格永远是灰的。
            </>
          ) : (
            '正在读…'
          )}
        </div>
      ) : null}
      {/* 🔴 邮件没发出去：**这一条必须显式报警**（I51 的末句）。
          ⚠️ 它**依赖取数结果**（`report.mailBad`），所以留在 `report !== null` 这一侧，
             而下面的口径块不是 —— 两者原来在同一个 `<>` 里，是本轮拆开的原因。 */}
      {report !== null && report.mailBad ? (
        <div
          className="mx-3.5 my-2 p-2.5"
          data-fb-mail-warn
          style={{
            background: 'var(--color-badsoft)',
            border: '1px solid var(--color-badline)',
            color: 'var(--color-badink)',
            borderRadius: 4,
            fontSize: 12.5,
            lineHeight: 1.8,
          }}
        >
          ⚠️ <b>有 {report.mailBad} 条反馈没发到你邮箱</b>（它们**照常落库了**，所以没有丢）。
          <br />
          为什么这算红：反馈是**先落库、再发信** —— 落库那一步是成功的，
          但**没人通知你**就等于没人看见。去左边「维护」那一栏点一下「发测试邮件」验通道。
        </div>
      ) : null}
      {/* 🔴 口径块**不放在取数分支里**（2026-09-26 修）：「先落库、再发信」「反馈 ≠ 通知」说的是
          **这张表怎么读**，与这一轮有没有读到数无关（本地演示模式没有 `/api/feedback`，
          这一格是灰的 —— 但灰的是数，不是口径）。理由与 `ErrorsCard` 那一处逐字相同。 */}
      <div
        className="px-3.5 py-2"
        style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.85 }}
      >
        · **先落库、再发信**：插入成功就算"已送到"（用户在「我的」里看得到那一条）；
        发信失败**不回滚**，只把 `mail_state` / `mail_error` 留在这一行上。
        <br />· **反馈 ≠ 通知**：通知是**学校对老师**说话（有收件范围、有未读）；
        反馈是**老师对学校**说话（收件人就是你这个邮箱）。两张表、两个接口、零复用。
        <br />· **不允许匿名提交**：登录不上 / 页面报错走「前端错误日志」那条路。
      </div>
      <PrivacyLine />
      {report === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pb-2">
            <input
              className="input"
              style={{ height: 34, fontSize: 13, width: 220 }}
              placeholder="关键字（同时匹姓名与正文）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              data-fb-keyword
            />
            <Button size="sm" icon={<IconSearch size={14} />} disabled={busy2} onClick={() => void doSearch()}>
              筛选
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || busy2} onClick={onReload}>
              重新读取
            </Button>
          </div>
          {msg ? (
            <div className="px-3.5 pb-2" style={{ fontSize: 12.5, color: 'var(--color-ok)' }}>
              <IconCheck size={13} /> {msg}
            </div>
          ) : null}
          {err ? (
            <div className="px-3.5 pb-2" style={{ fontSize: 12.5, color: 'var(--color-bad)' }}>
              <IconAlert size={13} /> {err}
            </div>
          ) : null}

          <SubHead>最近 {rows.length} 条（新→旧）</SubHead>
          <div className="px-3.5 pb-1 lg:hidden" style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
            ⚠️ 明细表格**在电脑上看**（手机上一行会折成好几段）。
          </div>
          {rows.length === 0 ? (
            <div className="px-3.5 py-2" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
              还没有反馈（或者这一页没有命中）。
            </div>
          ) : (
            rows.map((r) => {
              const mailBadNow = r.mailState !== 'sent'
              return (
                <div
                  key={r.id}
                  data-fb-row={r.id}
                  className="px-3.5 py-2"
                  style={{ borderTop: '1px solid var(--color-line)', fontSize: 12.5 }}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span style={{ color: 'var(--color-ink3)' }}>
                      {r.createdAt ? `${new Date(r.createdAt).toLocaleString('zh-CN')}（${agoText(r.createdAt, now)}）` : '时间读不到'}
                    </span>
                    <span className="tag tag-idle">{r.authorName || '（没有姓名快照）'}</span>
                    {r.authorRoles ? <span className="tag tag-idle">{r.authorRoles}</span> : null}
                    <span className={r.handledAt ? 'tag tag-ok' : 'tag tag-warn'}>
                      {r.handledAt ? '已处理' : '未处理'}
                    </span>
                    <span className={mailBadNow ? 'tag tag-bad' : 'tag tag-ok'}>
                      邮件：{r.mailState === 'sent' ? '已发' : r.mailState === 'pending' ? '未试发' : r.mailState === 'skipped' ? '没发（跳过）' : '失败'}
                    </span>
                    <span className="tag tag-idle">页面 {r.page || '（没记）'}</span>
                  </div>
                  <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {r.body}
                  </div>
                  {r.contact ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 2 }}>
                      {/* ⚠️ `contact` **只在明细里**出现（列表行上不摆 —— 方案 §4.1 的第三条落地） */}
                      联系方式：<code>{r.contact}</code>
                    </div>
                  ) : null}
                  {r.mailError ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-bad)', marginTop: 2 }}>
                      邮件没发出去的原因：{r.mailError}
                    </div>
                  ) : null}
                  {r.internalNote ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 2 }}>
                      内部备注：{r.internalNote}
                    </div>
                  ) : null}
                  {r.reply ? (
                    <div style={{ fontSize: 11.5, color: 'var(--color-ink2)', marginTop: 2 }}>
                      已回复：{r.reply}
                    </div>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {r.handledAt ? (
                      <Button size="sm" variant="ghost" disabled={busy2} onClick={() => void doHandled(r.id, false)}>
                        改回未处理
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy2}
                        onClick={() => void doHandled(r.id, true, '')}
                        data-fb-handle={r.id}
                      >
                        标记已处理
                      </Button>
                    )}
                    {replyOf === r.id ? (
                      <>
                        <input
                          className="input"
                          style={{ height: 32, fontSize: 12.5, flex: '1 1 220px' }}
                          placeholder="给老师的回复（他会看到）"
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy2}
                          onClick={() => void doHandled(r.id, true, replyText)}
                        >
                          连同回复一起标记已处理
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setReplyOf('')}>
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setReplyOf(r.id)
                          setReplyText(r.reply)
                        }}
                      >
                        回复
                      </Button>
                    )}
                  </div>
                </div>
              )
            })
          )}
          {judge.notes.map((n, i) => (
            <div
              key={i}
              className="px-3.5 py-1.5"
              style={{
                borderTop: '1px solid var(--color-line)',
                fontSize: 11.5,
                color: 'var(--color-ink3)',
                lineHeight: 1.75,
              }}
            >
              · {n}
            </div>
          ))}
          <HintOnly>
            反馈**不做附件**（本项目已经有一套 `shared_files` + 一条"别造第二套文件系统"的纪律；
            而硬挂上去会出现"老师传给管理员的截图，教室里那块屏也看得见"）。
            真要给证据：写清"在哪个页面点了什么"比一张截图有用（错误日志已经自动带页面了）。
          </HintOnly>
        </>
      )}
    </Card>
  )
}

/* 文件到此为止 —— 第二期新增的四个分区组件都在上面（DbCard / MaintenanceCard /
   ErrorsCard / FeedbackCard），外壳是 AdminFrame + Tiles。 */


