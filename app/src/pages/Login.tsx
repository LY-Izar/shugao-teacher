import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Logo, IconChevronRight, IconWifi } from '../components/icons'
import { Button } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { toEmail } from '../lib/accounts'
import { getSupabase, isRemote } from '../lib/supabase'
import { markLogin, setDeviceRole } from '../lib/session'
import { APP_VERSION_LABEL } from '../lib/version'

/*
 * 登录名 → 邮箱：`toEmail()` 在 `lib/accounts.ts`。
 *
 * 🔴 **必须和「教师账号」页建号时用的是同一个函数**（那里也调它）：
 *    两边规则不一致就会出现"账号建出来了、在登录页却敲不进去"这种查半天的问题。
 *    ⚠️ 后缀还必须和 `functions/api/classroom-account.ts` 里的 EMAIL_DOMAIN 一致，
 *       否则教室端账号在那边建出来、在这边登不进去。
 */

export default function Login() {
  const signIn = useStore((s) => s.signIn)
  const hydrate = useStore((s) => s.hydrate)
  const navigate = useNavigate()
  const loc = useLocation() as { state?: { from?: string; expired?: boolean } }
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
        email: toEmail(account),
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
      markLogin()
      /*
       * 这台设备按**这个账号的身份**用。
       * 教室端账号登录的就是一体机本身，别把它标成教师端 ——
       * 否则 Guard 会先按"这台设备被当过教室端"把它踢回登录页，来回弹。
       * 身份是 hydrate() 里查 classroom_accounts 得出的，不是靠猜。
       */
      const kind = useStore.getState().accountKind
      setDeviceRole(kind === 'classroom' ? 'classroom' : 'teacher')
      navigate(loc.state?.from ?? '/', { replace: true })
      return
    }

    setTimeout(() => {
      signIn(account)
      markLogin()
      setDeviceRole('teacher')
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
            批量录名单 · 点选批改 · 一键讲评
          </div>
        </div>

        {/* 表单 */}
        <form onSubmit={submit} className="panel overflow-hidden">
          <div className="panel-head sweep" style={{ position: 'relative' }}>
            <h2>账号登录</h2>
            <span className="flex-1" />
            {/*
             * 这里原先是「S1 演示」—— 那是"分阶段交付 S1–S5"时期留下的标签，
             * 平台早就过了那个阶段，留着只会让人误以为这是演示版（正式环境上尤其误导）。
             * 换成**当前版本号 + 构建哈希**：排查"线上跑的是哪一版"时，
             * 登录页是所有人第一眼看到的那一屏（以前只能去比对线上 JS 的文件哈希）。
             */}
            <span className="tag tag-idle num" title="前端版本">
              {APP_VERSION_LABEL}
            </span>
          </div>

          <div className="flex flex-col gap-4 p-4">
            {loc.state?.expired ? (
              <div
                className="p-2.5"
                style={{
                  background: 'var(--color-warnsoft)',
                  border: '1px solid var(--color-warnline)',
                  borderRadius: 4,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  color: 'var(--color-warnink)',
                }}
              >
                距上次在这台设备上登录已超过 <b>7 天</b>，请重新输入一次密码。
              </div>
            ) : null}
            <label>
              <span className="label">{isRemote ? '邮箱 / 账号' : '账号 / 工号'}</span>
              <input
                className="input"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={isRemote ? '邮箱，或直接敲 QQ 号 / 账号名' : '输入账号'}
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
                      background: 'var(--color-onaccent)',
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

        {/* 状态条（版本号不在这里重复一遍：它已经在上面「账号登录」右侧那一枚标签上） */}
        <div
          className="mt-5 flex items-center gap-2 px-1"
          style={{ fontSize: 11.5, color: 'var(--color-ink4)' }}
        >
          <IconWifi size={14} />
          <span>
            {isRemote ? '已连接云端 · 手机与教室端共享数据' : '本地存储模式 · 尚未连接'}
          </span>
        </div>
      </div>
    </div>
  )
}
