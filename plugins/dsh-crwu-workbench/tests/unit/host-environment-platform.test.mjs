/**
 * 平台探测（`src/host/platform/detect.ts`）的单元测试。
 *
 * 这一层为什么值得单独测：`platform` 同时决定「按哪个平台选包内二进制」和「shell 引用怎么写
 * （cmd.exe 不认单引号）」。旧实现一上来就跑 `python3 -c ...`，把**系统 Python** 当成了探针 ——
 * 于是「系统里有没有 python3」变成了「插件包装配对不对」的前置条件，而两者毫无关系。
 *
 * 新口径：Host 事实（`process.platform` + `process.arch`）优先且**不跑任何 shell**；
 * 只有它落在受支持平台集合之外时才跑**一次** `uname -sm` 作为执行世界诊断。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { detectPlatform, hostPlatformKey, normalizePlatform, isWindowsPlatform } = await import(
  new URL('src/host/platform/detect.ts', ROOT).href
)
const { BUNDLED_BIN_PLATFORMS } = await import(new URL('src/host/platform/bin-dir.ts', ROOT).href)

/** 记录命令的 shell 替身；`commandLine` 走的是 `execute().result()`。 */
function shellStub(handler = () => ({ stdout: '' })) {
  const calls = []
  return {
    calls,
    ctx: {
      get: (name) => (name === 'shell'
        ? {
            resolve: (request) => request,
            async execute(spec) {
              calls.push(spec.command)
              const out = handler(spec.command)
              return { result: async () => ({
                exitCode: out.exitCode ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: out.stdout ?? '', truncated: false },
                stderr: { text: out.stderr ?? '', truncated: false },
              }) }
            },
          }
        : undefined),
    },
  }
}

test('受支持平台集合就是包内 bin 目录的那两个（darwin-arm64 / win32-x64）', () => {
  assert.deepEqual([...BUNDLED_BIN_PLATFORMS], ['darwin-arm64', 'win32-x64'])
})

test('Host 事实受支持时不跑任何 shell 探测：进程事实就是唯一口径', async () => {
  for (const host of ['darwin-arm64', 'win32-x64']) {
    const shell = shellStub()
    assert.equal(await detectPlatform(shell.ctx, undefined, host), host)
    assert.deepEqual(shell.calls, [], `${host} 受支持时不该跑任何命令`)
  }
})

test('Host 事实不受支持时才跑一次 uname -sm（执行世界诊断），探测链里没有 python3', async () => {
  const shell = shellStub((command) => (command === 'uname -sm' ? { stdout: 'Linux x86_64\n' } : { stdout: 'Python 3.12.0\n' }))
  const platform = await detectPlatform(shell.ctx, '/tmp/case', 'darwin-x64')

  assert.equal(platform, 'linux-x64')
  assert.deepEqual(shell.calls, ['uname -sm'], `只允许跑一次 uname -sm，实际：${shell.calls.join(' / ')}`)
  for (const command of shell.calls) {
    assert.equal(command.includes('python3'), false, '探测链里不许再拿系统 Python 当探针')
  }
})

test('uname 也没结果时退回 Host 事实，绝不返回空串', async () => {
  const shell = shellStub(() => ({ stdout: '' }))
  assert.equal(await detectPlatform(shell.ctx, undefined, 'linux-x64'), 'linux-x64')
})

test('uname 给出另一个受支持平台时仍以 Host 事实为准（执行世界与包内二进制不可混用）', async () => {
  // SSH / 容器里的 shell 可能跑在别的机器上；包内二进制属于**插件进程所在机器**，
  // 按执行世界去认一份本机用不起来的二进制只会得到「路径在、跑不了」。
  const shell = shellStub(() => ({ stdout: 'Darwin arm64\n' }))
  assert.equal(await detectPlatform(shell.ctx, undefined, 'linux-x64'), 'linux-x64')
})

test('hostPlatformKey 用 normalizePlatform 的同一套键描述进程事实', () => {
  const key = hostPlatformKey()
  assert.equal(key, normalizePlatform(`${process.platform}-${process.arch}`))
  assert.match(key, /^(darwin|win32|linux)-/)
  assert.equal(isWindowsPlatform(key), key.startsWith('win32'))
})
