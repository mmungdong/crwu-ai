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

const {
  chmodCommand, currentUidCommand, grantModifyAclCommand, mkdirCommand, pathWritableCommand,
  homeProbeCommand, lockProbeCommand, parseLockProbe, privateFileCommand, readFileModeCommand,
  removeFileCommand,
  shellInvoke, shellQuote, statOwnerModeCommand,
  windowsAclVerdictCommand, windowsModifyProbeCommand,
} = await import(new URL('../../src/host/platform/shell.ts', import.meta.url).href)
const { text } = await import(new URL('../../src/shared/utils/value.ts', import.meta.url).href)
const { parseAclVerdict } = await import(new URL('../../src/host/dws/local.ts', import.meta.url).href)

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

      await t.test('本机权限探测命令：真的能读出所有者/模式/可写性（协议 18 · 子项目 D）', async () => {
        // 这一组是「本机文件权限问题」判据的**唯一**事实来源（`dws-local-doctor` 用它），
        // 所以不能只断言命令字符串：必须在真 shell 上跑出可解析的结果。
        const dir = join(sandbox.dir, 'perm-probe')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, "状态文件's.json")
        writeFileSync(file, '{}')

        if (provider.id === 'posix') {
          const ownerMode = provider.run(statOwnerModeCommand(dir, provider.platform))
          assert.equal(ownerMode.status, 0, `stat 失败：${ownerMode.stderr ?? ''}`)
          const parts = String(ownerMode.stdout).trim().split(/\s+/)
          assert.match(parts[0] ?? '', /^\d+$/, `第一个字段应当是 uid：${String(ownerMode.stdout)}`)
          assert.match(parts[1] ?? '', /^[0-7]{3,4}$/, `第二个字段应当是八进制模式：${String(ownerMode.stdout)}`)

          const uid = provider.run(currentUidCommand(provider.platform))
          assert.equal(uid.status, 0, `id -u 失败：${uid.stderr ?? ''}`)
          assert.equal(String(uid.stdout).trim(), parts[0], 'stat 的 uid 与 id -u 必须一致（同一份事实）')

          // 可写探测：自己建的目录必须可写。
          assert.equal(provider.run(pathWritableCommand(dir, provider.platform)).status, 0, '自己建的临时目录必须可写')

          // `homeProbeCommand`：执行世界与 Host 本地主目录不一致时的**兜底探测**，
          // 此前也从没真跑过（`detectHome` 只在 `os.homedir()` 拿不到时才用它）。
          const homeRun = provider.run(homeProbeCommand(provider.platform))
          assert.equal(homeRun.status, 0, `主目录探测失败：${homeRun.stderr ?? ''}`)
          const probedHome = String(homeRun.stdout).trim()
          assert.notEqual(probedHome, '', `探测到的主目录不能是空的：${JSON.stringify(String(homeRun.stdout))}`)
          if (text(process.env.HOME) !== '') {
            assert.equal(probedHome, text(process.env.HOME), 'shell 探测与 Host 本地主目录必须一致（同一份事实）')
          }
          // Windows 方言只问 PowerShell 自己的环境变量（不许先跑 python3 之类）。
          const winHome = homeProbeCommand('win32-x64')
          assert.match(winHome, /\$env:USERPROFILE/, `Windows 主目录探测走环境变量：${winHome}`)
          assert.equal(/python3|Get-Command/.test(winHome), false, `不许串上别的探测：${winHome}`)

          // `privateFileCommand`（凭据 0600）同样从没真跑过：它是"保存凭据"的写入口，
          // 而"保存成功没有"由**回读模式**决定（P-08/P-09/M-04）。这里把写-读一对真跑一次。
          const secret = join(dir, "凭据's.json")
          writeFileSync(secret, '{}')
          spawnSync('/bin/sh', ['-c', `chmod 644 ${shellQuote(secret, provider.platform)}`], { encoding: 'utf8' })
          assert.equal(provider.run(privateFileCommand(secret, provider.platform)).status, 0,
            'privateFileCommand 必须能真的把模式设成 600')
          const secretMode = String(provider.run(statOwnerModeCommand(secret, provider.platform)).stdout).trim().split(/\s+/)[1]
          assert.equal(secretMode, '600', `凭据文件回读必须是 600：${secretMode}`)

          // 修复命令只接受 700/600（刻意的窄口径）：目录 700、规则文件 600，且**必须回读**。
          assert.equal(provider.run(chmodCommand('700', dir, provider.platform)).status, 0)
          assert.equal(provider.run(chmodCommand('600', file, provider.platform)).status, 0)
          const fileMode = provider.run(statOwnerModeCommand(file, provider.platform))
          assert.equal(String(fileMode.stdout).trim().split(/\s+/)[1], '600', '回读的模式必须是收紧后的')
          // `readFileModeCommand`（只回模式）从来没被真跑过 —— 而"只断言命令字符串"正是
          // `stat -f %u %Lp` 缺引号那次漏洞的成因（见本文件末尾的说明）。这里真跑一次：
          // 它与 `statOwnerModeCommand` 是**同一份事实的两个读者**，必须一致。
          const modeOnly = provider.run(readFileModeCommand(file, provider.platform))
          assert.equal(modeOnly.status, 0, `readFileModeCommand 失败：${modeOnly.stderr ?? ''}`)
          assert.match(String(modeOnly.stdout).trim(), /^[0-7]{3,4}$/,
            `应当是八进制模式（不是 uid/模式两段）：${String(modeOnly.stdout)}`)
          assert.equal(String(modeOnly.stdout).trim(), String(fileMode.stdout).trim().split(/\s+/)[1],
            '两个读者读到的模式必须一致（同一份事实）')
          // 两种方言不能互换：darwin 用 `-f %Lp`、其它 POSIX 用 `-c %a`。
          assert.match(readFileModeCommand(file, 'darwin-arm64'), /stat -f %Lp /)
          assert.match(readFileModeCommand(file, 'linux-x64'), /stat -c %a /)
          // 带空格 / 单引号 / 中文的路径必须整段引用（历史缺陷就是这里漏引号）。
          for (const dialect of ['darwin-arm64', 'linux-x64']) {
            const command = readFileModeCommand(file, dialect)
            assert.equal(command.includes(`'${file.replace(/'/g, "'\\''")}'`), true,
              `${dialect} 的路径没有被引用：${command}`)
          }

          // 窄口径本身也要钉住：别的模式一律拒绝（否则这一层就成了通用 chmod）。
          assert.throws(() => chmodCommand('777', file, provider.platform), /只接受 700 \/ 600/)

          // 不可写时探测必须报非零（夹具侧用原生 chmod 造，测的是**我们的探测**）。
          const readOnly = join(dir, 'readonly.txt')
          writeFileSync(readOnly, 'x')
          spawnSync('/bin/sh', ['-c', `chmod 400 ${shellQuote(readOnly, provider.platform)}`], { encoding: 'utf8' })
          assert.notEqual(provider.run(pathWritableCommand(readOnly, provider.platform)).status, 0,
            'chmod 400 之后必须报"不可写"')

          // POSIX：锁探测必须有正向结论。`lsof` 在多数发行版里默认存在；
        // 没有就跳过这一条（探测命令本身由 `lockProbeCommand` 的单元测试守住）。
        const probeTarget = join(sandbox.dir, 'lock-target')
        writeFileSync(probeTarget, 'x')
        const lockProbe = provider.run(lockProbeCommand(probeTarget, provider.platform))
        if (lockProbe.status === 127 || /not found/i.test(String(lockProbe.stderr))) {
          t.diagnostic('本机没有 lsof，跳过锁探测的真实运行（命令形状由单元测试覆盖）')
        } else {
          const held = parseLockProbe({
            exitCode: typeof lockProbe.status === 'number' ? lockProbe.status : null,
            stdout: String(lockProbe.stdout),
            error: '',
          })
          assert.equal(held, false, `没有进程持有这个文件时必须给出"未被占用"：${String(lockProbe.stdout)}`)
          }
          return
        }

        // Windows：判决脚本回**角色标签 + 权限位掩码**，**不回**任何账户名 / SID / ACL 条目。
        const verdict = provider.run(windowsAclVerdictCommand(dir, provider.platform))
        assert.equal(verdict.status, 0, `ACL 判决脚本失败：${verdict.stderr ?? ''}`)
        const stdout = String(verdict.stdout)
        assert.match(stdout, /crwu-acl\/2/, `缺格式版本行（应为 /2）：${stdout}`)
        assert.match(stdout, /owner=(True|False)/i, `缺 owner 判决：${stdout}`)
        // `modify-mask` 由 .NET 的 `FileSystemRights.Modify` 给出（官方枚举 = 197055），
        // 插件侧拿它算"有效权限是否覆盖所需写位"。缺了它判决只能是 null（不知道）。
        assert.match(stdout, /modify-mask=\d+/, `缺 modify-mask：${stdout}`)
        assert.match(stdout, /ace=(allow|deny):(self|group|other):\d+/i, `缺数字权限位的 ACE：${stdout}`)
        assert.equal(/S-1-5-\d/i.test(stdout), false, `不许回 SID：${stdout}`)
        assert.equal(/:(OI|CI)\(/.test(stdout), false, `不许回 ACE：${stdout}`)
        // 判决必须能被插件侧的纯函数复算，并且自己建的目录要判成可改
        //（旧实现"只找当前 SID 的 Allow"在这里也是 true，所以下面还要专门测 Deny 优先）。
        const parsed = parseAclVerdict(stdout)
        assert.equal(parsed.owner, true, '临时目录的属主一定是当前账户')
        assert.equal(parsed.modify, true, `刚建的临时目录必须判为可改：${stdout}`)

        // 写实测（只在修复读回里用）：自己建的目录当然写得进去，探测必须回 modify=True。
        const modifyProbe = provider.run(windowsModifyProbeCommand(dir, 'directory', provider.platform))
        assert.equal(modifyProbe.status, 0, `写实测脚本失败：${modifyProbe.stderr ?? ''}`)
        assert.match(String(modifyProbe.stdout), /modify=True/i, `自己建的目录应当可写：${modifyProbe.stdout}`)

        // 修复命令：给当前账户补一条 Modify，然后**回读**确认（这就是 W-03 的判据）。
        const grant = provider.run(grantModifyAclCommand(dir, provider.platform, { inherit: true }))
        assert.equal(grant.status, 0, `icacls 授权失败：${grant.stderr ?? ''}`)
        const after = provider.run(windowsAclVerdictCommand(dir, provider.platform))
        assert.equal(parseAclVerdict(String(after.stdout)).modify, true, '授权后必须判为可改')
        // **Deny 优先**（用户复查的 P1）：给当前账户显式加一条 Deny 之后，
        // 判决必须翻成"不可改"，写实测也必须失败 —— 旧实现只找"当前 SID 的 Allow"，
        // 这种情况下照样报 `modify=true`，于是修复"验证通过"而 DWS 依然写不进去。
        // 只有真的在 Windows 上跑才测得到，所以这一段放在这里（CI 的 windows-powershell job）。
        const identity = provider.run('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name')
        const me = String(identity.stdout).trim()
        assert.notEqual(me, '', `拿不到当前账户名：${String(identity.stderr)}`)
        const deny = provider.run(`icacls ${shellQuote(dir, provider.platform)} /deny "${me}:(M)"`)
        assert.equal(deny.status, 0, `加 Deny 失败：${String(deny.stderr)}`)
        try {
          const denied = parseAclVerdict(String(provider.run(windowsAclVerdictCommand(dir, provider.platform)).stdout))
          assert.equal(denied.modify, false, '显式 Deny 必须压过 Allow（有效权限）')
          const writeDenied = provider.run(windowsModifyProbeCommand(dir, 'directory', provider.platform))
          assert.match(String(writeDenied.stdout), /modify=False/i,
            'Deny 还在时"真的写一次"必须失败（写实测才是最终判据）')
        } finally {
          // 清掉 Deny，别把临时目录留成不可写（后面还有用例要用它）。
          provider.run(`icacls ${shellQuote(dir, provider.platform)} /remove:d "${me}"`)
        }
        const restored = parseAclVerdict(String(provider.run(windowsAclVerdictCommand(dir, provider.platform)).stdout))
        assert.equal(restored.modify, true, '清掉 Deny 之后必须回到可改')

        // **W-05：锁必须真的探测得到**。旧实现在 Windows 固定返回空命令，
        // `lockHeld` 永远不可能为 true —— 于是"文件被另一个进程占用"这条归因
        // 在代码上不可达（用户复查的 P1）。这里用**另一个 pwsh 进程**真的持有句柄，
        // 再断言独占打开探测回 `locked=True`；放掉之后必须回 `False`。
        const lockFile = join(dir, 'lock-target')
        writeFileSync(lockFile, 'x')
        const idleRun = provider.run(lockProbeCommand(lockFile, provider.platform))
        // ⚠️ 先要求脚本**真的跑成功**并给出规范的三态行：只看 `parseLockProbe` 的布尔是不够的 ——
        // 脚本失败时 stdout 为空，解析会退回 POSIX 语义、恰好也回 `false`，于是"探测能跑"这件事
        // 会被一条假通过掩盖（与用户复查第 1 条同一类）。
        assert.equal(idleRun.status, 0, `锁探测脚本失败：${String(idleRun.stderr)}`)
        assert.match(String(idleRun.stdout), /locked=(True|False|Unknown)/, `缺三态结论行：${String(idleRun.stdout)}`)
        const idle = parseLockProbe({ exitCode: 0, stdout: String(idleRun.stdout), error: '' })
        assert.equal(idle, false, '没有别人持有时必须回 False')

        const { spawn } = await import('node:child_process')
        const holder = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$f = [IO.File]::Open('${lockFile.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 20; $f.Close()`],
        { stdio: 'ignore' })
        try {
          // 等它真的把句柄拿到手（拿不到就让下面的断言失败，而不是假通过）。
          let held = undefined
          let lastStdout = ''
          for (let attempt = 0; attempt < 20 && held !== true; attempt += 1) {
            await new Promise((resolve) => { setTimeout(resolve, 250) })
            const run = provider.run(lockProbeCommand(lockFile, provider.platform))
            lastStdout = String(run.stdout)
            // 拿不到"脚本跑成功 + 三态行"就一直等（而不是把空输出当成"没被占用"）。
            if (run.status !== 0 || !/locked=(True|False|Unknown)/.test(lastStdout)) continue
            held = parseLockProbe({ exitCode: 0, stdout: lastStdout, error: '' })
          }
          assert.equal(held, true, `另一个进程持有句柄时，独占打开探测必须回 True（最后一次输出：${lastStdout.trim()}）`)
        } finally {
          holder.kill('SIGKILL')
          await new Promise((resolve) => { setTimeout(resolve, 400) })
        }
        const releasedRun = provider.run(lockProbeCommand(lockFile, provider.platform))
        assert.equal(releasedRun.status, 0, `锁探测脚本失败：${String(releasedRun.stderr)}`)
        assert.match(String(releasedRun.stdout), /locked=(True|False|Unknown)/, `缺三态结论行：${String(releasedRun.stdout)}`)
        const released = parseLockProbe({ exitCode: 0, stdout: String(releasedRun.stdout), error: '' })
        assert.equal(released, false, '持有进程结束之后必须回 False')

        // **部分 Deny 也要算数**（用户复查的 P2）：Allow 整条 Modify、只 Deny `(W)`，
        // 有效权限里写位被减掉 → 判决必须翻成"不可改"。
        const partial = provider.run(`icacls ${shellQuote(dir, provider.platform)} /deny "${me}:(W)"`)
        assert.equal(partial.status, 0, `加部分 Deny 失败：${String(partial.stderr)}`)
        try {
          const partialVerdict = parseAclVerdict(String(provider.run(windowsAclVerdictCommand(dir, provider.platform)).stdout))
          assert.equal(partialVerdict.modify, false, '只 Deny 写权限也必须判为不可改（部分 Deny 参与有效权限）')
        } finally {
          provider.run(`icacls ${shellQuote(dir, provider.platform)} /remove:d "${me}"`)
        }

        // 修复命令不许出现夺所有权 / 提权动作（设计 §D3 的硬线）。
        const grantCommand = grantModifyAclCommand(dir, provider.platform, { inherit: false })
        for (const forbidden of ['/setowner', 'takeown', 'sudo', '/reset', '/T']) {
          assert.equal(grantCommand.includes(forbidden), false, `修复命令里不许出现 ${forbidden}`)
        }
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
