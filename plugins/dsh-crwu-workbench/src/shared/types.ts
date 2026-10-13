/**
 * 线协议类型的**兼容别名**（迁移期）。
 *
 * 真实定义已经按领域搬进 `shared/contracts/`：`common` / `environment` / `report-audit` /
 * `report-evaluation` / `local-audit` / `update`。本文件整体 re-export，所以
 * `from '../../shared/types.ts'` 这类旧导入路径**继续可用**，不需要一次性改几十个文件。
 *
 * 新代码请按领域从 `shared/contracts/` 导入 —— 那样"改哪一块会影响谁"是看得见的。
 * 等旧导入点全部迁完，这个文件可以删掉（届时它的存在就是最后一处遗留）。
 */
export * from './contracts/index.ts'
