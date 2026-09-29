/**
 * **迁移完成度**的静态护栏（协议 18 · 子项目 B）。
 *
 * 子项目 B 的验收里有四条只能靠"看全仓"来证伪 —— 单点单测证明不了"没有第二条路"：
 *
 * - B-01：每一条跨工作区边界的 **shell** 调用都有具名操作；
 * - B-02：每一次跨工作区边界的**文件写入**都有具名操作；
 * - B-03：模型 / 客户端 / 调用方**提交不了**提权开关或沙箱策略；
 * - B-09：除 Broker 与 `shell/run.ts` 之外，没有别的地方在申请提权或绕开 `ctx.shell`。
 *
 * 所以这里直接读源码（`src/**` 的文本），断言"不该再出现的写法"一处都没有。
 * 这类断言的**假通过风险**是"扫错目录/扫错后缀"：所以先断言真的扫到了文件，
 * 再断言具体模式 —— 扫到 0 个文件时测试必须红，而不是静静地绿。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const { LOCAL_ACCESS_OPERATIONS } = await import(new URL('../../src/host/access/operations.ts', import.meta.url).href)
const ROOT = new URL('../../', import.meta.url)
const SRC = new URL('src/', ROOT).pathname

/**
 * 去掉行注释与块注释。
 *
 * 这一层很关键：这几个文件的**注释里**正好在讲"以前是 `escalate` / 以前用
 * `node:child_process`"——把注释算进去，守卫会永远红；而不剥注释又会漏掉真正的代码。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** 递归收集 `src/` 下的 TypeScript 源码（含 tsx）。 */
function sourceFiles(dir = SRC) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const FILES = sourceFiles()
const rel = (path) => path.slice(SRC.length)

// ── B-09 / B-03：提权只有一个入口 ────────────────────────────────────────────

test('B-09 · 源码里只有 Broker 与 shell/run.ts 能出现 `escalate`（调用方提交不了提权）', () => {
  assert.equal(FILES.length > 40, true, `扫描面太小，多半扫错目录了：${String(FILES.length)} 个文件`)
  const offenders = []
  for (const path of FILES) {
    const text = readFileSync(path, 'utf8')
    // `escalated`（结果事实）不算；`escalate` 作为**参数/字段**才算。
    if (!/escalate\s*[:,]/.test(text) && !/escalate\s*===/.test(text) && !/escalate\?:/.test(text)) continue
    const name = rel(path)
    if (name === 'host/access/broker.ts' || name === 'host/shell/run.ts') continue
    // 文档注释里提到历史形态不算违规：只看**非注释行**。
    const codeLines = text.split('\n').filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
    if (codeLines.some((line) => /escalate\s*[:,]/.test(line) || /escalate\?:/.test(line))) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件还在自己拼提权（应当改成操作身份）：${offenders.join('、')}`)
})

test('B-03 · Host 操作不再读 `args.escalate` / 不接受沙箱策略字段', () => {
  const core = stripComments(readFileSync(join(SRC, 'host/ops/core.ts'), 'utf8'))
  assert.equal(/args\.escalate/.test(core), false, '`crwu` 直通入口不许再接受 escalate')
  assert.equal(/sandboxPolicy/.test(core), false, '操作表里不许出现 sandboxPolicy')
  // 工具 schema 里也不许出现提权 / 沙箱 / 二进制路径这类逃生字段（host-tools 有逐工具清单，
  // 这里再兜一层：整个 tools 目录都不许出现这些词）。
  for (const path of FILES.filter((p) => rel(p).startsWith('host/tools/'))) {
    const text = stripComments(readFileSync(path, 'utf8'))
    for (const forbidden of ['sandboxPolicy', 'sandbox_permissions', 'escalate:', 'binaryPath']) {
      assert.equal(text.includes(forbidden), false, `${rel(path)} 出现了逃生字段：${forbidden}`)
    }
  }
})

test('C-08 · 审核 Tool 里不出现任何登录操作名（也没有交互式登录 Tool）', () => {
  const offenders = []
  for (const path of FILES.filter((p) => rel(p).startsWith('host/tools/'))) {
    const text = stripComments(readFileSync(path, 'utf8'))
    for (const forbidden of ['h3yun.session.login', 'dws.auth.login', 'auth login', 'session login']) {
      if (text.includes(forbidden)) offenders.push(`${rel(path)}（${forbidden}）`)
    }
  }
  assert.deepEqual(offenders, [], `审核 Tool 不该碰登录：${offenders.join('、')}`)
  // 工具名里也不许出现 login：没有"给 Agent 用的登录 Tool"这回事。
  const consts = readFileSync(join(SRC, 'host/tools/consts.ts'), 'utf8')
  assert.equal(/login/i.test(stripComments(consts)), false, '工具集里不许有登录工具')
})

test('B-09 · 不用 `node:child_process` 绕过 ctx.shell', () => {
  const offenders = FILES
    .filter((path) => stripComments(readFileSync(path, 'utf8')).includes('node:child_process'))
    .map(rel)
  assert.deepEqual(offenders, [], `这些文件绕过了 DSH 的 shell 通道：${offenders.join('、')}`)
})

// ── B-01 / B-02：跨边界调用必须经过 Broker ───────────────────────────────────

/** 业务 CLI 的执行器：只有这些文件允许自己拼 `crwu` / `dws` / `ossutil` 的命令。 */
const APPROVED_EXECUTORS = [
  'host/crwu/run.ts',
  'host/dws/run.ts',
  'host/environment/probe.ts',
  'host/oss/ops.ts',
  'host/platform/shell.ts',
]

test('B-01b · OSS 的**每一次** `ossutil` 都必须经 Broker（2026-09-29 假绿复现）', () => {
  // 这一条是被用户复查抓出来的：原来的 B-01 只断言"`host/oss/ops.ts` 里出现过一次
  // `access.runShell`"——于是**列举 / 读结果 / 签名 / 上传 / 写后校验**五处直接调
  // `shell/run.ts` 的裸 `runShell` 全都没被发现，而那些调用不会拿到逐次
  // `danger-full-access`，在受限沙箱下读不到 `~/.ossutilconfig`（审核子会话里必然失败）。
  //
  // 判据从"出现过一次"改成"**不许出现**"：OSS 代码里唯一允许调 `runShell` 的地方是
  // 执行器 `host/oss/run.ts`。任何人以后再加一条 `ossutil` 调用，只要绕过执行器，这里就红。
  const ossFiles = FILES.filter((path) => {
    const name = rel(path)
    return (name.startsWith('host/oss/') || name === 'host/tools/oss.ts') && name !== 'host/oss/run.ts'
  })
  assert.equal(ossFiles.length >= 3, true, `OSS 文件扫描面太小：${String(ossFiles.length)}`)
  const offenders = []
  for (const path of ossFiles) {
    const code = stripComments(readFileSync(path, 'utf8'))
    // 合法的调用长这样：`deps.access.runShell(...)`。先把这些去掉，剩下的任何
    // `runShell(` 都是**裸执行器**（也可以直接看有没有 import `shell/run.ts`）。
    const withoutBrokerCalls = code.replace(/[\w.]*access\.runShell\s*\(/g, '')
    if (/\brunShell\s*\(/.test(withoutBrokerCalls)) offenders.push(`${rel(path)}（裸 runShell）`)
    if (/from '\.\.\/shell\/run\.ts'/.test(code)) offenders.push(`${rel(path)}（直接 import shell/run.ts）`)
  }
  assert.deepEqual(offenders, [], `这些 OSS 文件在绕过 Broker 直接执行：${offenders.join('、')}`)

  // 反过来：真的会跑 `ossutil` 的两个文件必须用执行器，而且**每次**都带 `operation`。
  for (const name of ['host/oss/ops.ts', 'host/tools/oss.ts']) {
    const code = stripComments(readFileSync(join(SRC, name), 'utf8'))
    assert.equal(code.includes('runOssutil('), true, `${name} 没有用 OSS 执行器`)
    const calls = code.match(/runOssutil\(/g)?.length ?? 0
    const operations = code.match(/operation:\s*'oss\.remote\.(read|write)'/g)?.length ?? 0
    assert.equal(operations >= calls, true, `${name} 有 ${String(calls)} 次调用但只有 ${String(operations)} 次声明 operation`)
  }
  // 执行器自己必须是唯一能拼 `ossutil` 命令的地方（`shellInvoke` 只在那里出现）。
  const executor = stripComments(readFileSync(join(SRC, 'host/oss/run.ts'), 'utf8'))
  assert.equal(/shellInvoke\(/.test(executor), true, '执行器应当负责拼命令')
  assert.equal(/access\.runShell\(/.test(executor), true, '执行器必须经 Broker')
  assert.equal(/oss\.remote\.(read|write)/.test(executor), true, '执行器要能表达读/写两类操作')
})

test('B-01e · 案例目录的本地文件操作只走 Broker（不许再出现裸 `runShell`）', () => {
  // 2026-09-30 的真实故障：`case-files.ts` 直接调 `shell/run.ts` 的裸 `runShell`，于是建本轮
  // 案例目录时拿到的是**部署默认沙箱**（边界 = 会话 cwd），`mkdir <员工选定工作空间>/<流水号>`
  // 回 `Operation not permitted` —— 员工本人对那个目录其实是有写权限的。
  // 判据与 OSS 那条一样，从"出现过一次"改成"**不许出现**"：这个文件里每一次命令都必须带着
  // 「操作 + 来源」交给 Broker，提权归属由操作表决定。
  const code = stripComments(readFileSync(join(SRC, 'host/tools/case-files.ts'), 'utf8'))
  const withoutBrokerCalls = code.replace(/access\.runShell\s*\(/g, '')
  assert.equal(/\brunShell\s*\(/.test(withoutBrokerCalls), false,
    'host/tools/case-files.ts 不许出现裸 runShell')
  assert.equal(/^\s*import\s+(?!type\b)[^\n]*from '\.\.\/shell\/run\.ts'/m.test(code), false,
    'host/tools/case-files.ts 不许**值导入** shell/run.ts（那会绕开逐次策略声明）；只允许 `import type`')
  // 反过来：三个操作名必须真的在这里被用（登记了没人用 = 边界没接上）。
  for (const operation of ['system.case-directory.write', 'system.case-file.write', 'system.case-file.read']) {
    assert.equal(code.includes(`'${operation}'`), true, `case-files.ts 没有用 ${operation}`)
  }
  // 审核启动链路（`audit/ops.ts`）也必须走这一条，而不是自己拼 mkdir。
  const auditOps = stripComments(readFileSync(join(SRC, 'host/audit/ops.ts'), 'utf8'))
  assert.equal(auditOps.includes('ensureCaseDirectory('), true, 'audit/ops.ts 必须用 ensureCaseDirectory 建案例目录')
  assert.equal(auditOps.includes('ensureDirectory('), false, 'audit/ops.ts 不许用案例内版本建本轮案例目录')
})

test('B-01c · 每个"凭据类"操作都必须**真的有调用点**（登记了没人用 = 边界没接上）', () => {
  // 用户复查的原话：「`oss.config.read` 和 `ifind.credential.read` 虽然登记在操作表中，
  // 但生产代码没有任何调用点」—— 操作表里有名字，读路径却绕过它，于是"撤销之后还能读"。
  // 这条门禁把"登记了必须接到调用点"变成机器判据：以后再加一条凭据操作，
  // 忘了接到读/写函数上就会红。
  const credentialOps = [
    'oss.config.read', 'oss.config.write', 'oss.config.permission',
    'oss.remote.read', 'oss.remote.write',
    'ifind.credential.read', 'ifind.credential.write', 'ifind.credential.clear',
    'ifind.credential.permission',
    'dws.local.permission', 'dws.local.permission.repair', 'dws.doctor.read',
    'h3yun.session.status', 'h3yun.session.login',
  ]
  // ⚠️ **必须排除 `host/access/**`**：操作表本身就写着每一个操作名，
  // "在源码里能找到这个字符串"会被那张表自己满足 —— 那就是本仓 §6 点名的"文本包含式假通过"
  //（第一次写这条门禁时就踩了：注入"删掉调用点"，它照样绿）。
  // 调用点必须出现在**领域模块**里（`oss/**`、`ifind/**`、`dws/**`、`h3yun/**`…）。
  const sources = FILES
    .filter((path) => rel(path).startsWith('host/'))
    .filter((path) => !rel(path).startsWith('host/access/'))
    .map((path) => stripComments(readFileSync(path, 'utf8')))
  /** 这个名字在**非操作表**的源码里被引用了吗（含模板拼出来的形态）。 */
  const referenced = (code, operation) => {
    if (code.includes(`'${operation}'`) || code.includes(`"${operation}"`)) return true
    // 有的名字是**拼**出来的：`crwu h3yun session status` 映射成 `` `h3yun.session.${action}` ``。
    // 那种情况下源码里没有整串字面量，但前缀 + `${` 一定在。
    const dot = operation.lastIndexOf('.')
    if (dot < 0) return false
    const prefix = operation.slice(0, dot + 1)
    return code.includes(`${prefix}${'${'}`)
  }
  const dead = credentialOps.filter((operation) => !sources.some((code) => referenced(code, operation)))
  assert.deepEqual(dead, [], `这些凭据操作在操作表里登记了，但生产代码里没人用：${dead.join('、')}`)

  // 反向：读凭据的两条**必须是特权**（目标在工作区之外，受限沙箱下读不到）。
  for (const operation of ['oss.config.read', 'ifind.credential.read']) {
    const descriptor = LOCAL_ACCESS_OPERATIONS[operation]
    assert.equal(descriptor.privileged, true, `${operation} 必须逐次声明策略`)
  }
})

test('B-01 · 业务 CLI 只在登记的执行器里被拼成命令，且它们都必须经 Broker', () => {
  const offenders = []
  for (const path of FILES) {
    const name = rel(path)
    if (APPROVED_EXECUTORS.includes(name) || name.startsWith('host/access/')) continue
    const text = stripComments(readFileSync(path, 'utf8'))
    // `shellInvoke(<包内路径>, ['ls' …])` 这类"自己拼一条业务 CLI 命令"的写法。
    if (/shellInvoke\([^)]*ossutil|shellInvoke\([^)]*dws|shellInvoke\([^)]*crwu/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件在自己拼业务 CLI 命令：${offenders.join('、')}`)

  // 反过来：登记的执行器必须真的经 Broker（出现 `access.runShell`），否则 B-01 在这一层就是空的。
  for (const name of ['host/crwu/run.ts', 'host/dws/run.ts', 'host/environment/probe.ts', 'host/oss/ops.ts']) {
    const text = readFileSync(join(SRC, name), 'utf8')
    assert.equal(/access\.runShell|options\.access\.runShell|deps\.access\.runShell/.test(text), true,
      `${name} 没有经 Broker 执行（提权判据会漂回它自己手里）`)
  }
})

test('B-01d · 解析了业务 CLI 二进制，就必须用**登记的**执行器执行它', () => {
  // B-01 那条正则只抓"在 `shellInvoke(...)` 里直接写 `ossutil` / `dws` / `crwu`"。
  // 它抓不到**间接**形态 —— 而这个形态才是最容易复制的：
  //
  //     const p = await requireBundledCommand(ctx, platform, 'ossutil')
  //     await runShell(ctx, shellInvoke(p, argv), …)      // ← B-01 看不见
  //
  // 所以判据换成"**解析**二进制"这一步：谁去解析业务 CLI 的可执行路径，谁就必须在同一文件里
  // 用对应的登记执行器（`runOssutil` / `runDws` / `runCrwu`）或本身就是那个执行器。
  // 解析二进制是执行它的前提，堵在这里就不必去猜命令是怎么拼出来的。
  const EXECUTOR_OF = { ossutil: 'runOssutil', dws: 'runDws', crwu: 'runCrwu' }
  const offenders = []
  for (const path of FILES) {
    const name = rel(path)
    const text = stripComments(readFileSync(path, 'utf8'))
    for (const [binary, executor] of Object.entries(EXECUTOR_OF)) {
      // 只看"把 biz CLI 名字当实参交给解析器"这一形态（别处出现同名变量/字符串不算）。
      const resolves = new RegExp(`requireBundledCommand\\([^)]*'${binary}'`).test(text)
      if (!resolves) continue
      if (name === `host/${binary}/run.ts`) continue
      if (new RegExp(`\\b${executor}\\(`).test(text)) continue
      offenders.push(`${name}（解析了 ${binary} 但没用 ${executor}）`)
    }
  }
  assert.deepEqual(offenders, [], `这些文件绕过了登记执行器：${offenders.join('、')}`)
  // 扫描面自检：今天至少有这几处解析（否则这条门禁是空的）。
  const resolvers = FILES.filter((path) => /requireBundledCommand\([^)]*'(ossutil|dws|crwu)'/.test(readFileSync(path, 'utf8')))
  assert.equal(resolvers.length >= 4, true, `解析点太少，多半扫错目录了：${String(resolvers.length)}`)
})

test('P1 · 活授权状态只允许在 `access/consent.ts` 里被赋值（调用方不许采纳返回的视图）', () => {
  // 用户复查的 P1（2026-09-29）：`core.ts` 曾经无条件 `state.localAccess = result.consent`，
  // 而写盘失败时那个 `consent` 可能来自**磁盘上的旧授权** —— 一次失败的「重新允许」
  // 就把 `persist-failed` 重新打开了。修法是让 `consent.ts` 自己负责状态迁移；
  // 这条门禁把"别处不许再写这个字段"变成机器判据。
  const offenders = []
  for (const path of FILES) {
    const name = rel(path)
    if (name === 'host/access/consent.ts') continue
    const code = stripComments(readFileSync(path, 'utf8'))
    // 只抓赋值（` = `），不抓读取与类型声明。
    if (/state\.localAccess\s*=[^=]/.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [],
    `这些文件在直接改活授权状态（应当由 consent.ts 负责）：${offenders.join('、')}`)
})

test('B-02 · 跨边界的文件写入只有 Broker 一处（`fs.writeText` + sandboxPolicy 不再散落）', () => {
  // 判据：`writeText(..., { mode: 'danger-full-access' … })` 这种"自己声明沙箱策略的写盘"
  // 只允许出现在 Broker 里。别处要写跨边界文件，只能经 `access.writeText`。
  const offenders = []
  for (const path of FILES) {
    const name = rel(path)
    if (name === 'host/access/broker.ts') continue
    const text = stripComments(readFileSync(path, 'utf8'))
    if (/writeText\([^;]*mode:\s*'danger-full-access'/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `这些文件在自己声明写盘策略：${offenders.join('、')}`)

  // 三个可写目标各自的**唯一**路径推导必须在 Broker 的 targets 里登记（由 apply.ts 装配）。
  const apply = readFileSync(join(SRC, 'host/apply.ts'), 'utf8')
  for (const symbol of ['workbenchConfigPath', 'ifindCredentialPath', 'ossConfigPath']) {
    assert.equal(apply.includes(symbol), true, `Broker 的目标表缺 ${symbol}`)
  }
})

test('B-04 · 环境自检与 Tool 都不再自己判断"要不要提权"，而是看操作身份', () => {
  // 旧口径的痕迹：`credentialOperation` / `trusted: deps.state...` 直接喂给执行器。
  const offenders = []
  for (const path of FILES) {
    const name = rel(path)
    if (name.startsWith('host/access/')) continue
    const text = stripComments(readFileSync(path, 'utf8'))
    if (text.includes('credentialOperation')) offenders.push(`${name}（credentialOperation）`)
    if (/runDws\([^;]*trusted:/.test(text)) offenders.push(`${name}（runDws trusted）`)
    if (/runCrwu\([^;]*trusted:/.test(text)) offenders.push(`${name}（runCrwu trusted）`)
  }
  assert.deepEqual(offenders, [], `这些文件还在给执行器传"要不要提权"：${offenders.join('、')}`)
})
