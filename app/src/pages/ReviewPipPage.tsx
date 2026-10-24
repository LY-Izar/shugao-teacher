/**
 * 作业讲评的**置顶小窗**那一屏（`/popup/shugao.review`）。
 * ============================================================================
 * 用户 2026-10-24：「作业讲评的置顶小窗怎么长这样，**要原来固定版的那种**」——
 * 指的是旧教室端那块深色面板：一排题号（每格带这一题的正确率与分档配色）+ 当前题的正确率
 * 大数字 + 上一题/下一题 + 错题与缺交名单。
 *
 * 为什么不能直接把插件界面塞进这扇窗：插件界面是**整块功能块**（含标题、换档案的下拉、
 * 「启动置顶小窗」那颗按钮、以及它自己的提示语）。塞进小窗里就成了"小窗里还有一个启动小窗的
 * 按钮"，而且它在浮窗里拿不到 `ctx.pip`（浮窗那份渲染进程没有 preload）⇒ 当场报
 * 「这台机器上开不了置顶小窗」。**这扇窗本身就是那个小窗**，所以这里直接画面板本体。
 *
 * 🔴 数据与分档全部来自宿主同一处：`readResource('class.gradedHomework')` 递出来的
 *    `questions` 已经带 `rate` / `band` / `wrongNos`（见 `resources.ts` 那一段的注释），
 *    面板组件是 `components/PipPanel.tsx` —— 与旧教室端**同一个组件**，不另写一份版式。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PipPanel } from '../components/PipPanel'
import { readResource, watchResource } from '../classroom/resources'
import type { Band } from '../lib/grading'

type PipQuestion = {
  seq: number
  rate: number
  band: Band
  wrongNos: string[]
}
type PipRow = { id: string; title: string; questions: PipQuestion[] }
type Person = { no: string; name: string }

/** 与主屏同一个键（`ClassroomPluginShell` 切班时写的那个）—— 小窗与主屏永远看同一个班 */
const CLASS_KEY = 'shugao.classroom.classId'

function readClassId(): string {
  try {
    return localStorage.getItem(CLASS_KEY) ?? ''
  } catch {
    return ''
  }
}

export default function ReviewPipPage() {
  const classId = readClassId()
  const [rows, setRows] = useState<PipRow[]>([])
  const [roster, setRoster] = useState<Person[]>([])
  const [seq, setSeq] = useState(1)

  useEffect(() => {
    if (!classId) return
    let alive = true
    const load = async () => {
      const [graded, people] = await Promise.all([
        readResource('class.gradedHomework', classId),
        readResource('class.roster', classId),
      ])
      if (!alive) return
      const g = graded.value as { rows?: PipRow[] } | null
      const r = people.value as { students?: Person[] } | null
      setRows(g?.rows ?? [])
      setRoster(r?.students ?? [])
    }
    void load()
    const off = watchResource(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [classId])

  /* 与旧教室端同一条口径：取最近一份已批改的档案（`readResource` 已按布置日倒序） */
  const row = rows[0] ?? null
  const questions = row?.questions ?? []
  const cur = questions[seq - 1] ?? null
  const total = questions.length

  const nameOf = useCallback(
    (no: string) => roster.find((s) => s.no === no)?.name ?? '',
    [roster],
  )
  const go = (n: number) => setSeq(Math.min(Math.max(1, n), Math.max(1, total)))

  /* 题号条要的那一份（下标 0 = 第 1 题）：只跟"这一份档案的题"有关 */
  const all = useMemo(() => (row?.questions ?? []).map((q) => ({ rate: q.rate, band: q.band })), [row])

  if (!cur) {
    return (
      <div
        className="grid h-full w-full place-items-center text-center"
        style={{
          background: 'linear-gradient(180deg,#10151c,#171e28)',
          color: 'rgb(255 255 255 / .72)',
          fontSize: 13,
          lineHeight: 1.8,
          padding: 16,
        }}
      >
        <div>
          还没有可讲评的档案
          <div style={{ marginTop: 6, fontSize: 12, color: 'rgb(255 255 255 / .5)' }}>
            批改完一份作业，这里就会显示逐题正确率
          </div>
        </div>
      </div>
    )
  }

  return (
    <PipPanel
      tone="pip"
      seq={seq}
      total={total}
      rate={cur.rate}
      band={cur.band}
      wrongNos={cur.wrongNos}
      nameOf={nameOf}
      all={all}
      onPick={(n) => go(n)}
      onPrev={() => go(seq - 1)}
      onNext={() => go(seq + 1)}
    />
  )
}
