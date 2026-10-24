import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { text } from '../../../shared/utils/value.ts'
import { joinLocalPath } from '../../../shared/utils/local-path.ts'
import { packageRootFrom } from '../../core/platform/package-root.ts'

/**
 * 审核技能脚本的**运行期依赖位置**。
 *
 * `crwu-audit` 的脚本（`prepare_materials.py` 等）被复制进 `<案例>/scripts/` 后执行，
 * 而它们需要的纯 Python 包（`pypdf`）**不在 DSH 运行时里**。随包 wheel 留在插件安装目录，
 * 由 Host 把它的绝对路径写进 `<案例>/scripts/runtime.json`：
 *
 * - wheel 逐案复制既慢又多一份可被误改的副本（与 `ocr-skill` 同一条口径）；
 * - 脚本按 `runtime.json.pythonVendor` 解析，插件升级后自动指向新包；
 * - 模型提交不了这个路径，也不该提交 —— 依赖位置不是业务输入。
 */
export const AUDIT_SCRIPTS_DIR = 'scripts'
export const AUDIT_RUNTIME_FILE = 'runtime.json'

const AUDIT_VENDOR_SEGMENTS = ['skills', 'crwu', 'crwu-audit', 'vendor', 'wheels'] as const

/** 是否是案例内的审核技能脚本：`scripts/<name>.py`（OCR 暂存目录另有自己的判定）。 */
export function isAuditScript(relative: string): boolean {
  const canonical = text(relative).trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return /^scripts\/[^/]+\.py$/i.test(canonical) && !canonical.startsWith('ocr-skill/')
}

/** 随包 wheel 根的绝对路径；包不完整时为空串（调用方按"没有依赖"如实记账）。 */
export function auditVendorRoot(sourceRoot?: string): string {
  const root = sourceRoot ?? packageRootFrom(dirname(fileURLToPath(import.meta.url)))
  return root === '' ? '' : joinLocalPath(root, ...AUDIT_VENDOR_SEGMENTS)
}

/** `runtime.json` 的内容：只有依赖位置与工具版本无关的事实。 */
export function auditRuntimeConfig(sourceRoot?: string): string {
  const pythonVendor = auditVendorRoot(sourceRoot)
  return `${JSON.stringify({
    schemaVersion: 1,
    pythonVendor,
    pythonVendorNote: 'crwu-audit 随包纯 Python 依赖目录（pypdf）；审核模型不提交此路径',
  }, null, 1)}\n`
}
