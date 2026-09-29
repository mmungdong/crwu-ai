import { text } from '../../shared/utils/value.ts'

/**
 * 附件的**稳定本地名**。
 *
 * ## 为什么不能直接用原文件名
 *
 * 一份报告里可以挂着两个**同名但不同**的附件（实测：两个 `广兴建筑v3.zip`，20 343 211 字节，
 * `fileId` 不同）。按文件名落盘时第二个会**静默覆盖**第一个，于是审核只看到一份材料，
 * 而报告里其实有两份 —— 既可能漏检，也无法回答"这是同一份重复上传，还是两个版本"。
 *
 * 所以本地名里带上 `fileId` 的稳定短标识：`广兴建筑v3__c8ef13b8.zip`。
 * 判据是**确定性**的（同一个 `fileId` 永远得到同一个名字），不依赖下载顺序，
 * 也不依赖"先到先得"这种会随执行顺序漂移的去重。
 *
 * ## 边界
 *
 * - 只在**案例目录之内**用：这里不判断目标目录，只负责最后一段文件名；
 * - 文件名来自氚云（外部数据），所以先把它收敛成**单个路径段**：去掉路径分隔符、控制字符，
 *   空 / `.` / `..` 一律退化成 `附件`（绝不让外部数据决定路径形状）。
 */

/** 文件名里不允许出现的字符（路径分隔符、NUL、Windows 保留字符）。 */
const UNSAFE_IN_NAME = /[/\\\u0000-\u001f\u007f<>:"|?*]/g

/** `fileId` 的短标识：只取字母数字，前 8 位；少于 4 位时认为它不够区分，返回空串。 */
export function attachmentDiscriminator(fileId: unknown): string {
  const cleaned = text(fileId).replace(/[^0-9A-Za-z]/g, '')
  if (cleaned.length < 4) return ''
  return cleaned.slice(0, 8).toLowerCase()
}

/** 把外部文件名收敛成一个安全的路径段。 */
export function safeAttachmentFileName(fileName: unknown): string {
  const raw = text(fileName).replace(UNSAFE_IN_NAME, '_').trim()
  // 尾部的点 / 空格在 Windows 上会被静默吃掉（`a.zip.` → `a.zip`），先自己处理掉。
  const trimmed = raw.replace(/[.\s]+$/, '')
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return '附件'
  return trimmed
}

/**
 * 附件落盘时用的名字：`<主名>__<fileId 短标识><扩展名>`。
 *
 * `fileId` 短标识拿不到（异常数据）时退回安全化的原名 —— 宁可少一层区分，
 * 也不能编一个可能与另一个附件撞车的标识。
 */
export function attachmentLocalName(fileName: unknown, fileId: unknown): string {
  const safe = safeAttachmentFileName(fileName)
  const discriminator = attachmentDiscriminator(fileId)
  if (discriminator === '') return safe
  const dot = safe.lastIndexOf('.')
  // 点开头的隐藏文件（`.env`）不当作"有扩展名"：它没有主名可拼。
  const hasExtension = dot > 0 && dot < safe.length - 1
  const stem = hasExtension ? safe.slice(0, dot) : safe
  const extension = hasExtension ? safe.slice(dot) : ''
  return `${stem}__${discriminator}${extension}`
}

/**
 * 这个本地名是不是**带上了**该 `fileId` 的短标识。
 *
 * 判据是"包含"而不是"逐字相等"：调用方可能自己给名字加了前后缀（例如把同一份材料以外文名存一份），
 * 真正要防的只有"两个不同附件落成同一个名字"。
 */
export function hasAttachmentDiscriminator(localName: unknown, fileId: unknown): boolean {
  const discriminator = attachmentDiscriminator(fileId)
  if (discriminator === '') return true
  return text(localName).toLowerCase().includes(`__${discriminator}`)
}
