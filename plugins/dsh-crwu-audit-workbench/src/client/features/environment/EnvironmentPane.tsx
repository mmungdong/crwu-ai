import * as React from 'react'
import { Badge, Button, Chip, LoadingBar, Meter, Notice, Section, Spinner, StatusDot, type Tone } from '../../components/primitives.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { text } from '../../../shared/utils/value.ts'
import { envTally } from './status.ts'
import type { EnvResult } from '../report-audit/api.ts'
import { InstallPromptBlock } from './InstallPromptBlock.tsx'
import { OssAuthCard } from './OssAuthCard.tsx'
import { WorkspaceCard } from '../workbench/WorkspaceCard.tsx'
import type { ClientServices } from '../workbench/services.ts'

/**
 * 环境自检页。
 *
 * 它是**所有后续操作的门禁**：`blocked` 非空时报告页不给发起审核。所以这一页的职责是
 * 把「还差什么」说得足够具体 —— 每项都要显示实际路径、实际版本、失败原因与补救入口，
 * 而不是只给一个红点。
 *
 * 页面的组织方式照用户排查的顺序：
 *   结论（hero）→ 阻塞清单 → ① 工作空间 → ② 运行时/命令行 → ③ 账号与登录
 *   → ④ 密钥 → ⑤ 交付件回传 → ⑥ 安装提示词 → ⑦ 运行环境信息。
 * 前七项都是「主机会实际去探测的东西」，⑧ 是只读的环境事实，出问题时用来对账。
 */

export interface EnvironmentPaneProps {
  env: EnvResult | null
  error: string
  busy: boolean
  /** 最近一次成功自检的时刻（ISO 串）；空串表示还不知道。 */
  checkedAt?: string
  onRefresh: () => void
  onCopyPrompt: () => void
  copied: boolean
  onRelogin: () => void
  onDwsLogin: () => void
  /** 记住氚云授权：开了之后白名单内的 crwu 子命令才不会逐次询问。 */
  onTrust: (h3yun: boolean) => void
  /** 「进入报告审核」。不通过时由工作台外壳用 loading 状态拦住，这里照旧给入口。 */
  onEnterReport?: () => void
  /** 被门禁拦住时的界面状态：`running` 正在自检、`blocked` 自检没过。 */
  gate?: 'idle' | 'running' | 'blocked'
  /** 安装提示词（由外壳拉一次，复制与预览共用同一份文本）。 */
  prompt: string
  promptUrl: string
  promptBusy: boolean
  promptCopied: boolean
  promptMessage: string
  onPromptRefresh: () => void
  onPromptCopied: (message: string) => void
  /** 浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  wsBusy: boolean
  wsMessage: string
  onWsBusy: (busy: boolean) => void
  onWsMessage: (message: string) => void
}

/** 从 checkbox 事件里取布尔值；测试里是替身。 */
function readChecked(event: unknown): boolean {
  const target = (event as { target?: { checked?: unknown } } | null)?.target
  return target?.checked === true
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

/** 一条检查的结论 → 圆点/胶囊色调。 */
function toneOf(ok: boolean, required: boolean): Tone {
  if (ok) return 'ok'
  return required ? 'bad' : 'busy'
}

/**
 * 会话 id 的短显示。
 *
 * 审核根会话的 id 是 `session-<uuid>` 形状，直接 `slice(0, 8)` 得到的是 `session-` ——
 * 界面上就是一串没有信息量的「· session-…」（实测：断言 `session-a` 才发现的）。
 * 所以先剥掉 `session-` 前缀再取 8 位，用户才能拿它去侧栏核对。
 */
function shortSessionId(id: string): string {
  const tail = id.startsWith('session-') ? id.slice('session-'.length) : id
  return (tail === '' ? id : tail).slice(0, 8)
}

/** 阻塞清单：编号 + 文案，避免用户自己去列表里对应。 */
function Blockers(props: { items: string[] }): React.ReactElement | null {
  if (props.items.length === 0) return null
  return <Notice tone="warn">
    <div className={C.itemName}>{zhCN.envBlockedTitle}</div>
    <div className={C.muted}>{zhCN.envBlockedHint}</div>
    <ol className={C.blockers}>
      {props.items.map((item, index) => <li className={C.blocker} key={`${index}-${item}`}>
        <span className={C.blockerIndex}>{String(index + 1)}</span>
        <span>{item}</span>
      </li>)}
    </ol>
  </Notice>
}

/** 自检结论区：大号状态灯 + 通过率 + 一组计数 + 主要动作。 */
function Hero(props: {
  env: EnvResult
  checkedAt: string
  busy: boolean
  copied: boolean
  onRefresh: () => void
  onCopyPrompt: () => void
  onRelogin: () => void
  onDwsLogin: () => void
  onEnterReport?: (() => void) | undefined
}): React.ReactElement {
  const { env } = props
  const tally = envTally(env)
  const tone: Tone = env.allOk ? 'ok' : 'bad'
  const lamp = env.allOk ? C.lampOk : C.lampBad
  return <div className={`${C.hero} ${env.allOk ? C.heroOk : C.heroBad}`}>
    <span className={`${C.lamp} ${lamp}`}><StatusDot tone={tone} /></span>
    <div className={C.heroMain}>
      <div className={C.heroTitle}>
        {env.allOk ? zhCN.envHeroOk : zhCN.envHeroBad}
        {env.allOk ? null : <Chip text={`${String(env.blocked.length)}${zhCN.items}`} tone="bad" />}
      </div>
      <div className={C.heroSub}>{env.allOk ? zhCN.envHeroOkSub : zhCN.envHeroBadSub}</div>
      <Meter ratio={tally.ratio} bad={!env.allOk} />
      <div className={C.metrics}>
        <div className={C.metric}>
          <div className={C.metricValue}>{`${String(tally.passed)}/${String(tally.total)}`}</div>
          <div className={C.metricLabel}>{zhCN.envMetricPassed}</div>
        </div>
        <div className={C.metric}>
          <div className={C.metricValue}>{String(env.blocked.length)}</div>
          <div className={C.metricLabel}>{zhCN.envMetricFailed}</div>
        </div>
        <div className={C.metric}>
          <div className={C.metricValue}>{env.platform === '' ? '—' : env.platform}</div>
          <div className={C.metricLabel}>{zhCN.envMetricPlatform}</div>
        </div>
        <div className={C.metric}>
          <div className={C.metricValue}>{props.checkedAt === '' ? '—' : localTime(props.checkedAt)}</div>
          <div className={C.metricLabel}>{zhCN.envCheckedAt}</div>
        </div>
      </div>
      <div className={C.heroActions}>
        {props.onEnterReport === undefined
          ? null
          : <Button label={zhCN.enterReport} tone={env.allOk ? 'primary' : 'plain'} onClick={props.onEnterReport} />}
        <Button label={props.busy ? '…' : zhCN.refreshEnv} disabled={props.busy} onClick={props.onRefresh} />
        <Button label={props.copied ? zhCN.copied : zhCN.copyPrompt} onClick={props.onCopyPrompt} />
        <Button label={zhCN.relogin} onClick={props.onRelogin} />
        <Button label={zhCN.dwsLogin} onClick={props.onDwsLogin} />
      </div>
    </div>
  </div>
}

/** ② 单个二进制：状态 + 路径 + 版本 + 用途 + 失败原因与补救地址。 */
function RuntimeItem(props: { check: EnvResult['checks'][number] }): React.ReactElement {
  const check = props.check
  const tone = toneOf(check.ok, check.required)
  const detail = check.found
    ? `${check.path}${check.versionText === '' ? '' : ` · ${check.versionText}`}`
    : zhCN.envNotInstalled
  return <div className={C.item}>
    <StatusDot tone={tone} />
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{check.name}</span>
        <Chip text={check.ok ? zhCN.envPass : zhCN.envFail} tone={tone} />
        <Chip text={check.required ? zhCN.envRequired : zhCN.envOptional} tone="idle" />
        {check.versionText === '' ? null : <span className={`${C.muted} ${C.mono}`}>{check.versionText}</span>}
      </div>
      <div className={`${C.itemMeta} ${C.mono}`}>{detail}</div>
      {check.note === '' ? null : <div className={C.itemNote}>{check.note}</div>}
      {check.expect === '' ? null : <div className={C.muted}>{`${zhCN.envExpected} ${check.expect}`}</div>}
      {check.reason === '' ? null : <div className={C.itemFix}>{`${zhCN.envReason}：${check.reason}`}</div>}
      {check.ok || check.target === '' ? null
        : <div className={`${C.muted} ${C.mono}`}>{`${zhCN.envInstallTarget} ${check.target}`}</div>}
      {check.ok || check.url === '' ? null : <div className={C.row}>
        <span className={C.muted}>{zhCN.envDownloadUrl}</span>
        <span className={`${C.mono} ${C.link}`}>{check.url}</span>
        <CopyButton text={check.url} small />
      </div>}
      {check.ok || check.sha256 === '' ? null
        : <div className={`${C.muted} ${C.mono}`}>{`${zhCN.envChecksum} ${check.sha256}`}</div>}
    </div>
  </div>
}

/** ③ 一个账号/服务：状态 + 人类可读状态 + 探测详情。 */
function ServiceItem(props: { service: EnvResult['services'][number] }): React.ReactElement {
  const service = props.service
  const tone = toneOf(service.ok, service.required)
  return <div className={C.item}>
    <StatusDot tone={tone} />
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{service.label}</span>
        <Chip text={service.state === '' ? (service.ok ? zhCN.envPass : zhCN.envFail) : service.state} tone={tone} />
        <Chip text={service.required ? zhCN.envRequired : zhCN.envOptional} tone="idle" />
      </div>
      {service.detail === '' ? null : <div className={`${C.itemMeta} ${C.mono}`}>{service.detail}</div>}
    </div>
  </div>
}

/** ⑦ 只读的环境事实：出问题时用来对账（清单来自哪、会话挂在哪个工作空间）。 */
function InfoSection(props: {
  env: EnvResult
  checkedAt: string
  onTrust: (h3yun: boolean) => void
}): React.ReactElement {
  const { env } = props
  const session = env.sessionWorkspace
  // 审核子代理挂在哪：老 Host 不带这个字段，界面按「尚未创建」显示。
  const root = env.auditRoot
  return <Section title={zhCN.envSectionInfo}>
    <div className={C.kv}>
      <Kv label={zhCN.envMetricPlatform}>{env.platform === '' ? zhCN.envNotResolved : env.platform}</Kv>
      <Kv label={zhCN.envHome}><span className={C.mono}>{env.home}</span></Kv>
      <Kv label={zhCN.envManifestSource}>
        <span className={C.mono}>{env.manifestSource === '' ? zhCN.envNotConfigured : env.manifestSource}</span>
        <span className={C.muted}>{`（${env.manifestLoaded ? zhCN.envManifestLoaded : zhCN.envManifestBuiltin}${env.manifestKind === '' ? '' : ` · ${env.manifestKind}`}）`}</span>
      </Kv>
      <Kv label={zhCN.envManifestUpdated}>
        {env.manifestUpdatedAt === '' ? zhCN.envUnset : `${localTime(env.manifestUpdatedAt)}（${env.manifestUpdatedAt}）`}
      </Kv>
      {env.manifestError === '' ? null : <Kv label={zhCN.envManifestError}>
        <span className={C.error}>{env.manifestError}</span>
      </Kv>}
      <Kv label={zhCN.envInstallDoc}>
        <span className={`${C.mono} ${C.link}`}>{env.installDocUrl === '' ? zhCN.envNotConfigured : env.installDocUrl}</span>
      </Kv>
      <Kv label={zhCN.envCheckedAt}>{props.checkedAt === '' ? zhCN.envUnset : localTime(props.checkedAt)}</Kv>
      <Kv label={zhCN.envCaseRoot}>
        <span className={C.mono}>{env.workspace.path === '' ? zhCN.envUnset : env.workspace.path}</span>
      </Kv>
      <Kv label={zhCN.envAuditRoot}>
        {root === undefined || root.sessionId === ''
          ? <span className={C.muted}>{zhCN.envAuditRootNone}</span>
          : <>
              <span>{root.title || root.sessionId}</span>
              <span className={`${C.muted} ${C.mono}`}>{` · ${shortSessionId(root.sessionId)}…`}</span>
              {/* 「挂在哪个工作空间」要就地看得出来：用户报的正是「没挂到我的工作空间里」，
                  让他去比对 ① 不够直接。 */}
              {root.workspacePath ? <span className={`${C.muted} ${C.mono}`}>{` · ${root.workspacePath}`}</span> : null}
              {root.usable ? null : <span className={C.muted}>{zhCN.envAuditRootStale}</span>}
            </>}
      </Kv>
      <Kv label={zhCN.envParentSession}>
        <span className={C.mono}>{session.parentSessionId === '' ? zhCN.envUnset : session.parentSessionId}</span>
      </Kv>
      <Kv label={zhCN.envSessionCwd}>
        <span className={C.mono}>{session.sessionCwd === '' ? zhCN.envUnset : session.sessionCwd}</span>
      </Kv>
      <Kv label={zhCN.envSessionWorkspaceTitle}>
        {session.workspaceTitle === '' ? zhCN.envUnset : `${session.workspaceTitle}${session.workspacePath === '' ? '' : `（${session.workspacePath}）`}`}
      </Kv>
    </div>
    <div className={C.divider} />
    {/* 氚云授权开关：Host 的 runCrwu 用它决定白名单子命令是否免沙箱。
        界面上没有它，`trustH3yun` 永远是 false，读氚云就会一直撞钥匙串。 */}
    <label className={C.row} style={{ gap: '6px', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={env.trust.h3yun === true}
        onChange={(event) => props.onTrust(readChecked(event))}
      />
      <span>{zhCN.trustHint}</span>
      {env.trust.h3yun === true ? <Badge text={zhCN.trustOn} tone="medium" /> : null}
    </label>
  </Section>
}

/** ⑤ OSS 配置详情（凭据表单在 OssAuthCard 里）。 */
function OssSection(props: { env: EnvResult }): React.ReactElement {
  const { env } = props
  const oss = env.oss
  const probe = (oss.probe ?? {}) as { ok?: boolean; state?: string; detail?: string }
  return <Section title={zhCN.envSectionOss}>
    <div className={C.kv}>
      <Kv label={zhCN.envOssBucket}>
        <span className={C.mono}>{text(oss.bucket) === '' ? zhCN.envNotConfigured : text(oss.bucket)}</span>
      </Kv>
      <Kv label={zhCN.envOssPrefix}><span className={C.mono}>{text(oss.prefix)}</span></Kv>
      <Kv label={zhCN.envOssEndpoint}>
        <span className={C.mono}>{text(oss.endpoint) === '' ? zhCN.envUnset : text(oss.endpoint)}</span>
      </Kv>
      <Kv label={zhCN.envOssLinkMode}>{`${text(oss.linkMode)}${text(oss.linkTtl) === '' ? '' : ` · ${text(oss.linkTtl)}${zhCN.envSeconds}`}`}</Kv>
      <Kv label={zhCN.envOssAutoUpload}>{text(oss.autoUpload)}</Kv>
      <Kv label={zhCN.envOssOssutil}>
        {oss.ossutilReady === true ? zhCN.envOssReady : zhCN.envOssNotReady}
      </Kv>
      <Kv label={zhCN.envOssCredFile}>
        <span className={C.mono}>{env.ossCred.exists ? env.ossCred.path : zhCN.envOssCredMissing}</span>
      </Kv>
      <Kv label={zhCN.envOssCredAk}>
        <span className={C.mono}>{env.ossCred.accessKeyIdMasked === '' ? zhCN.envOssCredMissing : env.ossCred.accessKeyIdMasked}</span>
      </Kv>
      <Kv label={zhCN.envProbe}>
        <Chip
          text={probe.state === undefined || probe.state === '' ? (probe.ok === true ? zhCN.envPass : zhCN.envFail) : probe.state}
          tone={probe.ok === true ? 'ok' : 'bad'}
        />
      </Kv>
    </div>
    {probe.detail === undefined || probe.detail === '' ? null
      : <div className={`${C.itemMeta} ${C.mono}`}>{probe.detail}</div>}
  </Section>
}

export function EnvironmentPane(props: EnvironmentPaneProps): React.ReactElement {
  const { env } = props

  if (env === null) {
    // 首次加载时 busy 可能还没翻成 true（状态更新是异步的），所以「没有数据 + 没有错误」
    // 一律显示「正在自检」，避免先闪一个空面板再出现内容。
    if (props.error !== '') {
      return <div>
        <Notice tone="warn">{props.error}</Notice>
        <div className={C.row}>
          <Button label={zhCN.recheck} onClick={props.onRefresh} />
        </div>
      </div>
    }
    return <div className={C.loading}>
      <Spinner large />
      <span>{zhCN.loadingEnv}</span>
    </div>
  }

  const gate = props.gate ?? 'idle'
  const ifind = env.ifindKey
  const ifindTone = toneOf(ifind.ok, ifind.required)

  return <div>
    {props.error === '' ? null : <Notice tone="warn">{props.error}</Notice>}

    {/* 被拦住的解释放在最上面：用户是从「进入报告审核」被挡回来的，要立刻知道发生了什么。 */}
    {gate === 'idle' ? null : <div className={C.gate}>
      {gate === 'running'
        ? <div className={C.row}>
            <Spinner />
            <span className={C.gateTitle}>{zhCN.gateRunningTitle}</span>
          </div>
        : <div className={C.gateTitle}>{zhCN.gateBlockedTitle}</div>}
      <div className={C.muted}>{gate === 'running' ? zhCN.gateRunningHint : zhCN.gateBlockedHint}</div>
    </div>}

    {/* 重新自检要跑 shell 探测 + 氚云/钉钉登录态 + 一次 OSS 实测，好几秒；
        没有这条进度条，用户只会看到界面「卡住」。下面的正文同时压暗并停掉点击，防手快连点。 */}
    <LoadingBar active={props.busy} />

    <div className={props.busy ? C.dim : ''}>
    <Hero
      env={env}
      checkedAt={props.checkedAt ?? ''}
      busy={props.busy}
      copied={props.copied}
      onRefresh={props.onRefresh}
      onCopyPrompt={props.onCopyPrompt}
      onRelogin={props.onRelogin}
      onDwsLogin={props.onDwsLogin}
      onEnterReport={props.onEnterReport}
    />

    <Blockers items={env.blocked} />

    <WorkspaceCard
      workspace={env.workspace}
      services={props.services}
      busy={props.wsBusy}
      message={props.wsMessage}
      onBusy={props.onWsBusy}
      onMessage={props.onWsMessage}
      onRefresh={props.onRefresh}
    />

    <Section
      title={zhCN.envSectionRuntime}
      count={`${String(env.checks.filter((check) => check.ok).length)}/${String(env.checks.length)}`}
    >
      {env.checks.length === 0
        ? <div className={C.muted}>{zhCN.envNotConfigured}</div>
        : env.checks.map((check) => <RuntimeItem key={check.name} check={check} />)}
    </Section>

    <Section title={zhCN.envSectionAccounts} count={`${String(env.services.filter((service) => service.ok).length)}/${String(env.services.length)}`}>
      {env.services.length === 0
        ? <div className={C.muted}>{zhCN.envNotConfigured}</div>
        : env.services.map((service) => <ServiceItem key={service.id} service={service} />)}
    </Section>

    <Section title={zhCN.envSectionIfind}>
      <div className={C.item}>
        <StatusDot tone={ifindTone} />
        <div className={C.itemMain}>
          <div className={C.itemHead}>
            <span className={C.itemName}>{zhCN.ifindItemName}</span>
            <Chip
              text={ifind.ok ? zhCN.ifindOk : zhCN.ifindMissing}
              tone={ifindTone}
            />
          </div>
          <div className={`${C.itemMeta} ${C.mono}`}>{`${zhCN.envIfindPath} ${ifind.path}`}</div>
          {ifind.ok
            // 只回长度，绝不回显密钥内容。
            ? <div className={C.muted}>{`${zhCN.ifindConfigured}${String(ifind.tokenLength)}${zhCN.ifindNoEcho}`}</div>
            : <div className={C.itemFix}>{ifind.reason === '' ? zhCN.ifindMissing : ifind.reason}</div>}
          <div className={C.muted}>{zhCN.ifindSource}</div>
        </div>
      </div>
    </Section>

    <OssAuthCard
      cred={env.ossCred}
      defaultEndpoint={text(env.oss.endpoint)}
      onRefresh={props.onRefresh}
    />

    <OssSection env={env} />

    <InstallPromptBlock
      prompt={props.prompt}
      url={props.promptUrl}
      busy={props.promptBusy}
      copied={props.promptCopied}
      message={props.promptMessage}
      onRefresh={props.onPromptRefresh}
      onCopied={props.onPromptCopied}
    />

    <InfoSection env={env} checkedAt={props.checkedAt ?? ''} onTrust={props.onTrust} />
    </div>
  </div>
}
