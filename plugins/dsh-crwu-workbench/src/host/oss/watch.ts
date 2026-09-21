import type { Context } from '@deepseek-ai/cordis'
import { runUploadWatch, type AutoUploadDeps } from './auto.ts'
import type { WorkbenchState } from '../state/types.ts'

/**
 * 上传看门狗。
 *
 * 为什么需要它：审核子会话跑完时**不会**通知插件（一次性运行没有回调），而交付件是子会话自己
 * 写到案例目录的。所以只能轮询：每 30 秒看一次，有结果就传。
 *
 * 两条收敛规则：
 * 1. 只处理「当前活动的那条」或「已结束但还没上传的」记录；
 * 2. 一旦没有待上传项就**主动停掉定时器** —— 留着空转会让插件一直占着 timer，
 *    也让「已经传完了」这件事在日志里看起来还在跑。
 *
 * 定时器必须随 Cordis 生命周期释放：句柄存在插件实例的局部变量里，停止时显式清理。
 */

const WATCH_INTERVAL_MS = 30_000

export interface UploadWatch {
  /** 开始（或重启）看门狗；重复调用不会叠加定时器。 */
  start: () => void
  /** 停止看门狗并释放定时器。 */
  stop: () => void
  /** 立刻跑一轮（audit-status 轮询时顺手踢一脚，不必等满 30 秒）。 */
  kick: () => Promise<void>
}

export function createUploadWatch(
  ctx: Context,
  state: WorkbenchState,
  /** 每轮重新取依赖：清单与平台可能在两次 tick 之间变过（用户刚做完环境自检）。 */
  resolveDeps: () => Promise<AutoUploadDeps>,
): UploadWatch {
  let cancel: (() => void) | null = null

  const stop = (): void => {
    if (cancel === null) return
    try {
      cancel()
    } catch (error) {
      // 定时器可能已被 Cordis 释放；忽略即可，不能因此中断停止流程。
      void error
    }
    cancel = null
  }

  const tick = async (): Promise<void> => {
    const pending = await runUploadWatch({ ...await resolveDeps(), state })
    if (!pending) stop()
  }

  const start = (): void => {
    if (cancel !== null) return
    const timer = ctx.get('timer') as { interval?: (callback: () => void, ms: number) => () => void } | undefined
    if (timer === undefined || typeof timer.interval !== 'function') return
    cancel = timer.interval(() => { void tick() }, WATCH_INTERVAL_MS)
  }

  return {
    start,
    stop,
    kick: async () => { await tick() },
  }
}
