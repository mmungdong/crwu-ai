import * as React from 'react'
import { Badge, Button, Card, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from './consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import type { WorkspaceView } from '../../../shared/types.ts'
import type { ClientServices } from './services.ts'
import { artifactHint, workspaceStatus } from './workspace-view.ts'
import { workbenchApi } from '../report-audit/api.ts'

/**
 * ① 工作空间（案例根目录）。
 *
 * **这是前置条件，不是可选配置**：`audit-start` 硬性要求已选定工作空间 ——
 * 案例目录为空时审核指令里不会出现「唯一根目录」，子会话就只能写进它继承的 cwd。
 * 所以清单偏好没命中、也没有上次选择时，用户必须有办法**自己选一个目录**，
 * 否则这个插件在那种部署下完全用不了。
 *
 * 选目录走浏览器侧的 `uiWorkspace.pickDirectory()`，再把目录注册成工作空间
 * （`workspaces.create`），最后通知 Host 记下来（`workbench:workspace` 会落盘）。
 * 缺 `uiWorkspace` / `workspaces` 时只提示「服务不可用」，不抛错。
 */

export interface WorkspaceCardProps {
  workspace: WorkspaceView | null
  services: ClientServices
  busy: boolean
  message: string
  onBusy: (busy: boolean) => void
  onMessage: (message: string) => void
  /** 选定/恢复后刷新自检页（Host 的 workspace 视图变了）。 */
  onRefresh: () => void
}

export function WorkspaceCard(props: WorkspaceCardProps): React.ReactElement {
  const status = workspaceStatus(props.workspace)
  const servicesReady = props.services.uiWorkspace !== undefined && props.services.workspaces !== undefined

  /** 把「一个有绝对路径的目录」登记为工作空间并通知 Host。 */
  const adopt = React.useCallback(async (path: string, created: boolean): Promise<void> => {
    const workspaces = props.services.workspaces
    if (workspaces?.create === undefined) {
      props.onMessage(zhCN.wsServiceUnavailable)
      return
    }
    const view = await workspaces.create({ path })
    const workspaceId = String(view.workspaceId ?? '')
    const applied = await workbenchApi.workspace({
      path: String(view.path ?? path),
      id: workspaceId,
      title: String(view.title ?? ''),
    })
    if (applied.persistError !== undefined && String(applied.persistError) !== '') {
      props.onMessage(String(applied.persistError))
    } else {
      props.onMessage(created ? `${zhCN.wsCreated}${path}` : `${zhCN.wsPicked}${path}${zhCN.wsRemembered}`)
    }
    // 在案例根目录的会话里打开工作台，审核子会话的 cwd 才会跟它一致。
    if (workspaceId !== '' && props.services.uiWorkspace?.openWorkspace !== undefined) {
      await props.services.uiWorkspace.openWorkspace(workspaceId).catch(() => undefined)
    }
    props.onRefresh()
  }, [props])

  const pick = (createNew: boolean): void => {
    const uiWorkspace = props.services.uiWorkspace
    if (uiWorkspace?.pickDirectory === undefined) {
      props.onMessage(zhCN.wsServiceUnavailable)
      return
    }
    props.onBusy(true)
    props.onMessage('')
    uiWorkspace.pickDirectory()
      .then(async (picked) => {
        if (picked === null || picked === undefined || picked === '') {
          props.onMessage(zhCN.wsCancelled)
          return
        }
        const path = createNew && uiWorkspace.createDirectory !== undefined
          ? await uiWorkspace.createDirectory(picked, 'crwu-workspace')
          : picked
        await adopt(path, createNew)
      })
      .catch((cause: unknown) => {
        props.onMessage(`${zhCN.wsFailed}${cause instanceof Error ? cause.message : String(cause)}`)
      })
      .finally(() => { props.onBusy(false) })
  }

  const auto = (): void => {
    props.onBusy(true)
    props.onMessage('')
    workbenchApi.workspaceAuto()
      .then((result) => {
        const workspace = (result as { workspace?: WorkspaceView }).workspace
        props.onMessage(workspace?.chosen === true
          ? `${zhCN.wsAutoRestored}${workspace.path}`
          : zhCN.wsAutoNone)
        props.onRefresh()
      })
      .catch((cause: unknown) => {
        props.onMessage(`${zhCN.wsAutoFailed}${cause instanceof Error ? cause.message : String(cause)}`)
      })
      .finally(() => { props.onBusy(false) })
  }

  const openInWorkspace = (): void => {
    const uiWorkspace = props.services.uiWorkspace
    const id = String(props.workspace?.id ?? '')
    if (uiWorkspace?.openWorkspace === undefined || id === '') {
      props.onMessage(zhCN.wsServiceUnavailable)
      return
    }
    uiWorkspace.openWorkspace(id)
      .then(() => { props.onMessage(`${zhCN.wsOpenedSession}${status.path}`) })
      .catch((cause: unknown) => {
        props.onMessage(`${zhCN.wsFailed}${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }

  return <Card
    title={zhCN.wsSectionTitle}
    extra={status.missing
      ? <Badge text={zhCN.wsMissingDirBadge} tone="high" />
      : (status.chosen
        ? <Badge text={`${zhCN.wsChosen}${status.sourceLabel === '' ? '' : ` · ${status.sourceLabel}`}`} tone="ok" />
        : <Badge text={zhCN.wsNotChosen} tone="high" />)}
  >
    {status.missing
      // 目录没了：说清是哪一个 + 给出重选/恢复自动识别的出口。绝不静默换到别的工作空间。
      ? <>
          <Notice tone="warn">
            <div>{`${zhCN.wsMissingDir}${status.path}`}</div>
            <div className={C.muted}>{zhCN.wsMissingDirHint}</div>
          </Notice>
          <div className={C.row}>
            <Button label={zhCN.wsPick} tone="primary" small disabled={props.busy || !servicesReady} onClick={() => pick(false)} />
            <Button label={zhCN.wsCreate} small disabled={props.busy || !servicesReady} onClick={() => pick(true)} />
            <Button label={zhCN.wsAuto} small disabled={props.busy} onClick={auto} />
          </div>
          {servicesReady ? null : <div className={C.muted}>{zhCN.wsServiceUnavailable}</div>}
        </>
      : (status.chosen
        ? <>
            <div className={C.mono} style={{ fontWeight: 600 }}>{status.path}</div>
            <div className={C.muted}>{artifactHint(status.path)}</div>
            <div className={C.row} style={{ marginTop: '6px' }}>
              <Button label={zhCN.wsChange} small disabled={props.busy || !servicesReady} onClick={() => pick(false)} />
              <Button label={zhCN.wsOpenSession} small disabled={props.busy} onClick={openInWorkspace} />
              {status.canAuto ? <Button label={zhCN.wsAuto} small disabled={props.busy} onClick={auto} /> : null}
            </div>
          </>
        : <>
            <Notice tone="warn">{zhCN.wsMissing}</Notice>
            <div className={C.row}>
              <Button label={zhCN.wsPick} tone="primary" small disabled={props.busy || !servicesReady} onClick={() => pick(false)} />
              <Button label={zhCN.wsCreate} small disabled={props.busy || !servicesReady} onClick={() => pick(true)} />
            </div>
            {servicesReady ? null : <div className={C.muted}>{zhCN.wsServiceUnavailable}</div>}
          </>)}

    {props.message === '' ? null : <div className={C.muted}>{props.message}</div>}
  </Card>
}
