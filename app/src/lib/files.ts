import { getSupabase } from './supabase'

/* ============================================================
   教师端 → 教室端 的文件互传
   文件存在 Supabase Storage 的私有桶里，这里只管增删查和取签名链接。

   班级归属（2026-09-28，schema.sql §19）
   ------------------------------------------------------------
   一个文件可以**同时属于几个班**（同一个课件传一次，几个班都能看），
   归属落在 `shared_files.class_ids uuid[]` 上：**空数组 = 没有归属 = 教室端看不到**。
   教室端能读到什么，**由数据库的读策略说了算**（§19.3），这里一个字都不筛 ——
   `listFiles()` 拉回来的就是"这个人该看见的那些"（见 功能设计与不变量.md §11.3 / §19）。
   ============================================================ */

export type SharedFile = {
  id: string
  name: string
  mime: string
  size: number
  /** 班级归属：空数组 = 未指派班级（只有上传者自己看得见，教室端看不到） */
  classIds: string[]
  storagePath: string
  createdAt: number
}

export type FileKind = 'image' | 'pdf' | 'ppt' | 'doc' | 'video' | 'other'

/**
 * 按扩展名判类型 —— 手机拍的照片 mime 常常不准，扩展名更可信。
 *
 * 🔴 2026-10-01 安全加固 A6：`.html/.htm` 与 `.svg` **不再单独成类**，一律落进 `'other'`。
 *    原因是它们会被浏览器当**同源文档**渲染：同事点开一个上传的 `.html`，
 *    里面的 JS 就跑在**本站 origin** 上、能读到 `localStorage` 里的会话（`安全加固方案.md` A6）。
 *    `.svg` 同理（SVG 里可以带 `<script>`）。
 *    判"是什么"与判"能不能内嵌打开"本是两件事，但这一类**两者都得收紧**，
 *    所以在这里就断掉，而不是只在 `canViewInline()` 上补一句。
 */
export function kindOf(name: string, mime = ''): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['ppt', 'pptx'].includes(ext)) return 'ppt'
  if (['doc', 'docx', 'xls', 'xlsx'].includes(ext)) return 'doc'
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video'
  /* ⚠️ 扩展名认不出时才看 mime，而且 `image/svg+xml` 不算图片 */
  if (mime.startsWith('image/') && !mime.includes('svg')) return 'image'
  return 'other'
}

export const KIND_TEXT: Record<FileKind, string> = {
  image: '图片',
  pdf: 'PDF',
  ppt: 'PPT',
  doc: '文档',
  video: '视频',
  other: '文件',
}

/** 教室端能不能直接打开看 —— 这决定了界面上是「看」还是「下载」 */
export function canViewInline(k: FileKind): boolean {
  return k === 'image' || k === 'pdf' || k === 'video'
}

const BUCKET = 'classroom-files'

function sb() {
  const c = getSupabase()
  if (!c) throw new Error('未连接云端')
  return c
}

/** 文件名里可能有中文、空格、括号，统一洗成安全的键 */
function safeName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60)
  const ext = dot > 0 ? name.slice(dot).replace(/[^\w.]/g, '') : ''
  return `${base || 'file'}${ext}`
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ---------------- 班级归属：默认勾选 / 勾选动作 / 显示 / 落库列 ----------------
   这四件事都只有这一处实现（页面上不许再写一遍）—— 见 §11.3「前端不另写过滤」的反面：
   界面上的**选择**可以预填，但"谁能看见"永远由数据库判（§19.3）。 */

/**
 * 上传时**默认勾上哪些班**（用户口径："只教一个班就默认勾上那个班；
 * 在某个班的上下文里进来就默认勾那个班"）。规则：
 *   ① 当前班级确实在自己名下 → 勾它（老师多半就是要发给它）；
 *   ② 只教一个班 → 勾那一个，老师**不用操作**（反指标：别给他加负担）；
 *   ③ 其余（教多个班、又没有可用的上下文）→ 一个都不勾，让他自己挑 —— **不猜**。
 */
export function defaultFileClassIds(classes: { id: string }[], currentClassId: string | null): string[] {
  if (currentClassId && classes.some((c) => c.id === currentClassId)) return [currentClassId]
  if (classes.length === 1) return [classes[0].id]
  return []
}

/** 勾 / 取消一个班。`multiple=false`（线上库还没跑 §19）时退化成单选：点另一个就换过去 */
export function toggleFileClassIds(ids: string[], id: string, multiple = true): string[] {
  const has = ids.includes(id)
  if (!multiple) return has ? [] : [id]
  return has ? ids.filter((x) => x !== id) : [...ids, id]
}

/**
 * 列表里那一行怎么写归属。
 * ⚠️ "未指派"**必须说出来**：教室端看不到这件事不能显示成一片空白（本项目对
 * "空态不报错也不说明"踩过好几次坑）。认不出的 id（班被删了）会被跳过。
 */
export function fileClassLabel(classes: { id: string; name: string }[], ids: string[]): string {
  const names = fileClassNames(classes, ids)
  return names.length ? names.join('、') : '未指派班级 · 教室端看不到'
}

/** 归属里至少有一个**认得出的班**（班被删了就等于没归属）—— 界面上的强调色用它，文案用上面那个 */
export function fileClassAssigned(classes: { id: string }[], ids: string[]): boolean {
  return ids.some((id) => classes.some((c) => c.id === id))
}

function fileClassNames(classes: { id: string; name: string }[], ids: string[]): string[] {
  return ids.map((id) => classes.find((c) => c.id === id)?.name).filter((n): n is string => Boolean(n))
}

/**
 * 写入时的班级归属列 —— **兼容期纪律的唯一实现**（与 `remote.ts` 的 `assignmentWriteRow` 同一套）：
 *   · `class_ids` 这一列存在 → 写数组（空数组照写，**不写 null**：null 让读策略判不出来）；
 *   · 列不存在（线上库还没跑 §19）→ 只写**老列** `class_id`（单个班时）。
 *     带上一列不存在的列，整条 insert 会被 PostgREST 拒掉，而本项目是"保存失败 = 刷新即丢"；
 *   · 列不存在 + 选了**两个以上**的班 → **报错**，绝不静默只存一个（老师会以为发出去了）。
 */
export function fileClassColumns(classIds: string[], hasClassIdsCol: boolean): Record<string, unknown> {
  const ids = [...new Set(classIds.filter(Boolean))]
  if (hasClassIdsCol) return { class_ids: ids }
  if (ids.length > 1) throw new Error(`一个文件暂时只能选一个班（${FILE_MIGRATION_HINT}）`)
  return { class_id: ids[0] ?? null }
}

/* ---------------- 兼容期：`class_ids` 这一列在不在？（schema.sql §19） ----------------

   与 `remote.ts` 的 `ensureSubjectCols()` **同一套纪律**（判据只看「列不存在」这一种错误）：
     · 读：`select('*')` 读不到那个键**不报错** → `classIds` 兜底成空数组（= 未指派）；
     · 写：先探测一次，列不在就**摘掉这一列**（否则整条 insert 被 PostgREST 拒 → 刷新即丢），
           改走老列 `class_id`（单个班）；
     · SQL 真跑过之后**前端一行都不用改**，新列自动开始写（刷新生效）。 */

export type FileClassCols = { classIds: boolean }

let fileClassColsProbe: Promise<FileClassCols> | null = null

/**
 * 🆕 2026-10-08 · **只读**的探测结论（管理台自检面板 C2 的第四格要它）。
 *
 * 🔴 为什么非要有它：`ensureFileClassCols()` 对外只回 `{ classIds }`，而
 *    "探测本身没结论（网络抖动 / 权限错误）"**被兜底成了 `true`**（那是给**写路径**用的：
 *    宁可多带一列也不要一次抖动就把归属永久写停）。于是屏上"列在"与"我没问出来"
 *    长得一模一样 —— 而项目的硬纪律是**"没结论"必须是独立的第四种状态，绝不能画绿**
 *    （`AGENTS.md` §三.4）。
 *
 * ⚠️ 这两个 getter **一个字节都不改变探测的时机、次数与返回值** ——
 *    只是把 `probeFileClassCols()` 里本来就知道的结论另记一份，
 *    与 `data/remote.ts` 的 `getExamTablesProbeStatus()` 是同一套写法。
 *    ⚠️ 探过之前是 `'pending'`（还没问），**不是** `'indeterminate'`。
 */
export type FileClassColsStatus = 'pending' | 'present' | 'missing' | 'indeterminate'

let fileClassColsStatus: FileClassColsStatus = 'pending'
let fileClassColsProbeAt: number | null = null

export function getFileClassColsStatus(): FileClassColsStatus {
  return fileClassColsStatus
}
export function getFileClassColsProbeAt(): number | null {
  return fileClassColsProbeAt
}

async function probeFileClassCols(): Promise<FileClassCols> {
  const c = getSupabase()
  const mark = (s: FileClassColsStatus) => {
    fileClassColsStatus = s
    fileClassColsProbeAt = Date.now()
  }
  if (!c) {
    /* 本地模式：没有云端可问 —— "无法判断"，不是"列不在" */
    mark('indeterminate')
    return { classIds: false }
  }
  try {
    const { error } = await c.from('shared_files').select('class_ids').limit(1)
    if (!error) {
      mark('present')
      return { classIds: true }
    }
    const msg = String(error.message ?? '')
    const code = String((error as { code?: string }).code ?? '')
    // 🔴 返回值照旧：网络抖动 / 权限问题一律当作**有**（否则一次抖动就把归属永久写停了）
    if (code === '42703' || /does not exist/i.test(msg)) {
      mark('missing')
      return { classIds: false }
    }
    mark('indeterminate')
    return { classIds: true }
  } catch {
    mark('indeterminate')
    return { classIds: true }
  }
}

/** 探测一次（同一页面内只探一次），给上传页与写路径用 */
export function ensureFileClassCols(): Promise<FileClassCols> {
  if (!fileClassColsProbe) fileClassColsProbe = probeFileClassCols()
  return fileClassColsProbe
}

/** §19 还没跑时界面上要显示的那句话（**下一步动作写在错误信息里**，与 EXAM_MIGRATION_HINT 同款） */
export const FILE_MIGRATION_HINT =
  '线上数据库还没有「班级归属」这一列：请到 Supabase → SQL Editor 跑 supabase/schema.sql 第 19 段'

/**
 * 行 → 本地形状。`class_ids` 读不到（列不存在）**不报错**，兜底成空数组。
 * ⚠️ 老列 `class_id` **故意不读**：§19 之后没有任何策略按它判归属，
 *    在这里兜底就会造出"界面显示一个班、教室端其实看不见"的分叉（一个字段一种语义）。
 */
const rowToFile = (r: Record<string, unknown>): SharedFile => ({
  id: r.id as string,
  name: r.name as string,
  mime: (r.mime as string) ?? '',
  size: Number(r.size) || 0,
  classIds: ((r.class_ids as string[] | null) ?? []).filter(Boolean),
  storagePath: r.storage_path as string,
  createdAt: new Date(r.created_at as string).getTime(),
})

export async function listFiles(): Promise<SharedFile[]> {
  const { data, error } = await sb()
    .from('shared_files')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  // 教室端能读到哪些行由数据库的读策略决定（§19.3），这里**一条过滤都不加**
  return (data ?? []).map((r) => rowToFile(r as Record<string, unknown>))
}

/**
 * 生成一个**标准 v4 UUID**（照 `data/store.ts:58` / `lib/backup.ts:149` 那两份抄，
 * 本文件是**第三份**）。
 *
 * 🔴🔴 **为什么原来这里是裸的 `crypto.randomUUID()`**（2026-10-04 扫安卓 8 扫出来的）：
 *   它要求两件事，**缺一件就是 `TypeError`**：
 *     ① **Chrome ≥ 92** —— 安卓 8 上**从没更新过 WebView** 的那批（Chrome 138 之前
 *        一直在发，但国产机没有 GMS 就不走 Play）达不到；
 *     ② **安全上下文**（https / localhost）—— `app://` 已在
 *        `_src/desktop/main-teacher.js:74` 注册 `secure: true` ✅，
 *        但**局域网 http 访问**不是 ✗（`store.ts:55-56` 早就记着这条）。
 *   两种情况它都是 `undefined` ⇒ `crypto.randomUUID()` 当场抛
 *   ⇒ **整个上传断掉**，而报错落在"选完文件之后"，老师看到的是"点了没反应"。
 *
 * ⚠️ `store.ts` 与 `backup.ts` **早就各守了一次**，唯独这里漏了 ——
 *   这是「查不到 ≠ 没有」的另一面：**已有的守卫不代表全都有**。
 *   三处同构的写法，改一处的判据时**三处都要看**。
 *
 * ⚠️ 这里产出**标准 v4**（16 字节 + 版本位），不偷懒写短串 ——
 *   `backup.ts:148` 记着理由：**uuid 列不接受短串**，哪天这个 id 被拿去写库就坏了。
 *
 * ⚠️ 不 `import` `store.ts`：`lib/` 不该反过来依赖 `data/`
 *   （`backup.ts` 里那条注释写的就是这个理由）。
 */
function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export async function uploadFile(file: File, teacherId: string, classIds: string[] = []): Promise<SharedFile> {
  const c = sb()

  /*
   * 先探列、再定"归属写进哪一列"：兼容期的两条纪律全在 `fileClassColumns` 里。
   * ⚠️ 顺序讲究：这一步必须**在把文件传上存储之前**跑 —— 多选 + 老库那种情形要当场报错，
   *    不能先把文件传上去再失败（那样存储桶里留一个没人认领的孤儿）。
   */
  const cols = await ensureFileClassCols()
  const classCols = fileClassColumns(classIds, cols.classIds)

  const path = `${teacherId}/${uuid()}-${safeName(file.name)}`

  /*
   * 🔴 A6：**不信浏览器报的类型**。`.html/.svg` 与认不出的一律存成
   * `application/octet-stream` —— 这样即便有人拿到直链，浏览器也只会下载、
   * 不会把它当页面（或脚本）在**本站 origin** 里跑起来。
   * 认得出的那几类仍按真实类型存（图片 / PDF / 视频要能内嵌看、要能播）。
   */
  const storeType =
    kindOf(file.name, file.type) === 'other' ? 'application/octet-stream' : file.type || undefined

  const up = await c.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: storeType,
  })
  if (up.error) throw up.error

  const row = {
    teacher_id: teacherId,
    ...classCols,
    name: file.name,
    mime: file.type || '',
    size: file.size,
    storage_path: path,
  }
  const ins = await c.from('shared_files').insert(row).select().single()
  if (ins.error) {
    // 元数据写失败就把文件也删掉，别留孤儿
    await c.storage.from(BUCKET).remove([path])
    throw ins.error
  }
  return rowToFile(ins.data as Record<string, unknown>)
}

export async function deleteFile(f: SharedFile): Promise<void> {
  const c = sb()
  await c.storage.from(BUCKET).remove([f.storagePath])
  const del = await c.from('shared_files').delete().eq('id', f.id)
  if (del.error) throw del.error
}

/**
 * 取一个限时直链。私有桶必须走签名，默认 2 小时够一节课用。
 *
 * 🔴 A6：`download` 为真时带上下载选项 —— 上游会回 `Content-Disposition: attachment`，
 *    浏览器只存盘、**不会在站点自己的 origin 里渲染它**。
 *    界面上"能内嵌看的那几类"（图片 / PDF / 视频）才传 false，其余一律 true。
 *    ⚠️ 这是第二层；第一层在 `kindOf()`（html / svg 已不算是"能看的"），
 *       第三层在 `uploadFile()`（那几类连存储里的 contentType 都不是 text/html）。
 */
export async function signedUrl(
  path: string,
  seconds = 7200,
  download = false,
): Promise<string | null> {
  const { data, error } = await sb()
    .storage.from(BUCKET)
    .createSignedUrl(path, seconds, download ? { download: true } : undefined)
  if (error) return null
  return data?.signedUrl ?? null
}

/** 把云端文件取成本地 Blob —— 教室端「搬到自己电脑上」用 */
export async function fetchBlob(path: string): Promise<Blob | null> {
  const url = await signedUrl(path, 300)
  if (!url) return null
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return await r.blob()
  } catch {
    return null
  }
}
