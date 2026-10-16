/**
 * Isolated real-source fixture for the valuation workface inside the actual shell.
 *
 * Built by `install/ui-browser-check.mjs` with an external test-only React/ReactDOM root. The
 * fixture mounts the **real** `WorkbenchPanel` (real navigation / env / build stores) instead of
 * a hand-copied shell. Every same-origin RPC is answered in memory under `/fixture` paths: no
 * account, file, provider, DSH profile or external fetch is touched.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../../src/client/shell/WorkbenchPanel.tsx'
import { createModuleStore, type ModuleStore } from '../../src/client/shell/module-store.ts'
import { createEnvStatusStore, type EnvStatusStore } from '../../src/client/modules/environment/model/status.ts'
import { createBuildStore, type BuildStore } from '../../src/client/shell/build-store.ts'
import { environmentStateOf } from '../../src/client/modules/environment/api.ts'
import { createReportEvaluationController } from '../../src/client/modules/report-evaluation/controller.ts'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'
import { WORKBENCH_PROTOCOL } from '../../src/shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../src/shared/access/types.ts'
import type { ClientServices } from '../../src/client/shell/services.ts'

const PATHS = [
  '/fixture/materials/房屋权属资料.pdf',
  '/fixture/materials/项目说明.docx',
  '/fixture/materials/周边市场记录.xlsx',
]
const KINDS = ['pdf', 'word', 'excel']
const FILE_ROWS = PATHS.map((path, index) => ({
  path, name: path.split('/').at(-1), kind: KINDS[index], sizeBytes: 2048 * (index + 1),
  parentPath: path, state: 'included',
}))
const FILES = FILE_ROWS.map((file) => ({ ...file, status: 'scanned', reason: '', fileCount: 1, dirHint: '' }))

const calls = { intake: [], start: [], preflight: 0, open: 0 }

const port = {
  fileInput: async () => PATHS.map((path) => ({ path, name: path.split('/').at(-1) })),
  pickDirectory: async () => '/fixture/materials',
  scan: async () => ({
    ok: true, error: '', fileCount: 3, readableCount: 3, overLimit: false, limit: 30,
    skippedCount: 0, items: FILES, files: FILE_ROWS,
  }),
  intake: async (input) => {
    calls.intake.push(input)
    return {
      ok: true, error: '', errorKind: '', requestId: input.requestId, previewId: 'fixture-preview',
      projectId: 'fixture-project', casePath: '/fixture/case', inputDigest: 'sha256:fixture',
      assetType: input.assetType, methodRequest: input.method, baseDate: input.baseDate || null,
      purpose: input.purpose || null, valueType: input.valueType || null,
      supplementalPrompt: input.supplementalPrompt || '',
      files: FILE_ROWS.map((file, index) => ({
        fileId: `file${index}`, fileName: file.name, absolutePath: file.path,
        archiveRelativePath: `材料/${file.name}`, kind: file.kind, sizeBytes: file.sizeBytes,
        sha256: 'a'.repeat(64), createdAt: '2026-10-01T01:00:00Z', modifiedAt: '2026-10-10T01:00:00Z',
        readable: true, duplicateOf: null,
      })),
      fileCount: 3, overLimit: false, skipped: [], capabilityGaps: [],
      createdAt: '2026-10-15T01:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    }
  },
  preflight: async () => {
    calls.preflight += 1
    return {
      ok: true, error: '',
      rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', stateLabel: '未登录', reason: '尚未登录', required: false }],
      sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '' }],
      gate: { released: false, required: [], optional: ['lianjia'], reason: '', unavailable: false, checkedAt: '2026-10-15T01:00:00Z' },
      loginJobs: [],
    }
  },
  start: async (input) => {
    calls.start.push(input)
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { ok: true, error: '', projectId: 'fixture-project', parentSessionId: 'fixture-session', dispatchAccepted: true, reused: false }
  },
  openSession: async () => { calls.open += 1; return { ok: true, error: '' } },
  ready: () => ({ ok: true, error: '' }),
}

/** Host services are intentionally empty: the fixture never reaches a real service. */
const SERVICES: ClientServices = {
  uiWorkspace: undefined, workspaces: undefined, layout: undefined, sidebarRight: undefined, sessions: undefined,
}

/**
 * Capability presets for `?capability=` so the browser check can exercise
 * unknown / error / challenge / ready rows without any product test hook.
 */
const CAPABILITY_PRESETS: Record<string, Record<string, unknown>> = {
  unauthenticated: {
    check: 'ready',
    gate: { released: false, required: ['lianjia'], optional: [], reason: '链家 尚未登录', unavailable: false, checkedAt: '2026-10-15T01:00:00Z' },
    rows: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', stateLabel: '未登录', reason: '尚未登录', required: true }],
    sites: [{ siteId: 'lianjia', label: '链家', state: 'unauthenticated', reason: '' }],
    loginJobs: [], error: '', job: null,
  },
  challenge: {
    check: 'ready',
    gate: { released: false, required: ['lianjia'], optional: [], reason: '还有必需来源没有通过登录检查', unavailable: false, checkedAt: '2026-10-15T01:00:00Z' },
    rows: [{
      siteId: 'lianjia', label: '链家', state: 'unknown', stateLabel: '无法检查', reason: '受保护页要求人机验证',
      required: true, verdict: 'captcha',
      challenge: { detected: true, attempted: true, state: 'waiting-user', reasonCode: 'challenge-visible', verifyUrl: 'https://bj.lianjia.com/ershoufang/' },
    }],
    sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '' }],
    loginJobs: [], error: '', job: null,
  },
  unknown: {
    check: 'ready',
    gate: { released: false, required: [], optional: ['lianjia'], reason: '', unavailable: false, checkedAt: '2026-10-15T01:00:00Z' },
    rows: [{ siteId: 'lianjia', label: '链家', state: 'unknown', stateLabel: '', reason: '本次检查没有拿到结论', required: false }],
    sites: [{ siteId: 'lianjia', label: '链家', state: 'unknown', reason: '' }],
    loginJobs: [], error: '', job: null,
  },
  ready: {
    check: 'ready',
    gate: { released: true, required: [], optional: ['lianjia'], reason: '', unavailable: false, checkedAt: '2026-10-15T01:00:00Z' },
    rows: [{ siteId: 'lianjia', label: '链家', state: 'authenticated', stateLabel: '已登录', reason: '', required: false }],
    sites: [{ siteId: 'lianjia', label: '链家', state: 'authenticated', reason: '' }],
    loginJobs: [], error: '', job: null,
  },
  error: {
    check: 'ready', gate: null, rows: [], sites: [], loginJobs: [], error: '检查失败：示例原因', job: null,
  },
}

const params = new URLSearchParams(location.search)
const empty = params.has('empty')
const preset = CAPABILITY_PRESETS[params.get('capability') ?? '']
const controller = createReportEvaluationController(port, {
  initial: empty ? {} : {
    phase: 'draft', selection: PATHS, files: FILES, fileRows: FILE_ROWS, scanState: 'ready',
    fileCount: 3, readableCount: 3, assetType: 'real-estate', method: 'auto',
    purpose: '内部价值研判', valueType: '市场价值', baseDate: '2026-10-15',
    supplementalPrompt: '重点关注周边交通条件、物业现状及近期市场变化。',
    ...(preset === undefined ? {} : { login: preset }),
  },
})
Object.assign(window, { fixtureController: controller, fixtureCalls: calls })

const READY_ENV = {
  ok: true, allOk: true, blocked: [], services: [],
  workspace: { chosen: true, path: '/fixture/case', title: 'fixture', id: 'fixture-ws', source: 'manual', missing: false },
  me: { name: '', org: '', userId: '' },
  state: {
    status: 'ready', proceed: true,
    userSetup: {}, systemHealth: {},
    capabilities: { global: true, auditCore: true, delivery: true, externalData: true },
    issues: [], passed: 1, total: 1, blocked: [], allOk: true, checkError: '',
  },
}
const BOOT = {
  ok: true, rev: 'pkg-fixture', version: '0.0.0-fixture', buildKind: 'dev', builtAt: '',
  protocol: WORKBENCH_PROTOCOL, permissionSchemaVersion: PERMISSION_SCHEMA_VERSION, parentSessionId: '',
}

// Memory-only same-origin RPC: the fixture must never reach a profile or the network.
window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  let op = ''
  try { op = String(JSON.parse(String(init?.body ?? '{}')).op ?? '') } catch { op = '' }
  const body = op === 'boot' ? BOOT : op === 'env' ? READY_ENV : { ok: true, error: '' }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof window.fetch

interface FixtureProps {
  envStatus: EnvStatusStore
  build: BuildStore
  modules: ModuleStore
}

function App(props: FixtureProps): React.ReactElement {
  return <>
    <style>{WORKBENCH_STYLE_TEXT}</style>
    {/* The DSH shell defines the host font; the fixture has no shell, so provide it scoped to the
        panel (theme changes are driven by the browser check through the body attribute). */}
    <style>{'html,body,#root{height:100%;margin:0}'
      + '[data-crwu-scope="workbench"]{--dsw-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}'}</style>
    <WorkbenchPanel
      services={SERVICES}
      envStatus={props.envStatus}
      build={props.build}
      modules={props.modules}
      evaluation={controller}
    />
  </>
}

/** Real stores, pre-seeded from the memory RPC, then landed on the valuation page. */
async function main(): Promise<void> {
  const envStatus = createEnvStatusStore()
  await envStatus.refresh()
  const build = createBuildStore()
  await build.refresh()
  const modules = createModuleStore()
  modules.navigate('eval', { state: environmentStateOf(envStatus.get().env) })
  createRoot(document.getElementById('root') as HTMLElement).render(
    <App envStatus={envStatus} build={build} modules={modules} />,
  )
}

void main()
