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
