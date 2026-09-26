/**
 * DSH 自带 Python 解析器（`src/host/runtime/python.ts`）的测试。
 *
 * 用户口径：**技能脚本用 DSH 自带的运行时，不再把系统 `python3` 当依赖**。所以这里钉的是
 * 四条不能回退的规则：
 * 1. `load_workspace_dependencies` **只调一次**，成功结果缓存（失败不缓存，可显式刷新重试）；
 * 2. 拿到的路径必须**真的是可执行文件**，并且真的能跑出版本 —— 工具返回的字符串本身不是证据；
 * 3. 关键包（`openpyxl`）缺失 → 明确 capability gap / missing-package，绝不静默换系统 Python；
 * 4. 源码里**没有**硬编码的 DSH 安装路径，也**不改 PATH**。
 *
 * 全部替身都在内存里：不跑真实 shell、不碰真实运行时。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { createPythonRuntimeResolver, pythonVersionOf, distributionsOf, REQUIRED_PYTHON_PACKAGES } = await import(
  new URL('src/host/runtime/python.ts', ROOT).href
)

const PYTHON = '/dsh/runtimes/primary/dependencies/python/bin/python3'

function makeHarness(options = {}) {
  const toolCalls = []
  const shellCommands = []
  const stats = options.stats ?? { [PYTHON]: { type: 'file' } }
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          async execute(input) {
            toolCalls.push({ name: input.name, agent: input.agent })
            if (input.name !== 'load_workspace_dependencies') {
              return { isError: true, error: { code: 'unexpected', message: `不应调用 ${input.name}` } }
            }
            return {
              isError: options.isError === true,
              ...(options.isError === true ? { error: options.error ?? { code: 'runtime/missing', message: 'no runtime' } } : {}),
              value: options.value ?? {
                python: PYTHON,
                pythonPackages: '/dsh/runtimes/primary/dependencies/python/lib/python3.12/site-packages',
                pythonDistributions: { openpyxl: '3.1.5', pandas: '3.0.1', numpy: '2.3.5' },
              },
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) { return stats[target.targetKey] },
        }
      }
      if (name === 'shell') {
        return {
          resolve: (request) => request,
          async execute(spec) {
            shellCommands.push(spec.command)
            return {
              result: async () => ({
                exitCode: options.versionExit ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
                stdout: { text: options.versionStdout ?? '3.12.4\n', truncated: false },
                stderr: { text: '', truncated: false },
              }),
            }
          },
        }
      }
      return undefined
    },
  }
  const resolver = createPythonRuntimeResolver({
    ctx,
    world: {
      platform: async () => 'darwin-arm64',
      home: async () => '/Users/x',
      workdir: async () => '/cases/session',
      cached: () => ({ platform: 'darwin-arm64', home: '/Users/x' }),
    },
  })
  return { resolver, toolCalls, shellCommands }
}

test('只解析一次：第二次直接读缓存，显式 refresh 才重问 DSH', async () => {
  const { resolver, toolCalls, shellCommands } = makeHarness()
  const first = await resolver.check()
  assert.equal(first.ok, true)
  assert.equal(first.path, PYTHON)
  assert.equal(first.versionText, '3.12.4')
  assert.equal(first.source.includes('DSH 自带'), true, '来源必须写清是 DSH 自带，不能让人以为是系统 Python')
  assert.equal(toolCalls.length, 1)

  const second = await resolver.check()
  assert.equal(second.ok, true)
  assert.equal(toolCalls.length, 1, '成功结果必须缓存，不要每次自检都问一次 DSH')

  await resolver.check({ refresh: true })
  assert.equal(toolCalls.length, 2, '显式刷新要重新解析（员工现场升了运行时）')
  assert.equal(shellCommands.length, 2, '每次解析都跑一次版本探测，证明它真能执行')
})

test('caller 的 agent scope 一路传进工具调用（走完整 policy pipeline）', async () => {
  const { resolver, toolCalls } = makeHarness()
  const agent = { id: 'parent-1' }
  await resolver.check({ agent })
  assert.equal(toolCalls[0].agent, agent)
})

test('工具不可用 / 没有返回路径：报 capability gap，而不是「未安装 python3」', async () => {
  const missing = makeHarness({ value: {} })
  const noPath = await missing.resolver.check()
  assert.equal(noPath.ok, false)
  assert.equal(noPath.state, 'capability-gap')
  assert.match(noPath.error, /DSH 自带运行时不可用/)
  assert.equal(noPath.error.includes('python3'), false, '不许把结论说成「没装 python3」')

  const errored = makeHarness({ isError: true, error: { code: 'runtime/unavailable', message: 'runtime not installed' } })
  const failed = await errored.resolver.check()
  assert.equal(failed.state, 'capability-gap')
  assert.match(failed.error, /load_workspace_dependencies 报错/)
})

test('返回的路径必须真的是文件，并且真的能执行出版本', async () => {
  const notAFile = makeHarness({ stats: { [PYTHON]: { type: 'directory' } } })
  const dir = await notAFile.resolver.check()
  assert.equal(dir.ok, false)
  assert.equal(dir.state, 'failed')
  assert.match(dir.error, /不是普通文件/)

  const gone = makeHarness({ stats: {} })
  const absent = await gone.resolver.check()
  assert.equal(absent.state, 'failed')
  assert.match(absent.error, /路径不存在/)

  const cannotRun = makeHarness({ versionExit: 1, versionStdout: '' })
  const broken = await cannotRun.resolver.check()
  assert.equal(broken.state, 'failed')
  assert.match(broken.error, /无法执行/)
})

test('缺 openpyxl：报 missing-package（含包名），且失败不进缓存、下次可重试', async () => {
  const { resolver, toolCalls } = makeHarness({
    value: { python: PYTHON, pythonDistributions: { numpy: '2.3.5' } },
  })
  const view = await resolver.check()
  assert.equal(view.ok, false)
  assert.equal(view.state, 'missing-package')
  assert.deepEqual(view.missingPackages, [...REQUIRED_PYTHON_PACKAGES])
  assert.match(view.error, /openpyxl/)
  assert.equal(view.error.includes('pip'), true, '要说明本插件不自动 pip 安装，交给部署方')
  assert.equal(resolver.cached(), null, '失败不得缓存')
  await resolver.check()
  assert.equal(toolCalls.length, 2, '失败后下一次调用允许重试')
})

test('版本表归一与版本号提取（只认包名 → 版本字符串）', () => {
  assert.equal(pythonVersionOf('3.12.4\n'), '3.12.4')
  assert.equal(pythonVersionOf('Python 3.11.5'), '3.11.5')
  assert.equal(pythonVersionOf('没有版本'), '')
  assert.deepEqual(distributionsOf({ openpyxl: '3.1.5', nested: { a: 1 }, empty: '' }), { openpyxl: '3.1.5' })
})

test('解析器源码里没有硬编码的 DSH 安装路径，也不改 PATH', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('src/host/runtime/python.ts', ROOT), 'utf8')
  // 只看**代码行**：注释里举「不要写死什么」的例子是有价值的（说的正是这条纪律本身），
  // 真正要禁的是代码里出现固定安装位置。
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
    })
    .join('\n')
  for (const forbidden of ['/Applications/DeepSeek Harness.app', 'dsh-runtimes', 'process.argv', 'process.env.PATH']) {
    assert.equal(code.includes(forbidden), false, `不许硬编码 ${forbidden}`)
  }
  assert.equal(/(^|[^A-Za-z_])PATH\s*=/.test(code), false, '不许改 PATH')
  assert.equal(code.includes('execPath'), false, '不许拿 Node 自己的可执行文件去猜运行时')
})
