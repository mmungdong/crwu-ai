---
name: crwu-ocr
description: Use when audit materials include PDFs, scans, or images whose pages, stamps, signatures, tables, or layout must be read faithfully before any review conclusion.
---

# crwu-ocr 忠实识别

## 职责

把案例目录里的 PDF 与图片变成**可复核的逐页证据**，供审核技能判读：

- 文字型 PDF 保留文本层提取；扫描页、文本提取异常的页，以及需要看印章、签名、勾选、表格与版式的页，进入**页面图判读**；
- 产出页图、逐页文本、结构化索引与识别记录，每页都有页码、图像指纹与状态；
- **只做忠实识别**：文字、表格、可见要素（印章/签名/勾选/版式）、不确定项、来源页码、状态。
  合规判断、差异定性、审核意见一律留给 `crwu-audit` 及其专业叶子。

本技能不是独立的 OCR 服务，也不是新的上传通道：页面图交给**当前 DSH 会话的图片判读能力**读取，
本技能只负责"先转图、再索引、记录覆盖与证据"。模型是否真的能读图由运行时决定，
"已生成页图"不等于"已识别"。

## 何时使用

- 审核材料里有 PDF（无论有没有文本层）、扫描件、照片、截图、票据、证照、签章页；
- 需要核对印章、签字、勾选、手写批注、表格结构、横竖版式，而文本层证明不了；
- 需要给审核结论留下"第 X/Y 页已判读 / 第 Z 页未核"的可追溯证据。

不适用：`.xlsx/.xls/.docx` 的结构化读取（走 `crwu-audit` 的材料准备与数据核查），
以及不需要看图的纯文本核对。

## 输入与产物（一律用案例目录内的相对路径）

输入：`<案例>/材料-源/` 下的 PDF 与图片（`--src` 可重复，例如复核件用 `复核-人工`）。

产物：

| 路径 | 内容 |
| --- | --- |
| `ocr/index.json` | 来源清单、逐页页图路径/指纹、文本层、视觉判读要求与状态、覆盖统计 |
| `ocr/pages/<sourceId>/<stem>_pageNNNN.png` | 整页图，基准 144 DPI（高风险页 200，变体带 `@<dpi>`），页号从 1 起 |
| `ocr/text/<sourceId>/pageNNNN.txt` | 该页文本层（存在时） |
| `ocr/recognition/<sourceId>.json` | 逐页识别记录，绑定页图 sha256 |
| `ocr/merged/<sourceId>.txt` | **按页序合并的连贯文本**（`--split-pages N` 时为 `…partNN.txt`） |
| `ocr/coverage.json` | **交付门禁用**的覆盖率快照：逐来源 verdict（`complete`/`partial`/`pending`/`skippedBudget`）、预算与 `indexDigest` |
| `ocr/refusal.json` | 整批拒绝的显式声明（仅当本轮必须判读页数 > 5000）：逐来源 `relativePath / reason / pages` |
| `ocr/.deps/` | 随包依赖的解包缓存（可删，会重建） |

不同来源或同名不同版本使用各自的 `sourceId` 子目录，互不覆盖。

## 执行步骤

脚本由 Host 在**首次调用时**暂存到 `<案例>/ocr-skill/scripts/`，统一用 `crwu_run_python_script`
执行（只提交案例内的相对脚本路径与参数，解释器与沙箱由 Host 决定；`--case` 必须等于本轮案例目录）：

1. **准备与索引**
   `script=ocr-skill/scripts/ocr_prepare.py`，参数 `--case <案例目录>`；
   需要复核件时加 `--src 复核-人工`。输出 `ocr/index.json` 与逐页摘要。
   默认 `--visual auto`（无文本层/文本过短/乱码的页要求判读）；`--policy fast|auto|quality`
   决定首轮 DPI，`--budget N` 限制双读次数（`0` = 不做双读）。
   **只处理清单里的文件**时加 `--only <案例内相对路径>`（可重复，如 `--only 材料-源/报告.pdf`）：
   未列出的既有来源保持原样，不为它们重渲染；`--only` 与 `--reset`、`--src` 不能同用。
2. **按索引逐页判读**：只读 `index.json` 里 `image` 指向的页图（`DSH read_image`），
   **不要**直接读原始 PDF 或未导出图片。对每页记录：原文文字、表格、可见要素、
   不确定项、方向与状态；金额、面积、日期、证号等关键字段再写成 `keyValues`
   （`value` 必须能在本页 `text` 的逐字 `quote` 里找到）。
   需要补判印章/签名/勾选/版式的页，先以
   `--visual pages:1,3-5` 重跑准备，再读对应页图。
3. **记录识别结果**（每 8–10 页一次，不要只在脑子里过）：
   把本批结果写成案例内 JSON（例如 `ocr/recognition-input.json`），字段见
   [03-recognition-record.md](references/03-recognition-record.md)，然后
   `script=ocr-skill/scripts/ocr_record.py`，参数 `--case <案例目录> --input <案例内 JSON>`。
   **不许攒到全部读完再写**：判读结果只活在上下文里，子任务被终止时没落盘的页就是全丢
   （2026-10-22 现场：子代理读完 32 张照片后被终止，一条记录都没有）。
   记录会校验页号、页图指纹与 `keyValues` 的 quote；图变了就必须重读，不能沿用旧结果。
   返回 `escalate[]` 时，按建议用 `ocr_prepare.py --re-render pages:<页号> --dpi <更高>`（不给 `--dpi` 时自动取更高一档）
   （`--mode tile` 用于表格页）重渲再读一遍；预算耗尽时不再升级。
   两次判读给出不同值时，记录会把该页标成 `conflict`——**不要在两值之间挑一个**。
   宿主没有视觉能力时，改用 `ocr_record.py --case <案例目录> --vision-unavailable`，
   把待判读页全部标为未判读并整类停止，不要逐页重试。
4. **合并成连贯文本**（页数多也必须能顺读）：
   `script=ocr-skill/scripts/ocr_merge.py --case <案例目录>`（可选 `--source <sourceId>`、
   `--split-pages N`），产出 `ocr/merged/<sourceId>.txt`：按页序拼接，每页一行页头
   `===== 第 N 页 | 来源: 页图判读|文本层|未判读 | sha256: <前12位> | 状态: … =====`，
   旋转扫描页的页头另有 `| 方向: rotated-90`；
   未判读的页写成 `[第 N 页 未判读：<原因>]` 占位（**绝不写空行**）。
   默认一份到底，不建议分卷；确需分卷才用 `--split-pages N`。
5. **核对覆盖**：`script=ocr-skill/scripts/ocr_status.py --case <案例目录>`。
   `pending` 未清零、`unreadable` 未登记前，不得把相关检查项写成"已核"。
6. **产出覆盖率快照（交付前**最后一步**）**：`script=ocr-skill/scripts/ocr_coverage.py --case <案例目录>`，
   产出 `ocr/coverage.json`：逐来源 verdict + `indexDigest` + `gate`。交付时
   `audit_delivery.py validate|render <结果.json>` 按它逐条对账（`--case` 省略时会从结果文件所在目录推导）——
   `readable` 与 verdict 必须一致、未判读来源必须进 `scope.notCheckedItems`、快照过期直接失败。
   **唯一阻断口径**：**只要还有待判读页（`pending > 0`）就不许交付**——5000 页以内必须读完，
   读完或把读不出的页登记 `unreadable` 才放行，**没有任何比例容忍**（`pending-pages` 会列出未读完的来源）。
   不许用 `ocr/refusal.json` 绕（那只给 > 5000 页的异常量级）。
   **分母包含"从未进过 `ocr_prepare` 的盘点件"**：不 prepare 不会让结论变好，只会换成
   `index-missing` / `inventory-page-count-missing` 两种阻断。
   **跑完不要再 `ocr_record` 或 `ocr_merge`**：两者都会重写 `ocr/index.json`，快照立即过期。
7. **整批拒绝（仅超出预算时）**：本轮必须判读页数 **> 5000** 才允许整批拒绝——写
   `ocr/refusal.json`：`{"schemaVersion":1,"sources":[{"relativePath":"材料-源/…","reason":"…","pages":351}]}`。
   快照只在批次确实超预算时才认这份声明；低于阈值会被判 `refusal-not-justified` 并阻断。
   拒绝**不删除**材料、不改 `ocr/index.json`，它是"本轮不判读"的显式声明，交付时必须逐条披露。
8. **交回审核**：在审核结论里引用页图页码与识别记录；未读页逐条登记为"未核"，给出员工可执行动作。

## 硬规则

- **渲染 ≠ 识别**：页图生成、文本层提取都只是准备；没有 `record` 的页仍是 `pending`。
- **冲突不选值**：两次判读不一致就是 `conflict`，只能人工确认或登记未核，不许脚本"挑一个"。
- **预算只停双读**：`budget.exhausted=true` 表示没做第二遍，不表示页面没读；`actions[]` 按实际 `reads` 说话。
- **有效分辨率有上限**：会话读图约 1721 px 宽，超过该宽度的 DPI 只增磁盘不增信息；`--re-render` 计入双读预算，非必要不重渲（重渲会让该页记录失效）。
- **不能因为有文本层就跳过必要视觉核验**：印章、签名、勾选、横竖版式、表格结构必须看页图。
- **未核 ≠ 缺失，也 ≠ 通过**：图片读不出、页图损坏、模型无图片能力时，只能登记未核与原因。
- **整份打不开 ≠ 已审核**：`needs-password` / `failed` 的来源 verdict 是 `pending`
  （`reasonCode` 分别是 `pdf-password-required` / `source-failed`），交付必须 `readable=false`
  并进 `notCheckedItems`；不许因为它们"没有页"就算成 `complete`。
- **单页失败继续**：某页渲染/读取失败时保留该页与页号，继续其余材料；依赖该页的检查项标未核。
- **整类环境失败立即停**：渲染引擎不可用、依赖缺失、模型没有图片能力时，停止该类剩余调用，
  报告可恢复动作，不逐页空转、不重复重试。
- **复用要可验证**：页图按来源内容、渲染配置与引擎版本复用；失败页可恢复；识别记录绑定页图 sha256。
- **不临时安装依赖**：依赖随插件发布，由 DSH 自带 Python 加载；缺依赖是能力缺口，不是"装一下"。
- **判读边界要如实**：页面图由 DSH 模型判读；不要声称完全离线，也不得另建上传/OCR API。
  隐藏 sheet / 行 / 列 / 折叠区导出的媒体不在放行清单内，禁止自行绕过。

## 平台与依赖

- Windows：随包 `pypdfium2` wheel 渲染，DSH 自带 Pillow 处理图片；
- macOS：DSH Python 是硬化签名运行时，第三方原生库无法加载，改用系统 CoreGraphics 渲染
  （无需下载），DSH 自带 Pillow 处理图片；
- 其它平台：只有文本层可用，页面图判读记为能力缺口。

细节、依赖清单与升级方式见 [02-dependency-and-platform.md](references/02-dependency-and-platform.md)。

## 完成门禁

- `ocr/index.json` 覆盖全部目标源；每页有页号、页图路径（或明确的不可读原因）、状态；
- `ocr/merged/<sourceId>.txt` 已产出且页序与 `index.json` 一致（`mergedDigest` 可复核）；
- `ocr_status.py` 的 `pending` 为空，或每个 pending/unreadable 都已在审核结论里登记为未核；
- `needsPassword`（加密 PDF）是可接受终态：整份来源登记为未核，并给员工"提供口令或解密版"的动作；
- 识别记录与页图指纹一致，批次可追溯（`recognition/<sourceId>.json`）；
- 报告中引用页码时，页码与 `index.json` 的 `page` 一致。

契约与字段细节：[01-execution-contract.md](references/01-execution-contract.md)、
[03-recognition-record.md](references/03-recognition-record.md)。
