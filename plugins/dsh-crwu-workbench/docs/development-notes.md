# 开发要点（dsh-crwu-workbench）

这份文档回答「**改动落在哪一层、为什么这么接、踩过什么坑**」。门禁口径在
`plugins/dsh-crwu-workbench/AGENTS.md`，两者冲突时以那份为准；界面与样式看
`docs/ui-design-guidelines.md`。

---

## 1. 形态与产物

- 源码只有 `src/`，由 tsdown 打成 `lib/index.js`（ESM，Host）与 `lib/client.js`（CJS，Client）。
  **`lib/` 是产物，不要手改**（`npm run build` 覆盖）；
- 交付形状由 `package.json` 的 `exports` / `files` / `dsh.client` 决定，改它们必须跑
  `npm run pack:assert`；产物加载能力由 `npm run smoke:built` 证明；
- 三条静态可查的加载契约（`pack:assert` 强制）：
  1. 客户端产物必须是 `window.__ModuleLoader__.load({ id, factory })`，且 `id` **等于包名**；
  2. 客户端产物的 `require(...)` **只允许** `react` 与 `react/jsx-runtime`；
  3. Host 产物导出 `name` / `inject` / `apply` / `Config`，`apply` 以**位置参数**接收 config。

## 2. Cordis 生命周期归属（照 DSH 自带插件抄）

| 副作用 | 正确写法 |
|---|---|
| 槽位注册 | `ctx.slots.inject(name, () => ctx.slots.register(...))` —— **直接调用，不要再包 `effect`** |
| 同源路由 | `ctx.effect(() => ctx.webServer.register(route), label)` |
| 样式 / 定时器 / 语言包 | `ctx.effect(...)` |

**为什么不能把 `slots.inject` 包进 `effect`**：Cordis 的 `effect` 对回调返回值有类型要求，
`slots.inject` 返回登记对象，会被判成 `TypeError("Invalid effect")` ——
表现是「插件装上了但面板不出现」，而且是在**激活阶段**抛错。
`tests/unit/client-package.test.mjs` 与 `npm run smoke:built` 都断言了「`inject` 必须在 effect 之外」。

## 3. bundle patch 里的 `baseUrl` 是 **profile 目录**

profile 的整棵树是「补丁层挂在 profile 的空根配置上」，所以 `cordis.patch.yml` 里 `!!js` 表达式拿到的
`baseUrl` 锚在 **profile 目录**，**不是本包目录**（`agent.cordis.yml` 里同样写法是好的，因为 preset
按文件加载 —— 两处语义不同，别互相套用）。

- 后果很隐蔽：`new URL('skills/', baseUrl)` 指向 `<profile>/skills/`（不存在），skill provider 照样
  "装配成功"，只是**静默贡献 0 个技能**；
- **第二种同类失效**：`dsh-skill-filesystem` 对每个技能根只扫一层（不递归）。技能按层组织后
  （`skills/crwu/`、`skills/dws/`、`common/skills/`）必须**一层一个根**；只注册 `skills/` 会让
  `skills/crwu/` 被当成"没有 `SKILL.md` 的技能"跳过，整层静默消失；
- 本包内的路径一律**按包名解析**：
  `createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')` → 包目录 →
  再拼 `skills/crwu`、`skills/dws`、`common/skills`。link 开发、员工 tarball、别的布局都对；
- `>-` 折叠标量会把换行**折成空格**：多语句必须写分号，漏了就是求值期的 `SyntaxError`；
- 回归测试 `tests/unit/host-skills-patch.test.mjs` 会造一个 profile 形态的目录、把补丁里的表达式
  **真的求值一次**并断言三层都在；改回 `new URL('skills/', baseUrl)` 或漏注册一层都会立刻变红。

## 4. Host 与 Client 是**分开加载**的 → 协议号

客户端产物刷新页面就换新，宿主产物**只有重启 profile 才换**。不同代的表现极其费解：
界面是新版、行为是旧版（用户报过「还是挂错位置」，实际是宿主还跑着上一轮 build）。

- `src/shared/consts.ts` 的 `WORKBENCH_PROTOCOL` 是协议代数：**改跨进程契约就 +1**，
  `ping` / `boot` 都会带上它。**当前 = 24**（历史见常量上方的注释：16→…→22 删掉登录类操作、
  23 新增 `discussion-material-open`、**24 把审核根的 cwd/沙箱边界从"本轮案例目录"改成"已选工作空间"**
  —— 后者决定审核会话是挂在工作空间下还是落「未分组」，见 §4.8 与 CHANGELOG 0.0.34）；
- 客户端发现 `boot.protocol !== WORKBENCH_PROTOCOL`：面板上明说「宿主插件是旧构建，请重启 web profile」，
  并把 `canDispatch` 置 false；
- 排查口诀：`env` 应答里缺字段 = 宿主是旧代。`ping.builtAt` 是**模块加载那一刻**的产物写入时间，
  与磁盘 mtime 不同就说明"你还在跑上一份，忘了重启"——它必须是常量，不能每次请求现读文件。

## 5. 沙箱与授权（员工零启动参数）

- 沙箱/审批模式来自**启动环境**：`mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
  `policy: … === 'danger-full-access' ? 'never' : 'ask'`；
- **产品口径**：员工不改启动方式。插件按 DSH 的请求契约**逐命令声明** `sandboxPolicy`，
  且只在员工允许（`localAccess` 收据）之后才提权；
- 读本机凭据的命令（`crwu h3yun …`、`dws auth status`、`dws contact user get-self`）在受限沙箱下
  会**假报"未登录"**（凭据在 macOS 钥匙串里读不到）。同一台机器同一时刻：沙箱里 false、
  带 `sandboxPolicy: danger-full-access` 时 true。所以**未授权时不许猜**，宁可说「需要授权」；
- 提权命令必须有工作目录（DSH 拒绝无工作区的提权执行）；写状态文件
  （`~/.dsh/crwu-workbench.json`）同样要带 `sandboxPolicy`，否则受限沙箱下写不进去 ——
  症状是「授权没能写入磁盘，重启后需要重新授权」。

### 5.1 工作区之外的路径清单（2026-09-28 员工 Windows 实测补齐）

`workspace-write` 的**可写根 = 工作区 + 系统临时目录**（见 `@deepseek-ai/dsh-sandbox` 的
`writableRoots`）。下面这些路径**全在界外**，碰它们必须逐次声明 `sandboxPolicy` 或让命令提权：

| 路径 | 谁在用 | 怎么声明 |
| --- | --- | --- |
| `~/.dsh/crwu-workbench.json` | 插件状态（授权 / 工作空间 / 占用锁） | `fs.writeText(..., { mode: 'danger-full-access', workspaceRoot: home })`（`state/persist.ts`） |
| `~/.dsh/crwu-workbench/ifind-credential.json` | iFinD API-Key | 同上（`ifind/store.ts`） |
| `~/.ossutilconfig` | OSS AccessKey | 同上（`oss/ops.ts`，**2026-09-28 之前漏了**） |
| `~/.dws/**`（`.data.lock` 等） | 钉钉 CLI 自己的登录态 | 命令必须提权（`runShell({ escalate: true })`） |
| 操作系统凭据存储（钥匙串 / Credential Manager） | `crwu h3yun session …`、`dws auth …` | 命令必须提权（白名单见 `crwu/run.ts` 的 `escalationAllowed`） |

**三种表象、同一个原因**（认错就会把员工指去重新扫码 / 重装 CLI / 换 AK）：

| 表象（原文） | 真原因 |
| --- | --- |
| `file access denied under workspace-write mode` | DSH 自己的拒绝标记（最好认） |
| `secret not found in keyring`（看着像没登录） | 命令在沙箱里读不到系统凭据存储 |
| `acquiring file lock: … .dws\.data.lock: Access is denied.`（看着像 dws 的 bug） | 命令在沙箱里写不了 `~/.dws/`；也可能是真的文件被占用 / NTFS 权限 |

归因由 `shell/run.ts` 的 `sandboxDenialNote()` 统一做，`runDws` / `runCrwu` 会把那句话补在错误最前面。
`fs.writeText` 那条没有 shell，所以它报的就是 DSH 的标记本身。

**优先用事实，别认文本**：DSH 的 `ShellRunResult.sandbox = { mode, denied, runnerFailed }` 直接告诉你
「命令实际跑在哪个模式」「沙箱有没有真的拒绝一次文件操作」，`resolve()` 回来的 `spec.sandboxPolicy`
还能看出**提权请求有没有被降级**（请求 `danger-full-access`、解析回来 `workspace-write`）。
`ShellResult.sandbox` 把这四项一起带出来，`sandboxDenialNote()` 的顺序是：

1. `denied === true` → 沙箱拒了（确定）；
2. `requested !== resolved` → 提权被降级（确定）；
3. `runnerFailed === true` → runner 起不来（确定）；
4. 拿到事实但都不成立 → **返回空**（沙箱不是原因，去查文件占用 / ACL / 业务错误）；
5. 拿不到事实（老版本 DSH、非 shell 通道）→ 才退回文本判据。

第 4 条是刻意的：事实已说明「没拒、也没降级」时再去猜文本，会把一份被占用的文件说成沙箱问题，
员工按「去授权」处理就永远修不掉。诊断时用 `describeSandboxFacts(result)` 压成一行。

### 5.2 真要在整台机器上关掉沙箱（只用于已知机器 / 排障）

插件**不能**给自己发常驻豁免：`@deepseek-ai/dsh-sandbox` 的提权是
`approveEscalation()` —— 逐次、需要人批、只对该次调用生效，没有审批通道时 fail closed。
要「一次设置、全局不沙箱」，只能改 DSH 侧：

```bash
DSH_PERMISSION_MODE=danger-full-access dsh --profile <你的 profile>
```

或把 profile 里 `dsh-sandbox-policy` 的 `mode` 设为 `danger-full-access`。**这是员工的机器设置，
不是插件的产品口径**（产品口径仍是「员工零启动参数，首次授权一次」）。

## 6. 「我是谁」与身份口径

- 姓名来源是钉钉 CLI：`dws contact user get-self --format json` →
  `result[0].orgEmployeeModel.orgUserName` / `orgName` / `userId`（实现：
  `src/host/system/identity.ts` 的 `dwsSelf` / `readSelfDocument`）；
- 它**跟着环境自检一起取**（`env.me`），不单独开操作 —— 用户口径：「这个钉钉 cli 环境监测一遍
  就可以了，不需要每次切换页面都去调，本质就是从环境信息把这个人的信息拿到」；
- 宿主侧**只缓存成功结果**（姓名在一次登录周期里不变），失败不缓存：员工登录后刷一下就有；
- 未授权时不发这条命令（问出来的"没登录"不可信）；拿不到姓名时 `me` 是三个空串，
  界面整句不展示（见 `docs/ui-design-guidelines.md` §6.1）。

## 7. 增删一个 Host 操作的最小清单

最容易漏的是 2~4：

1. `src/host/ops/core.ts` 的操作表加一项；
2. 同一文件 `boot.ported.done` 加名字（漏了 → 「操作表 ↔ ported 声明一一对应」红）；
3. `tests/unit/host-package.test.mjs` 的 `FROZEN` 清单加名字并改数量注释（漏了 → 冻结清单红）；
4. 客户端要调用 → 门面加方法 + `OPERATION_OF`；不打算给客户端用 → 加进
   `client-rpc-facade.test.mjs` 的 `HOST_ONLY`（漏了 → 双向核对红）；
5. 补单元测试；
6. 真机上点一下（依赖 `shell` / `fs` / `subagents` / `slots` / `webServer` 或真实外部行为的，
   替身证明不了）。

### 7.1 增删一个**本机访问操作**（`LOCAL_ACCESS_OPERATIONS`）的最小清单

这张表是**另一张表**（`src/host/access/operations.ts`）：跨工作区边界的每一条命令 / 文件写入
都必须在它上面登记，判据是「需要哪个 capability / 走哪条通道 / 要不要逐次提权 / 允许哪些来源」。
加一项时：

1. `LocalAccessOperation` 联合类型 + `LOCAL_ACCESS_OPERATION_NAMES` + `LOCAL_ACCESS_OPERATIONS`
   三处一起加（`satisfies` 保证漏登记就 typecheck 红）；
2. 想清楚**特权还是不提权**：目标在会话 cwd 之外（钥匙串、`~/.dws`、员工选定的工作空间）才提权；
   边界之内（审核子会话的案例目录）一律不提权 —— 「能给最小权限就给最小」；
3. `allowedSources` 要能回答"这个来源**应不应该**做这件事"：`audit-host`（插件自己的审核编排）与
   `audit-tool`（审核子代理调 Tool）刻意分开，两者的沙箱位置不同；
4. 必须有**真实调用点**：`host-access-migration.test.mjs` 的 B-01c/B-01e 会断言「登记了没人用」；
5. `tests/unit/host-access-broker.test.mjs` 会逐项检查描述表的**字段集**（只许四个键）与来源取值；
   新增来源要同步那张白名单。

当前操作清单与条数**只在 `tests/helpers/frozen-inventory.mjs` 写一份** —— 别在文档里写死数字
（本文件历史上同时写过 30 与 29 两个互相矛盾的值，就是这么来的）。各测试各写一个裸数字的结果是：
加进 iFinD 之后"9 个工具"那条断言照样绿过一次。

**协议号也只有一个事实源**：`src/shared/consts.ts` 的 `WORKBENCH_PROTOCOL`（当前 = 25，
25 是**把「授权收据读不出来」从「需要授权」里分出来**：`localAccess.state` 新增 `unreadable`，
见 §21）。
历史（13：`state` 统一环境模型 / iFinD 凭据改由插件保管；
14：删除 `install-prompt`；15：iFinD 改为必需项；18：本机访问授权收据 + 诊断 + DWS 本机目录体检；
19：审核 scope 收紧到本轮案例目录；20：内置浏览器扫码的凭据出口；21：钉钉登录两阶段；
22：删掉上面三条登录操作；23：讨论会话的受限材料范围；24：审核根绑到已选工作空间）
写在那个常量的注释里。

## 8. 本地开发循环与两道人工关卡

用户指定的循环：**改 `src/` → `npm run build` → 装进他的 web profile → 他亲自测 → 他审代码 → 才提交**。

- 中间两道关卡不许跳过、不许替他判断；
- 提交后**不推送**，除非他明确说「推送 / 发版」；
- 重启他的 profile 会打断当前会话（agent 就跑在那个进程里），所以"重启"这一步由用户做，
  agent 的职责是 build + 确认安装 + 说明这轮改了什么；
- 独立验证用一次性 profile（`dsh --profile <名字> --from-default-profile web`），验完删掉。

## 9. 测试与验收

- 跑在 `node --test` 上：**不引入 vitest / jsdom / react-dom**。`tests/helpers/tsx-loader.mjs`
  剥类型 + 转 JSX，并把 `react` 指向一个极小替身，所以 `.tsx` 也能直接测；
- **每个新断言必须先证伪一次**（临时注入缺陷 → 确认变红 → 还原）。从没红过的断言不算证据。
  证伪脚本的还原清单必须覆盖它改过的**每一个文件**（漏过一个新建组件，就出现过"单测全绿、
  真机少东西"）；
- 反过来，**文本包含式断言**（`源码.includes("'sidebar.panellist'")`）会被同文件里别的同名字面量满足 ——
  要断言"注册发生了"就解析真正的调用实参，要断言"方法存在"就 `import` 真模块查 `typeof`；
- 界面行为只有浏览器能证明：`install/browser-check.mjs` 用系统里已装的 Edge + `playwright-core`
  （不下载 Chromium），逐阶段断言几何、计算样式、真实请求次数；它**不点「AI 审核」**；
- 等真实后端的断言一律用 `waitForFunction`（氚云十几秒、`ossutil` 几十秒都是常态）；
  瞬时加载态用 `page.route` 人为拖慢，把"有没有加载态"变成确定性断言；
- 运行产物（`*.tgz`、截图、临时 profile）不进提交。

## 10. 发版

- `npm run version:set x.y.z` + 手写 CHANGELOG 一节 + `npm run version:check`（三处一致）；
- 走 `plugin-v*` tag 发布（CI 里跑完整门禁 + `npm publish --provenance`），**不要手工 publish**；
- **同一个版本号只发一次**：分发走 npm，已发布的版本号不可覆盖，所以改了内容就必须升版本号
  —— 否则早装与重装的员工跑的不是同一份，而版本号也不再能定位问题；
- 改了任何东西（代码 / 技能 / 文档 / 配置）→ **升版本号**再发。

## 11. 常见坑速查

| 症状 | 根因 | 处理 |
|---|---|---|
| 插件装上了、面板不出现 | `slots.inject` 被包进 `ctx.effect` → 激活期 `TypeError` | 直接调用 `slots.inject`，把 `effect` 留给自有副作用 |
| 技能表里一个 crwu-* 都没有，日志干净 | 补丁里 `new URL('skills/', baseUrl)` 指向 profile 目录 | 按包名解析包目录（§3） |
| 只有某一层技能全不见（如 `dws` 层），日志干净 | 补丁只注册了上层 `skills/`，而 DSH 对每个根只扫一层 | 一层一个 `customSkillDirs` 条目（§3）；`host-skills-patch.test.mjs` 会红 |
| **升级 DSH 后插件装上了、界面里什么都没有，启动日志干净** | **0.1.7 起 peer 是硬门禁**：`peerDependencies` 的 `@deepseek-ai/dsh*` 与 `getDshRuntimeVersion()` 不匹配 → 整个 bundle 被当作不可读**跳过**，记进 `skippedBundles` | peer 必须覆盖**每一条我们支持的 DSH 线**，一条线一个 `^` 区间用 `\|\|` 并列（本包写 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`）；**加线之前先把两条线的 `@deepseek-ai/dsh-*` tarball 逐文件 diff 过**，只改区间不做比对等于赌。应急时用 profile 的 `compatibility.json` 精确豁免。判据是 peer，**不是** `engines.dsh` |
| 升级 DSH 到同一条线里的新 rc（例如桌面端自动升到 `0.2.0-rc.2`），想确认插件还支持 | 插件声明的区间（`^0.2.0-rc.1`）本来就覆盖整条 0.2.0 线，**先别急着改代码**；要的是把新版本纳入验证矩阵 | ① 逐包比对：`npm pack` 两条 rc 的全部 `@deepseek-ai/dsh-*`，解包后逐文件 diff。0.2.0-rc.1 → 0.2.0-rc.2 的实测结论：16 个包**所有 `.d.ts` 零差异**，13 个只有 `package.json` 版本号变化，另 3 个只有运行时代码小改动（`dsh-subagent` 多一条 `user-question-reply` typert 声明、`dsh-client-ui-renderer` 加一个 `useMemo`、`dsh-client-ui-sidebar` 去掉品牌按钮外层 `Tooltip`）→ 业务代码零改动；② 把代表版本换进 `scripts/check-dsh-compat.mjs` 的 `RUNTIMES` 与 `tests/unit/host-package.test.mjs` 的 `SUPPORTED_DSH_RUNTIMES`（**一条线一个代表版本**，同线后续 rc/正式版由区间语义覆盖）；③ `devDependencies` 跟着挪到该线（`^0.2.0-rc.2`），否则 `npm run typecheck` 验的还是旧线；④ 把结论写进 `CHANGELOG.md` 与本节 |
| 插件管理器弹「`dsh-crwu-workbench@0.0.13` 与 DSH `0.2.0-rc.1` 不兼容（要求 …），请安装与当前 DSH 兼容的插件版本」，或装上了却被禁用 | `^0.1.7-rc.2` 的语义是 `>=0.1.7-rc.2 <0.2.0-0`，**不含** `0.2.0-rc.1`；而 Windows 那台机器已经升到 DSH 0.2.0-rc.1（当时本机 macOS 桌面端还是 0.1.7-rc.2，所以本机看不出来） | 与上一条同一个修法（加一条 `\|\| ^0.2.0-rc.1`）。**别用 `>=0.1.7-rc.2 <0.3.0` 图省事** —— 会顺带放行没验证过的 0.3 线。0.1.7-rc.2 → 0.2.0-rc.1 的逐包比对结论：7 个 peer 里 5 个字节相同，`dsh-client-ui-sidebar` 只多 1 行埋点、`dsh-client-ui-layout` 只多一段 Windows 标题栏 CSS |
| 加宽 peer 之后，`npm install`（新鲜解析，没有 lock）在**本仓自己**报 `ERESOLVE`：`peer @deepseek-ai/dsh-fs@0.2.0-rc.1 from @deepseek-ai/dsh-skill-filesystem@0.2.0-rc.1` 撞上 devDep 的 `0.1.7-rc.2` | npm 的 peer 自动安装会为「只有 peer、树里没有具体实例」的包去解析**最新**匹配版本，而新线里有些包把 `peerDependencies` 写成**精确版本** | 把**全部 7 个 peer** 也写进 `devDependencies`（哪怕并不 import）：树里有了实例，npm 就钉在我们开发所对的那条线上。**接收方不受影响** —— profile 的 pnpm 配了 `autoInstallPeers: false`，`@deepseek-ai/dsh-*` 从来不由包管理器安装（DSH 运行时自己提供）。`host-package.test.mjs` 那条真装 tarball 的回归会拦住这个 |
| 所有命令都失败，报 `shell.execute is not a function`（或 `run is not a function`） | 0.1.7 的 shell 契约变更：`ShellExecutor.run(spec)` → `execute(spec)` + 句柄的 `result()` | 改 `src/host/shell/run.ts`；**测试替身也要一起改**，否则单测里每个 shell 调用都会静默变成「执行失败」 |
| 想让员工零安装（把 `crwu`/`dws`/`ossutil` 放进插件 `bin/`，指望 DSH 挂上 PATH） | **DSH 没有这个机制**：`dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 `Config` 无 env/PATH、`dsh-shell-env` 只收 `DSH_*` 键（前缀校验抛错）、`.env` 明确拒绝 `PATH` | 插件按平台自己解析包内绝对路径（`src/host/platform/bin-dir.ts`）；**再加一条 export 到 PATH**（见下条） |
| 审核子代理里 `dws: command not found`，而插件自己的调用正常（**2026-09-25 前的旧症状**） | 那时审核子代理要自己拼命令行，而它跑的是 **DSH shell 的 PATH**（实测 `/usr/bin:/bin:/usr/sbin:/sbin`） | **不要再用「给用户 export PATH」这条路**（那等于把执行世界的要求推给员工，还把沙箱/审批绕开了）。现在自研审核链路只走结构化 Tool，命令由插件用**包内绝对路径**经 `ctx.shell` 发出 —— 见 §12 |
| 本机 `bin/` 里明明有二进制，员工装上却没有 | `npm pack` **静默丢弃符号链接**（相对/绝对都不进 tarball，只有真实文件会） | 一律落真实文件；`assert-pack` 在本地装配了 `bin/` 时逐个断言真在 tarball 里 |
| `make plugin-pack` 打出来的包缺自带二进制 | `plugin-bin` 没跑，或并列 prerequisites 在 `make -j` 下并行、门禁跑在了装配之前 | `plugin-pack` 用配方**显式**依次跑 `plugin-bin` → `plugin-check` → `npm pack`；`pack:assert` 会逐个断言 |
| 有人想把只读分发桶加回来（环境清单 / 安装说明 / 插件 TGZ） | 那四个用途都让员工机器的行为依赖一个**地址谁都能换**的远端对象 | 别加。二进制随包自带、清单内置、插件走 npm；`host-yaml-config.test.mjs` 有一条「只读整段不存在」的断言盯着 |
| 包是新的，面板版本徽章还是上一版 | `PLUGIN_VERSION`（`src/host/consts.ts`）没跟着 `version:set` 走 | `version:set` / `version:check` 现在都管这一份；`host-package.test.mjs` 有 `ping.rev === pkg-<version>` 兜底 |
| 某个 skill 静默消失 | `SKILL.md` frontmatter 有一行没缩进 | 修缩进；`skills:check` / 契约测试盯着数量 |
| 样式被截断且不报错 | `WORKBENCH_STYLE_TEXT` 注释里出现了反引号 | 模板字符串里不许有反引号（连注释也不行） |
| 卡片没边框、底色透明 | 用了 DSH 里**不存在**的 token | 到 theme 表核对；扫硬编码色值的测试扫不出这个 |
| 长页面被裁一半 / 头部跟着滚 | 滚动容器放错（放 root 或没给 `min-height:0`） | 滚动归 `.crwu-audit-body`（设计规范 §4） |
| 把兜底提示词粘进普通会话，第一步就失败（读不到案例目录 / 取不到附件 / 写不了交付件） | 手工兜底跑在员工**自己的会话**里，那条会话的沙箱边界是它自己的工作目录；案例目录、报告材料与本机凭据都在边界之外 | 兜底卡在提示词**之前**给出切「完全权限」的四步操作（`zh-CN.ts` 的 `handoffFullAccess*`，措辞对齐 DSH 客户端的「访问模式 / 完全权限 / 确认启用完全权限？」）。⚠️ **只在这一处提醒**：审核子会话按设计固定在 `workspace-write`，环境页/报告页平时说「切完全权限」会把人引到错的处置上（`client-package.test.mjs` 两侧都有断言） |
| 全量测试里偶发「an installed tarball can actually be installed and imported」 | 有两处测试会真跑 `npm pack`（`host-package.test.mjs` 与 `host-bin-manifest.test.mjs` 的严格模式），而 `node --test` 并行跑文件：两次 `prepack`（`skills:sync` + `prepare.mjs --force`）**同时重写同一棵 `lib/`**，其中一个读到半成品 | 已知**测试侧并发缺陷**（不是插件逻辑问题；2026-09-29 全量跑第一次红、紧接着两次全绿，单独跑该文件 39/39 通过）。**已修**：两处真构建走 `tests/helpers/build-lock.mjs` 的 `mkdir` 文件锁（`host-build-lock.test.mjs` 钉住「不交叠 / 抛错也释放 / 重入立刻报错」）。别用"重试一次"遮掉 —— 那会把真实的打包失败也吞成通过 |
| 诊断/错误文案把员工路径带进界面 | 诊断的 `summary` 由 argv 前缀拼出来（可能有路径）；`chmod` / fs 的错误消息自带 `EACCES: …, stat '/Users/x/.dws'`，而 doctor 视图与凭据卡片是员工可见的 | 记录时过 `sanitizeDiagnosticSummary()`（遇到像路径的词就截断，最多四词）；展示前过 `redactPaths()`（把绝对路径换成 `<路径>`，错误本身保留）。⚠️ 夹具抛的错也要**带路径**，否则"不该出现主目录"那条断言是空的（证伪时抓到过） |
| 静态门禁只抓"看得见的形态" | B-01 抓的是"在 `shellInvoke(…)` 里直接写 `ossutil`"，于是"先 `requireBundledCommand(…, 'ossutil')` 拿路径、再用变量 `runShell`"这种**间接形态**在它下面全绿（2026-09-29 用一个临时模块实测过） | 判据往前挪一步：堵在"**解析**业务 CLI 二进制"这里（B-01d）。解析是执行的前提，堵它不必猜命令怎么拼 |
| 静态门禁"文件里出现过一次 X" | 只断言"某文件里出现过一次 `access.runShell`"——同一文件里另外 6 处裸 `runShell` 全都没被发现，OSS 的列举/读结果/签名/上传在受限沙箱下必然失败 | 门禁要断言**不许出现**（逐个调用点扫），而不是"至少出现过一次"；新增执行器时同时把违规形态（裸调用 + 直接 import `shell/run.ts`）都列进去（2026-09-29 用户复查抓到的 P1 假绿） |
| 坏请求把已授权的状态掀掉 | 把"请求不合法"（版本不符 / 能力清单被改）与"落盘失败"混成一种失败，于是旧版界面或手工坏请求也会落实一个关闭态 | 两类必须分开：不合法请求**什么都不改**（不改活状态、不碰磁盘），只有落盘/回读失败才 fail closed（2026-09-29 M5） |
| 拿成功记录做失败归因 | 前置判据取"最新一条 dws 记录"，而界面自检刚跑过成功的 `dws auth status`；`not-authorized` / `invalid-source` 这类访问控制结果也被当成执行失败 | 判据是"**最近一次失败**"：`errorClass === ''` 不是失败、访问控制类不是执行失败、最近失败不是 DWS 时不许往回翻（2026-09-29 M6） |
| 拼接出来的 PowerShell 结构坏了，本机看不见 | 用数组 `join('; ')` 拼脚本，分号落在 `try {` / `foreach (...) {` 后面 → `try {;` 空语句；括号不配平、有 `try` 没 `catch` 同理 —— 在 macOS 上完全不可见，Windows 上表现成"探测拿不到结论"而不是报错 | Windows 命令一律写成**整段脚本**（不要 join），并由 `host-dws-local.test.mjs` 的结构自检守：左花括号后不许空语句、`{}()[]` 必须配平、有 `try` 必须有 `catch`、POSIX 命令在 Windows 上必须为空（2026-09-29 M7） |
| CI 合同与生成器各说一套 | 生成器早已输出 `crwu-acl/2` + `modify-mask` + 数字权限位，Windows 合同测试还在要 `/1` 与 `modify\|partial` —— 本机没 pwsh，只在 CI 红 | 生成器与合同测试必须同一协议版本；本地加一条结构化判据（生成器输出必须含 `/2` 与 `modify-mask`，且不含 `/1`）（2026-09-29 M8） |
| PowerShell 包装异常读错层 | `[IO.File]::Open` 抛出的 IOException 被 `MethodInvocationException` 包住，直接读外层 `$_.Exception.HResult` 永远对不上共享冲突 32/33 → "真的持锁"也变 Unknown | 沿 `InnerException` 解包到根异常再读 HResult；本地用结构判据守（计数器从 0 起、循环有上限、每一步往里走、HResult 从 `$e` 读）（2026-09-29 M9） |
| 只探目录、漏掉锁文件 | 原始报错目标是 `.data.lock`，只判目录 → 目录正常时归因退化成 `cli`、修复入口不出现；修复还会无条件连目录一起改 | 目录与锁文件**分别**探权限并分别形成 `filesystemAccessDenied`；修复只动被证明有问题的对象（2026-09-29 M10） |
| 把模式读成 uid | `parseOwnerMode` 把第一个 token 当 uid，只有模式的输出（`644`）被读成 uid=644 → "不是你的文件" → 跳过修复（可修变不可修） | 形状必须是 `<uid> <mode>`，否则结论留 `null`（不知道）；既不说是你的，也不说不是（2026-09-29 M11） |
| 有人持锁就报文件锁 | `lockHeld === true` 单独成立即归因 `file-lock`，于是"认证失败 + 恰好有人持锁"被说成文件锁 | 两个条件缺一不可：原始失败与锁有关（Broker 记的脱敏布尔事实 `lockRelated`）+ 当前正向探测持锁（2026-09-29 M12） |
| 客户端替 Host 猜"能不能做" | 体检按钮的可点性若由客户端自己推断，就会与 Host 的前置门禁不一致（亮着被拒 / 灰着却能体检） | 能力/可做性一律由 Host 给事实（`dwsDiagnosable` / `canDiagnose`），且与门禁**同一个判据**；两侧各有证伪用例（2026-09-29 M13） |
| 注释里的不变式没实现 | `requireCaseDir` 的注释写着"案例目录必须在 Host 选定工作空间之下"，代码里只校验了"绝对 + 存在 + 是目录 + 没有 .." —— `caseDir` 是模型参数，于是可以指到工作空间之外（`oss_publish` 外泄任意可读文件、`h3yun_record_get` 把它当特权命令 cwd） | 把不变式做成**必填参数**（`allowedRoot`，编译器保证不漏传；运行时漏传 fail closed），并补工具级反例：越界 → `policy` + **零命令**（2026-09-29 M14） |
| 夹具的 `contains` 只认 `/` | 真实 `fs.contains` 是规范化比较（Windows 路径照样成立），夹具只认正斜杠 → Windows 用例假红，或掩盖真实行为 | 夹具的 `contains` 两种分隔符都认；Windows 用例的 `state` 也要与案例目录同平台（信任域自洽）（2026-09-29 M15） |
| 边界靠"两处巧合相等"成立 | `openPath` 的注释写"只允许打开案例根内的文件"，实现却是"案例根为空就跳过检查"；那天唯一挡住它的是 Broker 的提权必须有 workdir（而 `defaultCaseRoot` 的兜底恰好就是那个 workdir） | **未知信任域 = 拒绝**，判据放在任何 fs 探测之前；用例断言"被拒时对目标零 fs 调用"，这样把判据挪到后面也会红（2026-09-29 M16） |
| 脱敏声明缺证据 | `dataSample` 的注释写着"绝不回传 token"，但只有**失败路径**被喂过 token；成功路径的 sample 只用 `{"v":1}` 试过 —— 声明成立、证据不在 | 声明式的安全承诺要**端到端**喂一次对抗输入（成功路径也要）；并且注意"值级净化"与"对象路径的密钥字段整条丢掉"是两回事，别把后者当成前者的证据（2026-09-29 M17） |
| 零件有证据、接线没有 | 卡片自己的 `schemaMismatch` 分支有用例、协议不一致的整屏也有用例，但"权限说明版本不一致 → 卡片被禁用"这条**接线**没有任何用例（面板恒传 `false` 也没人发现） | 安全/门禁类的判据要按**链路**取证：判据真值表 + 每一跳（面板 → 环境页 → 卡片）各一条，四跳都能被注入打红（2026-09-29 M18） |
| 两个相似的判据被"顺手统一" | `hostIsStale`（协议 null = 还没答 → **不算**旧）与 `hostPermissionSchemaStale`（null = 旧宿主没给字段 → **算**不一致）的 null 语义**刻意相反** | 语义相反的地方要有真值表用例 + 注释写明理由；把两者"统一"会立刻打红两条用例（2026-09-29 M19） |
| 卸载路径从没跑过 | `smoke:built` 收集 `effects` 却从不调用，"忘了 `return` disposer"（Cordis 经典坑）在本地完全看不见：卸载后路由还在、看门狗还在轮询。替身的 `register` 还返回空 disposer，把"有没有释放"变成永远绿 | 冒烟里真的跑一遍卸载（逆序调用每个 effect 的 disposer），断言路由被摘掉、工具被逐个注销；替身的 `register` 必须返回真的注销函数（2026-09-29 M20） |
| 门禁只测了一个方向 | "单条并发"有两个方向：同一条报告 → 带时间戳重启（有用例）、**另一条报告在跑 → 拒绝**（没用例，删掉那段 `if` 也不红） | 双向门禁要两边都取证据；拒绝型断言要同时钉住"零子代理"与"原占用原样保留"（2026-09-29 M21） |
| 顺序声明没有判据落在真调用上 | 注释写"并发冲突先于能力预检"，只断言 `readiness` 没跑**抓不到**（它是更晚的一道门）；要把判据落在**工具真的被调用**（`ctx.toolCalls`）上 | 顺序类声明要观察那个"更贵的步骤"本身是否发生（2026-09-29 M22） |
| 注入是空操作 → 假证伪 | 我第一次"把门禁挪到预检之后"实际上把它插回了原处（`replace(marker, gate+marker)`），于是"仍然全绿"被我读成"抓不到"；差点据此写下错误的结论 | 注入后要**回读文件**确认真的改了（grep 或带守卫的 assert），否则证伪的是空气（2026-09-29 M23） |
| 门禁判"包含"而不是"精确等于" | 案例内 Tool 只校验"`caseDir` 落在选定工作空间之下" —— 一个工作空间里有很多案例目录，于是 S1 的子会话可以传 `<工作空间>/S2` 或传工作空间根再读 `S2/文件`（读出来传上 OSS / 往别的案例里写） | 判据改成"与 Host 记录的 `casePath` **规范解析后精确相等**"（`audit/scope.ts`）+ `seqNo`/`objectId` 一致；工作空间级旧根判过期（2026-09-29 M24） |
| 模型提交的标识没有绑到本轮 | `objectId` / `fileId` 都由模型给，Host 只查"格式对不对"，于是审核子会话能读**别的**记录、把任意附件下到自己的案例目录 | 记录查询移出审核能力集（注册面 ≠ 审核能力集），文件下载只认**可信输入快照**里登记的 `fileId`（2026-09-29 M25） |
| 边界设对了但 cwd 还是外层 | 沙箱边界改成案例目录、根的 cwd 仍是工作空间：子会话继承的是 **cwd**，通用 fs 的默认落点仍在工作空间 | 根的 `meta.cwd` 与边界**一起**钉成案例目录，并回读核对（读得到时必须相符）（2026-09-29 M26） |
| 拒绝条件写成"范围可用"而不是"身份" | `record_get`/`files_list` 的拒绝用 `auditScopeFor(...) !== undefined`：一轮审核 `ended:true` 后 scope 变为不可用，那个还活着的子会话就绕过拒绝去读任意 `objectId`。**同一形态**还有 `case_bootstrap`（`caseDir` 钉死了，但 `objectId` 是提交进来的） | 这类"面板能用 / 审核子会话不能用"的判据一律按**调用者身份**（`isAuditChild`，不要求 scope 可用）；交付前自审时补的两条（2026-09-29 M27） |
| 夹具跳过了整段复查 | `agents.get()` 只返回根 Agent → 子会话策略/工具复查整段被跳过，"期望值写错"这类缺陷永远不会红（第二轮复查的 P1 就是这么漏掉的） | 关键复查必须有一条"**真的返回 child** + 正确值 → 正常启动"的正向用例（2026-09-29 M28） |
| "名单"当成安全边界 | 把工具从"必需集"里删掉只是预检名单：子会话照样看得到、也执行得了。真边界是 provider 的 `toolFilter`（scoped `tools.restrict()`），且**不支持过滤的 provider 必须在创建前拒绝** | 声明"某类调用者不能用某工具"时，判据必须落在**执行/可见性**上（2026-09-29 M29） |
| 发布早于记账的窗口 | `subagents.start()` 返回前子会话已在跑：身份拒绝失效、scope 还不存在 | 两阶段握手：**先落 pending scope（父会话认领）→ 再创建 → 再写真身份**；失败回滚（2026-09-29 M30） |
| 安全判据押在别人的元数据上 | 窗口内"父会话"只读会话头 `meta.parentSession`：那个字段由委派方写入，插件既保证不了也测不到 | 判据要有**权威退路**：读不到就问会话存储（`subagents.listChildren`）"审核根的孩子里有没有它"，两条都拿不到才 fail closed（2026-09-29 M33） |
| 超时被当成成功 | `Promise.race` 里计时器**正常 resolve**，不会进 catch → `disposed=false` 但 `errors=[]`，上层继续重试 | 超时必须显式区分"谁赢了"，并以"子会话是否仍在 running"作为静默判据；没确认就**不覆盖记录、不起下一条**（2026-09-29 M31） |
| 不透明 ID 被当路径解析 | `FsTarget.targetKey` 是 `Branded` 不透明标识，只允许等值比较；按路径归一化会错误放行 | 身份比较一律 `===`；`displayPath` 只用于显示；夹具也必须用**不透明 key**建模（2026-09-29 M32） |
| 必需集与拒绝集重叠 | `crwu_audit_case_bootstrap` 同时属于"根必需"和"子会话 deny"，而子会话复查用根必需集 → 真 `toolFilter` 一生效，**正常子会话刚创建就被停** | 拆成 root-required / child-required 两个集合，并用一条门禁断言二者**不相交**；"谁能看到什么"与"谁必需什么"必须分开表达（2026-09-29 M34） |
| 用归属当本次启动的身份 | 窗口内按"父会话 = 审核根"认领 scope：同一个 root 下的旧 sibling 可以冒领新审核的案例范围 | 没有不可伪造的 launch token 时，**没有权威 childId 就不放行**（fail closed）；父会话判据只能用在**拒绝方向**（多拒绝是安全的，放行不是）（2026-09-29 M35） |
| 失败回滚不看静默 | 启动后复查失败就立刻删记录/句柄/占用：dispose 超时 + Agent 仍 running 时，旧子会话还在写案例目录而 Host 已不认识它 | 回滚前必须 `quiesced`；没确认就写成**退役记录**并保留句柄与占用，让用户能再停一次（2026-09-29 M36） |
| 拿不到子 Agent 也继续跑 | 边界复查依赖 `localAgent`，远程 provider 没有它；只记 warning 继续 = 在无法验证边界的子会话里跑完审核 | 读不到就停并失败；provider 只接受能给出本进程子 Agent 的本地实现，**不回退到"第一个注册的"**（2026-09-29 M37） |
| 进程内锁当跨进程事实 | 重启时原样恢复 `pending`（childId 从未落地）记录与指向空 childId 的锁 | 恢复时退役不可绑定的 pending，并且**不恢复**指向空 childId 的占用锁（2026-09-29 M38） |
| 停止只用"一个 RPC 的返回值"表达 | 点了停止后界面只能等这一次 RPC（8 秒空白），而且 timeout 与 disposed 在返回值里长得一样 | 两阶段协议：**先接受并落盘阶段 → 后台继续 → 状态接口回报阶段**；阶段是持久化事实，`canStartNext` 只由 Host 判定（2026-09-29 M39） |
| 客户端自己推断"已停止" | 用 `status !== 'running'` 或"没看到错误"推 stopped/quiesced —— 后端字段缺失时就会显示成功 | 缺字段 = **未知**：不许推断；`canStartNext` 只信 Host，timeout/failed 一律不放行（2026-09-29 M40） |
| 子串匹配断言阶段文案 | timeout 的文案「暂时无法确认子会话**已停止**」本身包含"已停止"三个字，`includes` 会假红 | 断阶段文案要比**整行开头**（`startsWith`）或按 aria-live 区域取行，不用整篇 `includes`（2026-09-29 M41） |
| 撤销授权后还能读到本机凭据 | 界面把入口禁掉，但 `oss-cred` / `ifind-status` / `ifind-probe` / 宿主凭据服务 `set`/`delete` 没有 Host 侧门禁：撤销之后直接调 RPC 照样读 `.ossutilconfig` 与凭据文件 | 门禁写在**读函数**里（`readOssCred` / `readIfindSecret` / `writeIfindSecret` / `clearIfindSecret` / `dwsLocalDoctor`），判据是"未授权时 fs / store / 网络**零调用**"（`host-access-rpc-gate.test.mjs`） |
| 撤销"点了"但没真的关 | 撤销把内存更新排在 `await writeWorkbenchConfig` 之后；写盘失败后环境刷新又从磁盘读回旧授权，进程内变回 `granted` | 任何 `await` **之前**把内存切到关闭态（`persist-failed` 墓碑）；`syncLocalAccessConsent` **不许**用磁盘授权覆盖这个墓碑；客户端在撤销失败时也不刷新环境 |
| Windows 上"读不到"被说成"不存在" | `statOf` 把任何异常折成 `exists:false`，`lstat` 的异常也被吞掉——`Access is denied` 于是变成「`.dws` 不存在，请先登录一次」，修复还可能沿着未知类型的路径动手 | `stat` / `lstat` 一律三态（`present` / `absent` / `error`）：只有 `undefined` 才算不存在；`error` 必须停在"无法确认"并阻断修复 |
| Windows ACL 只找"自己的 Allow" | 给组的权限看不见、显式 Deny 也看不见，于是"修完"报成功而 DWS 依然写不进去 | 判决按**有效权限**算（自己的 + 所属组的 SID、继承 ACE、Deny 优先），并且修复的回读要**真的写一次**（建临时文件 / 以写方式打开） |
| 锁文件存在 ⇒ 锁被占用 | `lockExists && canModify` 被当成 `lockHeld`；分类器还允许"只有锁文本"就定性 | 锁必须**正向探测**（POSIX `lsof -t --`；Windows 无可靠手段 → `unknown`）；拿不到结论就不定性，也不回退成"本机文件权限问题" |
| 保存凭据"成功"但没保护住 | OSS/iFinD 的写盘函数在 `permission.status === 'failed'` 时仍回顶层 `ok:true`，只附一句错误字符串 | 顶层 `ok` 由 `credentialPermissionSatisfied()` 决定（POSIX 回读 `0600` 才算成功；Windows `inherited` 按设计成立） |
| 撤销授权后还能读到本机凭据 | `chmod` / `icacls` 在只读挂载 / 网络盘 / 上层策略覆盖下会**退出码 0 而什么都不改** | `ok` 必须由**回读**决定：修了哪一类就核对哪一类的后置条件（`700` / `600` / `modify=True`），对不上就说"回读与预期不符"（`host-dws-local.test.mjs` 有"静默无效"用例） |
| 一条探测的"沙箱事实"看起来完全访问，其实什么都没证明 | `shell/run.ts` 的 `resolved = spec.sandboxPolicy?.mode` 是**我们自己请求**的模式，特权操作恒为 `danger-full-access`；`ran`（`ShellRunResult.sandbox.mode`）才是执行器答的 | 判断"这条探测真的跑在完全访问下吗"**只能看 `ran`**；替身也要按**服务形状** `{ mode, denied, runnerFailed }` 返回，写成 `{ ran }` 会被 `runShell` 静默忽略（2026-09-29 踩到） |
| 体检把「沙箱不让写」当成「操作系统权限不对」，于是给出一个按下去真会改权限的按钮 | 探测命令虽然声明了逐次 `danger-full-access`，但部署可能把提权降级；受限 shell 里 `test -w ~/.dws` 照样回 1（实测：目录是 `700`、属主就是当前用户） | 每条探测都要先判**它自己**有没有被沙箱拦下（`probeSandboxed`：`denied` / `runnerFailed` / `ran !== danger-full-access`）；被拦下时只能说"不知道"（`null`），`classification` 保持沙箱类，`repairOffered` 自然不渲染（2026-09-29 真机探测抓到） |
| `dws` 体检报「读不到所有者/模式」（`directoryMode`/`ownerMatchesCurrentUser` 空） | `stat -f %u %Lp <path>` —— BSD 的 `-f` **只吃紧跟其后的那一个** token，`%Lp` 被当成文件操作数 → `stat: %Lp: stat: No such file or directory` | 格式串自己也要经 `shellQuote`（`stat -f '%u %Lp' <path>`）；`tests/windows/powershell-contract.test.mjs` 的真 shell 用例会红（2026-09-29 就是这么抓到的 —— 只断言命令字符串的测试全绿） |
| 体检的结论永远是"没确诊" | `dwsLocalDoctor` 自己也要跑几条特权命令，它们会进诊断环形缓冲；等体检跑完再读 `lastDiagnostic()` 拿到的是**体检自己**那一条 | 进体检第一件事就把上一次失败抓在手里（`const failure = deps.access.lastDiagnostic()`），再用它 + 本次探测结论做归因 |
| "不许改权限"的用例删掉某条判据后**照样绿** | 真正的守门人是"必须正向确诊 `os-filesystem-permission`"那条白名单判据，前面几条具体拒绝只是更早的文案 | 证伪这类断言时要把**白名单判据**放宽（不是删黑名单项），否则证明不了任何东西（2026-09-29 实测：删掉钥匙串判据两次都不红，放宽正向确诊立刻红 2 条） |
| 提示词里删掉了"未登录就停下"的要求，测试**照样绿** | 断言用的是整篇 `text.includes('立即停止本次审核')`，而同一句话在"数据边界"那一条里也出现过 | 提示词断言先 `indexOf('**登录与授权（必须照做）**')` 定位段落，再在**段内**逐句查（`host-audit-prompt.test.mjs` 的 C-08 用例就是这么写的）。同类风险：任何"整篇包含式"断言 |
| 审核子会话跑到工作区外面去了 | 只写了提示词、没设会话策略；DSH 的沙箱是 `session 覆盖 ?? 部署默认`，而部署默认可能是 `danger-full-access` | `host/audit/policy.ts` 显式写 + 回读 + 按委派口径预测（§4.8）；`auto` / `danger-full-access` preset 的根**不可复用** |
| 加了 Broker 之后，环境自检里的 `dws auth status` 还是自己拼命令 | 它把 `shellInvoke(dws, ...)` 直接交给 Broker —— 提权走对了，但**绕开了 `runDws` 的 argv 白名单** | 业务 CLI 一律经登记的执行器（`runDws` / `runCrwu`）；`host-access-migration.test.mjs` 的 B-01 守卫会红（2026-09-29 实测抓到两处） |
| 授权类测试全绿，但"未授权不放行"永远测不到 | 夹具给 Broker 传的是 `state` 的**副本**，测试改 `state.localAccess` 时 Broker 看不到 | `makeTestAccess(ctx, { state })` 直接复用同一个对象（见 `tests/helpers/local-access-broker-fixture.mjs`） |
| 提权断言"没有沙箱策略"在 OSS 上失效 | 协议 18 把 `ossutil` 也归入本机凭据访问（它**每次**都读 `~/.ossutilconfig`） | 这类断言的判据是"要不要碰工作区外的凭据"，不是"这条命令看起来像不像读凭据"。改断言时写清原因，别只改期望值 |
| **未授权时仍然报「还没有填写 AccessKey」**（协议 18 加授权闸门时踩到） | 给 `if (granted && …)` 加了闸门，但**后面的 `else if` 没有**：被拒绝的 `if` 会继续往下走，于是用占位事实派了一条真实任务 | 闸门要包**整条链**，不能只包第一个分支。判据：`else if` 的每个分支都自己带条件（或整链套一层 `if (granted) { … }`）。`host-environment-env.test.mjs` 的 A-03 用例按 **issue id** 断言"未授权时没有凭据类任务"，就是拦这个的 |
| 状态文件夹具写了 `trustCredentials:true`，`env` 却报「需要授权」 | 协议 18 的授权是**整条收据**：旧的布尔键被判成 `outdated`（这是刻意的，防静默扩权） | 夹具统一用 `tests/helpers/local-access-fixture.mjs` 的 `grantedConsent()` / `consentConfigJson()`；各文件里手写收据字面量会在下一次升 schema 时静默过期 |
| 新客户端接旧宿主，授权看起来成功了、实际按旧范围跑 | `boot.permissionSchemaVersion` 与客户端不一致（旧宿主根本没这个字段） | `build-store.ts` 的 `hostPermissionSchemaStale()` 判它；不一致时授权卡整体禁用并提示完全退出重启 DSH。**不要**只依赖协议号：两者是同一个 bundle 里的常量，语义不同（协议号答"哪一代"，权限 schema 答"执行的判据是哪版"） |
| 「重启了但还是旧行为」 | 客户端刷新即换新，宿主只有重启才换 | 比对 `ping.builtAt` 与 `lib/index.js` 的 mtime |
| 审核子代理挂在聊天会话下 | 宿主是旧构建（按旧规则挂"当前会话"） | 重启 profile；`audit-start` 的父级必须是审核根会话 |
| 授权重启后丢失 | 状态文件写入被受限沙箱拦住（且错误被吞） | `writeText` 带 `sandboxPolicy`，失败要报出来 |
| browser-check 报「Route is already handled」 | 撤路由撤得太早，拖慢的那次请求还没回来 | 先等被拖慢的请求回来再 `unroute` |
| `getByRole('button', { name })` 取不到侧栏按钮 | 该按钮可访问名拿不到（实测 count=0） | 用 `button:has-text("…")` |
| 真机少了一块界面，单测全绿 | 证伪/还原时漏还原了新建文件 | 还原清单覆盖改过的每个文件；改完在真机复看截图 |
| 要在验收脚本里收/放侧栏（量 56px 轨道） | 侧栏不是插件画的，没有自己的类名可用 | 点 DSH 自带的 `button[aria-label="收起侧边栏"]` / `"打开侧边栏"`（来自 DSH 的 zh-CN 语言包），量完必须展开还原 |
| 验收脚本从整页文本里正则捞流水号，捞到了**氚云待审核**的号 | 讨论会话名是「报告讨论 · <流水号>」，左侧会话列表里就带着流水号 | 按**表格行**取（`tbody tr td:first-child`），不要扫整页；同理，命中断言也要看结果行，否则会被那条同名会话满足 |
| 想在插件面板里内嵌 DSH 原生对话 | `main` 槽位只有保留键 `conversation` 有会话绑定；客户端产物只能 `require('react')`，装不进 `ui-chat`；右栏是资源标签页、没有对话类型 | 自绘外壳 + 挂**真实会话**：`services.sessions` 的 `create/open/binding/list`（见下条），对话正文按会话事件流自己渲染 |
| 自绘面板里读会话事件流总是空 | 会话的**事件窗口只对当前会话打开**（stage 语义），而且绑定与历史是**异步**就绪的 | 绑定/发问前调 `sessions.open(id)`（只切会话选中，**不动主面板**）；读一次 + 挂订阅不够 —— 再加一路 1.2s 轮询（引用比较，没变化不重渲染）；`create` 不支持标题，建完要 `rename`，会话名就是复用凭据 |
| 事件映射一条都匹配不上（面板空着，控制台也不报错） | 会话事件是**信封 + data**：`{type, seq, time, data:{…}}`，字段在 `data` 里，不在顶层 | 先取 `event.data` 再读 `content/source/message/name`；**单测样本抄真实事件**（真机探针打印一条即可），想当然的平铺样本会让单测全绿而真机全空 |
| **Windows 上环境页/按钮报 `ParserError`、`意外的标记`，macOS 全绿** | 有调用点**绕过**了中央适配器自己拼命令（模板以 `` `${shellQuote(` `` 开头、`argv.map(…).join(' ')`、`cmd /c …`） | 所有经 `ctx.shell` 的命令只从 `src/host/platform/shell.ts` 生成；`host-platform-shell.test.mjs` 有两条静态门禁盯着（一条历史守卫在 `host-shell-fs.test.mjs`）。新增调用点先看这两处 |
| 命令返回 0，但目录其实没建出来 / 文件其实没删掉 | 只信退出码 | `ensureDirectory` / `removeFileIfExists` 会**回读后置条件**（只读路径探测，见下一条）；只有「目标已是我们要的状态」才算成功。测试替身必须模拟 shell 副作用（`tests/helpers/shell-effects.mjs`），否则替身会造出「命令成功但文件系统没变」的假机器 |
| 只读探测要不要也全走 Broker（`ensureAuditRoot` 的 `fs.stat`、`report/files.ts` 的本地列举） | DSH 的 `workspace-write`（以及默认的 `read-only`）只限制**写**：可写根由 `dsh-sandbox` 的 `writableRoots()` 推导（工作区 + 临时区），**读没有这条限制** | 案例目录那一条链路（建 + 回读后置条件）**必须**走 Broker，因为它是写；其余的只读探测继续用 `ctx.fs`（2026-09-30 决策：不为"可能的读限制"加一层没有证据的间接层）。**实测**：本机 `workspace-write` 下读工作区之外的路径正常（`cat ~/.dsh/profiles/desktop/package.json`、`stat ~/.dsh` 都成功）。真机上如果出现"读不到外部工作空间"，先看那条命令的沙箱事实，再决定要不要把 `system.workspace-directory.read` 铺到那两处 |
| **案例目录建出来了，紧接着 `mkdir <案例目录>/输入快照` 回 `Operation not permitted（沙箱拒绝=是）`** | **DSH 的执行器不持有会话**：请求里不带 `sandboxPolicy` 时它只用部署默认（`workspace-write` + 兜底根 = 进程 cwd），而案例目录是**调用方那条会话**的 cwd。⚠️ 换 `ctx` 没用（第一次就是这么修的，真机原样复现） | 案例内的调用点把 `exec.agent.session` 交给 Broker（`BrokerShellOptions.session`，**不是权限开关**），Broker 用 `ctx.sandboxPolicy.resolve({ session })` 算出策略放进请求。替身必须**按策略拦人**（`tests/helpers/fs-sandbox-stub.mjs`），否则这类缺陷在单测里永远看不见 |
| **`mkdir: Operation not permitted` 建不出案例目录**（员工选定工作空间本身可写） | 案例目录在会话 cwd **之外**，而案例目录创建直接调了 `shell/run.ts` 的裸 `runShell` → 拿到部署默认的 `workspace-write`（边界 = 会话 cwd），写被沙箱拒绝；员工本人对那个目录是有写权限的 | 建目录走 Broker 的 `system.case-directory.write`（**特权**、来源 `audit-host`、`workspaceRoot = 员工选定的工作空间`），建完回读后置条件；失败按三分类给话：沙箱拒绝 / 操作系统权限 / 工作空间不存在。`tests/unit/host-access-migration.test.mjs` 的 B-01e 禁止 `case-files.ts` 再出现裸 `runShell`，`host-case-files.test.mjs` 有一台**真的会拦人**的沙箱替身做回归 |
| Windows 上案例名/目录名变成一整条路径 | `path.split('/')`（Windows 分隔符是 `\`） | 用 `shared/utils/local-path.ts` 的 `basenameLocalPath` / `joinLocalPath`；跨端拼接也走它 |
| `C:\` 被裁成 `C:`（盘符相对路径），或 UNC 根被裁坏 | `replace(/[\\/]+$/, '')` | 用 `trimTrailingSeparators`（保留 `/`、`C:\`、`\\server\` 这些根本身） |
| Windows 上说「凭据权限已收紧到 0600」 | `chmodOk: boolean`：Windows 没有 `chmod`，跳过之后只能是 `true` | 协议 17 起用结构化 `permission`（`verified` / `inherited` / `failed` + `mechanism`）；Windows 报 `inherited / windows-acl`，界面文案由 `features/environment/credential-permission.ts` 决定 |
| 装上 tarball 时 `prepare` 报找不到 `tsdown`，或项目路径被拆成两截 | `spawnSync('tsdown', { shell: true })`：一过 shell，路径里的空格与单引号就被第二套规则改写 | 用 `scripts/lib/cli-entry.mjs` 解析 JS 入口 + `process.execPath` 执行，**不传 `shell`**；`host-prepare-script.test.mjs` 会在带空格与单引号的目录里真构建一次 |
| 加了 DSH 兼容线，装到真机上却被禁用 | 只写了「读区间字符串」的单测 | `npm run compat:dsh`：干净工程里真的装两条线的完整 peer 集 + `npm pack` 的 tarball，再调 DSH 自己的 `evaluatePluginCompatibility()` 断言不 skip/disable，并用该版本类型跑 tsc |
| 审核根预检在 Windows 上直接失败，错误里出现 `bash` | 预检提示词写死了「用 bash 执行 `pwd`」 | 预检由 `auditRootProbe(platform)` 按平台生成（Windows `Get-Location` / POSIX `pwd`）；`host-audit-root.test.mjs` 断言两个平台都不出现 bash |
| **发布 job 里「故意跑失败」的断言把整条流水线判红** | GitHub 的 pwsh 壳用脚本末尾的 `$LASTEXITCODE` 当步骤退出码；`Write-Host` 不会把它重置成 0 | 「存退出码 → 断言 → 末尾显式 `exit 0`」；`tests/unit/host-ci-workflows.test.mjs` 用 yaml 解析两个工作流，凡是引用 `$LASTEXITCODE` 的 `run` 块都必须以 `exit` 收尾（已证伪） |
| **`git diff --check` 报「干净」，但已提交内容里仍有 `new blank line at EOF`** | `git diff --check`（不带范围）只看**工作区/索引**与 HEAD 的差异 —— 工作区干净时它什么都不查，完全看不到已提交的改动 | 提交前用 `git diff --cached --check`；提交后/复查用 `git diff --check main...HEAD`。同一类缺陷还有机器门禁兜底：`tests/unit/host-text-hygiene.test.mjs` 断言本包文本文件**末尾恰好一个换行、且无 CRLF**（已证伪） |
| 权限收紧「成功」但模式没生效 | 只看了 `chmod` 的退出码；部分文件系统（网络盘、虚拟化挂载）会静默忽略 chmod | `enforceCredentialPermission` 收紧后**回读模式位**（`readFileModeCommand`：GNU `stat -c %a` / BSD `stat -f %Lp`），对不上即 `failed`；`verified` 只能由观察到的 `600` 支撑 |
| `Access denied` 被回报成「删除成功 / 目录已建好」 | 把 `fs.stat` 的**异常**折叠成「不存在」 | `case-files.ts` 的 `probePath` 是三态（存在 / 不存在 / 查不出来），「查不出来」按基础设施失败上报；只把 `undefined` 当不存在 |
| 审核子代理「重新定位/搜索报告」：自己发现表单、列记录、翻案例目录 | 交接不完整：启动只给 objectId/seqNo/project，而记录接口要 `schemaCode` | Host 先解析表单 code（实例级 `H3yunFormResolver`，只发现一次、并发共享），再用 `crwu_audit_case_bootstrap` 按精确 objectId 取一次数落成 `输入快照/`；`schemaCode` 不进任何 Tool 参数（`host-tools.test.mjs` 逐字断言） |
| 新报告点「AI 审核」必失败：`输入快照交接失败（input）：案例目录不存在或不是目录：<工作空间>/<流水号>`（审过的报告却好好的） | `<工作空间>/<流水号>` **谁都没建**：案例内每个 Tool 都过 `requireCaseDir`（要求目录已存在），而 bootstrap 又必须在子代理之前落快照 —— 旧形态是子代理自己 `mkdir -p`，结构化 Tool 化之后那条路没了，于是只有目录已存在的（审过的）报告能再发起 | `audit-start` 在 bootstrap **之前**由 Host 建目录（`tools/case-files.ts` 的 `ensureCaseDirectory`，经 `system.case-directory.write`），失败就在创建子代理之前报 `创建案例目录失败：<路径>（原因）`；`host-audit-lifecycle.test.mjs` 用 trace 钉死「mkdir → bootstrap → start」的次序 |
| 后置条件回读在受限沙箱下「查不出来」，把建好的目录报成失败 | 探测走 `ctx.fs.stat`：它和服务沙箱是同一条策略，"读不到"与"不存在"分不开 | 探测改走 Broker 上的一条命令（`platform/shell.ts` 的 `pathProbeCommand`：`test -d` / `Test-Path -PathType`，**永远以 0 退出、结论只在 stdout**），"命令没跑起来"才是不确定；测试替身要回答它（`tests/helpers/shell-effects.mjs` 的 `probeAnswer`） |
| 技能脚本报缺 `openpyxl` / 结果不可信 | 用了系统 `python3`：它不是审核运行时 | 只用 `load_workspace_dependencies` 返回的 DSH Python（实例级解析、只缓存成功）；审核启动解析不出来就不建子代理；技能正文禁止裸解释器名字与静默降级 |
| 环境自检里 packaged 三件套又「未安装」 | 拿 PATH 当判据（Finder 启动的桌面端 PATH 只有 `/usr/bin:/bin`） | packageIntegrity 只认包内 `bin/<平台>/` 与 `bin/manifest.json`（比对 size），**不** `command -v`、**不**回退 PATH、**不**跑 `dws version`（会生成 `.dws/` 残留）；缺了就说「插件包不完整/平台不受支持」 |
| 自检里出现「未安装 python3」 | 把系统解释器当依赖 | 环境页的 ③ 层是「DSH 脚本运行时」：拿不到就报 capability gap，不检查裸 `python3`、也不接受 `/usr/bin/python3` |
| 讨论会话里模型去 `ls`/`find` 翻本机目录、并把材料下到 `cases/<流水号>`（错的） | 提示词只写了「不得读本地文件」，却**没给唯一允许的目录** → 模型自己猜 | 两条讨论提示词都注入 `fetchRules()`：唯一案例目录（`<工作空间>/<流水号>`，与审核链路共用 `caseDirOf()`）+ 用 `crwu_h3yun_file_get` 逐件重下 + 禁止 `ls`/`find`/`grep` 扫本机；本机路径只允许出现这一条（测试按正则抽出全部路径去重断言） |
| 「讨论会话里工具调不动」的错觉 | 实测工具是通的（`crwu_audit_capabilities` 返回 8 个 available、附件都下回来了），真正在动的是并行的 `bash`/`read` 翻目录 | 先读真实会话记录再动手：`~/.dsh/sessions/<工作空间>/<会话>/session.v4.jsonl.zstd` 是**多帧 zstd**（逐帧 `zstdDecompressSync` 才解得全，`createZstdDecompress` 只给第一帧） |
| 点「与 DeepSeek 讨论报告」/「复核报告」**跳不到对应的会话**（点下去什么都不发生，也不报错） | 客户端 `sessions` 服务上**没有** `open()`（`ClientSessions` 只有 retain/using/binding/create…）= 早先写的 `sessions?.open?.(id)` 被可选链吞成静默 no-op | 跳到会话只有一条路：`uiWorkspace.openSession(id)`（内部 `replaceMain(…, 'reveal')`）；`discussionPortOf` 里**不许**凭空发明服务上没有的方法，`DiscussionPort` 只放真实的四个动词 |
| 讨论会话「建不出新对话」/ 每次都新建一条 | 会话 face 取得不对：`binding(id)` 只对**已被 retain** 的会话有值，刚 `create()` 的还没有 → rename 静默跳过、kickoff prompt 发不出去 | 用 `sessions.using(id, {source}, (ref) => ref.binding.session.rename/prompt)`；`binding` 只作旧宿主退路。改名失败要如实报（`aiRenameFailed`） |
| 客户端适配器把服务方法「取出来再调」后第一个调用就 `TypeError` | `ClientSessions.create/using/binding` 都依赖 `this`（`this.manager` / `this.scopes`） | 适配器里一律 `svc.create(...)` 经接收者调用；也不要 `{ ...sessions }`（方法在原型上，展开只剩字段） |
| 安装提示词还让 agent 手工跑 `crwu h3yun session login` / `dws auth login` | 旧文案把「本机零安装」只做了一半：二进制随包了，但登录仍交给 agent 拼命令行 | 改成在面板 ③ 登录认证 里点按钮（`install-prompt.ts` + `install/INSTALL-PROMPT.md`），`host-install-prompt.test.mjs` 里有一条「不许出现可直接照抄的登录命令」 |
| 想「顺手」把插件 `bin/<平台>/` 挂进用户 shell PATH（或往 `~/bin` 拷副本） | 那会让「手工拼命令行」看起来可用，绕开沙箱/审批；插件升级后该路径还可能失效 | **不要这么做**。插件用包内绝对路径启动；`~/.zshrc` 里那条 PATH 注入已按此口径删除，并留了「为什么不要再加回来」的注释 |
| 审核子代理自己去 `which crwu` / `command -v dws` / `find … ossutil` | 提示词里写着「命令在哪」，或某个 Tool 不可见时它自然去找退路 | 审核链路只给结构化 Tool；插件在**创建子代理之前**做确定性能力门禁（`host/audit/preflight.ts`），缺 Tool 直接失败并点名 |
| 某个 Tool 在根 Agent 可见、在**子代理**却不可见 | 子代理是新的 scope，预设/委托运行时可以再加一层 restriction | 子代理发布后按**它自己的 scope** 复查（`missingAuditTools(ctx, childAgent)`），被收窄就立刻停掉该子会话并失败 |
| `ctx.tools.get(name, agent)` 老是返回 undefined | scope 传错了：DSH 的 scoped 路由 key **就是 agent 对象**（`scopeTarget(base, exec.agent)`），不是 `agent.ctx` | 传 Agent 对象本身；`agent.ctx` 只用于「优先用调用者的 Context 执行 shell」 |
| Tool 的输出 schema 校验总是失败 | `defineTool` 的 schema DSL **没有 `required: [...]` 数组**：必填是**每个属性上的 `required: true`**；也不支持 `type: ['integer','null']` | 见 `src/host/tools/*.ts` 的写法；`type` 只允许单一类型，联合用 `oneOf` |
| shell 取消不生效，`exec.signal` 像是被丢掉 | `runShell` 直到 2026-09-25 才接收 `signal` | Tool 把 `exec.signal` 传进 `runShell` → `ShellExecRequest.signal`；`ShellResult.aborted` 单独一位，别和 `error`（基础设施故障）混用 |
| 审批拒绝被报成「沙箱不可用」 | DSH 的三类失败文案不同：审批是 `approval / rejected / cancelled`，基础设施是 spawn/服务缺失 | `src/host/tools/outcome.ts` 的 `APPROVAL_FAILURE` 一处收口；`classifyRun` 先看 `aborted`，再看审批，最后才是退出码 |
| `assert-pack` 说通过，员工装到的二进制却是坏的 | 旧判据只看「文件在不在、非不空」—— 内容无关 | `bin/manifest.json` 记**最终文件**的 size + sha256，`sync-binaries --check` 与 `assert-pack --strict` 都按清单重算 |
| 干净发布机上打出来的包没有 `bin/` | `bin/` 是 gitignore 的构建产物，发布作业自己没装配 | `release.yml` 先跑 `binaries` job（macOS 交叉编译 + 装配 + 自检），artifact 交给发布 job；发布作业跑 `pack:assert:strict`，缺一个平台/工具/manifest 就红 |
| 悬停操作列的「AI 审核 / 重新审核」时整个按钮**全黑** | 选择器特异性 + 顺序：基础 `.crwu-audit-btn` 是 (0,1,0)，§20 迁移覆盖层把它写在样式表**最后**；单类变体 `.crwu-audit-btn-primary` 也是 (0,1,0) → 变体底色与字色被基础规则吃掉（主按钮看起来就是普通按钮），而变体那条 `:hover` (0,3,0) 反倒生效 —— 深底 + 深字 | 变体改用**双类** `.crwu-audit-btn.crwu-audit-btn-primary`（(0,2,0)）把顺序依赖去掉；hover 的选择器组里带上基础按钮的 `:hover:not(:disabled)`；hover 里**不要**写 `opacity`（会盖掉 `:disabled` 的 0.45）。分辨"是色值不对还是规则没生效"直接用 CSSOM：遍历 `document.styleSheets` + `element.matches(sel)`，按顺序打印所有命中该元素的 `background/color` 声明（`getComputedStyle` 只看结果，看不出谁赢了） |
| 改了 `~/.dsh/settings.yaml` 的 `ui-theme.preference` 来验另一套主题，之后文件被改回去/改不回来 | 正在跑的 profile 进程会把内存里的主题偏好**回写**这个文档；两个实例（用户 `web` + 自测 profile）同时活着时更乱 | 验主题时**先停掉会回写的实例**再改文件；验完按备份逐字还原（`diff` 确认），最后重启一个实例读回用户原值。主题是 Host 侧设置（`~/.dsh/settings.yaml` 的 `ui-theme`），**不是**浏览器 localStorage，也不是 `prefers-color-scheme` |
| 往页面里注入探针按钮量颜色，量出来全是 `rgba(0,0,0,0)` + 继承色 | 探针挂在 `document.body` 上，而 `--crwu-*` token 定义在**面板子树**（`.crwu-audit-root` / `.crwu-audit-surface`）里；token 取不到 → 每条 `var()` 声明都失效、退化成透明/继承（几何类声明照旧生效，所以"看起来像样式没加载"） | 探针必须挂进**真实的面板节点内部**（如 `.crwu-audit-td-action .crwu-audit-row-actions`），要浮在角落再给 `position: fixed`（自定义属性按 DOM 继承，与布局无关）；量颜色时把**邻近的真实按钮一起读**，能立刻发现"三个按钮全透明"这种整体失效 |
| 深色主题下工作台还是浅色（或反之） | 拿 `@media (prefers-color-scheme: dark)` 当判据 —— 那跟的是**操作系统**，不是用户在 Harness 里选的偏好 | DSH 的主题插件把解析后的明暗写到 **`body[data-ds-dark-theme]`**；在 §19 里用 `body[data-ds-dark-theme] .crwu-audit-root { --crwu-…: … }` 覆盖同名 token，规则与组件一份都不用改 |
| 「样式里出现硬编码颜色」的红条报在一个根本没写颜色的地方 | 单测是**先把 §19「工作台 Design Token」整块剔除**再扫 `#hex` / `rgb(` / `hsl(`；那块靠 `/* ═` 分隔线结束 | 新的字面量色值只能加进 §19 那一块；别在别处补 `#hex`，也别动 §19 的标题文字（正则按它定位） |
| 新加的类名没有样式，页面看起来"少了一块" | `WORKBENCH_CLASSES` 里加了键但样式表里没有 `.<类名>` 规则 | 有一条单测断言"每个类名常量都有一条规则"（`client-package.test.mjs`），补规则即可；新写的断言记得**注入缺陷证伪一次** |
| `oss-index` / `report-files` 等测试突然全部报「插件包不完整」 | `resolveOssutil` **删掉了 PATH 回退**（2026-09-25）：只认包内 `bin/<平台>/ossutil`，替身里的 `command -v ossutil` 回应已经不算数 | 测试的 fs 替身要让 `bundledBinaryPath(platform, 'ossutil')` 这个 key `stat` 出 `{type:'file'}`，且 `platform` 必须是 `darwin-arm64`/`win32-x64` 这类规范键（写成 `'darwin'` 会直接判成平台不受支持） |
| 环境自检突然对一台装好 Python 的机器报「未安装」/ 少一项 | 清单曾把 `crwu`/`dws`/`ossutil`（packaged）与 `python3`（runtime）混在一张 `binaries[]` 里统一按 PATH 命令探 | 清单已拆成 `packaged[]` + `runtime.python`（`crwu.env-manifest.v3`）：packaged 只 `stat` 包内文件比字节数（**不跑命令**），runtime 只认 **DSH 自带** Python（缺了报 capability gap，不是「未安装」）；`blocked` 里插件包不完整只算一项 |
| 客户端里点「复制」没反应也不报错 | `navigator.clipboard` 在非安全上下文（老宿主 / 非 https）里是 `undefined`，`writeText` 也可能 reject | `ReportPane.copySeqNo` 先判 `typeof clipboard?.writeText === 'function'`，失败就**静默不改状态**（不假装复制成功），Hover 复制图标只在行悬停/聚焦时出现 |
| 同一行里的次级控件看起来"颜色不一致" | 各自的底色被写成了不同的值（一个填充、一个透明、一个又是 Ghost） | 次级控件（刷新 / 小鲸鱼 / ••• / 复制）**只允许走 `--crwu-control*` 这一对**；单测「次级控件共用同一套中性底」盯着 |
| 鼠标移到某一行时，小鲸鱼 / ••• 的底色"消失" | 中性控件的底与 `--crwu-hover`（行悬停底）取了同一档 | `--crwu-control` 必须与 `--crwu-hover` **分得开**（浅色 `#EFF0F2` vs `#F5F6F7`、深色 `#2E2F34` vs `#222326`），且浅深两套里各写一遍 |
| 业务界面出现「昨天 / 09-20 / 3 天前」 | 有人为了"简洁"写了相对时间格式化 | 审核/复核/交付留痕**一律绝对时间**（`features/report-audit/time.ts`：`YYYY-MM-DD HH:mm`，只有日期给 `YYYY-MM-DD`，完整原值进 title / 技术详情）；只有 DSH 侧栏的会话活跃时间允许相对 |
| 抽屉里要显示「AI 发现了什么」，但客户端根本没有 issues[] | `oss-result` 的摘要只回 counts/metrics/bands，问题清单在完整 JSON 里 | 在 `auditInfoFromResult` 里**追加裁剪过的最小集**（`issues[]` / `reviewItems[]`，逐字段截断 + 封顶），并按规矩把 `WORKBENCH_PROTOCOL` +1；`ruleEvidence` / 知识库路径仍然不进这个接口 |
| 「已提未改」把已经改好的说成没改 | 只看 `overlap > 0`，或只看 `issue.flowStatus`，或只看 `inFileResolution` | 必须 **`linkedIssueIds` 非空 且 `inFileResolution === 'L-open'`**（交付规范 §6.1「复核已提出 · 被审件未落实」）→ 关联 issues → 按 issueId 去重；宁可少显示也不误报 |
| 断言「业务区不含原始 JSON」却一直假通过 | 把若干节点的文本拼起来再 `replace` —— 拼接会引入原串里没有的分隔符，替换直接失败 | 用**子树整段**做减法（`all.split(textOf(fold)).join('')`），或直接断言具体节点文本 |
| | 说"OSS 只能拿到 key，判不了版本" | `oss-index` 给自己加了 `--short-format`（那才只剩 key） | `ossutil ls` **默认就是长格式**：一次列举同时给出对象个数与每个对象的 `Size(B)` / `LastModifiedTime` / **`ETAG`**（`ossutil help ls` 的样本可查）。用 `parseLsEntries()`；**不要**再加 `--short-format` |
| | 报告业务会话里模型去读本机文件 | 上下文里塞了本地路径（案例根目录 / 本地案例目录的文件名） | **远端-only**：`fileLinesOf()` 只列氚云附件 + 云端交付件；本地那份只用于界面显示。远端取不到就**重试**，不许 fallback 本地（用户 2026-09-23 强制规则） |
| 想给某个会话单独限制工具（不给 bash/fs） | 以为 `sessions.create({agentPreset})` 能生效 | **不能**：客户端 `sessions.create()` 会重建 payload，只转发 `{workspaceId|cwd, sessionId}`，多余字段被丢掉（读 `@deepseek-ai/dsh-api-session-controller/lib/client.js` 的 `create()`）。只有宿主侧 `agents.create({meta:{agentPreset}})` + `agentPresets.mount()` 这条路能按 preset 组合建会话（建审核根会话用的就是它），且 preset 必须是磁盘上一个被发现的目录 |
| | 想在会话上挂 `conversationContextType` 之类的元数据 | DSH 的 `sessions.create` 只吃 `{workspaceId, cwd}`，会话行（`SessionSummary`）只有 `updatedAt`、没有 metadata | 用**会话名前缀**当来源标识（本仓既有的"名字即映射"），`ensureDiscussion({kind})` + `sessionsOfKind()`；不要去改会话数据库 |
| 点了 DeepSeek 直接建会话，把半个月前的审核结论当成"当前问题" | 没有做版本检查 | 先 `freshnessOf()`（`digest → version → etag → mtime → 时间退化`）；**纯时间差只给 possibly_stale**，`stale` 必须有 digest/version/etag 证据；缺原始报告要进 Limited 并如实写进上下文 |
| | 抽屉/浮层里的菜单项点了没反应（脚本里 `getByRole('button', { name })` 超时） | 菜单项挂的是 `role="menuitem"`，可访问角色不是 button | 用类名 + 文案定位（`.crwu-audit-float-item` + hasText）；`install/browser-check.mjs` 里已经踩过两次 |
| 用户报「界面颜色不对」，但自己本地看是对的 | 主题是**服务端设置**（`~/.dsh/settings.yaml` 的 `ui-theme.preference`），用户切到 dark 之后整页观感全变（主操作会从深色实心翻成近白实心） | 改配色先在**当前真实主题**下量一遍：读 `~/.dsh/settings.yaml` 或用浏览器会话里 `document.body.hasAttribute('data-ds-dark-theme')` 确认，不要默认浅色 |
| Windows 上环境页「氚云员工会话」「钉钉认证」两行一起红，报 `表达式或语句中包含意外的标记"h3yun"` / `ParserError` / `UnexpectedToken`（macOS 上一切正常） | 拼命令时按 `cmd.exe` 的规矩办事，而 **DSH 在 Windows 挂的执行器是 PowerShell**（`@deepseek-ai/dsh-pwsh-local` 把整条命令当**一个 argv 元素**交给 `pwsh -Command`）。于是在 PowerShell 里「引号包住可执行文件」是**字符串表达式**、不是命令调用，紧随其后的第一个参数就成了意外标记。同一类错还有 `chmod`（Windows 根本没有这个命令）、`rm -f`（`-f` 在 `Remove-Item` 上同时匹配 `-Force` 与 `-Filter`）、`mkdir -p`（靠参数名缩写） | ① 命令位置一律走 `shellInvoke(exe, args, platform)`（`environment/probe.ts`），它只在 Windows 补调用运算符 `&`；**参数位置**用 `shellQuote`，Windows 走 PowerShell 单引号字面量（双引号会插值 `$`）；② 平台方言跟着**同一个 `platform` 键**走，不要读 `process.platform`（否则 Windows CI 上跑 stubbed `darwin-arm64` 的用例也会被加上 `&`）；③ POSIX-only 命令按平台分支（`ifind/store.ts` / `oss/ops.ts` 已有样例）。`host-shell-fs.test.mjs` 有一条静态守卫盯着「模板以 `${shellQuote(` 开头」与「`argv.map(…shellQuote…).join(' ')`」这两种会复发的写法 |
| **首次使用点「扫码登录氚云 / 钉钉登录」浏览器起不来**，面板给的是 `mkdir …\Temp\crwu-scan-…: Access is denied.` 或 `acquiring file lock: …\.dws\.data.lock: Access is denied.`（看着像 CLI 自己坏了） | 登录**必须写工作区之外**：氚云的临时浏览器 profile（`$TMPDIR`/`%TEMP%\crwu-scan-*`，再经 CDP 读会话）、钉钉的 `<HOME>/.dws/.data.lock`（拿登录态前先抢锁）、以及两者收尾的操作系统凭据存储。宿主按完全访问跑、操作系统的 ACL/受限令牌仍然拒绝时就是这两句；受限沙箱下浏览器起来了也会在几毫秒内 renderer 崩溃（CDP 只回 `close 1006` / `Target crashed`）。**设备码登录不是退路**：它同样要抢 `~/.dws` 的锁 | 归因只看结构化事实**加一条**登录专用的文本判据：`src/host/system/login-failure.ts` 的 `loginFailureAdvice()` —— 顺序是 `runnerFailed` → 提权被降级 → `denied`/实际受限 → 「点名了登录必须写的工作区外目标 **且** 带拒绝字样」。它由 `dwsLogin` / `relogin` 填进 `error` 与 `sandboxBlocked`，界面据此说"把访问模式切到「完全权限」再点一次"，**原始报错保留**。⚠️ 这是 `sandboxDenialNote()`「事实干净就不猜文本」的**唯一例外**，理由是目标集合已知（别把它推广成通用规则）；**目标词与拒绝字样必须同时命中**，否则 `secret not found in keyring` 这种"真没条目 / 钥匙串被锁"会被说成权限问题。⚠️ 还分**两支**（`policyBlocked`）：事实说降级/拒绝 → 让人切「完全权限」；**事实干净却仍被拒 → 是这台机器在拒，必须说"切权限没有用"**（2026-09-29 实测：三个模式都是完全访问，第一版却在让人去切权限）。登录的临时目录也改由插件指定（`<home>/.dsh/crwu-workbench/auth-tmp`，见 `system/auth-scratch.ts`），不再依赖系统 TEMP |

## 11.1 环境领域模型与统一门禁（2026-09-26）

**一句话**：`allOk + blocked[]` 不再承担所有语义 —— 事实（`userSetup` / `systemHealth`）、
解释（`issues[]` 带 owner / blocking / scope / action）、结论（`status` / `capabilities` /
`passed·total`）三层分离，判据只有一份纯函数（`src/shared/environment/model.ts`）。
界面**只读** `env.state`，不再自己算结论。

为什么必须这么改（都是实测出来的自相矛盾）：

- 一个 `blocked[]` 里同时住着「员工该做的」与「员工做不了的」（包不完整 / 无系统 Python /
  改 PATH），界面只能平铺，于是员工被指去装一份插件根本不会用的解释器；
- iFinD 当时是**条件能力**，却与"氚云没登录"长得一模一样 —— 2026-09-26 曾把它改成必需项，
  2026-09-30 又按用户口径改回**可选数据源**（见下面的表格、§11.2 与 §14 开头的取代说明）；
- 顶部说「环境就绪」（`allOk`），旁边的通过率说「7/8 通过」（分母把可选项也算进去了）。

四条判据（改这块前先读，测试逐条盯着）：

| 情形 | 结论 |
| --- | --- |
| iFinD API-Key 未通过 | **不阻塞**（2026-09-30 起它是可选数据源）：只记一条 `blocking:false` + scope=`external-data` 的 issue；owner 仍按 credential→user / entitlement→admin / infrastructure→system 分派；只有 `externalData` 关闭，`global` / `auditCore` / `delivery` 与通过率分母都不受影响 |
| 工作空间未选定 / 目录已消失 | 阻塞（owner=user）：插件**不创建**工作空间根目录，只允许重选一个已有目录 |
| 未登记但存在的工作空间目录 | **只登记**（`workspaceRegistry.create`），不建目录 |
| 氚云 / 钉钉 / OSS / 工作空间缺失 | 阻塞（`action-required`，owner=user） |
| 包 / 运行时 / 平台 / Tool 故障 | 阻塞（`system-blocked`，owner=system，**不派给员工**） |
| 部署配置缺 bucket | `admin-required`（owner=admin） |
| 通过率 | 只统计必需项，`passed/total` 与 `status` 永远自洽 |

**统一导航门禁**：`features/workbench/modules.ts` 的 `requiresEnvironment` / `requirement` +
`module-store.ts` 的 `navigate(target)` 是**唯一**入口（侧栏子项、报告页内跳转、环境页
「进入报告审核」、以后新增的页）。被拦时不进入目标页 → 记 `pendingTarget` → 落到 `env` →
显示「进入【目标页】前…」；检查通过后**只恢复最近一次**被拦的目标；用户中途改去别处即取消
自动恢复。**踩过的坑**：面板里那条 `envChanged` effect 的依赖一开始写的是解出来的 `env`，
两次刷新之间 `env.state` 的引用不变时它就不跑 —— 表现是「重新检查通过了、人还卡在环境页」。
依赖要用**模型对象的引用**（Host 每次应答都是新对象）。

**Host 侧另有能力门禁**（`src/host/environment/gate.ts`）：界面门禁管体验，Host 门禁管真实性与
绕过防护（同源路由是公开契约）。`audit-start` 判 `auditCore`，判据是**同一份 60s 快照**
（授权 / 换工作空间 / 存凭据 / 登录之后 `invalidate()`），**不为每个操作重跑一遍完整自检**；
拿不到快照或自检失败一律 fail closed。**停止审核与释放占用锁刻意不判门禁** —— 它们是安全出口，
环境刚坏时更要能停能放。

**两个踩过的坑（2026-09-26）**：

1. **拦截理由只能拼一层**。`environmentGate` 已经把整句算好了（iFinD 未通过时是
   「进入【报告审核】前，请先完成 iFinD API-Key 验证。」），而 `navigateModuleIn` 当时又套了一层
   通用模板，结果是「请先完成环境配置。（…请先完成 iFinD API-Key 验证。）」——
   员工第一眼看到的仍然是一句笼统的话，而"指名到项"正是这条需求要的东西。
   现在 `navigateModuleIn` 只在门禁**没给理由**时兜底。
2. **拦截说明要当场出现**。环境页原来只在 `gate === 'blocked'` **且** `gateTarget` 存在时画那条提示，
   而 `gate` 只在面板自己点过「重新检查 / 进入报告审核」之后才会变成 `blocked` ——
   于是"侧栏点子项被拦回来"这条最常走的路径上，页面**什么都不说**。
   现在 `WorkbenchPanel` 把统一导航层的 `blocked` / `pendingTarget` / `gateReason` 直接下发给
   环境页（`gate` 的优先级：界面刚点的动作 > 导航层结论），页面原样显示 `gateReason`。

### 11.2 iFinD 凭据：插件自己的状态文件（2026-09-26）

- 凭据在 `<home>/.dsh/crwu-workbench/ifind-credential.json`（原子写入 + `chmod 600` + 回读核对）；
  优先 DSH 凭据服务（`ctx.get('credentials')` 形状），当前版本没有时落文件，判断只在
  `resolveIfindStore()` 一处。**不再读 `~/.agents/skills/…/mcp_config.json`**。
- 空值 / 占位符 / 首尾空白 / 换行在**写盘之前**拒绝；明文只有 `readIfindSecret` 一个出口且只给
  Host 内部；面向界面与模型的视图**只有长度**。
- 界面上叫 **API-Key**（不是"SK"）。保存或点击「重新验证」时才真的取一次数据；环境校验只读最近结论
  （`initialize` → `tools/list` → `tools/call`）：`ok`（认证）与 `dataVerified`（取数）是两个结论，
  认证过了但没取到数据时状态是 `unverified` + 明确的 `errorKind`，**不许显示成「已认证」**。
  环境页的反复刷新与「重新检查」都不再访问 iFinD；只有用户主动保存或点击「重新验证」才更新这份结论。
  试取工具由 `pickProbeTool` 从真实 `inputSchema` 挑（只读、必填 ≤ 1、无开关参数），写/批量类不碰。
- 保存后**立刻真实探测**（同上，含取数）；失败归因**四个阶段一致**（`classifyFailure`）：
  先看 401/403 再看消息指纹。401 → `credential`、
  403 → `entitlement`、网络 / 超时 / 协议 → `infrastructure`，三者不许混。
- `describe_tool` 返回**脱敏、限深、限长**的 `inputSchema`（净化器接在 schema 出口的**每一层**上 ——
  只在最外层净化会漏掉 `properties` 嵌套里的示例值）。
- MCP `protocolVersion` = `2025-03-26`（官方 1.4.0 客户端）并**显式协商**；回不认识的版本按
  协议错误失败，不许静默假设 `2024-11-05` 永远有效。

## 12. 自研审核链路：结构化 Tool 优先（2026-09-25）

**一句话口径**：审核子代理**只**调用业务级 Tool，插件**只**经 `ctx.shell` 执行包内二进制；
链路里没有「让模型自己找命令」这条退路。

### 12.1 谁在哪一层

| 层 | 职责 | 文件 |
| --- | --- | --- |
| Tool 定义 | 模型可见的 schema、输出契约、失败分类 | `src/host/tools/{capabilities,h3yun,knowledge,oss,dingtalk}.ts` |
| 注册与生命周期 | `ctx.tools.register()` + 注销、可见性判据 | `src/host/tools/register.ts` |
| 命令构造 | `dws` argv 白名单、包内绝对路径、`ctx.shell` | `src/host/dws/run.ts`、`src/host/crwu/run.ts` |
| 纯逻辑 | 回传计划、知识库目录树寻址（可单测，不碰 IO） | `src/host/dws/{plan,knowledge-tree}.ts` |
| 门禁 | 案例目录包含、失败分类、能力预检 | `src/host/tools/{case-dir,outcome}.ts`、`src/host/audit/preflight.ts` |

### 12.2 三条不许破的边界

1. **模型不提交基础设施参数**：binary / argv / command / sandbox 模式 / bucket / 组织 / 团队空间 /
   profile / nodeId 都不在 schema 里。审核 Tool 的输入只有业务标识 + `caseDir`。
2. **命令不经模型**：`dws` 走 `runDws`（argv 前缀白名单，表外默认拒绝），`crwu` 走 `runCrwu` 且审核
   Tool 先做严格二进制解析，`ossutil` 只在 `crwu_audit_oss_publish` 里拼。
3. **提权不由模型触发**：只有本机凭据命令 + 已允许（`localAccess` 收据）+ `workspaceRoot` 已知，
   插件才在请求里带 `danger-full-access`；其它一律默认沙箱。

### 12.3 怎么验

- `npm test`：`host-tools.test.mjs`（注册/schema/逃生字段/包内路径/signal/沙箱/钉钉/OSS/失败分类）、
  `host-audit-prompt.test.mjs`（提示词里只有 Tool 名，没有路径与裸命令）、
  `host-audit-lifecycle.test.mjs`（缺 Tool 或能力缺失时**不得创建子代理**）、
  `host-bin-manifest.test.mjs`（清单哈希判据）、`host-skills-guard.test.mjs`（技能侧守卫 + 证伪）。
- `npm run skills:cli-guard`：非 vendored 技能的活跃指令里不许出现裸 CLI / `which` / `command -v` /
  `export PATH=` / 包内 `bin/<平台>/`。非 DSH 宿主兼容章节必须用
  `<!-- crwu-cli-guard:legacy-compat-start/end -->` 包起来，且**自动审核主路径不得引用兼容层**。
- `npm run pack:assert:strict`：真实 tarball 里两个平台六个二进制 + `bin/manifest.json`，逐个重算哈希。

### 12.4 vendored 兼容边界（不许含糊）

`skills/dws/**` 是上游 `dingtalk-workspace-cli` 的**原样正文**，本次改造**没有**改它：
它的 `dws …` 命令是给非 DSH 宿主与人工用的，内容一致性由 `npm run dws:check` 按 provenance 守。
所以正确的说法是：**CRWU 自研自动审核链路不依赖 PATH；vendored DWS 技能仍是命令行兼容层。**
不要对外说「整个插件摆脱了 PATH」—— 那不是事实。

## 13. Windows 适配（2026-09-28）

这一节是「为什么这么写」的落点；改命令生成、本地路径、凭据权限或 CI 之前先读它。

### 13.1 三条边界各自只有一份实现

| 关注点 | 唯一实现 | 不许再出现 |
| --- | --- | --- |
| 命令方言（引用、命令位置、建目录/删除/打开/剪贴板/主目录探测/权限命令） | `src/host/platform/shell.ts` | `cmd /c …`、`SilentlyContinue`、`Start-Process`、`New-Item`/`Remove-Item`、`mkdir -p`、`rm -f`、`chmod`、`xdg-open`/`pbcopy`/`xclip`、旧 `quoteArg`（静态门禁逐条钉住） |
| 本地展示路径 | `src/shared/utils/local-path.ts` | `split('/')`、`+ '/'`、`replace(/[\\/]+$/,'')`、`startsWith(parent + '/')` |
| 凭据文件权限结论 | `src/host/platform/credential-permission.ts` | 任何形式的 `chmodOk: boolean` |

`platform` 一律**由调用方注入**（`world.platform()` / 操作参数）：业务函数里回退 `process.platform`
会让单测与真实运行使用不同方言，Windows 分支永远测不到 —— 静态门禁会红。

### 13.2 平台事实从哪来

- 插件**进程所在机器**的下标事实决定随包二进制与方言（`platform/detect.ts`）。
- shell 可能在别的执行世界（SSH / 容器）里跑 —— 那时自带二进制用不上，只能回退到那台机器的
  PATH，而**审核链路不这么干**（它是结构化 Tool + 包内绝对路径）。这一段差异写在
  `platform/bin-dir.ts` 头部。

### 13.3 CI 的三个 Windows 面

| job | 在验什么 | 为什么不能省 |
| --- | --- | --- |
| `plugin` 矩阵（`windows-latest`，job 级 `shell: bash`） | 跨平台单元/集成测试（含 `npm pack` + `install` 回归） | 覆盖依赖安装与打包形状 |
| `windows-powershell`（不设 `shell:`，runner 默认 pwsh） | 静态门禁 + 方言表格 + `tests/windows/powershell-contract.test.mjs`（把生成的命令真的交给 `pwsh -Command`）+ build/smoke + 全量 `npm test` | Git Bash 验证的是 bash 的解析，**不是 DSH 在 Windows 上的语义** |
| `release.yml` 的 `windows-binary-smoke` | 发布二进制在 Windows 上真的启动一次 + `win32-arm64` 明确被拒 | 哈希一致只证明「文件没变」，不证明「能跑」 |

`npm run compat:dsh`（CI 里在 plugin 矩阵的 Node 22 上跑）覆盖的是**安装期**的兼容判定，
与上面三个面互补：它回答「DSH 会不会加载这个包」。

### 13.4 人工验收

机器能验的部分全在 CI；「干净 Windows 用户配置装插件 → 选工作空间 → 建案例 → 跑审核 → 回传」
只能在真实 Windows 上做，清单与脱敏日志模板见
[`windows-acceptance.md`](windows-acceptance.md)。

## 14. 内置浏览器登录（钉钉 / 氚云，2026-09-29 调研定稿）

> ⚠️ **本节已被 2026-09-30 口径取代（协议 22）**：用户明确 DSH **不再提供**氚云内置浏览器扫码登录、
> 也不提供钉钉设备码登录。`browser-session-bind` / `dws-login-start` / `dws-login-status` 三条操作、
> 客户端 `H3yunBrowserLogin` / `DwsLoginCard` / `login-browser.ts` / `open-url.ts` 全部删除；
> 账号连接只读取、检查已有凭据，登录由**本机 CLI 打开系统浏览器**完成。
> 下面这一段作为**历史调研记录**保留（它解释了当年为什么这么设计、以及那些真实报错长什么样），
> 但**不得**据此恢复任何内置登录入口或设备码流程。取代后的口径见插件 `AGENTS.md` §4.6 / §4.8。

背景：Windows 上 `crwu h3yun session login` 要自己拉起一个带 CDP 的 Chromium，机器策略与 ACL 会拒它
（真实报错见 `src/host/system/auth-scratch.ts` 顶部）。目标是两个登录都改走 **DSH 桌面内置浏览器**，
并回答「员工扫码后凭证存到哪里」。

### 14.1 DSH 侧只有三条入口，能力边界完全不同

| 入口 | 是什么 | 插件能拿到什么 | 用在哪 |
| --- | --- | --- | --- |
| `ctx.sidebarRight.openTab('browser', { params: { url } })` | 右侧栏浏览器标签（Desktop = Electron `<webview>`；Web = 沙箱 iframe，且 Web profile 默认关闭） | 只能「开给人看」。**没有**读页面 / 执行 JS / 读 Cookie / 导航完成事件的接口 | 钉钉登录：把授权 URL 打开给人完成 |
| 客户端 `window.open(url)` | Desktop 由主进程 `setWindowOpenHandler` 转 `shell.openExternal` → 系统默认浏览器 | 同上（开完插件一无所知） | 兜底：内置浏览器不可用时 |
| `globalThis.dshDesktop.browser` | Desktop preload 暴露的 lease 桥：`acquire(workspace)` → `{ lease, partition }`、`release(lease)`、`onOpenRequested(lease, cb)` | **可以自建 `<webview>`**（主进程只认 `src="about:blank#<lease>"` + 匹配 partition，并会重写 webPreferences），从而用 webview 自己的 `executeJavaScript` 读页面 | 氚云登录：必须把 cookie 读出来 |

三条要点，缺一条就会静默失败：

1. 第三条是 **DSH 桌面壳的内部契约**（0.2.0-rc.2 实测形态），不是公开插件 API。必须 feature-detect
   （`dshDesktop?.browser` 存在才走），拿不到就整体降级到 `window.open`，不许假设它在。
2. 每个 lease **只能 attach 一次**；必须先在 `about:blank#<lease>` 上 `dom-ready` 再导航，
   否则主进程会把 guest 关掉（`did-attach-webview` → `dom-ready` 校验 URL）。
3. guest 的权限 / 下载 / 原生弹窗一律被拒；页面的 `window.open` 会以 `onOpenRequested` 事件回到插件
   —— 不接管就等于丢弹窗。

### 14.2 氚云：二维码必须由「接回调的那个浏览器」显示

只读 GET 实测（2026-09-29，均为氚云登录页自己的接口）：

- `/v1/login/dingtalk/scanurl` 返回一个钉钉 `sns_authorize` 授权地址：**H3Yun 自己的钉钉应用** +
  `redirect_uri=https://www.h3yun.com/entry/login/corp`。
- 扫码确认发生在**手机端**，`code` 被送到那个 `redirect_uri` —— 也就是**显示二维码的那个浏览器**。
  所以「服务端镜像扫码、直接拿会话」不可行（与 `docs/v0.0.1/design-h3yun-auth.md` 的结论一致）：
  **必须有浏览器，但可以是内置浏览器。**
- `/v1/login/dingtalk/scan?code=<临时授权码>` 是换取会话的接口：喂 dummy code 得到业务错误
  （「不存在的临时授权码」），说明它**不依赖任何浏览器 cookie / state**，可以脱离浏览器调用。

### 14.3 凭证落点（唯一答案）

| 登录 | 谁写 | 写到哪里 | 插件角色 |
| --- | --- | --- | --- |
| 钉钉 | `dws auth login` 自己 | `~/.dws` + OS 凭据存储 | 只给 URL / 看状态，**全程不接触凭证** |
| 氚云 | `crwu h3yun session bind` | OS 凭据存储（service `crwu-h3yun` / account `current`） | 只在内存里过一手并立刻交出去；不落盘、不回显、不进日志/诊断/对话 |

- **插件绝不代写 keyring**：那要复刻 `go-keyring` 的编码约定，并破坏 `internal/platform/h3yuncreds`
  这条唯一 seam（根 `AGENTS.md` 的凭据口径）。
- `bind` 目前只能 `--token <jwt>`，JWT 会出现在进程命令行（本机 `ps` 可见）。建议给它加
  `--token-stdin`（Broker 已支持 `stdinText`），插件走 stdin，命令行保持干净。
- 绑定成功后**续期免浏览器**：`session refresh` + CLI 中间件在剩余 ≤36h 时静默续期。

### 14.4 氚云凭证回传通道：主 / 备 / 兜底

| 优先级 | 通道 | 依赖 | 定稿依据 |
| --- | --- | --- | --- |
| 主 | 面板内嵌 lease 浏览器打开氚云登录页 → 轮询 `document.cookie` 的 `h3_token` → `crwu h3yun session bind` | 桌面内部桥 | 氚云**自己的代码**：登录成功处理用 `CookieStorage.set(ACCESS_TOKEN_KEY, token, 48)` 写 cookie（登录 chunk），请求拦截器又用 `CookieStorage.get(ACCESS_TOKEN_KEY)` 拼 `Authorization: Bearer`（app.js）→ `h3_token` **不可能是 HttpOnly**，`document.cookie` 一定读得到 |
| 备 | 监听 webview 导航抓到 `?code=` → Host 调 `/v1/login/dingtalk/scan?code=…` → `session bind` | 同一个桥 + 未公开 Web 接口 | 该接口实测无状态；对 cookie 可读性免疫。注意 code 是一次性的、页面可能先消费掉，只在主通道读不到时启用 |
| 兜底 | 现有 CLI CDP 登录 / 面板粘贴 JWT（`session bind`） | 无 | 原子能力，保留不动 |

⚠️ **「备」通道已按维护者决定（2026-09-29）取消，不要照上表去实现它。** 理由：它存在的唯一前提是
「主通道读不到 cookie」，而 E1 实测证明 `h3_token` 就是 JS 可读的 cookie（见 14.5）——前提被证伪；
再加上它依赖未公开接口、且 code 是一次性的（页面通常先消费掉），收益小于风险。
客户端**保留**对 `?code=` 回调的**观测**（`authCodeLocationOf` 只回主机与路径、不记值），
仅用于失败归因；`browser-session-bind` 只接受会话令牌，不接受 code。

### 14.5 端到端确认（E1 探针）：**已跑通（2026-09-29，桌面端 0.2.0-rc.2）**

探针**不进版本库**（放 `plugins/dsh-crwu-workbench/.cache/`，已被 `.gitignore`）：
`e1-browser-lease-probe.js`（客户端探针）+ `e1-control-server.mjs`（本地控制页）。
本机打包版在 macOS 上**没有可用的 DevTools 入口**（菜单项 `visible: false`、自动打开只对未打包的
`development` 生效、F12 不触发），所以实际跑法是：完全退出后从终端以
`--remote-debugging-port=9222` 启动，再用 CDP `Runtime.evaluate` 把探针注入主窗口。

实测结论（`__crwuE1.verdict`，用钉钉扫码一次）：

| 观测项 | 实测值 | 结论 |
| --- | --- | --- |
| `bridgePresent` / `leaseAcquired` / `attached` / `domReady` | `true` | `dshDesktop.browser` lease 桥在主窗口可用，自建 `<webview>` 能附着 |
| `executeJavaScriptWorks` | `true` | 能在 guest 里执行 JS |
| 同页标定（在 `https://www.h3yun.com` 上） | `cookie: true`、`localStorage: true` | 读取器可用（写一个普通 cookie 立刻读回） |
| `tokenReadable` / `tokenSource` / `tokenIsJwt` | `true` / `cookie` / `true` | **主通道成立**：扫码后 `h3_token` 就在 `document.cookie` 里，且是 JWT |
| `tokenExpiresAt` | 约 48 小时后 | 与前端 `CookieStorage.set(..., 48)` 的 48h 一致 |
| `sawAuthCode` / `authCodeLocation` | `true` / `www.h3yun.com/entry/login/corp` | **备通道也真实存在**：导航里确实出现带 `?code=` 的回调 |
| `popups` | `[]` | 登录流程不需要弹窗，`onOpenRequested` 不接管也不会丢东西 |
| `released` | `true` | `bridge.release(lease)` 干净销毁 guest（8 秒内确认） |

- A 段（本地控制页）那次没成：控制页服务跑在沙箱里，Electron 进程连不上它（`chrome-error://chromewebdata/`）。
  A 段要证的事已由「`executeJavaScriptWorks` + 氚云页同页标定」覆盖，**下次不要再依赖那个本地控制页**。
- 因此 §14.4 的「主」通道不再是「未确认」：**主通道已验证**，备通道也已观测到。
- **实现已落地（协议 20）**：Host 侧 `browser-session-bind`（`src/host/system/ops.ts` 的
  `bindH3yunSession` + `ops/core.ts` 的入口，操作名不许带数字，所以不叫 `h3yun-session-bind`），
  客户端侧 `features/environment/login-browser.ts`（lease + `<webview>` 驱动，DOM 与时钟注入以便单测）
  + `H3yunBrowserLogin.tsx`（环境页卡片）。令牌经 `runCrwu` 的 `stdinText` 走
  `crwu h3yun session bind --token-stdin`（CLI 侧支持见 `docs/v0.0.1/CHANGELOG.md`），**不进命令行**；
  未授权 / 无内置浏览器（Web profile）时卡片禁用并给出回退说明。

## 15. 钉钉登录的两阶段（协议 21）

`dws auth login` 默认是 OAuth loopback：**先起 127.0.0.1 监听、打印授权 URL，再等人完成授权**
（5 分钟）。旧形态是同步等它结束才把 stdout 尾巴交给界面 —— URL 到界面时用户早已不在等，
CLI 那边也超时了。所以拆成两阶段。

### 15.1 三个部件，一条路径

| 部件 | 位置 | 要点 |
| --- | --- | --- |
| 后台执行 | `src/host/shell/run.ts` 的 `startShell` + `src/host/access/broker.ts` 的 `startShell` | 用 `execute()` **但不 await `result()`**（DSH 的契约：「前台」是调用方要不要 await 结果，不是 spawn 的性质）。请求带 `onExpiry: 'none'` —— 执行器的默认死线只适合前台命令，会把一次正常等待变成超时 |
| 登录会话 | `src/host/system/ops.ts` 的 `createDwsLoginRegistry()` | 句柄**挂在会话对象上**（不许用模块级变量：第二次登录会把第一次串掉）；`start` 立刻回快照，`status` 读快照；5 分钟上限到点 `kill()` |
| 界面 | `src/client/features/environment/DwsLoginCard.tsx` | 先把**动作**摆出来（打开授权链接 / 复制设备码），再给 CLI 原文；`running` 时轮询，进入终态停止，成功**只通知一次**刷新 |

#### 打开方式：内置浏览器优先，系统浏览器兜底

授权 URL **不**用裸 `window.open`：桌面端会把它转成 `shell.openExternal` → **系统浏览器**，
员工看到窗口跳出 DSH（2026-09-29 用户当场指出"钉钉登录还是用的外置浏览器"）。
`environment/open-url.ts` 的 `openUrlWithBuiltinFirst()` 先走
`ctx.get('sidebarRight').openTab('browser', { params: { url } })`（右侧栏浏览器标签），
拿不到服务、或标签类型未启用（Web profile 默认关闭它）、或实现返回的 promise 失败时，
**才**退回 `window.open`。

为什么用 `ctx.get` 而不是 peer 依赖 + `inject`：`browser` 标签类型不是必然存在的，
把它写成硬依赖会让插件在 Web profile 上激活失败 —— 而"打不开就退回系统浏览器"才是正确降级。

解析（`parseDwsAuthorization`）是**尽力而为**：`url` 取第一个 `http(s)://…` 并去掉尾部标点，
`userCode` 认「连字符大写码」与「标签后跟码」两种写法。解析不出来不影响流程 —— `tail` 始终是原文。

### 15.2 由缺陷注入抓到的两个真问题（别再犯）

1. **`settle()` 必须先清定时器再判状态**。它会被 `done` 与轮询同时触发，早退时若不清定时器，
   轮询 interval 会永远留在事件循环里（2026-09-29 证伪时整条测试进程退不出来）。
   清理必须幂等、且不依赖 `phase`。
2. **`onDone` 要一次性**：终态可能被轮询与状态更新重复看到（替身不跑 effect 清理时更明显），
   用 ref 守卫「一次登录只刷一次环境」。

另外：**正在跑的时候再 `start` 不许起第二个进程** —— 两个 `dws` 会抢同一个 `~/.dws` 的锁，
第二个必然以 `Access is denied` 失败，而那个报错会被误读成"权限问题"。

## 16. 不再替 CLI 指定目录（2026-09-29 决定）

**决定：`dws` 的配置目录与登录的临时目录都用各自默认值，插件不再自指定。**

- `DWS_CONFIG_DIR` 这条通道**整体下掉**（`src/host/dws/config-dir.ts` 已删除，所有调用点不再传目录）；
- `TMPDIR`/`TEMP`/`TMP` 那条通道同样下掉（`src/host/system/auth-scratch.ts` 已删除；
  `runCrwu` 的 `scratchDir` 选项一并移除）；
- 登录命令因此回到 CLI 的默认形状：`crwu h3yun session login`、`dws auth login [--device]` 原样执行。

### 16.1 为什么曾经要自指定（当时的证据）

- 员工 Windows 上出现过 `mkdir C:\Users\51019\AppData\Local\crwu: Access is denied`（`crwu` 建临时
  browser profile 失败，系统 TEMP 与用户缓存目录都被拒）→ 于是把临时目录改到插件状态目录；
- 钉钉出现 `acquiring file lock: creating config dir for lock: mkdir C:\Users\51019\.dws: Access is denied`
  → 于是把 `dws` 配置目录也改到插件状态目录。

### 16.2 为什么最后全部下掉（三次对照，缺一条都会停在错误结论上）

| # | 事实 | 来源 |
| --- | --- | --- |
| 1 | 同一个用户、同一个 `dws.exe`，**在自己的 PowerShell 里**能建 `~/.dws`、能打印授权链接 | 员工实测 |
| 2 | 把配置目录换到插件树（`~/.dsh/crwu-workbench/dws-home`）后，`dws` **仍然**建不出目录 | 员工实测 |
| 3 | 手工把该目录预建好，`dws` **仍然**打不开里面的 `.data.lock` | 员工实测 |
| 4 | **以管理员身份运行 DSH** 后一次通过；再用普通权限重启，**已存在的锁也照样打不开** | 员工实测 |
| 5 | DSH 的子进程（PowerShell）能在同一棵树里建目录（`auth-tmp` 就是它建的），而 `dws.exe` 不能 | 员工实测 |

结论：**拦的是"这台机器按程序/按父进程对 `dws.exe` 的访问控制"，不是路径、不是 ACL、也不是 DSH 的文件策略**
（诊断里三种模式都已是 `danger-full-access`）。补充一条 Windows 语义，它是理解 #2/#3 的关键：
`CreateDirectory` **先查"对父目录有没有创建子项权限"，再查目标是否存在**，所以令牌没有创建权时，
**目录在不在都回 `Access is denied`**。

既然换位置不解决问题，自指定目录就只剩下代价（员工自己终端里的 `dws` 与插件用两套状态、
多组织"当前组织"可能要各选一次），因此**整体下掉**。

### 16.3 现在的口径（三条，别再走回头路）

1. **插件不自指定目录**：配置目录、临时目录都用 CLI/系统默认 —— 与员工自己终端里的用法一致，
   状态只有一处；
2. **不做探针、不做回退、不重试**：登录是有副作用的交互（可能已经开始扫码/授权），
   把第一次进程丢掉再起一个在语义上就是错的；而且只读命令（如 `auth status`）可能压根不碰锁，
   拿它当判据实测会漏判；
3. **失败就如实报告**：文案给出两条可执行路径（**以管理员身份运行 DSH 完成登录** /
   **让管理员按程序放行随插件发布的 `dws.exe`**），并写明"换目录没用""设备码不是绕过办法"。
   判据与文案在 `src/host/system/login-failure.ts`（两支：策略支 vs 机器支，见 §16.4）。

### 16.4 影响面（不止登录）

同一台机器上，凡是依赖 `dws` 的功能都需要提权或放行后才可用：
知识库下载（`crwu_audit_knowledge_materialize`）、钉钉归档与通知
（`crwu_audit_dingtalk_archive` / `notify_self`）、组织/身份解析。

### 16.5 要恢复"自指定目录"需要什么证据

只有当**目标位置确实可写、而 CLI 默认位置不可写**同时成立，并且**不依赖重试**时才值得再考虑。
本轮已经证明：在受管/受限机器上，两者往往一起被拒（#2/#3），而真正的原因是按程序拦截（#4）——
所以再次引入自指定目录之前，先把 #4 那类对照做一遍。

### 16.6 顺带确认的两件事（供后来者）

- **凭据不在配置目录里**：`dws doctor --json` 显示 `keychain: 当前平台使用本地加密凭据后端`
  （service `dws-cli`），token 存在**用户级的本地加密后端**（所以 `cmdkey /list` 看不到、
  配置目录里也只有 `.data.lock` / `logs/` / `profiles.json`）。这解释了"提权那次直接通过"：
  同一个 Windows 用户（提权只是令牌提权）都能解密凭据，缺的只是**写锁与日志的文件权限**。
- **不要就地升级随包二进制**：插件自带的 `dws` 按 `bin/manifest.json` 校验，
  在插件目录里跑 `dws upgrade` 会让自检报"插件包不完整"，且下次插件升级会覆盖回去。

## 17. 环境页的「系统故障」：**没问到 ≠ 缺失**（2026-09-29 修正）

### 17.1 现象与实测

员工 Windows 上环境页显示「发现系统故障」，但报告里其它项全绿，只有这一行空着：

```
DSH Runtime: （未设置） ·  · DSH 自带运行时（load_workspace_dependencies）
依赖包版本: （未设置）
```

同一台机器上让 DSH 的会话**带 agent** 调同一个工具，返回是完整的：

```json
{ "python": "C:\\Users\\…\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe",
  "pythonPackages": "…\\python\\Lib\\site-packages",
  "pythonDistributions": { "openpyxl": "3.1.5", "pandas": "3.0.1", "Pillow": "12.3.0", … } }
```

载荷有 Python、必需包齐全 → **运行时没缺失**，缺的是"插件在自检上下文里问不到它"。

### 17.2 根因

环境自检跑在 `host-background`，**没有会话 agent**（`env` 这条 RPC 的负载只有 `{ op, args }`，
客户端也不带 session id），而 `load_workspace_dependencies` 需要 agent 作用域。
于是解析器拿到的是工具报错，**旧实现把它一律渲染成"DSH 自带脚本运行时不可用"** ——
一条「系统归属 + 阻塞」的 issue，直接把总状态打成 `system-blocked`、把审核入口关掉。

### 17.3 修正口径

1. `PythonRuntimeView` / `RuntimeView` 增加 `unresolved`：**工具不可用 / 调用抛错 / 超时 / 工具报错**
   都标 `unresolved: true`（"没问到"）；而"工具成功返回但载荷里没有 python""路径不存在/不是文件"
   "缺必需包"仍是**真·缺失**（`unresolved: false`）；
2. `environment/state.ts`：`unresolved` 时 issue **非阻塞**（owner 仍是 system，scope 仍是 global），
   文案说明"发起审核时会以审核根会话复核，拿不到就拒绝启动"；真·缺失照旧阻塞；
3. 页面那一行用**新状态词 `unresolved`**（客户端渲染成「待复核」、语气中性），不再显示成"未配置/缺失"；
4. **真正的拦阻留在 `audit-start`**：那条本来就带审核根 agent 调 `python.check({ agent: rootAgent })`，
   拿不到就 `failed(...)` 终止审核 —— 所以放宽的是"自检的显示与总状态"，不是审核门禁。
   解析成功会进缓存，因此发起过一次审核之后，环境页那一行会变成"已就绪"。

### 17.4 根因修法（0.0.27）：自检也用**面板绑定的父会话**取 agent

只把"没问到"改成非阻塞还不够 —— 运行时**必须真的能解析出来**，否则审核仍不可用。
自检这条 RPC 没有会话上下文，但插件状态里本来就有 `bind-session` 落盘的 `parentSessionId`
（审核启动用的就是它）。所以：`environment/ops.ts` 在调 `pythonRuntime` 之前，
用 `boundParentAgent(ctx, state.parentSessionId)`（`audit/spawn.ts`，唯一实现）
取同一个 agent 传给解析器；拿不到就退回不带 agent 的调用（那种情况只报「待复核」）。

实测证据（2026-09-29 员工 Windows）：同一个工具在会话里调用返回完整载荷
（`python` + `openpyxl 3.1.5` 等），而自检上下文报错 —— 差别就是 agent 作用域。

### 17.5 这条口径的通用教训

**"我没问到"与"事实如此"必须分开**：前者只能降低确定性（未验证 / 待复核），不能升级成故障，
更不能因此关掉功能入口。原来那句"运行时不可用"是一句**比事实更强**的结论，
而它带来的后果（审核入口被关）比"显示未知"严重得多。

## 18. DSH 自带运行时**从环境自检里挪走**（2026-09-29，0.0.28）

### 18.1 结论与理由

`load_workspace_dependencies` **需要 agent 作用域**：员工在同一台机器上让 DSH 会话调它，返回完整载荷
（`python` + `openpyxl 3.1.5` 等），而环境自检跑在 `host-background`、RPC 负载里没有会话上下文，
调它就是工具报错。围绕这条我们试过两种补救，都不成立：

1. 把"没问到"当"运行时缺失" → 一条**系统归属的阻塞项** → 总状态 `system-blocked`，**审核入口被关**（0.0.26 之前）；
2. 只把它显示成「待复核」→ 状态不再撒谎，但那一行**永远解析不出来**，员工看到的是"未设置"（0.0.26/0.0.27）。

所以自 0.0.28 起：**这条检查整个移出环境自检** ——
不再调用解析器、不再有这一行、不再进必需项分母（分母 9 → **8**）、不再影响总状态。

### 18.2 留在哪里

* **`audit-start` 仍然是硬门禁**：它用**审核根 agent** 调 `python.check({ agent: rootAgent })`，
  拿不到就终止审核。所以能力上没有被放宽，只是"什么时候检查"从"切页面时"改成"真要跑审核时"。
* 失败文案分两支（`PythonRuntimeView.unresolved`）：**没能问到**（工具调用失败/超时/报错，可重试）
  与**确实缺失**（载荷没有 python / 路径不可用 / 缺必需包，只能由部署方补运行时）。
* 取 agent 的唯一实现是 `audit/spawn.ts` 的 `boundParentAgent(ctx, parentSessionId)`
  （`bind-session` 落盘的那个父会话），`audit-start` 也用它，两处口径一致。

### 18.3 删掉的东西（避免留"以后可能有用"的死代码）

`shared/types.ts` 的 `RuntimeView`、`env.runtime` 分区、`EnvironmentInput.runtime/runtimeRequired`、
`runtimeItem`、`runtime` issue、客户端三行诊断与 `unresolved` 状态词、以及对应的六条文案键。
`src/host/runtime/python.ts`（解析器）**保留** —— 它是 `audit-start` 用的。

## 19. 启动审核时的运行时门禁（0.0.29 修正）

### 19.1 症状

员工机器上发起审核后：**案例目录没被创建**、子会话里任何案例内 Tool 都被拒
（「调用者不在进行中的审核里（或本轮案例范围不完整 / 已结束）」），而能力自检显示三个二进制与
全部业务 Tool 都 available —— 即"不是能力缺口，是这轮审核根本没成立"。

### 19.2 根因

`audit-start` 在创建案例目录**之前**要解析 DSH 自带运行时，而它拿 agent 的方式是
`boundParentAgent(ctx, state.parentSessionId)`。宿主侧（`host-background`）**没有会话作用域**时这个查
询会拿到 `undefined`，于是那次工具调用必然报错 → `python.unresolved === true` →
**旧实现一律 `failed(...)` 拒绝启动** → 案例目录不建、子会话没有 scope。

### 19.3 修正口径：**「没问到」不再拒绝启动**

| 情形 | 判据 | 处置 |
| --- | --- | --- |
| 真·缺失（载荷没有 python / 路径不可用 / 缺必需包） | `ok === false && unresolved !== true` | **仍然拒绝**（fail closed）：否则子代理会退回系统解释器，结果不可信 |
| **没能问到**（工具调用失败 / 超时 / 报错） | `unresolved === true` | **放行**，并把提示词换成「由你在本会话里解析」那一段 |

放行的依据：**子会话有 agent 作用域**，它自己调一次 `load_workspace_dependencies` 就能拿到
`python` 绝对路径与已装包清单。提示词（`prompt.ts` 的 `pythonUnresolvedSection`）写死了三件事：

1. 唯一来源是那个工具的返回，绝对路径是唯一允许的解释器；
2. 仍然禁止任何解释器查找（搜索可执行文件 / 读环境变量 / 改 PATH）与裸解释器名字；
3. 取不到或缺 `openpyxl` → **立即停止**并汇报「capability gap：DSH Python 不可用」。

这不是放宽安全口径，而是把"从哪拿"交给**有能力拿到**的那一层。

### 19.4 另一个独立阻塞：`workspace-write` 下 pwsh 起不来（0xC0000142）

员工机器上 `workspace-write` 策略下本机 pwsh **每次调用都以 `0xC0000142`（STATUS_DLL_INIT_FAILED）
结束、零输出**，`danger-full-access` 下正常。这条与运行时无关，但它会**整段**打死审核链路：
审核根与子会话按设计**恒为 `workspace-write`**（`audit/policy.ts`），而材料准备（工作版重建、
隐藏区隔离、媒体导出）与交付渲染都走 shell。**这是 DSH 侧（沙箱启动器）的问题，插件不该也
不能**为了跑通而把审核改成不限沙箱 —— 那等于把"审核边界是本轮案例目录"这条安全口径拆掉。
处置：把 `0xC0000142` 的证据（策略、命令、零输出）交给 DSH 维护者排查沙箱启动器。

## 20. 配置入口收敛（2026-09-30 · 协议 22）

用户口径一次收敛三件事，实现时**每一条都有一个"看起来更省事、但会退回去"的写法**：

### 20.1 iFinD 从"必需项"改回"可选数据源"

- 清单 `ifind.required=false` ⇒ `userSetup.ifind.required=false`、**不进必需项分母**（7 项而不是 8 项）。
- issue 只有一条：`blocking:false` + `scope:'external-data'` ⇒ 总状态 `degraded`（**照常放行**），
  `global` / `auditCore` / `delivery` 都不动，只有 `capabilities.externalData` 关闭。
- ⚠️ 三个会咬人的地方：
  1. **侧栏那枚灯的判据是 `statusProceedable`，不是 `status === 'ready'`** —— 只认 `ready` 会让
     "未配置外部数据源"的部署出现「红点 + 基础环境已就绪」的自相矛盾（`envLampOf`）。
  2. **环境页顶部同理**：`ok = (ready || degraded) && proceed`，否则未配置 iFinD 时会显示
     「还需完成 0 项」。
  3. **门禁文案回到通用模板**。以前 `hasIfindBlocker` 会把它换成"请先完成 iFinD API-Key 验证"，
     现在 iFinD 不阻塞 —— 那句专门话术必须消失，否则员工会去修一个不拦人的东西。
- 旧字段与旧文案**没有**保留成"兼容分支"：`ifind-external` 这条 issue 已删（`capabilitiesOf` 改成看
  scope，而不是看第二条 issue）。

### 20.2 账号连接只读、只检查；登录走 CLI + 系统浏览器

- 删掉：`browser-session-bind`（协议 20）、`dws-login-start` / `dws-login-status`（协议 21）、
  客户端 `H3yunBrowserLogin.tsx` / `DwsLoginCard.tsx` / `login-browser.ts` / `open-url.ts`、
  `crwuOperationOf` 里的 `h3yun session bind` 映射、`dwsLogin` 的 `--device` 分支。
- 留下：`relogin`（`crwu h3yun session login`）与 `dws-login`（`dws auth login`）—— CLI 自己拉起
  **系统浏览器**；面板只触发 + 「重新检查」。
- ⚠️ 判据要**两种一起**：文件已删（`existsSync === false`）+ 面板上没有任何按钮/正文承诺
  "用设备码登录 / 在内置浏览器里扫码"。"DSH 不提供内置浏览器扫码登录"这句**免责说明**是推荐文案，
  不许被"含'内置浏览器'就报错"的粗糙断言误伤（`client-package.test.mjs` 里踩过一次）。

### 20.3 Windows：提醒"以管理员身份运行"（2026-09-30）

钉钉 CLI（`dws`）在 Windows 上要碰 `<HOME>\.dws`：先抢 `.data.lock`，再把登录态写进操作系统凭据存储。
进程权限不足时它以"锁被占用 / 拒绝访问"结束，**表现却是钉钉登录一直不成功**（员工只会反复点登录）。

- 判据是**纯函数**：`features/environment/platform-note.ts` 的 `needsWindowsAdminReminder`
  只看 `env.platform` 的 `win32` 前缀；**拿不到平台就不提醒**（不猜）。
- 它是**非阻塞提醒**，不是门禁：钉钉登录态到底有效没有，仍由环境自检的探测结论说了算。
- 挂在**账号连接**那一步（钉钉登录态与两颗登录按钮都在那里），别处不重复；非 Windows 一个字都不提。
- 文案 `zhCN.envWindowsAdminHint` 必须同时说清两件事：**以管理员身份运行**、**是为了钉钉 CLI**。

### 20.4 插件不创建工作空间根目录

- `ensureAuditRoot` 里**没有** `mkdir`：路径为空 → 「尚未选定工作空间，请先选择一个已有目录」；
  路径不存在 / 是文件 → 「已选定的工作空间目录不存在，请重新选择一个已有目录」；两种情况都**拒绝启动**。
- 目录存在但未登记 → **只登记**（`workspaceRegistry.create` 本身要求目录已存在）。
- 客户端 `UiWorkspaceService` 不再声明 `createDirectory`，`WorkspaceCard` 把选中的路径原样使用。
- ⚠️ 允许自动创建的**只有** `<工作空间>/<流水号>` 这一级案例目录 —— 审核启动的 shell 轨迹里
  **不许**出现 `mkdir <工作空间根>`（`host-audit-lifecycle.test.mjs` 按真实 trace 断言）。
- ⚠️ `@8-5` 那类边界用例要**单独造**：`fs.stat` 回 `type:'file'`（路径存在但不是目录）与
  "路径不存在"是两种输入，夹具只准备 `dirs` 集合会漏掉前者。

### 20.5 外部数据源（iFinD）**和别的配置项并排**放在步骤里，而且排在最后

用户口径（2026-09-30，返工两次）：**外部数据核查放到环境信息里面去，不要单拆一个目录**；
**「同花顺这里直接显示未配置就可以」**；**「把同花顺放到最后一个」**。

- 它是 `SETUP_STEP_IDS` 里的**最后一步**（`accounts → oss → workspace → ifind`）：那一步的正文就是
  `IfindAuthCard`，**不另起一块**（用户口径：单开一块/一页会让页面很乱；可选能力也不该挤在必检项中间）。
- **未配置时直接显示「未配置」**：芯片一律琥珀（`toneOfOptionalItem` / `ifindStateTone` 只回
  `ok` / `busy`，红 = "必须处理"），能力清单等已配置后再显示 —— 一开始不堆一屏说明。
- **必检标记只有一份判据**：`REQUIRED_SETUP_STEPS = ['accounts','oss','workspace']` →
  `SetupStepView.required` → 界面上那枚**红色星号**（`C.stepRequired`，颜色用
  `--dsw-alias-state-error-primary`，不写硬编码红）。iFinD **不带**星号。
- **可选步骤不进"还没做完"**：`pickStep` 只停在第一项未完成的**必检项**，必检项都完成时停在
  **最后一个必检项**（不是末位的可选项）；`allStepsDone` 只统计必检项 —— 否则未配置 iFinD 的部署会
  永远停在"还没做完"、默认落点还会跑到可选项上。
- **不是** `ModuleId`：`MODULE_IDS` 仍是 `eval / audit / env` 三项，`NavigateTarget` 没有 `external`，
  侧栏卡仍是三行；`EnvironmentRequirement = 'external-data'` 保留（它描述"只看外部数据"的**严格度**，
  与有没有独立页面无关）。
- ⚠️ 三次返工的教训：① 做成**第四个侧栏模块**（要搬同一份 `env.external` 事实、还读成"又一个要配置的模块"）；
  ② 做成**页级区块**（页面上下两块"配置"，很乱）；③ 放在**列表中间**且"未配置"报红（可选能力挤在必检项
  中间、还像故障）。正确形态是：**它就是配置列表里的最后一步**，必检与否用星号区分，未配置只说
  「未配置」、不报红、不堆说明。
- ⚠️ 星号计数断言要限定在**步骤导航**子树里（`data-crwu-env-stepnav`）：面板标题上还有一枚"当前这一步"
  的星号，对整棵树数数会数出 4 而不是 3。

## 21. 「授权收据读不出来」不许显示成「需要授权」（2026-09-30 · 协议 25）

**现场**：用户报「修复了 GitHub 上那个已知问题之后，Windows 上找不到氚云和钉钉的凭据了」。
「账号连接」里那两行都显示「需要授权」，而磁盘上的 `~/.dsh/crwu-workbench.json` 里躺着一份
**合法**收据（`schemaVersion: 1` + 逐字同序的五项能力）—— 也就是"授权明明成功过"。

**先纠正一条推断**（它当时看起来很顺，所以值得记下来）：这不是"读被沙箱拒了"。
DSH 的 `dsh-fs-sandbox` 只在 `writeText` / `editText` 上做可写根围栏，源码原话是

> Reads pass through untouched: every mode permits reading.

本机实测也印证：会话策略是 `workspace-write`（工作区在 `~/code/github/mungdong/crwu-ai`）时读
工作区之外的 `~/.dsh/crwu-workbench.json` 一切正常，`env.localAccess.state` 就是 `granted`。
而且 `ctx.fs` 的**读接口根本没有逐次策略参数**（只有 `writeText` / `editText` 有），所以
"读要与写对称地声明 `danger-full-access`"这句话在这里无从落地 —— 也不需要。

**真正的缺陷是"事实被折叠"**：`ConfigRead` 只有一个 `ok` 布尔，于是五种完全不同的事实
（文件不存在 / 位置不是普通文件 / 路径解析失败 / stat 或读抛错 / 内容解析不出来）在授权层眼里
长得一样，全被写成 `missing`；界面再把 `missing` 显示成「需要授权」，把员工指向"再授权一次"——
而写盘同样是读-改-写，读不出来时它**根本落不了盘**：员工于是陷在"授权成功、界面永远停在
需要授权"里，且每一步看起来都是成功的。

**改法（三层各一件事）**：
1. `state/persist.ts`：`ConfigRead` 带上 `reason`（`ok` / `absent` / `corrupt` / `no-fs` /
   `no-home` / `not-a-file` / `resolve` / `stat` / `read`）。`ok` 只回答"能不能覆盖写"
   （`corrupt` 仍然可以 —— 内容已经无可保全，必须允许重建，否则死循环），`reason` 回答
   "到底发生了什么"。
2. `access/consent.ts`：`missing` 只留给"真的没有收据"；读失败与内容损坏一律
   `unreadable` + 一句**明说"这不是「没有授权」"**的原因。授权路径在写盘前先读一次，
   读不到就 `ok:false` + `unreadable` + **一个字都不改磁盘**（不再报成"落盘失败"把人引去查磁盘空间）。
3. `environment/ops.ts` + `state.ts` + 授权卡：`unreadable` 时那两行显示「授权状态读不出来 + 原因」，
   `credentialsConsent` 归 `invalid`，issue 的 owner 归 `system`（"把这条原因发给维护者，不是重新授权"），
   授权卡不再显示"首次使用请允许一次"那段介绍。

**顺带修掉的两个"读法"陷阱**：
- `home === ''` 时先前的兜底是拼字面量 `~/.dsh/crwu-workbench.json`，而 `ctx.fs.resolve()` **不展开
  `~`** —— 它会被当成相对于会话 cwd 的 `./~/.dsh/…`：那里永远没有文件，"主目录探不到"于是伪装成
  "从没授权过"。现在直接是 `no-home`。
- `JSON.parse` 见到 UTF-8 BOM 会抛错，而在这里抛错会被折叠成"没有授权"。现在解析前先剥 BOM ——
  这一条是**防御性**的：DSH 自带的本地 fs 用 `TextDecoder`，默认就剥 BOM，但 fs 后端并不保证
  都这么做。

**这条要记住的通用口径**：**"读不出来"与"没有"是两句不同的话**。凡是把一个 `ok` 布尔喂给界面
当结论的地方，都要先问一遍"这里其实有几种事实"。

## 22. 那层「Windows 原生命令捕获」只属于受限沙箱（2026-09-30）

**现场**：用户报"同一台 Windows 上 `main` 能读到氚云与钉钉凭据，`codex/windows-pwsh-capture`
分支读不到 —— 扫了码也不行"。这条二分法把范围压到了这个分支唯一改过执行路径的地方：
`runShell` / `startShell` 的最终 seam 上加的 `capturePowerShellNativeCommand`。

**根因**：那层捕获是按**命令形状**（`& '…'`）无条件套上的，而它要解决的是**受限沙箱**下
native 子进程继承 DSH 管道句柄时的 DLL 初始化失败（0xC0000142）。但
`dsh-pwsh-sandbox` 的 `execute()` 第一句就是：

```js
if (mode === "danger-full-access") return …super.execute(spec)…
```

—— 提权调用**根本不套 restricted-token runner**，那个缺陷的前提不存在。于是所有提权命令
（`crwu h3yun session status` / `dws auth status` / `ossutil …`）都被套上了捕获，而捕获
必须经过 PowerShell 的**文本层**（`>` → `Out-File`）：

| 路径 | 字节怎么走 |
| --- | --- |
| 不套捕获（= `main`） | native 子进程**直接继承** DSH 的管道句柄 → 原始 UTF-8 字节进收集器 |
| 套捕获（= 回归） | 子进程 → 临时文件（`Out-File` 编码）→ `ReadAllBytes` → `OpenStandardOutput()` |

Windows PowerShell 5.1 的 `Out-File` 默认是 **UTF-16LE**（pwsh 7 才是 UTF-8 无 BOM），
于是 CLI 的 JSON 成了 `{\0"\0…`，插件解析失败 → 「未绑定 / 未知 / 未登录」。
**"扫码了却读不到"的症状，源头是编码，不是凭据。**

**修法**：
1. `nativeCaptureNeeded(mode)`：只有**非** `danger-full-access` 才捕获（没声明策略 = 落到执行器
   部署默认 `workspace-write`，仍要捕获）。提权调用回到 `main` 的形状。
2. 仍然使用捕获的地方（受限沙箱里的 Python）把文本层钉死：显式
   `$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'`，并在转发前把字节里的 UTF-8 BOM
   剥掉（5.1 的 `utf8` 会加 BOM，pwsh 7 不会）。
3. 补一条**非 ASCII JSON 逐字节往返**的真 shell 用例：原先那条只喂 `out` / `err` 两个纯 ASCII
   单词，用的又是 pwsh 7 —— 文本层把字节改掉它也是绿的。

### 22.1 第三层：把子代理的脚本执行收进 Host（`crwu_run_python_script`）

§22 修的是**插件自己**发起的命令；但审核技能脚本是**子代理**跑的，走的是 DSH 的
`tool-pwsh` —— 插件在 `runShell` 里的那道 seam 覆盖不到它。而两者**是同一套 Windows sandbox**
（`dsh-pwsh-sandbox` 注册为 `ctx.shell`），所以子代理自己拼 `& 'python.exe' script.py`
照样命中同一个缺陷。提示词里那份 `Invoke-DshPython` 只是"请照做"——不保证被执行，也不带
退出码、超时、清理与沙箱事实。

所以加了 Host Tool `crwu_run_python_script`（宿主操作 `python.script.run`，来源只给
`audit-tool`、**不提权**）：

- 模型只提交 `caseDir` / `script`（**案例目录内**的相对路径）/ `scriptArgs`；
  绝对路径、`..`、空串一律拒绝（`joinLocalPath` 负责平台分隔符）；
- 参数逐个作为 argv 传给 `shellInvoke`，不经过任何 shell 解析；
- 解释器来自与审核启动**同一个** `PythonRuntimeResolver`（同一份缓存），解析不到就如实回
  `capability-gap`，绝不换系统解释器；
- 命令经 `LocalAccessBroker` 走到**同一条 `ctx.shell` seam** —— 于是它自动拿到
  `windowsCaptureCommand` 那层**只在受限沙箱生效**的临时文件捕获。这就是"不提权"的用处：
  越界不需要 `danger-full-access`，而留在受限沙箱里正是那层补丁生效的前提。
- 返回里带 `exitCode` / `stdout` / `stderr` / `truncated` / `timedOut` 与
  `sandbox{requested,resolved,ran,denied,runnerFailed}`，以及本次用的 Python 路径与版本。

**这条要记住的**：**"请照做"不是契约**。凡是"必须按某个形状执行才能绕过平台缺陷"的要求，
只写在提示词里就等于没写；把它做成 Host Tool（或 Host 侧的 seam）才是可验证、可回归的形态。

**两条要记住的**：
- **受限沙箱的补丁只能装在受限沙箱这条路上**。"这个缺陷只在 A 条件下出现"必须写成代码里的
  条件，而不是写在注释里然后无条件套上去 —— 无条件套上去的代价是把 B 条件下本来正确的路径改坏。
- **凡是经过 PowerShell 文本层的转发都不是逐字节的**（编码、BOM、行尾都可能变）。要么不走文本层
  （让子进程直接继承句柄），要么显式把编码钉死并在边界上校验。

## 普通会话案例访问（2026-10-05，协议 26）

审核子会话身份用于约束工作台托管审核，不是所有业务工具的使用资格。`audit/case-access.ts` 是案例工具的统一入口：已知托管 child 只能走 `requireAuditScope`，包括结束、停止、scope 不完整与待接管窗口；已登记讨论使用其案例与附件白名单；普通会话无需登记，按当前工作空间下的直接案例目录校验，带 `seqNo` 的交付必须与目录一致。无调用者身份、工作空间根、嵌套替代目录及工作空间外路径均拒绝。

普通会话的氚云下载权限由员工凭据和远端服务判定；不通过伪造审核记录或复用旧 childId 放行。讨论会话记录查询改为核对登记 ObjectId。Python 解析必须传当前 Agent，避免手工新会话依赖自动审核填过的运行时缓存。复制提示词带工作空间案例路径，先刷新输入快照，再消费同一 Skill 流程。原 §讨论材料范围中“普通会话不是材料入口”的规则已由此替代。
