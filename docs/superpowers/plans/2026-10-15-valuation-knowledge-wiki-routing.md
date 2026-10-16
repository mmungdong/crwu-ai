# 房地产估值知识取数改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把房地产估值的知识路由从技能内的 TS 常量搬到知识库侧的一份 wiki manifest，使改知识库即生效、无需发版，并删掉技能内 6 份业务正文降级副本。

**Architecture:** 知识库 `01 估值与测算/01 房地产/<文件名>` 下放一份 manifest，声明方法选择方案、各方法正文与各方法计算表模板的**库内路径**。Host 按配置的 `manifestPath` 取回并解析成路由表，取数工具从「按阶段调度」改为「按显式 routeId 取」。manifest 的键位推导出稳定 routeId（`method-selection` / `method.<m>.guide` / `method.<m>.template`），因此 `routeId` 字段在既有 schema 中不变。

**Tech Stack:** TypeScript（Host，ESM，Cordis/DSH 生命周期）· Python 3（技能脚本）· Node 内置 test runner（`node --test`，`tests/**/*.test.mjs`）

**Spec:** [`docs/superpowers/specs/2026-10-15-valuation-knowledge-wiki-routing-design.md`](../specs/2026-10-15-valuation-knowledge-wiki-routing-design.md)

## Global Constraints

- **唯一真停 = manifest 读不到。** 除此之外任何缺失都不阻断；不存在「必需项清单」。
- **路径基准两条，各自写死并有测试：** `valuation.knowledge.manifestPath` 相对**知识库根**；manifest 内的路径相对 **manifest 自己所在的目录**。
- **`template: null` = 该方法还没有模板**（正常，不是错误）；字段**缺失**才是 manifest 写坏了。
- **保留的正确性不变量**（不得在本次改动中削弱）：数字由脚本算不心算；空栏不填 0（缺失 ≠ 0）；模板只读、公式区不许硬编码；模板字节验真；案例来源不可核要标剔除、不许编造；案例目录隔离与工具可见性；产物形状（工作簿七表、报告数据 schema）。
- **不做**收益法 / 成本法正文补齐（业务侧负责，当前为空）。
- **站点留在插件侧**（`assets/browser-sites.json`），本次不进知识库。
- 提交信息用 Angular 规范英文格式，不加 `Co-Authored-By` 行（用户全局规范）。
- 不自动提交推送 —— 每个任务的 commit 步骤执行前需用户明确授权。

## Review Focus

以下五类输入是 spec 未明说、但最可能让人踩坑的，各自在所属任务的测试里钉住：

1. **manifest 里写了 `..` 或绝对路径** —— 必须拒绝，不得逃出知识库根。
2. **`guide` / `template` 的字段缺失 vs 显式 `null`** —— 前者是 manifest 写坏了（`problems` 非空、`ok:false`），后者是「该项还没写」（正常，`ok` 不受影响）。收益法与成本法的正文当前在库中为空，走的就是 `null` 这一路。
3. **两个 routeId 指向同一路径** —— 应照常工作，不得因「重复」报错。
4. **manifest 里的路径指向一个目录而非文件** —— 该 routeId 记 `empty`，不阻断其余。
5. **节点存在但正文为空（`empty`）与节点不存在（`missing`）** —— 报告必须区分，两者都不阻断。

---

### Task 1: manifest 解析层

纯函数，不碰网络与文件系统，可穷尽单测。这是整条链的地基。

**Files:**
- Create: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/manifest.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-manifest.test.mjs`

**Interfaces:**
- Consumes: `KnowledgeRouteKind`（`'document' | 'binary' | 'directory'`，来自 `route.ts`）
- Produces:
  - `interface ManifestRoute { routeId: string; path: string; kind: KnowledgeRouteKind }`
  - `interface ManifestParseResult { ok: boolean; error: string; problems: string[]; warnings: string[]; methodSelection: string | null; routes: ManifestRoute[] }`
  - `function parseValuationManifest(document: string): ManifestParseResult`
  - `function manifestRoutePath(manifestDir: string, route: ManifestRoute): string` —— 把 manifest 内的相对路径拼成库内完整路径

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/host/host-valuation-manifest.test.mjs`，头部照 `host-valuation-knowledge.test.mjs` 的模式：

```js
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { parseValuationManifest, manifestRoutePath } =
  await import(new URL('src/host/domains/report-evaluation/knowledge/manifest.ts', ROOT).href)
```

必写的断言（每条一个 `test(...)`）：

- 合法 JSON 围栏 → `ok === true`，`routes` 含三个 routeId：`method-selection`、`method.market.guide`（kind `document`）、`method.market.template`（kind `binary`）；`methodSelection === '02 估值方法/01 房地产评估方法选择方案.md'`
- `template: null` → `ok === true`，且 `routes` 中**不含** `method.income.template`
- `methods.market.template` 字段**缺失** → `ok === false`，`problems` 非空
- `guide: null` → `ok === true`，且 `routes` 中**不含** `method.income.guide`（与 `template: null` 对称：方法已登记，正文还没写）
- `methods.market.guide` 字段**缺失** → `ok === false`，`problems` 非空
- `version: 2` → `ok === false`，`problems` 含不支持的版本说明
- 路径含 `..` → `ok === false`
- 路径以 `/` 开头（绝对）→ `ok === false`
- 两个 routeId 指向同一路径 → `ok === true`（不得因重复报错）
- 无 `json` 围栏也无清单表 → `ok === false`，`error` 说清**需要哪一种形态**
- `manifestRoutePath('01 估值与测算/01 房地产', { path: '02 估值方法/02 市场法.md', ... })` → `'01 估值与测算/01 房地产/02 估值方法/02 市场法.md'`

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-manifest.test.mjs`
Expected: FAIL —— `manifest.ts` 不存在 / `parseValuationManifest is not a function`

- [ ] **Step 3: 实现 `manifest.ts`**

参照 `templates.ts` 的 `parseTemplateIndex`（`src/host/domains/report-evaluation/knowledge/templates.ts:271`）的写法：先 `matchAll` 抓 ` ```json ` 围栏，逐个 `JSON.parse`，失败进 `problems` 而**不静默跳过**。

键位 → routeId 的推导规则（写死，且有测试）：

| manifest 键位 | kind |
| --- | --- |
| 顶层 `methodSelection` | `document` |
| `methods.<m>.guide` | `document` |
| `methods.<m>.template` | `binary` |

**`guide` 与 `template` 走同一套三态规则**，不得各写一套：

| 取值 | 含义 | 处置 |
| --- | --- | --- |
| 非空字符串 | 有 | 产生一条 route |
| `null` | 方法已登记，该项还没写（`03 收益法（TODO）.md` 属此类） | **跳过**，不进 `routes`，不进 `problems`，`ok` 不受影响 |
| 字段缺失 / 其它类型 | manifest 写坏了 | 进 `problems`，`ok = false` |

其它必填校验：`version` 必须为 `1`；`methodSelection` 必须是非空字符串；`methods` 必须是对象，其每个值必须是对象。

路径校验（`problems`，不 throw）：非空字符串、不以 `/` 开头、按 `/` 切分后不含 `..`。

Markdown 清单表形态作为受控适配一并实现：表头逐字要求「routeId / 路径」两列；未登记或多值整行报 `problem`，不猜。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-manifest.test.mjs`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**（需用户授权）

```bash
git add plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/manifest.ts \
        plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-manifest.test.mjs
git commit -m "feat(workbench): add knowledge manifest parser for valuation routing"
```

---

### Task 2: 配置新键 `manifestPath`

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/config/config.ts`（`ValuationKnowledgeConfig` 与 `DEFAULT_VALUATION_KNOWLEDGE`，约 79-96 行）
- Modify: `plugins/dsh-crwu-workbench/src/host/config/yaml.ts`（`parseValuationKnowledge`，185-195 行）
- Modify: `plugins/dsh-crwu-workbench/config/crwu-workbench.yml`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-yaml-config.test.mjs`

**Interfaces:**
- Produces: `ValuationKnowledgeConfig.manifestPath: string`，默认 `'01 估值与测算/01 房地产/00-知识目录与必需项'`

> 默认文件名待业务侧确认（spec 第 9 节）。先用上面这个值把链路跑通，业务侧定了改 `DEFAULT_VALUATION_KNOWLEDGE` 一处即可。

- [ ] **Step 1: 写失败测试**

在 `host-yaml-config.test.mjs` 加：

- 未给 `valuation.knowledge` → `manifestPath` 等于默认值
- 给了合法相对路径 → 采用该值
- 给了 `/abs/path` → throw，信息含 `valuation.knowledge.manifestPath`
- 给了 `a/../b` → throw
- 给了空串 → throw

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-yaml-config.test.mjs`
Expected: FAIL —— `manifestPath` undefined

- [ ] **Step 3: 实现**

`config.ts`：`ValuationKnowledgeConfig` 加 `manifestPath: string`（带 spec 4.2 的口径注释：相对知识库根、不是文件系统路径、不进模型可见结果）；`DEFAULT_VALUATION_KNOWLEDGE` 加默认值。

`yaml.ts` 的 `parseValuationKnowledge`：照现有 `mirrorRoot` 的写法加校验，但**基准不同** —— `mirrorRoot` 是文件系统绝对路径，`manifestPath` 是**相对知识库根的库内路径**，所以校验是「非空、不以 `/` 开头、不含 `..`」，与 `parseValuationBrowser` 里 `sitesFile` 的校验同构。

`config/crwu-workbench.yml` 的 `valuation.knowledge` 节加该键并附注释说明基准与「读不到即停」。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run config:check && node --test tests/unit/host/host-yaml-config.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git add plugins/dsh-crwu-workbench/src/host/config plugins/dsh-crwu-workbench/config/crwu-workbench.yml \
        plugins/dsh-crwu-workbench/tests/unit/host/host-yaml-config.test.mjs
git commit -m "feat(workbench): add valuation knowledge manifestPath config"
```

---

### Task 3: `KnowledgeRoute` 瘦身、`resolveRoute` 转路径匹配

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/route.ts`（删路由表与 `KnowledgeRoute` 的 `directory`/`fileName`/`aliases`/`expectedNames`/`required`/`stages`/`methods`/`when`）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/resolve.ts`（`resolveRoute` 409 行起、`snapshotFileFor` 368 行起）
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-knowledge.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `ManifestRoute`
- Produces:
  - `interface KnowledgeRoute { routeId: string; path: string; kind: KnowledgeRouteKind; extensions: readonly string[] }`
  - `function resolveRoute(catalog: KnowledgeCatalog, spec: KnowledgeRoute): RouteResolution`（签名不变，语义改为按**完整路径**匹配）

- [ ] **Step 1: 写失败测试**

改造 `host-valuation-knowledge.test.mjs` 中依赖 `VALUATION_KNOWLEDGE_ROUTES` / `routeById` / `aliases` 的用例，新增：

- 完整路径精确命中 → `state === 'found'`
- 路径里连字符 ↔ 空格变体（`02-市场法.md` vs `02 市场法.md`）→ 仍 `found`（折叠逻辑保留）
- 两条真实节点仅差该两种写法 → `ambiguous`，保留全部候选路径，**不选第一份**
- 路径指向目录而非文件 → `state === 'empty'`
- 路径不存在 → `state === 'missing'`
- 除名 `aliases` 后：老扁平路径 `估值与测算/房地产/02-市场法` → `missing`（不再恢复）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-knowledge.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`route.ts`：`KnowledgeRoute` 收敛成上面四个字段。`resolve.ts` 的 `resolveRoute` 改为按 `spec.path` 做身份折叠匹配（`knowledgeIdentityKey` 已有，保留其「只折叠连字符 ↔ 空格与全角 ↔ 半角」的口径），删除 alias 恢复阶梯。`snapshotFileFor` 改用 `routeId` 派生落点文件名（保持现有命名规则）。

`route.ts` 中 `requiredRouteIds`、`routesForStage`、`routeById`、`routeAllowedAt`、`knowledgeNodeNames`、`VALUATION_KNOWLEDGE_ROUTES`、`KnowledgeStage`、`VALUATION_STAGES`、`isKnowledgeStage` 随本次删除 —— 注意 `index.ts` 的 re-export 同步收敛，且 `scope.ts` / `valuation-state.ts` / `shared/contracts` 各自持有的 `VALUATION_METHODS` 副本**不受影响**（本次不动）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run typecheck && node --test tests/unit/host/host-valuation-knowledge.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "refactor(workbench): resolve valuation knowledge by path instead of route table"
```

---

### Task 4: `materializeKnowledge` 去 `stage`、接 manifest

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/resolve.ts`（`KnowledgeMaterializeInput` 与 `materializeKnowledge`，712 行起；失败口径 920 行起）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/snapshot.ts`（`KnowledgeStage` 引用）
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-knowledge.test.mjs`

**Interfaces:**
- Consumes: Task 1 `parseValuationManifest` / `manifestRoutePath`；Task 2 `manifestPath`；Task 3 `KnowledgeRoute`
- Produces:
  - `interface KnowledgeMaterializeInput { projectId: string; planId?: string | null; routeIds: readonly string[] }` —— **删掉 `stage`**
  - `KnowledgeMaterializeDeps` 加两个成员：
    - `manifestDir: string` —— manifest **所在目录**的库内路径（路径基准的唯一落点）
    - `loadManifest(): Promise<{ ok: boolean; document: string; error?: string }>`
  - `function toKnowledgeRoute(manifestDir: string, route: ManifestRoute): KnowledgeRoute` —— 桥接层，`resolve.ts` 内部导出。`path` 取 `manifestRoutePath(manifestDir, route)`；`extensions` 由 `kind` 推导：`document → ['.md']`、`binary → ['.xlsx', '.xls', '.xlsm']`、`directory → []`
  - `KnowledgeManifest` 加 `manifestDigest: string` 与 `availableRouteIds: string[]`

- [ ] **Step 1: 写失败测试**

- manifest 读不到 → `ok === false`、`errorKind === 'capability-gap'`，**这是唯一会整体失败的用例**
- manifest 读到了，请求一个 manifest 中不存在的 routeId → `ok === false`，`errorKind === 'input'`（这正是 spec 4.6 第 2、3 行的机制：`guide`/`template` 为 `null` 的方法，其 routeId 压根不在路由表里，请求它就得到输入错误，而不是静默取到别的方法正文）
- manifest 合法、请求 `method.market.guide` 且路径命中 → `ok === true`
- **回归锚点**：manifest 里 `methodSelection` 指向的目录为空、其余齐备 → `ok === true`（`01 房地产估值通用` 为空不再阻断）
- manifest 里路径指向目录 → 该 routeId `state === 'empty'`，`ok === true`
- `manifestDigest` 非空，且等于 manifest 正文的 sha256

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-knowledge.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`materializeKnowledge` 第一步改为取 manifest：经 `deps.loadManifest()` 拿到正文，`parseValuationManifest` 解析，失败即 `capability-gap` 返回。成功后对每条 `ManifestRoute` 调 `toKnowledgeRoute(deps.manifestDir, route)` 建路由表，按 `input.routeIds` 查找；查不到的 routeId 走 spec 4.6 的输入错误处置。

**重写 920 行起的失败口径**：删除 `if (missing.length > 0) { ok = false }` 这条钝规则；删除 `required` 集合与 `missingRequired` 文案分支。改为：只要 manifest 解析成功，物化就算 `ok`，逐条 routeId 的 `state`（`found`/`missing`/`empty`/`ambiguous`/`unreadable`）如实进 `states[]` 与 `capabilityGaps[]`，由调用方按 spec 4.6 处置。

索引落盘失败仍算 `infrastructure` 失败（保留现有语义）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run typecheck && node --test tests/unit/host/host-valuation-knowledge.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "refactor(workbench): drive knowledge materialization by manifest routes"
```

---

### Task 5: 取数工具改造

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/knowledge.ts`
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-knowledge-tool.test.mjs`

**Interfaces:**
- Consumes: Task 4 的 `materializeKnowledge`
- Produces: 工具 `crwu_valuation_knowledge_materialize` 的 `parameters` 去掉 `stage` 与 `method`，`routeIds` 变为可选；输出新增 `availableRouteIds`

- [ ] **Step 1: 写失败测试**

- 不传 `routeIds` → 只解析 manifest，返回 `availableRouteIds` 与 `ok: true`，不落任何正文快照
- 传 `['method.market.guide']` → 快照目录出现该文件，`entries[]` 有一条
- 传不存在的 routeId → `ok: false`，`errorKind: 'input'`
- 工具描述文本中**不再出现**「必需知识（realestate.common）缺失时返回失败」

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-knowledge-tool.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`defineTool` 的 `description` 重写为：按 manifest 声明的 routeId 取数；`routeIds` 省略时只回报可用路由（`routeIds` 的可选性要在 `parameters` 里如实标注）。注入 `deps.loadManifest`（读 `manifestPath`，走既有 catalog/dws 通道）。`idleResult()` 同步加 `availableRouteIds: []`。

`checklist` 字段改为直接来自 manifest 的 `routes`（去掉 `required` 字段）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run typecheck && node --test tests/unit/host/host-valuation-knowledge-tool.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "refactor(workbench): make knowledge materialize tool manifest-driven"
```

---

### Task 6: 模板选择改从 manifest 取

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/tools/report-evaluation/template.ts`（`routeById` / `templateRouteFor` 用法，18-20、200 行附近）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/route.ts`（删 `templateRouteFor`）
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-template.test.mjs`、`host-valuation-template-tool.test.mjs`

**Interfaces:**
- Consumes: Task 1 manifest 解析
- Produces: 模板 routeId 由键位推导 —— `method.<m>.template`（无须 `propertyType` 入参）

> 现有 `templateRouteFor(propertyType, method)` 用物业类型选模板（`template.market.residential`）。manifest 的 `methods.<m>.template` 只有方法维度。**本次按方法维度落地**：`propertyType` 细分留到业务侧真需要第二份模板时，再扩 manifest 结构。这是一个有意的简化，写进任务注释。

- [ ] **Step 1: 写失败测试**

- `methods.market.template` 有路径 → 解析得到 `method.market.template` 且 kind 为 `binary`
- `template: null` → 不存在 `method.<m>.template` 这一项；模板工具对该方法返回 capability-gap，**不抛异常、不猜一个模板**
- 模板字节与 manifest 声明不一致（若 manifest 给了 digest）→ 拒绝

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-template.test.mjs tests/unit/host/host-valuation-template-tool.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

模板工具改为：先取 manifest，查 `method.<m>.template`；不存在则返回 capability-gap 并说明「manifest 未声明该方法模板」。删 `route.ts` 的 `templateRouteFor` 与 `knowledge/templates.ts` 中不再被用到的物业类型筛选分支（若 `parseTemplateIndex`/`selectTemplate` 整体不再被调用则一并删除，并同步 `index.ts` 导出与 `schemas/`）。

> 若确认 `templates.ts` 整体作废，删它是本任务的**可选**部分 —— 先确认无其他调用方再删。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run typecheck && node --test tests/unit/host/host-valuation-template.test.mjs tests/unit/host/host-valuation-template-tool.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "refactor(workbench): select valuation template from knowledge manifest"
```

---

### Task 7: 删死代码、修正 prompt 与 handoff 口径

**Files:**
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/prompt.ts`（60-61、158-160 行）
- Modify: `plugins/dsh-crwu-workbench/src/host/operations/report-evaluation/handoff.ts`（414 行）
- Modify: `plugins/dsh-crwu-workbench/src/host/domains/report-evaluation/knowledge/index.ts`（删死导出）
- Test: `plugins/dsh-crwu-workbench/tests/unit/host/host-valuation-handoff.test.mjs`、`host-audit-prompt.test.mjs`

**Interfaces:**
- Produces: `prompt.ts` 的 `facts` 去掉 `knowledgeReady`；`handoff.ts` 不再硬编码

- [ ] **Step 1: 写失败测试**

- handoff 产出的事实里 `knowledgeReady` 的取值**来自 manifest 是否取到**，而非常量 `true`
- prompt 文本中**不再出现**「必需知识缺失：不要输出估值结论」
- prompt 文本中**不再出现**「realestate.common」字样
- `requiredRouteIds` 不再从 `knowledge/index.ts` 导出

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench && node --test tests/unit/host/host-valuation-handoff.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`knowledgeReady` 改由「manifest 是否成功取回并解析」计算（语义**收窄为**：知识入口是否可用）。`prompt.ts` 的 `knowledgeReady` 分支改写为：入口不可用 → 说明无法取得方法口径并交回人工；可用 → 按 manifest 读采用方法的正文。删「realestate.common」相关措辞。

`knowledge/index.ts` 删 `requiredRouteIds` 及本次已删符号的 re-export。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd plugins/dsh-crwu-workbench && npm run typecheck && node --test tests/unit/host/host-valuation-handoff.test.mjs tests/unit/host/host-audit-prompt.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "fix(workbench): derive knowledge readiness from manifest, drop dead route exports"
```

---

### Task 8: schema 去 `stage`

**Files:**
- Modify: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/schemas/knowledge-source.schema.json`（`stage` 从 `required` 与 `properties` 移除）
- Test: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/scripts/test_valuation_contracts.py`

**Interfaces:**
- Consumes: Task 4 的 `KnowledgeManifest`
- Produces: `knowledge-source.schema.json` 不再要求 `stage`；`routeId` 语义更新为「manifest 键位推导的逻辑槽位」

- [ ] **Step 1: 写失败测试**

在 `scripts/test_valuation_contracts.py` 加：

- 缺 `stage` 字段的知识来源文档**通过**校验
- `routeId` 取 `method.market.guide` 通过
- 现存的 `stage` 字段若存在也不报错（兼容旧快照）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate && python3 -m pytest scripts/test_valuation_contracts.py -k knowledge_source -v`
Expected: FAIL（缺 `stage` 时校验不过）

> 若该仓未装 pytest，用 `python3 scripts/test_valuation_contracts.py` 按其既有入口运行。

- [ ] **Step 3: 实现**

改 schema：`required` 去掉 `"stage"`，`properties` 去掉 `stage` 定义，`routeId` 的 `description` 更新为「manifest 键位推导的逻辑槽位（`method-selection` / `method.<m>.guide` / `method.<m>.template`）」。

同步更新 `toKnowledgeSourceDocument`（`snapshot.ts`）不再写 `stage`。

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2，Expected: PASS

- [ ] **Step 5: 提交**（需用户授权）

```bash
git commit -am "refactor(workbench): drop knowledge stage from source snapshot schema"
```

---

### Task 9: 技能瘦身 —— 删业务正文、重写路由合同、修引用

**Files:**
- Delete: `plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate/references/01-realestate-valuation.md`
- Delete: 同目录 `02-market-method.md`
- Delete: 同目录 `03-income-method.md`
- Delete: 同目录 `04-case-selection.md`
- Delete: 同目录 `05-parameter-mapping.md`
- Delete: 同目录 `07-cost-method.md`
- Rewrite: 同目录 `knowledge-routing.md`
- Modify: 同目录 `../SKILL.md`（150 行等）
- Modify: 同目录 `workflow.md`（39、60 行）
- Modify: `scripts/market_rules.py`、`scripts/validate_result.py`、`scripts/test_market_rules.py`、`scripts/test_valuation_contracts.py`、`examples/valuation-result.sample.json`

**Interfaces:**
- Consumes: Task 1 manifest 结构、Task 4 的 routeId 集合
- Produces: `knowledge-routing.md` 重写为「manifest 契约 + 案例获取链」

- [ ] **Step 1: 写失败测试**

`scripts/test_market_rules.py:125` 现在从 `references/02-market-method.md` 读阈值做校验。改为断言**阈值不出现在技能目录内任何文件里**：

```python
def test_no_business_thresholds_in_skill_tree():
    """业务阈值只能来自知识快照；技能目录里不得内置。"""
```

同时加一条源仓契约测试：断言 `references/` 下不再存在这 6 个文件。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate && python3 scripts/test_market_rules.py`
Expected: FAIL

- [ ] **Step 3: 删除 6 份正文，重写 `knowledge-routing.md`**

新 `knowledge-routing.md` 只写**技术合同**，不含业务规则：

1. manifest 的位置与两条路径基准
2. 键位 → routeId 的推导规则（与 Task 1 的表逐字一致）
3. 两种可解析形态（JSON 围栏 / Markdown 清单表），以及解析失败时的 capability-gap 文案
4. 案例获取链：列表抓取 → 按方法限制粗筛 → 记候选 → 与方法对比精筛 → 保留最接近 → 详情页 → 落盘；**筛选判据来自方法正文**
5. 缺失处置表（照 spec 4.6 逐条）

- [ ] **Step 4: 修全部引用处**

| 文件 | 处置 |
| --- | --- |
| `SKILL.md:150` | `references/02-market-method.md` 第 9 节 → 「wiki 方法正文对应节」 |
| `workflow.md:39` | 删对 `04-case-selection.md` §1.2 的引用，改为自查「方法正文声明的能力 ID」 |
| `workflow.md:60` | 删对 `05-parameter-mapping.md` 的引用 |
| `market_rules.py` 4/12/23/133 行 | 阈值出处改述为「本轮知识快照的方法正文」 |
| `validate_result.py:72,481` | 同上 |
| `test_valuation_contracts.py:613` | 改述依据 |
| `examples/valuation-result.sample.json:9` | 改述依据 |

`references/06-workbook-contract.md`、`09-output-contract.md`、`execution-and-land-extension.md` 的引用**保持不动**。

- [ ] **Step 5: 运行测试与自包含校验**

Run（逐层跑，不接受把整个 `skills/` 当一层）：

```bash
cd plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate
python3 scripts/test_market_rules.py && python3 scripts/test_valuation_contracts.py && python3 scripts/test_report_data.py
cd /Users/mungdong/code/github/mungdong/crwu-ai && make plugin-check
```
Expected: PASS

- [ ] **Step 6: 提交**（需用户授权）

```bash
git add -A plugins/dsh-crwu-workbench/skills/biz/crwu-biz-valuation-realestate
git commit -m "refactor(workbench): drop copied business text and route contract from valuation skill"
```

---

### Task 10: 版本、CHANGELOG、打包断言

**Files:**
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`
- Modify: `plugins/dsh-crwu-workbench/VERSION`、`package.json`（经 `npm run version:set`）
- Modify: `plugins/dsh-crwu-workbench/README.md`、`README.en.md`（若提及知识路由口径）

> **已核实无需改动**：`scripts/assert-pack.mjs` 只登记了 `knowledge-routing.md`、`workflow.md`、`execution-and-land-extension.md` 三份 references，本次要删的 6 份**不在**打包清单里；本次也不向技能新增文件（manifest 住在知识库，不在包里）。`package.json` 的 `files` 已含 `skills/biz/`，同样不动。若 Step 1 的闸门在此处报错，再回来处理。

- [ ] **Step 1: 全量闸门**

```bash
cd plugins/dsh-crwu-workbench && npm run check
cd /Users/mungdong/code/github/mungdong/crwu-ai && make plugin-check && make docs-check && git diff --check
```
Expected: 全部 PASS。任何一项失败先修，不带病进版本号。

- [ ] **Step 2: 升版本并写 CHANGELOG**

`npm run version:set <next>`（当前 `0.0.44`，取下一个 patch）。

CHANGELOG 用中文，说明**破坏性口径变化**：知识路由改由知识库侧 manifest 声明；删除技能内 6 份业务正文副本；`materialize` 工具去掉 `stage`/`method` 参数；「缺必需知识即停」取消（唯一真停改为 manifest 读不到）。

- [ ] **Step 3: 确认无残留引用**

```bash
cd /Users/mungdong/code/github/mungdong/crwu-ai
grep -rn "requiredRouteIds\|VALUATION_KNOWLEDGE_ROUTES\|routesForStage\|realestate.common" \
  plugins/dsh-crwu-workbench/src plugins/dsh-crwu-workbench/skills/biz plugins/dsh-crwu-workbench/tests
```
Expected: 无输出

- [ ] **Step 4: 提交**（需用户授权）

```bash
git add -A plugins/dsh-crwu-workbench
git commit -m "chore(workbench): release valuation manifest routing"
```

---

## 交付验收

- `01 房地产估值通用` 为空时估值**照常完成**（本改造的回归锚点，Task 4 Step 1）
- 技能 `references/` 下不再有 6 份业务正文；阈值只出现在知识快照里
- 知识库侧改 manifest 的路由**无需发版**即可生效
- `npm run check` + `make plugin-check` + `make docs-check` + `git diff --check` 全绿
