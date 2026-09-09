# 多轴技能注册表

| 版本 | v1.0 | 状态 | 2026-09-09 定稿 | 维护 | 轴标签到技能状态的唯一事实源 |
| --- | --- | --- | --- | --- |

`available` 才进入执行并集；`pending` 为对应 `axis+label` 写独立 gap；`profile-only` 只保留画像，不需要技能。不得创建 pending 技能目录，也不得注册旧组合技能。

| axis | label | skill | status | load behavior |
| --- | --- | --- | --- | --- |
| scope | 单项资产 | — | profile-only | no skill |
| scope | 资产组合 | crwu-audit-scope-asset-portfolio | pending | record gap |
| scope | 企业价值 | crwu-audit-scope-enterprise-value | pending | record gap |
| scope | 其他范围 | — | profile-only | review profile |
| asset | 房地产 | crwu-audit-asset-realestate | available | load |
| asset | 设备 | crwu-audit-asset-equipment | pending | record gap |
| asset | 无形资产 | crwu-audit-asset-intangible | pending | record gap |
| asset | 存货 | crwu-audit-asset-inventory | pending | record gap |
| asset | 债权 | crwu-audit-asset-debt | pending | record gap |
| asset | 矿业权 | crwu-audit-asset-mining-right | pending | record gap |
| asset | 数据资产 | crwu-audit-asset-data | pending | record gap |
| asset | 森林资源 | crwu-audit-asset-forest | pending | record gap |
| business | 租赁 | crwu-audit-business-rent | available | load |
| business | 清算 | crwu-audit-business-liquidation | pending | record gap |
| business | 破产 | crwu-audit-business-bankruptcy | pending | record gap |
| business | 资产处置 | crwu-audit-business-disposal | pending | record gap |
| business | 资产转让 | crwu-audit-business-transfer | pending | record gap |
| business | 拍卖 | crwu-audit-business-auction | pending | record gap |
| business | 资产收购 | crwu-audit-business-acquisition | pending | record gap |
| business | 资产置换 | crwu-audit-business-swap | pending | record gap |
| business | 抵押质押 | crwu-audit-business-mortgage | pending | record gap |
| business | 抵债偿债 | crwu-audit-business-debt-settlement | pending | record gap |
| business | 债务重组 | crwu-audit-business-debt-restructuring | pending | record gap |
| business | 财务报告 | crwu-audit-business-financial-reporting | pending | record gap |
| business | 公允价值计量 | crwu-audit-business-fair-value | pending | record gap |
| business | 减值测试 | crwu-audit-business-impairment | pending | record gap |
| business | 投资出资 | crwu-audit-business-investment | pending | record gap |
| business | 股权变动 | crwu-audit-business-equity-change | pending | record gap |
| business | 计税 | crwu-audit-business-taxation | pending | record gap |
| business | 追溯评估 | crwu-audit-business-retrospective | pending | record gap |
| business | 司法涉诉 | crwu-audit-business-litigation | pending | record gap |
| business | 补偿 | crwu-audit-business-compensation | pending | record gap |
| business | 复核 | crwu-audit-business-review | pending | record gap |
| business | 价值咨询 | crwu-audit-business-advisory | pending | record gap |
| method | 资产基础法 | crwu-audit-method-asset-based | pending | record gap |
| method | 成本法 | crwu-audit-method-cost | pending | record gap |
| method | 市场法 | crwu-audit-method-market | pending | record gap |
| method | 收益法 | crwu-audit-method-income | pending | record gap |
| method | 假设开发法 | crwu-audit-method-hypothetical-development | pending | record gap |
| method | 基准地价系数修正法 | crwu-audit-method-benchmark-land-price | pending | record gap |
| method | 路线价法 | crwu-audit-method-route-price | pending | record gap |
| method | 其他方法 | — | profile-only | review profile |
| overlay | 国资 | crwu-audit-overlay-state-owned | pending | record gap |
| overlay | 证券 | crwu-audit-overlay-securities | pending | record gap |
| overlay | 司法 | crwu-audit-overlay-judicial | pending | record gap |
| overlay | 金融/银行 | crwu-audit-overlay-financial | pending | record gap |
| public | 表格勾稽 | crwu-audit-datacheck | available | load when tabular materials exist |

## 维护约束

- 04 的每个 business 标签必须在本表恰好注册一次；任何新增、改名或删除都需同步两处。
- pending 只表示能力尚未落地，不表示画像未命中；标签留在 route profile，按 10 产出 gap。
- 新技能只有真实目录、门禁和所需登记完成后才能从 `pending` 改为 `available`。本表不得以计划中的目录证明可用。
- 一个技能即使由多个标签命中，也由 08 的 `stable_unique` 去重；不得建立资产×业务等组合技能替代独立轴。
