/**
 * 登录失败归因的单元测试（2026-09-29）。
 *
 * 样本**逐字抄自实测**：
 * - Windows：`mkdir …\Temp\crwu-scan-…: Access is denied.` 与
 *   `…\.dws\.data.lock: Access is denied.`；
 * - macOS：受限沙箱下浏览器 renderer 崩溃时 CLI 的原话
 *   `enable network inspection: websocket: close 1006 (abnormal closure): unexpected EOF`。
 *
 * 这个文件同时守住**两个方向**：
 * 1. 该归因的形态必须归因（否则员工看到的还是 `mkdir … Access is denied` 这种原文）；
 * 2. 不该归因的形态不许归因（否则一次真实的业务失败会被说成"去切完全权限"，
 *    员工按它处理永远修不掉）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { loginFailureAdvice, describeLoginAdvice } = await import(
  new URL('src/host/system/login-failure.ts', ROOT).href
)

/** 干净的结构化事实：宿主按完全访问跑、没拒绝 —— 单看事实看不出问题。 */
const CLEAN = { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false }

// ── 该归因：Windows 实测的两段原文 ──────────────────────────────────────────

test('氚云：临时浏览器 profile 被拒 → 归因到工作区之外的写', () => {
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1,
    stderr: 'mkdir C:\\Users\\51019\\AppData\\Local\\Temp\\crwu-scan-1799287186: Access is denied.',
    sandbox: CLEAN,
  })
  assert.equal(advice.blocked, true)
  // 事实干净（宿主按完全访问跑）→ 这是**这台机器**在拒，不是文件策略。
  assert.equal(advice.policyBlocked, false)
  assert.match(advice.reason, /临时浏览器配置目录/)
  // 实测（2026-09-29）：这一支**不是**叫人去切 DSH 访问模式，而是提权或让 IT 放行；原话必须留着。
  assert.doesNotMatch(advice.action, /选「完全权限」/)
  assert.match(advice.action, /以管理员身份运行/)
  assert.match(advice.action, /session bind/)
})

test('钉钉：.dws/.data.lock 被拒 → 归因，且动作里点明设备码同样走不通', () => {
  const advice = loginFailureAdvice('dws', {
    exitCode: 2,
    stderr: '{"error":{"category":"auth","code":2,"message":"device authorization failed: 本地登录态无法安全更新: acquiring file lock: opening lock file: open C:\\\\Users\\\\51019\\\\.dws\\\\.data.lock: Access is denied."}}',
    sandbox: CLEAN,
  })
  assert.equal(advice.blocked, true)
  assert.equal(advice.policyBlocked, false)
  assert.match(advice.reason, /锁文件/)
  // 设备码那条要抢同一个锁：动作里必须点明它不是绕过办法。
  assert.match(advice.action, /设备码登录/)
  assert.match(advice.action, /不是绕过办法/)
  // 换目录已被实测排除（主目录根 / 插件目录都试过），动作里必须说清，别再让人白试。
  assert.match(advice.action, /换目录也没用/)
  assert.match(advice.action, /以管理员身份运行/)
  // 实测补充：**不是一次性步骤** —— 非提权时即使登录态文件已存在也打不开（2026-09-29 员工复验）。
  assert.match(advice.action, /不是一次性步骤/)
  // 影响面必须说清：依赖 dws 的其它功能同样受影响，避免有人以为"只是登录的问题"。
  assert.match(advice.action, /知识库下载/)
})

test('员工实测原文（系统 TEMP + 缓存目录两条都被拒）→ 机器支，并给出 bind 退路', () => {
  // 2026-09-29 Windows 逐字原文。注意里面有 **两条** 失败路径：先系统 TEMP，再 fallback 缓存目录。
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1,
    stderr: 'create fallback browser profile directory: mkdir C:\\Users\\51019\\AppData\\Local\\crwu: Access is denied. '
      + '(system TEMP failed: mkdir C:\\Users\\51019\\AppData\\Local\\Temp\\crwu-scan-556823159: Access is denied.)',
    // 诊断事实：宿主确实按完全访问跑的（这正是"别叫人去切权限"的依据）。
    sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false },
  })
  assert.equal(advice.blocked, true)
  assert.equal(advice.policyBlocked, false)
  // 文案要点（2026-09-29 员工实测后修正）：说清事实（已是完全访问）＋ 给出**提权**与 IT 放行两条路，
  // 且**不许**再叫人去切 DSH 访问模式（那一支实测没用）。
  assert.match(advice.action, /danger-full-access/)
  assert.match(advice.action, /以管理员身份运行/)
  assert.doesNotMatch(advice.action, /选「完全权限」/)
})

test('同一段原文、但事实说"被降级"时，才走策略支（切权限才对）', () => {
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1,
    stderr: 'mkdir C:\\Users\\x\\AppData\\Local\\Temp\\crwu-scan-556823159: Access is denied.',
    sandbox: { requested: 'danger-full-access', resolved: 'workspace-write', ran: 'workspace-write', denied: false, runnerFailed: false },
  })
  assert.equal(advice.policyBlocked, true)
  assert.match(advice.action, /完全权限/)
})

test('钥匙串问题只在**带拒绝字样**时才算（"没找到条目"是另一类故障，不许混进来）', () => {
  // 只有凭据存储的词、没有拒绝字样 → 不归因：那可能是真的没有条目 / 钥匙串被锁，
  // 处置（重新扫码 / 解锁钥匙串）与"切完全权限"完全不同，猜错就把人指偏。
  const missing = loginFailureAdvice('dws', {
    exitCode: 1,
    stderr: 'dingtalk login failed: secret not found in keyring',
    sandbox: CLEAN,
  })
  assert.equal(missing.blocked, false)
  // 带拒绝字样（且点名凭据存储）就是这类：读/写被挡在工作区之外。
  const denied = loginFailureAdvice('dws', {
    exitCode: 1,
    stderr: 'permission denied while writing the credential store',
    sandbox: CLEAN,
  })
  assert.equal(denied.blocked, true)
})

// ── 该归因：结构化事实（不管原文写什么）────────────────────────────────────

test('提权被降级：请求完全访问、执行器按受限模式跑', () => {
  const advice = loginFailureAdvice('h3yun', {
    sandbox: { requested: 'danger-full-access', resolved: 'workspace-write', ran: 'workspace-write', denied: false },
  })
  assert.equal(advice.blocked, true)
  assert.equal(advice.policyBlocked, true)
  assert.match(advice.reason, /降级/)
  assert.match(advice.action, /完全权限/)
})

test('沙箱明确拒绝 / 实际跑在受限模式 / runner 起不来：三种都归因', () => {
  const denied = loginFailureAdvice('h3yun', { sandbox: { ...CLEAN, denied: true } })
  assert.equal(denied.blocked, true)
  assert.equal(denied.policyBlocked, true)
  assert.match(denied.reason, /拒绝了这次操作/)

  const confined = loginFailureAdvice('dws', { sandbox: { ...CLEAN, resolved: 'workspace-write', ran: 'workspace-write' } })
  assert.equal(confined.blocked, true)

  const runner = loginFailureAdvice('dws', { sandbox: { ...CLEAN, runnerFailed: true } })
  assert.equal(runner.blocked, true)
  assert.match(runner.reason, /runner/)
})

// ── 不该归因：真实业务失败与别的形态 ──────────────────────────────────────

test('没找到浏览器不是沙箱问题（不许把人指去切权限）', () => {
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1,
    stderr: 'no supported browser found; install Chrome/Edge or set CRWU_BROWSER',
    sandbox: CLEAN,
  })
  assert.equal(advice.blocked, false)
  assert.equal(advice.reason, '')
  assert.equal(advice.action, '')
})

test('macOS 受限沙箱下 CLI 只回 1006：事实干净、原文没有工作区外目标 → 不猜', () => {
  // 1006 本身既没有目标词也没有拒绝字样；宿主这边 requested/resolved/ran 都是完全访问。
  // 这种情况归因靠**结构化事实**，不靠猜 —— 所以这里是 false（防止用"看着像"乱归因）。
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1,
    stderr: 'enable network inspection: websocket: close 1006 (abnormal closure): unexpected EOF',
    sandbox: CLEAN,
  })
  assert.equal(advice.blocked, false)
})

test('目标词与拒绝字样必须同时命中（只命中一个不算）', () => {
  // 只有目标词：可能只是提示文字里提到了 .dws，不是拒绝。
  const onlyTarget = loginFailureAdvice('dws', {
    exitCode: 1, stderr: 'profile stored under .dws is ready', sandbox: CLEAN,
  })
  assert.equal(onlyTarget.blocked, false)
  // 只有拒绝字样、目标与登录无关（例如用户的 OSS 密钥文件）：不归因到登录的沙箱边界。
  const otherTarget = loginFailureAdvice('dws', {
    exitCode: 1, stderr: 'open C:\\Users\\x\\.ossutilconfig: Access is denied.', sandbox: CLEAN,
  })
  assert.equal(otherTarget.blocked, false)
})

test('成功不产生建议；超时本身不算沙箱问题（归因只看目标词 + 拒绝字样）', () => {
  assert.equal(loginFailureAdvice('h3yun', { sandbox: CLEAN }).blocked, false)
  // 超时 + 原文里确有"工作区外目标被拒"：那是真的被拒（否则命令不会打印这句话），照样归因。
  const deniedThenTimeout = loginFailureAdvice('h3yun', {
    timedOut: true, stderr: 'mkdir crwu-scan-x: Access is denied.', sandbox: CLEAN,
  })
  assert.equal(deniedThenTimeout.blocked, true)
  // 只是超时（浏览器开着等人扫）没有任何拒绝证据 → 不归因。
  const plainTimeout = loginFailureAdvice('h3yun', { timedOut: true, stdout: '正在打开浏览器窗口…', sandbox: CLEAN })
  assert.equal(plainTimeout.blocked, false)
})

// ── 文案装配 ───────────────────────────────────────────────────────────────

test('describeLoginAdvice：归因时给一句人话 + 下一步 + 原始报错；未归因时原样透传', () => {
  const advice = loginFailureAdvice('h3yun', {
    exitCode: 1, stderr: 'mkdir C:\\Temp\\crwu-scan-1: Access is denied.', sandbox: CLEAN,
  })
  const text = describeLoginAdvice('h3yun', advice, 'mkdir C:\\Temp\\crwu-scan-1: Access is denied.')
  // 文本形态（事实干净）→ "被这台机器拒绝"，绝不能出现"切完全权限"。
  assert.match(text, /被这台机器拒绝（不是 DSH 的文件策略）/)
  assert.equal(text.includes('选「完全权限」'), false)
  assert.match(text, /原始报错：mkdir/)

  const plain = { blocked: false, reason: '', action: '' }
  assert.equal(describeLoginAdvice('h3yun', plain, 'no supported browser found'), 'no supported browser found')
})
