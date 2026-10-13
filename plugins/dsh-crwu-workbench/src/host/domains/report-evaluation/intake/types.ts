import type { ValuationFileKind } from './classify.ts'

/**
 * 报告评估（房地产估值）的**资料提取契约**。
 *
 * 这一层只描述"我们承诺能交出什么"，不描述"用什么工具读"。原因：读取要靠案例目录里的
 * Python 脚本（DSH 自带运行时 + openpyxl 等），而契约要能被工具层、提示词层与校验层共用。
 *
 * 一条硬口径继承自审核链路：**读不出来就说读不出来**。
 * 未解析的文件进 `capabilityGaps`，绝不允许模型按文件名猜内容（猜出来的字段会一路进计算）。
 */

/** 一份进入本轮的资料文件（已经落到案例目录里的形态）。 */
export interface IntakeFile {
  /** 展示名（用户看到的原始文件名）。 */
  fileName: string
  /** 案例目录内的相对路径，例如 `材料-源/估值报告.pdf`。 */
  relativePath: string
  kind: ValuationFileKind
  /** 主机给出的内容类型；拿不到时为空串。 */
  contentType: string
  sizeBytes: number
  /** `sha256:<hex>`；同一份文件重复上传时值相同。 */
  sha256: string
}

/** 从 Excel 等表格资料里取出的一张表。 */
export interface ExtractedTable {
  name: string
  rows: string[][]
}

/** 单份文件的提取结果。 */
export interface ExtractedFile {
  fileName: string
  fileType: ValuationFileKind
  text: string
  tables: ExtractedTable[]
  images: Array<{ path: string; description?: string }>
  /**
   * 从正文/表格里**实际读到**的字段（坐落、用途、面积…）。
   *
   * 只放读到的东西：读不到就不出现 —— 缺失由 `missingFields` 与
   * `manual_confirmation_items` 表达，不用空串冒充。
   *
   * 值一律是**字符串**：提取只做"标签锚定"（`坐落：某路 1 号`），不做类型推断。
   * 让这里收 `unknown` 会诱导下游把 `{value: 1}` 这类结构塞进来，而估值字段的消费者
   * （确认抽屉 / 表格 / JSON）要的是可显示、可比对的原文。
   */
  extractedFields: Record<string, string>
  /** 非致命观察（编码回退、表格被截断…）。 */
  warnings: string[]
  /** 能力缺口（扫描件没有文本层、旧版 .doc 读不了…）。 */
  capabilityGaps: string[]
}

/**
 * 一种文件类型的提取器。
 *
 * `canHandle` 按**内容类型 + 文件名**判断（不看扩展名之外的线索）：同一种内容类型可能由
 * 不同后端实现（例如 PDF 文本层 vs OCR），选择权交给装配方。
 */
export interface FileExtractor {
  canHandle(contentType: string, fileName: string): boolean
  extract(input: { path: string; fileName: string; kind: ValuationFileKind }): Promise<ExtractedFile>
}

/** 整轮提取的汇总。 */
export interface ExtractionOutcome {
  files: ExtractedFile[]
  /** 一份都没解析出来的文件（文件名，不含路径）。 */
  unparsed: string[]
  /** 本轮累计的能力缺口（去重、保持出现顺序）。 */
  capabilityGaps: string[]
  /** 累计的非致命观察。 */
  warnings: string[]
}

/** 空结果（没有可提取文件，或全部失败）。 */
export function emptyExtraction(): ExtractionOutcome {
  return { files: [], unparsed: [], capabilityGaps: [], warnings: [] }
}

/** 按出现顺序去重（能力缺口与观察都要稳定，不能因为去重换顺序）。 */
export function dedupeOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const item = value.trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
