import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconChevronRight, IconWifi } from '../components/icons'
import { Emblem } from '../components/Emblem'
import { StarBorder } from '../components/StarBorder'
import { Button } from '../components/ui'
import { useStore, useToast } from '../data/store'
import { loginFailText, toEmail } from '../lib/accounts'
/* 🔴 「提交那一刻从屏上读回真实值」—— 见 `lib/liveInput.ts` 的文件头（登录页吞字的修法） */
import { liveValue } from '../lib/liveInput'
// 🔴 教室端"只让教室端账号登录"：判据与文案都在这一个文件里（见那里的说明）
import { CLASSROOM_ONLY, isClassroomShell } from '../lib/classroomShell'
import { signOutEverywhere } from '../hooks/useAuthBootstrap'
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
  /*
   * 🔴 账号 / 密码从**受控**改成**非受控**（`ref` + `liveValue`，提交时读 DOM）。
   *
   * 真机反馈「登录页还有吞字」，机制与上次公告发布框同源：
   *   受控输入靠 `input` 事件才知道屏上变了 —— 而**这次事件可能不来**：
   *     · 安卓自动填充（密码管理器）是**直接写 DOM** 的，不发 `input`；
   *     · 有些输入法 / 老 WebView 在组字提交那一刻不发 `composition*` 也不发 `input`。
   *   于是**屏上比 state 多几个字**，而点「进入平台」会 `setBusy(true)` ⇒ 一次重渲染
   *   ⇒ React 把**旧 state 写回 DOM** ⇒ 屏上那几个字**当场消失**（就是"吞字"），
   *   而且拿去登录的也是旧值。
   *   非受控之后 React 再也不往这两个框里写值，"点一下把刚打的字冲掉"从结构上不可能；
   *   提交走 `liveValue()` 读屏上那一份 —— 口径见 `lib/liveInput.ts` 文件头（含它的三条边界）。
   */
  const accountRef = useRef<HTMLInputElement>(null)
  const pwdRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    /* 🔴 只读屏上那一份（`liveValue` 只读不写，不与任何 `onChange` 打架） */
    const account = liveValue(accountRef.current, '')
    const pwd = liveValue(pwdRef.current, '')

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
          /* 🔴 A5：**不回显 GoTrue 原文**（原文会漏"账号在不在 / 有没有确认过 / 有没有被限流"） */
          desc: loginFailText(error.message),
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
      /*
       * 🔴🔴 教室端 exe **只让教室端账号登录**（2026-10-03，`lib/classroomShell.ts`）
       *
       * 为什么必须在这里拦：教室端和教师端加载的是**同一份 dist**，
       * 所以教师账号在教室端那台机器上登进来，`accountKind` 是 'teacher'，
       * `App.tsx` 那条 `Navigate to="/classroom"` 就不成立 ——
       * **直接落在教师控制台上**，而那块屏是学生面前的：能看全班成绩、能改数据。
       *
       * 判据用 `accountKind`（= `classroom_accounts` 里有没有自己那一行），
       * 不用 `teachers` 表 —— 见 `remote.loadClassroomAccount()` 的注释。
       *
       * ⚠️ **这只是客户端拦截，不是安全边界**（改 JS 能绕）。
       *    真隔离在数据库 RLS，那条策略还没钉死，属单独立项 —— 别把这里当成"防住了"。
       *
       * ⚠️ 顺序很重要：**先踢掉会话再提示**。反过来的话提示一弹出会话还活着，
       *    用户按一下刷新就又进去了。
       */
      if (isClassroomShell() && kind !== 'classroom') {
        await signOutEverywhere()
        setBusy(false)
        push({ text: CLASSROOM_ONLY.text, tone: 'bad', desc: CLASSROOM_ONLY.desc })
        return
      }
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
          {/* 登录卡：校徽 **48px 全徽**（盒子 55.2 = 48 / 0.87，正好落在 48 这道阈值下限上）。
              🔴 这一格原来有 `border: 1px solid var(--color-line2)` —— 那是"围着盘的第二个框"，
                 §11.2 已整条删掉；**盒子尺寸、位置、间距一个像素没动，只是不画线**。 */}
          <span
            className="draw-all grid place-items-center"
            style={{ width: 58, height: 58, position: 'relative' }}
          >
            <Emblem n={48} />
          </span>
          <h1 style={{ fontSize: 21, fontWeight: 680, letterSpacing: '-.01em', marginTop: 14 }}>
            树高教务通
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
                ref={accountRef}
                defaultValue=""
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
                ref={pwdRef}
                defaultValue=""
                placeholder="输入密码"
                autoComplete="current-password"
              />
            </label>

            {/* 星光（`StarBorder`）—— 只暗色出现；亮色 / reduced-motion 下连元素都不画。
                这一屏**唯一**的动作，独占性满分（判据见 `说明.md` §1.2 P0）。 */}
            <StarBorder data-nav="login-enter">
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
            </StarBorder>

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
