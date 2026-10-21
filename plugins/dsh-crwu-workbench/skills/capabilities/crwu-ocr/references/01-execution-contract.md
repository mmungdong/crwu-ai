# 01 执行契约

本文件是 `ocr_prepare.py` / `ocr_record.py` / `ocr_status.py` 的运行时契约。
字段形状的机器可读版本见 `../schemas/`；两者冲突时以脚本实际校验与本文为准，并同批修正。

## 1. 调用方式

三个脚本都是案例内的受控脚本，统一经 `crwu_run_python_script` 执行：

```text
crwu_run_python_script({
  caseDir: "<案例目录>",
  script: "ocr-skill/scripts/ocr_prepare.py",
  scriptArgs: ["--case", "<案例目录>", "--src", "材料-源"]
})
```

- 解释器只用 DSH 自带 Python；不要提交解释器路径、不要拼 shell、不要 `pip install`。
- `--case` 必须是本轮案例目录的绝对路径，且由 `crwu_run_python_script` 与 Host 核定的案例目录比对；
  脚本只读写案例目录内的相对路径。
- 脚本 stdout 只输出一段 JSON 摘要；诊断写入对应 JSON 的 `error`/`errors` 字段。

## 2. `ocr_prepare.py`

```text
--case <绝对路径>              必填
--src <子目录>                 可重复；缺省 材料-源
--dpi <整数>                   首轮基准 DPI（72–600）；缺省沿用上次索引的 DPI；`high` 页不低于 200
--visual auto|all|none|pages:1,3-5
--policy fast|auto|quality     首轮策略，缺省 auto
--budget N                     双读上限；缺省按公式，0 = 禁止双读
--re-render "pages:3,7-9"      只重渲这些页，作为新的渲染变体；计入双读预算，超出需 --force-budget
--force-budget                 显式允许 --re-render 超出双读预算；索引记 budget.exceededBy
--mode dpi-retry|tile          重渲方式，缺省 dpi-retry；tile 为 2×2 几何裁切
--deps <wheel 目录>            仅测试/排障时覆盖随包依赖位置
--force                       忽略缓存，重新渲染全部页
--reset                       丢掉索引里已有的来源（缺省保留）
--only <案例内相对路径>         可重复；只索引这些文件（审核兜底清单入口）
```

`--src` 是**可叠加**的：阶段二用 `--src 复核-人工` 复跑时，先前索引过的 `材料-源` 来源会保留，
页面图与识别记录不被覆盖；只有显式 `--reset` 才丢弃旧来源。

`--only` 是审核侧的唯一兜底入口：清单来自 `材料盘点.json` 的 `ocrRequired[].path`，只接受
**案例内相对路径**（`材料-源/报告.pdf` 这种写法）。绝对路径、含 `..`、文件不存在，一律按参数错误
拒绝（退出码 `2`，`errorKind=input`），并且**不改写**既有索引。
它与 `--reset`、`--src` 都不能同用（前者会丢清单外来源，后者与案例内路径定位重叠）。

- 一份文件算不算 OCR 源按**内容**判定（PDF 头 / PNG、JPEG、GIF、BMP、TIFF、WEBP 的 magic），
  扩展名只作回退：盘点本来就把「扩展名不认识但内容是图片」的文件放进了 `ocrRequired[]`，
  这里再按文件名卡一遍会让清单与索引永远对不上。内容也认不出时仍按参数错误拒绝。

- 支持的输入：`.pdf`，以及 `.png .jpg .jpeg .webp .gif .bmp .tif .tiff`。
  其它扩展名只记入 `skipped`，不猜测内容。
- 退出码：`0` 成功（允许个别来源 `failed`/`partial`）；`2` 参数错误；`3` 能力缺口。
- 输出摘要字段：`ok / errorKind / error / indexPath / runtime / coverage / sources[]`。
  每个 source 带 `sourceId / relativePath / kind / pageCount / status / visualRequiredPages /
  unreadablePages / errors`。

### 逐页状态

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `textStatus` | `ok` / `empty` / `garbled` / `failed` | 文本层提取结果；`empty` 不代表页面没有内容 |
| `visualRequired` | 布尔 | 是否必须看页图；有原因时不得跳过 |
| `visualReasons[]` | `image-source` `no-text-layer` `text-extract-failed` `text-garbled` `text-too-short` `visual-all` `visual-pages` | 要求判读的原因 |
| `visualStatus` | `pending` / `done` / `unreadable` / `skipped` / `not-required` | `done` 只由 `ocr_record.py` 写入 |
| `renderError` | 字符串 | 该页图渲染失败的原因；非空时该页按不可读处理 |
| `pageRotation` | `0/90/180/270` | PDF 页的 `/Rotate`；页图已按显示方向渲染 |
| `engine` | `pdfium@…` / `quartz@…` | 生成该页图的渲染引擎（缓存复用条件之一） |
| `pageClass` | `text` / `scan` / `image` | 页级分类：有文本层、PDF 扫描页、独立图片 |
| `riskTier` | `high` / `normal` / `low` | 脚本按规则算出的风险等级；`high` 页首轮用 200 DPI（大文档除外） |
| `policy` | 对象 | `{dpi, doubleRead, mode}`：`mode` 取 `none` / `dpi-retry` / `tile`，重渲后记录该页最后使用的手段；`dpi` 随之更新为最后一版渲染的 DPI |
| `renders[]` | 数组 | 每次渲染一条：`{n, dpi, mode: page\|tile, image, imageSha256, width, height, pageRotation, engine, createdAt, tiles[]}` |
| `pendingReason` | 字符串 | `""` / `vision-unavailable`；后者由 `ocr_record.py --vision-unavailable` 写入，重跑 prepare 时保留 |

来源级 `status`：全部页有页图 = `prepared`；部分页不可读 = `partial`；无可用页图 = `failed`。

### 覆盖统计

`index.coverage`：`sources / pages / pagesWithText / pagesWithoutText / pagesVisualRequired /
pagesRecognized / pagesUnreadable / pagesPending`。它只统计事实，不产出审核结论。

### 预算

`index.budget`：`pagesRequired / pagesRead / doubleReads / maxDoubleReads / imageCalls / elapsedMs /
exhausted`，越权时另有 `exceededBy`。`maxDoubleReads` 缺省为
`min(10, pagesRequired, max(3, ceil(0.2 × pagesRequired)))`；`--budget N` 覆盖，
**`0` 表示显式禁止双读**。`exhausted=true` 只表示"不再做双读"，**不表示页面没读**。

`--re-render` 每页占用一个双读名额：`已有 doubleReads + 本次页数 > maxDoubleReads` 时直接拒绝
（退出码 2，`errorKind=input`），除非同时给 `--force-budget`；越权通过后
`budget.exceededBy = doubleReads - maxDoubleReads`。

### 有效分辨率

会话侧 `read_image` 会把页图归一化到约 **1721 px 宽**（`ocr_runtime.SESSION_MAX_WIDTH`，实测值）。
渲染结果超过该宽度时，`render.engineNotes` 追加一条
`会话侧有效宽度约 1721 px；本次最大页图宽 N px，超出部分不增加信息量`——只告警，不阻塞。
因此 `dpi-retry` 默认 200；300 DPI 只在确实需要且接受"超出部分被丢弃"时使用。

## 3. 缓存与恢复

- 每个来源的 `cacheKey = 内容 sha256 | kind | pages | render=png@<dpi> | engine=<引擎/库版本>`。
- 单页复用条件：页图存在、sha256 与索引一致、`engine` 未变、未加 `--force`；`--force` 会为这些页追加新的渲染变体。
  内容或渲染配置变了就重渲染，不按文件名复用。
- 识别记录绑定该页 `imageSha256`；重渲染后旧记录不能挂到新图上（`ocr_record.py` 会拒绝）。
- 失败页保留在原位，下一次运行只补缺失/损坏的页；不需要删除整个 `ocr/`。
- `ocr/.deps/` 只是随包依赖的解包缓存，可安全删除；删除后下一次运行会重建。

## 4. `ocr_record.py`

```text
--case <绝对路径>    必填
--input <案例内 JSON> 读取 recognition 时必填；相对路径，拒绝绝对路径与 ..
--source <sourceId 或相对路径>  可选；只有一份来源时可省略
--recognizer <标识>   写入记录的识别器；本期只接受 session-vision，其它值按 input 拒绝
--vision-unavailable  不读任何页：把 pending 页标为 vision-unavailable，退出码 3
```

- 合并写入 `ocr/recognition/<sourceId>.json`，同一页追加一条 `reads[]`；不同页保留。
- 校验：页号必须在索引范围内；`status` 必须合法；`imageSha256` 必须与当前页图一致；
  `keyValues[]` 的 `quote` 必须是本页 `text` 的逐字片段（去空白后子串），`value` 必须出现在 `quote` 里。
- 同一 `label` 在两次判读里规范化后不相等，或一侧缺失（记 `null`），写入 `conflicts[]`，
  该页 `recognitionStatus=conflict`；**不替人选值**。
- 失败退出码 `2`，`errorKind` 为 `input`（参数/页号/字段/quote）或 `stale`（页图已重渲染）。
- 成功后更新 `index.json` 的 `visualStatus`、`recognitionStatus` 与覆盖统计，返回剩余 `pending`；
  返回 `escalate[] = [{page, mode, priority}]`（`mode` 为 `tile` 或 `dpi-retry`；`priority` 为
  `table` / `keyValues` / `uncertainty`），按优先级排序且**只含预算内条数**（剩余 `maxDoubleReads - doubleReads`）。

## 5. `ocr_merge.py`

```text
--case <绝对路径>        必填
--source <sourceId>      可选，可重复；缺省合并全部已索引来源
--split-pages N          可选；每 N 页一卷，缺省 0 = 一份到底
```

- 产物 `ocr/merged/<sourceId>.txt`（分卷时 `…partNN.txt`），首行是来源与时间戳，正文按页序：
  `===== 第 N 页 | 来源: 页图判读|文本层|未判读 | sha256: <前12位> | 状态: <visualStatus|conflict> | 档位: <riskTier>/<读取次数> 次 =====`；
  旋转扫描页另加 ` | 方向: rotated-90|rotated-180|rotated-270`（`normal` / `unknown` / 缺省不出现）。
- 冲突页在正文后追加一行：`[冲突：<字段> <值1> / <值2> —— 不得直接引用，须人工确认]`。
- 页内取值优先级：识别记录 `text`（非空）→ 该页 `textPath` 的文本层 → 显式占位
  `[第 N 页 未判读：no-text-layer|pending|unreadable|render-failed|stale-record]`。**占位不是空行**；记录绑定的 `imageSha256` 与当前页图不一致时按 `stale-record` 处理，不引用旧正文。
- `mergedDigest = sha256(正文)`，**不含时间戳行**：没有新证据时重跑得到同一摘要，补记任一页即变化。
- 回写 `index.json` 的 `mergedTextPath / mergedDigest / mergedPages / mergedParts`。
- 退出码：`0` 成功；`2` 参数错误（案例目录不存在、未知 `sourceId`、`--split-pages` 为负、
  还没有 `index.json`）。
- 合并是**全量重写**（纯文本拼接），所以任何一次补记之后都能用同一条命令把文本对齐到记录。

## 6. `ocr_status.py`

```text
--case <绝对路径>
```

输出 `coverage / pending[] / unreadable[] / failedSources[] / needsPassword[] /
conflictPages[] / budgetExhausted / notVerified[] / actions[]`。
`pending` 表示"页图在、但还没识别"；`unreadable` 表示"读不了，必须登记未核"；
`needsPassword` 表示"加密 PDF、本机没有口令通道"——它是**可接受终态**，但整份来源必须
登记进审核结论的 `scope.notCheckedItems`（`reasonCode=needs-password`）并给出员工动作；
`notVerified[]` 每页只出现一次，`reason` 取 `conflict / unreadable / pending`。

## 7. 错误分类与处置

| `errorKind` | 含义 | 处置 |
| --- | --- | --- |
| `capability-gap` | 平台无渲染引擎/依赖清单缺失 | 停止该类调用，报告平台与缺失项；不要逐页重试 |
| `deps-manifest` / `deps-missing` / `deps-integrity` | 随包依赖清单或字节/哈希不符 | 插件包不完整；重装插件或修包，不在审核中补装 |
| `deps-unpack` / `deps-import` | 解包或导入失败 | 保留结构化错误；换受支持平台或修包 |
| `deps-signature` | 原生库被本机签名策略拒绝 | 属平台约束；改用该平台的系统渲染通道或报告缺口 |
| `runtime-package-missing` | DSH 运行时缺 Pillow | 部署侧补齐；本技能不安装 |
| `input` | 参数/路径/页号/字段不合法 | 按错误原文修正后重跑 |
| `stale` | 记录与当前页图不对应 | 重新读取该页并记录 |

个别来源 `failed` 不改变退出码 `0`：其余材料照常可用，失败来源必须在审核结论里登记未核。
