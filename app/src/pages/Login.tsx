import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Logo, IconChevronRight, IconWifi } from '../components/icons'
import { Button } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { getSupabase, isRemote } from '../lib/supabase'
import { APP_VERSION } from '../lib/version'

export default function Login() {
  const signIn = useStore((s) => s.signIn)
  const hydrate = useStore((s) => s.hydrate)
  const navigate = useNavigate()
  const loc = useLocation() as { state?: { from?: string } }
  const push = useToast((s) => s.push)
  const [account, setAccount] = useState('')
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)

    if (isRemote) {
      const sb = getSupabase()
      const { error } = await sb!.auth.signInWithPassword({
        email: account.trim(),
        password: pwd,
      })
      if (error) {
        setBusy(false)
        push({
          text: '登录失败',
          tone: 'bad',
          desc: error.message === 'Invalid login credentials' ? '邮箱或密码不正确' : error.message,
        })
        return
      }
      await hydrate()
      navigate(loc.state?.from ?? '/', { replace: true })
      return
    }

    setTimeout(() => {
      signIn(account)
      navigate(loc.state?.from ?? '/', { replace: true })
    }, 380)
  }

  return (
    <div className="relative z-[1] flex min-h-full flex-col items-center justify-center px-5 py-10">
      <div className="w-full anim-in" style={{ maxWidth: 372 }}>
        {/* 品牌 */}
        <div className="mb-7 flex flex-col items-center text-center">
          <span
            className="draw-all grid place-items-center"
            style={{
              width: 58,
              height: 58,
              border: '1px solid var(--color-line2)',
              borderRadius: 6,
              background: 'var(--color-surface)',
              color: 'var(--color-accent)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <Logo size={32} strokeWidth={1.5} />
          </span>
          <h1 style={{ fontSize: 21, fontWeight: 680, letterSpacing: '-.01em', marginTop: 14 }}>
            树高教师平台
          </h1>
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.2em',
              color: 'var(--color-ink3)',
              marginTop: 3,
            }}
          >
            TEACHER CONSOLE
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--color-ink3)',
              marginTop: 10,
              maxWidth: 260,
              lineHeight: 1.6,
            }}
          >
            面向高中物理作业全链路：批量录名单、点选批改、一键讲评
          </div>
        </div>

        {/* 表单 */}
        <form onSubmit={submit} className="panel overflow-hidden">
          <div className="panel-head sweep" style={{ position: 'relative' }}>
            <h2>账号登录</h2>
            <span className="flex-1" />
            <span className="tag tag-idle">S1 演示</span>
          </div>

          <div className="flex flex-col gap-4 p-4">
            <label>
              <span className="label">{isRemote ? '邮箱' : '账号 / 工号'}</span>
              <input
                className="input"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={isRemote ? 'teacher@example.com' : '输入账号'}
                autoComplete="username"
                autoFocus
              />
            </label>
            <label>
              <span className="label">密码</span>
              <input
                className="input"
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="输入密码"
                autoComplete="current-password"
              />
            </label>

            <Button
              type="submit"
              variant="primary"
              block
              disabled={busy}
              icon={
                busy ? (
                  <span
                    className="live-dot"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 99,
                      background: '***REMOVED***fff',
                      display: 'inline-block',
                    }}
                  />
                ) : null
              }
            >
              {busy ? '正在进入…' : '进入平台'}
              {!busy ? <IconChevronRight size={16} /> : null}
            </Button>

            <p
              style={{
                fontSize: 12,
                color: 'var(--color-ink3)',
                textAlign: 'center',
                lineHeight: 1.65,
              }}
            >
              {isRemote
                ? '账号由管理员创建，不支持自助注册。'
                : '当前为演示环境，任意账号密码均可进入。'}
            </p>
          </div>
        </form>

        {/* 状态条 */}
        <div
          className="mt-5 flex items-center gap-2 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <IconWifi size={14} />
          <span>
            {isRemote ? '已连接云端 · 手机与教室端共享数据' : '本地存储模式 · 尚未连接 Supabase'}
          </span>
          <span className="flex-1" />
          <span className="num">v{APP_VERSION}</span>
        </div>
      </div>
    </div>
  )
}
