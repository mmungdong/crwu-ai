import type { CaseScopeRegistries } from '../../domains/report-audit/case-access.ts'
import type { ToolDeps } from '../common/types.ts'

/**
 * 从 Tool 依赖里取出**托管 scope 注册表**。
 *
 * 为什么单独一个文件：门禁（`audit/case-access.ts`）与 Tool 装配（`tools/*.ts`）互相认识，
 * 而 `ToolDeps` 只是可选依赖的容器。把"哪些注册表要交给门禁"这件事放在这里，
 * 每个 Tool 都只写一次 `caseScopes(deps)` —— 少一处手写就少一处"新加了 scope 却忘了传"
 * （那种遗漏的后果是**门禁静默失效**，不是报错）。
 *
 * 只导入类型：运行时没有任何依赖环。
 */
export function caseScopes(deps: ToolDeps): CaseScopeRegistries {
  return {
    ...(deps.localAudit === undefined ? {} : { localAudit: deps.localAudit }),
    ...(deps.valuationScopes === undefined ? {} : { valuation: deps.valuationScopes }),
  }
}
