import { createHash } from 'node:crypto'
import { text } from '../../../../shared/utils/value.ts'
import { isLocalPathUnder, trimTrailingSeparators } from '../../../../shared/utils/local-path.ts'
import { kindOf, type ValuationFileKind } from './classify.ts'
import type { IntakeFile } from './types.ts'

/**
 * 输入清单：一轮估值**吃进去什么**的客观记录。
 *
 * 两个用途，都必须可追溯：
 *   1. 用户确认抽屉里逐行显示（文件名 / 类型 / 大小 / 解析状态）；
 *   2. 结果 JSON 里留 `sha256`，让"这份结果对应哪一版资料"可核对 —— 用户重传同一份文件
 *      时指纹不变，改了内容必然变。
 */

/** `sha256:<hex>`；与审核链路的 `digestOf` 同形（跨链路比对不会被前缀绊倒）。 */
export function sha256OfBytes(bytes: Uint8Array | string): string {
  const hash = createHash('sha256')
  hash.update(bytes)
  return `sha256:${hash.digest('hex')}`
}

/** 候选资料（Host 解析出真实路径之后、复制进案例目录之前）。 */
export interface IntakeCandidate {
  /** 展示名。 */
  fileName: string
  /** 本机真实路径（只用于读取与越界判定，**不进**提示词）。 */
  path: string
  sizeBytes: number
}

/** 被拒的一份资料。`kind` 给代码看，`reason` 给人看。 */
export interface IntakeRejection {
  fileName: string
  kind: 'empty' | 'unsupported' | 'out-of-bounds' | 'too-large' | 'duplicate'
  reason: string
}

export interface IntakeSelection {
  accepted: IntakeCandidate[]
  rejected: IntakeRejection[]
}

export interface IntakeSelectionInput {
  candidates: readonly IntakeCandidate[]
  /**
   * 允许读取的根目录（**必须**至少给一个）。
   *
   * 为什么是"根清单"而不是单个根：估值资料既可能来自员工自己选的本机文件，
   * 也可能来自 Host 已经落进案例目录的材料。两者都在白名单里显式列出，
   * 而不是"凡是绝对路径都放行"。
   */
  allowedRoots: readonly string[]
  /** 单份文件上限（字节）。默认 200MB —— 超过这个量级的一定是误选。 */
  maxFileBytes?: number
}

export const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024

/**
 * 校验一轮资料选择。
 *
 * 三条判据（都是 fail closed，**不**静默跳过）：
 *   ① 空文件（`sizeBytes === 0`）直接拒绝 —— 它一定是没写完或选错了，当成"解析失败"会掩盖原因；
 *   ② 路径必须落在允许的根目录下（防止提示词或界面被构造成读任意文件）；
 *   ③ 超过大小上限的直接拒绝（不截断：截断后的表格会得到错误的数字）。
 *
 * 不在这里拒绝"不支持的类型"：那是**解析状态**（界面要显示"未解析"），不是选择错误 ——
 * 员工交上一张 `.tif` 扫描件是正常行为，插件该说的是"这份没解析"，而不是"你不该选它"。
 */
export function validateIntakeSelection(input: IntakeSelectionInput): IntakeSelection {
  const roots = input.allowedRoots.map((root) => trimTrailingSeparators(text(root))).filter((root) => root !== '')
  const max = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const accepted: IntakeCandidate[] = []
  const rejected: IntakeRejection[] = []
  const seen = new Set<string>()

  for (const candidate of input.candidates) {
    const fileName = text(candidate.fileName) || text(candidate.path)
    const path = trimTrailingSeparators(text(candidate.path))
    if (path === '') {
      rejected.push({ fileName, kind: 'out-of-bounds', reason: '这份资料没有可读取的路径。' })
      continue
    }
    if (roots.length === 0 || !roots.some((root) => isLocalPathUnder(path, root))) {
      rejected.push({ fileName, kind: 'out-of-bounds', reason: '这份资料不在本轮允许读取的目录里。' })
      continue
    }
    if (seen.has(path)) {
      rejected.push({ fileName, kind: 'duplicate', reason: '同一份文件被选了两次。' })
      continue
    }
    if (!Number.isFinite(candidate.sizeBytes) || candidate.sizeBytes <= 0) {
      rejected.push({ fileName, kind: 'empty', reason: '这份资料是空文件（0 字节），请重新导出后再上传。' })
      continue
    }
    if (candidate.sizeBytes > max) {
      rejected.push({
        fileName,
        kind: 'too-large',
        reason: `这份资料超过单份上限（${Math.round(max / 1024 / 1024)}MB），请拆分后再上传。`,
      })
      continue
    }
    seen.add(path)
    accepted.push({ fileName, path, sizeBytes: candidate.sizeBytes })
  }
  return { accepted, rejected }
}

export interface IntakeManifest {
  generatedAt: string
  files: IntakeFile[]
  /** 整份清单的指纹：顺序固定（按 `relativePath` 升序）后哈希。 */
  digest: string
}

/** 案例目录内的资料落点目录名。 */
export const SOURCE_MATERIAL_DIR = '材料-源'

/**
 * 生成输入清单。
 *
 * 顺序**固定**（按相对路径升序）：指纹要能被重复计算出来，而"用户选择的顺序"不是稳定事实
 * （重选一次顺序就变了，指纹跟着变，历史结果就再也对不上）。
 */
export function buildIntakeManifest(input: {
  files: ReadonlyArray<Omit<IntakeFile, 'kind' | 'contentType'> & { kind?: ValuationFileKind; contentType?: string }>
  now?: Date
}): IntakeManifest {
  const files: IntakeFile[] = input.files
    .map((file) => ({
      fileName: text(file.fileName),
      relativePath: text(file.relativePath),
      kind: file.kind ?? kindOf(file.fileName),
      contentType: text(file.contentType),
      sizeBytes: file.sizeBytes,
      sha256: text(file.sha256),
    }))
    .sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))

  const digest = sha256OfBytes(JSON.stringify(files.map((file) => ({
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  }))))

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    files,
    digest,
  }
}
