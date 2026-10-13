# 0.0.42 验收矩阵：房地产估值（协议 33）

> [!NOTE]
> **状态：验收记录（插件 0.0.42 / 协议 33）。** 本文把实现方案 §16 的每一条验收标准
> 对应到**具体在哪一处被强制**（测试断言 / 校验脚本 / 契约规则），并写明去掉那一处会放走什么。
> 对应不上强制点的条目一律记成能力缺口，不写成"已满足"。现行入口见
> [`README.md`](../README.md) 与 [`development-notes.md`](development-notes.md)。

## 怎么读这张表

- **强制点**是"删掉它，错的东西就能通过"的那一处。没有强制点的条目**不算已满足**。
- 表里只列**可自动核**的部分；需要真机 / 真网络 / 人工判断的，在最后一节单独列。
- 断言位置用文件路径 + 断言原话（`「…」` 里的文字必须在测试里**逐字存在**），便于直接跳过去看。
  这条约定有守卫：`tests/unit/host/host-acceptance-matrix.test.mjs` 会把本文的每个 `「…」`
  拿回测试源码里找一遍 —— 找不到就判红，防止这张表慢慢变成"写着却没有的强制点"。

## 1. 工作区与会话（方案 §3 / §16）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 没有工作区时只能进入环境信息 | `tests/unit/host/host-workspace-session.test.mjs`「没有选中工作区 / 目录丢了 / 自检没完成 —— 都不算"有工作区"」 | 业务页在未自检的工作区上开起来 |
| 所有会话都使用 workspaceId | 同上「创建会话只发 workspaceId，绝不发 cwd」+ `host-audit-root.test.mjs`「审核根只通过统一会话入口创建」 | 某条路径悄悄用 `cwd` 建会话，落到别处 |
| 没有 cwd fallback | 同上「工作区会话层里没有任何 cwd 降级（静态判据）」+ `host-module-layout` 的旧路径扫描 | 缺失工作区时退回部署默认目录 |
| 审核根和 child 都进入 `workspace.sessionIds` | `host-audit-root.test.mjs`「建的顶层会话：cwd = 已选工作空间」；child 见 `host-audit-spawn.test.mjs`「子会话建完要**显式挂到工作区**并回读成员关系」 | 会话建了但没挂到工作区（用户在侧栏看不到） |
| attach 失败不会继续执行 | `host-workspace-session.test.mjs`「成员关系回读失败时**不许**返回成功」+「create 抛错 / 返回空 id —— 都算创建失败，且不谎报成员关系」（挂载在统一会话服务里做，失败即 `createSession` 返回失败、`auditRoot` 不落钩子）+ `host-audit-root.test.mjs`「ensureAuditRoot keeps the hook clean when the preflight fails」+ `host-audit-spawn.test.mjs`「挂不到工作区时：**不返回成功**，并且把刚建的子会话停掉」 | 挂载失败被记进 notes 后照常跑 |
| 旧错误会话不被复用 | `host-workspace-session.test.mjs`「复用旧会话：工作区换了 / Agent 没了 / 成员关系丢了 —— 都不复用」 | 复用一条落在旧工作区的会话 |
| 切换工作区后创建新会话 | 同上；`host-audit-root.test.mjs`「auditRootUsability：没有根 / 工作空间级旧根 / 别的案例的根 / 换过工作区 / 死掉 / 子代理 / cwd 不对 —— 一律不可用」 | 换工作区后继续用旧根 |

## 2. 估值交互（方案 §5 / §16）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 支持多类型文件 | `tests/unit/host/host-valuation-intake.test.mjs`（PDF/Word/Excel/图片/未解析/空文件/越界七类）+ `host-valuation-ops.test.mjs` 的 `valuation-intake` 两条（真跑一次复制与提取） | 某类资料静默不进清单；或**每一份**都被 Broker 拒掉（借错操作） |
| 支持补充提示词 | `host-valuation-lifecycle.test.mjs`（指令里有 `## 用户补充要求`；Host 逐字写进冻结输入） | 用户写的要求没进子会话 |
| 支持四种方法选择 | `host-valuation-ops.test.mjs`「valuation-start：方法非法 / 基准日形状不对都在建任何东西之前拒绝」（`isValuationMethod`） | 任意字符串当方法传下去 |
| 支持可选基准日 | `host-valuation-lifecycle.test.mjs`「未指定基准日时：指令明确禁止按基准日筛选与做日期修正，并要求登记」 | 把 PDF 里的日期当基准日 |
| 确认抽屉只读 | `tests/unit/client/client-valuation-pane.test.mjs`（抽屉只有三个动作按钮、无输入控件、字段为纯文本） | 抽屉里能改方法/基准日 → 快照与展示不一致 |
| 确认后输入快照不可变 | `domains/report-evaluation/scope.ts` 的 `frozenInputMismatch` + `host-valuation-ops.test.mjs`「输入快照被改过时可见」（比对方法/基准日/补充要求/清单指纹） | 案例目录里的 `估值输入.json` 被改而无人知 |
| 正常情况下确认后自动完成 | `operations/report-evaluation.ts` 的 `valuation-status` 宿主侧完成判定 + `host-valuation-ops.test.mjs`「完成由宿主判定」（三件齐备且结果可解析才 `completed`） | 阶段永远停在 `running`，结果页不出现 |
| 登录异常时进入可恢复的 `browser-login-required` | `tools/report-evaluation/record.ts` 写回 + `host-valuation-market-tool.test.mjs`（阶段/来源状态/缺口真的落到注册表）+ 构建期装配保证（见第 8 节） | 面板永远显示"正在跑"，用户不知道该去登录 |
| 页面不会伪造进度 | 客户端只读 `valuation-status` 的 `progress`（无本地计时/估算）；断言见 `client-valuation-pane.test.mjs`「渲染：还没确认时不画抽屉；运行中给阶段与进度但**不伪造**进度条」 | 界面安慰性推进度 |

## 3. 知识库（方案 §6 / §16）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 优先使用 DSW 知识库 | `host-valuation-knowledge-tool.test.mjs`（节点存在 → `source=dws`，本地不覆盖） | 有知识库正文却用了本地备份 |
| 本地 `references` 可作 fallback | 同上（节点不存在 → `source=local`） | 知识库不可用时整轮停摆 |
| 每次结果记录知识来源 | `validate_result.py` 的 `check_knowledge_traceability`（逐条对着 `知识快照/.知识来源.json` 核路由与指纹） | 结果里出现根本没取到的路由 |
| 知识缺失不被伪装成规范已满足 | `validate_result.py` 的 `check_knowledge_traceability`（快照里的知识库来源必须逐条写进结果） + `host-valuation-knowledge.test.mjs`「必需知识「01-房地产估值通用」两边都缺 → **停止估值**（不是继续 + 缺口）」 | 用了降级备份却说"已按规范完成" |

## 4. 外部案例（方案 §10 / §16）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 三家来源有独立 Provider | `host-valuation-market.test.mjs`「来源白名单只有三家，展示名与枚举一一对应」+ `host-valuation-market-tool.test.mjs`「三家来源的 Tool 都在注册清单里」与预检返回 `['fang','anjuke','lianjia']` | 来源混在一个解析器里，字段口径串台 |
| 每个分页最多尝试 3 次 | `host-valuation-market.test.mjs`「每个分页最多尝试三次：第三次失败即停，绝不尝试第四次」+ `host-valuation-market-tool.test.mjs`「每个分页**恰好**三次尝试（数调用次数）」 | 无限重试或只试一次就当失败 |
| 登录状态可在确认抽屉查看 | `host-valuation-market.test.mjs`「登录状态只认三个值；认不出来是 unknown」+ `valuation-intake` 的 `providers` + `client-valuation-pane.test.mjs` 的抽屉数据源区块 | 用户在不知登录状态的情况下启动；或把 unknown 当已登录 |
| 页面可通过默认浏览器登录 | `host-valuation-ops.test.mjs` 的三条 `valuation-browser-preflight`（只打开该站点自己的登录页 + 结果无令牌字段 / 未知来源不发命令 / 未授权不打开且如实回报） | 打开错误的地址、把凭据顺手回给界面、未授权也照开 |
| 案例有 URL、抓取时间和证据 | `validate_result.py` 的 `check_cases` + `check_case_evidence_files`（URL / `captured_at` / 证据文件必须真实存在，越界不合格） | 引用着不存在的证据，或干脆没证据 |
| 挂牌价和成交价区分 | `validate_result.py` 的 `check_cases`（`used_as_comparable` 为真而 `transaction_type` 不是「成交」即判失败）+ `host-valuation-market-tool.test.mjs` 的挂牌/成交分别标注 | 挂牌价被当成交价直接算 |
| 不编造案例 | `host-valuation-market-tool.test.mjs`「页面取到但**没有**结构化房源 → 0 条 + 能力缺口（绝不按标题猜）」 | 从标题猜面积/价格 |
| 失败来源进入 `capability_gaps[]` | 同上（三次失败仍确认登录 → 只记缺口、继续其他来源）+ `record.ts` 的写回断言 | 失败被吞掉，结论看起来完整 |

## 5. 计算输出（方案 §14 / §16）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| XLSX 通过工作簿契约 | `scripts/check_workbook_contract.py`（七张可见表 / 关键公式链 / 收益法链 / **采用的方法逐字**） | 表被改名、隐藏、公式被覆盖 |
| 公式区不被覆盖 | 同上（`REQUIRED_FORMULAS` 逐条要求公式形态仍在） | 用数值盖掉公式 → 结论无法重算 |
| 无 `#REF!` / `#VALUE!` / `#DIV/0!` | 同上 + `validate_result.py --workbook`（错误值扫描） | 交付带错误值的底稿 |
| JSON 通过 Schema | `scripts/test_valuation_contracts.py` 的 `SchemaSubsetTest`（样例真的过 schema；未知 keyword 报错；schema↔校验脚本双向绑定） | schema 与校验脚本各说一套 |
| HTML、JSON、XLSX 三者结论一致 | 报告↔JSON 严格（`--html`）；JSON↔底稿**方法**严格（`check_method_agreement`）；**数字层面本机查不了**（需重算，见第 6 节） | 报告与 JSON 数字不一致；方法口径不一致 |
| 无基准日时写入「本次未指定评估基准日」 | `validate_result.py`（无 `baseDate` 时缺该条 → 红） | 用户以为有基准日 |
| 所有待确认事项和能力缺口完整输出 | `check_result`（字段必须在；`capability_gaps` 为数组） | 缺口字段整个丢掉 |

## 6. 需要真机 / 真网络 / 人工的部分（能力缺口，不是"已满足"）

| 条目 | 现状 | 为什么本机查不了 |
| --- | --- | --- |
| 页面截图证据 | **不可用**：每次取证都如实上报"本部署没有页面截图能力"，证据为页面字节（HTML）+ 指纹 | 无无头浏览器 |
| 三家站点 URL 模板与 JSON-LD 覆盖率 | **未验证**：模板写在 `providers.ts` 里，未对真实站点核对过 | 需要联网与真实登录态 |
| “在默认浏览器登录”真机行为 | **未真机验证**（自动断言已覆盖"打开的是该站点自己的登录页、不读 Cookie、未授权不开"，但"真的弹出了浏览器"要在桌面会话里看） | 需要真实桌面会话 |
| 扫描 PDF / 图片内容 | **不可用**：无文本层 → `PDF 无文本层，需要 OCR`；图片 → 待识别 + 缺口 | 本机与 DSH 自带 Python 都没有 OCR |
| 底稿数字 ↔ JSON 数字 | **查不了**：比较需要重算后的单元格值，openpyxl 不算公式 | 交付前必须真打开一次底稿让它重算，由人核对 |
| DSW 知识库七个路由节点是否真实存在 | **未验证**：路由与降级都已实现并有测试，但没对着真实知识库确认过节点名 | 需要真实知识库权限 |
| 视觉验收：暗/浅主题、宽/窄面板 | **自动化断言已写进** `install/browser-check.mjs`（主题作用域在每个挂载点上取计算值 + 深浅翻转后取值必须变 + 宿主隔离；面板宽窄两态无横向溢出 + 容器查询按面板宽度生效），**结果未产生** | 需要装了插件的 profile 与 playwright |
| 视觉验收：**只读确认抽屉打开态** | **自动化做不到**：打开抽屉要先选到真实文件（走系统原生对话框），浏览器脚本点不了。`browser-check.mjs` 只能断言"没点之前不许自己弹出来" | 需要人工选一份 PDF 后截图 |
| 视觉验收：运行 / 失败 / 结果三态 | **自动化做不到**：三态都要真跑一轮估值（含真实站点检索） | 需要人工跑一轮后截图 |

## 7. 构建期保证（不属于 §16，但挡住同一类失败）

| 保证 | 在哪里 | 它挡住什么 |
| --- | --- | --- |
| **装配必须齐备** | `src/host/apply.ts` 的 `AssembledToolDeps`（`ToolDeps` 的"全字段必需"视图，例外只有 `ifind` / `ifindTimeoutMs` 两个注入点与调优项） | 新加一个可选依赖却忘了在 `apply()` 接上 → **编译不过**。这类漏接不会崩，只会让某个功能默默降级（例如估值工具写不回轮次状态、界面永远停在"正在跑"），是最难发现的一类问题 |
| **注册面 = 业务工具集** | `scripts/smoke-built.mjs`（对**构建产物**跑真实 `apply()`，逐个比对注册的 Tool 名） | 工具写好了却没注册（模型看不到），或审核子会话能力集与注册面不一致 |
| **声明的来源必须被那条操作允许** | `tests/unit/host/host-access-source-policy.test.mjs`（把 `src/host` 每个调用点的 `{operation, source}` 与操作描述表对一遍；反向查"登记了没人用"） | 借错操作（例如面板借 `audit-tool` 的 `system.case-file.write`）→ 运行期被 Broker 拒掉，而单测全绿 |

## 8. 集成层（跨脚本的那一段）

| 链路 | 断言 | 它挡住什么 |
| --- | --- | --- |
| 真 docx + 真 xlsx → `extract_files.py` → `build_workbook.py` → `check_workbook_contract.py` → `build_report.py` → `validate_result.py --html --workbook` | `tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs` | 脚本**之间**的接口漂移（字段名、值 JSON 形状、结果 JSON 字段）—— 各脚本自己的用例都是被夹具"喂"出来的，改一处接口照样全绿 |

## 9. 真机层（`tests/browser/` 在本仓的对应物）

方案 §4.4 的 `tests/browser/` 在本仓对应 **`install/browser-check.mjs`** ——
真机行为（面板真的画出来、侧栏入口、单列表、分页只补本页 OSS）唯一的自动化手段，
需要有人起一个装了插件的 DSH profile 并装 playwright。

| 条目 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 报告评估面板真的画出来 | `install/browser-check.mjs` 的「报告评估：**已经实现的房地产估值面板**」阶段（断言 `.crwu-valuation`、四种方法可选、打开页面**不弹**确认抽屉、没选资料时「开始估值」**禁用**且说明原因、禁用状态下点了也不弹抽屉、不造假进度） | 面板在白屏/报错/把"确认"这一步省掉的情况下也算通过 |
| 验收脚本不许描述旧产品 | `tests/unit/client/client-browser-check-drift.test.mjs`（注册表说模块开发完了，脚本里就不许还有占位页文案；任何 `.click(` 不许落在「AI 审核」上） | 产品变了、验收脚本没变 —— 而它要有人真跑才会发现 |

⚠️ **这一层在本机跑不了**（没有真机 profile 与 playwright），所以上面第一条是"脚本里写了断言"，
不是"本机已验证通过"。真机结论仍待人工执行 `install/browser-check.mjs`。

## 10. 与方案的有意偏差（每条都写清理由）

方案是目标形状；下面几处**没有照抄**，逐条说明为什么 —— 不写下来的话，下一个读代码的人
会以为是漏了。

| 方案里的位置 | 实际实现 | 为什么 |
| --- | --- | --- |
| `operations/update.ts` | 留在 `src/host/update/ops.ts`（`update/` 是顶层子系统） | 更新操作与**检查器 / 持久化 / 安装服务**同生共死：拆一个只做转出的 `operations/update.ts` 是空壳，而空壳会让人以为那里有逻辑 |
| `operations/workspace.ts` | 留在 `operations/environment.ts` | 那一个文件的判据是"**它回答的是这台机器现在是什么样**"，且族内共享同一个能力门禁快照（`host.gate`），任何一条改了环境事实都要 `invalidate()`。把工作区选择拆出去会割断那条凝聚性 —— 文件头已写明这条判据 |
| `integrations/browser/`、`tools/integrations/browser.ts` | 不存在 | 本机浏览器能力只有一处真实动作：面板操作 `system.browser.open`（打开站点自己的登录页）。本仓**没有可注入的浏览器驱动**，建一层空目录等于假装有那一层。真机行为由 `install/browser-check.mjs` 证明 |
| `MarketProvider.captureEvidence()` | `domains/report-evaluation/browser/capture.ts` 的 `saveEvidence()`，由 Tool 调用 | Provider 只做**网络**（传输是可注入的，测试用内存替身）；把证据写进案例目录需要 Broker 与调用者会话。放在 Provider 上会逼每个 Provider 都携带 fs/broker 依赖。行为等价且已断言（「取证：页面字节落进案例目录，带指纹」） |

其余按方案落地的部分：`WorkspaceSessionService` 的四个方法逐一对上（另加一个 `verifyPlacement` 用于复用前重验）、
`FileExtractor`（`canHandle` / `extract`）、`MarketProvider`（`id` / `preflight` / `search`）、
八个估值 RPC、七个估值 Tool、Skill 目录树与七张可见表。

## 11. 复核这套结论的命令

```bash
npm run typecheck        # 类型
npm test                 # 插件全部断言（含估值全链路）
npm run build            # 构建
npm run smoke:built      # 构建产物冒烟
npm run pack:assert      # 打包清单
make plugin-check        # 插件门禁（含技能契约测试与 CLI 守卫）
make docs-check          # 活跃文档入口与链接
git diff --check         # 空白/冲突标记
```

技能契约测试可单独跑：

```bash
cd plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test_valuation_contracts.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_workbook_contract.py
```

## 12. 两级目录（一级「业务大类」+ 二级「功能页面」，2026-10-13）

> [!NOTE]
> 2026-10-13 修订：一级目录改为**按模块分属**。以前只有一棵混着的树，进入「报告评估」也能看到
> 一级标签「审核」；现在评估树只含「估值」，审核树只含「审核」，没有已配置业务项的一级目录
>（其他业务）不再显示。下表已同步到当前判据。

用户口径与实现说明见 [`PRD-workbench-sidebar-modules.md`](PRD-workbench-sidebar-modules.md) 的
「两级目录」一节。这里把用户给出的十条验收标准逐条对应到**强制点**（去掉它就放走什么）。
引用一律是断言原话 / 用例名 —— 本文开头那条守卫会拿每个 `「…」` 回测试源码里找一遍。

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 1. 一级目录切换后，二级目录立即替换 | `client-package.test.mjs`「两级目录按模块分离：报告审核树只有审核，报告评估树只有估值且不出现审核」 | 一级切了、二级还停在上一组目录 |
| 2. 二级目录自动选中第一个可用页面 | `client-module-gate.test.mjs`「每次切一级目录都默认选中第一个可用页面（不记忆上一次的二级页面）」 | 记忆上一次的二级页面，或选中一个不可用页面 |
| 3. 一级 / 二级 / 正文不会不同步 | `client-module-gate.test.mjs`「点一级目录：二级目录、正文、一级目录在**同一次通知**里一起变」 | 先改一级、下一帧再改二级 —— 闪出不一致的画面 |
| 4. 切换时布局高度与滚动容器稳定 | `client-local-audit.test.mjs`「样式契约：内容区是唯一的 tabpanel，且是那个把高度接下去的滚动容器」+「页面内容区：只有一层纸，纸里的第二层 surface 不画框」 | 内容区被重建 / 高度断链 → 滚动条消失、纸里多一条线 |
| 5. 切换目录不丢估值草稿 | `client-package.test.mjs`「切一级目录不丢估值草稿：控制器由 apply 层持有，切走再回来还是同一份」 | 已选资料 / 方法 / 基准日 / 补充要求切一次目录就没了 |
| 6. 运行中的估值不被切目录取消 | `client-package.test.mjs`「面板持有估值轮询：切到别的目录也不会把它停掉（运行中的估值不被取消）」 | 切走就停表；`controller.poll()` 没人调用 → 永远停在「估值进行中」 |
| 7. 不显示环境信息 | `client-package.test.mjs`「估值页不展示环境信息：没有环境胶囊、没有环境检查详情、导航里也没有环境标签」 | 估值页上出现环境卡片 / 「环境已就绪」胶囊 / 环境标签 |
| 8. 不用写死的「报告评估 / 房地产估值」抬头 | `client-package.test.mjs` 断言页面抬头取 `valuationPageTitle`（标题来自**导航元数据**；估值页自己不再画抬头） | 抬头写死：切到别的二级目录还说「房地产估值」 |
| 9. 新增一级 / 二级目录只加元数据 | `client-module-gate.test.mjs`「二级目录：估值三项（土地 / 机器设备还没做）、审核两项」+「默认页面 = 该一级目录下第一个**可用**页面；不认识的 id 返回 null」 | 加一个目录要改组件里的 if（回到"三处各写一套"） |
| 10. 估值 RPC / 状态机 / 只读抽屉 / 结果字段不变 | `tests/unit/client/client-valuation-pane.test.mjs`（状态机与阶段、只读抽屉恰好三个动作、结果字段与两桶案例） | 改导航顺手改了估值行为（协议与结果口径漂移） |

同一批改动里另外几条被强制住的（不在这十条里，但删掉它们同类问题会回来）：

| 额外强制点 | 在哪里 | 它挡住什么 |
| --- | --- | --- |
| 一级目录**分属模块**，评估树里没有审核、审核树里没有估值 | `client-module-gate.test.mjs`「导航按模块分离：评估树只有估值，一级标签不出现审核」+ `client-package.test.mjs`「两级目录按模块分离：报告审核树只有审核，报告评估树只有估值且不出现审核」 | 一个模块里出现另一个模块的入口（截图里那个重复入口） |
| 没有已配置业务项的一级目录**不画** | `client-module-gate.test.mjs`「没有已配置业务项的一级目录不画（不展示空占位入口）」 | 点「其他业务」得到一张空白页 |
| 页面身份变了要把滚动位置归零 | `client-module-gate.test.mjs`「页面身份：二级目录 / 环境页各是一个身份，一级目录不算」 | 容器不重建 → 上一页的 `scrollTop` 套给下一页 |
| 门禁判据只有一份（从 `MODULE_META` 派生，不抄第二份布尔量） | `client-module-gate.test.mjs`「页面 → 模块；门禁判据从模块元数据派生（不在这张表里再抄一份）」 | 导航说能进、门禁说不能进 —— 两边再次分叉 |
| 「开发中」是硬判据，不是只把按钮画灰 | `client-module-gate.test.mjs`「「开发中」的二级目录不可进入（enabled=false 是硬判据，不是样式）」 | 点进未实现的页面 |
| 一级目录下没有可用页面时如实说一句 | `client-module-gate.test.mjs`「一级目录下一个可用页面都没有：落到 empty（正文说「该业务目录暂未开放」）」+「该业务目录暂未开放」 | 点一个空目录得到一张空白页 |
| 被拦时记的是**二级目录节点**，且只恢复最近一次 | `client-module-gate.test.mjs`「环境不通过时点二级目录：落到环境页、记 pending、带出目标页名」+「重新检查通过后只恢复最近一次被拦的目标（回到那一个二级目录）」 | 恢复时跳错页，或把用户弹走 |
| 环境信息永远进得去（修复入口） | `client-module-gate.test.mjs`「环境信息永远进得去（它就是修复入口）：不判门禁、也不留下 pending」 | 环境坏了就没有出路 |
| 真机形态：一级 44px + 3px 强调线、二级更轻的胶囊、`aria-controls` 指向同一内容区 | `install/browser-check.mjs`「报告审核的一级目录只有审核」+「报告评估的二级目录是 房地产 / 土地 / 机器设备」+「估值页抬头按二级目录给出（房地产估值）」 | DOM / 类名漂移而本机断言没跟上（**这一层需要真机 profile 与 playwright 才能跑**） |

## 13. 「检查并确认」没有反应那一类回归（协议 33，2026-10-13）

用户报的现象是"点按钮没反应"。根因不是没有事件、也不是没有确认抽屉，而是
`valuation-intake` 是一条**没有中间反馈的长 RPC**：它当时在返回确认数据**之前**还会串行预检
房天下 / 安居客 / 链家，每家最多 20 秒 —— 三家连续失败时按钮要等约一分钟才有反应。
下面每条都对应一处**强制点**：删掉它，这一类问题就会原样回来。

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 点下去**同一帧**就有反馈（阶段 + 按钮文案 + 禁用 + 输入锁定） | `client-valuation-pane.test.mjs`「点击检查并确认：**同一帧**进入 extracting」 | 回到"点了没反应"：用户只能靠按钮颜色猜有没有执行 |
| 进度区在当前可视区域内，且是 `role="status"` | 同上（断言 `data-valuation-intake-status` 存在且 `role` 可读） | 反馈被后面的大块内容推到屏幕最下方 —— 等于没有反馈 |
| 提取阶段显示的是**宿主报的真实阶段** | `client-valuation-pane.test.mjs`「进度区显示的是**宿主报的真实阶段**，客户端不自己编」 | 按计时器逐条切换阶段文字 = 假进度（§4 明确禁止） |
| 基准日从 Client 逐字传到 Host | `client-valuation-pane.test.mjs`「基准日：从 Client **逐字**传到 Host（未选择就是空串，不拿资料里的日期补）」 | 用户选的基准日被静默丢掉，结果里却写着"未指定基准日" |
| 成功之后抽屉**自动**打开 | `client-valuation-pane.test.mjs`「intake 成功：抽屉**自动**打开，不需要用户再点一次」 | 用户以为没成功，反复点 |
| 失败要写出具体原因 + 可执行动作 | `client-valuation-pane.test.mjs`「intake 失败：role=alert」 | 错误只在控制台里；用户不知道下一步做什么 |
| 超时是**可恢复**的失败，且不谎称宿主已停止 | `client-valuation-pane.test.mjs`「intake 超时：进入可恢复的失败态」 | 永远转圈；或反过来谎称"已停止"（宿主可能还在跑） |
| 提取过程中可以取消，并按 `valuationId` 通知 Host | `client-valuation-pane.test.mjs`「取消提取：回到可编辑态，并按 valuationId 通知 Host 取消」 | `state.valuationId` 还空着 → 取消通知发不出去，那一轮在宿主侧一直跑 |
| 迟到响应不许覆盖新状态 | `client-valuation-pane.test.mjs`「取消之后迟到的 intake 响应**不许**把抽屉重新弹出来」 | 用户明明退出了，抽屉又自己弹回来 |
| 「返回修改」后重新提取是一轮**新**请求 | `client-valuation-pane.test.mjs`「返回修改后重新提取：作废旧请求，并生成新的一次快照」 | 旧快照被当成新快照，冻结的东西与实际不一致 |
| 失败不丢资料 / 方法 / 基准日 / 补充要求 | `client-valuation-pane.test.mjs`「intake 失败：role=alert」 | 改一句话要重选一遍资料 |
| 来源探测**不阻塞**抽屉，且逐家独立更新 | `client-valuation-pane.test.mjs`「外部来源：抽屉先开、状态初始」 | 回到"按钮等一分钟"；或一家超时拖死另外两家 |
| 没有预检能力时如实说「无法检查」 | `client-valuation-pane.test.mjs`「没有预检能力时如实说」 | 把 `unknown` 显示成"已登录"（编造能力） |
| 文件行：主标题是文件名、同名给目录摘要、完整路径在详情里 | `client-valuation-pane.test.mjs`「资料清单：逐份事实来自 valuation-files-scan，同名文件给目录摘要、完整路径不做主标题」 | 回到"整条绝对路径当标题"，用户认不出资料 |
| 没有资料时按钮禁用**并在旁边写原因** | `client-valuation-pane.test.mjs`「没有资料时开始按钮禁用，并在旁边写出原因」 | 一个禁用的按钮，用户不知道为什么 |
| 非提取阶段「取消提取」被明确拒绝 | `client-valuation-pane.test.mjs`「取消提取的状态机判据：非提取阶段一律拒绝（不静默）」 | 静默无动作，看起来像坏掉了 |

## 14. 导航按模块分离 / 单工作面 / 样式作用域

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 报告评估树里**没有**审核入口 | `client-module-gate.test.mjs`「导航按模块分离：评估树只有估值，一级标签不出现审核」 | 一个模块里出现另一个模块的入口（用户截图里那个重复入口） |
| 没有已配置业务项的一级目录不画 | `client-module-gate.test.mjs`「没有已配置业务项的一级目录不画」 | 点进去得到一张空白页 |
| 页面身份变了要把滚动位置归零 | `client-module-gate.test.mjs`「页面身份：二级目录 / 环境页各是一个身份，一级目录不算」 | 容器不重建 → 上一页的滚动位置套给下一页 |
| 每个独立挂载点都带插件作用域 | `client-style-scope.test.mjs`「每个独立挂载点都带插件作用域」 | 漏掉的那一块退回"命中整个宿主页面" |
| 主题变量挂在作用域节点上，深色读 `body[data-ds-dark-theme]` | `client-style-scope.test.mjs`「主题变量定义在作用域节点上，不只在 .crwu-audit-root 上」 | 侧栏入口 / 会话头按钮拿不到 `--crwu-*`，小组件在深色下错色 |
| 面板布局与主题作用域分开 | `client-style-scope.test.mjs`「面板布局与主题作用域分开：小组件不套 .crwu-audit-root」 | 小组件被面板布局规则拉成整屏 |
| 没有裸重置规则 / 无作用域的通用类 | `client-style-scope.test.mjs`「合成后的样式表里没有裸重置规则」 | 一条 `button { font: inherit }` 把宿主按钮字体改掉 |
| 限定不改变权重（`:where()`，不需要 `!important`） | `client-style-scope.test.mjs`「限定不改变权重：前缀用 :where()（0 权重），不是属性选择器」 | 加作用域抬高权重 → 原有层叠失效 → 只能堆 `!important` |
| 模块隔离：改估值不影响别的业务 | `client-style-scope.test.mjs`「模块隔离：估值模块的样式只命中估值自己的类」 | 改一个模块的样式连带改掉别处的观感 |
| 一级 / 二级目录的样式归 shell | `client-style-scope.test.mjs`「一级 / 二级目录的样式归 shell，不再由本地审核模块提供」 | 本地审核模块改页签样式，评估页跟着变 |
| 共享按钮 / 卡片 / 抽屉归共享 UI | `client-style-scope.test.mjs`「共享按钮 / 卡片 / 抽屉归共享 UI，业务模块不得重定义它们」 | 某个模块重定义共享类 → 改到别的业务的外观 |
| 样式节点：认领已存在的那一个并**刷新内容** | `client-package.test.mjs`「认领已存在的样式节点：不插第二份，但」 | 开发重载后样式永远停在第一份，改 CSS 看不到变化 |
| 多实例引用计数 | `client-package.test.mjs`「多实例引用计数：一个实例卸载不能删掉另一个还在用的样式」 | 一个实例卸载撤掉另一个还要用的样式 |

### 只读确认抽屉里的四条（方案 §5.4）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 完整业务提示词可折叠查看 | `client-valuation-pane.test.mjs`「抽屉把「将提交的提示词」和「每项要素的来源」都摆出来」 | 用户看不到将要执行的到底是什么，只能盲点确认 |
| 宿主没回提示词时如实说 | `client-valuation-pane.test.mjs`「宿主不回提示词预览时如实说」 | 编一份"看起来像提示词"的东西给用户核对 |
| 每项关键事实标出来源 + 粒度限制 | 同上（`data-valuation-field-source` + 「来源粒度是「哪一份文件」」） | 用户不知道该去核哪一份文件；或以为系统知道页码 |
| 取证能力如实说 | 同上（「取证能力」那一段） | "已登录"被读成"能留截图证据"，而本部署没有截图能力 |

### 结果页（方案 §9）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 证据不完整时**先**说一句，不拿数字装成正式结论 | `client-valuation-pane.test.mjs`「结果页：证据不完整时先提示，剔除案例可折叠，证据缺失如实标出」 | 缺件 / 缺证据的结论看起来和核实过的一样 |
| 证据齐备时不显示"不完整"提示 | `client-valuation-pane.test.mjs`「结果页：证据齐备时不显示」 | 正常结论被说成有问题，用户不再信这个提示 |
| 剔除案例可折叠但**不删** | 同上（`data-valuation-dropped-cases` + 断言理由文本仍在） | "这条为什么没算进去"查不到 —— 过程留痕丢失 |
| 证据文件与抓取时刻逐条可见 | 同上（断言证据相对路径与「抓取于 …」） | 案例不可追溯 |
| 明确没留存的证据如实标出 | 同上（断言「没有留存证据」） | 空单元格被读成"证据是空文件" |

### 中介联系方式（方案 §7.5）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 五态必须显式给出（不许留空对象） | `test_valuation_contracts.py`「test_contact_must_be_present_even_when_there_is_none」 | 分不出"页面没有"和"忘了写" |
| 状态只能是那五个值 | `test_valuation_contracts.py`「test_contact_state_must_be_one_of_the_five」 | 自由文本状态，界面与复核都没法判 |
| `public` 必须有取值 + 取得时刻 | `test_valuation_contracts.py`「test_public_contact_needs_a_value_and_a_time」 | "已公开获取"却什么都没拿到 |
| 脱敏号码**原样保留**、不许猜补 | `test_valuation_contracts.py`「test_masked_number_must_be_kept_as_is_not_guessed」 | 把 `138****1234` 补成完整号码 = 编造证据 |
| 需要登录 / 获取失败必须写原因 | `test_valuation_contracts.py`「test_login_required_and_failed_need_a_reason」 | 用户不知道该怎么处置 |
| 没有公开联系方式**不**排除案例 | `test_valuation_contracts.py`「test_contact_states_other_than_public_still_pass」 | 把"页面没公开"当成"案例不合格"剔掉 |
| 结果页按状态呈现，且**没有**联系入口 | `client-valuation-pane.test.mjs`「结果页：公开联系方式按状态呈现，脱敏号码**原样**保留且没有联系入口」 | 界面变成"点一下就能打过去"的工具 |

### 完成门槛（方案 §9 的后半段）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 结果读不懂不算完成 | `host-valuation-ops.test.mjs`「完成由宿主判定：三件交付件齐备且结果读得懂」 | 子会话写了一半的报告被当成结论渲染 |
| 采用规则不可追溯不算完成 | 同上（断言 `没有列出采用的知识库规范`） | 用了哪一版规范查不到，结论无法复核 |
| 采用案例没有证据不算完成 | 同上（断言 `没有页面证据`） | 没有页面证据的案例成了结论依据 |
| 重算能力缺口必须在完成时如实记下 | 同上（断言 `没有底稿重算能力`） | 把"以后人工打开核对"包装成"已完成自动交付" |

### 部分结果 / 失败阶段 / 资料冲突 / 宿主隔离（§4 / §5 / §10）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 失败要给出**失败阶段**（宿主报的那个） | `client-valuation-pane.test.mjs`「失败时给出失败阶段：宿主最后报过的那个阶段，不是客户端猜的」 | 用户只知道"失败了"，不知道停在哪一步 |
| 轮询不许擦掉失败原因 | 同上（`applyStatus` 保留上一份 error，只有 completed 才清） | 界面只剩"原因见下"而没有原因 |
| 部分结果看得见，但不装成正式结论 | `client-valuation-pane.test.mjs`「部分结果：轮次失败但已有交付件时，结果看得见且**不**装成正式结论」 | 已产出的底稿被藏起来；或反过来当成正式结论 |
| 失败且**没有**交付件时不渲染结果页 | `client-valuation-pane.test.mjs`「失败且**没有**交付件时不渲染结果页（不给一个空壳结论）」 | 一个没有任何数字的空壳"结论页" |
| 正式完成时不打"阶段结果"标记 | `client-valuation-pane.test.mjs`「部分结果不覆盖正式完成：completed 时结果页不打"阶段结果"标记」 | 正常结论被误标成阶段结果 |
| 单价旁边必须给出计价面积与计价单位 | 同上（断言「计价面积」与 `元/㎡`） | 只给一个数字、不说按多少面积算的，读的人没法复核 |
| 资料之间的冲突要如实列出（含双方取值与当前采用） | `host-valuation-ops.test.mjs`「valuation-intake：多份资料对同一要素给出不同值时，冲突要**如实列出来**而不是静默取第一个」 | 系统替用户做了一个他没看见的选择 |
| 值一致不算冲突（不制造噪音） | `host-valuation-ops.test.mjs`「valuation-intake：多份资料给出**相同**的值时不算冲突（不制造噪音）」 | 每份资料都报"冲突"，提示很快被忽略 |
| 抽屉把冲突与「用户提供」的性质摆出来 | `client-valuation-pane.test.mjs`「抽屉把资料冲突与「用户提供」的性质都摆出来」 | 用户不知道补充要求不是文件原文，也不知道冲突存在 |
| 宿主隔离：每条规则都在作用域内 | `client-style-scope.test.mjs`「宿主隔离：每条规则都限定在插件作用域内（插件不可能改到宿主元素）」 | 插件规则命中宿主元素 |
| 宿主隔离：不用裸元素选择器 | `client-style-scope.test.mjs`「宿主隔离：插件规则不靠裸元素选择器命中宿主（button / input / a / p 一类）」 | `button { … }` 一类写法把宿主按钮一起改了 |
| 宿主隔离：不在 `:root` / `body` 上声明插件变量 | `client-style-scope.test.mjs`「宿主隔离：插件不声明全局变量（:root / body 上不许有插件 token）」 | 插件改掉宿主的全局主题 |
| 插件控件自带盒模型与字体基线 | `client-style-scope.test.mjs`「插件控件自带盒模型与字体（作用域挡不住宿主**继承**）」 | 宿主继承把插件控件布局压坏 |

### 市场法规则的可测试计算模块（方案 §8 / §10）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 20% / 30% / 1.2 的**等于**算到限、不算超 | `test_market_rules.py`「test_single_factor_20_percent」/「test_combined_30_percent」/「test_price_ratio_12」 | 等于阈值被判成超限（或反过来静默放过） |
| 略低 / 略高各一档 | 同上（`1.199` / `1.201`、`1.299` / `1.301`、`119.9` / `120.1`） | 只测等于那一档，边界语义其实没定 |
| 浮点表示不许把等于判成略低 | `test_market_rules.py`「test_floating_point_at_the_boundary_is_not_misjudged」 | 1.2 因二进制误差变成 1.2000000000000002 |
| 综合修正是**连乘**，不是百分比相加 | `test_market_rules.py`「test_combined_is_a_product_not_a_sum」 | 两项各 +10% 被算成 20%（正确是 21%） |
| 修正方向：对象/案例指数定系数 | `test_market_rules.py`「test_ratio_direction」 | 系数上下颠倒，价格朝反方向修正 |
| 取整用 Excel 口径（不是银行家舍入） | `test_market_rules.py`「test_uses_excel_half_up_not_bankers_rounding」 | 底稿（Excel）与 JSON 的数字对不上 |
| 阈值与知识库参考逐字一致 | `test_market_rules.py`「test_thresholds_match_the_reference_document」 | 有人悄悄把 20% 改成 25% 而没人发现 |
| 案例数量不足不许给正式单价 | `host-valuation-ops.test.mjs`「完成由宿主判定：三件交付件齐备且结果读得懂」 | 用 1〜2 个案例平均出一个"正式结论" |
| 金额口径必须勾稽 | 同上（断言 `对不上`） | 三个数各说一套却算完成 |

### 文件列表的四种形态（方案 §4 / §10；布局本身仍要真机看）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 少量文件：逐份都画、不折叠 | `client-valuation-pane.test.mjs`「少量文件：逐份都画出来，不做任何折叠」 | 三份文件也被折叠起来 |
| 大量文件：有界列表 + 「查看全部 N 份」 | `client-valuation-pane.test.mjs`「大量文件：有界列表 + 「查看全部 N 份」，不把后续设置推到很远」 | 20 份文件把方法 / 基准日 / 操作区推到屏幕外 |
| 长文件名：完整名称可查（行内截断交给 CSS） | `client-valuation-pane.test.mjs`「长文件名：行内截断，完整名称在 title 里查得到」 | 截断之后再也看不到完整名字 |
| 解析失败：逐份给出具体原因 | `client-valuation-pane.test.mjs`「解析失败：逐份给出具体原因，而不是只说「未完成」」 | 用户只知道"有一份没读出来"，不知道是哪份、为什么 |
| 扫描失败：说清是清单读不出来 | `client-valuation-pane.test.mjs`「扫描失败：说清楚是清单读不出来，而不是"你还没选"」 | 失败被读成"用户没选资料" |

### 规则检查记录与案例状态（方案 §8）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 规则 ID / 状态 / 阈值与计算模块是同一套词 | `test_valuation_contracts.py`「test_rule_ids_and_status_must_match_the_calculation_module」 | 计算模块说超限、结果里记成别的东西，两边长期分叉 |
| 每条案例必须有 `rule_checks` | `test_valuation_contracts.py`「test_case_needs_rule_checks」 | 只有一句"符合要求"，复核的人没法重算 |
| 规则项必须给 ID / 判定 / 理由 | `test_valuation_contracts.py`「test_rule_check_needs_id_verdict_and_reason」 | 判定无名无据 |
| 阈值必须等于知识库口径 | `test_valuation_contracts.py`「test_threshold_must_equal_the_knowledge_value」 | 有人把 20% 悄悄改成 25% |
| 数值型判定必须给出实际值 | `test_valuation_contracts.py`「test_numeric_verdict_needs_an_actual_value」 | 只有结论没有实际值 |
| 剔除案例必须能对上触发它的规则 | `test_valuation_contracts.py`「test_dropped_case_needs_a_reason_not_a_one_liner」 | 状态说"未通过"，却不知道依据哪条规则 |
| 状态与 `used_as_comparable` 必须一致 | `test_valuation_contracts.py`「test_status_and_used_as_comparable_must_agree」 | 一处说采用、一处说剔除 |
| 状态枚举受约束 | `test_valuation_contracts.py`「test_status_enum」 | 自由文本状态 |
| 组内比值必须能重算 | `test_valuation_contracts.py`「test_group_ratio_must_be_recomputable」 | 写一个好看的比值蒙过去 |
| 比值超 1.2 必须有处置说明 | `test_valuation_contracts.py`「test_group_over_12_needs_an_explanation」 | 静默忽略组内不一致 |
| 采用案例不许带着没通过的规则 | `test_valuation_contracts.py`「test_adopted_case_cannot_carry_a_failed_rule」+ `host-valuation-ops.test.mjs`「完成门槛：采用案例带着没通过的规则判定时不许算完成（规范允许的组内比值例外）」 | 有规则没过却当正式结论；宿主这一层不兜底则子会话跳过校验就漏 |
| 结果页给出规则校验摘要 | `client-valuation-pane.test.mjs`「结果页给出规则校验摘要：逐条规则给出通过 / 未通过数与阈值，组内比值可复核」 | 用户看不到"按哪几条规则查过" |
| 超限在摘要上明说并指向处置 | `client-valuation-pane.test.mjs`「组内比值超过 1.2 时摘要上明说"已超过阈值"，并把处置指向待确认事项」 | 超限被折进一个没有标记的数字里 |

### 抽屉动作与来源预检分类（方案 §5 / §11.2）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 抽屉动作恰好是 返回修改 / 重新检查 / 确认并开始 | `client-valuation-pane.test.mjs`「渲染：确认阶段画出只读抽屉，恰好三个按钮，且**没有任何**可编辑控件」 | 少一个「重新检查」，用户刚登录完只能返回表单从头再来 |
| 预检失败分类：网络 / 验证码 / 登录墙 / 站点错误 各说各的 | `host-valuation-market.test.mjs`「预检分类：网络失败 / 验证码 / 登录墙 / 站点错误 各自给不同的话」 | 一律报"无法检查"，用户不知道该去登录还是换网络 |
| 验证码单独标记（插件不绕过验证） | 同上（`captcha === true` + 「不会绕过验证」） | 验证码被说成"你没登录"，用户反复登录也没用 |
| 「页面结构无法识别」在**检索**那一层报 | `host-valuation-market-tool.test.mjs`「检索：页面取到但**没有**结构化房源 → 0 条 + 能力缺口（绝不按标题猜）」 | 预检时误判（首页本来就没有房源列表），或按标题猜数据 |

### 底稿与结果 JSON 的一致性（方案 §8「截图编号」/ §9「三者一致」）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 采用案例的证据必须写进底稿的案例表 | `test_valuation_contracts.py`「test_workbook_must_carry_the_adopted_cases_evidence」 | 报告说留了证据、底稿上却是空的 |
| 那一行被整行删掉也算不合格 | `test_valuation_contracts.py`「test_missing_evidence_row_is_an_error_not_a_silent_skip」 | "找不到就跳过"—— 证据留档整行消失而无人知 |

### 抓取失败分类与跨站去重（方案 §7.3）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 失败分类：登录 / 验证码 / 限流 / 失效 / 站点错误 / 网络 各是一类 | `host-valuation-market.test.mjs`「抓取失败分类：需要登录 / 验证码 / 限流 / 页面失效 / 站点错误 / 网络 各是一类」 | 一律写"取不到"，事后分不清"站点没有案例"与"被风控拦了" |
| 验证码优先于登录墙 | 同上（`captcha` 先于 `loginRequired`） | 被验证码挡住时说成"你没登录"，用户反复登录也过不去 |
| 每一类有单独的人话 | 同上（九类标签互不相同） | 分类形同虚设（都显示同一句） |
| 抓取通道把类别带进错误信息 | `host-valuation-market.test.mjs`「抓取通道：网络异常 / 白名单外重定向 / 状态码失败 都带上类别与可区分的话」 | 三次重试记录三行一模一样的 `HTTP 403` |
| 跨站去重：同一套房源只算一条 | `host-valuation-market.test.mjs`「跨站去重：同一套房源在两个来源出现只算一条，且留下"与谁重复"的痕迹」 | 同一套房在两个站点各记一条，凑出假的可比实例数 |
| 同小区**不同**房源不合并 | 同上（面积 / 价格不同 → 保持两条） | 靠"小区相同"合并，案例凭空少一条 |
| 拿不到面积或价格时不参与合并 | 同上（指纹为空 → 照常保留） | 误并不同房源 |
| 去重结果与合并条数进检索应答 | `host-valuation-market-tool.test.mjs`「跨站去重接进检索：结果里的案例数是**合并之后**的，并给出合并了几条」 | 界面报的案例数与实际采用数对不上 |

### 交付校验进完成门槛（方案 §9：模板改坏 / 报告与结果对不上都不得完成）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 校验结论写回轮次 | `host-valuation-artifact-validate.test.mjs`「校验结论要**写回轮次**：完成门槛据此判断"交付前两道校验都过了"」 | `completed` 只能相信模型说"我验过了" |
| 写回与校验结论一致 | `host-valuation-artifact-validate.test.mjs`「校验结论与写回**一致**：过了就是 true，没过就是 false + 逐条原因」 | 把"没过"记成"没跑过"，界面给出错误的下一步 |
| 没跑过交付校验不算完成 | `host-valuation-ops.test.mjs`「完成由宿主判定：三件交付件齐备且结果读得懂」 | 模板被改坏、报告与 JSON 对不上也照样 `completed` |
| 两道校验都要跑过才算有效结论 | `artifact-validate.ts` 的 `ranBoth`（脚本没跑成时按"没通过"记，不把"没跑成"当成"过了"） | 脚本一次都没跑成就当校验通过 |

### 方法判断记录与"不许静默切换"（方案 §7.2）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 方法判断必须留记录（采用哪个、依据） | `test_valuation_contracts.py`「test_screening_is_required」+「test_method_screening_needs_exactly_one_adopted」 | 只有一句"采用市场法"，看不出别的为什么不采用 |
| 恰好一条 adopted 且与结论一致 | `test_valuation_contracts.py`「test_method_screening_must_agree_with_the_conclusion」 | 筛选记录说收益法、结论却是市场法 |
| 每个方法都要写依据 | `test_valuation_contracts.py`「test_every_screened_method_needs_a_reason」 | "不符合要求"这种不可复核的一句话 |
| 没有冲突要显式写 null | `test_valuation_contracts.py`「test_no_conflict_must_be_explicit_null」 | 分不出"没冲突"与"忘了写" |
| **用户指定的方法不许被静默切换** | `test_valuation_contracts.py`「test_user_specified_method_cannot_be_switched_silently」+ `host-valuation-ops.test.mjs`「完成门槛：用户指定的方法被换掉时必须写出方法冲突（不许静默切换）」 | 用户选收益法、结果按市场法给数，界面上什么都不说 |
| 冲突记录必须指向用户真正选的那个方法 | `test_valuation_contracts.py`「test_conflict_must_name_the_user_method」 | 冲突记录张冠李戴 |
| 自动判定时不许造冲突 | `test_valuation_contracts.py`「test_no_conflict_when_the_user_specified_auto」 | 没有用户指定却报"方法冲突" |
| 用户指定的方法就是采用的那个时冲突必须为 null | `test_valuation_contracts.py`「test_conflict_is_null_when_the_user_method_was_adopted」 | 无冲突也报冲突 |
| 换了方法必须说明为什么 | `test_valuation_contracts.py`「test_conflict_reason_is_required」 | 换了却不给理由 |
| 结果页把冲突摆在结论之前 | `client-valuation-pane.test.mjs`「用户指定的方法被换掉时，结果页把冲突摆在结论之前」 | 冲突被埋在正文里，用户看不到 |
| 结果页给出方法判断记录 | `client-valuation-pane.test.mjs`「结果页给出方法判断记录：采用哪个、其他为什么不采用」 | 读者不知道别的方案为什么被排除 |

### 结果页的案例来源 + 规则只在适用方法里执行（方案 §9 第 3 条 / §8）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 结果页给出最终采用案例的**来源分布** | `client-valuation-pane.test.mjs`「结果页给出最终采用案例的**来源分布**与每条的来源（§9 第 3 条）」 | 只给一个总数，看不出"结论压在几个站点上" |
| 每条案例标出来源站点 | 同上（`data-valuation-case-source`） | 复核时追不到这条案例是从哪个站点取的 |
| 来源拿不到时不制造假分组 | `client-valuation-pane.test.mjs`「来源拿不到时不当成"有个空来源"（不制造假分组）」 | 结果页多出一行没有任何来源名的空分组 |
| 比较案例调整规则**只在市场法**里执行 | `test_valuation_contracts.py`「test_market_rules_only_apply_to_the_market_method」 | 把 20% / 30% / 1.2 套到收益法 / 成本法上（那两条方法里没有"可比实例修正系数积"这一层） |

### 底稿必须带上汇总依据与限制（方案 §8「计算表填写」）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 模板留出「权重 / 汇总依据」「已知限制」「待确认事项」三行 | `test_valuation_contracts.py`「test_template_must_keep_the_summary_basis_rows」+ `check_workbook_contract.py` 的 `REQUIRED_SUMMARY_ROWS` | "最终单价怎么汇总的"与"这份底稿到什么程度为止"没地方写；整行删掉也没人报 |
| `manual_confirmation_items` 必须落进底稿的「待确认事项」行 | `test_valuation_contracts.py`「test_confirmation_items_must_reach_the_workbook」 | 报告上写了限制、交出去的底稿上看不出来（复核时最难发现的一类不一致） |

### 用用户实际模板 + 模板可追溯（方案 §7.1）

| 验收标准 | 强制点 | 去掉它会放走什么 |
| --- | --- | --- |
| 必须用**给定的**那份模板，不许悄悄换成随包模板 | `test_valuation_contracts.py`「test_uses_the_template_it_was_given_not_the_shipped_one」 | 知识库里下载的用户模板被无视，底稿其实出自随包模板 |
| 「外观类似但结构不同」的模板要在动手前拦住 | `test_valuation_contracts.py`「test_rejects_a_lookalike_template」 | 少一张表 / 表名不同的仿制模板填完一轮才发现，整轮白做 |
| 拒绝时不留半成品 | 同上（`assertFalse(os.path.exists(self.out))`） | 半填的底稿看上去有数据，公式还会算出看起来正常的数 |
| 模板缺失要报错，不能回退到默认 | `test_valuation_contracts.py`「test_missing_template_is_an_error_not_a_silent_default」 | `--template` 打错字就静默用随包模板 |
| 产物要说明用的是哪一份模板（路径 + 指纹） | 同上（`用户/知识库模板` + `sha256:…`） | 事后分不清底稿出自随包模板还是用户模板 |

### 这一层里查不了的（能力缺口，不是"已满足"）

| 条目 | 现状 | 为什么本机查不了 |
| --- | --- | --- |
| 容器查询的真实布局（宽面板一行四项 / 窄面板纵向） | **未真机验证**：规则写了 `@container crwu-valuation (min-width: 560px)`，本机没有浏览器 | 需要真机 profile 与 playwright |
| 宿主侧栏展开 / 收起时的面板宽度行为 | **未真机验证** | 同上 |
| 面板内粘性操作区是否遮挡输入 | **未真机验证**：规则用 `position: sticky; bottom: 0`，不覆盖宿主页面 | 同上 |
| 点下去到抽屉打开的**观感**（首帧反馈是否够明显） | **未真机验证**：本机断言的是"同一帧进入 extracting"这一事实 | 观感只能由人在真实面板上看 |
