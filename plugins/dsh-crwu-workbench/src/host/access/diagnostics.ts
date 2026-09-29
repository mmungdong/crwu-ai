import { text } from '../../shared/utils/value.ts'
import type { LocalAccessOperation, LocalAccessSource } from './operations.ts'
import {
  classifyAccessFailure as classifyFromFacts,
  processStartedOf as processStartedFromFacts,
  type AccessClassifyInput,
  type AccessErrorClass,
  lockRelatedIn as classifyLockRelatedIn,
} from './classify.ts'

/**
 * 归因类别与分类判据的**单一事实源**在 `classify.ts`（协议 18 · 子项目 D1）。
 *
 * 本模块只负责"记什么、留多久"；"这次为什么失败"由分类器回答。两者拆开是因为分类器要接受
 * **平台原生探测**的结论（子项目 D 的 doctor 提供），而诊断缓冲不该知道钥匙串与 ACL 的存在。
 */
export type { AccessErrorClass } from './classify.ts'

/**
 * 本机访问的**结构化诊断**（协议 18 · 子项目 B3）。
 *
 * ## 为什么必须收结构化事实，而不是把错误文本分类
 *
 * 员工在 Windows 上看到的三段报错（写 `~/.ossutilconfig` 被拒、`secret not found in keyring`、
 * `dws` 的 `.data.lock: Access is denied`）表现完全不同，原因却可以是同一个沙箱降级；
 * 反过来，同样一句 `Access is denied` 也可能是真实的 NTFS ACL、或者一份被别的进程占用的文件。
 * **文本分不出来，事实能分出来。**
 *
 * 所以每一条诊断都记：请求了什么模式、`resolve()` 回来什么模式、命令**实际**跑在什么模式、
 * 沙箱是否真的拒绝过、runner 是否在命令起来之前就挂了。归因只从这些事实推（文本判据是
 * 最后兜底，且**事实在手时不看文本** —— 见 `shell/run.ts` 的 `sandboxDenialNote` 注释）。
 *
 * ## 脱敏
 *
 * 诊断里允许出现的只有：操作名、来源、模式、几个布尔、错误类别、版本与时刻。
 * **绝不出现** AccessKey、token、Cookie、登录二维码内容、文件正文、未脱敏的 argv。
 * 命令摘要由各执行器（`describeDwsCommand` / `describeCrwuCommand`）生成，它们只保留域与子命令。
 */

export interface AccessDiagnostic {
  operation: LocalAccessOperation
  source: LocalAccessSource
  /** 授权收据的 schema 版本；0 = 当时未授权。 */
  consentVersion: number
  /** 请求的沙箱模式（空串 = 没声明，交给执行器默认）。 */
  requestedMode: string
  /** `resolve()` 回来、执行器实际会用的模式。 */
  resolvedMode: string
  /** 命令**实际**跑在哪个模式。 */
  ranMode: string
  sandboxDenied: boolean
  runnerFailed: boolean
  errorClass: AccessErrorClass
  /** 原始失败是否与 `.data.lock` 有关（脱敏布尔事实：只回答"像不像锁"，不带任何文本）。 */
  lockRelated: boolean
  /** 是否真的产生过一个进程（`false` = 命令没跑起来）。 */
  processStarted: boolean
  hostVersion: string
  protocolVersion: number
  /** 执行器给出的**已脱敏**命令摘要（只有域 + 子命令，不含业务标识与凭据）。 */
  summary: string
  at: string
}

/**
 * 诊断的原始输入：结构化事实 + （只用于分类、**不入库**的）输出文本。
 *
 * `text` 存在的原因：macOS 钥匙串与 DWS 锁的失败**没有**结构化字段可判，只能看原话。
 * 它进分类器、出 `errorClass`，**绝不进** `AccessDiagnostic`。
 */
export type AccessFactsInput = AccessClassifyInput

/** 从执行事实（+ 平台原生探测）推归因。见 `classify.ts` 的优先级表。 */
export function classifyAccessFailure(input: AccessFactsInput): AccessErrorClass {
  return classifyFromFacts(input)
}

/**
 * 这段文本是不是「与 `.data.lock` 有关」（**只**回答像不像锁，不含任何身份/路径判断）。
 *
 * 在 `diagnostics.ts` 再导出一次，是为了让 Broker 记录事实时不必同时 import 两个模块 ——
 * 判据仍然只有 `classify.ts` 里那一份。
 */
export function lockRelatedIn(text: string): boolean {
  return classifyLockRelatedIn(text)
}

/** 进程有没有真的起来过。`runnerFailed` 或基础设施错误都算「没起来」。 */
export function processStartedOf(input: AccessFactsInput): boolean {
  return processStartedFromFacts(input)
}

export interface AccessDiagnostics {
  record(diagnostic: AccessDiagnostic): void
  /** 最近 N 条（新的在前）。返回值是**快照**，调用方改不动内部状态。 */
  list(): AccessDiagnostic[]
  clear(): void
}

/**
 * 诊断摘要的**脱敏口径**：只保留"命令词"，最多四个。
 *
 * 摘要来自调用方（`ossutil ls（列举交付件）` 这种静态标签，或 `describeCrwuCommand` /
 * `describeDwsCommand` 从 argv 前缀拼出来的字符串）。**argv 里可能有路径**：
 * 只要命令形状碰巧把路径放进前几个词，摘要就会把员工的本地目录带进界面与"复制诊断"文本。
 *
 * 所以这里按词过滤：含路径分隔符（`/` `\`）、盘符冒号或 `~` 开头的词一律丢掉。
 * 丢掉而不是"整条拒收"：宁可少一条摘要，也不让一条诊断把路径带出去。
 */
export function sanitizeDiagnosticSummary(raw: unknown): string {
  const words = text(raw).split(/\s+/).filter((word) => word !== '')
  const safe: string[] = []
  for (const word of words) {
    // **遇到第一个像路径/主目录的词就停**（不是"跳过它继续拼"）：后面的词多半是同一个
    // 实参的碎片，拼起来只会得到半截路径。
    if (/[/\\:~]/.test(word)) break
    safe.push(word)
    if (safe.length >= 4) break
  }
  return safe.join(' ')
}

/** 诊断条数上限：开发者诊断只给人看最近这些，不做无限累积。 */
export const ACCESS_DIAGNOSTIC_LIMIT = 50

/**
 * 环形缓冲。
 *
 * 放内存、随插件实例释放：诊断是**排障快照**，不是审计日志 —— 落盘会引入"诊断文件在哪、
 * 怎么轮转、会不会带上凭据"这一整套新问题，而它要回答的问题（"刚才那次为什么失败"）
 * 在同一个进程生命周期里就有答案。
 */
export function createAccessDiagnostics(limit = ACCESS_DIAGNOSTIC_LIMIT): AccessDiagnostics {
  const size = limit > 0 ? Math.trunc(limit) : ACCESS_DIAGNOSTIC_LIMIT
  let items: AccessDiagnostic[] = []
  return {
    record(diagnostic) {
      // **摘要也脱敏**（协议 18 · B3）：调用方给的往往是命令前缀（`describeCrwuCommand` /
      // `describeDwsCommand`），而"前四个词"在某些命令形状里可以含路径或 ID。
      // 诊断要进界面与"复制诊断"文本，所以这里统一收一道：只留不含分隔符/冒号的命令词。
      items = [{ ...diagnostic, summary: sanitizeDiagnosticSummary(diagnostic.summary) }, ...items].slice(0, size)
    },
    list: () => items.map((item) => ({ ...item })),
    clear() { items = [] },
  }
}
