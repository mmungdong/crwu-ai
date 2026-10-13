/**
 * 线协议类型的**唯一入口**。
 *
 * 分领域组织（`common` / `environment` / `report-audit` / `report-evaluation` / `local-audit` /
 * `update`），但都从这里出去：调用方按领域导入更清楚，按入口导入也不会错。
 * `shared/types.ts` 是本入口的兼容别名（迁移期旧导入路径继续可用）。
 */
export * from './common.ts'
export * from './environment.ts'
export * from './report-audit.ts'
export * from './report-evaluation.ts'
export * from './local-audit.ts'
export * from './update.ts'
