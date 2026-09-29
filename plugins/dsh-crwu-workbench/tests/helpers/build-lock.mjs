import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 把"真的会构建 / 打包"的测试**串行化**。
 *
 * ## 为什么需要它
 *
 * `node --test` 并行跑测试**文件**。有两个测试会真的驱动构建系统：
 *
 * - `host-package.test.mjs`：`npm pack` → 触发 `prepack`（`skills:sync` + `prepare.mjs --force`），
 *   它会**重写包根的 `lib/`**；
 * - `host-prepare-script.test.mjs`：在临时目录里真跑一次 tsdown，而那个目录的 `node_modules`
 *   是**软链到包根**的（见该测试的注释）—— 于是两个构建共享同一套依赖与缓存目录。
 *
 * 它们并行时互相踩：2026-09-29 全量跑第一次红在 `an installed tarball can actually be installed
 * and imported`（同一条命令单独跑 39/39 通过）；手工在同一个包里并发跑两次 `npm pack`
 * 也能稳定复现其中一个失败（`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`）。
 *
 * ⚠️ **不要用"失败就重试一次"遮掉这件事**：那会把真实的打包失败也吞成通过。
 * 这里用锁把临界区真的串起来，谁先拿到谁先做，另一个等。
 *
 * 实现用 `mkdir` 而不是锁文件：`mkdir` 是**原子**的（EEXIST 即"已被占用"），
 * 不需要"先判断再创建"那种有窗口的写法，也不依赖任何第三方库。
 */
const LOCK_DIR = join(tmpdir(), 'crwu-build-lock')

/** 等锁时的轮询间隔与总等待上限（构建最长也就几十秒，超时说明有别的东西卡住了）。 */
const POLL_MS = 250
const WAIT_LIMIT_MS = 10 * 60_000

/** 本进程是否已经持有锁（识别重入，避免自己把自己等死）。 */
let held = false

/** 超过这个年龄的锁视为**陈旧**（持有者被 Ctrl-C 杀掉时会留下它）。 */
const STALE_MS = 15 * 60_000

async function sleep(ms) {
  await new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 在锁里跑 `body`。
 *
 * 拿不到锁时**不是失败**，而是等待 —— 这是"排队"不是"互斥失败"。
 * 唯一会抛的情况是等过了 `WAIT_LIMIT_MS`（那时把锁目录留在原地，方便排查是谁没释放）。
 */
export async function withBuildLock(body, options = {}) {
  const started = Date.now()
  // **重入**是自己咬自己：同一个进程里已经持有锁，再等下去只会等到超时。
  // 用一个进程内的计数器立刻识别它，把"跑不完"变成"看得出来"。
  if (held === true) {
    throw new Error(`构建锁重入：本进程已持有 ${LOCK_DIR}（同一个测试里不要再调一次 withBuildLock）`)
  }
  const limit = options.timeoutMs ?? WAIT_LIMIT_MS
  let acquired = false
  for (;;) {
    try {
      await mkdir(LOCK_DIR)
      acquired = true
      held = true
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 陈旧锁：持有者被杀掉时不会有人来清它，否则后面所有构建都会等到超时。
      try {
        const info = await stat(LOCK_DIR)
        if (Date.now() - info.mtimeMs > STALE_MS) {
          await rm(LOCK_DIR, { recursive: true, force: true })
          continue
        }
      } catch {
        // 锁刚好被别人释放了：下一轮循环立刻就能拿到。
        continue
      }
      if (Date.now() - started > limit) {
        throw new Error(`等构建锁超过 ${String(Math.round(limit / 1_000))} 秒：${LOCK_DIR}`)
      }
      await sleep(POLL_MS)
    }
  }
  assert: {
    if (acquired !== true) throw new Error(`构建锁没有拿到：${LOCK_DIR}`)
    break assert
  }
  try {
    return await body()
  } finally {
    held = false
    await rm(LOCK_DIR, { recursive: true, force: true })
  }
}
