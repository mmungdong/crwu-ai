# 估值体验逐页截图证据（2026-10-23）

这些截图由 **真实 React 组件 + 真实样式表** 生成，不是手写 HTML 仿制页：

1. `install/valuation-experience-preview.mjs --out <新目录>` 用仓库现有轻量渲染器把页面展开为 DOM；
2. Microsoft Edge（macOS，headless）按固定视口截图。

生成命令：

```bash
cd plugins/dsh-crwu-workbench
node install/valuation-experience-preview.mjs --out /tmp/ve-preview
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
  --user-data-dir=/tmp/crwu-edge --window-size=1440,1000 --virtual-time-budget=2500 \
  --screenshot=/tmp/ve-preview/01-overview.png file:///tmp/ve-preview/01-overview.html
```

## 页面

| 文件 | 页面 | 视口 | 主题 |
| --- | --- | --- | --- |
| `01-overview.png` | 资产评估总览（空项目） | 1440×1000 | 浅色 |
| `02-intake-object.png` | 01 估值 · 选择对象 | 1440×1000 | 浅色 |
| `03-intake-info-demo.png` | 资料与信息（显式载入示例） | 1440×1000 | 浅色 |
| `04-intake-review-conflict.png` | 核对提交（面积冲突已处理） | 1440×1000 | 浅色 |
| `05-workspace-docs.png` | 六步工作面 · 资料与模板 | 1440×1000 | 浅色 |
| `06-workspace-check.png` | 六步工作面 · 信息核对 | 1440×1000 | 深色 |
| `07-workspace-reasoning.png` | 六步工作面 · 方案推理 | 1440×1000 | 浅色 |
| `08-workspace-confirm.png` | 六步工作面 · 方案确认 | 1440×1000 | 浅色 |
| `09-workspace-cases.png` | 六步工作面 · 案例获取 | 1440×1000 | 浅色 |
| `10-workspace-case-check.png` | 六步工作面 · 案例核对 | 1440×1000 | 浅色 |
| `11-workspace-narrow.png` | 900px 面板 · 资料与模板 | 900×1000 | 浅色 |
| `12-intake-info-narrow.png` | 600px 面板 · 资料与信息（单列布局） | 600×900 | 浅色 |

## 旧浏览器脚本

`install/ui-browser-check.mjs` 的估值段落原本检查旧输入页与旧图工作面。检测到新体验根
（`.ve-experience-root`）时，该段落只记录一条“已随新体验退役”的通过项，不再对新页面跑旧断言；
新页面的逐页证据以本目录和 `install/valuation-experience-preview.mjs` 为准。

## 边界

- Host 与文件选择是**内存假端口**；示例项目、资料、案例均为虚构演示数据，页面顶部与表格明确标注。
- 没有读取真实文件、没有 OCR、没有联网、没有执行真实模板重算，也没有生成金额结论。
- 截图仅验证 macOS + Edge headless；Windows 与真实 DSH profile 未验收。Edge 在本机退出阶段偶发
  segfault（截图已写出）；这是浏览器进程退出问题，不是页面运行错误。
