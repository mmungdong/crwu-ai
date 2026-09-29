/**
 * 状态持久化与工作空间解析的单元测试。
 *
 * 这一层管三件会「跨重启」的事：审核记录、**占用锁**、用户选过的工作空间。
 * 三者丢了都会产生真实事故（重复起子会话对写同一目录 / 用户的选择被自检覆盖），
 * 所以每条都要能反向失败。另有两条绝对规则：绝不采用父会话自己的工作空间，以及运行态不落盘。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { readWorkbenchConfig, writeWorkbenchConfig, workbenchConfigPath } = await import(
  new URL('src/host/state/persist.ts', ROOT).href
)
const { normalizeAudit, persistableAudits, persistAudits, persistAuditRoot, ensureRegistry } = await import(
  new URL('src/host/state/registry.ts', ROOT).href
)
const { trimSlash, registryList, resolveAuditWorkspace, ensureWorkspace, sessionWorkspaceInfo } = await import(
  new URL('src/host/workspace/resolve.ts', ROOT).href
)
const { createWorkbenchState } = await import(new URL('src/host/state/store.ts', ROOT).href)
const { makeTestAccess } = await import(new URL('tests/helpers/local-access-broker-fixture.mjs', ROOT).href)

/**
 * `writeWorkbenchConfig` 的依赖：真 Broker（策略走真实代码）+ 测试的 ctx。
 *
 * 状态文件是 `host-owned-state`（不属于员工授予的能力），所以未授权也能落盘 —— 这正是
 * 「允许一次」这个动作本身能写盘的原因。
 */
function writeDeps(ctx) {
  return { ctx, home: '/Users/x', access: makeTestAccess(ctx).access }
}

/** `ensureRegistry` / `persistAudits` / `persistAuditRoot` 的依赖（同一份 Broker）。 */
function regDeps(ctx, state) {
  return { ctx, home: '/Users/x', state, access: makeTestAccess(ctx).access }
}

/** 内存文件系统替身：记录写入，stat 按已有文件回答。 */
function memoryFs(initial = {}, dirs = []) {
  const files = { ...initial }
  const directories = new Set(dirs)
  const writes = []
  return {
    files,
    writes,
    ctx: {
      get: (name) => (name === 'fs'
        ? {
            async resolve(path) { return { targetKey: path, displayPath: path } },
            async stat(target) {
              // 真实实现会归一尾斜杠：`/cases/a/` 与 `/cases/a` 是同一个目录。
              const key = String(target.targetKey).replace(/[\\/]+$/, '')
              if (directories.has(key)) return { type: 'directory' }
              return files[target.targetKey] === undefined ? undefined : { type: 'file' }
            },
            async readText(target) { return files[target.targetKey] },
            async writeText(target, content) {
              writes.push({ path: target.targetKey, content })
              files[target.targetKey] = content
              return { operation: 'update', version: 'v', before: null, after: content }
            },
          }
        : undefined),
    },
  }
}

const CONFIG = { caseRoot: '/cases', formName: '报告审核', preferWorkspaceTitle: '', ossBucket: '', ossPrefix: '', ossEndpoint: '', ossLinkMode: 'signed', ossLinkTtlSeconds: 3600, autoUpload: true, requireTopLevelParent: true }

function makeState(patch = {}) {
  return { ...createWorkbenchState(CONFIG), ...patch }
}

// ── 持久化文件 ──────────────────────────────────────────────────────────────

test('workbenchConfigPath lives under the execution-world home', () => {
  assert.equal(workbenchConfigPath('/Users/x/'), '/Users/x/.dsh/crwu-workbench.json')
  assert.equal(workbenchConfigPath(''), '~/.dsh/crwu-workbench.json')
})

test('P2 · Windows 上的收据路径不能出现混合分隔符（授权状态就落在这个文件里）', () => {
  // `C:\Users\x` + 手拼 `/` = `C:\Users\x/.dsh/crwu-workbench.json`。Windows 通常能吃下去，
  // 但这个文件承载授权收据与撤销状态，不该依赖"通常能吃下去"。
  const win = workbenchConfigPath('C:\\Users\\张 三')
  assert.equal(win.includes('/'), false, `Windows 路径出现正斜杠：${win}`)
  assert.equal(win.endsWith('\\.dsh\\crwu-workbench.json'), true, win)
  // 盘符根 + 尾分隔符 + 非 ASCII 都要稳。
  assert.equal(workbenchConfigPath('C:\\'), 'C:\\.dsh\\crwu-workbench.json', '盘符根后面只接一个分隔符')
  // POSIX 侧不变。
  assert.equal(workbenchConfigPath('/Users/x'), '/Users/x/.dsh/crwu-workbench.json')
  assert.equal(workbenchConfigPath('/Users/x/'), '/Users/x/.dsh/crwu-workbench.json')
})

test('readWorkbenchConfig tolerates missing file, bad JSON and missing fs', async () => {
  const missing = memoryFs()
  assert.deepEqual(await readWorkbenchConfig(missing.ctx, '/Users/x'), {})

  const broken = memoryFs({ '/Users/x/.dsh/crwu-workbench.json': '{oops' })
  assert.deepEqual(await readWorkbenchConfig(broken.ctx, '/Users/x'), {})

  // fs 不可用时返回空对象：这个文件坏了不该让整个面板打不开。
  assert.deepEqual(await readWorkbenchConfig({ get: () => undefined }, '/Users/x'), {})
})

test('writeWorkbenchConfig merges instead of overwriting', async () => {
  const fs = memoryFs({ '/Users/x/.dsh/crwu-workbench.json': '{"workspacePath":"/cases/a"}' })
  const ok = await writeWorkbenchConfig(writeDeps(fs.ctx), { activeKey: 'k1' })
  assert.equal(ok, true)
  const written = JSON.parse(fs.writes[0].content)
  assert.equal(written.workspacePath, '/cases/a', '已有的 workspacePath 不能被抹掉')
  assert.equal(written.activeKey, 'k1')
  assert.match(fs.writes[0].content, /\n$/, '文件结尾要有换行')
})

test('writeWorkbenchConfig refuses to write when the config cannot be read', async () => {
  // 读-改-写里把「读失败」当成空配置，就会用只有本次补丁的对象覆盖别人的字段 ——
  // 实测踩过：一次 transient 的 stat 失败把 workspacePath 抹掉，用户下次进来发现工作空间自己变了。
  const writes = []
  const ctx = {
    get: () => ({
      async resolve(path) { return { targetKey: path, displayPath: path } },
      async stat() { throw new Error('boom') },
      async readText() { return '{}' },
      async writeText(target, content) { writes.push({ target, content }) },
    }),
  }
  assert.equal(await writeWorkbenchConfig(writeDeps(ctx), { activeKey: 'k1' }), false, '读不到就别写')
  assert.deepEqual(writes, [], '一次写入都不该发生')
})

test('writeWorkbenchConfig reports failure without throwing when fs is unavailable', async () => {
  assert.equal(await writeWorkbenchConfig(writeDeps({ get: () => undefined }), { a: 1 }), false)
})

// ── 审核记录与占用锁 ────────────────────────────────────────────────────────

test('normalizeAudit narrows fields and only accepts strict booleans', () => {
  const record = normalizeAudit('k', {
    childId: 'c1', seqNo: '2026-301705-LX10170', ended: 'true', stopped: 1, attempt: 'x', adopted: true,
  })
  assert.equal(record.childId, 'c1')
  assert.equal(record.seqNo, '2026-301705-LX10170')
  assert.equal(record.ended, false, 'ended 只认严格 true')
  assert.equal(record.stopped, false)
  assert.equal(record.attempt, 1, 'attempt 非数字时回 1')
  assert.equal(record.adopted, true)
  assert.equal(record.status, 'idle')
  assert.equal(normalizeAudit('k', null), null)
  assert.equal(normalizeAudit('k', 'nope'), null)
})

test('persistableAudits drops live state and keeps the record fields', () => {
  const out = persistableAudits({
    k: { ...normalizeAudit('k', { childId: 'c1' }), uploading: true, runs: { c1: {} } },
  })
  assert.equal(out.k.childId, 'c1')
  assert.equal('uploading' in out.k, false, 'uploading 是运行态，不能落盘')
  assert.equal('runs' in out.k, false, '活的进程内句柄绝不能落盘')
})

test('ensureRegistry restores records AND the occupancy lock', async () => {
  const fs = memoryFs({
    '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({
      audits: { 'a:1': { childId: 'child-1', seqNo: 'S1', attempt: 2 } },
      activeKey: 'a:1',
      activeChildId: 'child-1',
      workspacePath: '/cases/a',
    }),
  })
  const state = makeState()
  await ensureRegistry(regDeps(fs.ctx, state))

  assert.equal(state.audits['a:1'].childId, 'child-1')
  assert.equal(state.audits['a:1'].attempt, 2)
  // 锁没恢复 = 同一条报告能被起第二条子会话。
  assert.equal(state.activeKey, 'a:1')
  assert.equal(state.activeChildId, 'child-1')
  assert.equal(state.registryLoaded, true)
  // 工作空间**不在这里**恢复：它要连同 title/id/source 一起恢复，还要判断目录是否还在，
  // 那三件事只有 ensureWorkspace 做得到（见下面的用例）。
  assert.equal(state.workspacePath, '', 'ensureRegistry 不再单独塞一个 workspacePath')
  assert.equal(state.workspaceChosen, false)
})

test('ensureRegistry never overwrites a live record and only reads once', async () => {
  const fs = memoryFs({
    '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ audits: { k: { childId: 'from-disk' } }, activeChildId: 'disk-child' }),
  })
  const state = makeState()
  state.audits.k = { ...normalizeAudit('k', { childId: 'live' }) }
  state.activeChildId = 'live-child'

  await ensureRegistry(regDeps(fs.ctx, state))
  assert.equal(state.audits.k.childId, 'live', '本进程的记录比磁盘上的新')
  assert.equal(state.activeChildId, 'live-child', '已有占用时不接受磁盘上的锁')

  fs.files['/Users/x/.dsh/crwu-workbench.json'] = JSON.stringify({ audits: { other: { childId: 'x' } } })
  await ensureRegistry(regDeps(fs.ctx, state))
  assert.equal(state.audits.other, undefined, '第二次调用不应再读盘')
})

test('persistAudits writes records plus the occupancy lock', async () => {
  const fs = memoryFs()
  const state = makeState()
  state.audits['a:1'] = { ...normalizeAudit('a:1', { childId: 'c1' }) }
  state.activeKey = 'a:1'
  state.activeChildId = 'c1'
  assert.equal(await persistAudits(regDeps(fs.ctx, state)), true)
  const written = JSON.parse(fs.writes[0].content)
  assert.equal(written.activeKey, 'a:1')
  assert.equal(written.activeChildId, 'c1')
  assert.equal(written.audits['a:1'].childId, 'c1')
})

// ── 审核根会话的跨重启钩子 ──────────────────────────────────────────────────

const SAVED_ROOT = {
  // 根的标识是**案例目录**（协议 19 起）：它必须跟着一起恢复，否则重启后会判过期、
  // 每次都新建一个根（侧栏里散成一堆「审核子代理根节点」）。
  casePath: '/cases/space/S1', workspacePath: '/cases/space', sessionId: 'session-9', title: '审核子代理根节点 · 09-20 10:00', assignedAt: '2026-09-20T02:00:00.000Z' }

test('persistAuditRoot writes the hook and leaves the other fields alone', async () => {
  const fs = memoryFs({ '/Users/x/.dsh/crwu-workbench.json': '{"workspacePath":"/cases/a","audits":{"k1":{"childId":"c1"}}}' })
  const state = makeState({ auditRoot: { ...SAVED_ROOT } })
  assert.equal(await persistAuditRoot(regDeps(fs.ctx, state)), true)

  const written = JSON.parse(fs.writes[0].content)
  assert.deepEqual(written.auditRoot, SAVED_ROOT, '四个字段原样落盘')
  assert.equal(written.workspacePath, '/cases/a', '读-改-写：别人的字段不许被抹掉')
  assert.equal(written.audits.k1.childId, 'c1')
})

test('ensureRegistry restores the persisted root so a restart reuses the same tree', async () => {
  // 恢复失败 = 每次发起审核都新建一个根，侧栏里散成一堆「审核子代理根节点」，而用户
  // 以为自己挂的还是原来那棵树（「挂的有问题」里最容易发生的一种）。
  const fs = memoryFs({ '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ auditRoot: SAVED_ROOT }) })
  const state = makeState()
  await ensureRegistry(regDeps(fs.ctx, state))
  assert.deepEqual(state.auditRoot, SAVED_ROOT)
})

test('ensureRegistry narrows a missing or garbage root to "no root"', async () => {
  // 老状态文件没有 auditRoot；被人手改成对象/数字时也不能把非字符串塞进 state
  // （那会一路显示到界面上，还会被写回磁盘）。
  const absent = makeState()
  await ensureRegistry(regDeps(memoryFs({ '/Users/x/.dsh/crwu-workbench.json': '{"workspacePath":"/cases/a"}' }).ctx, absent))
  assert.deepEqual(absent.auditRoot, { workspacePath: '', casePath: '', sessionId: '', title: '', assignedAt: '' })

  const garbage = makeState()
  const file = JSON.stringify({ auditRoot: { sessionId: { nested: true }, title: 42, assignedAt: ['x'] } })
  await ensureRegistry(regDeps(memoryFs({ '/Users/x/.dsh/crwu-workbench.json': file }).ctx, garbage))
  assert.deepEqual(garbage.auditRoot, { workspacePath: '', casePath: '', sessionId: '', title: '', assignedAt: '' })
})

// ── 工作空间解析 ────────────────────────────────────────────────────────────

/** registry + fs 的组合替身。 */
function workspaceCtx({ entries = [], dirs = [], files = {}, resolveByPath, sessions } = {}) {
  const directories = new Set(dirs)
  return {
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return {
          list: () => entries,
          ...(resolveByPath === undefined ? {} : { resolveByPath }),
        }
      }
      if (name === 'sessions') return sessions
      // 一个 ctx 只提供一份 fs：不要写两个 fs 替身再用 ?? 拼起来 —— 先命中的那个会把
      // 配置文件挡在外面，测试就会在「读不到配置」的前提下假绿/假红。
      if (name === 'fs') {
        return {
          async resolve(path) { return { targetKey: path, displayPath: path } },
          async stat(target) {
            const key = String(target.targetKey).replace(/[\\/]+$/, '')
            if (directories.has(key)) return { type: 'directory' }
            return files[target.targetKey] === undefined ? undefined : { type: 'file' }
          },
          async readText(target) { return files[target.targetKey] ?? '' },
          async writeText(target, content) {
            files[target.targetKey] = content
            return { operation: 'update', version: 'v', before: null, after: content }
          },
        }
      }
      return undefined
    },
  }
}

test('trimSlash only strips trailing separators', () => {
  assert.equal(trimSlash('/cases/a///'), '/cases/a')
  assert.equal(trimSlash('/cases/a\\'), '/cases/a')
  assert.equal(trimSlash(''), '')
  assert.equal(trimSlash(null), '')
})

test('registryList degrades to an empty list when the service is missing or throws', () => {
  assert.deepEqual(registryList({ get: () => undefined }), [])
  assert.deepEqual(registryList({ get: () => ({ list: () => { throw new Error('boom') } }) }), [])
  assert.deepEqual(registryList({ get: () => ({ list: () => 'nope' }) }), [])
  assert.deepEqual(registryList(workspaceCtx({ entries: [{ id: 'w1', path: '/cases/a', title: 'A' }] })), [
    { id: 'w1', path: '/cases/a', title: 'A' },
  ])
})

test('resolveAuditWorkspace prefers the saved choice when it still exists', async () => {
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/saved', title: 'S' }],
    dirs: ['/cases/saved'],
    files: { '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ workspacePath: '/cases/saved/' }) },
    resolveByPath: () => ({ id: 'w9' }),
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.source, 'saved')
  assert.equal(resolved.path, '/cases/saved')
  assert.equal(resolved.id, 'w9', '注册表能解析时用它的 id')
})

test('resolveAuditWorkspace falls back to the manifest workspace by path, then title', async () => {
  const byPath = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/a', title: '别的名字' }, { id: 'w2', path: '/cases/b', title: '中瑞世联工作空间' }],
    dirs: ['/cases/a', '/cases/b'],
  })
  assert.deepEqual(
    await resolveAuditWorkspace(byPath, '/Users/x', { preferTitle: '', preferPath: '/cases/a' }),
    { ok: true, path: '/cases/a', source: 'manifest-workspace', id: 'w1', title: '别的名字', missing: false },
  )
  assert.equal(
    (await resolveAuditWorkspace(byPath, '/Users/x', { preferTitle: '中瑞世联工作空间', preferPath: '' })).id,
    'w2',
  )
})

test('resolveAuditWorkspace matches a title inside the path as a last resort', async () => {
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/workspaces/中瑞世联-审核', title: '审核' }],
    dirs: ['/workspaces/中瑞世联-审核'],
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '中瑞世联', preferPath: '' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.id, 'w1')
})

test('resolveAuditWorkspace refuses a workspace whose directory is gone', async () => {
  const ctx = workspaceCtx({ entries: [{ id: 'w1', path: '/cases/gone', title: '中瑞世联工作空间' }], dirs: [] })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(resolved.ok, false, '目录不存在就不能采用，否则审核产物写不进去')
  assert.equal(resolved.path, '')
})

test('resolveAuditWorkspace never silently switches when the chosen directory is gone', async () => {
  // 用户报障的另一半：选过的目录没了，插件会**悄悄**换成清单偏好里的另一个工作空间 ——
  // 产物就写进别的目录了，而用户以为自己还在原来那儿。正确行为是停下来问一句。
  const ctx = workspaceCtx({
    entries: [{ id: 'w-manifest', path: '/cases/manifest', title: '中瑞世联工作空间' }],
    dirs: ['/cases/manifest'],
    files: { '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ workspacePath: '/cases/gone', workspaceSource: 'manual' }) },
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(resolved.ok, false, '目录没了就不能采用')
  assert.equal(resolved.missing, true, '要如实报「选过的那个不见了」')
  assert.equal(resolved.path, '/cases/gone', '路径必须留着，界面才能说清是哪一个')
  assert.notEqual(resolved.path, '/cases/manifest', '绝不回落到清单偏好：那是静默换工作空间')
})

test('resolveAuditWorkspace restores the whole saved selection, not just the path', async () => {
  // 只恢复 path 的话，重启后 source 会从 'manual' 变成 'saved'：界面标签变样，
  // 且 canAuto 变 false ——「恢复自动识别」按钮会凭空消失（用户报的「每次进来都变」）。
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/a', title: '注册表里的标题' }],
    dirs: ['/cases/a'],
    files: {
      '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({
        workspacePath: '/cases/a',
        workspaceTitle: '我起的名字',
        workspaceId: 'w-from-disk',
        workspaceSource: 'manual',
      }),
    },
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '别的', preferPath: '' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.missing, false)
  assert.equal(resolved.title, '我起的名字', '标题按落盘的用')
  assert.equal(resolved.id, 'w-from-disk', 'id 按落盘的用')
  assert.equal(resolved.source, 'manual', '来源原样恢复，标签与按钮才不会变样')
})

test('resolveAuditWorkspace treats a legacy file without source as the previous choice', async () => {
  // 老状态文件只存了 workspacePath：这时按「上次选择」显示，行为与今天一致。
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/a', title: 'A' }],
    dirs: ['/cases/a'],
    files: { '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ workspacePath: '/cases/a' }) },
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '', preferPath: '' })
  assert.equal(resolved.source, 'saved')
  assert.equal(resolved.title, 'A', '落盘没标题时退回注册表里的标题')
})

test('ensureWorkspace restores the saved choice wholesale and reports a missing one', async () => {
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/a', title: 'A' }],
    dirs: ['/cases/a'],
    files: {
      '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({
        workspacePath: '/cases/a', workspaceTitle: '我的案例根', workspaceId: 'w1', workspaceSource: 'manual',
      }),
    },
  })
  const restored = makeState()
  await ensureWorkspace(ctx, '/Users/x', restored, { preferTitle: '别的', preferPath: '' })
  assert.equal(restored.workspaceChosen, true)
  assert.equal(restored.workspacePath, '/cases/a')
  assert.equal(restored.workspaceTitle, '我的案例根')
  assert.equal(restored.workspaceSource, 'manual', '重启后「恢复自动识别」按钮必须还在')
  assert.equal(restored.caseRoot, '/cases/a')
  assert.equal(restored.workspaceMissing, false)

  // 目录没了：只置 missing，绝不采用清单偏好那个。
  const gone = makeState()
  const goneCtx = workspaceCtx({
    entries: [{ id: 'w2', path: '/cases/manifest', title: '中瑞世联工作空间' }],
    dirs: ['/cases/manifest'],
    files: { '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({ workspacePath: '/cases/gone', workspaceSource: 'manual' }) },
  })
  await ensureWorkspace(goneCtx, '/Users/x', gone, { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(gone.workspaceMissing, true)
  assert.equal(gone.workspaceChosen, false)
  assert.equal(gone.workspacePath, '/cases/gone')
  assert.equal(gone.caseRoot, '', '不能拿一个不存在的目录当案例根目录')
})

test('resolveAuditWorkspace never adopts the parent session cwd', async () => {
  // 父会话常常开在源码仓库里；采用它会把审核产物写进代码仓库。这是硬规则。
  const ctx = workspaceCtx({
    entries: [{ id: 'repo', path: '/Users/x/code/crwu-ai', title: 'crwu-ai' }],
    dirs: ['/Users/x/code/crwu-ai'],
    sessions: { get: () => ({ header: { cwd: '/Users/x/code/crwu-ai' } }) },
  })
  const resolved = await resolveAuditWorkspace(ctx, '/Users/x', { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(resolved.ok, false)
})

test('ensureWorkspace adopts once and never overwrites the user choice', async () => {
  const ctx = workspaceCtx({
    entries: [{ id: 'w1', path: '/cases/a', title: '中瑞世联工作空间' }],
    dirs: ['/cases/a'],
    files: { '/Users/x/.dsh/crwu-workbench.json': '{}' },
  })
  const state = makeState()
  await ensureWorkspace(ctx, '/Users/x', state, { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(state.workspaceChosen, true)
  assert.equal(state.workspacePath, '/cases/a')
  assert.equal(state.workspaceId, 'w1')
  assert.equal(state.caseRoot, '/cases/a', 'caseRoot 跟着采用的工作空间走')

  // 用户随后手动换到别处 → 再自检不得覆盖。
  state.workspacePath = '/cases/other'
  state.workspaceId = 'manual'
  await ensureWorkspace(ctx, '/Users/x', state, { preferTitle: '中瑞世联工作空间', preferPath: '' })
  assert.equal(state.workspacePath, '/cases/other')
  assert.equal(state.workspaceId, 'manual')
})

test('sessionWorkspaceInfo only reports and picks the longest matching prefix', () => {
  const ctx = workspaceCtx({
    entries: [
      { id: 'outer', path: '/cases', title: '外层' },
      { id: 'inner', path: '/cases/a', title: '内层' },
    ],
    sessions: { get: () => ({ header: { cwd: '/cases/a/sub' } }) },
  })
  const state = makeState({ parentSessionId: 'p1' })
  const info = sessionWorkspaceInfo(ctx, state)
  assert.equal(info.sessionCwd, '/cases/a/sub')
  assert.equal(info.workspaceId, 'inner', '取最长前缀，不是第一个命中')
  assert.equal(info.workspacePath, '/cases/a')
})

test('sessionWorkspaceInfo stays empty without a parent session or cwd', () => {
  const ctx = workspaceCtx({ entries: [{ id: 'w', path: '/cases', title: 'x' }] })
  assert.deepEqual(sessionWorkspaceInfo(ctx, makeState()), {
    parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '',
  })
  const noCwd = makeState({ parentSessionId: 'p1' })
  const info = sessionWorkspaceInfo({ get: () => ({}) }, noCwd)
  assert.equal(info.sessionCwd, '')
  assert.equal(info.workspaceId, '')
})

test('重启时不恢复"没落地过 childId"的 pending：退役它，也不恢复指向空 childId 的占用锁', async () => {
  // 用户第三轮复查的 P2：创建子会话失败且**回滚写盘也失败**时，磁盘上会留下 pending: true 的记录。
  // 重启时若原样恢复，它既没有可停的对象、又可能被当成"正在跑"。
  const fs = memoryFs({
    '/Users/x/.dsh/crwu-workbench.json': JSON.stringify({
      audits: {
        orphan: {
          key: 'orphan', childId: '', seqNo: 'S1', objectId: 'o1', parentSessionId: 'parent-1',
          casePath: '/cases/space/S1', attemptId: 'S1-a1-x', pending: true, status: 'running',
          ended: false, stopped: false,
        },
      },
      activeKey: 'orphan',
      activeChildId: '',
    }),
  })
  const state = makeState()
  await ensureRegistry(regDeps(fs.ctx, state))
  const record = state.audits.orphan
  assert.notEqual(record, undefined, '记录本身保留（万一那个孩子还活着，面板类 Tool 仍要拒绝它）')
  assert.equal(record.retired, true, '退役：不发放任何 scope')
  assert.equal(record.status, 'unknown')
  assert.equal(state.activeChildId, '', '不许把指向空 childId 的锁恢复回来')
  assert.equal(state.activeKey, '')
})
