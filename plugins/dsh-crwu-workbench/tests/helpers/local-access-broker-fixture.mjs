/**
 * Broker 的**测试夹具**（协议 18 · 子项目 B）。
 *
 * ## 为什么用真 Broker 而不是替身
 *
 * 测试里要断言的仍然是「发了哪条命令、带没带 sandboxPolicy、写没写那个文件」——
 * 那些都由 `ctx.shell` / `ctx.fs` 的替身观察。所以这里给的是**真的** Broker，
 * 只是把它的 `ctx` 指向测试自己的内存替身：策略判据（操作表、来源、授权、目标路径）
 * 全部走真实代码，替身只负责"世界"。
 *
 * 缺省是**已授权**：绝大多数用例关心的是业务行为，不是授权闸门；需要验闸门的用例
 * 显式传 `consentOf: () => missingConsent()`。
 */
import { createLocalAccessBroker } from '../../src/host/access/broker.ts'
import { workbenchConfigPath } from '../../src/host/state/persist.ts'
import { ifindCredentialPath } from '../../src/host/ifind/store.ts'
import { ossConfigPath } from '../../src/host/oss/cred.ts'
import { grantedConsent, missingConsent } from './local-access-fixture.mjs'

export const TEST_HOME = '/Users/x'
export const TEST_WORKDIR = '/cases/session'

export const TEST_TARGETS = {
  'workbench-state': workbenchConfigPath,
  'ifind-credential': ifindCredentialPath,
  'oss-config': ossConfigPath,
}

/**
 * 造一个真 Broker。
 *
 * @param ctx 测试的 ctx 替身（`shell` / `fs` 由它提供）。
 * @param patch 覆盖项：授权收据、主目录、工作目录、诊断上限。
 */
export function makeTestAccess(ctx, patch = {}) {
  // 传了 `state` 就直接用它：调用方（例如 `makeDeps`）改 `state.localAccess` 时，
  // Broker 必须**立刻**看到 —— 否则"撤销后不放行"这类断言测的就是一个副本。
  const state = patch.state ?? { localAccess: patch.consent ?? grantedConsent() }
  const broker = createLocalAccessBroker({
    ctx,
    state,
    home: async () => patch.home ?? TEST_HOME,
    workdir: async () => patch.workdir ?? TEST_WORKDIR,
    // 平台事实：分类器要用它区分 macOS 钥匙串与 Windows 错误（`patch.platform` 可覆盖）。
    platform: async () => patch.platform ?? 'darwin-arm64',
    targets: TEST_TARGETS,
    hostVersion: '0.0.15-test',
    protocolVersion: 18,
    ...(patch.diagnosticsLimit === undefined ? {} : { diagnosticsLimit: patch.diagnosticsLimit }),
  })
  return { access: broker, consentState: state }
}

/** 未授权版本的快捷方式（闸门用例用）。 */
export function makeUnauthorizedAccess(ctx, patch = {}) {
  return makeTestAccess(ctx, { ...patch, consent: missingConsent() })
}
