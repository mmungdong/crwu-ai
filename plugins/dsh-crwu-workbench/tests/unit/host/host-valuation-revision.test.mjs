/**
 * 候选册的**稳定编号**与**修订索引**（协议 39 · 设计稿 §7）。
 *
 * 这两层共同支撑"用户在会话里按编号选例、生成新版并保留旧版"：
 * 编号必须跨轮次稳定（否则用户说的"3 号"会指向另一条房源），
 * 修订必须落盘且**通过核对才能成为当前版**（否则旧依据永久消失、半成品会被当成正式结论）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = new URL('../../../', import.meta.url)
const {
  candidateIdentityOf, canonicalListingUrl, emptyRegister, mergeCandidates, registerDigest,
  registerFromJson, resolveSelection,
} = await import(new URL('src/host/domains/report-evaluation/market/candidates.ts', ROOT).href)
const {
  REVISION_INDEX_FILE, appendRevision, currentRevisionOf, decideRevision, emptyRevisionIndex, failRevision,
  nextRevisionNumber, promoteRevision, revisionDirectoryOf, revisionIndexFromJson,
} = await import(new URL('src/host/domains/report-evaluation/delivery/revision.ts', ROOT).href)

const AT = '2026-10-15T05:00:00.000Z'
const caseOf = (name, area, price, patch = {}) => ({
  source: 'lianjia', url: `https://example.invalid/${name}`, community: name,
  buildingArea: area, price, unitPrice: null, transactionType: '挂牌', evidence: `来源证据/${name}.html`,
  status: 'near-miss', reason: '面积偏差超过规则上限', ...patch,
})

// ── 候选册：稳定编号 ────────────────────────────────────────────────────────

test('编号只增不重用：新身份接着发号，旧身份沿用原号', () => {
  const register = emptyRegister({ planId: 'plan-001', updatedAt: AT })
  const first = mergeCandidates(register, [caseOf('例1', 100, 5_000_000), caseOf('例2', 90, 4_500_000)], {
    round: 1, updatedAt: AT,
  })
  assert.deepEqual(first.added, [1, 2])
  assert.equal(first.register.nextNumber, 3)

  // 第二轮：例2 又出现（沿用 2 号），例3 是新身份（发 3 号）。
  const second = mergeCandidates(first.register, [caseOf('例2', 90, 4_500_000), caseOf('例3', 80, 4_000_000)], {
    round: 2, updatedAt: AT,
  })
  assert.deepEqual(second.added, [3])
  assert.deepEqual(second.updated, [2], '已见过的身份沿用旧编号并更新')
  assert.equal(second.register.entries.find((entry) => entry.identity === candidateIdentityOf(caseOf('例2', 90, 4_500_000)))?.number, 2)
  // 这一轮没出现的例1 **保留编号**、标记退休（不删、不重排）。
  const retired = second.register.entries.find((entry) => entry.number === 1)
  assert.equal(retired.retired, true)
  assert.equal(retired.identity, candidateIdentityOf(caseOf('例1', 100, 5_000_000)))
})

test('换关键字重搜不会重排编号：同一套房源拿到同一批号', () => {
  const register = emptyRegister({ planId: 'plan-001', updatedAt: AT })
  const a = mergeCandidates(register, [caseOf('甲', 100, 5_000_000), caseOf('乙', 90, 4_500_000)], { round: 1, updatedAt: AT })
  // 第二轮按另一个顺序返回同样的房源（换词 / 换排序的典型表现）。
  const b = mergeCandidates(a.register, [caseOf('乙', 90, 4_500_000), caseOf('甲', 100, 5_000_000)], { round: 1, updatedAt: AT })
  assert.deepEqual(b.added, [], '没有新身份')
  assert.deepEqual(b.updated.sort(), [1, 2])
  assert.equal(b.register.nextNumber, 3, '编号没有被重排')
})

test('用户编号只在方案内有效：未知 / 已退休编号单独报，不静默忽略', () => {
  const register = emptyRegister({ planId: 'plan-001', updatedAt: AT })
  const merged = mergeCandidates(register, [caseOf('甲', 100, 5_000_000), caseOf('乙', 90, 4_500_000)], { round: 1, updatedAt: AT })
  const second = mergeCandidates(merged.register, [caseOf('乙', 90, 4_500_000)], { round: 1, updatedAt: AT })

  const ok = resolveSelection(second.register, [2])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.selected.map((entry) => entry.number), [2])

  const retired = resolveSelection(second.register, [1])
  assert.equal(retired.ok, false)
  assert.deepEqual(retired.retired, [1], '退休的编号要单独说：它是"这条已经不在最新结果里了"')
  assert.deepEqual(retired.selected, [])

  const unknown = resolveSelection(second.register, [99])
  assert.equal(unknown.ok, false)
  assert.deepEqual(unknown.unknown, [99])

  // 用户写重了同一个编号：只算一次，但如实报出来。
  const dup = resolveSelection(second.register, [2, 2])
  assert.deepEqual(dup.duplicated, [2])
  assert.deepEqual(dup.selected.map((entry) => entry.number), [2])
  assert.equal(resolveSelection(second.register, []).ok, false, '一个都没选就不算有效选择')
})

test('身份以规范化 URL 为准：事实相同但 URL 不同不是同一条', () => {
  const base = { community: '阳光小区', buildingArea: 100, price: 5_000_000 }
  const a = candidateIdentityOf({ ...base, url: 'https://example.invalid/a' })
  const b = candidateIdentityOf({ ...base, url: 'https://example.invalid/b' })
  assert.notEqual(a, b)
  assert.notEqual(a, '')
  assert.equal(candidateIdentityOf({ ...base, url: 'https://example.invalid/a' }), a)

  // Same URL with an updated price keeps the identity (no new number).
  assert.equal(candidateIdentityOf({ ...base, price: 5_200_000, url: 'https://example.invalid/a' }), a)

  // Tracking-only query change is the same listing; identity params are not stripped.
  assert.equal(
    candidateIdentityOf({ url: 'https://example.invalid/a?utm_source=x' }),
    candidateIdentityOf({ url: 'https://example.invalid/a' }),
  )
  assert.notEqual(
    candidateIdentityOf({ url: 'https://example.invalid/a?id=1' }),
    candidateIdentityOf({ url: 'https://example.invalid/a?id=2' }),
  )
  assert.equal(candidateIdentityOf({}), '')
})

test('候选册：事实相同但 URL 不同各自独立编号；同 URL 改价沿用编号', () => {
  const register = emptyRegister({ planId: 'p', updatedAt: AT })
  const facts = {
    source: 'lianjia', community: '阳光小区', buildingArea: 100, price: 5_000_000,
    unitPrice: 50_000, transactionType: '成交', evidence: '来源证据/a.html',
    status: 'adopted', reason: '按知识正文判定',
  }
  const first = mergeCandidates(register, [
    { ...facts, url: 'https://example.invalid/a' },
    { ...facts, url: 'https://example.invalid/b' },
  ], { round: 1, updatedAt: AT })
  assert.deepEqual(first.added, [1, 2], '不同 URL 即便小区/面积/价格相同也是两条候选')
  assert.equal(first.register.nextNumber, 3)

  const priceUpdated = mergeCandidates(first.register, [
    { ...facts, price: 5_200_000, unitPrice: 52_000, url: 'https://example.invalid/a' },
  ], { round: 2, updatedAt: AT })
  assert.deepEqual(priceUpdated.added, [])
  assert.deepEqual(priceUpdated.updated, [1], '同一 URL 改价沿用原编号')
  assert.equal(priceUpdated.register.entries.find((entry) => entry.number === 2).retired, true)
})

test('遗留 c: 身份按唯一同 URL 匹配迁移，保留原编号', () => {
  const seeded = registerFromJson({
    schemaVersion: 'crwu.valuation.candidates.v1',
    planId: 'p', nextNumber: 8, updatedAt: AT,
    entries: [{
      number: 7, identity: 'c:老小区|99|4900000', source: 'lianjia',
      url: 'https://example.invalid/legacy', community: '老小区', unitPrice: null,
      buildingArea: 99, transactionType: '成交', evidence: '来源证据/legacy.html',
      status: 'adopted', reason: '按知识正文判定', firstSeenRound: 1, retired: false,
    }],
  })
  assert.notEqual(seeded, null)
  const incoming = {
    source: 'lianjia', url: 'https://example.invalid/legacy', community: '老小区',
    buildingArea: 99, price: 5_200_000, unitPrice: 52_525, transactionType: '成交',
    evidence: '来源证据/legacy.html', status: 'adopted', reason: '按知识正文判定',
  }
  const migrated = mergeCandidates(seeded, [incoming], { round: 2, updatedAt: AT })
  assert.deepEqual(migrated.added, [], '唯一同 URL 匹配的遗留身份应迁移，不能重发编号')
  assert.deepEqual(migrated.updated, [7])
  assert.equal(migrated.register.nextNumber, 8, '迁移不推进 nextNumber')

  // Migration must rewrite identity, otherwise the next merge would re-add it.
  const again = mergeCandidates(migrated.register, [incoming], { round: 3, updatedAt: AT })
  assert.deepEqual(again.added, [])
  assert.deepEqual(again.updated, [7])
})

test('候选册落盘可读回；nextNumber 不会被读小（否则会重发号）', () => {
  const register = mergeCandidates(emptyRegister({ planId: 'p', updatedAt: AT }), [caseOf('甲', 100, 5_000_000)], { round: 1, updatedAt: AT }).register
  const round = registerFromJson(JSON.parse(JSON.stringify(register)))
  assert.deepEqual(round, register)
  // 篡改成一个更小的 nextNumber：读回来必须被抬到"最大编号 + 1"。
  const tampered = registerFromJson({ ...JSON.parse(JSON.stringify(register)), nextNumber: 0 })
  assert.equal(tampered.nextNumber, 2)
  assert.equal(registerFromJson({ schemaVersion: '别的' }), null)
})

test('候选册指纹只覆盖编号与身份（跨轮次可比）', () => {
  const base = mergeCandidates(emptyRegister({ planId: 'p', updatedAt: AT }), [caseOf('甲', 100, 5_000_000)], { round: 1, updatedAt: AT }).register
  const sameShape = mergeCandidates(emptyRegister({ planId: 'p', updatedAt: AT }), [caseOf('甲', 100, 5_000_000, { reason: '换了理由' })], { round: 1, updatedAt: AT }).register
  assert.equal(registerDigest(base), registerDigest(sameShape))
})

// ── 修订索引 ────────────────────────────────────────────────────────────────

const request = (patch = {}) => ({
  changeKind: 'user-case-selection', reason: '用户要求把 2 号纳入重算',
  adoptedNumbers: [2], candidatesDigest: 'sha256:bank1', knowledgeDigest: 'sha256:k1',
  templateDigest: 'sha256:t1', searchRound: 1, ...patch,
})

test('第 1 版是初版（没有修订子目录），第 2 版起落在 修订/<n>/', () => {
  assert.equal(REVISION_INDEX_FILE, '修订记录.json')
  assert.equal(revisionDirectoryOf(1), '')
  assert.equal(revisionDirectoryOf(2), '修订/2')
  assert.equal(revisionDirectoryOf(0), '')
})

test('新版本一出生是 pending：核对通过之前不动当前指针', () => {
  const index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const decision = decideRevision(index, request(), { now: AT })
  assert.equal(decision.kind, 'ok')
  assert.equal(decision.record.revision, 1)
  assert.equal(decision.record.parentRevision, 0)
  assert.equal(decision.record.state, 'pending')
  assert.deepEqual(decision.record.adoptedNumbers, [2])
  const appended = appendRevision(index, decision.record, AT)
  assert.equal(appended.currentRevision, 0, '还没有任何核对通过的版本')
  assert.equal(currentRevisionOf(appended), null)
  assert.equal(decision.record.ruleVersion, 'v1', '不换规则时沿用父版本的规则版本')
})

test('重复提交（双击 / 超时重试）不新建版本', () => {
  const index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const first = decideRevision(index, request(), { now: AT })
  const appended = appendRevision(index, first.record, AT)
  const again = decideRevision(appended, request(), { now: '2026-10-15T05:01:00.000Z' })
  assert.equal(again.kind, 'duplicate')
  assert.equal(again.revision, 1)
  assert.equal(appended.records.length, 1)
  // 编号顺序不同但集合相同也算重复（用户写"3、2"与"2、3"是一回事）。
  const reordered = decideRevision(appended, request({ adoptedNumbers: [2] }), { now: AT })
  assert.equal(reordered.kind, 'duplicate')
  // 原因不同 = 真的是一次不同的修订。
  assert.equal(decideRevision(appended, request({ reason: '再纳入 3 号' }), { now: AT }).kind, 'ok')
})

test('变更必须具体：没原因 / 按编号纳入却一个号都没给 → invalid', () => {
  const index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const noReason = decideRevision(index, request({ reason: '  ' }), { now: AT })
  assert.equal(noReason.kind, 'invalid')
  assert.match(noReason.reason, /变更原因/)
  const noNumbers = decideRevision(index, request({ adoptedNumbers: [] }), { now: AT })
  assert.equal(noNumbers.kind, 'invalid')
  assert.match(noNumbers.reason, /候选编号/)
  // 补搜 / 换规则不需要编号。
  assert.equal(decideRevision(index, request({ changeKind: 'research-round', adoptedNumbers: [] }), { now: AT }).kind, 'ok')
  assert.equal(decideRevision(index, request({ changeKind: '瞎编' }), { now: AT }).kind, 'invalid')
})

test('只有核对**本版**的回执才能提升；提升会把上一版标成 superseded 并保留', () => {
  let index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const first = decideRevision(index, request({ changeKind: 'manual', reason: '初版' }), { now: AT })
  index = appendRevision(index, first.record, AT)

  assert.equal(promoteRevision(index, 1, { checked: false, checkedRevision: 1, checkedAt: AT }).ok, false)
  const wrongRevision = promoteRevision(index, 1, { checked: true, checkedRevision: 2, checkedAt: AT })
  assert.equal(wrongRevision.ok, false)
  assert.match(wrongRevision.reason, /对应的是第 2 版/)

  const promoted = promoteRevision(index, 1, { checked: true, checkedRevision: 1, checkedAt: AT })
  assert.equal(promoted.ok, true)
  const current = promoted.index
  assert.equal(current.currentRevision, 1)
  assert.equal(currentRevisionOf(current).state, 'current')

  // 第二版：提升之后第一版变成 superseded，记录仍在（旧报告与旧底稿可读）。
  const second = decideRevision(current, request({ reason: '加入 2 号' }), { now: AT })
  const appended = appendRevision(current, second.record, AT)
  const promotedAgain = promoteRevision(appended, second.revision, {
    checked: true, checkedRevision: second.revision, checkedAt: AT,
  })
  assert.equal(promotedAgain.ok, true)
  assert.equal(promotedAgain.index.currentRevision, 2)
  const byNumber = new Map(promotedAgain.index.records.map((record) => [record.revision, record]))
  assert.equal(byNumber.get(1).state, 'superseded')
  assert.equal(byNumber.get(2).state, 'current')
})

test('失败的版本占号但永远不能成为当前版（回滚：指针不动）', () => {
  let index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const first = decideRevision(index, request({ changeKind: 'manual', reason: '初版' }), { now: AT })
  index = appendRevision(index, first.record, AT)
  index = promoteRevision(index, 1, { checked: true, checkedRevision: 1, checkedAt: AT }).index

  const second = decideRevision(index, request({ reason: '加入 2 号' }), { now: AT })
  index = appendRevision(index, second.record, AT)
  index = failRevision(index, second.revision, '案例证据缺失', AT)

  const promote = promoteRevision(index, 2, { checked: true, checkedRevision: 2, checkedAt: AT })
  assert.equal(promote.ok, false)
  assert.match(promote.reason, /标记为失败/)
  assert.equal(index.currentRevision, 1, '回滚：当前指针留在上一版')
  assert.equal(nextRevisionNumber(index), 3, '失败的版本占号，下一版是 3')
})

test('修订索引落盘可读回；当前指针指向不存在的记录时退回 0', () => {
  let index = emptyRevisionIndex({ planId: 'plan-001', updatedAt: AT })
  const first = decideRevision(index, request({ changeKind: 'manual', reason: '初版' }), { now: AT })
  index = appendRevision(index, first.record, AT)
  index = promoteRevision(index, 1, { checked: true, checkedRevision: 1, checkedAt: AT }).index
  const round = revisionIndexFromJson(JSON.parse(JSON.stringify(index)))
  assert.deepEqual(round, index)

  const dangling = revisionIndexFromJson({ ...JSON.parse(JSON.stringify(index)), currentRevision: 7 })
  assert.equal(dangling.currentRevision, 0, '不许挂一个空指针')
  assert.equal(revisionIndexFromJson({ schemaVersion: '别的' }), null)
})

// Canonical URL: invalid / non-http is empty; scheme and fragment stay identity-bearing.

test('canonical URL：非法 / 非 http 返回空，身份参数与 scheme/hash 保留，跟踪参数折叠', () => {
  assert.equal(canonicalListingUrl('not a url'), '')
  assert.equal(canonicalListingUrl(''), '')
  assert.equal(canonicalListingUrl('javascript:alert(1)'), '')
  assert.equal(canonicalListingUrl('ftp://x.example/a'), '')

  // Tracking-only params collapse; identity-bearing query survives.
  assert.equal(
    canonicalListingUrl('https://x.example/a?utm_source=1&gclid=2&id=7'),
    canonicalListingUrl('https://x.example/a?id=7'),
  )
  assert.notEqual(
    canonicalListingUrl('https://x.example/a?id=1'),
    canonicalListingUrl('https://x.example/a?id=2'),
  )
  // Scheme and fragment identify distinct resources: they must not be silently merged.
  assert.notEqual(
    canonicalListingUrl('http://x.example/a?id=1'),
    canonicalListingUrl('https://x.example/a?id=1'),
  )
  assert.notEqual(
    canonicalListingUrl('https://x.example/a?id=1#one'),
    canonicalListingUrl('https://x.example/a?id=1#two'),
  )
})
