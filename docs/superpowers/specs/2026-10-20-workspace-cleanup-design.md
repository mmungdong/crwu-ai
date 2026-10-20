# 工作空间清理（清空）设计

- 日期：2026-10-20
- 作用域：`plugins/dsh-crwu-workbench`
- 目标版本：插件 0.0.50 · 线协议 49 · 授权收据 schema 2
- 状态：设计已确认，待写实现计划

## 1. 背景与目标

环境信息页的「工作空间」目前只有选择 / 更换 / 恢复自动识别，没有反向操作：员工交付完一批报告后，
工作空间里会堆着几十个案例目录和一批会话，只能手工去 Finder / 资源管理器里删。手工删有两个问题：
不知道哪些属于这一轮、也不知道删完 DSH 里会留下什么。

本设计新增一个**不可逆的清空**入口：

- 位置：环境信息页 → 工作空间区域（摘要行与展开卡片各一处）。
- 点击后先做一次真实扫描，把**要删什么、影响多少、哪些不受影响**逐项列出。
- 输入工作空间目录名后才能真正执行。
- 执行范围：工作空间根目录下的**全部直接子项**（目录与文件），以及归属该工作空间的 DSH 会话。
- 工作空间目录本身保留，选择状态保留，插件下次仍把产物写到这个已经空掉的目录。

## 2. 已确认的决策

| # | 决策 | 取值 | 来源 |
|---|---|---|---|
| D1 | 删除范围 | **整盘清空**：根下全部目录与文件；保留根目录本身 | 用户选择 |
| D2 | 会话处置 | 默认归档；可选「同时彻底删除会话日志」 | 用户选择 |
| D3 | 运行中会话 | **自动停止并归档**，然后继续删除；停不下来则在动文件前中止 | 用户修正 |
| D4 | 确认强度 | 弹窗清单 + **逐字输入目录名** | 用户选择 |
| D5 | 插件历史 | 一并清空 `audits` / `auditRoot` | 用户选择 |
| D6 | 删除引擎 | Host 内 `node:fs`（可注入 IO），不经 shell | 用户选择 |
| D7 | 授权 | 新增能力 `workspace-cleanup`，收据 schema 1 → 2 | 用户确认 |

## 3. 术语与不变量

- **W**：当前在环境信息里选定的工作空间目录（Host `WorkbenchState.workspacePath`）。
  W 由 Host 从状态读取，**不接受客户端提交路径**。
- **可删子项**：W 的直接子项（一层），不含 W 自身，不递归下钻判断归属。
- **归属会话**：`session/list` 返回的、`cwd` 落在 W 之内（含相等）的会话；子代理会话同属。
- **计划（plan）**：一次扫描产出的不可变清单 + 指纹，内存保存 5 分钟、单次使用。

必须始终成立：

1. 删除动作只发生在 W 的直接子项上，以及本设计第 8 节列出的会话日志路径上。
2. 没有一份**与用户确认时完全一致**的计划，就不删任何东西。
3. 任何一步失败都不扩大删除范围；失败项如实回报，不重试、不掩盖。
4. 清理不会改变工作空间选择，也不会删除授权收据与凭据。

## 4. 平台能力与限制（设计依据）

以下事实来自当前 DSH 宿主 API，不是假设：

| 能力 | 事实 | 对设计的影响 |
|---|---|---|
| 会话列表 | `sessionController.list()` 返回 `sessionId / cwd / running / agentAvailable / parentSessionId / origin / updatedAt` | 能按 `cwd` 精确圈出归属会话，并判断是否在运行 |
| 会话归档 | `workspaceController.archiveSession({ sessionId, stopActivity? })`，停止该轮与子代理后从工作区分组隐藏 | D3 用它“先停再归档” |
| 会话删除 | **不存在**：`sessionController` 无 `delete`/`close`；`workspace/delete` 明确保留文件与会话；会话存储层文档写明无删除接口 | D2 的“彻底删除”只能由插件直接处理日志文件，属未支持路径，必须如实告知 |
| 会话日志位置 | `~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`（+ `session.lock`） | 物理删除按 **sessionId 精确匹配目录**，不自行推导 slug |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/session-<id>.json` | 物理删除时一并清理 |
| 工作区注册 | `workspace/delete` 只注销工作区，保留文件夹与会话 | **不使用**；清理后仍保留注册与选择 |
| 估值工作流状态 | `<W>/.crwu/workflows.sqlite`，由 `node:sqlite` 打开并缓存连接 | 删 `.crwu` 前必须先关闭该工作空间的连接，否则 Windows 上文件被占用 |
| 宿主文件 API | `ctx.fs` 有 `stat/lstat/readdir/resolve/contains`，**没有删除** | 删除走 `node:fs`，路径校验自己兜住 |

## 5. 数据契约

新增 `src/shared/contracts/workspace-cleanup.ts`：

```ts
/** 明细回给界面的展示上限；Host 计划内部保留完整清单。 */
export const WORKSPACE_CLEANUP_ENTRY_LIMIT = 500

export type WorkspaceCleanupErrorKind =
  | '' | 'input' | 'policy' | 'capability-gap' | 'infrastructure' | 'conflict'

export type WorkspaceCleanupEntryKind = 'directory' | 'file' | 'symlink' | 'other'

export interface WorkspaceCleanupEntry {
  name: string
  kind: WorkspaceCleanupEntryKind
  /** 递归大小（目录）；符号链接与其它类型为 0。 */
  sizeBytes: number
}

export interface WorkspaceCleanupSession {
  sessionId: string
  title: string
  running: boolean
  agentAvailable: boolean
  /** 空串 = 顶层会话；非空 = 子代理。 */
  parentSessionId: string
  updatedAt: number
}

export interface WorkspaceCleanupTotals {
  folders: number
  files: number
  symlinks: number
  other: number
  bytes: number
  /** false = 递归大小超出扫描预算，`bytes` 只是已统计部分。 */
  bytesComplete: boolean
  sessions: number
  topLevelSessions: number
  subagentSessions: number
  runningSessions: number
}

export interface WorkspaceCleanupPlan {
  ok: boolean
  error: string
  errorKind: WorkspaceCleanupErrorKind
  planId: string
  digest: string
  expiresAt: number
  /** `name` = W 的末段目录名，也是确认框要求逐字输入的那一段。 */
  workspace: { path: string; name: string; id: string }
  /**
   * **只用于界面展示**，最多 500 项。
   * Host 的计划内部保留完整清单，删除以 Host 计划为准，客户端拿到的截断不影响执行。
   */
  entries: WorkspaceCleanupEntry[]
  /** 被截掉的项数（计数与指纹都覆盖完整清单）。 */
  entriesTruncated: number
  sessions: WorkspaceCleanupSession[]
  totals: WorkspaceCleanupTotals
  /** 必须展示给用户的限制说明（已归档会话不可枚举等）。 */
  notes: string[]
}

export interface WorkspaceCleanupRequest {
  planId: string
  digest: string
  /** 逐字等于 `workspace.name`（仅去掉首尾空白）。 */
  confirmName: string
  /** 缺省 false：只归档。 */
  deleteSessionLogs: boolean
}

export interface WorkspaceCleanupFailure {
  name: string
  kind: 'entry' | 'session-archive' | 'session-log' | 'workflow-store' | 'state'
  reason: string
}

export interface WorkspaceCleanupResult {
  ok: boolean
  status: 'completed' | 'partial' | 'aborted' | 'failed'
  error: string
  errorKind: WorkspaceCleanupErrorKind
  archivedSessionIds: string[]
  deletedSessionLogs: string[]
  skippedSessionLogs: { sessionId: string; reason: string }[]
  deleted: { folders: number; files: number; symlinks: number; other: number }
  failures: WorkspaceCleanupFailure[]
  /** 执行结束后 W 下剩余的直接子项数（正常应为 0）。 */
  remaining: number
  /** 剩余项名字，最多回 50 个；`remaining` 是完整计数。 */
  remainingNames: string[]
  /** 中止时未能停下的会话；此时未删除任何子项。 */
  stuckSessionIds: string[]
  notes: string[]
}
```

契约同时登记到 `src/shared/wire/index.ts`（`workspace-cleanup` 命名空间），客户端与 Host 共用同一份类型。

## 6. 流程

```
点「清理工作空间…」
  │
  ├─① workspace-cleanup-plan （只读）
  │   校验工作空间与授权 → 扫描 W 直接子项 → 枚举归属会话
  │   → 生成 planId + digest，内存保存 5 分钟、单次有效
  │
  ├─② 前端确认弹窗
  │   数量 / 明细 / 会话 / 不受影响项 / 限制说明 / 输入目录名
  │
  └─③ workspace-cleanup-apply
      a. 取 plan（不存在 / 过期 / 已用 → conflict）
      b. 校验 confirmName、digest、授权
      c. **重新扫描并重算 digest**；不一致 → input，零删除
      d. 标记计划已用 + 加单实例锁
      e. 归档会话（运行中的带 stopActivity）
      f. 等待会话静止（≤30s）；有未静止 → aborted，零文件删除
      g. 关闭该工作空间的估值工作流存储连接
      h. （勾选时）物理删除会话日志与投影缓存
      i. 逐个删除计划内的 W 直接子项
      j. 清空插件审核历史并落盘
      k. 回读 W：存在、剩余子项数
      l. 作废环境快照、释放锁、返回结果
```

扫描与执行是**两次独立调用**：确认框展示的永远是第一次扫描的结果，执行时以第二次扫描做一致性校验。

## 7. 扫描

### 7.1 工作空间解析与边界校验

1. 用 `resolveSelectedWorkspace(ctx, state)` 解析（与审核、估值同一条口径）。
   失败（未选定 / 目录丢失 / 未登记 / 不是目录）→ `input`，界面禁用按钮并给同一句原因。
2. 校验 W：
   - 绝对路径、存在、`stat` 为目录；
   - `realpath(W)` 成功；身份比较与黑名单一律用规范路径，展示用原路径；
   - **删除也用规范路径**：计划里保存 `realPath`，执行阶段只对 `realPath` 的直接子项动手，
     避免扫描后把 W 换成另一个符号链接指向；
   - 拒绝文件系统根（POSIX `/`、Windows 盘符根、UNC 共享根）；
   - 拒绝 `W === home`、`W` 是 `home` 的祖先、`W` 是 DSH 主目录（`~/.dsh`）的祖先或相等；
   - 拒绝 `W` 是插件状态文件 `~/.dsh/crwu-workbench.json` 的祖先。
3. 拒绝时返回 `input` + 一条指明触发哪条规则的文案，不产生计划。
4. W 下**一个子项都没有、也没有归属会话**时：扫描照常成功（计划里数量为 0），
   弹窗显示「这个工作空间已经是空的」并禁用执行按钮 —— 不把它做成 `input` 错误，
   否则界面只能弹一句误导人的“失败”。

### 7.2 直接子项

- `readdir(W, { withFileTypes: true })`，逐项 `lstat` 判定类型：
  `isDirectory → directory`、`isFile → file`、`isSymbolicLink → symlink`、其余 `other`。
- 大小：文件取 `size`；目录递归累加，预算 **50,000 项**（只按条目数、不按时间，保证两次扫描同口径），
  超出则停止并令 `bytesComplete=false`（界面显示「≥ X」）。符号链接不跟随、不统计目标大小。
- 明细按名字排序，回前 500 项；`entriesTruncated` 记录剩余数。**计数、指纹与删除清单都基于完整列表**：
  完整清单留在 Host 的内存计划里，客户端拿到的 `entries` 只是展示切片。
- `mtimeMs` 只随扫描结果返回给 Host 内部，**不进指纹**：目录 mtime 会因子目录内部写入而变。

### 7.3 归属会话

- 调 `sessionController.list()`，按 `cursor` 翻页直到没有下一页（总上限 5,000 条，超出则
  `capability-gap`，避免一次扫描拖死页面）。
- 过滤：`cwd !== ''` 且 `isLocalPathUnder(cwd, W)`。
  `isLocalPathUnder` 已按路径风格处理分隔符与 Windows 大小写，`/work` 不会命中 `/work2`。
- 每条的标题取 `projections.values.title`，空则显示会话 id 前 8 位（界面负责截断）。
- `notes` 固定包含：
  - 「已归档、不在会话列表里的旧会话无法枚举，其日志可能残留（不会出现在侧栏）。」
  - 「物理删除会话日志不是 DSH 支持的路径；删完后侧栏可能要在重启 DSH 后才彻底消失。」

### 7.4 阻断项

运行中的会话**不阻断**（D3）。以下情况让扫描返回 `ok:false`：

| 情况 | errorKind | 文案方向 |
|---|---|---|
| 工作空间不可用 | `input` | 与工作空间卡片同一句原因 |
| 未授予 `workspace-cleanup` | `policy` | 指向「账号连接」重新允许 |
| 缺少 `sessionController.list` / `workspaceController.archiveSession` | `capability-gap` | 宿主版本不支持安全清理，请升级 DSH |
| 会话列表调用失败或超过 5,000 条 | `infrastructure` / `capability-gap` | 无法安全枚举归属会话，不生成计划 |

缺少归档能力时必须阻断：没有归档就删文件，会让会话指向一个已经不存在的目录。

### 7.5 指纹

```
digest = sha256(canonicalJson({
  v: 1,
  workspace: canonical(W),
  entries: [{ name, kind }] 按 name 排序,
  sessions: [sessionId] 按 sessionId 排序,
}))
```

指纹覆盖的是**“会删哪些顶层项、哪些会话”**这一集合。两个刻意的取舍：

- **不含 `sizeBytes`**：目录大小的统计受预算影响，把它放进指纹会让“什么都没变”也偶发拒绝。
  大小只用于展示。
- **不含 `running` / `agentAvailable`**：这两个是扫描时刻的事实，用户犹豫几秒就可能变。
  它们不改变删除集合；执行时以**当时的实时列表**决定是否带 `stopActivity`（见 8.2）。

目录内部文件变化不改变指纹——计数口径本来就是顶层项，所以“确认框说 94 个文件夹”在执行时仍然成立。
这一点写进实现注释，避免后来者误以为指纹能发现任意深度的变化。

## 8. 执行

### 8.1 前置校验（顺序不可换）

1. planId 命中内存计划；未命中 / 过期 / 已用 → `conflict`，文案区分三种原因。
2. **当前选定的工作空间必须仍是计划里那一个**：重新解析选中的工作空间，`id` 与规范路径都要与计划相等；
   不等 → `conflict`（用户在确认框开着时换了工作空间，不能拿旧计划删新目录）。
3. `confirmName.trim() === workspace.name`；不等 → `input`（前端已经卡一次，这是第二道）。
4. `digest === plan.digest`（客户端回传值），否则 `input`。
5. 重新扫描并重算指纹；与计划不一致 → `input`，**零删除**；界面收到后自动再扫一次，让用户重看。
6. 再判一次授权（扫描后可能被撤销）→ `policy`。
7. 置锁；已有一份在执行 → `conflict`。

### 8.2 会话：先停、再归档

- 对每条**顶层**计划会话调用：

  ```
  archiveSession({ sessionId, stopActivity: running || agentAvailable })
  ```

  `running` / `agentAvailable` 取**执行时**的实时列表（不是扫描快照，见 7.5）。
  实时列表里找不到该会话时按 `stopActivity: false` 归档。

  归档失败（抛错或返回里缺少该 id）→ **立即中止**：返回 `status: 'aborted'`、
  `failures(kind: 'session-archive')`、`stuckSessionIds`，**不删任何文件与会话日志**。
  理由：归档是“先停再删”的前提；归档没成功就删 cwd，会留下一条指向空目录的活会话。
- 子代理会话不单独归档（父会话归档后自然消失），只计入统计。
- 等待：每 250ms 重新 `list()`，直到计划内所有会话都满足 `running === false`，
  或不在列表里（视为已静止）；上限 30 秒。
  **不要求 `agentAvailable === false`**：归档只隐藏会话，不会销毁仍 attached 的 Agent；
  把它当静止条件会让每次清理都超时中止（现场：审核根 agent 空闲但仍 attached）。
  会话已归档 + 没有正在跑的活，就足以保证没有代码再往 W 里写。
- `list()` 抛错 → 中止（同上，`infrastructure`），不猜“应该都停了”。
- **超时仍未静止**：返回 `status: 'aborted'`、`stuckSessionIds`、`ok: false`，
  此时只完成过归档，**没有删除任何文件与会话日志**。文案要求员工重启 DSH 后重试。

### 8.3 会话日志（仅 `deleteSessionLogs: true`）

- 会话根：`<home>/.dsh/sessions`；投影缓存：`<home>/.dsh/storages/session_projcache/sessions`。
- 对每条计划会话（含子代理）：
  1. 遍历会话根的**一级目录**（cwd slug），检查 `<slug>/<sessionId>` 是否存在且为目录；
  2. 命中恰好 1 个 → `rm -r` 该目录，记入 `deletedSessionLogs`；
  3. 命中 0 个 → 记入 `skippedSessionLogs`，原因「日志已不存在」；
  4. 命中 >1 个 → **不删**，记入 `skippedSessionLogs`，原因「会话 id 命中多个目录，拒绝猜测」。
  5. 投影缓存文件 `session-<id>.json` 存在则删除；失败记 `failures(kind: 'session-log')`。
- `session.lock` 随会话目录一起删除；不单独解锁。

### 8.4 删除 W 的直接子项

- 顺序按计划里的名字排序，逐个处理（用 Host 计划里的**完整清单**，不是客户端那份展示切片）：
  - 删除前再 `lstat` 一次，确认仍是 W 的直接子项（`dirname` 逐字相等）；不成立记失败、跳过。
  - 目录 / 普通文件 → `rm(path, { recursive: true, force: false })`；
  - 符号链接 → `unlink(path)`（**永不**跟随到目标）；
  - 其它类型 → 跳过并记失败（不猜它是什么）。
- 单条失败不影响后续；`deleted` 按实际成功数累加。
- 计划之外新出现的项**不删**；执行结束回读 W，`remaining` 与 `remainingNames` 如实返回。

### 8.5 估值工作流存储

- 删除前调用估值工作流宿主的 `closeWorkspaceStores(workspacePath)`：
  在 `src/host/integrations/valuation-workflow/host.ts` 的返回对象上新增该方法，
  关闭 `sessions` 里 store 路径落在 W 之下的连接、从 `sessions` / `opened` 中移除。
- 关闭失败不阻断清理，但 `.crwu` 的删除结果会如实记为失败（Windows 上表现为文件被占用）。
- 清理用的 Host 依赖里传入这个函数（缺省为 no-op，便于单测）。

### 8.6 插件状态

- `state.audits = {}`、`state.activeKey = ''`、`state.activeChildId = ''`、
  `state.auditRoot` 重置为空结构。
- 通过 `persistAudits()` 落盘；写盘失败记 `failures(kind: 'state')`，按第 12 节判成 `partial`
  （不会因为“文件都删掉了”就报 `completed`）。
- **不动**：工作空间路径 / 标题 / id / 来源、本机访问授权收据、凭据文件。

### 8.7 收尾

- `gate.invalidate()`；客户端成功后刷新 `env` 与模块状态（报告审核页随之清空）。
- 释放锁；计划标记已用，二次提交同一 planId 返回 `conflict`。

## 9. 安全模型

| 风险 | 措施 | 测试 |
|---|---|---|
| 删错目录（根 / 主目录 / `.dsh`） | 黑名单 + 规范路径比较 | 5 组反例 |
| 客户端提交任意路径 | 路径只来自 Host 状态 | 契约测试：请求体无路径字段 |
| 扫描后内容被改 | 双扫描 + 指纹校验 | 改动一项后 apply 必拒 |
| 符号链接逃逸 | 只 `unlink` 链接，不 `realpath` 子项 | 链接指向 W 外目录，目标必须完好 |
| 删到兄弟工作空间 | 只处理 W 的直接子项 | `/work` 与 `/work2` 相邻 |
| 同一时刻两份清理 | 单实例锁 + 计划单次使用 | 并发第二次 → `conflict` |
| 活 Agent 的 cwd 被删 | 归档 + 静止等待 + 超时中止 | 会话永不静止 → `aborted` 且零删除 |
| 命令注入 | 不使用 shell | 代码审查 + 无 `runShell` 调用 |
| 会话日志误删 | 按 sessionId 精确匹配，多命中即放弃 | 0 / 1 / 2 命中三分支 |
| 中途页面关闭 | 不依赖页面存活；重开后重新扫描即可看到真实剩余 | 结果与 `remaining` 一致 |

## 10. 界面

### 10.1 入口

`WorkspaceCard`（`src/client/shell/WorkspaceCard.tsx`）新增两个可选 props：

```ts
cleanup?: {
  allowed: boolean
  /** 不允许时的一句原因（空串=允许）。 */
  reason: string
  onOpen: () => void
}
```

- **摘要行**（默认态）：`路径 … [清理工作空间…] [更换工作空间]`，清理按钮危险色、`small`。
- **展开态**：原操作行下方加分隔线与「清理工作空间…」。
- 禁用条件：未选定 / 目录不存在 / `busy` / `cleanup.allowed === false`；禁用时按钮旁显示 `reason`。

### 10.2 确认弹窗

新组件 `src/client/modules/environment/ui/WorkspaceCleanupDialog.tsx`，状态机在
`src/client/modules/environment/model/workspace-cleanup.ts`：

```
closed → scanning → ready → applying → done
                 ↘ error（可重试扫描）
```

`ready` 内容：

```
清理工作空间                                        不可逆
/Users/…/中瑞世联工作空间 · 中瑞世联工作空间

将删除   94 个文件夹 · 1 个文件 · 约 12.4 GB
         清单（滚动）：<name> <kind> <size> …
         另有 N 项未展开

DSH 会话 12 条（顶层 5 · 子代理 7）
         其中 2 条运行中：确认后将先停止并归档
         ☐ 同时彻底删除会话日志（DSH 不支持；可能需重启才彻底消失）

不受影响 工作空间目录本身 · 其他工作空间 · 本机凭据与授权 · 系统回收站（不走）

限制     已归档的旧会话无法枚举，其日志可能残留
         清理后报告审核页的历史记录会一并清空

请输入目录名「中瑞世联工作空间」以确认  [____________]

                                  [取消] [清空工作空间]
```

- 输入逐字匹配（去首尾空白）才点亮红色按钮。
- 若该工作空间下有运行中会话，额外显示一行：
  「**如果其中包含你正在使用的会话**：确认后它的当前回复会立即中断，然后被归档。」
- `applying`：显示「正在清理… 已用时 Ns」+ 一行固定的阶段说明
  （停止并归档会话 → 删除会话日志 → 删除文件夹 → 收尾），**不伪装实时阶段，也不伪造百分比**；
  禁用关闭、Esc 与遮罩点击。`apply` 是一次 RPC，结果只在结束时返回。
- 页面若在这一步被关闭，**不保证** Host 侧执行会中止；重开后重新扫描，`remaining` 会反映真实状态。
- `done`：成功计数、失败清单（可折叠）、`remaining > 0` 时提示「有 N 项未删除」、按钮「重新扫描 / 关闭」。

### 10.3 页面接线

- `EnvironmentPane` 持有弹窗开关与 `cleanup` 视图，`WorkspaceCard` 只负责渲染入口。
- 是否允许由 `env.localAccess` 推出（Host 是唯一判据）：缺 `workspace-cleanup` 能力时
  `allowed=false`，`reason` = 标准授权文案 + 指向「账号连接」。
- 控制器接受一个 `onSettled(result)` 回调：执行结束后由 `apply.ts` 接上 `envStatus.refresh()`，
  环境页与报告审核页随 Host 状态一起刷新；`onRefresh()` 仍是页面的「重新检查」入口。

## 11. 接口、授权与协议

### 11.1 Host 操作

新增 `src/host/operations/workspace-cleanup.ts`，在 `operations/register.ts` 注册两条：

| 操作 | 入参 | 副作用 |
|---|---|---|
| `workspace-cleanup-plan` | 无 | 只读扫描；内存写一份计划 |
| `workspace-cleanup-apply` | `WorkspaceCleanupRequest` | 归档会话、删日志、删子项、清状态 |

实现放 `src/host/domains/workspace-cleanup/`：

```
guards.ts     路径校验、黑名单、直接子项判定
scan.ts       子项扫描、会话枚举、统计
plan.ts       指纹、计划租约（TTL/单次）、单实例锁
sessions.ts   归档、静止等待、日志定位与删除
apply.ts      编排：校验 → 会话 → 存储 → 子项 → 状态 → 回读
io.ts         可注入 IO（生产 node:fs/promises；测试内存替身）
index.ts      对外服务
```

### 11.2 本机访问

- `LOCAL_ACCESS_CAPABILITIES` 追加 `workspace-cleanup`（最后一项）。
- `LOCAL_ACCESS_SCHEMA_VERSION` 1 → 2：老收据变 `outdated`，界面要求重新同意一次。
- 操作表新增：

  ```
  'system.workspace-cleanup': {
    capability: 'workspace-cleanup',
    transport: 'filesystem',
    privileged: true,
    allowedSources: ['panel'],
  }
  ```

- 扫描与执行都先 `authorize()`；执行另记 `note()`（只记操作名与来源，不记路径）。
- 授权卡片新增一行说明：「清理工作空间：删除所选工作空间下的全部内容与会话日志，不可恢复」。

### 11.3 协议

- `WORKBENCH_PROTOCOL` 48 → 49（新增两条操作与一套契约）。
- 客户端 `environment/api.ts` 增加 `workspaceCleanupPlan()` / `workspaceCleanupApply()`。
- 协议不匹配时按现有口径：界面整体提示重启，清理按钮禁用。

## 12. 结果语义

| status | 含义 | 界面 |
|---|---|---|
| `completed` | 计划内子项全部删除，`failures` 为空 | 绿色结果 + 计数 |
| `partial` | 有删除失败、状态写盘失败，或 `remaining > 0`，但执行完成 | 琥珀结果 + 失败清单 |
| `aborted` | 会话无法归档，或未在 30 秒内静止；**未删任何文件** | 红色结果 + 重启提示 |
| `failed` | 前置校验失败（输入/授权/冲突/基础设施） | 红色 + 可重试入口 |

`ok` 当且仅当 `status === 'completed'`。`remaining` 与 `remainingNames` 在所有 status 下都返回。
计划是**单次使用**的：任何失败后重试都必须重新扫描、重新确认；不允许复用旧计划再执行一次。

## 13. 测试策略

### 13.1 单元（内存 IO）

- `guards`：`/`、盘符根、`home`、`~/.dsh`、祖先关系、`..`、空名、符号链接；
- `scan`：计数（目录/文件/链接/其它）、大小预算截断、500 项截断、排序稳定；
- 会话过滤：相等、子目录、`/work` vs `/work2`、Windows 大小写、空 cwd；
- `plan`：TTL 过期、单次使用、并发锁；
- `fingerprint`：顶层项增/删/改名、会话**增删**改变指纹；大小、`mtimeMs`、会话 `running` 变化都不改变；
- `apply`：顺序（归档 → 日志 → 子项 → 状态）、单条失败继续、`remaining` 正确；
- `sessions`：会话永不静止 → `aborted` 且零文件删除；归档失败 → `aborted` 且零文件删除；
  `list()` 抛错 → `aborted`；日志 0/1/2 命中三分支；
- 空工作空间：计划 `ok`、计数全 0、执行入口禁用。

### 13.2 Host 行为

- 未授权 → `policy`，且零文件系统写入；
- 协议不匹配 → 明确失败；
- apply 缺 planId / 指纹错误 / 名称不匹配 / 计划过期 → 对应 errorKind；
- 扫描后改动子项 → apply 拒绝且目录完好；
- 成功后 `env` 快照作废、审核记录清空且落盘。

### 13.3 客户端

- 摘要行与展开态都渲染入口；禁用原因可见；
- 弹窗计数与明细、输入匹配才可点、运行中提示、勾选框；
- `applying` 不可关闭；`done` 的失败清单与 `remaining` 展示；
- 无会话/空工作空间/目录不存在三种边界。

### 13.4 真机

- 只在**临时目录**手工造一个假工作空间（若干目录 + 文件 + 符号链接 + 一条会话）跑一遍；
- macOS 与 Windows 各一次，记录实际步骤、平台与结果；**不在真实工作空间上验收**。

## 14. 文档与交付

- `plugins/dsh-crwu-workbench/CHANGELOG.md`：0.0.50 条目（功能、限制、协议 49、schema 2）。
- `plugins/dsh-crwu-workbench/README.md` / `README.en.md`：环境页「工作空间」一行补清理入口。
- `plugins/dsh-crwu-workbench/docs/development-notes.md`：新增「清空工作空间」小节（限制与不变量）。
- `src/shared/consts.ts`：协议 49 的变更注释。
- 完成后跑 `make plugin-check`（插件与打包 Skill 门禁）与 `make docs-check`（改到活跃文档时）。

## 15. 非目标

- 不提供“只清理案例目录”的选项（用户明确要整盘清空）。
- 不提供撤销 / 回收站；不承诺可恢复。
- 不清理其他工作空间、不清理 `~/.dsh` 下不属于 W 的会话。
- 不自动重置工作空间选择，也不注销 DSH 工作区注册。
- 不做定时/自动清理。
- 不修改 DSH 自身代码或新增 DSH 的删除会话 API。
