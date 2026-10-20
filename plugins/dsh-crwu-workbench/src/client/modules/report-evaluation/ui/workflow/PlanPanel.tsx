import * as React from 'react'
import { Button } from '../../../../ui/components/index.ts'
import type {
  ValuationWorkflowPlan,
  ValuationWorkflowPlanSource,
  ValuationWorkflowPlanTemplate,
} from '../../../../../shared/contracts/valuation-workflow.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import {
  algorithmLabelOf,
  areaTextOf,
  modeLabelOf,
  planMethodLabelOf,
  providerLabelOf,
  safeExternalUrl,
  sourceStateLabelOf,
  transactionTypeLabelOf,
  unitPriceTextOf,
} from './model.ts'

export interface PlanApprovalInput {
  expectedRevision: number
  planDigest: string
}

export interface PlanPanelProps {
  plan: ValuationWorkflowPlan
  progressRevision: number
  busy: boolean
  onApprovePlan?: (input: PlanApprovalInput) => void
  onOpenArtifact?: (kind: string) => void
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function SourceRow(props: { source: ValuationWorkflowPlanSource }): React.ReactElement {
  const { source } = props
  const fields = source.fields ?? { unitPrice: null, areaSqm: null }
  const provider = providerLabelOf(source.providerId)
  const link = safeExternalUrl(source.detailUrl)
  const stateLabel = sourceStateLabelOf(source.state)
  const natureLabel = transactionTypeLabelOf(source.transactionType)
  return <li className={W.planSource} data-workflow-plan-source={source.providerId}>
    <div className={W.planSourceHead}>
      <span className={W.planSourceName}>{source.community}</span>
      {provider === '' ? null : <span className={W.badge} data-workflow-plan-provider={source.providerId}>{provider}</span>}
      {stateLabel === '' ? null : <span className={W.badge}>{stateLabel}</span>}
      {natureLabel === '' ? null : <span className={W.badge}>{natureLabel}</span>}
    </div>
    <dl className={W.planList}>
      <div className={W.planItem}>
        <dt className={W.planLabel}>挂牌单价</dt>
        <dd className={W.planValue}>{unitPriceTextOf(fields.unitPrice)}</dd>
      </div>
      <div className={W.planItem}>
        <dt className={W.planLabel}>建筑面积</dt>
        <dd className={W.planValue}>{areaTextOf(fields.areaSqm)}</dd>
      </div>
      <div className={W.planItem}>
        <dt className={W.planLabel}>详情地址</dt>
        <dd className={W.planValue}>
          {link === null
            ? <span className={W.planValue} data-workflow-plan-source-url="true">{source.detailUrl}</span>
            : <a className={W.planLink} href={link} target="_blank" rel="noopener noreferrer"
              data-workflow-plan-source-url="true">{source.detailUrl}</a>}
        </dd>
      </div>
      {source.evidence === '' ? null : <div className={W.planItem}>
        <dt className={W.planLabel}>取证依据</dt>
        <dd className={W.planValue}>{source.evidence}</dd>
      </div>}
      {typeof source.reason === 'string' && source.reason !== '' ? <div className={W.planItem}>
        <dt className={W.planLabel}>失败原因</dt>
        <dd className={W.planValue}>{source.reason}</dd>
      </div> : null}
    </dl>
  </li>
}

/**
 * The immutable Host plan receipt shown before data acquisition. Every fact here
 * comes from the Host; the two actions only open the verified table or submit the
 * displayed plan identity.
 */
export function PlanPanel(props: PlanPanelProps): React.ReactElement {
  const { plan } = props
  const template: ValuationWorkflowPlanTemplate | undefined = plan.template
  const sources = Array.isArray(plan.sources) ? plan.sources : []
  const basis = Array.isArray(plan.basis) ? plan.basis : []
  const limitations = Array.isArray(plan.limitations) ? plan.limitations : []
  const gaps = Array.isArray(plan.gaps) ? plan.gaps : []
  const mapping = template !== undefined && Array.isArray(template.mapping) ? template.mapping : []
  const formulaChecks = template !== undefined && Array.isArray(template.formulaChecks) ? template.formulaChecks : []
  const revisionMatches = plan.revision === props.progressRevision
  const canOpenTemplate = template !== undefined && template.verified === true && typeof props.onOpenArtifact === 'function'
  const canApprove = plan.ready === true
    && plan.accepted !== true
    && revisionMatches
    && props.busy !== true
    && typeof props.onApprovePlan === 'function'

  return <section className={W.planPanel} data-workflow-plan="true"
    data-workflow-plan-revision={String(plan.revision)}
    data-workflow-plan-ready={String(plan.ready)}
    data-workflow-plan-accepted={String(plan.accepted)}>
    <h3 className={W.panelTitle}>评估方案</h3>
    <div className={W.planMeta}>
      <span className={W.badge} data-workflow-plan-mode={plan.valuationMode}>{modeLabelOf(plan.valuationMode)}</span>
      <span className={W.badge} data-workflow-plan-method={plan.method}>方法 {planMethodLabelOf(plan.method)}</span>
      <span className={W.badge} data-workflow-plan-algorithm={plan.algorithm}>算法 {algorithmLabelOf(plan.algorithm)}</span>
      <span className={W.badge}>{plan.ready ? '方案已就绪' : '方案待完善'}</span>
      <span className={W.badge}>{plan.accepted ? '已确认' : '待确认'}</span>
    </div>
    <details className={W.rawDetails}>
      <summary>技术标识</summary>
      <p className={W.mono}>方法 {plan.method} · 算法 {plan.algorithm}</p>
    </details>

    <h4 className={W.blockTitle}>实测来源</h4>
    {sources.length === 0
      ? <p className={W.hint}>Host 尚未提供可比来源。</p>
      : <ul className={W.planSources}>
        {sources.map((source) => <SourceRow key={source.providerId} source={source} />)}
      </ul>}

    {template === undefined
      ? null
      : <div className={W.planTemplate} data-workflow-plan-template="true" data-workflow-plan-template-verified={String(template.verified)}>
        <h4 className={W.blockTitle}>计算表</h4>
        <p className={W.planValue} data-workflow-plan-template-file="true">{template.fileName}</p>
        <p className={W.hint}>{template.relativePath}</p>
        <p className={W.hint}>摘要 {template.digest} · {template.verified ? '已校验' : '未校验'}</p>
        <h4 className={W.blockTitle}>字段映射</h4>
        <ul className={W.planList}>
          {mapping.map((item) => <li className={W.planItem} key={`${item.field}:${item.sheet}:${item.range}`}>
            <span className={W.planLabel}>{item.field}</span>
            <span className={W.planValue}>{item.sheet} · {item.range}</span>
          </li>)}
        </ul>
        <h4 className={W.blockTitle}>公式试算</h4>
        <ul className={W.planList}>
          {formulaChecks.map((check) => <li className={W.planItem} key={check.name}>
            <span className={W.planLabel}>{check.name}</span>
            <span className={W.planValue}>{check.ok ? '通过' : '未通过'}</span>
          </li>)}
        </ul>
      </div>}

    <h4 className={W.blockTitle}>采用依据</h4>
    <ul className={W.planList}>
      {basis.map((item, index) => <li className={W.planItem} key={`${text(item.sourceId)}:${String(index)}`}>
        <span className={W.planValue}>{text(item.quote)}</span>
      </li>)}
    </ul>

    {limitations.length === 0 ? null : <div className={W.block}>
      <h4 className={W.blockTitle}>限制说明</h4>
      <ul className={W.planList}>
        {limitations.map((item) => <li className={W.planItem} key={item}><span className={W.planValue}>{item}</span></li>)}
      </ul>
    </div>}

    {gaps.length === 0 ? null : <div className={W.block}>
      <h4 className={W.blockTitle}>缺口</h4>
      <ul className={W.planList}>
        {gaps.map((item) => <li className={W.planItem} key={item}><span className={W.planValue}>{item}</span></li>)}
      </ul>
    </div>}

    <div className={W.planActions}>
      {canOpenTemplate
        ? <Button variant="secondary" size="sm" data-workflow-open-template="true"
          onClick={() => { props.onOpenArtifact?.('template') }}>打开计算表</Button>
        : null}
      <button
        type="button"
        className={`${W.confirm} crwu-ui-btn crwu-ui-btn-primary crwu-ui-btn-sm`}
        data-workflow-plan-confirm="true"
        disabled={!canApprove}
        onClick={() => {
          if (!canApprove || plan.accepted === true) return
          props.onApprovePlan?.({ expectedRevision: plan.revision, planDigest: plan.digest })
        }}
      >确认方案并开始取证</button>
    </div>
    {revisionMatches ? null : <p className={W.stale}>方案版本与当前进度不一致，请刷新后按最新版本确认。</p>}
  </section>
}
