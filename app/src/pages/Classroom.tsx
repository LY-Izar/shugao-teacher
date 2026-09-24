import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Logo,
} from '../components/icons'
import { Button, Panel, Sect, Sheet, Tag } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { collectStats } from '../lib/assignments'
import { BAND_META, gradeStats } from '../lib/grading'
import { closePip, openPip, pipSupported } from '../lib/pip'
import { HEARTBEAT_MS, emit, subscribe } from '../lib/realtime'
import { isRemote } from '../lib/supabase'
import { setDeviceRole } from '../lib/session'
import * as remote from '../data/remote'
import {
  fsSupported,
  loadHandle,
  makeBackup,
  pickFolder,
  writableFolder,
  writeToFolder,
} from '../lib/backup'

/** 备份文件名：固定名字，每次覆盖 —— 免得一天攒几十个文件 */
const BACKUP_NAME = '树高备份.json'
import { awayText, dayState, maybeShift, toMinutes, weekdayOf } from '../lib/schedule'
import { dayKind, nextHoliday, ymdOf } from '../lib/holiday'
import { parseScheduleText, type ParsedScheduleItem } from '../lib/scheduleParse'
import { preparePhoto } from '../lib/photo'
import { recognize } from '../lib/ocr'
import { WEEKDAY_TEXT } from '../data/types'
import {
  KIND_TEXT,
  canViewInline,
  deleteFile,
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
import { chime, setExamMuted, softChime, speak, stopSpeaking, unlockAudio } from '../lib/tts'
import { friendlyDate } from '../lib/date'
import type { CallRecord } from '../data/types'

const CLASS_KEY = 'shugao.classroom.classId'

export default function Classroom() {
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const classrooms = useStore((s) => s.classrooms)
  const setClassroomOnline = useStore((s) => s.setClassroomOnline)
  const ensureClassroom = useStore((s) => s.ensureClassroom)
  const hydrated = useStore((s) => s.hydrated)
  const teacher = useStore((s) => s.teacher)
  const navigate = useNavigate()

  const [classId, setClassId] = useState(() => {
    try {
      return localStorage.getItem(CLASS_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const klass = classes.find((c) => c.id === classId) ?? classes[0]
  const client = classrooms.find((c) => c.classId === klass?.id)

  const graded = useMemo(
    () =>
      assignments
        .filter(
          (a) => a.classId === klass?.id && (a.status === 'graded' || a.status === 'reviewed'),
        )
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
  const [broadcast, setBroadcast] = useState<CallRecord | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [armed, setArmed] = useState(false)
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

  /* 时钟 */
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])

  /* 教室端自我登记：后端模式没有种子数据，第一次打开时要把这台设备建出来 */
  useEffect(() => {
    if (!klass) return
    ensureClassroom(klass.id, '一体机')
  }, [klass?.id, ensureClassroom]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 教师传来的文件：拉到本机就立刻从云端删掉，云端只做中转 */
  const [cloudFiles, setCloudFiles] = useState<SharedFile[]>([])
  const [localFiles, setLocalFiles] = useState<LocalFile[]>([])
  const [pulling, setPulling] = useState('')

  const refreshLocal = useCallback(async () => {
    try {
      setLocalFiles(await allFiles())
    } catch {
      /* 本机库不可用时不影响上课 */
    }
  }, [])

  useEffect(() => {
    if (!isRemote) return
    let alive = true

    const pull = async () => {
      let pending: SharedFile[] = []
      try {
        pending = (await listFiles()).filter((f) => !f.classId || f.classId === klass?.id)
      } catch {
        return
      }
      if (!alive) return
      setCloudFiles(pending)

      const have = new Set((await allFiles()).map((f) => f.id))
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
          // 已经落到本机硬盘上了，云端这份就没必要留着
          await deleteFile(f).catch(() => {})
        }
        setPulling('')
      }
      if (alive) {
        setCloudFiles((await listFiles().catch(() => [])) as SharedFile[])
        await refreshLocal()
      }
    }

    void pull()
    const t = window.setInterval(() => void pull(), 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [klass?.id, refreshLocal])

  /* 今天的课表 —— 教师端维护，这里只读；也支持现场拍一张课表自动识别 */
  const schedule = useStore((s) => s.schedule)
  const addScheduleMany = useStore((s) => s.addScheduleMany)
  const schedRef = useRef<HTMLInputElement>(null)
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedErr, setSchedErr] = useState('')
  /** 照片识别结果，等教师核对/改完时间再入库 */
  const [schedReview, setSchedReview] = useState<ParsedScheduleItem[] | null>(null)
  /** 粘贴课表 —— 学校发的电子表直接贴进来，比拍照准得多（也不会漏掉没写时间的节次） */
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')

  /* ---- 自动备份到本机文件夹（C4）----
     云端之外的第二份保险。注意浏览器**不允许静默写文件夹**：
     首次授权时勾「允许每次访问时编辑」后，同一会话内可全自动；
     浏览器重启后权限退回 prompt，必须由用户点一下 —— 所以状态要显示出来。 */
  const bkSupported = fsSupported()
  const [bk, setBk] = useState<number | null>(null)
  const [bkBusy, setBkBusy] = useState(false)
  const [needsGrant, setNeedsGrant] = useState(false)

  useEffect(() => {
    if (!bkSupported) return
    let alive = true
    const tick = async () => {
      // 这里**只查询、不申请** —— requestPermission 必须由用户手势触发
      const dir = await loadHandle()
      if (!alive) return
      if (!dir) return
      const q = await dir.queryPermission?.({ mode: 'readwrite' })
      if (q !== 'granted') {
        setNeedsGrant(true)
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
  }, [bkSupported])

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

  const dayItems = useMemo(() => {
    const raw = schedule.filter(
      (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === useWeekday,
    )
    // 朝会只在真正的周一早上，所以顺延看的是「今天是不是周一」，
    // 而不是「借用了哪一天的课表」—— 调休借周一的课不代表今天要顺延。
    return maybeShift(raw, weekdayOf(now))
  }, [schedule, klass?.id, useWeekday, now])

  const day = useMemo(() => dayState(dayItems.items, now), [dayItems.items, now])
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
        setSchedErr('没从这张图里认出课表。拍正一点、光线均匀些再试，或在教师端「我的课表」里录入。')
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
   * 下课铃：下一节课**开始前 5 分钟**响一声很轻的「叮」。
   * 用 rungRef 记住已经响过的 `日期-课id`，避免在同一分钟内重复响。
   */
  const rungRef = useRef('')
  useEffect(() => {
    const tick = () => {
      const n = new Date()
      const m = n.getHours() * 60 + n.getMinutes()
      const day = maybeShift(
        schedule.filter(
          (s) => s.scope === 'class' && s.classId === klass?.id && s.weekday === weekdayOf(n),
        ),
        weekdayOf(n),
      ).items
      for (const it of day) {
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
  }, [schedule, klass?.id])

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
  const playedRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)
  /** 同一个 call 重复播报时 sentAt 会追加，所以用「id + 最后一次时间」当键 */
  const callKey = (c: CallRecord) => `${c.id}:${Math.max(0, ...(c.sentAt ?? []))}`

  useEffect(() => {
    if (!klass) return
    const play = (c: CallRecord) => {
      const k = callKey(c)
      if (playedRef.current.has(k)) return
      playedRef.current.add(k)
      setBroadcast(c)
      chime()
      window.setTimeout(() => speak(c.text), 680)
      window.setTimeout(() => setBroadcast(null), 15000)
    }

    const off = subscribe((m) => {
      if (m.type !== 'call') return
      if (m.call.classId !== klass.id) return
      play(m.call)
    })

    let alive = true
    const tick = async () => {
      const list = await remote.loadRecentCalls(klass.id, Date.now() - 15 * 60_000)
      if (!alive) return
      if (!seededRef.current) {
        // 第一次只把"已经存在的"记下来，不播 —— 免得刚打开就把几分钟前的旧呼叫播一遍
        for (const c of list) playedRef.current.add(callKey(c))
        seededRef.current = true
        return
      }
      for (const c of list) play(c)
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
   */
  useEffect(() => {
    setDeviceRole('classroom')
  }, [])

  const startPip = async () => {
    unlockAudio()
    setArmed(true)
    const w = await openPip()
    if (!w) {
      push({
        text: '当前浏览器不支持置顶小窗',
        tone: 'warn',
        desc: '需要 Edge / Chrome 116 及以上版本',
      })
      return
    }
    w.addEventListener('pagehide', () => setPipWin(null))
    setPipWin(w)
  }

  const nameOf = useCallback(
    (no: string) => students.find((s) => s.studentNo === no)?.name ?? '',
    [students],
  )

  const cur = stats?.questions[seq - 1]
  const pad = (n: number) => String(n).padStart(2, '0')

  /* ---------- 后端模式下教室端需要一次登录 ---------- */
  if (isRemote && !hydrated) {
    return (
      <Shell>
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 15, fontWeight: 640 }}>正在同步数据…</div>
        </Panel>
      </Shell>
    )
  }
  if (isRemote && !teacher) {
    return (
      <Shell>
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
        <Panel bodyClass="p-8 text-center" className="anim-in">
          <div style={{ fontSize: 16, fontWeight: 640 }}>还没有班级数据</div>
          <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
            先在教师端建立班级并录入学生名单，教室端会自动读到。
          </div>
        </Panel>
      </Shell>
    )
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
                onClick={() => {
                  const rows = schedReview.filter(
                    (r) => r.title.trim() && toMinutes(r.end) > toMinutes(r.start),
                  )
                  if (!rows.length) {
                    push({ text: '没有可导入的课', tone: 'warn' })
                    return
                  }
                  addScheduleMany(
                    rows.map((it) => ({
                      weekday: it.weekday,
                      start: it.start,
                      end: it.end,
                      title: it.title.trim(),
                      room: it.room,
                      classId: it.classId,
                      kind: it.kind,
                      notify: it.notify,
                      scope: 'class' as const,
                    })),
                  )
                  setSchedReview(null)
                  push({ text: `已导入 ${rows.length} 条课`, tone: 'ok' })
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
        <textarea
          className="input"
          rows={11}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={'一行一条，例如：\n周一 08:00-08:40 英语\n周一 08:50-09:30 语文\n周三 10:50-11:30 化学'}
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
                setSchedErr('没解析出课程。按「周一 08:00-08:40 英语」一行一条写最稳。')
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
            <span style={{ color: 'var(--color-accent)', display: 'grid', placeItems: 'center' }}>
              <Logo size={22} />
            </span>
            <span style={{ fontSize: 15.5, fontWeight: 650 }}>树高教师平台</span>
            <Tag tone="accent">教室端</Tag>
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

          {pipWin ? (
            <Button
              size="sm"
              icon={<IconCheck size={14} />}
              onClick={() => {
                closePip()
                setPipWin(null)
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
          {/* 小窗不可用提示 */}
          {!pipSupported() ? (
            <div
              className="mb-4 flex items-start gap-2.5 p-3.5"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={17} />
              </span>
              <div style={{ fontSize: 13, color: '***REMOVED***8a5a12', lineHeight: 1.7 }}>
                当前浏览器不支持<b>强制置顶小窗</b>（需要 Edge / Chrome 116 及以上）。
                下面的「当前题目」面板仍然可用，但它会被全屏的新教育平台盖住 ——
                讲评时请用手机或平板看题号与正确率。
              </div>
            </div>
          ) : !armed ? (
            <div
              className="mb-4 flex flex-wrap items-center gap-3 p-3.5"
              style={{
                background: 'var(--color-accentsoft)',
                border: '1px solid ***REMOVED***c3d6fb',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-accent)' }}>
                <IconInfo size={17} />
              </span>
              <div className="flex-1" style={{ fontSize: 13, color: '***REMOVED***0d3f9e', lineHeight: 1.7 }}>
                点一次「启动置顶小窗」即可：它会浮在全屏的新教育平台之上，显示当前题号与正确率。
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
              <Panel className="anim-in overflow-hidden">
                <div className="p-5 text-center">
                  <div
                    className="num"
                    style={{ fontSize: 62, fontWeight: 650, letterSpacing: '-.05em', lineHeight: 1 }}
                  >
                    {pad(now.getHours())}:{pad(now.getMinutes())}
                    <span style={{ fontSize: 24, color: 'var(--color-ink4)', marginLeft: 4 }}>
                      {pad(now.getSeconds())}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 8 }}>
                    {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · 周
                    {'日一二三四五六'[now.getDay()]} · {klass.name}
                  </div>
                </div>
              </Panel>

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
                  <button
                    type="button"
                    onClick={() => {
                      setPasteText('')
                      setPasteOpen(true)
                    }}
                    style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
                  >
                    粘贴课表
                  </button>
                  <button
                    type="button"
                    disabled={schedBusy}
                    onClick={() => schedRef.current?.click()}
                    style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
                  >
                    {schedBusy ? '识别中…' : '拍课表'}
                  </button>
                </div>

                {isMakeup ? (
                  <div
                    className="mb-2 flex flex-wrap items-center gap-1.5 p-2"
                    style={{
                      background: 'var(--color-warnsoft)',
                      border: '1px solid ***REMOVED***ecd9ae',
                      borderRadius: 4,
                      fontSize: 11.5,
                      color: '***REMOVED***8a5a12',
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
                          color:
                            useWeekday === w && weekOverride !== null ? '***REMOVED***fff' : 'inherit',
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
                      border: '1px solid ***REMOVED***f0c9c9',
                      borderRadius: 4,
                      fontSize: 11.5,
                      color: '***REMOVED***8f2b2b',
                      lineHeight: 1.6,
                    }}
                  >
                    {dayItems.conflicts.map((c) => (
                      <div key={c}>⚠ {c}</div>
                    ))}
                  </div>
                ) : null}

                {day.items.length === 0 ? (
                  <div
                    className="mt-2"
                    style={{ fontSize: 12, color: 'var(--color-ink3)', lineHeight: 1.7 }}
                  >
                    今天没有排课。拍一张课表照片可以自动识别录入。
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
                      () => speak(`请 12 号、37 号，到${klass.name}的物理老师办公室。`),
                      680,
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

              {/* 考试模式：全屏黑底时钟，所有声音停掉 */}
              {exam ? (
                <div
                  className="fixed inset-0 z-[90] flex flex-col items-center justify-center"
                  style={{ background: '***REMOVED***000' }}
                >
                  <div
                    className="num"
                    style={{
                      fontSize: 'clamp(72px, 17vw, 190px)',
                      fontWeight: 200,
                      color: '***REMOVED***fff',
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

              {/* 自动备份到这台电脑上的一个文件夹 —— 云端之外的第二份保险 */}
              <Panel bodyClass="p-4">
                <div className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                  <IconCheck size={15} />
                  <span style={{ color: 'var(--color-ink2)' }}>自动备份到本机</span>
                  <span className="flex-1" />
                  {bkSupported ? (
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
                      style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
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
                    ? '这个浏览器不支持自动写文件夹。数据在云端有备份，不受影响。'
                    : needsGrant
                      ? '浏览器重启后权限会失效 —— 点右上角「点一下恢复」即可继续自动备份。'
                      : bk
                        ? `上次备份：${new Date(bk).toLocaleString('zh-CN')} · 每 5 分钟一次`
                        : '选一个文件夹（建议放在网盘同步目录里），之后每 5 分钟自动写一份备份。'}
                </div>
              </Panel>

              {/* 小窗同款面板：不支持置顶小窗时，这就是兜底 */}
              {cur && !closing ? (
                <Panel className="overflow-hidden">
                  <div className="panel-head">
                    <h2>当前题目</h2>
                    <span className="flex-1" />
                    <span style={{ fontSize: 11, color: 'var(--color-ink3)' }}>
                      {pipWin ? '与小窗同步' : '小窗兜底'}
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
                  <div style={{ fontSize: 13, color: 'var(--color-ink3)', marginTop: 6 }}>
                    在教师端完成一次批改后，这里的逐题正确率会自动出现。
                  </div>
                </Panel>
              ) : (
                <>
                  {/* 按日期筛选：一天可能不止一份作业，所以筛选的是"日期"而不是作业 */}
                  {graded.length > 1 ? (
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      {[...new Set(graded.map((a) => a.assignDate))]
                        .sort((x, y) => (x < y ? 1 : -1))
                        .slice(0, 10)
                        .map((d) => {
                          const on = assignment.assignDate === d
                          const n = graded.filter((a) => a.assignDate === d).length
                          return (
                            <button
                              key={d}
                              type="button"
                              onClick={() => {
                                const first = graded.find((a) => a.assignDate === d)
                                if (first) {
                                  setAssignmentId(first.id)
                                  setSeq(1)
                                }
                              }}
                              className="num"
                              style={{
                                padding: '3px 9px',
                                borderRadius: 4,
                                fontSize: 12,
                                border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                                background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                                color: on ? 'var(--color-accentink)' : 'var(--color-ink2)',
                                fontWeight: on ? 650 : 500,
                              }}
                            >
                              {d.slice(5).replace('-', '/')}
                              {n > 1 ? ` (${n})` : ''}
                            </button>
                          )
                        })}
                      <span style={{ fontSize: 11.5, color: 'var(--color-ink4)', marginLeft: 2 }}>
                        按日期
                      </span>
                    </div>
                  ) : null}

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
                    {pipWin ? <Tag tone="ok">小窗已开启</Tag> : null}
                  </div>

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

                  <Sect>老师传来的文件</Sect>
                  <Panel className="overflow-hidden">
                    {pulling ? (
                      <div
                        className="px-3 py-2.5"
                        style={{
                          fontSize: 12.5,
                          color: 'var(--color-accent)',
                          borderBottom: '1px solid var(--color-line)',
                        }}
                      >
                        正在取回「{pulling}」…
                      </div>
                    ) : null}

                    {localFiles.length === 0 && cloudFiles.length === 0 ? (
                      <div className="px-3 py-4" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                        还没有文件。教师端在「我的 → 教室端文件」里上传，
                        传过来会自动存到这台电脑上。
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
                                onClick={() => (viewable ? openLocal(f) : saveToDisk(f))}
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
                    文件已经存在<b>这台电脑上</b>，云端不留 —— 断网也能打开。
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
                      <li>换题时会自动收起名单，避免上一题的名单留在屏幕上</li>
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
                  color: 'var(--color-ink2, ***REMOVED***333)',
                  background: 'var(--color-surface, ***REMOVED***fff)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 6 }}>还没有可讲评的作业</div>
                <div style={{ fontSize: 12, color: 'var(--color-ink3, ***REMOVED***777)' }}>
                  {klass?.name ?? ''} 还没有批改完的作业。
                  <br />
                  教师端批改一次后，这里就会出现题号与正确率。
                </div>
              </div>
            ),
            pipWin.document.body,
          )
        : null}

      {/* 播报浮层 */}
      {broadcast ? (
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
                background: '***REMOVED***4ade9a',
                display: 'inline-block',
              }}
            />
            正在播报
          </div>
          <div
            style={{
              color: '***REMOVED***fff',
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
          <div className="mt-10 flex gap-3">
            <Button
              onClick={() => {
                chime()
                window.setTimeout(() => speak(broadcast.text), 680)
              }}
            >
              再播一遍
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                stopSpeaking()
                setBroadcast(null)
              }}
            >
              关闭
            </Button>
          </div>
        </div>
      ) : null}
    </Shell>
  )
}

/* 教室端不套教师端的应用壳 */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-[1] mx-auto min-h-full w-full">{children}</div>
}
