import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  Logo,
  IconCalendar,
  IconChevronRight,
  IconDownload,
  IconLogout,
  IconRefresh,
  IconUsers,
  IconWifi,
} from '../components/icons'
import { Button, KV, PageHead, Panel, Sect, Tag } from '../components/ui'
import { IconAlert } from '../components/icons'
import { activeStudents, useStore, useToast } from '../data/store'
import { signOutEverywhere } from '../hooks/useAuthBootstrap'
import { connectionMode } from '../lib/supabase'
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
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const mode = connectionMode()

  const total = classes.reduce((n, c) => n + activeStudents(c).length, 0)
  const todayCount = itemsForDate(schedule).length
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
                <Tag tone="idle">{teacher?.school ?? '树高中学'}</Tag>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3">
            <KV k="工号" v={<span className="num">T-0001</span>} />
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
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              当前数据保存在本机浏览器（localStorage）。接入 Supabase 后会自动迁移到云端，
              并启用行级权限（RLS）—— 教师只能访问自己任教班级的学生数据。
            </p>
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
            <p style={{ fontSize: 11.5, color: 'var(--color-ink3)', marginTop: 10, lineHeight: 1.7 }}>
              本机演示时：教师端与教室端开在两个标签页即可，呼叫会通过浏览器内通道实时送达。
              跨设备使用需要接入 Supabase Realtime（换掉 <span className="num">lib/realtime.ts</span> 一个文件）。
            </p>
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
            <KV k="当前阶段" v="S2 · 作业档案与收缴" />
            <KV k="版本" v={<span className="num">v0.2.0</span>} />
            <KV k="学段学科" v="高中 · 物理（教科版）" />
            <KV k="存储" v="本地 localStorage" />
          </Panel>
        </div>

        {/* S1 范围说明 */}
        <div className="mb-4">
          <Sect>已实现范围</Sect>
          <Panel bodyClass="p-3">
            <div className="num" style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.1em' }}>
              S1 · 班级与花名册
            </div>
            <ul
              style={{
                fontSize: 12.5,
                color: 'var(--color-ink2)',
                lineHeight: 1.95,
                paddingLeft: 16,
                listStyle: 'disc',
                marginTop: 4,
              }}
            >
              <li>账号登录与教师身份（学科 · 学校）</li>
              <li>班级创建、编辑、删除，当前班级上下文切换</li>
              <li>学生名单：增删改、转班、转出保留历史</li>
              <li>拍照录名单：识别 → 逐行校对 → 序列校验 → 导入</li>
              <li>粘贴导入：自动解析学号与姓名两列</li>
              <li>名单体检：缺号、重号、重名、非数字学号</li>
              <li>数据导出与清空</li>
            </ul>

            <div
              className="num mt-3"
              style={{ fontSize: 11, color: 'var(--color-ink3)', letterSpacing: '.1em' }}
            >
              S2 · 作业档案与收缴
            </div>
            <ul
              style={{
                fontSize: 12.5,
                color: 'var(--color-ink2)',
                lineHeight: 1.95,
                paddingLeft: 16,
                listStyle: 'disc',
                marginTop: 4,
              }}
            >
              <li>练习册模板（作业21 = 1–6 题），题号不依赖图像识别</li>
              <li>作业档案：名称、题目数量、班级、日期（默认前一天）</li>
              <li>收作业查缺：拍一摞作业的侧面识别已交学号</li>
              <li>序列自检：重复号与相邻跳号配对，推断「把某号读成了某号」</li>
              <li>登记表默认全班已交，只标例外；识别结果可随时手工修正</li>
              <li>迟交与未交分开记录</li>
            </ul>

            <div
              className="mt-2 flex items-center gap-2 pt-3"
              style={{
                borderTop: '1px solid var(--color-line)',
                fontSize: 12,
                color: 'var(--color-ink3)',
              }}
            >
              <IconUsers size={15} />
              <span>下一步 S3：快速模式批改录入 + 完成批改</span>
            </div>
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
    </>
  )
}
