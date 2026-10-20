# 随包 wheel

`manifest.json` 是唯一登记处：模块名、版本、wheel 文件名、字节数、sha256、适用平台。

- `pypdf`：纯 Python，全平台；PDF 文本层读取。
- `pypdfium2`：仅 Windows x64；整页渲染。macOS 不加载第三方原生库（DSH Python 是硬化
  签名运行时），改用系统 CoreGraphics，见技能正文与 `references/02-dependency-and-platform.md`。
- `Pillow`：不随包发布，由 DSH 自带 Python 提供（`runtimeProvided`）。

升级：在源仓运行 `python3 scripts/fetch_wheels.py`，再跑 `scripts/test_ocr_runtime.py`。
不要手工编辑哈希或单独替换某个 wheel；三处（wheel、manifest、变更说明）必须同批更新。
