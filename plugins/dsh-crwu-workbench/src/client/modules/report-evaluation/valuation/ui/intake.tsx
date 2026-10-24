import * as React from 'react'
import type { ExperienceState, FieldView, MaterialFile, MaterialRow, MaterialSource } from '../model.ts'
import {
  activeConflict,
  areaTagOf,
  conflictPending,
  countPending,
  filledCount,
  formatSize,
  fullLocation,
  includedRows,
  infoGate,
  materialRows,
  materialStats,
  missingRequired,
  readableCount,
  typeLabelOf,
} from '../model.ts'
import type { ValuationExperienceController } from '../controller.ts'
import { ArrowRight, CheckIcon, ChevronLeft, ChevronRight, FileIcon, FolderIcon, InfoIcon, ScaleIcon, SaveIcon, SheetIcon, BuildingIcon, ChipIcon, ChartIcon, DotsIcon, LockIcon } from './icons.tsx'
import { Modal, Toast } from './shell.tsx'

const INTAKE_STEPS: ReadonlyArray<{ key: 'object' | 'info' | 'review' | 'handoff'; label: string }> = [
  { key: 'object', label: '选择对象' },
  { key: 'info', label: '资料与信息' },
  { key: 'review', label: '核对提交' },
  { key: 'handoff', label: '进入工作台' },
]

export function IntakeExperience(props: {
  state: ExperienceState
  controller: ValuationExperienceController
  onBackOverview: () => void
}): React.ReactElement {
  const { state, controller } = props
  const stage = state.intakeStage
  const current = stage === 'object' ? 0 : stage === 'info' ? 1 : 2
  return <div className="ve-intake" data-valuation-intake="true" data-workflow-step="valuation" data-intake-stage={stage} data-intake-mode={state.mode}>
    <IntakeTop state={state} controller={controller} onBackOverview={props.onBackOverview} />
    <nav className="ve-stepper" aria-label="估值资料进度" data-intake-stepper="true">
      <div className="ve-stepperInner">
        {INTAKE_STEPS.map((item, index) => {
          const done = index < current
          const active = index === current
          const disabled = item.key === 'handoff' || controller === undefined
          return <button key={item.key} type="button"
            className={`ve-step${active ? ' is-active' : ''}${done ? ' is-done' : ''}`}
            data-step={item.key}
            aria-current={active ? 'step' : undefined}
            disabled={disabled}
            onClick={() => {
              if (item.key === 'object') controller.backToObject()
              else if (item.key === 'info') controller.setIntakeStage('info')
              else if (item.key === 'review') controller.goReview()
            }}>
            <span className="ve-stepDot">{done ? <CheckIcon size={13} /> : <span>{`0${index + 1}`}</span>}</span>
            <span className="ve-stepLabel">{item.label}</span>
          </button>
        })}
      </div>
    </nav>
    <main className="ve-stage">
      <div className="ve-canvas">
        {state.error === '' ? null : <div className="ve-banner is-warn" role="alert" data-intake-error="true"><InfoIcon size={15} /><span>{state.error}</span><button type="button" className="ve-textBtn is-muted" onClick={controller.dismissError}>关闭</button></div>}

        {stage === 'object'
          ? <ObjectView state={state} controller={controller} />
          : stage === 'review'
            ? <ReviewView state={state} controller={controller} />
            : <InfoView state={state} controller={controller} />}
      </div>
    </main>
    <IntakeActionbar state={state} controller={controller} />
    <HandoffOverlay state={state} controller={controller} />
    <Toast state={state} />
    <IntakeSheets state={state} controller={controller} />
  </div>
}

function IntakeTop(props: { state: ExperienceState; controller: ValuationExperienceController; onBackOverview: () => void }): React.ReactElement {
  const { state, controller } = props
  const saving = state.draft.savedAt !== '' ? `草稿已保存 ${state.draft.savedAt.slice(11)}` : '本地草稿'
  return <header className="ve-top">
    <div className="ve-topInner">
      <nav className="ve-crumb" aria-label="当前位置">
        <button type="button" className="ve-crumbLink" data-back-overview="true" onClick={props.onBackOverview}>资产评估</button>
        <span className="ve-sep" aria-hidden="true">/</span>
        <span className="ve-crumbCur">01 估值</span>
      </nav>
      <div className="ve-topTitle">
        <h1>资料与信息</h1>
        <span className={`ve-chip${state.mode === 'demo' ? ' is-demo' : ''}`}><span className="ve-dot" />{state.mode === 'demo' ? '示例数据' : state.mode === 'host' ? '已有估值项目' : '概念原型 · 未接读取'}</span>
      </div>
      <div className="ve-topRight">
        {state.host.projectId === '' ? null : <span className="ve-saveState"><span className="ve-saveDot" />已有项目</span>}
        <span className={`ve-saveState${state.error !== '' ? ' is-warn' : ''}`} data-intake-save-state="true"><span className="ve-saveDot" />{saving}</span>
        <button type="button" className="ve-textBtn" onClick={() => controller.openSheet({ kind: 'concept' })}>流程说明</button>
      </div>
    </div>
  </header>
}

function ObjectView(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const selected = state.draft.category === 'realestate'
  return <div className="ve-objectWrap" data-intake-object="true">
    <div className="ve-objectHero">
      <h2>本次评估什么资产？</h2>
      <p>先选定资产类别，再把资料与已知信息放在一起。当前只接通房地产与市场法案例准备，其他类别会明确标记为未接通，不做不可用的入口。</p>
    </div>
    <div className="ve-objectGrid">
      <button type="button" className={`ve-objectCard${selected ? ' is-selected' : ''}`} data-object-category="realestate"
        onClick={() => { controller.selectObject('realestate') }}>
        <span className="ve-objectState">{selected ? <><CheckIcon size={13} />已选择</> : <><LockIcon size={13} />可进入</>}</span>
        <span className="ve-objectIcon"><BuildingIcon size={17} /></span>
        <strong>房地产</strong>
        <span>住宅、商业、办公等；当前已接通市场法案例准备</span>
      </button>
      <button type="button" className="ve-objectCard" disabled data-object-category="machine">
        <span className="ve-objectState"><LockIcon size={13} />暂未接通</span>
        <span className="ve-objectIcon"><ChipIcon size={17} /></span>
        <strong>机器设备</strong>
        <span>设备清单与现场资料</span>
      </button>
      <button type="button" className="ve-objectCard" disabled data-object-category="equity">
        <span className="ve-objectState"><LockIcon size={13} />暂未接通</span>
        <span className="ve-objectIcon"><ChartIcon size={17} /></span>
        <strong>股权 / 无形资产</strong>
        <span>企业价值与无形资产</span>
      </button>
      <button type="button" className="ve-objectCard" disabled data-object-category="other">
        <span className="ve-objectState"><LockIcon size={13} />暂未接通</span>
        <span className="ve-objectIcon"><DotsIcon size={17} /></span>
        <strong>其他资产</strong>
        <span>暂未配置资料与流程</span>
      </button>
    </div>
    <div className="ve-panel ve-objectNote">
      <InfoIcon size={16} />
      <span><strong>选择房地产后</strong>，下一步会接收产权证明、合同、发票、实勘照片等资料，并可选填手头已有的位置、面积、用途。位置和面积可以留空，资料读取后再核对。</span>
    </div>
  </div>
}

function InfoView(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  return <>
    <div className="ve-pageHead">
      <div>
        <p className="ve-pageKicker"><span className="ve-dot" />步骤 2 / 4</p>
        <h2 className="ve-pageTitle">资料与信息</h2>
        <p className="ve-pageLede">把这次评估现有的资料和已知信息放在一起。资料先登记清单，位置、面积等可以等读取后再核对。</p>
      </div>
      <div className="ve-pageActions">
        <button type="button" className="ve-textBtn" data-save-draft="true" onClick={() => controller.saveDraft()}><SaveIcon size={13} />保存草稿</button>
      </div>
    </div>
    <div className="ve-workGrid">
      <div className="ve-colMain">
        <DocsPanel state={state} controller={controller} />
        <TemplatePanel state={state} controller={controller} />
      </div>
      <div className="ve-colSide">
        <InfoForm state={state} controller={controller} />
      </div>
    </div>
  </>
}

function treeOf(files: MaterialFile[], rootLabel: string): {
  folders: Map<string, ReturnType<typeof treeOf>>
  files: MaterialFile[]
} {
  const root: ReturnType<typeof treeOf> = { folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.relPath.split('/').filter(Boolean)
    let dirs = parts.slice(0, -1)
    if (rootLabel !== '' && dirs[0] === rootLabel) dirs = dirs.slice(1)
    let node = root
    for (const dir of dirs) {
      let child = node.folders.get(dir)
      if (child === undefined) {
        child = { folders: new Map(), files: [] }
        node.folders.set(dir, child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

function countTree(node: ReturnType<typeof treeOf>): number {
  let count = node.files.length
  for (const child of node.folders.values()) count += countTree(child)
  return count
}

function fileRowOf(row: MaterialRow, controller: ValuationExperienceController): React.ReactElement {
  const file = row.file
  const off = row.status !== 'included'
  const label = {
    included: '已纳入',
    excluded: '已排除',
    duplicate: '重复',
    unsupported: '不支持',
    'wrong-role': '模板文件',
  }[row.status]
  const stateClass = row.status === 'included' ? ' is-in' : row.status === 'duplicate' ? ' is-dup' : ' is-off'
  const canToggle = row.status === 'included' || row.status === 'excluded'
  const folder = file.relPath.split('/').slice(0, -1).join(' / ')
  return <div className={`ve-fileRow${off ? ' is-off' : ''}`} key={file.id} data-file-row={file.id}>
    <span className={`ve-fileType is-${typeClassOf(file.ext)}`}>{typeLabelOf(file.ext)}</span>
    <span className="ve-fileMain">
      <span className="ve-fileTitle"><span className="ve-fileName" title={file.path || file.relPath}>{file.name}</span></span>
      <span className="ve-fileMeta">{formatSize(file.size)} · {folder === '' ? '根目录' : folder}</span>
      {row.reason === '' ? null : <span className="ve-fileReason">{row.reason}</span>}
    </span>
    <span className="ve-fileSide">
      <span className={`ve-fileState${stateClass}`}>{label}</span>
      {canToggle ? <button type="button" className={`ve-fileToggle${row.status === 'excluded' ? ' is-muted' : ''}`}
        data-toggle-file={file.id} onClick={() => {
          if (file.demoKey !== '') controller.toggleDemoFile(file.id)
          else if (row.status === 'included') controller.excludeFile(file.path)
          else controller.reincludeFile(file.path)
        }}>{row.status === 'included' ? '排除' : '恢复'}</button> : null}
    </span>
  </div>
}

function treeHtml(node: ReturnType<typeof treeOf>, rows: Map<string, MaterialRow>, controller: ValuationExperienceController): React.ReactElement[] {
  const out: React.ReactElement[] = []
  for (const [name, child] of [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
    out.push(<details className="ve-treeFolder" open key={`folder-${name}`}>
      <summary><ChevronRight size={13} className="ve-chev" /><FolderIcon size={13} /><span>{name}</span><span className="ve-folderCount">{countTree(child)} 份</span></summary>
      <div className="ve-treeChildren">{treeHtml(child, rows, controller)}</div>
    </details>)
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    const row = rows.get(file.id)
    if (row !== undefined) out.push(<React.Fragment key={file.id}>{fileRowOf(row, controller)}</React.Fragment>)
  }
  return out
}

function typeClassOf(ext: string): string {
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(ext)) return 'img'
  if (['doc', 'docx', 'xlsx', 'xls'].includes(ext)) return 'doc'
  return 'other'
}

function DocsPanel(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const rows = materialRows(state)
  const stats = materialStats(rows)
  const rowMap = new Map(rows.map((row) => [row.file.id, row]))
  const hasSources = state.materials.length > 0
  return <section className="ve-panel" data-intake-doc-panel="true">
    <div className="ve-panelHead">
      <div><h2>产权与现状资料</h2><p>只登记清单；PDF、图片、Word 均可选择，不支持的类型会保留并说明原因。</p></div>
      <div className="ve-panelSide">
        <button type="button" className="ve-btn ve-btnSecondary ve-btnSm" data-pick-files="true" onClick={controller.pickFiles}><FileIcon size={13} />选择文件</button>
        <button type="button" className="ve-btn ve-btnSecondary ve-btnSm" data-pick-folder="true" onClick={controller.pickFolder}><FolderIcon size={13} />选择文件夹</button>
      </div>
    </div>
    <div className="ve-docToolbar">
      <div className="ve-docStats">
        <span className="ve-statChip is-in"><strong>{stats.included}</strong>纳入</span>
        <span className="ve-statChip"><strong>{stats.excluded}</strong>排除</span>
        <span className="ve-statChip is-dup"><strong>{stats.duplicate}</strong>重复</span>
        {stats.unsupported > 0 ? <span className="ve-statChip"><strong>{stats.unsupported}</strong>不支持</span> : null}
      </div>
      <span className="ve-spacer" />
      <button type="button" className="ve-textBtn is-muted" data-load-demo="true" onClick={() => {
        const dirty = state.materials.length > 0 || filledCount(state.draft) > 0 || state.draft.template !== null
        if (dirty) controller.openSheet({ kind: 'demo' })
        else controller.loadDemo()
      }}><InfoIcon size={13} />载入示例项目</button>
    </div>
    <div className="ve-docList">
      {hasSources ? state.materials.map((source) => {
        const tree = treeOf(source.files, source.kind === 'folder' ? source.label : '')
        return <div className="ve-docSource" key={source.id} data-source={source.id}>
          <div className="ve-docSourceHead">
            <span className="ve-docSourceKind">{source.kind === 'folder' ? '文件夹' : '文件'}</span>
            <strong>{source.label}</strong>
            <span className="ve-docSourceCount">{source.files.length} 份</span>
            <button type="button" className="ve-textBtn is-muted ve-remove" onClick={() => {
              if (source.files.some((file) => file.demoKey !== '')) controller.removeDemoSource(source.id)
              else controller.removeSelection(source.id)
            }}>移除</button>
          </div>
          <div className="ve-tree">{treeHtml(tree, rowMap, controller)}</div>
        </div>
      }) : <div className="ve-docEmpty">
        <span className="ve-docEmptyIcon"><FileIcon size={20} /></span>
        <h3>先加入这个项目的资料</h3>
        <p>选择文件或文件夹后，这里只登记相对路径、文件名、大小和类型。不会上传到外部服务器，也不会对你的文件伪造 OCR 结果。</p>
        <div className="ve-docEmptyActions">
          <button type="button" className="ve-btn ve-btnSecondary" data-empty-pick-files="true" onClick={controller.pickFiles}><FileIcon size={13} />选择文件</button>
          <button type="button" className="ve-btn ve-btnSecondary" onClick={controller.pickFolder}><FolderIcon size={13} />选择文件夹</button>
        </div>
      </div>}
    </div>
    {state.scan.error !== ''
      ? <div className="ve-banner is-warn" role="alert"><InfoIcon size={14} /><span>{state.scan.error}</span></div>
      : null}
    {state.scan.overLimit
      ? <div className="ve-banner is-warn" role="alert"><InfoIcon size={14} /><span>资料清单超过 {state.scan.limit} 份上限，整批未纳入，请缩小本次范围。</span></div>
      : null}
    {state.scan.truncated
      ? <div className="ve-banner is-warn" role="alert"><InfoIcon size={14} /><span>资料清单未完整读取（安全上限截断），不能按“已纳入”确认。</span></div>
      : null}
    {hasSources
      ? <div className="ve-listFoot"><InfoIcon size={13} />文件不会上传；重复只按相对路径与大小标记，字节是否相同由 Host 判断。</div>
      : null}
  </section>
}

function TemplatePanel(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const template = state.draft.template
  return <section className="ve-panel ve-templatePanel" data-intake-template-panel="true">
    <div className="ve-panelHead">
      <div><h2>计算表模板</h2><p>独立区域，与产权资料分开登记</p></div>
      <span className="ve-pill">可选</span>
    </div>
    <div className="ve-panelPad">
      {template === null
        ? <div className="ve-templateEmpty">
          <p>可选。选择一个 .xlsx 计算表模板，后续用于核对对象字段与案例缺项；不做真实公式重算。</p>
          <button type="button" className="ve-btn ve-btnSecondary ve-btnSm" data-pick-template="true" onClick={controller.pickTemplate}><SheetIcon size={13} />选择 .xlsx</button>
        </div>
        : <div className="ve-templateFile">
          <span className="ve-fileType is-doc">XLSX</span>
          <span className="ve-templateMain"><strong>{template.name}</strong><span>{template.size > 0 ? `${formatSize(template.size)} · ` : ''}待检查{template.demo ? ' · 示例模板' : ''}</span></span>
          <span className="ve-templateActions">
            <button type="button" className="ve-fileToggle" onClick={controller.pickTemplate}>更换</button>
            <button type="button" className="ve-fileToggle is-muted" onClick={controller.clearTemplate}>移除</button>
          </span>
        </div>}
      <p className="ve-templateNote">仅登记文件，尚未检查工作簿结构；不会根据文件名推断字段，也不会把模板混入产权资料。</p>
      {state.draft.templateError === ''
        ? null
        : <div className="ve-banner is-warn" role="alert"><InfoIcon size={14} /><span>{state.draft.templateError}</span></div>}
    </div>
  </section>
}

function tagOf(state: ExperienceState, key: string, value: string): { label: string; cls: string } {
  const extracts = state.draft.extracts
  const extract = extracts === null ? undefined : extracts[key]
  if (value === '') return { label: key === 'location' || key === 'usage' ? '待确认' : '可选', cls: ' is-pending' }
  if (extract !== undefined) {
    if (value === extract.value) return { label: '材料摘取', cls: ' is-user' }
    return { label: '用户更正', cls: ' is-user' }
  }
  return { label: '用户填写', cls: ' is-user' }
}

function InfoForm(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const draft = state.draft
  const gate = infoGate(state)
  const existing = state.host.projectId === ''
    ? null
    : <div className="ve-banner is-accent"><InfoIcon size={14} /><span>检测到本机已有估值项目。确认后会更新同一个项目，不会新建重复项目。</span></div>
  return <section className="ve-panel ve-formPanel" data-intake-form-panel="true">
    <div className="ve-panelHead"><div><h2>已知信息</h2><p>已知的先填，资料读取后再核对；不会强制填完所有字段。</p></div><span className="ve-pill is-accent">房地产</span></div>
    <div className="ve-panelPad">
      {existing}
      <div className="ve-field is-full">
        <div className="ve-fieldHead"><label htmlFor="ve-project-name">项目名称</label><span className="ve-fieldSrc">可选</span></div>
        <input className="ve-input" id="ve-project-name" data-intake-field="projectName" value={draft.projectName}
          placeholder="如：滨江花园 3 幢 1802 室 · 市场法案例准备" autoComplete="off"
          onChange={(event) => controller.setField('projectName', event.target.value)} />
      </div>
      <div className="ve-fieldRow">
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-asset-type">房地产资产类别</label><span className="ve-fieldSrc is-user">用户填写</span></div>
          <select className="ve-select" id="ve-asset-type" data-intake-field="assetType" value={draft.assetType}
            onChange={(event) => controller.setField('assetType', event.target.value)}>
            <option value="">请选择</option>
            {['住宅', '商业', '办公', '工业', '其他'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-usage">用途</label><span className={`ve-fieldSrc${tagOf(state, 'usage', draft.usage).cls}`}>{tagOf(state, 'usage', draft.usage).label}</span></div>
          <select className="ve-select" id="ve-usage" data-intake-field="usage" value={draft.usage}
            onChange={(event) => controller.setField('usage', event.target.value)}>
            <option value="">待确认</option>
            {['住宅', '商业', '办公', '工业', '其他'].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </div>
      <div className="ve-fieldRow">
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-city">城市</label><span className="ve-fieldSrc">可选</span></div>
          <input className="ve-input" id="ve-city" data-intake-field="city" value={draft.city} placeholder="如：杭州市" autoComplete="off"
            onChange={(event) => controller.setField('city', event.target.value)} />
        </div>
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-community">小区 / 商圈</label><span className="ve-fieldSrc">可选</span></div>
          <input className="ve-input" id="ve-community" data-intake-field="community" value={draft.community} placeholder="可选，如：滨江花园" autoComplete="off"
            onChange={(event) => controller.setField('community', event.target.value)} />
        </div>
      </div>
      <div className="ve-field">
        <div className="ve-fieldHead"><label htmlFor="ve-location">详细坐落</label><span className={`ve-fieldSrc${tagOf(state, 'location', fullLocation(draft)).cls}`}>{tagOf(state, 'location', fullLocation(draft)).label}</span></div>
        <input className="ve-input" id="ve-location" data-intake-field="location" value={draft.location} placeholder="可待识别；填到门牌或幢室即可" autoComplete="off"
          onChange={(event) => controller.setField('location', event.target.value)} />
      </div>
      <div className="ve-fieldRow">
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-area">建筑面积</label><span className={`ve-fieldSrc${tagOf(state, 'area', draft.area).cls}`}>{tagOf(state, 'area', draft.area).label}</span></div>
          <input className="ve-input" id="ve-area" data-intake-field="area" type="number" min="0" step="0.1" inputMode="decimal"
            value={draft.area} placeholder="㎡ · 可待识别" onChange={(event) => controller.setField('area', event.target.value)} />
        </div>
        <div className="ve-field">
          <div className="ve-fieldHead"><label htmlFor="ve-base-date">评估基准日</label><span className="ve-fieldSrc">可选</span></div>
          <input className="ve-input" id="ve-base-date" data-intake-field="baseDate" type="date" value={draft.baseDate} autoComplete="off"
            onChange={(event) => controller.setField('baseDate', event.target.value)} />
        </div>
      </div>
      <div className="ve-field is-full">
        <div className="ve-fieldHead"><span>评估方法</span><span className="ve-fieldSrc is-user">用户选择</span></div>
        <div className="ve-methodGroup" role="radiogroup" aria-label="评估方法">
          <label className="ve-methodOption is-on" data-method-choice="market">
            <input type="radio" name="ve-method" checked readOnly /><strong>市场法</strong><span>当前可用 · 案例获取</span>
          </label>
          <label className="ve-methodOption is-off">
            <input type="radio" name="ve-method" disabled /><strong>收益法</strong><span>暂未接通</span>
          </label>
          <label className="ve-methodOption is-off">
            <input type="radio" name="ve-method" disabled /><strong>成本法</strong><span>暂未接通</span>
          </label>
        </div>
      </div>
      <div className="ve-field is-full">
        <div className="ve-fieldHead"><label htmlFor="ve-note">补充要求</label><span className="ve-fieldSrc">可选</span></div>
        <textarea className="ve-textarea" id="ve-note" data-intake-field="note" rows={2} value={draft.note}
          placeholder="如：优先同小区、同用途；挂牌价只作背景资料"
          onChange={(event) => controller.setField('note', event.target.value)} />
      </div>
      <p className="ve-formNote"><strong>位置和面积可以留空。</strong>资料读取后会与这里的值并列核对；手填值会标为“用户填写”，不会覆盖材料原文。</p>
      {!gate.ok ? <div className="ve-banner is-warn"><InfoIcon size={14} /><span>还没有选择资料，也没有填写信息。可以任选一种开始，不必先填完所有字段。</span></div> : null}
    </div>
    <div className="ve-sideSummary">
      <div><span>纳入文件</span><strong>{materialStats(materialRows(state)).included}</strong></div>
      <div><span>已填信息</span><strong>{filledCount(draft)}</strong></div>
      <div><span>计算表模板</span><strong>{draft.template === null ? '0' : '1'}</strong></div>
    </div>
  </section>
}

interface CompareRow {
  key: string
  label: string
  source: { value: string; doc: string; page: number; quote: string } | null
  user: string
  use: string
  conflict: boolean
}

function compareRows(state: ExperienceState): CompareRow[] {
  const draft = state.draft
  const extracts = draft.extracts
  const hasDoc = (key: string): boolean => includedRows(state).some((row) => row.file.demoKey === key)
  const conflict = activeConflict(state)
  const rows: CompareRow[] = []
  const location = fullLocation(draft)
  rows.push({
    key: 'location',
    label: '坐落位置',
    source: hasDoc('d1') && extracts !== null ? extracts.location ?? null : null,
    user: location,
    use: location === '' ? '待核对' : extracts !== null && location === extracts.location?.value ? '材料摘取' : extracts !== null ? '用户更正' : '用户填写',
    conflict: false,
  })
  rows.push({
    key: 'area',
    label: '建筑面积',
    source: hasDoc('d1') && extracts !== null ? extracts.area ?? null : null,
    user: conflict === null ? draft.area : conflict.user,
    use: draft.area === '' ? '待核对' : areaTagOf(state),
    conflict: conflict !== null && conflict.choice === null,
  })
  rows.push({
    key: 'usage',
    label: '房屋用途',
    source: hasDoc('d1') && extracts !== null ? extracts.usage ?? null : null,
    user: draft.usage,
    use: draft.usage === '' ? '待核对' : extracts !== null && draft.usage === extracts.usage?.value ? '材料摘取' : extracts !== null ? '用户更正' : '用户填写',
    conflict: false,
  })
  rows.push({
    key: 'built',
    label: '建筑年代',
    source: hasDoc('d3') && extracts !== null ? extracts.built ?? null : null,
    user: '',
    use: hasDoc('d3') ? '材料摘取' : '待核对',
    conflict: false,
  })
  rows.push({
    key: 'rights',
    label: '权利性质',
    source: hasDoc('d1') && extracts !== null ? extracts.rights ?? null : null,
    user: '',
    use: hasDoc('d1') ? '材料摘取' : '待核对',
    conflict: false,
  })
  rows.push({
    key: 'baseDate',
    label: '评估基准日',
    source: null,
    user: draft.baseDate,
    use: draft.baseDate === '' ? '未填写' : '用户填写',
    conflict: false,
  })
  rows.push({
    key: 'method',
    label: '评估方法',
    source: null,
    user: draft.method,
    use: '用户选择',
    conflict: false,
  })
  return rows
}

function ReviewView(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const rows = materialRows(state)
  const stats = materialStats(rows)
  const conflict = activeConflict(state)
  const pending = conflictPending(state)
  return <>
    <div className="ve-pageHead">
      <div>
        <p className="ve-pageKicker"><span className="ve-dot" />步骤 3 / 4</p>
        <h2 className="ve-pageTitle">核对提交</h2>
        <p className="ve-pageLede">确认本次提交的范围，并处理资料候选与手填值之间的差异。未接通的读取能力会如实标注。</p>
      </div>
      <div className="ve-pageActions">
        <button type="button" className="ve-textBtn" data-back-info="true" onClick={controller.backToInfo}><ChevronLeft size={13} />返回修改</button>
      </div>
    </div>
    <ReviewBanner state={state} />
    <div className="ve-summaryStrip">
      <div><span>纳入资料</span><strong>{stats.included}</strong><em>排除 {stats.excluded} · 重复 {stats.duplicate}{stats.unsupported > 0 ? ` · 不支持 ${stats.unsupported}` : ''}</em></div>
      <div><span>已填信息</span><strong>{filledCount(state.draft)}</strong><em>手填与选择</em></div>
      <div><span>计算表模板</span><strong>{state.draft.template === null ? '0' : '1'}</strong><em>{state.draft.template === null ? '未选择' : '待检查'}</em></div>
      <div><span>读取覆盖</span><strong>{readableCount(state)}</strong><em>{state.mode === 'demo' ? '份有演示结果' : '份有读取结果'}</em></div>
    </div>
    <div className="ve-reviewGrid">
      <div className="ve-reviewMain">
        {conflict === null ? null : <ConflictCard state={state} controller={controller} />}
        <section className="ve-panel ve-reviewSection" data-compare-panel="true">
          <div className="ve-panelHead">
            <div><h2>资料候选与我的填写</h2><p>原值与来源并列保留；冲突需在本页处理。</p></div>
            {conflict === null ? null : <span className={`ve-pill ${pending ? 'is-warn' : 'is-success'}`}>{pending ? '1 项面积冲突' : '冲突已处理'}</span>}
          </div>
          <CompareTable state={state} />
        </section>
        <section className="ve-panel ve-reviewSection" data-scope-panel="true">
          <div className="ve-panelHead"><div><h2>本次提交范围</h2><p>进入工作台后会保留同一组资料、手填值和来源。</p></div><span className="ve-pill">{stats.included} 份资料</span></div>
          <div className="ve-reviewList">{includedRows(state).length === 0
            ? <div className="ve-emptyInline">没有纳入资料。提交后工作台会保留手填信息，资料页仍为空。</div>
            : includedRows(state).map((row) => <div className="ve-reviewDoc" key={row.file.id}>
              <span className={`ve-fileType is-${typeClassOf(row.file.ext)}`}>{typeLabelOf(row.file.ext)}</span>
              <span className="ve-reviewDocMain"><strong>{row.file.name}</strong><span>{formatSize(row.file.size)} · {row.file.relPath.split('/').slice(0, -1).join(' / ') || '根目录'}</span></span>
              <span className="ve-reviewDocSide"><span className={`ve-pill${row.file.demoKey !== '' ? ' is-accent' : ''}`}>{row.file.demoKey !== '' ? '示例资料' : '仅登记'}</span></span>
            </div>)}</div>
          <div className="ve-panelHead is-sub"><div><h2>手填信息</h2><p>未填写的可选项不会阻断提交。</p></div></div>
          <ManualMeta state={state} />
        </section>
      </div>
      <div className="ve-reviewSide">
        <section className="ve-panel" data-coverage-panel="true">
          <div className="ve-panelHead"><div><h2>读取覆盖概览</h2><p>逐份文件、逐页状态；示例结果明确标注。</p></div>
            <span className={`ve-readingBadge${state.mode === 'demo' ? '' : ' is-pending'}`}>{state.mode === 'demo' ? '演示读取' : '未接真实读取'}</span>
          </div>
          <CoverageRows state={state} />
        </section>
        <section className="ve-panel" data-template-review-panel="true">
          <div className="ve-panelHead"><div><h2>计算表模板</h2><p>只登记文件与待检查状态。</p></div></div>
          {state.draft.template === null
            ? <div className="ve-emptyInline">本次没有选择计算表模板。</div>
            : <><div className="ve-reviewDoc" data-review-template="true">
              <span className="ve-fileType is-doc">XLSX</span>
              <span className="ve-reviewDocMain"><strong>{state.draft.template.name}</strong><span>{state.draft.template.size > 0 ? `${formatSize(state.draft.template.size)} · ` : ''}待检查 · 不解析结构</span></span>
              <span className="ve-reviewDocSide"><span className={`ve-pill${state.draft.template.demo ? ' is-accent' : ''}`}>{state.draft.template.demo ? '示例模板' : '待检查'}</span></span>
            </div>
            <div className="ve-handoffNote">模板名称与“待检查”状态会随项目带入工作台。真实模板结构尚待检查，示例结构仅用于交互演示。</div></>}
        </section>
        <section className="ve-panel">
          <div className="ve-panelHead"><div><h2>提交后</h2><p>同一项目，不会重新填。</p></div></div>
          <div className="ve-panelPad ve-postNote">
            资料、手填字段、来源、模板和当前节点会保存为工作台可读的项目状态。工作台将停留在<strong>待核对</strong>状态：不会自动生成方案，也不会产生案例或金额结果。
          </div>
          <div className="ve-handoffNote">已有工作台项目可通过总览“继续估值”恢复，不会新建重复项目。</div>
        </section>
      </div>
    </div>
  </>
}

function ReviewBanner(props: { state: ExperienceState }): React.ReactElement {
  const { state } = props
  const hasDemo = state.mode === 'demo' && includedRows(state).some((row) => row.file.demoKey !== '')
  const userFiles = includedRows(state).filter((row) => row.file.demoKey === '').length
  if (hasDemo && userFiles > 0) {
    return <div className="ve-banner is-accent"><InfoIcon size={15} /><span><strong>混合范围：</strong>示例资料使用本地演示读取结果；你自选的 {userFiles} 份文件只登记了路径，尚未接真实读取，不会借用示例内容。</span></div>
  }
  if (hasDemo) {
    return <div className="ve-banner is-accent"><InfoIcon size={15} /><span><strong>演示读取结果：</strong>以下覆盖与候选来自虚构的示例资料，仅用于走通流程。没有上传，也没有对你的真实文件做 OCR。</span></div>
  }
  if (userFiles > 0) {
    return <div className="ve-banner is-warn"><InfoIcon size={15} /><span><strong>尚未接真实读取：</strong>所选文件只登记清单，不能生成提取结果。可以继续进入待核对状态的工作台，不会生成假已核结果。</span></div>
  }
  return <div className="ve-banner"><InfoIcon size={15} /><span>本次没有纳入资料；提交后只带入已填写的信息。</span></div>
}

function CompareTable(props: { state: ExperienceState }): React.ReactElement {
  const rows = compareRows(props.state)
  return <div className="ve-compareWrap">
    <table className="ve-compare">
      <thead><tr><th className="ve-cField">字段</th><th className="ve-cSource">资料原文候选</th><th className="ve-cUser">我的填写</th><th className="ve-cUse">本次采用</th></tr></thead>
      <tbody>{rows.map((row) => {
        const hasSource = row.source !== null
        const sourceText = props.state.draft.extracts === null && !hasSource ? '尚未接真实读取' : '示例资料已排除，无候选'
        return <tr key={row.key}>
          <td className="ve-cField">{row.label}</td>
          <td className="ve-cSource">{hasSource
            ? <><span className="ve-value">{row.source!.value}</span><span className="ve-quote">“{row.source!.quote}”</span><span className="ve-srcMeta">{row.source!.doc} · 第 {row.source!.page} 页</span></>
            : <span className="ve-none">{sourceText}</span>}</td>
          <td className="ve-cUser">{row.user === ''
            ? <span className="ve-none">未填写</span>
            : <><span className="ve-value">{row.user}</span><span className="ve-srcMeta">{row.use}</span></>}</td>
          <td className="ve-cUse"><span className={`ve-use${row.conflict ? ' is-conflict' : ''}`}>{row.conflict ? '待处理' : row.use}</span></td>
        </tr>
      })}</tbody>
    </table>
  </div>
}

function ConflictCard(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement | null {
  const conflict = activeConflict(props.state)
  if (conflict === null) return null
  return <section className="ve-panel ve-conflictCard" data-area-conflict="true">
    <div className="ve-conflictHead">
      <span className="ve-conflictIcon"><InfoIcon size={16} /></span>
      <div><h2>建筑面积有两个值</h2><p>资料原文与手填值不一致。请选择这次提交采用的面积；两个值和来源都会保留在项目记录里。</p></div>
    </div>
    <div className="ve-conflictOptions">
      <label className={`ve-conflictOpt${conflict.choice === 'material' ? ' is-on' : ''}`}>
        <input type="radio" name="ve-area-choice" value="material" checked={conflict.choice === 'material'}
          onChange={() => { props.controller.chooseArea('material') }} />
        <span className="ve-conflictOptMain"><em>保留材料值</em><strong>{conflict.material} ㎡</strong><small>{conflict.doc} · 第 {conflict.page} 页 · 材料摘取</small><q>“{conflict.quote}”</q></span>
      </label>
      <label className={`ve-conflictOpt${conflict.choice === 'user' ? ' is-on' : ''}`}>
        <input type="radio" name="ve-area-choice" value="user" checked={conflict.choice === 'user'}
          onChange={() => { props.controller.chooseArea('user') }} />
        <span className="ve-conflictOptMain"><em>保留我的填写</em><strong>{conflict.user} ㎡</strong><small>用户填写 · 资料入口</small><q>进入工作台后标为“用户更正”，材料原文仍可追溯。</q></span>
      </label>
    </div>
    <div className="ve-conflictFoot">当前提交面积：{props.state.draft.area === '' ? '未填写' : `${props.state.draft.area} ㎡ · ${areaTagOf(props.state)}`}。原值 {conflict.material} / {conflict.user} ㎡ 不会因选择而删除。</div>
  </section>
}

function CoverageRows(props: { state: ExperienceState }): React.ReactElement {
  const rows = includedRows(props.state)
  if (rows.length === 0) return <div className="ve-emptyInline">本次没有纳入的资料文件。你可以返回选择文件，或继续提交已填写的信息。</div>
  return <div className="ve-coverage">
    <div className="ve-coverageLegend">
      <span><i className="ve-legendDot is-read" />已读取</span>
      <span><i className="ve-legendDot is-blank" />空白页</span>
      <span><i className="ve-legendDot is-reg" />已登记</span>
      <span><i className="ve-legendDot is-unread" />未读取</span>
    </div>
    {rows.map((row) => {
      const pages = row.file.pages
      return <div className="ve-coverageRow" key={row.file.id} data-coverage={row.file.id}>
        <div className="ve-coverageTop"><strong>{row.file.name}</strong><span>{pages === null ? '未读取' : `${pages.length} 页`}</span></div>
        <div className="ve-pageChips">{pages === null
          ? <span className="ve-pageChip is-unread">未读取</span>
          : pages.map((code, index) => <span key={`${row.file.id}-${index}`} className={`ve-pageChip is-${code}`} title={`第 ${index + 1} 页`}>P{index + 1}</span>)}</div>
        <p className="ve-coverageNote">{pages === null
          ? '仅登记文件路径，尚未接真实读取'
          : row.file.demoKey === 'd6' || row.file.demoKey === 'd7' ? '图片已登记，不做文字识别' : '演示读取结果，未写入工作台为已核'}</p>
      </div>
    })}
  </div>
}

function ManualMeta(props: { state: ExperienceState }): React.ReactElement {
  const draft = props.state.draft
  const items: Array<[string, string, boolean]> = [
    ['项目名称', draft.projectName, false],
    ['资产类别', draft.assetType, false],
    ['城市 / 小区', [draft.city, draft.community].filter(Boolean).join(' / '), false],
    ['详细坐落', fullLocation(draft), false],
    ['用途', draft.usage, false],
    ['建筑面积', draft.area === '' ? '待识别' : `${draft.area} ㎡ · ${areaTagOf(props.state)}`, false],
    ['评估方法', draft.method, false],
    ['基准日', draft.baseDate, false],
    ['补充要求', draft.note, true],
  ]
  return <div className="ve-metaList">{items.map(([label, value, wide]) => <div key={label} className={wide ? 'is-wide' : ''}>
    <span>{label}</span><strong>{value === '' ? '未填写' : value}</strong>
  </div>)}</div>
}

function IntakeActionbar(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement {
  const { state, controller } = props
  const stats = materialStats(materialRows(state))
  const gate = infoGate(state)
  const pending = conflictPending(state)
  const scanBlocked = state.scan.overLimit || state.scan.truncated
  const stage = state.intakeStage
  const left = <div className="ve-actionSummary">
    <span><strong>{stats.included}</strong> 份纳入</span><span className="ve-actionSep" />
    <span><strong>{filledCount(state.draft)}</strong> 项信息</span><span className="ve-actionSep" />
    <span><strong>{state.draft.template === null ? '0' : '1'}</strong> 套模板</span>
  </div>
  let right: React.ReactNode
  if (stage === 'object') {
    right = <button type="button" className="ve-btn ve-btnPrimary" data-intake-next-info="true"
      disabled={state.draft.category === ''} onClick={controller.goInfo}>下一步，资料与信息<ArrowRight size={15} /></button>
  } else if (stage === 'review') {
    right = <>
      {pending ? <span className="ve-gateHint">请先处理 1 项面积冲突</span> : scanBlocked ? <span className="ve-gateHint">资料清单未完整读取，不能确认</span> : null}
      <button type="button" className="ve-btn ve-btnSecondary" onClick={controller.backToInfo}>返回修改</button>
      <button type="button" className="ve-btn ve-btnPrimary" data-intake-confirm="true"
        disabled={pending || scanBlocked || state.busy || state.handoffPending} onClick={controller.confirmIntake}>
        {state.busy || state.handoffPending ? '正在准备交接…' : '确认信息，进入估值工作面'}{state.busy ? null : <ArrowRight size={15} />}
      </button>
    </>
  } else {
    right = <>
      {!gate.ok ? <span className="ve-gateHint">请选择资料，或至少填写一项信息</span> : null}
      <button type="button" className="ve-btn ve-btnPrimary" data-intake-next-review="true"
        disabled={!gate.ok || state.busy} onClick={controller.goReview}>下一步，核对提交<ArrowRight size={15} /></button>
    </>
  }
  return <footer className="ve-actionbar" data-intake-actionbar="true">
    <div className="ve-actionbarInner">{left}<div className="ve-actionRight">{right}</div></div>
  </footer>
}

function HandoffOverlay(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement | null {
  const { state } = props
  const pending = state.handoffPending || state.evaluationPhase === 'preparing-confirmation' || state.evaluationPhase === 'confirmation' || state.evaluationPhase === 'creating-session'
  if (!pending && state.evaluationPhase !== 'handoff-failed' && state.error === '') return null
  if (state.evaluationPhase === 'handoff-failed') {
    return <Modal title="交接没有完成" kicker="进入工作台" onClose={() => undefined} actions={<>
      {props.state.handoffCanEdit
        ? <button type="button" className="ve-btn ve-btnSecondary" data-handoff-back="true" onClick={() => props.controller.backToHandoffEdit()}>返回资料修改</button>
        : <button type="button" className="ve-btn ve-btnSecondary" data-handoff-open="true" onClick={() => props.controller.openCreatedSession()}>打开估值会话</button>}
      {props.state.handoffCanEdit
        ? <button type="button" className="ve-btn ve-btnPrimary" data-handoff-retry="true" onClick={() => props.controller.retryHandoff()}>重试交接</button>
        : <button type="button" className="ve-btn ve-btnPrimary" data-handoff-recover="true" onClick={() => props.controller.recoverHandoff()}>恢复上一轮交接</button>}
    </>}>
      <p>{state.error === '' ? '估值工作流没有接受这次交接，请查看提示后重试。' : state.error}</p>
      <p className="ve-sheetNote">已选择的资料与填写内容仍保留在当前项目中。</p>
    </Modal>
  }
  if (!pending) return null
  const phases = [
    { key: 'preparing-confirmation', label: '准备归档与确认信息' },
    { key: 'creating-session', label: '创建估值工作流会话' },
    { key: 'handed-off', label: '交接完成' },
  ]
  return <div className="ve-modalLayer" role="presentation">
    <div className="ve-modal ve-handoffModal" role="dialog" aria-modal="true" aria-label="正在进入估值工作面">
      <div className="ve-modalHead"><div><p className="ve-modalKicker">进入工作台</p><h2 className="ve-modalTitle">正在准备交接…</h2></div></div>
      <div className="ve-modalBody">
        <p>资料、手填字段、来源与模板会交给同一个估值工作流。交接完成后才进入六步工作面。</p>
        <ol className="ve-handoffSteps">{phases.map((phase) => {
          const index = phases.findIndex((item) => item.key === state.evaluationPhase)
          const done = state.evaluationPhase === 'handed-off' || (index >= 0 && phases.findIndex((item) => item.key === phase.key) < index)
          return <li key={phase.key} className={done ? 'is-done' : ''}><span>{done ? <CheckIcon size={11} /> : null}</span>{phase.label}</li>
        })}</ol>
        <p className="ve-sheetNote">交接期间不要关闭面板；已有资料不会丢失。</p>
      </div>
    </div>
  </div>
}

function IntakeSheets(props: { state: ExperienceState; controller: ValuationExperienceController }): React.ReactElement | null {
  const { state, controller } = props
  if (state.sheet === null) return null
  if (state.sheet.kind === 'demo') {
    return <Modal title="载入示例项目" kicker="演示数据" onClose={() => controller.closeSheet()} actions={<>
      <button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.closeSheet()}>取消</button>
      <button type="button" className="ve-btn ve-btnPrimary" data-demo-confirm="true" onClick={() => { controller.loadDemo(); controller.closeSheet() }}>载入示例</button>
    </>}>
      <p>这会替换当前已选择的文件与填写内容。示例资料仅用于演示，不会读取真实文件。</p>
      <ul className="ve-modalList">
        <li>虚构的产权资料、合同、照片与文件夹树</li>
        <li>住宅市场法示例模板，状态为“待检查”</li>
        <li>手填信息与面积冲突演示（89.5 / 96.2 ㎡）</li>
      </ul>
    </Modal>
  }
  if (state.sheet.kind === 'concept') {
    return <Modal title="关于这个页面" kicker="流程说明" onClose={() => controller.closeSheet()} wide actions={
      <button type="button" className="ve-btn ve-btnSecondary" onClick={() => controller.closeSheet()}>知道了</button>
    }>
      <p>当前只做资产评估中的“01 估值”。先选择对象与资料，核对后进入六步估值工作面。示例数据不会读取本机文件。</p>
      <ul className="ve-modalList">
        <li><span>资料</span><strong>只登记清单与来源，不伪造 OCR</strong></li>
        <li><span>信息</span><strong>手填值不会覆盖材料原文</strong></li>
        <li><span>方案</span><strong>确认后才允许案例获取</strong></li>
        <li><span>交付</span><strong>本轮不出金额结论</strong></li>
      </ul>
    </Modal>
  }
  return null
}

export function CountOfPending(state: ExperienceState): number {
  return countPending(state.fields)
}

export function MissingOf(state: ExperienceState): FieldView[] {
  return missingRequired(state.fields)
}

export { type ScaleIcon }
