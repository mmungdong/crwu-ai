/**
 * 操作表的**兼容别名**（协议 32 · Task 3）。
 *
 * 真实实现已按域搬进 `operations/`：
 * - `register.ts`：组装（构造共享依赖 + 拼四张域操作表 + `boot` 里的 `ported.done`）
 * - `common.ts`：共享依赖与闭包（门禁快照 / OSS 依赖与队列 / 看门狗 / 身份缓存 / 自检入口）
 * - `environment.ts` / `report-audit.ts` / `local-audit.ts` / `report-evaluation.ts`：各域的 handler
 *
 * 本文件保留**两个类型与一个函数**的旧导入路径（`apply.ts` 与多处测试从这里取
 * `createCoreOperations` / `CoreDeps` / `HostResolvers`），迁移期不必一次改完。
 */
export { createCoreOperations } from './register.ts'
export type { CoreDeps, HostResolvers } from './types-export.ts'
