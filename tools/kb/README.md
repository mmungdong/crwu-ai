# tools/kb —— 审核技能引用与实时协议校验

> 定位：审核技能族的**只读**静态校验工具（引用卫生 + 实时引用协议 lint）。
> 本文档 = 源仓维护者视角；**工具不随 skill 安装**——运行时如需由 agent 调用，
> 由部署环境注入可执行路径。

## 为什么存在

知识正文的唯一来源是**钉钉知识库**，由 `crwu-dws` 按本次审核清单实时下载
（正文零缓存；目录可缓存）。本仓因此**不再维护本地知识库根**
（`CRWU_KB_ROOT` / `~/.crwu/knowledge/knowledge-base`）：
技能侧只写 RULE/CHK 编号与**库内层级路径**寻址键，正文一律运行时获取。

这带来两条必须机器校验的纪律：

1. **不许退回本地知识库**：技能内不得再出现本地根常量、本地根路径字面、
   `KB/…` 省略号或 `KB/<rel>` 本地根相对引用；
2. **不许写死运行时值**：`nodeId` 一律由 `crwu-dws` 运行时解析，技能内不得硬编码赋值。

## 运行

```bash
# 源仓技能：引用卫生 + 实时协议 lint（CRWU_KB_ROOT / ~/.crwu/ / knowledge-base 字面、nodeId 赋值只在 crwu-audit* 目录生效）
python3 tools/kb/kb_tool.py validate --skill-root skills

# 追加禁止知识库名称字面（作用于该 root；crwu-dws 自带默认库名，勿对其目录加库名）
python3 tools/kb/kb_tool.py validate --skill-root skills --forbid-literal 中瑞世联
```

## 子命令

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `validate` | ①引用卫生（旧树残留标记、`KB/…` 省略号、**已废止的 `KB/<rel>` 本地根相对引用**、**已废止的 `CRWU_KB_ROOT` 常量**、`~/.crwu/...` 字面路径是否存在）②**实时协议 lint**（crwu-audit* 目录内：禁本地 KB 根字面 `CRWU_KB_ROOT=`/`~/.crwu/`/`knowledge-base`、禁硬编码 nodeId 赋值；`--forbid-literal` 追加禁知识库名称等字面） | 0 全过；1 有 error |

已删除的子命令（v0.2，2026-09-10）：`index` / `resolve` / `query` / `release` /
`assemble` / `extract` / `selftest`。它们全部建立在本地知识库 md 树上，
而该树已迁至钉钉、本地根不再存在，命令实际不可运行。

## 装配清单从哪来（不再由本工具生成）

下载清单 = 命中**资产/业务子技能**的 `references/01-kb-assembly.md`
（一个一级目录根，或明确的单文件路径）＋ 执行契约路径并集，
由 `crwu-dws` M2 实时下载到 `<案例目录>/knowledge/`：

- 清单同时支持**单文件路径**与**目录路径**（目录项递归下载其中全部支持正文）；
- **清单外零下载**；正文永不写入目录缓存；
- 资产/业务子技能只登记一级目录根（`request_kind=directory`、`recursive=true`），
  细分对象与子业务在已下载目录包内二次选用，不各建技能。

映射一致性（registry ↔ classification ↔ 真实技能目录 ↔ 最新知识库目录）
由 `skills/crwu-audit-skill-maintainer/scripts/check_audit_skill_mappings.py` 校验。

## 校验口径要点

- 实时协议 lint 只对 `crwu-audit*` 族目录做"三不写"严格检查；`crwu-dws` 等
  允许按需引用部署常量与默认库名；
- `CRWU_KB_ROOT` 与 `KB/<rel>` 现在是**全 root error**（不再限于 crwu-audit*），
  因为本地根模型已整体废止；
- 旧树残留标记与 `KB/…` 省略号为 warn（消费方需人工判断）；
- 纪律文本（含"禁止/不写…字面"的说明行）与"禁止出现旧名"的列举行自动豁免。
