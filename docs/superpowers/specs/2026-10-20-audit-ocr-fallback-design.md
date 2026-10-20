# 审核链路 OCR 兜底设计（crwu-audit × crwu-ocr）

- 日期：2026-10-20
- 状态：待实现
- 范围：`crwu-audit` 编排层 + `crwu-audit-datacheck` + 审核叶子 + Host 审核提示词 + `crwu-ocr` 能力技能
- 明确不动：估值链路（`crwu-biz-valuation-realestate` / `crwu_valuation_file_extract`）

## 1. 背景与目标

### 1.1 现状（代码事实）

审核链路里 PDF 文字有**两条通道**，且互不相认：

1. `crwu-audit/scripts/prepare_materials.py` 用 `pypdf` 把 PDF 正文抽成 `提取/<文件>.pdf.txt`（带
   `===== 第 N 页 =====` 分隔），无文本层时只记一句“PDF 无文本层或内容极少（疑扫描件）”；
2. `crwu-ocr` 技能把 PDF / 图片渲染成页图、抽逐页文本层、产出 `ocr/index.json` 与
   `ocr/recognition/<sourceId>.json`（页图 sha256 绑定）。

文档口径已经要求“PDF 整页判读走 `crwu-ocr`”（`crwu-audit/references/00-input-and-route-profile.md`
§211、`14-orchestration-workflow.md` 步骤 11/12、`crwu-audit-datacheck` §34、Host 两只提示词），
但**文字**层面仍是各读各的：pypdf 读不到的页没有任何东西去补，扫描页在审核里等于黑洞。

### 1.2 目标

- pypdf 能读的**一切保持原样**：`提取/*.txt` 的文件名、内容、生成时机零改动；
- 只有 pypdf **读不到**的页与独立图片，由 `crwu-ocr` 兜底；
- 兜底按**页**判定（不是整份），200 页报告里 3 页扫描件只补那 3 页；
- 兜底结果必须**按页序连成一份可顺读的文本**，页数多也不切碎，不得让审核在“有字页 / 只能看记录的页”之间跳；
- 兜底是否完成**可验证**：清单由脚本产出，覆盖由 `ocr_status.py` 判定。

### 1.3 非目标

- 不改估值链路的 `crwu_valuation_file_extract`；
- 不把 `extract_text` 从 `prepare_materials.py` 删除，也不改变“pypdf 优先”的顺序；
- 不新增 OCR 服务、不上传页面、不引入新的外部依赖（依赖随 `crwu-ocr` 包发布）；
- 不改 H0（隐藏区禁读）纪律：OCR 只做页面级视觉，不读 xlsx 隐藏区。

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | pypdf 为**主**，`crwu-ocr` 为**兜底** | 既有可读材料的文本与引用位置全部不变，风险最小 |
| D2 | 兜底判定**按页** | 混合型 PDF（正文可读、证照页扫描）最常见；整份重做既慢又改变既有文本 |
| D3 | 兜底清单由 `prepare_materials.py` 产出（`ocrRequired[]`） | 清单是脚本事实，不是模型判断；可断言、可回归 |
| D4 | 页面判读仍由 DSH 模型读页图，`crwu-ocr` 只负责转图、索引、记录 | 沿用既有能力边界，不假装有本地 OCR 引擎 |
| D5 | 合并成单一连贯文本 `ocr/merged/<sourceId>.txt` | 页数多时保证顺读；页码、sha、状态仍可回指索引 |
| D6 | 默认不分卷，提供 `--split-pages N` | 默认“一份到底”最连贯；超长件由入口显式选择分卷 |
| D7 | 覆盖未达标的页只能进 `notCheckedItems` | 沿用“未核 ≠ 缺失”，禁止把未读写成“为空/缺失” |

## 3. 架构与组件

职责三分，只加一条兜底链：

- **`crwu-audit`（编排层脚本）**：判定“这份 PDF 哪些页 pypdf 读不到”并写清单；
- **`crwu-ocr`**：把那些页与独立图片变成页图、逐页文本、判读记录与合并文本；
- **DSH 模型**：只读页图、写识别记录。

### 3.1 `prepare_materials.py`（改）

PDF 分支在既有 `pdf_to_text` 之外多算一项，**不改变** `提取/*.txt`：

- 逐份 PDF 新增 `textPages`：`{total, withText, empty, emptyPages: [页号…]}`；
- 每条材料新增 `textSource`：`pypdf`（有字） / `ocr-required`（进兜底） / `none`（图片等无 pypdf 通道）；
- 顶层新增 `ocrRequired[]`，元素：
  `{path, stage, kind: "pdf"|"image", reason: "no-text-layer"|"empty-pages"|"pypdf-error"|"encrypted"|"image-source", emptyPages: [..], pageCount }`；
- 进入 `ocrRequired` 的条件（任一命中）：
  1. PDF 整份抽取结果不足 50 字（沿用既有 `< 50` 阈值口径）；
  2. PDF 存在 `empty` 页（该页 `extract_text().strip() == ""`；有零散字符但无实质文字的页仍算 `withText`，交 `crwu-ocr` 的 `text-too-short` 规则判读）；
  3. `pypdf` 抛错 / 加密 / 打开失败；
  4. 独立图片（`.png/.jpg/.jpeg/.webp/.gif/.bmp/.tif/.tiff`）。
- `pypdf` 缺失仍走既有 `DependencyUnavailable` 逻辑，但该 PDF 同时进 `ocrRequired`（`reason=pypdf-error`），
  不再只留一句能力缺口。
- `提取/*.txt` 的命名、编码、页分隔符、写入时机全部保持现状（回归测试锁死）。

### 3.2 `ocr_prepare.py`（改）

新增 `--only <案例内相对路径>`（可重复，如 `--only 材料-源/报告.pdf`；必须是案例目录内的相对路径，
绝对路径与 `..` 一律按参数错误拒绝）：

- 只索引这些文件；未列出的既有来源保持原样（不重渲染、不丢索引）；
- 与 `--reset` 同用时退出码 2（`--reset` 会丢弃其它来源，语义冲突）；
- 其它参数（`--dpi`、`--visual`、`--src`、`--force`）语义不变。

### 3.3 `ocr_merge.py`（新）

```text
--case <绝对路径>        必填
--source <sourceId>      可选，缺省合并全部来源
--split-pages N          可选，每 N 页一卷；缺省单文件
```

输出 `ocr/merged/<sourceId>.txt`（分卷时 `<sourceId>.part01.txt`…）：

```text
# 力鸿花园产权证.pdf · 8 页 · 合并于 2026-10-20T05:49:49Z · 来源 力鸿花园产权证__049e779b
===== 第 1 页 | 来源: 页图判读 | sha256: 089f69a7e5cd | 状态: done =====
（该页识别记录原文）
===== 第 2 页 | 来源: 文本层 | sha256: 57a2270867c5 | 状态: not-required =====
（该页文本层原文）
===== 第 3 页 | 来源: 未判读 | sha256: 664311431dd3 | 状态: pending =====
[第 3 页 未判读：pending]
```

页内取值优先级：

1. 已判读（`visualStatus=done|partial` 且识别记录 `text` 非空）→ 识别记录原文；
2. 否则 `textStatus=ok` → 该页文本层原文；
3. 否则显式占位 `[第 N 页 未判读：<no-text-layer|pending|unreadable|render-failed>]`，**绝不写空行**。

同时更新 `ocr/index.json`：`mergedTextPath`、`mergedDigest`（文本 sha256）、`mergedPages`、分卷时
`mergedParts[]`。合并为**全量重写**（纯文本拼接，成本可忽略），保证任何一次补记之后内容与记录一致。

### 3.4 文档与提示词（改）

统一改成兜底链表述，并把 `ocr/merged/` 作为顺读入口：

- `crwu-audit/references/00-input-and-route-profile.md`（§141 的产物清单、§224 的实施段）；
- `crwu-audit/references/14-orchestration-workflow.md`（步骤 11 阶段一、步骤 12 复核件）；
- `crwu-audit/scripts/README.md`、`crwu-audit/SKILL.md`；
- `crwu-audit-datacheck/references/01-runtime-and-check-catalog.md`；
- Host：`src/host/domains/report-audit/prompt.ts`、`src/host/domains/local-audit/prompt.ts`；
- `crwu-ocr/SKILL.md`、`references/01-execution-contract.md`、`scripts/README.md`。

## 4. 数据流（一次审核）

```text
① prepare_materials.py              → 材料盘点.json（含 ocrRequired[]）+ 提取/*.txt（原样）
② ocr_prepare.py --only <清单>       → ocr/index.json（页面图 + 逐页文本层 + visualRequired）
③ 模型分批读页图 → ocr_record.py     → ocr/recognition/<sourceId>.json
④ ocr_merge.py                      → ocr/merged/<sourceId>.txt（页序连贯）
⑤ ocr_status.py                     → pending=0 才算覆盖；否则进 notCheckedItems
```

阶段二复核件走同一链：`prepare_materials.py --src 复核-人工` 产出的 `复核盘点.json` 同样带
`ocrRequired[]`，OCR 侧用 `--only 复核-人工/…` 单独索引（`--src` 与 `--only` 互斥），**不覆盖**阶段一产物。

## 5. 门禁与失败处理

| 门 | 规则 |
|---|---|
| G1 兜底必须跑 | `ocrRequired[]` 非空时，清单里每个 `path` 都必须在 `ocr/index.json` 有对应来源且 `status != failed`；否则判编排未完成，不得宣称“材料已核” |
| G2 覆盖才算读过 | `pending` 未清零或该页 `unreadable` → 该页进 `scope.notCheckedItems`（`reasonCode=unreadable\|unsupported` + `requiredAction`） |
| G3 占位不得当空白 | `ocr/merged/` 的占位页是显式事实；结论引用该页即越界；引用兜底页必须带页码 + sha256 前 12 位 |

失败三态：

| 情形 | 处置 |
|---|---|
| 平台能力缺口（无渲染引擎 / 依赖清单缺失 / 宿主无视觉能力） | 整类停止，逐条 `notCheckedItems` + `requiredAction`（“扫描件另存为可读 PDF 或逐页图片后重送” / “人工补录”），不逐页重试 |
| 单页渲染失败 | 该页 `unreadable`，其余页继续；合并文本占位 |
| pypdf 抛错 / 加密 / 整份无文本层 | 进 `ocrRequired`，不得写成“不可读”，交由兜底判定 |

## 6. 兼容性

- `提取/*.txt`：文件名、内容、页分隔符不变；
- `材料盘点.json`：只**新增** `textPages` / `textSource` / `ocrRequired`，既有字段语义不动；
- 旧案例目录重跑：新增字段按本次运行重算，不追溯改写既有冻结产物；
- `ocr/index.json`：新增 `merged*` 字段；旧索引可被 `ocr_merge.py` 直接补齐。

## 7. 测试（先红后绿）

### 7.1 `crwu-audit/scripts/test_prepare_materials.py`

1. 纯文本 PDF → 不进 `ocrRequired`，`textSource=pypdf`；
2. 含空页 PDF → 进 `ocrRequired`，`emptyPages` 精确到页号，`textPages.empty` 计数一致；
3. pypdf 缺失 / 抛错 / 加密 → 进 `ocrRequired`（对应 `reason`），`readable=False`，不抛整个盘点；
4. 独立图片 → 进 `ocrRequired`（`kind=image`）；
5. 回归：`提取/*.txt` 的文件名与逐字节内容与改造前一致。

### 7.2 `crwu-ocr/scripts/test_ocr_flow.py`

1. `--only` 只索引清单内文件，未列出来源的页图与记录不被改动；
2. `--only` 与 `--reset` 同用时退出码 2；
3. `ocr_merge`：页序正确、页头含来源与 sha 前 12 位、`来源: 未判读` 占位带原因；
4. 补记一页后重跑 merge，`mergedDigest` 变化且该页内容更新；
5. `--split-pages 2` 产出 `part01/part02…` 且 `mergedParts[]` 完整；
6. `pending` 页不产生空行。

### 7.3 仓库门禁

`make plugin-check`、`make docs-check`、上述两个 Python 契约测试。

## 8. 文档与版本

- 插件 `CHANGELOG.md` 增一节（feat：审核 PDF 文字 OCR 兜底与连贯合并文本）；
- `package.json` / `VERSION` / Host 常量按仓库规则同步升版：实现完成时用
  `make plugin-version-set PLUGIN_RELEASE_VERSION=<下一补丁版>` 一次写齐四处，再补 CHANGELOG 小节；
- `crwu-ocr` / `crwu-audit` 的 SKILL.md 与 references 同步（见 §3.4）。

## 9. 验收标准

1. 一份“正文可读 + 2 页扫描件”的 PDF：`提取/<文件>.pdf.txt` 与改造前逐字节一致；`ocrRequired` 命中该 PDF 且 `emptyPages` 为那 2 页；
2. 跑完 ①–⑤ 后 `ocr/merged/<sourceId>.txt` 可按页顺读，2 页扫描件内容来自识别记录，页头标 `来源: 页图判读`；
3. 同一份 PDF 中未判读页在合并文本里是显式占位，`ocr_status.py` 报 `pending` 非空，审核只能记 `notCheckedItems`；
4. 纯文本 PDF 不产生任何页图、不进兜底清单，审核行为与今天完全一致；
5. 无渲染引擎的平台上，兜底整类停止并给出员工可执行动作，不出现“材料缺失/为空”结论。
