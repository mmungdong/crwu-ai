# 变更纪要（CLI Changelog）

> 维护纪律（见 `AGENTS.md`）：**每次 CLI 功能新增 / 变更 / 删除**（命令、参数、
> 环境变量、输出契约、通道行为），必须在本文档**追加**一条纪要，并同步更新
> [`docs/cli-manual.md`](cli-manual.md)（Agent 使用说明书）。
>
> 条目格式：`日期 · 类型 · 标题`，类型沿用 Angular 词表（feat / fix / refactor /
> docs / chore），正文写明**影响命令**与关键说明。

---

## 2026-09-04 · feat · records list 支持 --filter 字段条件筛选

- 影响命令：`crwu h3yun records list`（新增 flag `--filter <条件>`）
- 说明：SQL 风格筛选表达式（`=`/`!=`/`<>`/`<`/`>`/`<=`/`>=`/Contains/Like/
  StartWith/EndWith/In/NotIn/Between/IsNull/IsNotNull/IsNone/NotNone，支持
  `and`/`or` 与括号，大小写不敏感），字段自动补 `<schemaCode>.` 前缀；
  `--filter` 与 `--keyword` 可叠加
- 语法与操作符表见 `docs/cli-manual.md` §4"记录"；氚云无 SQL `Like`，`Like`
  已映射为 `Contains`
- 相关：新增 `internal/integrations/h3yun/filter.go`（表达式→matcher 树，含
  单元测试）；`internal/app/h3yunweb`（Records 透传 Filter）、
  `internal/transport/cli`（flag + scheme 示例）；同步 skill `h3yun-query`

---

## 2026-09-04 · docs · 扫码登录的沙箱运行注意与前置说明

- 影响：`crwu h3yun session login` 的运行环境注意事项
- 在 AI 宿主沙箱环境中，login 拉起的 GUI 浏览器会被沙箱拦截而弹不出窗口
  （报 `websocket close 1006`），应**脱离沙箱 + 前台**运行，并用 `CRWU_BROWSER`
  显式指定 Chromium 系浏览器路径
- 同步 `docs/cli-manual.md`（§3 增加环境提示）与 `skills/h3yun-login/SKILL.md`
  （增加"确保 crwu 可用"前置——`crwu` 缺失时应询问用户而非擅自构建/改环境；
  `CRWU_BROWSER` 显式示例；沙箱拦截排障条目）

---

## 2026-09-03 · feat · 员工自助扫码登录（session login）

- 新增命令：`h3yun session login`
- 影响：自动拉起本机 Chrome/Edge 打开 h3yun.com，员工用钉钉扫码后由 crwu 经
  CDP 直接读取会话并写入本机 keyring；令牌全程进程内处理，不打印/不进对话
- 相关：`internal/platform/scanlogin`（浏览器捕获）、`internal/app/h3yunweb`、
  新增 skill `h3yun-login`
- 环境变量：`CRWU_BROWSER`（指定浏览器可执行文件）
- 默认浏览器支持：优先使用系统默认浏览器（需为 Chrome/Edge/Brave/Chromium 等
  Chromium 系；Safari/Firefox 不支持 CDP 时回退到已装 Chromium），macOS 读
  LaunchServices、Windows 读 UserChoice、Linux 读 xdg-settings
- 读取加固：cookie（www 域与根域双拉）+ 页面 JS localStorage/document.cookie
  兜底；抓取值先解码校验 enginecode/userid/exp（未来时间）后才写入，无效不存储

---

## 2026-09-03 · feat · 首个交互式查询 Skill（h3yun-query）

- 新增：`skills/h3yun-query/SKILL.md`
- 影响命令：复用 `h3yun apps list / apps children / forms search /
  records list / records get / files list / file download`（只读）
- 说明：按"系统 → 表单 → 记录"逐层交互查询，每页 20 条、可翻页、支持标题
  关键词查找；不发散写操作

---

## 2026-09-03 · feat · version 输出构建信息

- 影响命令：`crwu version`
- 影响：输出含 版本号、commit 缩写、构建时间（UTC）、目标平台（macOS/Windows/
  Linux + 架构），由 Makefile 注入 BuildDate；GOOS/GOARCH 为编译期值

---

## 2026-09-03 · feat · 会话惰性自动续期（中间件）

- 影响命令：apps/forms/records/files 等依赖网页会话的读命令
- 说明：h3yun 组 PersistentPreRunE 中间件在执行前检查会话剩余时间 ≤24h 则自动
  refresh 一次；已过期则提示重新 `crwu h3yun session login`。session 管理命令与
  agent 通道（ping/tools/apps search/records query）跳过
- 相关：`internal/transport/cli/middleware.go`（CLI 中间件）、
  `internal/app/h3yunweb/renewal.go`（EnsureFresh）

---

## 2026-09-03 · refactor · 用 cobra 重写 CLI（docker/k8s 规范）

- 影响命令：全部（结构不变，命令路径/flag 保持一致）
- 说明：命令改为嵌套树，help 分层折叠（`crwu help h3yun session`）；flag 由
  cobra/pflag 管理并校验必填参数；`crwu scheme` 目录改为由 cobra 命令树实时
  生成，与 help 描述同源；退出码统一：成功 0、任何错误 1

---

## 2026-09-03 · feat · H3Yun 员工级网页会话通道上线

- 新增命令：`h3yun session bind/status/refresh/clear`、`h3yun apps list`、
  `h3yun apps children`、`h3yun forms search`、`h3yun records list`、
  `h3yun records get`、`h3yun files list`、`h3yun file download`
- 影响：以员工本人网页会话（钉钉扫码，无密码）读取应用/表单/记录/附件；
  会话存本机 OS 凭据存储（`internal/platform/h3yuncreds`），48h 可续期
- 相关：新增 `internal/integrations/h3yun`（网页 REST 客户端）、
  `internal/app/h3yunweb`

## 2026-09-03 · feat · H3Yun Agent 网关（MCP）客户端

- 新增命令：`h3yun ping`、`h3yun tools`、`h3yun apps search`、
  `h3yun records query`（只读 SQL）
- 影响：以个人访问凭证 `h3pat_*` 对接 `www.h3yun.com/v1/agent/mcp`
- 说明：氚云数据面未对企业开通时，`tools/call` 返回 `h3yun.read.upstream_error`
  （平台侧问题，非客户端故障）；开通后该通道方可用
- 相关：`internal/integrations/h3yun`（MCP 客户端）、`internal/app/h3yunops`

## 2026-09-03 · refactor · 移除 crwu-server 模块与 `h3yun login`

- 影响命令：删除 `h3yun login`（钉钉 OAuth 服务器登录）
- 说明：员工凭证改为**本机绑定**模型，无服务端可运维；移除
  `cmd/crwu-server`、`internal/app/h3yunlogin`、`internal/auth`、
  `internal/config`、`internal/integrations/{dingtalk,crwuserver}`、
  `internal/transport/httpapi`、`internal/platform/browser`
- 破坏性：若曾有调用方依赖 CRWU 会话服务器或 `h3yun login`，需迁移到
  `h3yun session bind`

## 2026-09-03 · docs · 项目文档重构

- 新增：`docs/design-h3yun-auth.md`（鉴权决策）、
  `docs/design-h3yun-cli.md`（CLI 决策）、`docs/design-h3yun-connector.md`
  （连接器决策）、`docs/cli-manual.md`（本说明书）
- 更新：`AGENTS.md`、`CONTEXT.md`、README（en/zh）按"无服务端员工会话"模型重构

---

> 预置条目回溯了项目当前功能状态；此后所有变更按上方格式**向下追加**，请勿改写历史。
