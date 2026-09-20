# Changelog

本仓**只有一条形态**：`src/` 是唯一源码，产物 `lib/index.js` + `lib/client.js` 按 DSH 包插件分发，
版本号用 semver（`package.json` / `VERSION` / `CHANGELOG.md` 三处一致）。

2026-09-20 收尾前本仓并存过一条**动态 Cordis 形态**（`legacy/`，在 DSH 会话里由
`cordis_define` + `cordis_run` 装配，版本号用 DSH 的 `pkg-N`）；它已在本仓收尾时删除
（见 `0.0.1` 一节），下面 `legacy · pkg-43` 及更早的记录是它的历史。

## package · 0.0.1 · 2026-09-20（首个 npm 发布）

**版本号定为 `0.0.1`**：此前 `0.1.1` / `0.1.2` 两个编号**从未发布过**，首个 npm 发布用最小
版本号；下面那两节保留为同一批工作的过程记录（不表示存在过 0.1.x 的发布）。
`ping.rev` 跟着变成 `pkg-0.0.1`。

首个发布里有什么：

- **包形态**：`src/` 是唯一源码，tsdown 分构建 `lib/index.js`（ESM，导出 `name` / `inject` /
  `apply` / `Config`）与 `lib/client.js`（`__ModuleLoader__.load({ id })`，只 require `react` 与
  `react/jsx-runtime`）；`lib/` 不入库，由 `prepare.mjs` / `prepack` 产出。
- **25 条同源操作**（冻结清单）：`ping` / `boot` / `workspace` / `workspace-auto` / `trust` /
  `bind-session` / `install-prompt` / `env` / `pending` / `crwu` / `audit-start` / `audit-stop` /
  `audit-status` / `audit-release` / `oss-index` / `oss-result` / `oss-link` / `oss-upload` /
  `oss-cred-save` / `open-path` / `clipboard` / `relogin` / `dws-login` / `session` / `oss-cred`。
- **审核子代理一律挂在审核根会话下**：`host/audit/root.ts` 在 ① 选定的工作空间里建一个顶层会话
  `审核子代理根节点 · MM-DD HH:mm`（`meta.cwd` = 工作空间、**不带** `parentAgent`、
  `workspace.attachSession`），建完跑一次 hello 预检，不通过就不落钩子、不起审核；根可用就一直
  复用，不可用才新建（旧树保留）。
- **`WORKBENCH_PROTOCOL`**：宿主产物只有重启 profile 才换、客户端刷新页面就换；协议号对不上时
  界面明确说「宿主插件是旧构建，请重启 web profile」并拦住派发。
- **① 案例根目录三条硬规则**：整份持久化（path / title / id / source）、选过的目录不在了**报错
  而不静默回落**清单偏好、绝不采用父会话 cwd；配置读失败时放弃本次写入。
- **界面**：右上角环境指示灯（绿=就绪 / 红=未通过 + 悬停文案）、自检通过直接进报告审核、
  不通过用 loading 拦住；报告表固定列宽 + 风险等级列 + 窄列不换行；「审核信息」右侧抽屉；
  翻页与重新自检的加载态。
- **「查看会话」的两个根因**：可选客户端服务改为现读（不再在 `apply()` 里快照）、目标改为
  「被点那一行」的 key；另加 `uiWorkspace.openSession` 兜底路径，两条都缺才说「服务不可用」。
- **删掉「只释放占用（不停子会话）」按钮**（用户要求）：它会解开占用锁而子会话继续跑，正是
  「两条子会话往同一个案例目录对写」那条闸门要拦的状态；宿主侧 `audit-release` 保留为 host-only。
- **交付与门禁**：`install/browser-check.mjs`（47 条真实浏览器断言，且全程不点「AI 审核」）、
  `scripts/`（prepare / assert-pack / smoke-built / sync-version）、CI（Ubuntu + Windows ×
  Node 22/24）、`v*` tag → npm 发布工作流（`--provenance`）、LICENSE / SECURITY.md /
  README.en.md / `package-lock.json`。
- **文档**：`AGENTS.md` 补 §4.4.1 样式规范（CSS）与 §7.10~§7.13（审核根会话、工作空间三条硬规则、
  协议号、「查看会话」三条硬规则）；`PORTING.md` 记录 25 个操作的验证账。

## package · 0.1.2 · 2026-09-20（未发布）

**收尾完成：`legacy/` 已删除，`src/` 成为唯一源码**（第 32 轮，用户明确要求后执行）：

- 删掉动态 Cordis 形态及其配套件：`legacy/`（`host.js` / `client.js` / `REV`）、
  `install/verify.mjs` + `verify.sh`、`install/rev.mjs`、5 个 `tests/legacy-*.test.mjs`、
  `tests/helpers/legacy-client-renderer.mjs`，以及随形态一起退休的
  `tests/unit/port-coverage.test.mjs` 与 `tests/unit/verify-rules.test.mjs`。
- `package.json`：去掉 `rev:bump` / `rev:check`，`check` 收窄为
  `version:check + typecheck + test + build + smoke:built`；CI 同步删除两步 legacy 校验。
- **4 处测试原本会因为读不到 `legacy/` 而断**，各自换成不依赖 legacy 的锚点：
  安装提示词从「与 legacy 逐字比对」改为**逐条钉住 10 条规则**；
  「实现了每个 legacy handler」改为**冻结的 25 条操作清单**；
  「客户端调用的 RPC 都已登记」改为用**活门面 `OPERATION_OF`** 反查并要求 `ported.todo` 为空；
  发布链路断言去掉 `rev:check`。
- 清掉把已删文件当作依据的注释（`src/host/{shell/run,audit/prompt,audit/summary,oss/parse}.ts`、
  `src/host/environment/install-prompt.ts`、`src/shared/utils/json.ts`、`AuditInfoDrawer.tsx` 等），
  保留「不要改写措辞」这类指令本身。
- 文档改为单形态：`README.md`（§一 形态表、§二 安装、§三 配置项、§四 命令与铁律、§七 目录）、
  `README.en.md`、`AGENTS.md`（§1 / §2 / §6 / §6.1 / §6.2 / §7 / §8）、
  `install/INSTALL-PROMPT.md`（原来整篇在教装动态插件，而那个路径已不存在）。
- **明确记录一条取舍**：`lib/` 产物**不能**当动态插件交（ESM 具名导出 / ModuleLoader 工厂，都不是
  沙箱函数体；注册方式、客户端传输、React 来源也都不同）。用户确认不补第二个构建目标 ——
  只维护一条形态。接缝与代价清单留在 `PORTING.md`。
- 收尾后复跑：**`npm run check` 退出码 0、354 条测试全过、`npm run pack:assert` PASS**。

**把 25 个操作按四层过了一遍账，并补上三个可安全真机验证的操作**：

- 账目：25/25 有单元测试、24/25 有界面入口（唯一例外 `ping`，与旧形态一致）、25/25 有类型化门面方法、
  **15/25 在真实 DSH 上实跑过**。清单与「剩下 10 个为什么不跑」写进 `PORTING.md`。
- 本轮新增真机验证：`oss-link`（对真实对象签名，校验 scheme/host/路径/签名参数，且**不回显 URL 本体**）、
  `audit-stop`（无进行中审核时明确拒绝）、`audit-release`（无占用时是空操作）。
- 仍未在真机跑过的那一个关键操作是 `audit-start` —— 用户明确保留这一下；它依赖的 `subagents.start`
  请求形状改由测试对照已安装的 DSH 类型声明钉死（`tests/unit/host-audit-spawn.test.mjs`）。

**收尾（删除 `legacy/`）已在仓库副本上演练通过，并补上 CI 漏掉的两道门禁**：

- **收尾演练**：把整仓 `rsync` 到 `/tmp` 的副本上真做了一遍删除 + 改造（`.git` / `node_modules` 除外），
  结果 **`npm run check` 退出码 0、354 条测试全过、`pack:assert` PASS**。演练发现的、光看代码想不到的点
  全部写进 `PORTING.md` 的「收尾计划」：14 个待删文件；**4 处测试会因为读不到 `legacy/` 而断**
  （安装提示词的「逐字对照」、两处 handler/RPC 对账、发布链路里的 `rev:check`），各自换成了不依赖 legacy 的
  锚点（逐条钉住提示词条款、冻结的 25 条操作清单、改用活门面 `OPERATION_OF` 反查并要求 `todo` 为空）；
  以及**门禁抓不到**的 `install/INSTALL-PROMPT.md` —— 它整篇还在教人装动态插件，
  删完 legacy 后引用的路径全不存在，没有任何测试会报。
- **CI 补上两道本地有、CI 没有的门禁**：`npm run version:check`（三处版本一致）与
  `npm run pack:assert`（真实 tarball 清单 + 加载契约）。此前它们只在本地 `check` 与发布前的
  `prepublishOnly` 里跑，PR 阶段挡不住 —— `AGENTS.md` §7 那句「本地漏跑会被 CI 挡住」对这两条并不成立。
  CI 现在的步骤序列写进了 `README.md` 的门禁表。

**客户端半在真实浏览器里验通了，验收清单只剩「真点一次审核」要人参与**：

- 新增 `install/browser-check.mjs`：用**真实浏览器**（系统里的 Edge，经 `playwright-core` 的
  channel，**不下载 Chromium**）打开装了插件的页面，点进面板逐页核对第 5 / 6 / 7a 条判据。
  此前这三条只能写「需人眼」—— `smoke:built` 的替身证明不了「面板真的画出来」。
  本机实测 **22 条全过、浏览器控制台零报错**：
  - 侧栏出现「中瑞世联工作台」，点进去面板渲染出标签；
  - 环境自检页画出真实平台、四个二进制（带真实路径与版本）、氚云 `正常` / 钉钉 `已登录`、iFinD `已配置`；
  - 待审核报告页画出真实待办（`共 8608 条`、真实流水号与项目名、复核级次、行内「已停止 / 已完成·已上云」
    徽章与「查看会话 / 审核信息 / 本机 HTML」入口）；
  - AI审核结果页画出 4 个真实云端案例与其 html + json 交付件；
  - 点开「审核信息」抽屉：渲染出真实摘要（项目编号 / 引擎版本 / 阶段 / 结论 / 问题总数 13 / 复核状态 / 命中率 /
    复核计数 / 生成时间），**不再报「审核结果不是合法 JSON」**；
  - **翻页时 `pending` 真的重取、`oss-index` 次数不变**；在「待审核报告 / AI审核结果」之间来回切 3 轮，
    **`oss-index` 持续为 1** —— 「切标签 / 翻页不重复列举 OSS」这条硬要求第一次在真实界面上被验证；
  - 全程只发出 `boot env install-prompt audit-status pending oss-index`，**没有 `audit-start`**。
- 该脚本**证伪过两次**：① 拿它跑一个**没装插件**的 profile → 报出唯一一条 FAIL（侧栏入口超时）、
  跳过依赖的后续阶段、退出码 1，而不是崩掉；② 把第 26 轮那个 JSON 修复**按原样还原**（`try JSON.parse`
  → 报「不是合法 JSON」）后重跑 → 抽屉那 4 条断言全红。也就是说这一步真的在盯那个缺陷，
  不是「跑起来就算过」。脚本末尾硬断言「没有发出 audit-start」，防止日后被改成会点审核。
- README 验证清单第 5 / 6 / 7a 条改为 ✅，并补上运行浏览器核对的完整命令；
  `PORTING.md`、`AGENTS.md` §7 同步（AGENTS 里原来写「哪两条只能人工验」，现在只剩第 7b 条）。

**npm 分发路径（正式分发那一半）也实测过，并修掉一个发布目标隐患**：

- **tarball 装进干净 profile 能被 DSH 正常加载**：`npm pack` → `dsh plugin --profile tgz add <tgz>`
  → 起 profile，得到的是**拷贝**而非符号链接、无 `src/`，`lib/*` 与仓库构建逐字一致；
  `ping` / `env` / `oss-result` 全部走通，客户端产物被登记进该 profile 的 web 启动清单并被原样服务；
  随包发布的 `scripts/prepare.mjs` 在无 `src/` 时按设计跳过。此前只验过 `link:` 安装，
  而那并不是用户拿到的形态。
- **发布目标钉死官方 registry**：本机 `~/.npmrc` 指向镜像时，手工 `npm publish` 会发到镜像上，
  而 `--provenance` 在镜像上不成立（一条命令踩两个坑）。现在 `publishConfig.registry` 显式写成
  `https://registry.npmjs.org`，并与 release workflow 的 `registry-url` 互相核对（测试会比对两者）。
  装依赖仍走本机镜像，不受影响。
- **`npm publish --dry-run` 现在能整条跑通**：它会让 `npm run check` 里的「真跑 `npm pack` +
  `npm install`」回归测试一起变成 dry-run，于是 `npm pack` 不产出 tarball、门禁因为与被测行为无关的
  原因变红。已在该测试里显式清掉继承来的 `npm_config_dry_run`（改回必红，已证伪）。
- **补上唯一不能真机实测那条调用链的测试**：`startChild`（发起审核子会话）过去**一条测试都没有** ——
  而它恰恰是真验证的盲区（真发一次就是在一个真实案例上跑真实审核）。新增 8 条断言，
  逐个字段对照已安装的 `@deepseek-ai/dsh-subagent` / `dsh-llm` 类型声明：
  `start(name, { label, prompt: [{type:'text',text}], parent, signal })`，其中
  **`handle.abort` 必须打在交给 DSH 的那个 signal 上**（停止 one-shot 审核靠它，打错控制器等于没取消）。
  除一条运行时与 `pickProvider` 重复、仅用于类型收窄的守卫外，其余断言均已逐条证伪。

**首次在真实 DSH 上装载验证，并修掉验证暴露的一处误报**（记录见 `README.md` 的验证清单）：

- 装进独立 `smoke` profile 后逐项实测：`ping` / `boot` / `env` / `pending` / `audit-status` 全部
  走通真实服务（真实平台识别、真实二进制路径、氚云会话正常、钉钉已登录、OSS AK 可列 bucket、
  真实待办 8608 条）；客户端产物被 DSH 登记进 web 启动清单并原样服务（与 `lib/client.js` 逐字一致）。
- **修掉「把执行失败说成未安装」的误报**：沙箱后端不可用时（本机 `sandbox-exec: sandbox_apply:
  Operation not permitted`）所有 shell 调用直接失败，旧实现丢弃了这个失败，于是环境自检对一台装好了
  Node / Python / dws 的机器报「未安装」，OSS 报「ossutil 未安装」—— 把人送去装已经装好的东西。
  现在分辨「命令根本没执行」（DSH 契约里 `run` 只为基础设施故障 reject）与「执行了但结果如此」：
  二进制报 `无法探测：<原因>`、服务报 `探测失败`、OSS 报 `无法探测`，`resolveOssutil` 改为返回
  `{ path, error }`，6 处调用点统一给出真实原因。新增 5 条测试，并逐条证伪过（改回旧行为必红）。
- **修掉「审核信息」在读真实对象时必失败**（拿真实 OSS 对象才验出来的存量缺陷，legacy 同样中招）：
  `ossutil` v1.7.19 会把 `<n>(s) elapsed` **无条件**写到 stdout，而代码对 `ossutil cat` 的输出直接
  `JSON.parse`，于是对每一个真实对象都报「审核结果不是合法 JSON」。新增 `src/shared/utils/json.ts`
  的 `parseJsonLoose`（先严格解析，失败再扫描第一个配对完整的 JSON 文档；正确处理字符串内的括号与
  转义，垃圾输入仍返回 null），并接到所有「解析命令行 stdout」的调用点（文件、HTTP body、状态文件
  仍然严格解析）。实测：真实对象 97KB → 摘要 2716 字节，`projectId` / `schemaVersion` / `counts`
  全部正确。新增 8 条测试并逐条证伪。
- 顺手修掉换用 `parseJsonLoose` 时引入的一处回归（**由已有测试抓出**）：它返回 null 而不抛错，
  而 `loadManifest` / `loadPending` / `discoverForm` 原来靠 `catch` 判失败 —— 不改就会把坏清单当成
  「已加载」、把坏取数显示成「0 条待办」。三处改为显式判空。
- README 补上「沙箱模式」这一节：包形态用 profile 的默认模式，受限模式没有后端时必须由**用户**
  按 DSH 的提示切到 `danger-full-access`；插件不会自己去申请无沙箱执行。

**包形态完成对 `legacy/` 的功能移植**（逐项收尾报告与已知差异见 `PORTING.md`）：

- **Host 操作 24/24 落地**：shell / fs / 平台识别 / 环境自检 / 清单 / 工作空间 / 氚云记录与待办 /
  OSS 凭据·列举·签名·自动上传 / 审核生命周期（发起·停止·状态·释放）/ 系统操作 / crwu 直通。
- **Client 半按四个槽位重写**：`sidebar.panellist`、`main`、`tool.view.cordis`、
  `conversation.session.header.utilities`（最后一个此前完全缺失，导致界面**没有任何入口登记审核父级**，
  `audit-start` 从界面永远失败）；拆成 `features/workbench`、`features/environment`、
  `features/report-audit` 三块，文案集中到 `src/client/locales/zh-CN.ts`。
- **修掉 8 个「操作名对得上、链路断掉」的缺口**（逐条见 `PORTING.md`）：`slots.inject` 被多包
  `ctx.effect`（激活即抛 `Invalid effect`）、**漏订阅 `subagent/end` 与 `agent/status`**
  （「已中断」永不出现、交付件自动上云整个不触发）、`audit-start` 少「必须已选定工作空间」的门禁
  （产物写进继承的 cwd，常常是源码仓库）、`workspace-auto` 只清内存不重新采用、
  `install-prompt` 文案是手写改写版（丢掉两条安全指令）等。
- **保留 legacy 的真实结论**：审核存活判据用子 Agent 自己的 `status === 'running'`（清单里有 ≠ 还活着）、
  停 one-shot 必须「先 abort 再 dispose」、占用锁要能自愈、同源越界只有 `stripPrefix` 一处。
- **有意差异 6 条**（不是遗漏）：内置案例根不做本机绝对路径兜底、Windows 命令引用按平台选引号、
  自动上传的「还没有交付件 / 目录不可读 / 未找到 ossutil」只返回原因不写 `uploadError`（legacy 会把
  「还没有东西可传」记成上传失败并挂「上云失败」徽章）等。
- **新增「搬完了」的机器判据** `tests/unit/port-coverage.test.mjs`：legacy 每个组件、四个槽位、
  每个 `workbench:*` 调用都必须有 `src` 落点，且落点文件真实存在、映射无死行。它的每条断言都做过
  **证伪**，因此抓到两条**假通过**的断言（`includes("'sidebar.panellist'")` 会被槽位登记对象的
  `name` 字段满足；`includes('auditStart:')` 会在实现被删后仍被接口声明满足）—— 已改为解析真实调用
  实参与 `import` 真门面查 `typeof`。
- 全仓测试 **389 条**（`npm run check` 全绿：版本一致 → typecheck → test → rev:check → build →
  交付校验 → 构建产物冒烟）。
- **已完成真实 DSH 装载验证**：独立 `smoke` profile 里 Host 半逐操作实测通过、客户端产物被登记并
  被服务（详见上面第一条与 `README.md`）。剩下两条要人参与：侧栏面板的肉眼确认、以及真发起一次
  审核（会在真实案例上跑）。
- **尚未执行**（需用户明确要求）：删除 `legacy/` 与配套校验/回归、文档与 CI 改成单形态。
  用户已确认「先留一个版本再删」，所以 `legacy/` 现在保持可用。

对齐 DSH 插件生态的实际分发与门禁做法（官方 [打包与安装插件] 教程 + 社区模板
`dsh-plugin-template` / `dsh-plugin-mcp-panel`）：

- **打通 npm 发布链路**（包形态按 npm 分发，是长期维护的那一半）：去掉 `private`，加
  `publishConfig`（public + provenance）、`prepublishOnly`（先产物自检再跑门禁）、
  以及 tag 驱动的 `.github/workflows/release.yml`（断言 tag 与 `package.json`/`VERSION` 一致 →
  跑门禁与产物自检 → `npm publish --provenance`；`workflow_dispatch` 可 dry-run）。
  新增 `scripts/sync-version.mjs`（`version:set` / `version:check`）与
  `scripts/assert-pack.mjs`（`pack:assert`：缺入口、误打 `tests/`/`legacy/`/`install/` 一律失败）。
- **修掉「发出去的包装不上」**（本轮实测踩出的两个坑，都是本地门禁看不出来的）：
  npm 在安装**已发布的 tarball** 时也会执行 `prepare`，而 tarball 里只有 `lib/` + 补丁 + 文档。
  `prepare: "tsdown"` 会因为找不到 tsconfig 直接失败；`prepare: "node scripts/build.mjs"`
  又因为 `scripts/` 不在 `files` 里而找不到脚本。现在构建入口是 `scripts/prepare.mjs`：
  **随包发布**、源码在就构建、源码不在（即装的是预构建产物）就跳过并打印原因；
  发布路径用 `prepack` → `build:lib --force`，源码缺失即失败，不会发出没有 `lib/` 的包。
  并加了一条**真跑 `npm pack` + `npm install` + 导入**的回归测试钉住这条路径。
- **`files` 收紧到 9 个文件**：只带 `lib/` + 补丁 + 文档；`src` / `install` / `tests` / `scripts`
  是仓库内部件，不进包（`pack:assert` 会核对真实 tarball 清单）。
- **修通包形态安装链**：加 `prepare: tsdown`（git 安装拉的是源码，没有它就装不出 `lib/`）、
  补 `engines.node`、`repository` / `bugs` / `keywords`。
- **提交 `package-lock.json`**：此前没有 lockfile，依赖不可复现，也没有 `npm ci` 可跑。
- 删除 `@deepseek-ai/dsh-client-ui-slots` 依赖：它不在 DSH 0.1.5-rc.2 的安装里，src 也不需要它的类型。
- **加 CI**（`.github/workflows/ci.yml`）：Ubuntu + Windows × Node 22/24 上跑
  `npm ci → typecheck → 交付校验 → rev:check → test → build → 断言产物`；此前门禁全靠人肉。
- **交付校验重写为 `install/verify.mjs`**，`install/verify.sh` 退化为薄包装。新增：
  语法检查、`name:` 值 ASCII 检查、客户端不得裸 `fetch` / `node:*`、文件末尾换行。
  **修掉一个静默失效的检查**：RPC 成对原来只匹配 `host.call('...')`，而客户端所有调用都经本地包装
  `call('workbench:…')`，于是它一直报告 `callers=0` 却仍然 PASS；现在按调用点解析（21 个调用者）。
  新增信息项：宿主字节上限若没有回归测试顶住会被列出（`RECORDS_STDOUT_MAX` 目前如此）；
  在 npm 包（无 `legacy/`）里运行会给出「必须在 git 克隆的仓根运行」的明确提示。
- **新增 `install/rev.mjs`**（`npm run rev:bump` / `rev:check`）：`legacy/REV` 的 sha256 / 字节数
  改为生成与校验，不再手工抄写。
- **包形态 Client 半现在有直接测试**：新增 `tests/helpers/tsx-loader.mjs`，用 `node:module` 的
  `registerHooks` 在测试进程里剥类型 + 转 JSX，并把 `react` / `react/jsx-runtime` 指向极小替身 ——
  于是 `.tsx` 能被 `node --test` 直接加载，且不引入 vitest / jsdom / react-dom。
  `tests/unit/client-package.test.mjs` 覆盖：同源 RPC 的请求契约与错误处理、槽位注册（名称/键/顺序）、
  面板在未加载 / 已加载 / 失败 / 卸载后迟到响应四种状态下的渲染、
  样式走 DSH 主题 token 而非硬编码颜色、文案必须走 locale 表。
  （此处原本写「槽位注册必须在 `ctx.effect` 内」—— 那是错的，正确结论是
  `slots.inject` **必须直接调用、不能包 `ctx.effect`**，见 `AGENTS.md` §4.1.2；测试现已反过来断言。）
- **新增 66 条包形态测试**（`tests/unit/`：交付契约 19 + 包形态 Host 31 + 包形态 Client 16）：
  交付契约的每条规则都配反向测试；Config schema 默认值与边界；同源路由的 405 / 403 / 404 / 200
  与错误信封、请求体上限；状态隔离与工作空间视图；操作表行为；`package.json` 入口 / files /
  发布配置 / peer 一致性；以及一条真跑 `npm pack` + `npm install` 的安装路径回归。
  当时全仓共 77 条（legacy 回归 11 条；移植收尾后为 368 条）。
- **修掉骨架里一处真实缺陷**：`boot` 把尚未实现的 `clipboard` 列在 `ported.done` 里，
  客户端点「复制提示词」会拿到 404；现在声明跟着实现走，并有测试防止再次漂移。
  操作表与 `ported.done/todo` 现在必须一一对应，legacy 客户端调用的每个 RPC 名都必须已登记。
- 补 `LICENSE`（内部使用）、`SECURITY.md`（插件是受信任 Host 代码、凭据位置、漏洞报告口径）、
  `README.en.md`，并把 README 的命令表、校验范围、npm 发布流程、踩坑清单更新到当前实现。
- `AGENTS.md` §6/§7/§8 更新：测试怎么摆（含 `.tsx` 怎么测）、交付契约规则的新增流程、
  门禁改为 `npm run check` + `pack:assert`、npm tag 发布流程与 DSH peer 版本对齐要求。

## package · 0.1.1 · 2026-09-20（未发布）

- 将包形态骨架拆分为 Host、Client、shared 及领域子目录，入口文件只保留 DSH 装配导出。
- 修正 Client 的 DSH ModuleLoader 包装、Host/Client 独立构建和 `lib/index.js` / `lib/client.js` 固定输出。
- 收紧 `dsh.client.inject` 与 Cordis `inject`，常量、配置、状态、HTTP 和 UI 骨架分别维护。

## legacy · pkg-43 · 2026-09-20

- 报告页增加“待审核报告 / AI审核结果”页内标签，列表直接展示氚云人工复核级次、状态和当前节点。
- 保留原 OSS 对象命名与审核报告 HTML；报告页首次进入只列举一次 OSS，检索、翻页与审核状态轮询不再重复扫 OSS，只有显式刷新或上传成功后才重新列举。
- 已审核项目增加“审核信息”入口；点击后才按精确 Key 读取一份审核结果 JSON，并以精简摘要与当前氚云复核信息并列展示。列表接口不下载逐条 JSON，也不把“氚云更新时间较晚”误称为“报告材料变化”。
- Host 对审核结果 Key 增加 Bucket 前缀和 `.json` 边界校验，限制单次读取大小，并只向 Client 返回摘要字段。
- 云端报告链接同样执行 OSS 前缀校验；对象清单只认 `审核意见.<流水号>.html` 与 `审核结果.<流水号>.json`，避免辅助文件被误当正式交付件。
- OSS 清单失败不再拖垮已成功返回的氚云列表，也不会在后续检索、翻页时自动重试；快速切换审核信息时忽略迟到的旧请求。
- 新增按需读取、完整交付件门禁、OSS 清单缓存/失败隔离、请求竞态、Key 越界拒绝与结果归一化回归测试。
- 新增根目录 `AGENTS.md`；包形态 TypeScript 按 Host / Client / shared 及领域目录拆分，常量归入各目录 `consts.ts`，并修正 Host / Client 双入口构建产物名。

## legacy · pkg-42 · 2026-09-20

- 修复审核创建期间重复点击会并发创建两个子会话的问题：Client 立即显示并禁用「创建中…」，并在创建完成前禁用其它审核入口。
- Host 增加独立的创建中门禁；并发请求在调用 `subagents.start` 前即被拒绝，成功、失败或提前返回都会自动释放门禁。
- 新增 Client 状态传递与 Host 并发请求回归测试。

## legacy · pkg-41 · 2026-09-20

- **审核只允许挂一层子代理。** `bind-session` 拒绝把子代理会话登记成审核父级并保留原来的顶层父级；
  `audit-start` 再兜一道门禁。判据是只有子代理才有的 `origin: 'subagent'` / `delegationDepth`
  （顶层会话为 `delegationDepth: 0`、无 `origin`）。
- **存活判据换成子 Agent 自己的 `AgentStatus`**（`idle` / `running`），不再依赖 `listChildren` 的 `activity`。
  `listChildren` 由会话存储驱动，跑完的一次性子会话**依然在列**，父会话一变（`state.parentSessionId`
  只是「最后看过哪个会话」）就全体查不到，界面表现为「状态跟丢」。新判据与父会话无关。
- `audit-status` 按**每条记录自己的** `parentSessionId` 聚合查询多个父会话，并对历史 depth-2 记录免疫。
- **占用锁自愈**：只要本轮真看到有子会话在 `running`，就把单条审核门禁重新挂回去。
- **「这条任务已经有了」= 带时间戳重启**：先停掉已存在的子会话（记录里的 + 清单里 label 命中同一
  流水号的），再用「重新审核」提示词重启；子会话 label 变为 `审核 <流水号> · HH:MM:SS`，记录里有
  `startedAt` 与第 N 次，界面上显示「启动 10:16:27（第 2 次）」。别的报告在跑时仍然拒绝（单条并发门禁）。

## legacy · pkg-40 · 2026-09-20

- 修 pkg-39 引入的**认领过头**缺陷：认领只收 `agentStatusOf(cid) === 'running'`。
- 认领来的记录（以及落盘时没有 `startedAt` 的记录）永远等不到 `subagent/end`，其生命周期一律以
  Agent 状态判定，一旦不再 running 就置 `ended`、按交付件定状态并释放占用 —— 据此自愈了已被
  误写进 `~/.dsh/crwu-workbench.json` 的三条记录。
- `adopted` 落盘，重启后语义不丢。

## legacy · pkg-39 · 2026-09-20

- 补回 **Client 半**：pkg-38 只带了 Host 半，导致浏览器端停在更早的 `pluginRunId` 上，
  而 `invoke()` 严格按 run 对账，于是每次 `host.call` 都返回 `stale-run` 并被面板里的
  `.catch(function () {})` 静默吞掉 —— 界面表现为「子任务在跑但什么都不显示」。
- 新增按 label「审核 <SeqNo>」认领重装前遗留的审核子会话（pkg-40 收紧了准入条件）。

## legacy · pkg-38 · 2026-09-20

- 审计记录与占用锁落盘到 `~/.dsh/crwu-workbench.json`，插件重装后自动恢复。
- 停止增加无句柄退路：直接对子 Agent 调 `cancel({ kind: 'parent' })`，与驱动 `onAbort` 同一条路径，
  所以重装前起的会话同样停得掉。

> pkg-1 … pkg-37 的历史记录在当时的 DSH 会话里（`~/.dsh/storages/session_projcache/`），
> 未逐条搬进本文件；其中 pkg-34 之后的关键节点见上。
