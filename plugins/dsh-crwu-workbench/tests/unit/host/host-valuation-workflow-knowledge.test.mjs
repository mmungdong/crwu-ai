/**
 * Knowledge requirement binding for the planned valuation workflow (tests-only).
 *
 * Prose and tables are first-class knowledge: a parameter passes only when it is
 * bound to a scope-approved source body, an exact quote and the applicable facts,
 * with a unit the quoted text actually carries. Unknown values stay unknown.
 *
 * Fixtures use text explicitly labelled synthetic; no real threshold is hard-coded.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  digestOf,
  loadListingReferenceAsset,
  loadRequirements,
  syntheticContext,
  syntheticCountCandidate,
  syntheticPolicyProse,
  syntheticPolicyTable,
  syntheticTableCandidate,
} from '../../helpers/valuation-workflow-fixture.mjs'

const ROOT = new URL('../../../', import.meta.url)
const knowledge = await import(new URL('src/host/domains/report-evaluation/knowledge/index.ts', ROOT).href)
const wikiLinks = await import(new URL('src/host/domains/report-evaluation/knowledge/wiki-links.ts', ROOT).href)

function gapKinds(result) {
  return result.gaps.map((gap) => gap.kind)
}

test('a prose parameter bound to an exact quote, unit and applies-to context is accepted', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const source = syntheticPolicyProse()
  const result = await bindKnowledgeRequirements({
    sources: [source],
    candidates: [syntheticCountCandidate()],
    context: syntheticContext(),
  })

  assert.equal(result.ok, true, result.gaps.map((gap) => `${gap.kind}: ${gap.message}`).join(' | '))
  assert.equal(result.accepted.length, 1)
  const accepted = result.accepted[0]
  assert.equal(accepted.requirementId, 'synthetic.comparable-count.min')
  assert.equal(accepted.sourceId, source.sourceId)
  assert.equal(accepted.sourceDigest, source.digest)
  assert.equal(accepted.resolvedPath, source.path, 'the accepted requirement carries the library path')
  assert.equal(accepted.section, '合成条款甲')
  assert.equal(accepted.parameter.value, 3)
  assert.equal(accepted.parameter.unit, '个')
})

test('a table parameter keeps its row quote, unit and applies-to context', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyTable()],
    candidates: [syntheticTableCandidate()],
    context: syntheticContext({ stage: 'calculation' }),
  })

  assert.equal(result.ok, true, result.gaps.map((gap) => `${gap.kind}: ${gap.message}`).join(' | '))
  assert.equal(result.accepted.length, 1)
  assert.equal(result.accepted[0].parameter.value, 1)
  assert.equal(result.accepted[0].parameter.unit, '无量纲')
})

test('a wrong source digest fails explicitly instead of binding to the wrong version', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const candidate = syntheticCountCandidate()
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [{
      ...candidate,
      source: { ...candidate.source, digest: digestOf('另一个版本') },
    }],
    context: syntheticContext(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(gapKinds(result), ['digest-mismatch'])
})

test('a quote that is not in the verified body fails explicitly', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const candidate = syntheticCountCandidate()
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [{
      ...candidate,
      source: { ...candidate.source, quote: '正文里根本没有这句话。' },
    }],
    context: syntheticContext(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(gapKinds(result), ['quote-missing'])
})

test('a unit that the quoted text does not carry fails explicitly', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const candidate = syntheticTableCandidate()
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyTable()],
    candidates: [{
      ...candidate,
      parameter: { ...candidate.parameter, unit: '元', evidenceQuote: '1.00' },
    }],
    context: syntheticContext({ stage: 'calculation' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(gapKinds(result), ['unit-mismatch'])
})

test('two conflicting interpretations of the same requirement are left ambiguous, not last-wins', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const candidate = syntheticCountCandidate()
  const second = syntheticCountCandidate({
    source: { ...candidate.source, section: '合成条款乙', quote: '可比案例数量不得少于 5 个。' },
    statement: '可比案例数量不得少于 5 个。',
    parameter: { name: 'comparableCount.min', value: 5, unit: '个', evidenceQuote: '不得少于 5 个' },
  })
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [candidate, second],
    context: syntheticContext(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0, 'a conflict must not silently keep one value')
  assert.deepEqual(gapKinds(result), ['ambiguous'])
})

test('a requirement that does not apply to the current object fails explicitly', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [syntheticCountCandidate()],
    context: syntheticContext({ objectId: 'object-b' }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(gapKinds(result), ['not-applicable'])
})

test('a source outside the approved space or path scope is rejected', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const outside = { ...syntheticPolicyProse(), spaceName: '别的知识库' }
  const result = await bindKnowledgeRequirements({
    sources: [outside],
    candidates: [syntheticCountCandidate()],
    context: syntheticContext(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(gapKinds(result), ['out-of-scope'])
})

test('an unknown parameter value stays null and never becomes zero or a default', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()
  const candidate = syntheticCountCandidate({
    parameter: { name: 'comparableCount.min', value: null, unit: '个', evidenceQuote: '不得少于 3 个' },
  })
  const result = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [candidate],
    context: syntheticContext(),
  })

  assert.equal(result.ok, true, result.gaps.map((gap) => gap.message).join(' | '))
  assert.equal(result.accepted.length, 1)
  assert.equal(Object.is(result.accepted[0].parameter.value, null), true, 'unknown must stay null')
  assert.notEqual(result.accepted[0].parameter.value, 0)
})

test('an arbitrary executable formula or unregistered calculator is never accepted', async () => {
  const { bindKnowledgeRequirements } = await loadRequirements()

  const formula = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [syntheticCountCandidate({
      parameter: { name: 'synthetic.formula', value: '3 * (1 + 0.05)', unit: '' },
    })],
    context: syntheticContext(),
  })
  assert.equal(formula.ok, false)
  assert.equal(formula.accepted.length, 0)
  assert.equal(
    formula.gaps.some((gap) => ['unsafe-formula', 'unsupported-calculator'].includes(gap.kind)),
    true,
    JSON.stringify(formula.gaps),
  )

  const unregistered = await bindKnowledgeRequirements({
    sources: [syntheticPolicyProse()],
    candidates: [syntheticCountCandidate({
      executor: { calculatorId: 'arbitrary.exec', inputSlots: [] },
    })],
    context: syntheticContext(),
  })
  assert.equal(unregistered.ok, false)
  assert.equal(unregistered.accepted.length, 0)
  assert.deepEqual(gapKinds(unregistered), ['unsupported-calculator'])
})

test('parseRuleParameters reports a program adapter gap for prose-only knowledge, not a maintainer JSON task', async () => {
  const source = syntheticPolicyProse()
  const parsed = knowledge.parseRuleParameters({
    routeId: `wiki:${source.path}`,
    snapshotDigest: source.digest,
    body: source.body,
  })

  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorKind, 'missing')
  assert.equal(parsed.parameters.length, 0, 'no default parameter may be invented')

  const text = [parsed.error, ...parsed.gaps].join('；')
  // The gap is a program-side adapter task; business maintainers keep writing prose.
  assert.match(text, /适配|程序/)
  assert.doesNotMatch(text, /维护者|补齐|结构化规则段/)
})

test('a relative Wiki link exposes both the raw target and the resolved path; selection uses the path', async () => {
  const markdown = [
    '# 入口',
    '先读[合成政策](<02 估值方法/02 市场法.md>)。',
    '外部参考见[法规](https://example.invalid/x)。',
    '坏链：[越界](../../../etc/passwd)。',
    '',
  ].join('\n')
  const links = wikiLinks.parseWikiLinks(markdown, '01 估值与测算/01 房地产/wiki.adoc')
  const resolved = links.find((link) => link.kind === 'knowledge')
  assert.ok(resolved, 'the relative link must resolve as knowledge')
  assert.equal(resolved.target, '<02 估值方法/02 市场法.md>', 'the raw target is preserved verbatim, angle brackets included')
  assert.equal(resolved.path, '01 估值与测算/01 房地产/02 估值方法/02 市场法.md')

  const asset = await loadListingReferenceAsset()
  assert.equal(asset.LISTING_REFERENCE_MODE, 'listing-reference')
  const selection = asset.selectListingReferenceSources({
    links,
    accepted: [{ sourceId: 'synthetic-market', path: resolved.path }],
  })

  assert.deepEqual(selection.wikiPaths, [resolved.path])
  assert.equal(selection.wikiPaths.includes(resolved.target), false, 'the raw target must never be used as a library path')
  assert.equal(selection.rejected.some((item) => item.kind === 'external'), true)
  assert.equal(selection.rejected.some((item) => item.kind === 'invalid'), true)
})
