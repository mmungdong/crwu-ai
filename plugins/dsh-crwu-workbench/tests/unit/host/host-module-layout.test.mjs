/**
 * Host 侧的**目录分层与路径引用**（Task 3，方案 §4.2）。
 *
 * 这一层盯两件在评审里看不出来、但会在别处炸掉的事：
 *
 * 1. **目录分层真的归位了**：`tools/` 下只允许 `register.ts` 与四个分层目录；`ops/` 已经不存在
 *    （改成 `operations/`）。没有这条断言时，"搬了一半"看起来和"搬完了"一样 —— 都只是文件在别处。
 * 2. **没有指向旧路径的字符串**。这条是被真实故障逼出来的：搬完 `tools/case-dir.ts` 之后
 *    `src`/`tests` 全绿，但 `scripts/smoke-built.mjs` 里那句 `import '../src/host/tools/consts.ts'`
 *    没跟着改 —— **只有 `make plugin-check` 跑到冒烟那一步才炸**。路径引用散落在三种写法里
 *    （相对 import、`new URL('src/...', ROOT)`、`'../src/host/...'`），所以这里按"出现过旧路径"扫，
 *    而不是按某一种语法扫。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const PLUGIN = ROOT.pathname

function filesUnder(relative, extensions = ['.ts', '.tsx', '.mjs', '.js']) {
  const root = join(PLUGIN, relative)
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path)
    }
  }
  walk(root)
  return out
}

test('tools/ 下只有 register.ts 与四个分层目录（不再有一堆平铺文件）', () => {
  const entries = readdirSync(join(PLUGIN, 'src/host/tools'), { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(files, ['register.ts'], `tools/ 根下只该有 register.ts，实际：${files.join('、')}`)
  assert.deepEqual(dirs, ['common', 'integrations', 'report-audit', 'report-evaluation'])
})

test('registrar 只做组装：按分层导入各域工具，且自身不写业务（无 runShell/rpc 调用）', () => {
  const body = readFileSync(join(PLUGIN, 'src/host/tools/register.ts'), 'utf8')
  for (const layer of ['common/', 'report-audit/', 'report-evaluation/', 'integrations/']) {
    assert.ok(body.includes(layer), `register.ts 没有从 ${layer} 导入工具`)
  }
  for (const banned of ['runShell(', 'access.runShell', 'ctx.shell']) {
    assert.equal(body.includes(banned), false, `register.ts 里出现了业务执行：${banned}`)
  }
})

test('每个分层的目录都有真实内容（空目录 = 搬了个壳）', () => {
  const counts = {
    common: filesUnder('src/host/tools/common').length,
    'report-audit': filesUnder('src/host/tools/report-audit').length,
    'report-evaluation': filesUnder('src/host/tools/report-evaluation').length,
    integrations: filesUnder('src/host/tools/integrations').length,
  }
  for (const [layer, count] of Object.entries(counts)) {
    assert.ok(count >= 2, `${layer} 只有 ${count} 个文件，看起来没搬完`)
  }
})

test('operations/ 取代了 ops/（方案 §4.2 的目录名）', () => {
  assert.equal(existsSync(join(PLUGIN, 'src/host/ops')), false, 'ops/ 应当已经改名 operations/')
  // 组装 / 共享依赖 / 四个域 / 两个类型文件 —— 域文件里只放 handler。
  const operations = readdirSync(join(PLUGIN, 'src/host/operations')).sort()
  assert.deepEqual(operations, [
    'common.ts', 'core.ts', 'environment.ts', 'local-audit.ts',
    'register.ts', 'report-audit.ts', 'report-evaluation.ts', 'types-export.ts', 'types.ts',
  ])
  // `core.ts` 只剩兼容转出：真实实现搬走之后它不该再带 handler。
  const core = readFileSync(join(PLUGIN, 'src/host/operations/core.ts'), 'utf8')
  assert.equal(/^    '/m.test(core), false, 'core.ts 不该再带操作 handler')
  assert.match(core, /export \{ createCoreOperations \} from '\.\/register\.ts'/)
})

test('host/ 只剩五个顶层目录：core / domains / integrations / operations / tools（+ update/config）', () => {
  const entries = readdirSync(join(PLUGIN, 'src/host'), { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  // `update/`（自助更新子系统：检查器 / 安装器 / 持久化）与 `config/`（部署配置解析）是**子系统**，
  // 不属于"按运行时边界分的五个目录"，所以照旧留在顶层。
  assert.deepEqual(dirs, ['config', 'core', 'domains', 'integrations', 'operations', 'tools', 'update'])
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  assert.deepEqual(files, ['apply.ts', 'build-info.ts', 'consts.ts'])

  // 四类归位的判据：外部提供方进 integrations、业务进 domains、机制进 core。
  for (const [dir, expected] of [
    ['src/host/integrations', ['crwu', 'dws', 'h3yun', 'ifind', 'oss']],
    ['src/host/domains', ['local-audit', 'report-audit', 'report-evaluation']],
  ]) {
    const names = readdirSync(join(PLUGIN, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    assert.deepEqual(names, expected, `${dir} 的分层不对`)
  }
  for (const dir of ['access', 'environment', 'fs', 'http', 'platform', 'runtime', 'shell', 'state', 'system', 'workspace', 'workspace-session']) {
    assert.ok(existsSync(join(PLUGIN, 'src/host/core', dir)), `core/${dir} 应当在（机制层）`)
  }
})

test('src / tests / scripts 里没有指向旧路径的引用（冒烟脚本那次就是这么漏的）', () => {
  // 旧路径清单：搬走之后**任何**地方都不该再引用它们。
  const stale = [
    // 拼接是为了**不命中这份清单自己**：扫的是真实引用，不是清单文本。
    ['host', 'ops/'].join('/'),
    ...['case-dir', 'case-files', 'outcome', 'snapshot', 'capabilities', 'python-script']
      .map((name) => ['tools', `${name}.ts`].join('/')),
    ...['bootstrap', 'h3yun', 'knowledge', 'oss', 'dingtalk', 'local-claim', 'dws-json', 'case-scopes', 'consts']
      .map((name) => ['tools', `${name}.ts`].join('/')),
    ...['ifind', 'ifind-ops'].map((name) => ['tools', `${name}.ts`].join('/')),
    // Task 3 第二批：集成提供方与业务域归位后的旧路径
    ...['h3yun', 'ifind', 'oss', 'dws', 'crwu'].map((name) => ['host', `${name}/`].join('/')),
    ...['audit', 'local-audit', 'report'].map((name) => ['host', `${name}/`].join('/')),
    ...['access', 'fs', 'http', 'platform', 'runtime', 'state', 'workspace', 'environment', 'system', 'shell']
      .map((name) => ['host', `${name}/`].join('/')),
  ]
  const offenders = []
  // 自排除按**本文件自己的位置**算，不写死路径 —— 写死的话文件一搬，排除就失效，
  // 于是守卫开始扫自己那份"旧路径清单"并报自己（这一版就是这么被自己抓出来的）。
  const self = fileURLToPath(import.meta.url).replace(PLUGIN, '')
  for (const file of [...filesUnder('src'), ...filesUnder('tests'), ...filesUnder('scripts')]) {
    if (file.replace(PLUGIN, '') === self) continue
    const body = readFileSync(file, 'utf8')
    for (const needle of stale) {
      if (body.includes(needle)) offenders.push(`${file.replace(PLUGIN, '')} → ${needle}`)
    }
  }
  assert.deepEqual(offenders, [], `还有指向旧路径的引用：\n${offenders.join('\n')}`)
})

test('搬走之后 import 仍然解析得到：抽查每个分层目录的一个入口文件', () => {
  // 路径写对了但文件不在，是"看起来改完了、跑起来 module not found"的另一种形态。
  for (const file of [
    'src/host/tools/common/case-files.ts',
    'src/host/tools/common/types.ts',
    'src/host/tools/report-audit/consts.ts',
    'src/host/tools/report-audit/bootstrap.ts',
    'src/host/tools/report-evaluation/artifact-validate.ts',
    'src/host/tools/integrations/ifind.ts',
    'src/host/operations/core.ts',
    'src/host/operations/report-evaluation.ts',
  ]) {
    assert.ok(existsSync(join(PLUGIN, file)), `找不到 ${file}`)
  }
})

// ── Client 侧（同一条 Task 3，方案 §4.1）─────────────────────────────────────

test('client/ 只剩六个入口目录：core / locales / modules / shell / styles / ui', () => {
  const entries = readdirSync(join(PLUGIN, 'src/client'), { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  // `styles/` 是插件级样式层（token / 基础层 / 作用域 / 装配 / 安装）：它既不属于 shell，
  // 也不属于某个业务模块 —— 共享 UI 与所有模块都要从这里取主题变量。
  assert.deepEqual(dirs, ['core', 'locales', 'modules', 'shell', 'styles', 'ui'])
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
  assert.deepEqual(files, ['apply.ts', 'consts.ts', 'index.ts'])
  // 旧的三个"什么都放"的目录必须彻底消失。
  for (const gone of ['features', 'components', 'api']) {
    assert.equal(existsSync(join(PLUGIN, 'src/client', gone)), false, `src/client/${gone} 应当已被拆分`)
  }
})

test('底层 rpc() 只在 core/rpc.ts（业务 API 不再从共享入口拿它）', () => {
  const rpc = readFileSync(join(PLUGIN, 'src/client/core/rpc.ts'), 'utf8')
  assert.match(rpc, /export (async )?function rpc|export const rpc/)
  const offenders = filesUnder('src/client')
    .filter((file) => !file.endsWith('src/client/core/rpc.ts'))
    .filter((file) => /from '[^']*\/api\/client\.ts'/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [], `还有文件从旧的 api/client.ts 导入：\n${offenders.join('\n')}`)
})

test('每个业务模块都有 api.ts 与 model/ 或 ui/（模块化不是把文件塞进一个目录）', () => {
  const modules = readdirSync(join(PLUGIN, 'src/client/modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(modules, ['environment', 'local-audit', 'report-audit', 'report-evaluation', 'update'])
  for (const name of modules) {
    const base = join(PLUGIN, 'src/client/modules', name)
    assert.ok(existsSync(join(base, 'api.ts')), `${name} 缺少 api.ts`)
    const hasUi = existsSync(join(base, 'ui'))
    const hasModel = existsSync(join(base, 'model'))
    assert.ok(hasUi || hasModel, `${name} 既没有 ui/ 也没有 model/`)
  }
})

test('client 侧不再有指向旧目录的引用（features/components/api 三种写法一起扫）', () => {
  const stale = ['client/features/', 'client/components/', 'client/api/']
  const offenders = []
  const self = fileURLToPath(import.meta.url).replace(PLUGIN, '')
  for (const file of [...filesUnder('src'), ...filesUnder('tests'), ...filesUnder('scripts')]) {
    if (file.replace(PLUGIN, '') === self) continue
    const body = readFileSync(file, 'utf8')
    for (const needle of stale) {
      if (body.includes(needle)) offenders.push(`${file.replace(PLUGIN, '')} → ${needle}`)
    }
  }
  assert.deepEqual(offenders, [], `还有指向旧 client 目录的引用：\n${offenders.join('\n')}`)
})

// ── 测试目录分层（方案 §4.4）─────────────────────────────────────────────────

test('tests/unit 按 client / host / shared 分层，且不再有平铺的测试文件', () => {
  const entries = readdirSync(join(PLUGIN, 'tests/unit'), { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const loose = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  assert.deepEqual(dirs, ['client', 'host', 'shared'])
  assert.deepEqual(loose.filter((name) => name.endsWith('.test.mjs')), [],
    `tests/unit/ 根下不该还有测试文件：${loose.join('、')}`)
  // 每一层都要有真实内容（空目录 = 搬了个壳）。
  for (const [dir, least] of [['client', 10], ['host', 50], ['shared', 3]]) {
    const count = readdirSync(join(PLUGIN, 'tests/unit', dir)).filter((name) => name.endsWith('.test.mjs')).length
    assert.ok(count >= least, `tests/unit/${dir} 只有 ${count} 个测试文件，看起来没搬完`)
  }
})

test('测试文件的路径基准与它所在的深度一致（搬迁最容易漏的就是这个）', () => {
  // 测试下沉一层之后，`new URL('../../', import.meta.url)` 会指到 tests/ 而不是插件根 ——
  // 于是"找不到模块"，而报错信息指向的是路径而不是"你少写了一级 ../"。
  // 这里按**文本**核对：分层之后的测试必须用三级（插件根）或更深的相对路径。
  const offenders = []
  for (const dir of ['client', 'host', 'shared']) {
    for (const name of readdirSync(join(PLUGIN, 'tests/unit', dir))) {
      if (!name.endsWith('.test.mjs')) continue
      const body = readFileSync(join(PLUGIN, 'tests/unit', dir, name), 'utf8')
      // ⚠️ 本文件自己**就是要包含**这两个旧写法的（它是判据），所以排除自己 ——
      // 用写死的路径做排除也会随搬迁失效，所以按自己所在位置算。
      if (join(PLUGIN, 'tests/unit', dir, name) === fileURLToPath(import.meta.url)) continue
      if (body.includes("new URL('../../', import.meta.url)")) offenders.push(`${dir}/${name}`)
      // 数 `dirname(` 的个数，而不是匹配"三级"——正则不锚定的话，四级形态的**尾巴**
      // 恰好就是三级（`d2(d3(d4(fileURLToPath`），于是修好的文件也会被报出来（踩过一次）。
      const rootLine = body.split('\n').find((line) => line.includes('fileURLToPath(import.meta.url)')) ?? ''
      const depth = (rootLine.match(/dirname\(/g) ?? []).length
      if (rootLine !== '' && depth > 0 && depth < 4) {
        offenders.push(`${dir}/${name}（dirname 只有 ${depth} 级，插件根要 4 级）`)
      }
    }
  }
  assert.deepEqual(offenders, [], `这些测试的路径基准还是旧的深度：\n${offenders.join('\n')}`)
})
