import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { missingAuditTools } from '../register.ts'
import { VALUATION_CHILD_TOOLS } from './consts.ts'

/**
 * 估值链路的**工具可见性预检**（方案 §8 的 `VALUATION_CHILD_TOOLS` 的实际用法）。
 *
 * ## 为什么这里不是"工具过滤"
 *
 * 审核子会话走 DSH 的 `toolFilter`：provider 在创建窗口里把工具集**真的收窄**，
 * 看不见就调不到。估值会话不同 —— 它是通过统一会话服务建的**顶层会话**
 * （`sessionController.create({ workspaceId })`），那条路径没有工具过滤入口。
 *
 * 所以估值这条链路的边界在**别处**，而且是可验证的：
 *
 * | 边界 | 在哪 | 作用 |
 * | --- | --- | --- |
 * | 案例归属门禁 | 每个估值 Tool 的 `requireCaseAccess` | 非本轮估值会话调用一律拒绝 |
 * | 审核 Tool 的作用域门禁 | 审核 Tool 自己的 scope 检查 | 估值会话调不到审核记录/附件 |
 * | **可见性预检** | 这里 | 起估值**之前**确认本轮要用到的 Tool 在宿主里确实可见 |
 *
 * 第三条才是本文件的意义：`VALUATION_CHILD_TOOLS` 列了 8 条工具名，但名字写在常量里
 * **不等于**宿主真的注册了它们（打包漏一个、注册表收窄、部署降级都会让名单变成一纸空文）。
 * 所以 `valuation-start` 在**创建会话之前**拿同一份名单去问注册表 —— 缺任何一条就拒绝启动，
 * 并如实说是哪一条。宁可让用户看到"缺工具、请重新自检"，也不要让子会话跑到一半才发现。
 *
 * ⚠️ 判据与审核侧**共用同一个实现**（`missingAuditTools` 的 `required` 参数）：两处各写一遍
 * "怎么算可见"迟早会分叉，而分叉的表现是两条链路对同一个部署给出不同结论。
 */

/** 本轮估值缺失的工具（空数组 = 齐备）。`agent` 缺省表示按**未收窄**的注册表查。 */
export function missingValuationTools(ctx: Context, agent?: Agent): string[] {
  return missingAuditTools(ctx, agent, VALUATION_CHILD_TOOLS)
}

/** 缺失时给用户看的话（逐条列出缺哪几个，而不是笼统一句"环境不对"）。 */
export function valuationToolsMissingText(missing: readonly string[]): string {
  return `本轮估值需要的工具在宿主里不可见：${missing.join('、')}。`
    + '请回【环境信息】重新自检；仍缺说明插件包不完整，需要重装或等待更新。'
}
