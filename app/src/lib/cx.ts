/** 极小的类名拼接工具。放在独立文件里，避免组件文件导出非组件内容而破坏 HMR。 */
export const cx = (...v: Array<string | false | null | undefined>) =>
  v.filter(Boolean).join(' ')
