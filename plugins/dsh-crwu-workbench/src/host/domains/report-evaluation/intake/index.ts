/**
 * 报告评估（房地产估值）资料入口。
 *
 * 只导出契约与纯函数：真正的字节读取由案例目录里的 Python 脚本承担
 * （`skills/biz/crwu-biz-valuation-realestate/scripts/extract_files.py`），
 * 通过结构化 Tool 驱动 —— 这一层不碰 shell、不碰 fs。
 */
export {
  SUPPORTED_EXTENSIONS,
  contentTypeOf,
  extensionOf,
  isSupportedFileName,
  kindLabel,
  kindOf,
} from './classify.ts'
export type { ValuationFileKind } from './classify.ts'
export {
  DEFAULT_MAX_FILE_BYTES,
  SOURCE_MATERIAL_DIR,
  buildIntakeManifest,
  sha256OfBytes,
  validateIntakeSelection,
} from './manifest.ts'
export type {
  IntakeCandidate,
  IntakeManifest,
  IntakeRejection,
  IntakeSelection,
  IntakeSelectionInput,
} from './manifest.ts'
export { emptyExtractedFile, runExtraction } from './extract.ts'
export type { ExtractInput } from './extract.ts'
export {
  EXTRACT_OUTPUT_DIR,
  EXTRACT_SCRIPT_DIR,
  EXTRACT_SCRIPT_NAME,
  EXTRACT_TIMEOUT_MS,
  packagedExtractScriptPath,
  pythonFileExtractor,
} from './python-extractor.ts'
export type { PythonExtractorDeps } from './python-extractor.ts'
export { dedupeOrdered, emptyExtraction } from './types.ts'
export type {
  ExtractedFile,
  ExtractedTable,
  ExtractionOutcome,
  FileExtractor,
  IntakeFile,
} from './types.ts'
