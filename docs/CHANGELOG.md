# 变更纪要（CLI Changelog）

> 维护纪律（见 `AGENTS.md`）：**每次 CLI 功能新增 / 变更 / 删除**（命令、参数、
> 环境变量、输出契约、通道行为），必须在本文档**追加**一条纪要，并同步更新
> [`docs/cli-manual.md`](cli-manual.md)（Agent 使用说明书）。
>
> 条目格式：`日期 · 类型 · 标题`，类型沿用 Angular 词表（feat / fix / refactor /
> docs / chore），正文写明**影响命令**与关键说明。

---

---

---

## 2026-09-04 · docs · crwu-audit-datacheck：跨方向表格勾稽能力 + 叶子必做步骤

- 影响：skills 新增 `crwu-audit-datacheck`（L2 能力型：C1–C6 数据/表格勾稽、差异清单输出、
  xlsx/.xls 解析与公式重算工具链说明）；`crwu-audit-realestate-rent`/`crwu-audit-realestate`
  增加"表格勾稽必做（先于意见输出）"步骤；总路由注册表与设计文档 v0.2 登记该能力
- 说明：Excel 明细/测算/汇总表属 M-数据校对职责（校准 G7），此前试点只审报告+说明属执行缺口；
  现固化为必做：差异清单回传规则技能作判定（如汇总数与报告结论不符→反证数字污染），
  解析失败必须明示"该表未核"；差异计入台账 data_diff_count（crwu-knowledge audit-skill/08）
- 未新增/修改 crwu CLI 命令

---

## 2026-09-04 · docs · 审核统计规范接入 crwu-audit 路由

- 影响：`skills/crwu-audit/SKILL.md` 汇总输出新增第 8 步"统计回填"
- 说明：单份审核完成后按 crwu-knowledge `audit-skill/08-审核统计与台账规范.md` 产出统计字段
  （A–G）并落入台账（模板 `knowledge-base/05-模板库/审核统计台账-模板.md`），用于周/月/批汇总
  与知识库反哺（易错点候选/缺口反馈）；取值口径复用 crwu-knowledge 标签词典
- 未新增/修改 crwu CLI 命令

---

## 2026-09-04 · docs · crwu-audit 分层路由：总路由 + 房地产大方向（设计 v0.2）

- 影响：skills 新增 `crwu-audit`（L0 总路由：全量路由注册表 + 分层分发/降级/汇总/门禁透传）、
  `crwu-audit-realestate`（L1 房地产大方向通用审核）；`crwu-audit-realestate-rent` 明确为 L2 细分；
  `docs/design-crwu-audit-skills.md` 升级 v0.2（三层可插拔模型：L1 大方向 runnable → L2 细分
  pluggable，细分未命中降级父大方向，最上层统一维护所有能力 skill 路由）
- 说明：三层语义按用户口径——先判大方向→再尝试细分；细分未命中按上一层（大方向）审核逻辑开展；
  大方向下可继续插"具体法律/专项内容"审核能力；总路由只分发不判断
- 未新增/修改 crwu CLI 命令；后续：案例 B 试点走查验证三层路由

---

## 2026-09-04 · docs · crwu-audit 审核技能族：分类设计与首片叶子

- 影响：skills 目录新增 `crwu-audit-realestate-rent`（提示型 Skill）；`skills/README.md` 注册；
  新增 `docs/design-crwu-audit-skills.md`（划分判据/分类树/总路由 crwu-audit 契约/优先级）
- 说明：crwu-audit 族按审核能力逻辑划分（report_type → object_type → method/scenario →
  就绪度）；首片叶子=商铺租金/经营性物业市值类评估报告（市场法租金比较/成本法/收益法租约），
  只读引用 crwu-knowledge 规则（RULE-01-02-281~305、543~578）与清单（CHK-MKT/CST）；
  依赖 crwu-knowledge A 发布门禁：未发布仅试点（意见标注"依据待发布"）
- 未新增/修改 crwu CLI 命令；总路由 `crwu-audit` 与其余叶子待后续实现

---

## 2026-09-04 · feat · records list 支持 --filter 字段条件筛选

- 影响命令：`crwu h3yun records list`（新增 flag `--filter <条件>`）
- 说明：SQL 风格筛选表达式（`=`/`!=`/`<>`/`<`/`>`/`<=`/`>=`/Contains/Like/
  StartWith/EndWith/In/NotIn/Between/IsNull/IsNotNull/IsNone/NotNone，支持
  `and`/`or` 与括号，大小写不敏感），字段自动补 `<schemaCode>.` 前缀；
  `--filter` 与 `--keyword` 可叠加
- 语法与操作符表见 `docs/cli-manual.md` §4"记录"；氚云无 SQL `Like`，`Like`
  已映射为 `Contains`
- 相关：新增 `internal/integrations/h3yun/filter.go`（表达式→matcher 树，含
  单元测试）；`internal/app/h3yunweb`（Records 透传 Filter）、
  `internal/transport/cli`（flag + scheme 示例）；同步 skill `h3yun-query`

---

## 2026-09-04 · docs · 扫码登录的沙箱运行注意与前置说明

- 影响：`crwu h3yun session login` 的运行环境注意事项
- 在 AI 宿主沙箱环境中，login 拉起的 GUI 浏览器会被沙箱拦截而弹不出窗口
  （报 `websocket close 1006`），应**脱离沙箱 + 前台**运行，并用 `CRWU_BROWSER`
  显式指定 Chromium 系浏览器路径
- 同步 `docs/cli-manual.md`（§3 增加环境提示）与 `skills/h3yun-login/SKILL.md`
  （增加"确保 crwu 可用"前置——`crwu` 缺失时应询问用户而非擅自构建/改环境；
  `CRWU_BROWSER` 显式示例；沙箱拦截排障条目）

---

## 2026-09-03 · feat · 员工自助扫码登录（session login）

- 新增命令：`h3yun session login`
- 影响：自动拉起本机 Chrome/Edge 打开 h3yun.com，员工用钉钉扫码后由 crwu 经
  CDP 直接读取会话并写入本机 keyring；令牌全程进程内处理，不打印/不进对话
- 相关：`internal/platform/scanlogin`（浏览器捕获）、`internal/app/h3yunweb`、
  新增 skill `h3yun-login`
- 环境变量：`CRWU_BROWSER`（指定浏览器可执行文件）
- 默认浏览器支持：优先使用系统默认浏览器（需为 Chrome/Edge/Brave/Chromium 等
  Chromium 系；Safari/Firefox 不支持 CDP 时回退到已装 Chromium），macOS 读
  LaunchServices、Windows 读 UserChoice、Linux 读 xdg-settings
- 读取加固：cookie（www 域与根域双拉）+ 页面 JS localStorage/document.cookie
  兜底；抓取值先解码校验 enginecode/userid/exp（未来时间）后才写入，无效不存储

---

## 2026-09-03 · feat · 首个交互式查询 Skill（h3yun-query）

- 新增：`skills/h3yun-query/SKILL.md`
- 影响命令：复用 `h3yun apps list / apps children / forms search /
  records list / records get / files list / file download`（只读）
- 说明：按"系统 → 表单 → 记录"逐层交互查询，每页 20 条、可翻页、支持标题
  关键词查找；不发散写操作

---

## 2026-09-03 · feat · version 输出构建信息

- 影响命令：`crwu version`
- 影响：输出含 版本号、commit 缩写、构建时间（UTC）、目标平台（macOS/Windows/
  Linux + 架构），由 Makefile 注入 BuildDate；GOOS/GOARCH 为编译期值

---

## 2026-09-03 · feat · 会话惰性自动续期（中间件）

- 影响命令：apps/forms/records/files 等依赖网页会话的读命令
- 说明：h3yun 组 PersistentPreRunE 中间件在执行前检查会话剩余时间 ≤24h 则自动
  refresh 一次；已过期则提示重新 `crwu h3yun session login`。session 管理命令与
  agent 通道（ping/tools/apps search/records query）跳过
- 相关：`internal/transport/cli/middleware.go`（CLI 中间件）、
  `internal/app/h3yunweb/renewal.go`（EnsureFresh）

---

## 2026-09-03 · refactor · 用 cobra 重写 CLI（docker/k8s 规范）

- 影响命令：全部（结构不变，命令路径/flag 保持一致）
- 说明：命令改为嵌套树，help 分层折叠（`crwu help h3yun session`）；flag 由
  cobra/pflag 管理并校验必填参数；`crwu scheme` 目录改为由 cobra 命令树实时
  生成，与 help 描述同源；退出码统一：成功 0、任何错误 1

---

## 2026-09-03 · feat · H3Yun 员工级网页会话通道上线

- 新增命令：`h3yun session bind/status/refresh/clear`、`h3yun apps list`、
  `h3yun apps children`、`h3yun forms search`、`h3yun records list`、
  `h3yun records get`、`h3yun files list`、`h3yun file download`
- 影响：以员工本人网页会话（钉钉扫码，无密码）读取应用/表单/记录/附件；
  会话存本机 OS 凭据存储（`internal/platform/h3yuncreds`），48h 可续期
- 相关：新增 `internal/integrations/h3yun`（网页 REST 客户端）、
  `internal/app/h3yunweb`

## 2026-09-03 · feat · H3Yun Agent 网关（MCP）客户端

- 新增命令：`h3yun ping`、`h3yun tools`、`h3yun apps search`、
  `h3yun records query`（只读 SQL）
- 影响：以个人访问凭证 `h3pat_*` 对接 `www.h3yun.com/v1/agent/mcp`
- 说明：氚云数据面未对企业开通时，`tools/call` 返回 `h3yun.read.upstream_error`
  （平台侧问题，非客户端故障）；开通后该通道方可用
- 相关：`internal/integrations/h3yun`（MCP 客户端）、`internal/app/h3yunops`

## 2026-09-03 · refactor · 移除 crwu-server 模块与 `h3yun login`

- 影响命令：删除 `h3yun login`（钉钉 OAuth 服务器登录）
- 说明：员工凭证改为**本机绑定**模型，无服务端可运维；移除
  `cmd/crwu-server`、`internal/app/h3yunlogin`、`internal/auth`、
  `internal/config`、`internal/integrations/{dingtalk,crwuserver}`、
  `internal/transport/httpapi`、`internal/platform/browser`
- 破坏性：若曾有调用方依赖 CRWU 会话服务器或 `h3yun login`，需迁移到
  `h3yun session bind`

## 2026-09-03 · docs · 项目文档重构

- 新增：`docs/design-h3yun-auth.md`（鉴权决策）、
  `docs/design-h3yun-cli.md`（CLI 决策）、`docs/design-h3yun-connector.md`
  （连接器决策）、`docs/cli-manual.md`（本说明书）
- 更新：`AGENTS.md`、`CONTEXT.md`、README（en/zh）按"无服务端员工会话"模型重构

---

> 预置条目回溯了项目当前功能状态；此后所有变更按上方格式**向下追加**，请勿改写历史。

## 2026-09-04 · fix · crwu-audit-datacheck：H0 由"默认忽略"升级为"强制跳过（禁读禁报）"

- 影响：`skills/crwu-audit-datacheck/SKILL.md`（description + 主流程第 0 步 + C3 扫描范围 +
  边界纪律 + 校准实例口径）；同步 `skills/README.md` 与 `docs/design-crwu-audit-skills.md` §4 注册表行
- 说明：业务口径 = 人工检查员本就会跳过隐藏的 sheet/行/列（含折叠分组），这些区域**无需关注**；
  此前 H0 只是"默认忽略（不产生误报）"，仍允许/暗示对隐藏区做 C3 公式错误等扫描，agent 审核会比
  人工更严且产生噪音。现固化为铁律：隐藏区**整体跳过**——不得读取、解析、核对、引用或输出其中任何
  单元格值；不得对其产生 C1–C6 差异/意见（含 #REF!/#DIV/0!、串扰词、占位）；合计勾稽只看可见区
  （SUM 覆盖隐藏区时注明"仅核可见部分"）；输出忽略清单仅含元数据（数量/名单/段位）。无法判定隐藏
  状态 → 该区按跳过处理并列入"隐藏状态未知 · 已跳过"，禁止回头取值
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · crwu-audit 画像层升级：references 运行材料 + 维护说明
- 影响：`skills/crwu-audit/SKILL.md`（重构为 ≤300 行入口；输入双源=材料包/氚云报告审核记录；分发算法升级：报告形态→受控角度词表→对象→方法(附件名+抽验)→监管覆盖层；注册表状态 P0/P1/P2）；新增 `skills/crwu-audit/references/{00-route-profile-schema,01-audit-angles-catalog,02-overlay-rules,99-维护说明}.md`；同步 `~/.dsh/skills/crwu-audit` 拷贝；README 与 `docs/design-crwu-audit-skills.md`（v0.2→v0.3）
- 说明：分发运行材料从 docs/ 收敛到技能自身 references/（Agent 加载友好，SKILL.md 不超行数上限）；监管覆盖层仅保留 国资(F0000082)/证券(F0000127∪0188…)/司法(F0000126)/金融(F0000124)；ABC/级次/状态不参与路由；数据基线=报告审核 8,486 条（2026-09-07）
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · refactor · crwu-audit 总路由入口与知识库解耦（叶子技能保留执行期知识库引用）
- 影响：`skills/crwu-audit/SKILL.md`、`skills/crwu-audit/references/00`、`skills/crwu-audit/references/99`、`skills/README.md`（同步 `~/.dsh/skills` 拷贝）
- 说明：**入口/路由层**（crwu-audit）不再“先读 KB/00-治理与规范…门禁”、不引用 crwu-knowledge 绝对路径（分发材料自含于 references/）；
  **叶子技能保持原状**——执行期按规则编号只读引用 crwu-knowledge 规则正文（收益法等细则不塞进技能、不复制正文），避免两个仓库过度耦合
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · 叶子技能统一加“仅经 crwu-audit 编排调用”前置门禁
- 影响：`skills/crwu-audit-realestate/SKILL.md`、`skills/crwu-audit-realestate-rent/SKILL.md`、
  `skills/crwu-audit-datacheck/SKILL.md`（新增“⚠️ 调用前置条件”+ frontmatter 描述约束）；
  `skills/crwu-audit/SKILL.md`（纪律：唯一编排入口）；`references/99-维护说明.md`（红线：新叶子必须自带门禁）；
  `docs/design-crwu-audit-skills.md`（§1 编排纪律）；同步 `~/.dsh/skills`（realestate/datacheck/router）
- 说明：防止 Agent 绕过总路由直接调单个子技能导致报告不完整、口径漂移；datacheck 保留“用户明确只要数据核对差异清单”的独立执行例外（仅输出差异清单、不下判断）
- 未新增/修改 crwu CLI 命令

## 2026-09-07 · skills · crwu-audit 路由首判：机构 A/B/C 业务风险分类(references/03)
- 影响：新增 `skills/crwu-audit/references/03-业务风险分类判定.md`；`SKILL.md`（§0 列表/§2 分发第 2 步首判/§5 纪律区分两类 ABC）；
  `references/00`（route_profile.business_risk_class）；`references/02`（原则口径）；`references/99`（分层地图）；README/design
- 说明：A/B/C 分类=审核严谨度参考与首页标注（制度 A1–A15/B1–B13/C1–C7 条款→谓词映射；A 先查取最高档、hits 列全；
  金额<500万条款缺金额挂起；A13/A14/A15 与涉密为人工项）；**不裁剪审核角度**——agent 一律全面审核，最终通过由人工复核；
  氚云风险等级字段 F0000020/级次/状态仅作对照不参与判定
- 未新增/修改 crwu CLI 命令
