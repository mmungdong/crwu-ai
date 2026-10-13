/**
 * 真实浏览器验收脚本不许"描述旧产品"（协议 32）。
 *
 * 起因是一个真实的漂移：`install/browser-check.mjs` 还在断言「报告评估」是 **Coming Soon 占位页**
 * （"整页只写开发中"），而那个模块早已实现。它之所以一直没红，是因为这条验收**必须有人起一个
 * 装了插件的 DSH profile、再装 playwright 才能跑** —— 于是"唯一能自动验收真机行为"的脚本，
 * 自己没人跑。
 *
 * 这条守卫做的是**静态交叉核对**：客户端模块注册表说"这个模块开发完了"，
 * 那么浏览器验收脚本里就不该还留着"它是占位页"的断言（反之亦然）。
 * 它挡不住 DOM 改名的漂移（那只有真跑才知道），但能挡住"产品变了、验收脚本没变"这一整类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const REGISTRY = join(PLUGIN, 'src/client/shell/modules.ts')
const BROWSER_CHECK = join(PLUGIN, 'install/browser-check.mjs')

/** 从注册表读某个模块的 `underDevelopment`（文本解析：这里只关心这一个事实）。 */
function underDevelopment(registryText, id) {
  const match = new RegExp(`\\b${id}:\\s*\\{[^}]*underDevelopment:\\s*(true|false)`).exec(registryText)
  assert.notEqual(match, null, `注册表里找不到 ${id} 的 underDevelopment`)
  return match[1] === 'true'
}

test('模块注册表说"开发完了"，浏览器验收就不许还断言它是占位页', () => {
  const registry = readFileSync(REGISTRY, 'utf8')
  const script = readFileSync(BROWSER_CHECK, 'utf8')
  const developing = underDevelopment(registry, 'eval')

  // 占位页特有的文案（来自 `locales/zh-CN.ts` 的 Coming Soon 那一组）。
  const placeholders = ['AI 辅助资产评估工作流', '正在开发中']
  const assertedPlaceholder = placeholders.filter((text) => script.includes(text))
  // 侧栏「开发中」小标签的断言。
  const assertsDevTag = /还没开发的子项挂着一枚「开发中」小标签/.test(script)

  if (developing) {
    assert.notEqual(assertedPlaceholder.length, 0,
      '报告评估还是占位页，浏览器验收却没有断言它是 Coming Soon')
  } else {
    assert.deepEqual(assertedPlaceholder, [],
      `报告评估已实现（underDevelopment: false），但浏览器验收脚本还在断言占位页文案：${assertedPlaceholder.join('、')}`)
    assert.equal(assertsDevTag, false,
      '报告评估已实现，浏览器验收脚本还在断言侧栏挂着「开发中」小标签')
    // 反过来：已经实现的模块**必须**在浏览器验收里被真的点开看一遍（否则没人证明它画得出来）。
    assert.match(script, /crwu-valuation/, '浏览器验收里应当有报告评估面板的真实断言')
  }
})

test('浏览器验收不许点「AI 审核」（一次真跑会写真实工作空间与 OSS）', () => {
  // 这条是脚本自己的硬约束，写在这里是因为它**只能靠读代码**保证：一旦有人加了这一击，
  // 那条验收就不再是"只看不写"了。
  const script = readFileSync(BROWSER_CHECK, 'utf8')
  assert.match(script, /绝不点击「AI 审核」/)
  const clicks = [...script.matchAll(/\.click\(/g)].length
  assert.ok(clicks > 0, '脚本总得点东西')
  // 触发真实审核的那两个动作名不该出现在任何 click 里。
  for (const line of script.split('\n')) {
    if (!/\.click\(/.test(line)) continue
    assert.equal(/AI 审核|开始审核|audit-start/.test(line), false, `这一击会跑真实审核：${line.trim()}`)
  }
})

test('验收清单里要求的视觉证据与主题/宽度断言都在真机脚本里', async () => {
  // 本机没有浏览器：视觉验收只能由人跑 `install/browser-check.mjs`。所以**要求本身**
  // 必须落在脚本里，否则人工执行时没有任何东西提醒他"这一项还没验"。
  const source = readFileSync(new URL('../../../install/browser-check.mjs', import.meta.url), 'utf8')
  // 主题：明暗两套变量在每个挂载点都有效。
  assert.match(source, /主题作用域：明暗两套变量在每个挂载点都有效/)
  assert.match(source, /深色块命中作用域节点/)
  assert.match(source, /宿主隔离/)
  // 宽度：面板窄宽切换（以面板实际宽度为准，不是浏览器宽度）。
  assert.match(source, /面板窄宽切换：无横向溢出（以面板实际宽度为准）/)
  assert.match(source, /容器查询按面板宽度生效，不是浏览器宽度/)
  // 视觉验收要求的几组截图都在。
  for (const shot of ['valuation-workface-wide.png', 'valuation-workface-narrow.png', 'sidebar-rail.png']) {
    assert.ok(source.includes(shot), `缺少截图 ${shot}`)
  }
  // 抽屉与运行/失败/结果状态的证据。
  assert.match(source, /确认抽屉|valuation-confirmation-drawer/)
})
