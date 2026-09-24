import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  Logo,
  IconAlert,
  IconCalendar,
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconPencil,
  IconRefresh,
  IconUpload,
  IconWifi,
} from '../components/icons'
import { Button, KV, PageHead, Panel, Sect, Sheet, Tag } from '../components/ui'
import { activeStudents, useStore, useToast } from '../data/store'
import { signOutEverywhere } from '../hooks/useAuthBootstrap'
import { connectionMode } from '../lib/supabase'
import { APP_VERSION } from '../lib/version'
import {
  backupSummary,
  downloadJson,
  makeBackup,
  pushBackupToCloud,
  readJsonFile,
  validateBackup,
} from '../lib/backup'
import { REMIND_BEFORE, itemsForDate } from '../lib/schedule'
import { beijingNow, holidayDataInfo, ymdOf } from '../lib/holiday'

export default function Settings() {
  const teacher = useStore((s) => s.teacher)
  const classes = useStore((s) => s.classes)
  const schedule = useStore((s) => s.schedule)
  const currentClassId = useStore((s) => s.currentClassId)
  const setCurrentClass = useStore((s) => s.setCurrentClass)
  const resetDemo = useStore((s) => s.resetDemo)
  const clearAll = useStore((s) => s.clearAll)
  const restoreBackup = useStore((s) => s.restoreBackup)
  const bkRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const mode = connectionMode()

  /* 编辑教师身份 */
  const updateTeacher = useStore((s) => s.updateTeacher)
  const [editing, setEditing] = useState(false)
  const [fName, setFName] = useState('')
  const [fSchool, setFSchool] = useState('')
  const [fSubject, setFSubject] = useState('')
  const openEdit = () => {
    setFName(teacher?.name ?? '')
    setFSchool(teacher?.school ?? '')
    setFSubject(teacher?.subject ?? '物理')
    setEditing(true)
  }

  const total = classes.reduce((n, c) => n + activeStudents(c).length, 0)
  // 只看教师自己的排课表 —— 班级课表（scope='class'）是教室端给学生看的，混进来数字会对不上
  const todayCount = itemsForDate(schedule.filter((s) => s.scope !== 'class')).length
  const holidayInfo = holidayDataInfo()

  const exportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      teacher,
      classes,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `树高教师平台-数据导出-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    push({ text: '已导出全部数据', tone: 'ok', desc: 'JSON 格式，不锁定在平台内' })
  }

  return (
    <>
      <PageHead title="我的" sub="账号 · 数据 · 关于" />
      <Page>
        {/* 身份 */}
        <Panel className="anim-in mb-4 overflow-hidden">
          <div className="flex items-center gap-3 p-4">
            <span
              className="grid place-items-center shrink-0"
              style={{
                width: 46,
                height: 46,
                border: '1px solid var(--color-line2)',
                borderRadius: 6,
                background: 'var(--color-surface2)',
                color: 'var(--color-accent)',
              }}
            >
              <Logo size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <div style={{ fontSize: 17, fontWeight: 660 }}>{teacher?.name ?? '未登录'}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <Tag tone="accent">{teacher?.subject ?? '物理'}</Tag>
                <Tag tone="idle">{teacher?.school || '未填学校'}</Tag>
              </div>
            </div>
            <Button size="sm" variant="ghost" icon={<IconPencil size={14} />} onClick={openEdit}>
              编辑
            </Button>
          </div>
          <div className="px-4 pb-3">
            <KV k="任教班级" v={`${classes.length} 个 · ${total} 名学生`} />
            <KV
              k="当前班级"
              v={
                <select
                  className="input"
                  style={{ height: 32, fontSize: 13, width: 'auto', display: 'inline-block' }}
                  value={currentClassId ?? ''}
                  onChange={(e) => setCurrentClass(e.target.value || null)}
                >
                  {classes.length === 0 ? <option value="">暂无班级</option> : null}
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
        </Panel>

        {/* 我的课表 */}
        <div className="mb-4">
          <Sect>我的</Sect>
          <Panel className="overflow-hidden">
            <button type="button" className="row" style={{ padding: 14 }} onClick={() => navigate('/files')}>
              <span
                className="grid place-items-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  background: 'var(--color-surface2)',
                  color: 'var(--color-accent)',
                }}
              >
                <IconUpload size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ fontSize: 14.5, fontWeight: 620 }}>教室端文件</span>
                <span className="mt-0.5 block" style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}>
                  把题图、PDF、HTML、PPT 传到教室一体机上打开
                </span>
              </span>
              <IconChevronRight size={16} />
            </button>
            <button type="button" className="row" style={{ padding: 14 }} onClick={() => navigate('/schedule')}>
              <span
                className="grid place-items-center shrink-0"
                style={{
                  width: 36,
                  height: 36,
                  border: '1px solid var(--color-line2)',
                  borderRadius: 4,
                  background: 'var(--color-surface2)',
                  color: 'var(--color-accent)',
                }}
              >
                <IconCalendar size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span style={{ fontSize: 14.5, fontWeight: 620 }}>我的课表</span>
                <span
                  className="mt-0.5 block"
                  style={{ fontSize: 11.5, color: 'var(--color-ink3)' }}
                >
                  录入上课与日程 · 上课前 {REMIND_BEFORE} 分钟提醒
                </span>
              </span>
              <Tag tone={todayCount > 0 ? 'accent' : 'idle'}>今天 {todayCount} 项</Tag>
              <IconChevronRight size={16} />
            </button>
          </Panel>
        </div>

        {/* 备份与恢复 */}
        <div className="mb-4">
          <Sect>备份与恢复</Sect>
          <Panel bodyClass="p-3">
            <input
              ref={bkRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try {
                  const v = validateBackup(await readJsonFile(f))
                  if (!v.ok) {
                    push({ text: v.why, tone: 'bad' })
                    return
                  }
                  const yes = window.confirm(
                    `确定用这份备份覆盖当前数据吗？\n\n${backupSummary(v.data)}\n备份时间：${new Date(v.data.at).toLocaleString()}\n\n当前数据会被替换，此操作不可撤销。`,
                  )
                  if (!yes) return
                  restoreBackup(v.data)
                  const msg = await pushBackupToCloud(v.data, teacher?.id ?? '')
                  push({ text: msg, tone: 'ok' })
                } catch (err) {
                  push({ text: err instanceof Error ? err.message : '这个文件读不了', tone: 'bad' })
                }
              }}
            />
            <div className="flex flex-col gap-2">
              <Button
                block
                icon={<IconDownload size={16} />}
                onClick={() => {
                  const b = makeBackup(useStore.getState())
                  downloadJson(b, `树高备份-${ymdOf(beijingNow())}.json`)
                  push({ text: `已导出：${backupSummary(b)}`, tone: 'ok' })
                }}
              >
                导出备份文件
              </Button>
              <Button block icon={<IconUpload size={16} />} onClick={() => bkRef.current?.click()}>
                从备份文件恢复
              </Button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              云端是主副本，这份备份是<b>额外</b>一道保险。主要防两件事：
              误点下面的「清空全部数据」、以及换账号时把数据搬过去。
            </p>
          </Panel>
        </div>

        {/* 数据 */}
        <div className="mb-4">
          <Sect>数据</Sect>
          <Panel bodyClass="p-3">
            <div className="flex flex-col gap-2">
              <Button block icon={<IconDownload size={16} />} onClick={exportJson}>
                导出全部数据（JSON）
              </Button>
              <Button
                block
                icon={<IconRefresh size={16} />}
                onClick={() => {
                  resetDemo()
                  push({ text: '已重置为演示数据', tone: 'ok' })
                }}
              >
                重置为演示数据
              </Button>
              <Button
                block
                variant="danger"
                onClick={() => {
                  clearAll()
                  push({ text: '已清空全部数据', tone: 'warn', desc: '包含班级与学生名单' })
                  navigate('/login', { replace: true })
                }}
              >
                清空全部数据
              </Button>
            </div>
          </Panel>
        </div>

        {/* 教室端 */}
        <div className="mb-4">
          <Sect>教室端</Sect>
          <Panel bodyClass="p-3">
            <div
              className="mb-3 flex items-start gap-2.5"
              style={{ fontSize: 12.5, color: 'var(--color-ink2)', lineHeight: 1.7 }}
            >
              <IconWifi size={15} />
              <span>
                在教室一体机上用 <b>Edge / Chrome</b> 打开下面这个地址，点一次「启动置顶小窗」即可。
                小窗会浮在全屏的新教育平台之上，显示当前题号与正确率。
              </span>
            </div>
            <div
              className="flex items-center gap-2 p-3"
              style={{
                background: 'var(--color-surface2)',
                border: '1px solid var(--color-line)',
                borderRadius: 4,
              }}
            >
              <code
                className="flex-1 truncate"
                style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--color-ink2)' }}
              >
                {typeof window !== 'undefined'
                  ? `${window.location.origin}/classroom`
                  : '/classroom'}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  const url = `${window.location.origin}/classroom`
                  void navigator.clipboard?.writeText(url)
                  push({ text: '已复制教室端地址', tone: 'ok' })
                }}
              >
                复制
              </Button>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <Button
                size="sm"
                block
                icon={<IconChevronRight size={14} />}
                onClick={() => window.open('/classroom', '_blank')}
              >
                在新标签页打开教室端
              </Button>
            </div>
          </Panel>
        </div>

        {/* 节假日数据来源 */}
        <div className="mb-4">
          <Sect>节假日与调休</Sect>
          <Panel bodyClass="px-4 py-2">
            <KV
              k="数据存储"
              v={
                mode === 'remote' ? (
                  <Tag tone="ok">云端 · 跨设备同步</Tag>
                ) : (
                  <Tag tone="warn">本机浏览器 · 未连云端</Tag>
                )
              }
            />
            <KV
              k="数据来源"
              v={
                holidayInfo.latest ? (
                  <span className="num">{holidayInfo.latest.docNo}</span>
                ) : (
                  '未加载'
                )
              }
            />
            <KV k="覆盖年份" v={`${holidayInfo.years.join('、')} 年`} />
            <KV
              k="校准时间"
              v={<span className="num">{ymdOf(beijingNow())}（北京时间）</span>}
            />
          </Panel>
          {!holidayInfo.coversThisYear ? (
            <div
              className="mt-2 flex items-start gap-2.5 p-3"
              style={{
                background: 'var(--color-warnsoft)',
                border: '1px solid ***REMOVED***ecd9ae',
                borderRadius: 6,
              }}
            >
              <span style={{ color: 'var(--color-warn)', marginTop: 1 }}>
                <IconAlert size={16} />
              </span>
              <div style={{ fontSize: 12.5, color: '***REMOVED***8a5a12', lineHeight: 1.65 }}>
                还没有今年的放假安排 —— 假期与调休判断会按普通周历走。
                国务院通常每年 11 月发布次年安排，发布后运行
                <span className="num"> npm run fetch:holidays </span>
                即可更新。
              </div>
            </div>
          ) : (
            <p
              style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.7 }}
            >
              放假与调休安排取自中国政府网发布的国务院办公厅通知，由
              <span className="num"> scripts/fetch-holidays.mjs </span>
              解析生成；判断一律按北京时间。
            </p>
          )}
        </div>

        {/* 关于 */}
        <div className="mb-4">
          <Sect>关于</Sect>
          <Panel bodyClass="px-4 py-2">
            <KV k="平台" v="树高教师平台" />
            <KV k="版本" v={<span className="num">v{APP_VERSION}</span>} />
            <KV k="学段学科" v="高中 · 物理（教科版）" />
            <KV
              k="存储"
              v={mode === 'remote' ? '云端 · 手机与教室端共用一份' : '本机浏览器 · 未连云端'}
            />
          </Panel>
        </div>

        {/* 更新日志 */}
        <div className="mb-4">
          <Sect>更新日志</Sect>
          <Panel bodyClass="p-3">
            {[
              {
                v: '0.8.0',
                at: '9 月 26 日',
                items: [
                  '作业档案可同时布置给多个班（每个班各生成一份，批改统计各算各的）',
                  '完成批改分成两条路：临时保存（可随时接着批）／确认完成（未批改的登记为未交）',
                  '新增「改错登记」：逐个点过关，谁改完了、谁还没改一目了然',
                  '需重点关注名单：批改时点「找」标一下，改错登记里置顶提醒',
                  '新增「极简模式」：不带练习册也能用，只记每人 优 / 良 / 差',
                  '题号上不再有会误触的「+」：双击拆小题、长按改小题数',
                  '布置日期建完之后也能改',
                  '教室端：考试一键静音（全屏黑底时钟）、下课前 5 分钟轻声提示',
                  '教室端：调休日可手动选「今天按周几的课表上」，周一早三节自动顺延',
                  '教室端：晚上 7:20 后换成收尾语，0 点自动恢复；节日和周末倒计时',
                  '教室端：拍照识别课表后可逐条核对修改时间再导入',
                  '教师端可把题图 / PDF / HTML / PPT 传到教室一体机上打开，文件不占云端',
                  '错题集：按知识点统计丢分、生成错题重练卷（Word）、一键备份与恢复',
                  '批改中途切出去不会丢进度，回来接着批',
                  '所有名单统一按学号排序；呼叫记录只留最近 3 条',
                ],
              },
              {
                v: '0.7.0',
                at: '9 月 19 日',
                items: [
                  '云端同步：手机与教室端共用一份数据，呼叫真的能跨设备送达',
                  'Word 稿一键导入建立作业档案（题量 / 题型 / 分值 / 小问自动识别，可逐题改）',
                  '作业情况新增「题型掌握情况」：每个题型丢几分、正确率多少',
                  '课表支持批量录入与课表文件导入，上课前 10 分钟提醒',
                  '拍照查缺改为真识别：先数本数，够数直接判全过',
                  '法定假期与调休按官方安排自动判定（含调休上班日）',
                ],
              },
              {
                v: '0.5.0',
                at: '9 月 18 日',
                items: [
                  '逐题错误率与讲评优先级（30–70% 优先精讲）',
                  '改错一键呼叫：教室端全屏播报 + 置顶小窗',
                  '教室端：系统语音播报、逐题正确率、压在全屏应用之上的小窗',
                  '快速批改录入：点学号就地展开题号，默认全对只记错的',
                ],
              },
              {
                v: '0.2.0',
                at: '9 月 17 日',
                items: [
                  '班级与花名册：拍照/粘贴导入、序列自检、名单体检',
                  '作业档案与收作业查缺、未交与迟交分开记录',
                ],
              },
            ].map((log) => (
              <div key={log.v} className="mb-3 last:mb-0">
                <div className="flex items-baseline gap-2">
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700 }}>
                    v{log.v}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}>{log.at}</span>
                </div>
                <ul
                  style={{
                    fontSize: 12.5,
                    color: 'var(--color-ink2)',
                    lineHeight: 1.9,
                    paddingLeft: 16,
                    listStyle: 'disc',
                    marginTop: 2,
                  }}
                >
                  {log.items.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            ))}
          </Panel>
        </div>

        <Button
          block
          icon={<IconLogout size={16} />}
          onClick={() => {
            void signOutEverywhere()
            navigate('/login', { replace: true })
          }}
        >
          退出登录
        </Button>
      </Page>

      {/* 编辑教师身份 */}
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title="我的身份"
        footer={
          <Button
            block
            variant="primary"
            disabled={!fName.trim()}
            onClick={() => {
              updateTeacher({
                name: fName.trim(),
                school: fSchool.trim(),
                subject: fSubject.trim() || '物理',
              })
              setEditing(false)
              push({ text: '已保存', tone: 'ok' })
            }}
          >
            保存
          </Button>
        }
      >
        <label className="block">
          <span className="label">姓名</span>
          <input
            className="input"
            value={fName}
            onChange={(e) => setFName(e.target.value)}
            placeholder="例如 王老师"
          />
        </label>
        <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 6, lineHeight: 1.65 }}>
          这个名字会出现在问候语和账目里。刚注册时它默认取邮箱前缀，建议改成本名。
        </p>
        <label className="mt-4 block">
          <span className="label">学校</span>
          <input
            className="input"
            value={fSchool}
            onChange={(e) => setFSchool(e.target.value)}
            placeholder="例如 示例中学"
          />
        </label>
        <label className="mt-4 block">
          <span className="label">学科</span>
          <input
            className="input"
            value={fSubject}
            onChange={(e) => setFSubject(e.target.value)}
            placeholder="例如 物理"
          />
        </label>
      </Sheet>
    </>
  )
}
