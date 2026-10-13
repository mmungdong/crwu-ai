import * as React from 'react'
import { SideDrawer } from '../../../ui/SideDrawer.tsx'
import { Badge } from '../../../ui/primitives.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import {
  fieldRowsOf,
  valuationMethodLabel,
  type ValuationIntakeView,
  type ValuationMethod,
} from '../model/valuation-state.ts'

/**
 * **只读确认抽屉**（方案 §5.4）。
 *
 * ## 只读是结构性的，不是"没绑 onClick"
 *
 * 这个组件**只接收**一个 `intake`（Host 回填的事实）和三个回调（返回 / 确认 / 取消）。
 * 它没有 `onChange`，也没有可编辑控件 —— 输入框、下拉、日期选择器**一个都不存在**，
 * 于是"在抽屉里改方法/基准日/提示词"在类型上就写不出来。
 * 与之配套的状态机判据是 `canEditInputs(phase)`（`confirmation` 阶段为 false）。
 *
 * ## 三个按钮之外不加东西
 *
 * 方案明确"按钮只有 返回修改 / 确认并开始估值 / 取消"。不提供"去登录"之类的旁路 ——
 * 登录是外部能力动作，见进度页；抽屉里只如实**展示**登录状态。
 */

export interface ValuationConfirmationDrawerProps {
  intake: ValuationIntakeView
  /** 用户在表单里选的方法（`intake.method` 是 Host 回显，两者应当一致）。 */
  method: ValuationMethod
  open: boolean
  /** 外部来源预检的进行状态：`checking` 时那三行显示「检查中」。 */
  providerCheck?: 'idle' | 'checking' | 'done'
  /** 逐家的最新状态（探测结果局部更新到这里；缺项时用 `intake.providers` 的初值）。 */
  providerStates?: Record<string, { state: string; attempts: number; detail: string }>
  onBack: () => void
  onConfirm: () => void
  /**
   * 「重新检查」：再问一次宿主（资料提取 + 规则定位 + 外部来源状态）。
   *
   * 它是 §5 点名的三个动作之一：用户可能刚在默认浏览器登录完、或刚补了一份规范，
   * 这时要能**就地把这一轮重查一遍**，而不是返回表单从头再来。
   */
  onRecheck?: () => void
  /** 打开该站点自己的公开登录页（不读 Cookie、不导出凭据）。 */
  onOpenLogin?: (providerId: string) => void
}

/** 来源状态的人话 + 语气（认不出来就是"无法检查"，**不猜**成已登录）。 */
function providerLabelOf(state: string, checking: boolean): string {
  if (checking) return zhCN.valuationProviderChecking
  if (state === 'authenticated') return zhCN.valuationDrawerProviderReady
  if (state === 'unauthenticated') return zhCN.valuationDrawerProviderLogin
  if (state === 'unknown') return zhCN.valuationProviderCannotCheck
  return zhCN.valuationProviderUnchecked
}

function providerTone(state: string, checking: boolean): 'ok' | 'medium' | 'low' {
  if (checking) return 'low'
  if (state === 'authenticated') return 'ok'
  if (state === 'unauthenticated') return 'medium'
  return 'low'
}

function fileStatusText(status: string): string {
  return status === 'parsed' ? zhCN.valuationDrawerFileStatusParsed : zhCN.valuationDrawerFileStatusUnparsed
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function ValuationConfirmationDrawer(props: ValuationConfirmationDrawerProps): React.ReactElement {
  const { intake } = props
  const rows = fieldRowsOf(intake.extractedFields)

  /**
   * 焦点管理（§11.3）：
   * - 打开时把焦点送进抽屉的**主操作**（确认并开始估值），键盘用户不用先 Tab 一圈；
   * - 关闭 / 返回修改由调用方（`ReportEvaluationPane` 那一侧的表单）把焦点送回
   *   「检查并确认」—— 抽屉自己卸载后没有可聚焦的东西，只能由仍在的那一侧接手。
   *
   * `?.` 一路兜底：注入式渲染替身里 ref 不接 DOM，这时静默跳过即可。
   */
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)
  React.useEffect(() => {
    if (!props.open) return
    confirmRef.current?.focus?.()
  }, [props.open])

  // `SideDrawer` 自己管开关动画与 Esc：`open` 为假时父层直接不渲染它，
  // 所以这里只在打开时才渲染，避免抽屉内容参与关闭动画期间的可访问性树。
  if (!props.open) return <></>
  return <SideDrawer
    title={zhCN.valuationDrawerTitle}
    onClose={props.onBack}
    // 稳定的测试锚点：抽屉"打开了没有"不该靠猜类名组合。
    dataAttributes={{ 'data-valuation-confirmation-drawer': 'true' }}
  >
    <div className="crwu-valuation-drawer-actions">
      <button type="button" className="crwu-valuation-btn" onClick={props.onBack}>{zhCN.valuationDrawerBack}</button>
      {/* §5 点名的三个动作：返回修改 / 重新检查 / 确认并开始。
          「取消本轮」在进度页与结果页（那时才真的有一轮在跑 / 已跑完）。 */}
      <button
        type="button"
        className="crwu-valuation-btn"
        onClick={() => { props.onRecheck?.() }}
      >{zhCN.valuationDrawerRecheck}</button>
      <button
        type="button"
        ref={confirmRef}
        className="crwu-valuation-btn crwu-valuation-btn-primary"
        onClick={props.onConfirm}
      >
        {zhCN.valuationDrawerConfirm}
      </button>
    </div>
    <p className="crwu-valuation-drawer-note">{zhCN.valuationDrawerReadonly}</p>

    <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationDrawerFiles}</h4>
      <ul className="crwu-valuation-drawer-files">
        {intake.files.map((file) => <li key={`${file.relativePath || file.fileName}`}>
          <span className="crwu-valuation-drawer-file-name">{file.fileName}</span>
          <span className="crwu-valuation-drawer-file-meta">{file.kind} · {formatBytes(file.sizeBytes)}</span>
          <Badge text={fileStatusText(file.status)} tone={file.status === 'parsed' ? 'ok' : 'medium'} />
          {file.note === '' ? null : <span className="crwu-valuation-drawer-file-note">{file.note}</span>}
        </li>)}
      </ul>
    </section>

    <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationMethodTitle}</h4>
      <p data-valuation-readonly="method">
        {valuationMethodLabel(props.method)}
        {props.method === 'auto' ? <span className="crwu-valuation-drawer-note-inline"> · {zhCN.valuationDrawerMethodAuto}</span> : null}
      </p>
      <h4>{zhCN.valuationBaseDateTitle}</h4>
      <p data-valuation-readonly="baseDate">
        {intake.baseDate === '' ? zhCN.valuationResultNoBaseDate : intake.baseDate}
      </p>
      <h4>{zhCN.valuationDrawerPrompt}</h4>
      <p data-valuation-readonly="prompt">
        {intake.supplementalPrompt === '' ? zhCN.valuationDrawerNone : intake.supplementalPrompt}
      </p>
    </section>

    <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationDrawerKnown}</h4>
      <dl className="crwu-valuation-drawer-fields">
        {rows.filter((row) => !row.missing).map((row) => <React.Fragment key={row.key}>
          <dt>{row.label}</dt>
          <dd>
            {row.value}
            {/* 每项关键事实的来源。提取器以**文件**为粒度（不回页码 / 工作表位置），
                所以这里如实标到文件，并在下面说明粒度限制。 */}
            {intake.fieldSources[row.key] === undefined
              ? null
              : <span className="crwu-valuation-drawer-source" data-valuation-field-source={row.key}>
                {zhCN.valuationDrawerSourceFrom.replace('{file}', intake.fieldSources[row.key])}
              </span>}
          </dd>
        </React.Fragment>)}
      </dl>
      <p className="crwu-valuation-drawer-note">{zhCN.valuationDrawerSourceGranularity}</p>

      {/* **资料之间的冲突**：同一要素在不同资料里不一致时，双方来源都要留，并写明当前采用哪一份
          （§4「用户补充与文件内容冲突时保留双方来源，并在确认信息中说明」的同类要求）。 */}
      <h4>{zhCN.valuationDrawerConflicts}</h4>
      {intake.fieldConflicts.length === 0
        ? <p className="crwu-valuation-drawer-none">{zhCN.valuationDrawerNone}</p>
        : <ul className="crwu-valuation-drawer-conflicts">
          {intake.fieldConflicts.map((conflict) => <li key={conflict.label} data-valuation-field-conflict={conflict.label}>
            <span className="crwu-valuation-drawer-conflict-label">{conflict.label}</span>
            <ul>
              {conflict.values.map((one) => <li key={`${one.file}-${one.value}`}>
                <span className="crwu-valuation-drawer-conflict-source">{one.file}</span>
                <span className="crwu-valuation-drawer-conflict-value">{one.value}</span>
                {intake.fieldSources[conflict.label] === one.file
                  ? <span className="crwu-valuation-drawer-conflict-current">{zhCN.valuationDrawerConflictCurrent}</span>
                  : null}
              </li>)}
            </ul>
          </li>)}
        </ul>}
      {/* 用户补充要求是**用户提供**的事实，不是文件原文 —— 这一条要说在明处。 */}
      <h4>{zhCN.valuationDrawerPromptSource}</h4>
      <p className="crwu-valuation-drawer-note">{zhCN.valuationDrawerPromptSourceNote}</p>
      <h4>{zhCN.valuationDrawerMissing}</h4>
      {rows.filter((row) => row.missing).length === 0
        ? <p className="crwu-valuation-drawer-none">{zhCN.valuationDrawerNone}</p>
        : <ul className="crwu-valuation-drawer-missing">
          {rows.filter((row) => row.missing).map((row) => <li key={row.key}>{row.label}</li>)}
        </ul>}
    </section>

    <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationDrawerUnparsed}</h4>
      {intake.unparsed.length === 0
        ? <p className="crwu-valuation-drawer-none">{zhCN.valuationDrawerNone}</p>
        : <ul>{intake.unparsed.map((name) => <li key={name}>{name}</li>)}</ul>}
      <h4>{zhCN.valuationDrawerKnowledge}</h4>
      <p>{intake.knowledge.space}：{intake.knowledge.ready ? zhCN.valuationDrawerFileStatusParsed : zhCN.valuationDrawerFileStatusUnparsed}</p>
      {/* 逐条给出**路由 + 来源 + 版本信息**（更新时间与正文指纹）：规范用了哪一版要可追溯。 */}
      <ul className="crwu-valuation-drawer-knowledge">
        {intake.knowledge.sources.map((source) => <li key={source.route} data-valuation-knowledge-route={source.route}>
          <span className="crwu-valuation-drawer-knowledge-route">{source.route}</span>
          <span className="crwu-valuation-drawer-knowledge-meta">
            {source.source}
            {source.updatedAt === '' ? null : ` · ${zhCN.valuationDrawerUpdatedAt.replace('{at}', source.updatedAt)}`}
            {source.digest === '' ? null : ` · ${source.digest}`}
          </span>
        </li>)}
      </ul>
      {intake.knowledge.gaps.length === 0 ? null : <ul className="crwu-valuation-drawer-gaps">
        {intake.knowledge.gaps.map((gap) => <li key={gap}>{gap}</li>)}
      </ul>}
      <h4>{zhCN.valuationDrawerProviders}</h4>
      {/* 三行来源：**彼此独立**。某一家超时不影响另外两家的结论（§11.2）。 */}
      <ul className="crwu-valuation-drawer-providers">
        {intake.providers.map((provider) => {
          const live = props.providerStates?.[provider.id]
          const raw = live?.state ?? provider.state
          // 探测还在跑、而这一家还没有结论（`unknown`）时显示「检查中」——
          // 但**已经有结论**的那几家照常显示结论，一家超时不拖累另外两家。
          const checking = props.providerCheck === 'checking' && (raw === 'unknown' || raw === 'checking')
          const state = checking ? 'checking' : raw
          const detail = checking ? '' : (live?.detail ?? provider.detail)
          const needsLogin = state === 'unauthenticated'
          return <li key={provider.id} data-valuation-provider={provider.id} data-valuation-provider-state={state}>
            <span className="crwu-valuation-drawer-provider-name">{provider.label}</span>
            <Badge text={providerLabelOf(state, checking)} tone={providerTone(state, checking)} />
            {detail === '' ? null : <span className="crwu-valuation-drawer-provider-detail">{detail}</span>}
            {needsLogin && props.onOpenLogin !== undefined
              ? <button
                type="button"
                className="crwu-valuation-btn"
                onClick={() => { props.onOpenLogin?.(provider.id) }}
              >{zhCN.valuationProviderOpenLogin}</button>
              : null}
          </li>
        })}
      </ul>
      <h4>{zhCN.valuationDrawerBrowser}</h4>
      <p>{intake.providers
        .filter((item) => (props.providerStates?.[item.id]?.state ?? item.state) !== 'authenticated')
        .map((item) => item.label).join('、') || zhCN.valuationDrawerNone}</p>
      {/* 取证能力如实说：本部署没有页面截图能力时，"已登录"也不代表能留下截图证据。 */}
      <h4>{zhCN.valuationDrawerEvidence}</h4>
      <p>{zhCN.valuationDrawerEvidenceNote}</p>
    </section>

    <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationDrawerPromptFull}</h4>
      {/* 完整业务提示词：与执行时同一个构造器生成，可折叠查看（默认收起，避免盖住确认信息）。 */}
      {intake.prompt === ''
        ? <p className="crwu-valuation-drawer-none">{zhCN.valuationDrawerPromptUnavailable}</p>
        : <details className="crwu-valuation-drawer-prompt">
          <summary>{zhCN.valuationDrawerPromptShow}</summary>
          <pre data-valuation-prompt-full="true">{intake.prompt}</pre>
        </details>}
    </section>

    {(intake.capabilityGaps.length > 0 || intake.warnings.length > 0) ? <section className="crwu-valuation-drawer-section">
      <h4>{zhCN.valuationResultGaps}</h4>
      <ul className="crwu-valuation-drawer-gaps">
        {[...intake.capabilityGaps, ...intake.warnings].map((gap) => <li key={gap}>{gap}</li>)}
      </ul>
    </section> : null}

    <p className="crwu-valuation-drawer-digest">{zhCN.valuationDrawerDigest}：{intake.digest}</p>
  </SideDrawer>
}
