# 各 Agent skills 安装目录参考

> 维护纪律：本表是**缓存/默认值**。每次对 workbuddy / codex / opencode 或其它
> 不熟悉的 agent 安装前，用 `web_search` 核实官方文档；路径有变 → **以官方为准**
> 并回写本表（含链接、日期）。deepseek harness 以本机 dsh 的 skills 根为准。

DSH 技能随插件包发布。其它宿主按需选择单个 Skill，并使用宿主自己的安装流程；本仓库不再提供
把全部层扁平复制到用户目录的 Make 目标。目录布局本身就是名单，不维护第二份清单：

```bash
make plugin-pack    # DSH：打成插件包，技能按层随包发布
```

## 目录表

| Agent | 用户级 skills 目录 | 环境变量覆盖 | 官方文档（核实用） |
| --- | --- | --- | --- |
| workbuddy | `~/.workbuddy/skills/` | — | https://www.workbuddy.cn/docs/cli/skills |
| codex | `~/.codex/skills/` | — | Codex CLI 官方文档 skills 一节 |
| opencode | `~/.config/opencode/skills/` | — | https://opencode.ai/docs/skills/ |
| deepseek harness (dsh) | 随**插件包**发布，不再手拷：插件把包内 `skills/crwu/`、`skills/dws/`、`common/skills/` **各注册成一个技能根**（一层一个根，DSH 对每个根只扫一层） | `$DSH_HOME` | 本机 DSH `@deepseek-ai/dsh-skill-filesystem`（`customSkillDirs` 配置项） |

## 补充说明

- **codex**：还有项目级 `.codex/skills/`、系统级 `/usr/local/share/codex/skills/`；
  用户级默认装到 `~/.codex/skills/`。
- **opencode**：额外兼容 `~/.claude/skills/`、`~/.agents/skills/`；opencode **原生**
  用户级目录是 `~/.config/opencode/skills/`。
- **deepseek harness (dsh)**：装插件（`dsh plugin --profile <profile> add <tgz|URL>`）后
  技能由插件提供，**不需要**再往 `~/.dsh/skills/` 里拷 —— 插件目录的 rank 比用户根高，
  旧的手拷副本会被插件副本覆盖，长期建议清掉以免两处漂移。

## 技能格式兼容性

本仓库技能均为 `<name>/SKILL.md`（frontmatter 含 `name` + `description`，可选
`references/` 子文件夹），上述 agent 均按此格式发现（`<root>/<name>/SKILL.md`），
无需转换。

## 覆盖语义（重要）

- 安装或更新时只选择含 `SKILL.md` 的具体 Skill 目录，不要把层目录本身当作 Skill。
- 替换同名 Skill 时使用宿主提供的安装/更新流程；若宿主没有安装器，先备份目标目录，再完整替换
  该 Skill 目录，避免残留旧的 `references/` 或脚本。
- 不要把不同层批量扁平化到同一目录；同名 Skill、上游 vendored 内容和宿主自己的版本策略需要逐项确认。
