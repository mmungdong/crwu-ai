# crwu-dev-audit-skill-maintainer/scripts —— 审核技能引用与实时协议校验

> 定位：审核技能族的**只读**静态校验工具（引用卫生 + 实时引用协议 lint）。
> 本工具归口本技能，**随技能安装**（本目录即技能内 `scripts/`），被 `crwu-dev-audit-optimize`、
> `crwu-audit-datacheck` 等按「`crwu-dev-audit-skill-maintainer` 技能的 `scripts/kb_tool.py`」引用。

## 为什么存在

知识正文的唯一来源是**钉钉知识库**，由 `crwu-dws` 按本次审核清单实时下载
（正文零缓存；目录可缓存）。本仓因此**不再维护本地知识库根**：
技能内禁止写本地知识库根常量与本地根路径字面，
只写 RULE/CHK 编号与**库内层级路径**寻址键，正文一律运行时获取。

这带来两条必须机器校验的纪律：

1. **不许退回本地知识库**：技能内不得再出现本地根常量、本地根路径字面、
   省略号式引用，或以 `KB/` 开头的本地根相对引用（写法已废止）；
2. **不许写死运行时值**：`nodeId` 一律由 `crwu-dws` 运行时解析，技能内不得硬编码赋值。

## 运行

```text
# 源仓技能：引用卫生 + 实时协议 lint（禁止本地知识库根常量与根路径字面、禁止硬编码 nodeId，crwu-audit* 目录从严）
python3 scripts/kb_tool.py validate --skill-root <skills 安装根>

# 追加禁止知识库名称字面（作用于该 root；crwu-dws 自带默认库名，勿对其目录加库名）
python3 scripts/kb_tool.py validate --skill-root <skills 安装根> --forbid-literal 中瑞世联
```

## 子命令

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `validate` | ①引用卫生（旧树残留标记、省略号式引用、已废止的本地根相对引用与本地根常量、已废止的本地根字面路径是否存在）②**实时协议 lint**（crwu-audit* 目录内：禁止写本地知识库根常量赋值与本地根路径字面、禁止硬编码 nodeId；`--forbid-literal` 追加禁止知识库名称等字面） | 0 全过；1 有 error |

已删除的子命令（v0.2，2026-09-10）：`index` / `resolve` / `query` / `release` /
`assemble` / `extract` / `selftest`。它们全部建立在本地知识库 md 树上，
而该树已迁至钉钉、本地根不再存在，命令实际不可运行。

## 装配清单从哪来（不再由本工具生成）

下载清单 = 命中**资产/业务子技能**的 `references/01-kb-assembly.md`
（一个一级目录根，或明确的单文件路径）＋ 执行契约路径并集，
由 `crwu-dws` M2 实时下载到 `<案例目录>/knowledge/`：

- 清单同时支持**单文件路径**与**目录路径**（目录项递归下载其中全部支持正文）；
- **清单外零下载**；正文永不写入目录缓存；
- 资产/业务子技能只登记一级目录根（`request_kind=directory`、`recursive=true`），
  细分对象与子业务在已下载目录包内二次选用，不各建技能。

**2026-09-16 起，下载清单的第三个来源是 router 的分发规则**：方法轴技能（7 个）与覆盖层技能（4 个）
均为 `pending`，其知识库目录由 router 按本次 `methods[]` / `overlays[]` 的命中项或映射表显式跨轴条件追加；财务报告补充规则按
`business_types[]=财务报告` 追加
（映射唯一事实源：`crwu-audit` 技能的 `references/08-union-dispatch-rules.md`
§「方法层、覆盖层与财务报告补充规则的库内装配映射」）。**`pending` 表示能力未落地，不表示内容可以不装**；
因此该分发规则文件在本工具的装配缺口检查中**被承认为合法装配来源**。

映射一致性（registry ↔ classification ↔ 真实技能目录 ↔ 最新知识库目录）
由本技能 `scripts/check_audit_skill_mappings.py` 校验：

```text
# 只读盘点（json 供机器消费；--strict 有 error 时退出 1）
python3 scripts/check_audit_skill_mappings.py --repo-root <源仓> --catalog <本次目录> --format json --strict

# 刷新人工校准表（追加一条历史行；人工备注块逐字保留）
python3 scripts/check_audit_skill_mappings.py --repo-root <源仓> --catalog <本次目录> \
  --emit-map references/07-kb-skill-map.md
```

## 校验口径要点

- 实时协议 lint 只对 `crwu-audit*` 族目录做"三不写"严格检查；`crwu-dws` 等
  允许按需引用部署常量与默认库名；
- `CRWU_KB_ROOT` 与 `KB/<rel>` 现在是**全 root error**（不再限于 crwu-audit*），
  因为本地根模型已整体废止；
- 旧树残留标记与 `KB/…` 省略号为 warn（消费方需人工判断）；
- 纪律文本（含"禁止/不写…字面"的说明行）与"禁止出现旧名"的列举行自动豁免；
- **方法层/清单类/覆盖层装配缺口**（`ASSEMBLY_GAP_METHOD_LAYER`）监视前缀共 **17 项**：
  `03-评估方法/` 六个方法子目录、06-规则库 下 清单-M-市场法 / 成本法 / 收益法 / 资产基础法 四份清单、
  `06-规则库/易错点库/`、`04-监管覆盖/` 五个覆盖层目录、`06-规则库/M-计算表审核/`。2026-09-16 由 9 项扩为 16 项、
  2026-09-26（F-006）扩为 17 项——漏列会让新清单与覆盖层规则**无人装配却不报错**，
  与当年 `CHK-MKT-001~014` 缺装同一失效模式；
- **正式 Python 运行时口径**（2026-09-26 · OPT-005-R1 更正）：技能脚本的**正式验收**必须用
  **DSH/工作区注入的绝对 Python 路径**（`load_workspace_dependencies` 返回的 `python` 字段），
  报告里要给出 `sys.executable` / `sys.version` / `openpyxl.__version__`；预期主版本 **3.12**。
  **不得**用裸 `python3` 或 `/usr/bin/python3` 代表正式验收、不得静默回退系统解释器、不得 pip 安装。
  系统 3.9 只能写成**附加兼容回归**，不是默认运行时、也不是正式验收依据。
- **格式级依赖边界与三态登记**（2026-09-26 · OPT-005-R2）：顶层依赖**固定到格式**
  （`FORMAT_DEPENDENCIES = {".xlsx": "openpyxl", ".pdf": "pypdf", ".xls": "xlrd"}`；`.docx` 不入表，
  保留 `docx`→`textutil` 既有回退），**不再**在文件级 `except ImportError` 里按 `e.name` 推导依赖。
  三个格式分支各自调用 `_call_with_dependency(rec, rel, dependency, ext, func, ...)`；依赖不可用时
  它按顶层依赖记账并返回 `(False, None)`，调用方 `raise DependencyUnavailable()` 终止本分支
  （外层只留一个 `except DependencyUnavailable: pass` + 一个 `except Exception`，**没有**第二个
  相邻的同类兜底）。
  依赖状态分**三态**（`dependency_state()`）：`missing`（`find_spec` 返回 None）、
  `import_failed`（spec 在、import 失败）、`probe_failed`（`find_spec` 自身抛异常）。三态都写
  `readable=false` / `notChecked=true` / `workVersionCreated=false`，都进 `dependencyGaps` 与
  `capabilityGaps`，都不生成工作版、不归为材料缺失、不影响其他文件继续盘点。**只有 `missing`
  可以写"缺少第三方运行时依赖"**；`import_failed` 写"存在但导入失败/不可用"，`probe_failed` 写
  "状态探测失败"，后两者**不得**伪装成缺包。`dependencyGaps` 字段保持兼容并新增
  `state` / `causeModule` / `detail`：`dependency` **始终**是该格式的顶层依赖，传递依赖（如 pypdf
  内部缺的子模块）只进 `causeModule`/`detail`。`recalc_check.py` 同样三态，都 exit=3、不产出差异文件。
- **依赖异常精确归因**（2026-09-26 · OPT-005-R1）：`prepare_materials.py` 的 `except ImportError`
  不再用 `getattr(e, "name", None) or "openpyxl"` 这种**硬编码回退**——它会把 `.pdf` 的导入失败
  说成"缺少 openpyxl"，并把**包在但已损坏**的导入失败伪装成 capability gap（等于把真实缺陷吞成
  "环境问题"）。现在由 `dependency_for_import_failure(exc, ext)` 判定：只有**确实不可用**的依赖
  （`e.name` 指向的模块不可用，或该格式声明的依赖确实不可用）才记结构化缺口；否则按**真实错误**
  留痕（`note` 以 `ImportError（依赖并非缺失…）` 开头，**不**产生 `dependencyGaps`）。
  `_dependency_absent()` 还兜住"`find_spec` 自己抛异常"（包目录在、导入链已坏）——否则整个盘点会崩。
  `recalc_check.py` 同样区分"缺少"与"包存在但导入失败"，两种都 fail closed（exit=3、不产出差异文件）。
  测试用**阻断型 meta_path finder**（`import` 与 `find_spec` 都报缺，忠实模拟缺包）与**影子模块**
  （可被 `find_spec` 找到、但 import 抛错，模拟损坏安装），都在子进程内做，不动本机包。

- **H0 单一权威**（2026-09-26 · OPT-005）：隐藏区规范的**唯一权威**是叶子共同约束
  `12-leaf-common-contract.md` §7.1（H0 禁读禁报 / H1 书面授权 / 三档定级与去向 / 可否摘录）。
  `00-input-and-route-profile.md` 只是**隔离机制 owner**（结构识别、raw XML 元数据、工作版重建、
  raw 坐标映射、媒体锚点隔离、`prepare_materials.py` 输入输出），**不得**再定义定级、状态、
  是否计入 `fail` 或 H1 授权条件 —— 它的隐藏区段落里出现 `S3` / `manualConfirmationItems` /
  `review_required=true` / 「不计入…」即视为又立了一份口径。datacheck 只允许留**一句**自包含最小铁律
  （「隐藏区内容不得读取、解析、核对、引用或输出；发现未隔离隐藏区时停止该工作簿处理并登记
  capability gap」），**不得**扩写成第二份状态表。测试
  `H0SingleSourceTest` 按行（全部消费方）+ 按段落（机制 owner）判，**不**禁止「H0」「隐藏区」这些词。
- **Excel 依赖 fail closed**（2026-09-26 · OPT-005）：`openpyxl` 是**第三方运行时依赖**；缺包时
  `prepare_materials.py` 写结构化 `dependencyGaps`（依赖名 / 格式 / 本次未核 / 未生成工作版）并按
  `capability gap` 记账（**不是**被审件缺陷、也不是"材料缺失"），其他文件继续盘点；
  `recalc_check.py` **清晰非零退出**（exit=3）且**不产出差异文件**。**禁止**在缺 `openpyxl` 时改用
  标准库解析 OOXML 读单元格值/公式继续审核，也禁止 pip 安装或切换解释器。raw XML 仍合法用于
  `prepare_materials.py` 的结构元数据补足、`media_extract.py` 的包结构与媒体锚点、测试夹具与归档解压。
  `ExcelDependencyContractTest`、`MissingOpenpyxlBehaviorTest`（两个脚本各自一份）用**影子模块**在
  子进程里模拟缺包，**不卸载本机包**。

- **模块隔离的覆盖语义（`_path_overlaps`，2026-09-26 · R2 补充）**：非运行时 / 仅兼容模块只要**任意部分**
  进入下载清单就算泄漏。目标是**目录**时，其**内部文件**键同样算 —— `06-规则库/M-收益法/04-模块-收益法`
  进运行时 = 该原型模块泄漏了一半（R1 的 `_path_covers` 只认"键==目录"或"键在目录之下且以 `/` 收尾"，
  对此**完全静默**）。目标是**文件**时仍只认"它自己"或"祖先目录"，否则相似名兄弟会假阳性。
  因此本仓有**三个**方向明确的谓词，用途不得互换：
  `_path_covers`（内容是否被递归纳入 → 装配缺口）、`_path_within`（子目录是否被**显式**登记 → 二级维度）、
  `_path_overlaps`（模块是否有**任意部分**被纳入 → 隔离码）。
- **路径覆盖语义（`_path_covers` / `_path_within`，2026-09-26 · OPT-004-R1 修正）**：判断"某个键是否覆盖某个
  目标"一律**按路径分段**，不用裸字符串前缀 `key.startswith(target)`。三个被复核实测出来的反例：
  1. **只装父目录** `06-规则库/M-数据对齐-勾稽与一致性/` → 两个禁用模块被**递归下进本次审核**，旧实现
     因"键不等于前缀也不以它开头"而**漏报**；正确语义是目录键递归包含其下全部节点；
  2. **相似名兄弟文件** `…/05-模块-基准要素一致性-扩展` → 旧实现**误报**该原型模块被装配（文件键必须精确匹配）；
  3. **只装子文件** `…/M-计算表审核/00-模块边界与证据规则` → 旧实现把它当成**覆盖了整个受监视目录**，
     于是装配缺口被掩盖；目录键才算覆盖目录。
  另有一个**方向**问题：`_path_within`（"这个子目录被**显式**登记了吗"）与 `_path_covers` 方向相反 ——
  用 `_path_covers` 判二级维度会让它恒真（每个可用叶子都声明了一级根），二级门禁会整体失效。
  目录键因以 `/` 收尾而天然分段安全；只有**文件键**需要精确相等。
- **权威根必须**精确**装配**（`AUTHORITATIVE_ROOT_NOT_RECURSIVE`，2026-09-26；R2 收紧）：`06-规则库/M-计算表审核/`
  这类"唯一权威口径根"必须有**它自己**的目录键（`06-规则库/M-计算表审核/`）。只写若干单文件键会报本码；
  **过粗祖先**（如 `06-规则库/`）**也不能替代** —— 它虽然把内容带进了清单（因此**不报** `ASSEMBLY_GAP_METHOD_LAYER`），
  却会把整个规则库连禁用模块一起拖进本次审核（此时 4 个隔离码会一并报出）。缺口与"不够递归"是两个各自
  独立成立的判断，**同时报**；
- **原型/非运行时模块**单独追踪，不计作运行时装配缺口：`06-规则库/M-收益法/`、
  `06-规则库/M-法律法规合规/`、`06-规则库/M-数据对齐-勾稽与一致性/05-模块-基准要素一致性`
  （2026-09-26（F-007）加入：自述"版本 v0.1 / 状态 原型 / A 级条目待编"）为 `prototype/non-runtime`，
  文本与校准表必须显式显示；若 router 或装配表（**或其父目录**）把它纳入下载清单，报
  `NON_RUNTIME_MODULE_ASSEMBLED`（error）。正文自行变化不会自动启用，须满足正式发布、规则编号与维护人条件并经人工复核；
- **仅兼容模块**（`COMPAT_MODULE_ASSEMBLED`，2026-09-26）：`06-规则库/M-数据对齐-勾稽与一致性/03-模块-数据校对`
  是库内保留的**兼容入口**（正文自述"正式内容一律指向 `06-规则库/M-计算表审核/`"），供外部旧引用使用，
  **不得进入 CRWU 运行时装配**。被装配（含被父目录递归带入）即 error。它与原型模块共用 `nonRuntime` 校准桶，
  用 `classification = compat-only/non-runtime` 与被误装的 `prototype/non-runtime` 区分；
  注意**负面示例也要避开反引号寻址键**：写成 `` `06-规则库/…/03-模块-数据校对` `` 的"不要装配"说明句本身就会被算作装配键；
- **缓存选择：自动发现 vs 显式覆盖**（`test_real_repository_library_path_keys_exist`，2026-09-26 · R1/R3）：
  缓存来源由 `_cache_candidates()` 显式区分为三种模式，**不再返回无法辨别来源的 `list[Path]`**：
  1. **自动发现**（`automatic`）：本地 crwu-dws 目录缓存根（脚本常量 `DWS_CACHE_ROOT`）下空间名匹配的目录，按抓取时间**新→旧**；
     备份目录按**精确名称前缀** `<知识库名>.bak-<时间戳>` 判定（不是「名字里含 `.bak`」）：
     `…知识库.bak-2026…` 排除；`….bakery` / `….bak` **不**排除；其它知识库的备份也不会出现在本知识库的排除消息里。
     被排除的是**回滚备份、不是活缓存**，且排除清单会写进 skip 消息（不静默）。
     逐个评估候选：**过期只记录、继续下一个**；找到完整有效候选即通过；**全部用尽**且都只是允许的过期缺口时，
     **聚合一次** skip 并把每个候选与其缺失键列出。
  2. **显式缓存目录**（`CRWU_DWS_CACHE_DIR`）：只此一个候选，**不降级**到自动发现；不存在、不可解析、
     知识库不匹配、过期、缺键、真实漂移**一律失败，不 skip**。
  3. **显式快照文件**（`CRWU_DWS_SNAPSHOT`）：必须使用**调用者传入的那个文件**（旧实现取它的 parent 再固定读
     `目录快照.json`，等于偷偷换文件）；同样一律失败而非 skip。
  **在成功选中完整有效候选之前**，被**实际评估**过的候选上出现"声明之外缺失键"或"后缀/斜杠漂移"
  都直接失败；一旦命中完整有效候选即**成功返回并停止**，更老的历史缓存不再参与判定，其漂移不得污染结果。
  允许的过期缺口由 `_REPO_KEYS_NEWER_THAN_LOCAL_CACHE` 声明（本仓晚于本地缓存入库的库内根）；
  用 `CRWU_DWS_SNAPSHOT=<新鲜产物>` 指向新鲜目录/文件即可恢复最强断言；
- **`目录树.md` 解析**（`_parse_box_tree`）接受规范式的**无分支根层行**：`crwu-dws/references/00` §4
  的渲染示例中根层条目为裸名，旧实现要求每行都有 `├─`/`└─`，会把根层整体丢弃并破坏层级栈
  （实测 327 节点只解析出 315）。三种目录形态必须给出完全相同的路径集合。
- **二级目录一致性门禁**（2026-09-26 立规，`inspect_second_level_index`）：知识库里有二级目录
  **不等于**审核读得到 —— 父叶子必须在三个文件里各自索引它，任一不成立即 **error**：
  1. `ASSET_SUBOBJECT_NOT_CLASSIFIED` / `BUSINESS_SUBROUTE_NOT_CLASSIFIED`：二级**标签**须出现在
     `00-applicability.md` 的识别表里（表格行 / 列表项）。**只认 00**：`01-kb-assembly.md` 有标签
     不能替代 —— 否则装配表替分类表说话，三个维度重新退化成两个。反引号内的路径不算（否则分类
     维度会退化成装配维度的影子），且只认去掉排序前缀的标签、不认节点名 `01-通用设备`。
  2. `ASSET_SUBOBJECT_NOT_ASSEMBLED` / `BUSINESS_SUBROUTE_NOT_ASSEMBLED`：`01-kb-assembly.md`
     须写出该二级目录的相对目录或完整库内路径键；
  3. `ASSET_SUBOBJECT_NOT_REVIEWED` / `BUSINESS_SUBROUTE_NOT_REVIEWED`：`02-review-focus.md`
     须写出该二级目录的路径（相对或完整）。

  另有 `ASSET_SUBOBJECT_ABSENT_CLAIM`（二级目录确实存在却仍声称"本一级根未提供 `02-细分对象/`"）、
  `BUSINESS_SUBROUTE_NOT_IN_CLASSIFICATION`（子业务未登记进 `04-business-classification.md` 的
  子业务取值域），以及既有的 `ASSET_SUBOBJECT_REVIEW_MISSING` / `BUSINESS_SUBROUTE_REVIEW_MISSING`
  （二级目录缺审核文件，warning，记内容 gap）。
  **二级对象/子业务不各建 Skill、不占 registry 行**；门禁只对**已注册且 `available`** 的父 Skill 强制。
  失效模式：老检查器只查"二级目录是否缺审核文件"，对"库里有、父叶子没索引"完全静默
  （2026-09-26 实测：机器设备/债权各 4 个细分对象已入库，两个叶子仍声明无细分对象，而 error=0）。
