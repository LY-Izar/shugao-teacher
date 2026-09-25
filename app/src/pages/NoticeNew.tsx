import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconSend } from '../components/icons'
import { Button, Empty, PageHead, Panel, Sect } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { departmentName } from '../lib/departments'
import { canPublishNotice, roleName } from '../lib/roles'
import { subjectShort } from '../lib/subjects'
import type { NoticeScopeOption } from '../data/types'

const TITLE_MAX = 120
const BODY_MAX = 2000

/**
 * 发通知 `/notices/new`（`管理架构与角色权限方案.md` §九.2 / §九.3）。
 *
 * 🔴 三条不能破的纪律：
 *
 *  ① **"能发给谁"完全由数据库算**。下面那几组选项来自 `my_notice_scopes()`（服务端
 *     `/api/notice` 的 `list` 里带回来的）—— **不是**前端按角色拼的。
 *     手打这个页面、或者改前端，都绕不过服务端那一次 `can_publish_notice_to()`（I46）。
 *     这一页**只决定摆不摆那个选项**。
 *  ② **年级主任与组长看不到"全校"** —— 那不是这里藏掉的结果，是数据库
 *     `my_notice_scopes()` 根本不会把它列出来（§九.3 ② 那条边界）。
 *  ③ **不做附件、不做富文本**（§九.9 / Q18）：一条通知 = 标题 + 正文。
 *     要发材料就在正文里写一句"材料在『教室端文件』里"。
 *
 * ⚠️ 班主任与任课教师**到不了这一页**（`ENTRIES` 的 `/notices/new` 是 `E`），
 *    但手打 URL 进得来 —— 那时显示下面那句说明，服务端也会 403（不构成信息泄露）。
 */
export default function NoticeNew() {
  const myRoles = useStore((s) => s.myRoles)
  const scopes = useStore((s) => s.noticesScopes)
  const publishNotice = useStore((s) => s.publishNotice)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)

  const mayPublish = canPublishNotice(myRoles)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pick, setPick] = useState<string>('')
  const [days, setDays] = useState(0)
  const [sending, setSending] = useState(false)

  /**
   * 一份**去重后的选项清单**。
   *
   * `my_notice_scopes()` 给的是**逐维度值**的行（一个年级一行、一个学科一行…），
   * 所以界面上要按 `scopeKind` 分五组摆：
   *   · `school`     只有一行（"全校所有老师"）
   *   · `department` 🆕 一个职能部门一行（**校级单位** —— 见 schema §21.4 那个判断）
   *   · `grade`      一个年级一行
   *   · `subject`    一个学科一行（**跨年级** —— 这正是教研组长的范围）
   *   · `role`       一个职位一行
   * ⚠️ `grade_subject`（本年级 + 本学科）不单独成组：它是"年级 + 学科"的组合，
   *    在 UI 上等于连选两次，而当前用它的只有备课组长一个人 —— 先不做，
   *    但**数据库那一侧已经支持**（服务端与 `can_publish_notice_to` 都认它）。
   *    这是本轮**唯一**一处"后端能力比前端界面宽"的地方，写在这里免得被当成漏了。
   */
  const groups = useMemo(() => {
    const g = {
      school: scopes.filter((s) => s.scopeKind === 'school'),
      department: scopes.filter((s) => s.scopeKind === 'department'),
      grade: scopes.filter((s) => s.scopeKind === 'grade'),
      subject: scopes.filter((s) => s.scopeKind === 'subject'),
      role: scopes.filter((s) => s.scopeKind === 'role'),
    }
    return g
  }, [scopes])

  const keyOf = (s: NoticeScopeOption) =>
    `${s.scopeKind}|${s.gradeId ?? ''}|${s.subjectCode ?? ''}|${s.roleCode ?? ''}|${s.departmentCode ?? ''}`
  const all = useMemo(
    () => [
      ...groups.school,
      ...groups.department,
      ...groups.grade,
      ...groups.subject,
      ...groups.role,
    ],
    [groups],
  )
  const chosen = all.find((s) => keyOf(s) === pick) ?? null

  const scopeLabel = (s: NoticeScopeOption): string => {
    switch (s.scopeKind) {
      case 'school':
        return '全校所有老师'
      case 'department':
        return `${s.departmentCode ? departmentName(s.departmentCode) : '某个部门'}全体人员`
      case 'grade':
        return `${s.gradeName ?? '本年级'}的老师`
      case 'subject':
        return `${s.subjectCode ? subjectShort(s.subjectCode, s.subjectCode) : ''} 全体老师（跨年级）`
      case 'role':
        return `全部${roleName(s.roleCode)}`
      default:
        return '一批老师'
    }
  }

  /** 每一组的标题 + 那句"这是干什么用的"（选项少的时候不摆标题，免得空一节） */
  const blockOf = (kind: string, label: string, hint: string) => {
    const list = all.filter((s) => s.scopeKind === kind)
    if (!list.length) return null
    return (
      <div className="mb-3" key={kind}>
        <Sect>
          {label} · {hint}
        </Sect>
        <Panel className="overflow-hidden">
          {list.map((s, i) => {
            const on = pick === keyOf(s)
            return (
              <button
                key={keyOf(s)}
                type="button"
                onClick={() => setPick(keyOf(s))}
                className="flex w-full items-center gap-2.5 px-3 text-left"
                style={{
                  minHeight: 46,
                  borderBottom: i === list.length - 1 ? undefined : '1px solid var(--color-line)',
                  background: on ? 'var(--color-accentsoft)' : 'var(--color-surface)',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 99,
                    border: `1.5px solid ${on ? 'var(--color-accent)' : 'var(--color-line2)'}`,
                    display: 'grid',
                    placeItems: 'center',
                    flex: 'none',
                  }}
                >
                  {on ? (
                    <i
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: 'var(--color-accent)',
                      }}
                    />
                  ) : null}
                </span>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: on ? 640 : 540,
                    color: on ? 'var(--color-accentink)' : 'var(--color-ink)',
                  }}
                >
                  {scopeLabel(s)}
                </span>
              </button>
            )
          })}
        </Panel>
      </div>
    )
  }

  /* 不能发的人（手打 URL 进来的班主任 / 任课教师）—— 给一句说明，不摆表单 */
  if (!mayPublish) {
    return (
      <>
        <PageHead title="发通知" onBack={() => navigate('/notices')} />
        <Page>
          <Panel>
            <Empty
              icon={<IconAlert size={24} />}
              title="你没有发通知的权限"
              desc="你的收件箱照常能看。"
              action={
                <Button size="sm" onClick={() => navigate('/notices')}>
                  去看通知
                </Button>
              }
            />
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <>
      <PageHead title="发通知" onBack={() => navigate('/notices')} />
      <Page>
        {all.length === 0 ? (
          <Panel className="anim-b in mb-4" bodyClass="p-4">
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <b>暂时拿不到你能发的范围。</b>
              <div className="mt-1" style={{ color: 'var(--color-ink2)' }}>
                请管理员检查通知功能是否已开启。
              </div>
            </div>
          </Panel>
        ) : null}

        <Sect>发给谁</Sect>
        <div className="mb-4">
          {blockOf('school', '全校', '全校所有老师')}
          {blockOf('department', '某个部门', '职能部门（办公室 / 教务处 / 总务处 / 德育处）—— 一个人可以属于多个部门')}
          {blockOf('grade', '本年级', '本年级的老师')}
          {blockOf('subject', '本学科', '本校这一科的所有老师（跨年级）')}
          {blockOf('role', '某个职位', '只列得出比你低的职位')}
          {all.length > 0 && !chosen ? (
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', paddingLeft: 2 }}>
              请选一个范围
            </p>
          ) : null}
        </div>

        <Sect>写什么</Sect>
        <Panel className="mb-4" bodyClass="p-3.5">
          <label style={{ fontSize: 12, color: 'var(--color-ink3)' }}>标题</label>
          <input
            className="mt-1 w-full"
            style={{
              border: '1px solid var(--color-line2)',
              borderRadius: 4,
              padding: '8px 10px',
              fontSize: 14.5,
              background: 'var(--color-surface)',
            }}
            value={title}
            maxLength={TITLE_MAX}
            placeholder="例如：本周三 16:30 全体教师会（报告厅）"
            onChange={(e) => setTitle(e.target.value)}
          />
          <label className="mt-3 block" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
            正文
          </label>
          <textarea
            className="mt-1 w-full"
            style={{
              border: '1px solid var(--color-line2)',
              borderRadius: 4,
              padding: '8px 10px',
              fontSize: 13.5,
              lineHeight: 1.8,
              minHeight: 132,
              background: 'var(--color-surface)',
            }}
            value={body}
            maxLength={BODY_MAX}
            placeholder="时间、地点、要带什么"
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-3" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
            <span>
              正文 <span className="num">{body.length}</span> / {BODY_MAX}
            </span>
            <span className="flex items-center gap-1.5">
              有效期
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                style={{
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  background: 'var(--color-surface)',
                  fontSize: 12,
                }}
              >
                <option value={0}>不过期</option>
                <option value={3}>3 天</option>
                <option value={7}>7 天</option>
                <option value={30}>30 天</option>
              </select>
            </span>
            <span>过期后从列表里消失，但记录不删</span>
          </div>
        </Panel>

        <Button
          block
          variant="primary"
          icon={<IconSend size={17} />}
          disabled={sending || !chosen || !title.trim() || !body.trim()}
          onClick={async () => {
            if (!chosen) return
            setSending(true)
            const res = await publishNotice({
              title: title.trim(),
              body: body.trim(),
              scopeKind: chosen.scopeKind,
              gradeId: chosen.gradeId ?? undefined,
              subjectCode: chosen.subjectCode ?? undefined,
              targetRole: chosen.roleCode ?? undefined,
              /* 🆕 部门那一维（其余维度时它是 undefined → 服务端收到 null） */
              department: chosen.departmentCode ?? undefined,
              expiresInDays: days,
            })
            setSending(false)
            if (res.ok) {
              push({ text: '通知已发出', tone: 'ok' })
              navigate('/notices')
            } else {
              /*
               * 🔴 403 那句话**原样显示**（服务端写的）：它是"你没有给这个范围发通知的权限"，
               *    而不是一句笼统的"操作失败" —— 这一页最需要说清楚的就是这条边界。
               */
              push({ text: res.message, tone: 'bad' })
            }
          }}
        >
          {sending ? '发送中…' : '发出'}
        </Button>
      </Page>
    </>
  )
}
