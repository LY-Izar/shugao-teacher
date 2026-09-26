import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconCheck, IconTrash } from '../components/icons'
import { Button, KV, Modal, PageHead, Panel, Sect, StatStrip, Tag } from '../components/ui'
import { downloadJson } from '../lib/backup'
import {
  apiDownloadBackup,
  apiGradeBackup,
  apiGradeDelete,
  apiOverview,
  apiPromote,
  checklistRows,
  confirmMatches,
  hasPromotable,
  promotePlan,
  readPromoteResult,
  type ActionResult,
  type ChecklistRow,
  type OverviewState,
  type PromoteGrade,
} from '../lib/gradePromote'

/**
 * 「提档与毕业」`/grades/promote`（P4）。
 *
 * 施工图：`选科走班实施计划.md` P4 段；决策：`年级管理与选科走班方案.md`
 * §2.6（毕业删除：备份 → 发信 → 弹提示 → 二次确认 → 清残留）· §4.2.4(3)(4)。
 *
 * 🔴 这一页只做三件事：**摆预览 / 摆按钮 / 把服务端的话原样说给人听**。
 *    权限、幂等、清残留全在数据库（`schema.sql` §29）；这里一处判据都没有
 *    （`confirmMatches()` 只用来把按钮点亮，闸门是 SQL 里那一句逐字比对）。
 * 🔴 **"删除"按危险等级设计**：红、单独一块、写清"不可恢复"、要逐字输入年级全名，
 *    而且**只有最高管理员**看得到那个按钮。
 * ⚠️ 提档那一块**不提"撤回身份"** —— Q16：提档不撤回任何身份。
 */
export default function GradePromote() {
  const navigate = useNavigate()
  const [state, setState] = useState<OverviewState | null>(null)
  const [busy, setBusy] = useState('')
  /** 提档的二次确认 */
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [promoteMsg, setPromoteMsg] = useState('')
  /** 每个年级：删除确认的输入 / 上一步的结果 / 删除后的清点表 */
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [result, setResult] = useState<Record<string, ActionResult>>({})
  const [checklist, setChecklist] = useState<Record<string, ChecklistRow[]>>({})
  /** 读一次预览的"重跑开关"（写完之后 +1）—— 与 `Grades.tsx` 同款：setState 不在 effect 体里直接调 */
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const s = await apiOverview()
      if (alive) setState(s)
    })()
    return () => {
      alive = false
    }
  }, [nonce])

  const ov = state?.overview
  const plan = promotePlan(ov?.grades ?? [])
  const graduates = (ov?.grades ?? []).filter((g) => g.stage === 3)
  /** 🔴 给教导处的提示：**备份已发出、但还没删**的年级（§2.6 第③步） */
  const pending = (ov?.grades ?? []).filter((g) => g.mailOk && !g.removedAt)

  const doPromote = async () => {
    setPromoteOpen(false)
    setBusy('promote')
    const a = await apiPromote()
    const r = readPromoteResult(a)
    setPromoteMsg(
      a.ok
        ? r.alreadyPromoted
          ? `${r.academicYear} 这一学年已经提过了，这次一行都没改。`
          : `提档完成：${r.promoted} 个年级升了一级（班级、走班班、课表都没有变）。`
        : a.message,
    )
    setBusy('')
    reload()
  }

  const doBackup = async (g: PromoteGrade) => {
    setBusy(`backup:${g.id}`)
    const a = await apiGradeBackup(g.id)
    setResult((m) => ({ ...m, [g.id]: a }))
    setBusy('')
    reload()
  }

  const doDownload = async (g: PromoteGrade) => {
    if (!g.removalId) return
    setBusy(`download:${g.id}`)
    const a = await apiDownloadBackup(g.removalId)
    if (a.ok && a.data.payload) {
      downloadJson(a.data.payload, `${g.fullName.replace(/[\\/:*?"<>|（）]/g, '')}-备份.json`)
    } else {
      setResult((m) => ({ ...m, [g.id]: a }))
    }
    setBusy('')
  }

  const doDelete = async (g: PromoteGrade) => {
    setBusy(`delete:${g.id}`)
    const a = await apiGradeDelete(g.id, typed[g.id] ?? '')
    setResult((m) => ({ ...m, [g.id]: a }))
    if (a.ok) {
      setChecklist((m) => ({ ...m, [g.id]: checklistRows(a.data.report) }))
      setTyped((m) => ({ ...m, [g.id]: '' }))
    }
    setBusy('')
    reload()
  }

  return (
    <>
      {/* 返回「行政管理」(`/manage`)：这一页的入口是 `/manage` 那张「档案管理」卡，
          不是「年级管理」页（写死 `/grades` 是「行政管理」页存在之前的旧世界） */}
      <PageHead title="提档与毕业" onBack={() => navigate('/manage')} />
      <Page>
        {state === null ? (
          <Panel bodyClass="p-6 text-center">
            <span style={{ fontSize: 13, color: 'var(--color-ink3)' }}>正在读年级…</span>
          </Panel>
        ) : state.verdict !== 'allowed' ? (
          <Panel bodyClass="p-4">
            <div style={{ fontSize: 13.5 }}>{state.notice || '这一页现在打不开。'}</div>
          </Panel>
        ) : (
          <>
            {/* ---------- 给教导处的提示（§2.6 第③步） ---------- */}
            {pending.length ? (
              <Panel bodyClass="p-3.5" className="mb-3">
                <div className="flex items-start gap-2" style={{ color: 'var(--color-warn)' }}>
                  <IconAlert size={16} />
                  <div className="min-w-0 flex-1" style={{ fontSize: 13 }}>
                    {pending.map((g) => (
                      <div key={g.id}>
                        {g.fullName}：备份已经生成
                        {g.mailAt ? `（${g.mailAt.slice(0, 10)}）` : ''}，等最高管理员确认删除。
                      </div>
                    ))}
                  </div>
                </div>
              </Panel>
            ) : null}

            {/* ---------- 提档 ---------- */}
            <Sect>提档</Sect>
            <Panel bodyClass="p-3.5">
              <StatStrip
                items={[
                  { k: '本学年', v: ov?.academicYear ?? '读不到' },
                  { k: '今天', v: ov?.today ?? '读不到' },
                  {
                    k: '本学年提档',
                    v: ov?.promotedAt ? `已提（${ov.promotedAt.slice(0, 10)}）` : '还没提',
                    tone: ov?.promotedAt ? 'var(--color-ok)' : 'var(--color-warn)',
                  },
                ]}
              />

              {plan.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>库里还没有年级。</div>
              ) : (
                <div className="mt-3">
                  {plan.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 py-1.5"
                      style={{ borderTop: '1px solid var(--color-line2)' }}
                    >
                      <div className="min-w-0 flex-1" style={{ fontSize: 13.5 }}>
                        {r.from} → {r.to}
                        <span style={{ color: 'var(--color-ink3)', marginLeft: 8, fontSize: 12 }}>
                          {r.fullName}
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                        {r.classes} 个班 · {r.students} 人
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {ov?.promotedAt ? (
                <div className="mt-3" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                  本学年已经提过档了，再点也不会改任何数据。
                </div>
              ) : !ov?.windowOpen ? (
                <div className="mt-3" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                  提档在每年 9 月 1 日之后做。
                </div>
              ) : null}

              {ov?.canPromote ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    disabled={!!busy || !!ov.promotedAt || !ov.windowOpen || !hasPromotable(ov.grades)}
                    onClick={() => setPromoteOpen(true)}
                  >
                    确认提档
                  </Button>
                  <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                    只改学段，年级 id 不变
                  </span>
                </div>
              ) : null}

              {promoteMsg ? (
                <div className="mt-2.5" style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                  {promoteMsg}
                </div>
              ) : null}
            </Panel>

            {/* ---------- 毕业删除 ---------- */}
            <Sect>毕业删除</Sect>
            {graduates.length === 0 ? (
              <Panel bodyClass="p-4">
                <div style={{ fontSize: 13, color: 'var(--color-ink3)' }}>还没有高三的年级。</div>
              </Panel>
            ) : (
              graduates.map((g) => {
                const a = result[g.id]
                const rows = checklist[g.id]
                const canType = confirmMatches(typed[g.id] ?? '', g.fullName)
                const done = !!g.removedAt || a?.data?.alreadyDeleted === true
                return (
                  <div key={g.id} className="mb-3">
                    <Panel bodyClass="p-3.5">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1" style={{ fontSize: 15, fontWeight: 650 }}>
                          {g.fullName}
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                          {g.classes} 个班 · {g.students} 人
                        </span>
                      </div>

                      {/* 第一步：备份 */}
                      <div className="mt-3" style={{ fontSize: 12.5, color: 'var(--color-ink2)' }}>
                        {g.mailOk
                          ? `备份已在 ${
                              g.mailAt ? g.mailAt.slice(0, 16).replace('T', ' ') : ''
                            } 已完成备份。`
                          : g.backupAt
                            ? `备份生成过，但没能存到云端${g.mailReason ? `（${g.mailReason}）` : ''}。`
                            : '还没有备份。'}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="sm" disabled={!!busy} onClick={() => void doBackup(g)}>
                          {busy === `backup:${g.id}`
                            ? '正在备份…'
                            : g.mailOk || g.backupAt
                              ? '重新备份'
                              : '生成备份'}
                        </Button>
                        {g.removalId ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() => void doDownload(g)}
                          >
                            下载备份
                          </Button>
                        ) : null}
                      </div>

                      {/* 第二步：删除（**危险区**） */}
                      <div className="mt-3.5 pt-3" style={{ borderTop: '1px solid var(--color-line2)' }}>
                        {done ? (
                          <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
                            <IconCheck size={15} />
                            这个年级已经删掉了
                            {g.removedAt ? `（${g.removedAt.slice(0, 10)}）` : ''}。
                          </div>
                        ) : !g.isSuper ? (
                          <div style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
                            删除只有最高管理员能做。
                          </div>
                        ) : (
                          <>
                            <div
                              className="flex items-center gap-1.5"
                              style={{ fontSize: 13, color: 'var(--color-bad)' }}
                            >
                              <IconTrash size={15} />
                              删除这个年级
                            </div>
                            <div className="mt-1" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                              {g.classes} 个班、{g.students} 名学生，连同作业、呼叫、考试一起删除，
                              不可恢复。
                            </div>
                            {!g.canDelete ? (
                              <div className="mt-2" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                                先做一次备份，这里才放行。
                              </div>
                            ) : null}
                            <div className="mt-2">
                              <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                                输入「{g.fullName}」以确认：
                              </div>
                              <input
                                className="input mt-1"
                                style={{ height: 32, fontSize: 13 }}
                                value={typed[g.id] ?? ''}
                                onChange={(e) => setTyped((m) => ({ ...m, [g.id]: e.target.value }))}
                                placeholder={g.fullName}
                                aria-label={`输入${g.fullName}以确认删除`}
                              />
                            </div>
                            <div className="mt-2">
                              <Button
                                variant="danger"
                                disabled={!g.canDelete || !canType || !!busy}
                                onClick={() => void doDelete(g)}
                              >
                                {busy === `delete:${g.id}` ? '正在删除…' : '删除这一个年级'}
                              </Button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* 第三步：结果 + 清点表 */}
                      {a ? (
                        <div
                          className="mt-3"
                          style={{
                            fontSize: 12.5,
                            color: a.ok ? 'var(--color-ink2)' : 'var(--color-bad)',
                          }}
                        >
                          {a.ok
                            ? a.data.alreadyDeleted === true
                              ? '这个年级之前已经删过了，这次什么都没改。'
                              : '删除完成。'
                            : a.message}
                        </div>
                      ) : null}
                      {rows ? (
                        <div className="mt-2">
                          <div style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                            清点表（删之前 → 删之后）
                          </div>
                          {rows.map((r) => (
                            <div
                              key={r.key}
                              className="flex items-center gap-2 py-1"
                              style={{ fontSize: 12.5 }}
                            >
                              <span className="min-w-0 flex-1">{r.label}</span>
                              <span style={{ color: 'var(--color-ink3)' }}>
                                {r.before} → {r.after}
                              </span>
                              <Tag tone={r.ok ? 'ok' : 'bad'}>{r.ok ? '已清空' : '还有残留'}</Tag>
                            </div>
                          ))}
                          {a?.data?.classroomAccounts ? (
                            <KV
                              k="教室端账号"
                              v={(() => {
                                const c = a.data.classroomAccounts as Record<string, unknown>
                                return `${Number(c.deleted ?? 0)} / ${Number(c.total ?? 0)} 个已删`
                              })()}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </Panel>
                  </div>
                )
              })
            )}
          </>
        )}
      </Page>

      {/* 提档的二次确认（确认式，不是"到点自动"） */}
      <Modal open={promoteOpen} onClose={() => setPromoteOpen(false)}>
        <div style={{ fontSize: 15, fontWeight: 650 }}>确认提档？</div>
        <div className="mt-2" style={{ fontSize: 13, color: 'var(--color-ink2)' }}>
          {ov?.academicYear ?? ''} 这一学年提一次：
          {plan
            .filter((r) => r.kind === 'promote')
            .map((r) => `${r.from} → ${r.to}`)
            .join('、')}
          。
        </div>
        <div className="mt-1.5" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
          班级、走班班、课表都不变；老师们的身份也不变。
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button disabled={!!busy} onClick={() => void doPromote()}>
            确认提档
          </Button>
          <Button variant="ghost" onClick={() => setPromoteOpen(false)}>
            先不提
          </Button>
        </div>
      </Modal>
    </>
  )
}
