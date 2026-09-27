# references/01 · 取数路径发现与调用规程（crwu-audit-external-data）

> 本文件只规定**怎么找到并调用**同花顺 iFinD 的取数入口，以及找不到时怎么办。
> 本技能不启用万得。要核哪些数据项、每项的口径要求与结论档位由知识库
> `06-规则库/M-外部数据核验/01-模块-外部数据核验`（表 A / 表 B / 表 C）规定，本文件不复制；
> 库内表 D 为取数失败与降级口径（单源），双源复核不适用（见 §6）。

## 1 唯一数据源 = 同花顺 iFinD，但入口随宿主而异

同花顺 iFinD 在不同宿主以不同形态提供，**不要用一个宿主的事实推断另一个宿主**：

| 宿主 | 取数路径 | 形态与调用 | 凭据归属 |
| --- | --- | --- | --- |
| WorkBuddy | 宿主内置连接器 | MCP 服务，连接器 id `ifind-mcp`（服务端授权）；会话可能直接暴露其 MCP 工具，否则读宿主连接器声明 | 宿主托管 |
| DeepSeek Harness | 结构化 Tool `crwu_audit_ifind_query` | 由 Host 执行固定 iFinD MCP HTTP 协议；`operation=list_tools` 查权益内工具清单、`operation=query` 取数 | Host 按环境清单声明的固定位置读取（模型不可提交、不可读取、不可见） |

- 两条宿主入口取的是**同一上游 iFinD 服务**，取回值可视为同一数据源；进入 `sources[]` 时统一写
  `同花顺 iFinD`，本次实际走哪条路径写进 `note`。
- DeepSeek Harness 侧**不再**调用任何第三方技能脚本：取数入口是宿主的结构化 Tool
  `crwu_audit_ifind_query`（注册、审批、超时、取消、脱敏都在 DSH 的工具链里）。
  服务地址与 `serverType` 映射是 Host 的内部固定表，模型只提交 `operation` / `serverType` /
  `toolName` / `params`。**不得**搜索技能根（`~/.agents`、`~/.dsh`、`~/.codebuddy`、`~/.claude` 等）、
  **不得**执行任何第三方技能自带的调用脚本、**不得**在第三方技能目录写临时脚本、
  **不得**读取任何第三方技能的凭据配置文件。
- 禁止把万得列为数据源，也禁止声称已做双源复核（本环境无万得）。

## 2 发现顺序（逐级降级，不得跳级）

| 级 | 动作 | 判据 |
| --- | --- | --- |
| L1 | 使用**当前会话已暴露的取数入口** | WorkBuddy：会话已暴露同花顺 iFinD 的 MCP 工具；DeepSeek Harness：`crwu_audit_ifind_query` 对当前 Agent 可见 |
| L2 | 读**宿主声明**（仅 WorkBuddy；L1 未暴露时） | 见 §3（WorkBuddy 连接器声明）；命令：`<WorkBuddy 宿主可用的绝对 Python 路径> scripts/connector_probe.py --format json`。**DeepSeek Harness 无此级**——入口就是结构化 Tool 的可见性，不读宿主声明、也不运行本探测脚本 |
| L3 | 入口存在但**未启用 / 未认证** | 按 §5 降级并在交付件声明 |
| L4 | 完全不存在 | 按 §5 降级并在交付件声明 |

**逐宿主判定，不得跨宿主推断。** WorkBuddy：L1 未暴露**不等于**数据源不可用——必须继续走 L2 读宿主声明，
不得直接判"无数据源"。DeepSeek Harness：只有 L1（结构化 Tool 对当前 Agent 的可见性），
没有 L2，也没有任何可读的声明文件。

## 3 WorkBuddy：宿主连接器声明位置

默认根 = 环境变量 `CRWU_CONNECTOR_ROOT`；未设置时 = `~/.workbuddy`（WorkBuddy 连接器宿主目录）。
**本仓不提供这些连接器，也不随本技能安装**——它们是宿主侧外部工具。

| 位置（相对根） | 内容 |
| --- | --- |
| `mcp.json` | 宿主 MCP 服务清单（`mcpServers`：连接器 id → 端点 / 启用标记） |
| `connectors/*/mcp.json` | 按账号态分目录的连接器声明 |
| `connectors/*/connector-states.json`、`connector-states.v3.json` | 启用状态（`enabled` 列表、`userDisabled` 映射、`everConnected`）与凭据引用（`headerOverrides` 的**键名**） |
| `connectors-marketplace/.codebuddy-connector/connectors.json` | 连接器目录（id / 中英文名 / 是否需要授权），**不作为"已声明"依据** |

已知连接器标识：同花顺 iFinD = `ifind-mcp`（服务端授权，宿主托管，无需本技能处理凭据）。

## 4 DeepSeek Harness：结构化 Tool `crwu_audit_ifind_query`

DeepSeek Harness 没有 WorkBuddy 连接器目录，**也不允许脚本例外**。同花顺 iFinD 取数统一走宿主注册的
结构化 Tool `crwu_audit_ifind_query`：

- **入口可见性**：`operation` 的「列工具」取值能返回工具清单即视为入口可用（枚举字面量见 Tool schema，本文件不复述）；Tool 不在本 Agent 的可见集里
  → 按 §5 降级（记 capability gap 并写交付声明）。
- **参数**：只有 `operation`（列工具 / 查询两个取值）、`serverType`（固定八元：`stock` / `fund` /
  `edb` / `news` / `bond` / `global_stock` / `index` / `future`）、`toolName`（查询时必填）、
  `params`（JSON 对象）。**没有** URL / token / 脚本路径 / 沙箱模式这类字段。
- **凭据**：由 Host 从环境清单声明的固定位置读取；本技能**不读取、不输出、不落盘**任何令牌，
  也**不**读取任何第三方技能的凭据配置文件。
- **`toolName` 校验**：Host 会先用 MCP「列工具」方法的真实返回校验 `toolName`，不在清单里的名字不会被发出。
- **失败语义**：未授权读凭据 → `policy`；缺令牌 → `capability-gap`；HTTP / 协议错误 → `infrastructure`；
  服务端 JSON-RPC 错误 → `cli`；取消 → `cancelled`。一律按 §5 降级，**不得静默跳过**、
  也不得把能力缺口写成被审件缺陷。
- **禁止**（自包含安全边界）：搜索任何技能根、执行任何第三方技能自带的调用脚本、
  在第三方技能目录写临时脚本、读取任何第三方技能的配置文件、用 `subprocess` / `child_process` 起进程。

## 5 兜底：入口不可用时怎么办

1. **不得静默跳过**，也不得事后补写结论。
2. 按库内降级口径降级：命中关键参数 / 高风险的条目降为"单源 + 请说明"；其余记未检查项与能力缺口。
   本环境无万得副源，**所有条目一律单源**，不得声称已复核。
3. **在交付 HTML 的《外部数据核验》区显式声明**（字段 `externalDataVerification.sources[]`，
   数据源统一写 `同花顺 iFinD`）：

   | 情形 | `configured` | `authenticated` | 必须在 `note` 写明 |
   | --- | --- | --- | --- |
   | 所有宿主入口都不存在 | `false` | `false` | 未配置同花顺 iFinD 取数入口；相关条目未经外部数据核验 |
   | 入口存在但未启用 | `false` | `false` | 取数入口未启用；相关条目未经外部数据核验 |
   | 入口启用但未完成授权 | `true` | `false` | 取数入口未认证；相关条目未经外部数据核验 |
   | 可用 | `true` | `true` | 本次取数路径（WorkBuddy 连接器 / 结构化 Tool `crwu_audit_ifind_query`）与取数时点、口径 |

4. 声明措辞统一为："本次未配置 / 未认证 同花顺 iFinD，相关条目未经外部数据核验。"
5. 降级不影响其他检查项与轴：外部数据核验失败不得短路方法判断、披露检查或表格勾稽。

## 6 调用与留痕契约

每次取数必须记录并回执：

```yaml
data_point:
  metric: 【数据项名称】            # 与知识库表 B 的数据项一致
  metric_key: EXT_【…】            # 可选，与库内稳定键一致
  base_date: 【报告基准日】         # 全部取数的锚点
  as_of_date: 【本次取数时点】       # 与基准日不同的必须说明
  source: 同花顺 iFinD
  access_path: 宿主连接器 / 结构化 Tool crwu_audit_ifind_query
  query_params:                    # 口径参数，按库内表 B 要求的必填项逐项填
    term / window / frequency / benchmark / adjustment / unit / …
  value: 【取回值】
  source_note: 【可选】取数路径（宿主连接器 / 结构化 Tool）或口径变更说明
  snapshot_digest: 【快照摘要】      # 对取回内容做规范化摘要，供事后核验
```

- **基准日纪律**：`query_params` 的区间与窗口一律由 `base_date` 推导；禁止"截止最新 / 最近 N 周"这类
  以取数时点为准的滚动窗口。
- **单源纪律**：本环境不启用万得，数据源一律为同花顺 iFinD，**不得声称双源复核**；
  取数路径与口径变更在 `source_note` 如实登记。
- **凭据纪律**：只读连接器声明的**键名与启用状态**；不读取、不输出、不落盘任何令牌、Authorization 头
  或含 token 的 URL。WorkBuddy 侧的 `scripts/connector_probe.py` 已按此实现（URL 只输出主机名）。
- **快照纪律**：外部数据快照按本次审核工作目录落盘并登记摘要，供交付层引用；不写入知识库缓存。
