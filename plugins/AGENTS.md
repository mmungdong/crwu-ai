# DeepSeek Harness 插件与 Skill 开发规范

本文件约束 `plugins/` 下的 DeepSeek Harness（DSH）插件源码、配置、打包、分发和插件内 Skill。
先遵守仓库根目录 `AGENTS.md`，再遵守本文件；更深目录存在 `AGENTS.md` 时，以更具体的规则为准。

## 1. 范围与基本原则

- 只修改并提交 source repo 中获授权的文件。不得直接写入、复制、链接或删除任何运行时 Skill 目录。
- 插件源码、构建产物、部署配置和运行时数据必须保持边界清楚，不得为了省事相互替代。
- 插件专属 Skill 位于 `plugins/*/skills/`，公共 Skill 位于 `plugins/common/skills/`。后文的审核 Skill
  规则重点约束 `crwu-audit-asset-*` 和 `crwu-audit-biz-*`；`crwu-audit-business-*` 仅是待迁移的遗留前缀。
- 先保持开发形态可读、可测试，再由构建工具生成 DSH 可加载的单包产物。打包要求不得反向破坏源码结构。

## 2. DSH 插件源码开发规范

### 2.1 开发源码与打包产物

- `plugins/<插件>/src/` 是开发源码。源码必须保持模块化；即使最终需要输出一个或少数几个插件文件，也只能在
  `build`、`pack` 或发布阶段由构建工具合并。
- 禁止为了生成 TGZ、npm 包或 DSH bundle，手工把 `src/` 中已经分离的功能重新合并到一个源码文件。
- `lib/`、`dist/`、打包后的 JS、source map 和 TGZ 都是派生产物，不得作为日常开发入口，也不得手工修改。
  构建产物需要变化时，修改对应源码或构建配置后重新生成。
- 源码拆分不得改变 DSH 对外加载契约。入口、导出、bundle 名和 Client 模块 ID 等仍由插件自己的
  `package.json`、构建配置和更深层 `AGENTS.md` 约束。

### 2.2 目录与职责边界

- 按运行边界和业务领域组织代码，优先采用 `host/`、`client/`、`shared/`，再在其中按 feature 或 domain
  分目录。不要按“所有 hooks”“所有 helpers”这类无业务边界的技术类别堆放。
- 入口文件只负责命名导出、依赖声明和装配。不得在 `src/index.ts`、`src/client/index.ts` 或同类入口中实现
  路由、服务、数据转换、状态机、复杂 UI 或其它业务逻辑。
- 一个模块只承担一个可清晰命名的职责。路由、服务、外部适配、状态、类型、常量、纯函数和 UI 组件应按职责
  拆分；禁止把所有功能、类型和常量持续堆进一个文件。
- 同一 feature 内部使用的代码留在该 feature；只有真正被多个 Host/Client 领域共同使用的协议类型、常量或
  无运行环境依赖的纯函数，才能进入 `shared/`。
- 不建立无边界的全局 `utils.ts`、`helpers.ts`、`types.ts` 或 `constants.ts`。使用能表达用途的目录和文件名，
  例如 `json.ts`、`fingerprint.ts`、`audit/types.ts`。
- 不为拆分而拆分：紧密相关且能一次读懂的实现可以共处，但当文件混合多个职责、需要跨越很长距离理解，或修改
  一个功能频繁影响无关功能时，必须拆开。
- 修改已有大文件时，至少把本次触及且能够独立命名、测试的职责提取出来；不得借机进行与需求无关的全仓重构。

### 2.3 可读性、命名与注释

- 代码应让后来维护者不依赖打包产物或提交历史就能理解：使用清晰命名、短小函数、提前返回和明确的数据流。
- 保留必要注释，重点解释“为什么”：DSH/Cordis 生命周期限制、安全边界、并发条件、失败恢复、兼容原因、
  外部协议陷阱和看似多余但不能删除的处理。
- 注释不得机械复述代码，不记录讨论过程，不保留已经失效的方案，也不得用大段注释掩盖过度复杂的实现。
- 外部输入应在边界处解析、校验和收窄；内部代码使用明确类型。禁止以无说明的 `any` 或松散对象跨模块传递。
- 函数或文件一旦难以用一句话描述职责，应优先重新划分边界，而不是继续追加分支和共享可变状态。

### 2.4 变更与验证

- 功能变更应配套测试。纯函数、Host 边界、Client 状态和交付形状分别在适合的层级验证，避免只测打包后的偶然表现。
- 源码拆分后至少验证类型检查、相关测试和真实构建；涉及发布形状时还要验证 tarball 内容和安装后的加载入口。
- 提交前执行 `git diff --check`，并确认没有手改构建产物、凭据、缓存、下载正文或无关文件。
- 更深层 `AGENTS.md` 定义了插件专属目录、命令或加载契约时，按其要求执行完整门禁。

## 3. `dsh-crwu-workbench` 配置与分发

### 3.1 命名只有一个事实源

目录名、npm 包名、`cordis.patch.yml` 的 `name:`、`npm pack` 生成的 tarball 文件名和员工侧
`dsh.profile.bundles` 条目都必须是 `dsh-crwu-workbench`。旧名 `dsh-crwu-audit-workbench` 已废弃。

- 单一事实源是 `plugins/dsh-crwu-workbench/package.json` 的 `name`。Makefile 的 `PLUGIN` 表示目录名，
  `PLUGIN_PKG_NAME` 从 `package.json` 读取；不得分别手写两个名字。
- 改名必须同批更新目录、`package.json.name`、patch 的 `name:`、CI 的 `working-directory` 和
  `cache-dependency-path`、接收方测试，以及员工机器上已登记的 bundle 名，避免升级后残留两个包。

### 3.2 统一 YAML 配置

`plugins/dsh-crwu-workbench/config/crwu-workbench.yml` 是工作台唯一部署配置源。开发运行、TGZ、员工安装后的
运行时和 OSS 分发都从这一份 YAML 解析；不得在 Makefile、`cordis.patch.yml`、TypeScript 默认常量或发布脚本
中再维护一套相同地址或行为参数。

#### OSS 边界

- `oss.readonly` 是匿名只读 Bucket，保存环境清单、安装说明和员工下载的插件 TGZ；`manifestKey`、
  `installDocKey`、`pluginPrefix` 都相对它的 `baseUrl`/`bucket` 解析。
- `oss.protected` 是审核交付件私有 Bucket，匿名访问应返回 403；保存 `auditPrefix`、签名模式与 TTL。
  插件使用员工机器上的 OSS 凭据上传，并默认生成签名 URL。
- YAML 与 TGZ 不得包含 AK、SK、STS Token、签名 URL 或其它临时凭据。配置只保存 Bucket、Endpoint、
  Base URL、对象前缀和行为参数；凭据只能保存在员工机器的凭据存储中。
- 不得用旧字段名 `publicBaseUrl` 描述私有 Bucket。新增字段使用 `baseUrl`/`objectBaseUrl`，公开性由 Bucket
  权限与 `linkMode` 决定。

#### 开发与 TGZ 加载契约

- 源码开发默认读取上述 YAML。临时验证其它配置时，只能通过 `CRWU_CONFIG_FILE=/绝对路径/config.yml`
  或开发 Cordis 配置的 `configFile` 显式选择。
- `configFile` 留空时，源码形态寻找插件根的 `config/crwu-workbench.yml`，安装形态寻找 TGZ 内同一路径。
  文件缺失、YAML 无法解析或 Schema 不合法时必须拒绝激活，不得静默使用作者地址。
- `npm pack` / `make plugin-pack` 前必须运行 `npm run config:check`；`package.json.files` 与
  `scripts/assert-pack.mjs` 必须共同保证 YAML 真正进入 TGZ。
- 真实打包回归必须覆盖 `npm pack → npm install → apply()`，证明安装后的 Host 从包内 YAML 激活，
  而不是只检查 tarball 文件列表。

#### 运行与分发解释权

- 远程环境清单只提供二进制与服务目录；私有 OSS 的 bucket、endpoint、prefix、链接模式、TTL 和自动上传
  策略以 YAML 为最终解释权。
- `env` RPC 不得接受请求级 `source` 替换 YAML 确定的清单地址；远程清单不得向宿主注入 `probeCommand`
  或其它自由格式 Shell。
- `make plugin-dist` / `scripts/dist-plugin.mjs` 必须从 `oss.readonly` 计算 `oss://` 上传目标与员工 HTTPS
  安装地址，并遵守“同版本对象不可覆盖”。
- 修改 YAML 结构或字段时，必须同批更新解析类型、Schema 校验、`config:check`、Host 映射、分发推导、
  TGZ 断言、README、CHANGELOG 和版本号；最低测试为 `host-yaml-config.test.mjs`、
  `dist-config.test.mjs` 与 `host-package.test.mjs`。

## 4. 审核 Skill 的领域与维护流程

### 4.1 资产轴与业务轴

- 资产 Skill 只负责对象或资产类型的专业规则，例如权属、物理和经济特征、资产特有方法前提及对象特有风险。
- 业务 Skill 只负责评估目的、经济行为和场景规则，例如出租、处置、拍卖、抵押担保、减值测试对口径、材料和
  判断的影响。
- `business_types[]` 只使用 `01-业务路线/` 下的一级业务标签：资产经营、交易与处置、财务报告、融资与债务、
  投资与资本运作、税务与历史确认、司法清算与补偿、咨询复核与其他，以 `04-business-classification.md` 为准。
  租赁、清算、破产、拍卖、抵押质押、减值测试、计税、追溯评估、复核等历史行为词只作为命中信号，不作为
  标签、不占 registry 行、不单独建 Skill。
- 同一报告命中两个轴时，由 `crwu-audit` router 对各轴 Skill 做稳定并集加载；任何一轴不得替代另一轴。
- 禁止创建 `asset × business` 组合 Skill。交叉场景由 router 装配，不复制两轴内容或新增组合目录。
- 新建或扩展资产 Skill 前检查 `crwu-audit/references/03-asset-classification.md`；业务 Skill 检查
  `04-business-classification.md`。标签、状态或映射变化时同步更新 `07-skill-registry.md`。

### 4.2 一级 Skill 与知识库粒度

- 资产 Skill 只映射 `02-资产类型/` 下一个一级资产目录；业务 Skill 只映射 `01-业务路线/` 下一个一级业务目录。
- `01-kb-assembly.md` 对该轴只登记一个精确一级根，设置 `request_kind=directory`、`recursive=true`、
  `required=true`，并用 `expected_structure` 断言根内结构。正式审核命中后由 `crwu-dws` 递归下载该根内
  全部支持正文，不得退回逐文件挑选。
- 一级根逐字使用库内精确路径，包括 `01-` 等排序前缀；不得按显示名简写或从其它库推断。
- 寻址键逐字使用库内节点名：`crwu-dws` 的 `by_path` 不折叠大小写或全半角。单文件项不得带 `.md`，目录项
  必须以 `/` 结尾。`.md` 只是导出后的本地文件后缀，写入寻址键会与 `by_path` 不匹配并在 M2 记 failure；
  旧库中节点名自带 `.md` 的历史残留不得沿用。
- 细分对象与子业务只作为父 Skill 的二级选择索引，不各建 Skill、不各占 registry 行。
- 资产 Skill 先读取一级根的 `01-共性参考/` 全部正文，再叠加命中对象的 `评估审核条目`。业务 Skill 先执行
  一级根直接文档 `共同审核点`（若存在），再执行命中子业务的 `01-业务通用审核要点` 和关联文件。
- `共同审核点` 是一级业务共用层，命中任一子业务都执行；不存在时不记缺口，也不得归入某个子业务。
- 缺少资产 `01-共性参考/`、细分对象 `评估审核条目` 或子业务 `01-业务通用审核要点` 属于知识内容 gap。
  必检项写“待补”、正文为空或只有 `TODO` 同样记 gap，并声明覆盖不完整；不得创建空 Skill 或凭标题、历史摘录补造规则。

### 4.3 知识库驱动流程

对每个命中的 `axis + label` 按顺序执行：

1. 经 `crwu-dws` 只读拉取最新目录，记录 `fetchedAt`、`complete`、`failures`，再定位业务路线、资产类型、
   规则库、审核清单和必要文件。缓存只用于定位；刷新失败时只能输出候选并标注“非本次在线结果”。
2. 形成“本次来源清单”，列出库内层级路径、文件或目录类型、预期 RULE/CHK 范围和读取状态。目录快照不是正文证据。
3. 按库内路径实时读取正文，不得仅凭经验、旧缓存、历史摘录或文件名编写审核要点。
4. 逐文件核对 RULE/CHK 编号、适用条件、必备材料、检查步骤、判断标准、冲突或例外、输出证据要求。
5. 基于真实读取材料归纳审核要点，分别维护装配寻址与审核要点；不得把知识库正文复制进 Skill。

资料缺失、实时下载失败、来源冲突或内容不足时不得猜测：

- 完全无法定义：保持 `pending`，或记录 capability gap 与人工确认项，不得标 `available`。
- 部分可真实归纳：可以标 `available`，但必须在对应叶子明确声明覆盖不完整并登记 gap，不得补造缺失部分。
- 其它 `available` Skill 仍按 router 规则继续并集加载，不因单点 gap 停止整轴能力。

### 4.4 变更归口

两个元技能都不经 `crwu-audit` 路由，也不产出审核判断：

| 变更类型 | 归口 | 说明 |
| --- | --- | --- |
| 规则/清单内容、词表取值、叶子算法与流程 | `crwu-dev-audit-optimize` | 从漏检、误检和复核反馈诊断根因；知识库项只生成 `manual_only` 修复单，Skill 项逐项确认后执行 |
| 一级 Skill 新增改名、一级根、registry、classification、遗留命名迁移 | `crwu-dev-audit-skill-maintainer` | 使用 `audit`/`create`/`repair`/`remap`；`audit` 只读并同步校准表 |

- 两者都先给逐文件方案，用户确认后才改文件。门禁与校验口径只在 maintainer 的 `references/04`、`05`
  定义一次，optimize 不重复定义。
- 同时存在 AI 结果与人工复核文件时，由 optimize 输出 `L-* → 根因 → FIX-*` 差距报告。知识库对 AI/CLI
  永远只读，即使方案获批也只能由用户人工修改。
- 结构或映射问题由 optimize 给出根因和最低改动集，再交接 maintainer；交接不继承修改授权。
- 现状速查读取 maintainer 的 `references/07-kb-skill-map.md`，每次校准后刷新。

#### 审核族前缀

- `crwu-audit-*`：router、`crwu-audit-asset-*`、`crwu-audit-biz-*`、`crwu-audit-datacheck`、
  `crwu-audit-external-data`、`crwu-audit-output-filter`、`crwu-audit-public-general-standards`。
- `crwu-dev-audit-*`：`crwu-dev-audit-optimize`、`crwu-dev-audit-skill-maintainer`。
- `kb_tool.py` 和 `check_audit_skill_mappings.py` 必须扫描两组前缀。新增或迁移前缀时同批更新两处常量，
  否则技能会静默掉出门禁。
- 前缀改名至少同步：技能自名、registry、classification、`08-union-dispatch-rules.md`、router `SKILL.md`、
  叶子引用、两个门禁脚本、三个契约测试、`docs/skills.md`、现行设计文档和变更纪要。带日期的历史记录不回改。

## 5. Skill 自洽性与目录内聚

每个 Skill 必须在作为副本独立安装后可用。运行时所需内容必须位于该 Skill 目录内；仓库目录、仓根文件和其它
仓库路径在安装后都视为不存在。

### 5.1 禁止引用

`plugins/<插件>/skills/<skill>/` 内的 `SKILL.md`、`references/`、`scripts/` 不得引用：

- 仓库目录 `docs/`、`tools/`、`cmd/`、`internal/`、`bin/` 或仓根文件 `Makefile`、`go.mod`；
- 逃出 Skill 目录的相对路径，例如 `../../docs/`；
- 以仓库根为前缀的跨 Skill 路径，例如 `skills/<技能>/` 或 `plugins/<插件>/skills/<技能>/`。

### 5.2 正确写法

| 需求 | 写法 |
| --- | --- |
| 解释、口径、设计依据 | 写入本 Skill 的 `references/`，不把源仓设计文档作为运行时读物 |
| 运行脚本 | 放入本 Skill 的 `scripts/`，在 Skill 目录执行 `python3 scripts/<file>` |
| 调用其它 Skill 的脚本 | 写明目标 Skill 和 `scripts/<file>`，命令使用 `python3 "$SKILLS_ROOT/<技能名>/scripts/<file>"` |
| CLI 用法与字段 | 以 `crwu scheme` 和 PATH 中的 `crwu` 为准，不引用仓库手册路径 |
| 脚本定位 skills 根 | 由 `Path(__file__).resolve().parents[N]` 上溯推导，禁止硬编码仓库布局 |
| 源仓变更登记 | 使用功能性表述，不写运行时依赖的仓库路径 |

### 5.3 脚本归属与例外

- 脚本只归属一个负责它的 Skill，并随 Skill 安装。`audit_delivery.py` 及其 schema/examples 归 `crwu-audit`；
  `kb_tool.py` 归 maintainer；三个契约测试归各自被测 Skill 的 `scripts/`。
- 脚本和对应 `README.md`、schema、`examples/`、`test_*.py` 同目录安置；不得依赖部署环境注入可执行路径。
- 外部工具确由第三方提供时，必须写明“本仓不提供、不随 Skill 安装”，不得描述成 Skill 资产。
- 仅在源仓运行的契约测试或维护工具，可以在文件头 30 行内声明“源仓契约测试”或“源仓维护工具”后定位源仓，
  但不得被 `SKILL.md` 当作运行时步骤。源仓文档缺失时必须显式 skip；`_REQUIRED_SIBLINGS` 中任一技能不存在、
  即只安装了技能族的子集时也必须显式 skip。单独安装 Skill 后，其自带测试只能通过或 skip，不得失败。

### 5.4 迁移与机器门禁

本节与仓库根 `AGENTS.md` 的 Skill Self-Containment 是同一规则；改动任一处必须同步另一处。

- 搬迁或改写时同批更新脚本路径常量（包括由 `__file__` 推导的 `REPO_ROOT`/`SKILLS_ROOT`）、所有现行引用、
  `docs/skills.md`、源仓设计文档和 CHANGELOG。
  带日期的历史变更、评审记录以及 `docs/superpowers/plans|specs/*` 不回改。
- 两个技能根都必须通过 `kb_tool.py validate` 且 error=0：插件专属根
  `plugins/dsh-crwu-workbench/skills` 与公共根 `plugins/common/skills`。
- `plugins/AGENTS.md`、`docs/skills.md` 等源仓文档不在技能根内，不属于 Skill 自洽性 lint 的扫描对象。

## 6. 审核叶子的 `SKILL.md` 与 references

本节只适用于 `crwu-audit-asset-*` 与 `crwu-audit-biz-*` 的知识装配内容，不扩大为其它 Skill 的全局禁令。

- 不得保存或硬编码知识库名称、个人绝对路径、本地正文路径、`nodeId` 常量值，也不得逐字复制知识库正文。
  只保存 RULE/CHK 编号、库内层级路径寻址键，以及基于本次真实读取归纳的审核要点。
- 可以定义 `nodeId` 协议字段。运行时 manifest 和输出也可以携带本次 `crwu-dws` 返回的值，但不得把值写回源码。
- `SKILL.md` 保持入口化，只包含职责边界、输入、必读 reference、执行步骤和输出门禁；资产和业务叶子必须声明
  “仅经 `crwu-audit` 编排调用、禁止单独调用”。
- 推荐最小结构：
  - `00-applicability.md`：canonical label 的适用、排除、边界及二级对象识别规则；
  - `01-kb-assembly.md`：只记录 RULE/CHK 与库内路径键；先写一级根映射
    `source_key`/`owner_axis`/`canonical_label`/`kb_root`/`request_kind`/`recursive`/`required`，再写
    `expected_structure`、二级选择索引和其它轴共享依赖。目录或文件名变化时必须同步更新；
  - `02-review-focus.md`：基于真实资料归纳的审核要点，每项回指 RULE/CHK 和库内路径。
- 公共规则只写一份，统一放在 `crwu-audit/references/12-leaf-common-contract.md`。叶子只引用它并保留
  本轴、本标签的特有内容；新建叶子以任一 `crwu-audit-biz-*` 四件套为版式基线。
- 可以增加其它 reference，但每个文件只承担一个职责，且不得成为知识库正文副本。
- 实际审核仍须通过 `crwu-dws` 重新下载正文。最终出处至少包含本次下载文件、实际行号、库内路径、运行时
  `nodeId` 和 `exportedAt`；reference 映射不能替代本次下载证据。

## 7. `available` 能力完成门禁

新增或扩展 `axis + label`，以及将 `pending` 改为 `available`，必须同批满足：

- 分类、`07-skill-registry.md`、`SKILL.md`、`00-applicability.md`、`01-kb-assembly.md`、
  `02-review-focus.md` 边界一致；设计文档、`docs/skills.md`、变更记录和测试已同步。
- 受影响 Skill 通过 skill-creator 的 `quick_validate.py`，router contract 与 DWS source contract 通过。
- 两个技能根都通过 `kb_tool.py validate`。经批准的分阶段迁移若暂不能通过，必须记录实际命令、失败项和待同步
  内容，不得宣称完整可用。
- 映射检查器基于本次最新目录运行且 error=0，覆盖一级根精确匹配、轴前缀、registry/classification 一致性、
  遗留命名和库内路径键存在性（包括公共轴）；warning 必须逐条判断并注明理由。
- 使用 `--emit-map` 刷新 `references/07-kb-skill-map.md`，并如实填写内容级核对结论与 gap；未下载正文时写“未核”。
- 新叶子引用 `12-leaf-common-contract.md` 且未复述公共规则。
- `git diff --check` 通过，提交范围仅包含获授权改动。

不得为了占位创建空的 pending Skill。凭据、知识库下载正文、临时清单、缓存和运行时文件不得提交；Skill 与
reference 资产只能提交到 source repo。

### 常用契约命令

在仓库根执行：

```bash
S=plugins/dsh-crwu-workbench/skills
python3 "$S/crwu-dev-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py"
python3 "$S/crwu-audit/scripts/test_audit_multiaxis_router.py"
python3 plugins/common/skills/crwu-dws/scripts/test_dws_source_contract.py
python3 "$S/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py" validate --skill-root "$S"
python3 "$S/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py" validate --skill-root plugins/common/skills
python3 "$S/crwu-dev-audit-skill-maintainer/scripts/check_audit_skill_mappings.py" \
  --repo-root . --catalog <本次快照> --max-age-hours 2 \
  --emit-map "$S/crwu-dev-audit-skill-maintainer/references/07-kb-skill-map.md"
git diff --check
```

## 8. 资产或业务能力检查单

- [ ] 已确认轴和 canonical label，未创建组合 Skill。
- [ ] 已核对目录树并形成“本次来源清单”。
- [ ] 已通过 `crwu-dws` 逐文件实时读取，未用旧缓存代替正文。
- [ ] 每个审核要点均可回指 RULE/CHK 和库内层级路径。
- [ ] 最终出处包含本次下载文件、实际行号、库内路径、运行时 `nodeId` 和 `exportedAt`，且未回写 `nodeId` 值。
- [ ] 一级根逐字等于库内节点名，`directory`/`recursive`/`required` 三键齐全。
- [ ] 单文件寻址键不带 `.md`，目录键以 `/` 结尾，所有键与库内节点名逐字一致。
- [ ] 业务叶子已处理 `共同审核点`：存在则回指，不存在则如实记“未发现”且不记 gap。
- [ ] “待补”、空正文和 `TODO` 已登记为 gap，未补造要求。
- [ ] 新叶子引用公共合同且未复述共同规则。
- [ ] 分类、registry、Skill、references、文档、测试和校准表已同步。
- [ ] 所有门禁已运行并保留结果；缺失或冲突已记录为 pending、gap 或人工确认项。
- [ ] 提交中不含凭据、下载正文、运行时文件或无关改动。
