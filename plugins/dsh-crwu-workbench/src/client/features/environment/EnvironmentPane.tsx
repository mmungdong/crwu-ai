import * as React from 'react'
import { Badge, Button, Chip, LoadingBar, Meter, Notice, Spinner, StatusDot } from '../../components/primitives.tsx'
import { CheckIcon, DeveloperDiagnosticsIcon, WarnIcon } from '../../components/icons.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { headlineOf, workbenchApi, type EnvResult } from '../report-audit/api.ts'
import type { SetupItemView } from '../../../shared/environment/model.ts'
import { WorkspaceCard } from '../workbench/WorkspaceCard.tsx'
import type { ClientServices } from '../workbench/services.ts'
import { IfindAuthCard } from './IfindAuthCard.tsx'
import { OssCredCard } from './OssCredCard.tsx'
import type { BuildSnapshot } from '../workbench/build-store.ts'
import { DEVELOPER_CONTACT_URL } from '../../../shared/consts.ts'
import {
  allStepsDone, lastVerifiedAt, pickStep, setupStepInput, setupSteps, type SetupStepKind,
} from './steps.ts'

/**
 * 环境信息页（2026-09-26 重排为「紧凑状态摘要 + 引导式配置工作区」）。
 *
 * ## 页面结构
 *
 * ```
 * ┌ 环境状态摘要 ────────────────────────────────┐
 * │ 环境已就绪 / 还需完成 N 项        [重新检查]  │
 * │ 已完成 N/N · 最近真实验证时间                  │
 * └──────────────────────────────────────────────┘
 * ┌ 配置工作区 ──────────────────────────────────┐
 * │ 左侧步骤导航        │ 右侧当前步骤            │
 * │ 1 账号连接 已完成    │ 标题 + 一句用途          │
 * │ 2 阿里云 OSS 待处理  │ 表单 / 登录按钮          │
 * │ 3 iFinD 待处理       │ 验证过程与人话结果       │
 * │ 4 工作空间 已完成    │ 获取方式 / 安全说明      │
 * └──────────────────────────────────────────────┘
 * [开发者诊断 ▾]
 * ```
 *
 * ## 四条不许退回去的口径
 *
 * 1. **顶部不再有「进入报告审核」按钮**（用户口径：只做提示，跳转走左侧栏的统一导航门禁）；
 * 2. **顶部不再罗列全部阻塞项**（左侧步骤已经承担状态导航），只给**第一条**明确下一步；
 *    `平台` 这类技术指标移入开发者诊断，「最近检查」压成一行辅助文案；
 * 3. **默认停在第一项未完成的步骤**；用户手动选过之后，后台刷新**不许**抢焦点；
 * 4. **密钥类输入只提交、不回显**（OSS AK / iFinD API-Key）：提交后立刻清空，已保存只给掩码。
 *
 * 结论、通过率、"下一步"、门禁判据全部来自 Host 的**统一环境模型**（`env.state`），
 * 这一页不再自己算任何结论。
 */

export interface EnvironmentPaneProps {
  env: EnvResult | null
  /** 当前实际运行的插件构建；开发者诊断与页面头共用同一份版本事实。 */
  build?: BuildSnapshot
  error: string
  busy: boolean
  /** 最近一次成功自检的时刻（ISO 串）；空串表示还不知道。 */
  checkedAt?: string
  /** 重新检查环境（会刷新宿主侧缓存，并强制重跑真实外部验证）。 */
  onRefresh: () => void
  onRelogin: () => void
  onDwsLogin: () => void
  /** 设备码登录：浏览器打不开 / 远程无头时的退路（`dws auth login --device`）。 */
  onDwsLoginDevice?: () => void
  /** 最近一次登录的结果（成功、失败原因、CLI 打印的 URL 或设备码）；空串 = 还没点过。 */
  loginMessage?: string
  /** 被门禁拦住时的界面状态：`running` 正在检查、`blocked` 检查没过。 */
  gate?: 'idle' | 'running' | 'blocked'
  /** 被拦时本来要去的那一页名（「进入【报告审核】前…」）。 */
  gateTarget?: string
  /**
   * 统一导航层给出的**完整拦截理由**（`module-store` 的 `gateReason`）。
   *
   * 优先用它：iFinD 未通过时门禁会把话说具体（「进入【报告审核】前，请先完成 iFinD API-Key 验证」），
   * 页面自己拼一句通用文案会把这层信息丢掉。
   */
  gateReason?: string
  /** 浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  wsBusy: boolean
  wsMessage: string
  onWsBusy: (busy: boolean) => void
  onWsMessage: (message: string) => void
  /** 授权（一次性、长期有效）。 */
  authorized?: boolean
  authBusy?: boolean
  authError?: string
  authDeclined?: boolean
  onGrantCredentials?: () => void
  onRegrant?: () => void
}

/**
 * 会话 id 的短显示。
 *
 * 审核根会话的 id 是 `session-<uuid>` 形状，直接 `slice(0, 8)` 得到的是 `session-` ——
 * 界面上就是一串没有信息量的「· session-…」。所以先剥掉 `session-` 前缀再取 8 位，
 * 用户才能拿它去侧栏核对。
 */
function shortSessionId(id: string): string {
  const tail = id.startsWith('session-') ? id.slice('session-'.length) : id
  return (tail === '' ? id : tail).slice(0, 8)
}

/** 本地时刻；解析不出来就原样显示（不猜）。 */
function localTime(iso: string): string {
  if (iso === '') return ''
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString()
}

/** 单行「标签 : 值」，值过长时换行而不是截断（路径与版本要能看全）。 */
function Kv(props: { label: string; children?: React.ReactNode }): React.ReactElement {
  return <>
    <div className={C.kvKey}>{props.label}</div>
    <div className={C.kvValue}>{props.children}</div>
  </>
}

interface DiagnosticRow {
  label: string
  value: string
  details?: string[]
}

/** iFinD 的凭据认证与真实取数是两层事实，不能只凭 `state` 报“已连接”。 */
function ifindConnectionText(env: EnvResult): string {
  if (env.external.state === 'authenticated') {
    return env.external.dataVerified ? zhCN.envDiagIfindConnected : zhCN.envDiagIfindNoData
  }
  if (env.external.state === 'unconfigured') return zhCN.envIfindStateUnconfigured
  if (env.external.state === 'invalid') return zhCN.envIfindStateInvalid
  if (env.external.state === 'unreachable') return zhCN.envIfindStateUnreachable
  return zhCN.envIfindStateUnverified
}

function buildVersionText(build: BuildSnapshot): string {
  if (build.version !== '') return `v${build.version}`
  if (build.rev.startsWith('pkg-')) return `v${build.rev.slice('pkg-'.length)}`
  return build.rev === '' ? zhCN.versionUnknown : build.rev
}

/**
 * 开发者诊断的单一事实源：页面与复制文本都从这些行生成，避免二者遗漏不同字段。
 * 这里只接收 Host 已脱敏的视图，绝不放入 API-Key / AccessKey 明文。
 */
function diagnosticRows(env: EnvResult, checkedAt: string, build: BuildSnapshot): DiagnosticRow[] {
  const health = env.state?.systemHealth
  const integrity = env.packageIntegrity
  const runtime = env.runtime
  const root = env.auditRoot
  const session = env.sessionWorkspace
  const buildDetails = [
    build.buildKind === '' ? '' : `${zhCN.envDiagBuildKind}：${build.buildKind}`,
    build.rev === '' ? '' : `${zhCN.envDiagBuildRev}：${build.rev}`,
    build.protocol === null ? '' : `${zhCN.envDiagProtocol}：${String(build.protocol)}`,
    build.builtAt === '' ? '' : `${zhCN.envDiagBuildTime}：${localTime(build.builtAt)}`,
  ].filter((item) => item !== '')
  const ifindDetails = [
    `${zhCN.envDiagIfindCredential}：${env.external.path === '' ? zhCN.envNotConfigured : env.external.path}`,
    env.external.reason === '' ? '' : env.external.reason,
    env.external.dataTool === '' ? '' : `${zhCN.envDiagIfindTool}${env.external.dataTool}`,
    env.external.dataSample === '' ? '' : `${zhCN.envDiagIfindSample}${env.external.dataSample}`,
    env.external.checkedAt === '' ? '' : `${zhCN.envIfindDataAt}${localTime(env.external.checkedAt)}`,
  ].filter((item) => item !== '')
  const auditRoot = root === undefined || root.sessionId === ''
    ? zhCN.envAuditRootNone
    : [
        root.title || root.sessionId,
        `${shortSessionId(root.sessionId)}…`,
        root.workspacePath,
        root.usable ? '' : `${zhCN.envAuditRootStale}${root.reason === '' ? '' : `（${root.reason}）`}`,
      ].filter((item) => item !== '').join(' · ')

  return [
    { label: zhCN.envDiagWorkbenchVersion, value: buildVersionText(build), details: buildDetails },
    {
      label: zhCN.envDiagPackages,
      value: `${String(integrity.tools.filter((tool) => tool.ok).length)}/${String(integrity.tools.length)} · ${integrity.ok ? zhCN.envDiagOk : zhCN.envDiagBad}`,
      details: health === undefined || health.packageIntegrity.reason === '' ? [] : [health.packageIntegrity.reason],
    },
    {
      label: zhCN.envDiagRuntime,
      value: `${runtime.path === '' ? zhCN.envUnset : runtime.path} · ${runtime.versionText} · ${runtime.source}`,
      details: runtime.missingPackages.length === 0 ? [] : [`${zhCN.envRuntimeMissingPackages}${runtime.missingPackages.join('、')}`],
    },
    { label: zhCN.envDiagPlatform, value: env.platform === '' ? zhCN.envNotResolved : env.platform },
    {
      label: zhCN.envDiagTools,
      value: health === undefined ? zhCN.envDiagToolsUnknown
        : (health.toolRegistry.state === 'ok' ? zhCN.envDiagToolsOk : itemStateText(health.toolRegistry)),
      details: health === undefined || health.toolRegistry.reason === '' ? [] : [health.toolRegistry.reason],
    },
    { label: zhCN.envDiagIfindConnection, value: ifindConnectionText(env), details: ifindDetails },
    {
      label: zhCN.envDiagOssTarget,
      value: `${env.delivery.probe.target === undefined || env.delivery.probe.target === '' ? zhCN.envNotConfigured : env.delivery.probe.target} · ${env.delivery.probe.ok ? zhCN.envPass : zhCN.envFail}`,
      details: env.delivery.probe.detail === '' ? [] : [env.delivery.probe.detail],
    },
    { label: zhCN.envPackagesRoot, value: integrity.packageRoot === '' ? zhCN.envNotResolved : integrity.packageRoot },
    {
      label: zhCN.envPackagesManifest,
      value: `${integrity.manifestPath === '' ? zhCN.envNotResolved : integrity.manifestPath} · ${integrity.manifestFound ? zhCN.envPass : zhCN.envFail}`,
    },
    { label: zhCN.envHome, value: env.home },
    { label: zhCN.envConfigSource, value: env.configSource === '' ? zhCN.envNotConfigured : env.configSource },
    { label: zhCN.envCheckedAt, value: checkedAt === '' ? zhCN.envUnset : localTime(checkedAt) },
    { label: zhCN.envCaseRoot, value: env.workspace.path === '' ? zhCN.envUnset : env.workspace.path },
    { label: zhCN.envOssBucket, value: env.delivery.oss.bucket || zhCN.envNotConfigured },
    { label: zhCN.envOssPrefix, value: env.delivery.oss.prefix },
    { label: zhCN.envOssCredFile, value: env.delivery.ossCred.exists ? env.delivery.ossCred.path : zhCN.envOssCredMissing },
    { label: zhCN.envAuditRoot, value: auditRoot },
    { label: zhCN.envParentSession, value: session.parentSessionId === '' ? zhCN.envUnset : session.parentSessionId },
    ...integrity.tools.map((tool): DiagnosticRow => ({
      label: tool.name,
      value: tool.present ? tool.file : zhCN.envNotInstalled,
      details: [
        tool.present ? `${zhCN.envPackagesSize} ${String(tool.sizeBytes)} / ${zhCN.envPackagesManifestSize} ${String(tool.manifestSizeBytes)}` : '',
        tool.sha256 === '' ? '' : `${zhCN.envPackagesSha} ${tool.sha256}`,
        tool.reason === '' ? '' : `${zhCN.envReason}：${tool.reason}`,
      ].filter((item) => item !== ''),
    })),
    { label: zhCN.envRuntimeExpect, value: runtime.expect },
    { label: zhCN.envRuntimeRequiredPackages, value: runtime.requiredPackages.join(' / ') },
    {
      label: zhCN.envRuntimeDistributions,
      value: Object.entries(runtime.distributions).map(([name, version]) => `${name} ${version}`).join(' · ') || zhCN.envUnset,
    },
    {
      label: zhCN.envProbe,
      value: env.delivery.probe.state === '' ? (env.delivery.probe.ok ? zhCN.envPass : zhCN.envFail) : env.delivery.probe.state,
    },
  ]
}

function diagnosticText(rows: DiagnosticRow[]): string {
  return rows.map((row) => [
    `${row.label}: ${row.value}`,
    ...(row.details ?? []).map((detail) => `  ${detail}`),
  ].join('\n')).join('\n')
}

/** 配置项状态 → 色调。`unverified` 是琥珀（"还没证据"），不是红色。 */
function toneOfItem(item: SetupItemView): 'ok' | 'busy' | 'bad' {
  if (item.state === 'ok' || item.state === 'authenticated') return 'ok'
  if (item.state === 'unverified') return 'busy'
  return 'bad'
}

function itemStateText(item: SetupItemView): string {
  if (item.state === 'ok' || item.state === 'authenticated') return zhCN.envItemOk
  if (item.state === 'unverified') return zhCN.envIfindStateUnverified
  if (item.state === 'invalid') return zhCN.envItemMissing
  if (item.state === 'unreachable') return zhCN.envIfindStateUnreachable
  return zhCN.envItemMissing
}

/** 一行配置项：状态点 + 名称 + 状态 + （未就绪时）原因。 */
function SetupRow(props: { id: string; item: SetupItemView; extra?: React.ReactNode }): React.ReactElement {
  const item = props.item
  const tone = toneOfItem(item)
  const notReady = tone !== 'ok'
  return <div className={C.item} data-crwu-env-item={props.id}>
    <StatusDot tone={tone} />
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{props.id}</span>
        <Chip text={itemStateText(item)} tone={tone} />
      </div>
      {item.value === '' ? null : <div className={`${C.itemMeta} ${C.mono}`}>{item.value}</div>}
      {notReady && item.reason !== '' ? <div className={C.itemFix}>{item.reason}</div> : null}
      {props.extra}
    </div>
  </div>
}

/**
 * 顶部状态摘要：一句结论 + 完成数量 + 最近真实验证时间 + **唯一**主动作「重新检查」。
 *
 * 刻意**不罗列全部阻塞项**：左侧步骤导航已经回答了"哪里不对"，罗列一遍只会让顶部变成第二张清单。
 * 被统一导航拦住时，「进入【X】前…」作为摘要内部的一条轻提示出现，而不是另一张大卡。
 */
function StatusSummary(props: {
  env: EnvResult
  checkedAt: string
  busy: boolean
  onRefresh: () => void
  gate: 'idle' | 'running' | 'blocked'
  gateTarget?: string | undefined
  gateReason?: string | undefined
}): React.ReactElement {
  const head = headlineOf(props.env)
  const ok = head.status === 'ready' && head.proceed
  // OSS 的探测结果里没有独立时间戳，但 `probeOss` **每次自检都真跑**（没有缓存），
  // 所以"这次自检的时刻"（store 在应答落地时记的 `checkedAt`）就是它的真实验证时刻。
  const verifiedAt = lastVerifiedAt(props.env, props.checkedAt ?? '')
  // 同一必检项可能同时产生 global / external-data 两条诊断 issue（例如 iFinD）。
  // 顶部数量必须跟 N/N 的必检项口径一致，不能把诊断作用域当成待配置项重复计数。
  const remaining = Math.max(0, head.total - head.passed)
  const title = ok
    ? zhCN.envStatusReady
    : (head.status === 'admin-required'
      ? `${zhCN.envStatusAdmin}${String(remaining)}${zhCN.envStatusActionTail}`
      : (head.status === 'system-blocked'
        ? zhCN.envStatusSystem
        : (head.status === 'check-failed'
          ? zhCN.envStatusFailed
          : (head.status === 'unknown' || head.status === 'checking'
            ? zhCN.envStatusChecking
            : `${zhCN.envStatusAction}${String(remaining)}${zhCN.envStatusActionTail}`))))
  return <div className={`${C.status} ${ok ? C.statusOk : C.statusBad}`} data-crwu-env-status={head.status}>
    <span className={`${C.statusMark} ${ok ? C.statusMarkOk : C.statusMarkBad}`}>
      {ok ? <CheckIcon size={18} /> : <WarnIcon size={18} />}
    </span>
    <div className={C.statusMain}>
      <div className={C.statusTitle}>{title}</div>
      {/* 只给**第一条**明确下一步：员工不需要在这里读完所有问题。 */}
      {ok
        ? <div className={C.statusSub}>{zhCN.envStatusProceedHint}</div>
        : (head.primary === null
          ? null
          : <div className={C.statusSub}>{`${head.primary.action}：${head.primary.message}`}</div>)}
      {/* 被统一导航拦住时的一句轻提示（不再是一张独立的大卡）。 */}
      {props.gate === 'blocked' && props.gateTarget !== undefined
        ? <div className={C.statusNote} data-crwu-env-gate="blocked">
            {/* 优先用统一导航层算好的那一句（iFinD 未通过时它指名 API-Key）。 */}
            {props.gateReason !== undefined && props.gateReason !== ''
              ? props.gateReason
              : `进入【${props.gateTarget}】前，请先完成环境配置`}
          </div>
        : null}
      {props.gate === 'running'
        ? <div className={C.statusNote} data-crwu-env-gate="running">
            <Spinner />
            <span>{zhCN.envGateRunningTitle}</span>
          </div>
        : null}
      <div className={C.statusMeta}>
        <span>{`${zhCN.envStatusSummary}${String(head.passed)}/${String(head.total)}${zhCN.envStatusSummaryTail}`}</span>
        <span className={C.statusDot} />
        <span>{`${zhCN.envStatusCheckedAt} ${props.checkedAt === '' ? zhCN.envUnset : localTime(props.checkedAt)}`}</span>
        {verifiedAt === '' ? null : <>
          <span className={C.statusDot} />
          <span data-crwu-env-verified-at={verifiedAt}>{`${zhCN.envStatusVerifiedAt} ${localTime(verifiedAt)}`}</span>
        </>}
      </div>
      {/* 完成数量与进度合并成一条紧凑摘要（不再有三块技术指标卡）。 */}
      <Meter ratio={head.ratio} bad={!ok} />
    </div>
    <div className={C.statusAction}>
      <Button
        label={props.busy ? zhCN.envStatusChecking : zhCN.envActionRecheck}
        tone="primary"
        disabled={props.busy}
        onClick={props.onRefresh}
      />
    </div>
  </div>
}

/** 左侧步骤导航：序号 + 名称 + 状态标签（当前项是选中态）。 */
function StepNav(props: {
  steps: ReturnType<typeof setupSteps>
  active: SetupStepKind
  onPick: (id: SetupStepKind) => void
}): React.ReactElement {
  return <nav className={C.stepsNav} aria-label={zhCN.envStepsNavLabel} data-crwu-env-stepnav="1">
    <ol className={C.stepsList}>
      {props.steps.map((step) => {
        const on = step.id === props.active
        return <li key={step.id}>
          <button
            type="button"
            className={`${C.stepItem} ${on ? C.stepItemOn : ''}`}
            aria-current={on ? 'step' : undefined}
            data-crwu-env-step={step.id}
            data-state={step.state}
            onClick={() => { props.onPick(step.id) }}
          >
            <span className={`${C.stepIndex} ${step.state === 'done' ? C.stepIndexDone : ''}`}>
              {step.state === 'done' ? <CheckIcon size={13} /> : String(step.index)}
            </span>
            <span className={C.stepText}>
              <span className={C.stepTitle}>{step.title}</span>
              <span className={C.stepState}>{step.stateText}</span>
            </span>
          </button>
        </li>
      })}
    </ol>
  </nav>
}

/** 当前步骤的壳：标题 + 用途说明 + （可选）当前状态标签。 */
function StepPanel(props: {
  step: ReturnType<typeof setupSteps>[number] | undefined
  state?: SetupItemView
  children: React.ReactNode
}): React.ReactElement {
  const step = props.step
  return <section className={C.stepPanel} data-crwu-env-step-panel={step?.id ?? ''}>
    <header className={C.stepPanelHead}>
      <div className={C.stepPanelTitle}>
        {`${zhCN.envStepOf}${String(step?.index ?? 1)}${zhCN.envStepOfTail} · ${step?.title ?? ''}`}
      </div>
      {props.state === undefined
        ? null
        : <Chip text={itemStateText(props.state)} tone={toneOfItem(props.state)} />}
    </header>
    {props.children}
  </section>
}

/** 账号连接步骤：一次性授权 + 氚云 + 钉钉。 */
function AccountsStep(props: EnvironmentPaneProps & { env: EnvResult; authorized: boolean }): React.ReactElement {
  const authorized = props.authorized
  return <>
    <p className={C.stepLead}>{zhCN.envStepHintAccounts}</p>
    {/* 一次性本机凭据授权**就放在配置流程里**（旧版是一层遮住整页的模态框）。 */}
    <div className={C.item} data-crwu-env-item="consent">
      <StatusDot tone={authorized ? 'ok' : 'bad'} />
      <div className={C.itemMain}>
        <div className={C.itemHead}>
          <span className={C.itemName}>{zhCN.envConsentTitle}</span>
          <Chip text={authorized ? zhCN.envItemOk : zhCN.envItemMissing} tone={authorized ? 'ok' : 'bad'} />
        </div>
        <div className={C.itemNote}>{zhCN.envConsentWhy}</div>
        {props.authError === undefined || props.authError === '' ? null
          : <Notice tone="warn">{props.authError}</Notice>}
        {!authorized && props.authDeclined === true ? <Notice tone="warn">{zhCN.envConsentDeclined}</Notice> : null}
        <div className={C.row}>
          {authorized
            ? <span className={C.authGranted}>{zhCN.envConsentDone}</span>
            : (props.authDeclined === true
              ? <Button label={zhCN.envConsentRegrant} small disabled={props.authBusy === true}
                  onClick={() => { props.onRegrant?.() }} />
              : <Button label={zhCN.envConsentAgree} tone="primary" disabled={props.authBusy === true}
                  onClick={() => { props.onGrantCredentials?.() }} />)}
        </div>
      </div>
    </div>
    <SetupRow
      id={props.env.services.find((service) => service.id === 'h3yun')?.label ?? '氚云（H3Yun）员工会话'}
      item={props.env.state?.userSetup.h3yun ?? { state: 'unknown', value: '', reason: '', required: true }}
      extra={<div className={C.layerActions}>
        <Button label={zhCN.envLoginH3yun} small onClick={props.onRelogin} />
      </div>}
    />
    <SetupRow
      id={props.env.services.find((service) => service.id === 'dingtalk')?.label ?? '钉钉认证'}
      item={props.env.state?.userSetup.dingtalk ?? { state: 'unknown', value: '', reason: '', required: true }}
      extra={<div className={C.layerActions}>
        <Button label={zhCN.dwsLogin} small onClick={props.onDwsLogin} />
        {/* 默认那条会开浏览器等回调；浏览器起不来时设备码是唯一走得通的路。 */}
        {props.onDwsLoginDevice === undefined
          ? null
          : <Button label={zhCN.dwsLoginDevice} small onClick={props.onDwsLoginDevice} />}
      </div>}
    />
    {props.loginMessage === undefined || props.loginMessage === ''
      ? null
      : <div className={C.itemFix} style={{ whiteSpace: 'pre-wrap' }}>{props.loginMessage}</div>}
  </>
}

/**
 * 开发者诊断：包内组件 / DSH Runtime / 平台 / Tool 可见性 + 技术细节。
 *
 * 普通用户默认看不到：包路径、sha256、协议版本、运行时路径、凭据路径、验证工具名与数据样本
 * **只在这里**出现。
 */
function DeveloperDiagnostics(props: {
  env: EnvResult
  build?: BuildSnapshot
  checkedAt: string
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  const rows = diagnosticRows(props.env, props.checkedAt, props.build ?? {
    ok: false, error: '', rev: '', version: '', buildKind: '', builtAt: '', protocol: null, parentSessionId: '',
  })
  const [copied, setCopied] = React.useState(false)
  const [copyError, setCopyError] = React.useState('')

  const copy = (): void => {
    void (async () => {
      setCopyError('')
      const text = diagnosticText(rows)
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            return
          } catch {
            // 浏览器可能因为权限策略拒绝；继续走 Host 的系统剪贴板退路。
          }
        }
        const result = await workbenchApi.clipboard({ text })
        if (!result.ok) throw new Error(result.error)
        setCopied(true)
      } catch {
        setCopyError(zhCN.envDiagCopyFailed)
      }
    })()
  }

  return <div className={C.details} data-crwu-env-diag="1">
    <button type="button" className={C.detailsHead} aria-expanded={props.open} onClick={props.onToggle}>
      <span className={C.detailsTitle}>
        <DeveloperDiagnosticsIcon size={17} />
        <span>{zhCN.envGroupMaintenance}</span>
      </span>
      <span className={C.detailsToggle}>{props.open ? zhCN.envLayerCollapse : zhCN.envLayerExpand}</span>
    </button>
    <a
      className={`${C.link} ${C.detailsContact}`}
      href={DEVELOPER_CONTACT_URL}
      target="_blank"
      rel="noreferrer noopener"
    >{zhCN.envDeveloperContact}</a>
    {props.open
      ? <section className={C.detailsBody} data-crwu-developer-panel="1">
          <header className={C.detailsPanelHead}>
            <div className={C.detailsPanelTitle}>{zhCN.envDiagPanelTitle}</div>
            <Button label={copied ? zhCN.envDiagCopied : zhCN.envDiagCopy} small onClick={copy} />
          </header>
          {copyError === '' ? null : <div className={C.detailsCopyError}>{copyError}</div>}
          <div className={C.kv}>
            {rows.map((row, index) => <Kv key={`${row.label}-${String(index)}`} label={row.label}>
              <span className={C.mono}>{row.value}</span>
              {(row.details ?? []).map((detail, detailIndex) => <div
                key={`${String(index)}-${String(detailIndex)}`}
                className={C.muted}
              >{detail}</div>)}
            </Kv>)}
          </div>
        </section>
      : null}
  </div>
}

export function EnvironmentPane(props: EnvironmentPaneProps): React.ReactElement {
  const { env } = props
  const [developerDiagnosticsOpen, setDeveloperDiagnosticsOpen] = React.useState(false)
  /**
   * 用户手动选过的步骤。
   *
   * `null` = 还没选过 → 默认停在第一项未完成；一旦非空就**无条件**用他的选择，
   * 后台刷新（环境结论变了、重新检查回来）都不许把他切回第一项。
   */
  const [manualStep, setManualStep] = React.useState<SetupStepKind | null>(null)

  if (env === null) {
    // 首次加载时 busy 可能还没翻成 true（状态更新是异步的），所以「没有数据 + 没有错误」
    // 一律显示「正在检查」，避免先闪一个空面板再出现内容。
    if (props.error !== '') {
      return <div>
        <Notice tone="warn">{props.error}</Notice>
        <div className={C.row}>
          <Button label={zhCN.envActionRecheck} onClick={props.onRefresh} />
        </div>
      </div>
    }
    return <div className={C.loading}>
      <Spinner large />
      <span>{zhCN.loadingEnv}</span>
    </div>
  }

  const gate = props.gate ?? 'idle'
  const setup = env.state?.userSetup
  const authorized = props.authorized ?? env.trust.credentials
  const activeStep = pickStep(setupSteps(setupStepInput(env, authorized), manualStep), manualStep)

  return <div>
    {props.error === '' ? null : <Notice tone="warn">{props.error}</Notice>}
    <LoadingBar active={props.busy} />

    <div className={props.busy ? C.dim : ''}>
      <StatusSummary
        env={env}
        checkedAt={props.checkedAt ?? ''}
        busy={props.busy}
        onRefresh={props.onRefresh}
        gate={gate}
        gateTarget={props.gateTarget}
        gateReason={props.gateReason}
      />

      {setup === undefined
        // 旧宿主没有统一模型：步骤导航与状态都无从谈起 —— 明说，让人重启 profile。
        ? <Notice tone="warn">{zhCN.hostStaleHint}</Notice>
        : <SetupWorkspace
            {...props}
            env={env}
            authorized={authorized}
            activeStep={activeStep}
            onPick={setManualStep}
          />}

      <DeveloperDiagnostics
        env={env}
        build={props.build}
        checkedAt={props.checkedAt ?? ''}
        open={developerDiagnosticsOpen}
        onToggle={() => { setDeveloperDiagnosticsOpen(!developerDiagnosticsOpen) }}
      />
    </div>
  </div>
}

/** 配置工作区：左侧步骤导航 + 右侧当前步骤。 */
function SetupWorkspace(props: EnvironmentPaneProps & {
  env: EnvResult
  authorized: boolean
  activeStep: SetupStepKind
  onPick: (id: SetupStepKind) => void
}): React.ReactElement {
  const { env } = props
  const setup = env.state?.userSetup
  const input = setupStepInput(env, props.authorized)
  const active = props.activeStep
  const steps = setupSteps(input, active)
  const activeView = steps.find((step) => step.id === active)
  const done = allStepsDone(steps)
  return <div className={C.workspace} data-crwu-env-workspace="1">
    <StepNav steps={steps} active={active} onPick={props.onPick} />
    <StepPanel step={activeView} state={active === 'accounts' ? undefined : setupItemOf(input, active)}>
      {done
        ? <p className={C.stepLead} data-crwu-env-alldone="1">{zhCN.envStepDoneSummary}</p>
        : null}
      {active === 'accounts'
        ? <AccountsStep {...props} env={env} authorized={props.authorized} />
        : null}
      {active === 'oss'
        ? <OssCredCard delivery={env.delivery} onSaved={props.onRefresh} />
        : null}
      {active === 'ifind'
        ? <IfindAuthCard credential={env.external} onSaved={props.onRefresh} />
        : null}
      {active === 'workspace'
        ? <WorkspaceCard
            workspace={env.workspace}
            services={props.services}
            busy={props.wsBusy}
            message={props.wsMessage}
            onBusy={props.onWsBusy}
            onMessage={props.onWsMessage}
            onRefresh={props.onRefresh}
            collapsed={done}
          />
        : null}
      {setup === undefined ? null : null}
    </StepPanel>
  </div>
}

function setupItemOf(input: ReturnType<typeof setupStepInput>, id: SetupStepKind): SetupItemView {
  if (id === 'oss') return input.oss
  if (id === 'ifind') return input.ifind
  if (id === 'workspace') return input.workspace
  return input.h3yun
}

/** 只给测试与诊断用：把「账号连接」里每一项的状态词取出来（不涉及渲染细节）。 */
export function accountStates(env: EnvResult): Record<string, string> {
  const setup = env.state?.userSetup
  if (setup === undefined) return {}
  return {
    credentialsConsent: setup.credentialsConsent.state,
    h3yun: setup.h3yun.state,
    dingtalk: setup.dingtalk.state,
  }
}

/** 只给诊断用：把「交付与外部数据」里每一项的状态词取出来。 */
export function deliveryStates(env: EnvResult): Record<string, string> {
  const setup = env.state?.userSetup
  if (setup === undefined) return {}
  return { aliyunOss: setup.aliyunOss.state, ifind: setup.ifind.state }
}
