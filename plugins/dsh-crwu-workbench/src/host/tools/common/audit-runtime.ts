import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { LocalAccessBroker } from '../../core/access/broker.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import {
  AUDIT_RUNTIME_FILE, AUDIT_SCRIPTS_DIR, auditRuntimeConfig,
} from '../../domains/report-audit/audit-scripts.ts'
import { ensureDirectory, writeCaseText } from './case-files.ts'

/**
 * 把「审核脚本的随包依赖位置」写进案例目录（`<案例>/scripts/runtime.json`）。
 *
 * ## 为什么必须在**案例创建/认领**时就写，而不是等第一次执行脚本
 *
 * 2026-10-22 现场：`prepare_materials.py` 在盘点一开始就跑，模型按文档用
 * `Start-Process <python> scripts/prepare_materials.py` 直接执行 —— 那条路径**不经过**
 * `crwu_run_python_script`，于是 `runtime.json` 从来没有被写出来，DSH 自带 Python 没有
 * `pypdf`，28 个 PDF 全部被记成 `pypdf-error`、连页数都是 0，整批材料被推给视觉判读。
 * 把写入点前移到认领/建档，依赖位置就与"谁来执行脚本"解耦了。
 *
 * ## 为什么是尽力而为
 *
 * 写不出来只意味着脚本退回"缺依赖、如实记账"，**不该让一次审核启动或认领失败**。
 * 调用方忽略返回值，只把错误写进诊断。
 */
export interface AuditRuntimeInput {
  /** 缺任何一个都直接跳过：测试替身与降级部署里没有这些依赖也照常工作。 */
  ctx?: Context
  access?: LocalAccessBroker
  casePath: string
  platform: string
  session?: Session
  signal?: AbortSignal
}

export interface AuditRuntimeResult {
  ok: boolean
  error: string
  path: string
}

/** 案例内 `runtime.json` 的路径（模型提交不了，也不该提交）。 */
export function auditRuntimePath(casePath: string): string {
  return joinLocalPath(casePath, AUDIT_SCRIPTS_DIR, AUDIT_RUNTIME_FILE)
}

/**
 * 尽力写出 `runtime.json`；**不抛异常**，失败只回结构化事实。
 *
 * 内容只有依赖位置（见 `auditRuntimeConfig`），不含任何模型可控字段。
 */
export async function ensureAuditRuntimeFile(input: AuditRuntimeInput): Promise<AuditRuntimeResult> {
  const path = auditRuntimePath(input.casePath)
  const base: AuditRuntimeResult = { ok: false, error: '', path }
  if (input.ctx === undefined || input.access === undefined) {
    return { ...base, error: '没有可用的文件/执行依赖，跳过 runtime.json（脚本将按"缺依赖"如实记账）' }
  }
  const scope = {
    workdir: input.casePath,
    platform: input.platform,
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  try {
    const made = await ensureDirectory(input.access, joinLocalPath(input.casePath, AUDIT_SCRIPTS_DIR), scope)
    if (!made.ok) return { ...base, error: made.error }
    const written = await writeCaseText(input.ctx, path, auditRuntimeConfig(), {
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!written.ok) return { ...base, error: written.error }
    return { ...base, ok: true }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 认领 / 建档时的**尽力而为**版本：拿不到执行依赖就跳过，失败只写诊断，永不抛。
 *
 * 调用点（`crwu_audit_local_claim`、`crwu_audit_case_bootstrap`）的职责是认领与建档本身；
 * 依赖位置写不出来只影响"PDF 有没有文本通道"，不该把它变成一次失败的认领。
 */
export async function writeAuditRuntimeQuietly(input: {
  ctx?: Context
  access?: LocalAccessBroker
  world?: { platform(): Promise<string> }
  casePath: string
  session?: Session
  signal?: AbortSignal
}): Promise<AuditRuntimeResult> {
  const path = input.casePath === '' ? '' : auditRuntimePath(input.casePath)
  if (input.ctx === undefined || input.access === undefined || input.world === undefined
    || input.casePath === '') {
    return { ok: false, error: '没有可用的文件/执行依赖，跳过 runtime.json', path }
  }
  try {
    const platform = await input.world.platform()
    const result = await ensureAuditRuntimeFile({
      ctx: input.ctx,
      access: input.access,
      casePath: input.casePath,
      platform,
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (!result.ok) {
      input.ctx.logger?.warn?.('crwu-workbench: 写审核脚本 runtime.json 失败 %o', { error: result.error })
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.ctx.logger?.warn?.('crwu-workbench: 写审核脚本 runtime.json 抛错 %o', { error: message })
    return { ok: false, error: message, path }
  }
}
