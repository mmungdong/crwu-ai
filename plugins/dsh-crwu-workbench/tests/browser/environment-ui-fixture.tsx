/**
 * Isolated real-source fixture for the environment page inside the actual shell.
 *
 * Built by `install/ui-browser-check.mjs` with an external test-only React/ReactDOM root. It mounts
 * the **real** `WorkbenchPanel` on the environment page with a fake `EnvResult`; every same-origin
 * RPC is answered in memory under `/fixture` paths. No account, credential store, provider, file or
 * DSH profile is touched.
 */
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../../src/client/shell/WorkbenchPanel.tsx'
import { createModuleStore, type ModuleStore } from '../../src/client/shell/module-store.ts'
import { createEnvStatusStore, type EnvStatusStore } from '../../src/client/modules/environment/model/status.ts'
import { createBuildStore, type BuildStore } from '../../src/client/shell/build-store.ts'
import { environmentStateOf } from '../../src/client/modules/environment/api.ts'
import { WORKBENCH_STYLE_TEXT } from '../../src/client/styles/bundle.ts'
import { environmentFixtureEnv, environmentFixtureFetch } from '../helpers/environment-ui-fixture.mjs'
import type { ClientServices } from '../../src/client/shell/services.ts'
import * as React from 'react'

/** Fake host services: memory only, just enough for the workspace picker to render enabled. */
const SERVICES: ClientServices = {
  uiWorkspace: { pickDirectory: async () => null } as unknown as ClientServices['uiWorkspace'],
  workspaces: { create: async () => ({ path: '/fixture/评估工作空间' }) } as unknown as ClientServices['workspaces'],
  layout: undefined, sidebarRight: undefined, sessions: undefined,
}

const STATE = new URLSearchParams(location.search).get('state') ?? 'degraded'
const ENV = environmentFixtureEnv(STATE)
window.fetch = environmentFixtureFetch(ENV) as typeof window.fetch

interface FixtureProps {
  envStatus: EnvStatusStore
  build: BuildStore
  modules: ModuleStore
}

function App(props: FixtureProps): React.ReactElement {
  return <>
    <style>{WORKBENCH_STYLE_TEXT}</style>
    {/* The DSH shell owns these tokens; the fixture provides them (including the success green)
        so a leaked green is visible to the checks. Theme flips go through the body attribute. */}
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

/** Real stores, pre-seeded from the memory RPC, then landed on the environment page. */
async function main(): Promise<void> {
  const envStatus = createEnvStatusStore()
  await envStatus.refresh()
  const build = createBuildStore()
  await build.refresh()
  const modules = createModuleStore()
  modules.navigate('env', { state: environmentStateOf(envStatus.get().env) })
  createRoot(document.getElementById('root') as HTMLElement).render(
    <App envStatus={envStatus} build={build} modules={modules} />,
  )
}

void main()
