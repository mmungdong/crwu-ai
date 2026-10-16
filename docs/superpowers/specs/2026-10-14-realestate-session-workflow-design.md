# 房地产估值：单父会话、知识驱动 Workflow 与交付设计

> 文档性质：2026-10-14 的设计交接稿，用户已同意继续细化实施计划；新增房地分别评估扩展边界供一并审阅。不是当前已实现能力的说明。
> 接收方：DeepSeek Harness 中负责 crwu-ai 的实现 Agent。
> 本稿对照源码基线 `4c12b85`（工作台协议当前为 34）。实施前检查最新差异，不覆盖用户未提交文件。
> 本文合并本次讨论的 UI/UX、知识库、浏览器、分组、调度、计算与交付要求；如与早先聊天方案冲突，以本文中明确保留的用户要求为准。

## 1. 目标、范围与已确认决策

将房地产估值页收敛成会话启动入口。员工完成登录、选择资料、填写条件、确认输入后，只创建一个父估值会话，提示成功并自动打开该会话。对象识别、方案分组、方法判定、知识下载、数据抓取、计算和交付都在该会话中完成。

已确认的要求：

1. 默认简体中文，沿用工作台“办公风 + Apple”视觉、两级目录和单层工作面。
2. 浏览器门禁只放在房地产二级目录正文内；门禁时其他二级目录仍可切换。基础环境继续由既有共享环境模型判定。
3. 递归选择至少 1 份、至多 30 份文件。主页面右下角叫“确认”；只读抽屉主操作叫“开始估值”。
4. 抽屉只展示文件元信息与用户填写的条件，不展示规范、完整提示词、分析结果或 Agent 运行详情。
5. 创建成功后跳转父会话；删除估值页面后续进度、结果、完成度追踪和交付件管理页面。
6. 先识别对象并分组，再确定各方案方法。相同小区或区域可形成一个方案，但保留逐对象计算；不同物业类型或规则条件须拆方案。
7. 多方案始终属于一个父会话。按 Harness 实际 Agent 状态动态并行；负载高、状态未知、子 Agent 服务不可用时在父会话顺序执行。
8. Skill 是能力与编排契约，业务知识库才提供业务依据。知识缺失先检查对应节点、目录与同名文件；无法补齐则中断受影响方案，生成说明原因的 HTML。
9. 正常业务交付主要是 HTML 和计算表。JSON 为内部数据契约；截图在推理结果目录内按案例归档，并在 HTML 展示。Excel 记录图片相对路径，无须嵌图。
10. 按具体步骤完成后运行针对性回测；最终集成完成后做一次相关完整门禁，不在每次编辑后重复全量测试。

首期可完成的测算范围仍是住宅市场法。多类型识别、方案拆分和未支持方法的中断报告本期必须实现。收益法、成本法正文与模板为空或预留时，不能以“软件只支持市场法”为业务理由强行改用市场法。

导航二级目录继续叫“房地产”，页面明确“当前支持住宅市场法估值”；继续使用现有 `crwu-biz-valuation-realestate`，通过能力声明和执行分支限制首期范围，暂不新建住宅市场法子 Skill。未来知识和实现齐备后才扩展分支或拆子 Skill。

未来房地分别评估必须预留：房地产方案可以包含土地与建筑物依赖任务；土地任务由未来 `crwu-biz-valuation-land` 提供。当前没有土地能力则受影响方案中断，不伪造 Skill、土地结论或合并总价。导航是否启用“土地”由实际可用能力决定，不因预留接口就宣告完成。

本次不新增独立估值控制台，不重做报告审核，不发布包，不提交、推送或修改线上知识库。知识库治理清单由本稿给出，实际上线内容需由业务负责人维护。

## 2. 与当前代码的差异

以下路径除 CLI 外，相对于 `plugins/dsh-crwu-workbench/`。

| 边界 | 当前事实 | 目标变更 |
| --- | --- | --- |
| Go 浏览器 | `internal/transport/cli/browser.go` 已有 profile/login/status/fetch/shot；`--sites` 接受 JSON 数组 | 复用，不重新写浏览器；补必要可靠性、进程并发和站点配置验证 |
| 人机验证 | `internal/platform/browser/action.go` 检测到 captcha 即返回失败，不输出正式证据；当前未接入归档的滑块尝试脚本 | 保留证据拒绝规则，新增固定脚本 recovery；估值工具先自动尝试、再断点等待用户，不能默认结束估值 |
| CLI 适配 | `src/host/integrations/crwu/run.ts` 的 `crwuOperationOf` 只接受 h3yun | 登记 browser 子命令对应 Broker 操作，使用包内二进制 |
| 浏览器预检 | `browser/preflight.ts` 通过普通 HTTP provider 判断公开检索是否可用；打开登录是默认浏览器 URL | 改成同一 CLI profile 的真实 status/login；普通页面可访问不等于已登录 |
| 市场来源 | `browser/providers.ts` 固定 fang/anjuke/lianjia；模板标记待真机核对；城市值直接代入 host；解析只有 JSON-LD 等通道 | 把链家与贝壳作为独立站点，规范城市标识，增加已验证 DOM 解析；Agent 不自由拼 URL/选择器 |
| 截图 | `src/host/apply.ts` 有截图注入接缝，当前未装配实际 screenshot 能力 | 接上 CLI shot，绑定案例证据目录、截图校验和 manifest |
| 资料入口 | `valuation-intake` 建目录、复制、提取、用本地 reference 预检知识，返回大量抽屉字段 | 页面 intake 只做元信息、资料快照和确认契约；完整提取移到父会话一次完成并复用 |
| 文件数量 | 复用 `domains/local-audit/scan.ts`，已有递归、realpath 去重、符号链接策略和 30 份上限 | 保留算法，补 metadata 与数量回显；不改变本地审核规则 |
| 输入完整性 | `readManifest` 可直接信任清单内 digest；复制指纹来自复制前读取的源字节 | 启动强制重算规范化输入摘要并验证归档字节，不能只比较一段自报 digest |
| 页面结构 | ReportEvaluationPane 渲染 Intake、Confirmation、Progress、Result | 只保留门禁、输入、确认、交接反馈 |
| 页面轮询 | `src/client/shell/WorkbenchPanel.tsx` 的估值 interval 在页面外仍轮询 | 删除估值专用完成度轮询；报告审核的轮询不动 |
| 会话创建 | `valuation-start` 已走 `workspaceSessionService.createSession`，但仍进入 running 并等页面判完成 | 改为一次性创建、交接和导航；幂等保存 parentSessionId/dispatchReceipt |
| 完成判定 | operations 内 `confirmCompletion` 依赖 `valuation-status` 才检查三件文件 | 移到明确的 finalize Tool；无需面板存活，不允许简单删掉校验 |
| 数据模型 | scope/result/schema 以单对象、单方法为基础 | 引入项目→方案→对象三层；沿用对象级校验，增加方案与项目汇总 |
| 知识路由 | `knowledge/route.ts` 寻找旧的扁平七节点；缺少正文时 fallback 到 Skill references | 精确匹配实际分层目录，按阶段读取；移除 Skill 规范副本作为生产兜底 |
| 知识下载 | `tools/report-evaluation/knowledge.ts` 只按文本读回，xlsx 不能用该通道完成 | 文本导出与二进制下载分开；模板单独 materialize、验指纹和结构 |
| 报告 | `build_report.py` + HTML 模板已有，但从结果 JSON 拼表，未完整展示轨迹/图片，不支持无金额中断 | 新增 report-data Schema，统一 renderer 支持 completed/blocked/partial/failed |
| 工作簿 | build_workbook/check_workbook/market_rules 已有；规则阈值和取整部分写在代码；重算依赖 Excel/LibreOffice | 复用计算原语；业务参数和阈值从知识快照进入；明确重算能力门禁 |
| 注册契约 | `shared/contracts`、`shared/wire`、frozen-inventory 和 consts 同时包含旧 RPC/Tool | 同步增删、升级协议；用实际注册表和 scoped tool filter 做校验 |

### 2.1 知识库基线不能误认

用户展示的目标目录为：

```text
中瑞世联业务知识库/
  01 估值与测算/
    01 房地产/
      01 房地产估值通用/
      02 估值方法/
        01 房地产评估方法选择方案
        02 市场法
        03 收益法（TODO）
        04 成本法（TODO）
      03 案例选取/
      04 参数与税费/
      05 计算表模板/
```

本机 `~/knowledge-中瑞世联业务业务知识库/_manifest.json` 实际 spaceName 为“中瑞世联评估审核知识库”，本地文件也有空格/连字符命名差异。仅有目录名或同名文件不能证明它是目标业务库的缓存。不能改 manifest 的库名后就认为迁移完成。

本次离线检查发现本地住宅模板与包内模板均有七张可见表、250 个公式单元格；这仅说明形状相近，不代表每格公式、参数或知识版本等价。两个现存未跟踪模板文件属于用户材料，本次不删除、不覆写、不自动加入发布包。

## 3. 架构与交接边界

```text
房地产启动页
  ├─ 基础环境与房地产浏览器门禁
  ├─ 文件元信息扫描、归档预览
  └─ 确认 → 创建一个父估值会话 → 原生会话导航

父估值会话 + crwu-biz-valuation-realestate Skill
  ├─ 提取与对象识别
  ├─ 下载通用知识、完成方案分组
  ├─ 方法选择 → 方法正文 → 数据与证据 → 模板 → 计算 → 交付
  ├─ 有能力且运行状态健康：委派方案子 Agent
  └─ 其他情况：父会话顺序处理独立方案

结构化 Tools → 估值域服务 → provider / Broker
  ├─ 浏览器适配 → crwu browser → 持久 profile
  ├─ 知识适配 → DWS → 业务知识库
  ├─ 文件适配 → 受控案例路径
  └─ 脚本适配 → DSH Python → 计算、校验、渲染
```

浏览器、文件、知识和计算服务不依赖 DSH 会话语义。DSH 调度与 Tool filter 是外层适配器。不要让 Go CLI 知道房地产分组或具体估值方法，不让 provider 相互导入。

页面和会话拥有不同状态：页面只知道“是否可以创建、是否已交接”；会话内执行记录知道“方案是否计算/中断/已校验”。后者为执行必要记录，不提供面板进度 API，不后台轮询全局估值完成度。

## 4. UI/UX 设计与交互

### 4.1 视觉与导航

复用 `docs/ui-design-guidelines.md`、`src/client/styles/tokens.ts`、shell navigation、SideDrawer 和共享控件。

- 侧栏依旧一张分组卡：报告评估 / 报告审核 / 环境信息；目录条位置与顺序不变。
- 一级“估值”和二级“房地产 / 土地 / 机器设备”保持可见。登录门禁只替换房地产正文，不覆盖目录导航。
- 主面板只有一层 Workspace Surface，内容内部用间距、轻分隔线；不新增 Dashboard、并行 Agent 看板、方案确认页和结果页。
- 工作面最大宽度 1120px、居中；容器查询适配实际可用宽度，约 500px 窄面板不能横向溢出。
- 字体跟随 DSH；正文约 13–14px、元信息 12px；绝对路径用 12px 次级色、允许换行并可选中复制。
- 颜色只引用实际存在的 DSH/CRWU token；深色跟随 `body[data-ds-dark-theme]`，不使用系统 prefers-color-scheme 覆盖 DSH 设置。
- 保留已存在的 `crwu-valuation-*` 模块类，不因旧文档的前缀建议批量改名；新增类采用模块已有命名模式，并由 `scopeCss` 限定到 `data-crwu-scope="workbench"`。
- 样式仍随 client bundle 注入，不新增外链 CSS、react-dom 或独立网站。
- 一屏一个 primary；中性按钮一致。动画 120–160ms，支持 reduced-motion；不动画 width/height。

### 4.2 房地产登录门禁

进入房地产时异步 status。加载直接显示“正在检查案例来源登录状态”，不能显示未登录空态。显示站点行：名称 / 状态 / 必要说明 / 登录或重试动作。

默认首期检查链家与贝壳；这只是待实现的插件来源配置，不是业务案例一定要两站都有。登录组、required/optional 与站点启用状态由可信配置声明，不能放进全局 required 环境列表。站点实际是否共享登录，以两站 status 分别验证为准。

`authenticated` 才释放；`unauthenticated` 显示“登录链家”“登录贝壳”；`unknown` 展示网络、验证或风控原因及“重新检查”，不能要求无意义的反复登录。多个登录入口均使用中性按钮，只有“重新检查”可成为当前工作面主动作。

点击登录立即拉起可见的 CLI 浏览器，不能先串行探测所有来源再打开。login 结束后必跑权威 status；Cookie 存在不能直接宣告成功。禁止把用户普通浏览器已有 Cookie 导出到插件；统一复用 CLI 自己的持久 profile。

登录过程允许切目录；旧请求通过 request generation + AbortSignal 失效，晚到响应不能覆盖新页面。只允许单个 profile 上一个登录任务，其他点击复用状态或说明正在登录。

### 4.3 资料输入

纵向：待评估资料 → 方法 → 可选基准日 → 可选补充要求 → 粘性操作栏。

- 复用原生文件/文件夹选择器，不宣称支持未接入的拖拽上传。
- 递归去重后的文件数作为数量依据，不能用用户选中的目录数代替。
- 相同真实路径只保留一次；相同文件名但路径不同保留两条；不同路径字节相同标记重复内容，并保留来源关系，解析可以复用。
- 超过 30 整批阻止，不悄悄截取；0 份、全部空或不可读不能启动。沿用扫描深度/目录数量保护和符号链接不跟随策略。
- 元信息：fileId、原名称、absolutePath、type、sizeBytes、createdAt、mtime、可读状态、重复提示。birthtime 不可靠时 createdAt=null，显示“创建时间未知”；不能拿 mtime 冒充创建时间。
- 清单前 8 条可折叠，提供“显示全部 N 份”；长路径可换行，删除按钮视觉紧凑但命中区域 ≥44px。
- 首期“自动判定”“市场法”可选；收益法、成本法保留禁用选项及“尚未提供完整知识与模板”。Host 同样拒绝不支持的输入，不能只禁用 UI。
- 基准日为空原样冻结；不能自动从资料日期填入。会话取数区分成交日期、挂牌日期与采集时间。若未指定，以采集时点组织数据，并明确这是未指定基准日的测算，不能宣称历史时点价值。
- 补充要求是原样用户输入，只增加流程/项目要求；不能放松知识规则、补造证据或扩大 Tool 权限。建议长度上限 4000 字符，同步 Client/Host。
- 右下角唯一 primary：“确认”；禁用原因可见并以 aria-describedby 关联。

### 4.4 只读确认抽屉

点击“确认”只做递归校验、字节归档、元信息回显和确认摘要，**不在此调用模型分析、拉取整套知识或抓案例**。瞬时 pending 文案“正在准备确认信息”，无需新增提取进度页。

SideDrawer 标题“确认本轮估值输入”。每行显示文件名、类型、大小、创建日期、原始绝对路径；重名附目录或短 fileId。下面显示用户选择的方法、基准日（未指定时明确显示）、补充要求。

底部固定：中性“返回修改” + primary“开始估值”。移除当前抽屉的“重新检查”、知识状态、已知/缺失字段、冲突表、完整 Prompt、取证能力和 digest 展示。错误提示归外层交接状态，不往抽屉塞业务结果。

Esc、遮罩、关闭按钮等于返回修改，保留输入。打开焦点进入抽屉标题或第一项；Tab/Shift+Tab 限定抽屉、背景 inert；关闭后回到“确认”。增加 footer 插槽时保持其他审核抽屉兼容。

### 4.5 创建与跳转

“开始估值”期间按钮改“正在创建会话…”，禁用重复点击。成功必须包含：快照验证成功、父会话正确归组、scope 已登记、固定指令已被接受。

提示“估值会话已创建，正在打开…”后立即调用 `uiWorkspace.openSession(sessionId)`，必要时 `layout.selectPanel('conversation')`；这里是顶层父会话，不调用 openSubagent。

不延时数秒让员工盯成功页。提示使用既有 notice/role=status。导航失败显示“会话已创建，自动打开失败”，提供“打开估值会话”，重试导航不能重新创建。指令发送失败保留 sessionId，重试向同一会话交接，不能留下重复空会话。

成功跳转后停止所有页面请求与计时器。再次进入房地产显示新的草稿入口，可保留最近创建会话链接，无状态看板。

## 5. 页面 RPC 与交接事务

保留操作名但重写职责，必要新增 login/cancel 专用操作；所有字段由 shared wire 校验。

| RPC | 参数 | 输出与约束 |
| --- | --- | --- |
| valuation-files-scan | paths | 展开文件 items、fileCount、overLimit、可读数与元信息；Client-only 回显原始路径 |
| valuation-browser-preflight | 无自由 URL | status 三态及安全原因；不读取用户输入页内容 |
| valuation-browser-login（新增） | siteId | 启动既定站点人工登录；返回 jobId/受理状态，独立 status 可查询当前登录任务 |
| valuation-browser-login-cancel（新增） | jobId | 取消本页发起的登录任务，不操作别人的浏览器实例 |
| valuation-intake | requestId、paths、method、baseDate、supplementalPrompt | 创建资料归档预览；files + previewId + inputDigest；无业务提取/知识/外网抓取 |
| valuation-start | previewId、confirmedInputDigest、requestId | 从 Host 预览读取全部条件，不接受 Client 重新提交一套方法条件；返回 parentSessionId、projectId、dispatchAccepted、reused |

login 的短状态查询只是手动登录生命周期，允许页面存活时有界查询；它不属于估值会话完成度追踪。取消草稿准备如需保留独立 operation，应名为 intake-cancel，不沿用运行期 valuation-cancel。

删除页面相关 valuation-status / valuation-result / valuation-open-artifact / 运行期 valuation-cancel。按引用检查移除门面、wire、冻结清单、Client consts 和注册表，不能只把页面隐藏。

交接顺序：

1. 在 Host 内解析已选 workspaceId 和预览；拒绝缺摘要/过期预览/条件变化。
2. 对归档副本逐文件验大小与 sha256；计算摘要覆盖有序文件 manifest、method、baseDate、supplementalPrompt 和 Schema 版本。原始绝对路径不进入模型快照。
3. 先落 handoff pending 记录，再调用统一 workspace-session 创建父会话；同一 requestId 加互斥，同一 preview 只能成功交接一次。
4. 回读 cwd 与工作区归组，绑定父会话 scope；写只读输入与交接 manifest。
5. 以可重试的 dispatchReceipt 发送固定指令。收到 accepted 后写 handed-off；请求超时再次查询/重试只复用同一会话。
6. 返回 Client 自动导航。后续结果与 finalize 完全不依赖 Client。

复制必须以归档后的字节验指纹；不能先读源算 hash 再 cp 而不检查目标。预览完成后源文件被改动不改变已归档输入；归档副本改动则强制重新确认。临时产物与正式交接原子切换，取消或失败不能误报已启动。

## 6. 知识库与 Skill 协议

### 6.1 路由、发现与同名恢复

`routeId` 是 Skill 自带技术路由标识，库路径是知识目录事实，正文是业务规则。三者分开。

| routeId | 目标范围 | 加载时机 |
| --- | --- | --- |
| realestate.common | 01 房地产估值通用 下对应通用文档 | 分组前 |
| realestate.method-selection | 02 估值方法/01 房地产评估方法选择方案 | 每方案方法分析，包括手选方法可行性 |
| realestate.method.market | 02 估值方法/02 市场法 | 选择 market 后 |
| realestate.method.income / cost | 相应方法正文 | 仅被选择/需要时；空文档返回未支持 |
| realestate.case-selection | 03 案例选取 下对应物业/方法规则 | 案例搜索前 |
| realestate.parameters | 04 参数与税费 下相关参数文件 | 需要该参数前 |
| realestate.template-index | 05 计算表模板 的索引说明 | 参数/方法已明确、取模板前 |
| realestate.template.market.residential | 索引指定的已发布住宅 xlsx | 案例/参数齐备后、填表前 |

先精确定位业务库身份，再读取一次目录树，catalog → resolve → materialize → validate 是四个内部步骤，不为每一步强行新增一个 Tool。

缺失恢复：精确路径 → 目标目录下同名文档/附件（可匹配明确的 .md/.xlsx 后缀）→ 明确配置的历史别名 → 通过业务库身份验证的本地镜像同路由文件。所有候选均留下检查记录。相似标题、全库随意模糊命中、文件夹标题当正文均不允许。多命中为 ambiguous，不选第一份。

缓存只在 manifest 空间身份、route、文件 hash 均可验证且节点未被确认废止时使用；远程缺失可按本地同名恢复，但远程明确为空/撤销/废止不能被旧副本掩盖。恢复材料来自业务库镜像，不来自 Skill `references`。

缓存目录属于 Host 配置，仅允许在该根范围读；Skill 和模型不获取本机 mirrorRoot。当前已给目录身份不符，因此不能默认启用它。

### 6.2 按阶段下载而非全量注入

父会话先下载通用分组口径与方法选择文档；每方案确定方法后只下载对应方法、03 相关选例、04 相关参数；数据整理后读取模板索引，再下载一个实际匹配的已发布模板。不能因为 method=auto 就下载收益/成本全文和所有模板。

每次物化输出 source=dws 或 verified-mirror、routeId、实际节点名、resolvedPath、updatedAt、digest、snapshotFile、恢复查找轨迹。正文非空、索引落盘、模板验真全部通过才返回 ok。知识引用使用 snapshotDigest + section/ruleId；只有正文 hash 不足以证明某条参数存在，还需核对节/规则字段。

一个方案一轮固定快照；中途发现规则更新不静默换版本。共享源可复用下载，但给每方案固定独立 manifest；共享目录只读，子 Agent 不改别方案快照。

### 6.3 业务规则与可执行配置

知识库方法/参数文档增加受 Schema 限制的结构化规则段（例如 JSON fenced block）。只允许数据声明：适用对象、规则标识、阈值、单位、比较方向、日期窗、取整、参数来源、所需 capability ID 和 templateId。不允许可执行 JS/Python、shell、任意 URL 或选择器。

Agent 可分析自然语言和证据，但运行数值规则必须从已物化文档结构化字段获得；Host/script 独立核对字段来自该快照。缺结构化参数不允许 Agent 按记忆补数；形成知识缺口报告。

Skill 保留调用顺序、Schema、技术公式原语、模板映射接口、失败分流和证据记录；移出市场法阈值、面积筛选范围、税率、案例最少数量等业务正文/默认值。适用条款的业务强度（必须/应/不宜）由知识库明确，超限处置按快照，不能由程序一律删案例或自由放宽。

### 6.4 03 与 04 的内容清单

03 是截图中房地产层的“案例选取”，**不是**方法目录内的“03 收益法”。建议目录文件：

| 文档 | 必须维护的内容 |
| --- | --- |
| 00-案例选取目录与适用范围 | method × propertyType 路由、已发布/空/预留状态、规则版本 |
| 01-住宅市场法案例选取 | 城市/小区/用途/权利/面积/交易日期等筛选、候选与采用数量、拓展检索阶梯、终止条件 |
| 02-案例记录与证据要求 | 字段清单、来源、挂牌/成交/询价区分、日期语义、图片/页面取证要求、不可核处置 |
| 03-跨来源去重与采用记录 | 房源 ID 优先；链家/贝壳同房源合并来源，特征匹配仅候选重复；保留/剔除理由 |
| 04-其他物业与方法选例（预留） | 仅说明未提供完整规则，不能作为运行依据 |

现有 02 市场法已有渠道、筛选、因素等大量正文；治理时拆出共享规则放 03，市场法保留流程与链接，避免两份不同阈值。实际数值必须由业务维护者提供，不在本方案发明。

04 是“参数与税费”，**不是**方法目录内的“04 成本法”。建议：

| 文档 | 必须维护的内容 |
| --- | --- |
| 00-参数目录与来源原则 | 参数索引、地区/用途/日期适用性、依据等级和冲突处理 |
| 01-住宅市场法价值内涵与税费 | 价税口径、买卖双方正常负担、适用税种/税基/条件/有效期/权威来源 |
| 02-市场状况与交易情况修正 | 日期指数来源、挂牌与成交转换证据、修正方向、公式 ID、变量和缺值处理 |
| 03-房地产状况修正参数 | 因素、档位、评分和修正系数、权利条件；每个取值如何引用依据 |
| 04-参数记录与缺失处理 | value/unit/valueDate/region/sourceRef/ruleRef，null 与不适用/0 区分、必需参数缺失时中断 |
| 05-收益与成本参数（预留） | 报酬率、空置率、收益年限、重置成本等未来方法参数；不假装首期可用 |

参数来源不能简单写成“用户提示比政策优先”或“文件值永远优先”。项目事实与规范约束分开，按知识库规定的适用时点/地区/条件验证；双方冲突记录双方证据。该清单是内容职责，不能填空税率或引用未经核对的法规。

## 7. 父会话 Workflow：项目→方案→对象

### 7.1 材料提取与对象分组

父会话 bootstrap 后调用现有 file-extract，保留全文/表格和来源坐标；一份输入只提取一次，hash 相同复用结果。PDF 扫描/OCR 不可用返回明确缺口，不按文件名猜资产。记录每对象的 source fileId、页/表/单元格可用坐标；提取器不给坐标则明确粒度。

先加载通用知识，形成对象清单，再分估值方案。同小区/同地域只作为候选分组信号，不能自动共享计价面积、权益、案例权重或价值结论。

同一方案需满足规则兼容：物业类型、评估目的、价值类型、基准日、权益/价税口径、市场范围。方法尚未确定时这些字段形成预分组；判方法后如不同再拆分。

分组由父会话输出项目估值方案索引.json，字段：projectId、planId、objectIds、propertyType、purpose、valueType、baseDate、groupReason、materialRefs、conflicts。可验证的分组自动继续；关键未知/冲突在原生会话询问员工，不能增加插件 plan-review 页面。

住宅多套可同方案多对象，逐对象保留 cases/parameters/calculation/result。复用案例证据不等于共用修正系数。方案汇总须逐行反映对象；项目金额只有地区/时点/币种/权益可加且知识规则允许时由脚本合计，否则只列各项，不给误导性总价。

### 7.2 方法选择与实际能力

每方案读取 `01 房地产评估方法选择方案`，记录所有适用方法与未选原因。用户 market 是约束，不是可忽略建议；不可用时记录 methodConflict，并在父会话请求确认，不悄悄替换。

当前知识选择方案涉及主/辅助方法，现有 Schema 恰好一个 adopted 不能直接视为永久业务规则。新契约区分 primaryMethod、selectedMethods、每个 method assessment；首期 market 结果不代表完整多方法业务要求。知识要求另一必要方法而实际未实现，则中断并解释，不能写“成本/收益软件未支持，因此业务不适用”。

方法选定 → 下载对应方法正文 → 获取相关 03/04 → 生成取数任务 → 校验 capability manifest → 调用已注册取数 Tool → 整理案例/参数 → 下载适用模板。取模板前可读取索引确认它已发布，避免抓完才发现一定没模板；实际 xlsx 按需下载在填表前。

### 7.3 房地合一 / 房地分别评估与土地 Skill 扩展

知识库方法选择方案含“房地合一与房地分别评估”判断，应在分组后、方法最终选定前解析 valuationPath，不能等到合计金额时才发现需要土地。

- `combined`：对象价值已包含土地权益，正常进入当前住宅市场法路径。
- `separate`：方案内形成土地任务与建筑物任务及必要的汇总任务，关联同一 objectId/parentPlanId，而非两份无关联估值。
- `unresolved`：房地权益边界或资料冲突在父会话请员工确认，不自行选路径。

新建执行任务合同：taskId、parentPlanId、objectIds、assetClass（realestate/land/building）、requestedCapability、dependsOn、valuationPath、valueScope、basisRefs、status。任务依赖图必须无环；土地与建筑物任务只有知识规则和输入允许独立取值时才允许并行。有前置依赖时先完成依赖，再启动下一任务；顺序模式保留同一图和结果合同。

未来土地契约标识 `land.valuation.execute` → 候选 Skill `crwu-biz-valuation-land`。实际 Skill 发现、结构化 Tool、知识路由、方法与模板全部验证后才 available；本期只预留映射与 unavailable 返回，不创建空壳 SKILL.md、不注册假土地工具、不硬编码外部仓库路径。其他 host 的访问方式沿用既有窄兼容边界。

每个组件结果明确 `land-only`、`building-only`、`land-and-building` 的价值范围，土地还须记录面积、用途、权利类型、剩余年限、基准日、币种和价税口径。汇总要求土地/建筑物范围无重叠且相关对象一致；知识允许的组合方式由脚本执行。含土地的住宅市场法价值不能再加一次土地价值。

本期触发 separate 时先保存任务图与方法依据，发现 land 能力或 building-only 方法未实现即中断此方案，HTML 说明缺哪种 Skill/数据/模板。不能拿普通住宅市场法作为 building-only 替代，也不能把子任务 partial 数值写成房地综合结论。其他独立方案继续。

未来组件用独立 taskId 子目录、知识快照、证据和底稿，共用现有 lease 与动态调度；父会话等组件 finalize 通过后生成对应方案 HTML。用户仍只进入一个父估值会话，无新增插件土地结果看板。

## 8. 浏览器与方法取数能力闭环

### 8.1 capability manifest

capability ID 是 Host 技术契约，如 browser.auth.status、market.residential.search、market.residential.detail、browser.page.screenshot、parameters.market-index.read、template.xlsx.materialize、valuation.market.calculate、workbook.recalculate。

每能力记录 registeredTool、actualAvailability、支持物业/数据类型、失败类和 provider。方法文档只声明所需 ID；Host 取实际 scoped registry + provider 健康状态做 gate，名单写在 Prompt 不算实现。

如果方法要求插件没有的能力，父会话立刻给 affected plan 输出 blocked 报告；不让 Agent 调 shell、安装新库、试泛用浏览器工具、临时推选择器或反复重试。登录/captcha/network 分别处理：未登录引导员工登录；captcha 先调用已注册脚本恢复能力，不能直接宣告估值失败；network/rate-limited 按技术策略有界重试。脚本未恢复时保存断点并等待员工操作，见 8.4。

### 8.2 来源实现

按现有 MarketTransport 接缝新增 browser transport，CLI 统一 JSON envelope `{ok,data}`；非零退出也必须解析有效 data 的每站状态。Host 构建 URL、固定输出路径和 CLI argv。

可信技术站点描述放 Skill 自带 `assets/browser-sites.json`（CLI 实际需要顶层数组），作为站点连接配置，不是业务规范。Host 从安装包解析文件；Skill 只给 siteId。新增时核对受保护 URL、Cookie 名和 domains，不造一套未经验证的真实地址。

来源实现放 provider adapter：城市中文→站点 cityCode 有校验；检索路径按真实样本纠正；JSON-LD 优先、固定 DOM parser 兜底。fixtures 可用脱敏 DOM，零选择器命中返回 template-stale，不能返回“没有案例”。

详情页必须取得真实 URL、页面内容、挂牌/成交属性、日期、价格、面积与证据。列表页记录不等于详情取证成功。跨链家贝壳房源以源 ID/映射去重，保留多个来源证据；仅按小区+面积+价格不能吞掉不同房屋。

### 8.3 共享浏览器的并发控制

多个估值 Agent 可以并行推理/计算，但同一个 CLI profile 的 status/login/fetch/shot 必须通过 Broker 队列串行执行，或明确隔离 target 后再验证并发安全。首期串行最稳。

避免两个 Agent 互相导航同一 CDP 页面，造成“案例 A 的截图实际是 B”。截图必须回读最终 URL、页面业务标识和 manifest caseId。取消只取消调用者队列项；不能杀掉其他 Agent/用户拥有的浏览器。profile/CDP 凭据、日志保持现有脱敏要求。

### 8.4 人机验证脚本恢复：检测后必须先尝试

2026-10-14 新增用户要求：链家、贝壳拦截不能默认失败，必须先调用沉淀的脚本能力。此要求替代本稿早先“captcha 直接等待员工动作”的处理。技术恢复策略属于 CLI/插件能力；知识库 03 只定义来源、案例有效性与替代来源条件，不存放验证码解法或 CDP 指令。

**参考证据及适用范围。** 用户提供 `dsh-session-session-cdp-skip-891b-4687-9d48-3262c4b58c00.zip`；只读取历史工具调用中的脚本和结果，没有执行归档指令或连接员工浏览器。归档中的脚本由会话创建，不是 ZIP 根目录独立文件，实现者须按名称定位对应 write/bash 调用。

| 参考脚本/记录 | 已确认内容 | 集成时处理 |
| --- | --- | --- |
| `cdp.mjs`，主会话事件 253、369、393 | 有头浏览器、附着 target、DOM 读取、CDP 截图；后两次补 attach 和防止 import 执行 CLI | 复用现有 Go CDP，不复制硬编码 Edge 路径/端口或任意 `--eval` 入口 |
| `eval_geetest_state.js`、`gap_detect.py`，事件 363、369 | 读取可见 canvas/控件，完整图与缺口图差分，或背景与滑块图匹配 | 固定技术脚本和已测试图像计算；跨域污染、iframe/非 canvas、坐标比例均需显式处理 |
| `solve_geetest.mjs`，事件 375 | 计算缺口后用 `Input.dispatchMouseEvent` 拖动、回读页面 | 候选 `geetest-v3-canvas` 策略；记录证明脚本被创建，未发现执行该 solver 并通过验证的完整证据，不能先标 verified |
| `reshoot_one.mjs`，事件 850–851 | 冷却后重新进入原详情页、滚动、截图；记录首轮 captcha=false 并保存图片 | 候选 `cooldown-renavigate` 策略，有恢复访问记录，但不能据此断言 slider 被自动解出 |
| 页面探测，事件 414–415 | 贝壳业务内容可读，HTML 中仍包含 captcha 字样 | 隐藏验证码资源/脚本不能触发恢复；检测必须看最终 URL、可见遮罩/挑战控件与业务页标识 |
| 链家读取，事件 912–919 | 后续链家检索/小区页可读，前有员工单独登录操作 | 证明已登录 profile 可用，不证明链家/贝壳共享登录或自动滑块成功 |

旧 solver 在没有 canvas、dry-run 和拖动后均可能 exit 0；退出码不等于恢复。旧脚本还硬编码本机解释器、临时目录、任意首个 blank target，缺少连接清理/完整成功判定。归档中房天下的 Cookie 操作与链家/贝壳滑块不同，不能混入两站策略；不复制任何历史登录值。首期将上述算法适配成固定 CLI 脚本策略，经过 fixture 和独立真实页面验收再标 verified。

**实现所有权。** 新增通用 CLI `crwu browser recover`，仍使用既有 profile、Site 配置、CDP client 和 URL 校验；canonical scheme 描述命令与参数。建议合同：`--sites <file> --site <id> --url <originalUrl> --strategy <auto|cooldown-renavigate|geetest-v3-canvas>`。实施时以 scheme 注册后的准确 usage 为准；脚本名/路径、端口、Cookie、运行参数由 CLI/Host 内部决定，不由模型传入。

固定页面探测脚本 `internal/platform/browser/challenges/geetest_v3_probe.js` 随 Go binary embed；图像偏移计算与鼠标重放放 Go 小模块，采用标准库 PNG 解码，避免依赖旧临时 Node/Python 环境。这仍是“调用固定脚本尝试处理验证”，而非让 Agent 现场生成解法。脚本为 CLI 自带能力，Skill 安装后通过 `crwu scheme` 和结构化 Tool 使用，不引用源仓脚本路径。业务插件 Host 不新增 `node:child_process` 或直接 CDP 旁路。

Host 增加 `ChallengeRecoveryCoordinator`，由 BrowserTransport 在 search/detail/shot 检测到 challenge 后自动调用；结构化 `crwu_valuation_browser_recover` 用于同一取数任务的显式继续，输入仅 providerId、retrievalTaskId。两条入口共用幂等 recoveryId 和尝试预算，不能自动尝试两次后模型再开启两次。capability `browser.challenge.recover` 必须检查实际脚本、CLI 命令、适配器和 scoped Tool 已装配。

**固定状态流程。**

```text
原案例页取数/截图
  → 判定有效业务页 / 登录页 / 可见挑战 / 限流 / 网络异常
  → 可见挑战：创建 recoveryId + 原任务断点
  → 识别挑战族、调用已适配固定脚本
  → 回读挑战状态；必要时有界冷却后再次进入原 URL
  → 验证登录状态、最终 URL、房源 ID、可见业务字段、无阻挡遮罩
  → recovered：原任务继续取证，重新生成正式截图
  → 未恢复：waiting-user，保留原会话和资料，请员工在当前浏览器完成验证
  → 员工继续：先验证原任务页面，通过才从断点继续
```

不把所有 HTTP 403 当成 slider。仅存在隐藏 Geetest DOM/脚本不能判断 challenge；有价格字段但遮罩实际阻挡仍需处理。没有对应挑战控件/策略时返回 unsupported 并转 waiting-user，而非向 Agent 暴露任意脚本评估。真未登录不能用验证码策略代替登录；不填密码、短信验证码或替员工勾选登录协议。

登录状态与挑战可见性分开记录，不能只因现有 ClassifyPage 先返回 login-wall 就忽略真正出现的滑块。员工已发起登录、网页实际显示挑战时，login job 同样可调用适配策略辅助通过；之后仍须验证员工登录身份，challenge 消失并不释放未登录门禁。没有实际挑战的普通登录表单不运行 solver。

**预算与执行状态。** 一次取数任务的自动恢复最多 2 次，总窗口最多 120 秒；单次脚本/CDP 调用最多 30 秒。冷却由 coordinator 定时任务管理、释放 profile 队列，不让模型 sleep/反复调用；再次执行须重新取得同一 profile 与该任务 target 的租约。收到 Retry-After 超过剩余窗口时保存 nextEligibleAt，返回 waiting-user/可继续状态，不截短后轰击站点。相同 provider/profile 的新取数请求遵守同一 cooldownUntil，其他 provider 和计算任务可继续。重载/取消不重置预算，也不关闭用户 target；需要 input 重放的动作始终串行，并显式清理鼠标按下状态与自建连接。

恢复 receipt 至少包含 recoveryId、retrievalTaskId、providerId、strategyId/version、attempts、beforeKind、state（recovered/waiting-user/unsupported/cancelled/unavailable/failed）、reasonCode、nextEligibleAt、pageValidation。基础设施 failed/unavailable 与 challenge 未解分开；模型可见结果只给安全摘要。恢复判定由 CLI 页面检查加 Host 房源字段检查共同完成，不能信任脚本 console、exit 0、成功文字或仅 HTTP 200。详情页恢复后发生再次挑战，正式 shot 同样执行共享恢复流程，预算由同一任务累计。

**页面和交付体验。** 会话创建前的房地产门禁中遇 challenge，也先走该能力；正文显示“正在尝试恢复链家访问”，失败后显示“需要完成网页验证”及“打开验证页面 / 验证完成，重新检查”。这是登录检查阶段的有限查询，不恢复已经删除的估值进度轮询。创建会话后的处理留在父会话：一次说明自动尝试结果和需要的动作，其他独立方案照常执行；无需回插件页面、重传文件或重建会话。waiting-user 保存运行期 checkpoint，与财务结果 completed 分开；需要产出阶段报告时使用 partial/blocked HTML 并明确“等待网页验证”，不能写成“知识缺失”或“无案例”。

挑战 canvas/截图仅为临时排障材料，和 `推理结果/图片/<caseId-名称>/` 正式证据隔离，不能进入 Excel/案例 HTML。恢复成功后重新抓原详情页，校验 caseId、真实 URL 和 hash 后才转入证据目录。正式 HTML 可记录技术恢复次数、方式及来源验证结果，不展示 Cookie、挑战凭证、原始 CDP 指令或隐藏推理。

## 9. 根据 Agent 状态动态执行

### 9.1 使用真实 API，不假设空闲槽位

已检查依赖声明：Agent 有 idle/running 状态及 registry list/get；subagents 有 provider catalog、启动、listChildren 与生命周期，配置中有 maxActiveSubagents。配置上限不等于实时空闲容量；没有已验证的“CPU 快慢评分”或“remainingSlots”接口。实际启动入口按安装版本的 service/provider 声明适配，不猜方法签名。

在 `domains/report-evaluation/execution/` 新建调度决策纯函数与 DSH adapter，不复制整个审核 spawn 模块、不让估值依赖审核业务策略。借鉴 scope 预登记、toolFilter 和父子关系回读模式即可。

输入：provider/filter 能力、当前其他 running Agent 数、本项目活动任务、真实启动时长/拒绝结果、既定并发安全上限。输出 parallel/sequential + reason + admittedPlanIds。

### 9.2 首期保守规则

1. 单方案直接父会话执行。
2. provider 缺失、Tool filter 不可验证、状态无法读取、存在其他繁忙任务或上一启动拒绝：父会话顺序执行。
3. 多方案、当前运行状态明确且没有外部繁忙任务：允许启动首个方案子 Agent；回读 scope/filter/归组成功且启动健康时，最多再同时启动一个。并发上限 2 是安全上限，不是强制并行数。
4. 子 Agent 创建耗时超过 10 秒即停止扩张；该数只属于技术启动 SLA，不把慢网络直接解释成用户 CPU 慢。
5. 启动超时但是否已创建未知：保留 plan lease，等待/查询真实子身份和结束结果；不能立刻父会话再执行同方案。只有确认无活动执行者或已静止，才能顺序接手。
6. 未启动方案转顺序队列；已经运行的子 Agent 保持其工作，不盲目中断已完成工作。
7. 父会话顺序计算开始前，先等本项目活动子任务静止，防止名义上顺序但实际上争用资源。

不新增性能基准测试或持续监控定时器。调度状态变化/创建结果是信号；日志只记录业务安全摘要。以 projectId/planId/attemptId + 单执行 lease 防止重复写同一方案。

### 9.3 scope 和恢复

父会话可协调项目及其方案；子 Agent 只可写自己 planId 目录。顺序模式仍显式指定 planId，Tool 从父会话 scope 和项目索引派生目录；不让模型传任意 caseDir。

先 pending 方案授权再启动 child，回读 child 身份/工具过滤后发布；失败回滚。所有脚本参数中的读写路径均验证受控范围，不能靠 Prompt 隔离。

继续会话/插件重载时以绑定的父会话身份、项目 ID 和持久 handoff 校验恢复；不把任意绝对路径当成认领能力。无法验证时要求从原会话显式重新绑定，不自动跨项目接管。保留输入冻结验证，不因移除面板 lifecycle 而丢失归属校验。

## 10. 计算表、计算与结果契约

### 10.1 模板取得

使用知识库 05 索引中的已发布模板，按 propertyType × method × contractVersion 定位 templateId → route。空目录、标题预留、TODO 正文均不是可用模板。

复用 DWS 二进制下载，逐字节保存 xlsx，验 ZIP/工作簿结构、digest、公式区、输入映射和模板合同。不能把 xlsx 下载后作为 markdown 读回，不能以 CLI exit=0 代替文件验真。

现有本地“模板索引.md”是用户未跟踪文件且包含基线兜底策略，本期不将它当已批准的知识库规则。若知识库正式允许通用基线且它实际存在/已发布/适用，才允许采用；否则模板缺失中断，禁止从 Skill 旧模板偷换。

### 10.2 计算执行

复用 `market_rules.py` 的连乘、比较、取整等原语，新增薄的 calculate CLI/脚本入口；生产运行必传知识规则参数，移除默认业务阈值作为隐式依据。变量需带单位与 provenance。

Script 输入是经过 Schema 校验的对象数据、案例数据、规则参数、快照 digest。输出 Decimal 可追溯中间值、公式 ID、未取整数、按规则取整的结果、判定和来源引用。不允许任意公式 eval。

报告单位、金额格式同一处生成；renderer 只排版，不能再次四舍五入改变精度。实例计算结果不能反过来当修正参数凑价。

### 10.3 重算能力不是自动存在

DSH Python/openpyxl 不计算 Excel 公式。现有脚本要求 Excel/LibreOffice 重算，但仓库未证明员工机器都有自动重算 provider。

实现 `workbook.recalculate` 适配和能力探测：只有确实提供且经 Broker 验证，才运行本地 Excel/LibreOffice。缺能力时保留正确公式底稿并标“待重算”，生成 partial HTML，不能称已完成。若采用脚本生成计算校验值，须与模板公式做独立一致性核验；缓存值未更新仍不得伪报已重算。

一个方案内多个对象：保留共享模板下载快照，每对象独立填入值和工作簿实例，不在同一固定单对象模板上反复覆盖。方案底稿由技术合并脚本复制对象完整 sheet 集合并重写内部引用，加汇总；若不能保证引用/重算一致，交付“计算表/对象-xxx.xlsx”集合而不造错表。两者都属于计算表交付，不强制固定七张表承载无限对象。

## 11. 两类用户交付、图片与 HTML

### 11.1 目录

```text
<已选工作区>/<估值项目ID>/
  估值输入.json
  项目估值方案索引.json
  交接记录.json
  材料-源/                         原始资料只读归档
  提取结果/                       一次提取结果与 provenance
  方案/
    plan-001-住宅/
      知识快照/                   本轮实际知识和模板
        知识来源.json
      来源证据/页面/              网页内容、脱敏记录和 hash
      推理结果/
        估值对象.json
        估值案例.json
        估值参数.json
        方法判断.json
        计算轨迹.json
        估值报告数据.json
        估值状态.json
        图片/
          C001-案例名称/
            链家-详情.png
            贝壳-详情.png
            图片清单.json
      估值报告.html
      估值结果.json               仅通过正式结果门禁后生成
      估值底稿.xlsx               或 计算表/ 下对象级工作簿集合
    plan-002-商业/                可以只有中断报告，无金额结论
  估值报告.html                    项目入口，内嵌/汇总方案正文
  计算表/                         多方案时的交付索引/实例
```

输出文件名以安全 planId/objectId/caseId 为身份，中文名称是显示标签；禁止从网页标题直接拼路径。名称变动不会导致证据失联。

### 11.2 图片证据

JSON 包含 caseId、displayName、provider、sourceUrl、capturedAt、relativePath、digest、validity。路径必须位于当前方案推理结果/图片下；Host 验文件存在、可解码、内容分类、URL 与案例对应。

采用案例的截图缺失或无效先尝试知识规则允许的替代证据/替代案例；规则要求截图且最终未齐则中断/partial，不输出正式采用结论。未采用候选保留缺图原因，不会让无关候选缺图阻断所有方案。

Excel 写相对路径或相对 hyperlink，并写 caseId；不要求截图嵌入。HTML 显示案例缩略图、来源、性质、时间、采用理由，点图查看原尺寸并支持 Esc 返回。该预览属于独立报告 HTML，不回加插件结果/截图抽屉页面。

### 11.3 JSON 约束 HTML

统一 `valuation-report-data.schema.json`：schemaVersion、projectId、planId、status、inputs、objects、methodAssessment、knowledgeSources、retrievalAttempts、comparables、parameters、calculationSteps、ruleChecks、conclusions、blockers、limitations、artifacts。

HTML 完整过程是可复核的业务推导和工具轨迹，不保存模型隐藏思维链：展示事实来源→适用规则→方法理由→案例筛选→参数依据→公式与中间值→校验→结果。

使用判别联合：

- completed：必需 knowledge/method/calculation/conclusion、工作簿和证据校验通过。
- blocked：阻断 stage、缺失项、检查位置、原因、补齐动作必填；conclusion=null，xlsx 可不存在。
- partial：已有工作与未完成项明确分开，暂算金额不可作为最终结论显示。
- failed/cancelled：如实列阶段和已有文件，不标为已估值完成。

`build_report_data.py` 汇总经验证的结构化数据；`build_report.py` 在渲染前再验 Schema，按固定模板输出并原子落盘。模型不能直接写 HTML、任意样式或 HTML 片段。

独立 HTML 保持工作台办公风：标题和结论首屏、目录锚点、紧凑表格、明暗可读、长过程折叠但可展开打印、截图延迟加载、键盘可操作、打印不裁表。CSS/脚本内联，不依赖 CDN；外部标题和内容转义，安全嵌入 JSON、限制 href/src。

磁盘原始图片目录始终保留。员工下载/转发单个 HTML 时避免丢图：render 阶段脚本将已验证图片嵌入为 data URI，HTML 可独立离线展示；原始 relativePath/digest 仍在 manifest 可查。若体积过大，提供显式“含图片目录的报告包”，不可让断图悄悄出现。此处理不需要 Agent 把图片嵌进 Excel，也不消耗图片 base64 模型上下文。

### 11.4 缺失报告与完成校验

知识缺失时，affected plan 写估值状态.json + 报告数据 + 中断 HTML；没有方法/模板也能渲染。列出 exact lookup、同目录同名、别名/镜像检查及结果，区分 missing/empty/ambiguous/unreadable/unsupported。

一个方案中断不会停止可独立的其他方案；通用或方法选择必需规则缺失影响整个项目。中断后已生成材料保留为中间件，之前轮次成果不能冒充本轮结果。

新增 finalize Tool：Host 调真实校验脚本、验知识 hash/输入快照、案例与图片、逐对象数字与计算表、报告渲染和产物 manifest。保留原 `artifact_validate` 的有价值校验，移出 operations 的 `confirmCompletion`。模型称完成或 child end 只能触发校验，不直接写 completed。

JSON 是内部合同，会话主要给员工“打开估值报告”和“打开/下载计算表”，无需员工逐个找技术 JSON。默认本地交付，不新增 OSS 发布或通知他人。

## 12. 文件级改动与删除清单

### 12.1 Client

修改 `modules/report-evaluation/{index.ts,api.ts,controller.ts,model/valuation-state.ts}`：删 post-handoff actions、resultViewOf/applyResult 等；状态收敛 checking-auth/auth-blocked/draft/preparing-confirmation/confirmation/creating-session/handoff-failed/handed-off。

修改 `ui/ReportEvaluationPane.tsx`、`ValuationIntakePane.tsx`、`ValuationConfirmationDrawer.tsx`；新增 `ValuationAuthGate.tsx` 和薄的 `session/open-session.ts` adapter；服务 getter 在调用时读取，避免快照早注册能力。

删除 `ValuationProgressPane.tsx`、`ValuationResultPane.tsx` 及仅为它们服务的样式、model helpers、locale、exports。删除 `WorkbenchPanel.tsx` 的 VALUATION_POLL_INTERVAL_MS、估值 phase 订阅和 interval（以实际引用为准）；接入父会话 openSession。

修改 `src/client/apply.ts`、shell services、shared wire/API facade、locales 与 styles bundle。共享 SideDrawer 如补 footer/focus 行为需保持审核使用兼容。不能新增 ValuationEvidenceDrawer、ValuationKnowledgeBlockedPane、ReportArtifactPanel，这些旧建议已被“会话创建后跳转”取代。

### 12.2 Host

将 `operations/report-evaluation.ts` 拆成薄装配和 intake/handoff/auth-focused handler，不继续堆单文件。操作数量变化同步 `core/access/operations.ts`、注册表、wire、`tests/helpers/frozen-inventory.mjs`、`shared/consts.ts` 协议升级。

新增/修改估值域：`intake/` 元信息与归档、`project/` 项目/方案/对象模型、`execution/` 调度与 lease、`knowledge/` 分层路由/镜像验证/规则装载、`browser/` CLI transport 与 profile 队列、`delivery/` finalize。

`scope.ts` 拓展 project/parent/plan 归属；`lifecycle/` 只保留交接或执行所必需功能，移除面板完成度 registry 和无效状态。`tools/report-evaluation/record.ts` 不再写 UI progress；改为方案事件/结果 manifest。

复用现有 Tool 名：case_bootstrap、file_extract、knowledge_materialize、browser_preflight、market_search、market_capture、artifact_validate、run_python_script。必要新增 template_materialize、execution_dispatch/join、finalize；每个工具先明确调用身份、planId 范围、输入输出，再写注册。

修改 `tools/report-evaluation/knowledge.ts`、`market-search.ts`；当前 search 和 capture 两个 Tool 都在 market-search.ts 中，没有单独的 market-capture.ts。必要时在本次范围内拆出 capture 薄模块。ToolDeps/apply.ts、visibility、Tool filter 必须同步，父会话与子会话获得不同范围。Host 的站点配置、镜像根、启动 SLA 等进入 owning config/schema 与 `config/crwu-workbench.yml`，禁止散落写默认常量。

### 12.3 Skill 与 CLI

重写业务 Skill 为入口 + workflow、知识路由、分组、调度降级、交付门禁。删除规范 reference 的生产 fallback；业务内容先列待迁移台账，未写入知识库时阻断相应步骤，不在当前任务自动改线上知识库。

新增/改造 Skill 内：project/plan/rule-parameters/report-data/screenshot/knowledge schemas；`scripts/{build_report_data,build_report,market_rules,build_workbook,check_workbook_contract,validate_result}.py` 和测试；新增固定计算入口与多对象汇总脚本；模板只保留 HTML/JSON 技术骨架，xlsx 从知识库下载，包内测试样本移入 fixtures 且不作生产依据。

旧 `validate_result` 中 dws/local 来源、恰好一 adopted、至少一个金额、三件必存在等约束分到不同状态/对象合同；不能为了支持中断而放松 completed。现有 result/case/object schema 的下游消费者同步迁移，不在一个 Schema 里混 v1/v2 字段。

Go 浏览器只改实际发现的通用缺口（例如登录成功后权威探测、页面等待、互斥），遵守 scheme/CLI manual/command contract/changelog 更新。如果 CLI 不改，测试现有行为即可，不跑无关 Go 重构。

## 13. 分阶段回测策略与交接里程碑

**明确执行规则：每个步骤先增加关键行为断言并证明会按预期失败；完成该步骤后只运行对应窄测试。小编辑不重复全量测试。相关窄测试通过且无新风险后继续下一步。全部边界集成后执行一次完整门禁。**

以下是设计的实施顺序与验收落点，详细逐项 TDD 实施计划待本稿审阅后生成。

| 阶段 | 完成内容 | 针对性回测与完成证据 |
| --- | --- | --- |
| A 契约与删除边界 | project/plan/object v2、handoff、报告状态；协议和 operation inventory；标记旧 UI 引用 | shared contract、冻结清单、scope 单测；必要一次 typecheck |
| B 门禁与会话交接 UI | CLI browser adapter、房地产 gate、元信息/抽屉、父会话创建和跳转、删进度结果/轮询 | Host ops、Client pane、扫描、Broker policy、导航失败与重复点击 |
| C 知识与能力闭环 | 实际路由、同目录同名恢复、镜像身份、按阶段下载、二进制模板、规则参数/能力 gate | knowledge/knowledge-tool、模板下载、方法缺口、中断 report-data |
| D 分组与动态执行 | 多对象方案、方法冲突、parent/child scope、动态/顺序 adapter、lease | 新 project-grouping/execution 单测：unknown→serial、创建慢/超时不重复、跨方案拒绝 |
| E 浏览器取证 | provider 城市和 DOM fixture、详情、截图、去重、profile 串行队列 | market/market-tool、capture/schema、取消/页面错配；仅必要 Go browser 窄测试 |
| F 计算和 HTML/Excel | 知识参数计算、适用模板、重算能力、对象汇总、图片 HTML、blocked 与 finalize | Python 数值/报告/工作簿合同 + integration deliverable chain |
| G 集成收尾 | UI 视觉、文档、版本/协议/包、删除残留、自包含 | 一次完整相关门禁 + 独立 profile 真实验收 |

已有测试的真实路径（不要用不存在的 report-evaluation 通配符）：

```bash
# 从插件目录运行；每阶段只选它覆盖的文件。
node --test tests/unit/client/client-valuation-pane.test.mjs
node --test tests/unit/host/host-valuation-ops.test.mjs tests/unit/host/host-workspace-session.test.mjs
node --test tests/unit/host/host-valuation-knowledge.test.mjs tests/unit/host/host-valuation-knowledge-tool.test.mjs
node --test tests/unit/host/host-valuation-market.test.mjs tests/unit/host/host-valuation-market-tool.test.mjs
node --test tests/unit/host/host-valuation-bootstrap.test.mjs tests/unit/host/host-valuation-artifact-validate.test.mjs
node --test tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_market_rules.py
PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_valuation_contracts.py
```

TS/TSX 测试复用现有 helpers/registerTsxLoader；不安装新测试框架。新增测试按所属阶段加进对应精确命令；已删除页面的测试改成“不得渲染/不得轮询”，有价值的底层合同不丢。

Go 有改动时先：`go test ./internal/platform/browser ./internal/transport/cli`；最终 `make test` 一次。Plugin 最终 `make plugin-check` 一次，**不要再额外重复 npm run check/npm test/build/pack 同一套**。`make docs-check` 在主动入口/当前运行文档有更新后跑一次；最终 `git diff --check`。

额外对已改业务层自包含单独运行一次（当前 Makefile 未单独验证 biz root）：

```bash
# 插件目录
python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/biz
```

视觉验收扩展 `install/browser-check.mjs`：只读检查门禁、窄面板、深色、抽屉 footer、可访问性与旧页移除；创建/跳转用独立测试 profile、临时文件和明确的 mock/测试入口，不让普通只读验收误触真实估值。脚本已有 --url/--out/--playwright 参数，禁止写成裸命令必然失败。真实站点人工登录与截图仅在员工授权的独立环境验证，不由离线单测访问。

本稿本轮只修改文档：检查文档链接、差异和语义，不运行完整产品测试。

## 14. 最终验收样例

1. 浏览器未登录：房地产正文拦截，目录可切换，报告审核行为不变。
2. 30 文件可预览、31 拒绝、重叠目录不重复计数、不同路径同名能分辨、创建时间未知不伪造。
3. 抽屉只有文件元信息与三个用户输入；页面“确认”、抽屉“开始估值”；无知识/完整 Prompt/运行看板。
4. 双击开始/请求重试只建一个父会话；跳转失败重试只打开同一会话；创建失败保留草稿。
5. 创建后关闭/切走工作台：父会话能独立分析、取知识、生成报告，无 valuation-status/result 后台请求。
6. 三套同小区住宅：一个方案、三个对象独立修正和金额；住宅+商业：拆方案，住宅可完成、商业规则未支持则给中断 HTML。
7. 同小区权益/基准日冲突：不自动合并，在父会话问员工；无插件方案编辑器。
8. Agent 状态未知/繁忙/服务缺失：父会话顺序；明确健康则有界并行；超时晚创建的 child 不会与父会话重复执行同方案。
9. 方法需要未注册抓取能力：取数前阻断，不自由尝试 shell/网页；链家贝壳同房源不重复算案例。
10. 知识旧路由失败：按配置的实际路径/同目录同名恢复并留痕；歧义或两处真缺失出说明报告；错误身份镜像拒绝。
11. 模板 xlsx 确实下载、解析、hash/合同通过；只有空预留标题不会继续填表。
12. 截图 A/B 并发请求不会错页；原始图片与案例名称可对应，报告离线可看图，Excel 证据路径一致。
13. 单位/日期/税率/阈值来自知识快照，脚本边界可复算；缺重算能力明确 partial，不显示完成。
14. blocked HTML 无金额必填约束，completed HTML 与 JSON/工作簿一致；项目可部分完成但不能把中断方案金额计入总价。
15. 房地分别评估形成组件任务图；土地 Skill 缺失时给中断说明，不创建虚假子 Agent。未来土地/建筑物可独立时动态并行、有依赖时顺序；land-and-building 与 land-only 汇总必拒绝重复计价。
16. 可见链家/贝壳挑战先自动调用固定脚本；隐藏 captcha 资源不触发。脚本 exit 0 但仍在挑战页不能成功；恢复后返回原房源并重新取证。预算耗尽保存 waiting-user，员工继续不重建会话；限流共享冷却，挑战截图不充当估值证据。

## 15. 固定 Prompt 与方案输入示例

父会话初始指令由 Host 构造，模板属于 Skill 技术契约。只带 projectId、冻结输入指纹和案例相对路径，不塞正文、图片 base64、绝对源文件路径或原始命令：

```text
使用 crwu-biz-valuation-realestate 执行本次房地产估值。
先用 crwu_valuation_case_bootstrap 取得 Host 绑定的项目与冻结输入。
依次完成：资料提取、通用知识读取、对象识别和方案分组、各方案方法判定。
方法判定必须引用本轮业务知识快照；指定方法有冲突时在本会话确认。
对每个方案下载方法正文和所需案例/参数知识，用已注册能力取数；按索引下载适用模板。
使用执行 Tool 的真实调度决策；状态未知或资源不足时由本会话顺序执行。
每个对象独立记录数据与计算。调用脚本计算、重算及 finalize，不自行输出未校验结论。
必需知识缺失先检查对应目录/同名文件；确实缺失则输出受影响方案的中断 HTML。
最后向员工交付估值报告和计算表。插件页面不会追踪本会话进度。
```

方案索引的最小结构（这是数据形状示例，不包含任何示例业务阈值）：

```json
{
  "schemaVersion": "crwu.valuation.project.v2",
  "projectId": "project-001",
  "inputDigest": "sha256:<完整实际指纹>",
  "plans": [
    {
      "planId": "plan-001",
      "title": "同小区住宅方案",
      "propertyType": "residential",
      "objectIds": ["object-001", "object-002"],
      "methodRequest": "auto",
      "methodAssessment": null,
      "baseDate": null,
      "groupEvidenceRefs": ["material-001#page-2"],
      "status": "ready-for-method-selection"
    }
  ]
}
```

子 Agent 指令只包含授权 planId、objectIds、其知识 snapshotDigest、能力结果和本方案步骤。创建前完成方法及必需知识/能力 gate；子 Agent 再检查授权清单，不能改组或绕过缺口。父会话已经完成的提取与知识下载结果传文件引用，不复制全部上下文、不重新分析所有员工资料。

## 16. 给接收实现 Agent 的启动说明

先读仓库及插件 AGENTS，再读本稿对应阶段与目标源码。保留用户未跟踪模板。先固定 wire/数据合同和受控路径，再改页面交接、知识、分组执行、证据和交付。不要把旧聊天中的“新增方案确认页/进度页/结果页”重新实现出来。

业务规范从正确业务库及可验证镜像取得；缺内容先查对应文件/目录，确实缺失就在 HTML 说明，不自行创规则。不得让 Agent 因插件能力缺失反复试错。始终一个父会话，子 Agent 动态可选，顺序模式是完整有效的执行路径。

按第 13 节阶段回测，针对性用例通过后向下一阶段推进；只有新的失败/修改/未解决风险才重复相应检查。最后做一次完整门禁并说明哪些真实验收由员工完成。未获明确要求不得提交、推送、打 tag 或发布。
