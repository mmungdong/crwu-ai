import * as React from 'react'
import type { TemplateMarketPlan } from '../../../../../shared/contracts/valuation-template-market.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import { providerLabelOf } from './model.ts'

export function MarketPlanSummary({ plan }: { plan: TemplateMarketPlan }): React.ReactElement {
  const budget = plan.budget
  return <section className={W.marketSummary} data-workflow-market-plan={plan.digest}>
    <h3 className={W.panelTitle}>本轮采集方案</h3>
    <dl className={W.planList}>
      <div className={W.planItem}><dt className={W.planLabel}>计算表</dt><dd className={W.planValue}>{plan.template.relativePath}</dd></div>
      <div className={W.planItem}><dt className={W.planLabel}>资料范围</dt><dd className={W.planValue}>{plan.filters.city} · {plan.filters.district} · {plan.filters.community}</dd></div>
      <div className={W.planItem}><dt className={W.planLabel}>案例性质</dt><dd className={W.planValue}>{plan.filters.propertyType} · {plan.priceBasis === 'listing' ? '挂牌价' : '成交价'}</dd></div>
      <div className={W.planItem}><dt className={W.planLabel}>面积范围</dt><dd className={W.planValue}>{plan.filters.areaMin ?? '未设下限'} 至 {plan.filters.areaMax ?? '未设上限'} ㎡</dd></div>
      <div className={W.planItem}><dt className={W.planLabel}>来源</dt><dd className={W.planValue}>{plan.providers.map(providerLabelOf).join('、')}</dd></div>
      <div className={W.planItem}><dt className={W.planLabel}>本轮预算</dt><dd className={W.planValue}>最多 {budget.maxPages ?? '待定'} 页、{budget.maxCandidates ?? '待定'} 条、{budget.maxDurationMs === null ? '待定' : Math.ceil(budget.maxDurationMs / 1000)} 秒</dd></div>
    </dl>
    <p className={W.hint}>先整理列表并生成候选案例表；选定案例后，再读取详情和截图。</p>
    {plan.stopRules.map((rule, index) => <p key={index} className={W.hint}>{rule}</p>)}
    {plan.proposedDispositions.map(d => <p className={W.stale} key={d.dispositionId}>
      待确认处置：{d.scope.fieldIds.map(id => plan.requirements.fields.find(f => f.fieldId === id)?.label ?? id).join('、')} · {d.reason}
      {d.assumption ? ` · 情景假设 ${String(d.assumption.value)} ${d.assumption.unit}` : ''}
    </p>)}
  </section>
}
