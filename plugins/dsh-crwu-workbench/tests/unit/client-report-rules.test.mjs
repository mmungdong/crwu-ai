/**
 * 第 6 层（Client 报告页规则）的单元测试。
 *
 * 这一层是**纯规则**，所以可以脱离 React 直接测。三条规则各有真实后果，
 * 每条都要能反向失败：
 * 1. 「停止」与「重新审核」互斥 —— 破了两条子会话会对写同一个案例目录；
 * 2. 云端已有意见 → 主按钮是「重新审核」且要二次确认；
 * 3. 「重传 OSS」只在「已出结果且未上传」时出现。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../', import.meta.url)

const {
  rowKeyOf,
  hasCloudResult,
  hasAuditInfo,
  statusBadge,
  riskBadge,
  childIsLive,
  startLabel,
  deriveRowView,
  primaryActionOf,
  menuActionsOf,
  formatTime,
  resultItems,
  buildRows,
  filterModeText,
  pageCount,
  pendingArgs,
  openReportNotice,
} = await import(new URL('src/client/features/report-audit/row.ts', ROOT).href)

const GATING = { canDispatch: true, canStart: true }
const SEQ = '2026-301705-LX10170'
const TASK = { seqNo: SEQ, name: '某项目报告' }

/** 一条审核记录，只覆盖被断言的字段。 */
function audit(patch = {}) {
  return {
    key: SEQ, childId: 'child-1', seqNo: SEQ, project: 'P', objectId: 'o1', startedAt: '2026-09-20T02:16:27Z',
    parentSessionId: 'p1', status: 'running', ended: false, stopped: false, stopReason: '', endReason: '',
    casePath: '', resultFile: '', htmlFile: '', caseName: '', uploadedAt: '', uploadError: '', ossPrefix: '',
    attempt: 1, ...patch,
  }
}

/** 一份云端交付件。 */
function cloud(patch = {}) {
  return { seqNo: SEQ, files: [], htmlKey: `${SEQ}/审核意见.html`, jsonKey: `${SEQ}/审核结果.json`, ...patch }
}

// 用户 2026-09-22 的操作列口径：主操作只留一个，其余动作进 ••• 菜单。
// 这些回归用例关心的是"这个动作还在不在、要不要确认"，所以按**主位 + 菜单**合并查，
// 位置变化由专门的结构用例盯着（见下面那条"操作列结构"用例）。
const allActions = (view) => [primaryActionOf(view), ...menuActionsOf(view)].filter((entry) => entry !== null)
const idsOf = (view) => allActions(view).map((button) => button.id)
const button = (view, id) => allActions(view).find((entry) => entry.id === id)

// ── 基础工具 ────────────────────────────────────────────────────────────────

test('rowKeyOf prefers the serial number and falls back to the name', () => {
  assert.equal(rowKeyOf({ seqNo: SEQ, name: 'x' }), SEQ)
  assert.equal(rowKeyOf({ seqNo: '', name: 'x' }), 'x')
})

test('hasCloudResult needs an html artifact; hasAuditInfo also needs the json', () => {
  assert.equal(hasCloudResult(cloud()), true)
  assert.equal(hasCloudResult(cloud({ htmlKey: '' })), false)
  assert.equal(hasCloudResult(null), false)
  // 只有 HTML 时抽屉里没有内容，所以不给「审核信息」入口。
  assert.equal(hasAuditInfo(cloud()), true)
  assert.equal(hasAuditInfo(cloud({ jsonKey: '' })), false)
})

test('statusBadge never calls a finished-but-unscanned audit a failure', () => {
  assert.deepEqual(statusBadge('running'), { text: '审核中', tone: 'medium' })
  assert.deepEqual(statusBadge('stopped'), { text: '已停止', tone: 'low' })
  assert.deepEqual(statusBadge('failed'), { text: '已中断', tone: 'high' })
  assert.deepEqual(statusBadge('done'), { text: '已出结果', tone: 'ok' })
  // idle = 正常跑完但还没扫到交付件：说成失败会让用户去重启一个已经跑完的审核。
  assert.deepEqual(statusBadge('idle'), { text: '未出结果', tone: 'low' })
  assert.deepEqual(statusBadge('不认识的状态'), { text: '未出结果', tone: 'low' })
})

test('formatTime shows HH:MM:SS and passes junk through', () => {
  assert.match(formatTime('2026-09-20T02:16:27Z'), /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(formatTime('not-a-date'), 'not-a-date')
  assert.equal(formatTime(''), '')
})

test('filterModeText and pageCount are the display-only helpers', () => {
  assert.equal(filterModeText('equal'), ' · 精确匹配')
  assert.equal(filterModeText('contains'), ' · 模糊匹配')
  assert.equal(filterModeText(''), '')
  assert.equal(pageCount(0, 20), 1)
  assert.equal(pageCount(37, 20), 2)
  assert.equal(pageCount(37, 0), 1, '页大小非法时不能除零')
})

test('pendingArgs keeps the active query while paging or refreshing', () => {
  assert.deepEqual(pendingArgs('2026-301705', 3), { query: '2026-301705', page: 3 })
  assert.deepEqual(pendingArgs('', 1), { query: '', page: 1 })
})

// ── 未发起过：主按钮与确认 ──────────────────────────────────────────────────

test('a report never audited offers AI 审核, without confirmation', () => {
  const view = deriveRowView(TASK, null, null, GATING)
  assert.deepEqual(view.badges, [])
  assert.deepEqual(idsOf(view), ['start'])
  assert.equal(button(view, 'start').label, 'AI 审核')
  assert.equal(button(view, 'start').confirm, false)
  assert.equal(button(view, 'start').retry, false)
  assert.deepEqual(view.notes, [])
})

test('已有线上报告：主位是查看报告，••• 里给带确认的重新审核', () => {
  // 否则用户会以为从来没审过。
  const view = deriveRowView(TASK, null, cloud(), GATING)
  // 有线上报告 → 主位就是「查看报告」；「重新审核」在 ••• 里（不会随数据加载跳变）。
  assert.equal(primaryActionOf(view).id, 'cloud-report')
  assert.equal(button(view, 'restart').label, '重新审核')
  assert.equal(button(view, 'restart').confirm, true)
  assert.equal(button(view, 'restart').retry, true)
  assert.equal(button(view, 'cloud-report').label, '查看报告')
  assert.equal(button(view, 'audit-info').label, '查看审核信息')
  assert.equal(primaryActionOf(view).id, 'cloud-report', '主位只留一个：查看报告')
})

test('the cloud info entry needs both artifacts', () => {
  assert.equal(idsOf(deriveRowView(TASK, null, cloud({ jsonKey: '' }), GATING)).includes('audit-info'), false)
  assert.equal(idsOf(deriveRowView(TASK, null, cloud({ htmlKey: '' }), GATING)).includes('cloud-report'), false)
})

test('gating notes explain why the start button is unavailable', () => {
  const noDispatch = deriveRowView(TASK, null, null, { canDispatch: false, canStart: true })
  assert.equal(button(noDispatch, 'start').disabled, true)
  assert.deepEqual(noDispatch.notes, ['需先通过钉钉认证'])

  const busyElsewhere = deriveRowView(TASK, null, null, { canDispatch: true, canStart: false })
  assert.equal(button(busyElsewhere, 'start').disabled, true)
  assert.deepEqual(busyElsewhere.notes, ['已有审核在进行中'])
})

test('creating a child shows 创建中… and disables every start button', () => {
  const creating = deriveRowView(TASK, null, null, { canDispatch: true, canStart: true, auditBusy: SEQ })
  assert.equal(button(creating, 'start').label, '创建中…')
  assert.equal(button(creating, 'start').disabled, true)
})

// ── 已有记录：互斥规则 ──────────────────────────────────────────────────────

test('a live child offers stop and NOT a restart', () => {
  // 破这条 = 同一份报告能跑两条子会话，它们往同一个案例目录对写。
  const view = deriveRowView(TASK, audit({ status: 'running', childAlive: true }), null, GATING)
  // 用户 2026-09-22 口径：正在审核时主位是「审核中」（不可点，避免重复触发），
  // 停止进 ••• 菜单；「查看会话」已删（与小鲸鱼重复）。
  assert.equal(primaryActionOf(view).id, 'progress')
  assert.equal(primaryActionOf(view).disabled, true)
  assert.deepEqual(menuActionsOf(view).map((entry) => entry.id), ['stop'])
  assert.equal(idsOf(view).includes('start'), false)
  assert.equal(idsOf(view).includes('open-session'), false, '查看会话已删除')
})

test('跑完的记录：主操作就是重新审核（菜单里不再重复一个），且没有停止', () => {
  const view = deriveRowView(TASK, audit({ status: 'idle', ended: true, childAlive: false }), null, GATING)
  assert.equal(idsOf(view).includes('stop'), false)
  // 用户 2026-09-22 口径：有记录就是「重新审核」，不要再同时出现「AI 审核」。
  assert.equal(primaryActionOf(view).label, '重新审核', '主位是重新审核')
  assert.equal(primaryActionOf(view).confirm, true, '重新审核一律二次确认（会覆盖结果）')
  assert.equal(menuActionsOf(view).some((entry) => entry.id === 'restart'), false, '菜单里不许重复')
  // 启动类动作**全局只出现一次**（主位那个 start 的 label 已经是「重新审核」）。
  assert.equal(
    idsOf(view).filter((id) => id === 'start' || id === 'restart').length,
    1,
    '启动 / 重新审核只允许出现一个',
  )
})

test('a child that is alive but not running still shows the stop button', () => {
  // childAlive 来自 Host（子代理清单），比前端的 status 可靠；status 只作兜底。
  const view = deriveRowView(TASK, audit({ status: 'idle', childAlive: true }), null, GATING)
  assert.equal(idsOf(view).includes('stop'), true)
  assert.equal(idsOf(view).includes('start'), false)
  // 「未出结果 / 已出结果 / 已上云 / 第 N 次」这类状态噪音已从列表移除（进详情）。
  assert.deepEqual(view.badges.map((badge) => badge.text), ['会话仍存活'])
})

test('a stopped or ended record never offers another stop', () => {
  const stopped = deriveRowView(TASK, audit({ status: 'stopped', stopped: true, childAlive: true }), null, GATING)
  assert.equal(idsOf(stopped).includes('stop'), false, 'stopped 优先于 childAlive')

  const ended = deriveRowView(TASK, audit({ status: 'done', ended: true, childAlive: true }), null, GATING)
  assert.equal(idsOf(ended).includes('stop'), false)
})

test('a running record without a childId cannot be stopped', () => {
  const view = deriveRowView(TASK, audit({ status: 'running', childId: '' }), null, GATING)
  assert.equal(idsOf(view).includes('stop'), false, '没有 childId 就没有停止入口')
  assert.equal(idsOf(view).includes('open-session'), false)
})

// ── 上传相关按钮与徽章 ──────────────────────────────────────────────────────

test('retry-upload appears only for a delivered result that is not uploaded yet', () => {
  const pendingUpload = deriveRowView(TASK, audit({ status: 'done', ended: true, resultFile: 'r.json' }), null, GATING)
  assert.equal(idsOf(pendingUpload).includes('retry-upload'), true)

  const uploaded = deriveRowView(TASK, audit({ status: 'done', ended: true, uploadedAt: '2026-09-20T03:00:00Z' }), null, GATING)
  assert.equal(idsOf(uploaded).includes('retry-upload'), false)
  assert.equal(uploaded.badges.map((badge) => badge.text).includes('已上云'), false, '已上云不再占列表')

  const running = deriveRowView(TASK, audit({ status: 'running', childAlive: true }), null, GATING)
  assert.equal(idsOf(running).includes('retry-upload'), false, '还没出结果就没有可重传的东西')
})

test('upload failure is surfaced as a badge and a note', () => {
  const view = deriveRowView(TASK, audit({ status: 'done', ended: true, uploadError: 'AccessDenied' }), null, GATING)
  assert.equal(view.badges.map((badge) => badge.text).includes('上云失败'), true)
  // 错误原文不再挤在列表里（进 ••• → 查看审核信息），但"失败"这件事必须一眼看得见。
  assert.equal(view.notes.includes('AccessDenied'), false, '错误原文进详情，不占列表')
})

test('重试次数与启动时间不再占列表（进详情）', () => {
  const view = deriveRowView(TASK, audit({ status: 'running', childAlive: true, attempt: 3 }), null, GATING)
  assert.equal(view.badges.map((badge) => badge.text).includes('第 3 次'), false)
  assert.equal(view.notes.some((note) => /^启动/.test(note)), false)
  // 但数据本身仍在审核记录里（详情面板/审核信息从 AuditView 读，不从这一行读）。
  assert.equal(view.key, rowKeyOf(TASK))
})

test('停止原因不再占列表（进详情）', () => {
  // 状态说明不是操作：列表只留操作，原因/时间这类进 ••• → 查看审核信息。
  const running = deriveRowView(TASK, audit({ status: 'running', childAlive: true, stopReason: '旧原因' }), null, GATING)
  assert.equal(running.notes.some((note) => note.includes('旧原因')), false)
  const stopped = deriveRowView(TASK, audit({ status: 'stopped', stopped: true, stopReason: '已被用户手动停止' }), null, GATING)
  assert.equal(stopped.notes.some((note) => note.includes('已被用户手动停止')), false)
})

test('local HTML and session buttons follow the artifacts that exist', () => {
  const view = deriveRowView(TASK, audit({ status: 'idle', ended: true, htmlFile: '审核意见.html', childId: 'c9' }), null, GATING)
  assert.equal(idsOf(view).includes('open-html'), true)
  assert.equal(idsOf(view).includes('open-session'), false, '查看会话已删除（与小鲸鱼重复）')

  const none = deriveRowView(TASK, audit({ status: 'idle', ended: true, htmlFile: '', childId: '' }), null, GATING)
  assert.equal(idsOf(none).includes('open-html'), false)
  assert.equal(idsOf(none).includes('open-session'), false)
})

test('busy flags relabel the buttons instead of silently doing nothing', () => {
  const stopping = deriveRowView(TASK, audit({ status: 'running', childAlive: true }), null, { ...GATING, stopBusy: true })
  assert.equal(button(stopping, 'stop').label, '停止中…')
  assert.equal(button(stopping, 'stop').disabled, true)

  const retrying = deriveRowView(TASK, audit({ status: 'done', ended: true }), null, { ...GATING, retryBusy: true })
  assert.equal(button(retrying, 'retry-upload').label, '重传中…')
  assert.equal(button(retrying, 'retry-upload').disabled, true)
})

// ── 结果页与整表合成 ────────────────────────────────────────────────────────

test('resultItems keeps only items with artifacts, newest first', () => {
  const items = resultItems({
    a: cloud({ seqNo: '2026-1-A1', htmlKey: 'h', jsonKey: 'j' }),
    b: cloud({ seqNo: '2026-3-C3', htmlKey: 'h', jsonKey: '' }),
    c: cloud({ seqNo: '2026-2-B2', htmlKey: '', jsonKey: '' }),
    d: cloud({ seqNo: '2026-4-D4', htmlKey: '', jsonKey: 'j' }),
  })
  assert.deepEqual(items.map((item) => item.seqNo), ['2026-4-D4', '2026-3-C3', '2026-1-A1'])
})

test('resultItems tolerates an empty or missing index', () => {
  assert.deepEqual(resultItems(null), [])
  assert.deepEqual(resultItems({}), [])
})

test('buildRows joins tasks with their audit record and cloud item', () => {
  const other = { ...TASK, seqNo: '2026-999999-XX1', name: '另一条' }
  const rows = buildRows(
    [TASK, other],
    { [SEQ]: audit({ status: 'done', ended: true, uploadedAt: '2026-09-20T03:00:00Z' }) },
    { [SEQ]: cloud({ jsonKey: '' }) },
    GATING,
  )
  assert.equal(rows.length, 2)
  // 「已出结果」这类状态噪音已从列表移除：有线上报告时主位就是「查看报告」，
  // 用户点得动它本身已经证明结果存在。
  assert.equal(rows[0].badges.some((badge) => badge.text === '已出结果'), false)
  assert.equal(primaryActionOf(rows[0]).id, 'cloud-report')
  assert.equal(rows[0].buttons.some((entry) => entry.id === 'audit-info'), false, '只有 HTML 时没有审核信息入口')
  // 第二条既没有记录也没有云端结果 → 只能发起。
  assert.deepEqual(idsOf(rows[1]), ['start'])
  assert.equal(button(rows[1], 'start').label, 'AI 审核')
})

test('startLabel and childIsLive are exported for the renderer to reuse', () => {
  assert.equal(startLabel(null), 'AI 审核')
  assert.equal(startLabel(cloud()), '重新审核')
  assert.equal(childIsLive(audit({ status: 'running' })), true)
  assert.equal(childIsLive(audit({ status: 'running', ended: true })), false)
  assert.equal(childIsLive(audit({ status: 'idle', childAlive: true })), true)
})

// ── 风险等级（这一列是用户要求「透出来」的）────────────────────────────────

test('riskBadge surfaces the raw level and only uses tone for severity', () => {
  // 取值域来自本机真实抽样：A / B / C（50 条：B 46、A 3、C 1）。
  assert.deepEqual(riskBadge('A'), { text: 'A', tone: 'high' })
  assert.deepEqual(riskBadge('B'), { text: 'B', tone: 'medium' })
  assert.deepEqual(riskBadge('C'), { text: 'C', tone: 'low' })
  // 中文写法（别的表单可能是这套）也要认，别整列变成「未知」。
  assert.deepEqual(riskBadge('高'), { text: '高', tone: 'high' })
  assert.deepEqual(riskBadge('中'), { text: '中', tone: 'medium' })
  assert.deepEqual(riskBadge('低'), { text: '低', tone: 'low' })
  // 没填 ≠ 零风险：给一个中性占位符，而不是空白（空白看起来像渲染坏了）。
  assert.deepEqual(riskBadge(''), { text: '—', tone: 'low' })
  assert.deepEqual(riskBadge('   '), { text: '—', tone: 'low' })
  // 原始值一律不改写。
  assert.equal(riskBadge('D').text, 'D')
})

// ── 「查看报告」的结果怎么说话（用户报过「查看报告打不开」且界面毫无反应）──────

test('openReportNotice names both failure kinds and stays quiet on success', () => {
  // `ok` 只代表签名成功；打开浏览器是另一步。早先客户端只判 `ok`，于是
  // `opened:false` 时什么都不说 —— 用户看到的就是「点了没反应」。
  assert.equal(openReportNotice({ ok: true, opened: true }), '', '真的打开了就不要打扰用户')
  assert.equal(openReportNotice({ ok: true, opened: true, openError: '噪声' }), '', '成功时忽略残留的 openError')

  const notOpened = openReportNotice({ ok: true, opened: false, openError: '沙箱拒绝了 open 命令' })
  assert.match(notOpened, /没能打开浏览器/)
  assert.match(notOpened, /沙箱拒绝了 open 命令/, '真实原因必须带出来，否则还是无从下手')

  assert.match(openReportNotice({ ok: true, opened: false }), /没能打开浏览器/, '没有原因也要说「没打开」')

  // 签名/前缀这类的硬失败走 error。
  assert.equal(openReportNotice({ ok: false, error: '对象不在配置的 OSS 前缀内' }), '对象不在配置的 OSS 前缀内')
  assert.equal(openReportNotice({ ok: false, error: '' }), '打开报告失败', '空原因也要给一句能看的话')
})
