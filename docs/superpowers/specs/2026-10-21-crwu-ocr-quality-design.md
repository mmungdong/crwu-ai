# crwu-ocr 识别质量与规模自适应设计

- 日期：2026-10-21
- 状态：已实现（插件 0.0.52）；§14 的 6 项实测增量已落地，首轮评审的 Critical/Important 修复见 §15；未提交（仓库规则由用户决定）
- 范围：`crwu-ocr` 能力技能（脚本、契约、文档）+ 审核提示词中与该技能相关的口径
- 前序：`2026-10-20-audit-ocr-fallback-design.md`（兜底链）。本设计**不改变**其 D1–D7，只在其上增加"判读可信度"与"自适应预算"。

## 1. 背景与目标

### 1.1 现状（代码事实）

- 审核链路已按页判定 `ocrRequired[]`，由 `crwu-ocr` 转页图、会话模型判读、`ocr_record` 记录、`ocr_merge` 合并、`ocr_status` 核对覆盖。
- 识别记录已支持 `tables / visibleElements / uncertainties`。表格与数字是**模型转写**的结果，没有校验手段：写错了也看不出来。
- 默认 144 DPI、单遍判读、无预算概念。页数差异大时，要么整份按同一策略跑（慢且贵），要么靠人临时决定。
- 交付门禁只校验 `scope.notCheckedItems` 的结构，不关心 OCR 覆盖是否被真正执行；但那是审核侧的问题，本设计只负责把"可核/不可核"的事实产出清楚。

### 1.2 目标

1. **让错误可见**：关键字段（金额、面积、日期、证号）必须能回指本页原文；回指不上就拒绝，不接受"看起来合理"的值。
2. **让错误可发现**：高风险页用两次独立判读比对，不一致标冲突，由人决定，不替人选值。
3. **让成本自适应**：按材料规模、页面类型与风险等级决定 DPI、是否双读、判读顺序；额度耗尽时保留"未核"事实。
4. **让后端可替换**：记录里带 `recognizer`，将来接专用引擎时契约不变。

### 1.3 非目标

- 不实现专用 OCR 引擎（PaddleOCR-VL 等）的接入；只留字段与文档口子。
- 不做语义区域检测，不输出元素坐标；`tile` 只用固定几何切分。
- 不改 `pypdf` 优先、`crwu-ocr` 兜底的既有顺序；不改 `提取/*.txt`。
- 不改估值链路（`crwu-biz-valuation-realestate` / `crwu_valuation_file_extract`）。
- 不新增 Host Tool，不新增 Host 暂存的运行脚本（避免动白名单与暂存清单）；维护期脚本除外。

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 判读档位与风险等级由脚本按规则计算，不由模型自评 | 与"清单是脚本事实"一致；可断言、可回归 |
| D2 | 关键字段以 `quote`（本页原文逐字片段）为锚，`value` 从 `quote` 抽取 | 把"模型说它对"变成"模型能指出它在哪" |
| D3 | 双读只对高风险页，且默认有上限 | 全量双读代价翻倍，收益集中在小部分页 |
| D4 | 冲突页不选值，整页记 `conflict` | 审计纪律：宁可未核，不可给一个"二选一"的答案 |
| D5 | 页图按页保留渲染变体，不覆盖首版 | 双读要能复核"两次各看了什么" |
| D6 | 预算耗尽只停止双读，单次判读结果仍可用；不得把"未双读"说成"已核"以外的东西 | 预算管的是复核强度，不是"读没读" |
| D7 | 识别后端只留 `recognizer` 字段，不做抽象层代码 | 现在没有第二个实现，抽象会变成空壳 |
| D8 | 视觉能力预检只能是软门禁 | Host 拿不到模型视觉能力的硬事实，不承诺"启动即阻断" |

## 3. 数据契约增量

### 3.1 `ocr/index.json`

来源级不变。逐页新增（全部可选，旧索引可读）：

```json
{
  "pageClass": "scan",
  "riskTier": "high",
  "policy": { "dpi": 200, "doubleRead": true, "mode": "dpi-retry" },
  "renders": [
    { "n": 1, "dpi": 144, "mode": "page",
      "image": "ocr/pages/<sid>/<stem>_page0003.png",
      "imageSha256": "…", "engine": "quartz@macos", "createdAt": "…", "tiles": [] },
    { "n": 2, "dpi": 200, "mode": "tile",
      "image": "ocr/pages/<sid>/<stem>_page0003@200.png",
      "imageSha256": "…", "engine": "quartz@macos", "createdAt": "…",
      "tiles": [
        { "index": 1, "image": "…_page0003@200_t1.png", "imageSha256": "…" },
        { "index": 2, "image": "…_page0003@200_t2.png", "imageSha256": "…" },
        { "index": 3, "image": "…_page0003@200_t3.png", "imageSha256": "…" },
        { "index": 4, "image": "…_page0003@200_t4.png", "imageSha256": "…" }
      ] }
  ],
  "pendingReason": ""
}
```

- `pageClass`（页级）：`text`（有文本层且无需判读）/ `scan`（PDF 页无文本层）/ `image`（独立图片源）。
- `riskTier`：`high` / `normal` / `low`，规则见 §4。
- `policy.mode`：`none` / `dpi-retry` / `tile`。
- `renders[]` 只记渲染事实；`image` / `imageSha256` 保留页级字段指向**最新一版**，兼容既有读取方。
- `mode=tile` 时页级 `image` 仍是**整页图**（裁切前的原图），四张裁切图只进 `tiles[]`；这样兼容读取方永远能拿到整页。
- `pendingReason`：`""` / `not-attempted` / `vision-unavailable`。

顶层新增：

```json
"budget": {
  "pagesRequired": 42, "pagesRead": 30, "doubleReads": 4,
  "maxDoubleReads": 8, "imageCalls": 34, "elapsedMs": 0, "exhausted": false
}
```

### 3.2 `ocr/recognition/<sourceId>.json`

逐页新增：

```json
{
  "keyValues": [
    { "label": "评估值", "value": "12345678.00", "quote": "评估值：人民币 12,345,678.00 元" }
  ],
  "conflicts": [
    { "field": "评估值", "values": ["12345678.00", "12345687.00"], "reads": [1, 2] }
  ],
  "reads": [
    { "n": 1, "renderN": 1, "status": "recognized", "recordedAt": "…" },
    { "n": 2, "renderN": 2, "status": "recognized", "recordedAt": "…" }
  ],
  "recognizer": "session-vision",
  "recognitionStatus": "recognized"
}
```

- `recognitionStatus` 取值增加 `conflict`。
- `keyValues[].quote` 必须是本页 `text` 的逐字片段：两侧都去掉全部空白后再做子串判断（容忍换行与排版，不容忍错字）。
- `value` 由 `quote` 规范化抽取：先 NFKC、去全部空白；数值类字段再去千分位与货币符号、统一小数点，只比较数字串；非数值字段（日期、证号）只做 NFKC 与去空白。抽不出即拒绝该条。
- 同一 `label` 在两次判读中规范化后不相等，或一侧缺失（缺失侧记 `null`），写 `conflicts[]`，整页 `conflict`。
- `reads[].status` 只取 `recognized / partial / unreadable`（单次读取的事实）；`conflict` 是**页级** `recognitionStatus`，由跨读取比对得出。
- `reads[]` 只记读取事实；`renders[]` 在索引里，两边用 `renderN` 关联。`budget.pagesRead` 按"至少有一次读取的页"计数。

### 3.3 `ocr_status.py` 输出

新增 `conflictPages`、`budgetExhausted`、`notVerified[]`。`notVerified[]` **每页只出现一次**，`reason` 取 `pending / unreadable / conflict`，同一页命中多类时按 `conflict > unreadable > pending` 取一个。`pending` / `unreadable` 语义不变。`budgetExhausted` 只表示"不再做双读"，**不等于页面未读**。

### 3.4 `ocr_merge.py`

- 页头加档位、读取次数、方向与冲突标记：
  `===== 第 3 页 | 来源: 页图判读 | sha256: … | 状态: conflict | 档位: high/2 次 | 方向: rotated-90 =====`
  方向取 `recognition` 里该页的 `orientation`；扫描方向与 PDF `/Rotate` 是两回事，下游不能只看索引。
- 冲突页保留最新一次转写正文，但在页尾追加一行：
  `[冲突：评估值 12,345,678.00 / 12,345,687.00 —— 不得直接引用，须人工确认]`
- 未判读页的占位不变。

## 4. 判读策略与预算

### 4.1 初始分级（先验，脚本计算）

| 情形 | riskTier | 首次 DPI |
|---|---|---|
| 整份无文本层（`no-text-layer`） | high | 200 |
| 独立图片（`image-source`） | high | 200 |
| 混合件中的空页（`empty-pages`） | high | 200 |
| 有文本层、仅为核印章/勾选而渲图 | normal | 200 |
| 旋转页或单页异常 | normal | 144 |
| 其它 | normal | 144 |

> 整份无文本层且页数 > 50 时，首轮统一 144 DPI，升级交给 §4.2 的后验信号——避免几百页扫描件一上来就整份 200 DPI。

### 4.2 读完升级（后验）

首轮记录满足任一条件即升为 high 并触发第二遍：

- `tables` 存在且任一表行数 ≥ 10；
- `keyValues` 数量 ≥ 3；
- `uncertainties` 中出现小字、模糊、折痕、遮挡等关键词。

机制：`ocr_record.py` 在返回值里给出 `escalate[]`（`page` + 建议手段 `dpi-retry|tile` + `priority`），**只返回预算内条数**并按优先级排序；模型据此调 `ocr_prepare.py --re-render pages:… --dpi …` 渲新变体，再读一遍并记录。`ocr_status.py` 只按事实统计，不自行升级。

`priority` 取值（高→低）：`table`（表格行数 ≥ 10）> `keyValues`（关键字段 ≥ 3）> `uncertainty`（不确定项命中关键词）；同优先级按页序。预算为 3 时 `escalate[]` 最多 3 条，不再给出"建议 7 页、预算只够 3 页"的悬空清单。

升级只影响该页，不改整份来源的策略。

### 4.3 第二遍的两种手段

- `dpi-retry`：同页换更高 DPI 重渲重读。**默认 200；300 只在脚本内置的会话有效宽度上限支持时使用。**
  实测（2026-10-21，8 页扫描件）：300 DPI 渲染为 2479×3508，但 `read_image` 归一化后只有 1721×2435（并转 JPEG），
  相对 200 DPI 的 1653×2339 仅提升约 4%，磁盘却从约 2.5 MB/页涨到约 4.5 MB/页。**DPI 超过会话上限的部分是纯浪费。**
  实现口径：`ocr_runtime.py` 内置 `SESSION_MAX_WIDTH = 1721`（实测值，随 DSH 版本复核，并有单测锁住），
  渲染前按 `dpi × 页面英寸宽` 估算等效宽度，超过即告警并写 `render.engineNotes`，不阻塞。
- `tile`：按固定几何把页面四等分（2×2，相邻区 10% 重叠），四张裁切图分别判读、按位置拼回本页文本。**只用几何切分，不使用模型给出的框。** 整页图照常保留，裁切图只进 `tiles[]`。
- 两种手段都记入 `renders[]`，`policy.mode` 标明用了哪种。

### 4.4 预算与顺序

- 默认 `--policy auto`；`maxDoubleReads = min(10, pagesRequired, max(3, ceil(0.2 × pagesRequired)))`，`--budget N` 覆盖（同样不超过 `pagesRequired`）。
- `--policy fast`：全部 144、不双读；`auto`：按 §4.1–4.2；`quality`：所有 high 页先按 200 渲、统一双读（仍受 `--budget` 上限）。`quality` 是显式选择，可越过 §4.1 的“页数 > 50 首轮 144”保护。
- 判读顺序：high → normal → low；同档内按页序。
- 额度用尽：不再升级，剩余页保持单次判读结果；索引 `budget.exhausted=true`，供审核侧如实说明复核强度（"未双读"或"仅对 N 页双读"），**不是**未核。
- **`--re-render` 计入预算**：重渲一页即占用一个双读名额；超出 `maxDoubleReads` 时直接拒绝（`errorKind=input`，退出码 2）并提示"用 `--force-budget` 显式超预算"。实测曾出现 `doubleReads=5 > maxDoubleReads=3` 却静默通过，预算形同虚设。
- `--force-budget`：维护/排障用的显式越权开关，必须在输出里回显 `budget.exceededBy`，供审计追溯。

### 4.5 交互式重渲

`--re-render pages:3,7-9 --dpi 300`（受 §4.4 预算约束）：只重渲列出的页，作为新 `renderN` 追加，不动其它页与既有渲染。

**重渲即失效**：该页 `image` 指向新变体后，旧识别记录因 `imageSha256` 不匹配立即变为待读（`pending`）。这是证据绑定的正确行为，但对审核是实打实的成本——提示词与文档要明确"非必要不重渲；重渲后必须重读并重记"。

## 5. 脚本职责

| 脚本 | 变化 |
|---|---|
| `ocr_prepare.py` | 计算 `pageClass / riskTier / policy / budget`；新增 `--policy`、`--budget`、`--re-render`、`--force-budget`；`--re-render` 超出预算默认拒绝；页图变体命名 `<stem>_pageNNNN@<dpi>.png`；复用条件改为"该变体文件存在且 sha256 与 `renders[]` 记录一致" |
| `ocr_record.py` | 校验 `keyValues[].quote`；抽取与规范化 `value`；跨 `reads` 比对生成 `conflicts[]`；写入 `reads[]`、`recognizer`（默认 `session-vision`，`--recognizer` 仅供维护/引擎接入）与 `recognitionStatus`；返回 `escalate[]`；拒绝时返回逐页原因且不落半成品 |
| `ocr_status.py` | 汇总 `conflict`、`budget` 与 `notVerified[]`；`actions[]` 必须按**实际** `reads` 生成（单次判读 / 已双读 / 未判读），不得只凭 `budgetExhausted` 一律写"未做双读" |
| `ocr_merge.py` | 页头档位/次数；冲突追加说明行；其余不变 |

不新增运行脚本；`ocr_bench.py` 只在维护期使用，不进 `OCR_RUNTIME_FILES`。

## 6. 失败处理

| 情形 | 处置 |
|---|---|
| `quote` 去空白后不是 `text` 子串 | 拒绝该条 `keyValue`；整页可重提，重提仍失败则该页 `unreadable` |
| 两次判读同一字段值不一致或一侧缺失 | 该页 `conflict`，进 `notVerified[]`；合并文本带冲突说明 |
| 预算耗尽 | 不再升级，页面保留单次判读结果；`budget.exhausted=true`，交付说明写"未做双读" |
| `--re-render` 超出预算 | 拒绝（`errorKind=input`，退出码 2），提示改用 `--force-budget`；索引与页图均不改动 |
| 已做双读但预算耗尽 | `actions[]` 如实写"已对 N 页双读，其余为单次判读"；不得因 `exhausted` 一律写"未做双读" |
| 单页渲染失败 | 该页 `unreadable`，其余页继续 |
| 首次读图失败（模型无视觉能力） | 整类停止：剩余页 `pendingReason=vision-unavailable`，逐条登记未核并给员工动作 |
| 依赖缺失 / 无渲染通道 | 沿用现有 `capability-gap` 退出码，不逐页重试 |

## 7. 插槽与评测

### 7.1 `recognizer`

- 今天由 `ocr_record.py` 写死 `session-vision`：**不接受模型提交该字段**（模型会编）。接入专用引擎时，才由维护者用 `--recognizer external:<engine>@<version>` 显式指定；
- 将来外部引擎写 `external:<engine>@<version>`，并负责产出同一套逐页结构；
- 不新增 Tool、不改 `crwu_run_python_script` 白名单；引擎接入另立设计。

### 7.2 `ocr_bench.py`（维护期）

输入：案例目录 + `bench/truth.json`：

```json
{ "pages": [
  { "page": 2,
    "keyValues": [{ "label": "评估值", "value": "12345678.00" }],
    "tables": [{ "rows": [["科目", "评估值"], ["固定资产", "120"]] }] }
] }
```

输出：

- `keyValueAccuracy`：规范化后完全相等的比例；
- `silentErrorRate`：分母是基准里全部 `keyValues` 条数；分子是"值错误且该页未标 `conflicts`、该条未进 `uncertainties`"的条数（核心指标）；
- `tableCellAccuracy`：基准页表格单元格逐格相等比例；
- `cost`：`imageCalls`、`elapsedMs`。

支持 `--policy fast|auto|quality` 对同一案例分别跑并输出差异报告。

## 8. 兼容性

- 两个 JSON 均为增量字段；旧索引/旧记录可被新脚本读取，缺失字段按 `""` 或默认值处理。
- 旧的页图路径（无 `@dpi` 后缀）继续作为首版渲染路径，不迁移、不删除。
- `提取/*.txt`、`材料盘点.json` 的既有字段与 `ocrRequired[]` 语义不变。
- 纯文本 PDF 不产生页图、不进入判读，行为与今天一致。

## 9. 测试

### 9.1 `test_ocr_flow.py` 新增

1. 分级与策略：整份无文本层 → high/200；混合件空页 → high；有文本层核章页 → normal/200；`--policy fast` 全部 144 且不双读。
2. 变体渲染：`--re-render pages:2 --dpi 300` 只新增该页变体，首版仍在，其它页不变；重复运行复用变体（sha 一致）。
3. `tile`：整页图与四张裁切图都存在、`tiles[]` 索引完整、裁切尺寸符合重叠几何。
4. `quote` 校验：对得上通过；改一个字被拒绝并返回 `quote-not-found`。
5. 冲突：两次判读同一字段不同值 → `conflict`、`conflicts[]` 完整、`status` 汇总非零。
6. 预算：`--budget 1` 时第二次升级被拒、`budget.exhausted=true`，该页仍算已读（单次）。
7. 合并：冲突页页头标 `conflict` 且附冲突说明行；未判读页占位不变。
8. 兼容：旧格式记录（无 `keyValues/reads/renders`）可被 `status` 与 `merge` 正常处理。
9. 合并页头方向：`orientation=rotated-90` 的页在页头出现 `方向: rotated-90`。
10. 重渲预算：`--budget 1` 后 `--re-render` 第二页被拒绝（退出码 2、索引不变）；加 `--force-budget` 才通过并回显 `budget.exceededBy`。
11. 状态文案：3 页双读 + 5 页单读时，`actions[]` 写"3 页已双读、5 页单次判读"，不得写"未做双读"。
12. 分辨率上限：`SESSION_MAX_WIDTH` 有单测；超过等效宽度时只告警不阻塞，索引 `render.engineNotes` 记"实际有效分辨率约 N px"。
13. 升级优先级：`priority` 排序为表格页 > 关键字段页 > 不确定项页；`escalate[]` 长度不超过剩余预算。

### 9.2 `test_ocr_bench.py` 新增

用合成基准验证四个指标计算与 `silentErrorRate` 的"标了不算静默"口径。

### 9.3 仓库门禁

`make plugin-check`（含两个 Python 契约测试）、`make docs-check`；`assert-pack.mjs` 补 `ocr_runtime.py`、`ocr_merge.py`（现缺断言）、新增的 `ocr_bench.py` 与 schema 文件。

## 10. 上线顺序

1. 契约增量 + `prepare` 策略 + `record` 校验 + `status/merge` 冲突呈现（先不双读）→ 用真实案例测基准。
2. 双读与 `tile`（默认关，`--policy quality` 打开）→ 再测一次。
3. 提示词与审核引用口径同步：冲突页只能未核或人工确认；文档与 schema 收尾。

每一步都可停在当前状态交付。

## 11. 验收标准

1. 在已人工审过的真实案例上，`silentErrorRate` 相比改造前下降；`已核` 页不因改造回退为未核。`已核` 的定义固定为：`visualStatus=done` 且 `recognitionStatus != conflict` 且不在 `notVerified[]`。
2. 纯文本 PDF：零页图、零判读，行为与今天一致。
3. 预算耗尽只影响"是否双读"，任何交付表述都不会把**未读页**写成"已核"，也不会把单次判读页说成"已双读"。
4. 冲突页在合并文本中显式标注，不存在"脚本选了一个值"的路径。
5. 旧案例目录重跑后索引与记录仍可被 `status` / `merge` 消费。
6. 手动重渲不能绕过预算：超出 `maxDoubleReads` 必须被拒绝，除非显式 `--force-budget`。
7. `status.actions[]` 与实际 `reads` 一致：不得把已双读的页说成"未做双读"。

## 12. 风险与限制

- `quote` 校验只保证"字段与自述原文一致"，**不能证明两者都对**；真正的独立验证来自双读，而双读仍可能同错。
- 双读与高 DPI 会增加图像调用与耗时；靠 `maxDoubleReads` 与分级控制，默认 `auto` 不接受无上限。
- `tile` 可能切断跨栏表格；只在 `quality` 与明确升级的页使用，验收时逐页比对。
- 基准样本来自真实案例，规模有限；指标用于回归比较，不外推为整体准确率。
- 视觉能力是软门禁；模型自报"看不到"之前，不会有硬阻断。
- **有效分辨率由会话侧决定，不由渲染端决定**：实测 300 DPI 被归一化到 1721×2435，超过该上限的 DPI 只增加磁盘与耗时，不增加信息量。
- **手写、印章与覆盖批注仍是弱项**：只能到"部分可辨 + 不确定项"，不得据此下审核结论；需要精确识别时只能换专用引擎。
- **冲突页目前没有"清除冲突"的正式路径**：人工确认后重记仍会保留历史冲突并停在 `conflict`（fail-closed，不会给出错误结论，但该页会一直算未核）。这是已知设计缺口，需在后续版本补一条受控的确认/清除机制。
- **`--budget` 按调用生效**，不是案例级持久设置：同一次调用里 `--budget 0` 会拒绝重渲；下一次不带该参数的调用会按当次默认重新计算预算。案例里记录的是"上一次运行的预算"，不是锁。
- **`--force` 与 `--re-render` 都受双读预算约束**：`--force` 重渲全部页同样计入；`--force-budget` 是唯一的显式越权开关，越权后 `budget.exceededBy` 记录超出页数。

## 13. 版本与文档

- 插件补丁版升一级（`make plugin-version-set`），`CHANGELOG.md` 记一节；主体已在 0.0.51，§14 增量按下一补丁版（0.0.52）发布；
- 同批更新：`crwu-ocr/SKILL.md`、`references/01-execution-contract.md`、`references/03-recognition-record.md`、`schemas/*.json`；
- 审核提示词（`report-audit/prompt.ts`、`local-audit/prompt.ts`）只改与冲突/预算相关的那几句；
- 不在本设计内提交 git，提交按仓库规则由用户决定。

## 14. 实测校准（2026-10-21）

样本：`6-力鸿花园产权证.pdf`，8 页、2.9 MB、整份无文本层；两套产权（101 / 102）各含封面、权证正文、房屋登记表、分户平面图。测试在案例目录副本上完成，测后已删除全部页图与副本。

### 14.1 结果

- 渲染 8 页 1.68 s（`quartz@macos`，首轮 200 DPI）；记录 0.23 s；合并 0.19 s。
- 首轮 8 页模型判读约 79 s（≈10 s/页，含转写输出）。
- 8/8 页 recorded，0 pending、0 unreadable、0 冲突；4 页为 90° 旋转扫描，`orientation=rotated-90` 正确。
- 关键数字（101 / 102）：`197.42 / 154.62 / 42.80 / 9.46` 与 `216.46 / 169.53 / 46.93 / 9.46`，系数 `0.2768`；差值（建筑面积−套内=分摊）与比率（分摊/套内=系数）均自洽。
- 伪造 `quote` 被拒绝（`quote-not-found`，退出码 2），未写入任何记录。
- 300 DPI 渲染为 2479×3508，但会话侧归一化为 1721×2435（JPEG）；200 DPI 归一化为 1653×2339。

### 14.2 由此产生的增量

| # | 实测现象 | 处置 | 落点 |
|---|---|---|---|
| 1 | 300 DPI 有效分辨率仅提升约 4%，磁盘约 +80% | `dpi-retry` 默认 200；超过有效上限只告警 | §4.3、§9.12 |
| 2 | 手动重渲绕过预算（`doubleReads=5 > maxDoubleReads=3`） | `--re-render` 计入预算，超出拒绝；`--force-budget` 显式越权 | §4.4、§6、§9.10、§11.6 |
| 3 | `status` 写"未做双读"，实际 5 页已双读 | `actions[]` 按实际 `reads` 生成 | §5、§6、§9.11、§11.7 |
| 4 | `escalate[]` 建议 7 页、预算只有 3 页 | 带 `priority` 且只返回预算内条数 | §4.2、§9.13 |
| 5 | 重渲后 5 页立即变 `pending` | 明确"非必要不重渲，重渲必须重读" | §4.5 |
| 6 | 图号尾号在 200/300 DPI 均不可辨 | 记入 `uncertainties`，不承诺小字/表格逐格还原 | §12 |

### 14.3 未覆盖

- 冲突路径：本次两次读取一致，冲突只在单元测试覆盖；
- `tile` 与 `ocr_bench.py`：缺少人工基准 `bench/truth.json`，未实跑。

## 15. 首轮评审修复（2026-10-21）

对 0.0.52 做了一次独立整支评审，按影响重新定级后完成一轮修复（每条先有失败测试）：

- **Critical**：重复执行同一 `--re-render` 被误判超预算（变体已存在仍计入名额）。现在按“实际会新建的变体”计数，`test_21` 断言两次调用都成功且 `doubleReads` 不变。
- **Important**：`--force` 绕过预算 → 与 `--re-render` 同一道门禁，超限拒绝，`--force-budget` 显式越权（`test_33` / `test_51`）。
- **Important**：未知页号/无索引的 `--re-render` 在渲染之后才报错 → 校验移到任何写入之前（`test_52` 断言 `ocr/pages/` 未创建）。
- **Important**：`policy.mode` 恒为 `none` → 重渲后记录最后使用的手段与 DPI（`test_19`）。
- **Important**：默认 `orientation=unknown` 被当成旋转方向输出 → 只有 `rotated-90/180/270` 才追加 `方向`（`test_50`）。

评审给出的 9 条 Minor 记录在执行的 ledger 中，未进入本次修复；其中“冲突无法清除”与“`--budget` 按调用生效”已写入 §12 作为已知限制。
