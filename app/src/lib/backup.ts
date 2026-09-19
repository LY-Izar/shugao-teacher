import { getSupabase } from './supabase'
import type { Assignment, CallRecord, ClassroomClient, Klass, ScheduleItem, Teacher } from '../data/types'

/* ============================================================
   备份与恢复
   ------------------------------------------------------------
   两种方式，都是「落到本机硬盘上一个文件」：

   ① 一键导出 JSON —— 任何浏览器都能用，教师自己存 U 盘/网盘
   ② 授权一个文件夹，之后每次数据变动自动往里写 —— 需要一次授权

   注意：云端（Supabase）才是主副本，这里是**额外**的一份。
   两边都坏才会真丢数据 —— 这正是备份该有的样子。
   ============================================================ */

export type Backup = {
  v: 1
  at: number
  teacher?: Teacher | null
  classes: Klass[]
  assignments: Assignment[]
  schedule: ScheduleItem[]
  calls: CallRecord[]
  classrooms: ClassroomClient[]
}

export function makeBackup(s: {
  teacher: Teacher | null
  classes: Klass[]
  assignments: Assignment[]
  schedule: ScheduleItem[]
  calls: CallRecord[]
  classrooms: ClassroomClient[]
}): Backup {
  return {
    v: 1,
    at: Date.now(),
    teacher: s.teacher,
    classes: s.classes,
    assignments: s.assignments,
    schedule: s.schedule,
    calls: s.calls,
    classrooms: s.classrooms,
  }
}

/** 一份备份值不值得信 —— 恢复是不可逆的，宁可不恢复也不能恢复半份 */
export function validateBackup(raw: unknown): { ok: true; data: Backup } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '不是有效的备份文件' }
  const b = raw as Partial<Backup>
  if (b.v !== 1) return { ok: false, why: `备份版本不认识（v${String(b.v)}）` }
  if (!Array.isArray(b.classes)) return { ok: false, why: '缺少班级数据' }
  if (!Array.isArray(b.assignments)) return { ok: false, why: '缺少作业数据' }
  const students = b.classes.reduce((n, c) => n + (c.students?.length ?? 0), 0)
  if (students === 0) return { ok: false, why: '备份里一个学生都没有，可能是坏文件' }
  return {
    ok: true,
    data: {
      v: 1,
      at: b.at ?? 0,
      teacher: b.teacher ?? null,
      classes: b.classes,
      assignments: b.assignments,
      schedule: b.schedule ?? [],
      calls: b.calls ?? [],
      classrooms: b.classrooms ?? [],
    },
  }
}

export function backupSummary(b: Backup): string {
  const students = b.classes.reduce((n, c) => n + (c.students?.length ?? 0), 0)
  return `${b.classes.length} 个班级 · ${students} 名学生 · ${b.assignments.length} 份作业档案`
}

/* ---------------- ① 导出 / 导入 ---------------- */

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text())
}

/* ---------------- ② 自动写进指定文件夹 ---------------- */

const HANDLE_KEY = 'shugao.backupDir'
const DB = 'shugao.backup'
const STORE = 'handles'

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('打不开句柄库'))
  })
}

/** 目录句柄可以直接存进 IndexedDB（这是它比路径字符串强的地方） */
async function saveHandle(h: DirHandle): Promise<void> {
  const db = await openDb()
  await new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, 'readwrite')
    t.objectStore(STORE).put(h, HANDLE_KEY)
    t.oncomplete = () => {
      db.close()
      res()
    }
    t.onerror = () => rej(t.error ?? new Error('存句柄失败'))
  })
}

export async function loadHandle(): Promise<DirHandle | null> {
  try {
    const db = await openDb()
    return await new Promise((res) => {
      const t = db.transaction(STORE, 'readonly')
      const r = t.objectStore(STORE).get(HANDLE_KEY)
      r.onsuccess = () => {
        db.close()
        res((r.result as DirHandle) ?? null)
      }
      r.onerror = () => {
        db.close()
        res(null)
      }
    })
  } catch {
    return null
  }
}

export function fsSupported(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

/** 让教师选一个文件夹（必须由点击触发） */
export async function pickFolder(): Promise<DirHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker: () => Promise<DirHandle> })
    .showDirectoryPicker
  if (!picker) return null
  const h = await picker()
  await saveHandle(h)
  return h
}

/**
 * 拿一个**当前可写**的目录句柄。
 * 浏览器重启后权限可能退回 'prompt'，此时必须由用户点击才能再要一次 ——
 * 返回 null 让界面提示教师点一下，不要静默失败。
 */
export async function writableFolder(): Promise<DirHandle | null> {
  const h = await loadHandle()
  if (!h) return null
  const q = await h.queryPermission?.({ mode: 'readwrite' })
  if (q === 'granted') return h
  if (q === 'prompt') {
    const r = await h.requestPermission?.({ mode: 'readwrite' })
    if (r === 'granted') return h
  }
  return null
}

/** 还有句柄但需要教师点一下授权 */
export async function folderNeedsGrant(): Promise<boolean> {
  const h = await loadHandle()
  if (!h) return false
  return (await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted'
}

export async function writeToFolder(name: string, data: unknown): Promise<boolean> {
  const dir = await writableFolder()
  if (!dir) return false
  try {
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify(data))
    await w.close()
    return true
  } catch {
    return false
  }
}

/* ---------------- 恢复时把数据推回云端 ---------------- */

/**
 * 恢复不只是"写回本地" —— 云端才是主副本，必须一起推上去，
 * 否则下次刷新就被云端覆盖回去了。
 */
export async function pushBackupToCloud(b: Backup, teacherId: string): Promise<string> {
  const sb = getSupabase()
  if (!sb) return '本地模式：只恢复到本机'
  try {
    if (b.teacher) {
      await sb.from('teachers').upsert({ id: teacherId, name: b.teacher.name, subject: b.teacher.subject, school: b.teacher.school })
    }
    const cls = b.classes.map((c) => ({
      id: c.id,
      teacher_id: teacherId,
      name: c.name,
      grade: c.grade,
      year: c.year,
    }))
    if (cls.length) await sb.from('classes').upsert(cls)

    const stu = b.classes.flatMap((c) =>
      (c.students ?? []).map((s) => ({
        id: s.id,
        class_id: c.id,
        student_no: s.studentNo,
        name: s.name,
        status: s.status,
      })),
    )
    for (let i = 0; i < stu.length; i += 200) await sb.from('students').upsert(stu.slice(i, i + 200))
    return `已恢复到云端：${cls.length} 个班级 / ${stu.length} 名学生`
  } catch (e) {
    return `本地已恢复，但推云端失败：${e instanceof Error ? e.message : String(e)}`
  }
}
