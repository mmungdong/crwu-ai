# crwu-dws 技能设计 v0.6

| 版本 | v0.6 | 日期 | 2026-09-15 | 状态 | ✅ 已确认并实施 |
| 变更 | v0.6：取数按节点 `extension` 分流的**双通道**（`adoc`→`doc +export`；`md`/`txt`→`drive +download`；其余→`skipped`），修复「原生 `.md` 正文被 `doc +export` 必然失败并误记为 failure」的通道缺陷 | | | |
| --- | --- | --- | --- | --- |
| 归属 | crwu-ai，与 crwu-audit 族平级协作 | 远端权限 | 钉钉只读 | |
| 正文来源 | 钉钉知识库 | 本地持久层 | 无正文目录缓存 | |

## 1. 定位

crwu-dws 通过宿主注入的 `dws` CLI，为审核流程提供目录查询、按清单下载和路径定位：

- **M1 目录查询**：解析目标知识库，递归遍历目录，写无正文的目录元数据缓存。
- **M2 审核下载**：按本次审核清单下载知识正文；清单支持单文件和目录路径。
- **M3 路径查找**：按文件名、库内路径或 nodeId 查目录索引；需要正文时仍从钉钉现场下载。

crwu-dws 不做审核判断，不向钉钉写入任何内容。

## 2. 数据边界

### 2.1 正文

- 唯一来源是钉钉知识库。
- 每次审核重新下载，只能用于当前审核。
- 可以落入当前案例 `knowledge/` 工作集或系统临时目录。
- 不得写入目录缓存，不得跨审核复用。

### 2.2 目录元数据

目录元数据可以缓存到：

```text
~/.crwu/knowledge/dws-dir-cache/<库名>/
├── 目录快照.json
├── 目录树.md
├── node-index.json
└── .cache-meta.json
```

缓存只包含目录结构、节点元数据、路径索引和刷新证据。缓存损坏或未命中时重新在线遍历；缓存身份与目标知识库不一致时清理后重建。

## 3. 只读命令边界

- wiki：`space-list`、`space-search`、`space-get`、`node-list`、`node-search`、`node-get`。
- doc：仅 `+export`（`extension=adoc`）。
- drive：仅 `+download`（可读原生文本 `md`/`txt`）。
- 未知命令或参数先读取对应 leaf help；不得连续猜测。
- profile 在解析、遍历和取数过程中保持一致。

### 3.1 取数通道按 `extension` 分流（v0.6）

服务端文档节点的 `nodeType` **恒为 `file`**，格式信息只在 `extension`/`contentType`；`doc +export` 只支持 `extension=adoc`。整改前 M2 对所有文档一律调用 `doc +export`，导致知识库中 25 个原生 `.md` 正文（`03-评估方法/` 整支）每次审核都必然失败并被记成 failure，且两道门禁（`kb_tool validate`、`check_audit_skill_mappings`）都只看"路径键是否存在"，看不出节点类型不可读。

| `extension` | 通道 | 落地 |
| --- | --- | --- |
| `adoc` | `dws doc +export --export-format markdown` | `<节点名>.md` |
| `md` / `txt` | `dws drive +download` | `<节点名>.<extension>`（原件即正文，不转换） |
| 其余（`pdf`/`docx`/`xlsx`/`exe` …） | 不取正文 | `skipped` + 真实 `extension`；**不得记为 failure** |

- 通道必须由 `extension` 判定，**禁止"先 `doc +export` 试一次、失败再换通道"**：试错会把必然失败记成偶发 failure 并污染 manifest。
- `extension`/`contentType` 由 M1 遍历写入快照与 node-index；旧缓存缺该字段时逐节点补查 `wiki +node-get`（只读），**不按名称后缀猜**。

## 4. M1 目录查询

1. 在组织与个人范围内按精确库名解析空间。
2. 对每个命中空间执行 DFS；每层使用完整分页并记录证据。
3. folder 按 nodeId 防环；上限 10,000 节点、20 层。
4. 只有遍历完整且无 failure 时才原子替换目录缓存。
5. node-index 同时维护 `by_node_id`、`by_name` 和 `by_path`。

## 5. M2 本次审核下载

输入是库内层级路径数组 `paths[]`，同一清单可以混合：

- **单文件路径**：不以 `/` 结尾，精确命中一个 adoc，**只下载该文件**。
- **目录路径**：以 `/` 结尾，命中 folder 后**递归下载**全部支持正文。

处理流程：

1. 按原始顺序解析清单项。
2. 缓存未命中时刷新目录并重查。
3. 目录项展开后与文件项合并，按 nodeId 去重。
4. 逐节点按 §3.1 判通道后串行取数（`adoc` 导出 / `md`·`txt` 下载）；取不到正文的类型记 `skipped`，不记 failure。
5. 写当前审核 `knowledge/` 与 `.crwu-manifest.jsonl`（entry 记 `extension` + `channel`）。
6. 报告成功、跳过和失败（三者分开统计）；清单外零下载。

M2 不提供整库备份或其他与本次审核清单无关的下载能力。

## 6. M3 查找和现场正文

1. 输入精确文件名、nodeId 或库内路径。
2. 先检查与目标知识库身份一致的目录索引。
3. 未命中或缓存损坏时在线刷新，再重查。
4. 多命中时列出全部路径，请调用方消歧。
5. 需要正文时按 §3.1 同一 `extension` 分流规则现场取回到当前审核工作集或临时目录，并登记 `exportedAt`。
6. 在线刷新失败时可以用旧目录元数据回答“可能的位置”，但不能返回任何旧正文。

## 7. manifest

使用 `crwu.audit-download.manifest.v1`：

- header：空间、案例目录、开始时间。
- entry：requestPath、requestKind、nodeId、库内路径、`extension`、`channel`、localPath、exportedAt、取数回执。
- skipped：不支持类型与真实 `extension`（**与 failure 分开统计**，不得并入 failure）。
- failure：原始路径、已知节点信息与错误。

同一审核重跑时路径可以保持稳定，但正文仍需重新导出并更新时间。

## 8. crwu-audit 协作

crwu-audit 汇总：

- 总路由所需执行契约；
- L1/L2 命中技能的装配表；
- 覆盖层与校准所需文件。

明确文件使用单文件路径；确需一组完整资料才使用目录路径。crwu-dws 只执行该清单，叶子技能只读取本次下载物。完整协议见 `docs/design-audit-live-kb-protocol.md`。

## 9. 错误处理

| 错误 | 行为 |
| --- | --- |
| 空间零命中 | 报告范围与相似候选，不编造 |
| 分页不完整 | 不更新正式缓存，不宣称全量 |
| 单文件路径歧义 | failure，不猜 |
| 目录路径类型错误 | failure，不自动改路径 |
| 取数失败 | failure；系统性认证错误时停止后续取数 |
| `extension` 非 adoc/`md`/`txt` | `skipped`（正常结论），**不得记为 failure** |
| `extension` 缺失且 `node-get` 补查仍不可判定 | `skipped`（"类型不可判定"），不猜不试 |
| 缓存不可写 | 报告路径问题，不改存正文 |

## 10. 验收用例

| 用例 | 通过标准 |
| --- | --- |
| M1 完整遍历 | 节点计数一致，缓存原子更新 |
| M1 不完整遍历 | 保留旧缓存并明确未更新 |
| M2 单文件 | 只下载指定文档 |
| M2 目录 | 递归下载目录内支持文档 |
| M2 混合 | 两类条目均生效并按 nodeId 去重 |
| M2 通道分流 | `adoc` 走导出、`md`/`txt` 走下载，manifest `channel` 与 `extension` 一致 |
| M2 原生 md | 目录内原生 `.md` 正文成功取回（不再记 failure） |
| M2 类型不支持 | 记 `skipped` 且不出现在 failure 列表 |
| M2 范围 | manifest 无清单外正文 |
| M3 缓存命中 | 返回路径上下文，不读取正文 |
| M3 正文请求 | 从钉钉现场导出并登记时间 |
| 跨审核 | 不复用上一审核正文 |

## 11. 演进方向

1. 扩展 axls、able 与其余原生附件（pdf/docx/xlsx）的只读导出——按同一 `extension` 分流表追加通道，不改动 adoc/`md` 既有分支。
2. 优化目录缓存刷新时机，不改变正文来源边界。
3. 为路径清单增加结构化 schema 校验和端到端测试。
