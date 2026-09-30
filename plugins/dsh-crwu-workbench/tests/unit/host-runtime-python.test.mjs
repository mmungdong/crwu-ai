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
const {
  createPythonRuntimeResolver, pythonVersionOf, distributionsOf, REQUIRED_PYTHON_PACKAGES,
  looksLikeProcessStartFailure, pythonStartFailureReason, DLL_INIT_FAILED,
} = await import(new URL('src/host/runtime/python.ts', ROOT).href)

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
            // 版本探测是唯一一条带 python 路径的命令；其余（控制探测）走 `control*` 那一组。
            const isVersionProbe = String(spec.command).includes(PYTHON)
            return {
              result: async () => (isVersionProbe
                ? {
                    exitCode: options.versionExit ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
                    stdout: { text: options.versionStdout ?? '3.12.4\n', truncated: false },
                    stderr: { text: '', truncated: false },
                    ...(options.versionSandbox === undefined ? {} : { sandbox: options.versionSandbox }),
                  }
                : {
                    exitCode: options.controlExit ?? 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
                    stdout: { text: options.controlStdout ?? 'crwu-python-probe\n', truncated: false },
                    stderr: { text: '', truncated: false },
                    ...(options.controlSandbox === undefined ? {} : { sandbox: options.controlSandbox }),
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

test('版本探测失败要带上结构化事实：exitCode / 沙箱模式 / 是否被拒 / 执行器起不来', async () => {
  // Windows 受限沙箱里的 `0xC0000142`（native 子进程继承管道）与"Python 没装"处置完全不同，
  // 只报一句"无法执行"会把两件事混起来。这几个字段是 DSH 给的**结构化**事实，不靠文本猜。
  const denied = makeHarness({
    versionExit: 1, versionStdout: '',
    versionSandbox: { mode: 'workspace-write', denied: true, runnerFailed: false },
  })
  const d = await denied.resolver.check()
  assert.equal(d.state, 'failed')
  assert.match(d.error, /exitCode 1/)
  assert.match(d.error, /workspace-write/)
  assert.match(d.error, /沙箱拒绝/)

  const runner = makeHarness({
    versionExit: 2, versionStdout: '',
    versionSandbox: { mode: 'read-only', denied: false, runnerFailed: true },
  })
  const r = await runner.resolver.check()
  assert.match(r.error, /read-only/)
  assert.match(r.error, /执行器未启动/)
})

test('受限沙箱里进程起不来：跑一次控制探测，把「沙箱后端坏了」与「子进程句柄有毛病」分开', async () => {
  // 真机现场（2026-09-30）：`exitCode 3221225794 · 沙箱 执行器默认 → workspace-write`，stderr 空。
  // DSH 把它当成一次普通的非零退出（denied / runnerFailed 都是 false），所以必须自己再问一句。
  assert.equal(looksLikeProcessStartFailure({ exitCode: DLL_INIT_FAILED, sandbox: { denied: false, runnerFailed: false } }), true)
  assert.equal(looksLikeProcessStartFailure({ exitCode: -1073741502, sandbox: {} }), true, 'int32 视图也要认')
  assert.equal(looksLikeProcessStartFailure({ exitCode: 1, sandbox: {} }), false)
  assert.equal(looksLikeProcessStartFailure({ exitCode: 0, sandbox: { denied: true } }), true)

  // ② 控制探测也失败 → 是沙箱后端的问题，不是「Python 不可用」。
  const sandboxDown = makeHarness({
    versionExit: DLL_INIT_FAILED, versionStdout: '',
    versionSandbox: { mode: 'workspace-write', denied: false, runnerFailed: false },
    controlExit: DLL_INIT_FAILED, controlStdout: '',
    controlSandbox: { mode: 'workspace-write', denied: false, runnerFailed: false },
  })
  const down = await sandboxDown.resolver.check()
  assert.equal(down.state, 'failed')
  assert.match(down.error, /0xC0000142/)
  assert.match(down.error, /控制探测（纯 PowerShell 命令）\*\*同样失败\*\*/)
  assert.match(down.error, /不是「DSH Python 不可用」/)
  assert.equal(down.blockedBySandbox, true, '控制探测也失败 = 沙箱后端起不了进程')
  assert.equal(sandboxDown.shellCommands.length, 2, '版本探测 + 一次控制探测')
  assert.match(String(sandboxDown.shellCommands[1]), /Write-Output/, '控制探测必须是纯 PowerShell 命令')

  // ③ 控制探测成功 → pwsh 自己能跑，问题在那层捕获（子进程仍在继承句柄）。
  const childOnly = makeHarness({
    versionExit: DLL_INIT_FAILED, versionStdout: '',
    versionSandbox: { mode: 'workspace-write', denied: false, runnerFailed: false },
    controlExit: 0,
  })
  const child = await childOnly.resolver.check()
  assert.match(child.error, /控制探测（纯 PowerShell 命令）\*\*成功\*\*/)
  assert.match(child.error, /临时文件捕获兼容层/)
  assert.equal(child.blockedBySandbox, false, '控制探测成功 = 不是沙箱整体坏了')
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

test('工具报错 = 没问到答案（unresolved），不等于运行时缺失', async () => {
  // 2026-09-29 员工 Windows 实测：同一个工具在会话里返回完整载荷（python + openpyxl 都在），
  // 而环境自检不带 agent 调它时报错。把"没问到"当成"缺失"会直接关掉审核入口。
  const errored = makeHarness({ isError: true, error: { code: 'agent/required', message: 'agent scope required' } })
  const view = await errored.resolver.check()
  assert.equal(view.ok, false)
  assert.equal(view.unresolved, true, '没问到 ≠ 缺失')

  // 工具**成功返回**但载荷里没有 python：这是真·缺失，必须保持 unresolved=false（不许一并放宽）。
  const missing = await makeHarness({ value: { pythonDistributions: {} } }).resolver.check()
  assert.equal(missing.unresolved, false)
  assert.match(missing.error, /没有返回 python 路径/)

  // 成功解析时当然是 false。
  const ok = await makeHarness().resolver.check()
  assert.equal(ok.ok, true)
  assert.equal(ok.unresolved, false)
})
