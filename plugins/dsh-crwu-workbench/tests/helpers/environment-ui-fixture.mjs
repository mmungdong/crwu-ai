/**
 * Shared environment-page test fixture (unit + browser).
 *
 * Pure builders for a **fake** `EnvResult` plus a memory-only same-origin RPC. Nothing here talks
 * to a real account, credential store, provider, file or DSH profile; paths live under `/fixture`.
 * The private supervisor probe seeded these shapes; this is the portable, relative-import copy.
 */
import { grantedConsent } from './local-access-fixture.mjs'
import { WORKBENCH_PROTOCOL } from '../../src/shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../src/shared/access/types.ts'

/** Package-integrity test shape: three bundled tools, all present. */
export function packagesOk(patch = {}) {
  const tool = (name, size) => ({
    name, label: `${name} 组件`, file: name, present: true, sizeBytes: size, manifestSizeBytes: size,
    sha256: `sha-${name}`, expectedVersion: name === 'dws' ? '>=0.2.14' : '', note: `${name} 的用途`,
    ok: true, reason: '',
  })
  return {
    ok: true, supported: true, platform: 'darwin-arm64',
    packageRoot: '/fixture/plugin',
    manifestPath: '/fixture/plugin/bin/manifest.json',
    manifestFound: true,
    tools: [tool('crwu', 7351330), tool('dws', 32432720), tool('ossutil', 10849218)],
    note: '插件内置组件 3/3 完整。',
    ...patch,
  }
}

/** DSH bundled script runtime shape. */
export function runtimeOk(patch = {}) {
  return {
    ok: true, state: 'ok', path: '/fixture/python/bin/python3', versionText: '3.12.3',
    distributions: { openpyxl: '3.1.2', 'python-docx': '1.1.2' },
    missingPackages: [], error: '', source: 'DSH 自带（bundled runtime）',
    expect: '>=3.10', required: true, requiredPackages: ['openpyxl', 'python-docx'],
    note: '审核技能脚本用的 Python 运行时，由 DSH 自带',
    ...patch,
  }
}

/** Optional external data (iFinD): credential + real-data-verified are two facts. */
export function externalOk(patch = {}) {
  return {
    path: '/fixture/cfg.json', required: false, ok: true, state: 'authenticated', errorKind: '',
    reason: '', tokenLength: 12, checkedAt: '2026-09-26T10:00:00.000Z', toolCount: 3,
    dataVerified: true, dataTool: 'get_stock_summary', dataSample: '{"value":42}',
    applyUrl: 'https://example.invalid/', ...patch,
  }
}

/** OSS delivery config shape: masked fake credentials only. */
export function deliveryOk(patch = {}) {
  return {
    oss: {
      enabled: true, bucket: 'fixture-bucket', endpoint: 'oss-cn-fixture.invalid', prefix: 'crwu/audit',
      linkMode: 'signed', linkTtl: 3600, autoUpload: true, ossutilReady: true,
      ossutilPath: '/fixture/plugin/bin/ossutil',
    },
    ossCred: {
      path: '/fixture/.ossutilconfig', exists: true, endpoint: 'oss-cn-fixture.invalid',
      accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH',
    },
    probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://fixture-bucket/' },
    ...patch,
  }
}

/** Not-yet-saved OSS credential shape (so the form fields really render). */
export function deliveryUnsaved(patch = {}) {
  return deliveryOk({
    ossCred: {
      path: '/fixture/.ossutilconfig', exists: false, endpoint: '', accessKeyIdMasked: '',
      hasSecret: false, hasSts: false, language: '',
    },
    probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: false, state: '未配置', detail: '' },
    ...patch,
  })
}

/** Unified environment model (`env.state`), all required items passing. */
export function stateBody(patch = {}) {
  const item = (state, extra = {}) => ({ state, value: '', reason: '', required: true, ...extra })
  return {
    status: 'ready',
    proceed: true,
    userSetup: {
      workspace: item('ok', { value: '/fixture/评估工作空间' }),
      credentialsConsent: item('ok'),
      h3yun: item('ok', { value: 'userId fixture' }),
      dingtalk: item('ok'),
      aliyunOss: item('ok', { value: 'AKID****7890 · AK 正常' }),
      // iFinD is an optional data source (`required: false`, outside the required denominator).
      ifind: item('authenticated', { value: 'API-Key 已保存（长度 12，不回显）', required: false }),
    },
    systemHealth: {
      packageIntegrity: item('ok'),
      dshRuntime: item('ok'),
      platform: item('ok'),
      toolRegistry: item('unverified', { required: false }),
    },
    capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    issues: [],
    passed: 7,
    total: 7,
    blocked: [],
    allOk: true,
    checkError: '',
    ...patch,
  }
}

/** A fully-ready env answer (real field names of the Host `EnvResult`). */
export function okEnvBody(patch = {}) {
  return {
    ok: true, configSource: '/fixture/config.yml', platform: 'darwin-arm64',
    packageIntegrity: packagesOk(),
    runtime: runtimeOk(),
    external: externalOk(),
    services: [{ id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId fixture' }],
    blocked: [], allOk: true, home: '/fixture/employee', localAccess: grantedConsent(),
    delivery: deliveryOk(),
    workspace: { chosen: true, path: '/fixture/评估工作空间', title: '评估工作空间', id: 'fixture-ws', source: 'manual', missing: false },
    sessionWorkspace: { parentSessionId: 'fixture-parent', sessionCwd: '/fixture/评估工作空间', workspaceId: 'fixture-ws', workspacePath: '/fixture/评估工作空间', workspaceTitle: '评估工作空间' },
    me: { name: '', org: '', userId: '' },
    state: stateBody(),
    ...patch,
  }
}

/** Ready base env with the **optional** iFinD source unconfigured (status `degraded`, still passable). */
export function degradedEnvBody(patch = {}) {
  return okEnvBody({
    external: externalOk({ state: 'unconfigured', ok: false, dataVerified: false, checkedAt: '', tokenLength: 0, reason: '还没有保存 iFinD API-Key' }),
    state: stateBody({
      status: 'degraded', capabilities: { global: true, auditCore: true, delivery: true, externalData: false },
      userSetup: { ...stateBody().userSetup, ifind: { state: 'unconfigured', value: '', reason: '还没有保存 iFinD API-Key', required: false } },
      issues: [{
        id: 'ifind', owner: 'user', blocking: false, scope: 'external-data',
        action: '配置外部数据源（同花顺 iFinD API-Key）',
        message: '外部数据核查未就绪（同花顺 iFinD）：还没有配置外部数据源。不影响进入报告审核。',
      }],
      blocked: [],
    }),
    ...patch,
  })
}

/** A blocking env: the workspace root is not chosen yet. */
export function blockedEnvBody(patch = {}) {
  return okEnvBody({
    allOk: false,
    blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择'],
    workspace: { chosen: false, path: '', title: '', id: '', source: '', missing: false },
    state: stateBody({
      status: 'action-required', proceed: false, allOk: false,
      passed: 6, total: 7,
      capabilities: { global: false, auditCore: false, delivery: true, externalData: true },
      userSetup: {
        ...stateBody().userSetup,
        workspace: { state: 'unconfigured', value: '', reason: '未找到工作空间「中瑞世联工作空间」，请手动选择', required: true },
      },
      issues: [{
        id: 'workspace', owner: 'user', blocking: true, scope: 'global',
        action: '选择案例根目录', message: '未找到工作空间「中瑞世联工作空间」，请手动选择',
      }],
      blocked: ['未找到工作空间「中瑞世联工作空间」，请手动选择'],
    }),
    ...patch,
  })
}

/** `boot` answer used by the browser fixture. */
export function environmentBoot() {
  return {
    ok: true, rev: 'pkg-fixture', version: '0.0.0-fixture', buildKind: 'dev', builtAt: '',
    protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION, parentSessionId: '',
  }
}

/** Named env presets for the browser fixture (`?state=`). */
export function environmentFixtureEnv(name = 'degraded') {
  if (name === 'ready') return okEnvBody()
  if (name === 'blocked') return blockedEnvBody()
  if (name === 'degraded') return degradedEnvBody()
  return degradedEnvBody()
}

/**
 * Memory-only same-origin RPC. `env` and `boot` return the fake facts; every other op is an ok
 * empty answer, so the diagnostics effect and the update store stay inert.
 */
export function environmentFixtureFetch(env, boot = environmentBoot()) {
  return async (_input, init) => {
    let op = ''
    try { op = String(JSON.parse(String(init?.body ?? '{}')).op ?? '') } catch { op = '' }
    const body = op === 'boot' ? boot : op === 'env' ? env : { ok: true, error: '', entries: [], dwsDiagnosable: false }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
