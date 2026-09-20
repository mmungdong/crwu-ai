# AGENTS.md

本仓库是一个 **DeepSeek Harness（DSH）插件**。所有代码、目录、测试和发布改动都必须遵守 DSH 的插件装配、Host/Client 分层、Cordis 生命周期与浏览器模块规范。不能把它当作普通 Node.js 网站或独立 React 应用处理。

## 1. 当前形态与修改原则

仓库同时保留两种形态：

- `legacy/`：当前可用的动态 Cordis 插件。DSH 接收 `host.js` 和 `client.js` 两段完整源码字符串，因此这两个交付文件必须保持自包含，不能直接使用相对 `import`。
- `src/`：长期维护的 DSH 包插件源码。TypeScript 源码可以并且应当拆分为多个模块，最终由 `tsdown` 打包成 `lib/index.js` 与 `lib/client.js`。

新架构、类型、可复用工具和长期功能优先进入模块化 `src/`。在包形态尚未具备完整生产能力前，影响当前用户的修复必须同步维护 `legacy/`，并通过 legacy 专项测试。

不要为了拆文件破坏动态插件的交付格式。`legacy/host.js` 和 `legacy/client.js` 是交付产物，不是未来模块化结构的参考模板。

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
├── unit/                            # 与 src 目录领域对应
├── integration/                     # Host 路由、Cordis 装配、Host/Client 协作
└── legacy/                          # 动态插件回归测试
```

目录按业务能力划分，不按“所有 hooks”“所有 helpers”这类技术类别堆放。一个模块只负责一个明确领域。

## 3. 常量、类型和工具

- 常量不得散落在功能代码中。一个目录使用的常量统一放在该目录的 `consts.ts`。
- 只有多个 Host/Client 领域都使用的协议常量，才允许放入 `src/shared/consts.ts`。
- 不建立无边界的全局 `utils.ts`。工具函数按用途放入具名文件，例如 `date.ts`、`json.ts`、`fingerprint.ts`。
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
- Legacy：动态 `host.js` / `client.js` 能在函数壳内解析，RPC 名称成对，关键历史缺陷有回归测试。

测试名称描述可观察行为，不描述“实现正确”。测试不得访问真实氚云、真实 OSS、真实凭据或真实用户文件。

## 7. 每次代码更新后的验证

完成任何一组代码修改后，必须运行与改动相关的测试；向用户交付、提交或推送前必须完整运行：

```bash
npm test
npm run typecheck
npm run build
./install/verify.sh
git diff --check
```

其中：

- `npm test` 必须包含 `tests/` 下全部自动化测试。
- 修改正式 TypeScript 时，`typecheck` 和 `build` 不得省略。
- 修改 `legacy/` 时，`./install/verify.sh` 不得省略，并同步更新 `legacy/REV` 的版本、字节数和 SHA-256。
- 任一验证失败都不能宣称完成、不能提交、不能推动到 DSH。先定位根因并修复；如果失败与本次改动无关，也要在交付说明中明确列出。

## 8. 版本与交付

- 未经用户明确要求，不提交、不推送、不安装到 DSH。
- legacy 改动更新 `legacy/REV`、`CHANGELOG.md` 和必要的安装校验信息。
- 包形态改动遵守语义化版本，更新 `package.json`、`VERSION` 与 `CHANGELOG.md`。
- 运行产物、临时页面、密钥、测试缓存和 `.superpowers/` 目录不得进入提交。
- 提交前确认工作树中没有覆盖用户已有改动，也没有无关文件。
