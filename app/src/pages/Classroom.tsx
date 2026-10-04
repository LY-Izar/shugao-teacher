import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { PipPanel } from '../components/PipPanel'
import {
  IconAlert,
  IconBellOff,
  IconCheck,
  IconClock,
  IconDownload,
  IconEye,
  IconInfo,
  IconMegaphone,
  IconTarget,
  IconWifi,
} from '../components/icons'
import { Button, Panel, Sect, Sheet, Tag } from '../components/ui'
import { Emblem } from '../components/Emblem'
import { useStore, useToast } from '../data/store'
import { collectStats } from '../lib/assignments'
import { BAND_META, gradeStats } from '../lib/grading'
import { isStreamClass } from '../lib/pick'
import { closePip, onPipClosed, openPip, pipSupported, pushPipScreen } from '../lib/pip'
import { shellAutoplayAllowed, shellPlatform } from '../lib/classroomShell'
import { useMaintenanceStatus } from '../lib/useMaintenance'
import { MaintenanceScreen } from '../components/MaintenanceGate'
import { ranked } from '../lib/wrongbook'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import { isRemote } from '../lib/supabase'
import { setDeviceRole } from '../lib/session'
import * as remote from '../data/remote'
import {
  backupTargetHint,
  fsSupported,
  loadHandle,
  makeBackup,
  pickFolder,
  writableFolder,
  writeToFolder,
} from '../lib/backup'
import { hasBuiltinBackupDir } from '../lib/fileOut'

/** 备份文件名：固定名字，每次覆盖 —— 免得一天攒几十个文件 */
const BACKUP_NAME = '树高备份.json'
import { checkScheduleConflicts, awayText, dayState, maybeShift, toMinutes, weekdayOf } from '../lib/schedule'
import { beijingNow, dayKind, holidayOn, isRestDay, nextHoliday, ymdOf } from '../lib/holiday'
import { pickDailyQuote } from '../lib/quotes'
import { SUBJECTS, subjectCodeOf, subjectName } from '../lib/subjects'
import {
  loadDailyBundle,
  repSetDailyHomework,
  toDutyInput,
  todayDuty,
  type DailyBundle,
} from '../lib/daily'
import { downloadBlob, homeworkImageBlob, homeworkImageName } from '../lib/homeworkImage'
import {
  matchClassName,
  parseScheduleText,
  splitLessonTitle,
  type ParsedScheduleItem,
} from '../lib/scheduleParse'
import { preparePhoto } from '../lib/photo'
import { recognize } from '../lib/ocr'
import { WEEKDAY_TEXT, type ScheduleItem } from '../data/types'
import {
  KIND_TEXT,
  canViewInline,
  fetchBlob,
  humanSize,
  kindOf,
  listFiles,
  type SharedFile,
} from '../lib/files'
import {
  allFiles,
  clearFiles,
  openLocal,
  putFile,
  saveToDisk,
  type LocalFile,
} from '../lib/localStore'
import {
  chime,
  isSilenced,
  quietNow,
  setExamMuted,
  softChime,
  speak,
  speechBudgetMs,
  stopSpeaking,
  unlockAudio,
} from '../lib/tts'
import { friendlyDate, isoOffset } from '../lib/date'
import type { CallRecord, DailyHomework } from '../data/types'

const CLASS_KEY = 'shugao.classroom.classId'

/**
 * 教室端读「每日作业 / 值日生」的日期窗口（相对今天的天数）：往前两周 + 明天。
 * 往前两周是因为这块屏也会翻前几天的作业；往后一天是为了"提前录了也看得见"。
 */
const DAILY_FROM = -14
const DAILY_TO = 1

/* ---------------- 播报队列的几个常数 ---------------- */

/** 队列上限。一节课正常也就三五条，这只是防止队列无限涨的阀门；满了就先不收（见 play） */
const MAX_QUEUE = 12
/**
 * 呼叫浮层的**最短展示时长**。
 *
 * 为什么必须有它：出队时机原本完全交给 TTS 的 onend（"念完才算播完"，见下面
 * 播报 effect 的注释）。这在语音正常时是对的，但一旦这台机器的语音合成不可用，
 * `tts.ts` 里的 `u.onerror = () => done()` 会**立刻**触发 —— 队列马上跳下一条，
 * 浮层闪一下就没了，教师根本来不及看。实机上就撞到过：23 点报修
 * 「呼叫信息过了一秒就被顶掉了，并且信息还没显示完」。
 *
 * 所以展示时长要取「念完」和「够读完」两者中**更长**的那个：
 * 语音快慢只影响朗读，不该决定人有没有时间看。
 */
const BUBBLE_MIN_MS = 3_500
/** 每个字至少留多少毫秒给人看（默读中文约 5～8 字/秒，取 180ms/字＝5.5 字/秒，宁可慢一点） */
const BUBBLE_MS_PER_CHAR = 180

/*
 * 「[班名] 科目 [任课老师]」怎么拆成科目与老师 —— 拆法**只有一处**：
 * `lib/scheduleParse.ts` 的 `splitLessonTitle`（课程管理页认科目、认姓名也用它）。
 * 2026-10-01 之前这里是本地的一份 `LEADING_CLASS_RE` + `splitTitle`，与课程管理页那份
 * 各写一遍，于是同一节课在教室端叫「英语」、在整周网格里叫整串标题 —— 合到一处。
 */

/**
 * **临时层**在这一天、这个班上的那一格（键 = 开始时间）。
 *
 * 🔴 2026-10-01 从"一个科目串"改成一个对象：一格被临时调过有**三种**情况，
 *    只拿一个科目串分不出来，屏上就出错：
 *      · 换成别的课（换科目/换老师）→ 显示新的那一门；
 *      · **腾空**（`to_subject` 是空串）→ 这一节今天**没有课**，那一格要从今天的清单里**去掉**。
 *        旧写法把空串盖上去，标题拼出来只剩班名 —— 屏上就成了"一节没有科目的课"
 *        （用户 2026-10-01 在教室里看到的那一幕）。
 *      · 挪到**本来没课**的那一节 → 今天**多出来一节课**，周课表里没有这一行，要自己摆一行。
 *        （旧写法这种课在教室里**一条都不显示** —— 同一个洞的另一半。）
 *    `teacherId` / `end` 是给"多出来的那一行"用的：`end` 周课表里没有，只能从临时层拿
 *    （数据库 `schedule_day_cells` 回的就是 `coalesce(b.end_time, o.end_time)`）。
 */
type TempDayCell = { subject: string; teacherId: string | null; end: string }
/** 播放记录只留最近这一段（轮询窗口是 15 分钟，比它长就够），不然开一整天会一直涨 */
const SEEN_TTL_MS = 20 * 60_000
/** 「叮咚」响完到开口的间隔 */
const SPEAK_AFTER_CHIME_MS = 680
/** 两次「关闭」之间的最短间隔：双击会连出队两条，被切那条就永远不会响了 */
const CLOSE_GUARD_MS = 1200
/** 同一条备份故障的提示间隔 —— 自动备份的 tick 是 5 分钟一次，不节流会一直刷屏 */
const BK_ISSUE_REPEAT_MS = 10 * 60_000

/** 同一个 call 重复播报时 sentAt 会追加，所以用「id + 最后一次时间」当键 */
const lastAt = (c: CallRecord) => Math.max(0, ...(c.sentAt ?? []))
const callKey = (c: CallRecord) => `${c.id}:${lastAt(c)}`

/**
 * 大时钟（T4 2026-10-02）：整间教室**唯一**需要秒级粒度的地方就是它。
 * 自己带 1 秒的 useState + interval、`memo` —— 秒针跳动只重渲染这一个 <Panel>，
 * 不再把整棵子树每秒拖着重算（顶层 now 降到分钟级，见主组件里的时钟 effect）。
 */
const ClockBig = memo(function ClockBig({
  klassName,
  duty,
}: {
  klassName: string
  /**
   * 今天的值日生（由 `lib/duty.ts` 推出来，见主组件里那一段）。
   *
   * 🆕 2026-10-02 用户口径：**下课**要提醒值日生擦黑板（不是放学）。
   * 这里只做"小字一行"，`null` 时**整个不摆** ——
   * 这块屏挂在教室墙上，多一块面板就会挤掉别的（用户要求"别破坏原有布局"）。
   */
  duty?: string | null
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    <Panel className="anim-in overflow-hidden">
      <div className="p-5 text-center">
        <div className="num" style={{ fontSize: 62, fontWeight: 650, letterSpacing: '-.05em', lineHeight: 1 }}>
          {pad(now.getHours())}:{pad(now.getMinutes())}
          <span style={{ fontSize: 24, color: 'var(--color-ink4)', marginLeft: 4 }}>{pad(now.getSeconds())}</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 8 }}>
          {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周
          {'日一二三四五六'[now.getDay()]} · {klassName}
        </div>
        {/* 🆕 今天值日生：紧贴在日期行下面的一行 13px 小字（不新增区域、不动排版） */}
        {duty ? (
          <div
            data-classroom-duty
            style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 5 }}
          >
            今天值日生 ·{' '}
            <b style={{ fontWeight: 620, color: 'var(--color-ink)' }}>{duty}</b>
          </div>
        ) : null}
      </div>
    </Panel>
  )
})

export default function Classroom() {
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const classrooms = useStore((s) => s.classrooms)
  const setClassroomOnline = useStore((s) => s.setClassroomOnline)
  const ensureClassroom = useStore((s) => s.ensureClassroom)
  const hydrated = useStore((s) => s.hydrated)
  const teacher = useStore((s) => s.teacher)
  const navigate = useNavigate()

  /*
   * 🔴🔴 **教室端恒亮 —— 这条是硬规矩，不是偏好**（2026-10-09 F4，用户拍板）。
   *
   * 这块屏挂在**亮着灯的教室**里给学生看。暗色在那儿是错的：晚上灯一开、屏幕一暗，
   * 三米外的学生先看不清的是**字**，而这块屏存在的全部意义就是"看得清"。
   *
   * 所以这里做的是**摘掉** `<html data-theme="dark">`，而不是"跟着偏好走"：
   *   · `lib/theme.ts` 的 `effective()` 一命中 `/classroom` 就恒返回 `'light'`（不读偏好）；
   *   · `index.html` 里那段内联脚本在首帧之前也是同一条判断（所以**不会**先暗一下再变亮）；
   *   · 这一句是**第三道**：这条路由被**直接打开**（书签 / 二维码 / SPA 内部跳转）时，
   *     前面两道都可能已经被别处写上的属性越过 —— 这里在**挂载时无条件清一次**。
   *
   * ⚠️ 为什么不用 `apply()`：`apply()` 会顺手改 `<meta name="theme-color">`，
   *    而那一条是"教师端顶栏的颜色"；教室端有自己的显示方式，不该动它。
   * ⛔ 别在这里加"如果系统是暗色就跟着暗"的分支 —— 那正是这条硬规矩要挡掉的东西。
   *    `shots.mjs` 的 F4 那一节有一条断言专门钉它（含反向对照：让它跟着暗必须红）。
   */
  useEffect(() => {
    document.documentElement.removeAttribute('data-theme')
  }, [])

  const [classId, setClassId] = useState(() => {
    try {
      return localStorage.getItem(CLASS_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const klass = classes.find((c) => c.id === classId) ?? classes[0]
  const client = classrooms.find((c) => c.classId === klass?.id)

  /*
   * 🆕 P9：走班班的屏**还要能看考试**（Q17：「只看作业和考试」）。
   * ⚠️ `exams` **不在 `loadSnapshot()` 里**（与通知同一条纪律：读不到它不该让整块屏打不开），
   *    所以这里显式 `hydrateExams()` —— 它自己带探测（老库上回 `missing`，页面照常显示作业）。
   * 🔴 **读得到、写不了一点**：`exams` / `exam_scores` 上教室端一条写策略都没有（§15.3）。
   * ⚠️ 这两个 hook 必须在**所有 early return 之前**（`rules-of-hooks`：hook 的调用顺序每次都一样），
   *    而 `klass` 又要先算出来 —— 所以位置正好夹在两者之间。
   */
  const exams = useStore((s) => s.exams)
  const hydrateExams = useStore((s) => s.hydrateExams)
  useEffect(() => {
    void hydrateExams()
  }, [hydrateExams])
  const classExams = useMemo(
    () =>
      exams
        .filter((e) => (e.classIds ?? []).includes(klass?.id ?? ''))
        .sort((a, b) => (a.examDate < b.examDate ? 1 : -1))
        .slice(0, 6),
    [exams, klass?.id],
  )

  /**
   * 教室端能看的「已批改作业」—— 判据**必须**用 `lib/wrongbook.ts` 的 `ranked`，
   * 不能在这里手写 `status === 'graded'`。
   *
   * 为什么（§11.5「判据只有一处」）：`ranked` 还要求 `statsMode !== 'simple'`，
   * 而极简模式的档案**没有任何逐题数据**（`wrong` 恒为空）。自己写一遍状态判断的话，
   * 极简档案会混进这个列表，下面那块「逐题正确率」会把它渲染成
   * **全班全对 + 错误率 0%** —— 看起来很正常，其实是错的（W16 的教室端那一半）。
   */
  const graded = useMemo(
    () =>
      assignments
        .filter((a) => a.classId === klass?.id && ranked(a))
        .sort((x, y) => (x.assignDate < y.assignDate ? 1 : -1)),
    [assignments, klass?.id],
  )

  const [assignmentId, setAssignmentId] = useState('')
  const assignment = graded.find((a) => a.id === assignmentId) ?? graded[0]

  const students = useMemo(
    () => (klass?.students ?? []).filter((s) => s.status === 'active'),
    [klass],
  )
  const stats = useMemo(
    () => (assignment ? gradeStats(students, assignment) : null),
    [assignment, students],
  )
  const collect = useMemo(
    () => (assignment ? collectStats(klass?.students ?? [], assignment) : null),
    [assignment, klass],
  )

  const [seq, setSeq] = useState(1)
  const [pipWin, setPipWin] = useState<Window | null>(null)
  /**
   * 🆕 小窗走的是**壳原生**那条路（教室端 exe）—— 2026-10-04，施工单 `教室端原生置顶小窗`。
   *
   * 🔴 为什么不能只用一个 `pipWin`：壳那个窗口是**主进程**建的，网页侧**没有** `Window`
   *    对象可以拿（拿不到它的 `document`、也没法 `addEventListener`）
   *    —— 把 `null` 塞进 `pipWin` 就分不清"没开小窗"和"开着壳原生小窗"。
   * ⚠️ 它只表示"有没有开着"，**内容是网页推过去的**（`pushPipScreen`）。
   */
  const [pipNative, setPipNative] = useState(false)
  /** 两种小窗的**统一问法**：屏上那颗按钮、那几处标记都判它，别各写一套 */
  const pipOn = pipWin !== null || pipNative
  /**
   * 播报队列 —— 多科老师可能几乎同时叫，**排队依次播，不能互相顶掉**。
   * 当前正在播的就是队首那条。
   */
  const [queue, setQueueState] = useState<CallRecord[]>([])
  /**
   * 队列的唯一写入口，state 和 ref 一起改。
   *
   * 为什么还要一份 ref：入队发生在**推送 / 轮询的回调**里，不在渲染期，
   * 那时候闭包里的 state 是上一次渲染的旧值 —— 判断"队列满没满"会判错。
   * 返回同一个数组表示"没变化"，不会触发重渲染。
   */
  const queueRef = useRef<CallRecord[]>([])
  const mutateQueue = useCallback((fn: (q: CallRecord[]) => CallRecord[]) => {
    const next = fn(queueRef.current)
    if (next === queueRef.current) return
    queueRef.current = next
    setQueueState(next)
  }, [])
  const broadcast = queue[0] ?? null
  const [now, setNow] = useState(() => new Date())
  /**
   * 「声音已经能用了吗」。
   *
   * 🔴 初值不是 `false`（2026-10-04 改）：**壳里不需要那一步** ——
   *    两个 exe 的 `webPreferences` 写了 `autoplayPolicy: 'no-user-gesture-required'`
   *    （`preload.js` 同步暴露 `autoplayAllowed`），所以教室里那台机器**不该**再看到
   *    「先解锁声音」那个提示。用户原话：「不支持置顶小窗，为什么还要点一下解锁声音」。
   * ⚠️ 网页版读不到那个字段 ⇒ `false` ⇒ **照旧显示那一步**，一字不变。
   */
  const [armed, setArmed] = useState(() => shellAutoplayAllowed())
  const push = useToast((s) => s.push)
  const rootRef = useRef<HTMLDivElement>(null)

  /* 记住选的是哪个班 */
  useEffect(() => {
    if (!klass) return
    try {
      localStorage.setItem(CLASS_KEY, klass.id)
    } catch {
      /* 忽略 */
    }
  }, [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 时钟（T4 2026-10-02）：顶层 now 只到**分钟**粒度 —— 秒针的跳动归 <ClockBig> 自己。
     这个 1 秒的 interval 只负责探测"分钟变了没有"，没变就不 setNow：
     否则 merged / dayState / closing / 静音判定这些下游每秒全部重算一遍。 */
  useEffect(() => {
    const t = window.setInterval(() => {
      const d = new Date()
      setNow((v) => (v.getHours() === d.getHours() && v.getMinutes() === d.getMinutes() ? v : d))
    }, 1000)
    return () => window.clearInterval(t)
  }, [])

  /* 教室端自我登记：后端模式没有种子数据，第一次打开时要把这台设备建出来 */
  useEffect(() => {
    if (!klass) return
    ensureClassroom(klass.id, '一体机')
  }, [klass?.id, ensureClassroom]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 教师传来的文件：教室端**只读**（零写权限，§17.6），拉到本机就存下来自己用 */
  const [cloudFiles, setCloudFiles] = useState<SharedFile[]>([])
  const [localFiles, setLocalFiles] = useState<LocalFile[]>([])
  const [pulling, setPulling] = useState('')
  /**
   * 读文件列表失败的原因。
   * 🔴 **不能吞**（这里原来是 `catch { return }`）：屏上挂着"还没有文件"，
   *    值班老师会以为"没人传"而不是"这台机器读不到" —— §9 那一整类"空态不报错也不说明"的坑。
   */
  const [filesErr, setFilesErr] = useState('')

  const refreshLocal = useCallback(async () => {
    try {
      setLocalFiles(await allFiles())
    } catch {
      /* 本机库不可用时不影响上课 */
    }
  }, [])

  useEffect(() => {
    if (!isRemote) return
    /*
     * ⚠️ 走班班的屏不摆「老师传来的文件」那一块（Q17：只看作业与考试），
     *    所以连取回也停掉 —— 它会把每一份文件的字节都拉到这台机器上。
     * 🔴 **这不是权限**：读那一半一个字没改（"读得宽"），只是这块屏不用它。
     */
    if (isStreamClass(klass)) return
    let alive = true

    const pull = async () => {
      let pending: SharedFile[] = []
      try {
        /*
         * 🔴 这里**不再**按班级过滤（原来是 `.filter((f) => !f.classId || f.classId === klass?.id)`）：
         *    能读到哪些行由数据库的读策略说了算 —— `shared_files_class_read`（schema.sql §19.3）
         *    把"本班的文件"给到这块屏。前端再筛一遍就是"同一件事两个判定入口"（§11.3）：
         *    多选共用的文件会被筛掉，策略改口径时这里也跟着错。
         */
        pending = await listFiles()
        if (alive) setFilesErr('')
      } catch (e) {
        if (alive) setFilesErr(e instanceof Error ? e.message : String(e))
        return
      }
      if (!alive) return

      const have = new Set((await allFiles()).map((f) => f.id))
      // 「待取回」= 还没落到这台电脑上的那些（已经取回来的在下面本机列表里，不重复显示）
      setCloudFiles(pending.filter((f) => !have.has(f.id)))

      for (const f of pending) {
        if (have.has(f.id) || !alive) continue
        setPulling(f.name)
        const blob = await fetchBlob(f.storagePath)
        if (!alive) return
        if (blob) {
          await putFile({
            id: f.id,
            name: f.name,
            mime: f.mime,
            size: f.size,
            blob,
            savedAt: Date.now(),
          })
          /*
           * ⚠️ 这里**故意不再**调 `deleteFile(f)`（原来那句是"落到本机就把云端那份删掉"）：
           *    教室端是**零写权限**（schema.sql §17.6，用户拍板）—— 这一行不是它传的，
           *    DELETE 会被策略静默筛成 0 行（连报错都没有），所以那句话**从来没有生效过**。
           *    而多班共用的文件（同一个课件发给几个班）也**必须**留着云端那份：
           *    第一个班取走就删，别的班就再也取不到了 —— 那正是"几个班都能看"的反面。
           *    清理入口只有一个：教师端「教室端文件」里的删除按钮。
           */
        }
        setPulling('')
      }
      if (alive) await refreshLocal()
    }

    void pull()
    const t = window.setInterval(() => void pull(), 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [klass?.id, refreshLocal]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 今天的课表 —— 教师端维护，这里只读；也支持现场拍一张课表自动识别 */
  const schedule = useStore((s) => s.schedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const removeSchedule = useStore((s) => s.removeSchedule)
  const schedRef = useRef<HTMLInputElement>(null)
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedErr, setSchedErr] = useState('')
  /** 照片识别结果，等教师核对/改完时间再入库 */
  const [schedReview, setSchedReview] = useState<ParsedScheduleItem[] | null>(null)
  /** 粘贴课表 —— 学校发的电子表直接贴进来，比拍照准得多（也不会漏掉没写时间的节次） */
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  /**
   * 「按日期选作业」的展开面板。
   * 以前是平铺一排小日期按钮（最多 10 个）—— 挂墙上那块屏是**手指点的**，
   * 一排又小又密的按钮点不准；改成先显示当前日期，点一下才展开列表。
   */
  const [datePickOpen, setDatePickOpen] = useState(false)

  /* ---- 自动备份到本机文件夹（C4）----
     云端之外的第二份保险。注意浏览器**不允许静默写文件夹**：
     首次授权时勾「允许每次访问时编辑」后，同一会话内可全自动；
     浏览器重启后权限退回 prompt，必须由用户点一下 —— 所以状态要显示出来。 */
  const bkSupported = fsSupported()
  const [bk, setBk] = useState<number | null>(null)
  const [bkBusy, setBkBusy] = useState(false)
  const [needsGrant, setNeedsGrant] = useState(false)
  /* 🔴 内置备份文件夹的**真绝对路径**（壳里才有；网页/apk 恒为 null）
     —— 施工单 §1.3：老师/管理员要照着它去 U 盘拷走，所以必须显示出来、且是真路径 */
  const [bkDir, setBkDir] = useState<string | null>(null)

  /**
   * 备份出问题必须**弹出来**，不能只在面板里留一行小字。
   * 这块屏挂在墙上没人盯着：自动备份悄没声地失败，等于没有备份 ——
   * 真要用它的那天（数据丢了）才发现，就晚了。
   * 同一条原因 10 分钟只弹一次（这个 tick 自己 5 分钟跑一次，不节流会一直刷屏），
   * 写文件的失败由 `backup.ts` 的 `writeToFolder` 用同一套口径提示，这里只补它管不到的两条分支。
   */
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
    /*
     * 🔴🔴 **exe 自带备份文件夹：这一整套「授权文件夹」的流程都要跳过**（施工单 §1）。
     *
     * 改之前这个定时器第一件事是 `loadHandle()`，**没有句柄就直接 return** ——
     * 而 exe 里**根本不存在"教师授权过的文件夹"**（`showDirectoryPicker`
     * 必须有人点一次，教室里那台大屏经常没有键鼠）⇒ 每 5 分钟报一次
     * 「还没有选备份文件夹」，然后 `writeToFolder` **一次都走不到**：
     * **一直在写、其实一份都没写**，而屏上看着「自动备份开着呢」。
     *
     * → 壳里直接写内置目录（不需要任何人授权），网页/apk 走原来那条一字不改。
     */
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
      // 这里**只查询、不申请** —— requestPermission 必须由用户手势触发
      const dir = await loadHandle()
      if (!alive) return
      if (!dir) {
        // 一次都没设过文件夹：以前这里直接 return，屏上一个字都没有
        reportBkIssue('还没有选备份文件夹（在教室端「自动备份到本机」里点「设置文件夹」）')
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
    const t = window.setInterval(() => void tick(), 5 * 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [bkSupported, reportBkIssue])

  /** 改一行（时间最容易认错，所以每一格都能直接编辑） */
  const patchRow = (i: number, patch: Partial<ParsedScheduleItem>) =>
    setSchedReview((rows) => (rows ? rows.map((r, k) => (k === i ? { ...r, ...patch } : r)) : rows))
  /**
   * 调休那天各校安排不一样（有的按周五上、有的按周一上），
   * 所以给教师一个当天可切换的口子 —— **只影响显示，不改课表数据**。
   */
  const [weekOverride, setWeekOverride] = useState<number | null>(null)
  const isMakeup = dayKind(ymdOf(now)) === 'makeup'
  const useWeekday = isMakeup && weekOverride !== null ? weekOverride : weekdayOf(now)

  const todayIso = ymdOf(now)

  /*
   * 课表重排只认"今天是星期几"这一个数（T4 的口径：分钟级的变化不该惊动重排）。
   * 单独取出来：那个 `useMemo` 的依赖里既不能放 `now`（身份每次都变），
   * 也不能放没被用到的日期串。
   */
  const nowWeekday = weekdayOf(now)

  /*
   * 🆕 2026-10-13「课程管理」第 4 轮 · **教室端认"今天有临时调整"**（`schema.sql` §38.6）。
   *
   * 🔴 数据源是**数据库那一份** `schedule_day_cells(p_date)`：它把"读时按日期过滤"做在里面了
   *    （临时调课只在 `on_date = 这一天` 时压上来）—— 所以**过了那天自动恢复**不需要教室端
   *    做任何事：换一天再读就是原来的周课表，`schedule_items` 一个字都没被写过。
   * 🔴 **这一层只覆盖本班**：下面 `c.classId === klass.id` 那一句就是「教室端只看本班」那条
   *    硬边界（`scope='class'` 的口径**一个字没放宽**）。
   * ⚠️ 本地演示模式没有数据库（`loadScheduleDay` 回 `local`）→ 用内存里那一层
   *    `tempScheduleChanges` 顶上，两边**同一份语义**（与 `CourseAdmin.tsx` 同款做法）。
   * ⚠️ 读不到（`missing` / `unknown`）**保持原课表**、不做任何标记：
   *    "不知道有没有调整"不等于"没有调整"，也**不许**让这块屏空掉（§三.4 的三态纪律）。
   */
  const localTempChanges = useStore((s) => s.tempScheduleChanges)
  const [dbTempCells, setDbTempCells] = useState<Record<string, TempDayCell>>({})
  /* 标题的写法要班名（照平台约定「班名 科目」）—— 单独取一份，免得把整个 `klass` 挂进依赖 */
  const klassName = klass?.name ?? ''

  useEffect(() => {
    if (!isRemote || !klass?.id) return
    let alive = true
    const load = () => {
      void remote.loadScheduleDay(todayIso).then((r) => {
        if (!alive || r.status !== 'present') return
        const m: Record<string, TempDayCell> = {}
        /* ⚠️ 同一条纪律：`r.cells` 是**服务端回来的东西**，这里也不假设它一定是数组 */
        for (const c of r.cells ?? []) {
          /* 🔴 只要**本班**那几格（教室端那条边界），且只要被临时调过的那几格 */
          if (c.changed && c.classId === klass.id) {
            m[c.start] = { subject: c.subject, teacherId: c.teacherId, end: c.end }
          }
        }
        setDbTempCells(m)
      })
    }
    load()
    /* 教务处那边改完，这块屏最多一分钟自己跟上（不要求有人来点刷新） */
    const t = window.setInterval(load, 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [klass?.id, todayIso])

  /** 这一天、这个班被临时调过的格：键 = **开始时间**（临时调课锚在"这一天这一节"上） */
  const tempOfDay = useMemo(() => {
    if (isRemote) return dbTempCells
    const m: Record<string, TempDayCell> = {}
    /*
     * 🔴 `?? []` 是**入口这一侧的兜底**，不是判据：`store.ts` 那 6 处赋
     *    `tempScheduleChanges` 的地方给的都是数组（见那一处核查记录），类型上也是 `TempScheduleChange[]`。
     *    但"教室里那块屏"是**出不得错的**那一块（它一崩，整页连左栏一起白）——
     *    多一个 `?? []` 的代价是零，而漏掉它的代价是一整屏。
     */
    for (const c of localTempChanges ?? []) {
      if (c.date === todayIso && c.classId === klass?.id) {
        m[c.start] = { subject: c.toSubject, teacherId: c.toTeacherId ?? null, end: c.end }
      }
    }
    return m
  }, [dbTempCells, localTempChanges, todayIso, klass?.id])

  const dayItems = useMemo(() => {
    const raw = schedule.filter(
      (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === useWeekday,
    )
    /*
     * 🔴 今天有临时调整 → 那一格照临时层来（三种情况见 `TempDayCell` 的注释）。
     *    ⚠️ `used` 这一套判据与 `CourseAdmin.tsx` 的 `buildDayCells` **同一口径**：
     *       一条临时调课只管它锚住的**那一节的第一行** —— 同一时段排了两节课（撞课）时，
     *       第二条照旧显示它自己的课，不然"改一节课"会把撞在一起的两节都抹掉。
     *    标题按平台约定拼「班名 科目」—— 与 `CourseAdmin` 写进周课表的那一种写法同一口径
     *    （教室端「正在上课」卡就是靠 `splitLessonTitle` 从这一串里拆出科目与老师）。
     */
    const used = new Set<string>()
    const merged: ScheduleItem[] = []
    for (const it of raw) {
      const t = tempOfDay[it.start]
      if (!t || used.has(it.start)) {
        merged.push(it)
        continue
      }
      used.add(it.start)
      /* 腾空 = 这一节今天**没有课** → 这一行不进今天的清单（照课程管理页的口径） */
      if (!t.subject) continue
      merged.push({ ...it, title: `${klassName} ${t.subject}`.trim(), teacherId: t.teacherId ?? undefined })
    }
    /*
     * 🔴 挪到**本来没课**的那一节：临时层里有、周课表里没有这一行 → 今天得**自己摆一行**。
     *    这一支在 2026-10-01 之前不存在：教务处把一节语文挪到下午那个空档，教室里那节课
     *    **一条都不显示**（学生看不到、铃也不响）—— 与"腾空显示成空科目"是同一个洞的两半。
     *    ⚠️ 周课表里本来就有这一节的情况不用再判：上面那个循环已经把它收进 `used` 了。
     */
    for (const [start, t] of Object.entries(tempOfDay)) {
      if (!t.subject || used.has(start)) continue
      merged.push({
        id: `temp-${start}`,
        weekday: useWeekday,
        start,
        end: t.end,
        title: `${klassName} ${t.subject}`.trim(),
        kind: 'class',
        notify: false,
        scope: 'class',
        classId: klass?.id,
        teacherId: t.teacherId ?? undefined,
      })
    }
    /* 多出来的那一行要摆回时间顺序里（`maybeShift` 自己也排，但那是在周一才生效） */
    merged.sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
    // 朝会只在真正的周一早上，所以顺延看的是「今天是不是周一」，
    // 而不是「借用了哪一天的课表」—— 调休借周一的课不代表今天要顺延。
    return maybeShift(merged, nowWeekday)
    /* T4：依赖是天级的「今天星期几」（`nowWeekday`）—— 这里只按星期几重排，
       午夜翻天才需要重算；分钟级 now 的身份变化不该惊动它。 */
  }, [schedule, klass?.id, klassName, useWeekday, nowWeekday, tempOfDay])

  /** 今天哪几节是**被临时调过的**（屏上给一个小标记；`id` 在顺延之后不变） */
  const adjustedIds = useMemo(() => {
    const ids = new Set<string>()
    const rows = schedule.filter(
      (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === useWeekday,
    )
    /* 判据与 `dayItems` 同一套（`used` = "这一节的临时调课已经认领过了"），别各写一遍 */
    const used = new Set<string>()
    for (const it of rows) {
      const t = tempOfDay[it.start]
      if (!t || used.has(it.start)) continue
      used.add(it.start)
      /* 腾空那一节今天不显示，也就没有"已调整"可挂 */
      if (t.subject) ids.add(it.id)
    }
    /* 挪到空格那一节是临时层自己摆出来的行（`id` 见 `dayItems`），它也要挂「已调整」 */
    for (const [start, t] of Object.entries(tempOfDay)) {
      if (t.subject && !used.has(start)) ids.add(`temp-${start}`)
    }
    return ids
  }, [schedule, klass?.id, useWeekday, tempOfDay])

  // 传入 useWeekday：调休日教师手选的那天，不能被设备真实星期再筛一次
  /* T4：dayState 保留**分钟级**重算 —— current/next/minutesToNext 在整分翻转
     （schedule.ts:62 实测它读 nowMinutes(d)，按天重算会把「下一节」倒计时冻住；
     施工单说它"按天就够"不成立）。顶层 now 已降到分钟级，这里每分钟一次。 */
  const day = useMemo(() => dayState(dayItems.items, now, useWeekday), [dayItems.items, now, useWeekday])

  /**
   * 今天是不是**放假**（法定假期 / 周末）。
   *
   * 🔴 为什么必须单独判一次：放假那天 `useWeekday` 仍然是真实的星期四，
   * 所以 `dayItems` 照样会筛出周四的课 —— 屏幕会在中秋节显示"第 4 节 物理"。
   * 用户的原话：「节假日也要加进去，我可不想在节假日上课」。
   *
   * 注意和**调休上班日**的区别：那天 `dayKind === 'makeup'`，不是放假日，
   * 课要照上（还可能按教师手选的星期上）—— 只有 `isRestDay` 才拦。
   * 下课铃那边早就有这道判断了（见下面 tick 里的 isRestDay），这里是补上显示。
   */
  const restDay = isRestDay(todayIso)
  const restName = restDay ? (holidayOn(todayIso)?.name ?? '') : ''
  const nowMin = now.getHours() * 60 + now.getMinutes()

  const scanSchedule = async (f: File) => {
    setSchedErr('')
    setSchedBusy(true)
    try {
      const img = await preparePhoto(f, { enhance: true, maxSide: 1800 })
      const out = await recognize(img.dataUrl, { scene: 'schedule', className: klass?.name })
      if (out.status !== 'ok') {
        setSchedErr(out.message)
        return
      }
      if (!out.lines?.length) {
        // 别让老师跑去教师端的「日程表」录 —— 那是另一套数据（scope='mine'），
        // 教室端只读 scope='class'。这里给的出路是**本页的粘贴入口**。
        setSchedErr('没从这张图里认出课表。拍正一点、光线均匀些再试，或用本页的「粘贴课表」把电子表贴进来。')
        return
      }
      const parsed = parseScheduleText(out.lines.join('\n'), classes)
      if (!parsed.items.length) {
        setSchedErr('识别到的内容没解析成课程。可以换一张更清楚的课表图。')
        return
      }
      // 不直接入库 —— 照片识别的时间最容易出错，必须让教师过一眼再存
      setSchedReview(parsed.items)
      push({ text: `认出 ${parsed.items.length} 条课，请核对时间`, tone: 'ok' })
    } catch (e) {
      setSchedErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSchedBusy(false)
    }
  }

  /* 考试模式：全屏黑底时钟，所有声音停掉 */
  const [exam, setExam] = useState(false)
  useEffect(() => {
    setExamMuted(exam)
    return () => setExamMuted(false)
  }, [exam])

  /**
   * 现在是不是"不该出声"的时候：考试模式，或落在固定静音时段（周三下午）。
   * 播报队列据此**暂停**（不是清空）—— 见下面的 play effect。
   */
  const silenced = exam || quietNow(now).quiet

  /**
   * 下课铃：下一节课**开始前 5 分钟**响一声很轻的「叮」。
   * 用 rungRef 记住已经响过的 `日期-课id`，避免在同一分钟内重复响。
   *
   * 两个"按钟点"的坑：
   *  ① 放假的日子（法定假期 + 周末）本来就没课，不能照课表响 —— 之前不看 dayKind，
   *     中秋、寒暑假的早上照样"叮"一声；
   *  ② 调休上班日教师手选的「今天按周X的课表上」也要算数，否则屏幕上显示的是周三的课，
   *     铃却按真实的周日课表（空表）不响 —— 和 dayItems 必须是同一个星期。
   *     maybeShift 仍然看**真实的今天是不是周一**（借周一的课不代表今天要顺延）。
   *
   * 🔴 2026-10-01：这一支**改吃 `dayItems.items`**，不再自己从 `schedule` 筛一遍。
   *    原来那一份筛法**不看临时层** ⇒ 两个洞都在教室里响得出来：教务处把一个班那一节
   *    **腾空**了，屏上已经不显示那节课了，铃却照旧提前 5 分钟"叮"（学生白跑）；
   *    反过来把一节语文**挪到下午的空档**，屏上有那节课，铃却**不响**。
   *    "屏上显示的那份课表"与"响铃的那份课表"必须是同一份 —— 一份数据一处算。
   */
  const rungRef = useRef('')
  useEffect(() => {
    const tick = () => {
      const n = new Date()
      if (isRestDay(ymdOf(n))) return
      const m = n.getHours() * 60 + n.getMinutes()
      for (const it of dayItems.items) {
        if (toMinutes(it.start) - m !== 5) continue
        const key = `${ymdOf(n)}-${it.id}`
        if (rungRef.current === key) continue
        rungRef.current = key
        softChime()
      }
    }
    tick()
    const t = window.setInterval(tick, 20_000)
    return () => window.clearInterval(t)
  }, [dayItems.items])

  /**
   * 19:20 之后当天收尾：统计区换成一句收束。
   * 0:00 起 now.getHours() 归零 → closing 变回 null → 自动恢复显示作业，
   * 不需要额外的定时器去"刷新状态"。
   */
  const closing = useMemo(() => {
    const h = now.getHours()
    const m = now.getMinutes()
    if (h < 19 || (h === 19 && m < 20)) return null
    const today = ymdOf(now)
    const nh = nextHoliday(today)
    // 只在**最近 7 天内**有假期时才提假期，否则一律说周末
    if (nh && nh.daysLeft <= 7) {
      return `恭喜，今日的课业已全部完成，距离${nh.span.name}还有${nh.daysLeft}天`
    }
    const wd = now.getDay() // 0=周日
    const days = wd === 0 ? 0 : 6 - (wd - 1) // 周一=6 … 周五=1
    return days <= 0
      ? '恭喜，今日的课业已全部完成，周末愉快'
      : `恭喜，今日的课业已全部完成，距离周末还有${days}天`
  }, [now])

  /* 心跳：教师端据此显示「在线 / 离线」 */
  useEffect(() => {
    if (!client) return
    const beat = () => {
      if (isRemote) {
        // 后端模式：心跳就是更新 classrooms.last_seen_at，教师端靠 Realtime 收到
        setClassroomOnline(client.id, true)
      } else {
        // 本地模式：两个标签页各有各的 store，必须靠广播
        emit({ type: 'heartbeat', classroomId: client.id, at: Date.now() })
        if (!client.online) setClassroomOnline(client.id, true)
      }
    }
    beat()
    const t = window.setInterval(beat, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [client?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 接收呼叫 —— **只接本班的**，别的班的一声不响地丢掉（那是别的教室的事）
     ------------------------------------------------------------------
     两条路一起走：
       ① Realtime 推送 —— 快，但 websocket 会悄悄断（心跳是另一条 REST 连接，照常活着）
       ② 每 8 秒轮询一次 —— 兜底。上面那条断了也不会漏掉呼叫。 */
  /**
   * 已经收下的呼叫：callKey → 记下的时刻。
   * 用 Map 而不是 Set，是为了能清掉过期的键 —— 这块屏一开一整天，只增不减会一直涨。
   */
  const playedRef = useRef<Map<string, number>>(new Map())
  const seededRef = useRef(false)

  useEffect(() => {
    if (!klass) return
    /*
     * 🔴 Q17：**走班班的屏不接呼叫**（呼叫一律落到该学生**行政班**那块屏上）。
     *    数据库那一层已经保证了这一点（`calls.class_id` 只能是行政班，`schema.sql` §33.2），
     *    所以这里连轮询都不开 —— 开着它只会每 8 秒空跑一次，而且会让人以为
     *    "这块屏本来该收到呼叫，只是还没来"。
     */
    if (isStreamClass(klass)) return
    /*
     * 只负责**入队**，不负责播 —— 多个学科的老师可能几乎同时叫。
     * 以前是 setBroadcast(c) 直接顶掉上一条，语文老师刚喊完物理老师就叫，
     * 学生只听到后半句。现在排队，按先来后到依次播。
     */
    const play = (c: CallRecord) => {
      const k = callKey(c)
      if (playedRef.current.has(k)) return
      // 队列满了就先**不收，也不打标** —— 下一轮轮询还会把它送来，
      // 等积压播掉一条自然就进去了（打了标才是真丢）
      if (queueRef.current.length >= MAX_QUEUE) return
      playedRef.current.set(k, Date.now())
      mutateQueue((q) => [...q, c])
    }

    /* 换班：旧班没播完的不能接着在新班的喇叭里念（那是串台），
       新班也不能把 15 分钟前的旧呼叫补播一遍（那是刚开机就该跳过的）。
       所以队列、播放记录、seeded 标记三个一起归零。 */
    stopSpeaking()
    mutateQueue(() => [])
    playedRef.current.clear()
    seededRef.current = false

    const off = subscribe((m) => {
      if (m.type !== 'call') return
      if (m.call.classId !== klass.id) return
      play(m.call)
    })

    let alive = true
    const tick = async () => {
      const list = await remote.loadRecentCalls(klass.id, Date.now() - 15 * 60_000)
      if (!alive) return
      // 轮询回来的是 created_at **倒序**（最新在前），照原样入队就会倒着念。
      // 先翻成"最旧的在前"，再按最后一次播报时间稳定排序（同一毫秒的保持原先后）。
      const ordered = [...list].reverse().sort((a, b) => lastAt(a) - lastAt(b))
      if (!seededRef.current) {
        // 第一次只把"已经存在的"记下来，不播 —— 免得刚打开就把几分钟前的旧呼叫播一遍
        for (const c of ordered) playedRef.current.set(callKey(c), Date.now())
        seededRef.current = true
        return
      }
      // 顺手清掉过期的键：轮询只回看 15 分钟，比这更老的键不会再出现
      const nowMs = Date.now()
      for (const [k, at] of playedRef.current) {
        if (nowMs - at > SEEN_TTL_MS) playedRef.current.delete(k)
      }
      for (const c of ordered) play(c)
    }
    void tick()
    const t = window.setInterval(() => void tick(), 8000)
    return () => {
      alive = false
      window.clearInterval(t)
      off()
    }
  }, [klass?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => closePip(), [])

  /**
   * 标记这台设备是「教室端」。
   * 之后在这台机器上访问教师端（把 /classroom 改成 /）会要求重新输教师密码 ——
   * 学生在教室里改网址就进不去教师控制台了。
   *
   * ⚠️ **只在教室端账号登录时才标。**
   * 教师用自己的账号打开 /classroom 通常只是想看看那块屏长什么样（核对课表显示），
   * 如果顺手把设备标成教室端，他回头就被自己的 Guard 挡在教师控制台外面了 ——
   * 预览一个页面不该有这个代价。
   *
   * 注意这个标记本来就只是"改网址"这一层的拦阻，**不是安全边界**：
   * 真正的隔离是教室端账号 + 数据库 RLS。
   */
  const accountKind = useStore((s) => s.accountKind)
  useEffect(() => {
    if (accountKind === 'classroom') setDeviceRole('classroom')
  }, [accountKind])

  /**
   * 播报队首那条：响一声提示音 → 念出来 → **念完**才出队，接着播下一条。
   *
   * 以前是固定 15 秒出队：长播报会被拦腰截断，短播报又白占着屏。现在以
   * speechSynthesis 的 onend 为准（`speechBudgetMs` 只是"万一不回调"的兜底）。
   *
   * 静音（考试模式 / 周三下午）期间**什么都不做**：不响、不念、不倒计时，
   * 浮层也不显示 —— 也就是"暂停"，队列原样留着，静音一结束从队首接着播。
   * 这里不能改成"静音期间直接出队丢掉"：丢掉的那条在 playedRef 里已经打了标，
   * 轮询不会再送第二次，它就永远不会有人念了 —— 而老师以为学生已经听见了。
   * 也不能靠"静音期间不入队、等静音结束由轮询补"：轮询只回看 15 分钟，
   * 而静音时段有 2.5 小时（周三下午），过了窗口的呼叫就真没了。
   */
  const playHeadRef = useRef<() => void>(() => {})
  /** 上一次点「关闭」的时刻 —— 防双击连切两条（见浮层里的关闭按钮） */
  const closeAtRef = useRef(-Infinity)
  const headKey = broadcast ? callKey(broadcast) : ''
  useEffect(() => {
    if (!broadcast || silenced) return
    const key = callKey(broadcast)
    let done = false
    let speakTimer = 0
    let fallbackTimer = 0
    let holdTimer = 0
    /** 这条从什么时候开始展示 —— 「再播一遍」会重置它 */
    let shownAt = Date.now()
    /** 出队。语音结束 / 兜底超时 / 最短展示到期，三个来源会抢，只认先到的那个 */
    const advance = () => {
      if (done) return
      done = true
      mutateQueue((q) => (q[0] && callKey(q[0]) === key ? q.slice(1) : q))
    }
    /**
     * 这条至少要展示多久 —— 按字数算，与语音是否可用无关。
     * 见文件上方 BUBBLE_MIN_MS 的注释：语音一坏就闪过去，是实机上踩过的坑。
     */
    const holdMs = () =>
      Math.max(BUBBLE_MIN_MS, broadcast.text.replace(/\s+/g, '').length * BUBBLE_MS_PER_CHAR)
    /**
     * 语音这条路走完了（念完、合成失败、被系统打断都算）。
     * **不立刻出队** —— 先补齐"够读完"的那段时间，不够就不补。
     */
    const finishSpeech = () => {
      const left = shownAt + holdMs() - Date.now()
      if (left > 0) holdTimer = window.setTimeout(advance, left)
      else advance()
    }
    /** 响铃 → 开口；「再播一遍」也走这里，所以最短展示与兜底计时都重新起算 */
    const playHead = () => {
      chime()
      shownAt = Date.now()
      window.clearTimeout(speakTimer)
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(holdTimer)
      speakTimer = window.setTimeout(() => {
        // 这 0.68 秒里静音开始了（静音时段刚好跨过这一秒）：
        // 什么都别做，队列留着 —— silenced 一变 effect 会重跑，静音结束再念
        if (isSilenced()) return
        speak(broadcast.text, { onEnd: finishSpeech })
      }, SPEAK_AFTER_CHIME_MS)
      fallbackTimer = window.setTimeout(
        () => {
          if (!isSilenced()) finishSpeech()
        },
        SPEAK_AFTER_CHIME_MS + speechBudgetMs(broadcast.text),
      )
    }
    playHeadRef.current = playHead
    playHead()
    return () => {
      window.clearTimeout(speakTimer)
      window.clearTimeout(fallbackTimer)
      window.clearTimeout(holdTimer)
      playHeadRef.current = () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headKey, silenced])

  const startPip = async () => {
    unlockAudio()
    setArmed(true)
    const r = await openPip()
    if (!r.ok) {
      /*
       * 🔴 **两种失败要分开说**（2026-10-04 改；原来一律说"需要 Edge / Chrome 116 及以上"）：
       *   · `no-api`  —— 这台机器上压根没有这个能力（老浏览器 / 教师端 exe / 某些壳）；
       *   · `failed`  —— 能力在，但窗口没开成（`requestWindow` 抛了 / 壳侧没建出来）；
       *   而**在教室端 exe 里那句"浏览器太老"是假的**：它跑的是 Electron 33（Chromium 130）、
       *   `app://` 也是安全上下文 —— 真因是壳里调不起来。所以按端说人话：
       *   壳里就说"这台机器上开不了 + 看手机/平板"，网页版才提浏览器版本。
       */
      const inShell = shellPlatform() === 'electron'
      push(
        r.why === 'no-api'
          ? {
              text: inShell ? '这台机器上开不了置顶小窗' : '当前浏览器不支持置顶小窗',
              tone: 'warn',
              desc: inShell ? '讲评时请用手机或平板看题号与正确率' : '需要 Edge / Chrome 116 及以上版本',
            }
          : { text: '置顶小窗没打开', tone: 'warn', desc: '再点一次；还不行就用手机或平板看题号与正确率' },
      )
      return
    }
    /*
     * 🔴 两条路各回各的（2026-10-04）：
     *   · 壳原生 —— `win` 是 `null`（窗口在主进程手里）⇒ 只翻一个标记，
     *     那一屏由下面那个 effect 推过去（**网页推、壳只画**）；
     *   · Document PiP —— 老路一字没改：接 `pagehide`、把 `win` 交给 portal。
     */
    if (r.native) {
      setPipNative(true)
      return
    }
    const w = r.win
    if (!w) return
    w.addEventListener('pagehide', () => setPipWin(null))
    setPipWin(w)
  }

  /*
   * 🆕 小窗被关掉 ⇒ 把屏上那颗按钮变回「启动置顶小窗」（2026-10-04，施工单 §二.4）。
   *
   * 🔴 **谁关的都算**：小窗自己那颗 ✕ / 网页侧 `closePip()` / 系统别的路 ——
   *    壳在主进程 `closed` 事件里发 `shell:pipClosed`，这里复位；网页版没有这个口（返回空注销函数）。
   */
  useEffect(() => onPipClosed(() => {
    setPipNative(false)
    setPipWin(null)
  }), [])

  const nameOf = useCallback(
    // `no` 是**档案键**（迁移后 = 序列号）—— 两条路都要认（见 `lib/keys.ts`）
    (no: string) => students.find((s) => s.studentNo === no || s.serial === no)?.name ?? '',
    [students],
  )

  const cur = stats?.questions[seq - 1]

  /**
   * 🆕 把小窗那一屏**推给壳**（2026-10-04，施工单 `教室端原生置顶小窗` §二.3）。
   *
   * 🔴 触发条件就是施工单那句话：**班级 / 题号 / 正确率 / 未交人数一变就推**。
   *    依赖逐个列出来（不是把整个 `cur` 丢进去）：题号 / 正确率 / 未交人数正好是
   *    那三个会变的量 —— **题号一变就必须有新数据过去**（门禁 `nav-checks` 钉着这一处）。
   * ⚠️ 只在**壳原生**那条路上推：Document PiP 走的是 portal，React 自己会更新，推了也没人收。
   * ⚠️ 每次 `pipData` 壳都重建那一屏（每节课几次，代价可忽略），而且**壳不做任何计算**。
   * 🔴 这个 effect **必须放在 `cur` 声明之后**：依赖数组里的 `cur?.rate` 是在渲染期求值的，
   *    放前面会撞上 TDZ（`Cannot access 'cur' before initialization`）—— 那是整页崩，不是静默。
   */
  useEffect(() => {
    if (!pipNative) return
    pushPipScreen({
      className: klass?.name ?? '',
      seq: cur ? seq : 0,
      total: stats?.questions.length ?? 0,
      // 网页先算好 0–100 的整数再给壳：一个字段一种语义，壳里不再乘一遍
      ratePct: Math.round((cur?.rate ?? 0) * 100),
      missing: collect?.missing ?? 0,
    })
  }, [pipNative, klass?.name, seq, cur?.rate, stats?.questions.length, collect?.missing])

  /* ============================================================
     🆕 维护模式（2026-09-29 管理台第二期）—— 教室端**自己**渲染维护画面
     ------------------------------------------------------------
     🔴 为什么这一页**不交给全局闸门**（`MaintenanceGate.tsx` 的文件头写的是同一件事）：
        闸门会把这一页整块卸载掉 —— 而卸载会**停掉心跳**，面板随即显示"教室端离线"，
        可它其实好好地在显示维护画面：那是往"假在线"那条已知缺陷（H3/W4）
        上再叠一层假信号。所以这里的顺序是：
          ① **心跳照发**（上面那个 effect 一行都不用改，它按 `client` 跑）；
          ② **立刻清掉本页学生数据**（下面那个 effect）；
          ③ 整屏换成维护画面（下面那个 early return）。

     🔴 **问的是"要不要清"，不是"要不要停"**：维护画面的意义之一就是
        "别让学生继续看到作业 / 名单"。清的是**这一页渲染出来的东西**：
        本机文件列表、云端文件列表、播报队列、置顶小窗、语音 ——
        ⚠️ **不动 `store`**：那是全班/全校的数据，别的老师还在用（清 store 等于删数据）。
     ============================================================ */
  const maint = useMaintenanceStatus()
  const maintOn = maint.enabled
  useEffect(() => {
    if (!maintOn) return
    /* 立刻清屏上/本页里那些"学生看得见"的东西 */
    stopSpeaking()
    closePip()
    setPipWin(null)
    setPipNative(false)
    mutateQueue(() => [])
    setCloudFiles([])
    setLocalFiles([])
    setSchedReview(null)
    setPasteText('')
    setAssignmentId('')
  }, [maintOn, mutateQueue])

  /* ============================================================
     🆕 每日作业 + 值日生（`supabase/schema.sql` §40 那三张表）
     ------------------------------------------------------------
     🔴 这一块**必须放在下面那几个 early return 之前**（`:1010` 起）——
        `rules-of-hooks`：维护中 / 后端没同步 / 没登录 / 没班级，这四种整屏状态
        也会走一遍 render，钩子少走一次就会报"渲染的 hook 数变了"。
     🔴 这块屏**只读**：值日生由教师端指定，每日作业由老师在教师端录
        （课代表那一条走口令，校验在数据库里）。教室端只回答"今天该看见什么"。
     ============================================================ */
  const [dl, setDl] = useState<DailyBundle | null>(null)
  /** 课代表录作业那张 Sheet（屏上入口 + 班级口令） */
  const [repOpen, setRepOpen] = useState(false)
  /** 作业档案区的两个筛选：学科（`''` = 全部）与日期（默认**今天**） */
  const [hwSubject, setHwSubject] = useState('')
  const [hwDate, setHwDate] = useState<'today' | 'yesterday' | 'all'>('today')
  /** 档案**默认全收起**：点开一条，下面才展开它的逐题正确率 */
  const [hwOpen, setHwOpen] = useState(false)

  useEffect(() => {
    const id = klass?.id
    if (!id) return
    let alive = true
    /* 窗口：往前两周（教室端也会翻到前几天）+ 明天（有人提前录了也看得见） */
    loadDailyBundle(id, isoOffset(DAILY_FROM), isoOffset(DAILY_TO))
      .then((b) => {
        if (alive) setDl(b)
      })
      .catch(() => {
        if (!alive) return
        /* 🔴 读不到就**按空显示**，并把话说出来（不假装"今天没作业"） */
        setDl({
          state: 'unknown',
          homework: [],
          anchors: [],
          calendar: [],
          notice: '这一次没读出每日作业 / 值日生。',
        })
      })
    return () => {
      alive = false
    }
  }, [klass?.id, todayIso])

  /**
   * 值日生：池子 = 本班在读学生（`students` 已按学号排好），锚点 = 老师指定过的那些天。
   * **轮值算法只有一处**（`lib/duty.ts` 的纯函数，教师端预览 / 导出图片共用同一份）。
   */
  const dutyInput = useMemo(
    () =>
      klass
        ? toDutyInput({
            students,
            anchors: dl?.anchors ?? [],
            calendar: dl?.calendar ?? [],
            classCreatedAt: klass.createdAt,
          })
        : null,
    [klass, students, dl],
  )
  const dutyTodayRes = dutyInput ? todayDuty(dutyInput) : null
  const dutyTodayName = dutyTodayRes?.name ?? null

  /** 今天各科留的作业（同一天同一科**可以不止一条** —— 口径见 §40） */
  const todayHw = useMemo(
    () => (dl?.homework ?? []).filter((h) => h.onDate === todayIso),
    [dl, todayIso],
  )

  /**
   * 今天这几条按**学科**归拢（一科一组，组内按 `seq`）。
   * 为什么不在渲染里现算：这块屏一分钟重渲染好几次（时钟），分组是纯函数，算一次就够。
   * ⚠️ 顺序按 `lib/subjects.ts` 那张字典（语文数学英语…），不是插入顺序。
   */
  const hwGroups = useMemo(() => {
    const order = new Map(SUBJECTS.map((s, i) => [s.code as string, i]))
    const groups: Array<{ key: string; label: string; code: string; rep: boolean; items: DailyHomework[] }> = []
    const byKey = new Map<string, (typeof groups)[number]>()
    for (const h of todayHw) {
      const code = subjectCodeOf(h) ?? ''
      const key = code || h.subject || '其他'
      let g = byKey.get(key)
      if (!g) {
        g = { key, label: subjectName(code, h.subject || '其他'), code, rep: false, items: [] }
        byKey.set(key, g)
        groups.push(g)
      }
      if (h.source === 'rep') g.rep = true
      g.items.push(h)
    }
    groups.sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99))
    return groups
  }, [todayHw])

  /**
   * 档案区**看得见的那几行**：先按日期档（今天 / 昨天 / 全部）再按学科筛。
   *
   * 🔴 只影响这一块的显示。上面那个 `<select>` 必须继续列**全部** `graded` ——
   *    `app/scripts/clock-checks.mjs:1421-1425` 数它的 options 个数、
   *    `app/scripts/shots.mjs:1900-1905` 断言它只有普通模式那一份。
   * ⚠️ 演示数据里**今天没有已批改档案**（`app/src/data/seed.ts` 那几份在 -1/-2 天），
   *    所以默认这一档必须给诚实空态 + 一键切「全部」，不能看起来像坏了。
   */
  const hwRows = useMemo(() => {
    const hit = (a: { assignDate: string }) => {
      if (hwDate === 'all') return true
      if (hwDate === 'yesterday') return a.assignDate === isoOffset(-1)
      return a.assignDate === todayIso
    }
    const list = graded.filter(
      (a) => hit(a) && (!hwSubject || subjectCodeOf(a) === hwSubject),
    )
    return [...list].sort((x, y) =>
      x.assignDate === y.assignDate
        ? x.title.localeCompare(y.title, 'zh')
        : x.assignDate < y.assignDate
          ? 1
          : -1,
    )
  }, [graded, hwDate, hwSubject, todayIso])

  /** 档案区里**实际出现过**的学科（按字典顺序）—— 15 个全摆太挤，只摆有的 */
  const hwSubjects = useMemo(() => {
    const order = new Map(SUBJECTS.map((s, i) => [s.code as string, i]))
    const codes = [...new Set(graded.map((a) => subjectCodeOf(a) ?? ''))]
    codes.sort((x, y) => (order.get(x) ?? 99) - (order.get(y) ?? 99))
    return codes.map((code) => ({ code, label: subjectName(code, code || '其他') }))
  }, [graded])

  /**
   * 现在是不是"课间"（值日生提醒的时机）。
   *
   * 🔴 用户 2026-10-02 纠正过一次口径：**不是放学**，是**每节课下课**要有人擦黑板。
   * 判据只用课表本身：上一节已经下课、下一节还没开始 ⇒ 中间这段就是课间。
   * 最后一节下课仍然提醒一次（擦完黑板再走），但只留 30 分钟 ——
   * 放学后不该一直挂着一枚浮标。放假 / 今天没课 / 今天不上课 ⇒ 不提醒。
   */
  const breakReminder = useMemo(() => {
    if (restDay) return false
    const items = dayItems.items
    if (!items.length) return false
    const sorted = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start))
    for (let i = 0; i < sorted.length; i += 1) {
      const end = toMinutes(sorted[i].end)
      if (nowMin < end) continue // 这一节还没下课
      const nxt = sorted[i + 1]
      if (nxt) {
        if (nowMin < toMinutes(nxt.start)) return true // 课间
        continue // 已经上课了，看下一节
      }
      return nowMin - end <= 30 // 最后一节：只留半小时
    }
    return false
  }, [dayItems.items, nowMin, restDay])

  /* ---------- 维护中：整屏维护画面（心跳与清理见上面那一段） ---------- */
  if (maintOn) {
    return (
      <Shell>
        <MaintenanceScreen status={maint} variant="classroom" />
      </Shell>
    )
  }

  /* ---------- 后端模式下教室端需要一次登录 ---------- */
  if (isRemote && !hydrated) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 15, fontWeight: 640 }}>正在同步数据…</div>
        </Panel>
      </Shell>
    )
  }
  if (isRemote && !teacher) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>教室端还没有登录</div>
          <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.7 }}>
            这台一体机需要用教师账号登录一次，之后会一直保持登录。
            <br />
            登录后回到本页即可。
          </div>
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => navigate('/login')}
          >
            去登录
          </Button>
        </Panel>
      </Shell>
    )
  }

  /* ---------- 没有班级 ---------- */
  if (!klass) {
    return (
      <Shell>
        <SyncWrap />
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>还没有班级数据</div>
        </Panel>
      </Shell>
    )
  }

  /*
   * 🔴 Q17：**走班班的屏**（`classes.kind = 'stream'`）—— 「有屏，但只读」。
   *    它能看的只有**作业**与**考试**；所以下面把这些入口**不摆**：
   *      · 粘贴课表 / 拍课表（那是**写**：`schedule_items` 上教室端那两处有限写之一，
   *        数据库那边也已经把它收窄到行政班了 —— `schema.sql` §33.4，这里只是不摆入口）；
   *      · 呼叫播报面板（走班班的屏**不接呼叫** —— 呼叫落行政班）；
   *      · 老师传来的文件、自动备份到本机（那是行政班那块屏的活）。
   *    ⚠️ **摆不摆入口 ≠ 判据**：判据全在数据库（`visible_class_ids_for` + §33.4 那三条
   *       restrictive 策略）。少写一处前端隐藏，并不会让它多出一点权限。
   */
  const streamMode = isStreamClass(klass)

  /**
   * 核对页每一条只有三种状态，**不许混**：
   *   · `ok`    —— 认出了班名（绿）：教室端会显示；
   *   · `red`   —— 班名认不出（红）：`classId` 是空的，**教室里一条都不会显示**；
   *   · `unknown` —— 班级列表根本没读到（**灰**，不是红）：判不了，不能说人家错。
   * ⚠️ 第三种必须是灰（§三.4 三态）：`classes` 空 = 数据没读回来，那是"没结论"。
   */
  const classMark = (r: ParsedScheduleItem): 'ok' | 'red' | 'unknown' => {
    if (!classes.length) return 'unknown'
    if (!r.title.trim()) return 'unknown'
    const name = matchClassName(r.title, classes)
    if (!name) return 'red'
    return name === klass?.name ? 'ok' : 'red'
  }

  /**
   * 粘贴框里的示例 —— **必须带本班班名**（用户 2026-09-28 实测栽在这）。
   *
   * 教室端只显示 `scope='class'` 且 `classId` 等于本班的行，而 `classId` 是
   * `matchClass()` 从**标题文本**里认班名才给的（见 lib/scheduleParse.ts）。
   * 原来的示例只有「周一 08:00-08:40 英语」——**照着它写，导进去 classId 是空的，
   * 教室里一条都不显示**，而且屏上连个招呼都不打。所以这里用**本班真实班名**拼示例，
   * 并且说明这个班名是给谁看的（不然老师会以为该把它抄进标题）。
   */
  const pasteSample = klass?.name
    ? `一行一条，例如：\n周一 08:00-08:40 ${klass.name} 英语 张老师\n周一 08:50-09:30 ${klass.name} 语文 李老师\n周三 10:50-11:30 ${klass.name} 化学 王老师`
    : '一行一条，例如：\n周一 08:00-08:40 高二(1)班 英语 张老师\n周一 08:50-09:30 高二(1)班 语文 李老师'
  const pasteHint = klass?.name
    ? `每行要写上班名「${klass.name}」——教室端靠它认出这节课是哪个班的；不写班名，这一条在教室里不会显示。`
    : null

  /**
   * 核对页要摊开的两件事：
   *   · `noShow` —— 这批里有几条 **教室里不会显示**（认不出班名）。**必须说出来**：
   *     用户实测就是"粘了、看不见、也没人告诉他为什么"（2026-09-28）。
   *   · `existing` —— 本班**已经**有多少条课。`addScheduleMany` 是**只追加**，
   *     所以再导一次就是两批（《功能设计与不变量.md》§重复导入）。
   */
  const noShow = (schedReview ?? []).filter((r) => classMark(r) === 'red').length
  const existing = schedule.filter((s) => s.scope === 'class' && s.classId === klass?.id).length

  /** 清掉本班旧课表（重复导入的出路）—— 删的是本班全部 `scope='class'` 行，不是"这一批" */
  const dropAllOld = () => {
    if (!klass) return
    const ok = window.confirm(
      `确定清掉${klass.name}的全部旧课表吗？共 ${existing} 条，本班之前导错、重复的那些会一起没掉。`,
    )
    if (!ok) return
    const old = schedule.filter((s) => s.scope === 'class' && s.classId === klass.id)
    if (!old.length) return
    old.forEach((s) => removeSchedule(s.id))
    push({ text: `已清掉旧课表 ${old.length} 条`, tone: 'warn' })
  }

  /**
   * 🆕 重新读一遍"每日作业 / 值日生"（课代表刚录完一条时用）。
   * 不去动上面那个 load effect：它挂的是 `[klass?.id, todayIso]`，录一条不该重挂。
   */
  const reloadDaily = async () => {
    if (!klass) return
    setDl(await loadDailyBundle(klass.id, isoOffset(DAILY_FROM), isoOffset(DAILY_TO)))
  }

  /**
   * 🆕 把"今天的每日作业"存成一张 800×600 的 PNG。
   *
   * 版式就是用户给的那份壁纸工具（紫→紫灰渐变、左上日期、一科一行）——
   * 口径 ⑨"把那个项目内置到教室端"落到这里：**教室端只负责出图**，
   * 它不设 Windows 壁纸（那是打包成 exe 以后外壳的活，《打包与系统能力清单.md》里写了）。
   */
  const saveHomeworkImage = async () => {
    const blob = await homeworkImageBlob({
      className: klassName,
      onDate: todayIso,
      rows: todayHw,
      duty: dutyTodayName,
    })
    if (!blob) {
      push({ text: '这张图没画出来', tone: 'bad' })
      return
    }
    downloadBlob(blob, homeworkImageName(klassName, todayIso))
    push({ text: '作业图片已生成，去浏览器的下载里拿', tone: 'ok' })
  }

  return (
    <Shell>
      {/* 照片识别的结果先给教师核对 —— 时间最容易认错，不能直接入库 */}
      <Sheet open={Boolean(schedReview)} onClose={() => setSchedReview(null)} title="核对课表">
        {schedReview ? (
          <>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 10 }}>
              照片识别最容易在<b>时间</b>上出错。一条条对着原表核一遍，改完再导入。
            </p>

            {/* 🔴 教室端看的是「本班 + classId」这一条线 —— 认不出班名的行，教室里一条都不会显示。
                这件事以前核对页一个字都不说（用户 2026-09-28 就是这么"粘了、看不见"的）。 */}
            {noShow > 0 ? (
              <div
                style={{
                  background: 'var(--color-badsoft)',
                  border: '1px solid var(--color-badline)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  fontSize: 11.5,
                  color: 'var(--color-badink)',
                  lineHeight: 1.7,
                  marginBottom: 10,
                }}
              >
                这 {schedReview.length} 条里有 <b>{noShow} 条没认出班名，教室里不会显示</b>
                {klass ? `（下面标红的那几条就是）。把它改成「${klass.name} 科目 老师」再导入。` : '。'}
              </div>
            ) : null}

            {/* 重复导入：`addScheduleMany` **只追加**，所以再导一次就是两批。
                这里明说，并给一条出路（清掉旧的），不走静默覆盖。 */}
            {existing > 0 ? (
              <div
                style={{
                  background: 'var(--color-warnsoft)',
                  border: '1px solid var(--color-warnline)',
                  borderRadius: 4,
                  padding: '8px 10px',
                  fontSize: 11.5,
                  color: 'var(--color-warnink)',
                  lineHeight: 1.7,
                  marginBottom: 10,
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">
                    {klass ? `${klass.name}已有 ` : '本班已有 '}
                    <b>{existing} 条课</b>，再导入会变成两批（旧的不会自动顶掉）。
                  </span>
                  <Button size="sm" variant="danger" onClick={dropAllOld}>
                    先清掉旧的 {existing} 条
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              {schedReview.map((r, i) => (
                <div
                  key={`${r.weekday}-${r.start}-${i}`}
                  style={{ border: '1px solid var(--color-line2)', borderRadius: 4, padding: 8 }}
                >
                  <div className="flex items-center gap-1.5">
                    <select
                      className="input"
                      style={{ width: 74, flexShrink: 0 }}
                      value={r.weekday}
                      onChange={(e) => patchRow(i, { weekday: Number(e.target.value) })}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                        <option key={w} value={w}>
                          {WEEKDAY_TEXT[w - 1]}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input num"
                      type="time"
                      value={r.start}
                      onChange={(e) => patchRow(i, { start: e.target.value })}
                    />
                    <span style={{ color: 'var(--color-ink3)', flexShrink: 0 }}>–</span>
                    <input
                      className="input num"
                      type="time"
                      value={r.end}
                      onChange={(e) => patchRow(i, { end: e.target.value })}
                    />
                    <button
                      type="button"
                      className="shrink-0"
                      style={{ marginLeft: 'auto', color: 'var(--color-bad)', fontSize: 12 }}
                      onClick={() => setSchedReview((rows) => rows?.filter((_, k) => k !== i) ?? null)}
                    >
                      删除
                    </button>
                  </div>
                  <input
                    className="input mt-1.5"
                    value={r.title}
                    placeholder="课程名"
                    onChange={(e) => patchRow(i, { title: e.target.value })}
                  />
                  {/* 这一行教室端会不会显示 —— 三态：认出来（绿）/ 没认出来（红）/ 判不了（灰）。
                      `data-cf-mark` 是给门禁数的（`clock-checks.mjs` 要精确数
                      "几条会显示 / 几条不会"），不是样式钩子。 */}
                  {(() => {
                    const mark = classMark(r)
                    if (mark === 'ok')
                      return (
                        <div
                          data-cf-mark="ok"
                          style={{ fontSize: 11, color: 'var(--color-okink)', marginTop: 4 }}
                        >
                          ✓ 认出班名「{matchClassName(r.title, classes)}」，教室端会显示
                        </div>
                      )
                    if (mark === 'red')
                      return (
                        <div
                          data-cf-mark="red"
                          style={{
                            fontSize: 11,
                            color: 'var(--color-bad)',
                            marginTop: 4,
                            lineHeight: 1.6,
                          }}
                        >
                          ⚠ 这条没认出班名，教室里不会显示 —— 标题里写上班名
                          {klass ? `「${klass.name}」` : ''}
                        </div>
                      )
                    /* classes 有、标题空 → 那是"还没填"，不用再说一句（下面「课程名」那个框空着就是提示） */
                    if (classes.length) return null
                    /* 🔴 班级列表没读到 = **判不了**，这里是灰不是红（§三.4 三态） */
                    return (
                      <div
                        data-cf-mark="unknown"
                        style={{ fontSize: 11, color: 'var(--color-ink3)', marginTop: 4 }}
                      >
                        班级列表没读到，暂时看不出教室端会不会显示
                      </div>
                    )
                  })()}
                  {r.raw ? (
                    <div
                      style={{ fontSize: 10.5, color: 'var(--color-ink4)', marginTop: 4, lineHeight: 1.5 }}
                    >
                      原表内容：{r.raw.slice(0, 70)}
                    </div>
                  ) : null}
                  {toMinutes(r.end) <= toMinutes(r.start) ? (
                    <div style={{ fontSize: 11, color: 'var(--color-bad)', marginTop: 4 }}>
                      ⚠ 结束时间不晚于开始时间
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            {schedReview.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--color-ink3)', padding: '8px 0' }}>
                都删光了，换一张图重来吧。
              </div>
            ) : null}

            <div className="mt-4 flex gap-2">
              <Button block onClick={() => setSchedReview(null)}>
                取消
              </Button>
              <Button
                block
                variant="primary"
                onClick={async () => {
                  const rows = schedReview.filter(
                    (r) => r.title.trim() && toMinutes(r.end) > toMinutes(r.start),
                  )
                  if (!rows.length) {
                    push({ text: '没有可导入的课', tone: 'warn' })
                    return
                  }
                  const items = rows.map((it) => ({
                    weekday: it.weekday,
                    start: it.start,
                    end: it.end,
                    title: it.title.trim(),
                    room: it.room,
                    classId: it.classId,
                    kind: it.kind,
                    notify: it.notify,
                    scope: 'class' as const,
                  }))
                  /*
                   * 🔴 教室端粘贴也是排课入口之一 —— **同一个** `checkScheduleConflicts`（I16）。
                   * 教室端只看得到本班，但冲突的另一半在**别的班**（走班班 / 别的行政班），
                   * 所以这一处不校验的话，它就是一个"看起来很正常"的绕过口（方案 §2.3）。
                   */
                  const gate = await checkScheduleConflicts(
                    { items: items.map((x, i) => ({ ...x, id: `pending-${i}` })), schedule, classes },
                    { loadMembers: remote.loadClassMembers, loadSubjects: remote.loadClassSubjects },
                  )
                  if (gate.blocked) {
                    setSchedErr(`和走班班撞了，没有导入：\n${gate.message}`)
                    return
                  }
                  addScheduleMany(items)
                  setSchedReview(null)
                  setSchedErr('')
                  /*
                   * 追加了多少要**明说**（不许静默）：认不出班名的那几条照样入库了，
                   * 只是在教室里不会显示 —— 这句话就是"上一批怎么还有旧行"的答案。
                   */
                  const hidden = rows.filter((r) => classMark(r) === 'red').length
                  if (hidden) {
                    push({
                      text: `已导入 ${rows.length} 条课`,
                      tone: 'warn',
                      desc: `${hidden} 条没认出班名，教室里不会显示`,
                    })
                  } else {
                    push({
                      text:
                        existing > 0
                          ? `已导入 ${rows.length} 条课（本班原有 ${existing} 条，没有顶掉）`
                          : `已导入 ${rows.length} 条课`,
                      tone: 'ok',
                    })
                  }
                }}
              >
                确认导入（{schedReview.length} 条）
              </Button>
            </div>
          </>
        ) : null}
      </Sheet>

      {/* 粘贴课表：学校发的电子表直接贴，比拍照准，也不会漏掉"没写时间"的节次 */}
      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="粘贴课表">
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.7, marginBottom: 8 }}>
          把课表复制粘贴进来即可。识别出来会先让你<b>核对时间</b>，不会直接入库。
        </p>
        {pasteHint ? (
          <p style={{ fontSize: 11.5, color: 'var(--color-bad)', lineHeight: 1.7, marginBottom: 8 }}>
            {pasteHint}
          </p>
        ) : null}
        <textarea
          className="input"
          rows={11}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={pasteSample}
          style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.7, resize: 'vertical' }}
        />
        <div className="mt-3 flex gap-2">
          <Button block onClick={() => setPasteOpen(false)}>
            取消
          </Button>
          <Button
            block
            variant="primary"
            disabled={!pasteText.trim()}
            onClick={() => {
              const parsed = parseScheduleText(pasteText, classes)
              setPasteOpen(false)
              if (!parsed.items.length) {
                setSchedErr(
                  klass?.name
                    ? `没解析出课程。一行一条写最稳，例如「周一 08:00-08:40 ${klass.name} 英语」。`
                    : '没解析出课程。一行一条写最稳，例如「周一 08:00-08:40 高二(1)班 英语」。',
                )
                return
              }
              setSchedErr('')
              setSchedReview(parsed.items)
            }}
          >
            解析并核对
          </Button>
        </div>
      </Sheet>

      <div ref={rootRef}>
        {/* 顶栏 */}
        <div
          className="glass sticky top-0 z-30 flex flex-wrap items-center gap-3 px-5"
          style={{ height: 62, borderBottom: '1px solid var(--color-line)' }}
        >
          <span className="flex items-center gap-2.5">
            {/* 教室端顶栏：校徽 **40px 全徽**（盒子 46.0 = 40 / 0.87）。
                这一条与桌面左栏那一处同形（徽左字右的平台名），顶栏 62 高装得下。
                ⚠️ 教室端**恒亮**（`lib/theme.ts` 里判路由，见 `index.css`），所以这里永远不带提亮。 */}
            <Emblem n={40} />
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>树高教务通</span>
            <Tag tone="accent">教室端</Tag>
            {/* 🔴 Q17：走班班的屏 —— 有屏但只读，只看作业与考试，不接呼叫 */}
            {streamMode ? <Tag tone="warn">走班班 · 只读</Tag> : null}
          </span>

          <span className="flex-1" />

          <select
            className="input"
            style={{ width: 'auto', height: 34, fontSize: 13 }}
            value={klass.id}
            onChange={(e) => {
              setClassId(e.target.value)
              setAssignmentId('')
              setSeq(1)
            }}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <span className="flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            <span
              className={client?.online ? 'live-dot' : ''}
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: client?.online ? 'var(--color-ok)' : 'var(--color-warn)',
                display: 'inline-block',
              }}
            />
            <IconWifi size={14} />
            <span style={{ color: 'var(--color-ink3)' }}>{client?.name ?? '未绑定'}</span>
          </span>

          {pipOn ? (
            <Button
              size="sm"
              icon={<IconCheck size={14} />}
              onClick={() => {
                /* 🔴 两条路都要收干净：关上（壳里那次是主进程关的）+ 本地标记复位 */
                closePip()
                setPipWin(null)
                setPipNative(false)
              }}
            >
              小窗已开启
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<IconTarget size={14} />} onClick={startPip}>
              启动置顶小窗
            </Button>
          )}
        </div>

        <div className="mx-auto w-full px-5 py-5" style={{ maxWidth: 1360 }}>
          {/* 同步失败：教室里这块屏也得自己说出来 */}
          <SyncBanner />

          {/* 小窗不可用提示 */}
          {!pipSupported() ? (
            <div
              data-classroom-pip-unsupported
              className="mb-4 flex items-start gap-2.5 p-3.5"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid var(--color-warnline)',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={17} />
              </span>
              <div style={{ fontSize: 13, color: 'var(--color-warnink)', lineHeight: 1.7 }}>
                {shellPlatform() === 'electron' ? (
                  <>这台机器上开不了<b>置顶小窗</b>。讲评时请用手机或平板看题号与正确率。</>
                ) : (
                  <>
                    当前浏览器不支持<b>强制置顶小窗</b>（需要 Edge / Chrome 116 及以上）。
                    讲评时请用手机或平板看题号与正确率。
                  </>
                )}
              </div>
            </div>
          ) : !armed ? (
            <div
              data-classroom-unlock
              className="mb-4 flex flex-wrap items-center gap-3 p-3.5"
              style={{
                background: 'var(--color-accentsoft)',
                border: '1px solid var(--color-infoline)',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-accenttext)' }}>
                <IconInfo size={17} />
              </span>
              <div
                className="flex-1"
                style={{ fontSize: 13, color: 'var(--color-accentink)', lineHeight: 1.7 }}
              >
                点一次「启动置顶小窗」：小窗会浮在全屏的新教育平台之上，显示当前题号与正确率。
                <b>同时这一步也解开了浏览器的声音限制</b>，呼叫播报才能出声。
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  unlockAudio()
                  setArmed(true)
                  chime()
                  push({ text: '已解锁声音', tone: 'ok', desc: '现在可以听到呼叫播报' })
                }}
              >
                先解锁声音
              </Button>
            </div>
          ) : null}

          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: 'minmax(300px, 360px) 1fr' }}
          >
            {/* 左列 */}
            <div className="flex flex-col gap-4">
              <ClockBig klassName={klass.name} duty={dutyTodayName} />

              {/*
                每日名言 —— 这一屏是**给学生看的**，所以内容来自 `lib/quotes.ts`
                （古典诗词 / 名言警句 / 人民日报，**每条都写出处**），
                与教师端那句问候（`lib/mood.ts`）不是同一批。

                🔴 用 `beijingNow()` 的日期做种子（`pickDailyQuote` 内部走 `dayIndex`），
                   **不用随机** —— 否则刷新一次就换一句，学生会以为屏幕在乱跳。
                字号按屏宽走 clamp：最后一排也要看得清，但不许压过右边那块逐题区。
              */}
              <DailyQuote />

              {/* 今天的课 —— 时间在最前面，一眼看清现在上什么、下一节什么 */}
              <Panel bodyClass="p-4">
                <input
                  ref={schedRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void scanSchedule(f)
                    e.target.value = ''
                  }}
                />
                <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <IconClock size={15} />
                  <span style={{ color: 'var(--color-ink2)' }}>
                    这个班的课 · {WEEKDAY_TEXT[weekdayOf(now) - 1]}
                  </span>
                  <span className="flex-1" />
                  {/* 走班班的屏**只读**：这两个是"粘贴 / 拍课表"的**写**入口，不摆（§33.4 已从数据库收窄） */}
                  {streamMode ? null : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setPasteText('')
                          setPasteOpen(true)
                        }}
                        style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
                      >
                        粘贴课表
                      </button>
                      <button
                        type="button"
                        disabled={schedBusy}
                        onClick={() => schedRef.current?.click()}
                        style={{ fontSize: 11.5, color: 'var(--color-accenttext)' }}
                      >
                        {schedBusy ? '识别中…' : '拍课表'}
                      </button>
                    </>
                  )}
                </div>

                {isMakeup ? (
                  <div
                    className="mb-2 flex flex-wrap items-center gap-1.5 p-2"
                    style={{
                      background: 'var(--color-warnsoft)',
                      border: '1px solid var(--color-warnline)',
                      borderRadius: 4,
                      fontSize: 11.5,
                      color: 'var(--color-warnink)',
                    }}
                  >
                    <span>今天是调休上班日，按</span>
                    {[1, 2, 3, 4, 5].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setWeekOverride(w)}
                        style={{
                          padding: '1px 7px',
                          borderRadius: 3,
                          fontSize: 11.5,
                          fontWeight: useWeekday === w && weekOverride !== null ? 700 : 500,
                          background:
                            useWeekday === w && weekOverride !== null
                              ? 'var(--color-warn)'
                              : 'rgb(255 255 255 / .6)',
                          /* ⚠️ 教室端恒亮（`data-theme` 在 `/classroom` 上永远不写），
                             所以这里 `#fff / rgb(255 255 255/.6)` **是有意的**：
                             它是压在那条**暖黄 warn 块**上的字，不是"漏改的面色"。 */
                          color:
                            useWeekday === w && weekOverride !== null ? '#fff' : 'inherit',
                        }}
                      >
                        {WEEKDAY_TEXT[w - 1]}
                      </button>
                    ))}
                    <span>的课表上</span>
                    {weekOverride !== null ? (
                      <button
                        type="button"
                        onClick={() => setWeekOverride(null)}
                        style={{ color: 'var(--color-ink3)', textDecoration: 'underline' }}
                      >
                        还原
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {dayItems.conflicts.length ? (
                  <div
                    className="mb-2 p-2"
                    style={{
                      background: 'var(--color-badsoft)',
                      border: '1px solid var(--color-badline)',
                      borderRadius: 4,
                      fontSize: 11.5,
                      color: 'var(--color-badink)',
                      lineHeight: 1.6,
                    }}
                  >
                    {dayItems.conflicts.map((c) => (
                      <div key={c}>⚠ {c}</div>
                    ))}
                  </div>
                ) : null}

                {/*
                 * 放假：不显示课表。
                 * 放假那天 useWeekday 仍然是真实的星期四，不拦就会显示周四的课。
                 * 调休上班日（makeup）**不算**放假，课照上（还可能按教师手选的星期上）。
                 */}
                {restDay ? (
                  <div
                    className="mt-2"
                    style={{
                      border: '1px solid var(--color-line2)',
                      background: 'var(--color-surface)',
                      borderRadius: 6,
                      padding: '18px 16px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: 22, fontWeight: 700 }}>
                      {restName ? `今天放假 · ${restName}` : '今天放假'}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
                      没有课，好好休息 —— 明天按课表上课
                    </div>
                  </div>
                ) : day.current ? (
                  <div
                    className="mt-2"
                    style={{
                      border: '1px solid var(--color-accent)',
                      background: 'var(--color-accentsoft)',
                      borderRadius: 6,
                      padding: '14px 16px',
                    }}
                  >
                    <div
                      className="flex items-center gap-2"
                      style={{ fontSize: 12, color: 'var(--color-accentink)' }}
                    >
                      <span
                        className="live-dot"
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 99,
                          background: 'var(--color-accent)',
                          display: 'inline-block',
                        }}
                      />
                      正在上课
                      <span className="flex-1" />
                      <span className="num">
                        {day.current.start}–{day.current.end}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 30,
                        fontWeight: 750,
                        letterSpacing: '-.01em',
                        marginTop: 10,
                        lineHeight: 1.15,
                        textAlign: 'center',
                      }}
                    >
                      {splitLessonTitle(day.current.title).subject}
                    </div>
                    {splitLessonTitle(day.current.title).teacher ? (
                      <div
                        style={{
                          fontSize: 16,
                          color: 'var(--color-ink2)',
                          marginTop: 6,
                          textAlign: 'center',
                        }}
                      >
                        {splitLessonTitle(day.current.title).teacher}
                      </div>
                    ) : null}
                  </div>
                ) : day.items.length === 0 ? (
                  <div
                    className="mt-2"
                    style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}
                  >
                    今天没有排课
                  </div>
                ) : (
                  <div className="mt-2">
                    {day.items.map((it) => {
                      const live = day.current?.id === it.id
                      const next = day.next?.id === it.id
                      const done = toMinutes(it.end) <= nowMin
                      return (
                        <div
                          key={it.id}
                          className="flex items-center gap-3 py-1.5"
                          style={{ opacity: done ? 0.42 : 1 }}
                        >
                          <span
                            className="num shrink-0"
                            style={{
                              width: 46,
                              fontSize: 13,
                              fontWeight: 700,
                              color: live || next ? 'var(--color-accent)' : 'var(--color-ink2)',
                            }}
                          >
                            {it.start}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate"
                            style={{ fontSize: 13.5, fontWeight: live ? 700 : 550 }}
                          >
                            {it.title}
                          </span>
                          {it.room ? (
                            <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                              {it.room}
                            </span>
                          ) : null}
                          {live ? (
                            <Tag tone="ok">上课中</Tag>
                          ) : next && day.minutesToNext !== null ? (
                            <Tag tone="accent">下一节 {awayText(day.minutesToNext)}</Tag>
                          ) : null}
                          {/* 🆕 今天这一节**被临时调过**（教务处换的课）—— 屏上要看得出来 */}
                          {adjustedIds.has(it.id) ? <Tag tone="warn">已调整</Tag> : null}
                        </div>
                      )
                    })}
                  </div>
                )}

                {schedErr ? (
                  <div style={{ fontSize: 11.5, color: 'var(--color-bad)', marginTop: 8, lineHeight: 1.6 }}>
                    {schedErr}
                  </div>
                ) : null}
              </Panel>

              {/* 🆕 每日作业（用户口径 ③⑥：**每天常驻**，按学科分组）。
                  🔴 这是"今天各科留了什么"的清单；下面那块「本次作业」（应交/已交/未交）
                     是**某一份作业档案**的收缴情况 —— 两件事，口径 ⑤ 把后者改成档案。
                  🔴 版式照抄上面那几块的 `.panel`，不新增区域样式；也**不加带 ▾ 的按钮**
                     （`app/scripts/clock-checks.mjs:423-436` 会数全页 ▾ 的个数）。 */}
              <section className="panel anim-in" data-classroom-homework>
                <div className="panel-head">
                  <h2>每日作业</h2>
                  <span className="flex-1" />
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                    {friendlyDate(todayIso)}
                    {todayHw.length ? ` · 共 ${todayHw.length} 条` : ''}
                  </span>
                </div>
                <div className="p-4">
                  {todayHw.length ? (
                    <div className="flex flex-col gap-3">
                      {hwGroups.map((g) => (
                        <div key={g.key} data-classroom-hw-subject={g.code || g.key}>
                          <div className="flex items-center gap-2">
                            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{g.label}</span>
                            {g.rep ? <Tag tone="idle">课代表</Tag> : null}
                          </div>
                          {g.items.map((h) => (
                            <div
                              key={h.id}
                              style={{
                                fontSize: 13,
                                color: 'var(--color-ink2)',
                                lineHeight: 1.75,
                                marginTop: 2,
                                wordBreak: 'break-word',
                              }}
                            >
                              {h.content}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--color-ink3)', lineHeight: 1.8 }}>
                      今天还没有人留作业。
                      {dl?.notice ? (
                        <>
                          <br />
                          {dl.notice}
                        </>
                      ) : null}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => setRepOpen(true)}>
                      课代表录一条
                    </Button>
                    <Button size="sm" disabled={!todayHw.length} onClick={() => void saveHomeworkImage()}>
                      存成图片
                    </Button>
                  </div>
                </div>
              </section>

              {collect ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>本次作业</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      {assignment ? friendlyDate(assignment.assignDate) : ''}
                    </span>
                  </div>
                  <div className="p-4 grid grid-cols-3 gap-3 text-center">
                    {[
                      { k: '应交', v: collect.total },
                      { k: '已交', v: collect.submitted, c: 'var(--color-ok)' },
                      {
                        k: '未交',
                        v: collect.missing,
                        c: collect.missing ? 'var(--color-bad)' : undefined,
                      },
                    ].map((x) => (
                      <div key={x.k}>
                        <div className="num" style={{ fontSize: 26, fontWeight: 700, color: x.c }}>
                          {x.v}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>{x.k}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {/* 🆕 P9：本班考试（**只读**）—— Q17 说走班班的屏"只看作业和考试"，
                  这是"考试"那一半。它是**纯读**：`exams` 上教室端零写策略（§15.3）。 */}
              {classExams.length ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>本班考试</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                      共 {classExams.length} 场
                    </span>
                  </div>
                  <div className="p-3">
                    {classExams.map((e) => (
                      <div key={e.id} className="flex items-center gap-2 py-1.5">
                        <span className="num shrink-0" style={{ width: 48, fontSize: 12.5, color: 'var(--color-ink2)' }}>
                          {e.examDate.slice(5).replace('-', '/')}
                        </span>
                        <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>
                          {e.subject || e.title}
                        </span>
                        <Tag tone={e.status === 'graded' ? 'ok' : 'idle'}>
                          {e.status === 'graded' ? '已定稿' : '批阅中'}
                        </Tag>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {/* 呼叫播报：走班班的屏**不接呼叫**（Q17），整块不摆 */}
              {streamMode ? null : (
              <Panel bodyClass="p-4">
                <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <IconMegaphone size={15} />
                  <span style={{ color: 'var(--color-ink2)' }}>呼叫播报已就绪</span>
                </div>
                <Button
                  size="sm"
                  block
                  className="mt-3"
                  onClick={() => {
                    unlockAudio()
                    setArmed(true)
                    chime()
                    window.setTimeout(
                      // 试播样例：地点写中性词，不要写死某一科（真实呼叫的地点是教师填的）
                      () => speak('请 12 号、37 号，到老师办公室。'),
                      SPEAK_AFTER_CHIME_MS,
                    )
                  }}
                >
                  试播一句
                </Button>
                <Button
                  size="sm"
                  block
                  className="mt-2"
                  variant={exam ? 'primary' : 'ghost'}
                  icon={exam ? <IconCheck size={15} /> : <IconBellOff size={15} />}
                  onClick={() => {
                    unlockAudio()
                    setExam((v) => !v)
                  }}
                >
                  {exam ? '结束考试' : '考试静音'}
                </Button>
              </Panel>
              )}

              {/* 考试模式：全屏黑底时钟，所有声音停掉 */}
              {exam ? (
                <div
                  className="fixed inset-0 z-[90] flex flex-col items-center justify-center"
                  style={{ background: '#000' }}
                >
                  <div
                    className="num"
                    style={{
                      fontSize: 'clamp(72px, 17vw, 190px)',
                      fontWeight: 200,
                      color: '#fff',
                      lineHeight: 1,
                      letterSpacing: '.02em',
                    }}
                  >
                    {String(now.getHours()).padStart(2, '0')}
                    <span style={{ opacity: 0.35 }}>:</span>
                    {String(now.getMinutes()).padStart(2, '0')}
                  </div>
                  <div
                    style={{
                      marginTop: 18,
                      fontSize: 14,
                      letterSpacing: '.24em',
                      color: 'rgb(255 255 255 / .42)',
                    }}
                  >
                    考试进行中 · 已静音
                  </div>
                  <button
                    type="button"
                    onClick={() => setExam(false)}
                    style={{
                      marginTop: 46,
                      fontSize: 13,
                      color: 'rgb(255 255 255 / .34)',
                      textDecoration: 'underline',
                    }}
                  >
                    结束考试
                  </button>
                </div>
              ) : null}

              {/* 自动备份到这台电脑上的一个文件夹 —— 云端之外的第二份保险
                  ⚠️ 走班班的屏不摆它：Q17 的口径是"只看作业与考试"，
                     而整份备份是行政班那块屏的活。 */}
              {streamMode ? null : (
              <Panel bodyClass="p-4">
                <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <IconCheck size={15} />
                  <span style={{ color: 'var(--color-ink2)' }}>自动备份到本机</span>
                  <span className="flex-1" />
                  {/* 🔴 exe 自带备份文件夹：**装上就写，不需要任何人授权**
                      ⇒ 不摆「设置文件夹」那个按钮（摆着它反而会让人以为要点一下才开） */}
                  {bkSupported && !bkDir ? (
                    <button
                      type="button"
                      disabled={bkBusy}
                      onClick={async () => {
                        setBkBusy(true)
                        try {
                          // 两种情况都在点击里处理 —— 浏览器只允许用户手势里要权限
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
                      ? /* 🔴 壳：显示**真绝对路径** —— 老师照着它去 U 盘拷走（施工单 §1.3）。
                           ⚠️ 拿不到路径（三处都写不进去）时不许假装有，如实说。 */
                        (bk
                          ? `上次备份：${new Date(bk).toLocaleString('zh-CN')} · 每 5 分钟写一份，存到：${bkDir}`
                          : `每 5 分钟写一份，存到：${bkDir}`)
                      : needsGrant
                        ? '点右上角「点一下恢复」继续自动备份'
                        : bk
                          ? `上次备份：${new Date(bk).toLocaleString('zh-CN')} · 每 5 分钟一次`
                          : '选一个文件夹（建议放在网盘同步目录里），之后每 5 分钟自动写一份备份。'}
                </div>
              </Panel>
              )}

              {/* 小窗同款面板：不支持置顶小窗时，这就是兜底 */}
              {cur && !closing ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>当前题目</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                      {pipOn ? '与小窗同步' : ''}
                    </span>
                  </div>
                  <div className="p-3">
                    <PipPanel
                      key={seq}
                      tone="inline"
                      seq={seq}
                      total={stats?.questions.length ?? 0}
                      rate={cur.rate}
                      band={cur.band}
                      wrongNos={cur.wrongNos}
                      nameOf={nameOf}
                      all={stats?.questions ?? []}
                      onPick={setSeq}
                      onPrev={() => setSeq((v) => Math.max(1, v - 1))}
                      onNext={() =>
                        setSeq((v) => Math.min(stats?.questions.length ?? 1, v + 1))
                      }
                    />
                  </div>
                </Panel>
              ) : null}
            </div>

            {/* 右列：逐题 */}
            <div className="flex flex-col gap-4">
              {closing ? (
                <Panel bodyClass="p-6">
                  <div className="flex flex-col items-center gap-3 text-center">
                    <span
                      className="grid place-items-center"
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: 99,
                        background: 'var(--color-oksoft)',
                        color: 'var(--color-ok)',
                      }}
                    >
                      <IconCheck size={24} strokeWidth={2.4} />
                    </span>
                    <div style={{ fontSize: 17, fontWeight: 650, lineHeight: 1.6 }}>{closing}</div>
                    <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                      明天 0:00 自动恢复显示作业情况
                    </div>
                  </div>
                </Panel>
              ) : !assignment || !stats ? (
                <Panel bodyClass="p-8 text-center">
                  <div style={{ fontSize: 15, fontWeight: 620 }}>本班还没有已批改的作业</div>
                  <div style={{ fontSize: 12, color: 'var(--color-ink4)', marginTop: 4 }}>
                    极简模式的档案没有逐题正确率。
                  </div>
                </Panel>
              ) : (
                <>
                  {/*
                   * 按日期筛选：一天可能不止一份作业，所以筛选的是"日期"而不是作业。
                   * 挂墙上的那块屏是**手指点的**，平铺一排小按钮又密又难点准 ——
                   * 改成只显示当前日期，点一下才展开列表（Sheet 整行都是可点区域）。
                   */}
                  {graded.length > 1 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setDatePickOpen(true)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 12px',
                          borderRadius: 4,
                          fontSize: 13.5,
                          border: '1px solid var(--color-accent)',
                          background: 'var(--color-accentsoft)',
                          color: 'var(--color-accentink)',
                          fontWeight: 650,
                        }}
                      >
                        <IconClock size={15} />
                        <span className="num">{assignment.assignDate.slice(5).replace('-', '/')}</span>
                        <span style={{ opacity: 0.65 }}>▾</span>
                      </button>
                      <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                        按日期选作业 · 共 {graded.length} 份
                      </span>
                    </div>
                  ) : null}

                  <Sheet
                    open={datePickOpen}
                    onClose={() => setDatePickOpen(false)}
                    title="选择日期"
                  >
                    <div className="flex flex-col">
                      {[...new Set(graded.map((a) => a.assignDate))]
                        .sort((x, y) => (x < y ? 1 : -1))
                        .slice(0, 30)
                        .map((d) => {
                          const on = assignment.assignDate === d
                          const n = graded.filter((a) => a.assignDate === d).length
                          const first = graded.find((a) => a.assignDate === d)
                          return (
                            <button
                              key={d}
                              type="button"
                              className="flex items-center gap-3 py-3.5"
                              style={{
                                borderBottom: '1px solid var(--color-line2)',
                                textAlign: 'left',
                                minHeight: 52,
                              }}
                              onClick={() => {
                                if (first) {
                                  setAssignmentId(first.id)
                                  setSeq(1)
                                }
                                setDatePickOpen(false)
                              }}
                            >
                              <span
                                className="num"
                                style={{ fontSize: 16, fontWeight: on ? 700 : 550 }}
                              >
                                {d.slice(5).replace('-', '/')}
                              </span>
                              <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                                {WEEKDAY_TEXT[weekdayOf(new Date(`${d}T12:00:00`)) - 1]}
                              </span>
                              <span className="flex-1" />
                              {n > 1 ? (
                                <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                                  {n} 份
                                </span>
                              ) : null}
                              {on ? <IconCheck size={16} /> : null}
                            </button>
                          )
                        })}
                    </div>
                  </Sheet>

                  <div className="flex flex-wrap items-center gap-3">
                    <select
                      className="input"
                      style={{ width: 'auto', height: 36, fontSize: 13.5 }}
                      value={assignment.id}
                      onChange={(e) => {
                        setAssignmentId(e.target.value)
                        setSeq(1)
                      }}
                    >
                      {graded.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                    <span className="flex-1" />
                    <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                      当前小窗显示：第 {seq} 题
                      {cur ? ` · 错误率 ${Math.round(cur.rate * 100)}%` : ''}
                    </span>
                    {pipOn ? <Tag tone="ok">小窗已开启</Tag> : null}
                  </div>

                  {/*
                   * 🆕 作业档案区（口径 ②⑤：按学科筛、默认当天的作业；**默认全收起**）。
                   *
                   * 🔴 上面那个带 ▾「按日期选作业」按钮、它的 Sheet、下面那个 `<select>`
                   *    必须**原样留着**（`clock-checks.mjs:423-436` 数全页 ▾ 的个数、
                   *    `:1421-1425` 数 select 的 options）。筛选用的是**小圆片按钮**，
                   *    不是再摆一个 `<select>`。
                   * 点开一条 = 选中这份档案 + 展开下面的「逐题正确率」（那块面板一字没改）。
                   */}
                  <div className="flex flex-wrap items-center gap-2" data-hw-filters>
                    <button
                      type="button"
                      data-hw-subject=""
                      data-on={hwSubject === '' ? '1' : '0'}
                      onClick={() => setHwSubject('')}
                      style={chipStyle(hwSubject === '')}
                    >
                      全部
                    </button>
                    {hwSubjects.map((s) => (
                      <button
                        key={s.code || 'other'}
                        type="button"
                        data-hw-subject={s.code || 'other'}
                        data-on={hwSubject === s.code ? '1' : '0'}
                        onClick={() => setHwSubject(s.code)}
                        style={chipStyle(hwSubject === s.code)}
                      >
                        {s.label}
                      </button>
                    ))}
                    <span className="flex-1" />
                    {([
                      ['today', '今天'],
                      ['yesterday', '昨天'],
                      ['all', '全部'],
                    ] as const).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        data-hw-date={k}
                        data-on={hwDate === k ? '1' : '0'}
                        onClick={() => setHwDate(k)}
                        style={chipStyle(hwDate === k)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-col gap-2" data-hw-archive>
                    {hwRows.length ? (
                      hwRows.map((a) => {
                        const cs = collectStats(students, a)
                        const on = a.id === assignmentId && hwOpen
                        return (
                          <button
                            key={a.id}
                            type="button"
                            data-hw-card={a.id}
                            data-on={on ? '1' : '0'}
                            onClick={() => {
                              setAssignmentId(a.id)
                              setSeq(1)
                              setHwOpen(!on)
                            }}
                            className="flex flex-wrap items-center gap-3 text-left"
                            style={{
                              padding: '10px 12px',
                              borderRadius: 6,
                              border: '1px solid var(--color-line2)',
                              background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                            }}
                          >
                            <span
                              className="min-w-0 flex-1 truncate"
                              style={{ fontSize: 13.5, fontWeight: 650 }}
                            >
                              {a.title}
                            </span>
                            <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                              {subjectName(subjectCodeOf(a), a.subject)}
                            </span>
                            <span className="num" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                              {a.assignDate.slice(5).replace('-', '/')}
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: cs.missing ? 'var(--color-bad)' : 'var(--color-ink3)',
                              }}
                            >
                              已交 <b className="num">{cs.submitted}</b>/{cs.total}
                            </span>
                            <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>
                              {on ? '收起' : '展开'}
                            </span>
                          </button>
                        )
                      })
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--color-ink4)', lineHeight: 1.8 }}>
                        {hwDate === 'today'
                          ? '今天还没有已批改的作业档案。'
                          : '这一档、这一科都没有已批改的档案。'}
                        {hwDate !== 'all' || hwSubject ? (
                          <button
                            type="button"
                            data-hw-all="1"
                            onClick={() => {
                              setHwDate('all')
                              setHwSubject('')
                            }}
                            style={{ ...chipStyle(false), marginLeft: 8 }}
                          >
                            看全部
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {hwOpen && cur ? (
                  <Panel className="overflow-hidden">
                    <div className="panel-head">
                      <h2>逐题正确率 · 点一行切换小窗</h2>
                      <span className="flex-1" />
                      <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                        共 {stats.questions.length} 题
                      </span>
                    </div>
                    <div>
                      {stats.questions.map((q) => {
                        const meta = BAND_META[q.band]
                        const on = q.seq === seq
                        return (
                          <button
                            key={q.seq}
                            type="button"
                            onClick={() => setSeq(q.seq)}
                            className="row"
                            style={{
                              padding: '13px 16px',
                              gap: 14,
                              background: on ? 'var(--color-accentsoft)' : undefined,
                              borderLeft: `3px solid ${on ? 'var(--color-accent)' : 'transparent'}`,
                            }}
                          >
                            <span
                              className="num grid place-items-center shrink-0"
                              style={{
                                width: 38,
                                height: 38,
                                border: '1px solid var(--color-line2)',
                                borderRadius: 4,
                                background: 'var(--color-surface)',
                                fontSize: 16,
                                fontWeight: 700,
                              }}
                            >
                              {q.seq}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-baseline gap-3">
                                <span
                                  className="num"
                                  style={{
                                    fontSize: 22,
                                    fontWeight: 700,
                                    color: q.wrongCount ? meta.color : 'var(--color-ink4)',
                                    minWidth: 66,
                                  }}
                                >
                                  {Math.round(q.rate * 100)}%
                                </span>
                                <span style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                                  <b className="num">{q.wrongCount}</b> 人错
                                </span>
                                <span className="flex-1" />
                                {q.wrongCount > 0 ? (
                                  <Tag tone={meta.tone}>{meta.label}</Tag>
                                ) : (
                                  <Tag tone="ok">全对</Tag>
                                )}
                              </span>
                              <span
                                className="mt-2 block"
                                style={{
                                  height: 6,
                                  background: 'var(--color-surface3)',
                                  borderRadius: 3,
                                  overflow: 'hidden',
                                }}
                              >
                                <i
                                  style={{
                                    display: 'block',
                                    height: '100%',
                                    width: `${Math.max(2, q.rate * 100)}%`,
                                    background: meta.color,
                                  }}
                                />
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </Panel>
                  ) : null}

                  {/* 老师传来的文件：走班班的屏**不摆**（Q17：它只看作业与考试）。
                      ⚠️ 读那一半**一个字没改**（"读得宽"）—— 只是这块屏不显示。 */}
                  {streamMode ? null : (
                  <>
                  <Sect>老师传来的文件</Sect>
                  <Panel className="overflow-hidden">
                    {pulling ? (
                      <div
                        className="px-3 py-2.5"
                        style={{
                          fontSize: 12.5,
                          color: 'var(--color-accenttext)',
                          borderBottom: '1px solid var(--color-line)',
                        }}
                      >
                        正在取回「{pulling}」…
                      </div>
                    ) : null}

                    {/*
                      ⚠️ 读不到列表时**必须说出来**：这块屏挂在墙上没人盯，
                      显示成"还没有文件"会被当成"老师没传"（而不是"这台机器读不到"）。
                      这条以前是 `catch { return }`，一个字都不显示。
                    */}
                    {filesErr ? (
                      <div
                        className="px-3 py-2.5"
                        style={{
                          fontSize: 12,
                          color: 'var(--color-badink)',
                          background: 'var(--color-badsoft)',
                          borderBottom: '1px solid var(--color-badline)',
                          lineHeight: 1.7,
                        }}
                      >
                        读不到文件列表：{filesErr}
                        <br />
                        每隔一分钟会自动重试一次。
                      </div>
                    ) : null}

                    {localFiles.length === 0 && cloudFiles.length === 0 ? (
                      <div className="px-3 py-4" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                        {filesErr ? (
                          '(列表读不到，不代表没人传)'
                        ) : (
                          <>
                            这个班还没有文件
                          </>
                        )}
                      </div>
                    ) : (
                      <>
                        {cloudFiles.map((f) => (
                          <div
                            key={f.id}
                            className="flex items-center gap-3 px-3 py-2.5"
                            style={{ borderBottom: '1px solid var(--color-line)' }}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>
                                {f.name}
                              </span>
                              <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                                <Tag tone="warn">待取回</Tag>{' '}
                                <span className="num">{humanSize(f.size)}</span>
                              </span>
                            </span>
                          </div>
                        ))}
                        {localFiles.map((f, i) => {
                          const k = kindOf(f.name, f.mime)
                          const viewable = canViewInline(k)
                          return (
                            <div
                              key={f.id}
                              className="flex items-center gap-3 px-3 py-2.5"
                              style={{
                                borderBottom:
                                  i === localFiles.length - 1
                                    ? undefined
                                    : '1px solid var(--color-line)',
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <span
                                  className="block truncate"
                                  style={{ fontSize: 13.5, fontWeight: 550 }}
                                >
                                  {f.name}
                                </span>
                                <span style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                                  <Tag tone={viewable ? 'accent' : 'idle'}>{KIND_TEXT[k]}</Tag>{' '}
                                  <span className="num">{humanSize(f.size || f.blob.size)}</span>
                                </span>
                              </span>
                              <Button
                                size="sm"
                                variant={viewable ? 'primary' : 'ghost'}
                                icon={
                                  viewable ? <IconEye size={15} /> : <IconDownload size={15} />
                                }
                                onClick={() => {
                                  /* 🔴 2026-10-03：`openLocal` 现在**返回结局**了。
                                     壳里"系统没有能打开这个类型的程序"是**真会发生的**
                                     （教室端那台机器上尤其容易遇到）——
                                     而这一支原先把返回值 `void` 掉了，
                                     结果是**点了没反应、界面也不说为什么**。
                                     失败时顺带给一句"要不要改存下来"，那是唯一出路。 */
                                  if (!viewable) {
                                    void saveToDisk(f)
                                    return
                                  }
                                  void openLocal(f).then((r) => {
                                    if (r === 'opened') return
                                    push({
                                      text: '这台机器打不开它',
                                      tone: 'bad',
                                      desc: '系统里没有能打开这个文件的程序。要不改成另存为，放到电脑上再看？',
                                    })
                                  })
                                }}
                              >
                                {viewable ? '打开' : '下载'}
                              </Button>
                            </div>
                          )
                        })}
                      </>
                    )}
                  </Panel>
                  <p
                    style={{
                      fontSize: 11.5,
                      color: 'var(--color-ink3)',
                      marginTop: 8,
                      lineHeight: 1.7,
                    }}
                  >
                    取回的文件已存在这台电脑上，断网也能打开。
                    {localFiles.length ? (
                      <>
                        {' '}
                        本机共 <span className="num">{localFiles.length}</span> 个 ·{' '}
                        <span className="num">
                          {humanSize(localFiles.reduce((n, f) => n + (f.size || f.blob.size), 0))}
                        </span>
                        <button
                          type="button"
                          style={{ marginLeft: 8, color: 'var(--color-bad)', textDecoration: 'underline' }}
                          onClick={async () => {
                            await clearFiles()
                            await refreshLocal()
                          }}
                        >
                          全部清理
                        </button>
                      </>
                    ) : null}
                  </p>
                  </>
                  )}

                  <Sect>小窗操作</Sect>
                  <Panel bodyClass="p-4">
                    <ul
                      style={{
                        fontSize: 12.5,
                        color: 'var(--color-ink2)',
                        lineHeight: 2,
                        paddingLeft: 18,
                        listStyle: 'disc',
                      }}
                    >
                      <li>
                        小窗里的 <b>◀ ▶</b> 切题；小窗获得焦点时也可用键盘方向键
                      </li>
                      <li>
                        点<b>名单</b>才展开错误学生姓名，再点一次立即收起 —— 讲评到敏感处可随手隐藏
                      </li>
                      <li>小窗可以随意拖动、缩放，位置会被浏览器记住</li>
                    </ul>
                  </Panel>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 置顶小窗内容
          注意：没数据时也必须渲染 —— 否则小窗会是一个纯白窗口，教师以为坏了 */}
      {pipWin
        ? createPortal(
            cur ? (
              <PipPanel
                key={seq}
                seq={seq}
                total={stats?.questions.length ?? 0}
                rate={cur.rate}
                band={cur.band}
                wrongNos={cur.wrongNos}
                nameOf={nameOf}
                all={stats?.questions ?? []}
                onPick={setSeq}
                onPrev={() => setSeq((v) => Math.max(1, v - 1))}
                onNext={() => setSeq((v) => Math.min(stats?.questions.length ?? 1, v + 1))}
              />
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '12px 16px',
                  textAlign: 'center',
                  font: '13px/1.7 system-ui, -apple-system, "Microsoft YaHei", sans-serif',
                  /* ⚠️ 这块 DOM 渲染进的是**另一个文档**（Document PiP 的系统置顶窗口），
                     那边**没有主文档的 CSS 自定义属性** → 令牌取不到，只能靠 `,` 后面的兜底色。
                     所以这里的三处 `#333 / #fff / #777` **不是漏改**：它们是那个窗口的**唯一**颜色来源。 */
                  color: 'var(--color-ink2, #333)',
                  background: 'var(--color-surface, #fff)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>还没有可讲评的作业</div>
                <div style={{ fontSize: 12, color: 'var(--color-ink3, #777)' }}>
                  {klass?.name ?? ''} 还没有批改完的作业。
                </div>
              </div>
            ),
            pipWin.document.body,
          )
        : null}

      {/* 播报浮层 —— 静音期间不显示（考试本来就是黑屏，静音时段不该打扰），
          队列留着不动，等静音结束再接着播 */}
      {broadcast && !silenced ? (
        <div
          className="anim-in fixed inset-0 z-[70] flex flex-col items-center justify-center px-10"
          style={{ background: 'rgb(10 14 20 / .95)' }}
        >
          <div
            className="flex items-center gap-2.5"
            style={{ color: 'rgb(255 255 255 / .55)', fontSize: 14, letterSpacing: '.14em' }}
          >
            <span
              className="live-dot"
              style={{
                width: 9,
                height: 9,
                borderRadius: 99,
                background: '#4ade9a',
                display: 'inline-block',
              }}
            />
            正在播报
          </div>
          <div
            style={{
              color: '#fff',
              fontSize: 46,
              fontWeight: 700,
              lineHeight: 1.5,
              textAlign: 'center',
              marginTop: 26,
              maxWidth: 1200,
            }}
          >
            {broadcast.text}
          </div>

          {/* 还有别的老师在叫 —— 让他们知道自己的呼叫没被顶掉，只是排在后面 */}
          {queue.length > 1 ? (
            <div
              style={{
                marginTop: 18,
                fontSize: 14,
                color: 'rgb(255 255 255 / .5)',
                letterSpacing: '.06em',
              }}
            >
              后面还有 <b className="num">{queue.length - 1}</b> 条呼叫在排队，会依次播报
            </div>
          ) : null}

          <div className="mt-10 flex gap-3">
            <Button
              onClick={() => {
                // 重播队首：走队列那套（响铃 → 开口 → 重新计兜底时间），
                // 不能再自己 speak，否则兜底定时器会在重播到一半时把这条切掉
                playHeadRef.current()
              }}
            >
              再播一遍
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                /* 只出队这一条 —— 后面排着的照常播。
                   双击会连出队两条：第二条被切掉时 playedRef 已经打了标，
                   轮询不会再送来，那条呼叫就永远不响了。所以一秒内只认一次。 */
                const at = Date.now()
                if (at - closeAtRef.current < CLOSE_GUARD_MS) return
                closeAtRef.current = at
                stopSpeaking()
                mutateQueue((q) => q.slice(1))
              }}
            >
              关闭
            </Button>
          </div>
        </div>
      ) : null}

      {/*
       * 🆕 课间值日提醒（口径 ①）。
       * 🔴 用户 2026-10-02 纠正过一次口径：**不是放学**，是**每节课下课**要有人擦黑板。
       * 时机判据只用课表本身（`breakReminder`）：上一节下课、下一节没开始 ⇒ 现在就是课间。
       * 它是**右下角一枚圆角浮标**，不弹窗、不遮内容，下一节上课自动收起（没有"知道了"按钮）。
       * 放假 / 今天没课 / 没有值日生 ⇒ 整枚不摆，平时这块屏与以前一模一样。
       */}
      {breakReminder && dutyTodayRes ? (
        <div
          data-classroom-duty-tip
          style={{
            position: 'fixed',
            right: 18,
            bottom: 18,
            zIndex: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '11px 16px',
            borderRadius: 999,
            background: 'var(--color-accent)',
            color: 'var(--color-onaccent)',
            boxShadow: 'var(--lift-2)',
            fontSize: 14,
            lineHeight: 1.5,
            maxWidth: '72vw',
          }}
        >
          <span style={{ fontSize: 12.5, opacity: 0.85 }}>值日</span>
          <span>
            下课了，值日生·<b>{dutyTodayRes.name}</b> 不要忘记擦黑板
          </span>
        </div>
      ) : null}

      {/* 🆕 课代表录作业（口径 ⑦ + 追问 5「屏上入口 + 班级口令」） */}
      <RepHomeworkSheet
        open={repOpen}
        onClose={() => setRepOpen(false)}
        classId={klass.id}
        className={klassName}
        onSaved={reloadDaily}
      />
    </Shell>
  )
}

/* 教室端不套教师端的应用壳 */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-[1] mx-auto min-h-full w-full">{children}</div>
}

/**
 * 每日名言（教室大屏给学生看的那一句）。
 *
 * ⚠️ **日期口径 `beijingNow()`**（§一 时间口径）：这块屏在别的时区也不会串天。
 * ⚠️ 它是**自己一个 Panel**，不插进"这个班的课"那块里 —— 课表与呼叫是这块屏的核心，
 *    名言只占它自己那一格，不挤掉它们。
 * `data-daily-quote` 是给 `shots.mjs` 断言"当天固定"用的钩子（刷新两次必须同一句）。
 */
function DailyQuote() {
  const q = pickDailyQuote(beijingNow())
  return (
    <section className="panel anim-in" data-daily-quote>
      <div className="px-4 py-3.5">
        <div
          style={{
            fontSize: 'clamp(19px, 1.7vw, 27px)',
            fontWeight: 620,
            lineHeight: 1.55,
            letterSpacing: '.01em',
            textAlign: 'center',
          }}
        >
          {q.text}
        </div>
        <div
          style={{
            marginTop: 7,
            fontSize: 13,
            color: 'var(--color-ink3)',
            textAlign: 'center',
          }}
        >
          —— {q.from}
        </div>
      </div>
    </section>
  )
}

/**
 * 「数据没能存到服务器」提示。
 *
 * 这条以前只有教师端 AppShell 有 —— 可教室端是**挂在墙上的一块屏**：
 * 断网、会话过期、写库被拒的时候，屏上照旧显示着一切正常，
 * 教室里没人会去教师端核对，等发现时这节课的记录已经没了。
 * 这里的样式与教师端那条一致（同一句话、同样的 warnsoft 底）。
 */
function SyncBanner() {
  const syncError = useStore((s) => s.syncError)
  const clearSyncError = useStore((s) => s.clearSyncError)
  if (!syncError) return null
  return (
    <button
      type="button"
      onClick={clearSyncError}
      className="anim-in mb-4 flex w-full items-start gap-2.5 p-3.5 text-left"
      style={{
        background: 'var(--color-warnsoft)',
        border: '1px solid var(--color-warnline)',
        borderRadius: 6,
      }}
    >
      <span style={{ color: 'var(--color-warn)', marginTop: 1, flexShrink: 0 }}>
        <IconAlert size={17} />
      </span>
      <span style={{ flex: 1 }}>
        <span
          style={{ display: 'block', fontSize: 13.5, fontWeight: 620, color: 'var(--color-warnink)' }}
        >
          数据没能存到服务器
        </span>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--color-warnink2)',
            marginTop: 3,
            lineHeight: 1.7,
          }}
        >
          {syncError} · 本地已保留，网络好了再操作一次
        </span>
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--color-warnink2)', flexShrink: 0 }}>知道了</span>
    </button>
  )
}

/** 未登录 / 同步中 / 没有班级这三种整屏状态下也要能看见同步失败（没错时不占位置） */
function SyncWrap() {
  const syncError = useStore((s) => s.syncError)
  if (!syncError) return null
  return (
    <div className="mx-auto w-full px-5 pt-4" style={{ maxWidth: 1360 }}>
      <SyncBanner />
    </div>
  )
}

/**
 * 🆕 课代表在教室端录一条作业（口径 ⑦ + 追问 5「屏上入口 + 班级口令」）。
 *
 * 这块屏平时是**只读**的，这是唯一的写入口 —— 所以规则写在明面上：
 *   · 只能录**今天**（数据库那边也写死 `beijing_today()`，这里不给人挑日期）；
 *   · 只能录**这台机器所属的那个班**（RPC 按 `classroom_accounts` 判）；
 *   · 只能录**自己那一科**（`class_subjects` 的任教关系）；
 *   · 口令由班主任在教师端设。`class_rep_pins` 那张表**不给客户端任何表权限**，
 *     比对发生在 `security definer` 函数里 —— 这里只把 `reason` 翻成人话。
 * 🔴 本地演示模式没有权限层，照常能录（与 `canManageSchedule()` 回 `'local'` 同一口径）。
 */
function RepHomeworkSheet({
  open,
  onClose,
  classId,
  className,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  classId: string
  className: string
  onSaved: () => void | Promise<void>
}) {
  const push = useToast((s) => s.push)
  const [subject, setSubject] = useState<string>('chinese')
  const [content, setContent] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    /* 老师那一条路直接写表（能不能写由 RLS 判）；课代表这一条**必须**走 RPC + 口令 */
    const r = await repSetDailyHomework({
      classId,
      subject: subjectName(subject),
      subjectCode: subject,
      content,
      pin,
    })
    setBusy(false)
    if (!r.ok) {
      push({ text: r.message, tone: 'bad' })
      return
    }
    push({ text: '已录进今天的每日作业', tone: 'ok' })
    setContent('')
    setPin('')
    onClose()
    await onSaved()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`课代表录作业 · ${className}`}
      footer={
        <Button variant="primary" block disabled={busy} onClick={() => void save()}>
          {busy ? '在写…' : '写进今天的作业'}
        </Button>
      }
    >
      <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', lineHeight: 1.75, marginBottom: 10 }}>
        只能录<b>今天</b>、只能录<b>自己那一科</b>。口令问班主任要。
      </p>
      <div className="flex flex-wrap gap-2" data-rep-subjects>
        {SUBJECTS.map((s) => (
          <button
            key={s.code}
            type="button"
            data-rep-subject={s.code}
            data-on={subject === s.code ? '1' : '0'}
            onClick={() => setSubject(s.code)}
            style={chipStyle(subject === s.code)}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', margin: '12px 0 6px' }}>
        作业内容
      </div>
      <textarea
        className="input"
        rows={4}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="例：背《琵琶行》全文，明天早读抽查。"
      />
      <div style={{ fontSize: 11.5, color: 'var(--color-ink3)', margin: '12px 0 6px' }}>
        班级口令
      </div>
      <input
        className="input"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        placeholder="问班主任要的 4–12 位口令"
      />
    </Sheet>
  )
}

/**
 * 筛选用的小圆片。
 * 🔴 它是 `<button>`，**不是 `<select>`** —— 教室端 `select` 的判据见
 *    `app/scripts/shots.mjs:1900-1905` 与 `app/scripts/clock-checks.mjs:1421-1425`。
 */
function chipStyle(on: boolean): React.CSSProperties {
  return {
    padding: '5px 11px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: on ? 650 : 500,
    border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
    background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
    color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
  }
}
