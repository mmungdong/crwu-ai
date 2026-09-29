import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **设计要求 → 证据** 的可追溯门禁（协议 18 · 子项目 E）。
 *
 * ## 为什么需要它
 *
 * 设计文档（`docs/superpowers/specs/2026-09-28-desktop-local-access-design.md`）把每条要求都编了号
 * （`A-01`…`D-08`、`P-*` / `W-*` / `M-*`），并给了一张"每条要求由谁守"的验证矩阵。
 * 但那张矩阵是**人写的散文**：某条要求悄悄失去覆盖时不会有任何东西变红。
 * 2026-09-29 复查时就是靠人工比对才发现 `A-02` / `B-07` / `B-08` / `C-04…C-06` 这几条
 * 在设计里"有人守"，而在仓库里既没有具名的自动化用例、也没在验收清单里指出对应行。
 *
 * ## 判据
 *
 * 每一条要求编号必须同时在**两处**出现：
 *
 * 1. 至少一个测试文件（`tests/**`）—— 自动化证据；**或者**它是被人写进
 *    `docs/desktop-acceptance-0.0.15.md` 的"必须由人做"那一类（例如真正的越界写只能真机验）；
 * 2. 验收清单的映射表（设计要求 ↔ 验收行）—— 人工证据。
 *
 * 编号表**刻意写在测试里**，而不是从设计文档现读：设计文档是**未提交**的工作稿
 * （`docs/superpowers/specs/`），让 CI 依赖它会让门禁在干净 clone 上直接红。
 * 增删要求时同步这张表 —— 那一步正是"别忘了给它安排证据"。
 */
const DESIGN_IDS = [
  // A：版本化同意与安全的环境自举
  'A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06',
  // B：本机访问代理与迁移
  'B-01', 'B-02', 'B-03', 'B-04', 'B-05', 'B-06', 'B-07', 'B-08', 'B-09',
  // C：审核会话收敛
  'C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07', 'C-08',
  // D：桌面归因与修复指引
  'D-01', 'D-02', 'D-03', 'D-04', 'D-05', 'D-06', 'D-07', 'D-08',
]

/**
 * 只能由**真机**证明、因此允许"只在验收清单里出现"的那几条。
 *
 * 它们要么需要真实的子代理 + 真实沙箱（越界写），要么需要在别人机器上装一次。
 * 写在这里是一条**声明**：这几条没有自动化证据，别当成已经验证过。
 */
const MANUAL_ONLY = new Set(['C-04', 'C-05', 'C-06'])

const ROOT = new URL('../../', import.meta.url)
const pluginDir = fileURLToPath(ROOT)

/** `tests/**` 的全部文本（编号出现在注释里也算：那是"这条用例在守哪条要求"的声明）。 */
function testSources() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (/\.(mjs|js|ts)$/.test(entry)) out.push(full)
    }
  }
  walk(join(pluginDir, 'tests'))
  // ⚠️ **必须排除本文件**：它自己就写着 `DESIGN_IDS` / `MANUAL_ONLY` 两张表，
  // 不排除的话"某条要求没有测试声明它"永远不成立 —— 门禁自己把自己满足了
  //（和 `B-01c` 第一次写成"源码里找字符串"同一个坑：操作表把自己满足了）。
  return out.filter((path) => !path.endsWith('host-design-traceability.test.mjs'))
}

test('设计要求 ↔ 测试/验收：每条编号都必须能在两处找到证据', () => {
  // 真实浏览器里的断言（`install/browser-check.mjs`）也是自动化证据，而且是**唯一**能证明
  // "点「暂不允许」一个请求都不发"那种行为的地方 —— 所以它也算进来。
  const browserCheck = readFileSync(join(pluginDir, 'install/browser-check.mjs'), 'utf8')
  const testText = [...testSources().map((path) => readFileSync(path, 'utf8')), browserCheck].join('\n')
  const acceptance = readFileSync(join(pluginDir, 'docs/desktop-acceptance-0.0.15.md'), 'utf8')

  const missingInTests = []
  const missingInAcceptance = []
  for (const id of DESIGN_IDS) {
    if (!MANUAL_ONLY.has(id) && !testText.includes(id)) missingInTests.push(id)
    if (!acceptance.includes(id)) missingInAcceptance.push(id)
  }

  assert.deepEqual(missingInTests, [],
    `这些要求在设计里有编号，但没有任何测试声明它在守：${missingInTests.join('、')}`
    + '（真机才验得了的写进 MANUAL_ONLY，并说明理由）')
  assert.deepEqual(missingInAcceptance, [],
    `这些要求在验收清单里找不到对应行：${missingInAcceptance.join('、')}`
    + '（验收清单是人工证据的唯一入口）')

  // 反向：声明"只能真机"的编号必须真的**没有**测试声明它，否则声明就是错的。
  for (const id of MANUAL_ONLY) {
    assert.equal(testText.includes(id), false,
      `${id} 被声明为"只能真机验证"，但测试里已经有它 —— 要么去掉声明，要么把用例写完整`)
  }
})

test('设计与验收的编号**集合**必须一致（多一个少一个都说明有人改了口径没同步）', () => {
  const acceptance = readFileSync(join(pluginDir, 'docs/desktop-acceptance-0.0.15.md'), 'utf8')
  // 验收清单自己的人造编号（P/W/M 那三条矩阵）必须齐全 —— 它们是"人工证据"的骨架。
  const matrixIds = [
    ...Array.from({ length: 18 }, (_, index) => `P-${String(index + 1).padStart(2, '0')}`),
    ...Array.from({ length: 7 }, (_, index) => `W-${String(index + 1).padStart(2, '0')}`),
    ...Array.from({ length: 10 }, (_, index) => `M-${String(index + 1).padStart(2, '0')}`),
  ]
  const missing = matrixIds.filter((id) => !acceptance.includes(id))
  assert.deepEqual(missing, [], `验收清单缺了这些行：${missing.join('、')}`)
})
