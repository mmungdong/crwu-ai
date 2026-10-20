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
/**
 * 受守卫的验收矩阵。
 *
 * 0.0.42 那份是协议 33 的完整清单（带作废标记的历史行仍在），0.0.43 那份只列协议 35
 * **新增或改判**的验收点。两份都扫：新加一行引用却没人核对，等于又造了一张会过期的表。
 */
const DOCS = [
  join(PLUGIN, 'docs/acceptance-0.0.42.md'),
  join(PLUGIN, 'docs/acceptance-0.0.43.md'),
  join(PLUGIN, 'docs/acceptance-0.0.45.md'),
  join(PLUGIN, 'docs/acceptance-0.0.46.md'),
]
const DOC = DOCS[0]

/** 历史行的标记：带它的行不参与"逐字存在"校验（见第一条用例的说明）。 */
const SUPERSEDED_TAGS = [
  // 协议 35 删掉的 v1 行为（抽屉自动打开、按 valuationId 的进度与取消…）。
  '⟪协议35作废⟫',
  // 案例来源收敛成只登记链家后不再成立的行（来源数量与展示名）。
  '⟪来源收敛作废⟫',
  // 同页重试上限由 3 降为 2（风控口径收敛）后不再成立的行 —— 那些行引用的用例名
  // 里写着"三次"，而用例名本身必须跟着上限改，否则名字与断言会互相打架。
  '⟪重试上限收敛作废⟫',
  // 知识路由改由知识库侧 manifest 声明之后，**整条前置链路消失**的行：模板索引正文、
  // published/reserved 状态、索引声明的指纹与大小、本地 references 兜底、以及
  // "缺必需知识即停"。这些行记录的是当时真实存在过的强制点，保留原文只加标记。
  '⟪清单路由作废⟫',
  // 协议 39 改判：估值改成**一级页**（取消房地产二级导航）、登录从门禁改为可选能力、
  // 进页面不再探测来源。那几条验收点记录的是 0.0.43 当时的真实强制点，保留原文只加标记。
  '⟪协议39改判作废⟫',
  // 面板视觉与交互重构（0.0.46）：页面顺序换了、主操作从「确认」改成「核对资料」、
  // 抽屉里必须出现信息获取辅助区。这些行记录的是 0.0.43 / 0.0.45 当时的真实强制点。
  '⟪面板重构改判作废⟫',
  // 协议 40（0.0.47）：随包住宅七表模板与旧结果 JSON 链退出生产，工作簿改为"显式模板 +
  // 该模板自己的填写说明"，交付口径统一到 `估值报告数据.json`。引用旧
  // `test_valuation_contracts.py` 的行记录的是当时的真实强制点，保留原文只加标记。
  '⟪协议40改判作废⟫',
  // Protocol 42 re-decisions: weak-fact auto-merge, raw-row qualified budgets, and the old
  // report-chain reference-contract assertion all left production.
  '⟪协议42改判作废⟫',
]
const isSuperseded = (line) => SUPERSEDED_TAGS.some((tag) => line.includes(tag))

/** 断言原话可能出现在任何测试或技能校验脚本里。 */
function sourcesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourcesUnder(full, out)
    else if (/\.(mjs|py)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * 仓库内的 Go 测试也是合法强制点。
 *
 * 有些验收标准（登录判定、cookie 有效期、端口发现）的边界就在 CLI 那边，插件测试引用的是
 * 结论而不是判据本身。只扫插件目录会让这些引用被误判成"表已变旧"，于是要么删掉正当的引用、
 * 要么把 Go 侧的判据再抄一遍 —— 两种都比扫一遍 Go 测试更坏。
 *
 * 源仓不在时（技能/插件被单独拷走）返回空列表：这一层是源仓契约测试，缺文件就不假装通过。
 */
function goTestSources(repoRoot, out = []) {
  let entries
  try {
    entries = readdirSync(repoRoot)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(repoRoot, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (!['internal', 'cmd', 'scripts'].includes(entry)) continue
    collectGoTests(full, out)
  }
  return out
}

function collectGoTests(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) collectGoTests(full, out)
    else if (entry.endsWith('_test.go')) out.push(full)
  }
}

test('验收矩阵引用的断言原话必须逐字存在（防止表变旧）', () => {
  const doc = DOCS.map((path) => readFileSync(path, 'utf8')).join('\n')
  // 断言原话可能出现在：插件测试、技能校验脚本、**构建产物冒烟脚本**（`scripts/`）、
  // 以及**真机验收脚本**（`install/browser-check.mjs`）。少扫一处，表里那条引用就会被误判成"变旧"。
  const corpus = [
    ...sourcesUnder(join(PLUGIN, 'tests')),
    ...sourcesUnder(join(PLUGIN, 'skills/biz/crwu-biz-valuation-realestate/scripts')),
    // 技能维护器自己的校验与回归（`kb_tool.py` + 它的测试）：引用卫生、技能自足性这些
    // 验收标准的边界就在那里。不扫它，表里那条引用会被误判成"变旧"，
    // 于是要么删掉正当的引用、要么把校验逻辑再抄一份。
    ...sourcesUnder(join(PLUGIN, 'skills/crwu/crwu-dev-audit-skill-maintainer/scripts')),
    ...sourcesUnder(join(PLUGIN, 'scripts')),
    ...sourcesUnder(join(PLUGIN, 'install')),
    ...goTestSources(dirname(dirname(PLUGIN))),
  ].filter((path) => path !== fileURLToPath(import.meta.url)).map((path) => readFileSync(path, 'utf8')).join('\n')

  // **作废行不参与逐字校验**：协议 35 把 v1 的"抽屉自动打开 / 提取阶段进度 / 按 valuationId 取消"
  // 整条链路删掉了（页面不再追踪估值完成度）。这些行是 0.0.42 的**历史记录**，
  // 按仓库口径（dated acceptance 是历史快照）保留原文，只加一个作废标记，
  // 不能为了"让守卫变绿"去改写历史叙述、也不能删掉它们。
  //
  // 但**活着的行必须仍然逐字存在** —— 那才是这张表真正的价值。所以：
  // ① 作废行必须带标记（否则它会被当成活行）；② 活行条数仍然有下限。
  const lines = doc.split('\n')
  const superseded = lines.filter((line) => isSuperseded(line))
  const live = lines.filter((line) => !isSuperseded(line)).join('\n')
  assert.ok(superseded.length > 0, '作废行必须显式带 ⟪协议35作废⟫ / ⟪来源收敛作废⟫ 标记')

  const cited = [...live.matchAll(/「([^」]+)」/g)]
    .map((match) => match[1])
    // 只校验"看起来像断言原话"的：够长、且不是路径/文件名。
    .filter((item) => item.length >= 7 && !/\.(mjs|ts|py|md|json|xlsx|html)$/.test(item))

  assert.ok(cited.length >= 20, `引用太少（${cited.length} 条）：验收矩阵看起来没写完`)
  // Map superseded assertion names without rewriting historical snapshots.
  const replacedAssertions = new Map([
    ['检索：页面取到但既没有 JSON-LD 也不是结果页 → no-results（绝不按标题猜）', '检索：未识别的页面保留解析缺口，不推断为无房源'],
    ['开始新一轮：两个必填项一起清回未选择，保留最近会话入口', '开始新一轮：两项都回到未选择，并保留最近会话入口'],
    ['资产类型：初始为空、未选不能确认、只认已登记取值', '资产类型：默认未选择、显式清空需补选、未知值与 auto 被拒'],
    ['新草稿：资产类型与评估方法**都未选择**（自动判定不是默认值）', '新草稿：资产类型与评估方法都未选择，auto 不再是有效方法'],
    ['setMethod：四项通过、空串清回未选、未知枚举与大小写变体被拒', 'setMethod：三项通过、空串清回未选、auto 与未知枚举被拒'],
    ['方法：四项全部可选（适用性由本轮业务规范判断，界面不预先禁用）', '方法：三项指定方法全部可选，auto 不在选项里（适用性由本轮业务规范判断）'],
    ['自动判断可采用**组合**方法：适用且能跑的方法全部被采纳，不再只取第一个', '用户指定方法时**不静默增补**其它方法（即使它们也能跑）'],
    // 上限 30 → 200（0.0.49）：历史表格保留原文，活断言已按常量重命名。
    ['资料份数：30 份通过；31 份**整批阻止**且一份都不复制', '资料份数：达到上限通过；上限 +1 **整批阻止**且一份都不复制'],
  ])
  const missing = cited.filter((item) => !corpus.includes(replacedAssertions.get(item) ?? item))
  assert.deepEqual(missing, [], `这些引用在测试源码里找不到（表已变旧）：\n${missing.join('\n')}`)
})

test('验收矩阵必须为每条标准写明"去掉它会放走什么"', () => {
  let total = 0
  for (const path of DOCS) {
    const doc = readFileSync(path, 'utf8')
    const rows = doc.split('\n').filter((line) => line.startsWith('| ') && line.endsWith(' |'))
    // 表头分隔行与表头本身不算数据行。
    const dataRows = rows.filter((line) => !/^\|\s*-+/.test(line) && !/验收标准\s*\|/.test(line))
    assert.ok(dataRows.length >= 8, `${path} 只有 ${String(dataRows.length)} 行，看起来没覆盖完`)
    const thin = dataRows.filter((line) => line.split('|').length < 5)
    assert.deepEqual(thin, [], `${path}：这些行没有第三列（去掉强制点会放走什么）`)
    // 能力缺口要单独成节，且**不许**混进"已满足"的表里。
    assert.match(doc, /## \d+\. 需要真机 \/ 真网络 \/ 人工的部分/, `${path}：能力缺口必须单独成节`)
    total += dataRows.length
  }
  assert.ok(total >= 30, `两份矩阵合计只有 ${String(total)} 行`)
})
