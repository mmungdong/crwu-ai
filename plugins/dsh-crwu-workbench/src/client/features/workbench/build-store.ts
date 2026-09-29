import * as React from 'react'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'
import { WORKBENCH_PROTOCOL } from '../../../shared/consts.ts'
import { PERMISSION_SCHEMA_VERSION } from '../../../shared/access/types.ts'

/**
 * 「现在跑的是哪一份插件」的共享状态。
 *
 * 三个消费者，必须看到同一份结论：
 *
 * 1. 侧栏底部入口那枚小标签（`dev` / `v0.0.4`）—— 它常驻在侧栏里，是用户最先看到的那行字；
 * 2. 面板头部同一枚标签；
 * 3. 面板的**协议门禁**（宿主与客户端是不是同一代）。
 *
 * 为什么要 store 而不是各自 `boot()`：`boot` 不是免费的（它会恢复注册表、采用工作空间），
 * 侧栏入口与面板同时挂载时打两次是白花钱；而且两处各拉一次必然出现「标签是新的、门禁说旧的」
 * 这种自相矛盾的画面 —— 与 `envStatus` 是同一个理由。
 *
 * 生命周期：由 `apply()` 创建、随 props 下发，不是模块顶层单例（插件卸载后不许残留状态）。
 */

export interface BuildSnapshot {
  /** 宿主应答了 `ok:true`。 */
  ok: boolean
  /** 最近一次失败的原因（成功后被清空）。 */
  error: string
  /** 版本指纹 `pkg-0.0.5`；空串 = 还不知道。 */
  rev: string
  /** 包版本 `0.0.5`；空串 = 旧宿主没给这个字段。 */
  version: string
  /** `dev`（源码检出 / link 安装）/ `installed`（装好的包）；空串 = 旧宿主没给。 */
  buildKind: 'dev' | 'installed' | ''
  /** 这份宿主产物被加载那一刻的写入时间（ISO），空串 = 读不到。 */
  builtAt: string
  /** 宿主报回来的协议代数；null = 还没答（或答失败）。 */
  protocol: number | null
  /**
   * 宿主执行的**权限说明版本**（`boot.permissionSchemaVersion`，协议 18）。
   * `null` = 旧宿主没给这个字段 —— 按不一致处理（旧宿主的授权语义是布尔值，执行不了新范围）。
   */
  permissionSchemaVersion: number | null
  /** 宿主登记的「当前会话」（子会话的父级候选）；空串 = 还没登记。 */
  parentSessionId: string
}

export interface BuildStore {
  get(): BuildSnapshot
  subscribe(listener: () => void): () => void
  /** 拉一次 `boot`。并发调用共享同一次请求。 */
  refresh(): Promise<BuildSnapshot>
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const EMPTY: BuildSnapshot = {
  ok: false, error: '', rev: '', version: '', buildKind: '', builtAt: '', protocol: null,
  permissionSchemaVersion: null, parentSessionId: '',
}

export function createBuildStore(): BuildStore {
  let snapshot: BuildSnapshot = EMPTY
  const listeners = new Set<() => void>()
  let inflight: Promise<BuildSnapshot> | null = null

  const emit = (): void => {
    // 复制一份再遍历：监听器里可能会解除订阅（React 的重渲染就是这样）。
    for (const listener of [...listeners]) listener()
  }

  const patch = (next: Partial<BuildSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    emit()
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh() {
      if (inflight !== null) return inflight
      inflight = workbenchApi.boot()
        .then((result) => {
          // 失败**不清空**上一次的结论：标签保持上一次的真实取值比变成「未知」有用，
          // 而失败原因单独放在 `error` 里（面板照旧用它显示一行提示）。
          patch({
            ok: result.ok,
            error: result.ok ? '' : 'Host 未就绪',
            rev: typeof result.rev === 'string' ? result.rev : '',
            version: typeof result.version === 'string' ? result.version : '',
            buildKind: result.buildKind === 'dev' || result.buildKind === 'installed' ? result.buildKind : '',
            builtAt: typeof result.builtAt === 'string' ? result.builtAt : '',
            protocol: typeof result.protocol === 'number' ? result.protocol : null,
            permissionSchemaVersion: typeof result.permissionSchemaVersion === 'number'
              ? result.permissionSchemaVersion
              : null,
            parentSessionId: typeof result.parentSessionId === 'string' ? result.parentSessionId : '',
          })
          return snapshot
        })
        .catch((cause: unknown) => {
          patch({ ok: false, error: describe(cause) })
          return snapshot
        })
        .finally(() => { inflight = null })
      return inflight
    },
  }
}

/** 订阅 store 的 React hook（与 `useEnvStatus` 同一套写法，替身 React 也能跑）。 */
export function useBuild(store: BuildStore): BuildSnapshot {
  const [snapshot, setSnapshot] = React.useState<BuildSnapshot>(store.get())
  React.useEffect(() => {
    setSnapshot(store.get())
    return store.subscribe(() => { setSnapshot(store.get()) })
  }, [store])
  return snapshot
}

/** 宿主与客户端是不是同一代（不同代时**必须**拦住发起审核，见 AGENTS.md §7.12）。 */
export function hostIsStale(snapshot: BuildSnapshot): boolean {
  return snapshot.protocol !== null && snapshot.protocol !== WORKBENCH_PROTOCOL
}

/**
 * 宿主执行的权限说明版本与客户端是否一致（协议 18）。
 *
 * 与 `hostIsStale` 分开判是刻意的：协议号回答「是不是同一代」，这一条回答
 * 「我这份界面上写的授权范围，和宿主实际执行的判据是不是同一版」。
 * 版本不同（含旧宿主根本没给这个字段）时，**任何本机凭据操作都必须停住** ——
 * 让一个执行旧范围的宿主看起来授权成功，比拦住更危险。
 */
export function hostPermissionSchemaStale(snapshot: BuildSnapshot): boolean {
  return snapshot.permissionSchemaVersion !== PERMISSION_SCHEMA_VERSION
}

/**
 * 当前运行的版本号（**不带 `v` 前缀**）：`0.0.11` / dev 形态回空串。
 *
 * 侧栏徽标与更新面板都要把它交给更新 View Model（`v{currentVersion}`），
 * 口径必须只有一处 —— 以前两边各自 `build.version || rev` 拼过，dev 形态会拼出 `vdev`。
 */
export function currentVersionOf(snapshot: BuildSnapshot): string {
  if (snapshot.version !== '') return snapshot.version
  return snapshot.rev === '' ? '' : snapshot.rev.replace(/^pkg-/, '')
}

export interface BuildTag {
  /** 标签文字：`dev` / `v0.0.4` / `未知`。 */
  text: string
  /** 语义：dev 用琥珀色提醒「这不是装好的包」，包版本用中性灰。 */
  tone: 'dev' | 'installed' | 'unknown'
  /** 悬停解释：形态 + 版本 + 构建时间。 */
  title: string
}

/**
 * 小标签的取值（纯函数，可单测）。
 *
 * 用户口径（2026-09-22）：**这里要写清是 dev 模式，还是他直接安装的具体版本**。
 * 所以 dev 只显示 `dev`（版本号对开发没意义），装好的包显示 `v<版本>`；
 * 旧宿主两个字段都没有时退回 `rev` 去掉 `pkg-` 前缀，再没有就显示「未知」——
 * 三种情形都不许留空标签（空白标签比没有标签更让人困惑）。
 */
export function buildTagOf(snapshot: BuildSnapshot): BuildTag {
  const stamp = snapshot.builtAt === '' ? '' : `\n${zhCN.buildTagBuiltAt}${snapshot.builtAt}`
  if (snapshot.buildKind === 'dev') {
    const version = snapshot.version === '' ? zhCN.buildTagVersionUnknown : `v${snapshot.version}`
    return {
      text: zhCN.buildTagDev,
      tone: 'dev',
      title: `${zhCN.buildTagDevTitle.replace('{version}', version)}${stamp}`,
    }
  }
  const version = snapshot.version !== ''
    ? `v${snapshot.version}`
    : (snapshot.rev === '' ? '' : snapshot.rev.replace(/^pkg-/, 'v'))
  if (version === '') {
    return { text: zhCN.buildTagUnknown, tone: 'unknown', title: `${zhCN.buildTagUnknownTitle}${stamp}` }
  }
  return {
    text: version,
    tone: 'installed',
    title: `${zhCN.buildTagInstalledTitle.replace('{version}', version)}${stamp}`,
  }
}
