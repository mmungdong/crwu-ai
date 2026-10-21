# 03 识别记录契约

识别记录是本技能唯一的"已读"证据。页图存在但记录为空，仍然是未读。

## 1. 输入文件

由模型在案例目录内写出，例如 `ocr/recognition-input.json`：

```json
{
  "sourceId": "估值报告__1a2b3c4d",
  "pages": [
    {
      "page": 1,
      "status": "recognized",
      "imageSha256": "（可选，建议填写；必须与索引一致）",
      "orientation": "normal",
      "text": "该页原文（可保留换行；看不清的用 uncertainties 说明）",
      "tables": [
        {"title": "表 1 评估结果", "rows": [["科目", "账面值", "评估值"], ["固定资产", "100", "120"]]}
      ],
      "keyValues": [
        {"label": "评估值", "value": "120", "quote": "固定资产 100 120"}
      ],
      "visibleElements": [
        {"type": "印章", "description": "评估机构公章，红章，压住签字处", "location": "右下角"},
        {"type": "签字", "description": "手写签名，字迹可辨为'张三'", "location": "签字栏"}
      ],
      "uncertainties": ["第二行数字被折痕遮挡，无法确认末位"]
    }
  ]
}
```

也接受单页对象（`page` 在顶层）或页面数组。字段要求：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `page` | 是 | 1 起的页号，必须在索引范围内 |
| `status` | 是 | `recognized`（已判读）/ `partial`（部分可读）/ `unreadable`（读不出） |
| `text` | 否 | 该页原文；`unreadable` 时可空 |
| `tables` | 否 | 数组；每个表给 `title` 与 `rows`（二维数组）或 `headers`+`rows` |
| `visibleElements` | 否 | 数组；`type`（印章/签字/勾选/手写/版式/其他）、`description`、`location` |
| `uncertainties` | 否 | 字符串数组；逐条写清哪一处不确定、为什么 |
| `orientation` | 否 | `normal` / `rotated-90` / `rotated-180` / `rotated-270` / `unknown` |
| `keyValues[]` | 否 | 关键字段：`{label, value, quote}`。`quote` 必须是本页 `text` 的**逐字片段**（去空白后子串），`value` 必须出现在 `quote` 里；对不上整页被拒 |
| `imageSha256` | 否 | 填了就必须与索引一致；不一致按 `stale` 拒绝 |
| `note` | 否 | 给后续审核人员的补充说明 |

`recognition/<sourceId>.json` 会补 `sourceId / relativePath / imageSha256 / inputPath /
recordedAt`，并按页号排序。

## 2. 忠实识别的要求

- **只写看见的东西**：不据文件名、常识或上下文补写原文、金额、日期、证号、签章人。
- **表格按版面读**：保留行列关系；合并单元格用空串占位并在 `uncertainties` 说明。
- **印章/签名/勾选算事实**：写出类型、位置、可辨认的文字；认不出就写"不可辨"，不要猜姓名。
- **方向如实**：页面横向或倒置时，写 `orientation`；不要为了"看起来正常"而改写内容。
- **不确定项必写**：遮挡、模糊、折痕、反光、缺页、被裁切都进 `uncertainties`。
- **不写审核结论**：不要写"符合/不符合/缺失/异常"；这些由审核技能基于事实判断。
- **未读页不要编**：读不出就记 `unreadable`，并在审核结论里登记未核。

## 2.1 双读、冲突与升级

- 同页第二次记录时，`reads[]` 追加一条 `{n, renderN, status, recordedAt}`；记录页面带
  `recognizer`（本期固定 `session-vision`；`--recognizer` 的其它取值会被拒绝）。
- 同一 `label` 两次判读规范化后不相等，或一侧缺失（记 `null`），写 `conflicts[]` 并把整页标成
  `recognitionStatus=conflict`。**不得在两值之间挑一个**：冲突页只能人工确认或登记未核。
- 页图重渲染后旧记录会变 `stale`：合并文本按未判读处理，必须重读该页再记录。
- 只读一次的页不产生冲突；需要升级时，`ocr_record.py` 返回 `escalate[]`（`tile` 或 `dpi-retry`，
  带 `priority`：表格 > 关键字段 > 不确定项），**只含预算内条数**并按优先级排序。模型按建议重渲
  再读一遍。预算耗尽时不再升级，该页保留单次判读结果。
- 重渲属于“必要时才做”的动作：它会让该页旧记录失效并重新计入双读预算。没有明确理由不要重渲。
- 宿主无法读图时，用 `ocr_record.py --vision-unavailable` 把全部 `pending` 页标成
  `pendingReason=vision-unavailable`，并整类停止（退出码 3）。

## 3. 批次与长文档

- 每次 `ocr_record.py` 提交**一批页**（建议 10–20 页），记录后立即落盘；不要等整份文档读完再写。
- 长文档按 `index.json` 的页序推进；每批提交后用 `ocr_status.py` 看剩余 `pending`。
- 同一页重复提交会覆盖旧记录；换批次不需要重提已完成的页。
- 页图重渲染（内容或渲染配置变化）后，旧记录的 `imageSha256` 会失效 → 重读该页再记录。

## 4. 与审核结论的接口

审核技能引用本技能时，只使用：

- `index.json` 的 `sourceId / relativePath / page / pageCount / visualStatus / riskTier`；
- `recognition/<sourceId>.json` 的逐页事实、`keyValues`、`conflicts`、`reads` 与 `uncertainties`；
- `ocr_status.py` 的 `pending / unreadable / conflictPages / budgetExhausted / notVerified`。

报告中的页码必须与索引的 `page` 一致；"第 X/Y 页已判读"只能来自 `visualStatus=done`，
`pending` 与 `unreadable` 一律写"未核"并给出原因与员工可执行动作。
