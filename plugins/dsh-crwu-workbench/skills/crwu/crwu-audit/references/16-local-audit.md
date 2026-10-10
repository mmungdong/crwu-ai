# 16 · 本地审核（本机文件，一次性交接）

> 本文件只在**提示词里带 `handoffId` 且写着「本地审核」**时读取。
> 其余情况（材料包 / `SeqNo` / `ObjectId`）一律走 `01`–`15` 的报告审核路径，本文件不适用。

## 1. 它是什么

用户在本机选了若干文件/文件夹，Workbench 把它们复制进一个**案例目录**，生成一次性
`handoffId`，并（尽量）自动开一条新对话把固定提示词发过去。这条链路：

- **没有氚云记录、没有报告流水号、没有人工复核件**；
- **不上传、不回传**任何产物（OSS 发布与钉钉那两件都不做）；
- 结果只存在于这次对话与那个案例目录（`<工作空间>/本地审核/<handoffId>/`）里。

## 2. 第一步：认领交接（唯一入口）

调一次模型可见的 Tool：

```text
crwu_audit_local_claim({ handoffId: "<提示词里的 handoffId>" })
```

返回里 `caseDir` 就是**本轮案例目录**（绝对路径：`<工作空间>/本地审核/<handoffId>`，也是可写范围），`files[]` 是材料清单，
`skipped[]` 是没有进入审核范围的文件与原因。

- `ok:true` → 继续；之后所有案例内 Tool 的 `caseDir` 参数都用返回的这一个路径。
- `ok:false` → **立即停止**，把 `error` 原文交给用户。**不许**自己去本机目录找文件、
  不许按文件名在别处搜索、不许"重新扫描"用户磁盘。过期/已用/快照不在时，正确处置是
  让用户回 Workbench 重新准备。

## 3. 审核范围

- 材料只在 `<caseDir>/材料-源/` 之下；`<caseDir>/本地审核清单.json` 是这一轮的权威清单。
- **氚云相关的步骤一律记「不适用」**（不是"缺失"）：记录快照、附件定向下载、复核件隔离、
  隐藏区授权、复核对照与命中率，这七件在本地审核里都没有输入。写成 `scope.limitations[]`
  与 `externalDataVerification.applicability.reason` 里的**不适用**，不要伪造成缺件。
- `skipped[]` 里的文件必须逐条进入「未审核」，并写明原因。
- 规则与知识库仍然照常：按其他 reference 走 `crwu_audit_knowledge_materialize` 实时下载，
  结论必须落到条文（沿用 SKILL.md 的三条硬立场）。

## 4. 交付（只在案例目录里）

- 项目 ID 用 `handoffId`（形如 `la-<时间戳>-<随机段>`，本身就是安全的文件名）。
- 成对落盘：`审核结果.<项目ID>.json` 与 `审核意见.<项目ID>.html`，调用序列与校验口径
  仍以 `11-html-delivery-spec.md` 为唯一权威（`validate` 先行，通过后 `render --json-out`）。
- **不许**调用 `crwu_audit_oss_publish` / `crwu_audit_dingtalk_archive` /
  `crwu_audit_dingtalk_notify_self`：本地审核没有云端交付这一层。Host 侧对这三条**真的拒绝**
  （返回 `policy` 失败并说明"本地审核的产物只留在本机案例目录里"）——
  看到这条失败是**设计如此**，不要去查配置、不要换目标、也不要改道手工上传。
- **必须标记为本地审核**：`auditTask.mode` 写 `"local"` —— 渲染器据此把标题换成
  **「本地审核报告 - 项目ID」**、在首屏加一条 `本地文件审核 · 生成时间 · 已审核 N/M 个文件`
  的信息条（N/M 由渲染器从 `scope.inputs` 的 `readable` 数出来，**不要自己写数字**），
  并把阶段二说明写成「本地审核没有人工复核件，阶段二复核对照不适用」。
  `auditTask.projectId` = `handoffId`（`la-…`，本身就是安全文件名）；
  `auditTask.profile.objectType` 与 `scenario` 写「本地文件审核」。
  逐件可读性照常进 `scope.inputs[].readable`，跳过的文件进 `scope.notCheckedItems[]`。

### HTML 的读法顺序与四种状态（**复用既有 renderer，不另写模板**）

本地审核与报告审核**共用同一个渲染器**（`scripts/audit_delivery.py` + `template/audit-report.html`）：
`auditTask.mode = "local"` 只换标题、加信息条、改阶段二措辞，其余版式一个字不改。
所以你要做的是把下面这些内容**放进既有区域**，而不是另建一套页面：

| 员工要看到的 | 落在哪里 |
| --- | --- |
| 审核范围 | `scope.inputs[]`（文件表：文件名 / 版本 / 可读）+ `summary.narrative` |
| 总体结论 | `summary.overallDecision` + `summary.narrative` + `summary.counts` |
| 项目画像 | `auditTask.profile.*`（对象类型 / 方法 / 场景 / 环节 + `routeProfile`） |
| 文件覆盖范围 | `scope.inputs[].readable`（已审核）与 `scope.notCheckedItems[]`（未审核） |
| 计算表分析 | 对应问题项的 `module` / `materialEvidence`（工作簿 + sheet + 单元格） |
| 问题清单 | `issues[]`（每条两段式描述 + 双证据链） |
| 未审核文件 | `scope.notCheckedItems[]`（一条一件，写原因与需要的动作） |
| 缺失与不可用字段 | `scope.limitations[]` + `externalDataVerification.applicability` |

四种状态必须**用图标 + 文字 + 颜色共同**表达，四类含义不许混：

| 状态 | 含义 | 落点 |
| --- | --- | --- |
| 没有该数据 | 输入里根本没有这一项 | `scope.limitations[]`（写「输入未提供」） |
| 数据存在但处理失败 | 有材料，解析 / 重算 / 读图失败 | `scope.notCheckedItems[]`（`reasonCode=unreadable`） |
| 当前类型不适用 | 例如氚云复核对照 | `reviewComparison.status=not_performed` + 说明 |
| 文件没有被审核 | 在 `skipped[]` 里 | `scope.notCheckedItems[]`（写跳过原因） |

颜色只用渲染器既有 tokens（成功 / 警告 / 错误 / 中性）。**不许**用大面积红底，
也不许只靠颜色表达状态。

## 5. 对话里的汇报口径

开始时一句简短阶段说明（不假装有进度条）：

```text
本地审核已开始。

审核范围：12 个文件
计算表：3 个工作簿，8 个工作表
跳过：1 个文件

当前阶段：正在分析文件内容
```

结束时固定三段，并**在前面补一块交付件路径**：

```text
本次本地审核已完成。

交付件（完整路径，方便直接点开）：
- <caseDir>/审核意见.<项目ID>.html
- <caseDir>/审核结果.<项目ID>.json

已审核：
- <文件名>

未审核：
- <文件名>：<原因>

画像缺失：
- <画像字段>：<为什么拿不到>
```

- **交付件必须写完整路径**（`crwu_audit_local_claim` 返回的 `caseDir` 拼上文件名）。
  只写文件名会让界面把链接按**这条会话的工作空间根**解析，指到一个不存在的路径 ——
  点了什么都不发生（用户实测反馈）。也不要编 Markdown 假链接。
- 「画像缺失」只写**输入里确实没有**的字段；「未核」与「缺失」必须分开写。
