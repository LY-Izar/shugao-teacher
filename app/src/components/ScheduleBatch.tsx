import { useRef, useState } from 'react'
import {
  IconAlert,
  IconCheck,
  IconList,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
} from './icons'
import { Button, Sheet, Tag } from './ui'
import type { Klass, ScheduleItem } from '../data/types'
import { WEEKDAY_TEXT } from '../data/types'
import { docxToText } from '../lib/docx'
import { PERIOD_SLOTS, parseScheduleRows, parseScheduleText } from '../lib/scheduleParse'
import { normalizeTime, toMinutes } from '../lib/schedule'
import { xlsxToRows } from '../lib/xlsx'

type Draft = {
  key: string
  weekday: number
  start: string
  end: string
  title: string
  room: string
}

let seq = 0
const newKey = () => `d${++seq}`

const blank = (weekday: number, slot: [string, string] = PERIOD_SLOTS[0]): Draft => ({
  key: newKey(),
  weekday,
  start: slot[0],
  end: slot[1],
  title: '',
  room: '',
})

/** 追加一行时自动接上一行的下一节，省得每次都重填时间 */
function nextSlot(rows: Draft[]): [string, string] {
  const last = rows[rows.length - 1]
  if (!last) return PERIOD_SLOTS[0]
  const i = PERIOD_SLOTS.findIndex(([s]) => s === last.start)
  return i >= 0 && i + 1 < PERIOD_SLOTS.length ? PERIOD_SLOTS[i + 1] : PERIOD_SLOTS[0]
}

/**
 * 批量录入课表。
 *
 * 三条路最后都汇到同一张可编辑的清单上 —— 手工填、粘贴文字、上传课表文件，
 * 教师改完一次性保存。**识别结果永远可改，不静默采用。**
 */
export function ScheduleBatch({
  open,
  onClose,
  classes,
  today,
  onSave,
}: {
  open: boolean
  onClose: () => void
  classes: Klass[]
  today: number
  onSave: (items: Omit<ScheduleItem, 'id'>[]) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<Draft[]>([])
  const [err, setErr] = useState('')
  const [warns, setWarns] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')

  /* 每次打开都从一行空白开始 */
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setRows([blank(today)])
      setErr('')
      setWarns([])
      setPasteOpen(false)
      setPaste('')
    }
  }

  const patch = (key: string, p: Partial<Draft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const addRow = () => setRows((rs) => [...rs, blank(rs[rs.length - 1]?.weekday ?? today, nextSlot(rs))])

  const take = (parsed: ReturnType<typeof parseScheduleText>) => {
    setWarns(parsed.warnings)
    if (!parsed.items.length) {
      setErr(parsed.warnings[0] ?? '没从这份文件里认出日程')
      return
    }
    setErr('')
    const mapped: Draft[] = parsed.items.map((it) => ({
      key: newKey(),
      weekday: it.weekday,
      start: it.start,
      end: it.end,
      title: it.title,
      room: it.room ?? '',
    }))
    setRows((rs) => (rs.some((r) => r.title.trim()) ? [...rs, ...mapped] : mapped))
  }

  const handleFile = async (f: File) => {
    setBusy(true)
    setErr('')
    setWarns([])
    try {
      const n = f.name.toLowerCase()
      if (n.endsWith('.xlsx')) {
        take(parseScheduleRows(await xlsxToRows(f), classes))
      } else if (n.endsWith('.docx')) {
        take(parseScheduleText(await docxToText(f), classes))
      } else if (n.endsWith('.csv') || n.endsWith('.txt')) {
        take(parseScheduleText(await f.text(), classes))
      } else if (n.endsWith('.xls')) {
        throw new Error('旧版 .xls 打不开，请用 Excel/WPS 另存为 .xlsx 或 .csv')
      } else {
        throw new Error('支持的格式：.xlsx / .docx / .csv / .txt')
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const valid = rows.filter((r) => r.title.trim() && toMinutes(r.end) > toMinutes(r.start))

  const save = () => {
    if (!valid.length) {
      setErr('至少填一条：课程名 + 起止时间（结束要晚于开始）')
      return
    }
    const cls = (name: string) => classes.find((c) => name.includes(c.name))?.id
    onSave(
      valid.map((r) => {
        const title = r.title.trim()
        const isOther = /备课|教研|会议|活动|培训|值班|例会|讲座|监考|阅卷|升旗|社团/.test(title)
        return {
          weekday: r.weekday,
          start: normalizeTime(r.start, PERIOD_SLOTS[0][0]),
          end: normalizeTime(r.end, PERIOD_SLOTS[0][1]),
          title,
          room: r.room.trim() || undefined,
          classId: cls(title),
          kind: isOther ? ('other' as const) : ('class' as const),
          notify: !isOther,
        }
      }),
    )
  }

  const badCount = rows.length - valid.length

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="批量录入课表"
      footer={
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 12, color: 'var(--color-ink3)', flex: 1 }}>
            <span className="num">{valid.length}</span> 条可保存
            {badCount > 0 ? ` · ${badCount} 条待补全` : ''}
          </span>
          <Button variant="primary" disabled={!valid.length} onClick={save}>
            保存全部
          </Button>
        </div>
      }
    >
      {/* ---- 导入区 ---- */}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.docx,.csv,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
          e.target.value = ''
        }}
      />

      <div
        className="mb-3 p-3"
        style={{
          border: '1px dashed var(--color-line2)',
          background: 'var(--color-surface2)',
          borderRadius: 6,
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--color-accent)', display: 'grid', placeItems: 'center' }}>
            {busy ? <IconRefresh size={16} /> : <IconUpload size={16} />}
          </span>
          <span style={{ fontSize: 13, fontWeight: 620, flex: 1 }}>
            {busy ? '正在识别…' : '从课表文件导入'}
          </span>
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            选择文件
          </Button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.65 }}>
          支持 .xlsx / .docx / .csv / .txt
        </p>
        <button
          type="button"
          className="mt-2 flex items-center gap-1.5"
          style={{ fontSize: 11.5, color: 'var(--color-accent)' }}
          onClick={() => setPasteOpen((v) => !v)}
        >
          <IconList size={13} />
          {pasteOpen ? '收起粘贴框' : '或者直接粘贴文字'}
        </button>
        {pasteOpen ? (
          <>
            <textarea
              className="input mt-2"
              style={{ height: 96, fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
              placeholder={'每行一条，例如：\n周二 08:55-09:40 高二(3)班 语文\n周三 14:30-15:15 备课组活动 办公室'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <Button
              size="sm"
              className="mt-2"
              disabled={!paste.trim()}
              onClick={() => {
                take(parseScheduleText(paste, classes))
                setPasteOpen(false)
              }}
            >
              识别这段文字
            </Button>
          </>
        ) : null}
      </div>

      {err ? (
        <div
          className="mb-3 flex items-start gap-2 p-2.5"
          style={{
            background: 'var(--color-badsoft)',
            border: '1px solid #f0c9c9',
            borderRadius: 4,
            fontSize: 11.5,
            color: '#8f2b2b',
            lineHeight: 1.6,
          }}
        >
          <span style={{ marginTop: 1, flexShrink: 0 }}>
            <IconAlert size={14} />
          </span>
          <span>{err}</span>
        </div>
      ) : null}

      {warns.length ? (
        <div
          className="mb-3 flex items-start gap-2 p-2.5"
          style={{
            background: 'var(--color-warnsoft)',
            border: '1px solid #ecd9ae',
            borderRadius: 4,
            fontSize: 11.5,
            color: '#8a5a12',
            lineHeight: 1.6,
          }}
        >
          <span style={{ marginTop: 1, flexShrink: 0 }}>
            <IconAlert size={14} />
          </span>
          <span>{warns.join('；')}</span>
        </div>
      ) : null}

      {/* ---- 可编辑清单 ---- */}
      <div className="mb-2 flex items-center gap-2">
        <span style={{ fontSize: 11, letterSpacing: '.08em', color: 'var(--color-ink3)' }}>
          待保存的日程
        </span>
        <span className="flex-1" />
        {classes.length ? <Tag tone="idle">{classes.length} 个班级可匹配</Tag> : null}
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((r) => {
          const bad = !r.title.trim() || toMinutes(r.end) <= toMinutes(r.start)
          return (
            <div
              key={r.key}
              className="p-2.5"
              style={{
                border: `1px solid ${bad ? 'var(--color-line)' : 'var(--color-line2)'}`,
                borderRadius: 4,
                background: bad ? 'var(--color-surface2)' : 'var(--color-surface)',
              }}
            >
              <div className="flex items-center gap-1.5">
                <select
                  className="input"
                  style={{ height: 32, fontSize: 12.5, width: 76, padding: '0 4px' }}
                  value={r.weekday}
                  onChange={(e) => patch(r.key, { weekday: Number(e.target.value) })}
                >
                  {WEEKDAY_TEXT.map((t, i) => (
                    <option key={t} value={i + 1}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  className="input num"
                  style={{ height: 32, fontSize: 12.5, width: 62, textAlign: 'center' }}
                  placeholder="08:00"
                  value={r.start}
                  onChange={(e) => patch(r.key, { start: e.target.value })}
                />
                <span style={{ color: 'var(--color-ink4)' }}>–</span>
                <input
                  className="input num"
                  style={{ height: 32, fontSize: 12.5, width: 62, textAlign: 'center' }}
                  placeholder="08:45"
                  value={r.end}
                  onChange={(e) => patch(r.key, { end: e.target.value })}
                />
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label="删除这一条"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="grid place-items-center shrink-0"
                  style={{ width: 30, height: 30, color: 'var(--color-ink4)' }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  className="input"
                  style={{ height: 32, fontSize: 12.5, flex: 1, minWidth: 0 }}
                  placeholder="课程 / 事项，如 高二(3)班 语文"
                  value={r.title}
                  onChange={(e) => patch(r.key, { title: e.target.value })}
                />
                <input
                  className="input"
                  style={{ height: 32, fontSize: 12.5, width: 88 }}
                  placeholder="地点"
                  value={r.room}
                  onChange={(e) => patch(r.key, { room: e.target.value })}
                />
              </div>
              {bad ? (
                <div style={{ fontSize: 11, color: 'var(--color-ink4)', marginTop: 5 }}>
                  {!r.title.trim() ? '还没填课程名' : '结束时间要晚于开始时间'}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="mt-3 flex w-full items-center justify-center gap-1.5 py-2.5"
        style={{
          border: '1px dashed var(--color-line2)',
          borderRadius: 4,
          fontSize: 13,
          color: 'var(--color-accent)',
          background: 'var(--color-surface2)',
        }}
      >
        <IconPlus size={15} />
        再加一条
      </button>

      {rows.length === 1 ? (
        <p
          className="mt-3 flex items-start gap-1.5"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)', lineHeight: 1.65 }}
        >
          <IconCheck size={13} />
          <span>点「再加一条」可以一次录完整周。</span>
        </p>
      ) : null}
    </Sheet>
  )
}
