# Changelog

本仓**只有一条形态**：`src/` 是唯一源码，产物 `lib/index.js` + `lib/client.js` 按 DSH 包插件分发，
版本号用 semver（`package.json` / `VERSION` / `CHANGELOG.md` 三处一致）。

2026-09-20 收尾前本仓并存过一条**动态 Cordis 形态**（`legacy/`，在 DSH 会话里由
`cordis_define` + `cordis_run` 装配，版本号用 DSH 的 `pkg-N`）；它已在本仓收尾时删除
（见 `0.0.1` 一节），下面 `legacy · pkg-43` 及更早的记录是它的历史。

## package · 0.0.45 · 2026-10-23 · fix · OCR 覆盖率门禁、文本通道兜底与页图判读落盘（未发布）

2026-10-22 本地审核 `la-1792650417169-c1024edd` 交付了 54 条"未审核"：其中 34 条是**已读未落盘**（子代理读完 32 张照片后被终止，`ocr_record.py` 一次没调），18 条是 1171 页扫描件从未进入 `ocr_prepare`；而"已审核 30/84"这个数字由父会话在交付脚本里**即席折算**。根因有四层，本节逐条修。

### 新增功能

● **OCR 覆盖率快照 `ocr_coverage.py`（crwu-ocr 技能）** 把 `ocr/index.json` 与 `ocr/recognition/*.json` 折算成逐来源 verdict：`complete` / `partial`（已读但含不可读页）/ `pending`（仍有待判读页）/ `skippedBudget`。判定是纯函数、`indexDigest` 可复核，模型只消费事实、不再自拟 `done >= total` 这类规则。产出 `ocr/coverage.json`，同时给出 `budget`（默认上限 5000 页）与 `gate`（过期记录、预算超限直接 blocked）。

● **交付覆盖率门禁 `audit_delivery.py validate|render --case <案例目录>`** 按 `ocr/coverage.json` 对账：`scope.inputs[].readable` 必须与 verdict 一致（`complete`/`partial` → true，`pending`/`skippedBudget` → false）、每个未判读来源必须进 `scope.notCheckedItems`、快照 `indexDigest` 不得过期；`render` 同样前置执行。未判读本身不阻断交付（未核 ≠ 缺失），对不上才阻断；**2026-10-23 起收紧**：还有待判读页就不许交付（5000 页以内必须读完，无比例容忍，见本节末「复核补丁」）。

● **技能依赖覆盖门禁** `scripts/check_skill_python_deps.py`：遍历各技能层的运行时脚本，按 AST 取 import，逐个判定来源（同目录 / 该技能 `vendor/wheels` / DSH 运行时白名单），判定不了即失败并打印 `模块 ← 文件`；`try` / `if` 内的可选 import 单独列出、不判失败。接进 `make plugin-check`，且**用 DSH 自带 Python 跑** —— 系统 `python3` 恰好装了包，会把这个缺口全判绿。

● **审核脚本随包依赖通道** `crwu-audit/vendor/wheels/pypdf`（与 `crwu-ocr` 逐字节同版本），Host 把 wheel 目录的绝对路径写进 `<案例>/scripts/runtime.json`，`prepare_materials.py` 校验 sha256 后 zipimport。写入点从"第一次执行脚本"前移到 **认领 / 建档**（`crwu_audit_local_claim`、`crwu_audit_case_bootstrap`），因为模型实际会用 `pwsh` 直接跑脚本、那条路径不经过 `crwu_run_python_script`。

### 修复

● **DSH 运行时没有 pypdf 时，全部 PDF 被记成 `pypdf-error`** 28 个 PDF 连页数都是 0，整批材料被推给视觉判读。现在盘点顶层写 `vendoredPython`（`activated / wheel / source / reason`），接上以后 `ocrRequired[]` 只剩真正没有文本的页。

● **文本层判据落在逐页原文** 旧判据拿**拼好的 `提取/*.txt`** 比 50 字符，而它带 `===== 第 N 页 =====` 分隔符，8 页以上任何文件都"够长"；配合只认 `strip()==""` 的 `emptyPages`，扫描件每页带几个水印残字（现场 80–351 页的工商资料每 5 页约 40 个残字）就既不进 OCR 队列、也不进未核清单——**被静默当成正文读**。现在用不含分隔符的原始文本判 50 字符阈值，单页 `strip()` 少于 20 字符算薄文本页，占比 ≥50% 即按"扫描件带残字"进 `ocrRequired[]`（单页封面/隔页不会触发整份）。

● **`crwu_run_python_script` 的探测与执行策略不一致** 探测不带会话策略时落到部署默认 `workspace-write`，在 ACL restricted-token runner 起不来的机器上回 `0xC0000142`，而脚本真正执行那一步经 Broker 本来会用会话策略——同一个会话两条路径两个结论。现在两次探测（版本 + 控制）都带调用方会话策略。**边界**：托管审核会话按 `policy.ts` 永远 `workspace-write`，本修复只覆盖本地/手动会话，托管侧的沙箱 runner 问题仍归部署方。

● **页图判读的委派规则自相矛盾** "单个子代理最多 12 页"与"同一份来源不许拆给多个子代理"无法同时满足（现场有 72/85/107/245/351 页的单份扫描件）。改为"同一份来源只交一个子代理；一个子代理一次最多接 12 页，单份超 12 页整份交给一个、靠 8–10 页落盘压损失窗口"，并明确终止子代理前先要求落盘。

● **整份打不开的件被洗成"已审核"** `ocr_coverage` 的 `required == 0` 判定会把 `needs-password`（加密 PDF）与 `failed`（整份渲染失败）算成 `complete`，交付门禁进而**要求**模型把它们标成 `readable=true`——比不判读更糟。现在这两种状态落 `pending`，`reasonCode` 分别为 `pdf-password-required` / `source-failed`，披露里带各自员工动作（提供口令/重送可读件）。

● **从未进入 `ocr_prepare` 的文件不在门禁覆盖面内** 事故里 1171 页扫描件从未进过 `ocr_prepare`，因此不在 `ocr/index.json`、旧门禁只读 `coverage.json` 完全看不见它们。现在 `audit_delivery --case` 用 `材料盘点.json.ocrRequired[].path` 逐条对账：既不在快照、也没进 `scope.notCheckedItems` 的，报缺项；盘点文件缺失同样失败。

● **预算量错了口径** `budget.used` 原取"总必读页数"，导致 6000 页全部读完仍被判 `budget-exceeded`。改为量**本轮待判读页数**，并新增 `requiredPages` 作信息字段。

● **整批拒绝没有写入通道** 提示词要求模型"记 `budget-refused`"，但 `derive_status` 只产 `prepared/partial/failed`，这条承诺无法落地。新增 `ocr/refusal.json`（逐来源 `relativePath / reason / pages`）：`ocr_coverage.py` 校验路径、理由、来源归属与页数，**只在批次确实超预算时生效**（否则报 `refusal-not-justified` 并阻断），生效来源判 `skippedBudget` 并从预算扣除、逐条披露。拒绝不写 `ocr/index.json`、不删材料。

● **同名文件按 basename 对账会误配** `材料-源/A/营业执照.pdf` 与 `材料-源/B/营业执照.pdf` 共用一个 basename：verdict 不一致时旧逻辑会替调用方挑一份来比。现在报"同名歧义，请在 `displayName` / `relatedFiles` 里带上子目录"；披露侧优先按完整相对路径匹配。

● **`runtime.json` 写失败会阻断脚本执行** 与"尽力而为"的既有口径不一致。执行入口同样改为 warn + 继续，降级由盘点里的 `vendoredPython.activated=false` 暴露。

● **`.xls` 在用户环境读不出** `crwu-audit` 的 `.xls` 读取依赖 `xlrd`，DSH 自带解释器没有它、任何技能也没随包 —— `.xls` 明细表/测算表会整类只记能力缺口。现随包 `xlrd 2.0.2`（纯 Python wheel），与 pypdf 同一套 `runtime.json` 通道；`assert-pack` 同步断言。

● **随包依赖只激活了 `pypdf` 一个包** `activate_vendored_python` 写死了 `packages.get("pypdf")`：manifest 里再加包也永远不会进 `sys.path`。改为**按 manifest 全量校验后统一插入**，任一个 wheel 缺失或 sha256 不符则整份不激活（不留"pypdf 可用、xlrd 静默缺失"的半激活状态）。

### 约束

● `ocr_coverage.py` 由 Host 暂存进案例（`OCR_RUNTIME_FILES` / `OCR_SCRIPT_NAMES`），模型可用 `crwu_run_python_script` 提交 `ocr-skill/scripts/ocr_coverage.py`；`--case` 仍是唯一允许的案例参数。

● `runtime.json` 写入是**尽力而为**：写不出来只退回"缺依赖、如实记账"，不让认领或建档失败；`crwu_run_python_script` 仍保留一次写入，兼容本变更之前已存在的案例目录。

● `npm run vendor:check` 断言两个技能里的同名随包依赖版本/wheel/sha256 一致（输出区分"跨技能已比对"与"单技能"）；`pack:assert` 增加两条新路径，xlrd 只随审核技能。

● `fetch_wheels.py`（源仓维护工具）支持 `--vendor-dir / --only`：登记表新增 `xlrd`，换目录时必须显式指定包，避免把别的技能的 manifest 覆盖错；既有 `note` 字段会保留。

● `vendoredPython`（盘点顶层）形状改为 `activated / packages / source / reason`（`packages` 为 name→version），`00` 与单测同步。

### 验证

● 新增用例 `test_ocr_coverage.py`（25 项：verdict 表、26 页 1 页不可读判 `partial`、加密/坏件判 `pending`、预算按待判读页、拒绝生效与不被受理、过期记录、CLI）、`test_audit_delivery.py::CoverageGateTest`（16 项：缺快照/过期 digest/blocked gate/readable 冲突/未判读未披露/未判读已披露放行/`ocrRequired` 缺项/盘点缺失/同名歧义/CLI 有无 `--case`）、`test_prepare_materials.py` 新增薄文本页两项（残字扫描件必进清单、短封面不误伤）、`host-audit-runtime.test.mjs`（4 项：写入内容与目录、缺依赖跳过、写失败不抛）。

● 变异验证 把 `ocr_coverage` 的 `partial` 改成 `pending`、把 `THIN_PAGE_RATIO` 调到 1.1，对应用例分别变红，确认断言咬得住。

● 新增/加强用例 `test_prepare_materials_deps.py` 增加"xlrd 激活后必须在干净子进程里可 import"（证明通道有用，而不是本进程碰巧有包）；`test_prepare_materials.py` 的随包测试改为断言**全量包**，并新增"一个 wheel 坏掉时整份不激活"。

● 门禁 `scripts/check_skill_python_deps.py` 由红转绿：唯一缺口 `xlrd` 已随包；可选 import（`pdfminer`、`requests`）仍按设计降级。

● 门禁 `npm run typecheck`、`npm test`、`make plugin-check`、`make docs-check`、`git diff --check`（结果见交付说明）。

### 复核补丁 · 2026-10-23（同一 0.0.45）

● **待判读页即阻断（`pending-pages`，无比例容忍）** 5000 页以内**必须读完**：`pending > 0` 即 `gate.blocked`，`pending-pages` 逐条列出未读完的来源与页号，**没有比例豁免**；`--max-pending-ratio` 与 `DEFAULT_MAX_PENDING_RATIO` 已删除（宽不了任何批次），`budget.pendingRatio` 只作汇报、不再参与判定。分子分母都并入 `材料盘点.json.ocrRequired[]` 里"从未进过 `ocr_prepare`"的件——否则不 prepare 就能把比值压到 0，正是 1171 页扫描件消失的方式；这些件的 `pageCount` 为 0 时报 `inventory-page-count-missing` 并阻断。唯一放行通道是必须判读页数 > 5000 时的整批拒绝。

● **已读到内容就必须读完** 某来源 `recognized > 0` 且 `pending > 0` 时，`pending-pages` 会把该来源的 `recognized / pending / 待判读页号` 一并列出：读到一半的来源要么读完，要么把读不出的页登记 `unreadable`。2026-10-22 现场被终止的 34 页正是这种形状。

● **缺索引不再自称 `not-required`** 盘点要求 OCR 但 `ocr/index.json` 不存在时，快照产出 `status=index-missing` + `gate.blocked`（指向 `ocr_prepare.py`），不再写一份 `passed` 的空快照；此前只有交付侧 digest 检查会报一句误导性的"快照已过期"。

● **`readable` 回退：个别空白页不再把整份判成不可读** 上一版把任何 `empty` 页都算进 `err`，于是一份 300 页报告只要有空白分隔页就 `readable=false`，叠加交付门禁等于要求整份重渲。现在只有"整份无文本（原始逐页文本 < 50 字符）"或"薄文本页占比 ≥50%"才判不可读；`empty-pages` 恢复 `readable=true`，仍进 `ocrRequired[]` 带页号。

● **`--case` 从结果文件目录自动推导** 门禁不再依赖"模型记得传 `--case`"：`validate`/`render` 省略时，结果文件所在目录若有 `ocr/` 或 `材料盘点.json` 就按案例目录对账，否则保持既有行为（单测夹具、临时文件不受影响）。

● **发布侧闸门** 新增 `coverage-snapshot.ts`：`crwu_audit_oss_publish` 与 `crwu_audit_dingtalk_archive` 在送件前读 `ocr/coverage.json`，缺快照、`status=index-missing`、或 `gate.status != pass` 一律拒绝并带回阻断项（设计 §6 承诺过、此前未实现）。`indexDigest` 的权威校验仍留在 `audit_delivery validate`（JS 复刻 Python 规范化序列化会因浮点/转义产生假过期）。

● **`vendor:check` 补孤儿 wheel 检查** 目录里有、manifest 没登记的 wheel 会被打进包却永远加载不到；现在直接判失败（已用假 wheel 验证会红）。

● **文档同步** `crwu-ocr/SKILL.md`、`references/00`、`14 §1.3`、`11` 与 Host 提示词（`prompt.ts` 3d/6）改为同一口径：还有待判读页即阻断（无比例容忍）、已读必读完、分母含未入索引件、`--case` 可省、跑完不许再 `ocr_record` / `ocr_merge`。

● **验证** `test_ocr_coverage.py` 36 项（新增一页未读即阻断、`pending-pages` 逐来源明细、未入索引分母、缺页数、index-missing、`--max-pending-ratio` 已删除）、`test_audit_delivery.py` 132 项（新增自动推导与"不在案例目录不拦"）、`test_prepare_materials.py` 51 项（空白页 `readable=true`）、`host-coverage-snapshot.test.mjs` 6 项；`vendor:check` 孤儿用例实跑为红。

### 复核补丁 2 · 2026-10-23（同一 0.0.45）

● **拒绝清单的页数不再信任模型声明（门禁绕过）** 不在 `ocr/index.json` 里的来源，页数**只认 `材料盘点.json` 的 `pageCount`**：声明值与盘点不一致报 `refusal-pages-mismatch` 并阻断，盘点没有页数报 `refusal-pages-missing`。此前实测 1086 页的件声明 6000 页即可让 `gate.status=pass`、`skippedPages=6000`，同时也把 `totals.required` 污染成 6010。

● **发布侧门禁 fail-closed** `requireCoveragePass` 改为三态读文件（`content` / `missing` / `unreadable`）：文件服务不可用、权限拒绝、盘点损坏、索引读不出来一律 `errorKind=infrastructure` 并拒绝发布，不再折成空串当作"本轮不需要 OCR"。错误文案明确写"这是发布闸门的基础设施故障、可重试，不是没做 OCR"，避免被误读成审核失败。

● **本地审核允许带未核交付（`policy=disclose`）** `ocr_coverage.py` 新增 `gate.policy`：案例目录有 `本地审核清单.json` 即本地审核（`auto` 判定，**不是模型可提交的参数**），**只有"还没读完"这一类**不阻断交付（`pending-pages` / `budget-exceeded` / `index-missing`）——它们进 `warnings` 与 `disclosures`；`refusal-*`、`stale-recognition`、`inventory-page-count-missing` 这类**数据完整性**问题在两种 policy 下都阻断（本地审核允许"没读"，不允许"说假话/用过期记录"）。`gate.status` 仍如实记 `blocked`，`gate.effectiveStatus` 才决定能不能交付。托管审核保持 `strict`：还有待判读页就不许交付。两条硬检查在两种 policy 下都不放宽——`readable` 不许标反、每个未核来源必须进 `notCheckedItems`（漏披露照样失败）。

● **`--pending-policy` 只给维护与测试** `auto|strict|disclose`，默认 `auto`；审核提示词不提交该参数，`resolve_pending_policy` 的判定依据是案例里的本地审核交接清单。

● **验证** `test_ocr_coverage.py` 42 项（新增：拒绝页数取自盘点、盘点无页数与虚报分别被拒、`policy` 四态）、`test_audit_delivery.py` 136 项（新增：strict 阻断 / disclose 放行 / disclose 仍查披露 / disclose 仍查 `readable`）、`host-coverage-snapshot.test.mjs` 11 项（新增：权限拒绝、无 fs、盘点损坏、索引读不出来、disclose 放行）。`make plugin-check` 绿。


## package · 0.0.44 · 2026-10-22 · fix · 补上 langgraph 的必需 peer，修干净 profile 上的依赖错误

0.0.43 在 Windows 首次安装后即报依赖错误；macOS 上靠历史残留侥幸没暴露，同一路径实测也已经坏。

### 新增功能

● 本地自测安装 **make plugin-local-install** 现打当前代码的 tarball（`npm pack` 会跑 prepack，打进包的 `lib/` 一定是当前源码构建的），删掉 profile 的 `node_modules` 后把包装进 DSH，再用 **make plugin-local-verify** 校验：声明的依赖、入口的每个非宿主 import、以及依赖自带的必需 peer 都必须能从插件自己的位置解析；profile 里若还有别的包，会提示它可能在替本包兜底 peer。这两个目标只存在于源码仓库，不随 npm 包发布。

### 修复

● 补齐 langgraph 的必需 peer `@langchain/langgraph@1.5.1` 把 `@langchain/core@^1.1.48`、`zod@^3.25.32 || ^4.2.0` 声明为必需 peer（无 `peerDependenciesMeta` optional），而接收方 profile 用 `autoInstallPeers: false` 解析（宿主有意如此：`@deepseek-ai/dsh-*` 由运行时提供，不由包管理器安装），这两个 peer 因此永远装不到可解析的位置；本包 `lib/index.js` 顶层静态 import langgraph，于是加载阶段直接 `ERR_MODULE_NOT_FOUND: Cannot find package '@langchain/core'`，不是某个功能不可用。修法是把两者写进本包 `dependencies`，`devDependencies` 同步一份但那只覆盖本仓开发、不参与接收方装配。

● macOS「看起来没事」的假象 残留的 `@langchain/core` 落在 `node_modules/dsh-crwu-workbench/node_modules/`（从提升到顶层的 langgraph 位置向上解析看不到），`zod` 只是 `dsh-plugin-hub` 顺带带进来的 —— 两者都不是本包的依赖，换一台干净机器就暴露。

### 约束

● 包形状契约测试 `tests/unit/host/host-package.test.mjs` 新增断言：本包每个运行时依赖的非 optional peer 都必须出现在本包 `dependencies` 里（宿主提供的 `@deepseek-ai/*`、`react` 豁免）。补依赖前该断言失败，失败项正是 `@langchain/langgraph → @langchain/core`、`@langchain/langgraph → zod`。

● 规则沉淀 `plugins/AGENTS.md` 与工作台 `AGENTS.md` 写明这条边界，避免下次加依赖时重犯。

### 验证

● 干净目录复现 按 `nodeLinker: hoisted` + `autoInstallPeers: false` 装 0.0.43，原样复现上述报错；换成 0.0.44 的依赖块后 `@langchain/core`、`zod` 落在顶层，`import('@langchain/langgraph')` 通过。

● 发布前门禁 `npm test`（3263 项，3259 通过 / 4 跳过）、`version:check`、`make docs-check`、`git diff --check` 全部通过。0.0.44 于 2026-10-22T05:10:52Z 发布到 npm。

## package · 0.0.43 · 2026-10-21 · feat · 估值开发预览、OCR 兜底与审核安全收口（合并未发布的 0.0.44–0.0.53）

0.0.43 是 npm 上 0.0.42 之后的下一个发布版本。此前仓库内的 0.0.44–0.0.53 均为内部排期、
从未发布，现全部并入本节；下面的 `###` 小节保留各批次的原始记录。

**估值链路仍是开发预览，不随本版对外承诺可用**：方法覆盖默认只有市场法，58 同城未接入，
缺表格计算程序时交付上限为 `partial`，验收仅覆盖 macOS。

### 0.0.53 · 2026-10-21 · fix · 审核链路的安全边界与状态正确性

十五项复查的落地（编号沿用复查清单）。没有新增 Tool、没有改线协议字段。

- **OCR 入口（1–3、15）**：`--src` 必须落在案例目录内（真实路径判定、拒绝绝对路径与 `..`、
  文件软链不跟，且失败时整体退出而不是跳过）；OCR 脚本的 `--case` 收集**全部**出现次数，
  重复即拒；脚本路径按路径语义归一后再判定，`//`、`./`、大小写变体不再绕过 `--case` 校验；
  四个脚本关掉 argparse 缩写，并在暂存布局（`<case>/ocr-skill/scripts/`）里自行核对 `--case` ——
  Host 的检查退化为诊断，真实边界在脚本侧。
- **OCR 判据（15）**：`--only` 的 OCR 源改按内容判定（PDF / PNG / JPEG / GIF / BMP / TIFF / WEBP 的
  magic），扩展名只作回退。盘点本来就把"扩展名不认识但内容是图片"的件放进 `ocrRequired[]`，
  这里再按文件名卡一遍会让清单与索引永远对不上。
- **删除路径（4、5、7、8）**：主目录判据改用 realpath（HOME 为软链时真实主目录、它的祖先与
  `~/.dsh` 仍被拒）；每次删除前复核工作空间真实路径，确认后被换成软链即整体停手；删除前再判一次
  授权（撤回 → `aborted` / `policy`，一条不删）；回读失败登记为 failure 并把结果落 `partial`，
  不再把"读不到"当成"已清空"。
- **状态与快照（12、13）**：`audit-start` 的进程内锁改在第一个 `await` 之前同步抢占，并发两次
  只成功一条；本地审核快照对同名文件改名落盘，并在清单里记 `renamedFrom`，不再静默覆盖。
- **加密 PDF（14）**：`ocr_prepare` 新增终态 `needs-password`（不渲染、不判读），`ocr_status` 单列
  `needsPassword[]`；门禁口径改为"有来源且非 `failed`"，加密件必须整份登记未核并给员工动作
  （提供口令或解密版）。本版**不加**口令通道：口令只能由员工提供，落到案例目录就是一份明文凭据。
- **验证**：`npm test`、`make plugin-check`、`go test ./...`；OCR 用例在 DSH 自带 Python 下跑真实渲染。

### 0.0.52 · 2026-10-21 · fix · OCR 实测校准

用一份 8 页真实扫描件跑通后，修掉六处“设计与实际不符”。

- 分辨率上限：`ocr_runtime.SESSION_MAX_WIDTH = 1721`（实测值），超过等效宽度的 DPI 只往
  `render.engineNotes` 记一条告警，不再让 300 DPI 白占磁盘（实测仅提升约 4%）。
- `--re-render` 与 `--force` 都计入双读预算；超出时直接拒绝（退出码 2），显式 `--force-budget`
  才放行，并在 `budget.exceededBy` 记录超出页数。重复执行同一重渲命令按“变体已存在”复用，
  不再被误判超预算；未知页号/无索引在任何写入之前就拒绝。
- `escalate[]` 带 `priority`（表格 > 关键字段 > 不确定项），且只返回预算内条数，不再给出
  “建议 7 页、预算只够 3 页”的悬空清单。
- `ocr_status.py` 的 `actions[]` 按实际 `reads` 生成：已双读就说“已对 N 页双读”，不再一律写
  “本次未做双读”。
- `ocr_merge.py` 页头增加 `方向`（仅 `rotated-90/180/270` 时出现），旋转扫描页不再需要
  下游自己回查记录；`policy.mode` 记录重渲后最后使用的手段，不再恒为 `none`。
- 文档与 schema 同步；旧案例目录（无 `budget` / `renders`）继续可读。

### 0.0.51 · 2026-10-21 · feat · OCR 关键字段回指、双读冲突与自适应预算

识别结果从"模型说它对"推进到"能指出它在哪、两次不一致会暴露"。

- `crwu-ocr` 页级新增 `pageClass / riskTier / policy / renders[] / pendingReason`，顶层新增
  `budget`：首轮按风险选 144/200 DPI，大文档（>50 页整份无文本层）仍从 144 起步；
  `--policy fast|auto|quality`、`--budget N`（0 = 禁止双读）、`--re-render pages:N --dpi X --mode tile`。
- 识别记录新增 `keyValues[]`（`label/value/quote`，quote 必须是本页原文逐字片段）、
  `conflicts[]`、`reads[]`、`recognizer`；`recognitionStatus` 增加 `conflict`。
  同一字段两次判读不一致时整页标冲突，**不替人选值**，合并文本追加冲突说明行。
- `ocr_record.py` 返回 `escalate[]`（表格 ≥10 行 → `tile`；关键字段 ≥3 或出现小字/模糊等 →
  `dpi-retry`），预算耗尽时停止升级；新增 `--vision-unavailable`，把待判读页整类标为未判读并退出 3。
- `ocr_status.py` 新增 `conflictPages / budgetExhausted / notVerified[]`（每页一条，
  `conflict > unreadable > pending`）；`ocr_merge.py` 页头增加档位与读取次数。
- 维护期新增 `ocr_bench.py`（关键字段准确率、静默错误率、表格单元格准确率），不进 Host 暂存清单。
- 打包断言补齐 `ocr_runtime.py / ocr_merge.py / ocr_bench.py / schemas`（此前漏断言，缺文件不会被发现）。
- 门禁：`test_ocr_flow.py` 32 项、`test_ocr_bench.py` 3 项接入 `make plugin-ocr-check`。

### 0.0.50 · 2026-10-20 · feat · 审核 PDF 文字 OCR 兜底与连贯合并文本

pypdf 能读的文本**保持原样**（`提取/*.txt` 文件名、内容、页分隔符不变）；只有 pypdf 读不到的页
与独立图片才交 `crwu-ocr` 兜底，并把兜底结果按页序合并成一份可顺读的文本。

- `crwu-audit/scripts/prepare_materials.py`：PDF 逐页统计 `textPages`（`total/withText/empty/emptyPages`）、
  每条材料 `textSource`（`pypdf` / `ocr-required` / `none`），盘点新增顶层 `ocrRequired[]`
  （整份无文本层 / 存在空页 / 加密 / 读取出错 / 独立图片）。加密与坏文件不再让盘点中断。
- `crwu-ocr/scripts/ocr_prepare.py`：新增 `--only <案例内相对路径>`（可重复），只索引兜底清单里的文件；
  与 `--reset`、`--src` 互斥，绝对路径 / `..` / 非 OCR 源 / 不存在的文件一律参数错误且不改写索引。
- `crwu-ocr/scripts/ocr_merge.py`（新）：按页序合并 `ocr/merged/<sourceId>.txt`，页头标来源
  （页图判读 / 文本层 / 未判读）与页图 sha 前 12 位；未判读页写显式占位；`--split-pages N` 可选分卷；
  `mergedDigest` 只覆盖正文，无新证据时重跑不变。
- Host：`OCR_RUNTIME_FILES` 与可提交脚本白名单加入 `ocr_merge.py`；审核与本地审核提示词改为
  “pypdf 优先 → OCR 兜底 → `ocr/merged/` 顺序读 → `ocr_status` 覆盖门禁”。
- 门禁：`test_prepare_materials.py` 接入 `make plugin-check`（此前未被任何门禁执行）。

### feat · 工作空间清理（清空）· 协议 49 · 授权 schema 2

环境信息页「工作空间」多了「清理工作空间…」：先扫描并展示待删清单，逐字输入目录名后才执行。

- **范围**：工作空间根下的全部直接子项（目录与文件）与归属该工作空间的 DSH 会话；根目录本身、
  工作空间选择、其他工作空间、凭据与授权都保留。
- **两步确认**：`workspace-cleanup-plan` 只读扫描，产出一份带指纹的内存计划（5 分钟、单次使用）；
  `workspace-cleanup-apply` 带 planId + 指纹 + 目录名执行。确认期间内容变了（指纹失配）就整体拒绝，
  一条都不删。
- **会话**：默认归档；运行中的会话先 `stopActivity` 停止再归档。可选「同时彻底删除会话日志」——
  这不是 DSH 支持的路径（官方只有归档），删完可能要重启 DSH 才彻底消失；已归档、不在列表里的
  旧会话无法枚举，日志可能残留。
- **安全**：删除只用 Host 内 `node:fs`（可注入 IO），不拼 shell；边界只认工作空间根的直接子项，
  拒绝文件系统根 / 主目录 / `~/.dsh`，不跟随符号链接；停止不下来时在动文件之前中止。
- **状态**：一并清空 `audits` / `auditRoot`，报告审核页历史随之清空。
- **授权**：新增能力 `workspace-cleanup`，收据 schema 1 → 2（老收据判 `outdated`，需重新同意一次）；
  操作 `system.workspace-cleanup` 为 `filesystem` / 特权 / 仅面板。
- 协议 48 → 49：客户端门面新增 `workspaceCleanupPlan` / `workspaceCleanupApply`。

### style · 2026-10-21 · 工作空间清理界面

- 清理入口独立放在工作空间配置底部；弹窗分为工作空间、清单摘要、会话选项、确认输入和固定底栏。
- 清单独立滚动，长路径和文件名换行；补充限制可展开，永久删除与报告审核历史清空仍直接可见。
- 修正复选框错行、按钮拥挤及完成/错误态重复取消；支持键盘焦点循环、返回入口和执行中禁止退出。
- 使用现有主题 token，原生复选框跟随应用深浅主题。删除范围、授权与目录名确认判据保持原行为。
- 隔离浏览器验收使用现有轻量渲染器和外部测试 Playwright，不增加 ReactDOM 或产品依赖；本次仅 macOS 验证。

### chore · 门禁：OCR 只认 DSH 自带 Python，npm 缓存锚在包根

- **OCR 真实渲染不再依赖系统 `python3`**：`make plugin-check` 先用 `scripts/resolve-dsh-python.mjs`
  按 `$DSH_HOME`（缺省 `~/.dsh`）/`dsh-runtimes/*/dependencies/python` 解析 DSH 自带解释器，
  再校验它能 `import PIL`，然后才跑 `test_ocr_runtime.py` / `test_ocr_flow.py`。解析不到时门禁
  直接失败并逐个候选说明原因，**不再 skip 掉两条用例却当作通过**；显式覆盖用
  `make plugin-check DSH_PYTHON=<绝对路径>`。`plugin-ocr-check` 复用同一套解析。
- **npm 缓存锚在包根**：新增包内 `.npmrc`（`cache=./.npm-cache`）。npm 的全局缓存默认在 `~/.npm`，
  受限沙箱（如 DSH 文件沙箱）只允许写工作区，`npm pack` / `npm ci` 会因 EPERM 整条失败，而 npm
  会把它误报成「缓存里有 root 拥有的文件」。该目录已被 `.gitignore` 忽略、不进 tarball；
  `npm pack` 每次会缓存一份 ~40MB 的 tarball，长期累积可用 `make plugin-clean` 清掉。

### 0.0.49 · 2026-10-19 · feat · 估值图工作面 / 原生工作流接线 / 检查点存储，协议 45

协议 42 → 43 → 44 → 45：把已编译的估值图接到可达的客户端工作面上，并把每个节点的回执、方案的精确确认、
修订的下游失效与当前任务的导出 / 加载 / 清空落成一条可核对链路；随后把停在意图路由的停止运行接入
同一父会话下的显式、有界重试，并让全部节点与选择器拿到第一次提交的入口选择快照。
npm 版本号由发布前 `version:set 0.0.49` 同步（`package.json` / `VERSION` / lockfile / Host 常量与本节一起对齐）。

### 修订 6 · 2026-10-20 · 审核 activation 迁移与 SDK 升级

- 本地 DSH SDK 固定为 `0.2.1-rc.2`，兼容矩阵保留 `0.2.0-rc.2` 并加入新运行时；engines 与 peers 显式覆盖新预发布版的 npm 安装。
- 审核按实际接口能力优先走 `startActivation`；仅接口缺失时使用旧 `start`，新入口创建失败不回退重建。
- 在 `agent/created` 创建窗口同步设置三条 deny 并回读必需工具与拒绝工具，保留真实子 Agent、工作区挂载和策略复核。
- 创建或挂载失败后有界停止；无法确认静默时保留子会话身份、句柄及退役记录，阻止替代审核。
- 错配收据不用于确认预占 child 已停止；缺少 disposer 时取消真实 Agent，同步 dispose 异常进入可恢复失败。重启后恢复未静默退役记录的占用，并允许重试被重启中断的停止流程。
- 验证平台：本次仅 macOS 本机验证，Windows 验证由现有 CI 矩阵执行，未在本次会话运行。

### 修订 5 · 2026-10-20 · 单次可纳入文件上限 30 → 200

- **本地审核与估值资料入口一起放宽**：`LOCAL_AUDIT_MAX_FILES` 与 `MAX_MATERIAL_FILES` 都改为 200，
  两处上限必须同值（估值面板的「已纳入 N / 上限」与归档阻断用的是同一个数）。
  判据不变：超过上限**整批阻止**、给出真实数量，绝不静默截取。
- Host 未装配信封不再写死 `limit`；客户端初始态与文案同步为 200，测试改为从常量推导上限值。

### 修订 4 · 2026-10-20 · 模板需求绑定与开发中标记

- 补齐只读模板检查服务与模板需求绑定：在业务 I/O 前校验当前会话、方案和 Host 登记的模板，
  通过已探测的 DSH Python/openpyxl 检查原文件；模板摘要、真实标签、目标单元格、知识原句及覆盖状态不符时拒绝采用。
- 新增隔离推理操作 `template-analysis`，使用严格结构化契约且不开放业务工具；未决问题保留为缺口，不补默认系数。
- 侧栏“报告评估”旁显示“开发中”小标签，保留现有页面与入口，并同步单元测试和浏览器验收断言。

### 修订 3 · 2026-10-20 · 共享 OCR 能力层 · `crwu-ocr`

- **新增共享能力技能层 `skills/capabilities/`**（独立注册的技能根，随 npm 包发布）：
  首个技能 `crwu-ocr` 把 PDF / 扫描件 / 图片转成可复核的逐页证据（页图 + 文本层 + 识别记录 + 覆盖状态）。
  接入 `cordis.patch.yml`、`package.json.files`、打包断言、CLI 守卫、自洽性 lint、Makefile 与 CI；
  `host-skills-patch` 的层数与技能数断言同步更新。
- **渲染与依赖**：依赖随插件发布并按 sha256 校验后由 DSH 自带 Python 加载，不在审核中安装。
  Windows 用随包 `pypdfium2` wheel；macOS 的 DSH Python 是硬化签名运行时，第三方原生库无法映射
  （`different Team IDs`），改用系统 CoreGraphics 渲染，不需要下载或证书。文本层用随包 `pypdf`；
  Pillow 由 DSH 运行时提供。页面图默认 144 DPI，按 `<stem>_pageNNNN.png` 逐页落盘，来源/版本各占子目录。
- **识别契约**：`crwu-ocr` 只做忠实识别（文字、表格、印章/签名/勾选/版式、不确定项），
  合规判断与结论仍归审核技能。记录绑定页图 sha256，重渲染后旧记录按 `stale` 拒绝；
  `pending` / `unreadable` 只能登记未核，**未核 ≠ 缺失 ≠ 通过**。长文档分批记录，覆盖可随时核对。
- **审核接入**：`crwu-audit` 的媒体/页面判读与数据核查参考统一路由到 `crwu-ocr`
  （`ocr_prepare.py` → DSH 图片判读 → `ocr_record.py` → `ocr_status.py`）；Host 在首次调用时把技能脚本
  暂存到 `<案例>/ocr-skill/`，模型只提交案例内相对路径。既有 `媒体索引.json` 放行清单与隐藏区隔离不变。
- **验证**：合成 PDF / 图片覆盖文本层、扫描页、多页 TIFF、旋转页、坏 PDF、缓存复用与记录校验；
  macOS 实机用 DSH 自带 Python 跑通渲染与全链路。Windows 真实渲染与 macOS 安装后验收仍需按
  `ocr` CI job / 真机执行，未执行前不宣称双平台已验证。

### 修订 2 · 2026-10-20 · 可选资料入口 / 全局参数 / 协议 46 / 窄屏报告卡

- **估值入口只要求两个业务选择**：已登记资产类型 + market / income / cost 之一即可开始；
  资料、独立 xlsx 模板、目的、价值类型、日期与补充要求都可留空。空选择生成诚实的零文件预览与
  可恢复项目记录；模板可单独归档。显式提供的资料仍逐条执行扫描 / 可读性 / 上限 / 截断门禁。
- **全局参数与结构化问答**：Host 投影当前（非初始）可编辑条件及其真实节点归属，节点字段附
  `rawValue` 供结构化展示；问题带原生控件 / 选项 / 必填语义，Host 按声明选项与完整必填答案校验。
- **修订与清空**：purpose / baseDate / mode 等全局条件走原子修订、从最早实际节点重跑并保留来源；
  清空先确认停止，并在等待期间核对项目 / run / 父会话身份，替换后的任务不被释放或清除。
  `WORKBENCH_PROTOCOL` 45 → **46**，项目记录仍只读兼容 43/44/45。
- **界面**：估值页改为必填两项在前的单列工作流；报告列表在窄面板切成逐报告卡片；
  本地审核改为「选择控制 → 已选清单 → 可选提示词 / 交接」的独立材料任务层级。

### 变更

- **节点失败说明与协议 48**：修复文本等非选择题携带空 `options: []` 时，原生工具校验通过但 Host 附加校验拒绝整份问卷的问题；
  仅将无意义空选项正规化为缺省，非法选项与字段仍严格拒绝。所有受阻 / 失败节点展示原因、未满足要求和恢复动作，
  保留失败会话标识，系统故障不再显示答题提交入口；模型提示附实际 Schema，支持完整失败说明并区分缺结果、类型错误和异常结束。
  协议 48 继续读取项目记录 43–47；只在 macOS 验证，未重启运行中的 profile。
- **节点展示性能**：后台节点详情读取不再阻塞流程状态轮询，同一节点未完成的后台请求复用；
  折叠的输入 / 输出在展开时才渲染结构化内容，减少抽屉打开及后续刷新的无效渲染。
- **节点问答与协议 47**：问题、已提交答案、草稿、补充说明及更正历史写入当前任务的 SQLite JSON；
  旧答案跨轮回显、可更正并与新答案统一提交，题型支持选择 / 判断 / 文本 / 数值 / 日期。
  问题定义实质变化需重新确认，不适用问题保留历史；模型失败不撤销已保存答案，材料冲突保留双方并使旧结果待重新验证。
  执行中可编辑草稿，提交版本冲突保留本地更正；节点输入输出默认折叠。
  清空二次确认后删除任务整条记录及问答，不保留归档。协议 43–46 的既有项目仍可读取；新功能仅在 macOS 验证。
- **估值页面交互**：移除「重新对接」及 JSON 导入 / 导出入口与页面文件处理代码；
  节点衔接期间显示「下一个节点初始化中…」和 loading 图标，等待处理或已停止的任务不显示该提示。
  仅待执行节点禁用并取消悬停 / 按压反馈；其余状态均可查看详情，包括受阻与等待处理节点。
- **案例检索缺口**：未识别的导航、脚本外壳或挑战页面不再被判定为“站点没有房源”；
  只有明确的页面空结果提示才采用 `no-results`。规划保留取数工具返回的能力缺口、对应来源的恢复动作与页面任务身份。
  本项不表示已实现原业务模板驱动的完整市场法案例采集。
- **规划来源身份**：向选择器明确区分材料正文、文件名、实际用户输入和知识正文的合法来源标识及字段范围，
  避免把文件名当正文引文或把能力清单当业务规则；周边社区可按无依据保持空列表，真实模板与来源缺口仍保留。
- **知识导航引用纠正**：提供入口正文中实际指向允许路径的导航原文，明确引用须包含完整 Markdown 链接。
  对版本、路径、角色和原文均有效而仅缺导航链接的选择，允许一次带反馈的重新选择；再次严格验证后才读取正文。
  其他来源与业务问题不进入重试，原校验和失败阻断保持生效。
- **要素读取与确认修复**：相同用途的重复引文、建筑面积表头单位及同行的独立面积字段可按实际原文验证；
  继续拒绝无单位、混合单位、无标签的多数字及错误裁剪引文。有效确认完成原等待要素回执、清除已解决缺口，
  保留用户来源与被替代候选，其他来源错误仍阻断；回答写入当前输入，不改初始快照。
  更正回答使用新提交标识，相同回答重试保持去重；同修订下所选节点详情随状态更新而重新读取。
- **真实图工作面**：Client 按 Host 编译出的原生节点 id 与边渲染（`data-workflow-node` /
  `data-workflow-edge-from|to`），展示节点状态、输入 / 输出、来源种类、采用的知识原文引用、
  本次已读资料、缺口与依赖影响；没有图的老数据退回阶段投影。页面不虚构阶段 / 百分比 / 推理过程。
- **方案与确认**：Host 按真实知识准备方案（方法 / 模式、逐条来源与数字字段、模板与字段映射 /
  公式试算、依据与限制）；确认绑定页面显示的那一份 `{expectedRevision, planDigest}`，
  Host 已推进到更新的方案 / 修订时拒绝陈旧确认；交付件按受控类型打开
  （`template` / `workbook` / `report` / `trace` / `data`），客户端不提交文件名或案例路径。
- **澄清与修订**：澄清按 `question.field` 给真实可编辑字段，并携带澄清身份与修订号；
  修订必须带理由、来源、基于的修订号与变更列表，创建新的、有界的子会话尝试，
  并让受影响的依赖节点失效。
- **持久化与恢复**：每个**工作空间 + 业务步骤**一份当前任务落在 `<已选工作区>/.crwu/workflows.sqlite`
  （Host 派生路径；解析到工作区之外的符号链接被拒绝）。重新进入页面被动展示并重新核对，
  只有明确动作才推进执行；导出 / 加载校验归属、图版本与修订号，**不内嵌资料字节**、
  上限 16Mi 字符；清空只清状态与检查点，**成果文件独立保留**。
- **接线与架构**：`src/host/graph/**`（根图 / 业务图 / 房地产专业子图）、
  `src/host/domains/report-evaluation/workflow/**`（端口 / 服务 / 方案 / 持久化 / 视图）、
  `src/host/integrations/valuation-workflow/host.ts`（外层装配与操作入口，`production/**` 辅助模块各自聚焦）、
  `src/host/operations|tools/report-evaluation/workflow.ts` 与
  `src/client/modules/report-evaluation/ui/workflow/**`（图 / 方案 / 澄清 / 节点详情）、
  `src/client/modules/report-evaluation/workflow-controller.ts`（页面控制器）。
  Graph / 领域 / Client 不导入 provider，能力由外层适配器注入。
- **意图路由先于专业知识**：资料 / 文本一进入先跑意图路由子会话，此时未读取专业知识、也未启动专业节点，
  路由只依据已提交正文与资料原文。识别出多个候选对象时不替员工选择，而是停在可回答的澄清上：问题逐条
  列出真实对象标识，并保留本次识别的完整对象、证据与真实意图子会话 id；员工回答后，问题与回答一起交给
  一个全新的意图子会话重新识别，资料正文沿用冻结快照。阻塞 / 失败的具体原因作为缺口显示在工作面与
  路由器节点上。
- **显式重新对接与有界意图重试**：页面被动加载不执行任何业务动作；「重新对接」只对停在意图路由、
  7 个专业阶段全部 `pending` 且 `attempt = 0`、没有结果 / 交付 / 已确认方案的 `blocked` 或 `failed`
  运行发起一次重试，沿用同一父会话、同一项目与已缓存的资料正文（不重新读取 PDF、不新建案例）。
  单一对象路由通过后，已注册的专业阶段才会继续；未知停止状态仍然保持阻塞。
- **入口选择快照**：确认入口时把第一次提交的完整选择（原始 userInput、资产类别、评估方法、目的、
  基准日、价值类型、模板标识、补充要求、输入摘要与全部冻结资料身份）固化为不可变 `initialInput`。
  7 个专业节点与知识 / 规划选择器都收到它的独立克隆，与当前已确认事实、员工回答和 `revision.changes`
  并列；当前更正、回答与重算只更新当前值，绝不回写快照，节点请求也改不动它。冷恢复 / 导入导出保留
  同一份快照，旧版本运行没有该字段时如实恢复为 `null`。资产类别与方法都必须**明确选择**
  （当前资产类别只有房地产，方法是市场法 / 收益法 / 成本法），不再有 `auto` 或默认值。
- **原生 PDF 页面渲染兜底**：内置提取器读不出 PDF 页面时可注入原生页面渲染作为可选能力，只补齐
  图片与真实页数，不把渲染结果冒充成 PDF 原有文本层；能力缺失时按缺口如实登记。macOS 上实际观察到
  8 页 PDF 的资料准备过程（业务端到端仍未验收，见下）。

### 验证与边界

- **已记录（Supervisor，macOS，实际 DSH Electron 运行时 Node 24.21.0）**：278 条 Host 工作流测试通过；
  边界组与挂载 Client 组（含 `client-valuation-workflow` 12 条与其余 Client 检查，共 89 条）通过；
  `npm run typecheck` 与 `git diff --check` 通过。此前 Host 的 24 条图操作 / 生产测试与 40 条纯交接测试
  也已通过。
- **发布前由持有者运行的包门禁**：`npm run check`（`version:check` → `typecheck` → `test` → `build` →
  `smoke:built`）、`make plugin-check`、`make docs-check`、`git diff --check`。
- **未验证 / 未承诺**：真实桌面端到端验收（真实产权证、真实知识库正文、真实来源与真实计算 / 模板、
  业务金额与底稿）**仍待进行**；macOS 上仅实际观察到**原生 PDF 8 页的资料准备**，资料准备可被观察到
  不等于业务链路已验收；Windows 未实跑。首版只交付**挂牌参考**口径，正式方法在执行之前就被识别并如实
  登记为能力缺口，不把参考成果显示成"正式评估已完成"，也不声称已经交付真实金额。
- **已知限制**：活动中的未知停止状态无法自动证明，保持阻塞（由「重新对接」人工核对）；
  模板与来源在真实探测成功之前不承诺"预检已通过"。

### 协议

- `WORKBENCH_PROTOCOL` 42 → 43 → 44 → 45：估值工作流的跨进程投影、方案确认、修订与检查点导入导出合同；
  44 追加**显式重新对接可在同一父会话下重试停在意图路由的停止运行**，45 追加**节点回执携带第一次提交的
  不可变入口选择快照**。
- 受保护项目记录在**当前为 45 且冻结输入 Schema 不变**时，允许读取已知的上一代图记录协议 43 与 44；
  42 及其他代次一律拒绝，冻结输入字节与全部身份 / 摘要 / 工作区校验不变。
  当前值以 `src/shared/consts.ts` 那一行为准，不在文档里抄数字。

### 0.0.48 · 2026-10-16 · feat · 估值流程 / 详情取证 / 后台浏览器收口，协议 42

协议 40 → 41 → 42（可加性两段），把估值取数链路从"排序即可用 + 列表页图冒充证据 + 每次抓取新开窗"
收敛为**可核对台账 + 详情证据 + 自有后台窗口**：41 负责列表快照 / 评估采用 / 交易语义，42 负责详情
取证 / 案例证据 / 后台浏览器。npm 版本号由发布前 `version:set` 同步。

### 变更

- **列表快照与预算**：`market_search` 成功列表页落**持久快照**并可复用（同一请求不再重复导航），
  按项目 / 方案 / 分组 / 轮次累计台账；合格候选预算只计**知识合格且事实合格**的记录；某一来源的
  文件级 / 页面级失败**就地停止该来源**，不继续烧预算；完整行都保留，不因排序被静默丢弃。
- **候选评估与身份**：`selection` 新增 `assessments`（`url` / `status=qualified|near-miss|excluded` /
  `reason` / `knowledgeRef`）；**没有评估即 `unreviewed`、不自动采用**，near-miss 不计合格预算；
  候选身份以 canonical URL 为准，弱事实（小区 + 面积 + 价格）只标**疑似重复**、不自动合并；同一
  对象的所有来源记录保留、编号稳定；挂牌信息保持挂牌口径，转可比参考是单独的人工 / 显式步骤，
  挂牌 / 成交的交易语义不混用。
- **详情取证**：`crwu_valuation_market_capture` 接收已选定的稳定 `caseId`，保存回读到的**实际详情
  URL**与**不可变 PNG**，并把条目写进 `推理结果/图片/图片清单.json`
  （`crwu.valuation.screenshot-manifest.v1`，按 `planId` 隔离、写入后回读核对）；页面被重定向到另一条
  房源或有可见拦截时不截图、不关联；列表页图片只作**页面证据**。
- **交付件证据**：`values.caseEvidence` 生成可见的 `案例证据` 表（完整详情 URL + native 超链接 +
  相对图片路径，**不内嵌图片**）；`build_workbook.py --case-root` 复算图片真实路径、PNG 魔数与
  sha256；`check_workbook_contract.py` 与报告数据交叉校验（`comparables[].used` 必须在证据索引里有
  同 caseId、同 sourceUrl 的行）；HTML 报告用本地图片链接展示同一批证据。
- **浏览器后台口径**：`crwu browser fetch/shot` 默认 `--background=true`，复用同一个**自有后台窗口**
  （不主动抢焦点；`--background=false` 显示**同一个**自有窗口，不是另起浏览器，也不是旧的一次性
  窗口）；`login` / `open` 是显式人工动作，把自有窗口带到前台；`recover` 与 `status --verify-page`
  走自有目标；只有人工验证（如可见人机验证）才把那张同一目标的页面带到前台。普通页面不 focus。
  浏览器不绑定单一发行版：Chromium 系即可（`CRWU_BROWSER` → 系统默认 Chromium 系 → 候选路径，
  不硬编码 Edge）。
- **知识读取与模板限制**：知识读取主通道是 `wikiPaths`（`stage` 只接受 `parameters`），入口只在
  `references/knowledge-routing.md` 声明一次；入口节点实读为 `.adoc`，导出 markdown 的相对链接写
  `.md`（解析侧保留 textual alias）。模板索引里的住宅工作簿当前只作**结构参考**、待修复与重算验收、
  **不能自动计价**，收益法 / 成本法无单独验收模板；通用 checker 无随包七表 profile；数值规则解析目前
  只认围栏 JSON 段（缺段是**适配器契约缺口**，不是知识不存在）；Provider 注册表只有
  `fang` / `anjuke` / `lianjia`（58 等为适配器缺口）。

### 验证与边界

- **已实测（macOS，Edge 155，隔离探针）**：正常态后台窗口连续 3 次截图 + 同目标复用成功；生产
  `Screenshot(ctx, true)` 隔离抓取成功（PNG 15780 bytes，不用 `Page.enable` / emulation / 额外 flag）。
  最小化窗口实测会让 `Page.captureScreenshot` 超时，所以后台取数用正常态、不主动抢焦点的自有窗口，
  **不承诺**操作系统层面完全不可见。
- **未验证 / 未承诺**：Windows 浏览器运行时未实跑（仅交叉编译通过）；真实房源站点在线验收与 Safari /
  Firefox（无法用 CDP 驱动）未覆盖；最终 `make plugin-check` 在本次记录时尚未运行。
- **协议**：`WORKBENCH_PROTOCOL` 40 → 41 → 42（选择 / 评估语义、详情取证与后台浏览器输出语义变化）；
  冻结操作清单不变（54）。

### 历史材料

- 新增源仓评审快照 `docs/superpowers/reviews/2026-10-16-valuation-workflow-live-findings.md`
  （八份实读正文标题 + sha256、源码 vs 实读更正、仍存在的限制）；它只作历史证据，不是现行指令。

### 清理（分支清理行动）

- 移除仅测试消费的估值 `SingleSelect` 兼容包装与三个测试专用 barrel（`browser/index.ts` /
  `intake/index.ts` / `market/index.ts`），测试改读真实 owning modules；估值操作清单改由
  `modules/report-evaluation/api.ts` 的 `VALUATION_OPERATION_OF` 提供，冻结操作对账合并两份清单。
- 移除无生产调用的 `scripts/market_rules.py` / `scripts/test_market_rules.py` 与 `Makefile` 配方；
  边界与取整断言迁入 `test_calculate_market.py`，`calculate_market.py` 去掉空 import。
- 清理 `ValuationOpsDeps` 中未使用的 python / transport / screenshot 依赖并同步装配与夹具；
  删除 `recalculate.ts` 只做二进制文本读取的空 `if`。
- 活动 `references/06-workbook-contract.md` 只保留描述文件通道、案例证据与报告数据对账；
  旧七表住宅默认 profile 正文原文存档到 `docs/analysis/2026-10-16-branch-cleanup.md`。
  删除空 `assets/logo|fonts|icons` 占位；README 中英文来源阶梯与已登记来源对齐；修正
  `skills/README` 的迁移后源码路径。
- 新增下一阶段红基线（本轮已落地）：`test_listing_reference.py` 的 `generatedAt` 冻结回归与
  `host-skills-guard` 的 `sys.executable` + `dws` 业务来源/动态数据记录夹具。
- **挂牌参考 Tool 与 finalize**：新增 `crwu_valuation_listing_reference`
  （`src/host/tools/report-evaluation/listing-reference.ts`：固定输入、一次打包脚本、四件产物真实核验、
  只回 `partial`，走 Broker `python.script.run` 的配置运行时）；`finalize` 增加可选
  `valuationMode=listing-reference` + 参考事实，验证通过时上限 `partial`，其余既有门禁不变。
- **CLI 守卫**：`exec-cli-literal` 改为逐字面量判定（同一行的数据取值不豁免真实绑定），并新增
  `exec-cli-record` 兜住「CLI 值存进数据记录再取出执行」；直接 argv / shell / 相对 / 包内路径
  与良性 `sys.executable` + 来源数据仍按原口径。
- `Makefile` 的插件 Python 门禁纳入 `test_listing_reference.py`；Skill / workflow / 09 输出合同
  补充挂牌参考一次性交付说明。

### 0.0.47 · 2026-10-16 · refactor · 估值交付统一到 v2 报告数据，并接入规则参数与项目收口

协议 39 → 40。按 2026-10-16 审查（F1–F5）收敛估值链路：**一份交付口径、显式模板契约、真实规则参数、
项目级完成判定**，并删除已退出生产入口的旧结果链与随包住宅模板。

### 变更

- **v2 交付唯一口径**：`build_report_data.py` 新增只读 `--validate <估值报告数据.json>`；
  `crwu_valuation_artifact_validate` 用它校验报告数据，并把脚本真正加载的
  `schemas/valuation-report-data.schema.json` 一起落到案例内。旧 `估值结果.json`、
  `validate_result.py`、旧结果 Schema / 模板 / 样例与 `build_report.py` 的 `--result` 分支全部移除。
- **通用工作簿通道**：`build_workbook.py` 的 `--template` 改为必填，契约取 `--contract` 或紧邻
  `<模板>.contract.json`；生成前清空全部声明的输入位（模板样例不泄漏），写未知 / 公式 / 结果位或
  输入区公式一律拒绝且不产出。产物写出自己的 sidecar，只保留来源模板指纹（`sourceTemplateSha256`），
  避免真实重算保存后因产物字节变化而误拒绝；独立校验器按 sidecar 自动发现，并检查错误值、断链与
  外部公式引用。`check_workbook_contract.py` 只保留
  通用通道：没有填写说明就拒绝，不再回退内置七表 profile；随包住宅模板与生成器、旧模板索引一并删除。
- **规则参数接入**：`crwu_valuation_knowledge_materialize` 新增可选 `stage=parameters`，在已验真的
  已落盘正文上解析结构化规则段，返回并持久化 **Host 绑定**的 `ruleParameters`（routeId /
  snapshotDigest 由 Host 事实绑定；片段可省略、显式不符仍拒绝）。缺段 / 多段 / 不安全 / 摘要不符
  只形成 capability gap 与空参数集，不阻断普通 Wiki 读取，也不补默认值。
  参数解析前重新核对落盘正文摘要；同批存在不安全或无效规则时整批拒绝，不挑选其中的有效部分。
- **项目级收口**：`crwu_valuation_finalize` 新增 `target=plan|project` 与 `projectSummary` 判别输出。
  `target=project` 由登记的父会话读取权威项目索引，逐方案独立核对后汇总，被阻断 / 部分完成的方案
  不计入合计，并落盘 `项目估值完成回执.json`；外方案 / 不安全 id / 项目或摘要不符 / 子会话一律
  fail closed。未登记父会话时同样拒绝；逐方案房地路径只取自项目索引，不接受调用方覆盖。
  方案目标的 revision 隔离不变。



估值面板从"进入 → 填写 → 选择 → 查看辅助状态 → 确认交接"整条链路重做：两个必填项紧跟资料区、
资产类型与评估方法改用同一种 select-only combobox、信息获取辅助区变轻、确认抽屉重排成
"摘要 → 补充条件 → 资料 → 未纳入 → 辅助"，并且估值页终于和审核页共用**同一张工作纸**。
不新增跨进程字段：资产类型与方法仍然沿协议 39 的线协议，宿主侧校验原样保留。

### 变更

- **估值底栏改成可见的固定带，并收口到工作纸的边上**（2026-10-16 用户口径，两轮）：底栏仍是
  `flex:none` 的 footer，但把透明底换成 `--crwu-surface-subtle` + 通栏 1px `--crwu-border`
  顶线（内缩 `::before` 发丝线随之删除）；估值页的工作纸改为 `padding: 0`，内缩由正文与底栏
  各自承担，灰带因此铺满纸的左右下三边，不再在下方留一条白线。第一轮试过的**负外边距通栏
  已回退**：工作纸横向内距本来就是 0，负向会把底栏撑到纸外（比纸宽 24px + 12px 纵向溢出）。
  底色只走主题 token，深浅两套仍由 `tokens.ts` 负责，正文滚动区保持透明。
- **两个必填项贯穿状态 / 预览 / 交接**：客户端草稿的方法改成明确空态（`'' | ValuationMethod`），
  `auto` 不再当默认值；`setMethod` 校验真实枚举（空串 = 清回未选，未知枚举被拒）；
  `prepareReady` 新增两道校验 —— Host 回包缺/非法资产类型或方法、或**回显与本次提交不一致**时
  返回**可恢复错误并留在草稿**（不再拿草稿里的旧方法冒充本次 Host 结论）。
- **必填项的可见性**：资产类型与评估方法排在资料区**正下方**、所有可选条件与辅助能力之前；
  容器 ≥560px 并排等宽，更窄纵向堆叠。字段有统一必填标记（星号 + 读屏"必填"）、
  真实 `aria-labelledby` 关联；错误只在**失焦**或**清空已填值**之后就地出现短句
  （初次进入不是满屏红字），底栏仍用 `aria-describedby` 说明不能点的原因。
- **同一种单选下拉**：新增 `SingleSelect`（`role=combobox` + `listbox`/`option`、
  `aria-expanded`/`aria-controls`/`aria-activedescendant`）。浮层 `position: fixed` 按触发元素
  rect 摆位（本仓没有 react-dom，这是 portal 的等价实现），并补上审核页浮层没有处理的一件事：
  `.crwu-valuation` 带 `container-type` 会建立**固定定位的包含块**，所以定位先找最近的那个包含块
  再换算坐标。贴底翻转、靠右夹取、限高滚动、外部点击 / Escape / Tab / 滚动 / resize 全部处理，
  关闭先播 100–120ms 淡出再卸载，减少动画时立即完成。
- **文件区整理**：文件夹展开 / 收起是真的（旧条件让有文件的目录永远展开，箭头点了没用）；
  子列表只在展开时渲染，被收起的后代不再落在键盘顺序里。主清单保持紧凑行 + 目录摘要。
- **信息获取辅助**：对外名字从「案例来源」统一为**「信息获取辅助」**，旁边轻标「可选」，
  说明固定为"用于辅助获取公开信息；未登录可继续估值。"。常态是一条紧凑摘要行
  （名称 / 短结论 / 该做的动作），详细原因、检查时刻与登录任务说明按需展开；
  未登录时补一句"未登录时将使用房天下、58 同城补充信息"。**辅助区不再拿整页 `error` 当自己的失败**。
- **确认抽屉重组**：首屏是「本轮估值」摘要（资产类型 / 评估方法 / 资料份数 / 基准日，两列键值），
  方法说明**与本次选择相符**（删掉"当前支持住宅市场法 / 收益法、成本法尚未提供完整知识与模板"
  两句旧限制文案）；补充条件把未指定的必要影响合并成一条；资料主行紧凑、完整路径 / 创建时间 /
  重复说明按需展开；未纳入项默认只给数量。抽屉里的资产类型与方法**只认 Host 回包**
  （不再接收一份会漂移的草稿方法）。抽屉里明确给出信息获取辅助区（登录 / 检查 / 验证是允许的
  环境操作），旧约束"抽屉里一个能力都不许出现"作废。
- **一层工作纸**：`WorkbenchPanel` 把估值页也放进 `.crwu-audit-page-paper`，估值工作面自己不再画框
  （否则就是双层描边），分区改由 16–24px 留白 + 发丝线表达。控件统一 40px 高 / 10px 圆角 /
  12px 水平内距 / 浅中性填充，并新增 `--crwu-valuation-field-border-hover`（浅深各一份）。
- **用词一致**：主操作从「确认」改成**「核对资料」**（准备中「正在准备…」），抽屉主操作仍是
  「开始估值」（创建中「正在创建会话…」），链路里不再混用多个同义的"确认 / 提交"。
- **复制路径的短反馈会恢复**：约 1.5 秒后就地消失并清理计时器（旧实现一旦成功就不再消失）；
  失败给真实可执行的提示。
- **交接成功不再留成功页**：`uiWorkspace.openSession` 已经把主面板切到会话，页面随即
  `resetAfterHandoff` 回到**新草稿**（只留一条中性的「最近创建的估值会话」入口），不再停在
  "估值会话已创建，正在打开…"那张没有可做之事的死页上；最近会话入口改用 `recentSessionId`
  （新一轮的 `parentSessionId` 已经清空，旧实现点它会报"没有子会话 id"）。
  自动打开**失败**时仍然保留恢复页（「打开估值会话」只重新导航、不再创建）。

### 0.0.45 · 2026-10-15 · feat · 通用估值入口 + 登录改为可选能力（协议 39）

估值从"房地产二级页 + 登录门禁"改成**通用页面 + 可选登录**：进页面直接是草稿，资产类型由用户
在下拉里主动选；链家未登录不再拦任何事，父会话拿到逐来源的策略与原因后按知识库的降级策略继续。
跨进程事实一起升到协议 39（冻结输入 Schema 升到 `crwu.valuation.input.v3`）。

### 变更（协议 39）

- **页面阶段删掉门禁**：`ValuationPagePhase` 去掉 `checking-auth` / `auth-blocked`。进页面就是
  `draft`、**不做任何来源探测**；能力状态改在页面下方的**能力区**与确认抽屉打开时各自更新一次。
- **资产类型（`assetType`）**进 `valuation-intake` 入参/应答、`估值输入.json`、项目记录与输入摘要。
  它是装配哪个 Skill / 哪份入口 Wiki 的唯一依据；**未选由 Host 直接拒绝预览** —— 不存在
  "默认房地产"这一档。初始为空、选择用稳定业务标识，显示文案不承担路由。
- **四种方法全部开放**：自动判断 / 市场法 / 收益法 / 成本法都不再在界面上禁用。旧实现把后两种画成
  "暂未开放"，那是**知识侧**的事实，不该让 UI 跟着发版；缺正文/参数/模板/能力一律记能力缺口。
- **登录改成可选用能力**：`sites.ts` 删除"空必需集 = 全部必需"的回退（配置里链家改为可选）；
  `decidePhase` 三类结论都 `canProceed: true`；`gateFromStatuses` 的结论带 `checkedAt`
  （检查时刻），`released` 退化为兼容字段，不再参与任何禁用判据。
- **能力区取代门禁屏**：`ValuationAuthGate` → `ValuationCapabilityArea`（类名不变，供样式与真机
  脚本继续选择）。未登录给登录入口、unknown 只给"重新检查"、被挑战只给"打开验证窗口" —— 三种
  处置仍然分开，但都不再阻止填写与启动。
- **来源策略随交接交给父会话**：`HandoffDeps.sources` 由站点清单 + 必需/可选分档推出，
  **不再是固定空数组**；清单读不出来时给一条说明原因的事实，而不是"一个来源都没有"。
  交接固定指令新增"资产类型"与"来源策略"两段。
- **业务判据搬回知识库**：指令不再复制选法顺序、可比性三条件、挂牌/成交口径、来源优先级与页数
  上限（那些的唯一维护位置是本轮知识正文）。知识取用改为"先读资产 Skill 声明的**入口 Wiki**，
  再按它的条件逐篇读正文"，并明说**不许**读 `_manifest.json` / 旧内置正文 / 未验证的本机导出。
  计算底稿一节改为"按模板自己的填写说明"，不再假定七张固定工作表。
- **库内相对链接可解析**：新增 `knowledge/wiki-links.ts`（纯函数），把正文里的
  `[标签](<01 房地产估值通用/01 输入与资料解释.md>)` 按**当前文档所在库内目录**解析成库内完整路径，
  外部地址 / 纯锚点 / 越界 / 绝对路径分别如实分类；`crwu_valuation_knowledge_materialize` 的每条
  正文条目因此带回 `links[]`，Agent 不必先取得全部节点 ID 就能按 Wiki 的导航逐篇往下读。

- **多方法与真实计算口径（协议 39 续）**：
  - `coverage.ts` 删掉「仅住宅 + 市场法」的覆盖门禁 —— 物业类型是**业务分类**（知识判定），
    方法能不能跑是**能力事实**（逐方法给出 `methodCapabilities`，可执行性与能力 ID 一起报）。
    结构性阻断只剩两条：房地权益边界未解、房地分别评估缺组件能力。
  - `methods.ts` 的 `auto` 不再恒取"第一个可执行方法"：**凡知识判定适用且当前能跑的方法全部采用**
    （单一或组合）；业务适用但跑不了的方法只记 `capabilityGaps` 与 `notes`，**不误伤**其他方法；
    只有"一个都跑不了"才整体阻断（`valuation.method.none-executable`）。
  - `task-graph.ts` 的 `combined` 改为**每个采用方法一个任务**（不再只按 `primaryMethod` 建）。
  - `valuation-result.schema.json` 新增 `methods[]`（唯一权威，`methods[0]` = `method`）、
    `methodResults[]`（逐方法依据 / 参数 / 案例 / 模板 / 结果 / 限制）与
    `methodCoordination`（`single` / `primary-secondary` / `cross-check` / `component-sum` +
    结论 + 依据 + 权重）；`validate_result.py` 逐条校验：screening 的 adopted 集合必须与
    `methods` 一致、每个采用方法都要有记录、多方法不许 `single`、加权必须有理由、
    `component-sum` 必须在依据里点名互斥组件。
  - `build_report_data.py` / `build_report.py` / `valuation-report.html`：报告数据新增
    `methods` 与 `methodResults`（金额为十进制逐字文本），报告新增**逐方法结果**表，
    组合方法时明确印出"不相加、不默认平均"；旧结果（协议 38 及更早）从顶层字段合成一条记录，
    历史案例仍可渲染。

- **知识入口配置：`wikiPath` 上线，`manifestPath` 标为遗留**：`valuation.knowledge` 新增
  `wikiPath`（默认 `01 估值与测算/01 房地产/wiki.md`，与技能 `references/knowledge-routing.md`
  声明的入口逐字一致，校验口径与 `sitesFile` 同构）。`crwu_valuation_knowledge_materialize`
  的结果新增 `entryWikiPath`，并在**仍走 manifest 槽位寻址**时带一条迁移提示
  （不是错误、不阻断）——"只回报可用槽位"的那一轮不产生提示。旧键 `manifestPath` 继续可读，
  只为盘上的旧配置与旧案例，配置注释与 README 都写明新部署不要再配它。

- **来源阶梯与检索预算（协议 39 续）**：
  - **新增 58 同城（`wuba`）适配器**：站点定义（检索 / 预检 / 登录 URL）+ 来源枚举 + 展示名，
    并新增 `ProviderSite.evidence`（`archived-capture` / `public-pattern`）与 `evidenceNote`：
    链家是**归档真实字节**，房天下 / 安居客 / 58 同城只有**公开路径约定**。
    依据随结果（`providers[].evidence`）与交接指令一起交出；`public-pattern` 的来源本轮
    **必须**带一条"尚未真机验收"的能力缺口，0 命中 / 解析失败都按缺口处置 ——
    不因为"枚举里有它"就声称这个来源已经可用。
  - **Host 持久检索预算**（`market/budget.ts` + 方案目录里的 `取数预算.json`）：
    同组同轮每来源 **10 页 / 20 条**，任一触顶即停。预算的键只有「项目 / 方案 / 分组 / 轮次 / 来源」
    —— **没有关键字、没有页码、没有尝试次数**，所以换词、换筛选、重复调用、验证码恢复都不重置；
    同源重复条目按来源内身份去重，**不重复计**候选。工具新增 `group` / `round` 入参，
    输出新增逐来源 `budget`（`pagesUsed` / `candidatesUsed` / 上限 / `stoppedBy` / 原因）。
    单次调用的页数硬夹由 5 提到 **10**（累计口径由预算回答），`maxPages` 缺省仍是 1 页
    （翻页是"再调一次工具"的决定，不是一次调用把配额吃满）。
  - **各来源独立解析地区**：城市解析状态拆成 `resolved` / **`not-covered`（该来源不覆盖）** /
    `invalid` / `unavailable`。链家公布的城市列表里没有这个城市 = **该来源不覆盖**，
    只影响链家一家并触发替代来源；其他来源记"城市表尚未适配"的**能力缺口**
    （不是"不覆盖"）。整轮不再因为一个来源不覆盖就把输入判成非法，也不擅自换城市。

- **真实重算接成生产调用点 + 可证伪判据（协议 39 续）**：
  - 新增配置 `valuation.recalculation.enginePath`（**绝对路径**；默认空串 = 本部署没有表格计算程序）。
    仓库不随包发布 LibreOffice / Excel，所以它只能由部署显式指定；**不扫 PATH、不猜安装位置**
    （算出来的数与"没人算过"一样不可信）。新增 `delivery/recalculation-engine.ts` 做**只读探测**
    （只回程序名，不回绝对路径）。
  - `finalize` 的读者新增 `recalcProviders`，`collectPlanFinalizeFacts` 把**真实探测结果**交给
    `recalculationOf`：本机探测不到任何表格计算程序时，任何声称 `recalculated` + `verified` 的
    `重算结论.json`（它落在方案目录里、模型写得到）一律判 `failed` + `verified: false`，
    报告只能 `partial`。调用方不给探测结果时保持原判据（不假装做过探测）。

- **候选稳定编号 + 修订版本（协议 39 续）**：
  - 新增 `market/candidates.ts`（纯函数）：候选按**身份**（小区 / 面积 / 价格，退 URL）分配编号，
    **只增不重用**；跨轮次、跨关键字沿用旧号；这一轮没出现的标 `retired` 并保留编号。
    落盘在方案目录的 `候选案例.json`，指纹（编号 + 身份）进修订记录。
  - 新增 `delivery/revision.ts`（纯函数）：修订索引（`修订记录.json`）记父版本、变更原因、
    采用编号、候选册 / 知识 / 模板指纹、检索轮次与规则版本。**新版本一出生是 `pending`，
    不动当前指针**；重复提交（同父版本 + 同原因 + 同编号 + 同候选册）幂等；
    失败的版本占号但标 `failed`（回滚：指针留在上一版）；提升必须带**本版**的核对回执，
    上一版转 `superseded` 并保留。
  - 新增 Tool `crwu_valuation_revision`（`op=candidates|list|recompute|promote`）：
    编号登记、修订建档、提升；`promote` 对**那一版自己的交付件**跑 Host 的完成判定
    （新增 `planFilePath(planId, name, revision)`，交付件按 `修订/<n>/` 隔离），
    没过就把该版标失败并给出问题清单。
  - `crwu_valuation_artifact_validate` / `crwu_valuation_finalize` 新增 `revision` 入参，
    可以核对指定版本的交付件；估值的固定指令新增「少案例与用户复算」一段，
    写明按编号选例、建新版本、**旧版一律保留**。

- **模板契约改由模板自己的填写说明驱动（协议 39 续）**：
  - `check_workbook_contract.py` 新增**通用通道**：`--contract <descriptor.json>`，或自动发现
    工作簿旁边的 `<workbook>.contract.json`。描述文件声明表与角色（input / formula / result）、
    `inputCells` / `resultCells` / `unitCells` / `emptyAllowedCells`、`orderMatters`、
    `templateSha256`。通用校验只查真正通用的正确性：可见表、无外部链接、无错误值、
    **输入位不许是公式**（受控写入）、**结果位必须有公式或数值**（空着就是缺口）、
    `formula` 角色的表必须真的有公式、允许为空的格子不许填 `0`、单位必须一致、
    模板字节指纹必须与实际一致。**不**假定表数量、表顺序、业务公式或任何业务阈值。
    没写描述文件时按内置的「住宅七表 profile」校验并在输出里说明走的是哪条通道。
  - `build_workbook.py` 的**输入区判定**同样支持契约：有描述文件按 `inputCells` / `resultCells`，
    没有才退回填充色约定；两条通道都**不覆盖公式**（公式保护不依赖声明），
    输入位仍拒写公式，空值仍写空而不写 `0`。模板验真也按同一条通道走。
  - 新增 14 条 Python 回归（`GenericWorkbookContractTest` / `BuildWorkbookContractTest`）：
    用一份**三张表、无填充色、无业务公式**的合成模板证明"换模板就要改脚本"已不成立，
    同时逐条证明通用校验该抓的仍然抓得住。

- **真实重算执行与回读接通（协议 39 续）**：
  - 新增 Broker 操作 `system.valuation-recalculation.run`（提权 shell，来源限 `audit-tool`）：
    Excel / LibreOffice **不随本仓发布**，可执行文件在工作空间之外，受限沙箱里起不来。
    命令由 `engineCommandOf()` 拼（配置里的引擎路径 + 固定参数 + 两个 Host 推出的绝对路径），
    模型提交不了引擎路径、也提交不了任意命令。
  - `recalculation-engine.ts` 新增 `runConfiguredEngine()`：① 引擎把工作簿**转换一次**
    （打开即重算，产物落在临时目录，原底稿一个字节不动）；② 用 `read_workbook_values.py`
    以 `data_only=True` 回读**缓存值**。两步各自走命名操作，任一步失败或数值对不上都是
    `verified: false`。
  - 新增技能脚本 `scripts/read_workbook_values.py`：读缓存值、**读不到就是 `null`**，
    "公式在但缓存空"单独报成"这份文件没有被真正打开重算过"（不等于"这一项为空"）。
    新增 5 条 Python 回归。
  - 新增 Tool `crwu_valuation_recalculate`：由 **Host 自己**跑引擎、回读、比对并写
    `重算结论.json`（`producedBy: 'host'`）。期望值取自 `估值报告数据.json`（调用方提交不了），
    数值位置由调用方按模板自己的填写说明提交（Host 不猜格子）。没有配置引擎时写
    `unavailable` 并说明只能交付 `partial` —— 模型写不出"重算通过"。

- **manifest 链路退出主通道：按入口 Wiki 的相对链接读取（协议 39 续）**：
  - `crwu_valuation_knowledge_materialize` 新增 **`wikiPaths`**（**主通道**）：库内相对路径清单，
    来自入口 Wiki 正文里的链接（或上一轮返回的 `links[].target`）。入口 Wiki 自己也通过它读取。
    `routeIds`（manifest 槽位）降为**遗留通道**，取正文时会在 `warnings` 里说明该迁移。
  - 取数层：`wikiPaths` 存在时**不要求 manifest 可读** —— manifest 读不到只是"没有槽位清单可回报"，
    不再是把整轮业务卡死的唯一真停（同时给了 `routeIds` 与 `wikiPaths` 时两条都取并如实说明）。
    新增 `wikiRouteFromPath()`：由库内路径推路由（`wiki:<路径>`）与形态（按后缀分文本 / 二进制），
    绝对路径 / `..` / 未知后缀一律**拒绝**，不做前缀或模糊匹配。
  - 落盘段名安全化（`snapshotFileFor`）：Wiki 路径的路由 id 含 `/`，直接拼进落盘路径会散成一串
    嵌套目录；槽位路由不含非法字符，落盘形状与从前逐字一致。
  - `KnowledgeManifest` 新增 `wikiPaths` 与 `warnings`（进汇总快照与模型可见结果）。
    新增 5 条取数层回归 + 1 条工具接线回归。

- **候选的批量筛选与优选（协议 39 续）**：新增 `market/select.ts`（纯函数）与
  `crwu_valuation_market_search` 的 `selection` 入参。规则（`maxAdopted` 名额 / `order` 优先级 /
  `sourceOrder` 渠道顺序）**全部来自本轮知识正文**：缺任何一项就拒绝，代码里没有默认名额、
  没有默认优先级（"惯例 3"不许出现在代码里）。这一层只做机械的三件事：
  **硬性排除**（挂牌 / 询价、无页面证据 —— 业务合同，不是阈值）、
  **确定性排序**（逐级比较 + URL 兜底；同一批输入必给同一批入选，这是稳定编号的前提）、
  **名额截断**（落选理由具体到名次与名额，并说明它仍可按编号纳入重算）。
  筛选**不改变** `cases`：相近未达标的候选照旧列给用户按编号选。新增 8 条纯函数回归 + 1 条工具接线回归。

- **各来源独立解析地区（协议 39 续）**：新增 `market/city-sources.ts`：**逐来源登记城市表**
  （来源页 / 城市标识进 URL 的方式 `subdomain|query` / 依据 `archived-capture|public-pattern` /
  是否已适配 `adapted`）。判定改为查这张表，而不是把链家公布的列表当成所有来源的映射：
  **只有自己那份表已适配**的来源才可能得到「该来源不覆盖这个地区」（目前只有链家，依据是
  2026-10-13 归档的真实城市列表页）；其余三家（安居客 / 58 同城 / 房天下）如实报
  **"城市表尚未适配"的能力缺口**，并明确写出**不是**"该来源不覆盖这个地区" ——
  两者混同会让员工以为某家不做这个地区，从此不再尝试它。
  逐来源结论新增 `citySourcePage` / `citySourceEvidence`，报告能说明"这个城市标识是哪来的"。
  新增 5 条回归（登记表自洽性、解析成功的来源依据、不覆盖 vs 未适配、未登记来源、非法输入）。

- **少案例：参考结论而不是清空金额（协议 39 续）**：`calculate_market.py` 原先在
  "可采用案例少于知识要求"时把 `unitPrice` / `totalValue` 清成 `null`，这与设计稿 §6.1
  （"1～2 条达标且有计算依据时仍给参考结论…不因数量少直接把所有金额清空"）相抵。
  现在只有**一条可用依据都没有**时才不给金额并写清原因；数量不足时照常计算，并给出
  `provisional: true` + `provisionalReason`（差几条、不得作为正式结论交付）、
  把缺额记进 `ruleChecks`（`market.comparables.min-adopted` 没过），限制段保留。
  同时补上"案例单价必须为正"的校验：`0` 既不是"缺失"也不是价格，放它过去会得到一个
  0 元的"比准价格"，而那看起来像个正常的中间结果。
  **`test_calculate_market.py`（生产计算入口的 17 条契约）此前不在门禁里**，现已加进 `make plugin-check`。

- **门禁修复：`make plugin-check` 在干净机器上通过（协议 39 续）**。
  `kb_tool.py validate` 的引用卫生检查把 `~/.crwu/knowledge`（crwu-dws 的**运行时缓存根**，
  由技能在 M1/M3 阶段创建、不随包发布）报成"路径不存在"。相邻的 `dws-dir-cache` 早已被单独豁免，
  父目录却漏了 —— 同一条纪律没贯彻，结果是**一份刚安装、还没跑过审核的技能副本判自己不合格**。
  现在豁免覆盖缓存根与**已登记的缓存层**；正文不缓存，所以
  `~/.crwu/knowledge/<别的>/x.md`（把正文当本地文件引用）仍然照拦。新增 2 条回归。

### 文档与验证

- 新增 [`docs/acceptance-0.0.45.md`](docs/acceptance-0.0.45.md)：协议 39 的验收点与强制点，
  并在末节**如实列出尚未完成的真实能力**（58 适配器、各来源独立地区解析、检索预算与跨站优选、
  多方法执行与协调、模板真实重算回读、会话内复算与新版 revision）。
- `0.0.42` / `0.0.43` 两份矩阵里被这一代改判的行按仓库口径标 `⟪协议39改判作废⟫`，原文保留。
- `install/browser-check.mjs` 的真机断言同步改成"估值无二级目录 / 资产类型空态 / 能力区在输入
  工作面里 / 收益法与成本法不再禁用"。

### 未完成（不得冒充已实现）

- **58 同城 provider 未实现**：只有链家 / 房天下 / 安居客三家；"未登录改用房天下与 58"里的 58
  一条是**能力缺口**。
- **检索预算（同组同轮 10 页 / 20 条、触顶即停）与跨站优选 3 条**尚未在 Host 落持久预算。
- **多方法编排**：`coverage.ts` / `methods.ts` / `task-graph.ts` 仍只支持住宅 + 市场法，
  auto 仍取第一个可执行方法，结果 Schema 仍要求恰好一个 adopted。
- **真实重算**：`delivery/recalculation.ts` 仍只有接口与核对逻辑，没有生产调用点；完成判定上限
  仍是 `partial`。
- **会话内复算与新版 revision**：未实现。
- **知识正文发布**：本版只改插件；Wiki 入口与各方法正文由业务负责人在知识库侧粘贴发布。

### 0.0.44 · 2026-10-14 · fix · 房地产启动页：流程恢复闭环 + 资料范围闭环（协议 37）

0.0.43 把估值改成"启动页 → 父会话"之后，页面在**流程恢复**与**资料范围**上还有一批会被员工
直接撞到的问题：点下「开始估值」原操作界面就消失、被人机验证挡住时没有任何入口、切走再回来
可能永久卡在"正在检查"、失败屏的「返回修改」点不动、文件夹只能看到一个份数、单个文件移不掉。
这一版按设计稿 §19 分阶段修完，并把跨进程事实一起升级到协议 37。

### P0：流程恢复与状态正确性（UX-01 ~ UX-07、UX-17）

- **创建期间**：`creating-session` 与 `confirmation` 共用**同一个抽屉实例**，主按钮原地变成
  「正在创建会话…」；X / Escape / 遮罩 / 返回修改四条关闭路径一起失效并说明原因
  （旧行为：点下去抽屉消失，pending 反馈看不到）。
- **验证窗口**：新增受控 Host 操作 `valuation-browser-open-verification`，门禁在检测到人机验证时
  给「打开验证窗口」；Client **只提交 `siteId`**，URL 与浏览器 profile 都由 Host 从可信站点清单取。
  配套新增 CLI 子命令 `crwu browser open`（复用同一个 profile 打开受保护页、立即返回、不关窗口）。
- **`waiting-user` 不再被归一成 `running`**：登录任务按**五种**状态呈现（各自的动作也不同），
  wire 词表补上 `waiting-user`；未知状态落到 `failed` 而不是"永远在登录"。
- **错误可见**：登录 / 取消登录失败、整体检查失败都贴在所属区域（`role="alert"`），
  不再出现"点了没反应、也没有一句话"。
- **切页恢复**：离开页面时除了作废在途请求，还**清理这一次页面请求的瞬时状态** ——
  检查中 → 可重查、准备中 → 可编辑草稿；回来按阶段恢复而不是永久卡住。
  交接（`creating-session`）**不**清理：会话是 Host 的事务，切走不能中断它。
- **交接失败按权威事实分三类**：`valuation-start` 的应答新增 `creationDisposition`
  （`not-created` / `created` / `unknown`）。只有 Host 明确说"没有创建"才允许「返回修改」；
  结果未知时只提供「恢复交接」并复用同一轮请求 —— 旧行为拿"没有 sessionId"当"没建会话"，
  会让同一批资料交接成第二个项目目录。
- **失败标题来自结构化事实**（"未能创建估值会话" / "会话已创建，交接尚未完成" / "尚未确认会话是否创建"），
  删掉那句与事实矛盾的泛化阶段话。
- **长等待有话说**：门禁 60s / 准备 120s / 创建 180s 的页面等待上限，15 秒给
  "用时较长 + 现在能做什么"；创建超时**不等于**未创建（判据保持 `unknown`）。

### P1：资料范围闭环（UX-08、UX-09、UX-14）

- `valuation-files-scan` 的应答从"只有入口 `items[]`"扩成**入口 + 真实文件 `files[]` + `skipped[]`
  + `truncated`**；两条资料操作都新增 `excluded[]`，**扫描 / 预览 / 归档共用同一份排除范围**
  （只过滤 UI 列表的"假排除"被彻底断掉）。
- 输入页改成两层：入口行（文件夹可展开、带 `aria-expanded` 与实际文件组关联）+ 真实文件行
  （类型图标、大小、状态、逐个移除）。文件状态按完整映射呈现（已纳入 / 已跳过 / 无法读取 /
  超过单次上限 / 已从本次范围移除 / 读取清单中 / 状态待确认），未知大小说"大小待确认"、不编 0 B。
- **移除可撤销**：反馈在资料区下方保留 8 秒，以最近一次移除为单位；移除文件夹会一起清理
  只属于它的排除项。被移除的文件仍然**看得见**并可「重新纳入」。
- **重新读取清单**：扫描失败给真实的 `rescan`；枚举被安全上限截断时明确说"清单未完整读取"
  并禁止确认（不把截断数量当全部数量）。

### P2：视觉、可访问性与动效（UX-10 ~ UX-13、UX-15、UX-16、UX-18）

- **唯一 primary 真的成立**：主按钮改用 `--crwu-primary-bg` / `--crwu-primary-text` 实心 token
  （旧版只有描边，视觉层级根本没建立）。
- **命中区**：图标按钮改成 **44×44 的独立按钮槽**（里面是 28px 视觉盒），普通按钮纵向外扩到
  ≥44px 高。为什么不用负向 `::after` 外扩：外扩会真的增加滚动容器的 `scrollWidth`，
  375px 窄面板实测正文多出 8px 横向滚动（真实浏览器复现后改成按钮槽）。
- **对比度**：新增两个只在估值模块使用的语义槽 `--crwu-valuation-field-border`（浅 / 深两套）
  与 `--crwu-valuation-hint-text`；必要说明、路径、跳过原因不再用 tertiary 承载。
- **只读核对抽屉**：方法从"一排 disabled radio"改成 `<dl>` 键值摘要（那排东西看起来像一个
  不能用的表单）；条件摘要放在清单**前面**；创建时间标注 UTC；路径可复制；补充要求 `pre-wrap`
  保留换行；未纳入项单独列出。
- **表单展示记忆**：抽屉打开期间输入工作面**隐藏但保留在 DOM 里**（旧行为是卸载），
  于是展开状态、查看全部状态、滚动位置与焦点锚点都不丢；焦点回到**同一个**「确认」按钮。
- **抽屉呈现生命周期**：父层自己管 `presented` / `closing`，退出动画（150ms）播完才卸载；
  退出期间继续显示同一份内容；`prefers-reduced-motion` 下立即卸载（不变成"多等 150ms"）。
- **补充要求**：不再用 `maxLength` 静默截断；超限写进 `promptOverLimit` 并说明，已有内容保留；
  中文输入法 composition 期间不应用上限（不把半个合成串报错）；接近上限提示剩余数量。
- **基准日**：只接受**真实存在**的日历日期（`2026-02-30` 会被拒绝，不做溢出归一），
  已填时可「清除日期」，空 / 满两种帮助各一句。
- **准备中补真实返回动作**：底栏在 `preparing-confirmation` 给出真的「返回修改」，
  并说明"正在归档所选资料、原输入已保留"。
- **页头只留标题（用户 2026-10-14 口径）**：删掉"把估值资料交给 AI，确认一遍输入之后它会自动完成
  测算与交付。"与"确认之后不再逐步问你：…"两句产品介绍；抬头只写「房地产估值」。
- **底部操作栏的视觉（同上）**：给它一层轻底（`--crwu-surface-subtle`）+ 顶部发丝线，
  左侧摘要与禁用原因统一走"说明与元信息"那一档（12px / 次级色），高度压在 52px
  （= 36px 主按钮 + 上下各 8px，设计稿 §6.4 的下限）—— 在纸面上只剩一根孤零零横线的
  样子看起来像没画完。
- **文字与按钮离底栏边框有距离（用户 2026-10-14 第二轮口径）**：底栏底色**通栏**到正文列之外，
  内容按同一个内缩量（`--crwu-valuation-inset`，12px）退回来 —— 于是"离边框有距离"与
  "与上方正文左对齐"同时成立（正文列也内缩同一个量）。
- **底部操作栏改成真正的 footer（用户真机截图反馈后重做）**：原先用
  `position: sticky; bottom: 0`，而 sticky 会把底栏**拉到自己流入位置之上**，
  于是它盖住当时视口底部的内容（截图里"补充要求"的输入框从底栏下面露出来）。
  现在工作面是**确定高度的 flex 列**：中间正文 `flex:1; min-height:0; overflow:auto`、
  底栏 `flex:none`，两者不重叠；挂载容器与工作面都接上高度。
  同时把底栏左侧收成**一行**（可用时"下一步做什么"、禁用时"为什么不能点"，
  不再用摘要 + 原因把同一句话说两遍），并让**禁用的主按钮退回中性底** ——
  深色下把浅色实心按钮整体降透明度，一屏最显眼的反而成了点不动的那颗。
- **动效**：新文件行 opacity + 4px 位移入场（160ms）、文件夹展开箭头 rotate（140ms）、
  抽屉 200ms 进 / 150ms 出；全部不碰 `width` / `height`，减少动画模式下全部关掉。
- **响应式**：容器查询覆盖 ≥900 / 560–899 / 400–559 / <400px 四档；窄面板（<600px 视口）
  抽屉成为整宽面板；窄面板下正文与可编辑控件放大到 16px、命中区 44px。
- **方法选项**：`fieldset` + `aria-label` 原生单选组语义；自动判定带「推荐」标记，
  收益法 / 成本法可见灰态并标注「暂未开放」；当前方法的说明只出现一次（去掉"当前选项"前缀）。

### 估值运行阻塞的逐项修复（P1–P18，2026-10-15）

按 `docs/superpowers/reviews/2026-10-15-valuation-run-remediation-analysis.md`（同日的运行诊断快照）
逐项**先核实再修**。下面每条都写了"是否真实存在"，以及有没有修完。

- **P2/P3/P4/P5 知识接通（已修）**：业务知识库在 2026-10-14 被改过名（`02-市场法` → `02 市场法`），
  而路由表与别名还写着旧写法，实测 9 条路由有 5 条落空。现在有了**声明式身份折叠**
  （连字符↔空格、全角↔半角；大小写/编号/后缀不折叠），精确/同名/别名三个通道统一按身份键查找，
  同一身份命中多个真实节点时返回 `ambiguous` 并保留全部路径（不再"取第一份"）；
  目录路由改为**有界递归发现**（深度 ≤3 / 正文 ≤40 / 子目录 ≤200），并区分
  `found` / `empty` / `unreadable`（越界不再静默当成"没有规则"）；模板索引在 JSON 之外
  增加**受控的 Markdown 清单表适配**（表头与取值走声明词表，未登记或多值整行报 problem，
  占位标题即便写"已发布"也强制 `empty`），published-only 口径未放宽。
- **P8/P9/P11/P13 工具回执与落盘（已修）**：市场取数回执补齐 `retrievalTaskId`（按
  项目/方案/来源/页码/城市/关键字派生，跨项目不共用预算）与逐供应商恢复任务，
  输出字段与 Schema 双向对齐；页面/截图/诊断目录在**任何写入之前幂等创建**，文件错误单独分类，
  不再被当成登录或验证码问题重试；公开页 200 不再被记成 `authenticated`
  （登录状态 / 当前页可读性 / 本次检索能力三件事分开）；`needsLogin` 只表示"凭据说没登录"，
  `unknown` 与 `captcha` 各有自己的类别与动作。
- **P10 链家人机验证（已修，语义纠正）**：真机实测链家把受保护页 302 到
  `hip.lianjia.com/captcha`（title=CAPTCHA、**没有**可见验证控件）。这一类现在被识别为
  `site-challenge-page` 并报 **`waiting-user` / `challenge-page-waiting-user`**（等人，可继续），
  不再是 `unsupported`（做不了）；`challengeVisible=false` 时**结构上不可能**调用极验 v3 脚本
  （真机回执里 `strategies: []`），预算用尽后的那次回读也要过同一道核验
  （同域 + 可读 + 无可见挑战）。Host 侧 `recovered` 同样要过核验，否则降级
  `waiting-user` / `recovery-unverified`。**不提供任何自动过验证的旁路。**
- **P14/P15/P16/P17 业务前提与分类（已修，协议 38）**：评估目的与价值类型进跨进程契约
  （表单 → 只读抽屉 → 预览 → 冻结输入 → 交接摘要/固定指令 → 报告数据 → HTML），
  未指定是显式事实（`null`）且**一律不得组装 completed**；未指定基准日不再在报告数据里静默
  （强制写进 limitations）；对象新增 `registeredUse`（权证原文）与 `classificationBasis`
  （业务分类依据），依据缺失的对象**挂起**而不是默认套住宅；参数缺失区分
  `registration-gap` 与 `calculation-suspended`（空栏不填 0、不许由楼龄推土地年限）。
- **P18 项目续跑（已修，新增 Host 操作）**：新增 `valuation-project-resume`。
  插件实例重建后，用 `projectId` 由 Host 从已选工作空间派生目录，逐项核对授权收据、工作区、
  交接记录、会话归属、`估值输入.json` 字段与材料字节摘要、记录自身指纹与协议/Schema 兼容性，
  通过后把**同一条会话**的案例归属与冻结输入绑回来（不新建会话、不重发指令、不建第二套目录）；
  任何一项不符即结构化拒绝（fail-closed）。操作清单 53 → 54。
- **顺带修掉一个真实覆盖洞**：`crwu_valuation_case_bootstrap` 之前会用更旧的快照形状
  **重写 `估值输入.json`**，把规范 v2 冻结输入降级（丢评估目的/价值类型、`null` 基准日变空串）。
  现在**已存在就不重写** —— 子会话只消费这份输入。

**P1/P12/P18 的剩余接线（同日，第二轮）**：
- **P1 收口**：`ExtractedFile` 增可选 `pages` / `pageCount` / `pagesWithText` / `pagesWithoutText` /
  `capabilities` / `capabilityProbe`，提取工具回执按份给**计数 + 能力**（`pages[]` 与
  `capabilityProbe` 仍只在 `提取结果/` 的 JSON 里，避免把最多 200 行逐页表塞进摘要）。
  口径是 **"未知 = 键不存在"**：布尔只认真布尔、计数只认非负安全整数、畸形行丢掉而不是
  编一个 `true`，空表不写成 `[]`（`[]` 会被读成"每页都有文本层"）。顺带修掉一处措辞失真：
  **部分读到**的资料不再被打成"未解析："（前缀只描述这次到底解析出了什么）。
- **P12 网络事实**：探测与取数现在把**网络/DNS 事实**单列（`phase` / `errorCode` / 地址与地址类别 /
  `refusedBy`），网络失败一律留在 `unknown`，**不许**变成"没登录"或"被站点挡"；本地边界拒绝
  照旧拒绝（没有为了过测试放宽任何清单）。`ok:true` 表示网络层完成 —— 站点 403/验证码因此
  按页面分类，而不是被打成"无法访问"。本机实测（2026-10-15）：出口 `114.244.128.43`
  （北京联通、无代理），链家对**任意 UA**都 302 到 `hip.lianjia.com/captcha`。
- **P18 门面**：`valuation-project-resume` 接进 Client 门面（`WorkbenchApi` + 估值模块 API），
  两个"临时 HOST_ONLY 豁免"删除。界面上的入口仍需产品决定放在哪。

**P7 业务城市解析（同日）**：检索工具以前要求模型自己给出站点侧标识（`bj` / `beijing` 全靠猜）。
现在 `crwu_valuation_market_search` 收**业务城市**（「北京」），由适配器从站点自己公布的
**城市页**派生映射（进程内缓存、无默认 transport、失败不缓存）：中文名解析成站点标识后进 URL
模板；`bj` 这类已是标识的形状原样通过；未知/歧义/城市页读不到一律 `unresolved` + 候选
（`名称=标识`）+ 要查阅的页面，**绝不默认北京**。回执新增 `cityStatus` / `cityCode` /
`cityCandidates` / `cityPage`（Schema 同步声明）。标识收紧为单段 DNS 标签 `^[a-z]{2,10}$`
（它要进域名）。**残余风险如实记**：`beijing` 这种 ASCII 形状仍会被当标识直通（离线区分不了
`bj` 与 `beijing`）——要更严就得拿公布列表校验 ASCII 键，代价是每次都要读到城市页。

**P1 的真正瓶颈是运行时缺 PDF 文本库（同日，环境动作）**：插件实际使用的 DSH 自带 Python 3.12
原本**没有** pypdf/PyPDF2/pdfminer，所以生产里 PDF 一律只能报"没有可用的 PDF 文本读取库"，
**逐页事实也无从产生**。已把 `pypdf` 纳入运行时清单（`TRACKED_PYTHON_PACKAGES`，仍然**不是**
必需包：缺了只把那一份资料记成能力缺口，不阻断流程），并在本机运行时装上 `pypdf`
（实测：混排 PDF → `pageCount=5 / pagesWithText=2 / pagesWithoutText=3` + 页码区间缺口；
纯文本 PDF → `pages=[{index:1,hasTextLayer:true,chars:31}]`）。没有 PDF 光栅化器
（`pdftoppm/pdftocairo/mutool/gs/qpdf` 全无）也没有 OCR 引擎，这两项能力仍是 `false`，
脚本按页如实报告而不是假装读过。

**按 2026-10-13 成功那一轮的归档证据再补三条（同日）**：归档还原见
`docs/superpowers/reviews/2026-10-15-lianjia-successful-run-reconstruction.md`（逐字行号引用）。
- 链家检索模板原本少了 `rs` 段、`pg` 前少了 `/`（真正能出 54 条的是
  `…/ershoufang/rs<关键词>/pg<N>/`）；另外总价丢掉单位词「万」会静默差 **10000 倍**、
  `元/㎡` 认不出、`共N层`/多方向朝向被截断 —— 都已修，并新增解析器测试。
- **预检页改到归档实测过的城市页**（`https://bj.lianjia.com/ershoufang/`，未登录 200 /
  175263B / 30 个 `data-price`），不再用从未核对过的 `www.` host。
- **站点挑战页不再冷却重试**：成功那轮的节奏是"每 URL 只导航一次 + 列表 9s / 详情 8.5s"，
  而归档显示站点随后开始回 captcha —— 对同一个挑战页再敲一次只会让风控更紧。
  这一类现在**一次即交回人工**（不吃第二次预算、不留冷却），人工过完再用同一
  `retrievalTaskId` 继续。
- **真机诊断（2026-10-15）**：当前出口 `114.244.128.43`（北京联通 AS4808、无代理），
  与成功那天同一个 ISP、不同 IP。A/B 实测：**我们的 UA 与真实 Chrome UA 都被 302 到
  `hip.lianjia.com/captcha`（200 / 6418B）** —— 所以这次拦截**不是** UA、不是 URL 形状、
  也不是"没登录"造成的，而是站点按出口 IP 的风控。能解的路径只有"可见窗口人工过验证 →
  同一任务续跑"，或运营侧换出口/等冷却；代码侧不再做任何自动绕过。

**本轮未修（如实记缺口）**：P1（扫描 PDF 的页面渲染与 OCR：提取脚本已如实报
「PDF 无文本层，需要 OCR」「图片内容未识别」，缺的是运行时的渲染/OCR 能力本身，需要产品决策
接哪个后端）；P6/P7（用页面搜索框发现检索 URL、城市标识由站点适配器决定）；P12（房天下的
DNS/代理诊断：需要环境侧核实，不放开私网访问边界）。另有若干**业务口径待确认**：价值类型与
评估目的的可选值清单、通用/选例/参数三份知识正文由谁写（库里那三个目录目前是真实空目录）、
模板索引维护成 JSON 还是清单表。

### 登录状态检查改成"只读凭据"（用户 2026-10-14 口径）

- **不再为一次检查打开浏览器窗口**：`crwu browser status` 改成从 CLI 的持久 profile 里读
  凭据与**到期时间**（CLI 侧只在需要时起一个不显示的实例读 cookie，**不加载任何页面**）。
  以前每次进房地产页、每次重新检查都会弹出一个可见窗口并导航受保护页，员工只看到窗口一闪。
- **页面判定挪到真正需要它的地方**：新增 `--verify-page`，只在**登录窗口本来就开着**的登录链路里读
  受保护页 —— 它是区分「登录失败」与「已登录但页面要人机验证」的唯一依据（`waiting-user`）。
  因此门禁**不再**在检查阶段主动探测人机验证；挑战恢复仍在取数与登录两条链路上生效。
- **门禁直接显示有效期**：逐站人话原因现在把 CLI 报回来的到期时间带出来
  （`已登录（到期 2026-10-15 16:54）`）；客户端原先在"已登录"时清空原因，等于把有效期丢掉了。
- 只读凭据模式下**不会**杀掉员工自己开着的浏览器（只释放本进程启动的那个实例）。

### 贝壳（beike）整体下线（用户 2026-10-14 口径）

- 贝壳与链家是**同一个数据源**，产品只保留链家：站点清单、门禁必需项默认值、市场案例来源
  （`MARKET_PROVIDER_IDS` / provider 定义 / 能力清单）、Skill 资产与业务参考、界面文案、
  测试 fixture 与真机验收脚本里的贝壳全部下掉；两站并列的用例改用中性来源，**多来源覆盖不减**。
- 历史 changelog 与带日期的验收快照保留原样（它们是历史记录，不是当前行为）。

### 契约与交付形状

- `WORKBENCH_PROTOCOL` 36 → **37**；操作清单 52 → **53**
  （新增 `valuation-browser-open-verification`）。
- CLI 新增 `crwu browser open --sites <文件> [--site <id>]`（见 CLI changelog 同条目）。
- 新增真实浏览器验收（隔离 fixture，不碰真实凭据）：计算样式、对比度、容器查询、命中区几何、
  焦点与 inert、动画时长、减少动画 —— 41 条断言全部通过；
  真实 profile 的门禁 / 输入页检查同步扩展到新契约（`install/browser-check.mjs`）。
- 新增/更新单测：`client-valuation-scope.test.mjs`（30 条，含"旧行为下失败"的证明）、
  既有估值用例按新契约更新；插件门禁 2197 条全绿。

### 0.0.43 · 2026-10-14 · feat · 房地产估值改为"启动页 → 父会话"会话工作流（协议 35）

估值不再由面板轮询驱动，而是**确认即交接**：面板只负责把资料与用户输入冻结成一次预览，
创建**一个**父估值会话后自动跳转；分析、识别对象、拆分方案、判方法、取数与测算全部在父会话里完成。

- **启动页与门禁（用户可见）**：二级目录仍是「房地产」，页面写明「当前支持住宅市场法估值」；
  未登录外部来源时**只替换房地产正文**（门禁屏逐来源给出状态与登录指引），其他二级目录照常可用；
  按钮从「检查并确认」改为「**确认**」，只有唯一主操作。
- **确认抽屉只读且只显示事实**：文件名 / 类型 / 大小 / 创建日期 / **原始绝对路径** / 同名与重复内容提示，
  不再出现知识库状态、识别字段、冲突、完整 Prompt、取证能力或摘要指纹；footer 固定「返回修改 / 开始估值」。
- **删除多余页面与轮询**：估值进度页、结果页、`operations/report-evaluation/monitor.ts`
  与四条 v1 完成度操作（`valuation-status` / `valuation-result` / `valuation-open-artifact` / `valuation-cancel`）
  一并移除；操作清单 54 → 52，新增门禁三操作 `valuation-browser-preflight` / `-login` / `-login-cancel`。
- **完成判定改为显式 finalize**：`crwu_valuation_finalize` 由 Host 用真实文件核对冻结输入、
  知识快照、模板验真、逐对象结论、计算轨迹、截图证据、计算表与**重算记录**、报告渲染与产物清单；
  缺项降级 `partial` / `blocked` 并列出问题。**没有落盘的重算记录时上限就是 `partial`**。
- **知识来源收窄**：`source` 只允许 `dws` 或 `verified-mirror`（**取消 `local` 降级**）；
  按精确路径 → 同目录同名 → 显式别名 → 身份已验证镜像四级尝试并留痕；仍缺则**中断受影响方案**
  并输出说明原因的 HTML。`references/` 定位改为**技术合同与结构说明**，不再充当业务正文。
- **业务阈值离开脚本**：`market_rules.py` 删除 `SINGLE/COMBINED_FACTOR_LIMIT`、`PRICE_RATIO_LIMIT`
  与 `RULE_LIMITS`，三个判定原语的 `limit` 改为必填（缺参数报错而不是用内置值）；
  `validate_result.py` 的阈值改为 `--limits` 由本轮知识快照传入，不传则**跳过并明确告警**。
- **浏览器与人机验证**：新增 `crwu browser recover`（固定脚本 + 冷却重导航，
  同一任务 ≤2 次自动尝试 / ≤120 秒窗口，预算与冷却由程序管理）；估值链路接入
  `crwu_valuation_browser_recover`、按来源独立的取数通道与 `推理结果/图片/<caseId-名称>/` 截图证据
  （**挑战页截图永远不是案例证据**）；同一 profile 的操作严格串行。
- **交付件**：主交付为完整过程的 **HTML**（由受约束的报告数据 JSON 按固定模板渲染）与**计算工作簿**；
  新增 `项目估值方案索引.json`（项目 → 方案 → 对象 + 方法判定 + 执行任务图，含房地分别评估的
  价值范围互斥与土地能力缺失时的明确阻断）。
- **真机验收脚本**：`install/browser-check.mjs` 增加「未执行（SKIP）」档位 —— 未登录时依赖输入工作面的
  检查如实记为未执行，而不是记成通过，也不会卡在门禁上。
- **方案级交付目录（2026-10-14 补）**：方案级产物一律落 `方案/<planId>/`
  （报告数据 / 报告 / 底稿 / 模板验真 / 重算结论 / 截图清单 / 产物清单），项目级事实留在案例根。
  此前多方案共用一个目录，`finalizePlan(plan-002)` 会读到 plan-001 的报告数据并通过校验；
  逐对象结论也改为按 `plans[].objectIds` 核对，不拿全项目的对象去要求某一个方案。
  取数的 `market_search` / `market_capture` 增加 `planId`：证据与截图同样按方案隔离。
- **新增结构化 Tool（2026-10-14 补）**：`crwu_valuation_template_materialize`
  （按索引选**已发布**模板并逐字节验真，空目录 / TODO 标题 / 预留正文一律拒绝）、
  `crwu_valuation_execution_dispatch` / `crwu_valuation_execution_join`
  （按真实 Agent 状态决定有界并行或父会话顺序；单执行租约防止重复执行与"启动超时后父会话接手重算"）。
- **能力门禁落到生产取数路径（2026-10-14 补）**：`crwu_valuation_market_search` 接受
  `requiredCapabilities`（方法正文声明的能力 ID），在**任何网络请求之前**用真实注册表 / 真实适配器 /
  这一轮来源状态逐项核对；工具或适配器缺席就地阻断（一个请求都不发），"来源尚未确认登录"留给
  逐来源预检现场判定。降级能力（如 `workbook.recalculate`）缺席只记缺口。
- **链家与贝壳拆成两个独立来源（2026-10-14 补）**：`MARKET_PROVIDER_IDS` 加入 `beike`，
  各自的探测页 / 检索页 / 登录页独立；展示名从「链家 / 贝壳」拆成「链家」「贝壳」。
- **固定 DOM 解析成为真实兜底（2026-10-14 补）**：来源检索改走 `parseSitePage`
  （JSON-LD 优先、固定选择器兜底），`template-stale`（站点改版、0 命中）与 `no-results`
  （确实没有房源）分开报 —— 前者不再被读成"这个小区没有案例"。
- **登录判定改为按凭据有效性（2026-10-14 用户口径，协议 36）**：门禁此前要求"受保护页必须可读"，
  于是受保护页被人机验证挡住时，**刚刚登录成功**的员工也进不去工作面。现在 `state` 只回答
  "有没有登录"（凭据在且未过期、且不是登录墙），`verdict` 单独回答"这一页能不能读"：
  凭据有效 + 页面被挑战 → 门禁**放行**，并在正文里给一条非阻塞提示（"已登录（到期 …）；
  该来源当前要求人机验证：取数时会自动尝试恢复，必要时请在那个窗口完成验证"），
  验证交给取数流程（自动恢复 → waiting-user 断点）。逐站结论新增 `expiresAt` / `sessionCookie`，
  界面直接展示有效期。凭据**过期**或页面是**登录墙**仍然是未登录，原因里分别写明"已过期"/"已被作废"。
  门禁的自动恢复只对"还不能用凭据证明已登录"的来源发起（已登录时不再多导航一次，少给风控添压）。
- **修复：登录任务把"登录成功但页面要验证"报成失败（2026-10-14，协议 36）**：登录命令成功、
  passport 凭据已到位，但受保护页回人机验证 / 风控时，登录任务原来直接落 `failed`
  （"登录状态未通过权威检查"）—— 员工看着浏览器里的"已登录"，面板却说登录失败。现在这个组合落
  新状态 **`waiting-user`**，文案是"登录凭据已到位，但受保护页要求人机验证：请在窗口里完成验证后
  点重新检查"；**确实没登录成功**（命令失败 / 没有凭据 / 登录墙）仍然是 `failed`，两种判断不混。
- **修复：浏览器还开着却连不上（2026-10-14 真机复现）**：见 CLI changelog 同条目 —— 端口文件被
  上一次命令删掉、浏览器仍在跑时，登录后的权威 `status` 会以"无法获得浏览器会话"失败，门禁因此
  永远过不去。现由 CLI 侧的多来源端口发现 + 保留端口文件修复。
- **修复：登录检查把"已登录"报成"没有凭据"（2026-10-14 真机实测，协议 35 → 36）**：
  凭据原来用 `Network.getCookies`（不带 `urls`）读取，而 CDP 把它**限定在当前 URL**上 ——
  CLI 附着的标签页是 `about:blank` 时读到 **0 条**，附在链家页面上时只看到链家那一条。
  真实 profile 实测：`about:blank` 0 条 / 带显式 urls 28 条 / 浏览器级 66 条。现在改用
  `Storage.getCookies`（浏览器级，与附着哪个标签页无关），并保留按 URL 读取供"这一页能看到什么"
  的场景；cookie 域比较也改成规范化（前导点可选、大小写不敏感、按标签边界匹配），
  因为 Chromium 会把同一个会话 cookie 存成 `.ke.com` 或 `ke.com` / `bj.ke.com`。
- **门禁的挑战处置（协议 36）**：受保护页回的是**人机验证**时，员工其实已经登录 ——
  原来的门禁只说"无法检查"，员工被按回登录页。现在 `crwu browser status` 在逐站结果里给出
  **结构化** `verdict`（`ok` / `login-wall` / `captcha` / `blocked`）与公开的 `protectedUrl`；
  门禁对判定为 `captcha` 的**必需来源**先走一次有界恢复（与取数共用同一个协调器，
  预算挂在 `gate:<siteId>` 上，重复点击不重置），**恢复后重新读一次权威状态**，只有真的过了才释放；
  未恢复时正文说明"这是验证不是未登录"并请员工在已打开的窗口里完成验证后点「重新检查」，
  且**不给**登录入口。调用方不再需要匹配 `reason` 的中文文案来分流。
- **修复：登录入口缺少 `service` 导致无法登录（2026-10-14 真机实测）**：站点清单里的
  `loginUrl` 原本写成裸 passport 地址（`https://clogin.ke.com/login`），而链家 / 贝壳的 passport
  靠 URL 上的 `service` 参数识别"哪个站点在请求登录"；少了它页面只回一句
  「Error 指定的服务未被授权，不能认证。」并**不渲染任何登录控件** —— 员工看到的就是这句话，
  无从下手。现在改为**站点自己发布的链接形状**（`service=<checklogin?redirect=<protectedUrl>>`），
  并加了一条守卫：随包清单里每个站点的 `new URL(loginUrl).searchParams.service` 必须非空，
  且其 `redirect` 必须**等于本机 `protectedUrl`**（两处指向不同城市时员工会登录到别的站点）。
  维护规则写进 `skills/biz/.../assets/README.md`（含"改版后从站点首页重新读取链接"的做法，
  以及 `https://login.ke.com/` 是 404 接口、不要照域名猜）。

## package · 0.0.42 · 2026-10-13 · feat · 钉钉设备流登录（环境信息 → 账号连接）

`dws auth login` 的 loopback 回调在部分环境里走不通（浏览器打开的 `127.0.0.1` 回不到 CLI、
远程 / 容器里根本没有可用浏览器），这一版给「钉钉认证」那一行加了一条退路。

- **授权页改成"强制新实例"打开（macOS `open -n`）**：现场根因是 WorkBuddy 的 `agent-browser` 从
  10:15 起挂着一个**无头 Edge**（`--headless=new`）。macOS 上应用已在运行时，`open <url>` 会把 URL
  当 Apple Event 投给**那个**实例 —— 无头实例没有窗口，URL 被吞掉，而 `open` 照样退出 0，
  员工看到的就是「浏览器打不开 / 地址栏一片空白」。氚云之所以正常，是因为 `crwu` 不走 `open`，
  而是直接起一个新 Edge 进程并把 URL 当参数传进去。登录两条路现在都用 `open -n`（实测恢复正常）；
  另外把授权链接回传给面板：**`open` 成功不等于页面出现**，所以没能确认打开时把链接摆出来让人手动打开。
- **两条登录都改由面板打开授权页**（用户实测：钉钉登录点了没反应）：`dws` 自己那次 `open` 失败是
  **静默的**（上游 loopback 那条路用 nil logger、device 那条只记 Debug），所以插件现在传 `--no-browser`、
  自己读输出里的链接并用 `system.browser.open`（与「查看报告」同一条已验证路径）打开，并把
  `opened` / `openError` 如实报给面板。`dws-login`（loopback）因此改成**内部两阶段**：后台起进程 →
  轮询输出 → 一看到链接就打开 → 继续等人授权；对外的返回形状与从前一致（只多两个字段），面板不用改。
- **设备流优先打开「已填入授权码」那一版链接**：`dws` 会打印两条链接（完整版在前、手动版在后），
  按位置"取最后一个"恰好会让员工把码抄一遍。解析改成按**标签**分类：完整版进 `url`（打开即可确认），
  手动版进 `urlManual` 作为退路并在面板上单独列出。
- **点「登录钉钉」之后有出路**：新操作 `dws-login-cancel`（操作清单 45 → 46）。loopback 最长要等人
  5 分钟，两条路又抢同一把 `.dws` 锁，所以在那期间设备流那颗按钮是**「改用设备流登录」**：先让 Host
  真的把那条命令杀掉、让出锁，**等它落定**再起设备流（不等的话两条命令会撞在同一把锁上）。
  `dws-login-cancel` 如实回报有没有真的取消到；插件卸载时也会把残留的 loopback 进程收尾。
  被取消的那次登录显示「已取消这次登录」，不是失败。
- **设备流登录**：新增 `dws-login-device-start` / `-status` / `-cancel` 三条 Host 操作（协议 31 → 32，
  操作清单 42 → 45）。`dws auth login --device` 要先打印短 URL 与授权码、再等人授权（最长 5 分钟），
  同步等它跑完面板在这期间**拿不到码** —— 所以做成"后台起会话 + 轮询快照 + 取消"。
- **面板行为**：点下去**秒级**出现授权码与链接；自动尝试打开授权页面（尽力而为，被弹窗拦截不算失败，
  链接与码都可复制）；授权成功后**自动**刷新环境自检，不用手点「重新检查」；切走再切回来仍能看到
  正在跑的那次；5 分钟到点杀进程并落超时。
- **两条登录互斥**：都要抢同一把 `.dws` 锁，所以设备流在跑时 `dws-login` 被 Host 直接拒绝
  （**一个进程都不起**，免得 dws 的 `Access is denied` 被归因读成"权限不足"）；
  loopback 在跑时界面禁用设备流按钮。
- **能力边界**：设备流救不了「Windows 权限不足 / `.dws` 锁被拒」那类故障（同一把锁），
  它解决的是**回调链路**；归因文案已相应改成指向面板上真实存在的「设备流登录」。
- **契约与安全**：三条操作入参一律为空（URL / 授权码 / 命令全部由 Host 解析）；
  URL 必须过 `https` + 钉钉域**后缀**白名单（`dingtalk.com.evil.tld` 会被拒）；
  授权码与 dws 原文只回显给发起登录的本人，不落盘、不进日志、不进诊断；
  客户端的轮询与视图派生放在框架无关的纯模块里（本仓 React 替身不跑 effect）。
- **规则与文档**：插件 `AGENTS.md` 那条"不收集设备码"改成窄口径例外；开发笔记 §14 / §20.2 两处
  "不得恢复设备码流程"的历史结论标注为被协议 32 部分反转（恢复的只有设备流，氚云内置浏览器扫码没有回来）；
  UI 设计指南 §6.8 补设备流四态与自动开页的尽力而为口径。

## package · 0.0.42 · 2026-10-13 · feat · 工作区会话统一（协议 32）+ 报告评估资料入口与输入交接 + 导航分模块 / 单工作面 / 样式作用域（协议 33）

用户报的「会话没创建在我环境信息里选中的工作区下面」在四条链路上各有成因。这一版把
"会话该落在哪儿"收敛成**一个**判据来源，并把所有降级路径删除。

- 新增 `src/host/core/workspace-session/`（协议 32）：唯一的工作区解析与建会话入口。
  `resolveSelectedWorkspace` 逐条核对 **id 非空 → 目录未丢 → 自检已完成 → 注册表能查到 id →
  注册表路径与选中路径是同一目录 → 确实是目录**；`createWorkspaceSession` 只发
  `sessionController.create({ workspaceId })`，随后回读会话 cwd 与工作区成员关系。
  失败给**可分类的原因**（`no-workspace` / `workspace-unregistered` / `workspace-path-mismatch` /
  `session-attach-failed` / `session-membership-missing` …）与一句人话。
- 新增 `src/client/core/workspace-session.ts`：客户端门禁 —— `workspaceId` 为空就不建会话。
- **审核根**改走统一入口：不再自己 `agents.create({ meta: { cwd } })`、不再用
  `workspacePath || caseRoot`（`caseRoot` 是部署配置目录，不是用户选的工作区）、不再 mkdir 补建、
  不再替用户登记工作区；`attachSession` 失败**不再只记一条 notes 继续跑**，而是停掉刚建的会话并失败；
  预检/策略/工具可见性任一步失败也释放该会话。根记录新增 `workspaceId`，复用前重新核对
  工作区一致性 + Agent 存活 + 会话 cwd + 成员关系 + 沙箱/审批策略。
- **审核子会话**建完**显式挂到同一工作区**并回读 `sessionIds`（DSH 的 `subagents.start` 不替
  child 做这件事），并校验 child cwd 与父会话一致；挂不上就 abort + 有界 dispose 释放它，不返回成功。
- **报告讨论 / 本地审核**删除 `cwd` 降级：`workspaceId` 为空时直接返回"工作区未就绪"，
  包含 `cwd: ''`（真机上是 `failed to ensure project directory "": mkdir ''`）与
  `cwd: workspacePath`（落在对的目录、却挂到侧栏「未分组」下）两种旧写法。
- `audit-start` 的工作区门禁改由统一解析器给结论，`errorKind: 'workspace'`；指令与案例目录
  一律用已核对的工作区路径。
- 协议 31 → 32（四条链路的跨进程行为都变了，旧客户端/旧宿主的组合正是用户看到的现象）。
  新增 5 条工作区会话单元断言组、3 条子会话挂载断言、3 条"`caseRoot` 不再是降级"断言。

**报告评估（房地产估值）资料入口与输入交接（2026-10-12，同一版）**

- 新增 `src/host/domains/report-evaluation/intake/`：多类型资料入口的**纯逻辑层**。
  类型判定（PDF / Word / Excel / 图片，另有 text / archive / unknown）、内容类型、人话类型名；
  选择校验（**空文件 / 越界路径 / 超单份上限 / 重复选择**逐条拒绝、理由分类，不支持的类型
  不算选择错误而是"未解析"）；输入清单与**排序无关**的 `sha256` 指纹；提取编排
  （每份文件交给第一个能处理它的提取器，读不出来的**不阻塞**其他文件并进 `capability_gaps`，
  提取器报的缺口与观察保序去重上浮，空结果无缺口时记一条观察而不是假装读到了空内容）。
- 新增 `src/host/domains/report-evaluation/scope.ts`：估值**案例 scope**。
  `ValuationScope` 持有 `valuationId` / 案例目录 / 会话 / 工作区 / **冻结输入快照**；
  `ValuationScopes` 双向索引 + 有界淘汰；`mintValuationId`（`估值-<yyyymmdd>-<hhmmss>-<4 hex>`）
  与 `isSafeValuationId`（`..` / 分隔符 / 绝对路径一律不合法）。
- 案例门禁（`audit/case-access.ts`）新增 `kind: 'valuation'` 分支：托管 scope 注册表收成一个
  `CaseScopeRegistries` 对象（`localAudit` / `valuation`），六个案例内 Tool 统一经
  `caseScopes(deps)` 传入 —— 归属按**会话 id 逐字相等**钉死，模型提交的 `caseDir`
  必须与那一份规范解析后相等（普通会话判据认的是形状，认不出归属）。
- 新增模型可见 Tool `crwu_valuation_case_bootstrap`：把**已冻结**的输入落盘到案例目录
  （`材料-源/`、`来源证据/`、`知识快照/` + `估值输入.json`），返回方法 / 基准日 / 资料清单 / 指纹。
  方法、基准日与用户补充要求**只来自冻结快照** —— 这个工具没有任何参数能让调用方改写它们，
  于是"确认后输入快照不可变"是结构性的，不是靠提示词。基准日未选时落盘与回传都是空串。
  它**不进** `REQUIRED_AUDIT_TOOLS`（审核能力门禁不该被另一条业务线的工具左右）。
- 新增技能脚本 `skills/biz/crwu-biz-valuation-realestate/scripts/extract_files.py` 与它的契约测试：
  PDF 文本（有 pypdf/PyPDF2/pdfminer 就用，没有就**如实报缺库**，绝不自己解析 PDF 内容流 ——
  字形编码读错会产出"看起来像正文的乱码"，而乱码会被下游当成坐落与面积）、Word（python-docx，
  段落 + 表格）、Excel（openpyxl，`data_only` 取公式值）、图片（Pillow 登记尺寸格式，
  内容识别进 `capabilityGaps` 等人工/OCR）；旧版 `.doc`/`.xls`、压缩包、未知扩展名各自给具体缺口。
  `extractedFields` 只做**标签锚定**（`坐落：…`），没有标签的正文一个字段都不产生；
  空文件是 `error` 而不是缺口；单份读不出来不影响脚本本身（退出码 0 + 结果文件必存在）。
- 新增 `src/host/domains/report-evaluation/intake/python-extractor.ts`：Python 后端。
  **先把脚本落到案例目录的 `scripts/`** 再执行（`python.script.run` 只接受案例内脚本路径，
  Host 自己也不开后门）；argv 逐个传参、不经 shell；结果写成案例目录里的 JSON 再读回来
  （不走 stdout —— 表格可能很大，被截断的 JSON 会变成误导性的"解析失败"）。
  读的是**插件自己的包文件**（`node:fs`），输出才走 `ctx.fs`（那是员工目录）。
- 新增模型可见 Tool `crwu_valuation_file_extract`：校验案例归属 → 收窄相对路径
  （空 / 绝对 / `..` 一律拒绝在起进程之前）→ 调编排 → **只回紧凑摘要**，
  完整正文与表格落盘 `<案例目录>/提取结果/提取汇总.json`。一份都没解析出来时
  `ok:false` + `capability-gap`，不说成"成功但结果为空"。
- `packageRootFrom` 的向上查找上限 4 → 6 层：分域模块 `src/host/domains/<域>/<子域>/*.ts`
  距包根 5 层，4 层会让"包内技能脚本"解析成空串（表现为"插件包可能不完整"这种误导性结论）。
- `make plugin-check` 增跑业务层的脚本契约测试（缺依赖的运行时会**跳过**对应用例，
  缺口分支照常断言）。新增 13 条 Host 侧断言 + 12 条脚本契约断言。

**报告评估的业务知识路由（2026-10-12，同一版）**

- 新增 `src/host/domains/report-evaluation/knowledge/`：知识路由的**决策层**（纯逻辑 + 注入探针）。
  `route.ts` 写死七条库内节点与**本地 fallback 映射**（`04-成本法 → references/07-cost-method.md`
  这类编号不一致逐个列明，绝不按编号或文件名推导）；`snapshot.ts` 给每条来源配
  `source` / `updatedAt` / **正文指纹**与整份快照指纹（按路由排序算，取数顺序无关）；
  `resolve.ts` 实现降级口径：知识库优先 → 本地参考 → 必需知识（`01-房地产估值通用`）
  两边都缺则**停止估值**，其余单份缺失记 `capability_gaps` 继续；`fallback.ts` 读包内参考
  并做存在性自检（重命名不许让 fallback 静默失效）。
- 三条容易静默出错的规则做成了显式判据并各有断言：**空正文不算命中**（节点在但导出为空时
  若算命中，子会话会拿一段空上下文去"按规范"编）、**探测失败 ≠ 节点不存在**
  （前者进能力缺口，否则"知识库挂过"永远查不出来）、**必需知识缺失是停止而不是降级**。
- 新增模型可见 Tool `crwu_valuation_knowledge_materialize`：一次遍历知识库树（组织库 + 个人库，
  与审核链路同一组范围与同一套通道）、命中节点按 `extension` 走 `doc +export` / `drive +download`，
  正文落 `<案例目录>/知识快照/`，来源写 `.知识来源.json`（库名、是否读到库、方法、指纹、逐条来源、
  失败与缺口）；知识库不可达时**退到技能自带参考文件**并如实标注 `source: local` 与失败证据。
  同样**不进** `REQUIRED_AUDIT_TOOLS`。
- 修正技能 `SKILL.md` 与 `references/` 里的**库内编号漂移**：此前表格与交叉引用用的是本地写作顺序
  （`04-案例选取` / `07-成本法`），与业务知识库的真实路由（`04-成本法` / `05-案例选取` /
  `06-参数与税费` / `07-计算表模板`）不一致 —— AI 按那张表寻址会取到**错的**正文而不报错。
  已按业务路由对齐，并加两条防漂移断言（SKILL.md 映射表与路由表逐行一致；references 里出现的
  节点名必须都是合法节点）。新增 22 + 7 条断言。

**报告评估的外部案例来源与浏览器预检（2026-10-12，同一版）**

- 新增 `src/host/domains/report-evaluation/browser/`：来源框架与预检的**纯逻辑**。
  `retry.ts`（每个分页**恰好**三次尝试，成功即停、失败留证据、最后一次之后不再多等）、
  `login-state.ts`（三态登录 × 失败页数 → 阶段：未确认登录 → `browser-login-required`，
  已确认登录 → 记缺口继续其他来源）、`login-probe.ts`（网络失败 > 验证码 > 登录墙 > 状态码 > 正常）、
  `provider.ts`（来源白名单 + 注入式抓取通道 + 明确不做的事）、`providers.ts`（三个站点的 URL 模板）、
  `fetch-transport.ts`（默认 `fetch`：不伪装 UA、不跟随到白名单之外的 host、响应体有上限）、
  `capture.ts`（证据落 `<案例目录>/来源证据/`，文件名带内容指纹）。
- 新增 `src/host/domains/report-evaluation/market/`：**字段标准化**与挂牌纪律。
  `jsonld.ts` 只从页面里**明确声明**的结构化数据取案例（不按 CSS 选择器猜 DOM、不让模型自由发挥）；
  `normalize.ts` 做跨站点字段别名、价格/面积解析与 `transactionType` 判定 ——
  **只有**页面明写"成交"才算成交，缺省是"未知"而不是"成交"，挂牌案例`caseIsComparable=false`。
- 新增三个模型可见 Tool：`crwu_valuation_browser_preflight`（逐家给"可用 / 需要登录 / 无法检查"
  与原因，并在返回里写明"这里回答的是站点是否放行公开检索，不是插件知道你的账号状态"）、
  `crwu_valuation_market_search`（逐页三次尝试 + 证据落盘 + `估值案例.json` + 阶段判定）、
  `crwu_valuation_market_capture`（单页取证）。三者都**不是**审核必需集成员。
- **授权门禁**：三个 Tool 都先过本机访问授权，未授权时**零外部请求、零落盘**（与协议 18
  对氚云 / 钉钉 / OSS / iFinD 的口径一致）。"在默认浏览器登录"**不**在这些 Tool 里 ——
  打开系统浏览器是面板来源的特权操作（`system.browser.open` 的 `allowedSources` 只有 `panel`），
  Tool 借面板身份开浏览器正是操作表要防的提权。
- **修正别名表漏项**：`floorSize`（schema.org 里建筑面积的规范字段）不在别名表里，导致
  JSON-LD 来源的面积永远拿不到 → 单价永远为 null → 市场法失去唯一的可比指标，而且**不报错**。
  同时收进了 `url` / `currency` 别名，并对非人民币标价给出人工核对提醒（本工具不做汇率换算）。
  新增一条防漂移断言：**JSON-LD 产出的每个键都必须能被别名表消费**（收了死数据、或漏了字段，都会红）。
- 截图能力如实上报：本部署没有无头浏览器，证据是页面字节 + 指纹，**每次**都写进 `capabilityGaps`，
  避免"有证据文件"被读成"有截图"。新增 24 + 17 条断言。

**报告评估的交付模板与契约校验（2026-10-12，同一版）**

- **Skill 目录按产物职责归位**：`assets/valuation-workbook-template.xlsx` → `template/valuation-workbook.xlsx`
  （`template/` = 要被填充或渲染的正式模板，`schemas/` = AI 输出的结构校验，`examples/` = 样例，
  `assets/` = 图片字体等静态资源）。`assets/` 已清空。生成脚本与契约脚本的默认路径同步改到 `template/`，
  并加了一条断言：**默认路径必须指向 `template/`**（指错了会让"不带参数"的调用静默校验别的文件）。
- 新增 `schemas/valuation-result.schema.json` / `valuation-case.schema.json` / `valuation-object.schema.json`：
  结果、案例与对象的结构契约。案例 schema 里 `transaction_type` 是四值枚举，
  并新增 `used_as_comparable` —— 只有 `成交` 才允许为 true（挂牌价是卖方要价，不得直接当成交价）。
- 新增 `examples/valuation-result.sample.json` / `valuation-case.sample.json`：一份**通过校验**的完整样例
  （含 dws 与 local 两种知识来源、挂牌与成交各一条案例、以及真实的能力缺口文案）。
- 新增 `references/08-knowledge-routing.md`（路由、来源标注与降级口径）与
  `references/09-output-contract.md`（案例目录、结果 JSON 的硬性规则、交付前的两道校验）。
  `SKILL.md` 的执行步骤随之补上"模板复制到案例目录、不许回写 `template/`"与"交付前必须过两道校验"。
- 新增 `scripts/validate_result.py`：结果契约校验。**每条硬规则都真的会让它失败**（有 15 条反例断言）：
  `method=auto`（那是输入不是结论）、`baseDate` 为空但没登记「本次未指定评估基准日」、
  基准日形状不是 `YYYY-MM-DD`、数字填 0、两个金额都为 null、`source=missing` 混进来源清单、
  来源缺 `digest`、挂牌案例被标为可直接作可比实例、案例没有保留/剔除理由、缺 `url`/`captured_at`、
  交付件不存在、交付件跑到案例目录之外；带 `--html` / `--workbook` 时还做一致性抽查
  （报告里必须找得到 JSON 里的数字；底稿不许有隐藏表或 `#REF!`/`#VALUE!`/`#DIV/0!`）。
- 新增 `scripts/test_valuation_contracts.py`：上面两个脚本的契约测试（19 条），
  并断言**随包发布的底稿模板过工作簿契约**、缺文件时返回非零而不是静默通过。已接入 `make plugin-check`。
- 新增模型可见 Tool `crwu_valuation_artifact_validate`（第七个估值 Tool）：把两个校验脚本落到
  `<案例目录>/scripts/` 再执行（`python.script.run` 只接受案例内的脚本路径，Host 也不开后门），
  逐条把问题原样带回；缺交付件时**直接报缺哪一件**且不去跑那一份校验。
  同样**不进** `REQUIRED_AUDIT_TOOLS`。`pack:assert` 增补模板 / schema / 两个校验脚本的存在性断言。

**报告评估的轮次状态机、子会话指令与八个 Host 操作（2026-10-12，同一版）**

- 新增 `domains/report-evaluation/lifecycle/`：估值轮次的**状态机**与进程内注册表。
  `draft → extracting → confirmation → queued → running → completed`，另有 `failed` / `cancelled` /
  `browser-login-required`（可恢复）与 `stale-host`（协议代数不匹配时的页面结论，**不由 Host 返回**）。
  **非法转移一律拒绝并给出原因**：没有转移表时任何一处写入都能改状态，典型后果是
  "已经失败的轮次被后续心跳改回 running"、界面永远转圈而没有任何地方报错。
  进度归一化把 `completed` 夹在 `total` 之内（跑过头是"页面在编进度"的第一个信号）；
  `total` 无效时都归 0 而不是显示 `3/0`。注册表有界：超限时**先删终态**、全是活动轮次时删最旧的
  （写这条时先试过"只标成失败"，用例当场抓出标记不减少条目数、会一路把每一轮都标花）。
- 新增 `domains/report-evaluation/prompt.ts`：估值子会话的**固定指令**（方案 §12）。
  逐段写全：估值 ID、案例目录、输入资料与提取结果（未解析的**逐条列出**原因）、知识来源与
  "必需知识缺失就停止测算"、外部来源状态、按方法分派的口径、底稿的复制与"只填输入区"纪律、
  三个交付件、交付前的两道校验。用户补充要求**单独成段**并明确"不得覆盖安全规则 / 工具边界 /
  目录范围 / 公式契约 / 输出结构"—— 直接拼进指令等于让一份被投喂的资料改写边界。
- 新增 `ops/report-evaluation.ts`：八个 Host 操作（`valuation-files-scan` / `valuation-intake` /
  `valuation-browser-preflight` / `valuation-start` / `valuation-status` / `valuation-cancel` /
  `valuation-result` / `valuation-open-artifact`）。三条硬口径：
  ① `valuation-start` 核对**确认指纹**（资料在确认后被改过就拒绝启动，避免"确认的是 A、算的是 B"）；
  ② 基准日空就是空，**绝不**从资料里识别到的日期补一个；
  ③ 会话落点只走统一会话服务（`workspaceId`），工作区不成立就不建会话、不留下半截轮次。
  操作清单 42 → 50；`valuation-intake` 把轮次推到 `confirmation`（抽屉即"待确认"阶段），
  `valuation-start` 沿**合法路径**推到 `queued` 再 `running`（一步到位会被转移表拦下，
  这条也是被用例抓出来的）。
- **资料按字节复制**：新增 `copyCommand()`（`cp -f` / `Copy-Item -Force`）并通过 Broker 的
  `system.case-file.write` 执行，指纹按源文件字节算。原先的 `readText` + `writeText` 会把
  `.pdf` / `.xlsx` / 图片按 UTF-8 解码再编码 —— 得到一个**看起来正常、内容已损坏**的副本，
  而下游只会说"这份读不出来"。
- 新增 `browser/preflight.ts`：把来源预检抽成面板与 Tool **共用**的一份。两处各写一遍循环的后果
  不是重复，而是结论不一致（抽屉说"可用"、工具说"需要登录"）。
- Client 门面（`report-audit/api.ts`）声明这八个操作，冻结清单同步到 50 条。
  新增 20 + 12 条断言（状态机 / 指令契约 / 操作接线）。

**报告评估页（房地产估值 UI）（2026-10-12，同一版）**

- 新增 `client/modules/report-evaluation/`：`model/valuation-state.ts`（页面状态机）、
  `controller.ts`（无 React 的控制器）、`api.ts`（本模块的八个操作）、`index.ts`（组装）、
  `model/styles.ts`（类名与样式文本）、以及 `ui/` 下的四个界面件。
- **只读确认抽屉是结构性的**（方案 §5.4）：`canEditInputs(phase)` 只在 `draft` / `extracting`
  为真，进入 `confirmation` 后所有改输入的动作被状态机**拒绝并给出原因**；组件也只接收
  一个 `intake` 与三个回调 —— 没有 `onChange`、没有输入框 / 下拉 / 日期选择器，
  于是"在抽屉里改方法 / 基准日 / 提示词"在类型上就写不出来。动作区**恰好三个按钮**
  （返回修改 / 确认并开始估值 / 取消）。有 20 + 15 条断言盯着这两件事。
- **确认后输入冻结，且基准日逐字提交**：`确认并开始估值` 提交的是提交那一刻的方法 / 基准日 /
  补充要求与确认指纹；未选基准日时提交**空串**，客户端不许拿资料里识别到的日期补一个。
  指纹不符时 Host 拒绝启动（见上一节的 `valuation-start`）。
- **失败不丢输入**：资料入口失败时选择 / 方法 / 基准日 / 补充要求全部保留（用户改一句再试，
  而不是从头再选一遍资料）；切换模块也保留（控制器是实例级、只有一份，与本地审核同一口径）。
- **不伪造进度**：阶段与进度只来自 Host；`total <= 0`（宿主没给总数）时**不画进度条**，
  只写文字阶段。阶段词认不出来时**不推进**页面状态（不猜）。协议代数不匹配 → `stale-host`，
  此后不再接受任何状态变化。
- 报告评估从「Coming Soon」变成**正式模块**：`MODULE_META.eval.underDevelopment` 改 false，
  侧栏不再画「开发中」标签（标签机制保留，判据仍是 `isUnderDevelopment`）；
  `WorkbenchPanel` 渲染 `ReportEvaluationPane`，控制器由 `apply()` 注入（缺省就地建一份，
  这一页在任何挂载方式下都能渲染）。**环境门禁不变**：仍由统一导航层拦（`requirement: global`）。
- 文件 / 文件夹选择**复用本地审核那一套**：把 `pickFilesFromInput`（隐藏 input + 宿主
  `pathFor`）从 `LocalAuditPane` 移到 `features/local-audit/pick.ts` 并导出，估值页与本地审核
  共用同一个系统对话框入口 —— 两套各写一遍迟早会在"回什么形状的路径"上分叉。
- 测试脚手架抽出 `tests/helpers/render.mjs`（`render` / `rerender` / `find` / `findAll` / `textOf`）：
  同一套渲染语义此前只在 `client-package.test.mjs` 内部，估值页的用例也用得上；
  `client-package.test.mjs` 改为引用它（191 条断言原样通过）。
- 样式只用 `--crwu-*` 语义 token（`client-package` 的"不许硬编码颜色"断言把第一版里的
  `#b3261e` 当场抓了出来），动画只碰 opacity / width 且在 `prefers-reduced-motion` 下关闭。

**估值 Skill 的两个构建脚本与报告模板（2026-10-12，同一版）**

- 新增 `scripts/build_workbook.py`：把 `填入值.json` 填进计算底稿。**"只填输入区、保护公式区"
  变成了可执行的判据** —— 模板自己用填充色声明区域（浅绿 = 输入区，浅黄 = 公式区，见
  `references/06` 第 2 节的图例），所以脚本能判：写公式区拒绝、写没声明为输入区的单元格拒绝、
  输入区里写 `=` 开头的值拒绝（那是把结论硬编码进输入）、空值写成**空单元格而不是 0**
  （0 是结论，未填是另一件事）。任一处被拒就**不输出底稿**：半填的底稿比没有更危险，
  公式会算出看起来正常的数。另外还拒绝把产物写回 `template/`（生成件覆盖母版），
  以及默认拒绝覆盖已存在的底稿（`--force` 才覆盖）。
- 新增 `scripts/build_report.py`：从 `估值结果.json` 渲染 HTML 报告。**报告不自己算数** ——
  连"万元换算"都不做（换算会引入第二套取整口径），数字逐字来自结果 JSON，
  于是 `validate_result.py --html` 能核对报告里找不找得到单价与总价。
  外部文本（案例标题、小区名来自网页）一律转义，且只把 `http/https` 渲染成可点链接。
  `capability_gaps` / `manual_confirmation_items` 为空时**照实写"没有…"**，而不是留白
  （留白会被读成漏印）。`method = auto` 直接拒绝：那是用户输入，渲染报告前必须已经判定。
- 新增 `template/valuation-report.html`（带占位符的报告模板）与 `template/valuation-result.json`
  （结果骨架）；新增 `assets/README.md` 与 `logo/`、`fonts/`、`icons/` 三个占位目录，说明资源
  准入规则（可再分发、注明来源、小写连字符命名、按相对路径内联进报告）。
- `SKILL.md` 执行步骤补上两个脚本的调用方式与"脚本不重算公式、交付前必须真打开重算一次"的提醒。
- 契约测试 19 → **34 条**：新增「填底稿」9 条（只填输入区、拒公式区、拒非输入区、拒输入区里的公式、
  空值不写成 0、拒绝未知表/区域/坏引用、拒绝写回模板、默认不覆盖、缺 cells 报错）与
  「渲染报告」6 条（样例跑通真链路、数字逐字一致、外部文本转义、拒绝 auto、缺口照实写、
  未指定基准日渲染出那句固定文案、默认不覆盖且不写回模板）。已接入 `make plugin-check`。

**共享层按领域拆分 + 环境模块解除对审核门面的依赖（2026-10-12，协议 32 · Task 3 第一批）**

- `shared/types.ts`（627 行、31 个声明）按领域拆成 `shared/contracts/`：`common`（环境自检零件、
  OSS 视图、脱敏凭据、本机访问诊断）/ `environment`（`env` 应答与工作区视图）/
  `report-audit`（列表、审核视图、交付件、审核根与占用）/ `report-evaluation`（协议 32 的
  阶段 / 方法 / 确认抽屉 / 状态 / 结果视图）/ `local-audit` / `update`。
  `shared/types.ts` 改为**整体 re-export** 的兼容别名（迁移期 29 个旧导入点不必一次改完），
  且新增断言：别名文件里不许再出现真实定义。
- `shared/wire-contract.ts` 按领域拆成 `shared/wire/`（`common` / `environment` / `report-audit` /
  `report-evaluation`），入口整体 re-export，旧路径不断。一处红就知道是哪条链路漂了。
- **修掉一处反向依赖**：`OSS_BATCH_FROM_HOST` 原先的右侧类型写的是
  `WorkbenchApi['ossBatchIndex']` —— 契约层从 **Client** 取类型。方向反了两层坏处：
  ① 契约层本该两端都不依赖、只被两端依赖，反向依赖会让"Client 改一个字段"悄悄放宽契约；
  ② 打包形态上 Client 与 Host 分开构建，共享层引用 Client 类型把两个边界缝在一起。
  现在用线协议自己的 `OssBatchIndexResult`。
- **修掉方案 §4.1 点名的禁止项**：新增 `client/modules/environment/api.ts` + `model/state.ts` +
  `model/types.ts`，把环境页真正需要的东西（`environmentApi`、`environmentStateOf`、`headlineOf`、
  `IfindProbeResult/IfindStatusResult/IfindSaveResult/LocalAccessResult`、`BootResult` 的环境那一半）
  从 `features/report-audit/api.ts` 搬进环境模块，8 个环境文件改为从环境模块导入。
  报告审核门面**转出**这些名字（旧导入路径继续可用），依赖方向变成 **环境 ← 审核**。
  `BootResult` 拆成 `EnvironmentBootView`（环境模块）+ `interface BootResult extends …`（审核侧补
  审核根 / 占用 / 已迁移操作清单）；`gatingOf` 与 `Gating` 留在审核侧（它算的是报告页的门禁），
  改为 import 环境模块的 `environmentStateOf`。
- 新增 `tests/unit/shared-contracts-layout.test.mjs`（8 条）：共享层不许引用 Client 任何东西、
  引用 Host 只能引类型、按领域的契约与 Wire 层都在且入口都导出了、兼容别名是整体 re-export
  且仍有真实消费者、Wire 常量导出真的存在、协议 32 的三套词（阶段 / 交易性质 / 结论方法）、
  环境模块不许反向依赖报告审核门面、环境 API 存在且门面转出它。

**Host 侧目录分层：tools/ 四层归位 + ops/ → operations/（2026-10-12，协议 32 · Task 3 第二批）**

- `host/tools/` 从 21 个平铺文件分成四个层次，根下**只留** `register.ts`：
  `common/`（capabilities / case-dir / case-files / python-script / snapshot / outcome / types）、
  `report-audit/`（bootstrap / h3yun / knowledge / oss / dingtalk / local-claim / dws-json /
  case-scopes / consts）、`report-evaluation/`（上一批已在）、`integrations/`（ifind / ifind-ops）。
  `host/ops/` 改名为 `host/operations/`（方案 §4.2 的目录名）。
- 搬模块用了一个**按模块图重写**的脚本，而不是手工 sed：搬文件会同时改变两件事 ——
  被搬文件内部的相对路径（深度 +1）与所有引用者的路径；手工只改一半，而 import 指错在
  Node 里的表现是"模块找不到"，只有类型检查或跑到那一步才看得见。脚本把每个相对 specifier
  解析成绝对路径、过一遍映射、再相对新位置写回去。
- ⚠️ **一次真实的漏改**：脚本只扫了 `src/` 与 `tests/`，于是 `scripts/smoke-built.mjs` 里那句
  `import '../src/host/tools/consts.ts'` 没跟着改 —— `npm test` 全绿、`make plugin-check`
  跑到冒烟那一步才炸。因此新增 `tests/unit/host-module-layout.test.mjs`（6 条）：
  ① `tools/` 根下只有 `register.ts` 与四个分层目录；② `register.ts` 只做组装（不许出现
  `runShell(` / `ctx.shell`）；③ 每个分层目录都有真实内容（空目录 = 搬了个壳）；
  ④ `ops/` 已不存在且 `operations/` 内容对得上；⑤ **`src` / `tests` / `scripts` 里不许再出现
  旧路径字符串**（按"出现过旧路径"扫，不按某一种语法扫 —— 路径引用有相对 import、
  `new URL('src/...', ROOT)`、`'../src/host/...'` 三种写法）；⑥ 抽查每个分层的入口文件真的在。
- 顺带修掉 8 处**注释里的旧路径**（活跃代码的注释指向不存在的文件，正是"读的人去找一个没有的文件"）。
  历史文档（`docs/review-0.0.15.md`、`docs/superpowers/specs/*`）按仓库规矩保持原样。

**Client 侧目录分层：features/ 拆成 modules/，components/ → ui/，workbench → shell（2026-10-12，协议 32 · Task 3 第三批）**

- `client/features/`（5 个子目录、50 个文件）按业务拆成 `client/modules/*`：`report-audit/`
  （api / types / model / session / ui）、`local-audit/`（api / consts / controller / pick / model /
  session / ui）、`environment/`（api / model / ui）、`update/`（api / model / ui）、
  `report-evaluation/`（上一批已在）。`client/features/`、`client/components/`、`client/api/`
  三个"什么都放"的目录**整体消失**。
- `client/components/*` → `client/ui/*`；`client/features/workbench/*` → `client/shell/*`
  （面板、侧栏入口、模块 store、服务、样式）；`client/api/client.ts` → `client/core/rpc.ts`
  （只保留底层 `rpc()`）。
- **删掉死代码**：`features/report-eval/ReportEvalPane.tsx`（Coming Soon 页）已无任何引用者
  （协议 32 起由 `modules/report-evaluation/ui/ReportEvaluationPane.tsx` 取代），连同它专用的
  5 个文案键与 3 个类名一起删除。
- 新增 `modules/local-audit/api.ts`：本地审核的三个操作原先借报告审核门面
  （`workbenchApi.localAuditStatus/Start/Claim`），现在写在自己的 `api.ts` 里；剪贴板这类环境通用
  能力改从 `modules/environment/api.ts` 拿。**借门的后果不是"多一层"，而是改审核门面会牵动本地审核页。**
- 新增 4 条 Client 侧护栏（`tests/unit/host-module-layout.test.mjs` 扩到 10 条）：
  ① `client/` 只剩 `core / locales / modules / shell / ui` 五个目录（+ 三个入口文件）；
  ② 底层 `rpc()` 只在 `core/rpc.ts`（不许再有文件从旧 `api/client.ts` 导入）；
  ③ 每个业务模块都有 `api.ts` 与 `model/` 或 `ui/`；④ 没有指向旧 client 目录的引用。
- 修掉三处**随搬迁暴露的守卫失效**：本地审核的源码守卫只 `readdirSync` 顶层（模块化后实现文件在
  `ui/`、`model/`、`session/` 里，文件数从 12 掉到 3，守卫报"扫描根可能不对"）→ 改成递归；
  Update 的静态边界扫的是旧平铺文件名 → 改成 `model/` 下的新路径；
  两处"被删组件不许复活"的断言只盯旧路径（**挪个目录就能让守卫失效**）→ 改成断言新分层下也不存在。
  另外修掉 10 处注释里的旧路径。

**估值工具可见性预检 + 文档同步（2026-10-12，协议 32 · Task 9 第一批）**

- **`VALUATION_CHILD_TOOLS` 从"写在常量里"变成真的会用**：新增
  `tools/report-evaluation/visibility.ts`，`valuation-start` 在**创建会话之前**拿这份名单去问宿主
  注册表（与审核侧共用同一个 `missingAuditTools` 实现 —— 两处各写一遍"怎么算可见"迟早会分叉，
  而分叉的表现是两条链路对同一个部署给出不同结论）。缺任何一条就**拒绝启动**并**点名**是哪一条：
  "把缺工具说成'环境不对'"会把用户指到错的处置上；让估值会话跑到一半才发现工具调不到更糟。
  新增 1 条断言钉住这条 fail-closed 行为（不可见时既不建会话也不开轮次）。
  ⚠️ 为什么估值这条链路**不是**工具过滤：估值会话是经统一会话服务建的**顶层会话**
  （`sessionController.create({ workspaceId })`），那条路径没有 `toolFilter` 入口。所以它的边界是
  ① 每个估值 Tool 的案例归属门禁、② 审核 Tool 自己的作用域门禁、③ 这次的可见性预检 ——
  `visibility.ts` 的文件头把这三条写清楚了，免得后来的人以为这里漏了一层。
- `README.md` / `README.en.md`：开头补上「报告评估 = 房地产估值」当前形态的说明（上传多类型资料、
  只读确认抽屉、冻结输入、自动取数与勾稽、三件交付件、未指定基准日的口径、以重算底稿为准）。
  2026-09-20 那节**真实浏览器验收记录**按仓库规矩**保持原样**，只在两处加了"当时标开发中、
  2026-10-12 起已交付"的注记 —— 历史快照不重写，但也不让它冒充当前行为。
- `docs/skills.md`：新增业务层估值技能的**目录职责表**（`references` / `template` / `schemas` /
  `examples` / `assets` / `scripts` 各放什么、各有什么规矩）与**调用方式**（7 个结构化 Tool +
  `crwu_run_python_script`，以及"这份名单会被用来预检"这件事）。

**Host 操作表按域拆分（2026-10-12，协议 32 · Task 3 第四批）**

- `operations/core.ts`（696 行、38 个 handler）拆成方案 §4.2 列的那套文件：
  `register.ts`（**组装**：构造共享依赖 + 拼四张域操作表 + `boot` 里那份 `ported.done`）、
  `common.ts`（**共享依赖与闭包**：门禁快照、OSS 依赖与批量队列、上传看门狗、身份缓存、
  环境自检入口）、`environment.ts`（21 条：环境自检 / 工作空间 / 本机访问授权 / DWS 目录体检与修复 /
  账号登录 / OSS 凭据 / iFinD 凭据生命周期）、`report-audit.ts`（13 条：待审核列表 / 审核生命周期 /
  报告讨论材料 / 交付件 / `crwu` 直通）、`local-audit.ts`（3 条）、`types-export.ts`（注入面两个类型）。
  `core.ts` 只剩**兼容转出**（`createCoreOperations` / `CoreDeps` / `HostResolvers` 的旧导入路径不断）。
- **拆分的动机不是"文件太长"**，而是这些闭包被三个域共用：门禁快照（`gate`）、OSS 依赖与队列、
  看门狗、身份缓存、自检入口。**每域各建一份**的后果是"授权之后只有环境页看到新事实、
  审核页还在用旧快照"，而那种不一致在任何地方都不会报错。所以 `common.ts` 构造**一次**，
  域文件通过 `OperationHost` 取用 —— 域文件里看不到 `create*` 调用，只看到 `host.gate` 这样的引用。
- `boot` 留在组装处：`ported.done` 那份"声明必须跟着实现走"的名单按**真实注入的操作表**推导
  （`Object.keys(updateOperations)` 这类），放在组装处才不会出现"某个域加了操作、声明忘了加"的漂移
  （`clipboard` 那次就是这么踩的：声明里有它、操作表里没有，客户端点「复制提示词」拿到 404）。
- 布局护栏同步收紧（`host-module-layout` 扩到 10 条）：`operations/` 的九个文件逐个点名，
  并断言 `core.ts` **只剩兼容转出**（不许再出现 handler 定义、必须转出 `createCoreOperations`）。
- 搬运是**按块提取**（不是手抄）：脚本按顶层键切分原文件、把紧邻的注释一起带走，再按域重组；
  imports 由"该文件真实用到的名字"过滤后生成 —— 手工重排 38 个 handler 必然会掉一处注释或漏一个
  import，而后者要到类型检查阶段才暴露。

**Host 目录按运行时边界归位：integrations/ · domains/ · core/（2026-10-12，协议 32 · Task 3 第五批）**

- 方案 §4.2 的 Host 目录树现在**逐条对得上**：
  `host/integrations/{h3yun,ifind,oss,dws,crwu}`（外部提供方）、
  `host/domains/{report-audit,report-evaluation,local-audit}`（业务域，`report/files.ts` 归到
  `domains/report-audit/material/`）、
  `host/core/{access,environment,fs,http,platform,runtime,shell,state,system,workspace,workspace-session}`
  （机制层）。`host/` 顶层只剩 `apply.ts` / `build-info.ts` / `consts.ts` + 五个分层目录
  + 两个子系统（`update/` 自助更新、`config/` 部署配置解析 —— 它们不是"按运行时边界分的目录"，
  所以照旧留在顶层，这一点写进了护栏注释）。
- 搬运仍然走**按模块图重写**的脚本（86 个文件的映射、约 150 处引用），并同步修掉
  21 个源码文件 + 4 份活跃文档里的旧路径引用。
- 布局护栏扩到 11 条：新增"`host/` 顶层只剩哪些目录"、"`integrations/` 与 `domains/` 的名字逐个点名"、
  "`core/` 的十一个机制目录都在"，并把这一批旧路径全部加进"不许再出现"的清单。
- 顺带修掉一处**随搬迁失效的守卫**：OSS 的"每一次 `ossutil` 都必须经 Broker"那条断言
  按 `host/oss/` 前缀扫描文件（搬迁后扫到 0 个文件、守卫静默失效），现在按
  `host/integrations/oss/` 扫，并把执行器 `run.ts` 的豁免路径一起更新。

**「JSON 通过 Schema」从一句话变成真的校验（2026-10-12，协议 32 · 验收 §16）**

- 对方案 §16 逐条做验收审计时发现一处**假满足**：`schemas/*.json` 被提示词、`SKILL.md` 与
  报告骨架三处引用为"结构契约"，但**没有任何代码或测试读过它们**。真正把关的是
  `validate_result.py`，于是 schema 可以悄悄漂移成一份没人执行、也没人校对的文件。
- 新增 `SchemaSubsetTest`（契约测试 34 → 39 条）：自带一个**最小 JSON Schema 校验器**
  （本机与 DSH 自带 Python 都没有 `jsonschema`），并让
  `examples/valuation-result.sample.json` / `valuation-case.sample.json` **真的过 schema**。
  校验器的关键设计是**遇到不认识的 keyword 就报错**：只认识一半 keyword 的校验器会给出
  **假通过**（schema 里写了 `pattern` 而校验器忽略它，样例照样"通过"），所以支持面是白名单，
  扩展 schema 的人必须同时扩展校验器。
- 同一批加了**防漂移**断言：schema 的 `required` 必须是校验脚本必需字段的子集；
  `method` / `transaction_type` / 知识来源 `source` 三个枚举按**从校验脚本里解析出来的值**比对
  （故意不把那些取值写进测试文件：技能脚本里出现业务 CLI 字面量会被 CLI 守卫判成"间接旁路"，
  实测被拦下两次）。负向断言也在：`method=auto` / 缺 `capability_gaps` / `unitPrice` 写成字符串
  三种改法都必须被判不合格。
- 修掉审计中发现的**第二处漂移**：抽屉要核对的 12 个估值要素此前写在两个地方
  （Host 的 `VALUATION_FIELD_KEYS`、界面的 `VALUATION_FIELD_LABELS`），schema 里没有。
  现在 `valuation-object.schema.json` 新增 `fieldLabels`（12 项逐字、顺序固定），
  并加一条 TS 断言把 **schema ↔ Host ↔ 界面**三处钉成同一套标签 —— 三处各写一份的后果
  是"用户核对的那份清单与结果文件里的口径不同"，而那种不一致谁也不知道该信哪个。

**估值工具把结论写回轮次状态（2026-10-12，协议 32 · 验收 §16）**

- 验收审计抓出**第二处假满足**：`market-search` 工具会回 `phase: browser-login-required`、
  `needsLogin` 与来源状态，但**没有任何东西把它写进轮次注册表** —— 于是面板轮询的
  `valuation-status` 永远说"正在跑"，界面**根本进不到** `browser-login-required`，
  §16 的"登录异常时进入可恢复的 browser-login-required"在用户视角是不存在的。
  阶段与来源状态只有**发请求的那一方**（工具）知道，模型转述一遍不算"界面看得到"。
- 新增 `tools/report-evaluation/record.ts`：把工具侧结论写回轮次的三个入口
  （来源状态 / 能力缺口 / 阶段）。**身份只从 Agent 取**（`callerIdentity(exec)`，与案例归属门禁
  同一个来源），所以"把状态写到别人的轮次上"在结构上写不出来。`market-search` 与
  `browser-preflight` 都接上了（后者写来源状态与缺口 —— 那是面板"即将访问的数据源"的事实来源）。
- **写不回去要如实说**：工具本身的结论照旧返回，但会往 `warnings` 里写一句
  "轮次状态没能回写（界面会少一条状态）：…"。静默的后果是**界面与子会话看到的事实不一致
  而没有任何地方会提这件事**。非法阶段转移同理：不算错误，但要回报。
- `ToolDeps` 增加 `valuationLifecycles`，`apply.ts` 让操作表与 Tool 闭包共用**同一个**注册表实例。
  测试夹具也照真实流程改成"先开一轮再跑工具"（否则这条回归会变成假绿：没有接收方，
  写回永远"成功"地写进空气里），并新增两条断言：阶段/来源状态/缺口**真的落到注册表上**；
  轮次记录被抹掉时检索照样成功且 `warnings` 里有那句话。

**输入快照从"天然不可变"变成"篡改可见"（2026-10-12，协议 32 · 验收 §16）**

- 验收审计抓出**第三处纸面承诺**：§16 写"确认后输入快照不可变"，实现只有两层保障 ——
  ① 子会话没有参数能改方法 / 基准日 / 补充要求；② `valuation-start` 在建会话**之前**核对一次
  确认指纹。两层都对，但都管不到一件事：**`估值输入.json` 是案例目录里的普通文件，
  而估值会话对案例目录有写权限**。谁都可以改它，而改完之后没有任何地方会知道 ——
  子会话读的正是这份文件。
- 新增 `frozenInputMismatch()`（纯函数，在 `domains/report-evaluation/scope.ts`）：
  把磁盘上的文件与**宿主内存里那一份**逐字段比对（方法 / 基准日 / 补充要求 / 输入清单指纹 ——
  只比会影响结论的字段，`frozenAt` 之类不参与）。不一致返回一句能读懂的话并指出**以宿主记录为准**。
- `valuation-result` 每次读结果时都核对一次：被改过 → `ok:false` + `error` +
  `snapshotTampered:true`，并把这件事写进轮次的能力缺口（结果页与交付件复核都读它）。
  **文件不见了同样要报**（它不是"没问题"：本轮输入没了）。
- `ValuationRecord` 增加 `supplementalPrompt`：不把当时那一份留在宿主内存里，
  "文件被改过"这件事就永远发现不了。`valuation-intake` 与 `valuation-start` 都写它。
- 新增 2 条断言：改基准日与补充要求后必须报出**改了哪一项**且进能力缺口；删掉文件也要报。

**完成由宿主判定（2026-10-12，协议 32 · 验收 §16）**

- 验收审计抓出**第四处断链**：状态机里有 `completed`、工具侧允许写它，但**没有任何地方真的推过去** ——
  于是面板轮询的 `valuation-status` 永远说 `running`，客户端控制器只在 `completed` 时去取结果，
  **结果页永远不出现**。§16 的"正常情况下确认后自动完成"在用户视角是不成立的。
- 判据放在 `valuation-status`（面板轮询的那一份事实）：**三件交付件齐备 + `估值结果.json` 读得懂**
  才收成 `completed`，进度同时走到头。两个理由：
  ① 子会话没法"报告完成"—— 它写完文件就结束了、没有回调，而模型说一句"我完成了"不是事实；
  ② 只看文件在不在会把"报告刚写了一半"判成完成，而结果页要拿这份 JSON 渲染结论，
     所以额外要求它解析得出来且带 `method`。读不懂就**不动阶段**（留在 running，下次轮询再看），
     这不是错误：本轮还没做完。
- `completed` 是**终态**：删掉一件交付件之后再轮询仍然是 `completed`（已交付过的东西不撤回，
  `advance` 本来就拒绝从终态回退）。
- 新增 1 条断言覆盖三段：两件 → 留在 running；三件齐但 JSON 读不懂 → 仍 running；
  三件齐且可解析 → `completed` 且进度走满；随后删一件 → 仍是 `completed`。

**工作簿契约补一条「静默空结论」检查（2026-10-12，协议 32 · 验收 §16）**

- 验收审计抓出**第五处**：§16 要求"方法选择必须进入 XLSX 的**采用的方法**"，但工作簿契约
  只管结构、公式链与收益法链，**从不检查汇总表的 J 列**。而 K 列的公式是
  `=IF(ISNUMBER(SEARCH("收益法",J5)),G5, IF(…"市场法"…, IF(…"成本法"…,"")))` ——
  **J 为空或写成"市场"这类非逐字名称时，三个分支全部落空，K 一声不响地回空串**，
  L（评估价值）也跟着空。
  于是：汇总表没有结论，而报告与结果 JSON 里可能写着数字 —— 两边不一致，却没有任何一处报错。
- `check_workbook_contract.py` 新增 `check_conclusion_method`：填了建筑面积的行必须写明
  「采用的方法」，且只能是 `市场法` / `收益法` / `成本法` 三个逐字名称；合计行不是数据行
  （它的 F 是 `=SUM(…)`），不参与检查。`references/06` 同步补上这条规则（契约正文与校验脚本一致）。
- 新增 3 条断言：填了面积没写方法 → 红且说清"静默回空串"；写了"市场"这种非逐字名 → 红；
  逐字写对 → 通过（证明前两条不是因为别的原因红的）。另加 1 条：**随包模板自己必须过这条新规** ——
  第一版忘了排掉合计行，模板当场被判不合格，那正是这条断言的来历。

**「三者一致」补上 JSON ↔ 底稿的方法一致性（2026-10-12，协议 32 · 验收 §16）**

- §16 写"HTML、JSON、XLSX 三者结论一致"。实际只做到两半：HTML↔JSON 由 `--html` 严格核对；
  XLSX 那一侧只有结构检查（隐藏表、错误值、关键公式在不在）。**JSON 的 `method` 与底稿汇总表的
  「采用的方法」列从未比过** —— 而这两者不一致比数字不一致更早出问题：汇总表按 `J` 列选单价
  （`SEARCH("收益法",J)`），J 写错等于结论来自另一个方法。
- `validate_result.py --workbook` 新增 `check_method_agreement`：JSON 的 `method` 必须出现在
  汇总表「采用的方法」列里（逐字映射 `market→市场法` 等）；没有数据行时不参与检查
  （模板本身就是那种形态）。新增 2 条断言：方法不一致 → 红且说清"口径必须一致"；
  写成 JSON 那一份 → 通过（证明前一条不是因为别的原因红的）。
- `references/09` 新增一张**能力边界表**，把"三者一致"到底查到哪一步逐格写明：
  报告↔JSON 严格、JSON↔底稿只查**方法与结构**、**底稿数字↔JSON 数字本机查不了**
  （比较需要重算后的值，而 openpyxl 不算公式）—— 最后一格是**已记录的能力缺口**，
  不是"已经查过了"，所以交付前要真打开一次底稿重算，由人核对汇总表结论。

**测试目录分层（2026-10-12，协议 32 · Task 3 第六批 / 方案 §4.4）**

- `tests/unit/` 的 93 个平铺测试文件按**被测的那一侧**分成三层：`client/`（18）、`host/`（71）、
  `shared/`（4，含契约与 Wire 层）。测试发现用 `tests/**/*.test.mjs` 递归 glob，不动就能找到。
- 搬迁本身是机械的，**代价在路径基准**：测试下沉一层之后
  `new URL('../../', import.meta.url)` 会指到 `tests/` 而不是插件根 —— 报错是"找不到模块"，
  而真正的信息是"你少写了一级 `../`"。这一版一共修了三类基准：
  ① `new URL('../../../', import.meta.url)`（86 个文件）；② `new URL('../helpers/...')` → `'../../helpers/...'`（19 处）；
  ③ `dirname(dirname(dirname(...)))` → 四层（2 处，`host-bin-manifest` / `host-skills-guard`，
  它们按 dirname 算插件根）。另有 2 个文件按仓库根算路径（CI workflow 与文本卫生），各加一级。
- 新增 2 条护栏：`tests/unit/` 根下不许再有测试文件、三层都要有真实数量；
  **测试文件的路径基准必须与它的深度一致**（扫 `new URL('../../', …)` 与 dirname 层数）。
  这条护栏自己踩了两次坑，都记在代码注释里：① 自排除写成硬编码路径，文件一搬排除就失效，
  于是守卫开始报自己那份"旧路径清单"——改成按 `import.meta.url` 算；② 判据用
  "匹配三级 dirname" 会命中四级形态的**尾巴**（`d2(d3(d4(fileURLToPath`），于是把修好的也报出来 ——
  改成**数 `dirname(` 的个数**。
- `scripts/` 与 `src/host/consts.ts` 里 4 处指向测试文件的注释路径同步跟上。

**指令补齐 §12 的清单项：案例筛选规则与压缩包口径（2026-10-12，协议 32 · 验收 §16/§12）**

- 逐条比对 §12 的 Prompt 契约清单时发现两项**只在别处存在、指令里没有**：
  ① **案例筛选规则** —— 指令只说了"不许编造案例、只用有证据的"，没写**判据**（可比性三条件、
     挂牌≠成交、剔除也要留痕、数量不足照实说）。这些判据在 `references/04` 里有，但子会话
     按指令办事：指令不说，它就会自己定一套，而"自己定的一套"事后无法复核；
  ② **压缩包不自动展开**（§5.1 的口径）—— 资料里出现压缩包时没有任何交代，子会话很可能去试着解压。
- 指令新增两段：`## 案例筛选规则`（五条硬规则 + 指向 `references/04-case-selection.md` 的细则）
  与 `## 压缩包`（按未解析登记、写进 `capability_gaps[]`、不要尝试解压、不要按文件名猜内容）。
  只写"要判可比性"是没用的 —— 判据本身必须在指令里，细则才指向 references。
- 新增 1 条断言逐字钉住这两段的 11 个要点（缺哪一条就等于让子会话自己定规矩）。

**知识来源可追溯从"写在 JSON 里"变成"对着快照核"（2026-10-12，协议 32 · 验收 §16/§1）**

- 验收审计抓出**第六处**：§1 要求"所有结果可追溯到…知识来源"，§16 要求"每次结果记录知识来源"。
  但 `knowledge_sources` 是子会话**自己写进结果 JSON** 的，而本轮实际取到的正文在
  `知识快照/.知识来源.json`（取数工具落盘）。**两者从未比对过** —— 结果里可以出现一份
  根本没取到的路由、或者把 `digest` 抄错，格式完全合法，事后复核的人只能去翻目录。
- `validate_result.py` 新增 `check_knowledge_traceability`：结果里的每条路由都必须在快照里、
  指纹必须一致；**快照里有 `dws` 来源却没写进结果同样不合格**（那等于把"用了降级备份"
  说成"用了知识库"）。快照不存在时**只提醒跳过**（老案例没有这个文件，协议 32 之前的产物）。
- 新增 2 条断言覆盖四种情形：一致 → 通过；凭空捏造的路由 → 红；指纹不一致 → 红；
  漏登知识库来源 → 红；无快照 → 只警告不失败。`references/09` 的规则 4 同步补上这条口径。
- 写测试时第二次撞上 CLI 守卫（脚本里出现知识来源的**字面量**被判成"间接旁路"）——
  解法仍是**从拥有这些取值的地方读**（`validate_result.py` 的常量元组），而不是把字面量拆开写。

**案例证据：从"字段在那儿"到"点得开、标得清"（2026-10-12，协议 32 · 验收 §16/§10.3）**

- 验收审计抓出**第七处**：§10.3 把「证据截图或页面快照」列为案例必备字段，§16 要求
  「案例有 URL、抓取时间和证据」—— 但**校验从不看 `evidence`**：`url` / `captured_at` /
  保留剔除理由都查，唯独证据不查。而工具在证据落盘失败时只把一个**空串**留在案例上，
  同时推一条 capability gap —— 于是"页面取到了、案例也解析出来了、证据其实没留存"这条路径
  产出的是**格式完全合法**的结果，且引用为空。
- **空串分不出两件事**："没留存"和"这段代码漏了赋值"。所以 Host 侧新增 `evidence_missing`
  显式标记（`evidence.trim() === ''` 即 true），缺口文案同时点明"该页案例不得直接当可比实例使用"。
- `validate_result.py` 补两条：① 案例必须有 `evidence`，或显式标 `evidence_missing`
  （且标了就**不许** `used_as_comparable`）；② `evidence` 指向的文件必须在案例目录内**真的存在**，
  越界（`..` / 绝对路径）一律不合格 —— 「证据丢了却说有」比「没有证据」更危险。
- 三处一起绑：`market-search` 的 `SearchCase`、`valuation-case.schema.json`
  （新增 `evidence` / `evidence_missing` 两个必需字段）、`validate_result.py`。
  第 15 轮建立的 schema↔样例绑定当场生效：**案例样例因为少了 `evidence_missing` 被判红**，
  补齐后通过 —— 这正是那条绑定存在的意义。
- 新增 3 条技能断言（空串且未标记 → 红；显式标记且不当可比 → 通过；标记了却当可比 → 红；
  证据文件被删 → 红；`..` 越界 → 红）与 2 条 Host 断言（有证据的案例不得标成缺证据；
  注入写失败后案例必须显式标记且缺口文案点明不得当可比）。夹具补了"写失败注入"能力，
  并把"案例目录里的证据文件"真造出来 —— 不然所有用例都会因为新规则而红。

**§16 验收矩阵成文，并给"表变旧"加了守卫（2026-10-12，协议 32 · 方案 §17）**

- 新增 `docs/acceptance-0.0.42.md`：把 §16 的每一条验收标准对应到**删掉它就放走什么**的那一处
  强制点，逐条写断言原话；**对应不上强制点的一律记成能力缺口**，不写成"已满足"。
  这正是 §17 要的那份验收报告，只不过落在文件里而不是只出现在对话里 —— 它下次还能被复核。
- 写这张表的过程本身筛出了东西：**第 7 节"能力缺口"一节能列这么长**（截图、真机 URL 模板、
  默认浏览器登录、扫描 PDF/图片、底稿数字↔JSON 数字、DSW 七节点是否真实存在），
  说明前 6 节的"已满足"是**有边界**的，边界必须一起写出来，否则读者会以为"三者一致"是全查的。
- 新增 `tests/unit/host/host-acceptance-matrix.test.mjs`（2 条）守住这张表：本文件里每个 `「…」`
  引用必须是**测试源码或技能校验脚本里逐字存在**的断言原话；数据行必须有第三列；
  能力缺口必须单独成节。约定写进正文：「`「…」` 只用来引用真实断言，UI 文案/字段名用引号」。
- 这条守卫当场抓出 **5 处不实引用**（我按记忆写的断言名）：`host-valuation-providers.test.mjs`
  这个文件根本不存在、`01 缺失时停止` 的实际名字是「必需知识「01-房地产估值通用」两边都缺 →
  **停止估值**」、`host-audit-spawn` 的成员关系断言名、客户端"不伪造进度"的完整用例名、
  以及两条把**描述**当成断言原话的写法。**一张声称"某处有强制"的表，最危险的就是它自己变旧** ——
  这种错在没有守卫时只会在事后复核时暴露，而那时它已经骗过了一次验收。

**装配漏接从"默默降级"变成"编译不过"（2026-10-12，协议 32）**

- `apply.ts` 给 Tool 闭包的依赖加了一个**全字段必需**的类型视图 `AssembledToolDeps`
  （`ToolDeps & Required<Omit<ToolDeps, 'ctx' | 注入点>>`）。动机来自第 16 轮那次真实险情：
  给估值工具加 `valuationLifecycles` 时，如果漏改 `apply.ts`，**所有测试照样全绿** ——
  因为工具会优雅降级成一句 warning（"轮次状态没能回写"），界面则永远停在"正在跑"。
  这类漏接不崩、不报错，只让某个功能默默降级，是最难发现的一类问题。
- 加这个类型视图**当场就找出两处**：`ifind` 与 `ifindTimeoutMs` 从来没有在 `apply()` 里接过。
  查过之后确认它们是**故意不接**的（前者是测试注入点，缺省就是真实传输；后者是有默认值的调优项），
  于是把这两个名字写进 `InjectionOnlyToolDeps` 并说明"没有第三条"：新加的可选依赖若不属于这两类，
  就必须在 `apply()` 里接上。**名单本身就是"我们想过这两个字段"的记录**，比散在注释里可靠。
- 验证方式是**让守卫响一次**：临时往 `ToolDeps` 加一个 `probeForAssemblyGuard?: string`，
  `npm run typecheck` 立刻在 `apply.ts` 报 TS2322；撤销后恢复干净。没响过的守卫不算守卫。
- `docs/acceptance-0.0.42.md` 新增第 7 节"构建期保证"，把这条与 `smoke-built.mjs` 的
  "注册面 = 业务工具集"一起写明 —— §16 之外还有一类失败是靠**编译期与构建产物**挡住的。

**估值 intake 真正跑起来了：两处"没人跑过所以没人发现"的缺陷（2026-10-12，协议 32 · §5.1/§5.4）**

- 起因是给 `valuation-intake`（确认抽屉的唯一数据来源）**补第一条测试** —— 这个操作此前
  **一条测试都没有**（现有 intake 测试全是纯函数：扩展名判定、清单指纹、去重）。补测试的过程
  直接抓出两个真实缺陷：
- **① 复制被 Broker 拒掉（功能整个不成立）**：intake 是**面板**操作，却借用了审核子代理的
  `system.case-file.write` —— 那条的来源只允许 `audit-tool`。于是生产里**每一份资料**都会得到
  "不接受来自「panel」的调用"，用户看到的是"所有文件都没解析"，而单测全绿。
  修法是给面板这条能力**自己的名字**：新增操作 `system.valuation-material.copy`
  （`capability: system-integration` · `transport: shell` · `privileged: true` · 只允许 `panel`），
  与 `system.local-audit-material.snapshot` 同一条判据（源路径是用户选的本机文件，可能在工作空间之外）。
  **不把 `panel` 加进 `system.case-file.write`**：那会把"审核子代理在案例目录内建/删文件"这条窄边界
  悄悄放宽成"面板也能借它跑复制命令"。
- **② 抽屉的"已知信息"永远是空的**：`extractedFields` 一开始就初始化为空对象、**再没被填过**，
  而每份文件都写 `status: 'parsed'`（那个 `parsed` 实际只表示"复制成功"）；`deps.python` 一直装配着
  却没人用。于是抽屉必然是"12 项全缺 + 每份都写着已解析"——那不是让用户核对输入，是让他对着空表点确认。
  现在 intake 会**真的跑一次提取**（复用 `runExtraction` + `pythonFileExtractor`），填出已知信息与
  缺失清单，并把预览落盘成 `资料提取预览.json`（确认与结果之间要有据可查）。
  「复制成功 != 解析成功」：提取器没读过的那一份状态改成 `unparsed` 并写清原因。
- 新增 2 条 intake 断言：提取成功 → 已知信息进抽屉、`missingFields` 不再是 12 项全缺、文件
  `fieldCount > 0`；没有 Python 提取能力 → 文件照样归档但**不许**写 `parsed`，且 12 项全缺（不编造）。
- 新增 `tests/unit/host/host-access-source-policy.test.mjs`（2 条）：把 `src/host` 里每个调用点声明的
  `{ operation, source }` 与操作描述表对一遍 —— **借错操作当场变红**。验证方式是**让守卫响一次**：
  把 op 名改回 `system.case-file.write`，它立刻报
  「src/host/operations/report-evaluation.ts:638 system.case-file.write 不允许来源 panel（允许：audit-tool）」。
  第二条反向查"登记了没人用"（保留项要显式列出来并写原因）。

**估值操作的外部抓取通道改为可注入（2026-10-12，协议 32）**

- 沿着上一轮那条教训往下查：8 条估值 RPC 里**只有 `valuation-browser-preflight` 一次都没被测过**
  （正好是 §16 的「页面可通过默认浏览器登录」）。补它的测试时发现根因是**通道写死了**：
  `createValuationOperations` 里 `const transport = fetchTransport({})`，于是
  ① `valuation-intake` 每开一次确认抽屉都要**等三家站点的真实网络**（离线就等到超时），
  ② 这两条操作在测试里根本没法跑 —— 而"没人跑过的操作"正是最容易坏的那一类。
  改为与估值 Tool 同一条口径：`ValuationOpsDeps.transport?`，缺省仍是真实 `fetch`。
  **实测效果**：`host-valuation-ops.test.mjs` 从 ~13 秒（每条 intake 用例 6 秒网络等待）降到 0.16 秒。
- 新增 3 条断言：预检只打开**该站点自己的**登录页（逐字比对 `siteOf(id).loginUrl`），
  结果里**不许出现任何令牌类字段**（cookie / authorization / token / sign=），
  三家状态都要回给抽屉；未知来源 → 拒绝且**一个 shell 命令都不发**；
  没授权 → **不许真的打开浏览器**，且如实回 Broker 的原话（不许静默）。
- 修夹具一处自欺：把 `state`（内含 `grantedConsent()`）递给 Broker 会**覆盖**未授权默认值，
  于是"未授权"用例实际跑在已授权状态下 —— 第一次写就是这么错的，现在显式换成 `missingConsent()`。
- 新增静态守卫（上一轮那条）当场发挥作用：`system.browser.open` 的来源声明若与操作表不符，
  它会在跑测试之前就报出来。

**交付件链路打通一层集成测试（2026-10-12，协议 32 · §4.4 / §14）**

- 新增 `tests/integration/report-evaluation/valuation-deliverable-chain.test.mjs`：五步真实链路 ——
  **真 docx + 真 xlsx → `extract_files.py` → `build_workbook.py` → `check_workbook_contract.py`
  → `build_report.py` → `validate_result.py --html --workbook`**。
  为什么需要这一层：各脚本自己的用例都过，也不代表**它们之间**对得上 ——
  字段名、值 JSON 的形状、结果 JSON 的字段，在各脚本用例里都是被夹具"喂"出来的，
  任何一处改名，单脚本用例照样全绿。（这也把方案 §4.4 的 `tests/integration/` 填上了真内容。）
- Python 解释器**按 glob 找 DSH 自带运行时**（`~/.dsh/dsh-runtimes/*/dependencies/python/bin/python3`），
  不强写绝对路径、不假设系统 `python3` 有 openpyxl/python-docx；找不到就 `skip` ——
  跳过好过用错解释器得出假结论。
- **这条测试第一版是"永远绿"的**（值得记）：`extractedFields` 的值一律是**原文**
  （"120.5 平方米"），我直接 `Number(...)` 得到 NaN，而 `JSON.stringify(NaN)` **静默变成 `null`**
  → 底稿那一格空着 → 汇总表没有数据行 → 方法一致性检查**整条跳过**。改成真的解析（并断言解析成功）
  之后，注入"底稿写市场法、JSON 说收益法"立刻变红。**没响过的测试不算测试**，这一条也一样。
- 顺带修掉链路暴露的一处**假计数**：`build_workbook.py` 把 `None`（"这一项未知"是合法输入）
  也算进"填入 N 个输入单元格"，而那一格其实是空的 —— 复核的人正是照着这句话判断"该填的都填了"。
  现在分开报「填入 N 个 / M 处按未填置空」，并新增 1 条断言（技能契约测试 47 → 48）。
- 另一处小发现：`extract_files.py` 的结果写在**文件**里而不在 stdout（表格可能被截断），
  集成测试第一版读 stdout 只得到 `Unexpected end of JSON input` —— 这个约定本身是对的，
  记下来是因为它正是"接口约定"那类只有跨脚本才暴露的东西。

**真实浏览器验收跟上已实现的模块（2026-10-12，协议 32 · §4.4 `tests/browser/`）**

- 抓出一处**没人会发现的漂移**：`install/browser-check.mjs`（真机验收的唯一自动化手段）
  还在断言「报告评估」是 **Coming Soon 占位页**（"整页只写开发中"），而那个模块早已实现。
  它一直没红的原因是这条验收**必须有人起一个装了插件的 DSH profile、再装 playwright 才能跑** ——
  于是"唯一能自动验收真机行为"的脚本，自己没人跑。
- 按已实现的面板重写那一段断言（这些是**只有真浏览器**能证明的）：面板真的画出来
  （`.crwu-valuation`）；**四种方法**都在且是可选的单选组；**打开页面不弹确认抽屉**
  （确认是用户的动作，不是页面的）；没选资料时「开始估值」**是禁用的**并说清缺什么；
  禁用状态下点了也**不弹抽屉、不造假进度**。
- 侧栏那枚「开发中」小标签的断言**反过来了**（现在三个子项都不该有）——
  "反过来这件事本身"也要断言：旧断言会一直绿到有人真跑一遍为止。
- 新增 `tests/unit/client/client-browser-check-drift.test.mjs`（2 条）做**静态交叉核对**：
  注册表说 `underDevelopment: false`，浏览器验收里就不许还留着占位页文案与「开发中」标签断言
  （反之亦然）；并要求脚本里存在面板的真实断言。另加一条：脚本里**任何 `.click(` 都不许**
  落在「AI 审核 / 开始审核 / audit-start」上 —— 那会跑一次真实审核、写真实工作空间与 OSS。
  验证方式是**让守卫响一次**：把注册表改回 `underDevelopment: true`，它立刻报
  「报告评估还是占位页，浏览器验收却没有断言它是 Coming Soon」；恢复后绿。
- 写断言时还改正了自己一处**想当然**：本以为是"点了「开始估值」应当报错"，
  实际面板是**禁用按钮 + 一句说明**（比点了再报错更强）。浏览器断言必须照真实 DOM 写。

**面板建案例子目录必须提权（2026-10-13，协议 32 · 用户实测）**

- 症状（用户原话）：创建资料目录失败 `mkdir: /Users/…/中瑞世联工作空间/估值-…/材料-源: Operation not permitted`，
  诊断行是「操作 `system.case-file.write` · 来源 `audit-tool` · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是」，
  估值会话因此建不出来。
- 根因在 `broker.ts` 的一行：`const escalated = decision.sandboxPolicy !== undefined` ——
  **特权**操作逐次声明 `danger-full-access`（不依赖会话）；**非特权**操作要把`调用方会话`的策略放进请求
  （`callerSessionPolicy(ctx, options.session)`），而**面板没有会话** → 策略 undefined → 执行器落回
  部署默认（进程 cwd）→ 案例目录不在可写根之下 → 系统拒绝。
  `ensureDirectory` / `removeFileIfExists` / `probeCasePath` 这套 helper 的判据正是
  "审核子代理的沙箱边界本来就是本轮案例目录"，所以它们**只对子代理成立**。
- 这是我上一轮那次修复的**兄弟调用点**：round 27 我给资料的**复制**加了面板专属的提权操作
  （`system.valuation-material.copy`），却漏了它**前面**的建目录 —— 同一次交互里改了一处、漏了邻座。
- 修法：新增 `system.valuation-case.directory.write`（`capability: system-integration` ·
  `transport: shell` · `privileged: true` · 只允许 `panel`）与 `ensurePanelCaseDirectory()`，
  与案例目录本身（`system.case-directory.write`，提权）和资料复制同一口径：
  **面板来源的能力各自有名、各自声明提权**，不借子代理那套。边界仍由路径决定 ——
  路径由 Host 从工作空间与估值 ID 推出，模型提交不了。
- 两条守卫，都**验证过会响**：
  ① 行为断言（`host-valuation-ops.test.mjs`）：`材料-源` 相关的每条命令都必须是 `danger-full-access`；
     把调用改回 `ensureDirectory` 后，它当场报「（无策略）· mkdir …/材料-源」——与线上症状逐字对应；
  ② 静态断言（`host-access-source-policy.test.mjs`）：**操作层**不许出现
     `ensureDirectory(` / `removeFileIfExists(` / `probeCasePath(`，防止下一个面板操作再犯。
- 夹具补了"记录每次 shell 调用的沙箱模式"（`shellCalls`）——没有这个观察点，这类缺陷只能靠真机撞。

**面板本机选择器的接线（2026-10-13，协议 32 · 用户实测）**

- 症状（用户原话）：插件页出现「当前运行环境拿不到本机绝对路径，无法选择文件：请在 DeepSeek Harness 桌面端打开本页」。
- **三处漏法**（都在"线有没有接上"，不在选择器本身）：
  ① `hostPaths` **从未接线**（`apply.ts` 与 `WorkbenchPanel.tsx` 都只传了 `fileInput`）——
     现代 Electron 已移除 `File.path`，绝对路径只能由 `__DSH_HOST_PATHS__.pathFor` 提供，
     所以**桌面端也拿不到**：那句"请在桌面端打开本页"是个无法兑现的承诺；
  ② `uiWorkspace.pickDirectory` 在装配时**快照**（`...(services.uiWorkspace?.pickDirectory === undefined ? {} : …)`）——
     服务晚注册就永远不可用（2026-10-11 本地审核为此专门改过 getter，这次又犯了一遍）；
  ③ 端口对象 `{ ...services }` **展开**会把 getter 求值一次——即使调用方改成 getter 也没用。
- 修法：把两条能力做成**活的**适配器 `hostPickerCapabilities(source, extra)`（getter 现读），
  两个装配点共用一份；控制器端口改为逐条 getter 转发（不再展开）。
- 顺带补上**漏接的环境门禁**：`port.ready` 两个装配点都没给，而控制器里是
  `port.ready?.() ?? { ok: true }` —— 于是"环境没就绪也能起估值"。现在两边都按
  「自检拿到结论且全部通过」现读判定，文案新增 `valuationNeedEnvironment`。
- 新增 `tests/unit/client/client-picker-wiring.test.mjs`（5 条）：接了路径桥就必须拿到绝对路径、
  **能力晚于装配才出现也要认**、控制器端口不许展开成快照、门禁不过时一个请求都不发、
  两个装配点必须走同一份适配器。两处注入原缺陷都验证过会红。

**工作台导航改成「一级目录 + 二级目录」（2026-10-13，同一版）**

用户口径：面包屑不如两级页签 —— 一级目录表达业务大类、二级目录表达该业务下的功能页面，
页面内容始终跟着二级目录。改动**只在客户端**（估值 RPC、状态机、只读确认抽屉与结果字段一个没动）。

- 新增 `src/client/shell/navigation.ts`：唯一的结构来源。一级 `估值 / 审核 / 其他业务`，
  二级 `房地产 / 土地 / 机器设备`（后两项 `enabled: false` = 灰态「开发中」）与
  `报告审核 / 本地审核`。节点声明 `label`（页签）/ `page`（画哪一页）/ `enabled` / 页面标题；
  **门禁判据仍从 `MODULE_META` 派生**（`requiresEnvironmentOf` / `requirementOfNode`），
  不在表里再抄一份布尔量 —— 加一级 / 二级目录 = 只加一条元数据。
- `module-store` 的落点从"一个模块"变成"一级 + 二级 + 正文"：`navigateParent()` 在**一次 `emit`**
  里改完整组（订阅者只收到一次通知），所以不存在"一级已经切了、二级还显示旧目录"的中间帧；
  每次切一级目录都**默认选中第一个可用页面**（不记忆上一次的二级页面）；空目录落到
  `kind: 'empty'` 并显示「该业务目录暂未开放」；`enabled: false` 的二级目录**不可进入**
  （判据在 store 里，不是只把按钮画灰）。
- `WorkbenchPanel`：面板顶部固定两级页签（一级沿用既有报告审核页那种 44px + 底部强调线的页签，
  二级是更轻的浅色胶囊），两级都是标准 Tab 语义（`role="tablist"` / `role="tab"`、`aria-selected`、
  全部指向**同一个内容区**的 `aria-controls`、roving tabindex、左右键循环、Home / End）；
  页面标题按导航元数据渲染（估值 / 房地产 → 「房地产估值」），写死的「报告评估 / 房地产估值」抬头删掉。
  只有一个 tabpanel（内容区在切换时**不重建**），滚动位置与宽度因此稳定；目录条长在滚动容器外面，
  所以始终留在页面顶部。
- **环境信息不再是目录里的一页**：它是外层门禁态（环境没过时的统一落点 + 员工自己去看配置的入口），
  不占页签；从它回工作台给一颗「返回工作台」。环境已通过后估值 / 审核页面不再展示任何环境信息
  （没有「环境已就绪」胶囊、没有检查详情）。
- **草稿与轮询的持有者**：估值控制器仍在 `apply()` 层，切一级目录不丢已选资料 / 方法 / 基准日 /
  补充要求；估值阶段轮询改由**面板**持有（`useValuationPhase`，只在 queued / running / 等登录时开定时器），
  切到别的目录不会把它停掉 —— 顺带修掉一个真缺陷：`controller.poll()` 此前没有任何地方调用，
  页面会永远停在「估值进行中」。
- 估值输入页按用户给的结构重排：抬头（导航元数据）+ 双栏（左：资料 / 文件列表 / 份数统计与解析状态，
  右：方法 / 基准日 / 补充要求），窄屏（<960px）自动单栏；主按钮文案改成「开始提取资料」
  （确认抽屉里那颗才是「确认并开始估值」）。
- 测试：`client-module-gate.test.mjs` 重写为两级目录 + 落点的断言组（含"一次通知改完整组"、
  "默认选第一个可用页面"、"开发中不可进入"、"空目录"、"恢复被拦目标只恢复最近一次"）；
  `client-package.test.mjs` 新增面板级渲染断言（两级页签结构与切换、空目录、开发中、
  估值页不展示环境信息、切目录不丢草稿、轮询不被切目录停掉）；`install/browser-check.mjs`
  的真机断言同步改成两级目录（一级 44px + 3px 强调线、二级更轻的胶囊、`aria-controls`
  指向同一内容区、纸里的 surface 不画第二层框）。


### 导航分模块 + 估值单工作面 + 样式作用域（2026-10-13，协议 32 → 33）

用户在截图里点出的问题：左右 50%/50% 双栏内容失衡、卡片过多、方法选项过高、主操作被挤到屏幕下方；
以及点「开始提取资料」之后**没有反应**。这一批按"单个工作面 + 纵向任务流"重做输入页，
并把之前靠"命名前缀"顶着的样式隔离升级成真正的组件作用域。

**导航：按模块分属两棵树**

- `NavigationNode` 新增 `module` 字段，`PARENT_IDS` 拆成 `PARENT_IDS_BY_MODULE`，`parentNodes(module)`
  只返回**这个模块**的一级目录。报告评估树里不再出现「审核」，报告审核树里也不再出现「估值」——
  以前一棵混着的树让用户看不出自己在哪个模块（截图里那个重复入口）。
- **没有已配置业务项的一级目录不画**：「其他业务」的元数据留着，但底下没有业务项，所以不出现在目录条上，
  不留"点进去什么都没有"的空占位入口。
- **页面身份变化时归零滚动位置**：内容区外壳不重建，`scrollTop` 会原样留到下一页。新增纯函数
  `pageIdentityOf()`（可断言），组件那侧只剩"身份变了就归零"这一句动作。

**输入页：一个工作面、一条纵向任务流**

- 删除 `.crwu-valuation-cols` 的 1:1 双栏：表单改单列、上限宽 1120px、宽屏居中；不再给资料区与设置区
  强设同一高度（那正是左边一大片空白的来源）；不再给每个字段套"卡片标题 + 卡片正文"，改用分区标题、
  间距与一条轻分隔线。
- 文件行改成：类型图标 + **文件名**（主标题）+ 大小 + 读取状态 + 移除；同名文件附目录摘要，
  完整路径留在 `title` 与详情里。文件列表有界高度（内部滚动），超过 8 份给「查看全部 N 份」。
- 四种方法改成**紧凑四项选择组**（容器查询：面板够宽一行四项、窄面板纵向），原生 radio 语义，
  当前选项的说明只在选择组下出现一次。
- 操作区是**面板内粘性**（`position: sticky`，不是宿主页面的全局固定底栏），始终显示资料数量与主操作；
  没选资料时主按钮禁用并在旁边写出原因（`aria-describedby` 关联）。
- 响应式以**面板实际可用宽度**为准（`@container crwu-valuation`），不是浏览器窗口宽度 ——
  宿主侧栏展开后窗口可能很宽、面板却只有 500px。

**「开始提取资料」没有反应：把长 RPC 拆成有反馈、可取消、可超时的链路**

- 根因：`valuation-intake` 在返回确认数据**之前**串行预检房天下 / 安居客 / 链家，每家最多 20 秒 ——
  三家连续失败时按钮要等约一分钟才有反应。现在 intake **不碰外部站点**：宿主只回三行
  「尚未检查」，真正的探测由 `valuation-browser-preflight` 在**抽屉打开之后**异步跑，逐家独立更新
  （一家超时不拖累另外两家），结果局部更新到抽屉里。
- 点击「检查并确认」**同一帧**就进入 `extracting`：按钮变「正在提取资料…」并禁用，输入全部锁定，
  页面出现 `role="status"` 的进度区。进度区显示的是**宿主报的真实阶段**（`valuation-status` 的
  `progress.stage`：正在检查资料 / 正在复制资料 / 正在提取文件内容 / 正在读取业务规范 / 正在准备确认信息），
  客户端不按计时器编阶段、不画百分比。
- 控制器加请求序号：`state.intakeRequestId`，只接受**当前**请求的响应；取消 / 返回修改后迟到的响应被丢掉，
  不会把抽屉重新弹出来。提取请求有有限超时（缺省 120s，可注入），超时进入**可恢复**的失败态，
  并明确说"不再等"而不是谎称宿主已停止。
- `valuationId` 在**点下去的那一刻**就写进 state（不再是 `start()` 的局部变量），所以提取过程中
  「取消提取」拿得到 id、能真的调 `valuation-cancel`。失败不丢资料 / 方法 / 基准日 / 补充要求。
- **基准日契约补全**：`valuation-intake` 入参新增 `baseDate`，宿主应答从写死的空串改成回显用户提交的那一份
  （旧宿主会静默丢掉用户选的基准日，结果里却写着"未指定基准日"）。客户端仍逐字提交、不拿资料里的日期补。

**样式分层与作用域（§6）**

- `shell/consts.ts` 不再承载全部业务 CSS：样式按所有者拆到 `styles/`（tokens / base / scope / scope-css /
  bundle / install）、`ui/styles/`（button / card / drawer / dialog）、`shell/styles/`（layout / navigation /
  sidebar）、`modules/<模块>/styles/`。类名常量留在各自模块。一级 / 二级目录的样式从本地审核模块搬回 shell。
- 每个**独立挂载点**（主面板、侧栏展开态与轨道态、会话头按钮、Cordis 运行卡片、抽屉）都带
  `data-crwu-scope="workbench"`；主题变量定义在**作用域节点**上（不是 `.crwu-audit-root`，那个类还带布局规则），
  深色读 `body[data-ds-dark-theme] [data-crwu-scope="workbench"]`；变量**不**挪到 `body` / `:root`。
- 规则由 `scopeCss()` 统一加 `:where([data-crwu-scope="workbench"]) ` 前缀：`:where()` 权重为 0，
  所以加作用域**不改变原有层叠关系**，不需要 `!important`。作用域节点自身的规则
  （`.crwu-audit-root` 与 token 块）写成"作用域在自身上"的形式 —— 后代式前缀对它们永远不命中。
- 清理：删掉末尾补丁式的"迁移覆盖层"（把取值并回原规则）、删掉报告评估 Coming Soon 占位页与它的
  12 个类名常量（已被真实面板取代）等死代码。
- 安装：单一入口 + **按 document 引用计数** + **内容始终刷新**（以前查到同 id 节点就直接返回，
  开发重载改了 CSS 也看不到变化）；清理函数幂等，多个活跃实例互不误删。

**只读确认抽屉：把方案 §5.4 的十条补齐**

- **完整业务提示词可折叠查看**：`valuation-intake` 用**与 `valuation-start` 同一个构造器、同一批参数**
  生成提示词并回传，所以只要快照指纹一致（`valuation-start` 会核对），用户看到的就是执行时逐字发出去的那一份；
  宿主没回传时如实说"没有回传"，不编一份像提示词的东西。
- **每项关键事实的来源**：`valuation-intake` 新增 `fieldSources`（标签 → 文件名），来源与取值走**同一条判据**
  （谁的值被采用，来源就是谁）。提取器以文件为粒度、不回页码 / 工作表位置，抽屉里如实写明这一限制。
- 知识来源逐条给出**路由 + 来源 + 更新时间 + 正文指纹**；自动判定时写明「执行时按规则判断」；
  取证能力如实说明（本部署没有页面截图能力，证据是页面字节与指纹，不是截图）。
- **焦点管理**：抽屉打开时焦点进入「确认并开始估值」；关闭 / 返回修改后焦点回到「检查并确认」
  （抽屉整个卸载后，只能由仍在的那一侧接手）。

**用用户实际模板 + 模板可追溯（方案 §7.1）**

- `build_workbook.py` 在动手**之前**先拿工作簿契约验一遍**模板本身**（表名、表序、公式链、
  勾稽行、汇总依据三行）：不合格就拒绝生成并列出问题。§7.1 的"不能自行生成一个外观类似但结构不同的
  替代模板"因此是可执行的 —— 少一张表或表名不同的仿制模板不会再填完一轮才被发现。
- 加 `--template` 就必须用它：模板缺失会**直接报错**，不静默回退到随包模板；生成结果里打印实际用的
  模板路径与 `sha256` 指纹（并标注"随包模板 / 用户·知识库模板"），事后能分辨底稿出自哪一份。
- 新增 3 条测试：给定模板必须被真的使用（改一处表头，产物里要带着那处改动）、仿制模板被拦下且
  **不留半成品**、模板缺失报错不回退。
- `references/06` 补「用哪一份模板」一节（下载的模板与填好的底稿都留在案例目录，不写回技能安装目录）。

**底稿补上「汇总依据与限制」三行（方案 §8「计算表填写」）**

- `估值结果汇总` 表新增「三、汇总依据与限制」：**权重 / 汇总依据**（多方法或多案例怎么汇总到最终采用单价）、
  **已知限制**、**待确认事项**。§8 点名要填的三项此前在前两表里放不下（逐案例字段承载不了"整体怎么汇总"
  与"整体有什么没定"）。三行是**输入区**，`build_workbook.py` 可写。
- 工作簿契约新增 `REQUIRED_SUMMARY_ROWS`：三行必须存在（整行删掉 → 报"缺少该行"），
  不是"记得填"。
- `validate_result.py --workbook` 新增 `check_confirmation_items_in_workbook`：`manual_confirmation_items`
  每一条都要出现在底稿的「待确认事项」行里 —— 报告上写了限制、交出去的底稿上看不出来，
  是复核时最难发现的一类不一致。
- `references/06` / `references/09` / `SKILL.md` 同步；`references/09` 的「三者一致」表补一行"留痕一致"。

**把视觉验收的要求落进真机脚本（方案 §10）**

- `install/browser-check.mjs` 新增两段：**主题作用域**（逐个挂载点读 `--crwu-*` 的计算值；
  把 `body[data-ds-dark-theme]` 翻一次、确认取值**真的变了**（证明深色块命中作用域节点）再原样还原；
  顺带量一个宿主自己的普通按钮，确认插件没有改动宿主的字号与盒模型）与**面板窄宽切换**
  （收起侧栏让**面板**变窄，断言工作面两态都无横向溢出，并记下方法组的排布方向）。
  三张截图（工作面宽 / 窄、侧栏轨道）落进验收产物目录。
- 本机没有浏览器，所以视觉验收只能由人跑 —— 但**要求本身**现在落在脚本里（并有一条测试盯着它别被删掉），
  人工执行时不会漏项。抽屉打开态与运行/失败/结果三态自动化做不到（要先选真实文件 / 真跑一轮），
  已在 §6 能力缺口里单列。

**结果页给出案例来源 + 规则只在适用方法里执行（方案 §9 第 3 条 / §8）**

- 结果页的「规则校验摘要」补上**按来源汇总**（每家共几条、其中采用几条）与案例表的**来源**列 ——
  §9 第 3 条要的是"最终采用案例数量、**来源**及规则校验摘要"，只给总数看不出"结论压在几个站点上"。
  来源与展示名都空时不参与分组（不制造一行没有来源名的假分组）。
- `validate_result.py` 新增 `check_rules_match_method`：**比较案例的调整规则（20% / 30% / 1.2）只在市场法里执行**。
  套到收益法 / 成本法上是真实会发生的错误 —— 那两条方法里没有"可比实例修正系数积"这一层，
  判定看着像做了校验，实际是拿错口径在自证。

**方法判断记录与「不许静默切换」（方案 §7.2）**

- 结果契约新增两项必填：**`methodScreening`**（每条给出「采用 / 不采用 + 依据」，恰好一条 `adopted` 且与
  `method` 一致）与 **`methodConflict`**（用户指定的方法与结论不一致时必须给出双方与原因，没有冲突时显式 `null`）。
  "只写一句采用市场法"从此在契约层就缺了"其他方法为什么不采用"。
- `validate_result.py` 新增 `check_method_screening`：它会把结果与案例目录里的 `估值输入.json`
  （**冻结输入**，用户确认那一刻写死的那一份）对一遍 —— 用户指定 `market` 而结论是 `income`、
  `methodConflict` 又是 `null` → **判不合格**。§7.2 的"指定方法不适用时不能静默切换"因此是**可强制**的，
  而不是靠模型自觉。宿主完成门槛加同一条兜底（子会话跳过校验脚本也拦得住）。
- 结果页在结论**之前**给出方法冲突（`role="alert"`），并在「采用方法」下逐条列出方法判断记录
  （采用 / 不采用 + 依据）—— 用户选收益法、结果按市场法给数时，必须在第一屏看见。
- `references/09` 补第 1.1 条（两项的字段与判据）；schema 子集校验器补 `minItems` 支持
  （守卫要求"不许让不支持的 keyword 被静默忽略"）。

**交付校验进完成门槛（方案 §9：模板改坏 / 报告与结果对不上都不得完成）**

- 轮次记录新增 `validationPassed` / `validationProblems`，注册表新增 `setValidation`；
  `crwu_valuation_artifact_validate` 跑完两道校验后**把结论写回轮次** ——
  在此之前"交付前两道校验都过了吗"只有模型自己知道，而 §9 明确要求 `completed` 不能靠模型声称。
- 完成门槛因此多一条硬判据：**没跑过交付校验不算完成**（提示写明去跑哪个 Tool）；
  没过时把逐条原因带进 `progress.detail`（用户看得到差在哪）。
- **两道校验都跑过才算一次有效结论**：脚本没跑成（staging 失败）时按"没通过"记，
  不把"没跑成"当成"过了"。
- 写回失败**不影响校验本身的结论**（与其它工具写回同一条口径）：后果是这一轮停在 `running`，
  用户看得见，不该把一次成功的校验说成没过。

**抓取失败分类 + 跨站去重 + 案例扩展顺序（方案 §7.3）**

- 抓取通道新增 **`failureKind`**：`login` / `captcha` / `rate-limited` / `not-found` /
  `server-error` / `network` / `blocked` / `unreadable` / `unknown`，并带上人话与 HTTP 状态。
  排序原则是 **验证码优先于登录墙**（被验证码挡住时页面里常有登录表单痕迹，说成"需要登录"
  会让用户反复登录而永远过不去）。三次重试的记录因此可区分，而不是三行一样的 `HTTP 403`。
  「网络不可达」与「被拦到白名单之外」也各是一类 —— 前者换网络、后者是白名单的漏口要查。
- 新增 **跨站去重** `dedupeAcrossSources`：同一套房源（链家 / 贝壳、以及房天下与链家之间）
  按「小区 + 建筑面积 + 价格档」合并成一条，只留先出现的那条，并在留下那条的 `notes` 里写
  "与 <来源> 的同一房源重复"，检索应答给出 `dedupedAway`。
  三条口径都写进了测试：按 URL 去重是不够的（URL 本来就不同）；同小区**不同**房源（面积 / 价格不同）
  不合并；**拿不到面积或价格时不参与合并**（靠"小区相同"合并会把不同房源误判成一套 —— 比重复更危险）。
- `references/04` 补两节：案例扩展的**顺序与留痕**（同小区 → 同片区 → 面积段 → 时间，每轮记放宽了什么；
  "硬条件"任何一轮都不许放宽），以及跨站去重的口径（去重不等于删过程）。

**底稿与结果 JSON 的证据一致性（方案 §8「截图编号」/ §9 三者一致）**

- `validate_result.py --workbook` 新增 `check_case_evidence_agreement`：每个采用案例的 `evidence`
  必须出现在底稿「案例」表的**「案例截图 / 证据留档」**行里（整行被删掉也算不合格，不是"找不到就跳过"）。
  两处各写一份而没人比过，就会出现"报告说留了证据、底稿上却是空的"。
- `references/06` 补上这条规则；测试夹具同步把证据写进底稿（并记下一个 openpyxl 的坑：
  `cell(row, column, value=None)` 是"读"，清空单元格必须显式赋值）。

**抽屉动作按 §5 对齐 + 来源预检分类可断言（方案 §5 / §11.2）**

- 只读确认抽屉的动作改成 §5 点名的三个：**返回修改 / 重新检查 / 确认并开始估值**
  （原先第三个是"取消"）。「取消本轮」留在进度页与结果页 —— 那时才真的有一轮在跑 / 已跑完；
  确认之前用户要走开，返回修改就够了，而且那时还没建会话。
- 顶部「重新检查」与来源行里的那个重复，来源行只留「在默认浏览器登录」。
- 新增预检分类断言：网络不可达 / 超时、验证码或人机校验、登录墙、站点返回错误
  四类各给不同的话与不同的处置方向；验证码单独标 `captcha` 且明说"不绕过验证"。
  「页面结构无法识别」不在预检这一层报（预检看的是"站点放不放行公开检索"，首页本来就没有房源列表），
  它由检索那一步报「没有可用的结构化房源数据（不猜测）」—— 这一点写进了验收矩阵。

**规则检查记录与案例状态进契约（方案 §8）**

- 案例契约新增必填 **`status`**（六态：采用 / 条件不匹配 / 资料或证据不足 / 单项规则未通过 /
  综合规则未通过 / 组内一致性未通过）与 **`rule_checks[]`**（规则 ID、实际值、阈值、判定、理由）。
  "只写一句符合要求"从此在契约层就写不出来 —— 复核的人要能自己重算一遍。
- `validate_result.py` 新增 `check_rule_checks` / `check_case_status` / `check_group_ratio`：
  - 规则 ID 只能取那五个；阈值**逐字**等于知识库口径（0.2 / 0.3 / 1.2），不许自行放宽；
  - 数值型判定必须给出实际值；每条剔除案例至少要有一条 `fail` 且能对上它的 `status`；
  - `status` 与 `used_as_comparable` 必须一致；采用案例不许带着没通过的规则
    （例外只有 `R-GROUP-1.2`：规范允许"说明处置方式后保留"）；
  - **`R-GROUP-1.2` 的比值必须能从采用案例的比准价重算得到**（写一个好看的比值蒙不过去）；
    超过 1.2 却没有处置说明 → 红。
- 规则词表（ID / 状态 / 阈值映射）在 `market_rules.py` 里定义一次，契约侧比对同一套词
  （有一条测试盯着两边一致，避免"计算模块说超限、结果里记成别的"）。
- 宿主完成门槛加一条同样的兜底：子会话可能没跑校验脚本就结束。
- 结果页新增「规则校验摘要」：最终采用案例数、组内比值与阈值（超限明说并指向待确认事项）、
  逐条规则的通过 / 未通过数；案例表新增「案例状态」列。
- `references/02` / `references/09` 补上三条约束的计算口径与 `rule_checks` 的落法。

**市场法规则进可测试的计算模块（方案 §8 / §10）**

- 新增 `skills/biz/crwu-biz-valuation-realestate/scripts/market_rules.py`：把
  「单项修正 20% / 共同修正 30% / 修正后最高价与最低价比值 1.2」三条阈值做成**确定性、可测试、
  无第三方依赖**的计算模块。阈值与口径都有出处（`references/02-market-method.md` 第 9 节），
  不是照着提示词抄的：
  - 「不宜」是**软约束**：判定是 `within` / `at-limit` / `over`，超限要求说明处置方式，
    不是抛错、也不是把案例直接删掉；
  - **边界是"不超过"**：等于阈值算 `at-limit`（通过但要标注），带一个很小的相对容差吸收浮点误差
    （否则 1.2 会因为二进制表示被判成超限）；
  - **综合修正是各系数的连乘**，不是把百分比相加（两项各 +10% 是 21%，不是 20%）；
  - 取整用 Excel 的 `ROUND_HALF_UP`（比准价格 / 评估单价到十位、评估值到百位），
    不是 Python 的银行家舍入 —— 后者会让底稿（Excel）与 JSON 的数字对不上。
- 新增 `scripts/test_market_rules.py`（16 条）：三条阈值的等于 / 略低 / 略高、
  浮点边界、连乘 vs 相加、修正方向、取整口径、**阈值与知识库参考逐字一致**。已接入 `make plugin-check`。
- 完成门槛补两条（§8）：市场法**采用案例少于 3 条**时不许给出正式单价 / 总价
  （规范：不少于 3 个，且不得用 2 个案例直接平均后当结论）；**单价 × 计价面积与总价对不上**不算完成。
- `SKILL.md` 增加一节：这三条约束用 `market_rules.py` **算**，不要心算；`over` 要说明处置方式，
  组内比值超 1.2 时不许反复删高价低价去凑一个想要的估值。

**文件列表的四种形态（方案 §4 / §10）**

- 新增 5 条断言：少量文件逐份画出不折叠、大量文件（20 份）只画前 8 份 + 「查看全部 20 份」、
  长文件名的完整名称在 `title` 里查得到、解析失败逐份给出具体原因（而不是含糊的"未完成"）、
  扫描失败说清是"清单读不出来"而不是"你还没选"。

**结果契约补「计价面积 / 计价单位」，完成门槛加金额勾稽（方案 §8 / §9 第 1 条）**

- `估值结果.json` 新增必填 `pricingArea`（计价面积，㎡）与 `priceUnit`（计价单位，统一 `元/㎡`）：
  §9 第 1 条要的是"单价、总价**及计价面积、单位**"，只给一个数字、不说按多少面积算的，读的人没法复核。
- `validate_result.py` 新增 `check_pricing_area`：单位必须统一为 `元/㎡`（按套内面积 / 按套计价先换算）；
  有单价就必须有正数计价面积；**单价 × 计价面积 ≈ 总价**（允许 1 元舍入差）。
- 宿主完成门槛同步加一条：金额口径对不上不推 `completed`（三个数各说一套说明至少一个错了）。
- 结果页把计价面积与计价单位摆在单价 / 总价旁边。

**「部分结果」与失败阶段（方案 §4）**

- 状态机新增 `artifacts`（宿主报的交付件存在性）、`failedStage`（宿主最后报过的阶段）、
  `applyPartialResult` / `hasAnyArtifact`：轮次**失败或已取消但已有交付件**时，把宿主给的结果落下来，
  **阶段保持原样** —— 结果页打上「这是阶段结果，不是正式结论」的标记，数字照旧只给 `—`（不给 0）。
- 失败时把**失败阶段**写出来（"失败阶段：正在提取文件内容"）：阶段是宿主报的，客户端不猜。
- 修掉一处真问题：轮询会用空字符串**擦掉**上一份失败原因（界面只剩"原因见下"而没有原因）。
  现在宿主给了就用宿主的、没给就保留上一份、只有走到 `completed` 才清。

**资料冲突：不再静默取第一个（方案 §4 / §5 第 7 条）**

- `valuation-intake` 以前是"首个非空值胜出"、后面不同的一律丢弃 —— 两份资料对"建筑面积"给出两个数时，
  用户看到的是一张干净的表，而系统已经替他做了一个他没看见的选择。
- 现在逐要素收集全部取值，值不一致就进 `fieldConflicts`（附双方文件名与取值）、写进 `warnings`
  说明"当前采用哪一份"；值一致**不算**冲突（不制造噪音）。
- 抽屉新增「资料冲突」区块（标出当前采用的那一份）与「补充要求的性质」说明：
  补充要求里的事实记为「用户提供」，**不**当作文件原文。

**宿主隔离（方案 §10「插件加载前后，宿主普通按钮、输入框及文字样式不被改变」）**

- 作用域节点新增盒模型基线（`box-sizing: border-box`）：任何挂载点都不依赖宿主的盒模型。
- 估值按钮显式声明 `box-sizing`：作用域挡得住"插件的规则命中谁"，挡不住宿主把布局属性**继承**下来。
- 新增四条守卫：每条规则都在作用域内、主角不许是裸元素（`button { … }` 一类）、
  不许在 `:root` / `body` 上声明插件变量、插件控件自带盒模型与字体基线。

**完成门槛：`completed` 不再只靠"三个文件在"**

- `confirmCompletion` 逐条要求（每条对应 §9 的一条）：三件齐备 + 结果 JSON 读得懂 + 方法非空 +
  **采用规则可追溯**（`knowledge_sources` 非空）+ **采用案例都有页面证据** + **输入与冻结记录一致**
  （`估值输入.json` 被改过就不算完成）。
- 不满足时**不推 completed**，留在 `running` 并把"还差什么"写进 `progress.detail` ——
  面板读到的是"正在跑 + 差 X"，比一个假的"已完成"有用。
- 底稿重算（打开 Excel 让公式算值再与 JSON 核对）本部署做不到，所以它**不**作为自动完成的判据，
  而是在完成时作为**能力缺口**写进这一轮：`completed` 表示"三件齐备且可追溯"，
  不表示"数字已重算核对过"。

**中介联系方式（方案 §7.5）**

- 案例契约新增 `contact`（必填对象）：`state` 五态枚举 `public` / `not-published` / `masked` /
  `login-required` / `failed`，另有 `agency` / `person` / `phone` / `source` / `captured_at` / `detail`。
- `validate_result.py` 新增 `check_contact`：状态必须是那五个值；`public` 必须有取值与取得时刻；
  **号码带脱敏符却标成 `public` 判不合格**；`masked` 必须把页面展示的脱敏号码原样留下来；
  `login-required` / `failed` 必须写一句人话原因。**没有公开联系方式不排除案例**。
- Skill 的 `references/04-case-selection.md` 补第 1.1 节：五态含义、必填项与四条边界
 （脱敏原样保留、不得自动联系、`public` 要写清页面位置）。
- 结果页新增「公开中介联系方式」区块与案例表联系方式列：按状态呈现、号码按页面原样写出，
  **没有任何**拨号 / 发消息 / 联系入口（可断言：没有 `tel:` / `sms:` 链接，也没有联系类按钮）。

**结果页（方案 §9）**

- 证据不完整（缺交付件 / 采用案例没留存证据 / 有能力缺口）时**先**给一句提示，不拿数字装成已核实的正式结论；
  证据齐备时**不显示**这条提示（否则用户不再信它）。
- 剔除 / 需修正的案例改为**可折叠**（`details`）但**不删** —— "这条为什么没算进去"必须查得到。
- 案例表逐行给出**证据文件相对路径**与**抓取时刻**；明确没留存证据的如实标成「没有留存证据」，
  不留空单元格（空单元格会被读成"证据是个空文件"）。

**测试**：新增 `client-style-scope.test.mjs`（16 条：作用域常量 / 限定不改变权重 / 每个挂载点都带作用域 /
无裸重置规则 / 模块隔离 / 导航归 shell / 共享控件归共享 UI / 合成表结构与色值扫描），
`client-valuation-pane.test.mjs` 增补 16 条时序与契约断言（首帧反馈 / 进度来自宿主 / baseDate 贯通 /
失败与超时不丢输入 / 取消与迟到响应 / 来源不阻塞抽屉），验收矩阵新增第 13、14 节。

## package · 0.0.41 · 2026-10-11 · feat · 本地审核（选本机文件、一次性交接给一条新对话）+ 报告审核页重构

- 通用准则公共能力逐项执行本次报告披露根内已启用的报告与评估说明校对 CHK，保留检查状态、本项目证据与无法核验原因；内部表单检查只形成内部质控意见，外部正式缺陷仍须独立的已核验依据。
- 澄清机构制度体系对照的排除边界，保留既有目录递归装配与数据勾稽分工，不新增 Skill、知识库路径键或模板依赖。
- 增加公共校对范围与输出权限的源仓契约回归。

- 报告审核合并为单一「报告列表」，移除 AI审核列表及顶部 Tab，新增独立 AI审核列；查看报告、审核摘要、结果分析、原始交付件与原始报告讨论合并到报告行。JSON 单独存在时也视为审核历史，重新审核需要确认。
- 首次进入、搜索、翻页和刷新按氚云分页定向补齐 OSS；`oss-index` 新增 `seqNos` 批量应答，Host 实例共享并发 3、90 秒整批截止时间，支持请求取消、逐项失败与单行重试。上传完成只补查当前页对应流水号，不扫描总前缀、不提前读取全部 JSON。
- 协议升级至 27；Client 在确认 Host 协议兼容后才发送批量请求，翻页及离开模块取消旧轮并丢弃迟到响应。

**本地审核与工作台 UI 重构（2026-10-11）**

用户口径：**在「报告审核」页下增加并列页签「本地审核」** —— 选本机文件或文件夹，插件建一次性
输入快照并开一条新对话，审核结果只存在于那次对话里。两条流程完全独立；报告审核的既有流程、
字段与 HTML 结果一个字不改。

- 新增三个 Host 操作（操作清单 39 → 42）：`local-audit-status`（按本次选择扫描：递归展开、
  按真实路径去重、不跟随符号链接、跳过特殊文件、读写性与大小、**超过 30 个明确阻止且不截取**）、
  `local-audit-start`（重新校验选择 → 建临时快照 → 生成一次性 handoff 与**可复制的固定提示词**）、
  `local-audit-claim`（把 handoff 绑到一条会话并回传案例目录）。
- 新增模型可见 Tool `crwu_audit_local_claim`：完全权限下人工新建对话、粘贴提示词之后，
  由它把临时案例目录**绑定到那条会话**。身份只来自 `exec.agent.id`；同一条会话重复认领幂等，
  别的会话拿到"已用过"；过期 / 快照不在时明确要求回 Workbench 重新准备，**不退化成本机搜索**。
- 新增本机访问具名操作 `system.local-audit-material.snapshot`（特权、只给面板）：未授权时
  **一个字节都不读**，授权通过后逐次留结构化诊断。快照落在操作系统临时目录
  `crwu-local-audit/<handoffId>/`，含 `材料-源/`、`本地审核清单.json`、`快照元数据.json`；
  原始文件随后被删除不影响那次对话。
- 案例门禁增加第四类调用者 `kind: 'local'`：本地审核的案例目录在临时目录下，普通会话判据
  （`<工作空间>/<流水号>`）覆盖不到它，因此走 `local-audit-claim` 写下的会话级 scope，
  并且模型提交的 `caseDir` 必须与那一份案例目录规范解析后精确相等。
- 客户端新增「本地审核」页签与 `LocalAuditPane` 一族组件：三块卡片（已选择内容 / 选择文件 /
  补充提示词）、阶段条、失败卡片与复制提示词兜底、`aria-live` 状态、语义化列表与
  `prefers-reduced-motion` 支持；主按钮九态与设计表逐条对应。选择能力缺一即显示
  「当前 DeepSeek Harness 版本不支持本机文件选择」，不暴露 JS 错误或底层服务名。
- 会话由**客户端**用 DSH 的 `sessions.create` / `using`（rename + prompt）建普通对话，
  再用 `uiWorkspace.openSession` 切过去；Host 只负责扫描、快照、handoff、提示词、claim 与清理。
  任何一步失败都不丢已选内容与提示词，并给出「切完全权限 → 新建对话 → 粘贴发送」的人工路径。
- 新增 `crwu-audit/references/16-local-audit.md`：定义一次性交接的认领、氚云相关步骤记
  **不适用**而非缺失、只在案例目录内交付（不调用 OSS 发布与钉钉两件），以及 HTML 必须标记为
  「本地审核」并用图标 + 文字 + 颜色区分「没有该数据 / 处理失败 / 不适用 / 文件没有被审核」。
- 草稿归 `apply()` 持有：`createLocalAuditPaneController(services)` 在客户端 `apply()` 里建一份、
  随 props 下发 —— 状态机若长在页面组件里，切一次页签就会把用户刚选的文件丢掉（与「不要丢弃已选内容」
  冲突）。页签条用 `role=tablist/tab/tabpanel` + roving tabindex + 左右/Home/End，
  **报告审核那一侧的内容与拦截屏一个字没改**。
- `install/browser-check.mjs` 新增一段**只读**的「本地审核页签」验收（页签语义 / 三块卡片 / 空态文案 /
  主按钮禁用 + 旁边的原因文字 / 切回报告审核后本地页卸载而报告正文还在 / 切页签零副作用）。
- 逐字对齐设计 §2–§9 的用户可见文案：补上页面副标题与辅助说明（「选择本机文件或文件夹，创建一个新的
  审核对话。」/「文件只会用于本次对话，不会进入报告审核或云端交付流程。」）、把复制成功的反馈改成设计里的
  三行（切完全权限 → 建新对话 → 粘贴发送，且已选内容与提示词仍然保留），并把「待审核」补进文件状态
  —— 扫描窗口里已经选中的行先画成「待审核」占位行，计数如实说「正在统计文件数量…」而不拿旧数字或
  `0 B` 冒充结论。新增一条**文案契约**测试逐字比对设计里那 40 余句原话与五个状态。
- 新会话走 `sessions.create({ cwd: 案例目录 })`：不需要预先注册工作空间（host 侧会 `mkdir -p`
  该目录并把它写成会话 `meta.cwd`，也就是它的沙箱边界），因此这条会话会出现在侧栏**「未分组」**下
  （与协议 24 同源），标题由插件 `rename` 成 `本地审核 · MM-DD HH:mm`。取证见 development-notes。
- 修掉"页面滚动条没了"（用户实测反馈）：两处独立原因 ——
  ① 页签内容块没有把高度接下去，`pane-main` 被撑成内容高（1704/1704）而外层 `overflow:hidden`，
  **整页没有任何滚动**；`tests/unit` 补了结构回归，无头实测从 `canScroll=false` 变 `true`。
  ② 报告审核正文同时写了标准属性 `scrollbar-width/scrollbar-color` 与 `::-webkit-scrollbar`，
  Chromium 里前者会让后者**整段失效**、退回 macOS 的 overlay 条（不滚不画）—— 实测滚动条占位
  从 10px 变 0。现在只留 `::-webkit-scrollbar` + `scrollbar-gutter: stable`，滚动条始终可见。
- 修掉页签下方那条横线（用户实测反馈）与重复的大字标题：横线的根因是**双层 Workspace Surface**
  —— 外层纸包着页签，报告审核页自己又带一层框，那圈 1px 描边正落在页签正下方；
  现在嵌在页签内容块里的 surface 不再画框（`border/radius/shadow` 全撤），并补上
  `.crwu-audit-tab-panel` 把高度接下去（否则内层 `height:100%` 退化成 `auto`、列表滚不起来）。
  同时按口径移除报告审核页头那行 24px「报告审核」大字（模块身份由页签承担），
  相关结构判据（等待页、页内身份代理）改用列表数据区。
- **修掉切页时页签下面那一大片空白**（2026-10-11 用户实测）：上一轮把两个 tabpanel 改成常驻
  （非选中者是 `hidden` 空壳）之后，空壳仍然参与布局 —— `.crwu-audit-tab-panel` 上的
  `display: flex` 是**作者样式**，会盖掉 UA 样式表对 `[hidden]` 的 `display: none`。
  无头实测（900px 视口）空壳占 **320px 高**，报告页只剩 484px。现在补
  `.crwu-audit-tab-panel[hidden] { display: none; }`（实测：空壳 0 高、报告页拿满 804px），
  并加了样式契约回归 + 真机 browser-check 的正反两向高度断言。
- **「查看报告」改由客户端打开链接（用户实测"浏览器很慢"）**：原来这条路是**两次串行的提权进程**
  —— `ossutil sign` 出链接、`open <url>` 拉起浏览器。第②步现在交给客户端：
  `oss-link` 新增可选入参 `open: false`（只回链接、宿主一个浏览器进程都不起），客户端
  拿到链接后自己 `window.open` —— 桌面端主进程的 `setWindowOpenHandler` 会把它转成
  `shell.openExternal` → **系统默认浏览器**（本仓 notes §14.1 那张表里早就写明，登录流程正是
  为了避开它才改用内置浏览器）。兼容性：旧宿主忽略这个参数、照旧自己打开并回 `opened: true`，
  客户端看到 `opened === true` 就不再开第二个窗口。协议 30 → 31。
  另外该行在打开期间显示「正在打开…」（占主位、不可重复点）。
  实测：交付件 HTML 只有 200–450KB、`ossutil sign` 本机 29ms，所以"先 `ossutil cp` 到本地再打开"
  **不会更快**（同一份数据、多一个进程、还要先等下完），见 development-notes 的一节。
- **UI/交互重构（2026-10-11，按产品/交互/前端三个视角过了一遍）**：
  - **页签**：从"两张描边卡片"改成**一条工作区导航** —— 44px 命中高度、选中项用
    「文字加重 + 3px 品牌色底部强调线」表达（形状 + 颜色双重，不只靠颜色）、悬停浅底、
    2px 焦点环、`prefers-reduced-motion` 下不动。两个 tabpanel 元素**常驻**（非选中者是
    `hidden` 空壳），`aria-controls` 在任何时刻都指向真实节点；tablist 补 `aria-orientation`
    并把 `aria-label` 从工作台名改成「审核页签」。
  - **本地审核**：扫描中**不再显示空态**（改骨架 + `role="status"`，避免误报"还没有选择文件"）；
    跳过原因收进 `<details>`（默认不占版面，要查一键展开）；整页**只保留一枚主按钮**
    （底部的开始/重试；选择按钮与卡片动作都降为次级）；≥1024px **双栏**（左：选择资料 +
    已选择内容；右：补充提示词与交接），窄屏单栏且不横向溢出；主按钮用 `aria-describedby`
    关联旁边那句可见的不可点原因；复制成功 `role="status"`、失败 `role="alert"`；
    滚动区可聚焦（`tabIndex=0`）；移除按钮视觉 28px、命中区外扩到 44px。
  - **报告审核**：**审核中的行不再展示「与 DeepSeek 讨论」小鲸鱼**（用户 2026-10-11 口径）——
    这一刻该行还没有可讨论的结果，主位已经在说「审核中」，多一枚图标只会让人以为还能做别的；
    停止 / 查看审核信息仍在 ••• 里，操作没有缺口。其余改动：失败类提示补 `role="alert"`（读屏立刻播报，不再只在视觉上变色）；
    搜索区声明 `role="search"`；`•••` 菜单补 `aria-controls`、方向键/Home/End 导航、
    打开时焦点移入第一项、关闭（Esc / 选中 / 点外部）时**焦点还给触发按钮**；
    「停止审核」补行内二次确认（与「重新审核」同一套：先变「确认停止审核」再执行）；
    交付件 ⓘ（18px）与搜索清空 ×（20px）视觉不变、命中区外扩到 44px，× 补 `focus-visible`。
- 修掉「本地审核的对话没有挂在环境信息里配置的工作空间下」（用户实测）：只给 `cwd` **挂不上去**。
  读了 DSH 自己的客户端产物（`ui-workspace` 的 `reuseOrCreateBlank`）：界面在某个工作区里建会话用的是
  `sessions.create({ workspaceId })`，而侧栏「未分组」的判据是 `workspace.sessionIds.includes(id)`
  —— **宿主工作区注册表里的成员关系**，不是 cwd 匹配。现在界面把 `env.workspace.id` 一路带到
  `createLocalAuditSession`，用它建会话；只有拿不到 id 时才退回 `cwd`（至少落在对的目录里）。
- 修掉「移除文件夹移不掉」（2026-10-11 用户实测）：macOS 的目录选择器回 `/x/资料/`（带尾斜杠），
  而 Host 回的 `item.path` 是去掉过的 —— 界面只比 `selected.includes` 会把它误判成"入口里的某个
  文件"，于是点 X 只是把它塞进排除清单，文件夹纹丝不动。现在选择项一入库就 `trimTrailingSeparators`
  归一，并且"是入口还是入口里的文件"改为看 **Host 回的 `items`**（权威），拼法归一后比较。
- 下掉「重新扫描」按钮（用户 2026-10-11 口径：它和移除的交互说不清）：移除一个文件/文件夹本身就会
  立刻重扫一次，辅助操作只剩「清空选择」。真要重扫时清空后重选即可。
- **本地审核的选择列表展开到文件级**（用户 2026-10-11 第二次口径：「审核文件在扫描后应该完整
  展示文件名称，右侧有个 X 的 icon，表示移除该文件」）：扫描应答新增文件级清单 `files[]`
  （带 `parentPath`），界面在**文件夹行下面逐行**列出每个文件（完整文件名 + 相对路径 + 大小，
  长名换行不截断），每行右侧一枚 X；入口行也把原来的文字按钮换成同一枚 X。
  移除分两条语义：入口行的 X 从选择里去掉该入口，文件行的 X 记进**排除清单**并发给 Host
  （`local-audit-status` / `local-audit-start` 新增可选入参 `excluded[]`）—— 所以"移除一个文件"
  在重新扫描后依然生效，且被移除的文件既不算"读不到"也不出现在快照里。协议 29 → 30。
- 会话 cwd 改用**界面已经在显示的那个工作区**（`env.workspace.path`）—— 用户指出「我插件的
  【环境信息】中不是已经规定了工作区吗」：对，面板本来就有它，不该再要求宿主在
  `local-audit-start` 里新回一个字段（那个字段在"界面新、宿主旧"时是空的，才会发出空 cwd）。
  现在宿主回的值优先（它是案例目录落点的权威）、面板那份兜底；两边都非空且**不一致**时
  直接拒绝并要求"重新准备文件"（工作空间中途换了，案例目录在旧工作区里，会话罩不住它）。
- **协议 28 → 29**（我改了跨进程字段却没升协议号，真机上表现为一句看不懂的报错）：
  `local-audit-start` 的应答新增 `workspacePath`、`casePath` 的含义也变了。旧宿主**不回**这个字段，
  新客户端于是拿空串当 cwd 去建会话 —— 用户看到的是
  `创建审核对话失败：… failed to ensure project directory "": ENOENT: mkdir ''`。
  现在协议号会先把「界面新、宿主旧」拦下来（顶部横幅 + 主按钮禁用 + 说明"完全退出并重新打开"）。
  另加第二道闸：`createLocalAuditSession` 遇到空工作空间路径**一个请求都不发**，文案直接指到重启 profile。
- **修掉交付件被删掉的数据丢失**（2026-10-11 用户实测第一次真机审核）：
  `handoff.sweep()` 原来把「已被认领（`used`）」也当成可清理条件，而 `claim()` 一成功就置 `used` ——
  于是审核一跑完（甚至还在跑），下一次清理（10 分钟兜底定时器 / 下一次开始本地审核）就把整个
  案例目录连**交付件 HTML / JSON** 一起删了。现在只清**没人认领**的过期快照；
  认领过的一律不自动删（记录也留着 —— 自动链路是"客户端先认领一次、模型随后再认领一次"，
  中间清掉会让模型那一次拿到"已过期"）。目录落点同时改到员工自己的工作空间下，见下条。
- **本地审核的会话与案例目录改到员工选定的工作空间下**（用户口径：「本地审核对话应该创建在我
  环境信息规定的工作区下面」）：案例目录从 `os.tmpdir()/crwu-local-audit/<id>` 移到
  `<工作空间>/本地审核/<id>`，新会话的 **cwd = 工作空间路径（逐字）** —— DSH 据此把会话挂到
  那个工作空间下，而会话的沙箱边界（= cwd）也正好罩住案例目录，对话里的案例内工具写得进去。
  没选工作空间时 `local-audit-start` 直接拒绝并指向「环境信息」。交付件也因此落在员工自己的目录里。
- **交付件要写完整路径**（用户实测「在会话中直接点击文件跳转不过去」）：界面里的文件链接按
  **会话工作空间根**解析，只写文件名会指到不存在的路径。固定提示词与 `16-local-audit.md` 的
  收尾格式里新增「交付件（完整路径）」一块，并明确写「不要只写文件名」。
- 修复客户端能力被**提前快照**导致的"目录选择不可用"（2026-10-11 用户实测二次反馈）：
  `portOf()` 曾在 `apply()` 里判一次 `services.uiWorkspace?.pickDirectory` 就把结论固化下来 ——
  我们的客户端插件比 `ui-workspace` 先激活时，这一条**永远是 undefined**，于是点「选择文件夹」
  回「当前宿主不支持本机目录选择」。现在 `pickDirectory` / `hostPaths` / `sessions.create` /
  `sessions.using` 全部改成**用时现读**（getter），并在目录能力缺席时**补探一次**（不轮询）。
  新增两条回归：晚注册的 `uiWorkspace` 仍能选目录、晚注册的 `sessions` 仍能走完
  「建会话 → 命名发提示词 → 切过去」。
- 修复选择能力探测与失败文案（2026-10-11 用户实测「当前 DeepSeek Harness 版本不支持本机文件选择」）：
  `__DSH_HOST_PATHS__` 是对象 `{ pathFor }` 而不是函数，早先按函数判导致「选择文件」**永远**被误判成不支持
  （该判据此前没有任何单测，替身恰好是函数形状）；两条能力改为**分开判**，缺一条不再把另一条按钮
  一起撤掉（用户问的正是"不能选择文件夹吗"）；并把「这个宿主不支持」与「这一次打不开」分成两句话 ——
  后者不再误导用户去"更新宿主"。新增 6 条回归（含"只有文件夹可用时界面给什么"）。
- 已知限制（已确认口径，保持现状）：本地审核是**报告审核页里的页签**，而该页受环境门禁保护 ——
  环境自检不通过时整个 audit 模块（含这两个页签）不渲染。页内那一侧确实不判 `envOk`，
  但整体可达性仍跟报告审核同一套前置；不动既有门禁语义。
- 协议升级至 28：旧宿主没有这三条操作，新界面点下去只会 404 —— 必须靠协议号把「界面新、宿主旧」
  挡在门外。新增 `tests/unit/host-local-audit.test.mjs`（35 条）、`tests/unit/host-local-claim.test.mjs`
  （9 条）与 `tests/unit/client-local-audit.test.mjs`（55 条，含"本地审核不受监控面污染"的源码守卫与**设计 §2–§9 逐字文案契约**）。

## package · 0.0.40 · 2026-10-05 · fix · 普通 DSH 会话支持完整手工审核（协议 26）

- 修复复制提示词到新会话后，脚本、知识库、附件下载、OSS 发布、钉钉归档和本人通知因缺少审核子会话身份被统一拒绝的问题。普通会话按选定工作空间下的 `<工作空间>/<流水号>` 校验案例目录，无需登记审核记录或讨论范围；氚云访问仍使用员工凭据与远端权限。
- 统一案例访问入口：托管审核子会话仍校验本轮案例与附件白名单，已结束、已停止、不完整及待接管状态不得降级为普通会话；已登记讨论会话可以使用全部案例工具，记录和附件清单查询仅允许登记的 ObjectId。
- `crwu_run_python_script` 通过调用者 Agent 解析 DSH Python，首次手工审核无需先运行一次工作台自动审核来填充缓存。
- 手工兜底提示词携带选定工作空间的案例路径，先用 `crwu_audit_case_bootstrap` 刷新输入快照，再完成两阶段审核和各交付通道。普通会话遵循自己的 DSH 沙箱策略，本机访问授权与托管审核隔离保持生效。
- 新增普通会话、托管审核和登记讨论的工具对照回归，覆盖 Windows 路径、写后校验、通知幂等与越界零进程。

## package · 0.0.39 · 2026-10-05 · feat · 审核 Skill 默认发布最终 HTML 与 JSON 到 OSS

- 新增 `crwu-audit/references/15-oss-result-publish.md`，把默认 OSS 双文件发布、精确文件名逐项写后验证、受信目标和非阻塞失败收尾纳入 Skill，而非仅依赖插件提示词。
- 编排顺序为步骤 14 成对校验与渲染最终结果 → 15 OSS 发布 → 16 独立钉钉归档与通知；完整保留两阶段复核与必要隔离补审，不上传会话内容。
- 插件提示词显式传入 HTML/JSON `files`，不再把结果 JSON 当可选文件。交付认证/授权失败仅停止受影响通道，保留本地审核成果并分别报告，不能冒充完全交付成功。
- 沿用现有 OSS Tool 的受信配置、流水号对象前缀和同名覆盖行为；不新增年月/时间戳归档，不改变 Host 审核范围与主会话绑定机制。
- 更新 Skill 路由、CLI 守卫与提示词契约测试，新增双文件 Tool 成功、JSON 缺失与写后大小不符用例。

## package · 0.0.38 · 2026-09-30 · fix · 发起失败的手工兜底必须先把会话切成「完全权限」（并把怎么切写清楚）

用户口径（2026-09-30）：「手工兜底那里要加上『打开完全权限』—— 用户可能不知道这个怎么打开，
所以这里的提示要明确一点。」**只加在这一处**（环境页 / 报告页其它状态一个字不提）：审核子会话
按设计固定在 `workspace-write`，平时让员工看到「切完全权限」会把人引到错的处置上。

- `Handoff.tsx`（发起审核失败时的**手工兜底卡**）在提示词**之前**加一条 warn 提醒：
  四步操作（输入框下方的「访问模式」→ 选「完全权限」→「确认启用完全权限？」里勾选
  「我已了解风险，并愿意继续」→「启用完全权限」）+ 一条命令行等价做法
  （`/permission danger-full-access`）。文案进 `zh-CN.ts` 的 `handoffFullAccess*`，
  措辞逐字取自 DSH 客户端的中文词典（控件名「访问模式」、选项名「完全权限」、确认弹窗与勾选名）。
- **顺序是判据**：提醒排在提示词前面 —— 反了员工会先粘一遍、失败一次再回头找原因；
  另外明说改的是**那条会话**当前的权限，「设置」里的默认值只影响以后新建的会话。
- 为什么这条提醒是必须的（不是体验优化）：手工兜底跑在员工**自己的会话**里，它的沙箱边界是
  自己的工作目录，而案例目录、报告材料与本机凭据都在边界之外；不切完全权限，粘贴后第一步就会失败。
- 配套测试（每条都注入缺陷证伪过一次）：`client-package.test.mjs` 新增「卡片里逐条写出怎么切」
  （含顺序断言），并把「没有失败时不许出现这条提醒」钉在报告页与环境页两条既有用例上。

## package · 0.0.37 · 2026-09-30 · fix · 沙箱起不了进程不再被说成「脚本运行时不可用」

真机闭环（0.0.36 的控制探测跑出来的）：

```text
控制探测（纯 PowerShell 命令）**同样失败**（exitCode 3221225794）
→ 连 pwsh 自己都起不来：本机沙箱后端（ACL restricted-token runner）的问题
```

也就是说这台机器的 `workspace-write` 下**任何进程都跑不起来**，插件的输出采集兼容层
（子进程重定向）在原理上就不可能生效 —— 做重定向的那个 pwsh 自己都没起来。

- `PythonRuntimeView` 新增 `blockedBySandbox`：启动失败指纹命中**且控制探测同样失败**时为 true。
- `audit-start` 的门禁第一句据此分流：沙箱坏 → 「本机受限沙箱起不了任何进程（部署侧问题）」；
  真的缺运行时 / 缺包 → 仍然是「DSH 脚本运行时不可用」。两者处置完全不同，不许混成一句。

## package · 0.0.36 · 2026-09-30 · fix · 受限沙箱里"进程起不来"不再被说成「DSH Python 不可用」

真机现场（Windows，0.0.35 打出来的结构化事实就成了判据）：

```text
DSH 脚本运行时不可用，已终止本次审核：DSH Python 无法执行：没有版本输出
（exitCode 3221225794 · 沙箱 执行器默认 → workspace-write）
```

`3221225794 = 0xC0000142 = STATUS_DLL_INIT_FAILED`，而 `denied` / `runnerFailed` 都还是
false —— DSH 把它当成一次**普通的非零退出**。于是"沙箱里进程起不来"被说成了"Python 不可用"，
两种处置完全不同的现场长得一模一样。

- 新增 `looksLikeProcessStartFailure()`（认 0xC0000142，无符号与 int32 两种视图）+
  **控制探测**：命中该指纹时再跑一条**纯 PowerShell** 命令，据此把两件事分开并给出处置 ——
  ① 控制探测也失败 ⇒ 本机沙箱后端（ACL restricted-token runner）连 pwsh 都起不来，
  **不是**「DSH Python 不可用」，换运行时没用；② 控制探测成功 ⇒ 只有 native 子进程在初始化阶段退出，
  是那层捕获兼容层还不够。结论进 `runtime.error`，结构化事实进日志。
  给出的处置走**部署侧**（DSH 版本 / 沙箱 runner / ACL）—— 插件把审核根钉死在 `workspace-write`
  + `approval: never`，且在 auto / 完全权限的父会话下拒绝发起审核，所以"切完全权限"不是退路。
- 捕获层补上**第三个句柄**：早先只重定向 stdout/stderr，stdin 仍然继承 DSH 的管道 ——
  而这层兼容层的全部前提是"子进程一个 DSH 句柄都不继承"。现在内层命令写成
  `$null | & 'exe' args > out 2> err`（pwsh 自己建一根空管道给子进程，立刻 EOF）。
  Host 侧、子代理提示词与技能文档三处同步。

## package · 0.0.35 · 2026-09-30 · fix · Windows 原生命令捕获收口 + 技能脚本执行进 Host（协议 25）

### feat · `crwu_run_python_script`：把技能脚本的执行收进 Host（协议 25）

子代理原先自己拼 `& 'python.exe' script.py`，而**模型可见的 pwsh 工具与插件的 `ctx.shell`
是同一套 Windows sandbox** —— 于是子代理的 Python 调用照样命中受限沙箱下 native 子进程的
管道缺陷（`0xC0000142` / `EACCES`）。提示词里那份 `Invoke-DshPython` 只是"请照做"，
不保证被执行，也不带退出码与沙箱事实。

- 新增 Host Tool `crwu_run_python_script`（宿主操作 `python.script.run`：来源只给 `audit-tool`、
  **不提权**）。模型只提交 `caseDir` / `script`（**案例目录内**的相对路径）/ `scriptArgs`：
  路径由 Host 用 `joinLocalPath` 拼，绝对路径、`..`、空串一律拒绝；参数逐个作为 argv 传入，
  不经过任何 shell 解析。
- 命令经**同一条 `ctx.shell` seam** 出去，所以自动拿到 `windowsCaptureCommand` 那层
  **只在受限沙箱生效**的临时文件捕获 —— 无需模型照做，也无需第二套执行通道。
- 返回里带 `exitCode` / `stdout` / `stderr` / `truncated` / `timedOut` 与
  `sandbox{requested,resolved,ran,denied,runnerFailed}`，以及本次用的 Python 路径与版本；
  DSH Python 解析不到时如实回 `capability-gap`，**绝不**改成系统解释器。
- 审核指令改为**首选**这个 Tool，原来的 PowerShell 包装器降级成"Tool 不可用时的退路"。

### fix · Windows 原生命令捕获收敛成唯一入口 + 探测失败带结构化事实

- 新增 `windowsCaptureCommand(command, mode)`：**形状**（只有 `shellInvoke()` 产出的
  `& 'exe' args` 才命中那个缺陷）与**沙箱模式**（只有真跑受限沙箱才需要捕获）一起判。
  `crwu` / `dws` / `ossutil` / DSH Python 的每一条命令都经由 `ctx.shell` 那个 seam 走到它，
  调用点不需要、也不允许自己决定要不要捕获 —— "统一走文件捕获执行器"只有这一处判据。
- DSH Python 版本探测失败时把**结构化事实**一起带进错误：`exitCode`、请求与实际的沙箱模式、
  是否被沙箱拒绝、执行器是否没能启动。Windows 受限沙箱的 `0xC0000142` 与"Python 没装"
  处置完全不同（换采集方式 vs 换运行时），只报一句"无法执行"会把两件事混起来。

### fix · Windows 原生命令捕获不再套在提权调用上（凭据读不到的真因）

现场（用户报）：**同一台 Windows 上 `main` 能读到氚云与钉钉凭据，这个分支读不到** ——
扫了码也不行，面板显示「未绑定 / 未知 / 未登录」，看起来像"凭据没写进去"。

- **根因**：`capturePowerShellNativeCommand` 是按**命令形状**（`& '…'`）无条件套上去的，可它
  解决的是**受限沙箱**下的 native-child DLL 初始化失败（0xC0000142）。而 `dsh-pwsh-sandbox`
  的 `execute()` 对 `danger-full-access` 直接 `super.execute()`、**不套 restricted-token runner**
  —— 那个前提根本不存在。于是所有**提权**命令（`crwu h3yun session status` /
  `dws auth status` / `dws doctor` / `ossutil …`，全都是 `danger-full-access`）也被套上了，
  而捕获必须经过 PowerShell 的**文本层**（`>` → `Out-File`）：Windows PowerShell 5.1 默认写
  UTF-16LE，CLI 的 JSON 就成了 `{\0"\0…`，解析失败 → 「未绑定 / 未知」。
  不套捕获时 native 子进程**直接继承 DSH 的管道句柄**，原始字节原样过去，不经过任何编码
  —— 这正是 `main` 的形状。
- **为什么 CI 没拦住**：`tests/windows/powershell-contract.test.mjs` 的 Windows provider 用的是
  **pwsh 7**（默认 UTF-8 无 BOM），而且只断言纯 ASCII 载荷 —— 两个条件恰好把这个缺陷挡在视野外。
  现在补了一条**非 ASCII JSON 逐字节往返**的真 shell 用例，并把「文本层显式钉成 UTF-8 +
  从字节里剥 BOM」写进两个包装器（Host 侧 + 子代理提示词里那份），让它们即使在 5.1 上也不改字节。
- **修法**：新增 `nativeCaptureNeeded(mode)` —— 只有**非** `danger-full-access`（真跑受限沙箱，
  或没声明策略而落到执行器部署默认）才上捕获。提权调用回到 `main` 的命令形状。

### fix · 「授权收据读不出来」不再显示成「需要授权」（协议 24 → 25）

现场（「授权成功、界面永远停在需要授权」，2026-09-30 复查）：磁盘上的
`~/.dsh/crwu-workbench.json` 里躺着一份**合法**收据（`schemaVersion: 1` + 逐字同序的五项能力），
而「账号连接」里的氚云与钉钉两行都显示「需要授权」，插件因此拒绝一切本机凭据访问。

- **先纠正一条推断**：这不是"读被沙箱拒了"。DSH 的 `dsh-fs-sandbox` 只在 `writeText` /
  `editText` 上做可写根围栏，源码原话是 *"Reads pass through untouched: every mode permits
  reading."* —— 本地实测也印证：会话策略 `workspace-write`（工作区在仓库下）时读
  `~/.dsh/crwu-workbench.json` 一切正常，`env.localAccess.state` 就是 `granted`。
  所以"读收据要与写对称地声明提权"并不是这里缺的那一块（fs 的读接口也**没有**逐次策略参数）。
- **真正的缺陷**：`ConfigRead` 只有一个 `ok` 布尔，于是**五种完全不同的事实**在授权层眼里
  长得一样 —— 文件不存在、位置不是普通文件、路径解析 / stat / 读文本抛错、内容解析不出来。
  它们全被折叠成 `missing`，界面于是显示「需要授权」并把员工指向"再授权一次"；而读失败时
  写盘（同样是读-改-写）根本落不了盘。现在逐种都有名字（`absent` / `corrupt` / `no-fs` /
  `no-home` / `not-a-file` / `resolve` / `stat` / `read`），授权层把 **`missing`（真的没有
  收据）** 与 **`unreadable`（读不出来）** 分成两句话。
- 主目录未知时不再拼 `~/.dsh/crwu-workbench.json` 这个字面量：`ctx.fs.resolve()` 不展开 `~`，
  它会变成**相对于会话 cwd** 的路径，于是"主目录探不到"会伪装成"从没授权过"。
- 解析前先剥掉 UTF-8 BOM（**防御性**）：`JSON.parse` 见到 U+FEFF 会直接抛错，而在这里抛错
  会被折叠成"没有授权"。DSH 自带的本地 fs 用 `TextDecoder`（默认剥 BOM），但 fs 后端并不
  保证都这么做。
- `env` / 界面：`localAccess.state` 新增 `unreadable`；氚云、钉钉、OSS、iFinD 的占位事实从
  「需要授权」改为「授权状态读不出来 + 宿主给的原因」，`credentialsConsent` 归 `invalid`，
  issue 的 owner 归 `system`（"把这条原因发给维护者，不是重新授权"）；授权卡不再对被读不出来的
  收据显示"首次使用请允许一次"那段介绍。协议 +1 的理由就是这条：旧客户端读到 `unreadable`
  会当成 `missing`，把员工送回那条走不通的路。

### fix · Windows `workspace-write` 下宿主与审核子代理的 Python 原生命令兼容

- Host 的统一 `ctx.shell` 执行入口现在只对 Windows PowerShell 原生命令启用临时文件捕获，
  再按原始 stdout/stderr 字节转发并保留退出码；macOS / Linux 命令字符串保持不变。
- 审核子代理提示词和 `crwu-audit` 编排契约增加同一套 `Invoke-DshPython` 包装器，材料准备、
  复核与交付脚本不再直接继承受限 PowerShell 的管道句柄。
- 该修复不放宽 `workspace-write`，也不回退系统 Python；Windows 原生 PowerShell 合同继续由
  `tests/windows/powershell-contract.test.mjs` 在 Windows CI 验证。

## package · 0.0.34 · 2026-09-30 · fix · 审核根绑到已选工作空间 + 快照写入带会话策略（协议 24）


现场：点「AI 审核」后，侧栏里新会话出现在**未分组**下，而不是环境信息里选定的工作空间下。

- **根因**：DSH 有两条硬规则把"会话 cwd"同时当成两件事，而我们只满足了一件：
  1. `SandboxPolicyService.resolve()`：*"**A session cwd is its workspace-write boundary**"* —— 边界就是 cwd；
  2. `Workspace.attachSession()`：`if (cwd !== this.record.path) throw …` —— 挂到工作空间下要求
     cwd **逐字等于**工作空间路径。
  我们原先用 `agents.create({ meta: { cwd: 案例目录 } })` 建根，cwd 与工作空间路径不等 →
  `attachSession` 必然抛错 → 只能落「未分组」。而当时那处 `catch` 只往 `notes` 里塞了一句
  "会话已建，但没能挂到工作空间"，界面上看不到 —— 所以看起来像"工作空间没定位到"。
- **正解**（与 DSH 自己创建"工作空间下的新会话"完全同一条口径，也是本插件"与 DeepSeek 讨论"
  那条链路一直在用的：客户端 `sessions.create({ workspaceId })` →
  `cwd = workspace.path` → `ensureSession` → `attachSession`）：
  **审核根的 cwd = 已选工作空间**。子会话继承父会话的 cwd，于是整棵审核树都在工作空间下。
- **跨案例隔离没有放松，只是换了承担者**：`requireAuditScope` 仍然要求每个案例内 Tool 的
  `caseDir` 与本轮记录的 `casePath` **规范解析后精确相等**（工作空间根、兄弟案例、案例子目录
  一律拒绝）—— 这条判据不随 cwd 变化，是跨案例的真正边界。文档里把这两件事分开写清楚了：
  **会话边界回答"这个进程能写哪儿"，案例 scope 回答"这次审核被允许碰哪个案例"**。
- 顺带把那个静默降级也修了：`attachSession` 失败不再只进 `notes`（见下条留档）。

### fix · 三个输入快照 JSON 写不进去（`FS_SANDBOX_DENIED`）

`mkdir 输入快照` 修好之后，下一步又断在这里：`ctx.fs.writeText(target, content)` **不带策略**，
而 `dsh-fs-sandbox` 的 `checkedTarget()` 是
`const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()` —— 没有会话就落到**部署默认**
（进程 cwd），于是往案例目录里写文件被自家沙箱拒：
`cannot write "…": file access denied under workspace-write mode`（`FS_SANDBOX_DENIED`）。
审核停在「未创建子代理」。

修法与 0.0.33 的 shell 侧完全对称，并且**只留一个解析口**：
- 新增 `host/access/caller-policy.ts` 的 `callerSessionPolicy(ctx, session)`（从 Broker 里提出来，
  现在 shell 与 fs 两侧共用同一处判据）；
- 新增 `case-files.ts` 的 `writeCaseText(...)`：解析目标 → 带策略写入（第 5 个参数）→ **回读核对**；
  失败按**结构化错误码**归因（`FS_SANDBOX_DENIED` → sandbox，`EACCES`/`EPERM` → permission，
  其余 infrastructure），不回退到文本猜测；
- 三个写入点全部改走它：输入快照的三个 JSON（`bootstrap.ts`）、知识库清单（`knowledge.ts`）、
  钉钉通知幂等状态（`dingtalk.ts`）。

### feat · 审核发起失败**全部留档**（`state.lastAuditFailure`）

真机连挂四次，每次失败详情只存在于那一次 RPC 的返回里，进程一重启就没了 —— 只能靠"复现 + 读代码"
倒推。现在 `auditStart` 的**每一条失败路径**（同一个闭包，漏不掉）都会把结构化事实落盘并在宿主日志
留一份：阶段（工作空间 / 案例目录 / 审核根会话 / 输入快照 / …）、`errorKind`（照抄工具回报的
结构化归因）、Host 算出来的 `caseDir`、`attemptId`、时刻、以及所有 `notes`（含"没能挂到工作空间"
这类原先被吞掉的降级）。发起成功时清空。**不含命令原文与凭据**。

### test · 覆盖

- `host-audit-root`：**替身照 DSH 的判据拦人** —— `attachSession` 现在会像真实现一样校验
  `cwd === workspace.path`，cwd 写错就抛。用缺陷注入验过：把根的 cwd 改回案例目录，4 条用例立刻变红
  （改之前它们全绿 —— 这正是这个 bug 溜到真机的原因）。
- `host-case-files`：`writeCaseText` 两个分支（不带会话 → `FS_SANDBOX_DENIED` + 归因 sandbox +
  一个字都没落盘；带会话 → 写入 + 回读一致 + 请求里带着案例边界）。
- `host-tools`：集成层的 fs 替身也换成**按策略拦写**的版本，断言三个 JSON 真的落盘、且没有被拒的写入。
- `host-audit-lifecycle`：失败留档（阶段/归因/案例目录/notes）与"发起成功清空"。
- 三条都用缺陷注入验过会红。

## package · 0.0.33 · 2026-09-30 · fix · 非特权命令带**调用方会话的策略**（0.0.32 修错了地方）

### fix · 同一个报错又出现了一次：这次定位到真机制

0.0.32 之后真机**原样复现**同一条失败：

```text
创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）
```

- **0.0.32 的修法是无效的**：它把"调用方的 `ctx`"传进 Broker。但 DSH 的执行器
  **不持有会话**（`dsh-sandbox-policy` 原话：*executors and providers remain session-free*）——
  换 `ctx` 只是换个地方 `ctx.get('shell')`，拿到的还是同一个执行器，请求里没带 `sandboxPolicy`
  时它照样用**部署默认**（`workspace-write` + 配置兜底根 = 进程 cwd）。
- **正解**：像 DSH 自带的 bash / fs 那样，**调用方把自己的会话策略算出来放进请求**。
  - `BrokerShellOptions.session`（替换掉 0.0.32 的 `scope`）：**不是权限开关**，提权仍只由
    `privileged` 决定；非特权操作由 Broker 用 `ctx.sandboxPolicy.resolve({ session })` 解析，
    作为 `sandboxPolicy` 随请求下发；
  - `runShell` / `startShell` 新增 `sandboxPolicy` 选项（`shell/run.ts`），请求模式照旧记进诊断
    （`requested` 不再是空串）；
  - 案例内的调用点（`crwu_audit_case_bootstrap` / `crwu_audit_knowledge_materialize`）传
    `exec.agent.session`（新助手 `callerSession(exec)`）。
- **替身也要按策略拦人**：新增 `tests/helpers/fs-sandbox-stub.mjs` —— 复刻"缺策略 → 部署默认 →
  写被拒"，并只拦**写**（DSH 的可写根管的正是写，只读探测照常回话）。
  以前那种"永远成功"的 shell 替身正是这两个缺陷在单测里全绿的原因。
- 失败文案现在带**插件版本**（`… · 插件 pkg-0.0.33`）：真机排障第一件事是"装的是哪一份产物"，
  而源码检出形态的客户端徽章只显示 `dev`。

### test · 覆盖

- 单元（`host-case-files.test.mjs`）与集成（`host-tools.test.mjs`，真调 `crwu_audit_case_bootstrap`）各一条：
  不带会话 → 复现真机那句话（且**真的**被沙箱拦下）；带会话 → 请求里带对边界、快照三个 JSON 落盘。
- 两条都用**缺陷注入**验过（去掉 Broker 的会话策略、去掉调用点的 `session`，各自立刻变红）。

## package · 0.0.32 · 2026-09-30 · fix · 案例内的非特权命令按**调用者的会话作用域**执行（协议不变）

### fix · 输入快照目录建不出来：`Operation not permitted（沙箱拒绝=是）`

真机验收第一轮就抓到（案例目录本身已经建出来了 —— §一 的修复是生效的）：

```text
输入快照交接未完成，已终止本次审核（未创建子代理）：输入快照交接失败（infrastructure）：
创建快照目录失败：mkdir: <案例目录>/输入快照: Operation not permitted
（操作 system.case-file.write · 来源 audit-tool · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是）
```

- 根因：**Broker 自己持有的是插件级 `ctx`，它没有会话**。非特权命令（案例目录之内的建/删/探测）
  不带 `sandboxPolicy`，沙箱边界由"执行它那个 ctx"解析出来的会话决定 —— 插件级 ctx 解析到的是
  **部署默认**（`workspace-write` + 配置里的兜底根，即进程 cwd），而不是调用方那条会话的 cwd。
  案例目录恰恰就是审核根会话的 cwd，于是"写自己所在的目录"被自家沙箱拒了。
  这与我上一版写下的注释（"子会话的沙箱边界本来就是那个目录"）不符：那句话只在**命令真的跑在
  子会话作用域里**时才成立，而经 Broker 执行时并没有。
- 修法（保持"提权只由操作表决定"这条口径不变）：`BrokerShellOptions` 新增 `scope?: Context` ——
  **不是权限开关**，提权仍由 `privileged` 决定、模型与客户端都碰不到它；它只回答"非特权命令落在
  谁的沙箱解析里"，与 `tools/types.ts` 的 `toolContext()` 同一条口径。`ensureDirectory` /
  `removeFileIfExists` / 案例内探测新增 `scope` 透传，`crwu_audit_case_bootstrap` 与
  `crwu_audit_knowledge_materialize` 把**调用者 Agent 的 ctx** 传下来。
- **协议不变（23）**：操作集、字段与语义都没变，变的是 Host 内部"这条命令按谁的作用域执行"。
  版本号 +1 只为让你一眼看出装的是修好的那份产物。

### test · 覆盖

- 单元：两个 ctx（插件级 / 调用者作用域）各一个 shell，断言案例内命令**只**落在调用者作用域上。
- 集成（`crwu_audit_case_bootstrap`）：③ 不带作用域 → 复现真机那句话（`创建快照目录失败` +
  `system.case-file.write` + `沙箱拒绝=是`，且一个目录都不建）；④ 带作用域 → 快照三个 JSON 落盘。
- 两条都用**缺陷注入**验过：把 `scope` 摘掉（Broker 侧与 bootstrap 侧各一次）立刻变红，还原即绿。

## package · 0.0.31 · 2026-09-30 · feat · 报告讨论会话的受限材料范围（协议 23）

### feat · 讨论会话也能取材料，但只取"登记那一刻的那批附件"

- 现场：案例目录创建修好之后，**报告讨论会话**里调 `crwu_h3yun_file_get` 仍然一件材料都取不回来 ——
  它是一条普通顶层会话，没有审核记录，而附件下载原先只认审核 scope（「调用者不在进行中的审核里」）。
- 修法**不是**让它复用审核 scope（那是扩大边界：审核 scope 绑着一条正在跑的子会话），
  而是给它一份**自己的、更窄的**范围：
  - 新增 Host 操作 `discussion-material-open`（协议 23，操作清单 38 → 39）；
  - 客户端在 `ensureDiscussion`（新建**或**恢复）之后、发 kickoff 之前调；只提交
    `sessionId` / `seqNo` / `objectId`；
  - Host 负责：拒绝子代理会话 → 用 `caseDirOf` 算出 `<已选工作空间>/<流水号>` →
    **自己按 `objectId` 取一次记录并核对 `ObjectId`/`SeqNo`**（只看附件清单的话，
    `seqNo=A, objectId=B` 会把 B 的白名单登记成 A 的案例目录）→ 重新取一次附件清单 →
    把这一批 `fileId` 记进**进程内**白名单（12 小时 TTL、最多 32 条、`use()` 推最近使用时刻）；
  - 回传 `caseDir` 与附件清单（`fileId` / `fileName` / `localName` / `fileSize` / `nameTotal`）。
- 工具侧：`requireAuditScope` 之上新增 **`requireMaterialScope`** —— 先看审核子会话 scope
  （有就以它为准，边界更窄），否则看讨论注册表（案例目录与白名单全部来自 Host 记录）。
  `crwu_h3yun_file_get` 改用它；**普通顶层对话仍然拒绝**。
- 讨论会话**不是氚云查询入口**：`crwu_h3yun_record_get` / `crwu_h3yun_files_list` 对
  **已登记**的讨论会话一律拒绝（`crwu-h3yun-query` 技能依赖的"普通会话可按 objectId 查记录"
  这条既有能力**保持不变** —— 收窄的只是讨论会话）。
- 提示词：kickoff 里新增「本次登记的材料」一段（`fileId` ↔ 落盘名成对给出，同名附件标 `同名 N 件`），
  取数规则改成"落盘名必须用这一段给出的名字"。报告讨论与审核结果分析共用这一段规则，
  所以**两条会话都登记**（否则分析会话会读到"用下面给出的落盘名"却找不到"下面"）。
- 登记失败时**不发 kickoff**、会话保留、给出可重试的明确文案；不降级去扫本机目录、也不自己查氚云。
- **续聊也要重新登记**：范围只在 Host 内存里，插件重启或 12 小时后旧会话默认拿不到材料。
  所以「继续上次聊天」这条路径也会先登记一次（不重新拉文件、不重新读 OSS、不重复注入 Prompt）；
  登记失败**不拦着进会话**（用户要的是继续聊，历史都在），原因写进面板，会话里 Tool 也会给出
  「请重新登记」的可执行文案。审核结果分析那条会话同样登记（两处共用同一段取数规则）。

### fix · "查不出来"不再被说成"不存在"（错误分类的两处收紧）

- 工作空间探测**本身失败**（shell 服务没起来 / 被沙箱拦下 / 输出不可识别）原先被折叠成
  「所选工作空间不存在」—— 那会把一次宿主侧的拒绝说成"员工选错了目录"，让员工去重选一个
  本来没错的目录（正是 §三 要消灭的误诊）。现在如实报「无法确认所选工作空间是否存在」，
  并按结构化事实归因（沙箱拒绝 → `sandbox`，其余 → `infrastructure`）。
- 建目录的结果里补齐**完整诊断事实**：`facts` 增加 `processStarted`（计划里那个 `ran` 布尔），
  结果新增 `postcondition`（`directory` / `file` / `absent` / `unknown`）——
  "命令跑过了"与"目标真的成了我们要的样子"从此是两个字段。

### test · 覆盖

- 注册表：TTL 到期即失效、重复登记刷新白名单与 TTL、`use` 推最近使用、超上限丢最久没用过的。
- 解析器：已登记会话放行；未登记 / 过期 / 错误的 `caseDir`（工作空间根、兄弟案例、子目录）/
  不一致的 `seqNo`·`objectId` 一律拒绝；同一 id 两边都命中时**以审核 scope 为准**。
- 工具：讨论会话能下白名单附件、清单外 `fileId` 与未登记会话零命令拒绝、
  `record_get` / `files_list` 对讨论会话拒绝。
- 登记 RPC：成功登记（含"文件身份核对不通过就不去取附件"）、子代理会话拒绝且零命令、
  参数不合法与没有工作空间时拒绝且不登记。
- 客户端：新建与恢复都登记、失败不发 kickoff、抛错变人话、旧宿主（没有这个能力）行为不变。
- **授权矩阵**逐格钉住（三种调用者 × 三个氚云 Tool）：允许的四格真的执行、拒绝的七格零命令。
- 审核启动：建目录失败时**后续步骤一个都不许发生**（无记录 / 无占用 / 无快照交接 / 无子代理），
  且错误里带得出操作名与工作空间；探测没结论时不许说成"工作空间不存在"。
- **产物级**：`npm run smoke:built` 现在也从打包后的 `lib/index.js` 真调一次
  `discussion-material-open`（空参数 → 结构化 `input` 失败、不回路径），证明这条新契约在**装上去的
  产物**里可达 —— 只查源码"写了没有"证明不了这件事（用缺陷注入验过这条断言会红）。

## package · 0.0.30 · 2026-09-30 · refactor · 配置入口收敛：iFinD 改回可选数据源、账号连接只读、插件不建工作空间

### 目标

一次收敛三件事，职责边界变成：**环境信息**判断基础条件 / **外部数据源**（配置列表里的一步，
可选、不带必检星号）展示与配置 / **账号连接**只读取、检查已有凭据 / **工作空间**只选择已有目录。

### refactor · 同花顺 iFinD 从「必需项」改回**可选数据源**

- 清单 `ifind.required=false`：不进必需项分母（8 → 7），未就绪只让 `status` 落到 `degraded`
  （与 `ready` 一样**放行**），只关掉 `capabilities.externalData` —— `global` / `auditCore` /
  `delivery` 与报告审核都不受影响。
- issue 从"双写 global + external-data 的阻塞项"收成**一条非阻塞**项（scope = `external-data`）：
  归属仍按原因分派（未填 / 无效 → user；无权益 → admin；网络 → system），因为"谁来修"三类不同。
- 环境页顶部改为「基础环境已就绪」，不再出现「还需完成 1 项 / 请完成同花顺 iFinD API-Key 验证」；
  门禁文案回到通用模板（`hasIfindBlocker` 那条专门话术删除）。
- 侧栏那枚环境灯的判据改成 `statusProceedable`：`degraded` 也是绿的，
  否则会出现「红点 + 基础环境已就绪」的自相矛盾。
- 外部数据源**和别的配置项并排**放在配置列表里，而且**排在最后一步**
  （账号连接 → 阿里云 OSS → 工作空间 → 同花顺 iFinD）：那一步的正文就是 iFinD 卡片
  （状态统一为 未配置 / 待验证 / 已配置并验证 / 验证失败 / 数据权限不足 / 暂时不可用）。
  **未配置时直接显示「未配置」**：芯片一律琥珀（红 = "必须处理"），能力清单等已配置后再显示。
- **基础必检项带红色星号**（`REQUIRED_SETUP_STEPS`：账号连接 / OSS / 工作空间；颜色用
  `--dsw-alias-state-error-primary`），**外部数据源不带** —— 用户口径：必检项用星号表示"必须配置"，
  外部数据不加，否则页面看起来很乱。可选项同时不进"还没做完"的统计（`pickStep` / `allStepsDone`
  只统计必检项，且默认落点是**最后一个必检项**而不是末位的可选项）。
- 形态上做过**三次**返工：① **独立的第四个侧栏模块**（被否：「不要单拆一个目录」）；
  ② **页级区块**（被否：「也和其他放在一起…否则页面看起来很乱」）；③ 放在列表中间且"未配置"报红
  （被否：「同花顺这里直接显示未配置就可以」+「把同花顺放到最后一个」）。最终就是**配置列表里的
  最后一步**。

### feat · Windows：提醒"以管理员身份运行"（2026-09-30）

- 钉钉 CLI（`dws`）在 Windows 上要碰 `<HOME>\.dws`（先抢 `.data.lock`，再写操作系统凭据存储）：
  进程权限不足时它以"锁被占用 / 拒绝访问"结束，**表现却是钉钉登录一直不成功**。
- 所以环境页在 `env.platform` 命中 `win32` 前缀时给一条**非阻塞**提醒
  （`features/environment/platform-note.ts` 的 `needsWindowsAdminReminder`）：
  「请用「以管理员身份运行」启动 DeepSeek Harness」——挂在**账号连接**那一步。
- 它**不参与任何门禁**（钉钉登录态是否有效仍由自检结论说了算）；非 Windows **一个字都不提**，
  拿不到平台也不猜。

### refactor · 账号连接只读取、检查已有凭据（协议 21 → 22）

- **删除**氚云内置浏览器扫码登录（协议 20 的 `browser-session-bind` + 客户端浏览器视图 + Cookie 读取）
  与钉钉设备码 / 两阶段登录（协议 21 的 `dws-login-start` / `dws-login-status` + 进度轮询）。
  一并删除 `H3yunBrowserLogin.tsx` / `DwsLoginCard.tsx` / `login-browser.ts` / `open-url.ts`
  （内置浏览器优先的打开器）、`crwuOperationOf` 的 `h3yun session bind` 映射、`dwsLogin` 的 `--device`。
- 保留**兼容路径**：`relogin`（`crwu h3yun session login`）与 `dws-login`（`dws auth login`）——
  本机 CLI 自己拉起**系统浏览器**；面板只触发 + 「重新检查」，不创建浏览器 Tab、不显示二维码 /
  设备码、不读 Cookie、不轮询进度。CLI 的 `dws auth login --device` 在终端里仍然可用。
- 冻结操作清单 41 → 38；`WORKBENCH_PROTOCOL` 22（旧界面调这三个操作会 404，必须被明确挡住）。

### refactor · 插件不再为用户创建工作空间根目录

- `ensureAuditRoot` 删掉 `ensureDirectory`（`mkdir` / `New-Item`）：路径为空 →
  「尚未选定工作空间，请先选择一个已有目录」；路径不存在 / 是文件 →
  「已选定的工作空间目录不存在，请重新选择一个已有目录」——两种情况都**拒绝启动**，
  不静默切到父会话 cwd、也不静默换工作空间。
- 目录存在但未登记 → **只登记**（`workspaceRegistry.create`，它要求目录已存在）。
- 客户端 `UiWorkspaceService` 删除 `createDirectory`，`WorkspaceCard` 去掉「新建目录并用作工作空间」
  与 `pick(true)`，把用户选中的路径原样登记；文案改为「选择已有目录作为工作空间」。
- 允许自动创建的**只有** `<工作空间>/<流水号>` 这一级案例目录（审核启动的 shell 轨迹里
  不许出现 `mkdir <工作空间根>`，有测试按真实 trace 断言）。

### fix · 案例目录创建改走本机访问代理（`mkdir: Operation not permitted` 的根因）

- 员工实测：发起审核后案例目录**没建出来**，子会话里案例内 Tool 全被拒（"调用者不在进行中的审核里"），
  而 `/Users/<员工>/中瑞世联工作空间` 本身是可写的。根因不是 ACL，也不是授权收据：
  `host/tools/case-files.ts` 的 `ensureDirectory` 直接调 `shell/run.ts` 的裸 `runShell`，
  于是这条 `mkdir` 拿到的是**部署默认沙箱**（`workspace-write`，边界 = 员工打开面板的那个会话 cwd），
  写案例目录被沙箱拒绝 —— 员工本人对那个目录其实是有写权限的。
- 新增三条**具名**本机访问操作，提权归属从此写在操作表里（`host/access/operations.ts`）：
  - `system.case-directory.write`：**特权**、来源 `audit-host` —— 只用于创建
    `<员工选定工作空间>/<流水号>` 这一级案例目录，逐次声明
    `danger-full-access` + `workspaceRoot = 已选工作空间`；
  - `system.case-file.write` / `system.case-file.read`：**不提权**、来源 `audit-tool` ——
    案例目录**之内**的建 / 删 / 只读探测（子会话的沙箱边界本来就是那个目录，能给最小权限就给最小）。
- 新增来源 `audit-host`（插件自己的审核编排），与 `audit-tool`（审核子代理调 Tool）刻意分开：
  两者的沙箱位置不同，合并会让"谁在什么沙箱下建目录"重新变成只能从调用点读出来的事实。
- `ensureCaseDirectory` 的顺序固定：① 只读探测工作空间是否真的存在 → ② 经 Broker 执行 `mkdir`
  → ③ 回读案例目录后置条件。**失败分三类给话**：沙箱未授权 / 被降级（带请求模式、实际模式、操作名、
  工作空间）、操作系统 ACL 不足（不动权限、不建议 `chmod`）、工作空间不存在（让员工重选）。
- 后置条件回读不再用 `ctx.fs.stat`，改用 Broker 上的只读路径探测
  （`platform/shell.ts` 的 `pathProbeCommand`：`test -d` / `Test-Path -PathType`，
  **永远以 0 退出、结论只在 stdout**）：这样"读不到"与"不存在"能分开 ——
  前者按基础设施失败如实上报，不会被折叠成"没有这个目录"。
- 新增静态门禁 B-01e（`host-access-migration.test.mjs`）：`case-files.ts` **不许**再出现裸 `runShell`
  或值导入 `shell/run.ts`，`audit/ops.ts` 必须用 `ensureCaseDirectory`；配套一台
  **真的会拦人**的沙箱替身做回归（`host-case-files.test.mjs`），把 2026-09-30 的现场固定下来。

### fix · 同名附件不再互相覆盖（`广兴建筑v3.zip` ×2）

- 一份报告里可以挂着两个**同名但不同**的附件（实测两个 `广兴建筑v3.zip`，`fileId` 不同）。
  按文件名落盘时第二件会**静默覆盖**第一件 —— 审核只看到一份材料，也答不了"这是重复上传还是两个版本"。
- 输入快照的 `附件清单.json` 每行新增三列：`localName`（`<主名>__<fileId 前 8 位><扩展名>`，
  例如 `广兴建筑v3__c8ef13b8.zip`）、`nameIndex` / `nameTotal`（同名附件的序号与总数）。
  名字**只由 `fileId` 决定**，与下载顺序无关；外部文件名先被收敛成单个路径段
  （`host/h3yun/attachment-name.ts`，纯函数、可单测）。
- `crwu_h3yun_file_get` 在任何进程之前校验目标名的最后一段**必须带上这件附件自己的标识**，
  不带就回 `policy` 失败并给出正确的名字；`relativePath` 仍然由模型给，但它再也拼不出
  两个不同附件落成同一个名字的形态。
- 审核提示词同步：附件只按清单里的 `localName` 落盘；`nameTotal > 1` 的条目要当成**两件材料**
  逐件核对，不许只留一件。

### test · 覆盖

- 工作空间：不渲染「新建」按钮、`createDirectory` 调用次数为 0、目录不存在 / 是文件 / 未选定时
  审核启动被拒、存在但未登记时只登记、审核启动不建工作空间根、案例目录仍然创建。
- 登录：相关模块文件已删 + 面板不存在内置浏览器登录 / 二维码 / 设备码入口与承诺、
  阻塞文案改为"请在系统浏览器完成登录后重新检查"、有效凭据照常通过、CLI 兼容路径仍在。
- iFinD：不在环境步骤与必需项分母里、未配置不阻塞环境与审核、区块展示数据源与验证状态、
  未配置时不产生误导性告警。

## package · 0.0.29 · 2026-09-29 · fix · 启动审核：「没问到运行时」不再拒绝启动（交给子会话解析）

### fix · 案例目录建不出来 / 子会话没有 scope 的那条根因

- 员工实测：发起审核后**案例目录没建**、子会话里案例内 Tool 全被拒（"不在进行中的审核里"），
  而能力自检里二进制与 Tool 全 available —— 说明这轮审核根本没成立。
- 根因：`audit-start` 在创建案例目录**之前**解析 DSH 自带运行时，而它在 `host-background` 里
  没有会话作用域 → 工具调用必然报错 → 旧实现一律拒绝启动。
- 现在按 `unresolved` 分开处置：**确实缺失**（载荷无 python / 路径不可用 / 缺必需包）仍然拒绝启动；
  **没能问到**（工具调用失败/超时/报错）**放行**，并把提示词换成新增的
  「由你在本会话里解析」那一段 —— 子会话有 agent 作用域，自己调一次
  `load_workspace_dependencies` 就能拿到唯一允许的解释器绝对路径；仍然禁止任何查找与降级，
  取不到就停下并汇报 capability gap。
- 另记一条**独立阻塞**（不在插件侧、也不该由插件绕过）：该机器上 `workspace-write` 下 pwsh
  每次以 `0xC0000142` 结束、零输出；而审核根/子会话按设计恒为 `workspace-write`，
  材料准备与交付渲染都走 shell → 需 DSH 侧排查沙箱启动器。

## package · 0.0.28 · 2026-09-29 · refactor · 把 DSH 自带运行时**从环境自检里挪走**

### refactor · 运行时只在 `audit-start` 解析，不再进环境结论

- 原因：`load_workspace_dependencies` **需要 agent 作用域**。会话里调它返回完整载荷
  （`python` + `openpyxl` 等），而环境自检跑在 `host-background`、没有会话上下文 —— 调它就是工具报错。
  两种补救都不成立：当"缺失"会伪造「系统故障」把审核入口关掉（0.0.26 之前）；
  只显示「待复核」则那一行**永远解析不出来**（0.0.26/0.0.27 员工实测仍是「未设置」）。
- 现在：环境自检**不再调用解析器、不再有这一行、不再进必需项分母（9 → 8）、不影响总状态**。
- **能力没有放宽**：`audit-start` 仍用审核根 agent 解析运行时，拿不到就终止审核；失败文案区分
  「没能问到」（可重试）与「确实缺失」（只能由部署方补运行时）。取 agent 的唯一实现是
  `boundParentAgent`（`bind-session` 落盘的父会话），`audit-start` 与它共用。
- 一并删除：`RuntimeView`、`env.runtime` 分区、`runtimeItem`、`runtime` issue、
  客户端三行诊断与相关文案键（不留死代码）。解析器本身保留（`audit-start` 要用）。

## package · 0.0.27 · 2026-09-29 · fix · 环境自检用面板绑定的父会话解析 DSH 运行时（真正修掉"未设置"）

### fix · 运行时不再显示「未设置」：自检也带上 agent 作用域

- 0.0.26 只把"没问到"说准（非阻塞 + 待复核），但运行时**仍然解析不出来** —— 因为根因是
  **自检没有 agent 作用域**：`load_workspace_dependencies` 需要它，不带就是工具报错。
- 现在自检在调 `pythonRuntime` 之前，用插件状态里 `bind-session` 落盘的 `parentSessionId`
  取同一个 agent（新增唯一实现 `boundParentAgent`，`audit/spawn.ts`；审核启动用的也是它）。
  取不到时退回不带 agent 的调用（只报「待复核」，不判缺失）。
- 实测依据（员工 Windows）：同一个工具在会话里（带 agent）返回完整载荷
  （`python` 路径 + `openpyxl 3.1.5` 等），自检上下文报错 —— 差别就是 agent 作用域。
- 解析成功会进缓存，因此环境页那一行会变成「Python 3.12.x · DSH 自带」，总状态回到 `degraded`/`ready`。

## package · 0.0.26 · 2026-09-29 · fix · 环境自检「没问到」不再伪造成系统故障（运行时待复核）

### fix · `load_workspace_dependencies` 在自检上下文问不到时，不再把审核入口关掉

- 员工 Windows 实测：环境页报「发现系统故障」，只有 `DSH Runtime: （未设置）` 一项；
  而**同一个工具在会话里（带 agent）返回完整载荷**（`python` 路径 + `openpyxl` 等全部必需包）。
  根因：环境自检跑在 `host-background`、**没有会话 agent**，而该工具需要 agent 作用域；
  旧实现把"工具报错"一律说成"DSH 自带脚本运行时不可用"——一条系统归属的阻塞项。
- 现在把两件事分开：`unresolved`（工具不可用 / 抛错 / 超时 / 工具报错 = **没问到**）与
  **真·缺失**（工具成功但载荷没有 python、路径不存在或不是文件、缺必需包）。
  前者**非阻塞**、页面显示「待复核」并说明"发起审核时会复核"；后者照旧阻塞。
- 真正的门禁不变：`audit-start` 仍带**审核根 agent** 解析运行时，拿不到就终止审核；
  解析成功会进缓存，所以发起过一次审核之后环境页那一行会变成"已就绪"。
- 顺带：`SetupItemView` 新增状态词 `unresolved`（「待复核」），客户端按中性语气渲染。

## package · 0.0.25 · 2026-09-29 · refactor · 下掉"插件自指定目录"：配置与临时目录都用默认

### refactor · `DWS_CONFIG_DIR` 与 `TMPDIR/TEMP/TMP` 两条自指定通道整体移除

- 删除 `src/host/dws/config-dir.ts` 与 `src/host/system/auth-scratch.ts`，以及各调用点的目录注入
  （`dws/run.ts`、`system/ops.ts`、`crwu/run.ts` 的 `scratchDir`、`ops/core.ts`、`apply.ts`、
  体检/身份/环境自检/审核 Tool）。
- 登录命令回到 CLI 默认形状：`crwu h3yun session login`、`dws auth login [--device]` 原样执行，
  配置目录用 `<HOME>/.dws`、临时目录用系统 TEMP —— 与员工自己终端里的用法一致，状态只有一处。
- **为什么下掉**（三次对照，见 `docs/development-notes.md` §16）：同一个 `dws.exe` 在员工自己的
  PowerShell 里能建 `~/.dws`、能打印授权链接；换成插件目录后**仍然**建不出目录；手工预建好目录后
  **仍然**打不开 `.data.lock`；**以管理员身份运行 DSH 一次通过**，而普通权限下连已存在的锁都打不开
  —— 拦的是这台机器对 `dws.exe` 的按程序/按父进程访问控制，换目录解决不了，只留下"两套状态"的代价。
- 归因文案相应补一句「插件已经不再自指定目录，全部回到 CLI 默认」，两条可执行路径不变
  （以管理员身份完成登录 / 让管理员按程序放行随包发布的 `dws.exe`）。

## package · 0.0.24 · 2026-09-29 · fix · 归因补上复验结论：提权**不是一次性步骤**，影响面不止登录

### fix · 别再让人以为"提权登一次以后就好了"

- 员工复验：提权那次登录成功之后，**用普通权限重启 DSH 依旧打不开已存在的锁**
  （`creating config dir for lock` / `opening lock file`）→ 非提权运行时 `dws` 连打开已有文件都被拒。
- 归因文案补两句：① **不是一次性步骤**（非提权每次都会被拒）；② **影响面不止登录** ——
  同一台机器上凡是依赖 `dws` 的功能（知识库下载、钉钉归档与通知）同样需要提权才能用。
- 两条长期正解不变：让 IT 按程序放行随插件发布的 `dws.exe`（放行后恢复普通权限运行），
  或在放行前以提权方式使用 DSH。

## package · 0.0.23 · 2026-09-29 · fix · 登录失败归因纠正：这台机器上**提权才有效**，换目录无效

### fix · 不再把员工指向"切访问模式"

- 0.0.22 的归因里写着「切权限不会有用」—— 前半段（切【DSH 访问模式】没用）是对的，
  但它被写成了"切权限一律没用"，而员工当场实测：**以管理员身份运行 DSH 后一次通过**。
  两条实测事实必须分开说，否则会把下一个人指到错方向。
- 现在机器支的文案改为：说清事实（请求与实际都已是 `danger-full-access`）+
  给出两条可执行路径（**以管理员身份运行 DSH 完成一次登录**；长期让 IT 按程序放行 `dws.exe`）+
  明确写出「**换目录也没用**」（主目录根、插件状态目录、手工预建的插件目录三个位置都试过）+
  「设备码登录同样要创建这个锁文件，不是绕过办法」。
- 提权那次登录的凭据写进**员工本人**的操作系统凭据存储（同账户、只是令牌提权），
  因此受管机器上"提权做一次性登录"是可接受处置。
- 测试用 `doesNotMatch` / `match` 双向钉住这两点，并逐条用缺陷注入证伪。

## package · 0.0.22 · 2026-09-29 · fix · `dws` 配置目录固定用插件自己的目录（协议 22）

### fix · 钉钉登录不再依赖 `<HOME>/.dws`（那台机器上 DSH 的子进程建不出来）

- 员工 Windows 实测：`creating config dir for lock: mkdir C:\Users\<你>\.dws: Access is denied`，
  而 DSH 的诊断里三种模式全是 `danger-full-access` —— 与 DSH 的文件策略无关。
- 证据链（详见 `docs/development-notes.md` §16）：① 同一个 `dws.exe` 在员工自己的 PowerShell 里
  能建 `~/.dws` 并打印授权链接；② **`~/.dws` 已存在也照样报同一个错** —— Windows 的
  `CreateDirectory` 先查父目录创建权再查目标是否存在，所以这是**令牌访问范围**问题，不是缺目录；
  ③ DSH 放行它自己的目录树（插件状态文件与登录临时目录都是插件在 DSH 里建的）；
  ④ 全新空目录里 `auth status` 仍 `authenticated:true` → **token 在操作系统凭据存储里，换目录不丢登录态**。
- 现在所有 dws 调用**一律显式**带 `DWS_CONFIG_DIR=<HOME>/.dsh/crwu-workbench/dws-home`
  （显式写进命令，不再赌进程有没有继承环境变量）。
- **刻意不做**探针、不做"失败后换目录"、不做重试：登录是有副作用的交互，不能靠重试兜；
  而只读的 `auth status` 在只读路径上可能不碰锁，拿它当判据实测会漏判。
- 代价如实说：员工自己终端里的 `dws` 与插件用不同配置目录（锁/日志分开；
  多组织时"当前组织"可能要各选一次）。

## package · 0.0.19 · 2026-09-29 · feat · 两个登录都改走内置浏览器（协议 20 / 21）

### feat · 氚云：面板内嵌 lease 浏览器扫码，读到 h3_token 就交给 CLI 落 OS 凭据存储

- 环境页新增「在内置浏览器里扫码登录」：插件在桌面端自建一个宿主的 lease guest
  （`dshDesktop.browser.acquire` → `<webview partition src="about:blank#<lease>">` → `dom-ready` 后导航），
  扫码后从页面 `document.cookie` 读 `h3_token`，**立刻**经新增操作 `browser-session-bind`（协议 20）
  交给 `crwu h3yun session bind --token-stdin`。令牌不进命令行、不落盘、不回显、不进日志。
- 拿不到内置浏览器（Web profile / 旧桌面端）时卡片禁用并给出回退说明；CLI 自己拉浏览器的老路径保留。
- E1 探针实测（桌面端 0.2.0-rc.2，macOS，钉钉扫码一次）：lease 桥可用、`<webview>` 可附着、
  `executeJavaScript` 可读 `document.cookie`、`h3_token` 是未过期 JWT（约 48h）、
  导航里出现 `www.h3yun.com/entry/login/corp?code=` 回调、`release` 干净。
  备通道（抓 `?code=` 由 Host 换取）已观测到，暂不启用。

### feat · 钉钉：`dws auth login` 改成后台跑 + 两阶段（协议 21）

- 旧形态是同步等 5 分钟再回 stdout 尾巴 —— 授权 URL 到界面时用户早已不在等。现在
  `dws-login-start` 起后台进程并立刻回快照，`dws-login-status` 轮询；界面先把**动作**摆出来
  （打开授权链接 / 复制设备码），再给 CLI 原文。解析是尽力而为，`tail` 始终是原文。
- **打开在 DSH 内置浏览器**（右侧栏 browser 标签，`openTab`），拿不到服务 / 标签类型未启用 /
  异步失败才退回系统浏览器 —— 裸 `window.open` 在桌面端等于"跳到 DSH 外面"。
- 正在跑时再 start 不会起第二个进程（两个 `dws` 会抢同一个 `~/.dws` 锁）；
  5 分钟到点杀掉并如实报超时；插件卸载时杀掉仍在跑的进程。
- 副作用：所有操作数与协议号随之 +1（41 个操作 / 协议 21），冻结清单与 facade 已同步。

### chore · 新增后台执行通道

- `src/host/shell/run.ts` 的 `startShell` + Broker 的 `startShell`：与前台同一条授权/提权判据，
  用 `execute()` 但不 await `result()`，请求带 `onExpiry: 'none'`。

## package · 0.0.18 · 2026-09-29 · chore · 把 DSH 0.2 线的验证矩阵推进到 `0.2.0-rc.2`

### fix · iFinD 环境检查改为只读用户主动验证结论

- 保存 API-Key 或点击「重新验证」时完成一次真实取数，并把脱敏结论随凭据保存。
- 普通环境检查、刷新和能力门禁只读取最近结论，不再主动请求 iFinD 远程服务。

桌面端 DSH 已升到 `0.2.0-rc.2`。**业务代码零改动** —— 逐包比对证明这条线内没有 API 漂移，
要补的是"声明支持"与"真的验过"之间的差：仓库原先只在矩阵里验到 `0.2.0-rc.1`。

**逐包比对结论**（2026-09-29，把 16 个插件用到的 `@deepseek-ai/dsh-*` 在 rc.1 / rc.2 各
`npm pack` 一次，解包后逐文件 diff）：

| 差异 | 包 |
| --- | --- |
| **所有 `.d.ts` 零差异** | 16/16 |
| 只有 `package.json`（版本号 + 内部依赖表） | 13 个：`dsh-tools` / `dsh-agent` / `dsh-sandbox-policy` / `dsh-user-approval` / `dsh-skill-filesystem` / `dsh-host-webserver` / `dsh-plugin-manager` / `dsh-shell` / `dsh-session` / `dsh-fs` / `dsh-util-values` / `dsh-client-ui-layout` / `dsh-app-boot` |
| 另有运行时代码小改动 | `dsh-subagent/lib/typert.host.js` 多一条 `user-question-reply` typert 协议声明；`dsh-client-ui-renderer/lib/client.js` 加一个 `useMemo`；`dsh-client-ui-sidebar/lib/client.js` 去掉品牌按钮外层 `Tooltip` 并换版本号 |

据此：把 `src/` 复制进一个只装了 `0.2.0-rc.2` 完整 peer 集的临时工程跑 `tsc --noEmit`，
**0 error**；插件用到的 slot / Tool / Shell / Sandbox / Subagent API 一个都没变。

**本版改了什么**

1. **兼容矩阵的代表版本换成 `0.2.0-rc.2`**：`scripts/check-dsh-compat.mjs` 的 `RUNTIMES`
   与 `tests/unit/host-package.test.mjs` 的 `SUPPORTED_DSH_RUNTIMES`。一条声明线只放一个
   代表版本（同线后续 rc 与正式版由 `^0.2.0-rc.1` 的区间语义覆盖），`0.3.x` 仍然明确不在范围内。
2. **`devDependencies` 从 `^0.1.7-rc.2` 挪到 `^0.2.0-rc.2`**（15 个，与全部 peer 一一对应）：
   默认的 `npm run typecheck` / `npm test` 现在验的就是员工装到的那条线，而不是旧线。
   `peerDependencies` 与 `engines.dsh` **不动** —— `^0.1.7-rc.2 || ^0.2.0-rc.1` 本来就覆盖 rc.2，
   0.1.7 线的用户不受影响。
3. 文档同步：`README.md` / `README.en.md` 的支持矩阵与兼容段落、`AGENTS.md` §8.6
   （新增「同一条线内的新 rc 也要进验证矩阵」一条）、`docs/development-notes.md` §11
   （新增一行"升级 DSH 到同线新 rc 怎么办"的完整处置步骤）、`docs/windows-acceptance.md`
   的 DSH 版本栏。

**验证**：`npm run check`（含 `version:check` / `config:check` / `skills:check` /
`skills:cli-guard` / `dws:check` / `typecheck` / 全量单测 / `build` / `smoke:built`）、
`npm run pack:assert`，以及 `npm run compat:dsh`（0.1.7-rc.2 与 0.2.0-rc.2 两条线各真装一遍）。

## package · 0.0.17 · 2026-09-29 · fix · 登录失败归因分两支 + 登录临时目录由插件指定

员工在 Windows 上点「扫码登录氚云 / 钉钉登录」持续失败。开发者诊断给出的结构化事实是
`req = res = ran = danger-full-access`、`denied=false`、`runnerFailed=false`、`started=true` ——
**DSH 没有拦这次调用**；原文却是

```
create fallback browser profile directory: mkdir C:\Users\51019\AppData\Local\crwu: Access is denied.
(system TEMP failed: mkdir C:\Users\51019\AppData\Local\Temp\crwu-scan-556823159: Access is denied.)
```

两条路径都在 `AppData\Local` 下、都被拒，而同一时刻 `dws auth status` 是 ok（`~/.dws` 可写）。
本版据此做两件事，都只动插件侧：

1. **登录的临时目录改由插件指定**（`src/host/system/auth-scratch.ts`）：先建
   `<home>/.dsh/crwu-workbench/auth-tmp`，再把 `TMPDIR`/`TMP`/`TEMP` 指过去
   （POSIX `mkdir -p … && TMPDIR=… <cmd>`；PowerShell `New-Item -Force …; $env:TMP=…; & <cmd>`）。
   依据是员工机器上的事实：系统 TEMP 与用户缓存目录都被拒，而插件状态目录（`<home>/.dsh/…`）可写。
   **不动 `LOCALAPPDATA`**（Chromium 自己的组件目录仍走系统默认）；主目录未知时原样返回命令，不伪造。
   `runCrwu` 增加可选 `scratchDir`（只有会就地起浏览器的那条命令用）。
2. **归因分两支，不许合成一句**（`LoginAdvice.policyBlocked`）：结构化事实说降级 / 拒绝 / 实际受限
   → 「被文件策略挡在工作区之外」，动作是切「完全权限」；**事实干净却照样 `Access is denied`
   → 「被这台机器拒绝（不是 DSH 的文件策略）」**，明说"切权限不会有用"，并给退路
   （氚云 `crwu h3yun session bind --token`、钉钉先试「设备码登录（无浏览器时）」）。
   上一版把两支合成一句"请切完全权限" —— 员工按提示切了，而日志证明根本不是策略问题（误导）。
3. 面板「账号连接」的前置说明同步改口径，并回到"设备码登录（**无浏览器时**）"
   （它不是"沙箱挡浏览器"的退路：同样要抢 `<HOME>/.dws` 的锁）。

**已证伪**：把两支合成策略支 → 5 条变红；把 scratch 的 env 前缀去掉（只建目录不指过去）→ 2 条变红。

### ① 登录失败归因：两支分开，不许合成一句

**症状**：员工第一次用（Windows 与 macOS 都报）时，点「扫码登录氚云」「钉钉登录」浏览器起不来；
面板给的却是 CLI 的原话 —— 氚云 `mkdir C:\…\Temp\crwu-scan-1799287186: Access is denied.`
（看着像 crwu 坏了）、钉钉 `acquiring file lock: …\.dws\.data.lock: Access is denied.`
（看着像 dws 自己的 bug）。

**根因（两条入口同一条边界）**：登录**必须写工作区之外的路径** ——

| 入口 | 必须写的东西 |
| --- | --- |
| `crwu h3yun session login` | `$TMPDIR`/`%TEMP%` 下的临时浏览器 profile（`crwu-scan-*`），再经 CDP 读会话 |
| `dws auth login`（含 `--device`） | `<HOME>/.dws/.data.lock`（拿登录态之前先抢文件锁） |
| 两者收尾 | 操作系统凭据存储（钥匙串 / Credential Manager） |

宿主按完全访问跑、操作系统的 ACL/受限令牌仍然拒绝时报的就是上面那两句；受限沙箱下浏览器即使
起来了也会在几毫秒内 renderer 崩溃（CDP 只回 `close 1006` / `Target crashed`）。

- **新增纯函数判据** `src/host/system/login-failure.ts`：`loginFailureAdvice()` / `describeLoginAdvice()`。
  顺序是「结构化事实优先，文本最后」：① `runnerFailed` → ② 提权被降级（`requested !== resolved`）
  → ③ `denied === true` 或实际跑在受限模式 → ④ **事实干净但原文点名了登录必须写的工作区外目标
  且带拒绝字样**（Windows 实测就是这一形态）。
- **第 ④ 条是 `sandboxDenialNote()` 的唯一例外**，判据本身变强了：目标不是"任意路径"，而是登录
  流程必须写的那几个已知目标。**目标词与拒绝字样必须同时命中** —— 只命中一个不归因（否则
  `secret not found in keyring` 这种"真没条目 / 钥匙串被锁"会被说成"去切完全权限"）。
- **`dwsLogin` 以前完全不做归因**（只有 `runDws` 做），现在两条登录都返回 `sandboxBlocked` + `advice`，
  并把「在输入框下方的访问模式里选「完全权限」再点一次」写进 `error`，**原始报错保留**在末尾。
- **设备码不再是"退路"**：它同样要抢 `~/.dws` 的锁，所以按钮文案改回「设备码登录（无浏览器时）」，
  归因文案里明说"在这个模式下也走不通"。
- **界面**：「账号连接」页在登录按钮下方**先说前置条件**（`envLoginSandboxHint`）；
  被归因时不再追加 stdout 尾巴（否则那句「正在打开浏览器窗口…」会把真正的动作挤掉）。

**已证伪**：把第 ④ 条整段关掉 → 7 条变红；把「目标词」那一半去掉（只认拒绝字样）→
误报用例变红。`cp` 还原后转绿。

### ② 登录的临时目录由插件指定（不再依赖系统 TEMP）

员工在 Windows 上用 0.0.15/0.0.16 再报一次，原文是**两条路径都被拒**：

```
create fallback browser profile directory: mkdir C:\Users\51019\AppData\Local\crwu: Access is denied.
(system TEMP failed: mkdir C:\Users\51019\AppData\Local\Temp\crwu-scan-556823159: Access is denied.)
```

而同一时刻开发者诊断里 `h3yun.session.login` 是
`req = res = ran = danger-full-access`、`denied=false`、`runnerFailed=false`、`started=true` ——
**DSH 没有拦它**，`%TEMP%` 与用户缓存目录却都被这台机器拒绝。两处修正：

1. **临时目录改由插件指定**（`src/host/system/auth-scratch.ts`）：登录命令先建
   `<home>/.dsh/crwu-workbench/auth-tmp`，再把 `TMPDIR`/`TMP`/`TEMP` 指过去
   （POSIX `mkdir -p … && TMPDIR=… <cmd>`；PowerShell `New-Item -Force …; $env:TMP=…; …; & <cmd>`）。
   依据是**这台机器自己的事实**：系统 TEMP 与缓存目录都被拒，而插件状态目录（`<home>/.dsh/…`）
   是它一直在写的地方。**不动 `LOCALAPPDATA`**（Chromium 自己的组件目录仍走系统默认）；
   主目录未知时**原样返回命令**，不伪造一个没建出来的目录。
   `runCrwu` 增加可选的 `scratchDir`（只有会就地起浏览器的那条命令用）。
2. **归因分两支，不许合成一句**：`LoginAdvice.policyBlocked`。
   - `true`（结构化事实：降级 / 拒绝 / 实际受限 / runner 挂）→「被文件策略挡在工作区之外」，
     动作是切「完全权限」；
   - `false`（事实干净、原文点名登录必须写的目标且带拒绝字样）→「**被这台机器拒绝**（不是 DSH 的
     文件策略）」，明确写「切权限不会有用」，并给退路：氚云用 `crwu h3yun session bind --token`、
     钉钉先试「设备码登录（无浏览器时）」。

   上一版把两支合成了一句"请切完全权限"——员工按提示切了，而日志证明根本不是策略问题（**误导**）。

**已证伪**：把两支合成策略支 → 5 条变红；把 scratch 的 env 前缀去掉（只建目录不指过去）→ 2 条变红。

## package · 0.0.16 · 2026-09-29 · fix · Windows 氚云扫码临时目录回退

- 随包 `crwu.exe` 的 `h3yun session login` 在系统 `%TEMP%` 被 Windows 安全策略拒绝时，
  自动回退到 `%LOCALAPPDATA%\crwu\scan-tmp\crwu-scan-*`；登录结束仍清理临时 profile。
- 回退只针对权限错误，且不改变 OS 凭据存储边界；若用户缓存目录也被拒绝，保留两段错误供
  Defender/企业安全软件排查。

## package · 0.0.15 · 2026-09-28

**协议 18：本机访问从「调用方声明提权」改成「具名操作 + 版本化授权收据」，
审核会话固定收敛到 `workspace-write` + `approval=never`。**

这是**跨进程契约的语义破坏**，不只是加字段：旧的 `trust` 布尔不再被接受（协议不匹配直接失败，
不会被当成"已授权"），`crwu` 直通 RPC 不再接受 `escalate` 参数，提权改由**操作身份**决定。
装上升级后需要**完整退出并重启** DSH（客户端与宿主是两个进程，只刷新页面会留下旧宿主）。

### 为什么要换形态（员工实测的三段报错）

| 员工看到的 | 真正的原因 | 旧形态为什么分辨不出 |
| --- | --- | --- |
| 写 `%USERPROFILE%\.ossutilconfig` 报 `file access denied under workspace-write mode` | DSH 沙箱拒绝 | `escalate: true` 只是一个布尔，看不出"这一步到底放行了什么" |
| 氚云报 `secret not found in keyring` | 受限沙箱读不到钥匙串，**不是**没登录 | 未授权时会先探一次凭据，把假结论当真相 |
| DWS 报 `.data.lock: Access is denied` | 沙箱写不了 / 真 NTFS ACL / 锁被占用（三种） | 三者文本一样，只能靠猜 |

三段表象不同、原因相同；而同**一句** `Access is denied` 又可能是三种完全不同的原因。
所以这一版把"提权"变成一个**具名操作的属性**，把"为什么失败"变成**结构化事实的推理**。

### A · 版本化同意 + 安全的环境引导（协议 18）

- 授权收据带 `schemaVersion` + `grantedAt` + **固定的五项能力**；旧的 `trustCredentials: true`
  一律判为 `outdated`（**永远不是**一次授权）。
- **未授权时一个凭据进程都不起、一个凭据字节都不读**（原来会先探一次，于是"未登录/密钥错误"
  这种假结论会被写进交付件）。未授权在环境自检里是**阻塞项**，不是"未登录"。
- 授权入口在环境 workflow 的「账号连接」里（不是遮住整页的模态框），并带一次明确的「暂不允许」。

### B · 本机访问代理（Local Access Broker）

- `src/host/access/{operations,diagnostics,broker}.ts`：**封闭的操作表**（27 个操作，
  每个固定 capability / 通道 / 是否提权 / 允许的来源）+ 唯一能声明 `danger-full-access` 的地方。
- `runShell` **没有** `escalate` 参数；调用方只能选一个操作名，不能提交命令、二进制路径、
  沙箱模式或提权开关。文件写入还要求"目标种类 + 绝对路径"逐字对上。
- 全量迁移：状态文件、iFinD 凭据、OSS 配置与**每一次** `ossutil`、氚云全部子命令、
  `dws` 全部白名单前缀、浏览器/剪贴板/案例目录、13 处审核 Tool 调用点。
- **归因只看结构化事实**：`requested` / `resolved` / `ran` / `denied` / `runnerFailed`。
  `ran` 也要看 —— 请求活过了 `resolve()` 却在执行时被降级是最难发现的一种。
- 迁移守卫（`host-access-migration.test.mjs`）：业务 CLI 只能在登记的执行器里拼命令、
  且必须经 Broker；这条守卫在开发中真的抓到两处自己拼 `dws` 命令的调用点。

### C · 审核会话收敛

- 审核根与审核子会话**永远** `workspace-write` + `approval=never`：用 DSH 自己的
  `setSandboxMode` / `setApprovalPolicy` 写入，再**回读**，并按 DSH 的委派捕获口径确认
  "子代理将要继承到什么"。**不依赖部署默认**（默认可能是 `danger-full-access`）。
- 带 `auto` / `danger-full-access` preset 的根**不可复用**；创建子代理前还有一道环境就绪门禁；
  子会话发布后按它自己的 scope 复查策略与工具可见性，不对就**停掉它**。
- 登录类操作（`h3yun.session.login` / `dws.auth.login`）的 `allowedSources` **只有面板**：
  审核链路连登录这个动作都拿不到。提示词里明令"未登录就停下、要员工回工作台"。

### D · 桌面归因与修复指引

- `src/host/access/classify.ts`：九档优先级的**纯函数**分类器，把三段表象分开成
  `os-credential-store` / `file-lock` / `os-filesystem-permission` / `sandbox-denied` /
  `sandbox-downgraded` / `infrastructure` / `cli`。
  `sandbox-exec: sandbox_apply: Operation not permitted` **永远**是基础设施故障，
  不会被翻译成"命令缺失 / 没登录 / 凭据无效"；锁必须有**正向探测**才定性。
- 新 Host 操作 `dws-local-doctor`（只读、零参数、目录由 `<home>/.dws` 推导）与
  `dws-local-permission-repair`（**只给面板**、必须 `{ confirm: true }`、要求体检**正向确诊**
  "本机文件权限问题"）。修复只动 `.dws`（700）与 `.data.lock`（600）：不 `chown` / `takeown` /
  `sudo`、不删锁、不碰父目录、拒符号链接，修完**重新体检**。
- 界面：修复按钮**只在确诊本机文件权限问题时渲染**，并且要**二次确认**（改权限 ≠ 允许读本机凭据）。
  沙箱拒绝 / 降级 / 钥匙串 / 认证失败 / 所有者不对 / 文件锁都不渲染。
- `@deepseek-ai/dsh-sandbox-policy` 与 `@deepseek-ai/dsh-user-approval` 加入 peer + dev
  （与其余 7 个 peer 同口径；宿主产物会 `import` 它们，接收方由 DSH 运行时提供）。

### 操作清单：33 → 38

新增 `local-access-grant` / `local-access-revoke`（A）、`access-diagnostics`（B，只读）、
`dws-local-doctor` / `dws-local-permission-repair`（D）。`crwu` 直通入口的 `escalate` 参数已删除。
冻结清单在 `tests/helpers/frozen-inventory.mjs`，漏登记会直接红。

### 复查期间加固（2026-09-29，用户复查逐条点出后修）

下面这些**都在本版里**（0.0.15 未发布，所以按最终形态记），每一条都能被具名用例证伪：

- **授权/撤销的状态迁移只由 `host/access/consent.ts` 负责**：调用方不得把返回的收据写回活状态 ——
  写盘失败时那份视图可能来自**磁盘上的旧授权**，照抄等于一次失败的「重新允许」把权限重新打开。
- **案例目录必须落在选定工作空间的信任域内**：此前这条要求只写在注释里。`caseDir` 是模型参数，
  只校验"绝对 + 存在 + 是目录 + 没有 `..`"等于没校验 —— `crwu_audit_oss_publish` 会把**任意可读文件**
  传到 OSS（读不受沙箱限制），`crwu_h3yun_record_get` / `files_list` 更把它**原样当特权命令的 cwd**。
  现在 `allowedRoot` 是**必填参数**（编译器保证没有调用点能漏传），运行时漏传 fail closed。
- **信任域未知一律拒绝，不许"跳过检查继续做"**：`openPath` 曾经是后者，那天唯一挡住它的是
  "提权必须有 workdir"与案例根兜底**恰好相等**；判据现在落在任何 fs 探测之前。
- **锁归因要两个条件**（原始失败与锁有关 **且** 正向探测证明有人持有）；Windows 的锁探测必须沿
  `InnerException` 解包到根异常再读 HResult（旧写法让"真有进程持锁"也落 `Unknown`，W-05 在代码上不可达）。
- **目录与 `.data.lock` 分别探权限**：只探目录会让"目录正常、锁文件不可写"退化成 `cli`、修复入口永不出现；
  修复只动被证明有问题的对象，回读也只核对修过的那些。
- **Windows ACL 算有效权限**：`Modify = 197055` / `FullControl = 2032127`（夹具曾把后者标成 Modify）；
  判据是"所需**写**权限"是否被完整覆盖，**部分 Deny**（`(W)`、Delete）同样算不可写 —— 旧实现整个忽略。
- **脱敏声明要有端到端证据**：取数摘要的净化此前只在失败路径被喂过 token，成功路径只试过 `{"v":1}`；
  现在按"零件级 + 接线级"两条分别取证（对象路径的密钥字段整条丢 ≠ 文本的值级净化）。
- **卸载路径此前从未被执行过**：`smoke:built` 现在调用每个 `ctx.effect` 的 disposer，断言同源路由被摘、
  工具被逐个注销（忘 `return` disposer 是 Cordis 的经典坑，本地以前完全看不见）。

### 复查第二轮：**审核 scope 绑定**（协议 19）

第一轮修的是"案例目录必须在工作空间之下"。用户第二轮复查指出：这**不够** ——
一个工作空间里通常有很多案例目录，于是 S1 的子会话可以传 `<工作空间>/S2`、
或传工作空间根再读 `S2/文件`（把别的案例读出来传上 OSS、或往别的案例里写）；
氚云的 `objectId` / `fileId` 也是模型提交的，Host 没有把任何东西绑到**本轮**审核上。

- **Host 权威 scope 落盘**：创建记录时写死 `casePath`（= `<工作空间>/<流水号>`）、`attemptId`
  与 `allowedAttachmentIds`（来自**可信输入快照**），跨重启保留。认领来的旧记录 scope 不完整 →
  案例内 Tool 一律拒绝（不拿工作空间兜底）。
- **统一门禁 `requireAuditScope`**：按 `exec.agent.id → childId → 记录` 找本轮 scope，
  `caseDir` 必须与 `casePath` **规范解析后精确相等**（工作空间根、兄弟案例、案例目录的子目录一律拒绝；
  Windows 盘符/UNC 按风格大小写不敏感，POSIX 大小写敏感），`seqNo` / `objectId` 必须一致，
  无身份 / 未知 childId / 已结束 / scope 不完整一律 fail closed。通过时**返回 Host 的路径**，
  调用方不再使用模型给的字符串。
- **氚云边界收紧**：`crwu_h3yun_record_get` / `files_list` 移出审核子会话的必需集
  （注册面与审核能力集拆成 `CRWU_BUSINESS_TOOLS` / `REQUIRED_AUDIT_TOOLS`），
  审核子会话调用它们直接拒绝且**零进程**；`crwu_h3yun_file_get` 只接受快照里登记的 `fileId`，
  表外 id 在起进程之前拒绝。`case_bootstrap` 也要求 `caseDir` 精确等于 Host 约定算出的那一个。
- **真正的写边界是案例目录**：审核根的 `cwd` 与 `workspace-write.workspaceRoot` **都**改成
  本轮案例目录（回读核对），一条根只服务一个案例，工作空间级旧根（`casePath` 为空）判**过期**不复用；
  占用门禁提前到"建目录 / 建根"之前，所以被拒的发起**零副作用**（不建空目录、不起根会话）。
  于是通用 shell / fs 也只能写自己的案例目录 —— 这一条与设计文档"只能写自己的案例目录"终于一致。
- **协议 18 → 19**：这是跨进程权限语义变化，旧宿主仍按工作空间级边界跑审核，
  必须靠协议号把"界面新、宿主旧"拦下来（客户端会要求完整重启）。
### F 段：可观察的停止状态机 + 当前审核会话入口（2026-09-29）

- **两阶段停止协议**：`audit-stop` 立刻把阶段写成 `requested` 并落盘后返回"已接受"，
  abort → dispose → 静默复查在后台继续，阶段逐段落盘；`audit-status` 每条记录带
  `stop`（`phase` / `requestedAt` / `elapsedMs` / `quiesced` / `aborted` / `disposed` /
  `error` / `notes` / `canStartNext`），并加一个顶层 `canStartNext`。
  重复点停止**幂等**（`alreadyStopping`，不启动第二条流程、不重复 abort）。
- **阶段枚举**：`idle` / `requested` / `aborting` / `waiting-quiescence` / `quiesced` / `timeout` / `failed`。
  `canStartNext` **只由 Host 判定**：没确认静默（timeout / failed / 进行中）一律 false，
  且**不依赖占用锁在不在**（重启后锁可能没恢复，"没确认停下"仍然成立）。客户端缺字段按未知处理。
- **启动门禁**：停止流程在跑、或上一条留下 timeout / failed 时，`audit-start` 直接拒绝；
  界面同时把行上的「AI 审核 / 重新审核」置灰（与 Host 的 `canStartNext` 取交）。
- **界面（F2/F3）**：顶部「当前审核」摘要卡（流水号 / 项目 / 状态 / attempt / 开始时间 /
  childId 脱敏尾部 / 停止阶段 / 观察），**在表格之外**，所以当前审核不在当前分页或筛选结果里时
  依然可见；阶段文案用 `aria-live="polite"` 播报、等待期间显示"已等待 N 秒 · 最多等待约 8 秒"、
  停止按钮禁用；timeout 给「继续等待 / 再次停止 / 复制诊断」，failed 给「打开当前会话 / 复制诊断」
  并显示真实错误与"当前审核仍被保留，未释放占用"。
- **「打开审核会话」**：用**被点那一行**的 `childId` / `parentSessionId`（`openSessionTarget` 是唯一解析点），
  `childId` 为空时按钮显示「会话正在建立」并禁用；它与「AI 审核结果分析（`audit_analysis`）」
  是两个入口、两个目标会话（文案与目标都有断言）。
- **客户端停止口径是纯函数**（`features/report-audit/stop-view.ts`）：阶段文案 / 语气 / 可用动作 /
  `canStartNext` 都能被单测穷举（7 条），组件只负责渲染。
- **协议号仍是 19**：新增的 `stop` / `canStartNext` 都是**可选**字段 —— 旧客户端忽略它们照常工作，
  新客户端在旧宿主上把它们当"未知"（不显示"已停止"、也不放行下一条）。没有破坏性契约变化。

### 第三轮复查：4 个 P1 + 2 个 P2（全部已修，逐条有用例与缺陷注入）

- **子会话必需集与 deny 集重叠（P1）**：`crwu_audit_case_bootstrap` 既是"根必需"又是"子会话 deny"，
  而子会话复查用的是根必需集 —— 真实 `toolFilter` 生效后**每条正常子会话都会被判成缺工具并停掉**。
  现在拆成 `REQUIRED_AUDIT_TOOLS`（根必需）与 `REQUIRED_AUDIT_CHILD_TOOLS`（子会话必需 = 根必需 − deny），
  并有一条门禁断言两个集合**不相交**；子会话复查专用后者。
- **pending scope 按父会话认领会允许 sibling 冒领（P1）**：父会话 id 只能证明"属于同一个 root"，
  证明不了"就是本次 `start()` 创建的那一个"。one-shot `start()` 没有预留 child id 的参数、
  拿不到不可伪造的 launch token，所以窗口内**案例内 Tool 一律 fail closed**（
  `auditScopeFor` 只认与记录逐字相等的 childId）；父会话判据只保留在**拒绝方向**（`isAuditChild`）。
- **失败分支忽略 `quiesced`（P1）**：子会话可见性/策略复查失败、最终落盘失败这三条路径此前直接
  回滚记录与句柄；dispose 超时且 Agent 仍 running 时，会形成"旧子会话继续写案例目录、Host 已抹掉身份"。
  现在检查 `quiesced`：没确认静默就写成**退役记录**（`retired: true`，只拒绝不放行）、
  **保留** run 句柄与占用，并提示去工作台重试停止。
- **读不到 child Agent 仍继续审核（P1）**：`SubagentRun.localAgent` 对远程 provider 是 `undefined`，
  而边界复查全靠它。现在保留并优先使用 `localAgent`，**读不到就停掉并失败**（不再只记 warning）；
  `pickProvider` 也**不再回退到"第一个注册的"**，只接受本地可验证的 provider（`spawn` / `fork`）。
- **orphan pending 跨重启可冒领（P2）**：创建失败且回滚写盘也失败时，磁盘会留下 `pending: true` 的记录。
  恢复时把它**退役**（不发放 scope），并且**不恢复指向空 childId 的占用锁**。
- **`auditStop` 返回写死的停止结果（P2）**：现在透传真实的 `StopOutcome`
  （`aborted` / `disposed` / `quiesced` / `interrupted` / `agentCancelled` / `notes`）。

### 第二轮复查：5 个 P1 + 2 个 P2（全部已修，逐条有用例与缺陷注入）

- **子会话策略复查用了错的边界**（P1）：协议 19 已把子会话的边界/cwd 收紧到案例目录，
  但复查仍拿整个工作空间当期望值 —— **正常可见的子会话会被稳定判错并停掉**。
  现在传 `caseDir`，并新增"真实可见 child + 正确案例目录能正常启动"的**正向**用例
  （旧夹具的 `agents.get()` 只返回根 Agent，整段复查被跳过，所以这条一直没被抓到）。
- **发布后的子会话没有被真正限制工具**（P1）：`record_get` / `files_list` / `case_bootstrap`
  仍可见可执行 —— "必需集名单"只是预检名单，不是边界。现在按 provider 的
  `capabilities.toolFilter` 显式传 `toolFilter.deny`（DSH 在子会话创建窗口里做 scoped
  `tools.restrict()`：**既不进 prompt、也拒绝执行**），**不支持过滤的 provider 在创建子会话之前拒绝**。
- **子会话发布早于 scope 建立**（P1）：`subagents.start()` 返回前子会话已在跑，那段窗口里
  身份拒绝失效、案例内 Tool 随机失败。现在**两阶段握手**：创建子会话**之前**先落一条
  pending 记录（父会话 = 审核根），窗口内按父会话认领本轮 scope；`start()` 返回后写真正 childId；
  创建失败 / 子会话复查失败一律回滚 pending。
  窗口内的"父会话"有**两条来源**：会话头的 `meta.parentSession`，读不到就问 `subagents.listChildren`
  （会话存储驱动，Host 权威）"审核根的孩子里有没有这个调用者" —— 两条都拿不到才 fail closed。
  这样一来该判据不再依赖另一个组件是否写了元数据。
- **dispose 超时被当成停止成功**（P1）：计时器是**正常 resolve** 的，旧实现在超时时
  `disposed=false` 但 `errors=[]`，上层据此继续重启。现在区分"谁赢了"，并以**静默判据**
  `quiesced`（dispose 完成 **或** Agent 已不在 running；问不到状态 = fail closed）为准：
  没确认停下来就**不覆盖旧记录、不启动下一条**，句柄与占用一并保留。等待也改成**有界**
  （没有 timer 服务时退化成全局定时器，绝不无界 await）。
- **返回记录的身份没有核对**（P1）：`records get --id B` 取回一条记录 ≠ 取回的是 B。
  现在**在请求附件与任何写盘之前**核对返回记录的 `ObjectId` / `SeqNo`：缺字段或与请求不一致
  一律 fail closed（不再用调用方提交的值兜底）。
- **把不透明的 `targetKey` 当路径解析**（P2）：`FsTarget.targetKey` 是 `Branded<'FsTargetKey'>`，
  合同只允许等值比较；旧实现做分隔符/大小写归一化，形似 Windows 路径但区分大小写的后端会被错误放行。
  现在只做 `===`（`displayPath` 不再当身份用）；我们自己产生的路径字符串另有 `samePathText`。
- **审核记录持久化失败仍返回成功**（P2）：启动/停止/释放三条路径都处理 `persistAudits=false` ——
  启动失败会停掉刚起的子会话并回滚内存锁；停止/释放如实返回失败（内存放开了，但磁盘上可能还留着）。

（实现方在交付前自己找的，均已用缺陷注入证伪）：
  ① `record_get` / `files_list` 的拒绝条件一度写成"这轮 scope 是否可用" —— 一轮审核
  `ended: true` 之后 scope 变为不可用，那个还活着的子会话就能以"没有可用 scope"为由绕过拒绝、
  去读**任意** `objectId`；判据已改成**调用者身份**（`isAuditChild`，不要求 scope 可用）。
  ② `crwu_audit_case_bootstrap` 的 `caseDir` 虽被钉在本轮案例目录，但 `objectId` 仍是提交进来的 ——
  子会话可以用**别的** objectId 把别人的记录取进自己的案例目录；现在审核子会话调用它一律拒绝。

### 测试

新增/扩写的测试文件：`host-access-consent` / `host-access-broker` / `host-access-classify` /
`host-access-migration` / `host-access-rpc-gate` / `host-audit-policy` / `host-dws-local` /
`client-dws-local` / `host-case-dir-gate` / `host-design-traceability`（**共 1242 条**，
本机 `1242 / 1238 pass / 1 skip`；两条 posix 子用例只在"用 DSH 自带二进制当 `node`"时红，
机制见 `docs/review-0.0.15.md` §5）。

每一条新断言都用**缺陷注入**证伪过（注入 → 变红 → `cp` 还原 → 转绿）；
开发与复查过程中被抓到的真实缺陷包括：OSS 未授权仍然报「还没有填写 AccessKey」、
环境自检与身份查询自己拼 `dws` 命令绕开白名单、审核根的诊断被体检自己挤掉、
"没确认"的修复调用照样跑了一串探测、撤销写盘失败反而把权限重新打开、
案例目录可以指到工作空间之外、Windows 锁探测读错异常层。

## package · 0.0.14 · 2026-09-28

**兼容 DSH `0.2.0-rc.1`：peer 区间从「一条线」改成「两条线并列」。**
0.0.13 及更早的版本在 DSH `0.2.0-rc.1` 上会被整体判为不兼容 —— 插件管理器的原文是
「`dsh-crwu-workbench@0.0.13` 与 DSH `0.2.0-rc.1` 不兼容（要求 `@deepseek-ai/dsh-tools@^0.1.7-rc.2`…），
运行它可能导致崩溃或数据丢失。请安装与当前 DSH 兼容的插件版本。」，装上了也会被禁用。

- **根因**：`^0.1.7-rc.2` 的语义是 `>=0.1.7-rc.2 <0.2.0-0`，**不含** `0.2.0-rc.1`。DSH 从 0.1.7 起把
  peer 当**硬门禁**：加载 profile 的 bundle 层时拿 `getDshRuntimeVersion()` 与每个
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的**区间**比对（预发布参与匹配），不匹配的整行被跳过；
  插件管理器在安装前还会拿候选包自己的 `peerDependencies` 先判一次。
- **peer 改成 `^0.1.7-rc.2 || ^0.2.0-rc.1`**（7 个 `@deepseek-ai/dsh-*` 与 `engines.dsh` 一致）。
  **一条线一个 `^` 区间并列，不用 `>=0.1.7-rc.2 <0.3.0`** —— 后者会顺带放行还没验证过的 0.3 线。
- **加线之前逐包比对过 API**，比对结论（`npm pack` 两条线的全部 `@deepseek-ai/dsh-*` 后逐文件 diff）：
  7 个 peer 里 `dsh-tools` / `dsh-plugin-manager` / `dsh-host-webserver` / `dsh-client-ui-renderer` /
  `dsh-skill-filesystem` **字节相同**；`dsh-client-ui-sidebar` 只多了 1 行埋点调用与 1 行文档注释；
  `dsh-client-ui-layout` 只多了一段 Windows 标题栏的 CSS 变量。插件用到的类型与运行时契约没有变化，
  0.1.7-rc.2 上的一切行为不变。
- **`devDependencies` 补全为全部 7 个 peer**（原先只有 4 个）：npm 的 peer 自动安装会为「只有 peer、
  树里没有具体实例」的包去解析**最新**匹配版本，于是 `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.1`
  的精确 peer（`@deepseek-ai/dsh-fs@0.2.0-rc.1`）会和开发树里的 `0.1.7-rc.2` 撞成 `ERESOLVE`。
  列出实例即把开发树钉在我们开发所对的那条线上。**接收方不受影响**：profile 的 pnpm 配了
  `autoInstallPeers: false`，`@deepseek-ai/dsh-*` 从来不由包管理器安装（DSH 运行时自己提供）。
- **新的回归测试**（`host-package.test.mjs`）：按 DSH 自己的判据
  （`semver.satisfies(runtime, range, { includePrerelease: true })`）断言 7 个 peer 覆盖
  `0.1.7-rc.2` / `0.1.7` / `0.2.0-rc.1`，并反向断言**没有**顺带放行 `0.3.0-rc.1`，同时要求
  `engines.dsh` 与 peer 口径一致。这条测试在旧区间上会直接红（已用注入缺陷证伪）。

## package · 0.0.13 · 2026-09-28

**修复 Windows 上的平台方言：命令串按 PowerShell 拼，不再按 `cmd.exe` 拼。**
0.0.12 及更早的版本在 Windows 上，环境页的「氚云员工会话」「钉钉认证」两行会一起报
`表达式或语句中包含意外的标记"h3yun"`（PowerShell `ParserError` / `FullyQualifiedErrorId:
UnexpectedToken`），相关按钮点下去也不会有结果；macOS 上完全正常。

- **根因**：DSH 在 Windows 挂的执行器是 `@deepseek-ai/dsh-pwsh-local` —— 整条命令作为**一个
  argv 元素**交给 `pwsh -NoLogo -NoProfile -NonInteractive -Command <整串>`，由 PowerShell 自己
  解析。插件此前按 `cmd.exe` 的规矩拼命令，于是在 PowerShell 里「引号包住可执行文件」是
  **字符串表达式**、不是命令调用，紧随其后的第一个参数就成了意外标记。
- **命令位置改用 PowerShell 的调用运算符 `&`**：新增 `shellInvoke(exe, args, platform)`，
  由它在 Windows 上拼 `& 'C:\…\crwu.exe' 'h3yun' 'session'`。所有「第一条 token 是可执行文件」
  的调用点（`crwu` / `dws` / DSH 自带 Python / `ossutil` / 清单里的探测模板）全部改走它；
  POSIX 上仍是原样的 `bash -c` 命令串（那里 `&` 是后台作业，绝不能加）。
- **参数引用改用 PowerShell 单引号字面量**：Windows 上 `shellQuote` 不再用 cmd 式的双引号
  （在 PowerShell 里会插值 `$` 与反引号），改为单引号 + 内部单引号翻倍。
- **清掉同一类「POSIX-only」写法**：Windows 上不再执行 `chmod`（Windows 没有这个命令，
  凭据文件由用户 ACL 保护，这一项在 Windows 上不适用、如实标注而不是伪造失败）；
  建目录用幂等的 `New-Item -ItemType Directory -Force`；删文件用
  `Remove-Item -LiteralPath … -Force -ErrorAction SilentlyContinue`
  （`rm -f` 的 `-f` 在 `Remove-Item` 上同时前缀匹配 `-Force` 与 `-Filter`，会直接报「参数名不明确」）。
- **平台方言跟着 `platform` 键走，不读 `process.platform`**：否则在 Windows CI 上跑
  stubbed `darwin-arm64` 的用例也会被补上 `&`。
- **回归测试**：`host-environment-probe.test.mjs`（引用与命令位置）、`host-shell-fs.test.mjs`
  （一条静态守卫，钉死「模板以 `${shellQuote(` 开头」与「`argv.map(…shellQuote…).join(' ')`」
  这两种会复发的写法）、`host-crwu-h3yun.test.mjs`（按员工报的原文断言 Windows 命令形状）。

### Windows 全面适配（同一版本的第二批，2026-09-28）

0.0.13 只修好了「最直接的那一类」PowerShell 调用（命令位置与参数引用）。这一批把剩下的四个
风险层一起收掉：安装兼容、命令方言不统一、本地路径按 POSIX 规则处理、CI 与发布门禁没有真的
模拟 DSH 的 Windows 语义。**一个版本的完整说明必须能回答「Windows 上到底能不能用」**，
所以下面按风险层分组。

#### 安装兼容

- `22b31b9` 的 peer 双线区间之外，新增 `scripts/check-dsh-compat.mjs`（`npm run compat:dsh`）：
  在干净临时工程里**真的**装齐 DSH `0.1.7-rc.2` 与 `0.2.0-rc.1` 的完整 peer 集（依赖表由
  peer + dependencies + devDependencies + `src/` 里真实 import 的 `@deepseek-ai/*` 共同生成，
  逐个钉版本），把 `npm pack` 出的 tarball 装进去，再调用 DSH 自己的
  `evaluatePluginCompatibility()` 断言**不会被 skip / disable**，并用**该版本**的 DSH 类型跑
  一次 `tsc --noEmit`。显式关掉 `legacy-peer-deps`，并反向断言 `0.3.0-rc.1` 会被判不兼容。
- 补上漏声明的 `@deepseek-ai/dsh-util-values`（`src/` 里 5 处 `import type { JsonValue }`，
  此前只能靠传递依赖拿类型）。

#### 命令方言（Shell）

- 新增 `src/host/platform/shell.ts`：**唯一**的方言适配器 —— `shellDialect` / `shellQuote` /
  `shellInvoke` / `mkdirCommand` / `removeFileCommand` / `openExternalCommand` /
  `clipboardCommand` / `homeProbeCommand` / `privateFileCommand` / `privateFileMechanism`。
  NUL 明确拒绝，换行等控制字符由单引号安全表示；平台一律由调用方注入。
- 迁移全部调用点：`tools/case-files.ts`、`system/ops.ts`、`oss/ops.ts`、`ifind/store.ts`、
  `platform/home.ts`、`audit/root.ts`、`environment/probe.ts`，以及 `dws`/`crwu`/`oss`/Python/
  身份查询的执行入口。**删除** `environment/manifest.ts` 的 `quoteArg` 与 `ifind/store.ts` 的
  本地 `shellQuote`（第二、第三个引用实现就是绕过 Windows 的后门）。
- 不再出现 `cmd /c …`、`Start-Process` 与建目录/删除/权限命令的手工拼接（有静态门禁）。
  Windows 打开文件改用 `Start-Process -FilePath`；删除改用
  `if (Test-Path -LiteralPath …) { Remove-Item … -ErrorAction Stop }` —— **不再用
  `SilentlyContinue` 把真实失败吞成成功**。
- `tools/case-files.ts` 不再吞错：只把「目标已经是我们要的状态」视为成功，并用 `ctx.fs.stat`
  **回读后置条件**（命令返回 0 不等于目录真的在 / 文件真的没了）。
- `oss.probeCommand` 模板降级为 deprecated 兼容路径：结构化 `executable/args` 是默认形状，
  模板的每个占位符**逐个按平台引用**，未知占位符 / 换行 / 空可执行文件一律拒绝。
- `platform/home.ts` 按平台只跑一条探测：Windows 只问 PowerShell 的 `$env:USERPROFILE`，
  不再先试 `python3` / `printf`（那两条在 Windows 上只是两次 command-not-found）。

#### 本地路径

- 新增 `src/shared/utils/local-path.ts`（不引用 Node 模块，Client 也能用）：
  `isWindowsStylePath` / `isAbsoluteLocalPath` / `trimTrailingSeparators` / `localSeparator` /
  `joinLocalPath` / `basenameLocalPath`，另有仅供展示层前缀匹配的 `isLocalPathUnder`
  （**明确标注不是安全边界**）。`joinLocalPath` 对绝对片段与 `..` 片段**抛错而不是静默清洗**。
- `shared/utils/case-dir.ts` 的 `caseDirOf` 改走它（Windows 上给出 `C:\Work\<流水号>`），
  新增 `caseDirName`；`host/audit/case.ts` 的 `caseNameOf` 改走 `basenameLocalPath`
  （旧实现 `split('/')` 在 Windows 上把整条路径当目录名）。
- `host/report/files.ts` 的拼接走 `joinLocalPath`，工作空间**包含判断从字符串前缀改为
  `ctx.fs.contains`**；`host/workspace/resolve.ts` 的最长前缀匹配改 `isLocalPathUnder`。
- **本地路径与 OSS object key 分开命名**：`host/oss/ops.ts` 里 `localPath` 随平台、
  `objectKey` 永远 `/`。
- **UNC 策略**：不自行判死 —— 交给底层 `fs` 解析（DSH 在 Windows 上原生支持 `\\server\share`），
  解析不了时回稳定的「案例目录不可解析：…（原因）」，**不生成损坏路径**。

#### audit 预检与凭据权限

- 审核根预检的提示词不再写死「用 bash 执行 `pwd`」（Windows 上 DSH 挂的是 PowerShell，
  宿主自检全绿而 Agent 预检必然失败）：改为按平台生成（Windows `Get-Location`、POSIX `pwd`），
  并把平台事实逐层传到 `probeMessage` / `preflight`。
- 技能正文与公共层里的 ```bash 代码块改为 ```text；`crwu-audit` 增加 §1.1「命令块按当前平台
  shell 执行」。vendored `skills/dws/**` 不动（上游正文，由 `dws:check` 按 provenance 守）。
- **凭据权限结论结构化**（协议 16 → 17）：`chmodOk: boolean` / `chmodError: string` 换成
  `permission: CredentialPermission`（`status: verified|inherited|failed` + `mechanism` +
  `message`）。Windows 上没有 POSIX 权限位、也没有 `chmod`，跳过之后旧字段只能报 `true`，
  字段名读起来是「chmod 成功了」—— 现在如实报 `inherited / windows-acl`
  （「使用当前 Windows 账户 ACL；POSIX 0600 不适用」）。**本轮不调用 `icacls`**。

#### 构建与发布门禁

- `scripts/prepare.mjs` 不再 `spawnSync('tsdown', { shell: process.platform === 'win32' })`：
  新增 `scripts/lib/cli-entry.mjs`（解析包的 JS 入口，命中 `.cmd`/`.ps1` shim 时明确报错、
  **不退回 shell**），用 `process.execPath` 直接执行。**过 shell 会让项目路径里的空格与单引号
  被第二套规则改写** —— 这是安装链路的第一跳。`scripts/lib/cli-entry.mjs` 随包发布
  （`files` + `pack:assert` 的 REQUIRED 都钉住了）。
- `tests/windows/powershell-contract.test.mjs`：把适配器生成的命令真的交给 shell 执行
  （与 DSH 同形：整串命令作为**一个** argv 元素给 `pwsh -Command`），覆盖命令位置（可执行文件
  路径含空格/引号/`$`/方括号/中文）、参数原样往返（含 `;` 与 `$(…)` 注入金丝雀）、
  mkdir/remove 幂等与后置条件、**真实失败必须非零退出**。POSIX 侧本机跑，Windows 侧在 CI 跑。
- `scripts/smoke-windows-binaries.mjs`（`npm run bin:smoke`）：在 Windows runner 上把
  `crwu.exe` / `ossutil.exe` / `dws.exe` 真的启动一次（核对 manifest 与 SHA-256、
  断言发布树无运行残留、对未声明平台明确失败）。
- CI：新增 `windows-powershell` job（**不设 job 级 `shell: bash`**，runner 默认 pwsh，
  先断言 PowerShell 7，再跑静态门禁 + 原生合同 + build + smoke + 全量 `npm test`）；
  plugin 矩阵的 Node 22 上跑 `npm run compat:dsh`；`release.yml` 新增
  `windows-binary-smoke`，`publish` 改为 `needs: [binaries, windows-binary-smoke]`。

#### 已知限制

- **`win32-arm64` 明确不支持**：随包二进制只有 `darwin-arm64` 与 `win32-x64`。arm64 Windows 上
  插件如实回 capability gap，**不会**静默用 x64 顶上（有单测钉住文案与「不发任何命令」）。
- **UNC 未在真实共享上做过端到端验收**：策略是「交给底层 fs 解析，失败给可读错误」，
  真实 `\\server\share` 的读写仍未在 CI 或真机覆盖。
- **没有 `icacls` 收紧 ACL**：Windows 上凭据文件的权限继承自当前账户 ACL，插件不擅自重写
  （企业域策略下这不该由插件决定）。真要「收紧 ACL」需要另做设计与域环境测试。
- **干净 Windows 用户配置的端到端验收（装插件 → 选工作空间 → 建案例 → 跑审核 → 回传）
  尚未执行**：本机是 macOS，可机器验证的部分已交给上面的三个 Windows job；
  人工验收按 `docs/windows-acceptance.md` 的清单逐项记录。

#### 复查修复（同一版本的第三批，2026-09-28）

分支合并前的一次定向复查发现了三个阻塞项与三个中等问题，全部已修，并各自配了会变红的用例。

- **[P1] 发布工作流会稳定失败**：`release.yml` 里「未声明平台必须报错」那一步**故意**让
  `node` 返回非零，但 GitHub 的 pwsh 壳在脚本末尾用 `$LASTEXITCODE` 作为步骤退出码，
  `Write-Host` 不会把它重置成 0 —— 于是这一步真的判红，依赖它的 `publish` 永远起不来。
  现在写成「存退出码 → 断言 → 末尾显式 `exit 0`」；`windows-powershell` job 里那条
  `npm test` 也改成同样的形状。新增 `tests/unit/host-ci-workflows.test.mjs`：用 `yaml` 解析两个
  工作流，**任何引用 `$LASTEXITCODE` 的 `run` 块都必须以显式 `exit` 收尾**，并钉住
  「原生 pwsh job 不得设 job 级 shell / 必须先断言 PowerShell 7 / publish 必须 needs Windows 冒烟」。
- **[P1] 裸盘符被当成绝对路径**：`isAbsoluteLocalPath` 复用了「Windows 风格」的判断，
  而风格判断为了兼容 `C:` 这种写法接受了裸盘符 —— 于是 `requireCaseDir('C:')` 会放行一条
  「盘符相对路径」，案例目录随进程 cwd 漂移。现在风格（`DRIVE_STYLE`）与绝对（`DRIVE_ROOTED`）
  是两条正则，并新增 `tests/unit/host-case-dir-gate.test.mjs` 覆盖门禁全部分支
  （裸盘符 / 相对路径 / `..` / UNC 策略 / `fs.contains` 而非字符串前缀）。
- **[P1] 本地路径迁移不完整**：`bootstrap.ts`（输入快照目录与三个快照文件）、`knowledge.ts`
  （knowledge 目录 / 下载目标 / manifest）、`dingtalk.ts`（通知幂等状态文件）、
  `audit/state.ts`（案例目录候选）、`WorkbenchPanel.tsx`（打开本地 HTML）、
  `workspace-view.ts`（界面上的落盘位置说明）仍在用 `/` 拼 Windows 本地路径 ——
  其中快照、知识库与本地报告打开都属于核心审核链路。全部改走 `joinLocalPath`/
  `localSeparator`；新增 Windows 行为测试（bootstrap 的三条快照路径与真实落盘目标、
  knowledge 目录、`assessAudit` 的案例目录候选、`artifactHint`），
  并在 `host-platform-shell.test.mjs` 加一条**本地路径载体名单**的静态门禁
  （名单短、每条写得出理由；对象键与 URL 不在名单里）。
- **[P2] `fs.stat` 异常被当成「文件不存在」**：`case-files.ts` 把 `resolve/stat` 的所有异常
  都折叠成「没什么可删的」，删除后的回读也一样 —— 于是 `Access denied` 会被回报成删除成功。
  现在探测是**三态**（存在 / 不存在 / 查不出来），「查不出来」一律按基础设施失败上报；
  `ensureDirectory` 在确认不了目标状态时也不许报成功。
- **[P2] `verified` 没有真正回读**：协议与注释都把 `verified` 定义为「执行并回读确认」，
  而实现只看了 `chmod` 的退出码 —— 有些文件系统会静默忽略 chmod。现在收紧之后**必须回读模式位**：
  新增 `readFileModeCommand()`（GNU `stat -c %a` / BSD `stat -f %Lp` / Windows 不适用，
  分歧只在适配器里出现一次）与 `parseFileMode()`；回读失败、模式对不上都算 `failed` 并带原因。
- **[P2] Windows 的 OSS 输入错误仍报 POSIX 机制**：`ossCredSave` 的输入校验失败信封硬编码了
  `mechanism: 'posix-0600'`，在 `win32-x64` 上说错了「谁在负责权限」。改为复用
  `failedPermission(error, deps.platform)`。
- 文档：`docs/windows-acceptance.md` 的收尾步骤在 PowerShell 里错用了 `rm -rf`，
  改为 `Remove-Item -LiteralPath … -Recurse -Force`。

#### 工作区外路径与沙箱归因（同一版本的第四批，2026-09-28 员工 Windows 实测）

员工在 Windows 上报了三段看起来无关的错误，实际是同一个原因：**受限沙箱（`workspace-write`）
不允许碰工作区之外的路径**（`%USERPROFILE%` 下的 `.ossutilconfig`、`.dws\`、操作系统凭据存储）。
当时插件有两处该提权却没提权，还有一处把沙箱下的假结论当成了真结论。

- **修①｜写 `~/.ossutilconfig` 被沙箱拒绝**：`oss/ops.ts` 的 `fs.writeText` 没声明
  `sandboxPolicy`（同仓的 `ifind/store.ts`、`state/persist.ts` 都声明了），员工实测原文
  `cannot write "C:\Users\<用户>\.ossutilconfig": file access denied under workspace-write mode`。
  现在与那两处同一形态。
- **修②｜`crwu h3yun session status` 拿不到真结论**：提权白名单只放行了 `session login`，
  而 `status` / `bind` 才是**读**钥匙串的那两条。受限沙箱下读不到，crwu 如实回
  `secret not found in keyring` —— 面板照着显示成「未登录」，把人指去重新扫码。
  现在 `h3yun session` 整段放行（凭据存储的读与写都要在沙箱外）。
- **修③｜未授权时不再去问氚云**：环境探测原来无条件跑一次 `h3yun session status`，
  既是假结论、又永远拿不到真值。现在与钉钉那条同一条纪律：未授权就报「需要授权」并进阻塞项，
  **一条凭据命令都不发**；授权后才带 `sandboxPolicy` 去拿真结论。
- **新增归因**：`shell/run.ts` 的 `sandboxDenialNote()` 统一认三种表象 ——
  DSH 的标记 `file access denied under <mode> mode`（确定）、
  以及 `Access is denied` + 工作区外路径线索（**疑似**，措辞不把猜测说成结论）。
  `runDws` / `runCrwu` 会把这句话补在错误最前面，于是 `dws` 的
  `acquiring file lock: … .dws\.data.lock: Access is denied.` 不再看起来像 dws 自己的 bug。
  测试样本**逐字抄自员工贴回来的原文**。
- **收下 DSH 的沙箱事实**：`ShellRunResult.sandbox = { mode, denied, runnerFailed }` 会说明命令
  **实际**跑在哪个模式、沙箱是否真的拒绝过；`resolve()` 回来的 `spec.sandboxPolicy` 还能看出
  提权请求有没有被降级。`ShellResult` 现在把这四项（请求 / 解析 / 实际 / 是否被拒）一起带出来，
  `sandboxDenialNote()` **以事实为准、事实在手就不再猜文本** ——
  于是「沙箱拒了」与「文件真被占用/ACL 异常」不会再被混为一谈（后者按「去授权」处理是修不好的）。
- 文档：`README.md` 的 Windows 故障排查与 `docs/development-notes.md` §5.1/§5.2 补上
  「工作区外的路径清单」「三种表象→同一个原因」「要全局关沙箱只能改 DSH 侧
  （`DSH_PERMISSION_MODE=danger-full-access` 或 profile 的 `dsh-sandbox-policy.mode`）」。

## package · 0.0.12 · 2026-09-28

**首个包含自更新能力的正式版本。** 0.0.10 / 0.0.11 用户需要**手动完成一次**引导升级
（见 README「更新 CRWU」与 `docs/releasing.md` §9）；从 0.0.12 起，后续正式版本才能通过界面内
的检查与安装升级。

- **启动后自动检查更新**：插件装载后按缓存策略做一次后台检查，**静默**完成，不弹窗打扰；
  发现新版本只把版本徽标变成 `v<当前> · 有更新`。
- **手动检查**：点徽标打开更新面板，「检查更新」绕过缓存立刻再查一次。
- **只接受稳定版本**：只认 npm `latest` 指向的**稳定 SemVer**（预发布 / `next` / `beta` 一律不装），
  并且只认**比当前更高**的版本。
- **同时读取两个公开源（仅限普通公共源 profile）**：普通公共源 profile 下，检查会查
  npm 官方 registry 与 npmmirror 各一次，取其中**合法的更高稳定版本**；
  两个源给出**同一版本**时优先展示 **npmmirror**（国内网络下更可能装得上）。
- **安装交给 DSH Plugin Manager**：安装动作由宿主的 Plugin Manager 执行，本插件不自己下载、
  不解包、不覆盖插件目录；安装优先使用 `https://registry.npmmirror.com/`，
  **网络失败与回退由 Plugin Manager 负责**。
- **企业 / 私有 registry profile：不访问那两个公共发现源**：这类 profile 下
  **不会**去查 npm 官方 registry 或 npmmirror，**自更新被明确禁用**（面板说明原因、禁用安装按钮），
  更新交由企业现有的分发策略管理；插件**不会绕过策略**安装。
- **不提供错误的"一键升级"承诺**：开发目录安装（dev）、Plugin Manager 不可用、企业源管理等情形
  会明确说明原因并禁用安装按钮，不假装能升级。
- **审核占用时禁止安装**：审核任务正在启动或正在运行时禁用安装（不动 profile），
  **但不禁止检查更新**。
- **安装过程可见、可取消、可恢复**：安装状态以**诚实的离散阶段**展示（连接更新源 / 下载安装包 /
  写入插件目录 / 取消中），不伪造百分比；安装期间可以取消；安装请求异常（网络中断、响应不认识）
  会立刻回读宿主事实，不会凭空把安装判定成功或失败；刷新页面后也能从宿主事实恢复安装状态。
- **更新完成后必须手动重启**：界面提示
  「CRWU v<版本> 已安装。请完全退出并重新打开 DeepSeek Harness，使新版生效。」
  macOS 明确说明**关闭窗口不等于退出**（从应用菜单选择「退出」或按 **Command-Q**）；
  刷新页面同样不等于重启。
- **本插件不修改、也不重启 DeepSeek Harness 桌面端**：没有"立即重启"按钮，
  也不会替用户退出桌面应用。
- **协议门禁**：宿主与客户端不同代（`WORKBENCH_PROTOCOL` 不一致）时继续拦住发起审核，
  提示以「完全退出并重新打开 DeepSeek Harness」为准。

## package · 0.0.11 · 2026-09-28

修复「新报告一律发起不了」：审核启动报
`输入快照交接未完成，已终止本次审核（未创建子代理）：输入快照交接失败（input）：案例目录不存在或不是目录：<工作空间>/<流水号>`。

- 根因：`<工作空间>/<流水号>` 是 Host 自己的约定（`shared/utils/case-dir.ts` 的 `caseDirOf`），
  但**没有任何代码建过它** —— 案例内的每一个 Tool（bootstrap / `crwu_h3yun_file_get` /
  `knowledge_materialize` / `oss_publish` / `dingtalk_*`）都先过 `requireCaseDir`（要求目录**已存在**），
  而 `crwu_audit_case_bootstrap` 又必须在**创建子代理之前**把输入快照落进这个目录。
  旧形态是审核子代理自己 `mkdir -p`（2026-09-25 的坑速查里记着它把材料下到 `cases/<流水号>` 那次）；
  改成结构化 Tool 之后那条路没有了，于是只有**已经审过**（目录已存在）的报告能再发起，新报告永远卡在门禁上。
- 修复：`audit-start` 在交接输入快照**之前**由 Host 自己建出案例目录（`mkdir -p`，复用
  `tools/case-files.ts` 的 `ensureDirectory`，workdir 是工作空间）；建不出来就在创建子代理之前
  以 `创建案例目录失败：<路径>（原因）` 终止。目录已存在时是空操作，重审走同一段代码。
- 测试：`host-audit-lifecycle.test.mjs` 新增两条（trace 断言「先 mkdir → 再 bootstrap → 最后建子代理」
  的次序；shell 失败时中止且不占用门禁），并把该文件的 shell 替身从「永远失败」改成默认成功、
  可记录命令（`makeCtx` 的 `trace`）。
- 顺带修发布清单里的一个既存红项：`npm publish --dry-run` 会把 `npm_config_dry_run=true` 继承给
  `pack:assert:strict` 内部那次**真正的** `npm pack` → 打不出 tarball → 严格自检报「没有产出 tarball」。
  现在那次 pack 的子进程环境显式 `npm_config_dry_run: 'false'`（`assert-pack.mjs`，
  与 `host-package.test.mjs` 同一处理），`host-bin-manifest.test.mjs` 加一条接线断言盯着它。
  CI 的真实发布（`npm publish --provenance`）本来就不受影响，只是发布手册 §5.3 这一步以前过不去。

## package · 0.0.10 · 2026-09-27

环境信息页进一步收敛普通员工不需要关注的技术说明：

- 删除「包内组件、DSH Runtime、平台与 Tool 可见性；员工日常不需要看。」在诊断区内与页面底部的重复提示；
- 将「维护者诊断」更名为「开发者诊断」，并加入与现有图标体系一致的终端 SVG 标志；
- 入口降级到内容区右下角的轻量按钮：自适应宽度、无整行虚线框、非悬浮；展开后「收起」仍停在原位置；
- 将全部开发信息收进一个大面板，加入一键复制；补回 CRWU Workbench 版本与同花顺 iFinD 真实连接状态；
- 在开发者诊断入口下加入「联系开发同学排查」链接，使用用户公开分享的钉钉个人名片地址；
- 用户可见名称统一为「同花顺 iFinD」，并修复 iFinD 的 global / external-data 双作用域 issue 被顶部重复计数的问题：8/9 时只显示「还需完成 1 项」。

## package · 0.0.9 · 2026-09-26（续：iFinD 改为必检 + 两项真实外部验证 + 环境页引导式重排）

**协议号 15**（见 `src/shared/consts.ts` 的版本注：iFinD 语义 + 阻塞项 + `externalData` 不再恒真 +
OSS 探测归因字段）。

1. **iFinD 从"可选外部数据能力"改成环境必检、必通过项**（产品口径覆盖了旧的 OPT-006-R1 · F-008）：
   - `DEFAULT_MANIFEST.ifind.required = true`；`IfindCheck.required` / `userSetup.ifind.required`
     随之为 true，**进必需项分母**（必需项 8 → 9）；
   - 未通过即**阻塞**，归属按原因分派：没填 / API-Key 无效或过期 → `user`；
     账号无数据权益 → `admin`；网络 / 超时 / 协议 / 上游不可达 → `system`；
   - issue 双写 `global` + `external-data` 两个 scope：`global` 让统一导航把受保护页面拦回环境页，
     `external-data` 让 `auditCore` 一起关掉（光关外部数据却放行审核是自相矛盾的）；
   - `capabilities.externalData` 不再恒为 true；`degraded` 只留给将来真正的可选能力，
     **不再由"只有 iFinD 缺失"产生**；
   - 门禁提示**整句**就是「进入【报告审核】前，请先完成 iFinD API-Key 验证。」
     （`environmentGate` 算好整句，`navigateModuleIn` 不再往外套一层通用模板 ——
     套起来会变成「请先完成环境配置。（…iFinD API-Key 验证。）」，第一眼仍是笼统的话）；
   - 拦截说明**当场出现**：环境页直接读统一导航层记下的 `blocked` / `pendingTarget` / `gateReason`，
     不再需要用户自己再点一次「重新检查」才看到"为什么没进去"。
2. **两项凭据都改成真实外部请求验证**（不允许"文件在 / 字段非空 / 命令能启动"就算过）：
   - OSS：用**包内绝对路径**的 `ossutil` 对 `oss://<bucket>/<配置前缀>/` 做一次只读列举
     （`--limited-num 1`，**空目录也算成功**，不再打桶根），并把失败**结构化归因**为
     `credential` / `permission` / `config` / `infrastructure`（`ServiceCheck.errorKind` + `target`）；
   - iFinD：判定标准钉死为 `tools/call` 返回非错误、非空内容（`dataVerified`），
     只有它才能让必检项通过；四个阶段（会话初始化 / 工具清单 / 取数 RPC / 取数内容）归因一致；
   - 两者都是：保存后**立刻**验证；点「重新检查」传 `force` **绕过缓存**再验一次；
     界面显示"最近真实验证时间"，不把缓存命中说成刚刚重新请求。
   - 脱敏收敛到一处：`src/host/oss/sanitize.ts` 的 `sanitizeOssError`（AK / Secret / STS Token /
     Signature / 签名 URL），环境探测与上传共用。
3. **环境页重排为"紧凑状态摘要 + 引导式配置工作区"**：
   - 顶部只有一条结论、完成数量、最近检查 / 最近真实验证时间，和**唯一**主动作「重新检查」；
     **删掉「进入报告审核」按钮**（连 `onEnterReport` 属性、处理函数与相关断言一起），
     就绪时只写一句「配置已完成。你可以从左侧进入报告审核。」；
   - 删除三块技术指标卡（平台移入维护者诊断、最近检查压成一行辅助文案、数量与进度合并成一条摘要）；
   - 主区改成**左侧步骤导航 + 右侧当前步骤**：1 账号连接 / 2 阿里云 OSS / 3 iFinD / 4 工作空间，
     默认停在第一项未完成，**用户手动选过之后后台刷新不得抢焦点**；窄屏（≤860px）改成顶部横向
     步骤条，375px 无横向滚动；
   - OSS 表单：真实 `<label>`、两个字段纵向排布、主按钮「保存并验证」、
     保存中「正在连接 OSS 并验证权限…」、成功「验证成功，可以访问交付目录。」，
     失败按凭据 / 权限 / 配置 / 网络分别给人话；
   - iFinD 卡：统一叫 **API-Key**（不再出现「SK」「auth_token」「MCP 配置文件」），
     明说用途、从哪里获得、怎么填、不要把 API-Key 发到对话里；验证中
     「正在连接 iFinD，并读取一条测试数据…」，成功「验证成功，已读取到测试数据。」；
   - 技术信息（工具名、数据样本、协议版本、凭据路径、Bucket / Endpoint / 前缀）**只在维护者诊断里**。
4. 文档与测试同批更新：`AGENTS.md` §4.5 / §4.6 / §4.7、`README.md`、`README.en.md`、
   `docs/ui-design-guidelines.md`、`docs/development-notes.md`、`docs/PRD-workbench-sidebar-modules.md`；
   新增 `tests/unit/client-env-steps.test.mjs`（步骤模型纯函数），
   `install/browser-check.mjs` 的环境阶段按新结构重写（四个步骤 + 无「进入报告审核」按钮 +
   375px 无横向溢出），仍**不触发** `audit-start`。

## package · 0.0.9 · 2026-09-26

**环境配置体验重做：插件自带运行能力，员工只处理账号与密钥；门禁上提到统一导航层。**

协议号 12 → 14（13 增加 `env.state`；14 删除 `install-prompt` 操作）。

### 一、环境领域模型（新增 `src/shared/environment/model.ts`）

旧的 `allOk + blocked[]` 一个数组要同时承担四种语义（谁该处理 / 拦不拦 / 拦哪一块 / 怎么修），
于是同一屏能同时出现「环境就绪」与「7/8 通过」。现在事实与解释分开：

- `userSetup`（workspace / credentialsConsent / h3yun / dingtalk / aliyunOss / ifind）、
  `systemHealth`（packageIntegrity / dshRuntime / platform / toolRegistry）、
  `capabilities`（global / auditCore / delivery / externalData）、`issues[]`
  （`id` / `owner: user|admin|system` / `blocking` / `scope` / `action` / `message`）；
- 总状态 `unknown` / `checking` / `ready` / `degraded` / `action-required` / `admin-required`
  / `system-blocked` / `check-failed` 由 issues **推出来**（纯函数，可单测）；
- **只有 iFinD 缺失 = `degraded`**，不进 `blocked`、不拦任何导航；氚云 / 钉钉 / OSS / 工作空间
  缺失仍是阻塞；
- 包内组件 / DSH Runtime / 平台故障归 `system`，员工页面**不提示**安装二进制、装系统 Python
  或改 PATH；
- **通过率只统计必需项** —— 「环境就绪」与「N/N 通过」永远同时成立；
- iFinD 与 OSS 都区分「未填写 / 已保存未验证 / 已认证 / 认证失败 / 网络不可达」五态。

### 二、iFinD 由插件 Host 集成（不再读技能目录）

- **删除**对 `~/.agents/skills/ifind-finance-data/mcp_config.json` 的运行时依赖；
- SK 改由插件 Host 保存在**插件状态目录**（`<home>/.dsh/crwu-workbench/ifind-credential.json`），
  原子写入 + `chmod 600` 并回读核对；优先 DSH 凭据服务，当前版本没有该服务时落到插件自有文件；
- 新增 4 个 Host 操作：`ifind-status` / `ifind-credential-save`（保存后**立刻真实探测**）/
  `ifind-credential-clear`（要求显式 `confirm`）/ `ifind-probe`；
- `crwu_audit_ifind_query` 增加 `describe_tool`：对单个真实工具返回**脱敏、限深、限长**的
  `inputSchema`（此前只回工具名与描述，模型知道有这个工具却不知道怎么填参数）；
- MCP `protocolVersion` 跟随官方 1.4.0 客户端改为 **`2025-03-26`**，并做**显式协商**
  （服务端回受支持集合内的版本就用它；回不认识的版本按协议错误失败，**不再静默假设**
  `2024-11-05` 永远有效）；
- 401 归 `credential`、403 权益受限归 `entitlement`、网络 / 超时 / 协议错误归 `infrastructure`，
  三者不混；探测结论里不回显 token / session / Authorization（净化器覆盖 schema 出口）。

### 三、统一全局环境门禁

- 模块元数据新增 `requiresEnvironment` / `requirement`（`modules.ts`）；
- **所有入口**都走同一个 `navigateModule(target)`：侧栏子项、报告页内跳转、环境页
  「进入报告审核」、以后新增的页；
- 目标需要环境且当前不是 `ready/degraded` 时：不进入目标页 → 记 `pendingTarget` → 落到 `env`
  → 显示「进入【目标页】前，请先完成环境配置」→ 给「重新检查」；
- 检查通过后**只恢复最近一次被拦的目标**；用户中途主动改去别处即取消自动恢复
  （绝不无条件把用户弹走）；`env` 页始终可进；
- **Host 侧也有能力门禁**（`src/host/environment/gate.ts`）：`audit-start` 等敏感操作复用
  workspace / 授权 / 包内能力 / Runtime / 必需 Tool 的统一判据；用**带 60s 失效策略的快照**
  而不是每个操作重跑一遍完整自检；拿不到快照或自检失败一律 fail closed。
  停止审核与释放占用锁**不判门禁**（它们是安全出口）。

### 四、环境信息页重排

页面顺序改成员工的操作顺序（旧版是维护者排查顺序，员工第一眼看到的是自己修不了的东西）：

1. 顶部**紧凑状态卡**：一句结论 + 通过率 + 最近检查时间 + **唯一**主动作；
2. **账号连接**：一次性授权整合进配置流程（**不再用模态层遮住整页**）+ 氚云扫码 + 钉钉登录
   （保留设备码备用）；
3. **交付与外部数据**：阿里云 AK 表单（向管理员获取）+ **新增 `IfindAuthCard.tsx`**
   （password 输入、保存中禁用、提交后清空本地、保存即真实验证、只显示「已认证」或脱敏摘要、
   可替换 SK、错误就地显示且不回显、给官方入口但不代填不索取）；
4. **工作空间**：自动识别成功时压成一行摘要，缺失 / 失效 / 要更换时才展开；
5. **维护者诊断**（默认收起）：包内组件 / DSH Runtime / 平台 / Tool 可见性 + 包路径、清单、哈希；
6. 「复制安装提示词」整块**删除**（同日追加）：`install-prompt` 宿主操作、
   `src/host/environment/install-prompt.ts` 与 `InstallPromptBlock.tsx` 一并删除，
   对应的 8 条单测（`host-install-prompt.test.mjs`）也随之删除 —— 二进制随包发布、
   登录与密钥都在界面上完成之后，那段提示词没有运行时用途，只把员工指去绕路。
   ① 工作空间的「在新会话中打开」按钮同样删除（多余：选目录那一步已经在案例根目录里打开了工作台）。
   操作清单 30 → 29；`boot.ported.done`、客户端门面与 `tests/helpers/frozen-inventory.mjs` 同步。
7. **iFinD 改名 API-Key，并把「环境校验」升级成真实取数验证**：
   - 界面与文案统一叫 **API-Key**（不再是"SK"）：输入框标签、状态词、错误提示、官方入口链接；
   - **每次环境校验都真的取一次 iFinD 数据**（`initialize` → `tools/list` → `tools/call`），
     不再是"只认证不看数据"；`dataVerified` / `dataTool` / `dataSample` 三个字段进线协议，
     `dataSample` 是**脱敏后**的短摘要（上游回显的 token 会被净化掉）；
   - 两截结论分开：`ok`（认证）与 `dataVerified`（取数）。认证通过但没取到数据时状态是
     `unverified` + 明确的 `errorKind`，界面说「认证通过，但这次没有取到数据」并给处置，
     **绝不显示成「已认证」**；
   - 失败归因在**四个阶段**一致（会话初始化 / 工具清单 / 取数 RPC / 取数内容）：先看 401/403，
     再看消息指纹；`credential` / `entitlement` / `infrastructure` 给三种不同的员工动作文案；
   - 试取工具由 `pickProbeTool` 从真实 `inputSchema` 挑（只读、必填 ≤ 1、无开关参数），
     写/批量/导入导出类一律不碰；挑不出来就如实报"权益可能未开通"；
   - **30s TTL 探测缓存**（按凭据指纹作键）避免面板反复刷新打上游，"重新检查"传 `force` 绕过缓存。

`AuthorizationGate` 模态层、`layers.ts`（五层规则）、`OssAuthCard.tsx` 随之下线。

### 五、测试与交付

- 新增 `tests/unit/client-env-model.test.mjs`（状态 / 通过率 / 门禁纯函数）、
  `client-module-gate.test.mjs`（统一导航）、`client-ifind-card.test.mjs`（SK 卡片）、
  `tests/helpers/ifind-fixture.mjs`（内存凭据 + MCP 传输替身）、
  `tests/helpers/frozen-inventory.mjs`（Tool / 操作名单只此一份）；
- `host-environment-env.test.mjs` 改为对着**模型**断言（degraded vs blocked、owner、
  通过率自洽）；`host-ifind-tool.test.mjs` 重写并覆盖保存 / 清除 / 探测五态；
- `install/browser-check.mjs`：环境页阶段改成新的四分组结构，并新增**全局门禁**阶段
  （人为降级环境应答 → 点报告审核 → 断言落到环境页且出现目标页名 → 恢复后自动继续），
  仍不触发 `audit-start`；
- `host-package.test.mjs` 的工具数量断言改为与 `REQUIRED_AUDIT_TOOLS` / 冻结清单对账
  （此前写死 9，实际 10 —— 裸数字已经漂移过一次）。
- `WORKBENCH_PROTOCOL` 12 → 13；插件版本 0.0.8 → 0.0.9。

## package · 0.0.8 · 2026-09-25

**自研审核链路改为结构化 Tool 优先：审核子代理不再查找、拼接或执行任何业务 CLI。**

### 一、新增 8 个业务级 Tool（`src/host/tools/`）

`apply()` 里经 `ctx.tools.register()` 注册，插件卸载时逐个注销；schema 自动进 Agent 的
system prompt。**没有任何通用逃生工具**（不存在 `crwu_exec({argv})` / `shell_exec` 这类形状），
schema 里也没有 binary / argv / command / sandbox 模式 / bucket / 组织 / 团队空间等字段。

| Tool | 作用 |
| --- | --- |
| `crwu_audit_capabilities` | 零副作用能力自检：受支持平台、三个自带二进制是否在包内、必需 Tool 对当前 Agent 是否可见、策略事实。**不返回二进制路径**。 |
| `crwu_h3yun_record_get` | 按 `schemaCode` + `objectId` 一次取回记录全字段 |
| `crwu_h3yun_files_list` | 只回附件元数据；不下载、不回显带会话鉴权的下载 URL |
| `crwu_h3yun_file_get` | 单附件定向下载，目标必须落在案例目录内；**没有整单下载回退** |
| `crwu_audit_knowledge_materialize` | 知识库 M2：解析库（组织 + 个人全范围精确名匹配）→ 递归遍历 → 按 `extension` 分流导出/下载 → 写 manifest 证据。模型只提交 `caseDir` + `paths[]`。 |
| `crwu_audit_oss_publish` | 从受信配置读 bucket/endpoint/prefix；只接受 `caseDir` + `seqNo`（或显式交付件名）；上传后**真的列举**核对对象与字节数；错误脱敏 |
| `crwu_audit_dingtalk_archive` | 组织唯一 / 默认账号唯一 / 团队空间唯一 / 年月目录 / 唯一远端名 / 写后验证；`profile`、`spaceId`、`nodeId` 全部来自真实返回 |
| `crwu_audit_dingtalk_notify_self` | get-self → 人员精确定位 → 发 HTML 到自己单聊 → 读回 conversationId/messageId → 转**应用内** DING；单案例幂等 + 进程内串行 |

### 二、执行层

- 新增 `src/host/dws/`（`consts.ts` / `run.ts` / `plan.ts` / `knowledge-tree.ts`）：
  `dws` 的**唯一**调用点，argv 白名单前缀匹配（表外默认拒绝），最终经 `ctx.shell` 执行。
- `requireBundledCommand`：审核 Tool 严格要求包内二进制存在，缺失时回 `capability-gap`，
  **绝不回退裸命令名**（回退会让模型看到 `command not found` 然后去搜 PATH）。
- `runShell` 新增可选 `signal`（透传 `ShellExecRequest.signal`）与 `aborted` 结果位；
  Tool 的 `exec.signal` 一路传到 shell。
- `runCrwu` 新增 `signal`，并把文件头自相矛盾的提权注释改成与实现一致的口径
  （`effective = (trusted ∧ 白名单) ∨ 显式 escalate`）；**白名单本身没有扩大**。
- 失败分成三类并在返回值里标明：审批拒绝（`approval`）/ shell 基础设施故障
  （`infrastructure`）/ CLI 非零退出（`cli`），另有 `input` / `capability-gap` / `policy` /
  `not-found` / `cancelled`。
- 默认操作走默认沙箱；只有本机凭据命令、且已授权（`trustCredentials`）、且 `workspaceRoot`
  已知时才申请 `danger-full-access`。模型无法通过参数提权。

### 三、审核子代理链路

- 审核指令**删除**插件二进制目录、`export PATH`、`<binDir>/dws` 与全部裸 `crwu`/`dws`/`ossutil`
  命令块，改写成逐条 Tool 调用要求；不再依赖 `upload_audit_result.py`。
- 审核根会话的 hello 预检扩为「`pwd` + 实际调用 `crwu_audit_capabilities`」。
- 新增**确定性能力门禁**（`src/host/audit/preflight.ts`）：发起审核前按
  `ctx.tools.get(name, agent)` 检查全部必需 Tool 对审核根 Agent 可见，并通过
  `ctx.tools.execute()` 真调一次零副作用的能力自检（证明注册表与 policy pipeline 通得过）；
  缺任何一个就在**创建子代理之前**失败并列出缺失的工具名。
- 子代理发布后按**它自己的 scope** 复查一次工具可见性；被收窄时立即停掉该子会话并失败。

### 四、技能

- `crwu-audit` 的 `SKILL.md`、`references/00`、`references/13` 改为 Tool 契约。
- 公共技能 `crwu-dws` / `crwu-h3yun-login` / `crwu-h3yun-query` 顶部新增「DSH 环境：只用结构化 Tool」，
  原 CLI 方式移入明确标注的**非 DSH 宿主兼容层**（`<!-- crwu-cli-guard:legacy-compat-start -->` 区块）。
- 新增静态守卫 `scripts/check-skill-cli-guard.mjs`（`npm run skills:cli-guard`，进 `check` 与 CI）：
  扫描非 vendored 技能文档的**活跃指令**，拦截裸 `crwu`/`dws`/`ossutil`、`which`、`command -v`、
  `export PATH=`、包内 `bin/<平台>/`、`~/bin/<命令>`；`skills/dws/**` 明确排除（vendored 上游正文）。

### 五、二进制供应链

- 新增 `bin/manifest.json`（`crwu.plugin-bin-manifest.v1`）：每个平台每个工具的来源、版本、
  构建 target/commit、**最终文件 size 与 sha256**，下载型二进制另记归档哈希。
- `sync-binaries.mjs --check` 改为**按清单重算最终文件哈希**（不再只看存在/非空）；
  新增 `CRWU_BIN_DIR` 以便发布矩阵汇总产物与单测覆盖失败分支。
- `assert-pack.mjs` 新增 `--strict`（`npm run pack:assert:strict`，`prepublishOnly` 与
  Makefile 的 `plugin-check` 都用它）：要求两平台六个二进制 + manifest 都在真实 tarball 里，
  解包后逐个重算 size/sha256，且 `bin/` 下没有未声明的运行残留。正式发布不再把「完全没有 bin」
  当警告。
- `.github/workflows/release.yml`：新增 `binaries` job（macos-14 上 `make build` 交叉编译出
  darwin + windows 两份 crwu，再 `sync-binaries.mjs` 装配并自检），产物作为 artifact 交给
  `publish` job；发布前跑严格模式自检。

### 十、报告定位交接：Host 定位 + 输入快照（2026-09-25）

用户报「自动审核启动后子代理重新定位/搜索报告」。根因是交接不完整：`auditStart` 只把
`objectId` / `seqNo` / `project` 交给子代理，而记录接口要 `schemaCode` —— 子代理于是自己去
发现表单、列记录、在案例目录里翻找材料。

- 新增 **`H3yunFormResolver`**（`src/host/h3yun/form.ts`，插件实例级）：`state.formCode` 非空直接复用；
  为空才调一次 `discoverForm`，**并发共享同一个 in-flight Promise**；失败不缓存。
  `loadPending` 与全部记录类 Tool 共用它（原来 `loadPending` 自己发现一次）。
- **模型可见参数里删掉 `schemaCode`**：`crwu_h3yun_record_get` / `crwu_h3yun_files_list` 改为
  `{ objectId, caseDir? }`，Tool 内部从解析器取 code；命令里的 `--schema` 来自 Host。
- 新增 **`crwu_audit_case_bootstrap`**（第 9 个 Tool）：按精确 `objectId` **各调一次**
  `records get` 与 `files list`（固定 argv，禁止 `records list` / 搜表单 / 扫目录），
  写 `<案例目录>/输入快照/{报告记录,附件清单,快照元数据}.json`，只回紧凑摘要
  （`snapshotPath` / `digest` / `fieldCount` / `attachmentCount` / `routingFacts`）。
  同一 `attemptId` 重复调用返回上次摘要（`reused:true`）；`refresh:true` 才覆盖。
  元数据里只有 `schemaCode` 的**指纹**，原文不落盘、不进上下文；`downloadUrl` 同样丢弃。
- **审核启动新增三道门禁**（都在创建子代理之前）：表单 code 解析、`bootstrapInputSnapshot()`
  （经 `ctx.tools.execute()`、以审核根 Agent 为 scope）、DSH Python 可用（见第十一节）。
  成功后把 `snapshotPath` / `digest` / `objectId` / `seqNo` / `attemptId` / Python 路径写进指令。
- **重审**：`attemptId` 每轮都新（`<key>-a<attempt>-<time36>`），bootstrap 强制 `refresh:true`
  覆盖本轮快照；仍不得读取上一轮审核产物与 `复核-人工/`。
- **指令新增「报告已由 Host 精确定位」一节**：以输入快照为唯一记录来源、不得重新定位或重复取数、
  附件只按清单 `fileId` 取、快照与任务不一致时立即停止并报「数据边界错误」。
- 技能同步：`crwu-audit/SKILL.md` 步骤 1 由「按输入类型定位 + 提交 schemaCode」改为
  「消费 Host 已准备的输入快照」；`references/00` 的脚本命令改为注入解释器占位符。
- 测试：`host-tools.test.mjs` 新增 4 条（schema 无 `schemaCode`、`--schema` 来自解析器、
  定位失败不调 CLI、bootstrap 幂等/重审刷新/落盘内容）；`host-audit-lifecycle.test.mjs` 新增 6 条
  （缓存复用、定位失败中止、交接失败中止、Python 不可用中止、只调一次且 agent scope 正确、
  指令含快照与指纹）；`host-audit-prompt.test.mjs` 新增 3 条逐字断言。

### 十一、DSH 自带 Python：审核脚本不再依赖系统 python3（2026-09-25）

- 新增 **`WorkspaceRuntimeResolver`**（`src/host/runtime/python.ts`，插件实例级）：经
  `ctx.tools.execute()` 调 `load_workspace_dependencies`（审核启动带审核根 Agent 作为 scope），
  校验 `python` **是存在的普通文件**并真能跑出版本，校验 `pythonDistributions` 至少含 `openpyxl`
  （缺则 `missing-package`）；顺带记录 `python-docx` / `python-pptx` / `Pillow` / `lxml` / `numpy` /
  `pandas` / `XlsxWriter` 版本。**只缓存成功结果**，失败可在「重新自检」时 `refresh:true` 重试。
  不硬编码安装路径、不读 `process.argv`、不改 PATH、不复制 Python 进包、不做 pip 自动安装。
- **审核启动前解析**：失败**不创建子代理**（否则子代理会退回系统解释器）；成功后把绝对路径写进
  `AuditPromptTask.python`，指令新增「脚本运行时：只用 DSH 自带的 Python」一节
  （含「禁止裸解释器名字 / 任何解释器查找 / 静默降级」与 capability gap 规则）。
- 技能同步（自研层，vendored `skills/dws/**` 不动）：`crwu-audit` 新增「脚本运行时（Python）」一节；
  `crwu-audit-datacheck`、`crwu-audit-external-data` 与两个维护元技能的运行时命令改为
  「注入的绝对路径 / 先调一次 `load_workspace_dependencies` 并复用」，并删掉 pip 安装建议。
- 测试：新增 `tests/unit/host-runtime-python.test.mjs`（7 条：只解析一次 + 显式刷新、agent scope、
  capability gap 文案、路径校验（不存在/非文件/不能执行）、缺 openpyxl 且失败不缓存、版本表归一、
  源码不硬编码路径/不改 PATH）。

### 九、讨论会话的资料来源：远端 only + 唯一案例目录（2026-09-25）

用户报「这两个与 DeepSeek 对话的按钮里工具好像还是调不动」+「每次新建对话都必须束缚 DeepSeek
不能从我电脑的目录里去找已有的文件，需要重新从远端下载」。**先看真实会话记录再改**：

- **工具是通的**（记录原话）：`crwu_audit_capabilities` 返回 8 个工具 `available:true`；
  5 个氚云附件全部由 `crwu_h3yun_file_get` 从远端下回（`ok:true` + 真实字节数）；
  会话标题正确写为 `报告讨论 · <流水号>`。看起来"没调工具"，是因为模型**同时**在用
  `bash`/`read` 翻本机目录。
- **真正要修的是目录**：模型 `pwd; ls -la` → `find cases -maxdepth 4` → `mkdir -p cases/<流水号>/材料-源`，
  把材料下到了 `<工作空间>/cases/<流水号>`；而审核链路一直用 `<工作空间>/<流水号>`。

改动：

- 新增 `src/shared/utils/case-dir.ts` 的 `caseDirOf(workspacePath, seqNo)`：案例目录约定**只定义一次**，
  Host 审核提示词与 Client 两条讨论提示词共用（原来是两处各拼一次，这次漂移就是它的产物）。
- 两条讨论提示词（报告讨论 `discussionBrief`、审核分析 `buildAuditContextBlock`）都追加
  `fetchRules()`：唯一案例目录 + `crwu_h3yun_file_get({fileId, caseDir, relativePath: "材料-源/<原名>"})`
  逐件下载 + **每次新建对话都重新下载**（磁盘上的同名文件可能是上一轮/别的报告的过期件）+
  **禁止** `ls`/`find`/`grep`/`glob` 扫描本机 + 不要自己建目录树 + 清单外一律「当前不可用」。
  `caseDir` 为空时整段不写。7 条规则逐字断言。
- 新增文案 `aiCaseDirHead` / `aiFetchRulesHead` / `aiFetchRules`（`zh-CN.ts`）。
- 测试口径更新：原来断言「上下文里不许出现任何本地路径」，现在改为**只允许出现案例目录这一条**
  （用正则抽出全部本机路径再去重断言），并在 `client-assistant.test.mjs` 增加一条
  「Host 审核指令与讨论上下文算出同一个案例目录」的防漂移断言。

### 八、修复「点讨论/复核跳不到会话、也建不出新对话」（2026-09-25）

用户报：在报告审核里点「与 DeepSeek 讨论报告」/「复核 AI 审核结果」跳不到对应会话，
也创建不出新对话。两个独立根因，都在客户端会话接线：

- **`sessions` 上没有 `open()`**：早期按「客户端会话服务有 open」写成 `sessions?.open?.(sessionId)`，
  而真实实现 `ClientSessions` 只有 `retain / using / binding / list / create / fork / scope /
  sessionOf / search / subagentAddress …`。可选链把它变成**静默 no-op**，只剩半截
  `layout.selectPanel(null)` —— 所以「点下去什么都不发生」。现在跳转统一走
  **`uiWorkspace.openSession(id)`**（内部 `replaceMain(…, 'reveal')` = 设置主会话 + 切回原生对话；
  左侧会话列表被点也是走它）。`DiscussionPort` 里**删除** `open`，只保留服务上真实存在的
  `create` / `using` / `binding` / `list`；新增 `discussionPortOf()` 做**逐方法、经接收者**的适配
  （不 `{...sessions}`、不把方法取出来再调 —— 这些方法都依赖 `this`）。
- **会话 face 取错**：`binding(id)` 是 `this.scopes.get(id)?.binding`，**只有已被 retain 的会话**
  才有值，而刚 `create()` 出来的还没 retain → rename 被静默跳过（会话没名字 → 下次按名字找不到、
  只能再建一条），kickoff prompt 也根本没发出去（用户看到的第二半症状）。现在 `rename` / `prompt`
  一律经 **`sessions.using(id, {source}, op)`**（retain → 跑 → release），`binding` 只作旧宿主退路；
  改名失败会带 `aiRenameFailed` 文案如实报出来，而不是悄悄咽掉。
- **职责收敛**：`ensureDiscussion` 只负责「建/复用 + 命名」，**不再自己跳**；「跳」由面板的
  `onOpenDiscussion` 单独负责（两处都跳会连线两次 `replaceMain`）。
- **测试替身也一起修**：原 `fakePort` 给每条会话都预置了 binding，比真服务宽容 —— 这正是缺陷漏过门禁
  的原因。`client-assistant.test.mjs` 改为按真实语义建模的 `FakeSessions`（`create` 不 retain、
  `binding` 只对有 retain 的 id 有值、放一个诱饵 `open`）；`client-package.test.mjs` 另加两条：
  适配器只转发真实动词且不解绑 `this`、以及「从面板点小鲸鱼一路到 `openSession` 恰好一次」。
- 跨进程契约未变，`WORKBENCH_PROTOCOL` 不动（纯客户端行为）。

### 七、登录与 PATH 口径（2026-09-25 收尾）

结构化 Tool 化之后，「把插件 bin 目录挂到 shell PATH」这条老拐杖必须一起去掉，否则
「模型手工拼命令行」看起来可用，等于绕过沙箱与审批。

- **安装提示词（`src/host/environment/install-prompt.ts`）不再让 agent 手工跑登录命令**：
  原来第 1、2 项写的是 `crwu h3yun session login` / `dws auth login`，现在改为
  「在面板 ③ 登录认证 里点『氚云登录』/『钉钉登录』」+「首次先点『同意并继续』完成插件授权」，
  并显式禁止「搜索可执行文件 / 改 PATH / 往 `~/bin` 拷副本 / 为了让它能跑而调环境」。
  逐条断言在 `host-install-prompt.test.mjs`（含「不许出现可直接照抄的登录命令」）。
- **`install/INSTALL-PROMPT.md`（发给收件人 agent 的装插件提示词）同步**：不再写
  「装 crwu / dws / ossutil」，改为「按面板引导完成登录与密钥」，并加一条禁止去找命令路径。
- 面板里的登录按钮本来就经 `resolveBundledCommand` / `runCrwu` 用**包内绝对路径**发起，
  所以这两处改动之后，员工机器上**不需要任何 PATH 配置**。

### 六、测试

新增/改写：`host-tools.test.mjs`（25 条：注册与注销、无逃生字段、包内路径、signal 透传、
默认沙箱与提权白名单、钉钉归档/通知、OSS 写后校验、失败三分类、纯计划逻辑）、
`host-bin-manifest.test.mjs`（6 条）、`host-skills-guard.test.mjs`（6 条，含守卫证伪），
`host-audit-prompt.test.mjs` 重写为「Tool 名 + 无路径泄漏」断言，
`host-audit-lifecycle.test.mjs` 增加 2 条「缺 Tool / 能力缺失时不得创建子代理」。

### 十二、环境自检分层：packaged / runtime / auth / delivery / external（2026-09-25）

**旧的 `env.checks[]` 把四类东西混装成一列命令清单**：随包组件（`crwu` / `dws` / `ossutil`）、
系统运行时探针（`python3`）、以及靠 PATH 解析的命令。界面只能平铺成「命令 + 路径 + 版本」，
员工看到 `python3 未安装` 就去装 Python、看到 `ossutil` 就去找安装包 —— 而这两个都不是他们的活。

- **清单拆成显式分区（`crwu.env-manifest.v3`）**：`packaged[]`（`crwu` / `dws` / `ossutil`，
  只有 `name` / `label` / `note` / `expectedVersion`，**没有** `command` / `versionArgs` / `expect`）
  与 `runtime.python`（**DSH 自带**解释器 + 版本约束 + `requiredPackages`，至少含 `openpyxl`）。
  `binaries[]` 整个删除，**裸 `python3` 不再是检查项**。
- **packaged 的检查规则**（`environment/probe.ts`）：只 `stat` 包内 `bin/<平台>/<文件>` 并与包内
  `bin/manifest.json` 比对**字节数**；`sha256` 从清单读出来进维护者详情，**不**每次自检重算
  （三个二进制一百多 MB，哈希是发布门禁的事）。**不得** `command -v`、**不得**回退 PATH 上的同名
  命令、**不得**执行 `dws version`（会在二进制旁落 `.dws/` 状态目录，`pack:assert` 判成运行残留）。
  缺失文案统一为「插件包不完整 / 平台不受支持」，绝不提示员工安装命令。
- **`resolveOssutil` 同样只认包内**（删掉 PATH 回退），失败文案改成插件包口径；
  导出名与 `{ path, error }` 形状保持不变，所以 `oss/ops.ts` / `oss/auto.ts` 不需要改。
- **`env` 的返回改成六块分区**：`packageIntegrity` / `runtime` / `services`（氚云 + 钉钉，**不含 oss**）/
  `delivery`（OSS 配置 + 凭据 + 连通性）/ `external`（iFinD）/ `workspace`；`checks` / `ifindKey` /
  顶层 `oss` 整体消失。**协议号 +1（11 → 12）**：旧宿主仍会回 `checks[]`，新界面读到 `undefined`
  只会画出一整页假故障，必须由协议号自己喊出来。
- **`blocked` 口径**：插件包不完整只算**一个**故障（`插件内置组件`）、DSH 运行时不可用只算
  **一个**故障（`DSH 脚本运行时`）；三件组件不再各占一项，vendored dws 的 PATH 兼容性也不再
  阻断 CRWU 自动审核。
- **`env` 接受 `{ refresh?: boolean }`**：界面「重新自检」传 `true`，让宿主重解析 DSH 自带运行时
  （首次进入用缓存）。`EnvDeps.pythonRuntime` 是**可选依赖**，缺它或它报 `capability-gap` 时
  如实显示 capability gap，**不是**「未安装 python3」。
- **平台探测（`platform/detect.ts`）去掉 `python3` 探针**：本地 Desktop 优先
  `process.platform` + `process.arch`（受支持时**一次 shell 都不跑**），只有 Host 事实不在
  `BUNDLED_BIN_PLATFORMS` 里时才跑**一次** `uname -sm` 作执行世界诊断；执行世界与包内二进制
  不可混用（包内二进制属于插件进程所在机器），所以 `uname` 给出另一个受支持平台时**不采纳**。
- **页面改成 ① + 五层**：① 案例根目录（`WorkspaceCard`）+ ② 插件内置组件（**一个**聚合项，
  显示 `插件内置组件 3/3 完整`）+ ③ DSH 脚本运行时（明写来源是 DSH 自带，列出 `openpyxl` 等版本）
  + ④ 登录与凭据授权 + ⑤ OSS 交付配置 + ⑥ 外部数据；`EnvLayerId` 随之改名，
  `envTally` / `blocked` 口径同步。安装提示词里的层号也一起改到 ④ / ⑤。
- **测试**：`host-environment-probe.test.mjs` 重写（只认包内、不跑 shell、不比 sha256、
  PATH 上有同名命令也不认）、`host-environment-env.test.mjs`（六分区、不跑 `command -v python3`、
  不跑 `dws version`、capability gap 两种、`blocked` 只算一项）、新增
  `host-environment-platform.test.mjs`（受支持不跑 shell / 不受支持只跑一次 `uname -sm`）、
  `client-env-layers.test.mjs` 重写（五层顺序与计数、聚合项、不出现「请安装 crwu/dws/ossutil」）。
  以上关键断言逐条**注入缺陷证伪过一次**（回退 PATH、跑 `dws version`、系统 python3 兜底、
  组件各占一项、总跑 uname、多塞一层）。

## package · 0.0.7 · 2026-09-25

- **只读 OSS 分发桶（`crwu-only-workspace`）整体下掉。** 它此前有四个消费者，这次全部切断：

  | # | 原来的用途 | 现在怎么办 |
  | --- | --- | --- |
  | 1 | 二进制下载元数据（远端清单里的 `~/bin/crwu`、`crwuPlatforms()` 的 url/sha256） | 二进制随包发布在 `bin/<平台>/`（0.0.6 已做），元数据整组删除 |
  | 2 | 远端环境清单拉取（`manifestUrl`） | 清单只有内置一份（`DEFAULT_MANIFEST`），`loadManifest` / `normalizeManifest` / `resolveBinary` / `resolvePlatformEntry` 全删 |
  | 3 | 安装文档 URL（`installDocUrl`） | 安装提示词改为**整篇自述**，一个外链都没有 |
  | 4 | 插件 TGZ 分发（`pluginPrefix`） | **改从 npm 安装**；`scripts/dist-plugin.mjs` 与 `plugin-dist` 目标删除 |

  **为什么值得动这一刀**：那四个用途都建立在「员工机器的行为依赖一个远端对象」之上，而那个桶是匿名可读、
  **地址谁都能换** —— 换掉清单就能改员工认哪些二进制、装到哪儿；换掉安装文档就能改 agent 照着做什么；
  换掉 TGZ 就能换掉插件本体。少一个远端数据源就少一条这样的通道。现在只剩**审核产物**那一个私有桶
  （员工自己的 AK 上传，`oss.protected`）。

- **安装提示词重写（这是安全相关的改动，逐条钉在 `host-install-prompt.test.mjs` 里）。**

  旧版第一篇是「**第一步：先完整阅读这份安装清单 —— `<url>`**」，并声明「清单里的下载地址、校验要求、
  目录约定、硬性约束都以它为准」—— 那份清单就是上面那个可被替换的远端对象。新版不再外链任何东西，
  因为 `crwu` / `dws` / `ossutil` 随包自带，剩下的只有登录与密钥：

  - 明说三个命令**随包自带**，要求 agent **不要**下载/安装/升级，也不要往 `~/bin` 或系统目录放副本；
  - OSS AK 与 iFinD 密钥改成「**你不要索取、不要代填、不要回显**，交给员工自己填 / 停下来问我」；
  - 逐字保留两条踩过坑的安全措辞：「**GitHub 一律按不可达处理**」（去探测会白等）、
    「**密钥、令牌一律不要回显**」。
  - 新增两条断言盯着「提示词里不许出现任何 URL」与「生成函数只收工作空间一个参数」——
    少一个参数就少一条「把地址换成任意 URL」的通道。

- **协议号 +1（9 → 10）**：`env` 的清单来源字段整组消失（`manifestSource` / `manifestKind` /
  `manifestLoaded` / `manifestError` / `manifestUpdatedAt` / `installDocUrl`），换成 `configSource`
  （部署 YAML 路径，故障对账时看的就是它）；`EnvCheckView` 去掉 `url` / `sha256` / `target`；
  `install-prompt` 的 `url` 恒为空。宿主与客户端分开加载，这一代必须靠协议号把「界面是新的、宿主是旧的」挡在门外。

- **`env` 自检的探测顺序简化为两条**：① 插件自带的 `bin/<平台>/`，② 执行世界自己的 PATH。
  第三条「清单里写的安装目标」（`~/bin/...`）随元数据一起删除 —— 留着它就等于留着「各自装一份」那条老路。
  `resolveOssutil` / `probeOss` 同步收窄（不再接受 `manifest` / `home` 选项）。

- **配置文件与校验**：`config/crwu-workbench.yml` 删掉 `oss.readonly` 整段；
  `src/host/config/yaml.ts` 删掉 `ReadonlyOssConfig` / `distributionTargets` / `objectUrl`；
  `check-config.mjs` 只打印私有桶。`WorkbenchConfig` 不再有 `manifestUrl` / `installDocUrl`。

- **界面**：环境自检页去掉「下载地址 / 安装到 / SHA256」与「环境清单来源 / 清单更新时间 / 清单错误 /
  安装文档」四行，换成一行「部署配置」（YAML 路径）；工具没就绪时的文案从
  「点上面『复制安装提示词』让 Agent 装上」改成「随插件自带，请重新安装插件或联系管理员」。

- **清理**：删 `scripts/dist-plugin.mjs`、`scripts/plugin-distribution-config.mjs`、
  `tests/unit/dist-config.test.mjs`；Makefile 去掉 `plugin-dist` 与 `PLUGIN_CONFIG`，
  `plugin-pack` 变成「先 `plugin-bin` 再 `plugin-check` 再 `npm pack`」并提示走 tag 发布；
  CI 去掉 dist 守卫自检步骤；root READMEs 与 `plugins/AGENTS.md` 同步（两桶 → 一桶）。

- **`node` 从环境清单里整个移除 —— 它从来不是这个插件的依赖，而且会假阻塞。**

  旧条目的理由是「最上游运行时：dws（npm 包）与 iFinD 的 Node 路径都依赖它」。那在当时是准确的：
  `~/bin/dws` 是个 `#!/usr/bin/env node` 的 **npm 包装脚本**。0.0.6 把二进制打进包之后这条就不成立了，
  逐条实测确认：

  1. **三个自带二进制都是原生可执行文件**（`cffa edfe` = Mach-O；Windows 侧是 PE）。
     `env -i PATH=/usr/bin:/bin ./bin/darwin-arm64/dws version` —— **PATH 里根本没有 node**，
     照样输出 `v1.0.61`。`dws` 用的是上游 `vendor/dws` 的 Go 程序，不是那个 npm 包装器；
     `crwu` / `ossutil` 本来就是 Go 二进制。
  2. **打包的技能里没有任何地方调用 node**：grep 出来的 `--node <ID>` 是 `dws` 的参数，
     `wiki node list` 是知识库节点，`#!/usr/bin/env node` 零命中。技能脚本全是 Python。
  3. 所以真必需项是 **`python3`**，而它本来就在清单里（`required: true`）。平台探测也只靠它：
     `python3 -c 'import sys,platform;print(sys.platform+"-"+platform.machine())'` → `darwin-arm64`，
     正是本清单 `platforms` 用的键。

  因此同时删掉了 `detectPlatform` / `detectHome` 里的 node 探测快路 —— 它们只是冗余，
  而**可用性取决于 DSH 是从 Finder 还是终端启动**（实测同一个桌面安装：Finder 起的 PATH 只有
  `/usr/bin:/bin:/usr/sbin:/sbin`，`node` 解析不到；终端起会带上 fnm 的 node）。
  同一台机器、同一份插件，只因为启动方式不同就红一项 —— 正是本仓反复要求避免的谎报。

  **顺带修了界面口径**：`envLayers` 的 `pass` / `total` / `needsWork` 现在**只数必需项** ——
  Host 的 `blocked` 只看 `required`，层也必须只看 `required`，否则会出现「Hero 说环境已就绪、
  某一层却显示 4/5 并默认展开」的自相矛盾。清单当前没有可选项，所以这条用一个合成的
  `required: false` 记录钉成不变量，并**证伪过一次**（把 `layerOf` 改回全量计数即变红）。

  **协议号 +1（10 → 11）。** `env.checks` 的字段形状没变，但**语义变了**：旧宿主仍把 node 当必需项
  并放进 `blocked`，界面于是显示「还差 node」。实测踩到这一刻：宿主比磁盘产物旧一版时，客户端因为
  形状没变而**不报警**，安静地显示一个假阻塞项（用户看到的就是「为什么还要我提供 node」）。
  所以这里必须 +1，让「界面是新的、宿主是旧的」由协议号自己喊出来（AGENTS.md §7.12）。

- **修「氚云登录 / 钉钉登录点了没有任何反应」。** 两个独立根因叠在一起：

  1. **命令按名字调用，而 PATH 里没有它。** 0.0.6 把 `crwu` / `dws` 从 `~/bin` 挪进包内 `bin/<平台>/`，
     但 `runCrwu`、`dwsSelf`、`dws auth status`、`dws auth login` 全都还在**按名字**拼命令、靠 PATH 找。
     桌面端从 Finder 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` —— 实测运行中的宿主报
     `h3yun → bash: crwu: command not found`、`dingtalk → bash: dws: command not found`，
     而同一份清单里的 `ossutil` 正常（`resolveOssutil` 早就改成优先包内绝对路径了）。
     现在统一走 `resolveBundledCommand`：**能证实包内有就用绝对路径，否则回退按名字**
     （SSH / 容器执行世界里包内路径不存在，回退分支必须留着）。
     `.zshrc` 里那条 export 对 Finder 启动的 GUI 进程无效 —— 依赖 PATH 这件事本身就不成立。
  2. **客户端把返回值丢掉了。** `onRelogin` / `onDwsLogin` 写的是
     `.then(() => envStatus.refresh())`，`ok` / `error` / `timedOut` / `stdoutTail` / `stderrTail` 全部丢弃 ——
     命令没跑起来时用户看到的就是「点了没反应」。现在把结果**显示在环境自检页**：成功一句话、
     失败带真实原因、CLI 打到 stdout 的 URL / 设备码原样带出来（浏览器打不开时那是员工唯一能走下去的路）。

  顺带补了**设备码登录**入口：门面一直支持 `dwsLogin({ device: true })`（`dws auth login --device`，
  官方文档写明给「SSH 远程 / 无头 / 本地浏览器够不到 127.0.0.1」用），但界面上从来没有入口 ——
  默认那条是 OAuth loopback 流、要开浏览器等回调。现在钉钉那一行多一枚「设备码登录」按钮。

- **审核子代理现在知道自带二进制在哪了。** 提示词里原先有两句**假话**：

  - 「凭据已经配在本机 `~/.ossutilconfig`，直接用 `ossutil` 即可」
  - 「**`dws` 已在 PATH 里**」

  子代理跑在 DSH 自己的 shell 里，PATH 是 DSH 继承来的、插件改不了 —— 桌面端从 Finder 启动时
  只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`dws` / `ossutil` 都不在里面。于是提示词让它跑的命令
  （钉钉回传、OSS 上传）实际只会拿到 `command not found`。

  而插件**本来就知道**它们在 `<包根>/bin/<平台>`。现在提示词最前面多一段「命令在哪」：
  给出真实目录、绝对路径用法（推荐），以及「脚本内部还会调 `dws` 时」在同一条命令里
  `export PATH="<目录>:$PATH"` 的用法；并明确**不要**往 `~/bin` 或系统目录拷副本。
  `binDir` 为空（平台不受支持）时整段不出现 —— 不编路径。
  新增两条断言（写入真实目录 / 缺平台时不出段）并**证伪过一次**。

## package · 0.0.6 · 2026-09-25

- **兼容 DSH 升至 `0.1.7-rc.2`（cordis `4.0.4`）。这不是例行跟进 —— 0.1.7 起 peer 变成了硬门禁。**

  `peerDependencies` / `devDependencies` 里的 `@deepseek-ai/dsh-*` 从 `0.1.5-rc.2` 升到 `^0.1.7-rc.2`。
  依据是 0.1.7-rc.2 自带文档里的原文：

  > Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and
  > `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`.
  > **Every declared range must match; prereleases participate in range matching.** …
  > an incompatible bundle without an exemption is **skipped** like an unreadable one and listed in `skippedBundles`.

  旧 peer 钉死 `0.1.5-rc.2`，在 `0.1.7-rc.2` 的运行时上**整个 bundle 被跳过** —— 症状是「插件装上了、
  界面里什么都没有」，而启动日志没有任何报错。写 `^0.1.7-rc.2` 而不是钉死，是为了让同一条 0.1.7 线上的
  rc 补丁与正式版都能过闸；`^0.1.7-rc.2` = `>=0.1.7-rc.2 <0.2.0`，预发布只在同一 `[major,minor,patch]`
  元组内参与匹配，所以 `0.1.8-rc.1` **不会**被放行。另加 `engines.dsh` 作声明口径 —— 但门禁读的是
  peer，`engines.dsh` / `dsh.manifestVersion` 在 0.1.7 上**只是声明、不强制**
  （`dsh-package-manifest` README 原文：「Current installers and loaders do not enforce」）。

- **修 0.1.7 的 shell 契约破坏性变更：`ShellExecutor.run(spec)` 已不存在。** 新形状是
  `execute(spec)` 返回进程句柄，前台结果（stdout/stderr/timedOut）在句柄的 `result()` 上，
  `ShellExecSpec` 另增 `onExpiry`。`src/host/shell/run.ts` 是唯一调用点，已改为两步；
  `tests/unit/*` 里 20 处 shell 替身同步改成 `execute().result()`（0.1.5 的 `run` 形状在 0.1.7 上
  直接 `is not a function`，实测过的报错原文）。**这一条是本次唯一的 API 破坏点** —— 其余 peer 与
  client UI / `ctx.fs` / `ctx.webServer` / `ctx.locale` / 槽位 API 在 0.1.7 上类型与行为都兼容，
  由 `tsc` + 548 条单测 + `smoke:built` 一起证明。

- **`crwu` / `dws` / `ossutil` 三个二进制改为随插件发布（`bin/<平台>/`），不再依赖员工各自的 `~/bin`。**

  先确认了「DSH 会不会把插件里的 bin 挂上 PATH」——**不会**，四条路都实测堵死：
  `dsh-package-manifest` 不认 `bin` 字段、`dsh-bash-local` 的 `Config` 只有
  `cwd/timeoutMs/maxTimeoutMs/maxOutputBytes/maxSpillBytes/graceMs`、`dsh-shell-env` 只接收 `DSH_*` 键
  （`lib/index.js` 里前缀校验会直接抛错）、`.env` 明确拒绝 `PATH`（文档原话「export them instead」）。
  所以「员工零安装」只能靠插件按平台解析包内绝对路径，前提是文件真在包里。

  目录按 `normalizePlatform()` 的键命名，两个平台：`bin/darwin-arm64/{crwu,dws,ossutil}`、
  `bin/win32-x64/{crwu.exe,dws.exe,ossutil.exe}`。**软链接落不了地**：实测 `npm pack` 会**静默丢弃**
  符号链接（相对与绝对都不在 tarball 里，只有真实文件会），所以一律落真实文件 —— 开发机也是拷贝，
  避免「本机能用、员工装上少文件」。

  装配由 `scripts/sync-binaries.mjs` 负责（`make plugin-bin`），来源都可复现、都不依赖开发机预装：
  `crwu` 取本仓构建产物、`ossutil` 取阿里云官方包（URL/sha256 直接读内置清单，**同一事实源**）、
  `dws` 取 `dingtalk-workspace-cli@1.0.61` 的 `assets/dws-*`（sha256 对照包内 `checksums.txt`，校验的是
  **归档**而不是解包结果）。`--check` 只校验已装配内容，供发布前核对。

  `src/host/platform/bin-dir.ts` / `package-root.ts` 负责定位（`import.meta.url` 上溯找 `package.json`，
  构建产物 1 层与源码 3 层都落到同一个包根）；`probeEnv` 与 `resolveOssutil` **优先自带**、
  查不到才回退 PATH 与清单 `target` —— 执行世界是 SSH/容器时自带二进制在宿主上用不到，回退分支必须留着。

- **`assert-pack` 增加自带二进制断言**：本地装配了 `bin/<平台>/` 就必须逐个出现在真实 tarball 里，
  没装配只提示不失败（CI 不做 `make build` + 110MB 下载这一套）。解包体积上限从 8MB 提到 160MB
  —— 两个平台三件套本身约 108MB，这里的上限是防「误打了别的大家伙」，不是追求包小。
  `files` 增 `bin/`，`FORBIDDEN` 增 `.cache/` 与几个同步脚本。

- **Makefile**：新增 `plugin-bin` / `plugin-bin-check`；`plugin-dist` 改为**显式**先 `plugin-bin` 再
  `plugin-check`（并列 prerequisites 在 `make -j` 下会并行，门禁可能跑在装配之前）；
  `plugin-clean` 连同 `bin/`、`.cache/` 一起清。

- **本机迁移（开发机）**：`~/bin` 下的 `crwu`、`dws`、`ossutil` 三个入口删除（`ossutil` 与包内副本
  逐字节相同、`sha256` 比对确认；`dws` 只删软链、不动 `~/.workbuddy` 里的真实安装），
  改为在 shell 配置里 export 一条指向 `plugins/dsh-crwu-workbench/bin/darwin-arm64` 的 PATH。
  这条 export 是**必需**的：审核子代理跑 vendored `skills/dws/` 里的 `dws ...` 用的是 DSH shell 的
  PATH（本会话实测 `/usr/bin:/bin:/usr/sbin:/sbin`），插件无法只给自己注入。

## package · 0.0.5 · 2026-09-23

- **技能重构为「分层目录 + 一层一个技能根」。** 原来包内只有 `skills/`（自研 27 个）与 `common/skills/`
  （公共 3 个）两个技能根；现在按归属分层：

  | 层 | 目录 | 内容 |
  | --- | --- | --- |
  | 自研层 | `skills/crwu/` | 原有 27 个 crwu-audit / crwu-dev-audit 技能（`git mv` 原样搬迁） |
  | 上游层（新） | `skills/dws/` | vendored 的 `dingtalk-workspace-cli` 钉钉技能 14 个（集合 `multi`） |
  | 公共层 | `common/skills/` | `crwu-dws` / `crwu-h3yun-*`（位置不变） |

  **为什么必须一层一个根**：`@deepseek-ai/dsh-skill-filesystem` 的 `discoverRoot()` 对每个技能根
  **只扫一层**（`readdir(root)` → `<子目录>/SKILL.md`），不递归。只注册 `skills/` 会把 `skills/crwu/`
  当成"一个没有 `SKILL.md` 的技能"跳过，**整层静默消失**（症状与 2026-09-22 的 `baseUrl` 陷阱完全一样：
  provider 装配成功、技能表里 0 个技能、日志干净）。所以 `cordis.patch.yml` 的 `customSkillDirs`
  改成返回 `skills/crwu`、`skills/dws`、`common/skills` 三个根。
- **`dws` 层只由同步脚本改写，可复现、可审计。** 新增 `scripts/sync-dws-skills.mjs`
  （`npm run dws:sync`）从本机 `dws` 的上游副本同步，并写 `skills/dws/provenance.json`
  （上游包名 / 版本 `1.0.61` / 集合 / 逐技能 sha256 / LICENSE、NOTICE 摘要）；
  `npm run dws:check` 只对照 provenance 逐文件比对（不需要上游，CI 与员工机器都能跑），已接入
  `npm run check` 与 `prepack`。上游版本或集合变化必须显式 `--allow-version-change` / `--allow-set-change`，
  否则拒绝写入 —— 上游静默换版不会悄悄改掉随包内容。上游以 Apache-2.0 发布，`LICENSE` / `NOTICE`
  随技能保留。这一层是上游正文，按 `skills/README.md` 的口径**豁免**本仓 Skill 自洽性 lint
  （上游按自己的跨技能相对链接组织），门禁只跑自研层与公共层。
- **共用的摘要/枚举逻辑提取**到 `scripts/lib/skill-digest.mjs`，两个同步脚本不再各写一份
  （`sync-common-skills.mjs` 改为复用，`--check` 语义不变）。
- **门禁与源仓工具改为按层寻址**（同一类"静默扫 0 个技能"的坑）：
  - `Makefile` / CI 的 `kb_tool.py validate` 改为 `--skill-root skills/crwu` 与 `--skill-root common/skills`
    各一次（传上层 `skills/` 会静默扫 0 个技能）；新增 `make plugin-dws`；
  - `Makefile` 的 `skills-install` 改为 `find plugins -name SKILL.md` 收集技能 —— 任何层都被收到，
    层目录自己不会被误当成技能；
  - `check_audit_skill_mappings.py` 的技能根候选改为 `skills/crwu` + `common/skills`，硬编码的
    `skills/crwu-audit/...`、`skills/crwu-dws` 等 label 改为按根解析；
  - 三个源仓契约测试的 `_skill_roots()` 改为按"根里直接放着技能"识别所有层并跨层查找
    （自研层与公共层不再同级；不修会让整组断言静默 skip）；
  - `kb_tool.py` 的仓库引用规则新增 `skills/<层>/` 形态（分层后跨层引用同样要拦）。
- **运行时路径与跨层依赖**：`src/host/audit/skill-paths.ts` 的包内解析改到 `skills/crwu/`
  （`prompt.ts` 的 `$SKILLS_ROOT` 占位语义不变，指自研层）；
  `crwu-audit-external-data` 的 `connector_probe.py` 改为在"本技能所在层 + 同级层 + 公共层 +
  常见位置"里找 `ifind-finance-data`（iFinD 与本技能不再同层）。
- **交付形状护栏**：`package.json` 的 `files` 显式列出 `skills/README.md`、`skills/crwu/`、
  `skills/dws/`；`assert-pack.mjs` 三层各钉代表文件 + `provenance.json`；`smoke-built.mjs` /
  `host-audit-prompt.test.mjs` / `host-package.test.mjs` / `host-skills-patch.test.mjs`
  （三个根、逐层技能数与 `SKILL.md`）同步。
- **文档**：新增 `skills/README.md`（分层契约、`dws` 层同步与升级、豁免口径）；
  同步 `AGENTS.md`（根 / `plugins/` / 插件各一处）、`docs/skills.md`（分层表 + `dws` 层目录）、
  `docs/agent-skill-dirs.md`、`README.md` + `README.zh-CN.md`、`README.en.md`、
  `docs/development-notes.md`（`baseUrl` 之外新增"少注册一层"这一同类坑）。
- **维护规程**：`plugins/AGENTS.md` 新增 §5.5「新增技能层或技能时的改动清单」—— 把本次逐项踩出来的
  改动面（技能根 / `files` / 打包断言 / 单测计数 / skills/README / 文档 / 版本）、自研层与 vendored 层
  的两条分叉、"不用改"的自动发现面，以及四个会咬人的坑固化成清单；插件 `AGENTS.md` §4.1.3 加了指针。
- 顺手修复一处既有缺陷：`crwu-audit/scripts/test_audit_delivery.py` 的 v1.6 目录同步断言读的是
  早已不存在的旧路径（`skills/README.md`、`docs/CHANGELOG.md`），一直以 `FileNotFoundError` 失败；
  改为从技能目录上溯定位源仓文档（`docs/skills.md` 与 `docs/v0.0.1/CHANGELOG.md`），
  安装副本内显式 skip。

### 验证（0.0.5）

- `npm run check`（版本一致 + 配置 + 公共技能同步 + `dws:check` + typecheck + 单测 + build + 产物冒烟）
  与 `npm run pack:assert`（三方加载契约 + 三层文件清单）在本轮全过。
- 技能门禁：自研层与公共层 `kb_tool.py validate` 均 `error=0`；
  `test_audit_skill_maintainer.py`、`test_audit_multiaxis_router.py`、`test_dws_source_contract.py`
  全过（跨层查找生效，未被静默 skip）。
- `git diff --check` 干净。

## package · 0.0.4 · 2026-09-22

- **DeepSeek 会话统一数据边界：报告业务会话只允许用「本次会话注入的远端资料」**（2026-09-23 用户强制口径）。
  两个入口（报告列表「与 DeepSeek 讨论报告」、AI 审核列表「与 DeepSeek 分析审核结果」）一律：
  **不发本地路径、不列本地文件、远端取不到就不建会话**。
  具体落地：
  ① 上下文只由远端资料组成 —— `fileLinesOf()` 只列**氚云附件 + 云端交付件**（带大小 / ETag），
  本地案例目录（`report-files.local`）**整组不进上下文**，也不再出现案例根目录路径；
  ② 新增 **Source Provenance**（`sourcesOf()`）：每条资料记 `sourceType:'remote'` / `provider(h3yun|oss)` /
  `remoteId` / `remoteVersion` / `remoteUpdatedAt` / `digest` / `fetchedAt`，**绝不记 localPath**；
  ③ Context Snapshot 按用户 §11 改成**远端身份**：`reportRemoteId`（氚云附件 fileId + OSS key 聚合，
  替代上一轮的本地文件指纹）、`auditRemoteId`（审核产物 OSS key）、`fetchedAt`；`changesSince()` 随之
  只比远端标识 / ETag / 远端时间 —— **本地路径不再参与任何版本判断**；
  ④ **远端失败 = 明确报资料不足**：`report-files` 的远端两项都空（哪怕本地目录里有同名报告）→
  弹「无法获取当前报告的远端最新资料 / 为避免使用过期或来源不明的数据，本次未创建分析会话」，
  只给**重试**；上一轮那个「仍以有限资料继续」的出口按 §8/§16 删掉了（那正是"去找本地替代"的口子）；
  ⑤ System Prompt 按 §12/§13/§14 逐字更新：报告讨论注入 7 条数据边界，AI 审核分析把开场句改成
  「系统已经将本次从远端业务系统获取的相关资料加入当前会话上下文…」并插入 7 条强制规则 +
  事实来源优先级（远端报告 > 远端 Metadata > 人工复核 > AI 审核结果，AI 审核属历史快照）。
  验证：新增 3 条断言（来源清单只有远端标识且无 localPath / 报告讨论上下文含数据边界且无任何本地路径 /
  远端为空时**不建会话、不发 prompt、不回显本地文件**），**逐条证伪 5/5 真红**
  （把本地文件当来源、边界段不注入、上下文写回本地路径、远端为空仍建会话、本地资料拼回上下文）；
  `npm run check` 545 → **548 通过**；`git diff --check` 干净。
  **工具层边界（用户 §15）本轮未做，原因与证据见下**：插件侧做不到 ——
  `@deepseek-ai/dsh-api-session-controller` 的客户端 `sessions.create()` 会**重建 payload**，
  只转发 `{workspaceId|cwd, sessionId}`，把 `agentPreset` 之类的字段直接丢掉（读 `lib/client.js` 的
  `create()` 实现可见），而"按 preset 组合（不含 bash/fs 工具）建会话"这条路只在宿主侧
  （`ctx.get('agents').create({meta:{agentPreset}})` + `agentPresets.mount`，本插件建审核根会话时已在用）
  才走得通，且需要插件自带一份 preset 目录并把它挂进 profile 的 preset root。
  这属于改动 Harness 的 agent plane、并且必须真机重启验证，因此**先按"数据边界彻底落到上下文层"交付**，
  工具层方案与影响面写在 `docs/ui-design-guidelines.md` §6.7 与 `docs/PRD-workbench-sidebar-modules.md` §9.19。
  **用户 2026-09-23 当场确认采用方案 B（只保留上下文 + Prompt 边界），工具层不做** —— 这是有意选择，
  不是遗漏。限制范围只针对这两个业务会话，**不动普通 Harness 会话**。

- **OSS 列举改用长格式：一次 `ls` 就带回 大小 / 最后写入时间 / ETag**（用户 2026-09-23 提示：
  「oss 一次可以查询一个目录下有多少个文件」）。原先 `oss-index` 给自己加了 `--short-format`，
  只拿到 key —— 而 `ossutil ls` **默认就是长格式**（`ossutil help ls` 的样本逐字写着
  `LastModifiedTime / Size(B) / StorageClass / ETAG / ObjectName` 与 `Object Number is: N`），
  一次调用本来就能同时给出对象个数与每个对象的元数据。
  改动：`parse.ts` 新增 `parseLsEntries()`（按长格式解析，时区段不逐字匹配，跨桶对象隔离，
  认不出的行跳过）；`oss-index` 去掉 `--short-format`，解析不到条目时**退回**老的 key 解析
  （少元数据但清单不丢，不把整次列举判成失败）；`CloudItem.files[]` 与 `report-files` 的
  `oss[]` 带上 `size / lastModified / etag`，`local[]` 带上 DSH `fs` 的 **`version` 令牌**
  （`FsDirEntry.version`：后端给的权威新鲜度令牌，比 mtime 强）；合成口径 `WORKBENCH_PROTOCOL` 8 → **9**。
  这些元数据直接喂给上一轮的「AI 审核结果分析会话」：
  `auditArtifactOf(cloud)` 取审核结果 JSON 对象的 ETag / 最后写入时间（没有就退回 HTML）→
  进版本证据与 Context Snapshot；`reportFingerprintOf(reportFiles)` 把本地案例目录的
  「名字 + 大小 + version」聚合成本地指纹 → 进快照。于是 §12/§13 最要紧的两条信号从"记录时间有没有动"
  升级成**同源客观**：资料指纹变了 = 报告已更新；审核对象 ETag 变了 = 审核结果重新生成过
  （记录时间没动也能判出来）。**仍不伪造强结论**：报告侧目前没有 OSS 对象，跨源的
  digest/version/etag 仍然不齐 → 初次判定依旧走时间退化（`possibly_stale`），这一条有单测钉着。
  顺带：AI 审核列表的「N 个交付件」改成以**这一次列举真实看到的对象个数**为准
  （`item.files.length`，旧宿主没带 files[] 时退回语义条数），Chip 仍是审核报告 / 审核数据。
  验证：真机 `ossutil ls oss://crwu-workspace/crwu/audit/`（只读）实跑，10 个对象 / 5 份报告，
  解析出的 size / lastModified / ETag 与逐字样本一致（样本已抄进单测）；新增 7 条断言
  （长格式解析与跨桶隔离、分组带元数据、ETag 取值与回退、指纹稳定性、快照比对的两条客观信号、
  交付件数量），**逐条证伪 9/9 真红**；`npm run check` 537 → **545 通过**；`pack:assert` 173 文件；
  `git diff --check` 干净。文档同步：`docs/ui-design-guidelines.md` §6.6 补"元数据来源"、
  `docs/development-notes.md` §11（+1 条坑：别给自己加 `--short-format` 丢元数据）。

- **新增「AI 审核结果分析会话」（audit_analysis）**（2026-09-23，用户口径：「本轮重点不是普通聊天入口，
  而是建立 AI 审核结果分析会话」）。**AI 审核列表**的操作列从 `[查看报告] [•••]` 变成
  `[查看报告] [DeepSeek SVG] [•••]`：复用**同一个** `DeepSeekIcon` 组件与同一套 Icon Button
  （`C.aiRowBtn`），靠浮动 Tooltip 区分业务含义 —— 报告列表那枚仍是「与 DeepSeek 讨论报告」，
  这里换成「与 DeepSeek 分析审核结果」；没有新增文字按钮，也没有「可分析 / AI ready / 已同步」这类 Tag。
  与报告列表**共用** `Report → Conversations` 体系（不建第二套聊天）：来源靠**会话名前缀**区分
  （`审核分析 · <流水号>` vs `报告讨论 · <流水号>`）—— 这是本仓既有的"名字即映射"机制，
  `sessions.create` 不接受 metadata，所以**没有**为这个字段去改会话数据库；`ensureDiscussion` 加了
  `kind` 参数，`sessionsOfKind()` 是唯一的找回入口。
  点 DeepSeek 之后**不立刻建会话**，先做 Audit Conversation Preflight：取最新原始资料
  （`report-files`：氚云附件 + 本地案例目录 + 云端交付件，只列举不下载）→ 取裁剪过的审核摘要
  （`oss-result`：审核报告 / 结构化问题 / 复核意见）→ **版本判定**（新增纯模块
  `audit-freshness.ts`：`digest → version → etag → mtime → 时间退化`，四态
  `current / possibly_stale / stale / unknown`）→ 按结论决定：直进 / 版本选择框 / 已有会话选择框 /
  缺原始资料（Limited）。**纯时间差只给 `possibly_stale`**（用户口径：「不要仅仅因为审核时间 < 报告更新时间
  就直接断言一定过期，因为更新时间可能来自非内容性操作」），所以「报告已更新」这种确定语气只在
  digest/version/etag 强证据下出现；`stale` 时提供「重新 AI 审核 / 仍以当前审核结果分析 / 取消」，
  选了后者会把「当前 AI 审核可能基于旧版本」写进上下文。
  **新建会话 = Fresh Snapshot**：重新取最新原始资料 + AI 审核 HTML + JSON + 复核意见 + 报告元数据；
  §20 的 System Instruction **逐字**注入（locales 的 `aiAuditSystemPrompt`，`【REPORT_SERIAL_NUMBER】`
  替换为真实流水号），并附 §21 的 Context Notice（报告更新时间 / AI 审核时间 / 复核更新时间 /
  版本关系中文表述 + 缺失项）—— **不把文件正文拼进 Prompt**（会话建在案例根目录下，模型按路径回看原文）；
  人工复核意见按**真实结构**读取（`reviewFiles` + `reviewItems`，含 `inFileResolution` 的三态中文口径），
  不假设固定三级。每个会话存一份 **Context Snapshot**（`reportSerialNumber / reportUpdatedAt / reportDigest /
  auditGeneratedAt / auditSourceDigest / auditArtifactVersion / reviewUpdatedAt / conversationCreatedAt /
  contextStatus`）到浏览器本地（`crwu.audit-analysis.<seqNo>`，读写都做了收窄与 try/catch；
  丢了大不了退化到会话行的 `updatedAt`）—— 用户说「不要为了这个字段重构整个会话数据库」，所以不改宿主状态结构。
  降级如实：原始报告取不到 → 「无法获取最新原始报告」（重试 / 仍以有限资料继续，并记入上下文）；
  只有 HTML 或只有 JSON → 各记一条缺失说明；没有复核意见 → 正常情况，不报错不阻断。
  **历史审核产物一个字节都不改**（AI Audit T1 / Current Report T2 / Analysis T3 三者独立）。
  验证：新增 9 条断言（版本判定优先级与 `possibly_stale` 克制、快照差异三信号、会话命名互不串味、
  Snapshot 存取与坏数据、上下文包逐字注入 System Instruction + 不出现英文枚举、AI 列表入口与 Tooltip、
  点 DeepSeek 的 possibly_stale 拦截 / 直进新建并注入 / 已有会话选择 / 缺原始报告拦截），
  **逐条注入缺陷证伪（11/11 真红）**；`npm run check` 527 → **537 通过**；`install/browser-check.mjs`
  的 AI 审核列表阶段补了「统一入口 + 同一枚 SVG + Tooltip 文案 + 无噪音 Tag」四条真机断言。
  文档同步：`docs/ui-design-guidelines.md` §6.6、`docs/development-notes.md` §11（+2 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.18。

- **「审核信息」Drawer 二轮返工：重定义为「AI 审核质量与问题摘要」**（2026-09-23，用户第二轮口径：
  「当前版本虽然比原始字段列表好看，但信息权重仍然错误……它不是审核状态详情，而是 AI 审核质量与问题摘要」）。
  优先级按 P0–P4 重排：**复核命中率（32px/600，不做红黄绿评分色）→ AI 检出问题数 + 已提未改 →
  AI 检出的具体问题列表 → 报告信息（默认折叠）→ 技术详情（默认折叠）**。
  **删掉**顶部「审核摘要 / 未通过 / 复核 · 已执行」Summary Card（结论与复核状态挪进折叠的报告信息）、
  删掉「问题情况 → 发现问题 → 13」这种三层重复标题、删掉 `hitRate` 旁的完整公式。
  新增：**AI 检出问题列表**（`issue.title` + `gapAnalysis.difference`，按 高→中→低 稳定排序，
  点开给「位置 / 建议 / 查看更多审核依据 →」，**不重新调模型生成描述**；完整规则证据不进 Drawer）；
  **「已提出但仍未整改」独立指标 + 折叠区**（左侧 3px 琥珀强调条 + 低浓度红 badge，
  每条给「人工复核：<原话>」与「AI 检出：<当前仍发现>」）；`bands.aiOnly` 降级成 AI 检出旁的
  secondary「其中独立发现 N」；高/中/低降级成标题下一条 secondary；待确认/未检查与其余三条带
  收进默认折叠的「其他事项」。
  **判定逻辑（严格按真实字段，不猜）**：`reviewComparison.reviewItems[].linkedIssueIds`（schema：string[]，
  人工复核项 ↔ AI issue 的正式关联）**且** `inFileResolution === 'L-open'`（交付规范 §6.1
  「复核已提出 · 被审件未落实」）→ 关联到 `issues[]` → 按 issueId 去重。
  已落实（L-resolved）/ 答复称已改未落地（L-unclosed）/ 材料缺失（L-uncheckable）/ 没关联 issue 的
  一律**不算** —— 用户口径「宁可暂时不显示，也不要误报」。
  为拿到这两块数据，Host 侧 `auditInfoFromResult`（`oss-result`）**追加两组裁剪字段**（同一操作、
  同参数，纯新增）：`issues[]`（8 个字段、逐字段截断、封顶 100 条）与
  `reviewComparison.reviewItems[]`（6 个字段、封顶 100 条）；`ruleEvidence`/`materialEvidence`/
  知识库路径/完整引文仍然**不进**这个接口。合成口径 `WORKBENCH_PROTOCOL` 7 → **8**（改跨进程契约要 +1）。
  尺寸/遮罩按新口径：宽 580（560–620）、遮罩 `rgba(0,0,0,.32/.34)` + `blur(2px)`。
  验证：客户端新增 10 条 + Host 新增 4 条断言，**逐条注入缺陷证伪**（客户端 11/11、Host 3/3 真红；
  其中「业务区不许出现程序枚举」一条最初用"拼接后 replace"是假通过，已改成按子树整段剔除并重新证伪）；
  `npm run check` 518 → **527 通过**；`pack:assert` 173 文件；`git diff --check` 干净；
  `install/browser-check.mjs` 的抽屉阶段整段重写（第一屏优先级 / 命中率字号与无公式 / 无结论大卡 /
  问题列表与点开 / 已提未改折叠与展开 / 折叠区默认收起 / 关闭后上下文不变），并把
  「没有带审核摘要的云端记录」从 FAIL 改成**条件式跳过**（那是数据条件，不是缺陷）。
  文档同步：`docs/ui-design-guidelines.md` §6.5 重写、`docs/development-notes.md` §11（+1 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.17。

- **「审核信息」右侧 Drawer 按业务视角重排（修用户报的「更像 Debug Panel」）**（2026-09-23）。
  信息架构从「标题 + 20 行 Label/Value 一路铺到底」改成五段：
  **审核摘要 → 问题情况 → 复核情况 → 报告信息 → 技术详情（默认折叠）**，
  3 秒内先看懂「过没过 / 多少问题 / 高中低各多少 / 复核到哪一步 / 命中情况」，元数据与技术追溯排后面。
  同批落地：Header 改成「标题（16/600）+ 一行等宽流水号 + ×」并**删除「关闭」文字按钮**
  （正文不再重复流水号；项目编号与流水号是两个真实字段，值相同也各自保留）；
  程序枚举只在有权威定义时翻中文（`pass/fail/pending_confirmation`、
  `not_performed/performed` 分别来自 `audit_result.schema.json` 的 enum 与 `audit_delivery.py` 的
  `REVIEW_STATUS_LABEL`，三条带标签来自 `11-html-delivery-spec.md` §6.1），认不出的取值**显示 —**
  并原样进技术详情，绝不编中文；`reviewComparison.bands` 的原始 JSON 与命中率公式
  （引擎写在 `metrics.aiHitRate` 里的 `33.3% (= (exact 1 + partial 0) / evaluable 3；…)`）
  **移出主界面**，主界面只留 `33.3%` + `1 / 3 条命中` + `精确 1 · 部分 0`，
  原值在折叠的技术详情里；引擎版本 / raw 枚举 / raw counts JSON / 原始 ISO 时间 / schema /
  renderer / sourceDigest / 内部流水号全部进技术详情（40px 折叠头 + `grid-template-rows 0fr→1fr`
  的 170ms 展开动画 + 可复制 JSON）。
  尺寸与交互：宽度 540（520–560，复用 `--crwu-surface`，不另立深色主题）、
  遮罩 `rgba(0,0,0,.32/.36)` + `blur(2px)`（关掉后还看得出从哪一行打开）、
  开 `translateX(20px)→0` 200ms / 关 150ms（父层延迟卸载，`onClose` 仍立刻回调）、
  关闭后不动列表上下文（Tab / 页码 / 搜索 / 滚动位置）。
  **业务时间全面绝对化**（用户口径：这是审核留痕系统，省略年份会造成误判）：新增
  `features/report-audit/time.ts`（`YYYY-MM-DD HH:mm` / 只有日期 `YYYY-MM-DD` / 认不出的原样返回 /
  **不做时区换算**，完整原值留 `title` 与技术详情），报告列表的「更新时间」从
  「今天 / 昨天 / 09-20 18:15」一并改成 `2026-09-20 18:18`（列宽 12% → 14%，否则年份会被截掉）。
  语义与文案集中在新的纯模块 `features/report-audit/audit-summary.ts`，中文全部进 locales
  （并把「面板不许内联中文文案」这条门禁从 `WorkbenchPanel.tsx` 扩到 `AuditInfoDrawer.tsx`）。
  验证：`tests/unit/client-package.test.mjs` 新增 13 条（时间规范、列表绝对时间、枚举映射与
  不构造语义、命中率只取百分数、三条带、计数缺字段不画 0、Drawer 小节顺序与技术详情默认折叠、
  业务区不出现程序枚举/JSON、认不出枚举显示 —、技术详情展开、加载/失败态、头部结构、关闭动画），
  **逐条注入缺陷证伪**（8/8 真红，其中「命中率主行」一条最初是 includes 假通过，已改成整格断言并重新证伪）；
  `npm run check` 505 → **518 通过**；`pack:assert` 173 文件；`git diff --check` 干净；
  `install/browser-check.mjs` 的抽屉阶段同步重写（宽度 / 遮罩与 blur / 动画 / 头部结构 / 小节顺序 /
  结论优先 / 技术详情默认折叠与展开 / 业务区无原语 / 关闭后列表上下文不变），
  并修掉两处**早已失效**的选择器（浮层菜单项是 `role="menuitem"`，`getByRole('button')` 永远匹配不到；
  抽屉入口改用类名 + 文案）。文档同步：`docs/ui-design-guidelines.md` §6.5（新增 Drawer 口径）、
  `docs/development-notes.md` §11（新增 2 条坑：业务时间规范、浮层菜单项角色）、
  `docs/PRD-workbench-sidebar-modules.md` §9.16。

- **次级控件收成一套中性底（修用户当场报的「操作列的按钮颜色不一致，还有刷新按钮」）**（2026-09-23，
  用户在 **dark 主题**下看到）。现场是同一行里三种形态：主操作实心反色、小鲸鱼填充 `#F2F3F4`、
  ••• 完全透明，而工具条的刷新又是第三种 Ghost；深色下小鲸鱼的底（`#232427`）还与行悬停底
  （`#222326`）几乎同格，鼠标移到那一行它就像"没底"了。改法：新增
  `--crwu-control` / `--crwu-control-hover` / `--crwu-control-active` / `--crwu-control-text`
  （浅色 `#EFF0F2` / `#E4E5E8` / `#DADCE0` / `#5F6065`，深色 `#2E2F34` / `#3A3B41` / `#45464C` / `#A1A1A6`），
  **刷新、小鲸鱼、•••、流水号复制四者逐字共用**；`--crwu-icon-btn*` / `--crwu-ghost-hover` /
  `--crwu-ghost-text` / `--crwu-menu-open` 四个只服务一处的旧 token 删除。
  回归：新增单测「次级控件共用同一套中性底」（断言四处引用同一 token、悬停同格、
  且 `--crwu-control` 在浅深两套里都不等于 `--crwu-hover`），**证伪两次**（••• 退回透明 / 中性底=行悬停底
  → 均变红）；`install/browser-check.mjs` 补两条真机断言（操作列里同类控件底色一致、小鲸鱼与刷新同底）。
  教训写进 `docs/development-notes.md` §11：主题是**服务端设置**，用户切到 dark 后观感全变，
  改配色要先确认当前真实主题。

- **报告审核页第二轮整体重构：Workspace Surface + Segmented 页签 + 行动作收口**（2026-09-23，用户书面口径：
  「从当前回退后的稳定代码重新开始……对报告审核整体 UI/UX 做一次完整但克制的重构」，前提是**不改业务逻辑、
  不改 API、不改数据结构、不重构侧栏**）。这一轮**取代**下面两条 0.0.4 早期口径（历史保留，以本条为准）：
  ① 文字型页签 + 2px 品牌色下划线 → **轻量 Segmented Workspace Tabs**（浅槽 `--crwu-tab-track` +
  选中项白片 `--crwu-surface` / `--crwu-shadow-tab` / 600，不要红色 underline、不要双重选中）；
  ② 主操作 / 小鲸鱼 / ••• 三个都实心反色 → **一屏只允许一处实心**（主操作 32px 实心反色、
  小鲸鱼 32×32 浅中性 Icon Button、••• 透明 Ghost，组件上不再挂 `C.btn + C.btnPrimary`）。
  同批落地：§19 成为**唯一允许写字面量色值**的 token 块（浅色一套 + `body[data-ds-dark-theme]` 覆盖同名
  token，不再依赖 `prefers-color-scheme`）；Header 54px + `blur(18px)`；正文底 `--crwu-app-bg` + 一块
  14px 圆角 Workspace Surface；表头 39px / 行 82px；搜索（400×38、默认无黑边、Enter 查询、× 清空）与
  刷新 Ghost（只转图标）**同一行**；流水号悬停浮出复制按钮；AI 审核列表的交付件改讲业务语义
  （「N 个交付件」+ 审核报告 / 审核数据 Chip），**不再暴露 `crwu/audit/.../*.html|json` 原始路径**；
  分页 `« ‹ 页码窗口 › »` + 跳至第 N 页（总数只在页签里出现一次）；空态「暂无 AI 审核结果」+ 一句说明；
  浮层仍是 fixed Floating Layer（Tooltip 深底白字带箭头、••• 菜单 150px/34px 行/160ms 入场），
  列表一滚就关闭、同一时间只允许一个。
  验证：`tests/unit/client-package.test.mjs` 新增 8 条断言（Segmented 页签 / 工具条 Ghost / 流水号复制 /
  两套操作列组合 / 交付件语义与 ••• 菜单 / 不暴露 OSS 路径与空态 / 分页四向 + 跳页 / 操作列无状态噪音），
  **8/8 都注入过缺陷并确认真红**；`npm run check` 496 → **504 通过**；`npm run pack:assert` 173 文件；
  `git diff --check` 干净；`install/browser-check.mjs` 同步改成本轮口径（量浅槽/白片/无指示条、
  Enter 查询、× 清空，并补了刷新 Ghost 与分页四向的断言）。文档同步：
  `docs/ui-design-guidelines.md` §1.1 / §6.0 / §6.1 / §6.4、`docs/development-notes.md` §11（新增 4 条坑）、
  `docs/PRD-workbench-sidebar-modules.md` §9.15。

- **操作列的 ••• 也改成与主操作同一套实心反色**（已被上面 2026-09-23 那轮取代：••• 现在是透明 Ghost
  Icon Button，不再挂 `C.btn + C.btnPrimary`；历史记录保留）（2026-09-23，用户原话：「操作列的 更多操作的三个点也需要
  改下颜色适配，和前面的 AI 审核一样，按钮的背景色什么的，这样看起来很清楚」）。做法是**复用**而不是复制
  颜色：组件上给 ••• 挂 `C.btn + C.btnPrimary`，`.crwu-audit-menu` 只保留几何（32px → **28px**，与小鲸鱼和
  行内小按钮一致）与「菜单开着」的品牌色内环 `box-shadow: inset 0 0 0 2px var(--crwu-brand)`。原来那个
  `surface-selected` 浅底选中态在实心按钮上根本看不出来，所以换成内环；§20 迁移层里那两条已被变体压过的
  菜单规则一并删除（免得读代码时误判谁生效）。回归断言在 `tests/unit/client-package.test.mjs` 的 ••• 用例里
  （已证伪一次：不挂变体类立刻红）。真机实测：浅色 `bg rgb(15,17,21)` / 白字，深色 `bg rgb(249,250,251)` /
  `rgb(35,35,36)`，hover 同一个 86% 浓度，菜单打开时内环 `rgb(216,74,74)`。

- **修掉「悬停操作列的主按钮时整个按钮全黑」**（2026-09-23，用户原话：「鼠标移动到操作列的 AI 审核
  按钮上时全黑，这是个 bug」）。根因不是色值，而是**选择器特异性 + 书写顺序**：基础 `.crwu-audit-btn`
  是 (0,1,0)，§20 迁移覆盖层把它写在样式表**最后**，于是同特异性的单类变体 `.crwu-audit-btn-primary`
  的 `background/color` 被它吃掉（主按钮退化成普通按钮），而变体那条 `:hover` 特异性更高、反倒生效 ——
  深底 + 深字，就是「全黑」。修法：变体一律改成**双类** `.crwu-audit-btn.crwu-audit-btn-primary`
  （(0,2,0)，不依赖顺序），hover 的选择器组里带上基础按钮的 `:hover:not(:disabled)`，并去掉 hover 里的
  `opacity: 1`（它会让**禁用**的主按钮悬停时看起来可点，禁用态只由 `:disabled` 的 0.45 表达）。
  顺带发现「确认重新审核」的 warn 变体也被同一条基础规则吃掉（与旁边的「取消」长得一模一样），
  按 §19 的中风险琥珀 token 恢复警示色；HEAD 遗留区那三条已被取代的变体规则删除。
  回归断言：`tests/unit/client-package.test.mjs` 的「按钮变体一律用双类选择器」（已证伪一次）。
  真机实测（浅色 + 临时切深色各一次）：IDLE `rgb(15,17,21)` / 白字，HOVER
  `color(srgb 0.0588 0.0667 0.0824 / 0.86)` / 白字；深色下 IDLE `rgb(249,250,251)` /
  `rgb(35,35,36)`，两套主题都是「底与字互为反转色」，禁用态悬停保持 `0.45`。

- **侧栏入口改成一张「分组卡」，三个模块变成它的三个子项**（用户口径：「报告评估、报告审核、
  环境信息是中瑞世联工作台的子模块，相当于一个小单元」「在左侧侧边栏直接看到这 3 个子项」
  「用 apple 风格的底色样式去修饰这些子项，让他们看起来是一个模块」）。做法：**仍然只占一个席位**
  （`sidebar.footer.action`），但内容由插件自绘 —— 一张浅底圆角卡，卡头是品牌标记 + 「中瑞世联工作台」
  + 版本标签，卡身是三行子项（图标 + 名字 + 「报告评估」带「开发中」角标），选中行是
  品牌蓝低浓度底 + 左侧 3px 蓝条 + 加粗。**面板底部的模块条随之撤掉**
  （`ModuleSwitcher.tsx` 删除）：两套导航会互相干扰，也白占正文高度。
  模块状态因此从面板的 `useState` 上移成 `apply()` 创建、同时下发给侧栏卡与面板的
  `module-store`（`active` / `autoEntered` / `selectEpoch` / `badge`）—— 各存一份的必然结果是
  「侧栏高亮报告审核、面板显示环境信息」；面板靠 `selectEpoch` 清掉上一次的自检拦截态，
  待办条数则由面板推给侧栏子项（撤掉模块条之后这个数不能在侧栏丢掉）。
  真机验收按几何断言「三行子项都落在同一张卡里、自上而下」（这就是「像一个模块」的判据）。
  设计与取舍见 `docs/PRD-workbench-sidebar-modules.md`（v1 已实施）。

- **分组卡按用户当面的三条反馈返工**（同日，真机截图后提出）：

  1. **卡头不再能选中**（原话：「中瑞世联工作台这个本身不应该能选中」）。卡头从 `<button>` 改成纯标题
     `<div>`：没有 `onClick`、没有 `cursor:pointer`、也删掉了那条 `:hover` 底色。打开面板只靠子项 ——
     点当前子项同样能进（store 会推进 `selectEpoch`，面板据此重置门禁）。
  2. **环境标记只留「环境信息」那一行**（原话：「右侧的绿色对勾去了吧，应该在环境信息那栏加个环境
     可以正常工作的标志」）。原先除了「报告评估」之外两行都画，挂在「报告审核」后面会被读成
     「那条审核通过了」；现在整页只有一枚，且长在环境那一行里（悬停文案顺带给出结论）。
  3. **悬停底色与选中底色分开**（原话：「选中时我用鼠标选中其他的子项时，和它激活的背景色一样，
     体验不好」）。根因是选中行用了 `bg-layer-1`：那在浅色主题下就是卡片自己的白底，于是「选中」
     看起来是无底色，而悬停那层 `interactive-bg-hover` 反而更像选中。改成悬停 = 一层中性极浅底、
     选中 = 品牌蓝低浓度底（`color-mix` 调浓度）+ 蓝条 + 加粗，**色相就不同**；并显式钉住
     `.crwu-audit-module-on:hover`，悬停自己那条选中行不会被降级。
     两条都是 `color-mix` 与 `-on:hover` 这种会被人「顺手简化掉」的写法，各有一条单测盯着。

- **卡激活不再整块换底色**（同一条反馈里的「它的背景色不好看」）。面板开着时原先给整张卡铺
  `sidebar-nav-item-active`，在侧栏里就是一块突兀的灰蓝色块；现在只把描边从 `border-l1` 压实到
  `border-l2`，「我在哪一页」由卡身那条选中行承担。

- **环境标记重新设计成「实心圆徽标」**（用户 2026-09-22：「环境信息检测通过的标记与否还是可以再
  设计一下，现在并不好看」→ 选定 iOS 设置风）。先前是一枚**裸勾 / 裸点**浮在行尾：没有容器，
  15px 细描边图形在 13px 文字旁边显得又飘又小。现在是一枚 16px 圆徽标，
  **四种结论各有形状**，不只靠颜色：

  | 结论 | 画法 |
  |---|---|
  | 通过 | 实心绿圆（`state-success-primary`）+ 白勾 |
  | 不通过 | 实心红圆（`state-error-primary`）+ 白叹号 |
  | 自检中 | 实心琥珀圆（`state-warn-primary`）+ 一段旋转白弧（纯 CSS `::after`，用已有的 `crwu-audit-spin`） |
  | 尚未自检 | 空心圈（不填色、不给结论） |

  两处细节：字形是**加粗版**（`BadgeCheckIcon` / `BadgeWarnIcon`，3px 描边、不带外圈）——
  线性图标那套 1.6px 描边缩到 12px 只剩 0.7px，压在实心色块上会糊成灰边，
  而 `WarnIcon` 自带一圈描边圆，放进实心圆里就成「圆中圆」；
  字形颜色用 **static 白**而不是 alias —— alias 的 `label-primary-inverted` / `-foreground`
  在深色主题下会翻成深色，压在实心色块上就看不清了，而色块上的字形必须恒为白。

- **「报告评估」占位页去掉全部说明文字，整页只写「开发中」**（用户 2026-09-22：「该页面整体写
  一个开发中就可以了」）。先前那版是虚线卡片 + 标题 + 一句说明 + 「开发中」角标 + 三条计划事项；
  在一个明确不可用的页面上堆信息，反而容易让人以为这里已经能用了。正文因此只剩「开发中」四个字，
  随之删掉 `evalTitle` / `evalText` / `evalPlan` 三段文案与 5 个占位页专属类名。
  起初只剩"一行灰字飘在空白正中间"，用户又说「它的页面也重写下，太难看了」，
  于是把那四个字做成**一枚有分量的灰色圆角标签**（14px / padding 8×18 / 圆角 12 / 浅中性底），
  居中摆放：既没有多余信息，也不是一行孤零零的灰字。

- **侧栏分组卡两处按用户口径收窄**：

  1. **「报告审核」旁边不再标报告数**（原话：「报告审核边上不需要标具体的报告数」）。那个数字
     是撤掉面板底部模块条时搬过去的（`module-store` 的 `badge` 字段 + 面板每次渲染推一次计数），
     既然侧栏不显示，就**整条链路一起删掉**，不留一份没人读的状态。
  2. **「报告评估」旁边的「开发中」角标改成一枚灰色小 tag**（原话先是要小 svg：「报告评估处于
     开发中边上加一个小 svg」，中间做过一版 13px 沙漏图标 + `moduleDevMark` 类；用户看过之后
     又改回文字标签：「那个 svg 不要了，太难看了，加一个灰色的小 tag【开发中】」）。
     定稿是 `moduleTag`：10px / line-height 16 / 圆角 6，`caption` 灰 + 一层极浅中性底
     （`interactive-bg-hover`，深浅主题都成立），没有描边、没有状态色、不带图标。
     `modules.ts` 的 `moduleTag()` 仍改成语义更准的 `isUnderDevelopment()`。

- **修掉「选中自己的会话之后，工作台还高亮着上一次那个子项」**（用户 2026-09-22 报的 bug）。
  根因：卡身那三行的选中态只看 `module-store` 里的"当前模块"，**没看工作台面板是不是还在前台**
  —— 面板被会话顶掉之后，那个高亮仍然留在侧栏里，看起来像工作台还开着。
  口径改成：**选中 = 工作台面板正开着（`usePanelInfo` 说当前主面板是它）+ 这就是当前模块**；
  面板切走就整块收起高亮，记忆仍留在 store 里（点回来还是原来那一页，并且重新亮起）。
  面板开着时的卡描边也走同一个判据。

- **背景水印试过一版又撤掉**（同日）。用户先说「子页面的背景都应该有一个特别大的中瑞世联 svg 背景，
  颜色浅点」，做完（单色标记 + 5% 不透明 + 贴底居中 + 下面一行「中瑞世联」字样）之后
  用户决定不要：「算了不要背景色这个标记了」。代码、样式、`BrandMark` 的 `tint` 开关与
  `brandName` 文案一并删除，验收脚本改钉「页面背景不再画水印」。

- **品牌标记改成矢量版（用户给的原图）**：新增 `BrandMark`，把原图 122x124 的四个色块描成四个多边形
  （品牌红 `#b50120` x3 + 品牌金 `#cf9950` x1，视框 101x104）。做法是把非白像素按行做颜色分段，
  逐块量出边界，再用同一套分段算法逐像素比对重建结果：**没有一个不一致像素离多边形边超过 2px**
  （全部落在抗锯齿过渡带上）。它替掉了侧栏入口那个通用文档图标，面板头部也放了一枚 —— 同一个图形、
  跟着主题缩放，不需要任何资源文件（客户端产物是单文件，没有资源加载器）。原 `PanelIcon` 随之删除。

- **入口与标题旁的小标签：dev 模式还是具体版本**（用户口径）。宿主新增两个模块加载时常量
  `PLUGIN_VERSION`（与 `package.json` 一致，测试盯着）与 `HOST_BUILD_KIND`（判据：包根旁边有没有 `src/`
  —— 发布包的 `files` 不带 `src/`，源码检出一律有），`ping` / `boot` 都回这两个字段。界面把这枚标签
  放在「中瑞世联工作台」后面：`dev`（琥珀色，悬停说明这是源码检出、改完要重新 build）或 `v0.0.4`
  （中性灰，悬停给形态与构建时间）。旧宿主不给这两个字段时退回 `rev` 去掉 `pkg-` 前缀，再没有才显示
  「未知」—— 任何情况下都不留空标签。

- **一处修进骨架的重构**：`boot` 从面板自己的 `useState` 挪进共享的 `build-store`（与 `envStatus` 同一套
  写法）。侧栏入口与面板头部要显示同一枚标签、面板还要拿 `boot.protocol` 做协议门禁，各自 `boot()` 会打两次
  请求，还会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。协议号 5 → 6（跨进程应答多了字段）。

- **统一的「正在自检环境」等待页**（用户 2026-09-22：「我点到中瑞世联工作台的时候都会进行一轮环境检测，
  这个是合理的，但是需要一个统一的 loading 页面，这个需要你设计一下，否则很不统一，这个注意有个好看的
  svg」）。先前第一次进来渲染的是**环境信息页的半成品**（页头 + 各层占位 + 一行灰字），看着像"页面缺了
  一块"；现在自检没出结论之前，整块正文只放这一页（新增 `features/workbench/LoadingPane.tsx`）：

  1. **一枚会依次亮起来的品牌标记**（76px）—— 四个色块按 `crwu-audit-brand-wave` 顺序呼吸，
     整体再叠一层极轻微的 `crwu-audit-breathe`。用品牌图形当加载符号，比通用转圈更有归属感，
     也不用额外图形资产（客户端产物是单文件，没有资源加载器）；
  2. 主文案「正在自检环境」+ 一句说明（正在检查工具、登录态、上传配置与外部数据，通过后会自动继续）——
     刻意不提任何模块名，免得结论还没出来就先谈"在哪一页"；
  3. 底部一条限宽的不确定进度条，让"还在动"有连续的视觉证据。

  另有一条 `@media (prefers-reduced-motion: reduce)` 让路：系统开了"减少动态效果"就关掉动画，
  页面结构与文案不受影响。判定条件是 `env === null && !hostStale && snapshot.error === ''` ——
  **宿主是旧构建**（要看到"请重启 profile"那句话）与**请求已失败**（要看到真实原因）都不显示等待页，
  转圈会把这两种情况藏起来。

- **面板头部右侧那句问候：「晚上好，某某某」**（用户 2026-09-22：「该工作台的上面右侧部分永远都有一个
  下午好/中午好，谁谁谁，这个谁谁谁是用钉钉 cli 请求的个人信息」）。姓名来自钉钉 CLI
  （`dws contact user get-self --format json` → `result[0].orgEmployeeModel.orgUserName`），
  客户端按**本地时钟**拼成 `凌晨好/早上好/上午好/中午好/下午好/晚上好，姓名`。
  三条口径：① **未授权就不去读钥匙串**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信）；
  ② **拿不到姓名就整句不展示**（用户原话：「如果钉钉 cli 没有登录信息，那就什么也不展示」）——
  不显示「晚上好，」这种半句，也不编造「同事」之类的占位；③ 宿主侧**只缓存成功结果**（姓名在一次登录
  周期里不变），失败不缓存，员工登录后刷一下就有，不用重启。
  同时**把头部那三个模块名（报告评估 / 报告审核 / 环境信息）去掉**（用户同批要求）：「我在哪一页」由
  侧栏分组卡的高亮说了算，头部右侧这一格留给问候。

- **「我是谁」跟着环境自检一起取，而且自检一次就够**（用户 2026-09-22：「这个钉钉 cli 环境监测一遍
  就可以了，不需要每次切换页面都去调，本质就是从环境信息把这个人的信息拿到」）。第一版把它做成第 26 个
  独立操作 `whoami`，每开一次面板就问一次宿主 —— 与用户的口径不符，已改成：
  `env` 自检在钉钉登录态那条链路上顺手取回姓名，塞进应答的 `me: { name, org, userId }`；
  独立操作与它的门面方法、协议声明、单测一并删除。另外**面板重新挂载不再重跑自检**：
  挂载 effect 只在「还没有结论」时补一次（`env === null && !busy`），关掉面板再打开（切会话、切模块）
  复用的是同一份结论 —— 要重跑仍然有页面上的「重新自检」按钮与登录 / 授权成功后的显式刷新。
  协议号 6 → 7（`env` 应答多了 `me` 字段）。- **品牌标记改成矢量版（用户给的原图）**：新增 `BrandMark`，把原图 122x124 的四个色块描成四个多边形
  （品牌红 `#b50120` x3 + 品牌金 `#cf9950` x1，视框 101x104）。做法是把非白像素按行做颜色分段，
  逐块量出边界，再用同一套分段算法逐像素比对重建结果：**没有一个不一致像素离多边形边超过 2px**
  （全部落在抗锯齿过渡带上）。它替掉了侧栏入口那个通用文档图标，面板头部也放了一枚 —— 同一个图形、
  跟着主题缩放，不需要任何资源文件（客户端产物是单文件，没有资源加载器）。原 `PanelIcon` 随之删除。

- **入口与标题旁的小标签：dev 模式还是具体版本**（用户口径）。宿主新增两个模块加载时常量
  `PLUGIN_VERSION`（与 `package.json` 一致，测试盯着）与 `HOST_BUILD_KIND`（判据：包根旁边有没有 `src/`
  —— 发布包的 `files` 不带 `src/`，源码检出一律有），`ping` / `boot` 都回这两个字段。界面把这枚标签
  放在「中瑞世联工作台」后面：`dev`（琥珀色，悬停说明这是源码检出、改完要重新 build）或 `v0.0.4`
  （中性灰，悬停给形态与构建时间）。旧宿主不给这两个字段时退回 `rev` 去掉 `pkg-` 前缀，再没有才显示
  「未知」—— 任何情况下都不留空标签。

- **一处修进骨架的重构**：`boot` 从面板自己的 `useState` 挪进共享的 `build-store`（与 `envStatus` 同一套
  写法）。侧栏入口与面板头部要显示同一枚标签、面板还要拿 `boot.protocol` 做协议门禁，各自 `boot()` 会打两次
  请求，还会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。协议号 5 → 6（跨进程应答多了字段）。

- **面板头部右侧那句问候：「晚上好，某某某」**（用户 2026-09-22：「该工作台的上面右侧部分永远都有一个
  下午好/中午好，谁谁谁，这个谁谁谁是用钉钉 cli 请求的个人信息」）。新增第 26 个 Host 操作 `whoami`：
  `dws contact user get-self --format json` → `result[0].orgEmployeeModel.orgUserName`（姓名）+
  `orgName`（公司）+ `userId`；客户端按**本地时钟**把它拼成 `凌晨好/早上好/上午好/中午好/下午好/晚上好，姓名`。
  三条口径：① **未授权就不去读钥匙串**（受限沙箱下 dws 会假报「未登录」，问出来的姓名不可信），直接回空姓名；
  ② **拿不到姓名就整句不展示**（用户原话：「如果钉钉 cli 没有登录信息，那就什么也不展示」）——
  不显示「下午好，」这种半句，也不编造「同事」之类的占位；③ 宿主侧**只缓存成功结果**（姓名在一次登录周期里
  不变），失败不缓存，用户登录后刷一下页面就有，不用重启。
  同时**把头部那三个模块名（报告评估 / 报告审核 / 环境信息）去掉**（用户同批要求）：「我在哪一页」由侧栏
  分组卡的高亮说了算，头部右侧这一格留给问候。协议号 6 → 7（多了一个客户端会调用的操作）。

- **收起侧栏后不再画环境标记**（用户 2026-09-22：「左侧栏收起来的时候不应展示绿色的标记」）。
  折叠成 56px 轨道时那颗按钮只留品牌标记 —— 环境徽标（通过 = 一枚常亮的实心绿勾）一并收掉：轨道里
  既没有「环境信息」这行字、也没有卡头，那枚绿勾读不出结论，只是噪音。口径是问过用户定的（三选一，
  另两个候选是「只在『不通过』时留红徽标」与「只藏绿徽标」），用户选了最干净的那个。结论不丢：
  轨道按钮的 `title` 里仍然写着「环境信息：已通过 / 未通过 / 自检中 / 尚未自检」，展开态卡身上
  「环境信息」那一行照旧画徽标。单测钉住「折叠轨道整棵树里没有 `crwu-audit-side-entry-mark`」以及
  「留下的那枚图形必须是品牌标记（`viewBox` = `0 0 101 104`）」，真机断言点一次 DSH 自带的
  「收起侧边栏」、量完再展开还原。

- **报告审核页收成「一个大圆角框」+ 点小鲸鱼用 crwu 拉数据后跳原生会话**（用户 2026-09-22 两轮口径）。
  第一轮做了「大圆角框 + 左数据 / 右自绘 AI 讨论面板」，随后用户改口径：**右侧自绘对话框撤掉**
  （"只会增加负担"），但"crwu 的数据拉取需要做"。最终形态：
  ① 正文**只有一层**大圆角框（`.crwu-audit-surface`），卡片不再各自带描边，靠发丝线 + 留白分格；
  页签按用户口径改名 **报告列表 / AI 审核列表**（当时是下划线式；2026-09-23 那轮已改成 Segmented 白片，
  见本文件 0.0.4 顶部）；
  ② 操作列**最后面**一枚 DeepSeek 图标（**用户直接给的官方 SVG**，`viewBox 0 0 23.16 17.04`），
  悬停文案「与Deepseek一起讨论这份报告」；
  ③ 点它先用 crwu **拉一次这份报告的全部文件元数据**（新增第 26 个 Host 操作 `report-files`：
  `crwu h3yun files list --schema <code> --id <ObjectId>` 拿氚云附件元数据 —— 这是用户让我
  "看下 skills 里 crwu 是怎么查这些文件的"得到的答案 —— 加本地案例目录与云端交付件；
  **只列举、不下载**，正文由 AI 在会话里按需取）；查询期间**整块正文**盖中瑞世联等待页；
  ④ 拉完分流：**有绑定会话** → 贴点击处弹气泡问「新建对话 / 继续上次聊天」；
  **没有** → 直接建新会话 + 注入上下文（角色 + 报告事实 + 三组文件）并跳到那条**原生**会话。
  多会话用 `报告讨论 · <流水号>` / `… #2` 命名；前缀匹配排除了"另一个流水号恰是自己的前缀"。

- **为什么对话不自绘**（对照安装的 DSH 逐个核实）：`main` 槽位只有保留键 `conversation` 有会话绑定；
  客户端产物只能 `require('react')`（装不进 `ui-chat`）；右栏只有资源标签页、没有对话类型；
  真机探针实测登记回调拿到的标准 props 是
  `usePanelInfo|useSessions|useSessionPendingInteraction|useWorkspaces|useResource`（**没有 `renderSlot`**）。

- **测试与验收同步**：新增品牌图形（四个多边形 / 三红一金 / 比例 / 无障碍）、`buildTagOf` 三分支、
  build store 并发去重、`hostBuildKindOf` 真目录判据（带 `src/` = dev、不带 = installed）、
  入口在名字后标 dev / 版本、dev 形态不假装成版本号、分组卡结构（卡头是纯标题 / 只有环境那一行带标记 /
  悬停与选中的底色必须分得开 / 环境徽标是实心圆且四态各有形状）等用例；
  `npm run check` 全绿（466 个单测）。

## package · 0.0.3 · 2026-09-22

- **工作台整体重做（办公风 + Apple 视觉，用户口径）**。界面语言换成一套统一的
  「卡片靠 1px 描边 + `--dsw-shadow-lv1` 分层、圆角交给 DSH 全局的 `corner-shape: superellipse`
  （连续曲率，就是 Apple 那种圆角）、字体跟随 `--dsw-font-family`、状态色只出现在圆点/胶囊/左侧细边」
  的规范；动效只过渡 background / color / box-shadow，时长 120~160ms，不动布局属性。
  报告审核页与环境信息页全部按这套重绘：分段控件（选中段浮起）、卡片、徽章、按钮、表格行悬停、
  抽屉、授权弹框、加载进度条，连同表格列宽与「窄列不换行」那些既有硬规则一起保留。

- **入口搬到左侧栏底部、设置上方（`sidebar.footer.action`）**。工作区（会话列表）仍在它上方；
  顶部那枚 `sidebar.panellist` 图标入口**撤掉**，会话头那颗环境指示灯也**撤掉**
  （`EnvironmentStatusIcon` 组件随之删除）—— 同一件事只留一个常驻入口。入口右端常驻环境标记：
  **通过 = 绿色对勾**、不通过 = 红点、自检中 = 黄点、未自检 = 灰点，悬停给出完整结论；
  折叠成 56px 轨道时只留图标。跳转动作在点击时现读 `services.layout`（沿用「可选服务不许快照」那条纪律）。

- **三个模块 + 底部常驻模块条**。`报告评估`（置灰占位，标「开发中」，点开是说明性占位页，**
  后面由用户自己开发**）/ `报告审核`（原报告页）/ `环境信息`（原环境自检页）三段固定顺序，
  切换条常驻在面板底部，正文滚到哪都点得到。为此面板骨架改成
  「固定头部 + 可滚正文（`.crwu-audit-body`）+ 常驻底部」，滚动仍归面板自己所有。
  门禁口径不变：**自检通过就直接进报告审核**，不通过停在环境信息；报告审核段被挡住时给出
  说明 + 「重新自检」+ 「去环境信息」。

- **测试与验收同步**：槽位断言从 5 条注册（含会话头指示灯）改为 4 条；新增「旧入口与指示灯
  都不再注册」「侧栏底部入口 + 绿勾/红点」「底部模块条双向切换」「报告评估占位页」等用例；
  `install/browser-check.mjs` 改成按**几何位置**断言入口在左列下半屏、按秒表断言模块条在正文下方，
  并新增侧栏入口环境标记与占位页的核对。`npm run check` 全绿（454 个单测）。

## package · 0.0.2 · 2026-09-21

- **修「随包技能一个都没加载」**（2026-09-22 实测）：`cordis.patch.yml` 的技能根原来写成
  `new URL('skills/', baseUrl)`，但 bundle patch 里的 `baseUrl` 锚的是 **profile 目录**（profile 整棵树
  是「补丁层挂在 profile 空根配置上」），于是指向了不存在的 `<profile>/skills/` —— provider 装配成功
  却静默贡献 0 个技能（启动日志无任何报错）。改为按包名解析
  （`createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')`），并把
  `providerName` 统一为 `crwu-workbench`；新增 `tests/unit/host-skills-patch.test.mjs`（造 profile 形态
  的临时目录**真的求值一次**补丁里的表达式，改回旧写法立刻变红）。顺带修掉折叠标量漏分号的
  `SyntaxError` 隐患。

- **一份 YAML 覆盖开发、打包与员工运行**：新增 `config/crwu-workbench.yml`，明确区分匿名只读的
  `crwu-only-workspace`（环境清单、安装说明、插件 TGZ）与私有的 `crwu-workspace`（审核产物）。
  源码开发直接读取 YAML；TGZ 原样携带同一文件，安装后 Host 自动读取包内副本。
- **分发也只认这份 YAML**：`make plugin-dist` 不再从 Makefile 的 `OSS_BUCKET` / `OSS_PREFIX`
  拼地址，而是从 `oss.readonly` 计算 `oss://` 上传目标与员工 HTTPS 安装地址。
- **部署配置真正生效**：私有 OSS 的 bucket、endpoint、prefix、签名模式、TTL 与自动上传策略覆盖
  远程环境清单；插件激活时立即用 YAML 初始化运行清单，不再依赖页面先调用 `env`；RPC 不再允许
  临时替换清单地址，远程清单的 `probeCommand` 也不会进入宿主 Shell。
- **收紧手工重传边界**：`oss-upload` 只接受 Host 审核注册表里的 key，不再接受调用方传入任意
  `casePath` / `projectId`；检索后的翻页与刷新会保留当前查询条件。
- **并发配置去伪存真**：页面与 Host 继续强制同一时间只运行一条审核，删除没有任何运行时作用的
  `audit.singleAuditOnly` YAML 字段，避免部署者误以为它可以关闭门禁。
- **发布门禁**：新增 YAML Schema/地址边界测试、`config:check`、TGZ 必含配置断言，以及真实
  `npm pack` → `npm install` → 从包内 YAML 激活 Host 的回归测试。

- **权限：员工零启动参数，但首次必须授权一次**（2026-09-22 用户口径）。环境自检把「授权读取本机凭据
  （氚云 / 钉钉）」当**硬前置**：没授权就是阻塞项（插件不可用），并且**不再**谎报「钉钉没登录」——
  没授权时干脆不去猜（沙箱里读钥匙串只会得到假的未登录）。授权不是 ③ 层里一个可以被忽略的勾选框，
  而是**插件级门槛**：未授权时用一个弹框挡住整块面板（「同意并继续」/「拒绝」→ 拒绝屏 + 「再次授权」），
  一次授权**长期有效**（写进 `~/.dsh/crwu-workbench.json` 的 `trustCredentials`，重启 profile 后仍在，
  由环境自检启动时读回）。授权后：读本机凭据的命令（`crwu h3yun session login|records|forms|…`、
  `dws auth status|login`）声明 `sandboxPolicy` 去拿真结论；其余命令保持默认沙箱（最小权限）。
  `trust` 的线协议字段由 `h3yun` 改为 `credentials`（协议号 3 → 4），旧客户端的 `h3yun` 字段仍接受。

- **按流水号查云端交付件**（2026-09-22 用户要求）。工具条长在**「AI审核结果」这一页自己的卡片里**
  （用户纠正过位置：不许浮在两个标签之上，「待审核报告」页也不许有）。输入 → 点「查找」→ 只列
  `oss.protected.auditPrefix` 下这一个流水号那一层；**输入过程不发任何请求**（防抖自动查会变成反复扫
  OSS），一次「查找」**只发一次列举**；形状不对就地拦下、Host 侧再校验一次（安全边界）。命中说清
  「正在看：流水号 X 的交付件」，没命中说「OSS 上没有这个流水号的交付件」（是结论不是错误，也不回退
  去猜别的流水号），点「清空」回到全量且**不重新列举**。卡片右上角的计数跟着**正在显示的那一份**走
  （先前的「空列表 + N 项」自相矛盾读数已修），线协议操作 `oss-index` 增加可选 `seqNo`（协议号 4 → 5）。

- **真浏览器验收扩到 76 条**：新增/改写「查找框在「AI审核结果」卡片里面」「输入不列举 OSS」「命中/没命中
  各只发一次列举」「清空回到全量且不重新列举」，以及授权弹框（未授权挡住整页 + 两个明确动作）与
  AK 表单形状（只有 ID / Secret 两个输入框，不再要 STS Token 与 endpoint）。先前三条**过期断言**一并
  修正：授权开关已改成弹框、AK 表单已按用户要求去掉两个字段、「命中用例」原先误把刚输入的假流水号
  当成真流水号去查（正则会匹配到状态行里的那个号）。

## package · 0.0.1 · 2026-09-20（首个 npm 发布）

**版本号定为 `0.0.1`**：此前 `0.1.1` / `0.1.2` 两个编号**从未发布过**，首个 npm 发布用最小
版本号；下面那两节保留为同一批工作的过程记录（不表示存在过 0.1.x 的发布）。
`ping.rev` 跟着变成 `pkg-0.0.1`。

首个发布里有什么：

- **包形态**：`src/` 是唯一源码，tsdown 分构建 `lib/index.js`（ESM，导出 `name` / `inject` /
  `apply` / `Config`）与 `lib/client.js`（`__ModuleLoader__.load({ id })`，只 require `react` 与
  `react/jsx-runtime`）；`lib/` 不入库，由 `prepare.mjs` / `prepack` 产出。
- **25 条同源操作**（冻结清单）：`ping` / `boot` / `workspace` / `workspace-auto` / `trust` /
  `bind-session` / `install-prompt` / `env` / `pending` / `crwu` / `audit-start` / `audit-stop` /
  `audit-status` / `audit-release` / `oss-index` / `oss-result` / `oss-link` / `oss-upload` /
  `oss-cred-save` / `open-path` / `clipboard` / `relogin` / `dws-login` / `session` / `oss-cred`。
- **审核子代理一律挂在审核根会话下**：`host/audit/root.ts` 在 ① 选定的工作空间里建一个顶层会话
  `审核子代理根节点 · MM-DD HH:mm`（`meta.cwd` = 工作空间、**不带** `parentAgent`、
  `workspace.attachSession`），建完跑一次 hello 预检，不通过就不落钩子、不起审核；根可用就一直
  复用，不可用才新建（旧树保留）。
- **`WORKBENCH_PROTOCOL`**：宿主产物只有重启 profile 才换、客户端刷新页面就换；协议号对不上时
  界面明确说「宿主插件是旧构建，请重启 web profile」并拦住派发。
- **① 案例根目录三条硬规则**：整份持久化（path / title / id / source）、选过的目录不在了**报错
  而不静默回落**清单偏好、绝不采用父会话 cwd；配置读失败时放弃本次写入。
- **界面**：右上角环境指示灯（绿=就绪 / 红=未通过 + 悬停文案）、自检通过直接进报告审核、
  不通过用 loading 拦住；报告表固定列宽 + 风险等级列 + 窄列不换行；「审核信息」右侧抽屉；
  翻页与重新自检的加载态。
- **「查看会话」的两个根因**：可选客户端服务改为现读（不再在 `apply()` 里快照）、目标改为
  「被点那一行」的 key；另加 `uiWorkspace.openSession` 兜底路径，两条都缺才说「服务不可用」。
- **删掉「只释放占用（不停子会话）」按钮**（用户要求）：它会解开占用锁而子会话继续跑，正是
  「两条子会话往同一个案例目录对写」那条闸门要拦的状态；宿主侧 `audit-release` 保留为 host-only。
- **交付与门禁**：`install/browser-check.mjs`（47 条真实浏览器断言，且全程不点「AI 审核」）、
  `scripts/`（prepare / assert-pack / smoke-built / sync-version）、CI（Ubuntu + Windows ×
  Node 22/24）、`v*` tag → npm 发布工作流（`--provenance`）、LICENSE / SECURITY.md /
  README.en.md / `package-lock.json`。
- **文档**：`AGENTS.md` 补 §4.4.1 样式规范（CSS）与 §7.10~§7.13（审核根会话、工作空间三条硬规则、
  协议号、「查看会话」三条硬规则）；`PORTING.md` 记录 25 个操作的验证账。

发布前补进来的（2026-09-20 深夜那几轮，都在同一天）：

- **修「查看报告」打不开**：待审核报告那一行把**流水号**当成 OSS 对象 key 交给 `oss-link`
  （被前缀隔离拒掉，`对象不在配置的 OSS 前缀内`）；改成取交付件的 `htmlKey`。另外 `ok:true`
  只代表签名成功，打开浏览器失败（`opened:false`）原来被静默吞掉 —— 新增
  `openReportNotice()` 把两种情况都说清楚。
- **审核指令补上钉钉两件回传**：`auditPrompt` 原来只有「案例目录 / 重审禁读旧产物 / OSS 上传」
  三段，从没提技能步骤 15（钉钉结果回传），子会话做完 OSS 那步就收尾了。现在显式写出
  ① 团队空间归档（技能脚本**绝对路径**、**只回传结果 JSON**、按 `auditTask.auditTime` 的
  年/月分开、时间戳必须带时区）与 ② 把 HTML 发到自己的单聊并**把那条消息转成 DING**
  （`ding message send-by-message --type app`，判据是真实 `openDingId`，一个案例只发一次）。
  这一层原来一条测试都没有，新增 `tests/unit/host-audit-prompt.test.mjs` 逐条钉住。
- **面板标题旁显示当前运行的宿主版本**（`pkg-0.0.1`，悬停看构建时间）：`boot` 现在带
  `rev`/`builtAt`，`WORKBENCH_PROTOCOL` 2 → 3。宿主与客户端分开加载，用户报问题时先看这个号
  就能分清「界面新、宿主旧」。
- **CI 修到四个 job 全绿**（原来只有 ubuntu/Node 24 绿）：① ubuntu/Node 22 上 npm 10 在
  `npm pack --json --ignore-scripts` 下仍会跑 `prepare`，构建日志混进 stdout 让 `JSON.parse`
  崩掉 → `prepare.mjs` 日志改走 stderr + `assert-pack.mjs` 定位 JSON；② Windows 上
  `execFile('npm')` 起不来（npm 是 `.cmd`）→ 新增 `scripts/exec.mjs` 用当前 node 跑 npm 的
  JS 入口；③ Windows 的 `tar` 是 GNU tar，把 `C:\…` 当 `host:path` 解析
  （`Cannot connect to C: resolve failed`）→ 解包改用相对路径；④ TSX 加载器用
  `new URL(url).pathname` 当路径，Windows 上是 `/C:/…` → 改用 `fileURLToPath`。
  测试失败现在会写成 check-run 注解（job log 的 REST 接口要仓库 admin 权限，读不到）。

同一个 0.0.1 版本内继续合并仓库（2026-09-21，源仓并入 `crwu-ai/plugins/dsh-crwu-workbench/`）：

- **分发纪律：同一个版本号只发一次**（用户 2026-09-21 要求）。新增 `scripts/dist-plugin.mjs` 作为
  `make plugin-dist` 的上传守卫：远端没有该对象 → 上传；已有且 MD5 一致 → 跳过（幂等）；已有但内容
  不同 → **拒绝上传**并提示升版本号；`ossutil stat` 读不出来 → 同样不动远端。判定表自检
  （`--self-test`）已接入 `make plugin-check` 与 CI。理由：URL 就是 `<包名>-<版本>.tgz`，同版本重发
  会让早装与重装的员工拿到同一版本号下的两份内容（且 `dsh plugin add` 未必真替换 —— pnpm 见 spec
  未变会跳过，实测过）。
- **名字统一成一个 `dsh-crwu-workbench`**：目录名、npm 包名、`cordis.patch.yml` 的行 `name:`、
  tarball 文件名、员工侧 `dsh.profile.bundles` 条目全部同名（此前目录叫 `dsh-crwu-audit-workbench`，
  「目录一个名、安装另一个名」的写法已废弃）。员工侧安装命令与 OSS 上的路径**不变**。

- **技能随包发布**：本包现在的交付物不止 `lib/`，还有 `skills/`（插件专属 27 个）与
  `common/skills/`（公共技能：`crwu-dws` / `crwu-h3yun-*`）。`cordis.patch.yml` 新增
  `crwu-workbench-skills` 行（`@deepseek-ai/dsh-skill-filesystem`，独立 `providerName:
  crwu-audit-workbench`、`includeDefaultRoots: false`），把两个目录注册成技能根 —— 员工
  `dsh plugin add` 装完即得全部技能，不再靠 skills-manager 往 `~/.dsh/skills/` 里拷。
  公共技能在打包前由 `scripts/sync-common-skills.mjs` 从源仓 `plugins/common/skills/` 拷进来
  （npm 的 `files` 出不了包目录；`--check` 逐文件比内容，杜绝「改了公共技能忘了同步」）。
- **审核指令不再写死用户级技能路径**：`src/host/audit/skill-paths.ts` 从**正在运行的这份代码**
  推导包内 `skills/` 绝对路径（开发机 = 仓库、员工 = profile 的 `node_modules/`），
  `auditPrompt` 里的钉钉回传脚本路径随之改为包内绝对路径。
- **修 `crwu-h3yun-query` 的 frontmatter**：描述块有一行没缩进，YAML 解析失败 →
  `dsh-skill-filesystem` 静默忽略该技能（实测技能目录 30 个只发现 29 个，用户目录里也一样）。
  修好后 30/30 全部可发现、零警告。
- **门禁覆盖不因布局变化而消失**：三个源仓契约测试与 `check_audit_skill_mappings.py` 原先按
  `skills/` 单根推导路径，技能拆到两个根后它们会**静默 skip**（实测流失 7 + 8 + 12 条断言）；
  现在按两个根解析同级技能，`--repo-root` 改为向上找 `go.mod` + `Makefile`，覆盖率恢复到
  66 / 21 / 12 全跑。
- **CI/发布工作流随仓库移动**：`.github/workflows/` 移到仓根，插件 job 用
  `working-directory: plugins/dsh-crwu-workbench`，并新增 Go job（`go build` + `go test`）
  与技能自洽性 lint；发布 tag 前缀改为 `plugin-v*`（CLI 将来用 `v*`，两条发布线分开）。
- **打包入口**：仓根 `Makefile` 增 `plugin-deps` / `plugin-skills` / `plugin-check` /
  `plugin-pack`（→ `dist/dsh-crwu-workbench-<ver>.tgz`）/ `plugin-dist`（`ossutil` 上传并打印
  员工安装命令）/ `skills-install AGENT_DIR=…`（非 DSH 宿主按目录布局拷全部技能，替代已废弃的
  `crwu-init`）。

## package · 0.1.2 · 2026-09-20（未发布）

**收尾完成：`legacy/` 已删除，`src/` 成为唯一源码**（第 32 轮，用户明确要求后执行）：

- 删掉动态 Cordis 形态及其配套件：`legacy/`（`host.js` / `client.js` / `REV`）、
  `install/verify.mjs` + `verify.sh`、`install/rev.mjs`、5 个 `tests/legacy-*.test.mjs`、
  `tests/helpers/legacy-client-renderer.mjs`，以及随形态一起退休的
  `tests/unit/port-coverage.test.mjs` 与 `tests/unit/verify-rules.test.mjs`。
- `package.json`：去掉 `rev:bump` / `rev:check`，`check` 收窄为
  `version:check + typecheck + test + build + smoke:built`；CI 同步删除两步 legacy 校验。
- **4 处测试原本会因为读不到 `legacy/` 而断**，各自换成不依赖 legacy 的锚点：
  安装提示词从「与 legacy 逐字比对」改为**逐条钉住 10 条规则**；
  「实现了每个 legacy handler」改为**冻结的 25 条操作清单**；
  「客户端调用的 RPC 都已登记」改为用**活门面 `OPERATION_OF`** 反查并要求 `ported.todo` 为空；
  发布链路断言去掉 `rev:check`。
- 清掉把已删文件当作依据的注释（`src/host/{shell/run,audit/prompt,audit/summary,oss/parse}.ts`、
  `src/host/environment/install-prompt.ts`、`src/shared/utils/json.ts`、`AuditInfoDrawer.tsx` 等），
  保留「不要改写措辞」这类指令本身。
- 文档改为单形态：`README.md`（§一 形态表、§二 安装、§三 配置项、§四 命令与铁律、§七 目录）、
  `README.en.md`、`AGENTS.md`（§1 / §2 / §6 / §6.1 / §6.2 / §7 / §8）、
  `install/INSTALL-PROMPT.md`（原来整篇在教装动态插件，而那个路径已不存在）。
- **明确记录一条取舍**：`lib/` 产物**不能**当动态插件交（ESM 具名导出 / ModuleLoader 工厂，都不是
  沙箱函数体；注册方式、客户端传输、React 来源也都不同）。用户确认不补第二个构建目标 ——
  只维护一条形态。接缝与代价清单留在 `PORTING.md`。
- 收尾后复跑：**`npm run check` 退出码 0、354 条测试全过、`npm run pack:assert` PASS**。

**把 25 个操作按四层过了一遍账，并补上三个可安全真机验证的操作**：

- 账目：25/25 有单元测试、24/25 有界面入口（唯一例外 `ping`，与旧形态一致）、25/25 有类型化门面方法、
  **15/25 在真实 DSH 上实跑过**。清单与「剩下 10 个为什么不跑」写进 `PORTING.md`。
- 本轮新增真机验证：`oss-link`（对真实对象签名，校验 scheme/host/路径/签名参数，且**不回显 URL 本体**）、
  `audit-stop`（无进行中审核时明确拒绝）、`audit-release`（无占用时是空操作）。
- 仍未在真机跑过的那一个关键操作是 `audit-start` —— 用户明确保留这一下；它依赖的 `subagents.start`
  请求形状改由测试对照已安装的 DSH 类型声明钉死（`tests/unit/host-audit-spawn.test.mjs`）。

**收尾（删除 `legacy/`）已在仓库副本上演练通过，并补上 CI 漏掉的两道门禁**：

- **收尾演练**：把整仓 `rsync` 到 `/tmp` 的副本上真做了一遍删除 + 改造（`.git` / `node_modules` 除外），
  结果 **`npm run check` 退出码 0、354 条测试全过、`pack:assert` PASS**。演练发现的、光看代码想不到的点
  全部写进 `PORTING.md` 的「收尾计划」：14 个待删文件；**4 处测试会因为读不到 `legacy/` 而断**
  （安装提示词的「逐字对照」、两处 handler/RPC 对账、发布链路里的 `rev:check`），各自换成了不依赖 legacy 的
  锚点（逐条钉住提示词条款、冻结的 25 条操作清单、改用活门面 `OPERATION_OF` 反查并要求 `todo` 为空）；
  以及**门禁抓不到**的 `install/INSTALL-PROMPT.md` —— 它整篇还在教人装动态插件，
  删完 legacy 后引用的路径全不存在，没有任何测试会报。
- **CI 补上两道本地有、CI 没有的门禁**：`npm run version:check`（三处版本一致）与
  `npm run pack:assert`（真实 tarball 清单 + 加载契约）。此前它们只在本地 `check` 与发布前的
  `prepublishOnly` 里跑，PR 阶段挡不住 —— `AGENTS.md` §7 那句「本地漏跑会被 CI 挡住」对这两条并不成立。
  CI 现在的步骤序列写进了 `README.md` 的门禁表。

**客户端半在真实浏览器里验通了，验收清单只剩「真点一次审核」要人参与**：

- 新增 `install/browser-check.mjs`：用**真实浏览器**（系统里的 Edge，经 `playwright-core` 的
  channel，**不下载 Chromium**）打开装了插件的页面，点进面板逐页核对第 5 / 6 / 7a 条判据。
  此前这三条只能写「需人眼」—— `smoke:built` 的替身证明不了「面板真的画出来」。
  本机实测 **22 条全过、浏览器控制台零报错**：
  - 侧栏出现「中瑞世联工作台」，点进去面板渲染出标签；
  - 环境自检页画出真实平台、四个二进制（带真实路径与版本）、氚云 `正常` / 钉钉 `已登录`、iFinD `已配置`；
  - 待审核报告页画出真实待办（`共 8608 条`、真实流水号与项目名、复核级次、行内「已停止 / 已完成·已上云」
    徽章与「查看会话 / 审核信息 / 本机 HTML」入口）；
  - AI审核结果页画出 4 个真实云端案例与其 html + json 交付件；
  - 点开「审核信息」抽屉：渲染出真实摘要（项目编号 / 引擎版本 / 阶段 / 结论 / 问题总数 13 / 复核状态 / 命中率 /
    复核计数 / 生成时间），**不再报「审核结果不是合法 JSON」**；
  - **翻页时 `pending` 真的重取、`oss-index` 次数不变**；在「待审核报告 / AI审核结果」之间来回切 3 轮，
    **`oss-index` 持续为 1** —— 「切标签 / 翻页不重复列举 OSS」这条硬要求第一次在真实界面上被验证；
  - 全程只发出 `boot env install-prompt audit-status pending oss-index`，**没有 `audit-start`**。
- 该脚本**证伪过两次**：① 拿它跑一个**没装插件**的 profile → 报出唯一一条 FAIL（侧栏入口超时）、
  跳过依赖的后续阶段、退出码 1，而不是崩掉；② 把第 26 轮那个 JSON 修复**按原样还原**（`try JSON.parse`
  → 报「不是合法 JSON」）后重跑 → 抽屉那 4 条断言全红。也就是说这一步真的在盯那个缺陷，
  不是「跑起来就算过」。脚本末尾硬断言「没有发出 audit-start」，防止日后被改成会点审核。
- README 验证清单第 5 / 6 / 7a 条改为 ✅，并补上运行浏览器核对的完整命令；
  `PORTING.md`、`AGENTS.md` §7 同步（AGENTS 里原来写「哪两条只能人工验」，现在只剩第 7b 条）。

**npm 分发路径（正式分发那一半）也实测过，并修掉一个发布目标隐患**：

- **tarball 装进干净 profile 能被 DSH 正常加载**：`npm pack` → `dsh plugin --profile tgz add <tgz>`
  → 起 profile，得到的是**拷贝**而非符号链接、无 `src/`，`lib/*` 与仓库构建逐字一致；
  `ping` / `env` / `oss-result` 全部走通，客户端产物被登记进该 profile 的 web 启动清单并被原样服务；
  随包发布的 `scripts/prepare.mjs` 在无 `src/` 时按设计跳过。此前只验过 `link:` 安装，
  而那并不是用户拿到的形态。
- **发布目标钉死官方 registry**：本机 `~/.npmrc` 指向镜像时，手工 `npm publish` 会发到镜像上，
  而 `--provenance` 在镜像上不成立（一条命令踩两个坑）。现在 `publishConfig.registry` 显式写成
  `https://registry.npmjs.org`，并与 release workflow 的 `registry-url` 互相核对（测试会比对两者）。
  装依赖仍走本机镜像，不受影响。
- **`npm publish --dry-run` 现在能整条跑通**：它会让 `npm run check` 里的「真跑 `npm pack` +
  `npm install`」回归测试一起变成 dry-run，于是 `npm pack` 不产出 tarball、门禁因为与被测行为无关的
  原因变红。已在该测试里显式清掉继承来的 `npm_config_dry_run`（改回必红，已证伪）。
- **补上唯一不能真机实测那条调用链的测试**：`startChild`（发起审核子会话）过去**一条测试都没有** ——
  而它恰恰是真验证的盲区（真发一次就是在一个真实案例上跑真实审核）。新增 8 条断言，
  逐个字段对照已安装的 `@deepseek-ai/dsh-subagent` / `dsh-llm` 类型声明：
  `start(name, { label, prompt: [{type:'text',text}], parent, signal })`，其中
  **`handle.abort` 必须打在交给 DSH 的那个 signal 上**（停止 one-shot 审核靠它，打错控制器等于没取消）。
  除一条运行时与 `pickProvider` 重复、仅用于类型收窄的守卫外，其余断言均已逐条证伪。

**首次在真实 DSH 上装载验证，并修掉验证暴露的一处误报**（记录见 `README.md` 的验证清单）：

- 装进独立 `smoke` profile 后逐项实测：`ping` / `boot` / `env` / `pending` / `audit-status` 全部
  走通真实服务（真实平台识别、真实二进制路径、氚云会话正常、钉钉已登录、OSS AK 可列 bucket、
  真实待办 8608 条）；客户端产物被 DSH 登记进 web 启动清单并原样服务（与 `lib/client.js` 逐字一致）。
- **修掉「把执行失败说成未安装」的误报**：沙箱后端不可用时（本机 `sandbox-exec: sandbox_apply:
  Operation not permitted`）所有 shell 调用直接失败，旧实现丢弃了这个失败，于是环境自检对一台装好了
  Node / Python / dws 的机器报「未安装」，OSS 报「ossutil 未安装」—— 把人送去装已经装好的东西。
  现在分辨「命令根本没执行」（DSH 契约里 `run` 只为基础设施故障 reject）与「执行了但结果如此」：
  二进制报 `无法探测：<原因>`、服务报 `探测失败`、OSS 报 `无法探测`，`resolveOssutil` 改为返回
  `{ path, error }`，6 处调用点统一给出真实原因。新增 5 条测试，并逐条证伪过（改回旧行为必红）。
- **修掉「审核信息」在读真实对象时必失败**（拿真实 OSS 对象才验出来的存量缺陷，legacy 同样中招）：
  `ossutil` v1.7.19 会把 `<n>(s) elapsed` **无条件**写到 stdout，而代码对 `ossutil cat` 的输出直接
  `JSON.parse`，于是对每一个真实对象都报「审核结果不是合法 JSON」。新增 `src/shared/utils/json.ts`
  的 `parseJsonLoose`（先严格解析，失败再扫描第一个配对完整的 JSON 文档；正确处理字符串内的括号与
  转义，垃圾输入仍返回 null），并接到所有「解析命令行 stdout」的调用点（文件、HTTP body、状态文件
  仍然严格解析）。实测：真实对象 97KB → 摘要 2716 字节，`projectId` / `schemaVersion` / `counts`
  全部正确。新增 8 条测试并逐条证伪。
- 顺手修掉换用 `parseJsonLoose` 时引入的一处回归（**由已有测试抓出**）：它返回 null 而不抛错，
  而 `loadManifest` / `loadPending` / `discoverForm` 原来靠 `catch` 判失败 —— 不改就会把坏清单当成
  「已加载」、把坏取数显示成「0 条待办」。三处改为显式判空。
- README 补上「沙箱模式」这一节：包形态用 profile 的默认模式，受限模式没有后端时必须由**用户**
  按 DSH 的提示切到 `danger-full-access`；插件不会自己去申请无沙箱执行。

**包形态完成对 `legacy/` 的功能移植**（逐项收尾报告与已知差异见 `PORTING.md`）：

- **Host 操作 24/24 落地**：shell / fs / 平台识别 / 环境自检 / 清单 / 工作空间 / 氚云记录与待办 /
  OSS 凭据·列举·签名·自动上传 / 审核生命周期（发起·停止·状态·释放）/ 系统操作 / crwu 直通。
- **Client 半按四个槽位重写**：`sidebar.panellist`、`main`、`tool.view.cordis`、
  `conversation.session.header.utilities`（最后一个此前完全缺失，导致界面**没有任何入口登记审核父级**，
  `audit-start` 从界面永远失败）；拆成 `features/workbench`、`features/environment`、
  `features/report-audit` 三块，文案集中到 `src/client/locales/zh-CN.ts`。
- **修掉 8 个「操作名对得上、链路断掉」的缺口**（逐条见 `PORTING.md`）：`slots.inject` 被多包
  `ctx.effect`（激活即抛 `Invalid effect`）、**漏订阅 `subagent/end` 与 `agent/status`**
  （「已中断」永不出现、交付件自动上云整个不触发）、`audit-start` 少「必须已选定工作空间」的门禁
  （产物写进继承的 cwd，常常是源码仓库）、`workspace-auto` 只清内存不重新采用、
  `install-prompt` 文案是手写改写版（丢掉两条安全指令）等。
- **保留 legacy 的真实结论**：审核存活判据用子 Agent 自己的 `status === 'running'`（清单里有 ≠ 还活着）、
  停 one-shot 必须「先 abort 再 dispose」、占用锁要能自愈、同源越界只有 `stripPrefix` 一处。
- **有意差异 6 条**（不是遗漏）：内置案例根不做本机绝对路径兜底、Windows 命令引用按平台选引号、
  自动上传的「还没有交付件 / 目录不可读 / 未找到 ossutil」只返回原因不写 `uploadError`（legacy 会把
  「还没有东西可传」记成上传失败并挂「上云失败」徽章）等。
- **新增「搬完了」的机器判据** `tests/unit/port-coverage.test.mjs`：legacy 每个组件、四个槽位、
  每个 `workbench:*` 调用都必须有 `src` 落点，且落点文件真实存在、映射无死行。它的每条断言都做过
  **证伪**，因此抓到两条**假通过**的断言（`includes("'sidebar.panellist'")` 会被槽位登记对象的
  `name` 字段满足；`includes('auditStart:')` 会在实现被删后仍被接口声明满足）—— 已改为解析真实调用
  实参与 `import` 真门面查 `typeof`。
- 全仓测试 **389 条**（`npm run check` 全绿：版本一致 → typecheck → test → rev:check → build →
  交付校验 → 构建产物冒烟）。
- **已完成真实 DSH 装载验证**：独立 `smoke` profile 里 Host 半逐操作实测通过、客户端产物被登记并
  被服务（详见上面第一条与 `README.md`）。剩下两条要人参与：侧栏面板的肉眼确认、以及真发起一次
  审核（会在真实案例上跑）。
- **尚未执行**（需用户明确要求）：删除 `legacy/` 与配套校验/回归、文档与 CI 改成单形态。
  用户已确认「先留一个版本再删」，所以 `legacy/` 现在保持可用。

对齐 DSH 插件生态的实际分发与门禁做法（官方 [打包与安装插件] 教程 + 社区模板
`dsh-plugin-template` / `dsh-plugin-mcp-panel`）：

- **打通 npm 发布链路**（包形态按 npm 分发，是长期维护的那一半）：去掉 `private`，加
  `publishConfig`（public + provenance）、`prepublishOnly`（先产物自检再跑门禁）、
  以及 tag 驱动的 `.github/workflows/release.yml`（断言 tag 与 `package.json`/`VERSION` 一致 →
  跑门禁与产物自检 → `npm publish --provenance`；`workflow_dispatch` 可 dry-run）。
  新增 `scripts/sync-version.mjs`（`version:set` / `version:check`）与
  `scripts/assert-pack.mjs`（`pack:assert`：缺入口、误打 `tests/`/`legacy/`/`install/` 一律失败）。
- **修掉「发出去的包装不上」**（本轮实测踩出的两个坑，都是本地门禁看不出来的）：
  npm 在安装**已发布的 tarball** 时也会执行 `prepare`，而 tarball 里只有 `lib/` + 补丁 + 文档。
  `prepare: "tsdown"` 会因为找不到 tsconfig 直接失败；`prepare: "node scripts/build.mjs"`
  又因为 `scripts/` 不在 `files` 里而找不到脚本。现在构建入口是 `scripts/prepare.mjs`：
  **随包发布**、源码在就构建、源码不在（即装的是预构建产物）就跳过并打印原因；
  发布路径用 `prepack` → `build:lib --force`，源码缺失即失败，不会发出没有 `lib/` 的包。
  并加了一条**真跑 `npm pack` + `npm install` + 导入**的回归测试钉住这条路径。
- **`files` 收紧到 9 个文件**：只带 `lib/` + 补丁 + 文档；`src` / `install` / `tests` / `scripts`
  是仓库内部件，不进包（`pack:assert` 会核对真实 tarball 清单）。
- **修通包形态安装链**：加 `prepare: tsdown`（git 安装拉的是源码，没有它就装不出 `lib/`）、
  补 `engines.node`、`repository` / `bugs` / `keywords`。
- **提交 `package-lock.json`**：此前没有 lockfile，依赖不可复现，也没有 `npm ci` 可跑。
- 删除 `@deepseek-ai/dsh-client-ui-slots` 依赖：它不在 DSH 0.1.5-rc.2 的安装里，src 也不需要它的类型。
- **加 CI**（`.github/workflows/ci.yml`）：Ubuntu + Windows × Node 22/24 上跑
  `npm ci → typecheck → 交付校验 → rev:check → test → build → 断言产物`；此前门禁全靠人肉。
- **交付校验重写为 `install/verify.mjs`**，`install/verify.sh` 退化为薄包装。新增：
  语法检查、`name:` 值 ASCII 检查、客户端不得裸 `fetch` / `node:*`、文件末尾换行。
  **修掉一个静默失效的检查**：RPC 成对原来只匹配 `host.call('...')`，而客户端所有调用都经本地包装
  `call('workbench:…')`，于是它一直报告 `callers=0` 却仍然 PASS；现在按调用点解析（21 个调用者）。
  新增信息项：宿主字节上限若没有回归测试顶住会被列出（`RECORDS_STDOUT_MAX` 目前如此）；
  在 npm 包（无 `legacy/`）里运行会给出「必须在 git 克隆的仓根运行」的明确提示。
- **新增 `install/rev.mjs`**（`npm run rev:bump` / `rev:check`）：`legacy/REV` 的 sha256 / 字节数
  改为生成与校验，不再手工抄写。
- **包形态 Client 半现在有直接测试**：新增 `tests/helpers/tsx-loader.mjs`，用 `node:module` 的
  `registerHooks` 在测试进程里剥类型 + 转 JSX，并把 `react` / `react/jsx-runtime` 指向极小替身 ——
  于是 `.tsx` 能被 `node --test` 直接加载，且不引入 vitest / jsdom / react-dom。
  `tests/unit/client-package.test.mjs` 覆盖：同源 RPC 的请求契约与错误处理、槽位注册（名称/键/顺序）、
  面板在未加载 / 已加载 / 失败 / 卸载后迟到响应四种状态下的渲染、
  样式走 DSH 主题 token 而非硬编码颜色、文案必须走 locale 表。
  （此处原本写「槽位注册必须在 `ctx.effect` 内」—— 那是错的，正确结论是
  `slots.inject` **必须直接调用、不能包 `ctx.effect`**，见 `AGENTS.md` §4.1.2；测试现已反过来断言。）
- **新增 66 条包形态测试**（`tests/unit/`：交付契约 19 + 包形态 Host 31 + 包形态 Client 16）：
  交付契约的每条规则都配反向测试；Config schema 默认值与边界；同源路由的 405 / 403 / 404 / 200
  与错误信封、请求体上限；状态隔离与工作空间视图；操作表行为；`package.json` 入口 / files /
  发布配置 / peer 一致性；以及一条真跑 `npm pack` + `npm install` 的安装路径回归。
  当时全仓共 77 条（legacy 回归 11 条；移植收尾后为 368 条）。
- **修掉骨架里一处真实缺陷**：`boot` 把尚未实现的 `clipboard` 列在 `ported.done` 里，
  客户端点「复制提示词」会拿到 404；现在声明跟着实现走，并有测试防止再次漂移。
  操作表与 `ported.done/todo` 现在必须一一对应，legacy 客户端调用的每个 RPC 名都必须已登记。
- 补 `LICENSE`（内部使用）、`SECURITY.md`（插件是受信任 Host 代码、凭据位置、漏洞报告口径）、
  `README.en.md`，并把 README 的命令表、校验范围、npm 发布流程、踩坑清单更新到当前实现。
- `AGENTS.md` §6/§7/§8 更新：测试怎么摆（含 `.tsx` 怎么测）、交付契约规则的新增流程、
  门禁改为 `npm run check` + `pack:assert`、npm tag 发布流程与 DSH peer 版本对齐要求。

## package · 0.1.1 · 2026-09-20（未发布）

- 将包形态骨架拆分为 Host、Client、shared 及领域子目录，入口文件只保留 DSH 装配导出。
- 修正 Client 的 DSH ModuleLoader 包装、Host/Client 独立构建和 `lib/index.js` / `lib/client.js` 固定输出。
- 收紧 `dsh.client.inject` 与 Cordis `inject`，常量、配置、状态、HTTP 和 UI 骨架分别维护。

## legacy · pkg-43 · 2026-09-20

- 报告页增加“待审核报告 / AI审核结果”页内标签，列表直接展示氚云人工复核级次、状态和当前节点。
- 保留原 OSS 对象命名与审核报告 HTML；报告页首次进入只列举一次 OSS，检索、翻页与审核状态轮询不再重复扫 OSS，只有显式刷新或上传成功后才重新列举。
- 已审核项目增加“审核信息”入口；点击后才按精确 Key 读取一份审核结果 JSON，并以精简摘要与当前氚云复核信息并列展示。列表接口不下载逐条 JSON，也不把“氚云更新时间较晚”误称为“报告材料变化”。
- Host 对审核结果 Key 增加 Bucket 前缀和 `.json` 边界校验，限制单次读取大小，并只向 Client 返回摘要字段。
- 云端报告链接同样执行 OSS 前缀校验；对象清单只认 `审核意见.<流水号>.html` 与 `审核结果.<流水号>.json`，避免辅助文件被误当正式交付件。
- OSS 清单失败不再拖垮已成功返回的氚云列表，也不会在后续检索、翻页时自动重试；快速切换审核信息时忽略迟到的旧请求。
- 新增按需读取、完整交付件门禁、OSS 清单缓存/失败隔离、请求竞态、Key 越界拒绝与结果归一化回归测试。
- 新增根目录 `AGENTS.md`；包形态 TypeScript 按 Host / Client / shared 及领域目录拆分，常量归入各目录 `consts.ts`，并修正 Host / Client 双入口构建产物名。

## legacy · pkg-42 · 2026-09-20

- 修复审核创建期间重复点击会并发创建两个子会话的问题：Client 立即显示并禁用「创建中…」，并在创建完成前禁用其它审核入口。
- Host 增加独立的创建中门禁；并发请求在调用 `subagents.start` 前即被拒绝，成功、失败或提前返回都会自动释放门禁。
- 新增 Client 状态传递与 Host 并发请求回归测试。

## legacy · pkg-41 · 2026-09-20

- **审核只允许挂一层子代理。** `bind-session` 拒绝把子代理会话登记成审核父级并保留原来的顶层父级；
  `audit-start` 再兜一道门禁。判据是只有子代理才有的 `origin: 'subagent'` / `delegationDepth`
  （顶层会话为 `delegationDepth: 0`、无 `origin`）。
- **存活判据换成子 Agent 自己的 `AgentStatus`**（`idle` / `running`），不再依赖 `listChildren` 的 `activity`。
  `listChildren` 由会话存储驱动，跑完的一次性子会话**依然在列**，父会话一变（`state.parentSessionId`
  只是「最后看过哪个会话」）就全体查不到，界面表现为「状态跟丢」。新判据与父会话无关。
- `audit-status` 按**每条记录自己的** `parentSessionId` 聚合查询多个父会话，并对历史 depth-2 记录免疫。
- **占用锁自愈**：只要本轮真看到有子会话在 `running`，就把单条审核门禁重新挂回去。
- **「这条任务已经有了」= 带时间戳重启**：先停掉已存在的子会话（记录里的 + 清单里 label 命中同一
  流水号的），再用「重新审核」提示词重启；子会话 label 变为 `审核 <流水号> · HH:MM:SS`，记录里有
  `startedAt` 与第 N 次，界面上显示「启动 10:16:27（第 2 次）」。别的报告在跑时仍然拒绝（单条并发门禁）。

## legacy · pkg-40 · 2026-09-20

- 修 pkg-39 引入的**认领过头**缺陷：认领只收 `agentStatusOf(cid) === 'running'`。
- 认领来的记录（以及落盘时没有 `startedAt` 的记录）永远等不到 `subagent/end`，其生命周期一律以
  Agent 状态判定，一旦不再 running 就置 `ended`、按交付件定状态并释放占用 —— 据此自愈了已被
  误写进 `~/.dsh/crwu-workbench.json` 的三条记录。
- `adopted` 落盘，重启后语义不丢。

## legacy · pkg-39 · 2026-09-20

- 补回 **Client 半**：pkg-38 只带了 Host 半，导致浏览器端停在更早的 `pluginRunId` 上，
  而 `invoke()` 严格按 run 对账，于是每次 `host.call` 都返回 `stale-run` 并被面板里的
  `.catch(function () {})` 静默吞掉 —— 界面表现为「子任务在跑但什么都不显示」。
- 新增按 label「审核 <SeqNo>」认领重装前遗留的审核子会话（pkg-40 收紧了准入条件）。

## legacy · pkg-38 · 2026-09-20

- 审计记录与占用锁落盘到 `~/.dsh/crwu-workbench.json`，插件重装后自动恢复。
- 停止增加无句柄退路：直接对子 Agent 调 `cancel({ kind: 'parent' })`，与驱动 `onAbort` 同一条路径，
  所以重装前起的会话同样停得掉。

> pkg-1 … pkg-37 的历史记录在当时的 DSH 会话里（`~/.dsh/storages/session_projcache/`），
> 未逐条搬进本文件；其中 pkg-34 之后的关键节点见上。
