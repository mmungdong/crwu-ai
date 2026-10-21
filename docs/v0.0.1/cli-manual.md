# crwu CLI 说明书（H3Yun 员工级访问）

> **给 Agent 的话**：读完本文即可完整操作 `crwu` 对接氚云，**不需要阅读整个项目**。
> 本文档是面向人和 Agent 的完整操作手册；机器可读的命令元数据以运行时 `crwu scheme` 为准。
> 命令、参数、环境变量或通道行为变化时，必须同步更新本文，并在
> [`CHANGELOG.md`](CHANGELOG.md) 追加纪要（见 [`AGENTS.md`](../../AGENTS.md)）。

## 1. 这是什么

`crwu` 是单二进制 Go CLI，让 AI/员工以**某个员工本人的氚云身份**读取企业数据
（应用/表单/记录/附件），**不需要氚云密码、不需要运维服务端**。

- 身份载体：员工在 `h3yun.com` 用钉钉扫码得到的**网页会话 JWT**，绑定在本机
  OS 凭据存储（keyring），48 小时有效、可续期。
- 数据边界：每条命令都按**绑定员工**在氚云里的角色/权限过滤返回。
- 命令目录：`crwu scheme` 输出机器可读的全量命令目录（AI 从这里自动发现）。

在 DeepSeek Harness 工作台复制审核提示词到普通新会话时，使用插件注册的 `crwu_*` 结构化工具。先按提示词在选定工作空间的案例目录准备输入快照，再执行完整两阶段审核与交付；无需把新会话登记为审核子会话。脚本、知识库、附件、OSS 和钉钉工具均校验案例路径、本机授权及员工权限。托管审核子会话仍受本轮范围限制。插件更新后须完整重启 DSH 并重新复制提示词。

## 2. 环境与前置

- 需要已构建的二进制 `./bin/darwin/crwu`（macOS，构建：仓库内 `make build`；
  Windows 产物为 `./bin/windows/crwu.exe`）或绝对路径 `/tmp/crwu` 等。
- 可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `H3YUN_BASE_URL` | 覆盖氚云控制台地址（测试用） | `https://www.h3yun.com` |
| `H3YUN_TOKEN` | 仅 **agent 通道**命令用（见 §6） | 无 |
| `CRWU_BROWSER` | `crwu browser` 使用的 Chromium 系浏览器可执行文件 | 依次取：`CRWU_BROWSER` → 系统默认浏览器（仅当它是 Chromium 系，Safari/Firefox 无法用 CDP 驱动时会跳过）→ 声明的 Chromium 候选路径（Chrome/Edge/Brave/Chromium/Vivaldi/Opera 等；**不硬编码 Edge**） |
| `CRWU_BROWSER_PROFILE` | 浏览器 profile 目录（登录态所在） | `~/.crwu/browser/profile` |

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

> **Windows 临时目录回退**：如果系统 `%TEMP%` 被安全策略按进程拒绝写入，
> crwu 会自动改用当前用户缓存目录 `%LOCALAPPDATA%\crwu\scan-tmp` 创建一次性的
> `crwu-scan-*` 浏览器 profile；登录结束后仍会删除该 profile。若该目录也被拒绝，
> 请检查 Defender/企业安全软件的拦截记录，不要把 JWT 写入工作区文件。

> ⚠️ **AI 宿主沙箱注意**：在受沙箱隔离的 Agent 环境里，`session login` 派生的
> GUI 浏览器会被沙箱拦截而无法弹出窗口（报 `websocket close 1006`、stderr 含大量
> file-write 被拒）。应**脱离沙箱 + 前台**运行本命令，并可用
> `CRWU_BROWSER` 显式指定 Chromium 系浏览器（如 Edge）路径。

**回退（受信 IT/本机粘贴，仅自动流程不可用时）**

1. 让员工在浏览器打开 `https://www.h3yun.com` 扫码登录；
2. 绑定者在本机执行 `crwu h3yun session bind --token '<JWT>'`（JWT 取自已登录
   浏览器的请求头 `Authorization`，`eyJhbGci...` 整串，不带 `Bearer ` 前缀）。

**优先用 `--token-stdin`**：`--token` 会把 JWT 写进进程命令行（同机其它进程的
`ps` / 任务管理器看得到），标准输入不会：

```text
crwu h3yun session bind --token-stdin   # 从管道、密钥管理器或粘贴后结束输入（EOF）交给它
```

两个来源只能给一个：同时给出 `--token` 与 `--token-stdin` 会被拒绝；`--token-stdin`
读到空白内容时按「没有令牌」处理；最多读 8 KiB。两条路径都不会回显令牌。

> 安全红线：token 只出现在**本机命令**（且优先走标准输入）；crwu 绝不写入日志/文件/
> scheme 输出/聊天/提交，绝不让 Agent 代看或代贴。需要吊销/换人时先 `session clear` 再重登。

## 4. 常用命令速查

### 会话管理

| 命令 | 说明 |
|---|---|
| `crwu h3yun session login` | 员工自助登录：自动开浏览器扫码并绑定（令牌不进对话） |
| `crwu h3yun session bind --token-stdin`（或 `--token <jwt>`） | 绑定员工网页会话到本机（回退/受信路径；`--token-stdin` 让令牌不进命令行） |
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
| `crwu h3yun files list --schema <编码> --id <记录ID>` | 列出该记录全部附件（字段/文件名/类型/大小/下载URL）；没有附件时 `data` 为 `[]` |
| `crwu h3yun file download --schema <编码> --id <记录ID> --out <目录>` | 下载全部附件到本地（原名 + 自动去重） |
| `crwu h3yun file get --id <FileId> --out <文件路径>` | **只下载单个附件**到指定路径（FileId 来自 `files list`） |

### Agent 网关（`h3pat`，需氚云开通数据面）

| 命令 | 说明 |
|---|---|
| `crwu h3yun ping` | 与 Agent 网关握手（`H3YUN_TOKEN`） |
| `crwu h3yun tools` | 列出网关可见工具（含输入 schema） |
| `crwu h3yun apps search --keyword <名称>` | 按关键字搜应用（网关工具） |
| `crwu h3yun records query --schema <编码> --sql <只读SELECT>` | 受控只读 SQL 查询 |

### 浏览器抓取（`browser`）

开一个**真实可见**的浏览器读页面。CLI 不内置任何站点：站点清单由 `--sites` 指向的 JSON 给出。
登录态存在 `~/.crwu/browser/profile`（权限 0700），**下次不用重登**。`--profile` 与
`CRWU_BROWSER_PROFILE` **都必须给绝对路径**：相对路径会跟着调用方的 cwd 漂移，凭据缓存就会落到
一个没人预期的地方（下一条命令换目录执行时又解析成另一个空 profile）。`crwu browser status`
默认只读该 profile 里的凭据，**不开窗口、不加载页面**。`fetch` / `shot` 默认在**自有后台窗口**
里执行：窗口不主动抢焦点，同一 profile 的下一次调用复用同一张已渲染页面，而不是每次抓取都弹一个窗。
它只承诺"不主动聚焦"，**不保证**操作系统层面完全不出现任何窗口/启动 UI，窗口本身仍是普通有头窗口。

| 命令 | 说明 |
|---|---|
| `crwu browser profile` | 显示 profile 路径与是否存在（不启动浏览器） |
| `crwu browser login --sites <文件> [--site <id>] [--timeout 5m]` | 打开**可见窗口**到各站登录页，等员工完成登录（含滑块）。全部站点登录成功才算通过 |
| `crwu browser status --sites <文件> [--site <id>] [--verify-page]` | 读取 profile 里的登录凭据与到期时间（`expiresAt` / `sessionCookie`），**不开窗口、不加载页面**：逐站报告 `authenticated` / `unauthenticated` / `unknown` 与公开的 `protectedUrl`，`verdict` 为空。加 `--verify-page` 时在**自有目标**里额外读取受保护页并保留该目标，给出**页面判定** `verdict`（`ok` / `login-wall` / `captcha` / `blocked`） |
| `crwu browser fetch --url <地址> --out <文件> [--background=true\|false] [--wait-ms 9000] [--scroll] [--dump <文件>]` | 取**渲染后**的 DOM 写文件；默认复用不加焦点的自有后台窗口，`--background=false` 显示同一个自有窗口（不新开浏览器、不附着员工标签页） |
| `crwu browser shot --url <地址> --out <文件> [--background=true\|false] [--full-page] [--scroll] [--dump <文件>]` | 全页截图写文件；后台窗口语义同 `fetch` |
| `crwu browser recover --sites <文件> --site <id> --url <地址> [--strategy auto\|cooldown-renavigate\|geetest-v3-canvas] [--task-id <id>]` | 对**可见**人机验证做一次有界恢复尝试，并回读页面给出状态与页面级证据 |
| `crwu browser open --sites <文件> [--site <id>]` | 用同一个 profile 在**可见窗口**里打开所选站点的**受保护页**（`protectedUrl`），供员工人工完成人机验证；**立即返回**、不等待、不关窗口 |

**后台窗口语义（`fetch` / `shot`）**：

- 默认在同一个**自有后台窗口**里读页：窗口以正常状态创建、`background=true`、不主动抢焦点；
  同一 profile 的下一次 `fetch` / `shot` 复用同一个目标，不新开窗口、也不导航员工的其它标签页。
- 它**不等于**"绝对不出现窗口"：这是一个普通有头窗口，操作系统仍可能短暂显示启动 UI。
- 只有显式的人工动作才把窗口带到前台（`login` / `open`），或当抓取真的落在一张人机验证页上时
  才把那张**同一目标**的页面带到前台供人工完成；正常页面一律不抢焦点。`status --verify-page`
  也在同一个自有目标里读页，遇到可见人机验证时才把该目标带到前台。
- `--background=false` **不是**另起一个可见窗口：它仍用同一个自有目标，只是把该窗口带到前台供
  这一次动作查看；运行中的浏览器不会被重开，员工的其它标签页也不会被附着。两种模式都会保留
  这个自有目标，人工验证窗口因此在任一模式下都留在原处。

站点清单 JSON 形状：

```json
[
  {
    "id": "lianjia",
    "label": "链家",
    "loginUrl": "https://clogin.lianjia.com/login",
    "protectedUrl": "https://bj.lianjia.com/ershoufang/chaoyang/",
    "authCookie": "lianjia_token",
    "authDomains": [".lianjia.com"]
  }
]
```

**产物纪律**：页面被判为登录墙 / 验证码 / 拦截时，`--out` **不写**（避免把验证页当成房源页存证）；
`--dump` 不受此限制，用于留下现场 DOM 排障。截图还会做真伪校验（尺寸 + 非白像素占比），
空白页或验证页一律判失败。

#### 人机验证恢复（`crwu browser recover`）

遇到**看得见**的人机验证时不再直接判失败，先做一次**有界**的自动恢复尝试；仍然没通过就把断点交回员工。

- **只认看得见的挑战**：判据是几何可见性 + 命中测试（覆盖层真的有尺寸、真的接收指针），
  加上最终 URL 与业务页标识。页面源码里出现验证码字样**不**触发恢复 ——
  实测的业务页 HTML 里就长期带着 captcha 字样，按文案判定会把每一张正常页送去做验证。
- **策略**：`auto`（先固定脚本，再按需冷却重入）、`cooldown-renavigate`（等待后重入原 URL，
  这是目前**唯一有执行证据**的策略）、`geetest-v3-canvas`（读挑战画布、算缺口、经 CDP 重放拖拽；
  **候选策略，尚未通过真实页面验收**）。没有可适配的挑战形态时返回 `unsupported`，不猜、不改用别的动作。
- **站点自己的人机验证页是"等人"，不是"做不了"**：站点把受保护页重定向到它自己的验证页时
  （实测 2026-10-15：`bj.lianjia.com/…` → `hip.lianjia.com/captcha`，标题 `CAPTCHA`），
  `beforeKind` 报 `site-challenge-page`，页面形态按**结构化事实**识别（最终 URL 的路径段或文档标题，
  不匹配中文文案），`state` 是 `waiting-user`、`reasonCode` 是 `challenge-page-waiting-user`，
  原因里写明原始 host 与验证 host。员工在那个可见窗口里过一次验证，用同一来源 + 同一
  `retrievalTaskId` 继续即可，不必重建会话或重传资料。`unsupported` 只留给"确实没有对应策略"的
  可见挑战族（`geetest-v3-dom`、读不出画布等）。
- **看不见就不拖**：`challengeVisible=false` 时不调用 `geetest-v3-canvas` —— 看不见的控件没有可拖的位置；
  只有几何可见且已适配的挑战才走固定脚本，其它挑战族一律不猜、不改用别的动作。
- **恢复必须回读核验**：`recovered` 要求最终 URL 回到原站点（`hostMatches`）、页面可读（`readable`）、
  且没有可见挑战（`challengeVisible=false`）；自动预算用尽后的那次回读走同一道核验，
  只在网页上"没有可见挑战"绝不等于恢复成功。
- **预算由程序管，不由调用方放宽**：一次调用最多 2 次尝试、总窗口最多 120 秒、单次脚本/CDP 调用最多 30 秒；
  `--attempts` / `--window-ms` / `--script-timeout-ms` / `--cooldown-ms` 都会被**夹到**这些上限。
  冷却放不进剩余窗口时**不等**，而是给出 `nextEligibleAt`，避免截短冷却后猛打站点。
- **没有任意脚本能力**：没有 `--eval` / `--script` 之类的参数；运行的唯一脚本是随二进制 embed 的固定探针。
- **退出码不是判据**：`data.state` 才是结论（`recovered` / `waiting-user` / `unsupported` / `unavailable` /
  `cancelled` / `failed`），并带上最终 URL、是否同站、是否仍有可见挑战、遮罩选择器与原因。
  脚本"退出成功"但挑战仍在页面上时，一律不是 `recovered`。
- **不替代登录**：真正的退出登录返回 `waiting-user`（`login-required`），不会用验证码策略顶替员工登录；
  也不填密码、不填短信码、不替员工勾选协议。
- **挑战页截图不能当证据**：恢复期间读到的画布/挑战页面只作临时排障材料，
  正式案例截图必须在恢复成功后**重新抓取**；恢复判定由 CLI 的页面检查加调用方的房源字段校验共同完成。
- **不清理员工窗口**：取消只清掉自己可能按下的鼠标状态，不关闭员工的标签页。

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
- `crwu browser` 读取**受保护页**时必须用有头浏览器：无头 Chromium 会被站点的指纹识别拦下。
  例外只有 `crwu browser status` 的默认模式 —— 它只读 profile 里的凭据与到期时间、**不加载任何页面**，
  因此用一个不显示的实例（`--headless=new`）读 cookie，既不弹窗也没有指纹面。
  为在 DSH 文件沙箱下启动，浏览器以 `--no-sandbox` 运行。
- `crwu browser` 只驱动 **Chromium 系**浏览器（需要 CDP）：依次取 `CRWU_BROWSER` → 系统默认
  浏览器（仅当它是 Chromium 系）→ 声明的 Chromium 候选路径（Chrome / Edge / Brave / Chromium
  等，**不硬编码 Edge**）。系统默认是 **Safari / Firefox** 时无法驱动，请安装 Chromium 系浏览器
  或用 `CRWU_BROWSER` 指定。
- `fetch` / `shot` 默认复用**自有后台窗口**：不主动聚焦、同一 profile 复用同一张渲染页，但这是
  普通有头窗口，**不保证**操作系统层面完全不出现窗口/启动 UI；`--background=false` 只是显示同一个
  自有窗口，不会另起浏览器。`status --verify-page` 同样在自有目标里读页。详见 §4 的「后台窗口语义」。
- `crwu browser` **只用固定脚本做有界恢复，不做通用绕过**：遇到**看得见**的人机验证先由
  `crwu browser recover` 按其固定策略自动尝试（最多 2 次 / 120 秒），失败就把断点交回员工，
  在那个可见窗口里人工完成。没有 `--eval` 之类的任意脚本入口，也不改变站点的登录保护。
  详见上一节的「人机验证恢复」。
- `unknown` ≠ 未登录：网络不通、出口 IP 在境外、页面被人机验证时都返回 `unknown`，
  不要据此让员工反复重登。**看 `verdict` 决定处置**：`captcha` → 先走 `recover`，
  失败则让员工在可见窗口里完成验证；`blocked` → 风控，稍后重试或换网络；`login-wall` →
  才引导登录。调用方**不要**去匹配 `reason` 的中文文案（那是给人看的）。
- **登录看凭据有效性，页面验证不算未登录**（2026-10-14 口径）：逐站结果多了 `expiresAt`
  （RFC3339；会话 cookie 为空）与 `sessionCookie`。判定顺序固定：
  ① 没有凭据或**已过期** → `unauthenticated`（这时才让员工登录；原因会写上"已过期"）；
  ② 凭据有效但页面是**登录墙** → `unauthenticated`（会话被服务端作废的形态）；
  ③ 凭据有效、页面要求**人机验证/风控** → `authenticated`（员工确实已登录；验证是页面访问问题，
     由取数流程自动尝试恢复、必要时请员工在窗口里完成，**不要**在这里把整条链路挡住）；
  ④ 凭据有效、页面可读 → `authenticated`。
  也就是说 `state` 回答"有没有登录"，`verdict` 回答"这一页能不能读"，两者不要再混。
- **凭据按浏览器级读取**（`Storage.getCookies`），与当前附着哪个标签页无关；
  `Network.getCookies` 是按当前 URL 取 cookie 的，用它判"有没有登录"会把已登录看成没登录
  （2026-10-14 实测：`about:blank` 上读到 0 条，浏览器级读到 66 条）。
- `status` 是**权威检查**：凭据存在还不够，它会真的打开 `protectedUrl` 读一次页面；
  连同站点清单里的 `loginUrl`，两者都必须来自站点自己发布的链接。
- 单条"详情"务必用 `records get`（走过滤查询）；氚云 `loaddata` 接口会返回空壳，不要用。
- 附件下载 URL 为 `www.h3yun.com/Form/Download/?AttachmentID=<FileId>`，需带会话鉴权；`file download`（整单）与 `file get`（单件，按 FileId）均已封装。
- 记录字段输出含 `*_Original` 冗余结构属正常；人员/部门字段同时有 `*_Name` 可读名。
- 氚云记录查询没有 SQL `Like`；`--filter` 里的 `Like` 自动映射为 `Contains`（包含匹配），前缀/后缀用 `StartWith`/`EndWith`。

## 7. 给 Agent 的调用约定

- 输出：成功 = 退出码 0，stdout 为 `{"ok":true,"data":...}` 纯 JSON；任何错误（含必填参数缺失等用法错误）均退出码 1，诊断在 stderr。
- 需要发现命令时先跑 `crwu scheme`，不要凭记忆调用参数。
- 本 CLI 对企业系统**全部为只读操作**；未来加入写/审批命令后，执行前必须先向用户声明并等确认。
- 例外说明：`crwu browser fetch/shot` 会**在本地写文件**（`--out`/`--dump`），
  `crwu browser login` 会开一个可见浏览器窗口——这两者都不是对企业系统的写操作，
  但调用前仍应让用户知道会落盘到哪里。
- token 不得出现在任何工具输出/日志/会话记录里；若需重绑请用户自己执行 bind。
