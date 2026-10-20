# 工作空间清理（清空）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在环境信息页的工作空间区域增加「清理工作空间…」：扫描并展示待删清单，输入目录名确认后，停止并归档归属会话、可选删除会话日志、清空工作空间根下的全部直接子项，并清空插件审核历史。

**Architecture:** 扫描与执行拆成两条 Host RPC（`workspace-cleanup-plan` / `workspace-cleanup-apply`）。扫描产出一份带指纹的内存计划（5 分钟、单次使用）；执行前重新扫描比对指纹，然后按「归档会话 → 等待静止 → 关估值存储 → 删会话日志 → 删子项 → 清插件状态 → 回读」的顺序执行。删除只用 Host 内 `node:fs`（可注入 IO），不拼 shell 命令；路径只来自 Host 状态，边界只认工作空间根的直接子项。

**Tech Stack:** TypeScript（ESM，Node 22/24）、React 18、Cordis 服务、Node 原生 `node:test`、`node:fs/promises`。

**Spec:** [docs/superpowers/specs/2026-10-20-workspace-cleanup-design.md](../specs/2026-10-20-workspace-cleanup-design.md)

## Global Constraints

- 所有改动在 `plugins/dsh-crwu-workbench/` 内；不要改 DSH 自身代码。
- 不新增运行时依赖；不使用 shell、`runShell`、`rm -rf`、`Remove-Item`。
- 删除只用 `src/host/domains/workspace-cleanup/io.ts` 的 `node:fs/promises`；其它模块只依赖 `CleanupIo` 接口。
- 工作空间路径只来自 `resolveSelectedWorkspace(ctx, state)`；RPC 请求体**不含路径**。
- 协议：`WORKBENCH_PROTOCOL` 48 → **49**；授权收据 `LOCAL_ACCESS_SCHEMA_VERSION` 1 → **2**；插件版本 → **0.0.50**。
- 注释风格、命名、缩进跟随同目录现有文件；注释只写「为什么」，不复述代码。
- **不自动 commit / push**（仓库规则）。每个任务结束只做检查点：跑测试、`git status --short`、`git diff --check`。
- 测试命令一律在 `plugins/dsh-crwu-workbench/` 下执行。
- 每个任务先写失败测试，再实现；测试必须能因预期原因失败。

## Review Focus

最容易让员工踩到、而 spec 没有逐条写测试的五类输入/状态：

1. **W 本身是符号链接**：扫描后链接被换掉或目录被替换 → 执行必须只对扫描时 `realPath` 的直接子项动手，链接本身按项删除、永不跟随。
2. **确认期间会话状态变化**：原来空闲的会话开始跑、或多出/少掉一条会话 → 不能删到未归档的活会话；会话集合变化必须让指纹失配。
3. **单条删除失败**：权限不足、文件被占用、Windows 文件名过长 → 其余项继续，`partial` 与 `remaining` 必须准确，不能报 `completed`。
4. **清理中途页面关闭 / RPC 超时**：结果未知 → 客户端不许显示成功；重开页面重新扫描必须能看到真实剩余。
5. **重复提交同一计划**：双击、两次弹窗、过期后再点 → 第二次必须 `conflict`，绝不重复删除。

这些行为在 Task 2（符号链接）、Task 5（指纹/单次）、Task 7（失败与剩余）、Task 8（冲突）、Task 10（中断后重扫）各自的测试里钉住。

---

### Task 1: 契约、授权能力与协议门面

**Files:**
- Create: `src/shared/contracts/workspace-cleanup.ts`
- Create: `src/shared/wire/workspace-cleanup.ts`
- Modify: `src/shared/contracts/index.ts`
- Modify: `src/shared/wire/index.ts`
- Modify: `src/shared/access/types.ts`
- Modify: `src/shared/consts.ts`
- Modify: `src/host/core/access/operations.ts`
- Modify: `src/client/modules/environment/ui/LocalAccessConsentCard.tsx`
- Modify: `src/client/locales/zh-CN.ts`
- Modify: `tests/unit/host/host-workflow-production.test.mjs:579`
- Test: `tests/unit/shared/workspace-cleanup-contract.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WORKSPACE_CLEANUP_ENTRY_LIMIT = 500`
  - `WorkspaceCleanupErrorKind`, `WorkspaceCleanupEntryKind`, `WorkspaceCleanupEntry`, `WorkspaceCleanupSession`, `WorkspaceCleanupTotals`, `WorkspaceCleanupPlan`, `WorkspaceCleanupRequest`, `WorkspaceCleanupFailure`, `WorkspaceCleanupResult`（字段与 spec §5 逐字一致）
  - `LOCAL_ACCESS_CAPABILITIES` 末项 `'workspace-cleanup'`
  - `LOCAL_ACCESS_SCHEMA_VERSION = 2`
  - `LOCAL_ACCESS_OPERATIONS['system.workspace-cleanup']`

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/shared/workspace-cleanup-contract.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { WORKSPACE_CLEANUP_ENTRY_LIMIT } = await import(
  new URL('src/shared/contracts/workspace-cleanup.ts', ROOT).href)
const { WORKBENCH_PROTOCOL } = await import(new URL('src/shared/consts.ts', ROOT).href)
const { LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_SCHEMA_VERSION } = await import(
  new URL('src/shared/access/types.ts', ROOT).href)
const { LOCAL_ACCESS_OPERATIONS, LOCAL_ACCESS_OPERATION_NAMES } = await import(
  new URL('src/host/core/access/operations.ts', ROOT).href)

test('清理契约暴露展示上限 500', () => {
  assert.equal(WORKSPACE_CLEANUP_ENTRY_LIMIT, 500)
})

test('协议升到 49、授权收据升到 2，并新增 workspace-cleanup 能力', () => {
  assert.equal(WORKBENCH_PROTOCOL, 49)
  assert.equal(LOCAL_ACCESS_SCHEMA_VERSION, 2)
  assert.equal(LOCAL_ACCESS_CAPABILITIES.at(-1), 'workspace-cleanup')
})

test('封闭操作表登记 system.workspace-cleanup：filesystem / 特权 / 只给面板', () => {
  assert.ok(LOCAL_ACCESS_OPERATION_NAMES.includes('system.workspace-cleanup'))
  const descriptor = LOCAL_ACCESS_OPERATIONS['system.workspace-cleanup']
  assert.equal(descriptor.capability, 'workspace-cleanup')
  assert.equal(descriptor.transport, 'filesystem')
  assert.equal(descriptor.privileged, true)
  assert.deepEqual(descriptor.allowedSources, ['panel'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/shared/workspace-cleanup-contract.test.mjs`
Expected: FAIL —— 模块 `src/shared/contracts/workspace-cleanup.ts` 不存在。

- [ ] **Step 3: 写共享契约并挂到两个入口**

按 spec §5 写 `src/shared/contracts/workspace-cleanup.ts`；`workspace` 字段注释说明 `name` 是末段目录名、也是确认输入。`contracts/index.ts` 与 `wire/index.ts` 各加一行导出；`wire/workspace-cleanup.ts` 照 `wire/environment.ts` 写一条编译期赋值校验。

- [ ] **Step 4: 扩授权能力与 schema**

`shared/access/types.ts`：能力数组末尾追加 `'workspace-cleanup'`，`LOCAL_ACCESS_SCHEMA_VERSION = 2`，并更新文件头关于范围的说明。

- [ ] **Step 5: 登记封闭操作与协议**

`shared/consts.ts` 改 `WORKBENCH_PROTOCOL = 49` 并补变更注释；`host/core/access/operations.ts` 的类型联合、名字数组、描述表各加 `'system.workspace-cleanup'`。

- [ ] **Step 6: 补授权卡的可见文案**

`LocalAccessConsentCard.tsx` 的 `capabilityLabel` 增加分支返回 `envConsentCapCleanup`；`zh-CN.ts` 文案：「清理工作空间：删除所选工作空间下的全部内容与会话日志，不可恢复」。

- [ ] **Step 7: 更新既有协议断言**

把 `tests/unit/host/host-workflow-production.test.mjs:579` 的 `assert.equal(WORKBENCH_PROTOCOL, 48)` 改成 `49`。

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test tests/unit/shared/workspace-cleanup-contract.test.mjs tests/unit/host/host-workflow-production.test.mjs`
Expected: PASS。

- [ ] **Step 9: 类型检查 + 检查点**

Run: `npm run typecheck && git status --short && git diff --check`
Expected: 无类型错误；改动只含本任务文件；不提交。

---

### Task 2: 工作空间边界守卫

**Files:**
- Create: `src/host/domains/workspace-cleanup/types.ts`
- Create: `src/host/domains/workspace-cleanup/guards.ts`
- Test: `tests/unit/host/workspace-cleanup-guards.test.mjs`

**Interfaces:**
- Consumes: `isAbsoluteLocalPath`, `isLocalPathUnder`, `joinLocalPath`, `trimTrailingSeparators`, `basenameLocalPath`（`src/shared/utils/local-path.ts`）；`WorkspaceCleanupEntryKind`（Task 1）。
- Produces:

```ts
export interface WorkspaceIdentity { id: string; path: string; realPath: string; name: string }
export interface GuardDeps {
  stat(path: string): Promise<{ isDirectory(): boolean } | undefined>
  realpath(path: string): Promise<string>
}
export interface GuardInput {
  workspace: { id: string; path: string; title: string }
  home: string
  platform: string
  deps: GuardDeps
}
export type GuardOutcome = { ok: true; identity: WorkspaceIdentity } | { ok: false; error: string }
export async function guardWorkspace(input: GuardInput): Promise<GuardOutcome>
export function isFilesystemRoot(path: string): boolean
export function isDirectChild(parent: string, child: string): boolean
export function classifyEntry(name: string, facts: {
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean
}): WorkspaceCleanupEntryKind
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-guards.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const { guardWorkspace, isDirectChild, isFilesystemRoot } = await import(
  new URL('src/host/domains/workspace-cleanup/guards.ts', ROOT).href)

const HOME = '/Users/x'
function depsOf(paths = {}) {
  return {
    async stat(path) { return Object.hasOwn(paths, path) ? { isDirectory: () => paths[path] === 'dir' } : undefined },
    async realpath(path) { return paths[`real:${path}`] ?? path },
  }
}
function input(path) {
  return { workspace: { id: 'w1', path, title: 't' }, home: HOME, platform: 'darwin-arm64', deps: depsOf() }
}

test('正常目录通过，并使用 realpath 作为删除路径', async () => {
  const out = await guardWorkspace({ ...input('/Users/x/work'), deps: depsOf({
    '/Users/x/work': 'dir', 'real:/Users/x/work': '/private/Users/x/work',
  }) })
  assert.equal(out.ok, true)
  assert.equal(out.identity.realPath, '/private/Users/x/work')
  assert.equal(out.identity.name, 'work')
})

test('拒绝文件系统根、主目录与 ~/.dsh（含祖先）', async () => {
  for (const path of ['/', '/Users/x', '/Users', '/Users/x/.dsh', '/Users/x/.dsh/profiles']) {
    const out = await guardWorkspace({ ...input(path), deps: depsOf({ [path]: 'dir' }) })
    assert.equal(out.ok, false, `${path} 必须被拒`)
  }
})

test('Windows 盘符根与主目录祖先也被拒', async () => {
  assert.equal(isFilesystemRoot('C:\\'), true)
  assert.equal(isFilesystemRoot('\\\\server\\share\\'), true)
  const out = await guardWorkspace({
    ...input('C:\\Users'), home: 'C:\\Users\\x', platform: 'win32-x64',
    deps: depsOf({ 'C:\\Users': 'dir' }),
  })
  assert.equal(out.ok, false)
})

test('直接子项判定：兄弟前缀不算，嵌套不算', () => {
  assert.equal(isDirectChild('/w', '/w/a'), true)
  assert.equal(isDirectChild('/w', '/w2/a'), false)
  assert.equal(isDirectChild('/w', '/w'), false)
  assert.equal(isDirectChild('/w', '/w/a/b'), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-guards.test.mjs`
Expected: FAIL —— `guards.ts` 不存在。

- [ ] **Step 3: 实现守卫与内部类型**

- `types.ts` 只放 `WorkspaceIdentity` 与后续任务共用的 IO/扫描类型（Task 3 会扩展，先建空壳也可以，但本任务至少要有 `WorkspaceIdentity`）。
- `guards.ts` 顺序：绝对路径 → `stat` 是目录 → `realpath` → 根判定 → `home` 轴 → `~/.dsh` 轴（双向：W 在 `.dsh` 内也拒）→ 状态文件祖先。
- `isFilesystemRoot`：POSIX `/`；Windows `/^[A-Za-z]:[\\/]?$/` 与 UNC 共享根 `/^\\\\[^\\/]+\\[^\\/]+[\\/]?$/`。
- `isDirectChild`：`basenameLocalPath(child)` 非空且不含分隔符，且 `joinLocalPath(parent, base) === child`（风格感知，不做字符串前缀）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-guards.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`
Expected: 通过；不提交。

---

### Task 3: 直接子项扫描与递归大小

**Files:**
- Modify: `src/host/domains/workspace-cleanup/types.ts`
- Create: `src/host/domains/workspace-cleanup/consts.ts`
- Create: `src/host/domains/workspace-cleanup/scan.ts`
- Create: `src/host/domains/workspace-cleanup/io.ts`
- Create: `tests/helpers/workspace-cleanup-fixture.mjs`
- Test: `tests/unit/host/workspace-cleanup-scan.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceIdentity`（Task 2）、`WorkspaceCleanupEntry`。
- Produces:

```ts
// consts.ts
export const WORKSPACE_CLEANUP_SIZE_ENTRY_BUDGET = 50_000

// types.ts
export interface CleanupDirent {
  name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean
}
export interface CleanupStats {
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean
  size: number; mtimeMs: number
}
export interface CleanupIo {
  readdir(path: string): Promise<CleanupDirent[]>
  lstat(path: string): Promise<CleanupStats | undefined>
  stat(path: string): Promise<CleanupStats | undefined>
  realpath(path: string): Promise<string>
  removeTree(path: string): Promise<void>
  unlink(path: string): Promise<void>
}
export interface ScannedEntry extends WorkspaceCleanupEntry { mtimeMs: number }
export interface EntryTotals {
  folders: number; files: number; symlinks: number; other: number
  bytes: number; bytesComplete: boolean
}

// scan.ts
export async function scanEntries(io: CleanupIo, workspace: WorkspaceIdentity):
  Promise<{ entries: ScannedEntry[]; totals: EntryTotals }>

// io.ts
export function nodeCleanupIo(): CleanupIo
```

- [ ] **Step 1: 写内存 IO 夹具与失败测试**

夹具 `tests/helpers/workspace-cleanup-fixture.mjs` 导出 `memoryCleanupIo(nodes, options)`：`nodes` 是 `[{ path, kind, size?, mtimeMs? }]`；`readdir` 返回直接子项、`lstat/stat` 返回节点、`removeTree` 删子树并记录 `calls`、`unlink` 删单项并记录。

```js
// tests/unit/host/workspace-cleanup-scan.test.mjs
const { scanEntries } = await import(new URL('src/host/domains/workspace-cleanup/scan.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)
const WS = { id: 'w1', path: '/w', realPath: '/w', name: 'w' }

test('计数、递归大小与排序', async () => {
  const io = memoryCleanupIo([
    { path: '/w/b', kind: 'dir', mtimeMs: 2 },
    { path: '/w/b/x', kind: 'file', size: 10 },
    { path: '/w/a', kind: 'file', size: 3, mtimeMs: 1 },
    { path: '/w/link', kind: 'symlink', mtimeMs: 3 },
  ])
  const { entries, totals } = await scanEntries(io, WS)
  assert.deepEqual(entries.map((e) => e.name), ['a', 'b', 'link'])
  assert.equal(totals.folders, 1)
  assert.equal(totals.files, 1)
  assert.equal(totals.symlinks, 1)
  assert.equal(totals.bytes, 13)
  assert.equal(totals.bytesComplete, true)
  assert.equal(entries.find((e) => e.name === 'link').sizeBytes, 0)
})

test('超出 50,000 项预算时停止并标记不完整', async () => {
  const nodes = [{ path: '/w/big', kind: 'dir' }]
  for (let i = 0; i < 50_001; i += 1) nodes.push({ path: `/w/big/f${String(i)}`, kind: 'file', size: 1 })
  const { totals } = await scanEntries(memoryCleanupIo(nodes), WS)
  assert.equal(totals.bytesComplete, false)
  assert.equal(totals.bytes, 50_000)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-scan.test.mjs`
Expected: FAIL —— `scan.ts` / 夹具不存在。

- [ ] **Step 3: 实现扫描与生产 IO**

- `scanEntries`：`readdir(realPath)` → 逐项 `lstat(join(realPath, name))`；目录用共享预算递归累加（预算只按条目数，不按时间）；符号链接与其它类型 `sizeBytes=0`；结果按 `name` 排序。
- `nodeCleanupIo`：`readdir` 用 `withFileTypes` 转成 `CleanupDirent`；`removeTree` 用 `rm(path,{recursive:true,force:false})`；`unlink` 用 `unlink`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-scan.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 4: 会话枚举、归属过滤与控制器适配

**Files:**
- Modify: `src/host/domains/workspace-cleanup/types.ts`
- Create: `src/host/domains/workspace-cleanup/session-port.ts`
- Create: `src/host/domains/workspace-cleanup/sessions.ts`
- Test: `tests/unit/host/workspace-cleanup-sessions-scan.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceIdentity`、`isLocalPathUnder`。
- Produces:

```ts
export interface CleanupSessionRow {
  sessionId: string; cwd: string; running: boolean; agentAvailable: boolean
  parentSessionId: string; updatedAt: number; title: string
}
export interface CleanupSessionPort {
  list(): Promise<CleanupSessionRow[]>
  archive(input: { sessionId: string; stopActivity: boolean }): Promise<string[]>
}
export interface SessionTotals {
  sessions: number; topLevelSessions: number; subagentSessions: number; runningSessions: number
}
export function scanSessions(rows: readonly CleanupSessionRow[], workspace: WorkspaceIdentity):
  { sessions: WorkspaceCleanupSession[]; totals: SessionTotals }
export function cleanupSessionPort(ctx: Context, options?: { pageLimit?: number }):
  { ok: true; port: CleanupSessionPort } | { ok: false; error: string }
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-sessions-scan.test.mjs
const { scanSessions } = await import(new URL('src/host/domains/workspace-cleanup/sessions.ts', ROOT).href)
const { cleanupSessionPort } = await import(
  new URL('src/host/domains/workspace-cleanup/session-port.ts', ROOT).href)

const WS = { id: 'w1', path: '/w', realPath: '/w', name: 'w' }
const row = (id, cwd, extra = {}) => ({
  sessionId: id, cwd, running: false, agentAvailable: false,
  parentSessionId: '', updatedAt: 1, title: id, ...extra,
})

test('只保留 cwd 在 W 之内（含相等），兄弟前缀不算', () => {
  const { sessions, totals } = scanSessions([
    row('a', '/w'), row('b', '/w/case-1'), row('c', '/w2/case'),
    row('d', '/w', { running: true }), row('e', '/w/case-1', { parentSessionId: 'a' }),
  ], WS)
  assert.deepEqual(sessions.map((s) => s.sessionId), ['a', 'b', 'd', 'e'])
  assert.equal(totals.sessions, 4)
  assert.equal(totals.topLevelSessions, 3)
  assert.equal(totals.subagentSessions, 1)
  assert.equal(totals.runningSessions, 1)
})

test('Windows 大小写不敏感', () => {
  const win = { id: 'w', path: 'C:\\Work', realPath: 'C:\\Work', name: 'Work' }
  const { sessions } = scanSessions([row('a', 'c:\\work\\case')], win)
  assert.equal(sessions.length, 1)
})

test('缺少会话控制器时给出明确失败', () => {
  const out = cleanupSessionPort({ get: () => undefined })
  assert.equal(out.ok, false)
  assert.match(out.error, /会话/)
})

test('翻页直到没有 cursor，并转成扁平行', async () => {
  const pages = [
    { items: [{ sessionId: 's1', cwd: '/w', parentSessionId: undefined,
      projections: { values: { title: '标题' } } }], cursor: 'next' },
    { items: [{ sessionId: 's2', cwd: '/w' }] },
  ]
  let calls = 0
  const sessionController = { list: async () => pages[calls++] }
  const workspaceController = { archiveSession: async () => ({ archivedSessionIds: ['s1'] }) }
  const port = cleanupSessionPort({ get: (n) => n === 'sessionController' ? sessionController
    : n === 'workspaceController' ? workspaceController : undefined })
  assert.equal(port.ok, true)
  const rows = await port.port.list()
  assert.deepEqual(rows.map((r) => r.sessionId), ['s1', 's2'])
  assert.equal(rows[0].title, '标题')
  assert.deepEqual(await port.port.archive({ sessionId: 's1', stopActivity: true }), ['s1'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-sessions-scan.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现过滤与适配**

- `scanSessions`：`cwd !== '' && isLocalPathUnder(cwd, realPath)`；`parentSessionId !== ''` 记为子代理；按 `sessionId` 排序。
- `session-port.ts`：
  - `ctx.get('sessionController')` 必须有 `list`；`ctx.get('workspaceController')` 必须有 `archiveSession`，缺任一 → `{ok:false}`。
  - `list()` 循环 `{ cursor }` 直到无 cursor，总条数上限 `options.pageLimit ?? 5000`，超限抛错（扫描层转 `capability-gap`）。
  - 行归一化：`title = text(projections.values.title)`，空则 `sessionId.slice(0, 8)`；`updatedAt` 非数则 0。
  - `archive` 调 `archiveSession({ sessionId, stopActivity })`，返回其 `archivedSessionIds`（非数组则 `[]`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-sessions-scan.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 5: 计划租约与指纹

**Files:**
- Modify: `src/host/domains/workspace-cleanup/consts.ts`
- Create: `src/host/domains/workspace-cleanup/plan.ts`
- Test: `tests/unit/host/workspace-cleanup-plan.test.mjs`

**Interfaces:**
- Consumes: `ScannedEntry`、`WorkspaceCleanupSession`、`WorkspaceCleanupTotals`、`WorkspaceIdentity`；`canonicalJson`、`digestOf`（`src/host/tools/common/snapshot.ts`）。
- Produces:

```ts
export const WORKSPACE_CLEANUP_PLAN_TTL_MS = 300_000
export const WORKSPACE_CLEANUP_REMAINING_NAME_LIMIT = 50

export interface CleanupPlan {
  planId: string; digest: string; expiresAt: number
  identity: WorkspaceIdentity
  entries: ScannedEntry[]
  sessions: WorkspaceCleanupSession[]
  totals: WorkspaceCleanupTotals
  notes: string[]
}
export type PlanTake =
  | { ok: true; plan: CleanupPlan }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' }
export interface PlanStore {
  put(plan: CleanupPlan): void
  take(planId: string): PlanTake
  acquire(): boolean
  release(): void
  busy(): boolean
}
export function createPlanStore(options?: {
  now?: () => number; id?: () => string; ttlMs?: number
}): PlanStore
export function fingerprint(input: {
  workspaceRealPath: string
  entries: readonly ScannedEntry[]
  sessionIds: readonly string[]
}): string
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-plan.test.mjs
const { createPlanStore, fingerprint } = await import(
  new URL('src/host/domains/workspace-cleanup/plan.ts', ROOT).href)

const entry = (name, mtimeMs = 1) => ({ name, kind: 'directory', sizeBytes: 0, mtimeMs })
const plan = (id = 'p1') => ({
  planId: id, digest: 'd', expiresAt: 0,
  identity: { id: 'w', path: '/w', realPath: '/w', name: 'w' },
  entries: [entry('a')], sessions: [], totals: {}, notes: [],
})

test('单次使用：第二次 take 返回 used', () => {
  let t = 1_000
  const store = createPlanStore({ now: () => t, id: () => 'p1' })
  store.put(plan())
  assert.equal(store.take('p1').ok, true)
  t += 1
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'used' })
})

test('过期返回 expired 并移除', () => {
  let t = 0
  const store = createPlanStore({ now: () => t, ttlMs: 100, id: () => 'p1' })
  store.put(plan())
  t = 101
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'expired' })
  assert.deepEqual(store.take('p1'), { ok: false, reason: 'unknown' })
})

test('锁：同一次只允许一份执行', () => {
  const store = createPlanStore()
  assert.equal(store.acquire(), true)
  assert.equal(store.acquire(), false)
  assert.equal(store.busy(), true)
  store.release()
  assert.equal(store.busy(), false)
})

test('指纹：改一项或换会话集合都变，改大小不变', () => {
  const base = fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1'] })
  assert.equal(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1'] }), base)
  assert.equal(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 2)], sessionIds: ['s1'] }), base)
  assert.notEqual(fingerprint({ workspaceRealPath: '/w', entries: [entry('b', 1)], sessionIds: ['s1'] }), base)
  assert.notEqual(fingerprint({ workspaceRealPath: '/w', entries: [entry('a', 1)], sessionIds: ['s1', 's2'] }), base)
  assert.equal(fingerprint({
    workspaceRealPath: '/w',
    entries: [{ name: 'a', kind: 'directory', sizeBytes: 999, mtimeMs: 1 }],
    sessionIds: ['s1'],
  }), base)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-plan.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现指纹与租约**

- `fingerprint` 用 `digestOf(canonicalJson({ v: 1, workspace, entries: [{name,kind}], sessions: ids }))`；排序在函数内做，**不含** `sizeBytes`、`mtimeMs` 与运行状态。
- `createPlanStore`：`Map<string, CleanupPlan>`（只保留最后一份，`put` 时清空）；`take` 顺序：不存在 → `unknown`；过期 → `expired` 并删除；已用 → `used`；成功则记录 `usedIds` 并删除。
- `acquire/release/busy` 用布尔锁；`release` 幂等。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-plan.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 6: 停止并归档会话、删除会话日志

**Files:**
- Modify: `src/host/domains/workspace-cleanup/consts.ts`
- Create: `src/host/domains/workspace-cleanup/session-run.ts`
- Test: `tests/unit/host/workspace-cleanup-session-run.test.mjs`

**Interfaces:**
- Consumes: `CleanupSessionPort`、`CleanupSessionRow`、`CleanupIo`、`WorkspaceCleanupSession`、`WorkspaceCleanupFailure`；`joinLocalPath`。
- Produces:

```ts
export const WORKSPACE_CLEANUP_SESSION_WAIT_MS = 30_000
export const WORKSPACE_CLEANUP_SESSION_POLL_MS = 250

export interface SessionRunDeps {
  port: CleanupSessionPort
  io: CleanupIo
  home: string
  now(): number
  sleep(ms: number): Promise<void>
  waitMs?: number
  pollMs?: number
}
export interface ArchiveOutcome {
  ok: boolean; reason: string
  archivedSessionIds: string[]
  failures: WorkspaceCleanupFailure[]
  stuckSessionIds: string[]
}
export interface LogOutcome {
  deletedSessionLogs: string[]
  skippedSessionLogs: { sessionId: string; reason: string }[]
  failures: WorkspaceCleanupFailure[]
}
export async function stopAndArchive(
  deps: SessionRunDeps, sessions: readonly WorkspaceCleanupSession[]): Promise<ArchiveOutcome>
export async function removeSessionLogs(
  deps: SessionRunDeps, sessions: readonly WorkspaceCleanupSession[]): Promise<LogOutcome>
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-session-run.test.mjs
const { stopAndArchive, removeSessionLogs } = await import(
  new URL('src/host/domains/workspace-cleanup/session-run.ts', ROOT).href)

const session = (id, extra = {}) => ({
  sessionId: id, title: id, running: true, agentAvailable: true,
  parentSessionId: '', updatedAt: 1, ...extra,
})

function depsWith(sequence, options = {}) {
  const archives = []
  const removals = []
  let index = 0
  return {
    archives, removals,
    port: {
      async list() { const rows = sequence[Math.min(index, sequence.length - 1)]; index += 1; return rows },
      async archive(input) { archives.push(input); return [input.sessionId] },
    },
    io: {
      async readdir(path) { return options.dir?.[path] ?? [] },
      async lstat() { return undefined },
      async stat() { return undefined },
      async realpath(p) { return p },
      async removeTree(path) { removals.push(path) },
      async unlink(path) { removals.push(path) },
    },
    home: '/Users/x',
    now: () => options.now ?? 0,
    sleep: async () => {},
    waitMs: options.waitMs ?? 100,
    pollMs: 1,
  }
}

test('运行中的顶层会话带 stopActivity 归档；子代理不单独归档', async () => {
  const deps = depsWith([[session('a'), session('b', { parentSessionId: 'a' })]])
  const out = await stopAndArchive(deps, [session('a'), session('b', { parentSessionId: 'a' })])
  assert.equal(out.ok, true)
  assert.deepEqual(deps.archives, [{ sessionId: 'a', stopActivity: true }])
})

test('会话一直不停：aborted、零文件删除', async () => {
  const deps = depsWith([[session('a')]])
  const out = await stopAndArchive(deps, [session('a')])
  assert.equal(out.ok, false)
  assert.deepEqual(out.stuckSessionIds, ['a'])
  assert.deepEqual(deps.removals, [])
})

test('归档抛错：立即中止并记 session-archive 失败', async () => {
  const deps = depsWith([[session('a')]])
  deps.port.archive = async () => { throw new Error('boom') }
  const out = await stopAndArchive(deps, [session('a')])
  assert.equal(out.ok, false)
  assert.equal(out.failures[0].kind, 'session-archive')
})

test('日志定位：0/1/2 命中三分支', async () => {
  const deps = depsWith([[]], { dir: { '/Users/x/.dsh/sessions': [
    { name: 'slug-a', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    { name: 'slug-b', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
  ] } })
  deps.io.readdir = async (path) => path === '/Users/x/.dsh/sessions'
    ? [
      { name: 'slug-a', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
      { name: 'slug-b', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
    ]
    : [{ name: 'a', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }]
  const out = await removeSessionLogs(deps, [session('a'), session('missing')])
  assert.deepEqual(out.deletedSessionLogs, ['a'])
  assert.equal(out.skippedSessionLogs.some((s) => s.sessionId === 'missing'), true)
  assert.equal(out.skippedSessionLogs.some((s) => /多个目录/.test(s.reason)), true)
})
```

（第三个 `removeSessionLogs` 用例需要两处 `a`：`slug-a/a` 与 `slug-b/a`；夹具里两个 slug 下的 `a` 都要出现。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-session-run.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现归档与日志删除**

- `stopAndArchive`：
  - 取实时 `rowById = new Map(await port.list())`；只对 `parentSessionId === ''` 的会话 `archive`，`stopActivity = row?.running || row?.agentAvailable`。
  - 归档失败或缺 id → 立即返回 `{ok:false, reason, failures, stuckSessionIds}`，不继续。
  - 轮询：每次 `list()` 后，计划内会话要么不在列表、要么 `running === false`（**不等 `agentAvailable`**：归档不销毁 attached Agent）；用 `now()` 判 `waitMs` 超时；超时返回 `stuckSessionIds`。`list()` 抛错 → `{ok:false, reason:'会话列表读取失败'}`。
- `removeSessionLogs`：
  - 会话根 `joinLocalPath(home, '.dsh', 'sessions')`；读一级 slug 目录，拼 `<slug>/<sessionId>`，`lstat` 是目录才算命中。
  - 0 命中 → skipped「日志已不存在」；>1 → skipped「会话 id 命中多个目录，拒绝猜测」；1 → `removeTree`。
  - 投影缓存 `join(home,'.dsh','storages','session_projcache','sessions', 'session-<id>.json')`：存在（lstat 非空）才 `unlink`，失败记 `session-log`。
  - 单条失败继续。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-session-run.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 7: 执行编排（顺序、失败与剩余）

**Files:**
- Create: `src/host/domains/workspace-cleanup/apply.ts`
- Test: `tests/unit/host/workspace-cleanup-apply.test.mjs`

**Interfaces:**
- Consumes: `CleanupPlan`、`CleanupIo`、`CleanupSessionPort`、`stopAndArchive`、`removeSessionLogs`、`isDirectChild`、`joinLocalPath`、`basenameLocalPath`。
- Produces:

```ts
export interface ApplyDeps {
  io: CleanupIo
  port: CleanupSessionPort
  home: string
  closeWorkflowStores(workspacePath: string): Promise<void>
  clearAudits(): void
  persistAudits(): Promise<boolean>
  now(): number
  sleep(ms: number): Promise<void>
  waitMs?: number
  pollMs?: number
}
export async function applyCleanup(
  deps: ApplyDeps,
  input: { plan: CleanupPlan; deleteSessionLogs: boolean },
): Promise<WorkspaceCleanupResult>
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-apply.test.mjs
const { applyCleanup } = await import(new URL('src/host/domains/workspace-cleanup/apply.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)

/** memoryCleanupIo 的 removeTree/unlink 会同步更新内存树，所以 remaining 回读是真的。 */
function harness(options = {}) {
  const calls = []
  const base = memoryCleanupIo(options.nodes ?? [
    { path: '/w/a', kind: 'dir' }, { path: '/w/a/x', kind: 'file', size: 1 },
    { path: '/w/f', kind: 'file', size: 2 },
  ])
  const io = {
    ...base,
    async removeTree(path) { calls.push(`removeTree ${path}`); return base.removeTree(path) },
    async unlink(path) { calls.push(`unlink ${path}`); return base.unlink(path) },
  }
  const deps = {
    io,
    port: { async list() { return [] }, async archive() { return [] } },
    home: '/Users/x',
    async closeWorkflowStores(path) { calls.push(`close ${path}`) },
    clearAudits() { calls.push('clearAudits') },
    async persistAudits() { calls.push('persistAudits'); return true },
    now: () => 0,
    sleep: async () => {},
  }
  return { deps, io, calls }
}

test('顺序：归档 → 关闭存储 → 删子项 → 清状态', async () => {
  const { deps, calls } = harness()
  const plan = {
    planId: 'p', digest: 'd', expiresAt: 1,
    identity: { id: 'w', path: '/w', realPath: '/w', name: 'w' },
    entries: [{ name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 }],
    sessions: [], totals: {}, notes: [],
  }
  const out = await applyCleanup(deps, { plan, deleteSessionLogs: false })
  assert.equal(out.ok, true)
  assert.deepEqual(calls.filter((c) => /close|removeTree|clearAudits|persistAudits/.test(c)), [
    'close /w', 'removeTree /w/a', 'clearAudits', 'persistAudits',
  ])
})

test('单条失败继续，结果 partial 且 remaining 准确', async () => {
  const { deps, io } = harness()
  const original = io.removeTree
  io.removeTree = async (path) => { if (path.endsWith('/a')) throw new Error('busy'); return original(path) }
  const plan = {
    planId: 'p', digest: 'd', expiresAt: 1,
    identity: { id: 'w', path: '/w', realPath: '/w', name: 'w' },
    entries: [
      { name: 'a', kind: 'directory', sizeBytes: 1, mtimeMs: 1 },
      { name: 'f', kind: 'file', sizeBytes: 2, mtimeMs: 1 },
    ],
    sessions: [], totals: {}, notes: [],
  }
  const out = await applyCleanup(deps, { plan, deleteSessionLogs: false })
  assert.equal(out.status, 'partial')
  assert.equal(out.ok, false)
  assert.equal(out.deleted.files, 1)
  assert.deepEqual(out.remainingNames, ['a'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-apply.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现编排**

- 先 `stopAndArchive(plan.sessions)`；`!ok` → 返回 `aborted`，不碰存储、日志与子项。
- `closeWorkflowStores(realPath)`（失败只记 `workflow-store`，继续）。
- `removeSessionLogs`（仅勾选时）：只对 `parentSessionId === ''` 调用？**不**——日志删除要对全部计划会话（含子代理）。
- 逐项删：`join(realPath, name)`，`lstat` 确认存在且 `isDirectChild`；目录/文件 `removeTree`，符号链接 `unlink`，其它记失败。
- 无论子项成败：`clearAudits()` + `persistAudits()`；写盘失败记 `state`。
- 回读 `readdir(realPath)`：`remaining` 计数、`remainingNames` 最多 50。
- `status`：`failures.length === 0 && remaining === 0` → `completed`；否则 `partial`。
- 结果里的 `archivedSessionIds` / `deletedSessionLogs` / `skippedSessionLogs` 来自前两步。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-apply.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 8: Host 服务、RPC 操作与工作流存储收尾

**Files:**
- Create: `src/host/domains/workspace-cleanup/index.ts`
- Create: `src/host/operations/workspace-cleanup.ts`
- Modify: `src/host/operations/register.ts`
- Modify: `src/host/operations/types-export.ts`
- Modify: `src/host/apply.ts`
- Modify: `src/host/integrations/valuation-workflow/host.ts`
- Modify: `tests/unit/host/host-package.test.mjs`（ported 声明随实现推导，通常只需确认）
- Test: `tests/unit/host/workspace-cleanup-service.test.mjs`
- Test: `tests/unit/host/workspace-cleanup-close-stores.test.mjs`

**Interfaces:**
- Consumes: 任务 1–7 的全部产物；`resolveSelectedWorkspace`、`LocalAccessBroker`、`persistAudits`、`workbenchConfigPath`。
- Produces:

```ts
export interface WorkspaceCleanupService {
  plan(): Promise<WorkspaceCleanupPlan>
  apply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult>
}
export interface WorkspaceCleanupServiceDeps {
  access: Pick<LocalAccessBroker, 'authorize' | 'note'>
  resolveWorkspace(): Promise<WorkspaceResolution>
  home(): Promise<string>
  platform(): Promise<string>
  sessionPort(): { ok: true; port: CleanupSessionPort } | { ok: false; error: string }
  io: CleanupIo
  closeWorkflowStores(workspacePath: string): Promise<void>
  clearAudits(): void
  persistAudits(): Promise<boolean>
  invalidate(): void
  now?(): number
}
export function createWorkspaceCleanupService(deps: WorkspaceCleanupServiceDeps): WorkspaceCleanupService
export function workspaceCleanupOperations(host: OperationHost): OperationMap
export async function closeStoresUnder(
  sessions: Map<string, Promise<{ close(): Promise<void> }>>,
  opened: Set<{ close(): Promise<void> }>,
  workspacePath: string,
): Promise<string[]>
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/host/workspace-cleanup-service.test.mjs
const { createWorkspaceCleanupService } = await import(
  new URL('src/host/domains/workspace-cleanup/index.ts', ROOT).href)
const { memoryCleanupIo } = await import(new URL('tests/helpers/workspace-cleanup-fixture.mjs', ROOT).href)

const identity = { id: 'w', path: '/w', realPath: '/w', name: 'w' }
function service(options = {}) {
  const calls = []
  const state = { audits: { a: {} }, activeKey: 'a', activeChildId: 'c',
    auditRoot: { workspaceId: 'w', workspacePath: '/w', casePath: '', sessionId: 's', title: '', assignedAt: '' } }
  return { calls, state, service: createWorkspaceCleanupService({
    access: {
      authorize: () => options.denied ? { ok: false, error: '未授权' } : { ok: true },
      note: () => {},
    },
    resolveWorkspace: async () => options.resolveNow?.()
      ?? options.resolve
      ?? { ok: true, workspace: { id: 'w', path: '/w', title: 'w' } },
    home: async () => '/Users/x',
    platform: async () => 'darwin-arm64',
    sessionPort: () => options.noSessions ? { ok: false, error: '没有会话控制器' } : {
      ok: true, port: { list: async () => [], archive: async () => [] },
    },
    io: options.io,
    closeWorkflowStores: async () => {},
    clearAudits: () => { state.audits = {} },
    persistAudits: async () => true,
    invalidate: () => calls.push('invalidate'),
    now: () => 1_000,
  }) }
}

test('未授权 → policy，且不扫描', async () => {
  const { service: svc } = service({ denied: true })
  const plan = await svc.plan()
  assert.equal(plan.ok, false)
  assert.equal(plan.errorKind, 'policy')
})

test('缺少会话控制器 → capability-gap', async () => {
  const { service: svc } = service({ noSessions: true, io: memoryCleanupIo([{ path: '/w', kind: 'dir' }]) })
  const plan = await svc.plan()
  assert.equal(plan.errorKind, 'capability-gap')
})

test('apply 的 planId 不认识 → conflict', async () => {
  const { service: svc } = service({ io: memoryCleanupIo([{ path: '/w', kind: 'dir' }]) })
  const out = await svc.apply({ planId: 'nope', digest: 'x', confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.status, 'failed')
  assert.equal(out.errorKind, 'conflict')
})

test('确认期间工作空间被换掉 → conflict，零删除', async () => {
  const io = memoryCleanupIo([{ path: '/w', kind: 'dir' }, { path: '/w/a', kind: 'dir' }])
  let current = { id: 'w', path: '/w', title: 'w' }
  const { service: svc } = service({
    io,
    resolveNow: () => ({ ok: true, workspace: current }),
  })
  const plan = await svc.plan()
  assert.equal(plan.ok, true)
  current = { id: 'w2', path: '/w2', title: 'w2' }
  const out = await svc.apply({ planId: plan.planId, digest: plan.digest,
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.errorKind, 'conflict')
  assert.deepEqual(io.calls.filter((c) => c.startsWith('removeTree')), [])
})

test('客户端指纹不对 → input，零删除', async () => {
  const io = memoryCleanupIo([{ path: '/w', kind: 'dir' }, { path: '/w/a', kind: 'dir' }])
  const { service: svc } = service({ io })
  const plan = await svc.plan()
  const out = await svc.apply({ planId: plan.planId, digest: 'wrong',
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.errorKind, 'input')
  assert.deepEqual(io.calls.filter((c) => c.startsWith('removeTree')), [])
})

test('正常路径：plan → apply 完成，空工作空间 remaining=0', async () => {
  const io = memoryCleanupIo([{ path: '/w', kind: 'dir' }])
  const { service: svc } = service({ io })
  const plan = await svc.plan()
  const out = await svc.apply({ planId: plan.planId, digest: plan.digest,
    confirmName: 'w', deleteSessionLogs: false })
  assert.equal(out.status, 'completed')
  assert.equal(out.remaining, 0)
})
```

```js
// tests/unit/host/workspace-cleanup-close-stores.test.mjs
const { closeStoresUnder } = await import(
  new URL('src/host/integrations/valuation-workflow/host.ts', ROOT).href)
test('只关闭 store 路径落在 W 之下的会话，并清两处集合', async () => {
  const closed = []
  const inside = { close: async () => { closed.push('inside') } }
  const outside = { close: async () => { closed.push('outside') } }
  const sessions = new Map([
    ['w\u0000/w/.crwu', Promise.resolve(inside)],
    ['w\u0000/w2/.crwu', Promise.resolve(outside)],
  ])
  const opened = new Set([inside, outside])
  const keys = await closeStoresUnder(sessions, opened, '/w')
  assert.deepEqual(keys, ['w\u0000/w/.crwu'])
  assert.deepEqual(closed, ['inside'])
  assert.equal(sessions.size, 1)
  assert.equal(opened.has(inside), false)
  assert.equal(opened.has(outside), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/host/workspace-cleanup-service.test.mjs tests/unit/host/workspace-cleanup-close-stores.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现服务与操作**

- `index.ts`：
  - `plan()`：authorize（`system.workspace-cleanup`, `panel`）→ resolve → guard（用 `io.stat/realpath`）→ sessionPort → `scanEntries` + `scanSessions` → 组装 `CleanupPlan`（notes 固定两条限制）→ `store.put` → 返回线上计划（`entries.slice(0, 500)`、`entriesTruncated`）。
  - 错误归类：`scanEntries` 抛错 → `infrastructure`；会话 `list()` 抛错 → `infrastructure`；会话超过 5,000 条 → `capability-gap`；缺控制器 → `capability-gap`。
  - `apply()`：authorize → `store.take` → 重新 resolve 并 `guardWorkspace` 一次，逐字比较 `id` 与 `realPath` → `confirmName` → `digest` → 用计划里的 `identity` 重新扫描并重算指纹 → `store.acquire`（失败 `conflict`）→ `applyCleanup` → `finally release + invalidate`。
  - 失败统一返回带 `status/errorKind/error` 的形状；`plan()` 失败时 `ok:false`、其余字段给空值。
- `operations/workspace-cleanup.ts`：`workspaceCleanupOperations(host)` 构造一次 service（模块级每次装配一份），两条 handler；`readRequest` 只接受 `planId/digest/confirmName` 字符串与 `deleteSessionLogs` 布尔。
- `register.ts`：spread 新操作表；`ported.done` 加 `'workspace-cleanup-plan'`、`'workspace-cleanup-apply'`。
- `types-export.ts` 的 `CoreDeps` 加 `closeWorkspaceStores?: (workspacePath: string) => Promise<void>`。
- `host/apply.ts`：传入 `closeWorkspaceStores: (path) => workflow.closeWorkspaceStores(path)`。
- `valuation-workflow/host.ts`：实现 `closeWorkspaceStores(workspacePath)`（调用导出的 `closeStoresUnder`）并加入返回对象；`dispose` 仍负责全量关闭。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/host/workspace-cleanup-service.test.mjs tests/unit/host/workspace-cleanup-close-stores.test.mjs tests/unit/host/host-package.test.mjs`
Expected: PASS（`host-package` 的「声明跟着实现走」通过）。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 9: 客户端模型、API 与文案

**Files:**
- Create: `src/client/modules/environment/model/workspace-cleanup.ts`
- Modify: `src/client/modules/environment/api.ts`
- Modify: `src/client/locales/zh-CN.ts`
- Test: `tests/unit/client/client-workspace-cleanup-model.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceCleanupPlan`、`WorkspaceCleanupResult`、`LocalAccessConsentView`、`rpc`。
- Produces:

```ts
export type CleanupPhase = 'closed' | 'scanning' | 'ready' | 'applying' | 'done' | 'error'
export interface CleanupViewState {
  phase: CleanupPhase
  plan: WorkspaceCleanupPlan | null
  result: WorkspaceCleanupResult | null
  error: string
  confirmName: string
  deleteSessionLogs: boolean
  startedAt: number
}
export function initialCleanupState(): CleanupViewState
export function cleanupBlockedReason(input: {
  chosen: boolean; missing: boolean; busy: boolean
  consent: LocalAccessConsentView
  /** 客户端与宿主的权限说明版本不一致（旧宿主）。 */
  schemaMismatch: boolean
}): string
export function canApply(state: CleanupViewState): boolean
export function cleanupIsEmpty(plan: WorkspaceCleanupPlan | null): boolean
export function cleanupSummary(plan: WorkspaceCleanupPlan): string
export function cleanupResultSummary(result: WorkspaceCleanupResult): string
export interface WorkspaceCleanupController {
  get(): CleanupViewState
  subscribe(listener: () => void): () => void
  open(): void
  close(): void
  rescan(): Promise<void>
  apply(): Promise<void>
  setConfirmName(value: string): void
  setDeleteSessionLogs(value: boolean): void
}
export function createWorkspaceCleanupController(options?: {
  api?: {
    plan(): Promise<WorkspaceCleanupPlan>
    apply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult>
  }
  now?: () => number
  /** 执行结束后通知页面刷新（环境快照与审核页历史）。 */
  onSettled?: (result: WorkspaceCleanupResult) => void
}): WorkspaceCleanupController
// environment/api.ts
export const environmentApi: { /* 原方法 */ workspaceCleanupPlan(): Promise<WorkspaceCleanupPlan>; workspaceCleanupApply(request: WorkspaceCleanupRequest): Promise<WorkspaceCleanupResult> }
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/client/client-workspace-cleanup-model.test.mjs
const {
  initialCleanupState, canApply, cleanupBlockedReason, cleanupIsEmpty, createWorkspaceCleanupController,
} = await import(new URL('src/client/modules/environment/model/workspace-cleanup.ts', ROOT).href)

const plan = (overrides = {}) => ({
  ok: true, error: '', errorKind: '', planId: 'p', digest: 'd', expiresAt: 1,
  workspace: { path: '/w', name: 'w', id: 'w1' },
  entries: [{ name: 'a', kind: 'directory', sizeBytes: 1 }], entriesTruncated: 0,
  sessions: [], totals: { folders: 1, files: 0, symlinks: 0, other: 0, bytes: 1,
    bytesComplete: true, sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0 },
  notes: [], ...overrides,
})

test('输入目录名逐字匹配才允许执行', () => {
  const ready = { ...initialCleanupState(), phase: 'ready', plan: plan() }
  assert.equal(canApply({ ...ready, confirmName: 'w' }), true)
  assert.equal(canApply({ ...ready, confirmName: 'w ' }), true)
  assert.equal(canApply({ ...ready, confirmName: 'W' }), false)
  assert.equal(canApply({ ...ready, confirmName: '' }), false)
})

test('空工作空间不允许执行', () => {
  assert.equal(cleanupIsEmpty(plan({
    entries: [], totals: { ...plan().totals, folders: 0, files: 0, bytes: 0 },
  })), true)
})

test('未授权时给出指向账号连接的原因', () => {
  const reason = cleanupBlockedReason({
    chosen: true, missing: false, busy: false, schemaMismatch: false,
    consent: { state: 'missing', schemaVersion: 0, requiredSchemaVersion: 2,
      grantedAt: '', capabilities: [], reason: '' },
  })
  assert.match(reason, /账号连接|允许/)
})

test('旧宿主（权限说明版本不一致）直接给重启原因', () => {
  const reason = cleanupBlockedReason({
    chosen: true, missing: false, busy: false, schemaMismatch: true,
    consent: { state: 'granted', schemaVersion: 2, requiredSchemaVersion: 2,
      grantedAt: '', capabilities: ['workspace-cleanup'], reason: '' },
  })
  assert.match(reason, /重新打开|重启/)
})

test('控制器：扫描成功进入 ready，apply 带指纹与目录名', async () => {
  const applied = []
  const controller = createWorkspaceCleanupController({
    now: () => 10,
    api: {
      plan: async () => plan(),
      apply: async (request) => { applied.push(request); return {
        ok: true, status: 'completed', error: '', errorKind: '',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 1, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [],
      } },
    },
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.deepEqual(applied, [{ planId: 'p', digest: 'd', confirmName: 'w', deleteSessionLogs: false }])
  assert.equal(controller.get().phase, 'done')
})

test('执行结束后调用 onSettled（页面据此刷新环境与审核历史）', async () => {
  const settled = []
  const controller = createWorkspaceCleanupController({
    api: {
      plan: async () => plan(),
      apply: async () => ({ ok: true, status: 'completed', error: '', errorKind: '',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 1, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [] }),
    },
    onSettled: (result) => settled.push(result.status),
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.deepEqual(settled, ['completed'])
})

test('apply 返回 input（清单已变）时自动重扫', async () => {
  let scans = 0
  const controller = createWorkspaceCleanupController({
    api: {
      plan: async () => { scans += 1; return plan() },
      apply: async () => ({
        ok: false, status: 'failed', error: '清单已变化', errorKind: 'input',
        archivedSessionIds: [], deletedSessionLogs: [], skippedSessionLogs: [],
        deleted: { folders: 0, files: 0, symlinks: 0, other: 0 }, failures: [],
        remaining: 0, remainingNames: [], stuckSessionIds: [], notes: [],
      }),
    },
  })
  await controller.rescan()
  controller.setConfirmName('w')
  await controller.apply()
  assert.equal(scans, 2)
  assert.equal(controller.get().phase, 'ready')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/client/client-workspace-cleanup-model.test.mjs`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现模型、控制器与 API**

- 纯函数按 Interfaces；`canApply` 要求 `phase === 'ready'`、`plan.ok`、未命中空计划、`confirmName.trim() === plan.workspace.name`。
- 控制器用 `subscribe/get` 快照（照 `createEnvStatusStore` 的写法）；`rescan` 置 `scanning` 再调 API；失败置 `error`；`apply` 不允许重入（`phase === 'applying'` 直接返回），结果置 `done` 并调用 `onSettled(result)`；`apply` 收到 `errorKind === 'input'`（清单已变）时自动 `rescan()` 回到 `ready`。
- `environment/api.ts` 加两个方法，走现有 `call()`。
- `zh-CN.ts` 补错字键：`wsCleanupOpen`、`wsCleanupTitle`、`wsCleanupIrreversible`、`wsCleanupFolders`、`wsCleanupFiles`、`wsCleanupSize`、`wsCleanupSizeAtLeast`、`wsCleanupSessions`、`wsCleanupTopLevel`、`wsCleanupSubagent`、`wsCleanupRunning`、`wsCleanupStopWarn`、`wsCleanupDeleteLogs`、`wsCleanupDeleteLogsHint`、`wsCleanupKeepTitle`、`wsCleanupKeep`、`wsCleanupLimitsTitle`、`wsCleanupLimitArchived`、`wsCleanupLimitHistory`、`wsCleanupConfirmHint`、`wsCleanupCancel`、`wsCleanupApply`、`wsCleanupApplying`、`wsCleanupElapsed`、`wsCleanupStages`、`wsCleanupDone`、`wsCleanupPartial`、`wsCleanupAborted`、`wsCleanupFailed`、`wsCleanupRetry`、`wsCleanupRemaining`、`wsCleanupEmpty`、`wsCleanupBlocked`、`envConsentCapCleanup`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/client/client-workspace-cleanup-model.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 10: 弹窗、工作空间卡片入口与页面接线

**Files:**
- Create: `src/client/modules/environment/ui/WorkspaceCleanupDialog.tsx`
- Modify: `src/client/shell/WorkspaceCard.tsx`
- Modify: `src/client/modules/environment/ui/EnvironmentPane.tsx`
- Modify: `src/client/shell/WorkbenchPanel.tsx`
- Modify: `src/client/apply.ts`
- Modify: `src/client/shell/consts.ts`（新增类名）
- Modify: `src/client/modules/environment/styles/pane.ts`
- Test: `tests/unit/client/client-workspace-cleanup-dialog.test.mjs`
- Test: `tests/unit/client/client-audit-workspace-polish.test.mjs`（若断言 WorkspaceCard 渲染形状，按新入口更新）

**Interfaces:**
- Consumes: `WorkspaceCleanupController`、`CleanupViewState`、`cleanupBlockedReason`、`canApply`、`cleanupIsEmpty`；`WorkspaceCard` 现有 props。
- Produces:
  - `WorkspaceCard` 新增可选 `cleanup?: { allowed: boolean; reason: string; onOpen: () => void }`
  - `WorkspaceCleanupDialogProps`：

```ts
export interface WorkspaceCleanupDialogProps {
  state: CleanupViewState
  now?: () => number
  onConfirmName(value: string): void
  onToggleDeleteSessionLogs(value: boolean): void
  onApply(): void
  onRescan(): void
  onClose(): void
}
```

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/client/client-workspace-cleanup-dialog.test.mjs
import { fakeReact, registerTsxLoader } from '../../helpers/tsx-loader.mjs'
registerTsxLoader()
const { WorkspaceCleanupDialog } = await import(
  new URL('src/client/modules/environment/ui/WorkspaceCleanupDialog.tsx', ROOT).href)

// 与 client-local-access.test.mjs 相同的 fakeReact 展开器；额外复用其 findButtonLike。
const React = fakeReact
function resolve(node) { /* 同 client-local-access.test.mjs */ }
function render(component, props) { globalThis.__crwuTestInstance = { cursor: 0, state: {}, refs: {}, effects: [] }; return resolve(component(props)) }
function textOf(node) { /* 同 client-local-access.test.mjs */ }
function findButtonLike(node, label) { /* 同 client-local-access.test.mjs */ }

function readyState() {
  return {
    phase: 'ready', plan: {
      ok: true, error: '', errorKind: '', planId: 'p', digest: 'd', expiresAt: 1,
      workspace: { path: '/w/中瑞世联工作空间', name: '中瑞世联工作空间', id: 'w1' },
      entries: [{ name: '2026-1', kind: 'directory', sizeBytes: 1 }], entriesTruncated: 0,
      sessions: [], totals: { folders: 94, files: 1, symlinks: 0, other: 0, bytes: 1,
        bytesComplete: true, sessions: 0, topLevelSessions: 0, subagentSessions: 0, runningSessions: 0 },
      notes: [],
    },
    result: null, error: '', confirmName: '', deleteSessionLogs: false, startedAt: 0,
  }
}

test('ready 态展示数量、不可逆与输入提示', () => {
  const tree = render(WorkspaceCleanupDialog, {
    state: { ...readyState(), confirmName: '' }, onConfirmName() {}, onToggleDeleteSessionLogs() {},
    onApply() {}, onRescan() {}, onClose() {},
  })
  const text = textOf(tree)
  assert.match(text, /94 个文件夹/)
  assert.match(text, /不可逆/)
  assert.match(text, /请输入目录名/)
})

test('输入目录名后执行按钮才可用', () => {
  const empty = findButtonLike(render(WorkspaceCleanupDialog, {
    state: { ...readyState(), confirmName: '' }, onConfirmName() {}, onToggleDeleteSessionLogs() {},
    onApply() {}, onRescan() {}, onClose() {},
  }), '清空工作空间')
  assert.equal(empty.props.disabled, true)
  const filled = findButtonLike(render(WorkspaceCleanupDialog, {
    state: { ...readyState(), confirmName: '中瑞世联工作空间' }, onConfirmName() {},
    onToggleDeleteSessionLogs() {}, onApply() {}, onRescan() {}, onClose() {},
  }), '清空工作空间')
  assert.equal(filled.props.disabled, false)
  assert.match(textOf(render(WorkspaceCleanupDialog, {
    state: { ...readyState(), confirmName: '中瑞世联工作空间' }, onConfirmName() {},
    onToggleDeleteSessionLogs() {}, onApply() {}, onRescan() {}, onClose() {},
  })), /彻底删除会话日志/)
})

test('applying 态显示已用时且不给取消入口', () => {
  const tree = render(WorkspaceCleanupDialog, {
    state: { ...readyState(), phase: 'applying', startedAt: 1_000 }, now: () => 4_000,
    onConfirmName() {}, onToggleDeleteSessionLogs() {}, onApply() {}, onRescan() {}, onClose() {},
  })
  assert.match(textOf(tree), /已用时 3 秒/)
  assert.equal(findButtonLike(tree, '取消'), null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/unit/client/client-workspace-cleanup-dialog.test.mjs`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现界面与接线**

- `WorkspaceCleanupDialog` 复用现有 `C.aiDialogBackdrop` / `C.aiDialog` 结构与样式；内容按 spec §10.2：
  数量、可滚动明细、`entriesTruncated`、会话分段、运行中提示（含「如果其中包含你正在使用的会话」）、
  删除日志勾选、不受影响项、两条限制、输入框、取消/清空按钮。
- `applying` 禁用关闭与 Esc；`done` 展示结果与失败清单、`remaining > 0` 提示、重新扫描/关闭。
- `WorkspaceCard`：摘要行与展开态各加危险色小按钮；禁用时显示 `reason`（`cleanup.allowed === false`）。
- `EnvironmentPane`：新增 `cleanup?: WorkspaceCleanupController` prop；`cleanup` 视图由 `cleanupBlockedReason({ chosen, missing, busy, consent, schemaMismatch: props.authSchemaMismatch === true })` 算出；渲染 `WorkspaceCleanupDialog`。
- `WorkbenchPanel`：新增 `cleanup?: WorkspaceCleanupController` prop，透传给环境页。
- `apply.ts`：`const cleanup = createWorkspaceCleanupController({ onSettled: () => { void envStatus.refresh() } })`；传给 `WorkbenchPanel`。
- 新样式类加在 `shell/consts.ts` 与 `styles/pane.ts`；文案全部走 `zhCN`，不硬编码中文。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/unit/client/client-workspace-cleanup-dialog.test.mjs tests/unit/client/client-audit-workspace-polish.test.mjs tests/unit/client/client-package.test.mjs`
Expected: PASS。

- [ ] **Step 5: 检查点**

Run: `npm run typecheck && git diff --check`

---

### Task 11: 文档、版本与最终验证

**Files:**
- Modify: `plugins/dsh-crwu-workbench/CHANGELOG.md`
- Modify: `plugins/dsh-crwu-workbench/README.md`
- Modify: `plugins/dsh-crwu-workbench/README.en.md`
- Modify: `plugins/dsh-crwu-workbench/docs/development-notes.md`
- Modify: `plugins/dsh-crwu-workbench/VERSION`（由脚本改）
- Modify: `plugins/dsh-crwu-workbench/package.json`（由脚本改）
- Modify: `plugins/dsh-crwu-workbench/package-lock.json`（由脚本改）
- Modify: `plugins/dsh-crwu-workbench/src/host/consts.ts`（由脚本改）

**Interfaces:**
- Consumes: 全部实现。
- Produces: 0.0.50 的可交付说明与版本一致性。

- [ ] **Step 1: 写 CHANGELOG 条目**

按现有格式加 `## package · 0.0.50 · 2026-10-20 · feat · 工作空间清理（清空）`，至少写清：

- 入口与两步确认（清单 + 输入目录名）；
- 整盘清空 + 保留根目录与选择；
- 运行中会话自动停止并归档；日志物理删除是可选、且不是 DSH 支持的路径；
- 已归档会话不可枚举、删完可能需重启；
- 审核历史一并清空；
- 协议 49、授权 schema 2（需重新授权一次）、新操作 `system.workspace-cleanup`。

- [ ] **Step 2: 更新 README 与开发笔记**

- 中英文 README 的「环境信息页」那一行补清理入口（保持两文结构等价）。
- `docs/development-notes.md` 新增「清空工作空间」小节：两条限制、指纹口径（不含大小/运行状态）、
  会话必须先归档再删日志、`.crwu` 前先关 sqlite。

- [ ] **Step 3: 版本同步**

Run: `node scripts/sync-version.mjs 0.0.50`
Expected: `package.json` / `VERSION` / `src/host/consts.ts` / lockfile 根版本都变 0.0.50。

- [ ] **Step 4: 跑仓库门禁**

Run（在 `plugins/dsh-crwu-workbench/`）: `npm run check`
Expected: 全绿（版本 / 配置 / 技能 / 类型 / 测试 / 构建 / smoke）。

Run（仓库根）: `make plugin-check && make docs-check`
Expected: 全绿。

- [ ] **Step 5: 真机验收（只在临时目录）**

- 造 `/tmp/crwu-cleanup-fixture`（Windows 用 `%TEMP%`）：两个目录、一个文件、一个指向外部目录的符号链接、
  一条该目录下的 DSH 会话；
- 点入口 → 核对清单 → 输入目录名 → 执行；
- 断言：目录本身还在、子项清空、符号链接目标完好、会话已归档、审核页历史为空；
- macOS 与 Windows 各跑一次，把平台、步骤与结果写进变更说明；**不在真实工作空间上验收**。

- [ ] **Step 6: 最终检查点**

Run: `git status --short && git diff --check`
Expected: 无遗漏文件、无空白错误；不提交。

---

## 计划自检

- **Spec 覆盖**：§2 决策 → 任务 1/6/7/10；§5 契约 → 1；§6 流程 → 5/7/8；§7 扫描 → 2/3/4；§8 执行 → 6/7/8；§9 安全 → 2/5/6/7；§10 界面 → 9/10；§11 接口 → 1/8/9；§12 结果 → 7；§13 测试 → 每个任务；§14 文档 → 11。
- **类型一致**：`WorkspaceIdentity`（2）→ `CleanupPlan`（5）→ `applyCleanup`（7）→ 服务（8）→ 客户端（9）逐级复用；`CleanupSessionPort` 在 4 定义、6/7/8 使用。
- **Review Focus**：五类风险分别在任务 2（符号链接）、5（指纹/单次）、7（失败与剩余）、8（冲突）、10（中断后重扫）有测试。
- **未包含**：真实工作空间验收、自动提交、任何 DSH 代码改动。
