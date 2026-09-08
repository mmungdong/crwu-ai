# crwu-dws 技能设计 v0.2 ——「中瑞世联 AI 测试知识库」目录查询 + 知识文档批量下载（钉钉 Wiki 只读）

| 版本 | v0.2（已实现） | 日期 | 2026-09-08 | 状态 | ✅ 已实现：D1–D7 按推荐默认落地（落点见 §9；验收 T1–T9 待注入 dws 环境执行） |
| --- | --- | --- | --- | --- |
| 上游基线 | `v0.1.0`（b06019e） | 归属 | crwu-ai 新功能线（与 crwu-audit 审核能力族平级、互为上下游） | |
| v0.2 变更 | 新增 **M2 知识文档批量下载**：v0.1 只有 M1 目录查询；按用户 2026-09-08 要求扩展"crwu-audit 推理参考文档实时化" | | | |

## 0. 一句话定位

**提示型 skill**：运行于 agent，通过宿主注入的 `dws` CLI（wiki/doc 产品域）以**对钉钉纯只读**方式，围绕「中瑞世联 AI 测试知识库」提供两个模式：

- **M1 目录查询**：解析用户可见范围内全部同名知识库 → 逐库递归导出完整层级目录 → 摘要 + 目录树文本 + 结构化 JSON 快照（带证据）。
- **M2 知识文档批量下载（镜像）**：把 crwu-audit 及其子 skill 推理时依赖的知识文档，按知识库目录结构**批量导出**到案例目录下与源审核数据文件**同级**的 `knowledge/` 目录，供审核时实时参考。

对钉钉零写操作；唯一的"写" = 本地产物文件（M2 含正文内容落盘）。员工继续在钉钉更新文档 → AI 每次审核拿到的是**实时**参考文档。

## 1. 背景与动机

- crwu 生态知识库唯一事实源路线（skills/README §V2.1 + tools/kb/README「迁移/演进」）：本地 `~/.crwu/knowledge/knowledge-base`（CRWU_KB_ROOT）为静态根，规则正文由部署方同步维护；**"钉钉知识库打通后只迁移目录内容并在此统一改根"**。
- crwu-audit 及子 skill 推理时有两类输入：① **源审核数据文件**（材料包：报告/附件/测算表，目录约定由部署环境注入，见 crwu-audit SKILL.md §0）；② **参考知识文档**（规则/清单/案例/口径——员工在钉钉「中瑞世联 AI 测试知识库」持续更新）。
- 现状缺口：②是静态安装/人工同步，员工在钉钉更新后 AI 拿不到实时版。**crwu-dws M2 = 让参考知识文档与源材料在同一个案例目录内"同时新鲜"**：`knowledge/` 与源审核数据文件同级存放，agent 审核时二者并列可读。
- M1 是 M2 的底座（遍历目录树）；同时独立服务"查目录"需求。

## 2. 需求场景（用户故事）

| # | 场景 | 应答 |
| --- | --- | --- |
| US1 | "看下中瑞世联 AI 测试知识库里有哪些目录、每层放了什么" | M1：完整目录树 + 统计摘要 |
| US2 | 有多个同名知识库（组织/个人/不同团队） | M1：全部命中逐一导出，标注各自 workspaceId/范围，不混库 |
| US3 | "某文档是否在这个库里 / 在哪个目录" | M1：在已导出树内按名定位，给完整路径上下文（不猜） |
| US4 | 后续工具要机器可读目录输入 | M1：稳定 schema 的 JSON 快照（references/00） |
| US5 | **员工在钉钉改完规则文档，接下来审报告时要用最新版** | M2：下载镜像到案例 `knowledge/`，内容即钉钉当前版 |
| US6 | **crwu-audit 推理：参考文档与源材料同案并列** | M2：`knowledge/` 与源审核数据文件同级；叶子技能读取口径由 crwu-audit 侧联动登记（§8） |

## 3. 范围与产物

**输入**
- 目标库名：默认固定「中瑞世联 AI 测试知识库」（描述写死为默认触发词，允许临时指定其他库名走同一流程）。
- 模式消歧：用户只要目录 → M1；要求下载/同步/取文档/最新参考 → M2。
- M2 额外参数：目标案例目录（= 源审核数据文件所在目录的**父级**；来源：① 编排者/用户在对话中显式给出；② 部署环境注入的案例目录约定；③ 都没有 → 询问用户，**禁止随意落盘**）。

**产物**

| 模式 | 产物 | 默认路径 |
| --- | --- | --- |
| M1 | ①聊天摘要（命中库数、每库节点/folder/深度、产物路径）；②目录树文本；③目录快照 JSON | `~/.crwu/kb-catalog/<精确库名>/{目录树.md, 目录快照.json}` |
| M2 | ①`knowledge/` 镜像（目录结构 + 文档正文文件）；②镜像清单（nodeId↔本地路径映射/跳过项/证据）；③同镜像目录一份目录快照 | `<案例目录>/knowledge/…` + `.crwu-manifest.jsonl` + `.crwu-directory.json` |

## 4. 明确不做（硬边界）

- **对钉钉零写操作**：不 create/move/copy/delete/改 member/改内容/订阅改动；钉钉侧任何状态不因本技能变化。
- **M2 只收 adoc 正文为文本文件**：adoc → markdown 导出（知识文档以文字规则为主）；**axls/able/其他类型节点 v0.1 不下载正文**，在 manifest 与摘要中如实记入"跳过+原因"（决策点 D7）。不读/不改本地 CRWU_KB_ROOT、不操作 kb_tool。
- **不自动删除**本地旧文件：远端已删除的文档，v0.1 保留本地文件并在摘要列出"远端已不存在"清单供人工清理（防误删）；内容更新=对 manifest 登记的同一 nodeId 原位覆盖。
- 不做库间差异比对/定时镜像/双向往上同步（路线图 §12）；不做审计判断（→ crwu-audit）；泛化钉钉 wiki/doc 管理（→ dingtalk-wiki / dingtalk-doc）。
- **禁止推断**：缺 type/父子/正文导出的字段如实报告；下载失败逐节点记录，不吞错、不宣称全量成功。

## 5. 架构与依赖

- **形态**：提示型 Skill：`skills/crwu-dws/SKILL.md` + `references/`（00-目录快照schema / 01-镜像与 manifest 规范）；无新依赖、不进 crwu Go 构建；源仓 → 运行时 `~/.dsh/skills/crwu-dws` 双份同步（diff -r 为空）。
- **依赖**：`dws` CLI（≥0.2.14，宿主注入）。命令语义权威：目录/节点= `dingtalk-wiki`，正文导出= `dingtalk-doc`（`dws doc +export --export-format markdown`；回执 `localPath`+`sizeBytes>0` 即终态，不二次 ls/stat 验证）；错误时读 `dingtalk-shared` 对应 reference。crwu-dws 不复述权威实现，只固化专用流程与差异约束。
- **上下游**：上游=钉钉知识库（员工维护）；下游=①审核案例目录（M2）②本地 `~/.crwu/kb-catalog`（M1 快照）。crwu-audit 叶子推理时读取 `knowledge/` 的口径变化 = crwu-audit 侧联动事项（§8），不在本技能内改 audit 文件。

## 6. 工作流设计（SKILL.md 将固化的步骤）

### P0 前置断言
`dws` 可用；profile 明确（默认 `isOrgCurrent=true` 账号或用户指定）；**全程同一 profile**。

### P1 模式消歧与库解析（只读）
- 意图→模式（M1/M2）；M2 先确认案例目录（§3 输入③）。
- 分范围全量取空间并精确名匹配：`dws wiki +space-list --type orgWikiSpace|myWikiSpace --limit 50 --page-all --format json`（`+space-search` 仅作候选浏览，不作唯一性证据）。
- 判据：`requestedType` 与请求范围一致；`autoPageComplete=true` 才能用缺席证无；命中 0 → 报告范围+相似候选，不编造；命中 ≥1 → 全部进入处理列表，保留真实 `workspaceId/spaceType` 标注。

### P2 目录遍历（M1/M2 共用；只读，DFS 递归）
- 根层 `dws wiki +node-list --workspace <ID> --page-all`；对 `type=folder` 递归 `--folder <folderId> --page-all`。
- 分页证据每层记录（autoPageComplete/pagesFetched/条目数）；`hasChildren` 仅提示、不作剪枝依据；folder 按 nodeId 去重（二次展开即停并标注异常）。
- 体量防护：节点 >10,000 或深度 >20 → 停止并如实报告部分结果（默认值，实现期可调）。
- 节点字段只取服务端真实返回；未知 type 原样保留不归类。

### P3-M1 产物组装（快照/树/摘要；计数一致才可宣称全量）

### P3-M2 批量下载（镜像；只读钉钉 + 本地写）
1. 在案例目录下建 `knowledge/`；镜像远端 folder 结构为本地同名子目录（目录名冲突时追加 `-<nodeId前8>`；文件名清洗非法字符，空/重复名同样处理）。
2. 逐 adoc 节点执行 `dws doc +export --node <nodeId> --export-format markdown`（导出到 cwd 相对路径的临时区），据回执 `localPath`（终态）移动到规范路径 `<folder路径>/<节点名>.md`（与既有 manifest 登记冲突时按 nodeId 判同：同 nodeId → 原位覆盖=更新；不同 nodeId 同名 → 追加后缀）。
3. 顺序执行、串行限流（大批量时不并发打爆导出接口）；每个节点：成功 → manifest 记 `{nodeId, name, type, folderPath, localPath, exportedAt, evidence}`；失败 → 记 `{nodeId, error}` 到 failures，继续后续节点，**不中断整批**（除非认证/权限类系统性错误 → 停止走 dingtalk-shared）。
4. 非 adoc 节点（folder 已建目录除外）：manifest 记跳过+原因；axls/able 等是否后续支持见 D7。
5. 收尾：manifest 与目录快照（`.crwu-directory.json`）写入 `knowledge/`；摘要报告：成功 N/跳过 S/失败 F、远端已删除清单、产物路径。

### P4 一致性自查
- M1：节点计数 == 遍历完成计数（失败分支如实减除）。
- M2：成功数+跳过数+失败数 == 目录树中 folder/adoc 相关节点总数；重跑幂等、manifest 稳定；不一致 → 不宣称完成并附证据与部分结果。

## 7. SKILL.md 结构草案

- frontmatter：`name: crwu-dws`；description 触发词：知识库「目录/层级/树/结构」查询，以及「下载/同步/镜像/最新/实时 参考知识文档（到本次审核材料旁）」等。
- **不触发**：泛化钉钉 wiki/doc 管理（→ dingtalk-wiki / dingtalk-doc）、本地知识库/规则正文查询（→ 不适配或对应本地工具）、审核材料本身（→ crwu-audit）。
- 正文（≤300 行）：P0–P4 + 只读断言 + 证据纪律 + M1/M2 产物规则 + 错误最短路径（认证/权限/profile/未知命令只读 `dingtalk-shared` reference）。
- `references/00-目录快照schema.md`：快照 JSON schema + 渲染规则。
- `references/01-镜像与manifest规范.md`：knowledge/ 落盘布局、命名与冲突规则、manifest JSONL 格式、幂等/覆盖/残留语义、摘要口径。

## 8. crwu-audit 联动登记（下游消费方——不在本技能内改，登记为联动事项）

- M2 产出的 `knowledge/` 是 crwu-audit 叶子推理时的**实时参考目录**；`~/.crwu/knowledge/knowledge-base`（CRWU_KB_ROOT 静态根）仍是**发布/门禁口径**（A 门禁、试点判定）。
- 叶子技能"推理时参考"与"发布门禁"两套口径的读取优先级/路径约定由 crwu-audit 族维护（走 `crwu-audit-optimize` 流程：引用落点、校验回归、双份同步）——本设计不预先改写 audit 文件，仅在实现 M2 后于 changelog/README 登记契约：**案例 `knowledge/` = 实时参考；CRWU_KB_ROOT = 门禁基准**，二者差异由人工/复核判定。

## 9. 登记与部署（实现阶段清单——确认 §10 后执行）

1. 新增 `skills/crwu-dws/SKILL.md` + `references/00-目录快照schema.md` + `references/01-镜像与manifest规范.md`。
2. `skills/README.md` 技能总表加行（提示型；注明与 dingtalk-wiki/doc 边界、M2 下游=案例 `knowledge/`）。
3. `docs/CHANGELOG.md` 追加 docs 纪要（无 crwu CLI 命令变更）。
4. 本文档状态 → 已实现。
5. 同步运行时 `~/.dsh/skills/crwu-dws`（diff -r 为空）。
6. 提交 main（基线 v0.1.0 之上）。

## 10. 决策点（请用户确认；默认=推荐项）

| # | 决策 | 选项 | 推荐 |
| --- | --- | --- | --- |
| D1 | 技能形态 | ① 单技能双模式（M1+M2，同一 SKILL.md 内消歧）② 拆两个 skill（crwu-dws / crwu-dws-download） | ①（都围绕同一库同一遍历底座；族化时机成熟再拆，保留 `crwu-dws-*` 前缀空间） |
| D2 | M1 快照落盘 | ① 落盘 `~/.crwu/kb-catalog/<库名>/` ② 仅聊天展示 ③ 自定义 | ① |
| D3 | 解析范围 | ① 组织+个人双范围全扫、多命中全导 ② 仅组织 ③ 仅个人 | ① |
| D4 | 目标库名 | ① 默认写死「中瑞世联 AI 测试知识库」+ 允许临时指定 ② 完全通用 | ① |
| D5 | 登记范围 | ① 仅 skills/README 加行 ② 同时进 crwu-audit 路由注册表 | ①（异族） |
| D6 | **M2 案例目录定位** | ① `knowledge/` = 案例目录（源审核数据文件所在目录的父级）下、与源文件同级；案例目录由 编排者显式给/部署约定注入/询问用户，禁止猜 ② 其他约定（请给出实际案例目录样例） | ①——实现期请用户提供**一个真实案例目录样例**校准措辞 |
| D7 | **M2 非 adoc 节点** | ① v0.1 跳过+如实报告（axls/able 后续加）② 一并支持（axls 导出等——实现与验收成本高） | ① |

## 11. 验收用例（实现后执行；本机 PATH 无 dws，须在注入环境跑，或部署方装 dws 后复跑，changelog 记录验证方式）

| # | 场景 | 通过标准 |
| --- | --- | --- |
| T1 | 库唯一存在（默认名）M1 | 解析唯一 → 全树导出；摘要与快照计数一致；证据字段齐全 |
| T2 | 无此名/空库 | 如实零命中报告（范围+分页完成证据），不编造 |
| T3 | 同名多个（组织+个人） | 全部导出，标注各自 workspaceId/范围，产物不混库 |
| T4 | 中途分页失败/网络错 | 结构化失败+已得部分如实标注，不宣称全量 |
| T5 | M1 全程只读审计 | 会话 wiki 域仅 space-list/space-get/node-list/node-search 类只读命令 |
| T6 | M2 混合类型库 | 全部 folder 建成目录、adoc 全部导出 md 且与 manifest 一一对应；axls/able 在 manifest 记跳过；摘要 N/S/F 与树一致 |
| T7 | M2 幂等重跑 + 内容更新 | 重跑全量覆盖成功、manifest 稳定；钉钉改文后再跑 → 本地文件内容变新（同 nodeId 原位覆盖） |
| T8 | M2 失败注入 | 某节点导出失败 → failures 记录、其余继续、不宣称全量成功 |
| T9 | M2 目标目录纪律 | 未提供案例目录且无部署约定 → 询问用户而非随意落盘 |

## 12. 演进路线图（非本轮）

1. M2 增量优化：按 doc 版本/更新事件跳过未变化节点（成本收益需实测，v0.1 全量覆盖保证"实时"语义最简单可靠）。
2. 非 adoc 下载扩展（axls/able/附件），按知识库实际内容再定。
3. 定时/按需镜像 + 目录 diff（快照×快照），支持"钉钉即事实源"的同步审计与清理建议自动化。
4. tools/kb 远端化（`resolve/query/release` 换远端实现，`assemble` 契约不变——改动走 tools/kb 维护纪律）。

---

## 附录 A：目录快照 JSON schema（草案，M1/M2 共用）

```jsonc
{
  "schema": "crwu.kb-catalog.snapshot.v1",
  "generated_at": "ISO8601",
  "profile": { "id": "…", "isOrgCurrent": true },
  "space": {
    "name": "中瑞世联 AI 测试知识库",
    "workspaceId": "…",
    "spaceType": "orgWikiSpace|myWikiSpace",   // 只取服务端真实返回
    "scope_evidence": { "requestedType": "…", "autoPageComplete": true, "pagesFetched": 1 }
  },
  "stats": { "total_nodes": 0, "folders": 0, "max_depth": 0, "complete": true },
  "nodes": [   // 前序展开序
    {
      "nodeId": "…", "name": "…",
      "type": "folder|adoc|axls|able|appt|adraw|amind|未知原值",
      "parentFolderId": null, "depth": 0,
      "children": [ … ],
      "evidence": { "hasChildren": null, "page": { "autoPageComplete": true } }
    }
  ],
  "failures": []   // 空=完整
}
```

## 附录 B：M2 `knowledge/` 布局与 manifest 草案

```
<案例目录>/
├── <源审核数据文件…>          # crwu-audit 材料包（部署约定注入，与本技能无关）
└── knowledge/                 # ← crwu-dws M2 落点（与源文件同级）
    ├── <顶层folder>/<子folder>/<文档名>.md
    ├── <文档名>-<nodeId前8>.md        # 仅同名冲突时
    ├── .crwu-manifest.jsonl           # {mode:"M2", schema:"crwu.kb-mirror.manifest.v1", space:{…}, exportedAt, entries:[…], skipped:[…], failures:[…], stale_remote_deleted:[…]}
    └── .crwu-directory.json            # = 附录 A 快照（该库）
```

entry 行示例：`{"nodeId":"…","name":"00-总纲-治理","type":"adoc","folderPath":"knowledge/00-总纲","localPath":"knowledge/00-总纲/00-总纲-治理.md","exportedAt":"…","evidence":{"export":{"localPath":"…","sizeBytes":1234}}}`
