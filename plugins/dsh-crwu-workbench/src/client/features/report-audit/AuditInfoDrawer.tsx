import * as React from 'react'
import { Loading } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { formatDateTime } from './time.ts'
import {
  asRecord, bandsOf, compactJson, countsOf, decisionOf, detectedOf, hasField, hitOf, issuesOf,
  prettyJson, raisedUnresolvedOf, reviewStatusOf, textOf,
} from './audit-summary.ts'
import type { IssueView, RaisedView } from './audit-summary.ts'

/**
 * 「审核信息」的内容体。
 *
 * ## 它是什么（用户 2026-09-23 第二轮口径）
 *
 * **不是**「审核状态详情」，而是 **「AI 审核质量与问题摘要」**。信息优先级：
 *
 * ```
 * P0  复核命中率                    ← 第一视觉重点（32px/600），不做红黄绿评分色
 * P1  AI 检出问题数量                ← summary.counts.issuesTotal（缺字段才退回 issues.length）
 * P1  已提出但仍未整改               ← reviewItems.linkedIssueIds × inFileResolution===L-open
 * P2  AI 检出的具体问题（列表）        ← issues[]：title + gapAnalysis.difference，点开给位置与建议
 * P3  报告基础信息（默认折叠）
 * P4  技术详情（默认折叠）
 * ```
 *
 * 顶部**没有**「未通过 / 复核 · 已执行」大卡：审核结论与复核状态挪进折叠的「报告信息」。
 *
 * ## 三条不许越线的规则
 *
 * 1. **不重算算法**：命中率直接读 `reviewComparison.metrics`（只展示、不发明），完整口径原文进技术详情；
 *    AI 检出条数读 `counts.issuesTotal`，**不**从 severity 数量重新求和。
 * 2. **不发明语义**：程序枚举只有 `audit-summary.ts` 表头登记过的取值才翻中文；认不出的显示原值，
 *    且「已提未改」只在 `linkedIssueIds` 与 `L-open` **同时成立**时才算（见该文件的长注释）。
 * 3. **不生成描述**：问题标题/简述直接取审核 JSON 里已有的 `title` / `gapAnalysis.difference`，
 *    前端不调用模型、不写第二套描述。
 *
 * 完整证据链（规则出处、材料引文、知识库路径）**不进抽屉** —— 由「查看更多审核依据」回到完整审核报告。
 */

export interface AuditInfoDrawerProps {
  seqNo: string
  info: Record<string, unknown> | null
  error: string
  /** 打开完整审核报告（交付件 HTML）；不传则不显示那个入口。 */
  onOpenReport?: () => void
}

function classes(...all: Array<string | false | undefined>): string {
  return all.filter((one): one is string => typeof one === 'string' && one !== '').join(' ')
}

/** 一行「标签 / 原值」（技术详情）。 */
function TechRow(props: { label: string; value: string }): React.ReactElement | null {
  if (props.value === '') return null
  return <div className={C.techRow}>
    <span className={C.techKey}>{props.label}</span>
    <span className={C.techValue}>{props.value}</span>
  </div>
}

/** 严重程度：圆点 + 业务文案；认不出的取值只显示原值（不编中文）。 */
function Severity(props: { issue: IssueView }): React.ReactElement {
  const dot = props.issue.tone === 'high'
    ? C.riskDotHigh
    : (props.issue.tone === 'medium' ? C.riskDotMedium : C.riskDotLow)
  return <span className={C.issueSeverity}>
    <span className={classes(C.riskDot, dot)} aria-hidden={true} />
    {props.issue.severityLabel === '' ? props.issue.severity : props.issue.severityLabel}
  </span>
}

/** 问题详情里的一行（位置 / 建议 / 人工复核 / AI 检出）。 */
function Field(props: { label: string; value: string }): React.ReactElement | null {
  if (props.value === '') return null
  return <div className={C.issueField}>
    <span className={C.issueFieldLabel}>{props.label}</span>
    <span className={C.issueFieldValue}>{props.value}</span>
  </div>
}

export function AuditInfoDrawer(props: AuditInfoDrawerProps): React.ReactElement {
  const info = asRecord(props.info)
  const [openRaised, setOpenRaised] = React.useState(false)
  const [openOther, setOpenOther] = React.useState(false)
  const [openReport, setOpenReport] = React.useState(false)
  const [openTech, setOpenTech] = React.useState(false)
  // 一次只展开一条问题（与列表的 ••• 菜单同一套"列表层持有"思路，避免整页都是展开态）。
  const [openIssue, setOpenIssue] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  const summary = asRecord(info.summary)
  const review = asRecord(info.reviewComparison)
  const trace = asRecord(info.fileTrace)
  const rawCounts = asRecord(summary.counts)
  const rawBands = asRecord(review.bands)
  const metrics = asRecord(review.metrics)
  const rawReviewItems = Array.isArray(review.reviewItems) ? review.reviewItems : []

  const issues = issuesOf(info)
  const raised = raisedUnresolvedOf(info)
  const detected = detectedOf(info, issues)
  const hit = hitOf(metrics)
  const bands = bandsOf(rawBands)
  const counts = countsOf(rawCounts)
  const decision = decisionOf(textOf(summary.decision))
  const status = reviewStatusOf(textOf(review.status))

  const auditTime = textOf(info.auditTime)
  const generatedAt = textOf(trace.generatedAt)
  const reportVersion = textOf(info.reportVersion)
  const projectId = textOf(info.projectId)
  const stage = textOf(info.stage)
  const engineVersion = textOf(info.engineVersion)

  // AI 独立发现（bands.aiOnly）只作为 secondary：不新增第四个 KPI。
  const aiOnly = bands.find((band) => band.key === 'aiOnly')
  const restBands = bands.filter((band) => band.key !== 'aiOnly')

  /** 高/中/低小结（§25：降级成标题下的一条 secondary，不占一块）。 */
  const severityLine = counts.risks.length === 0
    ? ''
    : zhCN.auditIssueSummary
      .replace('%s', String(counts.risks.find((risk) => risk.key === 'high')?.value ?? 0))
      .replace('%s', String(counts.risks.find((risk) => risk.key === 'medium')?.value ?? 0))
      .replace('%s', String(counts.risks.find((risk) => risk.key === 'low')?.value ?? 0))

  const rawJson = prettyJson(props.info)

  const copyRaw = (): void => {
    const clipboard = (globalThis.navigator as { clipboard?: { writeText?: (text: string) => Promise<void> } } | undefined)?.clipboard
    if (typeof clipboard?.writeText !== 'function' || rawJson === '') return
    void clipboard.writeText(rawJson).then(() => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { setCopied(false) }, 1200)
    }).catch((cause: unknown) => {
      // 复制失败只是"没复制上"：不改状态、不弹错，用户再点一次即可。
      void cause
    })
  }

  return <div className={C.drawer}>
    {props.error === '' ? null : <div className={C.error}>{props.error}</div>}
    {props.info === null
      ? (props.error === '' ? <Loading text={zhCN.loadingAuditInfo} /> : null)
      : <>
        {/* ── P0/P1 核心指标：命中率最大，AI 检出与已提未改同级 ─────────────── */}
        <section className={C.km}>
          <div className={C.rateLabel}>{zhCN.auditHitRate}</div>
          <div className={C.rateValue}>{hit.rate === '' ? '—' : hit.rate}</div>
          {hit.count === '' ? null : <div className={C.rateMeta}>{hit.count}</div>}
          {hit.detail === '' ? null : <div className={C.rateMeta}>{hit.detail}</div>}
          <div className={C.kmRow}>
            <div>
              <div className={C.kmLabel}>{zhCN.auditDetected}</div>
              <div className={C.kmValue}>
                {detected.hasCount ? zhCN.auditCountUnit.replace('%s', String(detected.count)) : '—'}
              </div>
              {aiOnly === undefined ? null : <div className={C.kmHint}>
                {zhCN.auditDetectedAiOnly.replace('%s', String(aiOnly.value))}
              </div>}
            </div>
            <div>
              <div className={C.kmLabel}>{zhCN.auditRaised}</div>
              <div className={C.kmValue}>{zhCN.auditCountUnit.replace('%s', String(raised.length))}</div>
              <div className={C.kmHint}>{zhCN.auditRaisedHint}</div>
            </div>
          </div>
        </section>

        {/* ── P1 「已提出但仍未整改」：默认折叠（业务上最该看，但不必一直占地方）── */}
        {raised.length === 0 ? null : <div
          className={classes(C.raised, C.acc)}
          data-open={openRaised ? 'true' : 'false'}
        >
          <button
            type="button"
            className={C.raisedHead}
            aria-expanded={openRaised}
            onClick={() => { setOpenRaised(!openRaised) }}
          >
            <span className={C.issueMain}>
              <span className={C.raisedTitle}>{zhCN.auditRaisedTitle}</span>
              <span className={C.raisedSub}>{zhCN.auditRaisedSubtitle}</span>
            </span>
            <span className={C.raisedCount}>{String(raised.length)}</span>
            <span className={C.accChevron} aria-hidden={true}>›</span>
          </button>
          <div className={C.accBody}>
            <div className={C.accInner}>
              <div className={C.issueList}>
                {raised.map((item: RaisedView) => <div key={item.issueId} className={C.issueRow}>
                  <div className={C.issueDetail}>
                    <Severity issue={item} />
                    <div className={C.issueTitle}>{item.title}</div>
                    <Field label={zhCN.auditRaisedReviewer} value={item.reviewerQuote} />
                    <Field label={zhCN.auditRaisedAi} value={item.brief} />
                  </div>
                </div>)}
              </div>
            </div>
          </div>
        </div>}

        {/* ── P2 AI 检出的具体问题：抽屉的主内容 ─────────────────────────── */}
        <section className={C.sec}>
          <div className={C.secTitle}>
            {zhCN.auditSecIssues}{detected.hasCount ? `  ${String(detected.count)}` : ''}
          </div>
          {severityLine === '' ? null : <div className={C.summaryLine}>{severityLine}</div>}
          {issues.length === 0
            ? <div className={C.muted}>{zhCN.auditIssueEmpty}</div>
            : <div className={C.issueList}>
              {issues.map((issue) => {
                const open = issue.issueId !== '' && openIssue === issue.issueId
                return <div
                  key={issue.issueId === '' ? issue.title : issue.issueId}
                  className={classes(C.issueRow, C.acc)}
                  data-open={open ? 'true' : 'false'}
                >
                  <button
                    type="button"
                    className={C.issueHead}
                    aria-expanded={open}
                    onClick={() => { setOpenIssue(open ? '' : issue.issueId) }}
                  >
                    <span className={C.issueMain}>
                      <Severity issue={issue} />
                      <span className={C.issueTitle}>{issue.title}</span>
                      {issue.brief === '' ? null : <span className={C.issueBrief}>{issue.brief}</span>}
                    </span>
                    <span className={C.accChevron} aria-hidden={true}>›</span>
                  </button>
                  <div className={C.accBody}>
                    <div className={C.accInner}>
                      <div className={C.issueDetail}>
                        <Field label={zhCN.auditIssueLocation} value={issue.locationSummary} />
                        <Field label={zhCN.auditIssueSuggestion} value={issue.handlingRequirement} />
                        {props.onOpenReport === undefined ? null : <button
                          type="button"
                          className={C.issueLink}
                          onClick={props.onOpenReport}
                        >{zhCN.auditIssueMore} →</button>}
                      </div>
                    </div>
                  </div>
                </div>
              })}
              {/* 列表被上限截断时说明一句（不新增字段：拿总数与实到条数比）。 */}
              {!detected.hasCount || detected.count <= issues.length ? null : <div className={C.summaryLine}>
                {zhCN.auditIssueTruncated.replace('%s', String(issues.length))}
              </div>}
            </div>}
        </section>

        {/* ── 其他事项：待确认 / 未检查 / 三条带（降级，默认折叠）────────────── */}
        {counts.hasAux || restBands.length > 0 ? <div
          className={classes(C.fold, C.acc)}
          data-open={openOther ? 'true' : 'false'}
        >
          <button
            type="button"
            className={C.foldHead}
            aria-expanded={openOther}
            onClick={() => { setOpenOther(!openOther) }}
          >
            <span className={C.foldTitle}>{zhCN.auditSecOther}</span>
            <span className={C.accChevron} aria-hidden={true}>›</span>
          </button>
          <div className={C.accBody}>
            <div className={C.accInner}>
              {counts.hasPending ? <div className={C.summaryLine}>
                {zhCN.auditOtherPending.replace('%s', String(counts.pending))}
              </div> : null}
              {counts.hasNotChecked ? <div className={C.summaryLine}>
                {zhCN.auditOtherNotChecked.replace('%s', String(counts.notChecked))}
              </div> : null}
              {restBands.map((band) => <div key={band.key} className={C.summaryLine} title={band.full}>
                {`${band.label} ${String(band.value)}`}
              </div>)}
            </div>
          </div>
        </div> : null}

        {/* ── P3 报告信息（默认折叠；审核结论与复核状态按口径放在这里，不进第一屏）── */}
        <div className={classes(C.fold, C.acc)} data-open={openReport ? 'true' : 'false'}>
          <button
            type="button"
            className={C.foldHead}
            aria-expanded={openReport}
            onClick={() => { setOpenReport(!openReport) }}
          >
            <span className={C.foldTitle}>{zhCN.auditSecReport}</span>
            <span className={C.accChevron} aria-hidden={true}>›</span>
          </button>
          <div className={C.accBody}>
            <div className={C.accInner}>
              <div className={C.kv}>
                <div className={C.kvKey}>{zhCN.auditConclusion}</div>
                <div className={C.kvValue}>
                  {decision.label === '' ? (decision.raw === '' ? '—' : decision.raw) : decision.label}
                </div>
                {status.label === '' && status.raw === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditReviewStatusLabel}</div>
                  <div className={C.kvValue}>{status.label === '' ? status.raw : status.label}</div>
                </>}
                {projectId === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditFieldProjectId}</div>
                  <div className={C.kvValue}><span className={C.mono}>{projectId}</span></div>
                </>}
                {auditTime === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditFieldAuditTime}</div>
                  <div className={C.kvValue}>
                    <span className={C.mono} title={auditTime}>{formatDateTime(auditTime)}</span>
                  </div>
                </>}
                {stage === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditFieldStage}</div>
                  <div className={C.kvValue}>{stage}</div>
                </>}
                {reportVersion === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditFieldReportVersion}</div>
                  <div className={C.kvValue}><div className={C.infoValueWrap}>{reportVersion}</div></div>
                </>}
                {generatedAt === '' ? null : <>
                  <div className={C.kvKey}>{zhCN.auditFieldGeneratedAt}</div>
                  <div className={C.kvValue}>
                    <span className={C.mono} title={generatedAt}>{formatDateTime(generatedAt)}</span>
                  </div>
                </>}
              </div>
            </div>
          </div>
        </div>

        {/* ── P4 技术详情（默认折叠）─────────────────────────────────────── */}
        <div className={classes(C.fold, C.acc)} data-open={openTech ? 'true' : 'false'}>
          <button
            type="button"
            className={C.foldHead}
            aria-expanded={openTech}
            onClick={() => { setOpenTech(!openTech) }}
          >
            <span className={C.foldTitle}>{zhCN.auditSecTech}</span>
            <span className={C.accChevron} aria-hidden={true}>›</span>
          </button>
          <div className={C.accBody}>
            <div className={C.accInner}>
              <TechRow label={zhCN.auditTechDecision} value={decision.raw} />
              <TechRow label={zhCN.auditTechReviewStatus} value={status.raw} />
              <TechRow
                label={zhCN.auditTechHitRate}
                value={hasField(metrics, 'aiHitRate') ? textOf(metrics.aiHitRate) : ''}
              />
              <TechRow
                label={zhCN.auditTechCounts}
                value={Object.keys(rawCounts).length === 0 ? '' : compactJson(rawCounts)}
              />
              <TechRow
                label={zhCN.auditTechBands}
                value={Object.keys(rawBands).length === 0 ? '' : compactJson(rawBands)}
              />
              <TechRow
                label={zhCN.auditTechMetrics}
                value={Object.keys(metrics).length === 0 ? '' : compactJson(metrics)}
              />
              <TechRow
                label={zhCN.auditTechReviewItems}
                value={rawReviewItems.length === 0 ? '' : compactJson(rawReviewItems)}
              />
              <TechRow label={zhCN.auditTechEngine} value={engineVersion} />
              <TechRow label={zhCN.auditTechSchema} value={textOf(info.schemaVersion)} />
              <TechRow label={zhCN.auditTechRenderer} value={textOf(trace.rendererVersion)} />
              <TechRow label={zhCN.auditTechDigest} value={textOf(trace.sourceDigest)} />
              <TechRow label={zhCN.auditTechAuditTime} value={auditTime} />
              <TechRow label={zhCN.auditTechGeneratedAt} value={generatedAt} />
              <TechRow label={zhCN.auditTechSeqNo} value={props.seqNo} />
              {rawJson === '' ? null : <pre className={C.techJson}>{rawJson}</pre>}
              {rawJson === '' ? null : <button type="button" className={C.techCopy} onClick={copyRaw}>
                {copied ? zhCN.auditTechCopied : zhCN.auditTechCopy}
              </button>}
              <div className={C.techHint}>{zhCN.auditTechHint}</div>
            </div>
          </div>
        </div>
      </>}
  </div>
}
