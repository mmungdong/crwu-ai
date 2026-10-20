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
--dpi 144                     页图 DPI（72–600）
--visual auto|all|none|pages:1,3-5
--deps <wheel 目录>            仅测试/排障时覆盖随包依赖位置
--force                       忽略缓存，重新渲染全部页
--reset                       丢掉索引里已有的来源（缺省保留）
--only <案例内相对路径>         可重复；只索引这些文件（审核兜底清单入口）
```

`--src` 是**可叠加**的：阶段二用 `--src 复核-人工` 复跑时，先前索引过的 `材料-源` 来源会保留，
页面图与识别记录不被覆盖；只有显式 `--reset` 才丢弃旧来源。

`--only` 是审核侧的唯一兜底入口：清单来自 `材料盘点.json` 的 `ocrRequired[].path`，只接受
**案例内相对路径**（`材料-源/报告.pdf` 这种写法）。绝对路径、含 `..`、非 PDF/图片扩展名、
文件不存在，一律按参数错误拒绝（退出码 `2`，`errorKind=input`），并且**不改写**既有索引。
它与 `--reset`、`--src` 都不能同用（前者会丢清单外来源，后者与案例内路径定位重叠）。

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

来源级 `status`：全部页有页图 = `prepared`；部分页不可读 = `partial`；无可用页图 = `failed`。

### 覆盖统计

`index.coverage`：`sources / pages / pagesWithText / pagesWithoutText / pagesVisualRequired /
pagesRecognized / pagesUnreadable / pagesPending`。它只统计事实，不产出审核结论。

## 3. 缓存与恢复

- 每个来源的 `cacheKey = 内容 sha256 | kind | pages | render=png@<dpi> | engine=<引擎/库版本>`。
- 单页复用条件：页图存在、sha256 与索引一致、`engine` 未变、未加 `--force`。
  内容或渲染配置变了就重渲染，不按文件名复用。
- 识别记录绑定该页 `imageSha256`；重渲染后旧记录不能挂到新图上（`ocr_record.py` 会拒绝）。
- 失败页保留在原位，下一次运行只补缺失/损坏的页；不需要删除整个 `ocr/`。
- `ocr/.deps/` 只是随包依赖的解包缓存，可安全删除；删除后下一次运行会重建。

## 4. `ocr_record.py`

```text
--case <绝对路径>    必填
--input <案例内 JSON> 必填；相对路径，拒绝绝对路径与 ..
--source <sourceId 或相对路径>  可选；只有一份来源时可省略
```

- 合并写入 `ocr/recognition/<sourceId>.json`，同一页后写覆盖前写；不同页保留。
- 校验：页号必须在索引范围内；`status` 必须合法；记录里的 `imageSha256` 必须与当前页图一致。
- 失败退出码 `2`，`errorKind` 为 `input`（参数/页号/字段）或 `stale`（页图已重渲染）。
- 成功后更新 `index.json` 的 `visualStatus` 与覆盖统计，并返回剩余 `pending`。

## 5. `ocr_merge.py`

```text
--case <绝对路径>        必填
--source <sourceId>      可选，可重复；缺省合并全部已索引来源
--split-pages N          可选；每 N 页一卷，缺省 0 = 一份到底
```

- 产物 `ocr/merged/<sourceId>.txt`（分卷时 `…partNN.txt`），首行是来源与时间戳，正文按页序：
  `===== 第 N 页 | 来源: 页图判读|文本层|未判读 | sha256: <前12位> | 状态: <visualStatus> =====`。
- 页内取值优先级：识别记录 `text`（非空）→ 该页 `textPath` 的文本层 → 显式占位
  `[第 N 页 未判读：no-text-layer|pending|unreadable|render-failed]`。**占位不是空行**。
- `mergedDigest = sha256(正文)`，**不含时间戳行**：没有新证据时重跑得到同一摘要，补记任一页即变化。
- 回写 `index.json` 的 `mergedTextPath / mergedDigest / mergedPages / mergedParts`。
- 退出码：`0` 成功；`2` 参数错误（案例目录不存在、未知 `sourceId`、`--split-pages` 为负、
  还没有 `index.json`）。
- 合并是**全量重写**（纯文本拼接），所以任何一次补记之后都能用同一条命令把文本对齐到记录。

## 6. `ocr_status.py`

```text
--case <绝对路径>
```

输出 `coverage / pending[] / unreadable[] / failedSources[] / actions[]`。
`pending` 表示"页图在、但还没识别"；`unreadable` 表示"读不了，必须登记未核"。

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
