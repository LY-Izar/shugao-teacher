import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5178,
    watch: {
      /*
       * Windows + 编辑器的原子写入（会先建临时目录再改名替换）会让原生
       * 文件监听抛 EBUSY 并**静默失效** —— 表现为服务器一直发旧代码，
       * 改了不生效、路由对不上。改用轮询，彻底规避这一类问题。
       * node_modules 已被忽略，轮询成本可忽略。
       */
      usePolling: true,
      interval: 400,
      ignored: ['**/node_modules/**', '**/dist/**', '**/.shots/**', '**/*.tmpdir/**', '**/*.tmp'],
    },
  },
})
