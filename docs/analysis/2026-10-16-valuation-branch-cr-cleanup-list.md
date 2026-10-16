# 估值分支 CR 清理清单：`feat/valuation_1012` vs `main`

> **状态：历史快照（2026-10-16）。** 本文保留当次评审的结论与证据，不代表当前实现或当前行号。
> 评审对象：`feat/valuation_1012` 工作树（含未提交改动）对比 `main`。
> 行号以 2026-10-16 当次复核时刻的工作树状态为准；评审期间该工作树仍在被并发写入。

---

## 0. 门禁现状

| 门禁 | 状态 | 说明 |
| --- | --- | --- |
| `node --test plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-knowledge-tool.test.mjs` | **红（3 条失败）** | 本次已实测。因此 `npm test` / `npm run check` / `make plugin-check` 在该树上不可能通过 |
| `go test -count=1 ./internal/...` | 绿 | 评审结论，本次未独立复核 |
| `make docs-check` | 绿（36 个入口） | 评审结论，本次未独立复核 |
| `Makefile` 的 `plugin-check` | 修复未提交 | HEAD 仍引用已删除的 `scripts/test_valuation_contracts.py` |

**核验口径**：标 ✅ 的条目由本次评审实测确认；其余条目引自评审代理结论，未独立复核，动手前请以当前工作树为准。

---

## 1. 第一档：功能实际不可用 / 交付结论是错的（12 条）

| # | 位置 | 一句话 | 核验 |
| --- | --- | --- | --- |
| 1 | `skills/.../scripts/calculate_market.py:159` | 30% 共同修正上限从未使用，20% 单项上限被套在连乘乘积上 | ✅ |
| 2 | `src/host/tools/report-evaluation/revision.ts:406` | `op=promote` 关掉冻结输入与证据截图两条门禁 | — |
| 3 | `src/host/domains/report-evaluation/scope.ts:160` | `addPlan` 无生产调用方，多方案与项目收口恒定被拒 | ✅ |
| 4 | `tests/unit/host/host-valuation-knowledge-tool.test.mjs` | 知识工具测试硬红，门禁不可能绿 | ✅ |
| 5 | `src/host/tools/report-evaluation/execution.ts:195` | `ownsTask` 归属检查 fail-open，与同门禁另一处口径相反 | — |
| 6 | `src/host/domains/report-evaluation/delivery/finalize.ts:289` | 成功分支把 problems 硬编码为空，回执自我抹掉缺失 | — |
| 7 | `src/host/config/config.ts:95` | TS 缺省复制部署配置，取值与 YAML 完全相反 | ✅ |
| 8 | `internal/platform/browser/recover.go:496` | 读页面失败被伪装成「站点拦截，改人工」 | — |
| 9 | `src/host/operations/report-evaluation/handoff.ts:270` | 创建失败一律记 `not-created`，客户端据此长出第二条父会话 | — |
| 10 | `skills/.../scripts/calculate_market.py:257` | 负条件指数算出负数交付，比值校验整段静默跳过 | — |
| 11 | `skills/.../scripts/calculate_market.py:163` | 十位取整口径既写不进 schema 也执行不了 | ✅ |
| 12 | `internal/platform/browser/process_windows.go:29` | `ps`/`tasklist` 无能力探测，三态塌缩成「端口 0」 | — |

### 1.1 共同修正上限形同虚设 ✅

`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/calculate_market.py:159`

`combined_limit` 是第 45 行 `REQUIRED_RULE_IDS` 里的快照必需项，第 159 行读出后全文件再无引用（`grep` 另一处命中是测试夹具 `test_calculate_market.py:30`）。同时第 200-206 行把 `_case_ratio` 返回的**连乘乘积**算成 `magnitude=abs(ratio-1)` 去比 `single_limit`，却记成「单项修正」。

后果：「一个因素 +45%、另一个 −24%」（乘积 1.10）能通过检查。规范的两条硬约束都没真正执行，结论与底稿合规行都是错的，且底稿里根本查不到 30% 那一条，复核者无法发现少判了一条。

### 1.2 `op=promote` 把两条门禁整体关掉

`plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/revision.ts:406`

用硬编码 `frozenInputDigest:''` 与 `screenshotRequired:false` 跑完成判定。用户在确认后改过案例目录的 `估值输入.json`，或知识要求 `browser.page.screenshot` 而一条截图证据都没有时，模型调用 `crwu_valuation_revision {op:'promote', revision:2}`：`finalizePlan` 因 frozen 是空串跳过冻结摘要比对，`evidence.required=false` 让截图校验恒通过，返回 `status='completed'` 且 problems 被清空。

同一份 `修订/2/` 交付件走 `crwu_valuation_finalize`（真实摘要 + 真实截图要求）却是 `failed`/`partial`——同批交付件两条入口给出相反结论。

### 1.3 `addPlan` 无生产调用方，多方案链恒定被拒 ✅

`plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/scope.ts:160`

`grep addPlan` 只命中自身实现与 `tests/unit/host/host-valuation-ops.test.mjs:604/607`（直接调用）；`handoff.ts:326` 与 `:383` 都以 `planIds: []` 交接，注释说「方案由 `crwu_valuation_project_prepare` 登记」却无人登记。

于是：

- `crwu_valuation_execution_dispatch` 在 `execution.ts:258` 把每个任务判成 foreign，恒定返回 policy 失败；
- `finalize target=project` 在 `finalize.ts:278` 用 `registered=[]` 逐项比对，恒定报「方案不在本轮登记范围」；
- `knowledge.ts:424` / `template.ts:213` 同样一律拒绝。

测试用 `openProject(scopes)` 直接塞 `planIds`，所以门禁全绿而功能不可用；错误话术还把缺陷伪装成权限问题。

### 1.4 知识工具测试硬红 ✅

`plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-knowledge-tool.test.mjs`

本次实测 3 条失败：`重复取同一已物化 wikiPath`、`没有结构化规则段`、`模板先物化、知识后物化`。前两条断言 `exportCount == 1`（报告指 `:827` 与 `:876`，本次确认 `:876`），而计数辅助只匹配命令里的 `'+export'`，源码已改走 `drive +download`：`channelFor('md')` 得 `'download'`（`src/host/integrations/dws/knowledge-tree.ts:112`），`knowledge.ts:519` 发的正是 download 命令，实测恒为 0。第三条 `:1034` 报「既有知识索引摘要与条目不一致」。

根因在测试自身，但在修复前，任何「门禁全绿」的交付声明都不成立。

### 1.5 `ownsTask` 归属检查 fail-open

`plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/execution.ts:195`

`scope.planIds` 不是数组时直接 `return true`，与 `scope.ts`「方案归属未登记一律 false」的 fail-closed 口径写反。缺 `planIds` 字段的 v1 形状夹具或旧恢复记录下，任意方案子会话提交别的方案的 `taskIds` 都会通过归属检查：协调器照常 `leases.acquire` 并启动执行者，两个执行者写同一个方案目录，而门禁一个字都不报。

`knowledge.ts:424` / `template.ts:213` 用的是 `Array.isArray(ownedPlans)` 的 fail-closed 写法——同一门禁在同一分支里有两种相反语义。

### 1.6 `finalizePlan` 成功分支吞掉 problems

`plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/delivery/finalize.ts:289`

`facts.inputDigest.frozen` 为空串时 `:163-164` 推入「拿不到冻结输入摘要：无法证明本轮算的是确认时那一份资料」；其余项全绿则 `:284-289` 返回 `status:'completed', problems: []`。而 `revision.ts:413` 正是拿 `receipt.problems.length > 0` 当拒绝条件——这次缺失被回执自己抹掉，completed 回执与 problems 列表不再能与本次真实校验项对账。

### 1.7 TS 缺省把部署配置复制进源码，且与 YAML 相反 ✅

`plugins/dsh-crwu-workbench/src/host/config/config.ts:95`

新增的 `DEFAULT_VALUATION_BROWSER` = `requiredSiteIds:['lianjia']` / `optionalSiteIds:[]`，而 `config/crwu-workbench.yml:26` 是 `requiredSiteIds: []`，且该 YAML 注释明写「留空 = **没有必需来源**（不再回退成"全部必需"）」。

违反 `plugins/AGENTS.md`「`config/crwu-workbench.yml` 是部署配置唯一来源，不得在 TypeScript 缺省里复制可配置行为」。该缺省经 `yaml.ts:187`（YAML 缺该节时用它）与 `sites.ts:210`（`config.valuation?.browser ?? DEFAULT_VALUATION_BROWSER`）真实生效，且无任何测试覆盖回退路径：沿用旧 YAML 或缺节的部署会把链家静默算成必需来源、可选来源清空，页面 gate 与交给父会话的「来源策略与原因」按错误分类计算——正好退回该 YAML 注释宣告已废除的「全部必需」口径，而两边看起来都在正常运行。

### 1.8 读页面失败被伪装成「站点拦截」

`internal/platform/browser/recover.go:496`

`client.Facts` 出错时 `:492-497` 直接映射成 `VerdictBlocked`，`facts` 保持零值；`:500` 的 `ChallengeFamilyOfPage` 在 probe 未命中、verdict 非 LoginWall、`IsChallengePage('','')` 为假时落到 `ChallengeBlocked`，`:539-543` 返回 waiting-user +「站点返回了访问拦截：这不是滑块挑战，请稍后重试或改用人工作业」，`pageValidationOf` 同时拿到 `FinalURL=''`、`Readable=false`。

一次瞬时的 CDP 读取失败因此被写成「站点封了我们、改人工」的业务结论。同类失败在 `probeErr` 分支（`:488-493`）是如实报 `probe-unavailable` 的。

### 1.9 `not-created` 语义错误 → 长出第二条父会话

`plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/handoff.ts:270`

`create.ts:79` 调 `controller.create()`（DSH 已返回活会话 id），随后在 `:96`（session-cwd-mismatch）/ `:103`（session-attach-failed）/ `:110`（session-membership-missing）/ `:137`（session-agent-missing）失败并 `workspaceFailure(reason, detail)`；`errors.ts:39-48` 的返回里**没有 sessionId 字段**，`handoff.ts:491` 的包装把它塌成 `{ok:false, sessionId:''}`，`:270` 于是硬编码 `'not-created'`（注释「连"建到一半"的证据都没有」——空 id 只是没传出来，不是没建）。

客户端按契约把 `not-created` 当作「可以安全重来」：`valuation-state.ts:471 canReturnToDraft`、`:476 valuationHandoffRetryCreate`、`ReportEvaluationPane.tsx:95`。一次成员清单回读抖动就会让面板给出「返回修改」，重试再建第二条父会话，而第一条仍在运行、永远收不到修正后的提示词。

### 1.10 负条件指数 → 负数进入交付

`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/calculate_market.py:257`

`:140-144` 只禁止 `caseIndex` 为 0，不禁止负值；`:195-199` 只对成交单价做 `price<=0` 报错。一条 `caseIndex` 为负的案例会得到负的 `comparableUnitPrice`，进入 `:256` 的 `prices` 后被 `:257` 的 `if min(prices) > 0 else None` 判成 `None`，`:258` 起整段 price-ratio 检查被**跳过**——`ruleChecks` 里连一条「未判定」都不留；`:265-266` 还会把负数平均进 `unitPrice`/`totalValue` 交付出去，而 `:267` 的注释把 `combinedRatio` 说成「仅作过程展示」，掩盖了它是唯一能看出异常的字段。

### 1.11 十位/百位取整口径既写不进也执行不了 ✅

`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/calculate_market.py:163`

- 声明侧被限死：`schemas/rule-parameters.schema.json:58` 是 `"digits": {"minimum": 0, "maximum": 8}`（`required: ["mode","digits"]`），`src/host/domains/report-evaluation/knowledge/rules.ts:248` 同样 `<0 || >8` 即拒。
- 要求侧却是十位：`references/06-workbook-contract.md:221` 与 `SKILL.md:217` 写「`comparable_unit_price` … 保留到十位（Excel 口径）」= `digits:-1`。
- 执行侧缺省 `digits:0`：`:163` 的 `or {"mode":"half-up","digits":0}`。

底稿表算的是 `ROUND(…,-1)`，脚本算的是 `ROUND(…,0)`，交付时底稿与 JSON 对不上而两边都不报错。

### 1.12 `ps`/`tasklist` 无能力探测，三态塌缩

`internal/platform/browser/process_windows.go:29`

`process_unix.go:22` 与 `process_windows.go:22` 直接 `exec ps` / `tasklist`；唯一调用方 `acquire.go:114-117` 把 `err` 吞成 `return 0`，既无运行记录也无三态区分（全局规范 §3.6 规则 1、2）。

Windows 上 `processCommandLine` 对活着的进程返回 `"", nil`，第三个端口发现来源等于失效：profile 被占用时会按 `acquire.go:58-66` 记录的那次事故形态再走一遍（新实例起不来、端口不开、20 秒超时），员工拿到的是超时而不是「进程探测不可用」。两个实现都没有测试。

---

## 2. 第二档：死代码 / 未被任何路径使用的文档

### 2.1 Skill 目录

- **`scripts/market_rules.py` 整个原语库无生产调用** ✅ —— `calculate_market.py:38` 的 `import market_rules  # noqa: E402` 之后全文没有一次 `market_rules.` 解引用（实测 `grep` 只命中注释与 import 行），10 个函数仅被 `test_market_rules.py` 调用；而 `SKILL.md:210-218` 却把它写成「用它的原语算」的指定算法，示例还是 float 语义，与生产路径的 `Decimal` 不同。同时 `market_rules.py:4` 与 `:23` 把 **已在本分支删除**的 `references/02-market-method.md` 第 9 节声明为 20%/30%/1.2 三条阈值的唯一出处——Skill 目录被单独拷进 agent skills root 后，阈值的依据与算法入口都指不到实处。
- **3 份 schema 从任何代码路径都不会被打开** —— 6 份里 `knowledge-source` / `rule-parameters` / `screenshot-manifest` 只作为注释里的名字存在（`knowledge.ts:57`、`snapshot.ts:16/161`、`route.ts:66`、`rules.ts:4`、`screenshot.ts:28`）；对应测试是照手写 key 清单断言（`host-valuation-knowledge.test.mjs:734` 起），所以这 3 份可以任意漂移而不被门禁发现。
- **`scripts/test_report_render.py:163/165`** —— fixture 仍指向已删除的 `template/valuation-workbook.xlsx`（字符串惰性，测试不红）。
- **`assets/README.md:10-11`** —— 声称 `build_report.py` 读取并内联 assets，实际只用于 `template/valuation-report.html` 与案例目录截图。

### 2.2 Workbench 死代码

- **`src/client/modules/report-evaluation/ui/SingleSelect.tsx` 是死组件** ✅ —— `grep -rn SingleSelect src/` 只返回自身与 `styles/pane.ts:42/:315` 的两处注释。真实渲染路径是 `ui/components/Select.tsx`（`ValuationIntakePane.tsx:539/572`），其 `registryKeyOf=instanceId`、`idPrefix 'crwu-ui-select-'`；而 SingleSelect 是 `registryKeyOf=props.name`、`'crwu-valuation-'`。于是 449 行的 `tests/unit/client/client-valuation-select.test.mjs`（含 `:220` 的 `'<id> crwu-valuation-method-value'` 断言）全部在测一个不渲染的组件。
- **`src/client/ui/icons.tsx:199`** —— 11 个 src 内零引用导出：`CopyIcon`、`DocSparkIcon`、`Section`、`childIdsOf`、`freezeScope`、`accountStates`、`deliveryStates`、`ifindStatusOf`、`buildContextNotice`、`isStamp`、`freshnessLabel`，每个名字全仓仅 1 次命中（声明行）。
- **`src/host/core/workspace-session/`** —— `create.ts:81` 入参 `sessionId` 三个调用方都不传，`mintSessionId` 在 `src/` 里已无生产者；`resolve.ts:102` 注释承诺「两条都要比」（规范键 + 字面）但只实现了规范键一条；`create.ts:109` 用正则匹配 `verify.ts:89` 的中文用户话术来判定失败原因，改一句文案就会把 membership-missing 归类成 cwd-mismatch。
- **`src/host/tools/report-evaluation/recalculate.ts:237`** —— 底稿存在性检查是只有注释的空 if，分支体不做任何事。
- **`src/host/domains/report-evaluation/execution/leases.ts:172`** —— 文件头声明为唯一归属判据的 `belongsToPlan` 无任何生产调用方，跨方案写入保护不在任何地方生效。
- **`internal/platform/browser/recover.go`** —— `:395` 导出函数 `DetectChallenge` 零调用方，且用 widget 级 `ChallengeFamilyOf`，对真实站点自建验证码页会返回 `ChallengeNone`；`:673` 的 `scriptTimeout` 在函数体内从未引用（只在 `:421/:484/:600` 出现），`--script-timeout-ms` 对拖拽重放无效。

### 2.3 重复 / 漂移的类型与常量

- `src/shared/contracts/report-evaluation.ts:253` —— `ArchivedMaterialView` 逐字重复 `ArchivedMaterial`（`valuation-project.ts:128`）的 10 个字段而非 extend；同一字段表又被 `intake/metadata.ts:21` 与 `client/modules/report-evaluation/controller.ts:334 previewViewOf` 手工复制到第三、第四份。新增一个冻结输入字段时四处都编译得过，确认抽屉静默不显示。
- `src/shared/wire/report-evaluation.ts:78` —— `VALUATION_ASSET_TYPES: readonly string[]` 是 host `ASSET_TYPES` 的手抄重复，注解被放宽导致 wire 层的编译期对账失效，且全仓零消费者。
- `src/host/domains/report-evaluation/intake/preview.ts:346` —— host 仍用自己的 `SUPPLEMENTAL_PROMPT_MAX_LENGTH`，而共享常量 `VALUATION_PROMPT_MAX_LENGTH`（`src/shared/consts.ts:320`，注释明说为避免两边漂移）只被 client 用；改任一侧都不会红。
- `src/client/modules/report-audit/api.ts:275` —— 保存的 8 个估值操作只为 frozen-inventory 名字对账而留，参数形状已漂移：`valuationIntake` 缺 `assetType`/`purpose`/`valueType`（真实入口 `report-evaluation/api.ts:31-44` 里 `assetType` 必填），`valuationBrowserPreflight(options?: { openLogin })` 与真实的零参调用不符。
- `src/client/modules/local-audit/consts.ts:4` —— 12 处 `features/` 旧路径绕过 `tests/unit/client/host-module-layout.test.mjs:208` 的守卫（守卫只匹配带 `client/` 前缀的写法）：`consts.ts:4/6`、`shell/modules.ts:12`、`environment/model/platform-note.ts:16`、`report-audit/api.ts:27/234/394` 及 6 个测试文件。
- 样式死代码 —— `src/client/styles/base.ts:45` 的 `.crwu-audit-header` 被 `shell/styles/layout.ts:22` 完整遮蔽；`src/client/modules/report-audit/styles/pane.ts:56` 与 `:103` 同文件重复 `.crwu-audit-td-nowrap`；`src/client/styles/tokens.ts:113/115/119` 的 `--crwu-valuation-field-border[-hover]`、`--crwu-valuation-inset`、`--crwu-space-8` 无消费者却被 `client-valuation-scope.test.mjs:785-787` 钉死。
- 协议 32「只发 workspaceId」规则 —— `src/client/core/workspace-session.ts`（工作树已删）留下的规则现在内联两处（`report-audit/session/assistant-session.ts:291`、`local-audit/session/session.ts:124`），无单一实现可对齐。

### 2.4 Go 侧其它

- `internal/platform/browser/cdp.go:86` —— 取消看门狗在 stop/done 同时就绪时随机选中，会关掉仍可用的 websocket，之后该 `Client` 的每次 CDP 调用都失败（`action.go:211-214` 同形）。
- `internal/platform/browser/acquire.go:240` —— `Release` 丢弃 `Browser.close` 的错误后即返回成功，不 Kill/Wait，close 失败即泄漏进程与 profile 锁。
- `internal/transport/cli/browser.go:771`、`:778` —— 附加既有浏览器时 `Target.createTarget` 的 `_, _ =`，`crwu browser login` 会先报成功再等满 `--timeout`。
- `internal/platform/browser/recover.go:527` 起 —— site-challenge-page / login-wall / blocked / geetest-v3-dom / not-original-page 这些终态都不写 `AfterKind`，回执 `afterKind` 恒为空串。

### 2.5 文档生命周期

- **`plugins/dsh-crwu-workbench/CHANGELOG.md` 版本记录有洞** ✅ —— **0.0.42 有两个同名章节**（`:660` 与 `:703`；`main` 上只有 1 个，重复是本分支 `dd587e1` 引入，与 0.0.9 用「（续：…）」的既有做法不一致），且 **0.0.46 全文缺失**（0.0.47 直接跳到 0.0.45）。而 `README.md:29`、`README.en.md:34`、`docs/PRD-workbench-sidebar-modules.md:1012`、`docs/acceptance-0.0.46.md`、`tests/unit/host/host-acceptance-matrix.test.mjs:28` 都按 0.0.46 叙述行为（VERSION / package.json 已是 0.0.48）——员工按 README「0.0.46 起…」回溯改动时在发布记录里找不到该版本，验收矩阵指向一个没有 changelog 条目的版本。
- `docs/superpowers/plans/2026-10-15-valuation-knowledge-wiki-routing.md:1` —— 已被 `2026-10-15-valuation-wiki-driven-workflow.md:106` 明文「取代」，但 50 个未勾选项且无历史标记（同批 `2026-10-15-unified-workbench-ui.md` 有 `> 历史执行快照：`）。
- `docs/analysis/2026-10-14-local-audit-slow-session-review.md` 与同目录 `2026-10-14-audit-conclusion-vs-process-reconciliation.md` —— 带日期复盘无历史标记，也不在任何导航路径上。
- `plugins/dsh-crwu-workbench/docs/acceptance-0.0.42.md:77` —— 历史快照被就地改写（替换逐字引用的用例名）却未加作废标记，与本文档自称的「原文保留、只加标记，不改写叙述」矛盾。
- `plugins/dsh-crwu-workbench/HANDOFF.md` —— 跟踪在案的 2026-09-23 交接（自称 0.0.4 / `feat/reactor_crwu_wb` / 496-496 全绿），无历史标记、无导航引用。
- `src/host/domains/report-evaluation/browser/providers.ts:105` —— 运行期 `evidenceNote` 内嵌 `docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md`，该路径随包不分发（`package.json` 的 `files` 无 `docs/`），读到能力缺口的员工/代理打不开。

### 2.6 构建与测试卫生

- `install/browser-check.mjs:712` —— 硬编码 `'/tmp/crwu-valuation-fixture'`（仓库其他脚本一律用 `os.tmpdir()`），违反全局规范 §3.6「不得硬编码 `/tmp`」。
- `tests/unit/host/host-package.test.mjs:320` —— 两个 `mkdtempSync` 根从不删除（每次跑泄漏 2 个临时目录）；同文件以仓库根为 cwd 跑真实 `npm pack`，触发 prepack 重写工作树 `lib/`。
- 约定缺口 —— 本分支新引入的外部依赖（Chromium 系驱动 + CDP、`ps`/`tasklist`）未在全局规范 §3.6 的平台工具映射表内补行（规范原文：漏更新视为未完成）。

---

## 3. 已核实为「不是问题」（避免下一轮重复劳动）

- `references/06-workbook-contract.md:122/129/221` 里的 `` `01` ``/`` `05` ``/`` `07` `` 是**知识库文档**编号（同文件 `:5/:133/:165` 用 `04-参数与税费`/`05-案例选取`/`02-市场法` 同形），不是被删的技能内文件，不是悬空引用。
- `scripts/test_valuation_contracts.py` 已删，`Makefile` 的 `plugin-check` 在工作树里已同步为 `test_report_data` / `generic_workbook` / `report_render` / `calculate_market`（12 条 python 路径全部存在）；但该修复**未提交**（HEAD 的 `Makefile` 仍引用已删脚本）。
- `market_rules.py` 的 float 实现本身没错（实测 `combined_ratio([1.05,1.03]) == 1.0815000000000001`，`_EPS` 容差让 `check_single(1.2, 0.20)` 返回 `at-limit`）——不要当数值 bug 报。
- Go 侧没有「定义了但可删」的函数（除未调用的 `DetectChallenge` 与 `belongsToPlan`），`go build` / `go vet` / `gofmt -l` 全干净。

---

## 4. 建议清理顺序

1. **先修第 4 条**（知识工具测试硬红）—— 门禁必须能红能绿，否则后面每条改动都无法验证。
2. **第 3、7 条** —— 静默功能不可用，且会伪装成权限问题或正常运行，最容易被放过。
3. **第 1、11 条** —— 交付结论错误（合规行失实、底稿与 JSON 对不上）。
4. **其余死代码按目录一次性清** —— Skill 目录、`src/client/ui`、`src/shared`、`internal/platform/browser` 各成一批。
5. **文档生命周期** —— CHANGELOG 的 0.0.42 重复与 0.0.46 缺失是发布历史的硬伤，优先补 0.0.46 条目并合并重复章节。
