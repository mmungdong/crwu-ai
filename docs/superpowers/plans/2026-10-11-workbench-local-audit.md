# Workbench 本地审核（Local Audit）实现计划

> 状态：进行中。本文件是「本地审核」这一功能的**实现契约**（Host / Client / 协议 / 技能四侧的唯一落点）。
> 用户可见文案、布局与视觉口径以本文件 §5–§8 为准；与源码冲突时以源码与测试为准，并回来改本文件。

## 1. 产品定位与边界

在「报告审核」页面下增加一个与之并列的页签「本地审核」。两条流程**完全独立**：

- 本地审核：用户选本机文件/文件夹 → Host 生成一次性输入快照 → 尝试自动创建一条**普通 DSH 对话**并把固定审核指令发过去 → 自动切到那条对话；创建失败时给用户一条**手动兜底**路径（切完全权限、新建对话、粘贴提示词）。
- 审核结果**只存在于那次对话里**：不保存审核历史、不建 sidecar、不监控其他对话、不上传/下载本地审核产物。
- 报告审核的既有流程、字段与 HTML 结果**不变**。

## 2. 协议（新增 3 个 Host 操作 + 1 个模型可见 Tool）

| 名称 | 作用 |
| --- | --- |
| `local-audit-status` | **只服务当前准备流程**：按本次选择扫描（递归展开、去重、计数、大小、可读性），回传逐项状态与汇总。不作为全局 sidecar 状态，也不用于历史监控。 |
| `local-audit-start` | 重新校验选择 → 建临时快照 → 生成一次性 handoff，回传 `handoffId` + **可复制的固定提示词**（不含绝对路径/凭据）。 |
| `local-audit-claim` | 由 `crwu-audit` 技能在**新对话里**调用：校验 handoff（存在/未用/未过期/快照仍在），把临时案例目录**绑定到当前会话**。 |
| Tool `crwu_audit_local_claim` | `local-audit-claim` 的模型可见入口（结构化 Tool，只接受 `handoffId`）。 |

`WORKBENCH_PROTOCOL` 27 → 28。

### 2.1 为什么会话由 Client 创建

DSH 的**普通会话**只能从浏览器侧服务建：`sessions.create({ cwd })` + `sessions.using(id, …, ref => ref.binding.session.prompt/rename)` +
`uiWorkspace.openSession(id)`（客户端 `sessions` 服务上**没有** `open()`）。Host 只在安装预设会话时能 `agents.create`。
因此职责切分是：

- **Host**：扫描、限额、快照、handoff、固定提示词、claim 校验、案例 scope、清理；
- **Client**：选择文件/文件夹、准备阶段状态、调用 3 个操作、用 DSH 会话服务建会话并发送提示词、切到新对话。

⚠️ **新会话必须用 `sessions.create({ workspaceId })` 建**（2026-10-11 修正；只有拿不到 id 时才退回
`cwd = workspacePath`）。判据来自 DSH 自己的客户端产物：`ui-workspace` 的 `reuseOrCreateBlank` 用的就是
`create({ workspaceId })`，而侧栏「未分组」的判据是 `workspace.sessionIds.includes(id)` ——
**注册表成员关系**，不是 cwd 匹配。`workspaceId` 由界面从 `env.workspace.id` 传下来。

⚠️ **cwd = `local-audit-start` 返回的 `workspacePath`（员工选定的工作空间，逐字）**
（2026-10-11 用户口径修正：「本地审核对话应该创建在我环境信息规定的工作区下面」）。三件事被这一条绑住：

1. DSH 按 cwd 把会话归到工作空间下 —— cwd 不等于工作空间路径就落「未分组」；
2. 会话的沙箱边界 = 那个 cwd，所以**案例目录必须在工作空间之内**，否则对话里的案例内工具
   （`crwu_run_python_script` 等，非特权）写不进去；
3. 交付件要落在员工找得到的地方。

因此案例目录从 `os.tmpdir()/crwu-local-audit/<id>` 移到 **`<工作空间>/本地审核/<id>`**；
`local-audit-start` 在没选工作空间时直接拒绝（`policy`，指回「环境信息」）。
`workspacePath` / `casePath` 都**只回给客户端**，不进提示词（提示词里只有 `handoffId`、展示名与
快照内相对路径）。

失败点因此有两个：Host 准备失败（`ok:false`，选择内容不丢）与**会话创建/发送失败**（同样是复制提示词的兜底）。

## 3. Host 模块

```
src/host/local-audit/
  consts.ts      # 30 文件上限、TTL、目录名
  scan.ts        # 选择的规范化 + 递归展开 + 去重 + 限额（纯逻辑，可注入 fs 替身）
  snapshot.ts    # 临时案例目录 + 材料-源/<相对路径> 拷贝 + 清单/元数据
  handoff.ts     # 一次性 handoff 注册表 + 案例 scope 注册表（进程内）
  prompt.ts      # 固定审核指令（本地审核版）
  cleanup.ts     # TTL 到期清理（快照目录 + 注册表）
  ops.ts         # 三个操作
```

- 案例目录：`<已选工作空间>/本地审核/<handoffId>/`（`材料-源/` + `本地审核清单.json` + `快照元数据.json`）。
  交付件（`审核意见.<项目ID>.html` / `审核结果.<项目ID>.json`）也落在它里面，员工在自己的工作空间里找得到；
  认领过的案例目录**不会**被插件自动删除（未认领的过期快照才清）。
  它是**本轮审核的信任域**：会话的 cwd 就是它，案例内工具也以它为 `casePath`。
- 快照拷贝失败的文件逐件记 `status='unreadable'|'skipped'` 与原因；**部分失败仍可继续**，全失败则 `ok:false`。
- 原始文件在快照之后被删除**不影响**本次对话（对话只读快照）。

## 4. 案例 scope

`requireCaseAccess` 增加第四类调用者：`kind: 'local'`（`handoff.claim` 登记 `sessionId → casePath`）。
命中时 `casePath` 就是该次本地审核的临时案例目录，`crwu_run_python_script` / `crwu_h3yun_file_get`
等案例内工具据此校验并只在它之下读写。审核子会话与讨论会话的判据不变。

## 5. 页面结构

顶部两个页签（沿用现有 token 与 `Button` 风格）：`报告审核` / `本地审核`。
选中本地审核后是单列滚动布局，三块卡片 + 主按钮：

1. **已选择内容**：空状态（文件夹 SVG 图标 + 说明）；已选择状态是**两层**列表 ——
   **入口行**（图标 + 名称 + `文件 · 2.4 MB` / `文件夹 · 展开 8 个文件`）+ 文件夹下面
   **每个文件一行**（完整文件名 + 相对路径 + 大小）。两层的右侧都是**一枚 X 图标**：
   入口行的 X = 不审这个入口；文件行的 X = 只不审这个文件（记进**排除清单**，
   重新扫描后依然不审，见 §2 的 `excluded`）。
   —— 2026-10-11 用户第二次口径：「审核文件在扫描后应该完整展示文件名称，右侧有个 X 的 icon，
   表示移除该文件」。
   底部汇总「已选择 2 个项目，展开后共 12 个文件」；每行状态用**图标 + 文字 + 颜色**三重表达。
2. **选择文件 / 选择文件夹**：两个并列主按钮 + 说明「支持任意文件类型。文件夹会递归读取。」+ 辅助操作
   「清空选择」（**「重新扫描」于 2026-10-11 按用户口径下掉**：移除一个文件/文件夹本身就会立刻重扫一次，
   再放一个手动重扫按钮会让两者的关系说不清）。真要重扫时清空后重选即可 —— 重新选择本来就会扫。
3. **补充提示词（可选）**：≥5 行 textarea，占位符与两行说明。
4. 主按钮按状态表变化（§8），loading 时禁用。

错误紧邻对应区域；扫描、快照、创建会话状态用 `aria-live`。

## 6. 选择能力与降级

- 「选择文件夹」：`uiWorkspace.pickDirectory()`（返回绝对路径）。
- 「选择文件」：隐藏 `<input type="file" multiple>` + Electron 的 `__DSH_HOST_PATHS__.pathFor(file)`（取回绝对路径）。
  DSH 没有原生「文件选择器」客户端服务，只有目录选择器；文件多选因此走渲染进程的 file input。
- 两条能力都拿不到（Web profile / 旧宿主）时整块显示：「当前 DeepSeek Harness 版本不支持本机文件选择。请更新宿主后重试。」——
  不暴露 JS 错误或底层服务名。

## 7. 正常与失败流程

正常：点「开始本地审核」→ 阶段条（`✓ 已读取选择范围` / `● 正在创建文件快照` / `○ 正在创建审核对话` / `○ 正在切换到新对话`）→
成功后显示「本地审核已移交到新对话 / 已提供 N 个文件 / 跳过 M 个文件 / 后续审核结果会直接显示在新对话中。」并自动切到新对话。

失败：不自动重试、不丢已选内容，显示「审核对话启动中断」+ Windows 完全权限三步说明，按钮「复制审核提示词」「重新准备文件」；
复制成功后提示已复制，且**不显示**「自动重试创建会话」。handoff 过期时显示「审核提示词已过期，请重新准备文件。」（旧 handoff 不可再用）。

## 8. 主按钮状态表

| 状态 | 文案 | 可用 |
| --- | --- | --- |
| 没有文件 | 请选择文件后开始 | 否 |
| 扫描中 | 正在扫描文件… | 否 |
| 超过 30 个文件 | 文件数量超限 | 否 |
| 有不可读但仍有可读 | 开始本地审核 | 是 |
| 没有任何可读文件 | 没有可审核文件 | 否 |
| 准备快照 | 正在准备文件… | 否 |
| 创建会话 | 正在创建审核对话… | 否 |
| 已准备 handoff | 开始本地审核 | 是 |
| 普通错误 | 重试准备 | 是 |

## 9. 视觉与可访问性

沿用 `features/workbench/consts.ts` 的既有 token（颜色/圆角/阴影/间距），不新增 CSS 变量、不用 emoji、不加大面积红底；
图标用 `components/icons.tsx` 的既有体系（必要时按同一笔画风格补）。动效只允许 loading 旋转、150–200ms 淡入、短暂 toast，
并支持 `prefers-reduced-motion: reduce`。所有图标按钮有 `aria-label`，列表用语义化 `<ul>/<li>`，移除按钮说明具体文件名，
禁用按钮旁边必须有可理解的原因文字。

## 10. 必须验证的场景（对应设计 §17）

1 无选择不可启动 · 2 文件夹递归 · 3 多入口同文件去重 · 4 超 30 明确阻止 · 5 部分失败可继续 · 6 全失败不可启动 ·
7 任意扩展名不被前端拦截 · 8 自动创建成功可切换 · 9 创建失败不丢选择 · 10 复制完整提示词 · 11 手动粘贴后 claim 成功 ·
12 过期明确提示 · 13 原始文件删除不影响首次对话 · 14 报告审核旧流程不变 · 15 无 sidecar/活动会话列表/跨对话监控 ·
16 Windows 失败提示 · 17 固定 JSON 与 HTML 都标记本地审核 · 18 HTML 展示已审核/未审核/缺失字段。

每条在 `tests/unit/` 下有对应断言（Host 侧纯函数 + 操作，Client 侧状态/渲染，技能侧文案守卫）。

---

## 附：实现状态（2026-10-11 收口）

已经落地并有回归的部分：

- **协议**：`WORKBENCH_PROTOCOL` 27 → 28；操作清单 39 → 42（`tests/helpers/frozen-inventory.mjs`）。
- **Host 核心**：`src/host/local-audit/{consts,scan,snapshot,handoff,scope,prompt,ops}.ts`。
  扫描不跟随符号链接、跳过特殊文件、按真实路径去重、**超过 30 个明确阻止且不截取**；
  快照落在 `<tmp>/crwu-local-audit/<handoffId>/`（`材料-源/` + 清单 + 元数据），
  逐件复制失败可继续、全失败即"没有可审核的文件"。
- **本机访问操作**：`system.local-audit-material.snapshot`（特权、`filesystem` 通道、只给面板）；
  未授权时一个字节都不读；非 shell 的本机访问事实经 `Broker.note()` 进诊断。
- **认领**：Tool `crwu_audit_local_claim` + RPC `local-audit-claim`。身份只来自
  `exec.agent.id`；同会话幂等、异会话拒绝、过期 / 快照不在时指回 Workbench。
- **案例门禁**：`requireCaseAccess` 增加 `kind: 'local'`（会话级 scope + `caseDir` 精确相等）。
- **交付门禁**：OSS 发布 / 钉钉归档 / 钉钉通知在本地审核 scope 下一律 `policy` 拒绝。
- **交付件标记**：`auditTask.mode = "local"` → 标题「本地审核报告 - 项目ID」+ 顶部信息条
  （`本地文件审核 · 生成时间 · 已审核 N/M 个文件`，N/M 由渲染器从 `scope.inputs[].readable` 数出）
  + 阶段二写成不适用；其余版式一字不改。schema 新增可选 `auditTask.mode`。
- **技能**：`crwu-audit/references/16-local-audit.md` + SKILL.md 的输入与必读指针。
- **测试**：`tests/unit/host-local-audit.test.mjs`（31 条）、`tests/unit/host-local-claim.test.mjs`（9 条）、
  `tests/unit/client-local-audit.test.mjs`（42 条）、`skills/crwu/crwu-audit/scripts/test_audit_delivery.py`（115 条）。
- **逐字文案**：设计 §2–§9 给出的每一句用户可见文字都在文案表里，并由一条**文案契约**测试逐条比对
  （含五个文件状态、「待审核」占位行、复制成功后的三行、以及"不要出现『自动重试创建会话』"）。
- **真机验收脚本**：`install/browser-check.mjs` 新增只读的「本地审核页签」一段（页签语义 / 页面说明 /
  三块卡片 / 空态文案 / 主按钮禁用 + 旁边原因 / 切回报告审核后本地页卸载而报告正文还在 / 切页签零副作用）。

### 真机第一次审核后的修正（2026-10-11）

- **协议 29 → 30**：`local-audit-status` 应答新增 `files[]`（文件级清单，带 `parentPath`），
  两条本地审核操作新增可选入参 `excluded[]`（逐个移除的文件）。移除**必须**发给 Host ——
  重新扫描与建快照都以它为准，否则"移除一个文件"在下一次扫描后会长回来。
- **协议 28 → 29**：上一轮改跨进程字段（`workspacePath`）时忘了升协议号，真机上"新界面 + 旧宿主"
  发出空 cwd，报 `mkdir ''`。协议号现在会拦住它；`session.ts` 另加一道"空路径绝不发请求"的闸。
- **cwd 不依赖那个新字段**：客户端改用**界面已经在显示的工作区**（`env.workspace.path`）；
  宿主回的值优先（案例目录落点的权威），面板那份兜底，两边不一致时拒绝并要求重新准备。

- **会话与案例目录改到工作空间下**（`<工作空间>/本地审核/<id>` + 会话 cwd = 工作空间）：见 §2.1 的三条绑定点。
- **交付件不再被清掉**：`sweep()` 原来把「已被认领」也当可清理条件，而 `claim()` 一成功就置 `used` ——
  审核跑完（甚至还在跑）时下一次清理就把整个案例目录连交付件删了。现在只清**未认领**的过期快照。
- **交付件要写完整路径**：界面里的文件链接按会话工作空间根解析，只写文件名会指到不存在的路径
  （用户实测「点击文件跳转不过去」）。收尾格式里新增「交付件（完整路径）」一块。

尚未完成 / 下一轮要做的：

1. **真机验收**（`tests/*` 覆盖不到的那几条）。当前 profile 里要跑一遍：
   - 点「本地审核」→ 选文件/文件夹 → 扫描结果与超限阻止；任意扩展名都不被拦；
   - 点「开始本地审核」→ 阶段条走完 → **真的切到了新对话**，且对话里 `crwu_audit_local_claim`
     成功拿到案例目录；
   - 对话里 `crwu_run_python_script` 能在案例目录里跑通；
   - 手动把 `sessions.create` 弄失败（或改到没有会话服务的宿主上）→ 失败卡片 + 「复制审核提示词」，
     粘贴到一个**完全权限**的新对话里仍能认领成功；
   - handoff 过期（改短 TTL 或等 30 分钟）→ 明确提示重新准备。

   ✅ **前提已静态核实（2026-10-11）**：`sessions.create({ cwd })` 不需要预先注册工作空间 ——
   装好的产物里 `dsh-api-session-controller` 的客户端只转发 `{ cwd }`，host 侧
   `SessionController.create` 把 `workspaceId` 与 `cwd` 判为二选一，拿到 `cwd` 后
   `agents.ensureSession → createOrAdopt` 会 `mkdir -p` 它并写进会话 `meta.cwd`
   （也就是它的沙箱边界）。所以"临时目录下建不出会话"这个风险已经排除，
   剩下的只是端到端跑一遍。这条会话会落在侧栏「未分组」（与协议 24 同源），标题是
   `本地审核 · MM-DD HH:mm`。取证过程写在 development-notes 的「会话 cwd 与未分组」一节。
2. **环境门禁下的可达性 —— 已确认口径：保持现状（2026-10-11 用户决定）**。
   `requiresEnvironment('audit')` 仍为 true，所以环境自检不通过时统一导航会把用户拦到环境页，
   `module === 'audit'` 整块（含这两个页签）不渲染 ——「本地审核不要求环境」只在 audit 模块
   已展示的范围内成立（页内那一侧确实不判 `envOk`）。拆成 per-tab 会改既有导航语义与
   `client-module-gate` 的断言，属于对报告审核流程的可见改动，所以**不做**；
   想让本地审核在环境坏掉时也能用，将来再单独提。
3. **HTML 八段结构的完整对齐**：现在靠"把内容放进既有区域"（见 reference 16 的映射表）实现，
   如果将来要让首屏**按顺序**出现「审核范围 → 总体结论 → 项目画像 → 文件覆盖范围 → 计算表分析 →
   问题清单 → 未审核文件 → 缺失与不可用字段」，需要改 `template/audit-report.html` 的目录与区块顺序
   （会同时影响报告审核，必须先确认口径）。
4. **真机浏览器验收脚本**：`install/browser-check.mjs` 已补一段只读的「本地审核页签」验收
   （页签语义 / 三块卡片 / 空态文案 / 主按钮禁用 + 旁边的原因文字 / 切回报告审核后本地页卸载、
   报告正文还在 / 切页签零副作用）。**还没有在真机上跑过**（需要带 token 的页面地址），
   第 1 条验收时一并跑。

### 客户端（已落地）

- `src/client/features/local-audit/`：`selection.ts`（纯逻辑：`formatBytes` / 去重保序 /
  §8 九态 `buttonStateOf` / 汇总与超限文案 / 四态 `itemStatusOf`）、`pick.ts`（注入式目录与文件选择，
  「不支持」与「用户取消」分开）、`session.ts`（`create({cwd: casePath})` → `using` rename + prompt →
  claim → `openSession`，每步失败收敛成一句人话）、`controller.ts`（纯状态机，失败不丢已选/提示词/handoff）、
  `tabs.ts`（左右/Home/End）、`consts.ts`（只用既有 `--crwu-*` token）与六个组件。
- **草稿的持有者是 `apply()`**：`createLocalAuditPaneController(services)` 在客户端 `apply()` 里建一份、
  随 props 下发。状态机若长在页面组件里，切一次页签就把用户选的文件丢了 —— 与 §8 冲突。
  有一条真渲染的回归盯着它（`client-local-audit.test.mjs` 的「草稿由 apply 层持有」）。
- 页签条在 `WorkbenchPanel` 的 `module === 'audit'` 块里（`role=tablist/tab/tabpanel` + roving tabindex +
  左右/Home/End）；报告审核那一侧的内容与 `auditGate` **一个字没改**。
- 测试：`tests/unit/client-local-audit.test.mjs`（42 条；含订阅可解除、**草稿由 apply 层持有**、失败卡的完全权限三步、过期卡不给复制、扫描窗口的「待审核」占位行、**文案契约**（设计 §2–§9 的逐字原话与五个文件状态逐条比对）、以及一条**源码守卫**：本地审核里不许出现 `setInterval` 轮询 / 报告审核状态操作 / 会话列表）。
