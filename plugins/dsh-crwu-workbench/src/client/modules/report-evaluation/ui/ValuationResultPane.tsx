import * as React from 'react'
import { Card } from '../../../ui/primitives.tsx'
import { Badge } from '../../../ui/primitives.tsx'
import { zhCN } from '../../../locales/zh-CN.ts'
import {
  artifactsComplete,
  caseBuckets,
  caseSourceSummary,
  evidenceIncomplete,
  ruleCheckSummary,
  type ValuationPageState,
  type ValuationResultView,
} from '../model/valuation-state.ts'

/**
 * 结果页。
 *
 * ## 显示的是**结论 + 案例处置**，不是全部数据
 *
 * 方案要求"结果页面展示候选、保留、剔除和失败原因"。所以案例分两桶显示：
 * 可直接作可比实例的（成交）与需要修正的（挂牌 / 询价 / 未知）—— 后者必须带上剔除或保留理由，
 * 否则用户看不出"这条为什么没算进去"。
 *
 * ## 拿不到的数字显示 `—`，不显示 0
 *
 * `0` 是一个**结论**（"值零元"），而"没算出来"是另一件事。两者混同会误导复核。
 */

export interface ValuationResultPaneProps {
  state: ValuationPageState
  onOpenArtifact: (name: string) => void
  onCancel: () => void
}

/** 方法的人话（§7.2 的方法词表；认不出来就把原样写出来，不猜）。 */
function methodLabel(method: string): string {
  if (method === 'market') return zhCN.valuationMethodMarket
  if (method === 'income') return zhCN.valuationMethodIncome
  if (method === 'cost') return zhCN.valuationMethodCost
  if (method === 'auto') return zhCN.valuationMethodAuto
  return method
}

/** 案例状态的人话（§8 的六态；认不出来就说"未记录"，不猜）。 */
function caseStatusLabel(status: string): string {
  if (status === 'adopted') return zhCN.valuationCaseStatusAdopted
  if (status === 'not-comparable') return zhCN.valuationCaseStatusNotComparable
  if (status === 'insufficient-evidence') return zhCN.valuationCaseStatusInsufficientEvidence
  if (status === 'single-rule-failed') return zhCN.valuationCaseStatusSingleFailed
  if (status === 'combined-rule-failed') return zhCN.valuationCaseStatusCombinedFailed
  if (status === 'group-consistency-failed') return zhCN.valuationCaseStatusGroupFailed
  return zhCN.valuationResultUnknown
}

/** 联系方式状态的人话（认不出来就是"未记录"，**不猜**成已公开）。 */
function contactLabel(state: string): string {
  if (state === 'public') return zhCN.valuationContactPublic
  if (state === 'not-published') return zhCN.valuationContactNotPublished
  if (state === 'masked') return zhCN.valuationContactMasked
  if (state === 'login-required') return zhCN.valuationContactLoginRequired
  if (state === 'failed') return zhCN.valuationContactFailed
  return zhCN.valuationContactUnrecorded
}

/**
 * 联系方式单元格：机构 / 联系人 + **原样**号码 + 状态。
 *
 * 号码按页面展示的形态原样写出（脱敏就写脱敏）；这里**没有**任何拨号 / 发消息入口 ——
 * 只登记公开信息（§7.5）。
 */
function ContactCell(props: { contact: ValuationResultView['cases'][number]['contact'] }): React.ReactElement {
  const { contact } = props
  const who = [contact.agency, contact.person].filter((item) => item !== '').join(' · ')
  return <span className="crwu-valuation-case-contact" data-valuation-contact-state={contact.state}>
    {who === '' ? null : <span className="crwu-valuation-case-contact-who">{who}</span>}
    {contact.phone === ''
      ? null
      : <span className="crwu-valuation-case-contact-phone" data-valuation-contact-phone="raw">{contact.phone}</span>}
    <span className="crwu-valuation-contact-state">{contactLabel(contact.state)}</span>
    {contact.detail === '' ? null : <span className="crwu-valuation-hint">{contact.detail}</span>}
  </span>
}

function amountText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return zhCN.valuationResultUnknown
  return value.toLocaleString('zh-CN')
}

/**
 * 案例表。
 *
 * `collapsible` 给"剔除案例与原因"用（§9 第 6 条：可折叠）：它们是过程留痕，
 * 默认收起来，但**不删**——"这条为什么没算进去"必须查得到。
 */
function CaseTable(props: {
  title: string
  cases: ValuationResultView['cases']
  collapsible?: boolean
}): React.ReactElement {
  if (props.cases.length === 0) {
    return <div className="crwu-valuation-case-group">
      <h4>{props.title}</h4>
      <p className="crwu-valuation-empty">{zhCN.valuationResultNoCases}</p>
    </div>
  }
  const table = <table className="crwu-valuation-cases">
    <thead><tr>
      <th>{zhCN.valuationResultSource}</th>
      <th>{zhCN.valuationFieldCases}</th>
      <th>{zhCN.valuationFieldArea}</th>
      <th>{zhCN.valuationResultUnitPrice}</th>
      <th>{zhCN.valuationResultTransaction}</th>
      <th>{zhCN.valuationResultCaseStatus}</th>
      <th>{zhCN.valuationResultEvidence}</th>
      <th>{zhCN.valuationResultScreenshot}</th>
      <th>{zhCN.valuationResultContact}</th>
      <th>{zhCN.valuationResultReason}</th>
    </tr></thead>
    <tbody>
      {props.cases.map((item, index) => <tr key={`${item.url}-${String(index)}`}>
        <td data-valuation-case-source={item.source}>{item.sourceLabel || item.source || zhCN.valuationResultUnknown}</td>
        <td>
          <span className="crwu-valuation-case-title">{item.title || item.community || item.url}</span>
          <span className="crwu-valuation-hint">{item.url}</span>
          {item.capturedAt === '' ? null : <span className="crwu-valuation-hint">
            {zhCN.valuationResultCapturedAt.replace('{at}', item.capturedAt)}
          </span>}
        </td>
        <td>{item.buildingArea === null ? zhCN.valuationResultUnknown : String(item.buildingArea)}</td>
        <td>{amountText(item.unitPrice)}</td>
        <td>{item.transactionType}</td>
        <td data-valuation-case-status={item.status}>{caseStatusLabel(item.status)}</td>
        {/* 证据：给出文件相对路径；明确没留存的**如实说没留存**（不画一个空单元格）。 */}
        <td>{item.evidence !== ''
          ? <span className="crwu-valuation-case-evidence">{item.evidence}</span>
          : <span className="crwu-valuation-case-no-evidence">
            {item.evidenceMissing ? zhCN.valuationResultEvidenceMissing : zhCN.valuationResultUnknown}
          </span>}</td>
        {/* 截图单独一列（§7.4）：**不用页面证据顶替**。没有截图能力时如实写"没有截图"，
            而不是留空让人以为"有证据就等于有截图"。 */}
        <td data-valuation-case-screenshot={item.screenshot === '' ? '' : item.screenshot}>
          {item.screenshot !== ''
            ? <span className="crwu-valuation-case-evidence" title={item.screenshotDigest}>
              {item.screenshot}
            </span>
            : <span className="crwu-valuation-case-no-evidence">
              {item.screenshotMissing ? zhCN.valuationResultScreenshotMissing : zhCN.valuationResultUnknown}
            </span>}
        </td>
        <td><ContactCell contact={item.contact} /></td>
        <td>{item.keepReason || item.dropReason || zhCN.valuationResultUnknown}</td>
      </tr>)}
    </tbody>
  </table>
  if (props.collapsible !== true) {
    return <div className="crwu-valuation-case-group">
      <h4>{props.title}</h4>
      {table}
    </div>
  }
  return <details className="crwu-valuation-case-group" data-valuation-dropped-cases="true">
    <summary>{props.title}（{props.cases.length}）</summary>
    {table}
  </details>
}

export function ValuationResultPane(props: ValuationResultPaneProps): React.ReactElement {
  const { state } = props
  const result = state.result
  if (result === null) {
    return <Card title={zhCN.valuationResultTitle}>
      <p className="crwu-valuation-empty">{zhCN.valuationPhaseQueued}</p>
    </Card>
  }
  const buckets = caseBuckets(result.cases)
  const summary = ruleCheckSummary(result.cases)
  // 旧宿主 / 测试夹具可能没有这两个字段：缺就是"没有冲突、没有筛选记录"，不当成错误。
  const conflict = result.methodConflict ?? null
  const screening = result.methodScreening ?? []
  const bySource = caseSourceSummary(result.cases)
  // 「部分结果」（§4）：阶段不是 `completed` 时，这份结果只是**阶段产出** ——
  // 不制造"已给出正式结论"的观感，并且明确说它可以被接着补。
  const partial = state.phase !== 'completed'

  return <div className="crwu-valuation-result">
    {partial
      ? <div className="crwu-valuation-partial" role="status" data-valuation-partial="true">
        <strong>{zhCN.valuationPartialTitle}</strong>
        <p>{zhCN.valuationPartialLead}</p>
        {state.failedStage === ''
          ? null
          : <p>{zhCN.valuationPartialStage.replace('{stage}', state.failedStage)}</p>}
      </div>
      : null}
    <Card title={partial ? `${zhCN.valuationResultTitle} · ${zhCN.valuationPartialTag}` : zhCN.valuationResultTitle}>
      {/* 证据不完整时**先**说一句：不能用大号数字制造"已给出正式结论"的观感（§9）。
          它不是"失败"，所以是提示而不是错误 —— 结论照样显示，但读者知道要打折扣看。 */}
      {/* **方法冲突**（§7.2）：用户指定的方法与结论不一致。它必须比结论更显眼 ——
          用户选的是收益法、结果是市场法，而界面上什么都不说的话就是静默切换。 */}
      {conflict === null
        ? null
        : <div className="crwu-valuation-method-conflict" role="alert" data-valuation-method-conflict="true">
          <strong>{zhCN.valuationResultMethodConflictTitle}</strong>
          <p>{zhCN.valuationResultMethodConflictLead
            .replace('{user}', methodLabel(conflict.userMethod))
            .replace('{adopted}', methodLabel(conflict.adoptedMethod))}</p>
          <p>{conflict.reason}</p>
        </div>}

      {evidenceIncomplete(result)
        ? <div className="crwu-valuation-incomplete" role="status" data-valuation-evidence-incomplete="true">
          <strong>{zhCN.valuationResultIncompleteTitle}</strong>
          <p>{zhCN.valuationResultIncompleteLead}</p>
        </div>
        : null}
      {/* 第一屏就是结论，顺序按用户口径：总价值 → 单价 → 采用方法 → 基准日 → 案例数量。
          「待确认事项 / 能力缺口」各自成块跟在下面（它们是"要用这份结论的人必须先看的两件事"）。 */}
      <dl className="crwu-valuation-summary">
        {/* 单价 / 总价旁边紧挨着**计价面积与计价单位**（§9 第 1 条）：只给一个数字、
            不说按多少面积算的，读的人没法复核。 */}
        <dt>{zhCN.valuationResultTotalValue}</dt><dd>{amountText(result.totalValue)}</dd>
        <dt>{zhCN.valuationResultUnitPrice}</dt>
        <dd>
          {amountText(result.unitPrice)}
          {result.priceUnit === '' ? null : <span className="crwu-valuation-price-unit">{result.priceUnit}</span>}
        </dd>
        <dt>{zhCN.valuationResultPricingArea}</dt>
        <dd>{result.pricingArea === null ? zhCN.valuationResultUnknown : `${result.pricingArea.toLocaleString('zh-CN')} ㎡`}</dd>
        <dt>{zhCN.valuationResultMethod}</dt><dd>{result.method}</dd>
        <dt>{zhCN.valuationResultBaseDate}</dt>
        <dd>{result.baseDate === '' ? zhCN.valuationResultNoBaseDate : result.baseDate}</dd>
        <dt>{zhCN.valuationResultCaseCount}</dt>
        <dd>{zhCN.valuationResultCaseCountValue
          .replace('{total}', String(result.cases.length))
          .replace('{comparable}', String(buckets.comparable.length))
          .replace('{listed}', String(buckets.listed.length))}</dd>
      </dl>
      {result.methodReason === '' ? null : <p className="crwu-valuation-hint">{result.methodReason}</p>}
      {/* 方法判断记录：不只说"用了哪个"，还要能看出"其他方法为什么不采用"（§7.2）。 */}
      {screening.length === 0 ? null : <ul className="crwu-valuation-method-screening">
        {screening.map((item) => <li key={item.method} data-valuation-method-screening={item.method}>
          <span className="crwu-valuation-method-name">{methodLabel(item.method)}</span>
          <Badge
            text={item.verdict === 'adopted' ? zhCN.valuationResultMethodAdopted : zhCN.valuationResultMethodNotAdopted}
            tone={item.verdict === 'adopted' ? 'ok' : 'low'}
          />
          <span className="crwu-valuation-method-reason">{item.reason}</span>
        </li>)}
      </ul>}
    </Card>

    <Card title={zhCN.valuationResultArtifacts}>
      <ul className="crwu-valuation-artifacts">
        {([['估值报告.html', result.artifacts.html], ['估值底稿.xlsx', result.artifacts.xlsx], ['估值结果.json', result.artifacts.json]] as const)
          .map(([name, exists]) => <li key={name}>
            <span>{name}</span>
            {exists
              ? <button type="button" className="crwu-valuation-btn" onClick={() => { props.onOpenArtifact(name) }}>
                {zhCN.valuationResultOpen}
              </button>
              : <span className="crwu-valuation-hint">{zhCN.valuationResultMissingArtifact}</span>}
          </li>)}
      </ul>
      {artifactsComplete(result.artifacts) ? null : <p className="crwu-valuation-error">
        {zhCN.valuationResultMissingArtifact}
      </p>}
    </Card>

    {/* 规则校验摘要（§9 第 3 条）：读者要一眼看到"这三条案例按哪几条规则查过、有没有没过的"。 */}
    <Card title={zhCN.valuationResultRuleChecks}>
      <dl className="crwu-valuation-summary">
        <dt>{zhCN.valuationResultAdoptedCount}</dt>
        <dd data-valuation-adopted-count={String(summary.adopted)}>
          {zhCN.valuationResultCaseCountValue
            .replace('{total}', String(summary.total))
            .replace('{comparable}', String(summary.adopted))
            .replace('{listed}', String(summary.total - summary.adopted))}
        </dd>
        <dt>{zhCN.valuationResultGroupRatio}</dt>
        <dd data-valuation-group-ratio={summary.groupRatio === null ? '' : String(summary.groupRatio)}
          data-valuation-group-over={summary.groupOverLimit ? 'true' : 'false'}>
          {summary.groupRatio === null ? zhCN.valuationResultUnknown : summary.groupRatio.toFixed(4)}
          <span className="crwu-valuation-price-unit">
            {zhCN.valuationResultLimitIs.replace('{limit}', '1.2')}
          </span>
          {summary.groupOverLimit
            ? <span className="crwu-valuation-case-no-evidence">{zhCN.valuationResultGroupOver}</span>
            : null}
        </dd>
      </dl>
      {/* 最终采用案例的**来源分布**（§9 第 3 条）：只给总数看不出"结论压在几个站点上"。 */}
      {bySource.length === 0 ? null : <ul className="crwu-valuation-source-summary">
        {bySource.map((row) => <li key={row.source || row.label} data-valuation-case-source-summary={row.source || row.label}>
          <span className="crwu-valuation-rule-id">{row.label}</span>
          <span className="crwu-valuation-rule-counts">
            {zhCN.valuationResultSourceCounts
              .replace('{total}', String(row.total))
              .replace('{adopted}', String(row.adopted))}
          </span>
        </li>)}
      </ul>}
      <ul className="crwu-valuation-rule-checks">
        {summary.rows.map((row) => <li key={row.ruleId} data-valuation-rule-check={row.ruleId}>
          <span className="crwu-valuation-rule-id">{row.ruleId}</span>
          <span className="crwu-valuation-rule-counts">
            {zhCN.valuationResultRuleCounts
              .replace('{passed}', String(row.passed))
              .replace('{failed}', String(row.failed))}
          </span>
          {row.thresholds.length === 0
            ? null
            : <span className="crwu-valuation-rule-limit">
              {zhCN.valuationResultLimitIs.replace('{limit}', row.thresholds.map((item) => String(item)).join(' / '))}
            </span>}
        </li>)}
      </ul>
    </Card>

    <Card title={zhCN.valuationResultCases}>
      <CaseTable title={zhCN.valuationResultComparable} cases={buckets.comparable} />
      {/* 剔除 / 需修正的案例：**可折叠**（§9 第 6 条），但全都在，不删。 */}
      <CaseTable title={zhCN.valuationResultListed} cases={buckets.listed} collapsible />
    </Card>

    {result.manualConfirmationItems.length === 0 ? null : <Card title={zhCN.valuationResultManual}>
      <ul>{result.manualConfirmationItems.map((item) => <li key={item}>{item}</li>)}</ul>
    </Card>}

    {/* 公开中介联系方式汇总：**只展示**，不提供任何联系入口（§7.5：不得自动联系、拨号或发送消息）。 */}
    <Card title={zhCN.valuationResultContacts}>
      <p className="crwu-valuation-hint">{zhCN.valuationResultContactsNote}</p>
      <ul className="crwu-valuation-contacts">
        {result.cases.map((item, index) => <li key={`${item.url}-contact-${String(index)}`}
          data-valuation-contact-row={item.contact.state}>
          <span className="crwu-valuation-case-title">{item.community || item.title || item.url}</span>
          <ContactCell contact={item.contact} />
        </li>)}
      </ul>
    </Card>

    {result.capabilityGaps.length === 0 ? null : <Card title={zhCN.valuationResultGaps}>
      <ul className="crwu-valuation-gaps">{result.capabilityGaps.map((item) => <li key={item}>{item}</li>)}</ul>
    </Card>}

    <div className="crwu-valuation-actions">
      <button type="button" className="crwu-valuation-btn" onClick={props.onCancel}>{zhCN.valuationResultCancel}</button>
    </div>
  </div>
}
