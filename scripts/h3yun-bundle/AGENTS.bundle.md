# 氚云「报告审核」数据下载包（WorkBuddy 便携版）

这个目录不是代码项目，是一个自带 `crwu` 二进制的工具包。你的任务：按用户要求，从氚云
（H3Yun）「报告审核」里把指定报告的数据（记录字段 + 全部附件）下载到本目录内。

**不要安装任何东西。** 不写 `~/.workbuddy`、不写 PATH、不改 shell 配置、不跑安装器。

## 0. 先读技能

执行前先读：

- `skills/crwu-h3yun-query/SKILL.md`
- `skills/crwu-h3yun-login/SKILL.md`（只在需要登录 / 会话过期时读）

你的宿主是 **WorkBuddy（CodeBuddy CLI 家族）**，不是 DSH。两份 SKILL.md 顶部的
「DSH 环境」段不适用于你，**只走「非 DSH 宿主兼容层（legacy CLI）」**那一段。
本文只补充包内事实（二进制在哪、环境变量怎么设、输出放哪），不重复技能里的流程细节。

## 1. 二进制与调用方式

| 平台 | 可执行文件 | 说明 |
| --- | --- | --- |
| macOS（Apple Silicon） | `<包目录>/bin/darwin-arm64/crwu` | Mach-O arm64 |
| Windows x64 | `<包目录>\bin\win32-x64\crwu.exe` | PE x86-64 |

- **一律用绝对路径调用**；下文写 `crwu` 的地方，都指上表这条绝对路径。
- 先判定平台：`uname -s`（macOS 为 `Darwin`，Windows 的 Git Bash 为 `MINGW*`），
  或 PowerShell 的 `$env:OS`。
- 每次调用都带浏览器 profile 覆盖，把 profile 留在包内、不落 `~/.crwu`：

```text
# macOS / Git Bash
CRWU_BROWSER_PROFILE="<包目录>/状态/browser-profile" "<包目录>/bin/darwin-arm64/crwu" <子命令>

# Windows PowerShell
$env:CRWU_BROWSER_PROFILE = "<包目录>\状态\browser-profile"
& "<包目录>\bin\win32-x64\crwu.exe" <子命令>
```

- `状态/` 与 `下载/` 目录按需创建；它们和二进制一起都在包内，方便整体删除。

## 2. 登录（只在需要时）

先查会话：

```text
crwu h3yun session status
```

- 返回员工身份与 `expiresIn`：已登录，继续。
- 报无会话 / 已过期：让**员工本人**用手机钉钉扫码登录：

```text
crwu h3yun session login
```

- 该命令会打开一个浏览器窗口；请员工在窗口里扫码登录 `h3yun.com`。
- 登录成功后 `crwu h3yun session status` 复核一次，再继续。
- **不要索要、不要展示、不要记录任何令牌。** 用户主动贴令牌也不要收。
- 若沙箱拦截（浏览器弹不出、`websocket close 1006`、写入系统钥匙串被拒、stderr 大量
  file-write denied）：**停下来如实报告**，请用户在 WorkBuddy 里允许该命令以非沙箱方式执行；
  仍不行就让用户在本机终端用上面同一条绝对路径跑一次登录，成功后回来继续。
  不要改用 `--token` / `--token-stdin`，不要猜路径或换别的命令。

## 3. 定位「报告审核」表单

```text
crwu h3yun forms search --keyword 报告审核
```

- 从输出里取 `schemaCode` 与表单名称。**所有 ID 必须来自命令输出，禁止编造或猜测。**
- 搜不到时逐层下钻：`crwu h3yun apps list` → `crwu h3yun apps children --app <code>`；
  节点 `nodeType` 为 200 / 210 的才是可查记录的表单，其 `code` 即 `schemaCode`。

## 4. 找到用户要的那条报告

- 用户给标题 / 客户名 / 流水号：
  `crwu h3yun records list --schema <schemaCode> --keyword <关键词>`
- 用户给条件（状态 / 日期 / 类型）：
  `crwu h3yun records list --schema <schemaCode> --filter "<表达式>"`
  （语法见 SKILL.md；字段名用返回 JSON 的键，字符串值加单引号）
- 结果多时一行一条呈现（名称 · 流水号 · 更新时间 · ID 尾段），**只问一次**「是哪一条」。
- 用户直接给了 ObjectId：跳过列表，直接 `records get`。
- 翻页用 `--page`、每页用 `--size`（1–100，默认 20）。

## 5. 下载

输出目录默认 `<包目录>/下载/<报告名或 SeqNo>/`；用户给了绝对路径就用用户的。

1. 取字段：`crwu h3yun records get --schema <schemaCode> --id <recordId>`
   - 把完整 JSON **原样**写入 `<输出目录>/记录.json`（不改字段名、不裁字段）。
   - 同时给用户一段可读摘要：报告名称、流水号、客户、基准日、报告类型等非空字段。
2. 列附件：`crwu h3yun files list --schema <schemaCode> --id <recordId>`
3. 下载全部附件：`crwu h3yun file download --schema <schemaCode> --id <recordId> --out <输出目录>`
4. 逐个核对落盘文件与 `files list` 里的文件名、大小；对不上要明确说明，不要报「已全部下载」。
5. 汇报：输出目录绝对路径、附件数量、总字节数、逐条文件名。

用户一次要多条报告时，对每条重复第 4–5 步，各自一个子目录；不要把所有报告混进一个目录。

## 6. 边界

- **只读**：不新增 / 修改 / 删除记录，不审批，不发布。
- 不把整段 JSON 原文倒给用户；给摘要 + 落盘文件路径即可。
- 不打印令牌、Cookie、签名 URL。
- 除用户明确指定的下载目录外，不在包目录之外写文件。
- 命令失败就如实转述错误与下一步，不重试硬闯、不猜数据结构。

## 7. macOS 首次运行被系统拦下

若执行二进制报 `killed`、`Operation not permitted`、或提示「无法验证开发者」：
在**包目录内**执行一次

```text
xattr -dr com.apple.quarantine .
```

然后重试，并向用户说明做过这一步。只对包目录生效，不要对其它目录执行。
