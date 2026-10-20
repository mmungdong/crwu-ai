/**
 * DSH inference adapter for the valuation workflow.
 *
 * Starts one fresh, non-inheriting child per attempt on a provider that actually
 * enforces a structured output schema. Each stage has its own output contract and
 * task instruction; an empty or malformed structured result is not a successful
 * stage. The adapter records the **actual** returned child session id, requires a
 * verifiable local child, disposes the run, and never reports quiescence when
 * stopping the child actually failed. Cancellation forwards the abort, waits for
 * the handle to settle and never publishes a stale result.
 *
 * The start itself goes through `subagent-start.ts`: the loaded DSH line decides
 * whether that is `startActivation` (0.2.x) or `start` (0.1.7).
 */
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { ValuationWorkflowStage } from '../../../shared/contracts/valuation-workflow.ts'
import type { ValuationInferencePort, ValuationInferenceRequest, ValuationInferenceResult } from
  '../../domains/report-evaluation/workflow/ports.ts'
import { STOP_UNKNOWN_ERROR, resolveStopTimeoutMs, stopChild } from './lifecycle.ts'
import { nodeFailure, readNodeFailure } from '../../domains/report-evaluation/workflow/failure.ts'
import { isTemplateRequirements } from '../../domains/report-evaluation/workflow/case-collection.ts'
import { TEMPLATE_ANALYSIS_SCHEMA, TEMPLATE_ANALYSIS_INSTRUCTION } from './template-analysis.ts'
import {
  eligibleProvider, hasSubagentStart, startSubagentChild,
  type SubagentRunLike, type SubagentRuntimeLike, type SubagentStartContextLike,
} from './subagent-start.ts'

/**
 * The caller context the inference adapters need: the subagents service plus,
 * on the activation line, the native `agent/created` lifecycle hook used to
 * restrict the reserved child before its first model turn.
 */
interface InferenceContextLike extends SubagentStartContextLike {
  get(name: string): unknown
}

/** Safe identity of a freshly published stage or isolated-operation child. */
export interface DshWorkflowStageStartedEvent {
  /** Actual native child session id returned by `runtime.start`; never a correlation key. */
  sessionId: string
  nodeId: string
  stage: ValuationWorkflowStage
  /** Isolated non-stage operation; absent for regular stage children. */
  operation?: NonNullable<ValuationInferenceRequest['operation']>
  runId: string
  revision: number
  /** Caller's per-attempt correlation key, kept distinct from the real session id. */
  correlationId: string
}

/** Safe identity of a freshly published router child. */
export interface DshWorkflowIntentStartedEvent {
  sessionId: string
  kind: 'intent'
}

export type DshWorkflowStartedEvent = DshWorkflowStageStartedEvent | DshWorkflowIntentStartedEvent

export interface DshWorkflowInferenceOptions {
  ctx: InferenceContextLike
  parentAgent: unknown
  /** Current workbench workspace the child must be attached to and read back from. */
  workspace?: unknown
  /**
   * Real workspace-session attachment + readback supplied by the Host composition.
   * Required whenever `workspace` is set; without it the adapter fails closed.
   */
  attachWorkspace?: (input: { childId: string; workspace: unknown; parentAgent: unknown }) => Promise<{ ok: boolean; error?: string }>
  /**
   * Durable receipt for the child that was actually published. Awaited right after
   * `runtime.start` returns a real id and before any result is accepted; a rejection
   * stops the child and fails the attempt.
   */
  onStarted?: (event: DshWorkflowStartedEvent) => void | Promise<void>
  /** Maximum time to await child disposal; non-positive or non-finite values use 5000ms. */
  stopTimeoutMs?: number
}

const STAGE_INSTRUCTIONS: Record<ValuationWorkflowStage, string> = {
  elements: '识别并核对基本要素与材料覆盖；基本事实只能以 sourceFacts 输出并绑定材料原文，不猜测缺失事实。'
    + '按当前 routing/confirmedFacts 中选定的唯一对象读取实际材料，能核实的用途/建筑面积直接输出 sourceFacts，'
    + '不重复向用户索要。quote 逐字包含完整字段标签、值和面积单位（表头或数字后缀），区分建筑面积/套内/土地，'
    + '重复的相同用途不视为缺失；对应不清不得猜值。',
  rights: '核对对象身份、原始用途、权利与面积口径；保留原始记载，冲突不得静默取值。',
  plan: '形成方法与计算方案；方法适用性与技术可执行性分别记录。',
  evidence: '取得案例与参数候选；每个候选必须绑定已验真来源、章节与原文，并给出适用条件。'
    + 'assessments 为每条选中的挂牌来源给出一条适用性说明：比较原始挂牌报价与对象的用途、面积与位置，'
    + '只写来源可证的适用条件，不得编造修正、折扣或调整金额；status 只能是 qualified / rejected，'
    + 'knowledge 必须逐字绑定已验真来源的 sourceId、digest 与 quote。',
  calculation: '按已采用要求与受控计算器形成金额；不自行估算，不补默认值。',
  review: '独立复核采用要求、来源与数值；列出缺陷与未解决的专业疑点。',
  delivery: '汇总交付物与限制；参考口径保持 partial，不得冒充正式结论。',
}

/** Enforceable schema for one source-bound basic fact. */
const SOURCE_FACTS_SCHEMA: JsonSchemaNode = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      field: { type: 'string', enum: ['purpose', 'baseDate', 'useLabel', 'areaSqm'] },
      value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      source: {
        type: 'object',
        additionalProperties: false,
        properties: {
          materialId: { type: 'string' },
          digest: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['materialId', 'digest', 'quote'],
      },
    },
    required: ['field', 'value', 'source'],
  },
}

/** One source-bound suitability explanation per selected listing source. */
const EVIDENCE_ASSESSMENT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string' },
    status: { type: 'string', enum: ['qualified', 'rejected'] },
    reason: { type: 'string' },
    knowledge: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: { type: 'string' },
        digest: { type: 'string' },
        quote: { type: 'string' },
      },
      required: ['sourceId', 'digest', 'quote'],
    },
  },
  required: ['sourceId', 'status', 'reason', 'knowledge'],
}

const REQUIREMENT_SOURCE_REF_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string' },
    digest: { type: 'string' },
    section: { type: 'string' },
    quote: { type: 'string' },
  },
  required: ['sourceId', 'digest', 'quote'],
}

const REQUIREMENT_APPLIES_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objectIds: { type: 'array', items: { type: 'string' } },
    stages: { type: 'array', items: { type: 'string' } },
    methods: { type: 'array', items: { type: 'string' } },
    modes: { type: 'array', items: { type: 'string' } },
    regions: { type: 'array', items: { type: 'string' } },
    effectiveFrom: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    effectiveTo: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
}

const REQUIREMENT_PARAMETER_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    value: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
    unit: { type: 'string' },
    evidenceQuote: { type: 'string' },
  },
  required: ['name', 'value', 'unit'],
}

const REQUIREMENT_EXECUTOR_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    calculatorId: { type: 'string' },
    inputSlots: { type: 'array', items: { type: 'string' } },
  },
  required: ['calculatorId'],
}

/** Exact `RequirementCandidate` model contract from knowledge/requirements.ts. */
const REQUIREMENT_CANDIDATE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requirementId: { type: 'string' },
    source: REQUIREMENT_SOURCE_REF_SCHEMA,
    statement: { type: 'string' },
    strength: { type: 'string' },
    appliesTo: REQUIREMENT_APPLIES_SCHEMA,
    parameter: { oneOf: [REQUIREMENT_PARAMETER_SCHEMA, { type: 'null' }] },
    executor: { oneOf: [REQUIREMENT_EXECUTOR_SCHEMA, { type: 'null' }] },
  },
  required: ['requirementId', 'source', 'statement'],
}

const QUESTIONS_SCHEMA: JsonSchemaNode = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      questionId: { type: 'string' }, field: { type: 'string' }, prompt: { type: 'string' },
      control: { type: 'string', enum: ['text', 'textarea', 'number', 'date', 'select', 'radio', 'multiselect', 'boolean'] },
      required: { type: 'boolean' }, version: { type: 'number' }, applicable: { type: 'boolean' },
      reason: { type: 'string' },
      options: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
    },
    required: ['questionId', 'field', 'prompt', 'control', 'required', 'version', 'applicable', 'reason'],
  },
}

const QUESTION_INSTRUCTION = [
  '无法完成节点时必须返回 failure={kind,reason,requirements,actions}；kind 为 business 或 system，reason 必须具体解释哪项检查未通过，requirements 列出全部未满足要求，actions 列出可执行的恢复动作，均不能为空。不得仅写“失败”“受阻”或“不通过”。',
  '业务缺口同时给出完整 questions 及题型；系统故障不得编造业务问题。失败时不要返回冒充已通过的成果。',
  'facts.questionGenerationOnly=true 时只输出 questions，整理事实与节点核验列出的全部员工问题，不执行原节点计算，也不声称核验通过。',
  'questions 一次列出当前已知、确实需要员工回答的全部阻塞问题；不要分批隐藏已知问题，也不要为可选空值编造必答问题。',
  '工具、权限、网络、文件格式或系统能力故障属于系统问题，不得伪造成员工问题；问题不得请求命令、路径、凭据或替代受控程序校验。',
  '每题必须包含 questionId、field、prompt、control、required、version、applicable、reason；control 只能使用给定枚举。',
  '同一节点同一含义始终使用相同 field 和 questionId；version 是正整数语义版本，类型、选项或含义变化必须提升版本，仅改文案不提升版本。',
  'select/radio/multiselect 必须给出非空 options，每项只含唯一 value 与清晰 label；其他控件不附选项。最多64题，每题提示和原因不超过4000字，每题最多50个选项，选项标签最多200字。',
  'applicable=false 必须给出具体 reason；保留历史问题而不凭空删除旧回答。',
  'facts 中已提交的完整问题回答和补充备注均是本轮上下文，要连同材料来源逐项使用；unknown=true 只表示员工不知道，reason 是其说明，必答项仍未解决。',
  '先核对 facts.currentQuestionnaire 中当前完整问题、已提交回答与历史说明；重新追问旧题时，reason 必须具体解释旧答案为何不足，不要忽略员工已经给出的答案。',
  '员工回答不得静默覆盖材料事实；冲突必须保留双方来源并阻塞。只返回真实需要补充的 questions，没有则省略或返回空数组。',
].join('\n')

/** Stage-specific object schemas: unknown/narrative keys and wrong types fail. */
const STAGE_OUTPUT_SCHEMAS: Record<ValuationWorkflowStage, JsonSchemaNode> = {
  elements: {
    type: 'object',
    additionalProperties: false,
    properties: {
      purpose: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      baseDate: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      mode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      requirements: { type: 'array' },
      coverage: { type: 'object' },
      issues: { type: 'array' },
      sourceFacts: SOURCE_FACTS_SCHEMA,
      questions: QUESTIONS_SCHEMA,
    },
  },
  rights: {
    type: 'object',
    additionalProperties: false,
    properties: {
      objectId: { type: 'string' },
      useLabel: { type: 'string' },
      areaSqm: { type: 'number' },
      questions: QUESTIONS_SCHEMA,
    },
  },
  plan: {
    type: 'object',
    additionalProperties: false,
    properties: {
      method: { type: 'string' },
      algorithm: { type: 'string' },
      questions: QUESTIONS_SCHEMA,
    },
  },
  evidence: {
    type: 'object',
    additionalProperties: false,
    properties: {
      samples: { type: 'array' },
      requirements: { type: 'array', items: REQUIREMENT_CANDIDATE_SCHEMA },
      assessments: { type: 'array', items: EVIDENCE_ASSESSMENT_SCHEMA },
      coverage: { type: 'object' },
      questions: QUESTIONS_SCHEMA,
    },
  },
  calculation: {
    type: 'object',
    additionalProperties: false,
    properties: {
      boundInputs: { type: 'array' },
      unitPrice: { type: 'number' },
      totalPrice: { type: 'number' },
      units: { type: 'string' },
      rounding: { type: 'string' },
      questions: QUESTIONS_SCHEMA,
    },
  },
  review: {
    type: 'object',
    additionalProperties: false,
    properties: {
      checked: { type: 'boolean' },
      limitations: { type: 'array' },
      issues: { type: 'array' },
      unresolved: { type: 'array' },
      questions: QUESTIONS_SCHEMA,
    },
  },
  delivery: {
    type: 'object',
    additionalProperties: false,
    properties: {
      artifacts: { type: 'array' },
      limitations: { type: 'array' },
      verified: { type: 'array' },
      questions: QUESTIONS_SCHEMA,
    },
  },
}

/** Known output fields per stage: a nonempty unrelated object is not a valid result. */
const STAGE_OUTPUT_KEYS: Record<ValuationWorkflowStage, string[]> = {
  elements: ['requirements', 'coverage', 'issues', 'purpose', 'baseDate', 'mode', 'sourceFacts'],
  rights: ['objectId', 'useLabel', 'areaSqm'],
  plan: ['method', 'algorithm'],
  evidence: ['samples', 'requirements', 'assessments', 'coverage'],
  calculation: ['unitPrice', 'totalPrice', 'units', 'rounding', 'boundInputs'],
  review: ['issues', 'unresolved', 'checked', 'limitations'],
  delivery: ['artifacts', 'limitations', 'verified'],
}

const FAILURE_SCHEMA: JsonSchemaNode = { type: 'object', additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['business', 'system'] }, reason: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } }, actions: { type: 'array', items: { type: 'string' } } },
  required: ['kind', 'reason', 'requirements', 'actions'] }
for (const schema of Object.values(STAGE_OUTPUT_SCHEMAS)) schema.properties!.failure = FAILURE_SCHEMA

/** Isolated structured contract for mapping entry Wiki links to business roles. */
const KNOWLEDGE_SELECTION_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entryDigest: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    selections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          role: { type: 'string', enum: ['common', 'rights', 'method', 'evidence', 'output'] },
          quote: { type: 'string' },
        },
        required: ['path', 'role', 'quote'],
      },
    },
  },
  required: ['entryDigest', 'questions', 'selections'],
}

const KNOWLEDGE_SELECTION_INSTRUCTION = [
  '只做知识来源选择，不执行任何业务节点，也不做完整项目调查。',
  'entryDigest 必须逐字等于 facts.entryDigest。',
  'selections[].path 必须逐字等于 facts.allowedLinks 中已登记的路径；不得猜测、拼接或追加后缀。',
  'selections[].role 只能是 common / rights / method / evidence / output，并且只能落在 facts.applicableRoles 允许的范围。',
  'selections[].quote 必须逐字包含完整的 Markdown 链接 [标签](目标)，且该链接解析后正好指向 selections[].path；请直接取 facts.navigationQuotes 中与该 path 对应的原始整行引用（保留百分号编码与 < >），不要只复制说明文字或与所选文档无关的节点角色段落。',
  'facts.selectionCorrection 是上一次校验失败的具体原因；只按它修正 quote/selection，保持同一 entryDigest 与当前上下文，不要新增路径或方法。',
  'facts.mode 是正式或挂牌参考口径（valuation basis），不是市场法 / 收益法 / 成本法等方法名，不要用 mode 推断估值方法。',
  'facts.methodRequest 是用户在确认页明确选择的评估方法（market / income / cost），没有 auto 这一档；按该方法选择知识，不要自己改法或补别的方法。',
  'facts.applicableRoles 限定当前阶段的角色：elements 先选 common 的通用流程与要素规则，此时方法 / 依据尚未确认；rights 选 common + rights；后续阶段才按适用范围选择 method / evidence / output。不要要求未来才确认的方法分支去读当前阶段的通用指引。',
  'purpose、valueType、baseDate 都是可选输入；基准日留空表示"未指定"，不要追问日期，也不要因为基准日为空就判定材料缺失或不可读。',
  '只依据本次提供的 facts.userInput、当前节点补充要求与已提供材料正文判断，没有提供的字段不要推断。',
  'questions 只登记**真正无法绑定**的已登记链接 / 入口正文 / 角色：来源缺失、路径歧义、原文对不上或角色无法判定时才提问。材料内部的事实不确定或冲突属于后续 elements / rights 节点；当前阶段暂时不需要的方法 / 依据 / 输出知识属于正常的分阶段延后，都不是来源选择问题。可选字段留空不会阻塞 common 来源绑定。',
  '如果确实无法把已登记链接或入口原文绑定到某个角色，把疑点写进 questions；不要编造文件、规则或业务阈值，也不要忽略真实的知识库缺失或不安全来源。',
  '不要输出叙述、解释或工具调用命令，只输出符合 JSON Schema 的对象。',
].join('\n')

/** Strict structured contract for transcribing already-admitted page images. */
const PAGE_READING_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number' },
          text: { type: 'string' },
          uncertainties: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'text', 'uncertainties'],
      },
    },
  },
  required: ['pages'],
}

const PAGE_READING_INSTRUCTION = [
  '只判读随消息附上的页面图像，不执行其他业务节点，也不调用任何工具。',
  '按 facts.pageIndexes 给出的页码逐页输出；每页一项，index 必须是其中的页码且不得重复。',
  'text 逐字转写图中可读的文字、表格与单位，保持原意；看不清或不确定的内容写进 uncertainties，不要猜测。',
  '不得编造资产事实、面积、权利人、金额或业务阈值；原文未写的字段一律不要补。',
  '保留建筑面积与套内建筑面积等口径标签的原样区分，不要把两者混为同一个面积。',
  '忠实保留表格标签、值、单位的对应关系，可按每个字段单独转写或保留表格列；不要把楼层等相邻数值串在建筑面积字段下，行列对应不清写入 uncertainties 且不猜字段、值或单位。',
  '没有把握时宁可留空 text 并把疑虑写进 uncertainties。',
  '不要输出叙述、解释或工具调用命令，只输出符合 JSON Schema 的对象。',
].join('\n')

/** Strict structured contract binding a market query to actual sources and registered templates. */
const PLANNING_SELECTION_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    city: { type: 'string' },
    community: { type: 'string' },
    nearbyCommunities: { type: 'array', items: { type: 'string' } },
    valueScope: { type: 'string' },
    providerOrder: { type: 'array', items: { type: 'string' } },
    templatePath: { type: 'string' },
    basis: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: {
            type: 'string',
            enum: ['city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath'],
          },
          sourceId: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['field', 'sourceId', 'quote'],
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['field', 'prompt'],
      },
    },
  },
  required: ['city', 'community', 'nearbyCommunities', 'valueScope', 'providerOrder', 'templatePath', 'basis', 'questions'],
}

const PLANNING_SELECTION_INSTRUCTION = [
  '只做市场检索规划选择，不执行任何业务节点，也不调用任何工具。',
  'city、community、nearbyCommunities、valueScope、providerOrder、templatePath 必须来自已确认事实与已验真来源，不得编造或补默认值。',
  'providerOrder 只能取 facts.allowedProviderIds 中的渠道 ID；allowedProviderIds 只是能力白名单，顺序必须来自知识库正文或用户明确输入，绝不能依据注册顺序或 JSON 中的能力事实排序。',
  'templatePath 必须逐字等于 facts.allowedTemplatePaths 中已登记的路径，不得猜测目录、追加后缀或拼接 URL；未验真的模板不得视为可用。',
  '地点只能依据允许的材料原文或用户明确输入；材料正文引用使用 materialId，文件名引用必须写成 materialId:file-name，且文件名只能证明社区，绝不能证明城市。',
  '业务决策（valueScope、providerOrder、templatePath）必须依据知识库正文或用户明确输入，不能用文件名作为依据。',
  'city、community、nearbyCommunities、valueScope 的名称与取值都必须逐字出现在对应来源的受支持 quote 中，不得把转述或改写拼进 valueScope。',
  '没有可证明的附近小区列表时 nearbyCommunities 可以为空数组，不要为了填满可选项而提问。',
  'basis 每条都要给出 field、sourceId 与逐字引用的 quote；sourceId 必须是 facts.sourceCatalog 中真实的 sourceId，且对应条目的 allowedFields 包含该 field，quote 必须能在对应来源中找到。',
  'user-input 来源的 quote 必须是员工的实际输入原文；知识库来源必须引用知识正文原文。',
  '不得编造 facts.confirmedFacts、facts.methodOutput 或任何 sourceId。',
  '确实缺失的必填字段、模板可用性与其他疑问写进 questions，不要猜测；不要输出叙述、解释、金额或其他额外字段。',
].join('\n')

/** Constant public error: raw infrastructure text never leaves the Host boundary. */
const PUBLIC_INFRASTRUCTURE_ERROR = '推理子会话基础设施错误：详情已省略，请由 Host 诊断会话占用后重试'

/** Constant public error: the child existed, so the real id is preserved for reconciliation. */
const PUBLIC_JOURNAL_ERROR = '子会话日志写入失败：详情已省略，已停止该子会话'

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

function normalizeStageQuestions(value: unknown): unknown {
  if (!isNonEmptyObject(value) || !Array.isArray(value.questions)) return value
  return { ...value, questions: value.questions.map((question: unknown) => {
    if (!isNonEmptyObject(question) || !['text', 'textarea', 'number', 'date', 'boolean'].includes(String(question.control))
      || !Array.isArray(question.options) || question.options.length !== 0) return question
    // Native structured tools may materialize an absent optional array as [].
    const { options: _empty, ...definition } = question
    return definition
  }) }
}

/** The structured result must satisfy this stage's schema and carry a known field. */
function isAcceptableStageOutput(stage: ValuationWorkflowStage, value: unknown): value is Record<string, unknown> {
  if (!isNonEmptyObject(value)) return false
  if (validateJsonSchemaValue(STAGE_OUTPUT_SCHEMAS[stage], value).length > 0) return false
  if (value.questions !== undefined && !validQuestions(value.questions)) return false
  if (value.failure !== undefined) return readNodeFailure(value.failure) !== null
    && Object.keys(value).every((key) => key === 'failure' || key === 'questions')
  const allowed = STAGE_OUTPUT_KEYS[stage]
  return Object.keys(value).some((key) => allowed.includes(key))
    || (Array.isArray(value.questions) && value.questions.length > 0)
}

/** The native schema subset has no size/integer constraints; enforce them here. */
function validQuestions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false
  const ids = new Set<string>(), fields = new Set<string>()
  const boundedText = (input: unknown, max: number): input is string => typeof input === 'string'
    && input.trim() !== '' && input.length <= max
  return value.every((question: Record<string, unknown>) => {
    if (!boundedText(question.questionId, 256) || !boundedText(question.field, 256)
      || !boundedText(question.prompt, 4_000) || !boundedText(question.reason, 4_000)
      || !Number.isSafeInteger(question.version) || Number(question.version) < 1
      || ids.has(question.questionId) || fields.has(question.field)) return false
    ids.add(question.questionId); fields.add(question.field)
    const choice = ['select', 'radio', 'multiselect'].includes(String(question.control))
    if (!choice) return question.options === undefined
    if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > 50) return false
    const options = new Set<string>()
    return question.options.every((option: Record<string, unknown>) => {
      if (!boundedText(option.value, 256) || !boundedText(option.label, 200) || options.has(option.value)) return false
      options.add(option.value)
      return true
    })
  })
}

/** A selection must satisfy the strict schema and carry a real version plus choices. */
function isAcceptableKnowledgeSelection(value: unknown): value is Record<string, unknown> {
  if (!isNonEmptyObject(value)) return false
  if (validateJsonSchemaValue(KNOWLEDGE_SELECTION_SCHEMA, value).length > 0) return false
  if (typeof value.entryDigest !== 'string' || value.entryDigest.trim() === '') return false
  const selections = value.selections
  if (!Array.isArray(selections) || selections.length === 0) return false
  return selections.every((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    return String(record.path ?? '').trim() !== '' && String(record.quote ?? '').trim() !== ''
  })
}

function outputSchemaFor(request: ValuationInferenceRequest): JsonSchemaNode | null {
  if (request.operation === 'template-analysis') return TEMPLATE_ANALYSIS_SCHEMA
  if (request.operation === 'knowledge-selection') return KNOWLEDGE_SELECTION_SCHEMA
  if (request.operation === 'page-reading') return PAGE_READING_SCHEMA
  if (request.operation === 'planning-selection') return PLANNING_SELECTION_SCHEMA
  if (request.operation !== undefined) return null
  return STAGE_OUTPUT_SCHEMAS[request.stage]
}

function outputViolations(request: ValuationInferenceRequest, value: unknown): string[] {
  if (!isNonEmptyObject(value)) return ['子会话未返回非空的结构化对象；自由文本、空对象或缺失结果均不能作为节点成果。']
  const schema = outputSchemaFor(request)!
  const problems: string[] = []
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (value[key] === undefined) {
      if (schema.required?.includes(key)) problems.push(`缺少必填字段 ${key}。`)
    } else if (validateJsonSchemaValue(field, value[key]).length > 0) {
      problems.push(`字段 ${key} 不符合契约：要求 ${field.type ?? '给定联合类型'}，且嵌套字段必须符合定义。`)
    }
  }
  if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) problems.push('返回了本节点不允许的额外字段；未采用其内容。')
  if (request.operation === undefined && value.questions !== undefined && !validQuestions(value.questions)) {
    problems.push('questions 定义无效：每题须包含唯一标识、字段、题型、必填标记、正整数版本、适用标记和具体原因；选择题还须有合法选项。')
  }
  if (value.failure !== undefined && readNodeFailure(value.failure) === null) problems.push('failure 必须包含具体 reason、非空 requirements 和 actions，且故障类型须合法。')
  if (problems.length === 0) problems.push(request.operation === undefined
    ? `未给出可采用的节点成果（${STAGE_OUTPUT_KEYS[request.stage].join('、')}）、有效问题或完整失败说明；失败与成功成果不能混合返回。`
    : '返回结果未满足本次隔离操作的来源、覆盖或非空要求，不能作为已验证成果。')
  return problems
}

/** One page entry must satisfy the strict schema and carry text or an explicit uncertainty. */
function isAcceptablePageReading(value: unknown): value is Record<string, unknown> {
  if (!isNonEmptyObject(value)) return false
  if (validateJsonSchemaValue(PAGE_READING_SCHEMA, value).length > 0) return false
  const pages = value.pages
  if (!Array.isArray(pages) || pages.length === 0) return false
  return pages.every((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    const uncertainties = Array.isArray(record.uncertainties) ? record.uncertainties : []
    return text !== '' || uncertainties.length > 0
  })
}

/** One planning selection must satisfy the strict schema and carry nonempty place/scope fields. */
function isAcceptablePlanningSelection(value: unknown): value is Record<string, unknown> {
  if (!isNonEmptyObject(value)) return false
  if (validateJsonSchemaValue(PLANNING_SELECTION_SCHEMA, value).length > 0) return false
  const required = ['city', 'community', 'valueScope', 'templatePath']
  return required.every((key) => typeof value[key] === 'string' && (value[key] as string).trim() !== '')
}

function isAcceptableOutput(request: ValuationInferenceRequest, value: unknown): value is Record<string, unknown> {
  if (request.operation === 'template-analysis') return isTemplateRequirements(value)
    && validateJsonSchemaValue(TEMPLATE_ANALYSIS_SCHEMA, value).length === 0
  if (request.operation === 'knowledge-selection') return isAcceptableKnowledgeSelection(value)
  if (request.operation === 'page-reading') return isAcceptablePageReading(value)
  if (request.operation === 'planning-selection') return isAcceptablePlanningSelection(value)
  if (request.operation !== undefined) return false
  return isAcceptableStageOutput(request.stage, value)
}

function gap(message: string): ValuationInferenceResult {
  return { ok: false, errorKind: 'capability-gap', sessionId: '', gaps: [message], error: message }
}

function workspaceFailure(sessionId: string): ValuationInferenceResult {
  return {
    ok: false,
    errorKind: 'capability-gap',
    sessionId,
    error: `子会话没能挂到当前工作区并回读：${PUBLIC_INFRASTRUCTURE_ERROR}`,
  }
}

/** Required page indexes declared in facts; both key spellings are honored. */
function requiredPageIndexesOf(facts: Record<string, unknown>): number[] {
  const raw = facts.pageIndexes ?? facts.pageIndices
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) continue
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function taskPrompt(request: ValuationInferenceRequest): string {
  const knowledge = request.knowledge
    .map((ref) => {
      const header = `- ${ref.path}${ref.section === '' ? '' : `#${ref.section}`} (${ref.sourceId}${ref.digest === undefined ? '' : ` @${ref.digest}`})`
      const coverage = ref.bodyTruncated === true ? `\n  [覆盖说明] ${ref.coverageNote ?? '正文按上限截断'}` : ''
      return `${header}\n  ${ref.body ?? ref.quote}${coverage}`
    })
    .join('\n')
  const materials = (request.materials ?? [])
    .map((material) => `- ${material.fileName} (${material.materialId} @${material.digest})\n${material.text ?? ''}`)
    .join('\n')
  const selection = request.operation === 'knowledge-selection'
  const pageReading = request.operation === 'page-reading'
  const planningSelection = request.operation === 'planning-selection'
  const templateAnalysis = request.operation === 'template-analysis'
  const instruction = selection
    ? KNOWLEDGE_SELECTION_INSTRUCTION
    : pageReading ? PAGE_READING_INSTRUCTION
      : planningSelection ? PLANNING_SELECTION_INSTRUCTION
        : templateAnalysis ? TEMPLATE_ANALYSIS_INSTRUCTION : STAGE_INSTRUCTIONS[request.stage]
  const pageIndexes = pageReading ? requiredPageIndexesOf(request.facts) : []
  return [
    selection
      ? '知识流程节点：knowledge-selection'
      : pageReading ? '估值流程节点：page-reading'
        : planningSelection ? '估值流程节点：planning-selection'
          : templateAnalysis ? '估值流程节点：template-analysis' : `估值流程节点：${request.stage}`,
    '只输出符合给定 JSON Schema 的结构化对象；不要前言、解释、叙述或调用工具探索。',
    `本次必须遵守的 JSON Schema：${JSON.stringify(outputSchemaFor(request))}`,
    `任务要求：${instruction}`,
    ...(request.operation === undefined ? [QUESTION_INSTRUCTION] : []),
    ...(pageReading
      ? [`必须判读的页码：${pageIndexes.length === 0 ? '（facts 未声明）' : pageIndexes.join(', ')}`]
      : []),
    `运行 ${request.runId} 修订 ${String(request.revision)} 第 ${String(request.attempt)} 次`,
    `已确认事实：${JSON.stringify(request.facts)}`,
    'facts.initialInput 是最初提交的入口选择快照；本次 facts.confirmedFacts、用户回答与 revision.changes 才是当前生效值，不要用原始快照覆盖当前更正。purpose / valueType / baseDate 缺失或留空是允许的可选输入，不是必须追问的问题。',
    materials === '' ? '已确认材料：（无）' : `已确认材料：\n${materials}`,
    knowledge === '' ? '采用知识：（无）' : `采用知识：\n${knowledge}`,
  ].join('\n')
}

/** Page images ride as real admitted attachment blocks; no bytes or paths in text/facts. */
function promptParts(request: ValuationInferenceRequest): Array<Record<string, unknown>> {
  if (request.operation !== 'page-reading') return [{ type: 'text', text: taskPrompt(request) }]
  const parts: Array<Record<string, unknown>> = (request.images ?? []).map((ref) => ({
    type: 'image',
    attachment: ref,
  }))
  parts.push({ type: 'text', text: taskPrompt(request) })
  return parts
}

/**
 * Build the DSH-backed inference port. One instance is shared by the workflow
 * service and the registered Tools for the plugin lifecycle.
 */
export function createDshWorkflowInference(options: DshWorkflowInferenceOptions): ValuationInferencePort {
  return {
    supportsQuestions: true,
    async infer(request: ValuationInferenceRequest): Promise<ValuationInferenceResult> {
      const runtime = options.ctx?.get?.('subagents') as SubagentRuntimeLike | undefined
      if (!hasSubagentStart(runtime)) {
        return gap('Host 的 subagents 服务不可验证（既没有 startActivation 也没有 start）：拒绝创建子会话')
      }
      const live = runtime as SubagentRuntimeLike
      const picked = eligibleProvider(live)
      if (picked === null) {
        return gap('没有可用的隔离子代理 provider：必须 inheritsParentContext=false 且声明 outputSchema')
      }
      if (options.workspace !== undefined && typeof options.attachWorkspace !== 'function') {
        return gap('需要把子会话挂到当前工作区，但没有可用的工作区挂载与回读能力：拒绝创建未归属的子会话')
      }
      const outputSchema = outputSchemaFor(request)
      if (outputSchema === null) {
        return gap('不支持的推理操作：拒绝回退到阶段输出契约')
      }
      if (request.operation === 'page-reading' && (request.images ?? []).length === 0) {
        return gap('page-reading 没有可判读的页面图像：拒绝创建空读子会话')
      }

      const controller = new AbortController()
      const forward = (): void => { controller.abort() }
      const callerSignal = request.signal
      if (callerSignal !== undefined) {
        if (callerSignal.aborted) controller.abort()
        else callerSignal.addEventListener('abort', forward, { once: true })
      }

      const stopTimeoutMs = resolveStopTimeoutMs(options.stopTimeoutMs)
      const detach = (): void => {
        if (callerSignal !== undefined) callerSignal.removeEventListener('abort', forward)
      }
      const disposeOrStopUnknown = async (run: SubagentRunLike, sessionId: string): Promise<ValuationInferenceResult | null> => {
        if (await stopChild(run, stopTimeoutMs)) return null
        return { ok: false, errorKind: 'stop-unknown', sessionId, error: STOP_UNKNOWN_ERROR }
      }

      let run: SubagentRunLike
      try {
        const started = await startSubagentChild(live, options.ctx, picked.provider, picked.name, {
          label: `valuation:${request.stage}`,
          prompt: promptParts(request),
          parent: options.parentAgent,
          signal: controller.signal,
          outputSchema,
        })
        if (!started.ok) {
          detach()
          return gap(`子会话没有可核对的启动凭据（${started.refusal}）：拒绝创建未验证的子会话`)
        }
        run = started.run
      } catch {
        detach()
        return { ok: false, errorKind: 'failed', sessionId: '', error: PUBLIC_INFRASTRUCTURE_ERROR }
      }

      const sessionId = String(run.id ?? '').trim()
      if (sessionId !== '' && options.onStarted !== undefined) {
        const started: DshWorkflowStageStartedEvent = {
          sessionId,
          nodeId: request.nodeId,
          stage: request.stage,
          runId: request.runId,
          revision: request.revision,
          correlationId: request.correlationId,
        }
        if (request.operation !== undefined) started.operation = request.operation
        try {
          await options.onStarted(started)
        } catch {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          detach()
          return stopped ?? { ok: false, errorKind: 'failed', sessionId, error: PUBLIC_JOURNAL_ERROR }
        }
      }
      if (sessionId === '' || !run.local) {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? gap('子会话没有可验证的本进程子代理：拒绝把不可核对的运行当作成果')
      }

      let workspaceAttachment: { ok: boolean; error?: string } | null | undefined
      try {
        workspaceAttachment = options.workspace === undefined
          ? null
          : await options.attachWorkspace?.({
            childId: sessionId, workspace: options.workspace, parentAgent: options.parentAgent,
          })
      } catch {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? workspaceFailure(sessionId)
      }
      if (workspaceAttachment !== null && workspaceAttachment !== undefined && !workspaceAttachment.ok) {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        detach()
        return stopped ?? workspaceFailure(sessionId)
      }

      let abortListener: (() => void) | undefined
      const aborted = new Promise<'aborted'>((resolve) => {
        abortListener = () => { resolve('aborted') }
        if (controller.signal.aborted) { abortListener(); return }
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })

      try {
        const raced = await Promise.race([
          run.result.then((value) => ({ aborted: false as const, value })),
          aborted.then(() => ({ aborted: true as const, value: undefined })),
        ])
        if (raced.aborted || controller.signal.aborted) {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          return { ok: false, errorKind: 'cancelled', sessionId, error: '本次推理已被取消' }
        }
        const value = raced.value
        if (value === undefined || value.stopReason !== 'completed') {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          const failure = nodeFailure('system', [value === undefined ? '子会话没有返回执行回执。'
            : '子会话异常结束，未完成本节点推理。模型服务、执行限制或子会话内部错误需要核查。'])
          return {
            ok: false,
            errorKind: 'failed',
            sessionId,
            error: failure.reason, failure,
          }
        }
        const structured = request.operation === undefined ? normalizeStageQuestions(value.structured) : value.structured
        if (!isAcceptableOutput(request, structured)) {
          const stopped = await disposeOrStopUnknown(run, sessionId)
          if (stopped !== null) return stopped
          const failure = nodeFailure('output-contract', outputViolations(request, structured))
          failure.actions = ['重新执行该节点以按契约重新生成；若再次失败，请检查模型的结构化输出能力及节点契约配置。已保存的答案无需重新填写。']
          return {
            ok: false,
            errorKind: 'failed',
            sessionId,
            error: failure.reason, failure,
          }
        }
        const stopped = await disposeOrStopUnknown(run, sessionId)
        if (stopped !== null) return stopped
        return { ok: true, sessionId, outputs: structured }
      } catch {
        const stopped = await disposeOrStopUnknown(run, sessionId)
        if (stopped !== null) return stopped
        return { ok: false, errorKind: 'failed', sessionId, error: PUBLIC_INFRASTRUCTURE_ERROR }
      } finally {
        if (abortListener !== undefined) controller.signal.removeEventListener('abort', abortListener)
        detach()
      }
    },
  }
}
