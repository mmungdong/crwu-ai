/**
 * 外部案例的浏览器预检与来源框架（协议 32）。
 *
 * 纯逻辑（尝试策略、登录状态 → 阶段、来源白名单、抓取通道契约）都在这一层；
 * 具体站点的抓取实现与结构化 Tool 在 `tools/report-evaluation/*` 与 `market/*`。
 */
export { MARKET_ATTEMPTS, withAttempts } from './retry.ts'
export type { AttemptOptions, AttemptOutcome } from './retry.ts'
export {
  MARKET_PROVIDER_IDS,
  decidePhase,
  isMarketProviderId,
  loginGapText,
  loginStateLabel,
  loginStateOf,
  providerLabel,
} from './login-state.ts'
export type {
  LoginState,
  MarketProviderId,
  PagePhase,
  PhaseDecision,
  ProviderLogin,
  ProviderRun,
} from './login-state.ts'
export {
  isAllowedProvider,
  narrowProviders,
  providerCatalogue,
} from './provider.ts'
export type {
  MarketFetchResult,
  MarketProvider,
  MarketSearchInput,
  MarketSearchResult,
  MarketTransport,
  RawListing,
} from './provider.ts'
export {
  classifyProbe,
  looksLikeCaptcha,
  looksLikeLoginWall,
} from './login-probe.ts'
export type { ProbeFacts, ProbeVerdict } from './login-probe.ts'
export {
  MARKET_MAX_PAGES,
  PROVIDER_SITES,
  allProviders,
  expandTemplate,
  htmlProvider,
  siteOf,
} from './providers.ts'
export type { HtmlProviderDeps, ProviderSite } from './providers.ts'
export {
  MARKET_BODY_MAX,
  MARKET_USER_AGENT,
  fetchTransport,
  hostAllowed,
  hostOf,
} from './fetch-transport.ts'
export type { FetchTransportOptions } from './fetch-transport.ts'
export {
  EVIDENCE_DIR,
  SCREENSHOT_GAP,
  evidenceExists,
  evidenceFileName,
  saveEvidence,
} from './capture.ts'
export type { EvidenceEntry, SaveEvidenceInput } from './capture.ts'
