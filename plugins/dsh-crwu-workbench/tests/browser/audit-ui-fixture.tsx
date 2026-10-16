/**
 * Isolated real-source fixture for the audit workface (报告审核 / 本地审核) inside the actual shell.
 *
 * Built by `install/ui-browser-check.mjs` with an external test-only React/ReactDOM root. It mounts
 * the **real** `WorkbenchPanel` with real env/build/module stores, pre-seeded from the shared
 * memory-only environment fixture. Every same-origin RPC is answered locally under `/fixture` paths
 * and recorded on `window.fixtureAuditCalls` as `{op, args}` fake data only: no account, credential
 * store, provider, file, DSH profile or external fetch is touched. Theme flips go through the body
 * `data-ds-dark-theme` attribute the DSH shell uses; there are no product test hooks.
 */
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../../src/client/shell/WorkbenchPanel.tsx'
import { createModuleStore, type ModuleStore } from '../../src/client/shell/module-store.ts'
import { createEnvStatusStore, type EnvStatusStore } from '../../src/client/modules/environment/model/status.ts'
import { createBuildStore, type BuildStore } from '../../src/client/shell/build-store.ts'
import { environmentStateOf } from '../../src/client/modules/environment/api.ts'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'
import { environmentBoot, environmentFixtureEnv, environmentFixtureFetch } from '../helpers/environment-ui-fixture.mjs'
import type { ClientServices } from '../../src/client/shell/services.ts'
import * as React from 'react'

/** Fake host services: memory only; no picker, session, workspace or provider is reachable. */
const SERVICES: ClientServices = {
  uiWorkspace: undefined, workspaces: undefined, layout: undefined, sidebarRight: undefined, sessions: undefined,
}

/** Two fake pending rows (fixed `/fixture` data; fields follow the Host `TaskRow`). */
const FORMAL_TASK = {
  name: '某项目资产评估报告', project: '某项目', business: '资产经营', risk: '低',
  reviewLevel: '初审', reviewState: '审核中', currentNode: '三级复核人',
  seqNo: '2026-301705-LX10170-BG8746', status: 'doing', statusName: '进行中',
  modifiedAt: '2026-09-20 18:18:59', id: 'fixture-0000-0000-0000-000000000000', idTail: 'fixture0',
}
const FRESH_TASK = {
  name: '另一项目资产评估报告', project: '另一项目', business: '资产经营', risk: '低',
  reviewLevel: '初审', reviewState: '审核中', currentNode: '三级复核人',
  seqNo: '2026-301705-LX10171-BG8747', status: 'doing', statusName: '进行中',
  modifiedAt: '2026-09-21 09:30:00', id: 'fixture-0000-0000-0000-000000000001', idTail: 'fixture1',
}
const PENDING_TASKS = [FORMAL_TASK, FRESH_TASK]
/** Cloud deliveries keyed by seqNo; only the formal row owns one (=> 查看报告 + whale + •••). */
const CLOUD: Record<string, { seqNo: string; files: Array<{ key: string; name: string }>; htmlKey: string; jsonKey: string }> = {
  [FORMAL_TASK.seqNo]: {
    seqNo: FORMAL_TASK.seqNo,
    files: [{ key: `crwu/audit/${FORMAL_TASK.seqNo}/审核意见.html`, name: '审核意见.html' }],
    htmlKey: `crwu/audit/${FORMAL_TASK.seqNo}/审核意见.html`,
    jsonKey: `crwu/audit/${FORMAL_TASK.seqNo}/审核结果.json`,
  },
}

const ENV = environmentFixtureEnv('ready')
const BOOT = environmentBoot()
const fallback = environmentFixtureFetch(ENV, BOOT)

interface AuditCall { op: string; args: Record<string, unknown> }
const calls: AuditCall[] = []
Object.assign(window, { fixtureAuditCalls: calls })

const jsonOf = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// Memory-only same-origin RPC: every op records `{op, args}` and is answered with fake facts.
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  let payload: { op?: string; args?: unknown } = {}
  try { payload = JSON.parse(String(init?.body ?? '{}')) } catch { payload = {} }
  const op = String(payload.op ?? '')
  const args = (payload.args ?? {}) as Record<string, unknown>
  calls.push({ op, args })

  if (op === 'pending') {
    const query = String(args.query ?? '')
    // All rows when the query is empty; the runner uses Enter/typing to tell requests apart.
    const rows = query === '' ? PENDING_TASKS : PENDING_TASKS.filter((task) => task.seqNo.includes(query))
    return jsonOf({
      ok: true, error: '', rows, formName: '报告审核', page: 1, size: 20, total: rows.length,
      query, filterMode: '', escalated: false, escalateAvailable: false,
    })
  }
  if (op === 'audit-status') {
    return jsonOf({
      ok: true, audits: [], parentSessionId: '', active: { key: '', childId: '', since: 0 }, canStartNext: true,
    })
  }
  // The client facade sends the batch op as `oss-index`; accept the explicit batch alias too so a
  // future rename in the owning api module does not silently break this fixture.
  if (op === 'oss-index' || op === 'oss-batch-index') {
    const seqNos = Array.isArray(args.seqNos) ? args.seqNos as string[] : []
    return jsonOf({
      ok: true, error: '',
      results: Object.fromEntries(seqNos.map((seqNo) => [seqNo, { ok: true, error: '', item: CLOUD[seqNo] ?? null }])),
    })
  }
  if (op === 'local-audit-status' || op === 'local-audit-start' || op === 'local-audit-claim') {
    return jsonOf({ ok: true, error: '' })
  }
  return fallback(input, init)
}) as typeof window.fetch

interface FixtureProps {
  envStatus: EnvStatusStore
  build: BuildStore
  modules: ModuleStore
}

function App(props: FixtureProps): React.ReactElement {
  return <>
    <style>{WORKBENCH_STYLE_TEXT}</style>
    {/* The DSH shell owns these tokens; the fixture provides them so focus rings, cards and the
        success/error palette render the same as in the shell. Theme flips use the body attribute. */}
    <style>{'html,body,#root{height:100%;margin:0}'
      + '[data-crwu-scope]{--dsw-alias-state-success-primary:#22C55E;--dsw-alias-state-error-primary:#B42318;--dsw-alias-state-warn-primary:#A76D16;--dsw-shadow-lv1:0 1px 3px rgba(0,0,0,.08);--dsw-alias-bg-layer-1:var(--crwu-surface);--dsw-alias-border-l1:var(--crwu-border);--dsw-alias-label-primary:var(--crwu-text-primary);--dsw-alias-label-caption:var(--crwu-text-secondary)}'
      + '[data-crwu-scope="workbench"]{--dsw-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}'}</style>
    <WorkbenchPanel
      services={SERVICES}
      envStatus={props.envStatus}
      build={props.build}
      modules={props.modules}
    />
  </>
}

/** Real stores, pre-seeded from the memory RPC, then landed on the audit module. */
async function main(): Promise<void> {
  const envStatus = createEnvStatusStore()
  await envStatus.refresh()
  const build = createBuildStore()
  await build.refresh()
  const modules = createModuleStore()
  modules.navigate('audit', { state: environmentStateOf(envStatus.get().env) })
  createRoot(document.getElementById('root') as HTMLElement).render(
    <App envStatus={envStatus} build={build} modules={modules} />,
  )
}

void main()
