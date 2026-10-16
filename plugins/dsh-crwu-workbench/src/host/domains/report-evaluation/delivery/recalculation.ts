import { joinLocalPath } from '../../../../shared/utils/local-path.ts'
import { text } from '../../../../shared/utils/value.ts'

/**
 * **工作簿重算能力的探测与执行**（设计稿 §10.3，计划 Task 9）。
 *
 * ## 为什么"重算"不能靠打开文件那个动作
 *
 * DSH 自带的 Python / openpyxl **不计算公式**：它读回来的是上次保存时缓存的数值。
 * 于是有三种"看起来完成了"的假象：
 *
 * 1. 用 openpyxl 读了 `=F5*G5` 的缓存值，然后说"重算通过" —— 那个值可能是员工上次
 *    用别的输入算的；
 * 2. "已写入公式"当成"已算出数值" —— 公式链是对的，数值没人算过；
 * 3. 打开一次 LibreOffice 就宣告成功 —— 进程起来了不等于算完、也不等于数值与 JSON 一致。
 *
 * 这个模块的职责就是**不产生这三种假象**：没有受 Broker 验证的本地表格程序时，
 * 明确返回 `unavailable`，调用方据此把报告标成 `partial`（保留公式正确的底稿，
 * 写明"待重算"），而不是 `completed`。
 *
 * ## 能力探测与执行都经 Broker
 *
 * `probe` 与 `run` 都是注入的：生产装配把它们接到本机访问操作（`excel.local` /
 * `libreoffice.local`），测试注入内存替身。这个模块自己不碰 `node:child_process`。
 */

export type RecalculationState = 'recalculated' | 'unavailable' | 'failed'

export interface RecalcProvider {
  id: 'excel.local' | 'libreoffice.local'
  /** 探测到的可执行程序标识（只作诊断，不含绝对凭据路径）。 */
  detail: string
}

export interface WorkbookRecalculationInput {
  taskId: string
  /** 工作簿相对案例目录的路径（受控路径；调用方已校验）。 */
  workbookRelativePath: string
  /** 案例目录的受控根。 */
  caseRoot: string
  /** JSON 侧的对象数字（用于回读核对；数字一律是十进制字符串）。 */
  expected: ReadonlyArray<{ objectId: string; unitPrice: string | null; totalValue: string | null }>
}

export interface RecalculationOutcome {
  state: RecalculationState
  reason: string
  /** 用哪个 provider 做的；`unavailable` 时为空串。 */
  providerId: string
  /** 回读并逐项核对通过才为 true。**默认 false**。 */
  verified: boolean
  /** 回读到的数值摘要（供报告的技术过程；不含整表内容）。 */
  observed: ReadonlyArray<{ objectId: string; unitPrice: string | null; totalValue: string | null }>
  recalculatedAt: string
  /** 逐项不一致的说明（`verified: false` 时非空）。 */
  mismatches: string[]
}

export interface RecalculationDeps {
  /** 探测本机可用的表格程序（经 Broker）。 */
  probe: () => Promise<RecalcProvider[]>
  /**
   * 执行一次重算并**回读缓存值**。
   *
   * 契约：返回的就是"重算之后从文件里读回来的数值"，而不是"我们期望的数值"。
   * 实现方不得把期望值回填成观测值 —— 那样核对永远是绿的。
   */
  run: (input: { provider: RecalcProvider; workbookAbsolutePath: string }) => Promise<{
    ok: boolean
    error?: string
    observed?: ReadonlyArray<{ objectId: string; unitPrice: string | null; totalValue: string | null }>
  }>
  now?: () => string
}

export interface WorkbookRecalculator {
  /** 探测可用 provider（不执行重算）。 */
  providers: () => Promise<RecalcProvider[]>
  /** 重算并核对；没有 provider 时返回 `unavailable`。 */
  recalculate: (input: WorkbookRecalculationInput) => Promise<RecalculationOutcome>
}

function sameNumber(a: string | null, b: string | null): boolean {
  // 十进制字符串比较：允许尾随零差异（`1.10` 与 `1.1` 是同一个数），但不做浮点近似。
  const normalize = (value: string | null): string => {
    const raw = text(value).trim()
    if (raw === '') return ''
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return raw
    // 只在**有小数点**时去掉尾随零：`39800.0` → `39800`，而 `39800` 必须原样保留
    // （`/0+$/` 会把它削成 `398`，那是个静默的数值篡改）。
    return raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw
  }
  return normalize(a) === normalize(b)
}

export function createWorkbookRecalculator(deps: RecalculationDeps): WorkbookRecalculator {
  const now = deps.now ?? (() => new Date().toISOString())

  const unavailable = (reason: string): RecalculationOutcome => ({
    state: 'unavailable',
    reason,
    providerId: '',
    // 关键：没有重算能力时**永远**不是 verified —— 否则报告会以 completed 交付一个没核对过的数字。
    verified: false,
    observed: [],
    recalculatedAt: now(),
    mismatches: [],
  })

  return {
    providers: async () => {
      try {
        return await deps.probe()
      } catch {
        // 探测失败 = 没有可用 provider（不是"假装可用"）。
        return []
      }
    },

    async recalculate(input) {
      const providers = await this.providers()
      if (providers.length === 0) {
        return unavailable(
          '本部署没有经验证的本地表格程序（Excel / LibreOffice）：底稿公式正确，但数值未重算，'
          + '本轮只能交付 partial 并标注「待重算」。',
        )
      }
      // 拼接走方言适配器：Windows 上 `C:\Work` + `/` 会混用分隔符，进 shell 就是一条坏路径。
      const absolute = joinLocalPath(input.caseRoot, input.workbookRelativePath)
      const failures: string[] = []
      for (const provider of providers) {
        let run: Awaited<ReturnType<RecalculationDeps['run']>>
        try {
          run = await deps.run({ provider, workbookAbsolutePath: absolute })
        } catch (error) {
          failures.push(`${provider.id} 执行失败：${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (!run.ok) {
          failures.push(`${provider.id} 未成功：${text(run.error) || '未给出原因'}`)
          continue
        }
        const observed = run.observed ?? []
        // **回读核对**：逐对象比对 JSON 侧数字。缺项也算不一致 ——
        // "读不到"和"对得上"是两件事。
        const mismatches: string[] = []
        for (const item of input.expected) {
          const got = observed.find((row) => row.objectId === item.objectId)
          if (got === undefined) {
            mismatches.push(`${item.objectId}：重算后读不到该对象的数值`)
            continue
          }
          if (!sameNumber(item.unitPrice, got.unitPrice ?? null)) {
            mismatches.push(`${item.objectId}：单价 JSON=${text(item.unitPrice) || '(空)'} 底稿=${text(got.unitPrice) || '(空)'}`)
          }
          if (!sameNumber(item.totalValue, got.totalValue ?? null)) {
            mismatches.push(`${item.objectId}：总价 JSON=${text(item.totalValue) || '(空)'} 底稿=${text(got.totalValue) || '(空)'}`)
          }
        }
        if (mismatches.length > 0) {
          return {
            state: 'recalculated',
            reason: `${provider.id} 完成了重算，但回读数值与 JSON 不一致：不能声称已核对`,
            providerId: provider.id,
            verified: false,
            observed,
            recalculatedAt: now(),
            mismatches,
          }
        }
        return {
          state: 'recalculated',
          reason: `${provider.id} 完成重算，回读数值与 JSON 逐项一致`,
          providerId: provider.id,
          verified: true,
          observed,
          recalculatedAt: now(),
          mismatches: [],
        }
      }
      return {
        state: 'failed',
        reason: `重算没有成功：${failures.join('；') || '未知原因'}。底稿保留公式，报告只能标 partial。`,
        providerId: '',
        verified: false,
        observed: [],
        recalculatedAt: now(),
        mismatches: [],
      }
    },
  }
}

/**
 * 由重算结论决定报告状态的上限。
 *
 * **没有重算能力就无法 completed** —— 这是设计稿 §10.3 的硬口径：`completed` 表示
 * "数字与底稿都被核对过"，而没重算的数字没有被核对过。
 */
export function statusCeilingFromRecalculation(outcome: RecalculationOutcome): 'completed' | 'partial' {
  return outcome.state === 'recalculated' && outcome.verified ? 'completed' : 'partial'
}
