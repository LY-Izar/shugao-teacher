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
   ============================================================ */

import React from 'react'
import { Button } from './ui'
import { reportFrontendError } from '../lib/errors'

type Props = { children: React.ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    try {
      const view = typeof location === 'undefined' ? '' : location.pathname
      /*
       * ⚠️ 面板自己不许走这条通道（见文件头那条例外）。
       *    它仍然**显示**兜底界面 —— 只是不往那张表里写。
       */
      if (view.startsWith('/admin')) return
      reportFrontendError({
        message: `[渲染] ${error?.message ?? '未知错误'}`,
        stack: `${error?.stack ?? ''}\n--- componentStack ---\n${info?.componentStack ?? ''}`,
        view,
      })
    } catch {
      /* 上报失败什么都不做（绝不能再次抛出） */
    }
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        data-error-boundary
        className="grid min-h-full place-items-center px-6 py-10"
        style={{ background: 'var(--color-canvas)' }}
      >
        <div className="panel w-full overflow-hidden" style={{ maxWidth: 460 }}>
          <div className="p-4" style={{ fontSize: 16, fontWeight: 660 }}>
            这一页出了点问题
          </div>
          <div className="px-4 pb-4" style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--color-ink2)' }}>
            你的数据没有丢。
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
            <div className="mt-3" style={{ fontSize: 12, color: 'var(--color-ink3)' }}>
              点下面的按钮回到工作台。如果一直进不去，把这行错误原文发给管理员。
            </div>
          </div>
          <div className="border-t border-line px-4 py-3">
            <Button
              variant="primary"
              onClick={() => {
                try {
                  this.setState({ error: null })
                  if (typeof location !== 'undefined') location.assign('/')
                } catch {
                  /* 忽略 */
                }
              }}
            >
              回到工作台
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
