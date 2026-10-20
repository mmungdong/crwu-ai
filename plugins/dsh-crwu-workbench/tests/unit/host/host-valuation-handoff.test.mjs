/**
 * 房地产估值 **资料归档预览 + 幂等父会话交接**（计划 Task 2）的关键失败断言。
 *
 * 这一层决定两件事，而且两件都"错了会静默"：
 *
 * 1. **界面确认的到底是哪一批字节**。所以预览必须按字节复制、**对归档副本重算 sha256**
 *    （源文件自报的 digest 不算数）、并把摘要落在"有序文件清单 + 方法 + 基准日 + 补充要求 +
 *    Schema 版本"上；原始绝对路径只回显给面板，**不进摘要**。
 * 2. **双击 / 超时重试不会建出第二条父会话**。所以交接是 `pending → created → dispatched`
 *    的持久化状态机，同一 requestId 互斥、同一预览只能成功交接一次。
 *
 * 全程内存替身 + 真实临时目录里的**源文件**：不访问网络、不碰真实员工资料。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url)
const { VALUATION_INPUT_SCHEMA_VERSION } = await import(new URL('src/shared/contracts/valuation-project.ts', ROOT).href)

const { preparePreview, PreviewRegistry, VALUATION_PREVIEW_TTL_MS } = await import(
  new URL('src/host/domains/report-evaluation/intake/preview.ts', ROOT).href)
const { materialFileId, archiveNameOf } = await import(
  new URL('src/host/domains/report-evaluation/intake/metadata.ts', ROOT).href)
const { HandoffStore, HANDOFF_RECORD_FILE } = await import(
  new URL('src/host/domains/report-evaluation/execution/handoff-store.ts', ROOT).href)
const { handoffProject } = await import(
  new URL('src/host/operations/report-evaluation/handoff.ts', ROOT).href)
const { scanSelection, nodeLocalAuditFs } = await import(
  new URL('src/host/domains/local-audit/scan.ts', ROOT).href)
const { MAX_MATERIAL_FILES } = await import(
  new URL('src/host/domains/report-evaluation/project/contracts.ts', ROOT).href)
const { canonicalJson, digestOf } = await import(
  new URL('src/host/tools/common/snapshot.ts', ROOT).href)

/** 本文件造出来的临时目录，跑完统一删。 */
const TEMPS = []
test.after(() => {
  for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMPS.push(dir)
  return dir
}

/** 一个资料目录：`[[文件名, 内容], …]`。 */
function sourceDir(spec) {
  const dir = tempDir('crwu-valuation-src-')
  for (const [name, content] of spec) writeFileSync(join(dir, name), content)
  return dir
}

const NOW = new Date('2026-10-14T08:00:00.000Z')

/**
 * 内存替身：**源文件是真的**（扫描与读字节都走 node fs），归档副本与案例目录在内存里。
 *
 * 为什么源文件用真的：扫描算法（realpath 去重 / 符号链接不跟随 / 深度保护）是被复用的既有实现，
 * 用假文件清单去测它等于把被测对象换掉。归档侧用内存则让"篡改归档副本"这类断言一句话就能写。
 */
function makeHarness() {
  let currentMs = NOW.getTime()
  const clock = () => new Date(currentMs)
  const workspace = tempDir('crwu-valuation-ws-')
  const archive = new Map()
  const dirs = new Set()
  const previews = new PreviewRegistry()
  const persisted = []
  const createdSessions = []
  const dispatchedPrompts = []
  const appliedMessages = new Set()
  const written = new Map()
  const scopes = []
  const hooks = { missingTools: [], failFirstDispatch: false, handedOff: [] }
  let minted = 0

  const readArchiveBytes = async (path) => {
    const bytes = archive.get(path)
    if (bytes === undefined) throw new Error(`归档副本不存在：${path}`)
    return new Uint8Array(bytes)
  }

  const previewDeps = {
    previews,
    scan: (selection) => scanSelection(selection, nodeLocalAuditFs()),
    canonicalPath: (path) => nodeLocalAuditFs().canonical(path),
    readSourceBytes: async (path) => new Uint8Array(readFileSync(path)),
    statSource: async (path) => {
      const info = statSync(path)
      return { createdAt: null, modifiedAt: info.mtime.toISOString(), readable: true }
    },
    ensureDirectories: async ({ projectDir, materialDir }) => {
      dirs.add(projectDir)
      dirs.add(materialDir)
      return { ok: true, error: '', errorKind: '' }
    },
    copyMaterial: async ({ sourcePath, archivePath }) => {
      const bytes = readFileSync(sourcePath)
      archive.set(archivePath, Buffer.from(bytes))
      return { ok: true, error: '', errorKind: '', sizeBytes: bytes.length }
    },
    readArchiveBytes,
    projectDirOf: (projectId) => `${workspace}/${projectId}`,
    mintProjectId: () => `估值-20261014-080000-${String(minted += 1).padStart(4, '0')}`,
    now: clock,
  }

  const store = new HandoffStore({
    now: clock,
    persist: async ({ projectId, content }) => {
      persisted.push({ projectId, content })
      return { ok: true, error: '' }
    },
  })

  const handoffDeps = {
    previews,
    store,
    // 来源策略（协议 39）：交接时**不是空数组** —— 配置里有哪些来源、各自必需还是可选
    // 必须先交给父会话，否则"未登录改用替代来源"这件事在指令里彻底消失。
    sources: [
      { id: 'lianjia', label: '链家', tier: 'optional', state: 'unknown', evidence: 'archived-capture', reason: '交接时尚未检查该来源的登录状态' },
      { id: 'fang', label: '房天下', tier: 'optional', state: 'unknown', evidence: 'public-pattern', reason: '可补充来源' },
    ],
    workspace: async () => ({ ok: true, error: '', workspaceId: 'w1', workspacePath: workspace }),
    createSession: async ({ title, source }) => {
      const sessionId = `session-${createdSessions.length + 1}`
      createdSessions.push({ title, source, sessionId })
      return { ok: true, error: '', sessionId, workspaceId: 'w1', workspacePath: workspace }
    },
    ensureProjectDirectory: async (path) => {
      dirs.add(path)
      return { ok: true, error: '', errorKind: '' }
    },
    writeProjectFile: async (path, content) => {
      written.set(path, content)
      return { ok: true, error: '', errorKind: '' }
    },
    readArchiveBytes,
    dispatch: async ({ sessionId, messageId, prompt }) => {
      // 真实 `followup` 用**稳定 messageId** 发同一条固定指令：同一指令不会被应用两次。
      if (appliedMessages.has(messageId)) return { accepted: true, error: '' }
      appliedMessages.add(messageId)
      dispatchedPrompts.push({ sessionId, messageId, prompt })
      if (hooks.failFirstDispatch && dispatchedPrompts.length === 1) {
        return { accepted: false, error: 'RPC 超时（可能已经受理）' }
      }
      return { accepted: true, error: '' }
    },
    bindScope: (scope) => { scopes.push(scope) },
    onHandoff: (receipt) => { hooks.handedOff.push(receipt) },
    missingTools: () => hooks.missingTools,
    projectPath: (projectId, relative) => `${workspace}/${projectId}/${relative}`,
    projectDirOf: (projectId) => `${workspace}/${projectId}`,
    now: clock,
  }

  return {
    workspace, archive, dirs, previews, persisted, createdSessions, dispatchedPrompts,
    appliedMessages, written, scopes, hooks, previewDeps, handoffDeps, store,
    advance(ms) { currentMs += ms },
  }
}

/** 一次预览的默认入参（协议 39 起 `assetType` 必填：没有资产类型就没有业务入口）。 */
function previewRequest(patch = {}) {
  return {
    requestId: 'req-1',
    paths: [],
    assetType: 'real-estate',
    method: 'market',
    baseDate: '',
    supplementalPrompt: '',
    ...patch,
  }
}

function handoffRequest(preview, patch = {}) {
  return {
    previewId: preview.previewId,
    confirmedInputDigest: preview.inputDigest,
    requestId: 'req-1',
    ...patch,
  }
}

test('removed automatic choices cannot prepare a frozen handoff', async () => {
  const h = makeHarness()
  const directory = sourceDir([['产权证.pdf', 'synthetic-property-material']])
  let frozen
  h.handoffDeps.onHandoff = (_receipt, input) => { frozen = input }
  for (const choices of [{ assetType: 'auto', method: 'market' }, { assetType: 'real-estate', method: 'auto' }]) {
    const preview = await preparePreview(previewRequest({ paths: [directory], ...choices }), h.previewDeps)
    assert.equal(preview.ok, false)
  }
  assert.equal(frozen, undefined)
})

test('an uploaded calculation template is archived once and its role changes the confirmed input digest', async () => {
  const h = makeHarness()
  const directory = sourceDir([['产权证.pdf', 'synthetic-property-material'], ['自定义计算表.xlsx', 'synthetic-template-bytes']])
  const templatePath = join(directory, '自定义计算表.xlsx')
  const preview = await preparePreview(previewRequest({ paths: [directory], templatePath }), h.previewDeps)
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.files.length, 2, 'the same selected file must not be archived twice')
  assert.ok(preview.templateFileId)
  const template = preview.files.find((file) => file.fileId === preview.templateFileId)
  assert.equal(template.fileName, '自定义计算表.xlsx')
  let frozen
  h.handoffDeps.onHandoff = (_receipt, input) => { frozen = input }
  assert.equal((await handoffProject(handoffRequest(preview), h.handoffDeps)).ok, true)
  assert.equal(frozen.templateFileId, template.fileId)
  assert.doesNotMatch(JSON.stringify(frozen), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const asMaterial = await preparePreview(previewRequest({ requestId: 'req-2', paths: [directory] }), h.previewDeps)
  assert.notEqual(preview.inputDigest, asMaterial.inputDigest, 'the approved template role belongs to the immutable input identity')
})

test('the uploaded template role matches the realpath deduplicated candidate', async () => {
  const h = makeHarness()
  const directory = sourceDir([['产权证.pdf', 'synthetic-property-material'], ['计算表.xlsx', 'synthetic-template-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [directory], templatePath: `${directory}/./计算表.xlsx` }), h.previewDeps)
  assert.equal(preview.ok, true, preview.error)
  assert.equal(preview.files.length, 2)
  assert.equal(preview.files.find((file) => file.fileId === preview.templateFileId)?.fileName, '计算表.xlsx')
})

test('a failed template canonicalization stops before archival without echoing its raw cause', async () => {
  const h = makeHarness()
  const directory = sourceDir([['计算表.xlsx', 'synthetic-template-bytes']])
  h.previewDeps.canonicalPath = async () => { throw new Error('Authorization: Bearer synthetic-secret') }
  const preview = await preparePreview(previewRequest({ paths: [directory], templatePath: join(directory, '计算表.xlsx') }), h.previewDeps)
  assert.equal(preview.ok, false)
  assert.equal(h.dirs.size, 0)
  assert.doesNotMatch(preview.error, /synthetic-secret|Authorization|Bearer/)
})

test('graph handoff dispatches the Host-minted command and stops before dispatch on registration failure', async () => {
  const h = makeHarness()
  const directory = sourceDir([['产权证.pdf', 'synthetic-property-material']])
  const preview = await preparePreview(previewRequest({ paths: [directory] }), h.previewDeps)
  h.handoffDeps.prepareHandoff = async ({ receipt, frozen }) => {
    assert.equal(receipt.projectId, preview.projectId)
    assert.equal(frozen.inputDigest, preview.inputDigest)
    assert.ok(h.written.size > 0)
    return { ok: true, prompt: '调用 crwu_valuation_workflow_run，commandId=opaque-command-only' }
  }
  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, true, result.error)
  assert.equal(h.dispatchedPrompts[0].prompt, '调用 crwu_valuation_workflow_run，commandId=opaque-command-only')
  const other = makeHarness()
  const next = await preparePreview(previewRequest({ paths: [directory] }), other.previewDeps)
  other.handoffDeps.prepareHandoff = async () => ({ ok: false, error: '合成图登记失败', prompt: '' })
  const refused = await handoffProject(handoffRequest(next), other.handoffDeps)
  assert.equal(refused.ok, false)
  assert.equal(other.dispatchedPrompts.length, 0)
  assert.equal(other.createdSessions.length, 1)
})

// ── 元信息与归档改名 ────────────────────────────────────────────────────────

test('归档改名与 fileId：同名不同路径得到两条可分辨的记录', () => {
  assert.equal(materialFileId(1), 'material-001')
  assert.equal(materialFileId(12), 'material-012')

  const taken = new Set()
  assert.equal(archiveNameOf('报告.pdf', taken), '报告.pdf')
  taken.add('报告.pdf')
  assert.equal(archiveNameOf('报告.pdf', taken), '报告-2.pdf')
  taken.add('报告-2.pdf')
  assert.equal(archiveNameOf('报告.pdf', taken), '报告-3.pdf')
  // 没有扩展名 / 前导点的文件名也要有确定结果（不许产出空名或 `-2` 这种尾巴）。
  assert.equal(archiveNameOf('无扩展名', new Set(['无扩展名'])), '无扩展名-2')
  assert.equal(archiveNameOf('.gitignore', new Set(['.gitignore'])), '.gitignore-2')
})

// ── 份数与扫描边界 ──────────────────────────────────────────────────────────

test('资料份数：达到上限通过；上限 +1 **整批阻止**且一份都不复制', async () => {
  const h = makeHarness()
  const pass = MAX_MATERIAL_FILES
  const full = sourceDir(Array.from({ length: pass }, (_, index) => [`f${index}.pdf`, `bytes-${index}`]))
  const ok = await preparePreview(previewRequest({ paths: [full] }), h.previewDeps)
  assert.equal(ok.ok, true, ok.error)
  assert.equal(ok.files.length, pass)
  assert.equal(ok.fileCount, pass)
  assert.equal(ok.overLimit, false)
  assert.equal(h.archive.size, pass, '通过的那一批要真的归档')

  const h2 = makeHarness()
  const over = pass + 1
  const overflow = sourceDir(Array.from({ length: over }, (_, index) => [`f${index}.pdf`, `bytes-${index}`]))
  const blocked = await preparePreview(previewRequest({ requestId: 'req-over', paths: [overflow] }), h2.previewDeps)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.errorKind, 'input-invalid')
  assert.match(blocked.error, new RegExp(String(over)))
  assert.match(blocked.error, new RegExp(String(pass)))
  assert.equal(h2.archive.size, 0, '超过上限不许悄悄复制前若干份')
  assert.equal(h2.createdSessions.length, 0)
})

test('explicit empty directories and zero-byte files fail; intentional no-material intake succeeds', async () => {
  const h = makeHarness()
  const empty = sourceDir([])
  const noFiles = await preparePreview(previewRequest({ paths: [empty] }), h.previewDeps)
  assert.equal(noFiles.ok, false)
  assert.equal(noFiles.errorKind, 'input-invalid')
  assert.match(noFiles.error, /没有可读取的普通文件/)

  const noSelection = await preparePreview(previewRequest({ paths: [], requestId: 'req-none' }), h.previewDeps)
  assert.equal(noSelection.ok, true, noSelection.error)
  assert.deepEqual(noSelection.files, [])
  assert.equal(noSelection.fileCount, 0)

  const allEmpty = sourceDir([['a.pdf', ''], ['b.pdf', '']])
  const blank = await preparePreview(previewRequest({ requestId: 'req-blank', paths: [allEmpty] }), h.previewDeps)
  assert.equal(blank.ok, false)
  assert.match(blank.error, /空文件/)
  assert.equal(h.archive.size, 0, '一份空文件都不该被归档')
})

test('重叠入口不重复计数：同一个真实文件经目录与它本身进来只算一次', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a'], ['b.pdf', 'b']])
  const result = await preparePreview(
    previewRequest({ paths: [dir, join(dir, 'a.pdf')] }), h.previewDeps)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.files.map((file) => file.fileName).sort(), ['a.pdf', 'b.pdf'])
})

test('同名不同路径保留两条：归档按 -2 改名，fileId 能分辨', async () => {
  const h = makeHarness()
  const first = sourceDir([['报告.pdf', 'a-bytes']])
  const second = sourceDir([['报告.pdf', 'b-bytes']])
  const result = await preparePreview(
    previewRequest({ paths: [first, second] }), h.previewDeps)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.files.map((file) => file.fileName), ['报告.pdf', '报告.pdf'])
  assert.deepEqual(
    result.files.map((file) => file.archiveRelativePath),
    ['材料-源/报告.pdf', '材料-源/报告-2.pdf'],
  )
  assert.notEqual(result.files[0].fileId, result.files[1].fileId)
  assert.equal(h.archive.has(`${result.casePath}/材料-源/报告-2.pdf`), true, '第二条要真的归档到改名后的路径')
})

test('不同路径字节完全相同 → 标 duplicateOf 并保留来源关系（两条都在）', async () => {
  const h = makeHarness()
  const first = sourceDir([['a.pdf', 'same-bytes']])
  const second = sourceDir([['b.pdf', 'same-bytes']])
  const result = await preparePreview(previewRequest({ paths: [first, second] }), h.previewDeps)
  assert.equal(result.files.length, 2, '内容相同也要保留两条（来源关系不能丢）')
  assert.equal(result.files[0].duplicateOf, null)
  assert.equal(result.files[1].duplicateOf, result.files[0].fileId)
  assert.equal(result.files[1].sha256, result.files[0].sha256)
})

test('指纹按**归档副本**重算：源文件自报的 digest 不算数', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'real-bytes']])
  // 复制命令"成功"但落进去的是别的字节：这种副本必须被指纹校验拦下。
  h.previewDeps.copyMaterial = async ({ archivePath }) => {
    h.archive.set(archivePath, Buffer.from('tampered-copy'))
    return { ok: true, error: '', errorKind: '', sizeBytes: 14 }
  }
  const result = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'infrastructure')
  assert.match(result.error, /归档副本与源文件不一致/)
})

// ── 元信息与摘要 ────────────────────────────────────────────────────────────

test('元信息逐条完整；createdAt 取不到时是 null（不许拿 mtime 冒充）', async () => {
  const h = makeHarness()
  const dir = sourceDir([['估值报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  assert.equal(preview.ok, true, preview.error)
  for (const field of [
    'fileId', 'fileName', 'absolutePath', 'archiveRelativePath', 'kind',
    'sizeBytes', 'sha256', 'createdAt', 'modifiedAt', 'readable', 'duplicateOf',
  ]) {
    assert.equal(field in preview.files[0], true, `元信息缺少 ${field}`)
  }
  assert.equal(preview.files[0].kind, 'pdf')
  assert.equal(preview.files[0].sizeBytes, 9)
  assert.match(preview.files[0].sha256, /^sha256:[0-9a-f]{64}$/)
  // 关键断言：birthtime 拿不到 → null（显示"创建时间未知"），**绝不**用 mtime 顶上。
  assert.equal(preview.files[0].createdAt, null)
  assert.equal(typeof preview.files[0].modifiedAt, 'string')
})

test('birthtime 可用时原样回显（不是恒 null）', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a']])
  h.previewDeps.statSource = async () => ({
    createdAt: '2026-01-02T03:04:05.000Z', modifiedAt: '2026-05-06T07:08:09.000Z', readable: true,
  })
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  assert.equal(preview.files[0].createdAt, '2026-01-02T03:04:05.000Z')
})

test('输入摘要只覆盖资产类型 + 有序清单 + 方法 + 基准日 + 补充要求 + Schema 版本；绝对路径不进摘要', async () => {
  const h1 = makeHarness()
  const h2 = makeHarness()
  const dirA = sourceDir([['报告.pdf', 'same-bytes']])
  const dirB = sourceDir([['报告.pdf', 'same-bytes']])
  const request = { method: 'market', baseDate: '2026-06-30', supplementalPrompt: '请多考虑地铁因素' }

  const one = await preparePreview(previewRequest({ ...request, requestId: 'a', paths: [dirA] }), h1.previewDeps)
  const two = await preparePreview(previewRequest({ ...request, requestId: 'a', paths: [dirB] }), h2.previewDeps)
  assert.equal(one.ok, true, one.error)
  assert.equal(one.inputDigest, two.inputDigest, '同一批字节来自不同绝对路径，摘要必须相同')

  // 面板拿得到原始绝对路径（只回显给员工本人）。
  assert.equal(one.files[0].absolutePath, join(dirA, '报告.pdf'))

  // 独立重算一次：把摘要公式钉死在测试里（加进 absolutePath 就会立刻红）。
  const expected = digestOf([canonicalJson({
    schemaVersion: VALUATION_INPUT_SCHEMA_VERSION,
    assetType: 'real-estate',
    methodRequest: 'market',
    baseDate: '2026-06-30',
    // P16：评估目的与价值类型也进摘要（未指定是 `null`）。
    purpose: null,
    valueType: null,
    templateFileId: null,
    supplementalPrompt: '请多考虑地铁因素',
    files: one.files.map((file) => ({
      fileId: file.fileId,
      fileName: file.fileName,
      archiveRelativePath: file.archiveRelativePath,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      duplicateOf: file.duplicateOf,
    })),
  })])
  assert.equal(one.inputDigest, expected)

  // 条件变了摘要就变（逐项）。
  const otherMethod = await preparePreview(
    previewRequest({ ...request, requestId: 'b', method: 'income', paths: [sourceDir([['报告.pdf', 'same-bytes']])] }), h1.previewDeps)
  assert.notEqual(otherMethod.inputDigest, one.inputDigest, '方法必须进摘要')
  const otherDate = await preparePreview(
    previewRequest({ ...request, requestId: 'c', baseDate: '2026-06-29', paths: [sourceDir([['报告.pdf', 'same-bytes']])] }), h1.previewDeps)
  assert.notEqual(otherDate.inputDigest, one.inputDigest, '基准日必须进摘要')
  const otherPrompt = await preparePreview(
    previewRequest({ ...request, requestId: 'd', supplementalPrompt: '别的', paths: [sourceDir([['报告.pdf', 'same-bytes']])] }), h1.previewDeps)
  assert.notEqual(otherPrompt.inputDigest, one.inputDigest, '补充要求必须进摘要')
  // 资产类型也是用户确认过的输入：换了它摘要必须变，否则"换了资产还按旧摘要启动"拦不住。
  const otherAsset = await preparePreview(
    previewRequest({ ...request, requestId: 'e', assetType: 'real-estate', paths: [sourceDir([['报告.pdf', 'same-bytes']])] }), h1.previewDeps)
  assert.equal(otherAsset.inputDigest, one.inputDigest, '同一资产类型摘要不变')
  const noAsset = await preparePreview(
    previewRequest({ ...request, requestId: 'f', assetType: '', paths: [sourceDir([['报告.pdf', 'same-bytes']])] }), h1.previewDeps)
  assert.equal(noAsset.ok, false, '未选资产类型必须被拒绝（没有默认房地产这一档）')
  assert.match(noAsset.error, /资产类型/)
  assert.equal(one.baseDate, '2026-06-30')
})

test('清单是**有序**的：选择顺序变了摘要就变', async () => {
  const h = makeHarness()
  const dirA = sourceDir([['a.pdf', 'a']])
  const dirB = sourceDir([['b.pdf', 'b']])
  const forward = await preparePreview(previewRequest({ requestId: 'fwd', paths: [dirA, dirB] }), h.previewDeps)
  const backward = await preparePreview(previewRequest({ requestId: 'bwd', paths: [dirB, dirA] }), h.previewDeps)
  assert.deepEqual(forward.files.map((file) => file.fileName), ['a.pdf', 'b.pdf'])
  assert.deepEqual(backward.files.map((file) => file.fileName), ['b.pdf', 'a.pdf'])
  assert.notEqual(forward.inputDigest, backward.inputDigest)
})

test('基准日空串归一化为 null；不存在的日期（2026-02-30）被拒', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a']])
  const blank = await preparePreview(previewRequest({ requestId: 'blank', paths: [dir] }), h.previewDeps)
  assert.equal(blank.baseDate, null, '未指定基准日是 null，不是空串、更不是今天')

  const impossible = await preparePreview(
    previewRequest({ requestId: 'feb30', paths: [dir], baseDate: '2026-02-30' }), h.previewDeps)
  assert.equal(impossible.ok, false)
  assert.equal(impossible.errorKind, 'input-invalid')
  assert.match(impossible.error, /不存在的日期|不是一个存在的日期/)
  assert.equal(h.archive.size, 1, '只有第一次（合法）的那一份被归档')
})

test('方法非法 / 补充要求超长 —— 都在建任何东西之前拒绝', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a']])
  const badMethod = await preparePreview(
    previewRequest({ requestId: 'm', paths: [dir], method: '瞎猜' }), h.previewDeps)
  assert.equal(badMethod.ok, false)
  assert.match(badMethod.error, /评估方法不合法/)

  const tooLong = await preparePreview(
    previewRequest({ requestId: 'l', paths: [dir], supplementalPrompt: 'x'.repeat(4001) }), h.previewDeps)
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.error, /4000/)
  assert.equal(h.archive.size, 0)
})

test('同一 requestId 重复准备预览是幂等的：不新建项目目录、不重复归档', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a']])
  const first = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  const second = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  assert.equal(first.previewId, second.previewId)
  assert.equal(first.inputDigest, second.inputDigest)
  assert.equal(h.archive.size, 1)
  assert.equal(h.previews.size, 1)
})

// ── 交接：幂等、互斥与失败语义 ──────────────────────────────────────────────

test('并发两次 handoffProject（双击）只建 1 个会话、只发 1 条指令', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  const request = handoffRequest(preview)

  const [first, second] = await Promise.all([
    handoffProject(request, h.handoffDeps),
    handoffProject(request, h.handoffDeps),
  ])

  assert.equal(first.ok, true, first.error)
  assert.equal(second.ok, true, second.error)
  assert.equal(h.createdSessions.length, 1, '双击不许建第二条父会话')
  assert.equal(h.dispatchedPrompts.length, 1, '双击不许发两条指令')
  assert.equal(first.parentSessionId, second.parentSessionId)
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(h.store.get('req-1').state, 'dispatched')
})

test('交接后用另一个 requestId 再来一次：同一预览只能成功交接一次', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  const first = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(first.ok, true, first.error)

  const again = await handoffProject(
    handoffRequest(preview, { requestId: 'req-2' }), h.handoffDeps)
  assert.equal(again.ok, false)
  assert.equal(again.errorKind, 'conflict')
  assert.equal(h.createdSessions.length, 1)

  // 同一个 requestId 重放：复用同一条会话（不再建会话、不再发指令）。
  const replay = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(replay.ok, true, replay.error)
  assert.equal(replay.reused, true)
  assert.equal(replay.parentSessionId, first.parentSessionId)
  assert.equal(h.createdSessions.length, 1)
  assert.equal(h.dispatchedPrompts.length, 1)
})

test('缺 confirmedInputDigest / 摘要不一致 —— 结构化失败，不抛裸错误', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  const missing = await handoffProject(handoffRequest(preview, { confirmedInputDigest: '' }), h.handoffDeps)
  assert.equal(missing.ok, false)
  assert.equal(missing.errorKind, 'input-invalid')
  assert.match(missing.error, /confirmedInputDigest|缺少确认摘要/)

  const changed = await handoffProject(
    handoffRequest(preview, { confirmedInputDigest: 'sha256:别的' }), h.handoffDeps)
  assert.equal(changed.ok, false)
  assert.equal(changed.errorKind, 'conflict')
  assert.match(changed.error, /重新确认/)
  assert.equal(h.createdSessions.length, 0, '摘要对不上不许建会话')

  // 失败一次不能把这个预览锁死：拿正确的摘要重试仍然能成功（临时认领已经释放）。
  assert.equal(h.store.size, 0, '没建出会话的失败认领必须被丢掉，不许把 preview 挡成"已交接"')
  const retry = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(retry.ok, true, retry.error)
  assert.equal(h.createdSessions.length, 1)
})

test('预览不存在 / 已过期 —— 都要重新确认，且不建会话', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  const ghost = await handoffProject(
    { previewId: '估值-不存在', confirmedInputDigest: preview.inputDigest, requestId: 'r-ghost' }, h.handoffDeps)
  assert.equal(ghost.ok, false)
  assert.equal(ghost.errorKind, 'not-found')

  h.advance(VALUATION_PREVIEW_TTL_MS + 1)
  const expired = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(expired.ok, false)
  assert.equal(expired.errorKind, 'not-found')
  assert.equal(expired.recoveryAction, 'refresh-preview')
  assert.match(expired.error, /过期/)
  assert.equal(h.createdSessions.length, 0)
})

test('an expired preview cannot relabel a created parent as not created or create another parent', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  h.hooks.failFirstDispatch = true
  const first = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(first.creationDisposition, 'created')
  h.advance(VALUATION_PREVIEW_TTL_MS + 1)
  const recovered = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(recovered.ok, true, recovered.error)
  assert.equal(recovered.parentSessionId, first.parentSessionId)
  assert.equal(recovered.reused, true)
  assert.equal(h.createdSessions.length, 1)
})

test('losing a preview after parent creation keeps the actual parent identity occupied', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  h.hooks.failFirstDispatch = true
  const first = await handoffProject(handoffRequest(preview), h.handoffDeps)
  h.previews.drop(preview.previewId)
  const retry = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(retry.ok, false)
  assert.equal(retry.creationDisposition, 'created')
  assert.equal(retry.parentSessionId, first.parentSessionId)
  assert.notEqual(retry.recoveryAction, 'refresh-preview')
  assert.equal(h.createdSessions.length, 1)
  const later = await Promise.race([
    handoffProject(handoffRequest(preview), h.handoffDeps),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 40)),
  ])
  assert.notEqual(later.timedOut, true, 'a missing preview must settle its claimed request instead of hanging the next retry')
  assert.equal(later.parentSessionId, first.parentSessionId)
})

test('an already dispatched handoff remains idempotent after preview expiry', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  const first = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(first.ok, true, first.error)
  h.advance(VALUATION_PREVIEW_TTL_MS + 1)
  const repeated = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(repeated.ok, true, repeated.error)
  assert.equal(repeated.parentSessionId, first.parentSessionId)
  assert.equal(h.createdSessions.length, 1)
  assert.equal(h.dispatchedPrompts.length, 1)
})

test('归档副本被篡改 → 强制重新确认（绝不按旧摘要启动）', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  assert.equal(preview.ok, true, preview.error)

  // 案例目录里的归档副本被改（估值会话对案例目录有写权限，这就是真实威胁）。
  const archivePath = `${preview.casePath}/材料-源/报告.pdf`
  h.archive.set(archivePath, Buffer.from('tampered-bytes'))

  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'conflict')
  assert.match(result.error, /重新确认/)
  assert.match(result.error, /不一样/)
  assert.equal(h.createdSessions.length, 0, '归档被改过就不许启动')
  assert.equal(h.written.size, 0, '也不许写冻结输入')
})

test('预览之后源文件被改动**不影响**已归档输入（归档副本才是输入）', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const sourcePath = join(dir, '报告.pdf')
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  // 员工在确认之前又改了源文件（或被别的东西改了）。
  writeFileSync(sourcePath, 'changed-after-preview')

  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, true, result.error)

  const frozen = JSON.parse(h.written.get(h.handoffDeps.projectPath(result.projectId, '估值输入.json')))
  assert.equal(frozen.inputDigest, preview.inputDigest)
  assert.equal(frozen.files[0].sha256, preview.files[0].sha256)
  assert.equal(frozen.schemaVersion, VALUATION_INPUT_SCHEMA_VERSION)
})

test('发送已受理但 RPC 超时：重试复用同一个 parentSessionId（reused:true），只建 1 个会话', async () => {
  const h = makeHarness()
  h.hooks.failFirstDispatch = true
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  const first = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(first.ok, false, '发送没被确认就不能报成功')
  assert.equal(first.errorKind, 'infrastructure')
  assert.notEqual(first.parentSessionId, '')
  assert.equal(first.dispatchAccepted, false)
  assert.equal(h.createdSessions.length, 1)
  // 会话已经建好，所以记录停在 created（重试要复用它，而不是再建一条）。
  assert.equal(h.store.get('req-1').state, 'created')

  const retry = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(retry.ok, true, retry.error)
  assert.equal(retry.parentSessionId, first.parentSessionId, '重试必须复用同一条父会话')
  assert.equal(retry.reused, true)
  assert.equal(h.createdSessions.length, 1, '重试不许再建会话')
  assert.equal(h.dispatchedPrompts.length, 1, '固定指令用稳定 messageId，不许被应用两次')
  assert.equal(h.store.get('req-1').state, 'dispatched')
})

test('交接成功后：冻结输入与交接清单落盘、scope 绑定、状态机 pending→created→dispatched', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(
    previewRequest({ paths: [dir], supplementalPrompt: '请多考虑地铁因素' }), h.previewDeps)
  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, true, result.error)

  // ① 状态机每一步都持久化（原子：内存只在落盘成功之后前进）。
  const states = h.persisted.map((item) => JSON.parse(item.content).state)
  assert.deepEqual(states, ['pending', 'created', 'dispatched'])
  for (const item of h.persisted) assert.equal(item.projectId, result.projectId)

  // ② 冻结输入（v2）：没有原始绝对路径，摘要与预览一致。
  const frozen = JSON.parse(h.written.get(h.handoffDeps.projectPath(result.projectId, '估值输入.json')))
  assert.equal(frozen.schemaVersion, VALUATION_INPUT_SCHEMA_VERSION)
  assert.equal(frozen.projectId, result.projectId)
  assert.equal(frozen.methodRequest, 'market')
  assert.equal(frozen.baseDate, null)
  assert.equal(frozen.supplementalPrompt, '请多考虑地铁因素')
  assert.equal(frozen.inputDigest, preview.inputDigest)
  for (const forbidden of ['absolutePath', h.workspace, dir]) {
    assert.equal(JSON.stringify(frozen).includes(forbidden), false, `冻结输入里不该出现 ${forbidden}`)
  }

  // ③ 交接清单：只留 fileId 与相对路径，同样没有绝对路径。
  const manifest = JSON.parse(h.written.get(h.handoffDeps.projectPath(result.projectId, '交接清单.json')))
  assert.equal(manifest.parentSessionId, result.parentSessionId)
  assert.equal(manifest.inputDigest, preview.inputDigest)
  assert.equal(manifest.files.length, 1)
  assert.equal(JSON.stringify(manifest).includes(h.workspace), false)

  // ④ scope 绑定（父会话按会话 id 逐字归属本轮案例目录）。
  assert.equal(h.scopes.length, 1)
  assert.equal(h.scopes[0].casePath, preview.casePath)
  assert.equal(h.scopes[0].sessionId, result.parentSessionId)

  // ⑤ 固定指令发给父会话，且带着案例目录与项目 id。
  const prompt = h.dispatchedPrompts[0].prompt
  assert.match(prompt, new RegExp(result.projectId))
  assert.equal(h.dispatchedPrompts[0].sessionId, result.parentSessionId)

  // ⑥ 交接回执通知宿主（轮次记录等）。
  assert.equal(h.hooks.handedOff.length, 1)
  assert.equal(h.hooks.handedOff[0].projectId, result.projectId)
})

test('P16：评估目的与价值类型进预览、进摘要、进冻结输入、进固定指令', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const stated = await preparePreview(previewRequest({
    requestId: 'purpose', paths: [dir],
    purpose: '司法拍卖处置参考', valueType: '市场价值',
  }), h.previewDeps)
  assert.equal(stated.ok, true, stated.error)
  assert.equal(stated.purpose, '司法拍卖处置参考')
  assert.equal(stated.valueType, '市场价值')

  // 未填就是 `null`（未指定），不是空串、更不是默认的某种正式价值结论。
  const h2 = makeHarness()
  const blank = await preparePreview(previewRequest({ requestId: 'blank-purpose', paths: [dir] }), h2.previewDeps)
  assert.equal(blank.purpose, null, '未指定评估目的就是 null')
  assert.equal(blank.valueType, null, '未指定价值类型就是 null')

  // 两个字段进摘要：改了它们摘要必须变（否则"条件变了还按旧摘要启动"拦不住）。
  const other = await preparePreview(previewRequest({
    requestId: 'purpose-2', paths: [dir],
    purpose: '抵押', valueType: '市场价值',
  }), h.previewDeps)
  assert.notEqual(other.inputDigest, stated.inputDigest, '评估目的必须进摘要')
  const otherType = await preparePreview(previewRequest({
    requestId: 'purpose-3', paths: [dir],
    purpose: '司法拍卖处置参考', valueType: '投资价值',
  }), h.previewDeps)
  assert.notEqual(otherType.inputDigest, stated.inputDigest, '价值类型必须进摘要')
  const same = await preparePreview(previewRequest({
    requestId: 'purpose-4', paths: [dir],
    purpose: '司法拍卖处置参考', valueType: '市场价值',
  }), h.previewDeps)
  assert.equal(same.inputDigest, stated.inputDigest, '同样的条件必须得到同一个摘要')

  // 冻结输入与固定指令都要带上：子会话不许自己猜"这一轮是为了什么"。
  const preview = await preparePreview(previewRequest({
    requestId: 'handoff-purpose', paths: [dir],
    purpose: '司法拍卖处置参考', valueType: '市场价值',
  }), h.previewDeps)
  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, true, result.error)
  const frozen = JSON.parse(h.written.get(h.handoffDeps.projectPath(result.projectId, '估值输入.json')))
  assert.equal(frozen.purpose, '司法拍卖处置参考')
  assert.equal(frozen.valueType, '市场价值')
  const prompt = h.dispatchedPrompts[0].prompt
  assert.match(prompt, /司法拍卖处置参考/)
  assert.match(prompt, /市场价值/)
})

test('P16：未指定评估目的/价值类型时，固定指令不许据此声称正式完成', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ requestId: 'blank-handoff', paths: [dir] }), h.previewDeps)
  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, true, result.error)
  const frozen = JSON.parse(h.written.get(h.handoffDeps.projectPath(result.projectId, '估值输入.json')))
  assert.equal(frozen.purpose, null)
  assert.equal(frozen.valueType, null)
  const prompt = h.dispatchedPrompts[0].prompt
  assert.match(prompt, /本次未指定评估目的/)
  assert.match(prompt, /本次未指定价值类型/)
})

test('P16：超长的评估目的/价值类型被拒，且**在建任何东西之前**', async () => {
  const h = makeHarness()
  const dir = sourceDir([['a.pdf', 'a']])
  for (const [key, requestId] of [['purpose', 'long-purpose'], ['valueType', 'long-value-type']]) {
    const bad = await preparePreview(previewRequest({
      requestId, paths: [dir], [key]: 'x'.repeat(401),
    }), h.previewDeps)
    assert.equal(bad.ok, false, `${key} 超长必须被拒`)
    assert.equal(bad.errorKind, 'input-invalid')
  }
  assert.equal(h.archive.size, 0, '被拒的请求一份都不复制')
  assert.equal(h.createdSessions.length, 0)
})

test('本轮要用的工具不可见 → 在**创建会话之前**拒绝', async () => {
  const h = makeHarness()
  h.hooks.missingTools = ['crwu_valuation_file_extract']
  const dir = sourceDir([['报告.pdf', 'pdf-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)

  const result = await handoffProject(handoffRequest(preview), h.handoffDeps)
  assert.equal(result.ok, false)
  assert.equal(result.errorKind, 'capability-gap')
  assert.match(result.error, /crwu_valuation_file_extract/)
  assert.equal(h.createdSessions.length, 0)
})

test('缺 requestId / previewId 时结构化拒绝（不抛裸错误）', async () => {
  const h = makeHarness()
  for (const bad of [
    { previewId: '', confirmedInputDigest: 'sha256:x', requestId: 'r' },
    { previewId: 'p', confirmedInputDigest: 'sha256:x', requestId: '' },
  ]) {
    const result = await handoffProject(bad, h.handoffDeps)
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'input-invalid')
    assert.equal(h.createdSessions.length, 0)
  }
})

test('交接记录落在项目目录里的固定文件名（Host 派生路径）', () => {
  assert.equal(HANDOFF_RECORD_FILE, '交接记录.json')
})

// ── 静态边界：预览与交接都不提取、不发网络、不拉知识 ──────────────────────

test('预览 / 交接层没有网络、提取、知识库或模型调用（结构边界）', async () => {
  const { readFile } = await import('node:fs/promises')
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const targets = [
    'src/host/domains/report-evaluation/intake/preview.ts',
    'src/host/domains/report-evaluation/intake/metadata.ts',
    'src/host/domains/report-evaluation/execution/handoff-store.ts',
    'src/host/operations/report-evaluation/handoff.ts',
  ]
  const banned = [
    'node:http', 'node:https', 'node:net', 'node:child_process',
    'fetch(', 'XMLHttpRequest', 'runExtraction', 'pythonFileExtractor',
    'resolveKnowledgePlan', 'materializeKnowledge',
  ]
  // 发固定指令是交接自己的职责（`followup` 只允许出现在交接那一个文件里）；
  // 预览与状态存储**一行模型调用都不许有**。
  const noModel = ['ctx.agents', 'followup', 'ctx.get(']
  for (const path of targets) {
    const code = stripComments(await readFile(new URL(path, ROOT), 'utf8'))
    for (const needle of banned) {
      assert.equal(code.includes(needle), false, `${path} 不许出现「${needle}」`)
    }
    if (path.includes('domains/report-evaluation')) {
      for (const needle of noModel) {
        assert.equal(code.includes(needle), false, `${path} 不许出现「${needle}」`)
      }
    }
  }
})


test('the template role changes the frozen digest even when the archived material bytes are identical', async () => {
  const directory = sourceDir([['报告.pdf', 'synthetic-pdf'], ['计算表.xlsx', 'synthetic-xlsx']])
  const first = makeHarness()
  const second = makeHarness()
  const plain = await preparePreview(previewRequest({ paths: [directory] }), first.previewDeps)
  const chosen = await preparePreview(previewRequest({ paths: [directory], templatePath: join(directory, '计算表.xlsx') }), second.previewDeps)
  assert.equal(plain.ok, true, plain.error)
  assert.equal(chosen.ok, true, chosen.error)
  assert.equal(plain.files.length, 2)
  assert.equal(chosen.files.length, 2, 'a template already in the folder is archived only once')
  assert.notEqual(plain.inputDigest, chosen.inputDigest, 'file identity alone does not bind its template role')
  assert.equal(chosen.templateFileId, chosen.files.find((file) => file.fileName === '计算表.xlsx').fileId)
})

test('a file selected as calculation template must be an actual XLSX file', async () => {
  const h = makeHarness()
  const directory = sourceDir([['报告.pdf', 'synthetic-pdf']])
  const preview = await preparePreview(previewRequest({ paths: [directory], templatePath: join(directory, '报告.pdf') }), h.previewDeps)
  assert.equal(preview.ok, false)
  assert.match(preview.error, /xlsx|计算表|模板/i)
})


test('an in-flight native parent creation still owns its handoff after preview expiry', async () => {
  const h = makeHarness()
  const dir = sourceDir([['报告.pdf', 'synthetic-bytes']])
  const preview = await preparePreview(previewRequest({ paths: [dir] }), h.previewDeps)
  const original = h.handoffDeps.createSession
  let release
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const barrier = new Promise((resolve) => { release = resolve })
  h.handoffDeps.createSession = async (input) => { entered(); await barrier; return original(input) }
  const first = handoffProject(handoffRequest(preview), h.handoffDeps)
  await started
  h.advance(VALUATION_PREVIEW_TTL_MS + 1)
  const second = handoffProject(handoffRequest(preview), h.handoffDeps)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true, a.error)
  assert.equal(b.ok, true, b.error)
  assert.equal(a.parentSessionId, b.parentSessionId)
  assert.equal(h.createdSessions.length, 1)
})
