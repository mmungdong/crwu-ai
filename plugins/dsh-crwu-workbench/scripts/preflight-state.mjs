/**
 * 状态文件预检（**只读**，维护者工具）。
 *
 * 用途：升级到协议 18 之后，员工第一次点「允许」会重写
 * `<home>/.dsh/crwu-workbench.json`。那个文件里还有 20+ 条审核记录、工作空间与占用锁 ——
 * 点之前想知道"会改什么、不会改什么"，点之后想知道"我的记录还在不在"。
 *
 * 这个脚本就是回答这两个问题的：
 *
 * 1. 现在这份文件被判成什么授权状态（`granted` / `outdated` / `revoked` / `missing`）；
 * 2. **在内存里**模拟一次"允许"（走生产的合并写入路径），列出会消失/新增的键，
 *    并逐字节比对其余字段是否原样保留。
 *
 * ⚠️ 它**绝不写**真实状态文件：模拟用的 fs 服务是内存替身，写进去的内容只留在进程里。
 * 输出只含键名与计数 —— 不含路径、不含凭据、不含审核记录内容。
 *
 * 用法：
 *
 * ```bash
 * node scripts/preflight-state.mjs            # 用当前用户的主目录
 * node scripts/preflight-state.mjs --home <目录>
 * ```
 *
 * 它**不随包发布**（`package.json` 的 `files` 只列了 `prepare.mjs` 与 `lib/cli-entry.mjs`），
 * 所以这是维护者/支持工具，不会进员工机器。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const homeIndex = args.indexOf('--home')
const home = homeIndex >= 0 ? (args[homeIndex + 1] ?? '') : homedir()
if (home === '') {
  console.error('用法：node scripts/preflight-state.mjs [--home <目录>]')
  process.exit(2)
}

const { workbenchConfigPath } = await import(new URL('../src/host/state/persist.ts', import.meta.url).href)
const { LOCAL_ACCESS_CONFIG_KEY, LEGACY_TRUST_CONFIG_KEY, localAccessViewOf } =
  await import(new URL('../src/host/access/consent.ts', import.meta.url).href)
const { LOCAL_ACCESS_CAPABILITIES, LOCAL_ACCESS_SCHEMA_VERSION } =
  await import(new URL('../src/shared/access/types.ts', import.meta.url).href)

const path = workbenchConfigPath(home)
let raw = ''
try {
  raw = readFileSync(path, 'utf8')
} catch {
  console.log(JSON.stringify({
    pathKnown: true,
    exists: false,
    consent: 'missing',
    note: '没有状态文件：这是全新安装的现场，第一次打开就会看到授权卡',
  }, null, 2))
  process.exit(0)
}

// 解析语义与 `readWorkbenchConfigResult` 一致：坏 JSON 当空配置（那时本来也没字段可保全）。
const parseConfig = (text) => {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch {
    return {}
  }
}
const before = parseConfig(raw)
const viewBefore = localAccessViewOf(before)
const countOf = (value) => (value !== null && typeof value === 'object' ? Object.keys(value).length : 0)

/** 内存 fs 替身：只服务这一个路径，写入留在进程里。 */
const files = { [path]: raw }
const fsStub = {
  async resolve(value) { return { targetKey: String(value), displayPath: String(value) } },
  async stat(target) { return files[target.targetKey] === undefined ? undefined : { type: 'file' } },
  async readText(target) { return files[target.targetKey] },
  async writeText(target, content) {
    files[target.targetKey] = content
    return { operation: 'update', version: 'v', before: null, after: content }
  },
  async lstat() { return { type: 'file' } },
  async mkdir() {}, async remove() {}, async list() { return [] }, async rename() {},
}
const ctx = { get: (name) => (name === 'fs' ? fsStub : undefined) }

const { writeWorkbenchConfig } = await import(new URL('../src/host/state/persist.ts', import.meta.url).href)
const access = {
  writeText: async (_call, target, content) => {
    files[target.path] = content
    return { ok: true, error: '' }
  },
}

// 与 `grantLocalAccess` 里那一次**完全同形**的补丁（含"抹掉旧键"）。
const simulated = await writeWorkbenchConfig({ ctx, home, access }, {
  [LOCAL_ACCESS_CONFIG_KEY]: {
    schemaVersion: LOCAL_ACCESS_SCHEMA_VERSION,
    grantedAt: new Date().toISOString(),
    capabilities: [...LOCAL_ACCESS_CAPABILITIES],
  },
  [LEGACY_TRUST_CONFIG_KEY]: undefined,
})
const after = parseConfig(files[path])
const viewAfter = localAccessViewOf(after)

const removed = Object.keys(before).filter((key) => !(key in after))
const added = Object.keys(after).filter((key) => !(key in before))
const changed = Object.keys(before).filter((key) => key in after
  && JSON.stringify(before[key]) !== JSON.stringify(after[key]))

console.log(JSON.stringify({
  exists: true,
  consentNow: viewBefore.state,
  reasonNow: viewBefore.reason,
  records: { audits: countOf(before.audits), hasLock: before.activeKey !== undefined || before.activeChildId !== undefined },
  simulatedGrant: {
    writeAccepted: simulated,
    consentAfter: viewAfter.state,
    removedKeys: removed,
    addedKeys: added,
    /** 除授权字段外，**其它任何**字段都不该变化 —— 变了就是合并写入有问题，先别点「允许」。 */
    otherKeysChanged: changed.filter((key) => key !== LOCAL_ACCESS_CONFIG_KEY && key !== LEGACY_TRUST_CONFIG_KEY),
    auditsPreserved: JSON.stringify(before.audits) === JSON.stringify(after.audits),
  },
}, null, 2))
