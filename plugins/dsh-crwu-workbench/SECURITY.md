# 安全说明（SECURITY）

本仓是一个 **DeepSeek Harness（DSH）插件**。按 DSH 的模型，插件是**受信任的 Host 代码**：
它在 `dsh` 进程的权限下运行，不在 agent 沙箱里。装一个插件 = 允许它的代码在你的机器上执行。

## 本插件能碰到什么

| 能力 | 位置 | 说明 |
|---|---|---|
| 执行 shell 命令 | Host | 只会调用 `crwu` / `dws` / `ossutil` 等具名 CLI，且命令白名单写死在 Host |
| 读写文件 | Host | 案例目录、`~/.ossutilconfig`（权限 600）、技能自己的配置文件 |
| 发起子代理 | Host | 一次只允许一条审核；只允许挂在顶层会话下（`requireTopLevelParent`） |
| 访问阿里云 OSS | Host | 只用配置里的 bucket/prefix；`oss-index`、`oss-result`、`oss-link` 都做前缀校验 |
| 浏览器渲染 | Client | 只渲染面板。Client 半**不得**导入 `node:*`、不得直接读写本地文件 |

**绝对不会**发生的事：Token / AccessKey / 签名 URL 不回显、不进日志、不进错误详情、不进前端持久状态；
`workbench:oss-result` 只返回精简摘要，不把完整证据链塞进列表接口。

## 凭据存放位置

插件自身**不存**任何凭据。运行期依赖的凭据由各自的工具持有：

- `~/.ossutilconfig`（600）—— OSS AccessKey，由 `workbench:oss-cred-save` 写入
- `~/.dsh/…` —— 氚云 / 钉钉会话
- 技能自己的配置文件 —— iFinD `auth_token`（Host 只回长度，不回显）

这些路径下任何内容都**不进本仓**，也不应贴进对话。

## 报告漏洞

发现以下任一情况，请直接联系仓库维护者，**不要**开公开 issue：

- 能把 OSS 读写越出配置的 bucket / prefix；
- 能让 Client 半执行任意命令或读任意文件；
- 能在响应体、日志或错误信息里捞到凭据；
- 能绕过「单条并发」「只挂顶层会话」这类门禁。

报告时请附：DSH 版本、插件形态（`legacy/` 动态还是 `src/` 包）、复现步骤、以及你实际看到的输出。
**不要**在报告里附带真实 AccessKey、Token 或内部审核材料 —— 用占位符替换。
