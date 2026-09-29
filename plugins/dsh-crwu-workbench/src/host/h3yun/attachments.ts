import { text } from '../../shared/utils/value.ts'
import { jsonObject } from '../tools/outcome.ts'
import { attachmentLocalName } from './attachment-name.ts'

/**
 * 氚云附件元数据的**规范化行**（从 `crwu h3yun files list` 的应答里取）。
 *
 * 为什么单独一个模块：审核启动的输入快照与**讨论会话的受限材料范围**都要用它，
 * 而两处的口径必须逐字一致 —— 尤其是 `localName`（同名附件不许互相覆盖的判据）
 * 与 `nameIndex` / `nameTotal`（"这是两件材料"的判据）。
 * 各写一份的结果是：快照里的名字与讨论会话下载用的名字对不上，工具会拒绝那条下载。
 */

/** 一行附件元数据。`downloadUrl` 明确丢弃（它带会话鉴权，不进快照、不进模型上下文）。 */
export interface AttachmentRow {
  field: string
  fileId: string
  fileName: string
  /** 落盘时用的**稳定本地名**（`<主名>__<fileId 短标识><扩展名>`）。 */
  localName: string
  fileSize: string
  contentType: string
  /** 同名附件里的序号与总数（1 起）：用来判断"重复上传"还是"两个版本"。 */
  nameIndex: number
  nameTotal: number
}

/**
 * 解析 `files list` 的应答（`{ data: [ { field, fileId, fileName, fileSize, contentType, downloadUrl } ] }`）。
 *
 * 形状不对时返回 `null`（调用方按 CLI 失败上报），**不返回空数组** ——
 * 空数组会被读成"这条报告没有附件"，那是另一件事。
 */
export function attachmentsOf(payload: unknown): AttachmentRow[] | null {
  const doc = jsonObject(payload)
  if (doc === null || !Array.isArray(doc.data)) return null
  const rows = (doc.data as unknown[]).map((row) => {
    const item = row !== null && typeof row === 'object' ? row as Record<string, unknown> : {}
    const fileName = text(item.fileName)
    const fileId = text(item.fileId)
    return {
      field: text(item.field),
      fileId,
      fileName,
      localName: attachmentLocalName(fileName, fileId),
      fileSize: text(item.fileSize),
      contentType: text(item.contentType),
    }
  }).filter((item) => item.fileId !== '')
  // 同名统计：`fileName` 相同（逐字）的那些，按出现顺序编号。
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.fileName, (totals.get(row.fileName) ?? 0) + 1)
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const index = (seen.get(row.fileName) ?? 0) + 1
    seen.set(row.fileName, index)
    return { ...row, nameIndex: index, nameTotal: totals.get(row.fileName) ?? 1 }
  })
}
