/**
 * 同一浏览器 profile 上的**串行执行队列**（设计稿 §8.3）。
 *
 * ## 为什么必须串行
 *
 * 一个 CLI profile 只有一个真实浏览器：`status` / `login` / `fetch` / `shot` / `recover`
 * 都会导航同一个标签页。两个估值 Agent 同时抓案例时，A 的截图完全可能是 B 的页面 ——
 * 而两张图各自看起来都"正常"，没有任何东西会报错。这就是"案例 A 的证据实际是 B"的来源。
 *
 * 所以首期取最稳的做法：**同一个 profile 上的浏览器操作串行执行**（并发上限 1）。
 * 队列是"同一 profile"一把锁，不是全局一把锁：不同 profile 互不阻塞。
 *
 * ## 三条容易做错的边界
 *
 * 1. **取消只取消调用者自己的那一项**。调用方 A 超时退出时，绝不能把正在跑的 B 的操作一起杀掉
 *    —— 那个浏览器实例可能是员工自己正在用的那个窗口。所以排队中的项可以被丢弃，
 *    正在执行的操作只由它自己的 signal 决定。
 * 2. **队列里不睡觉**。冷却必须由协调器在队列**之外**等待（`challenge-recovery.ts`）：
 *    在队列里 sleep 等于把整个 profile 锁死几十秒，而这段时间别的来源本来可以正常工作。
 * 3. **并发上限是观测事实，不是声明**。`maxConcurrent` 记录真实出现过的最大并发，
 *    测试用它证明"确实串行了"，而不是读一个我们写死的常量。
 */

/** 调用方在排队期间取消时抛出的错误。 */
export class ProfileQueueCancelled extends Error {
  constructor(message = '浏览器操作在排队期间被取消') {
    super(message)
    this.name = 'ProfileQueueCancelled'
  }
}

export interface ProfileQueue {
  /**
   * 在 `profileKey` 上串行执行一次操作。
   *
   * `signal` 只影响**本次调用**：排队期间取消会立刻从队列里移除并 reject；
   * 已经开始执行后取消则交给操作自己（它的 CLI 进程会收到同一个 signal）。
   */
  run<T>(profileKey: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>
  /** 还没开始执行的项数。 */
  queuedCount(profileKey: string): number
  /** 正在执行的操作数（上限 1）。 */
  activeCount(profileKey: string): number
  /** 该 profile 上真实出现过的最大并发。 */
  maxConcurrent(profileKey: string): number
  /** 丢掉还没开始的排队项（例如插件卸载）；返回丢掉几项。正在跑的不动。 */
  dropQueued(profileKey: string): number
}

interface Waiting {
  id: number
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  operation: () => Promise<unknown>
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
}

interface Lane {
  running: boolean
  waiting: Waiting[]
  maxConcurrent: number
}

export function createProfileQueue(): ProfileQueue {
  const lanes = new Map<string, Lane>()
  let nextId = 1

  const laneOf = (key: string): Lane => {
    const existing = lanes.get(key)
    if (existing !== undefined) return existing
    const created: Lane = { running: false, waiting: [], maxConcurrent: 0 }
    lanes.set(key, created)
    return created
  }

  const pump = (key: string): void => {
    const lane = laneOf(key)
    if (lane.running) return
    const next = lane.waiting.shift()
    if (next === undefined) return
    lane.running = true
    if (lane.maxConcurrent < 1) lane.maxConcurrent = 1
    // 已经取消但还没来得及移除的项：直接跳过，不占用这一次执行机会。
    if (next.signal?.aborted === true) {
      lane.running = false
      next.reject(new ProfileQueueCancelled())
      pump(key)
      return
    }
    void next.operation().then(
      (value) => {
        lane.running = false
        next.resolve(value)
        pump(key)
      },
      (error: unknown) => {
        lane.running = false
        next.reject(error)
        pump(key)
      },
    )
  }

  return {
    run<T>(profileKey: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
      const lane = laneOf(profileKey)
      if (signal?.aborted === true) return Promise.reject(new ProfileQueueCancelled())
      return new Promise<T>((resolve, reject) => {
        const entry: Waiting = {
          id: nextId++,
          // 队列只负责搬运值；这里的类型在下面收口成 T。
          resolve: resolve as (value: unknown) => void,
          reject,
          operation: operation as () => Promise<unknown>,
          signal,
          onAbort: undefined,
        }
        if (signal !== undefined) {
          entry.onAbort = () => {
            const index = lane.waiting.indexOf(entry)
            if (index >= 0) {
              lane.waiting.splice(index, 1)
              entry.reject(new ProfileQueueCancelled())
              return
            }
            // 已在执行：不替它做决定，只清掉监听（操作自己拿的是同一个 signal）。
            signal.removeEventListener('abort', entry.onAbort as () => void)
          }
          signal.addEventListener('abort', entry.onAbort, { once: true })
        }
        lane.waiting.push(entry)
        pump(profileKey)
      })
    },

    queuedCount(profileKey: string): number {
      return lanes.get(profileKey)?.waiting.length ?? 0
    },

    activeCount(profileKey: string): number {
      return lanes.get(profileKey)?.running === true ? 1 : 0
    },

    maxConcurrent(profileKey: string): number {
      return lanes.get(profileKey)?.maxConcurrent ?? 0
    },

    dropQueued(profileKey: string): number {
      const lane = lanes.get(profileKey)
      if (lane === undefined) return 0
      const dropped = lane.waiting.splice(0, lane.waiting.length)
      for (const entry of dropped) {
        if (entry.onAbort !== undefined) entry.signal?.removeEventListener('abort', entry.onAbort)
        entry.reject(new ProfileQueueCancelled('浏览器操作队列已被清理'))
      }
      return dropped.length
    },
  }
}
