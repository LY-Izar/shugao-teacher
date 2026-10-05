import { useEffect, useRef } from 'react'
import { useStore, useToast } from '../data/store'
import { loadSnoozes } from '../data/remote'
import {
  notifyAsync,
  readNotifyPermission,
  shellCanScheduleAlarms,
  shellCanOpenExactAlarmSettings,
  canScheduleExactNative,
  openExactAlarmSettings,
  nativeReminderPlan,
  scheduleNativeReminders,
} from '../lib/notify'
import { REMIND_BEFORE, dueRemindersWithSnooze, toMinutes, weekdayOf } from '../lib/schedule'
import { beijingNow, dayKind, ymdOf } from '../lib/holiday'

const SEEN_KEY = 'shugao.remind.seen'

/**
 * 交给系统排程时**往后算几天**。
 *
 * 🔴 这个数不是"越多越好"：每一条都会在系统里留一个精确闹钟
 *    （`AlarmManager.setExactAndAllowWhileIdle`，部分 ROM 对单个应用有配额），
 *    而**每次页面重新可见都会重排一遍**。3 天 = 老师手机上永远有"今天 / 明天 / 后天"
 *    三天的提醒 —— 只要他每三天开一次应用就够（而老师是每天在用的）。
 */
const NATIVE_PLAN_DAYS = 3

type Seen = Record<string, true>

/**
 * 「系统排不上」那一句到底该说哪一句 —— **唯一的分档点**（纯函数，判据能直接跑它）。
 *
 * 🔴🔴 2026-10-05 真机第二轮：兜底话原来**只有一句**「提醒改在应用内显示。关掉应用就收不到了。」
 *   +「换一版应用可以收到系统通知。」—— 老师看到的是"**收不到**"和一个**做不了的**建议
 *   （这一版就是最新版，换哪一版都收不到）。真因是 **Android 12+ 没给"精确闹钟"
 *   （`SCHEDULE_EXACT_ALARM`）授权**，而这是一步**他两分钟就能自己开的设置**。
 *
 * ⇒ 分档：
 *   · `canExact === false`（**量到了**：系统确实没授权）+
 *     `canOpenSettings === true`（**这个壳有那条跳设置的路**）
 *     ⇒ 给**可操作的一步**：去系统设置把「闹钟与提醒」允许给本应用；
 *   · 其余（没量到 / 跳不了 / 老壳）⇒ 照旧那句兜底，**不许**凭空指着设置说"去那儿开"
 *     （§三.4：量不出来就是不知道，不许猜；指错地方比不说更坏）。
 *
 * ⚠️ `canOpenSettings` 这一档是**能力门**：网页版与两个 exe 上它恒 `false`
 *   ⇒ "去系统设置"那句话在它们那里**从结构上不可达**（与 `shellCanScheduleAlarms()` 同一套纪律）。
 */
export function remindFailHint(
  canExact: boolean | null,
  canOpenSettings: boolean,
): { text: string; desc: string } {
  if (canExact === false && canOpenSettings) {
    return {
      text: '提醒只能在应用内显示',
      desc: '去系统设置把「闹钟与提醒」允许给本应用，关掉应用也能响。',
    }
  }
  return {
    text: '提醒改在应用内显示。关掉应用就收不到了。',
    desc: '换一版应用可以收到系统通知。',
  }
}

function loadSeen(): Seen {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as { day: string; ids: string[] }) : null
    if (!parsed || parsed.day !== ymdOf(beijingNow())) return {}
    return Object.fromEntries(parsed.ids.map((id) => [id, true as const]))
  } catch {
    return {}
  }
}

function saveSeen(seen: Seen) {
  try {
    localStorage.setItem(
      SEEN_KEY,
      JSON.stringify({ day: ymdOf(beijingNow()), ids: Object.keys(seen) }),
    )
  } catch {
    /* 忽略 */
  }
}

/**
 * 上课前 10 分钟提醒下一节课是哪个班的。
 * 每分钟检查一次；同一天同一条日程只提醒一次。
 *
 * **时间口径一律北京时间**（§一 全局约定）：判定窗口、去重、"今天"的节假日
 * 都从同一个 `beijingNow()` 出发。设备时区只是显示口径，不参与判断 ——
 * 老师在国外出差时，课表仍然是学校的时间。
 */
export function useScheduleReminder() {
  const schedule = useStore((s) => s.schedule)
  const classes = useStore((s) => s.classes)
  const push = useToast((s) => s.push)

  /*
   * 🔴 推迟记录读的是 **store 里的那一份**（不是组件自己的 useState）：
   *    日程页的「晚 10 分钟」按钮写的是 store，读取方若是另一个 useState
   *    ⇒ 两个真值源 ⇒ 按钮显示"已推迟到 10:20"、提醒还在 10:00 响。
   */
  const snoozes = useStore((s) => s.scheduleSnoozes)
  const setScheduleSnooze = useStore((s) => s.setScheduleSnooze)

  /*
   * 「系统排不了」这句话**一次会话只说一次**。
   * ⚠️ 用 `useRef` 而不是 `useState`：它不是**要画出来的东西**，只防刷屏 ——
   *    放成 state 就得进 effect 依赖 ⇒ 每次说完话 effect 重跑 ⇒ 又排一遍闹钟。
   */
  const warnedNoNative = useRef(false)

  /**
   * 「已经因为这个把老师送去系统设置、他还没回来」——`useRef` 同理（不是要画出来的东西）。
   *
   * 🔴 为什么要有这一档：送去设置页之后，回来时那句系统排程**照旧是失败的**
   *   （老师未必当场开、也可能开完要等下一次重排）⇒ 不记一笔就会**又跳一次设置、
   *   又弹一次同样的话**。而一旦他开好了，下面那条"开完就生效"会告诉他结果。
   */
  const returnFromSettings = useRef(false)

  /*
   * 🔴🔴 把提醒**交给系统排程**（2026-10-05，真机反馈「装上了、权限也过了，就是收不到通知」）。
   *
   * 改之前：整条提醒只有**应用内那一个 `setInterval(60s)`**（本文件末尾那个 effect）。
   *   应用一退到后台 / 锁屏 / 被杀，WebView 的定时器就冻结 ⇒ 一个提醒都不会响。
   *   而"权限那一步走通了"只说明**能发**，不说明**有人去发** —— 两件事。
   *
   * 现在：把"今天 / 明天 / 后天"要响的提醒算成一张单子交给壳
   *   （apk → `ShugaoNative.scheduleAlarms` → `AlarmManager` 精确闹钟 + 开机重排，
   *    原生那三个类是 2026-10-02 就写好的；断的一直是"网页侧没人调它"）。
   *   ⇒ 应用**关着也能响**。页内那个定时器**照旧保留当兜底**（前台更即时，且失败时有人知道）。
   *
   * ⚠️ 网页版 / exe：`window.__shell_out` 没有这个方法 ⇒ 下面**第一句**就把这条
   *   effect 挡掉（连监听都不挂）⇒ 这条链**什么都不做**（行为一字不变）。
   *
   * 🔴 **真机未验**：本机没有安卓设备 —— 这条链只有静态判据（`nav-checks` 第二十七节）。
   *    真机验收：停在日程页 ⇒ 划掉应用 ⇒ 到课前 10 分钟应收到系统通知。
   */
  useEffect(() => {
    if (schedule.length === 0) return

    /*
     * 🔴🔴 **先问"这个壳有没有原生排程这个能力"**（`scheduleAlarms` 在不在）——
     *   没有能力就**直接退出**：网页版与两个 exe 上**一个字都不新增**（不进 DOM、不弹提示）。
     *
     *   为什么不能"试一下、失败就提示"：`scheduleNativeReminders()` 在没有这条路时
     *   **恒返 `false`** ⇒ 那句「提醒改在应用内显示。关掉应用就收不到了。」会在
     *   **每一个登录后的页面上平白弹一次**。而它对这两种壳本来就是**噪音**：
     *   网页版关掉页面本来就收不到（无需提醒），两个 exe 也从来没有原生排程。
     *
     *   ⇒ 只有**壳里确实有这个能力、但这次没排上 / 被系统拒**，才轮到下面那句人话。
     */
    if (!shellCanScheduleAlarms()) return

    let alive = true
    const arm = async () => {
      /*
       * 🔴 刚从「闹钟和提醒」那页回来 ⇒ 先**量一次**"开成了没有"，再决定排不排。
       *   条条都摆明才动：量到 `false` 说明他还没开 ⇒ **别**重排（重排必失败）、
       *   **别**再跳一次设置（那就是把人来回弹）；量到 `true` / `null` 照旧重排一遍
       *   （这也是这一页原来就有的"回到前台重排"语义，一个字没改）。
       */
      const backFromSettings = returnFromSettings.current
      if (backFromSettings) {
        returnFromSettings.current = false
        const armed = await canScheduleExactNative()
        if (!alive) return
        if (armed === false) {
          push({
            text: '提醒仍只能在应用内显示',
            tone: 'warn',
            desc: '「闹钟与提醒」还没允许给本应用，应用关着时提醒不响。',
          })
          return
        }
        push({ text: '已交给系统提醒', tone: 'ok', desc: '应用关着也会响。' })
      }
      const now = beijingNow()
      const days: Array<{ ymd: string; items: Array<{ id: string; title: string; body: string; minute: number }> }> =
        []
      for (let i = 0; i < NATIVE_PLAN_DAYS; i++) {
        const d = new Date(now.getTime())
        d.setDate(d.getDate() + i)
        const ymd = ymdOf(d)
        // 法定假期不上课 ⇒ 那一天不排闹钟（调休上班日照旧排 —— 那天确实要上课）
        if (dayKind(ymd) === 'holiday') continue
        const wd = weekdayOf(d)
        const items = schedule
          .filter((s) => s.scope !== 'class' && s.notify && s.weekday === wd)
          .map((s) => {
            const moved = snoozes[s.id]
            const minute = moved === undefined ? toMinutes(s.start) - REMIND_BEFORE : moved
            const className = classes.find((c) => c.id === s.classId)?.name
            return {
              id: s.id,
              title: `${REMIND_BEFORE} 分钟后上课`,
              body: [s.title, className, s.room, `${s.start} 开始`].filter(Boolean).join(' · '),
              minute,
            }
          })
        if (items.length) days.push({ ymd, items })
      }

      const ok = await scheduleNativeReminders(nativeReminderPlan(days, now))
      if (!alive) return
      if (!ok) {
        /*
         * 🔴 没排上就**说出来**（§三.5：不可写的路径要显式报错，不许静默）——
         *    这正是"收不到通知而界面上看不出任何异常"的那个形态。
         */
        console.warn('[remind] 系统排程不可用，本次会话的提醒只能靠页内那一条')
        if (!warnedNoNative.current) {
          warnedNoNative.current = true
          /*
           * 🔴🔴 **先量、再指路**（2026-10-05 真机第二轮）：
           *   · `canScheduleExactNative()` = 同步问系统"精确闹钟给了没有"
           *     （没这条路的壳回 `null` = **不知道**，不是"不能"）；
           *   · `openExactAlarmSettings()` = **真的跳到**「闹钟和提醒」那一页
           *     （Android 12+ 的特殊权限页，不是普通通知页 —— 老师自己翻半天翻不到）。
           *   ⚠️ 两个都只在**壳里确实有原生排程能力**时才会走到（上面那句能力门挡着）
           *     ⇒ 网页版与两个 exe **一个字都不变**。
           *   ⚠️ 跳失败也照实说那句话（`try/catch` 在 `openExactAlarmSettings()` 里，
           *     它回 `false` 不抛错）—— 但**文案不依赖**这次跳成功没有：
           *     老师说得出"去系统设置开『闹钟与提醒』"就够了。
           */
          const canExact = await canScheduleExactNative()
          const hint = remindFailHint(canExact, shellCanOpenExactAlarmSettings())
          push({ text: hint.text, tone: 'warn', desc: hint.desc })
          if (canExact === false && shellCanOpenExactAlarmSettings()) {
            // 真的把老师送过去；他改完切回来会看到下面那条"开完就生效"
            await openExactAlarmSettings()
            if (!alive) return
            /*
             * ⚠️ 那条 Toast 只活 2.6 秒 —— 跳到设置页之后它在**后台就过期了**，
             *   老师回来会看不见任何字。⇒ 用 `once` 记一笔，回来的那一下补发一条
             *   （这也是"只给一次可操作的一步"的收口：说过就不再刷屏）。
             */
            returnFromSettings.current = true
          }
        }
      }
    }

    void arm()
    // 回到前台就重排一次：老师可能刚在系统设置里把通知/精确闹钟打开
    const onVisible = () => {
      if (document.visibilityState === 'visible') void arm()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [schedule, classes, snoozes, push])

  // 每天取一次当天那组（跨零点自动换组 —— `ymdOf` 变了 key 就变）
  const dayKey = ymdOf(beijingNow())
  useEffect(() => {
    let alive = true
    void loadSnoozes(dayKey).then((loaded) => {
      if (!alive || Object.keys(loaded).length === 0) return
      // 只在有东西时写回（否则一次网络抖动就把本地的推迟记录清空）
      const cur = useStore.getState().scheduleSnoozes
      const merged = { ...cur, ...loaded }
      if (JSON.stringify(merged) === JSON.stringify(cur)) return
      useStore.setState({ scheduleSnoozes: merged })
    })
    return () => {
      alive = false
    }
  }, [dayKey, setScheduleSnooze])

  useEffect(() => {
    if (schedule.length === 0) return

    const tick = async () => {
      /*
       * ⚠️ 一次 tick 里只取**一个**「现在」。
       *
       * `dueReminders` 内部读的是 Date 的**本地字段**（`getHours` / `getDay`），
       * 所以必须把 `beijingNow()` 传进去 —— 它返回的 Date 的本地字段就是北京时间。
       * 传设备本地时间的话，窗口按设备时区算、去重与节假日按北京时间算，
       * 出了国境（或设备时区不是 +08:00）就会「该提醒的不提醒、不该提醒的乱提醒」。
       *
       * 判定窗口、去重键、节假日三处必须用**同一个**时间点：
       * 取一次 now 全程复用，跨零点那一瞬间也不会一半算今天、一半算明天。
       */
      const now = beijingNow()
      const today = ymdOf(now)

      // 法定假期不上课，别在假期里提醒上课
      // （调休上班日照常提醒 —— 那天确实要上课）
      if (dayKind(today) === 'holiday') return

      // 只提醒教师自己的课；班级课表里别的科目不归他管
      const due = dueRemindersWithSnooze(
        schedule.filter((s) => s.scope !== 'class'),
        snoozes,
        now,
      )
      if (due.length === 0) return

      const seen = loadSeen()
      let changed = false
      for (const item of due) {
        // 同一天同一个日程只提醒一次 —— 这里是**北京时间的"今天"**，和上面同源
        const key = `${today}:${item.id}`
        if (seen[key]) continue
        seen[key] = true
        changed = true

        const className = classes.find((c) => c.id === item.classId)?.name
        const title = `${REMIND_BEFORE} 分钟后上课`
        const body = [item.title, className, item.room, `${item.start} 开始`]
          .filter(Boolean)
          .join(' · ')

        /*
         * 🔴🔴 用 `notifyAsync` 而不是 `notify`（2026-10-04 修）：
         *   旧版用同步的 `notify()`，而它在原生那一支**恒返回 true**
         *   （桥接层如实回的 false 被丢掉了）⇒ `if (!ok)` 从来不成立
         *   ⇒ **系统通知没发出去时，连这条页内提示也没有** ⇒ 到点无声无息。
         *   现在拿到的是**真结果**：发失败就一定补一条页内提示。
         *   ⚠️ 页内那条是**兜底**，不是"多此一举" —— 它正是"失败了会有人知道吗"那一问的答案。
         */
        const ok = await notifyAsync(title, body)
        // 系统通知没发出（未授权 / 非 https / 桥接失败）就退化成页内提示，不能什么都不说
        if (!ok) {
          const perm = await readNotifyPermission()
          push({
            text: `${REMIND_BEFORE} 分钟后：${item.title}`,
            tone: 'warn',
            desc:
              perm === 'granted'
                ? `${item.start} 开始`
                : '系统通知未授权，正在用页内提醒代替',
          })
        }
      }
      if (changed) saveSeen(seen)
    }

    // `tick` 是 async 的（`notifyAsync` / `readNotifyPermission` 要 await）——
    // 这里显式 `void`，免得未处理的 Promise 挂在那儿；定时器那一份同理。
    void tick()
    const t = window.setInterval(() => void tick(), 60_000)
    return () => window.clearInterval(t)
    // 🔴 `snoozes` 在依赖里：推迟/恢复之后**下一分钟的那次 tick** 必须按新时刻判，
    //    漏了它就会出现"我明明点了晚 10 分钟，它还是按课前 10 分钟又响了一遍"。
  }, [schedule, classes, push, snoozes])
}
