/**
 * 二进制供应链的门禁测试。
 *
 * 这一层以前只检查「文件在不在、非不非空」—— 那是**内容无关**的判据：解包错、拷贝错、
 * 甚至把上一次的残file 留在原地，它都会说"通过"。现在清单（`bin/manifest.json`）记录每个平台
 * 每个工具的**最终文件** size 与 sha256，`--check` 按清单重算；发布严格模式还会真打一份
 * tarball、解包后逐个核对。
 *
 * 这些测试全部用几 KB 的假文件与临时目录，**不装配、不下载、不碰真机**。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SCRIPT = join(ROOT, 'scripts', 'sync-binaries.mjs')

const {
  BIN_MANIFEST_NAME,
  BIN_MANIFEST_SCHEMA,
  BIN_PLATFORMS,
  BIN_TOOLS,
  binFileName,
  verifyBinDir,
} = await import(new URL('scripts/bin-manifest.mjs', `file://${ROOT}/`).href)

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/** 造一棵最小的 `bin/` 树 + 对应清单（内容与清单一致）。 */
async function makeStaging(patch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crwu-bin-'))
  const platforms = []
  for (const platform of BIN_PLATFORMS) {
    const tools = []
    for (const tool of BIN_TOOLS) {
      const file = binFileName(tool, platform)
      const path = join(dir, platform, file)
      await mkdir(dirname(path), { recursive: true })
      const content = `${tool}-${platform}`
      await writeFile(path, content)
      tools.push({
        tool,
        file,
        platform,
        source: 'test-fixture',
        sourceVersion: '0.0.0',
        target: platform,
        size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
      })
    }
    platforms.push({ platform, tools })
  }
  const manifest = { schemaVersion: BIN_MANIFEST_SCHEMA, generatedAt: new Date().toISOString(), platforms }
  await writeFile(join(dir, BIN_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
  if (patch.breakHash !== undefined) {
    const [platform, tool] = patch.breakHash
    await writeFile(join(dir, platform, binFileName(tool, platform)), 'tampered')
  }
  if (patch.removeManifest === true) await rm(join(dir, BIN_MANIFEST_NAME))
  if (patch.removeTool !== undefined) {
    const [platform, tool] = patch.removeTool
    await rm(join(dir, platform, binFileName(tool, platform)))
  }
  if (patch.stray !== undefined) {
    await mkdir(join(dir, patch.stray), { recursive: true })
    await writeFile(join(dir, patch.stray, 'dws.log'), 'x')
  }
  return { dir, manifest }
}

async function runCheck(dir) {
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, '--check'], { env: { ...process.env, CRWU_BIN_DIR: dir } })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('the assembled binary tree passes the manifest check', async () => {
  const { dir } = await makeStaging()
  try {
    const result = await runCheck(dir)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /sha256 全部一致/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the check detects a content change even when the file size is unchanged', async () => {
  // 这一条就是本次改造的核心：只比 size 的判据会放过"同长度但内容不同"的文件。
  const { dir } = await makeStaging()
  try {
    const target = join(dir, 'darwin-arm64', 'crwu')
    await writeFile(target, 'crwX-darwin-arm64')
    const result = await runCheck(dir)
    assert.equal(result.code, 1, '内容变了必须红')
    assert.match(result.output, /哈希与清单不符/)
    assert.equal(existsSync(target), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the check fails when the manifest, a platform or a tool is missing', async () => {
  const noManifest = await makeStaging({ removeManifest: true })
  try {
    const result = await runCheck(noManifest.dir)
    assert.equal(result.code, 1)
    assert.match(result.output, /缺少 .*manifest\.json/)
  } finally {
    await rm(noManifest.dir, { recursive: true, force: true })
  }

  const noTool = await makeStaging({ removeTool: ['win32-x64', 'ossutil'] })
  try {
    const result = await runCheck(noTool.dir)
    assert.equal(result.code, 1)
    assert.match(result.output, /ossutil\.exe/)
  } finally {
    await rm(noTool.dir, { recursive: true, force: true })
  }
})

test('the check rejects runtime residue under bin/', async () => {
  // 实测踩过：跑一次 `dws version` 会在旁边落 `.dws/`，`files` 里的 `bin/` 会把它整包带走。
  const { dir } = await makeStaging({ stray: '.dws' })
  try {
    const result = await runCheck(dir)
    assert.equal(result.code, 1)
    assert.match(result.output, /未在清单中声明的文件/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('verifyBinDir reports every missing platform/tool when the manifest is incomplete', async () => {
  const { dir } = await makeStaging()
  try {
    const trimmed = { schemaVersion: BIN_MANIFEST_SCHEMA, platforms: [{ platform: 'darwin-arm64', tools: [] }] }
    const problems = await verifyBinDir(dir, trimmed, { requireAll: true })
    for (const platform of BIN_PLATFORMS) {
      for (const tool of BIN_TOOLS) {
        assert.equal(
          problems.some((item) => item.includes(`${platform}/${binFileName(tool, platform)}`)),
          true,
          `必须报告缺少 ${platform}/${binFileName(tool, platform)}`,
        )
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the real package stages both platforms with a manifest that describes the final bytes', async () => {
  const binDir = join(ROOT, 'bin')
  if (!existsSync(join(binDir, BIN_MANIFEST_NAME))) {
    // 干净 checkout（CI / 同事机器）没有装配产物：显式 skip，而不是把「没装配」当通过。
    assert.equal(existsSync(join(binDir, 'darwin-arm64')), false, '没有 manifest 却装配了平台目录，属于不完整装配')
    return
  }
  const manifest = JSON.parse(await readFile(join(binDir, BIN_MANIFEST_NAME), 'utf8'))
  assert.equal(manifest.schemaVersion, BIN_MANIFEST_SCHEMA)
  for (const platform of BIN_PLATFORMS) {
    const entry = manifest.platforms.find((item) => item.platform === platform)
    assert.ok(entry, `manifest 缺少平台 ${platform}`)
    for (const tool of BIN_TOOLS) {
      const recorded = entry.tools.find((item) => item.tool === tool)
      assert.ok(recorded, `manifest 缺少 ${platform}/${tool}`)
      assert.equal(typeof recorded.source, 'string')
      assert.equal(recorded.sourceVersion.length > 0, true, `${platform}/${tool} 缺少来源版本`)
      assert.equal(recorded.size > 0, true, `${platform}/${tool} 的 size 必须为正`)
      const actual = await sha256(join(binDir, platform, recorded.file))
      assert.equal(recorded.sha256, actual, `${platform}/${tool} 的清单哈希必须等于最终文件哈希`)
      if (tool !== 'crwu') {
        assert.equal(typeof recorded.archiveSha256, 'string', `${platform}/${tool} 必须记下载归档的哈希`)
      } else {
        assert.equal(typeof recorded.buildCommit, 'string', 'crwu 必须记构建 commit')
        assert.match(String(recorded.target), /^(darwin|windows)\//, 'crwu 必须记构建 target')
      }
    }
  }
})

/** 直接跑发布严格模式的自检脚本（可把自带二进制目录指到临时目录）。 */
async function runStrictPackAssert(binDir) {
  try {
    const { stdout } = await run(process.execPath, [join(ROOT, 'scripts', 'assert-pack.mjs'), '--strict'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CRWU_BIN_DIR: binDir },
    })
    return { code: 0, output: stdout }
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('release strict mode fails when bin/ is absent entirely', async () => {
  // 正式发布不允许把「完全没有 bin」仅当警告：员工会装到一个没有 crwu/dws/ossutil 的插件。
  const empty = await mkdtemp(join(tmpdir(), 'crwu-nobin-'))
  try {
    const result = await runStrictPackAssert(empty)
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /发布严格模式要求自带二进制/)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('release strict mode is wired to the require-all judgement', async () => {
  // 严格模式的「缺任意平台/工具/manifest 都要失败」由共享判据 `requireAll` 承担
  // （上一组用例已逐个覆盖）。这里只钉**接线**：assert-pack 在 strict 下必须传 requireAll，
  // 且不允许把「完全没有 bin」降级成警告。改接线会让这条红。
  const source = await readFile(join(ROOT, 'scripts', 'assert-pack.mjs'), 'utf8')
  assert.match(source, /verifyBinDir\(BIN_ROOT, loaded\.manifest, \{ requireAll: strict \}\)/, '工作树复验必须在 strict 下要求齐全')
  assert.match(source, /verifyBinDir\(binDir, loaded\.manifest, \{ requireAll: true \}\)/, 'tarball 复验必须要求齐全（与是否 strict 无关，走到那一步就是发布形状）')
  assert.match(source, /发布严格模式要求自带二进制/, '完全没有 bin 在 strict 下必须是失败，不是警告')
  assert.match(source, /strict && problems\.length > 0/, '已经不合格时不再重复打 108MB 的包')
})

test('release strict mode neutralizes an inherited npm dry_run before the real pack', async () => {
  // 真实故障：`npm publish --dry-run`（发布手册 §5.3 的必做一步）会把 npm_config_dry_run=true
  // 设进整棵进程树，并**继承**给严格模式里那次真正的 `npm pack` → 打不出 .tgz →
  // `npm run pack:assert:strict` 必红，而 CI 单独跑这一步（npm publish --provenance，不是 dry-run）
  // 永远看不出来。断言钉的是「那次 pack 的子进程环境必须显式关掉它」。
  //
  // 只做源码接线断言：真跑一遍要打 108MB 的 tarball，且 CI 的单元测试 job 上 `bin/` 根本没装配，
  // 行为断言在那边只会变成 skip —— 这与本文件既有的接线断言口径一致。
  const source = await readFile(join(ROOT, 'scripts', 'assert-pack.mjs'), 'utf8')
  assert.match(
    source,
    /'pack', '--pack-destination', work, '--ignore-scripts'\], \{\s*cwd: ROOT,\s*maxBuffer: 64 \* 1024 \* 1024,\s*env: \{ \.\.\.process\.env, npm_config_dry_run: 'false' \},?\s*\}\)/,
    '真实 pack 的子进程环境必须显式 npm_config_dry_run=false（否则 npm publish --dry-run 之下打不出 tarball）',
  )
})

test('release packaging rejects Python bytecode residue anywhere in the tree', async () => {
  // 真实故障：在包目录里跑一次技能门禁（`kb_tool.py` / 契约测试）就会在
  // `skills/crwu/**/scripts/__pycache__/` 落 `.pyc`，而 `files` 里有 `skills/crwu/` →
  // 它会随包发出去（`.pyc` 里还带着构建者的绝对路径）。实测文件数 479 → 481。
  // 前缀式 FORBIDDEN 抓不到任意深度的片段，所以这条断言钉住「按路径片段判」的写法。
  const source = await readFile(join(ROOT, 'scripts', 'assert-pack.mjs'), 'utf8')
  assert.match(source, /file\.split\('\/'\)\.includes\('__pycache__'\)/, '必须按路径片段抓 __pycache__（前缀匹配抓不到深层残留）')
  assert.match(source, /file\.endsWith\('\.pyc'\)/, '散落的 .pyc 同样要在发布前拦下')
  assert.match(source, /打进了 Python 字节码缓存/, '残留必须变成 FAIL，不是静默放过')
})
