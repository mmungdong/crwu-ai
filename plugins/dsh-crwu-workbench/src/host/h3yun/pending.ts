import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { text } from '../../shared/utils/value.ts'
import { runCrwu, describeFailure } from '../crwu/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import type { WorkbenchState } from '../state/types.ts'
import { RECORDS_STDOUT_MAX } from './consts.ts'
import type { H3yunFormResolver } from './form.ts'
import { buildQueryFilter, rowToTask, rowsFromEnvelope, totalFromEnvelope, type H3yunTask } from './records.ts'

/**
 * 拉取待审核报告列表。
 *
 * 三个「不显眼但会坑人」的点：
 * 1. **表单 code 只定位一次**：定位要跑十几到六十秒，不能每次翻页都搜 —— 现在统一交给
 *    实例级的 `H3yunFormResolver`（已缓存零成本、并发共享同一个 in-flight Promise，
 *    与业务 Tool 用的是同一个解析器，所以两条链路不会各搜一遍）；
 * 2. **检索词含引号/反斜杠直接拒绝**：不拼进氚云过滤表达式，回明确的错误让用户改写；
 * 3. **`--size` 上限 100**：氚云那边的分页上限，不夹住会让命令报错而不是少拿数据。
 */
export interface PendingResult {
  ok: boolean
  error: string
  rows: H3yunTask[]
  formName: string
  page: number
  size: number
  total: number
  query: string
  filterMode: string
  escalated: boolean
  escalateAvailable: boolean
}

export interface PendingDeps {
  ctx: Context
  state: WorkbenchState
  /** Broker（协议 18）：待审核列表要读氚云，走 `h3yun.records.read`。 */
  access: LocalAccessBroker
  platform: string
  /** 显式 workdir；省略/空串时用会话工作目录（提权执行必须有它）。 */
  workdir?: string
  sessionRoot: () => Promise<string>
  /** 表单 code 的实例级解析器（审核启动与业务 Tool 共用同一个，保证全插件只发现一次）。 */
  form: H3yunFormResolver
}

export async function loadPending(deps: PendingDeps, args: Record<string, unknown>): Promise<PendingResult> {
  const { ctx, state } = deps
  const base = {
    rows: [] as H3yunTask[],
    page: 1,
    size: 20,
    total: 0,
    query: text(args.query),
    filterMode: '',
    escalated: false,
    escalateAvailable: false,
  }
  let escalated = false

  // 提权执行必须绑定工作区。调用方通常不传，所以这里统一解析一次并复用。
  const workdir = deps.workdir !== undefined && deps.workdir !== '' ? deps.workdir : await deps.sessionRoot()

  const found = await deps.form.ensure()
  if (!found.ok) {
    return { ...base, ok: false, error: found.error, formName: '', escalateAvailable: false }
  }
  if (found.escalated) escalated = true

  const rawPage = Number(args.page)
  const rawSize = Number(args.size)
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1
  const size = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(100, Math.floor(rawSize)) : 20

  const built = buildQueryFilter(args.query)
  if (built.mode === 'invalid') {
    return {
      ...base,
      ok: false,
      page,
      size,
      error: '报告流水号不能包含引号或反斜杠',
      formName: state.formName,
    }
  }

  const argv = [
    'crwu', 'h3yun', 'records', 'list',
    '--schema', state.formCode,
    '--page', String(page),
    '--size', String(size),
  ]
  if (built.expr !== '') argv.push('--filter', built.expr)

  const run = await runCrwu(ctx, argv, {
    ...(workdir === '' ? {} : { workdir }),
    timeoutMs: 90_000,
    access: deps.access,
    source: 'panel',
    platform: deps.platform,
    stdoutMaxBytes: RECORDS_STDOUT_MAX,
  })
  if (run.escalated) escalated = true

  // 解析不出东西就是**这次取数失败**，必须报 CLI 的真实原因；
  // 说成「0 条待办」会让界面显示一个空列表，用户以为真的没有待办。
  const payload = parseJsonLoose(run.stdout)
  if (payload === null) {
    return {
      ...base,
      ok: false,
      page,
      size,
      error: describeFailure(run),
      formName: state.formName,
      escalateAvailable: run.escalateAvailable,
    }
  }

  return {
    ok: true,
    error: '',
    formName: state.formName,
    rows: rowsFromEnvelope(payload).map(rowToTask),
    page,
    size,
    total: totalFromEnvelope(payload),
    query: text(args.query),
    filterMode: built.mode,
    escalated,
    escalateAvailable: false,
  }
}
