# 房地产估值会话 Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本计划交给 DeepSeek Harness 执行。为符合用户对速度和 Token 的要求，默认由同一个实现 Agent 按任务顺序完成、阶段末做窄回测；不要把运行时的估值子 Agent 与开发时的并行实现 Agent 混淆。用户未授权提交或发布，本计划没有自动 commit/push 步骤。

**Goal:** 将房地产页面改为单父会话启动入口，由知识驱动的估值 Skill 在会话内完成方案拆分、动态调度、案例取证、脚本计算及 HTML/计算表交付。

**Architecture:** Client 负责登录引导、文件预览、确认和跳转；Host 负责 Broker、结构化 Tools、归属和交接。父估值会话按业务知识库识别项目→方案→对象，健康状态下委派子 Agent，否则父会话顺序执行。浏览器与计算能力复用现有接缝，土地估值只预留可验证的依赖合同，不实现空壳土地 Skill。

**Tech Stack:** 现有 TypeScript/React/Cordis/DSH、Go Cobra/CDP、DSH Python/openpyxl、Node test runner、现有 TSX loader；不新增前端框架或浏览器测试框架。

**Spec:** [完整设计稿](../specs/2026-10-14-realestate-session-workflow-design.md)。必须连同本计划一起交给实现 Agent。

## Global Constraints

- 二级目录保留“房地产”，页面明确“当前支持住宅市场法估值”。不新增住宅子 Skill。
- 一个父会话；创建并交接成功后提示成功、自动跳转，不追踪会话完成度。
- 方案识别、方法判断、分组确认与缺口处理均在原生会话；不新增插件方案编辑器、进度页或结果页。
- 资料递归后 1–30 份；确认抽屉只显示文件元信息及用户填写的条件。
- 知识正文来自业务库或经过身份/hash 验证的镜像。Skill 不保留生产业务规则 fallback。
- 首期仅住宅市场法可完整测算；其他方法、房地分别评估的土地/建筑物专门能力缺失均生成中断报告，不强改市场法。
- 方法需要的能力必须可在实际 scoped registry 和 adapter 验证；禁止 Agent 自由网页试错、拼 CLI、安装依赖或绕过门禁。
- 并发安全上限 2，状态未知/繁忙则 sequential；上限不是必需并行数。启动健康阈值 10000ms，作为技术 SLA，不声称是 CPU 速度检测。
- 同 profile 浏览器调用串行；多个方案不得错页、重复执行或跨目录写入。
- 可见人机验证先调用固定脚本恢复，不直接失败。CLI 通用恢复能力由估值 Tool 自动使用；失败保存 waiting-user 断点，不重建会话、不让 Agent 现场改脚本。详细参考证据和状态合同见 Spec §8.4。
- 截图保存于本方案推理结果/图片/<caseId-名称>/；HTML 展示截图，Excel 只记录相对路径。
- 脚本计算与知识参数闭环；缺重算能力报告 partial，不能伪报完成。
- 当前所有新产品行为先写关键失败断言，再实现；窄测试在该步骤结束运行，全量门禁只在集成结束运行一次。
- 产品代码只改 src/ 与所属 Skill 源；生成 bundle、二进制、common/skills 不手改。保留用户两个未跟踪模板文件。
- 不访问生产凭据/线上业务作为测试，不提交、不推送、不发布。

## Review Focus

1. 启动请求超时或双击：创建/指令可能已受理，重试不得再创建父会话；导航失败也不能重复建会话（Task 2/4）。
2. 假知识命中：同名目录、空节点、另一个知识库的镜像、多个同名候选都不能当有效规则（Task 5）。
3. 子 Agent 超时后晚创建：未知状态保留执行 lease，父会话不能同时重做该方案（Task 7）。
4. 房地重复计价：含土地权益的住宅价值不能与 land-only 结果再次合计（Task 6/9/11）。
5. 去掉页面轮询后，校验可能无人触发；缺图/未重算/中断方案不能被模型一句“完成”升级为 completed（Task 10/11/12）。

## 执行位置与文件所有者

下文文件路径从仓库根开始。窄测试命令如未说明，从 `plugins/dsh-crwu-workbench/` 执行。Python 开发回测用能够 import 项目所需包的解释器；生产只用现有 DSH runtime resolver，不回落系统 Python。

| 所有者 | 目录与职责 |
| --- | --- |
| shared/contracts | report-evaluation.ts 只放跨进程输入/输出类型；新增 valuation-project.ts 放项目/方案/任务 DTO |
| operations/report-evaluation | 薄 RPC handlers，负责 panel 来源校验、调用 intake/auth/handoff；不承载知识或计算规则 |
| domains/report-evaluation/intake | metadata、归档摘要；复用本地审核扫描算法，不复制它 |
| domains/report-evaluation/project | 分组、方法记录、房地路径、任务图和对象结果关系 |
| domains/report-evaluation/execution | scope、lease、调度纯函数、DSH adapter、任务结果登记 |
| domains/report-evaluation/knowledge | catalog/resolve/materialize/validate、镜像、规则参数和模板 |
| domains/report-evaluation/browser | CLI transport、profile 队列、已验证来源与证据；业务阈值来自知识 |
| domains/report-evaluation/delivery | 最终校验和产物 manifest；无面板轮询 |
| client/modules/report-evaluation | auth gate、输入、只读抽屉、创建/跳转反馈 |
| skills/biz/crwu-biz-valuation-realestate | workflow、技术 Schema/脚本/HTML 模板；无规范正文生产兜底 |

所有新增依赖在 apply.ts 和 ToolDeps 中装配一份实例，并随 Cordis 生命周期清理。

## 核心合同：实现前统一命名

新合同在以下任务中依次定义，不允许后续任务临时换字段：

```ts
type MethodRequest = 'auto' | 'market' | 'income' | 'cost'
type ValuationPath = 'combined' | 'separate' | 'unresolved'
type ValueScope = 'land-only' | 'building-only' | 'land-and-building'
type ReportStatus = 'completed' | 'blocked' | 'partial' | 'failed' | 'cancelled'
type ExecutionMode = 'parallel' | 'sequential'

interface FrozenInput {
  schemaVersion: 'crwu.valuation.input.v2'
  projectId: string
  methodRequest: MethodRequest
  baseDate: string | null
  supplementalPrompt: string
  files: ArchivedMaterial[]
  inputDigest: string
}

interface TaskNode {
  taskId: string
  parentPlanId: string
  objectIds: string[]
  assetClass: 'realestate' | 'land' | 'building'
  requestedCapability: string
  dependsOn: string[]
  valuationPath: ValuationPath
  valueScope: ValueScope
  basisRefs: KnowledgeRef[]
}

interface HandoffReceipt {
  projectId: string
  parentSessionId: string
  dispatchAccepted: boolean
  reused: boolean
}
```

`ArchivedMaterial` 必须含 fileId、原名称、archiveRelativePath、sizeBytes、sha256；不含原绝对路径。`KnowledgeRef` 含 routeId、snapshotDigest、sectionId/ruleId。完整 Schema 在 Task 1 定义；错误统一返回 `{ok:false,errorKind,error}`，不抛裸业务错误。

UI 传基准日空串时 Host 归一化为 null；日期必须是有效 YYYY-MM-DD，不只检查正则形状。原始绝对路径只在 panel metadata 回显。projectId/planId/taskId 用 Host 铸号和安全路径派生，名称仅展示。

### Task 1: 定义 v2 合同与住宅市场法能力范围

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/shared/contracts/report-evaluation.ts`
- Create: `plugins/dsh-crwu-workbench/src/shared/contracts/valuation-project.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/project/contracts.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/project/coverage.ts`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/valuation-project.schema.json`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/valuation-report-data.schema.json`
- Test: `plugins/dsh-crwu-workbench/tests/unit/shared/valuation-project-contract.test.mjs`

**Interfaces:**
- Produces: FrozenInput、ArchivedMaterial、KnowledgeRef、TaskNode、HandoffReceipt、PlanAssessment、Blocker、ReportData。
- Produces: `assessCoverage(input: {propertyType:string; method:string; valuationPath:ValuationPath}): {supported:boolean; requiredCapabilities:string[]; blockers:Blocker[]}`。
- ReportData 用 status 判别联合；blocked 必须 stage、blockers、lookupAttempts、conclusion=null；completed 必须对象结果、计算表、证据、知识引用及验证 receipt。
- PlanAssessment 区分 primaryMethod、selectedMethods 和逐方法理由；未支持方法与业务不适用是两种状态。

- [ ] **Step 1 — 写失败用例。** 固定以下断言，不用新实现生成预期值：
  ```ts
  assert.equal(assessCoverage({propertyType:'residential',method:'market',valuationPath:'combined'}).supported, true)
  assert.equal(assessCoverage({propertyType:'commercial',method:'market',valuationPath:'combined'}).supported, false)
  assert.equal(assessCoverage({propertyType:'residential',method:'market',valuationPath:'separate'}).supported, false)
  ```
  同时读取新报告 Schema，断言各 status 分支的 required/const：blocked 不要求金额或工作簿，completed 必须含对象结论、工作簿和验证 receipt。blocked/completed 的实际数据校验在 Task 10 执行，本任务不调用未实现的 renderer。
- [ ] **Step 2 — 跑窄测试并记录预期失败。** `node --test tests/unit/shared/valuation-project-contract.test.mjs`；新合同/函数尚不存在或缺少判别约束时 FAIL。
- [ ] **Step 3 — 实现合同和 coverage。** 技术 coverage 不含业务阈值；未来 land.valuation.execute 标记 unavailable，无空壳 Skill。
- [ ] **Step 4 — 重跑本任务窄测试。** 必须 PASS；旧 DTO 在迁移阶段留在单独 v1 边界，最终 Task 4 移除 Client 依赖，不能让同一个 Schema 混两版。
- [ ] **Step 5 — 记录 checkpoint。** 列新增 DTO 和验收结果，不提交。

### Task 2: 元信息、归档预览与幂等父会话交接

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/operations/report-evaluation.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/intake.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/handoff.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/intake/metadata.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/intake/preview.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/execution/handoff-store.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/scope.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-handoff.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-ops.test.mjs`

**Interfaces:**
- Consumes: Task 1 FrozenInput/HandoffReceipt、既有 scanSelection、workspaceSessionService、Broker。
- Produces: `preparePreview(input:PreviewRequest,deps:PreviewDeps):Promise<PreviewResult>`，含 previewId/inputDigest/Client metadata；PreviewRequest={requestId,paths,method,baseDate,supplementalPrompt}，在 Host 映射 method→FrozenInput.methodRequest、空日期→null。
- Produces: `handoffProject(input:{previewId:string;confirmedInputDigest:string;requestId:string},deps:HandoffDeps):Promise<HandoffResult>`。
- Produces: `HandoffStore.claim(requestId,previewId)`、`bindSession(projectId,sessionId)`、`acceptDispatch(projectId,receipt)`；状态 pending/created/dispatched，原子持久化于 Host 派生项目目录。

- [ ] **Step 1 — 写失败用例。** 30/31 文件、空目录、重叠路径、同名不同路径、birthtime 缺失；源复制后变化、归档被篡改、无 confirmedInputDigest、2026-02-30；并发同 preview 只调用一次 create；发送已受理但 RPC 超时重试仍同 parentSessionId。
  ```ts
  await Promise.all([handoffProject(request,deps), handoffProject(request,deps)])
  assert.equal(deps.createdSessions.length, 1)
  assert.equal(deps.dispatchedPrompts.length, 1)
  assert.equal(preview.files[0].createdAt, null)
  ```
- [ ] **Step 2 — 先验证关键新断言失败。** `node --test tests/unit/host/host-valuation-handoff.test.mjs`。
- [ ] **Step 3 — 实现。** intake 只扫描、按字节复制、验目标 hash、生成确认摘要；不调用 Python/Agent/知识/外网。起会话从 Host preview 读条件，不接受第二套条件。快照摘要覆盖文件、方法、日期、补充要求和 schemaVersion。先 pending→统一 workspace create→验证 cwd/归组→scope→发送固定指令→accepted；失败重试同一会话。
- [ ] **Step 4 — 回测边界。** `node --test tests/unit/host/host-valuation-handoff.test.mjs tests/unit/host/host-valuation-ops.test.mjs tests/unit/host/host-workspace-session.test.mjs`。PASS 且无真实员工文件/网络。
- [ ] **Step 5 — 记录 checkpoint。** 保留未跟踪模板；删除旧 intake 中重复业务提取/本地规范预检，不在本任务删除会话内 file-extract Tool。

### Task 3: 浏览器 CLI 适配、脚本恢复基础、局部门禁与登录任务

**Files:**
- Modify: `internal/platform/browser/{classify.go,page.go,cdp.go}`
- Create: `internal/platform/browser/recover.go`
- Create: `internal/platform/browser/challenges/geetest_v3_probe.js`
- Create: `internal/platform/browser/challenge_gap.go`
- Modify: `internal/transport/cli/browser.go`
- Test: `internal/platform/browser/{recover_test.go,challenge_gap_test.go,classify_test.go}`
- Modify/Test: `internal/transport/cli/{browser_test.go,browser_hardening_test.go}`
- Modify: `docs/v0.0.1/{cli-manual.md,cli-command-contract.md,CHANGELOG.md}`
- Modify: `plugins/dsh-crwu-workbench/src/host/integrations/crwu/run.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/core/access/operations.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/cli-client.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/profile-queue.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/login-jobs.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/challenge-recovery.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/auth.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/config/config.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/config/deployment.ts`
- Modify: `plugins/dsh-crwu-workbench/config/crwu-workbench.yml`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-browser-client.test.mjs`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-challenge-recovery.test.mjs`

**Interfaces:**
- Produces: `BrowserClient.status(siteIds,signal):Promise<SiteStatus[]>`、`login(siteId,signal):Promise<LoginOutcome>`、`fetch(request,signal)`、`shot(request,signal)`、`recover(request,signal):Promise<RecoveryOutcome>`。
- SiteStatus: siteId/state/reason，state=authenticated/unauthenticated/unknown；非零退出的合法 `{ok,data}` 仍解析逐站结果。
- Produces: `statusFromEnvelope(output:{stdout:string;exitCode:number|null}):SiteStatus[]`；stdout 畸形返回 unknown 及安全原因，不抛裸 JSON 错误。
- Produces: `ProfileQueue.run<T>(profileKey:string,signal:AbortSignal|undefined,operation:()=>Promise<T>):Promise<T>`。
- Produces: startLogin(siteId) → jobId；preflight 可返回当前 loginJobs；cancelLogin(jobId) 校验归属。
- 配置 valuation.browser 指向包内站点数组、requiredSiteIds/optionalSiteIds；镜像配置另在 Task 5；不新增全局 required 环境项。
- CLI 新合同：`crwu browser recover --sites <file> --site <id> --url <originalUrl> --strategy <auto|cooldown-renavigate|geetest-v3-canvas>`；命令 catalogue 按现有拥有者注册，准确 flags/usage/example 必须由 `crwu scheme` 输出。复用当前 profile 参数和公共 URL 校验，禁止新增任意 `--eval`/`--script`/Cookie/端口参数给模型。
- `RecoveryOutcome`：recoveryId/retrievalTaskId/providerId/strategyId/strategyVersion/attempts/beforeKind/state/reasonCode/nextEligibleAt/pageValidation；state=recovered/waiting-user/unsupported/cancelled/unavailable/failed。CLI 做页面级检查，Host 在 Task 8 补房源字段验证。可见挑战且登录 profile 可用才调 solver；真未登录保留原登录步骤。
- Coordinator：同一任务最多 2 次自动尝试，总窗口 120 秒、每次脚本/CDP 调用不超过 30 秒。冷却异步持久 checkpoint，不等待模型 turn；退出/重载/显式 Tool 重试共享 recoveryId 和预算；profile/provider 的 cooldownUntil 对后续取数统一生效。

- [ ] **Step 1 — 写失败用例。** status 不等于 HTTP 首页成功；login 立即启动不先查三站；Cookie 存在后必须 status 权威通过；退出码非零+有效 JSON；同 profile 最大同时一操作；取消排队项不会杀别任务；未授权 Broker 不起进程；站点名单拒绝自由 URL。
  恢复用例补充：挑战才调用固定脚本；隐藏 captcha 资源不调用；solver exit 0 但挑战仍可见不能 recovered；无 canvas 返回 unsupported；known canvas 的差分/模板匹配和 CSS 缩放偏移；异常图像/越界坐标拒绝重放；页面已恢复无需拖动；请求取消后清理鼠标状态；脚本异常脱敏；相同任务显式重试不重置预算；冷却不占 profile 队列，其他来源可用；scheme 输出新命令且 stdout JSON-only。员工已发起login job时，登录页真实可见slider也可辅助，但challenge消失且身份未通过不得释放门禁。
  ```ts
  assert.equal(crwuOperationOf(['crwu','browser','status']) !== null, true)
  assert.equal(statusFromEnvelope(nonzeroWithUnknown)[0].state, 'unknown')
  assert.equal(fakeBrowser.maximumActiveCalls, 1)
  ```
- [ ] **Step 2 — 跑红。** 新 CLI 恢复断言先在仓库根跑 `go test ./internal/platform/browser ./internal/transport/cli -run 'Recover|Challenge|Classify|Browser'`；插件仅跑新增 browser-client/challenge-recovery 文件，确认对应断言失败，不先跑全量。
- [ ] **Step 3 — 实现。** 参数由 Host 构建，经现有 packaged runCrwu/Broker；不得回显 Cookie/profile/命令。站点文件为 CLI 现有顶层数组，真实 URL/Cookie 名从经验证来源配置取得；未经真机核对的 provider 标未验证，不伪造 available。登录 Job 随插件实例清理，支持有界查询。
  先复核 Spec §8.4 指定参考脚本与结果，从中迁移技术算法。固定 probe JS 随 Go embed，Go 标准库解 PNG、差分或匹配；使用 `Input.dispatchMouseEvent` 的受限技术方法，不给模型任意 CDP API。目标必须通过明确 target 身份和原请求关联选取，不能 `targets[0]`/任意 blank tab；处理 canvas 本征尺寸/CSS 尺寸、片块初始偏移与 deviceScaleFactor，不抄旧 `bias=-6` 当通用常量。Canvas 污染、iframe/不支持的挑战明确 unsupported。reference Node/Python 的绝对路径、execFileSync、旧 Cookie 值均不迁移。CLI recovered 必须实际回读页面；脚本结果只提供候选信号。冷却/重新导航和 slider 两策略各有固定触发规则，限流需遵守 Retry-After；不复制历史四次循环和无上限 sleep。
- [ ] **Step 4 — 窄回测。** 本任务两个 Host 测试 + `tests/unit/host/host-access-source-policy.test.mjs`、`host-yaml-config.test.mjs`；任务收尾仓库根跑 `go test ./internal/platform/browser ./internal/transport/cli` 一次。小改只重跑对应 Recover/Challenge/Browser 断言，不每次重跑 Go 全包/插件全量。
- [ ] **Step 5 — 记录 checkpoint。** 同步 scheme、CLI manual/contract/changelog，列出策略版本、fixture覆盖和真实站点尚未验证项；不借此重写整个 CDP。普通 fetch/shot 保留拒绝输出挑战证据的合同，自动恢复由已接入的估值 transport/coordinator 驱动，不静默改变所有 CLI 使用者。

### Task 4: 启动页 UI/UX、抽屉、自动跳转与旧页删除

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/{api.ts,index.ts,controller.ts,model/valuation-state.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/{ReportEvaluationPane.tsx,ValuationIntakePane.tsx,ValuationConfirmationDrawer.tsx}`
- Create: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/ValuationAuthGate.tsx`
- Create: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/session/open-session.ts`
- Delete: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/ValuationProgressPane.tsx`
- Delete: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/ui/ValuationResultPane.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/client/modules/report-evaluation/styles/pane.ts`
- Modify: `plugins/dsh-crwu-workbench/src/client/{apply.ts,locales/zh-CN.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/client/shell/{WorkbenchPanel.tsx,services.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/client/ui/SideDrawer.tsx`
- Modify: `plugins/dsh-crwu-workbench/src/shared/{contracts/report-evaluation.ts,wire/report-evaluation.ts,consts.ts}`
- Modify: `plugins/dsh-crwu-workbench/tests/helpers/frozen-inventory.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/client/client-valuation-pane.test.mjs`
- Create/Test: `plugins/dsh-crwu-workbench/tests/unit/client/client-valuation-handoff.test.mjs`

**Interfaces:**
- Consumes: Task 2 PreviewResult/HandoffResult；Task 3 SiteStatus/login job。
- Consumes: Task 3 安全 RecoveryOutcome；正文 auth gate 展示 recovering/waiting-user 的提示和“打开验证页面 / 验证完成，重新检查”。恢复中禁用重复触发，保留二级目录切换；只对当前门禁job有界查询，交接后不追踪。
- Produces: controller 检查登录、编辑输入、preparePreview、confirm、backToEdit、openCreatedSession；无 poll/result/openArtifact/运行期 cancel。
- 页面阶段 checking-auth/auth-blocked/draft/preparing-confirmation/confirmation/creating-session/handoff-failed/handed-off/stale-host。修改共享合同使 Client 不依赖运行期 phase。
- Produces: `openValuationSession(services,sessionId):Promise<{ok:boolean;error:string}>`，优先 uiWorkspace.openSession，切 conversation；不是 openSubagent。

- [ ] **Step 1 — 写失败用例。** 房地产被拦但目录可切换；页面叫房地产并显示住宅市场法限制；“确认/开始估值”精确文案；抽屉没有知识/字段/完整 Prompt；导航失败重试创建次数不变；交接成功无任何 valuation-status/result 请求；late response 无法覆盖新输入。
  ```ts
  assert.equal(textOf(drawer).includes('知识库状态'), false)
  assert.equal(findAll(tree, n => n.props?.['data-valuation-confirmation-drawer']).length, 1)
  assert.equal(port.calls.status.length, 0)
  assert.equal(openedSessions[0], receipt.parentSessionId)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/client/client-valuation-handoff.test.mjs`；旧页面没有导航适配且仍有后续查询时 FAIL。
- [ ] **Step 3 — 实现 UI 和删除。** 保留一层工作面、1120px、容器查询和现有 token/class scope。输入前 8 条可展开，抽屉全量元信息、路径小字；birthtime=null 不冒充日期。主页面底栏“确认”，抽屉固定 footer“返回修改/开始估值”，唯一 primary。改 SideDrawer footer/focus trap/background inert 与 reduced-motion 时同步保留审核抽屉行为。成功提示后立刻导航，失败只提供打开已创建会话。
- [ ] **Step 4 — 窄回测。** `node --test tests/unit/client/client-valuation-pane.test.mjs tests/unit/client/client-valuation-handoff.test.mjs tests/unit/client/client-style-scope.test.mjs tests/unit/client/client-package.test.mjs`。阶段末 `npm run typecheck` 一次。删除 WorkbenchPanel 的估值 interval/hooks 和相关 helpers/style/locale，报告审核轮询不变。
- [ ] **Step 5 — 记录 checkpoint。** 从 Host/Client/API/wire/frozen inventory 删除旧 status/result/open-artifact/运行期 cancel；保留必要的输入取消为 intake-cancel。升级 WORKBENCH_PROTOCOL 至当前基线+1（基线34时为35），只在一处更新，所有 wire 测试一致。

### Task 5: 真实知识目录、同名恢复、镜像验证和按阶段物化

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/{route.ts,resolve.ts,snapshot.ts,index.ts}`
- Replace: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/fallback.ts` → `mirror.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/rules.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/knowledge.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/config/{config.ts,deployment.ts}`
- Modify: `plugins/dsh-crwu-workbench/config/crwu-workbench.yml`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/knowledge-source.schema.json`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/rule-parameters.schema.json`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/{host-valuation-knowledge.test.mjs,host-valuation-knowledge-tool.test.mjs}`

**Interfaces:**
- Consumes: KnowledgeRef、绑定的 project/plan scope、DWS tree/channel helpers。
- Produces: `resolveRoute(catalog,routeSpec):RouteResolution`；resolution=found/missing/empty/ambiguous/unreadable。
- Produces: `materializeKnowledge({projectId,planId?,stage,routeIds},deps):Promise<KnowledgeManifest>`；stage=grouping/method-selection/method/data/template-index。
- Produces: `loadVerifiedMirror(routeSpec,expectedSpace,mirrorConfig):Promise<MirrorOutcome>`；`parseRuleParameters(snapshot):RuleParameterSet`。
- KnowledgeManifest 必需 actual space、routeId/resolvedPath/source、digest、snapshot file、lookupAttempts、非空正文校验；source=dws/verified-mirror。

- [ ] **Step 1 — 写失败用例。** 目录不是正文；旧扁平路由按显式 alias 恢复；同目录同名 .md 可命中；同名多个失败；错误空间 manifest 拒绝；镜像 hash 错误拒绝；远程明确废止/空不能回旧镜像；method=auto 只拉选择规则，不拉全部三法；索引写失败不返回 ok。
  ```ts
  assert.equal(resolveRoute(twoSameNameCandidates, route).state, 'ambiguous')
  assert.equal((await loadVerifiedMirror(route, '中瑞世联业务知识库', wrongSpace)).ok, false)
  assert.deepEqual(routesForStage('method-selection','auto'), ['realestate.method-selection'])
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-knowledge.test.mjs tests/unit/host/host-valuation-knowledge-tool.test.mjs` 中的新断言须在原本 local fallback/auto 全法路由上失败。
- [ ] **Step 3 — 实现。** 业务库路径按 Spec §2.1/6，使用一次树/按 route cache；精确路径→同目录同名→显式 alias→身份已验证镜像。目标库是业务库；当前给定目录 manifest 标审核库，默认 mirrorRoot 留空，不自动启用或修改身份。知识必需项按 stage，不全量下载。
- [ ] **Step 4 — 窄回测。** 运行 Step 2 命令及配置窄测试，确认没有生产 Skill reference fallback、没有模型可见 nodeId/镜像绝对路径。
- [ ] **Step 5 — 记录 checkpoint。** 产出 03/04 文档治理清单和 structured-rule 技术 Schema；不填写未经业务确认的阈值、税率，不修改线上知识库。关键规则缺失后交给 Task 10 中断 renderer。

### Task 6: 对象、方案、方法和房地分别评估任务图

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/project/{grouping.ts,methods.ts,task-graph.ts}`
- Create: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/project.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/file-extract.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/intake/{extract.ts,types.ts,python-extractor.ts}`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/valuation-task-graph.schema.json`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-project.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-file-extract.test.mjs`

**Interfaces:**
- Consumes: Task 1 DTO/coverage、Task 5 KnowledgeManifest/RuleParameterSet、已有一次提取结果。
- Produces: `validateGrouping(objects,proposedPlans,commonRules):GroupingOutcome`；`validateMethodAssessment(plan,assessment,selectionSnapshot):MethodOutcome`。
- Produces: `buildTaskGraph(plan,assessment):TaskGraph`、`validateValueScopes(components):ScopeCheck`；未来 land.valuation.execute 的 Skill 候选名 crwu-biz-valuation-land 仅 unavailable 配置。
- 新 `crwu_valuation_project_prepare` Tool 接收识别/分组/方法候选，Host 验结构、对象归属和来源指纹后固定项目索引；业务判断引用知识，不能靠硬编码城市/物业规则。

- [ ] **Step 1 — 写失败用例。** 同小区同口径三住宅可同方案但有三个 objectId；住宅+商业拆方案；同小区不同权益/基准日为冲突；指定 market 不适用不能改 income；选择方案要求两种方法但只支持一种不能称业务不适用；separate 生成 land/building/join 依赖；任务图拒绝环；land-and-building + land-only 汇总拒绝。
  ```ts
  assert.equal(validateValueScopes([{valueScope:'land-and-building'},{valueScope:'land-only'}]).ok, false)
  assert.equal(buildTaskGraph(separatePlan, separateAssessment).nodes.some(n => n.assetClass === 'land'), true)
  assert.equal(landCapability.available, false)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-project.test.mjs`。
- [ ] **Step 3 — 实现。** 父会话调用 file-extract 一次，hash 复用，保留来源坐标；资料冲突/unresolved 在会话询问员工。按知识先判 combined/separate，再最终方法；不同方法可使预分组再拆分。房地分别组件保留 parentPlanId/objectId/valueScope，未来能力全链验证才启用。当前缺 land 或 building-only 方法返回 blocker，不临时创建土地 Skill。
- [ ] **Step 4 — 窄回测。** `node --test tests/unit/host/host-valuation-project.test.mjs tests/unit/host/host-valuation-file-extract.test.mjs`。不同房产不能共用面积/修正值；有依赖任务只在前置完成时 ready。
- [ ] **Step 5 — 记录 checkpoint。** 模型不确定分组/方法通过父会话问一次关键问题，员工答复形成新确认记录；冻结的原用户输入不回写。

### Task 7: 动态调度、单执行 lease 和父/子范围

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/execution/{decision.ts,leases.ts,dsh-adapter.ts,registry.ts}`
- Create: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/execution.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/scope.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/visibility.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-audit/case-access.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-audit/case-scopes.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/common/python-script.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-execution.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-bootstrap.test.mjs`

**Interfaces:**
- Consumes: TaskGraph、scope、实际 Agent registry/provider capabilities、Broker。
- Produces: `decideExecution(input:ExecutionFacts):ExecutionDecision`；facts 含 statusKnown、externalRunningCount、providerUsable、filterSupported、activeOwnedTaskIds、lastStartDurationMs、lastStartFailure。
- Produces: `dispatchReadyTasks(parentAgent,projectId,signal):Promise<DispatchOutcome>`；`joinTasks(parentAgent,projectId,taskIds,signal):Promise<TaskOutcome[]>`。
- Produces: `TaskLeaseStore.acquire(taskId,attemptId,executor)`、`markStartUnknown`、`bindChild`、`settle`；owned task 必须确认 quiescent 后才换执行者。
- scope: parent 可协调项目，child 只写绑定 plan/task，顺序执行仍显式 taskId。执行工具无 arbitrary caseDir/command。

- [ ] **Step 1 — 写失败用例。** unknown/busy/no provider→sequential；healthy→最多2；10001ms startup 停止并发扩张；timeout later child 绑定后父会话不再执行同 task；错误身份/cross-plan 写拒绝；依赖未完成不 dispatch；父会话仍可执行完整 sequential，无虚假 child requirement。
  ```ts
  assert.equal(decideExecution({...facts,statusKnown:false}).mode, 'sequential')
  assert.equal(decideExecution({...facts,lastStartDurationMs:10001}).mode, 'sequential')
  assert.equal(await lease.acquire(taskId,anotherAttempt,'parent'), false)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-execution.test.mjs`。
- [ ] **Step 3 — 实现。** 使用当前安装 Harness service 声明，不臆造 remainingSlots；只读 Agent list/get/status + 启动真实结果。先 pending scope 后 start，回读本地 child、toolFilter、归组和沙箱；失败清理。状态/事件只为 lease、join 负责，无面板计时器。启动未知状态不能立即 fallback 同任务。
- [ ] **Step 4 — 窄回测。** 本任务测试 + bootstrap + 原 case access/scope 窄测试；确认对子 Agent 禁用泛用 shell/fs，Python script 的所有文件参数在范围内验证。顶层父会话使用现有正式会话创建能力，不能声称它已有子代理 toolFilter；父 Tools 自身做归属 gate，必要能力无法可靠限制时不启用对应额外操作。
- [ ] **Step 5 — 记录 checkpoint。** 插件重载后从受保护 handoff/索引校验恢复原父会话绑定；没有证据拒绝认领。读取 global Agent 元信息仅用于调度，不传其他会话内容给模型。

### Task 8: 方法所需能力、固定来源解析与截图案例闭环

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/execution/capabilities.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/browser-transport.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/browser-recover.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/browser/{providers.ts,provider.ts,login-state.ts,preflight.ts,capture.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/{jsonld.ts,normalize.ts}`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/market/site-parsers.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/market-search.ts`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/screenshot-manifest.schema.json`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-capture.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/{host-valuation-market.test.mjs,host-valuation-market-tool.test.mjs}`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-challenge-recovery.test.mjs`

**Interfaces:**
- Consumes: Task 3 BrowserClient/ProfileQueue、Task 5 method capability/03 rules、Task 7 scope。
- Produces: `checkMethodCapabilities(plan,knowledge,registry,adapters):CapabilityCheck`；registered+scoped-visible+actual verified 三项齐才 available。
- Produces: `planRetrievalTasks(plan,methodRules,caseRules):RetrievalTask[]`，业务搜索范围来自知识；URL/选择器只由 Host 技术 adapter 决定。
- Produces: `captureComparable({taskId,caseId,providerId,listingId},deps):Promise<EvidenceOutcome>`，relativePath/capturedAt/digest/finalUrl/validity。
- Produces: `parseSitePage(input:{providerId:string;body:string;finalUrl:string}):{listings:RawListing[];failureKind:string}`，放在 site-parsers.ts；validPageWithoutExpectedFields 是同形 fixture。
- Produces: `crwu_valuation_browser_recover({providerId,retrievalTaskId})`；调用者 scope 与原取数任务绑定，不能传自由 URL/策略/脚本/输出目录。自动恢复和显式继续共用 Task 3 coordinator，caseId/原 URL 从受保护任务索引读取。
- `browser.challenge.recover` availability 要求 CLI 命令、embed 脚本、strategy adapter、structured Tool、scoped filter 均可用；fixture通过仅标离线验证，不以此宣称已通过真实 CAPTCHA。

- [ ] **Step 1 — 写失败用例。** 方法要求 screenshot 而未装配时取数前 fail；链家/贝壳独立 site；中文城市不能原样进入域名；真实 fixture DOM可解析；0选择器命中→template-stale；同源ID跨两站去重但保留两个来源；同价同面积不同房不能误删；并行 A/B截图不能错页；登录/验证码截图无效。
  增加 challenge→recover→原任务继续链；原房源A恢复后误入B拒绝；抓取恢复而截图再次挑战共享预算；未恢复转waiting-user不创建新会话；用户继续不重传资料/重跑已完成对象；强行调用另一方案recoveryId拒绝；挑战canvas不进入正式证据目录；错误或隐藏captcha文案不产生额外操作。门禁与会话取数复用 coordinator，门禁有限查询不能重启旧估值完成度轮询。
  ```ts
  assert.equal(checkMethodCapabilities(plan,ruleWithScreenshot,missingScreenshotRegistry,adapters).ok, false)
  assert.equal(parseSitePage(validPageWithoutExpectedFields).failureKind, 'template-stale')
  assert.equal(captureA.manifest.caseId, 'case-A')
  assert.equal(captureA.manifest.finalUrl, detailA)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-capture.test.mjs` + market 中新解析断言。
- [ ] **Step 3 — 实现。** browserTransport 接现有 MarketTransport；细分城市/检索/详情固定 parser。Capture 和 search 当前同文件，可按本任务拆 capture 薄工具但不复制实现。固定证据路径为方案推理结果/图片/<安全caseId-名称>/，HTML页面另存来源证据/页面。命名、ID、最终URL、图片hash 一并校验。
  收到captcha调用固定恢复能力，通过后重新fetch/shot；真正login才引导登录。失败返回安全RecoveryOutcome及waiting-user checkpoint，在会话一次说明“自动处理未通过，请在当前浏览器完成验证后继续”；其他独立方案可以继续。重试必须验证原URL、listingId/业务字段、无可见遮罩，不能把挑战消失或HTTP200当证据有效。保留恢复摘要供HTML技术过程说明，不输出凭证/原始指令。CLI blocked 若可识别为适配挑战再处理，否则保留原分类；不是所有403都调slider。恢复预算/冷却由Host管理，不在Skill中写让模型循环sleep的指令。
- [ ] **Step 4 — 窄回测。** `node --test tests/unit/host/host-valuation-capture.test.mjs tests/unit/host/host-valuation-market.test.mjs tests/unit/host/host-valuation-market-tool.test.mjs tests/unit/host/host-valuation-challenge-recovery.test.mjs`。重试按 failureKind 限定；captcha先脚本、未恢复再员工动作；不能失败三次一律“请登录”。
- [ ] **Step 5 — 记录 checkpoint。** 实际站点样本未取得则保留真实验收缺口，不能用静态 fixture PASS 声称在线 provider 已验证；Agent 遇未验证 adapter 给中断报告，不开始自由试错。

### Task 9: 模板二进制下载、知识参数计算与对象工作簿

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/templates.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/template.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/delivery/recalculation.ts`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/{market_rules.py,build_workbook.py,check_workbook_contract.py}`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/calculate_market.py`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/summarize_objects.py`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_calculate_market.py`
- Modify/Test: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_market_rules.py`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-template.test.mjs`

**Interfaces:**
- Consumes: Task 5 template-index、rule parameters、Task 6对象/method/valueScope、Task 8证据。
- Produces: `materializeTemplate({taskId,templateId},deps):Promise<TemplateOutcome>`；只取索引真实已发布模板，返回binary digest/input mapping/contractVersion。
- Produces: `calculate_market(payload: dict) -> dict`；`summarize_objects(payload: dict) -> dict`；输出 numeric strings/Decimal、中间值、ruleRef、对象结论。
- Produces: `recalculateWorkbook({taskId,workbookRelativePath},deps):Promise<RecalculationOutcome>`，state=recalculated/unavailable/failed；解释器与本地重算程序都经 Broker。

- [ ] **Step 1 — 写失败用例。** xlsx不走文本decode；空/预留模板失败；模板ID/结构/公式链不符失败；没有阈值不运行；连乘非相加；取整边界遵循知识配置；单位不兼容/缺参数/null不作0；证据路径进底稿；不可把land-and-building和land-only合计；无重算 provider→partial。
  ```python
  self.assertRaises(ValueError, calculate_market, payload_without_rule_parameters)
  self.assertEqual(calculate_market(multiplicative_fixture)["combinedRatio"], "1.21")
  self.assertRaises(ValueError, summarize_objects, overlapping_value_scopes)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-template.test.mjs`；`PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_calculate_market.py`。
- [ ] **Step 3 — 实现。** 取索引→验证已发布/适用→二进制materialize→工作簿合同→复制实例→只填输入区。生产 market_rules 必传规则阈值/取整，移除隐式默认业务参数，使用 Decimal 而非模型算术。每对象独立 xlsx，再按脚本汇总，初期多对象优先交计算表集合，避免错误 sheet 重写；未来合成单表须单独通过公式引用/缓存验证。
- [ ] **Step 4 — 窄回测。** 上述命令 + `PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_market_rules.py`。独立模板 test fixture 放测试目录，不回生产包内 template 默认。
- [ ] **Step 5 — 记录 checkpoint。** openpyxl不重算；Excel/LibreOffice provider有可靠能力才使用。缺provider可保存待重算底稿并出partial，不安装/假装具备本地Excel能力，不靠打开文件动作声称重算完成。

### Task 10: 单数据合同 HTML、中断报告与图片体验

**Files:**
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/build_report_data.py`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/build_report.py`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/template/valuation-report.html`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/valuation-report-data.schema.json`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_report_data.py`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_report_render.py`

**Interfaces:**
- Consumes: Task1 ReportData、knowledge/lookup、对象/方法/图、取数轨迹、计算/重算、图片 manifest。
- Produces: `build_report_data(payload: dict) -> dict`；`validate_report_data(data:dict) -> list[str]`；`render_report(data:dict,template_path:str,case_root:str) -> str`。
- 这三个函数分别归 build_report_data.py（组装/数据校验）和 build_report.py（渲染）；不定义额外同名 TypeScript renderer。
- CLI：build_report_data.py `--input <受控运行manifest> --out <report-data.json>`；build_report.py `--data <report-data.json> --out <报告.html>`。
- 数据 status 控制结论展示；HTML不是第二计算器，金额精度由计算脚本输出，renderer不再次取整。

- [ ] **Step 1 — 写失败用例。** 缺方法/模板的blocked可出HTML且无金额；partial不显示正式结论；页面含所有筛选/参数/中间值/知识引用；图片实际不存在或digest不符拒绝渲染completed；路径../和symlink逃逸拒绝；标题script转义；内嵌JSON的`</script>`安全；离线打开不依赖CDN；图片/目录名与caseId一致。
  ```python
  self.assertIn("本次估值未完成", render_report(blocked_data, template, case_root))
  self.assertNotIn("<script>alert(1)</script>", render_report(unsafe_title_data, template, case_root))
  self.assertIn("data:image/png;base64,", render_report(valid_shot_data, template, case_root))
  ```
- [ ] **Step 2 — 跑红。** `PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_report_data.py` 及 test_report_render.py。
- [ ] **Step 3 — 实现。** JSON→统一Schema→固定模板→原子写HTML。首屏结果或中断原因，下面业务可复核过程；不输出隐藏思维链。采用案例缩略图、原图预览/键盘Esc、来源/时间/挂牌成交、完整打印，CSS/JS内联。图片目录始终保留，脚本嵌图实现单HTML转发不丢图；大体积报告明确给包含目录的报告包，不静默断图。
- [ ] **Step 4 — 窄回测。** 两个新Python测试；本任务只生成测试case输出，不改Skill模板原文件。对deep/light、500px/宽屏、print做本地生成HTML视觉抽样，截图失败属于可追踪验收缺口。
- [ ] **Step 5 — 记录 checkpoint。** 被阻断方案产出state/report-data/HTML；不产正式result/结论xlsx。已生成中间文件只标工作中，不删除可复核材料。

### Task 11: finalize、Skill Workflow 与真实生产装配

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/delivery/finalize.ts`
- Create: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/finalize.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/{bootstrap.ts,artifact-validate.ts,artifacts.ts,record.ts,consts.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/{register.ts,common/types.ts,report-audit/consts.ts}`
- Modify: `plugins/dsh-crwu-workbench/src/host/apply.ts`
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/prompt.ts`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/{SKILL.md,schemas/valuation-result.schema.json,schemas/valuation-object.schema.json,schemas/valuation-case.schema.json}`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/validate_result.py`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/references/workflow.md`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/references/knowledge-routing.md`
- Create: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/references/execution-and-land-extension.md`
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/references/09-output-contract.md`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-finalize.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-artifact-validate.test.mjs`

**Interfaces:**
- Consumes: Tasks1–10的合同与生产依赖。
- Produces: `finalizePlan({taskId,requestedStatus},deps):Promise<FinalizeReceipt>`、`finalizeProject({projectId},deps):Promise<FinalizeReceipt>`；requestedStatus只提示，Host依据实际文件/校验决定。
- 新Tools固定名：crwu_valuation_project_prepare、crwu_valuation_template_materialize、crwu_valuation_execution_dispatch、crwu_valuation_execution_join、crwu_valuation_browser_recover、crwu_valuation_finalize；其余沿用现有名。模型参数只接business IDs/typed data，不接任意command/destination。
- 执行Prompt根据Spec §15构造；使用现有crwu-biz-valuation-realestate，不新建residential或land空Skill。

- [ ] **Step 1 — 写失败用例。** 模型requestedStatus=completed但缺图/知识/未重算拒绝；blocked只需说明报告合同；父/child越权拒绝；页面不存活仍能finalize；项目一方案blocked时project=partial，不能加其中间金额；借改inputDigest隐瞒资料篡改拒绝。
  ```ts
  assert.equal((await finalizePlan({taskId,requestedStatus:'completed'},unrecalculatedDeps)).status, 'partial')
  assert.equal((await finalizePlan({taskId,requestedStatus:'completed'},missingEvidenceDeps)).ok, false)
  assert.equal(projectReceipt.status, 'partial')
  assert.equal(projectReceipt.conclusionIncludesBlockedAmount, false)
  ```
- [ ] **Step 2 — 跑红。** `node --test tests/unit/host/host-valuation-finalize.test.mjs`。
- [ ] **Step 3 — 实现闭环。** 验冻结输入、实际知识digest与节/规则、模板hash、对象计算、截图、重算结果、报告Schema/HTML和产物manifest。把旧 operations.confirmCompletion 移入明确调用的finalize，删除依赖面板lifecycle的recordProgress。注册Tool/滤器/ToolDeps/apply同批装配，screenshot不再InjectionOnly缺省能力。审核required工具清单不混入估值工具。
- [ ] **Step 4 — 窄回测。** finalize/artifact-validate + `host-tools.test.mjs`、`host-valuation-bootstrap.test.mjs`；改现有Python交付合同测试，不因blocked放宽completed。阶段末typecheck一次。所有新Tools校验exec.agent作用域，Python运行使用`python.check({agent:exec.agent})`，不因面板无Agent误报运行时缺失。
- [ ] **Step 5 — 迁移Skill。** 移出references中业务规范正文的生产使用；保留路由/技术合同，不删除用户未跟踪文件。老xlsx作为测试fixture归档且不能被生产读；新Skill可独立复制运行，外部Knowledge/Tools依赖明确标注。注册、Prompt、Skill和consts同名。
  workflow明确：可见挑战由取数Tool自动调用固定脚本；返回waiting-user则保留断点，请员工在当前浏览器完成验证后用同一取数任务继续；禁止看到captcha就finalize failed，禁止自行生成新CDP脚本或循环调用恢复Tool。结构化recover Tool加入真实注册/依赖/filter清单，并与transport共享状态，不能只有Prompt宣称能力已具备。

### Task 12: 端到端验收、文档与最终一次完整门禁

**Files:**
- Modify/Test: `plugins/dsh-crwu-workbench/tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs`
- Modify/Test: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_valuation_contracts.py`
- Modify: `plugins/dsh-crwu-workbench/install/browser-check.mjs`
- Modify: `plugins/dsh-crwu-workbench/docs/{ui-design-guidelines.md,development-notes.md,PRD-workbench-sidebar-modules.md}`
- Modify: `plugins/dsh-crwu-workbench/{README.md,README.en.md,CHANGELOG.md}`
- Modify: `plugins/dsh-crwu-workbench/tests/helpers/frozen-inventory.mjs`
- Modify if required: `Makefile`、插件package/version同步文件（通过owning scripts）。

**Interfaces:**
- Consumes: 所有Task结果；产物入口为一个父会话、项目HTML与计算表。
- Produces: acceptance报告含测试命令/结果、真实验收项、知识内容未就绪项，不能以测试fixture冒充线上上线。

- [ ] **Step 1 — 写新的失败集成断言。** 一条链涵盖启动成功→页面无轮询→三住宅一方案逐对象→正确知识/截图→计算→HTML/Excel；第二链住宅+商业partial；第三链separate缺land blocker、不重复计价。测试缺失依赖允许明确skip，但关键交付链未执行不得称全验收完成。
  第四链在取详情和截图时分别注入可见挑战：先脚本恢复、重新验证原房源、正式图有效；预算耗尽保留waiting-user，员工继续后仅恢复该任务；会话/资料/已完成计算保持，隐藏验证码资源不能产生误恢复。
- [ ] **Step 2 — 跑集成红。** `node --test tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs`；用真实临时docx/xlsx/png，网络/Agent服务内存替身。
- [ ] **Step 3 — 补集成接线和当前文档。** 独立profile视觉验收：导航保持、门禁在正文、深色/窄面板、抽屉focus/footer、跳转失败重试，不存在旧页/定时器。browser-check普通只读模式不能创建真实估值，测试创建使用明确独立fixture入口。README中英结构一致，说明首期范围和两类成果；dated旧设计保持历史。
- [ ] **Step 4 — 跑集成绿并完成最终门禁。** 窄集成 PASS 后只跑下面一套；不要额外再跑重复 npm check/test/build。协议已统一；本期配置与交付形态变化须按现有版本同步脚本更新包版本（基线 0.0.42 时使用 `npm run version:set -- 0.0.43`；实施前若基线已变，按当前源码取下一补丁版），同步 changelog，不发布。
  ```bash
  # 仓库根；Go有行为改动才需要make test。
  make test
  make plugin-check
  make docs-check
  git diff --check
  # 业务层自包含目前不在完整门禁单独root验证，补一次。
  cd plugins/dsh-crwu-workbench
  python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/biz
  ```
  真实browser-check必须有有效的`--url`及所需`--playwright`路径；带授权token只通过安全本地参数传递，不写文档/日志。实际站点登录、online解析和截图在员工授权环境验收一次，不能从测试通过推断实际外网站点可用。
- [ ] **Step 5 — 交付工作区diff和验收记录。** 标明未实现的land/income/cost、不具备的重算/在线能力、知识库缺失，以及如何通过HTML观察。无自动commit/push/tag/publish。

## 回测调度规则：避免拖慢 Goal

1. Step 1/2 只跑新增失败断言，证明它会因为对应缺陷失败；同一阶段继续小改不重复全套。
2. Step 4 跑当前任务或当前边界相关测试。失败修复只重跑失败文件和直接依赖；不要重跑所有Client/Host/Go/Python。
3. typecheck在跨层接口任务完成时跑，样式/文案小改不每次跑。build/smoke/pack只在最终完整门禁或确有bundle/package故障时跑。
4. 全量只在Task12集成结束跑一套；make plugin-check已包含npm check/build/smoke/pack等，不再手动重复。
5. 完成后的新修复只补相应窄测试；影响协议/注册/包形态才需要重跑相关整门禁。不能为了“一次全量”而忽略新风险。
6. 测试输出只记录摘要与失败原因，不输出完整DOM、文件全文、Cookie、Token或原始命令。共享fixture固定业务阈值只能标测试样本，不把它当生产知识。

## 与设计要求的任务覆盖

| 设计要求 | 任务 |
| --- | --- |
| 房地产入口、住宅市场法限制、既有视觉语言 | 1、4、12 |
| 资料1–30、元信息、冻结摘要、只读确认 | 2、4 |
| CLI真实登录、局部拦截、其他目录可用 | 3、4 |
| 一个父会话、立即导航、删多余页/轮询 | 2、4、11、12 |
| 业务库身份、03/04职责、精确节点与同名恢复 | 5 |
| 方案对象分组、方法选择、多方法冲突 | 6 |
| 房地分别、未来土地Skill、依赖图与范围 | 1、6、7、9、11 |
| 根据Agent状态动态并行/顺序、超时不重复 | 7 |
| 方法抓取能力、固定provider/DOM、截图 | 3、8 |
| 人机验证先固定脚本、有界恢复、断点继续与原房源验真 | 3、4、8、11、12 |
| 模板实际下载、脚本计算、重算、对象计算表 | 9 |
| HTML数据Schema、截图展示、中断报告 | 10、11 |
| 去页面后仍严格完成校验、项目汇总 | 11、12 |
| 阶段窄回测、最终一次全门禁 | 每Task Step4、Task12 |

## DeepSeek Harness 执行提示词

以下内容在用户审阅计划后，可作为实现任务输入；它不是对当前聊天立即实施的授权：

```text
请在crwu-ai仓库按2026-10-14-realestate-session-workflow设计稿和实施计划逐任务执行。
先读取AGENTS.md和插件规则，保留现有用户未跟踪文件，不提交、不推送、不发布。
房地产导航保留，当前仅住宅市场法可完整估值。页面只负责登录、资料、确认和创建一个父会话，成功后跳转；删除后续进度、结果与轮询。
对象分组和方法判定在父会话完成；业务规则来自正确业务知识库/身份验证镜像；缺失先精确查目录/同名文件，仍缺就出中断HTML。
方法需要的浏览器/取数/模板能力必须通过实际注册与adapter验证；Agent不能自己试错抓网页。
链家/贝壳可见人机验证先调用注册的脚本恢复能力，不能默认失败。按设计稿8.4复核归档参考，将固定probe与CDP重放沉淀到crwu browser recover，再由估值Tools调用；最多2次/120秒，冷却由Host处理。脚本exit0不等于通过，恢复后验证原房源并重新截图；未恢复保存waiting-user等待员工继续，不重建父会话，不把挑战图当案例。
状态健康可有界并行，未知或资源不足在父会话顺序；用执行lease防止超时后的重复任务。
房地分别评估保留土地/建筑物任务图，土地Skill当前未实现则阻断受影响方案，不造空Skill、不重复计算土地价值。
截图按案例存推理结果/图片，HTML展示，Excel写路径。脚本计算并验证知识阈值与来源，缺重算只能partial。
每个Task按计划先关键失败断言，完成后只做窄回测；全部集成后跑一次完整相关门禁，不每次修改就全量测试。
完成时给出diff、验证摘要和未完成真实验收项，不用模型声称完成替代finalize校验。
```

## 本计划自检结果

- 原需求与新增土地扩展均映射到Task；没有新增已被取消的插件运行页面。
- 生产normative规则与测试fixtures区分，正文缺失/模板缺失/能力缺失均有中断出口。
- 多对象、多方法和房地组件不混成单对象模板，也不把市场法房价与土地重复相加。
- 状态未知顺序路径不依赖子Agent服务；child创建超时保留lease直到确认静止。
- 所有数字与交付状态由脚本/Host校验；面板删除不删除安全门禁。
- 计划未实际运行未来产品测试；新增测试路径标为Create，既有路径以当前基线核对。实现时根据真实文件diff更新，不用旧聊天中的不存在文件名猜路径。
