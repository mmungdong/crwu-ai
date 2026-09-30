# Changelog

本仓**只有一条形态**：`src/` 是唯一源码，产物 `lib/index.js` + `lib/client.js` 按 DSH 包插件分发，
版本号用 semver（`package.json` / `VERSION` / `CHANGELOG.md` 三处一致）。

2026-09-20 收尾前本仓并存过一条**动态 Cordis 形态**（`legacy/`，在 DSH 会话里由
`cordis_define` + `cordis_run` 装配，版本号用 DSH 的 `pkg-N`）；它已在本仓收尾时删除
（见 `0.0.1` 一节），下面 `legacy · pkg-43` 及更早的记录是它的历史。

## package · 0.0.37 · 2026-09-30 · fix · 沙箱起不了进程不再被说成「脚本运行时不可用」

真机闭环（0.0.36 的控制探测跑出来的）：

```text
控制探测（纯 PowerShell 命令）**同样失败**（exitCode 3221225794）
→ 连 pwsh 自己都起不来：本机沙箱后端（ACL restricted-token runner）的问题
```

也就是说这台机器的 `workspace-write` 下**任何进程都跑不起来**，插件的输出采集兼容层
（子进程重定向）在原理上就不可能生效 —— 做重定向的那个 pwsh 自己都没起来。

- `PythonRuntimeView` 新增 `blockedBySandbox`：启动失败指纹命中**且控制探测同样失败**时为 true。
- `audit-start` 的门禁第一句据此分流：沙箱坏 → 「本机受限沙箱起不了任何进程（部署侧问题）」；
  真的缺运行时 / 缺包 → 仍然是「DSH 脚本运行时不可用」。两者处置完全不同，不许混成一句。

## package · 0.0.36 · 2026-09-30 · fix · 受限沙箱里"进程起不来"不再被说成「DSH Python 不可用」

真机现场（Windows，0.0.35 打出来的结构化事实就成了判据）：

```text
DSH 脚本运行时不可用，已终止本次审核：DSH Python 无法执行：没有版本输出
（exitCode 3221225794 · 沙箱 执行器默认 → workspace-write）
```

`3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED`，而 `denied` / `runnerFailed` 都还是
false —— DSH 把它当成一次**普通的非零退出**。于是"沙箱里进程起不来"被说成了"Python 不可用"，
两种处置完全不同的现场长得一模一样。

- 新增 `looksLikeProcessStartFailure()`（认 0xC0000142，无符号与 int32 两种视图）+
  **控制探测**：命中该指纹时再跑一条**纯 PowerShell** 命令，据此把两件事分开并给出处置 ——
  ① 控制探测也失败 ⇒ 本机沙箱后端（ACL restricted-token runner）连 pwsh 都起不来，
  **不是**「DSH Python 不可用」，换运行时没用；② 控制探测成功 ⇒ 只有 native 子进程在初始化阶段退出，
  是那层捕获兼容层还不够。结论进 `runtime.error`，结构化事实进日志。
  给出的处置走**部署侧**（DSH 版本 / 沙箱 runner / ACL）—— 插件把审核根钉死在 `workspace-write`
  + `approval: never`，且在 auto / 完全权限的父会话下拒绝发起审核，所以"切完全权限"不是退路。
- 捕获层补上**第三个句柄**：早先只重定向 stdout/stderr，stdin 仍然继承 DSH 的管道 ——
  而这层兼容层的全部前提是"子进程一个 DSH 句柄都不继承"。现在内层命令写成
  `$null | & 'exe' args > out 2> err`（pwsh 自己建一根空管道给子进程，立刻 EOF）。
  Host 侧、子代理提示词与技能文档三处同步。

## package · 0.0.35 · 2026-09-30 · fix · Windows 原生命令捕获收口 + 技能脚本执行进 Host（协议 25）

### feat · `crwu_run_python_script`：把技能脚本的执行收进 Host（协议 25）

子代理原先自己拼 `& 'python.exe' script.py`，而**模型可见的 pwsh 工具与插件的 `ctx.shell`
是同一套 Windows sandbox** —— 于是子代理的 Python 调用照样命中受限沙箱下 native 子进程的
管道缺陷（`0xC0000142` / `EACCES`）。提示词里那份 `Invoke-DshPython` 只是"请照做"，
不保证被执行，也不带退出码与沙箱事实。

- 新增 Host Tool `crwu_run_python_script`（宿主操作 `python.script.run`：来源只给 `audit-tool`、
  **不提权**）。模型只提交 `caseDir` / `script`（**案例目录内**的相对路径）/ `scriptArgs`：
  路径由 Host 用 `joinLocalPath` 拼，绝对路径、`..`、空串一律拒绝；参数逐个作为 argv 传入，
  不经过任何 shell 解析。
- 命令经**同一条 `ctx.shell` seam** 出去，所以自动拿到 `windowsCaptureCommand` 那层
  **只在受限沙箱生效**的临时文件捕获 —— 无需模型照做，也无需第二套执行通道。
- 返回里带 `exitCode` / `stdout` / `stderr` / `truncated` / `timedOut` 与
  `sandbox{requested,resolved,ran,denied,runnerFailed}`，以及本次用的 Python 路径与版本；
  DSH Python 解析不到时如实回 `capability-gap`，**绝不**改成系统解释器。
- 审核指令改为**首选**这个 Tool，原来的 PowerShell 包装器降级成"Tool 不可用时的退路"。

### fix · Windows 原生命令捕获收敛成唯一入口 + 探测失败带结构化事实

- 新增 `windowsCaptureCommand(command, mode)`：**形状**（只有 `shellInvoke()` 产出的
  `& 'exe' args` 才命中那个缺陷）与**沙箱模式**（只有真跑受限沙箱才需要捕获）一起判。
  `crwu` / `dws` / `ossutil` / DSH Python 的每一条命令都经由 `ctx.shell` 那个 seam 走到它，
  调用点不需要、也不允许自己决定要不要捕获 —— "统一走文件捕获执行器"只有这一处判据。
- DSH Python 版本探测失败时把**结构化事实**一起带进错误：`exitCode`、请求与实际的沙箱模式、
  是否被沙箱拒绝、执行器是否没能启动。Windows 受限沙箱的 `0xC0000142` 与"Python 没装"
  处置完全不同（换采集方式 vs 换运行时），只报一句"无法执行"会把两件事混起来。

### fix · Windows 原生命令捕获不再套在提权调用上（凭据读不到的真因）

现场（用户报）：**同一台 Windows 上 `main` 能读到氚云与钉钉凭据，这个分支读不到** ——
扫了码也不行，面板显示「未绑定 / 未知 / 未登录」，看起来像"凭据没写进去"。

- **根因**：`capturePowerShellNativeCommand` 是按**命令形状**（`& '…'`）无条件套上去的，可它
  解决的是**受限沙箱**下的 native-child DLL 初始化失败（0xC0000142）。而 `dsh-pwsh-sandbox`
  的 `execute()` 对 `danger-full-access` 直接 `super.execute()`、**不套 restricted-token runner**
  —— 那个前提根本不存在。于是所有**提权**命令（`crwu h3yun session status` /
  `dws auth status` / `dws doctor` / `ossutil …`，全都是 `danger-full-access`）也被套上了，
  而捕获必须经过 PowerShell 的**文本层**（`>` → `Out-File`）：Windows PowerShell 5.1 默认写
  UTF-16LE，CLI 的 JSON 就成了 `{\0"\0…`，解析失败 → 「未绑定 / 未知」。
  不套捕获时 native 子进程**直接继承 DSH 的管道句柄**，原始字节原样过去，不经过任何编码
  —— 这正是 `main` 的形状。
- **为什么 CI 没拦住**：`tests/windows/powershell-contract.test.mjs` 的 Windows provider 用的是
  **pwsh 7**（默认 UTF-8 无 BOM），而且只断言纯 ASCII 载荷 —— 两个条件恰好把这个缺陷挡在视野外。
  现在补了一条**非 ASCII JSON 逐字节往返**的真 shell 用例，并把「文本层显式钉成 UTF-8 +
  从字节里剥 BOM」写进两个包装器（Host 侧 + 子代理提示词里那份），让它们即使在 5.1 上也不改字节。
- **修法**：新增 `nativeCaptureNeeded(mode)` —— 只有**非** `danger-full-access`（真跑受限沙箱，
  或没声明策略而落到执行器部署默认）才上捕获。提权调用回到 `main` 的命令形状。

### fix · 「授权收据读不出来」不再显示成「需要授权」（协议 24 → 25）

现场（「授权成功、界面永远停在需要授权」，2026-09-30 复查）：磁盘上的
`~/.dsh/crwu-workbench.json` 里躺着一份**合法**收据（`schemaVersion: 1` + 逐字同序的五项能力），
而「账号连接」里的氚云与钉钉两行都显示「需要授权」，插件因此拒绝一切本机凭据访问。

- **先纠正一条推断**：这不是"读被沙箱拒了"。DSH 的 `dsh-fs-sandbox` 只在 `writeText` /
  `editText` 上做可写根围栏，源码原话是 *"Reads pass through untouched: every mode permits
  reading."* —— 本地实测也印证：会话策略 `workspace-write`（工作区在仓库下）时读
  `~/.dsh/crwu-workbench.json` 一切正常，`env.localAccess.state` 就是 `granted`。
  所以"读收据要与写对称地声明提权"并不是这里缺的那一块（fs 的读接口也**没有**逐次策略参数）。
- **真正的缺陷**：`ConfigRead` 只有一个 `ok` 布尔，于是**五种完全不同的事实**在授权层眼里
  长得一样 —— 文件不存在、位置不是普通文件、路径解析 / stat / 读文本抛错、内容解析不出来。
  它们全被折叠成 `missing`，界面于是显示「需要授权」并把员工指向"再授权一次"；而读失败时
  写盘（同样是读-改-写）根本落不了盘。现在逐种都有名字（`absent` / `corrupt` / `no-fs` /
  `no-home` / `not-a-file` / `resolve` / `stat` / `read`），授权层把 **`missing`（真的没有
  收据）** 与 **`unreadable`（读不出来）** 分成两句话。
- 主目录未知时不再拼 `~/.dsh/crwu-workbench.json` 这个字面量：`ctx.fs.resolve()` 不展开 `~`，
  它会变成**相对于会话 cwd** 的路径，于是"主目录探不到"会伪装成"从没授权过"。
- 解析前先剥掉 UTF-8 BOM（**防御性**）：`JSON.parse` 见到 U+FEFF 会直接抛错，而在这里抛错
  会被折叠成"没有授权"。DSH 自带的本地 fs 用 `TextDecoder`（默认剥 BOM），但 fs 后端并不
  保证都这么做。
- `env` / 界面：`localAccess.state` 新增 `unreadable`；氚云、钉钉、OSS、iFinD 的占位事实从
  「需要授权」改为「授权状态读不出来 + 宿主给的原因」，`credentialsConsent` 归 `invalid`，
  issue 的 owner 归 `system`（"把这条原因发给维护者，不是重新授权"）；授权卡不再对被读不出来的
  收据显示"首次使用请允许一次"那段介绍。协议 +1 的理由就是这条：旧客户端读到 `unreadable`
  会当成 `missing`，把员工送回那条走不通的路。

### fix · Windows `workspace-write` 下宿主与审核子代理的 Python 原生命令兼容

- Host 的统一 `ctx.shell` 执行入口现在只对 Windows PowerShell 原生命令启用临时文件捕获，
  再按原始 stdout/stderr 字节转发并保留退出码；macOS / Linux 命令字符串保持不变。
- 审核子代理提示词和 `crwu-audit` 编排契约增加同一套 `Invoke-DshPython` 包装器，材料准备、
  复核与交付脚本不再直接继承受限 PowerShell 的管道句柄。
- 该修复不放宽 `workspace-write`，也不回退系统 Python；Windows 原生 PowerShell 合同继续由
  `tests/windows/powershell-contract.test.mjs` 在 Windows CI 验证。

## package · 0.0.34 · 2026-09-30 · fix · 审核根绑到已选工作空间 + 快照写入带会话策略（协议 24）



现场：点「AI 审核」后，侧栏里新会话出现在**未分组**下，而不是环境信息里选定的工作空间下。

- **根因**：DSH 有两条硬规则把"会话 cwd"同时当成两件事，而我们只满足了一件：
  1. `SandboxPolicyService.resolve()`：*"**A session cwd is its workspace-write boundary**"* —— 边界就是 cwd；
  2. `Workspace.attachSession()`：`if (cwd !== this.record.path) throw …` —— 挂到工作空间下要求
     cwd **逐字等于**工作空间路径。
  我们原先用 `agents.create({ meta: { cwd: 案例目录 } })` 建根，cwd 与工作空间路径不等 →
  `attachSession` 必然抛错 → 只能落「未分组」。而当时那处 `catch` 只往 `notes` 里塞了一句
  "会话已建，但没能挂到工作空间"，界面上看不到 —— 所以看起来像"工作空间没定位到"。
- **正解**（与 DSH 自己创建"工作空间下的新会话"完全同一条口径，也是本插件"与 DeepSeek 讨论"
  那条链路一直在用的：客户端 `sessions.create({ workspaceId })` →
  `cwd = workspace.path` → `ensureSession` → `attachSession`）：
  **审核根的 cwd = 已选工作空间**。子会话继承父会话的 cwd，于是整棵审核树都在工作空间下。
- **跨案例隔离没有放松，只是换了承担者**：`requireAuditScope` 仍然要求每个案例内 Tool 的
  `caseDir` 与本轮记录的 `casePath` **规范解析后精确相等**（工作空间根、兄弟案例、案例子目录
  一律拒绝）—— 这条判据不随 cwd 变化，是跨案例的真正边界。文档里把这两件事分开写清楚了：
  **会话边界回答"这个进程能写哪儿"，案例 scope 回答"这次审核被允许碰哪个案例"**。
- 顺带把那个静默降级也修了：`attachSession` 失败不再只进 `notes`（见下条留档）。

### fix · 三个输入快照 JSON 写不进去（`FS_SANDBOX_DENIED`）

`mkdir 输入快照` 修好之后，下一步又断在这里：`ctx.fs.writeText(target, content)` **不带策略**，
而 `dsh-fs-sandbox` 的 `checkedTarget()` 是
`const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()` —— 没有会话就落到**部署默认**
（进程 cwd），于是往案例目录里写文件被自家沙箱拒：
`cannot write "…": file access denied under workspace-write mode`（`FS_SANDBOX_DENIED`）。
审核停在「未创建子代理」。

修法与 0.0.33 的 shell 侧完全对称，并且**只留一个解析口**：
- 新增 `host/access/caller-policy.ts` 的 `callerSessionPolicy(ctx, session)`（从 Broker 里提出来，
  现在 shell 与 fs 两侧共用同一处判据）；
- 新增 `case-files.ts` 的 `writeCaseText(...)`：解析目标 → 带策略写入（第 5 个参数）→ **回读核对**；
  失败按**结构化错误码**归因（`FS_SANDBOX_DENIED` → sandbox，`EACCES`/`EPERM` → permission，
  其余 infrastructure），不回退到文本猜测；
- 三个写入点全部改走它：输入快照的三个 JSON（`bootstrap.ts`）、知识库清单（`knowledge.ts`）、
  钉钉通知幂等状态（`dingtalk.ts`）。

### feat · 审核发起失败**全部留档**（`state.lastAuditFailure`）

真机连挂四次，每次失败详情只存在于那一次 RPC 的返回里，进程一重启就没了 —— 只能靠"复现 + 读代码"
倒推。现在 `auditStart` 的**每一条失败路径**（同一个闭包，漏不掉）都会把结构化事实落盘并在宿主日志
留一份：阶段（工作空间 / 案例目录 / 审核根会话 / 输入快照 / …）、`errorKind`（照抄工具回报的
结构化归因）、Host 算出来的 `caseDir`、`attemptId`、时刻、以及所有 `notes`（含"没能挂到工作空间"
这类原先被吞掉的降级）。发起成功时清空。**不含命令原文与凭据**。

### test · 覆盖

- `host-audit-root`：**替身照 DSH 的判据拦人** —— `attachSession` 现在会像真实现一样校验
  `cwd === workspace.path`，cwd 写错就抛。用缺陷注入验过：把根的 cwd 改回案例目录，4 条用例立刻变红
  （改之前它们全绿 —— 这正是这个 bug 溜到真机的原因）。
- `host-case-files`：`writeCaseText` 两个分支（不带会话 → `FS_SANDBOX_DENIED` + 归因 sandbox +
  一个字都没落盘；带会话 → 写入 + 回读一致 + 请求里带着案例边界）。
- `host-tools`：集成层的 fs 替身也换成**按策略拦写**的版本，断言三个 JSON 真的落盘、且没有被拒的写入。
- `host-audit-lifecycle`：失败留档（阶段/归因/案例目录/notes）与"发起成功清空"。
- 三条都用缺陷注入验过会红。

## package · 0.0.33 · 2026-09-30 · fix · 非特权命令带**调用方会话的策略**（0.0.32 修错了地方）

### fix · 同一个报错又出现了一次：这次定位到真机制

0.0.32 之后真机**原样复现**同一条失败：

```text
创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）
```

- **0.0.32 的修法是无效的**：它把"调用方的 `ctx`"传进 Broker。但 DSH 的执行器
  **不持有会话**（`dsh-sandbox-policy` 原话：*executors and providers remain session-free*）——
  换 `ctx` 只是换个地方 `ctx.get('shell')`，拿到的还是同一个执行器，请求里没带 `sandboxPolicy`
  时它照样用**部署默认**（`workspace-write` + 配置兜底根 = 进程 cwd）。
- **正解**：像 DSH 自带的 bash / fs 那样，**调用方把自己的会话策略算出来放进请求**。
  - `BrokerShellOptions.session`（替换掉 0.0.32 的 `scope`）：**不是权限开关**，提权仍只由
    `privileged` 决定；非特权操作由 Broker 用 `ctx.sandboxPolicy.resolve({ session })` 解析，
    作为 `sandboxPolicy` 随请求下发；
  - `runShell` / `startShell` 新增 `sandboxPolicy` 选项（`shell/run.ts`），请求模式照旧记进诊断
    （`requested` 不再是空串）；
  - 案例内的调用点（`crwu_audit_case_bootstrap` / `crwu_audit_knowledge_materialize`）传
    `exec.agent.session`（新助手 `callerSession(exec)`）。
- **替身也要按策略拦人**：新增 `tests/helpers/fs-sandbox-stub.mjs` —— 复刻"缺策略 → 部署默认 →
  写被拒"，并只拦**写**（DSH 的可写根管的正是写，只读探测照常回话）。
  以前那种"永远成功"的 shell 替身正是这两个缺陷在单测里全绿的原因。
- 失败文案现在带**插件版本**（`… · 插件 pkg-0.0.33`）：真机排障第一件事是"装的是哪一份产物"，
  而源码检出形态的客户端徽章只显示 `dev`。

### test · 覆盖

- 单元（`host-case-files.test.mjs`）与集成（`host-tools.test.mjs`，真调 `crwu_audit_case_bootstrap`）各一条：
  不带会话 → 复现真机那句话（且**真的**被沙箱拦下）；带会话 → 请求里带对边界、快照三个 JSON 落盘。
- 两条都用**缺陷注入**验过（去掉 Broker 的会话策略、去掉调用点的 `session`，各自立刻变红）。

## package · 0.0.32 · 2026-09-30 · fix · 案例内的非特权命令按**调用者的会话作用域**执行（协议不变）

### fix · 输入快照目录建不出来：`Operation not permitted（沙箱拒绝=是）`

真机验收第一轮就抓到（案例目录本身已经建出来了 —— §一 的修复是生效的）：

```text
输入快照交接未完成，已终止本次审核（未创建子代理）：输入快照交接失败（infrastructure）：
创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）
```

- 根因：**Broker 自己持有的是插件级 `ctx`，它没有会话**。非特权命令（案例目录之内的建/删/探测）
  不带 `sandboxPolicy`，沙箱边界由"执行它那个 ctx"解析出来的会话决定 —— 插件级 ctx 解析到的是
  **部署默认**（`workspace-write` + 配置里的兜底根，即进程 cwd），而不是调用方那条会话的 cwd。
  案例目录恰恰就是审核根会话的 cwd，于是"写自己所在的目录"被自家沙箱拒了。
  这与我上一版写下的注释（"子会话的沙箱边界本来就是那个目录"）不符：那句话只在**命令真的跑在
  子会话作用域里**时才成立，而经 Broker 执行时并没有。
- 修法（保持"提权只由操作表决定"这条口径不变）：`BrokerShellOptions` 新增 `scope?: Context` ——
  **不是权限开关**，提权仍由 `privileged` 决定、模型与客户端都碰不到它；它只回答"非特权命令落在
  谁的沙箱解析里"，与 `tools/types.ts` 的 `toolContext()` 同一条口径。`ensureDirectory` /
  `removeFileIfExists` / 案例内探测新增 `scope` 透传，`crwu_audit_case_bootstrap` 与
  `crwu_audit_knowledge_materialize` 把**调用者 Agent 的 ctx** 传下来。
- **协议不变（23）**：操作集、字段与语义都没变，变的是 Host 内部"这条命令按谁的作用域执行"。
  版本号 +1 只为让你一眼看出装的是修好的那份产物。

### test · 覆盖

- 单元：两个 ctx（插件级 / 调用者作用域）各一个 shell，断言案例内命令**只**落在调用者作用域上。
- 集成（`crwu_audit_case_bootstrap`）：③ 不带作用域 → 复现真机那句话（`创建快照目录失败` +
  `system.case-file.write` + `沙箱拒绝=是`，且一个目录都不建）；④ 带作用域 → 快照三个 JSON 落盘。
- 两条都用**缺陷注入**验过：把 `scope` 摘掉（Broker 侧与 bootstrap 侧各一次）立刻变红，还原即绿。

## package · 0.0.31 · 2026-09-30 · feat · 报告讨论会话的受限材料范围（协议 23）

### feat · 讨论会话也能取材料，但只取"登记那一刻的那批附件"

- 现场：案例目录创建修好之后，**报告讨论会话**里调 `crwu_h3yun_file_get` 仍然一件材料都取不回来 ——
  它是一条普通顶层会话，没有审核记录，而附件下载原先只认审核 scope（「调用者不在进行中的审核里」）。
- 修法**不是**让它复用审核 scope（那是扩大边界：审核 scope 绑着一条正在跑的子会话），
  而是给它一份**自己的、更窄的**范围：
  - 新增 Host 操作 `discussion-material-open`（协议 23，操作清单 38 → 39）；
  - 客户端在 `ensureDiscussion`（新建**或**恢复）之后、发 kickoff 之前调；只提交
    `sessionId` / `seqNo` / `objectId`；
  - Host 负责：拒绝子代理会话 → 用 `caseDirOf` 算出 `<已选工作空间>/<流水号>` →
    **自己按 `objectId` 取一次记录并核对 `ObjectId`/`SeqNo`**（只看附件清单的话，
    `seqNo=A, objectId=B` 会把 B 的白名单登记成 A 的案例目录）→ 重新取一次附件清单 →
    把这一批 `fileId` 记进**进程内**白名单（12 小时 TTL、最多 32 条、`use()` 推最近使用时刻）；
  - 回传 `caseDir` 与附件清单（`fileId` / `fileName` / `localName` / `fileSize` / `nameTotal`）。
- 工具侧：`requireAuditScope` 之上新增 **`requireMaterialScope`** —— 先看审核子会话 scope
  （有就以它为准，边界更窄），否则看讨论注册表（案例目录与白名单全部来自 Host 记录）。
  `crwu_h3yun_file_get` 改用它；**普通顶层对话仍然拒绝**。
- 讨论会话**不是氚云查询入口**：`crwu_h3yun_record_get` / `crwu_h3yun_files_list` 对
  **已登记**的讨论会话一律拒绝（`crwu-h3yun-query` 技能依赖的"普通会话可按 objectId 查记录"
  这条既有能力**保持不变** —— 收窄的只是讨论会话）。
- 提示词：kickoff 里新增「本次登记的材料」一段（`fileId` ↔ 落盘名成对给出，同名附件标 `同名 N 件`），
  取数规则改成"落盘名必须用这一段给出的名字"。报告讨论与审核结果分析共用这一段规则，
  所以**两条会话都登记**（否则分析会话会读到"用下面给出的落盘名"却找不到"下面"）。
- 登记失败时**不发 kickoff**、会话保留、给出可重试的明确文案；不降级去扫本机目录、也不自己查氚云。
- **续聊也要重新登记**：范围只在 Host 内存里，插件重启或 12 小时后旧会话默认拿不到材料。
  所以「继续上次聊天」这条路径也会先登记一次（不重新拉文件、不重新读 OSS、不重复注入 Prompt）；
  登记失败**不拦着进会话**（用户要的是继续聊，历史都在），原因写进面板，会话里 Tool 也会给出
  「请重新登记」的可执行文案。审核结果分析那条会话同样登记（两处共用同一段取数规则）。

### fix · "查不出来"不再被说成"不存在"（错误分类的两处收紧）

- 工作空间探测**本身失败**（shell 服务没起来 / 被沙箱拦下 / 输出不可识别）原先被折叠成
  「所选工作空间不存在」—— 那会把一次宿主侧的拒绝说成"员工选错了目录"，让员工去重选一个
  本来没错的目录（正是 §三 要消灭的误诊）。现在如实报「无法确认所选工作空间是否存在」，
  并按结构化事实归因（沙箱拒绝 → `sandbox`，其余 → `infrastructure`）。
- 建目录的结果里补齐**完整诊断事实**：`facts` 增加 `processStarted`（计划里那个 `ran` 布尔），
  结果新增 `postcondition`（`directory` / `file` / `absent` / `unknown`）——
  "命令跑过了"与"目标真的成了我们要的样子"从此是两个字段。

### test · 覆盖

- 注册表：TTL 到期即失效、重复登记刷新白名单与 TTL、`use` 推最近使用、超上限丢最久没用过的。
- 解析器：已登记会话放行；未登记 / 过期 / 错误的 `caseDir`（工作空间根、兄弟案例、子目录）/
  不一致的 `seqNo`·`objectId` 一律拒绝；同一 id 两边都命中时**以审核 scope 为准**。
- 工具：讨论会话能下白名单附件、清单外 `fileId` 与未登记会话零命令拒绝、
  `record_get` / `files_list` 对讨论会话拒绝。
- 登记 RPC：成功登记（含"文件身份核对不通过就不去取附件"）、子代理会话拒绝且零命令、
  参数不合法与没有工作空间时拒绝且不登记。
- 客户端：新建与恢复都登记、失败不发 kickoff、抛错变人话、旧宿主（没有这个能力）行为不变。
- **授权矩阵**逐格钉住（三种调用者 × 三个氚云 Tool）：允许的四格真的执行、拒绝的七格零命令。
- 审核启动：建目录失败时**后续步骤一个都不许发生**（无记录 / 无占用 / 无快照交接 / 无子代理），
  且错误里带得出操作名与工作空间；探测没结论时不许说成"工作空间不存在"。
- **产物级**：`npm run smoke:built` 现在也从打包后的 `lib/index.js` 真调一次
  `discussion-material-open`（空参数 → 结构化 `input` 失败、不回路径），证明这条新契约在**装上去的
  产物**里可达 —— 只查源码"写了没有"证明不了这件事（用缺陷注入验过这条断言会红）。

## package · 0.0.30 · 2026-09-30 · refactor · 配置入口收敛：iFinD 改回可选数据源、账号连接只读、插件不建工作空间

### 目标

一次收敛三件事，职责边界变成：**环境信息**判断基础条件 / **外部数据源**（配置列表里的一步，
可选、不带必检星号）展示与配置 / **账号连接**只读取、检查已有凭据 / **工作空间**只选择已有目录。

### refactor · 同花顺 iFinD 从「必需项」改回**可选数据源**

- 清单 `ifind.required=false`：不进必需项分母（8 → 7），未就绪只让 `status` 落到 `degraded`
  （与 `ready` 一样**放行**），只关掉 `capabilities.externalData` —— `global` / `auditCore` /
  `delivery` 与报告审核都不受影响。
- issue 从"双写 global + external-data 的阻塞项"收成**一条非阻塞**项（scope = `external-data`）：
  归属仍按原因分派（未填 / 无效 → user；无权益 → admin；网络 → system），因为"谁来修"三类不同。
- 环境页顶部改为「基础环境已就绪」，不再出现「还需完成 1 项 / 请完成同花顺 iFinD API-Key 验证」；
  门禁文案回到通用模板（`hasIfindBlocker` 那条专门话术删除）。
- 侧栏那枚环境灯的判据改成 `statusProceedable`：`degraded` 也是绿的，
  否则会出现「红点 + 基础环境已就绪」的自相矛盾。
- 外部数据源**和别的配置项并排**放在配置列表里，而且**排在最后一步**
  （账号连接 → 阿里云 OSS → 工作空间 → 同花顺 iFinD）：那一步的正文就是 iFinD 卡片
  （状态统一为 未配置 / 待验证 / 已配置并验证 / 验证失败 / 数据权限不足 / 暂时不可用）。
  **未配置时直接显示「未配置」**：芯片一律琥珀（红 = "必须处理"），能力清单等已配置后再显示。
- **基础必检项带红色星号**（`REQUIRED_SETUP_STEPS`：账号连接 / OSS / 工作空间；颜色用
  `--dsw-alias-state-error-primary`），**外部数据源不带** —— 用户口径：必检项用星号表示"必须配置"，
  外部数据不加，否则页面看起来很乱。可选项同时不进"还没做完"的统计（`pickStep` / `allStepsDone`
  只统计必检项，且默认落点是**最后一个必检项**而不是末位的可选项）。
- 形态上做过**三次**返工：① **独立的第四个侧栏模块**（被否：「不要单拆一个目录」）；
  ② **页级区块**（被否：「也和其他放在一起…否则页面看起来很乱」）；③ 放在列表中间且"未配置"报红
  （被否：「同花顺这里直接显示未配置就可以」+「把同花顺放到最后一个」）。最终就是**配置列表里的
  最后一步**。

### feat · Windows：提醒"以管理员身份运行"（2026-09-30）

- 钉钉 CLI（`dws`）在 Windows 上要碰 `<HOME>\.dws`（先抢 `.data.lock`，再写操作系统凭据存储）：
  进程权限不足时它以"锁被占用 / 拒绝访问"结束，**表现却是钉钉登录一直不成功**。
- 所以环境页在 `env.platform` 命中 `win32` 前缀时给一条**非阻塞**提醒
  （`features/environment/platform-note.ts` 的 `needsWindowsAdminReminder`）：
  「请用「以管理员身份运行」启动 DeepSeek Harness」——挂在**账号连接**那一步。
- 它**不参与任何门禁**（钉钉登录态是否有效仍由自检结论说了算）；非 Windows **一个字都不提**，
  拿不到平台也不猜。

### refactor · 账号连接只读取、检查已有凭据（协议 21 → 22）

- **删除**氚云内置浏览器扫码登录（协议 20 的 `browser-session-bind` + 客户端浏览器视图 + Cookie 读取）
  与钉钉设备码 / 两阶段登录（协议 21 的 `dws-login-start` / `dws-login-status` + 进度轮询）。
  一并删除 `H3yunBrowserLogin.tsx` / `DwsLoginCard.tsx` / `login-browser.ts` / `open-url.ts`
  （内置浏览器优先的打开器）、`crwuOperationOf` 的 `h3yun session bind` 映射、`dwsLogin` 的 `--device`。
- 保留**兼容路径**：`relogin`（`crwu h3yun session login`）与 `dws-login`（`dws auth login`）——
  本机 CLI 自己拉起**系统浏览器**；面板只触发 + 「重新检查」，不创建浏览器 Tab、不显示二维码 /
  设备码、不读 Cookie、不轮询进度。CLI 的 `dws auth login --device` 在终端里仍然可用。
- 冻结操作清单 41 → 38；`WORKBENCH_PROTOCOL` 22（旧界面调这三个操作会 404，必须被明确挡住）。

### refactor · 插件不再为用户创建工作空间根目录

- `ensureAuditRoot` 删掉 `ensureDirectory`（`mkdir` / `New-Item`）：路径为空 →
  「尚未选定工作空间，请先选择一个已有目录」；路径不存在 / 是文件 →
  「已选定的工作空间目录不存在，请重新选择一个已有目录」——两种情况都**拒绝启动**，
  不静默切到父会话 cwd、也不静默换工作空间。
- 目录存在但未登记 → **只登记**（`workspaceRegistry.create`，它要求目录已存在）。
- 客户端 `UiWorkspaceService` 删除 `createDirectory`，`WorkspaceCard` 去掉「新建目录并用作工作空间」
  与 `pick(true)`，把用户选中的路径原样登记；文案改为「选择已有目录作为工作空间」。
- 允许自动创建的**只有** `<工作空间>/<流水号>` 这一级案例目录（审核启动的 shell 轨迹里
  不许出现 `mkdir <工作空间根>`，有测试按真实 trace 断言）。

### fix · 案例目录创建改走本机访问代理（`mkdir: Operation not permitted` 的根因）

- 员工实测：发起审核后案例目录**没建出来**，子会话里案例内 Tool 全被拒（"调用者不在进行中的审核里"），
  而 `/Users/<员工>/中瑞世联工作空间` 本身是可写的。根因不是 ACL，也不是授权收据：
  `host/tools/case-files.ts` 的 `ensureDirectory` 直接调 `shell/run.ts` 的裸 `runShell`，
  于是这条 `mkdir` 拿到的是**部署默认沙箱**（`workspace-write`，边界 = 员工打开面板的那个会话 cwd），
  写案例目录被沙箱拒绝 —— 员工本人对那个目录其实是有写权限的。
- 新增三条**具名**本机访问操作，提权归属从此写在操作表里（`host/access/operations.ts`）：
  - `system.case-directory.write`：**特权**、来源 `audit-host` —— 只用于创建
    `<员工选定工作空间>/<流水号>` 这一级案例目录，逐次声明
    `danger-full-access` + `workspaceRoot = 已选工作空间`；
  - `system.case-file.write` / `system.case-file.read`：**不提权**、来源 `audit-tool` ——
    案例目录**之内**的建 / 删 / 只读探测（子会话的沙箱边界本来就是那个目录，能给最小权限就给最小）。
- 新增来源 `audit-host`（插件自己的审核编排），与 `audit-tool`（审核子代理调 Tool）刻意分开：
  两者的沙箱位置不同，合并会让"谁在什么沙箱下建目录"重新变成只能从调用点读出来的事实。
- `ensureCaseDirectory` 的顺序固定：① 只读探测工作空间是否真的存在 → ② 经 Broker 执行 `mkdir`
  → ③ 回读案例目录后置条件。**失败分三类给话**：沙箱未授权 / 被降级（带请求模式、实际模式、操作名、
  工作空间）、操作系统 ACL 不足（不动权限、不建议 `chmod`）、工作空间不存在（让员工重选）。
- 后置条件回读不再用 `ctx.fs.stat`，改用 Broker 上的只读路径探测
  （`platform/shell.ts` 的 `pathProbeCommand`：`test -d` / `Test-Path -PathType`，
  **永远以 0 退出、结论只在 stdout**）：这样"读不到"与"不存在"能分开 ——
  前者按基础设施失败如实上报，不会被折叠成"没有这个目录"。
- 新增静态门禁 B-01e（`host-access-migration.test.mjs`）：`case-files.ts` **不许**再出现裸 `runShell`
  或值导入 `shell/run.ts`，`audit/ops.ts` 必须用 `ensureCaseDirectory`；配套一台
  **真的会拦人**的沙箱替身做回归（`host-case-files.test.mjs`），把 2026-09-30 的现场固定下来。

### fix · 同名附件不再互相覆盖（`广兴建筑v3.zip` ×2）

- 一份报告里可以挂着两个**同名但不同**的附件（实测两个 `广兴建筑v3.zip`，`fileId` 不同）。
  按文件名落盘时第二件会**静默覆盖**第一件 —— 审核只看到一份材料，也答不了"这是重复上传还是两个版本"。
- 输入快照的 `附件清单.json` 每行新增三列：`localName`（`<主名>__<fileId 前 8 位><扩展名>`，
  例如 `广兴建筑v3__c8ef13b8.zip`）、`nameIndex` / `nameTotal`（同名附件的序号与总数）。
  名字**只由 `fileId` 决定**，与下载顺序无关；外部文件名先被收敛成单个路径段
  （`host/h3yun/attachment-name.ts`，纯函数、可单测）。
- `crwu_h3yun_file_get` 在任何进程之前校验目标名的最后一段**必须带上这件附件自己的标识**，
  不带就回 `policy` 失败并给出正确的名字；`relativePath` 仍然由模型给，但它再也拼不出
  两个不同附件落成同一个名字的形态。
- 审核提示词同步：附件只按清单里的 `localName` 落盘；`nameTotal > 1` 的条目要当成**两件材料**
  逐件核对，不许只留一件。

### test · 覆盖

- 工作空间：不渲染「新建」按钮、`createDirectory` 调用次数为 0、目录不存在 / 是文件 / 未选定时
  审核启动被拒、存在但未登记时只登记、审核启动不建工作空间根、案例目录仍然创建。
- 登录：相关模块文件已删 + 面板不存在内置浏览器登录 / 二维码 / 设备码入口与承诺、
  阻塞文案改为"请在系统浏览器完成登录后重新检查"、有效凭据照常通过、CLI 兼容路径仍在。
- iFinD：不在环境步骤与必需项分母里、未配置不阻塞环境与审核、区块展示数据源与验证状态、
  未配置时不产生误导性告警。

## package · 0.0.29 · 2026-09-29 · fix · 启动审核：「没问到运行时」不再拒绝启动（交给子会话解析）

### fix · 案例目录建不出来 / 子会话没有 scope 的那条根因

- 员工实测：发起审核后**案例目录没建**、子会话里案例内 Tool 全被拒（"不在进行中的审核里"），
  而能力自检里二进制与 Tool 全 available —— 说明这轮审核根本没成立。
- 根因：`audit-start` 在创建案例目录**之前**解析 DSH 自带运行时，而它在 `host-background` 里
  没有会话作用域 → 工具调用必然报错 → 旧实现一律拒绝启动。
- 现在按 `unresolved` 分开处置：**确实缺失**（载荷无 python / 路径不可用 / 缺必需包）仍然拒绝启动；
  **没能问到**（工具调用失败/超时/报错）**放行**，并把提示词换成新增的
  「由你在本会话里解析」那一段 —— 子会话有 agent 作用域，自己调一次
  `load_workspace_dependencies` 就能拿到唯一允许的解释器绝对路径；仍然禁止任何查找与降级，
  取不到就停下并汇报 capability gap。
- 另记一条**独立阻塞**（不在插件侧、也不该由插件绕过）：该机器上 `workspace-write` 下 pwsh
  每次以 `0xC0000142` 结束、零输出；而审核根/子会话按设计恒为 `workspace-write`，
  材料准备与交付渲染都走 shell → 需 DSH 侧排查沙箱启动器。

## package · 0.0.28 · 2026-09-29 · refactor · 把 DSH 自带运行时**从环境自检里挪走**

### refactor · 运行时只在 `audit-start` 解析，不再进环境结论

- 原因：`load_workspace_dependencies` **需要 agent 作用域**。会话里调它返回完整载荷
  （`python` + `openpyxl` 等），而环境自检跑在 `host-background`、没有会话上下文 —— 调它就是工具报错。
  两种补救都不成立：当"缺失"会伪造「系统故障」把审核入口关掉（0.0.26 之前）；
  只显示「待复核」则那一行**永远解析不出来**（0.0.26/0.0.27 员工实测仍是「未设置」）。
- 现在：环境自检**不再调用解析器、不再有这一行、不再进必需项分母（9 → 8）、不影响总状态**。
- **能力没有放宽**：`audit-start` 仍用审核根 agent 解析运行时，拿不到就终止审核；失败文案区分
  「没能问到」（可重试）与「确实缺失」（只能由部署方补运行时）。取 agent 的唯一实现是
  `boundParentAgent`（`bind-session` 落盘的父会话），`audit-start` 与它共用。
- 一并删除：`RuntimeView`、`env.runtime` 分区、`runtimeItem`、`runtime` issue、
  客户端三行诊断与相关文案键（不留死代码）。解析器本身保留（`audit-start` 要用）。

## package · 0.0.27 · 2026-09-29 · fix · 环境自检用面板绑定的父会话解析 DSH 运行时（真正修掉"未设置"）

### fix · 运行时不再显示「未设置」：自检也带上 agent 作用域

- 0.0.26 只把"没问到"说准（非阻塞 + 待复核），但运行时**仍然解析不出来** —— 因为根因是
  **自检没有 agent 作用域**：`load_workspace_dependencies` 需要它，不带就是工具报错。
- 现在自检在调 `pythonRuntime` 之前，用插件状态里 `bind-session` 落盘的 `parentSessionId`
  取同一个 agent（新增唯一实现 `boundParentAgent`，`audit/spawn.ts`；审核启动用的也是它）。
  取不到时退回不带 agent 的调用（只报「待复核」，不判缺失）。
- 实测依据（员工 Windows）：同一个工具在会话里（带 agent）返回完整载荷
  （`python` 路径 + `openpyxl 3.1.5` 等），自检上下文报错 —— 差别就是 agent 作用域。
- 解析成功会进缓存，因此环境页那一行会变成「Python 3.12.x · DSH 自带」，总状态回到 `degraded`/`ready`。

## package · 0.0.26 · 2026-09-29 · fix · 环境自检「没问到」不再伪造成系统故障（运行时待复核）

### fix · `load_workspace_dependencies` 在自检上下文问不到时，不再把审核入口关掉

- 员工 Windows 实测：环境页报「发现系统故障」，只有 `DSH Runtime: （未设置）` 一项；
  而**同一个工具在会话里（带 agent）返回完整载荷**（`python` 路径 + `openpyxl` 等全部必需包）。
  根因：环境自检跑在 `host-background`、**没有会话 agent**，而该工具需要 agent 作用域；
  旧实现把"工具报错"一律说成"DSH 自带脚本运行时不可用"——一条系统归属的阻塞项。
- 现在把两件事分开：`unresolved`（工具不可用 / 抛错 / 超时 / 工具报错 = **没问到**）与
  **真·缺失**（工具成功但载荷没有 python、路径不存在或不是文件、缺必需包）。
  前者**非阻塞**、页面显示「待复核」并说明"发起审核时会复核"；后者照旧阻塞。
- 真正的门禁不变：`audit-start` 仍带**审核根 agent** 解析运行时，拿不到就终止审核；
  解析成功会进缓存，所以发起过一次审核之后环境页那一行会变成"已就绪"。
- 顺带：`SetupItemView` 新增状态词 `unresolved`（「待复核」），客户端按中性语气渲染。

## package · 0.0.25 · 2026-09-29 · refactor · 下掉"插件自指定目录"：配置与临时目录都用默认

### refactor · `DWS_CONFIG_DIR` 与 `TMPDIR/TEMP/TMP` 两条自指定通道整体移除

- 删除 `src/host/dws/config-dir.ts` 与 `src/host/system/auth-scratch.ts`，以及各调用点的目录注入
  （`dws/run.ts`、`system/ops.ts`、`crwu/run.ts` 的 `scratchDir`、`ops/core.ts`、`apply.ts`、
  体检/身份/环境自检/审核 Tool）。
- 登录命令回到 CLI 默认形状：`crwu h3yun session login`、`dws auth login [--device]` 原样执行，
  配置目录用 `<HOME>/.dws`、临时目录用系统 TEMP —— 与员工自己终端里的用法一致，状态只有一处。
- **为什么下掉**（三次对照，见 `docs/development-notes.md` §16）：同一个 `dws.exe` 在员工自己的
  PowerShell 里能建 `~/.dws`、能打印授权链接；换成插件目录后**仍然**建不出目录；手工预建好目录后
  **仍然**打不开 `.data.lock`；**以管理员身份运行 DSH 一次通过**，而普通权限下连已存在的锁都打不开
  —— 拦的是这台机器对 `dws.exe` 的按程序/按父进程访问控制，换目录解决不了，只留下"两套状态"的代价。
- 归因文案相应补一句「插件已经不再自指定目录，全部回到 CLI 默认」，两条可执行路径不变
  （以管理员身份完成登录 / 让管理员按程序放行随包发布的 `dws.exe`）。

## package · 0.0.24 · 2026-09-29 · fix · 归因补上复验结论：提权**不是一次性步骤**，影响面不止登录

### fix · 别再让人以为"提权登一次以后就好了"

- 员工复验：提权那次登录成功之后，**用普通权限重启 DSH 依旧打不开已存在的锁**
  （`creating config dir for lock` / `opening lock file`）→ 非提权运行时 `dws` 连打开已有文件都被拒。
- 归因文案补两句：① **不是一次性步骤**（非提权每次都会被拒）；② **影响面不止登录** ——
  同一台机器上凡是依赖 `dws` 的功能（知识库下载、钉钉归档与通知）同样需要提权才能用。
- 两条长期正解不变：让 IT 按程序放行随插件发布的 `dws.exe`（放行后恢复普通权限运行），
  或在放行前以提权方式使用 DSH。

## package · 0.0.23 · 2026-09-29 · fix · 登录失败归因纠正：这台机器上**提权才有效**，换目录无效

### fix · 不再把员工指向"切访问模式"

- 0.0.22 的归因里写着「切权限不会有用」—— 前半段（切【DSH 访问模式】没用）是对的，
  但它被写成了"切权限一律没用"，而员工当场实测：**以管理员身份运行 DSH 后一次通过**。
  两条实测事实必须分开说，否则会把下一个人指到错方向。
- 现在机器支的文案改为：说清事实（请求与实际都已是 `danger-full-access`）+
  给出两条可执行路径（**以管理员身份运行 DSH 完成一次登录**；长期让 IT 按程序放行 `dws.exe`）+
  明确写出「**换目录也没用**」（主目录根、插件状态目录、手工预建的插件目录三个位置都试过）+
  「设备码登录同样要创建这个锁文件，不是绕过办法」。
- 提权那次登录的凭据写进**员工本人**的操作系统凭据存储（同账户、只是令牌提权），
  因此受管机器上"提权做一次性登录"是可接受处置。
- 测试用 `doesNotMatch` / `match` 双向钉住这两点，并逐条用缺陷注入证伪。

## package · 0.0.22 · 2026-09-29 · fix · `dws` 配置目录固定用插件自己的目录（协议 22）

### fix · 钉钉登录不再依赖 `<HOME>/.dws`（那台机器上 DSH 的子进程建不出来）

- 员工 Windows 实测：`creating config dir for lock: mkdir C:\Users\<你>\.dws: Access is denied`，
  而 DSH 的诊断里三种模式全是 `danger-full-access` —— 与 DSH 的文件策略无关。
- 证据链（详见 `docs/development-notes.md` §16）：① 同一个 `dws.exe` 在员工自己的 PowerShell 里
  能建 `~/.dws` 并打印授权链接；② **`~/.dws` 已存在也照样报同一个错** —— Windows 的
  `CreateDirectory` 先查父目录创建权再查目标是否存在，所以这是**令牌访问范围**问题，不是缺目录；
  ③ DSH 放行它自己的目录树（插件状态文件与登录临时目录都是插件在 DSH 里建的）；
  ④ 全新空目录里 `auth status` 仍 `authenticated:true` → **token 在操作系统凭据存储里，换目录不丢登录态**。
- 现在所有 dws 调用**一律显式**带 `DWS_CONFIG_DIR=<HOME>/.dsh/crwu-workbench/dws-home`
  （显式写进命令，不再赌进程有没有继承环境变量）。
- **刻意不做**探针、不做"失败后换目录"、不做重试：登录是有副作用的交互，不能靠重试兜；
  而只读的 `auth status` 在只读路径上可能不碰锁，拿它当判据实测会漏判。
- 代价如实说：员工自己终端里的 `dws` 与插件用不同配置目录（锁/日志分开；
  多组织时"当前组织"可能要各选一次）。

## package · 0.0.19 · 2026-09-29 · feat · 两个登录都改走内置浏览器（协议 20 / 21）

### feat · 氚云：面板内嵌 lease 浏览器扫码，读到 h3_token 就交给 CLI 落 OS 凭据存储

- 环境页新增「在内置浏览器里扫码登录」：插件在桌面端自建一个宿主的 lease guest
  （`dshDesktop.browser.acquire` → `<webview partition src="about:blank#<lease>">` → `dom-ready` 后导航），
  扫码后从页面 `document.cookie` 读 `h3_token`，**立刻**经新增操作 `browser-session-bind`（协议 20）
  交给 `crwu h3yun session bind --token-stdin`。令牌不进命令行、不落盘、不回显、不进日志。
- 拿不到内置浏览器（Web profile / 旧桌面端）时卡片禁用并给出回退说明；CLI 自己拉浏览器的老路径保留。
- E1 探针实测（桌面端 0.2.0-rc.2，macOS，钉钉扫码一次）：lease 桥可用、`<webview>` 可附着、
  `executeJavaScript` 可读 `document.cookie`、`h3_token` 是未过期 JWT（约 48h）、
  导航里出现 `www.h3yun.com/entry/login/corp?code=` 回调、`release` 干净。
  备通道（抓 `?code=` 由 Host 换取）已观测到，暂不启用。

### feat · 钉钉：`dws auth login` 改成后台跑 + 两阶段（协议 21）

- 旧形态是同步等 5 分钟再回 stdout 尾巴 —— 授权 URL 到界面时用户早已不在等。现在
  `dws-login-start` 起后台进程并立刻回快照，`dws-login-status` 轮询；界面先把**动作**摆出来
  （打开授权链接 / 复制设备码），再给 CLI 原文。解析是尽力而为，`tail` 始终是原文。
- **打开在 DSH 内置浏览器**（右侧栏 browser 标签，`openTab`），拿不到服务 / 标签类型未启用 /
  异步失败才退回系统浏览器 —— 裸 `window.open` 在桌面端等于"跳到 DSH 外面"。
- 正在跑时再 start 不会起第二个进程（两个 `dws` 会抢同一个 `~/.dws` 锁）；
  5 分钟到点杀掉并如实报超时；插件卸载时杀掉仍在跑的进程。
- 副作用：所有操作数与协议号随之 +1（41 个操作 / 协议 21），冻结清单与 facade 已同步。

### chore · 新增后台执行通道

- `src/host/shell/run.ts` 的 `startShell` + Broker 的 `startShell`：与前台同一条授权/提权判据，
  用 `execute()` 但不 await `result()`，请求带 `onExpiry: 'none'`。

## package · 0.0.18 · 2026-09-29 · chore · 把 DSH 0.2 线的验证矩阵推进到 `0.2.0-rc.2`

### fix · iFinD 环境检查改为只读用户主动验证结论

- 保存 API-Key 或点击「重新验证」时完成一次真实取数，并把脱敏结论随凭据保存。
- 普通环境检查、刷新和能力门禁只读取最近结论，不再主动请求 iFinD 远程服务。

桌面端 DSH 已升到 `0.2.0-rc.2`。**业务代码零改动** —— 逐包比对证明这条线内没有 API 漂移，
要补的是"声明支持"与"真的验过"之间的差：仓库原先只在矩阵里验到 `0.2.0-rc.1`。

**逐包比对结论**（2026-09-29，把 16 个插件用到的 `@deepseek-ai/dsh-*` 在 rc.1 / rc.2 各
`npm pack` 一次，解包后逐文件 diff）：

| 差异 | 包 |
| --- | --- |
| **所有 `.d.ts` 零差异** | 16/16 |
| 只有 `package.json`（版本号 + 内部依赖表） | 13 个：`dsh-tools` / `dsh-agent` / `dsh-sandbox-policy` / `dsh-user-approval` / `dsh-skill-filesystem` / `dsh-host-webserver` / `dsh-plugin-manager` / `dsh-shell` / `dsh-session` / `dsh-fs` / `dsh-util-values` / `dsh-client-ui-layout` / `dsh-app-boot` |
| 另有运行时代码小改动 | `dsh-subagent/lib/typert.host.js` 多一条 `user-question-reply` typert 协议声明；`dsh-client-ui-renderer/lib/client.js` 加一个 `useMemo`；`dsh-client-ui-sidebar/lib/client.js` 去掉品牌按钮外层 `Tooltip` 并换版本号 |

据此：把 `src/` 复制进一个只装了 `0.2.0-rc.2` 完整 peer 集的临时工程跑 `tsc --noEmit`，
**0 error**；插件用到的 slot / Tool / Shell / Sandbox / Subagent API 一个都没变。

**本版改了什么**

1. **兼容矩阵的代表版本换成 `0.2.0-rc.2`**：`scripts/check-dsh-compat.mjs` 的 `RUNTIMES`
   与 `tests/unit/host-package.test.mjs` 的 `SUPPORTED_DSH_RUNTIMES`。一条声明线只放一个
   代表版本（同线后续 rc 与正式版由 `^0.2.0-rc.1` 的区间语义覆盖），`0.3.x` 仍然明确不在范围内。
2. **`devDependencies` 从 `^0.1.7-rc.2` 挪到 `^0.2.0-rc.2`**（15 个，与全部 peer 一一对应）：
   默认的 `npm run typecheck` / `npm test` 现在验的就是员工装到的那条线，而不是旧线。
   `peerDependencies` 与 `engines.dsh` **不动** —— `^0.1.7-rc.2 || ^0.2.0-rc.1` 本来就覆盖 rc.2，
   0.1.7 线的用户不受影响。
3. 文档同步：`README.md` / `README.en.md` 的支持矩阵与兼容段落、`AGENTS.md` §8.6
   （新增「同一条线内的新 rc 也要进验证矩阵」一条）、`docs/development-notes.md` §11
   （新增一行"升级 DSH 到同线新 rc 怎么办"的完整处置步骤）、`docs/windows-acceptance.md`
   的 DSH 版本栏。

**验证**：`npm run check`（含 `version:check` / `config:check` / `skills:check` /
`skills:cli-guard` / `dws:check` / `typecheck` / 全量单测 / `build` / `smoke:built`）、
`npm run pack:assert`，以及 `npm run compat:dsh`（0.1.7-rc.2 与 0.2.0-rc.2 两条线各真装一遍）。

## package · 0.0.17 · 2026-09-29 · fix · 登录失败归因分两支 + 登录临时目录由插件指定

员工在 Windows 上点「扫码登录氚云 / 钉钉登录」持续失败。开发者诊断给出的结构化事实是
`req = res = ran = danger-full-access`、`denied=false`、`runnerFailed=false`、`started=true` ——
**DSH 没有拦这次调用**；原文却是

```
create fallback browser profile directory: mkdir C:\Users\51019\AppData\Local\crwu: Access is denied.
(system TEMP failed: mkdir C:\Users\51019\AppData\Local\Temp\crwu-scan-556823159: Access is denied.)
```

两条路径都在 `AppData\Local` 下、都被拒，而同一时刻 `dws auth status` 是 ok（`~/.dws` 可写）。
本版据此做两件事，都只动插件侧：

1. **登录的临时目录改由插件指定**（`src/host/system/auth-scratch.ts`）：先建
   `<home>/.dsh/crwu-workbench/auth-tmp`，再把 `TMPDIR`/`TMP`/`TEMP` 指过去
   （POSIX `mkdir -p … && TMPDIR=… <cmd>`；PowerShell `New-Item -Force …; $env:TMP=…; & <cmd>`）。
   依据是员工机器上的事实：系统 TEMP 与用户缓存目录都被拒，而插件状态目录（`<home>/.dsh/…`）可写。
   **不动 `LOCALAPPDATA`**（Chromium 自己的组件目录仍走系统默认）；主目录未知时原样返回命令，不伪造。
   `runCrwu` 增加可选 `scratchDir`（只有会就地起浏览器的那条命令用）。
2. **归因分两支，不许合成一句**（`LoginAdvice.policyBlocked`）：结构化事实说降级 / 拒绝 / 实际受限
   → 「被文件策略挡在工作区之外」，动作是切「完全权限」；**事实干净却照样 `Access is denied`
   → 「被这台机器拒绝（不是 DSH 的文件策略）」**，明说"切权限不会有用"，并给退路
   （氚云 `crwu h3yun session bind --token`、钉钉先试「设备码登录（无浏览器时）」）。
   上一版把两支合成一句"请切完全权限" —— 员工按提示切了，而日志证明根本不是策略问题（误导）。
3. 面板「账号连接」的前置说明同步改口径，并回到"设备码登录（**无浏览器时**）"
   （它不是"沙箱挡浏览器"的退路：同样要抢 `<HOME>/.dws` 的锁）。

**已证伪**：把两支合成策略支 → 5 条变红；把 scratch 的 env 前缀去掉（只建目录不指过去）→ 2 条变红。

### ① 登录失败归因：两支分开，不许合成一句

**症状**：员工第一次用（Windows 与 macOS 都报）时，点「扫码登录氚云」「钉钉登录」浏览器起不来；
面板给的却是 CLI 的原话 —— 氚云 `mkdir C:\…\Temp\crwu-scan-1799287186: Access is denied.`
（看着像 crwu 坏了）、钉钉 `acquiring file lock: …\.dws\.data.lock: Access is denied.`
（看着像 dws 自己的 bug）。

**根因（两条入口同一条边界）**：登录**必须写工作区之外的路径** ——

| 入口 | 必须写的东西 |
| --- | --- |
| `crwu h3yun session login` | `$TMPDIR`/`%TEMP%` 下的临时浏览器 profile（`crwu-scan-*`），再经 CDP 读会话 |
| `dws auth login`（含 `--device`） | `<HOME>/.dws/.data.lock`（拿登录态之前先抢文件锁） |
| 两者收尾 | 操作系统凭据存储（钥匙串 / Credential Manager） |

宿主按完全访问跑、操作系统的 ACL/受限令牌仍然拒绝时报的就是上面那两句；受限沙箱下浏览器即使
起来了也会在几毫秒内 renderer 崩溃（CDP 只回 `close 1006` / `Target crashed`）。

- **新增纯函数判据** `src/host/system/login-failure.ts`：`loginFailureAdvice()` / `describeLoginAdvice()`。
  顺序是「结构化事实优先，文本最后」：① `runnerFailed` → ② 提权被降级（`requested !== resolved`）
  → ③ `denied === true` 或实际跑在受限模式 → ④ **事实干净但原文点名了登录必须写的工作区外目标
  且带拒绝字样**（Windows 实测就是这一形态）。
- **第 ④ 条是 `sandboxDenialNote()` 的唯一例外**，判据本身变强了：目标不是"任意路径"，而是登录
  流程必须写的那几个已知目标。**目标词与拒绝字样必须同时命中** —— 只命中一个不归因（否则
  `secret not found in keyring` 这种"真没条目 / 钥匙串被锁"会被说成"去切完全权限"）。
- **`dwsLogin` 以前完全不做归因**（只有 `runDws` 做），现在两条登录都返回 `sandboxBlocked` + `advice`，
  并把「在输入框下方的访问模式里选「完全权限」再点一次」写进 `error`，**原始报错保留**在末尾。
- **设备码不再是"退路"**：它同样要抢 `~/.dws` 的锁，所以按钮文案改回「设备码登录（无浏览器时）」，
  归因文案里明说"在这个模式下也走不通"。
- **界面**：「账号连接」页在登录按钮下方**先说前置条件**（`envLoginSandboxHint`）；
  被归因时不再追加 stdout 尾巴（否则那句「正在打开浏览器窗口…」会把真正的动作挤掉）。

**已证伪**：把第 ④ 条整段关掉 → 7 条变红；把「目标词」那一半去掉（只认拒绝字样）→
误报用例变红。`cp` 还原后转绿。

### ② 登录的临时目录由插件指定（不再依赖系统 TEMP）

员工在 Windows 上用 0.0.15/0.0.16 再报一次，原文是**两条路径都被拒**：

```
create fallback browser profile directory: mkdir C:\Users\51019\AppData\Local\crwu: Access is denied.
(system TEMP failed: mkdir C:\Users\51019\AppData\Local\Temp\crwu-scan-556823159: Access is denied.)
```

而同一时刻开发者诊断里 `h3yun.session.login` 是
`req = res = ran = danger-full-access`、`denied=false`、`runnerFailed=false`、`started=true` ——
**DSH 没有拦它**，`%TEMP%` 与用户缓存目录却都被这台机器拒绝。两处修正：

1. **临时目录改由插件指定**（`src/host/system/auth-scratch.ts`）：登录命令先建
   `<home>/.dsh/crwu-workbench/auth-tmp`，再把 `TMPDIR`/`TMP`/`TEMP` 指过去
   （POSIX `mkdir -p … && TMPDIR=… <cmd>`；PowerShell `New-Item -Force …; $env:TMP=…; …; & <cmd>`）。
   依据是**这台机器自己的事实**：系统 TEMP 与缓存目录都被拒，而插件状态目录（`<home>/.dsh/…`）
   是它一直在写的地方。**不动 `LOCALAPPDATA`**（Chromium 自己的组件目录仍走系统默认）；
   主目录未知时**原样返回命令**，不伪造一个没建出来的目录。
   `runCrwu` 增加可选的 `scratchDir`（只有会就地起浏览器的那条命令用）。
2. **归因分两支，不许合成一句**：`LoginAdvice.policyBlocked`。
   - `true`（结构化事实：降级 / 拒绝 / 实际受限 / runner 挂）→「被文件策略挡在工作区之外」，
     动作是切「完全权限」；
   - `false`（事实干净、原文点名登录必须写的目标且带拒绝字样）→「**被这台机器拒绝**（不是 DSH 的
     文件策略）」，明确写「切权限不会有用」，并给退路：氚云用 `crwu h3yun session bind --token`、
     钉钉先试「设备码登录（无浏览器时）」。

   上一版把两支合成了一句"请切完全权限"——员工按提示切了，而日志证明根本不是策略问题（**误导**）。

**已证伪**：把两支合成策略支 → 5 条变红；把 scratch 的 env 前缀去掉（只建目录不指过去）→ 2 条变红。

## package · 0.0.16 · 2026-09-29 · fix · Windows 氚云扫码临时目录回退

- 随包 `crwu.exe` 的 `h3yun session login` 在系统 `%TEMP%` 被 Windows 安全策略拒绝时，
  自动回退到 `%LOCALAPPDATA%\crwu\scan-tmp\crwu-scan-*`；登录结束仍清理临时 profile。
- 回退只针对权限错误，且不改变 OS 凭据存储边界；若用户缓存目录也被拒绝，保留两段错误供
  Defender/企业安全软件排查。

## package · 0.0.15 · 2026-09-28

**协议 18：本机访问从「调用方声明提权」改成「具名操作 + 版本化授权收据」，
审核会话固定收敛到 `workspace-write` + `approval=never`。**

这是**跨进程契约的语义破坏**，不只是加字段：旧的 `trust` 布尔不再被接受（协议不匹配直接失败，
不会被当成"已授权"），`crwu` 直通 RPC 不再接受 `escalate` 参数，提权改由**操作身份**决定。
装上升级后需要**完整退出并重启** DSH（客户端与宿主是两个进程，只刷新页面会留下旧宿主）。

### 为什么要换形态（员工实测的三段报错）

| 员工看到的 | 真正的原因 | 旧形态为什么分辨不出 |
| --- | --- | --- |
| 写 `%USERPROFILE%\.ossutilconfig` 报 `file access denied under workspace-write mode` | DSH 沙箱拒绝 | `escalate: true` 只是一个布尔，看不出"这一步到底放行了什么" |
| 氚云报 `secret not found in keyring` | 受限沙箱读不到钥匙串，**不是**没登录 | 未授权时会先探一次凭据，把假结论当真相 |
| DWS 报 `.data.lock: Access is denied` | 沙箱写不了 / 真 NTFS ACL / 锁被占用（三种） | 三者文本一样，只能靠猜 |

三段表象不同、原因相同；而同**一句** `Access is denied` 又可能是三种完全不同的原因。
所以这一版把"提权"变成一个**具名操作的属性**，把"为什么失败"变成**结构化事实的推理**。

### A · 版本化同意 + 安全的环境引导（协议 18）

- 授权收据带 `schemaVersion` + `grantedAt` + **固定的五项能力**；旧的 `trustCredentials: true`
  一律判为 `outdated`（**永远不是**一次授权）。
- **未授权时一个凭据进程都不起、一个凭据字节都不读**（原来会先探一次，于是"未登录/密钥错误"
  这种假结论会被写进交付件）。未授权在环境自检里是**阻塞项**，不是"未登录"。
- 授权入口在环境 workflow 的「账号连接」里（不是遮住整页的模态框），并带一次明确的「暂不允许」。

### B · 本机访问代理（Local Access Broker）

- `src/host/access/{operations,diagnostics,broker}.ts`：**封闭的操作表**（27 个操作，
  每个固定 capability / 通道 / 是否提权 / 允许的来源）+ 唯一能声明 `danger-full-access` 的地方。
- `runShell` **没有** `escalate` 参数；调用方只能选一个操作名，不能提交命令、二进制路径、
  沙箱模式或提权开关。文件写入还要求"目标种类 + 绝对路径"逐字对上。
- 全量迁移：状态文件、iFinD 凭据、OSS 配置与**每一次** `ossutil`、氚云全部子命令、
  `dws` 全部白名单前缀、浏览器/剪贴板/案例目录、13 处审核 Tool 调用点。
- **归因只看结构化事实**：`requested` / `resolved` / `ran` / `denied` / `runnerFailed`。
  `ran` 也要看 —— 请求活过了 `resolve()` 却在执行时被降级是最难发现的一种。
- 迁移守卫（`host-access-migration.test.mjs`）：业务 CLI 只能在登记的执行器里拼命令、
  且必须经 Broker；这条守卫在开发中真的抓到两处自己拼 `dws` 命令的调用点。

### C · 审核会话收敛

- 审核根与审核子会话**永远** `workspace-write` + `approval=never`：用 DSH 自己的
  `setSandboxMode` / `setApprovalPolicy` 写入，再**回读**，并按 DSH 的委派捕获口径确认
  "子代理将要继承到什么"。**不依赖部署默认**（默认可能是 `danger-full-access`）。
- 带 `auto` / `danger-full-access` preset 的根**不可复用**；创建子代理前还有一道环境就绪门禁；
  子会话发布后按它自己的 scope 复查策略与工具可见性，不对就**停掉它**。
- 登录类操作（`h3yun.session.login` / `dws.auth.login`）的 `allowedSources` **只有面板**：
  审核链路连登录这个动作都拿不到。提示词里明令"未登录就停下、要员工回工作台"。

### D · 桌面归因与修复指引

- `src/host/access/classify.ts`：九档优先级的**纯函数**分类器，把三段表象分开成
  `os-credential-store` / `file-lock` / `os-filesystem-permission` / `sandbox-denied` /
  `sandbox-downgraded` / `infrastructure` / `cli`。
  `sandbox-exec: sandbox_apply: Operation not permitted` **永远**是基础设施故障，
  不会被翻译成"命令缺失 / 没登录 / 凭据无效"；锁必须有**正向探测**才定性。
- 新 Host 操作 `dws-local-doctor`（只读、零参数、目录由 `<home>/.dws` 推导）与
  `dws-local-permission-repair`（**只给面板**、必须 `{ confirm: true }`、要求体检**正向确诊**
  "本机文件权限问题"）。修复只动 `.dws`（700）与 `.data.lock`（600）：不 `chown` / `takeown` /
  `sudo`、不删锁、不碰父目录、拒符号链接，修完**重新体检**。
- 界面：修复按钮**只在确诊本机文件权限问题时渲染**，并且要**二次确认**（改权限 ≠ 允许读本机凭据）。
  沙箱拒绝 / 降级 / 钥匙串 / 认证失败 / 所有者不对 / 文件锁都不渲染。
- `@deepseek-ai/dsh-sandbox-policy` 与 `@deepseek-ai/dsh-user-approval` 加入 peer + dev
  （与其余 7 个 peer 同口径；宿主产物会 `import` 它们，接收方由 DSH 运行时提供）。

### 操作清单：33 → 38

新增 `local-access-grant` / `local-access-revoke`（A）、`access-diagnostics`（B，只读）、
`dws-local-doctor` / `dws-local-permission-repair`（D）。`crwu` 直通入口的 `escalate` 参数已删除。
冻结清单在 `tests/helpers/frozen-inventory.mjs`，漏登记会直接红。

### 复查期间加固（2026-09-29，用户复查逐条点出后修）

下面这些**都在本版里**（0.0.15 未发布，所以按最终形态记），每一条都能被具名用例证伪：

- **授权/撤销的状态迁移只由 `host/access/consent.ts` 负责**：调用方不得把返回的收据写回活状态 ——
  写盘失败时那份视图可能来自**磁盘上的旧授权**，照抄等于一次失败的「重新允许」把权限重新打开。
- **案例目录必须落在选定工作空间的信任域内**：此前这条要求只写在注释里。`caseDir` 是模型参数，
  只校验"绝对 + 存在 + 是目录 + 没有 `..`"等于没校验 —— `crwu_audit_oss_publish` 会把**任意可读文件**
  传到 OSS（读不受沙箱限制），`crwu_h3yun_record_get` / `files_list` 更把它**原样当特权命令的 cwd**。
  现在 `allowedRoot` 是**必填参数**（编译器保证没有调用点能漏传），运行时漏传 fail closed。
- **信任域未知一律拒绝，不许"跳过检查继续做"**：`openPath` 曾经是后者，那天唯一挡住它的是
  "提权必须有 workdir"与案例根兜底**恰好相等**；判据现在落在任何 fs 探测之前。
- **锁归因要两个条件**（原始失败与锁有关 **且** 正向探测证明有人持有）；Windows 的锁探测必须沿
  `InnerException` 解包到根异常再读 HResult（旧写法让"真有进程持锁"也落 `Unknown`，W-05 在代码上不可达）。
- **目录与 `.data.lock` 分别探权限**：只探目录会让"目录正常、锁文件不可写"退化成 `cli`、修复入口永不出现；
  修复只动被证明有问题的对象，回读也只核对修过的那些。
- **Windows ACL 算有效权限**：`Modify = 197055` / `FullControl = 2032127`（夹具曾把后者标成 Modify）；
  判据是"所需**写**权限"是否被完整覆盖，**部分 Deny**（`(W)`、Delete）同样算不可写 —— 旧实现整个忽略。
- **脱敏声明要有端到端证据**：取数摘要的净化此前只在失败路径被喂过 token，成功路径只试过 `{"v":1}`；
  现在按"零件级 + 接线级"两条分别取证（对象路径的密钥字段整条丢 ≠ 文本的值级净化）。
- **卸载路径此前从未被执行过**：`smoke:built` 现在调用每个 `ctx.effect` 的 disposer，断言同源路由被摘、
  工具被逐个注销（忘 `return` disposer 是 Cordis 的经典坑，本地以前完全看不见）。

### 复查第二轮：**审核 scope 绑定**（协议 19）

第一轮修的是"案例目录必须在工作空间之下"。用户第二轮复查指出：这**不够** ——
一个工作空间里通常有很多案例目录，于是 S1 的子会话可以传 `<工作空间>/S2`、
或传工作空间根再读 `S2/文件`（把别的案例读出来传上 OSS、或往别的案例里写）；
氚云的 `objectId` / `fileId` 也是模型提交的，Host 没有把任何东西绑到**本轮**审核上。

- **Host 权威 scope 落盘**：创建记录时写死 `casePath`（= `<工作空间>/<流水号>`）、`attemptId`
  与 `allowedAttachmentIds`（来自**可信输入快照**），跨重启保留。认领来的旧记录 scope 不完整 →
  案例内 Tool 一律拒绝（不拿工作空间兜底）。
- **统一门禁 `requireAuditScope`**：按 `exec.agent.id → childId → 记录` 找本轮 scope，
  `caseDir` 必须与 `casePath` **规范解析后精确相等**（工作空间根、兄弟案例、案例目录的子目录一律拒绝；
  Windows 盘符/UNC 按风格大小写不敏感，POSIX 大小写敏感），`seqNo` / `objectId` 必须一致，
  无身份 / 未知 childId / 已结束 / scope 不完整一律 fail closed。通过时**返回 Host 的路径**，
  调用方不再使用模型给的字符串。
- **氚云边界收紧**：`crwu_h3yun_record_get` / `files_list` 移出审核子会话的必需集
  （注册面与审核能力集拆成 `CRWU_BUSINESS_TOOLS` / `REQUIRED_AUDIT_TOOLS`），
  审核子会话调用它们直接拒绝且**零进程**；`crwu_h3yun_file_get` 只接受快照里登记的 `fileId`，
  表外 id 在起进程之前拒绝。`case_bootstrap` 也要求 `caseDir` 精确等于 Host 约定算出的那一个。
- **真正的写边界是案例目录**：审核根的 `cwd` 与 `workspace-write.workspaceRoot` **都**改成
  本轮案例目录（回读核对），一条根只服务一个案例，工作空间级旧根（`casePath` 为空）判**过期**不复用；
  占用门禁提前到"建目录 / 建根"之前，所以被拒的发起**零副作用**（不建空目录、不起根会话）。
  于是通用 shell / fs 也只能写自己的案例目录 —— 这一条与设计文档"只能写自己的案例目录"终于一致。
- **协议 18 → 19**：这是跨进程权限语义变化，旧宿主仍按工作空间级边界跑审核，
  必须靠协议号把"界面新、宿主旧"拦下来（客户端会要求完整重启）。
### F 段：可观察的停止状态机 + 当前审核会话入口（2026-09-29）

- **两阶段停止协议**：`audit-stop` 立刻把阶段写成 `requested` 并落盘后返回"已接受"，
  abort → dispose → 静默复查在后台继续，阶段逐段落盘；`audit-status` 每条记录带
  `stop`（`phase` / `requestedAt` / `elapsedMs` / `quiesced` / `aborted` / `disposed` /
  `error` / `notes` / `canStartNext`），并加一个顶层 `canStartNext`。
  重复点停止**幂等**（`alreadyStopping`，不启动第二条流程、不重复 abort）。
- **阶段枚举**：`idle` / `requested` / `aborting` / `waiting-quiescence` / `quiesced` / `timeout` / `failed`。
  `canStartNext` **只由 Host 判定**：没确认静默（timeout / failed / 进行中）一律 false，
  且**不依赖占用锁在不在**（重启后锁可能没恢复，"没确认停下"仍然成立）。客户端缺字段按未知处理。
- **启动门禁**：停止流程在跑、或上一条留下 timeout / failed 时，`audit-start` 直接拒绝；
  界面同时把行上的「AI 审核 / 重新审核」置灰（与 Host 的 `canStartNext` 取交）。
- **界面（F2/F3）**：顶部「当前审核」摘要卡（流水号 / 项目 / 状态 / attempt / 开始时间 /
  childId 脱敏尾部 / 停止阶段 / 观察），**在表格之外**，所以当前审核不在当前分页或筛选结果里时
  依然可见；阶段文案用 `aria-live="polite"` 播报、等待期间显示"已等待 N 秒 · 最多等待约 8 秒"、
  停止按钮禁用；timeout 给「继续等待 / 再次停止 / 复制诊断」，failed 给「打开当前会话 / 复制诊断」
  并显示真实错误与"当前审核仍被保留，未释放占用"。
- **「打开审核会话」**：用**被点那一行**的 `childId` / `parentSessionId`（`openSessionTarget` 是唯一解析点），
  `childId` 为空时按钮显示「会话正在建立」并禁用；它与「AI 审核结果分析（`audit_analysis`）」
  是两个入口、两个目标会话（文案与目标都有断言）。
- **客户端停止口径是纯函数**（`features/report-audit/stop-view.ts`）：阶段文案 / 语气 / 可用动作 /
  `canStartNext` 都能被单测穷举（7 条），组件只负责渲染。
- **协议号仍是 19**：新增的 `stop` / `canStartNext` 都是**可选**字段 —— 旧客户端忽略它们照常工作，
  新客户端在旧宿主上把它们当"未知"（不显示"已停止"、也不放行下一条）。没有破坏性契约变化。

### 第三轮复查：4 个 P1 + 2 个 P2（全部已修，逐条有用例与缺陷注入）

- **子会话必需集与 deny 集重叠（P1）**：`crwu_audit_case_bootstrap` 既是"根必需"又是"子会话 deny"，
  而子会话复查用的是根必需集 —— 真实 `toolFilter` 生效后**每条正常子会话都会被判成缺工具并停掉**。
  现在拆成 `REQUIRED_AUDIT_TOOLS`（根必需）与 `REQUIRED_AUDIT_CHILD_TOOLS`（子会话必需 = 根必需 − deny），
  并有一条门禁断言两个集合**不相交**；子会话复查专用后者。
- **pending scope 按父会话认领会允许 sibling 冒领（P1）**：父会话 id 只能证明"属于同一个 root"，
  证明不了"就是本次 `start()` 创建的那一个"。one-shot `start()` 没有预留 child id 的参数、
  拿不到不可伪造的 launch token，所以窗口内**案例内 Tool 一律 fail closed**（
  `auditScopeFor` 只认与记录逐字相等的 childId）；父会话判据只保留在**拒绝方向**（`isAuditChild`）。
- **失败分支忽略 `quiesced`（P1）**：子会话可见性/策略复查失败、最终落盘失败这三条路径此前直接
  回滚记录与句柄；dispose 超时且 Agent 仍 running 时，会形成"旧子会话继续写案例目录、Host 已抹掉身份"。
  现在检查 `quiesced`：没确认静默就写成**退役记录**（`retired: true`，只拒绝不放行）、
  **保留** run 句柄与占用，并提示去工作台重试停止。
- **读不到 child Agent 仍继续审核（P1）**：`SubagentRun.localAgent` 对远程 provider 是 `undefined`，
  而边界复查全靠它。现在保留并优先使用 `localAgent`，**读不到就停掉并失败**（不再只记 warning）；
  `pickProvider` 也**不再回退到"第一个注册的"**，只接受本地可验证的 provider（`spawn` / `fork`）。
- **orphan pending 跨重启可冒领（P2）**：创建失败且回滚写盘也失败时，磁盘会留下 `pending: true` 的记录。
  恢复时把它**退役**（不发放 scope），并且**不恢复指向空 childId 的占用锁**。
- **`auditStop` 返回写死的停止结果（P2）**：现在透传真实的 `StopOutcome`
  （`aborted` / `disposed` / `quiesced` / `interrupted` / `agentCancelled` / `notes`）。

### 第二轮复查：5 个 P1 + 2 个 P2（全部已修，逐条有用例与缺陷注入）

- **子会话策略复查用了错的边界**（P1）：协议 19 已把子会话的边界/cwd 收紧到案例目录，
  但复查仍拿整个工作空间当期望值 —— **正常可见的子会话会被稳定判错并停掉**。
  现在传 `caseDir`，并新增"真实可见 child + 正确案例目录能正常启动"的**正向**用例
  （旧夹具的 `agents.get()` 只返回根 Agent，整段复查被跳过，所以这条一直没被抓到）。
- **发布后的子会话没有被真正限制工具**（P1）：`record_get` / `files_list` / `case_bootstrap`
  仍可见可执行 —— "必需集名单"只是预检名单，不是边界。现在按 provider 的
  `capabilities.toolFilter` 显式传 `toolFilter.deny`（DSH 在子会话创建窗口里做 scoped
  `tools.restrict()`：**既不进 prompt、也拒绝执行**），**不支持过滤的 provider 在创建子会话之前拒绝**。
- **子会话发布早于 scope 建立**（P1）：`subagents.start()` 返回前子会话已在跑，那段窗口里
  身份拒绝失效、案例内 Tool 随机失败。现在**两阶段握手**：创建子会话**之前**先落一条
  pending 记录（父会话 = 审核根），窗口内按父会话认领本轮 scope；`start()` 返回后写真正 childId；
  创建失败 / 子会话复查失败一律回滚 pending。
  窗口内的"父会话"有**两条来源**：会话头的 `meta.parentSession`，读不到就问 `subagents.listChildren`
  （会话存储驱动，Host 权威）"审核根的孩子里有没有这个调用者" —— 两条都拿不到才 fail closed。
  这样一来该判据不再依赖另一个组件是否写了元数据。
- **dispose 超时被当成停止成功**（P1）：计时器是**正常 resolve** 的，旧实现在超时时
  `disposed=false` 但 `errors=[]`，上层据此继续重启。现在区分"谁赢了"，并以**静默判据**
  `quiesced`（dispose 完成 **或** Agent 已不在 running；问不到状态 = fail closed）为准：
  没确认停下来就**不覆盖旧记录、不启动下一条**，句柄与占用一并保留。等待也改成**有界**
  （没有 timer 服务时退化成全局定时器，绝不无界 await）。
- **返回记录的身份没有核对**（P1）：`records get --id B` 取回一条记录 ≠ 取回的是 B。
  现在**在请求附件与任何写盘之前**核对返回记录的 `ObjectId` / `SeqNo`：缺字段或与请求不一致
  一律 fail closed（不再用调用方提交的值兜底）。
- **把不透明的 `targetKey` 当路径解析**（P2）：`FsTarget.targetKey` 是 `Branded<'FsTargetKey'>`，
  合同只允许等值比较；旧实现做分隔符/大小写归一化，形似 Windows 路径但区分大小写的后端会被错误放行。
  现在只做 `===`（`displayPath` 不再当身份用）；我们自己产生的路径字符串另有 `samePathText`。
- **审核记录持久化失败仍返回成功**（P2）：启动/停止/释放三条路径都处理 `persistAudits=false` ——
  启动失败会停掉刚起的子会话并回滚内存锁；停止/释放如实返回失败（内存放开了，但磁盘上可能还留着）。

（实现方在交付前自己找的，均已用缺陷注入证伪）：
  ① `record_get` / `files_list` 的拒绝条件一度写成"这轮 scope 是否可用" —— 一轮审核
  `ended: true` 之后 scope 变为不可用，那个还活着的子会话就能以"没有可用 scope"为由绕过拒绝、
  去读**任意** `objectId`；判据已改成**调用者身份**（`isAuditChild`，不要求 scope 可用）。
  ② `crwu_audit_case_bootstrap` 的 `caseDir` 虽被钉在本轮案例目录，但 `objectId` 仍是提交进来的 ——
  子会话可以用**别的** objectId 把别人的记录取进自己的案例目录；现在审核子会话调用它一律拒绝。

### 测试

新增/扩写的测试文件：`host-access-consent` / `host-access-broker` / `host-access-classify` /
`host-access-migration` / `host-access-rpc-gate` / `host-audit-policy` / `host-dws-local` /
`client-dws-local` / `host-case-dir-gate` / `host-design-traceability`（**共 1242 条**，
本机 `1242 / 1238 pass / 1 skip`；两条 posix 子用例只在"用 DSH 自带二进制当 `node`"时红，
机制见 `docs/review-0.0.15.md` §5）。

每一条新断言都用**缺陷注入**证伪过（注入 → 变红 → `cp` 还原 → 转绿）；
开发与复查过程中被抓到的真实缺陷包括：OSS 未授权仍然报「还没有填写 AccessKey」、
环境自检与身份查询自己拼 `dws` 命令绕开白名单、审核根的诊断被体检自己挤掉、
"没确认"的修复调用照样跑了一串探测、撤销写盘失败反而把权限重新打开、
案例目录可以指到工作空间之外、Windows 锁探测读错异常层。

## package · 0.0.14 · 2026-09-28

**兼容 DSH `0.2.0-rc.1`：peer 区间从「一条线」改成「两条线并列」。**
0.0.13 及更早的版本在 DSH `0.2.0-rc.1` 上会被整体判为不兼容 —— 插件管理器的原文是
「`dsh-crwu-workbench@0.0.13` 与 DSH `0.2.0-rc.1` 不兼容（要求 `@deepseek-ai/dsh-tools@^0.1.7-rc.2`…），
运行它可能导致崩溃或数据丢失。请安装与当前 DSH 兼容的插件版本。」，装上了也会被禁用。

- **根因**：`^0.1.7-rc.2` 的语义是 `>=0.1.7-rc.2 <0.2.0-0`，**不含** `0.2.0-rc.1`。DSH 从 0.1.7 起把
  peer 当**硬门禁**：加载 profile 的 bundle 层时拿 `getDshRuntimeVersion()` 与每个
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的**区间**比对（预发布参与匹配），不匹配的整行被跳过；
  插件管理器在安装前还会拿候选包自己的 `peerDependencies` 先判一次。
- **peer 改成 `^0.1.7-rc.2 || ^0.2.0-rc.1`**（7 个 `@deepseek-ai/dsh-*` 与 `engines.dsh` 一致）。
  **一条线一个 `^` 区间并列，不用 `>=0.1.7-rc.2 <0.3.0`** —— 后者会顺带放行还没验证过的 0.3 线。
- **加线之前逐包比对过 API**，比对结论（`npm pack` 两条线的全部 `@deepseek-ai/dsh-*` 后逐文件 diff）：
  7 个 peer 里 `dsh-tools` / `dsh-plugin-manager` / `dsh-host-webserver` / `dsh-client-ui-renderer` /
  `dsh-skill-filesystem` **字节相同**；`dsh-client-ui-sidebar` 只多了 1 行埋点调用与 1 行文档注释；
  `dsh-client-ui-layout` 只多了一段 Windows 标题栏的 CSS 变量。插件用到的类型与运行时契约没有变化，
  0.1.7-rc.2 上的一切行为不变。
- **`devDependencies` 补全为全部 7 个 peer**（原先只有 4 个）：npm 的 peer 自动安装会为「只有 peer、
  树里没有具体实例」的包去解析**最新**匹配版本，于是 `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.1`
  的精确 peer（`@deepseek-ai/dsh-fs@0.2.0-rc.1`）会和开发树里的 `0.1.7-rc.2` 撞成 `ERESOLVE`。
  列出实例即把开发树钉在我们开发所对的那条线上。**接收方不受影响**：profile 的 pnpm 配了
  `autoInstallPeers: false`，`@deepseek-ai/dsh-*` 从来不由包管理器安装（DSH 运行时自己提供）。
- **新的回归测试**（`host-package.test.mjs`）：按 DSH 自己的判据
  （`semver.satisfies(runtime, range, { includePrerelease: true })`）断言 7 个 peer 覆盖
  `0.1.7-rc.2` / `0.1.7` / `0.2.0-rc.1`，并反向断言**没有**顺带放行 `0.3.0-rc.1`，同时要求
  `engines.dsh` 与 peer 口径一致。这条测试在旧区间上会直接红（已用注入缺陷证伪）。

## package · 0.0.13 · 2026-09-28

**修复 Windows 上的平台方言：命令串按 PowerShell 拼，不再按 `cmd.exe` 拼。**
0.0.12 及更早的版本在 Windows 上，环境页的「氚云员工会话」「钉钉认证」两行会一起报
`表达式或语句中包含意外的标记"h3yun"`（PowerShell `ParserError` / `FullyQualifiedErrorId:
UnexpectedToken`），相关按钮点下去也不会有结果；macOS 上完全正常。

- **根因**：DSH 在 Windows 挂的执行器是 `@deepseek-ai/dsh-pwsh-local` —— 整条命令作为**一个
  argv 元素**交给 `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`，由 PowerShell 自己
  解析。插件此前按 `cmd.exe` 的规矩拼命令，于是在 PowerShell 里「引号包住可执行文件」是
  **字符串表达式**、不是命令调用，紧随其后的第一个参数就成了意外标记。
- **命令位置改用 PowerShell 的调用运算符 `&`**：新增 `shellInvoke(exe, args, platform)`，
  由它在 Windows 上拼 `& 'C:\…\crwu.exe' 'h3yun' 'session'`。所有「第一条 token 是可执行文件」
  的调用点（`crwu` / `dws` / DSH 自带 Python / `ossutil` / 清单里的探测模板）全部改走它；
  POSIX 上仍是原样的 `bash -c` 命令串（那里 `&` 是后台作业，绝不能加）。
- **参数引用改用 PowerShell 单引号字面量**：Windows 上 `shellQuote` 不再用 cmd 式的双引号
  （在 PowerShell 里会插值 `$` 与反引号），改为单引号 + 内部单引号翻倍。
- **清掉同一类「POSIX-only」写法**：Windows 上不再执行 `chmod`（Windows 没有这个命令，
  凭据文件由用户 ACL 保护，这一项在 Windows 上不适用、如实标注而不是伪造失败）；
  建目录用幂等的 `New-Item -ItemType Directory -Force`；删文件用
  `Remove-Item -LiteralPath … -Force -ErrorAction SilentlyContinue`
  （`rm -f` 的 `-f` 在 `Remove-Item` 上同时前缀匹配 `-Force` 与 `-Filter`，会直接报「参数名不明确」）。
- **平台方言跟着 `platform` 键走，不读 `process.platform`**：否则在 Windows CI 上跑
  stubbed `darwin-arm64` 的用例也会被补上 `&`。
- **回归测试**：`host-environment-probe.test.mjs`（引用与命令位置）、`host-shell-fs.test.mjs`
  （一条静态守卫，钉死「模板以 `${shellQuote(` 开头」与「`argv.map(…shellQuote…).join(' ')`」
  这两种会复发的写法）、`host-crwu-h3yun.test.mjs`（按员工报的原文断言 Windows 命令形状）。

### Windows 全面适配（同一版本的第二批，2026-09-28）

0.0.13 只修好了「最直接的那一类」PowerShell 调用（命令位置与参数引用）。这一批把剩下的四个
风险层一起收掉：安装兼容、命令方言不统一、本地路径按 POSIX 规则处理、CI 与发布门禁没有真的
模拟 DSH 的 Windows 语义。**一个版本的完整说明必须能回答「Windows 上到底能不能用」**，
所以下面按风险层分组。

#### 安装兼容

- `22b31b9` 的 peer 双线区间之外，新增 `scripts/check-dsh-compat.mjs`（`npm run compat:dsh`）：
  在干净临时工程里**真的**装齐 DSH `0.1.7-rc.2` 与 `0.2.0-rc.1` 的完整 peer 集（依赖表由
  peer + dependencies + devDependencies + `src/` 里真实 import 的 `@deepseek-ai/*` 共同生成，
  逐个钉版本），把 `npm pack` 出的 tarball 装进去，再调用 DSH 自己的
  `evaluatePluginCompatibility()` 断言**不会被 skip / disable**，并用**该版本**的 DSH 类型跑
  一次 `tsc --noEmit`。显式关掉 `legacy-peer-deps`，并反向断言 `0.3.0-rc.1` 会被判不兼容。
- 补上漏声明的 `@deepseek-ai/dsh-util-values`（`src/` 里 5 处 `import type { JsonValue }`，
  此前只能靠传递依赖拿类型）。

#### 命令方言（Shell）

- 新增 `src/host/platform/shell.ts`：**唯一**的方言适配器 —— `shellDialect` / `shellQuote` /
  `shellInvoke` / `mkdirCommand` / `removeFileCommand` / `openExternalCommand` /
  `clipboardCommand` / `homeProbeCommand` / `privateFileCommand` / `privateFileMechanism`。
  NUL 明确拒绝，换行等控制字符由单引号安全表示；平台一律由调用方注入。
- 迁移全部调用点：`tools/case-files.ts`、`system/ops.ts`、`oss/ops.ts`、`ifind/store.ts`、
  `platform/home.ts`、`audit/root.ts`、`environment/probe.ts`，以及 `dws`/`crwu`/`oss`/Python/
  身份查询的执行入口。**删除** `environment/manifest.ts` 的 `quoteArg` 与 `ifind/store.ts` 的
  本地 `shellQuote`（第二、第三个引用实现就是绕过 Windows 的后门）。
- 不再出现 `cmd /c …`、`Start-Process` 与建目录/删除/权限命令的手工拼接（有静态门禁）。
  Windows 打开文件改用 `Start-Process -FilePath`；删除改用
  `if (Test-Path -LiteralPath …) { Remove-Item … -ErrorAction Stop }` —— **不再用
  `SilentlyContinue` 把真实失败吞成成功**。
- `tools/case-files.ts` 不再吞错：只把「目标已经是我们要的状态」视为成功，并用 `ctx.fs.stat`
  **回读后置条件**（命令返回 0 不等于目录真的在 / 文件真的没了）。
- `oss.probeCommand` 模板降级为 deprecated 兼容路径：结构化 `executable/args` 是默认形状，
  模板的每个占位符**逐个按平台引用**，未知占位符 / 换行 / 空可执行文件一律拒绝。
- `platform/home.ts` 按平台只跑一条探测：Windows 只问 PowerShell 的 `$env:USERPROFILE`，
  不再先试 `python3` / `printf`（那两条在 Windows 上只是两次 command-not-found）。

#### 本地路径

- 新增 `src/shared/utils/local-path.ts`（不引用 Node 模块，Client 也能用）：
  `isWindowsStylePath` / `isAbsoluteLocalPath` / `trimTrailingSeparators` / `localSeparator` /
  `joinLocalPath` / `basenameLocalPath`，另有仅供展示层前缀匹配的 `isLocalPathUnder`
  （**明确标注不是安全边界**）。`joinLocalPath` 对绝对片段与 `..` 片段**抛错而不是静默清洗**。
- `shared/utils/case-dir.ts` 的 `caseDirOf` 改走它（Windows 上给出 `C:\Work\<流水号>`），
  新增 `caseDirName`；`host/audit/case.ts` 的 `caseNameOf` 改走 `basenameLocalPath`
  （旧实现 `split('/')` 在 Windows 上把整条路径当目录名）。
- `host/report/files.ts` 的拼接走 `joinLocalPath`，工作空间**包含判断从字符串前缀改为
  `ctx.fs.contains`**；`host/workspace/resolve.ts` 的最长前缀匹配改 `isLocalPathUnder`。
- **本地路径与 OSS object key 分开命名**：`host/oss/ops.ts` 里 `localPath` 随平台、
  `objectKey` 永远 `/`。
- **UNC 策略**：不自行判死 —— 交给底层 `fs` 解析（DSH 在 Windows 上原生支持 `\\server\share`），
  解析不了时回稳定的「案例目录不可解析：…（原因）」，**不生成损坏路径**。

#### audit 预检与凭据权限

- 审核根预检的提示词不再写死「用 bash 执行 `pwd`」（Windows 上 DSH 挂的是 PowerShell，
  宿主自检全绿而 Agent 预检必然失败）：改为按平台生成（Windows `Get-Location`、POSIX `pwd`），
  并把平台事实逐层传到 `probeMessage` / `preflight`。
- 技能正文与公共层里的 ```bash 代码块改为 ```text；`crwu-audit` 增加 §1.1「命令块按当前平台
  shell 执行」。vendored `skills/dws/**` 不动（上游正文，由 `dws:check` 按 provenance 守）。
- **凭据权限结论结构化**（协议 16 → 17）：`chmodOk: boolean` / `chmodError: string` 换成
  `permission: CredentialPermission`（`status: verified|inherited|failed` + `mechanism` +
  `message`）。Windows 上没有 POSIX 权限位、也没有 `chmod`，跳过之后旧字段只能报 `true`，
  字段名读起来是「chmod 成功了」—— 现在如实报 `inherited / windows-acl`
  （「使用当前 Windows 账户 ACL；POSIX 0600 不适用」）。**本轮不调用 `icacls`**。

#### 构建与发布门禁

- `scripts/prepare.mjs` 不再 `spawnSync('tsdown', { shell: process.platform === 'win32' })`：
  新增 `scripts/lib/cli-entry.mjs`（解析包的 JS 入口，命中 `.cmd`/`.ps1` shim 时明确报错、
  **不退回 shell**），用 `process.execPath` 直接执行。**过 shell 会让项目路径里的空格与单引号
  被第二套规则改写** —— 这是安装链路的第一跳。`scripts/lib/cli-entry.mjs` 随包发布
  （`files` + `pack:assert` 的 REQUIRED 都钉住了）。
- `tests/windows/powershell-contract.test.mjs`：把适配器生成的命令真的交给 shell 执行
  （与 DSH 同形：整串命令作为**一个** argv 元素给 `pwsh -Command`），覆盖命令位置（可执行文件
  路径含空格/引号/`$`/方括号/中文）、参数原样往返（含 `;` 与 `$(…)` 注入金丝雀）、
  mkdir/remove 幂等与后置条件、**真实失败必须非零退出**。POSIX 侧本机跑，Windows 侧在 CI 跑。
- `scripts/smoke-windows-binaries.mjs`（`npm run bin:smoke`）：在 Windows runner 上把
  `crwu.exe` / `ossutil.exe` / `dws.exe` 真的启动一次（核对 manifest 与 SHA-256、
  断言发布树无运行残留、对未声明平台明确失败）。
- CI：新增 `windows-powershell` job（**不设 job 级 `shell: bash`**，runner 默认 pwsh，
  先断言 PowerShell 7，再跑静态门禁 + 原生合同 + build + smoke + 全量 `npm test`）；
  plugin 矩阵的 Node 22 上跑 `npm run compat:dsh`；`release.yml` 新增
  `windows-binary-smoke`，`publish` 改为 `needs: [binaries, windows-binary-smoke]`。

#### 已知限制

- **`win32-arm64` 明确不支持**：随包二进制只有 `darwin-arm64` 与 `win32-x64`。arm64 Windows 上
  插件如实回 capability gap，**不会**静默用 x64 顶上（有单测钉住文案与「不发任何命令」）。
- **UNC 未在真实共享上做过端到端验收**：策略是「交给底层 fs 解析，失败给可读错误」，
  真实 `\\server\share` 的读写仍未在 CI 或真机覆盖。
- **没有 `icacls` 收紧 ACL**：Windows 上凭据文件的权限继承自当前账户 ACL，插件不擅自重写
  （企业域策略下这不该由插件决定）。真要「收紧 ACL」需要另做设计与域环境测试。
- **干净 Windows 用户配置的端到端验收（装插件 → 选工作空间 → 建案例 → 跑审核 → 回传）
  尚未执行**：本机是 macOS，可机器验证的部分已交给上面的三个 Windows job；
  人工验收按 `docs/windows-acceptance.md` 的清单逐项记录。

#### 复查修复（同一版本的第三批，2026-09-28）

分支合并前的一次定向复查发现了三个阻塞项与三个中等问题，全部已修，并各自配了会变红的用例。

- **[P1] 发布工作流会稳定失败**：`release.yml` 里「未声明平台必须报错」那一步**故意**让
  `node` 返回非零，但 GitHub 的 pwsh 壳在脚本末尾用 `$LASTEXITCODE` 作为步骤退出码，
  `Write-Host` 不会把它重置成 0 —— 于是这一步真的判红，依赖它的 `publish` 永远起不来。
  现在写成「存退出码 → 断言 → 末尾显式 `exit 0`」；`windows-powershell` job 里那条
  `npm test` 也改成同样的形状。新增 `tests/unit/host-ci-workflows.test.mjs`：用 `yaml` 解析两个
  工作流，**任何引用 `$LASTEXITCODE` 的 `run` 块都必须以显式 `exit` 收尾**，并钉住
  「原生 pwsh job 不得设 job 级 shell / 必须先断言 PowerShell 7 / publish 必须 needs Windows 冒烟」。
- **[P1] 裸盘符被当成绝对路径**：`isAbsoluteLocalPath` 复用了「Windows 风格」的判断，
  而风格判断为了兼容 `C:` 这种写法接受了裸盘符 —— 于是 `requireCaseDir('C:')` 会放行一条
  「盘符相对路径」，案例目录随进程 cwd 漂移。现在风格（`DRIVE_STYLE`）与绝对（`DRIVE_ROOTED`）
  是两条正则，并新增 `tests/unit/host-case-dir-gate.test.mjs` 覆盖门禁全部分支
  （裸盘符 / 相对路径 / `..` / UNC 策略 / `fs.contains` 而非字符串前缀）。
- **[P1] 本地路径迁移不完整**：`bootstrap.ts`（输入快照目录与三个快照文件）、`knowledge.ts`
  （knowledge 目录 / 下载目标 / manifest）、`dingtalk.ts`（通知幂等状态文件）、
  `audit/state.ts`（案例目录候选）、`WorkbenchPanel.tsx`（打开本地 HTML）、
  `workspace-view.ts`（界面上的落盘位置说明）仍在用 `/` 拼 Windows 本地路径 ——
  其中快照、知识库与本地报告打开都属于核心审核链路。全部改走 `joinLocalPath`/
  `localSeparator`；新增 Windows 行为测试（bootstrap 的三条快照路径与真实落盘目标、
  knowledge 目录、`assessAudit` 的案例目录候选、`artifactHint`），
  并在 `host-platform-shell.test.mjs` 加一条**本地路径载体名单**的静态门禁
  （名单短、每条写得出理由；对象键与 URL 不在名单里）。
- **[P2] `fs.stat` 异常被当成「文件不存在」**：`case-files.ts` 把 `resolve/stat` 的所有异常
  都折叠成「没什么可删的」，删除后的回读也一样 —— 于是 `Access denied` 会被回报成删除成功。
  现在探测是**三态**（存在 / 不存在 / 查不出来），「查不出来」一律按基础设施失败上报；
  `ensureDirectory` 在确认不了目标状态时也不许报成功。
- **[P2] `verified` 没有真正回读**：协议与注释都把 `verified` 定义为「执行并回读确认」，
  而实现只看了 `chmod` 的退出码 —— 有些文件系统会静默忽略 chmod。现在收紧之后**必须回读模式位**：
  新增 `readFileModeCommand()`（GNU `stat -c %a` / BSD `stat -f %Lp` / Windows 不适用，
  分歧只在适配器里出现一次）与 `parseFileMode()`；回读失败、模式对不上都算 `failed` 并带原因。
- **[P2] Windows 的 OSS 输入错误仍报 POSIX 机制**：`ossCredSave` 的输入校验失败信封硬编码了
  `mechanism: 'posix-0600'`，在 `win32-x64` 上说错了「谁在负责权限」。改为复用
  `failedPermission(error, deps.platform)`。
- 文档：`docs/windows-acceptance.md` 的收尾步骤在 PowerShell 里错用了 `rm -rf`，
  改为 `Remove-Item -LiteralPath … -Recurse -Force`。

#### 工作区外路径与沙箱归因（同一版本的第四批，2026-09-28 员工 Windows 实测）

员工在 Windows 上报了三段看起来无关的错误，实际是同一个原因：**受限沙箱（`workspace-write`）
不允许碰工作区之外的路径**（`%USERPROFILE%` 下的 `.ossutilconfig`、`.dws\`、操作系统凭据存储）。
当时插件有两处该提权却没提权，还有一处把沙箱下的假结论当成了真结论。

- **修①｜写 `~/.ossutilconfig` 被沙箱拒绝**：`oss/ops.ts` 的 `fs.writeText` 没声明
  `sandboxPolicy`（同仓的 `ifind/store.ts`、`state/persist.ts` 都声明了），员工实测原文
  `cannot write "C:\Users\<用户>\.ossutilconfig": file access denied under workspace-write mode`。
  现在与那两处同一形态。
- **修②｜`crwu h3yun session status` 拿不到真结论**：提权白名单只放行了 `session login`，
  而 `status` / `bind` 才是**读**钥匙串的那两条。受限沙箱下读不到，crwu 如实回
  `secret not found in keyring` —— 面板照着显示成「未登录」，把人指去重新扫码。
  现在 `h3yun session` 整段放行（凭据存储的读与写都要在沙箱外）。
- **修③｜未授权时不再去问氚云**：环境探测原来无条件跑一次 `h3yun session status`，
  既是假结论、又永远拿不到真值。现在与钉钉那条同一条纪律：未授权就报「需要授权」并进阻塞项，
  **一条凭据命令都不发**；授权后才带 `sandboxPolicy` 去拿真结论。
- **新增归因**：`shell/run.ts` 的 `sandboxDenialNote()` 统一认三种表象 ——
  DSH 的标记 `file access denied under <mode> mode`（确定）、
  以及 `Access is denied` + 工作区外路径线索（**疑似**，措辞不把猜测说成结论）。
  `runDws` / `runCrwu` 会把这句话补在错误最前面，于是 `dws` 的
  `acquiring file lock: … .dws\.data.lock: Access is denied.` 不再看起来像 dws 自己的 bug。
  测试样本**逐字抄自员工贴回来的原文**。
- **收下 DSH 的沙箱事实**：`ShellRunResult.sandbox = { mode, denied, runnerFailed }` 会说明命令
  **实际**跑在哪个模式、沙箱是否真的拒绝过；`resolve()` 回来的 `spec.sandboxPolicy` 还能看出
  提权请求有没有被降级。`ShellResult` 现在把这四项（请求 / 解析 / 实际 / 是否被拒）一起带出来，
  `sandboxDenialNote()` **以事实为准、事实在手就不再猜文本** ——
  于是「沙箱拒了」与「文件真被占用/ACL 异常」不会再被混为一谈（后者按「去授权」处理是修不好的）。
- 文档：`README.md` 的 Windows 故障排查与 `docs/development-notes.md` §5.1/§5.2 补上
  「工作区外的路径清单」「三种表象→同一个原因」「要全局关沙箱只能改 DSH 侧
  （`DSH_PERMISSION_MODE=danger-full-access` 或 profile 的 `dsh-sandbox-policy.mode`）」。

## package · 0.0.12 · 2026-09-28

**首个包含自更新能力的正式版本。** 0.0.10 / 0.0.11 用户需要**手动完成一次**引导升级
（见 README「更新 CRWU」与 `docs/releasing.md` §9）；从 0.0.12 起，后续正式版本才能通过界面内
的检查与安装升级。

- **启动后自动检查更新**：插件装载后按缓存策略做一次后台检查，**静默**完成，不弹窗打扰；
  发现新版本只把版本徽标变成 `v<当前> · 有更新`。
- **手动检查**：点徽标打开更新面板，「检查更新」绕过缓存立刻再查一次。
- **只接受稳定版本**：只认 npm `latest` 指向的**稳定 SemVer**（预发布 / `next` / `beta` 一律不装），
  并且只认**比当前更高**的版本。
- **同时读取两个公开源（仅限普通公共源 profile）**：普通公共源 profile 下，检查会查
  npm 官方 registry 与 npmmirror 各一次，取其中**合法的更高稳定版本**；
  两个源给出**同一版本**时优先展示 **npmmirror**（国内网络下更可能装得上）。
- **安装交给 DSH Plugin Manager**：安装动作由宿主的 Plugin Manager 执行，本插件不自己下载、
  不解包、不覆盖插件目录；安装优先使用 `https://registry.npmmirror.com/`，
  **网络失败与回退由 Plugin Manager 负责**。
- **企业 / 私有 registry profile：不访问那两个公共发现源**：这类 profile 下
  **不会**去查 npm 官方 registry 或 npmmirror，**自更新被明确禁用**（面板说明原因、禁用安装按钮），
  更新交由企业现有的分发策略管理；插件**不会绕过策略**安装。
- **不提供错误的"一键升级"承诺**：开发目录安装（dev）、Plugin Manager 不可用、企业源管理等情形
  会明确说明原因并禁用安装按钮，不假装能升级。
- **审核占用时禁止安装**：审核任务正在启动或正在运行时禁用安装（不动 profile），
  **但不禁止检查更新**。
- **安装过程可见、可取消、可恢复**：安装状态以**诚实的离散阶段**展示（连接更新源 / 下载安装包 /
  写入插件目录 / 取消中），不伪造百分比；安装期间可以取消；安装请求异常（网络中断、响应不认识）
  会立刻回读宿主事实，不会凭空把安装判定成功或失败；刷新页面后也能从宿主事实恢复安装状态。
- **更新完成后必须手动重启**：界面提示
  「CRWU v<版本> 已安装。请完全退出并重新打开 DeepSeek Harness，使新版生效。」
  macOS 明确说明**关闭窗口不等于退出**（从应用菜单选择「退出」或按 **Command-Q**）；
  刷新页面同样不等于重启。
- **本插件不修改、也不重启 DeepSeek Harness 桌面端**：没有"立即重启"按钮，
  也不会替用户退出桌面应用。
- **协议门禁**：宿主与客户端不同代（`WORKBENCH_PROTOCOL` 不一致）时继续拦住发起审核，
  提示以「完全退出并重新打开 DeepSeek Harness」为准。

## package · 0.0.11 · 2026-09-28

修复「新报告一律发起不了」：审核启动报
`输入快照交接未完成，已终止本次审核（未创建子代理）：输入快照交接失败（input）：案例目录不存在或不是目录：<工作空间>/<流水号>`。

- 根因：`<工作空间>/<流水号>` 是 Host 自己的约定（`shared/utils/case-dir.ts` 的 `caseDirOf`），
  但**没有任何代码建过它** —— 案例内的每一个 Tool（bootstrap / `crwu_h3yun_file_get` /
  `knowledge_materialize` / `oss_publish` / `dingtalk_*`）都先过 `requireCaseDir`（要求目录**已存在**），
  而 `crwu_audit_case_bootstrap` 又必须在**创建子代理之前**把输入快照落进这个目录。
  旧形态是审核子代理自己 `mkdir -p`（2026-09-25 的坑速查里记着它把材料下到 `cases/<流水号>` 那次）；
  改成结构化 Tool 之后那条路没有了，于是只有**已经审过**（目录已存在）的报告能再发起，新报告永远卡在门禁上。
- 修复：`audit-start` 在交接输入快照**之前**由 Host 自己建出案例目录（`mkdir -p`，复用
  `tools/case-files.ts` 的 `ensureDirectory`，workdir 是工作空间）；建不出来就在创建子代理之前
  以 `创建案例目录失败：<路径>（原因）` 终止。目录已存在时是空操作，重审走同一段代码。
- 测试：`host-audit-lifecycle.test.mjs` 新增两条（trace 断言「先 mkdir → 再 bootstrap → 最后建子代理」
  的次序；shell 失败时中止且不占用门禁），并把该文件的 shell 替身从「永远失败」改成默认成功、
  可记录命令（`makeCtx` 的 `trace`）。
- 顺带修发布清单里的一个既存红项：`npm publish --dry-run` 会把 `npm_config_dry_run=true` 继承给
  `pack:assert:strict` 内部那次**真正的** `npm pack` → 打不出 tarball → 严格自检报「没有产出 tarball」。
  现在那次 pack 的子进程环境显式 `npm_config_dry_run: 'false'`（`assert-pack.mjs`，
  与 `host-package.test.mjs` 同一处理），`host-bin-manifest.test.mjs` 加一条接线断言盯着它。
  CI 的真实发布（`npm publish --provenance`）本来就不受影响，只是发布手册 §5.3 这一步以前过不去。

## package · 0.0.10 · 2026-09-27

环境信息页进一步收敛普通员工不需要关注的技术说明：

- 删除「包内组件、DSH Runtime、平台与 Tool 可见性；员工日常不需要看。」在诊断区内与页面底部的重复提示；
- 将「维护者诊断」更名为「开发者诊断」，并加入与现有图标体系一致的终端 SVG 标志；
- 入口降级到内容区右下角的轻量按钮：自适应宽度、无整行虚线框、非悬浮；展开后「收起」仍停在原位置；
- 将全部开发信息收进一个大面板，加入一键复制；补回 CRWU Workbench 版本与同花顺 iFinD 真实连接状态；
- 在开发者诊断入口下加入「联系开发同学排查」链接，使用用户公开分享的钉钉个人名片地址；
- 用户可见名称统一为「同花顺 iFinD」，并修复 iFinD 的 global / external-data 双作用域 issue 被顶部重复计数的问题：8/9 时只显示「还需完成 1 项」。

## package · 0.0.9 · 2026-09-26（续：iFinD 改为必检 + 两项真实外部验证 + 环境页引导式重排）

**协议号 15**（见 `src/shared/consts.ts` 的版本注：iFinD 语义 + 阻塞项 + `externalData` 不再恒真 +
OSS 探测归因字段）。

1. **iFinD 从"可选外部数据能力"改成环境必检、必通过项**（产品口径覆盖了旧的 OPT-006-R1 · F-008）：
   - `DEFAULT_MANIFEST.ifind.required = true`；`IfindCheck.required` / `userSetup.ifind.required`
     随之为 true，**进必需项分母**（必需项 8 → 9）；
   - 未通过即**阻塞**，归属按原因分派：没填 / API-Key 无效或过期 → `user`；
     账号无数据权益 → `admin`；网络 / 超时 / 协议 / 上游不可达 → `system`；
   - issue 双写 `global` + `external-data` 两个 scope：`global` 让统一导航把受保护页面拦回环境页，
     `external-data` 让 `auditCore` 一起关掉（光关外部数据却放行审核是自相矛盾的）；
   - `capabilities.externalData` 不再恒为 true；`degraded` 只留给将来真正的可选能力，
     **不再由"只有 iFinD 缺失"产生**；
   - 门禁提示**整句**就是「进入【报告审核】前，请先完成 iFinD API-Key 验证。」
     （`environmentGate` 算好整句，`navigateModuleIn` 不再往外套一层通用模板 ——
     套起来会变成「请先完成环境配置。（…iFinD API-Key 验证。）」，第一眼仍是笼统的话）；
   - 拦截说明**当场出现**：环境页直接读统一导航层记下的 `blocked` / `pendingTarget` / `gateReason`，
     不再需要用户自己再点一次「重新检查」才看到"为什么没进去"。
2. **两项凭据都改成真实外部请求验证**（不允许"文件在 / 字段非空 / 命令能启动"就算过）：
   - OSS：用**包内绝对路径**的 `ossutil` 对 `oss://<bucket>/<配置前缀>/` 做一次只读列举
     （`--limited-num 1`，**空目录也算成功**，不再打桶根），并把失败**结构化归因**为
     `credential` / `permission` / `config` / `infrastructure`（`ServiceCheck.errorKind` + `target`）；
   - iFinD：判定标准钉死为 `tools/call` 返回非错误、非空内容（`dataVerified`），
     只有它才能让必检项通过；四个阶段（会话初始化 / 工具清单 / 取数 RPC / 取数内容）归因一致；
   - 两者都是：保存后**立刻**验证；点「重新检查」传 `force` **绕过缓存**再验一次；
     界面显示"最近真实验证时间"，不把缓存命中说成刚刚重新请求。
   - 脱敏收敛到一处：`src/host/oss/sanitize.ts` 的 `sanitizeOssError`（AK / Secret / STS Token /
     Signature / 签名 URL），环境探测与上传共用。
3. **环境页重排为"紧凑状态摘要 + 引导式配置工作区"**：
   - 顶部只有一条结论、完成数量、最近检查 / 最近真实验证时间，和**唯一**主动作「重新检查」；
     **删掉「进入报告审核」按钮**（连 `onEnterReport` 属性、处理函数与相关断言一起），
     就绪时只写一句「配置已完成。你可以从左侧进入报告审核。」；
   - 删除三块技术指标卡（平台移入维护者诊断、最近检查压成一行辅助文案、数量与进度合并成一条摘要）；
   - 主区改成**左侧步骤导航 + 右侧当前步骤**：1 账号连接 / 2 阿里云 OSS / 3 iFinD / 4 工作空间，
     默认停在第一项未完成，**用户手动选过之后后台刷新不得抢焦点**；窄屏（≤860px）改成顶部横向
     步骤条，375px 无横向滚动；
   - OSS 表单：真实 `<label>`、两个字段纵向排布、主按钮「保存并验证」、
     保存中「正在连接 OSS 并验证权限…」、成功「验证成功，可以访问交付目录。」，
     失败按凭据 / 权限 / 配置 / 网络分别给人话；
   - iFinD 卡：统一叫 **API-Key**（不再出现「SK」「auth_token」「MCP 配置文件」），
     明说用途、从哪里获得、怎么填、不要把 API-Key 发到对话里；验证中
     「正在连接 iFinD，并读取一条测试数据…」，成功「验证成功，已读取到测试数据。」；
   - 技术信息（工具名、数据样本、协议版本、凭据路径、Bucket / Endpoint / 前缀）**只在维护者诊断里**。
4. 文档与测试同批更新：`AGENTS.md` §4.5 / §4.6 / §4.7、`README.md`、`README.en.md`、
   `docs/ui-design-guidelines.md`、`docs/development-notes.md`、`docs/PRD-workbench-sidebar-modules.md`；
   新增 `tests/unit/client-env-steps.test.mjs`（步骤模型纯函数），
   `install/browser-check.mjs` 的环境阶段按新结构重写（四个步骤 + 无「进入报告审核」按钮 +
   375px 无横向溢出），仍**不触发** `audit-start`。

## package · 0.0.9 · 2026-09-26

**环境配置体验重做：插件自带运行能力，员工只处理账号与密钥；门禁上提到统一导航层。**

协议号 12 → 14（13 增加 `env.state`；14 删除 `install-prompt` 操作）。

### 一、环境领域模型（新增 `src/shared/environment/model.ts`）

旧的 `allOk + blocked[]` 一个数组要同时承担四种语义（谁该处理 / 拦不拦 / 拦哪一块 / 怎么修），
于是同一屏能同时出现「环境就绪」与「7/8 通过」。现在事实与解释分开：

- `userSetup`（workspace / credentialsConsent / h3yun / dingtalk / aliyunOss / ifind）、
  `systemHealth`（packageIntegrity / dshRuntime / platform / toolRegistry）、
  `capabilities`（global / auditCore / delivery / externalData）、`issues[]`
  （`id` / `owner: user|admin|system` / `blocking` / `scope` / `action` / `message`）；
- 总状态 `unknown` / `checking` / `ready` / `degraded` / `action-required` / `admin-required`
  / `system-blocked` / `check-failed` 由 issues **推出来**（纯函数，可单测）；
- **只有 iFinD 缺失 = `degraded`**，不进 `blocked`、不拦任何导航；氚云 / 钉钉 / OSS / 工作空间
  缺失仍是阻塞；
- 包内组件 / DSH Runtime / 平台故障归 `system`，员工页面**不提示**安装二进制、装系统 Python
  或改 PATH；
- **通过率只统计必需项** —— 「环境就绪」与「N/N 通过」永远同时成立；
- iFinD 与 OSS 都区分「未填写 / 已保存未验证 / 已认证 / 认证失败 / 网络不可达」五态。

### 二、iFinD 由插件 Host 集成（不再读技能目录）

- **删除**对 `~/.agents/skills/ifind-finance-data/mcp_config.json` 的运行时依赖；
- SK 改由插件 Host 保存在**插件状态目录**（`<home>/.dsh/crwu-workbench/ifind-credential.json`），
  原子写入 + `chmod 600` 并回读核对；优先 DSH 凭据服务，当前版本没有该服务时落到插件自有文件；
- 新增 4 个 Host 操作：`ifind-status` / `ifind-credential-save`（保存后**立刻真实探测**）/
  `ifind-credential-clear`（要求显式 `confirm`）/ `ifind-probe`；
- `crwu_audit_ifind_query` 增加 `describe_tool`：对单个真实工具返回**脱敏、限深、限长**的
  `inputSchema`（此前只回工具名与描述，模型知道有这个工具却不知道怎么填参数）；
- MCP `protocolVersion` 跟随官方 1.4.0 客户端改为 **`2025-03-26`**，并做**显式协商**
  （服务端回受支持集合内的版本就用它；回不认识的版本按协议错误失败，**不再静默假设**
  `2024-11-05` 永远有效）；
- 401 归 `credential`、403 权益受限归 `entitlement`、网络 / 超时 / 协议错误归 `infrastructure`，
  三者不混；探测结论里不回显 token / session / Authorization（净化器覆盖 schema 出口）。

### 三、统一全局环境门禁

- 模块元数据新增 `requiresEnvironment` / `requirement`（`modules.ts`）；
- **所有入口**都走同一个 `navigateModule(target)`：侧栏子项、报告页内跳转、环境页
  「进入报告审核」、以后新增的页；
- 目标需要环境且当前不是 `ready/degraded` 时：不进入目标页 → 记 `pendingTarget` → 落到 `env`
  → 显示「进入【目标页】前，请先完成环境配置」→ 给「重新检查」；
- 检查通过后**只恢复最近一次被拦的目标**；用户中途主动改去别处即取消自动恢复
  （绝不无条件把用户弹走）；`env` 页始终可进；
- **Host 侧也有能力门禁**（`src/host/environment/gate.ts`）：`audit-start` 等敏感操作复用
  workspace / 授权 / 包内能力 / Runtime / 必需 Tool 的统一判据；用**带 60s 失效策略的快照**
  而不是每个操作重跑一遍完整自检；拿不到快照或自检失败一律 fail closed。
  停止审核与释放占用锁**不判门禁**（它们是安全出口）。

### 四、环境信息页重排

页面顺序改成员工的操作顺序（旧版是维护者排查顺序，员工第一眼看到的是自己修不了的东西）：

1. 顶部**紧凑状态卡**：一句结论 + 通过率 + 最近检查时间 + **唯一**主动作；
2. **账号连接**：一次性授权整合进配置流程（**不再用模态层遮住整页**）+ 氚云扫码 + 钉钉登录
   （保留设备码备用）；
3. **交付与外部数据**：阿里云 AK 表单（向管理员获取）+ **新增 `IfindAuthCard.tsx`**
   （password 输入、保存中禁用、提交后清空本地、保存即真实验证、只显示「已认证」或脱敏摘要、
   可替换 SK、错误就地显示且不回显、给官方入口但不代填不索取）；
4. **工作空间**：自动识别成功时压成一行摘要，缺失 / 失效 / 要更换时才展开；
5. **维护者诊断**（默认收起）：包内组件 / DSH Runtime / 平台 / Tool 可见性 + 包路径、清单、哈希；
6. 「复制安装提示词」整块**删除**（同日追加）：`install-prompt` 宿主操作、
   `src/host/environment/install-prompt.ts` 与 `InstallPromptBlock.tsx` 一并删除，
   对应的 8 条单测（`host-install-prompt.test.mjs`）也随之删除 —— 二进制随包发布、
   登录与密钥都在界面上完成之后，那段提示词没有运行时用途，只把员工指去绕路。
   ① 工作空间的「在新会话中打开」按钮同样删除（多余：选目录那一步已经在案例根目录里打开了工作台）。
   操作清单 30 → 29；`boot.ported.done`、客户端门面与 `tests/helpers/frozen-inventory.mjs` 同步。
7. **iFinD 改名 API-Key，并把「环境校验」升级成真实取数验证**：
   - 界面与文案统一叫 **API-Key**（不再是"SK"）：输入框标签、状态词、错误提示、官方入口链接；
   - **每次环境校验都真的取一次 iFinD 数据**（`initialize` → `tools/list` → `tools/call`），
     不再是"只认证不看数据"；`dataVerified` / `dataTool` / `dataSample` 三个字段进线协议，
     `dataSample` 是**脱敏后**的短摘要（上游回显的 token 会被净化掉）；
   - 两截结论分开：`ok`（认证）与 `dataVerified`（取数）。认证通过但没取到数据时状态是
     `unverified` + 明确的 `errorKind`，界面说「认证通过，但这次没有取到数据」并给处置，
     **绝不显示成「已认证」**；
   - 失败归因在**四个阶段**一致（会话初始化 / 工具清单 / 取数 RPC / 取数内容）：先看 401/403，
     再看消息指纹；`credential` / `entitlement` / `infrastructure` 给三种不同的员工动作文案；
   - 试取工具由 `pickProbeTool` 从真实 `inputSchema` 挑（只读、必填 ≤ 1、无开关参数），
     写/批量/导入导出类一律不碰；挑不出来就如实报"权益可能未开通"；
   - **30s TTL 探测缓存**（按凭据指纹作键）避免面板反复刷新打上游，"重新检查"传 `force` 绕过缓存。

`AuthorizationGate` 模态层、`layers.ts`（五层规则）、`OssAuthCard.tsx` 随之下线。

### 五、测试与交付

- 新增 `tests/unit/client-env-model.test.mjs`（状态 / 通过率 / 门禁纯函数）、
  `client-module-gate.test.mjs`（统一导航）、`client-ifind-card.test.mjs`（SK 卡片）、
  `tests/helpers/ifind-fixture.mjs`（内存凭据 + MCP 传输替身）、
  `tests/helpers/frozen-inventory.mjs`（Tool / 操作名单只此一份）；
- `host-environment-env.test.mjs` 改为对着**模型**断言（degraded vs blocked、owner、
  通过率自洽）；`host-ifind-tool.test.mjs` 重写并覆盖保存 / 清除 / 探测五态；
- `install/browser-check.mjs`：环境页阶段改成新的四分组结构，并新增**全局门禁**阶段
  （人为降级环境应答 → 点报告审核 → 断言落到环境页且出现目标页名 → 恢复后自动继续），
  仍不触发 `audit-start`；
- `host-package.test.mjs` 的工具数量断言改为与 `REQUIRED_AUDIT_TOOLS` / 冻结清单对账
  （此前写死 9，实际 10 —— 裸数字已经漂移过一次）。
- `WORKBENCH_PROTOCOL` 12 → 13；插件版本 0.0.8 → 0.0.9。

## package · 0.0.8 · 2026-09-25

**自研审核链路改为结构化 Tool 优先：审核子代理不再查找、拼接或执行任何业务 CLI。**

### 一、新增 8 个业务级 Tool（`src/host/tools/`）

`apply()` 里经 `ctx.tools.register()` 注册，插件卸载时逐个注销；schema 自动进 Agent 的
system prompt。**没有任何通用逃生工具**（不存在 `crwu_exec({argv})` / `shell_exec` 这类形状），
schema 里也没有 binary / argv / command / sandbox 模式 / bucket / 组织 / 团队空间等字段。

| Tool | 作用 |
| --- | --- |
| `crwu_audit_capabilities` | 零副作用能力自检：受支持平台、三个自带二进制是否在包内、必需 Tool 对当前 Agent 是否可见、策略事实。**不返回二进制路径**。 |
| `crwu_h3yun_record_get` | 按 `schemaCode` + `objectId` 一次取回记录全字段 |
| `crwu_h3yun_files_list` | 只回附件元数据；不下载、不回显带会话鉴权的下载 URL |
| `crwu_h3yun_file_get` | 单附件定向下载，目标必须落在案例目录内；**没有整单下载回退** |
| `crwu_audit_knowledge_materialize` | 知识库 M2：解析库（组织 + 个人全范围精确名匹配）→ 递归遍历 → 按 `extension` 分流导出/下载 → 写 manifest 证据。模型只提交 `caseDir` + `paths[]`。 |
| `crwu_audit_oss_publish` | 从受信配置读 bucket/endpoint/prefix；只接受 `caseDir` + `seqNo`（或显式交付件名）；上传后**真的列举**核对对象与字节数；错误脱敏 |
| `crwu_audit_dingtalk_archive` | 组织唯一 / 默认账号唯一 / 团队空间唯一 / 年月目录 / 唯一远端名 / 写后验证；`profile`、`spaceId`、`nodeId` 全部来自真实返回 |
| `crwu_audit_dingtalk_notify_self` | get-self → 人员精确定位 → 发 HTML 到自己单聊 → 读回 conversationId/messageId → 转**应用内** DING；单案例幂等 + 进程内串行 |

### 二、执行层

- 新增 `src/host/dws/`（`consts.ts` / `run.ts` / `plan.ts` / `knowledge-tree.ts`）：
  `dws` 的**唯一**调用点，argv 白名单前缀匹配（表外默认拒绝），最终经 `ctx.shell` 执行。
- `requireBundledCommand`：审核 Tool 严格要求包内二进制存在，缺失时回 `capability-gap`，
  **绝不回退裸命令名**（回退会让模型看到 `command not found` 然后去搜 PATH）。
- `runShell` 新增可选 `signal`（透传 `ShellExecRequest.signal`）与 `aborted` 结果位；
  Tool 的 `exec.signal` 一路传到 shell。
- `runCrwu` 新增 `signal`，并把文件头自相矛盾的提权注释改成与实现一致的口径
  （`effective = (trusted ∧ 白名单) ∨ 显式 escalate`）；**白名单本身没有扩大**。
- 失败分成三类并在返回值里标明：审批拒绝（`approval`）/ shell 基础设施故障
  （`infrastructure`）/ CLI 非零退出（`cli`），另有 `input` / `capability-gap` / `policy` /
  `not-found` / `cancelled`。
- 默认操作走默认沙箱；只有本机凭据命令、且已授权（`trustCredentials`）、且 `workspaceRoot`
  已知时才申请 `danger-full-access`。模型无法通过参数提权。

### 三、审核子代理链路

- 审核指令**删除**插件二进制目录、`export PATH`、`<binDir>/dws` 与全部裸 `crwu`/`dws`/`ossutil`
  命令块，改写成逐条 Tool 调用要求；不再依赖 `upload_audit_result.py`。
- 审核根会话的 hello 预检扩为「`pwd` + 实际调用 `crwu_audit_capabilities`」。
- 新增**确定性能力门禁**（`src/host/audit/preflight.ts`）：发起审核前按
  `ctx.tools.get(name, agent)` 检查全部必需 Tool 对审核根 Agent 可见，并通过
  `ctx.tools.execute()` 真调一次零副作用的能力自检（证明注册表与 policy pipeline 通得过）；
  缺任何一个就在**创建子代理之前**失败并列出缺失的工具名。
- 子代理发布后按**它自己的 scope** 复查一次工具可见性；被收窄时立即停掉该子会话并失败。

### 四、技能

- `crwu-audit` 的 `SKILL.md`、`references/00`、`references/13` 改为 Tool 契约。
- 公共技能 `crwu-dws` / `crwu-h3yun-login` / `crwu-h3yun-query` 顶部新增「DSH 环境：只用结构化 Tool」，
  原 CLI 方式移入明确标注的**非 DSH 宿主兼容层**（`<!-- crwu-cli-guard:legacy-compat-start -->` 区块）。
- 新增静态守卫 `scripts/check-skill-cli-guard.mjs`（`npm run skills:cli-guard`，进 `check` 与 CI）：
  扫描非 vendored 技能文档的**活跃指令**，拦截裸 `crwu`/`dws`/`ossutil`、`which`、`command -v`、
  `export PATH=`、包内 `bin/<平台>/`、`~/bin/<命令>`；`skills/dws/**` 明确排除（vendored 上游正文）。

### 五、二进制供应链

- 新增 `bin/manifest.json`（`crwu.plugin-bin-manifest.v1`）：每个平台每个工具的来源、版本、
  构建 target/commit、**最终文件 size 与 sha256**，下载型二进制另记归档哈希。
- `sync-binaries.mjs --check` 改为**按清单重算最终文件哈希**（不再只看存在/非空）；
  新增 `CRWU_BIN_DIR` 以便发布矩阵汇总产物与单测覆盖失败分支。
- `assert-pack.mjs` 新增 `--strict`（`npm run pack:assert:strict`，`prepublishOnly` 与
  Makefile 的 `plugin-check` 都用它）：要求两平台六个二进制 + manifest 都在真实 tarball 里，
  解包后逐个重算 size/sha256，且 `bin/` 下没有未声明的运行残留。正式发布不再把「完全没有 bin」
  当警告。
- `.github/workflows/release.yml`：新增 `binaries` job（macos-14 上 `make build` 交叉编译出
  darwin + windows 两份 crwu，再 `sync-binaries.mjs` 装配并自检），产物作为 artifact 交给
  `publish` job；发布前跑严格模式自检。

### 十、报告定位交接：Host 定位 + 输入快照（2026-09-25）

用户报「自动审核启动后子代理重新定位/搜索报告」。根因是交接不完整：`auditStart` 只把
`objectId` / `seqNo` / `project` 交给子代理，而记录接口要 `schemaCode` —— 子代理于是自己去
发现表单、列记录、在案例目录里翻找材料。

- 新增 **`H3yunFormResolver`**（`src/host/h3yun/form.ts`，插件实例级）：`state.formCode` 非空直接复用；
  为空才调一次 `discoverForm`，**并发共享同一个 in-flight Promise**；失败不缓存。
  `loadPending` 与全部记录类 Tool 共用它（原来 `loadPending` 自己发现一次）。
- **模型可见参数里删掉 `schemaCode`**：`crwu_h3yun_record_get` / `crwu_h3yun_files_list` 改为
  `{ objectId, caseDir? }`，Tool 内部从解析器取 code；命令里的 `--schema` 来自 Host。
- 新增 **`crwu_audit_case_bootstrap`**（第 9 个 Tool）：按精确 `objectId` **各调一次**
  `records get` 与 `files list`（固定 argv，禁止 `records list` / 搜表单 / 扫目录），
  写 `<案例目录>/输入快照/{报告记录,附件清单,快照元数据}.json`，只回紧凑摘要
  （`snapshotPath` / `digest` / `fieldCount` / `attachmentCount` / `routingFacts`）。
  同一 `attemptId` 重复调用返回上次摘要（`reused:true`）；`refresh:true` 才覆盖。
  元数据里只有 `schemaCode` 的**指纹**，原文不落盘、不进上下文；`downloadUrl` 同样丢弃。
- **审核启动新增三道门禁**（都在创建子代理之前）：表单 code 解析、`bootstrapInputSnapshot()`
  （经 `ctx.tools.execute()`、以审核根 Agent 为 scope）、DSH Python 可用（见第十一节）。
  成功后把 `snapshotPath` / `digest` / `objectId` / `seqNo` / `attemptId` / Python 路径写进指令。
- **重审**：`attemptId` 每轮都新（`<key>-a<attempt>-<time36>`），bootstrap 强制 `refresh:true`
  覆盖本轮快照；仍不得读取上一轮审核产物与 `复核-人工/`。
- **指令新增「报告已由 Host 精确定位」一节**：以输入快照为唯一记录来源、不得重新定位或重复取数、
  附件只按清单 `fileId` 取、快照与任务不一致时立即停止并报「数据边界错误」。
- 技能同步：`crwu-audit/SKILL.md` 步骤 1 由「按输入类型定位 + 提交 schemaCode」改为
  「消费 Host 已准备的输入快照」；`references/00` 的脚本命令改为注入解释器占位符。
- 测试：`host-tools.test.mjs` 新增 4 条（schema 无 `schemaCode`、`--schema` 来自解析器、
  定位失败不调 CLI、bootstrap 幂等/重审刷新/落盘内容）；`host-audit-lifecycle.test.mjs` 新增 6 条
  （缓存复用、定位失败中止、交接失败中止、Python 不可用中止、只调一次且 agent scope 正确、
  指令含快照与指纹）；`host-audit-prompt.test.mjs` 新增 3 条逐字断言。

### 十一、DSH 自带 Python：审核脚本不再依赖系统 python3（2026-09-25）

- 新增 **`WorkspaceRuntimeResolver`**（`src/host/runtime/python.ts`，插件实例级）：经
  `ctx.tools.execute()` 调 `load_workspace_dependencies`（审核启动带审核根 Agent 作为 scope），
  校验 `python` **是存在的普通文件**并真能跑出版本，校验 `pythonDistributions` 至少含 `openpyxl`
  （缺则 `missing-package`）；顺带记录 `python-docx` / `python-pptx` / `Pillow` / `lxml` / `numpy` /
  `pandas` / `XlsxWriter` 版本。**只缓存成功结果**，失败可在「重新自检」时 `refresh:true` 重试。
  不硬编码安装路径、不读 `process.argv`、不改 PATH、不复制 Python 进包、不做 pip 自动安装。
- **审核启动前解析**：失败**不创建子代理**（否则子代理会退回系统解释器）；成功后把绝对路径写进
  `AuditPromptTask.python`，指令新增「脚本运行时：只用 DSH 自带的 Python」一节
  （含「禁止裸解释器名字 / 任何解释器查找 / 静默降级」与 capability gap 规则）。
- 技能同步（自研层，vendored `skills/dws/**` 不动）：`crwu-audit` 新增「脚本运行时（Python）」一节；
  `crwu-audit-datacheck`、`crwu-audit-external-data` 与两个维护元技能的运行时命令改为
  「注入的绝对路径 / 先调一次 `load_workspace_dependencies` 并复用」，并删掉 pip 安装建议。
- 测试：新增 `tests/unit/host-runtime-python.test.mjs`（7 条：只解析一次 + 显式刷新、agent scope、
  capability gap 文案、路径校验（不存在/非文件/不能执行）、缺 openpyxl 且失败不缓存、版本表归一、
  源码不硬编码路径/不改 PATH）。

### 九、讨论会话的资料来源：远端 only + 唯一案例目录（2026-09-25）

用户报「这两个与 DeepSeek 对话的按钮里工具好像还是调不动」+「每次新建对话都必须束缚 DeepSeek
不能从我电脑的目录里去找已有的文件，需要重新从远端下载」。**先看真实会话记录再改**：

- **工具是通的**（记录原话）：`crwu_audit_capabilities` 返回 8 个工具 `available:true`；
  5 个氚云附件全部由 `crwu_h3yun_file_get` 从远端下回（`ok:true` + 真实字节数）；
  会话标题正确写为 `报告讨论 · <流水号>`。看起来"没调工具"，是因为模型**同时**在用
  `bash`/`read` 翻本机目录。
- **真正要修的是目录**：模型 `pwd; ls -la` → `find cases -maxdepth 4` → `mkdir -p cases/<流水号>/材料-源`，
  把材料下到了 `<工作空间>/cases/<流水号>`；而审核链路一直用 `<工作空间>/<流水号>`。

改动：

- 新增 `src/shared/utils/case-dir.ts` 的 `caseDirOf(workspacePath, seqNo)`：案例目录约定**只定义一次**，
  Host 审核提示词与 Client 两条讨论提示词共用（原来是两处各拼一次，这次漂移就是它的产物）。
- 两条讨论提示词（报告讨论 `discussionBrief`、审核分析 `buildAuditContextBlock`）都追加
  `fetchRules()`：唯一案例目录 + `crwu_h3yun_file_get({fileId, caseDir, relativePath: "材料-源/<原名>"})`
  逐件下载 + **每次新建对话都重新下载**（磁盘上的同名文件可能是上一轮/别的报告的过期件）+
  **禁止** `ls`/`find`/`grep`/`glob` 扫描本机 + 不要自己建目录树 + 清单外一律「当前不可用」。
  `caseDir` 为空时整段不写。7 条规则逐字断言。
- 新增文案 `aiCaseDirHead` / `aiFetchRulesHead` / `aiFetchRules`（`zh-CN.ts`）。
- 测试口径更新：原来断言「上下文里不许出现任何本地路径」，现在改为**只允许出现案例目录这一条**
  （用正则抽出全部本机路径再去重断言），并在 `client-assistant.test.mjs` 增加一条
  「Host 审核指令与讨论上下文算出同一个案例目录」的防漂移断言。

### 八、修复「点讨论/复核跳不到会话、也建不出新对话」（2026-09-25）

用户报：在报告审核里点「与 DeepSeek 讨论报告」/「复核 AI 审核结果」跳不到对应会话，
也创建不出新对话。两个独立根因，都在客户端会话接线：

- **`sessions` 上没有 `open()`**：早期按「客户端会话服务有 open」写成 `sessions?.open?.(sessionId)`，
  而真实实现 `ClientSessions` 只有 `retain / using / binding / list / create / fork / scope /
  sessionOf / search / subagentAddress …`。可选链把它变成**静默 no-op**，只剩半截
  `layout.selectPanel(null)` —— 所以「点下去什么都不发生」。现在跳转统一走
  **`uiWorkspace.openSession(id)`**（内部 `replaceMain(…, 'reveal')` = 设置主会话 + 切回原生对话；
  左侧会话列表被点也是走它）。`DiscussionPort` 里**删除** `open`，只保留服务上真实存在的
  `create` / `using` / `binding` / `list`；新增 `discussionPortOf()` 做**逐方法、经接收者**的适配
  （不 `{...sessions}`、不把方法取出来再调 —— 这些方法都依赖 `this`）。
- **会话 face 取错**：`binding(id)` 是 `this.scopes.get(id)?.binding`，**只有已被 retain 的会话**
  才有值，而刚 `create()` 出来的还没 retain → rename 被静默跳过（会话没名字 → 下次按名字找不到、
  只能再建一条），kickoff prompt 也根本没发出去（用户看到的第二半症状）。现在 `rename` / `prompt`
  一律经 **`sessions.using(id, {source}, op)`**（retain → 跑 → release），`binding` 只作旧宿主退路；
  改名失败会带 `aiRenameFailed` 文案如实报出来，而不是悄悄咽掉。
- **职责收敛**：`ensureDiscussion` 只负责「建/复用 + 命名」，**不再自己跳**；「跳」由面板的
  `onOpenDiscussion` 单独负责（两处都跳会连线两次 `replaceMain`）。
- **测试替身也一起修**：原 `fakePort` 给每条会话都预置了 binding，比真服务宽容 —— 这正是缺陷漏过门禁
  的原因。`client-assistant.test.mjs` 改为按真实语义建模的 `FakeSessions`（`create` 不 retain、
  `binding` 只对有 retain 的 id 有值、放一个诱饵 `open`）；`client-package.test.mjs` 另加两条：
  适配器只转发真实动词且不解绑 `this`、以及「从面板点小鲸鱼一路到 `openSession` 恰好一次」。
- 跨进程契约未变，`WORKBENCH_PROTOCOL` 不动（纯客户端行为）。

### 七、登录与 PATH 口径（2026-09-25 收尾）

结构化 Tool 化之后，「把插件 bin 目录挂到 shell PATH」这条老拐杖必须一起去掉，否则
「模型手工拼命令行」看起来可用，等于绕过沙箱与审批。

- **安装提示词（`src/host/environment/install-prompt.ts`）不再让 agent 手工跑登录命令**：
  原来第 1、2 项写的是 `crwu h3yun session login` / `dws auth login`，现在改为
  「在面板 ③ 登录认证 里点『氚云登录』/『钉钉登录』」+「首次先点『同意并继续』完成插件授权」，
  并显式禁止「搜索可执行文件 / 改 PATH / 往 `~/bin` 拷副本 / 为了让它能跑而调环境」。
  逐条断言在 `host-install-prompt.test.mjs`（含「不许出现可直接照抄的登录命令」）。
- **`install/INSTALL-PROMPT.md`（发给收件人 agent 的装插件提示词）同步**：不再写
  「装 crwu / dws / ossutil」，改为「按面板引导完成登录与密钥」，并加一条禁止去找命令路径。
- 面板里的登录按钮本来就经 `resolveBundledCommand` / `runCrwu` 用**包内绝对路径**发起，
  所以这两处改动之后，员工机器上**不需要任何 PATH 配置**。

### 六、测试

新增/改写：`host-tools.test.mjs`（25 条：注册与注销、无逃生字段、包内路径、signal 透传、
默认沙箱与提权白名单、钉钉归档/通知、OSS 写后校验、失败三分类、纯计划逻辑）、
`host-bin-manifest.test.mjs`（6 条）、`host-skills-guard.test.mjs`（6 条，含守卫证伪），
`host-audit-prompt.test.mjs` 重写为「Tool 名 + 无路径泄漏」断言，
`host-audit-lifecycle.test.mjs` 增加 2 条「缺 Tool / 能力缺失时不得创建子代理」。

### 十二、环境自检分层：packaged / runtime / auth / delivery / external（2026-09-25）

**旧的 `env.checks[]` 把四类东西混装成一列命令清单**：随包组件（`crwu` / `dws` / `ossutil`）、
系统运行时探针（`python3`）、以及靠 PATH 解析的命令。界面只能平铺成「命令 + 路径 + 版本」，
员工看到 `python3 未安装` 就去装 Python、看到 `ossutil` 就去找安装包 —— 而这两个都不是他们的活。

- **清单拆成显式分区（`crwu.env-manifest.v3`）**：`packaged[]`（`crwu` / `dws` / `ossutil`，
  只有 `name` / `label` / `note` / `expectedVersion`，**没有** `command` / `versionArgs` / `expect`）
  与 `runtime.python`（**DSH 自带**解释器 + 版本约束 + `requiredPackages`，至少含 `openpyxl`）。
  `binaries[]` 整个删除，**裸 `python3` 不再是检查项**。
- **packaged 的检查规则**（`environment/probe.ts`）：只 `stat` 包内 `bin/<平台>/<文件>` 并与包内
  `bin/manifest.json` 比对**字节数**；`sha256` 从清单读出来进维护者详情，**不**每次自检重算
  （三个二进制一百多 MB，哈希是发布门禁的事）。**不得** `command -v`、**不得**回退 PATH 上的同名
  命令、**不得**执行 `dws version`（会在二进制旁落 `.dws/` 状态目录，`pack:assert` 判成运行残留）。
  缺失文案统一为「插件包不完整 / 平台不受支持」，绝不提示员工安装命令。
- **`resolveOssutil` 同样只认包内**（删掉 PATH 回退），失败文案改成插件包口径；
  导出名与 `{ path, error }` 形状保持不变，所以 `oss/ops.ts` / `oss/auto.ts` 不需要改。
- **`env` 的返回改成六块分区**：`packageIntegrity` / `runtime` / `services`（氚云 + 钉钉，**不含 oss**）/
  `delivery`（OSS 配置 + 凭据 + 连通性）/ `external`（iFinD）/ `workspace`；`checks` / `ifindKey` /
  顶层 `oss` 整体消失。**协议号 +1（11 → 12）**：旧宿主仍会回 `checks[]`，新界面读到 `undefined`
  只会画出一整页假故障，必须由协议号自己喊出来。
- **`blocked` 口径**：插件包不完整只算**一个**故障（`插件内置组件`）、DSH 运行时不可用只算
  **一个**故障（`DSH 脚本运行时`）；三件组件不再各占一项，vendored dws 的 PATH 兼容性也不再
  阻断 CRWU 自动审核。
- **`env` 接受 `{ refresh?: boolean }`**：界面「重新自检」传 `true`，让宿主重解析 DSH 自带运行时
  （首次进入用缓存）。`EnvDeps.pythonRuntime` 是**可选依赖**，缺它或它报 `capability-gap` 时
  如实显示 capability gap，**不是**「未安装 python3」。
- **平台探测（`platform/detect.ts`）去掉 `python3` 探针**：本地 Desktop 优先
  `process.platform` + `process.arch`（受支持时**一次 shell 都不跑**），只有 Host 事实不在
  `BUNDLED_BIN_PLATFORMS` 里时才跑**一次** `uname -sm` 作执行世界诊断；执行世界与包内二进制
  不可混用（包内二进制属于插件进程所在机器），所以 `uname` 给出另一个受支持平台时**不采纳**。
- **页面改成 ① + 五层**：① 案例根目录（`WorkspaceCard`）+ ② 插件内置组件（**一个**聚合项，
  显示 `插件内置组件 3/3 完整`）+ ③ DSH 脚本运行时（明写来源是 DSH 自带，列出 `openpyxl` 等版本）
  + ④ 登录与凭据授权 + ⑤ OSS 交付配置 + ⑥ 外部数据；`EnvLayerId` 随之改名，
  `envTally` / `blocked` 口径同步。安装提示词里的层号也一起改到 ④ / ⑤。
- **测试**：`host-environment-probe.test.mjs` 重写（只认包内、不跑 shell、不比 sha256、
  PATH 上有同名命令也不认）、`host-environment-env.test.mjs`（六分区、不跑 `command -v python3`、
  不跑 `dws version`、capability gap 两种、`blocked` 只算一项）、新增
  `host-environment-platform.test.mjs`（受支持不跑 shell / 不受支持只跑一次 `uname -sm`）、
  `client-env-layers.test.mjs` 重写（五层顺序与计数、聚合项、不出现「请安装 crwu/dws/ossutil」）。
  以上关键断言逐条**注入缺陷证伪过一次**（回退 PATH、跑 `dws version`、系统 python3 兜底、
  组件各占一项、总跑 uname、多塞一层）。

## package · 0.0.7 · 2026-09-25

- **只读 OSS 分发桶（`crwu-only-workspace`）整体下掉。** 它此前有四个消费者，这次全部切断：

  | # | 原来的用途 | 现在怎么办 |
  | --- | --- | --- |
  | 1 | 二进制下载元数据（远端清单里的 `~/bin/crwu`、`crwuPlatforms()` 的 url/sha256） | 二进制随包发布在 `bin/<平台>/`（0.0.6 已做），元数据整组删除 |
  | 2 | 远端环境清单拉取（`manifestUrl`） | 清单只有内置一份（`DEFAULT_MANIFEST`），`loadManifest` / `normalizeManifest` / `resolveBinary` / `resolvePlatformEntry` 全删 |
  | 3 | 安装文档 URL（`installDocUrl`） | 安装提示词改为**整篇自述**，一个外链都没有 |
  | 4 | 插件 TGZ 分发（`pluginPrefix`） | **改从 npm 安装**；`scripts/dist-plugin.mjs` 与 `plugin-dist` 目标删除 |

  **为什么值得动这一刀**：那四个用途都建立在「员工机器的行为依赖一个远端对象」之上，而那个桶是匿名可读、
  **地址谁都能换** —— 换掉清单就能改员工认哪些二进制、装到哪儿；换掉安装文档就能改 agent 照着做什么；
  换掉 TGZ 就能换掉插件本体。少一个远端数据源就少一条这样的通道。现在只剩**审核产物**那一个私有桶
  （员工自己的 AK 上传，`oss.protected`）。

- **安装提示词重写（这是安全相关的改动，逐条钉在 `host-install-prompt.test.mjs` 里）。**

  旧版第一篇是「**第一步：先完整阅读这份安装清单 —— `<url>`**」，并声明「清单里的下载地址、校验要求、
  目录约定、硬性约束都以它为准」—— 那份清单就是上面那个可被替换的远端对象。新版不再外链任何东西，
  因为 `crwu` / `dws` / `ossutil` 随包自带，剩下的只有登录与密钥：

  - 明说三个命令**随包自带**，要求 agent **不要**下载/安装/升级，也不要往 `~/bin` 或系统目录放副本；
  - OSS AK 与 iFinD 密钥改成「**你不要索取、不要代填、不要回显**，交给员工自己填 / 停下来问我」；
  - 逐字保留两条踩过坑的安全措辞：「**GitHub 一律按不可达处理**」（去探测会白等）、
    「**密钥、令牌一律不要回显**」。
  - 新增两条断言盯着「提示词里不许出现任何 URL」与「生成函数只收工作空间一个参数」——
    少一个参数就少一条「把地址换成任意 URL」的通道。

- **协议号 +1（9 → 10）**：`env` 的清单来源字段整组消失（`manifestSource` / `manifestKind` /
  `manifestLoaded` / `manifestError` / `manifestUpdatedAt` / `installDocUrl`），换成 `configSource`
  （部署 YAML 路径，故障对账时看的就是它）；`EnvCheckView` 去掉 `url` / `sha256` / `target`；
  `install-prompt` 的 `url` 恒为空。宿主与客户端分开加载，这一代必须靠协议号把「界面是新的、宿主是旧的」挡在门外。

- **`env` 自检的探测顺序简化为两条**：① 插件自带的 `bin/<平台>/`，② 执行世界自己的 PATH。
  第三条「清单里写的安装目标」（`~/bin/...`）随元数据一起删除 —— 留着它就等于留着「各自装一份」那条老路。
  `resolveOssutil` / `probeOss` 同步收窄（不再接受 `manifest` / `home` 选项）。

- **配置文件与校验**：`config/crwu-workbench.yml` 删掉 `oss.readonly` 整段；
  `src/host/config/yaml.ts` 删掉 `ReadonlyOssConfig` / `distributionTargets` / `objectUrl`；
  `check-config.mjs` 只打印私有桶。`WorkbenchConfig` 不再有 `manifestUrl` / `installDocUrl`。

- **界面**：环境自检页去掉「下载地址 / 安装到 / SHA256」与「环境清单来源 / 清单更新时间 / 清单错误 /
  安装文档」四行，换成一行「部署配置」（YAML 路径）；工具没就绪时的文案从
  「点上面『复制安装提示词』让 Agent 装上」改成「随插件自带，请重新安装插件或联系管理员」。

- **清理**：删 `scripts/dist-plugin.mjs`、`scripts/plugin-distribution-config.mjs`、
  `tests/unit/dist-config.test.mjs`；Makefile 去掉 `plugin-dist` 与 `PLUGIN_CONFIG`，
  `plugin-pack` 变成「先 `plugin-bin` 再 `plugin-check` 再 `npm pack`」并提示走 tag 发布；
  CI 去掉 dist 守卫自检步骤；root READMEs 与 `plugins/AGENTS.md` 同步（两桶 → 一桶）。

- **`node` 从环境清单里整个移除 —— 它从来不是这个插件的依赖，而且会假阻塞。**

  旧条目的理由是「最上游运行时：dws（npm 包）与 iFinD 的 Node 路径都依赖它」。那在当时是准确的：
  `~/bin/dws` 是个 `#!/usr/bin/env node` 的 **npm 包装脚本**。0.0.6 把二进制打进包之后这条就不成立了，
  逐条实测确认：

  1. **三个自带二进制都是原生可执行文件**（`cffa edfe` = Mach-O；Windows 侧是 PE）。
     `env -i PATH=/usr/bin:/bin ./bin/darwin-arm64/dws version` —— **PATH 里根本没有 node**，
     照样输出 `v1.0.61`。`dws` 用的是上游 `vendor/dws` 的 Go 程序，不是那个 npm 包装器；
     `crwu` / `ossutil` 本来就是 Go 二进制。
  2. **打包的技能里没有任何地方调用 node**：grep 出来的 `--node <ID>` 是 `dws` 的参数，
     `wiki node list` 是知识库节点，`#!/usr/bin/env node` 零命中。技能脚本全是 Python。
  3. 所以真必需项是 **`python3`**，而它本来就在清单里（`required: true`）。平台探测也只靠它：
     `python3 -c 'import sys,platform;print(sys.platform+"-"+platform.machine())'` → `darwin-arm64`，
     正是本清单 `platforms` 用的键。

  因此同时删掉了 `detectPlatform` / `detectHome` 里的 node 探测快路 —— 它们只是冗余，
  而**可用性取决于 DSH 是从 Finder 还是终端启动**（实测同一个桌面安装：Finder 起的 PATH 只有
  `/usr/bin:/bin:/usr/sbin:/sbin`，`node` 解析不到；终端起会带上 fnm 的 node）。
  同一台机器、同一份插件，只因为启动方式不同就红一项 —— 正是本仓反复要求避免的谎报。

  **顺带修了界面口径**：`envLayers` 的 `pass` / `total` / `needsWork` 现在**只数必需项** ——
  Host 的 `blocked` 只看 `required`，层也必须只看 `required`，否则会出现「Hero 说环境已就绪、
  某一层却显示 4/5 并默认展开」的自相矛盾。清单当前没有可选项，所以这条用一个合成的
  `required: false` 记录钉成不变量，并**证伪过一次**（把 `layerOf` 改回全量计数即变红）。

  **协议号 +1（10 → 11）。** `env.checks` 的字段形状没变，但**语义变了**：旧宿主仍把 node 当必需项
  并放进 `blocked`，界面于是显示「还差 node」。实测踩到这一刻：宿主比磁盘产物旧一版时，客户端因为
  形状没变而**不报警**，安静地显示一个假阻塞项（用户看到的就是「为什么还要我提供 node」）。
  所以这里必须 +1，让「界面是新的、宿主是旧的」由协议号自己喊出来（AGENTS.md §7.12）。

- **修「氚云登录 / 钉钉登录点了没有任何反应」。** 两个独立根因叠在一起：

  1. **命令按名字调用，而 PATH 里没有它。** 0.0.6 把 `crwu` / `dws` 从 `~/bin` 挪进包内 `bin/<平台>/`，
     但 `runCrwu`、`dwsSelf`、`dws auth status`、`dws auth login` 全都还在**按名字**拼命令、靠 PATH 找。
     桌面端从 Finder 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— 实测运行中的宿主报
     `h3yun → bash: crwu: command not found`、`dingtalk → bash: dws: command not found`，
     而同一份清单里的 `ossutil` 正常（`resolveOssutil` 早就改成优先包内绝对路径了）。
     现在统一走 `resolveBundledCommand`：**能证实包内有就用绝对路径，否则回退按名字**
     （SSH / 容器执行世界里包内路径不存在，回退分支必须留着）。
     `.zshrc` 里那条 export 对 Finder 启动的 GUI 进程无效 —— 依赖 PATH 这件事本身就不成立。
  2. **客户端把返回值丢掉了。** `onRelogin` / `onDwsLogin` 写的是
     `.then(() => envStatus.refresh())`，`ok` / `error` / `timedOut` / `stdoutTail` / `stderrTail` 全部丢弃 ——
     命令没跑起来时用户看到的就是「点了没反应」。现在把结果**显示在环境自检页**：成功一句话、
     失败带真实原因、CLI 打到 stdout 的 URL / 设备码原样带出来（浏览器打不开时那是员工唯一能走下去的路）。

  顺带补了**设备码登录**入口：门面一直支持 `dwsLogin({ device: true })`（`dws auth login --device`，
  官方文档写明给「SSH 远程 / 无头 / 本地浏览器够不到 127.0.0.1」用），但界面上从来没有入口 ——
  默认那条是 OAuth loopback 流、要开浏览器等回调。现在钉钉那一行多一枚「设备码登录」按钮。

- **审核子代理现在知道自带二进制在哪了。** 提示词里原先有两句**假话**：

  - 「凭据已经配在本机 `~/.ossutilconfig`，直接用 `ossutil` 即可」
  - 「**`dws` 已在 PATH 里**」

  子代理跑在 DSH 自己的 shell 里，PATH 是 DSH 继承来的、插件改不了 —— 桌面端从 Finder 启动时
  只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`dws` / `ossutil` 都不在里面。于是提示词让它跑的命令
  （钉钉回传、OSS 上传）实际只会拿到 `command not found`。

  而插件**本来就知道**它们在 `<包根>/bin/<平台>`。现在提示词最前面多一段「命令在哪」：
  给出真实目录、绝对路径用法（推荐），以及「脚本内部还会调 `dws` 时」在同一条命令里
  `export PATH="<目录>:$PATH"` 的用法；并明确**不要**往 `~/bin` 或系统目录拷副本。
  `binDir` 为空（平台不受支持）时整段不出现 —— 不编路径。
  新增两条断言（写入真实目录 / 缺平台时不出段）并**证伪过一次**。

## package · 0.0.6 · 2026-09-25

- **兼容 DSH 升至 `0.1.7-rc.2`（cordis `4.0.4`）。这不是例行跟进 —— 0.1.7 起 peer 变成了硬门禁。**

  `peerDependencies` / `devDependencies` 里的 `@deepseek-ai/dsh-*` 从 `0.1.5-rc.2` 升到 `^0.1.7-rc.2`。
  依据是 0.1.7-rc.2 自带文档里的原文：

  > Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and
  > `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`.
  > **Every declared range must match; prereleases participate in range matching.** …
  > an incompatible bundle without an exemption is **skipped** like an unreadable one and listed in `skippedBundles`.

  旧 peer 钉死 `0.1.5-rc.2`，在 `0.1.7-rc.2` 的运行时上**整个 bundle 被跳过** —— 症状是「插件装上了、
  界面里什么都没有」，而启动日志没有任何报错。写 `^0.1.7-rc.2` 而不是钉死，是为了让同一条 0.1.7 线上的
  rc 补丁与正式版都能过闸；`^0.1.7-rc.2` = `>=0.1.7-rc.2 <0.2.0`，预发布只在同一 `[major,minor,patch]`
  元组内参与匹配，所以 `0.1.8-rc.1` **不会**被放行。另加 `engines.dsh` 作声明口径 —— 但门禁读的是
  peer，`engines.dsh` / `dsh.manifestVersion` 在 0.1.7 上**只是声明、不强制**
  （`dsh-package-manifest` README 原文：「Current installers and loaders do not enforce」）。

- **修 0.1.7 的 shell 契约破坏性变更：`ShellExecutor.run(spec)` 已不存在。** 新形状是
  `execute(spec)` 返回进程句柄，前台结果（stdout/stderr/timedOut）在句柄的 `result()` 上，
  `ShellExecSpec` 另增 `onExpiry`。`src/host/shell/run.ts` 是唯一调用点，已改为两步；
  `tests/unit/*` 里 20 处 shell 替身同步改成 `execute().result()`（0.1.5 的 `run` 形状在 0.1.7 上
  直接 `is not a function`，实测过的报错原文）。**这一条是本次唯一的 API 破坏点** —— 其余 peer 与
  client UI / `ctx.fs` / `ctx.webServer` / `ctx.locale` / 槽位 API 在 0.1.7 上类型与行为都兼容，
  由 `tsc` + 548 条单测 + `smoke:built` 一起证明。

- **`crwu` / `dws` / `ossutil` 三个二进制改为随插件发布（`bin/<平台>/`），不再依赖员工各自的 `~/bin`。**

  先确认了「DSH 会不会把插件里的 bin 挂上 PATH」——**不会**，四条路都实测堵死：
  `dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 `Config` 只有
  `cwd/timeoutMs/maxTimeoutMs/maxOutputBytes/maxSpillBytes/graceMs`、`dsh-shell-env` 只接收 `DSH_*` 键
  （`lib/index.js` 里前缀校验会直接抛错）、`.env` 明确拒绝 `PATH`（文档原话「export them instead」）。
  所以「员工零安装」只能靠插件按平台解析包内绝对路径，前提是文件真在包里。

  目录按 `normalizePlatform()` 的键命名，两个平台：`bin/darwin-arm64/{crwu,dws,ossutil}`、
  `bin/win32-x64/{crwu.exe,dws.exe,ossutil.exe}`。**软链接落不了地**：实测 `npm pack` 会**静默丢弃**
  符号链接（相对与绝对都不在 tarball 里，只有真实文件会），所以一律落真实文件 —— 开发机也是拷贝，
  避免「本机能用、员工装上少文件」。

  装配由 `scripts/sync-binaries.mjs` 负责（`make plugin-bin`），来源都可复现、都不依赖开发机预装：
  `crwu` 取本仓构建产物、`ossutil` 取阿里云官方包（URL/sha256 直接读内置清单，**同一事实源**）、
  `dws` 取 `dingtalk-workspace-cli@1.0.61` 的 `assets/dws-*`（sha256 对照包内 `checksums.txt`，校验的是
  **归档**而不是解包结果）。`--check` 只校验已装配内容，供发布前核对。

  `src/host/platform/bin-dir.ts` / `package-root.ts` 负责定位（`import.meta.url` 上溯找 `package.json`，
  构建产物 1 层与源码 3 层都落到同一个包根）；`probeEnv` 与 `resolveOssutil` **优先自带**、
  查不到才回退 PATH 与清单 `target` —— 执行世界是 SSH/容器时自带二进制在宿主上用不到，回退分支必须留着。

- **`assert-pack` 增加自带二进制断言**：本地装配了 `bin/<平台>/` 就必须逐个出现在真实 tarball 里，
  没装配只提示不失败（CI 不做 `make build` + 110MB 下载这一套）。解包体积上限从 8MB 提到 160MB
  —— 两个平台三件套本身约 108MB，这里的上限是防「误打了别的大家伙」，不是追求包小。
  `files` 增 `bin/`，`FORBIDDEN` 增 `.cache/` 与几个同步脚本。

- **Makefile**：新增 `plugin-bin` / `plugin-bin-check`；`plugin-dist` 改为**显式**先 `plugin-bin` 再
  `plugin-check`（并列 prerequisites 在 `make -j` 下会并行，门禁可能跑在装配之前）；
  `plugin-clean` 连同 `bin/`、`.cache/` 一起清。

- **本机迁移（开发机）**：`~/bin` 下的 `crwu`、`dws`、`ossutil` 三个入口删除（`ossutil` 与包内副本
  逐字节相同、`sha256` 比对确认；`dws` 只删软链、不动 `~/.workbuddy` 里的真实安装），
  改为在 shell 配置里 export 一条指向 `plugins/dsh-crwu-workbench/bin/darwin-arm64` 的 PATH。
  这条 export 是**必需**的：审核子代理跑 vendored `skills/dws/` 里的 `dws ...` 用的是 DSH shell 的
  PATH（本会话实测 `/usr/bin:/bin:/usr/sbin:/sbin`），插件无法只给自己注入。

## package · 0.0.5 · 2026-09-23

- **技能重构为「分层目录 + 一层一个技能根」。** 原来包内只有 `skills/`（自研 27 个）与 `common/skills/`
  （公共 3 个）两个技能根；现在按归属分层：

  | 层 | 目录 | 内容 |
  | --- | --- | --- |
  | 自研层 | `skills/crwu/` | 原有 27 个 crwu-audit / crwu-dev-audit 技能（`git mv` 原样搬迁） |
  | 上游层（新） | `skills/dws/` | vendored 的 `dingtalk-workspace-cli` 钉钉技能 14 个（集合 `multi`） |
  | 公共层 | `common/skills/` | `crwu-dws` / `crwu-h3yun-*`（位置不变） |

  **为什么必须一层一个根**：`@deepseek-ai/dsh-skill-filesystem` 的 `discoverRoot()` 对每个技能根
  **只扫一层**（`readdir(root)` → `<子目录>/SKILL.md`），不递归。只注册 `skills/` 会把 `skills/crwu/`
  当成"一个没有 `SKILL.md` 的技能"跳过，**整层静默消失**（症状与 2026-09-22 的 `baseUrl` 陷阱完全一样：
  provider 装配成功、技能表里 0 个技能、日志干净）。所以 `cordis.patch.yml` 的 `customSkillDirs`
  改成返回 `skills/crwu`、`skills/dws`、`common/skills` 三个根。
- **`dws` 层只由同步脚本改写，可复现、可审计。** 新增 `scripts/sync-dws-skills.mjs`
  （`npm run dws:sync`）从本机 `dws` 的上游副本同步，并写 `skills/dws/provenance.json`
  （上游包名 / 版本 `1.0.61` / 集合 / 逐技能 sha256 / LICENSE、NOTICE 摘要）；
  `npm run dws:check` 只对照 provenance 逐文件比对（不需要上游，CI 与员工机器都能跑），已接入
  `npm run check` 与 `prepack`。上游版本或集合变化必须显式 `--allow-version-change` / `--allow-set-change`，
  否则拒绝写入 —— 上游静默换版不会悄悄改掉随包内容。上游以 Apache-2.0 发布，`LICENSE` / `NOTICE`
  随技能保留。这一层是上游正文，按 `skills/README.md` 的口径**豁免**本仓 Skill 自洽性 lint
  （上游按自己的跨技能相对链接组织），门禁只跑自研层与公共层。
- **共用的摘要/枚举逻辑提取**到 `scripts/lib/skill-digest.mjs`，两个同步脚本不再各写一份
  （`sync-common-skills.mjs` 改为复用，`--check` 语义不变）。
- **门禁与源仓工具改为按层寻址**（同一类"静默扫 0 个技能"的坑）：
  - `Makefile` / CI 的 `kb_tool.py validate` 改为 `--skill-root skills/crwu` 与 `--skill-root common/skills`
    各一次（传上层 `skills/` 会静默扫 0 个技能）；新增 `make plugin-dws`；
  - `Makefile` 的 `skills-install` 改为 `find plugins -name SKILL.md` 收集技能 —— 任何层都被收到，
    层目录自己不会被误当成技能；
  - `check_audit_skill_mappings.py` 的技能根候选改为 `skills/crwu` + `common/skills`，硬编码的
    `skills/crwu-audit/...`、`skills/crwu-dws` 等 label 改为按根解析；
  - 三个源仓契约测试的 `_skill_roots()` 改为按"根里直接放着技能"识别所有层并跨层查找
    （自研层与公共层不再同级；不修会让整组断言静默 skip）；
  - `kb_tool.py` 的仓库引用规则新增 `skills/<层>/` 形态（分层后跨层引用同样要拦）。
- **运行时路径与跨层依赖**：`src/host/audit/skill-paths.ts` 的包内解析改到 `skills/crwu/`
  （`prompt.ts` 的 `$SKILLS_ROOT` 占位语义不变，指自研层）；
  `crwu-audit-external-data` 的 `connector_probe.py` 改为在"本技能所在层 + 同级层 + 公共层 +
  常见位置"里找 `ifind-finance-data`（iFinD 与本技能不再同层）。
- **交付形状护栏**：`package.json` 的 `files` 显式列出 `skills/README.md`、`skills/crwu/`、
  `skills/dws/`；`assert-pack.mjs` 三层各钉代表文件 + `provenance.json`；`smoke-built.mjs` /
  `host-audit-prompt.test.mjs` / `host-package.test.mjs` / `host-skills-patch.test.mjs`
  （三个根、逐层技能数与 `SKILL.md`）同步。
- **文档**：新增 `skills/README.md`（分层契约、`dws` 层同步与升级、豁免口径）；
  同步 `AGENTS.md`（根 / `plugins/` / 插件各一处）、`docs/skills.md`（分层表 + `dws` 层目录）、
  `docs/agent-skill-dirs.md`、`README.md` + `README.zh-CN.md`、`README.en.md`、
  `docs/development-notes.md`（`baseUrl` 之外新增"少注册一层"这一同类坑）。
- **维护规程**：`plugins/AGENTS.md` 新增 §5.5「新增技能层或技能时的改动清单」—— 把本次逐项踩出来的
  改动面（技能根 / `files` / 打包断言 / 单测计数 / skills/README / 文档 / 版本）、自研层与 vendored 层
  的两条分叉、"不用改"的自动发现面，以及四个会咬人的坑固化成清单；插件 `AGENTS.md` §4.1.3 加了指针。
- 顺手修复一处既有缺陷：`crwu-audit/scripts/test_audit_delivery.py` 的 v1.6 目录同步断言读的是
  早已不存在的旧路径（`skills/README.md`、`docs/CHANGELOG.md`），一直以 `FileNotFoundError` 失败；
  改为从技能目录上溯定位源仓文档（`docs/skills.md` 与 `docs/v0.0.1/CHANGELOG.md`），
  安装副本内显式 skip。

### 验证（0.0.5）

- `npm run check`（版本一致 + 配置 + 公共技能同步 + `dws:check` + typecheck + 单测 + build + 产物冒烟）
  与 `npm run pack:assert`（三方加载契约 + 三层文件清单）在本轮全过。
- 技能门禁：自研层与公共层 `kb_tool.py validate` 均 `error=0`；
  `test_audit_skill_maintainer.py`、`test_audit_multiaxis_router.py`、`test_dws_source_contract.py`
  全过（跨层查找生效，未被静默 skip）。
- `git diff --check` 干净。

## package · 0.0.4 · 2026-09-22

- **DeepSeek 会话统一数据边界：报告业务会话只允许用「本次会话注入的远端资料」**（2026-09-23 用户强制口径）。
  两个入口（报告列表「与 DeepSeek 讨论报告」、AI 审核列表「与 DeepSeek 分析审核结果」）一律：
  **不发本地路径、不列本地文件、远端取不到就不建会话**。
  具体落地：
  ① 上下文只由远端资料组成 —— `fileLinesOf()` 只列**氚云附件 + 云端交付件**（带大小 / ETag），
  本地案例目录（`report-files.local`）**整组不进上下文**，也不再出现案例根目录路径；
  ② 新增 **Source Provenance**（`sourcesOf()`）：每条资料记 `sourceType:'remote'` / `provider(h3yun|oss)` /
  `remoteId` / `remoteVersion` / `remoteUpdatedAt` / `digest` / `fetchedAt`，**绝不记 localPath**；
  ③ Context Snapshot 按用户 §11 改成**远端身份**：`reportRemoteId`（氚云附件 fileId + OSS key 聚合，
  替代上一轮的本地文件指纹）、`auditRemoteId`（审核产物 OSS key）、`fetchedAt`；`changesSince()` 随之
  只比远端标识 / ETag / 远端时间 —— **本地路径不再参与任何版本判断**；
  ④ **远端失败 = 明确报资料不足**：`report-files` 的远端两项都空（哪怕本地目录里有同名报告）→
  弹「无法获取当前报告的远端最新资料 / 为避免使用过期或来源不明的数据，本次未创建分析会话」，
  只给**重试**；上一轮那个「仍以有限资料继续」的出口按 §8/§16 删掉了（那正是"去找本地替代"的口子）；
  ⑤ System Prompt 按 §12/§13/§14 逐字更新：报告讨论注入 7 条数据边界，AI 审核分析把开场句改成
  「系统已经将本次从远端业务系统获取的相关资料加入当前会话上下文…」并插入 7 条强制规则 +
  事实来源优先级（远端报告 > 远端 Metadata > 人工复核 > AI 审核结果，AI 审核属历史快照）。
  验证：新增 3 条断言（来源清单只有远端标识且无 localPath / 报告讨论上下文含数据边界且无任何本地路径 /
  远端为空时**不建会话、不发 prompt、不回显本地文件**），**逐条证伪 5/5 真红**
  （把本地文件当来源、边界段不注入、上下文写回本地路径、远端为空仍建会话、本地资料拼回上下文）；
  `npm run check` 545 → **548 通过**；`git diff --check` 干净。
  **工具层边界（用户 §15）本轮未做，原因与证据见下**：插件侧做不到 ——
  `@deepseek-ai/dsh-api-session-controller` 的客户端 `sessions.create()` 会**重建 payload**，
  只转发 `{workspaceId|cwd, sessionId}`，把 `agentPreset` 之类的字段直接丢掉（读 `lib/client.js` 的
  `create()` 实现可见），而"按 preset 组合（不含 bash/fs 工具）建会话"这条路只在宿主侧
  （`ctx.get('agents').create({meta:{agentPreset}})` + `agentPresets.mount`，本插件建审核根会话时已在用）
  才走得通，且需要插件自带一份 preset 目录并把它挂进 profile 的 preset root。
  这属于改动 Harness 的 agent plane、并且必须真机重启验证，因此**先按"数据边界彻底落到上下文层"交付**，
  工具层方案与影响面写在 `docs/ui-design-guidelines.md` §6.7 与 `docs/PRD-workbench-sidebar-modules.md` §9.19。
  **用户 2026-09-23 当场确认采用方案 B（只保留上下文 + Prompt 边界），工具层不做** —— 这是有意选择，
  不是遗漏。限制范围只针对这两个业务会话，**不动普通 Harness 会话**。

- **OSS 列举改用长格式：一次 `ls` 就带回 大小 / 最后写入时间 / ETag**（用户 2026-09-23 提示：
  「oss 一次可以查询一个目录下有多少个文件」）。原先 `oss-index` 给自己加了 `--short-format`，
  只拿到 key —— 而 `ossutil ls` **默认就是长格式**（`ossutil help ls` 的样本逐字写着
  `LastModifiedTime / Size(B) / StorageClass / ETAG / ObjectName` 与 `Object Number is: N`），
  一次调用本来就能同时给出对象个数与每个对象的元数据。
  改动：`parse.ts` 新增 `parseLsEntries()`（按长格式解析，时区段不逐字匹配，跨桶对象隔离，
  认不出的行跳过）；`oss-index` 去掉 `--short-format`，解析不到条目时**退回**老的 key 解析
  （少元数据但清单不丢，不把整次列举判成失败）；`CloudItem.files[]` 与 `report-files` 的
  `oss[]` 带上 `size / lastModified / etag`，`local[]` 带上 DSH `fs` 的 **`version` 令牌**
  （`FsDirEntry.version`：后端给的权威新鲜度令牌，比 mtime 强）；合成口径 `WORKBENCH_PROTOCOL` 8 → **9**。
  这些元数据直接喂给上一轮的「AI 审核结果分析会话」：
  `auditArtifactOf(cloud)` 取审核结果 JSON 对象的 ETag / 最后写入时间（没有就退回 HTML）→
  进版本证据与 Context Snapshot；`reportFingerprintOf(reportFiles)` 把本地案例目录的
  「名字 + 大小 + version」聚合成本地指纹 → 进快照。于是 §12/§13 最要紧的两条信号从"记录时间有没有动"
  升级成**同源客观**：资料指纹变了 = 报告已更新；审核对象 ETag 变了 = 审核结果重新生成过
  （记录时间没动也能判出来）。**仍不伪造强结论**：报告侧目前没有 OSS 对象，跨源的
  digest/version/etag 仍然不齐 → 初次判定依旧走时间退化（`possibly_stale`），这一条有单测钉着。
  顺带：AI 审核列表的「N 个交付件」改成以**这一次列举真实看到的对象个数**为准
  （`item.files.length`，旧宿主没带 files[] 时退回语义条数），Chip 仍是审核报告 / 审核数据。
  验证：真机 `ossutil ls oss://crwu-workspace/crwu/audit/`（只读）实跑，10 个对象 / 5 份报告，
  解析出的 size / lastModified / ETag 与逐字样本一致（样本已抄进单测）；新增 7 条断言
  （长格式解析与跨桶隔离、分组带元数据、ETag 取值与回退、指纹稳定性、快照比对的两条客观信号、
  交付件数量），**逐条证伪 9/9 真红**；`npm run check` 537 → **545 通过**；`pack:assert` 173 文件；
  `git diff --check` 干净。文档同步：`docs/ui-design-guidelines.md` §6.6 补"元数据来源"、
  `docs/development-notes.md` §11（+1 条坑：别给自己加 `--short-format` 丢元数据）。

- **新增「AI 审核结果分析会话」（audit_analysis）**（2026-09-23，用户口径：「本轮重点不是普通聊天入口，
  而是建立 AI 审核结果分析会话」）。**AI 审核列表**的操作列从 `[查看报告] [•••]` 变成
  `[查看报告] [DeepSeek SVG] [•••]`：复用**同一个** `DeepSeekIcon` 组件与同一套 Icon Button
  （`C.aiRowBtn`），靠浮动 Tooltip 区分业务含义 —— 报告列表那枚仍是「与 DeepSeek 讨论报告」，
  这里换成「与 DeepSeek 分析审核结果」；没有新增文字按钮，也没有「可分析 / AI ready / 已同步」这类 Tag。
  与报告列表**共用** `Report → Conversations` 体系（不建第二套聊天）：来源靠**会话名前缀**区分
  （`审核分析 · <流水号>` vs `报告讨论 · <流水号>`）—— 这是本仓既有的"名字即映射"机制，
  `sessions.create` 不接受 metadata，所以**没有**为这个字段去改会话数据库；`ensureDiscussion` 加了
  `kind` 参数，`sessionsOfKind()` 是唯一的找回入口。
  点 DeepSeek 之后**不立刻建会话**，先做 Audit Conversation Preflight：取最新原始资料
  （`report-files`：氚云附件 + 本地案例目录 + 云端交付件，只列举不下载）→ 取裁剪过的审核摘要
  （`oss-result`：审核报告 / 结构化问题 / 复核意见）→ **版本判定**（新增纯模块
  `audit-freshness.ts`：`digest → version → etag → mtime → 时间退化`，四态
  `current / possibly_stale / stale / unknown`）→ 按结论决定：直进 / 版本选择框 / 已有会话选择框 /
  缺原始资料（Limited）。**纯时间差只给 `possibly_stale`**（用户口径：「不要仅仅因为审核时间 < 报告更新时间
  就直接断言一定过期，因为更新时间可能来自非内容性操作」），所以「报告已更新」这种确定语气只在
  digest/version/etag 强证据下出现；`stale` 时提供「重新 AI 审核 / 仍以当前审核结果分析 / 取消」，
  选了后者会把「当前 AI 审核可能基于旧版本」写进上下文。
  **新建会话 = Fresh Snapshot**：重新取最新原始资料 + AI 审核 HTML + JSON + 复核意见 + 报告元数据；
  §20 的 System Instruction **逐字**注入（locales 的 `aiAuditSystemPrompt`，`【REPORT_SERIAL_NUMBER】`
  替换为真实流水号），并附 §21 的 Context Notice（报告更新时间 / AI 审核时间 / 复核更新时间 /
  版本关系中文表述 + 缺失项）—— **不把文件正文拼进 Prompt**（会话建在案例根目录下，模型按路径回看原文）；
  人工复核意见按**真实结构**读取（`reviewFiles` + `reviewItems`，含 `inFileResolution` 的三态中文口径），
  不假设固定三级。每个会话存一份 **Context Snapshot**（`reportSerialNumber / reportUpdatedAt / reportDigest /
  auditGeneratedAt / auditSourceDigest / auditArtifactVersion / reviewUpdatedAt / conversationCreatedAt /
  contextStatus`）到浏览器本地（`crwu.audit-analysis.<seqNo>`，读写都做了收窄与 try/catch；
  丢了大不了退化到会话行的 `updatedAt`）—— 用户说「不要为了这个字段重构整个会话数据库」，所以不改宿主状态结构。
  降级如实：原始报告取不到 → 「无法获取最新原始报告」（重试 / 仍以有限资料继续，并记入上下文）；
  只有 HTML 或只有 JSON → 各记一条缺失说明；没有复核意见 → 正常情况，不报错不阻断。
  **历史审核产物一个字节都不改**（AI Audit T1 / Current Report T2 / Analysis T3 三者独立）。
  验证：新增 9 条断言（版本判定优先级与 `possibly_stale` 克制、快照差异三信号、会话命名互不串味、
  Snapshot 存取与坏数据、上下文包逐字注入 System Instruction + 不出现英文枚举、AI 列表入口与 Tooltip、
  点 DeepSeek 的 possibly_stale 拦截 / 直进新建并注入 / 已有会话选择 / 缺原始报告拦截），
  **逐条注入缺陷证伪（11/11 真红）**；`npm run check` 527 → **537 通过**；`install/browser-check.mjs`
  的 AI 审核列表阶段补了「统一入口 + 同一枚 SVG + Tooltip 文案 + 无噪音 Tag」四条真机断言。
  文档同步：`docs/ui-design-guidelines.md` §6.6、`docs/development-notes.md` §11（+2 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.18。

- **「审核信息」Drawer 二轮返工：重定义为「AI 审核质量与问题摘要」**（2026-09-23，用户第二轮口径：
  「当前版本虽然比原始字段列表好看，但信息权重仍然错误……它不是审核状态详情，而是 AI 审核质量与问题摘要」）。
  优先级按 P0–P4 重排：**复核命中率（32px/600，不做红黄绿评分色）→ AI 检出问题数 + 已提未改 →
  AI 检出的具体问题列表 → 报告信息（默认折叠）→ 技术详情（默认折叠）**。
  **删掉**顶部「审核摘要 / 未通过 / 复核 · 已执行」Summary Card（结论与复核状态挪进折叠的报告信息）、
  删掉「问题情况 → 发现问题 → 13」这种三层重复标题、删掉 `hitRate` 旁的完整公式。
  新增：**AI 检出问题列表**（`issue.title` + `gapAnalysis.difference`，按 高→中→低 稳定排序，
  点开给「位置 / 建议 / 查看更多审核依据 →」，**不重新调模型生成描述**；完整规则证据不进 Drawer）；
  **「已提出但仍未整改」独立指标 + 折叠区**（左侧 3px 琥珀强调条 + 低浓度红 badge，
  每条给「人工复核：<原话>」与「AI 检出：<当前仍发现>」）；`bands.aiOnly` 降级成 AI 检出旁的
  secondary「其中独立发现 N」；高/中/低降级成标题下一条 secondary；待确认/未检查与其余三条带
  收进默认折叠的「其他事项」。
  **判定逻辑（严格按真实字段，不猜）**：`reviewComparison.reviewItems[].linkedIssueIds`（schema：string[]，
  人工复核项 ↔ AI issue 的正式关联）**且** `inFileResolution === 'L-open'`（交付规范 §6.1
  「复核已提出 · 被审件未落实」）→ 关联到 `issues[]` → 按 issueId 去重。
  已落实（L-resolved）/ 答复称已改未落地（L-unclosed）/ 材料缺失（L-uncheckable）/ 没关联 issue 的
  一律**不算** —— 用户口径「宁可暂时不显示，也不要误报」。
  为拿到这两块数据，Host 侧 `auditInfoFromResult`（`oss-result`）**追加两组裁剪字段**（同一操作、
  同参数，纯新增）：`issues[]`（8 个字段、逐字段截断、封顶 100 条）与
  `reviewComparison.reviewItems[]`（6 个字段、封顶 100 条）；`ruleEvidence`/`materialEvidence`/
  知识库路径/完整引文仍然**不进**这个接口。合成口径 `WORKBENCH_PROTOCOL` 7 → **8**（改跨进程契约要 +1）。
  尺寸/遮罩按新口径：宽 580（560–620）、遮罩 `rgba(0,0,0,.32/.34)` + `blur(2px)`。
  验证：客户端新增 10 条 + Host 新增 4 条断言，**逐条注入缺陷证伪**（客户端 11/11、Host 3/3 真红；
  其中「业务区不许出现程序枚举」一条最初用"拼接后 replace"是假通过，已改成按子树整段剔除并重新证伪）；
  `npm run check` 518 → **527 通过**；`pack:assert` 173 文件；`git diff --check` 干净；
  `install/browser-check.mjs` 的抽屉阶段整段重写（第一屏优先级 / 命中率字号与无公式 / 无结论大卡 /
  问题列表与点开 / 已提未改折叠与展开 / 折叠区默认收起 / 关闭后上下文不变），并把
  「没有带审核摘要的云端记录」从 FAIL 改成**条件式跳过**（那是数据条件，不是缺陷）。
  文档同步：`docs/ui-design-guidelines.md` §6.5 重写、`docs/development-notes.md` §11（+1 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.17。

- **「审核信息」右侧 Drawer 按业务视角重排（修用户报的「更像 Debug Panel」）**（2026-09-23）。
  信息架构从「标题 + 20 行 Label/Value 一路铺到底」改成五段：
  **审核摘要 → 问题情况 → 复核情况 → 报告信息 → 技术详情（默认折叠）**，
  3 秒内先看懂「过没过 / 多少问题 / 高中低各多少 / 复核到哪一步 / 命中情况」，元数据与技术追溯排后面。
  同批落地：Header 改成「标题（16/600）+ 一行等宽流水号 + ×」并**删除「关闭」文字按钮**
  （正文不再重复流水号；项目编号与流水号是两个真实字段，值相同也各自保留）；
  程序枚举只在有权威定义时翻中文（`pass/fail/pending_confirmation`、
  `not_performed/performed` 分别来自 `audit_result.schema.json` 的 enum 与 `audit_delivery.py` 的
  `REVIEW_STATUS_LABEL`，三条带标签来自 `11-html-delivery-spec.md` §6.1），认不出的取值**显示 —**
  并原样进技术详情，绝不编中文；`reviewComparison.bands` 的原始 JSON 与命中率公式
  （引擎写在 `metrics.aiHitRate` 里的 `33.3% (= (exact 1 + partial 0) / evaluable 3；…)`）
  **移出主界面**，主界面只留 `33.3%` + `1 / 3 条命中` + `精确 1 · 部分 0`，
  原值在折叠的技术详情里；引擎版本 / raw 枚举 / raw counts JSON / 原始 ISO 时间 / schema /
  renderer / sourceDigest / 内部流水号全部进技术详情（40px 折叠头 + `grid-template-rows 0fr→1fr`
  的 170ms 展开动画 + 可复制 JSON）。
  尺寸与交互：宽度 540（520–560，复用 `--crwu-surface`，不另立深色主题）、
  遮罩 `rgba(0,0,0,.32/.36)` + `blur(2px)`（关掉后还看得出从哪一行打开）、
  开 `translateX(20px)→0` 200ms / 关 150ms（父层延迟卸载，`onClose` 仍立刻回调）、
  关闭后不动列表上下文（Tab / 页码 / 搜索 / 滚动位置）。
  **业务时间全面绝对化**（用户口径：这是审核留痕系统，省略年份会造成误判）：新增
  `features/report-audit/time.ts`（`YYYY-MM-DD HH:mm` / 只有日期 `YYYY-MM-DD` / 认不出的原样返回 /
  **不做时区换算**，完整原值留 `title` 与技术详情），报告列表的「更新时间」从
  「今天 / 昨天 / 09-20 18:15」一并改成 `2026-09-20 18:18`（列宽 12% → 14%，否则年份会被截掉）。
  语义与文案集中在新的纯模块 `features/report-audit/audit-summary.ts`，中文全部进 locales
  （并把「面板不许内联中文文案」这条门禁从 `WorkbenchPanel.tsx` 扩到 `AuditInfoDrawer.tsx`）。
  验证：`tests/unit/client-package.test.mjs` 新增 13 条（时间规范、列表绝对时间、枚举映射与
  不构造语义、命中率只取百分数、三条带、计数缺字段不画 0、Drawer 小节顺序与技术详情默认折叠、
  业务区不出现程序枚举/JSON、认不出枚举显示 —、技术详情展开、加载/失败态、头部结构、关闭动画），
  **逐条注入缺陷证伪**（8/8 真红，其中「命中率主行」一条最初是 includes 假通过，已改成整格断言并重新证伪）；
  `npm run check` 505 → **518 通过**；`pack:assert` 173 文件；`git diff --check` 干净；
  `install/browser-check.mjs` 的抽屉阶段同步重写（宽度 / 遮罩与 blur / 动画 / 头部结构 / 小节顺序 /
  结论优先 / 技术详情默认折叠与展开 / 业务区无原语 / 关闭后列表上下文不变），
  并修掉两处**早已失效**的选择器（浮层菜单项是 `role="menuitem"`，`getByRole('button')` 永远匹配不到；
  抽屉入口改用类名 + 文案）。文档同步：`docs/ui-design-guidelines.md` §6.5（新增 Drawer 口径）、
  `docs/development-notes.md` §11（新增 2 条坑：业务时间规范、浮层菜单项角色）、
  `docs/PRD-workbench-sidebar-modules.md` §9.16。

- **次级控件收成一套中性底（修用户当场报的「操作列的按钮颜色不一致，还有刷新按钮」）**（2026-09-23，
  用户在 **dark 主题**下看到）。现场是同一行里三种形态：主操作实心反色、小鲸鱼填充 `#F2F3F4`、
  ••• 完全透明，而工具条的刷新又是第三种 Ghost；深色下小鲸鱼的底（`#232427`）还与行悬停底
  （`#222326`）几乎同格，鼠标移到那一行它就像"没底"了。改法：新增
  `--crwu-control` / `--crwu-control-hover` / `--crwu-control-active` / `--crwu-control-text`
  （浅色 `#EFF0F2` / `#E4E5E8` / `#DADCE0` / `#5F6065`，深色 `#2E2F34` / `#3A3B41` / `#45464C` / `#A1A1A6`），
  **刷新、小鲸鱼、•••、流水号复制四者逐字共用**；`--crwu-icon-btn*` / `--crwu-ghost-hover` /
  `--crwu-ghost-text` / `--crwu-menu-open` 四个只服务一处的旧 token 删除。
  回归：新增单测「次级控件共用同一套中性底」（断言四处引用同一 token、悬停同格、
  且 `--crwu-control` 在浅深两套里都不等于 `--crwu-hover`），**证伪两次**（••• 退回透明 / 中性底=行悬停底
  → 均变红）；`install/browser-check.mjs` 补两条真机断言（操作列里同类控件底色一致、小鲸鱼与刷新同底）。
  教训写进 `docs/development-notes.md` §11：主题是**服务端设置**，用户切到 dark 后观感全变，
  改配色要先确认当前真实主题。

- **报告审核页第二轮整体重构：Workspace Surface + Segmented 页签 + 行动作收口**（2026-09-23，用户书面口径：
  「从当前回退后的稳定代码重新开始……对报告审核整体 UI/UX 做一次完整但克制的重构」，前提是**不改业务逻辑、
  不改 API、不改数据结构、不重构侧栏**）。这一轮**取代**下面两条 0.0.4 早期口径（历史保留，以本条为准）：
  ① 文字型页签 + 2px 品牌色下划线 → **轻量 Segmented Workspace Tabs**（浅槽 `--crwu-tab-track` +
  选中项白片 `--crwu-surface` / `--crwu-shadow-tab` / 600，不要红色 underline、不要双重选中）；
  ② 主操作 / 小鲸鱼 / ••• 三个都实心反色 → **一屏只允许一处实心**（主操作 32px 实心反色、
  小鲸鱼 32×32 浅中性 Icon Button、••• 透明 Ghost，组件上不再挂 `C.btn + C.btnPrimary`）。
  同批落地：§19 成为**唯一允许写字面量色值**的 token 块（浅色一套 + `body[data-ds-dark-theme]` 覆盖同名
  token，不再依赖 `prefers-color-scheme`）；Header 54px + `blur(18px)`；正文底 `--crwu-app-bg` + 一块
  14px 圆角 Workspace Surface；表头 39px / 行 82px；搜索（400×38、默认无黑边、Enter 查询、× 清空）与
  刷新 Ghost（只转图标）**同一行**；流水号悬停浮出复制按钮；AI 审核列表的交付件改讲业务语义
  （「N 个交付件」+ 审核报告 / 审核数据 Chip），**不再暴露 `crwu/audit/.../*.html|json` 原始路径**；
  分页 `« ‹ 页码窗口 › »` + 跳至第 N 页（总数只在页签里出现一次）；空态「暂无 AI 审核结果」+ 一句说明；
  浮层仍是 fixed Floating Layer（Tooltip 深底白字带箭头、••• 菜单 150px/34px 行/160ms 入场），
  列表一滚就关闭、同一时间只允许一个。
  验证：`tests/unit/client-package.test.mjs` 新增 8 条断言（Segmented 页签 / 工具条 Ghost / 流水号复制 /
  两套操作列组合 / 交付件语义与 ••• 菜单 / 不暴露 OSS 路径与空态 / 分页四向 + 跳页 / 操作列无状态噪音），
  **8/8 都注入过缺陷并确认真红**；`npm run check` 496 → **504 通过**；`npm run pack:assert` 173 文件；
  `git diff --check` 干净；`install/browser-check.mjs` 同步改成本轮口径（量浅槽/白片/无指示条、
  Enter 查询、× 清空，并补了刷新 Ghost 与分页四向的断言）。文档同步：
  `docs/ui-design-guidelines.md` §1.1 / §6.0 / §6.1 / §6.4、`docs/development-notes.md` §11（新增 4 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.15。

- **操作列的 ••• 也改成与主操作同一套实心反色**（已被上面 2026-09-23 那轮取代：••• 现在是透明 Ghost
  Icon Button，不再挂 `C.btn + C.btnPrimary`；历史记录保留）（2026-09-23，用户原话：「操作列的 更多操作的三个点也需要
  改下颜色适配，和前面的 AI 审核一样，按钮的背景色什么的，这样看起来很清楚」）。做法是**复用**而不是复制
  颜色：组件上给 ••• 挂 `C.btn + C.btnPrimary`，`.crwu-audit-menu` 只保留几何（32px → **28px**，与小鲸鱼和
  行内小按钮一致）与「菜单开着」的品牌色内环 `box-shadow: inset 0 0 0 2px var(--crwu-brand)`。原来那个
  `surface-selected` 浅底选中态在实心按钮上根本看不出来，所以换成内环；§20 迁移层里那两条已被变体压过的
  菜单规则一并删除（免得读代码时误判谁生效）。回归断言在 `tests/unit/client-package.test.mjs` 的 ••• 用例里
  （已证伪一次：不挂变体类立刻红）。真机实测：浅色 `bg rgb(15,17,21)` / 白字，深色 `bg rgb(249,250,251)` /
  `rgb(35,35,36)`，hover 同一个 86% 浓度，菜单打开时内环 `rgb(216,74,74)`。

- **修掉「悬停操作列的主按钮时整个按钮全黑」**（2026-09-23，用户原话：「鼠标移动到操作列的 AI 审核
  按钮上时全黑，这是个 bug」）。根因不是色值，而是**选择器特异性 + 书写顺序**：基础 `.crwu-audit-btn`
  是 (0,1,0)，§20 迁移覆盖层把它写在样式表**最后**，于是同特异性的单类变体 `.crwu-audit-btn-primary`
  的 `background/color` 被它吃掉（主按钮退化成普通按钮），而变体那条 `:hover` 特异性更高、反倒生效 ——
  深底 + 深字，就是「全黑」。修法：变体一律改成**双类** `.crwu-audit-btn.crwu-audit-btn-primary`
  （(0,2,0)，不依赖顺序），hover 的选择器组里带上基础按钮的 `:hover:not(:disabled)`，并去掉 hover 里的
  `opacity: 1`（它会让**禁用**的主按钮悬停时看起来可点，禁用态只由 `:disabled` 的 0.45 表达）。
  顺带发现「确认重新审核」的 warn 变体也被同一条基础规则吃掉（与旁边的「取消」长得一模一样），
  按 §19 的中风险琥珀 token 恢复警示色；HEAD 遗留区那三条已被取代的变体规则删除。
  回归断言：`tests/unit/client-package.test.mjs` 的「按钮变体一律用双类选择器」（已证伪一次）。
  真机实测（浅色 + 临时切深色各一次）：IDLE `rgb(15,17,21)` / 白字，HOVER
  `color(srgb 0.0588 0.0667 0.0824 / 0.86)` / 白字；深色下 IDLE `rgb(249,250,251)` /
  `rgb(35,35,36)`，两套主题都是「底与字互为反转色」，禁用态悬停保持 `0.45`。

- **侧栏入口改成一张「分组卡」，三个模块变成它的三个子项**（用户口径：「报告评估、报告审核、
  环境信息是中瑞世联工作台的子模块，相当于一个小单元」「在左侧侧边栏直接看到这 3 个子项」
  「用 apple 风格的底色样式去修饰这些子项，让他们看起来是一个模块」）。做法：**仍然只占一个席位**
  （`sidebar.footer.action`），但内容由插件自绘 —— 一张浅底圆角卡，卡头是品牌标记 + 「中瑞世联工作台」
  + 版本标签，卡身是三行子项（图标 + 名字 + 「报告评估」带「开发中」角标），选中行是
  品牌蓝低浓度底 + 左侧 3px 蓝条 + 加粗。**面板底部的模块条随之撤掉**
  （`ModuleSwitcher.tsx` 删除）：两套导航会互相干扰，也白占正文高度。
  模块状态因此从面板的 `useState` 上移成 `apply()` 创建、同时下发给侧栏卡与面板的
  `module-store`（`active` / `autoEntered` / `selectEpoch` / `badge`）—— 各存一份的必然结果是
  「侧栏高亮报告审核、面板显示环境信息」；面板靠 `selectEpoch` 清掉上一次的自检拦截态，
  待办条数则由面板推给侧栏子项（撤掉模块条之后这个数不能在侧栏丢掉）。
  真机验收按几何断言「三行子项都落在同一张卡里、自上而下」（这就是「像一个模块」的判据）。
  设计与取舍见 `docs/PRD-workbench-sidebar-modules.md`（v1 已实施）。

- **分组卡按用户当面的三条反馈返工**（同日，真机截图后提出）：

  1. **卡头不再能选中**（原话：「中瑞世联工作台这个本身不应该能选中」）。卡头从 `<button>` 改成纯标题
     `<div>`：没有 `onClick`、没有 `cursor:pointer`、也删掉了那条 `:hover` 底色。打开面板只靠子项 ——
     点当前子项同样能进（store 会推进 `selectEpoch`，面板据此重置门禁）。
  2. **环境标记只留「环境信息」那一行**（原话：「右侧的绿色对勾去了吧，应该在环境信息那栏加个环境
     可以正常工作的标志」）。原先除了「报告评估」之外两行都画，挂在「报告审核」后面会被读成
     「那条审核通过了」；现在整页只有一枚，且长在环境那一行里（悬停文案顺带给出结论）。
  3. **悬停底色与选中底色分开**（原话：「选中时我用鼠标选中其他的子项时，和它激活的背景色一样，
     体验不好」）。根因是选中行用了 `bg-layer-1`：那在浅色主题下就是卡片自己的白底，于是「选中」
     看起来是无底色，而悬停那层 `interactive-bg-hover` 反而更像选中。改成悬停 = 一层中性极浅底、
     选中 = 品牌蓝低浓度底（`color-mix` 调浓度）+ 蓝条 + 加粗，**色相就不同**；并显式钉住
     `.crwu-audit-module-on:hover`，悬停自己那条选中行不会被降级。
     两条都是 `color-mix` 与 `-on:hover` 这种会被人「顺手简化掉」的写法，各有一条单测盯着。

- **卡激活不再整块换底色**（同一条反馈里的「它的背景色不好看」）。面板开着时原先给整张卡铺
  `sidebar-nav-item-active`，在侧栏里就是一块突兀的灰蓝色块；现在只把描边从 `border-l1` 压实到
  `border-l2`，「我在哪一页」由卡身那条选中行承担。

- **环境标记重新设计成「实心圆徽标」**（用户 2026-09-22：「环境信息检测通过的标记与否还是可以再
  设计一下，现在并不好看」→ 选定 iOS 设置风）。先前是一枚**裸勾 / 裸点**浮在行尾：没有容器，
  15px 细描边图形在 13px 文字旁边显得又飘又小。现在是一枚 16px 圆徽标，
  **四种结论各有形状**，不只靠颜色：

  | 结论 | 画法 |
  |---|---|
  | 通过 | 实心绿圆（`state-success-primary`）+ 白勾 |
  | 不通过 | 实心红圆（`state-error-primary`）+ 白叹号 |
  | 自检中 | 实心琥珀圆（`state-warn-primary`）+ 一段旋转白弧（纯 CSS `::after`，用已有的 `crwu-audit-spin`） |
  | 尚未自检 | 空心圈（不填色、不给结论） |

  两处细节：字形是**加粗版**（`BadgeCheckIcon` / `BadgeWarnIcon`，3px 描边、不带外圈）——
  线性图标那套 1.6px 描边缩到 12px 只剩 0.7px，压在实心色块上会糊成灰边，
  而 `WarnIcon` 自带一圈描边圆，放进实心圆里就成「圆中圆」；
  字形颜色用 **static 白**而不是 alias —— alias 的 `label-primary-inverted` / `-foreground`
  在深色主题下会翻成深色，压在实心色块上就看不清了，而色块上的字形必须恒为白。

- **「报告评估」占位页去掉全部说明文字，整页只写「开发中」**（用户 2026-09-22：「该页面整体写
  一个开发中就可以了」）。先前那版是虚线卡片 + 标题 + 一句说明 + 「开发中」角标 + 三条计划事项；
  在一个明确不可用的页面上堆信息，反而容易让人以为这里已经能用了。正文因此只剩「开发中」四个字，
  随之删掉 `evalTitle` / `evalText` / `evalPlan` 三段文案与 5 个占位页专属类名。
  起初只剩"一行灰字飘在空白正中间"，用户又说「它的页面也重写下，太难看了」，
  于是把那四个字做成**一枚有分量的灰色圆角标签**（14px / padding 8×18 / 圆角 12 / 浅中性底），
  居中摆放：既没有多余信息，也不是一行孤零零的灰字。

- **侧栏分组卡两处按用户口径收窄**：

  1. **「报告审核」旁边不再标报告数**（原话：「报告审核边上不需要标具体的报告数」）。那个数字
     是撤掉面板底部模块条时搬过去的（`module-store` 的 `badge` 字段 + 面板每次渲染推一次计数），
     既然侧栏不显示，就**整条链路一起删掉**，不留一份没人读的状态。
  2. **「报告评估」旁边的「开发中」角标改成一枚灰色小 tag**（原话先是要小 svg：「报告评估处于
     开发中边上加一个小 svg」，中间做过一版 13px 沙漏图标 + `moduleDevMark` 类；用户看过之后
     又改回文字标签：「那个 svg 不要了，太难看了，加一个灰色的小 tag【开发中】」）。
     定稿是 `moduleTag`：10px / line-height 16 / 圆角 6，`caption` 灰 + 一层极浅中性底
     （`interactive-bg-hover`，深浅主题都成立），没有描边、没有状态色、不带图标。
     `modules.ts` 的 `moduleTag()` 仍改成语义更准的 `isUnderDevelopment()`。

- **修掉「选中自己的会话之后，工作台还高亮着上一次那个子项」**（用户 2026-09-22 报的 bug）。
  根因：卡身那三行的选中态只看 `module-store` 里的"当前模块"，**没看工作台面板是不是还在前台**
  —— 面板被会话顶掉之后，那个高亮仍然留在侧栏里，看起来像工作台还开着。
  口径改成：**选中 = 工作台面板正开着（`usePanelInfo` 说当前主面板是它）+ 这就是当前模块**；
  面板切走就整块收起高亮，记忆仍留在 store 里（点回来还是原来那一页，并且重新亮起）。
  面板开着时的卡描边也走同一个判据。

- **背景水印试过一版又撤掉**（同日）。用户先说「子页面的背景都应该有一个特别大的中瑞世联 svg 背景，
  颜色浅点」，做完（单色标记 + 5% 不透明 + 贴底居中 + 下面一行「中瑞世联」字样）之后
  用户决定不要：「算了不要背景色这个标记了」。代码、样式、`BrandMark` 的 `tint` 开关与
  `brandName` 文案一并删除，验收脚本改钉「页面背景不再画水印」。

- **品牌标记改成矢量版（用户给的原图）**：新增 `BrandMark`，把原图 122x124 的四个色块描成四个多边形
  （品牌红 `#b50120` x3 + 品牌金 `#cf9950` x1，视框 101x104）。做法是把非白像素按行做颜色分段，
  逐块量出边界，再用同一套分段算法逐像素比对重建结果：**没有一个不一致像素离多边形边超过 2px**
  （全部落在抗锯齿过渡带上）。它替掉了侧栏入口那个通用文档图标，面板头部也放了一枚 —— 同一个图形、
  跟着主题缩放，不需要任何资源文件（客户端产物是单文件，没有资源加载器）。原 `PanelIcon` 随之删除。

- **入口与标题旁的小标签：dev 模式还是具体版本**（用户口径）。宿主新增两个模块加载时常量
  `PLUGIN_VERSION`（与 `package.json` 一致，测试盯着）与 `HOST_BUILD_KIND`（判据：包根旁边有没有 `src/`
  —— 发布包的 `files` 不带 `src/`，源码检出一律有），`ping` / `boot` 都回这两个字段。界面把这枚标签
  放在「中瑞世联工作台」后面：`dev`（琥珀色，悬停说明这是源码检出、改完要重新 build）或 `v0.0.4`
  （中性灰，悬停给形态与构建时间）。旧宿主不给这两个字段时退回 `rev` 去掉 `pkg-` 前缀，再没有才显示
  「未知」—— 任何情况下都不留空标签。

- **一处修进骨架的重构**：`boot` 从面板自己的 `useState` 挪进共享的 `build-store`（与 `envStatus` 同一套
  写法）。侧栏入口与面板头部要显示同一枚标签、面板还要拿 `boot.protocol` 做协议门禁，各自 `boot()` 会打两次
  请求，还会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。协议号 5 → 6（跨进程应答多了字段）。

- **统一的「正在自检环境」等待页**（用户 2026-09-22：「我点到中瑞世联工作台的时候都会进行一轮环境检测，
  这个是合理的，但是需要一个统一的 loading 页面，这个需要你设计一下，否则很不统一，这个注意有个好看的
  svg」）。先前第一次进来渲染的是**环境信息页的半成品**（页头 + 各层占位 + 一行灰字），看着像"页面缺了
  一块"；现在自检没出结论之前，整块正文只放这一页（新增 `features/workbench/LoadingPane.tsx`）：

  1. **一枚会依次亮起来的品牌标记**（76px）—— 四个色块按 `crwu-audit-brand-wave` 顺序呼吸，
     整体再叠一层极轻微的 `crwu-audit-breathe`。用品牌图形当加载符号，比通用转圈更有归属感，
     也不用额外图形资产（客户端产物是单文件，没有资源加载器）；
  2. 主文案「正在自检环境」+ 一句说明（正在检查工具、登录态、上传配置与外部数据，通过后会自动继续）——
     刻意不提任何模块名，免得结论还没出来就先谈"在哪一页"；
  3. 底部一条限宽的不确定进度条，让"还在动"有连续的视觉证据。

  另有一条 `@media (prefers-reduced-motion: reduce)` 让路：系统开了"减少动态效果"就关掉动画，
  页面结构与文案不受影响。判定条件是 `env === null && !hostStale && snapshot.error === ''` ——
  **宿主是旧构建**（要看到"请重启 profile"那句话）与**请求已失败**（要看到真实原因）都不显示等待页，
  转圈会把这两种情况藏起来。

- **面板头部右侧那句问候：「晚上好，某某某」**（用户 2026-09-22：「该工作台的上面右侧部分永远都有一个
  下午好/中午好，谁谁谁，这个谁谁谁是用钉钉 cli 请求的个人信息」）。姓名来自钉钉 CLI
  （`dws contact user get-self --format json` → `result[0].orgEmployeeModel.orgUserName`），
  客户端按**本地时钟**拼成 `凌晨好/早上好/上午好/中午好/下午好/晚上好，姓名`。
  三条口径：① **未授权就不去读钥匙串**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信）；
  ② **拿不到姓名就整句不展示**（用户原话：「如果钉钉 cli 没有登录信息，那就什么也不展示」）——
  不显示「晚上好，」这种半句，也不编造「同事」之类的占位；③ 宿主侧**只缓存成功结果**（姓名在一次登录
  周期里不变），失败不缓存，员工登录后刷一下就有，不用重启。
  同时**把头部那三个模块名（报告评估 / 报告审核 / 环境信息）去掉**（用户同批要求）：「我在哪一页」由
  侧栏分组卡的高亮说了算，头部右侧这一格留给问候。

- **「我是谁」跟着环境自检一起取，而且自检一次就够**（用户 2026-09-22：「这个钉钉 cli 环境监测一遍
  就可以了，不需要每次切换页面都去调，本质就是从环境信息把这个人的信息拿到」）。第一版把它做成第 26 个
  独立操作 `whoami`，每开一次面板就问一次宿主 —— 与用户的口径不符，已改成：
  `env` 自检在钉钉登录态那条链路上顺手取回姓名，塞进应答的 `me: { name, org, userId }`；
  独立操作与它的门面方法、协议声明、单测一并删除。另外**面板重新挂载不再重跑自检**：
  挂载 effect 只在「还没有结论」时补一次（`env === null && !busy`），关掉面板再打开（切会话、切模块）
  复用的是同一份结论 —— 要重跑仍然有页面上的「重新自检」按钮与登录 / 授权成功后的显式刷新。
  协议号 6 → 7（`env` 应答多了 `me` 字段）。- **品牌标记改成矢量版（用户给的原图）**：新增 `BrandMark`，把原图 122x124 的四个色块描成四个多边形
  （品牌红 `#b50120` x3 + 品牌金 `#cf9950` x1，视框 101x104）。做法是把非白像素按行做颜色分段，
  逐块量出边界，再用同一套分段算法逐像素比对重建结果：**没有一个不一致像素离多边形边超过 2px**
  （全部落在抗锯齿过渡带上）。它替掉了侧栏入口那个通用文档图标，面板头部也放了一枚 —— 同一个图形、
  跟着主题缩放，不需要任何资源文件（客户端产物是单文件，没有资源加载器）。原 `PanelIcon` 随之删除。

- **入口与标题旁的小标签：dev 模式还是具体版本**（用户口径）。宿主新增两个模块加载时常量
  `PLUGIN_VERSION`（与 `package.json` 一致，测试盯着）与 `HOST_BUILD_KIND`（判据：包根旁边有没有 `src/`
  —— 发布包的 `files` 不带 `src/`，源码检出一律有），`ping` / `boot` 都回这两个字段。界面把这枚标签
  放在「中瑞世联工作台」后面：`dev`（琥珀色，悬停说明这是源码检出、改完要重新 build）或 `v0.0.4`
  （中性灰，悬停给形态与构建时间）。旧宿主不给这两个字段时退回 `rev` 去掉 `pkg-` 前缀，再没有才显示
  「未知」—— 任何情况下都不留空标签。

- **一处修进骨架的重构**：`boot` 从面板自己的 `useState` 挪进共享的 `build-store`（与 `envStatus` 同一套
  写法）。侧栏入口与面板头部要显示同一枚标签、面板还要拿 `boot.protocol` 做协议门禁，各自 `boot()` 会打两次
  请求，还会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。协议号 5 → 6（跨进程应答多了字段）。

- **面板头部右侧那句问候：「晚上好，某某某」**（用户 2026-09-22：「该工作台的上面右侧部分永远都有一个
  下午好/中午好，谁谁谁，这个谁谁谁是用钉钉 cli 请求的个人信息」）。新增第 26 个 Host 操作 `whoami`：
  `dws contact user get-self --format json` → `result[0].orgEmployeeModel.orgUserName`（姓名）+
  `orgName`（公司）+ `userId`；客户端按**本地时钟**把它拼成 `凌晨好/早上好/上午好/中午好/下午好/晚上好，姓名`。
  三条口径：① **未授权就不去读钥匙串**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信），直接回空姓名；
  ② **拿不到姓名就整句不展示**（用户原话：「如果钉钉 cli 没有登录信息，那就什么也不展示」）——
  不显示「下午好，」这种半句，也不编造「同事」之类的占位；③ 宿主侧**只缓存成功结果**（姓名在一次登录周期里
  不变），失败不缓存，用户登录后刷一下页面就有，不用重启。
  同时**把头部那三个模块名（报告评估 / 报告审核 / 环境信息）去掉**（用户同批要求）：「我在哪一页」由侧栏
  分组卡的高亮说了算，头部右侧这一格留给问候。协议号 6 → 7（多了一个客户端会调用的操作）。

- **收起侧栏后不再画环境标记**（用户 2026-09-22：「左侧栏收起来的时候不应展示绿色的标记」）。
  折叠成 56px 轨道时那颗按钮只留品牌标记 —— 环境徽标（通过 = 一枚常亮的实心绿勾）一并收掉：轨道里
  既没有「环境信息」这行字、也没有卡头，那枚绿勾读不出结论，只是噪音。口径是问过用户定的（三选一，
  另两个候选是「只在『不通过』时留红徽标」与「只藏绿徽标」），用户选了最干净的那个。结论不丢：
  轨道按钮的 `title` 里仍然写着「环境信息：已通过 / 未通过 / 自检中 / 尚未自检」，展开态卡身上
  「环境信息」那一行照旧画徽标。单测钉住「折叠轨道整棵树里没有 `crwu-audit-side-entry-mark`」以及
  「留下的那枚图形必须是品牌标记（`viewBox` = `0 0 101 104`）」，真机断言点一次 DSH 自带的
  「收起侧边栏」、量完再展开还原。

- **报告审核页收成「一个大圆角框」+ 点小鲸鱼用 crwu 拉数据后跳原生会话**（用户 2026-09-22 两轮口径）。
  第一轮做了「大圆角框 + 左数据 / 右自绘 AI 讨论面板」，随后用户改口径：**右侧自绘对话框撤掉**
  （"只会增加负担"），但"crwu 的数据拉取需要做"。最终形态：
  ① 正文**只有一层**大圆角框（`.crwu-audit-surface`），卡片不再各自带描边，靠发丝线 + 留白分格；
  页签按用户口径改名 **报告列表 / AI 审核列表**（当时是下划线式；2026-09-23 那轮已改成 Segmented 白片，
  见本文件 0.0.4 顶部）；
  ② 操作列**最后面**一枚 DeepSeek 图标（**用户直接给的官方 SVG**，`viewBox 0 0 23.16 17.04`），
  悬停文案「与Deepseek一起讨论这份报告」；
  ③ 点它先用 crwu **拉一次这份报告的全部文件元数据**（新增第 26 个 Host 操作 `report-files`：
  `crwu h3yun files list --schema <code> --id <ObjectId>` 拿氚云附件元数据 —— 这是用户让我
  "看下 skills 里 crwu 是怎么查这些文件的"得到的答案 —— 加本地案例目录与云端交付件；
  **只列举、不下载**，正文由 AI 在会话里按需取）；查询期间**整块正文**盖中瑞世联等待页；
  ④ 拉完分流：**有绑定会话** → 贴点击处弹气泡问「新建对话 / 继续上次聊天」；
  **没有** → 直接建新会话 + 注入上下文（角色 + 报告事实 + 三组文件）并跳到那条**原生**会话。
  多会话用 `报告讨论 · <流水号>` / `… #2` 命名；前缀匹配排除了"另一个流水号恰是自己的前缀"。

- **为什么对话不自绘**（对照安装的 DSH 逐个核实）：`main` 槽位只有保留键 `conversation` 有会话绑定；
  客户端产物只能 `require('react')`（装不进 `ui-chat`）；右栏只有资源标签页、没有对话类型；
  真机探针实测登记回调拿到的标准 props 是
  `usePanelInfo|useSessions|useSessionPendingInteraction|useWorkspaces|useResource`（**没有 `renderSlot`**）。

- **测试与验收同步**：新增品牌图形（四个多边形 / 三红一金 / 比例 / 无障碍）、`buildTagOf` 三分支、
  build store 并发去重、`hostBuildKindOf` 真目录判据（带 `src/` = dev、不带 = installed）、
  入口在名字后标 dev / 版本、dev 形态不假装成版本号、分组卡结构（卡头是纯标题 / 只有环境那一行带标记 /
  悬停与选中的底色必须分得开 / 环境徽标是实心圆且四态各有形状）等用例；
  `npm run check` 全绿（466 个单测）。

## package · 0.0.3 · 2026-09-22

- **工作台整体重做（办公风 + Apple 视觉，用户口径）**。界面语言换成一套统一的
  「卡片靠 1px 描边 + `--dsw-shadow-lv1` 分层、圆角交给 DSH 全局的 `corner-shape: superellipse`
  （连续曲率，就是 Apple 那种圆角）、字体跟随 `--dsw-font-family`、状态色只出现在圆点/胶囊/左侧细边」
  的规范；动效只过渡 background / color / box-shadow，时长 120~160ms，不动布局属性。
  报告审核页与环境信息页全部按这套重绘：分段控件（选中段浮起）、卡片、徽章、按钮、表格行悬停、
  抽屉、授权弹框、加载进度条，连同表格列宽与「窄列不换行」那些既有硬规则一起保留。

- **入口搬到左侧栏底部、设置上方（`sidebar.footer.action`）**。工作区（会话列表）仍在它上方；
  顶部那枚 `sidebar.panellist` 图标入口**撤掉**，会话头那颗环境指示灯也**撤掉**
  （`EnvironmentStatusIcon` 组件随之删除）—— 同一件事只留一个常驻入口。入口右端常驻环境标记：
  **通过 = 绿色对勾**、不通过 = 红点、自检中 = 黄点、未自检 = 灰点，悬停给出完整结论；
  折叠成 56px 轨道时只留图标。跳转动作在点击时现读 `services.layout`（沿用「可选服务不许快照」那条纪律）。

- **三个模块 + 底部常驻模块条**。`报告评估`（置灰占位，标「开发中」，点开是说明性占位页，**
  后面由用户自己开发**）/ `报告审核`（原报告页）/ `环境信息`（原环境自检页）三段固定顺序，
  切换条常驻在面板底部，正文滚到哪都点得到。为此面板骨架改成
  「固定头部 + 可滚正文（`.crwu-audit-body`）+ 常驻底部」，滚动仍归面板自己所有。
  门禁口径不变：**自检通过就直接进报告审核**，不通过停在环境信息；报告审核段被挡住时给出
  说明 + 「重新自检」+ 「去环境信息」。

- **测试与验收同步**：槽位断言从 5 条注册（含会话头指示灯）改为 4 条；新增「旧入口与指示灯
  都不再注册」「侧栏底部入口 + 绿勾/红点」「底部模块条双向切换」「报告评估占位页」等用例；
  `install/browser-check.mjs` 改成按**几何位置**断言入口在左列下半屏、按秒表断言模块条在正文下方，
  并新增侧栏入口环境标记与占位页的核对。`npm run check` 全绿（454 个单测）。

## package · 0.0.2 · 2026-09-21

- **修「随包技能一个都没加载」**（2026-09-22 实测）：`cordis.patch.yml` 的技能根原来写成
  `new URL('skills/', baseUrl)`，但 bundle patch 里的 `baseUrl` 锚的是 **profile 目录**（profile 整棵树
  是「补丁层挂在 profile 空根配置上」），于是指向了不存在的 `<profile>/skills/` —— provider 装配成功
  却静默贡献 0 个技能（启动日志无任何报错）。改为按包名解析
  （`createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')`），并把
  `providerName` 统一为 `crwu-workbench`；新增 `tests/unit/host-skills-patch.test.mjs`（造 profile 形态
  的临时目录**真的求值一次**补丁里的表达式，改回旧写法立刻变红）。顺带修掉折叠标量漏分号的
  `SyntaxError` 隐患。

- **一份 YAML 覆盖开发、打包与员工运行**：新增 `config/crwu-workbench.yml`，明确区分匿名只读的
  `crwu-only-workspace`（环境清单、安装说明、插件 TGZ）与私有的 `crwu-workspace`（审核产物）。
  源码开发直接读取 YAML；TGZ 原样携带同一文件，安装后 Host 自动读取包内副本。
- **分发也只认这份 YAML**：`make plugin-dist` 不再从 Makefile 的 `OSS_BUCKET` / `OSS_PREFIX`
  拼地址，而是从 `oss.readonly` 计算 `oss://` 上传目标与员工 HTTPS 安装地址。
- **部署配置真正生效**：私有 OSS 的 bucket、endpoint、prefix、签名模式、TTL 与自动上传策略覆盖
  远程环境清单；插件激活时立即用 YAML 初始化运行清单，不再依赖页面先调用 `env`；RPC 不再允许
  临时替换清单地址，远程清单的 `probeCommand` 也不会进入宿主 Shell。
- **收紧手工重传边界**：`oss-upload` 只接受 Host 审核注册表里的 key，不再接受调用方传入任意
  `casePath` / `projectId`；检索后的翻页与刷新会保留当前查询条件。
- **并发配置去伪存真**：页面与 Host 继续强制同一时间只运行一条审核，删除没有任何运行时作用的
  `audit.singleAuditOnly` YAML 字段，避免部署者误以为它可以关闭门禁。
- **发布门禁**：新增 YAML Schema/地址边界测试、`config:check`、TGZ 必含配置断言，以及真实
  `npm pack` → `npm install` → 从包内 YAML 激活 Host 的回归测试。

- **权限：员工零启动参数，但首次必须授权一次**（2026-09-22 用户口径）。环境自检把「授权读取本机凭据
  （氚云 / 钉钉）」当**硬前置**：没授权就是阻塞项（插件不可用），并且**不再**谎报「钉钉没登录」——
  没授权时干脆不去猜（沙箱里读钥匙串只会得到假的未登录）。授权不是 ③ 层里一个可以被忽略的勾选框，
  而是**插件级门槛**：未授权时用一个弹框挡住整块面板（「同意并继续」/「拒绝」→ 拒绝屏 + 「再次授权」），
  一次授权**长期有效**（写进 `~/.dsh/crwu-workbench.json` 的 `trustCredentials`，重启 profile 后仍在，
  由环境自检启动时读回）。授权后：读本机凭据的命令（`crwu h3yun session login|records|forms|…`、
  `dws auth status|login`）声明 `sandboxPolicy` 去拿真结论；其余命令保持默认沙箱（最小权限）。
  `trust` 的线协议字段由 `h3yun` 改为 `credentials`（协议号 3 → 4），旧客户端的 `h3yun` 字段仍接受。

- **按流水号查云端交付件**（2026-09-22 用户要求）。工具条长在**「AI审核结果」这一页自己的卡片里**
  （用户纠正过位置：不许浮在两个标签之上，「待审核报告」页也不许有）。输入 → 点「查找」→ 只列
  `oss.protected.auditPrefix` 下这一个流水号那一层；**输入过程不发任何请求**（防抖自动查会变成反复扫
  OSS），一次「查找」**只发一次列举**；形状不对就地拦下、Host 侧再校验一次（安全边界）。命中说清
  「正在看：流水号 X 的交付件」，没命中说「OSS 上没有这个流水号的交付件」（是结论不是错误，也不回退
  去猜别的流水号），点「清空」回到全量且**不重新列举**。卡片右上角的计数跟着**正在显示的那一份**走
  （先前的「空列表 + N 项」自相矛盾读数已修），线协议操作 `oss-index` 增加可选 `seqNo`（协议号 4 → 5）。

- **真浏览器验收扩到 76 条**：新增/改写「查找框在「AI审核结果」卡片里面」「输入不列举 OSS」「命中/没命中
  各只发一次列举」「清空回到全量且不重新列举」，以及授权弹框（未授权挡住整页 + 两个明确动作）与
  AK 表单形状（只有 ID / Secret 两个输入框，不再要 STS Token 与 endpoint）。先前三条**过期断言**一并
  修正：授权开关已改成弹框、AK 表单已按用户要求去掉两个字段、「命中用例」原先误把刚输入的假流水号
  当成真流水号去查（正则会匹配到状态行里的那个号）。

## package · 0.0.1 · 2026-09-20（首个 npm 发布）

**版本号定为 `0.0.1`**：此前 `0.1.1` / `0.1.2` 两个编号**从未发布过**，首个 npm 发布用最小
版本号；下面那两节保留为同一批工作的过程记录（不表示存在过 0.1.x 的发布）。
`ping.rev` 跟着变成 `pkg-0.0.1`。

首个发布里有什么：

- **包形态**：`src/` 是唯一源码，tsdown 分构建 `lib/index.js`（ESM，导出 `name` / `inject` /
  `apply` / `Config`）与 `lib/client.js`（`__ModuleLoader__.load({ id })`，只 require `react` 与
  `react/jsx-runtime`）；`lib/` 不入库，由 `prepare.mjs` / `prepack` 产出。
- **25 条同源操作**（冻结清单）：`ping` / `boot` / `workspace` / `workspace-auto` / `trust` /
  `bind-session` / `install-prompt` / `env` / `pending` / `crwu` / `audit-start` / `audit-stop` /
  `audit-status` / `audit-release` / `oss-index` / `oss-result` / `oss-link` / `oss-upload` /
  `oss-cred-save` / `open-path` / `clipboard` / `relogin` / `dws-login` / `session` / `oss-cred`。
- **审核子代理一律挂在审核根会话下**：`host/audit/root.ts` 在 ① 选定的工作空间里建一个顶层会话
  `审核子代理根节点 · MM-DD HH:mm`（`meta.cwd` = 工作空间、**不带** `parentAgent`、
  `workspace.attachSession`），建完跑一次 hello 预检，不通过就不落钩子、不起审核；根可用就一直
  复用，不可用才新建（旧树保留）。
- **`WORKBENCH_PROTOCOL`**：宿主产物只有重启 profile 才换、客户端刷新页面就换；协议号对不上时
  界面明确说「宿主插件是旧构建，请重启 web profile」并拦住派发。
- **① 案例根目录三条硬规则**：整份持久化（path / title / id / source）、选过的目录不在了**报错
  而不静默回落**清单偏好、绝不采用父会话 cwd；配置读失败时放弃本次写入。
- **界面**：右上角环境指示灯（绿=就绪 / 红=未通过 + 悬停文案）、自检通过直接进报告审核、
  不通过用 loading 拦住；报告表固定列宽 + 风险等级列 + 窄列不换行；「审核信息」右侧抽屉；
  翻页与重新自检的加载态。
- **「查看会话」的两个根因**：可选客户端服务改为现读（不再在 `apply()` 里快照）、目标改为
  「被点那一行」的 key；另加 `uiWorkspace.openSession` 兜底路径，两条都缺才说「服务不可用」。
- **删掉「只释放占用（不停子会话）」按钮**（用户要求）：它会解开占用锁而子会话继续跑，正是
  「两条子会话往同一个案例目录对写」那条闸门要拦的状态；宿主侧 `audit-release` 保留为 host-only。
- **交付与门禁**：`install/browser-check.mjs`（47 条真实浏览器断言，且全程不点「AI 审核」）、
  `scripts/`（prepare / assert-pack / smoke-built / sync-version）、CI（Ubuntu + Windows ×
  Node 22/24）、`v*` tag → npm 发布工作流（`--provenance`）、LICENSE / SECURITY.md /
  README.en.md / `package-lock.json`。
- **文档**：`AGENTS.md` 补 §4.4.1 样式规范（CSS）与 §7.10~§7.13（审核根会话、工作空间三条硬规则、
  协议号、「查看会话」三条硬规则）；`PORTING.md` 记录 25 个操作的验证账。

发布前补进来的（2026-09-20 深夜那几轮，都在同一天）：

- **修「查看报告」打不开**：待审核报告那一行把**流水号**当成 OSS 对象 key 交给 `oss-link`
  （被前缀隔离拒掉，`对象不在配置的 OSS 前缀内`）；改成取交付件的 `htmlKey`。另外 `ok:true`
  只代表签名成功，打开浏览器失败（`opened:false`）原来被静默吞掉 —— 新增
  `openReportNotice()` 把两种情况都说清楚。
- **审核指令补上钉钉两件回传**：`auditPrompt` 原来只有「案例目录 / 重审禁读旧产物 / OSS 上传」
  三段，从没提技能步骤 15（钉钉结果回传），子会话做完 OSS 那步就收尾了。现在显式写出
  ① 团队空间归档（技能脚本**绝对路径**、**只回传结果 JSON**、按 `auditTask.auditTime` 的
  年/月分开、时间戳必须带时区）与 ② 把 HTML 发到自己的单聊并**把那条消息转成 DING**
  （`ding message send-by-message --type app`，判据是真实 `openDingId`，一个案例只发一次）。
  这一层原来一条测试都没有，新增 `tests/unit/host-audit-prompt.test.mjs` 逐条钉住。
- **面板标题旁显示当前运行的宿主版本**（`pkg-0.0.1`，悬停看构建时间）：`boot` 现在带
  `rev`/`builtAt`，`WORKBENCH_PROTOCOL` 2 → 3。宿主与客户端分开加载，用户报问题时先看这个号
  就能分清「界面新、宿主旧」。
- **CI 修到四个 job 全绿**（原来只有 ubuntu/Node 24 绿）：① ubuntu/Node 22 上 npm 10 在
  `npm pack --json --ignore-scripts` 下仍会跑 `prepare`，构建日志混进 stdout 让 `JSON.parse`
  崩掉 → `prepare.mjs` 日志改走 stderr + `assert-pack.mjs` 定位 JSON；② Windows 上
  `execFile('npm')` 起不来（npm 是 `.cmd`）→ 新增 `scripts/exec.mjs` 用当前 node 跑 npm 的
  JS 入口；③ Windows 的 `tar` 是 GNU tar，把 `C:\…` 当 `host:path` 解析
  （`Cannot connect to C: resolve failed`）→ 解包改用相对路径；④ TSX 加载器用
  `new URL(url).pathname` 当路径，Windows 上是 `/C:/…` → 改用 `fileURLToPath`。
  测试失败现在会写成 check-run 注解（job log 的 REST 接口要仓库 admin 权限，读不到）。

同一个 0.0.1 版本内继续合并仓库（2026-09-21，源仓并入 `crwu-ai/plugins/dsh-crwu-workbench/`）：

- **分发纪律：同一个版本号只发一次**（用户 2026-09-21 要求）。新增 `scripts/dist-plugin.mjs` 作为
  `make plugin-dist` 的上传守卫：远端没有该对象 → 上传；已有且 MD5 一致 → 跳过（幂等）；已有但内容
  不同 → **拒绝上传**并提示升版本号；`ossutil stat` 读不出来 → 同样不动远端。判定表自检
  （`--self-test`）已接入 `make plugin-check` 与 CI。理由：URL 就是 `<包名>-<版本>.tgz`，同版本重发
  会让早装与重装的员工拿到同一版本号下的两份内容（且 `dsh plugin add` 未必真替换 —— pnpm 见 spec
  未变会跳过，实测过）。
- **名字统一成一个 `dsh-crwu-workbench`**：目录名、npm 包名、`cordis.patch.yml` 的行 `name:`、
  tarball 文件名、员工侧 `dsh.profile.bundles` 条目全部同名（此前目录叫 `dsh-crwu-audit-workbench`，
  「目录一个名、安装另一个名」的写法已废弃）。员工侧安装命令与 OSS 上的路径**不变**。

- **技能随包发布**：本包现在的交付物不止 `lib/`，还有 `skills/`（插件专属 27 个）与
  `common/skills/`（公共技能：`crwu-dws` / `crwu-h3yun-*`）。`cordis.patch.yml` 新增
  `crwu-workbench-skills` 行（`@deepseek-ai/dsh-skill-filesystem`，独立 `providerName:
  crwu-audit-workbench`、`includeDefaultRoots: false`），把两个目录注册成技能根 —— 员工
  `dsh plugin add` 装完即得全部技能，不再靠 skills-manager 往 `~/.dsh/skills/` 里拷。
  公共技能在打包前由 `scripts/sync-common-skills.mjs` 从源仓 `plugins/common/skills/` 拷进来
  （npm 的 `files` 出不了包目录；`--check` 逐文件比内容，杜绝「改了公共技能忘了同步」）。
- **审核指令不再写死用户级技能路径**：`src/host/audit/skill-paths.ts` 从**正在运行的这份代码**
  推导包内 `skills/` 绝对路径（开发机 = 仓库、员工 = profile 的 `node_modules/`），
  `auditPrompt` 里的钉钉回传脚本路径随之改为包内绝对路径。
- **修 `crwu-h3yun-query` 的 frontmatter**：描述块有一行没缩进，YAML 解析失败 →
  `dsh-skill-filesystem` 静默忽略该技能（实测技能目录 30 个只发现 29 个，用户目录里也一样）。
  修好后 30/30 全部可发现、零警告。
- **门禁覆盖不因布局变化而消失**：三个源仓契约测试与 `check_audit_skill_mappings.py` 原先按
  `skills/` 单根推导路径，技能拆到两个根后它们会**静默 skip**（实测流失 7 + 8 + 12 条断言）；
  现在按两个根解析同级技能，`--repo-root` 改为向上找 `go.mod` + `Makefile`，覆盖率恢复到
  66 / 21 / 12 全跑。
- **CI/发布工作流随仓库移动**：`.github/workflows/` 移到仓根，插件 job 用
  `working-directory: plugins/dsh-crwu-workbench`，并新增 Go job（`go build` + `go test`）
  与技能自洽性 lint；发布 tag 前缀改为 `plugin-v*`（CLI 将来用 `v*`，两条发布线分开）。
- **打包入口**：仓根 `Makefile` 增 `plugin-deps` / `plugin-skills` / `plugin-check` /
  `plugin-pack`（→ `dist/dsh-crwu-workbench-<ver>.tgz`）/ `plugin-dist`（`ossutil` 上传并打印
  员工安装命令）/ `skills-install AGENT_DIR=…`（非 DSH 宿主按目录布局拷全部技能，替代已废弃的
  `crwu-init`）。

## package · 0.1.2 · 2026-09-20（未发布）

**收尾完成：`legacy/` 已删除，`src/` 成为唯一源码**（第 32 轮，用户明确要求后执行）：

- 删掉动态 Cordis 形态及其配套件：`legacy/`（`host.js` / `client.js` / `REV`）、
  `install/verify.mjs` + `verify.sh`、`install/rev.mjs`、5 个 `tests/legacy-*.test.mjs`、
  `tests/helpers/legacy-client-renderer.mjs`，以及随形态一起退休的
  `tests/unit/port-coverage.test.mjs` 与 `tests/unit/verify-rules.test.mjs`。
- `package.json`：去掉 `rev:bump` / `rev:check`，`check` 收窄为
  `version:check + typecheck + test + build + smoke:built`；CI 同步删除两步 legacy 校验。
- **4 处测试原本会因为读不到 `legacy/` 而断**，各自换成不依赖 legacy 的锚点：
  安装提示词从「与 legacy 逐字比对」改为**逐条钉住 10 条规则**；
  「实现了每个 legacy handler」改为**冻结的 25 条操作清单**；
  「客户端调用的 RPC 都已登记」改为用**活门面 `OPERATION_OF`** 反查并要求 `ported.todo` 为空；
  发布链路断言去掉 `rev:check`。
- 清掉把已删文件当作依据的注释（`src/host/{shell/run,audit/prompt,audit/summary,oss/parse}.ts`、
  `src/host/environment/install-prompt.ts`、`src/shared/utils/json.ts`、`AuditInfoDrawer.tsx` 等），
  保留「不要改写措辞」这类指令本身。
- 文档改为单形态：`README.md`（§一 形态表、§二 安装、§三 配置项、§四 命令与铁律、§七 目录）、
  `README.en.md`、`AGENTS.md`（§1 / §2 / §6 / §6.1 / §6.2 / §7 / §8）、
  `install/INSTALL-PROMPT.md`（原来整篇在教装动态插件，而那个路径已不存在）。
- **明确记录一条取舍**：`lib/` 产物**不能**当动态插件交（ESM 具名导出 / ModuleLoader 工厂，都不是
  沙箱函数体；注册方式、客户端传输、React 来源也都不同）。用户确认不补第二个构建目标 ——
  只维护一条形态。接缝与代价清单留在 `PORTING.md`。
- 收尾后复跑：**`npm run check` 退出码 0、354 条测试全过、`npm run pack:assert` PASS**。

**把 25 个操作按四层过了一遍账，并补上三个可安全真机验证的操作**：

- 账目：25/25 有单元测试、24/25 有界面入口（唯一例外 `ping`，与旧形态一致）、25/25 有类型化门面方法、
  **15/25 在真实 DSH 上实跑过**。清单与「剩下 10 个为什么不跑」写进 `PORTING.md`。
- 本轮新增真机验证：`oss-link`（对真实对象签名，校验 scheme/host/路径/签名参数，且**不回显 URL 本体**）、
  `audit-stop`（无进行中审核时明确拒绝）、`audit-release`（无占用时是空操作）。
- 仍未在真机跑过的那一个关键操作是 `audit-start` —— 用户明确保留这一下；它依赖的 `subagents.start`
  请求形状改由测试对照已安装的 DSH 类型声明钉死（`tests/unit/host-audit-spawn.test.mjs`）。

**收尾（删除 `legacy/`）已在仓库副本上演练通过，并补上 CI 漏掉的两道门禁**：

- **收尾演练**：把整仓 `rsync` 到 `/tmp` 的副本上真做了一遍删除 + 改造（`.git` / `node_modules` 除外），
  结果 **`npm run check` 退出码 0、354 条测试全过、`pack:assert` PASS**。演练发现的、光看代码想不到的点
  全部写进 `PORTING.md` 的「收尾计划」：14 个待删文件；**4 处测试会因为读不到 `legacy/` 而断**
  （安装提示词的「逐字对照」、两处 handler/RPC 对账、发布链路里的 `rev:check`），各自换成了不依赖 legacy 的
  锚点（逐条钉住提示词条款、冻结的 25 条操作清单、改用活门面 `OPERATION_OF` 反查并要求 `todo` 为空）；
  以及**门禁抓不到**的 `install/INSTALL-PROMPT.md` —— 它整篇还在教人装动态插件，
  删完 legacy 后引用的路径全不存在，没有任何测试会报。
- **CI 补上两道本地有、CI 没有的门禁**：`npm run version:check`（三处版本一致）与
  `npm run pack:assert`（真实 tarball 清单 + 加载契约）。此前它们只在本地 `check` 与发布前的
  `prepublishOnly` 里跑，PR 阶段挡不住 —— `AGENTS.md` §7 那句「本地漏跑会被 CI 挡住」对这两条并不成立。
  CI 现在的步骤序列写进了 `README.md` 的门禁表。

**客户端半在真实浏览器里验通了，验收清单只剩「真点一次审核」要人参与**：

- 新增 `install/browser-check.mjs`：用**真实浏览器**（系统里的 Edge，经 `playwright-core` 的
  channel，**不下载 Chromium**）打开装了插件的页面，点进面板逐页核对第 5 / 6 / 7a 条判据。
  此前这三条只能写「需人眼」—— `smoke:built` 的替身证明不了「面板真的画出来」。
  本机实测 **22 条全过、浏览器控制台零报错**：
  - 侧栏出现「中瑞世联工作台」，点进去面板渲染出标签；
  - 环境自检页画出真实平台、四个二进制（带真实路径与版本）、氚云 `正常` / 钉钉 `已登录`、iFinD `已配置`；
  - 待审核报告页画出真实待办（`共 8608 条`、真实流水号与项目名、复核级次、行内「已停止 / 已完成·已上云」
    徽章与「查看会话 / 审核信息 / 本机 HTML」入口）；
  - AI审核结果页画出 4 个真实云端案例与其 html + json 交付件；
  - 点开「审核信息」抽屉：渲染出真实摘要（项目编号 / 引擎版本 / 阶段 / 结论 / 问题总数 13 / 复核状态 / 命中率 /
    复核计数 / 生成时间），**不再报「审核结果不是合法 JSON」**；
  - **翻页时 `pending` 真的重取、`oss-index` 次数不变**；在「待审核报告 / AI审核结果」之间来回切 3 轮，
    **`oss-index` 持续为 1** —— 「切标签 / 翻页不重复列举 OSS」这条硬要求第一次在真实界面上被验证；
  - 全程只发出 `boot env install-prompt audit-status pending oss-index`，**没有 `audit-start`**。
- 该脚本**证伪过两次**：① 拿它跑一个**没装插件**的 profile → 报出唯一一条 FAIL（侧栏入口超时）、
  跳过依赖的后续阶段、退出码 1，而不是崩掉；② 把第 26 轮那个 JSON 修复**按原样还原**（`try JSON.parse`
  → 报「不是合法 JSON」）后重跑 → 抽屉那 4 条断言全红。也就是说这一步真的在盯那个缺陷，
  不是「跑起来就算过」。脚本末尾硬断言「没有发出 audit-start」，防止日后被改成会点审核。
- README 验证清单第 5 / 6 / 7a 条改为 ✅，并补上运行浏览器核对的完整命令；
  `PORTING.md`、`AGENTS.md` §7 同步（AGENTS 里原来写「哪两条只能人工验」，现在只剩第 7b 条）。

**npm 分发路径（正式分发那一半）也实测过，并修掉一个发布目标隐患**：

- **tarball 装进干净 profile 能被 DSH 正常加载**：`npm pack` → `dsh plugin --profile tgz add <tgz>`
  → 起 profile，得到的是**拷贝**而非符号链接、无 `src/`，`lib/*` 与仓库构建逐字一致；
  `ping` / `env` / `oss-result` 全部走通，客户端产物被登记进该 profile 的 web 启动清单并被原样服务；
  随包发布的 `scripts/prepare.mjs` 在无 `src/` 时按设计跳过。此前只验过 `link:` 安装，
  而那并不是用户拿到的形态。
- **发布目标钉死官方 registry**：本机 `~/.npmrc` 指向镜像时，手工 `npm publish` 会发到镜像上，
  而 `--provenance` 在镜像上不成立（一条命令踩两个坑）。现在 `publishConfig.registry` 显式写成
  `https://registry.npmjs.org`，并与 release workflow 的 `registry-url` 互相核对（测试会比对两者）。
  装依赖仍走本机镜像，不受影响。
- **`npm publish --dry-run` 现在能整条跑通**：它会让 `npm run check` 里的「真跑 `npm pack` +
  `npm install`」回归测试一起变成 dry-run，于是 `npm pack` 不产出 tarball、门禁因为与被测行为无关的
  原因变红。已在该测试里显式清掉继承来的 `npm_config_dry_run`（改回必红，已证伪）。
- **补上唯一不能真机实测那条调用链的测试**：`startChild`（发起审核子会话）过去**一条测试都没有** ——
  而它恰恰是真验证的盲区（真发一次就是在一个真实案例上跑真实审核）。新增 8 条断言，
  逐个字段对照已安装的 `@deepseek-ai/dsh-subagent` / `dsh-llm` 类型声明：
  `start(name, { label, prompt: [{type:'text',text}], parent, signal })`，其中
  **`handle.abort` 必须打在交给 DSH 的那个 signal 上**（停止 one-shot 审核靠它，打错控制器等于没取消）。
  除一条运行时与 `pickProvider` 重复、仅用于类型收窄的守卫外，其余断言均已逐条证伪。

**首次在真实 DSH 上装载验证，并修掉验证暴露的一处误报**（记录见 `README.md` 的验证清单）：

- 装进独立 `smoke` profile 后逐项实测：`ping` / `boot` / `env` / `pending` / `audit-status` 全部
  走通真实服务（真实平台识别、真实二进制路径、氚云会话正常、钉钉已登录、OSS AK 可列 bucket、
  真实待办 8608 条）；客户端产物被 DSH 登记进 web 启动清单并原样服务（与 `lib/client.js` 逐字一致）。
- **修掉「把执行失败说成未安装」的误报**：沙箱后端不可用时（本机 `sandbox-exec: sandbox_apply:
  Operation not permitted`）所有 shell 调用直接失败，旧实现丢弃了这个失败，于是环境自检对一台装好了
  Node / Python / dws 的机器报「未安装」，OSS 报「ossutil 未安装」—— 把人送去装已经装好的东西。
  现在分辨「命令根本没执行」（DSH 契约里 `run` 只为基础设施故障 reject）与「执行了但结果如此」：
  二进制报 `无法探测：<原因>`、服务报 `探测失败`、OSS 报 `无法探测`，`resolveOssutil` 改为返回
  `{ path, error }`，6 处调用点统一给出真实原因。新增 5 条测试，并逐条证伪过（改回旧行为必红）。
- **修掉「审核信息」在读真实对象时必失败**（拿真实 OSS 对象才验出来的存量缺陷，legacy 同样中招）：
  `ossutil` v1.7.19 会把 `<n>(s) elapsed` **无条件**写到 stdout，而代码对 `ossutil cat` 的输出直接
  `JSON.parse`，于是对每一个真实对象都报「审核结果不是合法 JSON」。新增 `src/shared/utils/json.ts`
  的 `parseJsonLoose`（先严格解析，失败再扫描第一个配对完整的 JSON 文档；正确处理字符串内的括号与
  转义，垃圾输入仍返回 null），并接到所有「解析命令行 stdout」的调用点（文件、HTTP body、状态文件
  仍然严格解析）。实测：真实对象 97KB → 摘要 2716 字节，`projectId` / `schemaVersion` / `counts`
  全部正确。新增 8 条测试并逐条证伪。
- 顺手修掉换用 `parseJsonLoose` 时引入的一处回归（**由已有测试抓出**）：它返回 null 而不抛错，
  而 `loadManifest` / `loadPending` / `discoverForm` 原来靠 `catch` 判失败 —— 不改就会把坏清单当成
  「已加载」、把坏取数显示成「0 条待办」。三处改为显式判空。
- README 补上「沙箱模式」这一节：包形态用 profile 的默认模式，受限模式没有后端时必须由**用户**
  按 DSH 的提示切到 `danger-full-access`；插件不会自己去申请无沙箱执行。

**包形态完成对 `legacy/` 的功能移植**（逐项收尾报告与已知差异见 `PORTING.md`）：

- **Host 操作 24/24 落地**：shell / fs / 平台识别 / 环境自检 / 清单 / 工作空间 / 氚云记录与待办 /
  OSS 凭据·列举·签名·自动上传 / 审核生命周期（发起·停止·状态·释放）/ 系统操作 / crwu 直通。
- **Client 半按四个槽位重写**：`sidebar.panellist`、`main`、`tool.view.cordis`、
  `conversation.session.header.utilities`（最后一个此前完全缺失，导致界面**没有任何入口登记审核父级**，
  `audit-start` 从界面永远失败）；拆成 `features/workbench`、`features/environment`、
  `features/report-audit` 三块，文案集中到 `src/client/locales/zh-CN.ts`。
- **修掉 8 个「操作名对得上、链路断掉」的缺口**（逐条见 `PORTING.md`）：`slots.inject` 被多包
  `ctx.effect`（激活即抛 `Invalid effect`）、**漏订阅 `subagent/end` 与 `agent/status`**
  （「已中断」永不出现、交付件自动上云整个不触发）、`audit-start` 少「必须已选定工作空间」的门禁
  （产物写进继承的 cwd，常常是源码仓库）、`workspace-auto` 只清内存不重新采用、
  `install-prompt` 文案是手写改写版（丢掉两条安全指令）等。
- **保留 legacy 的真实结论**：审核存活判据用子 Agent 自己的 `status === 'running'`（清单里有 ≠ 还活着）、
  停 one-shot 必须「先 abort 再 dispose」、占用锁要能自愈、同源越界只有 `stripPrefix` 一处。
- **有意差异 6 条**（不是遗漏）：内置案例根不做本机绝对路径兜底、Windows 命令引用按平台选引号、
  自动上传的「还没有交付件 / 目录不可读 / 未找到 ossutil」只返回原因不写 `uploadError`（legacy 会把
  「还没有东西可传」记成上传失败并挂「上云失败」徽章）等。
- **新增「搬完了」的机器判据** `tests/unit/port-coverage.test.mjs`：legacy 每个组件、四个槽位、
  每个 `workbench:*` 调用都必须有 `src` 落点，且落点文件真实存在、映射无死行。它的每条断言都做过
  **证伪**，因此抓到两条**假通过**的断言（`includes("'sidebar.panellist'")` 会被槽位登记对象的
  `name` 字段满足；`includes('auditStart:')` 会在实现被删后仍被接口声明满足）—— 已改为解析真实调用
  实参与 `import` 真门面查 `typeof`。
- 全仓测试 **389 条**（`npm run check` 全绿：版本一致 → typecheck → test → rev:check → build →
  交付校验 → 构建产物冒烟）。
- **已完成真实 DSH 装载验证**：独立 `smoke` profile 里 Host 半逐操作实测通过、客户端产物被登记并
  被服务（详见上面第一条与 `README.md`）。剩下两条要人参与：侧栏面板的肉眼确认、以及真发起一次
  审核（会在真实案例上跑）。
- **尚未执行**（需用户明确要求）：删除 `legacy/` 与配套校验/回归、文档与 CI 改成单形态。
  用户已确认「先留一个版本再删」，所以 `legacy/` 现在保持可用。

对齐 DSH 插件生态的实际分发与门禁做法（官方 [打包与安装插件] 教程 + 社区模板
`dsh-plugin-template` / `dsh-plugin-mcp-panel`）：

- **打通 npm 发布链路**（包形态按 npm 分发，是长期维护的那一半）：去掉 `private`，加
  `publishConfig`（public + provenance）、`prepublishOnly`（先产物自检再跑门禁）、
  以及 tag 驱动的 `.github/workflows/release.yml`（断言 tag 与 `package.json`/`VERSION` 一致 →
  跑门禁与产物自检 → `npm publish --provenance`；`workflow_dispatch` 可 dry-run）。
  新增 `scripts/sync-version.mjs`（`version:set` / `version:check`）与
  `scripts/assert-pack.mjs`（`pack:assert`：缺入口、误打 `tests/`/`legacy/`/`install/` 一律失败）。
- **修掉「发出去的包装不上」**（本轮实测踩出的两个坑，都是本地门禁看不出来的）：
  npm 在安装**已发布的 tarball** 时也会执行 `prepare`，而 tarball 里只有 `lib/` + 补丁 + 文档。
  `prepare: "tsdown"` 会因为找不到 tsconfig 直接失败；`prepare: "node scripts/build.mjs"`
  又因为 `scripts/` 不在 `files` 里而找不到脚本。现在构建入口是 `scripts/prepare.mjs`：
  **随包发布**、源码在就构建、源码不在（即装的是预构建产物）就跳过并打印原因；
  发布路径用 `prepack` → `build:lib --force`，源码缺失即失败，不会发出没有 `lib/` 的包。
  并加了一条**真跑 `npm pack` + `npm install` + 导入**的回归测试钉住这条路径。
- **`files` 收紧到 9 个文件**：只带 `lib/` + 补丁 + 文档；`src` / `install` / `tests` / `scripts`
  是仓库内部件，不进包（`pack:assert` 会核对真实 tarball 清单）。
- **修通包形态安装链**：加 `prepare: tsdown`（git 安装拉的是源码，没有它就装不出 `lib/`）、
  补 `engines.node`、`repository` / `bugs` / `keywords`。
- **提交 `package-lock.json`**：此前没有 lockfile，依赖不可复现，也没有 `npm ci` 可跑。
- 删除 `@deepseek-ai/dsh-client-ui-slots` 依赖：它不在 DSH 0.1.5-rc.2 的安装里，src 也不需要它的类型。
- **加 CI**（`.github/workflows/ci.yml`）：Ubuntu + Windows × Node 22/24 上跑
  `npm ci → typecheck → 交付校验 → rev:check → test → build → 断言产物`；此前门禁全靠人肉。
- **交付校验重写为 `install/verify.mjs`**，`install/verify.sh` 退化为薄包装。新增：
  语法检查、`name:` 值 ASCII 检查、客户端不得裸 `fetch` / `node:*`、文件末尾换行。
  **修掉一个静默失效的检查**：RPC 成对原来只匹配 `host.call('...')`，而客户端所有调用都经本地包装
  `call('workbench:…')`，于是它一直报告 `callers=0` 却仍然 PASS；现在按调用点解析（21 个调用者）。
  新增信息项：宿主字节上限若没有回归测试顶住会被列出（`RECORDS_STDOUT_MAX` 目前如此）；
  在 npm 包（无 `legacy/`）里运行会给出「必须在 git 克隆的仓根运行」的明确提示。
- **新增 `install/rev.mjs`**（`npm run rev:bump` / `rev:check`）：`legacy/REV` 的 sha256 / 字节数
  改为生成与校验，不再手工抄写。
- **包形态 Client 半现在有直接测试**：新增 `tests/helpers/tsx-loader.mjs`，用 `node:module` 的
  `registerHooks` 在测试进程里剥类型 + 转 JSX，并把 `react` / `react/jsx-runtime` 指向极小替身 ——
  于是 `.tsx` 能被 `node --test` 直接加载，且不引入 vitest / jsdom / react-dom。
  `tests/unit/client-package.test.mjs` 覆盖：同源 RPC 的请求契约与错误处理、槽位注册（名称/键/顺序）、
  面板在未加载 / 已加载 / 失败 / 卸载后迟到响应四种状态下的渲染、
  样式走 DSH 主题 token 而非硬编码颜色、文案必须走 locale 表。
  （此处原本写「槽位注册必须在 `ctx.effect` 内」—— 那是错的，正确结论是
  `slots.inject` **必须直接调用、不能包 `ctx.effect`**，见 `AGENTS.md` §4.1.2；测试现已反过来断言。）
- **新增 66 条包形态测试**（`tests/unit/`：交付契约 19 + 包形态 Host 31 + 包形态 Client 16）：
  交付契约的每条规则都配反向测试；Config schema 默认值与边界；同源路由的 405 / 403 / 404 / 200
  与错误信封、请求体上限；状态隔离与工作空间视图；操作表行为；`package.json` 入口 / files /
  发布配置 / peer 一致性；以及一条真跑 `npm pack` + `npm install` 的安装路径回归。
  当时全仓共 77 条（legacy 回归 11 条；移植收尾后为 368 条）。
- **修掉骨架里一处真实缺陷**：`boot` 把尚未实现的 `clipboard` 列在 `ported.done` 里，
  客户端点「复制提示词」会拿到 404；现在声明跟着实现走，并有测试防止再次漂移。
  操作表与 `ported.done/todo` 现在必须一一对应，legacy 客户端调用的每个 RPC 名都必须已登记。
- 补 `LICENSE`（内部使用）、`SECURITY.md`（插件是受信任 Host 代码、凭据位置、漏洞报告口径）、
  `README.en.md`，并把 README 的命令表、校验范围、npm 发布流程、踩坑清单更新到当前实现。
- `AGENTS.md` §6/§7/§8 更新：测试怎么摆（含 `.tsx` 怎么测）、交付契约规则的新增流程、
  门禁改为 `npm run check` + `pack:assert`、npm tag 发布流程与 DSH peer 版本对齐要求。

## package · 0.1.1 · 2026-09-20（未发布）

- 将包形态骨架拆分为 Host、Client、shared 及领域子目录，入口文件只保留 DSH 装配导出。
- 修正 Client 的 DSH ModuleLoader 包装、Host/Client 独立构建和 `lib/index.js` / `lib/client.js` 固定输出。
- 收紧 `dsh.client.inject` 与 Cordis `inject`，常量、配置、状态、HTTP 和 UI 骨架分别维护。

## legacy · pkg-43 · 2026-09-20

- 报告页增加“待审核报告 / AI审核结果”页内标签，列表直接展示氚云人工复核级次、状态和当前节点。
- 保留原 OSS 对象命名与审核报告 HTML；报告页首次进入只列举一次 OSS，检索、翻页与审核状态轮询不再重复扫 OSS，只有显式刷新或上传成功后才重新列举。
- 已审核项目增加“审核信息”入口；点击后才按精确 Key 读取一份审核结果 JSON，并以精简摘要与当前氚云复核信息并列展示。列表接口不下载逐条 JSON，也不把“氚云更新时间较晚”误称为“报告材料变化”。
- Host 对审核结果 Key 增加 Bucket 前缀和 `.json` 边界校验，限制单次读取大小，并只向 Client 返回摘要字段。
- 云端报告链接同样执行 OSS 前缀校验；对象清单只认 `审核意见.<流水号>.html` 与 `审核结果.<流水号>.json`，避免辅助文件被误当正式交付件。
- OSS 清单失败不再拖垮已成功返回的氚云列表，也不会在后续检索、翻页时自动重试；快速切换审核信息时忽略迟到的旧请求。
- 新增按需读取、完整交付件门禁、OSS 清单缓存/失败隔离、请求竞态、Key 越界拒绝与结果归一化回归测试。
- 新增根目录 `AGENTS.md`；包形态 TypeScript 按 Host / Client / shared 及领域目录拆分，常量归入各目录 `consts.ts`，并修正 Host / Client 双入口构建产物名。

## legacy · pkg-42 · 2026-09-20

- 修复审核创建期间重复点击会并发创建两个子会话的问题：Client 立即显示并禁用「创建中…」，并在创建完成前禁用其它审核入口。
- Host 增加独立的创建中门禁；并发请求在调用 `subagents.start` 前即被拒绝，成功、失败或提前返回都会自动释放门禁。
- 新增 Client 状态传递与 Host 并发请求回归测试。

## legacy · pkg-41 · 2026-09-20

- **审核只允许挂一层子代理。** `bind-session` 拒绝把子代理会话登记成审核父级并保留原来的顶层父级；
  `audit-start` 再兜一道门禁。判据是只有子代理才有的 `origin: 'subagent'` / `delegationDepth`
  （顶层会话为 `delegationDepth: 0`、无 `origin`）。
- **存活判据换成子 Agent 自己的 `AgentStatus`**（`idle` / `running`），不再依赖 `listChildren` 的 `activity`。
  `listChildren` 由会话存储驱动，跑完的一次性子会话**依然在列**，父会话一变（`state.parentSessionId`
  只是「最后看过哪个会话」）就全体查不到，界面表现为「状态跟丢」。新判据与父会话无关。
- `audit-status` 按**每条记录自己的** `parentSessionId` 聚合查询多个父会话，并对历史 depth-2 记录免疫。
- **占用锁自愈**：只要本轮真看到有子会话在 `running`，就把单条审核门禁重新挂回去。
- **「这条任务已经有了」= 带时间戳重启**：先停掉已存在的子会话（记录里的 + 清单里 label 命中同一
  流水号的），再用「重新审核」提示词重启；子会话 label 变为 `审核 <流水号> · HH:MM:SS`，记录里有
  `startedAt` 与第 N 次，界面上显示「启动 10:16:27（第 2 次）」。别的报告在跑时仍然拒绝（单条并发门禁）。

## legacy · pkg-40 · 2026-09-20

- 修 pkg-39 引入的**认领过头**缺陷：认领只收 `agentStatusOf(cid) === 'running'`。
- 认领来的记录（以及落盘时没有 `startedAt` 的记录）永远等不到 `subagent/end`，其生命周期一律以
  Agent 状态判定，一旦不再 running 就置 `ended`、按交付件定状态并释放占用 —— 据此自愈了已被
  误写进 `~/.dsh/crwu-workbench.json` 的三条记录。
- `adopted` 落盘，重启后语义不丢。

## legacy · pkg-39 · 2026-09-20

- 补回 **Client 半**：pkg-38 只带了 Host 半，导致浏览器端停在更早的 `pluginRunId` 上，
  而 `invoke()` 严格按 run 对账，于是每次 `host.call` 都返回 `stale-run` 并被面板里的
  `.catch(function () {})` 静默吞掉 —— 界面表现为「子任务在跑但什么都不显示」。
- 新增按 label「审核 <SeqNo>」认领重装前遗留的审核子会话（pkg-40 收紧了准入条件）。

## legacy · pkg-38 · 2026-09-20

- 审计记录与占用锁落盘到 `~/.dsh/crwu-workbench.json`，插件重装后自动恢复。
- 停止增加无句柄退路：直接对子 Agent 调 `cancel({ kind: 'parent' })`，与驱动 `onAbort` 同一条路径，
  所以重装前起的会话同样停得掉。

> pkg-1 … pkg-37 的历史记录在当时的 DSH 会话里（`~/.dsh/storages/session_projcache/`），
> 未逐条搬进本文件；其中 pkg-34 之后的关键节点见上。
