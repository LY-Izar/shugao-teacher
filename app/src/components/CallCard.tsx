import { IconRefresh } from './icons'
import { Button, Panel, Tag } from './ui'
import type { CallRecord, CallState, Student } from '../data/types'
import { CALL_STATE_TEXT } from '../data/types'
import { formatClock } from '../lib/calls'
import { displayNoOfArchiveKey } from '../lib/keys'

const NEXT_STATE: Record<CallState, CallState> = {
  called: 'arrived',
  arrived: 'corrected',
  corrected: 'corrected',
}

const TONE: Record<CallState, { bg: string; fg: string }> = {
  called: { bg: 'var(--color-idlesoft)', fg: 'var(--color-ink3)' },
  arrived: { bg: 'var(--color-accentsoft)', fg: 'var(--color-accentink)' },
  corrected: { bg: 'var(--color-oksoft)', fg: 'var(--color-ok)' },
}

export function CallCard({
  call,
  students,
  context,
  onRepeat,
  onAdvance,
}: {
  call: CallRecord
  students: Student[]
  /** 跨作业查看时用来标明这是哪份作业 */
  context?: string
  onRepeat: () => void
  onAdvance: (studentNo: string) => void
}) {
  const last = call.sentAt[call.sentAt.length - 1] ?? 0
  /*
   * ⚠️ `call.studentNos` 里存的是**档案键**（迁移后 = 序列号），
   *    而界面上要显示**班内学号** → 一律经 `displayNoOfArchiveKey()` 换一次。
   *    以前这里直接 `s.studentNo === no`，迁移后会全部认不出（名字显示成空，而且不报错）。
   */
  const nameOf = (key: string) =>
    students.find((s) => s.studentNo === key || s.serial === key)?.name ?? ''
  const done = call.studentNos.filter((n) => call.states[n] === 'corrected').length

  return (
    <Panel className="overflow-hidden">
      <div className="panel-head">
        <h2 className="truncate">
          <span className="num">{formatClock(last)}</span>
          {context ? <span style={{ fontWeight: 500 }}> · {context}</span> : null}
          <span style={{ fontWeight: 500 }}> · 叫了 {call.studentNos.length} 人</span>
        </h2>
        <span className="flex-1" />
        {call.sentAt.length > 1 ? <Tag tone="idle">重播 {call.sentAt.length - 1} 次</Tag> : null}
        <Tag tone={done === call.studentNos.length ? 'ok' : 'accent'}>
          订正 {done}/{call.studentNos.length}
        </Tag>
      </div>

      <div className="p-3">
        <div style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.6 }}>{call.text}</div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {call.studentNos.map((no) => {
            const st = call.states[no] ?? 'called'
            const t = TONE[st]
            const shown = displayNoOfArchiveKey(students, no)
            return (
              <button
                key={no}
                type="button"
                onClick={() => onAdvance(no)}
                className="flex items-center gap-1.5 px-2 py-1"
                style={{
                  background: t.bg,
                  borderRadius: 3,
                  fontSize: 12,
                  color: t.fg,
                  border: 0,
                  fontFamily: 'inherit',
                  cursor: st === 'corrected' ? 'default' : 'pointer',
                }}
                title={st === 'corrected' ? '已订正' : '点一下推进状态'}
              >
                <b className="num">{shown}</b>
                {nameOf(no)}
                <span style={{ fontSize: 10.5, fontWeight: 600 }}>{CALL_STATE_TEXT[st]}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div
        className="flex items-center gap-1 px-3 py-2"
        style={{ borderTop: '1px solid var(--color-line)', background: 'var(--color-surface2)' }}
      >
        <Button size="sm" variant="ghost" icon={<IconRefresh size={14} />} onClick={onRepeat}>
          再播一遍
        </Button>
        <span className="flex-1" />
        <span style={{ fontSize: 11, color: 'var(--color-ink4)' }}>已叫 → 已到 → 已订正</span>
      </div>
    </Panel>
  )
}

export { NEXT_STATE }
