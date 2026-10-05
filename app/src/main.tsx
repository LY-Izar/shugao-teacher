import './lib/legacy'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { installImeMirror } from './lib/imeMirror'
import { installChunkRecovery } from './lib/chunkReload'

/*
 * 🔴 分块加载失败的**自愈**（2026-10-06 真机反馈：安卓 10 上登录时
 *    `Failed to fetch dynamically imported module: …/Workbench-<旧哈希>.js`）。
 *    根因与修法写在 `lib/chunkReload.ts` 的文件头：
 *    老师浏览器里留着**上一版的 index.html**（写死旧分块名），新部署一上线旧分块就没了。
 *
 * 🔴 **必须在这里、`createRoot(...)` 之前调**（理由：`lazy()` 失败比 `useEffect` 早得多，
 *    装在 effect 里就接不住"第一次进这一页"那一半现场）——
 *    且自愈会抢在 React 把错误画上屏之前发生 ⇒ 老师看到的是"重载一下进去了"。
 */
installChunkRecovery()

/*
 * 🔴 输入法组字的**全局镜像**：装一次，之后"屏上有什么、React 状态里就有什么"
 *    （不装的话，apk 上拼音还没选词就点按钮，那几个字会被一次重渲染冲掉 ——
 *     根因与三条边界写在 `lib/imeMirror.ts` 的文件头）。
 * ⚠️ 必须在 `createRoot(...)` **之前**装：首次渲染之前就该生效。
 */
installImeMirror()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
