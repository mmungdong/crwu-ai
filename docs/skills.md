# Skill 维护指南

本仓库不维护容易过期的 Skill 名单或数量。目录结构和每个 `SKILL.md` 的 frontmatter 才是事实源；
需要当前清单时，从工作树实时发现。

## 分层与归属

DSH 对每个 Skill 根只扫描一层，因此每一层都必须单独注册。

| 层 | 源目录 | 维护方式 |
| --- | --- | --- |
| 自研 | `plugins/dsh-crwu-workbench/skills/crwu/` | 本仓维护；修改后运行自洽性校验 |
| 上游 | `plugins/dsh-crwu-workbench/skills/dws/` | vendored `dingtalk-workspace-cli` 内容；只通过 `npm run dws:sync` 更新 |
| 公共 | `plugins/common/skills/` | 跨插件共享；通过 `npm run skills:sync` 同步进插件包 |

包内落点和 DSH 注册方式见
[`plugins/dsh-crwu-workbench/AGENTS.md`](../plugins/dsh-crwu-workbench/AGENTS.md)。

## 查看当前 Skill

从仓库根目录运行：

```bash
find plugins -name SKILL.md -type f -print | sort
```

任何包含 `SKILL.md` 的目录都视为一个 Skill。不要把命令输出复制成长期维护的静态表格，也不要在
README 中写固定总数。

非 DSH 宿主按需选择单个 Skill，并使用宿主支持的安装流程；本仓库不提供批量复制全部 Skill 的
Make 目标。宿主目录与替换注意事项见 [`agent-skill-dirs.md`](agent-skill-dirs.md)。

## 修改规则

- 每个 Skill 必须可被单独复制安装，不能依赖自身目录之外的仓库文件。
- 运行时脚本、schema、示例和必要说明放在 Skill 自己的目录内。
- CLI 命令、参数和输出契约以运行时 `crwu scheme` 为准，不在 Skill 中复制易漂移的命令表。
- 公共逻辑优先放在公共层；插件专属能力留在插件自研层。
- 上游 `dws` 层不做手工编辑；升级时同步来源、审查 diff，并更新 provenance。

`crwu-audit` 能力族采用路由器加多轴并集：路由器负责画像与装配，资产、业务、方法、覆盖层和公共轴
各自拥有规则；不创建“资产 × 业务”组合 Skill。运行期知识通过 `crwu-dws` 按本次清单读取，Skill 不复制
知识库正文。现行设计见 [`design-crwu-audit-skills.md`](v0.0.1/design-crwu-audit-skills.md) 和
[`design-audit-live-kb-protocol.md`](v0.0.1/design-audit-live-kb-protocol.md)。

外部数据核验只使用 iFinD：WorkBuddy 通过宿主连接器 `ifind-mcp`，DeepSeek Harness 通过受控的结构化
Tool `crwu_audit_ifind_query`。不要用第三方 Skill、裸 CLI 或子进程替代这些宿主边界。

## 同步与验证

在插件目录运行：

```bash
npm run skills:sync
npm run skills:check
npm run dws:check
python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate \
  --skill-root skills/crwu \
  --skill-root common/skills
```

完整插件门禁使用仓库根目录的 `make plugin-check`。安装目录发现规则见
[`agent-skill-dirs.md`](agent-skill-dirs.md)。
