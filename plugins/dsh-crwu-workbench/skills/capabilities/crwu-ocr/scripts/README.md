# crwu-ocr 脚本

| 脚本 | 作用 | 调用方 |
| --- | --- | --- |
| `ocr_prepare.py` | 渲染 PDF 页 / 规范化图片，提取文本层，写 `ocr/index.json` | 审核流程（步骤 11/12 前） |
| `ocr_record.py` | 合并逐页识别结果，绑定页图 sha256，更新覆盖 | 每批页图判读之后 |
| `ocr_merge.py` | 按页序合并成 `ocr/merged/<sourceId>.txt`（未判读页显式占位） | 全部页记录之后 |
| `ocr_status.py` | 报告 `pending / unreadable / conflictPages / budgetExhausted / notVerified` | 汇总与交付前 |
| `ocr_bench.py` | **维护工具**：对照人工基准算关键字段准确率、静默错误率、表格单元格准确率（审核链路不调用、不暂存） | 维护者 |
| `ocr_runtime.py` | 随包依赖校验/解包、文本与数值规范化、JSON 与路径工具 | 上述脚本导入 |
| `ocr_engines.py` | 渲染引擎选择：pypdfium2 优先，macOS 回退 CoreGraphics | `ocr_prepare.py` |
| `ocr_quartz.py` | macOS 系统 CoreGraphics 整页 RGB 渲染 | `ocr_engines.py` |
| `fetch_wheels.py` | **维护工具**：下载并登记随包 wheel（审核链路不调用） | 维护者 |
| `test_ocr_runtime.py` | 依赖校验、路径安全、清单一致性 | 门禁 |
| `test_ocr_flow.py` | 合成 PDF/图片的 prepare → record → merge → status 全链路 | 门禁 |
| `test_ocr_bench.py` | 评测指标（准确率 / 静默错误率 / 表格逐格） | 门禁 |

## 运行

审核内统一经 `crwu_run_python_script`，脚本由 Host 暂存到 `<案例>/ocr-skill/scripts/`：

```text
ocr-skill/scripts/ocr_prepare.py --case <案例目录>
ocr-skill/scripts/ocr_record.py   --case <案例目录> --input ocr/recognition-input.json
ocr-skill/scripts/ocr_merge.py    --case <案例目录>
ocr-skill/scripts/ocr_status.py   --case <案例目录>
```

开发/C 门禁直接跑（用 DSH 自带 Python，需含 Pillow）：

```bash
<python> scripts/test_ocr_runtime.py
<python> scripts/test_ocr_flow.py
```

Linux 上没有 macOS CoreGraphics 与 Windows pypdfium2 wheel，渲染用例会 `skip`；
这不是通过证据。macOS 与 Windows 各自实际渲染一次才算验证过。

## 维护

- 改字段形状：同批改 `schemas/`、`references/01-execution-contract.md`、脚本与测试；
- 升级依赖：`python3 scripts/fetch_wheels.py`，再跑 `test_ocr_runtime.py`；
- 不要把真实证件/材料放进测试；测试只用脚本内生成的合成 PDF/图片。
