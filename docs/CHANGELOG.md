# 变更纪要（CLI Changelog）

> 维护纪律（见 `AGENTS.md`）：**每次 CLI 功能新增 / 变更 / 删除**（命令、参数、
> 环境变量、输出契约、通道行为），必须在本文档**追加**一条纪要，并同步更新
> [`docs/cli-manual.md`](cli-manual.md)（Agent 使用说明书）。
>
> 条目格式：`日期 · 类型 · 标题`，类型沿用 Angular 词表（feat / fix / refactor /
> docs / chore），正文写明**影响命令**与关键说明。

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
