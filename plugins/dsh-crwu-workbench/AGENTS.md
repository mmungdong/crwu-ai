# AGENTS.md

本仓库是一个 **DeepSeek Harness（DSH）插件**。所有代码、目录、测试和发布改动都必须遵守 DSH 的插件装配、Host/Client 分层、Cordis 生命周期与浏览器模块规范。不能把它当作普通 Node.js 网站或独立 React 应用处理。

## 1. 形态与修改原则

仓库只有**一条形态**：`src/` 是唯一源码，由 tsdown 打包成 `lib/index.js` 与 `lib/client.js`，
按 DSH **包插件**分发（npm / tarball / git）。

- 源码改动一律进 `src/`；`lib/` 是产物，**不要手改**（`npm run build` 会覆盖）。
- 交付形状由 `package.json` 的 `exports` / `files` / `dsh.client` 决定，改它们必须跑 `npm run pack:assert`。
- 2026-09-20 收尾时删掉了并存的动态 Cordis 形态（原先的 `legacy/host.js` + `legacy/client.js`，
  沙箱函数体、由 `cordis_define` 装配）。**不会**再由 `lib/` 生成那条形态：产物形状与注册方式都不同
  （见 `README.md` 第一节与 `PORTING.md`）。历史记录保留在 `PORTING.md`。

## 2. 目标目录结构

```text
src/
├── index.ts                         # Host 入口，只做导出和装配
├── host/
│   ├── apply.ts                     # Host 功能总装配
│   ├── config/
│   │   ├── config.ts                # Config 类型与 Schema
│   │   └── consts.ts                # 配置默认值与固定协议常量
│   ├── http/
│   │   ├── route.ts                 # 同源 HTTP 路由
│   │   ├── json.ts                  # 请求与响应处理
│   │   ├── types.ts
│   │   └── consts.ts
│   ├── environment/
│   │   ├── service.ts
│   │   ├── types.ts
│   │   └── consts.ts
│   ├── h3yun/
│   │   ├── records.ts
│   │   ├── mapper.ts
│   │   ├── types.ts
│   │   └── consts.ts
│   ├── audit/
│   │   ├── service.ts
│   │   ├── prompt.ts
│   │   ├── state.ts
│   │   ├── types.ts
│   │   └── consts.ts
│   ├── oss/
│   │   ├── service.ts
│   │   ├── parser.ts
│   │   ├── result-info.ts
│   │   ├── types.ts
│   │   └── consts.ts
│   └── workspace/
│       ├── service.ts
│       ├── types.ts
│       └── consts.ts
├── client/
│   ├── index.ts                     # Client 入口，只注册插件能力
│   ├── apply.ts                     # Client 槽位总装配
│   ├── api/
│   │   ├── client.ts
│   │   ├── types.ts
│   │   └── consts.ts
│   ├── features/
│   │   ├── environment/
│   │   └── report-audit/
│   │       ├── ReportAuditPage.tsx
│   │       ├── ReportTable.tsx
│   │       ├── AuditResultTable.tsx
│   │       ├── AuditInfoDrawer.tsx
│   │       ├── state.ts
│   │       ├── types.ts
│   │       ├── consts.ts
│   │       └── report-audit.module.css
│   ├── components/                  # 仅放跨 feature 复用的展示组件
│   ├── locales/
│   │   └── zh-CN.ts                 # 用户可见中文文案
│   └── styles/
│       └── workbench.module.css
└── shared/
    ├── types.ts                     # Host 与 Client 都需要的线协议类型
    ├── consts.ts                    # 真正跨域的协议常量
    └── utils/                       # 无 Node/DOM 依赖的纯函数

tests/
├── unit/                            # 配置、同源路由、操作表、包清单，以及 Host 与 Client 半
└── helpers/                         # TSX 加载器 + 注入式渲染器
```

目录按业务能力划分，不按“所有 hooks”“所有 helpers”这类技术类别堆放。一个模块只负责一个明确领域。

## 3. 常量、类型和工具

- 常量不得散落在功能代码中。一个目录使用的常量统一放在该目录的 `consts.ts`。
- 只有多个 Host/Client 领域都使用的协议常量，才允许放入 `src/shared/consts.ts`。
- 不建立无边界的全局 `utils.ts`。工具函数按用途放入具名文件，例如 `date.ts`、`json.ts`、`fingerprint.ts`。
- 仓库级工具脚本放 `scripts/`（如 `sync-version.mjs`、`assert-pack.mjs`）；`install/` 只放交付相关的校验与安装件。
- 类型放在领域自己的 `types.ts`；跨 Host/Client 传输的类型放在 `src/shared/types.ts`。
- 部署可变的值必须进入 `Config` 和 `cordis.patch.yml`，不能伪装成 `DEFAULT_*` 常量写死在功能代码中。
- 固定路由、字段代码、协议版本、状态枚举等不可配置的协议值可以进入 `consts.ts`。

## 4. DSH 插件规范

### 4.1 包与入口

- 使用 ESM；相对 TypeScript 导入带 `.ts` / `.tsx` 后缀。
- 函数插件使用命名导出：`name`、`inject`、`Config`、`apply`，不要增加默认导出。
- `src/index.ts` 和 `src/client/index.ts` 必须保持轻薄，不在入口文件堆业务实现。
- `package.json` 必须保留 `.`、`./client`、`./package.json` 导出以及 `dsh.client` 声明。
- Host 与 Client 分别构建，最终产物仍为 `lib/index.js` 和 `lib/client.js`。源码拆分不会改变 DSH 的加载入口。

### 4.1.1 加载契约（改 tsdown / 依赖前必读）

三条**静态可查**的硬约束，`npm run pack:assert` 会强制（都是对照已安装的 DSH 与它自带的客户端包
实测得到的，不是推测）：

1. 客户端产物必须是 `window.__ModuleLoader__.load({ id, factory })`，且 `id` 等于包名 —— DSH 的
   web 端按这个 id 认模块；
2. 客户端产物的 `require(...)` **只能**出现 `react` 与 `react/jsx-runtime`。DSH 的模块表保证提供
   这两个；其它任何 require 都要求模块表里有对应条目，而插件无法保证 —— 所以 `dsh.client.inject`
   里声明的包只用于**激活顺序**，不能用来 require；
3. Host 产物是 ESM，必须导出 `name` / `inject` / `apply` / `Config` —— 与 `@deepseek-ai/dsh-tool-bash`
   的导出集完全一致；`apply` 以**位置参数**接收 config（`function apply(ctx, config = {})`）。

### 4.1.2 生命周期归属（照 DSH 自带插件抄，不要自己想）

| 副作用 | 正确写法 | 依据 |
|---|---|---|
| 槽位注册 | `ctx.slots.inject(name, () => ctx.slots.register(...))` —— **直接调用，不要再包 `effect`** | 四个自带客户端插件（jobs / goal / skill / plan）都这么写；槽位寿命由 slots 服务自己管 |
| 同源路由 | `ctx.effect(() => ctx.webServer.register(route), label)` | `WebServer.register(route): () => void` 返回 disposer，正好交给 effect |
| 样式 / 定时器 | `ctx.effect(callback, label)` | 插件自己的副作用，必须可释放 |
| 语言包 | `ctx.effect(() => ctx.locale.register(...), label)` | 同自带插件 |

**为什么不能把 `slots.inject` 包进 `effect`**：Cordis 的 `effect` 对回调返回值有类型要求 ——
函数被收集成 disposer，`null`/`undefined` 放过，**其余非空且非 thenable/可迭代的值直接抛
`TypeError("Invalid effect")`**。包错了一层，一旦 `slots.inject` 返回登记对象，
`apply()` 会在**激活阶段**抛错，表现为「插件装上了但面板不出现」。
`tests/unit/client-package.test.mjs` 与 `npm run smoke:built` 都断言了「`inject` 必须在 effect 之外」。

槽位注册的元数据形状（对照 `dsh-client-ui-sidebar` 的读取逻辑）：侧栏用
`resolveSlotLabel(options.label) ?? options.id`，而 `resolveSlotLabel` 对字符串**原样返回**
（对函数则调用）。所以 `label` 直接给中文字符串是正确的，不需要 locale 键。

### 4.2 Cordis 生命周期

- 所有注册、监听器、定时器和资源必须由 `ctx.effect()`、`ctx.on()` 或 DSH 提供的可释放生命周期 API 管理。
- 槽位使用 `ctx.slots.inject(name, () => ctx.slots.register(...))`，不能在模块加载阶段产生注册副作用。
- `inject` 只声明实际读取的服务。少声明会导致插件等待或运行失败，多声明会产生不必要的激活依赖。
- 可选服务通过 `ctx.get(name)` 获取；只有明确注入的服务才通过 `ctx.<service>` 使用。
- 不在模块顶层保存与某个插件实例相关的可变运行状态。状态由 `apply` 创建并随插件生命周期释放。

### 4.3 Host / Client 边界

- Host 承担文件系统、Shell、氚云、OSS、子代理和凭据相关操作。
- Client 只承担浏览器状态、渲染和用户交互，不得导入 `node:*`，不得直接读取本地文件或执行命令。
- Host/Client 通过同源接口和 `src/shared/types.ts` 中的类型通信。
- 同源接口必须校验 HTTP 方法、Origin、请求体大小、操作名和外部输入。
- 任何 OSS Key 都必须限制在配置的前缀内；不得接受任意 Bucket 或任意对象路径。
- Shell 操作必须走 DSH 注入的 Shell 服务，不得使用 `node:child_process` 绕过 DSH 沙箱和授权机制。
- 凭据、Token、AccessKey 和签名 URL 不得写入日志、错误详情、测试快照或前端持久状态。

### 4.4 Client UI

- 使用 DSH 提供的语义颜色变量。接入 DSH 官方 Client 构建预设后使用 CSS Modules；当前包形态骨架若必须保持 `lib/client.js` 单文件交付，样式文本放在 feature 自己的 `consts.ts`，由独立 `styles.ts` 随 Cordis 生命周期安装，不能散落在组件中。
- 用户可见中文文案集中在 `src/client/locales/zh-CN.ts`，组件通过稳定键读取；外部原始数据不做本地化改写。
- 组件状态属于组件，跨组件业务状态放在 feature 的 `state.ts`，不要建立全局万能 Store。
- 页面加载不得按行读取 OSS 文件。报告页只允许一次 OSS 对象列表查询；JSON 和 HTML 必须在用户操作后按精确 Key 懒加载。
- 切换标签页、翻页和本地筛选不得重复执行 OSS 列举；只有首次进入、显式刷新或上传成功后才能刷新对象清单。

### 4.4.1 样式规范（CSS）

这一节里的每条都是踩出来的，不是风格偏好。

1. **类名一律 `crwu-audit-` 前缀**。样式是插件自己往 `document.head` 注入的**全局** `<style>`，
   前缀就是隔离手段：`crwu-audit-root`、`crwu-audit-card`、`crwu-audit-col-seq-no`……
   不许出现 `crwu-wb-` / `crwu-workbench-`（历史前缀，已统一）或任何可能和别的插件撞名的短名。
   - 类名常量集中在 `src/client/features/workbench/consts.ts` 的 `WORKBENCH_CLASSES`，组件只引用常量；
   - 有一条测试断言**每个类名常量都有一条 `.<类名>` 规则**，漏写样式会红；
   - `install/browser-check.mjs` 里有硬编码选择器（`td.crwu-audit-td-nowrap` 等），**改类名必须同步**。
2. **样式载体**：单文件交付（`lib/client.js`）+ `WORKBENCH_STYLE_TEXT` + `styles.ts` 注入
   `<style id="crwu-audit-package-styles" data-plugin="dsh-crwu-workbench">`，寿命由 `ctx.effect` 管。
   **样式文本是模板字符串，注释里也不能出现反引号** —— 一个反引号就会把整段样式截断，而且不报错（踩过两次）。
3. **颜色只用 DSH 主题变量，且必须是 DSH 真正定义过的**：以 `@deepseek-ai/dsh-client-ui-theme` 的
   alias 表为准（`--dsw-alias-bg-layer-1`、`--dsw-alias-border-l1`、`--dsw-alias-label-caption`、
   `--dsw-alias-state-success|error|warn-primary`、`--dsw-alias-button-primary-fill`…）。
   - 未定义的 `var()` 会让**整条声明失效**：卡片没边框、底色透明、页面「很陋」，而控制台**没有任何报错**；
   - 早先用的 `--dsw-alias-bg-secondary` / `-border-secondary` / `-state-warning-primary` 都不存在；
   - 有一条测试扫描硬编码色值（`#hex` / `rgb(` / `hsl(`），改样式前先核对 theme 表。
4. **布局三条**（各自对应一次真实故障）：
   - 面板自身必须是滚动容器：`.crwu-audit-root { height:100%; overflow:auto }` —— DSH 的主内容列
     是 `display:flex; overflow:hidden`，它不滚动、把滚动交给面板；少这两条长页面会被裁一半；
   - 表格用**固定布局 + `colgroup` 百分比列宽**（`.crwu-audit-table` + `.crwu-audit-col-*`）：
     `table-layout: auto` 会把多出来的宽度全给最宽的那一列（实测 1920px 时报告名涨到 696px，
     而操作列几乎不变，右侧一直很挤）；表格另设 `min-width`，**外面必须套
     `.crwu-audit-table-wrap { overflow-x: auto }`**，视口太窄时表内滚动而不是被卡片裁掉；
   - 窄列（流水号 / 风险 / 时间）一律 `white-space: nowrap` 并给 `title`，否则会被从中间折断。

## 5. 代码风格

- TypeScript 开启严格类型检查，不使用无说明的 `any`。外部 JSON 在 Host 入口处解析并收窄。
- 函数保持短小，优先使用提前返回；超过一个领域职责的函数必须拆分。
- 状态使用明确的可判别联合或稳定状态值，避免多个布尔值组合出隐含状态。
- 不吞掉异常。确需忽略时，`catch` 必须命名错误并用中文注释说明为什么可忽略。
- 保留必要的中文注释，重点说明 DSH 生命周期限制、安全约束、并发条件、失败恢复和兼容原因。
- 注释不复述代码，不记录讨论过程，不保留已经失效的方案。
- 文件、函数和变量使用清晰英文命名；面向用户的文案使用中文。
- 文件结尾保留一个换行，提交前执行 `git diff --check`。

## 6. 测试规范

每个行为改动必须先有能失败的测试，再写实现。至少覆盖：

- 纯函数：字段映射、OSS 列表解析、审核结果摘要解析、状态判断。
- Host：同源路由、输入限制、Shell 命令参数、OSS 前缀隔离、错误返回。
- Client：环境硬门禁、标签切换、按钮状态、按需加载、重复点击、空状态和失败恢复。
- 集成：一次 OSS 列举与多条氚云记录合并；点击一条记录只读取一个 JSON；重新审核失败时旧报告仍可打开。
- 交付形状：`lib/` 两个入口能被真正加载（`npm run smoke:built`）、tarball 清单与加载契约（`npm run pack:assert`）。

测试名称描述可观察行为，不描述“实现正确”。测试不得访问真实氚云、真实 OSS、真实凭据或真实用户文件。

**「有能失败的测试」包括：新写的断言必须被证伪过一次。** 临时注入相应缺陷、确认它变红、再还原；
从没红过的断言不算证据。已经踩过的两类假通过：

- **文本包含式断言**：`源码.includes("'sidebar.panellist'")` 会被同一文件里别的同名字面量满足
  （槽位登记对象的 `name` 字段、接口声明、操作名表）。要断言「注册发生了」就解析真正的调用实参；
  要断言「方法存在」就 `import` 真模块查 `typeof`，不要用 `includes` 代替。
- **只断言一半**：门面「声明的操作名」与「真的发出的操作名」是两件事，两条测试分别覆盖才闭合。

**验证缺陷时要还原工作树，不要用 `git checkout <path>`**：本仓大量工作长期处于未提交状态，
`git checkout -- <path>` 会把它退回到 HEAD，直接丢掉成果（第 25 轮就这样丢掉过
`src/client/apply.ts` 里四个槽位的注册）。改造前先 `cp` 一份到 `/tmp`，还原也用 `cp`。

### 6.1 测试怎么摆

```
tests/helpers/tsx-loader.mjs        # 让 node --test 能加载 src 的 .ts/.tsx（含 JSX 转换）
tests/helpers/                      # + 注入式 React 渲染器
tests/unit/                         # 配置 / 路由 / 操作表 / 包清单 + Host 与 Client 半
```

- 测试运行在 `node --test` 上，**不引入 vitest / jsdom / react-dom**：本仓唯一的外部契约是 DSH 本身。
- `tests/unit/` 直接 `await import('./src/xxx.ts')`。本仓要求 `node ^22.19 || >=24`，这条时间线
  原生剥离类型，而 `src/` 不使用 enum / 参数属性 / namespace 这类需要生成的语法，因此**不需要构建步骤**。
- **`src/**.tsx` 也能直接测**：先 `registerTsxLoader()`（`tests/helpers/tsx-loader.mjs`），它用
  `node:module` 的 `registerHooks` 剥类型 + 转 JSX，并把 `react` / `react/jsx-runtime` 指向一个
  极小替身。所以 Client 半**必须有自己的测试**（`tests/unit/client-package.test.mjs`），
  不允许再用「靠别的形态间接覆盖」当理由。
- 该加载器只影响测试进程，不参与交付产物（交付仍由 tsdown 打包）。
- **历史缺陷回归测试不要删**：`tests/unit/` 里那些「曾经真的挂过」的用例是证据，改动实现时不要顺手
  改它们的期望值；要改先想清楚是缺陷复现还是需求变了。

### 6.2 交付形状的护栏

`npm run smoke:built`（`scripts/smoke-built.mjs`）与 `npm run pack:assert`（`scripts/assert-pack.mjs`）
是交付形状的**唯一**机器判据，两者都在 `npm run check` 之外单独存在（`check` 已含 `smoke:built`）：

- `pack:assert` 核对**真实 tarball** 的文件清单与三条加载契约（ModuleLoader id、只 require
  react、Host 导出集）。改 `files` / `exports` / `publishConfig` / 入口时必须跑。
- `smoke:built` 用**真的** `lib/index.js` 走一遍同源路由、用真的 `lib/client.js` 过一遍
  `__ModuleLoader__` 并检查四个槽位注册。改 tsdown / 入口 / 槽位时它最先响。
- 客户端半的**界面**行为（面板是否画出来、切标签是否重复列举 OSS）由
  `install/browser-check.mjs` 在真实浏览器里核对，见 §7。

### 6.3 加新功能 / 改动时，按类型决定测什么

先在下表找到你改的那一类，把「必须补的测试」做掉。第三列是**仓库里已经存在的自动护栏** ——
配套地方忘了改时它会红，照报错改就行；写着「没人拦」的，只能靠你自己写测试，漏了不会有任何提示。

| 改了哪一类 | 必须补的测试 | 忘了会被谁拦住 |
|---|---|---|
| 纯函数 / 解析器（`shared/utils/`、`oss/parse.ts`、`audit/summary.ts`、`environment/version.ts`） | 单元测试，**输入样本用真实数据片段**（把真实 CLI 输出、真实对象片段抄进测试） | 没人拦 |
| **新增 / 改名一个 Host 操作** | 单元测试（行为、参数校验、失败分类） | ① `host-package.test.mjs` 的**冻结操作清单**；② 同文件「操作表 ↔ `ported` 声明一一对应」；③ `client-rpc-facade.test.mjs` 的 missing / extra |
| Host 操作内部逻辑（不增删操作） | 单元测试，含**失败分类**：命令没跑起来 ≠ 命令跑完了 | 没人拦 |
| 同源路由 / 请求校验 | 单元测试（405 / 403 / 404 / 200、体积上限、Origin） | `npm run smoke:built`（真路由） |
| Shell 命令构造（引用、路径、stdout 上限） | 单元测试断言命令字符串（含 Windows 分支） | 没人拦；**必须再真机跑一次对应的只读命令** —— `ossutil` 的 `elapsed` 尾巴就是这类遗漏 |
| 客户端组件 / 状态 | `tests/unit/client-package.test.mjs` 风格的注入式渲染（加载 / 已加载 / 失败 / 卸载后迟到响应） | `client-package.test.mjs` 的槽位清单与 `registered.length === 4`；`smoke:built` |
| **槽位注册 / 样式 / locale** | 同上 + 更新槽位断言 | 同上两条 |
| **新增可见界面行为** | 给 `install/browser-check.mjs` 加一条断言 | 没人拦 —— 不加就永远没人守 |
| 审核生命周期 / 子代理（`host/audit/`） | 单元测试 + `host-audit-spawn.test.mjs` 那套（请求形状对照已安装的 DSH 类型声明） | 没人拦（**真机盲区**）；真机验证只能由用户点「AI 审核」 |
| 状态持久化（`host/state/`） | 单元测试（读-改-写、跨重启恢复、占用锁自愈） | 没人拦；真机前**先备份** `~/.dsh/crwu-workbench.json` |
| **构建 / 交付配置**（tsdown、`package.json` 的 `exports`/`files`/`dsh.client`、`prepare.mjs`、新依赖） | `npm run build` + `smoke:built` + `pack:assert` | `pack:assert`（缺入口 / `require` 只允许 react 与 react/jsx-runtime / ModuleLoader id 必须等于包名）；`host-package.test.mjs`（peer、`dsh.client.inject`、真跑 `npm pack` + `npm install` 的回归） |
| 用户可见文案（UI 中文 / 安装提示词） | **逐条**断言的测试，模板见 `host-install-prompt.test.mjs` | 没人拦 —— 但「意思差不多地改写」真的丢过安全指令 |
| 新增部署可变的值 | 默认值与边界的单元测试，并写进 `Config` / `cordis.patch.yml` | `host-package.test.mjs` 的 config schema 测试 |

**新增一个 Host 操作的最小改动清单**（最容易漏的是 2~4）：

1. `src/host/ops/core.ts` 的操作表加一项；
2. 同一文件的 `boot.ported.done` 加名字（漏了 → 「操作表 ↔ ported 声明一一对应」红）；
3. `tests/unit/host-package.test.mjs` 的 `FROZEN` 清单加名字并改掉数量注释（漏了 → 冻结清单红）；
4. 客户端要调用它 → `src/client/features/report-audit/api.ts` 加门面方法 + `OPERATION_OF`；
   不打算给客户端用 → 加进 `client-rpc-facade.test.mjs` 的 `HOST_ONLY`（漏了 → 双向核对红）；
5. 补单元测试；6. 走 §7 的循环让用户在真机上点一下。

**判断「要不要真机」**：凡是依赖 DSH 交付的服务（`shell` / `fs` / `subagents` / `slots` / `webServer`）
或真实外部行为（真实 CLI、网络、OSS、氚云）的，替身证明不了 —— 必须走 §7。纯函数与文案类改动
不必占用真机时间。

## 7. 本地开发与测试（用户指定的循环，必须照这个顺序）

用户要求的工作方式是：**改 `src/` → 打包 → 装进他的 DSH → 他亲自测 → 他再审代码 → 才提交**。
中间两道人工关卡（他测、他审）**不许跳过、不许替他做判断**。

### 7.1 循环（每一轮都走完）

```bash
# 1. 改 src/（唯一源码；lib/ 是产物，别手改）
# 2. 打包成插件产物
npm run build
# 3. 装进用户的 web profile（首次之后通常不必重复：已经是 link:）
dsh plugin --profile web add .
# 4. 备份真实状态文件（开发版会与正式版共用它，改坏了要能还原）
cp ~/.dsh/crwu-workbench.json /tmp/crwu-state-backup.json
# 5. 请用户重启 web profile —— 这一步 agent 不要自己做（见下）
```

**第 5 步为什么必须由用户做**：agent 这一轮就跑在 `web` profile 的进程里，重启它会把自己打断。
所以 agent 的职责是「build + 确认安装 + 告诉用户重启」，重启后由用户在自己界面上测。

**重启会加载什么**：`web` profile 早已是 `link:` 指向本仓，所以重启读到的就是仓库当前的
`lib/index.js` + `lib/client.js` —— 不需要重装，`npm run build` 之后重启即可。

### 7.2 重启后先确认「新 build 真的生效」

`ping` 的 `rev` 是跟着包版本走的常量（`pkg-0.0.1`），**同一轮开发里两次 build 完全一样**，
光看它分不清新旧。所以 `ping` 另外回一个 `builtAt` = **这份正在运行的代码被加载那一刻**产物的写入时间。

```bash
# token 每次启动会打印在 profile 的启动输出里（也可以直接从浏览器地址栏 ?token= 后面复制）；
# 本机实测它**跨重启保持不变**，所以存一次就能反复用：
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web-3080.log | tail -1 | cut -d= -f2)

curl -s -X POST "http://127.0.0.1:3080/api/crwu-workbench?token=$TOKEN" \
     -H 'Content-Type: application/json' -d '{"op":"ping","args":{}}'
# {"ok":true,"rev":"pkg-0.0.1","at":"…","builtAt":"2026-09-20T11:30:44.653Z"}
```

**面板标题旁就显示这个号**（`crwu-audit-version` 徽章，鼠标悬停看 `builtAt`）：宿主与客户端
分开加载，用户报问题时先说「看见的版本号是多少」，就能立刻分清是「界面是新的、宿主是旧的」
还是两边都新 —— 这个徽章的可见性由 `install/browser-check.mjs` 盯着。

拿 `builtAt` 与 `lib/index.js` 的 mtime 比：

- **相同** → 跑的就是当前产物，可以开始测；
- **不同**（`builtAt` 更早）→ 你还在跑上一份，**忘了重启**；
- `builtAt` 为空串 → 这种形态读不到自己的 mtime，只能靠功能现象判断。

**它必须是模块加载时的常量，不能每次请求现读文件**（第 33 轮实测踩到）：现读的话，「重新 build 了
但忘了重启」时报的是磁盘上新文件的 mtime，看起来像已经生效，而实际跑的还是内存里的旧代码 ——
指纹反而把人骗了。`tests/unit/host-package.test.mjs` 现在断言它是常量（改回函数即红）。

### 7.3 用户测完之后：先跑门禁，再等他审代码

用户说「测试没问题」之后，agent 做的是：

```bash
npm run check        # = version:check + typecheck + test + build + smoke:built
npm run pack:assert  # 改过 files / exports / publishConfig / 入口时必须
git diff --check
```

然后把**改了哪些文件、每处为什么改、验证结果**列清楚，等用户审代码。

### 7.4 两道人工关卡之后的动作边界

| 用户的状态 | agent 可以做的 |
|---|---|
| 还没测 | 只能 build + 装 + 说明这轮改了什么；**不得提交** |
| 测了、说没问题 | 跑门禁；**仍然不得提交**，等他审代码 |
| 审完、说可以 | `git commit`（**不 push**） |
| 明确说「推送 / 发版」 | 才 `git push` / 打 tag / 发布（见 §8） |

> 这条是从用户的原话落下来的：「先改 src → 打包放进我的 dsh → 我测没问题 → 我再审代码 → 没问题再合并」。
> 未经他明确说，**不推送、不发版**。

### 7.5 其他验证手段（按需，不是每轮都跑）

| 手段 | 命令 | 证明什么 |
|---|---|---|
| 单元 / 集成 | `npm test` | `src/` 的逻辑：配置、同源路由、操作表、包清单、Host 与 **Client 半**（含 `.tsx`） |
| 构建产物 | `npm run smoke:built` | 打出来的 `lib/` 真能被加载：真 `lib/index.js` 走同源路由 + 真 `lib/client.js` 过 `__ModuleLoader__` 并注册四个槽位 |
| 交付形状 | `npm run pack:assert` | **真实 tarball** 的文件清单 + 三条加载契约 |
| 独立 profile | §7.6 | 改动影响运行时行为、又不想占用用户正在用的 profile |
| 真实浏览器 | §7.7 | 面板真的画出来、标签能切、切标签不重复列举 OSS |

要点：`npm run check` 必须全绿，改正式 TypeScript 时 `typecheck` / `build` 不得省略；
**`tests/` 里的测试全部 import `src/` 源码，证明不了构建产物能被加载**，所以 `smoke:built` 必须排在
`build` 之后（`check` 里已排好）。CI（Ubuntu + Windows × Node 22/24）跑同一组命令：
`npm ci → version:check → typecheck → test → build → pack:assert → smoke:built → 断言两个入口存在`。

### 7.6 备选：用独立 profile 做真实验证

不想动用户的 `web`（或想反复重启而不打断会话）时，建一个一次性的：

```bash
dsh --profile smoke --from-default-profile web --dump-config   # 从内置 web 模板建 profile
dsh plugin --profile smoke add .
DSH_PERMISSION_MODE=danger-full-access dsh --profile smoke --port 3099 --no-open
```

- **沙箱模式是必看项**：受限模式在**没有可用沙箱后端**的机器上（macOS 上进程本身已在沙箱内，
  `sandbox-exec: sandbox_apply: Operation not permitted`）会被 DSH 按契约拒绝执行 —— 插件发出的每个
  shell 调用都会失败。这时按 DSH 自己的提示用 `DSH_PERMISSION_MODE=danger-full-access`
  （或改 profile 里 `dsh-sandbox-policy` 的 `mode`）。**插件不会自己申请无沙箱执行**，那是用户的决定。
- 只读操作可以随便调：`ping` / `boot` / `env` / `pending` / `audit-status` / `workspace` /
  `oss-index` / `oss-result` / `oss-cred` / `session` / `install-prompt` / `oss-link`
  （`oss-link` 返回签名 URL：**只看结构，不要把 URL 本体回显或落日志**）。
- **写操作与交互操作不要在真机上乱试**：`audit-start`（会在真实案例上起一次真实审核、写真实工作空间、
  可能自动传真实 OSS）、`oss-upload`、`oss-cred-save`、`workspace-auto`、`trust`、`bind-session`、
  `open-path`、`clipboard`、`relogin`、`dws-login`。覆盖情况见 `PORTING.md` 的「25 个操作的验证账」。
- 验完删掉：`rm -rf "$DSH_HOME/profiles/<名字>"`，别留在机器上占端口和状态。

### 7.7 客户端半要真浏览器核对

`smoke:built` 只能证明产物形状与注册调用；**面板真的画出来、标签能切、切标签不重复列举 OSS**
只有浏览器能证明。用系统里已装的 Edge，**不用下载 Chromium**：

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
node <repo>/install/browser-check.mjs --url 'http://127.0.0.1:3099/?token=<token>' \
     --playwright /tmp/pw/node_modules --out /tmp/pw/shots
```

47 条断言：侧栏入口、**右上角环境指示灯**（颜色与结论一致、悬停文案）、**自检通过就直接进报告审核**、
环境自检页的真实数据、**重新自检与翻页的加载态**（进度条 + 正文压暗）、待审核报告页
（含**风险等级列**与「窄列不换行」的排版断言）、**审核根会话**的可见性、
**「审核信息」右侧抽屉**（读真实 JSON 对象，断言它固定贴在视口右侧、占满高度、带遮罩、能关掉）、
**「查看会话」真实点一次**（断言不再出现「客户端 sessions 服务不可用」，且真把会话打开）、
翻页与切标签**不重复列举 OSS**、切回仍正常、控制台零报错。它**不点「AI 审核」**，并在末尾断言全程
没有发出 `audit-start` —— **不要把它改成会点**。

加载态是瞬态的，真机上几百毫秒就过去了：脚本用 `page.route` 把这一次 `env` / `pending`
人为拖慢 3 秒，把「有没有加载态」变成确定性断言。撤路由必须等被拖慢的那次请求先回来，
否则 handler 里的 `route.continue()` 会撞上「Route is already handled」把验收变成崩溃（踩过）。

**凡是等真实后端的断言都要用条件等待**（`waitForFunction`），不要用固定 `waitForTimeout`：
氚云查询十几秒、`ossutil` 读对象几十秒都是常态，固定等待会假红；而抽屉的遮罩盖住整个视口，
一次「没关掉」会让后面每个 `click` 都超时，一次假红看起来像五处坏了（踩过两次）。

样式与布局的硬规范见 §4.4.1（类名前缀、主题 token、滚动容器、表格列宽）——
那几条各自对应一次真实故障，改样式前先看一眼。

### 7.8 接收方形态（npm tarball）也要验

`link:` 安装能用**不代表** tarball 能用 —— `prepare` 与 `files` 的坑只在接收方那边才炸：

```bash
npm pack                                        # 产出 dsh-crwu-workbench-<ver>.tgz
dsh plugin --profile <临时 profile> add ./dsh-crwu-workbench-<ver>.tgz
```

装出来的目录里**没有 `src/`**，`scripts/prepare.mjs` 应当打印「跳过构建：这是已发布的预构建产物」
并退出 0，`lib/index.js` / `lib/client.js` 与仓库构建逐字一致。

### 7.9 纪律

- 用户的 `web` profile 里跑的是**他的真实数据**（真实工作空间选择、真实审核记录，都存在
  `~/.dsh/crwu-workbench.json`）。装开发版之前先备份这个文件（§7.1 第 4 步）；
  任何会写状态 / 写案例目录 / 传 OSS 的操作，都不许拿它当试验场。
- 失败先定位根因再谈完成；绕过去等于把缺陷留给下一个人。
- 运行产物（`*.tgz`、截图、临时 profile）不进提交，也不要留在用户机器上。

### 7.10 审核根会话（子代理挂在哪）

用户报过「创建新会话时还是挂错了地方」：子会话的 cwd 与「子代理树挂在谁下面」都由**父会话**
决定，而父会话原来是「哪个会话头最后挂载」——从工作空间 A 的会话点开面板，审核就挂到 A 之下。

**用户已当面确认过这条需求的口径**（2026-09-20，问的是「挂的位置不对」指哪一种，他选了 A）：
审核子代理**必须挂在独立的「审核子代理根节点」树下**，而不是挂在「你正在看的那个聊天会话」
（实测现场：他在 `中瑞世联工作空间` 里那个「在 macOS 安装 ossutil 并配置 PATH」的会话里点了
「AI 审核」，旧宿主就把子代理挂到了那个**装工具用的会话**下面）。所以「挂对了」的判据不是
「落在对的工作空间就行」，而是**父级必须是根会话**。

1. **父级一律是审核根会话**（`host/audit/root.ts`）：一个建在插件选定工作空间里的**顶层**会话
   （`meta.cwd = 工作空间`、**不带 `parentAgent`**、`workspace.attachSession`），命名
   `审核子代理根节点 · MM-DD HH:mm`。所有审核子代理都挂在它下面，侧栏里就是一棵树。
2. **稳定优先**：根可用就一直复用（判据：Agent 活着 + cwd 仍是当前工作空间 + 不是子代理）；
   不可用（进程重启、换工作空间、会话没了）→ **新建一个**，旧树保留（用户已确认接受分叉）。
3. **hello 预检**：建完立刻 `followup` 一句「hello，请用 bash 执行 pwd」并 `whenIdle`。
   预检不过就**不落钩子、不起审核** —— 把「跑不起来」拦在第一条真审核之前。
4. 根是插件自己 `agents.create` 的，所以**插件重载后根会失效**（这正是分叉规则的用途）；
   根建会话时优先跟随「你正在用的那个会话」的 preset，取不到才用部署默认。
5. `bind-session` 仍然登记「当前会话」，但它**不再决定审核父级** —— 只用于显示与 preset 提示。
6. **「挂对了」长什么样**：审核根会话出现在 ① 那个工作空间的分组里（`workspace.attachSession`
   的成功与否只体现在这里）。两个自查口子：
   - 界面上：⑧ 运行环境信息 的「审核根会话」一行给出 **标题 + 短 id + 它挂的工作空间路径**
     （短 id 要剥掉 `session-` 前缀 —— 直接 `slice(0, 8)` 只会得到 `session-` 这种没有信息量的串）；
   - 机器上：`~/.dsh/storages/workspace.json` 里每个工作空间有 `sessionIds`，根应该出现在 ① 的名字下面。
   实测踩到的旧指纹是反过来的 —— 审核子会话的父级都是**聊天会话**（`session-6ce0c197…`、
   `session-a12045ec…`），它们在工作空间 `mungdong` / `crwu-ai` 里，而 `中瑞世联工作空间` 名下
   一条审核会话都没有。
   请求形状（`agents.create` 只发 `sessionId`/`meta{cwd,agentPreset}`/`agentOptions`/`setup`、
   preset 挂进 `setup` 给的 agentCtx）由 `tests/unit/host-audit-root.test.mjs` 逐个字段钉死 ——
   这条路径在真机上点一次就是一次真审核，只能靠测试盯形状。

### 7.11 ① 案例根目录（工作空间）的三条硬规则

用户报过「每次点进去 ① 都在变」，根因有三处，都已修，改这块时不许退回去：

1. **选定后就不动，而且整份持久化**：`pickWorkspace` 要写 `workspacePath + workspaceTitle +
   workspaceId + workspaceSource`，`ensureWorkspace` 整份恢复。只恢复 path 的话，重启后
   `source` 会从 `'manual'` 变成 `'saved'`、`canAuto` 变 false，界面标签与「恢复自动识别」按钮都会变样。
2. **选过的目录不在了 → 报错，绝不静默回落清单偏好**：`resolveAuditWorkspace` 返回
   `missing: true`，`env` 的阻塞项与 `audit-start` 的门禁都要说清是哪个路径。
   静默换一个工作空间 = 审核产物写进别的目录，而用户以为自己还在原来那儿。
3. **① 不读当前会话**：`workspaceStatus()` 只吃 `WorkspaceView`。早先它比对父会话 cwd 并弹
   「不是同一个」，结果是每换一个会话卡片就变一次。会话事实放 ⑧ 运行环境信息。
4. 另外 `writeWorkbenchConfig` 是读-改-写，**读失败时必须放弃本次写入**（`ConfigRead.ok === false`）：
   把读失败当成空配置，一次 transient 的 stat 失败就会把别人的字段抹掉（实测抹过 `workspacePath`）。

### 7.12 宿主与客户端是**分开加载**的（协议号）

客户端产物刷新页面就换新，宿主产物**只有重启 profile 才换**。不同代时的表现极其费解：
界面是新版、行为是旧版（用户报过「还是挂错位置」，实际是宿主还跑着上一轮 build）。

- `shared/consts.ts` 的 `WORKBENCH_PROTOCOL` 是协议代数：**改跨进程契约（Host 操作的字段/语义、
  审核父级这类关键行为）就 +1**；`ping` / `boot` 都会带上它。
- 客户端发现 `boot.protocol !== WORKBENCH_PROTOCOL` → 面板上明说「宿主插件是旧构建，请重启 web profile」，
  并把 `canDispatch` 置 false（行内门禁文案走 `Gating.gateReason`，不要让它说成「需先通过钉钉认证」）。
- 排查口诀：`env` 应答里缺字段 = 宿主是旧代；`ping.builtAt` 只反映「产物被加载那一刻的文件时间」，
  **它匹配磁盘 mtime 不代表跑的是最新代码**（旧构建里那一版可能是每次请求现读的）。

### 7.13 「查看会话」的三条硬规则

用户报过「点『查看会话』出现 客户端 sessions 服务不可用」。这是**两个独立根因**叠在一起，
改这块时两个都要留着测试：

1. **目标是「被点那一行」的 key**，不能拿面板的 `activeKey`（「当前在跑的那条」）顶替 ——
   在别的行上点会开到错的孩子；`activeKey` 为空时更直接，得到「该记录没有子会话 id。」。
   规则集中在 `report-audit/row.ts` 的 `openSessionTarget`（纯函数、可单测），渲染层只负责
   把行 key 递出去，`tests/unit/client-package.test.mjs` 两半各有一条断言（取值 + 传参）。
2. **可选客户端服务必须现读**：`readClientServices` 每个字段都是 getter，访问时才 `ctx.get`。
   在 `apply()` 里快照成普通对象的写法，在「插件比会话控制器先激活」的部署里 `sessions` 会
   永远是 `undefined`，**刷新页面也不会好**。
3. 打开会话有两条路：`sessions.openSubagent`（先 `refreshSubagents`，再按 mode 逐个试，
   最后切主面板）与兜底的 `uiWorkspace.openSession(id)`；**两条都缺**才允许说「服务不可用」，
   失败时要把**真实原因**带出来。`install/browser-check.mjs` 有一条真实点击的断言盯着这句话。

## 8. 发版（npm）

### 8.1 版本号与 CHANGELOG

```bash
npm run version:set 0.0.2     # 改 package.json + VERSION，并同步 package-lock.json 的根版本
# 手动在 CHANGELOG.md 加一节：## package · 0.0.2 · <日期>
npm run version:check         # 校验 package.json / VERSION / CHANGELOG 三处一致
```

`npm run check` 里已含 `version:check`，三处不一致会直接红。CHANGELOG 那一节不会自动生成，必须手写。

### 8.2 发布前空跑

```bash
npm run check
npm run pack:assert
npm publish --dry-run
```

`npm publish --dry-run` 会真的跑完 `prepublishOnly`（= `pack:assert` + `check`）并打印将要发布的清单，
但**不上传**。期望看到 `Publishing to https://registry.npmjs.org …(dry-run)` 与 `total files: 172`
（`lib/` + 补丁 + 文档 + `skills/` + `common/skills/`；技能正文是体积大头，解包约 2.9MB）。

### 8.3 走 tag 发布，不要手工 publish

```bash
git commit -am "release(dsh-crwu-workbench): 0.0.2"
git push
git tag plugin-v0.0.2 && git push origin plugin-v0.0.2
```

`plugin-v*` tag（`v*` 留给仓里的 Go CLI，两条发布线分开）→ 仓根的
`.github/workflows/release.yml`（插件是子目录，工作流用 `working-directory` 立在包目录里）：

1. 断言 tag 与 `package.json` / `VERSION` 一致（CHANGELOG 由 `check` 里的 `version:check` 覆盖）；
2. 跑 `npm run check` + `npm run pack:assert`（tag 可能指向没经过 CI 的提交，所以这里再跑一遍）；
3. `npm publish --provenance`，走仓库 secret `NPM_TOKEN`，附构建来源证明。

也可以在 Actions 里 `workflow_dispatch` 手动跑：`dry-run` 默认 true，只打包与校验、不发布。

**不要手工 `npm publish`**：`prepublishOnly` 会重跑两道门禁，但绕过 tag 就绕过了「tag 与版本一致」
和 CI 的构建来源，而且本机 registry 未必是官方源（见下）。
**`git push` 与发版都要等用户明确说**（§7.4）。

### 8.3.1 同一个版本号只发一次（分发包不可变）

分发包 URL 就是 `<包名>-<版本>.tgz`（员工侧 `dsh plugin add <URL>` 认的就是它），所以**同版本重发
= 覆盖远端对象**：同一版本号出现两份内容，早装与重装的员工跑的不是同一份，版本号也不再能定位问题；
`dsh plugin add` 甚至未必真的替换（pnpm 见 spec 未变就跳过 —— 实测过）。用户 2026-09-21 明确要求
守住这条。

- 改了任何东西（代码 / 技能 / 文档 / `cordis.patch.yml`）→ **升版本号**：`npm run version:set x.y.z`
  + 手写 CHANGELOG 一节，然后 `make plugin-dist`。
- 机器判据在 `scripts/dist-plugin.mjs`（`make plugin-dist` 先跑完整门禁再接它）：远端没有该对象 →
  上传；已有且内容一致 → 跳过（幂等重跑无害）；已有但内容不同 → **拒绝上传**并提示升版本号；
  `ossutil stat` 读不出来（网络/权限/输出变了）→ 同样不动远端。空跑：`PLUGIN_DIST_DRY_RUN=1 make plugin-dist`。
- 员工侧升级 = 用**新** URL 再 `add` 一次（旧版本的 URL 一直有效、内容不变），然后重启 profile。

### 8.4 发布目标固定为官方 registry

`publishConfig.registry = https://registry.npmjs.org`，**必须与 release workflow 的 `registry-url` 相同**
（`tests/unit/host-package.test.mjs` 会互相核对，改一个不改另一个会红）。

原因：本机 `~/.npmrc` 常指向镜像（国内开发机常见），不钉死的话手工 `npm publish` 会发到镜像上，
而 `--provenance` 在镜像上根本不成立 —— 一条命令同时踩两个坑。**装依赖仍然走你的镜像，不受影响。**

### 8.5 发布链路里三条不能忘

1. `package.json` **不能加 `private`**（加了就发不出去）。
2. **`prepare` 在 npm 安装时也会执行**，而 tarball 里没有 `src/` / `tsconfig.json` / `tsdown.config.ts`。
   所以构建入口必须是**随包发布**的 `scripts/prepare.mjs`（源码在就构建、不在就跳过），
   发布前由 `prepack` → `build:lib --force` 保证真的构建过。改这条链时，
   `tests/unit/host-package.test.mjs` 里那条真跑 `npm pack` + `npm install` 的回归测试必须继续通过 ——
   本地门禁看不出这类失败，只有接收方装包才会炸。
3. `files` 带 `lib/` + 补丁 + 文档 + **技能**（`skills/` 插件专属、`common/skills/` 打包前由
   `scripts/sync-common-skills.mjs` 从源仓 `plugins/common/skills/` 拷进来）；`src/`、`tests/`、
   `install/`、`AGENTS.md`、`PORTING.md`、`scripts/`（除 `prepare.mjs`）都不进包。
   改完必须跑 `pack:assert` 核对（它会断言两个技能目录各有一个代表文件在包里）。

### 8.6 与 DSH 版本对齐

`peerDependencies` 里的 `@deepseek-ai/dsh-*` 与已安装 DSH 对齐（当前 `0.1.5-rc.2`）。
DSH API 是 developer preview：**升级 DSH 时必须**同步核对这几个 peer、重跑门禁，并把兼容到的
DSH 版本写进 `CHANGELOG.md`。

### 8.7 发完再验一次接收方

从 npm（或刚发的 tarball）装进一个干净 profile 验一遍，见 §7.8 —— 预构建产物、`github:` 安装与
`link:` 安装是三条不同的路径，只有第一条是别人真正会走的。

### 8.8 提交前

- 运行产物、临时页面、密钥、测试缓存、`.superpowers/` 不进提交。
- 确认没有覆盖用户已有改动，也没有无关文件。
- 确认用户**已经测过、并且审过代码**（§7.4）。
