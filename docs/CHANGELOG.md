# 变更纪要（CLI Changelog）

> 维护纪律（见 `AGENTS.md`）：**每次 CLI 功能新增 / 变更 / 删除**（命令、参数、
> 环境变量、输出契约、通道行为），必须在本文档**追加**一条纪要，并同步更新
> [`docs/cli-manual.md`](cli-manual.md)（Agent 使用说明书）。
>
> 条目格式：`日期 · 类型 · 标题`，类型沿用 Angular 词表（feat / fix / refactor /
> docs / chore），正文写明**影响命令**与关键说明。

---

## 2026-09-03 · feat · 首个交互式查询 Skill（h3yun-query）

- 新增：`skills/h3yun-query/SKILL.md`
- 影响命令：复用 `h3yun apps list / apps children / forms search /
  records list / records get / files list / file download`（只读）
- 说明：按"系统 → 表单 → 记录"逐层交互查询，每页 20 条、可翻页、支持标题
  关键词查找；不发散写操作

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
