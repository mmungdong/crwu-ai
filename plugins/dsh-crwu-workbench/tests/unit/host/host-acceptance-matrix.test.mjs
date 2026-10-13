/**
 * 验收矩阵守卫（协议 32 · 方案 §16/§17）。
 *
 * 源仓契约测试：`docs/acceptance-0.0.42.md` 把 §16 的每条验收标准对应到"删掉它就放走什么"的
 * 那一处强制点，并用 `「…」` 引用**断言原话**。这张表最大的风险不是写错，而是**慢慢变旧**：
 * 断言改名、文件搬走、某条被删掉 —— 表格照样写着"已强制"，而实际上已经没有强制点了。
 * 那种文档比没有文档更坏：它让人以为查过了。
 *
 * 所以这里把每个 `「…」` 拿回测试源码与校验脚本里找一遍。找不到就判红，并说清是哪一个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const DOC = join(PLUGIN, 'docs/acceptance-0.0.42.md')

/** 断言原话可能出现在任何测试或技能校验脚本里。 */
function sourcesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourcesUnder(full, out)
    else if (/\.(mjs|py)$/.test(entry)) out.push(full)
  }
  return out
}

test('验收矩阵引用的断言原话必须逐字存在（防止表变旧）', () => {
  const doc = readFileSync(DOC, 'utf8')
  // 断言原话可能出现在：插件测试、技能校验脚本、**构建产物冒烟脚本**（`scripts/`）、
  // 以及**真机验收脚本**（`install/browser-check.mjs`）。少扫一处，表里那条引用就会被误判成"变旧"。
  const corpus = [
    ...sourcesUnder(join(PLUGIN, 'tests')),
    ...sourcesUnder(join(PLUGIN, 'skills/biz/crwu-biz-valuation-realestate/scripts')),
    ...sourcesUnder(join(PLUGIN, 'scripts')),
    ...sourcesUnder(join(PLUGIN, 'install')),
  ].map((path) => readFileSync(path, 'utf8')).join('\n')

  const cited = [...doc.matchAll(/「([^」]+)」/g)]
    .map((match) => match[1])
    // 只校验"看起来像断言原话"的：够长、且不是路径/文件名。
    .filter((item) => item.length >= 7 && !/\.(mjs|ts|py|md|json|xlsx|html)$/.test(item))

  assert.ok(cited.length >= 20, `引用太少（${cited.length} 条）：验收矩阵看起来没写完`)
  const missing = cited.filter((item) => !corpus.includes(item))
  assert.deepEqual(missing, [], `这些引用在测试源码里找不到（表已变旧）：\n${missing.join('\n')}`)
})

test('验收矩阵必须为每条 §16 标准写明"去掉它会放走什么"', () => {
  const doc = readFileSync(DOC, 'utf8')
  const rows = doc.split('\n').filter((line) => line.startsWith('| ') && line.endsWith(' |'))
  // 表头分隔行与表头本身不算数据行。
  const dataRows = rows.filter((line) => !/^\|\s*-+/.test(line) && !/验收标准\s*\|/.test(line))
  assert.ok(dataRows.length >= 30, `验收矩阵只有 ${dataRows.length} 行，看起来没覆盖完`)
  const thin = dataRows.filter((line) => line.split('|').length < 5)
  assert.deepEqual(thin, [], '这些行没有第三列（去掉强制点会放走什么）')
  // 能力缺口要单独成节，且**不许**混进"已满足"的表里。
  assert.match(doc, /## 6\. 需要真机 \/ 真网络 \/ 人工的部分/, '能力缺口必须单独成节')
})
