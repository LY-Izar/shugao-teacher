/* ============================================================
   React 错误边界（2026-09-29 管理台第二期）
   ------------------------------------------------------------
   🔴 上报的三个入口之一（另两个在 `lib/errors.ts` 的 `installErrorReporting()`）：
      `window.onerror` / `unhandledrejection` **接不住渲染期抛的错** ——
      那正是"整页白屏"最常见的一种。所以必须有一个边界。

   🔴 **它自己绝不能成为错误源**：
      · `componentDidCatch` 里调上报，全程在 `try` 里（`reportFrontendError` 自带 try）；
      · 渲染出来的兜底界面**只用最朴素的元素**（不依赖任何可能出错的业务组件）。

   ⚠️ **面板（`/admin`）自己的报错不走上报通道**（方案 §二.4 写死的那条例外）：
      "面板坏了"会刷满错误表，而面板本来就是用来读错误表的。所以这里用
      `location.pathname.startsWith('/admin')` 判断一下，**只显示、不上报**。
      🔴 **例外中的例外**：分块加载失败在**上报之前就已经自愈过了**
      （`recoverChunkFailure()` 走的是 `lib/errors.ts` 那个封装）——
      面板这一页拉不到分块，恰恰最该留下证据，所以那一档照报不误。

   🆕 **2026-10-06 真机反馈：屏幕上那句话分两档**（用户点名的口径）
      · 分块加载失败 ⇒ 「页面加载失败，请下拉刷新或重进。」＋ **错误码 `FE-CHUNK-01`**
        （调试期再多一行**失败的 URL 小字**，开关在 `lib/chunkReload.ts` 的
         `DEBUG_ERROR_SCREEN` —— 正式期只改那一处）；
      · 其它渲染错误 ⇒ 照旧那一段，但**不再把原始 message 大字贴给老师**，
        改成同形状的一句人话 + 错误码 `FE-RENDER-01`，原文只在调试期显示。
   ============================================================ */

import React from 'react'
import { Button } from './ui'
import { reportFrontendError } from '../lib/errors'
import {
  CHUNK_ERROR_CODE,
  DEBUG_ERROR_SCREEN,
  isChunkFailure,
  selfHealFailed,
} from '../lib/chunkReload'

/** 给老师看的错误码：只有这两个。**上屏的永远是码，不是原文。** */
const RENDER_ERROR_CODE = 'FE-RENDER-01'

type Props = { children: React.ReactNode }
type State = { error: Error | null; chunkFailed: boolean }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, chunkFailed: false }

  static getDerivedStateFromError(error: Error): State {
    /*
     * 🔴 这一句必须在这里判（不能等到 `componentDidCatch`）：它决定的是**屏幕上画什么**。
     *    两者都在 React 的提交阶段跑，但 `getDerivedStateFromError` 是**先**跑的那个。
     */
    return { error, chunkFailed: isChunkFailure(error?.message ?? '') }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      const view = typeof location === 'undefined' ? '' : location.pathname
      const chunk = isChunkFailure(error?.message ?? '')
      /*
       * ⚠️ 面板自己不许走这条通道（见文件头那条例外）—— 分块那一档除外（见上）。
       */
      if (view.startsWith('/admin') && !chunk) return
      reportFrontendError({
        /*
         * 🔴 分块失败这一档**多数情况下到不了这里**（`installChunkRecovery()` 已经先
         *    自愈/上报过了）—— 能到这里的两种情形都值得留痕：
         *    ① 自愈被浏览器挡住（那就得有人知道老师卡在哪一页）；
         *    ② 自愈之后**还是**失败（说明线上真的少了那个分块）。
         */
        message: chunk
          ? `[${CHUNK_ERROR_CODE}][阶段=加载][自愈=${selfHealFailed() ? '仍失败（已重载过 1 次）' : '未执行'}][url=${String(error?.message ?? '').slice(0, 300)}][页面=${view}]`
          : `[渲染] ${error?.message ?? '未知错误'}`,
        stack: `${error?.stack ?? ''}\n--- componentStack ---\n${info?.componentStack ?? ''}`,
        view,
      })
    } catch {
      /* 上报失败什么都不做（绝不能再次抛出） */
    }
  }

  render(): React.ReactNode {
    const { error, chunkFailed } = this.state
    if (!error) return this.props.children
    /*
     * 🔴 上屏的一律是**错误码 + 一句人话**，**不是**原始 message
     *    （用户原话：「用户只用看见 XXXX 发生错误，请即时反馈的弹窗就行了」）。
     *    原文只在 `DEBUG_ERROR_SCREEN` 那一档以小字附在下面，供现在调试期排查。
     */
    const code = chunkFailed ? CHUNK_ERROR_CODE : RENDER_ERROR_CODE
    const headline = chunkFailed ? '页面加载失败' : '这一页出了点问题'
    const human = chunkFailed
      ? '请下拉刷新，或者退出去重新进一次。'
      : '请退出去重新进一次。如果一直进不去，把下面这行错误码发给管理员。'
    return (
      <div
        data-error-boundary
        className="grid min-h-full place-items-center px-6 py-10"
        style={{ background: 'var(--color-canvas)' }}
      >
        <div className="panel w-full overflow-hidden" style={{ maxWidth: 460 }}>
          <div className="p-4" style={{ fontSize: 16, fontWeight: 660 }}>
            {headline}
          </div>
          <div className="px-4 pb-4" style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--color-ink2)' }}>
            {/* 数据没丢是对"渲染出错"说的；分块没拉到这一档数据本来就没动过，不必说 */}
            {!chunkFailed && '你的数据没有丢。'}
            <div className="mt-2">{human}</div>
            {/*
              🔴 错误码：**老师唯一需要转发给我们的东西**（他截一张图就够定位到类别）。
                  永远显示，与调试开关无关。
            */}
            <div className="mt-2" style={{ fontSize: 12.5, color: 'var(--color-ink3)' }}>
              错误码 {code}
            </div>
            {/*
              🔴 **调试期才有的一行**（正式期把 `DEBUG_ERROR_SCREEN` 改成 false 即可）。
                  刻意放小、放灰：它是给我们的，不是给老师的。
            */}
            {DEBUG_ERROR_SCREEN && (
              <div
                className="mt-2 p-2.5"
                style={{
                  background: 'var(--color-surface2)',
                  border: '1px solid var(--color-line)',
                  borderRadius: 4,
                  fontSize: 11.5,
                  color: 'var(--color-ink3)',
                  wordBreak: 'break-word',
                }}
              >
                {String(error.message || '未知错误').slice(0, 300)}
              </div>
            )}
          </div>
          <div className="border-t border-line px-4 py-3">
            <Button
              variant="primary"
              onClick={() => {
                try {
                  this.setState({ error: null })
                  if (typeof location === 'undefined') return
                  /*
                   * 🔴 分块那一档必须是**一次真重载**：失败的是这一份 `index.html`
                   *    写死的旧分块名，软回到 `/` 只会再撞同一面墙 ——
                   *    只有重新取一份 HTML 才可能拿到新分块名。
                   */
                  if (chunkFailed) location.reload()
                  else location.assign('/')
                } catch {
                  /* 忽略 */
                }
              }}
            >
              {chunkFailed ? '刷新页面' : '回到工作台'}
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
