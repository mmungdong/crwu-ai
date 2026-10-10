/**
 * 本地审核（协议 28）的 Host 侧逐条测试。
 *
 * 这一份盯的是**设计与验收场景**（`docs/superpowers/plans/2026-10-11-workbench-local-audit.md`
 * 的 §2–§4、§7–§10），不是实现细节：
 *
 * - 扫描：递归、不跟随符号链接、特殊文件跳过、多入口去重、**超过 30 个明确阻止且不截取**；
 * - 快照：逐件复制、部分失败仍可继续、全部失败即"没有可审核的文件"、清单与元数据可回读；
 * - handoff：存在 / 未用 / 未过期 / 快照仍在四条判据，**同一条会话重复认领幂等**、别的会话拒绝；
 * - 提示词：只含展示名与相对路径，**不含绝对路径 / oss:// / 氚云标识**；
 * - 操作：无选择不可启动、超限拒绝、未授权一个字节都不读。
 *
 * 全部用内存替身（`LocalAuditFs` / `SnapshotIo`）：**绝不碰员工机器上的真实文件**，
 * 也绝不依赖真实的 `os.tmpdir()` 内容。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { scanSelection } = await import(new URL('src/host/local-audit/scan.ts', ROOT).href)
const { prepareSnapshot, readManifest, localAuditCaseDir } = await import(new URL('src/host/local-audit/snapshot.ts', ROOT).href)
const { createLocalAuditRegistry, newHandoffId } = await import(new URL('src/host/local-audit/handoff.ts', ROOT).href)
const { localAuditPrompt, snapshotStatusLine } = await import(new URL('src/host/local-audit/prompt.ts', ROOT).href)
const { localAuditStart, localAuditStatus, localAuditClaim } = await import(new URL('src/host/local-audit/ops.ts', ROOT).href)

// ── 内存替身 ──────────────────────────────────────────────────────────────────

/** 内存文件系统：键是绝对路径，值是 `{ kind, size, readable }`。 */
function memoryFs(entries, options = {}) {
  return {
    async kindOf(path) {
      const hit = entries[path]
      return hit === undefined ? 'absent' : hit.kind
    },
    async list(path) {
      if (options.unreadableDirs?.includes(path)) throw new Error('EACCES')
      const children = Object.entries(entries)
        .filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map(([key, value]) => ({ name: key.slice(path.length + 1), kind: value.kind, sizeBytes: value.size ?? 0 }))
      children.sort((left, right) => (left.name < right.name ? -1 : 1))
      return children
    },
    async canonical(path) { return options.canonical?.[path] ?? path },
    async readable(path) { return entries[path]?.readable !== false },
    async sizeOf(path) { return entries[path]?.size ?? 0 },
  }
}

/** 内存快照 IO：复制失败的源路径由 `failCopy` 指定；`deleted` 用来模拟"原件后来被删了"。 */
function memoryIo(options = {}) {
  const files = new Map()
  const dirs = new Set()
  return {
    files,
    dirs,
    /** 测试可以往里 push 源路径，模拟快照建完之后原件被删除 / 移走。 */
    deleted: [],
    async makeDir(path) { dirs.add(path) },
    async copyFile(from, to) {
      if (options.failCopy?.includes(from)) throw new Error('读取失败')
      if (this.deleted.includes(from)) throw new Error('ENOENT')
      files.set(to, from)
    },
    async writeText(path, content) { files.set(path, content) },
    async readText(path) {
      const value = files.get(path)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async removeTree(path) {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key)
    },
  }
}

const FILE = (size = 100, readable = true) => ({ kind: 'file', size, readable })
/** 测试用的已选工作空间（案例目录现在落在它下面：`<工作空间>/本地审核/<handoffId>`）。 */
const WORKSPACE = '/work/中瑞世联工作空间'
const caseOf = (id) => localAuditCaseDir(WORKSPACE, id)
const DIR = { kind: 'directory' }

// ── 1. 扫描 ──────────────────────────────────────────────────────────────────

test('扫描：文件夹递归展开，文件与目录混选时逐项计数正确', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/资产清单.xlsx': FILE(2400),
    '/work/资料/子目录': DIR,
    '/work/资料/子目录/说明.pdf': FILE(999),
    '/work/单独表格.xls': FILE(10),
  })
  const scan = await scanSelection(['/work/资料', '/work/单独表格.xls'], fs)
  assert.equal(scan.ok, true)
  assert.equal(scan.fileCount, 3)
  assert.equal(scan.overLimit, false)
  assert.deepEqual(scan.files.map((item) => item.relativePath).sort(), [
    '单独表格.xls', '资料/子目录/说明.pdf', '资料/资产清单.xlsx',
  ])
  // 选择项：目录行显示"展开 N 个文件"，文件行是 1。
  assert.deepEqual(scan.items.map((item) => [item.name, item.kind, item.fileCount]), [
    ['资料', 'directory', 2], ['单独表格.xls', 'file', 1],
  ])
})

test('扫描：不跟随目录与文件符号链接（记 skipped，写明原因）', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/真表格.xlsx': FILE(1),
    '/work/资料/快捷方式': { kind: 'symlink' },
    '/work/资料/链到别处.xlsx': { kind: 'symlink' },
  })
  const scan = await scanSelection(['/work/资料'], fs)
  assert.equal(scan.fileCount, 1, '符号链接不进审核范围')
  assert.deepEqual(scan.skipped.map((item) => item.reason), ['符号链接不纳入审核范围', '符号链接不纳入审核范围'])
})

test('扫描：特殊文件（FIFO / 设备节点）跳过，不挂住也不上报为文件', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/正常.docx': FILE(5),
    '/work/资料/管道': { kind: 'other' },
  })
  const scan = await scanSelection(['/work/资料'], fs)
  assert.equal(scan.fileCount, 1)
  assert.equal(scan.skipped.length, 1)
  assert.match(scan.skipped[0].reason, /特殊文件/)
})

test('扫描：同一个文件经多个入口进来只出现一次（去重按真实路径）', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/资产清单.xlsx': FILE(7),
  }, { canonical: { '/work/资料/资产清单.xlsx': 'real:资产清单' } })
  // 三个入口指向同一个真实文件：目录、文件本身、以及一条指向它的软链路径（canonical 相同）。
  const scan = await scanSelection(['/work/资料', '/work/资料/资产清单.xlsx', '/work/link.xlsx'], fs)
  assert.equal(scan.fileCount, 1, '同一个文件只能算一次')
  assert.deepEqual(scan.files.map((item) => item.name), ['资产清单.xlsx'])
})

test('扫描：超过 30 个文件时明确阻止，而且**不截取**（fileCount 是真实数量）', async () => {
  const entries = { '/work/资料': DIR }
  for (let index = 1; index <= 36; index += 1) {
    entries[`/work/资料/表${String(index).padStart(2, '0')}.xlsx`] = FILE(index)
  }
  const scan = await scanSelection(['/work/资料'], memoryFs(entries))
  assert.equal(scan.fileCount, 36, '不许静默截取前 30 个')
  assert.equal(scan.overLimit, true)
  assert.equal(scan.items[0].status, 'over-limit')
})

test('扫描：恰好 30 个不算超限', async () => {
  const entries = { '/work/资料': DIR }
  for (let index = 1; index <= 30; index += 1) entries[`/work/资料/表${String(index)}.xlsx`] = FILE(1)
  const scan = await scanSelection(['/work/资料'], memoryFs(entries))
  assert.equal(scan.fileCount, 30)
  assert.equal(scan.overLimit, false)
})

test('扫描：读不了的文件进 skipped（原因"权限不足"），不影响其余文件', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/可读.xlsx': FILE(1, true),
    '/work/资料/锁住.xlsx': FILE(1, false),
  })
  const scan = await scanSelection(['/work/资料'], fs)
  assert.equal(scan.fileCount, 1)
  assert.deepEqual(scan.skipped.map((item) => [item.name, item.reason]), [['锁住.xlsx', '权限不足']])
})

test('扫描：不存在的入口记 unreadable；相对路径一律拒绝', async () => {
  const absent = await scanSelection(['/work/没有这个'], memoryFs({}))
  assert.equal(absent.items[0].status, 'unreadable')
  assert.equal(absent.fileCount, 0)
  const relative = await scanSelection(['资料/表.xlsx'], memoryFs({}))
  assert.equal(relative.ok, false)
  assert.equal(relative.errorKind, 'input')
})

test('扫描：任意扩展名都不被拦截', async () => {
  const fs = memoryFs({
    '/work/资料': DIR,
    '/work/资料/a.xyz': FILE(1),
    '/work/资料/b': FILE(1),
    '/work/资料/c.2026': FILE(1),
  })
  const scan = await scanSelection(['/work/资料'], fs)
  assert.equal(scan.fileCount, 3)
})

// ── 2. 快照 ──────────────────────────────────────────────────────────────────

test('扫描：排除清单里的文件不进清单、不计入数量、也不算"读不到"', async () => {
  const entries = {
    '/work/资料': { kind: 'directory' },
    '/work/资料/资产清单.xlsx': { kind: 'file', size: 10, readable: true },
    '/work/资料/说明.pdf': { kind: 'file', size: 20, readable: true },
  }
  const fs = memoryFs(entries)
  const full = await scanSelection(['/work/资料'], fs)
  assert.equal(full.files.length, 2)
  assert.deepEqual(full.files.map((item) => item.parentPath), ['/work/资料', '/work/资料'], '每个文件都要说出自己属于哪个入口')

  // 员工在界面上把说明.pdf 那一行移除了。
  const trimmed = await scanSelection(['/work/资料'], fs, { excluded: ['/work/资料/说明.pdf'] })
  assert.deepEqual(trimmed.files.map((item) => item.name), ['资产清单.xlsx'])
  assert.equal(trimmed.fileCount, 1, '被移除的文件不计入总数')
  assert.equal(trimmed.items[0].fileCount, 1, '文件夹行的"展开后 N 个"也要跟着少')
  assert.deepEqual(trimmed.skipped, [], '被移除**不是**"读不到"，不许出现在跳过清单里')
})

test('扫描：入口本身被移除时如实说"已移除"，不说成"无法读取"', async () => {
  const entries = { '/work/资料': { kind: 'directory' }, '/work/资料/表.xlsx': { kind: 'file', size: 1, readable: true } }
  const fs = memoryFs(entries)
  const scan = await scanSelection(['/work/资料/表.xlsx'], fs, { excluded: ['/work/资料/表.xlsx'] })
  assert.equal(scan.fileCount, 0)
  assert.equal(scan.items[0].status, 'removed')
  assert.match(scan.items[0].reason, /已移除/)
})

test('快照：逐件复制到 材料-源/，清单与元数据可回读且 handoffId 一致', async () => {
  const io = memoryIo()
  const id = 'la-1-abcd1234'
  const outcome = await prepareSnapshot(id, [
    { sourcePath: '/work/资料/资产清单.xlsx', relativePath: '资料/资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 2400 },
    { sourcePath: '/work/资料/子/说明.pdf', relativePath: '资料/子/说明.pdf', name: '说明.pdf', sizeBytes: 9 },
  ], io, { casePath: caseOf(id) })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.files.length, 2)
  assert.ok(outcome.files.every((item) => item.relativePath.startsWith('材料-源/')))
  assert.ok(outcome.digest.startsWith('sha256:'))
  const manifest = await readManifest(io, localAuditCaseDir(WORKSPACE, id), id)
  assert.deepEqual(manifest, { fileCount: 2, skippedCount: 0 })
  assert.equal(await readManifest(io, localAuditCaseDir(WORKSPACE, id), 'la-other'), null, 'handoffId 对不上就是没读到')
})

test('快照：部分文件复制失败仍可继续（跳过原因"快照读取失败"）', async () => {
  const io = memoryIo({ failCopy: ['/work/坏.zip'] })
  const outcome = await prepareSnapshot('la-2', [
    { sourcePath: '/work/好.xlsx', relativePath: '好.xlsx', name: '好.xlsx', sizeBytes: 1 },
    { sourcePath: '/work/坏.zip', relativePath: '坏.zip', name: '坏.zip', sizeBytes: 1 },
  ], io, { casePath: caseOf('la-2') })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.files.length, 1)
  assert.deepEqual(outcome.skipped.map((item) => [item.name, item.reason]), [['坏.zip', '快照读取失败']])
})

test('快照：全部失败 = 没有可审核的文件，且半截目录被清掉', async () => {
  const io = memoryIo({ failCopy: ['/work/坏.zip'] })
  const outcome = await prepareSnapshot('la-3', [
    { sourcePath: '/work/坏.zip', relativePath: '坏.zip', name: '坏.zip', sizeBytes: 1 },
  ], io, { casePath: caseOf('la-3') })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.errorKind, 'no-readable-files')
  assert.equal(io.files.size, 0)
})

test('快照：清单里不含用户的原始绝对路径', async () => {
  const io = memoryIo()
  await prepareSnapshot('la-4', [
    { sourcePath: '/Users/someone/绝密/资产清单.xlsx', relativePath: '资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 1 },
  ], io, { casePath: caseOf('la-4') })
  // 只看**写下去的文本**（清单/元数据 JSON）；复制出来的条目值记的是源路径（替身实现细节）。
  const texts = [...io.files.values()].filter((value) => typeof value === 'string' && value.trimStart().startsWith('{'))
  for (const text of texts) {
    assert.equal(text.includes('/Users/someone/绝密'), false, '清单里不许出现原始绝对路径')
  }
})

// ── 3. handoff ───────────────────────────────────────────────────────────────

const FILES = [{ relativePath: '材料-源/资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 2400 }]

function handoffWith(io, options = {}) {
  const registry = createLocalAuditRegistry()
  const id = options.id ?? newHandoffId(1_000)
  // 案例目录用**生产实现算出来的那一条**：把它写死成另一条路径，就会测出一个真实缺陷
  //（claim / sweep 用的路径与快照实际落点不一致）。
  const record = registry.create({ id, casePath: localAuditCaseDir(WORKSPACE, id), files: FILES, skipped: [], now: 1_000 })
  return { registry, id, record }
}

test('handoff：认领成功后同一会话再认领是**幂等**的（自动链路 + Tool 各调一次）', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  const first = await registry.claim(id, 'session-1', io, 1_100)
  assert.equal(first.ok, true)
  assert.equal(first.casePath, localAuditCaseDir(WORKSPACE, id))
  const again = await registry.claim(id, 'session-1', io, 1_200)
  assert.equal(again.ok, true, '同一条会话重复认领必须拿到同一份清单')
  assert.equal(again.fileCount, first.fileCount)
})

test('handoff：别的会话拿不到（已用过）', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  assert.equal((await registry.claim(id, 'session-1', io, 1_100)).ok, true)
  const other = await registry.claim(id, 'session-2', io, 1_200)
  assert.equal(other.ok, false)
  assert.equal(other.errorKind, 'policy')
  assert.match(other.error, /已经用过/)
})

test('handoff：过期后不能再用，而且明确指回 Workbench 重新准备', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  const late = await registry.claim(id, 'session-1', io, 1_000 + 31 * 60_000)
  assert.equal(late.ok, false)
  assert.equal(late.errorKind, 'policy')
  assert.match(late.error, /已过期/)
  assert.match(late.error, /Workbench/)
})

test('handoff：快照不在了 = capability gap（不让模型自己去本机找文件）', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  const missing = await registry.claim(id, 'session-1', io, 1_100)
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'capability-gap')
  assert.match(missing.error, /重新准备/)
})

test('handoff：未知 id 与空会话都 fail closed；scope 只绑到认领的那条会话', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  assert.equal((await registry.claim('la-nope', 'session-1', io, 1_100)).ok, false)
  assert.equal((await registry.claim(id, '', io, 1_100)).ok, false)
  assert.equal(registry.scopeOf('session-1'), undefined)
  await registry.claim(id, 'session-1', io, 1_100)
  assert.deepEqual(registry.scopeOf('session-1'), { handoffId: id, casePath: localAuditCaseDir(WORKSPACE, id), claimedAt: 1_100 })
  assert.equal(registry.scopeOf('session-2'), undefined)
})

test('handoff：被淘汰的最旧一条也会在下次清理时删掉快照目录（不留孤儿）', async () => {
  const io = memoryIo()
  const registry = createLocalAuditRegistry()
  const firstId = newHandoffId(1_000)
  const first = await prepareSnapshot(firstId, [
    { sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 },
  ], io, { casePath: caseOf(firstId) })
  registry.create({ id: firstId, casePath: first.casePath, files: first.files, skipped: [], now: 1_000 })
  // 灌满注册表，把上面那条挤出去（淘汰发生在同步路径上，那时没有 IO 可做）。
  for (let index = 0; index < 40; index += 1) {
    const id = newHandoffId(1_000 + index + 1)
    registry.create({ id, casePath: `/tmp/${id}`, files: [], skipped: [], now: 1_000 + index + 1 })
  }
  assert.equal(registry.peek(firstId), undefined)
  const swept = await registry.sweep(io, 1_001)
  assert.equal(swept.removed.includes(first.casePath), true, '被淘汰那条的快照目录必须被清掉')
  assert.equal(io.files.size, 0)
})

test('handoff：清理只删**没人认领**的过期快照', async () => {
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  const swept = await registry.sweep(io, 1_000 + 31 * 60_000)
  assert.deepEqual(swept.dropped, [id])
  assert.equal(registry.size(), 0)
  assert.equal(io.files.size, 0)
})

test('handoff：认领过的案例目录**绝不被清理删掉**（交付件就在里面）', async () => {
  // 2026-10-11 用户实测的数据丢失：`sweep` 原来把「已被认领」也当成可删条件，
  // 而 `claim()` 一成功就置 used —— 于是审计跑完（甚至还在跑）时，下一次清理
  // 就把整个案例目录连**交付件 HTML/JSON** 一起删了。
  const io = memoryIo()
  const { registry, id } = handoffWith(io)
  await prepareSnapshot(id, [{ sourcePath: '/a.xlsx', relativePath: 'a.xlsx', name: 'a.xlsx', sizeBytes: 1 }], io, { casePath: caseOf(id) })
  assert.equal((await registry.claim(id, 'session-1', io, 1_100)).ok, true)
  // 认领之后，即便过了很久（远超 TTL）：**既不清记录、也不删目录**。
  // 记录要留着 —— 自动链路是"客户端先认领一次、模型随后按提示词再认领一次"，
  // 中间若被清掉，模型那一次就会拿到"已过期"，整条审核会莫名其妙停住。
  const swept = await registry.sweep(io, 1_000 + 365 * 24 * 60 * 60_000)
  assert.deepEqual(swept.dropped, [])
  assert.deepEqual(swept.removed, [])
  assert.ok(io.files.size > 0, '案例目录（含交付件）必须留着')
  assert.equal((await registry.claim(id, 'session-1', io, 1_200)).ok, true, '同一条会话仍然幂等')
  assert.deepEqual(await readManifest(io, caseOf(id), id), { fileCount: 1, skippedCount: 0 })
})

// ── 4. 提示词 ────────────────────────────────────────────────────────────────

test('提示词：含 handoffId / 展示名 / 相对路径 / 跳过原因，且**不含**绝对路径与云侧信息', () => {
  const prompt = localAuditPrompt({
    handoffId: 'la-9-abcdef',
    files: [
      { relativePath: '材料-源/资料/资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 2400 },
      { relativePath: '材料-源/说明.pdf', name: '说明.pdf', sizeBytes: 1 },
    ],
    skipped: [{ relativePath: '资料/坏.zip', name: '坏.zip', reason: '快照读取失败' }],
    extraPrompt: '重点检查金额汇总。',
  })
  assert.match(prompt, /la-9-abcdef/)
  assert.match(prompt, /crwu_audit_local_claim/)
  assert.match(prompt, /资产清单\.xlsx → 材料-源\/资料\/资产清单\.xlsx/)
  assert.match(prompt, /坏\.zip（资料\/坏\.zip）：快照读取失败/)
  assert.match(prompt, /重点检查金额汇总。/)
  // 硬要求：本地审核不许上传 / 回传，交付件要标记"本地审核"。
  assert.match(prompt, /钉钉/)
  assert.match(prompt, /本地审核/)
  assert.match(prompt, /未审核/)
  assert.match(prompt, /画像缺失/)
  // 禁止项：绝对路径、OSS 地址、氚云标识与凭据。
  assert.equal(/\/Users\//.test(prompt), false, '提示词不许出现用户绝对路径')
  assert.equal(/oss:\/\//.test(prompt), false, '提示词不许出现 OSS 地址')
  assert.equal(/bucket|endpoint|AccessKey|schemaCode|objectId/.test(prompt), false, '提示词不许出现云侧标识与凭据')
})

test('提示词：交付件要写**完整路径**（只写文件名会让界面按工作空间根解析 → 点不开）', () => {
  const prompt = localAuditPrompt({
    handoffId: 'la-9-abcdef',
    files: [{ relativePath: '材料-源/资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 1 }],
    skipped: [],
    extraPrompt: '',
  })
  // 2026-10-11 用户实测：「在会话中直接点击文件跳转不过去」——
  // 界面里的文件链接是按会话工作空间根解析的，只写文件名会指到不存在的路径。
  assert.match(prompt, /交付件（\*\*完整路径\*\*/, '收尾格式里要有交付件那一块')
  assert.match(prompt, /<caseDir>\/审核意见\.<项目ID>\.html/)
  assert.match(prompt, /不要只写文件名/)
  // 同时仍然不许把「绝对路径」写进**我们生成的提示词**（只要求模型在对话里写完整路径）。
  assert.equal(prompt.includes('/Users/'), false)
})

test('提示词：没有补充要求时明说使用默认本地审核规则', () => {
  const prompt = localAuditPrompt({ handoffId: 'la-1', files: [], skipped: [], extraPrompt: '   ' })
  assert.match(prompt, /按默认本地审核规则执行/)
})

test('快照状态行：跳过为 0 时不出现"跳过"', () => {
  assert.equal(snapshotStatusLine(12, 0), '已提供 12 个文件')
  assert.equal(snapshotStatusLine(12, 1), '已提供 12 个文件，跳过 1 个文件')
})

// ── 5. 操作（含未授权一个字节都不读） ────────────────────────────────────────

function opsDeps(entries, options = {}) {
  const io = options.io ?? memoryIo()
  const registry = createLocalAuditRegistry()
  const notes = []
  const authorizeResults = options.authorize ?? { ok: true, error: '', errorClass: '' }
  return {
    io,
    registry,
    notes,
    deps: {
      ctx: {},
      access: {
        authorize: () => authorizeResults,
        note: (call) => { notes.push(call.operation) },
      },
      // 案例目录落在**员工选定的工作空间**下：ops 依赖里必须有它。
      state: { workspacePath: WORKSPACE, caseRoot: WORKSPACE },
      world: { async workdir() { return '/work' } },
      registry,
      fs: memoryFs(entries, options),
      io,
    },
  }
}

test('操作：没有选择时不可启动（input 失败，且不建任何东西）', async () => {
  const { deps, io, registry } = opsDeps({})
  const started = await localAuditStart(deps, { selection: [] })
  assert.equal(started.ok, false)
  assert.equal(started.errorKind, 'input')
  assert.equal(started.handoffId, '')
  assert.equal(io.files.size, 0)
  assert.equal(registry.size(), 0)
})

test('操作：超过 30 个文件时 Host 也拒绝（界面禁用只是体验）', async () => {
  const entries = { '/work/资料': DIR }
  for (let index = 0; index < 31; index += 1) entries[`/work/资料/表${String(index)}.xlsx`] = FILE(1)
  const { deps, registry } = opsDeps(entries)
  const started = await localAuditStart(deps, { selection: ['/work/资料'] })
  assert.equal(started.ok, false)
  assert.match(started.error, /超过单次最多 30 个文件/)
  assert.equal(registry.size(), 0)
})

test('操作：没有可读文件时不可启动', async () => {
  const { deps, registry } = opsDeps({ '/work/资料': DIR, '/work/资料/锁住.xlsx': FILE(1, false) })
  const started = await localAuditStart(deps, { selection: ['/work/资料'] })
  assert.equal(started.ok, false)
  assert.equal(started.error, '没有可审核的文件')
  assert.equal(registry.size(), 0)
})

test('操作：未授权时**一个字节都不读**（Broker 拒绝优先于任何 IO）', async () => {
  const notes = []
  const { deps, io, registry } = opsDeps(
    { '/work/资料': DIR, '/work/资料/表.xlsx': FILE(1) },
    { authorize: { ok: false, error: '本机访问尚未允许：请先在「账号连接」里允许', errorClass: 'not-authorized' } },
  )
  deps.access.note = (call) => { notes.push(call.operation) }
  const started = await localAuditStart(deps, { selection: ['/work/资料'] })
  assert.equal(started.ok, false)
  assert.equal(started.errorKind, 'policy')
  assert.match(started.error, /本机访问尚未允许/)
  assert.equal(io.files.size, 0, '未授权时不许写任何快照文件')
  assert.equal(registry.size(), 0)
  assert.deepEqual(notes, [], '拒绝不是"做过一次"，不记成功留痕')
})

test('操作：正常路径产出 handoff + 可复制提示词 + 已提供/跳过计数，并留一条诊断', async () => {
  const { deps, registry, notes } = opsDeps({
    '/work/资料': DIR,
    '/work/资料/资产清单.xlsx': FILE(2400),
    '/work/资料/坏.zip': FILE(1),
  }, { io: memoryIo({ failCopy: ['/work/资料/坏.zip'] }) })
  const started = await localAuditStart(deps, { selection: ['/work/资料'], prompt: '看金额' })
  assert.equal(started.ok, true)
  assert.equal(started.providedCount, 1)
  assert.equal(started.skippedCount, 1)
  assert.equal(started.expiresAt > 0, true)
  assert.match(started.prompt, new RegExp(started.handoffId))
  assert.match(started.prompt, /看金额/)
  assert.deepEqual(notes, ['system.local-audit-material.snapshot'])
  // 案例目录只回给客户端（新会话的 cwd）；提示词里不出现这条绝对路径。
  assert.equal(started.casePath, registry.peek(started.handoffId)?.casePath)
  assert.equal(started.prompt.includes(started.casePath), false, '提示词里不许出现案例目录绝对路径')
  assert.equal(registry.peek(started.handoffId)?.used, false)
})

test('操作：没选工作空间就不许开始（案例目录要落在它下面、会话也挂在它下面）', async () => {
  const { deps, io, registry } = opsDeps({ '/work/资料': DIR, '/work/资料/表.xlsx': FILE(1) })
  // 把工作空间清空（员工还没在环境信息里选）。
  deps.state.workspacePath = ''
  deps.state.caseRoot = ''
  const started = await localAuditStart(deps, { selection: ['/work/资料'] })
  assert.equal(started.ok, false)
  assert.equal(started.errorKind, 'policy')
  assert.match(started.error, /先.*环境信息.*选择工作空间/)
  assert.equal(io.files.size, 0, '没工作空间时一个文件都不复制')
  assert.equal(registry.size(), 0)
})

test('操作：status 应答带文件级清单（界面据此逐行展示完整文件名）', async () => {
  const { deps } = opsDeps({
    '/work/资料': DIR,
    '/work/资料/资产清单.xlsx': FILE(10),
    '/work/资料/说明.pdf': FILE(20),
  })
  const view = await localAuditStatus(deps, { selection: ['/work/资料'], excluded: ['/work/资料/说明.pdf'] })
  assert.equal(view.ok, true)
  assert.deepEqual(view.files.map((item) => [item.name, item.parentPath, item.path]), [
    ['资产清单.xlsx', '/work/资料', '/work/资料/资产清单.xlsx'],
  ], '每个文件都要能被界面挂到入口下面，并带上"移除它"用的完整路径')
  assert.equal(view.fileCount, 1)
})

test('操作：start 认排除清单（快照里就没有被移除的文件）', async () => {
  const { deps, io } = opsDeps({
    '/work/资料': DIR,
    '/work/资料/资产清单.xlsx': FILE(10),
    '/work/资料/说明.pdf': FILE(20),
  })
  const started = await localAuditStart(deps, { selection: ['/work/资料'], excluded: ['/work/资料/说明.pdf'] })
  assert.equal(started.ok, true)
  assert.equal(started.providedCount, 1)
  assert.deepEqual(started.files.map((item) => item.name), ['资产清单.xlsx'])
  // 快照目录里也只有那一个（没被移除的那个不进案例目录）。
  assert.equal([...io.files.keys()].some((path) => path.includes('说明.pdf')), false)
})

test('操作：案例目录落在工作空间下，会话 cwd 也回工作空间', async () => {
  const { deps, registry } = opsDeps({ '/work/资料': DIR, '/work/资料/表.xlsx': FILE(1) })
  const started = await localAuditStart(deps, { selection: ['/work/资料'] })
  assert.equal(started.ok, true)
  // 会话 cwd = 员工选定的工作空间（DSH 据此把会话挂到那个工作空间下）。
  assert.equal(started.workspacePath, '/work/中瑞世联工作空间')
  // 案例目录在它里面：交付件在员工自己的目录里找得到，也才落在会话沙箱边界之内。
  assert.equal(started.casePath.startsWith('/work/中瑞世联工作空间/'), true, started.casePath)
  assert.equal(started.casePath.includes('/本地审核/'), true, started.casePath)
  assert.equal(registry.peek(started.handoffId)?.casePath, started.casePath)
  // 提示词里两条绝对路径都不许出现。
  assert.equal(started.prompt.includes(started.workspacePath), false)
  assert.equal(started.prompt.includes(started.casePath), false)
})

test('操作：status 只回事实（不建快照、不建 handoff）', async () => {
  const { deps, io, registry } = opsDeps({ '/work/资料': DIR, '/work/资料/表.xlsx': FILE(1) })
  const scan = await localAuditStatus(deps, { selection: ['/work/资料'] })
  assert.equal(scan.ok, true)
  assert.equal(scan.fileCount, 1)
  assert.equal(scan.limit, 30)
  assert.equal(io.files.size, 0)
  assert.equal(registry.size(), 0)
})

test('操作：claim 需要 handoffId 与会话标识，两者缺一都拒绝', async () => {
  const { deps } = opsDeps({})
  assert.equal((await localAuditClaim(deps, {})).ok, false)
  assert.equal((await localAuditClaim(deps, { handoffId: 'la-1' })).ok, false)
})

test('原始文件在快照之后被删除，不影响这一轮：认领只读快照，不再碰原件', async () => {
  const io = memoryIo()
  const id = 'la-88-abcdef'
  const candidates = [
    { sourcePath: '/work/资产清单.xlsx', relativePath: '资产清单.xlsx', name: '资产清单.xlsx', sizeBytes: 1 },
    { sourcePath: '/work/说明.pdf', relativePath: '说明.pdf', name: '说明.pdf', sizeBytes: 1 },
  ]
  const first = await prepareSnapshot(id, candidates, io, { casePath: caseOf(id) })
  assert.equal(first.ok, true)
  const registry = createLocalAuditRegistry()
  registry.create({ id, casePath: first.casePath, files: first.files, skipped: [], now: 1_000 })

  // 用户在快照之后把原件删了（或者移走了整个目录）。
  io.deleted.push('/work/资产清单.xlsx', '/work/说明.pdf')

  // 认领与回读清单都只走案例目录 —— 原件不在了也必须成功。
  const claimed = await registry.claim(id, 'session-1', io, 1_100)
  assert.equal(claimed.ok, true, '原件删除不该让这一轮认领失败（设计 §17.13）')
  assert.equal(claimed.files.length, 2)
  assert.deepEqual(await readManifest(io, first.casePath, id), { fileCount: 2, skippedCount: 0 })

  // 反证：这时**再建一次**快照就会失败 —— 说明上面那条不是"原件其实还在"。
  const again = await prepareSnapshot('la-99', candidates, io, { casePath: caseOf('la-99') })
  assert.equal(again.ok, false)
  assert.equal(again.skipped.length, 2)
})
