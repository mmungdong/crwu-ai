# 审核 OCR 覆盖率门禁设计

- 日期：2026-10-22
- 状态：**历史快照** · 已实现（0.0.45）。实现口径以代码、`CHANGELOG.md` 与技能 references 为准；
  §9 的“待实现”与 §10 的“200 页”是当时的计划口径，当前实现是 5000 页与已落地门禁。
- 范围：`crwu-audit` 材料准备与交付校验、`crwu-ocr` 覆盖率产出、插件级 Python 依赖分发
- 前序：`2026-10-20-audit-ocr-fallback-design.md`（兜底链）、`2026-10-21-crwu-ocr-quality-design.md`（判读质量）。本设计**不改变**二者的判读契约，只补"覆盖率如何计算、如何阻断交付"。

## 1. 背景

### 1.1 事故（真实会话 `la-1792650417169-c1024edd`，2026-10-22）

一次本地审核交付了 54 条"未审核"，其中 34 条属于**已读未落盘**：

| 事实 | 证据 |
| --- | --- |
| 材料盘点把所有 28 个 PDF 记成 `pypdf-error`，`pageCount: 0` | `材料盘点.json` 的 `ocrRequired[]`，`reason` 全为 `pypdf-error` |
| DSH 自带 Python 无 `pypdf` | `dependencyGaps[].detail`：`ModuleNotFoundError: No module named 'pypdf'` |
| 子代理读完 32 张照片后被父会话 `interrupt_agent` 终止（仅运行 2 分 24 秒），从未调用 `ocr_record.py` | 子会话 `turn/end reason.kind = aborted/parent`；其工具调用中没有 `ocr_record` |
| 1171 页扫描件（17 份工商资料 + 1 份尽调）从未进入 `ocr_prepare` | 全会话无对应 `--only` 调用 |
| 交付时"可读性"由模型临时写的 `done >= total` 规则折算，一度把已读完的 45 页判成未核 | 父会话 `build.py` 的 `ocr_progress()` 及其后续修改 |

### 1.2 结论

- 丢失不是"读不出来"，而是**流程时序**：渲染与识别分离，识别结果只在 `ocr_record.py` 落盘；子任务被终止时，已读证据随上下文一起消失。
- 覆盖率判定是**模型即席实现**的，不同会话会写出不同口径。
- `pypdf` 缺失把整类 PDF 推入视觉通道，掩盖了"哪些 PDF 本来就能读文本"。

### 1.3 目标

1. **已读必落盘**：任何批次的判读结果在上下文丢失前已经写入 `ocr/recognition/`。
2. **文本通道优先**：缺 `pypdf` 时自动启用随包 wheel，不再把全部 PDF 判成需 OCR。
3. **覆盖率可复现**：判定是纯函数输出，模型只消费事实、不自拟规则。
4. **门禁可执行**：交付校验直接读快照，不一致即失败。

### 1.4 非目标

- 不引入本地 OCR 引擎；识别仍由会话模型的页图判读完成。
- 不改变"未核 ≠ 缺失"的既有口径，只把"未核"变成有据可查的状态。
- 不实现沙箱 runner 的 fail-closed / 降级通道（另案决策）。
- 不改 `crwu_run_python_script` 的沙箱策略。

## 2. 依赖分发（pypdf 兜底）

### 2.1 布局决策：统一清单 + 各技能自带副本

- **唯一事实源**：插件级 `vendor/manifest.json`，登记包名、版本、wheel 文件名、sha256、`platforms`。
- **各技能自带**：技能目录下 `vendor/needs.json` 只声明需要的包名；`vendor/wheels/` 由构建期脚本从插件级源复制而来，不在源码里手写第二份版本号。
- **不做运行期跨技能引用**：DSH 把每个技能层注册为独立根，`crwu-audit` 不能假设 `../capabilities/crwu-ocr/vendor` 存在；且单技能复制后必须仍可用。

`npm run skills:vendor` 执行复制，`npm run skills:vendor -- --check` 校验 sha256 一致、无孤儿文件；`pack:assert` 增加新路径。

### 2.2 运行期解析顺序

`prepare_materials.py` 按下述顺序定位随包依赖，模型**不提交**任何路径：

1. `--vendor <dir>`（维护/测试用，不进审核提示词）；
2. `<案例>/scripts/runtime.json` 的 `pythonVendor` 绝对路径 —— Host 在**首次执行审核脚本**时写入：`crwu_run_python_script` 认出 `scripts/<name>.py` 后建目录并写该文件（与 `ocr-skill` 的 `runtime.json` 同一口径：只记位置，wheel 不落案例）；
3. 都拿不到 → 按现状记 `dependencyGaps`，PDF 进 `ocrRequired[]`（保留旧的降级行为）。

**不猜技能目录**：脚本从技能目录直接运行时没有案例上下文，静默使用安装包里的 wheel 会让"缺依赖"的契约测试失效，也掩盖部署问题。

校验与加载：`pypdf` 是纯 Python 包，**校验 sha256 后直接把 wheel 路径插入 `sys.path`**（zipimport），不解包、不装进 DSH 运行时。`crwu-ocr` 的 `ensure_dependencies` 走解包（因为它有原生包 pypdfium2），两者不共用实现。

### 2.3 盘点产物变化

- `pypdf` 可用时：`ocrRequired[]` 条目带真实 `pageCount` 与 `emptyPages`，`reason` 回到 `no-text-layer` / `empty-pages` / `encrypted` / `pypdf-error` 的准确语义。
- `pypdf` 不可用时：维持现有 `pypdf-error`，并在盘点顶层写 `vendoredPython`（`activated` / `wheel` / `source` / `reason`），明确"本轮 PDF 全部未经文本通道判定"，供交付披露。

## 3. 覆盖率快照

### 3.1 产出

新增 `crwu-ocr/scripts/ocr_coverage.py`（纯函数 + CLI），输入 `ocr/index.json` 与 `ocr/recognition/*.json`，输出 `ocr/coverage.json`。

不新增 Host Tool，不改变 `ocr_prepare/record/merge/status` 的接口。

### 3.2 契约

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T09:00:00Z",
  "indexDigest": "<规范化 ocr/index.json 的 sha256>",
  "budget": { "maxVisualPages": 200, "used": 143, "allocateOrder": ["报告", "审批备案", "权证", "车辆", "工商历史"] },
  "sources": [
    { "relativePath": "材料-源/…/行驶证.pdf", "kind": "pdf",
      "required": 26, "recognized": 25, "unreadable": 1, "pending": 0,
      "verdict": "partial", "reasonCode": "page-unreadable" }
  ],
  "totals": { "required": 56, "recognized": 45, "unreadable": 1, "pending": 10,
              "complete": 3, "partial": 2, "pending": 1, "skippedBudget": 0 },
  "gate": { "status": "pass", "blocks": [] }
}
```

页级状态来自 `index.json` 的 `visualStatus` 与识别记录；**只有记录里有 `status` 的页才算已判读**，页图存在不算。

### 3.3 verdict 规则（唯一口径）

| verdict | 条件 | 交付口径 |
| --- | --- | --- |
| `complete` | 全部 `required` 页 `recognized` | 已审核 |
| `partial` | `recognized + unreadable = required`，无 `pending` | 已审核（逐页登记不可读页） |
| `pending` | 存在 `pending` 页 | 未核，必须进 `notCheckedItems` |
| `skippedBudget` | 超出视觉预算，整份未判读 | 未核，必须进 `notCheckedItems` 并给 `requiredAction` |

`unreadable` 页计入"已判读但不可读"，不进 `complete`；一份来源只要还有 `pending` 页，整份即 `pending`（不按比例折算）。

## 4. 预算：5000 页才叫异常

### 4.1 实测成本（本机 2026-10-22，144 DPI）

| 项 | 实测 / 反推 |
| --- | --- |
| 渲染 | 91 ms/页（200 页 18.19 s）；5000 页 ≈ **7.6 分钟** |
| 磁盘 | 1.24 MB/页；5000 页 ≈ **6.1 GB** |
| 读图 | 现场 34 张 / 144 s ≈ 4.2 s/页（含推理），并行读约 2 s → 5000 页 ≈ **2.8–5.8 小时** |
| 上下文 | 1M 窗口；单页 2556 token（28px patch）→ 单批最多约 410 页；5000 页累计 12.8M token，**必须分批、上下文复用** |
| 单次 `ocr_prepare` 上限 | 脚本超时 600 s → 144 DPI 约 6600 页、200 DPI 约 3300 页 |

### 4.2 规则

- **拒绝阈值 `maxVisualPages = 5000`**（部署配置，默认 5000）。这是**异常量级**判据，不是"读不完"的挡箭牌：生产级审核页多是常态，只有本轮必须判读的页数超过 5000 才整批拒绝。
- **5000 以内不得以"页多"为由放弃**：必须读完；可以跨轮次续跑，`ocr_status.py` 的 `pending` 就是续跑入口，`ocr_record` 幂等。
- 拒绝时的终态是 `budget-refused:excessive`，整批不判读，逐条进 `notCheckedItems`，并给员工可执行动作：**分批送审**或**提供文本版**（不要把"页多"写成"材料缺失"）。
- 操作约束（**不构成拒绝理由**，只影响怎么跑）：
  1. 渲染**按文件分批**，单批 ≤ 3000 页，给 200 DPI 与 10 分钟超时留余量；
  2. 开跑前检查磁盘（按 1.24 MB/页估算），不足则先清理或分批；
  3. 每完成约 500 页汇报一次"已记录 / 剩余 / 预计耗时"；
  4. 读图节奏 8–10 页/批（见 §5）。
- 不再按 200 页做"整份 skippedBudget"的分配：那是上一版的保守假设，与本项目"生产级审核"的定位不符。

按本案例口径（1171 页）：远低于 5000，**必须读完**——尽调 85 页 + 车辆 18 页 + 照片证照 34 页 + 工商资料 1086 页全部在阈值内，按文件分批渲染即可。

## 5. 分批落盘与委派粒度

- 判读方（主会话或子代理）每完成 **8–10 页**就把结果写成 `ocr/recognition-input-N.json` 并调 `ocr_record.py`；不得攒到全部读完再写。记录幂等，重跑只覆盖同一页。
- **单个子代理最多 12 页**（按来源切分，不按页切同一份文件）；超了就拆多个。这样"读完全部再写"的窗口天然被压到 ≤12 页。
- 父会话终止子代理前，先 `send_message` 要求"把已读页立即落盘并回报页码"，收到确认或等待 60 秒后再 `interrupt_agent`。
- **消除终止动机**：父会话当初终止子代理，是为了"交付件与案例目录一致"。记录幂等且覆盖率快照在交付前重算，晚落盘不会破坏已冻结的交付件——没有落盘才是不可恢复的损失。
- 规则落在**两处**：Host 生成的审核提示词（`ocrSection()`，父会话必读，决定它怎么写任务书）+ `references/14-orchestration-workflow.md` §1.3（权威口径）。不由脚本强制（脚本只负责幂等记录）。

## 6. 交付门禁

`audit_delivery.py validate` 新增可选 `--case <dir>`：

1. 读 `ocr/coverage.json`，校验 `indexDigest` 与当前 `ocr/index.json` 一致；过期即失败。
2. `scope.inputs[].readable` 必须与 verdict 一致：`complete` / `partial` → `true`；`pending` / `skippedBudget` → `false`。
3. 每个 `pending` / `skippedBudget` 来源都必须出现在 `scope.notCheckedItems`（按规范化路径对账），否则失败并列出缺失项。
4. `render` 同样执行上述校验（不接受绕过 `validate` 直接渲染）。

边界：`ocrRequired[]` 为空且案例下无 `ocr/` 目录时，视为"本轮无需 OCR"，`validate` 放行并记 `coverage.status = "not-required"`；其余情况一律要求快照存在。

快照由编排层在**交付前**运行 `ocr_coverage.py` 产生；`14-orchestration-workflow.md` 的冻结步骤负责保证它在阶段一定稿前已经落盘。

发布侧（OSS / 钉钉归档 / 本地面板）在打包上传前校验 `coverage.json` 存在、`indexDigest` 匹配且 `gate.status == "pass"`，避免绕过 `validate` 直接送件。

## 7. 变更清单

| 文件 | 变更 |
| --- | --- |
| `skills/crwu/crwu-audit/vendor/wheels/`（新） | `pypdf` 副本 + `manifest.json`（与 `crwu-ocr` 逐字节同版本） |
| `scripts/check-vendor-sync.mjs`（新） | 断言两个技能的同名依赖版本/wheel/sha256 一致；`npm run vendor:check` |
| `src/host/domains/report-audit/audit-scripts.ts`（新） | 认 `scripts/<name>.py`、生成 `runtime.json`（只记 wheel 绝对路径） |
| `src/host/tools/common/python-script.ts` | 执行审核脚本前写 `<案例>/scripts/runtime.json`；`check()` 带会话策略 |
| `skills/crwu/crwu-audit/scripts/prepare_materials.py` | `--vendor` / `runtime.json` 解析、sha256 校验后 zipimport、盘点写 `vendoredPython` |
| `skills/capabilities/crwu-ocr/scripts/ocr_coverage.py`（新） | 覆盖率纯函数 + CLI |
| `skills/crwu/crwu-audit/scripts/audit_delivery.py` | `validate --case`、`render` 前置门禁 |
| `skills/crwu/crwu-audit/references/00、14` | verdict 表、预算、分批落盘、子代理终止协议 |
| `scripts/assert-pack.mjs`、`package.json` | 新路径断言与 `vendor:check` 脚本 |

## 8. 测试

纯函数与契约优先，全部可在无真机材料的情况下跑：

1. `ocr_coverage`：四类 verdict 的边界（含 26 页中 1 页 `unreadable` 判 `partial`）、预算边界（刚好等于、超出 1 页）、`indexDigest` 过期。
2. `test_prepare_materials_deps.py`（已落地）：不猜技能目录、`--vendor` 恢复文本通道、篡改 wheel 被拒。**门禁用 `python3` 与 `$(DSH_PYTHON)` 各跑一次**——DSH 自带 Python 没有 pypdf，这是唯一能证明"文本通道在真实运行时成立"的解释器（此前的门禁只有系统 `python3`，那条路径从未被真实覆盖）。
3. `audit_delivery validate --case`：`readable` 与 verdict 冲突、`notCheckedItems` 漏项、digest 过期三种失败。
4. `vendor:check`：两个技能同名依赖的版本/wheel/sha256 不一致、孤儿 wheel、文件被篡改。
5. 现有 OCR 流程测试（`test_ocr_flow.py`）与 `test_prepare_materials.py` 保持通过。

## 9. 分期

| 期 | 内容 | 状态 |
| --- | --- | --- |
| P0 | `crwu_run_python_script` 探测带调用方会话策略 + 报错文案纠偏 | **已实现**（2026-10-22，`make plugin-check` 通过） |
| P1 | §2 依赖分发 + pypdf 兜底 + 门禁在无 pypdf 运行时上跑一次 | **已实现**（含 `test_prepare_materials_deps.py`、`vendor:check`） |
| P2 | §5 分批落盘 + 委派粒度 + 终止协议 + §4 页数阈值 | **已落地为提示词与参考口径**（`ocrSection()`、`references/14` §1.3、`crwu-ocr/SKILL.md`） |
| P3 | §3/§4/§6 覆盖率快照与交付门禁 | 待实现（依赖 P1 的真实 `pageCount`） |

P0–P2 已上线；P3 是把 P2 的"纪律"变成"门禁"的那一期——`pending` 未清零且未登记就不许渲染 HTML。

## 10. 风险

> 历史口径：本节“默认 200 页”已被 5000 页取代（见 CHANGELOG 0.0.45）。

- **门禁误阻断**：`partial` 误判会让本可交付的报告无法出稿。缓解：`partial` 明确视为已审核；仅 `pending` / `skippedBudget` 阻断，且阻断原因逐条可读。
- **运行时依赖注入的兼容性**：`sys.path` 注入 wheel 在硬化签名运行时上只对纯 Python 包成立（macOS 已验证）；原生包仍走 `ocr_engines` 的既有通道。
- **预算默认值**：200 页是运行预算而非业务规则，部署可改；改动需同步文档与测试。
- **与知识库口径的关系**：预算与 verdict 属执行能力约束，不写入知识库规则正文。
