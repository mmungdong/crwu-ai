import * as React from 'react'
import type { ExperienceState, SheetState } from '../model.ts'
import { fullLocation, planStatusOf } from '../model.ts'
import { ArrowRight, BuildingIcon, CheckIcon, InfoIcon, XIcon } from './icons.tsx'
import type { ValuationExperienceController } from '../controller.ts'

export interface OverviewProps {
  experience: ValuationExperienceController
  state: ExperienceState
  onEnter: () => void
}

function statusTextOf(state: ExperienceState): { label: string; tone: 'draft' | 'active' | 'demo' | 'empty' } {
  if (state.mode === 'demo') return { label: '示例项目 · 本地演示', tone: 'demo' }
  if (state.mode === 'host') {
    const status = state.host.status
    if (status === 'completed') return { label: '估值已交付', tone: 'active' }
    if (status === 'partial') return { label: '带限制交付', tone: 'active' }
    if (status === 'waiting-user') return { label: '等待你的确认', tone: 'active' }
    if (status === 'running') return { label: '估值工作流执行中', tone: 'active' }
    if (status === 'blocked' || status === 'failed') return { label: '估值工作流受阻', tone: 'draft' }
    return { label: '估值项目已建立', tone: 'active' }
  }
  const started = state.draft.projectName !== ''
    || fullLocation(state.draft) !== ''
    || state.materials.some((source) => source.files.length > 0)
    || state.draft.category !== ''
  return started ? { label: '草稿 · 资料与信息待准备', tone: 'draft' } : { label: '尚未开始', tone: 'empty' }
}

export function AssetOverview(props: OverviewProps): React.ReactElement {
  const { state } = props
  const status = statusTextOf(state)
  const projectName = state.draft.projectName
    || state.plan?.inputs.address
    || fullLocation(state.draft)
    || '尚未建立估值项目'
  const assetLabel = state.draft.category === '' ? '待选择' : `房地产 · ${state.draft.assetType === '' ? '类别待定' : state.draft.assetType}`
  const methodLabel = state.plan === null
    ? '市场法 · 案例准备'
    : planStatusOf(state) === 'confirmed' ? '市场法 · 方案已确认' : `市场法 · ${planStatusOf(state) === 'stale' ? '方案待重新推理' : '方案待确认'}`
  const hasProject = state.mode !== 'empty' || state.draft.projectName !== '' || fullLocation(state.draft) !== ''
  return <div className="ve-overview" data-asset-workflow-overview="true">
    <p className="ve-eyebrow"><span className="ve-dot" />资产评估 · 项目总览</p>

    <div className="ve-titleRow">
      <div className="ve-titleMain">
        <h1 className="ve-projectTitle">{projectName}</h1>
        <p className="ve-projectLede">
          围绕同一个项目完成资料准备、信息核对与市场法案例整理。已确认的信息和资料会保留在项目中，供后续操作继续使用。
        </p>
      </div>
      <span className={`ve-projectStatus is-${status.tone}`} data-overview-status={status.tone}>
        <span className="ve-ring" aria-hidden="true" />01 估值 · {status.tone === 'empty' ? '当前阶段' : status.label}
      </span>
    </div>

    <div className="ve-summary" role="group" aria-label="项目摘要" data-overview-summary="true">
      <div className="ve-summaryItem">
        <span className="ve-summaryLabel">估值对象</span>
        <span className="ve-summaryValue">{assetLabel}{state.draft.category === '' ? null : <span className="ve-muted"> · 住宅及商业</span>}</span>
      </div>
      <div className="ve-summaryItem">
        <span className="ve-summaryLabel">评估方法</span>
        <span className="ve-summaryValue">{methodLabel}</span>
      </div>
      <div className="ve-summaryItem">
        <span className="ve-summaryLabel">项目状态</span>
        <span className="ve-summaryValue">{status.label}</span>
      </div>
    </div>

    <section className="ve-stageCard" aria-labelledby="ve-stage-title" data-business-step-card="valuation">
      <div className="ve-stageMain">
        <div className="ve-stageMeta">
          <span className="ve-stageNo">01</span>
          <span className="ve-stageTag">当前阶段</span>
        </div>
        <h2 className="ve-stageTitle" id="ve-stage-title">估值</h2>
        <p className="ve-stageLede">
          准备评估对象与资料，核对识别结果，确认任务方案后执行。本阶段聚焦市场法可比案例的准备，不输出估值金额。
        </p>
        <ul className="ve-scope" aria-label="本阶段工作内容">
          <li>选择评估对象与资料</li>
          <li>资料识别与人工核对</li>
          <li>确认案例获取方案</li>
        </ul>
        <div className="ve-stageActions">
          <button type="button" className="ve-btn ve-btnPrimary" data-business-step="valuation" onClick={props.onEnter}>
            {hasProject ? '继续估值' : '进入估值'}<ArrowRight size={15} />
          </button>
          <span className="ve-actionHint">先完成资料与信息，再进入六步工作面</span>
        </div>
      </div>
      <aside className="ve-stageSide" aria-label="本阶段产出">
        <p className="ve-sideLabel">本阶段将产出</p>
        <ul className="ve-deliverables">
          <li><span className="ve-mark" aria-hidden="true"><CheckIcon size={9} /></span>纳入的资料清单与来源</li>
          <li><span className="ve-mark" aria-hidden="true"><CheckIcon size={9} /></span>经核对的对象信息与版本</li>
          <li><span className="ve-mark" aria-hidden="true"><CheckIcon size={9} /></span>已确认的案例获取方案</li>
        </ul>
        <p className="ve-sideNote">本阶段的资料、核对结果与案例方案会保存在同一项目中，可在工作台随时查看。</p>
      </aside>
    </section>

    {state.host.error === '' && state.error === ''
      ? null
      : <div className="ve-banner is-warn" role="alert" data-overview-host-error="true">
        <InfoIcon size={15} /><span>{state.host.error || state.error}</span>
      </div>}

    <footer className="ve-pageFoot">
      <p>资料与对象信息可在本阶段反复修改，确认后与案例方案一起保存在同一项目。</p>
      <span className="ve-level">所在流程 <b>资产评估 / 01 估值</b></span>
    </footer>
  </div>
}

export function Toast(props: { state: ExperienceState }): React.ReactElement | null {
  const [visible, setVisible] = React.useState(false)
  const seq = props.state.toast.seq
  React.useEffect(() => {
    if (seq === 0) return undefined
    setVisible(true)
    const timer = setTimeout(() => { setVisible(false) }, 2800)
    return () => { clearTimeout(timer) }
  }, [seq])
  if (!visible || props.state.toast.text === '') return null
  return <div className="ve-toast is-on" role="status" aria-live="polite">{props.state.toast.text}</div>
}

export function EmptyState(props: { title: string; text: string; actions?: React.ReactNode }): React.ReactElement {
  return <div className="ve-locked">
    <span className="ve-lockedIcon"><InfoIcon size={20} /></span>
    <h2 className="ve-lockedTitle">{props.title}</h2>
    <p className="ve-lockedText">{props.text}</p>
    {props.actions === undefined ? null : <div className="ve-lockedActions">{props.actions}</div>}
  </div>
}

export function Modal(props: {
  title: string
  kicker?: string
  children: React.ReactNode
  actions?: React.ReactNode
  onClose: () => void
  wide?: boolean
}): React.ReactElement {
  return <div className="ve-modalLayer" role="presentation" onClick={(event) => {
    if (event.target === event.currentTarget) props.onClose()
  }}>
    <div className={`ve-modal${props.wide === true ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="ve-modalHead">
        <div>
          {props.kicker === undefined ? null : <p className="ve-modalKicker">{props.kicker}</p>}
          <h2 className="ve-modalTitle">{props.title}</h2>
        </div>
        <button type="button" className="ve-iconBtn" aria-label="关闭" onClick={props.onClose}><XIcon size={15} /></button>
      </div>
      <div className="ve-modalBody">{props.children}</div>
      {props.actions === undefined ? null : <div className="ve-modalFoot">{props.actions}</div>}
    </div>
  </div>
}

export function SheetHost(props: {
  state: ExperienceState
  controller: ValuationExperienceController
}): React.ReactElement | null {
  const sheet = props.state.sheet
  if (sheet === null) return null
  const close = (): void => { props.controller.closeSheet() }
  switch (sheet.kind) {
    case 'source':
      return <SourceSheet state={props.state} sheet={sheet} onClose={close} />
    case 'document':
      return <DocumentSheet state={props.state} sheet={sheet} onClose={close} />
    case 'template':
      return <TemplateSheet state={props.state} onClose={close} />
    case 'concept':
      return <ConceptSheet onClose={close} />
    case 'note':
      return <NoteSheet state={props.state} sheet={sheet} controller={props.controller} onClose={close} />
    case 'discard':
      return <Modal title="要放弃未保存的修改吗？" kicker="未保存修改" onClose={close} actions={<>
        <button type="button" className="ve-btn ve-btnSecondary" onClick={close}>继续编辑</button>
        <button type="button" className="ve-btn ve-btnPrimary" data-discard-confirm="true" onClick={() => {
          props.controller.setDraftValues(null)
          close()
        }}>放弃修改</button>
      </>}>
        <p>右侧项目信息中的修改还没有保存。放弃后不会生成新的信息版本。</p>
      </Modal>
    case 'demo':
      return <Modal title="载入示例项目" kicker="演示数据" onClose={close} actions={<>
        <button type="button" className="ve-btn ve-btnSecondary" onClick={close}>取消</button>
        <button type="button" className="ve-btn ve-btnPrimary" data-demo-confirm="true" onClick={() => {
          props.controller.loadDemo()
          close()
        }}>载入示例</button>
      </>}>
        <p>这会替换当前已选择的文件与填写内容。示例资料仅用于演示，不会读取真实文件。</p>
        <ul className="ve-modalList">
          <li>虚构的产权资料、合同、照片与文件夹树</li>
          <li>住宅市场法示例模板，状态为“待检查”</li>
          <li>手填信息与面积冲突演示（89.5 / 96.2 ㎡）</li>
        </ul>
      </Modal>
    default:
      return null
  }
}

function SourceSheet(props: { state: ExperienceState; sheet: Extract<SheetState, { kind: 'source' }>; onClose: () => void }): React.ReactElement {
  const field = props.state.fields.find((item) => item.key === props.sheet.key)
  if (field === undefined) return <Modal title="字段来源" onClose={props.onClose}><p>没有找到这个字段。</p></Modal>
  return <Modal title={field.label} kicker="字段来源" onClose={props.onClose} actions={
    <button type="button" className="ve-btn ve-btnSecondary" onClick={props.onClose}>关闭</button>
  }>
    {field.source === null && field.sourceText === ''
      ? <p className="ve-sheetMeta">{field.tag} · 无可引用的材料原文</p>
      : <p className="ve-sheetMeta">{field.tag}{field.source === null ? ` · ${field.sourceText}` : ` · ${field.source.doc} · 第 ${String(field.source.page)} 页`}</p>}
    {field.source === null ? null : <blockquote className="ve-sheetQuote">{field.source.quote}</blockquote>}
    <div className="ve-sheetCurrent"><span>当前值</span><strong>{field.value === '' ? '未填写' : field.value}</strong></div>
    {field.tag === '用户更正' ? <p className="ve-sheetNote">该字段原为材料摘取，已由用户更正；原摘取内容仍保留在上方。</p>
      : field.tag === '待核对' ? <p className="ve-sheetNote">该字段尚未核实。缺失信息不会被当作 0，也不会自动推断为“无”。</p>
        : <p className="ve-sheetNote">该字段由评估师填写，或来自当前项目信息版本。</p>}
  </Modal>
}

function DocumentSheet(props: { state: ExperienceState; sheet: Extract<SheetState, { kind: 'document' }>; onClose: () => void }): React.ReactElement {
  const file = props.state.materials.flatMap((source) => source.files).find((item) => item.id === props.sheet.id)
  if (file === undefined) return <Modal title="资料摘取" onClose={props.onClose}><p>没有找到这份资料。</p></Modal>
  return <Modal title={file.name} kicker="资料摘取" onClose={props.onClose} actions={
    <button type="button" className="ve-btn ve-btnSecondary" onClick={props.onClose}>关闭</button>
  }>
    <p className="ve-sheetMeta">{file.pages === null ? '未读取' : `${String(file.pages.length)} 页`} · {file.note}</p>
    {file.fields.length === 0
      ? <p className="ve-sheetNote">该类资料在演示环境中不做识别。</p>
      : <ul className="ve-modalList">{file.fields.map((name) => {
        const field = props.state.fields.find((item) => item.label === name)
        return <li key={name}><span>{name}</span><strong>{field === undefined || field.value === '' ? '未填写' : field.value}</strong></li>
      })}</ul>}
    {props.state.mode === 'demo' ? <p className="ve-sheetNote">以上为虚构示例的演示摘取，不会读取本机真实文件。</p> : null}
  </Modal>
}

function TemplateSheet(props: { state: ExperienceState; onClose: () => void }): React.ReactElement {
  const template = props.state.draft.template
  return <Modal title={template?.name ?? '未选择模板'} kicker="计算表模板" onClose={props.onClose} actions={
    <button type="button" className="ve-btn ve-btnSecondary" onClick={props.onClose}>关闭</button>
  }>
    <p>{template === null ? '本轮没有选择计算表模板。' : '模板已带入项目，真实结构解析与重算尚未接通。'}</p>
    {template?.demo === true ? <p className="ve-sheetNote">示例模板只用于演示字段需求，没有解析真实工作簿，也不执行真实重算。</p> : null}
  </Modal>
}

function ConceptSheet(props: { onClose: () => void }): React.ReactElement {
  return <Modal title="关于这个演示" kicker="概念原型" onClose={props.onClose} wide actions={
    <button type="button" className="ve-btn ve-btnSecondary" onClick={props.onClose}>知道了</button>
  }>
    <p>这是一个本地概念页面，用来演示“同一估值对象贯穿六个环节”的工作方式。示例项目、资料、案例与挂牌记录均为虚构。</p>
    <ul className="ve-modalList">
      <li><span>方法边界</span><strong>市场法为当前唯一可执行方法</strong></li>
      <li><span>价格边界</span><strong>示例挂牌不等于成交</strong></li>
      <li><span>计算边界</span><strong>不输出金额结论</strong></li>
      <li><span>数据边界</span><strong>示例数据不读取本机文件</strong></li>
      <li><span>缺失边界</span><strong>未填写不等于 0</strong></li>
    </ul>
  </Modal>
}

function NoteSheet(props: {
  state: ExperienceState
  sheet: Extract<SheetState, { kind: 'note' }>
  controller: ValuationExperienceController
  onClose: () => void
}): React.ReactElement {
  const entry = props.state.adopted.find((item) => item.id === props.sheet.caseId)
  const [note, setNote] = React.useState(entry?.note ?? '')
  return <Modal title="复核说明" kicker={entry?.id ?? ''} onClose={props.onClose} actions={<>
    <button type="button" className="ve-btn ve-btnSecondary" onClick={props.onClose}>取消</button>
    <button type="button" className="ve-btn ve-btnPrimary" onClick={() => { props.controller.saveNote(props.sheet.caseId, note.trim()) }}>保存说明</button>
  </>}>
    <p>记录采用该案例时需要注意的差异或判断。</p>
    <textarea className="ve-textarea" value={note} rows={4} placeholder="例如：面积接近，但楼层与建成年份需在详情页补核。"
      onChange={(event) => { setNote(event.target.value) }} />
  </Modal>
}

export function CloseButton(props: { onClick: () => void }): React.ReactElement {
  return <button type="button" className="ve-iconBtn" aria-label="关闭" onClick={props.onClick}><XIcon size={15} /></button>
}

export function BuildingMark(): React.ReactElement {
  return <span className="ve-objectIcon"><BuildingIcon size={17} /></span>
}
