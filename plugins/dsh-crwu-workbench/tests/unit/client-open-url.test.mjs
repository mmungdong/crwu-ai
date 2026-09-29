/**
 * 「优先内置浏览器」这一层的测试。
 *
 * 为什么值得单独测：它是 2026-09-29 用户指出「钉钉登录还是用的外置浏览器」的那一处判断，
 * 而且降级路径（服务缺席 / 标签类型未启用 / 异步失败）**每一条都必须还能打开**——
 * 静默什么都不开，比开在外部浏览器更糟。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { openUrlWithBuiltinFirst } = await import(new URL('src/client/features/environment/open-url.ts', ROOT).href)

const URL_UNDER_TEST = 'https://login.dingtalk.com/oauth2/auth?x=1'

test('有内置浏览器时：开在侧栏 browser 标签，且不碰系统浏览器', () => {
  const calls = []
  const external = []
  const result = openUrlWithBuiltinFirst(
    { sidebarRight: { openTab: (kind, options) => { calls.push({ kind, options }) } } },
    URL_UNDER_TEST,
    { openExternal: (url) => { external.push(url) } },
  )
  assert.equal(result, 'builtin')
  assert.deepEqual(calls, [{ kind: 'browser', options: { params: { url: URL_UNDER_TEST } } }])
  assert.deepEqual(external, [], '开在内置浏览器时不该再弹系统浏览器')
})

test('没有内置浏览器服务时：退回系统浏览器', () => {
  const external = []
  const result = openUrlWithBuiltinFirst({}, URL_UNDER_TEST, { openExternal: (url) => { external.push(url) } })
  assert.equal(result, 'external')
  assert.deepEqual(external, [URL_UNDER_TEST])
})

test('标签类型未启用（openTab 抛错）时：仍然要打开，不能静默失败', () => {
  const external = []
  const result = openUrlWithBuiltinFirst(
    { sidebarRight: { openTab: () => { throw new Error('unknown tab type: browser') } } },
    URL_UNDER_TEST,
    { openExternal: (url) => { external.push(url) } },
  )
  assert.equal(result, 'external')
  assert.deepEqual(external, [URL_UNDER_TEST])
})

test('openTab 异步失败时也退回系统浏览器', async () => {
  const external = []
  const result = openUrlWithBuiltinFirst(
    { sidebarRight: { openTab: () => Promise.reject(new Error('tab rejected')) } },
    URL_UNDER_TEST,
    { openExternal: (url) => { external.push(url) } },
  )
  assert.equal(result, 'builtin', '同步阶段先按内置浏览器返回')
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  assert.deepEqual(external, [URL_UNDER_TEST], '异步失败后必须补开一次')
})
