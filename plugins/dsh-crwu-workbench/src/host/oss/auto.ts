import type { Context } from '@deepseek-ai/cordis'
import type { EnvManifest } from '../environment/manifest-default.ts'
import { ossutilMissingMessage, resolveOssutil } from '../environment/probe.ts'
import { resolveTarget } from '../fs/paths.ts'
import { inspectCase } from '../audit/case.ts'
import type { AuditRecord } from '../state/types.ts'
import { uploadArtifacts } from './ops.ts'

/**
 * 出结果就自动上传。
 *
 * 为什么要有它：交付件由**子会话自己**写进案例目录，插件拿不到「写完了」的信号，
 * 所以只能等轮询到这里再传。失败不抛错 —— 上传失败必须留痕在记录里
 * （`uploadError`），界面据此提供「重新上传」，而不是静默略过。
 */

export interface AutoUploadDeps {
  ctx: Context
  manifest: EnvManifest
  platform: string
  home: string
  workdir: () => Promise<string>
}

export interface UploadOutcome {
  ok: boolean
  error: string
  prefix: string
}

/**
 * 上传一次交付件（如果现在有东西可传）。
 *
 * **两种「没传上去」必须区分开**（这里比 legacy 严格，见 PORTING.md 的差异表）：
 *
 * - **还没有东西可传**（没定位到案例目录 / 案例目录里还没有交付件）：只把原因返回给调用方，
 *   **不写 `uploadError`**。写了界面就会给一条尚未出结果的记录挂上「上云失败」徽章，
 *   用户会去点「重传 OSS」，而其实只是审核还没跑完。
 * - **真的尝试上传但失败**：写 `uploadError`，界面据此提供重传。
 *
 * 两条路径都必须把 `uploading` 放回 false，否则这条记录再也不会被重试。
 */
export async function maybeAutoUpload(deps: AutoUploadDeps, record: AuditRecord): Promise<UploadOutcome> {
  if (record.uploading === true || record.uploadedAt !== '') return { ok: false, error: '无需上传', prefix: '' }
  const oss = deps.manifest.oss
  if (!oss.enabled || oss.bucket === '' || !oss.autoUpload) return { ok: false, error: '自动上云未启用', prefix: '' }
  if (record.casePath === '') return { ok: false, error: '尚未定位案例目录', prefix: '' }

  record.uploading = true
  try {
    const lookup = await resolveOssutil(deps.ctx, oss, deps.platform, {
      manifest: deps.manifest,
      home: deps.home,
      workdir: await deps.workdir(),
    })
    // 「环境还没准备好」同样是**没有东西可传**，不算上传失败 —— 环境自检页会单独报缺 ossutil。
    // 探测本身失败（沙箱不可用）与「确实没装」都只回原因，绝不写 `uploadError`。
    if (lookup.path === '') {
      record.uploading = false
      return { ok: false, error: ossutilMissingMessage(lookup), prefix: '' }
    }
    const ossutil = lookup.path

    let item = null
    try {
      item = await inspectCase(deps.ctx, await resolveTarget(deps.ctx, record.casePath))
    } catch (error) {
      void error
      item = null
    }
    if (item === null || (item.htmlFile === '' && item.resultFile === '')) {
      record.uploading = false
      return { ok: false, error: item === null ? '案例目录不可读' : '案例还没有交付件', prefix: '' }
    }

    const out = await uploadArtifacts(deps, item, record.key, ossutil, oss)
    record.uploading = false
    if (out.ok) {
      record.uploadedAt = new Date().toISOString()
      record.uploadError = ''
      record.ossPrefix = out.prefix
    } else {
      record.uploadError = (out.error || '上传失败').slice(0, 300)
    }
    return { ok: out.ok, error: out.error, prefix: out.prefix }
  } catch (error) {
    // 走到这里说明是**上传过程本身**出的问题（命令抛错等），才写 uploadError。
    record.uploading = false
    record.uploadError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    return { ok: false, error: record.uploadError, prefix: '' }
  }
}

/** 一轮扫描：处理「当前活动的」或「已结束但还没传的」记录。返回是否还有待上传项。 */
export async function runUploadWatch(deps: AutoUploadDeps & {
  state: { audits: Record<string, AuditRecord>; activeKey: string }
}): Promise<boolean> {
  const { state } = deps
  for (const record of Object.values(state.audits)) {
    if (record.uploadedAt !== '' || record.uploading === true) continue
    if (record.key !== state.activeKey && record.ended !== true) continue
    await maybeAutoUpload(deps, record)
  }
  return Object.values(state.audits).some((record) => record.uploadedAt === ''
    && record.uploadError === ''
    && (record.uploading === true || record.key === state.activeKey))
}
