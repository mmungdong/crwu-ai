/**
 * 审核脚本的随包依赖位置（`<案例>/scripts/runtime.json`）。
 *
 * 2026-10-22 现场：`prepare_materials.py` 由模型用 `pwsh` 直接执行（日志 step 12–13），
 * 不经过 `crwu_run_python_script`，于是 DSH 自带 Python 没有 `pypdf`、28 个 PDF 全被记成
 * `pypdf-error`，整批材料被推给视觉判读。这条用例钉住"认领/建档时就写好依赖位置"，
 * 并保证写不出来时**不让认领失败**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  auditRuntimePath, ensureAuditRuntimeFile, writeAuditRuntimeQuietly,
} = await import(new URL('src/host/tools/common/audit-runtime.ts', ROOT).href)
const { auditVendorRoot } = await import(new URL('src/host/domains/report-audit/audit-scripts.ts', ROOT).href)

const CASE = '/work/中瑞世联工作空间/la-1-abc'

/** 内存 fs：`resolve` 只做字符串拼接，`writeText` 落 Map，`readText` 供写后回读。 */
function makeCtx() {
  const files = new Map()
  const dirs = new Set()
  const warnings = []
  const target = (path) => ({ targetKey: path, displayPath: path })
  const fs = {
    async resolve(path, opts) {
      const base = opts?.cwd ?? ''
      const absolute = path.startsWith('/')
      return target(absolute ? path : `${base}/${path}`)
    },
    async stat(t) {
      const key = String(t.targetKey).replace(/\/+$/, '')
      if (dirs.has(key)) return { type: 'directory', version: 'v' }
      if (files.has(t.targetKey)) return { type: 'file', size: '1', version: 'v' }
      return undefined
    },
    async readText(t) { return files.get(t.targetKey) ?? '' },
    async writeText(t, content) { files.set(t.targetKey, content); return { operation: 'create', version: 'v' } },
    contains() { return true },
  }
  return {
    files,
    dirs,
    warnings,
    ctx: {
      get: (name) => (name === 'fs' ? fs : undefined),
      logger: { warn: (...args) => warnings.push(args) },
    },
  }
}

/** Broker 替身：mkdir 恒成功；路径探测恒回 `directory`。 */
function makeAccess() {
  const commands = []
  return {
    commands,
    async runShell(spec, command) {
      commands.push(String(command))
      return {
        ok: true, exitCode: 0, stdout: 'directory\n', stderr: '', error: '',
        sandbox: { requested: 'workspace-write', resolved: 'workspace-write', ran: 'workspace-write', denied: false, runnerFailed: false },
        facts: { operation: spec.operation, source: spec.source },
      }
    },
  }
}

test('写入的 runtime.json 指向安装包里的随包依赖目录', async () => {
  const { ctx, files } = makeCtx()
  const access = makeAccess()
  const result = await ensureAuditRuntimeFile({
    ctx, access, casePath: CASE, platform: 'darwin-arm64',
  })

  assert.equal(result.ok, true, result.error)
  const path = auditRuntimePath(CASE)
  assert.equal(path, `${CASE}/scripts/runtime.json`)
  const config = JSON.parse(files.get(path))
  assert.deepEqual(Object.keys(config).sort(), ['pythonVendor', 'pythonVendorNote', 'schemaVersion'])
  assert.equal(config.pythonVendor, auditVendorRoot())
  assert.equal(access.commands.some((item) => item.includes('scripts')), true, '必须真的发过建目录命令')
})

test('缺少执行依赖时如实跳过，不抛异常', async () => {
  const { ctx } = makeCtx()
  const result = await ensureAuditRuntimeFile({ ctx, casePath: CASE, platform: 'darwin-arm64' })
  assert.equal(result.ok, false)
  assert.match(result.error, /跳过 runtime\.json/)
})

test('尽力而为版本：依赖缺失时静默返回，不影响认领', async () => {
  const result = await writeAuditRuntimeQuietly({ casePath: CASE })
  assert.equal(result.ok, false)
  assert.equal(result.error.includes('跳过 runtime.json'), true)
})

test('尽力而为版本：写失败只记诊断，不向上抛', async () => {
  const { ctx, warnings } = makeCtx()
  const access = {
    async runShell() { throw new Error('broker 挂了') },
  }
  const result = await writeAuditRuntimeQuietly({
    ctx, access, world: { async platform() { return 'darwin-arm64' } }, casePath: CASE,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /broker 挂了/)
  assert.equal(warnings.length, 1, '失败要留诊断，但不影响调用方')
})
