# tools/kb —— 知识库只读索引 / 自动校验 / 装配清单

> 定位：技能与知识库协同的机器侧工具（只读 KB、生成/校验索引、按画像出装配清单）。
> 本文档 = 源仓维护者视角；**工具不随 skill 安装**——运行时如需由 agent 调用，
> 由部署环境注入可执行路径（技能/装配表内均已写"注入或手工装载"双轨）。

## 为什么存在

- 技能按 RULE/CHK 编号引用规则 → 需要"编号 → 文件 + 行号区间 + 发布状态 + hash"的确定性解析；
- 发布/试点门禁、审核快照复现需要机器可查的状态口径（不靠人读月度发布清单猜）；
- 防止"索引/清单/README"变成需要人肉同步的第二份事实源——全部由本工具从 md 生成并校验。

## 运行

```bash
export CRWU_KB_ROOT=~/.crwu/knowledge/knowledge-base   # 缺省即此值
python3 kb_tool.py index        # 生成 00-总纲/治理/kb-index.jsonl（首行 _meta，勿手改）
python3 kb_tool.py validate     # 新鲜度/编号唯一/发布字段/词表（warn）
python3 kb_tool.py validate --skill-root <crwu-ai>/skills                              # +引用路径存在性/旧树残留/省略号 + 实时协议 lint（仅 crwu-audit* 目录：根路径/nodeId 检查）
python3 kb_tool.py validate --skill-root <crwu-ai>/skills/crwu-audit-realestate-rent --forbid-literal 中瑞世联  # 禁库名示例（--forbid-literal 作用于该 root；crwu-dws 自带默认库名，勿对其目录加中瑞世联）
python3 kb_tool.py release --list
python3 kb_tool.py resolve RULE-01-02-551 CHK-MKT-001
python3 kb_tool.py query --release pending --module M-市场法
python3 kb_tool.py assemble --profile examples/rent-market.json --out 装配清单.md
python3 kb_tool.py extract RULE-01-02-551   # 打印规则段落原文
```

## 子命令

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `index` | 解析全部 md 的定义锚点（`### RULE-…`/`### CHK-…`），生成/刷新索引 | 0 |
| `validate` | ①索引新鲜度（文件 hash 比对）②定义锚点编号唯一 ③已发布条目须带 curated_by/reviewed_on ④词表外取值（warn）⑤`--skill-root` 引用路径存在性/旧树标记/`KB/…` 省略号 ⑥`--skill-root` **实时协议 lint**（crwu-audit* 目录内：禁 本地 KB 根字面 `CRWU_KB_ROOT=`/`~/.crwu/`/`knowledge-base`、禁硬编码 nodeId 赋值；`--forbid-literal` 追加禁知识库名称等字面） | 0 全过；1 有 error |
| `resolve` | id → 文件:行号区间/发布状态/hash/标题 | 0 / 1(有 id 未找到) |
| `query` | 按 type/release/module/dims 过滤 | 0 |
| `release` | 发布状态汇总（试点模式判定依据） | 0 |
| `assemble` | profile JSON → 装配清单 md（命中/排除及原因/门禁），确定性排序 | 0 |
| `extract` | 按 id 打印条目段落原文（供引用原文） | 0 |
| `selftest` | 解析/匹配逻辑自检 | 0 |

## assemble 语义（确定性规则，v0.1）

- 候选 = modules 与画像相交 **或** dims（object/method/scenario，空=通用）任一命中；
- 命中 = 候选且 object_type/method/scenario 无冲突（stage 不作硬过滤，由叶子按材料分区判）；
- 排除 = 候选内未命中者 + 一条原因（如"method 不命中（收益法 vs 市场法）"）；
- 输出含发布门禁段：命中含 pending → **试点模式**；agent 仍须按文本复核，本清单只保证命中面不漏、可复现。

## 校验口径要点

- 编号唯一性只认**定义锚点**（`### RULE-…` 标题行）；正文里的区间引用（如 `543~578`）不视为定义；
- `validate` 的 error 级别应接入：KB 变更后 / skill 引用改动后 / 每次发布动作后；
- 词表校验为 warn（复合取值如 `object_type[不动产评估/单项资产-房建]` 允许由人工判读）。
- 实时协议 lint ⑥（2026-09-08）：crwu-audit 族技能内禁 本地 KB 根字面（`CRWU_KB_ROOT=`/`~/.crwu/`/`knowledge-base`）与 nodeId 硬编码——推理引用实时化后技能只写 编号+库内层级路径，正文由 crwu-dws 按清单实时下载（设计见 docs/design-audit-live-kb-protocol.md）；知识库名禁用经 `--forbid-literal` 传入。纪律文本（含"禁止/不写…字面"）自动豁免。

## 迁移/演进（钉钉知识库打通时）

- 全部命令以 `CRWU_KB_ROOT` 为准 → 迁移到钉钉知识空间后：导出/同步内容到新根，改环境变量即可重跑；
- 若钉钉端支持元数据查询，可把 `resolve/query/release` 换实现为远端 API，`assemble` 契约不变；
- 版本/发布批次管理（kb-manifest、git）另行设计，本工具不含。
- 推理引用实时化方向（2026-09-08，crwu-dws × crwu-audit 实时引用协议，docs/design-audit-live-kb-protocol.md）：技能引用改"编号+库内层级路径"，正文按本次审核清单实时下载（文件零缓存、目录可缓存）；本地静态根降级为 维护/发布登记/离线归档（不冒充实时）。`--skill-root` 引用存在性校验过渡双轨（本地静态根 OR crwu-dws 目录快照）；dws 验收环境就绪后切快照校验。
