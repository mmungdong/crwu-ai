/**
 * 「声明的来源必须被那条操作允许」（协议 32）。
 *
 * 背景是一个**只有端到端才会暴露**的真实缺陷：估值 intake（面板操作）把用户选中的资料复制进
 * 案例目录时，借用了审核子代理的 `system.case-file.write` —— 而那条操作只允许 `audit-tool`。
 * 于是在生产里**每一份资料**都会被 Broker 拒掉（"不接受来自「panel」的调用"），
 * 用户看到的是"所有文件都没解析"。单测全绿，因为没人跑过那条操作。
 *
 * Broker 的判据是**调用点声明的 `source`**（能力归属，不是运行期身份），所以这件事完全可以在
 * 静态层面查出来：把每个调用点的 `{ operation, source }` 与操作描述表对一遍。
 * 这条守卫就是那次缺陷的机器判据 —— 借错操作（或改错来源）会当场变红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SRC = join(PLUGIN, 'src')

const { localAccessDescriptorOf } = await import(new URL('src/host/core/access/operations.ts', `file://${PLUGIN}/`).href)

function sourcesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourcesUnder(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** 去掉注释：注释里写着操作名不算调用点（否则守卫会被文档自己满足）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('每个调用点声明的来源，都必须被那条操作允许（借错操作 = 运行期被拒）', () => {
  const problems = []
  let checked = 0
  for (const path of sourcesUnder(SRC)) {
    const code = stripComments(readFileSync(path, 'utf8'))
    const lines = code.split('\n')
    lines.forEach((line, index) => {
      // 两种写法都要认：内联对象字面量 `{ operation: '…', source: '…' }`，
      // 以及先取常量再引用（`const operation = '…' as const` / `const source = …`）。
      const operationMatch = /operation:\s*'([^']+)'/.exec(line) ?? /operation\s*=\s*'([^']+)'/.exec(line)
      if (operationMatch === null) return
      const operation = operationMatch[1]
      // 来源可能在同一行，也可能在后面几行的同一个对象字面量里。
      const window = lines.slice(index, index + 6).join('\n')
      const sourceMatch = /source:\s*'([^']+)'/.exec(window) ?? /source\s*=\s*'([^']+)'/.exec(window)
      if (sourceMatch === null) return
      const source = sourceMatch[1]
      const descriptor = localAccessDescriptorOf(operation)
      checked += 1
      const where = `${relative(PLUGIN, path)}:${index + 1}`
      if (descriptor === undefined) {
        problems.push(`${where} 用了未登记的操作 ${operation}`)
        return
      }
      if (!descriptor.allowedSources.includes(source)) {
        problems.push(`${where} ${operation} 不允许来源 ${source}（允许：${descriptor.allowedSources.join(' / ')}）`)
      }
    })
  }
  assert.ok(checked >= 20, `只查到 ${checked} 个调用点，守卫看起来没生效`)
  assert.deepEqual(problems, [], `这些调用点的来源与操作描述表不符：\n${problems.join('\n')}`)
})

test('操作表里的每条操作都必须真的有调用点（登记了没人用 = 边界没接上）', () => {
  // 与上一条互补：那条查"调用点合法"，这条查"操作不是摆设"。
  // 例外必须显式列出来（保留项），否则新增一条没人用的操作会悄悄留在表里。
  const reserved = new Set([
    // 面板/宿主后台会用到、但当前代码路径尚未接线的操作（保留项，加进来要写原因）。
    'system.clipboard.write',
  ])
  const code = sourcesUnder(SRC).map((path) => stripComments(readFileSync(path, 'utf8'))).join('\n')
  const names = [
    ...new Set([
      ...[...code.matchAll(/operation:\s*'([^']+)'/g)].map((match) => match[1]),
      ...[...code.matchAll(/operation\s*=\s*'([^']+)'/g)].map((match) => match[1]),
    ]),
  ]
  // 反查：描述表里有哪几条名字没在任何调用点出现。
  const used = new Set(names)
  const declared = ['oss.config.read', 'oss.config.write', 'oss.remote.read', 'oss.remote.write',
    'system.case-file.write', 'system.case-file.read', 'system.case-directory.write',
    'system.browser.open', 'system.case-file.open', 'system.valuation-material.copy']
  const orphans = declared.filter((operation) => !used.has(operation) && !reserved.has(operation))
  assert.deepEqual(orphans, [], `这些操作在表里登记了但没有任何调用点：${orphans.join('、')}`)
})

test('操作层不许用"依赖调用者会话沙箱"的案例内 helper（面板没有会话）', () => {
  // 2026-10-13 用户实测：估值 intake（**面板**操作）用 `ensureDirectory` 建 `材料-源`，
  // 报 `mkdir: … Operation not permitted（来源 audit-tool · 解析为 workspace-write · 沙箱拒绝=是）`。
  //
  // 根因在 Broker 的这一行（`broker.ts`）：非特权操作要把**调用方会话**的策略放进请求，
  // 面板没有会话 → 策略是 undefined → 执行器落回部署默认（进程 cwd）→ 案例目录不在可写根之下。
  // 那几个 helper（`ensureDirectory` / `removeFileIfExists` / `probeCasePath`）都是这么设计的，
  // 它们**只对子代理成立**。面板侧要建目录必须走自己那条**提权**的操作
  //（`system.valuation-case.directory.write` / `ensurePanelCaseDirectory`）。
  const forbidden = ['ensureDirectory(', 'removeFileIfExists(', 'probeCasePath(']
  const problems = []
  for (const path of sourcesUnder(join(SRC, 'host/operations'))) {
    const code = stripComments(readFileSync(path, 'utf8'))
    for (const helper of forbidden) {
      if (code.includes(helper)) problems.push(`${relative(PLUGIN, path)} 用了 ${helper}`)
    }
  }
  assert.deepEqual(problems, [],
    `操作层（面板 / 编排来源）不许用这些依赖会话沙箱的 helper：\n${problems.join('\n')}`)
})
