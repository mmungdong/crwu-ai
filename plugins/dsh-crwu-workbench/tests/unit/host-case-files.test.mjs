import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 案例目录内的本地文件操作（`host/tools/case-files.ts`）。
 *
 * 这里是 2026-09-28 Windows 报错里最隐蔽的一段：旧实现用 `cmd /c mkdir` / `cmd /c del`，
 * 并且**把 Windows 上的任意 mkdir 失败都当成成功**（「目录已存在也会报错」的粗糙兜底）。
 * 后果不是立刻炸，而是「以为目录建好了，下一步写文件才失败」—— 错误归因到完全无关的地方。
 *
 * 所以这一份钉两条：方言（命令由中央适配器生成）与**失败/后置条件**（不许吞错、不许只看退出码）。
 */
const ROOT = new URL('../../', import.meta.url)
// 成功的建/删命令要真的作用到内存 fs 上：实现会回读后置条件（见 tests/helpers/shell-effects.mjs）。
const { applyShellEffect } = await import(new URL('tests/helpers/shell-effects.mjs', ROOT).href)
const { ensureDirectory, removeFileIfExists } = await import(new URL('src/host/tools/case-files.ts', ROOT).href)

/** 内存 fs + 记录 shell 请求的最小 ctx。 */
function makeCtx({ dirs = [], files = [], shellResult = { exitCode: 0, stderr: '' }, effects = true } = {}) {
  const directorySet = new Set(dirs)
  const fileSet = new Set(files)
  const commands = []
  return {
    commands,
    directorySet,
    fileSet,
    get(name) {
      if (name === 'shell') {
        return {
          resolve: (request) => ({ ...request, workdir: request.workdir ?? '/default', timeoutMs: 1, stdoutMaxBytes: 1024 }),
          async execute(spec) {
            commands.push(spec.command)
            const result = typeof shellResult === 'function' ? shellResult(spec) : shellResult
            // 只有「真的跑成功了」才模拟副作用；`effects: false` 用来构造
            // 「退出码 0 但文件系统没变」的骗子机器，专门验后置条件。
            if (effects) {
              applyShellEffect(spec.command, result.exitCode, {
                addDir: (path) => directorySet.add(path),
                removeFile: (path) => fileSet.delete(path),
              })
            }
            return {
              result: async () => ({
                exitCode: result.exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
                stdout: { text: result.stdout ?? '', truncated: false },
                stderr: { text: result.stderr ?? '', truncated: false },
              }),
            }
          },
        }
      }
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            if (directorySet.has(target.targetKey)) return { type: 'directory' }
            if (fileSet.has(target.targetKey)) return { type: 'file' }
            return undefined
          },
        }
      }
      return undefined
    },
  }
}

const WORK = { workdir: '/cases/space/S1', platform: 'darwin-arm64' }

// ── 建目录 ──────────────────────────────────────────────────────────────────

test('ensureDirectory 按平台生成命令（POSIX mkdir -p / PowerShell New-Item -Force）', async () => {
  const mac = makeCtx({ dirs: ['/cases/space/S1/输入快照'] })
  assert.deepEqual(await ensureDirectory(mac, '/cases/space/S1/输入快照', WORK), { ok: true, error: '' })
  assert.equal(mac.commands[0], "mkdir -p '/cases/space/S1/输入快照'")

  const win = makeCtx({ dirs: ['C:\\Case\'s Work\\S1\\输入快照'] })
  const path = "C:\\Case's Work\\S1\\输入快照"
  assert.deepEqual(await ensureDirectory(win, path, { ...WORK, platform: 'win32-x64' }), { ok: true, error: '' })
  assert.equal(win.commands[0], `New-Item -ItemType Directory -Force -Path 'C:\\Case''s Work\\S1\\输入快照' | Out-Null`)
})

test('ensureDirectory 只在「目标已经是目录」时把失败当成功', async () => {
  // 目录已存在（重审会再走一次）：命令报错也不算失败 —— 这就是幂等的判据。
  const exists = makeCtx({ dirs: ['/cases/space/S1'], shellResult: { exitCode: 1, stderr: 'File exists' } })
  assert.deepEqual(await ensureDirectory(exists, '/cases/space/S1', WORK), { ok: true, error: '' })

  // 目录不存在又报错：**必须**失败。旧实现在 Windows 上无条件返回成功，把故障推到下一步。
  const missingWin = makeCtx({ shellResult: { exitCode: 1, stderr: 'Access is denied' } })
  const failed = await ensureDirectory(missingWin, 'C:\\x\\S1', { ...WORK, platform: 'win32-x64' })
  assert.equal(failed.ok, false, 'Windows 上 mkdir 失败不得被当成成功')
  assert.match(failed.error, /Access is denied/)
})

test('ensureDirectory 回读后置条件：命令返回 0 但目录不存在也算失败', async () => {
  const liar = makeCtx({ shellResult: { exitCode: 0 }, effects: false })
  const result = await ensureDirectory(liar, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /创建目录命令返回成功，但目录不存在/)
})

test('ensureDirectory 没有 fs 服务时如实报失败，不假装成功', async () => {
  const ctx = makeCtx({ dirs: ['/cases/space/S1'] })
  ctx.get = (name) => (name === 'shell' ? makeCtx().get('shell') : undefined)
  const result = await ensureDirectory(ctx, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
})

// ── 删除 ────────────────────────────────────────────────────────────────────

test('removeFileIfExists 在文件本来就不在时不发命令（幂等）', async () => {
  const ctx = makeCtx()
  assert.deepEqual(await removeFileIfExists(ctx, '/cases/space/S1/审核结果.json', WORK), { ok: true, error: '' })
  assert.deepEqual(ctx.commands, [], '不存在就没有可删的东西，一条命令也不该发')
})

test('removeFileIfExists 拒绝目录，并按平台生成删除命令', async () => {
  const asDir = makeCtx({ dirs: ['/cases/space/S1/输入快照'] })
  const refused = await removeFileIfExists(asDir, '/cases/space/S1/输入快照', WORK)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /不是普通文件/)
  assert.deepEqual(asDir.commands, [])

  const mac = makeCtx({ files: ['/cases/space/S1/审核结果.S1.json'] })
  assert.deepEqual(await removeFileIfExists(mac, '/cases/space/S1/审核结果.S1.json', WORK), { ok: true, error: '' })
  // 含中文的路径不在 POSIX 安全白名单里 —— 必须引用（不加引号会被词法拆分 / 被 glob 解释）。
  assert.equal(mac.commands[0], "rm -f -- '/cases/space/S1/审核结果.S1.json'")

  const ascii = makeCtx({ files: ['/cases/space/S1/result.json'] })
  assert.deepEqual(await removeFileIfExists(ascii, '/cases/space/S1/result.json', WORK), { ok: true, error: '' })
  assert.equal(ascii.commands[0], 'rm -f -- /cases/space/S1/result.json')
})

test('removeFileIfExists 传播真实失败，并用后置条件抓住「命令成功但文件还在」', async () => {
  const denied = makeCtx({
    files: ['/cases/space/S1/a.json'],
    shellResult: (spec) => { spec; return { exitCode: 1, stderr: 'Permission denied' } },
  })
  const failed = await removeFileIfExists(denied, '/cases/space/S1/a.json', WORK)
  assert.equal(failed.ok, false, '权限 / 占用类失败必须传播')
  assert.match(failed.error, /Permission denied/)

  // 命令返回 0，但替身 fs 里文件还在 —— 说明删除没生效，不能报成功。
  const liar = makeCtx({ files: ['/cases/space/S1/b.json'], shellResult: { exitCode: 0 }, effects: false })
  const still = await removeFileIfExists(liar, '/cases/space/S1/b.json', WORK)
  assert.equal(still.ok, false)
  assert.match(still.error, /文件仍然存在/)
})

test('removeFileIfExists 在 Windows 上用 PowerShell 幂等删除且失败可传播', async () => {
  const ctx = makeCtx({ files: ["C:\\Case's Work\\S1\\old.json"] })
  const path = "C:\\Case's Work\\S1\\old.json"
  assert.deepEqual(await removeFileIfExists(ctx, path, { ...WORK, platform: 'win32-x64' }), { ok: true, error: '' })
  assert.equal(
    ctx.commands[0],
    "if (Test-Path -LiteralPath 'C:\\Case''s Work\\S1\\old.json') { Remove-Item -LiteralPath 'C:\\Case''s Work\\S1\\old.json' -Force -ErrorAction Stop }",
  )
  assert.equal(ctx.commands[0].includes('SilentlyContinue'), false)
})
