# 钉钉设备流登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在环境信息 →① 账号连接 →「钉钉认证」那一行加一颗「设备流登录」按钮：点一下由 Host 后台起 `dws auth login --device`，面板秒级显示授权码与链接、自动尝试打开授权页面，授权成功后面板自动判定并刷新环境自检。

**Architecture:** Host 侧新增一个**按插件实例持有**的设备流会话注册表（`access.startShell` 起后台进程 + 500ms 增量读 + 5 分钟封顶 + 可取消 + 卸载收尾），暴露三条空入参操作；客户端把全部逻辑放在一个**框架无关的纯 store**（`createDeviceLoginStore`）与一个**纯视图函数**里，`.tsx` 只做渲染 —— 因为本仓的 React 替身只支持渲染、**不跑 effect、也不因 setState 重渲染**，带定时器的逻辑放进组件就等于没有测试。

**Tech Stack:** TypeScript / React 18（DSH 客户端插件）/ Cordis / Node 内建 `node:test`（无 vitest / jsdom）/ tsdown 打包。

**Spec:** [`plugins/dsh-crwu-workbench/docs/superpowers/specs/2026-10-13-dws-device-login-design.md`](../specs/2026-10-13-dws-device-login-design.md)

## Global Constraints

- **协议号**：`WORKBENCH_PROTOCOL` 31 → **32**（`src/shared/consts.ts`），并追加第 32 条理由注释。
- **操作条数**：`FROZEN_OPERATIONS` 42 → **45**（追加 `dws-login-device-start` / `-status` / `-cancel`），`FROZEN_OPERATION_COUNT` 由 `.length` 推导，但 `host-package.test.mjs` 里那条 `assert.equal(FROZEN_OPERATION_COUNT, 42)` 要改成 **45**。
- **包版本**：`dsh-crwu-workbench` **0.0.42**（`npm run version:set 0.0.42`，由 `sync-version.mjs` 同步 package.json / VERSION / Host 常量 / lockfile / changelog 契约）。
- **时序常量**：Host 轮询 **500ms**、Host 上限 **5 分钟**（300000ms）、客户端轮询 **1000ms**、`tail` 上限 **600** 字符。
- **URL 白名单**：`https:` 且 host 属于 `dingtalk.com` / `dingtalk.io`（含子域，按**后缀**匹配，不是 `includes`）。
- **三条新操作入参一律为空对象**：不接受 url / userCode / argv / 目录 / 超时。
- **`user_code` 与 `tail` 不落盘、不进 Host 日志、不进 `access-diagnostics`、不进对话与任何模型可见结果**。
- **不新增「打开任意 URL」的 Host 操作**；开页由客户端 `window.open` 完成。
- 用户可见文案一律**简体中文**；代码注释**英文或中文跟随该文件既有风格**，保持既有密度。
- **不要提交**。本仓规定：用户评审 + 真机验收之前不 commit。每条任务末尾的收尾步骤是 `git diff --check` + 记录改了哪些文件，**不是** `git commit`。
- 验证命令：窄测 `node --test tests/unit/<file>.mjs`；收尾 `npm run typecheck` 与 `npm test`；最终 `npm run check` + `git diff --check`。

## Review Focus

以下五类输入/条件，规格没有明说但用户一定会遇到。每条都必须在下面标出的任务里被测试钉住：

1. **dws 中途重发授权码**（码过期会自动重来一次）：面板必须显示**最新**的码与链接，而不是第一次那个 —— 旧码此刻已经失效，照着念一定失败。→ Task 2。
2. **「取消」与「进程已经自己结束」竞争**：取消必须幂等，不能把已经落定的 `ok` 覆写成 `failed`。→ Task 2。
3. **面板重挂时 `status` 回的是一个已经结束的会话**：必须显示终态（成功/失败），不是空按钮、也不是永远转圈。→ Task 5。
4. **dws 的 URL 后面紧跟中文标点或引号**（`…https://x.dingtalk.com/y。`）：解析出来的 URL 必须仍能打开。→ Task 1。
5. **`.dws` 锁被别的进程占着，`start` 立刻失败**（不是 5 分钟后）：面板要**立刻**给归因与下一步，而不是转圈到超时。→ Task 2。

---

### Task 1: 设备流输出解析器与 URL 白名单（纯函数）

**Files:**
- Create: `src/host/system/device-login.ts`
- Test: `tests/unit/host-device-login-parse.test.mjs`

**Interfaces:**
- Consumes: 无（本任务只写纯函数）。
- Produces:
  - `interface DwsDeviceAuthorization { url: string; userCode: string }`
  - `function parseDwsDeviceAuthorization(output: string): DwsDeviceAuthorization`
  - `function deviceUrlAllowed(url: string): boolean`
  - `const DEVICE_LOGIN_TAIL = 600`、`DEVICE_LOGIN_POLL_MS = 500`、`DEVICE_LOGIN_LIMIT_MS = 300_000`
  - 后续任务从 `../system/device-login.ts` 引入这些名字。

- [ ] **Step 1: 写失败测试**

文件头用 `import assert from 'node:assert/strict'` + `import test from 'node:test'`，然后
（`.ts` 在 Node 24 下直接可 import，**不需要** `registerTsxLoader`，参照 `tests/unit/host-login-failure.test.mjs` 的写法）：

```js
const ROOT = new URL('../../', import.meta.url)
const { parseDwsDeviceAuthorization, deviceUrlAllowed } = await import(
  new URL('src/host/system/device-login.ts', ROOT).href)
```

用例与断言（名字照抄）：

```js
test('解析出短 URL 与连字符大写授权码，并去掉紧跟的标点', () => {
  const out = '请在浏览器中打开以下链接，并输入授权码：\nhttps://s.dingtalk.com/abc。\n  ABCD-EFGH  '
  assert.deepEqual(parseDwsDeviceAuthorization(out), { url: 'https://s.dingtalk.com/abc', userCode: 'ABCD-EFGH' })
})

test('认「授权码: xxxx」这种标签写法（码没有连字符）', () => {
  const out = 'please open https://s.dingtalk.com/xyz and enter user code: 9F2K7QW1'
  assert.deepEqual(parseDwsDeviceAuthorization(out), { url: 'https://s.dingtalk.com/xyz', userCode: '9F2K7QW1' })
})

test('解析不出来不抛错，回两个空串（tail 永远兜底）', () => {
  assert.deepEqual(parseDwsDeviceAuthorization('请求设备授权码...'), { url: '', userCode: '' })
})

test('白名单只认 https 的钉钉域及其子域，且不认后缀伪装', () => {
  assert.equal(deviceUrlAllowed('https://s.dingtalk.com/abc'), true)
  assert.equal(deviceUrlAllowed('https://login.dingtalk.io/x'), true)
  assert.equal(deviceUrlAllowed('http://s.dingtalk.com/abc'), false)          // 非 https
  assert.equal(deviceUrlAllowed('https://dingtalk.com.evil.tld/x'), false)    // 后缀伪装
  assert.equal(deviceUrlAllowed('https://evil.tld/dingtalk.com'), false)
  assert.equal(deviceUrlAllowed('not a url'), false)
})

test('解析器只回白名单内的 URL（域外链接当没解析出来）', () => {
  assert.deepEqual(parseDwsDeviceAuthorization('open https://evil.tld/a now'), { url: '', userCode: '' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host-device-login-parse.test.mjs`
Expected: FAIL —— `Cannot find module .../src/host/system/device-login.ts`

- [ ] **Step 3: 实现 `src/host/system/device-login.ts`**

文件顶部写一段注释，说明**为什么解析是尽力而为**：dws 只保证人类可读输出（上游二进制，没有结构化契约），
所以解析失败不阻塞流程 —— `tail` 永远把原文交给员工。

- `parseDwsDeviceAuthorization(output)`：URL 取第一个 `https?://[^\s"'<>）)，。]+` 并去掉尾部 `[.,;:，。]+`，
  再过一次 `deviceUrlAllowed`，不合规就回空串；userCode 先试 `\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b`，
  再试 `/(?:authorization code|user code|授权码|用户码)[^\S\n]*[:：]?[^\S\n]*([A-Za-z0-9]{4,}(?:-[A-Za-z0-9]{4,})*)/iu`。
- `deviceUrlAllowed(url)`：`new URL(url)` 包在 try 里；要求 `protocol === 'https:'`；host 转小写后
  对 `['dingtalk.com', 'dingtalk.io']` 逐个判 `host === d || host.endsWith('.' + d)`。
  注释里写明**为什么必须后缀匹配**：`includes` 会放过 `dingtalk.com.evil.tld`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host-device-login-parse.test.mjs`
Expected: PASS（5 个用例）

- [ ] **Step 5: 收尾（不提交）**

Run: `npm run typecheck && git diff --check`
记录本任务新增了 `src/host/system/device-login.ts`、`tests/unit/host-device-login-parse.test.mjs`。

---

### Task 2: 设备流会话注册表（后台进程状态机）

**Files:**
- Modify: `src/host/system/device-login.ts`（追加）
- Modify: `src/shared/types.ts`（在 `DwsLocalDoctorView` 附近加 `DwsDeviceLoginView`）
- Test: `tests/unit/host-device-login-registry.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `parseDwsDeviceAuthorization` / `DEVICE_LOGIN_*` 常量；`loginFailureAdvice` / `describeLoginAdvice`（`./login-failure.ts`）；`resolveBundledCommand`（`../platform/command.ts`）；`shellInvoke`（`../platform/shell.ts`）；`LocalAccessBroker`（`../access/broker.ts`）。
- Produces:
  - `interface DeviceLoginDeps { ctx: Context; access: LocalAccessBroker; platform: string; workdir: () => Promise<string> }`
  - `interface DwsDeviceLoginRegistry { start(deps): Promise<DwsDeviceLoginView>; status(): DwsDeviceLoginView | null; cancel(): DwsDeviceLoginView; running(): boolean; dispose(): Promise<void> }`
  - `function createDwsDeviceLoginRegistry(options?: { pollMs?: number; limitMs?: number; now?: () => number }): DwsDeviceLoginRegistry`
  - 用到 Task 3 才接线、但本任务就要用到的 `DwsDeviceLoginView` —— **本任务先在 `src/shared/types.ts` 里加这个 interface**（Task 3 只加操作与协议号），避免两个任务互相等待。

- [ ] **Step 1: 写失败测试**

`tests/unit/host-device-login-registry.test.mjs`。必须自带一个**后台 shell 替身** —— 现有 `tests/helpers/`
里没有，`host-system-ops.test.mjs` 的 `makeCtx` 只实现了前台的 `result()`。替身的 `execute(spec)` 要回
`startShell`（`src/host/shell/run.ts:272-295`）真正会读的六个成员：

```js
// 后台 exec 句柄：readOutput 是**消耗式**的，两次读不会给同一段。
function backgroundExec() {
  let buffer = '', status = 'running', exitCode
  let resolveDone; const done = new Promise((r) => { resolveDone = r })
  return {
    push(text) { buffer += text },
    finish(code) { status = 'completed'; exitCode = code; resolveDone() },
    exec: {
      readOutput() { const delta = buffer; buffer = ''; return { delta, lossy: false } },
      kill() { if (status !== 'running') return false; status = 'killed'; resolveDone(); return true },
      done, get exitCode() { return exitCode }, get status() { return status }, sandbox: () => undefined,
    },
  }
}
```

`ctx` 替身参照 `host-system-ops.test.mjs` 的 `makeCtx`，但 `shell.execute(spec)` 回**上面那个句柄**
（并把 `spec.command` 记进 `commands`）；`access` 用 `makeTestAccess(ctx).access`（真 Broker + 授权收据）。

用例与断言：

```js
test('start 立刻回 running 快照，异步读到输出后带出 URL 与授权码', ...)
  // 断言：首帧 phase==='running' 且 url===''；push 输出并推进注入的 pollMs 定时器后，
  //       status() 的 url/userCode 等于 Task 1 解析出来的值。deadlineAt 是 5 分钟后的 ISO。

test('重复 start 不启第二个进程，只回当前快照', ...)
  // 断言：连点两次后 ctx.commands 长度仍是 1（两个 dws 会抢同一把 ~/.dws 锁）。

test('dws 重发授权码后，快照里是最新的码（旧码已失效）', ...)
  // push 第一批（code A）→ 推进 → 断言 userCode==='A'；
  // push 第二批（code B）→ 推进 → 断言 userCode==='B'。这条对应 Review Focus 1。

test('授权成功：done 之后 phase===\'ok\'，且 phase 落定后 status 仍回终态', ...)
  // finish(0) + 推进 → phase 'ok'、error ''。（Review Focus 3 的 Host 半边。）

test('进程立刻失败（.dws 锁被占）：phase 马上是 failed，并带沙箱归因', ...)
  // finish(2) 且 stderr 含 '.dws\.data.lock: Access is denied' → phase 'failed'、
  // sandboxBlocked===true、advice 非空。这条对应 Review Focus 5。

test('超时：到 limitMs 杀进程并落 timeout', ...)
  // 注入 limitMs: 50；断言 phase==='timeout'、进程被杀（handle.kill 被调用）。

test('cancel 幂等：已 ok 的会话再 cancel 不会把 ok 覆写成 failed', ...)
  // finish(0) + 推进 → ok；再 cancel() → 仍是 ok。这条对应 Review Focus 2。

test('dispose 杀掉仍在跑的进程并清掉定时器', ...)
  // 断言 dispose 后 status() 不再是 running，且 clearTimer 调用次数 >= 1。
  // （历史教训：不清定时器会让测试进程永远退不出来，所以这里必须显式断言。）

test('授权码与 dws 原文绝不进日志、也不进本机访问诊断', ...)
  // ctx 上加一个 logger 间谍（info/warn/error 各记一次调用参数）；
  // 跑完 start→读到码→ok 之后，断言三处都不含 userCode 与 URL 子串，
  // 且 access 的诊断视图（makeTestAccess 暴露的读法）里同样没有它们。spec §8 的硬要求。
```

> 定时器只用**一个** `setInterval`：到点判定改成在轮询里比对 `now() >= deadline`（超时就 kill 并落 timeout），
> **不要**再额外 `setTimeout` —— 少一个定时器就少一处"忘了清"的机会，也让测试的假定时器只需拦一个入口。
> 假定时器替换 `globalThis.setInterval` / `globalThis.clearInterval` 并手动 `tick()`；
> 实现必须走 `globalThis.setInterval`（不要从 `node:timers` 直接 import），否则替身拦不住。这一点写进实现注释。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host-device-login-registry.test.mjs`
Expected: FAIL —— `createDwsDeviceLoginRegistry is not a function`

- [ ] **Step 3: 实现 `createDwsDeviceLoginRegistry`**

要点（照 spec §5，逐条都要落实）：

- `start`：`running()` 时直接回当前快照，**不**起第二个进程。
- 起进程：`access.startShell({ operation: 'dws.auth.login', source: 'panel', workdir }, shellInvoke(resolveBundledCommand(ctx, platform, 'dws'), ['auth','login','--device'], platform), { summary: 'dws auth login --device' })`。
  失败（`started.ok === false`）→ 立刻落 `failed`，`error` 用既有归因文案。
- 定时器：**只用一个** `setInterval(pollMs)`：读增量 → 累积 → 重新解析 → **覆盖** `url` / `userCode`
  （永远取最新）→ 若 `now() >= deadline` 则标 `killedByDeadline` 并 `kill()` → `status() !== 'running'`
  时 `settle()`。不要额外的 `setTimeout`。
- `settle()`：**先清定时器再判状态**（历史缺陷：早退不清定时器会把 interval 永远留在事件循环里），
  清理幂等且不依赖 phase；只有 `phase === 'running'` 才落终态（这就是 cancel 幂等的实现方式）。
  终态判定顺序：`killedByDeadline` → `timeout`；`exitCode === 0` → `ok`；否则 `failed`
  （`advice.blocked` 时用 `describeLoginAdvice('dws', advice, tail)`，否则用 tail 原文，
  与 `dwsLogin` 的既有口径一致）。
- `deadlineAt = new Date(now() + limitMs).toISOString()`；`now` 默认 `Date.now`。
- `cancel()`：kill 句柄 + 走同一条 `settle()`；返回快照。
- `dispose()`：kill + 清定时器，并把会话置为可从 `status()` 读到的终态。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host-device-login-registry.test.mjs`
Expected: PASS（9 个用例）

- [ ] **Step 5: 反向验证两条最关键的断言真的会失败**

临时把实现改成「settle 先判状态再清定时器」和「解析结果只在为空时写入」，
Run: `node --test tests/unit/host-device-login-registry.test.mjs`
Expected: 分别有 1 条用例 FAIL（超时/dispose 那条、重发码那条）。改回来，再跑一次确认全绿。
**这一步不许跳过** —— 它证明这两条断言不是摆设。

- [ ] **Step 6: 收尾（不提交）**

Run: `npm run typecheck && git diff --check`

---

### Task 3: 契约接线（wire 类型已在 Task 2 加好，这里加操作/协议/门面）

**Files:**
- Modify: `src/shared/consts.ts`（`WORKBENCH_PROTOCOL` + 第 32 条注释）
- Modify: `src/host/ops/core.ts`（`HostResolvers.deviceLogin`、三条 handler、`ported.done` 清单注释）
- Modify: `src/host/apply.ts`（创建注册表 + `ctx.effect` 收尾 + 替换那条**过期的协议 21 注释**）
- Modify: `src/client/features/report-audit/api.ts`（三条门面方法 + `OPERATION_OF`）
- Modify: `tests/helpers/frozen-inventory.mjs`（追加 3 个名字 + 改写协议 22 的警告注释）
- Test: `tests/unit/host-package.test.mjs`、`tests/unit/client-rpc-facade.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `createDwsDeviceLoginRegistry` / `DwsDeviceLoginRegistry`；Task 2 加在 `src/shared/types.ts` 的 `DwsDeviceLoginView`。
- Produces: 三条操作名 `dws-login-device-start` / `dws-login-device-status` / `dws-login-device-cancel`；
  门面方法 `dwsLoginDeviceStart()` / `dwsLoginDeviceStatus()` / `dwsLoginDeviceCancel()`（都无参）。

- [ ] **Step 1: 先改既有断言，让它们失败**

- `tests/helpers/frozen-inventory.mjs`：在数组末尾追加
  `'dws-login-device-start', 'dws-login-device-status', 'dws-login-device-cancel'`，
  并把协议 22 那段警告改写成「协议 22 删掉；**协议 32（2026-10-13）把设备流登录以三条新操作恢复**，
  loopback 的 `dws-login` 语义未变」。
- `tests/unit/host-package.test.mjs`：`assert.equal(WORKBENCH_PROTOCOL, 31, ...)` → `32`；
  `assert.equal(FROZEN_OPERATION_COUNT, 42)` → `45`；协议注释块补一段协议 32 的理由
  （照既有格式：新增操作 = 跨进程契约变化，旧宿主没有它们，新界面点下去 404）。

Run: `node --test tests/unit/host-package.test.mjs`
Expected: FAIL（协议号与操作数量不一致）

- [ ] **Step 2: 加共享协议号与注释**

`src/shared/consts.ts`：`WORKBENCH_PROTOCOL = 32`，在协议 28 那段后面追加第 32 条，
写清三件事：新增三条操作；旧宿主 404 / 旧界面不会调；**明确记录这是对协议 22 的部分反转**，
loopback 的 `dws-login` 未改。

- [ ] **Step 3: Host 侧注册三条操作**

- `src/host/ops/core.ts` 的 `HostResolvers` 加 `deviceLogin?: DwsDeviceLoginRegistry`（与 `localAudit` 同样可选，测试可注入）。
- 在 handler 表里加：

```ts
'dws-login-device-start': async () => {
  const registry = resolvers.deviceLogin
  if (registry === undefined) return emptyDeviceLoginView('设备流登录不可用：宿主没有装配登录注册表')
  return await registry.start({ ctx, access: resolvers.access, platform: await world.platform(), workdir: () => world.workdir() })
},
'dws-login-device-status': async () => resolvers.deviceLogin?.status() ?? null,
'dws-login-device-cancel': async () => {
  const registry = resolvers.deviceLogin
  if (registry === undefined) return emptyDeviceLoginView('设备流登录不可用：宿主没有装配登录注册表')
  const view = registry.cancel()
  gate.invalidate()
  return view
},
```

  `start` 成功后同样调用 `gate.invalidate()`（与既有 `dws-login` 一致：登录态变了，环境结论作废）。
  `emptyDeviceLoginView(error)` 是同一文件里的小工厂：`phase: 'failed'` + `error`，其余字段空。
- `ported.done` 清单里把三个名字加在 `'dws-login'` 同行注释下。

- [ ] **Step 4: 在 `apply()` 里按插件实例持有**

`src/host/apply.ts`：把第 117-118 行那条**过期的**注释（「钉钉登录会话（协议 21）…」——
它下面根本没有对应的注册表，是协议 22 删除时留下的残骸）替换成：

```ts
// 钉钉设备流登录（协议 32）：握着后台 dws 进程与轮询定时器，必须按插件实例持有并在卸载时收尾 ——
// 残留就是「看不见的进程还占着 ~/.dws 的登录态锁」，员工下一次登录会莫名其妙失败。
const deviceLogin = createDwsDeviceLoginRegistry()
ctx.effect(() => () => { void deviceLogin.dispose() }, 'crwu-workbench: dws device login')
```

并把 `deviceLogin` 传进 `createCoreOperations(...)` 的 resolvers 对象。

- [ ] **Step 5: 客户端门面加三条方法**

`src/client/features/report-audit/api.ts`：`WorkbenchApi` 接口与实现各加三行
（`dwsLoginDeviceStart: () => call('dws-login-device-start')` 等，`call` 的 args 缺省 `{}`），
`OPERATION_OF` 同步加三行。`tests/unit/client-rpc-facade.test.mjs` 的样例参数表**不用改**
（它用 `args[method] ?? {}` 兜底），但跑一遍确认双向对账通过。

Run: `node --test tests/unit/host-package.test.mjs tests/unit/client-rpc-facade.test.mjs tests/unit/host-operations.test.mjs`
Expected: PASS

- [ ] **Step 6: 收尾（不提交）**

Run: `npm run typecheck && npm test && git diff --check`

---

### Task 4: 两个登录互斥（Host 拦截 + 客户端标志）

**Files:**
- Modify: `src/host/ops/core.ts`（`dws-login` handler 先判设备流）
- Modify: `tests/unit/host-system-ops.test.mjs`（改写那条「没有设备码分支」的用例 + 新增互斥用例）

**Interfaces:**
- Consumes: Task 2 的 `registry.running()`；Task 3 注册进 `resolvers.deviceLogin`。
- Produces: 无新类型；`dws-login` 在设备流 running 时回一条**不启进程**的失败结果。

- [ ] **Step 1: 改写既有用例并新增失败用例**

- `tests/unit/host-system-ops.test.mjs:236` 那条用例：**保留**「`dwsLogin` 不拼 `--device`」（loopback 语义未变），
  删掉注释里「插件不提供设备码登录」的理由句，改成「设备流走**独立的三条操作**，不是给 `dwsLogin` 加分支」。
- 新增：

```js
test('设备流正在跑时，dws-login 直接拒绝且一个进程都不起', async () => {
  const ctx = makeCtx({ shell: () => ({ stdout: '' }) })
  const stopped = { phase: 'running', url: '', userCode: '', tail: '', error: '', advice: '',
    sandboxBlocked: false, deadlineAt: '2026-10-13T00:05:00.000Z' }
  const deviceLogin = {
    running: () => true,
    start: async () => stopped, status: () => stopped, cancel: () => stopped, dispose: async () => {},
  }
  // 用 createCoreOperations 组装一份带 `deviceLogin` 的操作表（参照既有 `makeOps()` 之类写法），
  // 调 'dws-login'，断言：
  //   result.ok === false；/设备流登录正在进行/.test(result.error)；/取消/.test(result.error)；
  //   ctx.commands.length === 0   ← 这条是重点：拦住不算数，**没起进程**才算
})
```

  （断言 `ctx.commands.length === 0` 是这条用例的重点：拦住不算数，**没起进程**才算。）

Run: `node --test tests/unit/host-system-ops.test.mjs`
Expected: FAIL —— 新增用例失败（现在 `dws-login` 不判设备流）

- [ ] **Step 2: 实现拦截**

`dws-login` handler 在调用 `dwsLogin(...)` **之前**：

```ts
if (resolvers.deviceLogin?.running() === true) {
  return { ok: false, error: '设备流登录正在进行：请先在上面点「取消」，或等它结束再试（两次登录会抢 .dws 的同一把锁）', ... }
}
```

注释写清**为什么这比让 dws 自己报错好**：dws 会回 `Access is denied`，现有归因会把它读成
「权限不足」并让员工去切访问模式 —— 正是这个模块历史上踩过的坑。

- [ ] **Step 3: 跑测试确认通过**

Run: `node --test tests/unit/host-system-ops.test.mjs tests/unit/host-login-failure.test.mjs`
Expected: PASS（`host-login-failure` 那条「设备码登录不是绕过办法」**保留通过** —— 事实仍成立，
本任务不动 `login-failure.ts` 的文案；指向文案的更新在 Task 6 与环境页文案一起做）

- [ ] **Step 4: 收尾（不提交）**

Run: `npm run typecheck && git diff --check`

---

### Task 5: 客户端纯 store 与卡片视图函数

**Files:**
- Create: `src/client/features/environment/device-login.ts`
- Test: `tests/unit/client-dws-device-login.test.mjs`

**Interfaces:**
- Consumes: `DwsDeviceLoginView`（`src/shared/types.ts`）。
- Produces:
  - `interface DeviceLoginApi { dwsLoginDeviceStart(): Promise<DwsDeviceLoginView>; dwsLoginDeviceStatus(): Promise<DwsDeviceLoginView | null>; dwsLoginDeviceCancel(): Promise<DwsDeviceLoginView> }`
  - `interface DeviceLoginStore { get(): DwsDeviceLoginView | null; subscribe(listener: () => void): () => void; resume(): Promise<void>; start(): Promise<void>; cancel(): Promise<void>; dispose(): void }`
  - `function createDeviceLoginStore(options: { api: DeviceLoginApi; onSettled?: (view: DwsDeviceLoginView) => void; pollMs?: number }): DeviceLoginStore`
  - `function deviceLoginCardView(view: DwsDeviceLoginView | null, options: { now: number; busy: boolean }): DeviceLoginCardView`
  - `function formatRemaining(deadlineAt: string, now: number): string`（形如 `4:37`，过期回 `0:00`）
  - `interface DeviceLoginCardView { phase: 'idle' | 'running' | 'ok' | 'failed' | 'timeout'; statusText: string; code: string; link: string; detail: string; canStart: boolean; canCancel: boolean; canRetry: boolean; canOpen: boolean }`

- [ ] **Step 1: 写失败测试**

`tests/unit/client-dws-device-login.test.mjs`。**纯 `.ts`，不需要 tsx-loader、也不需要 fakeReact** ——
逻辑全部在 store 与视图函数里，这一步刻意不测 `.tsx`（本仓的 React 替身不跑 effect、不因 setState 重渲染）。

假定时器与假 api：

```js
function fakeTimers() {
  const jobs = []
  return {
    set: (fn) => { jobs.push(fn); return jobs.length - 1 },
    clear: () => {},          // 只记次数，见下
    tick: (times = 1) => { for (let i = 0; i < times; i++) for (const fn of [...jobs]) fn() },
  }
}
function view(patch = {}) {
  return { phase: 'running', url: '', userCode: '', tail: '', error: '', advice: '',
    sandboxBlocked: false, deadlineAt: '2026-10-13T00:05:00.000Z', ...patch }
}
```

用例与断言：

```js
test('resume 时 status 已是终态：直接显示终态，不进入轮询', ...)
  // api.status 回 { phase: 'ok' } → store.get().phase === 'ok'，且没有安排下一次轮询。Review Focus 3。

test('start 后进入轮询，直到终态；onSettled 只触发一次', ...)
  // api.start 回 running；tick 两次 → api.status 依次回 running / ok；
  // 断言 onSettled 调用次数 === 1 —— 终态可能被轮询与迟到响应同时看到，
  // 一次登录刷两次环境会让「重新检查」打两次（spec §5 的"一次性"要求）。

test('onSettled 对失败与超时同样只触发一次', ...)

test('cancel 之后不再轮询，且终态不被覆盖', ...)

test('dispose 停掉轮询（clearTimer 被调用）', ...)

test('deviceLoginCardView：running 时给码、给链接、可取消、不可重试', ...)
  // 断言 canCancel === true、canRetry === false、canOpen === (url !== '')、code/link 原样带出。

test('deviceLoginCardView：busy（loopback 在跑）时不可 start', ...)

test('formatRemaining 按 deadlineAt 倒计时，过期回 0:00', ...)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/client-dws-device-login.test.mjs`
Expected: FAIL —— `createDeviceLoginStore is not a function`

- [ ] **Step 3: 实现 `src/client/features/environment/device-login.ts`**

要点：

- `resume()`：调一次 `api.dwsLoginDeviceStatus()`；`null` 就不动；`running` 就继续轮询；终态就**不**轮询。
- `start()`：`busy` 由调用方（组件）保证；这里只负责调 `api.dwsLoginDeviceStart()` → 存快照 → 排轮询。
- 轮询用 `globalThis.setInterval` / `clearInterval`（默认值），**不要** `node:timers`；
  测试用假定时器替换 `globalThis` 上的这两个，实现才拦得住。
- `onSettled` **一次性**：每次进入终态最多触发一次，用标志位守住（历史缺陷：终态被轮询与 done 同时看到，
  一次登录刷两次环境）。
- `dispose()`：清定时器 + 停掉后续写入（`disposed` 标志），不调 api。
- 订阅：`subscribe(listener)` 在快照变化时通知，`get()` 回当前快照 —— 与 `module-store.ts` 同形。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/client-dws-device-login.test.mjs`
Expected: PASS（8 个用例）

- [ ] **Step 5: 收尾（不提交）**

Run: `npm run typecheck && git diff --check`

---

### Task 6: 卡片组件、环境页接线与全部文案

**Files:**
- Create: `src/client/features/environment/DeviceLoginCard.tsx`
- Modify: `src/client/features/environment/EnvironmentPane.tsx`（`AccountsStep` 接卡片 + props + 注释）
- Modify: `src/client/features/workbench/WorkbenchPanel.tsx`（按插件实例建 store、订阅、终态刷环境、登录进行中标志）
- Modify: `src/client/locales/zh-CN.ts`（新增 `deviceLogin*` 文案；改 `envDwsLoginNoDeviceCode` / `envAccountsHint` / 两处过期注释）
- Modify: `src/host/system/login-failure.ts`（两处指向改成面板上真实存在的「设备流登录」）
- Modify: `tests/unit/client-package.test.mjs`（改写 2868 那条用例）
- Modify: `tests/unit/host-login-failure.test.mjs`（断言的实际文案跟着改，**断言保留**）

**Interfaces:**
- Consumes: Task 5 的 `createDeviceLoginStore` / `deviceLoginCardView` / `DeviceLoginCardView`；Task 3 的门面方法。
- Produces: `EnvironmentPaneProps` 新增五个字段：
  `deviceLogin?: DwsDeviceLoginView | null`（Host 快照）、`deviceLoginBusy?: boolean`（设备流自己的请求在飞）、
  `loginInFlight?: boolean`（**loopback** 请求在飞，本任务新加的标志）、
  `onDeviceLoginStart?: () => void`、`onDeviceLoginCancel?: () => void`。
  卡片拿到的 `busy` 由环境页**合成**：`busy = deviceLoginBusy === true || loginInFlight === true`，
  这样 Task 5 的 `deviceLoginCardView(view, { busy })` 只需要一个入参。

- [ ] **Step 1: 先改既有断言，让它失败**

`tests/unit/client-package.test.mjs:2868` 那条用例：标题与注释改成新口径（「账号连接：loopback 是首选，
设备流是回调不通时的备用入口」）。改动：

- **保留**：四个被删文件的存在性断言、「内置浏览器 / 二维码」的禁止词、
  `zhCN.envLoginNoBuiltinBrowser` 必须在、两颗老按钮必须在。
- **删除**：`'用设备码登录'` / `'复制设备码'` 两条禁止词（现在正当地提供设备流），
  以及按钮文案里 `|设备码登录` 那条正则的禁止项。
- **新增**：`accountsText.includes(zhCN.deviceLoginStart)` 必须为真；
  `findButtonLike(accounts, zhCN.deviceLoginStart)` 找得到那颗按钮；
  `zhCN.deviceLoginStartHint` 必须出现（说清什么时候用它）。

同时 `tests/unit/host-login-failure.test.mjs` 里那两条
`assert.match(advice.action, /设备码登录/)` / `/不是绕过办法/` 改成匹配新文案里的
`/设备流登录/` 与 `/不是绕过办法/`（事实不变，指向变准）。

Run: `node --test tests/unit/client-package.test.mjs`
Expected: FAIL —— `zhCN.deviceLoginStart` 是 `undefined`

- [ ] **Step 2: 加文案**

`src/client/locales/zh-CN.ts` 新增（文案是最终用户可见的，按此实现）：

```ts
deviceLoginStart: '设备流登录（浏览器回调不通时用）',
deviceLoginStartHint: '点开后会显示一段授权码与一个链接：在浏览器里打开链接、输入授权码即可完成授权。'
  + '适合浏览器回调打不开、或本机没有可用浏览器的环境。',
deviceLoginWaiting: '等待你在浏览器里完成授权',
deviceLoginOpen: '打开授权页面',
deviceLoginCopyCode: '复制授权码',
deviceLoginCopyLink: '复制链接',
deviceLoginCancel: '取消',
deviceLoginRetry: '重试',
deviceLoginOk: '钉钉已授权，已重新检查环境',
deviceLoginTimeout: '等待授权超时（5 分钟）。请重试一次。',
```

并把 `envDwsLoginNoDeviceCode` 改成新口径（loopback 仍是首选，回调不通 / 无头环境用设备流），
`envAccountsHint` 补一句设备流。**同时删掉** `zhCN.ts:264-265` 与 `:967` 那两处
「没有 `dwsLoginDevice`（设备码登录）」的过期约束注释。

- [ ] **Step 3: 写卡片组件**

`DeviceLoginCard.tsx`：**props-only 的纯渲染器**（不 useState、不 useEffect）——
它接收 `view: DeviceLoginCardView`、`busy`、`dwsBusy`（dws 本机目录体检忙）与四个回调。
按 Task 5 的 `phase` 渲染四个状态（spec §7 那张表）。授权码用等宽 + `letterSpacing` 呈现，
`data-crwu-device-login` / `data-crwu-device-login-phase` 两个属性供浏览器验收脚本与单测定位。
复制走既有 `workbenchApi.clipboard`（与开发者诊断同一条路）。

- [ ] **Step 4: 接进环境页**

`EnvironmentPane.tsx` 的 `AccountsStep`：在「钉钉认证」那个 `SetupRow` 的 `extra` 里，
loopback 按钮之后加设备流按钮，紧跟着渲染 `<DeviceLoginCard .../>`；
把 `props.loginMessage` 那段保留在它下面。`EnvironmentPaneProps` 加 Step 1 列出的五个字段。

- [ ] **Step 5: 在 `WorkbenchPanel` 里持 store**

- 用 `React.useRef` + 一个 effect 建 `createDeviceLoginStore`：
  `api` 指向门面三方法，`onSettled: (view) => { if (view.phase === 'ok') void envStatus.refresh() }`；
  effect 的清理函数调 `store.dispose()`；effect 内先 `void store.resume()`（切回来能看到正在跑的那次）。
- 订阅 store 把快照写进 state，传给 `EnvironmentPane`。
- `runLogin`（既有函数）维护一个 `loginInFlight` 状态：进入时 `true`、`finally` 里 `false`。
  **注意**：这个标志是本任务新加的，现在没有 —— `runLogin` 只维护 `loginMessage`
  （已经显示了"正在等待…"），两颗登录按钮的 `disabled` 只看是否已授权。
  它和设备流自己的请求中标志一起传给环境页，由环境页合成卡片的 `busy`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/unit/client-package.test.mjs tests/unit/host-login-failure.test.mjs tests/unit/client-dws-device-login.test.mjs`
Expected: PASS

再加一条**静态渲染**断言进 `client-package.test.mjs`：设备流 `running` 快照传进去时，
面板渲染出授权码原文与链接（用既有 `envPaneProps` + `textOf`，不需要 effect）。

Run: `node --test tests/unit/client-package.test.mjs`
Expected: PASS

- [ ] **Step 7: 收尾（不提交）**

Run: `npm run typecheck && npm test && git diff --check`

---

### Task 7: 文档、规则与发布准备

**Files:**
- Modify: `plugins/dsh-crwu-workbench/AGENTS.md`
- Modify: `plugins/dsh-crwu-workbench/docs/development-notes.md`（§14 顶部、§20.2）
- Modify: `plugins/dsh-crwu-workbench/docs/ui-design-guidelines.md`（§6.8）
- Modify: `plugins/dsh-crwu-workbench/README.md`、`README.en.md`
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`、`VERSION`、`package.json`、Host 版本常量、lockfile（经 `version:set`）
- Modify: `src/host/system/login-failure.ts` 顶部那张表里 `dws auth login [--device]` 那一行（现在写着设备码走不通的旧结论）

**Interfaces:**
- Consumes: 前面全部任务。
- Produces: 无代码接口；产出可用包与一份与代码一致的规则文档。

- [ ] **Step 1: 改治理规则（这是本次唯一需要人明确同意的规则变更）**

`plugins/dsh-crwu-workbench/AGENTS.md` 的 Security boundaries 里那句
"the plugin does not collect passwords, browser cookies, QR credentials, or device codes"
改成准确口径：

> 面板只把**本人本次登录**的设备码回显给本人（不落盘、不进日志、不进对话）；
> 插件仍然不收集口令、浏览器 Cookie 与二维码凭据。

- [ ] **Step 2: 把两处「不得恢复」的历史结论改成与代码一致**

- `docs/development-notes.md` §14 顶部那段「**不得**据此恢复任何内置登录入口或设备码流程」：
  保留历史记述（那是史实），但补一句协议 32（2026-10-13）的新口径与指向本 spec 的链接。
- 同文件 §20.2「删掉 … `dws-login-start` / `dws-login-status`」：补「协议 32 以
  `dws-login-device-*` 三条操作恢复设备流；loopback 的 `dws-login` 仍未改」。
- `docs/ui-design-guidelines.md` §6.8 账号连接那段：补设备流按钮与四个状态。

Run: `make docs-check`
Expected: PASS

- [ ] **Step 3: 更新中英 README 与 CHANGELOG**

- `README.md` / `README.en.md`：环境信息页那一行（现在写着「插件不提供内置浏览器扫码、不显示二维码、不生成设备码」）
  改成「loopback 由本机 CLI 拉起系统浏览器；浏览器回调不通时可用设备流登录（面板显示授权码与链接）」。
  两份结构保持一致，只改这一处口径。
- `CHANGELOG.md`：在 `0.0.41` 之上加 `0.0.42` 一节，写清四件事：设备流登录三条操作、
  协议 32、`dws-login` 在设备流进行时被拦、以及规则/文档口径变更。

- [ ] **Step 4: 设置版本**

Run: `npm run version:set 0.0.42 && npm run version:check`
Expected: 两条都成功，`VERSION` / `package.json` / Host 版本常量同步为 `0.0.42`

- [ ] **Step 5: 全量门禁**

Run: `npm run check && git diff --check`
Expected: 全绿。若 `pack:assert` 报操作数量或文件清单不一致，按它的报错补齐（不要绕过）。

- [ ] **Step 6: 交回用户做真机验收**

按插件 `AGENTS.md`：agent 可以构建并安装链接开发包，但**真机那一步由用户执行**。
交给用户验收的清单：

1. 环境信息 → ① 账号连接 → 看到两颗钉钉登录按钮；
2. 点「设备流登录」→ **秒级**出现授权码与链接，系统浏览器被拉起（或被拦截，此时手动点「打开授权页面」）；
3. 在浏览器里完成授权 → 面板**自动**变「钉钉已授权」且钉钉那一行转「已通过」（不用手点重新检查）；
4. 设备流跑着时点 loopback 按钮 → 得到「设备流登录正在进行，请先取消」而不是权限报错；
5. 跑到一半点「取消」→ 进程结束、按钮回到闲置态；再点一次能重新开始。

**不提交、不推送、不发版** —— 等用户验收与评审。

---

## 附：本计划与 spec 的一处刻意偏差

spec §9.2 写的是「新客户端测试驱动卡片」。落地时改为**测纯 store + 纯视图函数**，
`.tsx` 只留静态渲染断言（进 `client-package.test.mjs`）。原因：本仓的 React 替身
（`tests/helpers/tsx-loader.mjs` 的 `fakeReact`）**只实现渲染**，`useEffect` 只被塞进数组、从不执行，
`useState` 的 setter 也不触发重渲染 —— 把轮询逻辑放进组件，等于这段逻辑没有任何测试覆盖。
spec 的**行为要求一字未改**（秒级出码、终态自动刷新、取消、切回继续），只是把它移进了可测的模块。
