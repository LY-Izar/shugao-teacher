import { useCallback, useEffect, useRef } from 'react'
import {
  fsSupported,
  loadHandle,
  makeBackup,
  writableFolder,
  writeToFolder,
} from '../lib/backup'
import { hasBuiltinBackupDir } from '../lib/fileOut'
import { useStore } from '../data/store'

/**
 * 「自动备份到本机」—— **壳侧底层能力，不占屏**（2026-10-24 用户拍板）。
 *
 * ============================================================================
 * 为什么从"一个功能块窗口"改成"一段没有 UI 的钩子"
 * ============================================================================
 * 教室屏是给学生看的：备份是**运维动作**，老师不需要看着它，更不该占一格给学生看。
 * 它原来的三种可见性都收掉了：没有窗口、没有功能块清单条目、没有布局占位。
 * 但**备份本身照跑**（5 分钟一次）——收掉的是"显示"，不是"能力"。
 *
 * 🔴 失败仍然必须让人知道：屏上不显示状态之后，**吐司是唯一的信号**。
 *    所以 `reportBkIssue` 这条保留：同一条原因 10 分钟只弹一次（这个 tick 自己 5 分钟一次，
 *    不节流会刷屏）。
 *
 * ⚠️ 三条从旧教室端搬过来、不能丢的判据（详见 `备份` 那轮的注释，这里只留结论）：
 *   ① **exe 自带备份文件夹**（`hasBuiltinBackupDir()`）⇒ 整条"授权文件夹"流程跳过。
 *      不跳的话：`loadHandle()` 恒空 ⇒ 每 5 分钟报"还没选文件夹"、`writeToFolder` 一次都走不到
 *      （一直在写、其实一份没写，而屏上看着"自动备份开着呢"）。
 *   ② 从没设过文件夹 ⇒ **不弹吐司**（网页版老师会自己看到"设置文件夹"的地方；
 *      而教室屏挂一整天，每 10 分钟弹一次只会变成噪声）。
 *   ③ 权限失效 / 写失败 ⇒ **必须弹**（那才是"以为在备份、其实没有"的真坏法）。
 */
export function useAutoBackup(push: (t: { text: string; tone: 'ok' | 'bad' | 'warn' | 'info'; desc?: string }) => void) {
  const supported = fsSupported()
  const issueRef = useRef({ why: '', at: 0 })

  const report = useCallback(
    (why: string) => {
      console.warn('[backup]', why)
      const at = Date.now()
      if (issueRef.current.why === why && at - issueRef.current.at < 10 * 60_000) return
      issueRef.current = { why, at }
      push({ text: '自动备份没写成', tone: 'bad', desc: why })
    },
    [push],
  )

  /* 网页版里老师点「设置文件夹」要的一个入口：没有 UI 时只能靠外部调这个函数。
     返回 true 表示真的开始写了（写不成会弹吐司）。 */
  return useCallback(async () => {
    if (!supported) {
      report('这个浏览器不支持自动写文件夹')
      return false
    }
    const builtin = hasBuiltinBackupDir()
    if (builtin) {
      return writeToFolder('树高备份.json', makeBackup(useStore.getState()))
    }
    const dir = await writableFolder()
    if (!dir) return false
    return writeToFolder('树高备份.json', makeBackup(useStore.getState()))
  }, [supported, report])
}

/**
 * 定时那一半：挂一次就开始跑（5 分钟一个 tick）。组件卸载即停。
 * 与 `useAutoBackup` 的返回值（手动触发）分开，是为了让"定时"和"点一下"各自只有一个入口。
 */
export function useAutoBackupTicker(push: (t: { text: string; tone: 'ok' | 'bad' | 'warn' | 'info'; desc?: string }) => void) {
  const supported = fsSupported()
  const issueRef = useRef({ why: '', at: 0 })
  const report = useCallback(
    (why: string) => {
      console.warn('[backup]', why)
      const at = Date.now()
      if (issueRef.current.why === why && at - issueRef.current.at < 10 * 60_000) return
      issueRef.current = { why, at }
      push({ text: '自动备份没写成', tone: 'bad', desc: why })
    },
    [push],
  )

  useEffect(() => {
    if (!supported) return
    let alive = true
    const builtin = hasBuiltinBackupDir()
    const tick = async () => {
      if (builtin) {
        const ok = await writeToFolder('树高备份.json', makeBackup(useStore.getState()))
        if (!alive) return
        if (!ok) report('内置备份目录写不进去（检查程序数据目录是否可写）')
        return
      }
      /* 这里**只查询、不申请** —— requestPermission 必须由用户手势触发 */
      const dir = await loadHandle()
      if (!alive) return
      if (!dir) return // 从没设过：网页版自己会看到设置入口，这里不弹（见文件头 ②）
      const q = await dir.queryPermission?.({ mode: 'readwrite' })
      if (!alive) return
      if (q !== 'granted') {
        report('浏览器重启后文件夹权限会失效 —— 重新在「我的 → 备份」里点一下恢复')
        return
      }
      const ok = await writeToFolder('树高备份.json', makeBackup(useStore.getState()))
      if (!alive) return
      if (!ok) report('备份文件没写成（文件夹不可写或已断开）')
    }
    void tick()
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [supported, report])
}
