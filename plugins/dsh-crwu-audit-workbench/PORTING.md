# 旧动态形态 → 包 的移植清单（**已完成、已验证、已收尾**）

本文件记录**旧动态形态**（`legacy/host.js` + `legacy/client.js`，2026-09-20 收尾时已删除）
逐项迁进 `src/` 包形态的全过程：结论、差异、缺口、验证账。
**24 个 `workbench:*` RPC 与 Client 面板已经全部搬进 `src/`。**

## 状态：Host 半 24/24，Client 半已重写

搬完的依据不是人工核对，而是一条**可反向失败**的测试
（`tests/unit/host-package.test.mjs` → `the package Host half implements every legacy workbench:* handler`）：
它直接从 `legacy/host.js` 里读 handler 名单，与 `src/host/ops/core.ts` 的操作表逐一对账，
并反向检查包形态没有 legacy 之外的多余操作（目前只允许 `ping`，那是包形态为链路自检新增的）。

| 层 | 内容 | 落点 |
|---|---|---|
| 1 | 命令执行 / 文件与路径 / 平台与主目录 / 环境清单与探测 / `env` 聚合 | `src/host/shell`、`fs`、`platform`、`environment` |
| 2 | crwu 白名单执行器 / 氚云应答解析 / 表单定位 / `pending` 列表 / OSS 凭据读取 | `src/host/crwu`、`h3yun`、`oss` |
| 3 | 审核记录持久化 / 占用锁恢复 / 工作空间解析 | `src/host/state`、`workspace` |
| 4 | 审核生命周期（顶层会话门禁、单条并发、带时间戳重启、状态聚合与自愈） | `src/host/audit` |
| 5 | OSS 交付件（列举 / 按 key 读摘要 / 签名链接 / 重传 / 凭据保存）+ 上传看门狗 | `src/host/oss` |
| 6 | 零碎操作（剪贴板 / 打开文件 / 登录 / 会话查询 / 凭据查看） | `src/host/system` |
| 7 | Client：规则层（纯 `.ts`，独立可测）、类型化 RPC 门面、线协议契约、渲染层 | `src/client/features`、`src/shared/types.ts` |

## 迁移中确认的结论（改代码前值得先读）

这些坑都是 legacy 用真实故障换来的，移植时逐条确认后保留：

1. **审核存活判据是子 Agent 自己的 `status === 'running'`**，与父会话无关。
   `subagents.listChildren` 由会话存储驱动，跑完的一次性子会话**依然在列** —— 「在清单里」不等于「还活着」。
   旧实现把清单当存活依据，父会话一变就全体查不到，表现为「状态跟丢」。
2. **停一条 one-shot 审核必须「先 abort 再 dispose」**。真正的取消发生在驱动监听调用方 signal 的
   abort 事件时；`run.dispose()` 会先摘掉 abort 监听再 await 结果，单独调它等于干等审核跑完。
   `subagents.interrupt` 对 one-shot 是记录在案的 no-op，只作兜底。
3. **「停止」与「重新审核」必须互斥**：子会话还活着只能停，已结束才能重审。给了口子 = 一份报告
   同时跑两条子会话，而它们往**同一个案例目录**对写。
4. **占用锁要一起恢复、也要自愈**：只恢复记录不恢复锁，同一条报告能被起第二条；反过来锁指向一个
   早已结束、甚至没有记录的 childId 时，界面上没有任何入口能释放它，这条报告就再也起不来了。
5. **绝不采用「父会话自己的工作空间」当默认案例根**：父会话常常开在源码仓库里，照搬会把审核产物
   写进代码仓库。判据只有「用户显式选过」与「清单按名字/路径命中且目录真实存在」。
6. **同源接口的越界判据只有一处**：`stripPrefix`。所有按 key 读对象/签名的操作先过它。
7. **`oss-result` 只回摘要**，完整证据链不进列表接口；签名 URL 必须升级成 https（带 bearer 签名）。
8. **切换标签、翻页、检索都不得重新列举 OSS**，只有首次进入、显式刷新、上传成功后才列举。
9. **包形态的产物必须满足 DSH 的加载契约**（`window.__ModuleLoader__.load` + 只 require react），
   见 `AGENTS.md` §4.1.1；`npm run pack:assert` 强制。

## 与 legacy 的既定差异（有意的，不是遗漏）

| 位置 | legacy | 包形态 | 原因 |
|---|---|---|---|
| 内置案例根 `DEFAULT_CASE_ROOT` | `/Users/mungdong/crwu-audit-workspace` | 空串 | 那是作者本机绝对路径，分发出去会把别人的产物写到不存在的目录 |
| 平台识别失败 | 返回空串 | 退回 Host 的 `process.platform` | 多给一个可信兜底；「未识别」仍然会 block |
| Windows 命令引用 | 单引号（`cmd.exe` 不认） | `shellQuote` 按平台选引号 | legacy 的版本探测在 Windows 上必失败 |
| `extractAuditSummary` 的 `overallDecision` | `text(root.summary ? … : '')` | `asText(summary.overallDecision)` | 加了 `rec()` 收窄入口后 `: ''` 兜底等价多余 |
| 清单 `binaries: []` | 回退内置 | 回退内置 | 同 legacy；否则环境自检会静默全绿 |
| 自动上传的失败留痕 | 「案例还没有交付件」「案例目录不可读」「未找到 ossutil」也写 `uploadError` | 这三类**只返回原因、不写 `uploadError`** | legacy 会把「还没有东西可传」记成上传失败，界面于是给一条尚未出结果的记录挂「上云失败」徽章，用户会去点重传。判定为「真的尝试上传但失败」才留痕 |

## 链路级等价（操作名对得上 ≠ 功能等价）

`tests/unit/host-package.test.mjs` 里那条对账测试只核对**操作名**。它核不出「某个功能的触发链路
整段缺失」——这类缺口已经抓到四次，都是静默的：

| 轮次 | 缺口 | 不修的后果 |
|---|---|---|
| 14 | `slots.inject` 被多包了一层 `ctx.effect` | `apply()` 激活阶段抛 `Invalid effect`，面板不出现 |
| 15 | 自动上传把「还没有交付件」记成失败 | 给未出结果的记录挂「上云失败」徽章 |
| 17 | **没有订阅 `subagent/end` / `agent/status`** | `ended`/`endReason` 永远为空 → 「已中断」永不出现，且**「交付件自动上云」整个不触发** |
| 18 | `audit-start` 少了「必须已选定工作空间」的门禁 | 案例目录为空 → 指令里没有「唯一根目录」→ 子会话写进继承的 cwd（常常是源码仓库） |
| 18 | `workspace-auto` 只清内存、不清磁盘也不重新采用 | 点完「恢复自动识别」后没有工作空间，且重启后旧选择回来 |
| 19 | `install-prompt` 的文案是手写改写版 | 丢掉「不要试探连通性」「以清单为唯一权威」两条**安全相关**指令 |
| 20 | **Client 只注册了 4 个槽位里的 2 个** | 少了 `conversation.session.header.utilities` → 界面**没有任何办法登记审核父级** → `audit-start` 永远失败，审核流程无法从界面发起 |
| 26 | **把「命令没跑起来」当成「命令不存在」** | 沙箱后端不可用时（本机 `sandbox-exec` 无法套娃），环境自检对装好了 Node / Python / dws 的机器报「未安装」、OSS 报「ossutil 未安装」，把人送去装已经装好的东西；`resolveOssutil` / 服务探测 / 版本探测三处都犯 |
| 26 | **没容忍 `ossutil` 写在 stdout 的尾巴** | `ossutil` v1.7.19 无条件把 `<n>(s) elapsed` 写到 **stdout**（`-q` / `--quiet` / `--loglevel` 都关不掉，它连错误也写 stdout）。于是对**每一个真实对象**的 `JSON.parse` 都失败 → 「审核信息」抽屉永远报「审核结果不是合法 JSON」。legacy 的 `parseJsonLoose` 同样只是 `try JSON.parse`，**一样中招** —— 这条不是移植引入的，是拿真实对象才看得见的存量缺陷 |

**第 26 轮的另一条教训（不是 legacy 的锅，是我自己踩的）**：`parseJsonLoose` **返回 null 而不抛错**，
而它替换掉的那些 `JSON.parse` 调用点里，有几个正是**靠抛异常**判失败的（`loadManifest` 的
`catch → loaded:false`、`loadPending` / `discoverForm` 的 `catch → 报 CLI 原因`）。
换函数时必须逐个调用点改成显式判空 —— 否则一份坏清单会被当成「已加载」、一次坏取数会被显示成
「0 条待办」。这次是**已有的测试先红了**才发现的（3 条），正好说明「防假绿」那类断言的价值。


查法（可重复）：把 legacy 每个 handler 的**副作用调用集**抽出来，与包形态对应实现逐项对照；
`ctx.on` / `ctx.get` / 状态字段写入 这些「链路」必须逐一核对，而不是只看 handler 是否存在。

## 「搬完了」由机器判，不由叙述判（第 25 轮）

`tests/unit/port-coverage.test.mjs` 是这件事的判据，替代「我觉得搬完了」：

1. legacy 的每个组件（首字母大写的 `function X(props…)`）都必须在落点表里有 `src` 文件；
2. 落点表里的每个文件必须真的存在（防映射指向已删文件）；
3. legacy 的四个槽位必须**恰好**是 `apply.ts` 里 `slots.inject(...)` 的四个实参；
4. legacy 客户端调用过的每个 `workbench:*` 都必须是门面上真实存在的方法，且发出的操作名与它一致；
5. 反向：落点表里的组件名必须仍在 legacy 源码里（防改名后留下永远没人看的死行）。

**每条断言都做了证伪**（临时注入缺陷后必须变红），这一轮因此抓到两条**假通过**的断言：

| 原写法 | 为什么改坏也不红 | 改成 |
|---|---|---|
| `apply.includes("'sidebar.panellist'")` | `slots.register` 的 `name` 字段含同一个字面量，把 `inject` 的实参改坏照样命中 | 只解析 `slots.inject('…'` 的实参，并双向核对 |
| `api.includes('auditStart:')` | `api.ts` 里该串出现三次（接口声明/实现/操作名表），删掉实现仍有两次命中 | `import` 真门面，查 `typeof workbenchApi[m] === 'function'` 且 `OPERATION_OF[m] === op` |

（门面「声明的操作名」与「真的发出的操作名」是否一致，由 `tests/unit/client-rpc-facade.test.mjs`
覆盖 —— 两条测试合起来才闭合，单独任何一条都留口子。）

删掉 `legacy/` 之后第 1、3、5 条会因读不到 legacy 源码自然失效 —— 那正是「可以安全删」的信号。

## Client 半：legacy 界面元素 → src 落点

| legacy 元素 | src 落点 | 状态 |
|---|---|---|
| `PanelIcon` + 侧栏入口 | `components/PanelIcon.tsx` + `apply.ts`（`sidebar.panellist`） | ✅ |
| `Workbench` 外壳（自检/报告切换、轮询、通知） | `features/workbench/WorkbenchPanel.tsx` | ✅ |
| `EnvPane`（二进制/服务/平台/清单） | `features/environment/EnvironmentPane.tsx` | ✅ |
| `WorkspaceCard`（选目录/新建/自动识别/在新会话打开/cwd 不一致提醒） | `features/workbench/WorkspaceCard.tsx` + `workspace-view.ts` | ✅ |
| `OssAuthCard`（AK 表单 + 保存并实测 + 掩码展示） | `features/environment/OssAuthCard.tsx` | ✅ |
| `InstallPromptBlock`（只读文本框 + 复制 + 重新生成 + 403 提醒） | `features/environment/InstallPromptBlock.tsx` | ✅ |
| `IfindCard`（路径 + 长度 + 密钥来源） | `EnvironmentPane` 内的 `IfindCard` | ✅ |
| `TrustToggle`（记住氚云授权） | `EnvironmentPane` 内的复选框 | ✅ |
| `ReportPane`（页内标签 + 两张表 + 检索/翻页） | `features/report-audit/ReportPane.tsx` | ✅ |
| `AuditInfoDrawer` | `features/report-audit/AuditInfoDrawer.tsx` | ✅ |
| `rowAction`（徽章/按钮/二次确认） | `features/report-audit/row.ts`（纯规则）+ `ReportPane` 渲染 | ✅ |
| `AuditParentButton`（会话头登记） | `features/workbench/AuditParentButton.tsx`（`conversation.session.header.utilities`） | ✅ |
| `RunCardAction`（运行卡片：顺带登记 + 跳面板） | `features/workbench/RunCardAction.tsx`（`tool.view.cordis`） | ✅ |
| `openSession`（打开子会话：刷清单→试 mode→切面板） | `features/workbench/open-session.ts` | ✅ |
| `Handoff`（发起失败时的手工提示词） | `features/workbench/Handoff.tsx` | ✅ |
| `escalate` 免沙箱重试入口 | `ReportPane` 的 `escalateAvailable` 通知 | ✅ |
| `binStatusBadge` / `Chip` / `Card` 等原子件 | `components/primitives.tsx` | ✅（合并实现） |
| 头部状态行（氚云/钉钉/平台/审核中） | 分散在自检页与报告页的通知里 | ⚠️ 等价信息，布局不同 |

## 真实验证（已完成，2026-09-20）

装进独立 `smoke` profile（`dsh plugin --profile smoke add .` 会把包名同时写进
`dsh.profile.bundles`），以 `DSH_PERMISSION_MODE=danger-full-access` 起该 profile 后实测：

| 验到了什么 | 证据 |
|---|---|
| `apply()` 在真实 DSH 里跑完并注册同源路由 | `ping` → `{"ok":true,"rev":"pkg-0.0.1"}` |
| 真实平台 / fs / 清单解析 | `boot` → `platform=darwin-arm64`、`caseRoot=/Users/mungdong/中瑞世联工作空间`、`source=manifest-workspace` |
| 真实 shell + 真实 CLI | `env` → `allOk:true`；`crwu`/`dws`/`python3`/`ossutil` 均定位到真实路径 |
| 真实氚云 / 钉钉 / OSS | `env` → 氚云 `正常`（真实 userId + 到期）、钉钉 `已登录`、OSS `AK 正常`（真实 bucket 可列） |
| 真实待办与状态聚合 | `pending` → `total: 8608` 条真实记录；`audit-status` → 聚合到真实历史记录 |
| 客户端产物被登记并被原样服务 | 页面 `__DSH_BOOT__` 里 `{"id":"dsh-crwu-workbench","url":"/plugins/??dsh-crwu-workbench/client.js&rev=…"}`，取回的 bundle 与 `lib/client.js` 逐字一致（DSH 只追加一个 `;`），只 require `react`/`react/jsx-runtime`，四个槽位名齐全 |
| 同源防护在真实链路上有效 | 未知 op → 404；带外部 `Origin` → 403 |
| 客户端半在**真实浏览器**里跑通 | `install/browser-check.mjs`（真实 Edge）：侧栏入口出现、面板渲染、环境自检/待审核/AI审核结果三页都画出真实数据、**切标签 3 轮 `oss-index` 只调用 1 次**、控制台零报错 |

**客户端半后来用真实浏览器补验了**（`install/browser-check.mjs`：真实 Edge + `playwright-core`，
22 条全过、控制台零报错；证伪过两次：拿「没装插件的 profile」跑会红，把第 26 轮的 JSON 修复还原后抽屉 4 条也会红）。**只剩一条要人点**：真的点一次
「AI 审核」—— 那会在真实案例上跑一次真实审核、写真实工作空间、可能自动传真实 OSS，
不该由 Agent 替你点，脚本也刻意不去点它。

**本轮暴露并修掉的缺口**：受限沙箱模式在本机**没有可用后端**时，DSH 按契约拒绝执行
（`sandbox-exec: sandbox_apply: Operation not permitted`），而旧实现丢掉了这个失败 —— 于是环境自检
对装好了 Node / Python / dws 的机器报「未安装」。这正是「只有装一次才知道」的那一类。

## 一个必须说清的事：`lib/` **不能**当动态插件交（第 32 轮）

目标的收尾括号里写着「lib/ 产物既可发 npm 也可作为动态插件交给 DSH」。**今天不成立**，
而且没有任何文档这么宣称 —— 这是当初写目标时的乐观措辞，不是已验证的事实。逐条对照过两种形态的源码后，
差别只有四处，但四处都要写适配层：

| 接缝 | 包形态（`src/` → `lib/`） | 动态形态（`legacy/`） |
|---|---|---|
| Host 注册 RPC | `ctx.effect(() => ctx.webServer.register(route))` + 操作表分发 | `harness.handle('workbench:<op>', fn)` × 24 |
| Client 发 RPC | `fetch('/api/crwu-workbench', {op, args})` | `host.call('workbench:<op>', args)` |
| React | `require('react')` + `require('react/jsx-runtime')`（DSH 模块表保证） | **裸全局** `React.createElement`（沙箱注入；没有 jsx-runtime 全局） |
| Node 外部依赖 | `import { homedir } from 'node:os'`、`@deepseek-ai/schemastery`（Config） | 一个都没有；取 home 靠 `node -p 'require("os").homedir()'` 走 shell |

**服务面反而是完全一样的** —— 这也正是能移植的原因：Host 两侧都只从 ctx 取
`shell` / `fs` / `subagents` / `agents` / `sessions` / `timer` / `workspaceRegistry`；
Client 两侧都只取 `slots` / `layout` / `uiWorkspace` / `workspaces` / `sessions`。

而且现在的产物**形状上就不是函数体**：

```text
lib/index.js   第一行是 import Schema from "@deepseek-ai/schemastery"（ESM 具名导出，不是 return {...}）
lib/client.js  第一行是 window.__ModuleLoader__.load({ id: "dsh-crwu-workbench", factory: (require) => {
```

所以「让 `src/` 同时产出动态形态」= 一个独立的构建目标（自包含 CJS → 包成 `return (() => { const module = … })()`）
+ 上面四处接缝的适配层 + 把 JSX 编到 `React.createElement`（经典运行时）。
**代价不小，收益取决于还有没有人需要那条投递路径**（动态形态的好处只是「不用改 profile、不用重启」，
代价是重启即失效、升级要重贴）。

**验证它还额外需要一个前提**：动态插件是**按会话**挂载的（`cordis_define` + `cordis_run`），
而这个会话就是用户正在看的那个 —— 挂上去会在侧栏多出一个「中瑞世联工作台」入口。
所以这件事要么用户点头当场验，要么不做。

**用户的决定（第 32 轮）：选 A —— 不做。** 动态形态随 `legacy/` 一起退休，只保留 npm/包形态；
目标里那句「lib/ 产物也可作为动态插件交给 DSH」随之作废（那条路径没有人在用：收尾前
`legacy/REV` 一直是 `pending-install`，也没有任何会话挂着它）。将来若真需要那条投递路径，
上面的接缝表就是出发点和代价清单。

## 25 个操作的验证账（第 31 轮）

「搬完了」不止是名字对得上。第 31 轮把每个操作按**四层**过了一遍账，结论是没有任何一个操作是「没人管」的：

| 口径 | 结果 |
|---|---|
| 有单元/集成测试 | **25 / 25** |
| 有界面入口 | **24 / 25**（唯一例外是 `ping`：Host 侧链路自检，客户端本来就不调用它，与旧形态一致） |
| 在**真实 DSH** 上实际跑过 | **15 / 25** |
| 有类型化门面方法 | 25 / 25 |

真机跑过的 15 个（`ping` / `boot` / `env` / `pending` / `audit-status` / `workspace` / `oss-index` /
`oss-result` / `oss-cred` / `session` / `install-prompt` / `crwu` / `oss-link` / `audit-stop` /
`audit-release`），既走同源接口逐个调过，其中 7 个还在真实浏览器里点过。

**剩下 10 个没在真机跑，是因为它们本身就是写操作或交互操作**，跑一次就会改真实状态：

| 操作 | 为什么不跑 |
|---|---|
| `audit-start` | 会在真实案例上起一次真实审核、写真实工作空间、可能自动传真实 OSS。**用户明确保留这一下** |
| `oss-upload` / `oss-cred-save` | 往真实 OSS 传东西 / 写真实凭据文件 |
| `workspace-auto` / `trust` / `bind-session` | 会改用户的共享状态（工作空间选择、授权偏好、审核父级） |
| `open-path` / `clipboard` | 会打开本机文件、覆盖用户剪贴板 |
| `relogin` / `dws-login` | 交互式登录，要人扫码 |

它们的逻辑由单元测试覆盖（门禁、参数校验、失败分类、状态回写），**但「DSH 真的把服务交给了我」
这一条只有 `audit-start` 还没有真机证据** —— 它依赖的 `subagents.start` 请求形状是对照已安装的
`@deepseek-ai/dsh-subagent` 类型声明钉住的（见 `tests/unit/host-audit-spawn.test.mjs`）。

## 收尾（**2026-09-20 已执行**）

第 30 轮先在**仓库副本**上把整段收尾演练了一遍（结果与下面第 7 步一致），第 31 轮用户点头后**已真实执行**：
`legacy/` 与配套的交付校验、5 个回归测试、`rev:*` 脚本都已删除，门禁在真仓上复跑通过
（**`npm run check` 退出码 0、354 条测试全过、`npm run pack:assert` PASS**）。

下面保留完整清单作为**记录**（含**第 4 步的 4 处测试断裂**与**第 6 步的 `INSTALL-PROMPT.md`** ——
这两处光看代码是想不到的，下次再做类似的形态收尾可以直接照抄这个套路）。

（历史记录：当时的执行顺序）

### 1. 删除（14 个文件）

```bash
rm -rf legacy
rm -f install/verify.mjs install/verify.sh install/rev.mjs
rm -f tests/legacy-client-audit-busy.test.mjs tests/legacy-client-audit-info.test.mjs \
      tests/legacy-client-oss-cache.test.mjs tests/legacy-host-audit-start.test.mjs \
      tests/legacy-host-oss-result.test.mjs
rm -f tests/helpers/legacy-client-renderer.mjs
rm -f tests/unit/port-coverage.test.mjs tests/unit/verify-rules.test.mjs
```

后两个是**随 legacy 一起退休**的：`port-coverage` 的存在意义就是「对照 legacy 数落点」，
`verify-rules` 测的是被删掉的交付契约。

### 2. `package.json`

- 删 `rev:bump` / `rev:check` 两个脚本；
- `check` 改为 `npm run version:check && npm run typecheck && npm test && npm run build && npm run smoke:built`。

### 3. `.github/workflows/ci.yml`

- 删掉 `legacy delivery verification`（`node install/verify.mjs`）与 `legacy REV freshness`（`npm run rev:check`）两步；
- **保留** `version consistency`（`npm run version:check`）与 `assert packed tarball`（`npm run pack:assert`）——
  这两步是第 30 轮补进 CI 的（见下）；
- 顶部注释里「本仓有两条形态」那段改成单形态。删完 YAML 仍然合法（已用 `yaml.safe_load` 验过），
  剩下 `npm ci → version consistency → typecheck → tests → build → assert packed tarball →
  built-artifact smoke → assert build artifacts`。

### 4. 4 处测试断裂与改法（演练才发现的）

| 断掉的测试 | 它原来靠 legacy 做什么 | 改成什么 |
|---|---|---|
| `host-install-prompt.test.mjs`「逐字对照 legacy」 | 从 `legacy/host.js` 抽出提示词原文逐字比对 | 删掉 legacy 锚，改为**逐条钉住 10 条规则**（含「不要试探连通性」「以清单为硬性约束」「密钥不回显」「逐项验证」等安全相关条款）。原先的锚没了，但真正要守的是这些条款本身 |
| `host-package.test.mjs`「实现了每个 legacy handler」 | 从 `legacy/host.js` 读 24 个 handler 名单双向对账 | 改为**冻结的 25 条操作清单**字面量（legacy 24 + 包形态新增 `ping`）。保住它真正守住的东西：操作清单不能悄悄少一个或改名 |
| `host-package.test.mjs`「客户端调用的 RPC 都已登记」 | 用 `install/verify.mjs` 解析 `legacy/client.js` 的调用点 | 改为用**活的门面** `OPERATION_OF`（`src/client/.../api.ts`）做来源，并加断言 `boot.ported.todo` 为空 —— 那正是「收尾完成」的可观察状态 |
| `host-package.test.mjs`「发布链路」 | 断言 `check` 里有 `rev:check` | 去掉这条断言（脚本已删） |

顺带：`host-package.test.mjs` 里「不许进包」的目录清单要去掉 `legacy`。

### 5. 悬空指针清理（注释）

这些注释把**已删掉的文件**当作依据，留着会让后来的人去找不存在的路径。改法是保留「不要改写措辞」
这类**指令**，只把指向删掉的文件的指针换成「动态形态（已删除，见 `PORTING.md`）」：

`src/host/shell/run.ts`、`src/host/audit/prompt.ts`、`src/host/audit/summary.ts`、`src/host/oss/parse.ts`、
`src/host/environment/install-prompt.ts`、`src/shared/utils/json.ts`、
`src/client/features/report-audit/AuditInfoDrawer.tsx`、`tests/unit/client-package.test.mjs`、
`tests/helpers/tsx-loader.mjs`。

（其余提到 legacy 的注释是在解释**历史决定**，不是指向文件，保留。）

### 6. 门禁抓不到、必须手改的地方

- **`install/INSTALL-PROMPT.md`**：它整篇还在教人装**动态插件**（引用 `<REPO>/legacy/host.js`、
  `install/verify.sh`、`legacy/REV`、一次 `cordis_define`）。删完 legacy 后这些路径全不存在，
  而门禁不会报 —— 没有任何测试或脚本读它。收尾时必须**按包形态重写**（`dsh plugin add` / npm 安装）
  或直接删掉，并同步 `README.md` / `README.en.md` 里指向它的两处。
- **文档**：`README.md`（形态表 → 单形态、§二/三 的 legacy 安装段、验证清单、第五节 npm 段、
  文末文件地图）、`README.en.md` 同步、`AGENTS.md`（§1 形态说明、§2 目录树、§6.1 测试布局、
  §6.2 交付契约、§7 门禁命令、§8 里 legacy 版本/REV 那几条）、`CHANGELOG.md` 加一节收尾记录。
- `scripts/assert-pack.mjs` 的 FORBIDDEN 里留着 `legacy/` 无妨（它只是「不许进包」的名单）。

### 7. 复跑与发布

```bash
npm run check        # 期望：354 条测试全过、smoke:built PASS
npm run pack:assert  # 期望：10 个文件
git diff --check
```

然后是发布：`npm run version:set <ver>` + CHANGELOG 一节 → 打 tag → release workflow。

### 想自己复现这次演练

```bash
rsync -a --exclude node_modules --exclude .git <repo>/ /tmp/cutover/
ln -s <repo>/node_modules /tmp/cutover/node_modules
# 按上面 1~5 步改，然后
cd /tmp/cutover && npm run check && npm run pack:assert
```
