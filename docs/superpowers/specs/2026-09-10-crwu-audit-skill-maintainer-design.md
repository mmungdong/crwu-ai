# crwu-audit-skill-maintainer 设计规范

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-10 |
| 状态 | 待用户审阅 |
| 目标位置 | `skills/crwu-audit-skill-maintainer/` |
| 适用仓库 | `crwu-ai` source repo |

## 1. 背景

`crwu-audit` 已采用多轴画像和稳定并集路由。资产、业务、方法、监管和公共能力分别维护，运行时由 router 根据 canonical label 和 registry 加载相应 Skill。

随着钉钉知识库目录调整和审核叶子持续增加，维护者目前需要人工完成多项关联工作：

- 判断新增能力属于资产轴还是业务轴；
- 从钉钉知识库目录中逐个寻找关联文件；
- 下载并核验规则正文；
- 创建或者修正叶子 Skill 及其 references；
- 同步分类表、registry、README、设计文档和变更记录；
- 检查知识库路径改名、Skill 改名和映射漂移。

人工逐项维护容易留下 registry 指向不存在的目录、Skill 目录名与 frontmatter 不一致、知识库旧路径残留等中间状态。需要一个专门的维护编排 Skill 统一处理上述生命周期。

## 2. 目标

新建 `crwu-audit-skill-maintainer`，用于：

1. 创建新的 `crwu-audit-asset-*` 或 `crwu-audit-business-*` 子 Skill。
2. 修正现有资产或业务子 Skill 的结构、名称、适用边界和 references。
3. 根据钉钉知识库最新目录重新计算子 Skill 的知识文件映射。
4. 检查全部资产、业务 Skill 与分类表、registry、知识库路径之间的一致性。
5. 在用户确认变更方案后，同步更新 source repo 中的映射和登记文件。

核心结果是让维护者提供一个 `axis + canonical label` 或目标 Skill，系统主动完成来源发现、正文核验、映射设计、文件修改和验证，不再要求维护者逐个核对知识文件。

## 3. 非目标

本 Skill 不负责：

- 执行正式评估报告审核；
- 产生专业审核意见；
- 替代 `crwu-audit` 的运行时路由；
- 替代 `crwu-dws` 的钉钉查询和下载职责；
- 依据复核反馈判断漏检、误检根因；该职责仍属于 `crwu-audit-optimize`；
- 修改钉钉知识库正文或者远端目录；
- 安装或直接修改 `~/.dsh`、`~/.workbuddy`、`~/.skills-manager` 等运行时 Skill；
- 创建 `资产 × 业务` 组合 Skill。

## 4. 与现有 Skill 的边界

| Skill | 唯一职责 | 与本 Skill 的关系 |
| --- | --- | --- |
| `crwu-audit` | 正式审核的画像、路由、并集加载和结果汇总 | 本 Skill读取并维护其分类表和 registry，不参与正式审核 |
| `crwu-dws` | 钉钉知识库目录查询、路径定位和正文实时导出 | 本 Skill通过它获得最新目录和本次维护所需正文，不复制其命令逻辑 |
| `crwu-audit-optimize` | 根据漏检、误检、反馈和回测结果诊断需要修改什么 | 诊断结论涉及创建、修正或重映射子 Skill 时，交由本 Skill执行 |
| `crwu-audit-skill-maintainer` | 审核子 Skill 的创建、修正、映射和一致性维护 | 不出审核意见，不经 `crwu-audit` router 分发 |

## 5. Skill 结构

```text
skills/crwu-audit-skill-maintainer/
├── SKILL.md
├── references/
│   ├── 00-responsibility-and-modes.md
│   ├── 01-kb-source-discovery.md
│   ├── 02-child-skill-contract.md
│   ├── 03-registry-and-mapping-update.md
│   └── 04-validation-and-delivery.md
└── scripts/
    └── check_audit_skill_mappings.py
```

不创建 README、示例占位目录或下载正文副本。

### 5.1 `SKILL.md`

入口文件保持精简，只包含：

- 触发条件与禁止场景；
- 四种运行模式；
- 输入要求；
- 必读 reference 路由；
- 总体执行步骤；
- 修改审批门禁；
- 失败和停止条件；
- 输出要求。

### 5.2 references

- `00-responsibility-and-modes.md`：职责边界、模式选择和输入规范。
- `01-kb-source-discovery.md`：如何根据 axis、label、最新目录树和治理文件推导来源清单。
- `02-child-skill-contract.md`：资产/业务子 Skill 的目录、frontmatter、references 和内容边界。
- `03-registry-and-mapping-update.md`：分类表、registry、装配表、README、设计文档和变更记录的同步规则。
- `04-validation-and-delivery.md`：校验命令、验收条件、失败输出和交付格式。

### 5.3 映射检查脚本

`check_audit_skill_mappings.py` 是只读检查器，不直接修改文件。它读取：

- `crwu-audit/references/03-asset-classification.md`；
- `crwu-audit/references/04-business-classification.md`；
- `crwu-audit/references/07-skill-registry.md`；
- `skills/crwu-audit-asset-*` 和 `skills/crwu-audit-business-*`；
- 指定的 DWS `node-index.json` 或本次最新目录快照。

它输出 JSON 和人类可读摘要，至少检测：

- registry 中的 available Skill 目录不存在；
- Skill 目录名、frontmatter `name` 和 registry 名称不一致；
- available 子 Skill 缺少规定的 references；
- classification 标签未在 registry 中恰好登记一次；
- registry 指向旧 Skill 名称；
- `01-kb-assembly.md` 中的库内路径在最新目录中不存在；
- source repo 存在未登记的资产或业务 Skill；
- 装配表保存了知识库名称、本地绝对路径或 nodeId 常量。

脚本不根据名称相似度自动改路径。它只提供候选和证据，由本 Skill在读取正文并取得用户确认后修改。

## 6. 运行模式

### 6.1 `create`

适用于新增资产或业务能力。

输入至少包括：

- `axis=asset|business`；
- canonical label；
- 目标 Skill 名称，或者允许本 Skill按照命名规则生成；
- source repo 路径；
- 目标钉钉知识库名称或者当前已确认空间。

输出新增方案，确认后创建子 Skill、references，更新分类和 registry，并完成验证。

### 6.2 `repair`

适用于已知目标 Skill 的名称、结构、边界、路径或 references 错误。

先生成当前状态与目标状态差异，再由用户确认修改范围。不得借修复目标 Skill 顺带改动其他叶子。

### 6.3 `remap`

适用于钉钉知识库目录调整、文件改名或者装配路径失效。

以最新 DWS 目录为路径事实，以本次实时导出的正文为内容事实，重新生成目标 Skill 的 `01-kb-assembly.md` 映射。不得仅用旧缓存、历史摘录或文件名相似度确认新路径。

### 6.4 `audit`

只读检查全部资产和业务子 Skill，不修改文件。输出：

- 正常映射；
- 失效路径；
- 缺失 Skill；
- 未注册 Skill；
- 名称不一致；
- 缺失 references；
- 待人工确认项。

## 7. 知识来源发现

### 7.1 目录事实与正文事实

- 目录事实来自 `crwu-dws` 本次在线完整遍历。缓存只用于定位加速；在 `remap` 和 `create` 模式下必须刷新后再确认。
- 正文事实来自本次通过 `crwu-dws` 实时导出的 Markdown。
- 下载文件仅存放于本次维护临时目录，并附 manifest；任务结束后不提交、不复制到 Skill，也不写入目录缓存。
- source 中只保存 RULE/CHK 编号、库内层级路径和归纳后的审核要点。
- 不保存知识库名称、个人绝对路径、nodeId 常量或逐字复制的知识库正文。

### 7.2 维护控制资料

每次创建或重映射前，先定位并读取与本次任务有关的治理资料：

- 目录地图；
- 标签词典和同义术语表；
- 审核模块注册表；
- 知识库内容编写与维护规范；
- 相关业务路线 README 或业务通用审核文件；
- 相关资产类型的定义、对象准则和已启用细分对象；
- 必要的规则库、方法索引和监管索引。

目录快照只用于形成候选清单。只有正文实际下载并读取成功，候选路径才可写入正式映射。

### 7.3 资产轴来源规则

资产 Skill 的候选来源以 `02-资产类型/<资产>/` 为主，包括：

- 资产定义与分类；
- 对象准则及精编条目；
- 当前已启用的细分对象；
- 适用于该资产全部业务的对象共性风险；
- 明确登记为该资产共性的规则模块。

不得把租赁、抵押、转让等具体业务要求写入资产 Skill。

### 7.4 业务轴来源规则

业务 Skill 的候选来源以 `01-业务路线/<业务大类>/<具体业务>/` 为主，包括：

- 业务定义、识别条件和排除条件；
- 业务通用审核要点；
- 业务目录登记的资产专项文件；
- 方法适用索引；
- 监管适用索引；
- 该业务历史问题和经复核经验。

业务目录中的资产专项文件可以由业务 Skill按 `route_profile.asset_types[]` 条件加载，但不能据此创建组合 Skill。资产对象共性仍由对应资产 Skill提供。

### 7.5 公共和其他轴来源

- 全局执行契约由 `crwu-audit` router 统一装配，不重复写入每个叶子，除非现有兼容行为尚未迁移且验证证明仍需要保留。
- 方法正文属于方法 Skill；业务和资产 Skill只保存适用索引或者条件依赖。
- 监管正文属于 overlay Skill；业务和资产 Skill只保存触发条件和适用索引。
- 兼容迁移必须分阶段完成，不能在没有回归验证时删除既有依赖。

## 8. 子 Skill 合同

资产和业务叶子统一采用：

```text
crwu-audit-asset-<label>/
或 crwu-audit-business-<label>/
├── SKILL.md
└── references/
    ├── 00-applicability.md
    ├── 01-kb-assembly.md
    └── 02-review-focus.md
```

### 8.1 调用边界

每个资产、业务叶子必须声明：

- 仅允许由 `crwu-audit` 编排调用；
- 不重新获取项目记录；
- 不替代其他轴；
- 不创建组合 Skill；
- 规则正文必须来自本次 `crwu-dws` 下载；
- 下载失败时记录 gap，不编造结论。

### 8.2 `00-applicability.md`

保存 canonical label 的适用、排除、冲突和人工复核条件。资产 Skill只描述对象边界；业务 Skill只描述评估目的和经济行为边界。

### 8.3 `01-kb-assembly.md`

每条映射至少包含：

| 字段 | 含义 |
| --- | --- |
| source key | 稳定的本地映射标识 |
| owner axis | asset 或 business |
| applicability | 无条件或 route profile 条件 |
| KB path | 完整库内层级路径 |
| request kind | file 或 directory |
| expected IDs | 预期 RULE/CHK 范围 |
| required | 必需或可选 |

路径必须来自本次目录解析结果；RULE/CHK 必须来自本次正文读取结果。

### 8.4 `02-review-focus.md`

保存从真实来源归纳的审核关注点。每个关注点必须回指 source key、RULE/CHK 和库内路径，不逐字复制正文。

## 9. 分类、registry 和映射同步

### 9.1 创建新标签

新增资产标签时同步：

1. `03-asset-classification.md`；
2. `07-skill-registry.md`；
3. 新资产 Skill；
4. `skills/README.md`；
5. 设计文档和 `docs/CHANGELOG.md`。

新增业务标签时同步：

1. `04-business-classification.md`；
2. `07-skill-registry.md`；
3. 新业务 Skill；
4. `skills/README.md`；
5. 设计文档和 `docs/CHANGELOG.md`。

### 9.2 修复或改名

Skill 改名必须同时检查：

- 目录名；
- frontmatter `name`；
- registry；
- router 和 references 中的名称引用；
- `skills/README.md`；
- 设计文档、测试和变更记录。

不得出现 registry 已标记 `available`，但真实目录、必备 references 或验证尚未完成的状态。

### 9.3 状态规则

- `available`：真实 Skill、三份 reference、知识来源、映射和所有完成门禁均已通过。
- `pending`：分类已识别但能力尚未完成，只在 registry 记录，不创建空 Skill 目录。
- `profile-only`：仅保留画像，不需要执行 Skill。

## 10. 修改门禁

本 Skill每次执行分成两个阶段：

### 阶段一：只读分析

1. 记录 git 基线状态和目标文件 hash。
2. 读取 classification、registry、目标 Skill 和 references。
3. 刷新 DWS 目录，形成来源清单。
4. 下载并读取必要正文。
5. 输出《子 Skill 维护方案》，逐文件列出拟新增、修改、移动和删除内容。

阶段一不得修改 source repo。

### 阶段二：确认后修改

用户明确确认方案后：

1. 检查目标文件相对阶段一是否发生变化；发生变化立即停止并重新分析。
2. 只修改方案列出的 source repo 文件。
3. 不改运行时 Skill 目录。
4. 更新分类、registry、references、README、设计文档和变更记录。
5. 执行完整验证并输出结果。

用户只要求 `audit` 时永不进入阶段二。

## 11. 验证

### 11.1 映射检查器测试

使用临时 fixture 覆盖：

- available Skill 完整存在；
- available Skill 目录缺失；
- frontmatter 与目录名不一致；
- classification 标签重复或漏注册；
- 必备 reference 缺失；
- KB path 存在和不存在；
- orphan Skill；
- 禁止字面和 nodeId 常量；
- business/asset 轴命名错误。

### 11.2 仓库门禁

实现后至少运行：

```bash
python3 tools/kb/test_audit_skill_maintainer.py
python3 tools/kb/test_audit_multiaxis_router.py
python3 tools/kb/test_dws_source_contract.py
python3 tools/kb/kb_tool.py validate --skill-root skills
python3 <skill-creator>/scripts/quick_validate.py skills/crwu-audit-skill-maintainer
git diff --check
```

如果 `kb_tool validate` 因本地知识库索引不存在或经批准的迁移中间态失败，必须报告真实失败项，不得宣称完整通过。

### 11.3 验收场景

第一版至少证明：

1. 能发现 registry 指向不存在的 available Skill。
2. 能发现旧 `crwu-audit-realestate-rent` 与新 business-axis 命名不一致。
3. 能发现旧房地产装配路径与最新目录树不一致。
4. 能为 `asset=房地产` 和 `business=租赁` 分别形成来源候选，不生成组合 Skill。
5. 能在用户确认后更新映射，同时保留工作区中的无关修改。

## 12. 失败处理

- DWS 在线刷新失败：不创建、不重映射、不把缓存结论标为最新；输出失败原因。
- 路径出现零命中或多命中：保持 pending 或待确认，不猜路径。
- 正文下载失败：对应来源不得进入正式映射。
- RULE/CHK 冲突：并列记录冲突和来源，等待专业确认。
- source repo 在方案确认前后发生变化：停止修改，重新计算差异。
- 工作区存在无关修改：保留且不提交；无法隔离目标文件时停止并请求用户处理。
- 验证失败：保持真实状态，不把能力改为 available。

## 13. 交付结果

每次运行输出：

1. 目标 axis、label 和 Skill；
2. 本次 DWS 目录抓取时间与空间身份；
3. 本次来源清单及下载状态；
4. classification 和 registry 变化；
5. 子 Skill 与 references 变化；
6. 映射新增、失效和待确认项；
7. 验证命令与真实结果；
8. 未完成项和 capability gap；
9. 本次实际修改的 source repo 文件清单。

下载的知识库正文、凭据、运行时 manifest 和临时文件不进入提交。

## 14. 初始实现范围

第一版完成：

- 新建 `crwu-audit-skill-maintainer` 及五份 references；
- 新建只读映射检查脚本及测试；
- 在 `skills/README.md` 登记维护 Skill；
- 在 `crwu-audit-optimize` 中增加经确认后的维护交接说明；
- 更新相关设计文档和变更记录；
- 使用当前房地产资产与租赁业务的迁移状态验证检查器能够发现问题。

第一版不自动批量修正所有现有资产和业务 Skill。实际修复由本 Skill输出逐文件方案，并在用户再次确认后执行，以免覆盖当前正在进行的迁移工作。
