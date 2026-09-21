# 各 Agent skills 安装目录参考

> 维护纪律：本表是**缓存/默认值**。每次对 workbuddy / codex / opencode 或其它
> 不熟悉的 agent 安装前，用 `web_search` 核实官方文档；路径有变 → **以官方为准**
> 并回写本表（含链接、日期）。deepseek harness 以本机 dsh 的 skills 根为准。

安装入口是仓库根目录的 Makefile（原来那个 `crwu-init` 技能已废弃：技能已随插件维护，
目录布局本身就是名单，不再需要"分发器技能"去拉一份 `skills/`）：

```bash
make skills-install AGENT_DIR=~/.codex/skills    # 其它宿主：拷全部技能
make plugin-pack                                 # DSH：打成插件包，技能随包发布
```

## 目录表

| Agent | 用户级 skills 目录 | 环境变量覆盖 | 官方文档（核实用） |
| --- | --- | --- | --- |
| workbuddy | `~/.workbuddy/skills/` | — | https://www.workbuddy.cn/docs/cli/skills |
| codex | `~/.codex/skills/` | — | Codex CLI 官方文档 skills 一节 |
| opencode | `~/.config/opencode/skills/` | — | https://opencode.ai/docs/skills/ |
| deepseek harness (dsh) | 随**插件包**发布，不再手拷：插件把 `<包内>/skills/` 与 `<包内>/common/skills/` 注册成技能根 | `$DSH_HOME` | 本机 DSH `@deepseek-ai/dsh-skill-filesystem`（`customSkillDirs` 配置项） |

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

- **更新模式 = 同名技能全量替换**：`rm -rf <TARGET>/<name>` 后再 `cp -R`，保证
  `references/` 等子文件夹也被覆盖、旧文件不残留。`make skills-install` 就是这么做的。
- 只安装含 `SKILL.md` 的子目录；`plugins/*/skills/*` 这个 glob 同时覆盖插件专属技能与
  `plugins/common/skills/` 下的公共技能，不需要任何名单文件。
