# 房地产估值知识取数改造：从技能内置路由表到知识库侧声明

- **日期**：2026-10-15
- **状态**：待评审
- **影响层**：`plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate`、`plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge`、`plugins/dsh-crwu-workbench/src/host/tools/report-evaluation`

## 1. 背景与问题

三个已核实的问题，同源：**把「取哪些知识、按什么顺序取」规范成了技能里的静态结构**。

### 1.1 业务正文在技能里留了降级副本

`references/` 下有 6 份业务正文，约 760 行：

| 文件 | 行数 |
| --- | --- |
| `01-realestate-valuation.md` | 99 |
| `02-market-method.md` | 172 |
| `03-income-method.md` | 92 |
| `04-case-selection.md` | 199 |
| `05-parameter-mapping.md` | 139 |
| `07-cost-method.md` | 116 |

这些内容现已进入知识库（`02 估值方法/02 市场法.md` 等）。副本与正本会漂移，且技能随包发布、改一次要发版。

### 1.2 路由表写死在代码里，且事实源有两份

`route.ts` 的 `VALUATION_KNOWLEDGE_ROUTES` 有 9 条路由，含库内逐字路径、`aliases`、`expectedNames`、`required`。同时 `references/knowledge-routing.md` 又写了一遍同样的 9 条。

而 `SKILL.md:60` 声称「路由键与库内层级路径的**唯一事实源**是本技能的 `knowledge-routing.md`」——**这句话与代码不符**：`resolve.ts:236,920` 读的是 TS 常量。两份靠人肉同步。

后果：知识库改名（2026-10-14 把 `02-市场法` 改成 `02 市场法`）要求技能发版，于是 `aliases` 表越堆越长。

### 1.3 「缺必需项就停」把业务卡死

`resolve.ts:920` 的口径是**任何**路由没取到就让整轮物化 `ok = false`：

```ts
if (missing.length > 0) { manifest.ok = false; manifest.errorKind = 'capability-gap' }
```

`required` 标记只改错误文案，不影响是否失败。于是 `01 房地产估值通用` 目录在库中为空时，每次估值必然中断。

根因不是某个常量写错，而是**「流程规范到必需项清单」这个做法本身**：规范越细，越容易在某个格子空着时把整个业务卡死。

### 1.4 附带发现的死代码

| 位置 | 问题 |
| --- | --- |
| `route.ts:288` `requiredRouteIds()` | 被 `index.ts` import，**全仓无任何调用** |
| `handoff.ts:414` `knowledgeReady: true` | **硬编码 true**，导致 `prompt.ts:158` 的「停止测算」分支永不触发 |
| `prompt.ts:160` | 该死分支还占着「必需知识缺失 → 停止测算」的口径 |

## 2. 目标

1. **知识由知识库 wiki 声明，改库即生效、零发版**：有哪些估值方法、各方法正文在哪、各用哪个计算表模板。
2. **技能退化为「能力 + 产物契约 + 正确性不变量」**，流程编排交给 agent。
3. **取数工具从「按阶段调度」改为「按路径取」**。

## 3. 非目标

- 不改浏览器能力与站点清单（站点是插件能力，留技能/配置）
- 不改产物形状（工作簿七表契约、报告数据 schema、报告 HTML 模板均不动）
- 不引入任何新的「必需项清单」机制——那正是要删的东西
- 不做收益法 / 成本法的正文补齐（业务侧负责）

## 4. 设计

### 4.1 知识库侧 manifest

**位置**：`01 估值与测算/01 房地产/<文件名>`（文件名待业务侧确认）

**格式**：沿用 `parseTemplateIndex` 已有的两种形态，不另造一套：

| 形态 | 结构 | 说明 |
| --- | --- | --- |
| ① JSON 围栏 | `json` 围栏里的 manifest 对象 | 权威形态 |
| ② Markdown 清单表 | 表头固定的清单表 | 业务维护者好写；能力弱于 ① |

解析不了就报 capability-gap 并说清「需要哪一种形态」，**不静默降级**。

**内容**：

```json
{
  "version": 1,
  "methodSelection": "02 估值方法/01 房地产评估方法选择方案.md",
  "methods": {
    "market": {
      "guide": "02 估值方法/02 市场法.md",
      "template": "05 计算表模板/01 市场法/01 市场法计算表模板-住宅.xlsx"
    },
    "income": { "guide": "02 估值方法/03 收益法（TODO）.md", "template": null },
    "cost": { "guide": "02 估值方法/04 成本法（TODO）.md", "template": null }
  }
}
```

- `template: null` 就是「该方法还没有模板」，如实表达，不另设状态
- **路径基准**：manifest 内的所有路径相对 **manifest 自己所在的目录**（`01 估值与测算/01 房地产`）逐字书写，与 `manifestPath` 的基准不同——后者相对知识库根。两条基准都要在解析器里写死并有测试覆盖
- **不再有** `required` / `aliases` / `expectedNames` / `stages` / `methods`(集合) / `kind` / `extensions`

### 4.2 Bootstrap

config 新增一个键（唯一还写死的东西，因为它没法由库侧给：

```yaml
# config/crwu-workbench.yml
valuation:
  knowledge:
    mirrorRoot: ''
    manifestPath: 01 估值与测算/01 房地产/<文件名>
```

- 相对**知识库根**的路径，不是文件系统路径
- 默认值写在 `config.ts` 的 `DEFAULT_VALUATION_KNOWLEDGE`
- 校验口径同 `valuation.browser.sitesFile`：非空、不含 `..`、不以 `/` 开头
- **读不到 manifest = 唯一真停**（没有入口）。这不是「我们规定它必需」，是鸡生蛋

### 4.3 取数工具改造

`crwu_valuation_knowledge_materialize`：

| 项 | 改造 |
| --- | --- |
| `stage` 参数 | **删** |
| `method` 参数 | **删** |
| `routesForStage()` 调度 | **删** |
| 入参 | 改为显式路径列表（来自 manifest） |
| 保留 | 来源标注（`dws` / `verified-mirror`）、正文指纹、查找轨迹、快照落盘、非空正文校验 |

原来那条「不许因为 auto 就全量注入」的成本控制不再需要：manifest 瘦成「每方法 3 个指针」，全拉也就几份文档。

### 4.4 案例获取链（技能持有流程，wiki 提供判据）

```
读 <method>.guide → 取该方法的限制条件
  → 查插件能力（浏览器站点：链家 / 安居客 / 房天下 …）
      能力缺席 → 记 capability_gaps[]，只用手上有证据的案例
  → 列表页抓取
  → 按方法限制粗筛，记一版候选
  → 与方法逐条对比：超出限制的遗弃，只留最接近的
  → 详情页抓取
  → 数据落盘进计算表；证据（截图）按案例存
```

**筛选判据全部来自 wiki 方法正文**，技能不内置阈值。

### 4.5 保留的正确性不变量

这些**不是流程规范**，去掉后的失败模式不是「慢一点」，而是**静默产出错误估值**。全部保留：

| 不变量 | 理由 |
| --- | --- |
| 数字由脚本算，禁止心算 | 否则静默算出错数 |
| 空栏不填 0；缺失 ≠ 0 | `0` 与「不知道」混同，报告即错 |
| 模板只读、公式区不许硬编码 | 底稿会算出看起来正常的数 |
| 模板字节验真 | 拿到的可能不是索引指的那一份 |
| 案例来源不可核要标剔除、不许编造 | 估值结论能否立住 |
| 案例目录隔离 / 工具可见性 | **安全边界**，不是流程 |
| 产物形状（工作簿七表、报告数据 schema） | 交付件的**验收标准** |

### 4.6 缺失处置

| 情况 | 处置 |
| --- | --- |
| manifest 读不到 | **停**（唯一真停） |
| `<m>.guide` 为 `null` 或读不到 | 该方法不可用，退回人工确认 |
| `<m>.template` 为 `null` 或读不到 | 该方案挂起填表，其余继续 |
| 抓取站点不可用 | 记 `capability_gaps[]`，只用手上有证据的案例 |
| 目录存在但为空 | 与「节点不存在」区分报告，**都不阻断** |

## 5. 影响面

### 5.1 Host 代码

| 文件 | 改动 |
| --- | --- |
| `knowledge/route.ts` | 删 `VALUATION_KNOWLEDGE_ROUTES`、`requiredRouteIds`、`KnowledgeRoute` 的 `aliases`/`expectedNames`/`required`/`stages`/`methods`；保留 `RouteState`；新增 manifest 类型与解析入口 |
| `knowledge/resolve.ts` | `materializeKnowledge` 改路径驱动；重写 `resolve.ts:920` 的失败口径 |
| `knowledge/index.ts` | 导出调整，删死导出 |
| `knowledge/snapshot.ts` | `KnowledgeStage` 类型引用调整 |
| `tools/.../knowledge.ts` | 参数、描述、schema 改 |
| `tools/.../template.ts` | `templateRouteFor` 改从 manifest 取 |
| `domains/.../prompt.ts` | 删停止分支与 `knowledgeReady` |
| `operations/.../handoff.ts` | `knowledgeReady: true` 硬编码处置 |
| `config/config.ts` + `config/yaml.ts` | 新增 `manifestPath` 键与解析 |

### 5.2 技能

**删除**：`references/01-realestate-valuation.md`、`02-market-method.md`、`03-income-method.md`、`04-case-selection.md`、`05-parameter-mapping.md`、`07-cost-method.md`

**重写**：`references/knowledge-routing.md`（约 210 行，为 9 条路由写的技术合同）→ 改为「manifest 契约 + 案例获取链」。不做补丁式修改。

**修改引用**：

| 文件 | 引用处 |
| --- | --- |
| `SKILL.md:150` | `references/02-market-method.md` 第 9 节 → wiki 方法正文 |
| `references/workflow.md:39` | `04-case-selection.md` §1.2 |
| `references/workflow.md:60` | `05-parameter-mapping.md` |
| `scripts/market_rules.py` | 第 4、12、23、133 行等多处 |
| `scripts/validate_result.py:72,481` | `references/01` / `02` |
| `scripts/test_market_rules.py:107,125` | `references/02` |
| `scripts/test_valuation_contracts.py:613` | `references/02` |
| `examples/valuation-result.sample.json:9` | `references/02 第 2 节` |

**保持不动**：`references/06-workbook-contract.md`、`09-output-contract.md`、`execution-and-land-extension.md`、`workflow.md` 的结构（仅改上表引用处）

### 5.3 测试

| 测试 | 预计影响 |
| --- | --- |
| `tests/unit/host/host-valuation-knowledge.test.mjs`（1040 行） | **主要重写对象** |
| `tests/unit/host/host-valuation-knowledge-tool.test.mjs`（452 行） | 参数与描述改 |
| `tests/unit/host/host-valuation-template.test.mjs` / `-template-tool.test.mjs` | 模板来源改 |
| `tests/unit/host/host-valuation-handoff.test.mjs` | `knowledgeReady` |
| `tests/unit/host/host-yaml-config.test.mjs` | 新配置键 |
| `tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs` | 链路核对 |
| 技能内 `scripts/test_*.py` | 引用改 |

### 5.4 配置与发布

`config/crwu-workbench.yml` 新键 · `scripts/check-config.mjs` · 版本号 · `CHANGELOG.md`

## 6. 测试策略

先写失败测试，确认失败原因正确，再实现。

1. **manifest 解析**：JSON 围栏 / Markdown 表 / 缺字段 / 坏路径 / 版本号不支持
2. **路径取数**：命中 / 缺失 / 空正文 / 歧义；`dws` 与 `verified-mirror` 两条通道
3. **缺失处置**：manifest 缺失（停）/ `guide` 为 null / `template` 为 null / 目录空
4. **不再有必需项**：`01 房地产估值通用` 为空时**不阻断**（本改造的回归锚点）
5. **技能自包含**：删正文后逐层跑校验器
6. **配置**：`manifestPath` 校验（空 / 相对 / 含 `..`）

### 完成门槛

先跑窄测试迭代，再跑仓库闸门：

```bash
npm run typecheck && npm test    # Workbench 窄循环
make plugin-check                # 打包 Skill / 交付形状 / 版本一致性
make docs-check                  # 改动了活跃 Markdown 入口
git diff --check                 # 空白与无关文件
```

## 7. 实施顺序

改动跨 Host、技能、测试、配置与发布，建议分四步，每步可独立验证：

1. **manifest 解析层**：类型 + 两种形态的解析器 + 校验，纯函数、可穷尽单测，不碰取数
2. **取数改造**：`materializeKnowledge` 转路径驱动，删 `stage`/`method` 调度；重写失败口径
3. **技能瘦身**：删 6 份正文、重写 `knowledge-routing.md`、修全部引用处、跑自包含校验
4. **配置与收尾**：`manifestPath` 键 + `check-config`、死代码清理、版本号、CHANGELOG

第 2 步是本改造的风险集中处（`host-valuation-knowledge.test.mjs` 1040 行是主要重写对象），建议它在第 3 步之前完成并通过。

## 8. 已知限制

- **manifest 是知识库侧文档，业务维护者的误编辑没有测试保护**。技能测试只能覆盖解析器与校验器。缓解手段是进入估值前的校验 + manifest 自身的快照与指纹留痕（报告能说清依据的是哪一版）。
- 收益法 / 成本法正文当前在库中为空，`template` 为 `null`，这两种方法改造后仍不可用——如实表达，不是回归。

## 9. 待业务侧确认

1. manifest 的文件名与确切位置（挂在 `01 房地产/` 根下还是 `02 估值方法/` 里）
2. manifest 采用哪种形态：JSON 围栏（权威、可带指纹）还是 Markdown 清单表（好写）
3. 案例抓取站点是否从链家扩到安居客 / 房天下（本次不阻塞，站点留插件侧）
