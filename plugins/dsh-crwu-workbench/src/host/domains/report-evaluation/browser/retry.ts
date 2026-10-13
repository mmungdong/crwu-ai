/**
 * 外部页面的**尝试策略**：每个分页 URL 最多尝试三次。
 *
 * 为什么是"有界重试"而不是随手 `for` 循环：
 * - 上限必须是**代码里的常量**（`MARKET_ATTEMPTS`），不是调用方传进来的数字 ——
 *   外部站点风控会按请求频率封禁，"再多试几次"是最容易把员工 IP 送进黑名单的做法；
 * - 每次失败都要**留下证据**（第几次、什么错），否则事后只能看到"这个来源没结果"，
 *   分不清"站点没有案例"与"被风控拦了"。
 *
 * 这一层不碰网络：它只负责"跑几次、记什么"，于是可以被穷尽单测（含"绝不尝试第四次"）。
 */

/** 每个分页 URL 的尝试上限。改这个数字要连 README / 结果契约一起改。 */
export const MARKET_ATTEMPTS = 3

export interface AttemptOutcome<T> {
  ok: boolean
  /** 成功时的值；失败时为 `undefined`。 */
  value?: T
  /** 真正尝试了几次（1..MARKET_ATTEMPTS）。 */
  attempts: number
  /** 每一次失败的原因（按顺序）；成功时只含先前失败的记录。 */
  errors: string[]
}

export interface AttemptOptions {
  /** 覆盖上限（**只用于测试**；生产路径一律用 `MARKET_ATTEMPTS`）。 */
  attempts?: number
  /** 每次尝试之前调用（attempt 从 1 开始）；用于记录诊断。 */
  onAttempt?: (attempt: number) => void
  /** 每次失败之后调用。 */
  onFailure?: (attempt: number, error: string) => void
  /** 两次尝试之间的等待（毫秒）；返回 Promise 以支持注入的计时器。 */
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  return String(cause)
}

/**
 * 最多尝试 `attempts` 次；**成功即停**，失败到上限就带着全部错误返回。
 *
 * 刻意**不**在最后一次之后 sleep：那会白白多等一个周期（用户已经拿到失败结论了）。
 */
export async function withAttempts<T>(
  run: (attempt: number) => Promise<T>,
  options: AttemptOptions = {},
): Promise<AttemptOutcome<T>> {
  const limit = Math.max(1, Math.min(options.attempts ?? MARKET_ATTEMPTS, 10))
  const errors: string[] = []
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    options.onAttempt?.(attempt)
    try {
      const value = await run(attempt)
      return { ok: true, value, attempts: attempt, errors }
    } catch (cause) {
      const error = describe(cause)
      errors.push(error)
      options.onFailure?.(attempt, error)
      // 还有下一次才等待：失败结论不需要再多等一个周期。
      if (attempt < limit) {
        const ms = options.delayMs ?? 0
        if (ms > 0 && typeof options.sleep === 'function') await options.sleep(ms)
      }
    }
  }
  return { ok: false, attempts: limit, errors }
}
