#!/usr/bin/env node
/**
 * 随包 Python 依赖的**一致性断言**。
 *
 * 两个技能各自携带自己的 wheel 副本（各自自包含、单技能复制后可用），但版本与字节必须
 * 完全一致：否则同一个 `pypdf` 在不同技能里是不同版本，出错时无法复现。
 * 这里把「统一清单 + 各自副本」落成一条可执行检查，而不是靠人记得同步。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDORS = [
  'skills/capabilities/crwu-ocr/vendor/wheels',
  'skills/crwu/crwu-audit/vendor/wheels',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const problems = []
const seen = new Map()

for (const vendor of VENDORS) {
  const manifestPath = join(ROOT, vendor, 'manifest.json')
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch (error) {
    problems.push(`${vendor}/manifest.json 读不出来：${error.message}`)
    continue
  }
  const packages = manifest?.packages ?? {}
  for (const [name, entry] of Object.entries(packages)) {
    const wheelPath = join(ROOT, vendor, String(entry.wheel ?? ''))
    let size
    try {
      size = statSync(wheelPath).size
    } catch {
      problems.push(`${vendor}：${name} 的 wheel 不存在（${entry.wheel}）`)
      continue
    }
    if (size !== entry.bytes) {
      problems.push(`${vendor}：${name} 字节数不符（manifest ${entry.bytes}，实际 ${size}）`)
    }
    const actual = sha256(wheelPath)
    if (actual !== entry.sha256) {
      problems.push(`${vendor}：${name} sha256 不符（manifest ${entry.sha256}，实际 ${actual}）`)
    }
    const fingerprint = `${entry.version}|${entry.wheel}|${entry.sha256}`
    const previous = seen.get(name)
    if (previous === undefined) {
      seen.set(name, { vendor, fingerprint, compared: false })
    } else if (previous.fingerprint !== fingerprint) {
      problems.push(
        `${name} 在两个技能里不一致：${previous.vendor} = ${previous.fingerprint}，`
        + `${vendor} = ${fingerprint}`,
      )
    } else {
      previous.compared = true
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`vendor:check ✗ ${problem}`)
  console.error(`\nvendor:check 失败（${problems.length} 项）：随包依赖必须逐字节一致`)
  process.exit(1)
}

// 孤儿 wheel：目录里有、manifest 没登记的文件会被原样打进包，加载却永远轮不到它。
// 设计口径是"统一清单 + 各自副本"，所以清单之外的 wheel 一律算错。
for (const vendor of VENDORS) {
  let manifest
  try {
    manifest = readJson(join(ROOT, vendor, 'manifest.json'))
  } catch {
    continue
  }
  const declared = new Set(
    Object.values(manifest?.packages ?? {}).map((entry) => String(entry?.wheel ?? '')),
  )
  let wheels = []
  try {
    wheels = readdirSync(join(ROOT, vendor)).filter((name) => name.endsWith('.whl'))
  } catch {
    wheels = []
  }
  for (const wheel of wheels) {
    if (!declared.has(wheel)) problems.push(`${vendor}：${wheel} 未在 manifest 里登记（孤儿 wheel）`)
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`vendor:check ✗ ${problem}`)
  console.error(`\nvendor:check 失败（${problems.length} 项）：随包依赖与 manifest 必须一致`)
  process.exit(1)
}

const compared = [...seen].filter(([, item]) => item.compared).map(([name]) => name)
const single = [...seen].filter(([, item]) => !item.compared).map(([name]) => name)
console.log(
  `vendor:check ✓ ${seen.size} 个随包依赖`
  + `（跨技能同名并已比对一致：${compared.join('、') || '无'}`
  + `；单技能：${single.join('、') || '无'}）`,
)
