/**
 * 本机访问授权（协议 18）的**测试夹具**。
 *
 * 为什么要有这一份：`localAccess` 是一条带版本与能力清单的收据，测试里如果各写一份字面量，
 * 升 schema 或改清单时就会有一半文件忘了改 —— 而它们**照样绿**（断言的是老形状）。
 * 所以「已授权 / 未授权」两种状态只在这里构造：
 *
 * - `grantedConsent()`：`state: 'granted'` + 规范能力清单（等价于旧的 `trustCredentials: true`）；
 * - `missingConsent()`：`state: 'missing'`（等价于旧的 `trustCredentials: false`）；
 * - `consentFor(trusted)`：把旧的布尔语义翻译过来，便于逐行迁移老测试；
 * - `consentConfigJson()` / `legacyTrustConfigJson()`：状态文件里的两种落盘形态
 *   （新版收据 / 旧版布尔），用于「第一次打开」与「旧版升级」两类场景。
 */
import {
  LOCAL_ACCESS_CAPABILITIES,
  LOCAL_ACCESS_SCHEMA_VERSION,
} from '../../src/shared/access/types.ts'

/** 已授权收据视图。 */
export function grantedConsent(grantedAt = '2026-09-28T00:00:00.000Z') {
  return {
    state: 'granted',
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
    reason: '',
  }
}

/** 未授权（从没问过）视图。 */
export function missingConsent(reason = '') {
  return {
    state: 'missing',
    schemaVersion: 0,
    requiredSchemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: '',
    capabilities: [],
    reason,
  }
}

/** 旧布尔语义 → 新收据视图（只用于迁移既有测试，不用于新断言）。 */
export function consentFor(trusted) {
  return trusted === true ? grantedConsent() : missingConsent()
}

/** 状态文件里的**新版**收据（`localAccessConsent` 键）。 */
export function consentRecord(grantedAt = '2026-09-28T00:00:00.000Z') {
  return {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt,
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  }
}

/** 状态文件 JSON：已授权（新版收据）。 */
export function consentConfigJson(grantedAt = '2026-09-28T00:00:00.000Z') {
  return JSON.stringify({ localAccessConsent: consentRecord(grantedAt) })
}

/** 状态文件 JSON：撤销墓碑（版本对、能力集合空）。 */
export function revokedConfigJson() {
  return JSON.stringify({
    localAccessConsent: {
      schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
      grantedAt: '2026-09-28T00:00:00.000Z',
      capabilities: [],
    },
  })
}

/** 状态文件 JSON：旧版布尔授权（应被判成 `outdated`，**不是** granted）。 */
export function legacyTrustConfigJson(trusted = true) {
  return JSON.stringify({ trustCredentials: trusted })
}
