/* ============================================================
   通知 —— 前端调用 `/api/notice` 的那一层（2026-09-28）
   ------------------------------------------------------------
   服务端（`functions/api/notice.ts`）才是闸门：
   · **读**走数据库的 RLS（`notices_visible` 策略，schema.sql §21.7）——
     教室端读不到、范围外的人读不到，都是数据库在拦，**前端一个字都插不上手**；
   · **写**（发 / 撤下 / 置顶）在服务端拿你的 JWT 去问
     `can_publish_notice_to()` / `is_school_admin()`。
   这里只做三件事：带 JWT、把错误翻成人话、**表还没建时不崩**。

   🔴 四条不能破的纪律：
     ① **教室端读不到通知**（I47）—— 这不是"界面上不渲染"，是**拿不到**：
        那块屏的 App 分支根本到不了这些页面，而数据库那一边也一条都不给它。
        ⚠️ 所以这里**不要**加任何"教室端过滤"的代码：多一处前端过滤
        就等于多一个"同一件事两个判定入口"。
     ② **通知绝不进早间欢迎弹窗**（I48）—— 弹窗的内容只能是"算出来的待办"。
        本文件不导出任何给 `useMood` / `MorningWelcome` 用的东西，是**故意**的。
     ③ **表没跑过时前端不崩**：线上库还没跑 `schema.sql` 第 21 段时，
        探测到 `missing` 就返回空包 + 一句人话，页面显示空态。
        （照 `ensureExamTables()` / `ensureSubjectCols()` / `ensureSerialCols()` 那套。）
     ④ **探针不许假设任何一列存在**（这一类 bug 在本仓库咬过**两次**，2026-09-28 是第二次）：
        探"这张表在不在"就用 `select('*')` —— `notice_targets` **没有 `id`**
        （§21.4），拿 `select('id')` 去探会得到 `42703`，而那句**不是**"表不在"的证据。
        同理，「表不在」与「列不在」是**两条判据**，不许合成一条泛化的 `does not exist`
        （`nav-checks.mjs` 的 **D10** 已经把这两条都钉成静态断言）。
   ============================================================ */

import { getSupabase } from './supabase'
import { departmentName } from './departments'
import { roleName } from './roles'
import { subjectShort } from './subjects'
import {
  EMPTY_NOTICE_BUNDLE,
  type Notice,
  type NoticeBundle,
  type NoticeScopeOption,
  type NoticeTarget,
} from '../data/types'

/* ---------------- 探测：通知那两张表在不在？（schema.sql 第 21 段） ----------------

   与 `ensureExamTables()` **同一套纪律**，判据不同：这次探的是**表**。
   判据只有「表不存在」这一种：网络抖动、权限问题一律当作**在**
   （否则一次抖动就把通知永久停掉，比偶发失败严重得多）。
   ⚠️ "探测本身失败"（断网）**不缓存** —— 缓存住会把临时故障固化成永久状态。

   🔴 **这一类 bug 咬过两次**（第一次是超管面板探 `subjects`）：
      **拿 `select('id')` 当"这张表在不在"的探针 —— 而 `notice_targets` 没有 `id`**
      （列是 `notice_id` / `target_kind` / …,schema.sql §21.4）→ PostgREST 回
      `42703 column notice_targets.id does not exist` → 被泛判据当成"表不在"
      → 通知页谎报「数据库里还没有通知表」，而两张表明明都在。
      → **表存在性只问"这张表在不在"，探针不许假设任何一列存在**（`select('*')`）。
   ---------------------------------------------------------------------------- */

type ProbeState = 'present' | 'missing' | 'indeterminate'

let noticeProbe: Promise<ProbeState> | null = null

/*
 * 「**表**不在」的判据 —— 只认这三样：`42P01` / `PGRST205` / 文案里带 `relation … does not exist`
 * （口径与 `lib/adminChart.ts` §C1 的 `MISSING_TABLE_RE` **逐字一致**，别各写一套）。
 *
 * 🔴 这里**绝不能**把 `42703`（`undefined_column`）当成"表不在"，也**绝不能**只写一个
 *    泛化的 `/does not exist/i` —— `column <表>.<列> does not exist` 里也有这两个词，
 *    而那说的**只是"这一列不在"**，不是"这张表没建"（那正是上面那次误报的形状）。
 *    ⚠️ `schema cache` 同理：`Could not find the 'x' column … in the schema cache`
 *    属于**列**不在，所以这里只认限定过的 `Could not find the table`。
 *
 * 🔴 「列不在」是**另一条判据**（下面那条 `MISSING_COL_RE`），探针里**先**问它：
 *    `42703` / `PGRST204` 都走 `has()` 的 `return null` —— 结论是**灰**（"无法判断"），
 *    页面**不会**显示"先把 SQL 跑一遍"（那会让人去跑一段本来已经跑过的 SQL）。
 */
const MISSING_TABLE_RE = /42P01|PGRST205|Could not find the table|relation .+ does not exist/i
/** 「**列**不在」：`42703` / `PGRST204` / `column … does not exist`（与上面那条成对，判据分流） */
const MISSING_COL_RE = /42703|PGRST204|column .+ does not exist/i

async function probeNoticeTables(): Promise<ProbeState> {
  const sb = getSupabase()
  if (!sb) return 'missing'
  const has = async (table: string): Promise<boolean | null> => {
    try {
      /* 🔴 `select('*')`，**不是 `select('id')`** —— 表存在性与"有哪几列"无关（见上面那段） */
      const { error } = await sb.from(table).select('*').limit(1)
      if (!error) return true
      const code = String((error as { code?: string }).code ?? '')
      const msg = String(error.message ?? '')
      // 「列不在」先摘出去：**表探针拿到它只能记灰**，绝不能据此说"表不在"
      if (MISSING_COL_RE.test(code) || MISSING_COL_RE.test(msg)) return null
      // 只有「表不在」才是 false；认不出的错一律 null（灰），不缓存
      if (MISSING_TABLE_RE.test(code) || MISSING_TABLE_RE.test(msg)) return false
      return null
    } catch {
      return null
    }
  }
  const [notices, targets] = await Promise.all([has('notices'), has('notice_targets')])
  if (notices === false || targets === false) return 'missing'
  if (notices === null || targets === null) {
    noticeProbe = null // 没结论不缓存，下次重探
    return 'indeterminate'
  }
  return 'present'
}

/** 探一次（同一页面内只探一次） */
export function ensureNoticeTables(): Promise<ProbeState> {
  if (!noticeProbe) noticeProbe = probeNoticeTables()
  return noticeProbe
}

/** 清掉探测缓存（"重试"按钮用；只清缓存、不写任何东西） */
export function resetNoticeProbe(): void {
  noticeProbe = null
}

/* ---------------- 调 `/api/notice` ---------------- */

const NEED_STAGE21 =
  '数据库还没跑通知那一段（仓库里 supabase/schema.sql 第 21 段）。' +
  '到 Supabase → SQL Editor 跑一遍再回来；刚跑完的话等十几秒让接口刷新一下缓存。'

async function call(body: Record<string, unknown>): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; message: string; missing?: boolean }
> {
  const sb = getSupabase()
  const session = sb ? (await sb.auth.getSession()).data.session : null
  const token = session?.access_token
  if (!token) return { ok: false, message: '登录已过期，请重新登录后再试' }

  let res: Response
  try {
    res = await fetch('/api/notice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, message: '网络不通，这次操作没有发出去' }
  }

  const text = await res.text()
  let payload: Record<string, unknown> = {}
  try {
    const v = JSON.parse(text || '{}')
    if (v && typeof v === 'object') payload = v as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (res.ok) return { ok: true, data: payload }
  if (res.status === 404) {
    return {
      ok: false,
      message: '通知服务暂时不可用，请稍后再试。',
    }
  }
  const message = String(payload.message ?? `操作失败（HTTP ${res.status}）`)
  return { ok: false, message, missing: message.includes('第 21 段') }
}

/* ---------------- 具体动作 ---------------- */

const asNotice = (raw: Record<string, unknown>): Notice => ({
  id: String(raw.id ?? ''),
  title: String(raw.title ?? ''),
  body: String(raw.body ?? ''),
  scopeKind: String(raw.scopeKind ?? 'school') as Notice['scopeKind'],
  senderId: String(raw.senderId ?? ''),
  createdAt: Number(raw.createdAt ?? 0),
  expiresAt: raw.expiresAt === null || raw.expiresAt === undefined ? null : Number(raw.expiresAt),
  pinned: raw.pinned === true,
  revokedAt: raw.revokedAt === null || raw.revokedAt === undefined ? null : Number(raw.revokedAt),
  expired: raw.expired === true,
  mine: raw.mine === true,
  unread: raw.unread === true,
  targets: Array.isArray(raw.targets)
    ? (raw.targets as Record<string, unknown>[]).map((t) => ({
        kind: String(t.kind ?? 'school') as Notice['scopeKind'],
        gradeId: (t.gradeId as string | null) ?? null,
        subjectCode: (t.subjectCode as string | null) ?? null,
        targetRole: (t.targetRole as string | null) ?? null,
        /* 🆕 老库 / 老缓存里没有这一列 → `?? null`（前端不会因为少一个字段崩） */
        department: (t.department as string | null) ?? null,
        teacherId: (t.teacherId as string | null) ?? null,
      }))
    : [],
})

/**
 * 读通知（含"我能发哪些范围"与未读数）。
 *
 * 🔴 **它不需要"有没有权限"这个前提**：看通知 = 所有老师（I39）。
 *    读的范围由数据库 RLS 决定，这里**不筛**。
 */
export async function loadNotices(): Promise<NoticeBundle> {
  const state = await ensureNoticeTables()
  /*
   * 三种结论各自的处置（**"无法判断"是独立的第三种状态**，不能归到绿也不能归到红）：
   *   · `present`        → 正常读
   *   · `missing`        → 表真的不在（第 21 段没跑）→ 空包 + 页面显示"先跑 SQL"
   *   · `indeterminate`  → 探测本身没结论（断网）→ 空包，`noticesState` 记 **`unknown`**：
   *     页面**不显示那句"先把 SQL 跑一遍"**（那会让人去跑一段本来已经跑过的 SQL）。
   */
  if (state === 'indeterminate') return { ...EMPTY_NOTICE_BUNDLE, state: 'unknown' }
  if (state === 'missing') return { ...EMPTY_NOTICE_BUNDLE, state: 'missing' }

  const res = await call({ action: 'list' })
  if (!res.ok) {
    return { ...EMPTY_NOTICE_BUNDLE, state: res.missing ? 'missing' : 'unknown' }
  }
  const d = res.data
  const scopes: NoticeScopeOption[] = Array.isArray(d.scopes)
    ? (d.scopes as Record<string, unknown>[]).map((s) => ({
        scopeKind: String(s.scopeKind ?? 'school') as NoticeScopeOption['scopeKind'],
        gradeId: (s.gradeId as string | null) ?? null,
        gradeName: (s.gradeName as string | null) ?? null,
        subjectCode: (s.subjectCode as string | null) ?? null,
        roleCode: (s.roleCode as string | null) ?? null,
        /* 🆕 部门那一维（老服务端 / 老库上这一列没有 → null，选项自然不出现） */
        departmentCode: (s.departmentCode as string | null) ?? null,
      }))
    : []
  return {
    state: 'present',
    canPublish: d.canPublish === true,
    scopes,
    notices: Array.isArray(d.notices) ? (d.notices as Record<string, unknown>[]).map(asNotice) : [],
    unread: Number(d.unread ?? 0),
    seenAt: d.seenAt === null || d.seenAt === undefined ? null : Number(d.seenAt),
  }
}

/** 把"我上次看到哪儿"推到最新。未读数归 0 —— 但**没有**任何"谁读过哪一条"的记录（I49）。 */
export async function markNoticesSeen(atMs = Date.now()): Promise<boolean> {
  const res = await call({ action: 'seen', seenAtMs: atMs })
  return res.ok
}

export type PublishInput = {
  title: string
  body: string
  scopeKind: string
  gradeId?: string
  subjectCode?: string
  targetRole?: string
  /** 🆕 收件范围 = 某个职能部门时的部门代码 */
  department?: string
  teacherIds?: string[]
  /** 有效期（天）。0 / 不传 = 不过期 */
  expiresInDays?: number
}

/** 发通知。🔴 能不能发给这个范围**只有服务端说了算**（403 时 message 直接给人看） */
export const publishNotice = (input: PublishInput) =>
  call({ action: 'create', ...input, teacherIds: input.teacherIds ?? [] })

/** 撤下（不删行）。⚠️ 只能撤自己发的 —— 例外是教务处与超管 */
export const revokeNotice = (noticeId: string) => call({ action: 'revoke', noticeId })

/** 置顶 / 取消置顶。⚠️ 只有教务处与超管能置顶别人的通知 */
export const pinNotice = (noticeId: string, pinned: boolean) =>
  call({ action: 'pin', noticeId, pinned })

export { NEED_STAGE21 }

/* ---------------- 显示用的小工具（放在这里而不是页面里） ----------------

   为什么在 lib 里而不是 `pages/Notices.tsx`：**两个页面都要写这一行**
   （通知页 + 工作台那一块），而 oxlint 的 `react(only-export-components)`
   不允许页面文件导出非组件 —— 那条规则是对的：一个页面文件导出别的东西，
   Fast Refresh 就会整页失效。所以它住在数据层这一侧。
   ---------------------------------------------------------------------- */

/**
 * 「发给谁」这一行怎么写。
 *
 * ⚠️ 用的是**范围**（数据库存的就是范围，不是名单 —— I50），
 *    所以这里是"全校老师 / 高二的老师"这种说法，而不是一串人名。
 * ⚠️ 年级名/学科名**不在这里编**：前端只拿到 id 与 code，拿不到名字就写代码 ——
 *    宁可显示 `physics`，也不谎报一个学科名（`roleName()` 的同一条纪律）。
 */
export function noticeScopeText(n: Notice): string {
  const kinds = [...new Set(n.targets.map((t) => t.kind))]
  const one = (t: NoticeTarget) => {
    switch (t.kind) {
      case 'school':
        return '全校老师'
      case 'grade':
        return '本年级的老师'
      case 'subject':
        return t.subjectCode
          ? `${subjectShort(t.subjectCode, t.subjectCode)} 全体老师`
          : '本学科的老师'
      case 'grade_subject':
        return `本年级 · ${t.subjectCode ? subjectShort(t.subjectCode, t.subjectCode) : '本学科'}`
      case 'role':
        return `全部${roleName(t.targetRole)}`
      /* 🆕 某个职能部门：写部门名，而不是"一批老师"。认不出的代码原样回显
         （`departmentName()` 的口径：不猜、也不吞掉）。 */
      case 'department':
        return t.department ? `${departmentName(t.department)}全体` : '某个职能部门'
      case 'custom':
        return '指定的几位老师'
      default:
        return '老师'
    }
  }
  const first = n.targets[0]
  if (kinds.length === 1 && first) return `发给：${one(first)}`
  return '发给：一批老师'
}
