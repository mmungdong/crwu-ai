#!/usr/bin/env node
/**
 * 校验某个 DSH profile 里对本插件的安装是否**自洽**（`make plugin-local-install` 的收尾一步）。
 *
 * 为什么需要它：profile 里上一次安装留下的包会让缺失的 peer 看起来能解析，于是「本机能跑」
 * 掩盖了「干净机器装不上」。0.0.43 就是这样：`@langchain/core` 靠在
 * `node_modules/dsh-crwu-workbench/node_modules/` 的残留，`zod` 靠另一个插件顺带带进来，
 * 而 `@langchain/langgraph` 被提升在顶层，两者都解析不到。
 *
 * 用法：node scripts/verify-installed.mjs <profileDir> [包名]
 * 只读，不改任何文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const profileDir = process.argv[2]
const pkgName = process.argv[3] || 'dsh-crwu-workbench'
if (!profileDir) {
  console.error('用法: node scripts/verify-installed.mjs <profileDir> [包名]')
  process.exit(2)
}

// DSH 运行时提供、不经包管理器的包
const hostProvided = (name) =>
  name.startsWith('@deepseek-ai/') || name === 'react' || name === 'react-dom' || name.startsWith('node:')

const problems = []
const notes = []
const fail = (msg) => problems.push(msg)

const profilePkgPath = path.join(profileDir, 'package.json')
if (!existsSync(profilePkgPath)) {
  console.error(`✗ 不是有效的 profile 目录（没有 package.json）: ${profileDir}`)
  process.exit(2)
}
const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
const declared = profilePkg.dependencies?.[pkgName]
if (declared === undefined) fail(`${pkgName} 不在 profile 的 dependencies 里`)

const pkgDir = path.join(profileDir, 'node_modules', pkgName)
if (!existsSync(pkgDir)) {
  console.error(`✗ 没装到: ${pkgDir}`)
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
console.log(`profile : ${profileDir}`)
console.log(`已安装 : ${pkg.name}@${pkg.version}（声明 ${declared}）`)

if (!existsSync(path.join(pkgDir, 'lib', 'index.js'))) fail('缺少 lib/index.js（包不完整）')

const req = createRequire(path.join(pkgDir, 'lib', 'index.js'))

// 1) 声明的运行时依赖必须能解析
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (hostProvided(name)) continue
  try { req.resolve(name) } catch { fail(`依赖解析不到: ${name}`) }
}

// 2) 入口里的非宿主 import 必须能解析
const entry = path.join(pkgDir, 'lib', 'index.js')
if (existsSync(entry)) {
  const src = readFileSync(entry, 'utf8')
  const specs = new Set([
    ...[...src.matchAll(/^\s*(?:import|export)\s[^\n]*?from\s*"([^"]+)"/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^\s*import\s*"([^"]+)"/gm)].map((m) => m[1]),
  ])
  for (const spec of specs) {
    if (spec.startsWith('.') || hostProvided(spec)) continue
    try { req.resolve(spec) } catch { fail(`入口 import 解析不到: ${spec}`) }
  }
}

// 3) 依赖自带的必需 peer 必须在**顶层**可解析（0.0.43 的事故点）
for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (hostProvided(name)) continue
  const depManifest = path.join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(depManifest)) continue
  const dep = JSON.parse(readFileSync(depManifest, 'utf8'))
  for (const peer of Object.keys(dep.peerDependencies ?? {})) {
    if (dep.peerDependenciesMeta?.[peer]?.optional === true) continue
    if (hostProvided(peer)) continue
    if (!existsSync(path.join(profileDir, 'node_modules', peer))) fail(`${name} 的必需 peer 缺失: ${peer}`)
  }
}

// 4) 提示可能掩盖问题的其它插件
const others = Object.keys(profilePkg.dependencies ?? {}).filter((name) => name !== pkgName)
if (others.length > 0) {
  notes.push(`profile 里还有其它依赖: ${others.join(', ')}；它们可能顺带满足本包缺失的 peer，`
    + '要验证干净安装请先移出它们再装。')
}

for (const note of notes) console.log(`! ${note}`)
if (problems.length > 0) {
  for (const msg of problems) console.log(`✗ ${msg}`)
  console.log(`\n结果: ✗ ${problems.length} 项不合格`)
  process.exit(1)
}
console.log('\n结果: ✓ 安装自洽（依赖与必需 peer 均可从本插件位置解析）')
