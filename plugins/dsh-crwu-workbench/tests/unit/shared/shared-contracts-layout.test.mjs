/**
 * 共享层的**依赖方向**与**兼容别名**（Task 3 的目录重构）。
 *
 * 这一层是两侧的唯一共同点，方向一反就会出两种很难查的问题：
 *
 * 1. `shared/` 引用 `client/` 或 `host/` 的**运行时代码** → 打包形态上 Client 与 Host 分开构建，
 *    共享层会把两个边界缝在一起（Wire 层的编译期类型引用是**有意的例外**：它就是来核对 Host 的，
 *    而且只引类型、不引值）；
 * 2. 兼容别名被当成真身继续写新代码 → "迁移期"永远结束不了，于是共享层长期有两份入口。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const SHARED = new URL('src/shared/', ROOT)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

const SHARED_FILES = walk(SHARED.pathname)

test('共享层不许引用 Client 的任何东西（契约层两端都不依赖，只被两端依赖）', () => {
  const offenders = []
  for (const file of SHARED_FILES) {
    const body = readFileSync(file, 'utf8')
    for (const match of body.matchAll(/from\s+'([^']+)'/g)) {
      const spec = match[1]
      if (spec.includes('/client/') || spec.startsWith('../client')) {
        offenders.push(`${file.replace(SHARED.pathname, '')} → ${spec}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `共享层反向引用了 Client：\n${offenders.join('\n')}`)
})

test('共享层引用 Host 只能引**类型**（契约检查要核对 Host，但不得引运行时代码）', () => {
  const offenders = []
  for (const file of SHARED_FILES) {
    const body = readFileSync(file, 'utf8')
    for (const match of body.matchAll(/^import\s+(?!type\b)([^;]*?)from\s+'([^']*\/host\/[^']+)'/gm)) {
      offenders.push(`${file.replace(SHARED.pathname, '')} → ${match[2]}`)
    }
  }
  assert.deepEqual(offenders, [], `共享层引用了 Host 的运行时代码：\n${offenders.join('\n')}`)
})

test('按领域拆开的契约与 Wire 层都在，且入口把它们都 re-export 了', () => {
  const contracts = ['common', 'environment', 'report-audit', 'report-evaluation', 'local-audit', 'update']
  const wire = ['common', 'environment', 'report-audit', 'report-evaluation']
  const contractsIndex = readFileSync(new URL('src/shared/contracts/index.ts', ROOT), 'utf8')
  const wireIndex = readFileSync(new URL('src/shared/wire/index.ts', ROOT), 'utf8')
  for (const name of contracts) {
    assert.ok(readFileSync(new URL(`src/shared/contracts/${name}.ts`, ROOT), 'utf8').length > 0, name)
    assert.ok(contractsIndex.includes(`./${name}.ts`), `contracts/index.ts 没导出 ${name}`)
  }
  for (const name of wire) {
    assert.ok(readFileSync(new URL(`src/shared/wire/${name}.ts`, ROOT), 'utf8').length > 0, name)
    assert.ok(wireIndex.includes(`./${name}.ts`), `wire/index.ts 没导出 ${name}`)
  }
})

test('兼容别名是**整体 re-export**，且仍在被真实消费者使用', () => {
  // 注意：`shared/types.ts` 里 31 个声明**全是类型**，运行时一个都不存在 ——
  // 所以这里不能断言"导入后能拿到 TaskRow"（那永远会是 undefined）。
  // 能断言的是两件事：别名文件本身是整体 re-export；旧路径确实还有真实消费者。
  const types = readFileSync(new URL('src/shared/types.ts', ROOT), 'utf8')
  const wire = readFileSync(new URL('src/shared/wire-contract.ts', ROOT), 'utf8')
  assert.match(types, /export \* from '\.\/contracts\/index\.ts'/)
  assert.match(wire, /export \* from '\.\/wire\/index\.ts'/)
  // 只认**行首的导出声明**：注释里出现 "types.ts" 这类词不算真实定义（第一版就是这么误判的）。
  assert.equal(/^export (interface|type|const) /m.test(types), false, '别名文件不该再带真实定义')

  // 旧路径被真实消费者使用 → 别名不是死代码，删除它需要一次有意识的迁移。
  const clients = walk(new URL('src/', ROOT).pathname)
    .filter((file) => !file.includes('/shared/types.ts') && !file.includes('/shared/contracts/'))
    .filter((file) => readFileSync(file, 'utf8').includes("shared/types.ts"))
  assert.ok(clients.length > 0, '旧导入路径已经没人用 → 该删掉别名并更新本用例')
})

test('Wire 层的常量导出真的存在（它们是值，不是类型）', async () => {
  const wire = await import(new URL('src/shared/wire-contract.ts', ROOT).href)
  for (const name of ['TASK_ROW_FROM_HOST', 'ENV_RESULT_FROM_HOST', 'OSS_BATCH_FROM_HOST']) {
    assert.equal(typeof wire[name], 'function', `shared/wire-contract.ts 少了 ${name}`)
  }
})

test('契约层声明了协议 32 的阶段 / 交易性质 / 结论方法三套词', async () => {
  const wire = await import(new URL('src/shared/wire/report-evaluation.ts', ROOT).href)
  const contracts = await import(new URL('src/shared/contracts/report-evaluation.ts', ROOT).href)
  assert.deepEqual([...wire.VALUATION_PHASES], [
    'draft', 'extracting', 'confirmation', 'queued', 'running',
    'browser-login-required', 'completed', 'failed', 'cancelled', 'stale-host',
  ])
  assert.deepEqual([...wire.VALUATION_TRANSACTION_TYPES], ['挂牌', '成交', '询价', '未知'])
  assert.deepEqual([...wire.VALUATION_CONCLUSION_METHODS], ['market', 'income', 'cost'])
  // 类型只在编译期存在，这里确认模块本身可加载（值导出都在）。
  assert.equal(typeof contracts, 'object')
})

test('环境模块不再依赖报告审核门面（方案 §4.1 的禁止项）', () => {
  // 方向：环境 ← 审核。反过来会让"审核门面改一个字段"牵动环境页，
  // 而环境页是修复入口（工作区没就绪时它是唯一能进的页面）。
  const offenders = walk(new URL('src/client/modules/environment/', ROOT).pathname)
    .filter((file) => {
      const body = readFileSync(file, 'utf8')
      return /from '[^']*report-audit\/api\.ts'/.test(body)
    })
  assert.deepEqual(offenders, [], `环境模块反向依赖了报告审核门面：\n${offenders.join('\n')}`)
})

test('环境模块自带 API，且门面转出它的名字（迁移期旧路径不断）', () => {
  const api = readFileSync(new URL('src/client/modules/environment/api.ts', ROOT), 'utf8')
  assert.match(api, /export const environmentApi/)
  for (const op of ['env', 'workspace', 'accessDiagnostics', 'ifindStatus', 'ossCredSave']) {
    assert.ok(api.includes(`'${op.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}'`) || api.includes(op),
      `环境 API 缺少 ${op}`)
  }
  const facade = readFileSync(new URL('src/client/modules/report-audit/api.ts', ROOT), 'utf8')
  // 门面在 `modules/report-audit/` 下，环境模块是它的兄弟目录 → 相对路径只有一层。
  assert.match(facade, /from '\.\.\/environment\/api\.ts'/, '门面要转出环境模块的名字')
})
