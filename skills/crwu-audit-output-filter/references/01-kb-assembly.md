# 审核意见屏蔽清单装配

本技能只装配运行时《02-屏蔽清单》；《01-维护规则》供人员维护知识库使用，不进入每次审核下载清单。

单文件路径逐字使用知识库节点名，不加 `.md` 后缀。运行时由 `crwu-dws` 实时下载正文，不读取跨审核缓存。

| source_key | owner_axis | canonical_label | kb_root | request_kind | recursive | required |
| --- | --- | --- | --- | --- | --- | --- |
| `OUTPUT_SUPPRESSION_CHECKLIST` | `public` | `审核意见屏蔽` | `06-规则库/04-AI审核意见屏蔽/02-屏蔽清单` | `file` | `false` | `true` |

下载失败时本技能降级为零屏蔽，保留全部候选意见并记录 capability gap；不得猜测近似路径或读取《01-维护规则》替代。
