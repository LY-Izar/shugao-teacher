/* ============================================================
   教室端本机文件库（IndexedDB）
   ------------------------------------------------------------
   云端只做中转：教师传上来 → 教室端拉下来存到本机 → 立刻从云端删除。
   这样 1 GB 的免费存储永远不会被课件堆满。

   为什么用 IndexedDB 而不是 File System Access API：
   后者能存成「我的电脑里看得见的文件」，但每次浏览器重启都要重新授权，
   一体机上没人去点那个授权框。IndexedDB 不需要任何授权、不会失效，
   教室端打开文件时从库里取 Blob 即可；需要交给 Office 的
   （PPT / Word）再触发一次浏览器下载，落到「下载」文件夹。
   ============================================================ */

const DB_NAME = 'shugao.classroom'
const STORE = 'files'
const VERSION = 1

export type LocalFile = {
  /** 与云端 shared_files.id 一致，便于对账 */
  id: string
  name: string
  mime: string
  size: number
  blob: Blob
  savedAt: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个浏览器不支持本机文件库'))
      return
    }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('打开本机文件库失败'))
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('本机文件库操作失败'))
        t.oncomplete = () => db.close()
      }),
  )
}

export function putFile(f: LocalFile): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(f))
}

export function getFile(id: string): Promise<LocalFile | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<LocalFile | undefined>)
}

export function allFiles(): Promise<LocalFile[]> {
  return tx('readonly', (s) => s.getAll() as IDBRequest<LocalFile[]>)
}

export function removeFile(id: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(id) as IDBRequest<undefined>)
}

export function clearFiles(): Promise<undefined> {
  return tx('readwrite', (s) => s.clear() as IDBRequest<undefined>)
}

/** 本机已占多少 —— 一体机硬盘再大也得让教师看得见 */
export async function localUsage(): Promise<{ count: number; bytes: number }> {
  const list = await allFiles()
  return { count: list.length, bytes: list.reduce((n, f) => n + (f.size || f.blob.size || 0), 0) }
}

/** 把 Blob 交给浏览器下载（PPT / Word 这类要本地软件打开的） */
export function saveToDisk(f: LocalFile) {
  const url = URL.createObjectURL(f.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = f.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 给下载留点时间再回收
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 可直接在浏览器里看的类型，用 Blob URL 打开 */
export function openLocal(f: LocalFile) {
  const url = URL.createObjectURL(f.blob)
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
