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

import { saveBlob, openInPlace, type OpenResult } from './fileOut'

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
  // 🔴 R4：转发给统一那一支（网页分支逐字照抄这里原来的实现 —— 60s 回收那一版）
  void saveBlob(f.name, f.blob)
}

/**
 * 可直接在浏览器里看的类型，用 Blob URL 打开。
 *
 * 🔴 R4：这是**第二种能力**，不能并进 saveBlob。
 *   网页上 `window.open(blobUrl)`；壳里必须走原生 —— 否则会在**没有 preload 的
 *   浏览器窗口**里打开，样式全丢、点不了（Android WebView 里更是静默失败）。
 *
 * 🔴🔴 **2026-10-03：改成返回结局，不再 `void` 掉**
 *   原先这里 `void openInPlace(...)`，而底下那一支把壳的返回值整个扔了
 *   ⇒ 教室端那台机器上「这个 .png 没有系统程序能打开」时，
 *   **老师点了什么都不会发生，界面也不会说为什么**（静默失败）。
 *   返回 `'failed'` 是调用方给提示的唯一机会 —— 别再 `void` 掉。
 *
 * @returns `'failed'` = 没打开成（调用方**应该**提示，可问"要不要改成另存为"）
 */
export function openLocal(f: LocalFile): Promise<OpenResult> {
  return openInPlace(f.name, f.blob)
}
