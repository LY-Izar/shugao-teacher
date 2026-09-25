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

export type FileKind = 'image' | 'html' | 'pdf' | 'ppt' | 'doc' | 'video' | 'other'

/** 按扩展名判类型 —— 手机拍的照片 mime 常常不准，扩展名更可信 */
export function kindOf(name: string, mime = ''): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return 'image'
  if (['html', 'htm'].includes(ext)) return 'html'
  if (ext === 'pdf') return 'pdf'
  if (['ppt', 'pptx'].includes(ext)) return 'ppt'
  if (['doc', 'docx', 'xls', 'xlsx'].includes(ext)) return 'doc'
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return 'other'
}

export const KIND_TEXT: Record<FileKind, string> = {
  image: '图片',
  html: '网页',
  pdf: 'PDF',
  ppt: 'PPT',
  doc: '文档',
  video: '视频',
  other: '文件',
}

/** 教室端能不能直接打开看 —— 这决定了界面上是「看」还是「下载」 */
export function canViewInline(k: FileKind): boolean {
  return k === 'image' || k === 'html' || k === 'pdf' || k === 'video'
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

async function probeFileClassCols(): Promise<FileClassCols> {
  const c = getSupabase()
  if (!c) return { classIds: false }
  try {
    const { error } = await c.from('shared_files').select('class_ids').limit(1)
    if (!error) return { classIds: true }
    const msg = String(error.message ?? '')
    const code = String((error as { code?: string }).code ?? '')
    // 网络抖动 / 权限问题一律当作**有**（否则一次抖动就把归属永久写停了）
    return { classIds: !(code === '42703' || /does not exist/i.test(msg)) }
  } catch {
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

export async function uploadFile(file: File, teacherId: string, classIds: string[] = []): Promise<SharedFile> {
  const c = sb()

  /*
   * 先探列、再定"归属写进哪一列"：兼容期的两条纪律全在 `fileClassColumns` 里。
   * ⚠️ 顺序讲究：这一步必须**在把文件传上存储之前**跑 —— 多选 + 老库那种情形要当场报错，
   *    不能先把文件传上去再失败（那样存储桶里留一个没人认领的孤儿）。
   */
  const cols = await ensureFileClassCols()
  const classCols = fileClassColumns(classIds, cols.classIds)

  const path = `${teacherId}/${crypto.randomUUID()}-${safeName(file.name)}`

  const up = await c.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
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

/** 取一个限时直链。私有桶必须走签名，默认 2 小时够一节课用。 */
export async function signedUrl(path: string, seconds = 7200): Promise<string | null> {
  const { data, error } = await sb().storage.from(BUCKET).createSignedUrl(path, seconds)
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
