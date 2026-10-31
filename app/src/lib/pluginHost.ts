/**
 * 教室端插件宿主 · **纯逻辑核心**（P0）
 *
 * ============================================================================
 * 为什么这里一行 DOM 都不碰
 * ============================================================================
 * 宿主要做的事分成两半：
 *   · **可判定的一半**：manifest 校验、能力白名单、生命周期、崩溃熔断、配额码、
 *     卡片该不该置灰 —— 这些不依赖浏览器，写在这里；
 *   · **只能眼见的一半**：建窗口、拖动、渲染、声音解锁 —— 那些在 P0b 的界面层。
 *
 * 分开的直接理由：`scripts/plugin-framework-checks.mjs` 要在**纯 Node**里跑完
 * 手册 §16 那 14 条（不启浏览器、不要 dev server）。宿主核心一旦 `import` 了
 * `document`，那道门禁就只能变成一条 Playwright 冒烟，既慢又 flaky
 * （本项目已有前车：`shots` 一次 7 分钟，调一条要跑很多次）。
 *
 * ⚠️ 因此本文件**只许 import 一个零依赖的纯数据模块** `./pluginTables.ts`（读表目录）。
 *    它不碰 DOM、不读环境、没有副作用；写成带 `.ts` 扩展名的相对导入 —— 门禁脚本直接
 *    `import('../src/lib/pluginHost.ts')` 时，Node 的类型擦除认的就是这个形状。
 *    其余任何 import 都别加：加一个依赖，这道纯 Node 门禁就废了。
 *
 * 📌 读表目录的静态自查在 `pluginTables.ts` 的 `selfCheckReadCatalog()`（不查库、不联网）。
 *    这一轮**不动 `scripts/`**，所以门禁还没接它；将来接 `plugin-framework-checks` 时直接调。
 *
 * 契约出处：《教室端插件开发手册.md》§2.1 / §4 / §5 / §6.1.1 / §7.2 / §10。
 * 线上实现的判据仍以数据库为准（§45 的 RPC 与 RLS）；这里只做**同一份口径的前端影子**
 * —— 两边不一致时以数据库为准，并回来改这里。
 */

import { PLUGIN_READ_TABLES } from './pluginTables.ts'

/* ============================================================================
   一、常量：手册里写死的那些数，**只有这一处定义**
   ============================================================================ */

/** 能力枚举（手册 §5）。多一个少一个都要先改手册，再改这里 —— 两个真相的代价是插件装上才坏。 */
export const PLUGIN_PERMISSIONS = [
  'storage',
  'data.roster',
  'data.schedule',
  'data.dailyHomework',
  'data.duty',
  'data.assignments',
  'data.quote',
  'data.exams',
  /* 🆕 P2 收尾（讲评插件）：已批改作业 + 逐题正确率。**不可**由它推出别的资源 ——
     名单（姓名）仍要单独的 `data.roster`，值日/每日作业仍要各自的能力。 */
  'data.gradedHomework',
  'config',
  'clock',
  'bus',
  'sound',
  'pip',
  'files',
  'keepAwake',
  /**
   * 🆕 2026-10-24 用户拍板：**开通用写入，但必须可审计**。
   *
   * 与 `storage`（写自己的槽）是两件事：`write` = **写平台业务表**。
   * 🔴 三个前提，缺一不给：
   *   ① 申请了这个能力；
   *   ② manifest 的 `writes` **逐张声明**了要动的表（声明本身就是审核材料）；
   *   ③ 只放行 `WRITABLE_TABLES` 里的表 —— 用户表/权限表/审计表一律不在此列。
   * 写入走**调用者自己的会话**（RLS 仍是边界），插件依旧拿不到 supabase 客户端。
   * 超管在 /admin 审核时会看到"这插件要写哪些表、每张表对应平台的什么功能"。
   */
  'write',
  /**
   * 🆕 2026-10-25 用户要求：「除了隐私信息类的，其他每一个的表数据读取权限都预留个接口」。
   *
   * 与 9 个"语义资源"（`data.*`）是两条路：
   *   · `data.*` = 宿主**算好形状**的结果（名单、课表、作业…），插件要什么给什么；
   *   · `read`   = **逐张表**读目录允许的列（`PLUGIN_READ_TABLES`），manifest 的
   *                `reads` 逐张声明，最多 12 张。这是"预留接口"，不是"开整库"。
   * 🔴 前提：① 申请了这个能力；② `reads` 声明了这张表；③ 表在目录里且不是 `deny`。
   * 三点缺一，`ctx.data.readTable()` 都回 `E_TABLE_NOT_READABLE`。
   * 实现只 select 白名单列、class 域强制按本班过滤，**不接受任何调用方过滤条件**。
   */
  'read',
] as const

/**
 * 允许插件申请写入的业务表白名单。
 * ⚠️ 与 `functions/api/_lib/pluginRepo.ts` 的 `WRITABLE_TABLES` 是**同一份**（服务端探针要独立判一次，
 *    两边不能只信客户端）。加表要同时加两处 + 手册 §5/§6.3。
 * 🔴 刻意**不**包含：teachers / teacher_roles / teacher_profiles / classroom_accounts /
 *    plugin_registry / plugin_configs / audit 类 —— 那些是账号、权限与审核本身，
 *    让插件写它们等于把"谁能审谁"交给插件。
 */
export const WRITABLE_TABLES = [
  'schedule_items',
  'classes',
  'students',
  'class_subjects',
  'assignments',
  'daily_homework',
  'duty_assignments',
  'school_calendar',
  'school_calendar_events',
  'calls',
  'shared_files',
  'exams',
  'score_rows',
  'wrongbook',
] as const

export type WritableTable = (typeof WRITABLE_TABLES)[number]

export interface PluginWriteDecl {
  table: WritableTable | string
  /** 为什么非写不可，≤40 字，给超管看的人话 */
  why: string
}

/**
 * 🆕 读表声明。**与 `PluginWriteDecl` 是同一个形状**（`{ table, why }`）——
 * 审核页看的是同一件事："这插件要动哪张表、对应平台的什么功能"。
 * 单独起个名字只是为了在 manifest 与审核页里分得清"读"与"写"。
 */
export type PluginReadDecl = PluginWriteDecl


export type Permission = (typeof PLUGIN_PERMISSIONS)[number]

/** 只读资源 → 需要哪个能力（手册 §6.1）。资源名是**枚举**，不是自由字符串。 */
export const RESOURCE_PERMISSION = {
  'class.roster': 'data.roster',
  'class.schedule': 'data.schedule',
  'class.todaySchedule': 'data.schedule',
  'class.slotNow': 'data.schedule',
  'class.dailyHomework': 'data.dailyHomework',
  'class.duty': 'data.duty',
  'class.assignments': 'data.assignments',
  'class.quote': 'data.quote',
  'class.exams': 'data.exams',
  'class.gradedHomework': 'data.gradedHomework',
} as const

export type ResourceName = keyof typeof RESOURCE_PERMISSION

/** 手册 §2.1 的命名空间正则。数据库 `plugin_registry_id_shape` 是同一份（§45.1）。 */
export const MANIFEST_ID_RE = /^[a-z][a-z0-9-]{2,31}\.[a-z][a-z0-9-]{2,31}$/

/** 手册 §7.1 的槽名正则。数据库 `plugin_data_key_shape` 是同一份（§45.2）。 */
export const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/

/** 框架自己的命名空间（窗口布局在这儿）。 */
export const FRAMEWORK_PLUGIN_ID = '__framework'

/** 手册 §7.2 / §9 / §10 的数字**全部集中在这儿**，门禁与界面都读它。 */
export const LIMITS = {
  rowsPerPluginPerClass: 500,
  payloadBytes: 16384,
  writesPerMinute: 60,
  frameworkWritesPerMinute: 120,
  readsPerMinute: 600,
  /** 🆕 读表：一次最多回多少行（超了截断，结果里带 `truncated: true`） */
  readTableRows: 2000,
  /** 🆕 一个插件最多声明几张可读表（手册 §6.1.1 的 12） */
  readTablesPerPlugin: 12,
  floatingWindowsMax: 6,
  activateTimeoutMs: 10_000,
  deactivateMaxMs: 2_000,
  crashWindowMs: 10 * 60 * 1000,
  crashLimit: 3,
  cleanResetMs: 30 * 60 * 1000,
} as const

/* ============================================================================
   二、manifest 校验（CF-01 / CF-02）
   ============================================================================ */

export interface PluginManifest {
  id: string
  name: string
  icon: string
  description: string
  version: string
  entry: string
  minShellVersion: string
  permissions: Permission[]
  /** 🆕 2026-10-24：申请 `write` 能力时**必须**逐张声明要写的表（审核材料，见 `Permission` 的注释） */
  writes?: PluginWriteDecl[]
  /** 🆕 2026-10-25：申请 `read` 能力时**必须**逐张声明要读的表（最多 12 张，见 `Permission`） */
  reads?: PluginReadDecl[]
  /** 教师端可见的插件结果槽；只有列在这里的 storage key 才会展示。 */
  teacherResults?: Array<{ key: string; label: string }>
  requiresShell?: string[]
  window?: { w: number; h: number; min?: { w: number; h: number } }
  config?: { fields: ConfigField[] }
}

export interface ConfigField {
  key: string
  type: 'switch' | 'number' | 'enum' | 'text'
  label: string
  default?: unknown
  min?: number
  max?: number
  options?: Array<[string, string]>
  maxLength?: number
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/

/** 与 `plugin_registry_id_shape` 同一个判据 —— 目录名必须等于 id（手册 §2.1）。 */
export function validateManifest(dirName: string, raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const m = (raw ?? {}) as Record<string, unknown>

  const str = (k: string, max = 200) => {
    const v = m[k]
    if (typeof v !== 'string' || !v.trim()) {
      errors.push(`缺少字段 ${k}`)
      return ''
    }
    if (v.length > max) errors.push(`字段 ${k} 超长（>${max}）`)
    return v
  }

  const id = str('id')
  if (id && !MANIFEST_ID_RE.test(id)) errors.push(`id 不合命名空间（vendor.name，小写，各段 ≥3 字符）：${id}`)
  if (id && dirName && id !== dirName) errors.push(`id 必须与目录名一致：目录 ${dirName} ≠ id ${id}`)

  str('name', 24)
  str('icon', 4096)
  str('description', 80)

  const version = str('version', 20)
  if (version && !SEMVER_RE.test(version)) errors.push(`version 必须是 主.次.修：${version}`)

  const minShell = str('minShellVersion', 20)
  if (minShell && !SEMVER_RE.test(minShell)) errors.push(`minShellVersion 必须是 主.次.修：${minShell}`)

  /* 🔴 入口只许相对路径：绝对路径 / `..` 会跳出插件目录（那是任意代码执行的口子） */
  const entry = typeof m.entry === 'string' && m.entry.trim() ? m.entry : 'index.js'
  if (entry.startsWith('/') || entry.includes('..') || /^[a-z]+:/i.test(entry)) {
    errors.push(`entry 必须是插件目录内的相对路径：${entry}`)
  }

  const perms = m.permissions
  if (!Array.isArray(perms) || perms.length === 0) {
    errors.push('缺少 permissions（至少一项）')
  } else {
    for (const p of perms) {
      if (typeof p !== 'string' || !(PLUGIN_PERMISSIONS as readonly string[]).includes(p)) {
        errors.push(`permissions 里有不认识的能力：${String(p)}`)
      }
    }
  }

  /* v0 草案用的是 capabilities —— 写了要明确报错，别静默当成"没申请任何能力" */
  if ('capabilities' in m) errors.push('字段名是 permissions（v0 草案的 capabilities 已废弃）')

  /*
   * 🆕 `write` 能力的三道校验（用户 2026-10-24 的口径：审核页要能看懂它要动哪些表）：
   *   ① 申请了 `write` 却没写 `writes` ⇒ 拒（"想写但不说写什么"比不申请更可疑）；
   *   ② `writes` 里有白名单外的表 ⇒ 拒（那份白名单见 `WRITABLE_TABLES`）；
   *   ③ `why` 空着或太长 ⇒ 拒（审核页要给人看，不是给机器看）。
   */
  const wantsWrite = Array.isArray(perms) && (perms as unknown[]).includes('write')
  const writes = m.writes
  if (wantsWrite) {
    if (!Array.isArray(writes) || writes.length === 0) {
      errors.push('申请了 write 能力却没有 writes（必须逐张声明要写的表）')
    }
  }
  if (writes !== undefined) {
    if (!Array.isArray(writes)) errors.push('writes 必须是数组')
    else {
      for (const [i, w] of (writes as PluginWriteDecl[]).entries()) {
        if (!w || typeof w.table !== 'string' || !w.table) {
          errors.push(`writes[${i}].table 缺失`)
          continue
        }
        if (!(WRITABLE_TABLES as readonly string[]).includes(w.table)) {
          errors.push(`writes[${i}].table 不在可写白名单里：${w.table}`)
        }
        if (typeof w.why !== 'string' || !w.why.trim()) errors.push(`writes[${i}].why 缺失（给审核看的一句人话）`)
        else if (w.why.length > 40) errors.push(`writes[${i}].why 超过 40 字`)
      }
      if (!wantsWrite) errors.push('声明了 writes 但没申请 write 能力')
    }
  }

  /*
   * 🆕 `read` 能力的六道校验（2026-10-25，与 `write` 同一个审核口径）：
   *   ① 申请了 `read` 却没写 `reads` ⇒ 拒；
   *   ② 表不在 `PLUGIN_READ_TABLES` ⇒ 拒（"目录里没有"就是没有，没有通配）；
   *   ③ 表在目录里但是 `deny` ⇒ 拒，**并把这句理由写进 errors** ——
   *      审核页要能解释"为什么这张表不给"，而不是只回一句"不合法"；
   *   ④ `why` 必填且 ≤40 字；⑤ 同一张表只许声明一次；⑥ 最多 12 张。
   */
  const wantsRead = Array.isArray(perms) && (perms as unknown[]).includes('read')
  const reads = m.reads
  if (wantsRead) {
    if (!Array.isArray(reads) || reads.length === 0) {
      errors.push('申请了 read 能力却没有 reads（必须逐张声明要读的表）')
    }
  }
  if (reads !== undefined) {
    if (!Array.isArray(reads)) errors.push('reads 必须是数组')
    else {
      const seen = new Set<string>()
      for (const [i, r] of (reads as PluginReadDecl[]).entries()) {
        if (!r || typeof r.table !== 'string' || !r.table) {
          errors.push(`reads[${i}].table 缺失`)
          continue
        }
        const def = PLUGIN_READ_TABLES[r.table]
        if (!def) {
          errors.push(`reads[${i}].table 不在可读目录里：${r.table}`)
        } else if (def.deny) {
          errors.push(`reads[${i}].table 是隐私 / 内部表，不给插件读：${r.table}（${def.deny}）`)
        } else if (seen.has(r.table)) {
          errors.push(`reads 里重复声明了 ${r.table}`)
        }
        seen.add(r.table)
        if (typeof r.why !== 'string' || !r.why.trim()) errors.push(`reads[${i}].why 缺失（给审核看的一句人话）`)
        else if (r.why.length > 40) errors.push(`reads[${i}].why 超过 40 字`)
      }
      if (reads.length > LIMITS.readTablesPerPlugin) {
        errors.push(`reads 最多声明 ${LIMITS.readTablesPerPlugin} 张表（现在 ${reads.length} 张）`)
      }
      if (!wantsRead) errors.push('声明了 reads 但没申请 read 能力')
    }
  }

  if (m.teacherResults !== undefined) {
    const results = m.teacherResults
    if (!Array.isArray(results) || results.length > 12) errors.push('teacherResults 必须是至多 12 项的数组')
    else {
      const seen = new Set<string>()
      for (const [i, result] of results.entries()) {
        const item = result as { key?: unknown; label?: unknown }
        if (typeof item?.key !== 'string' || !validateKey(item.key).ok || seen.has(item.key))
          errors.push(`teacherResults[${i}].key 无效或重复`)
        else seen.add(item.key)
        if (typeof item?.label !== 'string' || !item.label.trim() || item.label.length > 24)
          errors.push(`teacherResults[${i}].label 必须为 1–24 字`)
      }
      if (results.length && (!Array.isArray(perms) || !perms.includes('storage')))
        errors.push('teacherResults 需要 storage 能力')
    }
  }

  const win = m.window
  if (win !== undefined) {
    const w = win as Record<string, unknown>
    for (const k of ['w', 'h'] as const) {
      const v = w[k]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
        errors.push(`window.${k} 必须是正数（单位=网格格数）`)
      }
    }
  }

  const cfg = m.config as { fields?: unknown } | undefined
  if (cfg !== undefined) {
    if (!cfg || !Array.isArray(cfg.fields)) errors.push('config 必须是 { fields: [...] }')
    else {
      for (const [i, f] of (cfg.fields as ConfigField[]).entries()) {
        if (!f || typeof f.key !== 'string' || !f.key) errors.push(`config.fields[${i}].key 缺失`)
        if (!f || !['switch', 'number', 'enum', 'text'].includes(f.type)) {
          errors.push(`config.fields[${i}].type 只能是 switch/number/enum/text`)
        }
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

/* ============================================================================
   三、取值与槽名（CF-07 / CF-08）
   ============================================================================ */

/** 手册 §6.5：只允许 JSON 能表达的值。`Date` 存进去读回来是字符串 —— 现场就崩在 `getTime()`。 */
export function isJsonValue(v: unknown, seen: Set<object> = new Set()): boolean {
  if (v === null) return true
  const t = typeof v
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(v as number)
  if (t !== 'object') return false // undefined / function / symbol / bigint
  if (v instanceof Date || v instanceof Map || v instanceof Set) return false
  if (seen.has(v as object)) return false
  seen.add(v as object)
  try {
    if (Array.isArray(v)) return v.every((x) => isJsonValue(x, seen))
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false // 类实例一律不认（含 Date 的兄弟）
    return Object.values(v as Record<string, unknown>).every((x) => isJsonValue(x, seen))
  } finally {
    seen.delete(v as object)
  }
}

/** 序列化后的字节数（手册 §7.2 的 16 KB 判据就是量这个，不是量字符数）。 */
export function payloadBytes(v: unknown): number {
  const text = JSON.stringify(v ?? null)
  /* TextEncoder 在 Node 与浏览器里都在；不引 Buffer（浏览器没有） */
  return new TextEncoder().encode(text).length
}

export function validateKey(key: string): { ok: true } | { ok: false; code: 'E_RESERVED_KEY' | 'E_BAD_KEY' } {
  if (typeof key !== 'string' || !key) return { ok: false, code: 'E_BAD_KEY' }
  if (key.startsWith('__')) return { ok: false, code: 'E_RESERVED_KEY' }
  if (!KEY_RE.test(key)) return { ok: false, code: 'E_BAD_KEY' }
  return { ok: true }
}

/**
 * 写之前**在客户端先算一遍**（数据库那一份是最终判据，这里是让插件早点知道）。
 * 顺序与 §45.4 的 `plugin_data_write()` 一致：身份 → 命名空间 → 取值 → 行数 → 频率。
 * 返回值是 `null` 表示"客户端看不出问题，去问数据库"。
 */
export function preflightWrite(
  pluginId: string,
  key: string,
  payload: unknown,
  rows: number,
): 'E_RESERVED_KEY' | 'E_BAD_KEY' | 'E_BAD_VALUE' | 'E_QUOTA_SIZE' | 'E_QUOTA_ROWS' | null {
  /* 插件 id 自身也要合法：库里那两条同款 check 会拒，客户端先拒能给出更早的错。
     `__framework` 是唯一例外（它不是插件，是宿主自己）。 */
  if (pluginId !== FRAMEWORK_PLUGIN_ID && !MANIFEST_ID_RE.test(pluginId)) return 'E_BAD_KEY'

  /* `__` 开头的 key 一律拒 —— 包括框架自己：框架的槽是
     `plugin_id = '__framework'` + `key = 'layout'`，**不需要** `__` 开头的 key。
     那一半命名空间靠 plugin_id 区分，库里的 `plugin_data_key_shape` 也是这么定的。 */
  if (key.startsWith('__')) return 'E_RESERVED_KEY'
  if (!KEY_RE.test(key)) return 'E_BAD_KEY'
  if (!isJsonValue(payload)) return 'E_BAD_VALUE'
  if (payloadBytes(payload) > LIMITS.payloadBytes) return 'E_QUOTA_SIZE'
  if (rows >= LIMITS.rowsPerPluginPerClass) return 'E_QUOTA_ROWS'
  return null
}

/* ============================================================================
   四、能力注入（CF-06）
   ============================================================================ */

/** 宿主侧真实能力的登记表：能力 → ctx 上的属性名。没登记的能力，插件永远看不到。 */
export const CAPABILITY_SLOTS: Record<Permission, readonly string[]> = {
  storage: ['storage'],
  'data.roster': ['data'],
  'data.schedule': ['data', 'clock'],
  'data.dailyHomework': ['data'],
  'data.duty': ['data'],
  'data.assignments': ['data'],
  'data.quote': ['data'],
  'data.exams': ['data'],
  'data.gradedHomework': ['data'],
  config: ['config'],
  clock: ['clock'],
  bus: ['bus'],
  sound: ['sound'],
  pip: ['pip'],
  files: ['files'],
  keepAwake: ['keepAwake'],
  write: ['write'],
  read: ['data'],
}

/**
 * 宿主端口回给插件的错误码（手册 §4.3）。
 *
 * 🆕 2026-10-25 加 `E_TABLE_NOT_READABLE`：读表时
 *   · 表不在 `PLUGIN_READ_TABLES` 里 / 是 `deny` 的表 / 没在 `manifest.reads` 里声明
 *   —— 三种情况收成**一个码**（对插件来说处置方式相同：回去改 manifest，或别读）。
 * 其余几个是 `write` 端口已经在用的码，收在一处避免"读一个码、写一个码"两套字符串。
 */
export type PluginErrorCode =
  | 'E_TABLE_NOT_READABLE'
  | 'E_TABLE_NOT_DECLARED'
  | 'E_WRITE_UNSUPPORTED'
  | 'E_OFFLINE_WRITE'

/**
 * 🆕 写业务表的端口（2026-10-24）。壳/页面负责接上它；没接 ⇒ `ctx.write` 一律回 `E_OFFLINE_WRITE`。
 * 🔴 `op` 只有三种，且**表名已经在建 ctx 时校验过**（这里不再信任调用方）。
 */
export type WriteTableOp = 'insert' | 'update' | 'delete'
export type WriteTableResult = { ok: true } | { ok: false; code: PluginErrorCode; why: string }

/**
 * 🆕 读表端口的结果（2026-10-25）。
 *
 * 成功形状就是手册 §6.1.1 那一个 `{ rows, truncated?, stale, asOf }`；失败回**码**而不是抛，
 * 与 `WriteTableResult` 同一套写法 —— 这样"端口没接"也能回一个说得出口的码，
 * 而不是在插件里炸出一个 `undefined is not a function`。
 */
export type ReadTableResult =
  | { ok: true; rows: unknown[]; truncated: boolean; stale: boolean; asOf: string }
  | { ok: false; code: PluginErrorCode; why: string }


export interface HostPorts {
  /** 只读资源；`stale` 由端口自己决定（断网时 true，且**不许 reject**） */
  readResource(resource: ResourceName): Promise<{ value: unknown; stale: boolean; asOf: string }>
  watchResource(resource: ResourceName, cb: () => void): () => void
  storageGet(key: string): Promise<unknown>
  storageSet(key: string, value: unknown): Promise<void>
  storageKeys(): Promise<string[]>
  storageSyncState(): { pending: number; lastError: string | null }
  /**
   * 🆕 P1（配置通道，手册 §2.3）：`ctx.config.get()` 的后盾。
   * **合并默认值是端口的事**（教师设置 ∪ manifest `config.fields[].default`）——
   * 宿主核心不认识 config schema 的语义，只负责把"当前生效值"递出去。
   */
  configGet(): Record<string, unknown>
  configOnChange(cb: (next: Record<string, unknown>) => void): () => void
  onDispose(fn: () => void): void
  toast(text: string): void
  setTitle(text: string): void
  /** 🆕 P0b 接上了窗口管理器：单位是**格数**（手册 §4），端口没接就是"这条路没有" */
  setSize?(w: number, h: number): void
  clockOnMinute(cb: (at: Date) => void): () => void
  clockOnLesson(cb: (e: unknown) => void): () => void
  busEmit(type: string, payload?: unknown): void
  busOn(type: string, cb: (p: unknown, from: string) => void): () => void
  soundPlay(kind: string): void
  pipOpen(opts: Record<string, unknown>): Promise<boolean>
  filesSave(name: string, blob: unknown): Promise<boolean>
  /** 🆕 写业务表（能力 `write`）。**没接就是没有**：`ctx.write` 的调用会回 `E_OFFLINE_WRITE`。 */
  writeTable?(op: WriteTableOp, table: string, payload: unknown): Promise<WriteTableResult>
  /**
   * 🆕 读平台表（能力 `read`，手册 §6.1.1）。**没接就回 `E_TABLE_NOT_READABLE`**。
   * 🔴 `table` 已在建 ctx 时校验过"在目录里且 manifest 声明过"；这里的实现只负责
   *    "按目录的列取本班（或全校可见）行"，**不接受 `select` / `filter` / `order`**。
   *    `opts.classId` 由宿主递入，插件改不了它。
   */
  readPluginTable?(table: string, opts: { classId: string }): Promise<ReadTableResult>
  watchPluginTable?(table: string, cb: () => void): () => void
}

export interface ContextOptions {
  manifest: PluginManifest
  classId: string
  className: string
  now: () => Date
  container: unknown
  ports: HostPorts
  log: (...args: unknown[]) => void
  /**
   * 🆕 P0b：壳支不支持悬浮窗（手册 §5 的 `pip` 行："**且还要求壳支持**"、§9 的表：
   * 网页版 `ctx.pip` **没有**）。缺省（undefined）按"支持"——那是纯 Node 门禁里的形状，
   * 那边没有壳的概念，不该凭空少一个属性。
   */
  pipSupported?: boolean
}

/**
 * 造 `ctx`。**只有申请过的能力才出现在对象上** —— 手册 §4 那条
 * `'pip' in ctx === false`，靠的就是这里"不往上挂"，而不是挂上去再返回 undefined。
 */
export function buildContext(o: ContextOptions): Record<string, unknown> {
  const perms = new Set<string>(o.manifest.permissions)
  const ctx: Record<string, unknown> = {
    plugin: { id: o.manifest.id, name: o.manifest.name, version: o.manifest.version },
    class: { id: o.classId, name: o.className },
    now: () => o.now(),
    log: (...a: unknown[]) => o.log(`[${o.manifest.id}]`, ...a),
    onDispose: (fn: () => void) => o.ports.onDispose(fn),
    ui: {
      container: o.container,
      toast: (t: string) => o.ports.toast(t),
      setTitle: (t: string) => o.ports.setTitle(t),
      setSize: (w: number, h: number) => {
        /* P0b：单位格数，落到窗口管理器（`ports.setSize`）；端口没接就当"窗口管理器管不了它"，
           插件不必为这个写分支 —— 与手册 §4 `ui.setSize` 的"受窗口管理器约束"一致。 */
        o.ports.setSize?.(w, h)
      },
    },
  }

  /*
   * `ctx.data`：语义资源（`data.*`）与读表（`read`）**共用这个命名空间**，
   * 但各自只挂自己那一半 —— 只申请 `read` 的插件拿不到 `data.read`（那是别的能力），
   * 只申请 `data.*` 的插件也拿不到 `readTable`（CF-06 的"未申请的能力属性不存在"）。
   */
  const reads = perms.has('read') && Array.isArray(o.manifest.reads) ? o.manifest.reads : []
  const data: Record<string, unknown> = {}
  if ([...perms].some((p) => p.startsWith('data.'))) {
    data.read = async (resource: ResourceName) => {
      const need = RESOURCE_PERMISSION[resource]
      if (!need) throw codeErr('E_BAD_RESOURCE')
      if (!perms.has(need)) throw codeErr('E_NO_CAPABILITY')
      const r = await o.ports.readResource(resource)
      const base = r.value as Record<string, unknown>
      /* `stale` / `asOf` 由宿主贴在最外层（手册 §6.4：空形状 + 两个字段，**不 reject**） */
      return { ...base, stale: r.stale, asOf: r.asOf }
    }
    data.watch = (resource: ResourceName, cb: () => void) => {
      const need = RESOURCE_PERMISSION[resource]
      if (!need) throw codeErr('E_BAD_RESOURCE')
      if (!perms.has(need)) throw codeErr('E_NO_CAPABILITY')
      return o.ports.watchResource(resource, cb)
    }
    data.online = () => true
  }

  /*
   * 🆕 `ctx.data.readTable`（能力 `read`，2026-10-25）—— 用户要求：
   * 「除了隐私信息类的，其他每一个的表数据读取权限都预留个接口……并确保这些端口仅有插件能调用」。
   *
   * 🔴 这条通路**真实边界**有三层，别把它当沙箱（手册 §6.1.2 逐字同一段）：
   *   ① **端口不在全局**：`ctx` 是这里当场建的对象，只作为 `activate(ctx)` 的参数交出去，
   *      **不挂 `window` / `globalThis` / 模块级单例**。页面里别的脚本拿不到它 ——
   *      这一层拦的是"顺手就能调"。
   *   ② **真正的门是 RLS + 列白名单**：插件与宿主同页面（手册 §1），一个**故意**作恶的
   *      插件本来就能碰到宿主能碰的一切，这条通路拦不住它。所以即便它绕过端口直接问数据库，
   *      RLS 也只会给出"当前登录这位老师能看的那几行"，而列白名单在宿主这一侧再砍一刀
   *      （`PLUGIN_READ_TABLES[table].cols`，不是"读回来再删字段"）。
   *   ③ **没有"整表"这个口**：`readTable(table)` 只收表名，`select` / `filter` / `order`
   *      一概不接；class 域的表由宿主按**本班**钉死 `classCol`。所以拿不到"别人班的行"，
   *      也拿不到"全库导一份"。
   */
  if (reads.length) {
    const declaredRead = new Set(reads.map((r) => r.table))
    const fail = (code: PluginErrorCode, why: string) => {
      const e = codeErr(code)
      e.message = `${code}: ${why}`
      return e
    }
    data.readTable = async (table: string) => {
      /* 只认 manifest.reads 里声明过的表；目录与 deny 在这里再核一遍（纵深防御：
         万一 manifest 被别处拼出来，也绕不过这一层）。 */
      if (typeof table !== 'string' || !declaredRead.has(table)) {
        throw fail('E_TABLE_NOT_READABLE', `manifest.reads 里没有声明 ${String(table)}`)
      }
      const def = PLUGIN_READ_TABLES[table]
      if (!def) throw fail('E_TABLE_NOT_READABLE', `可读目录里没有 ${table}`)
      if (def.deny) throw fail('E_TABLE_NOT_READABLE', def.deny)
      if (!o.ports.readPluginTable) throw fail('E_TABLE_NOT_READABLE', '这台设备没有接读表端口')
      const r = await o.ports.readPluginTable(table, { classId: o.classId })
      if (!r.ok) throw fail(r.code, r.why)
      return {
        rows: r.rows,
        ...(r.truncated ? { truncated: true } : {}),
        stale: r.stale,
        asOf: r.asOf,
      }
    }
    data.watchTable = (table: string, cb: () => void) => {
      if (typeof table !== 'string' || !declaredRead.has(table) || !PLUGIN_READ_TABLES[table] || PLUGIN_READ_TABLES[table].deny)
        throw fail('E_TABLE_NOT_READABLE', `manifest.reads 里没有获批的 ${String(table)}`)
      if (!o.ports.watchPluginTable) throw fail('E_TABLE_NOT_READABLE', '这台设备没有接读表更新端口')
      return o.ports.watchPluginTable(table, cb)
    }
  }

  if (Object.keys(data).length) ctx.data = data

  if (perms.has('storage')) {
    ctx.storage = {
      get: (key: string, fallback: unknown) => {
        const v = validateKey(key)
        if (!v.ok) return Promise.reject(codeErr(v.code))
        return o.ports.storageGet(key).then((x) => (x === undefined ? fallback : x))
      },
      set: (key: string, value: unknown) => {
        const v = validateKey(key)
        if (!v.ok) return Promise.reject(codeErr(v.code))
        if (!isJsonValue(value)) return Promise.reject(codeErr('E_BAD_VALUE'))
        if (payloadBytes(value) > LIMITS.payloadBytes) return Promise.reject(codeErr('E_QUOTA_SIZE'))
        return o.ports.storageSet(key, value)
      },
      keys: () => o.ports.storageKeys(),
      syncState: () => o.ports.storageSyncState(),
    }
  }

  if (perms.has('config')) {
    /* P1：get 回**当前生效值**（端口已合并默认值），onChange 在教师改完配置时触发 ——
       手册 §2.3 的"1 秒内要有可见响应"由插件自己兑现，宿主只保证把变化送进来。 */
    ctx.config = {
      get: () => o.ports.configGet(),
      onChange: (cb: (next: Record<string, unknown>) => void) => o.ports.configOnChange(cb),
    }
  }
  if (perms.has('clock')) {
    ctx.clock = {
      onMinute: (cb: (at: Date) => void) => o.ports.clockOnMinute(cb),
      onLesson: (cb: (e: unknown) => void) => o.ports.clockOnLesson(cb),
    }
  }
  if (perms.has('bus')) {
    ctx.bus = { emit: o.ports.busEmit, on: o.ports.busOn }
  }
  if (perms.has('sound')) ctx.sound = { play: o.ports.soundPlay }
  /* `pip` 是"能力 + 壳支持"两把闸（手册 §5 / §9）：网页预览下壳不支持 ⇒ 这个属性根本不出现，
     插件的 `if (ctx.pip)` 自然走降级 —— 不是 open() 回 false 的那一种。 */
  if (perms.has('pip') && o.pipSupported !== false) ctx.pip = { open: o.ports.pipOpen, close: () => {} }
  if (perms.has('files')) {
    ctx.files = { save: o.ports.filesSave, open: async () => null }
  }
  if (perms.has('keepAwake')) ctx.keepAwake = true

  /*
   * 🆕 `ctx.write`：**只放行 manifest 声明过的表**。
   * 越权不是"让数据库拒"，而是**宿主这一层就拒**（`E_TABLE_NOT_DECLARED`）——
   * 理由：把"插件偷偷写别的表"变成一条开发期就能看见的错，而不是等 RLS 静默筛成 0 行
   * （那正是本项目反复踩的"失败了没人知道"）。
   */
  if (perms.has('write') && Array.isArray(o.manifest.writes) && o.manifest.writes.length) {
    const declared = new Set(o.manifest.writes.map((w) => w.table))
    const call = (op: 'insert' | 'update' | 'delete') => async (table: string, payload: unknown) => {
      if (!declared.has(table)) {
        return { ok: false as const, code: 'E_TABLE_NOT_DECLARED', why: `manifest.writes 里没有声明 ${table}` }
      }
      if (!o.ports.writeTable) {
        return { ok: false as const, code: 'E_OFFLINE_WRITE', why: '这台设备不能写库（演示模式或壳没接）' }
      }
      return o.ports.writeTable(op, table, payload)
    }
    ctx.write = Object.freeze({ insert: call('insert'), update: call('update'), delete: call('delete') })
  }

  return Object.freeze(ctx)
}

export function codeErr(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string }
  e.code = code
  return e
}

/* ============================================================================
   五、生命周期与熔断（CF-05 / CF-11 / CF-12）
   ============================================================================ */

export type HostState = 'idle' | 'activating' | 'active' | 'disabled'

export interface CrashRecord {
  at: number
  message: string
}

export interface PluginHostOptions {
  manifest: PluginManifest
  module: { activate?: (ctx: Record<string, unknown>) => unknown; deactivate?: () => unknown }
  makeContext: () => Record<string, unknown>
  now: () => number
  onDispose: (fn: () => void) => void
  onDisabled?: (reason: string) => void
  /** 测试用：把超时调小；线上用 LIMITS 那两个数 */
  activateTimeoutMs?: number
  deactivateMaxMs?: number
}

/**
 * 一个插件在本班的那一份运行状态。
 *
 * 🔴 三条口径（手册 §10，细则与 §45 无关，是宿主的账）：
 *   · 「崩溃」只数**插件代码**抛出的错 —— 宿主自己的错传 `reportHostError()`，不计数；
 *   · 窗口是 **10 分钟**，超窗的旧记录不算；连续正常 30 分钟清零；
 *   · 到第 3 次 → **本班**停用，`disableReason` 写清楚，恢复只能由老师/管理员做
 *     （`enable()` 是给界面用的入口，插件自己拿不到这个对象）。
 */
export class PluginHost {
  state: HostState = 'idle'
  crashes: CrashRecord[] = []
  disableReason: string | null = null
  private cleanSince: number | null = null
  private disposers: Array<() => void> = []
  private o: Required<Pick<PluginHostOptions, 'activateTimeoutMs' | 'deactivateMaxMs'>> & PluginHostOptions

  constructor(o: PluginHostOptions) {
    this.o = { activateTimeoutMs: LIMITS.activateTimeoutMs, deactivateMaxMs: LIMITS.deactivateMaxMs, ...o }
  }

  /** 崩溃窗口内的次数（超窗的旧记录直接不算，也不清表 —— 表大小对诊断有用） */
  crashCount(): number {
    const t = this.o.now()
    return this.crashes.filter((c) => t - c.at <= LIMITS.crashWindowMs).length
  }

  async activate(): Promise<{ ok: boolean; code?: string }> {
    if (this.state === 'disabled') return { ok: false, code: 'E_DISABLED' }
    if (this.state === 'active') return { ok: true }
    this.state = 'activating'
    const ctx = this.o.makeContext()
    try {
      await withTimeout(
        Promise.resolve(this.o.module.activate?.(ctx)),
        this.o.activateTimeoutMs,
        'E_ACTIVATE_TIMEOUT',
      )
      this.state = 'active'
      this.cleanSince = this.o.now()
      return { ok: true }
    } catch (e) {
      this.state = 'idle'
      await this.noteCrash(e)
      return { ok: false, code: (e as { code?: string })?.code ?? 'E_CRASH' }
    }
  }

  /** `deactivate` 超 2 秒算一次失败（**不是**崩溃：屏在等人，不该把插件停掉） */
  async deactivate(): Promise<{ ok: boolean; code?: string }> {
    if (this.state !== 'active' && this.state !== 'activating') return { ok: true }
    let ok = true
    let code: string | undefined
    try {
      await withTimeout(
        Promise.resolve(this.o.module.deactivate?.()),
        this.o.deactivateMaxMs,
        'E_DEACTIVATE_SLOW',
      )
    } catch (e) {
      ok = false
      code = (e as { code?: string })?.code ?? 'E_DEACTIVATE'
    }
    for (const d of this.disposers.splice(0)) {
      try {
        d()
      } catch (e) {
        ok = false
        code = (e as { code?: string })?.code ?? 'E_DISPOSE'
      }
    }
    this.state = 'idle'
    return { ok, code }
  }

  /** 插件回调里抛出来的错（宿主代为捕获后调它） */
  async noteCrash(e: unknown): Promise<void> {
    const msg = String((e as { message?: string })?.message ?? e)
    this.crashes.push({ at: this.o.now(), message: msg })
    if (this.crashCount() >= LIMITS.crashLimit) {
      this.disableReason = `连崩 ${LIMITS.crashLimit} 次：${msg}`
      this.state = 'disabled'
      this.o.onDisabled?.(this.disableReason)
      await this.deactivate()
    }
  }

  /** 长跑清零：连续正常 30 分钟后，崩溃计数不再算旧账 */
  tickClean(): void {
    if (this.state !== 'active' || this.cleanSince === null) return
    if (this.o.now() - this.cleanSince >= LIMITS.cleanResetMs) {
      this.crashes = []
      this.cleanSince = this.o.now()
    }
  }

  /** 恢复入口：**只在界面层**（老师/管理员点），插件拿不到 */
  enable(): void {
    if (this.state !== 'disabled') return
    this.state = 'idle'
    this.disableReason = null
    this.crashes = []
  }

  addDisposer(fn: () => void): void {
    this.disposers.push(fn)
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(codeErr(code)), ms)
        /* Node 里别让这个定时器把进程挂住；浏览器忽略这两个方法 */
        ;(timer as unknown as { unref?: () => void })?.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ============================================================================
   六、卡片：什么情况下要置灰（CF-13）
   ============================================================================ */

/**
 * 教师端卡片 / 教室端插件列表用。返回 `reason` 时界面必须**照实说**，
 * 不许"看起来能点、点了没反应"（手册 §1 第 4 条：降级不撒谎）。
 */
export function planCard(
  m: PluginManifest,
  env: { shellSupportsPip: boolean; shellVersion: string },
): { enabled: boolean; reason: string | null } {
  if (compareSemver(env.shellVersion, m.minShellVersion) < 0) {
    return { enabled: false, reason: '需要更新的教室版程序' }
  }
  if ((m.permissions as string[]).includes('pip') && !env.shellSupportsPip) {
    return { enabled: false, reason: '要教室版程序' }
  }
  return { enabled: true, reason: null }
}

/** 语义化版本比较（只认 `主.次.修`；认不出的一律当 0，别猜） */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.test(a) ? a.split('.').map(Number) : [0, 0, 0]
  const pb = SEMVER_RE.test(b) ? b.split('.').map(Number) : [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}
