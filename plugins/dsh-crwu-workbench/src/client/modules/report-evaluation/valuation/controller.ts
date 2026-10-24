/**
 * Controller for the redesigned valuation experience.
 *
 * It composes the real intake controller (files, template, handoff) and the live
 * workflow controller (host plan, questionnaire, candidates). No React, no DOM.
 * A demo run is only created by an explicit employee action and stays marked as demo.
 */
import type { ReportEvaluationController } from '../controller.ts'
import type { ValuationWorkflowController, ValuationWorkflowControllerState } from '../workflow-controller.ts'
import type { ValuationPageState } from '../model/valuation-state.ts'
import type { ValuationQuestionAnswer, ValuationQuestionEdit } from '../../../../shared/contracts/valuation-questionnaire.ts'
import {
  adoptedCsv,
  applyIntakeField,
  asArray,
  buildPlan,
  chooseConflict,
  confirmPlan as confirmPlanState,
  completeCaseCheck as completeCaseCheckState,
  confirmInfo as confirmInfoState,
  dismissAreaRange,
  emptyChecks,
  fieldsFromWorkspace,
  generatePlan as generatePlanState,
  includedRows,
  initialExperienceState,
  loadDemoState,
  materialsFromEvaluation,
  nowLabel,
  patchDraft,
  planFromHost,
  planStatusOf,
  record,
  removeAdopted as removeAdoptedState,
  removeDemoSource,
  retrieveCases as retrieveCasesState,
  saveCaseNote,
  saveInfo as saveInfoState,
  savePlanConditions as savePlanConditionsState,
  setIntakeStage,
  setTemplate,
  setView,
  setWorkspaceStep,
  submitPlan as submitPlanState,
  syncHost,
  text,
  toggleAdopt as toggleAdoptState,
  toggleCaseCheck,
  toggleConfirmAck,
  toggleDemoFile,
  type ExperienceState,
  type FieldView,
  type IntakeStage,
  type PlanConditions,
  type SheetState,
  type WorkflowStep,
} from './model.ts'

export interface ValuationExperienceController {
  getState: () => ExperienceState
  subscribe: (listener: (state: ExperienceState) => void) => () => void

  setView: (view: ExperienceState['view']) => void
  setIntakeStage: (stage: IntakeStage) => void
  setWorkspaceStep: (step: WorkflowStep) => void
  openInfo: () => void
  closeInfo: () => void
  setInfoTab: (tab: ExperienceState['infoTab']) => void

  selectObject: (category: '' | 'realestate') => void
  setField: (field: string, value: string) => void
  setDraftValues: (values: Record<string, string> | null) => void
  chooseArea: (choice: 'material' | 'user') => void
  loadDemo: () => void
  toggleDemoFile: (fileId: string) => void
  removeDemoSource: (sourceId: string) => void
  pickFiles: () => void
  pickFolder: () => void
  rescan: () => void
  removeSelection: (path: string) => void
  excludeFile: (path: string) => void
  reincludeFile: (path: string) => void
  pickTemplate: () => void
  clearTemplate: () => void

  goInfo: () => void
  goReview: () => void
  backToObject: () => void
  backToInfo: () => void
  confirmIntake: () => void
  backToHandoffEdit: () => void
  retryHandoff: () => void
  openCreatedSession: () => void
  recoverHandoff: () => void

  refresh: () => void
  confirmInfo: () => void
  saveDraft: () => void
  saveInfo: (values: Record<string, string>) => void
  generatePlan: () => void
  reReason: () => void
  editPlan: () => void
  cancelPlanEdit: () => void
  savePlan: (conditions: PlanConditions) => void
  submitPlan: () => void
  toggleAck: () => void
  confirmPlan: () => void
  retrieveCases: () => void
  toggleAdopt: (caseId: string) => void
  setCaseFilter: (filter: ExperienceState['caseFilter']) => void
  toggleCheck: (caseId: string, key: string) => void
  openNote: (caseId: string) => void
  saveNote: (caseId: string, note: string) => void
  removeAdopted: (caseId: string) => void
  completeCaseCheck: () => void
  exportCsv: () => string
  openArtifact: (kind: string) => void

  openSheet: (sheet: SheetState) => void
  closeSheet: () => void
  dismissAreaRange: () => void
  dismissError: () => void

  dispose: () => void
}

export interface ValuationExperienceOptions {
  evaluation: ReportEvaluationController
  workflow?: ValuationWorkflowController
  clock?: () => number
  /** Download hook; the default uses a browser Blob. Tests inject a collector. */
  download?: (fileName: string, content: string) => void
}

function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? path
}

export function createValuationExperienceController(options: ValuationExperienceOptions): ValuationExperienceController {
  const clock = options.clock ?? Date.now
  let state: ExperienceState = initialExperienceState()
  const listeners = new Set<(next: ExperienceState) => void>()
  let evaluationState: ValuationPageState = options.evaluation.getState()
  let workflowState: ValuationWorkflowControllerState | null = options.workflow?.getState() ?? null
  let disposed = false

  const emit = (): void => {
    if (disposed) return
    for (const listener of [...listeners]) listener(state)
  }
  const write = (next: ExperienceState): void => {
    state = next
    emit()
  }
  const patch = (part: Partial<ExperienceState>): void => {
    write({ ...state, ...part })
  }
  const toast = (message: string): void => {
    write({ ...state, toast: { text: message, seq: state.toast.seq + 1 } })
  }
  const fail = (message: string): void => {
    write({ ...state, error: message })
  }

  const templateOf = (evaluation: ValuationPageState): ExperienceState['draft']['template'] => {
    const path = text(evaluation.templatePath)
    if (path !== '') {
      return { name: basenameOf(path), size: 0, status: 'pending', demo: false, path }
    }
    if (state.draft.template?.demo === true && state.draft.demo) return state.draft.template
    return null
  }

  const absorbEvaluation = (next: ValuationPageState): void => {
    evaluationState = next
    const materials = materialsFromEvaluation(next, state.draft.sources)
    const template = templateOf(next)
    const patchPart: Partial<ExperienceState> = {
      materials,
      draft: {
        ...state.draft,
        template,
        baseDate: state.draft.baseDate || next.baseDate,
        note: state.draft.note || next.supplementalPrompt,
      },
      evaluationPhase: next.phase,
      handoffCanEdit: next.creationDisposition === 'not-created',
      scan: {
        state: next.scanState,
        error: next.scanError,
        fileCount: next.fileCount,
        limit: next.limit,
        overLimit: next.overLimit,
        truncated: next.truncated,
        readableCount: next.readableCount,
      },
      fields: state.view === 'workspace' && state.mode !== 'demo'
        ? fieldsFromWorkspace({ ...state, draft: { ...state.draft, template } })
        : state.fields,
    }
    state = { ...state, ...patchPart }
    if (state.handoffPending) {
      if (next.phase === 'confirmation' && state.autoConfirm) {
        state = { ...state, busy: true }
        options.evaluation.confirm()
      } else if (next.phase === 'creating-session') {
        state = { ...state, busy: true }
      } else if (next.phase === 'handed-off') {
        state = {
          ...state,
          busy: false,
          handoffPending: false,
          autoConfirm: false,
          view: 'workspace',
          workspaceStep: 'docs',
          mode: state.mode === 'demo' ? 'demo' : 'host',
          toast: { text: '资料与信息已交接给估值工作流', seq: state.toast.seq + 1 },
        }
        options.workflow?.activate().catch(() => undefined)
      } else if (next.phase === 'handoff-failed') {
        state = {
          ...state,
          busy: false,
          handoffPending: false,
          autoConfirm: false,
          error: text(next.error) || '交接没有完成，请根据提示重试',
        }
      }
    }
    emit()
  }

  const absorbWorkflow = (next: ValuationWorkflowControllerState): void => {
    workflowState = next
    const progress = record(next.current?.progress)
    const synced = syncHost(state, {
      current: next.current as unknown as Record<string, unknown> | null,
      progress,
      error: next.error,
    })
    state = synced
    emit()
  }

  const unsubscribeEvaluation = options.evaluation.subscribe(absorbEvaluation)
  const unsubscribeWorkflow = options.workflow?.subscribe(absorbWorkflow) ?? (() => undefined)
  // Project already-loaded state once at creation: returning from another module must not
  // flash an empty intake while waiting for the next controller notification.
  absorbEvaluation(evaluationState)
  if (workflowState !== null) absorbWorkflow(workflowState)

  const hostQuestionnaire = (): Record<string, unknown> | null =>
    record(record(state.host.progress)?.questionnaire)

  /** Merge the panel draft over current field values; unanswered known values may be submitted on confirm. */
  const effectiveValues = (values: Record<string, string>): Record<string, string> => {
    const merged: Record<string, string> = {}
    for (const field of state.fields) merged[field.key] = field.value
    return { ...merged, ...values }
  }

  const hostQuestionAnswers = (nodeId: string, fields: FieldView[], values: Record<string, string>): Record<string, ValuationQuestionAnswer> => {
    const answers: Record<string, ValuationQuestionAnswer> = {}
    for (const field of fields) {
      if (field.nodeId !== nodeId || field.questionId === '') continue
      if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue
      const value = text(values[field.key])
      if (value === '') continue
      if (field.answered && value === field.value) continue
      answers[field.questionId] = field.control === 'select'
        ? { kind: 'choice', values: [value], supplement: '' }
        : { kind: 'value', value, supplement: '' }
    }
    return answers
  }

  const submitHostInfo = (values: Record<string, string>): boolean => {
    const workflow = options.workflow
    const questionnaire = hostQuestionnaire()
    const progress = record(state.host.progress)
    if (workflow?.submitQuestions === undefined) {
      fail('估值工作流的问答通道尚未就绪，答案没有提交')
      return false
    }
    if (workflow === undefined || questionnaire === null || progress === null) {
      fail(workflow === undefined ? '估值工作流服务尚未就绪，信息修改尚未提交' : '当前没有可写的估值工作流，信息修改尚未提交')
      return false
    }
    const revision = typeof progress.revision === 'number' ? progress.revision : 0
    const version = typeof questionnaire.version === 'number' ? questionnaire.version : 0
    const merged = effectiveValues(values)
    const nodes = [...new Set(state.fields.filter((field) => field.nodeId !== '').map((field) => field.nodeId))]
    const pending: Array<{ nodeId: string; answers: Record<string, ValuationQuestionAnswer> }> = []
    for (const nodeId of nodes) {
      const answers = hostQuestionAnswers(nodeId, state.fields, merged)
      if (Object.keys(answers).length > 0) pending.push({ nodeId, answers })
    }
    if (pending.length === 0) return false
    state = { ...state, busy: true, draftValues: null, error: '' }
    emit()
    for (const item of pending) {
      const edit: ValuationQuestionEdit = {
        nodeId: item.nodeId,
        expectedRevision: revision,
        expectedQuestionVersion: version,
        answers: item.answers,
        supplement: '',
        noteEdits: {},
      }
      void workflow.submitQuestions?.(edit).then((ok) => {
        if (!ok) {
          state = { ...state, busy: false }
          fail(workflow.getState().error || '答案未被估值工作流接收，请刷新后重试')
          emit()
          return
        }
        const submittedKeys = new Set(Object.keys(item.answers).map((questionId) => state.fields.find((field) => field.questionId === questionId)?.key ?? ''))
        state = {
          ...state,
          fields: state.fields.map((field) => {
            if (field.nodeId !== item.nodeId || !submittedKeys.has(field.key)) return field
            const value = text(merged[field.key])
            return { ...field, value, answered: true, tag: field.tag === '材料摘取' ? '用户更正' : field.tag === '待核对' ? '用户填写' : field.tag }
          }),
          draftValues: null,
          notice: '答案已提交给估值工作流，等待回执刷新',
        }
        emit()
        void workflow.refresh()
      })
    }
    return true
  }

  const submitHostSelection = (caseIds: string[]): void => {
    const workflow = options.workflow
    const questionnaire = hostQuestionnaire()
    const progress = record(state.host.progress)
    if (workflow?.submitQuestions === undefined) {
      fail('估值工作流的问答通道尚未就绪，案例选择没有提交')
      return
    }
    if (workflow === undefined || questionnaire === null || progress === null) {
      fail('当前没有可写的估值工作流')
      return
    }
    const questions = asArray(questionnaire.questions).map((raw) => record(raw)).filter((item): item is Record<string, unknown> => item !== null)
    const nodeId = questions.map((item) => text(item.nodeId)).find((id) => id === 'select-cases' || id.endsWith(':select-cases'))
    if (nodeId === undefined) {
      fail('估值工作流尚未到达案例选择步骤')
      return
    }
    const caseQuestion = questions.find((item) => text(item.nodeId) === nodeId && text(item.field) === 'caseIds')
    const searchQuestion = questions.find((item) => text(item.nodeId) === nodeId && text(item.field) === 'searchDecision')
    if (caseQuestion === undefined) {
      fail('估值工作流没有提供案例选择问题')
      return
    }
    const answers: Record<string, ValuationQuestionAnswer> = {}
    answers[text(caseQuestion.questionId)] = {
      kind: 'choice',
      values: caseIds.length > 0 ? caseIds : ['none'],
      supplement: '',
    }
    if (searchQuestion !== undefined) {
      answers[text(searchQuestion.questionId)] = { kind: 'choice', values: ['stop'], supplement: '' }
    }
    const assumption = questions.find((item) => text(item.nodeId) === nodeId && text(item.field) === 'assumptions')
    if (assumption !== undefined) {
      answers[text(assumption.questionId)] = { kind: 'choice', values: ['blank'], supplement: '' }
    }
    const revision = typeof progress.revision === 'number' ? progress.revision : 0
    const version = typeof questionnaire.version === 'number' ? questionnaire.version : 0
    state = { ...state, busy: true, error: '' }
    emit()
    void workflow.submitQuestions?.({
      nodeId,
      expectedRevision: revision,
      expectedQuestionVersion: version,
      answers,
      supplement: '',
      noteEdits: {},
    }).then((ok) => {
      state = { ...state, busy: false }
      if (!ok) {
        fail(workflow.getState().error || '案例选择未被估值工作流接收')
        emit()
        return
      }
      emit()
      void workflow.refresh()
    })
  }

  const selectCaseIds = (): string[] => state.candidates.filter((c) => c.selection === 'selected').map((c) => c.id)

  const downloadCsv = (): string => {
    const csv = adoptedCsv(state)
    const fileName = `采用案例清单_${nowLabel(clock).slice(0, 10).replace(/-/g, '')}.csv`
    if (options.download !== undefined) options.download(fileName, csv)
    else if (typeof document !== 'undefined') {
      const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }
    state = { ...state, toast: { text: '已导出采用清单 CSV', seq: state.toast.seq + 1 } }
    emit()
    return csv
  }

  const controller: ValuationExperienceController = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setView: (view) => { write(setView(state, view)) },
    setIntakeStage: (stage) => { write(setIntakeStage(state, stage)) },
    setWorkspaceStep: (step) => { write(setWorkspaceStep(state, step)) },
    openInfo: () => { patch({ infoOpen: true }) },
    closeInfo: () => { patch({ infoOpen: false }) },
    setInfoTab: (tab) => { patch({ infoTab: tab }) },

    selectObject: (category) => {
      if (category !== 'realestate') return
      write(patchDraft(state, { category }))
    },
    setField: (field, value) => {
      write({ ...applyIntakeField(state, field, value), error: '' })
    },
    setDraftValues: (values) => { patch({ draftValues: values }) },
    chooseArea: (choice) => { write(chooseConflict(state, choice)) },
    loadDemo: () => { write(loadDemoState(state, state.draft.projectId || undefined)) },
    toggleDemoFile: (fileId) => { write(toggleDemoFile(state, fileId)) },
    removeDemoSource: (sourceId) => { write(removeDemoSource(state, sourceId)) },
    pickFiles: () => { options.evaluation.pickFiles() },
    pickFolder: () => { options.evaluation.pickFolder() },
    rescan: () => { options.evaluation.rescan() },
    removeSelection: (path) => { options.evaluation.removeSelection(path) },
    excludeFile: (path) => { options.evaluation.excludeFile(path) },
    reincludeFile: (path) => { options.evaluation.reincludeFile(path) },
    pickTemplate: () => { options.evaluation.pickTemplate() },
    clearTemplate: () => {
      options.evaluation.clearTemplate()
      write(setTemplate({ ...state, draft: { ...state.draft, demo: false } }, null))
    },

    goInfo: () => {
      if (state.draft.category === '') {
        fail('请先选择评估对象')
        return
      }
      write({ ...state, error: '', intakeStage: 'info', view: 'intake', checks: { ...state.checks, docs: state.materials.length > 0 ? 'done' : state.checks.docs } })
    },
    goReview: () => {
      const hasDoc = includedRows(state).length > 0
      const hasInput = countFilled(state) > 0
      if (!hasDoc && !hasInput) {
        fail('请选择资料，或至少填写一项信息')
        return
      }
      write({ ...state, error: '', intakeStage: 'review', view: 'intake', checks: { ...state.checks, info: 'needs' } })
    },
    backToObject: () => { write({ ...state, intakeStage: 'object', error: '' }) },
    backToInfo: () => { write({ ...state, intakeStage: 'info', error: '' }) },
    openCreatedSession: () => { options.evaluation.openCreatedSession() },
    recoverHandoff: () => {
      state = { ...state, busy: true, handoffPending: true, autoConfirm: true, error: '' }
      emit()
      options.evaluation.confirm()
    },
    backToHandoffEdit: () => {
      const current = options.evaluation.getState()
      if (current.creationDisposition === 'created' || current.parentSessionId !== '') {
        fail('估值会话已经创建，不能返回修改；请打开估值会话或重试交接')
        return
      }
      options.evaluation.backToEdit()
      write({
        ...state,
        view: 'intake',
        intakeStage: 'review',
        handoffPending: false,
        autoConfirm: false,
        busy: false,
        error: '',
        evaluationPhase: 'draft',
      })
    },
    retryHandoff: () => {
      if (options.evaluation.getState().phase === 'handoff-failed') options.evaluation.backToEdit()
      controller.confirmIntake()
    },
    confirmIntake: () => {
      if (state.draft.category === '') {
        fail('请先选择评估对象')
        return
      }
      if (state.scan.overLimit || state.scan.truncated) {
        fail('资料清单未完整读取（安全上限截断），请缩小本次范围后再确认')
        return
      }
      if (state.draft.template?.demo !== true && state.draft.template === null && state.materials.length === 0 && countFilled(state) === 0) {
        fail('请选择资料，或至少填写一项信息')
        return
      }
      const conflict = includedRows(state).length > 0 ? state.draft.conflict : null
      if (conflict !== null && conflict.choice === null) {
        fail('请先选择建筑面积采用哪一个值')
        return
      }
      if (state.mode === 'demo') {
        write(startDemoWorkspace(state, clock))
        return
      }
      const evaluation = options.evaluation.getState()
      if (evaluation.phase !== 'draft') {
        fail('当前估值输入正在处理，请稍后再确认')
        return
      }
      options.evaluation.setAssetType('real-estate')
      options.evaluation.setMethod('market')
      options.evaluation.setBaseDate(state.draft.baseDate)
      options.evaluation.setPrompt(state.draft.note)
      write({ ...state, busy: true, error: '', handoffPending: true, autoConfirm: true, notice: '正在准备资料归档与确认信息…' })
      options.evaluation.preparePreview()
    },

    refresh: () => {
      if (state.mode === 'demo') {
        toast('示例项目不使用估值工作流')
        return
      }
      if (options.workflow === undefined) {
        fail('估值工作流服务尚未就绪')
        return
      }
      patch({ error: '' })
      void options.workflow.activate().then(() => options.workflow?.refresh()).catch(() => undefined)
    },
    confirmInfo: () => {
      if (state.mode === 'host' && options.workflow !== undefined) {
        const unanswered = state.fields.some((field) => field.questionId !== '' && !field.answered && field.value !== '')
        if (unanswered && submitHostInfo({})) {
          state = { ...state, notice: '已提交待确认的信息答案，等待估值工作流回执' }
          emit()
          return
        }
      }
      const next = confirmInfoState(state)
      write({ ...next, error: next.error })
      if (next.error === '' && state.mode === 'host' && options.workflow !== undefined) void options.workflow.refresh()
    },
    saveDraft: () => {
      write({ ...state, draft: { ...state.draft, savedAt: nowLabel(clock) }, toast: { text: '草稿已保存到当前项目', seq: state.toast.seq + 1 } })
    },
    saveInfo: (values) => {
      if (state.mode === 'host') {
        if (!submitHostInfo(values)) {
          state = { ...state, busy: false, draftValues: null, notice: '没有需要提交的新答案；可刷新后查看工作流的最新问题' }
          emit()
        }
        return
      }
      write({ ...saveInfoState(state, values), error: '' })
    },
    generatePlan: () => {
      const plan = generatePlanState(state)
      const restricted = state.mode === 'host'
      write({ ...plan, error: restricted ? '' : plan.error })
      if (restricted) {
        patch({ workspaceStep: 'reasoning' })
        if (options.workflow !== undefined) void options.workflow.refresh()
      }
    },
    reReason: () => {
      if (state.mode === 'host') {
        if (options.workflow !== undefined) void options.workflow.refresh()
        toast('已请求刷新估值工作流的当前方案')
        return
      }
      const next = generatePlanState({ ...state, plan: state.plan })
      write({ ...next, error: '', notice: `已按信息 v${state.infoVersion} 重新推理，方案 r${next.plan?.rev ?? 0} 待确认` })
    },
    editPlan: () => {
      if (state.plan === null) return
      const status = planStatusOf(state)
      if (status === 'stale' || status === 'confirmed' || state.mode === 'host') {
        fail(state.mode === 'host'
          ? '方案由估值工作流生成；如需调整，请在项目信息中提交补充要求后重新推理'
          : status === 'stale' ? '方案已过期，请先重新推理' : '已确认方案不能直接调整')
        return
      }
      patch({ planEditing: true })
    },
    cancelPlanEdit: () => { patch({ planEditing: false }) },
    savePlan: (conditions) => { write(savePlanConditionsState(state, conditions)) },
    submitPlan: () => { write(submitPlanState(state)) },
    toggleAck: () => { write(toggleConfirmAck(state)) },
    confirmPlan: () => {
      if (state.mode === 'host') {
        const workflow = options.workflow
        const plan = state.plan
        if (workflow === undefined || plan === null) {
          fail('当前方案缺少 Host 回执，暂不能确认')
          return
        }
        if (!state.confirmAck) {
          fail('请先勾选复核确认')
          return
        }
        const progress = record(state.host.progress)
        const questionnaire = record(progress?.questionnaire)
        const revision = progress !== null && typeof progress.revision === 'number' ? progress.revision : plan.rev
        const version = questionnaire !== null && typeof questionnaire.version === 'number' ? questionnaire.version : 0
        const legacyPlan = record(progress?.plan) !== null
        state = { ...state, busy: true, error: '' }
        emit()
        if (legacyPlan && plan.digest !== '') {
          void workflow.approvePlan({ expectedRevision: revision, planDigest: plan.digest })
            .then((ok) => {
              state = { ...state, busy: false, confirmAck: false }
              if (!ok) fail(workflow.getState().error || '方案确认没有被估值工作流接受')
              else state = { ...state, toast: { text: '方案已确认，等待估值工作流完成案例获取', seq: state.toast.seq + 1 } }
              emit()
            })
          return
        }
        // Template-market v2 confirms through the `confirm-plan` question; `approvePlan`
        // only owns the legacy plan receipt and would refuse when that receipt is null.
        const questions = asArray(questionnaire?.questions).map((item) => record(item)).filter((item): item is Record<string, unknown> => item !== null)
        const approval = questions.find((item) => text(item.field) === 'approval' && text(item.nodeId).includes('confirm-plan'))
        if (approval === undefined) {
          state = { ...state, busy: false }
          fail('估值工作流尚未提供方案确认问题，请刷新后重试')
          emit()
          return
        }
        const nodeId = text(approval.nodeId)
        const answers: Record<string, ValuationQuestionAnswer> = {
          [text(approval.questionId)]: { kind: 'choice', values: ['accept'], supplement: '' },
        }
        void workflow.submitQuestions?.({
          nodeId,
          expectedRevision: revision,
          expectedQuestionVersion: version,
          answers,
          supplement: '',
          noteEdits: {},
        }).then((ok) => {
          state = { ...state, busy: false, confirmAck: false }
          if (!ok) fail(workflow.getState().error || '方案确认没有被估值工作流接受')
          else state = { ...state, toast: { text: '方案确认已提交，等待估值工作流回执', seq: state.toast.seq + 1 } }
          emit()
          if (ok) void workflow.refresh()
        })
        return
      }
      const next = confirmPlanState(state)
      write({ ...next, error: next.error })
    },
    retrieveCases: () => {
      if (state.mode === 'host') {
        if (options.workflow !== undefined) void options.workflow.refresh()
        toast('正在读取估值工作流的检索进度')
        return
      }
      const next = retrieveCasesState(state)
      write({ ...next, error: next.error })
    },
    toggleAdopt: (caseId) => {
      if (state.mode === 'host') {
        const selected = new Set(selectCaseIds())
        if (selected.has(caseId)) selected.delete(caseId)
        else {
          if (selected.size >= 4) {
            fail('最多采用 4 个案例，请先取消一个')
            return
          }
          selected.add(caseId)
        }
        submitHostSelection([...selected])
        return
      }
      const next = toggleAdoptState(state, caseId)
      write({ ...next, error: next.error })
    },
    setCaseFilter: (filter) => { patch({ caseFilter: filter }) },
    toggleCheck: (caseId, key) => {
      const next = toggleCaseCheck(state, caseId, key)
      write({ ...next, error: next.error })
    },
    openNote: (caseId) => { patch({ sheet: { kind: 'note', caseId } }) },
    saveNote: (caseId, note) => { write(saveCaseNote(state, caseId, note)) },
    removeAdopted: (caseId) => {
      if (state.mode === 'host') {
        const selected = selectCaseIds().filter((id) => id !== caseId)
        submitHostSelection(selected)
        return
      }
      const next = removeAdoptedState(state, caseId)
      write({ ...next, error: next.error })
    },
    completeCaseCheck: () => {
      const next = completeCaseCheckState(state)
      write({ ...next, error: next.error })
    },
    exportCsv: () => downloadCsv(),
    openArtifact: (kind) => {
      if (options.workflow === undefined) {
        fail('估值工作流服务尚未就绪')
        return
      }
      void options.workflow.openArtifact(kind)
    },

    openSheet: (sheet) => { patch({ sheet }) },
    closeSheet: () => { patch({ sheet: null }) },
    dismissAreaRange: () => { write(dismissAreaRange(state)) },
    dismissError: () => { patch({ error: '' }) },

    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribeEvaluation()
      unsubscribeWorkflow()
      listeners.clear()
    },
  }
  return controller
}

function countFilled(state: ExperienceState): number {
  const draft = state.draft
  return ['projectName', 'city', 'community', 'location', 'usage', 'area', 'baseDate', 'note']
    .filter((key) => text((draft as unknown as Record<string, unknown>)[key]) !== '').length
}

function startDemoWorkspace(state: ExperienceState, clock: () => number): ExperienceState {
  const area = Number.parseFloat(text(state.draft.area)) || 89.5
  const fields = fieldsFromWorkspace({ ...state, mode: 'demo' })
  return {
    ...state,
    view: 'workspace',
    intakeStage: 'review',
    workspaceStep: 'docs',
    mode: 'demo',
    fields,
    infoVersion: 1,
    plan: null,
    planHistory: [],
    candidates: [],
    adopted: [],
    checks: { docs: 'done', info: 'done', plan: 'todo', cases: 'todo', caseCheck: 'todo' },
    confirmAck: false,
    busy: false,
    error: '',
    notice: '示例项目已进入六步估值工作面；所有案例与方案均为演示数据。',
    toast: { text: '已进入示例估值工作面', seq: state.toast.seq + 1 },
    draft: { ...state.draft },
    materials: state.materials,
    history: state.history.length > 0 ? state.history : [{ version: 1, at: nowLabel(clock), author: '示例评估师', note: '从示例资料摘取并建档', changes: [] }],
  }
}
