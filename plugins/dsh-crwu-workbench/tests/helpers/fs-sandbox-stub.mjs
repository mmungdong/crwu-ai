/**
 * **会真的按策略拦人**的 shell / sandboxPolicy 替身。
 *
 * ## 为什么必须单独有一份（2026-09-30 的教训）
 *
 * 以前每个测试文件都自己造一个"永远成功"的 shell，于是**三个真实的失败形态**在单测里全都
 * 看不见：命令跑在谁的边界里、请求有没有带策略、执行器在没有策略时回落到哪儿。
 * 结果就是：单测全绿、真机连挂两次（案例目录创建一次、输入快照目录一次）。
 *
 * 这一份照 DSH 的实际语义来：
 *
 * 1. **执行器不持有会话**（`dsh-sandbox-policy` 的原话：executors and providers remain session-free）——
 *    `resolve(request)` 里带了 `sandboxPolicy` 就用它；**没带就落到执行器自己的部署默认**
 *    （`workspace-write` + 配置里的兜底根，通常是进程 cwd）。这正是真机上"写自己所在的目录被拒"的来源。
 * 2. **写只在可写根之内**（`dsh-sandbox` 的 `writableRoots()`）：工作区根 + `/tmp` + 平台临时目录；
 *    之外一律 `Operation not permitted` + `sandbox.denied = true`。
 * 3. 只读探测（`test -d` / `Test-Path`）照常回答，结论由内存 fs 决定。
 *
 * 于是"命令到底跑在哪个边界里"变成**可断言的行为**，而不是靠读代码猜。
 */

import { applyShellEffect, probeAnswer, probeKey } from './shell-effects.mjs'

/** 这条命令要动的目标路径（建目录 / 删除 / 探测）；取不到返回空串。 */
export function targetOf(command) {
  const text = String(command ?? '')
  const patterns = [
    /(?:mkdir -p|New-Item -ItemType Directory -Force -Path)\s+'([^']*)'/,
    /(?:rm -f --|Remove-Item -LiteralPath)\s+'([^']*)'/,
    /^if \[ -d '([^']*)' \]/,
    /^if \(Test-Path -LiteralPath '([^']*)'/,
  ]
  for (const re of patterns) {
    const match = re.exec(text)
    if (match !== null) return match[1]
  }
  return ''
}

/** 目标是不是落在某个根之内（与 DSH 的包含判据同形：前缀 + 分隔符）。 */
export function withinRoot(target, root) {
  if (target === '' || root === '') return false
  const t = String(target).replace(/[\\/]+$/, '')
  const r = String(root).replace(/[\\/]+$/, '')
  return t === r || t.startsWith(`${r}/`) || t.startsWith(`${r}\\`)
}

function shellResult({ exitCode = 0, stdout = '', stderr = '', mode = 'workspace-write', denied = false }) {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
    sandbox: { mode, denied },
  }
}

/**
 * `ctx.get('sandboxPolicy')` 的替身：**按会话**回答策略（没有会话 → 部署默认）。
 *
 * `roots` 是 `(session) => string`：审核链路的调用点会传自己的会话，于是拿到的边界就是那条会话的
 * cwd（本轮案例目录）；不传会话时拿到的就是 `defaultRoot`（进程 cwd 的等价物）。
 */
export function makeSessionPolicyService({ defaultRoot, roots = () => defaultRoot }) {
  const calls = []
  return {
    calls,
    service: {
      resolve(request = {}) {
        const session = request.session
        calls.push(session === undefined ? '(no session)' : String(session.id ?? 'session'))
        return {
          mode: 'workspace-write',
          workspaceRoot: session === undefined ? defaultRoot : roots(session),
          ...(session === undefined ? {} : { sessionId: session.id }),
        }
      },
    },
  }
}

/**
 * `ctx.get('shell')` 的替身：**按 `spec.sandboxPolicy` 拦人**（缺策略时用部署默认）。
 *
 * 返回的 `requests` 记录每一次 `resolve()` 的请求（用例据此断言"这次调用到底声明了什么策略"），
 * `commands` 记录真正执行的命令，`deniedCommands` 记录被沙箱拒掉的那些。
 */
export function makeSandboxedShell({ fs, defaultRoot, routes = [] }) {
  const commands = []
  const deniedCommands = []
  const requests = []
  return {
    commands,
    deniedCommands,
    requests,
    service: {
      resolve(request) {
        requests.push(request)
        // 与 DSH 一致：没带策略就落到执行器自己的部署默认。
        const policy = request.sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: defaultRoot }
        return {
          ...request,
          workdir: request.workdir ?? defaultRoot,
          timeoutMs: request.timeoutMs ?? 1,
          stdoutMaxBytes: request.stdoutMaxBytes ?? 1024,
          onExpiry: request.onExpiry ?? 'kill',
          sandboxPolicy: policy,
        }
      },
      async execute(spec) {
        const command = String(spec.command)
        commands.push(command)
        const mode = spec.sandboxPolicy?.mode ?? 'workspace-write'
        const root = spec.sandboxPolicy?.workspaceRoot ?? defaultRoot
        const target = targetOf(command)
        // ⚠️ 只拦**写**：DSH 的可写根管的正是写；读（`test -d` 这类只读探测）不受它限制，
        // 所以真机上"建不出来"后面那条**探测**照样回得出 `absent` —— 归因才落在 sandbox 上。
        const isWrite = /mkdir|New-Item -ItemType Directory|rm -f --|Remove-Item/.test(command)
        const confining = mode !== 'danger-full-access'
        if (isWrite && confining && target !== '' && !withinRoot(target, root) && !withinRoot(target, '/tmp')) {
          deniedCommands.push(command)
          return { result: async () => shellResult({ exitCode: 1, stderr: `${command.split(' ')[0]}: ${target}: Operation not permitted`, mode, denied: true }) }
        }
        // 用例自己的业务路由（氚云 / 钉钉 / OSS 的应答）。
        for (const [needle, answer] of routes) {
          if (command.includes(needle)) {
            const value = typeof answer === 'function' ? answer(spec) : answer
            return { result: async () => shellResult({ stdout: typeof value === 'string' ? value : JSON.stringify(value), mode }) }
          }
        }
        const probe = probeAnswer(command, {
          hasDir: (path) => fs.dirs.has(probeKey(path)),
          hasFile: (path) => fs.files.has(probeKey(path)),
        })
        if (probe !== undefined) return { result: async () => shellResult({ stdout: probe, mode }) }
        applyShellEffect(command, 0, {
          addDir: (path) => fs.dirs.add(path),
          removeFile: (path) => fs.files.delete(path),
        })
        return { result: async () => shellResult({ stdout: '{}', mode }) }
      },
    },
  }
}

/**
 * `ctx.fs` 的替身：**按策略拦写**（复刻 `dsh-fs-sandbox` 的 `checkedTarget()`）。
 *
 * 真实现是 `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()` ——
 * 调用方不传策略就落到**部署默认**（进程 cwd），于是"往自己所在的案例目录里写文件"被拒：
 * `FS_SANDBOX_DENIED: cannot write "…": file access denied under workspace-write mode`。
 * 2026-09-30 真机第三次故障就是它（建目录已经成功、三个快照 JSON 写不进去）。
 *
 * 只包 `writeText`：读侧不受可写根限制（真实现同样如此），其余方法原样透传。
 */
export function makeSandboxedFs({ fs, defaultRoot }) {
  const writes = []
  const deniedWrites = []
  return {
    writes,
    deniedWrites,
    service: {
      ...fs,
      async writeText(target, content, expected, signal, sandboxPolicy) {
        const policy = sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: defaultRoot }
        const path = String(target?.targetKey ?? target?.displayPath ?? '')
        writes.push({ target: path, policy })
        const confining = policy.mode !== 'danger-full-access'
        if (confining && !withinRoot(path, policy.workspaceRoot) && !withinRoot(path, '/tmp')) {
          deniedWrites.push(path)
          const error = new Error(`cannot write "${target?.displayPath ?? path}": file access denied under ${policy.mode} mode`)
          error.code = 'FS_SANDBOX_DENIED'
          throw error
        }
        return fs.writeText(target, content, expected, signal)
      },
    },
  }
}
