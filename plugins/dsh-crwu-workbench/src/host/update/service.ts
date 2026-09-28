/**
 * 安装与恢复状态机（每个 Host 插件实例一个）。
 *
 * 职责边界：
 * - 只做单飞、安装、取消、进度映射与启动恢复；
 * - 不认识 Context / RPC / Client，也不认识 UI 文案；
 * - 不自动退出或重启桌面应用（重启永远是员工手动完成的事）；
 * - 不自己装包：一切 profile 变更交给 Plugin Manager 的公开 API。
 *
 * 三条硬判据：
 * 1. **先写状态再动手**：`installing` 落盘失败就绝不调用 Plugin Manager；
 * 2. **成功必须由磁盘事实确认**：Promise resolve、`application: 'applied'` 都不算，
 *    必须 `listBundles()` 里固定包真的到了目标版本，才进入 `awaiting-restart`；
 * 3. **不谎报**：`too-late` 不说成已取消，`overridden` 不说成成功，恢复阶段绝不自动重装。
 */
import { compare, gte, prerelease, valid } from 'semver'

import {
  installStageOf,
  installThroughManager,
  readDiskVersion,
} from './manager.ts'
import type {
  PluginInstallProgress,
  PluginInstallRequestId,
} from '@deepseek-ai/dsh-plugin-manager'
import type {
  InstallOutcome,
  PersistedPluginUpdate,
  PluginManagerPort,
  UpdateService,
  UpdateServicePorts,
} from './types.ts'
import type { UpdateInstallStage, UpdateInstallState } from '../../shared/update/types.ts'

/** 一次活动安装的进程内记录（requestId 绝不落盘、绝不进 Client 状态）。 */
interface ActiveInstall {
  readonly requestId: PluginInstallRequestId
  readonly fromVersion: string
  readonly targetVersion: string
  readonly startedAt: string
  /** 最近一次进度事件给出的阶段；`too-late` 时用它回到真实阶段。 */
  stage: UpdateInstallStage
}

export function createUpdateService(ports: UpdateServicePorts): UpdateService {
  /** 对外结论：唯一写入点是 `setState`。 */
  let state: UpdateInstallState = { status: 'idle' }
  /** 唯一的活动安装；它同时是"单飞"的锁。 */
  let active: ActiveInstall | null = null
  let inflight: Promise<UpdateInstallState> | null = null

  function setState(next: UpdateInstallState): UpdateInstallState {
    state = next
    return next
  }

  /** 安装状态转换（终态共用）：清掉活动任务，回到 idle 语义。 */
  function finish(next: UpdateInstallState): UpdateInstallState {
    active = null
    return setState(next)
  }

  async function writeRecord(record: PersistedPluginUpdate): Promise<boolean> {
    try {
      return await ports.store.write(record)
    } catch {
      // 注入的 store 抛错与返回 false 同义：这一步没成功，调用方据此决定要不要继续。
      return false
    }
  }

  async function clearRecord(): Promise<void> {
    try {
      await ports.store.clear()
    } catch {
      // 清除失败只是多留一条恢复记录，不影响本次结论；下次恢复会再处理一次。
      return
    }
  }

  /** 磁盘上固定包是否已经达到（或超过）目标版本。 */
  async function diskReached(targetVersion: string): Promise<boolean> {
    const disk = await readDiskVersion(ports.manager)
    return disk.kind === 'installed' && gte(disk.version, targetVersion)
  }

  /** 成功路径：把 `awaiting-restart` 写进持久化，并让状态停在这里等员工重启。 */
  async function enterAwaitingRestart(targetVersion: string): Promise<UpdateInstallState> {
    const installedAt = ports.now().toISOString()
    const record: PersistedPluginUpdate = {
      phase: 'awaiting-restart',
      // 活动任务里有真实来源；恢复路径用运行版本兜底（两者都必须是合法 SemVer）。
      fromVersion: active?.fromVersion ?? valid(ports.version) ?? ports.version,
      targetVersion,
      startedAt: active?.startedAt ?? installedAt,
      installedAt,
    }
    // 写失败不改结论：磁盘事实已经成立（真的装了），提示员工重启仍然是对的；
    // 只是重启后的一次性 `updated` 提示会少一次。
    await writeRecord(record)
    return finish({ status: 'awaiting-restart', targetVersion, installedAt })
  }

  /** 一次安装调用的落点：只有磁盘确认目标版本才进入等待重启。 */
  async function settle(outcome: InstallOutcome, targetVersion: string): Promise<UpdateInstallState> {
    if (outcome.kind === 'cancelled') {
      return finish({ status: 'cancelled', targetVersion })
    }
    if (outcome.kind === 'failed') {
      return finish({ status: 'failed', kind: outcome.reason, targetVersion })
    }
    if (outcome.kind === 'unknown') {
      return finish({ status: 'failed', kind: 'unknown', targetVersion })
    }
    if (await diskReached(targetVersion)) return await enterAwaitingRestart(targetVersion)
    // ChangeResult 说成功、磁盘却对不上：自相矛盾，不进入等待重启。
    return finish({ status: 'failed', kind: 'unknown', targetVersion })
  }

  /** 安装主流程（单飞内部）。任何异常都收敛成结构化失败，不让调用方拿到 rejection。 */
  async function runInstall(): Promise<UpdateInstallState> {
    try {
      if (ports.auditBusy()) {
        // 有审核任务在跑：允许检查、拒绝安装（设计 §6.2）。
        return setState({ status: 'failed', kind: 'audit-active' })
      }
      const candidate = await ports.checker.installableCandidate()
      if (candidate === undefined) {
        // 授权是安全出口：没有"当前仍可安装"的候选就不碰 Manager（不猜版本、不回退旧缓存）。
        return setState({ status: 'failed', kind: 'unknown' })
      }
      const current = valid(ports.version)
      const target = valid(candidate.targetVersion)
      if (current === null || target === null || prerelease(target) !== null || compare(target, current) <= 0) {
        // 安装前再确认一次目标仍严格高于当前运行版本（预发布、降级、版本串异常都拒绝）。
        return setState({ status: 'failed', kind: 'unknown' })
      }

      const requestId = ports.newRequestId()
      const startedAt = ports.now().toISOString()
      // 先落盘 `installing`：写不进去就不开始装 —— 否则进程中断后会留下一个无法解释的 profile。
      const persisted = await writeRecord({
        phase: 'installing',
        fromVersion: current,
        targetVersion: target,
        startedAt,
      })
      if (!persisted) return setState({ status: 'failed', kind: 'unknown' })

      active = { requestId, fromVersion: current, targetVersion: target, startedAt, stage: 'connecting' }
      setState({ status: 'installing', stage: 'connecting', targetVersion: target, startedAt })

      const outcome = await installThroughManager(ports.manager, target, requestId)
      return await settle(outcome, target)
    } catch {
      // 注入端口抛错（不该发生）也必须给调用方一个稳定结论，不能把 rejection 漏进 RPC。
      return finish({ status: 'failed', kind: 'unknown' })
    } finally {
      active = null
      inflight = null
    }
  }

  /** 取消主流程：只认当前活动 requestId，且不谎报结果。 */
  async function runCancel(): Promise<UpdateInstallState> {
    const current = active
    if (current === null) return state

    const cancelling: UpdateInstallState = {
      status: 'installing',
      stage: 'cancelling',
      targetVersion: current.targetVersion,
      startedAt: current.startedAt,
    }
    setState(cancelling)

    let status: Awaited<ReturnType<PluginManagerPort['cancelInstall']>>['status']
    try {
      status = (await ports.manager.cancelInstall(current.requestId)).status
    } catch {
      // 取消请求本身失败：不猜结果，回到安装自己的阶段，等真实 settlement。
      if (active !== null && active.requestId === current.requestId) setState({ ...cancelling, stage: current.stage })
      return state
    }

    if (status === 'cancelled') {
      // Manager 只在进程退出、文件恢复之后才回 cancelled：等安装 promise 落定，
      // 并确保最终结论就是 cancelled（哪怕它的 ChangeResult 自相矛盾）。
      const promise = inflight
      if (promise !== null) await promise
      if (state.status !== 'cancelled') {
        finish({ status: 'cancelled', targetVersion: current.targetVersion })
      }
      return state
    }

    // `too-late`：bundle 已经在应用，取消不成立 —— 不能谎报取消成功，也不能覆盖安装的真实结论。
    // `not-running`：没有这个请求在跑 —— 不猜成功、也不猜已取消。
    // 两种情况都只把"正在取消"退回安装自己的阶段；若安装已经落定，则保持它的最终状态。
    if (active !== null && active.requestId === current.requestId) {
      setState({ ...cancelling, stage: current.stage })
    }
    return state
  }

  /** 恢复主流程：只读持久化与磁盘事实，绝不自动安装。 */
  async function runRecover(): Promise<UpdateInstallState> {
    // 有安装在进行时不要用恢复流程覆盖它（Task 4 在激活时调用一次，正常不会撞上）。
    if (active !== null || inflight !== null) return state

    let record: PersistedPluginUpdate | undefined
    try {
      record = await ports.store.read()
    } catch {
      record = undefined
    }
    // malformed / 缺失 / 读失败：安全忽略，什么都不做（更不下发安装）。
    if (record === undefined) return state

    const current = valid(ports.version)
    const target = valid(record.targetVersion)
    if (current === null || target === null) return state

    // 运行版本已经到（或高于）目标：这条记录已经没有意义，清掉并给出一次性成功提示。
    if (gte(current, target)) {
      await clearRecord()
      return setState({ status: 'updated', version: current })
    }

    if (record.phase === 'installing') {
      if (await diskReached(record.targetVersion)) {
        // 安装其实已经落到磁盘，只是进程没走完：改写成"等待重启"，让员工完成最后一步。
        const installedAt = ports.now().toISOString()
        await writeRecord({ ...record, phase: 'awaiting-restart', installedAt })
        return setState({ status: 'awaiting-restart', targetVersion: record.targetVersion, installedAt })
      }
      // 中断：清掉无效的 installing 标记，报失败并允许之后重新检查/重试（绝不自动重装）。
      await clearRecord()
      return setState({ status: 'failed', kind: 'unknown' })
    }

    // `awaiting-restart`：Host 仍旧，但磁盘已经是目标版本 → 继续提示完全退出并重新打开桌面应用。
    if (await diskReached(record.targetVersion)) {
      return setState({
        status: 'awaiting-restart',
        targetVersion: record.targetVersion,
        installedAt: record.installedAt ?? ports.now().toISOString(),
      })
    }
    // 磁盘旧 / 缺失 / 读不出来：状态异常，不自动安装（保留记录，让异常可见）。
    return setState({ status: 'failed', kind: 'unknown' })
  }

  return {
    status() {
      return state
    },

    install() {
      // 单飞：重复点击复用同一任务（同一个 requestId、同一次落盘、同一次 Manager 调用）。
      if (inflight !== null) return inflight
      const promise = runInstall()
      inflight = promise
      return promise
    },

    cancel() {
      return runCancel()
    },

    recover() {
      return runRecover()
    },

    acceptProgress(progress: PluginInstallProgress) {
      const current = active
      // 只接受当前任务自己的进度：其它插件、旧请求的事件一律忽略。
      if (current === null || progress.requestId !== current.requestId) return
      current.stage = installStageOf(progress.phase)
      setState({
        status: 'installing',
        stage: current.stage,
        targetVersion: current.targetVersion,
        startedAt: current.startedAt,
      })
      // `progress.attempt`（含 registry 与位置）只用于路由，不进任何对外状态。
    },
  }
}
