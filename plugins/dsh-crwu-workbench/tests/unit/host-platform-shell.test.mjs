import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

/**
 * 平台 shell 方言适配器的表格测试。
 *
 * 这一份是 Windows 适配的**判据文件**：DSH 在 Windows 用 `pwsh -Command <整串>` 解析命令，
 * 而本机（macOS / Linux）怎么跑都是 POSIX，所以 Windows 分支只能靠这里的逐字断言守住。
 * 真机上的执行合同由 `.github/workflows/ci.yml` 的原生 pwsh job 跑（`tests/windows/`）。
 */
const ROOT = new URL('../../', import.meta.url)
const {
  shellDialect, shellQuote, shellInvoke, mkdirCommand, removeFileCommand,
  openExternalCommand, clipboardCommand, homeProbeCommand, privateFileCommand,
} = await import(new URL('src/host/platform/shell.ts', ROOT).href)

const WIN = 'win32-x64'
const MAC = 'darwin-arm64'
const LINUX = 'linux-x64'

test('shellDialect 只把 win32 归到 PowerShell，其余都是 POSIX', () => {
  assert.equal(shellDialect(WIN), 'powershell')
  assert.equal(shellDialect('win32-arm64'), 'powershell')
  assert.equal(shellDialect(MAC), 'posix')
  assert.equal(shellDialect(LINUX), 'posix')
  assert.equal(shellDialect(''), 'posix')
})

test('shellQuote：PowerShell 用单引号字面量并把内部单引号翻倍', () => {
  // 双引号在 PowerShell 里会插值 `$` / 反引号，所以 `$work` 必须是字面量。
  assert.equal(shellQuote("Case's $work [1] 中文", WIN), "'Case''s $work [1] 中文'")
  assert.equal(shellQuote('C:\\Program Files\\CRWU\\crwu.exe', WIN), "'C:\\Program Files\\CRWU\\crwu.exe'")
  assert.equal(shellQuote('a`b', WIN), "'a`b'")
  assert.equal(shellQuote('', WIN), "''")
  // 普通值也照样加引号：PowerShell 里不加引号的裸 token 会走另一套解析（通配符、转义）。
  assert.equal(shellQuote('h3yun', WIN), "'h3yun'")
})

test('shellQuote：POSIX 能不加引号就不加，需要时用单引号 + 转义', () => {
  assert.equal(shellQuote('/usr/local/bin/ossutil', MAC), '/usr/local/bin/ossutil')
  assert.equal(shellQuote('oss://bucket/prefix/', LINUX), 'oss://bucket/prefix/')
  assert.equal(shellQuote('/opt/my tools/ossutil', LINUX), "'/opt/my tools/ossutil'")
  assert.equal(shellQuote("it's", MAC), "'it'\\''s'")
  assert.equal(shellQuote('$HOME', MAC), "'$HOME'")
  assert.equal(shellQuote('a[b]', MAC), "'a[b]'")
  assert.equal(shellQuote('', MAC), "''")
})

test('shellQuote 安全表示换行、明确拒绝 NUL', () => {
  // 单引号内部换行是字面量，不会变成语句分隔符 —— 安全表示，不是「原样进入命令结构」。
  assert.equal(shellQuote('a\nb', MAC), "'a\nb'")
  assert.equal(shellQuote('a\nb', WIN), "'a\nb'")
  assert.equal(shellQuote('a\rb', WIN), "'a\rb'")
  // NUL 在命令串里无法表达（会截断命令）：必须明确拒绝。
  assert.throws(() => shellQuote('a\u0000b', MAC), /NUL/)
  assert.throws(() => shellQuote('a\u0000b', WIN), /NUL/)
})

test('shellInvoke：Windows 补调用运算符 `&`，POSIX 绝不加', () => {
  assert.equal(
    shellInvoke('C:\\Program Files\\CRWU\\crwu.exe', ["Case's $work [1] 中文"], WIN),
    "& 'C:\\Program Files\\CRWU\\crwu.exe' 'Case''s $work [1] 中文'",
  )
  assert.equal(shellInvoke('dws.exe', ["a'b", '$HOME'], WIN), "& 'dws.exe' 'a''b' '$HOME'")
  // POSIX 上 `&` 是后台作业，会把前台命令变成异步执行。
  assert.equal(shellInvoke('/usr/local/bin/ossutil', ['ls', 'oss://b/p/'], MAC), '/usr/local/bin/ossutil ls oss://b/p/')
  assert.equal(shellInvoke('/opt/my tools/ossutil', ['ls'], LINUX), "'/opt/my tools/ossutil' ls")
  assert.equal(shellInvoke('/usr/bin/crwu', [], MAC), '/usr/bin/crwu')
  assert.equal(shellInvoke('crwu.exe', [], WIN), "& 'crwu.exe'")
})

test('mkdirCommand 在两个平台都幂等', () => {
  assert.equal(mkdirCommand('C:\\Case\'s Work', WIN), "New-Item -ItemType Directory -Force -Path 'C:\\Case''s Work' | Out-Null")
  assert.equal(mkdirCommand('/opt/my work', MAC), "mkdir -p '/opt/my work'")
  assert.equal(mkdirCommand('/work', LINUX), 'mkdir -p /work')
})

test('removeFileCommand 幂等，但不用 SilentlyContinue 吞掉真实失败', () => {
  const win = removeFileCommand('C:\\x', WIN)
  assert.equal(win, "if (Test-Path -LiteralPath 'C:\\x') { Remove-Item -LiteralPath 'C:\\x' -Force -ErrorAction Stop }")
  assert.equal(/SilentlyContinue/.test(win), false, '真实失败必须能传播成非零退出码')
  assert.equal(removeFileCommand('/tmp/x', MAC), 'rm -f -- /tmp/x')
  assert.equal(removeFileCommand("/tmp/Case's Work/old.json", MAC), "rm -f -- '/tmp/Case'\\''s Work/old.json'")
})

test('openExternalCommand：Windows 用 Start-Process，不用 cmd /c start', () => {
  assert.equal(openExternalCommand('C:\\report.html', WIN), "Start-Process -FilePath 'C:\\report.html'")
  assert.equal(openExternalCommand('/tmp/a.html', MAC), 'open /tmp/a.html')
  assert.equal(openExternalCommand('/tmp/a b.html', LINUX), "xdg-open '/tmp/a b.html'")
  for (const platform of [WIN, MAC, LINUX]) {
    assert.equal(/cmd \/c/.test(openExternalCommand('x', platform)), false)
  }
})

test('clipboardCommand 与 homeProbeCommand 按平台选一条命令，不混用两套工具', () => {
  assert.equal(clipboardCommand(MAC), 'pbcopy')
  assert.equal(clipboardCommand(WIN), 'clip')
  assert.match(clipboardCommand(LINUX), /xclip/)
  // Windows 不得依赖 python3 / printf / sh。
  assert.equal(homeProbeCommand(WIN), 'Write-Output $env:USERPROFILE')
  assert.equal(/python|printf|sh\b/.test(homeProbeCommand(WIN)), false)
  // POSIX 不得依赖 Windows 的环境变量写法。
  assert.equal(homeProbeCommand(MAC), 'printf %s "$HOME"')
  assert.equal(/USERPROFILE/.test(homeProbeCommand(LINUX)), false)
})

test('privateFileCommand 在 Windows 上明确表示「不适用」', () => {
  assert.equal(privateFileCommand('/Users/x/.dsh/cred.json', MAC), 'chmod 600 /Users/x/.dsh/cred.json')
  assert.equal(privateFileCommand('/Users/x/a b.json', LINUX), "chmod 600 '/Users/x/a b.json'")
  assert.equal(privateFileCommand('C:\\Users\\x\\cred.json', WIN), '')
})

// ── 静态门禁：平台命令只能由中央适配器生成 ───────────────────────────────────

/**
 * 除中央适配器外，任何 Host 源码都不得自己拼平台命令。
 *
 * 这一条必须存在：上面那些行为断言只能证明适配器**本身**对，证明不了调用点**用了**它 ——
 * 而历史形态恰恰是「适配器写对了，调用点各拼各的」。注释行跳过（正文里要解释这些坑）。
 */
test('静态门禁：平台命令只能由 platform/shell.ts 生成', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const hostRoot = fileURLToPath(new URL('src/host', ROOT))
  const dialectHome = fileURLToPath(new URL('src/host/platform/shell.ts', ROOT))

  const FORBIDDEN = [
    { pattern: /cmd(\.exe)?\s+\/c\b/, why: '第二套 cmd 解析规则会把转义错误放大一倍' },
    { pattern: /SilentlyContinue/, why: '真实失败会被吞成成功' },
    { pattern: /Start-Process/, why: '打开命令必须走 openExternalCommand' },
    { pattern: /New-Item\s+-ItemType\s+Directory/, why: '建目录必须走 mkdirCommand' },
    { pattern: /Remove-Item/, why: '删除必须走 removeFileCommand' },
    { pattern: /\bmkdir\s+-p\b/, why: '建目录必须走 mkdirCommand' },
    { pattern: /\brm\s+-[rf]/, why: '删除必须走 removeFileCommand' },
    { pattern: /\bchmod\s+\d/, why: '权限收紧必须走 privateFileCommand' },
    { pattern: /xdg-open|pbcopy|xclip|xsel/, why: '打开/剪贴板必须走 openExternalCommand / clipboardCommand' },
    { pattern: /quoteArg/, why: '旧 POSIX-only 引用函数已由 shellQuote 取代' },
    // 命令位置的两条（`${shellQuote(` 开头 / argv 自己 join）由 `host-shell-fs.test.mjs`
    // 的历史守卫钉着，这里不重复，避免两条门禁随时间漂移。
  ]

  const walk = async (dir) => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...await walk(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

  const offenders = []
  for (const file of await walk(hostRoot)) {
    if (file === dialectHome) continue
    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, index) => {
      if (isComment(line)) return
      for (const rule of FORBIDDEN) {
        if (rule.pattern.test(line)) {
          offenders.push(`${file.replace(`${hostRoot}/`, '')}:${String(index + 1)}: ${line.trim()} — ${rule.why}`)
        }
      }
    })
  }
  assert.deepEqual(offenders, [], `平台命令必须由 platform/shell.ts 生成：\n${offenders.join('\n')}`)
})

test('静态门禁：业务代码不得用 process.platform 覆盖注入的平台', async () => {
  const { readFile } = await import('node:fs/promises')
  const files = [
    'src/host/ifind/store.ts',
    'src/host/tools/case-files.ts',
    'src/host/system/ops.ts',
    'src/host/oss/ops.ts',
    'src/host/environment/probe.ts',
    'src/host/platform/home.ts',
  ]
  const offenders = []
  for (const relative of files) {
    const source = await readFile(fileURLToPath(new URL(relative, ROOT)), 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/process\.platform/.test(line)) offenders.push(`${relative}:${String(index + 1)}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `平台必须由调用方注入，不得回退 process.platform：\n${offenders.join('\n')}`)
})

// ── 静态门禁：本地路径拼接只能走 local-path.ts ────────────────────────────────

/**
 * 已知的**本地路径载体**变量：它们的值来自案例目录 / 工作空间 / 主目录，绝不是 OSS 对象键或 URL。
 *
 * 为什么用名单而不是「凡 `${x}/` 都禁」：`${oss.prefix}/${seqNo}`、`${base}/${path}`（URL）
 * 这些**必须**用 `/`。名单短、可读，且每条都写得出理由；代价是新增一个本地路径变量时
 * 门禁拦不住 —— 所以它只是补充，真正管用的是 `joinLocalPath` 本身与 Windows 行为测试。
 */
const LOCAL_PATH_CARRIERS = [
  'caseCheck.path', 'caseDir', 'knowledgeDir', 'snapshotDir', 'caseRoot',
  'record.casePath', 'record.htmlFile', 'context.caseRoot', 'workspacePath',
]

test('静态门禁：已知本地路径载体不得用 `/` 手工拼接', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const srcRoot = fileURLToPath(new URL('src', ROOT))
  const dialectHome = fileURLToPath(new URL('src/shared/utils/local-path.ts', ROOT))

  const walk = async (dir) => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...await walk(full))
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }

  const offenders = []
  for (const file of await walk(srcRoot)) {
    if (file === dialectHome) continue
    const source = await readFile(file, 'utf8')
    source.split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const carrier of LOCAL_PATH_CARRIERS) {
        // 模板里紧跟 `/` 、或 `+ '/' +`，都算手工拼接。
        const escaped = carrier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`${escaped}(?:\\.replace\\([^)]*\\))?\\}/`).test(line)
          || new RegExp(`${escaped}\\s*\\+\\s*['\"]\\/`).test(line)) {
          offenders.push(`${file.replace(`${srcRoot}/`, '')}:${String(index + 1)}: ${line.trim()} — 用 joinLocalPath()？`)
        }
      }
    })
  }
  assert.deepEqual(offenders, [], `本地路径拼接必须走 shared/utils/local-path.ts：\n${offenders.join('\n')}`)
})
