# 06 计算表模板契约

> ⚠️ **数值的权威来源是本轮知识快照，本文只描述"结构"。**
> 单因素修正上限、共同修正上限、组内比值上限、面积段放宽范围、税率与空置率区间等业务数值，
> **唯一权威来源是本轮知识快照**（`04-参数与税费` 的受限参数段）。
> 快照里的取值与本文不同时**以快照为准**；本文说明的是这些值在流程与底稿里的**位置与用法**。
> 技能与脚本里不内置业务阈值默认值，缺参数就如实报缺口。

> **没有随包默认业务模板，也没有内置七表 profile。** 计算表的表数量、表序、角色、输入/结果/
> 空值/单位格与公式校验全部由**工作簿自己的描述文件**声明；没有描述文件就直接拒绝。
> 旧版七表住宅 profile 的正文已移出活动文件并作为历史存档保留（仓库分析台账），
> **不是当前操作契约**。

## 0. 当前生效契约（通用描述文件通道）

`build_workbook.py` / `check_workbook_contract.py` 只认**工作簿自己的描述文件**
（`--contract <descriptor.json>` 或模板旁边的 `<模板>.contract.json`）：表数量、表序、角色
（input/formula/result）、输入/结果/空值/单位格都由描述文件声明。**没有随包默认模板，也没有内置七表
profile**；没有描述文件就直接拒绝。

- 生成：`build_workbook.py --values <填入值.json> --out <底稿.xlsx> --template <模板.xlsx> [--contract …] [--case-root …]`
- 校验：`check_workbook_contract.py <workbook.xlsx> [--contract …] [--case-root …] [--report-data …]`
  - `--case-root` 是图片路径的基准目录（Host 传**基础方案根**，不是修订目录）。缺省回退 sidecar 里的
    `caseRootRelative`（相对工作簿目录的解释），再缺省为工作簿所在目录；交付件里**不写**本机绝对路径。
  - 当填入值带 `caseEvidence` 时，产物追加可见的 `案例证据` 表，并在 sidecar 记录同一批条目。校验会
    逐行核对 caseId / 详情 URL / 图片相对路径 / 指纹 / 抓取时间 / 证据类型文本与 native 超链接，并用共享
    `evidence_index.py` 复算图片真实路径、PNG 魔数与 sha256；删除、篡改或与 sidecar 不一致即失败。
  - `--report-data` 可选：报告里 `comparables[].used === true` 的案例必须在本底稿案例证据索引里有同 caseId、
    同 sourceUrl 的行，且报告里 `validity: valid` 的截图 relativePath/digest 与索引一致；报告结构不认识时 fail closed。
- 底稿结构、业务阈值与公式链以**本轮知识快照 + 用户实际模板**为准。

## 1. 模板契约由**模板自己的填写说明**声明（协议 39）

**换一份模板不该意味着改脚本**，所以 `check_workbook_contract.py` 支持第二条通道：

```bash
python3 scripts/check_workbook_contract.py <workbook.xlsx> --contract <contract.json>
# 或者把描述文件写成 <workbook.xlsx>.contract.json，脚本会自己发现（不必带 --contract）
```

描述文件的形状（写在你那份模板的填写说明旁边）：

```json
{
  "templateId": "模板标识（进报告与留痕）",
  "templateSha256": "sha256:…",
  "sheets": [
    {"name": "输入", "role": "input", "required": true},
    {"name": "测算", "role": "formula"},
    {"name": "结果", "role": "result"}
  ],
  "orderMatters": false,
  "inputCells": ["输入!B2", "输入!B3"],
  "resultCells": ["结果!B5"],
  "unitCells": ["输入!B1", "测算!B1"],
  "emptyAllowedCells": ["输入!B4"],
  "allowHiddenSheets": false
}
```

通用通道只查**真正通用的正确性**：

| 通用校验 | 对应要求 |
| --- | --- |
| 表都是可见表（`allowHiddenSheets` 默认 false） | 无隐藏表 |
| 无外部链接、无 `#REF!` / `#VALUE!` 等错误值、无历史断链 | 公式链不得断开 |
| `inputCells` 存在且**不是公式**（受控写入） | 输入区不被公式覆盖 |
| `resultCells` 必须有公式或数值 —— 空着就是缺口 | 汇总必须有结论 |
| `formula` 角色的表必须真的有公式 | 公式区不能退化成常量 |
| `emptyAllowedCells` 里不许填 `0` | 空值不填零 |
| `unitCells` 写出的单位必须一致 | 单位与数量级一致 |
| `templateSha256` 与**实际字节**一致 | 写明本次依据的版本 |

它**不**假定表数量、表顺序、业务公式或任何业务阈值 —— 那些属于**你那份模板的填写说明**。
**没有描述文件时直接拒绝**（不回退任何内置 profile），并在输出里说明缺的是什么。

## 2. 交付前检查清单

交付计算表前逐项确认，任一项不通过不得交付：

1. 工作簿有描述文件，校验按描述文件通过；无隐藏表、无跨簿引用、无 `#REF!`；
2. 输入区 / 公式区 / 结果位与描述文件一致，输出无手工覆盖公式；
3. 业务数值（修正上限、组内比值上限、面积段放宽、税率与空置率区间等）来自本轮知识快照，
   并在交付中写明本次读到的知识正文版本；
4. 案例证据（caseId / 详情 URL / 图片相对路径 / 指纹 / 抓取时间）与 `evidence_index.py` 复算一致；
5. 报告数据与底稿的 caseId / sourceUrl / 截图 digest 对得上（`--report-data` 校验通过）。
