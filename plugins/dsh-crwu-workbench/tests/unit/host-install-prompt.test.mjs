/**
 * 安装提示词的测试。
 *
 * 这段文本是交给**另一个 agent** 的作业指令，它会照着它在本机完成登录与密钥配置。
 * 早先手写改写时丢掉了两处安全相关的措辞，所以这里**逐条钉住每一条规则**：
 * 丢失的措辞本身就是缺陷，逐条断言能在任何一次「顺手润色」时立刻变红。
 *
 * 2026-09-25 起多了一条**新的**安全属性要守：提示词里**不许出现任何 URL**。
 * 原版第一篇是「先完整阅读这份安装清单 —— <url>」，而那个地址来自只读 OSS ——
 * 谁都能换掉它，把 agent 引到别处去下载东西。二进制随包自带之后这条通道被关掉了，
 * 下面最后一条测试就是盯着「它不许回来」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const { buildInstallPromptText, BUNDLED_TOOLS } = await import(
  new URL('src/host/environment/install-prompt.ts', ROOT).href
)

test('the install prompt keeps every rule verbatim', () => {
  const prompt = buildInstallPromptText('')
  for (const clause of [
    /请完成本机 crwu 审核环境的配置/,
    /先检查、只做缺的/,
    /GitHub 一律按不可达处理/,
    /不要尝试、不要兜底、不要试探连通性/,
    /密钥、令牌一律不要回显/,
    /每一项都要实际验证/,
    /逐项回报/,
  ]) {
    assert.match(prompt, clause)
  }
})

test('提示词明说三个命令随包自带、不要安装', () => {
  const prompt = buildInstallPromptText('')
  for (const tool of BUNDLED_TOOLS) assert.ok(prompt.includes(tool), `必须点名 ${tool}`)
  // 这条是产品口径：员工机器上零安装，agent 再去装一份就会和插件自带的那份打架。
  assert.match(prompt, /随包自带/)
  assert.match(prompt, /不要\*\*下载、安装或升级它们|不要下载、安装或升级它们/)
  assert.match(prompt, /不要往 `~\/bin` 或任何系统目录里放副本/)
})

test('登录由插件面板发起，提示词不许再让 agent 手工拼命令（也不许去找路径）', () => {
  const prompt = buildInstallPromptText('')
  // 面板入口：④ 登录与凭据授权 里的两个按钮 + 首次授权（层号写错，agent 就找不到入口）。
  assert.match(prompt, /④ 登录与凭据授权（氚云 \/ 钉钉）/)
  assert.match(prompt, /点「氚云登录」/)
  assert.match(prompt, /点「钉钉登录」/)
  assert.match(prompt, /「同意并继续」/)
  assert.match(prompt, /需要授权[\s\S]*不是[\s\S]*未登录|「需要授权」，\*\*不是\*\*「未登录」/)
  // 不许再出现可直接照抄的登录命令（这与审核链路的「无路径泄漏」是同一条纪律）。
  assert.equal(/crwu h3yun session login/.test(prompt), false, '不许让 agent 手工跑氚云登录命令')
  assert.equal(/dws auth login/.test(prompt), false, '不许让 agent 手工跑钉钉登录命令')
  assert.match(prompt, /\*\*不要\*\*在 shell 里手工拼 `crwu` 命令/)
  assert.match(prompt, /不要\*\*手工拼 `dws` 命令/)
  // 明确禁止找路径 / 改 PATH / 拷副本。
  assert.match(prompt, /不要去找这几个命令的路径/)
  assert.match(prompt, /不要搜索可执行文件、不要改 PATH/)
  assert.match(prompt, /不需要任何 PATH 配置/)
})

test('提示词不让 agent 碰密钥：不索取、不代填、不回显', () => {
  const prompt = buildInstallPromptText('')
  assert.match(prompt, /不要索取、不要代填/)
  assert.match(prompt, /不要让它出现在对话或文件里/)
  assert.match(prompt, /不要把密钥贴进对话/)
})

test('the prompt states the workspace rule only when a workspace is known', () => {
  const withWorkspace = buildInstallPromptText('/cases/space')
  assert.match(withWorkspace, /放在当前工作空间 `\/cases\/space` 下/)
  const without = buildInstallPromptText('')
  assert.equal(without.includes('需要临时文件时放在当前工作空间'), false)
})

test('提示词里不许出现任何 URL（那是把 agent 引到别处下载的通道）', () => {
  for (const workspace of ['', '/cases/space']) {
    const prompt = buildInstallPromptText(workspace)
    assert.equal(/https?:\/\//.test(prompt), false, '提示词必须是整篇自述，不带任何外链')
  }
})

test('生成提示词只接受工作空间一个参数（没有清单地址可传）', () => {
  // 少一个参数就少一条「把地址换成任意 URL」的通道；这条断言挡住"顺手加回 url 参数"。
  assert.equal(buildInstallPromptText.length, 1)
})
