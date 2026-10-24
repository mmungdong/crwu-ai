import * as React from 'react'
import type { AdoptedCase, CaseView, ExperienceState, FieldView, PlanConditions, PlanView, WorkflowStep } from '../model.ts'
import {
  CHECK_KEYS,
  CHECK_LABELS,
  FIELD_GROUPS,
  WORKFLOW_STEPS,
  activeConflict,
  adoptedCaseOf,
  asArray,
  caseMissing,
  caseStatusLabel,
  countPending,
  fieldTagsOf,
  formatSize,
  fullLocation,
  includedRows,
  materialStats,
  materialRows,
  missingRequired,
  missingRequiredFor,
  navStateFor,
  planStatusOf,
  planValidConfirmed,
  providerLabelOf,
  record,
  text,
  typeLabelOf,
} from '../model.ts'
import type { ValuationExperienceController } from '../controller.ts'
import {
  AlertIcon, ArrowRight, CheckIcon, ChevronDown, ChevronLeft, ChevronRight, ClockIcon, DownloadIcon,
  EditIcon, FileIcon, FolderIcon, InfoIcon, LockIcon, MinusIcon, PanelIcon, PlusIcon, RefreshIcon,
  ScaleIcon, SearchIcon, ShieldIcon, StampIcon, XIcon,
} from './icons.tsx'
import { EmptyState, Modal, SheetHost, Toast } from './shell.tsx'

const TEMPLATE_CASE_FIELDS: ReadonlyArray<{ label: string; reason: string; next: string; stage: 'list' | 'detail' }> = [
  { label: '建筑面积', reason: '用于判断是否落在方案面积范围', next: '检索初筛', stage: 'list' },
  { label: '房屋用途', reason: '用途不一致的挂牌不进入候选', next: '检索初筛', stage: 'list' },
  { label: '所在楼层', reason: '楼层差异影响可比性，列表阶段先记录', next: '检索初筛', stage: 'list' },
  { label: '建成年份', reason: '列表阶段先按小区/年代粗筛，选中案例后在详情页补核', next: '详情核对', stage: 'detail' },
  { label: '权利性质', reason: '权利性质需与对象可比，缺失则标记待核', next: '详情核对', stage: 'detail' },
  { label: '挂牌信息', reason: '挂牌日期与挂牌价仅作背景资料，不能当作成交价', next: '资料留存', stage: 'list' },
]

export function WorkspaceExperience(props: {
  state: ExperienceState
  controller: ValuationExperienceController
  onBackOverview: () => void
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const { state, controller, onBackOverview } = props
  const step = state.workspaceStep
  return <div className="ve-workspace" data-workflow-step="valuation" data-workspace-mode={state.mode}>
    <WorkspaceTop state={state} controller={controller} onBackOverview={onBackOverview} onOpenSession={props.onOpenSession} />
    <div className="ve-shell">
      <WorkspaceRail state={state} controller={controller} />
      <main className="ve-center" id="ve-center">
        <div className="ve-page">
          {state.error === '' && state.host.error === ''
            ? null
            : <div className="ve-banner is-warn" role="alert" data-workspace-error="true"><AlertIcon size={15} /><span>{state.host.error || state.error}</span><button type="button" className="ve-textBtn is-muted" onClick={controller.dismissError}>关闭</button></div>}
          {renderStep(state, controller)}
        </div>
      </main>
      <InfoPanel state={state} controller={controller} />
    </div>
    <SheetHost state={state} controller={controller} />
    <Toast state={state} />
  </div>
}

function WorkspaceTop(props: {
  state: ExperienceState
  controller: ValuationExperienceController
  onBackOverview: () => void
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const { state, controller, onBackOverview } = props
  const address = fullLocation(state.draft) || state.plan?.inputs.address || '未载入项目'
  const area = state.plan?.subjectArea ?? (Number.parseFloat(state.draft.area) > 0 ? Number.parseFloat(state.draft.area) : null)
  return <header className="ve-wsTop">
    <nav className="ve-crumb" aria-label="当前位置">
      <button type="button" className="ve-crumbLink" data-back-overview="true" onClick={onBackOverview}>资产评估</button>
      <span className="ve-sep" aria-hidden="true">/</span>
      <button type="button" className="ve-crumbLink" data-back-intake="true" onClick={() => controller.setView('intake')}>01 估值</button>
    </nav>
    <div className="ve-tbProject">
      <FolderIcon size={15} />
      <span className="ve-tbProjectName" title={address}>{address}</span>
      <span className="ve-tbProjectChip">{state.draft.usage || '用途待定'} · {area === null || area === undefined ? '面积待定' : `${area} ㎡`}</span>
    </div>
    <div className="ve-topRight">
      <button type="button" className="ve-textBtn is-muted" data-refresh-workspace-top="true" onClick={controller.refresh}><RefreshIcon size={13} />刷新</button>
      {state.host.parentSessionId === '' || props.onOpenSession === undefined ? null : <button type="button" className="ve-textBtn" data-open-valuation-session="true" onClick={() => props.onOpenSession?.(state.host.parentSessionId)}>打开估值会话<ChevronRight size={12} /></button>}
      <button type="button" className="ve-infoToggle" data-open-info="true" onClick={controller.openInfo}>
        <PanelIcon size={14} />项目信息
      </button>
      <button type="button" className="ve-modeChip" data-workspace-mode-chip={state.mode} onClick={() => controller.openSheet({ kind: 'concept' })}>
        <span className="ve-dot" />
        {state.mode === 'demo' ? '示例数据 · 本地演示' : state.mode === 'host' ? '估值工作流 · 实时状态' : '尚未载入项目'}
      </button>
    </div>
  </header>
}

function WorkspaceRail(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const area = state.plan?.subjectArea ?? (Number.parseFloat(state.draft.area) > 0 ? Number.parseFloat(state.draft.area) : null)
  return <aside className="ve-rail" aria-label="估值流程">
    <p className="ve-railLabel">估值流程</p>
    <div className="ve-railProject">
      <div className="ve-rpAddr">{fullLocation(state.draft) || state.plan?.inputs.address || '未载入项目'}</div>
      <div className="ve-rpMeta">
        <span>{state.draft.usage || '用途待定'}</span>
        <span>{area === null || area === undefined ? '面积待定' : `${area} ㎡`}</span>
        <span>{state.draft.method}</span>
      </div>
    </div>
    <nav className="ve-steps" aria-label="六个估值环节">
      {WORKFLOW_STEPS.map((item) => {
        const info = navStateFor(state, item.key)
        const active = state.workspaceStep === item.key
        return <button key={item.key} type="button"
          className={`ve-navStep${active ? ' is-active' : ''}${info.cls === 'done' ? ' is-done' : ''}${info.cls === 'warn' ? ' is-warn' : ''}`}
          data-workspace-step={item.key}
          aria-current={active ? 'step' : undefined}
          onClick={() => controller.setWorkspaceStep(item.key)}>
          <span className="ve-navDot">{info.cls === 'done' ? <CheckIcon size={12} /> : item.num}</span>
          <span className="ve-navText"><span className="ve-navLabel">{item.label}</span><span className="ve-navState">{info.state}</span></span>
        </button>
      })}
    </nav>
    <div className="ve-railFoot">
      <button type="button" className="ve-railAction" data-refresh-workspace="true" onClick={controller.refresh}>
        <RefreshIcon size={13} />{state.mode === 'host' ? '刷新工作流状态' : '刷新当前项目'}
      </button>
      <p className="ve-railNote">{state.mode === 'demo' ? '示例数据，仅保存在当前面板。' : state.mode === 'host' ? '状态来自估值工作流回执。' : '尚未载入项目。'}</p>
    </div>
  </aside>
}

function renderStep(state: ExperienceState, controller: ValuationExperienceController): React.ReactElement {
  switch (state.workspaceStep) {
    case 'check': return <CheckPage state={state} controller={controller} />
    case 'reasoning': return <ReasoningPage state={state} controller={controller} />
    case 'confirm': return <ConfirmPage state={state} controller={controller} />
    case 'cases': return <CasesPage state={state} controller={controller} />
    case 'caseCheck': return <CaseCheckPage state={state} controller={controller} />
    default: return <DocsPage state={state} controller={controller} />
  }
}

function PageHead(props: { kicker: string; title: string; lede: string; actions?: React.ReactNode; pill?: React.ReactNode }): React.ReactElement {
  return <header className="ve-pageHead">
    <div>
      <p className="ve-pageKicker"><span>{props.kicker}</span>{props.pill ?? null}</p>
      <h1 className="ve-pageTitle">{props.title}</h1>
      <p className="ve-pageLede">{props.lede}</p>
    </div>
    {props.actions === undefined ? null : <div className="ve-pageActions">{props.actions}</div>}
  </header>
}

function PlanPill(props: { plan: PlanView | null; status?: string }): React.ReactElement | null {
  if (props.plan === null) return null
  const status = props.status ?? props.plan.status
  const map: Record<string, [string, string]> = {
    draft: ['is-muted', '草案'],
    pending: ['is-accent', '待确认'],
    confirmed: ['is-success', '已确认'],
    stale: ['is-warn', '已过期'],
  }
  const item = map[status] ?? ['is-muted', '未开始']
  return <span className={`ve-pill ${item[0]}`}>{item[1]}</span>
}

function effectivePlanStatus(state: ExperienceState): string {
  return planStatusOf(state)
}

function targetText(value: number): string {
  return value > 0 ? `${value} 个` : '待定'
}

/* ------------------------------------------------------------------ */
/* 1. Docs                                                            */
/* ------------------------------------------------------------------ */

function DocsPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const rows = materialRows(state)
  const stats = materialStats(rows)
  const template = state.draft.template
  const hostNoMaterials = state.mode === 'host' && state.materials.length === 0
  const hostMaterials = state.mode === 'host'
    ? asArray(record(record(state.host.progress)?.market)?.nodes).map((node) => record(node)).find((node) => text(node?.nodeId) === 'materials')
    : null
  return <>
    <PageHead kicker="步骤 1 / 6" title="资料与模板"
      lede="已接收资料入口的文件清单与填写信息。示例识别与真实待读取文件分别保留状态。"
      actions={<>
        <button type="button" className="ve-btn ve-btnSecondary" data-back-intake-page="true" onClick={() => controller.setView('intake')}><ChevronLeft size={14} />返回资料入口</button>
        <button type="button" className="ve-btn ve-btnPrimary" data-goto-check="true" onClick={() => controller.setWorkspaceStep('check')}>继续信息核对<ArrowRight size={14} /></button>
      </>} />
    <div className="ve-summaryStrip">
      <div><span>资料</span><strong>{stats.included}</strong><em>份纳入</em></div>
      <div><span>已识别</span><strong>{state.mode === 'demo' ? includedRows(state).filter((row) => row.file.pages !== null).length : 0}</strong><em>{state.mode === 'demo' ? '份演示结果' : '未接真实读取'}</em></div>
      <div><span>模板</span><strong>{template === null ? '0' : '1'}</strong><em>{template === null ? '未选择' : '待检查'}</em></div>
      <div><span>摘取字段</span><strong>{state.fields.filter((field) => field.source !== null).length}</strong><em>项材料来源</em></div>
    </div>
    {hostNoMaterials ? <div className="ve-banner is-warn" role="status" data-host-materials-gap="true"><InfoIcon size={15} /><span><strong>已有估值项目，但本页面还没有资料清单快照。</strong>历史资料仍保存在项目中，可用右上角「打开估值会话」查看；返回资料入口可补充本轮资料。</span></div> : null}
    <div className="ve-docsGrid">
      <section className="ve-panel">
        <div className="ve-panelHead"><div><h2>本轮纳入资料</h2><p>{state.mode === 'host' && hostMaterials !== undefined ? text(hostMaterials?.summary) : '点击查看摘取内容与来源'}</p></div>
          <span className={`ve-pill ${stats.included > 0 ? 'is-success' : 'is-muted'}`}>{stats.included > 0 ? '已载入' : '空'}</span></div>
        {stats.included === 0
          ? <EmptyState title={hostNoMaterials ? '本轮新页面没有资料清单快照' : '还没有纳入资料'}
            text={hostNoMaterials ? '项目里的历史资料没有被删除；本页面暂时只显示 Host 回执中的方案与信息。' : '可以返回资料入口选择文件，或继续核对已填写的信息。'} />
          : <div className="ve-docList is-plain">{includedRows(state).map((row) => <button key={row.file.id} type="button" className="ve-docRow2" data-open-document={row.file.id} onClick={() => controller.openSheet({ kind: 'document', id: row.file.id })}>
            <span className={`ve-fileType is-${fileTypeClass(row.file.ext)}`}>{typeLabelOf(row.file.ext)}</span>
            <span className="ve-docMain"><span className="ve-docName" title={row.file.path || row.file.relPath}>{row.file.name}</span><span className="ve-docMeta">{row.file.pages === null ? '仅登记' : `${String(row.file.pages.length)} 页`} · {formatSize(row.file.size)} · {row.file.note}</span></span>
            <span className="ve-docSide"><span className={`ve-miniTag${row.file.pages === null ? '' : ' is-ok'}`}>{row.file.pages === null ? '未读取' : '已识别'}</span>{row.file.fields.length > 0 ? <span className="ve-docFields">{row.file.fields.length} 项摘取</span> : null}</span>
          </button>)}</div>}
        <div className="ve-dataNote">{state.mode === 'demo' ? '演示资料与权证编号均为虚构，不读取本机文件。' : '未读取的文件仍待真实 OCR；本页不会为其生成示例摘取。'}</div>
      </section>
      <section className="ve-panel">
        <div className="ve-panelHead"><div><h2>本轮计算表模板</h2><p>与产权资料分开登记</p></div><span className={`ve-pill ${template === null ? 'is-muted' : 'is-warn'}`}>{template === null ? '未选择' : '待检查'}</span></div>
        <div className="ve-panelPad">
          <div className="ve-templateName">{template === null ? '本轮未上传计算表模板' : template.name}</div>
          <p className="ve-templateNote">{template === null
            ? '可以返回资料入口选择模板，或继续核对对象信息。'
            : '入口所选模板已带入项目状态。真实文件尚未解析；示例项目可演示模板字段需求，不能作为真实计算依据。'}</p>
          <button type="button" className="ve-textBtn" onClick={() => controller.openSheet({ kind: 'template' })}>查看模板状态<ChevronRight size={12} /></button>
        </div>
      </section>
    </div>
  </>
}

/* ------------------------------------------------------------------ */
/* 2. Check                                                           */
/* ------------------------------------------------------------------ */

function CheckPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const pending = countPending(state.fields)
  const missing = missingRequiredFor(state)
  const tags = fieldTagsOf(state.fields)
  const done = state.checks.info === 'done'
  return <>
    <PageHead kicker="步骤 2 / 6" title="信息核对"
      lede="逐项核对从资料中摘取的字段，并补上资料里没有的信息。点击任一行可在右侧查看出处或修改。"
      pill={done ? <span className="ve-pill is-success">已核对</span> : pending > 0 ? <span className="ve-pill is-warn">{pending} 项待核对</span> : null}
      actions={<button type="button" className="ve-btn ve-btnPrimary" data-confirm-info="true" disabled={missing.length > 0} onClick={controller.confirmInfo}>
        {done ? '继续方案推理' : '确认信息无误，进入方案推理'}<ArrowRight size={14} />
      </button>} />
    <div className="ve-summaryStrip is-five">
      <div><span>字段</span><strong>{state.fields.length}</strong><em>项</em></div>
      <div><span>材料摘取</span><strong>{tags['材料摘取'] ?? 0}</strong><em>项</em></div>
      <div><span>用户填写</span><strong>{tags['用户填写'] ?? 0}</strong><em>项</em></div>
      <div><span>用户更正</span><strong>{tags['用户更正'] ?? 0}</strong><em>项</em></div>
      <div><span>待核对</span><strong>{tags['待核对'] ?? 0}</strong><em>项</em></div>
    </div>
    {state.mode === 'host' && state.fields.every((field) => field.questionId === '')
      ? <div className="ve-banner is-accent"><InfoIcon size={15} /><span>估值工作流尚未返回待核对问题。当前只展示资料入口带入的信息，可使用「刷新工作流状态」读取。</span></div>
      : null}
    <div className="ve-stack">
      {FIELD_GROUPS.map((group) => {
        const fields = state.fields.filter((field) => field.group === group.key)
        return <section className="ve-panel" key={group.key}>
          <div className="ve-panelHead"><div><h2>{group.title}</h2></div><span className="ve-note">{fields.length} 个字段</span></div>
          <div className="ve-dataRows">{fields.map((field) => <button key={field.key} type="button" className="ve-dataRow"
            data-check-field={field.key} onClick={() => {
              controller.setInfoTab('fields')
              controller.openInfo()
              focusField(field.key)
            }}>
            <span className="ve-drLabel">{field.label}</span>
            <span className={`ve-drValue${field.value === '' ? ' is-missing' : ''}`}>{field.value === '' ? '未填写' : field.value}</span>
            <span className="ve-drSide"><span className={`ve-srcTag is-${tagClass(field.tag)}`}>{field.tag}</span></span>
          </button>)}</div>
          {group.key === 'rights' ? <div className="ve-dataNote">未填写的字段不会被当作 0，也不会被自动推断为“无”。</div> : null}
        </section>
      })}
      {missing.length === 0 ? null : <div className="ve-banner is-warn" role="alert"><AlertIcon size={15} /><span>还有必填信息未补全：{missing.map((field) => field.label).join('、')}。补全后才能确认信息。</span></div>}
      <p className="ve-note is-padded">信息确认后会进入方案推理。之后任何信息修改都会生成新版本，并使已有方案需要重新推理。</p>
    </div>
  </>
}

function fileTypeClass(ext: string): string {
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(ext)) return 'img'
  if (['doc', 'docx', 'xlsx', 'xls'].includes(ext)) return 'doc'
  return 'other'
}

function tagClass(tag: string): string {
  if (tag === '材料摘取') return 'material'
  if (tag === '用户更正') return 'corrected'
  if (tag === '待核对') return 'pending'
  return 'user'
}

function focusField(key: string): void {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    const wrap = document.getElementById(`ve-field-${key}`)
    if (wrap !== null) {
      wrap.scrollIntoView({ block: 'center', behavior: 'smooth' })
      wrap.classList.add('is-flash')
      setTimeout(() => wrap.classList.remove('is-flash'), 1200)
    }
  }, 60)
}

/* ------------------------------------------------------------------ */
/* 3. Reasoning                                                       */
/* ------------------------------------------------------------------ */

function ReasoningPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const plan = state.plan
  if (plan === null) {
    return <>
      <PageHead kicker="步骤 3 / 6" title="方案推理"
        lede="信息核对完成后，系统会按当前信息生成一版可审核的案例获取任务方案。本阶段不出金额结论。"
        actions={<button type="button" className="ve-btn ve-btnPrimary" data-generate-plan="true" onClick={controller.generatePlan}>{state.mode === 'host' ? '刷新读取任务方案' : '按当前信息生成任务方案'}<ArrowRight size={14} /></button>} />
      <section className="ve-panel"><EmptyState title="还没有任务方案"
        text={state.mode === 'host' ? '方案由估值工作流按当前信息生成。完成信息核对后刷新，等待回执。' : '方案会绑定当前的信息版本，列出检索条件、模板缺项和执行顺序；确认前不会启动案例检索。'}
        actions={<button type="button" className="ve-btn ve-btnPrimary" onClick={state.mode === 'host' ? controller.refresh : controller.generatePlan}>{state.mode === 'host' ? '刷新工作流状态' : '按当前信息生成任务方案'}</button>} /></section>
      {state.error === '' ? null : <div className="ve-banner is-warn" role="alert"><AlertIcon size={15} /><span>{state.error}</span></div>}
    </>
  }
  const status = effectivePlanStatus(state)
  const conditions = plan.conditions
  const canAdjust = status !== 'stale' && status !== 'confirmed' && state.mode !== 'host'
  return <>
    <PageHead kicker="步骤 3 / 6" title="方案推理"
      lede="以当前信息为基础，生成一版可审核的案例获取任务方案。先核对检索条件、模板缺项与执行顺序；本阶段不出金额结论。"
      pill={<PlanPill plan={plan} status={effectivePlanStatus(state)} />}
      actions={reasoningAction(state, controller)} />
    <PlanStatusBanner state={state} />
    <div className="ve-planGrid is-single">
      <section className="ve-panel ve-planMain" data-plan-panel="true">
        <div className="ve-planHead">
          <div>
            <div className="ve-planMethod">案例获取任务方案 · 市场法 <PlanPill plan={plan} status={status} /></div>
            <p className="ve-planSub">方案 r{plan.rev} · 绑定信息 v{plan.infoVersion} · 生成于 {plan.createdAt}</p>
          </div>
          <button type="button" className="ve-textBtn is-muted" onClick={controller.openInfo}>查看信息 v{state.infoVersion}<ChevronRight size={12} /></button>
        </div>
        <div className="ve-planBody">
          <PlanScope conditions={conditions} />
          <div className="ve-planCols">
            <div className="ve-planCol"><PlanInputs plan={plan} /><TemplateGaps state={state} plan={plan} /></div>
            <div className="ve-planCol"><PlanConditionsSection state={state} controller={controller} plan={plan} canAdjust={canAdjust} /><ExecutionSteps conditions={conditions} /></div>
          </div>
          <div className="ve-planBoundary"><ShieldIcon size={14} /><p><strong>交付边界：</strong>本轮只准备可比案例，不出金额结论，不声称计算完成。示例渠道与案例均为演示数据。当前绑定信息 v{plan.infoVersion}，案例库以实际回执为准。</p></div>
        </div>
      </section>
    </div>
  </>
}

function reasoningAction(state: ExperienceState, controller: ValuationExperienceController): React.ReactNode {
  const plan = state.plan
  if (plan === null) return <button type="button" className="ve-btn ve-btnPrimary" onClick={controller.generatePlan}>按当前信息生成任务方案<ArrowRight size={14} /></button>
  if (state.planEditing) return null
  const status = effectivePlanStatus(state)
  if (status === 'stale') return <button type="button" className="ve-btn ve-btnPrimary" onClick={controller.reReason}><RefreshIcon size={14} />按当前信息重新推理</button>
  if (status === 'draft') return <button type="button" className="ve-btn ve-btnPrimary" onClick={controller.submitPlan}>提交为待确认<ArrowRight size={14} /></button>
  if (status === 'pending') return <button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('confirm')}>确认方案，执行下一节点<ArrowRight size={14} /></button>
  return <button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('cases')}>进入案例获取<ArrowRight size={14} /></button>
}

function PlanStatusBanner(props: { state: ExperienceState }): React.ReactElement | null {
  const plan = props.state.plan
  if (plan === null) return null
  const status = effectivePlanStatus(props.state)
  if (status === 'stale') {
    return <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>项目信息已更新，方案需重新推理。</strong>方案 r{plan.rev} 绑定信息 v{plan.infoVersion}，当前信息为 v{props.state.infoVersion}。旧方案仍可查看，但不能确认。</span></div>
  }
  if (status === 'draft') return <div className="ve-banner is-accent"><InfoIcon size={15} /><span><strong>方案已调整，仍为草案。</strong>你已经手动修改检索条件。提交后进入待确认状态，确认前不会启动案例检索。</span></div>
  if (status === 'confirmed') return <div className="ve-banner is-success"><CheckIcon size={15} /><span><strong>任务方案已确认。</strong>方案 r{plan.rev} 已绑定信息 v{plan.infoVersion}。下一步进入案例获取，检索尚未自动开始。</span></div>
  return null
}

function PlanScope(props: { conditions: PlanConditions }): React.ReactElement {
  return <div className="ve-scopeStrip">
    <div className="ve-scopeCell"><span>本轮交付</span><strong>可比案例候选清单</strong><em>只准备资料，不出金额</em></div>
    <div className="ve-scopeCell"><span>目标候选</span><strong>{targetText(props.conditions.targetCount)}</strong><em>{props.conditions.areaMin ?? '不限'}–{props.conditions.areaMax ?? '不限'} ㎡</em></div>
    <div className="ve-scopeCell"><span>检索渠道</span><strong>{props.conditions.channels.join(' / ') || '未选择'}</strong><em>{props.conditions.channels.length > 0 ? '按方案渠道' : '待选择'}</em></div>
    <div className="ve-scopeCell"><span>交付边界</span><strong>不出金额结论</strong><em>模板重算未接通</em></div>
  </div>
}

function PlanInputs(props: { plan: PlanView }): React.ReactElement {
  return <section className="ve-planSection">
    <div className="ve-planSectionHead"><div><h3>输入依据</h3><p>绑定信息 v{props.plan.infoVersion} 的确认值</p></div></div>
    <div className="ve-inputLine">
      <span className="ve-tin is-wide"><em>坐落</em><strong>{props.plan.inputs.address || '未填写'}</strong></span>
      <span className="ve-tin"><em>用途</em><strong>{props.plan.inputs.usage || '未填写'}</strong></span>
      <span className="ve-tin"><em>面积</em><strong>{props.plan.inputs.area}</strong></span>
      <span className="ve-tin"><em>模板</em><strong>{props.plan.templateName}</strong></span>
    </div>
  </section>
}

function TemplateGaps(props: { state: ExperienceState; plan: PlanView }): React.ReactElement {
  const gaps = props.state.mode === 'host' && props.plan.gaps.length > 0
    ? props.plan.gaps.map((gap) => ({ label: '方案缺口', reason: gap, next: '待核', stage: 'detail' as const }))
    : TEMPLATE_CASE_FIELDS.map((item) => ({ ...item }))
  return <section className="ve-planSection">
    <div className="ve-planSectionHead"><div><h3>模板驱动</h3><p>{props.state.mode === 'host' ? 'Host 方案回执中的模板与缺口' : '示例模板已满足本对象字段，案例字段仍需采集'}</p></div><span className="ve-miniTag">{props.plan.templateVersion}</span></div>
    <div className="ve-tplSatisfied"><span>模板已满足</span><strong>坐落位置 · 房屋用途 · 建筑面积 · 权利性质</strong></div>
    <div className="ve-tplGapList">{gaps.map((item, index) => <div className="ve-tplGapRow" key={`${item.label}-${index}`}>
      <span className="ve-tplGapLabel">{item.label}</span><p>{item.reason}</p><span className={`ve-miniTag${item.stage === 'detail' ? ' is-warn' : ''}`}>{item.next}</span>
    </div>)}</div>
    <p className="ve-calcNote">建成年份的补核放在详情阶段，避免在检索阶段误判合格。</p>
  </section>
}

function PlanConditionsSection(props: {
  state: ExperienceState
  controller: ValuationExperienceController
  plan: PlanView
  canAdjust: boolean
}): React.ReactElement {
  const { state, controller, plan, canAdjust } = props
  return <section className="ve-planSection">
    <div className="ve-planSectionHead">
      <div><h3>检索条件</h3><p>确认后按这些条件获取挂牌候选</p></div>
      {state.planEditing || !canAdjust ? null : <button type="button" className="ve-btn ve-btnSecondary ve-btnSm" data-edit-plan="true" onClick={controller.editPlan}><EditIcon size={12} />调整方案</button>}
    </div>
    {state.planEditing
      ? <PlanEditor plan={plan} controller={controller} />
      : <ConditionView conditions={plan.conditions} />}
  </section>
}

function ConditionView(props: { conditions: PlanConditions }): React.ReactElement {
  return <div className="ve-condGrid">
    <div className="ve-condItem"><span>检索渠道</span><strong>{props.conditions.channels.join(' / ') || '未选择'}</strong></div>
    <div className="ve-condItem"><span>面积范围</span><strong>{props.conditions.areaMin ?? '不限'}–{props.conditions.areaMax ?? '不限'} ㎡</strong></div>
    <div className="ve-condItem"><span>目标候选数量</span><strong>{targetText(props.conditions.targetCount)}</strong></div>
    <div className="ve-condItem"><span>建成年份补核</span><strong>{props.conditions.verifyBuilt === 'list' ? '列表阶段补核' : '详情核对阶段补核'}</strong></div>
    <div className="ve-condItem is-wide"><span>停止条件</span><strong>{props.conditions.stopCondition}</strong></div>
    <div className="ve-condItem is-wide"><span>补充要求</span><strong>{props.conditions.extra || '未填写'}</strong></div>
  </div>
}

function PlanEditor(props: { plan: PlanView; controller: ValuationExperienceController }): React.ReactElement {
  const conditions = props.plan.conditions
  const [draft, setDraft] = React.useState<PlanConditions>(conditions)
  React.useEffect(() => { setDraft(conditions) }, [props.plan.rev])
  const channel = (name: string): void => {
    setDraft((current) => ({
      ...current,
      channels: current.channels.includes(name) ? current.channels.filter((item) => item !== name) : [...current.channels, name],
    }))
  }
  return <div className="ve-planEditor">
    <div className="ve-editorRow"><span className="ve-editorLabel">检索渠道</span><div className="ve-channelChecks">
      {['链家', '房天下', '58'].map((name) => <label className="ve-channelCheck" key={name}>
        <input type="checkbox" checked={draft.channels.includes(name)} onChange={() => channel(name)} /><span>{name}</span>
      </label>)}
    </div></div>
    <div className="ve-editorGrid">
      <label className="ve-editorField"><span>案例面积下限（㎡）</span><input className="ve-planInput" type="number" min="1" step="0.1" value={draft.areaMin ?? ''}
        onChange={(event) => setDraft({ ...draft, areaMin: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      <label className="ve-editorField"><span>案例面积上限（㎡）</span><input className="ve-planInput" type="number" min="1" step="0.1" value={draft.areaMax ?? ''}
        onChange={(event) => setDraft({ ...draft, areaMax: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      <label className="ve-editorField"><span>目标候选数量（1–12）</span><input className="ve-planInput" type="number" min="1" max="12" step="1" value={draft.targetCount}
        onChange={(event) => setDraft({ ...draft, targetCount: Number(event.target.value) })} /></label>
    </div>
    <label className="ve-editorField"><span>停止条件</span><textarea className="ve-planInput ve-planTextarea" rows={2} value={draft.stopCondition}
      onChange={(event) => setDraft({ ...draft, stopCondition: event.target.value })} /></label>
    <label className="ve-editorField"><span>补充要求</span><textarea className="ve-planInput ve-planTextarea" rows={2} value={draft.extra}
      onChange={(event) => setDraft({ ...draft, extra: event.target.value })} /></label>
    <div className="ve-editorRow"><span className="ve-editorLabel">建成年份补核时机</span><div className="ve-verifyOptions">
      <label className="ve-verifyOption"><input type="radio" name="ve-verify" checked={draft.verifyBuilt === 'list'} onChange={() => setDraft({ ...draft, verifyBuilt: 'list' })} /><span>列表阶段补核</span></label>
      <label className="ve-verifyOption"><input type="radio" name="ve-verify" checked={draft.verifyBuilt === 'detail'} onChange={() => setDraft({ ...draft, verifyBuilt: 'detail' })} /><span>详情核对阶段补核</span></label>
    </div></div>
    <div className="ve-editorFoot">
      <span className="ve-note">保存后会生成新的方案草案，并保留本次手设条件。</span>
      <span className="ve-editorActions">
        <button type="button" className="ve-textBtn is-muted" onClick={props.controller.cancelPlanEdit}>取消</button>
        <button type="button" className="ve-btn ve-btnPrimary ve-btnSm" data-save-plan="true" onClick={() => props.controller.savePlan(draft)}>保存为新草案</button>
      </span>
    </div>
  </div>
}

function ExecutionSteps(props: { conditions: PlanConditions }): React.ReactElement {
  const steps = [
    { title: '确认条件', text: '核对项目信息版本、渠道、面积范围与目标候选数。' },
    { title: '检索挂牌候选', text: `在 ${props.conditions.channels.join(' / ') || '所选渠道'} 中检索，最多保留 ${targetText(props.conditions.targetCount)}候选。` },
    { title: '用户选择采用案例', text: '系统不预选案例，由你勾选采用对象。' },
    { title: '所选案例详情及证据核对', text: '逐项核对挂牌信息、面积、权利性质；建成年份在此阶段补核。' },
    { title: '整理候选清单与待核事项', text: '汇总采用案例和仍缺字段，形成本轮交付清单。' },
  ]
  return <section className="ve-planSection">
    <div className="ve-planSectionHead"><div><h3>建议执行顺序</h3><p>确认后从案例获取开始，不自动视为检索完成</p></div></div>
    <div className="ve-flow">{steps.map((step, index) => <div className="ve-flowStep" key={step.title}>
      <span className="ve-flowNum">{index + 1}</span><span className="ve-flowMain"><strong>{step.title}</strong><span>{step.text}</span></span>
    </div>)}</div>
  </section>
}

/* ------------------------------------------------------------------ */
/* 4. Confirm                                                         */
/* ------------------------------------------------------------------ */

function ConfirmPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const plan = state.plan
  if (plan === null) {
    return <>
      <PageHead kicker="步骤 4 / 6" title="方案确认" lede="确认前先检查本轮执行范围与检索条件。" />
      <section className="ve-panel"><EmptyState title="尚未生成任务方案" text="先完成信息核对并生成任务方案，才能进入确认。"
        actions={<button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('reasoning')}>去方案推理</button>} /></section>
    </>
  }
  const status = effectivePlanStatus(state)
  if (status === 'stale') {
    return <>
      <PageHead kicker="步骤 4 / 6" title="方案确认" lede="确认前先检查本轮执行范围与检索条件。" pill={<PlanPill plan={plan} status={status} />} />
      <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>方案已过期，不能确认。</strong>方案 r{plan.rev} 生成于信息 v{plan.infoVersion}，当前信息已更新为 v{state.infoVersion}。旧方案可以查看，但确认与检索操作已禁用。</span></div>
      <PlanSummaryPanel plan={plan} mode="old" status="stale" />
      <div className="ve-confirmGrid">
        <section className="ve-panel ve-panelPad"><div className="ve-reviewList2">
          <ReviewRow ok={false} title="信息版本不一致" text={`方案绑定 v${plan.infoVersion}，当前为 v${state.infoVersion}。`} />
          <ReviewRow ok={false} title="确认操作已禁用" text="重新推理并确认新方案后，才能按新条件获取案例。" />
        </div></section>
        <section className="ve-panel ve-panelPad"><div className="ve-confirmBox"><h3>确认方案</h3><p>当前方案已过期，不能进入案例获取。</p><button type="button" className="ve-btn ve-btnPrimary" disabled>方案已过期，需重新推理</button></div></section>
      </div>
      <div className="ve-pageActions is-end"><button type="button" className="ve-btn ve-btnPrimary" onClick={() => { controller.setWorkspaceStep('reasoning'); controller.reReason() }}><RefreshIcon size={14} />按当前信息重新推理</button></div>
    </>
  }
  if (status === 'draft') {
    return <>
      <PageHead kicker="步骤 4 / 6" title="方案确认" lede="确认前先检查本轮执行范围与检索条件。" pill={<PlanPill plan={plan} status={status} />} />
      <div className="ve-banner is-accent"><InfoIcon size={15} /><span><strong>方案仍为草案。</strong>检索条件已调整，但还没有提交为待确认。回到方案推理提交后，才能进入确认。</span></div>
      <PlanSummaryPanel plan={plan} mode="draft" status="draft" />
      <div className="ve-confirmGrid">
        <section className="ve-panel ve-panelPad"><div className="ve-reviewList2">
          <ReviewRow ok title="信息版本一致" text={`方案与当前信息均为 v${state.infoVersion}。`} />
          <ReviewRow ok={false} title="方案尚未提交" text="提交为待确认后才能执行确认操作。" />
        </div></section>
        <section className="ve-panel ve-panelPad"><div className="ve-confirmBox"><h3>确认方案</h3><p>草案不能直接确认，请先在方案推理中提交。</p><button type="button" className="ve-btn ve-btnPrimary" disabled>草案尚未提交</button></div></section>
      </div>
      <div className="ve-pageActions is-end"><button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.setWorkspaceStep('reasoning')}>返回方案推理</button></div>
    </>
  }
  if (status === 'confirmed') {
    return <>
      <PageHead kicker="步骤 4 / 6" title="方案确认" lede="确认前先检查本轮执行范围与检索条件。" pill={<PlanPill plan={plan} status={status} />} />
      <section className="ve-panel"><div className="ve-successPanel">
        <span className="ve-successIcon"><CheckIcon size={22} /></span>
        <h2 className="ve-successTitle">方案已确认</h2>
        <p className="ve-successText">方案 r{plan.rev} 已绑定信息 v{plan.infoVersion}，检索范围与条件已锁定。案例尚未获取，需在“案例获取”中读取候选。</p>
        <div className="ve-successMeta"><span className="ve-pill is-success">r{plan.rev} 已确认</span><span className="ve-pill">信息 v{plan.infoVersion}</span><span className="ve-pill">目标 {targetText(plan.conditions.targetCount)}候选</span><span className="ve-pill">{plan.conditions.channels.join(' / ')}</span></div>
        <div className="ve-successActions">
          <button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.setWorkspaceStep('reasoning')}>查看方案</button>
          <button type="button" className="ve-btn ve-btnPrimary" data-goto-cases="true" onClick={() => controller.setWorkspaceStep('cases')}>进入案例获取<ArrowRight size={14} /></button>
        </div>
      </div></section>
      <div className="ve-stack is-top"><PlanSummaryPanel plan={plan} mode="confirmed" status="confirmed" /></div>
    </>
  }
  const canConfirm = state.confirmAck && !state.busy
  return <>
    <PageHead kicker="步骤 4 / 6" title="方案确认" lede="确认前先检查本轮执行范围与检索条件。确认后进入案例获取，不会在确认时自动完成检索。" pill={<PlanPill plan={plan} status={status} />} />
    <div className="ve-confirmGrid">
      <section className="ve-panel">
        <div className="ve-panelHead"><div><h2>确认前检查</h2><p>审核执行范围，不审核金额结论</p></div></div>
        <div className="ve-panelPad is-tight">
          <div className="ve-reviewList2">
            <ReviewRow ok title="信息版本一致" text={`方案 r${plan.rev} 与项目信息 v${state.infoVersion} 一致。`} />
            <ReviewRow ok title="输入依据已记录" text="坐落、用途、面积与模板均绑定本方案。" />
            <ReviewRow ok title="检索渠道" text={`${plan.conditions.channels.join(' / ') || '未选择'}${state.mode === 'demo' ? '（演示渠道）。' : '。'}`} />
            <ReviewRow ok title="检索范围" text={`${plan.conditions.areaMin ?? '不限'}–${plan.conditions.areaMax ?? '不限'} ㎡，目标 ${targetText(plan.conditions.targetCount)}候选。`} />
            <ReviewRow ok title="补核时机" text={plan.conditions.verifyBuilt === 'list' ? '列表阶段补核建成年份。' : '详情核对阶段补核建成年份。'} />
            <ReviewRow ok title="交付边界" text="本轮只准备可比案例，不出金额结论，不声称计算完成。" />
          </div>
          <div className="ve-stack is-top"><PlanSummaryPanel plan={plan} mode="review" status={status} /></div>
        </div>
      </section>
      <section className="ve-panel ve-panelPad"><div className="ve-confirmBox">
        <h3>确认方案</h3>
        <p>确认后锁定检索条件。若之后修改项目信息，方案会自动标记为已过期，需重新推理。</p>
        <div className="ve-confirmMeta"><span>方案版本</span><strong>r{plan.rev}</strong></div>
        <div className="ve-confirmMeta"><span>信息版本</span><strong>v{state.infoVersion}</strong></div>
        <div className="ve-confirmMeta"><span>目标候选</span><strong>{targetText(plan.conditions.targetCount)}</strong></div>
        <div className="ve-confirmMeta"><span>检索渠道</span><strong>{plan.conditions.channels.join(' / ') || '未选择'}</strong></div>
        <button type="button" className={`ve-ackRow${state.confirmAck ? ' is-on' : ''}`} data-toggle-ack="true" onClick={controller.toggleAck}>
          <span className={`ve-ackMark${state.confirmAck ? ' is-on' : ''}`}><CheckIcon size={10} /></span>
          <span className="ve-ackText">我已核对执行范围与检索条件；本轮不出金额结论，确认后进入案例获取。</span>
        </button>
        <button type="button" className="ve-btn ve-btnPrimary is-block" data-confirm-plan="true" disabled={!canConfirm} onClick={controller.confirmPlan}>
          {state.busy ? '正在提交确认…' : '确认方案，执行下一节点'}
        </button>
        <button type="button" className="ve-textBtn is-block" onClick={() => controller.setWorkspaceStep('reasoning')}>返回方案推理</button>
      </div></section>
    </div>
    <div className="ve-banner is-accent"><InfoIcon size={15} /><span><strong>确认意味着什么：</strong>确认只代表这版检索方案可以进入案例获取，不代表案例已检索、金额已完成或报告已出具。{state.mode === 'demo' ? '示例渠道、示例挂牌与模板重算均为演示。' : ''}</span></div>
  </>
}

function ReviewRow(props: { ok: boolean; title: string; text: string }): React.ReactElement {
  return <div className="ve-reviewRow">
    <span className={`ve-reviewMark${props.ok ? '' : ' is-warn'}`}>{props.ok ? <CheckIcon size={11} /> : <AlertIcon size={11} />}</span>
    <div className="ve-reviewMain"><div className="ve-reviewTitle">{props.title}</div><div className="ve-reviewText">{props.text}</div></div>
  </div>
}

function PlanSummaryPanel(props: { plan: PlanView; mode: 'old' | 'draft' | 'review' | 'confirmed'; status?: string }): React.ReactElement {
  const plan = props.plan
  return <section className="ve-panel">
    <div className="ve-planHead"><div><div className="ve-planMethod">案例获取任务方案 <PlanPill plan={plan} status={props.status ?? plan.status} /></div><p className="ve-planSub">方案 r{plan.rev} · 绑定信息 v{plan.infoVersion} · {plan.createdAt}</p></div>
      <span className="ve-miniTag">{props.mode === 'old' ? '旧方案，不可确认' : props.mode === 'draft' ? '草案，不可确认' : '仅准备案例'}</span></div>
    <div className="ve-planBody is-tight">
      <div className="ve-calcRow"><span>本轮交付</span><span className="ve-calcVal">可比案例候选清单</span></div>
      <div className="ve-calcRow"><span>检索渠道</span><span className="ve-calcVal">{plan.conditions.channels.join(' / ') || '未选择'}</span></div>
      <div className="ve-calcRow"><span>案例面积范围</span><span className="ve-calcVal">{plan.conditions.areaMin ?? '不限'}–{plan.conditions.areaMax ?? '不限'} ㎡</span></div>
      <div className="ve-calcRow"><span>目标候选数量</span><span className="ve-calcVal">{targetText(plan.conditions.targetCount)}</span></div>
      <div className="ve-calcRow"><span>建成年份补核</span><span className="ve-calcVal">{plan.conditions.verifyBuilt === 'list' ? '列表阶段补核' : '详情核对阶段补核'}</span></div>
      <div className="ve-calcRow"><span>停止条件</span><span className="ve-calcVal is-wrap">{plan.conditions.stopCondition}</span></div>
      <div className="ve-calcRow"><span>补充要求</span><span className="ve-calcVal is-wrap">{plan.conditions.extra || '未填写'}</span></div>
      <p className="ve-calcNote">交付边界：不出金额结论，不声称计算完成。示例挂牌只作资料，不能当作成交。</p>
    </div>
  </section>
}

/* ------------------------------------------------------------------ */
/* 5. Cases                                                           */
/* ------------------------------------------------------------------ */

function CasesPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const plan = state.plan
  if (plan === null) {
    return <>
      <PageHead kicker="步骤 5 / 6" title="案例获取" lede="按已确认任务方案获取挂牌候选。示例挂牌不等于成交。" />
      <section className="ve-panel"><EmptyState title="还没有可用的任务方案" text="先完成信息核对并生成任务方案，确认后才能按条件获取案例。未确认的方案不会自动启动检索。"
        actions={<button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('reasoning')}>去方案推理</button>} /></section>
    </>
  }
  const status = effectivePlanStatus(state)
  if (status === 'stale') {
    return <>
      <PageHead kicker="步骤 5 / 6" title="案例获取" lede="按已确认任务方案获取挂牌候选。示例挂牌不等于成交。" pill={<PlanPill plan={plan} status={status} />} />
      <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>项目信息已更新，当前候选结果不能沿用。</strong>重新推理并确认方案后，才会按新的面积与条件重新获取候选。</span></div>
      <section className="ve-panel"><EmptyState title="案例获取已暂停" text="旧候选不能直接沿用。已采用的案例已标记为需复核，待新方案确认后重新获取。"
        actions={<button type="button" className="ve-btn ve-btnPrimary" onClick={() => { controller.setWorkspaceStep('reasoning'); controller.reReason() }}><RefreshIcon size={14} />按当前信息重新推理</button>} /></section>
    </>
  }
  if (status !== 'confirmed') {
    return <>
      <PageHead kicker="步骤 5 / 6" title="案例获取" lede="按已确认任务方案获取挂牌候选。示例挂牌不等于成交。" pill={<PlanPill plan={plan} status={status} />} />
      <div className="ve-banner is-accent"><LockIcon size={15} /><span><strong>方案尚未确认，案例检索不会自动开始。</strong>当前方案为{status === 'draft' ? '草案' : '待确认'}。确认方案后，系统才会按方案条件获取挂牌候选。</span></div>
      <section className="ve-panel"><EmptyState title="尚未开始获取" text="检索渠道、面积范围与目标数量都来自已确认方案。未确认方案不会自动检索，也不会自动判定案例合格。"
        actions={<><button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.setWorkspaceStep('reasoning')}>查看方案</button><button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('confirm')}>去确认方案</button></>} /></section>
    </>
  }
  if (state.candidates.length === 0) {
    return <>
      <PageHead kicker="步骤 5 / 6" title="案例获取" lede="按已确认任务方案获取挂牌候选。示例挂牌不等于成交。" pill={<PlanPill plan={plan} />} />
      <div className="ve-banner is-success"><CheckIcon size={15} /><span><strong>{state.mode === 'host' ? '方案已确认，等待估值工作流返回候选。' : '方案已确认，检索尚未开始。'}</strong>{state.mode === 'host' ? '确认只锁定执行范围；请刷新读取检索进度，不在此页伪造候选。' : '确认只锁定了执行范围，不会自动完成检索。点击下方按钮，按方案条件获取挂牌候选。'}</span></div>
      <section className="ve-panel">
        <div className="ve-panelHead"><div><h2>待执行的检索条件</h2><p>来自已确认方案 r{plan.rev}</p></div><span className="ve-pill is-success">已确认</span></div>
        <div className="ve-panelPad"><ConditionView conditions={plan.conditions} />
          <div className="ve-actionsLeft">
            <button type="button" className="ve-btn ve-btnPrimary" data-retrieve-cases="true" onClick={controller.retrieveCases}>
              {state.mode === 'host' ? <><RefreshIcon size={14} />刷新读取候选</> : '按方案检索挂牌候选'}
            </button>
            <button type="button" className="ve-textBtn is-muted" onClick={() => controller.setWorkspaceStep('reasoning')}>查看完整方案</button>
          </div>
        </div>
      </section>
      {state.mode === 'demo' ? <p className="ve-note is-padded">检索在本地示例案例库中完成，未联网。全部候选均为“示例挂牌”，不是成交记录。</p> : null}
    </>
  }
  const rows = state.candidates.map((item) => ({ case: item, missing: caseMissing(item) }))
  const filtered = state.caseFilter === 'complete' ? rows.filter((row) => row.missing.length === 0)
    : state.caseFilter === 'pending' ? rows.filter((row) => row.missing.length > 0) : rows
  const flagged = state.adopted.filter((entry) => entry.needsReview).length
  return <>
    <PageHead kicker="步骤 5 / 6" title="案例获取" lede="候选条件来自已确认方案。示例挂牌只作资料，挂牌价不能当作成交价。"
      pill={<PlanPill plan={plan} status={status} />}
      actions={<button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.setWorkspaceStep('reasoning')}>查看方案条件</button>} />
    <div className="ve-summaryStrip">
      <div><span>方案</span><strong>r{plan.rev}</strong><em>已确认</em></div>
      <div><span>信息</span><strong>v{state.infoVersion}</strong><em>当前版本</em></div>
      <div><span>候选</span><strong>{state.candidates.length} / {plan.conditions.targetCount > 0 ? plan.conditions.targetCount : '—'}</strong><em>个</em></div>
      <div><span>渠道</span><strong>{plan.conditions.channels.join(' / ')}</strong><em>{state.candidateAt === '' ? '—' : `${state.candidateAt} 检索`}</em></div>
    </div>
    {flagged > 0 ? <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>{flagged} 个沿用案例需复核。</strong>这些案例来自上一版方案，需在「案例核对」逐项复核后再作为采用依据。</span><button type="button" className="ve-textBtn" onClick={() => controller.setWorkspaceStep('caseCheck')}>去案例核对<ChevronRight size={12} /></button></div> : null}
    <section className="ve-panel">
      <div className="ve-panelHead"><div><h2>检索与筛选条件</h2><p>来自已确认方案 r{plan.rev}，不自动判定合格</p></div><span className={`ve-pill ${state.mode === 'host' ? 'is-accent' : 'is-success'}`}>{state.mode === 'host' ? 'Host 回执' : '本地示例库'}</span></div>
      <div className="ve-criteria">
        <span className="ve-criterion">渠道 <strong>{plan.conditions.channels.join(' / ')}</strong></span>
        <span className="ve-criterion">用途 <strong>{state.draft.usage || '待定'}</strong></span>
        <span className="ve-criterion">面积范围 <strong>{plan.conditions.areaMin ?? '不限'}–{plan.conditions.areaMax ?? '不限'} ㎡</strong></span>
        <span className="ve-criterion">对象面积 <strong>{plan.subjectArea ?? '待定'} ㎡</strong></span>
        <span className="ve-criterion">目标数量 <strong>{targetText(plan.conditions.targetCount)}</strong></span>
      </div>
      <p className="ve-calcNote is-padded">停止条件：{plan.conditions.stopCondition} · 补充要求：{plan.conditions.extra || '未填写'}</p>
      <div className="ve-toolbar">
        <div className="ve-seg">
          {([['all', `全部 ${rows.length}`], ['complete', `资料齐全 ${rows.filter((row) => row.missing.length === 0).length}`], ['pending', `待核 ${rows.filter((row) => row.missing.length > 0).length}`]] as const).map(([key, label]) =>
            <button key={key} type="button" className={state.caseFilter === key ? 'is-active' : ''} data-case-filter={key} onClick={() => controller.setCaseFilter(key)}>{label}</button>)}
        </div>
        <span className="ve-caseFootNote">候选已达目标数量上限时自动截断</span>
      </div>
      <div className="ve-tableWrap">
        <table className="ve-tbl">
          <thead><tr><th style={{ width: '58px' }}>采用</th><th>案例</th><th>渠道</th><th>面积</th><th>类型</th><th>挂牌日期</th><th>挂牌单价</th><th>资料</th></tr></thead>
          <tbody>{filtered.length === 0
            ? <tr><td colSpan={8}><div className="ve-emptyInline">当前筛选下没有案例。</div></td></tr>
            : filtered.map((row) => <CaseRow key={row.case.id} view={row.case} missing={row.missing} adopted={adoptedCaseOf(state, row.case.id)} onToggle={() => controller.toggleAdopt(row.case.id)} />)}</tbody>
        </table>
      </div>
      <div className="ve-caseFoot">
        <span className="ve-caseFootNote">已采用 <strong>{state.adopted.length}</strong> 个案例 · 最多 4 个。候选 {state.candidates.length} 个，受方案目标 {targetText(plan.conditions.targetCount)}约束。</span>
        <span className="ve-actionsLeft">
          <button type="button" className="ve-textBtn is-muted" onClick={controller.retrieveCases}>{state.mode === 'host' ? '刷新候选' : '重新检索'}</button>
          <button type="button" className="ve-btn ve-btnPrimary ve-btnSm" data-goto-case-check="true" disabled={state.adopted.length === 0} onClick={() => controller.setWorkspaceStep('caseCheck')}>进入案例核对<ArrowRight size={13} /></button>
        </span>
      </div>
    </section>
    <p className="ve-note is-padded">{state.mode === 'demo' ? '检索在本地示例案例库中完成，未联网。全部候选均为“示例挂牌”，不是成交记录。' : '候选来自估值工作流回执；挂牌信息不等于成交。'}</p>
  </>
}

function CaseRow(props: { view: CaseView; missing: string[]; adopted: AdoptedCase | undefined; onToggle: () => void }): React.ReactElement {
  const { view, missing, adopted } = props
  const flagged = adopted?.needsReview === true
  return <tr className={adopted === undefined ? '' : 'is-adopted'}>
    <td><button type="button" className={`ve-adoptBtn${adopted === undefined ? '' : ' is-on'}`} data-adopt-case={view.id} onClick={props.onToggle}>{adopted === undefined ? '采用' : '已采用'}</button></td>
    <td><div className="ve-caseName">{view.community}{view.unit === '' ? '' : ` ${view.unit}`}{flagged ? <span className="ve-miniTag is-warn">需复核</span> : null}</div>
      <div className="ve-caseSub">{view.addr || view.sourceUrl || view.source}{view.decoration === '' ? '' : ` · ${view.decoration}`}{view.floor === '' ? ' · 楼层待核' : ` · ${view.floor} 层`}</div></td>
    <td><span className="ve-miniTag">{view.channel}</span></td>
    <td className="ve-num">{view.area === null ? '待核' : `${view.area} ㎡`}</td>
    <td><span className="ve-miniTag is-warn">{view.deal}</span></td>
    <td className="ve-num">{view.date || '—'}</td>
    <td className="ve-num">{view.unitPrice === null ? '待核' : `${view.unitPrice.toLocaleString('zh-CN')}`}<span className="ve-cellNote">元/㎡ · 挂牌</span></td>
    <td>{missing.length === 0 ? <span className="ve-miniTag is-ok">资料齐全</span> : <><span className="ve-miniTag is-warn">待核 {missing.length} 项</span><span className="ve-caseMissing">{missing.join('、')} 待核</span></>}</td>
  </tr>
}

/* ------------------------------------------------------------------ */
/* 6. Case check                                                      */
/* ------------------------------------------------------------------ */

function CaseCheckPage(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const plan = state.plan
  const valid = planValidConfirmed(state)
  const flagged = state.adopted.filter((entry) => entry.needsReview).length
  const checked = state.adopted.filter((entry) => CHECK_KEYS.every((key) => entry.checks[key] === true)).length
  const allChecked = state.adopted.length > 0 && checked === state.adopted.length
  const canComplete = valid && allChecked && flagged === 0
  const canExport = state.adopted.length > 0 && state.checks.caseCheck === 'done'
  const actions = <button type="button" className="ve-btn ve-btnSecondary" data-export-cases="true" disabled={!canExport} onClick={controller.exportCsv}><DownloadIcon size={14} />导出采用清单</button>
  if (state.adopted.length === 0) {
    return <>
      <PageHead kicker="步骤 6 / 6" title="案例核对" lede="逐项复核采用案例的挂牌信息、面积、建成年份、权利性质与时点，再形成采用清单。" actions={actions} />
      <section className="ve-panel"><EmptyState title="还没有采用案例" text="先在案例获取中由你选择采用案例，再逐项核对。系统不会自动替你把候选标为合格。"
        actions={<button type="button" className="ve-btn ve-btnPrimary" onClick={() => controller.setWorkspaceStep('cases')}>去案例获取</button>} /></section>
    </>
  }
  return <>
    <PageHead kicker="步骤 6 / 6" title="案例核对" lede="逐项复核采用案例的挂牌信息、面积、建成年份、权利性质与时点，再形成采用清单。" actions={actions}
      pill={state.checks.caseCheck === 'done' ? <span className="ve-pill is-success">已完成</span> : flagged > 0 ? <span className="ve-pill is-warn">{flagged} 个需复核</span> : null} />
    <div className="ve-statStrip">
      <div className="ve-stat"><strong>{state.adopted.length}</strong><span>采用案例</span></div>
      <div className="ve-stat"><strong>{checked} / {state.adopted.length}</strong><span>已完成核对</span></div>
      <div className="ve-stat"><strong>{flagged}</strong><span>需复核</span></div>
      <div className="ve-stat"><strong>{state.checks.caseCheck === 'done' ? '已完成' : '进行中'}</strong><span>采用清单状态</span></div>
    </div>
    {valid ? (flagged > 0 ? <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>{flagged} 个案例需要重新核对。</strong>方案已更新，沿用案例的挂牌信息与可比性需要重新确认。逐项核对完成后，复核标记会自动清除。</span></div> : null)
      : <div className="ve-banner is-warn"><AlertIcon size={15} /><span><strong>方案尚未确认。</strong>当前采用案例来自上一版方案，不能形成最终采用清单。确认有效方案后才能逐项核对。</span><button type="button" className="ve-textBtn" onClick={() => controller.setWorkspaceStep('confirm')}>去确认方案</button></div>}
    <section className="ve-panel">
      <div className="ve-panelHead"><div><h2>采用案例</h2><p>逐项点击核对；修改采用集合后需要重新完成核对</p></div><span className="ve-pill">{state.adopted.length} / 4</span></div>
      {state.adopted.map((entry) => <CaseCheckCard key={entry.id} state={state} entry={entry} controller={controller} />)}
      <div className="ve-checkFoot">
        <span className="ve-checkFootText">{canComplete ? '所有核对项已完成，可以形成采用清单。' : valid ? '完成全部核对项后才能形成采用清单。' : '方案无效，暂时不能完成核对。'}</span>
        <span className="ve-actionsLeft">
          <button type="button" className="ve-btn ve-btnSecondary ve-btnSm" disabled={!canExport} onClick={controller.exportCsv}>导出 CSV</button>
          {state.checks.caseCheck === 'done'
            ? <span className="ve-pill is-success">已形成采用清单</span>
            : <button type="button" className="ve-btn ve-btnPrimary ve-btnSm" data-complete-case-check="true" disabled={!canComplete} onClick={controller.completeCaseCheck}>完成核对</button>}
        </span>
      </div>
    </section>
    <p className="ve-note is-padded">示例挂牌不作为成交依据；采用清单只记录内部复核结果，不等于评估报告，也不含金额结论。</p>
  </>
}

function CaseCheckCard(props: { state: ExperienceState; entry: AdoptedCase; controller: ValuationExperienceController }): React.ReactElement | null {
  const c = props.state.candidates.find((item) => item.id === props.entry.id)
  if (c === undefined) return null
  const area = props.state.plan?.subjectArea ?? 89.5
  const diff = c.area === null ? 0 : Math.round(Math.abs(c.area - area) / area * 100)
  const locked = !planValidConfirmed(props.state)
  const missing = caseMissing(c)
  return <div className={`ve-ccard${props.entry.needsReview ? ' is-flagged' : ''}`} data-case-check={c.id}>
    <div className="ve-ccardTop">
      <div>
        <div className="ve-ccardTitle">{c.community}{c.unit === '' ? '' : ` ${c.unit}`} <span className="ve-miniTag is-warn">{c.deal}</span>{props.entry.needsReview ? <span className="ve-miniTag is-warn">需复核</span> : null}</div>
        <div className="ve-ccardMeta">{c.channel} · {c.addr || c.source} · {c.area === null ? '面积待核' : `${c.area} ㎡`} · {c.floor === '' ? '楼层待核' : `${c.floor} 层`} · {c.built === '' ? '建成年份待核' : `${c.built} 年建成`} · {c.date || '日期待核'} · 面积差 {diff}%
          {missing.length === 0 ? '' : ` · ${missing.join('、')} 待核`}</div>
      </div>
      <div className="ve-ccardPrice">{c.unitPrice === null ? '单价待核' : `${c.unitPrice.toLocaleString('zh-CN')} 元/㎡`}<span>{c.total === null ? '总价待核' : `挂牌总价 ${c.total} 万元`}</span></div>
    </div>
    <div className="ve-ccardChecks">{CHECK_KEYS.map((key) => {
      const on = props.entry.checks[key] === true
      return <button key={key} type="button" className={`ve-ccheck${on ? ' is-on' : ''}`} data-case-check-key={`${c.id}:${key}`} disabled={locked}
        onClick={() => props.controller.toggleCheck(c.id, key)}>
        <span className="ve-ccheckMark"><CheckIcon size={9} /></span>{CHECK_LABELS[key]}
      </button>
    })}</div>
    <div className="ve-ccardNote">
      <span>{props.entry.note === '' ? <><strong>复核说明：</strong>暂无补充</> : <><strong>复核说明：</strong>{props.entry.note}</>}</span>
      <span className="ve-ccardActions">
        <button type="button" className="ve-textBtn" onClick={() => props.controller.openNote(c.id)}>补充说明</button>
        <button type="button" className="ve-textBtn is-muted" onClick={() => props.controller.removeAdopted(c.id)}>取消采用</button>
      </span>
    </div>
  </div>
}

/* ------------------------------------------------------------------ */
/* Info panel                                                         */
/* ------------------------------------------------------------------ */

function InfoPanel(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const pending = countPending(state.fields)
  const versionLabel = state.infoVersion > 0 ? `v${state.infoVersion}` : '未建档'
  const sub = pending > 0 ? `${pending} 项待核对 · 缺失不等于 0` : state.infoVersion > 0 ? '字段已核对 · 修改会生成新版本' : '尚未建立项目信息'
  const values = state.draftValues
  const dirty = values !== null && Object.entries(values).some(([key, value]) => {
    const field = state.fields.find((item) => item.key === key)
    return field !== undefined && field.value !== value
  })
  const tabs: Array<['fields' | 'history' | 'basis', string]> = [['fields', '信息'], ['history', '修改记录'], ['basis', '采用依据']]
  return <aside className={`ve-infoPanel${state.infoOpen ? ' is-open' : ''}`} aria-label="项目信息" data-info-panel={state.infoTab}>
    <div className="ve-infoHead">
      <div className="ve-infoTitleRow"><h2>项目信息</h2><div className="ve-infoTitleRight">
        <span className={`ve-verChip${state.lastSaved === null ? '' : ' is-new'}`}>{versionLabel}</span>
        <button type="button" className="ve-iconBtn ve-infoClose" aria-label="收起项目信息" onClick={controller.closeInfo}><XIcon size={15} /></button>
      </div></div>
      <p className="ve-infoSub">{sub}</p>
      <div className="ve-tabs" role="tablist">{tabs.map(([key, label], index) => <button key={key} type="button" role="tab" id={`ve-info-tab-${key}`}
        aria-selected={state.infoTab === key} aria-controls="ve-info-panel-body" tabIndex={state.infoTab === key ? 0 : -1}
        className={`ve-tab${state.infoTab === key ? ' is-active' : ''}`}
        onClick={() => controller.setInfoTab(key)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]
          controller.setInfoTab(next)
          if (typeof document !== 'undefined') document.getElementById(`ve-info-tab-${next}`)?.focus()
        }}>{label}</button>)}</div>
    </div>
    <div className="ve-infoBody" role="tabpanel" id="ve-info-panel-body" aria-labelledby={`ve-info-tab-${state.infoTab}`}>
      {state.infoTab === 'history' ? <HistoryTab state={state} /> : state.infoTab === 'basis' ? <BasisTab state={state} /> : <FieldsTab state={state} controller={controller} />}
    </div>
    <div className="ve-infoFoot">
      {dirty
        ? <><div className="ve-infoFootTop"><span className="ve-dirtyLine"><span className="ve-dirtyDot" />有未保存修改</span><span className="ve-infoFootNote">保存后生成新版本</span></div>
          <div className="ve-infoFootActions"><button type="button" className="ve-textBtn is-muted" onClick={() => controller.setDraftValues(null)}>放弃</button>
            <button type="button" className="ve-btn ve-btnPrimary ve-btnSm" data-save-info="true" onClick={() => controller.saveInfo(values ?? {})}>{state.mode === 'host' ? '提交答案给估值工作流' : `保存并生成 v${state.infoVersion + 1}`}</button></div></>
        : <><div className="ve-infoFootTop"><span className="ve-infoFootNote">{state.infoVersion > 0 ? `信息 v${state.infoVersion} · 已保存` : '尚未建档'}</span>
          {state.plan !== null && planStatusOf(state) === 'stale' ? <span className="ve-miniTag is-warn">方案需重新推理</span> : <span className="ve-miniTag">{state.mode === 'host' ? 'Host 信息' : '本地草稿'}</span>}</div>
          {state.history.length > 0 ? <div className="ve-infoFootActions is-end"><button type="button" className="ve-textBtn" onClick={() => controller.setInfoTab('history')}>查看修改记录<ChevronRight size={12} /></button></div> : null}</>}
    </div>
  </aside>
}

function FieldsTab(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const values = state.draftValues
  const editable = (field: FieldView): boolean => state.mode !== 'host' || field.questionId !== ''
  const update = (key: string, value: string): void => {
    const next = { ...(values ?? {}) }
    const current = state.fields.find((field) => field.key === key)
    if (value === (current?.value ?? '')) delete next[key]
    else next[key] = value
    controller.setDraftValues(Object.keys(next).length === 0 ? null : next)
  }
  return <>
    {state.lastSaved === null ? null : <div className="ve-lastSaved">
      <div className="ve-lastSavedTitle">已保存 v{state.lastSaved.version} · 本次改动</div>
      <p className="ve-lastSavedText">{state.lastSaved.changes.slice(0, 3).map((change) => <React.Fragment key={change.key}>
        {change.label}：<span className="ve-faint">{change.from || '未填写'}</span> → <strong>{change.to || '未填写'}</strong><br />
      </React.Fragment>)}{state.lastSaved.changes.length > 3 ? `等 ${state.lastSaved.changes.length} 项` : null}</p>
    </div>}
    {FIELD_GROUPS.map((group) => <section className="ve-fieldGroup" key={group.key}>
      <div className="ve-fieldGroupTitle">{group.title}</div>
      {state.fields.filter((field) => field.group === group.key).map((field) => {
        const value = values !== null && Object.prototype.hasOwnProperty.call(values, field.key) ? values[field.key] ?? '' : field.value
        const empty = value === ''
        const disabled = !editable(field)
        return <div className={`ve-infoField${empty ? ' is-missing' : ''}${field.key === 'area' && state.areaRangePrompt ? ' is-hint' : ''}`} id={`ve-field-${field.key}`} key={field.key}>
          <div className="ve-fieldHeadInPanel">
            <label className="ve-fieldLabel" htmlFor={`ve-info-${field.key}`}>{field.label}{field.unit === '' ? null : <span className="ve-fieldUnit">{field.unit}</span>}</label>
            <button type="button" className={`ve-srcTag is-${tagClass(field.tag)}`} data-source-field={field.key} onClick={() => controller.openSheet({ kind: 'source', key: field.key })}>{field.tag}</button>
          </div>
          {field.control === 'select'
            ? <select className="ve-fieldInput" id={`ve-info-${field.key}`} disabled={disabled} value={value} onChange={(event) => update(field.key, event.target.value)}>
              {field.options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled === true}>{option.label}</option>)}
            </select>
            : field.control === 'textarea'
              ? <textarea className="ve-fieldInput ve-fieldTextarea" id={`ve-info-${field.key}`} disabled={disabled} value={value} rows={2}
                placeholder={field.placeholder} onChange={(event) => update(field.key, event.target.value)} />
              : <input className="ve-fieldInput" id={`ve-info-${field.key}`} disabled={disabled} type={field.control === 'number' ? 'number' : field.control === 'date' ? 'date' : 'text'}
                step={field.control === 'number' ? '0.1' : undefined} min={field.control === 'number' ? '0' : undefined}
                value={value} placeholder={field.placeholder} onChange={(event) => update(field.key, event.target.value)} />}
          {field.key === 'area' && state.areaRangePrompt ? <p className="ve-fieldHint">面积已变更，案例范围已保留，请核对。</p> : null}
          {disabled ? <p className="ve-fieldNote">该字段来自估值工作流回执，不能在此直接修改。</p> : null}
        </div>
      })}
    </section>)}
    <p className="ve-infoHint">{state.mode === 'host' ? '修改会作为答案提交给估值工作流；提交后由回执刷新版本。' : `所有字段都可在右侧直接修改。修改并保存会生成新的信息版本 v${state.infoVersion + 1}，并使已有方案需要重新推理。`}</p>
  </>
}

function HistoryTab(props: { state: ExperienceState }): React.ReactElement {
  const hostRevisions = props.state.mode === 'host'
    ? asArray(record(props.state.host.progress)?.revisions).map((raw) => record(raw)).filter((item): item is Record<string, unknown> => item !== null)
    : []
  if (hostRevisions.length > 0) {
    return <div className="ve-hist">{hostRevisions.slice().reverse().map((revision) => <div className="ve-histItem" key={text(revision.revision)}>
      <div className="ve-histTop"><span className="ve-histVer">v{text(revision.revision)}</span><span className="ve-histTime">{text(revision.updatedAt)}</span></div>
      <p className="ve-histNote">{text(revision.reason) || '估值工作流修订'} · {text(revision.source) || 'Host'}</p>
      <div className="ve-histChanges">{asArray(revision.changes).map((raw, index) => {
        const change = record(raw)
        return <div className="ve-histChange" key={index}>{text(change?.field) || '字段'}：<span className="ve-old">{text(change?.from) || '未填写'}</span> → <span className="ve-new">{text(change?.to) || '未填写'}</span></div>
      })}</div>
    </div>)}</div>
  }
  if (props.state.history.length === 0) {
    return <div className="ve-emptyInline">还没有修改记录。<br />载入示例资料后会生成 v1。</div>
  }
  return <div className="ve-hist">{props.state.history.map((item) => <div className="ve-histItem" key={item.version}>
    <div className="ve-histTop"><span className="ve-histVer">v{item.version}</span><span className="ve-histTime">{item.at}</span></div>
    <p className="ve-histNote">{item.note} · {item.author}</p>
    <div className="ve-histChanges">{item.changes.map((change) => <div className="ve-histChange" key={change.key}>{change.label}：<span className="ve-old">{change.from || '未填写'}</span> → <span className="ve-new">{change.to || '未填写'}</span></div>)}</div>
  </div>)}</div>
}

function BasisTab(props: { state: ExperienceState }): React.ReactElement {
  const plan = props.state.plan
  const status = effectivePlanStatus(props.state)
  const statusText = status === 'stale' ? '已过期' : status === 'confirmed' ? '已确认' : status === 'pending' ? '待确认' : status === 'draft' ? '草案' : '未生成'
  const sources = props.state.fields.filter((field) => field.source !== null)
  return <>
    <div className="ve-basisBlock"><div className="ve-basisTop"><h3 className="ve-basisTitle">信息版本</h3><span className="ve-verChip">{props.state.infoVersion > 0 ? `v${props.state.infoVersion}` : '未建档'}</span></div>
      <p className="ve-basisText">{props.state.history.length > 0 ? `最近修改于 ${props.state.history[0]?.at ?? ''} · ${props.state.history[0]?.author ?? ''}` : '尚未建立版本'}</p></div>
    <div className="ve-basisBlock"><div className="ve-basisTop"><h3 className="ve-basisTitle">模板与资料</h3><span className="ve-miniTag">{props.state.materials.length > 0 ? '已载入' : '未载入'}</span></div>
      {props.state.materials.length > 0 ? <ul className="ve-basisList"><li><span>模板</span><strong>{plan?.templateName ?? props.state.draft.template?.name ?? '未选择'}</strong></li><li><span>资料</span><strong>{materialStats(materialRows(props.state)).included} 份 · 已识别 {props.state.mode === 'demo' ? includedRows(props.state).filter((row) => row.file.pages !== null).length : 0} 份</strong></li></ul>
        : <p className="ve-basisEmpty">尚未载入资料或模板。</p>}</div>
    <div className="ve-basisBlock"><div className="ve-basisTop"><h3 className="ve-basisTitle">当前任务方案</h3>{plan === null ? <span className="ve-miniTag">未生成</span> : <PlanPill plan={plan} />}</div>
      <p className="ve-basisText">{plan === null ? '尚未生成方案' : `方案 r${plan.rev} · 状态：${statusText} · 绑定信息 v${plan.infoVersion}`}</p>
      {plan === null ? null : <ul className="ve-basisList"><li><span>方法</span><strong>市场法 · 比较法</strong></li><li><span>对象面积</span><strong>{plan.subjectArea ?? '待核'} ㎡</strong></li><li><span>检索渠道</span><strong>{plan.conditions.channels.join(' / ') || '未选择'}</strong></li><li><span>目标候选</span><strong>{targetText(plan.conditions.targetCount)}</strong></li></ul>}</div>
    <div className="ve-basisBlock"><div className="ve-basisTop"><h3 className="ve-basisTitle">材料依据</h3><span className="ve-miniTag">{sources.length} 项</span></div>
      {sources.length === 0 ? <p className="ve-basisEmpty">尚无材料摘取字段。</p> : <ul className="ve-basisList">{sources.map((field) => <li key={field.key}><span>{field.label}{field.tag === '用户更正' ? ' · 已更正' : ''}</span><strong>{field.source?.doc ?? ''}{field.source === null ? '' : ` p.${field.source.page}`}</strong></li>)}</ul>}</div>
    <div className="ve-basisBlock"><div className="ve-basisTop"><h3 className="ve-basisTitle">采用案例</h3><span className="ve-miniTag">{props.state.adopted.length} 个</span></div>
      {props.state.adopted.length === 0 ? <p className="ve-basisEmpty">尚未采用案例。方案确认后可开始匹配。</p> : <ul className="ve-basisList">{props.state.adopted.map((entry) => {
        const c = props.state.candidates.find((item) => item.id === entry.id)
        const label = caseStatusLabel(props.state, entry)
        return <li key={entry.id}><span>{c === undefined ? entry.id : `${c.community} ${c.unit}`}</span><strong className={`is-${label === '需复核' ? 'warn' : label === '已核对' ? 'ok' : 'muted'}`}>{label}</strong></li>
      })}</ul>}</div>
    <p className="ve-infoHint">采用依据会随信息版本和方案版本变化。信息修改后，旧方案与旧采用案例会标记为需重新核对。</p>
  </>
}

export { type ScaleIcon }
