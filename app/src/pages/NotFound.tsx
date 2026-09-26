import { useNavigate } from 'react-router-dom'
import { IconAlert } from '../components/icons'
import { Button, Panel } from '../components/ui'
import { goBackOr } from '../lib/back'

/**
 * 404（`App.tsx` 的 catch-all 路由）。
 *
 * 🔴 **「返回上一页」不许裸用 `navigate(-1)`**：404 最常见的处境恰恰是
 *    **直接打开 / 手打错地址**（书签、外链、地址栏敲错一个字）——
 *    那时这个 SPA 内部没有上一页，裸 `-1` 会把老师**带出应用**
 *    （回到上一个站点，PWA 里就是白屏 / 关掉）。
 *    所以走 `lib/back.ts` 的 `goBackOr(navigate, '/')`：有上一页回上一页，
 *    没有就回兜底 `/`（**与应用里另一颗「回到工作台」同一个去处**，两条路都留在应用里）。
 */
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
          <Button size="sm" onClick={() => goBackOr(navigate, '/')}>
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
