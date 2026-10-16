import { text } from '../../../../shared/utils/value.ts'
import type { ArchivedMaterial } from '../../../../shared/contracts/valuation-project.ts'

/**
 * 归档资料的**元信息**（面板确认抽屉逐行显示的那一份）。
 *
 * ## 为什么要单独一个文件
 *
 * 元信息的字段与"归档改名规则"是**跨层契约**：面板按它显示、确认摘要按它的一部分算指纹、
 * 归档目录按它落盘。三处各写一遍命名规则，迟早出现"界面显示的名字"和"落盘的名字"不是同一个，
 * 而那种错在确认抽屉里看不出来（两边都像对的）。
 *
 * ## 绝对路径只在这一层出现
 *
 * `absolutePath` 是给**员工本人**核对"我选的是哪一份"的；它不进确认摘要、不进冻结输入、
 * 不进交接指令、不进报告（设计稿 §5 / §11.1）。所以取指纹时走 `fingerprintOf()` ——
 * 它**显式**挑字段，而不是"把对象丢进去序列化"，免得将来加一个字段就悄悄改变了模型看到的东西。
 */

/** 面板确认抽屉里的一行（也是归档结果本身）。 */
export interface MaterialMetadata {
  /** 稳定标识：同一批资料里唯一，`fileId` 之间不会撞（同名不同路径也能分辨）。 */
  fileId: string
  /** 原名称（不含任何改名后缀）：显示标签，也是员工认得出的那一个。 */
  fileName: string
  /** 源文件在员工机器上的原始绝对路径。**只回显给面板**。 */
  absolutePath: string
  /** 归档副本相对项目目录的路径（唯一、已按 `-2` / `-3` 去重）。 */
  archiveRelativePath: string
  /** 粗分类（pdf / word / excel / image / text / archive / unknown）。 */
  kind: string
  sizeBytes: number
  /** **归档副本**的字节指纹（复制后重算，不沿用源文件自报值）。 */
  sha256: string
  /** 创建时间；`birthtime` 不可靠时是 `null`（界面显示"创建时间未知"，**不许**拿 mtime 冒充）。 */
  createdAt: string | null
  modifiedAt: string | null
  readable: boolean
  /** 内容与本批另一份相同时填对方的 `fileId`（真实路径不同但字节相同）。 */
  duplicateOf: string | null
}

/** 第 N 份资料的 `fileId`（1 起）。顺序即清单顺序，所以结果确定。 */
export function materialFileId(index: number): string {
  return `material-${String(Math.max(1, Math.floor(index))).padStart(3, '0')}`
}

/**
 * 归档文件名：重名时按 `-2` / `-3` … 追加到**主干**上（扩展名保持在末尾）。
 *
 * 为什么不用"目录 + 短 id"：员工要在案例目录里一眼认出这是哪一份资料。改名只在真的重名时发生，
 * 且必然是同名不同路径（同路径在扫描阶段已经被去重）。
 */
export function archiveNameOf(fileName: unknown, taken: ReadonlySet<string>): string {
  const name = text(fileName).trim() || 'material'
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let index = 2
  while (taken.has(`${stem}-${index}${extension}`)) index += 1
  return `${stem}-${index}${extension}`
}

/**
 * 记录"这一份的字节与前面某一份完全相同"。
 *
 * 去重**不等于**丢弃：两条都进清单、都归档、都保留来源关系；只是把重复关系写下来，
 * 让下游（提取、报告）可以复用解析结果而不必假装它们是两份不同的材料。
 */
export function takeDuplicate(fileId: string, sha256: string, firstBySha: Map<string, string>): string | null {
  const previous = firstBySha.get(sha256)
  if (previous === undefined) {
    firstBySha.set(sha256, fileId)
    return null
  }
  return previous
}

/** 进指纹的字段（**不含** `absolutePath`）：加字段时这里必须显式加，不许顺带漏出去。 */
export function fingerprintOf(file: MaterialMetadata): Record<string, unknown> {
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    archiveRelativePath: file.archiveRelativePath,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    duplicateOf: file.duplicateOf,
  }
}

/** 转成跨进程合同里的 `ArchivedMaterial`（这一步就是"丢掉绝对路径"）。 */
export function toArchivedMaterial(file: MaterialMetadata): ArchivedMaterial {
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    archiveRelativePath: file.archiveRelativePath,
    kind: file.kind,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    createdAt: file.createdAt,
    modifiedAt: file.modifiedAt,
    readable: file.readable,
    duplicateOf: file.duplicateOf,
  }
}

export function toArchivedMaterials(files: readonly MaterialMetadata[]): ArchivedMaterial[] {
  return files.map(toArchivedMaterial)
}
