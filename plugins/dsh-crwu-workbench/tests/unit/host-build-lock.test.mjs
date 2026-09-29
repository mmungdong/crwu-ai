import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 构建锁本身的行为（2026-09-29 全量测试偶发红之后加的）。
 *
 * 这一条**不是**在测"并发构建能不能过"（那要几十秒、且偶发），而是在测锁的**语义**：
 * 同一时刻只有一个临界区在里面。少了这条，锁写错了（比如忘了 `await`）也不会有人发现 ——
 * 全量测试仍然会偶发红，而偶发红正是最容易被当成"环境问题"忽略掉的东西。
 */

const { withBuildLock } = await import(new URL('../helpers/build-lock.mjs', import.meta.url).href)

/** 记录临界区的进入 / 离开，用来判断有没有交叠。 */
async function runTwo(delayMs) {
  const events = []
  const critical = async (name) => {
    await withBuildLock(async () => {
      events.push(`enter ${name}`)
      await new Promise((resolve) => { setTimeout(resolve, delayMs) })
      events.push(`exit ${name}`)
    })
  }
  await Promise.all([critical('A'), critical('B')])
  return events
}

test('同一时刻只有一个临界区：两个并发任务不交叠', async () => {
  const events = await runTwo(30)
  // 合法顺序只有两种：A 进 A 出 B 进 B 出，或反过来。
  assert.equal(events.length, 4, JSON.stringify(events))
  assert.equal(events[0].startsWith('enter'), true)
  assert.equal(events[1], events[0].replace('enter', 'exit'), `交叠了：${events.join(' → ')}`)
  assert.equal(events[2].startsWith('enter'), true)
  assert.equal(events[3], events[2].replace('enter', 'exit'), `交叠了：${events.join(' → ')}`)
  assert.notEqual(events[0], events[2], '两个任务都要真的跑过')
})

test('临界区抛错也要释放锁（否则后面所有构建都会等到超时）', async () => {
  await assert.rejects(
    withBuildLock(async () => { throw new Error('构建失败') }),
    /构建失败/,
  )
  // 上一条把锁留住了的话，这一条会一直等 —— 这就是"释放"的判据。
  const started = Date.now()
  const value = await withBuildLock(async () => 'ok')
  assert.equal(value, 'ok')
  assert.equal(Date.now() - started < 5_000, true, '抛错之后锁必须已经被释放')
})

test('嵌套调用同一把锁时给出明确错误，而不是永久挂住', async () => {
  // 真发生嵌套（同一个测试里自己又调一次）时，应该立刻看到"重入"这种明确原因；
  // 这正是把"构建挂住了"从"跑不完"变成"看得出来"的那一步。
  await assert.rejects(
    withBuildLock(async () => await withBuildLock(async () => 'inner', { timeoutMs: 300 })),
    /重入|等构建锁/,
  )
})
