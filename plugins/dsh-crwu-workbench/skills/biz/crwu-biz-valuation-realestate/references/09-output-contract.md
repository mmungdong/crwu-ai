# 09 · 输出契约（案例目录、JSON、报告与底稿）

本轮的**全部产物只写在估值案例目录里**。技能目录（含 `template/`、`schemas/`、`examples/`）
是**只读**的：任何情况下都不许回写，产物一律落案例目录。

## 案例目录

```text
<已选工作区>/<估值 ID>/
  材料-源/                 原始资料（Host 复制进来，带 sha256 清单）
  来源证据/                 外部页面证据（页面字节 + 内容指纹）
  知识快照/                 本轮实际取到的知识正文 + .知识来源.json（路由/来源/更新时间/指纹）
  提取结果/                 资料提取的完整结果（正文与表格）
  估值输入.json             确认抽屉确认时**冻结**的输入（方法/基准日/补充要求/资料清单/指纹）
  估值对象.json             规范化后的评估对象（fields / missing_fields / source_files）
  估值案例.json             候选案例（含来源、链接、时间、挂牌或成交、保留剔除理由）
  估值参数.json             参数与税率取值及依据
  估值结果.json             结论（见下）
  估值报告.html             人读的报告
  估值底稿.xlsx             由 template/valuation-workbook.xlsx 复制后填写的计算表
```

`估值输入.json` 是**不可变**的：它由 Host 在确认那一刻写死，子会话只能读。
方法、基准日与用户补充要求都取自它，子会话没有参数能改写。

## 一轮 = 一个估价对象

本契约是**单对象**的：一个案例目录对应一个估价对象、一份 `估值对象.json`、一份 `估值结果.json`、
一张汇总表。理由不是省事，而是**多宗资产混在一轮里必然出错**：比较案例是按对象选的，
面积口径与税费口径也可能不同 —— 合并面积或共用一组案例算出来的"总价"没有任何意义。

多宗资产的处理方式：**分轮**。每宗资产单独一轮（各自的案例目录、各自的案例组与底稿），
最后如需合并成一个项目结论，那是**报告层**的事，不在这一层做，也不许把两轮的数字凑在一起。

## 估值结果.json

结构与校验规则见 [`schemas/valuation-result.schema.json`](../schemas/valuation-result.schema.json)，
样例见 [`examples/valuation-result.sample.json`](../examples/valuation-result.sample.json)。
几条**会被校验脚本判为不合格**的硬性规则：

1. `method` 只能是 `market` / `income` / `cost`：`auto` 是用户的**输入**，不是结论。
   用 `auto` 时必须写出采用的方法与未采用方法的理由（写在 `methodReason`）。
1.1. **方法判断记录**（§7.2）是必填的两项：

   - `methodScreening`：至少一条，**恰好一条** `verdict: adopted` 且与 `method` 一致；
     每条（含未采用的）都要写依据（规范条款 / 资料条件 / 数据充分性）。只写一句"不符合要求"不可复核；
   - `methodConflict`：**用户指定的方法与结论不一致**时必须给出（`userMethod` / `adoptedMethod` / `reason`），
     没有冲突时显式写 `null`。校验脚本会把结果与案例目录里的 `估值输入.json`（冻结输入）对一遍：
     用户指定了 `market` 而结论是 `income`，`methodConflict` 又是 `null` → **判不合格**。
     **不许静默切换**：要么按用户指定的方法算，要么把冲突与原因写出来（并进 `manual_confirmation_items`）。
     宿主侧完成门槛同样拦这一条 —— 子会话跳过校验脚本也过不去。
2. `baseDate` 为空时，`manual_confirmation_items` **必须**包含 `本次未指定评估基准日`。
   **不许**把资料里识别到的日期补成基准日 —— 识别到的东西可以展示为"资料中的日期"，不能冒充用户确认。
3. `unitPrice` 与 `totalValue` 至少一个非空；拿不到就是 `null`，**不许填 0**。
3.1. `pricingArea`（计价面积，㎡）与 `priceUnit`（计价单位）是**必填**：
   - `priceUnit` 统一写 `元/㎡`（人民币元/建筑平方米）。按套内面积或按套计价的第一律先换算，
     不在这里换一种口径（`references/01` 第 5 条）；
   - 有 `unitPrice` 就**必须**有正数 `pricingArea`：没有计价面积，总价与单价没法勾稽 ——
     那正是"三个数各说一套"的来源；
   - `unitPrice × pricingArea ≈ totalValue`（允许 1 元舍入差）。超出即判不合格。
4. `knowledge_sources[].source` 只能是 `dws` 或 `local`，且 `digest` 非空；
   **每一条都必须在 `知识快照/.知识来源.json` 里**，且指纹一致 —— 换句话说：
   来源清单只能列**本轮真的取到过**的那几份。快照里有 `dws` 来源却没写进结果同样不合格
   （那等于把"用了降级备份"说成"用了知识库"）。
5. 每条案例必须有 `transaction_type`，且 `keep_reason` / `drop_reason` 至少一个非空（要留下人工判断）。
5.1. 每条案例必须有 **`status`** 与 **`rule_checks`**（§8）。只写一句"符合要求"或"不符合要求"不可复核：

   - `status` 六选一：`adopted` / `not-comparable` / `insufficient-evidence` /
     `single-rule-failed` / `combined-rule-failed` / `group-consistency-failed`；
     它与 `used_as_comparable` 必须一致（`adopted` ⟺ `true`）。
   - `rule_checks[]` 每项给 `rule_id` + `verdict` + `reason`；数值型规则还要给 `actual` 与 `threshold`。
     规则 ID 只允许 `R-COMPARABILITY` / `R-EVIDENCE` / `R-SINGLE-20` / `R-COMBINED-30` / `R-GROUP-1.2`。
   - **阈值不许自行放宽**：`R-SINGLE-20` 的 `threshold` 必须逐字等于 `0.2`、`R-COMBINED-30` 等于 `0.3`、
     `R-GROUP-1.2` 等于 `1.2`（口径见 `references/02-market-method.md` 第 9 节）。
   - **每个剔除案例至少有一条 `fail`**，且触发它的那条规则要能对上 `status`。
   - **采用案例不许带着没通过的规则判定**（`status = adopted` 时，除 `R-GROUP-1.2` 外不许有 `fail`）。
   - `R-GROUP-1.2` 的 `actual` **必须能从采用案例的比准价重算得到**（`max/min`）；超过 1.2 时
     `manual_confirmation_items` 里必须写明处置方式（剔除离群 / 改加权 / 说明原因后保留）。
     反复删高价低价去凑一个想要的估值是不允许的：没有选组依据就报告规则缺口。
6. `used_as_comparable = true` 的案例，`transaction_type` **必须**是 `成交`。
   挂牌价是卖方要价，系统性高于成交价 —— 直接当成交价会把估值整体抬高。
7. `artifacts` 三个路径都要给，`html` 与 `xlsx` 必须真的存在于案例目录里。
8. `capability_gaps` 与 `manual_confirmation_items` 要**完整**：有缺口却写成"已按规范完成"，
   比缺一个数字更糟。

## 交付前必须过的两道校验

```bash
# 工作簿契约：七张可见表、无隐藏表、无跨工作簿链接、公式链不断（#REF!/#VALUE!/#DIV/0!）
python3 scripts/check_workbook_contract.py <案例目录>/估值底稿.xlsx

# 结果契约：上面的 JSON 结构 + 口径规则（可直接带 --html / --workbook 做一致性抽查）
python3 scripts/validate_result.py <案例目录>/估值结果.json \
    --html <案例目录>/估值报告.html --workbook <案例目录>/估值底稿.xlsx
```

**所有数字结论以重算后的工作簿为准**：报告与结果 JSON 里的数字必须能从底稿的公式重算得到；
两者不一致时以底稿为准并修报告，而不是改底稿去凑报告。

### 「三者一致」到底查到哪一步（能力边界，别误读）

| 两两 | 查到什么 | 怎么查 |
| --- | --- | --- |
| 报告 ↔ 结果 JSON | **严格**：报告里必须找得到 JSON 的单价与总价 | `validate_result.py --html` |
| 结果 JSON ↔ 底稿 | **方法严格**：JSON 的 `method` 必须出现在汇总表「采用的方法」列里 | `validate_result.py --workbook` |
| 结果 JSON ↔ 底稿 | **数字抽查**：隐藏表、`#REF!`/`#VALUE!`/`#DIV/0!`、结构存在性 | `check_workbook_contract.py` + `--workbook` |
| 结果 JSON ↔ 底稿 | **留痕一致**：采用案例的 `evidence` 必须写进「案例截图 / 证据留档」行；`manual_confirmation_items` 必须写进「待确认事项」行 | `validate_result.py --workbook` |
| 底稿数字 ↔ JSON 数字 | ⚠️ **本机查不了**：比较需要**重算后的**单元格值，而 openpyxl 不算公式 | 交付前必须真打开一次底稿让它重算 |

最后一格是**已记录的能力缺口**，不是"已经查过了"。所以规矩是：重算之后**由人核对**一次
汇总表的结论与 JSON 是否一致；本机的自动检查保证的是"口径（方法与结构）一致 + 数字没写错地方"。

## HTML 报告

报告至少要能回答：评估对象是谁、价值类型与基准日、采用的方法与理由、关键参数与取值依据、
单价与总价、待确认事项、能力缺口、知识来源清单、案例清单（含来源与时间）。
报告是一次性渲染的人读件，**不参与**计算；数字一致性的权威是底稿。
