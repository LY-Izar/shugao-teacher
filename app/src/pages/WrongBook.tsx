import { useNavigate } from 'react-router-dom'
import { Page } from '../components/AppShell'
import { IconAlert, IconChart, IconClipboard, IconTarget, IconUsers } from '../components/icons'
import { Button, PageHead, Panel, Sect, Tag } from '../components/ui'
import { useStore } from '../data/store'

/**
 * 错题集（开发中）。
 *
 * 导航栏先占位，让教师知道这个东西在规划里；点进来把「将来会做什么、
 * 需要什么数据」讲清楚，而不是一句干巴巴的「敬请期待」。
 */
export default function WrongBook() {
  const navigate = useNavigate()
  const classes = useStore((s) => s.classes)
  const assignments = useStore((s) => s.assignments)
  const graded = assignments.filter((a) => a.status === 'graded' || a.status === 'reviewed')
  const totalStudents = classes.reduce(
    (n, c) => n + c.students.filter((s) => s.status === 'active').length,
    0,
  )

  return (
    <>
      <PageHead title="错题集" sub="按学生汇总历次错题" onBack={() => navigate('/')} />

      <Page>
        <div
          className="anim-in mb-4 flex items-start gap-3 p-4"
          style={{
            background: 'linear-gradient(140deg, var(--color-warnsoft), rgb(255 255 255 / 0))',
            border: '1px solid ***REMOVED***ecd9ae',
            borderRadius: 6,
          }}
        >
          <span
            className="grid place-items-center shrink-0"
            style={{
              width: 34,
              height: 34,
              borderRadius: 99,
              background: 'var(--color-surface)',
              border: '1px solid var(--color-line2)',
              color: 'var(--color-warn)',
            }}
          >
            <IconAlert size={18} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 680, color: '***REMOVED***8a5a12' }}>这个功能还在开发中</div>
            <div style={{ fontSize: 12.5, color: '***REMOVED***96702f', marginTop: 4, lineHeight: 1.7 }}>
              先把入口放在这里，免得你找不到。下面是它打算做成什么样 ——
              如果和你想的不一样，直接告诉我，现在改还来得及。
            </div>
          </div>
        </div>

        <div className="mb-4">
          <Sect>它打算做什么</Sect>
          <Panel bodyClass="p-3">
            {[
              [
                IconUsers,
                '每个学生一本错题账',
                '把历次作业里他错过的题按知识点攒起来，谁老在同一个地方摔跤一眼看得出',
              ],
              [
                IconTarget,
                '按人出一份「该重做的题」',
                '不用翻旧本子 —— 直接从他自己的错题里挑几道，打印成一张小卷',
              ],
              [
                IconChart,
                '班级层面的反复错',
                '同一道题或同一个知识点，两周内错了两次以上的，讲评时优先处理',
              ],
              [
                IconClipboard,
                '和现有批改数据打通',
                '不额外增加录入 —— 用的就是你批改时点的那几下',
              ],
            ].map(([Icon, title, desc]) => {
              const I = Icon as typeof IconUsers
              return (
                <div key={title as string} className="flex gap-3 py-2.5">
                  <span
                    className="grid place-items-center shrink-0"
                    style={{
                      width: 30,
                      height: 30,
                      border: '1px solid var(--color-line2)',
                      borderRadius: 4,
                      background: 'var(--color-surface2)',
                      color: 'var(--color-ink3)',
                    }}
                  >
                    <I size={15} />
                  </span>
                  <span>
                    <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>
                      {title as string}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        color: 'var(--color-ink3)',
                        lineHeight: 1.7,
                        marginTop: 1,
                      }}
                    >
                      {desc as string}
                    </span>
                  </span>
                </div>
              )
            })}
          </Panel>
        </div>

        <div className="mb-4">
          <Sect>现在已经攒下的料</Sect>
          <Panel bodyClass="p-3">
            <div
              className="flex flex-wrap items-center gap-x-6 gap-y-2"
              style={{ fontSize: 13, color: 'var(--color-ink2)' }}
            >
              <span className="flex items-center gap-1.5">
                <IconUsers size={15} />
                <b className="num">{totalStudents}</b> 名学生的错题记录
              </span>
              <span className="flex items-center gap-1.5">
                <IconClipboard size={15} />
                来自 <b className="num">{graded.length}</b> 份已批改的作业
              </span>
            </div>
            <p
              style={{
                fontSize: 11.5,
                color: 'var(--color-ink3)',
                marginTop: 10,
                lineHeight: 1.7,
              }}
            >
              数据都已经在云端了，功能接上就能用 —— 缺的只是界面。
              {graded.length === 0 ? '现在还没有已批改的作业，先去批一份试试。' : ''}
            </p>
          </Panel>
        </div>

        <div className="flex gap-2">
          <Button block onClick={() => navigate('/assignments')}>
            去看作业
          </Button>
          <Button
            block
            variant="primary"
            onClick={() => navigate('/settings')}
            icon={<Tag tone="idle">催一下</Tag>}
          >
            告诉开发者我多想要
          </Button>
        </div>
      </Page>
    </>
  )
}
