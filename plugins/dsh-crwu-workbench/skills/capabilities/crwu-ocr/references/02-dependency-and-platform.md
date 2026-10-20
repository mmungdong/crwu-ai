# 02 依赖与平台

本技能随插件发布，员工装完插件即可运行；**不在审核过程中安装任何依赖**，也不修改 DSH
自带 Python 的安装目录。

## 1. 随包内容

| 路径 | 内容 |
| --- | --- |
| `vendor/wheels/manifest.json` | 依赖清单：模块名、版本、wheel 文件名、字节数、sha256、适用平台 |
| `vendor/wheels/pypdf-*.whl` | 纯 Python 的 PDF 文本层读取库（全平台） |
| `vendor/wheels/pypdfium2-*-win_amd64.whl` | Windows 原生 PDF 渲染库 |
| `vendor/wheels/README.md` | 升级与校验说明 |

`Pillow` 由 DSH 自带运行时提供（`runtimeProvided`），不重复随包发布：DSH 的 Python 发行版
本身包含 Pillow，而 macOS 上第三方原生轮子无法被硬化签名的运行时加载（见 §2）。

## 2. 平台选择

| 平台 | 文本层 | 页面渲染 | 图片规范化 | 说明 |
| --- | --- | --- | --- | --- |
| Windows x64 | `pypdf`（随包） | `pypdfium2`（随包 wheel） | DSH Pillow | 解包到案例内缓存后加入 `sys.path` |
| macOS arm64/x64 | `pypdf`（随包） | 系统 CoreGraphics（`ocr_quartz.py`） | DSH Pillow | 不需要下载，不加载第三方原生库 |
| 其它 | 若运行时已有 `pypdf` 才能读 | 无 | 若运行时已有 Pillow | 记 `capability-gap`，不猜 |

### 为什么 macOS 不用随包 pypdfium2

DSH 自带 Python 是 Developer ID 签名并启用 hardened runtime 的进程。macOS 的 library
validation 只允许加载 Apple 或**同一 Team ID** 签名的动态库；随包 wheel 里的
`libpdfium.dylib` 是 adhoc/linker-signed，加载会被系统拒绝：

```text
code signature ... not valid for use in process:
mapping process and mapped file (non-platform) have different Team IDs
```

这不是某一台机器的配置问题，而是所有安装该 DSH 构建的员工机器共有的运行时约束。
插件不能重签 DSH 运行时，也没有可用于重签的证书。因此 macOS 的页面渲染改用系统
CoreGraphics（`/System/Library/Frameworks/CoreGraphics.framework`，Apple 签名）：
只做"页数 + 整页 RGBA 像素"，PNG 编码与图片处理仍走 Pillow。

如果将来的 DSH 运行时**自带** pypdfium2（由部署方签进运行时），`ocr_engines.py` 会优先
使用它，不再走 CoreGraphics；此时索引里的 `render.engine` 会变成 `pdfium@…`，缓存键随之变化。

## 3. 校验与加载顺序

1. `ocr_runtime.ensure_dependencies()` 先按平台挑出适用 wheel；
2. 逐件核对字节数与 sha256，不符即 `deps-integrity`，**不继续**；
3. 若同名模块已能导入（DSH 运行时自带），优先用运行时的那一份，不重复解包；
4. 解包到 `<案例>/ocr/.deps/<manifestDigest 前 16 位>/`，写 marker 后加入 `sys.path`；
5. 逐模块导入并记录版本；导入失败按 `deps-import` / `deps-signature` 如实返回；
6. `Pillow` 必须能从 DSH 运行时导入，否则 `runtime-package-missing`，不静默跳过。

wheel 解包拒绝绝对路径、`..` 段与盘符，避免 zip slip。

## 4. 升级依赖

维护者在源仓执行（**不是**审核运行时）：

```bash
python3 scripts/fetch_wheels.py --dry-run   # 查看将下载的版本与平台
python3 scripts/fetch_wheels.py             # 下载、校验、重写 manifest.json
python3 scripts/test_ocr_runtime.py         # 校验清单与字节/哈希一致
```

`fetch_wheels.py` 固定版本号，下载后按实际 wheel 重算 sha256 与字节数；升级必须在
变更说明里写清平台、版本与验证结果（macOS 实际渲染 + Windows 实际渲染各一次）。
不要手工编辑 `manifest.json` 的哈希。

## 5. 能力缺口口径

- 缺清单 / 缺 wheel / 哈希不符：插件包不完整，让员工重装或让部署方修包；
- 平台没有渲染通道：只能在受支持平台运行，或让部署方随 DSH 运行时提供渲染库；
- DSH 运行时缺 Pillow：部署侧补齐；
- 以上都**不允许**在审核中 `pip install`、换系统解释器或改 `PATH`。
