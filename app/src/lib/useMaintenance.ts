/* ============================================================
   维护状态的读取钩子 —— 2026-09-29 管理台第二期
   ------------------------------------------------------------
   🔴 **两条路都必须有**（方案 §二.3 的表）：
      · **进页面读一次**（首屏就知道）；
      · **每 30 秒轮询兜底**（维护中时改成 10 秒 —— 好让"恢复了"尽快被看到）。

   ⚠️ **为什么不做 Realtime 推送**（这一条是**明确没做**的，写下来免得被当成漏了）：
     第一期 H4 留档的现场是"**Realtime 的 websocket 悄悄断，而 REST 心跳照常**"。所以
     "一种状态的两种来源会骗人"—— 兜底必须有一条**不依赖 websocket** 的路。
     本项目现在只有这一条路（轮询）。加 Realtime 是**增量**，不是替代；
     而它要动 `schema.sql` 的 publication（§8 那一段），风险与该功能的收益不成比例。
     代价：最坏情况下"开启维护"要 30 秒才被看到。**这个代价写在 §二十五 里。**

   🔴 读不到时按"未维护"处理（fail-open），但 `read:'failed'` 会一路带到界面上
     （面板必须显示成灰的"维护状态：读不到"）。
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAINTENANCE_UNKNOWN,
  fetchMaintenanceStatus,
  type MaintenanceStatus,
} from './maintenance'
import {
  RELEASE_SLOTS_UNKNOWN,
  releaseDefaultNote,
  type Release,
  type ReleaseSlots,
} from './release'
import { devInjectedMaintenance, devInjectedRelease } from './roles'

/** 常态轮询间隔：30 秒（方案里写死的那个数） */
export const POLL_MS = 30_000
/** 维护中时的轮询间隔：10 秒（"恢复了"要尽快被看到） */
export const POLL_ACTIVE_MS = 10_000

/**
 * 🧪 DEV-only：`?maint=…` 装成"维护中"、`?rel=…` 装成"有新版本"（生产构建里被摇掉）。
 * 理由与三条边界写在 `lib/roles.ts` 的 `devInjectedMaintenance()` / `devInjectedRelease()` 上。
 */
function devForced(): MaintenanceStatus | null {
  const search = typeof location === 'undefined' ? '' : location.search
  const msg = devInjectedMaintenance(search)
  const rel = devInjectedRelease(search)
  if (msg === null && rel === null) return null

  /* 🧪 公告是**线上一档的形状**（列名）—— 与真服务端那一份走同一个 `releaseFromRow`
     🔴 `?urls=` 造出来的地址**同时**进 `downloads` 那一层（2026-10-04 起，那三层读数
        的分工与真服务端一致：公告那一层看 `enabled`，地址这一层不看）。 */
  let slots: ReleaseSlots = RELEASE_SLOTS_UNKNOWN
  if (rel) {
    const apk = rel.urls === 'exe' ? '' : 'https://example.com/update'
    const exe = rel.urls === 'apk' ? '' : 'https://example.com/update'
    const notice: Release = {
      version: rel.version,
      force: rel.force,
      note: releaseDefaultNote(rel.version, rel.force),
      /* 占位链接：只为让「下载最新版」与「我的 → 关于」那几颗按钮真的出现
         （截图里不许出现真域名）。`?urls=apk` / `?urls=exe` 让它**只填一半** ——
         门禁靠它验"面板只填了其中一个时，屏上只摆对应的那一颗"。 */
      urlApk: apk,
      urlExe: exe,
    }
    /* 🔴 `rel_off=1`（这一档公告已撤下）时**公告那一层是 null**，而
       `downloads` 那一层照旧有地址 —— 与真服务端 `/api/status` 的分工逐字一致
       （用户 2026-10-04 拍板：「公告撤下了，下载也照样能用」）。
       ⚠️ `downloads` 只填**这一屏那一档**（`?slot=classroom` 才填教室端）——
          真服务端是两档各一行、各自独立；这里造"教师端那一屏"时把教室端也填上，
          屏上就会冒出一颗教室里那台一体机才该有的按钮（门禁 ⑦b 组合二/三 当场红过）。 */
    const EMPTY_DL = { url_apk: '', url_exe: '' }
    slots = {
      teacher: rel.live && rel.slot === 'teacher' ? notice : null,
      classroom: rel.live && rel.slot === 'classroom' ? notice : null,
      read: 'ok',
      reason: '',
      downloads: {
        teacher: rel.slot === 'teacher' ? { url_apk: apk, url_exe: exe } : EMPTY_DL,
        classroom: rel.slot === 'classroom' ? { url_apk: apk, url_exe: exe } : EMPTY_DL,
      },
    }
  }

  const base: MaintenanceStatus = { ...MAINTENANCE_UNKNOWN, at: Date.now(), release: slots }
  if (msg === null) return base
  return {
    ...base,
    enabled: true,
    message: msg,
    until: Date.now() + 4 * 3600_000,
    read: 'ok',
    reason: '',
  }
}

/**
 * 两个状态"看起来一样"吗？
 *
 * 🔴 为什么必须有它：这个 hook 挂在**整个应用**外面（`MaintenanceGate` 包着 `<Routes>`），
 *    所以它的每一次 `setState` 都会**重渲染整棵树**。而轮询是每 30 秒一次 ——
 *    每次都给一个新对象的话，就是"**每 30 秒把整个应用重渲染一遍**"，
 *    在真机上表现为偶发的点击丢失（元素被换掉 → 指针事件落空），
 *    在 `shots.mjs` 里表现为 `element was detached from the DOM`。
 *    状态**真的变了**才 setState，这是轮询类 hook 的常规纪律。
 */
function sameStatus(a: MaintenanceStatus, b: MaintenanceStatus): boolean {
  return (
    a.enabled === b.enabled &&
    a.message === b.message &&
    a.until === b.until &&
    a.read === b.read &&
    a.reason === b.reason &&
    sameRelease(a.release, b.release)
  )
}

/**
 * 🔴 两档公告也要比 —— **漏了这一条就是"新发的公告永远不弹"**：
 *    这个 hook 只在"真的变了"时才 setState（理由见 `sameStatus`），所以
 *    "维护没变、只有公告变了"的那一次轮询必须被认出来。
 */
function sameRelease(a: ReleaseSlots, b: ReleaseSlots): boolean {
  const one = (x: Release | null, y: Release | null) =>
    x === y ||
    (x !== null &&
      y !== null &&
      x.version === y.version &&
      x.force === y.force &&
      x.note === y.note &&
      x.urlApk === y.urlApk &&
      x.urlExe === y.urlExe)
  return (
    one(a.teacher, b.teacher) &&
    one(a.classroom, b.classroom) &&
    a.read === b.read &&
    a.reason === b.reason
  )
}

export function useMaintenanceStatus(): MaintenanceStatus & { refresh: () => void } {
  const [status, setStatus] = useState<MaintenanceStatus>(MAINTENANCE_UNKNOWN)
  /** 防"重叠请求"：上一次还没回来就不再发一次（断网时 30 秒一次会堆起来） */
  const busy = useRef(false)
  const alive = useRef(true)

  /** 只在**真的变了**的时候 setState（见 `sameStatus` 的注释） */
  const apply = useCallback((s: MaintenanceStatus) => {
    setStatus((prev) => (sameStatus(prev, s) ? prev : s))
  }, [])

  const refresh = useCallback(() => {
    /* 🧪 DEV 钩子优先：本地演示模式下没有服务端，不装的话这一整块行为断言不了 */
    const forced = devForced()
    if (forced) {
      apply(forced)
      return
    }
    if (busy.current) return
    busy.current = true
    void fetchMaintenanceStatus()
      .then((s) => {
        if (!alive.current) return
        apply(s)
      })
      .finally(() => {
        busy.current = false
      })
  }, [apply])

  /* 首屏读一次（⚠️ 走一个 0ms 定时器：effect 里**同步** setState 会触发级联渲染，
       而"读一次"本来就该是一次异步取数 —— 见 `admin-checks` 的同一族纪律） */
  useEffect(() => {
    alive.current = true
    const t = window.setTimeout(refresh, 0)
    return () => {
      alive.current = false
      window.clearTimeout(t)
    }
  }, [refresh])

  /* 轮询：间隔随"现在是不是维护中"变 */
  useEffect(() => {
    const t = window.setInterval(refresh, status.enabled ? POLL_ACTIVE_MS : POLL_MS)
    return () => window.clearInterval(t)
  }, [refresh, status.enabled])

  /*
   * 回到这个标签页 / 网络恢复 / 窗口重新获得焦点时**立刻再读一次**。
   * 理由：浏览器会把后台标签页的定时器压到分钟级 —— 而教室里那块屏
   * 一挂一整天，"切回来发现还停在维护页"是最刺眼的一种。
   */
  useEffect(() => {
    const on = () => refresh()
    window.addEventListener('focus', on)
    window.addEventListener('online', on)
    document.addEventListener('visibilitychange', on)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('online', on)
      document.removeEventListener('visibilitychange', on)
    }
  }, [refresh])

  return { ...status, refresh }
}
