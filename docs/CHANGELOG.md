# 变更纪要（CLI Changelog）

> 维护纪律（见 `AGENTS.md`）：**每次 CLI 功能新增 / 变更 / 删除**（命令、参数、
> 环境变量、输出契约、通道行为），必须在本文档**追加**一条纪要，并同步更新
> [`docs/cli-manual.md`](cli-manual.md)（Agent 使用说明书）。
>
> 条目格式：`日期 · 类型 · 标题`，类型沿用 Angular 词表（feat / fix / refactor /
> docs / chore），正文写明**影响命令**与关键说明。

---

## 2026-09-16 · feat(crwu-audit) · 编排层加"角色定位（审核立场）"：资深资产评估师 + 三条硬立场

- **位置**：`crwu-audit/SKILL.md` 顶部（frontmatter 后、`## 职责与边界` 前），执行前先读到。
- **三条硬立场**：① **报告说明与法律依据必须落到条文**——引用的每处依据都回溯到本次经 `crwu-dws` 实时下载的
  规则正文并给出条款与出处，不得凭印象、经验或常识引法条；法律/监管适用存疑只登记
  `manualConfirmationItems[]` 或 `capability gap`，不擅自下确定性结论；底线＝结论不越出证据、审核不违反
  法律法规与执业准则。② **测算表必须逐格可复算**——一切数字结论以表内公式/缓存值或引擎重算值为准，
  禁止心算、估算与"看起来合理"；算不出来（未重算、缺依赖、隐藏区引用）必须明示"未核"，
  不得写成"已核"或"材料缺失"。③ **严谨 ≠ 加严**——不制造问题、不上调严重度，
  严重度只由规则影响与证据强度决定，不发表超出规则与材料的价值判断。
- **边界**：不改变任何既有门禁（H0 隐藏区禁读、两阶段隔离、防幻觉协议、双证据链、"未核 ≠ 缺失"），
  冲突时以门禁为准；本期不动交付层（送达规范 / schema / 模板）。
- **验证**：router 契约 15/15（含"router 不得出现 L1/L2"断言）、`kb_tool validate` error=0、`git diff --check`。

## 2026-09-16 · feat(skills) · crwu-audit 送达模板重构为客观复核评分与任务优先阅读

- **页面层级**：首屏标题改为“中瑞世联AI审核报告 - [报告流水号ID]”，正文依次呈现 AI 检出问题、AI 外部数据核验、人工复核对照、
  客观评分卡、人工确认、审核依据与追溯信息；问题位置和描述直接显示，修改意见及规则/材料/差异/结论分别进入带计数的明确展开控件。
- **范围状态**：“可读”列以绿色 `✅` / 红色 `❌` 取代 True/False，并保留可读/不可读无障碍标签。
- **严重程度配色**：高/中/低改用深珊瑚红、琥珀橙、沉静蓝；取消整张问题卡片的大面积渐变底色，保留左侧色条和浅色标签以降低视觉噪音。
- **修改意见折叠**：问题卡片默认只保留位置与问题描述；修改意见收进带条目数的明确展开控件，展开后逐条显示文件、定位和动作，打印时自动完整展开，避免问题较多时页面过长。
- **复核契约**：新增 `reviewFiles[]` 与 `reviewItems[]`，按文件顺序和复核级次展示全部意见；`L-unclosed`
  同时展示答复证据与被审件未落实证据并优先告警；已关闭假阳性不得继续保留为有效问题。
- **评分口径**：员工端不再呈现主观六维 0–10 自评分；严格命中率=`exact/evaluable`、覆盖率=
  `(exact+partial)/evaluable`，`L-resolved` 与 `L-uncheckable` 不进分母，全部使用百分数并由逐条明细重算。
- **版本与兼容**：送达规范和样例升至 v1.1，renderer 升至 `renderer/1.2.1`；旧版复核汇总与 `aiScorecard`
  仍可校验/读取，但旧六维分仅作为历史兼容信息，不进入员工端客观评分卡。
- **验证**：扩充契约测试，覆盖信息顺序、折叠行为、复核文件顺序、逐级明细、百分比重算、分母排除、
  L-unclosed 证据和假阳性一致性。

## 2026-09-16 · fix(crwu-audit) · 引用隐藏区只出"人工建议检查项"，不再作为 AI 问题

- **口径变更（反转 2026-09-15 口径）**：审核只要可见区公式计算正确即可。可见格公式引用了隐藏行/列/隐藏表时，
  该可见结果记 `manualConfirmationItems[]`（人工建议检查项、`review_required=true`），**不出 `issues[]`、
  不计入 `fail`、不据此升级严重度**；建议项只为"被可见公式引用的隐藏区"出，表内仅存在隐藏行/列而不参与计算的不出。
- **不变边界**：H0 仍禁读隐藏区值/公式（要读属 H1 授权）；**可见区自身**算错（勾稽不符、重算≠缓存值）
  照常按普通可见区缺陷出问题，不因涉及隐藏区加严或放松。
- **落点**：`references/00-input-and-route-profile.md` §Excel、`references/12-leaf-common-contract.md` §7.1、
  `SKILL.md` 步骤 3、`crwu-audit-datacheck/SKILL.md`（C7 去向 + 边界纪律）、
  `scripts/prepare_materials.py`（新增 `hiddenRefDisposition` 元数据，`hiddenRefs`/`calcChainNotReproducible`
  字段名与行为不变）、契约测试。
- **验证**：`test_prepare_materials.py` 27/27、`test_media_extract.py` 13/13、router 15/15、`kb_tool validate` error=0。

## 2026-09-16 · docs(crwu-audit) · 加"长任务 3 分钟介入准则"，禁止 agent 空转

- **背景**：编排层要跑附件下载、知识库批量下载、材料准备、交付渲染等外部长任务，此前无统一停滞判据，
  agent 可能静默等待或空轮询，既拖长交付又掩盖真实故障。
- **内容**：`crwu-audit/SKILL.md` 在「输入」与「路由流程」之间新增「执行纪律」节（执行前先读）：
  同一命令/后台作业连续 **3 分钟无新输出且无状态变化**即视为停滞；3 分钟是**介入触发器**（查状态 → 查原因 →
  处置 → 留痕），不是无条件终止；能修则修（补参数/缩小范围/改分批或后台周期查看），确认无法推进才终止并记
  `capability gap`。禁止静默等待、空轮询，禁止把停滞表述为"材料缺失/无数据"。人工等待（确认、授权、提供材料、
  扫码）不适用，不得因"无动静"终止流程。
- **覆盖**：只写编排层一处，正文明确"包括叶子与子任务里启动的命令"。
- **验证**：router 契约 15/15、`kb_tool validate` error=0、`git diff --check`。

## 2026-09-16 · refactor(skills) · 审核族分出 crwu-dev-audit- 前缀（optimize / public-general-standards）

- **变更**：`skills/crwu-audit-optimize/` → `skills/crwu-dev-audit-optimize/`、
  `skills/crwu-audit-public-general-standards/` → `skills/crwu-dev-audit-public-general-standards/`（`git mv` 保历史）。
- **同步**：技能自名、`crwu-audit/references/07-skill-registry.md`、`08-union-dispatch-rules.md`、router `SKILL.md`
  步骤 7/13、`10-capability-gap-proposal.md`、`99-maintenance.md`、资产/外部数据/datacheck 叶子引用、
  `skills/README.md`、`skills/AGENTS.md`、现行设计文档；带日期的历史记录不回改。
- **门禁双前缀**：`kb_tool.py` 的 `AUDIT_DIR_PREFIXES` 与 `check_audit_skill_mappings.py` 的
  `AUDIT_FAMILY_PREFIX`/`_SKILL_TOKEN_RE`/真实目录解析改为覆盖 `crwu-audit*` 与 `crwu-dev-audit-*`——
  否则 dev 前缀技能会静默掉出"三不写" lint 与装配路径键/R4 技能名校验；新增 3 条回归用例钉住。
- **部署影响（用户操作）**：需重新同步运行时并删除旧目录 `~/.skills-manager/skills/crwu-audit-optimize`、
  `crwu-audit-public-general-standards`（及 `~/.dsh`、`~/.workbuddy` 同名软链），否则新旧并存。
- **验证**：router 15/15、maintainer 63 项（1 项既有 live-cache 漂移失败，与本次无关）、dws 12/12、
  `kb_tool validate` error=0。

## 2026-09-16 · refactor(skills) · 氚云技能统一 crwu- 前缀：`h3yun-login`/`h3yun-query` 改名

- **变更**：`skills/h3yun-login` → `skills/crwu-h3yun-login`、`skills/h3yun-query` → `skills/crwu-h3yun-query`
  （`git mv` 保历史），与 `crwu-audit*`/`crwu-dws`/`crwu-init` 统一到 `crwu-` 前缀，便于按前缀识别/安装本仓技能。
- **同步**：两技能 `SKILL.md` 的 frontmatter `name`、标题与相互引用（`crwu-h3yun-query` ↔ `crwu-h3yun-login`）；
  `skills/README.md` 技能表；`skills/crwu-init/SKILL.md` 的"不触发"清单 `h3yun-*` → `crwu-h3yun-*`。
  CHANGELOG 中的历史条目按纪律**不回改**（旧名保留在历史记录里）。
- **部署影响（用户操作）**：改名后需重新执行 crwu-init / skills 管理机制同步；已安装目录里的旧
  `h3yun-login`/`h3yun-query`（含 `~/.dsh/skills` 等软链）**需手工删除**，否则新旧两份同时存在、
  触发词重复。技能能力与 `crwu h3yun ...` CLI 命令**零变化**。
- **验证**：`kb_tool.py validate --skill-root skills` error=0；两技能 frontmatter `name` 与目录名一致；
  全仓无残留旧名引用（CHANGELOG 历史条目除外）。

## 2026-09-16 · fix(skills) · 建"媒体证据通道"：内嵌图/复核件图导出并放行，修"图片被跳过"

- **缺陷（实测定位）**：上一笔只登记"原件媒体数"，**没有读取通道**——规则正文要求叶子"解析 raw 原件包的
  `xl/media` + `drawing*.xml` 锚点"，而 raw 只由编排层持有，编排层脚本只有计数；`docx/doc/pdf/独立图片`
  更连计数都没有（`docx_to_text` 静默丢图，独立图片只写"图片：无 OCR"）。实测：带 2 张内嵌图的 xlsx
  重建后工作版 0 张、盘点仅一个数字；带图 docx 的提取文本只剩"以下为询价截图："与空行；png 无任何可读路径。
  于是"证据在图片里"的检查项仍被结构性判成"为空/缺失"，且**复核意见附件里的图完全不可见**
  （人工用截图提出的问题会被误判成 `B·AI 新增`）。
- **修复**：
  - 新增 `crwu-audit/scripts/media_extract.py`（媒体抽取库）：xlsx（`xl/media` + `drawing*.xml` 锚点 →
    sheet/起止行，`oneCellAnchor`/`twoCellAnchor` 都认，命名空间前缀容错）、docx（正文内联图 → 段落序 + 前文提示）、
    `.doc`（`textutil -convert docx` 中转）、PDF（`pypdf` 页内嵌图 + 页号；缺依赖记未核）、独立图片（原样落盘）；
    统一 sha256/sizeBytes 与单件媒体数/总量护栏。
  - `prepare_materials.py`：所有格式统一导出到 `<案例>/媒体证据/` 并写放行清单 `<案例>/媒体索引.json`
    （`mediaId` / 受控 `locator` / `localPath` / `sha256` / `evidenceChannel=host-vision`）；`nonCellEvidence`
    汇总覆盖全部格式（`exportedMediaCount`/`hiddenSkippedCount`/`unresolvedCount`）；新增 `--media` / `--extract` /
    `--inventory` / `--label`，**阶段二复核件用 `--src 复核-人工 --label 复核` 复跑**（产出 `复核盘点.json` /
    `复核媒体索引.json` / `媒体证据-复核/`），绝不覆盖阶段一冻结的 `材料盘点.json`。
  - **H0 扩展到媒体锚点并统一 fail-closed**：锚点落在隐藏 sheet/行/列的媒体不导出、不定位，只记数量
    （此前 `rawMediaCount` 连隐藏锚点的图也计入）；锚点不可判定（`absoluteAnchor`、未被引用部件、页眉页脚、
    图表）与隐藏结构不可得时一律不导出，并记 `unresolvedReasons[]`（未核 ≠ 缺失）。
  - 叶子口径同步：编排层导出媒体并**放行**给叶子（消除"叶子必须解析 raw / 叶子拿不到 raw"的死结）；
    `references/00-input-and-route-profile.md` §Excel 重写为非单元格证据通道 + H0 + 未核；
    `references/11-html-delivery-spec.md` §4.3 的 `locator` 逐字取自 `媒体索引.json` 并补 docx/doc、PDF 行；
    `SKILL.md` 步骤 3 / 11 / 12（步骤 12 新增复核件媒体抽取）；`crwu-audit-datacheck/SKILL.md` 同口径。
- **验证**：新增 `test_media_extract.py` **13 项**（锚点导出、twoCell 起止行、隐藏行/列 H0、隐藏结构不可得
  fail-closed、绝对锚点未核、docx 段落序、页眉页脚未核、独立图片、缺 pypdf、`.xls` gap、上限护栏）；
  `test_prepare_materials.py` 23 → **26** 项（docx/独立图片进媒体索引、未被引用媒体留痕、阶段二复跑
  `材料盘点.json` sha256 不变）；探针案例导出 xlsx 锚点图 + docx 段图 + 独立图片共 3 条。

## 2026-09-15 · fix(skills) · 按权威 schema 重建目录缓存；修 crwu-dws 递归漏 `--workspace` 与"规定的目录树形态不被解析"

- **背景**：上一笔（`83f580d`）修完生产侧口径后，用 crwu-dws M1 重建 `中瑞世联评估审核知识库` 目录缓存，过程中又暴露两处缺陷。
- **缺陷 1（文档与实现不符，递归必失败）**：`crwu-dws/SKILL.md` §4 P1 的递归写法只写 `--folder <folderId> --page-all`，而 `dws wiki +node-list --help` 明示 **`--workspace` 是必填**——照文档写子层调用必然 `rc=3`，遍历只能停在根层。另 `--page-limit` 默认仅 20 页（× `--limit` 50 = 最多 1000 条），大库会被静默截断成"遍历完成"。已补明 `--workspace` 必填与 `--page-limit` 须显式放大。
- **缺陷 2（三种形态互不一致，"规定的产物"反而不可解析）**：`目录树.md` 的**规范形态**是 `crwu-dws/references/00` §4 的 box-drawing（`├─`/`└─`、folder 标 `[F]`、文档标 `extension`），**旧产物**是图标树（`- 📁`／`- 📄`），而 `check_audit_skill_mappings.py` 只认图标树与 slash 树 → 规定的 `目录树.md` 无法作为 `--catalog` 输入。已为 checker 增补 box-drawing 解析（`_parse_box_tree`），并保留既有两种以便粘贴树仍可用。
- **重建结果**：`目录快照.json`（`crwu.kb-catalog.snapshot.v1`，嵌套 `children`、`generated_at`/`profile`/`mode`/`stats.complete` 齐备、`failures=[]`）、`node-index.json`（`crwu.kb-dir-cache.nodeindex.v1`）、`.cache-meta.json`（`crwu.kb-dir-cache.meta.v1`，`last_successful_at`）、`目录树.md`（box 形态）四件套原子替换；**300 节点 / 127 folder / 173 文档 / 深度 5 / complete=true**。
- **验证**：映射检查器对真实缓存 `source_schema=crwu.kb-catalog.snapshot.v1`、`paths=300`、`complete=true`，**`KB_PATH_KEY_NOT_IN_CATALOG` 为零**（164 个寻址键全部命中），唯一 finding 是既知方法轴缺口 `ASSEMBLY_GAP_METHOD_LAYER`×3；`test_audit_skill_maintainer.py` **59 → 60 项、零 skip**——两个 live 回归恢复实跑，"三种产物形态指向同一棵树"通过（300 路径三方一致）；`kb_tool.py validate --skill-root skills` error=0。

## 2026-09-15 · fix(skills) · crwu-dws 快照 schema 口径自相矛盾致缓存被拒收；检查器报错改为可行动

- **缺陷（实测定位）**：`~/.crwu/knowledge/dws-dir-cache/<库>/目录快照.json` 无法作为 `--catalog` 输入——`check_audit_skill_mappings.py` 报 `unsupported catalog schema: 'crwu.kb-dir-cache.snapshot.v1'`，整条映射/路径键校验链不可用（`test_audit_skill_maintainer.py` 2 项因此报错）。
- **根因（生产侧口径自相矛盾）**：`crwu-dws/SKILL.md` §8 P4 写"缓存 meta 与快照 **`fetched_at`** 一致"，而 `references/00` §2/§3 与 `references/02` §107 定义的是 **`generated_at`**。模型跟了 SKILL.md，于是该缓存同时偏离四处：`schema` 字面混成 `crwu.kb-dir-cache.snapshot.v1`（由 `.cache-meta.json` 的 `crwu.kb-dir-cache.meta.v1` 与快照名混合而成，本仓历史中从未存在）、时间字段写成 `fetched_at`、缺 `profile`/`mode`/`stats.complete`、`nodes` 用了 `node-index.json` 的**扁平自带 `path`** 形态。
- **整改（修生产侧口径，不放宽消费侧）**：
  - `crwu-dws/references/00` §3 新增硬门禁：`schema` 字面与必填键逐字固定；三个 schema 名与时间字段名不得混用；`nodes` 必须为嵌套 `children`（扁平 `path` 形态属 `node-index.json`，禁止写入快照）。
  - `crwu-dws/SKILL.md` §8 P4 新增"写缓存前先校验快照 schema"门禁；`crwu-dws` 内 10 处 `fetched_at` 全部归一（快照语义 → `generated_at`；`.cache-meta.json` 描述 → `last_successful_at`）。
  - `check_audit_skill_mappings.py`：不可解析 schema 的报错由"只报名字"改为**列出可接受集合 + 重建指引**（点明快照字面与"扁平 `path` 是 node-index 形态"）。**不为该漂移字面开别名**——那会把漂移固化成契约。
  - `test_audit_skill_maintainer.py`：实时缓存不可解析时，两个 live 回归**显式 skip**（skip 消息附 checker 原始报错），不再抛 `JSONDecodeError`；新增 1 项锁住"可行动报错"契约（58 → **59** 项）。
- **验证**：全套 8 个契约测试通过（`test_audit_skill_maintainer.py` 为 `OK (skipped=2)`）、`kb_tool.py validate --skill-root skills` error=0、`git diff --check` clean。
- **待人工执行（运行时动作，本仓不代做）**：用 `crwu-dws` M1 重建该库目录缓存（新缓存须满足上述四条）；重建后两个 live 回归会自动恢复实跑（不再 skip）。

## 2026-09-15 · fix(skills) · 立"非单元格证据不得据工作版判缺失"口径并登记原件媒体数

- **缺陷（实测定位）**：重建工作版只复制单元格值与 `number_format`，**必然**丢弃 `xl/media`、`xl/drawings`、页眉页脚、批注、形状与图表；而 router 只把工作版交给叶子，于是"证据不在单元格里"的检查项被**结构性**判成"缺失"。实测 2026-302150-LX9757-BG8677：`MKT-004` 判"可比实例位置图为空、询价截图缺失"，而原件 `04评估计算表.xlsx` 实有 **26 个媒体对象**（工作版 0），其中 `1-2市场案例位置图` 的图正是带 4.6/5.4/3.8 km 标注的可比案例位置图。属**假阳性**，须回撤。
- **根因**：既有铁律"任何'未列示/缺失/为空'类结论下发前必须回 raw 原件复读"**只覆盖了单元格**——回 raw 只看单元格同样看不到图，缺"直读 raw 包部件"这一半。
- **整改（口径 + 数据依据）**：
  - `crwu-audit/references/00-input-and-route-profile.md` §Excel 补五条：① "工作版中不存在" ≠ "原件中不存在"；② 媒体类证据必须解析 raw 包的 `xl/media/*` 与 `drawing*.xml` 锚点，并据锚点定位 sheet 与行；③ 解析不到只能出「未核验」，**未核 ≠ 缺失**；④ **H0 扩展到图形锚点**（锚点落在隐藏行/列/隐藏 sheet 的媒体对象整体跳过；媒体呈现隐藏区内容属 H1）；⑤ 编排层在 `nonCellEvidence` 登记原件媒体数，叶子据此知道"有待核证据"，实际读取由编排层按清单放行。
  - `crwu-audit-datacheck/SKILL.md` 同步同一禁令（询价截图/位置图/现场照片等内嵌图不得据工作版判缺失）。
  - `crwu-audit/references/11-html-delivery-spec.md` §4.3 补**非单元格证据的 `locator` 受控写法**（`<sheet>!图片#<序号>（锚点 <起始行>:<结束行>）`、`!页眉`、`!页脚`、`!批注!<单元格>`、`!图形#<序号>`、扫描件 `#第<N>页`），并明确未核验写「未核验」、`excerptOrValue` 不得用"无/空"替代未核。
  - `audit_result.schema.json` 6 处 `locator` 补 `description`（同一词表；`locator` 仍为自由字符串，不改结构）。
  - `prepare_materials.py` 新增 `_raw_media_count()`，逐文件登记 `rawMediaCount` 与 `mediaCarriedOver: 0`，并在 `材料盘点.json` 汇总为顶层 `nonCellEvidence` 与 CLI 摘要提示。
- **验证**：真实案例 `04评估计算表.xlsx` 计数 26（工作版 0），案例汇总 4 个文件 / 72 个媒体对象；`test_prepare_materials.py` 22 → **23** 项（新增媒体计数与 `nonCellEvidence` 登记）；`test_audit_delivery.py` 61/61；`kb_tool.py validate --skill-root skills` error=0。

## 2026-09-15 · fix(skills) · recalc_check 函数参数丢索引：未实现运算符被静默丢弃，产生 1,914 条假差异

- **缺陷（实测定位）**：`_function` 的局部 `ev()` 写成 `return self._expr(tokens, s)[0]`，**丢弃了消费位置**。于是 `IF(A1&B1="x", a, b)` 只解析 `A1`，`&B1="x"` 被静默忽略、条件走错分支——引擎给出一个**自信的错误值**并按"已重算"参与比对；`%` 同理。
- **两个方向都危险**：① 假阳性——错误值与缓存值不等 → 记为差异（真实案例 `3-资产基础法.xlsx` 实测 3,462 条差异中 **1,914 条**由此产生）；② 假阴性——错误值恰好等于缓存值 → 被记成"已核"，即"没算却报已核"。本次样本 `matched` 未受影响（9,095，不变），但方向性风险确实存在：微用例 `=IF(1&2=12,111,222)` 返回了碰巧正确的 111。
- **整改**：`ev()` 校验参数范围内 token 全部消费，未消费即抛 `Unavailable("解析失败：函数参数存在未消费的片段 …")`，按脚本既有契约归入「未重算」。全文件仅此一处丢索引，其余 10 个解析调用点均正确保留位置。
- **同步**：`crwu-audit-datacheck/SKILL.md` 的 C7 段本就写明"百分比 `%`、文本拼接 `&`、未列函数不实现 → 标「未重算」，绝不猜值"——**文档是对的，是实现违反了文档**，故本次不改文档。
- **验证**：真实案例 `3-资产基础法.xlsx` 差异 **3,462 → 1,548**（−1,914），`matched` 不变、`engineErrors` 0；`test_recalc_check.py` 13 → **15** 项（新增 `&`、`%` 出现在函数参数内必须报未重算两例）；`kb_tool.py validate --skill-root skills` error=0。

## 2026-09-15 · fix(skills) · recalc_check 求值异常兜底：类型不匹配不再打穿整表，引擎缺陷单独计数

- **缺陷（实测定位）**：`recalc_check.py`（C7 计算链重算）只捕获 `Unavailable`，而 `_arith` / `_compare` / `_round_half_away` / `SUM` 的 `float()` 转换抛出的是裸 `TypeError`/`ValueError`。真实案例 `3-资产基础法.xlsx` 的 `=A1-B1`（A1 日期、B1 文本）→ `TypeError: unsupported operand type(s) for -: 'datetime.datetime' and 'str'` **打穿 `run()`**，整个 datacheck 崩溃、该表完全不可用。Excel 对同式报 `#VALUE!`，故这属"该格不可重算"，不是引擎缺陷。
- **整改**：`Evaluator.eval()` 收成唯一入口并统一兜底——`Unavailable` 原样透出；单元格值的类型/数值问题（`TypeError`/`ValueError`/`ArithmeticError`/`InvalidOperation`，即 Excel 会报 `#VALUE!`/`#DIV/0!` 的那类）→ 标「未重算：类型不匹配或计算失败」；**其余非预期异常** → 新增 `EngineError(Unavailable)` 子类，逐格标 `engineError: true` 并在摘要新增 `engineErrors` 计数。`run()` 另加一层 `except Exception` 兜底，保证**任何单格异常都不得中断整表**。
- **为什么不用一刀切 `except Exception`**：那样会把代码缺陷伪装成"该格数据有问题"，整表静默降级也看不出来。故按异常类型二分：数据/类型问题进普通「未重算」，引擎问题必须**可见**（`engineErrors` 非 0 须排查）。
- **契约同步**：`crwu-audit-datacheck/SKILL.md` C7 段补「类型不匹配」为未重算情形，并写明 `engineErrors` 非 0 须排查引擎缺陷、不得当作该表数据问题。
- **验证**：该真实案例由「崩溃、整表不可用」→ **11.9 s 跑完**（18,828 个公式格 / 重算 12,557 / 差异 3,462 / 未重算 6,271 / `engineErrors` 0）。`test_recalc_check.py` 10 → **13** 项（新增类型不匹配不崩、SUM 聚合非数值不崩、非预期异常计数不吞三例）；其余七个契约测试与 `kb_tool.py validate --skill-root skills`（error=0）全通过。

## 2026-09-15 · fix(skills) · prepare_materials/recalc_check 表格遍历改按"有值格"定界（修游离格式格导致的百万行扫描）

- **缺陷（实测定位）**：`3-资产基础法.xlsx` 的 `4-15-3无形-其他` 表**实际只有 944 个格、42 行有效数据**，但第 **1048575** 行第 6 列存在一个 `value=None`、`has_style=True` 的游离格式格（整列刷格式残留）。两处按矩形遍历的代码因此各扫 **2614 万个坐标**：`xlsx_visible` 重建循环 55.7 s、`audit_hidden_references` 69.9 s；同一案例 `报告附件/` 与 `报告附件_回填/` 各一份 → 合计约 280 s。26 MB 的测算表只要 2 s，说明**与文件大小无关，只与表的形状有关**。
- **根因**：`_sheet_bounds` 上一版已改为扫 `_cells`（避免虚增 dimension），但 **`_cells` 里的格 ≠ 有值格**——游离格式格同样在 `_cells` 里，边界仍被顶到 104 万行。
- **整改（四层边界，口径写进脚本注释与 `references/00`）**：**B1 扫描边界** ＝ **有值**格（缓存值 ∪ 公式串）的精确集合，不按矩形扫、无阈值；**B2 内容边界** ＝ 同一集合的 max 行列；**B3 异常阈值** ＝ 声明用区与有值区之差 >1000 行/列 → 记 `sheetAnomalies[]`（**仅提示，不改变遍历**）；**B4 硬护栏** ＝ 单表有值格 >2,000,000 → 记 `capabilityGaps` 并跳过该表（照 `extract_archive` 的 `MAX_ENTRIES` 形态，**不静默**）。
- **不丢信息**：声明用区与有值区不一致的 sheet 逐个在 `stats[].declaredSpan` 留痕（实测某案例 85 个 sheet），其中超 B3 阈值的再进 `sheetAnomalies`。
- **同批**：`crwu-audit-datacheck/scripts/recalc_check.py` 的 `ws.iter_rows()` 同型扫描一并改为扫 `_cells`。
- **明确不改**：行号语义（仍是「1..有值末行 减去隐藏行」）、隐藏区剔除、H0/H1 分层、`hiddenStructureDrift` 形态、**保存后重新打开工作版验证隐藏区为 0**（`references/00` 契约要求，保留）。
- **验证**：真实案例 `prepare_materials.py` 全量 **332.8 s → 12.3 s（约 27×）**；工作版产物与修复前**逐格比对 305,977 格、差异 0**；`sheets[].cells`、`valueUnavailable`、`hiddenMeta`、`hiddenRefs*` 全部不变（仅 `maxRow/maxCol/visibleRows` 回到"真实用区"语义）。`test_prepare_materials.py` 22/22（新增游离格式格、超限护栏两例），其余六个契约测试与 `kb_tool.py validate --skill-root skills`（error=0）全通过。

## 2026-09-15 · refactor(skills) · crwu-audit-external-data 单源化：移除万得校验，同花顺 iFinD 支持两条取数路径

- **背景**：本技能原先按知识库表 D 做"同花顺主源 + 万得副源"双源复核。实际环境里万得连接器常年未启用（实测 `~/.workbuddy` 中 `wind-finance` 为 `declared_disabled`），双源分支只能一直降级；同时同花顺 iFinD 在 WorkBuddy 是宿主连接器（`ifind-mcp`），在 DeepSeek Harness 是 `ifind-finance-data` 技能，两者调用方式不能互相套用。
- **单源化**：`crwu-audit-external-data` 的唯一数据源改为**同花顺 iFinD**，移除全部万得校验——连接器探测目标只剩 `ifind`、技能正文/装配表/交付字段不再出现"万得/副源/双源"；库内表 D 按单源降级口径执行。
- **知识库修订稿**：新增 `docs/2026-09-15-M-外部数据核验-模块规程-v0.2.md`（v0.2 单源版）——表 B 去掉"万得条件"列、表 C 源列统一为同花顺 iFinD、表 D 由「万得启用条件与降级」改为「取数失败与降级（D1–D4）」、§0/§1/§7/§8/§9 的双源表述收敛。知识库正文只读，需由维护人按该稿人工更新。
- **两条取数路径（新增说明）**：`SKILL.md` 新增「数据源与两条取数路径」表，`references/01-connector-access.md` 重写为 §1 路径对照 / §3 WorkBuddy 连接器声明 / §4 DeepSeek Harness 的 `ifind-finance-data` 技能目录 / §5 兜底 / §6 留痕（新增 `access_path`、`source_note`），并把"本仓不提供该技能"写明。
- **探测脚本**：`scripts/connector_probe.py` 升到 `crwu.external-data.connector-probe.v2`——宿主连接器与 Harness 技能目录两条路径分别探测后合并；新增 `--skills-root`（可重复）与 `CRWU_SKILLS_ROOT`，默认扫描 `$CRWU_SKILLS_ROOT` → 本技能所在 skills 根 → `~/.agents/skills` 等常见位置；退出码改为 0 = 至少一条路径预检可用、2 = 无可用路径。仍只读、不解析 `mcp_config.json`、不输出任何凭据。
- **交付层**：`unavailableDeclaration` 措辞由"未经双源复核"改为"未经外部数据核验"（`audit_delivery.py` 的 `EXT_DATA_UNAVAILABLE_TEXT` 与校验文案同步）；`audit_result.schema.json` 的 `externalDataVerification` / `deviationAgainst` 描述改为单源 iFinD 口径；样例 `examples/audit-result.sample.json` 删除万得来源与降级声明。
- **router / 契约同步**：`crwu-audit/SKILL.md`、`references/08-union-dispatch-rules.md`、`references/11-html-delivery-spec.md`（§3 概览与 05b、字段规则）、`references/12-leaf-common-contract.md` 全部改为单源 iFinD 表述；`skills/README.md` 与 `docs/design-crwu-audit-skills.md` 同步。
- **验证**：`test_connector_probe.py` 14/14（新增 Harness 技能路径、退出码、无万得残留用例）；`test_audit_delivery.py` 61/61（不可用源声明与校验用例改为构造 iFinD 不可用）；`kb_tool.py validate --skill-root skills` error=0；真实环境探测（2026-09-15）返回 `host_connector` 可用，并识别 `~/.agents/skills/ifind-finance-data`。

## 2026-09-15 · feat(skills) · crwu-audit-optimize 新增 AI—人工差距分析与可执行修复计划

- **新增模式**：审核结束且存在同源人工复核文件时，逐条对齐 AI 与人工结果；仅人工发现项使用稳定 `L-*`，区分 `L-resolved`、`L-open`、未闭环、不可核验与人工意见可疑，避免把已在最终件修复的问题误计为 AI 漏检。
- **根因追踪**：按输入、画像、路由、装配、知识、Skill、执行、输出八层追踪；用同次审核 `knowledge/` + manifest 解释历史原因，再以 crwu-dws 最新只读正文判断当前是否仍缺，明确区分知识库缺失、Skill 缺陷、路由装配、执行与输出问题。
- **双向关系**：每个可执行 `L-open.linkedFixIds[]` 必须指向一个或多个 `FIX-*`，每个 `FIX-*.sourceGapIds[]` 必须反向指回来源；校验器拒绝断链、重复 ID、非可执行状态进入计划及不可重算汇总。
- **HTML 交付**：新增 `scripts/gap_analysis_delivery.py`、JSON schema、样例与固定 `template/gap-analysis-report.html`；离线内嵌 Apache ECharts 5.6.0，输出表格、根因/状态图、执行轨迹、`L → 根因 → FIX` 映射、修复操作中心和 A4 打印版。
- **权限边界**：知识库计划强制 `kb_manual + manual_only`，只说明目标文档、缺失内容、修改位置、人工步骤与验证方法，AI/CLI 禁止修改知识库；Skill 修复只在用户明确批准具体 `FIX-*` 后生成可复制 prompt 并修改批准的源仓文件，禁止写运行时目录。
- **验证**：新增差距数据校验、HTML 离线/打印、根因统计、权限隔离、批准门禁及 Skill 集成测试；全量回归结果见本次交付记录。

## 2026-09-15 · fix(skills) · crwu-dws v0.6：取数按节点 `extension` 双通道分流，修复「原生 `.md` 正文必然失败且被误记为 failure」

- **缺陷（实测定位）**：知识库文档节点的 `nodeType` **恒为 `file`**，格式信息只在 `extension`/`contentType`；`dws doc +export` **仅支持 `extension=adoc`**。crwu-dws 整改前对所有文档一律调用 `doc +export`，于是「中瑞世联评估审核知识库」中 **25 个原生 `.md` 正文**（整个 `03-评估方法/`，含 `RULE-01-02-281~305` 评估方法准则 25 条、方法缺陷清单）**每次审核都必然失败并被记成 failure**；`crwu-audit-asset-realestate/references/01-kb-assembly.md` §3 声明的 `VALUATION_METHOD_INTERFACE` 路径（`03-评估方法/00-评估方法准则2019-精编/评估方法准则2019-精编条目/`，6 个文件）全部落在此列 → 每次房地产审核丢 6 条，方法准则层整层不可用。
- **波及表述修正**：这不是"没有权限"或"内容缺失"——同一批节点用 `dws drive +download` **27/27 全部取回成功**（方法轴 25 个文件合计 75,207 字节）。缺陷性质是**取数通道选错**。
- **整改（按 `extension` 分流，硬规则）**：`adoc`→`dws doc +export --export-format markdown`；可读原生文本 `md`/`txt`→`dws drive +download`（原件即正文，不转换）；其余类型（`pdf`/`docx`/`xlsx`/`exe` …）→ 记 `skipped` + 真实 `extension`，**不是 failure**、不伪造正文。**明令禁止"先 `doc +export` 试一次、失败再换通道"**——试错会把必然失败记成偶发错误并掩盖通道缺陷。
- **只读白名单**：由「doc 域仅 `+export`」扩为「wiki 域 6 命令 / doc 域 `+export` / **drive 域仅 `+download`**」；仍对钉钉零写（`+download` 为 `effect=read risk=low confirmation=not_required idempotent`，产物只落本地工作目录）。
- **快照与索引补 `extension`/`contentType`**（M1/P2 遍历强制记录，缺席记 `null` 不推断）：这是 M2 快路径判通道的唯一依据。旧缓存缺该字段时逐节点补查 `dws wiki +node-get`（只读，记入 `evidence.extensionSource=catalog|node-get`），**不按名称后缀猜**。`type` 字段明确为"只表示节点形态、不承载格式信息"（整改前 schema 文档把它当格式白名单 `folder|adoc|axls|…`，与真实返回 `folder|file` 不符，是本次误判的根源）。
- **manifest 契约（`crwu.audit-download.manifest.v1`）**：entry 新增必填 `extension` + `channel ∈ {export,download}`；新增 `skipped` 行（含真实 `extension` 与原因）；**`skipped` 必须与 `failure` 分开统计**，禁止把类型不支持并入 failure。摘要口径由「成功/失败」改为「成功/跳过/失败」。
- **同步文件**：`crwu-dws/SKILL.md`（description、§0、§2 白名单与分流表、§4 P2、§6.2 M2、§7 M3、§8 自查、§10 错误路径）、`references/00-目录快照schema.md`（v3）、`references/01-审核下载与manifest规范.md`（v4）、`references/02-缓存与兜底查找规范.md`（v1.3）、`skills/README.md`、`docs/design-crwu-dws.md`（v0.6 新增 §3.1 分流表与验收用例）。
- **门禁补强**：`crwu-dws/scripts/test_dws_source_contract.py` 新增 5 个契约测试（只读白名单含 `+download` 且不含 `+upload/+move/+delete`；通道由 `extension` 判定且禁止试错；`skipped` 不得记为 failure 且 manifest 三态齐全；快照与索引携带 `extension`/`contentType` 且缺失时补查 `node-get`；`type` 不得当格式判据、目录树按 `extension` 标注）。**非空验证**：在 `HEAD` 干净工作树上运行新测试，5 个新测试全失败；改动后 12/12 通过。
- **验证**：`test_dws_source_contract.py` 12/12；`kb_tool.py validate --skill-root skills` error=0/warn=0；`check_audit_skill_mappings.py --catalog <2026-09-15 在线快照>` error=0/warning=0；真实环境 `dws drive +download` 27/27 成功。
- **待办（用户侧，知识库）**：无。本整改不需要改钉钉端内容（方案①零内容改写）；若日后选择"把 `03-评估方法/` 转为 adoc"（方案②），需同步 `crwu-audit-asset-realestate` 的 `VALUATION_METHOD_INTERFACE` 与映射校准表。

## 2026-09-15 · feat(skills) · 新增 public 轴能力技能 `crwu-audit-external-data`（收益法/市场法的外部数据核验 + 同花顺 iFinD / 万得连接器发现与兜底）

- **背景**：知识库已新增模块规程 `06-规则库/M-外部数据核验/01-模块-外部数据核验`（表 A 触发范围 / 表 B 数据项触及 / 表 C 组合映射 / 表 D 万得条件与降级 / 结论档位 / 留痕 / 未检查项 / 员工补录机制）。本次把该模块落成 crwu-audit 族的执行能力。
- **新增技能**：`crwu-audit-external-data`（能力型、public 轴插拔，与 `crwu-audit-datacheck` 同版式）——`SKILL.md` + `references/00-KB装配表.md` + `references/01-connector-access.md` + `scripts/connector_probe.py` + `scripts/test_connector_probe.py`。
- **触发**：`route_profile.methods[]` 命中 `收益法`/`市场法` 时由 router 并入 `public_skills`（是否真正取数再由该技能按知识库表 A 三条自行判定，缺一记"不在本模块范围"）。
- **基准日纪律（三档）**：所有取数以 `record_context.base_date` 为锚，区间/窗口由基准日推导；**禁止取数时点的滚动窗口**（否则复跑不可比、双源比对失效）。基准日状态分三档处理，**不得整线停载**：①唯一确定 → 正常取数；②**多候选（ROUTE003 挂起）→ 条件性取数**（按候选日分别取数；结论一致可出并注明"已在候选基准日下逐一核验，结论一致"，不一致则出"请说明"的条件性结论、不得判"不符合"）；③缺失/不可解析 → 只核不依赖基准日的项（公司属性事实、报告期固定的财报数、政策文件现行有效性），其余记"未检查"。门禁只**消费** router 的 `base_date`/`base_date_status`，不自行判定 ROUTE 冲突（判定权在 `06-overlay-classification.md`），并按 `08` 的 ROUTE003 口径保留"不依赖冲突字段的检查仍须执行"。
- **连接器兜底**：宿主会话未暴露 MCP 工具时，按 `references/01` 读宿主连接器声明（默认根 `~/.workbuddy`，可用 `CRWU_CONNECTOR_ROOT` 覆盖）；无连接器 / 未启用 / 未认证 → 按知识库表 D 降级（W2/W4 降为"单源 + 请说明"），并**在交付 HTML《外部数据核验》区显式声明**"未配置 / 未认证的数据源，相关条目未经双源复核"。
- **交付层**：AuditResult 新增可选 `externalDataVerification`（`baseDate` / `unavailableDeclaration` / `sources[]` / `checks[]`）；HTML 新增《外部数据核验》区（左侧目录第 05b 项），逐项给出**报告值 / 各源取值 / 各源口径 / 基准日 / 与哪一源出入较大 / 判定（符合·不符合·请说明·未检查）**——"符合"同样入表，不只列问题。缺失该字段时页面显式显示"本次未执行外部数据核验"。
- **概览分区（可读性）**：审核结果概览不再只给一行问题总数——新增"**问题按模块分布**"（模块/问题数/高/中/低）与"**外部数据核验结果**"（判定·项数；以及"与哪一数据源出入较大"·项数）两个分块，全部由 `issues[].module` 与 `externalDataVerification.checks` 确定性推导，不与问题总数混列；渲染器仍不自造句子（计数按输入重算，测试相应放行纯整数文本节点）。
- **"出入较大"三态（避免 `—` 混淆）**：`deviationAgainst` 语义明确为 —— 有出入写源名 / 无出入写 `—` / **判定"未检查"的写"未取数"**（渲染器对空值与 `—` 归一化）；概览该分块每行必须有明确含义（源名 / `无出入（符合）` / `未取数` / `未列明来源`），行项数之和等于核验项数，且有测试钉住"不得出现无标签的 `—` 行"。
- **契约变更**：`12-leaf-common-contract.md` §1 增"外部数据取数是唯一例外"（仅该技能可直连取数，须留痕并向编排层回执）；`08-union-dispatch-rules.md` 的 `public_skills` 增条件项与示例；`07-skill-registry.md` 增 public 行；`99-maintenance.md` owner 表更新；`11-html-delivery-spec.md` 增第 05b 区与 `externalDataVerification` 字段规则。
- **凭据纪律**：探测脚本只读连接器**键名与启用状态**，不读取/不输出任何令牌与 Authorization 值（URL 只输出主机名）。
- **验证**：`test_audit_multiaxis_router.py` 14/14、`test_audit_delivery.py` 57/57、`test_connector_probe.py` 11/11、`kb_tool.py validate --skill-root skills` error=0/warn=0；真实环境探测（2026-09-15）返回同花顺 iFinD `available`（凭据引用存在）、万得 `available`（已启用且曾连接）。
- **待办（用户侧，知识库）**：`00-总纲/治理/审核模块注册表` §1 增 `M-外部数据核验` 行 + 接口契约；`00-总纲/治理/标签词典` §5 增同名 `modules` 取值；按总纲 §3.2 三处登记（目录地图 / 知识库大纲与进度总表 / 所在目录 README）。未登记则规则装配漏配。

## 2026-09-11 · feat(skills) · 资产轴补齐 11 个一级资产 Skill 并对齐路由（知识库 `02-资产类型/` 由 1 个一级根扩至 12 个）

- **背景**：知识库更新后 `02-资产类型/` 从「只有 01-房地产」扩到 12 个一级根（机器设备/企业价值/无形资产/矿业权/存货/债权/资产组合/交通运输设备/资产组-含商誉/废旧物资/其他），全部有真实审核条目正文（本次经 `crwu-dws` 实时下载逐份核对，无空文档/待补/TODO 占位）。
- **新增技能**：`crwu-audit-asset-equipment`（设备→机器设备 改名）、`crwu-audit-asset-enterprise-value`、`crwu-audit-asset-intangible`、`crwu-audit-asset-mining-right`、`crwu-audit-asset-inventory`、`crwu-audit-asset-debt`、`crwu-audit-asset-portfolio`、`crwu-audit-asset-transport-equipment`、`crwu-audit-asset-asset-group-goodwill`、`crwu-audit-asset-scrap-materials`、`crwu-audit-asset-other`，全部 `available`（四件套 + 引用 `12-leaf-common-contract.md`）。
- **移除登记**：`数据资产`（现为无形资产细分对象 `05-数据资产`）、`森林资源`（库内已消失）不再作为一级资产标签。
- **范围轴对齐**：`企业价值`/`资产组合` 在 scope 轴改为 `profile-only`（范围画像保留，审核内容由 asset 轴 `crwu-audit-asset-enterprise-value`/`crwu-audit-asset-portfolio` 承接），不再映射 pending scope 技能。
- **业务轴修正**：`04-business-classification.md` 财务报告子业务补 `合并对价分摊`（此前叶子已有、分类表漏）。
- **同步**：`07-skill-registry.md`、`02/03/04-*-classification.md`、`08-union-dispatch-rules.md`（示例更新 设备→机器设备、pending→available）、`test_audit_multiaxis_router.py`、`check_audit_skill_mappings.py` 的 `KNOWN_SKILL_SUFFIXES`、`skills/README.md` 技能表；校准表 `07-kb-skill-map.md` 用最新目录刷新。
- **验证**：`check_audit_skill_mappings.py --catalog <本次快照>` error=0；`test_audit_skill_maintainer.py` 58/58、`test_audit_multiaxis_router.py` 11/11、`test_dws_source_contract.py` 7/7、`kb_tool.py validate` error=0 通过。

## 2026-09-11 · feat(cli) · 新增 `crwu h3yun file get` 单附件下载（打通审核阶段一「定向取源材料」门禁）

- **背景**：审核阶段一安全下载门禁要求「只下源材料、不下复核件」。原 `crwu h3yun file download` 会下载整条记录全部附件，若记录混有复核意见类附件则阶段一被迫中止。经排查，服务层 `DownloadAttachment(ctx, attachmentID)`（`GET /Form/Download/?AttachmentID=<id>`）早已支持按 FileId 下载单附件，只是未暴露为 CLI 子命令。
- **新增命令**：`crwu h3yun file get --id <fileId> --out <文件路径>` —— 按 FileId 下载单个附件到指定路径（FileId 来自 `crwu h3yun files list`）。服务层新增 `h3yunweb.Service.DownloadOne(ctx, fileID, outPath) error`。
- **影响命令**：新增 `h3yun file get`；`h3yun file download` 行为不变（整单，阶段一仍禁用于含复核件的记录）。
- **文档**：`docs/cli-manual.md`（附件命令表 + 典型流程 + 已知坑）、`README.md`/`README.zh-CN.md` 命令表同步；`crwu scheme` 目录自动收录 `h3yun file get`。
- **测试**：`internal/app/h3yunweb/service_test.go` +2（写文件、缺 fileId 报错）；`internal/transport/cli/cli_test.go` +2（定向下载、缺参数报错）+ 目录断言。
- **后续**：`crwu-audit` 阶段一门禁据此改为「`files list` 取元数据 → 源材料逐件 `file get`、复核件只入排除清单」，不再要求整单下载后隔离。

## 2026-09-11 · feat(skills) · 数据校对新增 C7「计算链重算」引擎（可见区公式独立重算比对）

- **需求**：评估审核要覆盖「计算表的计算」——对测算/明细表可见区公式做**独立重算**，与表内缓存值比对，找出重算不一致的公式格（不是只扫 `#REF!` 等错误字面量）。
- **新增引擎**（`skills/crwu-audit-datacheck/scripts/recalc_check.py`，随技能安装、只用 openpyxl+标准库）：CLI `python3 scripts/recalc_check.py --workbook <raw.xlsx> [--out <diff.json>]`，输出 `summary{formulaCells/recomputed/matched/mismatched/notRecomputable}` + `differences[]` + `notRecomputable[]`。
- **能力边界（经确认只做这一档，低风险）**：仅支持算术 `+ - * / ^ %`、括号、比较 `= <> < <= > >=`、`SUM/PRODUCT/ROUND/IF/MAX/MIN`、单元格/绝对引用 `$A$1`、跨表引用 `'表名'!A1`、字符串与 TRUE/FALSE 常量；`ROUND` 用十进制半进位规避二进制浮点误差（`1.235→1.24`）。
- **纪律（防自造假阳性，H0 安全）**：只读**可见区**；引用隐藏 sheet/行/列、外部工作簿 `[book]`、不支持的函数、解析失败、除零 → 一律标「未重算(原因)」，**绝不判通过、绝不猜值**；重算结果仅与缓存值做「是否一致」比对（引擎不自判谁对谁错），不一致或无缓存值 → 记差异 `C7-计算链` 交人工复算。
- **契约测试**（`test_recalc_check.py`，10 项，自洽造 fixture）：算术/绝对引用、SUM/PRODUCT/ROUND、IF 链复现真实判例、IF 惰性分支返回字符串、隐藏依赖→未重算、跨表引用、不支持函数→未重算、外部工作簿→未重算、除零→未重算、缓存值故意写错→报差异。
- **流程**（`SKILL.md`）：六类检查 → **七类检查**，新增 C7 说明与工具链条目；`.xls` 仍需 soffice 先转 `.xlsx` 再核。
- **知识库侧待办（不在本仓执行）**：知识库 `M-数据校对` 模块当前**无「计算链重算」检查点**（只有勾稽一致/单位小数/跨表一致/要素一致/底稿支撑）→ 需在知识库补登记 C7 检查点，技能实现先行、知识库后采纳。
- **验证**：`python3 skills/crwu-audit-datacheck/scripts/test_recalc_check.py` 10/10 通过。

## 2026-09-11 · feat(skills) · 新增「AI 审核六维评分卡 + 审核错误项」（自评，量化工种差距）

- **需求**：一级复核时要记录 AI 自身的审核错误项并给自己打分；二级审核在同一张卡上打分，但**只是在一级基础上做分数补充与校正**。目的是**检测 AI 审核与人工复核的差距**。四项口径经确认：① 卡片**用表格呈现**（不用图表卡片）；② **两个级次均由 AI 自评**（不需要页面交互 → 保持"renderer 只呈现不改写"红线）；③ 综合分＝**六维均值按 0.5 取整**（两个口径：AI 单机 / 含人机复核闭环）；④ 错误项**新增独立结构**。
- **口径来源（重要）**：知识库《审核统计与台账规范》§1 只定义 `review_level`（初审/复审/终审，受控取值）与 A–G 组统计字段，**没有 AI 评分维度与算法** → 六维与取整算法作为**技能内受控取值**实现，并在 spec 中显式声明；若要回填台账/氚云字段，需先在知识库登记（列为知识库侧待办，技能不擅自回填未登记字段）。
- **schema**（`audit_result.schema.json`，顶层新增且进入 `required`）：`aiScorecard{level∈初审/复审/终审, dimensions[6]{key 受控 enum, label, score(0–10, 0.5 步长), max=10, basis 必填}, composites{aiOnly, withHumanLoop}, corrections[]{key,from,to,reason}}`；`selfAuditErrors[]{errorId, kind∈假阳性/事实更正/漏检/表述, discoveredAt∈级次, description, evidence, correction, status, issueId}`。
- **校验**（`audit_delivery.py`）：六维必须恰好覆盖、0–10 且 0.5 整数倍、`basis` 不得空、`aiOnly` 可由均值 0.5 取整复算、校正 `from` 必须等于初审分（**只增不覆盖**）且必须给理由、`level=初审` 禁 corrections/withHumanLoop、`level=复审` 必须给可复算的 `withHumanLoop`、错误项 kind/级次取值与 id 唯一。取整用**四舍五入**（非银行家舍入）。
- **渲染**（`audit_delivery.py` 新增 `_scorecard_section`）：员工端新增区块 `#ai-scorecard`（§3 表登记为 06b），**表格**呈现：`维度 × 初审分 × 复审校正 × 最终分 × 打分依据` ＋ 综合分两行 ＋ 校正明细 ＋ 错误项表；文本全部来自受控标签常量或输入数据（通过 §12.2 渲染红线测试）。
- **流程**（`SKILL.md`）：步骤 11 加"同批产出初审自评与错误项（冻结前）"；步骤 12 加"复审自评＝在初审分上只做补充与校正 + 追加错误项"。
- **spec**（`references/11-html-delivery-spec.md`）：新增 §6.3「AI 审核评分卡（自评·表格呈现）」——级次/六维/分值/综合分/只增不覆盖/级次约束/错误项/渲染八项口径 + 口径来源声明；§3 区块表加 06b 行。
- **契约测试**：`test_audit_delivery` 30 → **41** 项（缺维、越界/步长、空依据、aiOnly 不可复算、校正 from 不符、校正缺理由、初审禁校正、复审必给可复算 withHumanLoop、错误项 kind/重复 id、以及"评分卡渲染为表格"）。
- **⚠️ breaking（同前例）**：`aiScorecard`/`selfAuditErrors` 进入顶层 `required` → 既有交付件需补这两个字段；样例 `audit-result.sample.json` 已同步。本案 BG0312 v1.3 若需带评分卡，属案例侧动作（另行执行）。
- **知识库侧待办（不在本仓执行）**：① 若要把六维分数与错误项纳入台账/氚云字段，先在《审核统计与台账规范》§1 登记字段与受控取值（含维度词表）；② 是否把六维词表收进《标签词典》。
- **验证**：`kb_tool.py validate --skill-root skills` error=0/warn=0；六套件全绿；`git diff --check` 通过。

## 2026-09-11 · feat(skills) · 阶段二复核对照加「在件核验」三态与闭环核验，并固化阶段二取回脚本

- **问题（真实判例，源自 2024-300149-LX0551-BG0312 三轮回溯）**：人工复核意见提出于审前轮次，被审件是最终版；
  定稿已修复的事项 AI 报不出来才是正确行为。原步骤 12 把「复核独有」直接当漏检候选 → 会把人工工作成果误计为
  AI 失分（本项目实测把 1 条真漏检高估为 8 条）；且「复核答复称已改」不能当落实证据——本项目 4 项未闭环。
- **步骤 12 重写**（`skills/crwu-audit/SKILL.md`）：复核独有项先做**在件核验**再定性——核验该事项在被审件最终版中
  是否已落实，给出**在件位置**（文件+行号/单元格）与复核原文并列留痕；三态 `L-resolved`（已落实→不计漏检、不进命中率
  分母）/ `L-open`（未落实→隔离补审）/ `L-uncheckable`（不可读→记未检查项）；复核答复文本仅阶段二读取，**闭环核验**
  答复称已改是否落地，未落地单列 `L-unclosed`（优先回客户）。禁止跳过在件核验直接补审或计漏检。
- **schema + 校验器 + 渲染（同批原子）**：`audit_result.schema.json` 顶层 `reviewComparison` 的 `reviewerOnlyItems[]`
  新增 `inFileResolution`（enum 四态）+ `inFileEvidence`（被审件在件位置）+ `closureEvidence`（答复出处），`metrics` 加
  `denominatorExclResolved`/`aiHitRateExclResolved`（两个分母并列，只报「含 L-resolved」会低估 AI）；顶层加
  `hiddenRegionAccess[]`（H1 授权留痕：authorizedBy/authorizedAt/authorization/scope/notRead）。
  `audit_delivery.py` 校验三态取值与在件/答复证据、`hiddenRegionAccess` 结构，渲染拆为逐单元格单一输入值
  （不拼接，守住 §12.2 渲染红线）。样例 `audit-result.sample.json` 同步补字段。
  **注意**：`reviewerOnlyItems` 新增 required 字段是**加法但含 breaking**——旧阶段二产物需同步补字段（本案 v1.3
  `status=not_performed`、该数组为空，不受影响）。
- **spec 同步**（`references/11-html-delivery-spec.md`）：§3.1 术语映射加 L 四态；§6.1 表格加 L-resolved/open/unclosed/
  uncheckable 三行；§6.2 加「在件核验证据」与「命中率分母并列」两条。
- **H0/H1 补两条**（`references/00-input-and-route-profile.md`）：H0 加**多版本隐藏结构不一致**→ 元数据级可见区提示
  （定稿/送审稿隐藏结构不同，只比对隐藏元数据不读内容）；H1 加**留痕字段**（hiddenRegionAccess + `hidden_authorized_read_*`
  evidenceRole）与**隐藏列求和排除合计行/小计行**（以可见区正式合计为准）。
- **阶段二取回脚本固化**：新增 `skills/crwu-audit/scripts/fetch_review_records.py`（只接受阶段一排除清单内的 fileId、
  落 `复核-人工/`、禁写 `材料-源/`、逐件校验字节数、写 `.fetch-manifest.json` 留痕）+ 契约测试 4 例；SKILL.md 步骤 2 补
  「阶段一排除清单 → 阶段二按清单取回」闭环。`prepare_materials.py` 新增**多版本隐藏结构比对**（输出
  `hiddenStructureDrift`，元数据级）+ 契约测试 2 例。
- **契约测试增量**：`test_audit_delivery` +6（三态校验与双分母）、`test_prepare_materials` +2（隐藏结构漂移）、
  `test_fetch_review_records` 新增 4；全绿。
- **知识库侧待办（不在本仓执行）**：3.1「成本法方法层应披露事项」CHK 落点 `06-规则库/清单-M-成本法/不动产-房产-成本法-
  报告审核`（该清单是无人认领的旗舰清单，须先确认方法轴是否装配）；完成后用 crwu-dws 实时拉取验证 CHK 存在，再改
  `crwu-audit-asset-realestate/references/02-review-focus.md`（3.2）。本轮不动。
- **验证**：`kb_tool.py validate --skill-root skills` error=0/warn=0；五套件全绿；`git diff --check` 通过。

## 2026-09-11 · fix(skills) · 材料准备补"压缩包先解压再审核"（含 GBK 文件名解码与 zip-slip 防护）

- **触发（真实漏检）**：BG0312 一案 `材料-源/参考材料/2022年土地房屋测算表.zip` 内是 **2 份测算底稿**，其中
  「13-轻型汽车-土地使用权-**工业拟变更住宅**-测算底稿.xlsx」**本次从未被审核过**（v1.2 覆盖的是"土地使用权-市场法"底稿）——
  上一版 `prepare_materials.py` 把归档一律记为"压缩包：未解压审核"就跳过，属潜在假阴性；`建筑物照片.zip`（18 项）同样被跳过。
- **规则（`crwu-audit/references/00` + `SKILL.md` 步骤 3 + datacheck 输入口径）**：盘点遇归档**必须先解压再审核**，
  解压产物与源材料同等对待（提取文本、重建工作版、执行隐藏区隔离），禁止以"未解压"跳过；解压落 `<案例>/解压/<归档名>/`，
  **源材料目录零写入**，盘点以 `originArchive` 记录来源；**阶段一隔离门禁优先于解压**（归档内复核记录类文件不解压、只记名字）；
  安全上拒绝绝对路径/`..` 越界（zip-slip）/符号链接，条目数与解压总量设上限，超限记 capability gap。
- **实现（`skills/crwu-audit/scripts/prepare_materials.py`）**：新增 `is_archive()` / `extract_archive()`，支撑
  `.zip`/`.tar`/`.tar.gz|.bz2|.xz`/`.tgz` 等（stdlib）；`.rar/.7z` 尝试 `7z/unar`，缺工具则记
  「该件本次未核」而非"材料缺失"；**zip 内 GBK 文件名重解码**（未置 UTF-8 标志位时按 cp437 读出的乱码名还原为中文，
  否则连材料是什么都无法判断）；嵌套归档限深 2 层。`prepare()` 改为队列式：**解压产物入队并按同一套逻辑继续处理**，
  盘点结构升为 `{items, archives}` 且每项可带 `originArchive`；图片格式识别扩展到 jpg/png/webp/tif 等。
- **契约测试 +5 例**（共 15 项）：归档解压且产物出工作版、GBK 文件名解码（字节级构造真实 GBK 包，因 `writestr` 会自动置
  UTF-8 标志位）、zip-slip/绝对路径/符号链接被拒且如实记账、复核记录类条目按隔离门禁不解压、不支持的格式记 capability gap。
- **真实材料实测（只读副本，未动案例产物）**：两个归档均解压成功——`建筑物照片.zip` 18/18 项、
  `2022年土地房屋测算表.zip` 2/2 项；GBK 名正确还原为「13-轻型汽车-土地使用权-工业拟变更住宅-测算底稿.xlsx」并生成工作版
  （隐藏残留 0）；盘点 26 → 46 件；**源材料目录仍为 26 件、零污染**。
- **待人工决定（本条不擅自改结论）**：上述"工业拟变更住宅"底稿属本次未覆盖材料，是否纳入补审、以及是否影响 v1.2 结论，
  需另行授权后处理（与 v1.2 的 H1 授权相互独立）。
- **验证**：`test_prepare_materials` 15/15、其余四套件全绿；`kb_tool.py validate --skill-root skills` error=0/warn=0；
  `git diff --check` 通过。

## 2026-09-11 · fix(skills) · 隐藏区规则分 H0/H1 两层，并加"隐藏区引用审计"（可复核性缺陷）

- **触发**：新证据表明"隐藏区一律剔除"会掩盖实质问题——本项目中**隐藏列确实是计算输入**：定稿 `投资性地产-土地公允模式` 隐藏列 N（账面价值）被 32 处可见公式引用、驱动可见的 P/Q 列；`土地使用权-测算底稿` 隐藏列 U/V/W/X（评分）被 24 处引用。而上一版 `references/00` 被写成"**绝对不能把隐藏区纳入审核范围**"，**丢掉了 datacheck 原有的"经书面要求可例外"通道**，两技能口径因此不一致，也堵死了合法路径。
- **规则改为两层**（`crwu-audit/references/00` + `SKILL.md` 步骤 3）：
  - **H0（默认 · 铁律）**：隐藏区禁读禁报不变；新增并明确唯一合法的深化动作——**隐藏区引用审计**：只解析**可见格公式的引用坐标**判断是否指向隐藏行/列/隐藏表，**不读隐藏区任何内容或公式**；命中即把该**可见结果**标为「**计算链不可复核**」（可见区缺陷，必须出）。
  - **H1（唯一例外 · 须书面授权）**：仅当委托人/审核负责人**明确书面要求或授权**后才可读隐藏区内容，且须只读最小范围、**单独成条并显式标注"经授权读取的隐藏区"**、留下授权出处；**未获授权时涉及隐藏内容的疑点只能登记「待人工复核事项」，不得进入结论、不得影响严重度**。
  - 判据澄清：**"是否参与计算"只看引用关系，不看隐藏与否**；被引用的隐藏列**不得**因"被引用"就并入工作版（那会重新破坏 H0）。
- **实现**：`prepare_materials.py` 新增 `audit_hidden_references()`——正则解析可见格公式引用（覆盖**绝对引用 `$U$25`**、范围、跨表、带引号表名；排除函数名误判），比对隐藏行/列/表元数据，输出 `hiddenRefs` / `hiddenRefsCount` / `calcChainNotReproducible`（**只有坐标，无内容值**）。契约测试 +2 例（引用隐藏列/行/表被标出、仅自引用不报），共 10 项。
- **实测（只读副本，未动案例产物）**：定稿 `评估明细表` 隐藏列 N → **32 处引用、32 个可见格标记**；`土地使用权-测算底稿` 隐藏列 → **48 处引用、24 个可见格标记**；`土地市场交易案例`/`房屋造价调整` **无引用 → 可安全剔除**。三类判定与人工核出的"可剔除 / 是计算输入"完全吻合，且全程未读一个隐藏格。
- **验证**：`test_prepare_materials` 10/10、其余四套件全绿；`kb_tool.py validate` error=0/warn=0；`git diff --check` 通过。

## 2026-09-11 · fix(skills) · 数据隔离补齐三条纪律并固化工作版重建脚本（源自 BG0312 两次假阳性复盘）

- **问题（真实失效，非假设）**：`2024-300149-LX0551-BG0312` 一案 v1.0 判出 3 条高风险，v1.1 复核确认 **2 条假阳性撤回 + 1 条事实更正**，20 条里只有 7 条动过。根因不是判断标准，而是**案例级准备脚本的两个缺陷**：重建工作版时优先写公式串（重建簿不被重算 → `data_only=True` 读回 `None`，把"公式未重算"读成"数据缺失"，误报"评估结果列全空"）；输出名只取 `basename`（**定稿与送审稿同名**，送审稿覆盖定稿 → 把"使用状况"误判为"自用"）。而 `crwu-audit/references/00` 的「Excel 隐藏数据隔离」只规定"重建法"，**从未规定这两条**——同类项目照技能重写一遍就会再踩一次；且该案交叉记录的 `§6.1` 在全仓被引 4 处而**该编号根本不存在**。
- **A 补规范**（`crwu-audit/references/00-input-and-route-profile.md`，该节重写）：明确 **Excel 隐藏 sheet/行/列/折叠分组是员工手动隐藏、整体排除审核范围**，Agent 处理到此处必须谨慎、**绝对不能纳入审核范围**（禁读禁报、不报错也不报漏；只允许读"哪些行列被隐藏"的结构元数据用于剔除）；新增五条硬性要求——① **缓存值优先**（仅无缓存值才写公式串）② **「值不可得」≠「数据缺失」**（按表计数登记，禁止表述为空白/缺失）③ **输出名唯一 + 来源可追溯**（同名版本消歧、来源子目录与工作版一一对应、禁止静默覆盖）④ **不得改变格式语义**（逐格复制 `number_format`，疑似日期化须回 raw 核对）⑤ **"未列示/缺失/为空"类结论必须回 raw 原件（定稿）复读确认**（该毛病在同一项目复发三次）。另加 **"读不到 ≠ 材料缺失"**：缺依赖/无文本层/加密一律记 capability gap 并声明"本次未核"。
- **B 修引用**：4 处失效的 `§6.1`（`skills/README.md`、`crwu-audit-datacheck/SKILL.md`、`datacheck/references/00-KB装配表.md` ×2）改指该节实际标题。
- **C 固化脚本**（终止"每个案子各写一遍"）：新增 `skills/crwu-audit/scripts/prepare_materials.py`（随技能安装，`--case/--src/--txt/--work`）——重建法只复制可见区、缓存值优先、隐藏区零残留并输出忽略清单（只元数据）、同名消歧并在盘点标记 `nameCollision`、按表登记「值不可得」、逐格保留 `number_format`、折叠分组视同隐藏、隐藏 sheet 只记名字不枚举其行列、源材料目录零写入；`.docx` 在缺 `python-docx` 时**自动回退 `textutil`**，并在结尾汇报缺失依赖。新增契约测试 `scripts/test_prepare_materials.py`（8 项：缓存值优先、公式无缓存值时登记、隐藏内容零泄漏、折叠分组、同名不覆盖、源目录只读、格式保留、缺依赖不静默空返）。`crwu-audit/SKILL.md` 步骤 3 指向该脚本。
- **实测（只读副本，不动案例产物）**：对 BG0312 的 26 件源材料重跑——工作版 5 份齐备、两份同名（定稿 + `__送审稿`）**并标记同名冲突**、隐藏残留全 **0**、「值不可得」按表登记 **34 格**（与人工实测一致）、源目录文件集合未变；`.docx` 回退后**可读 7 → 11**，**定稿与送审稿的评估说明均恢复可读**（此前整份读不到）。开发过程中契约测试另抓出 2 个真 bug（`Worksheet` 无 `.name`；隐藏 sheet 未登记）。
- **验证**：`test_prepare_materials` 8/8、其余四套件全绿；`kb_tool.py validate --skill-root skills` error=0/warn=0（自洽性 lint 通过，新脚本随技能安装）；映射检查器无新增 error（唯一 error 为 `CATALOG_STALE`——本地目录快照为昨日 18:12，本次未改知识库映射，按非新鲜口径核对、未冒称最新）。

## 2026-09-10 · docs(skills) · 自洽性规则进根 AGENTS.md，并保证"单独安装的技能测试只通过或 skip"

- **规则上移**：根 `AGENTS.md` 新增 §Skill Self-Containment（会话级常驻规范，先于 skills/AGENTS.md 被读到）——不得引用的四类写法、正确写法清单、两类例外、机器门禁与指向 `skills/AGENTS.md` §「技能自洽性」的完整清单；Development Guidelines 里原长句收敛为一行指针，避免两处漂移。`skills/AGENTS.md` §5 注明两处是同一规则的两个表述、改动需同步。
- **安装副本不再失败**：三个源仓契约测试原先只声明了"源仓契约测试"，单独安装某技能后仍会因缺少同级技能而失败。现统一加 `_REQUIRED_SIBLINGS` 完整技能族判据与 `@_requires_skill_tree` 守卫：任一必需同级技能不在（即"只装了单个技能"）→ **显式 skip**。判据写死为"任一技能单独安装后，自带测试只能通过或 skip，不得失败"。
- **实测（模拟单独安装）**：只装 `crwu-audit` → `test_audit_delivery.py` OK、`test_audit_multiaxis_router.py` OK(skipped=4)；只装 `crwu-dws` → `test_dws_source_contract.py` OK(skipped=7)；只装 `crwu-audit-skill-maintainer` → `test_audit_skill_maintainer.py` OK(skipped=6)。源仓内四个套件仍全绿。
- **验证**：`kb_tool.py validate --skill-root skills` error=0/warn=0；四个套件全绿；映射检查器 error=0/warning=0；`git diff --check` 通过。

## 2026-09-10 · fix(skills) · 技能全面自洽化：不再引用代码仓库目录，并加机器门禁

- **问题**：技能正文与技能内脚本仍在引用**代码仓库**的位置——`docs/design-*.md`（设计依据）、`docs/cli-manual.md`（CLI 手册）、`./bin/darwin/crwu`（构建产物）、`docs/CHANGELOG.md`/`skills/README.md`（源仓登记），以及以仓库根为前缀的跨技能脚本路径 `skills/<技能>/scripts/…`。技能以副本安装到 agent skills 根后这些路径全部不存在：`h3yun-query` 的手册链接直接失效，跨技能命令也按错误位置寻址。
- **技能正文（12 文件）改为自洽写法**：设计依据/口径写回本技能 `references/`；跨技能脚本改称「`<技能名>` 技能的 `scripts/<file>`」、命令用 `python3 "$SKILLS_ROOT/<技能名>/scripts/<file>"`；CLI 用法与字段统一以 `crwu scheme`（运行时命令目录）为准，`crwu` 用 PATH 命令而非 `./bin/<平台>/crwu`；源仓登记动作改为功能性表述（源仓设计文档/技能清单/变更纪要）。
- **技能内脚本（4 个契约测试 + 检查器 + 2 个 README）**：定位 skills 根与源仓根一律由 `__file__` 上溯推导（新增 `SKILLS_ROOT`，`REPO_ROOT = SKILLS_ROOT.parent`），不再硬编码仓库布局；三个测试去掉 `REPO_ROOT / "skills"` 与 `"skills/…"` 字面契约键；`test_audit_delivery.py` 本自洽，删掉未用的 `REPO_ROOT`。
- **唯一保留的仓库耦合**：`test_dws_source_contract.py` 需要校验两条源仓设计文档——现单列为 `PINNED_SOURCE_REPO_FILES`，并在 `docs/` 不存在（已安装副本）时**显式 skip**（新增 `test_source_repo_docs_are_optional_outside_the_source_repo`），不静默通过也不误报失败。
- **机器门禁（新增）**：`kb_tool.py` 增加「技能自洽性 lint」`repo_reference_lint` 并接入 `validate` —— 拦截技能目录内 `docs/`、`tools/`、`cmd/`、`internal/`、`bin/`、`Makefile`、`go.mod`、`skills/<技能>/` 及逃出技能目录的相对链接；只扫描真正的技能目录（skills 根的 `AGENTS.md`/`README.md` 是源仓文档，不算技能）；剔除 shebang 的系统路径与外部 URL 误报；支持 `# lint-self`（规则定义行）与文件头声明「源仓契约测试 / 源仓维护工具」两类豁免。
- **回归测试**：`test_audit_skill_maintainer.py` 新增 6 例（仓库目录拦截 8 种写法、逃出技能目录的链接、源仓契约测试豁免、skills 根文档跳过、系统路径/URL 不误报、**真实仓库每个技能都自洽**），57 → 63 项全绿。
- **规范沉淀**：`skills/AGENTS.md` §「Skill 自带脚本」扩写为 §「技能自洽性：不得引用代码仓库（硬规则）」——不得引用清单、正确写法对照表、脚本归属与目录内聚、两类例外（外部工具 / 源仓契约测试）、迁移与校验；根 `AGENTS.md` 指引同步。
- **验证**：`kb_tool.py validate --skill-root skills` error=0/warn=0（自洽性 lint 生效）；四个套件全绿；映射检查器 error=0/warning=0；`git diff --check` 通过。

## 2026-09-10 · refactor(skills) · 技能依赖的脚本全部收进各技能 scripts/，并确立"Skill 自带脚本"规范

- **问题**：技能正文要求执行的脚本散在 `skills/` 之外——`tools/audit/`（5 件：`audit_delivery.py` + `audit_result.schema.json` + `examples/` + `README.md` + `test_audit_delivery.py`）与 `tools/kb/`（5 件：`kb_tool.py` + `README.md` + 三个契约测试）。`crwu-audit` 的 SKILL.md 甚至自述"部署环境未含 `tools/audit/`（技能以副本安装）时记 capability gap"——即该技能**强制要求的 HTML 交付链路在独立安装时结构性不可用**；`kb_tool.py` 亦被写成"可执行路径由部署环境注入"。技能以副本安装时这些脚本整体缺失。
- **迁移（`git mv` 保留历史）**：`tools/audit/*` → `skills/crwu-audit/scripts/`（含 `examples/`）；`tools/kb/kb_tool.py` + `README.md` → `skills/crwu-audit-skill-maintainer/scripts/`（跨技能共用脚本归口维护器）；`test_audit_multiaxis_router.py` → `skills/crwu-audit/scripts/`；`test_dws_source_contract.py` → `skills/crwu-dws/scripts/`；`test_audit_skill_maintainer.py` → `skills/crwu-audit-skill-maintainer/scripts/`（随被测脚本）；`tools/` 目录已清空移除。
- **脚本内常量**：四个测试的 `REPO_ROOT` 由 `parents[2]` 改 `parents[3]`（新层级 `skills/<skill>/scripts/<file>`）；`kb_tool.py` 的两处引用改指新位置；`audit_delivery.py` / `schema` / `README` 内示例命令与样例路径同步。
- **暴露出的一处真实违规**：`kb_tool.py` 的 README 移入 `skills/` 后立即被自身的引用卫生 lint 判为 error（含已废止的本地知识库根常量、根路径字面与本地根相对引用写法，共 5 处）。已按"技能内不得写这些字面"改写该 README——这恰好印证规则的必要性：它在 `tools/` 下时不受 lint 约束。
- **现行文档同步**：`crwu-audit/SKILL.md`（步骤 11/14：脚本随技能安装，仅当副本缺 `scripts/` 时记 gap）、`crwu-audit/references/11-html-delivery-spec.md`、`crwu-audit-optimize`（SKILL.md + references/00/01/02）、`crwu-audit-skill-maintainer/references/05`、`crwu-audit-datacheck/references/00-KB装配表.md`、`skills/AGENTS.md`、`skills/README.md`、`docs/design-crwu-audit-skills.md`。带日期的历史记录（本文件旧条目、`docs/review-*`、`docs/superpowers/plans|specs/*`）按约定**不回改**。
- **规范沉淀**：`skills/AGENTS.md` 新增 §「Skill 自带脚本（`scripts/`）」——硬规则（技能依赖的脚本必须在自身 `scripts/` 内随技能安装）、归属唯一性与跨技能引用方式、目录内聚（README/schema/examples/test 同目录）、外部依赖的例外写法、迁移纪律（路径常量 + 全部现行引用点 + CHANGELOG，历史记录不回改）与校验要求；根 `AGENTS.md` Development Guidelines 增一条指引。当前无例外项（`pull_全量画像.py` 属部署方外部工具，已在技能内标明本仓不提供）。
- **验证**：四个契约测试在新位置全绿（`test_audit_delivery` / `test_audit_multiaxis_router` / `test_dws_source_contract` / `test_audit_skill_maintainer`）；`kb_tool.py validate --skill-root skills` error=0/warn=0；映射检查器 error=0/warning=0；`git diff --check` 通过。

## 2026-09-10 · fix(skills) · 知识库今日改版后同步 8 个业务叶子与 optimize 指针，并修两处映射检查器缺陷

- **触发**：知识库当日（2026-09-10）改版——8 个一级业务目录补齐 `共同审核点`、27 个子业务 `01-业务通用审核要点` 由「必检项待补」改为真实内容、新增 `合并对价分摊`、`股权比例变动`/`其他目的` 补要点、清理 `01-业务路线/TODO/`、移除 `00-总纲/目录地图`。技能文本仍停留在旧状态（7 个业务叶子写着"一级根未提供 `共同审核点`（不记缺口）"、全部子业务标「待补」），属典型的"知识库已改、技能没跟"。
- **核对口径**：经 `crwu-dws` 实时拉取目录两次（17:51 / 18:12，节点集一致：257 节点 / 94 目录 / 163 文档 / complete）＋ 逐份实时读取 8 份 `共同审核点` 与 27 份 `01-业务通用审核要点` 正文；实测 110 条共用层必检项、305 条子业务必检项、448 条历史高频复核问题。**不改知识库、不复制正文进技能**。
- **技能同步（16 文件）**：`crwu-audit-biz-*` × 8 的 `01-kb-assembly.md` 与 `02-review-focus.md` —— 共用层状态改为"已提供且非占位"并给出路径键 `<一级根>共同审核点`；22 个子业务必检项改为实测条数与主题标签；5 个子业务（拍卖与处置、转让与出售、ABS及发债、并购与重组、股权转让）保留「待补」gap 声明不补造；补齐 `合并对价分摊` 并修正 `股权比例变动`、`其他目的` 的"无审核文件"旧结论。
- **指针修复（4 文件）**：`crwu-audit-optimize` 的 `SKILL.md` 与 `references/00`、`01`、`02` 中 9 处 `00-总纲/目录地图` —— 该节点已从库内移除（同位置是氚云项目统计文档，非目录映射），KB 登记点改指仍存在的 `00-总纲/README`；库侧缺口（含库内 README §3 仍引用该文档、以及同为不存在的 `00-总纲/治理/知识库大纲与进度总表`、`00-总纲/执行契约/01-04-*.md` 实为 01~03）登记在 `references/00` §2.1，不代改知识库。
- **检查器修复（`skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py`）**：① `BUSINESS_COMMON_REVIEW_NOT_REFERENCED` 原只判"字面出现"，叶子写"一级根**未提供** `共同审核点`"反而通过（本轮真实漏报）→ 改为**正向断言**：必须给出 `<一级根><共同审核点节点名>` 路径键；② `--emit-map` 的「库内路径键健康」诊断表把未命中键以反引号写回校准表，而该校准表本身在扫描范围内 → 下一轮把这张表当成本文件的新漂移（非幂等，并把别的技能的漂移重复记到维护器名下）→ 该表不再写反引号；③ `--emit-map` 的通知行在 `--format json` 下改走 stderr，保证 stdout 是唯一可解析报告对象。
- **回归测试**：`tools/kb/test_audit_skill_maintainer.py` 新增 2 例——`test_negative_common_review_claim_does_not_satisfy_the_reference`、`test_emitted_calibration_table_does_not_become_drift`（52 例全绿）。
- **校准与门禁**：`crwu-audit-skill-maintainer/references/07-kb-skill-map.md` 已刷新（257 节点 / error 0 / warning 0，129 处寻址键全部命中，二次运行幂等）；内容级备注写明本次正文核对结论与剩余缺口。`references/05-validation-and-delivery.md` 同步 finding 语义与 `--emit-map` 幂等要求。`kb_tool.py validate --skill-root skills` error=0/warn=0。
- **未做项**：知识库侧 5 份必检项「待补」、2 份空索引文档、缺失的 `目录地图` 均只登记 gap，不代改、不补造。

## 2026-09-10 · feat(skills) · P0-1 通用披露层归属：新增 public 轴通用准则能力，并补公共轴映射门禁

- **问题**：报告通用披露层只作为「其他轴共享依赖」登记在资产叶子 `skills/crwu-audit-asset-realestate/references/01-kb-assembly.md` §3 一处，`07-skill-registry.md` 的 `public` 轴只有表格勾稽，`08-union-dispatch-rules.md` 的 `public_skills` 写死为「仅当存在表格」。对象不是房地产时通用披露层无人装配（设备/企业价值/无形资产场景结构性出不了专业结论）；该登记同时违反 `12-leaf-common-contract.md` §4「方法正文、监管正文与全局契约由 router 其他轴装配，不复制进本轴根映射」。
- **新增**：`skills/crwu-audit-public-general-standards/`（`SKILL.md` + `references/00-applicability.md` / `01-kb-assembly.md` / `02-review-focus.md`），canonical label `通用准则`，public 轴两个装配根 `06-规则库/02-通用准则-报告与披露/` 与 `06-规则库/03-通用准则-程序与档案/`。原来的「通用披露层」单点扩为**报告披露层 + 程序质控层**，两层各自独立出条目状态。
- **正文核验（本次经 dws 实时下载，19 份文档）**：报告准则 `RULE-01-02-251~279`（251~260 总则与基本遵循 / 261~279 报告内容与附则，A 级已发布）；程序准则旧版 `RULE-01-02-101~127`；程序准则 2026 版 `RULE-01-02-001~028`；质控指南 2026 `RULE-01-02-401~456`。技能只保留归纳要点 + RULE 编号 + 库内层级路径寻址键，不复制正文。
- **版本纪律（本次核出的关键判定前提）**：程序准则 2026 版（中评协〔2026〕5 号）与质控指南（中评协〔2026〕6 号）**自 2027-01-01 起施行**，旧版程序准则（中评协〔2018〕36 号）**至 2026-12-31 仍现行** → 2026 年内报告按旧版整段引用，禁止新旧条款混引、禁止以新版新增要求倒查旧版期间报告；六处新旧差异（程序环节 7→9、程序缺失处理、内部审核→分级审核、出具前再审核、业务报备、涉密档案）已在技能内逐条登记。
- **内容缺口如实登记（不补造）**：机构质控旧版（中评协〔2017〕46 号）未精编 → 2026 年内机构质控对照无现行依据；利用专家工作准则（中评协〔2017〕35 号）精编待办，仅有索引卡；报告准则重构期待跟踪；声明要素条目数在规则条目与模板参考文件间表述不一致（六项/七项）列为待核项。
- **改动（源仓）**：`crwu-audit/references/07-skill-registry.md`（新增 public 行）、`08-union-dispatch-rules.md`（`public_skills` 改为「恒含通用准则 + 条件含 datacheck」，并新增「设备类报废物资残余价值评估」稳定并集示例）、`crwu-audit/SKILL.md` 步骤 7（公共能力按各自触发条件独立求值）；`crwu-audit-asset-realestate/references/01-kb-assembly.md` §3 由 4 个跨轴键收敛为 1 个（删 `REPORT_DISCLOSURE_GENERAL`/`EXECUTION_CONTRACT`/`CALIBRATION_BACKTEST`，`VALUATION_METHOD_INTERFACE` 标注为待剥离过渡登记，避免方法准则层回归）。
- **门禁补盲（同批）**：`skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py` 此前 `audit_rows` 只取 `AXIS_ROOTS`（asset/business）行、`skill_dirs` 只按 asset/biz 前缀收目录，公共轴不受映射门禁保护。新增 `PUBLIC_AXIS` 独立校验分支：目录存在、frontmatter 名一致、声明一份 KB 装配表（`01-kb-assembly.md` 或横切能力沿用的 `00-KB装配表.md`），不套用一级根/轴前缀规则；库内路径键仍由 `inspect_path_keys` 统一校验。`references/05-validation-and-delivery.md` 同步 finding 语义与判定边界。
- **测试**：`tools/kb/test_audit_skill_maintainer.py` 44 → **50 项**（新增 `PublicAxisMappingTest`：公共技能目录缺失 / 装配表缺失 / frontmatter 不一致 / 多根装配不被套用一级根模型 / 路径键按目录校验 / 横切装配表命名被接受）；`tools/kb/test_audit_multiaxis_router.py` 9 → **11 项**（新增无条件公共技能表达式断言、公共技能目录与门禁断言，并把新技能加入轴前缀白名单）；`tools/kb/test_dws_source_contract.py` 把公共轴 4 个文件显式 pin 进 `PINNED_CONTRACT_FILES`（`_leaf_files()` 只枚举 asset/biz，公共轴否则完全不被覆盖）。
- **验证**：`kb_tool.py validate --skill-root skills` → warn=0 / error=0；映射检查器对真实 `crwu-dws` 三种产物（`目录快照.json` / `node-index.json` / `目录树.md`，均带 `--max-age-hours 2`）→ **错误 0 / 警告 2**（基线 warning 2 保持不变，为 `股权比例变动`、`其他目的` 两个库侧空子业务）；`test_audit_delivery.py` 24 项通过；校准表已用真实快照 `--emit-map` 刷新。
- **同步登记**：`docs/design-crwu-audit-skills.md` §4 能力树 + §7.3 + §8、`skills/README.md`（技能表新增一行；并修正其中带 `.md` 后缀的寻址键示例——治理明文禁止，检查器会报 `KB_PATH_KEY_HAS_EXPORT_SUFFIX`）。
- **不做项**：方法轴落地与「清单-M-市场法 / 清单-M-成本法」两个孤儿清单的认领（P0-2，需先定方法轴根模型：根 = `03-评估方法/`）；`04-监管覆盖` 五目录；资产轴其余 7 个 `pending` 能力；运行时技能同步（由部署方 skills 管理机制负责）。
- 未新增/修改 crwu CLI 命令。

## 2026-09-10 · fix · 补齐快照解析的四处形态漂移：真实 crwu-dws 的三种产物与新鲜度门禁全部通过

- **问题（上一轮修复的遗漏）**：上一轮修好了 `parentFolderId` / 嵌套 `children` / `stats.complete`，但仍按**测试 fixture 的形状**读字段，真实 `crwu-dws` 落盘产物继续不通过。实测三类残留：
  1. **时间字段**：`load_catalog` 两处分支读 `data.get("fetchedAt")`，真实 `目录快照.json` 与 `node-index.json` 都是 **`fetched_at`** → 治理明文要求的 `--max-age-hours` 门禁报 `[error] CATALOG_NOT_LIVE · catalog carries no readable capture time`（此时无该参数则为 error 0，故此前未被发现）。
  2. **完整性标志**：真实快照把 `complete` / `truncated` 写在**顶层**，检查器只看 `stats.complete` 与旧式 `evidence[]` → `complete` 恒为 `None`（完整性未知）。
  3. **node-index 命名与目录判定**：真实 `crwu.kb-node-index.v1` 用 camelCase **`byPath`/`byNodeId`/`byName`**（无 `nodes` 键），且 `byPath` 的目录键**不带尾斜杠**、须靠条目 `type` 判目录 → `--catalog node-index.json` 直接报 `node index nodes must be an object`，完全无法加载。
  4. **目录树格式**：真实 `目录树.md` 用 `/ <folder>` + `- <doc>` 缩进格式（头部还有 `- fetched_at:` / `- workspaceId:` 等元数据行）→ `--catalog 目录树.md` 报 `catalog is neither supported JSON nor a pasted Markdown directory tree`。
- **影响（修复）**：`skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py` —— 新增 `CAPTURE_TIME_FIELDS` + `_capture_time()`（兼容 `fetched_at`/`fetchedAt`/`generated_at`/`built_from_snapshot_at` 等别名），`load_catalog` 四个分支统一改用它；`_snapshot_is_complete()` 增顶层 `complete` 与 `truncated` 分支；`_paths_from_node_index()` 改签名为 `(data, nodes=None)`，支持 `byPath`/`by_path`（优先，按条目 `type` 判目录）与 `byNodeId`/`by_node_id`/`nodes` 两套命名，抽出 `_paths_from_node_values()`；新增 `_parse_slash_tree()`（`/`·`-` 缩进树，跳过首个 folder 前的元数据块）并由 `_parse_markdown_tree()` 分派（图标树优先，失败退到斜杠树），`load_catalog` 的 markdown 分支捕获时间正则同时接受 `抓取时间`/`fetched_at`/`fetchedAt`。
- **修复后验证（真实 `~/.crwu/knowledge/dws-dir-cache/中瑞世联评估审核知识库/` 三种产物，均带 `--max-age-hours 2`）**：`目录快照.json`（`crwu.kb-dir-snapshot.v1`）263 路径 / complete=true；`node-index.json`（`crwu.kb-node-index.v1`）263 路径；`目录树.md`（`markdown-tree`）263 路径 —— **三者均 error 0 / warning 2**（warning 2 = `股权比例变动`、`其他目的` 两个库侧空目录），新鲜度门禁不再报 `CATALOG_NOT_LIVE`。
- **测试加固**：`tools/kb/test_audit_skill_maintainer.py` 新增 `CrwuDwsArtifactShapeTest`（4 项，全部按真实产物形状构造 fixture）：snake_case 时间 + 顶层 `complete` 的目录快照通过新鲜度门禁、`truncated=true` 判为不完整、`byPath` 无尾斜杠时按 `type` 判目录（并断言不再误报 `KB_PATH_KEY_HAS_EXPORT_SUFFIX`）、`/`·`-` 缩进目录树可解析且带 `fetched_at` 头可过新鲜度门禁。39 → **43 项全绿**。
- **校准表重跑**：`--emit-map` 对**真实**快照刷新 `skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md` —— 知识库目录抓取时间从代理快照的 `14:06:27` 更正为真实 `14:18:56`，抓取完整性按真实顶层 `complete` 判定为 `complete=true`，寻址键检查 81 → **98 个全部命中**；人工「内容级校准备注」区与追加式「校准历史」区由工具保留（旧行保留在历史表）。
- 说明：本轮的四处漂移与上一轮同源——检查器的形状预期对着测试 fixture 而不是部署产物。**仍待跟进（P1）**：`test_real_repository_library_path_keys_exist` 的真实仓库回归仍硬编码 `/tmp/audit-live/目录快照.json`（探针产物），建议改为环境变量可配 + 自动发现 `~/.crwu/knowledge/dws-dir-cache/<库>/` 下的真实快照。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · fix · 修正快照解析：目录快照按权威 schema（嵌套 children + parentFolderId）解析

- **问题（此前声称的验证是循环自证）**：`check_audit_skill_mappings.py` 把 `crwu.kb-dir-snapshot.v1` 当作**扁平节点表**并按 `parentId` 回溯父链，而 `crwu-dws/references/00-目录快照schema.md` §2/§3 定义的权威形态是**嵌套 `children` + `parentFolderId`**（`stats.complete` 判完整）。此前"三种真实形态路径完全一致 / error 0"的结论，是用**自己用 `parentId` 构造的快照**验证自己得到的，未对权威形态做过验证。
- **影响（实测）**：用符合 schema 的真实快照（263 节点、9 个根层、`stats.complete=true`）复跑，检查器只解析出 **9 条路径**（根层），产生 **97 条误报**（88×`KB_PATH_KEY_NOT_IN_CATALOG`、9×`MAPPING_ROOT_NOT_IN_CATALOG`、9×`REGISTRY_LABEL_NOT_IN_CATALOG`）。该误报由并行评审报告独立复现（其记录的 30 条误报为重跑时点差异）。
- **修复**：新增 `_paths_from_snapshot_nodes` —— 有非空 `children` 即按**嵌套形态**解析（复用 `_walk_snapshot`），否则按扁平形态解析；扁平形态**以 `parentFolderId` 为准**（`parentId` 仅作旧式别名容忍）。`_snapshot_is_complete` 改为优先 `stats.complete`，其次 `failures`，再退回旧式顶层 `evidence[]`。
- **修复后验证**：四种形态（符合 schema 的目录快照 / 旧式扁平快照 / node-index / 目录树）对同一知识库均解析出 **263 条路径**、error=0、warning=2（仅剩库侧两个无审核文件的子业务）；`complete=true` 判定正确。
- **测试加固（原测试正是缺陷来源）**：`test_audit_skill_maintainer.py` 的快照 fixture 从"扁平 + `parentId`"改为**权威嵌套形态**（`children`+`parentFolderId`+`depth`+`stats.complete`），并新增 `parentFolderId` 权威性 / `parentId` 别名的双形态断言；节点名一并去掉 `.md`（导出后缀）；不完整快照用例改用 `stats.complete=false`。38 → **39 项**。真实仓库回归用例的依赖快照已替换为符合 schema 的文件。
- **测试加固（覆盖率）**：`test_dws_source_contract.py` 的 `ACTIVE_CONTRACT_FILES` 原为 23 项固定清单、**叶子文件只覆盖 4/36**；改为固定清单 + **动态枚举全部 asset/biz 叶子文件**（受检 59 个文件）；一级根断言从子串检查（`"directory" in text and "true" in text`）升级为**解析装配表行**：恰好一行 `request_kind=directory`、`kb_root` 属本轴且为二级一级根、不以 `/` 结尾或含 `.md` 即失败、`recursive`/`required` 必须为 `true`、`canonical_label` 必须出现在 `kb_root` 中，并检查三份必备 reference 齐全。
- 说明：本次修正源于并行评审报告的独立发现；结论一并记录在此，避免与前面"已验证"的表述冲突。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · fix · 真实仓库回归改读权威缓存：不再硬编码探针快照，并新增三形态一致性断言

- **问题**：`tools/kb/test_audit_skill_maintainer.py::test_real_repository_library_path_keys_exist` 的「真实仓库回归」硬编码 `/tmp/audit-live/目录快照.json`（手写探针产物，字段为 `parentId`/`fetchedAt`）。所谓"真实仓库 + 真实 DWS 快照"的回归因此从未校验过 `crwu-dws` 真正落盘的产物——这正是权威 schema 漂移（`parentFolderId` / `fetched_at` / camelCase `byPath` / 斜杠缩进目录树）长期未被发现的直接原因。
- **影响**：`tools/kb/test_audit_skill_maintainer.py` —— 新增真实产物定位助手：`DWS_CACHE_ROOT` / `LIVE_CATALOG_FORMS` / `AUDIT_KB_NAME` 常量，`_cache_capture_time()`、`_cache_space_name()`、`_live_cache_dirs()`、`_is_audit_family_catalog()`。`_live_cache_dirs()` 自动扫描 `~/.crwu/knowledge/dws-dir-cache/` 下 **`.cache-meta.json.space.name` 等于 crwu-dws 默认目标库**的缓存目录（`last_successful_at` 最新者优先），并支持 `CRWU_DWS_CACHE_DIR`（整目录）/ `CRWU_DWS_SNAPSHOT`（单文件）覆盖以便 CI 重放；无缓存目录或目录内无 `目录快照.json` 时**干净 skip**（不因空/陈旧 override 报错或误判漂移）。库身份常量只存在于测试侧，不写进任何技能。
- **测试改动**：① `test_real_repository_library_path_keys_exist` 改为在自动发现的权威缓存上跑，并对「非本族知识库」的缓存 `continue`（显式 override 指向别的库则如实失败，不静默跳过）；② 新增 `test_live_cache_artifact_forms_agree_on_the_same_tree` —— 同一缓存目录内 `目录快照.json` / `node-index.json` / `目录树.md` 必须解析出**同一路径集**（集合与数量都比对），并断言权威快照能通过 `--max-age-hours`，作为形态漂移的直接护栏。43 → **44 项全绿**。
- **修复后验证（四种场景）**：默认自动发现 → 44 项 OK 且两条 live 回归实际执行（非 skip）；`CRWU_DWS_CACHE_DIR=<空目录>` → 44 项 OK（skipped=2）；`CRWU_DWS_CACHE_DIR=<另一知识库缓存>` → 如实失败 2 项（提示指错库）；`CRWU_DWS_SNAPSHOT=<权威快照>` → 44 项 OK。
- 说明：本仓测试此前只在自造 fixture 上验证检查器形状；本次把「权威产物」纳入自动回归后，形状类漂移会在本地与 CI 直接被拦截。**仍待跟进**：`test_dws_source_contract.py` 的一级根断言只统计 `request_kind=directory` 的行，asset 叶子 `01-kb-assembly.md:41-44` 的 4 个跨轴共享依赖键仍不被拦截。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · docs · 新增 crwu-audit 技能族评审报告（源仓口径）：通用兜底层缺失 / 旗舰清单孤儿 / 业务轴频次信号丢失 / 快照字段漂移残余

- 影响：新增 `docs/review-crwu-audit-skills.md`（**只读评审报告**，不改任何技能正文）。评审范围限定源仓 `skills/` 的架构、划分、协作、内容支撑与门禁设计；运行态与部署侧问题（已安装版本滞后、`tools/` 未随技能分发、外部 `dws` CLI 与认证前提、附件下载能力等）明确列为范围外，由部署方另行处理，报告不作部署结论。基线：`skills/` 工作区快照（分轴改版提交于 `d9cf150`、治理同步于 `7d0de8f`）+ 知识库目录快照 `中瑞世联评估审核知识库` `fetched_at=2026-09-10T14:18:56+08:00`（263 节点）+ `2026-09-10T14:15:54+08:00` 的本次下载物。
- 说明（P0 结论）：① **通用兜底层无归属**——`REPORT_DISCLOSURE_GENERAL` 只登记在 `crwu-audit-asset-realestate/references/01-kb-assembly.md:42`（全仓仅此一处），`public` 轴只有 datacheck，对象非房地产时通用披露层无人装配；同文件 `:41-44` 另登记 `VALUATION_METHOD_INTERFACE`/`EXECUTION_CONTRACT`/`CALIBRATION_BACKTEST` 三个 method/public 键，与共同约束 §4「不复制进本轴根映射」相冲。② **旗舰清单孤儿**——`06-规则库/清单-M-市场法`（CHK-MKT-001~014）与 `清单-M-成本法`（CHK-CST-001~012）在 `crwu-audit-realestate-rent` 下架后无人引用。③ **业务轴**：8 个叶子的同构属治理明文基线（「新建叶子时以任一 `crwu-audit-biz-*` 的四件套为版式基线」），且叶子对「必检项待补」记 gap 符合治理「部分内容待补但其余可真实归纳 → 可标 available，须声明覆盖不完整并记 gap」，**均不列为缺陷**；真正残留问题是**频次信号未进技能**——核对该次下载物，24 个子业务要点文件合计 258 KB / 560 条历史高频复核问题，每条自带「出现次数 · 项目数 · 分类标签」（如 `1173 次 · 651 个项目`），叶子只保留了分类标签，导致 560 条问题只能等权对待、无法排序分诊。次要结论：业务轴粒度（8 个技能彼此无不同清单，8× 维护成本换 0 增量能力，是否合并属治理决策）；叶子复述共同规则（轴边界句 / 共用层顺序句 / §7 状态表）与治理「不得复述共同规则」相冲；method/overlay 轴 registry 标签与 `03-评估方法/`、`04-监管覆盖/` 目录语义不对齐（成本法/假设开发法/基准地价系数修正法/路线价法无对应目录；「金融/银行」对应目录实为「金融国资」）；叶子→AuditResult 三处字段名互不相同、无映射规范；`request_kind`/`recursive`/`required` 与 crwu-dws manifest 无接口对端；9 个叶子 0 命中 `selected_relative_paths` 与输出自检，asset 叶子缺一级共用层先行、`REAL_ESTATE_OBJECT` 为悬空键、`expected_structure:17` 省略 `不动产准则-` 前缀（违反治理「一级根/寻址键逐字」明文）；契约实现缺口与 P2 杂项（rent 残留 3 处、`泰和里`、契约编号 04/03、optimize 旧画像词、`design-crwu-dws.md §10 决策点 D8–D12` 引用不存在）逐条列出并给出落点。
- 说明（快照字段漂移，发现 → 已修 → 残余）：评审用**真实 `crwu-dws` 扁平快照**（`~/.crwu/.../目录快照.json`，字段 `parentFolderId`）复跑 `check_audit_skill_mappings.py`，测到 **error 105**（96×`KB_PATH_KEY_NOT_IN_CATALOG` + 9×`MAPPING_ROOT_NOT_IN_CATALOG`）**/ warning 9**，catalog 路径被压缩到 188 条（实际 263 节点）；仅补 `parentId` 别名后即得 `一级资产 1 / 一级业务 8 / 错误 0 / 警告 2` —— 证明为字段漂移导致的假阳性。（本报告数字与同批 `fix` 条目的 97 条不同，原因是所测快照形态不同：本条为真实扁平文件，`fix` 条目为符合 schema 的嵌套 `children` 形态；两者共同点是「9 个一级根全判失效 + 大量路径键失效」。）**该缺陷已随同日 `fix` 条目修复并复验**：真实快照现得 error 0 / warning 2 / catalog 263。**残余 P0（本轮新发现，未修）**：`load_catalog` 两处仍读 `data.get("fetchedAt")`，而真实 `目录快照.json` 与 `node-index.json` 均为 **`fetched_at`** → 治理指定的 `--max-age-hours 2` 门禁实测报 `[error] CATALOG_NOT_LIVE · catalog carries no readable capture time`；建议加 `_capture_time()` 兼容 `fetchedAt`/`fetched_at`/`generated_at`/`built_from_snapshot_at`，并按真实快照重跑刷新校准表（`07-kb-skill-map.md` 现记录的抓取时间 `14:06:27` 来自代理快照，真实时间戳为 `14:18:56`）。
- 说明（跑通判定）：技术链路（画像→并集→装配→执行→汇总→冻结→两阶段→交付）规范齐全、可跑通；房地产对象层是唯一有真实内容的资产类型；业务轴的必检项层（§一）全为「待补」（合规记 gap），可用的是 §二 的 560 条历史问题（因频次信号丢失而无法排序）；方法/监管轴全 `pending`；**非房地产对象结构性不可用**（通用兜底层缺失 + 资产轴 7/8 pending）。报告同时声明方法与限制（知识库正文未本地全量留存、RULE 编号无仓内注册表可比对、业务叶子历史条数不可复现、治理文件评审期间在修订）。
- 未新增/修改 crwu CLI 命令；未修改任何 `skills/` 文件。

---

## 2026-09-10 · feat · 送达脚本接入编排层：router 步骤 11 冻结指纹 + 步骤 14 交付调用映射

- 影响：`skills/crwu-audit/SKILL.md`（步骤 11 增冻结指纹命令 `tools/audit/audit_delivery.py digest <冻结快照.json>` 与 `phase1FrozenAt`/`phase1Digest` 写入口径；步骤 14 增编排层交付调用序列 ①汇总 JSON → ②`validate` → ③`render --out` → ④交付 HTML，并写明失败即停止交付、不得绕过、脚本缺失记 capability gap）；`skills/crwu-audit/references/11-html-delivery-spec.md` §14.1 新增"编排层调用映射（脚本接入）"（阶段/命令/输入/输出/失败处理四列表格 + "调用者唯一=crwu-audit 编排层，叶子不得调用"）；`tools/audit/audit_delivery.py` 新增 `digest` 子命令（阶段一冻结指纹，与 renderer 共用规范化序列化）；`tools/audit/README.md` 补编排层接入映射与用法；`tools/audit/test_audit_delivery.py` 增 3 项 CLI 测试（digest 与规范化 sha256 一致、validate 退出码、校验失败时拒绝产出 HTML），共 **24 项全绿**。
- 说明：不加 Makefile / CLI 入口，脚本只由编排层在既定阶段调用——阶段一冻结算摘要、阶段二收口先校验后渲染；`digest` 与 `render` 使用同一规范化序列化（排序键、UTF-8、无多余空白），冻结指纹可复现且可与 `fileTrace.sourceDigest` 互校。部署环境未含 `tools/audit/` 时记 capability gap，只交付 JSON 与校验错误报告，不得跳过校验直接出 HTML。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · 落地送达规范 v1.0 参考实现：AuditResult JSON Schema + 校验器 + 单文件 HTML renderer

- 影响：新增 `tools/audit/`——`audit_result.schema.json`（§9 字段契约，draft 2020-12）、`audit_delivery.py`（纯标准库校验器 + 确定性 renderer，`validate` / `render` 子命令）、`examples/audit-result.sample.json`（【示意】样例）、`test_audit_delivery.py`（21 项契约测试）、`README.md`（用法与维护规则）；`skills/crwu-audit/references/11-html-delivery-spec.md` §14 增“参考实现（已落地）”行；`skills/crwu-audit/SKILL.md` 步骤 14 指向该实现。
- 说明：校验器覆盖 §9.4/§11.1/§12.2——`issueId`/`ruleId`/`recordId` 作用域内唯一、`decision=fail` 且规则性缺陷必须双证据链齐备、`external_formal` 版本不得写“现行”、`kbRelativePath` 必须相对路径、`summary.counts`/`usageCount`/`usedByIssueIds`/复核三条带可重算、阶段二完成后每条阶段一 issue 必须有 `reviewComparison` 且复核独有项进 `reviewerOnlyItems`、`reviewAccessedAt` 必须晚于 `phase1FrozenAt`、未检查项 `reasonCode` 受控枚举，以及绝对路径/`file://`/`nodeId`/凭据类字段的敏感信息扫描。renderer 为**确定性单文件渲染**：九区结构（含折叠的专业审核轨迹）、规则→材料→差异→结论→修改五段式问题卡片、严重程度文字标签与颜色并存、A4 打印样式与表头跨页、空态“本次无此类事项”、嵌入 JSON（`<` 转义为 `\u003c`）与 `sourceDigest`/`embeddedJsonDigest` 可离线追溯；**渲染前校验失败即拒绝渲染**，渲染后自检不通过即报错。测试覆盖 XSS 转义、离线自包含、渲染确定性、空态、打印规范与“文本节点只来自受控标签或输入数据”的防拼接检查，21 项全绿。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · 映射检查器增加「库内路径键存在性」检查（公共轴也查），并修掉 9 文件 25 处旧库路径残留

- 影响（检查器）：`check_audit_skill_mappings.py` 新增 `inspect_path_keys` —— 扫描 `skills/crwu-audit*` 全部 `.md` 的**反引号库内路径键**，逐条与最新目录比对，新增三个 finding：`KB_PATH_KEY_NOT_IN_CATALOG`（键在最新目录不存在）、`KB_PATH_KEY_HAS_EXPORT_SUFFIX`（键带 `.md` 导出后缀，或把文件当目录写）、`KB_PATH_KEY_FOLDER_NEEDS_SLASH`（目录键漏尾斜杠）。此前只校验资产/业务一级根，公共轴（`00-总纲`/`03`/`04`/`06`）的键不受检。
- 判定边界：只判断**本次目录已捕获的顶层容器**下的键（局部快照不会被误读为"另一轴全失效"，与 `MAPPING_ROOT_NOT_IN_CATALOG` 同一原则）；含 `…`／`*`／`<>`／`某`／`待建`／`不存在`／`省略` 的写法视为示例不检查；反引号外散文不扫描。
- 影响（修真实漂移）：检查器首次运行即报 30 条，全部修复 ——
  - **14 处 `.md` 后缀残留**（`crwu-audit`、`crwu-audit-datacheck`、`crwu-audit-optimize` 的标签词典/目录地图/回测报告/校准案例记录/模块条目等）；
  - **4 处编号漂移**：`00-总纲/执行契约/03-防幻觉协议执行细则.md` → 新库 `02-防幻觉协议执行细则`、`04-审核统计与台账规范.md` → `03-审核统计与台账规范`；
  - **9 处我方生成文件缺陷**：业务叶子 `02-review-focus.md` 对库内不存在的文档也写了「路径：」行，把不存在路径当寻址键 → 改为「库内未提供（无此前缀路径）」；
  - maintainer 自身 `SKILL.md` 的反例 `02-资产类型/房地产/` 曾被当成寻址键 → 反例改为非反引号写法，并新增纪律：**本文档里的路径只写库内真名**。
  合计 **9 个文件 25 处**。
- 影响（校准表）：`--emit-map` 产物新增「**库内路径键健康（公共轴也查）**」节，报告检查键数与未命中清单；本节次校准结果 = 检查 **81** 个寻址键，全部命中。
- 测试：`tools/kb/test_audit_skill_maintainer.py` 34 → **38 项**（键存在性、导出后缀/目录斜杠漂移、占位写法不误报、局部快照不误判，以及一项**对真实仓库 + 真实 DWS 快照**的路径键回归——快照不存在时自动 skip）。
- 验证：实时 audit error 30 → **0**、warning 2（仅剩库侧两个无审核文件的子业务）；`test_audit_skill_maintainer` 38/38、`test_audit_multiaxis_router` 9/9、`test_dws_source_contract` 6/6、`test_audit_delivery` 24/24、`kb_tool validate` error=0、`git diff --check` 通过。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · refactor · crwu-audit-optimize 保留并瘦身：重划与维护器的执行边界 + 修 6 处过时/漂移

- 决定：`crwu-audit-optimize` **保留**（不删除）。它独有的"复核反馈 → 规则内容/词表/算法诊断"职责无人替代，且其职责分离由 `docs/superpowers/specs/2026-09-10-crwu-audit-skill-maintainer-design.md` §5 与 §4 非目标明确规定；删除会使"审核意见错了/规则不对"这类反馈失去入口。
- 影响（边界重划）：`SKILL.md` §2 改为「症状 → 落点 → **谁执行**」表 —— **A 规则/清单内容、C 词表/画像取值、D 技能算法与流程（含公共规则落 `12-leaf-common-contract.md` 一份）由本技能执行**；**B 覆盖缺失（一级 Skill 创建）与 E 路径/装配/指针漂移（一级根/registry/classification）一律交接 `crwu-audit-skill-maintainer`**，本技能只给根因、证据、影响面与最低改动集，不自行改结构。新增 §2.2：门禁、逐文件方案与校验口径不再重复定义，统一沿用维护器 `references/04`／`05`。
- 影响（修过时/漂移）：
  1. `references/00-route-profile-schema.md`（**不存在**）→ `references/00-input-and-route-profile.md`（SKILL.md 与 references/01 各一处）；
  2. `crwu-audit/SKILL.md §3 路由注册表`（**已无该节**）→ `references/07-skill-registry.md` + maintainer 校准表 `07-kb-skill-map.md`；
  3. 画像示例的业务主线由旧行为词改为 v2.0 一级业务标签（8 个），并写明历史行为词降级为命中信号；
  4. `references/00` 增执行分界与 §2 落点表标注；§5「三处登记」改为交接维护器代办；
  5. `references/02` 增"门禁与校验沿用维护器"说明；`crwu-audit/references/10-capability-gap-proposal.md` 的落地分工改为"诊断走 optimize、一级 Skill 落地走 maintainer"。
  6. **路径键 `.md` 后缀漂移修正**：资产叶子装配表 6 个单文件路径键去掉 `.md` 并修正编号（`03-防幻觉协议执行细则` → 实为 `02-防幻觉协议执行细则`）。依据：`crwu-dws` 的 `by_path` 键 = **原样精确名**；实测新库「中瑞世联评估审核知识库」263 节点中带 `.md` 者 **0 个**，而旧库「中瑞世联 AI 测试知识库」节点名自带 `.md` —— 带后缀写法是旧库残留，会在 M2 与 `by_path` 不匹配而记 failure。
- 影响（防复发）：`crwu-dws/references/01-审核下载与manifest规范.md` 的 manifest 示例 `requestPath` 改为不带 `.md`，并新增口径：`requestPath` 逐字等于库内节点名，`.md` 只是导出后的本地文件名；旧库带后缀写法属历史残留，迁移后必须去后缀。资产叶子 `01-kb-assembly.md` 同步增「路径键写法」说明。
- 验证：`test_audit_skill_maintainer` 34/34、`test_audit_multiaxis_router` 9/9、`test_dws_source_contract` 6/6、`kb_tool validate --skill-root skills` error=0、`git diff --check` 通过。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · crwu-audit-skill-maintainer 增加知识库↔Skill 映射校准表 + 规范细化

- 影响（新增产物）：新增 `skills/crwu-audit-skill-maintainer/references/07-kb-skill-map.md` —— **知识库 ↔ Skill 映射校准表**，每次 `audit`/`create`/`repair`/`remap` 收尾自动刷新。表内容：校准时间、目录抓取时间、输入形态、完整性、节点数、一级资产/业务数、error/warning/建议；**资产轴**（一级目录 / 标签 / Skill / registry 状态 / 声明的一级根 / 共性参考 / 细分对象(有审核条目) / 本次问题代码）与**业务轴**（同列 + 共同审核点 / 子业务(有要点) / 缺项名）；未登记与待处理 Skill；以及「内容级校准备注」（人工维护、工具不覆盖）与「校准历史」（工具追加、新→旧）。
- 影响（工具）：`check_audit_skill_mappings.py` 新增 `--emit-map PATH` 与 `report.calibration`（机器可读的映射快照）。校准表由最新目录 + registry + 真实目录派生，**状态列禁止手工编辑**；「校准备注」与「校准历史」两区跨次运行保留并把新行追加在历史顶部。
- 影响（SKILL.md 细化）：职责新增校准表维护与"叶子共同约束只写一份"（`12-leaf-common-contract.md`）；词表口径写明 `business_types[]` 只取一级业务标签、历史行为词降级为命中信号；执行步骤新增第 4 步内容级核对（必检项「待补」/空文档/`TODO` 占位/结构断言）与第 8 步校准表同步（每个模式收尾必做，`audit` 也做）；硬门禁新增 6 条——**一级根逐字使用库内精确路径（含数字前缀）**、必检项待补/占位/空文档只记 gap 不补造、叶子不得复述共同约束、校准表只由工具生成、不把子业务与结构缺口列进"需创建"、不冒充"已核实最新"。
- 影响（references）：`04-registry-and-mapping-update.md` 增「校准表」节（定位/生成命令/同步时机/两区语义/目录级自动化与内容级人工的分工）；`05-validation-and-delivery.md` 交付清单与完成判据增列校准表刷新与内容级备注。
- 测试：`tools/kb/test_audit_skill_maintainer.py` 32 → **34 项**（`--emit-map` 生成与备注/历史保留、校准表对缺失子业务与共同层的标注）。
- 校准结果（2026-09-10 本次实时目录）：error 0 / warning 2 / 建议 0；内容级缺口见校准表备注（24 份要点必检项全部「待补」、`共同审核点` 为 `TODO` 占位、2 份空索引、2 个无审核文件的子业务）。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · 业务轴落地：8 个 crwu-audit-biz-* 叶子 + registry/classification 迁移到一级业务词表 + 叶子共同约束

- 影响（新技能）：新建 8 个业务一级 Skill —— `crwu-audit-biz-asset-operation`、`-transaction-disposal`、`-financial-reporting`、`-financing-debt`、`-investment-capital`、`-tax-history`、`-judicial-liquidation-compensation`、`-consulting-review`，各含 `SKILL.md` + `references/00-applicability.md`、`01-kb-assembly.md`、`02-review-focus.md`（共 32 个文件）。每个 Skill 恰好映射一个一级根 `01-业务路线/0N-<一级业务>/`（`directory`/`recursive`/`required`）；26 个子业务只在父级二级索引内选用，不各建 Skill、不建资产×业务组合 Skill。
- 影响（共同约束）：新增 `skills/crwu-audit/references/12-leaf-common-contract.md` —— 资产/业务叶子的共同约束（轴边界、输入、一级根装配、二级选择返回、执行顺序「一级共用层→命中二级条目」、必检项 4 态与历史问题 3 态字段、来源优先级、证据出处、capability gap）。公共规则只写这一份，叶子以 `../crwu-audit/references/12-leaf-common-contract.md` 引用、不复制；`crwu-audit` SKILL §reference 清单与 `crwu-audit-asset-realestate` 已接入。
- 影响（registry/classification 迁移）：`07-skill-registry.md` 的 22 行 `crwu-audit-business-*` 业务行替换为 8 个 `crwu-audit-biz-*` 一级业务行（均 available）；`04-business-classification.md` 升 v2.0 —— `business_types[]` 取值域收敛为 8 个一级业务标签，历史行为词（租赁/清算/破产/资产处置/拍卖/抵押质押/减值测试/计税/追溯评估/复核…）降级为**命中信号**，并补全一级业务→子业务映射。
- 影响（联动）：`08-union-dispatch-rules.md` 的三个示例场景（房地产租赁 / 房地产清算后拍卖处置 / 设备抵押）改用新一级业务与 `crwu-audit-biz-*` 名称；`10-capability-gap-proposal.md` gap 示例同步；`skills/README.md` 登记 8 个新叶子与共同约束；审核技能族设计增 §7.2。
- 依据（真实来源）：本次经 `crwu-dws` 实时拉取「中瑞世联评估审核知识库」（263 节点、failures=0）并导出 35 份业务正文后归纳，未使用旧缓存或历史摘录。**知识库内容缺口如实登记**：24 份 `01-业务通用审核要点` 的必检项要点全部为「待补」；`01-资产经营/共同审核点` 为 `TODO` 占位；`租赁与租金评估` 的两份适用索引为空文档；子业务 `股权比例变动`、`其他目的` 无审核文件。技能不自行补造，在 `02-review-focus.md` 与运行 gap 中声明。
- 验证：映射检查器对本次实时目录 error 30 → **0**、warning 11 → **2**（仅剩上述两个缺文件的子业务）；`test_audit_skill_maintainer` 32/32、`test_audit_multiaxis_router` 9/9、`test_dws_source_contract` 6/6、`test_audit_delivery` 24/24；11 个受影响技能 `quick_validate` 全过；`kb_tool validate --skill-root skills` error=0；`git diff --check` 通过。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · crwu-audit-skill-maintainer 增加实时路由一致性核对层（crwu-dws 最新目录 ↔ router/registry/真实 Skill）

- 影响：新增 `skills/crwu-audit-skill-maintainer/references/06-live-routing-reconciliation.md`。`audit` 不再只比对"某份目录快照"，而是**先经 `crwu-dws` 拉取最新知识库目录**（只读；缓存只用于定位，不得当最新），再与当前 skill 体系逐项对比四层：① 路由机制 ② 路由参考是否注册 ③ Skill 是否存在 ④ 是否需要创建；结论必须标注分级（已核实最新／候选·待核验／无法判定）。
- 契约：`SKILL.md` 增补实时刷新前置步骤、`06` reference 路由与两条硬门禁（不用缓存命中/粘贴目录冒充"已核实最新"；不把细分对象、子业务或结构缺口列进"需创建 Skill"）；`references/01` 把"目录事实"改为本次在线结果并说明离线降级；`references/05` 交付清单增列结论分级与路由机制结论、补全 finding 表。
- 检查器：`check_audit_skill_mappings.py` 新增 `ROUTER_FILE_MISSING`、`ROUTER_REFERENCE_MISSING`、`ROUTER_REFERENCE_UNRESOLVED`、`ROUTER_AXIS_UNDISPATCHED`、`ROUTER_SKILL_REFERENCE_UNRESOLVED`，以及 `--max-age-hours H` 触发的 `CATALOG_NOT_LIVE`／`CATALOG_STALE`。路由层按"真实 `crwu-audit*` 目录 ∪ registry 行"解析技能名，通配（`crwu-audit-asset-*`）与占位（`crwu-audit-<axis>-<label>`）写法不误报。
- 测试：`tools/kb/test_audit_skill_maintainer.py` 26 → **32 项**——router 入口缺失、路由 reference 缺失/未解析、轴未分发、路由命名不可解析技能、快照过期/无时间戳，以及一项**对真实仓库**的路由层一致性回归（router/references/registry/真实目录必须互相解析）。
- 设计记录：`docs/superpowers/specs/…-design.md` §6 增补 v0.3 说明（references 由六份增至七份）。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · crwu-audit-skill-maintainer 支持一级业务目录 `共同审核点`（业务轴共用审核层）

- 影响：`skills/crwu-audit-skill-maintainer/SKILL.md` 增补——一级业务目录下若存在 `共同审核点` 文档，必须与一级根一并拉取并作为该业务 Skill 的**共用审核层**参考：先于子业务条目执行、对该一级业务全部子业务生效、不因命中哪几个子业务而改变；文档不存在不视为缺口，也不得凭经验或旧摘录补造。
- 契约：`references/01-kb-source-discovery.md` 业务目录解释增补识别与处置（位置=一级根直接子文档，数字前缀/`.md` 不影响识别；归属=一级共用层不属于任何单个子业务；缺失不报错；名称近似不自动等同、只报候选交人工确认；导出失败记 capability gap）；`references/02-child-skill-contract.md` 把该文档写入业务轴 `expected_structure` 断言与 `02-review-focus.md` 共用段；`references/03` 合并顺序改为「一级共用层（`共同审核点`）→ 命中子业务通用审核要点」；`references/05` 交付清单与完成判据增列该文档的有无与回指状态。
- 检查器：`check_audit_skill_mappings.py` 新增 `BUSINESS_COMMON_REVIEW_NOT_REFERENCED`（warning）——仅当一级业务目录**确实存在**该文档、而对应 available 业务 Skill 的 `01-kb-assembly.md` 与 `02-review-focus.md` 均未回指时触发；文档不存在不报，避免把条件性约定当缺口。
- 测试：`tools/kb/test_audit_skill_maintainer.py` 23 → **26 项**（存在且未回指→告警；存在且回指→干净；不存在→不报且整体无 finding）。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · refactor · 废止本地知识库根模型（CRWU_KB_ROOT）：正文唯一来源=钉钉；下架 crwu-audit-realestate-rent

- 影响（工具）：`tools/kb/kb_tool.py` 收窄为**只做不依赖本地知识库的校验**——唯一子命令 `validate --skill-root`（引用卫生 + 实时协议 lint）；删除 `index`/`resolve`/`query`/`release`/`assemble`/`extract`/`selftest`（全部建立在本地知识库 md 树上，而该树已迁至钉钉、本地根不再存在，命令实际不可运行）。删除 `tools/kb/examples/`；`tools/kb/README.md` 改写为"引用与实时协议校验"定位。
- 影响（纪律）：`CRWU_KB_ROOT` 常量与 `KB/<相对路径>` 本地根相对引用由"仅 crwu-audit* 目录禁用"升级为**全 skill-root error**；说明性的"某写法已废止/禁止"行自动豁免，避免规范文本自伤。
- 影响（技能）：下架 `skills/crwu-audit-realestate-rent/`（资产×业务组合模型废止，租赁类业务要求改由业务轴 Skill 承载）；`crwu-audit-asset-realestate/references/01-kb-assembly.md` 改为**一级根映射**——唯一主映射 `02-资产类型/房地产/`（`request_kind=directory`、`recursive=true`、`required=true`）+ `expected_structure` 断言 + 二级选择索引（土地使用权等细分对象在已下载目录包内选用）；方法/披露/执行契约/校准改为标注 `owner_axis` 的**其他轴共享依赖**，不再伪装成本技能自有装配。
- 影响（文档口径）：`crwu-audit-optimize` SKILL + references 00/01/02 的 `kb_tool index/assemble/query/resolve/extract` 依赖全部改写为"读叶子装配表路径键 + crwu-dws 实时下载"；`crwu-audit` SKILL 与 `references/00`/`10` 的 legacy assemble 例外条款改写为"装配清单由叶子声明、router 不生成画像键"；`skills/README.md` 与 `docs/design-crwu-audit-skills.md` 的 L0/L1/L2 分层描述改为**分轴并集模型**（历史模型保留标注）。
- 测试：`tools/kb/test_dws_source_contract.py` 重写——活动清单文件须真实存在、逐行禁本地根/正文镜像字面、M2 单文件+目录混装契约、**每个 asset/biz 叶子必须声明递归一级根**、遗留前缀目录必须消失；`test_audit_multiaxis_router.py` 的 registry 断言改为"轴覆盖"，registry↔真实目录卫生交回 skill-maintainer 映射检查器（单一归属），router reference 集纳入 `11-html-delivery-spec.md`。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · feat · 新增 crwu-audit-skill-maintainer：资产/业务 Skill 目录盘点与映射维护

- 影响：新增 `skills/crwu-audit-skill-maintainer/`（入口、六份 reference、只读映射检查器）和 `tools/kb/test_audit_skill_maintainer.py`；同步 `skills/AGENTS.md`、`skills/README.md`、`crwu-audit-optimize/SKILL.md` 与审核技能族设计。
- 说明：支持读取粘贴目录树、DWS snapshot 或 node-index，对照 classification、registry 和真实 Skill，识别缺失的一级资产/业务 Skill、遗留业务前缀、失效一级根、缺少共性参考/细分对象审核条目/子业务审核要点等问题。资产 Skill 使用 `crwu-audit-asset-*`，业务 Skill 使用 `crwu-audit-biz-*`；细分对象和子业务只进入父 Skill 的二级索引，不创建独立或组合 Skill。
- 装配口径：一个资产/业务 Skill 恰好登记一个一级目录根，运行时由 `crwu-dws` 递归下载根内全部支持正文；必检项逐项记录 `符合/不符合/不适用/无法核验`，历史问题逐项记录 `涉及/未涉及/无法核验`，准则保持硬约束。
- 安全：检查器只读；创建、修复和重映射必须先输出逐文件方案并经用户确认。下载正文、manifest、缓存、凭据和运行时 Skill 不进入 source 提交。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-10 · fix · crwu-audit-skill-maintainer 加固：真实 DWS 目录输入、registry 全量校验与 audit 模式定名

- 影响：`skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py` 新增 `crwu.kb-dir-snapshot.v1`（扁平 `nodes[]`，按 `parentId` 上溯重建路径）与 `crwu.kb-node-index.v1`（`nodes{}` 字典，节点自带 `path`）两种**真实** `crwu-dws` 产物解析。此前只接受自造 schema，实际目录缓存无法作为 `--catalog` 输入。
- 检查项：新增 `MAPPING_ROOT_NOT_IN_CATALOG`（声明的一级根已不在最新目录）、`AXIS_ROOT_MISMATCH`（资产 Skill 登记业务根或反向）、`AXIS_PREFIX_MISMATCH`（轴与 `crwu-audit-asset-*`／`crwu-audit-biz-*` 前缀不符）、`REGISTRY_LABEL_NOT_IN_CATALOG`（available 标签无对应一级目录）；`AVAILABLE_SKILL_DIRECTORY_MISSING` 与 `REGISTRY_LABEL_DUPLICATE` 改为对全部资产/业务 registry 行生效，不再因该标签未出现在本次目录快照而漏检。
- 判定边界：仅在该轴容器目录（`02-资产类型/`、`01-业务路线/`）已被本次目录捕获时才判定根失效，只抓一个轴的局部快照不会被误读为另一轴已删除；`REGISTRY_LABEL_NOT_IN_CATALOG` 只针对 `available` 行，`pending` 行的目录缺失属正常中间态。
- 定名：只读模式按设计 §7.4 定为 `audit`，`inventory` 仅作同义旧称；触发描述同时保留 audit/inventory 两个词以便发现。
- 测试：`tools/kb/test_audit_skill_maintainer.py` 由 8 项扩到 22 项，补充真实 DWS 三形态路径一致、不完整快照标记，以及此前缺测的目录缺失、名称漂移、references 缺失、标签重复、未登记 Skill、轴前缀与越界根等用例。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-09 · docs · 送达规范 v1.0 进技能：AuditResult 单一事实源 + 单文件 HTML 交付；下掉技能侧的知识库输出契约引用

- 影响：新增 `skills/crwu-audit/references/11-html-delivery-spec.md`（**CRWU 审核意见 HTML 送达规范 v1.0** 全文收录 + §14 归属/维护/运行时加载说明：统一数据模型、单文件交付、双证据链、五段式判定、两阶段门禁、员工端九区结构、未检查项、专业审核轨迹、AuditResult JSON 契约与校验规则、HTML 安全/A4 打印/嵌入 JSON 规范、发布前验收清单）；
  `skills/crwu-audit/SKILL.md`（必读 references 增第 13 条指向 `11-html-delivery-spec.md`；步骤 9 的 DWS 契约清单由三份减为两份——**去掉交付契约，"交付/送达口径不再走知识库契约"**；步骤 14 改写为按 v1.0 执行：AuditResult JSON 单一事实源 → **每个项目只交付一个自包含单文件 HTML** `审核意见.<项目ID>.html`（离线可开、A4 可打印、含默认折叠的专业审核轨迹；renderer 只呈现不改写，JSON 可嵌入同页但不作独立交付件），发布前过双证据链/五段式/未检查项/统计可重算/无绝对路径与 `nodeId` 与凭据校验；输出清单项同步）；
  `skills/crwu-audit/references/99-maintenance.md`（owner 映射增"送达与交付层 → `11-html-delivery-spec.md`"，并注明该正文为本技能内正式规范、不经知识库下载）；
  `skills/crwu-audit-realestate-rent/SKILL.md` 与 `references/00-KB装配表.md`（裁定表正文指针与输出口径、装配表执行契约行同步去掉 `02-审核意见单规范.md`，改指 `references/11-html-delivery-spec.md` v1.0）；
  `docs/design-crwu-audit-skills.md`（§5 汇总输出与两阶段纪律按 v1.0 改写）；`skills/README.md`（总路由行交付口径改为 v1.0）；
  草案 `docs/02-审核意见单规范-v0.4-草稿.md` 保留为内部逻辑草案留档（其送达层已被技能内 v1.0 取代）
- 说明：员工端送达规则不再依赖知识库输出契约——**送达/交付正文 owner 改为技能内 `crwu-audit/references/11-html-delivery-spec.md`**；crwu-audit 的 DWS 清单只保留防幻觉（03）与统计台账（04）两份契约。核心口径：AuditResult JSON 是唯一权威结果、HTML 只如实呈现；员工侧每个项目只交付一个 HTML；双证据链（审核规则依据 vs 被审核材料证据）与五段式判定（规则/材料/差异/结论/修改）强制；两阶段门禁（阶段一定稿冻结后才允许读复核记录，阶段二对照与漏检反查不得回写阶段一）；未检查项与"不适用"必须显式披露；renderer 不得新增、删除、合并、拆分、升级、降级或润色审核结论。v0.4 草案中的《本次审核记录清单》《复核对照与综合对比》《逐条裁定表》等内部产物由 v1.0 §6/§7/§8/§11 承接。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-09 · docs · 输出契约 v0.4（草稿）：复核对照阶段化 + §5.5 综合对比（AI 独立审核 → 复核对照 → 综合对比）

- 影响：`skills/crwu-audit/SKILL.md`（§1 输入起增"独立审核门禁"；步骤 5 源材料下载排除复核记录改写为
  阶段一门禁；步骤 10–13 两阶段化：10 阶段一收口汇总（定稿前不读复核记录）→ 11 复核对照 A/B/C →
  12 综合对比三条带 + AI 命中率 → 13 统计回填；§5 边界增"复核记录不进叶子/下游上下文"）；
  仓库新增草稿 `docs/02-输出Schema与审核意见单-v0.4-草稿.md`（契约 02 修订稿，含 HTML 注释的变更要点：
  §1 顶层结构增 `复核对照与综合对比` 占位；§2 意见条目 schema 增 `复核对照` 字段（阶段二必附）；
  §5.1 时序门禁表（阶段一 独立审核 / 阶段二 对照）；§5.4 红线 4–6（独立审核门禁 / 禁止回改匹配 /
  "复核独有"判定前提）；§5.5 综合对比（双向三条带 + json/md 样例 + 处理纪律与补审）；§6.1 增
  "复核独有反查"漏检闭环）；
  `docs/design-crwu-audit-skills.md`（§5 增"两阶段输出纪律"）；`skills/README.md`（总路由行补两阶段输出说明）
- 说明：AI 是"先独立审、后对照"的两阶段流程——AI《意见列表》必须在读取任何复核记录（一/二/三级/四级
  意见、质控、底稿/在线意见、答复文件，含氚云字段中的在线意见）**之前**独立产出并定稿，否则复核对照
  A/B/C 与漏检统计失真；复核对照只回答"是否已提出、在哪提出"，不评判人工意见质量；综合对比新增第三向
  "复核独有（复核已提而 AI 未命中＝漏检候选）"——先查快照/逐条裁定表归因，确属漏检 → 独立补审后再
  对照（禁止拿复核记录抄补 AI 意见）或登记 crwu-audit-optimize。契约 02 正文本体在钉钉知识库：
  本仓库只落 v0.4 **草稿**，钉钉/镜像同步待用户执行；04 台账口径如需增记三向计数（M/K/L/R）另属该
  契约维护。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-09 · refactor · `make build` 跨平台产出：macOS 与 Windows 二进制按平台子目录落入 `bin/`

- 影响：根目录 `Makefile`（`build` = `build-mac` + `build-win`；新增
  `bin/darwin/crwu`（macOS，架构默认跟随构建机，`DARWIN_ARCH` 可覆盖）与
  `bin/windows/crwu.exe`（Windows，架构默认 amd64，`WINDOWS_ARCH` 可覆盖）；
  macOS 侧 CGO 开启、Windows 侧纯 Go 交叉编译）、`README.md`、
  `README.zh-CN.md`、`docs/cli-manual.md`、`skills/h3yun-query/SKILL.md`
  （仓库内产物路径由 `./bin/crwu` 改为 `./bin/darwin/crwu` /
  `./bin/windows/crwu.exe`）。
- 说明：`make build` 一次产出 mac 与 win 两种格式二进制，便于分发；仍只写
  `bin/`，`make clean` 全清；`make build-mac` / `make build-win` 单平台构建。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-08 · feat · 新增 crwu-init 技能：crwu 环境初始化 / skills 安装 / 更新分发器

- 影响：新增 `skills/crwu-init/SKILL.md` + `references/agent-skill-dirs.md`；`skills/README.md` 技能表登记。
- 说明：提示型分发器，不产业务能力。流程：确定目标 agent（workbuddy/codex/opencode/deepseek harness，未指定则给选项）→ 联网核实其 skills 安装目录 → 从 `https://gitee.com/mengdong123/crwu-ai` 拉取 `skills/` → 安装全部 / 安装指定 / 更新（同名覆盖含子文件夹，`rm -rf`+`cp -R` 全量替换）→ 校验汇报。内置各 agent 用户级 skills 目录缓存（workbuddy `~/.workbuddy/skills`、codex `~/.codex/skills`、opencode `~/.config/opencode/skills`、dsh `~/.dsh/skills`），执行前联网核实、以官方为准并回写。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-08 · fix · 知识正文仅从钉钉按本次审核清单下载，并支持单文件与目录条目

- 影响：`crwu-dws` SKILL、目录/manifest/缓存 references（M2 收敛为本次审核清单下载；删除整库留档能力；`01-镜像与manifest规范.md` 更名为 `01-审核下载与manifest规范.md`）、crwu-audit 总路由及 realestate/rent/datacheck/optimize 消费方、三份装配表、`skills/README.md`、`design-audit-live-kb-protocol.md`、`design-crwu-dws.md`，并新增 `tools/kb/test_dws_source_contract.py` 契约回归测试。
- 说明：钉钉知识库是知识正文唯一来源；本地仅保存无正文的目录元数据缓存和当前审核工作集。每次审核均重新下载正文，跨审核不得复用。下载清单可混合单文件路径（只下载精确文件）和目录路径（递归下载目录内支持正文），清单外零下载；下载失败不得回退到本地正文。
- 未新增/修改 crwu CLI 命令。

---

## 2026-09-08 · docs · audit 族知识库引用统一到目录级：目录级引用 = 下载该目录**全部**文档（folder 递归），禁止按“本次只用某文件/某段”挑选

- 影响：三份 `00-KB装配表.md`（`crwu-audit-realestate-rent` / `crwu-audit-realestate` / `crwu-audit-datacheck`：装配表路径键统一为目录级并加“目录级引用语义”注记，原文件级/取段键合并为所在目录，如 CHK 清单→`06-规则库/清单-M-市场法/`、`清单-M-成本法/`，契约→`00-总纲/执行契约/`，校准/治理→`00-总纲/治理/`，勾稽口径两文件合并为 `06-规则库/M-数据对齐-勾稽与一致性/`）、`crwu-audit`/`crwu-audit-realestate`/`crwu-audit-realestate-rent`/`crwu-audit-datacheck` SKILL 正文引用句（契约/清单/校准路径改为目录级并注明全量下载）、`crwu-dws/SKILL.md` §6.2（目录级清单项 → 该目录**全部**文档逐一实时下载，目录内不得挑选）、`docs/design-audit-live-kb-protocol.md` §4（补“目录级清单项语义”）
- 说明：知识库内容调整（全部条目发布、结构/治理文件结项改名）后，按用户口径把技能侧“具体引用目录”收敛为目录级寻址并统一下载语义——引用文件夹 = 展开该目录全部内容（folder 递归至无子目录）逐文档实时导出，manifest 逐文件记账；“按文件/按段定位”仅指下载后的定位阅读，不改变下载集合。维护对照类单文件键（`crwu-audit-optimize` refs/00 的编辑落点清单等）保留文件级不变；内嵌“要审什么”概述正文本轮不动（另立项收敛）。
- 回归：`kb_tool.py validate --skill-root` error=0 warn=0；未新增/修改 crwu CLI 命令

## 2026-09-08 · docs · 移除"人工审核待发布/试点门禁"全链路（新口径：知识库文档即权威——装配/路由命中文件按库内层级路径经 crwu-dws 实时下载后**下载即审**，无发布/试点状态判定与 `[依据待发布]` 标注）

- 影响：crwu-audit 族技能/refs（`crwu-audit` SKILL §2 步骤9 + refs 04/99、`crwu-audit-realestate` SKILL + refs00、`crwu-audit-realestate-rent` SKILL + refs00、`crwu-audit-datacheck` SKILL、`crwu-audit-optimize` SKILL + refs 00/01/02：删除 门禁透传/A 发布门禁/试点模式/待人工发布清单/release 状态行/curated_by/reviewed_on/发布登记 等判定语义，装配表"发布门禁"整行删除）；设计文档三份（`design-crwu-audit-skills.md`、`design-crwu-dws.md`、`design-audit-live-kb-protocol.md`：口径改写，协议决策 B 标记 ❌ 已废止）；`skills/README.md`、`skills/crwu-dws/SKILL.md` + refs 01 口径行（CRWU_KB_ROOT 一律"仅维护/离线归档"）；`tools/kb/kb_tool.py` + README（validate 删除"已发布条目须带 curated_by/reviewed_on"检查；assemble 输出"发布门禁/试点模式"段 → "装配说明（无发布门禁：下载即审）"；release 子命令=状态标注信息口径；docstring/注释同步）
- 说明：按用户口径（2026-09-08）下掉"人工审核待发布"功能——路由命中某子技能后，该技能负责给出必须参考的知识库文件地址（库内层级路径键：规则/评估方法/法律文件/业务清单等），业务知识库内文档即"必须审核哪些地方"的总结与依据，装配命中后实时下载**直接审核**，不做"未发布→试点"判定、不标 `[依据待发布]`、不读《待人工发布清单》判定门禁；知识库内容侧历史"待发布/A 内容核验"标注仅信息残留、AI 不读取判定（清理归知识库维护）；kb_tool release/pending 保留为纯信息口径；技能内嵌"要审什么"正文本轮不动（后续如需收敛为纯地址指引另立项）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-08 · docs · crwu-dws v0.4 + crwu-audit 族实时引用协议改造（R1–R5：目录可缓存、正文零缓存、清单驱动、实时下载、编号+层级路径寻址）

- 影响：`docs/design-audit-live-kb-protocol.md`（新，v0.2 定稿）、crwu-audit 族 13 份技能文件（`crwu-audit` SKILL/refs 04/99、`crwu-audit-realestate` SKILL/refs00、`crwu-audit-realestate-rent` SKILL/refs00、`crwu-audit-datacheck` SKILL/refs00、`crwu-audit-optimize` SKILL/refs 00-02：源仓与 ~/.skills-manager/skills 真身双份同步，.dsh/.workbuddy 软链视图）、`crwu-dws` SKILL.md+refs 02（v0.4：M2-A 按清单实时下载/M2-B 全量镜像、M3 路径寻址、node-index 全路径键 by_path）、`tools/kb/kb_tool.py`+README（validate 实时协议 lint）、`skills/README.md`、`docs/design-crwu-dws.md`（v0.4 登记）、`docs/design-crwu-audit-skills.md`（残留清理）
- 说明：按用户口径（正文文件零缓存、每次审核实时下载、下载清单=crwu-audit 路由/子技能装配产出）落地实时引用协议——audit 族技能删除"KB 根（CRWU_KB_ROOT=~/.crwu/knowledge/knowledge-base）"根常量句与 `KB/…` 根相对引用，改为 RULE/CHK 编号 + **库内层级路径**寻址（三不写：知识库名称/本地根路径字面/nodeId 硬编码；nodeId 每次由 crwu-dws 动态解析）；引用正文一律经 crwu-dws 按**本次审核文件清单**实时下载（M2-A，逐文件 exportedAt，出处=本次下载文件:行号+exportedAt；清单外零下载；M2-B 全量镜像仅显式留档）；门禁判定改为实时下载《待人工发布清单-*.md》+文件头 release/confidence 标注（试点 `[依据待发布]` 语义不变）；下载不可得→显式报告，禁止读本地静态副本冒充实时；kb_tool validate 增实时协议 lint（`--skill-root` 扫 crwu-audit* 目录：禁 CRWU_KB_ROOT=/~/.crwu//knowledge-base 字面与 nodeId 赋值，`--forbid-literal` 禁库名；纪律文本自动豁免）；本地静态根降级为 维护/发布登记/离线归档（不冒充实时）；运行时部署表述更正为真身 ~/.skills-manager/skills（.dsh/.workbuddy 软链）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-08 · docs · crwu-dws v0.3.1：新增缓存名一致性清理层（缓存库名 ≠ skill 目标库名 → 先清理缓存、在线重下远程目录结构）

- 影响：`skills/crwu-dws/SKILL.md`（新增 §5.0 缓存名一致性校验与清理层，M1/M3 用缓存前置；frontmatter/§1/§2/§8/§10 同步口径）、`skills/crwu-dws/references/02-缓存与兜底查找规范.md`（v1.1：新增 §2 缓存身份与名一致性清理，原 §2–6 顺移为 §3–7，含正文红线/报告口径指针修正）、`skills/crwu-dws/references/00-目录快照schema.md`（引用指针随 §2→§3、§5→§6 更新 + §6 身份说明）、`docs/design-crwu-dws.md`（v0.3.1：新增 P3-M0 清理层流程、决策 D12、验收 T13、演进项 5）、`skills/README.md`（总表行+独立段落）（源仓与 ~/.skills-manager/skills/crwu-dws 运行时双份同步）
- 说明：按用户口径加缓存清理层——每次 M1/M3 用缓存前先对账：缓存目录身份 = `.cache-meta.space`（name+workspaceId，真实返回）；与本次目标库名（默认「中瑞世联评估审核知识库」或指定库名；M1/刷新路径按 P1 name+workspaceId 双匹配，M3 命中路径保持"不发起在线遍历"、以请求库名做名级对账，workspaceId 一致性已由写缓存时 P1 校验固化于 meta）不一致（改名/换库/历史残留，或 meta 缺失损坏且目录名≠目标）→ **整体删除该缓存目录**（正式 4 文件+残留 .tmp-*；目录缓存=可再生中间产物、无正文，删除不违红线；只动 dws-dir-cache，不碰 M2 案例 knowledge/、CRWU_KB_ROOT、远端）→ 对目标库**在线重跑 P1+P2 全量遍历重新下载目录结构**并原子写缓存 → M3 侧重查；meta 缺失损坏但目录名==目标 → 不删除，按缓存损坏刷新覆盖；删除失败 → 报告路径问题、该缓存按不可用处理不静默复用；清理动作必在摘要/结论报告（"已清理不一致缓存：<目录>（缓存=<库名>，目标=<库名>）"）。副作用登记：临时指定其它库名运行时，与本次目标不一致的既有缓存（含默认库）会被清理，属"缓存可再生"的可接受代价（演进再评估见 design §12 项 5）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-08 · docs · crwu-dws v0.3：新增本地目录缓存层 + M3 缓存兜底查找（目录可缓存、正文不缓存）

- 影响：`skills/crwu-dws/SKILL.md`（三模式 M1/M2/M3）、`skills/crwu-dws/references/00-目录快照schema.md`（v2，落点迁移）、`references/01-镜像与manifest规范.md`（v2，案例镜像≠缓存+exportedAt 时效）、新增 `references/02-缓存与兜底查找规范.md`、`docs/design-crwu-dws.md`（v0.3 定稿）、`skills/README.md`（源仓与 ~/.dsh/skills 双份同步）
- 说明：按用户口径加缓存兜底层——M1 目录产物落点改 `~/.crwu/knowledge/dws-dir-cache/<库名>/`（=~/.crwu/knowledge 下、与 CRWU_KB_ROOT=knowledge-base 子树同级隔离，kb_tool 不扫描；原子替换写入：.tmp-* 全成后 rename，meta 最后覆盖）；产物=目录快照/目录树/node-index/.cache-meta，**只存目录与索引，永不存正文**；M3 兜底查找协议：文件名/nodeId 精确查缓存索引（nodeId→条目、名称→多命中全列消歧）→ 未命中自动在线刷新（P1+P2 全量遍历+原子写缓存）→ 重查 → 仍无如实"未找到：<名>（目录已刷新至 <时间> 后仍不存在）"+ 相近候选≤5，不编造；刷新失败降级：旧缓存可用 → 标注"缓存可能过期（fetched_at）+失败原因"作答，否则"无法确认"；正文实时红线：每次取正文 = 现场 `dws doc +export` 临时取用即弃，唯一例外 = M2 案例镜像（用户明确留档，案例期快照、manifest 带 exportedAt、不进缓存层）；正文读取次序登记（供 audit 侧）：M3 现场实时 → M2 本案镜像 → 缓存（无正文）→ CRWU_KB_ROOT（门禁基准）；旧落点 ~/.crwu/kb-catalog 弃用不写、不迁移不删除
- 未新增/修改 crwu CLI 命令

---

## 2026-09-08 · docs · crwu-dws：新增钉钉知识库只读域技能（M1 目录查询 + M2 知识文档批量下载到案例 knowledge/）

- 影响：新增 `skills/crwu-dws/SKILL.md`、`skills/crwu-dws/references/00-目录快照schema.md`、`skills/crwu-dws/references/01-镜像与manifest规范.md`、`docs/design-crwu-dws.md`（v0.2 定稿）、`skills/README.md` 总表行+独立段落（源仓与 ~/.dsh/skills 双份同步）
- 说明：围绕钉钉「中瑞世联评估审核知识库」的只读域技能（crwu-audit 推理参考文档实时化路线图读端第一步）——M1：组织/个人全范围精确库名解析（多命中全导、spaceType 只取真实返回）、DFS 递归完整层级导出（目录树.md + 目录快照.json，分页证据/防环/体量上限 10,000×20 层）；M2：把 crwu-audit 及子 skill 推理参考知识文档按库结构批量导出（adoc→md，`dws doc +export`，回执 localPath+sizeBytes>0 即终态）到与源审核数据文件同级的案例目录 `knowledge/`（目录由显式给定/部署约定 CRWU_CASE_DIR/询问三源决议，禁止猜）；`.crwu-manifest.jsonl` 幂等镜像（同 nodeId 原位覆盖=更新、不同 nodeId 同名加后缀、非 adoc 跳过如实报告、远端已删本地保留待人工清理）；**对钉钉零写**（wiki/doc 只读白名单）。口径登记：案例 knowledge/ = 推理实时参考，CRWU_KB_ROOT = 发布/门禁基准，两套口径读取优先级由 crwu-audit 族维护（另行登记）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-07 · docs · crwu-audit：references/00 §6.1 脏数据剔除改「重建法」+ 坐标系规则（BG8583 实操反哺）

- 影响：`skills/crwu-audit/references/00-route-profile-schema.md` §6.1、`skills/crwu-audit-datacheck/SKILL.md`、`skills/crwu-audit-datacheck/references/00-KB装配表.md`（源仓与 ~/.dsh/skills 双份同步）
- 说明：openpyxl delete_rows/delete_cols 不重映射/不清除 row_dimensions/column_dimensions → 删除法剔除隐藏内容会残留（BG8583 首版 VERIFY_FAIL 残留 40 处）；固化「重建法」（只复制可见 sheet×可见行×可见列，重开文件核残留=0）并禁止删除法；重建后工作版行列坐标整体收缩而公式串保留 raw 坐标 → 公式/引用/合计范围类勾稽一律回 raw 原件坐标、只取可见单元格判断，数据隔离增加「raw 只读可见区」唯一例外（datacheck C1/C3）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-07 · docs · crwu-audit-realestate-rent：清单逐条裁定表 + 校准点反查硬约束（执行 OPT-2026-09-07-01）

- 影响：`skills/crwu-audit-realestate-rent/SKILL.md`、`skills/crwu-audit/references/99-维护说明.md`、`skills/crwu-audit-optimize/references/00-优化规范与文件落点.md`、KB `06-规则库/清单-M-市场法/不动产-房产-市场法租金比较-报告审核.md`（技能三处同步：源仓 / .skills-manager（=`~/.dsh` 软链目标）/ .workbuddy 实际生效）
- 说明：BG8583 复盘——初版命中 CHK-MKT-001~014 仅 12 条被引用、无一显式裁定 → 漏 DC-013/EXP-008 两条高严重度缺陷。固化：命中清单**逐条裁定表（强制产物）**，未命中缺陷条目也必须留"符合+证据"痕；执行纪律改"命中才出意见、每条必出裁定"；校准点（B4/B8/B9/B11…）反查对应 CHK 为硬约束；技能同步目标更正为三处（~/.dsh 是软链、~/.workbuddy 实际生效）；KB CHK-008/013 补典型缺陷（BG8583 实案）。§6.1 重建法/坐标基准项已于同日先行落地（另条登记）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-07 · docs · crwu-audit：route_profile 增 scenario 装配键（评估目的×方法双键装配，执行 OPT-2026-09-07-02 第 1-3 项）

- 影响：`skills/crwu-audit/references/00-route-profile-schema.md`（v0.3，§3 增 scenario 必填装配键＋装配纪律）、`skills/crwu-audit/references/01-audit-angles-catalog.md`（v0.2，词表增「KB scenario 装配键」列）、`skills/crwu-audit-realestate-rent/SKILL.md`（双键装配句＋profile 必填键＋场景排除回查纪律）——源仓与运行时同步
- 说明：装配此前退化为方法键（kb_tool dims_hit 缺键=不过滤、场景筛选静默失效），目的相关检查装载不可见。本次固化：画像必须产出 scenario（受控取值只填已覆盖行=经营性物业出租，其余待能力落地补，禁止造值）；叶子缺键先补画像；scenario 排除须回路由层核画像。第 4 项（kb_tool assemble 缺键提示）**用户驳回，不做**
- 未新增/修改 crwu CLI 命令

---

## 2026-09-07 · docs · 族级下沉：逐条裁定表/校准反查等规则正文进 KB 执行契约 02 §6（全叶子适用）

- 影响：KB `00-总纲/执行契约/02-输出Schema与审核意见单.md`（v0.3 新增 §6：逐条裁定表/清单外必查/校准点反查/装载留痕/引用纪律——族级强制产物）；`skills/crwu-audit-realestate-rent/SKILL.md` 内联节收敛为 KB 指针（145 行，不复制正文）
- 说明：OPT-01/02 曾把族级执行规则写进 rent 单个叶子（违反"公共逻辑一份/正文在 KB"红线，其他叶子不继承）。按用户指令把正文落 KB 执行契约 §6 统一约束：一切按 CHK/清单执行并出意见的叶子（现役 realestate/rent，未来新建）输出前必做逐条裁定+清单外必查+校准点反查+装载留痕；rent 只留指针。datacheck 差异清单型豁免规则裁定但沿用坐标基准/H0
- 未新增/修改 crwu CLI 命令

---

## 2026-09-04 · docs · crwu-audit-datacheck：跨方向表格勾稽能力 + 叶子必做步骤

- 影响：skills 新增 `crwu-audit-datacheck`（L2 能力型：C1–C6 数据/表格勾稽、差异清单输出、
  xlsx/.xls 解析与公式重算工具链说明）；`crwu-audit-realestate-rent`/`crwu-audit-realestate`
  增加"表格勾稽必做（先于意见输出）"步骤；总路由注册表与设计文档 v0.2 登记该能力
- 说明：Excel 明细/测算/汇总表属 M-数据校对职责（校准 G7），此前试点只审报告+说明属执行缺口；
  现固化为必做：差异清单回传规则技能作判定（如汇总数与报告结论不符→反证数字污染），
  解析失败必须明示"该表未核"；差异计入台账 data_diff_count（crwu-knowledge audit-skill/08）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-04 · docs · 审核统计规范接入 crwu-audit 路由

- 影响：`skills/crwu-audit/SKILL.md` 汇总输出新增第 8 步"统计回填"
- 说明：单份审核完成后按 crwu-knowledge `audit-skill/08-审核统计与台账规范.md` 产出统计字段
  （A–G）并落入台账（模板 `knowledge-base/05-模板库/审核统计台账-模板.md`），用于周/月/批汇总
  与知识库反哺（易错点候选/缺口反馈）；取值口径复用 crwu-knowledge 标签词典
- 未新增/修改 crwu CLI 命令

---

## 2026-09-04 · docs · crwu-audit 分层路由：总路由 + 房地产大方向（设计 v0.2）

- 影响：skills 新增 `crwu-audit`（L0 总路由：全量路由注册表 + 分层分发/降级/汇总/门禁透传）、
  `crwu-audit-realestate`（L1 房地产大方向通用审核）；`crwu-audit-realestate-rent` 明确为 L2 细分；
  `docs/design-crwu-audit-skills.md` 升级 v0.2（三层可插拔模型：L1 大方向 runnable → L2 细分
  pluggable，细分未命中降级父大方向，最上层统一维护所有能力 skill 路由）
- 说明：三层语义按用户口径——先判大方向→再尝试细分；细分未命中按上一层（大方向）审核逻辑开展；
  大方向下可继续插"具体法律/专项内容"审核能力；总路由只分发不判断
- 未新增/修改 crwu CLI 命令；后续：案例 B 试点走查验证三层路由

---

## 2026-09-04 · docs · crwu-audit 审核技能族：分类设计与首片叶子

- 影响：skills 目录新增 `crwu-audit-realestate-rent`（提示型 Skill）；`skills/README.md` 注册；
  新增 `docs/design-crwu-audit-skills.md`（划分判据/分类树/总路由 crwu-audit 契约/优先级）
- 说明：crwu-audit 族按审核能力逻辑划分（report_type → object_type → method/scenario →
  就绪度）；首片叶子=商铺租金/经营性物业市值类评估报告（市场法租金比较/成本法/收益法租约），
  只读引用 crwu-knowledge 规则（RULE-01-02-281~305、543~578）与清单（CHK-MKT/CST）；
  依赖 crwu-knowledge A 发布门禁：未发布仅试点（意见标注"依据待发布"）
- 未新增/修改 crwu CLI 命令；总路由 `crwu-audit` 与其余叶子待后续实现

---

## 2026-09-04 · feat · records list 支持 --filter 字段条件筛选

- 影响命令：`crwu h3yun records list`（新增 flag `--filter <条件>`）
- 说明：SQL 风格筛选表达式（`=`/`!=`/`<>`/`<`/`>`/`<=`/`>=`/Contains/Like/
  StartWith/EndWith/In/NotIn/Between/IsNull/IsNotNull/IsNone/NotNone，支持
  `and`/`or` 与括号，大小写不敏感），字段自动补 `<schemaCode>.` 前缀；
  `--filter` 与 `--keyword` 可叠加
- 语法与操作符表见 `docs/cli-manual.md` §4"记录"；氚云无 SQL `Like`，`Like`
  已映射为 `Contains`
- 相关：新增 `internal/integrations/h3yun/filter.go`（表达式→matcher 树，含
  单元测试）；`internal/app/h3yunweb`（Records 透传 Filter）、
  `internal/transport/cli`（flag + scheme 示例）；同步 skill `h3yun-query`

---

## 2026-09-04 · docs · 扫码登录的沙箱运行注意与前置说明

- 影响：`crwu h3yun session login` 的运行环境注意事项
- 在 AI 宿主沙箱环境中，login 拉起的 GUI 浏览器会被沙箱拦截而弹不出窗口
  （报 `websocket close 1006`），应**脱离沙箱 + 前台**运行，并用 `CRWU_BROWSER`
  显式指定 Chromium 系浏览器路径
- 同步 `docs/cli-manual.md`（§3 增加环境提示）与 `skills/h3yun-login/SKILL.md`
  （增加"确保 crwu 可用"前置——`crwu` 缺失时应询问用户而非擅自构建/改环境；
  `CRWU_BROWSER` 显式示例；沙箱拦截排障条目）

---

## 2026-09-03 · feat · 员工自助扫码登录（session login）

- 新增命令：`h3yun session login`
- 影响：自动拉起本机 Chrome/Edge 打开 h3yun.com，员工用钉钉扫码后由 crwu 经
  CDP 直接读取会话并写入本机 keyring；令牌全程进程内处理，不打印/不进对话
- 相关：`internal/platform/scanlogin`（浏览器捕获）、`internal/app/h3yunweb`、
  新增 skill `h3yun-login`
- 环境变量：`CRWU_BROWSER`（指定浏览器可执行文件）
- 默认浏览器支持：优先使用系统默认浏览器（需为 Chrome/Edge/Brave/Chromium 等
  Chromium 系；Safari/Firefox 不支持 CDP 时回退到已装 Chromium），macOS 读
  LaunchServices、Windows 读 UserChoice、Linux 读 xdg-settings
- 读取加固：cookie（www 域与根域双拉）+ 页面 JS localStorage/document.cookie
  兜底；抓取值先解码校验 enginecode/userid/exp（未来时间）后才写入，无效不存储

---

## 2026-09-03 · feat · 首个交互式查询 Skill（h3yun-query）

- 新增：`skills/h3yun-query/SKILL.md`
- 影响命令：复用 `h3yun apps list / apps children / forms search /
  records list / records get / files list / file download`（只读）
- 说明：按"系统 → 表单 → 记录"逐层交互查询，每页 20 条、可翻页、支持标题
  关键词查找；不发散写操作

---

## 2026-09-03 · feat · version 输出构建信息

- 影响命令：`crwu version`
- 影响：输出含 版本号、commit 缩写、构建时间（UTC）、目标平台（macOS/Windows/
  Linux + 架构），由 Makefile 注入 BuildDate；GOOS/GOARCH 为编译期值

---

## 2026-09-03 · feat · 会话惰性自动续期（中间件）

- 影响命令：apps/forms/records/files 等依赖网页会话的读命令
- 说明：h3yun 组 PersistentPreRunE 中间件在执行前检查会话剩余时间 ≤24h 则自动
  refresh 一次；已过期则提示重新 `crwu h3yun session login`。session 管理命令与
  agent 通道（ping/tools/apps search/records query）跳过
- 相关：`internal/transport/cli/middleware.go`（CLI 中间件）、
  `internal/app/h3yunweb/renewal.go`（EnsureFresh）

---

## 2026-09-03 · refactor · 用 cobra 重写 CLI（docker/k8s 规范）

- 影响命令：全部（结构不变，命令路径/flag 保持一致）
- 说明：命令改为嵌套树，help 分层折叠（`crwu help h3yun session`）；flag 由
  cobra/pflag 管理并校验必填参数；`crwu scheme` 目录改为由 cobra 命令树实时
  生成，与 help 描述同源；退出码统一：成功 0、任何错误 1

---

## 2026-09-03 · feat · H3Yun 员工级网页会话通道上线

- 新增命令：`h3yun session bind/status/refresh/clear`、`h3yun apps list`、
  `h3yun apps children`、`h3yun forms search`、`h3yun records list`、
  `h3yun records get`、`h3yun files list`、`h3yun file download`
- 影响：以员工本人网页会话（钉钉扫码，无密码）读取应用/表单/记录/附件；
  会话存本机 OS 凭据存储（`internal/platform/h3yuncreds`），48h 可续期
- 相关：新增 `internal/integrations/h3yun`（网页 REST 客户端）、
  `internal/app/h3yunweb`

## 2026-09-03 · feat · H3Yun Agent 网关（MCP）客户端

- 新增命令：`h3yun ping`、`h3yun tools`、`h3yun apps search`、
  `h3yun records query`（只读 SQL）
- 影响：以个人访问凭证 `h3pat_*` 对接 `www.h3yun.com/v1/agent/mcp`
- 说明：氚云数据面未对企业开通时，`tools/call` 返回 `h3yun.read.upstream_error`
  （平台侧问题，非客户端故障）；开通后该通道方可用
- 相关：`internal/integrations/h3yun`（MCP 客户端）、`internal/app/h3yunops`

## 2026-09-03 · refactor · 移除 crwu-server 模块与 `h3yun login`

- 影响命令：删除 `h3yun login`（钉钉 OAuth 服务器登录）
- 说明：员工凭证改为**本机绑定**模型，无服务端可运维；移除
  `cmd/crwu-server`、`internal/app/h3yunlogin`、`internal/auth`、
  `internal/config`、`internal/integrations/{dingtalk,crwuserver}`、
  `internal/transport/httpapi`、`internal/platform/browser`
- 破坏性：若曾有调用方依赖 CRWU 会话服务器或 `h3yun login`，需迁移到
  `h3yun session bind`

## 2026-09-03 · docs · 项目文档重构

- 新增：`docs/design-h3yun-auth.md`（鉴权决策）、
  `docs/design-h3yun-cli.md`（CLI 决策）、`docs/design-h3yun-connector.md`
  （连接器决策）、`docs/cli-manual.md`（本说明书）
- 更新：`AGENTS.md`、`CONTEXT.md`、README（en/zh）按"无服务端员工会话"模型重构

---

> 预置条目回溯了项目当前功能状态；此后所有变更按上方格式**向下追加**，请勿改写历史。

## 2026-09-04 · fix · crwu-audit-datacheck：H0 由"默认忽略"升级为"强制跳过（禁读禁报）"

- 影响：`skills/crwu-audit-datacheck/SKILL.md`（description + 主流程第 0 步 + C3 扫描范围 +
  边界纪律 + 校准实例口径）；同步 `skills/README.md` 与 `docs/design-crwu-audit-skills.md` §4 注册表行
- 说明：业务口径 = 人工检查员本就会跳过隐藏的 sheet/行/列（含折叠分组），这些区域**无需关注**；
  此前 H0 只是"默认忽略（不产生误报）"，仍允许/暗示对隐藏区做 C3 公式错误等扫描，agent 审核会比
  人工更严且产生噪音。现固化为铁律：隐藏区**整体跳过**——不得读取、解析、核对、引用或输出其中任何
  单元格值；不得对其产生 C1–C6 差异/意见（含 #REF!/#DIV/0!、串扰词、占位）；合计勾稽只看可见区
  （SUM 覆盖隐藏区时注明"仅核可见部分"）；输出忽略清单仅含元数据（数量/名单/段位）。无法判定隐藏
  状态 → 该区按跳过处理并列入"隐藏状态未知 · 已跳过"，禁止回头取值
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · crwu-audit 画像层升级：references 运行材料 + 维护说明
- 影响：`skills/crwu-audit/SKILL.md`（重构为 ≤300 行入口；输入双源=材料包/氚云报告审核记录；分发算法升级：报告形态→受控角度词表→对象→方法(附件名+抽验)→监管覆盖层；注册表状态 P0/P1/P2）；新增 `skills/crwu-audit/references/{00-route-profile-schema,01-audit-angles-catalog,02-overlay-rules,99-维护说明}.md`；同步 `~/.dsh/skills/crwu-audit` 拷贝；README 与 `docs/design-crwu-audit-skills.md`（v0.2→v0.3）
- 说明：分发运行材料从 docs/ 收敛到技能自身 references/（Agent 加载友好，SKILL.md 不超行数上限）；监管覆盖层仅保留 国资(F0000082)/证券(F0000127∪0188…)/司法(F0000126)/金融(F0000124)；ABC/级次/状态不参与路由；数据基线=报告审核 8,486 条（2026-09-07）
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · refactor · crwu-audit 总路由入口与知识库解耦（叶子技能保留执行期知识库引用）
- 影响：`skills/crwu-audit/SKILL.md`、`skills/crwu-audit/references/00`、`skills/crwu-audit/references/99`、`skills/README.md`（同步 `~/.dsh/skills` 拷贝）
- 说明：**入口/路由层**（crwu-audit）不再“先读 KB/00-治理与规范…门禁”、不引用 crwu-knowledge 绝对路径（分发材料自含于 references/）；
  **叶子技能保持原状**——执行期按规则编号只读引用 crwu-knowledge 规则正文（收益法等细则不塞进技能、不复制正文），避免两个仓库过度耦合
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · 叶子技能统一加“仅经 crwu-audit 编排调用”前置门禁
- 影响：`skills/crwu-audit-realestate/SKILL.md`、`skills/crwu-audit-realestate-rent/SKILL.md`、
  `skills/crwu-audit-datacheck/SKILL.md`（新增“⚠️ 调用前置条件”+ frontmatter 描述约束）；
  `skills/crwu-audit/SKILL.md`（纪律：唯一编排入口）；`references/99-维护说明.md`（红线：新叶子必须自带门禁）；
  `docs/design-crwu-audit-skills.md`（§1 编排纪律）；同步 `~/.dsh/skills`（realestate/datacheck/router）
- 说明：防止 Agent 绕过总路由直接调单个子技能导致报告不完整、口径漂移；datacheck 保留“用户明确只要数据核对差异清单”的独立执行例外（仅输出差异清单、不下判断）
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · crwu-audit 路由首判：机构 A/B/C 业务风险分类(references/03)
- 影响：新增 `skills/crwu-audit/references/03-业务风险分类判定.md`；`SKILL.md`（§0 列表/§2 分发第 2 步首判/§5 纪律区分两类 ABC）；
  `references/00`（route_profile.business_risk_class）；`references/02`（原则口径）；`references/99`（分层地图）；README/design
- 说明：A/B/C 分类=审核严谨度参考与首页标注（制度 A1–A15/B1–B13/C1–C7 条款→谓词映射；A 先查取最高档、hits 列全；
  金额<500万条款缺金额挂起；A13/A14/A15 与涉密为人工项）；**不裁剪审核角度**——agent 一律全面审核，最终通过由人工复核；
  氚云风险等级字段 F0000020/级次/状态仅作对照不参与判定
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · fix · crwu-audit：文件级抽验明确“下载→转换→定位”真实读取链路 + 反拟造红线
- 影响：`skills/crwu-audit/SKILL.md`（step5 三步前置+红线、§5 纪律抽验红线）；`references/00`（新增 §6.1；§7 兜底模板未读文件须显式“未抽验（文件未读取）”）；同步 `~/.dsh/skills`
- 说明：评估目的/方法/结论方法及 loc 只能来自真实下载并读取的文件（旧版 .doc OLE→本机 textutil 转换→grep 行号定位）；
  严禁凭氚云字段、附件文件名、行业经验拟造原文或编造行号；未读文件必须显式标注“未抽验（文件未读取）”，禁止装作已审
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · feat · crwu-audit：路由下载阶段硬删除 Excel 用户手动隐藏数据（脏数据）
- 影响：`references/00` §6.1（新增第 2 步“Excel 脏数据硬删除”，转换/定位顺延）；`crwu-audit-datacheck/SKILL.md`（顶部说明：上游已删隐藏脏数据）；V2.2 步骤1；同步 `~/.dsh/skills`
- 说明：用户手动隐藏的 sheet/行/列/折叠分组=脏数据，路由数据准备阶段须在工作副本中整体删除，raw 原件保留；
  识别隐藏结构属元数据可读，隐藏单元格值禁读禁报（与 H0 一致）；处理后工作版仅含可见数据，勾稽只按可见区核
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · fix · crwu-audit：隐藏脏数据删除后 raw 原件与子技能数据隔离
- 影响：`references/00` §6.1（item2 增校验=0/阻断、新增“数据隔离红线”）；`SKILL.md` §5 纪律；V2.2 步骤1；同步 `~/.dsh/skills`
- 说明：含隐藏脏数据的 raw 原件**只归编排层持有，任何子技能/模块一律不得读取**；叶子/下游只能用已删隐藏数据的工作版
  （传工作版路径）；校验工作版隐藏区=0，失败即阻断；发现子技能直读 raw/原件 → 记违规
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · refactor · 技能族 KB 引用统一（CRWU_KB_ROOT）+ 只读索引/校验/装配工具 tools/kb
- 影响：`skills/README.md`（KB 根常量定义）；`crwu-audit/SKILL.md`（契约引用切 KB/00-总纲/执行契约 02-04 文件名）；
  `crwu-audit-realestate`、`crwu-audit-realestate-rent`、`crwu-audit-datacheck` 的 SKILL.md 与 references/00-KB装配表.md
  （去个人绝对路径/旧树目录名/省略号引用，装配表改稳定指针表）；知识库治理与批次文档（KB 根 README、目录地图、入库规范、
  调度总纲、待发布清单、进度总表、索引卡、台账模板等）旧目录名清理；KB 本体个人路径去标识
- 说明：KB 根常量 CRWU_KB_ROOT=`~/.crwu/knowledge/knowledge-base`（`~/.crwu/knowledge` 仅为父目录，不作引用根）；
  skills/README 不随技能安装——每个运行时文件自带根常量字面定义；rent/realestate 删除与 datacheck 重复的 C1–C6/工具链正文（指针化）
- 新增 `tools/kb/kb_tool.py`（stdlib only；index/validate/resolve/query/release/assemble/extract/selftest；CRWU_KB_ROOT 可覆盖）+ README + examples；
  索引产物 `KB/00-总纲/治理/kb-index.jsonl`（首行 _meta，勿手改）；validate：索引新鲜度/定义锚点编号唯一/发布字段/词表(warn)/引用路径存在性+旧树标记+省略号
- 校验基线：repo skills 与 KB 本体 validate warn=0 error=0；租金·市场法示例装配=96 命中（全 pending→试点门禁）/81 排除（含原因）/其余按归因汇总，两跑 diff 为空（可复现）
- 未新增/修改 crwu CLI 命令；KB 版本管理机制（git/manifest/发布批次改造）不在本次范围，随钉钉知识库打通另期设计

## 2026-09-07 · feat · crwu-audit-optimize：族维护/优化入口（先方案后执行）
- 影响：新增 `skills/crwu-audit-optimize/`（SKILL.md + references/00-优化规范与文件落点、01-反馈定位与画像流程、02-方案模板与确认门禁）；
  登记：skills/README 表+族段落、crwu-audit references/99-维护说明（§1 新行 + §2 步骤 0 前置）、design §7/§8、CHANGELOG；同步 ~/.dsh/skills
- 说明：元技能，不经 crwu-audit 路由、不产审核判断。用户反馈（规则/检查点问题、"缺 XX 文档对 XX 文档/某业务·对象审核"）→
  按 references/01 定位单子画像（对象 02/业务路线 01/方法 03/监管 04）与缺口分桶 A–E → 输出《优化方案》
  （拟改文件清单源仓+运行时双份、联动登记、kb_tool 校验回归步骤）→ **用户确认后才动文件** → 执行后按 references/00 §4 验收基线收口
- 校验基线：repo skills validate error=0；新 SKILL.md 行数 <300
- 未新增/修改 crwu CLI 命令；不处理：发布状态翻转、KB 版本管理、钉钉迁移、技能安装机制

## 2026-09-07 · docs · crwu-audit-optimize：KB 变更同步义务三件套（索引/装配表/目录地图）
- 影响：`skills/crwu-audit-optimize/SKILL.md`（铁律 3、§4 步骤 1/4）、references/00（新增 §2.1 同步义务判定表）、references/02（方案模板/核对清单补项）；
  `crwu-audit-datacheck/references/00-KB装配表.md`（同步义务行）；同步 ~/.dsh/skills
- 说明：凡 KB 内容/结构变更 → `kb_tool.py index` 同批重跑（必做）；新增/改名/移动文件或装配范围变化 →
  另同步叶子 00-KB装配表.md 与 KB 00-总纲/目录地图.md；发布状态翻转（质控人工）后亦须重跑 index 才更新 release 列
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · feat · crwu-audit：兜底自动产出《待建子技能提案》（references/04）
- 影响：新增 `skills/crwu-audit/references/04-待建子技能提案.md`；`crwu-audit/SKILL.md`（frontmatter 描述、
  §0 目录、步骤 7 兜底后自动产提案卡、步骤 10 汇总附路由路径/调用链）；`references/99-维护说明.md`（§1 新行）；
  `skills/README.md`（总路由行）；`crwu-audit-optimize`（SKILL B 桶 + references/01 §4.1：提案卡=优化输入起点）；同步 ~/.dsh/skills
- 说明：按"评估目的×评估方法×评估对象"路由后无可用子技能（🅿️/⏳/未登记组合）时，自动五查
  （注册表/词表/库内依据/对象与业务路线目录/数据体量）推导《待建子技能提案》卡：候选技能名、定位职责、
  需要审核什么（分区+可复用 CHK/RULE+待建清单起点）、内容缺口（待补精编）、前置登记、优先级——
  附 kb_tool 证据（可复现），非审核结论；画像歧义不产提案；落地正式化走 crwu-audit-optimize（先方案后执行）
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · feat · 输出契约：审核意见单新增《复核意见对照与溯源》块（契约 02 §5）
- 影响：KB `00-总纲/执行契约/02-输出Schema与审核意见单.md`（v0.2，新增 §5：输入与适用/对照分类 A·已在复核意见提出→必须给出 出处文件+条目/页码+原文摘录、B·复核未提出（AI 新增发现）→单列建议人工复核、C·未对照/输出 json+md 格式/红线）；`crwu-audit/SKILL.md` 步骤 10（汇总时材料含人工复核意见则附对照表）；同步 ~/.dsh/skills
- 说明：对照只回答"是否已提出、在哪提出"，不评判人工意见质量；复核意见中存在而本次未命中的事项只在附注提示；
  出处只能来自真实读取的复核意见文件，材料缺失/不可读→整表"未对照"，禁止编造出处，也禁止以"未提出"替代
- 未新增/修改 crwu CLI 命令
