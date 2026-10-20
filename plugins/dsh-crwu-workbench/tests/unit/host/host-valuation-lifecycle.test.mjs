/**
 * 估值轮次的状态机、注册表与子会话指令契约（协议 32）。
 *
 * 这一层要钉死的是**用户看到的状态是真的**：
 *
 * 1. 非法转移必须被拒绝并给出原因 —— 否则"已经失败的轮次被后续心跳改回 running"，
 *    界面永远转圈，而没有任何地方报错；
 * 2. 进度不许超过总数（跑过头是"页面在编进度"的第一个信号）；
 * 3. 协议代数不一致时整页进入 `stale-host`（那时唯一该做的事是提示重启）；
 * 4. 注册表有界淘汰时，被挤掉的轮次必须标成**失败并写明原因**，不许悄悄消失；
 * 5. 指令必须**逐项写全**：估值 ID、案例目录、方法口径、基准日规则、三个交付件、
 *    交付前两道校验 —— 少写一项，子会话就会按自己的理解收尾（审核链路的原话教训）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)

const {
  TERMINAL_PHASES,
  ValuationLifecycles,
  advance,
  canAdvance,
  emptyArtifacts,
  emptyProgress,
  isTerminalPhase,
  normalizeProgress,
  phaseWithHostProtocol,
} = await import(new URL('src/host/domains/report-evaluation/lifecycle/index.ts', ROOT).href)
const { valuationPrompt } = await import(new URL('src/host/domains/report-evaluation/prompt.ts', ROOT).href)

const VAL_ID = '估值-20261012-101500-ab12'
const CASE = `/cases/space/${VAL_ID}`

function makeRecord(patch = {}) {
  return {
    valuationId: VAL_ID,
    phase: 'draft',
    casePath: CASE,
    sessionId: '',
    workspaceId: 'w1',
    workspacePath: '/cases/space',
    method: 'market',
    baseDate: '2026-06-30',
    digest: 'sha256:x',
    createdAt: 1,
    updatedAt: 1,
    progress: emptyProgress(),
    providerStates: {},
    error: '',
    capabilityGaps: [],
    artifacts: emptyArtifacts(),
    ...patch,
  }
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

test('正常路径：draft → extracting → confirmation → queued → running → completed', () => {
  let record = makeRecord()
  for (const next of ['extracting', 'confirmation', 'queued', 'running', 'completed']) {
    const outcome = advance(record, next, {}, 2)
    assert.equal(outcome.ok, true, `${record.phase} → ${next}：${outcome.reason}`)
    record = outcome.record
  }
  assert.equal(record.phase, 'completed')
  assert.equal(record.updatedAt, 2)
})

test('「返回修改」是 confirmation → draft（抽屉里唯一允许的后退）', () => {
  const outcome = advance(makeRecord({ phase: 'confirmation' }), 'draft')
  assert.equal(outcome.ok, true, outcome.reason)
})

test('非法转移被拒绝且**不改动记录**（已完成的轮次不许被改回 running）', () => {
  for (const from of TERMINAL_PHASES) {
    const record = makeRecord({ phase: from })
    const outcome = advance(record, 'running')
    assert.equal(outcome.ok, false, from)
    assert.match(outcome.reason, /终态/)
    assert.equal(outcome.record.phase, from, '拒绝时记录必须原样返回')
  }
  // 跳步也不行：draft 直接 running 意味着跳过了资料入口与确认。
  assert.equal(canAdvance('draft', 'running').ok, false)
  assert.equal(canAdvance('draft', 'running').reason.length > 0, true)
  // 终态判定
  for (const phase of ['completed', 'failed', 'cancelled']) assert.equal(isTerminalPhase(phase), true)
  assert.equal(isTerminalPhase('running'), false)
})

test('browser-login-required 是可恢复的：回到 running', () => {
  const stuck = advance(makeRecord({ phase: 'running' }), 'browser-login-required')
  assert.equal(stuck.ok, true, stuck.reason)
  const resumed = advance(stuck.record, 'running')
  assert.equal(resumed.ok, true, resumed.reason)
})

test('running → running 是允许的（心跳推进进度），但终态 → 自己不允许', () => {
  assert.equal(canAdvance('running', 'running').ok, true)
  assert.equal(canAdvance('completed', 'completed').ok, false)
})

test('进度归一化：completed 不许超过 total；total 无效时都归 0', () => {
  assert.deepEqual(normalizeProgress({ stage: 'a', completed: 9, total: 4 }), { stage: 'a', detail: '', completed: 4, total: 4 })
  assert.deepEqual(normalizeProgress({ completed: -3, total: 4 }), { stage: '', detail: '', completed: 0, total: 4 })
  assert.deepEqual(normalizeProgress({ completed: 3, total: 0 }), { stage: '', detail: '', completed: 0, total: 0 })
  assert.deepEqual(normalizeProgress({ completed: 3, total: -1 }), { stage: '', detail: '', completed: 0, total: 0 })
  assert.deepEqual(normalizeProgress(undefined), { stage: '', detail: '', completed: 0, total: 0 })
})

test('协议代数不一致 → stale-host（那时一切事实都不可信）', () => {
  assert.equal(phaseWithHostProtocol('running', true), 'running')
  assert.equal(phaseWithHostProtocol('running', false), 'stale-host')
  assert.equal(phaseWithHostProtocol('completed', false), 'stale-host')
})

test('推进时缺口去重、错误按阶段清理、会话 id 只在新值时改写', () => {
  const first = advance(makeRecord(), 'extracting', {
    progress: { stage: '提取资料', completed: 1, total: 4 },
    capabilityGaps: ['图片内容未识别', '图片内容未识别'],
    sessionId: 's-1',
  })
  assert.equal(first.ok, true)
  assert.deepEqual(first.record.capabilityGaps, ['图片内容未识别'], '缺口去重')
  assert.equal(first.record.sessionId, 's-1')

  const failed = advance(first.record, 'failed', { error: '取数失败' })
  assert.equal(failed.record.error, '取数失败')
  const rerun = advance({ ...failed.record, phase: 'running' }, 'running')
  assert.equal(rerun.ok, true)
  assert.equal(rerun.record.error, '', '重新运行要清掉上一次的失败理由')
  assert.equal(rerun.record.sessionId, 's-1', '没给新会话 id 时保留原来的')
})

// ── 注册表 ──────────────────────────────────────────────────────────────────

test('注册表：同一 ID 不许开两轮（两轮会抢同一个案例目录）', () => {
  const lifecycles = new ValuationLifecycles({ now: () => 1 })
  const open = (patch = {}) => lifecycles.open({
    valuationId: VAL_ID, casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'market', baseDate: '', digest: 'sha256:x', ...patch,
  })
  const first = open()
  assert.equal(first.ok, true, first.error)
  assert.equal(first.record.phase, 'draft')
  assert.equal(first.record.baseDate, '', '没选基准日就是空串')
  const second = open()
  assert.equal(second.ok, false)
  assert.match(second.error, /已被占用/)

  const blank = lifecycles.open({
    valuationId: '  ', casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'market', baseDate: '', digest: '',
  })
  assert.equal(blank.ok, false)
  assert.match(blank.error, /缺少估值 ID/)
})

test('注册表：按会话反查；取消是终态；对未知轮次的操作如实报错', () => {
  const lifecycles = new ValuationLifecycles({ now: () => 1 })
  lifecycles.open({
    valuationId: VAL_ID, casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'income', baseDate: '2026-06-30', digest: 'sha256:x', sessionId: 's-9',
  })
  assert.equal(lifecycles.bySession('s-9')?.valuationId, VAL_ID)
  assert.equal(lifecycles.bySession('s-other'), undefined)
  assert.equal(lifecycles.bySession(''), undefined)

  const cancelled = lifecycles.cancel(VAL_ID)
  assert.equal(cancelled.ok, true, cancelled.error)
  assert.equal(cancelled.record.phase, 'cancelled')
  const again = lifecycles.cancel(VAL_ID)
  assert.equal(again.ok, false, '终态不可再取消')
  assert.match(again.error, /终态/)

  assert.equal(lifecycles.get('别的 id'), undefined)
  assert.equal(lifecycles.update('别的 id', 'running').ok, false)
  assert.equal(lifecycles.cancel('').ok, false)
})

test('注册表：来源状态与能力缺口可逐次记录，缺口去重', () => {
  const lifecycles = new ValuationLifecycles({ now: () => 1 })
  lifecycles.open({
    valuationId: VAL_ID, casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'market', baseDate: '', digest: '',
  })
  lifecycles.setProviderState(VAL_ID, 'fang', { state: 'unauthenticated', attempts: 3, detail: '需要登录' })
  assert.equal(lifecycles.get(VAL_ID).providerStates.fang.state, 'unauthenticated')
  lifecycles.addCapabilityGap(VAL_ID, '安居客：无结构化数据')
  lifecycles.addCapabilityGap(VAL_ID, '安居客：无结构化数据')
  lifecycles.addCapabilityGap(VAL_ID, '   ')
  assert.deepEqual(lifecycles.get(VAL_ID).capabilityGaps, ['安居客：无结构化数据'])
  assert.equal(lifecycles.setProviderState('missing', 'fang', { state: 'x', attempts: 0, detail: '' }).ok, false)
  assert.equal(lifecycles.addCapabilityGap('missing', 'x').ok, false)
})

test('注册表有界：超限时淘汰最旧的记录（未结束的也一样），不留无界增长', () => {
  const lifecycles = new ValuationLifecycles({ maxEntries: 2, now: () => clock.value })
  const clock = { value: 1 }
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    clock.value = index + 1
    lifecycles.open({
      valuationId: id, casePath: `/cases/space/${id}`, workspaceId: 'w1', workspacePath: '/cases/space',
      method: 'market', baseDate: '', digest: '',
    })
  }
  assert.equal(lifecycles.size, 2)
  // 被淘汰的那一轮在 `valuation-status` 里表现为 `known: false` —— 界面据此说
  // "宿主没有这一轮的记录（重启或已被更新的轮次挤掉）"，而不是显示一条被改花的记录。
  assert.equal(lifecycles.get('a'), undefined, '最旧的被真的删掉')
  assert.equal(lifecycles.get('c')?.phase, 'draft', '最新的一轮还在')
})

test('注册表有界：全是终态时淘汰最旧的终态', () => {
  const lifecycles = new ValuationLifecycles({ maxEntries: 1, now: () => 1 })
  lifecycles.open({
    valuationId: 'old', casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'market', baseDate: '', digest: '',
  })
  lifecycles.cancel('old')
  lifecycles.open({
    valuationId: 'new', casePath: CASE, workspaceId: 'w1', workspacePath: '/cases/space',
    method: 'market', baseDate: '', digest: '',
  })
  assert.equal(lifecycles.get('old'), undefined, '终态可以直接淘汰')
  assert.equal(lifecycles.get('new')?.phase, 'draft')
})

// ── 子会话指令契约 ──────────────────────────────────────────────────────────

function facts(patch = {}) {
  return {
    valuationId: VAL_ID,
    casePath: CASE,
    assetType: 'real-estate',
    method: 'market',
    baseDate: '2026-06-30',
    supplementalPrompt: '',
    digest: 'sha256:abc',
    files: [{ fileName: '估值报告.pdf', relativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 1024 }],
    extraction: [{ fileName: '估值报告.pdf', parsed: true, fieldCount: 0, note: '' }],
    knowledge: [{ route: '估值与测算/房地产/02-市场法', source: 'dws', digest: 'sha256:k' }],
    // 来源策略（协议 39）：交接那一刻已知的**能力事实**，不是检索结果。
    sources: [
      { id: 'lianjia', label: '链家', tier: 'optional', state: 'unknown', evidence: 'archived-capture', reason: '交接时尚未检查该来源的登录状态' },
      { id: 'fang', label: '房天下', tier: 'optional', state: 'unknown', evidence: 'public-pattern', reason: '可补充来源' },
      { id: 'wuba', label: '58同城', tier: 'optional', state: 'unknown', evidence: 'public-pattern', reason: '可补充来源' },
    ],
    validateScripts: [
      { name: '工作簿契约', script: `${CASE}/scripts/check_workbook_contract.py`, args: ['估值底稿.xlsx'] },
      { name: '报告数据', script: `${CASE}/scripts/build_report_data.py`, args: ['--validate', '估值报告数据.json'] },
    ],
    ...patch,
  }
}

test('指令把每一项交付与技术边界都写出来（少一项子会话就会自己收尾）', () => {
  const prompt = valuationPrompt(facts())
  for (const required of [
    VAL_ID, CASE, 'real-estate', '市场法', '2026-06-30', '材料-源/估值报告.pdf',
    '估值报告数据.json', '估值报告.html', '估值底稿.xlsx',
    'crwu_valuation_artifact_validate', 'check_workbook_contract.py', 'build_report_data.py',
    'stage=parameters', '真实重算', 'capability_gaps',
  ]) {
    assert.equal(prompt.includes(required), true, `指令里缺少「${required}」`)
  }
  assert.equal(prompt.includes('估值与测算/房地产/02-市场法'), true, '知识来源要出现')
})

test('业务判据搬进 Wiki：指令只留"读哪一份"，不再复制方法阈值与来源顺序', () => {
  const prompt = valuationPrompt(facts())
  // 旧指令把选法顺序、可比性三条件、挂牌/成交口径、来源优先级与页数上限都抄了一份。
  // 抄一份的后果是**改知识库不再生效**（Agent 照着更旧的副本执行，两边都不报错）。
  for (const gone of [
    '可比性三条件同时满足',
    '挂牌 ≠ 成交',
    '数量不足照实说',
    '## 案例筛选规则',
    '不少于 3 个',
    '优先收益法',
  ]) {
    assert.equal(prompt.includes(gone), false, `业务判据「${gone}」只能留在知识正文里`)
  }
  // 取而代之：唯一的业务入口是资产 Skill 声明的**入口 Wiki**，按它的条件逐篇读。
  assert.match(prompt, /入口 Wiki/)
  assert.match(prompt, /按 Wiki 的/)
  assert.match(prompt, /_manifest\.json/, '要明说：不许读旧 manifest')
  assert.match(prompt, /crwu_valuation_knowledge_materialize/)
  assert.match(prompt, /stage=parameters/)
  assert.match(prompt, /wikiPaths/, '结构化参数仍按本轮 Wiki 路径取用')
  assert.equal(prompt.includes('`routeIds`'), false, '知识取用不再走 manifest 槽位')
  assert.equal(prompt.includes('availableRouteIds'), false)
})

test('来源策略随交接交给父会话：逐来源分档与原因，且说明登录不阻断', () => {
  const prompt = valuationPrompt(facts())
  assert.equal(prompt.includes('链家'), true)
  assert.equal(prompt.includes('房天下'), true)
  assert.equal(prompt.includes('58同城'), true, '协议 39 的来源阶梯要包含 58 同城')
  assert.match(prompt, /适配器依据 archived-capture/, '有归档字节的来源要说清依据')
  assert.match(prompt, /适配器依据 public-pattern/, '没验收的来源也要说清依据（不许含糊成"可用"）')
  assert.match(prompt, /登录是可选用能力/)
  assert.match(prompt, /渠道与降级策略/)
  assert.match(prompt, /区分"来源不覆盖 \/ 成功但无合格数据 \/ 未登录 \/ 访问失败 \/ 解析能力缺口"/)
})

test('未指定基准日时：指令明确禁止按基准日筛选与做日期修正，并要求登记', () => {
  const prompt = valuationPrompt(facts({ baseDate: '' }))
  assert.match(prompt, /本次未指定评估基准日/)
  assert.match(prompt, /不按基准日筛选案例/)
  assert.match(prompt, /不做交易日期修正/)
  assert.match(prompt, /manual_confirmation_items/)
  assert.equal(prompt.includes('2026-06-30'), false, '没选基准日时不许出现任何日期')
})

test('指定基准日时按它处理（不再出现"未指定"那段）', () => {
  const prompt = valuationPrompt(facts())
  assert.match(prompt, /评估基准日：2026-06-30/)
  assert.equal(prompt.includes('本次未指定评估基准日'), false)
})

test('三种指定方法分别保留请求且要求不伪造结论', () => {
  for (const [method, label] of [['market', '市场法'], ['income', '收益法'], ['cost', '成本法']]) {
    const prompt = valuationPrompt(facts({ method }))
    assert.equal(prompt.includes(label), true, method)
    assert.match(prompt, /不得伪造结论|不许伪造结论|不许用"行业惯例"/)
  }
})

test('知识不是"必需项"：没有「必需知识缺失即停止测算」这一档，也不再有 realestate.* 口径', () => {
  const prompt = valuationPrompt(facts())
  // 旧形态是 `knowledgeReady=false → 不要输出估值结论`。那一条的判据来自一个**硬编码的常量**，
  // 本身就是死分支；而"缺一份通用正文就整轮停"更是要删的东西。
  assert.equal(prompt.includes('必需知识'), false)
  assert.equal(prompt.includes('不要输出估值结论'), false)
  assert.equal(prompt.includes('realestate.'), false)
  // 缺失只影响相关计算，其余有依据的工作继续。
  assert.match(prompt, /入口不可读 \/ 空正文 \/ 同名歧义 \/ 无权限/)
  assert.match(prompt, /capability_gaps/)
})

test('指令事实里不再有 knowledgeReady 字段（硬编码 true 的死分支连字段一起删）', () => {
  const source = readFileSync(new URL('../../../src/host/domains/report-evaluation/prompt.ts', import.meta.url), 'utf8')
  assert.equal(source.includes('knowledgeReady'), false)
  const handoff = readFileSync(new URL('../../../src/host/operations/report-evaluation/handoff.ts', import.meta.url), 'utf8')
  assert.equal(handoff.includes('knowledgeReady'), false, '交接侧不许再硬编码"知识已就绪"')
})

test('少案例与用户复算：指令写明按编号选例、建新版本、旧版保留', () => {
  const prompt = valuationPrompt(facts())
  for (const needle of [
    '## 少案例与用户复算',
    '## 重算与回读（真实计算）', 'crwu_valuation_recalculate', '由 **Host 写**「重算结论.json」',
    '## 候选的批量筛选与优选', 'maxAdopted', '全部照抄本轮知识正文的取值', '硬性排除',
    '1～2 条可核案例', '不要**因为数量少就把所有金额清空',
    'crwu_valuation_revision', 'op=candidates', 'op=recompute', 'op=promote',
    '稳定编号', '不自动重搜', '旧版本、旧报告与旧底稿一律保留',
    '通过核对之前，当前版本指针不动',
  ]) {
    assert.equal(prompt.includes(needle), true, `指令里缺少「${needle}」`)
  }
})

test('用户补充要求单独成段，并明确不得覆盖安全规则与公式契约', () => {
  const prompt = valuationPrompt(facts({ supplementalPrompt: '请多考虑地铁因素' }))
  assert.match(prompt, /## 用户补充要求/)
  assert.match(prompt, /请多考虑地铁因素/)
  assert.match(prompt, /不得.*覆盖：安全规则/)
  assert.match(prompt, /工具边界/)
  assert.match(prompt, /公式契约/)
  // 没有补充要求时也要有一段明确说明，而不是留白（留白会让模型以为"用户没说话"= 可自由发挥）。
  const empty = valuationPrompt(facts())
  assert.match(empty, /（用户没有补充要求）/)
})

test('指令要求"读不出来就进缺口、不许编造"（这条是整份指令的底线）', () => {
  const prompt = valuationPrompt(facts())
  assert.match(prompt, /不许编造案例、字段或参数/)
  assert.match(prompt, /读不到就是读不到/)
  // 未解析的文件要**逐条列出**并说明为什么没解析，而不是笼统一句"部分资料无法读取"。
  const withUnparsed = valuationPrompt(facts({
    files: [
      { fileName: '估值报告.pdf', relativePath: '材料-源/估值报告.pdf', kind: 'pdf', sizeBytes: 1024 },
      { fileName: '扫描件.tif', relativePath: '材料-源/扫描件.tif', kind: 'image', sizeBytes: 2048 },
    ],
    extraction: [
      { fileName: '估值报告.pdf', parsed: true, fieldCount: 4, note: '' },
      { fileName: '扫描件.tif', parsed: false, fieldCount: 0, note: '没有可用的提取器' },
    ],
  }))
  assert.match(withUnparsed, /扫描件\.tif：\*\*未解析\*\*/)
  assert.match(withUnparsed, /没有可用的提取器/)
})
