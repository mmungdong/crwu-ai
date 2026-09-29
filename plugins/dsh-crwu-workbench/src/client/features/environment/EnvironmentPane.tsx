import * as React from 'react'
import { Badge, Button, Chip, LoadingBar, Meter, Notice, Spinner, StatusDot } from '../../components/primitives.tsx'
import { CheckIcon, DeveloperDiagnosticsIcon, WarnIcon } from '../../components/icons.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { headlineOf, workbenchApi, type EnvResult } from '../report-audit/api.ts'
import type { AccessDiagnosticView, DwsLocalDoctorView, DwsLocalRepairView } from '../../../shared/types.ts'
import type { SetupItemView } from '../../../shared/environment/model.ts'
import { WorkspaceCard } from '../workbench/WorkspaceCard.tsx'
import type { ClientServices } from '../workbench/services.ts'
import { DwsLocalCard } from './DwsLocalCard.tsx'
import { IfindAuthCard } from './IfindAuthCard.tsx'
import { needsWindowsAdminReminder } from './platform-note.ts'
import { LocalAccessConsentCard } from './LocalAccessConsentCard.tsx'
import { consentGranted, consentOf } from './local-access.ts'
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
  /** 重新检查环境（只刷新本地环境结论，不会主动重跑 iFinD 远程验证）。 */
  onRefresh: () => void
  /**
   * 走**本机 CLI**登录氚云（`crwu h3yun session login`）。
   *
   * 这是**兼容路径**：CLI 自己拉起**系统浏览器**，DSH 不创建浏览器 Tab、不显示二维码、
   * 不读浏览器 Cookie、也不轮询登录进度（2026-09-30 口径）。凭据由 CLI 写进本机凭据存储，
   * 面板只负责触发与"重新检查"。
   */
  onRelogin: () => void
  /** 走**本机 CLI**登录钉钉（`dws auth login`，系统浏览器 OAuth 回调）。**无设备码入口**。 */
  onDwsLogin: () => void
  /** 最近一次登录的结果（成功 / 失败原因）；空串 = 还没点过。 */
  loginMessage?: string
  /** 被门禁拦住时的界面状态：`running` 正在检查、`blocked` 检查没过。 */
  gate?: 'idle' | 'running' | 'blocked'
  /** 被拦时本来要去的那一页名（「进入【报告审核】前…」）。 */
  gateTarget?: string
  /**
   * 统一导航层给出的**完整拦截理由**（`module-store` 的 `gateReason`）。
   *
   * 优先用它：被拦的原因可能来自任一基础必检项，页面自己拼一句通用文案会把那层信息丢掉。
   */
  gateReason?: string
  /** 浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  wsBusy: boolean
  wsMessage: string
  onWsBusy: (busy: boolean) => void
  onWsMessage: (message: string) => void
  /** 最近的本机访问诊断（协议 18 · B3）；展开开发者诊断时由面板取一次。 */
  accessDiagnostics?: AccessDiagnosticView[]
  /** DWS 本机目录的只读体检（协议 18 · D）：`null` = 还没查过。 */
  dwsLocal?: DwsLocalDoctorView | null
  dwsLocalRepair?: DwsLocalRepairView | null
  dwsLocalBusy?: boolean
  dwsLocalError?: string
  dwsLocalConfirming?: boolean
  onDwsLocalCheck?: () => void
  onDwsLocalAskRepair?: () => void
  onDwsLocalCancelRepair?: () => void
  onDwsLocalConfirmRepair?: () => void
  /** 授权（一次性、长期有效）。缺省时由 `env.localAccess` 推出（Host 是唯一判据）。 */
  authorized?: boolean
  authBusy?: boolean
  authError?: string
  authDeclined?: boolean
  /** 客户端与宿主的权限说明版本不一致（旧宿主）：授权与账号操作全部禁用。 */
  authSchemaMismatch?: boolean
  onGrantCredentials?: () => void
  onRegrant?: () => void
  /** 「暂不允许」：不产生任何 Host 变更，只是本地收起同意按钮。 */
  onDeclineCredentials?: () => void
  /** 撤销授权（写一个空能力集合的墓碑）。 */
  onRevokeCredentials?: () => void
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
function diagnosticRows(
  env: EnvResult,
  checkedAt: string,
  build: BuildSnapshot,
  access: AccessDiagnosticView[] = [],
): DiagnosticRow[] {
  const health = env.state?.systemHealth
  const integrity = env.packageIntegrity
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
        // 沙箱与审批策略也显示出来（协议 18 · C3）：验收要求"根与子会话都显示
        // workspace-write / never"。只写进提示词不算数 —— 得看得见。
        root.sandboxMode === '' ? '' : `${zhCN.envAuditRootSandbox}${root.sandboxMode}`,
        root.approvalPolicy === '' ? '' : `${zhCN.envAuditRootApproval}${root.approvalPolicy}`,
        root.usable ? '' : `${zhCN.envAuditRootStale}${root.reason === '' ? '' : `（${root.reason}）`}`,
      ].filter((item) => item !== '').join(' · ')

  return [
    { label: zhCN.envDiagWorkbenchVersion, value: buildVersionText(build), details: buildDetails },
    {
      label: zhCN.envDiagPackages,
      value: `${String(integrity.tools.filter((tool) => tool.ok).length)}/${String(integrity.tools.length)} · ${integrity.ok ? zhCN.envDiagOk : zhCN.envDiagBad}`,
      details: health === undefined || health.packageIntegrity.reason === '' ? [] : [health.packageIntegrity.reason],
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
    {
      label: zhCN.envProbe,
      value: env.delivery.probe.state === '' ? (env.delivery.probe.ok ? zhCN.envPass : zhCN.envFail) : env.delivery.probe.state,
    },
    // 最近的本机访问（协议 18 · B3）：**这是验收 §11 要求的那几项事实的唯一出口**。
    // 只列最近几条：开发者诊断是排障视图，不是审计日志（完整环形缓冲在 Host 内存里）。
    {
      label: zhCN.envDiagAccess,
      value: access.length === 0 ? zhCN.envDiagAccessNone : `${String(access.length)} ${zhCN.envDiagAccessCount}`,
      details: access.slice(0, 8).map(accessDiagnosticLine),
    },
  ]
}

/**
 * 一条本机访问诊断 → **一行**可抄进验收记录的脱敏事实。
 *
 * 字段顺序就是设计 §11 要求的证据顺序（操作名 / 来源 / 三个模式 / 两个布尔 / 归因 /
 * 进程是否起过 / 时刻）。**不**包含命令原文、路径与任何凭据 —— 那些在诊断里根本不存在。
 */
export function accessDiagnosticLine(entry: AccessDiagnosticView): string {
  const verdict = entry.errorClass === '' ? zhCN.envDiagAccessOk : entry.errorClass
  return [
    entry.operation,
    entry.source,
    `req=${entry.requestedMode === '' ? zhCN.envUnset : entry.requestedMode}`,
    `res=${entry.resolvedMode === '' ? zhCN.envUnset : entry.resolvedMode}`,
    `ran=${entry.ranMode === '' ? zhCN.envUnset : entry.ranMode}`,
    `denied=${String(entry.sandboxDenied)}`,
    `runnerFailed=${String(entry.runnerFailed)}`,
    `started=${String(entry.processStarted)}`,
    verdict,
    localTime(entry.at),
  ].join(' · ')
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

/**
 * **可选**步骤的状态语气。
 *
 * 可选能力（外部数据源）不该报红：红 = "必须处理"。所以除了"真的就绪"，它一律用琥珀
 * —— 未配置就是"未配置"，不是故障（用户口径 2026-09-30：同花顺这里直接显示未配置就可以）。
 */
function toneOfOptionalItem(item: SetupItemView): 'ok' | 'busy' | 'bad' {
  return item.state === 'ok' || item.state === 'authenticated' ? 'ok' : 'busy'
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
  // 「基础环境已就绪」= 可以放行（`ready` 或 `degraded`）。`degraded` 现在唯一的来源是
  // **可选的外部数据源**没配置：它不该让顶部显示"还需完成 0 项"这种自相矛盾的话
  // （顶部文案与侧栏那枚绿灯、与统一门禁必须说同一件事）。
  const ok = (head.status === 'ready' || head.status === 'degraded') && head.proceed
  // OSS 的探测结果里没有独立时间戳，所以"这次自检的时刻"（store 在应答落地时记的 `checkedAt`）
  // 仍可作为 OSS 事实时间；iFinD 的 checkedAt 则来自最近一次用户主动验证。
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
              <span className={C.stepTitle}>
                {step.title}
                {/* 基础必检项的**红色星号**：外部数据源（iFinD）是可选能力，刻意**不带** —— 页面才不乱。 */}
                {step.required ? <span className={C.stepRequired} aria-hidden={true}>{zhCN.envStepRequiredMark}</span> : null}
              </span>
              <span className={C.stepState}>{step.stateText}</span>
            </span>
          </button>
        </li>
      })}
    </ol>
    {/* 星号的含义只说一次：必检项必须配好，可选的外部数据源不带星号、也不拦审核。 */}
    <div className={C.stepLegend} data-crwu-env-step-legend="1">{zhCN.envStepRequiredHint}</div>
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
        {step?.required === true
          ? <span className={C.stepRequired} aria-label={zhCN.envStepRequiredHint}>{zhCN.envStepRequiredMark}</span>
          : null}
      </div>
      {props.state === undefined
        ? null
        : <Chip
            text={itemStateText(props.state)}
            tone={step?.required === false ? toneOfOptionalItem(props.state) : toneOfItem(props.state)}
          />}
    </header>
    {props.children}
  </section>
}

/**
 * 账号连接步骤：一次性授权 + 氚云 + 钉钉。
 *
 * ⚠️ **只读取、检查已有凭据**（2026-09-30 口径）：DSH **不再提供**内置浏览器扫码登录
 * （协议 20 的浏览器视图 + Cookie 读取已删除），也**不再提供**钉钉设备码登录与登录进度轮询
 * （协议 21 的两阶段卡片已删除）。留下的两颗按钮走的是**本机 CLI**：
 * CLI 自己拉起**系统浏览器**完成授权，插件只触发并随后「重新检查」。
 * 所以文案里不许再出现"内置浏览器""设备码""等待浏览器授权"这类承诺。
 */
function AccountsStep(props: EnvironmentPaneProps & {
  env: EnvResult
  authorized: boolean
  /** Host 给的"现在能不能体检"（`undefined` = 还没问到）；界面**不自己推断**。 */
  canDiagnoseDws?: boolean
}): React.ReactElement {
  const authorized = props.authorized
  /** 「暂不允许」之后点「重新允许一次」只是把本地状态翻回去，真正的同意仍是同一次提交。 */
  const grant = (): void => {
    props.onRegrant?.()
    props.onGrantCredentials?.()
  }
  return <>
    <p className={C.stepLead}>{zhCN.envStepHintAccounts}</p>
    {/* 本机访问授权**就放在配置流程里**（旧版是一层遮住整页的模态框）：逐条列出固定能力清单。 */}
    <LocalAccessConsentCard
      consent={consentOf(props.env)}
      busy={props.authBusy === true}
      error={props.authError ?? ''}
      declined={props.authDeclined === true}
      {...(props.authSchemaMismatch === true ? { schemaMismatch: true } : {})}
      onGrant={grant}
      onDecline={() => { props.onDeclineCredentials?.() }}
      onRevoke={() => { props.onRevokeCredentials?.() }}
    />
    <SetupRow
      id={props.env.services.find((service) => service.id === 'h3yun')?.label ?? '氚云（H3Yun）员工会话'}
      item={props.env.state?.userSetup.h3yun ?? { state: 'unknown', value: '', reason: '', required: true }}
      extra={<div className={C.layerActions}>
        {/* 未允许本机访问时登录按钮**禁用**：这时点下去必然失败，失败原因还会被误读成"没登录"。 */}
        <Button label={zhCN.envLoginH3yun} small disabled={!authorized} onClick={props.onRelogin} />
      </div>}
    />
    <div className={C.muted}>{zhCN.envLoginNoBuiltinBrowser}</div>
    <SetupRow
      id={props.env.services.find((service) => service.id === 'dingtalk')?.label ?? '钉钉认证'}
      item={props.env.state?.userSetup.dingtalk ?? { state: 'unknown', value: '', reason: '', required: true }}
      extra={<div className={C.layerActions}>
        <Button label={zhCN.dwsLogin} small disabled={!authorized} onClick={props.onDwsLogin} />
      </div>}
    />
    <div className={C.muted}>{zhCN.envDwsLoginNoDeviceCode}</div>
    {/* Windows 专属提醒（非阻塞）：钉钉 CLI（dws）要碰 `<HOME>\.dws` 的登录态与锁文件，
        进程权限不够时会以"锁被占用 / 拒绝访问"结束，表现却是钉钉登录一直不成功。 */}
    {needsWindowsAdminReminder(props.env)
      ? <div data-crwu-env-windows-admin="1"><Notice tone="warn">{zhCN.envWindowsAdminHint}</Notice></div>
      : null}
    {/* 登录的**前置条件**要说在点之前：这两条命令都要写工作区之外的路径
        （临时浏览器 profile / `~/.dws` 的登录态 / 操作系统凭据存储），
        文件策略不给就一条都走不通 —— 员工不该靠试错去发现这件事。 */}
    <div className={C.muted}>{zhCN.envLoginSandboxHint}</div>
    {props.loginMessage === undefined || props.loginMessage === ''
      ? null
      : <div className={C.itemFix} style={{ whiteSpace: 'pre-wrap' }}>{props.loginMessage}</div>}
    {/* 钉钉本机目录：能不能体检由 **Host** 给的事实决定（没有可归因失败时按钮禁用）；
        「修复权限」**只在确诊本机文件权限问题时**才渲染
        （见 DwsLocalCard 的 repairOffered —— 沙箱/钥匙串/锁/所有者不对都不渲染）。 */}
    <DwsLocalCard
      doctor={props.dwsLocal ?? null}
      canDiagnose={props.canDiagnoseDws}
      repair={props.dwsLocalRepair ?? null}
      busy={props.dwsLocalBusy === true}
      confirming={props.dwsLocalConfirming === true}
      error={props.dwsLocalError ?? ''}
      onCheck={() => { props.onDwsLocalCheck?.() }}
      onAskRepair={() => { props.onDwsLocalAskRepair?.() }}
      onCancelRepair={() => { props.onDwsLocalCancelRepair?.() }}
      onConfirmRepair={() => { props.onDwsLocalConfirmRepair?.() }}
    />
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
  access: AccessDiagnosticView[]
  onToggle: () => void
}): React.ReactElement {
  const rows = diagnosticRows(props.env, props.checkedAt, props.build ?? {
    ok: false, error: '', rev: '', version: '', buildKind: '', builtAt: '', protocol: null,
    permissionSchemaVersion: null, parentSessionId: '',
  }, props.access)
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

/**
 * ⚠️ 这里**没有**「打开外链」的助手了（2026-09-30）：本插件不再优先 / 也不再创建 DSH 内置浏览器
 * Tab（`open-url.ts` 已删除）。登录由本机 CLI 自己拉起系统浏览器完成，插件这边没有需要在面板里
 * 打开的 OAuth URL，也没有需要复制的设备码 —— 少一个入口就少一处"DSH 提供内置登录"的错觉。
 */

export function EnvironmentPane(props: EnvironmentPaneProps): React.ReactElement {
  const { env } = props
  const [developerDiagnosticsOpen, setDeveloperDiagnosticsOpen] = React.useState(false)
  // 最近的本机访问诊断：**展开时才取**（它是排障视图，没人看就不该产生请求；
  // 而且它只读、零副作用，所以随取随用，不进任何缓存）。
  const [accessDiagnostics, setAccessDiagnostics] = React.useState<AccessDiagnosticView[]>([])
  /**
   * 「检查本机目录」能不能点 —— **由 Host 给的**事实（`dwsDiagnosable`）。
   *
   * 挂载时问一次：它是一次零副作用的只读 RPC（同一份环形缓冲），但决定了按钮可不可点，
   * 所以不能等用户点下去才知道。`undefined` = 还没问到 → 保持可点（Host 会是那道真门禁）。
   */
  const [canDiagnoseDws, setCanDiagnoseDws] = React.useState<boolean | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    void workbenchApi.accessDiagnostics()
      .then((result) => { if (alive) setCanDiagnoseDws(result.ok ? result.dwsDiagnosable : undefined) })
      .catch(() => { if (alive) setCanDiagnoseDws(undefined) })
    return () => { alive = false }
  }, [])
  const toggleDiagnostics = (): void => {
    const next = !developerDiagnosticsOpen
    setDeveloperDiagnosticsOpen(next)
    if (!next) return
    void workbenchApi.accessDiagnostics()
      .then((result) => { setAccessDiagnostics(result.ok ? result.entries : []) })
      .catch(() => { setAccessDiagnostics([]) })
  }
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
  const authorized = props.authorized ?? consentGranted(env)
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
            canDiagnoseDws={canDiagnoseDws}
            activeStep={activeStep}
            onPick={setManualStep}
          />}

      <DeveloperDiagnostics
        env={env}
        build={props.build}
        checkedAt={props.checkedAt ?? ''}
        open={developerDiagnosticsOpen}
        access={accessDiagnostics}
        onToggle={toggleDiagnostics}
      />
    </div>
  </div>
}

/** 配置工作区：左侧步骤导航 + 右侧当前步骤。 */
function SetupWorkspace(props: EnvironmentPaneProps & {
  /** Host 给的"现在能不能体检"（`undefined` = 还没问到）。 */
  canDiagnoseDws?: boolean
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
        ? <AccountsStep
            {...props}
            env={env}
            authorized={props.authorized}
            canDiagnoseDws={props.canDiagnoseDws}
          />
        : null}
      {active === 'oss'
        ? <OssCredCard delivery={env.delivery} onSaved={props.onRefresh} />
        : null}
      {active === 'ifind'
        // 可选外部数据源，排在最后一步：那一步的正文就是卡片本身 ——
        // 未配置时直接显示「未配置」（用户口径 2026-09-30），不再堆一段口径说明。
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
