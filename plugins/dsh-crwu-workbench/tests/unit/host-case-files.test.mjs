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
function makeCtx({ dirs = [], files = [], shellResult = { exitCode: 0, stderr: '' }, effects = true, statError = '' } = {}) {
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
            // **契约**：不存在返回 `undefined`，真故障（权限/解析/基础设施）抛异常。
            // 替身必须能区分这两件事，否则「异常被当成不存在」这类缺陷测不出来。
            if (statError !== '') throw new Error(statError)
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

// ── fs.stat 的三态：不存在 / 存在 / **查不出来** ──────────────────────────────
//
// 2026-09-28 复查发现的 P2：原来把 `resolve/stat` 的所有异常都当成「文件不存在」，
// 于是 `Access denied` 会被回报成「删除成功」；删除后的回读同样把异常折叠成「不存在」，
// 后置条件因此形同虚设。

test('readdir 之前 stat 抛异常 → 按基础设施失败上报，不回报成功', async () => {
  const denied = makeCtx({ files: ['/cases/space/S1/a.json'], statError: 'Access denied' })
  const result = await removeFileIfExists(denied, '/cases/space/S1/a.json', WORK)
  assert.equal(result.ok, false, '权限错误不得被当成「没有这个文件」')
  assert.match(result.error, /无法确认目标状态/)
  assert.match(result.error, /Access denied/)
  assert.deepEqual(denied.commands, [], '状态都没确认，不该发删除命令')
})

test('删除后回读抛异常 → 不能报成功（后置条件无从判定）', async () => {
  let calls = 0
  const ctx = makeCtx({
    files: ['/cases/space/S1/b.json'],
    shellResult: { exitCode: 0 },
    effects: false,
  })
  // 第一次 stat（删之前）正常，之后抛错：模拟「删完了但回读失败」。
  const patched = {
    ...ctx,
    get(name) {
      const fs = ctx.get(name)
      if (name !== 'fs') return fs
      return {
        ...fs,
        async resolve(path) { return { targetKey: path, displayPath: path } },
        async stat(target) {
          calls += 1
          if (calls > 1) throw new Error('EIO: disk error')
          return { type: 'file' }
        },
      }
    },
  }
  const result = await removeFileIfExists(patched, '/cases/space/S1/b.json', WORK)
  assert.equal(result.ok, false, '回读失败时无法证明删除生效，不得报成功')
  assert.match(result.error, /无法确认目标是否已删除/)
})

test('建目录后回读抛异常 → 不能报成功', async () => {
  const ctx = makeCtx({ shellResult: { exitCode: 0 }, statError: 'EACCES' })
  const result = await ensureDirectory(ctx, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /无法确认目录是否已创建/)
})

test('建目录成功但同名目标是文件 → 如实报「不是目录」', async () => {
  // `effects: false`：这里的 shell 替身不模拟文件系统变化，用一个「同名文件已存在」的
  // 假机器来验后置条件的分支。
  const ctx = makeCtx({ files: ['/cases/space/S1'], effects: false })
  const result = await ensureDirectory(ctx, '/cases/space/S1', WORK)
  assert.equal(result.ok, false)
  assert.match(result.error, /不是目录/)
})
