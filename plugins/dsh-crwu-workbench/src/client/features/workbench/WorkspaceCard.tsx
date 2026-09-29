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
 * ⚠️ **只选已有目录，插件不建目录**（2026-09-30 口径）：卡片只提供「选择已有目录」，
 * 没有「新建目录并用作工作空间」，也**不调用** `uiWorkspace.createDirectory`。
 * 目录选择器回什么就用什么（`workspaces.create` 只是把它**登记**成工作空间，不建文件系统目录）；
 * 路径不存在 / 不是目录时由 Host 在审核启动时拒绝，界面只负责说清「请重新选一个已有目录」。
 * 允许自动创建的只有**案例子目录**（`<工作空间>/<流水号>`，由 Host 在审核启动时创建）。
 *
 * 选目录走浏览器侧的 `uiWorkspace.pickDirectory()`，再登记（`workspaces.create`），
 * 最后通知 Host 记下来（`workbench:workspace` 会落盘）。
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
  /**
   * 已就绪时**压缩成一行摘要**（需求口径：「自动识别成功时压缩成摘要，只有缺失、失效或用户
   * 要更换时才展开」）。缺省 false = 老样子（完整卡片），环境页传 true。
   *
   * 为什么不是直接删掉那几行：用户要**更换**工作空间时仍然需要完整的操作集合（选已有目录 /
   * 恢复自动识别），所以收起只是默认视图，不是删功能。
   */
  collapsed?: boolean
}

export function WorkspaceCard(props: WorkspaceCardProps): React.ReactElement {
  const status = workspaceStatus(props.workspace)
  const servicesReady = props.services.uiWorkspace !== undefined && props.services.workspaces !== undefined
  // 摘要态只在"已就绪 + 调用方要求收起"时生效：缺失/失效永远展开（那是要用户处理的状态）。
  const [expanded, setExpanded] = React.useState(false)
  const summaryOnly = props.collapsed === true && status.chosen && !status.missing && !expanded

  /** 把「一个用户选中的已有目录」登记为工作空间并通知 Host。 */
  const adopt = React.useCallback(async (path: string): Promise<void> => {
    const workspaces = props.services.workspaces
    if (workspaces?.create === undefined) {
      props.onMessage(zhCN.wsServiceUnavailable)
      return
    }
    // `workspaces.create` 在这里的语义是**登记已有目录**（DSH 的注册表要求目录已存在）；
    // 本卡片不建目录，所以没有"新建"分支，也没有 created 标志。
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
      props.onMessage(`${zhCN.wsPicked}${path}${zhCN.wsRemembered}`)
    }
    // 在案例根目录的会话里打开工作台，审核子会话的 cwd 才会跟它一致。
    if (workspaceId !== '' && props.services.uiWorkspace?.openWorkspace !== undefined) {
      await props.services.uiWorkspace.openWorkspace(workspaceId).catch(() => undefined)
    }
    props.onRefresh()
  }, [props])

  const pick = (): void => {
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
        // 用户选中的路径**原样**使用：这里既不再拼子目录，也不调用 createDirectory。
        await adopt(picked)
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

  if (summaryOnly) {
    return <Card
      title={zhCN.wsSectionTitle}
      extra={<Badge text={`${zhCN.wsChosen}${status.sourceLabel === '' ? '' : ` · ${status.sourceLabel}`}`} tone="ok" />}
    >
      <div className={C.row}>
        <span className={C.mono} style={{ fontWeight: 600 }}>{status.path}</span>
        <span className={C.grow} />
        <Button label={zhCN.wsChange} small disabled={props.busy || !servicesReady} onClick={() => { setExpanded(true) }} />
      </div>
      <div className={C.muted}>{artifactHint(status.path)}</div>
      {props.message === '' ? null : <div className={C.muted}>{props.message}</div>}
    </Card>
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
            <Button label={zhCN.wsPick} tone="primary" small disabled={props.busy || !servicesReady} onClick={pick} />
            <Button label={zhCN.wsAuto} small disabled={props.busy} onClick={auto} />
          </div>
          {servicesReady ? null : <div className={C.muted}>{zhCN.wsServiceUnavailable}</div>}
        </>
      : (status.chosen
        ? <>
            <div className={C.mono} style={{ fontWeight: 600 }}>{status.path}</div>
            <div className={C.muted}>{artifactHint(status.path)}</div>
            <div className={C.row} style={{ marginTop: '6px' }}>
              <Button label={zhCN.wsChange} small disabled={props.busy || !servicesReady} onClick={pick} />
              {status.canAuto ? <Button label={zhCN.wsAuto} small disabled={props.busy} onClick={auto} /> : null}
            </div>
          </>
        : <>
            <Notice tone="warn">{zhCN.wsMissing}</Notice>
            <div className={C.row}>
              <Button label={zhCN.wsPick} tone="primary" small disabled={props.busy || !servicesReady} onClick={pick} />
            </div>
            {servicesReady ? null : <div className={C.muted}>{zhCN.wsServiceUnavailable}</div>}
          </>)}

    {props.message === '' ? null : <div className={C.muted}>{props.message}</div>}
  </Card>
}
