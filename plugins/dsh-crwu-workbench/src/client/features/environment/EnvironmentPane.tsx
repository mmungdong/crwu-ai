import * as React from 'react'
import { Badge, Button, Chip, LoadingBar, Meter, Notice, Section, Spinner, StatusDot, type Tone } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { text } from '../../../shared/utils/value.ts'
import { envLayerSet, envTodoText, type EnvLayer, type EnvLayerId, type EnvLayerItem, type EnvLayerSet } from './layers.ts'
import { envTally } from './status.ts'
import type { EnvResult } from '../report-audit/api.ts'
import { InstallPromptBlock } from './InstallPromptBlock.tsx'
import { OssAuthCard } from './OssAuthCard.tsx'
import { WorkspaceCard } from '../workbench/WorkspaceCard.tsx'
import type { ClientServices } from '../workbench/services.ts'

/**
 * 环境自检页。
 *
 * 它是**所有后续操作的门禁**：`blocked` 非空时报告页不给发起审核。但它的读者是普通员工
 * （资产评估师），不是维护者 —— 所以页面按**排查顺序分四层**（工具 → 登录认证 → 上传配置 →
 * 外部数据），每层一行结论 + `x/y 已就绪`；没就绪的层默认展开、没就绪的项排在最前，并且
 * **每一项都写明"怎么配"**（按钮或填哪里）。① 案例根目录在四层之前（它是前置条件）。
 *
 * 维护者信息（清单来源、sha256、会话 id、probe 原文、氚云授权开关）全部收进页脚
 * 「排查详情」，默认不展开：它们只在排查时有用，摆在员工视野里就是噪声。
 *
 * 分层、排序、状态词、"怎么配"这四件事都在 `layers.ts` 里（纯函数、有单测），
 * 这里只负责画。
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
  /** 「进入报告审核」。不通过时由工作台外壳用 loading 状态拦住，这里照旧给入口。 */
  onEnterReport?: () => void
  /** 被门禁拦住时的界面状态：`running` 正在自检、`blocked` 自检没过。 */
  gate?: 'idle' | 'running' | 'blocked'
  /** 安装提示词（由外壳拉一次，复制与预览共用同一份文本）。 */
  prompt: string
  promptUrl: string
  promptBusy: boolean
  /** 唯一那枚复制按钮的结果文案（剪贴板被拒时说明可手工全选）。 */
  promptMessage: string
  /** 浏览器侧可选服务（目录选择器 / 工作空间注册表 / layout）。 */
  services: ClientServices
  wsBusy: boolean
  wsMessage: string
  onWsBusy: (busy: boolean) => void
  onWsMessage: (message: string) => void
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

/** 状态圆点/胶囊色调：就绪=绿、需重新登录=黄、未配置=红。 */
function toneOfItem(item: EnvLayerItem): Tone {
  if (item.state === 'ok') return 'ok'
  return item.state === 'reauth' ? 'busy' : 'bad'
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

/** 一个层里的单项：状态点 + 名称 + 一句用途 + 状态词 + （没就绪时）怎么配。 */
function LayerItemRow(props: { item: EnvLayerItem; extra?: React.ReactNode }): React.ReactElement {
  const item = props.item
  const tone = toneOfItem(item)
  return <div className={C.item}>
    <StatusDot tone={tone} />
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{item.name}</span>
        <Chip text={item.stateText} tone={tone} />
      </div>
      {item.purpose === '' ? null : <div className={C.itemNote}>{item.purpose}</div>}
      {item.meta === '' ? null : <div className={`${C.itemMeta} ${C.mono}`}>{item.meta}</div>}
      {item.reason === '' ? null : <div className={C.itemFix}>{item.reason}</div>}
      {item.fix === '' ? null : <div className={C.itemFix}>{item.fix}</div>}
      {/* 工具：下载地址与安装目标路径（sha256 只进排查详情）。没有平台包时上面那句已经如实说了。 */}
      {item.fixKind !== 'tool' || item.url === '' ? null : <div className={C.row}>
        <span className={C.muted}>{zhCN.envDownloadUrl}</span>
        <span className={`${C.mono} ${C.link}`}>{item.url}</span>
      </div>}
      {item.fixKind !== 'tool' || item.target === '' ? null
        : <div className={`${C.muted} ${C.mono}`}>{`${zhCN.envInstallTarget} ${item.target}`}</div>}
      {/* iFinD 的申请入口：沿用安装清单里已有的那条来源说明，不另编流程。 */}
      {item.fixKind !== 'ifind' ? null : <div className={C.muted}>{zhCN.ifindSource}</div>}
      {props.extra}
    </div>
  </div>
}

/**
 * 一层一张卡（受控：展开状态由页面持有）。
 *
 * 状态放在**页面**而不是卡片里，有两个原因：① 页面才知道"这层要不要默认展开"（没就绪的展开）；
 * ② 展开状态集中一处，刷新自检后四层的展开/收起不会被各卡片各说各话。
 * 初值一律用非函数式（构建产物冒烟的极小 react 替身不认函数式初值）。
 */
function LayerCard(props: {
  layer: EnvLayer
  open: boolean
  onToggle: () => void
  /** 每项下面附带的交互（③ 的登录按钮）。 */
  extraFor?: (item: EnvLayerItem) => React.ReactNode
  /** 层级的动作（② 的"复制安装提示词"）。 */
  actions?: React.ReactNode
  /** 层级的"怎么办"块（④ 的 AK 表单）。 */
  fix?: React.ReactNode
  /** 常驻在标题下方的补充行（③ 的"信任本机凭据"开关）：**不能**塞进标题按钮里，按钮内不许嵌交互元素。 */
  headerExtra?: React.ReactNode
}): React.ReactElement {
  const layer = props.layer
  const open = props.open
  const countText = layer.total === 0
    ? zhCN.envNotConfigured
    : `${String(layer.pass)}/${String(layer.total)} ${zhCN.envLayerReady}`
  return <div className={`${C.layer} ${layer.needsWork ? C.layerBad : C.layerOk}`}>
    <button
      type="button"
      className={C.layerHead}
      aria-expanded={open}
      onClick={props.onToggle}
    >
      <StatusDot tone={layer.needsWork ? 'bad' : 'ok'} />
      <span className={C.layerTitle}>{layer.title}</span>
      <span className={C.layerCount}>{countText}</span>
      <span className={C.layerToggle}>{open ? zhCN.envLayerCollapse : zhCN.envLayerExpand}</span>
    </button>
    {props.headerExtra === undefined ? null : <div className={C.layerHeadExtra}>{props.headerExtra}</div>}
    {open
      ? <div className={C.layerBody}>
          {layer.total === 0
            ? <div className={C.muted}>{zhCN.envNotConfigured}</div>
            : layer.items.map((item) => <LayerItemRow key={item.id} item={item} extra={props.extraFor?.(item)} />)}
          {props.actions === undefined ? null : <div className={C.layerActions}>{props.actions}</div>}
          {props.fix === undefined ? null : <div className={C.layerFix}>{props.fix}</div>}
        </div>
      : null}
  </div>
}

/**
 * 自检结论区：一句话结论 + 「还有 N 项要处理」 + 通过率 + 主要动作。
 *
 * 主按钮跟着结论走：没就绪时最该做的是「复制安装提示词交给 Agent」；就绪时是「进入报告审核」。
 * 没就绪时仍然保留「进入报告审核」（次要按钮）：用户刚装完最想直接再点一次，外壳会当场重新
 * 自检并给出结论，而不是让人先去别处找按钮。
 */
function Hero(props: {
  env: EnvResult
  checkedAt: string
  busy: boolean
  copied: boolean
  onRefresh: () => void
  onCopyPrompt: () => void
  onEnterReport?: (() => void) | undefined
}): React.ReactElement {
  const { env } = props
  const tally = envTally(env)
  const tone: Tone = env.allOk ? 'ok' : 'bad'
  const blocked = env.blocked.length > 0
  return <div className={`${C.hero} ${env.allOk ? C.heroOk : C.heroBad}`}>
    <span className={`${C.lamp} ${env.allOk ? C.lampOk : C.lampBad}`}><StatusDot tone={tone} /></span>
    <div className={C.heroMain}>
      <div className={C.heroTitle}>
        {env.allOk ? zhCN.envHeroOk : zhCN.envHeroBad}
        {blocked ? <Chip text={`${String(env.blocked.length)}${zhCN.items}`} tone="bad" /> : null}
      </div>
      <div className={C.heroSub}>{envTodoText(env)}</div>
      {env.allOk ? null : <div className={C.muted}>{zhCN.envHeroSectionHint}</div>}
      {/* Host 的权威阻塞清单：不单独起一个区块，但也不能丢 —— 平台未识别这类原因没有层可挂。 */}
      {blocked
        ? <div className={C.heroTodo}>
            <div>{zhCN.envBlockedTitle}</div>
            <div>{env.blocked.join('；')}</div>
            <div className={C.muted}>{zhCN.envBlockedHint}</div>
          </div>
        : null}
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
        {/* 全页**唯一**的复制入口。未就绪时它是主按钮（最该做的就是把它交给 Agent）；就绪时降为
            次要按钮（员工要装别的东西时还用得上）。各层里未就绪项的"怎么配"都指向这一枚。 */}
        {env.allOk
          ? <>
              {props.onEnterReport === undefined
                ? null
                : <Button label={zhCN.enterReport} tone="primary" onClick={props.onEnterReport} />}
              <Button label={props.busy ? '…' : zhCN.refreshEnv} disabled={props.busy} onClick={props.onRefresh} />
              <Button label={props.copied ? zhCN.copied : zhCN.envCopyInstallPrompt} onClick={props.onCopyPrompt} />
            </>
          : <>
              <Button label={props.copied ? zhCN.copied : zhCN.envCopyInstallPrompt} tone="primary" onClick={props.onCopyPrompt} />
              <Button label={props.busy ? '…' : zhCN.refreshEnv} disabled={props.busy} onClick={props.onRefresh} />
              {props.onEnterReport === undefined
                ? null
                : <Button label={zhCN.enterReport} onClick={props.onEnterReport} />}
            </>
        }
      </div>
    </div>
  </div>
}

/** 工具类的维护者明细：每项的版本约束 / 实际值 / sha256 / 安装目标路径。 */
function ToolDetails(props: { env: EnvResult }): React.ReactElement {
  return <Section title={zhCN.envDetailsTools}>
    <div className={C.kv}>
      {props.env.checks.map((check) => <Kv key={check.name} label={check.name}>
        <span className={C.mono}>{check.found ? check.path : zhCN.envNotInstalled}</span>
        {check.versionText === '' ? null : <span className={`${C.muted} ${C.mono}`}>{` · ${check.versionText}`}</span>}
        {check.expect === '' ? null : <span className={C.muted}>{` · ${zhCN.envExpected} ${check.expect}`}</span>}
        {check.actual === '' ? null : <span className={`${C.muted} ${C.mono}`}>{` · ${zhCN.envVersionText} ${check.actual}`}</span>}
        {check.sha256 === '' ? null : <div className={`${C.muted} ${C.mono}`}>{`${zhCN.envChecksum} ${check.sha256}`}</div>}
        {check.target === '' ? null : <div className={`${C.muted} ${C.mono}`}>{`${zhCN.envInstallTarget} ${check.target}`}</div>}
        {check.reason === '' ? null : <div className={C.itemFix}>{`${zhCN.envReason}：${check.reason}`}</div>}
      </Kv>)}
    </div>
  </Section>
}

/** 只读的环境事实：出问题时用来对账（清单来自哪、会话挂在哪个工作空间）。 */
function InfoSection(props: {
  env: EnvResult
  checkedAt: string
}): React.ReactElement {
  const { env } = props
  const session = env.sessionWorkspace
  // 审核子代理挂在哪：老 Host 不带这个字段，界面按「尚未创建」显示。
  const root = env.auditRoot
  return <Section title={zhCN.envDetailsInfo}>
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
  </Section>
}

/** 交付件回传的明细（AK 表单在 ④ 层里，这里只放配置事实）。 */
function OssSection(props: { env: EnvResult }): React.ReactElement {
  const { env } = props
  const oss = env.oss
  const probe = (oss.probe ?? {}) as { ok?: boolean; state?: string; detail?: string }
  return <Section title={zhCN.envDetailsOss}>
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

/**
 * 排查详情（维护者看）：默认收起。
 *
 * 里面是清单来源、会话 id、sha256、probe 原文这些**只有排查时才需要**的东西；
 * 默认展开会让员工一进门就看到一堆看不懂的路径与校验和（用户报的"乱"就是这个）。
 */
function MaintenanceDetails(props: {
  env: EnvResult
  checkedAt: string
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  const open = props.open
  return <div className={C.details}>
    <button type="button" className={C.detailsHead} aria-expanded={open} onClick={props.onToggle}>
      <span>{zhCN.envDetailsTitle}</span>
      <span className={C.detailsToggle}>{open ? zhCN.envLayerCollapse : zhCN.envLayerExpand}</span>
    </button>
    {open
      ? <div className={C.detailsBody}>
          <ToolDetails env={props.env} />
          <OssSection env={props.env} />
          <InfoSection env={props.env} checkedAt={props.checkedAt} />
        </div>
      : null}
  </div>
}

/** 各层初始展开状态：没就绪的展开（员工一眼看到要处理什么），全就绪的收成一行。 */
function initialOpenLayers(layers: EnvLayerSet): Record<EnvLayerId, boolean> {
  return {
    tools: layers.tools.needsWork,
    auth: layers.auth.needsWork,
    upload: layers.upload.needsWork,
    external: layers.external.needsWork,
  }
}

export function EnvironmentPane(props: EnvironmentPaneProps): React.ReactElement {
  const { env } = props
  // 展开状态在**页面**这一层（见 LayerCard 的注释）：初值不是函数式，替身也认。
  const [openLayers, setOpenLayers] = React.useState<Record<EnvLayerId, boolean>>(
    env === null ? { tools: false, auth: false, upload: false, external: false } : initialOpenLayers(envLayerSet(env)),
  )
  const [detailsOpen, setDetailsOpen] = React.useState(false)

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
  const layers = envLayerSet(env)

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
        onEnterReport={props.onEnterReport}
      />

      {/* ① 案例根目录：前置条件，排在四层之前（审核产物写到哪）。 */}
      <WorkspaceCard
        workspace={env.workspace}
        services={props.services}
        busy={props.wsBusy}
        message={props.wsMessage}
        onBusy={props.onWsBusy}
        onMessage={props.onWsMessage}
        onRefresh={props.onRefresh}
      />

      {/* ② 工具：怎么配都一样 —— 把安装提示词交给 Agent，所以动作放在层上，缺哪个都在那一句里。 */}
      <LayerCard
        layer={layers.tools}
        open={openLayers.tools}
        onToggle={() => { setOpenLayers({ ...openLayers, tools: !openLayers.tools }) }}
        actions={<>
          {/* 复制安装提示词**全页只留 Hero 那一枚**：同一动作在这里再放一枚只会让人犹豫点哪个。 */}
          <Button label={zhCN.refreshEnv} small disabled={props.busy} onClick={props.onRefresh} />
        </>}
      />

      {/* ③ 登录认证：登录按钮就在没就绪的那一项上（不再挤在 Hero 里）。 */}
      <LayerCard
        layer={layers.auth}
        open={openLayers.auth}
        onToggle={() => { setOpenLayers({ ...openLayers, auth: !openLayers.auth }) }}
        headerExtra={<span className={C.authGranted}>{zhCN.authGrantedLine}</span>}
        extraFor={(item) => {
          if (item.fixKind === 'h3yun') {
            return <div className={C.layerActions}>
              <Button label={zhCN.envLoginH3yun} small onClick={props.onRelogin} />
            </div>
          }
          if (item.fixKind === 'dws') {
            return <div className={C.layerActions}>
              <Button label={zhCN.dwsLogin} small onClick={props.onDwsLogin} />
            </div>
          }
          return null
        }}
      />

      {/* ④ 上传配置（AK）：表单就嵌在这一层里 —— 审核跑完等着上传时再去找 agent 是来不及的。 */}
      <LayerCard
        layer={layers.upload}
        open={openLayers.upload}
        onToggle={() => { setOpenLayers({ ...openLayers, upload: !openLayers.upload }) }}
        fix={<OssAuthCard
          cred={env.ossCred}
            onRefresh={props.onRefresh}
        />}
      />

      {/* ⑤ 外部数据（同花顺 iFinD）。 */}
      <LayerCard
        layer={layers.external}
        open={openLayers.external}
        onToggle={() => { setOpenLayers({ ...openLayers, external: !openLayers.external }) }}
      />

      <MaintenanceDetails
        env={env}
        checkedAt={props.checkedAt ?? ''}
        open={detailsOpen}
        onToggle={() => { setDetailsOpen(!detailsOpen) }}
      />

      <InstallPromptBlock
        prompt={props.prompt}
        url={props.promptUrl}
        busy={props.promptBusy}
        message={props.promptMessage}
      />
    </div>
  </div>
}
