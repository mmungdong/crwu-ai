import { text } from '../../../../shared/utils/value.ts'

/**
 * 资料类型判定。
 *
 * 判据是**扩展名**（不是内容嗅探）：估值资料由员工从本机选上来，扩展名是他们与系统共同认可的
 * 那一份事实；而内容嗅探要么引入依赖、要么在沙箱里读不到头部字节。拿不准时判 `unknown` ——
 * 那是"未解析"，不是"当作文本试试"。
 */

export type ValuationFileKind = 'pdf' | 'word' | 'excel' | 'image' | 'text' | 'archive' | 'unknown'

/**
 * 第一版支持的类型。
 *
 * `.doc` / `.xls`（旧版二进制 Office）在列表里 —— 它们是员工手上真实存在的东西，
 * 直接拒绝会让人以为插件坏了。它们**能不能真读出来**由提取后端回答：读不了就进
 * `capabilityGaps`，界面照实说"这份文件没解析"。
 */
export const SUPPORTED_EXTENSIONS = [
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg',
] as const

/** 额外认得、但第一版不主动解析的类型（用于给出更准确的提示，而不是"不支持"）。 */
const EXTRA_KNOWN_EXTENSIONS: Record<string, ValuationFileKind> = {
  '.txt': 'text', '.md': 'text', '.csv': 'text', '.json': 'text',
  '.zip': 'archive', '.rar': 'archive', '.7z': 'archive',
  '.gif': 'image', '.bmp': 'image', '.webp': 'image', '.heic': 'image', '.tif': 'image', '.tiff': 'image',
  '.ppt': 'unknown', '.pptx': 'unknown',
}

const KIND_BY_EXTENSION: Record<string, ValuationFileKind> = {
  '.pdf': 'pdf',
  '.doc': 'word', '.docx': 'word',
  '.xls': 'excel', '.xlsx': 'excel', '.xlsm': 'excel',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  ...EXTRA_KNOWN_EXTENSIONS,
}

/** 取小写扩展名（含点）；没有扩展名时为空串。 */
export function extensionOf(fileName: unknown): string {
  const name = text(fileName).trim()
  const at = name.lastIndexOf('.')
  // 前导点（`.gitignore`）与末位点都不算扩展名。
  if (at <= 0 || at === name.length - 1) return ''
  return name.slice(at).toLowerCase()
}

/** 文件类型；认不出来是 `unknown`。 */
export function kindOf(fileName: unknown): ValuationFileKind {
  const ext = extensionOf(fileName)
  return ext === '' ? 'unknown' : (KIND_BY_EXTENSION[ext] ?? 'unknown')
}

/** 第一版**主动解析**的类型（其余一律记 capability gap）。 */
export function isSupportedFileName(fileName: unknown): boolean {
  const ext = extensionOf(fileName)
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 图片扩展名 → MIME 子类型。
 *
 * 显式列出来而不是裁切扩展名：`'.jpeg'.replace('.jpeg', 'jpg').slice(1)` 会得到 `pg`，
 * 于是内容类型变成 `image/pg` —— 这种错不会抛异常，只会让下游按错的类型处理。
 */
const IMAGE_SUBTYPE: Record<string, string> = {
  '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg',
  '.gif': 'gif', '.bmp': 'bmp', '.webp': 'webp',
  '.heic': 'heic', '.tif': 'tiff', '.tiff': 'tiff',
}

/** 内容类型（给 Host 的附件元数据与提示词用）；认不出来是 `application/octet-stream`。 */
export function contentTypeOf(fileName: unknown): string {
  switch (kindOf(fileName)) {
    case 'pdf': return 'application/pdf'
    case 'word': return extensionOf(fileName) === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/msword'
    case 'excel': return extensionOf(fileName) === '.xlsx' || extensionOf(fileName) === '.xlsm'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/vnd.ms-excel'
    case 'image': return `image/${IMAGE_SUBTYPE[extensionOf(fileName)] ?? 'octet-stream'}`
    case 'text': return 'text/plain'
    case 'archive': return 'application/zip'
    default: return 'application/octet-stream'
  }
}

/** 人话类型名（界面与 `capabilityGaps` 用）。 */
export function kindLabel(kind: ValuationFileKind): string {
  switch (kind) {
    case 'pdf': return 'PDF'
    case 'word': return 'Word 文档'
    case 'excel': return 'Excel 表格'
    case 'image': return '图片'
    case 'text': return '文本'
    case 'archive': return '压缩包'
    default: return '未知类型'
  }
}
