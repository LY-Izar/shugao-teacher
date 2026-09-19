import { getSupabase } from './supabase'

/* ============================================================
   教师端 → 教室端 的文件互传
   文件存在 Supabase Storage 的私有桶里，这里只管增删查和取签名链接。
   ============================================================ */

export type SharedFile = {
  id: string
  name: string
  mime: string
  size: number
  classId?: string
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

export async function listFiles(): Promise<SharedFile[]> {
  const { data, error } = await sb()
    .from('shared_files')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    mime: (r.mime as string) ?? '',
    size: Number(r.size) || 0,
    classId: (r.class_id as string) ?? undefined,
    storagePath: r.storage_path as string,
    createdAt: new Date(r.created_at as string).getTime(),
  }))
}

export async function uploadFile(file: File, teacherId: string, classId?: string): Promise<SharedFile> {
  const c = sb()
  const path = `${teacherId}/${crypto.randomUUID()}-${safeName(file.name)}`

  const up = await c.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  })
  if (up.error) throw up.error

  const row = {
    teacher_id: teacherId,
    class_id: classId ?? null,
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
  const r = ins.data
  return {
    id: r.id as string,
    name: r.name as string,
    mime: (r.mime as string) ?? '',
    size: Number(r.size) || 0,
    classId: (r.class_id as string) ?? undefined,
    storagePath: r.storage_path as string,
    createdAt: new Date(r.created_at as string).getTime(),
  }
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
