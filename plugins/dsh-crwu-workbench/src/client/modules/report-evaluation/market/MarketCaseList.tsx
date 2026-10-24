import * as React from 'react'
import type { TemplateMarketCandidate } from '../../../../shared/contracts/valuation-template-market.ts'
import { providerLabelOf, safeExternalUrl } from '../ui/workflow/model.ts'
import { ChevronDownIcon, ChevronRightIcon, InfoIcon } from '../../../ui/icons.tsx'

export interface MarketCaseListProps {
  candidates: TemplateMarketCandidate[]
  options: Array<{ value: string; label: string }>
  selected: string[]
  version: number
  disabled?: boolean
  onToggle: (caseId: string) => void
}

function factText(candidate: TemplateMarketCandidate, field: string, unit = ''): string {
  const fact = candidate.listFacts[field]
  if (fact === undefined || fact.value === null || fact.value === '') return `${field}待核`
  return `${String(fact.value)}${fact.unit || unit}`
}

function candidateArea(candidate: TemplateMarketCandidate): string {
  return factText(candidate, 'areaSqm', '㎡')
}

function candidatePrice(candidate: TemplateMarketCandidate): string {
  return factText(candidate, 'unitPrice', ' 元/㎡')
}

/**
 * Candidate rows. A recommendation is a label only; it never pre-checks a row.
 */
export function MarketCaseList(props: MarketCaseListProps): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState<string[]>([])
  if (props.options.length === 0) return <div className="mv-empty">当前候选表还没有可选案例。</div>
  return <div className="mv-case-list" data-market-candidate-version={props.version}>
    <div className="mv-case-caption"><span>候选案例（来自真实候选表）</span><span>{props.selected.length} 条已选 · {props.options.length} 条候选</span></div>
    {props.options.map((option) => {
      const candidate = props.candidates.find((item) => item.caseId === option.value)
      const checked = props.selected.includes(option.value)
      const open = expanded.includes(option.value)
      if (candidate === undefined) {
        return <div className="mv-case" key={option.value}>
          <label className="mv-case-main">
            <input type="checkbox" checked={checked} disabled={props.disabled} data-market-case={option.value}
              onChange={() => { props.onToggle(option.value) }} />
            <span className="mv-case-id">{option.value}</span>
            <span className="mv-case-body"><span className="mv-case-title">{option.label}</span>
              <span className="mv-case-note">候选项缺少可展示的案例事实，请重新生成候选表。</span></span>
          </label>
        </div>
      }
      const link = safeExternalUrl(candidate.sourceUrl) ?? undefined
      const recommended = candidate.status === 'eligible'
      return <div className={`mv-case ${checked ? 'checked' : ''} ${candidate.selectionState === 'excluded' ? 'excluded' : ''}`} key={option.value} data-market-case-row={option.value}>
        <div className="mv-case-main">
          <input type="checkbox" checked={checked} disabled={props.disabled} data-market-case={option.value}
            aria-label={`选择案例 ${option.value} ${option.label}`}
            onChange={() => { props.onToggle(option.value) }} />
          <span className="mv-case-id">{option.value}</span>
          <span className="mv-case-body">
            <span className="mv-case-title">{option.label}
              {candidate.listFacts.community?.value ? <span className="mv-case-area"> · {String(candidate.listFacts.community.value)}</span> : null}
              {recommended ? <span className="mv-tag rec">推荐</span> : null}
              {candidate.selectionState === 'excluded' ? <span className="mv-tag excluded">已排除</span> : null}
            </span>
            <span className="mv-case-meta">{candidateArea(candidate)} · {candidatePrice(candidate)} · {providerLabelOf(candidate.providerId)}</span>
            <span className="mv-case-note">{candidate.recommendation || candidate.differences[0] || '待核实可比性'}</span>
          </span>
          <button type="button" className="mv-case-expand" aria-expanded={open}
            aria-label={`${open ? '收起' : '展开'} ${option.value} 详情`}
            onClick={() => { setExpanded(open ? expanded.filter((id) => id !== option.value) : [...expanded, option.value]) }}>
            {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
        </div>
        {open
          ? <div className="mv-case-detail" id={`mv-case-${option.value}`}>
            <dl>
              <div><dt>来源</dt><dd>{providerLabelOf(candidate.providerId)}</dd></div>
              <div><dt>链接</dt><dd>{link === '' ? '链接缺失 · 待核' : <a href={link} target="_blank" rel="noreferrer">打开原始页面</a>}</dd></div>
              <div><dt>状态</dt><dd>{candidate.status === 'eligible' ? '初筛合格' : candidate.status === 'nearby' ? '相近待核' : candidate.status === 'rejected' ? '已排除' : '待核'}</dd></div>
            </dl>
            {candidate.similarities.length > 0 ? <p className="mv-case-reason"><strong>相似点 </strong>{candidate.similarities.join('；')}</p> : null}
            {candidate.differences.length > 0 ? <p className="mv-case-reason"><strong>差异 </strong>{candidate.differences.join('；')}</p> : null}
            {candidate.missingFields.length > 0 ? <p className="mv-case-reason"><strong>待核字段 </strong>{candidate.missingFields.join('、')}</p> : null}
            <p className="mv-case-reason"><InfoIcon size={12} /> 勾选只决定是否读取该案例详情；推荐不等于已选。</p>
          </div>
          : null}
      </div>
    })}
  </div>
}
