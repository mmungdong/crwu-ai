# crwu-h3yun-bundle · 氚云「报告审核」数据下载包

给 WorkBuddy 用的零安装小工具。解压 → 把提示词发给 WorkBuddy → 它把氚云「报告审核」里
某条报告的字段和全部附件下载到你指定的目录。

不要安装任何东西，也不用改你的系统配置——所有文件都在这个目录里，删掉目录就清干净。

## 三步

1. **解压**到桌面或「文档」都行（路径尽量不要带 `#`、`%` 这类字符）。
2. 把 `PROMPT.md` 里的**提示词 ②**整段复制给 WorkBuddy。
3. 按它的问题回答：哪条报告（名称 / 流水号 / ObjectId）、存到哪（不填就存在包内 `下载/`）。

> 想先搞清楚这个包是什么，可以先发**提示词 ①** 让它介绍，再发提示词 ② 让它干活。

## 包里有什么

| 路径 | 作用 |
| --- | --- |
| `AGENTS.md` | 给 AI 的执行规则（WorkBuddy 打开本目录时会自动读；提示词里也会点名） |
| `PROMPT.md` | 两段可直接复制的提示词：① 介绍这个包 ② 下载报告数据 |
| `skills/crwu-h3yun-query/` | 查询技能：找表单、翻记录、看附件 |
| `skills/crwu-h3yun-login/` | 登录技能：钉钉扫码绑定本机会话 |
| `bin/darwin-arm64/crwu` | macOS（Apple Silicon）可执行文件 |
| `bin/win32-x64/crwu.exe` | Windows 64 位可执行文件 |
| `VERSION.txt` | 版本、构建提交、每个文件的 SHA-256 |

## 第一次用要登录一次

- WorkBuddy 会调用 `crwu h3yun session login`，弹出一个浏览器窗口，请你用**手机钉钉**扫码
  登录氚云（`h3yun.com`）。扫码的是谁，用的就是谁的权限。
- 令牌只写入你电脑的系统钥匙串，不显示、不发给 AI、不进聊天。
- 想解除绑定：在解压目录里执行 `bin/darwin-arm64/crwu h3yun session clear`
  （Windows 换成 `bin\win32-x64\crwu.exe h3yun session clear`）。

## 会在你电脑上留下什么

| 位置 | 内容 | 怎么清 |
| --- | --- | --- |
| 解压目录 | 下载的报告、`状态/`（浏览器登录态） | 整个目录删掉 |
| 系统钥匙串 | 一条氚云会话凭据（登录必需） | `crwu h3yun session clear` |
| 其它位置 | 无 PATH 改动、无 `~/.workbuddy`、无 `~/.crwu`、无后台服务 | — |

## 遇到问题

| 现象 | 处理 |
| --- | --- |
| macOS 提示「无法验证开发者」/ 命令直接被杀掉 | 在解压目录执行 `xattr -dr com.apple.quarantine .` 后重试 |
| 浏览器窗口弹不出来 / `websocket close 1006` | 允许 WorkBuddy 以非沙箱方式执行这条命令；或让 AI 给出命令，你贴到「终端」里跑一次登录 |
| 提示没有会话 / 会话过期 | 重新扫码登录（流程见上一节） |
| 找不到「报告审核」表单 | 让 AI 用 `apps list` → `apps children` 逐层下钻；表单名可能带年份或部门前缀 |
| 附件下载不全 | 让它把 `files list` 与落盘文件逐个对照，报告差异 |

## 说明

- 只读工具：不会新增、修改、删除氚云里的任何记录，也不会提交审批。
- 只支持 macOS（Apple Silicon）与 Windows x64；Intel Mac 与 Linux 没有对应二进制。
- 版本与来源见 `VERSION.txt`（`crwu` 版本、构建提交、文件哈希）。
