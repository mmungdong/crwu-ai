import * as React from 'react'
import type { TemplateMarketCandidate } from '../../../../../shared/contracts/valuation-template-market.ts'
import { VALUATION_WORKFLOW_CLASSES as W } from '../../styles/workflow.ts'
import { providerLabelOf, safeExternalUrl } from './model.ts'

export function CandidateSelection(props: {
  candidates: TemplateMarketCandidate[]; version: number; selected: string[]; disabled?: boolean
  options: Array<{ value: string; label: string }>; onToggle: (id: string) => void
}): React.ReactElement {
  return <div className={W.candidates} data-workflow-candidate-version={props.version}>
    <p className={W.hint}>候选表版本 {props.version} · 推荐项需由你勾选确认</p>
    {props.options.map(option => {
      const candidate = props.candidates.find(c => c.caseId === option.value)
      return <article key={option.value} className={W.candidate} data-workflow-candidate={option.value}>
        <label className={W.answerOption}><input type="checkbox" value={option.value} checked={props.selected.includes(option.value)}
          disabled={props.disabled} data-workflow-choice={option.value} onChange={() => props.onToggle(option.value)} />{option.label}</label>
        {candidate ? <>
          <p className={W.hint}>{providerLabelOf(candidate.providerId)} · {candidate.listFacts.areaSqm?.value ?? '面积待核'}{candidate.listFacts.areaSqm?.unit ?? ''}
            {' · '}{candidate.listFacts.unitPrice?.value ?? '单价待核'}{candidate.listFacts.unitPrice?.unit ?? ''}</p>
          {safeExternalUrl(candidate.sourceUrl) ? <a className={W.planLink} href={candidate.sourceUrl} target="_blank" rel="noreferrer">查看房源网页</a> : null}
          <p className={W.hint}>{candidate.recommendation}</p>
          {candidate.similarities.length ? <p className={W.hint}>相似点：{candidate.similarities.join('；')}</p> : null}
          {candidate.differences.length ? <p className={W.hint}>差异：{candidate.differences.join('；')}</p> : null}
          {candidate.missingFields.length ? <p className={W.stale}>待核：{candidate.missingFields.join('、')}</p> : null}
        </> : null}
      </article>
    })}
  </div>
}
