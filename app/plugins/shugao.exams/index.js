/**
 * 本班考试插件（P2 首批搬运的第三件：清单 8）
 *
 * 搬自旧教室端 `Classroom.tsx` 的「本班考试」块（P9：走班班"只看作业和考试"的
 * 考试那一半）：
 *   · 数据源 = 宿主资源 `class.exams`（最近 6 场、日期倒序 —— 宿主已按旧页同一条
 *     筛选算好，这里只渲染）；
 *   · 话术照旧页：日期 `MM/DD` · 学科 · 「已定稿 / 批阅中」；
 *   · 旧页在 0 场时整块不摆 —— 插件模型里块由教师启用，空清单显示一句空态
 *     （"没排考试"不是错误，§6.4），这是搬运中唯一一处因模型产生的形态差异。
 *
 * 刻意的写法（与宿主夹具同源）：顶层零副作用；不 import 裸模块；无 DOM 时退化。
 */

export default {
  async activate(ctx) {
    /* 无 DOM（纯 Node 门禁）退化：mk 出来的都是普通对象，setAttribute/append 全空转 ——
       与宿主夹具同一条纪律，不为门禁写两套逻辑。 */
    const hasDom = typeof document !== 'undefined' && typeof document.createElement === 'function'
    const mk = (css, text) => {
      const e = hasDom
        ? document.createElement('div')
        : { style: {}, textContent: '', setAttribute() {}, append() {} }
      if (css) e.style.cssText = css
      if (text !== undefined) e.textContent = text
      return e
    }

    const wrap = mk('')
    wrap.setAttribute('data-exams-slot', '')
    wrap.style.cssText =
      'height:100%;box-sizing:border-box;padding:12px 16px;overflow:auto;' +
      'scrollbar-width:thin;scrollbar-color:var(--color-line2) transparent;' +
      'font-family:system-ui;color:var(--color-ink)'

    const head = mk('display:flex;align-items:center;gap:8px')
    const headTitle = mk('font-weight:700;font-size:14.5px;color:var(--color-ink)', '本班考试')
    const count = mk('flex:1;text-align:right;font-size:11.5px;color:var(--color-ink3)', '')
    head.append(headTitle, count)

    const list = mk('margin-top:8px')
    const empty = mk('font-size:13px;color:var(--color-ink3);line-height:1.8;display:none',
      '最近没有排考试。')
    wrap.append(head, list, empty)
    ctx.ui.container.append(wrap)

    const paint = async () => {
      const { rows } = await ctx.data.read('class.exams')
      count.textContent = rows?.length ? `共 ${rows.length} 场` : ''
      list.innerHTML = ''
      if (!rows?.length) {
        empty.style.display = 'block'
        return
      }
      empty.style.display = 'none'
      for (const e of rows) {
        const row = mk('display:flex;align-items:center;gap:8px;padding:6px 0')
        const date = mk(
          'flex:none;width:48px;font-size:12.5px;color:var(--color-ink2);' +
          "fontVariantNumeric:'tabular-nums'",
          String(e.examDate ?? '').slice(5).replace('-', '/'))
        const subject = mk(
          'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
          'font-size:13.5px;font-weight:550',
          e.subject ?? '')
        const tag = mk(
          'flex:none;font-size:10.5px;padding:1px 7px;border-radius:999px;' +
          (e.status === 'graded'
            ? 'border:1px solid var(--color-line2);background:var(--color-surface);color:var(--color-ink2)'
            : 'border:1px solid var(--color-accent);background:var(--color-accentsoft);color:var(--color-accentink)'),
          e.status === 'graded' ? '已定稿' : '批阅中')
        row.append(date, subject, tag)
        list.append(row)
      }
    }

    await paint()
    ctx.onDispose(ctx.data.watch('class.exams', () => void paint()))
  },

  async deactivate() {},
}
