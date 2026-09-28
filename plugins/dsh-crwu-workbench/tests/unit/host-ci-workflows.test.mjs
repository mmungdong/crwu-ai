import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * CI / 发布工作流的结构门禁。
 *
 * ## 为什么需要它（2026-09-28 复查发现的 P1）
 *
 * release 的 `windows-binary-smoke` 里有一条**预期失败**的断言：
 * 「未声明的平台必须报错」。当时的写法是
 *
 * ```powershell
 * node scripts/smoke-windows-binaries.mjs --platform=win32-arm64
 * if ($LASTEXITCODE -eq 0) { throw "…" }
 * Write-Host "OK …"
 * ```
 *
 * 看起来没问题，实际会**稳定失败**：GitHub 的 pwsh 壳在脚本末尾用 `$LASTEXITCODE` 作为步骤
 * 退出码，而 `Write-Host` 不会把它重置成 0 —— 于是「故意跑失败」的那一步真的把 job 判红，
 * 依赖它的 `publish` 永远起不来。
 *
 * 规则很短，所以直接机器化：**任何引用 `$LASTEXITCODE` 的 `run:` 块都必须在末尾显式 `exit`。**
 * 这样「保存退出码 → 断言 → `exit 0`」就成了可检查的形状，而不是靠人记得。
 */
// 工作流在**仓根**：本文件在 plugins/<插件>/tests/unit/ 下，所以上溯四层。
const REPO_ROOT = new URL('../../../../', import.meta.url)
const { parse: parseYaml } = await import('yaml')

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml']

function readWorkflow(relative) {
  return parseYaml(readFileSync(fileURLToPath(new URL(relative, REPO_ROOT)), 'utf8'))
}

/** 摊平出「workflow / job / step / run 文本」。 */
function stepsOf(name, doc) {
  const out = []
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    for (const [index, step] of (job.steps ?? []).entries()) {
      const run = typeof step.run === 'string' ? step.run : ''
      if (run === '') continue
      out.push({ workflow: name, job: jobName, index, label: step.name ?? `step#${String(index)}`, run })
    }
  }
  return out
}

test('任何引用 $LASTEXITCODE 的 run 块都必须显式 exit（否则「预期失败」会判红整个 job）', () => {
  const offenders = []
  for (const name of WORKFLOWS) {
    const doc = readWorkflow(name)
    for (const step of stepsOf(name, doc)) {
      if (!step.run.includes('$LASTEXITCODE')) continue
      const lines = step.run.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      const last = lines[lines.length - 1] ?? ''
      // PowerShell 里末尾那行必须是显式退出：`exit 0`（断言通过）/ `exit $code`。
      if (!/^exit\b/.test(last)) {
        offenders.push(`${step.workflow} → ${step.job} → 「${step.label}」末尾是「${last}」`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    'GitHub 的 pwsh 壳在脚本末尾用 `$LASTEXITCODE` 当步骤退出码，`Write-Host` 不会清它：\n'
    + `${offenders.join('\n')}\n`
    + '写法：先把退出码存进变量 → 断言 → 末尾显式 `exit 0`。')
})

test('原生 PowerShell job 不得设 job 级 shell，并要先证明 runner 真的是 pwsh', () => {
  const doc = readWorkflow('.github/workflows/ci.yml')
  const job = doc.jobs['windows-powershell']
  assert.ok(job, 'ci.yml 必须有一个 windows-powershell job')
  assert.equal(job['runs-on'], 'windows-latest')
  // 设成 bash 就退化成 Git for Windows Bash —— 那正是这个 job 要消灭的盲区。
  assert.equal(job.defaults?.run?.shell, undefined, 'windows-powershell 不得设 job 级 shell')
  const runs = (job.steps ?? []).map((step) => String(step.run ?? ''))
  assert.equal(runs.some((run) => run.includes('$PSVersionTable')), true, '要先断言 runner 是 PowerShell 7')
  assert.equal(runs.some((run) => run.includes('tests/windows/powershell-contract.test.mjs')), true,
    '必须真的跑原生执行合同')
})

test('发布必须被 Windows 二进制冒烟阻断', () => {
  const doc = readWorkflow('.github/workflows/release.yml')
  const needs = doc.jobs.publish?.needs
  const list = Array.isArray(needs) ? needs : [needs]
  assert.equal(list.includes('binaries'), true)
  assert.equal(list.includes('windows-binary-smoke'), true,
    'Windows 冒烟不过就不许发布（needs 里必须有它）')
  const smoke = doc.jobs['windows-binary-smoke']
  assert.ok(smoke, 'release.yml 必须有 windows-binary-smoke job')
  assert.equal(smoke['runs-on'], 'windows-latest')
  const runs = (smoke.steps ?? []).map((step) => String(step.run ?? ''))
  assert.equal(runs.some((run) => run.includes('--platform=win32-x64')), true, '要真的启动 win32-x64 产物')
  assert.equal(runs.some((run) => run.includes('--platform=win32-arm64')), true, '要显式验 win32-arm64 被拒')
})
