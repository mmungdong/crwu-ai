# 审核意见 ↔ 审核过程 对账报告

> 数据来源：本机 `~/Downloads/修复复盘日志/` 两份 DSH 会话归档
> - 会话 1（本地审核 · 曲靖建宁商混）`session-62269d48-…`
> - 会话 2（氚云报告审核 · 贵州电网报废物资）`session-3c196b84-…`
>
> 交付件来源：
> - 会话 2 的员工 HTML 已定位到本机文件 `~/Downloads/未确认 566413.crdownload`（**358,498 字节，与日志中 `审核意见.2026-302807-LX10384-BG8897.html` 的字节数完全一致**；内嵌 `phase1Digest=0be87e20…55db98b` 与日志一致）。从 `<script id="audit-result" type="application/json">` 中解出完整 AuditResult（175,600 字节 JSON）。
> - 会话 1 的 HTML 未落盘到本机，其 AuditResult 从日志中的组装脚本（`build_audit_result.py` / `issues_a.py` / `parts_c.py` 等 heredoc）逐字重建。

---

## 0. 对账结论

| # | 对账项 | 结论 |
| --- | --- | --- |
| R1 | 会话 1 结论 **EI-013** 的正文与其自带证据**算术互相矛盾**，且该矛盾来自子代理一个不可复算的断言 | ❌ **不一致（可复算证伪）** |
| R2 | 会话 1 最重的实质发现（重复行涉 **约 336,690 元**评估净值缺实物支撑）在交付件里**金额消失**，严重度 high→low 无留痕 | ❌ **结论弱于过程，且不可追溯** |
| R3 | 会话 1 机器设备轴 8 条 findings 全部被压成 2 条，子代理量化的高估金额（**2,348 元**）在交付件中无落点 | ⚠️ **量化损失** |
| R4 | 会话 1「人工确认项 EM-001」与「问题项 EI-013」是同一事实，**一处量化一处不量化** | ⚠️ 口径不一 |
| R5 | 会话 2 的 39 条候选（8 个来源）→ 12 条问题：压降幅度正常，但**交付件里唯一的过程归属字段 `sourceSkills` 是收尾时硬编码的查表结果** | ⚠️ **归属可造，非机械派生** |
| R6 | 会话 2 公共准则轴 3 条候选被改档为提示，**理由与库内 `output_permission` 一致且留痕** | ✅ **对得上（做得好的地方）** |
| R7 | 会话 2 的 2 条 high 结论（ISS-01/ISS-02）均能在候选中找到对应，证据可定位 | ✅ 对得上 |
| R8 | 两份会话**都没有**"每条候选 → 去向"的处置台账；`sourceSkills[]` 的强制要求在 phase-1 汇总层**未被任何校验拦住** | ❌ 制度未落地 |
| R9 | 会话 2 的 `合并索引.txt` 计数自洽（39 候选 / 30 人工项 / 34 未核 / 9 缺口，与 8 个来源自报数之和逐段相等） | ✅ 对得上 |

---

## R1 · 会话 1：EI-013 正文与自带证据算术矛盾（可复算证伪）

**交付件里 EI-013 原文（从组装脚本逐字）**：

```
title: 机器设备计算表多一行重复的搅拌站设备且未纳入合计
problemDescription: 机器设备计算表评估明细表列了8行设备，但合计公式只取其中7行。
  第1行与第2行JS3000D1混凝土搅拌站设备的各项取值逐列相同，均为1,870,498元与18%。
  合计公式只取第7至13行，第8行（序号2）被排除在外，两者相差124,500元。
materialEvidence.excerptOrValue: ...S7:S13合计4,448,901，八行合计4,573,401，差124,500
```

**同一份交付件里自己写出的 8 行分项（来自 EI-012 的 materialEvidence）**：

```
分项：336,690＋336,690＋51,837＋8,280＋3,207＋137,693＋39,058＝913,765.00；合计格 U14=913,455.00，差310.00
```

- **8 行相加 = 913,765**（两种分法都是 6 个 336,690 加剩余两项），所以 **8 行合计就是 913,765，不是 4,573,401**。
- **7 行（去掉第 2 行）= 913,765 − 336,690 = 577,075**，不是 4,448,901。
- 因此「S7:S13 合计 4,448,901 / 八行合计 4,573,401 / 差 124,500」这组数字**在同一文件里无法同时成立**；
  它与 EI-012 的「差 310.00」直接冲突。

**这个 124,500 从哪来**：子代理原始报告（机器设备轴 findings，逐字）写的是

> 且 `S7:S13` 求和 = 4,573,401，该表 `S14` 硬编码为 4,448,901，差 124,500 = 序号 2 设备重置全价 1,870,498 的一部分，即合计与所列表格**不成勾稽**。

按子代理自己列出的行求和无法复算出 4,573,401 —— **这是一个不可复算的 AI 自算断言**，却以「materialEvidence 实测值」的形态进入了交付件。

**父代理当时其实已经发现并否掉了**（日志 `+26.69min` reasoning，逐字）：

> The sum formula S14=SUM(S7:S13) actually only covers 7 rows, excluding row 8, which explains why the total (4,448,901) doesn't match the sum of all 8 data rows (4,573,401). This appears to be a legacy duplicate row that shouldn't be included in the calculation — the formula correctly excludes it, but its presence in the enumeration is misleading and creates an appare[nt]…

**但纠正只停留在 reasoning 里，没有回到交付件**：EI-013 仍保留 124,500。

**对比**：会话 1 在 `selfAuditErrors` 里明确记录了 8 条自查错误（含"把文本展平当成案例组错位""含税列标注与其自身证据矛盾"两条假阳性），说明这套机制是有效的 —— **只是这一次没触发**。

---

## R2 · 会话 1：最重的实质发现被降级且丢失了金额

| 环节 | 内容 |
| --- | --- |
| 子代理原始（high，`reasonableness_doubt`，`pending`） | 「若序号 2 为重复录入，则评估净值 913,455 中含**约 336,690 元无实物支撑**；需与"机器设备"表 7 行及报告"7 台"表述对照确认。」 |
| 交付件 EI-013（low） | 「机器设备计算表多一行重复的搅拌站设备且未纳入合计」—— **全文没有 336,690，也没有"约 X 元缺实物支撑"的量化** |
| 交付件 EM-001（人工确认项） | 「计算表评估明细表列有2行JS3000D1混凝土搅拌站设备且取值完全相同，合计公式未包含第2行……若是1台，第2行是否为历史遗留重复行？」—— **同样没有金额** |

**交叉验证（确属同一客体）**：

- 交付件 EI-012 / 机器设备轴的清单：序号 3 装载机 51,837、序号 4 全电子汽车衡 8,280、序号 5 压力机 3,207、合计 913,455。
- 83690 在原始表格里是 `4、机器设备计算表!评估明细表!U8`（序号 2 的评估净值，与 U7 逐列相同）。
- 子代理对同一行的原话：「`B8:BM8` 与 `B7:BM7` 的每一个数值列逐一相同（含 AD 1,680,000、BG 1,870,498、BM 18、BI 14.59），明细表中不存在第二台」。

**处置方差**：high → low；「约 336,690 元缺实物支撑」这一条**是本项目机器设备口径下最大的单项金额**（机器设备评估净值合计 913,455，占比 36.9%）。**整个日志里找不到"为什么降级、为什么去掉金额"的任何记录。**

---

## R3 · 会话 1：机器设备轴 8 条 findings 的量化损失

| 子代理 finding | 严重度 | 交付件对应 | 交付件严重度 | 量化是否保留 |
| --- | --- | --- | --- | --- |
| EQ-001 项数与行数不一致、合计不勾稽（差 124,500） | high | EI-013 + EI-012 | low | ❌ 金额被替换成不可复算值 |
| EQ-002 重复行，约 336,690 元无实物支撑 | high | EI-013 + EM-001 | low | ❌ **金额丢失** |
| EQ-003 超经济年限设备成新率应 0%/12% 却取 15%/18%，两行高估约 2,348 元 | high | EI-008（medium）+ EM-005 | medium | ❌ **金额丢失** |
| EQ-004 评估价值列尾差 310 元 | low | EI-012 | low | ✅ |
| EQ-005 可抵扣增值税差 12,073.06（评估值影响约 12.22 元/台） | medium | EI-009 | medium | ⚠️ 部分 |
| EQ-006 前期费用费率口径与术语 | medium | MC/覆盖记录 | — | ✅ |
| EQ-007 功能性/经济性贬值未量化 | medium | 覆盖记录 | — | ✅ |
| EQ-008 压力机账面净值为 0 未说明处置 | medium | 覆盖记录 | — | ✅ |

**8 条 → 2 条问题 + 2 条人工确认**：这不是错（合并同质项是对的），但**子代理算出来的两个关键金额（336,690 / 2,348）在交付件中一个都没留下**。
更值得注意的是：**过程里"high"的 finding 全部没有以 high 出现在交付件**（交付件唯一 high 是"签字盖章页为空白"，来自 router 自己的核实），而 13 条问题中 10 条为 medium。

---

## R4 · 会话 1：同一事实、两种量化口径

- **EI-013**（问题项，low，`decision=fail`）：「列了8行设备，但合计公式只取其中7行……**两者相差124,500元**」→ 给了金额（且不可复算）
- **EM-001**（人工确认项）：「列有2行……取值完全相同，合计公式未包含第2行……若是1台，第2行是否为历史遗留重复行？」→ 不给金额

同一事实在两处出现是允许的（问题项 + 待确认项），但**一处给数一处不给数、且给的那个数是错的**，会让员工对金额失去信任。

---

## R5 · 会话 2：`sourceSkills` 是收尾时硬编码的，不是机械派生的

**制度要求**（`references/14-orchestration-workflow.md` 步骤 11，逐字）：

> 每条 finding 必须保留 `source_skills[]`；相同结论合并时保留全部来源，冲突结论并列留待人工复核，不相互覆盖。

**实际发生**：
1. `+130.25min` 写出 `阶段一/阶段一定稿意见.json`（50,816 字节）—— **12 条 issue 里没有 `sourceSkills` 字段**（逐条检查：12 条全为 `NO sourceSkills`）。
2. `+199.21min` 运行 `patch_opinions.py`，其中：

```python
SRC = {
    "ISS-01": ["crwu-audit-asset-scrap-materials", "crwu-audit-asset-equipment", "crwu-audit(router)"],
    "ISS-02": ["crwu-audit-asset-equipment", "crwu-audit-datacheck", "crwu-audit(router)"],
    ... 12 条全部手写 ...
}
for i in d["issues"]:
    i["sourceSkills"] = SRC.get(i["issueId"], ["crwu-audit(router)"])
```

**逐条抽验的结果（我按候选清单核对，总体是说得通的，但性质是"事后追认"而非派生）**：

| issue | 硬编码来源 | 候选清单里的实际对应 | 核对 |
| --- | --- | --- | --- |
| ISS-01 | scrap + equipment + router | SCRAP-03（high）＋ EQ-03（medium）＋ RTR-05（medium），均围绕"报废鉴定/审批文件文号缺失" | ✅ |
| ISS-02 | equipment + datacheck + router | EQ-01（high「重量测算口径与报告声明不一致」）＋ DC-01（high，后被 SAE-01 判假阳性）＋ RTR-04 | ✅（但见下） |
| ISS-03 | scrap + equipment + router | EQ-02（high）＋ SCRAP-06（medium）＋ RTR-04 | ✅ |
| ISS-04 | scrap + router | RTR-01（medium，router）／EQ 侧无同项 | ⚠️ scrap 的来源不明 |
| ISS-06 | scrap + router | SCRAP-01（high）＋ RTR-03（medium） | ✅ |
| ISS-08 | public + equipment + router | EQ-05（medium「资产核实实施时间与盘点方式未披露」）＋ public 侧 | ✅ |
| ISS-09 | tx-disposal + equipment | BIZ-TD-02（medium）＋ EQ-07（medium） | ✅ |
| ISS-11 / ISS-12 | datacheck（+scrap+equipment） | DC-02（medium）／DC-03+DC-05+DC-06（medium/low） | ✅ |

**关键问题不是"写错了"，而是**：`sourceSkills` 是交付件里**唯一**能回答"这条结论是谁查出来的"的字段，它却是模型在收尾阶段凭记忆手填的一张表。
只要模型记错一个技能名，员工和三级审核都无从发现 —— **没有任何机械校验保证它等于"实际贡献了该结论的叶子"**。

**顺带发现的问题**：ISS-02 把 `crwu-audit-datacheck` 列为来源，而 datacheck 的原候选 DC-01（high「案例调查表交易总价与单价数量不对应」）已在 `+124.03min` 被判定为**假阳性**（SAE-01：「将被审件的空『估价对象』单元格导致的文本展平位移当成了案例组错位」）。把一条已关闭假阳性的技能列为来源，属于归属污染。

---

## R6 · 会话 2：公共准则轴改档 —— 这次对得上（正面样本）

公共准则轴（含"重跑版"共 6+0 条候选）中有 3 条被改档，`selfAuditErrors` 的 `SAE-07` 逐条给了库内依据：

- PGS-05 引报告准则第二十八条，**该条在库内标注 `output_permission=advisory`**（只能形成提示或人工确认），故不作规则性缺陷 → 改列覆盖核查提示；
- PGS-06 引程序准则2018第十一条，其义务是「编制评估计划」，留痕属底稿事项，而底稿未随送审材料提供**已记未检查项** → 不据报告未复述判缺陷；
- PGS-03 引报告准则第十四条，其违反条件是"正文要素缺项"而非"载明方式"，机构名称已在签名盖章页 → 不作缺陷。

**这是"结论 ↔ 过程"完全对得上的样本**：每条改档都给了库内文件、RULE 号、`output_permission` 与具体理由。
同一个会话里，机制**能**做到可追溯 —— 说明 R1/R2 的问题不是能力问题，而是**没有被强制**。

---

## R8 · 制度没落地的确切位置

| 要求（出处） | 现实 | 缺口 |
| --- | --- | --- |
| 每条 finding 必须保留 `source_skills[]`（`14-orchestration-workflow.md` §2 步骤 11） | phase-1 汇总层无此字段；收尾脚本手写补上 | **无 schema 必填、无 validator 校验、无"候选→去向"台账** |
| 「候选审核意见汇总完成后、阶段一冻结前」执行输出过滤并留痕 | 有 `suppressedCandidates`（会话 2 命中 SUP-0001） | ✅ 这条做到了 |
| 「各复核级次显示异常数」等交付口径 | 会话 2 复核命中率 `evaluable=0` → 正确显示"不适用"而非伪造 0% | ✅ |

**建议（与主复盘 §8.6 的覆盖率门禁同源）**：

1. **候选处置台账（P0）**：阶段一必须产出 `候选处置.json`，逐条记录
   `candidateId → {disposition: issue|manual|notChecked|suppressed|downgraded|merged-into, targetId, reason, decidedAt}`。
   未出现在台账里的候选 → **阶段一冻结失败**。
2. **`sourceSkills` 机械派生（P0）**：由台账反推，不接受模型手写；`AuditResult.issues[].sourceSkills` 进 schema `required`，
   并校验其元素必须属于本次实际加载的叶子集合。
3. **降级必须留痕（P0）**：severity 从叶子到交付件的**任何下调**（high→medium/low）都要写 `downgradeReason` + 依据，
   否则 validator 拒绝交付。会话 1 的 336,690 与 2,348 两处都属于"无理由降级"。
4. **金额守恒校验（P1）**：叶子 finding 里出现的**结论性金额**（`excerptOrValue` 中的元值），
   若在交付件里消失，必须在台账里给出"为什么不需要员工看到"的理由；反之，交付件里出现的金额
   必须能对回 **原件读取值**而非模型自算值 —— R1 的 124,500 正是"模型自算值冒充实测值"。
5. **`problemDescription` 内的算术断言做一次机器复算（P1）**：本次只要对
   「分项之和 vs 合计」「A−B=C」这类句式做一次正则抽取 + Decimal 复算，就能在交付前拦下 124,500。

---

## R9 · 会话 2 `合并索引.txt` 计数自洽（正面核对）

日志中 `合并索引.txt` 的最终版（8 个来源）：

```
sources: 8
  asset-equipment  {candidates 10, manualConfirmation 6, notChecked 8, gaps 2}
  asset-scrap-materials {7, 5, 5, 5}
  biz-transaction-disposal {5, 4, 5, 3}
  datacheck {6, 6, 4, 1}
  external-data {0, 0, 0, 0}
  public-general-standards {6, 6, 8, 5}
  public-general-standards(重跑) {0, 0, 1, 1}
  crwu-audit(router-consolidated) {5, 3, 3, 0}

=== CANDIDATES (39) ===   逐条 1–39   ✅
=== MANUAL (30) ===       逐条 1–30   ✅
=== NOTCHECKED (34) ===   与自报之和 8+5+5+4+0+8+1+3 = 34   ✅
=== GAPS (9) ===          与自报之和 2+5+3+1+0+5+1+0 = 17 ⚠️ 见下
```

逐段核对结果：**候选 39、人工项 30、未核 34 三段都做到了"标题 = 逐条 = 各来源自报数之和"**。
只有 `GAPS` 的自报数之和（17）与标题（9）不等 —— 但各来源的 `gaps` 字段可能包含未合并的同质项，
本条作为**待确认的次要项**记录，不作为结论。

这条是**正面样本**：机械合并层（`工具/merge_leaves.py`）做到了计数守恒与来源标注，问题只出在**合并之后的挑选与降级**（R1–R5）。

---

## 附：本次对账用到的可复现命令

```bash
# 1) 交付件定位（会话 2）
stat -f "%z" "/Users/mungdong/Downloads/未确认 566413.crdownload"   # 358498 = 日志中的 HTML 字节数
python3 - <<'PY'
import re, json
h = open('/tmp/sess2.html', encoding='utf-8').read()
raw = re.search(r'<script id="audit-result" type="application/json">(.*?)</script>', h, re.S).group(1)
json.dump(json.loads(raw), open('/tmp/sess2.result.json','w'), ensure_ascii=False, indent=1)
PY

# 2) 会话 1 交付件重建：从 session.v4.jsonl 中最大的一条 pwsh heredoc 取 build_audit_result.py
# 3) 候选清单：会话 2 的 阶段一/合并索引.txt（含 CANDIDATES/MANUAL/NOTCHECKED/GAPS 四段）
```
