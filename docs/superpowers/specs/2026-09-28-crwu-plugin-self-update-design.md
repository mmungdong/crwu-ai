# CRWU 插件版本检查与自助更新设计

> [!NOTE]
> **状态：历史快照（2026-09-28）。** 本文保留当时的设计上下文，不代表当前实现或操作口径。现行入口见
> [`README.zh-CN.md`](../../../README.zh-CN.md)。

日期：2026-09-28

状态：已确认

实现范围：仅 `crwu-ai` 仓库中的 `plugins/dsh-crwu-workbench`

## 1. 背景

`dsh-crwu-workbench` 已发布 npm 版本 `0.0.10` 与 `0.0.11`；**`0.0.12` 是首个包含自更新能力的版本**。员工通过 DeepSeek Harness 桌面应用使用插件，主要位于国内网络环境，可能无法稳定、快速地从 npm 官方 registry 下载包。

本功能让已经安装更新器版本的员工在 CRWU 内看到新版本提示，点击按钮完成下载安装，再由界面提示员工完全退出并重新打开 DeepSeek Harness，使新版本生效。

DeepSeek Harness 桌面端不在本次修改范围内。CRWU 不尝试杀进程、拉起 DSH、调用 Electron 私有能力或模拟桌面端重启。

## 2. 目标与非目标

### 2.1 目标

- CRWU 启动后在后台检查稳定版更新，不阻塞工作台打开。
- 国内网络默认优先使用 `https://registry.npmmirror.com/`。
- 镜像未同步或不可达时，按 DSH Plugin Manager 的 registry 策略尝试可用后备源。
- 用户确认后只安装 Host 已确认的精确版本。
- 安装过程可观察、不可并发，并能从页面刷新或进程中断中恢复。
- 安装成功后明确提示员工完全退出并重新打开 DeepSeek Harness。
- 重启后核对实际运行版本，并给出一次性成功提示。
- 本地开发安装不会被 npm 包覆盖。

### 2.2 非目标

- 不修改 `deepseek-harness` 仓库或桌面应用。
- 不自动重启、退出或重新拉起桌面应用。
- 不支持降级、任意包安装或用户输入任意 registry URL。
- 第一版不支持 beta、next 等预发布通道。
- 第一版不实现强制升级、灰度发布、静默后台安装或自建版本清单服务。
- 不复制 DSH Plugin Manager 已经提供的 profile 锁、pnpm 执行、回滚、兼容性检查和 registry 策略。

## 3. 方案选择

评估过三种版本发现方案：

1. **CRWU Host 查询 registry，使用 DSH Plugin Manager 安装，采用本方案。** CRWU 自己拥有产品状态和界面，DSH 负责当前 profile 的可靠包操作。
2. **依赖第三方 Plugin Hub。** 开发量较小，但会形成插件之间的隐式依赖，其 HTTP 路由与实现细节不是 CRWU 的稳定接口。
3. **自建发布清单服务。** 可以提供灰度、公告和强制升级，但当前需求不需要额外服务及其运维成本。

安装后重启同样评估过三种方案：

1. **用户手动退出并重新打开桌面应用，采用本方案。** 不越过 CRWU 仓库边界。
2. 修改 DeepSeek Harness 桌面端，新增受限重启 API。体验更完整，但超出允许范围。
3. CRWU 按端口结束宿主并执行 `dsh web`。这会绕过桌面应用生命周期，并可能丢失 desktop profile、认证状态和启动参数，禁止采用。

## 4. 总体架构

系统分为三个职责单一的部分：

| 组件 | 职责 |
| --- | --- |
| CRWU Client | 展示版本、更新提示、安装阶段、错误和重启说明；不接触文件系统、registry 或命令 |
| CRWU Host 更新模块 | 检查版本、缓存结果、控制安装状态、持久化恢复标记、调用 DSH Plugin Manager |
| DSH Plugin Manager | 使用当前 profile 和桌面应用内置 pnpm，执行加锁安装、registry 回退、兼容性检查与失败回滚 |

Host 新增独立的 `update` 领域，不把网络、安装和状态机继续堆入 `ops/core.ts`：

```text
src/
├── host/update/
│   ├── registry.ts        # registry 元数据请求、响应约束与版本提取
│   ├── check.ts           # 缓存、候选合并和 SemVer 结论
│   ├── install.ts         # Plugin Manager 适配与错误分类
│   ├── state.ts           # 单飞状态机与重启恢复
│   ├── persist.ts         # updateState 在工作台配置中的解析和写入
│   ├── types.ts
│   └── consts.ts
├── client/features/update/
│   ├── update-store.ts
│   ├── UpdateDialog.tsx
│   ├── view-model.ts
│   ├── types.ts
│   └── consts.ts
└── shared/update/
    ├── types.ts           # Host/Client 线协议
    └── consts.ts
```

实际文件数量可以在实现时按职责合并，但 registry 请求、安装协调、状态恢复和 UI 不得混入一个文件。

## 5. 版本发现

### 5.1 当前版本

当前运行版本继续使用 Host 构建常量 `PLUGIN_VERSION`，由 `boot` 返回给 Client。Client 请求中的版本值不参与判断。

`buildKind === "dev"` 时将更新状态设为 `unsupported/development-install`，不展示安装按钮。这样 `link:`、`file:` 等本地开发形态不会被 npm 包覆盖。

### 5.2 最新版本来源

Host 请求 registry 的 package metadata，并读取：

- `dist-tags.latest`：稳定通道最新版本；
- `time[version]`：存在时作为可选发布时间；
- 对应版本的基本包信息，用于确认包名和版本。

默认公共源顺序：

1. `https://registry.npmmirror.com/`
2. `https://registry.npmjs.org/`

Host 可以并行请求两个公共源，分别设置 3 秒和 5 秒超时，并取成功结果中更高的合法 SemVer。npm 官方源超时不影响镜像结果，也不阻塞 CRWU 页面打开。

检查前先调用 `pluginManager.registries()` 识别 profile 的 registry 类型。若 profile 明确使用 npm 官方源或 npmmirror，执行上述公共源检查；若它使用其它企业私有源，则不绕过企业源访问公共 registry，也不尝试自行读取可能需要认证的私有地址，更新状态设为 `unsupported/enterprise-registry`。界面只显示“当前由企业源管理”，不展示 registry URL。

### 5.3 校验与缓存

- 包名固定为 `dsh-crwu-workbench`。
- 使用标准 SemVer 库比较版本，禁止字符串比较。
- 仅接受 `dist-tags.latest` 指向的正式版本；预发布版本不进入候选。
- 禁止降级；最新版本必须严格高于当前版本才进入 `available`。
- 每个响应最多读取 1 MiB，超过上限视为无效。
- 自动检查缓存 6 小时；启动时先返回有效缓存，再在缓存过期后后台刷新。
- 用户点击“检查更新”时绕过缓存。
- 自动检查失败后至少等待 10 分钟再重试。
- 从未成功检查过时，错误不能被展示成“已是最新版”。
- 缓存可持久化到工作台状态文件，使桌面应用重启后可以先展示最近一次结果；过期结果只作为“上次检查”，不能授权安装。

### 5.4 检查状态

```ts
type UpdateCheckState =
  | { status: "idle" }
  | { status: "checking"; cached?: UpdateCandidate }
  | { status: "up-to-date"; checkedAt: string }
  | { status: "available"; candidate: UpdateCandidate; checkedAt: string }
  | { status: "unsupported"; reason: "development-install" | "manager-unavailable" | "enterprise-registry" }
  | { status: "error"; kind: UpdateCheckErrorKind; checkedAt: string }
```

`UpdateCandidate` 至少包含 `currentVersion`、`targetVersion`、`sourceKind`，并可包含 `publishedAt`。不得把 registry 返回的任意字段原样传给 Client。

## 6. 安装机制

### 6.1 使用 DSH Plugin Manager

CRWU Host 使用当前 Context 的 `pluginManager` 服务安装：

```ts
ctx.pluginManager.installBundle(
  `dsh-crwu-workbench@${targetVersion}`,
  { registry: "https://registry.npmmirror.com/" },
)
```

这里的代码仅表达调用方向。实现必须使用 DSH 提供的公开类型和生命周期约束。

采用该服务的原因：

- 自动定位正在运行的 `desktop` profile，不硬编码 `web`；
- 使用桌面应用自带 Node.js 和 pnpm，不要求员工安装全局 `dsh` 或 `pnpm`；
- 持有 profile 写锁，避免与其他插件操作并发修改；
- 安装失败或取消时恢复 `package.json` 与 `pnpm-lock.yaml`，并修复安装状态；
- 负责完整性、bundle 结构和 DSH 版本兼容性检查；
- 返回 `restart-required`，准确表达现有 bundle 更新后的生效条件；
- 对公共源 profile，先请求 npmmirror，并在镜像无目标版本、超时或网络失败时按 DSH 的 registry 计划尝试 npm 官方源；企业私有源不进入自助安装。

CRWU 不使用 `node:child_process`，也不经 `ctx.shell` 重新实现包管理命令。

### 6.2 安装授权

安装请求的安全约束：

- Client 只发送“安装当前候选版本”的操作，不提交包名、版本、registry、命令或 profile。
- Host 只接受自己最近一次成功检查并仍未过期的候选版本。
- 安装 spec 由 Host 用固定包名和候选版本构造。
- 安装前再次确认目标版本仍高于当前运行版本。
- 同一 Host 实例只允许一个 CRWU 更新任务；重复点击返回现有任务。
- 有 CRWU 审核任务运行时允许检查，但拒绝开始安装。
- 安装进行中暂停新的自动版本检查；手动检查返回当前安装状态。

### 6.3 安装状态机

```text
idle
  └─ check ─→ checking
                 ├─→ up-to-date
                 ├─→ check-error
                 └─→ available
                          └─ confirm ─→ installing
                                            ├─→ install-error
                                            ├─→ cancelled
                                            └─→ awaiting-restart
                                                        └─ 手动退出并重开桌面应用
                                                                  └─→ updated
```

安装阶段只展示可证实的离散阶段，不生成虚假百分比：

- 连接国内镜像；
- 下载；
- 校验并安装；
- 正在取消；
- 安装完成，等待重启。

若 DSH Plugin Manager 提供带 request id 的安装进度事件，Host 将其映射为上述阶段；Client 不直接订阅 DSH 内部事件。

## 7. 持久化与恢复

更新状态写入现有 `~/.dsh/crwu-workbench.json` 的独立 `pluginUpdate` 字段，并继续使用现有的合并写入机制，不能覆盖工作空间、授权或审核记录。

持久化内容只保存恢复所需的非敏感字段：

```ts
interface PersistedPluginUpdate {
  phase: "installing" | "awaiting-restart"
  fromVersion: string
  targetVersion: string
  startedAt: string
  installedAt?: string
}
```

registry URL、pnpm 输出、认证信息和任意命令不进入该文件。

启动恢复规则：

1. `phase=installing` 且当前没有活动安装：
   - `pluginManager.listBundles()` 返回的已安装 bundle 版本是目标版本：转为 `awaiting-restart`；
   - profile 仍是旧版本：报告安装中断并允许重试；
   - 磁盘版本无法确认：报告状态异常，不自动重装。
2. `phase=awaiting-restart`：
   - 当前运行 `PLUGIN_VERSION` 等于目标版本：清除标记，展示一次更新成功；
   - 当前运行版本高于目标版本：视为通过其他方式完成了更新，清除标记；
   - 当前 Host 仍是旧版本、磁盘已是目标版本：继续提示重启；
   - 磁盘不是目标版本：报告安装状态异常。
3. 安装失败或取消：不写入 `awaiting-restart`。

一次性成功提示可以由 boot 恢复结果携带，不在 Client localStorage 中建立另一份事实源。

## 8. 手动重启体验

安装成功后的固定提示：

> CRWU v{version} 已安装。请完全退出并重新打开 DeepSeek Harness，使新版生效。

“完全退出”必须明确说明：macOS 关闭窗口不一定退出应用，应从应用菜单选择退出，或使用 `Command-Q`。

CRWU 不展示无法兑现的“立即重启”按钮。更新面板提供：

- “我知道了”；
- 再次打开时仍可见的“等待重启”状态；
- 面向维护者的脱敏诊断入口。

安装完成后当前 Host 仍是旧代码，而磁盘中的 Client 产物可能已经更新。若用户刷新而没有退出桌面应用，Host/Client 可能短暂不一致。`WORKBENCH_PROTOCOL` 从 15 升至 16，Client 检测到协议不一致时阻止新审核，并直接提示完全退出并重新打开桌面应用。

## 9. UI 行为

- 启动自动检查不弹窗。
- 发现新版本后，顶部现有版本徽标显示 `v{current} · 有更新`。
- 点击徽标打开更新面板，显示当前版本、目标版本、可选发布时间、来源类型和操作按钮。
- 手动检查失败时展示错误；后台自动检查失败时保留旧缓存，不打断用户。
- 安装按钮在以下状态禁用：本地开发安装、候选过期、审核任务运行中、另一个更新任务运行中、Plugin Manager 不可用。
- `awaiting-restart` 状态优先于新的版本提示，避免在重启前再次修改 profile。
- 用户可见中文全部进入 `src/client/locales/zh-CN.ts`。
- 新类名继续使用 `crwu-audit-` 前缀，并使用现有 DSH 主题变量。

## 10. 错误分类

| 底层错误 | 用户提示 | 行为 |
| --- | --- | --- |
| 镜像超时或不可达 | 国内镜像暂时无法连接 | 由 Plugin Manager 按安全 registry 计划尝试后备源 |
| 镜像没有目标版本 | 新版本正在同步 | 对公共源配置尝试官方源；企业私有源不越权回退 |
| 所有允许的源均不可用 | 暂时无法下载安装 | 保留旧版本，允许重试 |
| 磁盘空间不足 | 磁盘空间不足，无法完成更新 | 不自动重试 |
| profile 无写入权限 | 无法修改插件目录 | 引导联系管理员 |
| 完整性校验失败 | 下载内容校验失败 | 回滚，不进入等待重启 |
| DSH 版本不兼容 | 当前桌面版不支持此 CRWU 版本 | 要求先升级 DeepSeek Harness |
| 依赖构建脚本被阻止 | 插件安装需要管理员处理依赖脚本 | 不自动批准脚本 |
| profile 写锁超时 | 其他插件操作正在进行 | 稍后重试 |
| 安装被取消 | 已取消更新，当前版本继续可用 | 回到可重试状态 |
| 未分类失败 | 更新失败，当前版本仍可使用 | 提供脱敏诊断信息 |

普通界面不直接展示完整 pnpm 输出。诊断视图只给出分类、阶段、时间、目标版本、公开来源类型和脱敏后的短诊断，并可展示 DSH Plugin Manager 返回的日志文件位置。私有 registry 地址、认证头、Token 和签名信息不得进入 Client、日志摘要或状态文件。

## 11. Host/Client 接口

新增操作建议：

| 操作 | 方法 | 作用 |
| --- | --- | --- |
| `update-status` | POST（现有 RPC 操作） | 返回缓存、安装任务和恢复状态 |
| `update-check` | POST | 用户主动绕过缓存检查 |
| `update-install` | POST | 安装 Host 当前有效候选，不接受版本参数 |
| `update-cancel` | POST | 取消仍处于可取消阶段的当前安装 |

四个操作全部复用现有同源 POST 路由、Origin 校验、请求体上限和操作名白名单。返回值使用 `src/shared/update/types.ts` 的闭合判别联合。新增操作和字段属于跨进程协议变化，因此 `WORKBENCH_PROTOCOL` 必须升至 16。

## 12. 依赖与兼容性

- 插件包增加 `@deepseek-ai/dsh-plugin-manager` 的 `^0.1.7-rc.2` peer/dev dependency，用于公开服务类型和测试；运行时代码只做类型导入。
- 插件增加 `semver` 运行时依赖及其 TypeScript 类型，避免维护不完整的版本解析器。
- 现有 `engines.dsh = ^0.1.7-rc.2` 保持不变，该版本线提供设计所需的 Plugin Manager API；真实 tarball 安装测试继续验证兼容性。
- `pluginManager` 是自助安装的可选能力：Host 在检查或安装时通过 `ctx.get("pluginManager")` 获取，不把它加入阻止整个插件激活的硬 `inject`。服务缺失时状态为 `unsupported/manager-unavailable`，界面提示由管理员手动更新。

## 13. 测试计划

### 13.1 版本检查

- SemVer 的大于、等于、小于和 prerelease 用例；
- mirror 与 npm 结果合并，取更高合法版本；
- 超时、404、非法 JSON、错误包名、超大响应；
- 6 小时缓存、手动绕过缓存、10 分钟失败退避；
- 从未成功检查时不误报“已是最新版”；
- `buildKind=dev` 禁用更新。

所有单元测试使用注入式 fetch 替身，不依赖公网。

### 13.2 安装状态机

- Host 固定包名并使用缓存候选，Client 不能选择版本；
- 候选过期、审核运行中和重复点击；
- Plugin Manager 的 installing、applying、restart-required、failed、cancelled 映射；
- network、timeout、not-found、disk-full、permission、integrity、build-blocked、incompatible-version 和未知错误；
- 安装失败不产生等待重启标记；
- 日志和返回体不包含凭据及私有 registry 地址。

### 13.3 恢复

- `installing` 与磁盘目标一致、不一致、未知三种恢复；
- `awaiting-restart` 与当前版本相等、更高、更低；
- 页面刷新继续观察同一任务；
- 更新后 Host/Client 协议不一致时阻止新审核；
- 更新状态写入不覆盖现有工作台配置字段。

### 13.4 Client

- 版本徽标、更新面板和等待重启提示；
- 自动检查失败不打断页面；
- 审核运行中按钮禁用；
- macOS 完全退出说明；
- 中文文案集中管理；
- 新类名、主题变量和样式注入生命周期符合现有门禁。

### 13.5 构建与交付

- `npm run typecheck`；
- 相关单元测试与完整 `npm test`；
- `npm run build`；
- `npm run smoke:built`；
- `npm run pack:assert` 和发布前的 `pack:assert:strict`；
- `npm publish --dry-run`；
- 临时 desktop profile 安装 tarball，验证 bundle 加载和 Plugin Manager 服务可用；
- 使用模拟 registry 完成旧版到新版的端到端流程。

## 14. 验收标准

1. 国内无 VPN 网络中，检查过程不阻塞 CRWU 打开。
2. 已安装更新器的旧版能发现 npm `latest` 指向的新正式版本。
3. 点击更新后安装精确版本，且优先走 npmmirror。
4. 镜像不同步或不可达时，只按 DSH 安全 registry 计划回退。
5. 安装成功后明确提示完全退出并重新打开 DeepSeek Harness。
6. 未重启前刷新页面仍显示等待重启，不重复安装。
7. 重启后 boot 返回新版本，等待标记被清理，并显示一次成功提示。
8. 工作空间、凭据授权、审核历史和运行结果不因更新状态写入而丢失。
9. 安装失败后旧版继续运行，profile 文件由 Plugin Manager 恢复。
10. `link:` / `file:` 开发安装不会被 npm 更新覆盖。
11. 代码、文档和测试改动全部位于 `crwu-ai` 仓库。

## 15. 首次上线与版本迁移

npm 上的 `0.0.10` / `0.0.11` 都不包含更新检查代码，因此它们无法自行发现首个带更新器的版本；
两个版本的用户都需要**手动完成一次**引导升级到 `0.0.12`。

推荐发布节奏：

```text
发布 0.0.12：首次包含版本检查和自助安装（原计划曾写作 0.0.11，实际 0.0.11 已先发布且不含更新器）
        ↓
0.0.10 / 0.0.11 用户按发布手册手动更新一次并重启桌面应用
        ↓
从 0.0.12 开始由 CRWU 自动发现和安装
```

`0.0.12` 的 CHANGELOG、README 和发布说明必须明确：

> 本版本首次加入自动更新功能。**0.0.10 与 0.0.11 都不含更新器**，两个版本的用户都需要手动更新至
> 0.0.12 一次；从 0.0.12 起，后续稳定版本可在 CRWU 内直接检查与安装。安装完成后请完全退出并重新打开 DeepSeek Harness。

实现完成后同步更新插件的中英文 README、CHANGELOG 和 `docs/releasing.md`。正式发布仍遵循 `plugin-v<semver>` tag 工作流，不在本功能中自动发布、推送或创建 tag。
