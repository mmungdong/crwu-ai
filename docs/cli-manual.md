# crwu CLI 说明书（H3Yun 员工级访问）

> **给 Agent 的话**：读完本文即可完整操作 `crwu` 对接氚云，**不需要阅读整个项目**。
> 本文档是 CLI 使用的**唯一权威来源**；命令、参数、环境变量或通道行为变化时，必须
> 同步更新本文，并在 [`docs/CHANGELOG.md`](CHANGELOG.md) 追加纪要（见
> `AGENTS.md` 的"CLI Manual & Changelog"纪律）。

## 1. 这是什么

`crwu` 是单二进制 Go CLI，让 AI/员工以**某个员工本人的氚云身份**读取企业数据
（应用/表单/记录/附件），**不需要氚云密码、不需要运维服务端**。

- 身份载体：员工在 `h3yun.com` 用钉钉扫码得到的**网页会话 JWT**，绑定在本机
  OS 凭据存储（keyring），48 小时有效、可续期。
- 数据边界：每条命令都按**绑定员工**在氚云里的角色/权限过滤返回。
- 命令目录：`crwu scheme` 输出机器可读的全量命令目录（AI 从这里自动发现）。

## 2. 环境与前置

- 需要已构建的二进制 `./bin/crwu`（构建：仓库内 `make build`）或绝对路径 `/tmp/crwu` 等。
- 可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `H3YUN_BASE_URL` | 覆盖氚云控制台地址（测试用） | `https://www.h3yun.com` |
| `H3YUN_TOKEN` | 仅 **agent 通道**命令用（见 §6） | 无 |

## 3. 上手：绑定员工会话（一次性，每台机器每员工一次）

1. 让员工在浏览器打开 `https://www.h3yun.com`，用钉钉扫码登录（员工无氚云密码也可）；
2. DevTools → Network → 刷新/操作一次 → 找到任一发往 `h3yun.com/v1/...` 的请求；
3. 复制其请求头 `Authorization` 的 Bearer 值（`eyJhbGci...` 整串，**不要带 `Bearer ` 前缀**也行）；
4. 执行：

```bash
crwu h3yun session bind --token '<JWT>'
crwu h3yun session status        # 应显示 engineCode / userId / expiresIn
```

> 安全红线：token **只应出现在本机命令**，绝不写入日志/文件/scheme 输出/
> 聊天/提交；会话在 `个人信息 → 管理凭证` 页无法吊销网页会话时，可执行
> `session clear` 后让员工重新扫码。

## 4. 常用命令速查

### 会话管理

| 命令 | 说明 |
|---|---|
| `crwu h3yun session bind --token <jwt>` | 绑定员工网页会话到本机 |
| `crwu h3yun session status` | 查看绑定身份/引擎/剩余有效期 |
| `crwu h3yun session refresh` | 续期（48h 内调用一次刷新） |
| `crwu h3yun session clear` | 清除绑定 |

### 应用与表单

| 命令 | 说明 |
|---|---|
| `crwu h3yun apps list [--keyword <名称>]` | 员工可访问的应用列表 |
| `crwu h3yun apps children --app <应用编码>` | 某应用下的表单（`code` 即表单 `schemaCode`） |
| `crwu h3yun forms search --keyword <名称>` | 跨应用按名称搜表单 |

### 记录

| 命令 | 说明 |
|---|---|
| `crwu h3yun records list --schema <编码> [--page n --size n] [--keyword <kw>]` | 分页查记录（`ObjectId` 即记录 ID） |
| `crwu h3yun records get --schema <编码> --id <记录ID>` | 单条详情（字段为 `F0000xxx`，人员类字段带 `*_Name`） |

### 附件

| 命令 | 说明 |
|---|---|
| `crwu h3yun files list --schema <编码> --id <记录ID>` | 列出该记录全部附件（字段/文件名/类型/大小/下载URL） |
| `crwu h3yun file download --schema <编码> --id <记录ID> --out <目录>` | 下载全部附件到本地（原名 + 自动去重） |

### Agent 网关（`h3pat`，需氚云开通数据面）

| 命令 | 说明 |
|---|---|
| `crwu h3yun ping` | 与 Agent 网关握手（`H3YUN_TOKEN`） |
| `crwu h3yun tools` | 列出网关可见工具（含输入 schema） |
| `crwu h3yun apps search --keyword <名称>` | 按关键字搜应用（网关工具） |
| `crwu h3yun records query --schema <编码> --sql <只读SELECT>` | 受控只读 SQL 查询 |

### 通用

| 命令 | 说明 |
|---|---|
| `crwu help` | 帮助 |
| `crwu scheme` | 机器可读全量命令目录（AI 发现用） |
| `crwu version` | 版本 |

## 5. 典型任务流程（照抄即用）

**找应用 → 看表单 → 查记录 → 拿附件：**

```bash
crwu h3yun apps list
crwu h3yun apps children --app <从上面拿到的 appCode>
crwu h3yun records list --schema <表单 code，即 children 输出的 code> --keyword <关键词>
crwu h3yun records get  --schema <编码> --id <ObjectId>
crwu h3yun files list   --schema <编码> --id <ObjectId>
crwu h3yun file download --schema <编码> --id <ObjectId> --out ./附件
```

**纪律**：`appCode`/`schemaCode`/`recordId` 一律来自上一步命令的返回值，**禁止猜测或编造编码**；
关键字搜不到先放宽关键字或换表单，不要硬试 ID。

## 6. 双通道与已知限制

| 通道 | 凭证 | 现状 |
|---|---|---|
| 网页会话（§3） | 员工扫码 JWT | ✅ 全部读取/附件命令可用 |
| Agent 网关 | 个人访问凭证 `h3pat_*` | ⏳ 若氚云未开通数据面，任意 `tools/call` 会返回 `h3yun.read.upstream_error`（上游响应异常）——**这是氚云平台侧问题，不是客户端故障**，重试无意义，找氚云开通即可 |

已知坑：
- 单条"详情"务必用 `records get`（走过滤查询）；氚云 `loaddata` 接口会返回空壳，不要用。
- 附件下载 URL 为 `www.h3yun.com/Form/Download/?AttachmentID=<FileId>`，需带会话鉴权；`file download` 已封装。
- 记录字段输出含 `*_Original` 冗余结构属正常；人员/部门字段同时有 `*_Name` 可读名。

## 7. 给 Agent 的调用约定

- 输出：成功 = 退出码 0，stdout 为 `{"ok":true,"data":...}` 纯 JSON；用法错误 = 退出码 2；运行错误 = 退出码 1（诊断在 stderr）。
- 需要发现命令时先跑 `crwu scheme`，不要凭记忆调用参数。
- 本 CLI 当前**全部为只读操作**；未来加入写/审批命令后，执行前必须先向用户声明并等确认。
- token 不得出现在任何工具输出/日志/会话记录里；若需重绑请用户自己执行 bind。
