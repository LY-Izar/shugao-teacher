/* ============================================================
   一条通道 · 多个订阅者（扇出）
   ------------------------------------------------------------
   🔴 为什么必须有它（2026-10-24 教室端首页报错换来的）：

   supabase 的 `client.channel(名字)` **不是"新建一条通道"** —— 同名通道还活着时，
   它把**同一个对象**原样返回。而 realtime-js 里有一条硬规则：

     cannot add `postgres_changes` callbacks for realtime:xxx after `subscribe()`

   即：已经 join（或正在 join）的通道上再 `.on('postgres_changes', …)` **直接抛错**。
   于是"两个地方各自 subscribe()"的老写法，第二个调用必然炸 —— 而它抛在 useEffect 里，
   被 React 的错误边界接住，教室端整块屏就只剩一张报错卡（FE-RENDER-01）。

   ⚠️ 它**只在后端模式下炸**：本地模式的订阅走 BroadcastChannel，谁来都能挂。
   所以本地跑门禁永远绿，线上教室端一进去就白 —— 这类"只有线上才复现"的坑，
   只能靠把通道的所有权收归一处来根除，而不是靠测试去撞。

   约定：通道由这里统一持有 —— 第一个订阅者开通道，其余只在本地登记；
   最后一位走的时候关掉。调用方**可以随便 subscribe() 几次**。
   ============================================================ */

export type Dispose = () => void

export type Fanout<M> = {
  /** 把一条消息发给所有订阅者 */
  emit: (m: M) => void
  /** 登记一位订阅者；返回退订函数。第一位会在此时开通道 */
  subscribe: (fn: (m: M) => void) => Dispose
  /** 现在几位订阅者（测试与调试用） */
  readonly subscriberCount: number
  /** 通道开到第几条（测试与调试用） */
  readonly generation: number
}

export function createFanout<M, C>(opts: {
  /** 第一条通道的名字；之后第 N 条是 `${baseTopic}-${N}` */
  baseTopic: string
  open: (topic: string) => C
  close: (c: C) => void
}): Fanout<M> {
  const listeners = new Set<(m: M) => void>()
  let channel: C | null = null
  let generation = 0

  /**
   * ⚠️ 每个订阅者**单独 try**：一个订阅者抛错不该把后面的人一起带走。
   * 抛在这里的症状是"某块屏静默不更新"，正是本项目最怕的那种
   * "不报错但就是不对" —— 所以兜住它并留下 warn，而不是让它扩散。
   */
  function emit(m: M) {
    for (const fn of [...listeners]) {
      try {
        fn(m)
      } catch (err) {
        console.warn('[realtime] 订阅者抛错（已隔离）:', err)
      }
    }
  }

  function ensure() {
    if (channel) return
    generation += 1
    /*
     * 🔴 代数后缀（不是洁癖）：`removeChannel` 是**异步**的 —— 旧通道在我们新建的
     * 这一刻可能还没走完 unsubscribe。名字一样就会被 `channel()` 复用、`.on()` 当场抛错。
     * 换个名字就绕开这段竞态。第一条仍叫原名，控制台/后台日志里好认。
     */
    channel = opts.open(generation === 1 ? opts.baseTopic : `${opts.baseTopic}-${generation}`)
  }

  return {
    emit,
    subscribe(fn: (m: M) => void): Dispose {
      listeners.add(fn)
      ensure()
      return () => {
        listeners.delete(fn)
        if (listeners.size > 0 || !channel) return
        const c = channel
        channel = null
        try {
          opts.close(c)
        } catch (err) {
          console.warn('[realtime] 关闭通道失败:', err)
        }
      }
    },
    get subscriberCount() {
      return listeners.size
    },
    get generation() {
      return generation
    },
  }
}
