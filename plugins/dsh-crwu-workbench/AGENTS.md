# AGENTS.md

本仓库是一个 **DeepSeek Harness（DSH）插件**。所有代码、目录、测试和发布改动都必须遵守 DSH 的插件装配、Host/Client 分层、Cordis 生命周期与浏览器模块规范。不能把它当作普通 Node.js 网站或独立 React 应用处理。

**延伸阅读（`docs/`，给维护者读的"为什么"）**：本文件是**门禁口径**；写代码前按需读下面四份，
它们与本文件冲突时以本文件为准，并在同一批把文档改回来。

| 文档 | 什么时候读 |
| --- | --- |
| [`docs/ui-design-guidelines.md`](docs/ui-design-guidelines.md) | 动界面 / 样式 / 交互：视觉语言、DSH token 白名单、样式交付与模板字符串禁反引号、类名纪律、布局硬规则、侧栏分组卡与面板壳口径、加载态与空态、改样式的验收方式 |
| [`docs/development-notes.md`](docs/development-notes.md) | 动交付形态 / Cordis 生命周期 / Host 操作 / 协议号 / 沙箱与授权 / 测试与发版：加载契约、`baseUrl` 陷阱、协议号规则、增删操作清单、开发循环与证伪纪律、常见坑速查 |
| [`docs/PRD-workbench-sidebar-modules.md`](docs/PRD-workbench-sidebar-modules.md) | 改侧栏三模块或面板壳的形态与口径：需求、取舍、历次返工与证伪记录 |
| [`docs/releasing.md`](docs/releasing.md) | 准备或执行 npm 发版：认证配置、版本升级、完整门禁、`plugin-v*` tag、Actions、发布后验收、失败恢复与回滚 |
| [`docs/desktop-acceptance-0.0.15.md`](docs/desktop-acceptance-0.0.15.md) | 走 0.0.15 的桌面验收（P-01…P-18 / W-01…W-07 / M-01…M-10）：记录哪些事实、怎么故意弄坏、什么条件下才允许打 tag |
| [`docs/review-0.0.15.md`](docs/review-0.0.15.md) | **准备复审 0.0.15 时先读这一份**：按风险排序的复审顺序、每条设计要求的自动化证据在哪、三条真机验证的最短路径、以及「我没有验证的」清单 |

`plugins/AGENTS.md` §3.3 也指向这些文档；新踩的坑**写回对应文档**，不要只留在提交信息或对话里。

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
│   │   ├── config.ts                # Cordis 选择入口与运行时配置类型
│   │   ├── deployment.ts            # YAML 部署值合并到运行清单
│   │   └── yaml.ts                  # YAML Schema 解析与分发地址推导
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
│   ├── dws/                         # dws 的**唯一**调用点：白名单 argv → ctx.shell
│   │   ├── run.ts                   #   runDws / assertDwsCommand / dwsEscalationAllowed
│   │   ├── consts.ts                #   允许的命令前缀、提权前缀、固定目标
│   │   ├── plan.ts                  #   钉钉回传的纯计划逻辑（无 IO，可单测）
│   │   └── knowledge-tree.ts        #   知识库目录树解析与寻址（纯函数）
│   ├── tools/                       # CRWU 业务 Tool：模型可见的**唯一**执行入口
│   │   ├── register.ts              #   registerCrwuTools / missingAuditTools（生命周期与可见性）
│   │   ├── capabilities.ts          #   crwu_audit_capabilities（零副作用自检）
│   │   ├── h3yun.ts                 #   crwu_h3yun_record_get / files_list / file_get
│   │   ├── knowledge.ts             #   crwu_audit_knowledge_materialize
│   │   ├── oss.ts                   #   crwu_audit_oss_publish
│   │   ├── dingtalk.ts              #   crwu_audit_dingtalk_archive / notify_self
│   │   ├── case-dir.ts              #   案例目录门禁（containment，防越界写/读）
│   │   ├── case-files.ts            #   案例目录内的本地文件操作（同样经 ctx.shell）
│   │   ├── dws-json.ts              #   dws --format json 的调用与解析
│   │   ├── outcome.ts               #   失败三分类（审批 / 基础设施 / CLI）与统一包络
│   │   ├── types.ts                 #   ToolDeps / toolContext（优先调用者 Agent scope）
│   │   └── consts.ts                #   工具名、必需工具集、固定目录名
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
- 部署可变的值必须进入 `config/crwu-workbench.yml`；开发与 TGZ 运行共用这一份配置，不能再写进
  `cordis.patch.yml` 或伪装成 `DEFAULT_*` 常量。
- 固定路由、字段代码、协议版本、状态枚举等不可配置的协议值可以进入 `consts.ts`。
- **环境清单按语义分区，不许再混装**（`crwu.env-manifest.v4`，2026-09-26）：`packaged[]` 是**随插件
  发布**的组件（`crwu` / `dws` / `ossutil`，只有 `name` / `label` / `note` / `expectedVersion`），
  `runtime.python` 是 **DSH 自带**的脚本运行时，`ifind` 只声明「是什么、是不是必需、官方入口在哪」。
  清单里**没有** `binaries[]`、**没有**裸 `python3` 检查项、v4 起也**没有** `ifindKey.path` ——
  混装或第二份路径的直接后果是界面把两类东西平铺成一列命令清单（员工于是去装 Python、去找 ossutil
  安装包），或者凭据位置出现两个事实源。iFinD 凭据位置由 `host/ifind/store.ts` 推导（见 §4.7）。
- **自检只读事实，不跑命令**：② 只 `stat` 包内 `bin/<平台>/<文件>` 并与包内 `bin/manifest.json`
  比对**字节数**（sha256 从清单读出来进维护者详情，**不**每次自检重算 —— 三个二进制一百多 MB）；
  **不得** `command -v`、**不得**回退 PATH 上的同名命令、**不得**执行 `dws version`（会在二进制旁落
  `.dws/` 状态目录，`pack:assert` 判成运行残留）。缺失文案只能是「插件包不完整 / 平台不受支持」。
- **`env` 的分区就是界面层级**：`packageIntegrity` / `runtime` / `services`（氚云 + 钉钉，不含 OSS）/
  `delivery`（OSS 配置 + 凭据 + 连通性）/ `external`（iFinD）+ `workspace`。`blocked` 口径：插件包不完整
  只算**一个**故障、运行时不可用只算**一个**故障，三件组件与 vendored dws 的 PATH 兼容性都**不得**
  各占一项、也**不得**阻断自动审核。

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

工作台的入口席位是 `sidebar.footer.action`（左侧栏底部、Settings 上方），只注入 `wide` 与标准席位
hook `usePanelInfo`；**跳转动作要在点击时现读 `services.layout`**，别在 `apply()` 里快照。
`tests/unit/client-package.test.mjs` 会断言顶部 `sidebar.panellist` 入口与会话头指示灯**都不再注册**。

入口内容 = **品牌标记（`components/BrandMark.tsx`，用户给的原图描出来的矢量版）+ 名字 + 版本小标签 +
环境标记**。版本小标签（`dev` / `v0.0.5`）来自 `features/workbench/build-store.ts`，它包着 `boot`，
和 `envStatus` 一样由 `apply()` 创建、随 props 下发 —— 侧栏入口与面板头部必须显示同一枚标签，各自
`boot()` 既费一次请求，又会出现「标签是新的、门禁说旧的」这种自相矛盾的画面。宿主侧对应的两个常量在
`src/host/build-info.ts`（`HOST_BUILD_KIND`：包根旁边有没有 `src/`）与 `src/host/consts.ts`
（`PLUGIN_VERSION` / `PLUGIN_REV`），`ping` / `boot` 都会带上；**改这两个字段就等于改跨进程契约，要 +1
`WORKBENCH_PROTOCOL`**。

### 4.1.3 bundle patch 里的 `baseUrl` 是 **profile 目录**（2026-09-22 踩过）

profile 的整棵树是「补丁层挂在 profile 的空根配置上」，所以 `cordis.patch.yml` 里 `!!js` 表达式拿到
的 `baseUrl` 锚在 **profile 目录**，**不是本包目录**（DSH 源码注释：根配置文件存在只是因为 Loader
需要一个真实的 include root 来锚定 `baseUrl`）。`agent.cordis.yml`（agent preset）里同样写法是好的，
因为 preset 按文件加载、`baseUrl` 才是 preset 目录 —— 两处语义不同，别互相套用。

后果很隐蔽：`new URL('skills/', baseUrl)` 指向 `<profile>/skills/`（不存在），skill provider 照样
"装配成功"，只是**静默贡献 0 个技能**（症状：技能表里 crwu-* 一个都没有，而启动日志干干净净）。

**同一类"静默 0 个技能"还有第二种触发方式：技能根少注册一层。** `dsh-skill-filesystem` 的
`discoverRoot()` 对每个根只扫一层（`readdir(root)` → `<子目录>/SKILL.md`），不递归；技能按层组织后
如果只注册 `skills/`，`skills/crwu/` 会被当成"一个没有 `SKILL.md` 的技能"直接跳过，整层消失而日志无痕。
所以**一层一个根**。

- 本包内的路径一律**按包名解析**：
  `createRequire(baseUrl + 'package.json').resolve('dsh-crwu-workbench/package.json')` → 包目录 →
  再拼 `skills/crwu`、`skills/dws`、`common/skills`。link 开发、员工 tarball、装到别的布局都对。
- **新增一个技能层**（或只加技能）的完整改动清单 —— 技能根 / `files` / 打包断言 / 单测计数 / 文档 /
  版本，以及"哪些不用改"与四个会咬人的坑 —— 见 `plugins/AGENTS.md` §5.5。
- `>-` 折叠标量会把换行**折成空格**：多语句必须写分号，漏了就是求值期的 `SyntaxError`。
- 回归测试 `tests/unit/host-skills-patch.test.mjs` 会造一个 profile 形态的临时目录、把补丁里的表达式
  **真的求值一次**并断言三个技能根存在、每层都有技能且都有 `SKILL.md`；改回 `new URL('skills/', baseUrl)`
  或只注册 `skills/` 都会立刻变红。

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
- **权限按命令声明、且以「员工授权」为前提**（2026-09-22 口径）：读本机凭据的命令
  （`crwu h3yun session login|records|forms|…`、`dws auth status|login`）在请求里带
  `sandboxPolicy`，但这个提权**只在用户授权后**发生 —— 授权是插件状态文件里的
  **本机访问授权收据**（`state.localAccess`，协议 18：`schemaVersion` + `grantedAt` + 五项固定能力，
  一次允许、长期有效），没允许时环境自检把它作**阻塞项**，
  绝不谎报「未登录」。其余命令一律走 profile 的默认沙箱（能给最小权限就给最小）。
- **自研审核链路的模型可见执行入口只有 CRWU 结构化 Tool**（2026-09-25 口径，见 §4.5）。
  审核子代理不许查找、拼接或执行 `crwu` / `dws` / `ossutil` 命令；插件也不得把二进制目录、
  `PATH` 注入方式或裸命令写进 system prompt / user prompt。

⚠️ **授权/撤销的状态迁移只由 `host/access/consent.ts` 负责**，调用方（`ops/core.ts`）**不得**
把返回的 `consent` 写回活状态：写盘失败时那个视图可能来自**磁盘上的旧授权**
（撤销写盘失败时磁盘上仍是 `granted`），照抄等于一次失败的「重新允许」把权限重新打开
（2026-09-29 复查的 P1）。失败一律返回 `persist-failed` 关闭态；
`host-access-migration.test.mjs` 有一条门禁：`state.localAccess` 只允许在 `consent.ts` 里被赋值。

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
   - 面板自身必须拥有滚动：`.crwu-audit-root { height:100%; min-height:0; overflow:hidden }` +
     **正文区** `.crwu-audit-body { overflow:auto; min-height:0 }` —— DSH 的主内容列
     是 `display:flex; overflow:hidden`，它不滚动、把滚动交给面板；少这两条长页面会被裁一半。
     滚动**不能放在 root 上**：头部（标题 + 版本标签）必须常驻，root 一滚它就跟着滚出视口；
   - 表格用**固定布局 + `colgroup` 百分比列宽**（`.crwu-audit-table` + `.crwu-audit-col-*`）：
     `table-layout: auto` 会把多出来的宽度全给最宽的那一列（实测 1920px 时报告名涨到 696px，
     而操作列几乎不变，右侧一直很挤）；表格另设 `min-width`，**外面必须套
     `.crwu-audit-table-wrap { overflow-x: auto }`**，视口太窄时表内滚动而不是被卡片裁掉；
   - 窄列（流水号 / 风险 / 时间）一律 `white-space: nowrap` 并给 `title`，否则会被从中间折断。

### 4.4.2 本地访问代理（Local Access Broker，协议 18 · 子项目 B）

**所有跨工作区边界的 Host 操作只有一条路：`src/host/access/broker.ts`。**

| 文件 | 职责 |
| --- | --- |
| `host/access/operations.ts` | **封闭**操作表：每个操作固定 capability / 通道 / 是否提权 / 允许的来源 |
| `host/access/diagnostics.ts` | 结构化事实 → 归因（纯函数）+ 脱敏的最近 N 条 |
| `host/access/broker.ts` | `authorize` / `runShell` / `writeText`；唯一能声明 `danger-full-access` 的地方 |
| `host/oss/run.ts` | `ossutil` 的**唯一**执行器：每次调用都带对的操作（`oss.remote.read` / `.write`）与来源 |

五条不许退回去的口径：

1. **提权不是调用方的参数**。`broker.runShell` 没有 `escalate`；它由操作描述表决定。
   旧形态（`escalate?: boolean` + `trusted: boolean`）的 `effective = (trusted ∧ 白名单) ∨ escalate`
   已经把"这一步到底放行了什么"散进调用链，而且那个布尔值可以被复制粘贴到新调用点而**没有任何东西变红**。
2. **未授权时一个进程都不起、一个字节都不写**（B-04）。"先试一下、失败再看是不是没授权"
   会把受限沙箱的假结论（未登录 / 密钥错误）真的带回来给员工看。
3. **文件写入只能命中该操作唯一允许的那个路径**：`writeText` 比对"目标种类 + 绝对路径"，
   两者都必须逐字对上（B-06）。三个可写目标（工作台状态 / iFinD 凭据 / OSS 配置）的路径
   由各自领域模块推导，在 `apply.ts` 注入 —— Broker 自己不认识业务路径。
4. **业务 CLI 只在登记的执行器里拼命令**，而它们都必须经 Broker：`runCrwu`（argv 白名单 →
   `crwuOperationOf` 映射操作）、`runDws`（前缀白名单 → `dwsOperationOf`）、`ossutil`
   （**只能**经 `host/oss/run.ts` 的 `runOssutil`，每次带 `oss.remote.read` / `oss.remote.write`
   与来源）。⚠️ OSS 代码里**不许**出现裸 `runShell`，也不许直接 import `shell/run.ts`
   —— 2026-09-29 用户复查抓到过 6 处（列举 / 读结果 / 签名 / 上传 / 写后校验），
   它们不会拿到逐次 `danger-full-access`，在审核子会话里必然读不到 `~/.ossutilconfig`。
   当时的静态门禁只查"文件里出现过一次 `access.runShell`"，是**假绿**；现在是"不许出现"。
   ⚠️ **不要在新地方自己 `shellInvoke(bundledPath, [...])`**：那会绕开 argv 白名单这一层，
   `host-access-migration.test.mjs` 会红（2026-09-29 就是这样抓到 `environment/ops.ts` 与
   `system/identity.ts` 自己拼 `dws` 命令的）。
   ⚠️ 更隐蔽的是**间接形态**：先 `requireBundledCommand(ctx, platform, 'ossutil')` 拿到路径、
   再拿变量去 `runShell` —— 正则看不见它（2026-09-29 实测：这种文件在 B-01 下是绿的）。
   所以判据补在"**解析二进制**"这一步（B-01d）：解析了业务 CLI 的模块必须用同一文件里的
   登记执行器（`runOssutil` / `runDws` / `runCrwu`），或本身就是那个执行器。
5. **凭据读取一律先过具名操作**（P-11 的 Host 侧边界）。`oss-cred` / `ifind-status` /
   `ifind-probe` / iFinD 的宿主凭据服务 `set`/`delete` 都要**在 provider / fs / store / 网络之前**
   过 `authorize()`；判据写在读函数里（`readOssCred` / `readIfindSecret` / `writeIfindSecret` /
   `clearIfindSecret`），而不是每个 RPC 各写一遍。**UI 禁用不是安全边界**：
   撤销之后直接调 RPC 必须一个 fs / store / 网络调用都没有
   （`host-access-rpc-gate.test.mjs` 断言的就是"零调用"）。
   `oss.config.read` / `ifind.credential.read` 是**特权**操作（目标在工作区之外）。
6. **保存凭据的 `ok` 由权限回读决定**（P-08/P-09/M-04）：`credentialPermissionSatisfied()`
   说 `failed` 就是顶层 `ok:false`（POSIX 必须回读为 `0600`；Windows 的 `inherited` /
   `host-store` 按设计成立）。"文件写下去了"不等于"保存成功"。
7. **归因只看结构化事实**：`requested / resolved / ran / denied / runnerFailed` 五项进诊断，
   文本判据只在拿不到事实时兜底（见 `shell/run.ts` 的注释）。OS 级定性（Windows ACL、
   macOS Keychain、文件锁）由子项目 D 的只读 doctor 给出，**不许在这里猜**。
   诊断的**唯一界面出口**是开发者诊断里的「最近的本机访问」（`access-diagnostics`，展开时才取；
   验收 §11 要求的九项事实就是那一行，复制出来的文本可直接贴进验收记录）。
   ⚠️ 往诊断里加字段前先看 `AccessDiagnostic` 的脱敏口径：它**只**放操作名、来源、三个模式、
   两个布尔、归因类别、是否起过进程、版本与时刻 —— 命令原文、路径、凭据一律不进。
   **摘要（`summary`）在记录时还要再过一道 `sanitizeDiagnosticSummary()`**：它常常是调用方从
   argv 前缀拼出来的（`describeCrwuCommand` / `describeDwsCommand`），而 argv 里可能有路径 ——
   遇到第一个像路径的词就**截断**（不是跳过继续拼，那样只会得到半截路径）。

沙箱事实的**优先级**（`classifyAccessFailure`，每一条都有测试）：
`runnerFailed` → `sandbox-downgraded`（requested 或 ran 与请求不符，**ran 也要看**：
请求活过了 `resolve()` 却在执行时被降级是最难发现的一种）→ `sandbox-denied` →
`approval-denied` → `infrastructure` → `cli`。

### 4.5 CRWU 结构化 Tool 层（`src/host/tools/` + `src/host/dws/`）

**iFinD 取数也是结构化 Tool，不是脚本例外**（2026-09-26 · OPT-006）：同花顺 iFinD 的取数入口是
`crwu_audit_ifind_query`（`operation` = `list_tools` / `describe_tool` / `query`），
走 `defineTool` + `ctx.tools.register`，
纳入既有审批、超时、取消与脱敏链路。技能**不得**再授权"在 `ifind-finance-data` 技能目录写临时脚本、
执行其 `call.py` / `call-node.js`、读取其 `mcp_config.json`"，也**不得**搜索 `~/.agents` / `~/.dsh` /
`~/.codebuddy` / `~/.claude` 等技能根。服务地址与 `serverType` 映射是 Host 内部固定表（模型不能提交 URL），
SK 由 Host 从**插件状态目录**读取（模型不可见，见 §4.7），TLS 正常校验（不接受任何"关校验"开关）。

**这是本次改造的核心口径，不是可选风格。**

1. **注册只走 DSH 注册表**：`defineTool()` + `ctx.tools.register()`，在 `apply()` 里用
   `ctx.effect()` 包住；返回的 disposer 逆序注销每个工具。**不得自造私有 registry** ——
   只有进 `ctx.tools`，schema 才会自动进 Agent 的 system prompt，也才会走
   `tools/pre-execute → guard → tools/execute → tools/post-execute` 这条审批/超时/取消 pipeline。
   `tools` 是**硬依赖**（`PLUGIN_INJECT`），缺了就直接拒绝激活；DSH 的 base bundle 已以稳定 id
   `tools` 挂载 `@deepseek-ai/dsh-tools`，所以插件**只声明依赖，不重复插入第二个实例**。
2. **没有通用逃生工具**。工具 schema 里不得出现 `command` / `argv` / `args` / `binary` /
   `executable` / `path`(to binary) / `sandbox` / `sandboxPolicy` / `sandbox_permissions` /
   `escalate` / `profile` / `bucket` / `endpoint` / `prefix` / `corpName` / `spaceId` /
   `folderId` / `nodeId` / `conversationId` / `messageId` / `openDingId` / `userId` 这类字段
   （`host-tools.test.mjs` 有逐工具的封禁清单断言）。业务参数 + 案例目录才是输入。
3. **命令由 Tool 内部构造**：`dws` 只能经 `src/host/dws/run.ts` 的 `runDws`（argv 前缀白名单，
   表外默认拒绝）；`crwu` 只能经 `runCrwu`；`ossutil` 只能由 `crwu_audit_oss_publish` 拼装。
   所有参数经 `shellQuote`，**模型输入永远不进任意命令字符串**。
4. **二进制只按包内绝对路径解析**：审核 Tool 必须用 `requireBundledCommand`（严格）：受支持平台上
   找不到包内二进制就回 `capability-gap`，**绝不回退裸命令名** —— 回退会让模型看到
   `command not found`，下一步自然就是搜 PATH（正是要消灭的行为）。
5. **执行必须走 `ctx.shell`**：`ctx.shell.resolve()` → `execute()` → `result()`，并把
   `exec.signal` 透传进 `ShellExecRequest.signal`。**禁止** `ctx.subprocess`、`node:child_process`
   或 Python `subprocess` 执行 `crwu` / `dws` / `ossutil`。
6. **沙箱与提权**：见 §4.4.2 —— Tool 只交"操作 + 来源"，提权由 Broker 的操作描述表决定。
   **模型无法通过参数提权**（schema 里没有这个字段，`host-access-migration.test.mjs` 盯着）。
   特权操作拿不到工作目录时 **fail closed**（不是"退回沙箱"：那会拿到假的「未登录」）。
7. **失败三分类**：`approval`（审批拒绝）/ `infrastructure`（命令根本没跑起来）/ `cli`（退出码非 0）
   必须分开，另有 `input` / `capability-gap` / `policy` / `not-found` / `cancelled`。普通命令失败
   作为规范的结构化失败结果返回（`ok:false` + `errorKind`），不抛异常、不伪装成功。
8. **输出契约**：每个 Tool 必须声明 `output.schema`，`execute` 只返回该 schema 的 JSON 值；
   渲染统一用 `renderJson`。返回值里不得出现凭据、签名 URL 或二进制路径（OSS 错误另有
   `sanitizeOssError` 脱敏）。
9. **凭据与 URL 零外泄**：`crwu_h3yun_files_list` 不回显带会话鉴权的下载 URL；
   `crwu_audit_knowledge_materialize` 不回显 profile / 签名 URL；
   `crwu_audit_dingtalk_*` 只回稳定 ID 与远端路径。
10. **案例内操作的门禁是「本轮案例目录」，不是「工作空间」**（协议 19 收紧，见 `audit/scope.ts`）。
    审核子会话发起的每一个案例内 Tool 都要先过 `requireAuditScope(ctx, state, exec, args)`：
    `exec.agent.id → childId → 本轮的 `AuditRecord` → `casePath`，而 `caseDir` 必须与它
    **规范解析后精确相等**（`resolve` 后的 targetKey；Windows 盘符/UNC 按风格大小写不敏感、
    POSIX 大小写敏感）。**工作空间根、兄弟案例、案例目录的子目录一律拒绝**，`seqNo` / `objectId`
    必须与本轮记录一致，无身份 / 未知 childId / 已结束 / scope 不完整（认领来的旧记录）一律
    fail closed；通过时**返回 Host 的路径**，调用方不许再用模型给的字符串。
    ⚠️ 为什么不能只判"落在工作空间之下"（2026-09-29 用户第二轮复查的 P1）：一个工作空间里
    通常有很多案例目录，S1 的子会话可以传 `<工作空间>/S2`，或传工作空间根再读 `S2/文件` ——
    `crwu_audit_oss_publish` 会把**别的案例**的交付件传到 OSS，`file_get` / 知识库会往别的案例里写。
    ⚠️ **氚云标识也属于 scope**：`crwu_h3yun_record_get` / `files_list` 的 `objectId` 由模型提交、
    Host 绑不到本轮审核，所以它们**不在**审核子会话的必需集里（`CRWU_BUSINESS_TOOLS` 是注册面、
    `REQUIRED_AUDIT_TOOLS` 是审核能力集，两者刻意分开），审核子会话调用即拒绝且零进程；
    `crwu_h3yun_file_get` 只接受**可信输入快照**里登记的 `fileId`。`case_bootstrap` 同样要求
    `caseDir` 精确等于 Host 约定算出的那一个。`requireCaseDir` / `requireInsideCase` 仍然保留：
    前者用于**宿主自己的**路径判定（如 bootstrap 的期望目录），后者用来证明"目标在案例目录之内"。
    ⚠️ **"名单"不是边界**（2026-09-29 第二轮复查的 P1）：把某条 Tool 从 `REQUIRED_AUDIT_TOOLS`
    里删掉只是**预检名单** —— 子会话照样看得到、也执行得了。真正的边界是**创建子会话时**显式传下去的
    `toolFilter.deny`（`AUDIT_CHILD_DENIED_TOOLS`：`record_get` / `files_list` / `case_bootstrap`；
    DSH 在子会话的创建窗口里做 scoped `tools.restrict()`，工具**既不进 prompt、也拒绝执行**），
    而且**不支持 `capabilities.toolFilter` 的 provider 必须在创建子会话之前被拒绝**（`pickProvider`）。
    ⚠️ **scope 必须早于子会话发布**（同一个 P1）：`subagents.start()` 返回时子会话已经在跑，
    所以启动是**两阶段**的 —— 先落一条 `pending` 记录（带 `casePath`/`attemptId`/
    `allowedAttachmentIds`），`start()` 返回后再写入真 `childId` 并清掉 `pending`；
    创建失败或子会话复查失败一律**回滚** pending。
    ⚠️ **窗口内不放行任何东西**（2026-09-29 第三轮复查的 P1）：one-shot `start()` **没有**预留
    child id 的参数，也就拿不到不可伪造的 launch token，而父会话 id 只能证明"属于同一个 root"
    —— 同一个 root 下的旧 sibling 可以在窗口里冒领新审核的 case scope。所以 `auditScopeFor`
    **只认与记录逐字相等的 `childId`**，窗口内案例内 Tool 一律 fail closed（文案说明"会话正在建立"）；
    父会话判据（会话头 `meta.parentSession`，读不到就问 `subagents.listChildren`
    "审核根的孩子里有没有这个调用者"）**只用在拒绝方向**（`isAuditChild` → 拒绝面板类 Tool）：
    那里最坏只是多拒绝一个同 root 的 sibling，方向是安全的。
    `case_bootstrap` 的角色因此更清楚：它是 Host 在创建子会话**之前**的交接点。
    **同一条口径适用于所有"包含检查"**：信任域未知（工作空间没选、案例根为空）时**拒绝**，
    而不是"跳过检查继续做" —— `openPath` 曾经是后者，那天唯一挡住它的是"提权必须有 workdir"
    与 `defaultCaseRoot` 的兜底**恰好相等**；两处巧合一旦被改掉就会静默打开任意路径。
11. **基础设施标识不进模型参数**（2026-09-25）：氚云表单的 `schemaCode` 是 Host 状态，
    不是业务参数 —— `crwu_h3yun_record_get` / `crwu_h3yun_files_list` / `crwu_audit_case_bootstrap`
    的 `parameters` 里**没有**它，Tool 内部从 `H3yunFormResolver` 取（见 §7.15）。
12. **`crwu_audit_case_bootstrap` 是记录的唯一交接点**：按精确 `objectId` 各取一次记录与附件元数据，
    落盘到案例目录的 `输入快照/`，只回紧凑摘要（路径 + 指纹 + 计数 + 少量路由事实）；
    完整记录**不进**模型上下文。审核启动前由 Host 经 `ctx.tools.execute()` 调一次。

**审核链路的能力门禁**（`src/host/audit/preflight.ts`）：发起审核之前，插件自己检查
（1）全部必需 Tool 对审核根 Agent 可见（`ctx.tools.get(name, agent)`，agent 对象就是 scope key）；
（2）通过 `ctx.tools.execute()` 真调一次零副作用的能力自检，证明注册表与 policy pipeline 通得过；
（3）子代理发布后按**它自己的 scope** 复查一次（provider 可能进一步收窄）。
任何一步不过都在**创建子代理之前**失败并列出缺失的工具名 —— 提示词是请求，这里才是门禁。

### 4.6 环境领域模型与统一门禁（2026-09-26 · 协议 15）

**`allOk + blocked[]` 不再承担所有语义。** 环境结论拆成三层，判据只有一份（纯函数在
`src/shared/environment/model.ts`，Host 与 Client 共用、可单测）：

| 层 | 字段 | 说明 |
| --- | --- | --- |
| 事实 | `userSetup`（workspace / credentialsConsent / h3yun / dingtalk / aliyunOss / ifind）、`systemHealth`（packageIntegrity / dshRuntime / platform / toolRegistry） | 每项一个 `state` + 脱敏 `value` + `reason` + `required`。iFinD 与 OSS **必须是五态**（`unconfigured` / `unverified` / `authenticated` / `invalid` / `unreachable`）—— 压成一个布尔就会把"网络不通"说成"密钥错误" |
| 解释 | `issues[]`（`id` / `owner: user\|admin\|system` / `blocking` / `scope: global\|audit\|delivery\|external-data` / `action` / `message`） | 总状态、能力开关、通过率、门禁结论**全部从它推出来** |
| 结论 | `status`（`unknown` / `checking` / `ready` / `degraded` / `action-required` / `admin-required` / `system-blocked` / `check-failed`）、`capabilities`、`passed/total` | `ready` 与 `degraded` 才放行需要环境的页面 |

五条不许退回去的口径：

1. **iFinD 是必需项**（2026-09-26 产品口径，覆盖了旧的 OPT-006-R1 · F-008）：清单
   `ifind.required=true` ⇒ `userSetup.ifind.required=true`、**进必需项分母**、未通过即**阻塞**，
   并按原因分派归属：没填 / API-Key 无效或过期 → `user`；账号无数据权益 → `admin`；
   网络 / 超时 / 协议 / 上游不可达 → `system`。issue 双写 `global` + `external-data` 两个 scope ——
   前者让统一导航拦回环境页，后者让 `auditCore` 一起关掉（**光关外部数据却放行审核是自相矛盾的**，
   审核装配里本来就要取外部数据）。
   `degraded` 这个枚举为将来真正的可选能力保留，但**不得**再由"只有 iFinD 缺失"产生。
2. **判据是"真的取到一次数据"**：`ok`（认证通过 `initialize + tools/list`）与
   `dataVerified`（`tools/call` 返回非错误、非空内容）分开；只有后者为真才通过。没有可安全试取的
   只读工具时如实报权益问题，**不许**去调写 / 批量 / 导入导出类工具，也不许伪装成功。
3. **包 / 运行时 / 平台 / Tool 故障归 `system`**：员工页面（账号连接 + 交付与外部数据）
   **不得**出现「请安装 crwu / dws / ossutil」「未安装 python3」「export PATH」这类话 ——
   它们不是员工能修的。技术细节（包根、清单、sha256、运行时路径、凭据路径、验证工具名、
   数据样本、协议版本、审核根会话）只在「开发者诊断」里、且默认收起。
4. **通过率只统计必需项**：`passed/total` 与 `status` 永远自洽 —— 「环境就绪」旁边不会出现
   「7/8 通过」。"未查询"的 Tool 注册表**不进分母**。
5. **`blocked` / `allOk` 只作为兼容派生字段**（供审核提示词与旧客户端），必须与模型一致；
   不许再出现"各处自己拼 blocked"的实现。

**统一导航门禁（不许再有第二个判断处）**：

- 模块元数据在 `features/workbench/modules.ts` 声明 `requiresEnvironment` / `requirement`；
- **所有入口**都调 `module-store.ts` 的 `navigate(target)`：侧栏子项、报告页内跳转、以后新增的页。
  `WorkbenchPanel` **不得**再写"能不能进 audit"这种特判；**环境页里也不再放"进入报告审核"按钮**
  （2026-09-26 口径：就绪时只写一句「你可以从左侧进入报告审核」，跳转交给左侧栏的统一入口）；
- 被拦时不进入目标页 → 记 `pendingTarget` → 落到 `env` → 把「进入【目标页】前…」带出来；
  iFinD 未通过时那句话**指名 API-Key**（「进入【报告审核】前，请先完成 iFinD API-Key 验证」）；
  检查通过后**只恢复最近一次**被拦的目标；用户中途主动改去别处即取消自动恢复
  （`navigate('env')` 也取消，且**不得**把 active 改回旧目标）；`env` 页始终可进；
- **Host 侧另有能力门禁**（`src/host/environment/gate.ts`）：界面门禁负责体验，Host 门禁负责
  真实性与绕过防护（同源路由是公开契约）。判据是**同一份环境快照**（60s TTL，`invalidate()`
  在授权 / 换工作空间 / 存凭据 / 登录之后调用），**不为每个操作重跑一遍昂贵自检**；
  拿不到快照或自检失败一律 fail closed。`audit-start` 判 `auditCore`（iFinD 未过时它就是 false）；
  **停止审核与释放占用锁不判门禁**（它们是安全出口）。

**真实外部验证（两项都必须打真请求，不许只看文件在不在）**：

| 项 | 真实请求 | 归因 |
| --- | --- | --- |
| OSS | 包内 `ossutil ls oss://<bucket>/<configured-prefix>/ --endpoint <配置> --limited-num 1`（**只读**；空目录也算成功；不打桶根） | `credential` / `permission` / `config` / `infrastructure` 四类（`probeOss` 的 `errorKind`） |
| iFinD | `initialize → notifications/initialized → tools/list → 选安全只读工具 → tools/call` | `credential`（401）/ `entitlement`（403）/ `infrastructure`（网络超时协议）；四个阶段**判据一致**（`classifyFailure` 先看状态码再看消息指纹） |

两者都：保存后**立刻**真验证；用户点「重新检查」传 `force` **绕过缓存**再验一次；
自动 / 被动刷新可以复用短 TTL（iFinD 30s，按凭据指纹作键）以免被上游限流，
但界面**不得**把缓存命中说成"刚刚重新请求"（显示最近真实验证时间）。
所有 stderr / stdout 在返回界面或写日志前必须过 `host/oss/sanitize.ts` 的 `sanitizeOssError`
（AK / Secret / STS Token / Signature / 签名 URL）与 iFinD 的脱敏器。

### 4.7 iFinD 凭据：插件自己的状态文件（2026-09-26）

- **不许再读技能目录**：`~/.agents/skills/ifind-finance-data/mcp_config.json` 那条运行时依赖已删除。
  凭据落在**插件状态目录**：`<home>/.dsh/crwu-workbench/ifind-credential.json`，原子写入 + `chmod 600`
  + **回读核对**（`src/host/ifind/store.ts`）。优先 DSH 凭据服务（`ctx.get('credentials')` 形状），
  当前版本没有该服务时落文件 —— 判断只在 `resolveIfindStore()` 一处。
- **返回值只允许是成功状态、错误分类与脱敏信息**：`readIfindSecret` 是唯一能拿到明文的出口且只给
  Host 内部。空值 / 占位符 / 首尾空白 / 换行在**写盘之前**拒绝。用户视图只给"验证成功/失败 +
  最近验证时间 + 已保存（含长度）"；**工具名、数据样本、协议版本**一律移入开发者诊断；
  凭据文件路径与 OSS 的 Bucket / Endpoint / 前缀同属维护者信息，可以只在诊断里展开。
- **结论会变，界面结论必须跟着清**：卡片上的"验证成功 / 失败"是**组件状态**，而后台自检随时可能
  把同一项变成 `invalid`（密钥被撤销、权益到期、被限流）。`IfindAuthCard` 按"结论指纹"
  （state + errorKind + ok + dataVerified + checkedAt + reason）在变化时清掉上一次的提示，
  否则同一张卡上会同时出现「验证成功」与「API-Key 无效」两句互相矛盾的话。
- **名字与口径**：界面上一律叫 **API-Key**（不是"SK"）—— 员工的输入框标签、状态词、错误提示都用它。
  `auth_token` 只是上游 MCP 的字段名，**不得**出现在任何面向用户的文案里。
- **每次环境校验都真的验一次，且验证 = 真的取一次数据**（2026-09-26 改）：
  `probe` 默认 **true**；`initialize` → `tools/list` 之后**真的 `tools/call` 取一次数据**。
  两截结论分开：`ok`（认证）与 `dataVerified`（取到数据）—— 认证通过但没取到数据时，
  状态必须是 `unverified` + 明确的 `errorKind`（权益 → 找管理员；凭据 → 重填；网络 → 稍后重试），
  **绝不显示成「已认证」**，而且是**阻塞项**（见 §4.6 第 1 条）。
  面板反复刷新由 **30s TTL 缓存**兜住（按凭据指纹作键，换 key 自然失效），
  用户点「重新检查」传 `force: true` **必须绕过缓存**重新真探。
- **试取工具的选择**（`pickProbeTool`）：只挑只读、必填 ≤ 1、无 boolean/数组/对象参数的工具，
  名字命中写/批量/导入导出词表的一律不碰；一个都挑不出来时如实报"权益可能未开通"，
  **不许**把"没挑到工具"当成取数成功，也**不许**真去调一个可能写数据的工具。
- **失败归因四阶段一致**（`classifyFailure`）：会话初始化 / 工具清单 / 取数 RPC / 取数内容
  都要**先看 HTTP 状态码（401/403）再看消息指纹**。只在前一阶段区分，员工在后置失败时
  就只会看到"取数失败"这种既不能重填也不能找管理员的笼统提示。
- **Host 操作**：`ifind-status` / `ifind-credential-save`（保存后**立刻真实探测**）/
  `ifind-credential-clear`（要求显式 `confirm: true`）/ `ifind-probe`。**不是模型可见的 Tool**。
- **协议**：`crwu_audit_ifind_query` 的 `operation` 增加 `describe_tool`（对单个真实工具返回
  **脱敏、限深、限长**的 `inputSchema`）；MCP `protocolVersion` = `2025-03-26`（官方 1.4.0 客户端）
  并做**显式协商**：服务端回受支持集合内的版本就用它，回不认识的版本按协议错误失败 ——
  **不许静默假设** `2024-11-05` 永远有效。401 → `credential`、403 → `entitlement`、
  网络 / 超时 / 协议 → `infrastructure`，三者不许混。
- **不上游打包**：官方 `call.py` / `call-node.js` / `mcp_config.json` **不进运行包**，也不得把
  「把密钥发给 Agent」「SSL 失败用 `curl -k`」「跑官方脚本」写进任何指引或提示词。

### 4.8 审核会话的沙箱与审批（协议 18 引入，协议 19 收紧到案例目录 · 子项目 C）

**审核根与审核子会话永远是 `workspace-write` + `approval=never`，边界是本轮案例目录。**
判据与写入口只有一处：`src/host/audit/policy.ts`。

**一条根只服务一个案例目录**（协议 19）：`ensureAuditRoot` 必须先拿到 Host 算出的 `casePath`，
把它作为根的 `meta.cwd`，回读 `workspace-write.workspaceRoot` 与 cwd 都等于它；
工作空间级旧根（`auditRoot.casePath` 为空 / 缺失）判**过期、绝不复用** —— 那是通用 shell / fs
能改同工作空间其他案例的形态。顺序也是硬要求：**先建案例目录，再建根**（根一诞生就必须有边界），
而占用门禁排在两者之前（被拒的发起零副作用：不建空目录、不起根会话）。

| 步骤 | 在哪 | 说明 |
| --- | --- | --- |
| 写覆盖 | `applyAuditRootPolicy` | 用 DSH 的 `setSandboxMode` / `setApprovalPolicy`（**不许**手写 `session.append`：会绕开取值校验，且事件名漂移时静默失效） |
| 回读 | 同一个函数 | `sandboxPolicy.resolve({session})` 必须是 `workspace-write` 且边界**等于本轮的案例目录**（协议 19 起；此前是"选定工作空间"，那让通用 shell / fs 能改同工作空间的其他案例），会话 cwd 也要等于它（读得到时必须相符） |
| 预测子会话 | `delegatedPolicyFacts` | 按 DSH 委派捕获口径算"子代理会继承到什么"：沙箱覆盖 = 父的显式覆盖、审批 = `never`、permissionPreset = Auto/Full 时继承 |
| 拒绝不受限 preset | 同上 | `auto` / `danger-full-access` 是会话**身份**，不是一次覆盖 —— 只能判根不可用，不能"先复用再纠正" |
| 就绪门禁 | `AuditDeps.readiness` | 创建子代理**之前**再判一次环境（复用界面门禁的同一份快照） |
| 发布后复查 | `audit/ops.ts` | 子会话起来后按它自己的 scope 复查策略与工具可见性；不对就**停掉它** |

七条不许退回去的口径：

1. **不依赖部署默认**：`session 覆盖 ?? 部署默认` 里的默认可以是 `danger-full-access`，
   "审核跟着部署默认走"等于把边界交给别人配 —— 所以显式写、显式回读。
2. **策略也是根可用性的一部分**：带 `auto` / `danger-full-access` 的根**不复用**（C-02）；
   边界或 cwd 不是本轮案例目录、或根属于别的案例，同样不复用（协议 19）。
   ⚠️ **子会话发布后的复查也要传 `caseDir`**（2026-09-29 第二轮复查的 P1）：那里曾传
   `workspacePath`，于是**每个正常可见的子会话都会被判错并停掉**。配套必须有"真实可见 child +
   正确案例目录 → 正常启动"的**正向**用例（只测"不对就停"会让期望值写错也全绿）。
3. **停止的判据是静默，不是"信号发出去了"**：`stopChild` 返回 `quiesced`（dispose 完成
   **或** Agent 已不在 `running`；问不到状态 → fail closed）。`dispose` 超时**不算**成功，
   没确认静默就**不覆盖旧记录、不删句柄、不释放占用、不起下一条**；等待必须**有界**
   （没有 timer 服务时退化成全局定时器，绝不无界 await）。
4. **登录只给面板**：`h3yun.session.login` / `dws.auth.login` 的 `allowedSources` 只有 `panel`
   （`host-access-broker.test.mjs` 盯着），审核 Tool 里没有任何 login 工具
   （`host-access-migration.test.mjs` 盯着），提示词里明令"停下并要求员工回工作台"
   （`host-audit-prompt.test.mjs` 在**登录那一段内**逐句断言）。
5. **改提示词要绑到段落**：`立即停止本次审核` 这类句子在提示词里出现过多次，
   整篇 `text.includes(...)` 会被别处的同名句子满足（2026-09-29 用缺陷注入证伪过）。
   断言要 `indexOf` 定位到段落再在段内查。
6. **发布后复查是"证伪"**：安全性来自创建前设对并验证；复查抓到不对就停子会话并报错，
   不让一条越界的审核跑完。
7. **`@deepseek-ai/dsh-sandbox-policy` / `dsh-user-approval` 是 peer + dev 双声明**
   （同其余 7 个 peer）：宿主产物会 `import` 它们，接收方由 DSH 运行时提供。

### 4.8.1 停止审核的状态机（F1，2026-09-29）

**停止是一个可观察的状态机，不是一次 RPC 的返回值。** 阶段枚举（Host 与 Client 共用）：
`idle` → `requested` → `aborting` → `waiting-quiescence` → `quiesced` / `timeout` / `failed`。

- `audit-stop` **两阶段**：先把 `requested` 落盘再返回"已接受"，abort → dispose → 静默复查在后台跑，
  阶段逐段落盘；`audit-status` 的每条记录带 `stop`（phase / requestedAt / elapsedMs / quiesced /
  aborted / disposed / error / notes / canStartNext）。
- **幂等**：重复点停止不会再起第二条流程（`stopInFlight` + 持久化阶段双重判据），也不重复 abort。
- **`canStartNext` 只由 Host 判定**：进行中 / timeout / failed 一律 false，且**不看占用锁在不在**
  （重启后锁可能没恢复，"没确认停下"仍然是事实）。客户端缺字段按**未知**处理，
  **禁止**用 `status !== 'running'` 之类本地事实推断成 stopped / quiesced。
- **没确认静默就不许丢身份**：`stopChild` 的 `quiesced` 是唯一判据；不满足时写成退役记录并保留
  句柄与占用（见 §4.8 第 3 条）。`audit-start` 在停止未确认时直接拒绝。
- 界面侧口径是**纯函数**（`features/report-audit/stop-view.ts`）：阶段文案、语气、可用动作、
  `canStartNext` 都在那里算，组件只渲染；阶段文案放在 `aria-live="polite"` 区域里播报，
  等待期间显示"已等待 N 秒 · 最多等待约 8 秒"并禁用停止/重新审核/AI 审核。
- 「**打开审核会话**」与「AI 审核结果分析（`audit_analysis`）」是两个入口、两个目标会话：
  前者用记录里的 `childId` / `parentSessionId`（`openSessionTarget` 是唯一解析点），
  `childId` 为空时显示「会话正在建立」并禁用。

### 4.9 桌面归因与修复指引（协议 18 · 子项目 D）

**"为什么进不去"只有一处判据：`src/host/access/classify.ts`。** 它是纯函数，
输入是执行事实 + 平台原生探测结论，输出是归因类别。

六条不许退回去的口径：

1. **事实在手时文本不许翻案**。第 5~7 档（`os-credential-store` / `file-lock` /
   `os-filesystem-permission`）都带结构化前置（**实际**跑在 `danger-full-access` 且 `denied !== true`）；
   前置不成立就直接落 `cli` / `infrastructure`，**不看**文本说的是不是"权限不足"。
2. **`sandbox_apply: Operation not permitted` 永远不是文件权限问题**（§D5）。它的判据排在
   所有权限判据**之前**；反过来写就会把"嵌套沙箱起不来"翻译成"命令缺失 / 没登录 / 凭据无效"。
3. **锁必须有正向探测**。`.data.lock: Access is denied` 同一句话有三种原因，
   "看着像锁"是其中最不可靠的一种 —— 只有 `probes.lockHeld === true` 才定性。
4. **修复走白名单，不走黑名单**：`dws-local-permission-repair` 要求体检**正向确诊**
   `os-filesystem-permission`。沙箱 / 钥匙串 / 锁 / 所有者不对那些分支只是"更早、更可操作的
   拒绝文案"，真正的守门人是那条正向判据（`host-dws-local.test.mjs` 用缺陷注入证过这一点）。
5. **修复只动该动的**：目录 `.dws` 与它下面的 `.data.lock`；不许 `chown` / `takeown` / `sudo`、
   不许删锁、不许碰父目录、不许沿符号链接走；修完**必须重新体检**（退出码 0 不等于模式变了）。
6. **登录类操作只给面板**、体检与修复都**不接受路径参数**（目录由 `<home>/.dws` 推导）。
   返回体里没有 ACL 条目、账户名、SID、钥匙串条目名、原始 `dws doctor` 输出。
   **失败原因里的路径也要脱敏**（`platform/redact.ts` 的 `redactPaths`）：system 调用的错误消息
   自带绝对路径（`EACCES: permission denied, stat '/Users/x/.dws'`），而 doctor 视图与凭据卡片都是
   **员工可见**的；只把路径换成 `<路径>`，**错误本身必须留着**（丢掉原因比多一个路径更难查）。
   凭据文件路径与主目录按 §4.6 第 3 条只在开发者诊断里展开。
7. **探测自己也要被判沙箱**：每条只读探测（`stat` / `id` / `test -w` / ACL 判决）先看**它自己**
   有没有被沙箱拦下（`probeSandboxed`）。判据**只看 `ran`** —— `shell/run.ts` 里的 `resolved`
   是**我们自己请求**的模式（`spec.sandboxPolicy.mode`，特权操作恒为 `danger-full-access`），
   拿它当证据等于不检查。被拦下或拿不到 `ran` 时只能说"不知道"（`null`），
   **不许**当成"操作系统权限不对" —— 否则会给员工一个按下去真会改权限的按钮，
   而原因在宿主/部署那一层（实测：`~/.dws` 是 `700` 且属主是自己，受限 shell 里 `test -w` 仍回 1）。
8. **修复的成败由回读决定**：`ok` 必须核对后置条件（目录 `700` / 锁文件 `600` / Windows
   要**真的写一次**）。`chmod` / `icacls` 退出码 0 而实际没生效的情形真实存在，
   把"命令跑过了"说成"修好了"就是 §2 那张表点名的"把结果报得比事实好"。
9. **Windows ACL 要算"有效权限"**：判决脚本把当前访问令牌的 SID（自己的 + 所属组）与
   继承 ACE 一起算，**Deny 优先**；输出的每一行只有 `self` / `group` / `other` 标签与
   **权限位掩码**（数字，不是身份），**没有** SID、账户名、域名。
   数值口径（官方 `FileSystemRights`）：`Modify = 197055`、`FullControl = 2032127` ——
   ⚠️ 夹具与注释里曾把 `2032127` 标成 "Modify"，那是 **FullControl**（实现不硬编码位，
   但夹具用错值会让"覆盖写位"的算术在测试里失真，2026-09-29 复查指出）。
   插件侧算 `effective = (∪allow) & ~(∪deny)`，再判它是否完整覆盖
   `modify-mask & 写位`（`WRITE_BITS`）—— 判据是"所需**写**权限"，不是整条 Modify：
   要求整条位集存活会把"只 Deny 了读位"误判成不可写（另一个方向的错）。
   ⚠️ 旧实现只否决"整条 Modify 位集被 Deny"，于是 `Deny (W)` / `Deny Delete` 这类
   **部分 Deny** 被整个忽略 —— doctor 报"可改"、修复入口也不出现（2026-09-29 复查的 P2）。
   更早的形态是只找"当前 SID 的 Allow ACE"（组权限与 Deny 都看不见），修完照样写不进去。
10. **`stat` 是三态，不是布尔**：`present` / `absent` / `error`。只有 `stat → undefined` 才是
   `absent`；任何抛错（Windows 的 `Access is denied` 就是这样）都是 `error`，
   体检必须停在"无法确认"（`infrastructure`），**不许**报「目录不存在，请先登录一次」，
   修复也**不许**动手（`lstat` 抛错时"是不是符号链接"同样没有答案）。
11. **锁必须正向探测，两个平台都要有**：`lockExists` 只是"文件在"，残留锁文件与"真有进程握着"
   看着一样。POSIX 用 `lsof -t -- <path>`（退出码 1 + 空输出 = 正向的"没被占用"）；
   **Windows 用 `FileShare.None` 独占只读打开**（成功 = `False`、共享/锁冲突错误码 32/33 = `True`、
   `UnauthorizedAccess` = `Unknown` —— 那是 ACL 问题，交给 ACL 判决，**不许**混成"锁被占用"）。
   句柄必须在 `finally` 关闭，全程不写一个字节。
   ⚠️ **必须沿 `InnerException` 解包到根异常再读 HResult**：PowerShell 调用 .NET 方法抛出的
   `IOException` 会被 `MethodInvocationException` 包住，32/33 在内层；读外层 `$_.Exception.HResult`
   会让"真的有进程持锁"也落到 `Unknown`，W-05 依旧归不了 `file-lock`（2026-09-29 复查的 P1）。
   ⚠️ 归因 `file-lock` 要求**两个条件**：原始失败与锁有关 + 当前正向探测证明有人持有。
   前者由 Broker 在失败当时算成**脱敏布尔事实** `lockRelated` 记进诊断（不存文本）——
   doctor 手里的 `text` 是本次体检输出，靠它会把"认证失败 + 恰好有人持锁"说成文件锁。
   ⚠️ 旧实现 Windows 固定返回**空命令** → `lockHeld` 永远不可能为 true → 验收矩阵 **W-05 的
   `file-lock` 归因在代码上不可达**（2026-09-29 复查的 P1）。分类器里也没有"只有锁文本就定性"的口子。

12. **目录与锁文件要**分别**探权限**（2026-09-29 复查的 P1）：原始报错目标就是
   `<home>/.dws/.data.lock`，只探目录会让"目录正常、锁文件不可写"退化成 `cli`、
   修复入口永不出现。Windows 上锁文件也要跑 ACL 判决，POSIX 上要读它的 owner/mode
   并做只读的 `test -w`；**任一个确定不可写都算 `filesystemAccessDenied`**。
   修复**只动被证明有问题的对象**（目录正常就不许改目录），回读也只核对修过的那些。
   ⚠️ 属主/模式读取的形状必须是 `<uid> <mode>`：把只有模式的输出当"uid=644"读会得出
   "这个文件不是你的"，把**可修的问题变成不可修的**（夹具当场抓到）；形状不对时留 `null`。

13. **体检有前置条件**（设计 §D2）：`dws-local-doctor` **只在"刚刚发生过一次属于 `dws.*` 的失败、
   且结构化事实排除沙箱拒绝"之后**运行。没有可归因的失败、或最近一次是沙箱拦下的 → 直接拒绝，
   "可归因的失败"有三条排除：`errorClass === ''` 是**成功**（不是失败）、
   `not-authorized` / `invalid-source` 是**访问控制**结果（说的是谁在调，不是机器怎么了）、
   以及判据是"**最近一次失败**是不是 DWS 的"（最近的失败属于 OSS 时不许往更早的记录里翻）。
   判据必须在**任何 fs / shell 调用之前**（"零调用"是判据，不是优化）。
   界面要把这件事说清（`dwsLocalNeedsFailure`），否则员工会以为按钮坏了 —— 而且**能不能点由 Host
   给事实**（`access-diagnostics` 的 `dwsDiagnosable` → 卡片 `canDiagnose`），**不许客户端自己推断**：
   客户端看不到 `lockRelated` 这类结构化事实，猜出来的一定与 Host 不一致（要么亮着被拒、要么灰着却能体检）。
   修复路径同理：体检自己拒绝了，就**原样转述它的原因**，不要换成"目录不存在"那种更笼统的话
   —— 那会把"最近一次失败是沙箱拦下的，改权限没用"说成"请先登录一次"，把员工指错方向。
14. **登录必须写工作区之外，所以它的归因比通用规则更强一条**（G 段，2026-09-29）：
   `crwu h3yun session login` 要写临时浏览器 profile（`$TMPDIR`/`%TEMP%\crwu-scan-*`）、
   `dws auth login`（含 `--device`）要先抢 `<HOME>/.dws/.data.lock`，两者收尾都要写操作系统凭据存储。
   判据在 `src/host/system/login-failure.ts`：`runnerFailed` → 提权被降级（`requested !== resolved`）
   → `denied` / 实际跑在受限模式 → **原文点名了登录必须写的工作区外目标且带拒绝字样**。
   ⚠️ 第 ④ 条是 `shell/run.ts` 的 `sandboxDenialNote()`「事实干净就不猜文本」的**唯一例外**
   （目标集合已知），**不许**把它推广成通用规则；**目标词与拒绝字样必须同时命中** ——
   否则 `secret not found in keyring` 这种"真没条目 / 钥匙串被锁"会被说成权限问题。
   两条登录都返回 `sandboxBlocked` + `advice`，`error` 是"一句人话 + 下一步 + **保留**的原始报错"；
   客户端只渲染 Host 给的事实，不许按错误文本自己推断。**设备码不是"浏览器打不开"时的退路**
   （它同样要抢 `~/.dws` 的锁），按钮文案与归因文案都必须说清这一点。
   ⚠️ 归因必须分**两支**（`LoginAdvice.policyBlocked`）：结构化事实说降级/拒绝 → 让人切「完全权限」；
   **事实干净却照样 `Access is denied` → 是这台机器在拒，必须明说"切权限没有用"** 并给退路
   （氚云 `h3yun session bind --token`、钉钉先试设备码）。把两支合成一句"请切完全权限"就是误导
   —— 2026-09-29 实测：诊断里三个模式都是 `danger-full-access`，面板却让人去切权限。
   ⚠️ 登录的**临时目录由插件指定**（`system/auth-scratch.ts` → `<home>/.dsh/crwu-workbench/auth-tmp`
   + 命令内建目录并指 `TMPDIR`/`TMP`/`TEMP`）：依据是员工机器上系统 TEMP 与用户缓存目录都被拒、
   而插件状态目录可写。**不许动 `LOCALAPPDATA`**（Chromium 自己的组件目录走系统默认）；
   主目录未知时原样返回命令，不伪造。

界面侧（`client/features/environment/DwsLocalCard.tsx`）只有一条交互规则：
**修复按钮只在确诊"本机文件权限问题"时渲染**，并且要**二次确认**（改权限与"允许读本机凭据"
是两件事）。沙箱拒绝 / 降级 / 钥匙串 / 认证失败 / 所有者不对 / 文件锁**都不渲染**。

两层护栏：`tests/unit/client-dws-local.test.mjs` 逐类断言"不渲染"，
`install/browser-check.mjs` 在真浏览器里断言卡片可见、只读体检点得动、**没查过时不出现修复按钮**、
以及"只读体检不会发送修复请求"。另外 `tests/windows/powershell-contract.test.mjs` 会把这一层的
权限探测/修复命令**真的交给 `bash -c` / `pwsh -Command` 跑一遍**（macOS 上跑 POSIX 那半，
Windows 那半由 CI 的 `windows-powershell` job 覆盖）—— 只断言命令字符串漏掉了
`stat -f %u %Lp` 缺引号这种真实缺陷（2026-09-29 就是这么抓到的）。

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
  它还会**跑一遍卸载路径**：把 `apply()` 里每个 `ctx.effect` 的 disposer 都调用一次，
  断言同源路由被摘掉、CRWU 工具被逐个注销。⚠️ 这条是 2026-09-29 补的 ——
  在此之前**没有任何用例跑过卸载**，"忘了 `return` disposer"（Cordis 经典坑）在本地完全看不见，
  表现是插件卸载后路由/看门狗还在。替身的 `register` 必须返回**真的**注销函数，
  否则"有没有释放"根本观察不到（替身返回空函数 = 这条判据永远绿）。
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
| 用户可见文案（UI 中文） | **逐条**断言的测试，模板见 `host-install-prompt.test.mjs`（已随 `install-prompt` 删除；现存模板看 `host-environment-env.test.mjs` 的"员工可见结论"那条） | 没人拦 —— 但「意思差不多地改写」真的丢过安全指令 |
| 新增部署可变的值 | YAML Schema 边界测试，并写进 `config/crwu-workbench.yml` | `host-yaml-config.test.mjs` + `host-package.test.mjs` 的真实 pack/install/激活测试 |
| **新增 / 改名一个 CRWU Tool**（`host/tools/`） | 工具名的**逐字**断言（`host-tools.test.mjs` 的注册清单与 `REQUIRED_AUDIT_TOOLS` 对照）+ 参数无逃生字段 + 输出 schema 能过 `validateJsonSchemaValue` + 命令走包内绝对路径 + `exec.signal` 透传 + 沙箱/提权断言 | `host-tools.test.mjs`（注册清单、封禁字段、工具名）；`smoke:built`（产物里 8 个工具名）；改名的工具还要同步 `host-audit-prompt.test.mjs`（提示词逐字列 Tool 名） |
| **审核提示词 / 审核链路**（`host/audit/`） | 逐条断言（`host-audit-prompt.test.mjs`）：必需 Tool 名、**不含**插件 bin 路径 / `export PATH` / `which` / `command -v` / 裸命令 / Python 回传脚本；能力门禁（`host-audit-lifecycle.test.mjs`：缺 Tool 或能力缺失时**不得创建子代理**） | `host-audit-prompt.test.mjs`（删一步就红）；`skills:cli-guard`（技能侧的对应约束） |
| **技能正文与自带脚本里的执行指令**（`skills/crwu/**`、`plugins/common/skills/**`） | 改完跑 `npm run skills:cli-guard`；新增兼容章节必须用 `crwu-cli-guard:legacy-compat-start/end` 包起来。守卫现在也扫 `.py` / `.js` / `.mjs`：脚本不得用 `subprocess` / `child_process` / shell / 裸命令驱动 `crwu` / `dws` / `ossutil`（归档与通知只走 `crwu_audit_dingtalk_archive` / `crwu_audit_dingtalk_notify_self`） | `skills:cli-guard`（`check` 与 CI 里都有）；`host-skills-guard.test.mjs` 另有守卫自身的证伪用例（含 Python/Node 旁路与间接调用形态） |
| **自带二进制 / 打包**（`scripts/sync-binaries.mjs`、`assert-pack.mjs`、`release.yml`） | 改清单字段或判据时补 `host-bin-manifest.test.mjs`（哈希变化、缺平台/工具/manifest、运行残留）；发布形状改动跑 `npm run pack:assert:strict` | `host-bin-manifest.test.mjs`；`make plugin-check` 里的 `pack:assert:strict`；`release.yml` 的 `binaries` job |

**新增一个 Host 操作的最小改动清单**（最容易漏的是 2~4）：

1. `src/host/ops/core.ts` 的操作表加一项；
2. 同一文件的 `boot.ported.done` 加名字（漏了 → 「操作表 ↔ ported 声明一一对应」红）；
3. `tests/helpers/frozen-inventory.mjs` 的 `FROZEN_OPERATIONS` 加名字（漏了 → 冻结清单红；
   删操作也要在这里显式改小，并有 `host-operations.test.mjs` 的独立护栏）；
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
# 每次启动都会打印**新的** URL 与 token（同一个日志文件里会累积多份，实测各次互不相同），
# 所以取最后一行；重启脚本会把最新那份写到 /tmp/dsh-web-url.txt，也可以直接用那个：
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' ~/.dsh/logs/dsh-web-3080.log | tail -1 | cut -d= -f2)
# 或：TOKEN=$(sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' /tmp/dsh-web-url.txt | tail -1)

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
npm run check               # = version:check + config:check + skills:check + skills:cli-guard
                            #   + dws:check + typecheck + test + build + smoke:built
npm run pack:assert         # 改过 files / exports / publishConfig / 入口时必须
npm run pack:assert:strict  # 发布形态：两平台六个二进制 + manifest 必须在真实 tarball 里且哈希一致
npm run bin:check           # 装配过 bin/ 时：按 manifest 重算最终文件哈希
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
  （或改 profile 里 `dsh-sandbox-policy` 的 `mode`）。**产品口径是「员工零启动参数、但首次必须授权一次」**：
  插件不要求员工改启动方式，读本机凭据的命令由插件按 DSH 的请求契约声明 `sandboxPolicy`，
  且只在员工**允许**（`localAccess` 收据）之后才提权；没允许时环境自检把它当阻塞项，且
  **一次凭据探测都不发生**（不读凭据文件、不起凭据子进程）—— 未授权时读到的「未登录 / 密钥错误」
  是受限沙箱造成的假结论。上面这条
  `DSH_PERMISSION_MODE` 只是**开发自测**临时 profile 的用法。
- 只读操作可以随便调：`ping` / `boot` / `env` / `pending` / `audit-status` / `workspace` /
  `oss-index` / `oss-result` / `oss-cred` / `session` / `ifind-probe` / `oss-link`
  （`oss-link` 返回签名 URL：**只看结构，不要把 URL 本体回显或落日志**）。
- **写操作与交互操作不要在真机上乱试**：`audit-start`（会在真实案例上起一次真实审核、写真实工作空间、
  可能自动传真实 OSS）、`oss-upload`、`oss-cred-save`、`workspace-auto`、`local-access-grant`、`local-access-revoke`、`bind-session`、
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

断言覆盖：**侧栏分组卡**（几何位置 + 卡内三行子项、三行都在同一张卡的范围内且自上而下、
报告评估占位、点过的子项是选中态、全页只有这三行 —— 面板里不再有模块条 + 子项右侧环境标记：
通过 = 绿勾）、**自检通过就直接进报告审核**、
**未授权时的授权行**（在「账号连接」里，不是遮住整页的模态层；Host 侧同样拒绝发起审核）、
**全局环境门禁**（`page.route` 把环境应答人为降级 → 点报告审核 → 断言不进入目标页、
落到环境页且出现「进入【报告审核】前」→ 撤掉改写后自动继续；`env` 页始终可进）、
环境信息页的真实数据（四个分组 + 顶部状态卡 + AK 表单**只要 ID 与 Secret** +
iFinD **API-Key** 卡片的官方入口与「不要让 Agent 代填」）、
**重新检查与翻页的加载态**（进度条 + 正文压暗）、待审核报告页
（含**风险等级列**与「窄列不换行」的排版断言、**没有**流水号查找框）、**审核根会话**的可见性、
**「审核信息」右侧抽屉**（读真实 JSON 对象，断言它固定贴在视口右侧、占满高度、带遮罩、能关掉）、
**「查看会话」真实点一次**（断言不再出现「客户端 sessions 服务不可用」，且真把会话打开）、
**「AI审核结果」页里按流水号查找**（查找框在**这一页的卡片里**、输入不列举 OSS、命中/没命中各只发
一次列举、清空回到全量且不重新列举）、翻页与切标签**不重复列举 OSS**、切回仍正常、控制台零报错。
它**不点「AI 审核」**，并在末尾断言全程没有发出 `audit-start` —— **不要把它改成会点**。

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
3. **策略收敛（协议 18 · C）**：`agents.create` 之后、**hello 预检之前**，
   `applyAuditRootPolicy` 写入并回读 `workspace-write` + `never`，并确认"子会话将要继承到什么"
   正是这两项（见 §4.8）。不复用带 `auto` / `danger-full-access` preset 的根。
4. **hello 预检**：建完立刻 `followup` 一句「hello，请用 bash 执行 pwd；并调用
   `crwu_audit_capabilities` 回报 ok/platform」并 `whenIdle`；随后插件**自己**再做两件确定性检查
   （`host/audit/preflight.ts`）：全部必需 Tool 对该 Agent 可见、通过 `ctx.tools.execute()`
   真调一次能力自检（证明注册表与 policy pipeline 通得过）。
   任一不过就**不落钩子、不起审核** —— 把「跑不起来」拦在第一条真审核之前。
   发起审核时还会再查一次（复用的根不会重新预检），并在子代理发布后按它自己的 scope 复查
   **策略与工具可见性**（不对就停掉子会话）。
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

### 7.13 「跳到某条会话」的四条硬规则

用户报过两次：一次是「点『查看会话』出现 客户端 sessions 服务不可用」，一次是
「点『与 DeepSeek 讨论报告』/『复核报告』跳不到对应的会话，也创建不出新对话」。
四个根因彼此独立，改这块时四条都要留着测试：

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
4. **客户端 `sessions` 服务上没有 `open()`**（2026-09-25 踩到）。`ClientSessions` 只有
   `retain / using / binding / list / create / fork / scope / sessionOf / search / subagentAddress …`；
   切会话的唯一入口是 **`uiWorkspace.openSession(id)`** → 内部 `replaceMain(id, signal, 'reveal')`
   = 设置主会话 + `layout.selectPanel(null)`（左侧会话列表被点也是走它）。
   写成 `sessions?.open?.(id)` 会被可选链吞成**静默 no-op**，只剩半截 `selectPanel` ——
   用户看到「点下去什么都不发生」。
5. **会话 face（`rename` / `prompt`）必须经 `sessions.using(id, {source}, op)` 借**，
   不能只写 `binding(id)`：`binding(id)` 是 `this.scopes.get(id)?.binding`，**只有已被 retain 的会话**
   才有值，而刚 `create()` 出来的那条还没 retain → `undefined` → rename 被静默跳过（会话没名字 →
   下次按名字找不到，只能再建一条），kickoff prompt 也发不出去。`binding` 只作为旧宿主的退路。

### 7.14 讨论会话的资料来源：远端 only + **唯一**案例目录（2026-09-25）

用户在「与 DeepSeek 讨论报告」/「复核报告」两条会话里报过两件事，一起看：

1. **「工具好像调不动」** —— 实测**工具是通的**：真实会话记录里 `crwu_audit_capabilities`
   返回 8 个工具全部 `available:true`、5 个附件都由 `crwu_h3yun_file_get` 从远端下回来了
   （`ok:true` + 真实字节数），会话标题也正确写成了 `报告讨论 · <流水号>`。
   看起来"没调工具"的真相是：**模型同时还在用 `bash`/`read` 翻本机目录**。
2. **「模型会从我电脑的目录里去找已有的文件」** —— 记录里的原话是 `pwd; ls -la`、
   `find cases -maxdepth 4`、`md5 *.doc`、`read …`；它还自己 `mkdir -p cases/<流水号>/材料-源`，
   把材料下到了**错的目录**。

**根因不是工具，是提示词**：原来只有一段抽象的数据边界（「不得读取本地文件」），
却**没给"唯一允许读写的目录"**。模型不知道材料该放哪，就 `ls` + `find` 去猜 —— 猜出了
`cases/<流水号>`（与审核链路实际使用的 `<工作空间>/<流水号>` 不一致）。

所以现在的口径是三条，改这块时必须同时满足：

- **案例目录的约定只有一份**：`shared/utils/case-dir.ts` 的 `caseDirOf(workspacePath, seqNo)`
  → `<工作空间>/<流水号>`。Host 的审核提示词与 Client 的两条讨论提示词**都**用它算；
  两处各写一次拼接就是这次漂移的温床。`client-assistant.test.mjs` 有一条「Host 与 Client 算出同一个路径」的断言。
- **两条讨论提示词都注入「取数规则」**（`assistant-context.ts` 的 `fetchRules()`，报告讨论与审核分析共用）：
  唯一案例目录 + 用 `crwu_h3yun_file_get({fileId, caseDir, relativePath})` 逐件下载 +
  **每次新建对话都重新下载**（磁盘上的同名文件可能是上一轮或别的报告的过期文件）+
  **禁止** `ls`/`find`/`grep`/`glob` 扫描本机 + 不要自己建目录树 + 清单外资料一律「当前不可用」。
  `caseDir` 为空（旧宿主 / 没选工作空间）时**整段不写** —— 宁可不给，也不给半截路径。
- **本机路径只允许出现这一条**：上下文里除了案例目录，不许再出现任何 `/Users/...` 之类的路径。
  `client-package.test.mjs` 用正则抽出全部本机路径，断言去重后就等于案例目录那一条。

**还没做（按需再上）**：让 `crwu_h3yun_file_get` 支持「只给 `seqNo`、目录由 Host 算」，
这样模型连路径都不用写。现在先靠提示词 + 共享约定把它约束住；如果真机上仍看到模型乱翻目录，
再上这一级（工具 schema 会多一种定位方式，要同时补 `input` 错误分支与测试）。

### 7.15 报告定位交接：Host 定位 + 输入快照（2026-09-25）

用户报「自动审核启动后子代理重新定位/搜索报告」。根因是**交接不完整**：`auditStart` 只把
`objectId` / `seqNo` / `project` 交给子代理，而记录接口要 `schemaCode` —— 于是子代理自己去
发现表单、列记录、在案例目录里翻找材料。`schemaCode` 属于 Host 的基础设施状态，不是模型该推断的
业务参数。现在的口径：

1. **表单 code 只在 Host 解析一次**：`H3yunFormResolver`（`host/h3yun/form.ts`，**插件实例级**）
   —— `state.formCode` 非空直接复用；为空才调一次 `discoverForm`，并发请求共享同一个 in-flight
   Promise；失败不缓存（允许下次重试）。列表（`loadPending`）与所有记录类 Tool 共用它，
   所以两条链路不会各搜一遍。
2. **模型可见的 Tool 参数里没有 `schemaCode`**：`record_get` / `files_list` / `case_bootstrap` 都由
   Tool 内部向解析器要。测试按**逐字**断言参数集合里没有它，并断言命令里的 `--schema` 来自解析器。
3. **`crwu_audit_case_bootstrap` 一次做完**：`records get` 与 `files list` **各一次**（按精确
   `objectId`，禁止 `records list` / 搜表单 / 扫目录 —— argv 是固定模板，模型只提交业务标识与案例目录），
   写 `<案例目录>/输入快照/{报告记录,附件清单,快照元数据}.json`，返回
   `snapshotPath / digest / fieldCount / attachmentCount / routingFacts`。
   同一 `attemptId` 重复调用直接返回上次摘要（`reused:true`），`refresh:true`（重审）才覆盖。
   元数据里只放 `schemaCode` 的**指纹**，原文不落盘、不进上下文。
4. **审核启动的三道门禁**（都在 `startChild` 之前，任一失败就不创建子代理）：
   capability 预检（§4.5）→ 表单 code 解析成功 → `bootstrapInputSnapshot()`（经
   `ctx.tools.execute()`、以**审核根 Agent** 为 scope，走完整 policy pipeline）→ DSH Python 可用（§7.16）。
   成功后把 `snapshotPath` / `digest` / `objectId` / `seqNo` / `attemptId` / Python 路径写进指令。
5. **子代理指令里写明**：报告已由 Host 精确定位、以输入快照为唯一记录来源、不得重新定位或重复取数、
   附件只按清单 `fileId` 取、快照与任务不一致时立即停止并报「数据边界错误」。
6. **重审**：`attemptId` 每轮都新（`<key>-a<attempt>-<time36>`），bootstrap 强制 `refresh:true`
   覆盖本轮快照；仍然不得读取上一轮审核产物与 `复核-人工/`。

### 7.16 DSH 自带 Python：审核脚本的运行时（2026-09-25）

**外部数据取数不在本节范围内**：iFinD 取数不是"技能脚本运行时"问题，而是 §4.5 的结构化 Tool
（`crwu_audit_ifind_query`）。Python 运行时只用于材料准备、表格勾稽、交付渲染等本机脚本。

**不再把系统 `python3` 当运行时依赖。** 技能脚本要 `openpyxl` 这类包，员工机器上的
`/usr/bin/python3` 既没有它们、版本也不受控。DSH 0.1.7 起自带 workspace runtime，并把它暴露成工具
`load_workspace_dependencies`（返回 `python` / `pythonPackages` / `pythonDistributions`）。

- **`WorkspaceRuntimeResolver`**（`host/runtime/python.ts`，插件实例级）：经 `ctx.tools.execute()`
  调 `load_workspace_dependencies`（审核启动时带审核根 Agent 作为 scope）；校验返回的路径
  **真的是普通文件**并真能跑出版本；校验 `pythonDistributions` 里至少有 `openpyxl`（缺了就
  `missing-package` + 明确文案）；顺带记录 `python-docx` / `python-pptx` / `Pillow` / `lxml` /
  `numpy` / `pandas` / `XlsxWriter` 的版本。
- **只解析一次、只缓存成功**：成功结果缓存（环境自检反复刷新也只问一次 DSH）；失败不缓存，
  `refresh: true`（界面「重新自检」）可重试。
- **不硬编码、不改 PATH**：不写 `/Applications/DeepSeek Harness.app`、不写 `~/.dsh/dsh-runtimes`、
  不读 `process.argv`，路径只能来自工具真实返回；也不把 Python 复制进 `bin/`，不做下载 / 安装 /
  pip 自动安装。`host-runtime-python.test.mjs` 用源码扫描钉住这两条。
- **审核启动前解析**：解析失败**不创建子代理**（否则子代理会退回系统解释器）。
  解析成功后把绝对路径写进 `AuditPromptTask.python`，子代理直接复用。
- **技能正文**：`crwu-audit` 的「脚本运行时（Python）」一节写死三条 —— 自动审核用注入的绝对路径；
  独立使用技能时先调**一次** `load_workspace_dependencies` 并复用；**禁止**裸解释器名字、
  任何解释器查找、静默降级到系统解释器。`crwu-audit-datacheck` / `crwu-audit-external-data` /
  两个维护元技能同样加了这一段；`skills/dws/**`（vendored）不改。
- **脚本仍然走 shell**：命令经 `ctx.shell` 执行（沙箱 / 审批 / 取消照旧），不用 `node:child_process`、
  不用 `ctx.subprocess`（`host-tools.test.mjs` 的源码扫描同时覆盖这两条）。

## 8. 发版（npm）

### 8.1 版本号与 CHANGELOG

```bash
npm run version:set 0.0.2     # 改 package.json + VERSION + src/host/consts.ts，并同步 package-lock.json 的根版本
# 手动在 CHANGELOG.md 加一节：## package · 0.0.2 · <日期>
npm run version:check         # 校验 package.json / VERSION / CHANGELOG.md / src/host/consts.ts 四处一致
```

`npm run check` 里已含 `version:check`，四处不一致会直接红。CHANGELOG 那一节不会自动生成，必须手写。

**为什么 `src/host/consts.ts` 也要跟着走**：`PLUGIN_VERSION` / `PLUGIN_REV` 是 `ping` / `boot` 与界面
版本徽章的唯一来源（§7.2 的排查全靠它），漏改的表现是「包是新的、面板显示的还是 v0.0.5」——
正是 §7.2 要区分的那种假象。`version:set` 与 `version:check` 都会管这一份；
`tests/unit/host-package.test.mjs` 另有断言 `ping.rev === pkg-<package.json.version>` 兜底。

### 8.2 发布前空跑

```bash
npm run check
npm run pack:assert
npm publish --dry-run
```

`npm publish --dry-run` 会真的跑完 `prepublishOnly`（= `check` + `pack:assert:strict`，**先构建再自检**）
并打印将要发布的清单，
但**不上传**。期望看到 `Publishing to https://registry.npmjs.org …(dry-run)`。

**发布前必须先装配自带二进制**（`make plugin-pack` 会先跑 `plugin-bin`），否则包里没有它们。
装配好的形态是 `total files: 457`、解包约 **106MB**（`PASS …：457 个文件 / 解包 108340KB`）——
`lib/` + 补丁 + 文档 + 三层技能 + **两个平台各一套 `crwu`/`dws`/`ossutil`**。
体积大头从「技能正文（约 5.5MB）」变成了「自带二进制（约 100MB，其中 dws 一个平台就 32MB）」，
所以 `pack:assert` 的上限也提到了 160MB。**没装配时它会打印 `WARN 未装配 bin/` 并显示 450 个文件 /
约 5.7MB** —— 那是 CI（Ubuntu/Windows 不做 `make build` + 110MB 下载）的正常形态，
不是可以直接发布的包。文件数或体积与这两种形态都不符时，先怀疑有东西误进包。

### 8.3 走 tag 发布，不要手工 publish

```bash
git commit -am "release(dsh-crwu-workbench): 0.0.2"
git push
git tag plugin-v0.0.2 && git push origin plugin-v0.0.2
```

`plugin-v*` tag（`v*` 留给仓里的 Go CLI，两条发布线分开）→ 仓根的
`.github/workflows/release.yml`（插件是子目录，工作流用 `working-directory` 立在包目录里）：

1. 断言 tag 与 `package.json` / `VERSION` 一致（CHANGELOG 由 `check` 里的 `version:check` 覆盖）；
2. `binaries` job 先在 macOS 上交叉编译并按 manifest 装配六个二进制，作为 artifact 交给发布 job；
   再跑 `npm run check` + `npm run pack:assert:strict`（tag 可能指向没经过 CI 的提交，所以这里再跑一遍）；
3. `npm publish`（当前由仓库 secret `NPM_TOKEN` 完成 registry 鉴权；`permissions: id-token: write`
   配合 `--provenance` 生成 provenance attestation；迁移到无长期 Token 的 npm Trusted Publishing
   见 `docs/releasing.md`）；**不要把 `provenance: true` 写进 `publishConfig`** ——
   那样本机 `npm publish` 会以 `EUSAGE: ... provider: null` 拒绝发布，首发引导就做不了了）。

也可以在 Actions 里 `workflow_dispatch` 手动跑：`dry-run` 默认 true，只打包与校验、不发布。

**不要手工 `npm publish`**（首发那次引导例外，见 README §五）：`prepublishOnly` 会重跑两道门禁，
但绕过 tag 就绕过了「tag 与版本一致」
和 CI 的构建来源，而且本机 registry 未必是官方源（见下）。
**`git push` 与发版都要等用户明确说**（§7.4）。

### 8.3.1 同一个版本号只发一次（发布不可变）

**分发通道是 npm**（2026-09-25 起）：员工侧 `dsh plugin add dsh-crwu-workbench@<版本>`。
原来走的是「把一个 tgz 传到匿名只读 OSS，员工按 URL 装」——那条路连同那个桶一起删了
（理由见 CHANGELOG 0.0.7：那个地址谁都能换，换掉就能换掉插件本体）。

- 改了任何东西（代码 / 技能 / 文档 / `cordis.patch.yml` / `config/crwu-workbench.yml`）→ **升版本号**：`npm run version:set x.y.z`
  + 手写 CHANGELOG 一节，然后 `make plugin-pack`（它会先 `plugin-bin` 再 `plugin-check`）。
- 「同版本只发一次」这条纪律现在由 **npm 自己**守住：已发布的版本号不能覆盖，改了内容只能发新版本号。
  **不要手工 `npm publish`** —— 走 §8.3 的 tag 流程，那里同时校验 tag 与版本一致并附构建来源证明。
- 本地要空跑一遍：`npm publish --dry-run`（会真跑 `prepublishOnly` = `check` + `pack:assert:strict`，但不上传）。
  注意 `--dry-run` 也会走到"要不要生成 provenance"那一步，所以本机**必须先**去掉 `publishConfig.provenance`
  （见 §8.1；`host-package.test.mjs` 有断言钉住它不许回来）。
- 员工侧升级 = 装新版本号再重启 profile。

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
3. `files` 带 `lib/` + 补丁 + 文档 + **三层技能**（`skills/crwu/` 自研层、`skills/dws/` vendored 上游层、
   `common/skills/` 打包前由 `scripts/sync-common-skills.mjs` 从源仓 `plugins/common/skills/` 拷进来）；
   `src/`、`tests/`、`install/`、`AGENTS.md`、`PORTING.md`、`scripts/`（除 `prepare.mjs`）都不进包。
   改完必须跑 `pack:assert` 核对（它会断言每一层都有一个代表文件在包里，vendored 层还钉 `provenance.json`）；
   **发布链路还要跑 `pack:assert:strict`** —— 它真打一份 tarball、解包后按 `bin/manifest.json`
   逐个重算 size/sha256，并拒绝 `bin/` 下任何未声明的运行残留。

### 8.6 与 DSH 版本对齐

`peerDependencies` 里的 `@deepseek-ai/dsh-*` 必须覆盖**每一条我们声明支持的 DSH 运行时线**
（当前 `^0.1.7-rc.2 || ^0.2.0-rc.1`，cordis `^4.0.4`）。DSH API 是 developer preview：
**加一条 DSH 线之前**必须逐包比对这几个 peer 的 API，再把那条线写进区间，并把兼容到的
DSH 版本写进 `CHANGELOG.md`。

**0.1.7 起 peer 是硬门禁，不再是提醒**（依据 0.1.7-rc.2 的 app-boot 文档原文）：加载 profile 的
bundle 层时会拿 `getDshRuntimeVersion()` 与每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的
peer 范围比对，**「Every declared range must match; prereleases participate in range matching」**，
不匹配的 bundle 会被**当作不可读直接跳过**并记进 `skippedBundles` —— 表现为「插件装上了、界面里
什么都没有」，而启动日志干干净净；插件管理器还会直接把这一行标成「与 DSH <运行时版本> 不兼容
（要求 …）」并禁用。注意五点：

- 判据是 **`peerDependencies`，不是 `engines.dsh`**：官方文档明确写了「These checks use peer
  declarations, not `engines.dsh`」，而 `dsh.manifestVersion` 与 `engines.dsh` 目前**只是声明、
  没有任何强制**（`dsh-package-manifest` README：「Current installers and loaders do not enforce」）。
  本包两者都写，仅为声明口径；真正生效的是 peer。
- **一条线一个 `^` 区间，用 `||` 并列**：`^0.1.7-rc.2 || ^0.2.0-rc.1` 精确表达「0.1.7 线的 rc 补丁
  与正式版」+「0.2.0-rc.1 到 0.2.x」，而 `>=0.1.7-rc.2 <0.3.0` 会顺带放行**没验证过的** 0.3 线。
  注意 `^0.1.7-rc.2` 语义是 `>=0.1.7-rc.2 <0.2.0-0`，**不含** `0.2.0-rc.1` —— 2026-09-28 的真实
  事故正是这一条（DSH 升到 0.2.0-rc.1 后 0.0.13 被整体判为不兼容）。
- **加线之前先逐包比对 API**：把两条线的 `@deepseek-ai/dsh-*` tarball 都 `npm pack` 下来逐文件 diff，
  确认插件用到的部分没变（0.1.7-rc.2 → 0.2.0-rc.1 的实测结论：7 个 peer 里 5 个字节相同，
  `dsh-client-ui-sidebar` 只多 1 行埋点、`dsh-client-ui-layout` 只多一段 Windows 标题栏 CSS；
  0.2.0-rc.1 → 0.2.0-rc.2 的实测结论：16 个包**所有 `.d.ts` 零差异**，13 个只有 `package.json`
  版本号变化，另 3 个只有运行时代码小改动 —— 所以业务代码零改动）。
  比对结论写进 `CHANGELOG.md`。**只改区间不做比对等于赌**。
- **同一条线内的新 rc 也要进验证矩阵**：区间语义本来就覆盖它，不必改 peer，但**必须**把该线的
  **代表版本**换进 `scripts/check-dsh-compat.mjs` 的 `RUNTIMES`、`tests/unit/host-package.test.mjs`
  的 `SUPPORTED_DSH_RUNTIMES`，并让 `devDependencies` 跟着挪到该线 —— 否则 `npm run typecheck`
  与 `compat:dsh` 验的还是旧版本，「支持」只是一句声明。一条线只留一个代表版本，
  同线后续 rc 与正式版由区间语义覆盖（0.2 线的代表是 `0.2.0-rc.2`）。
- 精确版本豁免写在 **profile 自己的 `compatibility.json`**（不在本包），由插件管理器写入；
  「同一个版本只发一次」的纪律意味着**豁免不是升级路径**，改 API 就该发新版本。
- `devDependencies` 里**必须同时列出全部 7 个 peer**（哪怕并不 import）：npm 的 peer 自动安装会为
  「只有 peer、树里没有具体实例」的包去解析**最新**匹配版本，于是新线里那些把 `peerDependencies`
  写成精确版本的包（例如 `@deepseek-ai/dsh-skill-filesystem@0.2.0-rc.1` 要求
  `@deepseek-ai/dsh-fs@0.2.0-rc.1`）会和旧线的 devDep 撞成 `ERESOLVE`。列出实例 = 把开发树钉在
  我们开发所对的那条线上。**接收方不受影响**：profile 的 pnpm 配了 `autoInstallPeers: false`，
  `@deepseek-ai/dsh-*` 从来不由包管理器安装（DSH 运行时自己提供）。`host-package.test.mjs` 那条
  真装 tarball 的回归盯着这一点，`peer 区间必须覆盖每一条我们声明支持的 DSH 运行时线` 那条盯着区间。
- **0.1.7 的 shell 契约变更**：`ShellExecutor.run(spec)` 已不存在，改为 `execute(spec)` 返回进程句柄，
  前台结果在句柄的 `result()` 上（`ShellExecSpec` 另增 `onExpiry`）。本仓的 `runShell` 是唯一调用点，
  测试替身必须跟着 `execute().result()` 走 —— 0.1.5 的 `run` 形状在 0.1.7 上会直接 `is not a function`。

### 8.7 发完再验一次接收方

从 npm（或刚发的 tarball）装进一个干净 profile 验一遍，见 §7.8 —— 预构建产物、`github:` 安装与
`link:` 安装是三条不同的路径，只有第一条是别人真正会走的。

### 8.8 提交前

- 运行产物、临时页面、密钥、测试缓存、`.superpowers/` 不进提交。
- 确认没有覆盖用户已有改动，也没有无关文件。
- 确认用户**已经测过、并且审过代码**（§7.4）。
