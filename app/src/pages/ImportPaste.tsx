import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page } from '../components/AppShell'
import {
  IconAlert,
  IconCamera,
  IconCheck,
  IconChevronRight,
  IconPaste,
} from '../components/icons'
import { Button, PageHead, Panel, Sect, Tag } from '../components/ui'
import { useStore, useToast, type ImportMode } from '../data/store'
import { FLAG_TEXT, parseRosterText, validateRows } from '../lib/roster'

const SAMPLE = `学号\t姓名
1\t王志远
2\t李思涵
3\t张雨欣
4\t刘佳怡
5\t陈明轩
6\t杨嘉豪
7\t黄雅静
8\t赵子涵
9\t吴欣悦
10\t周明
11\t徐博文
12\t孙志强
13\t马晓明`

export default function ImportPaste() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const push = useToast((s) => s.push)
  const klass = useStore((s) => s.classes.find((c) => c.id === id))
  const addStudents = useStore((s) => s.addStudents)

  const [text, setText] = useState('')
  const [mode, setMode] = useState<ImportMode>('merge')

  const parsed = useMemo(() => parseRosterText(text), [text])
  const rows = useMemo(() => validateRows(parsed, klass?.students ?? []), [parsed, klass])

  const bad = rows.filter((r) => r.flag).length
  const updatable = rows.filter((r) => r.existing).length

  if (!klass) {
    return (
      <>
        <PageHead title="班级不存在" onBack={() => navigate('/classes')} />
        <Page>
          <Panel bodyClass="p-6 text-center">
            <div style={{ fontSize: 14, color: 'var(--color-ink3)' }}>请返回重新选择班级</div>
          </Panel>
        </Page>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="粘贴导入名单"
        sub={klass.name}
        onBack={() => navigate(`/classes/${klass.id}`)}
        right={
          <Button
            size="sm"
            variant="ghost"
            icon={<IconCamera size={15} />}
            onClick={() => navigate(`/classes/${klass.id}/import/photo`)}
          >
            改用拍照
          </Button>
        }
      />

      <Page>
        <div className="mb-2">
          <Sect>第 1 步 · 粘贴内容</Sect>
          <Panel bodyClass="p-3">
            <textarea
              className="input"
              rows={7}
              placeholder={'每行一条，支持从 Excel 直接复制：\n1  王志远\n2  李思涵\n3,张雨欣\n4、刘佳怡'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5 }}
            />
            <div className="mt-2.5 flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setText(SAMPLE)}>
                填入示例
              </Button>
              {text ? (
                <Button size="sm" variant="ghost" onClick={() => setText('')}>
                  清空
                </Button>
              ) : null}
              <span className="flex-1" />
              <span style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
                自动识别学号与姓名两列
              </span>
            </div>
          </Panel>
        </div>

        <div className="mb-2">
          <Sect>第 2 步 · 校验结果</Sect>
          <Panel className="overflow-hidden">
            {rows.length === 0 ? (
              <div className="empty">
                <IconPaste size={24} />
                <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>还没有内容</div>
                <div style={{ fontSize: 13 }}>粘贴后这里会显示校验结果</div>
              </div>
            ) : (
              <>
                <div
                  className="flex items-center gap-2 px-3 py-2"
                  style={{ borderBottom: '1px solid var(--color-line)' }}
                >
                  <Tag tone="accent">解析 {rows.length} 行</Tag>
                  {bad ? <Tag tone="warn">{bad} 行待确认</Tag> : <Tag tone="ok">全部正常</Tag>}
                  {updatable ? <Tag tone="idle">{updatable} 人已存在将更新</Tag> : null}
                </div>
                <div className="max-h-[38vh] overflow-y-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 56 }}>行</th>
                        <th style={{ width: 70 }}>学号</th>
                        <th>姓名</th>
                        <th style={{ width: 96 }}>校验</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.key} data-flag={r.flag ? 'true' : undefined}>
                          <td className="num" style={{ color: 'var(--color-ink4)' }}>
                            {i + 1}
                          </td>
                          <td className="num" style={{ fontWeight: 600 }}>
                            {r.studentNo || '—'}
                          </td>
                          <td>{r.name || '—'}</td>
                          <td>
                            {r.flag ? (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: 'var(--color-warn)', fontSize: 12 }}
                              >
                                <IconAlert size={13} />
                                {FLAG_TEXT[r.flag]}
                              </span>
                            ) : (
                              <span
                                className="flex items-center gap-1"
                                style={{ color: 'var(--color-ok)', fontSize: 12 }}
                              >
                                <IconCheck size={13} />
                                正常
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>
        </div>

        <div className="mb-4">
          <Sect>第 3 步 · 导入方式</Sect>
          <Panel bodyClass="p-3">
            <div className="seg">
              <button type="button" data-on={mode === 'merge'} onClick={() => setMode('merge')}>
                合并
              </button>
              <button type="button" data-on={mode === 'append'} onClick={() => setMode('append')}>
                追加
              </button>
              <button type="button" data-on={mode === 'replace'} onClick={() => setMode('replace')}>
                覆盖
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--color-ink3)', marginTop: 8, lineHeight: 1.6 }}>
              {mode === 'merge'
                ? '按学号合并：同学号则更新姓名，新学号则新增。日常补录推荐。'
                : mode === 'append'
                  ? '仅新增，已存在的学号会被跳过。'
                  : '删除该班原有名单后重新写入。仅用于整班覆盖。'}
            </p>
          </Panel>
        </div>

        <Button
          block
          variant="primary"
          disabled={rows.length === 0}
          icon={<IconChevronRight size={16} />}
          onClick={() => {
            const clean = rows.filter((r) => !r.flag).map((r) => ({ studentNo: r.studentNo, name: r.name }))
            if (clean.length === 0) {
              push({ text: '没有可导入的正常行', tone: 'bad' })
              return
            }
            const { added, updated } = addStudents(klass.id, clean, mode)
            push({
              text: `导入完成：新增 ${added} 人，更新 ${updated} 人`,
              tone: 'ok',
              desc: bad ? `有 ${bad} 行因校验未通过被跳过` : undefined,
            })
            navigate(`/classes/${klass.id}`)
          }}
        >
          导入 {rows.filter((r) => !r.flag).length} 条
        </Button>
        {bad ? (
          <p
            style={{
              fontSize: 12,
              color: 'var(--color-warn)',
              textAlign: 'center',
              marginTop: 8,
              lineHeight: 1.6,
            }}
          >
            待确认的 {bad} 行不会导入，请修正后重新粘贴。
          </p>
        ) : null}
      </Page>
    </>
  )
}
