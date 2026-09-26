import type { Context } from '@deepseek-ai/cordis'
import { text } from '../../shared/utils/value.ts'
import { runDws, type DwsRunResult } from '../dws/run.ts'
import { DWS_STDOUT_MAX, DWS_TIMEOUT_MS } from '../dws/consts.ts'
import { jsonObject, failure, type ToolEnvelope } from './outcome.ts'

/**
 * `dws ... --format json` 的调用与解析。
 *
 * 所有知识库 / 钉钉回传编排都从这里走：命令由各 Tool 按固定模板拼装，
 * 解析失败**不算零命中**（空数组才算），这是 `dingtalk-wiki` 契约里的硬要求。
 */

export interface DwsJsonOk {
  ok: true
  payload: Record<string, unknown>
  run: DwsRunResult
}

export type DwsJsonResult = DwsJsonOk | ({ ok: false } & ToolEnvelope & { run?: DwsRunResult })

export interface DwsJsonOptions {
  workdir: string
  trusted: boolean
  signal?: AbortSignal
  credentialOperation?: boolean
  timeoutMs?: number
  stdoutMaxBytes?: number
}

export async function dwsJson(
  ctx: Context,
  platform: string,
  argv: readonly string[],
  options: DwsJsonOptions,
): Promise<DwsJsonResult> {
  const run = await runDws(ctx, platform, argv, {
    workdir: options.workdir,
    trusted: options.trusted,
    credentialOperation: options.credentialOperation !== false,
    timeoutMs: options.timeoutMs ?? DWS_TIMEOUT_MS,
    stdoutMaxBytes: options.stdoutMaxBytes ?? DWS_STDOUT_MAX,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!run.ok) {
    return { ...failure(run.errorKind === '' ? 'cli' : run.errorKind, run.error), run }
  }
  const payload = jsonObject(run.stdout)
  if (payload === null) {
    return {
      ...failure('cli', `${run.command} 没有返回 JSON 对象：${text(run.stdout).slice(0, 300)}`),
      run,
    }
  }
  // `success:false` / `ok:false` 也是失败 —— 不能当成「零命中」。
  if (payload.success === false || payload.ok === false) {
    return {
      ...failure('cli', `${run.command} 返回失败：${text(payload.errorMsg) || text(payload.message) || '未提供原因'}`),
      run,
    }
  }
  return { ok: true, payload, run }
}
