/**
 * 插件加载器 · **接线层**（P0b）—— 判据全部来自 `lib/pluginHost.ts`（不另写一份）。
 *
 * ============================================================================
 * 这一层只做三件事
 * ============================================================================
 * ① **存储槽**：`ctx.storage` 背后的读写。演示模式（没有 Supabase）走内存 +
 *    localStorage 假槽；线上走本地镜像 + `plugin_data_write/read` RPC（§45.4）。
 *    🔴 **接口形状与线上一致**（手册 §12 的硬要求）：同一个 `code` 集、同一个
 *    预检顺序（`preflightWrite`）、断网同样"不 reject、等重放"（手册 §6.4）——
 *    假槽一旦更宽容，插件就是"本地好好的、装上就坏"。
 * ② **端口组装**（`makeHostPorts`）：`ctx` 的每个口接到壳的真实现上；插件回调里
 *    抛的错在这里被包住送去 `host.noteCrash()` —— 崩溃计数是插件的账（手册 §10）。
 * ③ **崩溃记录**（手册 §10）：10 分钟内崩 3 次 → 本班停用，故障记录写框架槽
 *    （`plugin_id='__framework'`、`key='crash.<插件id>'`）。**持久化是刻意的**：
 *    只记在内存里，重启一下熔断就自己解了 —— "能自解锁的熔断等于没有熔断"。
 */

import {
  LIMITS,
  FRAMEWORK_PLUGIN_ID,
  codeErr,
  preflightWrite,
  validateManifest,
  compareSemver,
  WRITABLE_TABLES,
  type HostPorts,
  type PluginHost,
  type ResourceName,
} from '../lib/pluginHost'
import { getSupabase, isRemote } from '../lib/supabase'
import { chime, isSilenced, softChime } from '../lib/tts'
import { readResource, watchResource } from './resources'
import type { AvailablePlugin } from './demoPlugin'

/**
 * 教室端插件壳自己的版本（手册 §2.1 的 `minShellVersion` 跟它比）。
 *
 * 🔴 它**不是** `APP_VERSION`（教师端发版号，`lib/version.ts`）：那是"网页产物第几版"，
 *    这个回答的是"这个壳有没有插件框架要的能力"。P0b 是第一个带插件框架的教室端壳，
 *    定 1.1.5（假插件的 `minShellVersion` 就是照它写的）；等壳侧作业落地，exe 的
 *    preload 会用真值盖掉它（严格值纪律：壳说了算，这里只是网页预览的兜底）。
 */
export const PLUGIN_SHELL_VERSION = '1.1.5'

/** 手册 §2.1：壳版本不够 ⇒ 不加载，只显示这一句。导出成常量让界面与判据同源。 */
export const NEED_NEWER_SHELL = '需要更新的教室版程序'

/** 加载前的两道闸（manifest 形状 + 壳版本）。返回 `errors` 时**不进窗口**。 */
export function preflightPlugin(
  p: AvailablePlugin,
): { ok: true } | { ok: false; reason: string } {
  const v = validateManifest(p.dirName, p.manifest)
  if (!v.ok) return { ok: false, reason: v.errors[0] ?? '插件清单不合法' }
  if (compareSemver(PLUGIN_SHELL_VERSION, p.manifest.minShellVersion) < 0) {
    return { ok: false, reason: NEED_NEWER_SHELL }
  }
  return { ok: true }
}

/* ============================================================================
   一、存储槽
   ============================================================================ */

export interface PluginSlot {
  get(key: string): Promise<unknown>
  /** 配额错**抛**（带 `code`）；断网**不抛**（等重放，手册 §6.4）。 */
  set(key: string, value: unknown): Promise<void>
  keys(): Promise<string[]>
  syncState(): { pending: number; lastError: string | null }
  /** 停用/换班时注销全局监听（online / visibilitychange）。 */
  dispose(): void
}

const LS_PREFIX = 'shugao.plugin.slot'

function lsKey(classId: string, pluginId: string): string {
  return `${LS_PREFIX}.${classId}.${pluginId}`
}

/** 本分钟已写次数（演示模式的频率配额，与 §45.4 同一个数）。 */
function rateLimitHit(times: number[], limit: number): boolean {
  const nowMs = Date.now()
  const alive = times.filter((t) => nowMs - t < 60_000)
  alive.push(nowMs)
  times.length = 0
  times.push(...alive)
  return alive.length > limit
}

/** 演示模式槽：内存 + localStorage。频率上限跟 §45.4 一样分插件/框架两档。 */
class DemoSlot implements PluginSlot {
  private classId: string
  private pluginId: string
  private mem = new Map<string, unknown>()
  private writeTimes: number[] = []
  private limit: number

  constructor(classId: string, pluginId: string) {
    this.classId = classId
    this.pluginId = pluginId
    this.limit = pluginId === FRAMEWORK_PLUGIN_ID ? LIMITS.frameworkWritesPerMinute : LIMITS.writesPerMinute
    try {
      const raw = localStorage.getItem(lsKey(classId, pluginId))
      if (raw) {
        const o = JSON.parse(raw) as Record<string, unknown>
        for (const [k, v] of Object.entries(o)) this.mem.set(k, v)
      }
    } catch {
      /* 读不出来就当空的 —— 空槽是"还没有"，不是错误 */
    }
  }

  async get(key: string): Promise<unknown> {
    return this.mem.get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    /* 预检与线上同一个函数、同一个顺序：名字 → 命名空间 → 取值 → 大小 → 行数 */
    const bad = preflightWrite(this.pluginId, key, value, this.mem.has(key) ? 0 : this.mem.size)
    if (bad) throw codeErr(bad)
    if (rateLimitHit(this.writeTimes, this.limit)) throw codeErr('E_QUOTA_RATE')
    this.mem.set(key, value)
    try {
      localStorage.setItem(
        lsKey(this.classId, this.pluginId),
        JSON.stringify(Object.fromEntries(this.mem)),
      )
    } catch {
      // 手册 §4.3：本地存不下要说出来（E_STORAGE），不静默
      throw codeErr('E_STORAGE')
    }
  }

  async keys(): Promise<string[]> {
    return [...this.mem.keys()]
  }

  syncState() {
    return { pending: 0, lastError: null }
  }

  dispose() {
    /* 没有全局监听 */
  }
}

/** 线上槽：本地镜像先行，RPC 写穿；断网排队重放（不 reject），配额错照抛。 */
class RemoteSlot implements PluginSlot {
  private classId: string
  private pluginId: string
  private mem = new Map<string, unknown>()
  private queue: Array<{ key: string; value: unknown }> = []
  private lastError: string | null = null
  private loaded = false
  private disposed = false

  constructor(classId: string, pluginId: string) {
    this.classId = classId
    this.pluginId = pluginId
    window.addEventListener('online', this.flush)
    document.addEventListener('visibilitychange', this.flush)
  }

  dispose() {
    this.disposed = true
    window.removeEventListener('online', this.flush)
    document.removeEventListener('visibilitychange', this.flush)
  }

  syncState() {
    return { pending: this.queue.length, lastError: this.lastError }
  }

  /** 库还没跑 §45（函数不存在）⇒ 只落本地镜像，一次 warn（布局这类框架数据照用）。 */
  private async rpc(
    fn: 'plugin_data_read' | 'plugin_data_write',
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown } | null> {
    const sb = getSupabase()
    if (!sb) return null
    try {
      return await sb.rpc(fn as never, args as never)
    } catch (e) {
      return { data: null, error: e }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const r = await this.rpc('plugin_data_read', {
      p_class_id: this.classId,
      p_plugin_id: this.pluginId,
      p_key: null,
    })
    if (!r || r.error) return
    const v = r.data as { ok?: boolean; rows?: Array<{ key: string; payload: unknown }> } | null
    if (v?.ok && Array.isArray(v.rows)) {
      for (const row of v.rows) this.mem.set(row.key, row.payload)
    }
  }

  async get(key: string): Promise<unknown> {
    await this.ensureLoaded()
    return this.mem.get(key)
  }

  async keys(): Promise<string[]> {
    await this.ensureLoaded()
    return [...this.mem.keys()]
  }

  async set(key: string, value: unknown): Promise<void> {
    const bad = preflightWrite(this.pluginId, key, value, this.mem.has(key) ? 0 : this.mem.size)
    if (bad) throw codeErr(bad)
    const prev = this.mem.get(key)
    this.mem.set(key, value) // 先落镜像：断网时 get 也要能读回最新（§6.4）
    const r = await this.rpc('plugin_data_write', {
      p_class_id: this.classId,
      p_plugin_id: this.pluginId,
      p_key: key,
      p_payload: value,
    })
    if (!r) {
      // 连 Supabase 客户端都没有（不该发生：RemoteSlot 只在 isRemote 下建）→ 排队等重放
      this.enqueue(key, value)
      return
    }
    if (r.error) {
      // 网络错 ⇒ 排队重放、**不 reject**；库没跑 §45 也走这里（框架槽降级为本地），
      // 其余错误（表坏了等）同样先排队——重放时自然再报。
      this.lastError = String((r.error as { message?: string }).message ?? r.error)
      this.enqueue(key, value)
      return
    }
    const v = r.data as { ok?: boolean; code?: string } | null
    if (v && v.ok === false) {
      // 数据库明确拒（配额/权限/命名空间）⇒ 回滚镜像 + 抛同一个码（§4.2：set 要 reject）
      if (prev === undefined) this.mem.delete(key)
      else this.mem.set(key, prev)
      throw codeErr(v.code ?? 'E_FORBIDDEN')
    }
  }

  private enqueue(key: string, value: unknown) {
    // 同 key 只留最新一条 —— 重放的是"最终值"，不是历史
    const rest = this.queue.filter((q) => q.key !== key)
    rest.push({ key, value })
    this.queue = rest
  }

  private flush = () => {
    if (this.disposed || !this.queue.length || document.visibilityState !== 'visible') return
    void (async () => {
      while (this.queue.length) {
        const head = this.queue[0]
        const prev = this.mem.get(head.key)
        const r = await this.rpc('plugin_data_write', {
          p_class_id: this.classId,
          p_plugin_id: this.pluginId,
          p_key: head.key,
          p_payload: head.value,
        })
        if (!r || r.error) return // 还是出不去：留着下次
        const v = r.data as { ok?: boolean; code?: string } | null
        if (v && v.ok === false) {
          if (prev === undefined) this.mem.delete(head.key)
          else this.mem.set(head.key, prev)
          this.lastError = v.code ?? 'E_FORBIDDEN'
          this.queue.shift() // 数据库明确拒的不重试（§4.3：配额错"不是重试一下就好"）
          continue
        }
        this.queue.shift()
        this.lastError = null
      }
    })()
  }
}

/** 建一个 (班, 插件) 的槽。演示/线上同一接口形状。 */
export function makeSlot(classId: string, pluginId: string): PluginSlot {
  return isRemote ? new RemoteSlot(classId, pluginId) : new DemoSlot(classId, pluginId)
}

/* ============================================================================
   二、崩溃记录（框架槽里的 `crash.<插件id>`，手册 §10）
   ============================================================================ */

export interface CrashRecordData {
  reason: string
  at: number
}

export async function loadCrashRecord(slot: PluginSlot, pluginId: string): Promise<CrashRecordData | null> {
  try {
    const v = (await slot.get(`crash.${pluginId}`)) as CrashRecordData | undefined
    return v && typeof v.reason === 'string' && typeof v.at === 'number' ? v : null
  } catch {
    return null
  }
}

export async function saveCrashRecord(
  slot: PluginSlot,
  pluginId: string,
  rec: CrashRecordData | null,
): Promise<void> {
  try {
    if (rec) await slot.set(`crash.${pluginId}`, rec)
    else await slot.set(`crash.${pluginId}`, null)
  } catch (e) {
    // 记录写不进去不挡停用本身（停用已经发生了），但要有人知道
    console.error('[plugin] 崩溃记录写不进去：', e)
  }
}

/* ============================================================================
   三、端口组装
   ============================================================================ */

/** 插件的分钟/课程事件总线（壳每分钟推一次；exam 切换时发 modeChange）。 */
export class ClockBus {
  private minute = new Set<(at: Date) => void>()
  private lesson = new Set<(e: unknown) => void>()

  onMinute(cb: (at: Date) => void): () => void {
    this.minute.add(cb)
    return () => this.minute.delete(cb)
  }

  onLesson(cb: (e: unknown) => void): () => void {
    this.lesson.add(cb)
    return () => this.lesson.delete(cb)
  }

  emitMinute(at: Date): void {
    for (const cb of [...this.minute]) cb(at)
  }

  emitLesson(e: unknown): void {
    for (const cb of [...this.lesson]) cb(e)
  }
}

/** 插件间总线（手册 §14：**不跨设备** —— P0b 就在本页内发，跨设备等 P2 的通道）。 */
export class LocalBus {
  private map = new Map<string, Set<(p: unknown, from: string) => void>>()

  emit(type: string, payload: unknown, from: string): void {
    for (const cb of [...(this.map.get(type) ?? [])]) cb(payload, from)
  }

  on(type: string, cb: (p: unknown, from: string) => void): () => void {
    const set = this.map.get(type) ?? new Set()
    set.add(cb)
    this.map.set(type, set)
    return () => set.delete(cb)
  }
}

export interface PortDeps {
  classId: string
  pluginId: string
  host: PluginHost
  slot: PluginSlot
  clock: ClockBus
  bus: LocalBus
  toast(text: string): void
  setTitle(text: string): void
  /** `ui.setSize` 传来的**格数**（手册 §4；换算成像素是窗口管理器的事）。 */
  setSize(w: number, h: number): void
  /**
   * 🆕 P1 配置通道（手册 §2.3）：壳侧把"当前生效值"算好递进来（默认值 ∪ 教师设置），
   * 教师改完配置后由壳侧逐插件叫醒订阅者。配置值**不进**本文件 —— 这里只接线。
   */
  getConfig(): Record<string, unknown>
  onConfigChange(cb: (next: Record<string, unknown>) => void): () => void
  /** 悬浮窗：壳的桥 + 全局上限的账都在壳那侧，这里只接线。 */
  pipOpen(opts: Record<string, unknown>): Promise<boolean>
  log(...args: unknown[]): void
}

export function makeHostPorts(d: PortDeps): HostPorts {
  /** 插件回调里抛的错 → 崩溃计数（手册 §10：只数**插件代码**抛的）。 */
  const crashGuard = <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a)
      } catch (e) {
        void d.host.noteCrash(e)
      }
    }

  return {
    readResource: (resource: ResourceName) => readResource(resource, d.classId),
    watchResource: (_resource: ResourceName, cb: () => void) =>
      watchResource(crashGuard(cb)),
    storageGet: (key: string) => d.slot.get(key),
    storageSet: (key: string, value: unknown) => d.slot.set(key, value),
    storageKeys: () => d.slot.keys(),
    configGet: () => d.getConfig(),
    configOnChange: (cb) => d.onConfigChange(crashGuard(cb)),
    onDispose: (fn: () => void) => d.host.addDisposer(fn),
    toast: (t: string) => d.toast(t),
    setTitle: (t: string) => d.setTitle(t),
    setSize: (w: number, h: number) => d.setSize(w, h),
    clockOnMinute: (cb) => d.clock.onMinute(crashGuard(cb)),
    clockOnLesson: (cb) => d.clock.onLesson(crashGuard(cb)),
    busEmit: (type: string, payload?: unknown) => d.bus.emit(type, payload, d.pluginId),
    busOn: (type: string, cb) => d.bus.on(type, crashGuard(cb)),
    soundPlay: (kind: string) => {
      // 静音矩阵在宿主（手册 §10）：上课铃期 / 考试 / 夜间一律静 —— 插件喊了也白喊
      if (isSilenced()) return
      if (kind === 'ding') softChime()
      else if (kind === 'chime') chime()
      else d.log(`sound.play 收到不认识的 kind：${kind}`)
    },
    pipOpen: (opts) => d.pipOpen(opts),
    filesSave: async () => {
      // 壳侧 `files` 走 IPC（附录 A 之外的一项，P2 文件共享插件才用）；网页里就是没有
      d.toast('要教室版程序')
      return false
    },
    /*
     * 🆕 写业务表（能力 `write`，2026-10-24 用户拍板「开通用写入但必须可审计」）。
     *
     * 🔴 三条纪律：
     *   ① 用**调用者自己的会话**写 —— RLS 仍是边界，插件依旧拿不到 supabase 客户端；
     *   ② 表名在这里**再核一遍**白名单（纵深防御：万一 ctx 被别处拼出来也绕不过去）；
     *   ③ 失败必须回 `{ok:false, code, why}`，不许静默 —— 课表写失败时老师会以为录进去了。
     */
    writeTable: async (op, table, payload) => {
      /* 适配器未接完：这两个参数先显式 void 掉，等写入适配落地时再用 */
      void op
      void payload
      if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
        return { ok: false, code: 'E_TABLE_NOT_DECLARED', why: `${table} 不在可写白名单里` }
      }
      /*
       * 🔴 2026-10-24：**适配器还没写完，先如实拒绝，不要拿原始列插入去撞库**。
       *
       * 已知两件事（子智能体交活时点出来的，都是真的）：
       *   ① 插件交的是**平台业务对象**（`ScheduleItem` 样子），不是表行；要过
       *      `data/remote.ts` 的 `scheduleToRow(s, teacherId)` 才落得进 `schedule_items`；
       *   ② `schedule_items.teacher_id` 是 `not null references teachers(id)`，而**教室端账号的 uid
       *      不在 `teachers` 里** ⇒ 从教室屏写"班级课表"时会撞 not null，而不是"写进去看不见"。
       * ⇒ 在"班级课表的归属人"这条定下来之前（见报告：借班主任 vs 允许 scope='class' 的 teacher_id 为空），
       *    这里返回一个**说得出口的错**，让插件的降级分支去提示，而不是把 Postgres 的原文甩到屏上。
       */
      if (table === 'schedule_items') {
        return {
          ok: false,
          code: 'E_WRITE_UNSUPPORTED',
          why: '课表的写入适配还没接（这条课表要记在谁名下还没定），先在宿主页面导入',
        }
      }
      return { ok: false, code: 'E_WRITE_UNSUPPORTED', why: `${table} 还没接写入适配` }
    },
  }
}
