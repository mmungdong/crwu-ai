import { text } from '../../shared/utils/value.ts'

/**
 * 登录失败归因：**这两个按钮为什么起不来浏览器**。
 *
 * ## 为什么单独一条判据（2026-09-29 员工实测）
 *
 * 氚云扫码与钉钉登录都**必须写工作区之外的路径**：
 *
 * | 入口 | 必须写的东西 |
 * | --- | --- |
 * | `crwu h3yun session login` | 临时浏览器 profile（`$TMPDIR`/`%TEMP%` 下的 `crwu-scan-*`，再经 CDP 读会话） |
 * | `dws auth login [--device]` | `<HOME>\.dws\.data.lock`（拿登录态之前先抢文件锁） |
 * | 两者收尾 | 操作系统凭据存储（钥匙串 / Credential Manager） |
 *
 * 在 `workspace-write` 下这些写会被挡下，而**失败的样子完全不像权限问题**：
 * 氚云报 `mkdir …crwu-scan-…: Access is denied.`（看着像 CLI 坏了），
 * 钉钉报 `.data.lock: Access is denied.`（看着像 dws 自己的 bug），
 * 浏览器真起来了也会在几毫秒内 renderer 崩溃（CDP 只回一句 `close 1006` / `Target crashed`）。
 *
 * ## 与 `shell/run.ts` 的 `sandboxDenialNote()` 分工
 *
 * `sandboxDenialNote()` 是**通用**归因，顺序刻意是「结构化事实优先，事实说没拒就不猜文本」——
 * 因为对一条普通命令，`Access is denied` 可能是真 ACL / 文件占用，猜成沙箱会把员工指错方向。
 *
 * 登录是那条规则的**唯一例外**，理由是判据本身变强了：这里的目标不是"任意路径"，
 * 而是登录流程**必须**写的那几个已知目标（临时浏览器 profile / `.dws` 锁 / 凭据存储）。
 * 拒绝字样**配上这些目标**才归因，所以既不猜、也不会漏。
 *
 * 判据顺序（前三条都是结构化事实，最后一条才看文本）：
 * 1. `runnerFailed` —— 沙箱 runner 在命令跑起来之前就失败了；
 * 2. 提权被降级（`requested !== resolved`）—— 请求了完全访问、执行器按受限模式跑；
 * 3. `denied === true` 或实际跑在受限模式（`ran` / `resolved` 不是 `danger-full-access`）；
 * 4. 事实干净但原文点名了**登录必须写的工作区外目标**且带拒绝字样（Windows 实测就是这个形态）。
 */

/** 登录入口：两个域的"必须写什么"不同，文案也就不同。 */
export type LoginKind = 'h3yun' | 'dws'

export interface LoginSandboxFacts {
  requested?: unknown
  resolved?: unknown
  ran?: unknown
  denied?: unknown
  runnerFailed?: unknown
}

export interface LoginFailureFacts {
  error?: unknown
  stdout?: unknown
  stderr?: unknown
  exitCode?: number | null
  timedOut?: boolean
  sandbox?: LoginSandboxFacts
}

export interface LoginAdvice {
  /** 这次失败是否已经归因（DSH 策略挡下 **或** 这台机器拒绝）。 */
  blocked: boolean
  /**
   * true = **DSH 的文件策略**挡下的（结构化事实说了降级 / 拒绝 / 实际跑在受限模式）；
   * false = 策略允许（`requested = resolved = ran = danger-full-access`），
   * 是**这台机器**（安全软件按二进制规则 / 低完整性令牌 / 该目录 ACL）拒绝了这条命令写那个目标。
   *
   * 两支处置完全不同：前者切「完全权限」就够，后者**切权限一点用都没有** ——
   * 所以绝不能合成一句话（2026-09-29 员工实测：日志里三个模式都是完全访问，面板却在让人去切权限）。
   */
  policyBlocked: boolean
  /** 一句话原因（空串 = 没有归因，交给原始错误）。 */
  reason: string
  /** 员工能做的下一步（空串 = 没有可归因的动作）。 */
  action: string
}

/** 完全访问模式的字面量；只在**结构化事实**里比较。 */
const FULL_ACCESS = 'danger-full-access'

/**
 * 这一条命令**必须**能写的工作区外目标（大小写不敏感的子串）。
 *
 * 刻意保守：只登记登录流程真正会碰的东西。多写一个词就会把别的失败误判成沙箱问题。
 */
const LOGIN_TARGETS: Record<LoginKind, readonly string[]> = {
  // Go 侧 `os.MkdirTemp("", "crwu-scan-")`：临时浏览器 profile 的目录名。
  h3yun: ['crwu-scan-', 'crwu-scan'],
  // dws 的登录态目录与它抢的文件锁。
  dws: ['.dws', '.data.lock'],
}

/** 两个入口共有的目标：操作系统凭据存储。 */
const CREDENTIAL_STORE_TARGETS = ['keyring', 'credential store', 'credential-store', '钥匙串', '凭据存储'] as const

/** 拒绝字样。命中它**且**命中目标词才算归因。 */
const DENIED_MARKERS = [
  'access is denied', 'access denied', 'permission denied', 'operation not permitted',
  'eacces', 'eperm', '拒绝访问', '不允许', '被拒绝',
] as const

/** ① 策略挡下：原因是文件策略，动作是切「完全权限」。 */
const POLICY_REASONS: Record<LoginKind, string> = {
  h3yun: '氚云扫码登录要起一个临时浏览器配置目录（crwu-scan-*），当前文件策略超过工作区就不再放行',
  dws: '钉钉登录要先创建/打开登录态锁文件（在工作区之外的插件状态目录里），当前文件策略超过工作区就不再放行',
}

const POLICY_ACTIONS: Record<LoginKind, string> = {
  h3yun: '在输入框下方的访问模式里选「完全权限」（或输入 /permission danger-full-access），回到「账号连接」再点一次「扫码登录氚云」。',
  dws: '在输入框下方的访问模式里选「完全权限」（或输入 /permission danger-full-access），回到「账号连接」再点一次「钉钉登录」。设备码登录同样要创建/打开这个锁文件，在这个模式下也走不通。',
}

/**
 * ② 策略允许、**这台机器**拒绝（2026-09-29 员工 Windows 实测）。
 *
 * 实测事实（同一台机器、同一个用户、同一个 `dws.exe`）：
 * - 员工自己的（非管理员）PowerShell 能建目录、能跑 `dws auth login` 并打印授权链接；
 * - DSH 拉起的子进程**建目录与建锁文件都被拒**，换三个位置（主目录根、插件目录、手工预建的插件目录）都一样；
 * - **以管理员身份运行 DSH 后一次通过**。
 *
 * 所以「切【DSH 访问模式】」确实没用（三个模式都是 `danger-full-access`），但**把 DSH 提权**是有用的 ——
 * 这两件事在旧文案里被混成了一句「切权限不会有用」，实测已被证伪（2026-09-29 员工当场验证）。
 * 归因必须把「换目录解决不了」说清，并给出提权与「请 IT 放行该二进制」两条可执行路径。
 *
 * 2026-09-29 复验（员工当场确认）：提权那次登录成功之后，**用普通权限重启 DSH 依旧打不开已存在的锁**
 * —— 所以这**不是一次性步骤**：非提权运行时 `dws` 连打开已有文件都被拒。同一台机器上凡是依赖 `dws`
 * 的功能（知识库下载、钉钉归档与通知）因此同样需要提权，文案必须把影响面一起写出来。
 */
const MACHINE_REASONS: Record<LoginKind, string> = {
  h3yun: '氚云扫码登录要就地建一个临时浏览器配置目录（crwu-scan-*），而这台机器不让这次运行的命令创建它',
  dws: '钉钉登录要先创建/打开登录态锁文件，而这台机器不让这次运行的 `dws` 创建它',
}

const MACHINE_ACTIONS: Record<LoginKind, string> = {
  h3yun: '这不是工作区权限问题，换目录也没用：请求与实际都已是 danger-full-access，而这个二进制在这台机器上被按程序拦了。'
    + '实测有效的是**把 DSH 提权**：完全退出后右键 DSH →「以管理员身份运行」，完成一次登录。'
    + '长期建议让 IT 按程序放行随插件发布的 `crwu`（或改用本机终端里的 `crwu h3yun session bind --token <JWT>`，令牌不要发到对话里）。',
  dws: '这不是工作区权限问题，**换目录也没用**（插件已经不再自指定目录，全部回到 CLI 默认）：'
    + '主目录下的 `.dws`、插件状态目录、以及预先建好的目录都试过，'
    + '同一个 `dws.exe` 在 DSH 的非提权子进程里创建/打开登录态一律被拒；'
    + '而同一个人在自己的 PowerShell 里跑同一个 `dws` 是正常的。'
    + '**可行做法：完全退出 DSH，右键 →「以管理员身份运行」再登录**（凭据写进你自己账户的操作系统凭据存储）。'
    + '实测这**不是一次性步骤**：非提权运行时，即使登录态文件已经存在也打不开；'
    + '因此这台机器上凡是依赖 `dws` 的功能（知识库下载、钉钉归档与通知）同样需要提权才能用。'
    + '**长期正解：让 IT 按程序放行随插件发布的 `dws.exe`**（放行后即可恢复普通权限运行）。'
    + '「设备码登录」同样要创建这个锁文件，所以不是绕过办法。',
}

function textList(values: readonly unknown[]): string {
  return values.map((value) => text(value)).filter((value) => value !== '').join('\n').toLowerCase()
}

/** 命中拒绝字样，且原文点名了该入口**必须写**的工作区外目标。 */
function deniedOutsideWorkspace(kind: LoginKind, facts: LoginFailureFacts): boolean {
  const blob = textList([facts.stderr, facts.stdout, facts.error])
  if (blob === '') return false
  const denied = DENIED_MARKERS.some((marker) => blob.includes(marker))
  if (!denied) return false
  const targets = [...LOGIN_TARGETS[kind], ...CREDENTIAL_STORE_TARGETS]
  return targets.some((target) => blob.includes(target))
}

/** 一条没有归因的结论（调用方据此原样回原始错误）。 */
function none(): LoginAdvice {
  return { blocked: false, policyBlocked: false, reason: '', action: '' }
}

/**
 * 判据入口：给一次登录失败的事实，回答"是不是本机访问被挡在工作区之外"。
 *
 * 纯函数：没有 IO、没有时间、没有平台分支 —— 平台差异全部体现在传进来的事实里。
 */
export function loginFailureAdvice(kind: LoginKind, facts: LoginFailureFacts): LoginAdvice {
  const sandbox = facts.sandbox
  const requested = text(sandbox?.requested)
  const resolved = text(sandbox?.resolved)
  const ran = text(sandbox?.ran)
  const confined = (value: string): boolean => value !== '' && value !== FULL_ACCESS

  // ① runner 起不来：与命令本身无关，是沙箱后端的问题。
  if (sandbox?.runnerFailed === true) {
    return {
      blocked: true,
      policyBlocked: true,
      reason: 'DSH 的沙箱 runner 在命令跑起来之前就失败了（不是命令本身的业务失败）',
      action: POLICY_ACTIONS[kind],
    }
  }
  // ② 提权被降级：请求了完全访问，执行器解析回来是别的模式 —— 确定的证据。
  if (requested !== '' && resolved !== '' && requested !== resolved) {
    return {
      blocked: true,
      policyBlocked: true,
      reason: `提权请求被降级：请求 ${requested}，执行器实际按 ${resolved} 跑`,
      action: POLICY_ACTIONS[kind],
    }
  }
  // ③ 沙箱真的拒绝过，或实际就跑在受限模式下。
  if (sandbox?.denied === true) {
    return {
      blocked: true,
      policyBlocked: true,
      reason: `DSH 沙箱拒绝了这次操作（${ran || resolved || requested || '当前模式'}）`,
      action: POLICY_ACTIONS[kind],
    }
  }
  if (confined(resolved) || confined(ran)) {
    return {
      blocked: true,
      policyBlocked: true,
      reason: `登录进程实际跑在 ${ran || resolved} 下，写不了工作区之外的登录目标`,
      action: POLICY_ACTIONS[kind],
    }
  }
  // ④ 事实干净、但原文点名了登录必须写的工作区外目标：Windows 上实测就是这个形态
  //    （宿主按完全访问跑，操作系统的 ACL/受限令牌仍然拒绝 `%TEMP%` 与 `~/.dws`）。
  if (deniedOutsideWorkspace(kind, facts)) {
    return { blocked: true, policyBlocked: false, reason: MACHINE_REASONS[kind], action: MACHINE_ACTIONS[kind] }
  }
  // 没归因就是没归因：超时（浏览器开着等人扫）与业务失败都走原始错误，不在这里猜。
  return none()
}

/**
 * 把归因拼成一句给员工看的话（界面直接显示 `error`）。
 *
 * `original` 必须是**命令自己的原话**（stderr / 脱离沙箱前的错误），不是别的归因函数
 * 已经加工过的句子 —— 否则同一句"沙箱挡住了"会出现两次，员工会以为是两个故障。
 */
export function describeLoginAdvice(kind: LoginKind, advice: LoginAdvice, original: unknown): string {
  if (!advice.blocked) return text(original)
  // 两支的开头必须不同：说成"被文件策略挡下"会让人去切权限，而那一支切了没用。
  const head = advice.policyBlocked
    ? `本机访问被文件策略挡在工作区之外：${advice.reason}。`
    : `本机访问被这台机器拒绝（不是 DSH 的文件策略）：${advice.reason}。`
  const body = text(original).trim()
  const evidence = body === '' ? '' : `（原始报错：${body.slice(0, 300)}）`
  return `${head}${advice.action}${evidence}`
}
