/**
 * **原生 shell 执行合同**：把 `platform/shell.ts` 生成的命令真的交给该平台的 shell 跑一遍。
 *
 * ## 为什么需要这一层
 *
 * `tests/unit/host-platform-shell.test.mjs` 断言的是**命令字符串**；字符串对了不等于命令能跑。
 * DSH 在 Windows 上把整条命令作为**一个 argv 元素**交给
 * `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`（POSIX 上是 `bash -c`），
 * 所以这里用完全相同的形状执行，验证三件事：
 *
 * 1. **命令位置**：可执行文件路径含空格 / 单引号 / `$` / 方括号 / 中文时仍能被调用
 *    （Windows 上靠调用运算符 `&`，POSIX 上靠单引号字面量）；
 * 2. **参数原样往返**：参数里的空格、单引号、`$`、反引号、方括号、中文、`;`、`$(…)`
 *    必须原封不动地到达子进程 —— 少一次引用就会被拆词或被当成代码执行；
 * 3. **后置条件与退出码**：`mkdirCommand` 幂等；`removeFileCommand` 删除后目标真的没了、
 *    再删一次仍成功；**真实失败必须非零退出**（不许被 `SilentlyContinue` 吞掉）。
 *
 * 两个 provider 用同一份用例：`pwsh` 在 macOS / Linux 上通常不存在，那一半会自动 skip，
 * 真实覆盖由 `.github/workflows/ci.yml` 的 `windows-powershell` job 提供（runner 默认就是 pwsh，
 * 且**不在 job 级设 `shell: bash`**）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { mkdirCommand, removeFileCommand, shellInvoke } = await import(
  new URL('../../src/host/platform/shell.ts', import.meta.url).href)

/** 参数里把所有会出问题的形状都放进来：空格、单引号、`$`、反引号、方括号、中文、分号、命令替换。 */
const TRICKY_ARG = "Case's $work [1] 中文 `id` $(echo pwned) ; echo INJECTED"

/** 一个自包含的可执行文件被复制到「路径含特殊字符」的目录里，用来验命令位置。 */
const EXEC_DIR_NAME = "Case's $work [1] 中文"

function hasCommand(name, probe) {
  const result = spawnSync(name, probe, { encoding: 'utf8' })
  return result.error === undefined && result.status === 0
}

const PROVIDERS = [
  {
    id: 'posix',
    platform: `${process.platform}-${process.arch}` === 'darwin-arm64' ? 'darwin-arm64' : 'linux-x64',
    available: () => hasCommand('/bin/sh', ['-c', 'exit 0']),
    execName: 'node',
    run: (command) => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  },
  {
    id: 'powershell',
    platform: 'win32-x64',
    available: () => hasCommand('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']),
    execName: 'node.exe',
    // 与 DSH 的 `@deepseek-ai/dsh-pwsh-local` 完全同形：整串命令作为**一个** argv 元素。
    run: (command) => spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  },
]

function makeSandbox(provider) {
  const root = join(tmpdir(), `crwu-shell-contract-${provider.id}-`)
  const dir = join(root, EXEC_DIR_NAME)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const executable = join(dir, provider.execName)
  copyFileSync(process.execPath, executable)
  if (provider.id === 'posix') chmodSync(executable, 0o755)
  return { root, dir, executable }
}

/** 每个 provider 一条子测试；不可用时**显式 skip**（不是静默通过）。 */
for (const provider of PROVIDERS) {
  test(`原生 shell 合同（${provider.id}）`, async (t) => {
    if (!provider.available()) {
      t.skip(`当前机器没有 ${provider.id === 'posix' ? '/bin/sh' : 'pwsh'}：真实覆盖由 CI 的 windows-powershell job 提供`)
      return
    }
    const sandbox = makeSandbox(provider)
    try {
      await t.test('命令位置：可执行文件路径含空格/引号/$/方括号/中文仍能调用', () => {
        const command = shellInvoke(sandbox.executable, ['--version'], provider.platform)
        const result = provider.run(command)
        assert.equal(result.status, 0, `命令没跑起来：${command}\n${result.stderr ?? ''}`)
        assert.match(String(result.stdout), /^v\d+\./, '拿到的应当是 node 的版本号')
      })

      await t.test('参数原样往返：空格 / 单引号 / $ / 反引号 / 方括号 / 中文 / 分号都不被解释', () => {
        const command = shellInvoke(
          sandbox.executable,
          ['-e', 'process.stdout.write(process.argv[1])', TRICKY_ARG],
          provider.platform,
        )
        const result = provider.run(command)
        assert.equal(result.status, 0, `命令没跑起来：${command}\n${result.stderr ?? ''}`)
        assert.equal(String(result.stdout), TRICKY_ARG, `参数被改写了：${String(result.stdout)}`)
        assert.equal(String(result.stdout).includes('INJECTED\n'), false, '命令替换/分号不得被执行')
      })

      await t.test('mkdirCommand 幂等：目标不存在时建出来，已存在时也不报错', () => {
        const target = join(sandbox.dir, '子目录 with space')
        for (const round of [1, 2]) {
          const result = provider.run(mkdirCommand(target, provider.platform))
          assert.equal(result.status, 0, `第 ${String(round)} 次建目录失败：${result.stderr ?? ''}`)
          assert.equal(existsSync(target), true, `第 ${String(round)} 次之后目录应当存在`)
        }
      })

      await t.test('removeFileCommand：删掉后目标真的没了，再删一次仍然成功', () => {
        const target = join(sandbox.dir, "待删文件's.txt")
        writeFileSync(target, 'x')
        const first = provider.run(removeFileCommand(target, provider.platform))
        assert.equal(first.status, 0, `第一次删除失败：${first.stderr ?? ''}`)
        assert.equal(existsSync(target), false, '删除命令返回成功，但文件还在')
        // 幂等：目标本来就不存在时也必须成功（PowerShell 靠 Test-Path 守卫，POSIX 靠 rm -f）。
        const second = provider.run(removeFileCommand(target, provider.platform))
        assert.equal(second.status, 0, `第二次删除（目标已不存在）不该失败：${second.stderr ?? ''}`)
      })

      await t.test('真实失败必须非零退出（不许被 SilentlyContinue 之类吞成成功）', () => {
        // 非空目录：POSIX 的 `rm -f` 与 PowerShell 的 `Remove-Item -Force`（无 -Recurse）都会失败。
        const nonEmpty = join(sandbox.dir, '非空目录')
        mkdirSync(nonEmpty, { recursive: true })
        writeFileSync(join(nonEmpty, 'inner.txt'), 'x')
        const result = provider.run(removeFileCommand(nonEmpty, provider.platform))
        assert.notEqual(result.status, 0, `删除非空目录应当失败，实际退出码 ${String(result.status)}`)
        assert.equal(existsSync(join(nonEmpty, 'inner.txt')), true, '失败时不得真的删掉东西')
      })
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true })
    }
  })
}
