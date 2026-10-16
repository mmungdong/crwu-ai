# 链家取数链路缺陷修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录门禁真的能判出「未登录」，让站点清单故障以自己的名义失败，把同页重试上限降到 2，并把列表页**已经解析出**的「房屋朝向」接进案例契约。

**Architecture:** 四处独立改动，都落在既有取数链路里：一条部署配置（`browser-sites.json`）、一个取数工具的入口检查（`market-search.ts`）、一个常量及其全部文案（`retry.ts` 等）、一条字段通路（`site-parsers` → `normalize` → `ValuationCase` → `SearchCase`）。**不新增模块、不改协议号、不动截图与挑战恢复。**

**Tech Stack:** TypeScript（Node 24 原生 TS 加载）、Node 内置 `node --test`、Cordis 插件框架。

**Spec:** `docs/superpowers/specs/2026-10-15-lianjia-case-retrieval-optimization-design.md`

本计划只实现其中的 **批次 A（A1/A2/A3）** 与 **批次 B-1（`orientation` 接出）**。
**B-2（详情页解析器 + 详情阶段执行者）不在本计划内** —— 写计划前的范围检查发现 `stage: 'detail'` 只有任务生成、**没有任何执行者**，那是一块新能力，需另立 spec 与计划。

## Global Constraints

- `src/` 是唯一实现源。**不得**直接编辑 `lib/`、tarball、暂存二进制或同步过的 `common/skills/`。
- 每处行为改动**先写失败测试**，并证明它因**预期原因**失败（不是语法错误、不是别的断言）。
- 用户可见文案一律**简体中文**；代码注释用**英文**，只标「为什么这么做」。
- **不新增依赖**；不新增浏览器框架或 DOM 运行时。
- 测试**不得**访问真实 H3Yun / OSS / 凭据 / 员工文件 / 生产 profile，也**不得**联网。
- 站点 URL 与 DOM 选择器只由 Host 决定：模型提交不了命令、路径、选择器。
- 字段取不到时：多值文本用**空串**，数值用 `null`，**绝不填 0**。
- **不提交、不推送、不打标签**（用户未授权）。每个任务以「窄测试 + 全量门禁通过」收尾，不写提交步骤。
- 测试命令：窄跑 `node --test tests/unit/host/<文件>.test.mjs`；全量 `npm test`。

## Review Focus

1. **判据页与预检页不得是同一个 URL。** `probeUrl` 按定义是「公开、免登录」的页；`protectedUrl` 按定义是「要求会话」的页。两者相等时，`status --verify-page` 在任何未登录状态下都会说 `authenticated` —— 门禁变成一句空话。这是 A1 的全部理由。
2. **清单故障必须保留自己的身份。** `createValuationBrowserRuntime` 在 `loadBrowserSites` 失败时**仍然返回 runtime**，失败信息只在 `sitesError` 里。取数若忽略它，员工看到的是一条来自 CLI 的参数错误，而真正的原因是「站点清单不存在/畸形」。
3. **重试上限是风控参数，不是性能参数。** 「再多试几次」会把员工 IP 送进黑名单（`retry.ts` 自己的注释就这么写）。改这个数字要连**文案与数请求次数的测试**一起改，否则报告会写着一个代码里已经不成立的次数。
4. **`orientation` 从产出到契约不能断在中间。** `site-parsers.ts` 已经产出它，`normalize.ts` 的别名表没有它 → 产出即丢弃。补的是别名与契约字段，**不是**新写解析逻辑。
5. **取不到的字段不能变成「有值」。** 朝向拿不到时空串，且**不得**用 `unknown` / `未知` 之类的字符串顶上 —— 那会被下游当成一个真实取值参与打分。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json` | 改 1 行 | 部署用的站点清单；`protectedUrl` 是登录门禁的判据页 |
| `src/host/tools/report-evaluation/market-search.ts` | 改 2 处 | 取数工具；入口检查清单故障（A2）+ `SearchCase` 与 `caseToJson`（B-1） |
| `src/host/domains/report-evaluation/browser/retry.ts` | 改常量 + 注释 | 同页尝试上限的唯一来源 |
| `src/host/domains/report-evaluation/browser/login-state.ts` | 改注释 | 缺口文案里「三次」的出处说明 |
| `src/host/domains/report-evaluation/browser/providers.ts` | 改注释 | 重试语义的注释 |
| `src/host/domains/report-evaluation/market/normalize.ts` | 改别名表 + 契约 | 字段标准化；`ValuationCase` 契约 |
| `tests/unit/host/host-valuation-site-parsers.test.mjs` | 加测试 | 部署清单的不变量 |
| `tests/unit/host/host-valuation-market-tool.test.mjs` | 加测试 + 改断言 | 工具入口行为与文案 |
| `tests/unit/host/host-valuation-market.test.mjs` | 改断言 + 加测试 | 常量值与字段标准化 |

---

## Task 1: A1 — 判据页必须与预检页不同

**Files:**
- Modify: `skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json`
- Test: `tests/unit/host/host-valuation-site-parsers.test.mjs`

**背景（实测，2026-10-15）：** 部署清单里链家的 `protectedUrl` 与 `providers.ts:69` 里链家的 `probeUrl` **是同一个 URL**（`https://bj.lianjia.com/ershoufang/`）。该页未登录时公开返回 200、30 个 `data-price`，因此权威判定永远通过。实测 `https://bj.lianjia.com/ershoufang/chaoyang/` 未登录时 302 到 `clogin.lianjia.com`，是真门禁。

- [ ] **Step 1: 写失败测试**

该文件顶部已有 `const { PROVIDER_SITES, expandTemplate, siteOf } = await import(...providers.ts...)`，但**没有**读文件的能力。在顶部 import 区加一行：

```js
import { readFile } from 'node:fs/promises'
```

然后在文件末尾追加：

```js
test('部署清单的 protectedUrl 必须是要求会话的页，不能与公开预检页相同', async () => {
  const raw = await readFile(
    new URL('skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json', ROOT), 'utf8',
  )
  const sites = JSON.parse(raw)
  assert.ok(Array.isArray(sites) && sites.length > 0, '站点清单不能为空')
  for (const site of sites) {
    const provider = PROVIDER_SITES.find((item) => item.id === site.id)
    assert.ok(provider, `清单里的来源 ${site.id} 在 providers.ts 中没有定义`)
    // probeUrl 按定义是"公开、免登录也能打开"的页；protectedUrl 按定义是"要求会话"的页。
    // 两者相等 → status --verify-page 在未登录时也会说 authenticated，门禁形同虚设。
    assert.notEqual(
      site.protectedUrl,
      provider.probeUrl,
      `${site.id} 的 protectedUrl 与公开预检页相同，登录门禁无法判出未登录`,
    )
  }
  const lianjia = sites.find((item) => item.id === 'lianjia')
  assert.equal(lianjia.protectedUrl, 'https://bj.lianjia.com/ershoufang/chaoyang/')
})
```

- [ ] **Step 2: 跑测试，确认它因预期原因失败**

```bash
node --test tests/unit/host/host-valuation-site-parsers.test.mjs
```

期望：**失败**，失败信息是 `lianjia 的 protectedUrl 与公开预检页相同，登录门禁无法判出未登录`。
若失败信息是 `readFile is not defined` 之类，先修好 import 再继续 —— 那不是本任务要抓的失败。

- [ ] **Step 3: 改部署清单**

`skills/biz/crwu-biz-valuation-realestate/assets/browser-sites.json`，只改链家条目的 `protectedUrl`：

```json
"protectedUrl": "https://bj.lianjia.com/ershoufang/chaoyang/",
```

`probeUrl`（在 `providers.ts` 里）**不要动** —— 预检页要回答的正是「公开检索放不放行」，本来就该用公开页。

- [ ] **Step 4: 跑测试，确认通过**

```bash
node --test tests/unit/host/host-valuation-site-parsers.test.mjs
```

期望：PASS。

- [ ] **Step 5: 跑相关门禁**

```bash
node --test tests/unit/host/host-valuation-browser-client.test.mjs
```

期望：PASS（该文件也读部署清单，可能对 `protectedUrl` 有形状假设；若它失败，按它断言的真实意图调整，**不要**为了让它过而回退 Step 3）。

---

## Task 2: A2 — 站点清单故障必须以自己的名义失败

**Files:**
- Modify: `src/host/tools/report-evaluation/market-search.ts`
- Test: `tests/unit/host/host-valuation-market-tool.test.mjs`

**背景：** `browser/runtime.ts` 的 `createValuationBrowserRuntime` 在 `loadBrowserSites` 失败时**仍然返回 runtime**，失败信息只在 `runtime.sitesError`。而 `market-search.ts` 只读 `runtime.toolClient`（`:317`）与 `runtime.coordinator`（`:318`），**从不读 `sitesError`** → 清单缺失/畸形时，员工看到的是一条 `crwu browser --sites <坏路径>` 的参数错误。

- [ ] **Step 1: 扩测试桩**

该文件的 `makeDeps({ ctx, scopes, lifecycles } = {})`（`:134`）**不接受** `browserRuntime`，它的 `deps` 对象里也没有这个键。先扩签名：

```js
function makeDeps({ ctx = makeCtx(), scopes = new ValuationScopes(), lifecycles = new ValuationLifecycles(), browserRuntime } = {}) {
```

并在返回的 `deps` 对象里（`world: {...}` 之后）加：

```js
      ...(browserRuntime === undefined ? {} : { browserRuntime }),
```

- [ ] **Step 2: 写失败测试**

在文件末尾追加。**第二个参数必须显式传 `undefined`** —— 该文件的调用形状是
`valuationMarketSearchTools(deps, transport)[0].execute(args, execOf(...))`，而 `pickTransport` 的优先级是
「测试注入 > 浏览器 runtime」，传了 transport 就永远走不到 `browserRuntime` 分支：

```js
test('站点清单加载失败时，取数以清单问题失败，且不发起任何取数', async () => {
  const runtime = {
    toolClient: {}, coordinator: {}, sites: [],
    sitesPath: '/nonexistent/browser-sites.json',
    sitesError: '站点清单不存在：/nonexistent/browser-sites.json',
  }
  const { deps } = makeDeps({ browserRuntime: runtime })
  const sessionId = openValuation(deps)
  const result = await valuationMarketSearchTools(deps, undefined)[0]
    .execute({ caseDir: CASE_DIR, planId: PLAN_ID, keyword: '力鸿花园', city: 'beijing' }, execOf(sessionId, VALUATION_TOOL_NAMES.marketSearch))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /站点清单加载失败/)
  assert.match(result.error, /站点清单不存在/, '必须带上清单自己的原因，而不是一句笼统的失败')
  assert.equal(result.cases.length, 0, '清单坏掉时不得产出任何案例')
  assert.equal(result.retrievalTasks.length, 0, '清单坏掉时不得生成取数任务')
})
```

- [ ] **Step 3: 跑测试，确认它因预期原因失败**

```bash
node --test tests/unit/host/host-valuation-market-tool.test.mjs
```

期望：**失败**，且是 `result.ok` 仍为 `true`（或 `result.error` 里没有「站点清单加载失败」），**不是** `openValuation is not defined` 之类的桩错误。

- [ ] **Step 4: 在 `pickTransport` 之前加清单检查**

`src/host/tools/report-evaluation/market-search.ts`，在 `pickTransport` 的定义**之前**（现有注释块 `/** 抓取通道（**按来源 × 页面任务**建，不是全局一条）。... */` 之后、`const pickTransport = ...` 之前）插入：

```ts
  /**
   * 站点清单坏掉时**以清单问题失败**，不退回直连 fetch。
   *
   * `createValuationBrowserRuntime` 在 `loadBrowserSites` 失败时仍然返回 runtime，
   * 失败信息只在 `sitesError` 里。若这里不看它，取数会拿着一个不存在的 `--sites` 路径去调
   * `crwu browser`，员工看到的是一条 CLI 参数错误 —— 而真正的原因是站点清单没有加载成功。
   *
   * 也**不**退回 `fetchTransport`：那条通道自报 UA 且没有浏览器身份，链家会直接判成非浏览器
   * 流量；用它"兜底"只会制造一个更难解释的失败。
   */
  const sitesFailure = (): ToolFailure | null => {
    const error = text(deps.browserRuntime?.sitesError)
    if (error === '') return null
    return failure('capability-gap', `站点清单加载失败：${error}`)
  }
```

然后在该工具 `search` 的处理函数**最开始**（`caseDir` 校验之后、任何取数动作之前）插入：

```ts
      const blocked = sitesFailure()
      if (blocked !== null) return { ...idleResult(), ...blocked, caseDir }
```

`failure` 已在该文件可用（`src/host/tools/common/outcome.ts`，签名 `failure(errorKind, error)`，内部截断到 600 字符）；`text` 也已可用。**`ToolFailure` 与 `idleResult` 若未 import，按文件里既有的方式补上。**

- [ ] **Step 5: 跑测试，确认通过**

```bash
node --test tests/unit/host/host-valuation-market-tool.test.mjs
```

期望：PASS。

- [ ] **Step 6: 确认没有误伤既有行为**

```bash
node --test tests/unit/host/host-valuation-market.test.mjs tests/unit/host/host-valuation-site-parsers.test.mjs
```

期望：PASS。既有的「没有 browserRuntime 时退回 fetchTransport」用例必须仍然通过 —— 本任务只拦 `sitesError` 非空，**不**改变 `runtime === undefined` 的语义。

---

## Task 3: A3 — 同页重试上限降为 2

**Files:**
- Modify: `src/host/domains/report-evaluation/browser/retry.ts`
- Modify: `src/host/tools/report-evaluation/market-search.ts`（4 处注释/文案）
- Modify: `src/host/domains/report-evaluation/browser/login-state.ts`（2 处注释）
- Modify: `src/host/domains/report-evaluation/browser/providers.ts`（1 处注释）
- Test: `tests/unit/host/host-valuation-market.test.mjs`、`tests/unit/host/host-valuation-market-tool.test.mjs`

**背景：** 抓成功那一轮靠「慢 + 每 URL 只导航一次」活下来（复盘 §6 M15）；`MARKET_ATTEMPTS = 3` 叠加挑战自动恢复会**增加**同页访问次数。用户裁决：降为 **2**。

`retry.ts` 的注释明确要求「改这个数字要连 README / 结果契约一起改」，所以本任务包含全部文案与**数请求次数**的测试。

- [ ] **Step 1: 改既有断言与用例名（6 处）**

`tests/unit/host/host-valuation-market.test.mjs:51`：

```js
  assert.equal(MARKET_ATTEMPTS, 3)
```
→
```js
  assert.equal(MARKET_ATTEMPTS, 2)
```

同文件 `:89` 有一处显式 `attempts: 3` 的调用 —— 那是**显式传值**。读该用例的意图：若断言的是「覆盖被夹到常量上限」，改成 2；若断言的是「显式值被尊重」，**保持不变**，并在该用例上留一行注释说明为何不是 2。

`tests/unit/host/host-valuation-market-tool.test.mjs` 有四处在数请求次数，会连带变化：

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `:404` 用例名 | `检索：每个分页**恰好**三次尝试（数调用次数），三次全败且登录未确认 → 暂停等人，但不算"要登录"` | 「恰好**两次**尝试」「**两次**全败」 |
| `:418` 注释 | `// 三家来源 ×（1 次预检 + 1 页 × 3 次尝试）= 12 次，一次不多。` | `// 三家来源 ×（1 次预检 + 1 页 × 2 次尝试）= 9 次，一次不多。` |
| `:419` 断言 | `assert.equal(calls.length, 12, ...)` | `assert.equal(calls.length, 9, ...)` |
| `:728-729` | `assert.equal(calls, 3, '恰好三次')` + `assert.match(result.error, /已尝试 3 次/)` | `assert.equal(calls, 2, '恰好两次')` + `assert.match(result.error, /已尝试 2 次/)` |

同一文件 `:557`：

```js
  assert.match(result.capabilityGaps.join('；'), /最多 3 次尝试/)
```
→
```js
  assert.match(result.capabilityGaps.join('；'), /最多 2 次尝试/)
```

改完先 `grep` 一遍，确认该文件里没有残留的 3 次口径：

```bash
grep -n "三次\|3 次\|, 12\|, 3," tests/unit/host/host-valuation-market-tool.test.mjs
```

期望：只剩与本任务无关的命中（例如状态夹具里的 `attempts: 3`）。

- [ ] **Step 2: 跑测试，确认它们因预期原因失败**

```bash
node --test tests/unit/host/host-valuation-market.test.mjs tests/unit/host/host-valuation-market-tool.test.mjs
```

期望：**失败**，且失败信息分别是 `2 !== 3`、`/最多 2 次尝试/` 不匹配、`9 !== 12`。

- [ ] **Step 3: 改常量**

`src/host/domains/report-evaluation/browser/retry.ts:14`：

```ts
export const MARKET_ATTEMPTS = 3
```
→
```ts
export const MARKET_ATTEMPTS = 2
```

- [ ] **Step 4: 改全部文案（9 处，逐处核对）**

| 文件 | 位置 | 现状 → 改为 |
| --- | --- | --- |
| `browser/retry.ts` | `:2` 文件头 | 「每个分页 URL 最多尝试三次」→「两次」 |
| `market-search.ts` | `:36` | 「（3）次」→「（2）次」 |
| `market-search.ts` | `:37` | 「三次都失败时」→「两次都失败时」 |
| `market-search.ts` | `:141` | 「三次尝试后仍未取到」→「两次尝试后仍未取到」 |
| `market-search.ts` | `:340` | 工具描述里的「三次都失败」→「两次都失败」（该句已插值 `${MARKET_ATTEMPTS}`，核对插值后是 2） |
| `market-search.ts` | `:724` | 「第一个三次都没取到的分页」→「第一个两次都没取到的分页」 |
| `browser/login-state.ts` | `:9` | 「某个来源三次都失败」→「两次」 |
| `browser/login-state.ts` | `:77` | 「让"三次"这件事可核对」→「让"两次"这件事可核对」 |
| `browser/providers.ts` | `:154` | 「按"三次尝试"重试」→「按"两次尝试"重试」 |

`browser/login-state.ts` 的 `attemptLimit` 是**字段**（写进缺口文案）。核对它的赋值处确实读
`MARKET_ATTEMPTS`，而不是另写一个字面量 3。

- [ ] **Step 5: 跑测试**

```bash
node --test tests/unit/host/host-valuation-market.test.mjs tests/unit/host/host-valuation-market-tool.test.mjs tests/unit/host/host-valuation-lifecycle.test.mjs tests/unit/host/host-valuation-capture.test.mjs
```

期望：PASS。`host-valuation-lifecycle.test.mjs:187` 的 `attempts: 3` 是**状态夹具**（模拟「已经试过 3 次」的历史状态），与常量无关，**不要**改它；若它因此失败，说明它其实读了常量，那就按真实意图调整并在用例里注明。

- [ ] **Step 6: 全仓搜一遍，确认没有漏网的「三次」**

```bash
grep -rn "三次" src/ | grep -v "第三次故障\|第三次就是"
```

期望：**无输出**（白名单里那两条是无关的真机故障叙述，不是重试次数）。

---

## Task 4: B-1 — 把 `orientation` 接进案例契约

**Files:**
- Modify: `src/host/domains/report-evaluation/market/normalize.ts`（别名表 + `ValuationCase`）
- Modify: `src/host/tools/report-evaluation/market-search.ts`（`SearchCase` + `caseToJson`）
- Test: `tests/unit/host/host-valuation-market.test.mjs`

**背景：** `market/site-parsers.ts:183` 已经产出 `fields.orientation`（形如 `南 西南 西`），但 `normalize.ts` 的别名表 `ALIASES`（`:85`）里没有它 → 产出即丢弃。本任务只补**通路**，不新写解析逻辑。

**同时注意（影响 B-2 的 spec，不影响本任务）：** `ALIASES` 里已有
`purpose: ['purpose', 'usage', '用途', '房屋用途', '物业类型']` —— **「房屋用途」已经经 `purpose` 进契约了**。
所以 spec 里拟新增的 `usage` 字段是**多余**的，B-2 写 spec 时应删掉它，改为复用 `purpose`。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/host/host-valuation-market.test.mjs` 追加。该文件已 import `normalizeCase`；
`caseToJson` 若未在该文件的 import 列表里，按 `market-search.ts:212` 的导出从 `market-search.ts` 导入：

```js
test('房屋朝向从列表页字段进入案例契约，拿不到时是空串', () => {
  const listing = {
    source: 'lianjia',
    url: 'https://bj.lianjia.com/ershoufang/101131385498.html',
    title: '力鸿花园 2室1厅 南 西南 西',
    fields: { community: '力鸿花园', area: '197.42', orientation: '南 西南 西' },
  }
  const item = normalizeCase(listing)
  assert.equal(item.orientation, '南 西南 西')
  assert.equal(caseToJson(item).orientation, '南 西南 西')

  // 拿不到时必须是空串：不得用 "unknown" / "未知" 之类顶上 —— 那会被下游当成真实取值参与打分。
  const bare = normalizeCase({ ...listing, fields: { community: '力鸿花园' } })
  assert.equal(bare.orientation, '')
  assert.equal(caseToJson(bare).orientation, '')
})
```

- [ ] **Step 2: 跑测试，确认它因预期原因失败**

```bash
node --test tests/unit/host/host-valuation-market.test.mjs
```

期望：**失败**，且是 `item.orientation` 为 `undefined`（不是 `caseToJson is not a function`）。

- [ ] **Step 3: 扩 `ValuationCase` 与别名表**

`src/host/domains/report-evaluation/market/normalize.ts`：

在 `export interface ValuationCase` 里，`buildingArea: number | null` 那一行**之后**、`floor: string` 之前插入：

```ts
  /**
   * 房屋朝向（站点原文，例如 `南 西南 西`）。
   *
   * 多方向是常态，所以按原文整串保留、不在这一层拆分或排序 —— 拆分口径属于打分规则，
   * 不属于字段标准化。
   */
  orientation: string
```

在 `ALIASES: Record<string, string[]>`（`:85`）里，按该表既有的写法增加一条：

```ts
  orientation: ['orientation', '朝向', '房屋朝向'],
```

在 `normalizeCase`（`:202`）返回的对象里，按该函数对其它字符串字段的**同一写法**加一行
（`decoration` 用的就是这个表达式，取不到时空串）：

```ts
    orientation: pickField(fields, 'orientation'),
```

**同时检查** `knownFieldAliases`（该表被 `host-valuation-market.test.mjs` 导入）—— 若它是从 `ALIASES`
派生的，无需改动；若是手写清单，补上 `orientation`。

- [ ] **Step 4: 扩取数输出契约**

`src/host/tools/report-evaluation/market-search.ts`：

`interface SearchCase`（`:79`）里，在 `decoration: string` 之后加：

```ts
  orientation: string
```

`caseToJson`（`:212`）里，在 `decoration: item.decoration,` 之后加：

```ts
    orientation: item.orientation,
```

命名：这个字段两边同名（`orientation` 本身没有下划线需求），**不要**写成 `house_orientation`。

- [ ] **Step 5: 跑测试，确认通过**

```bash
node --test tests/unit/host/host-valuation-market.test.mjs
```

期望：PASS。

- [ ] **Step 6: 确认解析层到契约这条链是通的**

```bash
node --test tests/unit/host/host-valuation-site-parsers.test.mjs tests/unit/host/host-valuation-capture.test.mjs
```

期望：PASS。若 `host-valuation-capture.test.mjs` 对 `ValuationCase` 做了整体深比较（对象全等），它会因为多了一个字段而失败 —— 那是**预期内**的契约扩张：把该断言改成按字段比较，并在用例里留一行说明。

---

## 收尾

- [ ] **全量门禁**

```bash
npm run typecheck
npm test
```

- [ ] **行尾空白检查**

```bash
git diff --check
```

- [ ] **核对最终 diff 只包含本计划列出的文件**

```bash
git status --porcelain
```

期望：只有「文件结构」表里的 9 个文件被改。**出现其它文件即停下核对**，不要把无关改动卷进来。

- [ ] **确认没有提交**

```bash
git log --oneline -1
```

期望：仍是本计划开始前的那一条（用户未授权提交）。
