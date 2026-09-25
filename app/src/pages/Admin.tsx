import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../data/store'
import { getSupabase, isRemote, connectionMode, SUPABASE_URL } from '../lib/supabase'
import { APP_VERSION, APP_VERSION_LABEL, BUILD_HASH } from '../lib/version'
import { deviceRole, deviceRoleAt, authDaysLeft } from '../lib/session'
import { isSuperAdmin } from '../lib/roles'
import { getExamTablesProbeStatus, probeReport, type ProbeReport } from '../data/remote'
import { displayNoOfArchiveKey, studentOfArchiveKey } from '../lib/keys'
import type { Klass } from '../data/types'
import {
  agoText,
  humanBytes,
  judgeBackup,
  judgeR2,
  judgeServiceKey,
  probeSchemaDrift,
  scanAssignmentContradictions,
  dirtyGroups,
  driftSummary,
  driftTone,
  worstTone,
  R2_KEYS,
  NO_PROBE_REASON,
  type BackupFacts,
  type DriftSection,
  type SecretFacts,
  type Tone,
} from '../lib/adminChart'
import { Button } from '../components/ui'
import {
  IconAlert,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconInfo,
  IconRefresh,
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

const TONE_STYLE: Record<Tone, { dot: string; chip: string; text: string }> = {
  ok: { dot: 'var(--color-ok)', chip: 'tag tag-ok', text: '正常' },
  warn: { dot: 'var(--color-warn)', chip: 'tag tag-warn', text: '需要处理' },
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
  children,
  openLabel = '看明细',
}: {
  tone: Tone
  title: string
  headline: string
  note?: string
  children?: React.ReactNode
  openLabel?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="panel mb-3 overflow-hidden" data-tone={tone}>
      <div className="flex items-start gap-3 p-3.5">
        <span style={{ paddingTop: 5 }}>
          <Dot tone={tone} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontSize: 14.5, fontWeight: 650 }}>{title}</span>
            <span className={TONE_STYLE[tone].chip}>{TONE_STYLE[tone].text}</span>
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
        border: '1px solid ***REMOVED***ecd9ae',
        color: '***REMOVED***8a5a12',
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
    const email = account.includes('@') ? account.trim() : `${account.trim()}@qq.com`
    const { error } = await sb.auth.signInWithPassword({ email, password: pwd })
    if (error) {
      setBusy(false)
      setErr(error.message === 'Invalid login credentials' ? '邮箱或密码不正确' : error.message)
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
              border: '1px solid ***REMOVED***ecd9ae',
              borderRadius: 4,
              fontSize: 12.5,
              lineHeight: 1.7,
              color: '***REMOVED***8a5a12',
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
              style={{ color: 'var(--color-accent)', fontSize: 12 }}
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
      const r = await fetch('/api/admin/config-check', {
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

  /* 3. C2 前端探测汇总（读现成状态，**不改任何写入路径**） */
  const probes: ProbeReport = useMemo(() => probeReport(), [])
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

  const allTones = [toneDeploy, toneConfig, toneSchema, toneData, toneBackup]
  const toneAll = worstTone(allTones)
  const badCount = allTones.filter((t) => t === 'bad').length
  const warnCount = allTones.filter((t) => t === 'warn').length
  const unknownCount = allTones.filter((t) => t === 'unknown').length

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
    <Shell>
      {/* ---------------- L0 健康条 ---------------- */}
      <div className="px-4 pt-4" style={{ maxWidth: 760, margin: '0 auto' }} data-admin-l0={toneAll}>
        <div className="panel overflow-hidden">
          <div className="flex items-center gap-3 p-3.5">
            <Dot tone={toneAll} />
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 16, fontWeight: 680 }} data-admin-headline>
                {toneAll === 'bad'
                  ? `平台有问题 · ${badCount} 项需要处理`
                  : toneAll === 'warn'
                    ? `平台基本正常 · ${warnCount} 项需要处理`
                    : toneAll === 'unknown'
                      ? `平台状态无法完全判断 · ${unknownCount} 项拿不到数据`
                      : '平台正常 · 没有发现异常'}
              </div>
              <div
                className="mt-0.5"
                style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}
              >
                {APP_VERSION_LABEL}（{hashMissing ? '哈希取不到' : '构建哈希已显示'}）· 备份{' '}
                {backup.text.replace(/^备份\s*/, '').slice(0, 26)} · 作业档案 {contradictions.scanned}{' '}
                份
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconRefresh size={14} />}
              onClick={() => {
                reloadServer()
                reloadDrift()
              }}
            >
              重测
            </Button>
          </div>
          {localMode ? (
            <div
              className="flex items-start gap-2 px-3.5 py-2.5"
              style={{
                background: 'var(--color-badsoft)',
                borderTop: '1px solid ***REMOVED***f3c9cd',
                color: '***REMOVED***8f1c26',
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
                borderTop: '1px solid ***REMOVED***ecd9ae',
                color: '***REMOVED***8a5a12',
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
                borderTop: '1px solid ***REMOVED***f3c9cd',
                color: '***REMOVED***8f1c26',
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

        <div className="mt-3" />

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
          headline={
            localMode
              ? '**本地模式** —— 平台上所有数据其实只在这台浏览器里'
              : hashMissing
                ? `${APP_VERSION_LABEL} —— **这是开发态或哈希取不到，线上出现就是构建异常**`
                : versionDrift
                  ? '代码改了但没人改版本号（两个部署版本号一样、哈希不一样）'
                  : '线上构建标识正常'
          }
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

        {/* ② 配置完整性（B1 / B3） */}
        <Card
          tone={toneConfig}
          title="② 配置完整性"
          headline={
            serviceKey.tone === 'bad'
              ? '`SUPABASE_SERVICE_ROLE_KEY` 未配置 → 建号 / 指派身份那两页会打不开'
              : r2.text
          }
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

        {/* ③ 备份与外部依赖（G2 · 第一期最该先做的一条） */}
        <Card
          tone={toneBackup}
          title="③ 备份（G2）"
          headline={backup.text}
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
          <HintOnly>
            前端拿不到 R2 里的备份文件，所以**不给"立刻下载备份"**（硬做只会做成一个坏掉的按钮）。
            手动触发：GitHub → Actions → backup → Run workflow。
          </HintOnly>
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
          headline={driftInfo ? driftInfo.text : '正在探测…'}
          note={drift ? `探测于 ${agoText(drift.at, now)}（刷新即重探）` : undefined}
          openLabel="看 §10–§19 总表"
        >
          <div
            className="px-3.5 py-2"
            style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75 }}
          >
            判据全部走**调用者自己的会话**（表看 <code>42P01</code>/<code>PGRST205</code>、列看{' '}
            <code>42703</code>、函数看裸版 RPC），**没有为了"看得全"而绕开 RLS**。灰点 ={' '}
            **无法判断**（探测本身没结论或探不到），**绝不是绿**。
          </div>
          {(drift?.sections ?? []).map((s) => (
            <div key={s.stage} style={{ borderTop: '1px solid var(--color-line)' }}>
              <div className="flex items-start gap-2.5 px-3.5 py-2">
                <span style={{ paddingTop: 5 }}>
                  <Dot tone={driftTone(s.state)} />
                </span>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: 13, fontWeight: 620 }}>
                    {s.stage}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--color-ink3)' }}>
                      {s.cells.length === 0
                        ? '不适用（面板探不到）'
                        : s.state === 'present'
                          ? '已跑'
                          : s.state === 'missing'
                            ? '未跑'
                            : '无法判断'}
                    </span>
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
                      {NO_PROBE_REASON[s.stage] ?? ''}
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
                      : '（这一段的产物不是表也不是函数，anon 会话探不到）'}
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

          <SubHead>C2 · 前端四个探测的汇总（它自己以为哪些列/表在）</SubHead>
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
                            : 'var(--color-warn)',
                      fontWeight: 600,
                    }}
                  >
                    {p.state === 'present' ? '在' : p.state === 'missing' ? '不在' : '认不出'}
                  </span>{' '}
                  <code style={{ fontSize: 11.5 }}>{p.target}</code>{' '}
                  <span style={{ color: 'var(--color-ink4)', fontSize: 11.5 }}>
                    {p.at ? agoText(p.at, now) : '本次会话还没探过'}
                  </span>
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
            <br />⚠️ 第四个探测（`lib/files.ts` 的 `ensureFileClassCols`）**没有对外的只读
            getter**，所以不在上面这张汇总里；它的现状看 §19 那一行的{' '}
            <code>shared_files.class_ids</code>。
          </div>
        </Card>

        {/* ⑤ 数据可信度（E7） */}
        <Card
          tone={toneData}
          title="⑤ 作业档案内部矛盾（E7）"
          headline={
            !hydrated
              ? '数据还没就绪（hydrate 没成功）—— **无法判断**，不是"没有矛盾"'
              : contradictions.badCount
                ? `作业档案 ${contradictions.badCount} 份自相矛盾（扫了 ${contradictions.scanned} 份）`
                : `作业档案 ${contradictions.scanned} 份，内部一致`
          }
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
                          style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
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
            <br />· **不给写操作**：面板上唯一的"动作"是**重新探测**（只读）。
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

        <div
          className="flex items-center gap-2 px-1 pb-8"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <IconWifi size={13} />
          <span>
            数据来源：本机会话 + `/api/admin/config-check` + `schema.sql` 存在性探测 + 教师端
            store。拿不到的**如实写"无法判断"**，绝不画绿。
          </span>
        </div>
      </div>
    </Shell>
  )
}

/**
 * 面板自己的外壳 —— **不套 `AppShell`**。
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
