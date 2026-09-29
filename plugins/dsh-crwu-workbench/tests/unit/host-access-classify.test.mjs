/**
 * 归因分类器的测试（协议 18 · 子项目 D1）。
 *
 * 判据是设计文档 §D1 的九档优先级，样本是**员工真实报回来的原话**
 * （`docs/superpowers/specs/2026-09-28-desktop-local-access-design.md` §2 那张表）。
 *
 * 这一层最容易犯的错是"看着像就定性"：同一句 `Access is denied` 可能是沙箱拒绝、真 NTFS ACL、
 * 或者锁被占用，而三者的处置完全不同。所以每条用例都成对出现 —— **有结构化事实**与
 * **只有文本**两种输入下分别该得出什么结论，以及"事实在手时文本不许翻案"的反向用例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const {
  classifyAccessFailure, processStartedOf, actualFullAccessOf,
  credentialStoreDeniedIn, credentialStoreMissingIn, lockRelatedIn,
} = await import(new URL('src/host/access/classify.ts', ROOT).href)

/** 员工报回来的真实文本（逐字抄，不要"改写得更通顺"）。 */
const SAMPLES = {
  ossutilWrite: 'file access denied under workspace-write mode',
  keyring: 'secret not found in keyring',
  dwsLock: 'acquiring file lock: opening lock file: open C:\\Users\\某某\\.dws\\.data.lock: Access is denied.',
  nestedSandbox: 'sandbox-exec: sandbox_apply: Operation not permitted',
  keychainInteraction: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.',
  keychainStatus: 'errSecInteractionNotAllowed (-25308)',
  plainDenied: 'Access is denied.',
  missingBinary: 'crwu: command not found',
}

const fullAccess = { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false }

// ── ① runner 失败：永远不是"命令缺失/没登录/凭据无效"（§D5） ────────────────

test('D-01 · macOS 嵌套沙箱：runnerFailed 与文本签名都归 infrastructure，绝不翻译成别的原因', () => {
  const structured = classifyAccessFailure({
    platform: 'darwin-arm64',
    sandbox: { ...fullAccess, runnerFailed: true },
    text: SAMPLES.nestedSandbox,
    exitCode: null,
  })
  assert.equal(structured, 'infrastructure')
  // 只有文本时（没有结构化事实）：仍然必须是基础设施 —— 而不是"权限不足"。
  const textOnly = classifyAccessFailure({ platform: 'darwin-arm64', text: SAMPLES.nestedSandbox, exitCode: null })
  assert.equal(textOnly, 'infrastructure', 'sandbox_apply 的 Operation not permitted 不许被读成文件权限问题')
})

test('命令缺失（真的没这个二进制）不会被说成权限问题', () => {
  assert.equal(classifyAccessFailure({
    platform: 'darwin-arm64',
    sandbox: fullAccess,
    exitCode: 127,
    text: SAMPLES.missingBinary,
  }), 'cli')
})

// ── ②③ 沙箱降级与沙箱拒绝 ──────────────────────────────────────────────────

test('D-01 · 提权被降级（resolved 或 ran 对不上）→ sandbox-downgraded，且优先于 sandbox-denied', () => {
  // resolved 就降级了。
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: { ...fullAccess, resolved: 'workspace-write', ran: 'workspace-write' },
  }), 'sandbox-downgraded')
  // 活过了 resolve()、执行时才降级（最难发现的一种）。
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: { ...fullAccess, ran: 'workspace-write', denied: true },
  }), 'sandbox-downgraded', '降级与拒绝同时出现时，降级是更能解释这次失败的那个')
})

test('D-01 · DSH 自己的标记是"确定"的沙箱拒绝：有事实、没事实都必须认出来', () => {
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: { ...fullAccess, denied: true, ran: '' },
    text: SAMPLES.ossutilWrite,
  }), 'sandbox-denied')
  // 没给结构化事实（旧日志）：仍然认出 DSH 的标记。
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    text: SAMPLES.ossutilWrite,
    exitCode: 1,
  }), 'sandbox-denied')
})

test('DHS 沙箱标记不会被"权限不足"吃掉（顺序：沙箱标记先于 os-filesystem-permission）', () => {
  const verdict = classifyAccessFailure({
    platform: 'win32-x64',
    text: `${SAMPLES.plainDenied} file access denied under workspace-write mode`,
    exitCode: 1,
    // 即便有人误报了"平台原生检查确认被拒"，DSH 自己的标记仍然是更确定的那一条。
    probes: { filesystemAccessDenied: true },
  })
  assert.notEqual(verdict, 'os-filesystem-permission')
})

// ── ④ 审批拒绝 vs 基础设施 ─────────────────────────────────────────────────

test('审批在进程创建之前被拒 → approval-denied；其它"没跑起来"→ infrastructure', () => {
  const sandbox = { requested: 'danger-full-access', resolved: 'danger-full-access', ran: '', denied: false, runnerFailed: false }
  assert.equal(classifyAccessFailure({ sandbox, error: '审批被拒绝：用户没有允许这次执行' }), 'approval-denied')
  assert.equal(classifyAccessFailure({ sandbox, error: 'Host shell 服务不可用' }), 'infrastructure')
  assert.equal(processStartedOf({ sandbox, error: '审批被拒绝：用户没有允许这次执行' }), false)
  assert.equal(processStartedOf({ sandbox, error: '' }), true)
})

// ── ⑤ macOS 凭据存储 ───────────────────────────────────────────────────────

test('D-01 · 实际 DFA + 未被拒 + 钥匙串交互被拒 → os-credential-store', () => {
  for (const text of [SAMPLES.keychainInteraction, SAMPLES.keychainStatus]) {
    assert.equal(classifyAccessFailure({
      platform: 'darwin-arm64',
      sandbox: fullAccess,
      exitCode: 1,
      text,
    }), 'os-credential-store', text)
    // 有正向探测时也一样。
    assert.equal(classifyAccessFailure({
      platform: 'darwin-arm64',
      sandbox: fullAccess,
      exitCode: 1,
      probes: { credentialStoreDenied: true },
    }), 'os-credential-store')
  }
})

test('D-04 · 「条目不存在」是**没登录**，不是"被拒"：两者不许混', () => {
  // 探测明确说条目不存在，即使文本里有钥匙串字样，也不判成"被拒"：
  // 命令跑完了、如实回报「没登录」→ 那是 `cli` 的正常结果（`os-credential-store` 才是 OS 问题）。
  assert.equal(classifyAccessFailure({
    platform: 'darwin-arm64',
    sandbox: fullAccess,
    exitCode: 1,
    text: SAMPLES.keyring,
    probes: { credentialStoreDenied: true, credentialStoreMissing: true },
  }), 'cli');
  // 「没登录」也不许被说成沙箱拒绝或降级。
  assert.equal(classifyAccessFailure({
    platform: 'darwin-arm64',
    sandbox: fullAccess,
    exitCode: 1,
    text: SAMPLES.keyring,
  }), 'cli');
  // 反向：文本是"交互被拒"，绝不判成"没登录"。
  assert.equal(credentialStoreMissingIn(SAMPLES.keychainInteraction), false)
  assert.equal(credentialStoreDeniedIn(SAMPLES.keychainInteraction), true)
})

// ── ⑥ DWS 锁 ───────────────────────────────────────────────────────────────

test('D-01 · 锁文本 + 正向锁探测 → file-lock；只凭锁文本**不**定性', () => {
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: fullAccess,
    exitCode: 1,
    text: SAMPLES.dwsLock,
    probes: { lockHeld: true },
  }), 'file-lock')
  // 只有文本、没有探测：不能定性（"看着像锁"是三种原因里最不可靠的一种）。
  assert.notEqual(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: fullAccess,
    exitCode: 1,
    text: SAMPLES.dwsLock,
  }), 'file-lock')
  assert.equal(lockRelatedIn(SAMPLES.dwsLock), true)
})

// ── ⑦⑧ 平台原生权限 vs 业务失败 ────────────────────────────────────────────

test('D-01 · 实际 DFA + 未被拒 + 平台原生访问检查为真 → os-filesystem-permission', () => {
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: fullAccess,
    exitCode: 1,
    text: SAMPLES.plainDenied,
    probes: { filesystemAccessDenied: true },
  }), 'os-filesystem-permission')
  // 文本兜底（没有探测、也没有结构化事实）：仍然认得出，但必须排掉 runner 与沙箱标记。
  assert.equal(classifyAccessFailure({
    platform: 'win32-x64',
    text: SAMPLES.plainDenied,
    exitCode: 1,
  }), 'os-filesystem-permission')
})

test('D-02 · 实际 DFA 且 denied=false 时，**绝不**被描述成沙箱拒绝', () => {
  for (const text of [SAMPLES.plainDenied, SAMPLES.dwsLock, SAMPLES.keyring, '']) {
    const verdict = classifyAccessFailure({
      platform: 'win32-x64',
      sandbox: fullAccess,
      exitCode: 1,
      text,
    })
    assert.notEqual(verdict, 'sandbox-denied', text)
    assert.notEqual(verdict, 'sandbox-downgraded', text)
  }
})

test('D-02 · 结构化事实在手时，文本**不许翻案**：denied=true 就是沙箱拒绝', () => {
  // 文本说的是"权限不足 / 锁"，但事实是沙箱拒绝了 —— 以事实为准。
  const verdict = classifyAccessFailure({
    platform: 'win32-x64',
    sandbox: { requested: '', resolved: 'workspace-write', ran: 'workspace-write', denied: true, runnerFailed: false },
    exitCode: 1,
    text: `${SAMPLES.plainDenied} ${SAMPLES.dwsLock}`,
    probes: { filesystemAccessDenied: true, lockHeld: true },
  })
  assert.equal(verdict, 'sandbox-denied', '文本与事实冲突时以事实为准')
})

test('沙箱拒绝的原因下，平台原生探测也不许把它改写成 OS 权限问题', () => {
  // 实际跑在受限模式（不是 DFA）→ 平台级那几档的前置不成立。
  const verdict = classifyAccessFailure({
    platform: 'darwin-arm64',
    sandbox: { requested: '', resolved: 'workspace-write', ran: 'workspace-write', denied: false, runnerFailed: false },
    exitCode: 1,
    text: SAMPLES.keychainInteraction,
    probes: { credentialStoreDenied: true, filesystemAccessDenied: true },
  })
  assert.equal(verdict, 'cli', '受限模式下读不到钥匙串，不能定性成钥匙串 ACL 问题')
})

test('P2 · 锁文本单独出现时**不**定性为 file-lock（锁必须有正向探测）', () => {
  // `.data.lock: Access is denied` 同一句话有三种原因：真被进程持有 / 残留锁文件权限不对 /
  // 整个目录没权限。"看着像锁"是其中最不可靠的一种，所以没有正向探测就不定性。
  const textOnly = classifyAccessFailure({ text: '.data.lock: Access is denied', sandbox: undefined })
  assert.notEqual(textOnly, 'file-lock', '没有正向锁探测就不许说"锁被占用"')
  // 更不许退成"本机文件权限问题"——那会开出一个真会改权限的修复按钮。
  assert.notEqual(textOnly, 'os-filesystem-permission', '锁文本不该被读成文件权限问题')

  // 有正向探测时才可以定性（结构化前置：真的跑在完全访问下、没被沙箱拒）。
  const probed = classifyAccessFailure({
    text: '.data.lock: Access is denied',
    sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false },
    probes: { lockHeld: true },
  })
  assert.equal(probed, 'file-lock')

  // 探测给出"**没有**被持有"时同样不定性（那不是锁的问题）。
  const notHeld = classifyAccessFailure({
    text: '.data.lock: Access is denied',
    sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false },
    probes: { lockHeld: false },
  })
  assert.notEqual(notHeld, 'file-lock')
})

test('成功（进程跑完、退出码 0）→ 空串，不制造"失败原因"', () => {
  assert.equal(classifyAccessFailure({ platform: 'darwin-arm64', sandbox: fullAccess, exitCode: 0, text: 'ok' }), '')
})

test('actualFullAccessOf：ran 优先于 resolved，都没有时不算完全访问', () => {
  assert.equal(actualFullAccessOf({ requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'workspace-write' }), false)
  assert.equal(actualFullAccessOf({ resolved: 'danger-full-access' }), true)
  assert.equal(actualFullAccessOf({ ran: 'danger-full-access' }), true)
  assert.equal(actualFullAccessOf({}), false)
  assert.equal(actualFullAccessOf(undefined), false)
})


test('P2 · 锁的归因要**两个条件**：原始失败与锁有关 + 正向探测持锁（缺一不可）', () => {
  // 用户复查的 P2：只看 `lockHeld === true` 就能把任何一次 DWS 失败改写成 `file-lock` ——
  // 于是"凭据不存在 / 认证失败 + 机器上恰好有进程持锁"会让员工去关一个无关的程序。
  // 设计 §D 的原话是「锁文本 + 正向锁探测」，两个条件都必须成立。
  const base = {
    platform: 'darwin-arm64',
    sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false },
    exitCode: 1,
    text: 'dws drive +list failed',
  }
  // ① 原始失败与锁无关 + 有人持锁 → **不许**说成文件锁。
  assert.notEqual(
    classifyAccessFailure({ ...base, probes: { lockHeld: true, lockRelated: false } }),
    'file-lock',
    '无关失败 + 恰好有人持锁，不许归因文件锁',
  )
  // ② 原始失败与锁有关 + 有人持锁 → 文件锁（这就是 W-05 的现场）。
  assert.equal(
    classifyAccessFailure({ ...base, probes: { lockHeld: true, lockRelated: true } }),
    'file-lock',
  )
  // ③ 原始失败与锁有关，但**当前没人持锁**（残留锁文件）→ 也不许说成文件锁。
  assert.notEqual(
    classifyAccessFailure({ ...base, probes: { lockHeld: false, lockRelated: true } }),
    'file-lock',
  )
  // ④ 调用方没给这个事实时，退回**手上这段文本**判（Broker 直接分类那条路：text 就是原始失败）。
  assert.equal(
    classifyAccessFailure({
      ...base,
      text: 'opening lock file: Access is denied',
      probes: { lockHeld: true },
    }),
    'file-lock',
    '没给 lockRelated 时应按手上的失败文本判',
  )
})
