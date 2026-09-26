/**
 * 环境自检页的**分层规则**测试（`src/client/features/environment/layers.ts`）。
 *
 * 用户口径："这个检查很乱，对普通员工很不友好" —— 乱在没有层次。所以这里钉的不是文案措辞，
 * 而是可观察的规则：
 *   1. **五层固定顺序**：② 插件组件 → ③ DSH 脚本运行时 → ④ 登录与凭据授权 → ⑤ OSS 交付配置
 *      → ⑥ 外部数据（① 案例根目录由 WorkspaceCard 承担，**不在** layers 里）；
 *   2. 没就绪的项排在该层最前；
 *   3. 每层的 `needsWork` 与 Host 的权威结论（`blocked` / `allOk`）不打架；
 *   4. **每个没就绪的项都必须有"怎么配"的文案与对应交互**，已就绪的项不许留半句提示；
 *   5. 三件随包组件是**一个**聚合项，且整页**不许**出现「请安装 crwu / dws / ossutil」这类文案 ——
 *      它们随插件发布，员工机器上零安装。
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

const PKG_ROOT = '/Users/x/.dsh/plugins/dsh-crwu-workbench'
const tool = (name, size, patch = {}) => ({
  name,
  label: `${name} 组件`,
  file: name,
  present: true,
  sizeBytes: size,
  manifestSizeBytes: size,
  sha256: `sha-${name}`,
  expectedVersion: name === 'dws' ? '>=0.2.14' : '',
  note: `${name} 的用途`,
  ok: true,
  reason: '',
  ...patch,
})

/** 一台装齐了的机器：插件包完整、DSH 运行时正常、两条登录、AK 可用、iFinD 有 token。 */
function okEnv() {
  return {
    ok: true,
    configSource: '/tmp/test-crwu-workbench.yml',
    platform: 'darwin-arm64',
    packageIntegrity: {
      ok: true, supported: true, platform: 'darwin-arm64',
      packageRoot: PKG_ROOT, manifestPath: `${PKG_ROOT}/bin/manifest.json`, manifestFound: true,
      tools: [tool('crwu', 7351330), tool('dws', 32432720), tool('ossutil', 10849218)],
      note: '随包清单：darwin-arm64 / 3 个组件',
    },
    runtime: {
      ok: true, state: 'ok', path: '/opt/dsh/python/bin/python3', versionText: '3.12.3',
      distributions: { openpyxl: '3.1.2', 'python-docx': '1.1.2' },
      missingPackages: [], error: '', source: 'DSH 自带（bundled runtime）',
      expect: '>=3.10', required: true, requiredPackages: ['openpyxl', 'python-docx'],
      note: '审核技能脚本用的 Python 运行时，由 DSH 自带',
    },
    services: [
      { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: true, state: '正常', detail: 'userId u1 · 到期 2026-10-01' },
      { id: 'dingtalk', label: '钉钉认证', required: true, ok: true, state: '已登录', detail: '' },
    ],
    delivery: {
      oss: {
        enabled: true, bucket: 'crwu-bucket', endpoint: 'oss-cn-x.aliyuncs.com', prefix: 'crwu/audit',
        linkMode: 'signed', linkTtl: 3600, autoUpload: true, ossutilReady: true,
        ossutilPath: `${PKG_ROOT}/bin/darwin-arm64/ossutil`,
      },
      ossCred: {
        path: '/Users/x/.ossutilconfig', exists: true, endpoint: 'oss-cn-x.aliyuncs.com',
        accessKeyIdMasked: 'AKID****7890', hasSecret: true, hasSts: false, language: 'CH',
      },
      probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: true, state: 'AK 正常', detail: 'AK 可访问 oss://crwu-bucket/' },
    },
    external: { path: '/Users/x/.crwu/ifind.json', required: true, ok: true, reason: '', tokenLength: 64 },
    blocked: [], allOk: true, home: '/Users/x', trust: { credentials: true },
    workspace: { chosen: true, path: '/cases/a', title: 'A', id: 'w1', source: 'manual', missing: false },
    auditRoot: { sessionId: 'session-abcdef12', title: '审核子代理根节点', workspacePath: '/cases/a', assignedAt: '', usable: true, reason: '' },
    sessionWorkspace: { parentSessionId: '', sessionCwd: '', workspaceId: '', workspacePath: '', workspaceTitle: '' },
    me: { name: '', org: '', userId: '' },
  }
}

/** 一台什么都没配的机器（插件包不全、运行时缺包、登录过期、没有 AK、iFinD 空）。 */
function badEnv() {
  return {
    ...okEnv(),
    platform: '',
    allOk: false,
    blocked: [
      '运行平台未识别', '插件内置组件', 'DSH 脚本运行时',
      '氚云（H3Yun）员工会话', '钉钉认证', '阿里云 OSS（AK 权限）', 'iFinD 密钥',
    ],
    packageIntegrity: {
      ...okEnv().packageIntegrity,
      ok: false, supported: false,
      tools: [
        tool('crwu', 7351330),
        tool('dws', 32432720, { present: false, sizeBytes: 0, manifestSizeBytes: 32432720, ok: false, reason: '插件包不完整：包内缺少 dws' }),
        tool('ossutil', 10849218),
      ],
      note: '插件包不完整 / 平台不受支持',
    },
    runtime: {
      ...okEnv().runtime,
      ok: false, state: 'missing-package', missingPackages: ['openpyxl'],
      versionText: '3.12.3', error: 'DSH 自带运行时缺少必需包：openpyxl',
    },
    services: [
      { id: 'h3yun', label: '氚云（H3Yun）员工会话', required: true, ok: false, state: '已过期', detail: '到期 2026-09-01' },
      { id: 'dingtalk', label: '钉钉认证', required: true, ok: false, state: '未登录', detail: '请先 dws login' },
    ],
    delivery: {
      oss: { ...okEnv().delivery.oss, ossutilReady: true },
      ossCred: { path: '', exists: false, endpoint: '', accessKeyIdMasked: '', hasSecret: false, hasSts: false, language: '' },
      probe: { id: 'oss', label: '阿里云 OSS（AK 权限）', required: true, ok: false, state: 'AK 未配置', detail: 'AK and SK are both empty' },
    },
    external: { path: '/Users/x/.crwu/ifind.json', required: true, ok: false, reason: 'auth_token 为空', tokenLength: 0 },
  }
}

test('五层顺序与计数固定：插件组件 → 运行时 → 授权 → 交付 → 外部数据（① 不在层里）', () => {
  const ok = envLayers(okEnv())
  assert.deepEqual(ok.map((layer) => layer.id), ['packages', 'runtime', 'auth', 'delivery', 'external'])
  assert.deepEqual(ok.map((layer) => layer.title), [
    zhCN.envLayerPackages, zhCN.envLayerRuntime, zhCN.envLayerAuth, zhCN.envLayerDelivery, zhCN.envLayerExternal,
  ])
  // 层标题自带 ②..⑥ 编号：① 是 WorkspaceCard，不许混进 layers。
  for (const [index, layer] of ok.entries()) {
    assert.equal(layer.title.startsWith(['②', '③', '④', '⑤', '⑥'][index]), true, `第 ${String(index + 2)} 层的标题要带编号：${layer.title}`)
  }
  assert.deepEqual(ok.map((layer) => layer.id).includes('tools'), false, '旧的「工具」层必须消失')
  assert.deepEqual(ok.map((layer) => layer.id).includes('upload'), false, '旧的上传层改名成交付配置')
  assert.deepEqual(ok.map((layer) => `${layer.pass}/${layer.total}`), ['1/1', '1/1', '2/2', '1/1', '1/1'])
  assert.deepEqual(ok.map((layer) => layer.needsWork), [false, false, false, false, false])

  const bad = envLayers(badEnv())
  assert.deepEqual(bad.map((layer) => `${layer.pass}/${layer.total}`), ['0/1', '0/1', '0/2', '0/1', '0/1'])
  assert.deepEqual(bad.map((layer) => layer.needsWork), [true, true, true, true, true])
})

test('② 插件组件是**一个**聚合项：显示「插件内置组件 3/3 完整」，缺失时只说插件包不完整', () => {
  const ok = envLayerSet(okEnv()).packages
  assert.equal(ok.items.length, 1, '三件组件不许各占一行')
  assert.equal(ok.items[0].id, 'packages')
  assert.equal(ok.items[0].name, zhCN.envItemPackagesName)
  assert.equal(ok.items[0].stateText, zhCN.envItemOk)
  assert.equal(ok.items[0].meta.includes(`${zhCN.envItemPackagesName} 3/3 ${zhCN.envPackagesComplete}`), true)

  const bad = envLayerSet(badEnv()).packages.items[0]
  assert.equal(bad.state, 'missing')
  assert.equal(bad.stateText, zhCN.envPackagesBroken)
  assert.match(bad.stateText, /插件包不完整|平台不受支持/)
  // 缺哪一件要说得出（但它仍然是同一项）。
  assert.match(bad.reason, /dws|插件包不完整/)
  assert.equal(bad.fixKind, 'packages')
})

test('没就绪的项排在该层最前（同组内保持 Host 给的顺序）', () => {
  const auth = envLayerSet(badEnv()).auth
  // 氚云是「需重新登录」（已过期），钉钉是「未配置」（未登录）：两条都没就绪时保持 Host 顺序。
  assert.deepEqual(auth.items.map((item) => item.id), ['service-h3yun', 'service-dingtalk'])
  assert.deepEqual(auth.items.map((item) => item.state), ['reauth', 'missing'])

  const base = okEnv()
  const env = {
    ...base,
    services: [base.services[1], { ...base.services[0], ok: false, state: '未绑定', detail: 'no session' }],
  }
  const mixed = envLayerSet(env).auth
  assert.equal(mixed.items[0].id, 'service-h3yun', '没就绪的要排到最前')
  assert.equal(mixed.items[1].id, 'service-dingtalk')
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
  const notReady = badLayers.flatMap((layer) => layer.items).filter((item) => item.state !== 'ok')
  const names = notReady.map((item) => item.name)
  for (const name of ['插件内置组件', 'DSH 脚本运行时（Python）', '氚云（H3Yun）员工会话', '钉钉认证']) {
    assert.equal(names.includes(name), true, `blocked 提到的「${name}」必须在层里表现为没就绪`)
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

test('整页不出现「请安装 crwu / dws / ossutil」这类文案（它们随插件发布）', () => {
  for (const env of [okEnv(), badEnv()]) {
    for (const layer of envLayers(env)) {
      assert.equal(/②|③|④|⑤|⑥/.test(layer.title), true)
      for (const item of layer.items) {
        const text = [item.name, item.stateText, item.purpose, item.meta, item.reason, item.fix, item.detail, item.note].join('\n')
        for (const banned of [/请安装\s*(crwu|dws|ossutil)/i, /安装到\s*~?\/?bin/i, /npm i(nstall)?\s+(dws|ossutil|crwu)/i, /下载/]) {
          assert.equal(banned.test(text), false, `不该出现「${String(banned)}」：${text}`)
        }
      }
    }
  }
})

test('③ 运行时：能力缺口与缺包都要点名，且明说不需要装系统 Python', () => {
  const gapEnv = {
    ...okEnv(),
    allOk: false,
    blocked: ['DSH 脚本运行时'],
    runtime: {
      ...okEnv().runtime,
      ok: false, state: 'capability-gap', path: '', versionText: '', distributions: {},
      missingPackages: [], error: '宿主没有接线 DSH 自带 Python 运行时解析',
    },
  }
  const gap = envLayerSet(gapEnv).runtime.items[0]
  assert.equal(gap.state, 'missing')
  assert.equal(gap.stateText, zhCN.envRuntimeStateGap)
  assert.match(gap.stateText, /capability gap|能力缺口/i)
  assert.equal(gap.fix, zhCN.envFixRuntime)
  assert.match(gap.fix, /DSH 自带/)
  assert.doesNotMatch(gap.fix, /安装\s*python3|装 Python|请安装/i)
  assert.equal(gap.fixKind, 'runtime')

  const missing = envLayerSet(badEnv()).runtime.items[0]
  assert.equal(missing.stateText.startsWith(zhCN.envRuntimeStateMissingPackage), true)
  assert.match(missing.stateText, /openpyxl/)
  assert.match(missing.reason, /openpyxl/)

  // 就绪时展示 Python 版本、关键包版本与来源。
  const ready = envLayerSet(okEnv()).runtime.items[0]
  assert.equal(ready.meta.includes('3.12.3'), true)
  assert.equal(ready.meta.includes('openpyxl 3.1.2'), true)
  assert.equal(ready.meta.includes('DSH 自带'), true)
})

test('状态词按事实选：未配置 / 需重新登录 / Host 原文 / 缺包', () => {
  const bad = envLayerSet(badEnv())
  const byId = (layer, id) => layer.items.find((item) => item.id === id)
  assert.equal(byId(bad.packages, 'packages').stateText, zhCN.envPackagesBroken)
  assert.equal(byId(bad.auth, 'service-h3yun').state, 'reauth')
  assert.equal(byId(bad.auth, 'service-h3yun').stateText, zhCN.envItemReauth, '登录过期 = 需重新登录')
  assert.equal(byId(bad.auth, 'service-dingtalk').stateText, '未登录', 'Host 的原文比"未配置"更说明问题')
  assert.equal(byId(bad.delivery, 'oss-cred').stateText, zhCN.envItemMissing)
  assert.equal(byId(envLayerSet(okEnv()).delivery, 'oss-cred').stateText, zhCN.envItemOk)
})

test('可选项目缺失不算「要处理」：门禁与层的口径必须一致', () => {
  // 不变量：Host 的 `blocked` 只看 `required` 项，所以层的 `needsWork` / `pass` / `total` 也必须只看必需项。
  // 两边不一致就会出现「Hero 说环境已就绪、某一层却显示 2/3 并默认展开」这种自相矛盾的画面。
  const base = okEnv()
  const env = {
    ...base,
    services: [
      ...base.services,
      { id: 'extra', label: '可选的额外服务', required: false, ok: false, state: '未接入', detail: '清单声明为可选' },
    ],
  }
  const auth = envLayerSet({ ...env, allOk: true, blocked: [] }).auth
  assert.equal(auth.needsWork, false, '可选项缺失不该让这一层要求处理')
  assert.equal(auth.total, 2, 'total 只数必需项')
  assert.equal(auth.pass, 2)
  // 但可选项仍然看得见（排查时能核对它在不在），而且带着「可选」这个事实。
  const optional = auth.items.find((item) => item.required === false)
  assert.ok(optional, '可选项仍要出现在列表里')
  assert.equal(optional.state, 'missing')
})

test('⑤ 交付：AK 与连通性两条都算数（写进文件 ≠ 能用）', () => {
  const base = okEnv()
  const noSecret = {
    ...base,
    delivery: { ...base.delivery, ossCred: { ...base.delivery.ossCred, hasSecret: false } },
  }
  const item = envLayerSet(noSecret).delivery.items[0]
  assert.equal(item.state, 'missing')
  assert.equal(item.reason, zhCN.envOssReasonNoSecret)
  assert.equal(item.fixKind, 'oss')

  const deadAk = { ...base, delivery: { ...base.delivery, probe: { ...base.delivery.probe, ok: false, state: 'AK 无效', detail: 'InvalidAccessKeyId' } } }
  assert.equal(envLayerSet(deadAk).delivery.items[0].state, 'missing')
  assert.match(envLayerSet(deadAk).delivery.items[0].reason, /InvalidAccessKeyId/)
})

test('每项都有"一句人话用途"（组件与运行时用 Host 的 note，其余用本地文案）', () => {
  const ok = envLayerSet(okEnv())
  assert.equal(ok.packages.items[0].purpose, zhCN.envPackagesPurpose)
  assert.equal(ok.runtime.items[0].purpose, okEnv().runtime.note, '运行时用途直接用 Host 的 note，不自编')
  assert.equal(ok.auth.items.find((item) => item.id === 'service-h3yun').purpose, zhCN.envPurposeH3yun)
  assert.equal(ok.auth.items.find((item) => item.id === 'service-dingtalk').purpose, zhCN.envPurposeDingtalk)
  assert.equal(ok.delivery.items[0].purpose, zhCN.envPurposeOss)
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

test('envLayerSet 只认这五个层 id，取不到会抛而不是画错层', () => {
  const set = envLayerSet(okEnv())
  assert.deepEqual(Object.keys(set), ['packages', 'runtime', 'auth', 'delivery', 'external'])
  assert.equal(set.packages.title, zhCN.envLayerPackages)
  assert.equal(set.external.id, 'external')
  assert.equal('workspace' in set, false, '① 案例根目录不属于 layers')
})

test('未授权时：④ 授权里的那一项说「需要授权」，怎么配指向那个开关', () => {
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
  assert.equal(auth.needsWork, true, '④ 层要默认展开，员工一眼看到')
})
