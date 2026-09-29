import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 构建脚本的**跨平台启动**（`scripts/prepare.mjs` + `scripts/lib/cli-entry.mjs`）。
 *
 * 真实故障（2026-09-28，Windows）：`spawnSync('tsdown', { shell: process.platform === 'win32' })`
 * 只能靠 shell 找到 `tsdown.cmd`，而**一旦过 shell，项目路径里的空格与单引号就会被第二套
 * 解析规则改写**，退出码与 stderr 也可能被 shell 吃掉。macOS/Linux 上永远看不到这一类失败。
 *
 * 这一份钉三件事：① 命令位置是「当前 node + tsdown 的 JS 入口」；② 绝不带 `shell`；
 * ③ 在**带空格与单引号的路径**下真的能构建出 `lib/`。
 */
const ROOT = new URL('../../', import.meta.url)
const PLUGIN_DIR = fileURLToPath(ROOT)
const { resolvePackageCli, nodeCommand } = await import(new URL('scripts/lib/cli-entry.mjs', ROOT).href)
const { build, buildPlan, missingSources, run } = await import(new URL('scripts/prepare.mjs', ROOT).href)

test('resolvePackageCli 解析到真实的 JS 入口，而不是 Windows 的 .cmd/.ps1 shim', () => {
  let entry = ''
  try {
    entry = resolvePackageCli('tsdown', { from: PLUGIN_DIR, binName: 'tsdown' })
  } catch (error) {
    // 干净 checkout 且没装依赖时跳过：这条断言的价值在「装了依赖的机器上不许解析成 shim」。
    assert.match(String(error), /找不到 tsdown/)
    return
  }
  assert.equal(/\.(mjs|cjs|js)$/.test(entry), true, `必须是 JS 入口，实际 ${entry}`)
  assert.equal(/\.(cmd|ps1|bat)$/i.test(entry), false, '不得把 Windows shim 当入口')
  assert.equal(existsSync(entry), true)
})

test('resolvePackageCli 解析不到时明确报错，不退回「让 shell 去跑」', () => {
  assert.throws(() => resolvePackageCli('crwu-这个包不存在', { from: PLUGIN_DIR }), /找不到/)
})

test('buildPlan 的命令位置是当前 node + JS 入口，且不带 shell', () => {
  const plan = buildPlan(PLUGIN_DIR)
  assert.equal(plan.command, process.execPath, '必须用当前这个 node 执行，避免再找一次可执行文件')
  assert.equal(plan.args.length, 1)
  assert.equal(/\.(mjs|cjs|js)$/.test(plan.args[0]), true)
  assert.equal(plan.cwd, PLUGIN_DIR)
  assert.equal('shell' in plan, false, 'plan 里不许出现 shell 选项')
})

test('build 调 spawn 时不传 shell（否则路径里的空格会被第二套规则改写）', () => {
  const calls = []
  const status = build({
    root: PLUGIN_DIR,
    log: () => {},
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, error: undefined }
    },
  })
  assert.equal(status, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].options.shell, undefined, '绝不允许 shell: true / shell: <shell 名>')
  assert.equal(calls[0].options.cwd, PLUGIN_DIR)
  assert.deepEqual(calls[0].options.stdio, ['inherit', 2, 'inherit'], '子进程 stdout 必须转去 stderr')
})

test('build 如实带回失败：spawn 报错与退出码非 0 都是失败', () => {
  const logs = []
  assert.equal(build({ root: PLUGIN_DIR, log: (m) => logs.push(m), spawn: () => ({ error: new Error('spawn 起不来'), status: null }) }), 1)
  assert.match(logs.join('\n'), /spawn 起不来/)
  assert.equal(build({ root: PLUGIN_DIR, log: () => {}, spawn: () => ({ status: 3 }) }), 3, '退出码必须原样带出')
})

test('缺少源码时不构建：没有 --force 跳过，带 --force 失败', () => {
  const logs = []
  const missing = missingSources('/nonexistent-project-dir')
  assert.equal(missing.length > 0, true)
  assert.equal(run({ root: '/nonexistent-project-dir', log: (m) => logs.push(m), spawn: () => ({ status: 0 }) }), 0)
  assert.match(logs.join('\n'), /跳过构建/)
  assert.equal(run({ root: '/nonexistent-project-dir', force: true, log: (m) => logs.push(m), spawn: () => ({ status: 0 }) }), 1)
})

test('带空格与单引号的路径下真的能构建（回归：这条路径过去只能靠 shell）', async (t) => {
  const { mkdtemp, mkdir, cp, symlink, rm, stat } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  if (!existsSync(join(PLUGIN_DIR, 'node_modules', 'tsdown'))) {
    t.skip('没装开发依赖（node_modules/tsdown 不存在）：跳过真实构建')
    return
  }

  // 目录名故意带 **空格 + 单引号**：走 shell 的写法必定把这里拆坏，不走 shell 就没事。
  const parent = await mkdtemp(join(tmpdir(), 'crwu prepare-'))
  const workdir = join(parent, "Case's Work")
  try {
    await mkdir(workdir, { recursive: true })
    for (const item of ['src', 'tsconfig.json', 'tsdown.config.ts', 'package.json']) {
      await cp(join(PLUGIN_DIR, item), join(workdir, item), { recursive: true })
    }
    // 依赖用软链接：Node 的解析会跟随它，不必再装一遍（`preserveSymlinks` 默认为 false）。
    await symlink(join(PLUGIN_DIR, 'node_modules'), join(workdir, 'node_modules'), 'dir')

    // 这次构建的 `node_modules` 是**软链到包根**的（见上面的注释），
    // 而 `host-package.test.mjs` 里的 `npm pack` 会重写包根的 `lib/` —— 两者并行会互相踩，
    // 所以走同一把构建锁（见 `tests/helpers/build-lock.mjs`）。
    const { withBuildLock } = await import(new URL('tests/helpers/build-lock.mjs', ROOT).href)
    const status = await withBuildLock(async () => build({ root: workdir, log: () => {} }))
    assert.equal(status, 0, '带空格与单引号的路径下构建必须成功')
    await stat(join(workdir, 'lib', 'index.js'))
    await stat(join(workdir, 'lib', 'client.js'))
  } finally {
    if (parent.startsWith(tmpdir())) await rm(parent, { recursive: true, force: true })
  }
})
