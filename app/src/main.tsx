import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { installImeMirror } from './lib/imeMirror'

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
