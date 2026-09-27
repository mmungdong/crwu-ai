/**
 * 阿里云 OSS 交付凭据卡的 UI 行为测试（`features/environment/OssCredCard.tsx`）。
 *
 * 每一条都对应需求里点名的一条行为：
 * 1. AccessKey ID 与 Secret **各自有真实 `<label>`**（不能只靠 placeholder），且纵向排布；
 * 2. Secret 是 password 类型；
 * 3. **Client 不保留已保存的密钥**：提交的那一瞬间就清空本地输入，且从不回填；
 * 4. 主按钮文案是「保存并验证」，保存中是「正在连接 OSS 并验证权限…」，成功是
 *    「验证成功，可以访问交付目录。」；
 * 5. 失败按**四类**给人话：凭据 / 权限 / 配置 / 网络 —— 四句文案互不相同，
 *    而且"网络不通"必须显式撇清 AccessKey 的责任；
 * 6. Bucket / Endpoint / 前缀**不由员工填写**（只提示向管理员获取）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { registerTsxLoader } = await import(new URL('tests/helpers/tsx-loader.mjs', ROOT).href)
registerTsxLoader()

const { OssCredCard, ossErrorHint } = await import(
  new URL('src/client/features/environment/OssCredCard.tsx', ROOT).href)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

// ── 最小注入式渲染器（与 client-ifind-card.test.mjs 同一套写法）────────────────

function resolve(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(resolve)
  if (typeof node.type === 'function') {
    const saved = globalThis.__crwuTestInstance
    const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
    globalThis.__crwuTestInstance = instance
    try {
      return resolve(node.type(node.props))
    } finally {
      globalThis.__crwuTestInstance = saved
    }
  }
  return { type: node.type, props: { ...node.props, children: resolve(node.props.children) } }
}

function render(component, props = {}) {
  const instance = { cursor: 0, state: {}, refs: {}, effects: [] }
  globalThis.__crwuTestInstance = instance
  return { tree: resolve(component(props)), instance }
}

function rerender(component, props = {}) {
  const instance = globalThis.__crwuTestInstance
  instance.cursor = 0
  instance.effects = []
  return resolve(component(props))
}

function findAll(node, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, found)
    return found
  }
  found.push(node)
  findAll(node.props?.children, found)
  return found
}

const byType = (tree, type) => findAll(tree).filter((node) => node.type === type)
const inputs = (tree) => byType(tree, 'input')
const buttons = (tree) => byType(tree, 'button')
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const buttonLike = (tree, label) => buttons(tree).find((node) => textOf(node).includes(label)) ?? null
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

function stubOps(handlers = {}) {
  const ops = []
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    ops.push(payload)
    const entry = handlers[payload.op]
    const out = typeof entry === 'function' ? entry(payload) : entry
    return { ok: true, status: 200, async json() { return out ?? { ok: true } } }
  }
  return ops
}

/** 交付分区的最小形状：Bucket 已由部署配置给好，凭据还没填。 */
const delivery = (patch = {}) => ({
  oss: { enabled: true, bucket: 'bkt', endpoint: 'oss-cn-x.aliyuncs.com', prefix: 'crwu/audit' },
  ossCred: { exists: false, hasSecret: false, accessKeyIdMasked: '', path: '/Users/x/.ossutilconfig' },
  probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: false, state: 'AK 未配置', detail: '', errorKind: '' },
  ...patch,
})

// ── 四类归因 ────────────────────────────────────────────────────────────────

test('四类失败给出四种不同的处置（网络问题必须撇清 AccessKey 的责任）', () => {
  assert.equal(ossErrorHint('credential'), zhCN.envOssErrCredential)
  assert.equal(ossErrorHint('permission'), zhCN.envOssErrPermission)
  assert.equal(ossErrorHint('config'), zhCN.envOssErrConfig)
  assert.equal(ossErrorHint('infrastructure'), zhCN.envOssErrInfrastructure)
  const all = ['credential', 'permission', 'config', 'infrastructure'].map((kind) => ossErrorHint(kind))
  assert.equal(new Set(all).size, 4, '四类文案必须互不相同，否则等于把员工指错方向')
  assert.match(ossErrorHint('credential'), /无效|已过期|重新填写/)
  assert.match(ossErrorHint('permission'), /权限|管理员/)
  assert.match(ossErrorHint('config'), /Bucket|Endpoint|管理员/)
  assert.match(ossErrorHint('infrastructure'), /稍后|不代表 AccessKey 有误/)
  assert.equal(ossErrorHint(''), '', '认不出的归因不给话（不编原因）')
})

// ── 表单 ────────────────────────────────────────────────────────────────────

test('两个字段各有真实 <label>，Secret 是 password，且纵向排布', () => {
  stubOps()
  const { tree } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
  const labels = byType(tree, 'label')
  assert.equal(labels.length, 2, 'AccessKey ID 与 Secret 各要有自己的 <label>')
  const labelTexts = labels.map((node) => textOf(node))
  assert.equal(labelTexts.some((text) => text.includes(zhCN.envOssAkLabel)), true)
  assert.equal(labelTexts.some((text) => text.includes(zhCN.envOssSkLabel)), true)
  // 两个 label 包着各自的 input（点标签能聚焦）。
  for (const label of labels) assert.equal(inputs(label).length, 1, '每个 <label> 里恰好一个输入框')
  const field = inputs(tree).find((node) => node.props.name === 'crwu-oss-sk')
  assert.equal(field.props.type, 'password', 'Secret 必须是 password 类型')
  assert.equal(inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.type, 'text')
})

test('两个字段都填了才放行主按钮；未填时禁用', () => {
  stubOps()
  const { tree, instance } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
  const find = () => buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }), zhCN.envOssSubmit)
  const before = buttonLike(tree, zhCN.envOssSubmit)
  assert.ok(before, `要有「${zhCN.envOssSubmit}」按钮`)
  assert.equal(before.props.disabled, true, '空表单时禁用')

  // 只填 ID → 仍然禁用。
  inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.onChange({ target: { value: 'AKID123' } })
  assert.equal(find().props.disabled, true, '只有 ID 时禁用')
  // 两个都填 → 放行。
  inputs(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
    .find((node) => node.props.name === 'crwu-oss-sk').props.onChange({ target: { value: 'secret' } })
  const ready = buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }), zhCN.envOssSubmit)
  assert.equal(ready.props.disabled, false, '两个字段都填了就放行')
  assert.equal(instance.state[0], 'AKID123')
})

test('提交的那一瞬间清空本地密钥，且从不回填已保存的值', () => {
  const ops = stubOps({ 'oss-cred-save': { ok: true, error: '', chmodOk: true, chmodError: '', probe: { ok: true, state: 'AK 正常' } } })
  const { tree, instance } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
  inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.onChange({ target: { value: 'AKID123' } })
  inputs(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
    .find((node) => node.props.name === 'crwu-oss-sk').props.onChange({ target: { value: 'the-secret' } })
  buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }), zhCN.envOssSubmit).props.onClick()

  // 点下去的那一瞬间：本地两份都空了（Client 不保留已保存的密钥）。
  assert.equal(instance.state[0], '', '提交后立刻清空 AccessKey ID')
  assert.equal(instance.state[1], '', '提交后立刻清空 AccessKey Secret')
  assert.equal(JSON.stringify(ops).includes('the-secret'), true, '提交时确实把 Secret 发给了宿主')
})

test('保存成功：显示「验证成功，可以访问交付目录。」并回调刷新', async () => {
  stubOps({
    'oss-cred-save': {
      ok: true, error: '', chmodOk: true, chmodError: '',
      probe: { ok: true, state: 'AK 正常', detail: '已验证可访问 oss://bkt/crwu/audit/' },
    },
  })
  let saved = 0
  const { tree } = render(OssCredCard, { delivery: delivery(), onSaved: () => { saved += 1 } })
  inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.onChange({ target: { value: 'AKID123' } })
  inputs(rerender(OssCredCard, { delivery: delivery(), onSaved: () => { saved += 1 } }))
    .find((node) => node.props.name === 'crwu-oss-sk').props.onChange({ target: { value: 'the-secret' } })
  buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => { saved += 1 } }), zhCN.envOssSubmit).props.onClick()
  await settle()
  await settle()
  const text = textOf(rerender(OssCredCard, { delivery: delivery(), onSaved: () => { saved += 1 } }))
  assert.equal(text.includes(zhCN.envOssSaved), true, `成功文案要说清验证通过：${text.slice(0, 200)}`)
  assert.equal(saved >= 1, true, '成功后要刷新环境自检')
})

test('保存失败：按宿主给的四类归因就地给人话，且不回显密钥', async () => {
  const cases = [
    ['credential', zhCN.envOssErrCredential],
    ['permission', zhCN.envOssErrPermission],
    ['config', zhCN.envOssErrConfig],
    ['infrastructure', zhCN.envOssErrInfrastructure],
  ]
  for (const [kind, hint] of cases) {
    stubOps({
      'oss-cred-save': {
        ok: false, error: `OSS 交付不可用：${kind}`, chmodOk: true, chmodError: '',
        probe: { ok: false, state: 'x', detail: `上游原文 ${kind}`, errorKind: kind },
      },
    })
    const { tree } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
    inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.onChange({ target: { value: 'AKID123' } })
    inputs(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
      .find((node) => node.props.name === 'crwu-oss-sk').props.onChange({ target: { value: 'the-secret' } })
    buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }), zhCN.envOssSubmit).props.onClick()
    await settle()
    await settle()
    const text = textOf(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
    assert.equal(text.includes(hint), true, `${kind} → 要显示对应的人话：${text.slice(0, 260)}`)
    assert.equal(text.includes('the-secret'), false, `${kind} → 绝不回显密钥`)
  }
})

test('权限没收紧成功要如实说（0600 是这份文件的安全边界）', async () => {
  stubOps({
    'oss-cred-save': {
      ok: true, error: '', chmodOk: false, chmodError: 'chmod 不可用：权限仍是 0644',
      probe: { ok: true, state: 'AK 正常' },
    },
  })
  const { tree } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
  inputs(tree).find((node) => node.props.name === 'crwu-oss-ak').props.onChange({ target: { value: 'AKID123' } })
  inputs(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
    .find((node) => node.props.name === 'crwu-oss-sk').props.onChange({ target: { value: 'the-secret' } })
  buttonLike(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }), zhCN.envOssSubmit).props.onClick()
  await settle()
  await settle()
  const text = textOf(rerender(OssCredCard, { delivery: delivery(), onSaved: () => {} }))
  assert.equal(text.includes('0644'), true, `权限问题必须如实说：${text.slice(0, 260)}`)
})

// ── 已保存态与安全底线 ──────────────────────────────────────────────────────

test('已保存：只给掩码与次级操作，不再显示两个输入框', () => {
  stubOps()
  const saved = delivery({
    ossCred: { exists: true, hasSecret: true, accessKeyIdMasked: 'AKID****7890', path: '/Users/x/.ossutilconfig' },
    probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: true, state: 'AK 正常', detail: 'ok', errorKind: '' },
  })
  const { tree } = render(OssCredCard, { delivery: saved, onSaved: () => {} })
  assert.equal(inputs(tree).length, 0, '已保存时收起输入框（不逼用户重填）')
  const text = textOf(tree)
  assert.equal(text.includes('AKID****7890'), true, '显示掩码而不是明文')
  assert.ok(buttonLike(tree, zhCN.envOssReplace), '给「替换 AccessKey」')
  assert.ok(buttonLike(tree, zhCN.envOssRetry), '给「重新验证」')
})

test('安全底线：明说向管理员获取、不要让 Agent 代填，且不接受员工自填 Bucket', () => {
  stubOps()
  const { tree } = render(OssCredCard, { delivery: delivery(), onSaved: () => {} })
  const text = textOf(tree)
  assert.equal(text.includes(zhCN.envOssCardHint), true, '要说清向管理员获取 AccessKey')
  assert.equal(text.includes(zhCN.envOssNeverAsk), true, '要明说不要让 Agent 代填')
  assert.equal(text.includes(zhCN.envOssNeedAdmin), true, '要明说 Bucket / Endpoint 不用员工填')
  // 页面上**没有**任何让员工填 Bucket / Endpoint / 前缀的输入框。
  for (const node of inputs(tree)) {
    assert.equal(/bucket|endpoint|prefix/i.test(String(node.props.name)), false, `不该有 ${String(node.props.name)} 输入框`)
  }
})
