/**
 * 环境自检页的**分层规则**测试（`src/client/features/environment/layers.ts`）。
 *
 * 用户口径："这个检查很乱，对普通员工很不友好" —— 乱在没有层次。所以这里钉的不是文案措辞，
 * 而是四条可观察的规则：
 *   1. 四层固定顺序与计数（工具 → 登录认证 → 上传配置 → 外部数据）；
 *   2. 没就绪的项排在该层最前；
 *   3. 每层的 `needsWork` 与 Host 的权威结论（`blocked` / `allOk`）不打架；
 *   4. **每个没就绪的项都必须有"怎么配"的文案与对应交互**，已就绪的项不许留半句提示。
 *
 * 样本用真实 EnvResult 片段（字段名与 Host 的应答一致），不是自造的简化结构。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)
const { envLayers, envLayerSet, envTodoText } = await import(
  new URL('src/client/features/environment/layers.ts', ROOT).href
)
const { zhCN } = await import(new URL('src/client/locales/zh-CN.ts', ROOT).href)

/** 一台装齐了的机器：五个工具、两个登录、AK 可用、iFinD 有 token。 */
function okEnv() {
  return {
    ok: true,
    manifestSource: 'https://x.invalid/m.json', manifestKind: 'url', manifestLoaded: true,
    manifestError: '', manifestUpdatedAt: '2026-09-20T10:00:00.000Z', installDocUrl: 'https://doc.invalid/i.md',
    platform: 'darwin-arm64',
    checks: [
      {
        name: 'node', command: 'node', required: true, note: '最上游运行时：dws 与 iFinD 的 Node 路径都依赖它',
        found: true, path: '/usr/local/bin/node', versionText: 'v22.19.0', actual: '22.19.0', expect: '>=16.7',
        ok: true, reason: '', url: '', sha256: '', target: '',
      },
      {
        name: 'crwu', command: 'crwu', required: true, note: '审核编排 CLI（crwu-audit 全流程）',
        found: true, path: '/Users/x/.local/bin/crwu', versionText: '0.0.1', actual: '0.0.1', expect: '>=0.0.1',
        ok: true, reason: '', url: '', sha256: '', target: '',
      },
      {
        name: 'dws', command: 'dws', required: true, note: '钉钉 CLI（npm 包 dingtalk-workspace-cli）',
        found: true, path: '/usr/local/bin/dws', versionText: '1.0.0', actual: '1.0.0', expect: '>=0.1',
        ok: true, reason: '', url: '', sha256: '', target: '',
      },
      {
        name: 'python3', command: 'python3', required: true, note: '技能自带脚本运行时',
        found: true, path: '/usr/bin/python3', versionText: '3.11.5', actual: '3.11.5', expect: '>=3.8',
        ok: true, reason: '', url: '', sha256: '', target: '',
      },
      {
        name: 'ossutil', command: 'ossutil', required: true, note: '阿里云 OSS 上传（按平台自动选用对应包）',
        found: true, path: '/Users/x/.local/bin/ossutil', versionText: '1.7.19', actual: '1.7.19', expect: '',
        ok: true, reason: '', url: '', sha256: '', target: '',
      },
    ],
    ifindKey: { path: '/Users/x/.crwu/ifind.json', required: true, ok: true, reason: '', tokenLength: 64 },
    services: [
      { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1 · 到期 2026-10-01' },
      { id: 'dingtalk', label: '钉钉认证', required: true, ok: true, state: '已登录', detail: '' },
      { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://crwu-bucket/' },
    ],
    blocked: [], allOk: true, home: '/Users/x', trust: { h3yun: false },
    workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false },
    auditRoot: { sessionId: 'session-abcdef12', title: '审核子代理根节点', workspacePath: '/cases/a', assignedAt: '', usable: true, reason: '' },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    oss: {
      bucket: 'crwu-bucket', prefix: 'crwu/audit', endpoint: 'oss-cn-x.aliyuncs.com', linkMode: 'signed', linkTtl: 3600,
      autoUpload: true, ossutilReady: true, probe: { ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://crwu-bucket/' },
    },
    ossCred: {
      path: '/Users/x/.ossutilconfig', exists: true, endpoint: 'oss-cn-x.aliyuncs.com',
      accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH',
    },
  }
}

/** 一台什么都没配的机器（含"装上了但版本不符"和"登录过期"两种边界）。 */
function badEnv() {
  const env = okEnv()
  return {
    ...env,
    platform: '',
    checks: [
      { ...env.checks[0], found: false, path: '', versionText: '', actual: '', ok: false, reason: '未找到命令 node' },
      {
        ...env.checks[1], found: true, path: '/Users/x/.local/bin/crwu', versionText: '0.0.0', actual: '0.0.0',
        ok: false, reason: '版本 0.0.0 不满足 >=0.0.1',
        // 没有本平台预编译包：url 为空时文案必须如实说，不能给一个假下载地址。
        url: '', target: '/Users/x/.local/bin/crwu',
      },
      env.checks[2], env.checks[3], env.checks[4],
    ],
    services: [
      { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: false, state: '已过期', detail: '到期 2026-09-01' },
      { id: 'dingtalk', label: '钉钉认证', required: true, ok: false, state: '未登录', detail: '请先 dws login' },
      { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: false, state: '无凭据', detail: '未找到 OSS 凭据' },
    ],
    ifindKey: { path: '/Users/x/.crwu/ifind.json', required: true, ok: false, reason: 'auth_token 为空', tokenLength: 0 },
    blocked: ['运行平台未识别', 'node', 'crwu', '氚云（H3Yun）员工会话', '钉钉认证', '阿里云 OSS（AK 权限）', 'iFinD 密钥'],
    allOk: false,
    ossCred: { path: '', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
    oss: { ...env.oss, probe: { ok: false, state: '无凭据', detail: '未找到 OSS 凭据' } },
  }
}

test('四层顺序与计数固定：工具 → 登录认证 → 上传配置 → 外部数据', () => {
  const ok = envLayers(okEnv())
  assert.deepEqual(ok.map((layer) => layer.id), ['tools', 'auth', 'upload', 'external'])
  assert.deepEqual(ok.map((layer) => layer.title), [
    zhCN.envLayerTools, zhCN.envLayerAuth, zhCN.envLayerUpload, zhCN.envLayerExternal,
  ])
  assert.deepEqual(ok.map((layer) => `${layer.pass}/${layer.total}`), ['5/5', '2/2', '1/1', '1/1'])
  assert.deepEqual(ok.map((layer) => layer.needsWork), [false, false, false, false])

  const bad = envLayers(badEnv())
  // 工具层 5 个里只有 3 个通过（node 没装、crwu 版本不符）；③ 两条登录都没过；④⑤ 各一条。
  assert.deepEqual(bad.map((layer) => `${layer.pass}/${layer.total}`), ['3/5', '0/2', '0/1', '0/1'])
  assert.deepEqual(bad.map((layer) => layer.needsWork), [true, true, true, true])
})

test('没就绪的项排在该层最前（同组内保持 Host 给的顺序）', () => {
  const env = okEnv()
  env.checks = [env.checks[0], env.checks[2], env.checks[3], env.checks[4], { ...env.checks[1], ok: false, found: true, reason: '版本不符' }]
  const tools = envLayerSet(env).tools
  assert.equal(tools.items[0].id, 'tool-crwu', '没就绪的 crwu 要排到最前')
  assert.deepEqual(
    tools.items.slice(1).map((item) => item.id),
    ['tool-node', 'tool-dws', 'tool-python3', 'tool-ossutil'],
    '已就绪的项保持 Host 的顺序',
  )

  // 两条登录都排在前面：氚云是「需重新登录」（已过期），钉钉是「未配置」（未登录）。
  const auth = envLayerSet(badEnv()).auth
  assert.deepEqual(auth.items.map((item) => item.state), ['reauth', 'missing'])
})

test('每层 needsWork 与 Host 的 blocked / allOk 不打架', () => {
  const ok = okEnv()
  const okLayers = envLayers(ok)
  assert.equal(ok.allOk, true)
  assert.equal(ok.blocked.length, 0)
  assert.equal(okLayers.some((layer) => layer.needsWork), false, '全通过时不该有任何层"要处理"')

  const bad = badEnv()
  const badLayers = envLayers(bad)
  assert.equal(bad.allOk, false)
  assert.equal(bad.blocked.length > 0, true)
  assert.equal(badLayers.some((layer) => layer.needsWork), true, 'blocked 非空时至少有一层要处理')
  // Host 的 blocked 里凡是被层覆盖的项，都必须能在层里找到对应的没就绪项（不丢人话）。
  const notReady = badLayers.flatMap((layer) => layer.items).filter((item) => item.state !== 'ok').map((item) => item.name)
  for (const name of ['node', 'crwu', '氚云（H3Yun）员工会话', '钉钉认证']) {
    assert.equal(notReady.includes(name), true, `blocked 提到的「${name}」必须在层里表现为没就绪`)
  }
})

test('每个没就绪的项都有"怎么配"的文案与交互；已就绪的项不留半句提示', () => {
  for (const [label, env] of [['全通过', okEnv()], ['全没配', badEnv()]]) {
    for (const layer of envLayers(env)) {
      for (const item of layer.items) {
        if (item.state === 'ok') {
          assert.equal(item.fix, '', `${label}：已就绪的「${item.name}」不该还留着"怎么办"`)
          assert.equal(item.fixKind, 'none', `${label}：已就绪的「${item.name}」不该要求交互`)
          continue
        }
        assert.notEqual(item.fix.trim(), '', `${label}：没就绪的「${item.name}」必须写明怎么配`)
        assert.notEqual(item.fixKind, 'none', `${label}：没就绪的「${item.name}」必须给出对应的交互`)
        assert.notEqual(item.reason.trim(), '', `${label}：没就绪的「${item.name}」必须说明原因`)
      }
    }
  }
})

test('状态词按事实选：未配置 / 版本不符 / 需重新登录 / Host 原文', () => {
  const bad = envLayerSet(badEnv())
  const byId = (layer, id) => layer.items.find((item) => item.id === id)
  assert.equal(byId(bad.tools, 'tool-node').stateText, zhCN.envItemMissing, '没装 = 未配置')
  assert.equal(byId(bad.tools, 'tool-crwu').stateText, zhCN.envItemOutdated, '装上了但版本不符 ≠ 未配置')
  assert.equal(byId(bad.auth, 'service-h3yun').state, 'reauth')
  assert.equal(byId(bad.auth, 'service-h3yun').stateText, zhCN.envItemReauth, '登录过期 = 需重新登录')
  assert.equal(byId(bad.auth, 'service-dingtalk').stateText, '未登录', 'Host 的原文比"未配置"更说明问题')
  assert.equal(byId(envLayerSet(okEnv()).tools, 'tool-node').stateText, zhCN.envItemOk)
})

test('工具层没就绪时：给出安装提示词的做法，并区分"本平台暂无预编译包"', () => {
  const bad = envLayerSet(badEnv())
  const noPackage = bad.tools.items.find((item) => item.id === 'tool-crwu')
  assert.equal(noPackage.url, '', '样本里这一项没有下载地址')
  assert.equal(noPackage.fix.includes(zhCN.envFixToolNoPackage), true, '没有平台包必须如实说，不能给假地址')
  assert.equal(noPackage.target, '/Users/x/.local/bin/crwu', '安装目标路径要透出来')

  // 有下载地址时不许再说"本平台暂无预编译包"（fixture 里给 node 一个真实地址）。
  const withUrl = okEnv()
  withUrl.checks[0] = { ...withUrl.checks[0], ok: false, found: false, path: '', versionText: '', actual: '', url: 'https://x.invalid/node.tgz', target: '/usr/local/bin/node' }
  const node = envLayerSet(withUrl).tools.items.find((item) => item.id === 'tool-node')
  assert.equal(node.url, 'https://x.invalid/node.tgz')
  assert.equal(node.fix.includes(zhCN.envFixToolNoPackage), false)
})

test('每项都有"一句人话用途"（工具用 Host 的 note，其余用本地文案）', () => {
  const ok = envLayerSet(okEnv())
  const node = ok.tools.items.find((item) => item.id === 'tool-node')
  assert.equal(node.purpose, '最上游运行时：dws 与 iFinD 的 Node 路径都依赖它', '工具用途直接用 Host 的 note，不自编')
  assert.equal(ok.auth.items.find((item) => item.id === 'service-h3yun').purpose, zhCN.envPurposeH3yun)
  assert.equal(ok.auth.items.find((item) => item.id === 'service-dingtalk').purpose, zhCN.envPurposeDingtalk)
  assert.equal(ok.upload.items[0].purpose, zhCN.envPurposeOss)
  assert.equal(ok.external.items[0].purpose, zhCN.envPurposeIfind)
})

test('iFinD 的"怎么配"给到文件路径、字段名与申请入口', () => {
  const ifind = envLayerSet(badEnv()).external.items[0]
  assert.equal(ifind.stateText, zhCN.envItemMissing)
  assert.equal(ifind.fix.includes('/Users/x/.crwu/ifind.json'), true, '要给文件路径')
  assert.equal(ifind.fix.includes('auth_token'), true, '要给字段名')
  assert.equal(ifind.fix.includes('<你的令牌>'), true, '要给一个占位示例')
  assert.equal(ifind.reason, 'auth_token 为空', '原因用 Host 的原文')
})

test('Hero 的结论句：就绪 / 还有 N 项 / 没有 blocked 但有失败', () => {
  assert.equal(envTodoText(okEnv()), zhCN.envHeroOkSub)
  const bad = badEnv()
  assert.equal(envTodoText(bad), `${zhCN.envHeroTodo}${String(bad.blocked.length)}${zhCN.envHeroTodoTail}`)
  assert.equal(envTodoText({ ...bad, blocked: [] }), zhCN.envHeroBadSub, 'blocked 为空时退回通用说明，别说"还有 0 项"')
})

test('envLayerSet 只认这四个层 id，取不到会抛而不是画错层', () => {
  const set = envLayerSet(okEnv())
  assert.deepEqual(Object.keys(set), ['tools', 'auth', 'upload', 'external'])
  assert.equal(set.tools.title, zhCN.envLayerTools)
  assert.equal(set.external.id, 'external')
})

test('未授权时：③ 登录认证里的那一项说「需要授权」，怎么配指向那个开关', () => {
  const base = okEnv()
  const env = {
    ...base,
    allOk: false,
    blocked: ['授权读取本机凭据（氚云 / 钉钉）'],
    services: base.services.map((service) => (service.id === 'dingtalk'
      ? { ...service, ok: false, state: '需要授权', detail: '还没授权读取本机凭据' }
      : service)),
  }
  const auth = envLayers(env).find((layer) => layer.id === 'auth')
  const item = auth.items.find((entry) => entry.id === 'service-dingtalk')
  assert.equal(item.state, 'missing', '未授权 = 没就绪（红），不是"已就绪"')
  assert.equal(item.stateText, '需要授权')
  assert.equal(item.fix, zhCN.envFixAuthorize, '未授权的"怎么办"就是先授权')
  assert.equal(auth.needsWork, true, '③ 层要默认展开，员工一眼看到')
})
