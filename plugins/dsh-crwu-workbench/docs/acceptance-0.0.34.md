# 0.0.34 验收清单（案例目录创建 + 讨论会话材料范围 · 人工）

这份只覆盖 **0.0.34 / 协议 25** 这一批改动的验收：案例目录创建改走本机访问代理、
报告讨论会话的受限材料范围、同名附件不覆盖、「授权收据读不出来」与「没有授权」分开显示
（协议 25，见 [`development-notes.md`](development-notes.md) §21）。它不替代
[`desktop-acceptance-0.0.15.md`](desktop-acceptance-0.0.15.md) 里那套 P/W/M 矩阵。

## 0. 前置

| 项 | 值 |
| --- | --- |
| 插件版本 | `0.0.34`（侧栏入口的小标签；源码检出形态显示 `dev`） |
| 协议号 | `25`（界面与宿主必须是同一个数；不一致时界面**会拦下新审核**并提示完全退出重开） |
| 工作空间 | `/Users/mungdong/中瑞世联工作空间` |
| 流水号 | `2026-302549-LX10063-BG8856` |

### 这一台机器怎么"安装新产物"

本机的 profile 是 **link 形态**（`~/.dsh/profiles/desktop/package.json` 里
`"dsh-crwu-workbench": "link:<本仓>/plugins/dsh-crwu-workbench"`，
`node_modules/dsh-crwu-workbench` 是指向检出目录的符号链接）。所以：

```bash
npm --prefix plugins/dsh-crwu-workbench run build     # 只重建 lib/（Host 半 + Client 半）
```

然后 **完全退出并重新打开 DeepSeek Harness**（macOS：菜单退出或 ⌘Q；关窗口不算退出）。
**不需要**装 tgz —— `dist/dsh-crwu-workbench-0.0.34.tgz` 是给别的机器 / 发版用的。

判据（重启前可以先自查）：`lib/index.js` 里能搜到 `discussion-material-open`、
`lib/client.js` 里能搜到 `discussionMaterialOpen`，且两个文件的 mtime 晚于最后一次 `src/` 改动。

```bash
grep -c discussion-material-open plugins/dsh-crwu-workbench/lib/index.js
grep -c discussionMaterialOpen plugins/dsh-crwu-workbench/lib/client.js
```

### 0.1 前置自检（只读，可以现在就做）

工作台自己的状态文件是 `~/.dsh/crwu-workbench.json`（**只读地看**，改它等于手工编辑授权收据与工作空间）：

```bash
python3 - <<'PY'
import json, pathlib
d = json.loads((pathlib.Path.home()/'.dsh'/'crwu-workbench.json').read_text(encoding='utf-8'))
c = d.get('localAccessConsent') or {}
print('workspacePath :', repr(d.get('workspacePath')))
print('consent       :', c.get('schemaVersion'), c.get('capabilities'))
print('audits        :', 'audits' in d)
PY
```

2026-09-30 05:xx 的**实测状态**（这一轮验收开始前）：

| 项 | 值 | 含义 |
| --- | --- | --- |
| `localAccessConsent` | `schemaVersion 1` + 五项能力（含 `system-integration`） | **已授权**，且覆盖案例目录创建那一条操作 → 不会卡在"未授权" |
| `workspacePath` | 空串 | **还没选工作空间** → 重启后第一步必须选 `/Users/mungdong/中瑞世联工作空间`，否则 `audit-start` 会先回「尚未选定工作空间」 |
| `audits` | 不存在 | 没有历史审核记录，占用锁是干净的 |
| 目标案例目录 | 不存在 | 所以第 1 条"案例目录自动出现"可以直接判（不是"本来就在"） |

**为什么必须"完全退出并重开"**：宿主半随 profile 重启才换（客户端半刷新页面就换），这一代靠协议号
自己显形。**正在跑的这条会话本身横跨了这次构建**，所以它现在挂着的仍是旧宿主；重启之前点「AI 审核」
只会拿到「界面与宿主的版本不一致」——那是设计好的拦截，不是缺陷。

### 0.2 怎么一眼确认"装的到底是哪一份产物"（0.0.33 起）

失败文案末尾现在带**插件版本**：

```text
创建快照目录失败：mkdir: …: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是 · 插件 pkg-0.0.34）
```

**看不到 `插件 pkg-` 这一段，就说明宿主跑的还是 0.0.34 之前的产物**（重启没生效 / 重启在了构建之前）。
协议号在 0.0.31–0.0.33 一直是 23，所以界面上的"版本不一致"拦截**区分不出**那几代（0.0.34 起是 24） ——
2026-09-30 就因为这一点白排查了一轮，这一段就是补这个洞的。

### 0.3 2026-09-30 真机验收记录（已跑过四轮）

**第三、四轮**（0.0.33 之后）：`mkdir 输入快照` 已通过（目录真的建出来了），但三个快照 JSON 写不进去
（`FS_SANDBOX_DENIED: cannot write "…": file access denied under workspace-write mode`）→
审核仍停在「未创建子代理」。**根因与 shell 侧同形**：`ctx.fs.writeText` 不带策略，
而 `dsh-fs-sandbox` 是 `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()` ——
没有会话就落到部署默认（进程 cwd）。0.0.34 起所有案例内写入都走 `writeCaseText`（带策略 + 回读）。

**用户同时报的第四个故障**：点「AI 审核」后会话落在**未分组**，而不是环境信息里选定的工作空间下。
根因是协议 19 把审核根的 `cwd` 钉在案例目录上，而 DSH 的 `attachSession` 要求
`cwd === workspace.path` —— 挂不上只能落未分组。0.0.34（协议 24）起根的 cwd/边界 = 已选工作空间。
**验收时先看这一条**：新会话必须出现在「中瑞世联工作空间」下面。

### 0.3.1 2026-09-30 07:36 通过（0.0.34 / 协议 24）

用户跑 `2026-302739-LX10302-BG8857`（另一条报告），**审核正常启动并跑到子会话产出**。
机器上留下的证据（只读核对，不是转述）：

| 判据 | 证据 |
| --- | --- |
| ① 案例目录自动出现 | `<工作空间>/2026-302739-LX10302-BG8857/`（07:37） |
| ② `输入快照/` 三个 JSON | `报告记录.json` 13340 B · `附件清单.json` 4583 B · `快照元数据.json` 695 B（均为 `600`） |
| ③ 带本轮 attemptId 的审核子会话 | `audits` 记录：`childId 2149c2e5-…` · `attemptId 2026-302739-…-a1-munbfyii` · `status running` |
| ④/⑤ 子会话取到附件 | `材料-源/` 有实际材料（docx / xlsx / 媒体） |
| ⑥ 工作空间归属（本次修复的主目标） | `~/.dsh/storages/workspace.json` 里 `中瑞世联工作空间` 的 `sessionIds` **含审核根** `session-7c9fd1e3-…` |
| ⑦ 同名附件不互相覆盖 | 两对同名件各自带标识落盘：`01评估报告-百色__9eda2500.docx` / `__a5f8b737.docx`、`02评估说明-百色__51b6c6bb.docx` / `__a5321a20.docx` |
| 失败留档 | `lastAuditFailure` **不存在**（没有失败） |

子会话还产出了 `材料盘点.json`、`媒体索引.json`、`排除清单.json`、`提取/`、`工作版/`、`媒体证据/`。

**仍未在真机上单独验过的一条**：⑥ 的反面 —— 普通 DeepSeek 顶层会话直接取附件必须被拒
（Host 侧判据由 `host-tools.test.mjs` 的授权矩阵与 `host-audit-scope` 覆盖）。

### 0.4 2026-09-30 前两轮记录（历史）

**第一轮**：第 1 条通过（案例目录自动出现 —— `system.case-directory.write` 的逐次提权在真机上生效），
失败在下一步"输入快照目录"。

**第二轮**（0.0.32 之后）：**同一个报错原样复现** —— 说明 0.0.32 的修法（把调用方的 `ctx` 传给 Broker）
**是无效的**：DSH 的执行器不持有会话，换 ctx 只是换个地方 `ctx.get('shell')`。
**正解**（0.0.33）：调用方把**自己会话的策略**算出来放进请求
（`BrokerShellOptions.session` → `ctx.sandboxPolicy.resolve({ session })` → `sandboxPolicy`），
与 DSH 自带的 bash / fs 同一条路。

**为什么这次的前置条件成立**（不是又一个猜测）：`ensureAuditRoot` 会在
`audit/ops.ts:202` 把根的沙箱写成 `workspace-write` + 边界 = 本轮案例目录，**并在回读不符时直接拒绝启动**
（`root.ts:260`，"策略没有收敛"）；而 bootstrap 在 `ops.ts:279` 才跑 —— 也就是说：
**能走到"建输入快照目录"这一步，就证明根会话解析出来的边界已经等于案例目录**。
所以这次拿到的策略一定是对的边界。

### 0.4 第一次真机验收记录（历史）

结论：**第 1 条通过；第 2 条失败在"输入快照目录"这一步，根因已定位并修掉（0.0.32）。**

```text
输入快照交接未完成，已终止本次审核（未创建子代理）：输入快照交接失败（infrastructure）：
创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）
```

- **案例目录建出来了** —— 说明 `system.case-directory.write` 的逐次提权在真机上生效（§一 的修复成立），
  而且失败发生在**下一步**，不是同一处。
- 失败那一步是**非特权**的案例内命令，边界落到了**部署默认**（进程 cwd）而不是案例目录。
  修法与两次踩空的原因见 AGENTS §4.4.2 第 7 条与 0.0.33 的 CHANGELOG。
- 因此现在的待办是**把这一轮再重做一遍**：第 2~7 条仍未在真机上确认过。

## 1. 成功标准（七条，逐条可判）

| # | 标准 | 怎么看 | 通过的样子 | 失败时最可能是什么 |
| --- | --- | --- | --- | --- |
| 1 | 案例目录自动出现 | Finder 打开工作空间 | 多出 `2026-302549-LX10063-BG8856/`，**不需要**手工建 | 见 §2 的三句话 |
| 2 | `输入快照/` 下三个 JSON | 进案例目录看 `输入快照/` | `报告记录.json`、`附件清单.json`、`快照元数据.json` 都在 | 「输入快照交接未完成」——快照失败会在**创建子代理之前**终止 |
| 3 | 有带本轮 `attemptId` 的审核子会话 | 左侧会话列表 | 一条按流水号命名的审核子会话 | 「审核子会话看不到必需的 CRWU Tool」 |
| 4 | 审核子会话能下载附件 | 在子会话里让它下 `广兴建筑v3.zip`（若有） | `crwu_h3yun_file_get` 返回 `ok:true` + 非零 `sizeBytes` | 「不在本轮审核的输入快照里」 |
| 5 | **报告讨论会话**也能下载附件 | 点报告那枚小鲸鱼 → 新建对话 → 让它下同一件附件 | 同上；材料落进 `<案例目录>/材料-源/…` | 「既不是进行中的审核子会话，也不是已登记的报告讨论会话」 |
| 6 | 普通顶层聊天仍不能绕过审核范围 | 在**新建的普通会话**里让它调 `crwu_h3yun_file_get` | 回 `policy` 拒绝，**零命令** | 若真下下来了 → 材料门禁有洞，立刻停下报给我们 |
| 7 | 两个同名 ZIP 不互相覆盖 | 报告里有两个同名附件时 | 落成 `广兴建筑v3__<fileId 前 8 位>.zip` 两个文件 | 若只落了一个或互相覆盖 → 名字判据没生效 |

第 7 条的对照物就在 `附件清单.json`：每一行有 `fileName` / `fileId` / `localName` /
`nameIndex` / `nameTotal`。`nameTotal > 1` 的条目就是"同名但不同 `fileId`"，
它的 `localName` 必须带 `__<fileId 前 8 位>`，两个同名列的 `localName` 必须不同。

## 2. 建不出案例目录时看哪一句话

三条**互斥**的失败文案（判据在 `host/tools/case-files.ts`，只看结构化事实，不猜文本）：

| 文案 | 含义 | 谁去修 |
| --- | --- | --- |
| 「DSH 主机未授予案例目录创建所需的 danger-full-access：…（请求 … · 实际 …）」 | 提权没到位：未授权、被降级或沙箱拒绝 | 宿主/部署（检查授权收据与插件版本） |
| 「当前系统账户无法写入所选工作空间：请检查目录所有者与操作系统文件访问权限」 | 沙箱放行了，是操作系统 ACL / 所有者 / 只读挂载 | 员工（**不自动改权限、不建议 chmod**） |
| 「所选工作空间不存在，无法启动审核：…请重新选择一个已有目录」 | 目录真的不在（探测明确回了 `absent`） | 员工（重选一个已有目录） |

另有一条**不是**上面三种的：「**无法确认**所选工作空间是否存在（探测没有得到结论）」——
探测命令自己没跑起来 / 被沙箱拦下 / 输出不可识别。它**不许**被读成"目录不存在"。

## 3. 出问题时先取这三样

1. **开发者诊断 → 最近的本机访问**（`access-diagnostics`）：每一行有操作名、来源、
   请求/解析/实际沙箱模式、是否被拒、归因类别、是否起过进程。案例目录那一步应当出现
   `system.case-directory.write`（来源 `audit-host`，请求与实际都是 `danger-full-access`）。
2. **案例目录里的 `输入快照/快照元数据.json`**：`attemptId` / `objectId` / `seqNo` / 取数时刻 /
   `schemaCode` 的指纹 —— 用来确认"这一轮"与子会话里看到的是同一份。
3. **完整退出重开**：协议号 25 是这一代的判据；界面发现宿主还是旧代时会**直接拦下新审核**并
   提示完全退出重开（而不是拿旧逻辑干活）。看到那句提示就先重启，不要继续排查业务。

## 4. 我没有验证的（如实记录）

自动化证据只到**替身层**：`tests/unit/host-case-files.test.mjs` 里有一台**真的会拦人**的沙箱替身
（复刻 `workspace-write` 的写白名单：不逐次声明 `danger-full-access` 就回
`mkdir: Operation not permitted`），`host-tools.test.mjs` 有完整的授权矩阵。
以下只能在**真机**上确认，我这一侧没有证据：

- ~~macOS 上 DSH 的 `danger-full-access` 提权对 `/Users/mungdong/中瑞世联工作空间` 真的生效~~
  —— **2026-09-30 已验证**：案例目录（那一级目录）真的建出来了，失败发生在它的**下一步**；
- DSH 在执行器侧对 `sandboxPolicy` 的解析与回传（`resolved` / `ran`）与替身一致；
- 氚云 `records get` / `files list` 在讨论会话那条链路上的真实延迟（每次登记两次 CLI 调用）；
- 同名 ZIP 的真实现场（本机这份报告是否真有两个同名附件）。

填完这份清单后，把结果（含上面的诊断那一行）贴回对话，我再决定是否需要下一批改动。
