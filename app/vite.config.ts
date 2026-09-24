import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5178,
    /*
     * 🔴 **`strictPort` 必须为 true**（2026-09-27 加，审计实测的事故）：
     * 不写它时，5178 被占（另一个 checkout 的 dev server、上一次没关干净的进程、
     * 别人的调试实例）vite 会**静默改到 5179** 并照常打印 "ready"，
     * 而 `shots.mjs` / `clock-checks.mjs` 打的是**写死的 5178** ——
     * 于是脚本可能在测**别人更早起的那个 server**（甚至另一个 checkout 的代码），
     * 断言全绿、图也对，测的却不是这一份源码。这是最难查的一类假通过。
     * 打开它之后端口被占会**直接报错退出**（错误信息里写着 5178 在用），
     * 让人当场看见，而不是偷偷换端口。
     */
    strictPort: true,
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
