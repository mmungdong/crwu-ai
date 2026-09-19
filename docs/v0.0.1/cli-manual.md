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

- 需要已构建的二进制 `./bin/darwin/crwu`（macOS，构建：仓库内 `make build`；
  Windows 产物为 `./bin/windows/crwu.exe`）或绝对路径 `/tmp/crwu` 等。
- 可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `H3YUN_BASE_URL` | 覆盖氚云控制台地址（测试用） | `https://www.h3yun.com` |
| `H3YUN_TOKEN` | 仅 **agent 通道**命令用（见 §6） | 无 |

## 3. 上手：绑定员工会话（一次性，每台机器每员工一次）

**推荐（员工自助扫码，令牌不进对话/LLM）**

```bash
crwu h3yun session login
crwu h3yun session status        # 应显示 engineCode / userId / expiresIn
```

- crwu 自动打开浏览器窗口（优先系统默认浏览器，需 Chromium 系；找不到时设
  `CRWU_BROWSER`），直达钉钉登录入口 `h3yun.com/entry/login/dingtalk`；
- 员工在弹出窗口用**钉钉扫码**完成登录（无需氚云密码）；
- 会话由 crwu 经浏览器直接读取（cookie 双域 + localStorage/document.cookie
  兜底），**校验有效后才写入**本机 keyring；令牌从不打印、不外传。

> ⚠️ **AI 宿主沙箱注意**：在受沙箱隔离的 Agent 环境里，`session login` 派生的
> GUI 浏览器会被沙箱拦截而无法弹出窗口（报 `websocket close 1006`、stderr 含大量
> file-write 被拒）。应**脱离沙箱 + 前台**运行本命令，并可用
> `CRWU_BROWSER` 显式指定 Chromium 系浏览器（如 Edge）路径。

**回退（受信 IT/本机粘贴，仅自动流程不可用时）**

1. 让员工在浏览器打开 `https://www.h3yun.com` 扫码登录；
2. 绑定者在本机执行 `crwu h3yun session bind --token '<JWT>'`（JWT 取自已登录
   浏览器的请求头 `Authorization`，`eyJhbGci...` 整串，不带 `Bearer ` 前缀）。

> 安全红线：token 只出现在**本机命令**；绝不写入日志/文件/scheme 输出/聊天/
> 提交，绝不让 Agent 代看或代贴。需要吊销/换人时先 `session clear` 再重登。

## 4. 常用命令速查

### 会话管理

| 命令 | 说明 |
|---|---|
| `crwu h3yun session login` | 员工自助登录：自动开浏览器扫码并绑定（令牌不进对话） |
| `crwu h3yun session bind --token <jwt>` | 绑定员工网页会话到本机（回退/受信路径） |
- 自动续期：依赖会话的读命令执行前，若剩余 ≤36h 先静默 refresh；已过期则提示
  重新执行 `crwu h3yun session login`
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
| `crwu h3yun records list --schema <编码> [--page n --size n] [--keyword <kw>] [--filter <条件>]` | 分页查记录（`ObjectId` 即记录 ID）；`--filter` 按字段条件筛选（见下） |
| `crwu h3yun records get --schema <编码> --id <记录ID>` | 单条详情（字段为 `F0000xxx`，人员类字段带 `*_Name`） |

**`records list --filter` 字段筛选语法**（SQL 风格，关键字大小写不敏感；字符串值
用单/双引号包裹）：

| 写法 | 语义 |
|---|---|
| `Name = '测试'`（或 `Name Equal '测试'`） | 等于 |
| `Status <> 2` / `Status != 2` / `Status NotEqual 2` | 不等于 |
| `Status > 1` / `>=` / `<` / `<=`（也可写 `Above`/`NotBelow`/`Below`/`NotAbove` 或 `gt`/`ge`/`lt`/`le`） | 数值 / 日期比较 |
| `Name Contains '测试'`（`Like` 同义，氚云没有 `Like`，映射为包含） | 模糊包含（≈ SQL `LIKE '%测试%'`） |
| `Name StartWith '瑞'` / `Name EndWith '公司'`（可加 `not` 取反） | 前缀 / 后缀匹配 |
| `Status In (1, 2)` / `Status NotIn (3)` | 在 / 不在集合内 |
| `CreatedTime Between '2026-09-01' and '2026-09-30'` | 区间匹配（闭区间） |
| `OwnerId IsNull` / `IsNotNull` / `IsNone` / `NotNone` | 空值判断 |
| `(Name Contains 'a' or Name Contains 'b') and Status = 1` | 括号 + `and`/`or` 组合（`and` 优先） |

- **字段名**：用记录返回 JSON 里的字段键——标准字段如 `Name`、`SeqNo`、`Status`、
  `CreatedTime`、`ModifiedTime`、`OwnerId`，以及业务字段 `F0000xxx`。命令自动补
  `<schemaCode>.` 前缀；字段名已含 `.`（跨表单全限定名）时按原样使用。
- **值类型**：不加引号的数字、`true`/`false` 按类型传参；日期/时间建议用字符串，
  如 `'2026-09-04'`、`'2026-09-04 13:55:21'`。中文文本（下拉/单选/名称等）用引号。
- `--filter` 可与 `--keyword` 叠加；翻页 `--page n` 从 1 开始；无效表达式返回清晰
  报错（退出码 1）。

### 附件

| 命令 | 说明 |
|---|---|
| `crwu h3yun files list --schema <编码> --id <记录ID>` | 列出该记录全部附件（字段/文件名/类型/大小/下载URL） |
| `crwu h3yun file download --schema <编码> --id <记录ID> --out <目录>` | 下载全部附件到本地（原名 + 自动去重） |
| `crwu h3yun file get --id <FileId> --out <文件路径>` | **只下载单个附件**到指定路径（FileId 来自 `files list`） |

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
crwu h3yun records list --schema <code> --filter "Status = 1 and Name Contains '测试'" --size 20
crwu h3yun records get  --schema <编码> --id <ObjectId>
crwu h3yun files list   --schema <编码> --id <ObjectId>
crwu h3yun file download --schema <编码> --id <ObjectId> --out ./附件
crwu h3yun file get      --id <FileId> --out ./附件/估值报告.pdf
```

> 审核阶段一隔离：`file get` 只取单个附件，是「只下源材料、不下复核件」的唯一放行命令；
> 复核件应只用 `files list` 看元数据并记入排除清单，禁止 `file download` 整单下载。

**纪律**：`appCode`/`schemaCode`/`recordId` 一律来自上一步命令的返回值，**禁止猜测或编造编码**；
关键字搜不到先放宽关键字或换表单，不要硬试 ID；`--filter` 字段写错会直接报错，先跑一次
`records list` 看返回字段名再筛选。

## 6. 双通道与已知限制

| 通道 | 凭证 | 现状 |
|---|---|---|
| 网页会话（§3） | 员工扫码 JWT | ✅ 全部读取/附件命令可用 |
| Agent 网关 | 个人访问凭证 `h3pat_*` | ⏳ 若氚云未开通数据面，任意 `tools/call` 会返回 `h3yun.read.upstream_error`（上游响应异常）——**这是氚云平台侧问题，不是客户端故障**，重试无意义，找氚云开通即可 |

已知坑：
- 单条"详情"务必用 `records get`（走过滤查询）；氚云 `loaddata` 接口会返回空壳，不要用。
- 附件下载 URL 为 `www.h3yun.com/Form/Download/?AttachmentID=<FileId>`，需带会话鉴权；`file download`（整单）与 `file get`（单件，按 FileId）均已封装。
- 记录字段输出含 `*_Original` 冗余结构属正常；人员/部门字段同时有 `*_Name` 可读名。
- 氚云记录查询没有 SQL `Like`；`--filter` 里的 `Like` 自动映射为 `Contains`（包含匹配），前缀/后缀用 `StartWith`/`EndWith`。

## 7. 给 Agent 的调用约定

- 输出：成功 = 退出码 0，stdout 为 `{"ok":true,"data":...}` 纯 JSON；任何错误（含必填参数缺失等用法错误）均退出码 1，诊断在 stderr。
- 需要发现命令时先跑 `crwu scheme`，不要凭记忆调用参数。
- 本 CLI 当前**全部为只读操作**；未来加入写/审批命令后，执行前必须先向用户声明并等确认。
- token 不得出现在任何工具输出/日志/会话记录里；若需重绑请用户自己执行 bind。
