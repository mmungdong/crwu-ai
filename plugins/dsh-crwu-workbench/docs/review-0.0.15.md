# 0.0.15 复审指引（给复审者用的一页清单）

这份文档**只服务于两件事**：让复审更快，让真机验证更省时间。判据口径仍以
[`../AGENTS.md`](../AGENTS.md) 为准，人工验收记录在
[`desktop-acceptance-0.0.15.md`](desktop-acceptance-0.0.15.md)。

改了什么、为什么改，全都挂在设计文档的编号上（`A-*` / `B-*` / `C-*` / `D-*`）。
每条编号的证据在验收清单的追溯表里，这里是"怎么最快看完"。

## 1. 建议的复审顺序（按风险，不按目录）

前 5 项是**安全边界**，也是本次改造的核心；它们的共同失败模式是"边界登记了，
实际路径绕过去"（这正是上一次复审抓到的 6 个 P1）。**建议先看这 5 个文件**，
每个文件顶部都写着"不许退回去的口径"：

| 顺序 | 文件 | 看什么 | 对应要求 |
| --- | --- | --- | --- |
| 1 | [`src/host/access/operations.ts`](../src/host/access/operations.ts) | 封闭操作表：每条操作的 capability / 通道 / **是否提权** / 允许来源 | B-01…B-04 |
| 2 | [`src/host/access/broker.ts`](../src/host/access/broker.ts) | 唯一能声明 `danger-full-access` 的地方；未授权时**一个进程都不起**；`writeText` 逐字比对目标 | B-04、B-06 |
| 3 | [`src/host/access/consent.ts`](../src/host/access/consent.ts) | 授权先落盘再改内存；撤销**内存先关**（`persist-failed` 墓碑）；同步不许用磁盘旧授权覆盖墓碑 | A-01…A-06 |
| 4 | [`src/host/access/classify.ts`](../src/host/access/classify.ts) | 纯函数、九档优先级；事实在手时文本不许翻案 | D-01、D-02、D-08 |
| 5 | [`src/host/ops/core.ts`](../src/host/ops/core.ts) | Host 操作表 + 每个 handler；凭据类 RPC 是否在 provider 之前过门禁 | B-01、P-11 |

然后按子项目看剩下的：

| 子项目 | 主要文件 | 看什么 |
| --- | --- | --- |
| A 版本化同意 | `src/shared/access/types.ts`、`src/client/features/environment/{local-access.ts,LocalAccessConsentCard.tsx}` | 五项固定能力；旧 `trustCredentials` 判 `outdated`；界面与宿主版本不一致时整张卡禁用 |
| B 迁移 | `src/host/{oss/run.ts,dws/run.ts,crwu/run.ts}`、`src/host/state/persist.ts`、`src/host/update/persist.ts` | **业务 CLI 只有这三个执行器**；跨边界写只有 Broker 一条路 |
| C 审核收敛 | `src/host/audit/{policy.ts,root.ts,ops.ts,prompt.ts}` | 根与子会话 `workspace-write` + `never`；不安全 preset 的根不复用；发布后复查 |
| D 归因与修复 | `src/host/dws/local.ts`、`src/host/platform/{shell.ts,credential-permission.ts,redact.ts}` | 三态 `stat`；锁要**正向探测**；Windows 按**有效权限**（Deny 优先）；修复要二次确认 + **回读** |
| E 交付 | `package.json`、`VERSION`、`CHANGELOG.md`、`src/host/consts.ts`、`docs/desktop-acceptance-0.0.15.md` | 版本 0.0.15、协议 18、验收矩阵 |

## 2. 自动化证据都在哪

```bash
node --test "tests/*.test.mjs" "tests/**/*.test.mjs"   # 1253 条（本机跑会看到 3 条环境侧红，见 §5）
```

> **协议 19（2026-09-29 第二轮复查）**：审核 scope 绑定 —— 案例内 Tool 的判据从
> "落在工作空间之下"收紧成"精确等于**本轮案例目录**"，氚云记录查询移出审核子会话能力集，
> 审核根的 cwd 与沙箱边界都改成案例目录。`WORKBENCH_PROTOCOL = 19`；
> 装上升级后**必须完整退出重启**（否则旧宿主仍按工作空间级边界跑审核）。

本次改造新增/扩写的用例：

> 用例名里**有一部分**带设计编号（`host-access-migration` 是全部 10/10，
> `host-access-broker` 10/25、`host-access-classify` 9/16、`host-dws-local` 9/25、
> `host-access-consent` 3/15、`host-audit-policy` 3/9）—— 所以"按编号单跑"只在那些带编号的用例上成立；
> 要按编号找证据，用验收清单的追溯表 + `host-design-traceability.test.mjs`。

| 文件 | 条数 | 守什么 |
| --- | --- | --- |
| `tests/unit/host-access-broker.test.mjs` | 25 | 操作表封闭性、逐次提权、未授权零进程、写入目标比对、诊断 |
| `tests/unit/host-access-consent.test.mjs` | 15 | 授权 / 撤销状态机（含**写盘失败**与**刷新不许复活**） |
| `tests/unit/host-access-classify.test.mjs` | 16 | 九档归因（用真实报错样本片段） |
| `tests/unit/host-dws-local.test.mjs` | 25 | doctor 只读、三态 stat、锁探测、修复白名单、回读判据 |
| `tests/unit/host-access-migration.test.mjs` | 10 | **静态门禁**：不许绕开执行器 / Broker（B-01、B-01b、B-01c、B-01d） |
| `tests/unit/host-access-rpc-gate.test.mjs` | 4 | 未授权时 fs / 宿主凭据服务 / 网络**零调用** |
| `tests/unit/host-audit-policy.test.mjs` | 9 | 根与子会话的沙箱与审批策略 |
| `tests/unit/client-local-access.test.mjs` | 12 | 授权卡的每种状态（含版本不一致 fail closed） |
| `tests/unit/client-dws-local.test.mjs` | 5 | 修复按钮只在确诊时渲染 |
| `tests/unit/host-design-traceability.test.mjs` | 2 | **每条设计要求都要有证据归属**（没有就红） |
| `tests/unit/host-build-lock.test.mjs` | 3 | 真构建串行化的锁语义 |
| `tests/unit/host-case-dir-gate.test.mjs` | 7 | **案例目录信任域**：越界 → `policy`；前缀相似的兄弟目录不算在内；信任域未知 → 拒绝 |
| `tests/unit/host-system-ops.test.mjs` | 18 | system 操作：`openPath` 只开案例根内（信任域未知时**零 fs 探测**就拒绝） |
| `tests/unit/host-ifind-tool.test.mjs` | 58 | iFinD 结构化 Tool：协议协商、脱敏（**值级**净化与 schema 的对象路径分别覆盖） |
| `tests/unit/host-audit-lifecycle.test.mjs` | 52 | 审核生命周期：单条并发的**两个方向**、门禁顺序（冲突时零预检）、认领孤儿子会话 |
| `tests/unit/host-audit-scope.test.mjs` | 8 | **审核 scope**：越界/兄弟案例/子目录/`seqNo`·`objectId` 不一致/无身份/未知 childId/已结束/scope 不完整 一律拒绝；Windows 盘符·UNC 别名判同一位置，POSIX 大小写敏感 |
| `tests/unit/host-audit-root.test.mjs` | 17 | 审核根：**一个根只服务一个案例目录**、工作空间级旧根判过期不复用、`meta.cwd` = 案例目录、边界回读 = 案例目录 |

三条**交付形状**的机器判据（改 `files` / 入口 / 槽位必须先跑）：

```bash
node scripts/assert-pack.mjs           # 真实 tarball 清单 + 三条加载契约
node scripts/assert-pack.mjs --strict  # 发布形态：两平台六二进制 + manifest
node scripts/smoke-built.mjs           # 真 lib/index.js 走同源路由、真 lib/client.js 过 ModuleLoader
                                       # + **跑一遍卸载**：调用每个 effect 的 disposer，断言路由被摘、工具被注销
```

CI 上另外两处（本机跑不了）：`.github/workflows/ci.yml` 的 `windows-powershell` job 会
**在真实 Windows 上**跑 `tests/windows/powershell-contract.test.mjs`（含 `icacls /deny` 之后
判决必须翻成不可改、写实测必须失败的用例）；插件矩阵 job 跑 `compat:dsh`。

## 2.4 重启前必读：**这台机器上的运行时是 DSH 0.2.0-rc.1，判定为兼容**

协议 18 的宿主产物会 `import` 两个新的 DSH 包，而本仓 devDependency 装的是 0.1.7-rc.2。
"devDep 与运行时不同版本"这件事本身值得查清 —— 如果运行时不提供那两个包，
或者两版的 API 不一致，表现是**插件加载期就抛错 / 被标 disabled（面板根本不出现）**，
而不是某个功能不好用。2026-09-29 逐项核过：

| 检查 | 结果 |
| --- | --- |
| 这台机器实际在跑的 DSH | **0.2.0-rc.1**（从 `app.asar` 的依赖表读到，非推测） |
| DSH **自己**的 `evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.1')` | `undefined` = **兼容** ✅（0.1.7-rc.2 / 0.1.7 同样兼容） |
| 运行时是否有 `dsh-sandbox-policy` / `dsh-user-approval` | **都在**（0.2.0-rc.1） |
| 我 `import` 的名字：`setSandboxMode` / `setApprovalPolicy` | 两边都在，声明**逐字相同**（`(session, mode)` / `(session, policy)`） |
| 两个包的 `lib/` 在两版之间 | **逐字节相同**（5/5 与 8/8 个文件，`diff -r` 无差异） |

所以：无论 profile 解析到插件本地那份还是运行时那份，我依赖的那一面行为一致；
重启不会出现"插件装上了但整行被跳过"。想自己复核：

```bash
cd plugins/dsh-crwu-workbench
node -e "import('@deepseek-ai/dsh-app-boot').then(b=>console.log(b.evaluatePluginCompatibility(require('./package.json'),{},'0.2.0-rc.1')))"
```

> 括号里那条命令在插件目录下跑（`@deepseek-ai/dsh-app-boot` 由 devDependencies 提供）。

## 2.5 重启前必读：你机器上现在是**旧版授权**，第一次打开会看到授权卡

2026-09-29 在本机核过实际的 `~/.dsh/crwu-workbench.json`：里面是
`trustCredentials: true` 而**没有** `localAccessConsent`（21 条审核记录、工作空间都在）。

按设计 A-01，这种文件被判定为 **`outdated`（不是 `granted`）**——旧授权只覆盖"读本机凭据"，
而协议 18 的范围是五项固定能力，**不许静默扩权**。所以重启后：

1. 第一屏是**授权卡**（不是环境页），文案是「这是旧版本留下的授权（只覆盖读取本机凭据）：
   授权范围已更新，请重新允许一次」；
2. 氚云 / 钉钉 / OSS 凭据 / iFinD 在重新允许之前都是**阻塞**状态；
3. 点一次「允许」之后，磁盘上写新的 `localAccessConsent`，并且**旧键会被抹掉**
   （单一事实源；`host-access-consent.test.mjs` 有一条升级场景用例钉住这件事）。

**这不是故障，也不是你的配置丢了** —— 21 条审核记录与工作空间都原样保留。验收时请把
P-01/P-02 按"升级场景"来读：它们描述的是"首次打开、尚未同意"的行为，与你现在看到的一致。

**点「允许」之前/之后各跑一次这条（只读，不会改任何文件）：**

```bash
node scripts/preflight-state.mjs
```

它打印：现在判成什么授权状态、有多少条审核记录、以及**在内存里**模拟一次「允许」之后
会消失/新增哪些键、其余字段是否逐字节保留。本机实测输出（你的真实文件）：

```
consentNow: outdated    records: { audits: 21, hasLock: true }
simulatedGrant: { writeAccepted: true, consentAfter: granted,
                  removedKeys: ["trustCredentials"], addedKeys: ["localAccessConsent"],
                  otherKeysChanged: [], auditsPreserved: true }
```

也就是说：**那次点击只动授权字段**，21 条审核记录、`auditRoot`、工作空间与占用锁都不变
（这条不变式有永久用例钉着：`host-access-consent.test.mjs` 的升级场景用例，
逐键逐字节比对，注入"顺手丢字段"的回归会立刻变红）。

> 如果你希望先验证一次"完全新鲜"的路径：把状态文件备份走
> （`cp ~/.dsh/crwu-workbench.json /tmp/crwu-state-backup.json`）再移开，就是全新安装的现场；
> 验完把备份放回即可。

## 3. 真机验证的最短路径（三条 curl，约两分钟）

在**已经重启过新版**的 profile 上（重启前先确认版本徽章是 `v0.0.15`）：

```bash
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web-3080.log | tail -1 | cut -d= -f2)
RPC() { curl -s -X POST "http://127.0.0.1:3080/api/crwu-workbench?token=$TOKEN" \
        -H 'Content-Type: application/json' -d "$1"; echo; }

# ① 还没允许时：读凭据必须什么都读不到，而且**一个进程都不起**
RPC '{"op":"oss-cred","args":{}}'          # 期望 cred.exists=false，reason 里是"本机访问尚未允许：oss.config.read …"
RPC '{"op":"access-diagnostics","args":{}}' # 期望最新一条是**被拒**的记录：errorClass=not-authorized、processStarted=false
                                            #（被拒也要留痕，但没有任何"跑过 ossutil"的证据）

# ② 允许之后再读：这时应当读到真实配置（掩码 AK + endpoint）
#    先在界面上点「允许」，然后重跑上面第一条

# ③ 撤销之后：立刻回到读不到的状态，且刷新页面也不会复活
RPC '{"op":"local-access-revoke","args":{}}'
RPC '{"op":"oss-cred","args":{}}'          # 期望又是 exists=false + 未授权
RPC '{"op":"env","args":{}}'                # 期望顶层 localAccess.state 是 revoked（不是 granted）
```

这三条分别对应上次复审抓到的 **P1-1**（OSS 在审核子会话里必然失败）与 **P1-3**
（撤销后仍可读凭据）。第二条要在审核子会话里再验一次才是完整的 P-14：
发起一次审核，子会话用 `crwu_audit_oss_publish` 真的传一个交付件。

其余人工矩阵按 [`desktop-acceptance-0.0.15.md`](desktop-acceptance-0.0.15.md) 走；
其中已由 CI 覆盖的格子在该文档 §1.1 里列了出来，不必重复造条件。

## 4. 我**没有**验证的（不要当成已验证）

| 项 | 为什么没验 | 谁会验 |
| --- | --- | --- |
| 真实沙箱下的越界写（C-04 / C-05 / C-06） | 需要真实子代理 + 真实沙箱，替身证明不了 | 你（P-12 / P-13 / P-14） |
| **同工作空间兄弟案例**是否真的写不进去（协议 19 的第 4 条） | 单元测试只证得了"边界/ cwd 都设成案例目录 + 门禁按精确路径判"；"通用 shell / fs 在兄弟案例下被沙箱拒绝"只能真机 | 你（P-13 ②，先手工建一个兄弟案例目录） |
| 锁文件**自身**的权限（目录正常） | `host-dws-local` 的 P1 用例（POSIX 与 Windows 各一条：确诊 → 只改锁文件 → 回读）| 自动化 |
| 锁归因的两个条件（原始失败 + 正向探测） | `host-access-classify`、`host-dws-local` 的 P2 反例 | 自动化 |
| Windows 的 ACL / 锁分支（Deny 优先、**部分 Deny**、写实测、`icacls`、**另一进程持锁**） | 本机没有 `pwsh`；只有纯函数 fixture 与命令形状 | CI 的 `windows-powershell` job（2026-09-29 补：`/deny (M)`、`/deny (W)` 与真实持锁进程三种现场都进了合同测试） |
| `compat:dsh` 的"每条 DSH 线真装一遍" | 需要 npm + 网络（本机只有 pnpm 垫片）；**判定本身**已用 DSH 自己的 `evaluatePluginCompatibility` 覆盖 | CI 的插件矩阵 |
| 审核链路在真机上的端到端行为 | 只能由你点「AI 审核」 | 你（P-12…P-14） |
| 三条人工矩阵 | 需要干净的非管理员账户 | 你 |

## 5. 已知的测试侧瑕疵（不是插件逻辑）

**先看这两条：跑全量前确认环境，否则会看到两类"假红"。** 两种都在本机复现过、都已定性，
不要当成插件缺陷：

| 现场 | 症状 | 机制 |
| --- | --- | --- |
| `npm` 不在 `PATH` | 3 条红：`an installed tarball…`、`release strict mode fails when bin/ is absent entirely`、vendored dws provenance | 它们都要在包根起 `npm`（`npm pack` / `npm run`），拿不到就 `spawn npm ENOENT` |
| 用 DSH 自带二进制当 `node`（`DSH_DESKTOP_NODE_EXECUTABLE`） | `原生 shell 合同（posix）` 的 2 条子用例红（`expected: 0, actual: null`） | 该用例把 `process.execPath` **拷进**临时目录再调用；而 `process.execPath` 是 Electron 应用二进制，macOS 拒绝执行"被复制、签名失效"的二进制 → 子进程被信号杀死（`status: null`）。用真正的 Node 跑必过 |

正确基线（`npm` 在 `PATH`、`node` 是真 Node，也就是你自己的 `npm test`）：`1242 tests / 1238 pass / 1 skip / 0 fail`。只有在上面那两种现场下才会看到 2~3 条红。


`npm test` 在一次全量跑里偶发红在 `an installed tarball can actually be installed and imported`：
有两处测试会真的驱动构建系统，而 `node --test` 并行跑文件时会互相踩（手工在同一个包里并发跑
两次 `npm pack` 可稳定复现）。已经用 `tests/helpers/build-lock.mjs` 的 `mkdir` 文件锁串行化，
锁的语义由 `host-build-lock.test.mjs` 钉住（不交叠 / 抛错也释放 / 重入立刻报错）。若**仍然**
偶发红，请把失败输出发我 —— 那说明还有第三处真构建没进锁。
