import { isWindowsPlatform } from '../platform/detect.ts'

/**
 * 本机访问失败的**归因分类器**（协议 18 · 子项目 D1）。
 *
 * ## 为什么分类必须由事实主导、文本只做兜底
 *
 * 员工在 Windows 上看到的三段报错表现完全不同，原因却可以是同一个沙箱降级：
 *
 * | 表象 | 真实原因可能是 |
 * | --- | --- |
 * | 写 `~/.ossutilconfig` 报 `file access denied under workspace-write mode` | DSH 沙箱拒绝（**确定**） |
 * | `crwu h3yun session status` 报 `secret not found in keyring` | 受限沙箱读不到钥匙串（看着像「没登录」） |
 * | `dws` 报 `.data.lock: Access is denied` | 沙箱写不了 `~/.dws`，**或者**真的 NTFS ACL，**或者**锁被别的进程占着 |
 * | macOS `sandbox-exec: sandbox_apply: Operation not permitted` | 嵌套沙箱起不来（不是命令缺失、不是凭据错） |
 * | macOS `errSecInteractionNotAllowed` / `-25308` | 真的钥匙串 ACL / 交互策略（**不是**没登录） |
 *
 * 同一句 `Access is denied` 可能是三种完全不同的原因，而处置分别是「改部署」「修 ACL」「关掉占着锁的
 * 进程」—— **文本分不出来，事实能分出来**。所以：
 *
 * 1. 有结构化事实（requested / resolved / ran / denied / runnerFailed）时，**文本不能翻案**：
 *    第 5~7 档的平台级判断都以「实际跑在 `danger-full-access` 且 `denied !== true`」为前置，
 *    前置不成立就直接落到 `cli` / `infrastructure`，**不看**文本说的是不是"权限不足"。
 * 2. 完全没有结构化事实时（例如旧客户端的日志、或一个不经执行器的失败），才允许按文本兜底 ——
 *    而且仍然要求**正向证据**（DSH 自己的标记、或平台原生探测 confirmed），不做"看着像"的猜测。
 *
 * ## 平台原生结论从哪来
 *
 * `os-credential-store` / `file-lock` / `os-filesystem-permission` 三档需要**平台原生检查**
 * （钥匙串探测、锁占用探测、ACL / 模式位检查）。这些探测由子项目 D 的只读 doctor 执行，结果作为
 * `probes` 传进来 —— 分类器本身是**纯函数**，不跑命令、不读文件。
 */

/**
 * 归因类别。
 *
 * 前五档是本项目自己产生的（授权 / 来源 / 沙箱 / 审批 / 降级），
 * `os-*` 与 `file-lock` 需要平台原生检查，最后两档是通用兜底。
 */
export type AccessErrorClass =
  | ''
  | 'not-authorized'
  | 'invalid-source'
  | 'sandbox-denied'
  | 'sandbox-downgraded'
  | 'approval-denied'
  | 'os-filesystem-permission'
  | 'os-credential-store'
  | 'file-lock'
  | 'cli'
  | 'infrastructure'

/** 执行器给出的沙箱事实（`ctx.shell` 的 `sandbox` 字段，未脱敏前的原样）。 */
export interface AccessSandboxFacts {
  requested?: unknown
  resolved?: unknown
  ran?: unknown
  denied?: unknown
  runnerFailed?: unknown
}

/**
 * **平台原生探测**的正向结论。
 *
 * 三个都是"确实如此"的布尔，而不是"可能是"：只有真的探测到才置 true。
 * 拿不到结论时留 `undefined`（分类器不会把它当 false，而是当"没证据"）。
 */
export interface AccessOsProbes {
  /** 平台原生访问检查确认「当前账户被拒」（Windows ACL / POSIX 模式位/所有权）。 */
  filesystemAccessDenied?: boolean
  /** 锁探测确认「锁文件打不开 / 被别的进程持有」。 */
  lockHeld?: boolean
  /** 凭据存储探测确认「交互或访问被拒绝」（macOS 钥匙串）。 */
  credentialStoreDenied?: boolean
  /** 凭据存储探测确认「条目就是不存在」（= 真的没登录），用于把它与"被拒"分开。 */
  credentialStoreMissing?: boolean
  /**
   * **原始那次失败**与 `.data.lock` 有关（由 Broker 在记录时算好的**脱敏布尔事实**）。
   *
   * 为什么必须由 Broker 给：doctor 跑分类器时手里的 `text` 是**本次体检**的输出，
   * 不是原来那次失败的文本（原文本从不落盘）。没有这个事实，"机器上恰好有人持锁"
   * 就会把任何一次 DWS 失败改写成 `file-lock`（用户复查的 P2）。
   */
  lockRelated?: boolean
}

export interface AccessClassifyInput {
  platform?: string
  sandbox?: AccessSandboxFacts
  /** 执行器的基础设施错误（命令**没跑起来**）；空串表示进程起来了。 */
  error?: string
  exitCode?: number | null
  /**
   * 已收集到的输出文本（stdout + stderr）。
   *
   * ⚠️ **只用于分类，绝不进诊断**：诊断里存的是 `errorClass`，不是这段文本
   * （它可能带着路径、CLI 的原始报错，甚至上游返回的片段）。
   */
  text?: string
  probes?: AccessOsProbes
}

const MODE_FULL_ACCESS = 'danger-full-access'

/** DSH 沙箱自己的标记：`file access denied under <mode> mode`（最确定的一条）。 */
const DSH_SANDBOX_MARKER = /file access denied under [a-z-]+ mode/i

/**
 * macOS 嵌套沙箱起不来。
 *
 * 这一条必须**先于**任何"权限不足"的判据：`Operation not permitted` 也出现在文件权限错误里，
 * 但 `sandbox_apply` 是 runner 自己的失败 —— 设计文档 §D5 明确要求它**永远**不能被翻译成
 * 「命令缺失」「没登录」「凭据无效」。
 */
const SANDBOX_RUNNER_SIGNATURE = /sandbox_apply|sandbox-exec:.*operation not permitted/i

/**
 * macOS 凭据存储的「交互 / 访问被拒」。
 *
 * 与「条目不存在」是两件事，处置也完全不同（前者要用户去钥匙串里放开权限，后者才是"去登录"）。
 * 这些指纹都是 macOS 自己吐出来的原话。
 */
const CREDENTIAL_STORE_DENIAL = [
  /errsecinteractionnotallowed/i,
  /user interaction is not allowed/i,
  /\b-25308\b/,
  /errsecauthfailed/i,
  /keychain[\s\S]{0,40}(access denied|not allowed|denied)/i,
  /secitemcopymatching[\s\S]{0,60}(denied|not permitted|-25308)/i,
] as const

/** 「条目就是不存在」——这一档才是真的"没登录"。 */
const CREDENTIAL_STORE_MISSING = [
  /secret not found in keyring/i,
  /errsecitemnotfound/i,
  /\b-25300\b/,
  /item could not be found in the keychain/i,
] as const

/**
 * DWS 的锁文件失败。
 *
 * 真实的形态（2026-09-28 员工实测）：
 * `acquiring file lock: opening lock file: open C:\Users\<用户>\.dws\.data.lock: Access is denied.`
 * ——**同一句**既可能是沙箱写不了，也可能是真 ACL，也可能是锁被占着。所以文本只用来
 * "这是锁相关"，定性必须靠 `probes.lockHeld`。
 */
const FILE_LOCK_SIGNATURE = [
  /\.data\.lock/i,
  /acquiring file lock/i,
  /opening lock file/i,
  /being used by another process/i,
  /resource temporarily unavailable/i,
  /another process has locked/i,
] as const

/** 平台原生权限不足的文本形态（只在没有结构化事实、或探测已确认时用）。 */
const FILESYSTEM_PERMISSION_SIGNATURE = [
  /access is denied/i,
  /permission denied/i,
  /\beacces\b/i,
  /operation not permitted/i,
] as const

const APPROVAL_SIGNATURE = /approval|denied|reject|审批/i

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/** 命令**实际**跑在完全访问下吗（`ran` 优先，没有 `ran` 时看 `resolved`）。 */
export function actualFullAccessOf(facts: AccessSandboxFacts | undefined): boolean {
  const ran = asText(facts?.ran)
  if (ran !== '') return ran === MODE_FULL_ACCESS
  return asText(facts?.resolved) === MODE_FULL_ACCESS
}

/**
 * 从执行事实（+ 平台原生探测）推归因。**纯函数、无 IO**，优先级照设计文档 §D1：
 *
 * 1. `runnerFailed` → `infrastructure`
 * 2. 请求 DFA、解析回来**或实际跑**的是别的模式 → `sandbox-downgraded`
 * 3. 沙箱确实拒绝过 → `sandbox-denied`
 * 4. 进程没起来（审批拒绝）→ `approval-denied`；否则 → `infrastructure`
 * 5. 实际 DFA + 未被拒 + 凭据存储被判拒（探测或 macOS 指纹）→ `os-credential-store`
 * 6. 实际 DFA + 未被拒 + 锁文本 + **锁探测为真** → `file-lock`
 * 7. 实际 DFA + 未被拒 + 平台原生访问检查为真 → `os-filesystem-permission`
 * 8. 进程起来了、退出码非 0 → `cli`
 * 9. 其余 → `infrastructure`（进程没起来）或空串（成功）
 *
 * 「文本不能翻案」的落点：第 5~7 档都带**结构化前置**（实际 DFA 且 `denied !== true`）；
 * 前置不成立就不看文本。完全没有结构化事实时才走文本兜底，且兜底里
 * `sandbox_apply` 与 DSH 自己的沙箱标记**优先**，不会被"权限不足"吃掉。
 */
export function classifyAccessFailure(input: AccessClassifyInput): AccessErrorClass {
  const facts = input.sandbox
  const structured = facts !== undefined
  const requested = asText(facts?.requested)
  const resolved = asText(facts?.resolved)
  const ran = asText(facts?.ran)
  const denied = facts?.denied === true
  const text = `${asText(input.text)}`
  const probes = input.probes ?? {}

  // ① runner 在命令起来之前就挂了：这是**基础设施**故障，不是命令缺失、不是凭据错。
  if (facts?.runnerFailed === true) return 'infrastructure'

  // ② 提权请求被降级 —— 必须排在"沙箱拒绝"之前：降级时 `denied` 也可能为 true，
  //    但处置完全不同（一个是宿主/部署的问题，一个是策略问题）。
  if (requested === MODE_FULL_ACCESS
    && ((resolved !== '' && resolved !== requested) || (ran !== '' && ran !== requested))) {
    return 'sandbox-downgraded'
  }

  // ③ 沙箱确实拒绝过。
  if (denied) return 'sandbox-denied'

  // ④ 进程没起来：审批拒绝与基础设施故障要分开。
  const error = asText(input.error)
  if (error !== '') {
    return APPROVAL_SIGNATURE.test(error) ? 'approval-denied' : 'infrastructure'
  }

  // ⑤⑥⑦ 平台级归因。前置：**实际**跑在完全访问下、且沙箱没有拒绝过。
  //    `structured === false`（没有任何结构化事实）时才允许纯文本兜底。
  const platformVerdictAllowed = !structured || (actualFullAccessOf(facts) && !denied)
  if (platformVerdictAllowed) {
    // 文本兜底里**最确定的两个信号先判**，而且先于平台探测：
    // `sandbox_apply` 是 runner 自己的失败、DSH 的 `file access denied under <mode> mode`
    // 是宿主自己的标记 —— 两者都比"探测说这个账户没权限"更能解释这次失败，
    // 也绝不能被 `Operation not permitted` / `Access is denied` 这类重合字样吃掉（§D5）。
    if (!structured && SANDBOX_RUNNER_SIGNATURE.test(text)) return 'infrastructure'
    if (!structured && DSH_SANDBOX_MARKER.test(text)) return 'sandbox-denied'

    const macLike = !isWindowsPlatform(asText(input.platform))
    const credentialDenied = probes.credentialStoreDenied === true
      || (macLike && matchesAny(CREDENTIAL_STORE_DENIAL, text))
    // "条目不存在"被显式探测到时不判成"被拒"：那才是真的没登录。
    if (credentialDenied && probes.credentialStoreMissing !== true) return 'os-credential-store'

    const lockLike = probes.lockRelated ?? matchesAny(FILE_LOCK_SIGNATURE, text)
    // **锁必须由正向探测定性**：`.data.lock: Access is denied` 同一句话有三种原因，
    // "看着像锁"是其中最不可靠的一种。文本单独出现（哪怕完全没有结构化事实）也不定性 ——
    // 旧实现留了个 `lockLike && !structured → file-lock` 的口子，等于让文本翻案，
    // 与设计 §D 的"锁文本 + 正向锁探测"不一致（2026-09-29 复查抓到）。
    // ⚠️ **两个条件都要**：原始失败必须与锁有关（`lockRelated`），**且**现在有正向探测
    // 证明真的有人持有它。只看 `lockHeld` 会把"凭据不存在/认证失败 + 机器上恰好有进程持锁"
    // 说成文件锁 —— 员工于是去关一个无关的程序（用户复查的 P2）。
    if (probes.lockHeld === true && lockLike) return 'file-lock'

    const permissionLike = matchesAny(FILESYSTEM_PERMISSION_SIGNATURE, text)
    if (probes.filesystemAccessDenied === true) return 'os-filesystem-permission'
    // 走到了这里说明上面两条"确定性信号"都没命中，文本兜底才敢按权限读。
    // 但**锁文本不算**：`.data.lock: Access is denied` 长得就像权限不足，而它有三种原因；
    // 没有正向锁探测时它落通用兜底（`cli`），不落"本机文件权限问题"——后者会开出一个
    // 真会改权限的修复按钮。
    if (!structured && permissionLike && !lockLike) return 'os-filesystem-permission'
  }

  // ⑧⑨ 通用兜底。
  //
  // 「条目不存在」（`secret not found in keyring` / `errSecItemNotFound`）**不**在这里单独成类：
  // 它意味着命令**跑完了**、如实回报「没登录」——那是 `cli` 的正常结果，不是操作系统问题。
  // 「没登录」与「钥匙串被拒」的区分由 doctor 的 `credentialStoreState` 承担（§D4），
  // 分类器只负责不把后者说成前者。
  if (typeof input.exitCode === 'number' && input.exitCode !== 0) return 'cli'
  return ''
}

/** 进程有没有真的起来过。`runnerFailed` 或基础设施错误都算「没起来」。 */
export function processStartedOf(input: Pick<AccessClassifyInput, 'sandbox' | 'error'>): boolean {
  if (input.sandbox?.runnerFailed === true) return false
  return asText(input.error) === ''
}

/** 这段文本是不是"凭据不存在"（真的没登录）—— 用于把"没登录"与"被拒"分开。 */
export function credentialStoreMissingIn(text: string): boolean {
  return matchesAny(CREDENTIAL_STORE_MISSING, text)
}

/** 这段文本是不是「钥匙串交互/访问被拒」。 */
export function credentialStoreDeniedIn(text: string): boolean {
  return matchesAny(CREDENTIAL_STORE_DENIAL, text)
}

/** 这段文本是不是「锁相关」（不区分原因）。 */
export function lockRelatedIn(text: string): boolean {
  return matchesAny(FILE_LOCK_SIGNATURE, text)
}
