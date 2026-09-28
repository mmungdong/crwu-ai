# Windows 干净环境验收清单（人工）

本文件是 **Task 10** 的执行清单：在真实 Windows 上、用**全新用户配置**装一遍最终 tarball，
把机器验不到的部分走完并留证。

机器能验的部分已经在 CI 里（见 [`development-notes.md`](development-notes.md) §13.3）：

| 已经自动化 | 在哪 |
| --- | --- |
| DSH 兼容判定（0.1.7 线 / 0.2.0 线各装一遍，调 `evaluatePluginCompatibility()`） | `npm run compat:dsh` / CI plugin 矩阵（Node 22） |
| PowerShell 命令合同（命令位置、参数原样往返、幂等、失败非零退出） | `tests/windows/powershell-contract.test.mjs` / CI `windows-powershell` |
| 全量单元/集成测试在原生 pwsh 下 | CI `windows-powershell` |
| 发布二进制真的启动 + `win32-arm64` 明确被拒 | `release.yml` 的 `windows-binary-smoke` |

**剩下这些只能人工做**：真实 DSH profile 里的加载与界面、真实氚云/钉钉/OSS/iFinD 凭据链路、
重启后的状态恢复、从上一稳定版升级。

## 0. 前置

- Windows 10/11 x64；PowerShell 7（`pwsh`）。
- Node 22 或 24。
- 一个**专用的测试用户**（或至少一个专用 Windows 账户）：验收要删配置，不得动真实用户数据。
- 待验收的 tarball：`dsh-crwu-workbench-<version>.tgz`（发布作业产出），并记下它的 sha256。

记录到日志头部（**不要**记录任何 token / AK / API-Key）：

```
Windows 版本：       winver / (Get-ComputerInfo).WindowsVersion
CPU / 架构：         $env:PROCESSOR_ARCHITECTURE
PowerShell：         $PSVersionTable.PSVersion.ToString()
Node：               node --version
DSH：                dsh --version
插件版本 / tarball：   <version> / sha256=<...>
```

## 1. 全新配置装插件（DSH 0.1.7 线与 0.2.0 线各做一次）

```powershell
$profile = "crwu-accept-$([guid]::NewGuid().ToString('N').Substring(0,6))"
dsh --profile $profile --from-default-profile web --dump-config   # 从内置 web 模板建 profile
dsh plugin --profile $profile add .\dsh-crwu-workbench-<version>.tgz
dsh --profile $profile --port 3099 --no-open
```

- [ ] 插件**没有**被 peer 检查 skip / disable（`dsh plugin --profile $profile list` 里是 enabled，
      启动日志里没有 `skippedBundles`、没有「与 DSH `<版本>` 不兼容」）。
- [ ] 客户端面板可见：左侧栏底部的「中瑞世联工作台」入口出现，点开是环境信息页。
- [ ] 面板标题旁的版本徽标显示的是 tarball 的版本号。

## 2. 环境自检

- [ ] ② 插件内置组件：三个组件（crwu / dws / ossutil）按包内 `bin/win32-x64/` 字节数核对通过。
- [ ] ③ 运行时：DSH 自带 Python 可用（**不**要求系统装 Python）。
- [ ] ④ 服务：氚云 / 钉钉登录态可查（授权后）。
- [ ] ⑤ 交付：OSS 配置 + 凭据 + 一次真实只读列举。
- [ ] ⑥ 外部：iFinD API-Key 保存后**真的取一次数据**才算通过。
- [ ] 所有命令都在**原生 PowerShell** 下执行，日志里**没有** `ParserError`、
      「不是有效的 Win32 应用程序」、`bash` / `cmd` not found。

## 3. 带特殊字符的工作空间与案例目录

建一个把要命字符都放进去的目录，并把它选成工作空间：

```
C:\Users\<测试用户>\测试 Work\Case's [1]
```

- [ ] workspace 选择与持久化：选中后重启 profile，仍是同一个路径（不是「每次进来都变」）。
- [ ] case 创建 / 列举 / 删除都在这个路径下正常（案例目录 = `<工作空间>\<流水号>`，
      分隔符是 `\`，不是混用的 `/`）。
- [ ] audit root 探测：审核根会话建在这个工作空间里，标题 `审核子代理根节点 · MM-DD HH:mm`，
      预检用 `Get-Location` 回报当前目录（**不是** `pwd` / `bash`）。

## 4. 审核链路与交付

- [ ] DSH Python runtime 脚本：`prepare_materials.py` 等按启动指令里的**绝对解释器路径**执行成功。
- [ ] `crwu` / `dws` 的结构化 Tool 调用成功（`crwu_audit_capabilities` 返回 ok/platform/binPlatform）。
- [ ] OSS：签名、打开（`Start-Process -FilePath`）、上传/下载（专用测试凭据）都成功；
      上传后**列举核对**对象与字节数。
- [ ] iFinD：凭据写入 → 读取 → 删除；界面上那句「使用当前 Windows 账户 ACL；POSIX 0600 不适用」
      **只在 Windows 上**出现（不是「已收紧到 600」，也不是失败）。
- [ ] 重启 DSH 后状态恢复（工作空间、授权、审核记录、占用锁自愈）。
- [ ] 从上一稳定版（0.0.13）升级到本版本后，面板、环境自检、发起审核都正常。

## 5. 断言「日志里没有这些」

把整个验收过程的日志抓下来，逐条确认**不存在**：

- [ ] `ParserError` / `意外的标记` / `UnexpectedToken`
- [ ] `cmd: not found` / `bash: not found` / `'bash' 不是内部或外部命令`
- [ ] `不是有效的 Win32 应用程序` / `Exec format error`
- [ ] 路径被截断（`C:\Users\张三\测试` 被拆成两段、或目录名变成一整条路径）
- [ ] 「成功」但目标不存在（目录没建出来、文件没删掉、上传没落地）
- [ ] 插件被禁用 / `skippedBundles` 里有本插件
- [ ] 凭据明文或签名 URL 出现在日志里

## 6. UNC（按支持策略执行）

- [ ] 用 `\\<测试服务器>\<共享>\crwu-accept` 当工作空间试一次：
      **要么**完整走通（选工作空间 → 建案例 → 审核 → 回传），
      **要么**在入口处得到明确的「案例目录不可解析：…（原因）」——
      两种都算通过；**不许**出现「路径被拼坏后继续往下走」。

## 7. 收尾

- [ ] 删除本次专用的 profile 与临时工作空间（PowerShell：
      `Remove-Item -LiteralPath "$env:USERPROFILE\.dsh\profiles\<profile>" -Recurse -Force`）。
- [ ] 确认发布树 / 安装目录里没有运行残留（`.dws`、日志、临时文件）。
- [ ] 把**脱敏后**的日志附到发布说明或 CI artifact（手工上传）。

## 脱敏日志模板

```
=== CRWU Windows 验收 ===
日期：            2026-XX-XX
Windows / 架构：   <...>  (x64)
PowerShell：       <7.x>
Node：             <22.x|24.x>
DSH：              <0.1.7-rc.2|0.2.0-rc.1>
插件 / tarball：   <0.0.14>  sha256=<...>

[1] 安装与加载
    plugin list: enabled
    skippedBundles: 无
    版本徽标: v0.0.14

[2] 环境自检
    ② 包内组件: 3/3
    ③ DSH Python: <路径> <版本>
    ④ 氚云/钉钉: 已登录 / 未授权(如实)
    ⑤ OSS: AK 正常（只读列举 <oss://bucket/prefix/>）
    ⑥ iFinD: dataVerified=true（工具 <名>，样本已脱敏）

[3] 特殊字符路径
    工作空间: C:\Users\<用户>\测试 Work\Case's [1]
    案例目录: C:\Users\<用户>\测试 Work\Case's [1]\<流水号>
    审核根 Session: <短 id> / cwd 一致 / 预检用 Get-Location

[4] 交付
    OSS 上传: <html|json> 字节数一致
    iFinD 凭据: permission.status=inherited mechanism=windows-acl

[5] 禁用词检查: ParserError=0 bash-not-found=0 cmd-not-found=0 无效Win32=0 路径截断=0 假成功=0 插件禁用=0

[6] UNC: 通过 / 明确拒绝（<原文>）

[7] 残留: 无
```
