# skills/ —— 分层技能目录

`skills/` 本身**不是**技能根，而是**技能层的容器**。`cordis.patch.yml` 把每一层分别注册成一个
DSH 技能根（`@deepseek-ai/dsh-skill-filesystem` 的 `customSkillDirs`）。

| 层 | 目录 | 归属 | 改动方式 |
| --- | --- | --- | --- |
| `crwu` | `skills/crwu/` | 本仓自研的审核能力族 | 正常评审后改；必须过 Skill 自洽性 lint |
| `dws` | `skills/dws/` | 上游 `dingtalk-workspace-cli` 的钉钉技能（vendored） | **只能**由 `npm run dws:sync` 改写 |
| 公共 | 包内 `common/skills/`（源在 `plugins/common/skills/`） | 跨插件公共技能 | 改源仓，再 `npm run skills:sync` |

## 为什么一层一个技能根

DSH 对每个技能根**只扫一层**（`<根>/<技能名>/SKILL.md`），不递归。所以 `skills/` 自己不能当根：
那样 `skills/crwu/` 会被当成"一个没有 `SKILL.md` 的技能"被跳过，**整层静默消失**（症状是
provider 装配成功、技能表里 0 个技能）。

## `dws` 层

- 内容与版本身份记录在 `skills/dws/provenance.json`：上游包名、版本、集合、逐技能 sha256。
- 同步：`npm run dws:sync`（自动找本机 `dws` 的上游副本；也可 `--source <dir>` 显式指定）。
- 校验：`npm run dws:check`（只对照 `provenance.json`，不需要上游；`npm run check` 已含）。
- 升级上游：`npm run dws:sync -- --allow-version-change`，审 diff，并把版本写进 `CHANGELOG.md`。
- 上游以 Apache-2.0 发布：`LICENSE` / `NOTICE` 随技能一并保留，不得删除。
- 这一层是**上游正文**，不受本仓「Skill 自洽性」lint 约束（上游按自己的跨技能相对链接组织）。
  要改 dws 正文请回上游提 issue / PR，不要在这里就地改 —— 下次同步会覆盖。

### DSH 适配（协议 18 · 子项目 C4）

上游技能里**有** `dws auth login` 这类交互式登录指引 —— 那对"人手敲命令"是对的，对 DSH
里的 Agent **不是**。所以在 DSH 宿主下：

- **登录一律回工作台**：员工在侧栏面板的「账号连接」步骤里点「钉钉登录」/「氚云扫码登录」。
  Host 用 `dws.auth.login` / `h3yun.session.login` 两个操作执行它，而这两个操作的
  `allowedSources` **只有 `panel`** —— 审核链路（`audit-tool`）与宿主后台都拿不到它们。
- **没有给 Agent 的登录 Tool**：`host/tools/consts.ts` 的工具集里没有任何 login 工具，
  `host-access-migration.test.mjs` 与 `host-access-broker.test.mjs` 各有一条断言盯着。
- **审核提示词明令禁止**：未登录 / 未允许本机访问时子代理必须**停下并回报**，
  不许自己登录、不许翻凭据、不许改 `PATH`（`host-audit-prompt.test.mjs` 逐句钉住）。
- **自动审核不走这两层技能**：`crwu-audit` 的取数与交付只走 `crwu_*` 结构化 Tool；
  审核提示词里明确写了 vendored DWS 技能不参与本次编排。

因此这一层的登录指引**不需要**、也**不应该**就地改写：改了就与上游 diff 冲突，
而且下次 `npm run dws:sync` 会覆盖。适配以"策略 + 提示词 + 断言"的形式落在本仓代码里，
而不是落在 vendored 正文里。
