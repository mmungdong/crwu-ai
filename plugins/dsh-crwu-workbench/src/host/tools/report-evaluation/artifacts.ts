import { stageSkillScript, type StageInput } from '../../domains/report-evaluation/artifacts/stage.ts'
import {
  VALUATION_CASES_FILE,
  VALUATION_INPUT_FILE,
  VALUATION_OBJECT_FILE,
  VALUATION_PARAMS_FILE,
  VALUATION_REPORT_FILE,
  VALUATION_RESULT_FILE,
  VALUATION_WORKBOOK_FILE,
} from './consts.ts'

/**
 * 估值案例目录里的**交付件与中间件清单**（顺序即展示顺序）。
 *
 * 单独一份而不是散在各 Tool 里：交付校验、结果页、RPC 的 `valuation-result` 都要用同一张清单，
 * 各写一遍必然会漂移成"校验说齐了、结果页说少一件"。
 */
export const VALUATION_OUTPUT_FILES = [
  VALUATION_WORKBOOK_FILE,
  VALUATION_REPORT_FILE,
  VALUATION_RESULT_FILE,
  VALUATION_OBJECT_FILE,
  VALUATION_CASES_FILE,
  VALUATION_PARAMS_FILE,
  VALUATION_INPUT_FILE,
] as const

/** 三个**必须存在**的交付件（其余是中间件）。 */
export const VALUATION_REQUIRED_FILES = [
  VALUATION_WORKBOOK_FILE,
  VALUATION_REPORT_FILE,
  VALUATION_RESULT_FILE,
] as const

/** 把技能脚本落到案例目录（校验与构建脚本共用一条落盘路径）。 */
export async function stagedValuationScript(
  input: Omit<StageInput, 'relative'> & { relative: string },
): Promise<{ ok: boolean; error: string; scriptPath: string }> {
  if (!input.relative.startsWith('scripts/')) {
    return { ok: false, error: `只允许落案例内的技能脚本（scripts/…）：${input.relative}`, scriptPath: '' }
  }
  return await stageSkillScript(input)
}
