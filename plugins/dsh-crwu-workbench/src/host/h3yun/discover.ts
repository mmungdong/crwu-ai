import type { Context } from '@deepseek-ai/cordis'
import { parseJsonLoose } from '../../shared/utils/json.ts'
import { describeFailure, runCrwu } from '../crwu/run.ts'
import type { LocalAccessBroker } from '../access/broker.ts'
import { pickForm, rowsFromEnvelope } from './records.ts'

/**
 * 首次调用时定位氚云表单并记下它的 `code`。
 *
 * 为什么需要：`crwu h3yun records list --schema <code>` 要的是表单 code，而用户只知道表单名
 * （默认「报告审核」）。定位一次就缓存进插件状态，后续调用直接用 code —— 每次都搜一遍会白等 60 秒。
 */
export interface DiscoverFormResult {
  ok: boolean
  code: string
  name: string
  error: string
  escalateAvailable: boolean
  escalated: boolean
}

export async function discoverForm(
  ctx: Context,
  keyword: string,
  options: {
    /** Broker（协议 18）：表单定位要读氚云（`h3yun.forms.read`）。 */
    access: LocalAccessBroker
    platform?: string
    /** 显式 workdir；空串表示「用会话工作目录」——提权执行必须有它。 */
    workdir?: string
    sessionRoot?: () => Promise<string>
  },
): Promise<DiscoverFormResult> {
  const workdir = options.workdir !== undefined && options.workdir !== ''
    ? options.workdir
    : (options.sessionRoot === undefined ? '' : await options.sessionRoot())
  const run = await runCrwu(ctx, ['crwu', 'h3yun', 'forms', 'search', '--keyword', keyword], {
    ...(workdir === '' ? {} : { workdir }),
    timeoutMs: 60_000,
    access: options.access,
    source: 'panel',
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  })
  const base = {
    code: '',
    name: '',
    escalateAvailable: run.escalateAvailable,
    escalated: run.escalated,
  }
  // 坏输出必须报 CLI 的真实原因，不能报成「没找到表单」—— 那是让人去查一个不存在的问题。
  const payload = parseJsonLoose(run.stdout)
  if (payload === null) return { ...base, ok: false, error: describeFailure(run) }
  const form = pickForm(rowsFromEnvelope(payload), keyword)
  if (form === null) return { ...base, ok: false, error: `未在氚云定位到表单「${keyword}」` }
  return { ...base, ok: true, error: '', code: form.code, name: form.name }
}
