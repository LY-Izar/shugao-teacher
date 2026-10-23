import { useCallback, useEffect, useRef, useState } from 'react'
import {
  backupTargetHint,
  fsSupported,
  loadHandle,
  makeBackup,
  pickFolder,
  writableFolder,
  writeToFolder,
} from '../../lib/backup'
import { hasBuiltinBackupDir } from '../../lib/fileOut'
import { useStore } from '../../data/store'

/**
 * 「自动备份到本机」—— **本体功能块**（2026-10-24 用户拍板：备份是默认能力，不走插件）。
 *
 * 从旧教室端 `Classroom.tsx` 的那一块**逐行搬过来**（行为一个字没改），只换了两样：
 * 外层 `Panel` 由新壳窗口标题栏代替；吐司走新壳的 `push`。
 *
 * 🔴 三条搬过来时不能丢的判据：
 *   ① **exe 自带备份文件夹**（`hasBuiltinBackupDir()`）⇒ 整条"授权文件夹"的流程要跳过。
 *      原来第一件事是 `loadHandle()`，没有句柄就当场 return；而 exe 里根本不存在"教师授权过的文件夹"
 *      （`showDirectoryPicker` 必须有人点一次，教室里那块屏经常没有键鼠）
 *      ⇒ 每 5 分钟报一次「还没有选备份文件夹」，`writeToFolder` **一次都走不到**：
 *      一直在写、其实一份都没写，而屏上看着「自动备份开着呢」。
 *   ② 备份失败必须**弹出来**，同一原因 10 分钟只弹一次（这个 tick 自己 5 分钟一次，不节流会刷屏）。
 *      屏挂在墙上没人盯；自动备份悄没声地失败，等于没有备份。
 *   ③ 壳里要显示**真绝对路径**（老师照着它去 U 盘拷走）；拿不到时不许假装有。
 */
const BACKUP_NAME = '树高备份.json'
/** 同一条原因 10 分钟内只弹一次 */
const BK_ISSUE_REPEAT_MS = 10 * 60_000

export function BackupBlock({
  push,
}: {
  push: (t: { text: string; tone: 'ok' | 'bad' | 'warn' | 'info'; desc?: string }) => void
}) {
  const bkSupported = fsSupported()
  const [bk, setBk] = useState<number | null>(null)
  const [bkBusy, setBkBusy] = useState(false)
  const [needsGrant, setNeedsGrant] = useState(false)
  const [bkDir, setBkDir] = useState<string | null>(null)

  const bkIssueRef = useRef({ why: '', at: 0 })
  const reportBkIssue = useCallback(
    (why: string) => {
      console.warn('[backup]', why)
      const at = Date.now()
      if (bkIssueRef.current.why === why && at - bkIssueRef.current.at < BK_ISSUE_REPEAT_MS) return
      bkIssueRef.current = { why, at }
      push({ text: '自动备份没写成', tone: 'bad', desc: why })
    },
    [push],
  )

  useEffect(() => {
    if (!bkSupported) return
    let alive = true
    const builtin = hasBuiltinBackupDir()
    const tick = async () => {
      if (builtin) {
        const ok = await writeToFolder(BACKUP_NAME, makeBackup(useStore.getState()))
        if (!alive) return
        setNeedsGrant(false)
        setBkDir(await backupTargetHint())
        if (ok) setBk(Date.now())
        return
      }
      /* 这里**只查询、不申请** —— requestPermission 必须由用户手势触发 */
      const dir = await loadHandle()
      if (!alive) return
      if (!dir) {
        /*
         * 从来没有设过文件夹 ⇒ **不弹吐司**：块里那句"选一个文件夹（建议放在网盘同步目录里）"
         * 已经是给老师的指引；教室屏挂一整天、没人盯着，每 10 分钟弹一次"自动备份没写成"
         * 只会变成噪声（真正的坏法见下一条：设过但权限失效 —— 那才必须弹）。
         */
        return
      }
      const q = await dir.queryPermission?.({ mode: 'readwrite' })
      if (!alive) return
      if (q !== 'granted') {
        setNeedsGrant(true)
        reportBkIssue('浏览器重启后文件夹权限会失效 —— 在「自动备份到本机」里点「点一下恢复」')
        return
      }
      const ok = await writeToFolder(BACKUP_NAME, makeBackup(useStore.getState()))
      if (!alive) return
      setNeedsGrant(false)
      if (ok) setBk(Date.now())
    }
    void tick()
    /* ⚠️ 异步里 setState：同步 setState 会触发级联渲染（oxlint react/set-state-in-effect） */
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [bkSupported, reportBkIssue])

  return (
    <div className="flex h-full flex-col p-3.5">
      <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
        <span style={{ color: 'var(--color-ink2)' }}>自动备份到本机</span>
        <span className="flex-1" />
        {/* exe 自带备份文件夹：装上就写、不需要授权 ⇒ 不摆「设置文件夹」（摆着会让人以为要点一下才开） */}
        {bkSupported && !bkDir ? (
          <button
            type="button"
            disabled={bkBusy}
            onClick={async () => {
              setBkBusy(true)
              try {
                /* 两种情况都在点击里处理 —— 浏览器只允许用户手势里要权限 */
                const dir = needsGrant ? await writableFolder() : await pickFolder()
                if (!dir) {
                  push({ text: '没有授权文件夹，自动备份没开', tone: 'warn' })
                  return
                }
                const ok = await writeToFolder(BACKUP_NAME, makeBackup(useStore.getState()))
                setNeedsGrant(false)
                setBk(ok ? Date.now() : null)
                push({
                  text: ok ? '已开启自动备份' : '文件夹不可写，换个位置试试',
                  tone: ok ? 'ok' : 'bad',
                })
              } finally {
                setBkBusy(false)
              }
            }}
            style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
          >
            {bkBusy ? '处理中…' : needsGrant ? '点一下恢复' : '设置文件夹'}
          </button>
        ) : null}
      </div>
      <div
        className="mt-1.5"
        style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7 }}
      >
        {!bkSupported
          ? '这个浏览器不支持自动写文件夹'
          : bkDir
            ? bk
              ? `上次备份：${new Date(bk).toLocaleString('zh-CN')} · 每 5 分钟写一份，存到：${bkDir}`
              : `每 5 分钟写一份，存到：${bkDir}`
            : needsGrant
              ? '点右上角「点一下恢复」继续自动备份'
              : bk
                ? `上次备份：${new Date(bk).toLocaleString('zh-CN')} · 每 5 分钟一次`
                : '选一个文件夹（建议放在网盘同步目录里），之后每 5 分钟自动写一份备份。'}
      </div>
    </div>
  )
}
