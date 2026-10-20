import type { WorkspaceCleanupPlan } from '../contracts/workspace-cleanup.ts'

/**
 * 工作空间清理的契约：计划与结果都由 Host 直接产出，界面原样消费。
 *
 * 这里只钉「两端说的是同一个形状」；字段级判断在 `contracts/workspace-cleanup.ts`，
 * 因为那是唯一一份被 Host、Client 与测试共同 import 的定义。
 */
export const WORKSPACE_CLEANUP_PLAN_FROM_HOST: (plan: WorkspaceCleanupPlan) => WorkspaceCleanupPlan =
  (plan) => plan
