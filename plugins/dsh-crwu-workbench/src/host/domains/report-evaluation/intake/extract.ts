import { text } from '../../../../shared/utils/value.ts'
import { kindLabel, type ValuationFileKind } from './classify.ts'
import { dedupeOrdered, emptyExtraction, type ExtractedFile, type ExtractionOutcome, type FileExtractor } from './types.ts'

/**
 * 多类型资料提取的**编排层**。
 *
 * 它只做三件事，都不含"怎么读"：
 *   ① 按注册顺序挑出第一个能处理这份文件的提取器；
 *   ② 把单份结果汇总成整轮的 `ExtractionOutcome`；
 *   ③ 任何一份读不出来都**如实登记**，且**不阻塞其他文件**。
 *
 * 三条硬口径（都来自审核链路的教训）：
 *   - 没有提取器 / 提取抛错 → 该文件进 `unparsed` + `capabilityGaps`，**不猜内容**；
 *   - 扫描件没有文本层 → 由提取器报 `PDF 无文本层，需要 OCR` 这类缺口，
 *     编排层**不**把它当成功（空正文不是"读到了空内容"）；
 *   - 提取器报的 `capabilityGaps` / `warnings` 一律上浮到整轮汇总（去重、保序），
 *     否则界面看不到"这一轮其实是降级的"。
 */

export interface ExtractInput {
  files: ReadonlyArray<{ path: string; fileName: string; kind: ValuationFileKind }>
  extractors: readonly FileExtractor[]
}

/** 一份提取器都无法处理的返回（不生成 `ExtractedFile`）。 */
function unhandled(fileName: string, kind: ValuationFileKind): string {
  return `未解析：${fileName}（${kindLabel(kind)}，当前没有可用的提取器）`
}

/** 提取失败（抛错）的缺口文案：带上真实原因，否则用户无从下手。 */
function failed(fileName: string, kind: ValuationFileKind, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `未解析：${fileName}（${kindLabel(kind)}，读取失败：${detail}）`
}

export async function runExtraction(input: ExtractInput): Promise<ExtractionOutcome> {
  const outcome = emptyExtraction()
  const gaps: string[] = []
  const warnings: string[] = []

  for (const file of input.files) {
    const fileName = text(file.fileName)
    const extractor = input.extractors.find((candidate) => {
      try {
        return candidate.canHandle('', fileName) || candidate.canHandle(contentTypeHint(file.kind), fileName)
      } catch (error) {
        // 判定本身抛错 = 这个提取器不可用：跳过它，但要说出来（静默吞掉会让"为什么没解析"无从查起）。
        warnings.push(`${fileName}：一个提取器在判断能否处理时出错（${error instanceof Error ? error.message : String(error)}）`)
        return false
      }
    })

    if (extractor === undefined) {
      outcome.unparsed.push(fileName)
      gaps.push(unhandled(fileName, file.kind))
      continue
    }

    let extracted: ExtractedFile
    try {
      extracted = await extractor.extract({ path: file.path, fileName, kind: file.kind })
    } catch (error) {
      outcome.unparsed.push(fileName)
      gaps.push(failed(fileName, file.kind, error))
      continue
    }

    // 提取器自己报的缺口是**这一份读不全**的证据：一份正文为空、又没有任何缺口的 PDF，
    // 只可能是提取器写错了。这里不替它编缺口，但也不把它当成"成功读到空内容" ——
    // 记一条观察，让界面与结果 JSON 都能看见。
    if (text(extracted.text) === '' && extracted.tables.length === 0 && extracted.images.length === 0
      && extracted.capabilityGaps.length === 0) {
      warnings.push(`${fileName}：提取结果为空，且没有报告任何能力缺口 —— 请人工确认这份资料。`)
    }

    outcome.files.push(extracted)
    gaps.push(...extracted.capabilityGaps.map((gap) => gap.startsWith('未解析') ? gap : `未解析：${fileName}（${gap}）`))
    warnings.push(...extracted.warnings.map((warning) => `${fileName}：${warning}`))
  }

  outcome.capabilityGaps = dedupeOrdered(gaps)
  outcome.warnings = dedupeOrdered(warnings)
  return outcome
}

/**
 * 内容类型提示。
 *
 * 类型判定在 `classify.ts` 只做一次（按扩展名），这里把类型翻回一个内容类型，
 * 让"按内容类型判断"的提取器也能命中 —— 装配方可能只实现了内容类型那一半。
 */
function contentTypeHint(kind: ValuationFileKind): string {
  switch (kind) {
    case 'pdf': return 'application/pdf'
    case 'word': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'excel': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'image': return 'image/'
    case 'text': return 'text/'
    default: return ''
  }
}

/** 空的单份提取结果（提取器内部拼装用；保证字段齐全，避免各处少写一个数组）。 */
export function emptyExtractedFile(fileName: string, fileType: ValuationFileKind): ExtractedFile {
  return {
    fileName,
    fileType,
    text: '',
    tables: [],
    images: [],
    extractedFields: {},
    warnings: [],
    capabilityGaps: [],
  }
}
