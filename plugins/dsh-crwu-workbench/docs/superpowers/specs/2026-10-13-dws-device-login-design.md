# 钉钉设备流登录设计（`dws auth login --device`）

> 文档性质：2026-10-13 的**设计快照**（brainstorming 逐节确认的产出），不是当前操作指南。
> 实现落地后以源码、测试与项目 `AGENTS.md` 为准。
>
> **目标发布**：`dsh-crwu-workbench@0.0.42`　**基线**：分支 `fix/dws_login`（`83e78b0`）
> **协议**：31 → 32

> **⚠️ 落地后的修订（2026-10-13，真机验收期间）** —— 下面 §1~§11 是评审通过时的设计；
> 实现过程中被真机证据改掉了四处，**这几处以本说明为准**：
>
> 1. **授权页由插件打开，而且用 `open -n`（强制新实例）**。macOS 上某个应用已经在运行时，
>    `open <url>` 会把 URL 投给**正在跑的那个实例**：现场是 WorkBuddy 的 `agent-browser` 挂着
>    一个**无头 Edge**，URL 被它吞掉而 `open` 照样退出 0 —— 员工看到「浏览器打不开 / 地址栏空白」。
>    氚云之所以正常，是因为 `crwu` 不用 `open`。两条登录路现在都传 `--no-browser` 并自己 `open -n`。
> 2. **设备流优先打开「已填入授权码」那一版链接**（`url`），并把「手动输入授权码的链接」单独回传
>    （`urlManual`）。按位置"取最后一个 URL"恰好会选错。
> 3. **多一条操作 `dws-login-cancel`**（操作清单 45 → 46）：取消正在跑的 **loopback** 登录。
>    loopback 最长占 5 分钟且与设备流抢同一把 `.dws` 锁 —— 那段时间设备流按钮曾经是灰的，
>    员工点完「登录钉钉」没有任何出路。现在它变成「改用设备流登录」（先取消、再起）。
>    `DwsLoginResult` 相应多了 `cancelled` / `url` / `opened` / `openError`。
> 4. **界面文案收窄**：账号连接那一步只留一句「登录钉钉按钮一直失败？试试下面的「设备流登录」。」，
>    长段落撤掉（权限说明由 Host 的归因在失败那一刻给出）。

## 1. 目标与成功标准

员工在自己的 DSH 工作台里点一下，就能走钉钉 CLI 的**设备流**完成登录：面板给出授权码与授权链接、
自动尝试用系统浏览器打开授权页面、员工确认之后**面板自动判定成功**并刷新环境自检。

需求场景（用户 2026-10-13 确认，单选）：**loopback 回调不通 / 无头环境** ——
浏览器打开的 `127.0.0.1` 回不到 CLI，或该环境根本拿不到本机浏览器。

可观察的成功标准：

1. 环境信息 → ① 账号连接 → 「钉钉认证」那一行有**第二颗**按钮「设备流登录」；点下去**秒级**出现
   授权码与链接（不是黑等 5 分钟）。
2. 授权码与链接都能一键复制；「打开授权页面」用系统默认浏览器打开。
3. dws 那边授权成功后，**不需要手动点「重新检查」**：钉钉那一行自动转「已通过」。
4. loopback 那条「登录钉钉（打开系统浏览器）」的行为**零变化**。
5. 失败或超时给的是人话 + 下一步动作 + dws 原文，不是 `Command failed`。

## 2. 为什么必须是两阶段（证据）

- `dws auth login --device` 是**一体化长流程**：先请求设备授权码，打印
  「请在浏览器中打开以下链接，并输入授权码：」+ 短 URL + user_code，然后**在终端轮询等待**
  （过期码会自动重发），总超时 5 分钟。
  证据：包内二进制 `bin/darwin-arm64/dws` 的 i18n 串 —— `请求设备授权码...`、
  `请在浏览器中打开以下链接，并输入授权码：`、`授权码将在 %d 秒后过期。`、
  `授权码已过期，正在重新发起设备授权流程...`、`授权超时（5分钟），请重试`。
- 同步等它结束 = 面板在整个等待期拿不到授权码，等于没有这个功能。这正是协议 21 当初把它改成
  `dws-login-start` / `dws-login-status` 的理由；协议 22（2026-09-30）删除它，依据的是当时
  「DSH 不再提供设备码登录」的口径。**本次是用户重新提出的新口径**，历史实现可以复用，
  但当时的禁止性结论必须一起改（见 §8 与 §10）。
- **能力边界必须写在设计里**：设备流**救不了**「Windows 权限不足 / `.dws` 锁被拒」那类故障 ——
  它和 loopback 抢的是同一把锁。它解决的是**回调链路**，不是权限。

## 3. 非目标

- 不动氚云登录（`relogin`）。
- 不改 loopback 的 `dws-login` 语义，**不**把两种登录合并成一个状态机。
- **不**新增「打开任意 URL」的 Host 操作。
- 不解析授权码有效期（dws 自己会重发），不显示 dws 之外的倒计时。

## 4. 契约（协议 31 → 32）

三条 Host 操作，入参一律为空对象：

| 操作 | 入参 | 返回 |
| --- | --- | --- |
| `dws-login-device-start` | `{}` | `DwsDeviceLoginView` |
| `dws-login-device-status` | `{}` | `DwsDeviceLoginView \| null` |
| `dws-login-device-cancel` | `{}` | `DwsDeviceLoginView` |

```ts
export interface DwsDeviceLoginView {
  phase: 'running' | 'ok' | 'failed' | 'timeout'
  url: string          // Host 校验过的 https（钉钉域白名单）；空串 = 还没打印出来
  userCode: string     // 面板要显示的那个码；空串 = 还没有
  tail: string         // dws 原文尾巴（≤600 字），给人看
  error: string        // 人话；空串 = 没有
  advice: string       // 沙箱归因给出的下一步动作
  sandboxBlocked: boolean
  deadlineAt: string   // Host 自己的 5 分钟上限（ISO）
}
```

刻意的取舍：

- **入参为空**：URL / user_code / argv 全部由 Host 自己解析。客户端不能提交，否则面板就成了
  「让宿主打开任意 URL」的入口。
- **不假装知道码的有效期**：dws 会自己重发过期码，Host 只报**自己**的 5 分钟上限（这是真事实）。
  dws 那句「授权码将在 N 秒后过期」只留在 `tail` 里给人看。
- **没有 `idle`**：从没 `start` 过时 `status` 回 `null`。
- 协议号 +1 的理由：旧宿主没有这三条操作（新界面点下去 404），旧界面也不会调它们。
  必须靠协议号把错配喊出来，而不是让它表现成「点一下没反应」或白等 5 分钟（与协议 21/22 同源）。
- 三条操作要同时进 `src/host/ops/core.ts` 的**已移植清单**（那里有一块按协议分段的注释）
  与客户端门面 `src/client/features/report-audit/api.ts` 的 `OPERATION_OF`
  —— 两侧双向核对由既有测试强制，少一侧就是点下去 404。

## 5. 数据流与生命周期

1. 员工点【设备流登录】→ `dws-login-device-start`
2. Host 走**既有**的授权判据（操作名仍是 `dws.auth.login`，提权 + 会话工作目录）→
   `access.startShell` 起后台 `dws auth login --device`
3. Host 每 500ms 读一次**增量**输出，从累积输出里解析短 URL 与 user_code；5 分钟封顶
4. 客户端拿到快照：渲染授权码 → 尝试 `window.open(url)` → 每 1s 轮询 `status`
5. 终态 `ok` → 自动刷新环境自检，钉钉那一行转「已通过」；`failed` / `timeout` → 原文 + 归因 + 重试

细节：

- **解析是尽力而为，不是契约**：`parseDwsDeviceAuthorization(output) → { url, userCode }`。
  URL 取第一个 `https://…` 片段并去掉尾部标点；userCode 先认「4 位以上、带连字符的大写码」，
  再认「授权码 / user code」标签之后的 token。**解析不出来不让流程失败** —— `tail` 永远兜底。
- **会话注册表由 `apply()` 持有**（不是模块级单例）：它持有后台进程与定时器，卸载后残留就是
  「看不见的进程还占着 `~/.dws` 的锁」。`dispose()` 必须 kill 进程并清定时器。
- **重复点击去重**：`running` 时再 `start` 只回当前快照，**不**起第二个进程 —— 两个 `dws` 会抢
  同一把锁，第二个必以 `Access is denied` 失败，而那个报错会被误读成权限问题。
- **切页 / 切会话不 kill**（用户已确认）：客户端停轮询，进程留在 Host；切回来仍看到正在跑的那次
  与剩余时间。只有「取消」、5 分钟超时、插件卸载才 kill。
  这条要求**组件挂载时先调一次 `status`**：会话在 Host 手里，客户端重挂之后只有主动问一次
  才知道「已经有一次在跑」，否则"切回来还看得到"就只是同一棵组件树没被卸载时的巧合。
- 历史实现踩过的两个坑，实现时照抄注释里的结论：`settle()` 必须**先清定时器再判状态**（否则
  轮询 interval 永远留在事件循环里），终态回调必须**一次性**（用守卫，别让一次登录刷两次环境）。

## 6. 两个登录撞同一把锁（用户已确认：Host 侧拦截）

面板上是两颗按钮，背后是同一把 `~/.dws` 锁。两个方向分别处理，因为 **Host 只知道其中一个方向**：

- **设备流 running → 员工点 loopback**：`dws-login` handler 在起进程**之前**先判一次设备流会话；
  running 就直接回
  `{ ok: false, error: '设备流登录正在进行：请先点上面那颗「取消」，或等它结束再试（两次登录会抢 .dws 的同一把锁）' }`，
  **一个进程都不起**。理由：让 dws 自己报 `Access is denied` 会被现有归因读成「权限不足」，
  正是这个模块历史上踩过的坑。
- **loopback 在跑 → 员工点设备流**：Host **追踪不到**（它就是一次前台 `await`）。由**客户端**在
  loopback 请求进行中禁用设备流按钮。

  注意现状：客户端**现在没有**「登录进行中」这个标志 —— `runLogin` 只管 `loginMessage`
  （已经显示了"正在等待…"），两颗登录按钮的 `disabled` 只看本机访问是否已授权。
  所以这一条要**新加**一个登录进行中的标志，由 `runLogin` 维护，并同时钉住设备流按钮的
  禁用态与文案；不要假设它已经存在。

## 7. UI 与文案

**位置**：① 账号连接 → 「钉钉认证」那一行里加第二颗按钮（第一颗仍是 loopback）。不新增页级大卡，
新组件 `src/client/features/environment/DeviceLoginCard.tsx` 嵌在现有 `SetupRow` 里，
只用既有的 `Button` / `Chip` / `C.item*` 语言（对齐 `ui-design-guidelines.md` §6.8 的
「引导式配置工作区」）。

四个状态：

| 状态 | 呈现 |
| --- | --- |
| 闲时 | 一颗按钮「设备流登录（浏览器回调不通时用）」 |
| 等待中 | `等待你在浏览器里完成授权…（还剩 4:37）` / 授权码等宽大字号拉开字距 + 「复制授权码」/ 链接一行 + 「打开授权页面」+「复制链接」/「取消」 |
| 成功 | `钉钉已授权，已重新检查环境`（自检已自动刷新，钉钉那行转「已通过」） |
| 失败 / 超时 | 人话 + 沙箱归因的下一步动作 + dws 原文尾巴 + 「重试」 |

**文案必须改的地方**（不是只加新键就算完）：

- `zhCN.envDwsLoginNoDeviceCode` 现在写着「DSH 不提供设备码登录」——**事实反了，必须改**成新口径：
  loopback 是首选，浏览器回调不通 / 无头环境时用设备流。
- `zhCN.ts` 里那条「没有 `dwsLoginDevice`（设备码登录）」的约束注释同理。
- `zhCN.envAccountsHint` 那句「都由本机 CLI 打开系统浏览器完成」要补设备流这一支。
- `login-failure.ts` 里两句「设备码登录在这个模式下也走不通 / 不是绕过办法」在事实层面**仍然成立且更贴切**，
  但指向要改成面板上真实存在的那颗按钮（「设备流登录」），别让员工去找一个不存在的入口。

## 8. 安全与治理边界

- **URL 下发前校验**：必须 `https://`，且 host 属于 `dingtalk.com` 或 `dingtalk.io`（含子域）。
  匹配按**域名后缀**做（`host === d || host.endsWith('.' + d)`），不是 `includes`
  —— 否则 `dingtalk.com.evil.tld` 会被放过去。校验不过就只回 `tail`、`url` 回空串。
  白名单里带上 `.io` 是因为 `dws auth login` 有国际版入口（本次不传 `--intl`，但白名单不因此变窄）。
- **`user_code` 是本人本次登录的一次性短码**：只回显给发起它的那个人；不落盘、不进 Host 日志、
  不进 `access-diagnostics`、不进对话与任何模型可见结果。
- **规则变更（本次 brainstorming 中已与用户确认）**：`plugins/dsh-crwu-workbench/AGENTS.md` 现在写着
  "the plugin does not collect passwords, browser cookies, QR credentials, or **device codes**"。
  设备流让面板**显示**设备码，所以这条必须改写成准确口径：
  > 面板只把**本人本次登录**的设备码回显给本人（不落盘、不进日志、不进对话）；
  > 插件仍然不收集口令、浏览器 Cookie 与二维码凭据。
- **不新增「打开任意 URL」的 Host 操作**：开页由客户端 `window.open` 完成（桌面端主进程转
  `shell.openExternal` → 系统默认浏览器；Web profile 开浏览器标签页），与 `oss-link` 在
  2026-10-11 采用的快路径同源，少一次提权进程。
- **自动开页是尽力而为**：它在 `await` 之后发生、不是用户手势，可能被弹窗拦截。**可靠路径是那颗
  「打开授权页面」按钮**；被拦不算失败，链接与码都摆在面板上可复制 —— 这恰好就是无头场景的走法。

## 9. 测试计划

### 9.1 Host 新增 `tests/unit/host-dws-login-device.test.mjs`

1. 解析：两种 user_code 写法 + URL 去尾部标点；解析不出来不失败、只回 tail。
2. 重复点击不启第二个进程（替身数进程数）。
3. 5 分钟超时 → kill + `phase='timeout'`（注入小 `limitMs`）。
4. `cancel` 杀掉进程且 phase 落定。
5. `dispose` 清定时器（缺陷注入：不清则测试进程退不出来 —— 历史踩过）。
6. 沙箱归因：`.dws` 锁被拒 → `sandboxBlocked=true` + `advice` 非空。
7. URL 白名单：非钉钉域 / `http://` → 只回 tail。
8. 入参被忽略：传 `url` / `userCode` / `argv` 不改变结果。
9. 设备流 running 时 `dws-login` 被拒，且**没有**起进程。

### 9.2 Client 新增 `tests/unit/client-dws-device-card.test.mjs`

1. `start` → 渲染授权码 → 轮询 → 终态触发 `envStatus.refresh()`（断言**真实刷新次数**，不靠固定等待）。
2. 挂载时 `status` 已经是 `running` → 直接进等待态并接着轮询（「切回来还看得到」的判据）。
3. `window.open` 返回 `null` 不算失败，链接仍可复制。
4. 取消；loopback 登录进行中时设备流按钮禁用。
5. 文案断言：`zhCN` 里不再出现「不提供设备码」。

### 9.3 必须**一起改**的既有断言（不改就是自相矛盾）

| 位置 | 现在钉住什么 | 本次怎么改 |
| --- | --- | --- |
| `client-package.test.mjs:2868` | 「账号连接…没有设备码」+ 按钮文案不许含「设备码登录」+ 必须含「DSH 不提供设备码登录」 | 改成新口径：设备流按钮**必须在**、loopback 按钮仍在；「内置浏览器 / 二维码」的禁止条款保留，`envDwsLoginNoDeviceCode` 那条断言换成新文案键 |
| `host-system-ops.test.mjs:236` | `dwsLogin` 即使收到 `{ device: true }` 也**不**拼 `--device` | 保留「loopback 不拼 `--device`」，删掉「插件不提供设备码登录」的注释与理由（设备流现在走**新操作**，不是给 `dwsLogin` 加分支） |
| `host-package.test.mjs:332/397` | `WORKBENCH_PROTOCOL === 31`、`FROZEN_OPERATION_COUNT === 42` | 改成 32 / 45，并按既有格式补一段协议 32 的理由 |
| `client-rpc-facade.test.mjs:64` | 门面样例参数表 | 补三条新方法的样例参数（新方法入参为空对象） |
| `host-login-failure.test.mjs:44` | `.dws` 锁被拒时归因里点明「设备码登录不是绕过办法」 | **断言保留**（事实仍成立），但断言的实际文案要跟着 §7 的指向更新 |

## 10. 文档与发布

- 插件 `AGENTS.md`：§8 那条「不收集设备码」的规则。
- `docs/development-notes.md`：§14 顶部「**不得**据此恢复任何内置登录入口或设备码流程」与 §20.2
  「删掉 `dws-login-start` / `dws-login-status`」两处 —— 不改的话，下一个人读到的规则和代码是反的。
  按本仓文档生命周期规则标注为历史结论 + 本次新口径，不要机械重写史实。
- `docs/ui-design-guidelines.md` §6.8 账号连接那一段。
- `README.md` / `README.en.md` 登录段（「登录也由面板发起」那处）。
- `CHANGELOG.md` + `npm run version:set 0.0.42`。
- `src/shared/consts.ts` 协议注释追加第 32 条。

**验证**：`npm run check`（typecheck / test / build / smoke / pack:assert）+ `git diff --check`。
真机那一步（点一次、看自动开页、授权后自动转已登录）由用户执行 —— 按插件 `AGENTS.md`，
agent 可以构建并安装链接开发包，但**不能**替用户做这一步。

## 11. 风险与未决

- **解析依赖 dws 的人类可读输出**（上游二进制，没有结构化契约）→ 所以设计成解析失败不阻塞，
  `tail` 永远兜底。
- **自动开页可能被弹窗拦截** → 已按「按钮才是可靠路径」设计。
- **5 分钟窗口内进程持有 `.dws` 锁** → 由 §6 的 Host 侧拦截 + 「取消」缓解。
- **暂不暴露会话 id**：开发者诊断里不加设备流会话标识 —— 它没有诊断价值，反而多一个泄漏面。
