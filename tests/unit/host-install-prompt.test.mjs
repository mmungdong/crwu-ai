/**
 * 安装提示词的测试。
 *
 * 这段文本是交给**另一个 agent** 的作业指令，它会照着它在本机装 CLI、写配置、处理密钥。
 * 早先我手写改写时丢掉了两处安全相关的措辞，所以这里**逐条钉住每一条规则**：
 * 丢失的措辞本身就是缺陷，逐条断言能在任何一次「顺手润色」时立刻变红。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { buildInstallPromptText, DEFAULT_INSTALL_DOC } = await import(
  new URL('src/host/environment/install-prompt.ts', ROOT).href
)
const { DEFAULT_MANIFEST } = await import(new URL('src/host/environment/manifest-default.ts', ROOT).href)

/** 抽出源码里某段区间的字符串字面量。 */
function literals(source, from, to) {
  const start = source.indexOf(from)
  const end = to === undefined ? source.length : source.indexOf(to, start)
  assert.ok(start >= 0, `找不到起点：${from}`)
  return [...source.slice(start, end).matchAll(/'[^']*'/g)].map((match) => match[0])
}

test('the install prompt keeps every rule verbatim', () => {
  // 动态形态退休后，「与旧实现逐字一致」这个锚没了 —— 改由**逐条钉住每一条规则**来守。
  // 原来踩过的坑是：手写改写版把「不要试探连通性」和「以清单为唯一权威」两条**安全相关**指令弄丢了，
  // 而那两条恰恰是防止 agent 白等 GitHub、以及防止它凭经验发明安装方式的关键。
  const prompt = buildInstallPromptText(DEFAULT_INSTALL_DOC, '')
  for (const clause of [
    /请完成本机 crwu 审核环境的安装/,
    /先完整阅读这份安装清单/,
    /不要凭经验跳步，不要自己发明安装方式/,
    /清单里的下载地址、校验要求、目录约定、硬性约束都以它为准/,
    /先检查、只装缺的/,
    /GitHub 一律按不可达处理/,
    /不要尝试、不要兜底、不要试探连通性/,
    /密钥、令牌一律不要回显/,
    /每一项都要实际验证/,
    /逐项回报/,
  ]) {
    assert.match(prompt, clause)
  }
})

test('the prompt keeps the clause that tells the agent not to probe GitHub', () => {
  // 这条不是措辞洁癖：GitHub 在本环境按不可达处理，去探测会白等。
  const prompt = buildInstallPromptText(DEFAULT_INSTALL_DOC, '')
  assert.match(prompt, /不要尝试、不要兜底、不要试探连通性/)
  // 权威来源条款：否则 agent 会凭经验发明安装方式。
  assert.match(prompt, /清单里的下载地址、校验要求、目录约定、硬性约束都以它为准/)
  assert.match(prompt, /密钥、令牌一律不要回显/)
  assert.match(prompt, /每一项都要实际验证/)
})

test('the prompt states the workspace rule only when a workspace is known', () => {
  const withWorkspace = buildInstallPromptText('https://doc.invalid/x.md', '/cases/space')
  assert.match(withWorkspace, /放在当前工作空间 `\/cases\/space` 下/)
  const without = buildInstallPromptText('https://doc.invalid/x.md', '')
  assert.equal(without.includes('需要临时文件时放在当前工作空间'), false)
})

test('the prompt always names the checklist URL first', () => {
  const prompt = buildInstallPromptText('https://doc.invalid/install.md', '')
  assert.match(prompt, /\*\*第一步：先完整阅读这份安装清单 —— https:\/\/doc\.invalid\/install\.md\*\*/)
  const empty = buildInstallPromptText('', '')
  assert.match(empty, /第一步：先完整阅读这份安装清单 —— \*\*/)
})

test('the built-in manifest carries a usable install doc so the prompt is never empty', () => {
  // 「内置默认必须自洽」：拿不到远程清单时，安装提示词里的地址不能是空的。
  assert.equal(DEFAULT_MANIFEST.installDocUrl, DEFAULT_INSTALL_DOC)
  assert.match(DEFAULT_INSTALL_DOC, /^https:\/\//)
})
