import { useNavigate } from 'react-router-dom'
import { IconAlert } from '../components/icons'
import { Button, Panel } from '../components/ui'

export default function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="relative z-[1] grid min-h-full place-items-center px-5">
      <Panel className="anim-in w-full" bodyClass="p-7 text-center">
        <div className="mx-auto mb-3 grid place-items-center" style={{ width: 46, height: 46, border: '1px solid var(--color-line2)', borderRadius: 6, color: 'var(--color-warn)' }}>
          <IconAlert size={22} />
        </div>
        <div className="num" style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.03em' }}>
          404
        </div>
        <div style={{ fontSize: 14, color: 'var(--color-ink3)', marginTop: 4 }}>
          没有找到这个页面
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" onClick={() => navigate(-1)}>
            返回上一页
          </Button>
          <Button size="sm" variant="primary" onClick={() => navigate('/')}>
            回到工作台
          </Button>
        </div>
      </Panel>
    </div>
  )
}
