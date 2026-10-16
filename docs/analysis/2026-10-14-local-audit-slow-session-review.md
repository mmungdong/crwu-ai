# 本地审核会话复盘：32 分钟里 22 分钟烧在知识库取数上

> 分析对象：`dsh-session-session-62269d48-e680-4f30-9161-6ea1347a6cb5`（本地审核 · 曲靖建宁商混）
> 对照对象：`dsh-session-session-3c196b84-cce7-42ca-bf27-ee1a7949e158`（氚云报告审核 · 2026-302807-LX10384-BG8897）
> 日志来源：本机 `~/Downloads/修复复盘日志/` 两份 DSH session 归档

---

## 0. 结论先行

| 结论 | 证据 |
| --- | --- |
| **交付是成功的**：32.4 分钟走完 125 步、17 件材料的两阶段本地审核，最终产出 HTML + JSON 两份交付件 | `turn/end reason=completed`；`deliverables/presented` 两条 |
| **时间不是被"算"掉的，是被"取数失败重试"吃掉的**：`crwu_audit_knowledge_materialize` 5 次调用共 **805.1s / 13.4min（占工具耗时 65%、占总墙钟 41%）**，其中 **4 次（758.4s）全部或大面积失败** | 见 §2 故障 B |
| **根因是部署环境与 dws 的硬链接式"安全下载"不兼容**：案例工作区在 **D:（exFAT）**，`dws doc +export` 用 `linkat` 把暂存文件硬链接到工作目录，跨卷 + exFAT 不支持硬链接 → **70/70 项必然报 `Incorrect function`** | log `+14.72min`：同一 node 在 `C:`（NTFS）**14.5s 成功**，在 `D:`（exFAT）**必然失败** |
| **Agent 自己绕过成功了，但代价是 10 分钟手工排查 + 10 分钟手工脚本**：写 `scripts/kb_fetch_exfat.py`（C: 暂存取数 → 普通复制回 exFAT → 逐件字节数校验），最终 **70/70 导出、0 失败** | log `+19.22min`（写脚本）、`+19.34min`（后台跑）、`+21.62min`（70/70 校验通过） |
| **绕过成功后 Agent 又白跑了一次 226.2s 的知识库取数**：文件已经在位，这次阻塞调用是纯冗余 | log `+22.35 → +26.12min` |
| **第二个会话（C: 工作区、氚云报告审核）同样栽在同一个工具上，而且更贵**：两次调用 **3491.1s / 58.2min（占 204.65min 会话的 28%）**，第一次 60 成功 3 失败（1491.5s），第二次只为补 3 项又花 **1999.6s** | 见 §5 |
| **员工反馈的"很多文件没审到"是成立的**，且是三个问题叠加：`readable` 只表达"文本被提取"，不等于"被审过"；旧版 `.doc` 在 Windows 上只剩 macOS 专有的 `textutil` 一条通道（会话 2 里报告正文与评估说明 4 件全部判不可读）；审核范围按业务轴/资产轴组织，**没有"文件 → 检查项"的映射，也没有任何交付校验要求文件覆盖完整** | 见 §8 |

**一句话**：审核链路本身不慢（知识库到位后，4 个子代理 3.9–6.7 分钟并行跑完，装配与交付不到 6 分钟）；
**慢在一个"必然失败但不早退、不降级、不给出可用绕行路径"的知识库取数工具上**；
**而"审不全"是另一条独立的线：读得到的通道太少，且"读到了"被当成了"审过了"。**

---

## 1. 会话 1（本地审核）基本面

| 指标 | 数值 |
| --- | --- |
| 会话跨度 | 13h22m（末尾 12.8h 是导出前空闲，非执行时间） |
| **真实执行时长（turn 1）** | **32.43 min** |
| 步数 / 工具调用 | 125 步 / 153 次 tool call |
| 模型（deepseek-flash · reasoningEffort=high · 256k maxTokens · 1M ctx） | 125 次推理共 **714.0s（11.9min，占 36.7%）**，单步均值 5.7s |
| 工具总耗时 | **1229.9s（20.5min，占 63.3%）** |
| 人工交互 | `ask_user_question` 1 次，等人 **69.8s** |
| 子代理 | 4 个（企业价值 / 机器设备 / 交通运输设备 / 存货），并行 3.9–6.7 min |
| 材料 | 17 件（16 件源材料 + 1 件人工复核件被阶段一隔离） |

### 工具耗时结构

| 工具 | 次数 | 累计耗时 | 占比 |
| --- | ---: | ---: | ---: |
| `crwu_audit_knowledge_materialize` | 5 | **805.1s** | **65.5%** |
| `pwsh`（模型自己拼的 Shell） | 82 | 340.1s | 27.7% |
| `ask_user_question` | 1 | 69.8s | 5.7% |
| `job_output` | 6 | 10.3s | 0.8% |
| 其余 11 类工具合计 | 59 | 4.6s | 0.4% |
| **合计** | **153** | **1229.9s** | 100% |

---

## 2. 完整时间线（分钟为 turn 起点相对值）

### 阶段 A：起步（0 – 8.2 min，健康）

| 时刻 | 事件 |
| --- | --- |
| 0.00 | `crwu_audit_local_claim` 认领交接，返回案例目录 `D:\中瑞世联工作空间\本地审核\la-1791907346748-9f1a777a` |
| 0.00–0.13 | 读 `crwu-audit` SKILL + `14-orchestration-workflow` / `16-local-audit` / `00-input-and-route-profile` / `11-html-delivery-spec` 等 references |
| 0.01–0.03 | `ask_user_question`：材料里有「初审-互审意见.docx」，阶段二怎么处理 → **等 69.8s**，用户选「按本地审核口径：阶段二不适用」 |
| 0.04–0.12 | 隔离复核件到 `复核-人工/`；准备材料；**开始探测 Excel/LibreOffice/soffice**（3 次 Shell 共 234s：58.3 + 86.4 + 89.2） |
| 0.12–0.13 | 写 `scripts/`、跑材料准备，产出 `提取/`、`媒体证据/` |
| **0.13** | **第一次 `crwu_audit_knowledge_materialize`（70 个清单项）启动** |

> Shell 探测 LibreOffice/Excel 的 234s 是另一处环境税：Windows 上 `.doc` 文本提取没有内置转换器，Agent 全盘搜 `soffice`。本次它没成为瓶颈（与后续并行），但它是纯粹的"找不到就慢慢找"。

### 阶段 B：知识库取数连环失败（8.2 – 19.3 min，**纯损失**）

| 时刻 | 事件 | 耗时 | 结果 |
| --- | --- | ---: | --- |
| 8.17 → 14.49 | `materialize(70 项)` | **378.9s** | **`ok:false`，70/70 全部 `failed`**，全部同一根因 |
| 14.49 → 14.56 | Shell 找 `dws`、看 `knowledge/` | ~4s | 发现 `knowledge/` 下空 |
| 14.63 → 14.72 | 读 `dws doc +export --help`；**手工复现同一条 export** | ~28s | 复现失败：`发布下载文件失败: linkat .dws-download-6880-1 01-评估审核条目.md: Incorrect function.` |
| 14.93 | **在 `C:`（NTFS）上冒烟测试同一条 export** | ~14.5s | **`exit=0`，成功落盘 14403B** → 根因锁定：**不是钉钉侧、不是节点、不是权限，是目标卷文件系统** |
| 15.03 | `materialize(caseDir=C:\Users\...\Temp\crwu-kb-stage\case)` | 0.0s | `errorKind:policy`「案例目录必须是**本次本地审核自己的**临时快照目录」 |
| 15.21 | `materialize(caseDir=C:\crwu-kb-stage2)` | 0.0s | 同上（policy 拒绝，正确但无出路） |
| 15.09 / 15.29 | 试图在案例内 `mklink /J`（junction）、`New-Item -ItemType SymbolicLink` 指向 C: | ~40s | junction 失败（D: 非 NTFS）、符号链接失败（"指定的路径不支持符号链接"） |
| 15.57 → 18.90 | **第二次 `materialize(仅 1 项：依据时效对照表)`** | **199.9s** | 仍 **failed 1**，同一个 linkat 错误 |
| 19.22 | **写 `scripts/kb_fetch_exfat.py`**（NTFS 暂存取数 → 复制回 exFAT → 逐件字节数校验） | ~10s | 4362B |
| 19.29–19.34 | 从 spill 文件里捞出完整 70 项 manifest，写 `scripts/kb-list.json`；**后台启动** `kb_fetch_exfat.py` | ~10s | `job pwsh-56` |

**这一段（8.2 → 19.3 min）≈ 11.1 分钟，除了最后 20 秒写的绕行脚本，全部是损失。**

### 阶段 C：并行执行（19.81 – 26.47 min，健康）

| 时刻 | 事件 |
| --- | --- |
| 19.81 | 派 2 个子代理（企业价值 / 机器设备） |
| 20.09 | 派 2 个子代理（交通运输设备 / 存货） |
| 20.13 / 20.34 / 20.59 | `job_output(pwsh-56)` 观察取数进度：`[1/70]` → `[34/70]` → `[43/70] → [48/70]`，**每件都有字节数** |
| 20.26 – 20.99 | 父会话并行读 13 张证据图（`read_image` ×13，共 1.6s） |
| 21.01 | 列 `knowledge/`：**70 件已到位** |
| 21.62 | 逐件核对：**清单项 70 / 取数条目 70 / exported 70 / failed 0 / 字节数不一致 0**；写 `知识库取数结果.json`、`排除清单.json` |
| **22.35 → 26.12** | **第三次 `materialize(3 项)`**：**226.2s，3/3 失败**（文件其实已在位，纯冗余重试） |
| 23.75 | 企业价值轴子代理完成（用时 3.94 min） |
| 24.85 / 25.01 | 交通运输设备轴 / 存货轴完成（4.76 / 4.92 min） |
| 26.47 | 机器设备轴完成（6.66 min，最慢） |

> **关键观察**：4 个子代理在 **+19.81 与 +20.09** 启动，而知识库文件直到 **+21.01** 才全部就位 —— 子代理在"知识库还在写"的窗口里开工。
> 从证据看它们没有因此报错（父会话同时也在观察 `[1/70]…[48/70]` 的进度），但这个**竞态是靠运气而不是靠契约**：没有任何机制保证子代理读到的知识库是完整快照。

### 阶段 D：装配与交付（26.5 – 32.4 min）

| 时刻 | 事件 |
| --- | --- |
| 26.5 – 28.9 | 合并 4 份 findings、写 `build_audit_result.py`（首次撞 `spawn ENAMETOOLONG`，改分段写） |
| 28.9 – 31 | 写 `parts_c.py` / `build_final.py`；阶段一冻结 |
| 31 – 32.4 | 渲染 HTML + JSON，校验通过，`present` 交付 |

---

## 3. 故障归因

### 故障 A（根因 · 环境）：dws 的"安全下载"用硬链接发布，在 exFAT 工作区 100% 失败

**证据链（三条互相独立）：**

1. **同一条命令，两个卷，两种结果**
   - `+14.72min`，目标 `D:\...\knowledge\01-评估审核条目.md`（exFAT）→
     `"cause": "发布下载文件失败: linkat .dws-download-6880-1 01-评估审核条目.md: Incorrect function."`
   - `+14.93min`，目标 `C:\Users\...\Temp\crwu-kb-test\kb-test.md`（NTFS）→ `steps: [submit, poll, download] 全 success`，**14403B**，`exit=0`
2. **失败阶段是 `download` 而不是 `export`**：`"stage": "download"`、`"status": "incomplete"`，
   且 message 明确写着「导出任务已完成但安全下载失败」。**钉钉侧的导出 job 是成功的。**
3. **二进制符号**：vendored `dws` 1.0.61 的 Windows 产物里同时含 `internal/syscall/windows.Linkat` 与 `os.linkat`
   → 发布用 `linkat` 语义。Windows 上硬链接要求**同卷**且**文件系统支持**（NTFS/ReFS）；
   exFAT/FAT32 直接返回 `ERROR_INVALID_FUNCTION`（="Incorrect function"），跨卷硬链接同理失败。

**为什么第一次调用特别贵（378.9s）**：工具对清单项是**串行**处理（`knowledge.ts` 第 319–373 行，
每个项：`removeFileIfExists` → `dws doc +export` → 轮询 → 下载 → `fileSize` 校验），
**遇到失败只 `continue`，不早退** —— 于是它把 70 项全部跑完（含服务器侧提交 + 轮询 + 下载 + 发布失败），
再在最后返回一句「70 个清单项取数失败」。**第 1 项就足以判定这是环境级必然失败。**

### 故障 B（工具设计）：失败归类把环境错误说成了"工具不可用"，且不给出可执行的绕行

工具返回 `ok:false / errorKind:cli`，配合 `localDeliveryRefused` 之外没有任何"工作区文件系统不兼容"的判别。
Agent 于是走了 4 条死路（都在 `+14.5 – +19.3`）：

| 尝试 | 结果 | 说明 |
| --- | --- | --- |
| 换 `caseDir` 到 `C:\...\Temp\crwu-kb-stage\case` | `policy` 拒绝 | 正确（归属必须钉死在本轮案例目录），但**拒绝理由只说了"必须是本次本地审核自己的临时快照目录"，没有告诉它"取数目标卷不受支持"** |
| 换 `caseDir` 到 `C:\crwu-kb-stage2` | `policy` 拒绝 | 同上 |
| 案例目录内建 junction / symlink 指向 C: | 均失败 | exFAT 不支持 junction；无 Developer Mode 时符号链接被禁 |
| **重试** `materialize`（1 项 / 3 项） | 又花 199.9s + 226.2s | **必然失败的重试** |

**工具的错误里明确给了出路，但没人走**：
`"actions": ["dws doc +export-get --job-id 31483196824", ...]` 且 `jobId` 已在 details 里。
由于失败发生在 **download 发布阶段**（导出 job 已完成、产物在服务端/暂存区），
`+export-get <jobId>` **本来就是恢复路径**。日志里 **完全没有** 这条命令的调用记录。

同时错误体里带 `"retryable": false` —— 这个字段在**发布阶段失败**的语义下是误导：
真正不可重试的是"往这个卷 linkat"，可重试的是"从同一个 job 重新取回"。

### 故障 C（编排）：绕行已经成功，父会话却又阻塞跑了 226.2s 的同类调用

- `+19.34` 后台 `kb_fetch_exfat.py` 启动，`+20.59` 已到 `[48/70]`，`+21.01` 目录里 70 件齐。
- `+22.35` 父会话又调 `materialize(3 项)`，**阻塞 226.2s 到 `+26.12`**，结果 3/3 失败。
- 这段时间恰好覆盖 4 个子代理的尾部（机器设备轴 26.47 才结束），于是**父会话自己的关键路径被白白拉长了 3.8 分钟**。
- 触发原因很清楚：`+19.29` 从 spill 捞 manifest 时 Agent 已经看到 `channels: {export: 70}`、`extensions: {adoc: 70}`，
  **判据（"文件是否已在位"）在它手边，它没有先看 `knowledge/` 就直接重试了工具。**

### 故障 D（环境税）：Windows 上 `.doc` / Office / Python 的探测开销

| 项 | 耗时 | 说明 |
| --- | ---: | --- |
| 3 次全盘搜 soffice/Excel | 234s | 58.3 + 86.4 + 89.2 |
| 会话 2 更重：Python 沙箱 `0xC0000142`、`.doc` 需 LibreOffice 且字节截断、Office 技能加载 | ~9 min | 见 §5 |

---

## 4. 已经做对的地方（不要"修"坏）

1. **复核件门禁**：`初审-互审意见.docx` 在阶段一被隔离到 `复核-人工/`、未读、按本地审核口径记 `not_performed`，
   并且在动手前用 `ask_user_question` 向员工确认口径 —— 流程正确。
2. **子代理并行**：4 条资产轴同时跑，单条 3.9–6.7 min，父会话同时读证据图与合并结果 —— 并行度用足了。
3. **阶段一冻结 + 证据链**：`知识库取数结果.json`（70 项、字节数逐件校验、不一致 0）、
   `排除清单.json`、`build_final.py` 冻结指纹 —— 证据完整。
4. **绕行脚本本身是合规的**：它没有伪造正文、每次都实时向钉钉取数、逐件校验字节数，并如实写下根因（exFAT + 跨卷 + linkat）。
   **这条绕行路径应该被产品化，而不是让它每次都靠模型现场手写。**

---

## 5. 对照组：会话 2（氚云报告审核）—— 同一个工具，更贵的账单

| 指标 | 数值 |
| --- | --- |
| 工作区 | `C:\中瑞世联工作空间\2026-302807-LX10384-BG8897`（NTFS） |
| 会话时长 | 204.65 min（其中 **48.87 min 是父会话在等一个卡死的子代理**：公共准则轴跑到 +130 后无产出，父会话直到 +179.52 才 `interrupt_agent` 并换更小范围重跑） |
| `crwu_audit_knowledge_materialize` | **2 次 / 3491.1s = 58.2 min（占 28.4%）** |
| 其余工具 | 71 次 `pwsh` 仅 219.6s；`crwu_h3yun_file_get` 17 次 26.8s；归档/通知/取数均 < 16s |
| 子代理 | 7 个，最长 98.1 min（公共准则轴，最终被判卡死并中断重跑） |

**会话 2 的另一笔账：卡死子代理的 48.9 分钟。**
公共准则轴 `b9a0c067` 从 +81.42 起跑，父会话 +130.4 拿到它最后一次产物后再无进展；
父会话继续干自己的活（+130 → +179 之间在等），直到 **+179.48** 才 `list_agents` + **`interrupt_agent`**，
再用 +179.65 派一个"必须快、必须有产物、禁止通读全部正文"的缩范围版本（19.6 min 完成）。
**从"该发现它卡住"到"真的动手中断"之间空转了 48.87 分钟** —— 这正是 DSH 编排里"子代理无产出停滞判据"没有落到工具层的代价。

| 调用 | 时刻 | 耗时 | 结果 |
| --- | --- | ---: | --- |
| 第 1 次（60+ 项） | +13.16 → +38.02 | **1491.5s** | `exported:60, failed:3`（`file_export_download_failed` / linkat 家族） |
| 第 2 次（只为补 3 项） | +38.37 → +71.70 | **1999.6s** | `ok:true`，`exported:3`，**`nodes:459`** |

**两个新的坏味道：**

1. **重试比首次更慢**：补 3 项花了 **1999.6s（33.3 min）**，比首次 63 项的 1491.5s（24.9 min）还长 34%。
   单件均摊 666s/项 —— 说明耗时**不是线性于清单项数**的。
2. **每次都全量遍历整棵知识库树**：即使只请求 3 个文件，也返回 `nodes:459`。
   `readTree()`（`knowledge.ts` 第 91–135 行）对每个空间从根开始逐层 `wiki +node-list --page-all --page-limit 200`，
   **整棵树 464 个节点、串行、不并发**（源码注释明确写了"不并发：知识库端点的分页/限流行为未知，串行是唯一能保证证据完整的方式"）。
   于是**请求 3 项和请求 70 项，树遍历成本一样**；这解释了为什么"补 3 项"不能便宜。
   会话 2 在 `C:`（NTFS）上依然慢，说明 **linkat 只是会话 1 的额外放大器，串行 + 全树遍历才是共同底噪。**

---

## 6. 修复建议（按性价比排序）

### P0 · 让知识库取数在 exFAT / 跨卷工作区可用

1. **在 `crwu_audit_knowledge_materialize` 内部把"取数"与"落盘"解耦**：
   在系统临时目录（NTFS）完成 `dws doc +export`，然后用**普通文件复制**搬到 `<caseDir>/knowledge/`，
   逐件校验字节数。这一步**不需要模型写脚本**——它应该就是工具的实现（`knowledge.ts` 第 348–372 行）。
2. **启动自检**：案例目录所在卷不支持硬链接时（exFAT/FAT32/网络盘），
   在**第一次**取数前就判定并直接走"暂存 + 复制"通道，返回
   `errorKind: infrastructure` + 明确文案（如「当前工作区卷（exFAT）不支持硬链接发布，已改用暂存复制通道」）。
3. **首次失败即熔断**：同一批清单项里**第 1 项**以 `doc_export_download_failed` / linkat 失败时，
   立刻停止剩余项，返回"环境级失败 + 已完成 jobId 列表 + 恢复动作"。
   当前 70/70 全跑完才聚合报错，白烧 378.9s。

### P0 · 把恢复动作真正接上

4. **失败时自动 `dws doc +export-get --job-id`**：错误体里已经有 `jobId` 和 `actions`，
   工具应自己完成"重新取回"，而不是把 jobId 交给模型。
5. **修正 `retryable` 语义**：`stage=download` 失败时报 `retryable:false` 会误导 Agent 放弃；
   应区分"同卷重试无意义"与"换通道/换 job 重取可恢复"。

### P1 · 消除冗余与竞态

6. **`materialize` 幂等短路**：目标文件已存在且字节数 > 0 时直接返回 `status: exported (cached-in-place)`，
   不重新提交 job。这一条能直接省掉会话 1 的 226.2s。
7. **编排契约化**：知识库**必须先完整落盘，再派子代理**（会话 1 里子代理在 `[48/70]` 时就开工了）。
   要么在编排文档里写成硬门禁，要么让 `subagent` 携带"等待知识库就绪"的前置条件。
8. **并行化树遍历与导出**：`readTree` 的逐层串行 + 导出逐项串行是会话 2 的 58 分钟底噪。
   至少做到**有界并发**（如 4–6 路），并在只请求少量路径时**按路径前缀剪枝**，不要每次都走全树。
9. **子代理停滞自动判据**：会话 2 里父会话对一个卡死的叶子子代理空转了 48.87 分钟才发现并中断
   （7 条子代理里 1 条 98 分钟无产出）。应在编排层给出"N 分钟无新产物 → 主动问询 / 中断 / 缩范围重跑"的默认动作，
   而不是依赖父会话自己想起来 `list_agents`。

### P1 · 环境税

10. **工作区默认用 NTFS 卷**：`D:`（exFAT）作为员工工作空间会让所有"原子发布"类操作降级或失败。
   在产品侧应检测并提示（或默认把案例目录建在 NTFS 卷）。
11. **`.doc` / Office 探测前置**：把"本机有没有可用的转换器"放进环境自检，
    而不是让模型在会话里全盘搜 `soffice`（会话 1 花 234s，会话 2 花了约 9 分钟且撞上字节截断的 `.doc`）。

### P2 · 观测与话术

12. **给取数加进度与预算**：当前一次调用静默最长 2000s，模型唯一能做的是一遍遍 `job_output` 轮询自己写的后台脚本
    （会话 1 轮询了 6 次共 10.3s，这部分反而是健康的）。工具应自己输出"X/N 已取回"。
13. **`caseDir` policy 拒绝时补一句出路**：会话 1 里两次 policy 拒绝**没有坏处**（归属必须钉死），
    但如果文案带上"若目标卷不受支持，请勿改道，工具会在内部改用暂存通道"，Agent 就不会去试 junction / symlink。

---

## 7. 可复现的判定清单（下次修完怎么验）

- [ ] 在工作区位于 exFAT 卷（如 `D:`）时，`crwu_audit_knowledge_materialize(70 项)` 应 **`ok:true`**，且 `failed:0`。
- [ ] 该调用**总耗时**应显著低于 378.9s；且**首件失败即熔断**（不再出现 "70 个清单项取数失败"）。
- [ ] 同一批清单项**重复调用**必须幂等：第二次耗时应接近 0（不重新提交导出 job）。
- [ ] 只请求 3 项时，树遍历/耗时**不应**与请求 70 项相当（当前会话 2 是 1999.6s vs 1491.5s）。
- [ ] 编排顺序上，子代理启动时刻必须**晚于**知识库 `failed:0 && 全部在位` 的确认时刻。

---

## 8. 第二个用户反馈：为什么"很多文件没有审核到"

> 员工反馈口径：本地审核与报告审核都感觉"很多文件没被审到"。
> 这个反馈**成立**，而且不是一个 bug，是三个叠加的结构性问题。下面每一条都有本次两份日志的实证。

### 8.1 反馈的实证：同一句话，两种口径

会话 1 交付件首屏写的是 **「本地文件审核 · … · 已审核 11/17 个文件」**，模型在对话里的汇报也写「已审核（11 件，文本/表格已提取并实际纳入审核）」。
但同一次运行里 `scope.notCheckedItems` 有 **10 条**、`summary.counts.notChecked = 10`。

**17 件材料 → 11 件"已审核"、10 条"未检查项"** —— 两个数字不是一个口径，员工按文件名对照时自然得出"很多没审"。

更关键的是那 11 件"已审核"里，**至少有 4 件并没有任何审核动作落在它自己身上**：

| 文件 | 交付件里的状态 | 实际发生了什么 |
| --- | --- | --- |
| `2026.7 利润表.xls`、`2026.7现金流量表.xls`、`2026.7资产负债表.xls` | `readable=true`、「已提取并纳入审核」 | 只被 `datacheck` 当作与评估明细表勾稽的数值来源看过；**没有任何技能核过这三张表自身的完整性、口径、与评估报告财务数据的对应**，全部 0 条 finding |
| `附件3商混资质（2029.12.31）.pdf` | `readable=true`、「含文本层，已提取文本」 | 文本被提取；**没有任何技能核过资质有效期与评估基准日/报告日的匹配**（文件名里就写着 2029.12.31），0 条 finding |
| `附件4商混公司章程.pdf` | `readable=true`、「含文本层，已提取文本；股东名录另经宿主读图判读」 | 只被用来读股东名录核对股权结构；章程本身的条款未被审 |
| `评估说明附件-有关事项说明-曲靖建宁商混.doc` | `readable=false`、未审核 NC-002 | 确实没读到（见 §8.3） |

**结论：`scope.inputs[].readable` 表达的是"这一件的文本/表格被提取出来了"，不是"这一件被审核了"。**
员工看到"11/17 已审核"，理解成"11 个文件被审过"，两者不是一回事。

### 8.2 根因一（结构性）：审核范围按"业务轴 × 资产轴"组织，没有"文件 → 检查项"的映射

会话 1 实际加载的叶子技能只有四条资产轴：

```
crwu-audit-asset-enterprise-value / -equipment / -transport-equipment / -inventory
```

- **`crwu-audit-public-general-standards` 这次根本没加载**（会话 1 无 public 叶子的调用记录）。
  而它恰恰是唯一把「委托合同订立与服务费合理性」「承接/计划/调查等程序质控」当审核对象的技能
  （见 `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit-public-general-standards/references/02-review-focus.md`）。
  于是本地审核里**没有任何技能对"委托合同、股东会决定、营业执照、公司章程、商混资质"这类佐证/程序文件负责**。
- router 的口径本身也把这类文件当**路由输入**而不是**审核对象**：
  `references/04-business-classification.md` 写的是「子业务识别以报告评估目的原文、**经济行为文件、委托合同**与审批材料为准」——
  即"读它是为了定业务标签"，不是"审它"。
- 结果：一个文件进了 `材料-源`、进了 `scope.inputs`、被单模态或视觉读过片段，
  **但没有任何 `checkDomains` 条目指向它**。交付件 validator 也不要求这种映射存在（见 §8.5）。

> **相邻证据**：会话 2 里 `crwu-audit-public-general-standards` 确实加载了，但它第一次运行 **1 小时 40 分无产物**被中断重跑（见 §5）。
> 也就是说——**唯一管这类文件的技能，要么不加载，要么加载了跑不出来。**

### 8.3 根因二（工具性）：读不到的入口只有一条，且那条通道依赖 macOS 专有命令

`scripts/prepare_materials.py` 是唯一面向"这 17 件读完没有"的确定性脚本，它对旧版 `.doc` 的处理是：

```python
def doc_to_text(p: str):
    """OLE .doc：textutil 转换。"""
    r = subprocess.run(["textutil", "-convert", "txt", "-output", out, p], ...)
```

- **`textutil` 是 macOS 专有命令**。在 Windows 上必然 `FileNotFoundError: [WinError 2] 系统找不到指定的文件。`
- 该失败被记成 `readable=false` **而不是**"我需要换一条读取路径"。
- `.docx` 的 `python-docx` 缺失回退也是 `textutil`（`docx_to_text()`），同样在 Windows 上死掉。
- **媒体通道同样死**：`media_extract.py` 的 `.doc` 分支
  `if not shutil.which("textutil"): return [], 0, [".doc 需 textutil 转 docx 才能取媒体，本机不可得：媒体本次未核"]`。

**会话 2 的实证（4 件源材料全部被判不可读）**：

```
1、…资产评估报告__92f92765.doc | magic ole | readable false | FileNotFoundError: [WinError 2] 系统找不到指定的文件。
2、…资产评估报告__ef68c7e4.doc | magic ole | readable false | FileNotFoundError: [WinError 2] 系统找不到指定的文件。
（更新件）1、…__4320d22b.doc   | magic ole | readable false | FileNotFoundError: [WinError 2]
（更新件）2、…__3436d46d.doc   | magic ole | readable false | FileNotFoundError: [WinError 2]
```

**而这两份 `.doc` 就是本次审核最关键的报告正文与评估说明。** 该会话是**靠模型现场手写了一个 CFB/OLE 分片表解析器**（`工具/doc_text.py`）才把正文读出来的：

> 技能脚本 `prepare_materials.py` 对旧版 `.doc` 依赖 `textutil`（macOS 专有），本机不可得 → 记 readable=false。
> 改用 DSH 自带 LibreOffice Kit 判定，其对本案 `.doc` 报 `invalid or truncated compound-file header`（容器尺寸非 512 字节对齐）。
> 最终以自建 CFB/OLE 只读解析器（`工具/doc_text.py`…）取得报告与说明正文。

**这就是"很多文件没审到"最直接的一条**：如果模型不自己写解析器，报告正文和评估说明就会彻底不进审核——
而这依赖模型当次的发挥，不是产品能力。

**完整的能力缺口清单（两份日志实证）**：

| 格式 | 现状 | 实证 |
| --- | --- | --- |
| 旧版 `.doc`（OLE）文本 | 只走 macOS `textutil` → Windows 必失败 | 上表 4 件；会话 1 的 `评估说明附件-有关事项说明-曲靖建宁商混.doc` → NC-002 |
| 旧版 `.doc` 内嵌媒体（签章页、回执影像） | 同样只走 `textutil` | 会话 2：「报告与评估说明的内嵌图片…（签章页影像、权属与鉴定资料影像）本次未导出」，6 条未检查项含此项 |
| 扫描 PDF（无文本层） | `pypdf` 为空 → 只记「疑扫描件」；只能靠宿主视觉**抽页**读 | 会话 1：委托合同 6 页只判读第 1–2 页；现场盘点表只判读第 1/3/4 页，各页 TIFF 未判读 |
| 图片（jpg/png） | 代码里直接写死 `readable=False`（"图片本机无 OCR"）；只能靠宿主视觉 | 会话 1：营业执照「旋转排版，文字识别存在不确定性」 |
| 旧版 `.xls` 内嵌媒体 | 无通道 | `media_extract.py`：`"xls 老二进制：本机无媒体提取通道（需 soffice 转换），若有内嵌图本次未核"` |
| 第三方依赖 | `openpyxl` / `python-docx` / `pypdf` / `xlrd` 缺任一项 → 整个格式判不可读 | 会话 2 的 `crwu_run_python_script` 直接 `0xC0000142` 起不来，全程退化为模型自己拼 pwsh 调 Python |
| 压缩包 | 解压后按普通材料处理（这条是对的） | 但未解压时被记 `readable=false / "压缩包：未解压审核"` |

**与交付件脱节**：这些失败只落在**盘点层的 `readable`**（`材料盘点.json`）里，
**交付件的 `scope.inputs[].readable` 是模型在 `refine_scope.py` 里重新手写的一份**（11 条白名单 + 6 条黑名单，见日志）。
没有任何工具把"盘点层的 readable"与"交付层的 readable"对齐——**所以存在一段无证据的自由裁量区**。

### 8.4 根因三（流程性）：文件集合本身不受任何门禁约束

| 环节 | 现状 | 风险 |
| --- | --- | --- |
| 报告审核：附件枚举 | `crwu_audit_case_bootstrap` 按记录字段枚举附件（本案 12 件 / 130 字段）；要下载哪些由模型按 `附件清单.json` 逐件调 `crwu_h3yun_file_get` | 模型漏一件，交付件里就没有这件，没有任何校验能发现 |
| 本地审核：文件枚举 | `crwu_audit_local_claim` 扫描后给 `files[]`（本案 17 件，`skippedCount=0`） | 枚举完整，但**是否每件都读**仍由模型决定 |
| 本地审核上限 | `LOCAL_AUDIT_MAX_FILES = 30`，超限**明确阻断**（`超过单次最多 30 个文件的限制`） | 员工一次丢 100 个文件 → 直接拒绝（正确，但员工感受是"没审完"） |
| 会话 1 的交付集合 | 17 件进 `scope.inputs`，与盘点 17 件逐一对齐 | 这次对齐了，是**模型手工枚举对齐的**（`READ_TRUE` 11 条 + `READ_FALSE` 6 条 + `assert` 总数 17），不是系统保证的 |
| 阶段一隔离 | 复核件按门禁排除（会话 1 的 `初审-互审意见.docx`；会话 2 的 5 件复核件） | 设计正确，但员工视角就是"有文件没被审"；需要更醒目的"这是复核件、阶段一不审、阶段二另行对照" |

### 8.5 为什么没有一处校验拦住它

三处本该拦住的位置，都放行了（源码位置见附录 C）：

1. **`scope.inputs` 没有"必须覆盖全部材料"的约束**：
   `audit_result.schema.json` 里 `scope.inputs` 只要求 `minItems: 1`，entry 必填 `fileId/displayName/version/readable`。
   validator（`audit_delivery.py` §7）只检查 `scope.inputs` 至少一项、`scope.checkDomains` 至少一项、
   `scope.notCheckedItems` 是数组。**没有一条要求"材料清单的每一件都出现在 `scope.inputs`，或出现在 `notCheckedItems`"。**
2. **`readable` 的方向是"默认可读"**：渲染器
   `local_readable = sum(1 for item in local_inputs if item.get("readable") is not False)`
   —— **凡是没写 `readable` 或写成非 `false` 的，都计进"已审核 N"**。少写一个字段，N 就虚高。
3. **没有"文件 × 检查域"的覆盖矩阵**：`scope.checkDomains` 是一串自由文本域名称，
   与 `scope.inputs` 之间没有引用关系，validator 无从校验"每件材料都落进过某个域"。

### 8.6 修复建议

**P0 · 统一"可读"的判定与通道（让读不到成为确定失败，而不是模型的自由发挥）**

1. 把 `prepare_materials.py` / `media_extract.py` 的 `.doc` 通道从 `textutil` 换成**跨平台**：
   优先 DSH 自带 LibreOffice Kit（会话 2 已证明它在机器上存在：
   `C:\DeepSeek Harness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\program\program\soffice.ini`），
   其次内置最小 CFB/OLE 文本解析（把会话 2 现场写的 `工具/doc_text.py` 收编成技能脚本）。
   `.xls` 内嵌媒体同理走 LibreOffice。
2. 把缺依赖（`openpyxl` / `python-docx` / `pypdf` / `xlrd`）**在审计启动前**判成环境门禁，
   而不是等 `prepare_materials.py` 逐件报 `dependencyGaps`。
3. 无文本层 PDF 与图片：把"**逐页渲染 + 宿主视觉判读**"变成流程的固定一步（现在是模型自选抽几页），
   并在交付件里写清"第 X/Y 页已判读"。
4. 本地审核上限（30 件）超限时，除阻断外给出"分批送审"的明确指引。

**P0 · 交付前加覆盖率门禁（让"没审到"变成校验失败）**

5. 新增机械校验：**盘点清单（或 `本地审核清单.json`）里的每一件，必须二选一** ——
   或在 `scope.inputs` 且带非空证据（`materialEvidence` / 引用了它的 `issues` / 该件的 `notCheckedItems`），
   或在 `scope.notCheckedItems` 里带 `reasonCode` + `requiredAction`。
   任一件两边都不在 → `validate` 失败。落点：`scripts/audit_delivery.py` §7 + `audit_result.schema.json`。
6. 把 `readable` 改成 fail-closed：渲染器按 `item.get("readable") is not True` 计"未核"，
   或干脆要求 `scope.inputs[].readable` 与盘点记录**逐件一致**（不一致即拒绝交付）。

**P1 · 把"读到了"和"审过了"拆成两个字段**

7. `scope.inputs[]` 增 `audited: boolean`（或 `checkDomains: string[]`）：
   `readable=true, audited=false` 是**合法但必须显式可见**的组合，员工页面据此把"已读未审"单独列一栏。
   现在这个区别被 `readable` 一个字段吞掉了，正是员工困惑的来源。
8. 信息条改成两个数：「已审核 A/M 件 · 已读取但未形成检查 R 件」，口径写进 `11-html-delivery-spec.md`。

**P1 · 补上"文件 → 检查项"的映射**

9. router 在冻结画像后产出一张**材料覆盖矩阵**：文件 × 归属技能 × 检查域，
   并强制两类兜底：① 每个加载的叶子至少认领一份材料；② 每份材料要么被某个叶子认领，要么明确写出"无人认领"的理由。
10. 给"佐证/程序类文件"（委托合同、经济行为文件、营业执照、资质、章程）一个明确归属：
    要么固定挂 `crwu-audit-public-general-standards`，要么在 router 里新建一条覆盖它们的检查轴。
    现在它们只有在 public 叶子被加载时才可能被审到（会话 1 根本没加载）。

**P2 · 让员工看得懂"为什么这件没审"**

11. 未审核项按原因分三栏呈现：**能力受限（unreadable/unsupported）／本次不适用（复核件、H0 隐藏区、out_of_scope）／材料确实没有（missing_material）**，
    并给出员工动作（"另存为 .docx 或 PDF 后重送"）。
12. 复核件在 HTML 里单独成块：「本次按两阶段门禁未参与阶段一，阶段二已另行对照（对照结论见 X）」——
    现在它只以一条 `notCheckedItems` 出现，员工读到的感觉是"漏审"。

### 8.7 三个可立即自测的验收点

- [ ] 在一台**没有 `textutil`** 的机器上对同一批材料跑 `prepare_materials.py`，`.doc` 必须**不因这条原因失败**
      （走 LibreOffice 或内置解析），且 `材料盘点.json` 的 `readable=true`。
- [ ] 交付件里 `readable=true` 但**没有任何 issue / materialEvidence / notCheckedItems 引用它**的文件数，必须能被校验器报出来。
- [ ] 会话 1 那种"17 件材料"的案子，信息条里的"已审核 N"必须能由盘点层逐件重算，且与 `notCheckedItems` 不重不漏。

---

## 附录 A · 会话 1 时间线速查

```
+ 0.00  claim → 案例目录 D:\中瑞世联工作空间\本地审核\la-1791907346748-9f1a777a
+ 0.01  ask_user_question（复核件口径）……………… 等 69.8s
+ 0.04  隔离复核件 / 材料准备 / 探测 LibreOffice+Excel ……… 234s
+ 8.17  materialize(70 项) ────────────────── 378.9s → 70/70 FAILED
+14.49  找 dws / 看 knowledge/（空）
+14.72  手工复现 export@D: → linkat Incorrect function
+14.93  export@C:（NTFS）→ 14.5s SUCCESS        ← 根因锁定
+15.03  materialize(C:\...\Temp\crwu-kb-stage\case) → policy 拒绝（0s）
+15.09  mklink /J → 失败（D: 非 NTFS）
+15.21  materialize(C:\crwu-kb-stage2) → policy 拒绝（0s）
+15.29  New-Item SymbolicLink → 失败（不支持符号链接）
+15.57  materialize(1 项) ──────────────────── 199.9s → FAILED
+19.22  写 scripts/kb_fetch_exfat.py
+19.34  ▶ 后台启动 kb_fetch_exfat.py（job pwsh-56）
+19.81  派子代理 ×2（企业价值 / 机器设备）
+20.09  派子代理 ×2（交通运输设备 / 存货）      ← 知识库此时 ~48/70
+21.01  knowledge/ 70 件到位
+21.62  70/70 逐件字节校验通过
+22.35  materialize(3 项) ──────────────────── 226.2s → 3/3 FAILED（冗余）
+23.75  子代理：企业价值 完成（3.94 min）
+24.85  子代理：交通运输设备 完成（4.76 min）
+25.01  子代理：存货 完成（4.92 min）
+26.12  第三次 materialize 返回失败
+26.47  子代理：机器设备 完成（6.66 min）
+26.50  合并 findings / 写装配脚本（撞 ENAMETOOLONG 后分段）
+31.0   阶段一冻结 + 渲染
+32.43  present 交付 HTML + JSON → turn/end completed
```

## 附录 B · 故障证据原文（脱敏）

```
[第一次 materialize 返回]
{"ok":false,"errorKind":"cli","error":"70 个清单项取数失败",
 "counts":{"exported":0,"downloaded":0,"skipped":0,"failed":70,"nodes":464},
 "manifest":[{"requested":"02-资产类型/03-企业价值/",
   "path":"03-企业价值/01-共性参考/01-评估审核条目",
   "nodeId":"XPwkYGxZV3M5AayYTp6XmGEL8AgozOKL","extension":"adoc","channel":"export",
   "status":"failed","r...}]}

[手工复现（D: exFAT）]
{"error":{"category":"api",
 "cause":"发布下载文件失败: linkat .dws-download-6880-1 01-评估审核条目.md: Incorrect function.",
 "message":"导出任务已完成但安全下载失败（output=01-评估审核条目.md）",
 "reason":"doc_export_download_failed","retryable":false,"stage":"download",
 "details":{"jobId":"31483196824","status":"incomplete"},
 "actions":["dws doc +export-get --job-id 31483196824", ...]}}

[同一条 export 在 C: NTFS]
steps: [submit: success, poll: success, download: success]   exit=0   14403B

[caseDir policy 拒绝]
{"ok":false,"errorKind":"policy",
 "error":"案例目录必须是**本次本地审核自己的**临时快照目录"}
```

## 附录 C · 关键源码位置（源仓）

| 行为 | 位置 |
| --- | --- |
| 知识库取数工具（串行遍历 + 串行导出 + 失败不早退） | `plugins/dsh-crwu-workbench/src/host/tools/report-audit/knowledge.ts` |
| 树遍历（不并发，逐层 `wiki +node-list --page-all`） | 同上，`readTree()` 第 91–135 行 |
| 逐项导出/下载（`doc +export` / `drive +download`） | 同上，第 348–372 行 |
| 失败只 `continue`、最后聚合报错 | 同上，第 355–359、395–398 行 |
| 案例目录归属门禁（`caseDir` 必须逐字等于本轮案例目录） | `plugins/dsh-crwu-workbench/src/host/domains/report-audit/case-access.ts` |
| 旧版 `.doc` 文本通道（只走 macOS `textutil`） | `plugins/dsh-crwu-workbench/skills/crwu/crwu-audit/scripts/prepare_materials.py` `doc_to_text()` |
| 旧版 `.doc` 媒体通道（同样只走 `textutil`） | 同上目录 `scripts/media_extract.py` 第 391–408 行 |
| `readable` 默认按"非 false 即已审核"计数 | 同上目录 `scripts/audit_delivery.py` 第 2408 行（`local_readable`） |
| validator 对 `scope.inputs` / `notCheckedItems` 的全部约束 | 同上目录 `scripts/audit_delivery.py` 第 1126–1162 行 |
| `scope.inputs` 的 schema（只要求 `minItems: 1`） | 同上目录 `scripts/audit_result.schema.json` |
| 本地审核文件上限与扫描规则 | `plugins/dsh-crwu-workbench/src/host/domains/local-audit/consts.ts`、`scan.ts` |
