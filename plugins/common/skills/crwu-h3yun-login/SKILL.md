---
name: crwu-h3yun-login
description: >-
  当用户/员工需要【登录/绑定/重新登录/续期/换账号】H3Yun（氚云）会话，或任何
  h3yun 查询提示"没有会话/会话过期/请先登录/无法读取数据"时，自动使用本技能。
  它自动打开本机浏览器，由员工用钉钉扫码完成登录，会话直接写入本机凭据存储；
  令牌全程不显示、不进对话、不发送给任何 AI 宿主。非登录诉求（查数据）不要使用，
  改走 crwu-h3yun-query。
---

# H3Yun 员工自助登录（crwu-h3yun-login）

## 自动触发规则

- **触发**：用户说"帮我登录/绑定/扫码/登录不上/会话过期/需要重新登录氚云"，
  或任何氚云查询返回"无会话/会话过期/请先登录"类错误。
- **不触发**：用户只是要查应用/表单/记录/附件（走 `crwu-h3yun-query`），或明确表示不愿扫码。
- **命中后的第一步**：见下方「DSH 环境」或「非 DSH 宿主兼容层」——按当前宿主选入口，
  把引导原文展示给用户，让其用手机钉钉扫码；成功后确认会话可用，再转交
  `crwu-h3yun-query` 继续查询。


## DSH 环境（DeepSeek Harness）：**只用结构化 Tool**

在 DSH 里，氚云取数一律通过工作台插件注册的 CRWU 结构化 Tool 完成 ——
**不要**在 shell 里拼 `crwu` 命令行，**不要**用 `which` / `command -v` / `find`
去查找或"修好"这个命令，也不要猜它的路径。

| 需求 | DSH 入口 |
| --- | --- |
| 记录（全字段一次取回） | `crwu_h3yun_record_get` |
| 记录附件元数据 | `crwu_h3yun_files_list` |
| 单个附件定向下载 | `crwu_h3yun_file_get` |
| 能力/平台自检 | `crwu_audit_capabilities` |

- **登录/会话续期**：DSH 的工作台面板里有「登录认证」（氚云 / 钉钉）入口，由插件按 DSH
  的审批契约发起；员工只需在弹窗里授权一次。
- **Tool 不可见或返回 capability gap**：如实报告「capability gap：缺少 <工具名>」并停止，
  **不要**降级成 shell 查找或手工命令行。
- 下面「非 DSH 宿主兼容层」里的命令只用于非 DSH 宿主与人工排障，**不参与 DSH 自动审核链路**。

<!-- crwu-cli-guard:legacy-compat-start -->
## 非 DSH 宿主兼容层（legacy CLI）

以下内容仅在**非 DSH 宿主**（或人工在终端排障）时使用；DSH 环境请只用上面的结构化 Tool。

用 `crwu` 帮当前用户（员工本人、非程序员）完成 H3Yun 网页会话的**本机绑定**，
让后续 `crwu-h3yun-query` 等只读查询能以其权限执行。**这是绑定入口；不要在对话中
索要、展示或转发任何令牌。**

## 什么时候用

- 员工第一次使用，或会话过期（`crwu h3yun session status` 报无会话/已过期）。
- 换电脑 / 换账号时需要重新绑定。
- 已绑定但想换成另一个员工身份时（先 `crwu h3yun session clear`）。

## 前置：确保命令可用（仅非 DSH 宿主）

`crwu` 是 Go 二进制，通常已随项目/环境装好。若**找不到**它，**不要擅自改环境、
不要往 `~/bin` 拷副本、也不要自行从源码构建**——这属于部署/环境问题，应先
**如实告知用户**"当前环境找不到该命令"，并**询问用户**希望如何处理（例如由用户
提供/安装该工具，或确认正确的调用路径）后再继续。技能纪律：遇到环境缺失如实转述、
不擅自绕过或替用户做决定。

## 流程

**唯一推荐步骤（自动扫码）**

```bash
crwu h3yun session login
```

- crwu 会**自动打开一个浏览器窗口**（Chrome/Edge，找不到时提示装浏览器或设
  `CRWU_BROWSER`，可显式设
  `CRWU_BROWSER="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"`）。
- 请员工在**弹出的窗口**里用钉钉扫码登录 h3yun.com（无需氚云密码）；
- 成功后命令输出类似 `{"ok":true,"data":{...,"expiresIn":"47h…"}}`，会话已写入
  本机 keyring。

> ⚠️ **AI 宿主沙箱注意**：在受沙箱隔离的 Agent 环境里，`session login` 派生的
> GUI 浏览器会被沙箱拦截而**无法弹出窗口**（报 `websocket close 1006`、stderr
> 含大量 file-write 被拒）。此时必须**脱离沙箱 + 前台**运行本命令（例如 Bash 工具
> 加 `dangerouslyDisableSandbox`，且不用后台模式），Edge 窗口才能在桌面上弹出供扫码。

**验证**

```bash
crwu h3yun session status
```

应显示 `engineCode`、`userId` 与剩余有效期。然后即可使用 `crwu-h3yun-query` 等技能。

## 回退（受信 IT/自助二选一，仅当扫码自动流程不可用时）

若浏览器自动流程不可用（无浏览器/被禁用），可以让员工在 `h3yun.com` 网页扫码
登录后，由**绑定者本人在本机**执行并把浏览器里的会话 JWT 只粘贴给本机命令：

```bash
crwu h3yun session bind --token '<JWT>'
```

> ⚠️ 回退路径中，**令牌粘贴只发生在员工本机终端**；Agent/LLM 不得要求用户把
> 令牌贴进对话，也不得在日志/输出中保留令牌。

## 纪律与边界

- **令牌零外泄**：会话令牌仅在 crwu 进程内从浏览器读取并写入本机 OS 凭据存储；
  不打印、不进日志、不进聊天、不发给任何 AI 宿主。
- **只绑定当前员工自己的账号**：登录扫码的是谁，绑的就是谁的权限；发现绑定的
  员工与预期不符时，先 `crwu h3yun session clear` 再重新登录。
- 每个员工在**自己的电脑**上绑定自己的会话（员工自助模型）。
- 出错时如实转述错误，如"超时/浏览器打不开/扫码未完成"，不要替用户猜测或重试
  绕过（例如不要把某人的会话强绑到另一台机器）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示找不到浏览器 | 安装 Chrome/Edge 后重试，或设 `CRWU_BROWSER` 指向浏览器可执行文件 |
| 扫码后一直等待超时 | 确认扫码用的是**钉钉**且属于本企业；重跑一次 `crwu h3yun session login` |
| `session status` 显示另一个员工 | `crwu h3yun session clear` 后重新用正确员工扫码登录 |
| 自动流程不可用 | 使用上面"回退"路径在本机粘贴绑定 |
| 沙箱内运行、浏览器窗口弹不出（`websocket close 1006`） | 用**脱离沙箱 + 前台**方式运行 `session login`；可显式设 `CRWU_BROWSER` 指向 Edge/Chrome |

## 更多

命令与细节以 `crwu scheme` 为准；登录成功后即可使用 `crwu-h3yun-query` 技能
进行查询。

<!-- crwu-cli-guard:legacy-compat-end -->
