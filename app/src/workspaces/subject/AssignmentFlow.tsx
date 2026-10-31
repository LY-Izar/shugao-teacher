import { useNavigate } from 'react-router-dom'
import { useStore } from '../../data/store'

/** 同一份作业的三个工作阶段；只提供入口，数据与写入仍由原页面处理。 */
export function AssignmentFlow({ id, step }: { id: string; step: string }) {
  const navigate = useNavigate()
  const assignment = useStore((s) => s.assignments.find((a) => a.id === id))
  if (!assignment) return null

  const prefix = `/assignments/${id}`
  const reviewReady = assignment.status === 'graded' || assignment.status === 'reviewed'
  return <div className="assignment-flow-wrap">
    <nav className="assignment-flow" aria-label={`${assignment.title} · 作业流程`}>
      <div className="assignment-flow-title">
        <span>作业情况 / {assignment.title}</span>
        <button type="button" onClick={() => navigate('/assignments')}>返回作业列表</button>
      </div>
      <div className="assignment-flow-steps">
        <div className={step === 'collect' ? 'active' : ''}>
          <button type="button" className="assignment-flow-small" onClick={() => navigate(`${prefix}/collect#photo`)}>拍照清查</button>
          <button type="button" className="assignment-flow-main" onClick={() => navigate(`${prefix}/collect`)}>上交统计</button>
        </div>
        <div className={step === 'grade' ? 'active' : ''}>
          <button type="button" className="assignment-flow-main" onClick={() => navigate(`${prefix}/grade`)}>作业批改</button>
          <span className="assignment-flow-small">逐人批阅</span>
        </div>
        <div className={['stats', 'correct', 'call'].includes(step) ? 'active' : ''}>
          <button type="button" className="assignment-flow-main" onClick={() => navigate(`${prefix}/stats`)}>错题统计·过关</button>
          {reviewReady ? <button type="button" className="assignment-flow-small" onClick={() => navigate(`${prefix}/correct`)}>改错过关</button>
            : <span className="assignment-flow-small">完成批改后登记过关</span>}
        </div>
      </div>
    </nav>
  </div>
}
