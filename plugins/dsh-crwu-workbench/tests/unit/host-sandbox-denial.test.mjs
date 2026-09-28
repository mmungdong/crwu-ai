import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 沙箱拒绝的归因（`host/shell/run.ts` 的 `sandboxDenialNote`）。
 *
 * 样本**逐字抄自员工 2026-09-28 在 Windows 上贴回来的三段报错** —— 它们看起来是三个不同的问题
 * （没登录 / 登录失败 / 写不进去），实际是同一个原因：受限沙箱（`workspace-write`）不允许碰
 * 工作区之外的路径（`%USERPROFILE%\.dws\`、操作系统凭据存储、`~/.ossutilconfig`）。
 * 归因错了，处置就会错到完全无关的方向（去重新扫码、去重装 dws、去换一份 AK）。
 */
const ROOT = new URL('../../', import.meta.url)
const { sandboxDenialNote, describeSandboxFacts } = await import(new URL('src/host/shell/run.ts', ROOT).href)

test('认得出 DSH 自己的拒绝标记，并带出模式名', () => {
  // 员工原文（写 ~/.ossutilconfig）。
  const real = 'cannot write "C:\\Users\\51019\\.ossutilconfig": file access denied under workspace-write mode'
  const note = sandboxDenialNote({ stderr: real })
  assert.match(note, /DSH 沙箱/)
  assert.match(note, /workspace-write/, '要把模式名带出来，否则没法判断该改哪个设置')
  assert.match(note, /工作区之外/)
})

test('认得出 dws 写 ~/.dws 被拦（疑似档，措辞不把猜测说成结论）', () => {
  // 员工原文（钉钉登录）。
  const real = 'dingtalk login failed: 本地登录态无法安全更新: acquiring file lock: '
    + 'opening lock file: open C:\\Users\\51019\\.dws\\.data.lock: Access is denied.'
  const note = sandboxDenialNote({ stderr: real })
  assert.match(note, /疑似被沙箱拦下/)
  // 也可能是真的 NTFS ACL / 文件被占用 —— 必须把这条一起说出来。
  assert.match(note, /占用|NTFS/)
  // 并给出可执行的动作。
  assert.match(note, /授权/)
})

test('认得出凭据存储被拦（keyring 假结论）', () => {
  const real = 'read H3Yun session from operating system credential store: secret not found in keyring'
  // 这条只有「凭据存储」线索、没有 Access is denied，所以不该硬说成沙箱拒绝。
  assert.equal(sandboxDenialNote({ stderr: real }), '')

  // 但带上拒绝字样时（沙箱下常见组合）要认出来。
  const withDenial = 'read from credential store: Access is denied (keyring backend unavailable)'
  assert.match(sandboxDenialNote({ stderr: withDenial }), /疑似被沙箱拦下/)
})

test('业务失败、无关的 Access is denied 都不冒充沙箱拒绝', () => {
  assert.equal(sandboxDenialNote({ stderr: 'AccessKey 无效或已过期（HTTP 401）' }), '')
  assert.equal(sandboxDenialNote({ stderr: 'Error: NoSuchBucket' }), '')
  // 只有 Access is denied、但没有任何「工作区外」线索 → 不猜（可能是它自己目录的 ACL）。
  assert.equal(sandboxDenialNote({ stderr: 'open ./out/x.lock: Access is denied.' }), '')
  assert.equal(sandboxDenialNote({}), '')
  assert.equal(sandboxDenialNote({ error: '执行失败：no sandbox backend' }), '')
})

test('stdout / error 通道里的拒绝同样认得出（不只是 stderr）', () => {
  const marker = 'file access denied under read-only mode'
  assert.match(sandboxDenialNote({ stdout: marker }), /read-only/)
  assert.match(sandboxDenialNote({ error: marker }), /DSH 沙箱/)
})

// ── 结构化事实优先（DSH 会回 `ShellRunResult.sandbox`，比文本判据可靠）────────────

test('沙箱自己说「拒了」时以它为准，并带出实际模式', () => {
  // 这条才是判定 dws 那条报错的关键：`denied: true` 就是沙箱拒了，
  // `denied: false` 且实际跑在 danger-full-access 就说明是文件本身的问题（占用 / ACL）。
  const note = sandboxDenialNote({ stderr: 'whatever', sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'workspace-write', denied: true } })
  assert.match(note, /DSH 沙箱拒绝了这次操作/)
  assert.match(note, /workspace-write/, '要把实际模式带出来')
})

test('提权请求被降级：请求 A、解析回来是 B —— 这是「授权了却仍被拦」的确定证据', () => {
  const note = sandboxDenialNote({ sandbox: { requested: 'danger-full-access', resolved: 'workspace-write', ran: 'workspace-write', denied: false } })
  assert.match(note, /提权请求被降级/)
  assert.match(note, /danger-full-access/)
  assert.match(note, /workspace-write/)
})

test('runner 起不来时如实说，不冒充业务失败', () => {
  assert.match(sandboxDenialNote({ sandbox: { runnerFailed: true } }), /runner/)
})

test('沙箱说没拒、也没降级时**不许**硬扣沙箱的帽子（留给文件占用/ACL 那条路）', () => {
  // 请求=解析=实际=danger-full-access、denied=false → 沙箱不是原因。
  const clean = { sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access', denied: false, runnerFailed: false } }
  assert.equal(sandboxDenialNote({ stderr: 'dingtalk login failed: acquiring file lock: open C:\\Users\\x\\.dws\\.data.lock: Access is denied.', ...clean }), '')
})

test('describeSandboxFacts 压成一行供诊断（无凭据、可读）', () => {
  assert.equal(describeSandboxFacts({ sandbox: { requested: 'danger-full-access', resolved: 'workspace-write', ran: 'workspace-write', denied: true } }),
    '请求 danger-full-access · 解析为 workspace-write · 实际 workspace-write · 沙箱拒绝=是')
  assert.equal(describeSandboxFacts({}), '')
  // 请求与解析一致时不重复说一遍。
  assert.equal(describeSandboxFacts({ sandbox: { requested: 'danger-full-access', resolved: 'danger-full-access', ran: 'danger-full-access' } }),
    '请求 danger-full-access · 实际 danger-full-access')
})
