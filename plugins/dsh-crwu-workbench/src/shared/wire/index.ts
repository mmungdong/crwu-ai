/**
 * 线协议的**编译期契约检查**入口（没有运行时代码）。
 *
 * 分领域放在 `common` / `environment` / `report-audit` / `report-evaluation`：一处红就知道
 * 是哪条链路漂了，而不是在一个几百行的文件里找哪一行。
 *
 * 方向铁律：这一层可以 import Host 侧的内部类型（它就是来核对 Host 的），
 * 但**不许** import Client 的任何东西 —— 契约层两端都不依赖，只被两端依赖。
 */
export * from './common.ts'
export * from './environment.ts'
export * from './report-audit.ts'
export * from './report-evaluation.ts'
