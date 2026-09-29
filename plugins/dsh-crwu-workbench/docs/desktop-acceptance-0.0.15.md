# 桌面本机访问验收清单（0.0.15 · 人工）

本文件是 [本机权限完整适配方案](superpowers/specs/2026-09-28-desktop-local-access-design.md) §10
的**执行与留证模板**：装 `dsh-crwu-workbench-0.0.15.tgz`，在**干净的非管理员账户**上逐条走完
P-01…P-18（Windows / macOS 各一遍）、W-01…W-07（Windows）、M-01…M-10（macOS）。

**机器能验的部分不在这里**：`npm run check`、`pack:assert(:strict)`、`bin:check`、`compat:dsh`
与 CI 的 `windows-powershell` / `windows-binary-smoke` 覆盖了类型、命令合同、打包形状与两条 DSH
兼容线。这里只做**只能人工做**的事：真实 DSH profile 里的加载与界面、真实氚云/钉钉/OSS/iFinD
凭据链路、重启后的状态恢复、从 0.0.14 升级、以及"故意把它弄坏"之后的结论是否正确。

> **不要**在验收完成、用户明确同意之前打 `plugin-v0.0.15` tag（设计 §E1 最后一条）。
> 本文件填完之后，tag 才由 `docs/releasing.md` 的流程创建。

## 0. 前置与记录头部

- 待验收 tarball：`dsh-crwu-workbench-0.0.15.tgz` + 它的 sha256（**不要**记录任何 token / AK / API-Key）。
- 干净账户：Windows 用专用账户；macOS 建一个标准（**非管理员**）账户。验收要删配置，不得动真实数据。
- 两台机器的 DSH 都从**默认** `workspace-write` 起（不要设 `DSH_PERMISSION_MODE`，那会掩盖沙箱结论）。

```
平台：            win32-x64 / darwin-arm64
系统版本：        winver / sw_vers
账户类型：        标准用户 / 管理员（必须是标准用户）
DSH 版本：        dsh --version
插件版本：        0.0.15
tarball sha256：  <...>
Host builtAt：    <面板版本徽章悬停 / ping 回的 builtAt>
本轮起止时间：    <...>
```

**证据从哪拿**：环境信息页底部的「开发者诊断」（默认收起）→ 展开后最后一行是
**「最近的本机访问」**，逐条列出每次本机访问的操作名 / 来源 / `req` · `res` · `ran` 三个模式 /
`denied` / `runnerFailed` / `started`（进程有没有真的起来）/ 归因类别 / 时刻。
那一栏的「复制」按钮可以把整份诊断（含这些行）拷成文本，直接贴进下面每一行的证据栏。
不经界面也可以直连（**只读、零副作用**）：

```bash
curl -s -X POST "http://127.0.0.1:3080/api/crwu-workbench?token=$TOKEN" -H 'Content-Type: application/json' \
     -d '{"op":"access-diagnostics","args":{}}'
```

**每条失败都要带这九项事实**（设计 §11；就是上面那一行的字段，日志要脱敏）：

```
acceptance ID / 插件版本 / builtAt / 操作名 + 来源 /
requested, resolved, actual 沙箱模式 / sandboxDenied / runnerFailed /
归因类别 + 脱敏后的消息 / 失败发生在**进程创建之前还是之后**
```

## 1. 公共矩阵 P-01…P-18（Windows 与 macOS 各做一遍）

> **升级场景提示**：从 0.0.14 升上来的机器，状态文件里是旧版的 `trustCredentials: true` 而
> 没有 `localAccessConsent`。按设计 A-01 它会判成 **`outdated`**（不是 `granted`），
> 所以第一屏就是授权卡、各凭据项在重新允许前都是阻塞态 —— 这是**预期行为**，
> 不是授权丢失（审核记录与工作空间都还在）。重新允许一次之后即可按下面的矩阵继续。
> 想验"全新安装"的现场，就先把 `~/.dsh/crwu-workbench.json` 备份走再移开。


在 ID 前加平台前缀记录（`WIN-P-01` / `MAC-P-01`）—— 一边通过**不**等于另一边通过。

| ID | 场景 | 期望证据 | 结果 / 证据 |
| --- | --- | --- | --- |
| P-01 | 装 tarball 后完整退出并重启 DSH | `boot.version=0.0.15`、协议 18、`buildKind=installed`、`builtAt` 与 tarball 一致 | |
| P-02 | 首次打开、**未**同意 | 授权卡可见；**没有**任何氚云/钉钉/OSS/iFinD 进程或凭据文件读取发生（判据：开发者诊断的「最近的本机访问」是**空的**） | |
| P-03 | 点「暂不允许」 | 不落任何长期授权；凭据探测一次都没有；审核仍被阻塞 | |
| P-04 | 点「允许」 | **先落盘**版本化收据，之后才开始授权后的真实校验 | |
| P-05 | 已有氚云登录 | 登录态用 Broker 的完全访问调用取得；**不会**把真实会话报成 `keyring not found` | |
| P-06 | 氚云全新登录 | **前置**：会话权限必须是「完全权限」（登录要写 `%TEMP%\crwu-scan-*`）；够了就浏览器/设备码流程能走完，之后 `session status` 成功。不够时面板必须给「本机访问被挡在工作区之外…切到完全权限再点一次」，而**不是** CLI 的 `mkdir … Access is denied` 原文 | |
| P-07 | 钉钉登录 | **同一前置**（`<HOME>/.dws/.data.lock` 也在工作区之外）；够了就锁能安全创建/更新、`auth status` 成功。不够时同样给归因文案，且**必须点明设备码登录也走不通** | |
| P-08 | OSS 保存 | `<HOME>/.ossutilconfig` 写入 + 权限后置条件通过 + 真实前缀内探测成功 | |
| P-09 | iFinD 保存 | 凭据落盘 + 权限后置条件通过 + 真实安全取数成功 | |
| P-10 | 完整重启应用 | 授权与配置自动恢复：**不再问一次**，也**没有**授权前的探测 | |
| P-11 | 撤销授权 | 全部带凭据的 Host 与 Tool 操作**立刻** fail closed，重启后仍然如此 | |
| P-12 | 发起审核 | 根与子会话事实显示 `workspace-write` / `never`，且 ⑧「审核根会话」里的**边界与 cwd 都等于本轮案例目录**（`<工作空间>/<流水号>`，不再是工作空间）；子会话写进自己的案例目录 | |
| P-13 | 子会话尝试越界写（**两种**） | ① **工作空间之外**（如 `~/Documents/x.txt`）：直接 shell 与文件系统写**都被拒**；② **同工作空间的兄弟案例**（先在 `<工作空间>/<另一个流水号>` 建一个目录，再让子会话写 `../<另一个流水号>/x.txt`）：同样**被拒** —— 这是协议 19 才兑现的约束（此前沙箱边界是整个工作空间，兄弟案例可写） | |
| P-14 | 子会话用结构化 Tool | 氚云/钉钉/OSS/iFinD 注册工具经 Broker 正常工作，**且不弹审批** | |
| P-15 | 强制沙箱降级 | 那一行报出 `req` / `res` / `ran` 且 `ran` 与请求不符，归因 `sandbox-downgraded`；「钉钉本机目录」卡**不出现**「修复权限」（建议去改操作系统权限就是错） | |
| P-16 | 强制文件系统拒绝 | ① 先按「怎么强制」把 `.dws` 权限改坏，**再让一次 DWS 操作失败**（点一次钉钉登录 / 取数）—— 体检只回答"刚才那次为什么失败"，没有这次失败它会**按规定拒绝**（§1.05）；② 那一行显示 `ran=danger-full-access`、`denied=false`（先确认真的没被沙箱拦）；③「检查本机目录」报出平台原生权限机制且不可写；④ 出现「修复权限」且**必须二次确认** | |
| P-17 | 强制文件锁 | 界面要求**关闭占用进程**；**不**删锁、**不**杀进程 | |
| P-18 | 客户端/宿主版本不一致 | 新的凭据活动被拦，并提示"完整重启应用" | |

### 怎么"强制"（P-15 / P-16 / P-17 / M-03 / M-07）

| 目的 | 做法 | 必须看到的结论 |
| --- | --- | --- |
| 沙箱降级 | profile 的 `dsh-sandbox-policy` 设 `mode: workspace-write`，同时让插件请求提权（任一凭据操作） | 归因 `sandbox-downgraded`，界面显示三个模式；**不许**引导去修 ACL |
| 文件系统拒绝 | 把 `<HOME>/.dws` 的权限改坏（Windows：`icacls <dir> /deny "<你>:(M)"`；macOS：`chmod 500 <dir>` 且确保属主是你），**然后让一次 DWS 操作真的失败**（点一次钉钉登录或取数）—— 权限坏掉本身不会自动进诊断，体检必须先有一次可归因的失败（§1.05） | doctor 报 `windows-acl` / `posix-mode` 且 `currentUserCanModify=false`；「修复权限」出现并要二次确认 |
| 文件锁 | 用另一个进程持有 `<HOME>/.dws/.data.lock`（Windows：`[IO.File]::Open(...,'Open','ReadWrite','None')` 之后别关；macOS：`flock` 或 `python3 -c "import fcntl,time; f=open('...','w'); fcntl.flock(f,fcntl.LOCK_EX); time.sleep(600)"`），**然后让一次 DWS 操作真的失败**（持锁本身要先让某次 dws 调用失败，体检才有可归因的对象） | 归因 `file-lock`；界面要求关闭占用进程；**锁文件仍在** |
| 钥匙串被拒（macOS） | 在「钥匙串访问」里把该项的访问控制改成"每次询问"并取消，或让进程在无交互会话里访问 | 归因 `os-credential-store`；**不**报成"没登录"；**不**出现修复权限按钮 |
| 嵌套沙箱失败（macOS） | 在已受限的 DSH 进程里再起一层 `sandbox-exec` | 归因 `infrastructure`；**绝不**说成"命令缺失 / 没登录 / 凭据无效" |
| 客户端/宿主版本不一致（P-18） | 换上新版后**只刷新页面**（不退出应用）：客户端产物随刷新换新，宿主还是上一份 | 新的凭据活动被拦住并提示「界面与宿主的权限说明版本不一致：请完全退出并重新打开」；完整退出重启后恢复正常 |

## 1.0 设计要求 ↔ 验收行（追溯表）

设计文档（`docs/superpowers/specs/2026-09-28-desktop-local-access-design.md`）的每条编号在这里
落到具体的验收行；**这一列是人工证据的唯一入口**（`host-design-traceability.test.mjs` 会断言
每条编号都能在这里找到）。

| 设计要求 | 对应验收行 | 自动化证据（守它的是哪条用例） |
| --- | --- | --- |
| A-01（旧版授权判 `outdated`） | P-02 | `host-access-consent`（旧 `trustCredentials` 各形态） |
| A-02（授权落盘失败 → 不放行） | P-03 | `host-access-consent`（写盘失败：磁盘不变、内存不放行） |
| A-03（同意之前不碰凭据） | P-02 | `host-access-rpc-gate`（未授权零调用）+ `host-environment-env` |
| A-04（拒绝不产生本机变更） | P-02 | browser-check（点「暂不允许」后**一个 Host 请求都不发**） |
| A-05（撤销写盘失败也立刻关闭） | P-11 | `host-access-consent`（撤销墓碑 + 刷新不许复活） |
| A-06（界面与宿主版本不一致 → fail closed） | P-18 | `client-local-access`（`permissionStale` 判据）+ browser-check |
| B-01（跨边界 shell 都有具名操作） | P-05…P-09 | `host-access-broker`、`host-access-migration` |
| B-02（跨边界写入都有具名操作） | P-06、P-07 | `host-access-migration`（只有 Broker 一处 `fs.writeText`） |
| B-03（schema 里没有提权 / 通用命令字段） | P-05 | `host-tools`（封禁字段清单）、`host-access-migration` |
| B-04（未授权 → provider 零调用） | P-02、P-11 | `host-access-rpc-gate`、`host-access-broker` |
| B-05（特权请求逐次声明，被降级要看得出来） | P-15 | `host-access-broker`（结构化事实四档） |
| B-06（OSS 配置与每一次 `ossutil` 都被覆盖） | P-07、P-08 | `host-access-migration` 的 B-01b、`host-tools`（每条 `ossutil` 都提权） |
| B-07（氚云钥匙串假结论不得显示成未登录） | P-09 | `host-crwu-h3yun`（`session` 整段登记为特权操作） |
| B-08（dws 保持前缀白名单与取消） | P-14 | `host-tools`（白名单 + `exec.signal` 透传） |
| B-09（源码里没有绕过执行器的业务 CLI） | P-05 | `host-access-migration`（B-01 / B-01b / B-01c） |
| C-01（新根解析为 `workspace-write`） | P-12 | `host-audit-policy` |
| C-02（不安全 preset 的根不复用） | P-12 | `host-audit-policy`、`host-audit-lifecycle` |
| C-03（子会话继承 `workspace-write` + `never`） | P-12 | `host-audit-policy`（委派事实）、`host-audit-spawn` |
| C-04（子会话能写自己的案例目录） | P-12 | **只能真机**（真实子代理 + 真实沙箱） |
| C-05（子会话写不出工作空间；协议 19 起也写不进**同工作空间的兄弟案例**） | P-13 ① + ② | **只能真机**（边界=案例目录，真实沙箱才证得了） |
| C-06（同一个子会话能用 Broker 工具） | P-14 | **只能真机**（同上） |
| C-07（缺授权 / 未登录时停在创建之前） | P-12 | `host-audit-lifecycle`（能力门禁） |
| C-08（审核链路没有交互式登录） | P-14 | `host-audit-migration`、`host-audit-prompt`、`host-access-broker` |
| D-01（三种 Windows 报错与 macOS 样本都归对档） | P-15、P-16 | `host-access-classify`（真实样本片段） |
| D-02（实际 DFA + `denied=false` 不许说成沙箱拒绝） | P-15 | `host-access-classify` |
| D-03（doctor 自己推导目标、不接受路径） | P-16 | `host-dws-local`、`client-dws-local` |
| D-04（修复要确诊 + 显式确认） | P-16 | `host-dws-local`（D-03/D-05 用例）、`client-dws-local` |
| D-05（修复不碰父目录、不删锁） | P-16 | `host-dws-local`（D-07 用例逐条断言命令） |
| D-06（医生与修复的返回都不含凭据与身份） | P-16 | `host-dws-local`（D-06 用例）+ `host-platform-redact` |
| D-07（macOS 拒绝错误属主 / 符号链接，不用 `sudo`/`chown`） | P-17 | `host-dws-local`（D-07 用例） |
| D-08（钥匙串失败绝不触发文件权限修复） | P-17 | `host-dws-local`（D-08 用例）、`host-access-classify` |
| 设计 §11（失败要带九项事实） | 每一行的证据栏 | 开发者诊断的「最近的本机访问」（`accessDiagnosticLine`） |


## 1.05 体检的前置条件（W-03 / W-04 / P-16 都会用到）

设计 §D2 规定：`dws-local-doctor` **只在"刚刚发生过一次 DWS 失败、且结构化事实排除沙箱"之后**运行。
它不是随时可跑的健康检查，而是"刚才那次为什么失败"的事后归因。所以走 W-03 / W-04 之前：

1. **先制造一次失败现场**：断网后点一次钉钉登录、或用一份权限不对的 `.dws` 让 `dws` 命令失败
   （`P-16` 与「怎么强制」那一节都写了这一步：**改坏权限/持锁之后必须真的让一次 dws 调用失败**）；
2. 再点「检查本机目录」。**没有可归因的失败时 Host 会直接拒绝**（界面显示
   「还没有可以归因的 DWS 失败：请先复现一次」），这是**预期行为**，不是按钮坏了；
3. 如果最近一次失败其实是沙箱拦下的，体检同样拒绝并说明"改文件权限解决不了它" ——
   这正是 §D2 要防的误归因。

## 1.1 已有 CI 机器证据的格子（2026-09-29 补）

下面这些格**不必再手工造条件**——它们由 CI 的 `windows-powershell` job 在真实 Windows 上跑
（`tests/windows/powershell-contract.test.mjs`），人工走查时只看用户可见行为即可：

| 已覆盖的行为 | 机器判据 |
| --- | --- |
| Windows 权限判决**Deny 优先**（有效权限，含组与继承） | 合同测试里 `icacls /deny` 一次：判决必须翻成不可改、写实测必须失败、清掉 Deny 后必须恢复 |
| Windows **写实测**（`windowsModifyProbeCommand`） | 同上（自己建的目录必须回 `modify=True`） |
| POSIX 模式回读（`stat -f '%u %Lp'` 带引号） | 同一条合同测试的 posix 半，在 macOS 上真跑 |
| OSS 的每一次 `ossutil` 都拿到逐次提权 | `host-access-migration.test.mjs` 的 B-01b（静态）+ `host-tools.test.mjs`（配对断言 sandboxPolicy） |
| 未授权时读凭据**零调用** | `host-access-rpc-gate.test.mjs`（fs / 宿主凭据服务 / 网络都断言零调用） |
| 凭据操作"登记了必须有调用点" | `host-access-migration.test.mjs` 的 B-01c（含模板拼出来的操作名） |

## 2. Windows 原生矩阵 W-01…W-07

用 Windows PowerShell 5.1，CI 提供时再用 PowerShell Core 各做一遍。

| ID | 场景 | 期望证据 | 结果 / 证据 |
| --- | --- | --- | --- |
| W-01 | 路径含盘符根、空格、非 ASCII | 全部 Host 目标都落在预期根之下；原生命令里**没有** POSIX 分隔符 | |
| W-02 | 在 `workspace-write` 下做 OSS / 钉钉操作 | 逐次 Broker 事实显示 requested/resolved/actual 都是 `danger-full-access`；**没有**改 profile 全局模式 | |
| W-03 | `.dws` 不给当前账户 Modify | doctor 报 `windows-acl`；二次确认后的修复**只**加当前账户的 Modify，SYSTEM / Administrators / 继承条目**原样保留** | |
| W-04 | `.dws` 属主是别人，或修复命令失败 | **不**尝试夺取所有权；界面明确指向管理员人工处理；验证结论仍然是失败 | |
| W-05 | 另一个进程持有 `.data.lock` | 归因 `file-lock`（不是 ACL、不是认证）；**不**自动删锁、**不**结束进程。⚠️ 归因要求**两个条件**：原始那次失败与锁有关 **且** 当前正向探测证明有人持有 —— 无关失败（例如认证失败）即使机器上恰好有人持锁，也**不许**报 `file-lock` | |
| W-05b | `.dws` 目录正常，**只有** `.data.lock` 不可写（原始报错 `opening lock file ... Access is denied`） | 体检报「锁文件（.data.lock）当前账户改不了」并确诊 `os-filesystem-permission`；修复**只**动锁文件（目录一个字节都不改），回读核对锁文件权限 | |
| W-06 | 子会话直接写 `%USERPROFILE%` | shell 与文件系统的尝试**都失败**，而经 Broker 的注册工具仍然通过 | |
| W-07 | 打包产物的兼容作业 | `windows-powershell`、`windows-binary-smoke` 与两条受支持 DSH 线都对**打包产物**通过 | |

## 3. macOS 原生矩阵 M-01…M-10

验收记录里必须写明**架构**（当前发布二进制是 `darwin-arm64`）与 macOS 版本。

| ID | 场景 | 期望证据 | 结果 / 证据 |
| --- | --- | --- | --- |
| M-01 | 氚云/钉钉读已有的钥匙串会话 | Broker 事实先证明**实际完全访问**再解释结果；能读到有效密钥且**不**暴露条目名/账户名 | |
| M-02 | 钥匙串里确实没有该条目 | 归因 `missing-secret`；只在同意之后才提供正常的面板登录 | |
| M-03 | 钥匙串交互被取消或拒绝 | 归因 `os-credential-store`；**不**把登录态误报成"没登录"；**不**提供文件权限修复 | |
| M-04 | 保存凭据文件 | 父目录已按要求私有；报告成功**之前**规则文件回读必须是 `0600` | |
| M-05 | `.dws` 模式过宽且属主是当前用户 | doctor 报 `posix-mode`；二次确认后目录设 `0700`，**只有**被诊断的规则文件设 `0600` | |
| M-06 | `.dws` 是符号链接或属主是别人 | 修复**在改动之前**就拒绝；**不**跟随链接、**不**调 `sudo`、**不**调 `chown` | |
| M-07 | 强制嵌套沙箱失败 | `sandbox-exec: sandbox_apply: Operation not permitted` 归为基础设施/runner 失败，**绝不**是命令缺失或凭据错误 | |
| M-08 | 子会话直接写 `$HOME` | shell 与文件系统尝试**都失败**，经 Broker 的注册工具仍然通过 | |
| M-09 | 从已安装的 `0.0.14` 升级 | 旧 `trust` 变成 `outdated`；完整退出重启后加载 `0.0.15`，并要求**一次**版本化同意 | |
| M-10 | 打包二进制与兼容 | `darwin-arm64` 的哈希/清单核对通过；两条受支持 DSH 线对**打包产物**通过 | |

## 4. 收尾

- [ ] 每一条失败都补上了 §0 的九项事实（没有就写"未发生失败"）。
- [ ] 日志已脱敏：只有包/构建、操作、来源、三个模式、`processStarted` / `sandboxDenied` /
      `runnerFailed` 与归一化后的错误类别 —— 没有 AK、token、签名 URL、账户名、SID、钥匙串条目名。
- [ ] `npm run check` / `pack:assert` / `pack:assert:strict` / `bin:check` / `git diff --check`
      在**验收所用的那一次构建**上全绿。
- [ ] 用户已经**亲自测过**并**审过代码**（两道人工关卡）。
- [ ] 只有到这一步，才按 `docs/releasing.md` 提交、推送并打 `plugin-v0.0.15`。
